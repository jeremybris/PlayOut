// PlayOutOverlay64.dll: the worker thread. Reads the config mapping, installs the hooks, then runs sessions with
// PlayOut over the named pipe (PROTOCOL.md, sections 2-4): HELLO, a reader thread for PlayOut's messages, the PING
// watchdog, and dormancy / reconnects.
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "hook/hooks.h"
#include "hook/protocol.h"
#include "hook/state.h"
#include "playout_version.h"

namespace playout::hook {

namespace proto = playout::protocol;

namespace {

constexpr DWORD kHeartbeatMs = 2000;
constexpr DWORD kReconnectPollMs = 500;
constexpr DWORD kNoSwapChainMs = 1000;
constexpr DWORD kWriteTimeoutMs = 3000;
constexpr DWORD kInputRescanMs = 5000;

struct Config {
  DWORD playoutPid = 0;
  std::wstring pipe;
  std::string token;
};

/** Why a session ended. */
enum class End { PipeLost, Detach, Heartbeat, Fault, Refused };

std::atomic<uint64_t> g_lastPing{0};
std::atomic<bool> g_detach{false};

/**
 * Reads the config mapping when it holds a token other than `lastToken`; marks it consumed. False when there is no
 * mapping, it is not valid, or it is the one already used.
 */
bool ReadConfig(Config& out, const std::string& lastToken) {
  const std::wstring name = std::wstring(proto::CONFIG_MAPPING_PREFIX) + std::to_wstring(GetCurrentProcessId());
  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ | FILE_MAP_WRITE, FALSE, name.c_str());
  if (!mapping) return false;
  auto* config = static_cast<proto::ConfigMapping*>(
      MapViewOfFile(mapping, FILE_MAP_READ | FILE_MAP_WRITE, 0, 0, sizeof(proto::ConfigMapping)));
  bool ok = false;
  if (config) {
    if (config->magic == proto::CONFIG_MAGIC && config->version == proto::CONFIG_VERSION) {
      MemoryBarrier();
      char token[sizeof config->token];
      std::memcpy(token, config->token, sizeof token);
      token[sizeof token - 1] = '\0';
      wchar_t pipe[256];
      std::memcpy(pipe, config->pipe, sizeof pipe);
      pipe[255] = L'\0';
      if (lastToken != token && std::strlen(token) == 64) {
        out.playoutPid = config->playoutPid;
        out.pipe = pipe;
        out.token = token;
        InterlockedExchange(&config->consumed, 1);
        ok = true;
      }
    }
    UnmapViewOfFile(config);
  }
  CloseHandle(mapping);
  return ok;
}

// ---- pipe I/O (overlapped: the reader and the writer use the handle at the same time) -----------------------------

/** Reads exactly `size` bytes; false on pipe loss or when `stop` is signalled. */
bool ReadExact(HANDLE pipe, HANDLE stop, HANDLE event, uint8_t* data, size_t size) {
  while (size) {
    OVERLAPPED ov{};
    ov.hEvent = event;
    ResetEvent(event);
    const DWORD chunk = static_cast<DWORD>((std::min)(size, static_cast<size_t>(1) << 20));
    if (!ReadFile(pipe, data, chunk, nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) return false;
    const HANDLE waits[2] = {event, stop};
    if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) != WAIT_OBJECT_0) {
      CancelIoEx(pipe, &ov);
      DWORD ignored = 0;
      GetOverlappedResult(pipe, &ov, &ignored, TRUE);
      return false;
    }
    DWORD got = 0;
    if (!GetOverlappedResult(pipe, &ov, &got, FALSE) || got == 0) return false;
    data += got;
    size -= got;
  }
  return true;
}

bool WriteAll(HANDLE pipe, HANDLE event, const uint8_t* data, size_t size) {
  while (size) {
    OVERLAPPED ov{};
    ov.hEvent = event;
    ResetEvent(event);
    const DWORD chunk = static_cast<DWORD>((std::min)(size, static_cast<size_t>(1) << 20));
    if (!WriteFile(pipe, data, chunk, nullptr, &ov) && GetLastError() != ERROR_IO_PENDING) return false;
    if (WaitForSingleObject(event, kWriteTimeoutMs) != WAIT_OBJECT_0) {
      CancelIoEx(pipe, &ov);
      DWORD ignored = 0;
      GetOverlappedResult(pipe, &ov, &ignored, TRUE);
      return false;  // PlayOut stopped reading
    }
    DWORD put = 0;
    if (!GetOverlappedResult(pipe, &ov, &put, FALSE) || put == 0) return false;
    data += put;
    size -= put;
  }
  return true;
}

bool WriteMessage(HANDLE pipe, HANDLE event, uint32_t type, const std::string& payload) {
  std::vector<uint8_t> bytes(proto::HEADER_BYTES + payload.size());
  const proto::MessageHeader header{type, static_cast<uint32_t>(payload.size())};
  std::memcpy(bytes.data(), &header, sizeof header);
  if (!payload.empty()) std::memcpy(bytes.data() + proto::HEADER_BYTES, payload.data(), payload.size());
  return WriteAll(pipe, event, bytes.data(), bytes.size());
}

HANDLE Connect(const std::wstring& name) {
  const ULONGLONG until = GetTickCount64() + 5000;
  for (;;) {
    // SECURITY_IDENTIFICATION: the server may identify the game's user but never act as it.
    HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                              FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    const DWORD error = GetLastError();
    if (GetTickCount64() >= until) return nullptr;
    if (error == ERROR_PIPE_BUSY)
      WaitNamedPipeW(name.c_str(), 500);
    else if (error == ERROR_FILE_NOT_FOUND)
      Sleep(200);
    else
      return nullptr;
  }
}

std::string HelloJson(const Config& config) {
  const TargetInfo t = GetTarget();
  char text[512];
  std::snprintf(text, sizeof text,
                "{\"proto\":%u,\"dll\":\"%s\",\"pid\":%lu,\"token\":\"%s\",\"api\":\"d3d11\",\"width\":%u,"
                "\"height\":%u,\"format\":%u,\"exclusive\":%s,\"hwnd\":\"%llu\"}",
                proto::PROTOCOL_VERSION, PLAYOUT_INGAME_VERSION, GetCurrentProcessId(), config.token.c_str(), t.width,
                t.height, t.format, t.exclusive ? "true" : "false", static_cast<unsigned long long>(t.hwnd));
  return text;
}

// ---- reading PlayOut's messages -----------------------------------------------------------------------------------

void OnMessage(uint32_t type, const std::vector<uint8_t>& payload) {
  const std::string json(payload.begin(), payload.end());
  switch (type) {
    case proto::MSG_SHOW:
      g_holdWanted = JsonBool(json, "hold", false);
      g_anyMode = JsonBool(json, "anyMode", false);
      g_inputBlocked = true;
      g_showTick = GetTickCount64();
      g_showGen++;
      g_show = true;
      InstallInputHooks();  // modules loaded since the last scan
      break;
    case proto::MSG_HIDE: {
      g_show = false;
      g_holdWanted = false;
      // The hold loop sees the flags at its next frame; answer once it has left (or after a second regardless).
      const ULONGLONG until = GetTickCount64() + 1000;
      while (g_inHold.load() && GetTickCount64() < until) Sleep(5);
      Send(proto::MSG_HIDDEN);
      break;
    }
    case proto::MSG_FRAME:
      if (!ApplyFrame(payload.data(), payload.size())) Log("warn", "a malformed FRAME was ignored");
      break;
    case proto::MSG_PING:
      g_lastPing = GetTickCount64();
      Send(proto::MSG_PONG);
      break;
    case proto::MSG_INPUT_RELEASE:
      g_inputBlocked = false;
      break;
    case proto::MSG_DETACH:
      g_detach = true;
      break;
    default:
      Log("warn", "unknown message type " + std::to_string(type));
      break;
  }
}

/** The reader thread: messages until the pipe fails, `stop` is signalled, DETACH or a protocol error. */
void ReaderMain(HANDLE pipe, HANDLE stop, HANDLE done) {
  HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  std::vector<uint8_t> payload;
  while (event && !g_detach.load()) {
    proto::MessageHeader header{};
    if (!ReadExact(pipe, stop, event, reinterpret_cast<uint8_t*>(&header), sizeof header)) break;
    if (header.length > proto::MAX_PAYLOAD_BYTES) {
      Log("error", "a message over the size limit: disconnecting");
      break;
    }
    payload.resize(header.length);
    if (header.length && !ReadExact(pipe, stop, event, payload.data(), payload.size())) break;
    OnMessage(header.type, payload);
  }
  if (event) CloseHandle(event);
  SetEvent(done);
}

DWORD ReaderFilter(DWORD code) {
  ReportFault("pipe", code);
  return EXCEPTION_EXECUTE_HANDLER;
}

void GuardedReader(HANDLE pipe, HANDLE stop, HANDLE done) {
  __try {
    ReaderMain(pipe, stop, done);
  } __except (ReaderFilter(GetExceptionCode())) {
    SetEvent(done);
  }
}

// ---- one session ------------------------------------------------------------------------------------------------

End RunSession(const Config& config, const std::string& hookStatus) {
  HANDLE pipe = Connect(config.pipe);
  if (!pipe) return End::PipeLost;
  ULONG server = 0;
  if (!GetNamedPipeServerProcessId(pipe, &server) || server != config.playoutPid) {
    // Not PlayOut's pipe: say nothing and stay dormant.
    CloseHandle(pipe);
    return End::Refused;
  }
  HANDLE writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE readerDone = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!writeEvent || !stop || !readerDone || !WriteMessage(pipe, writeEvent, proto::MSG_HELLO, HelloJson(config))) {
    for (HANDLE h : {writeEvent, stop, readerDone}) {
      if (h) CloseHandle(h);
    }
    CloseHandle(pipe);
    return End::PipeLost;
  }

  ClearQueue();
  {
    // A new session starts transparent: nothing from an earlier PlayOut session is shown before its first FRAME.
    std::lock_guard lock(g_image.mutex);
    g_image.pixels.clear();
    g_image.width = g_image.height = 0;
    g_image.dirtyLeft = g_image.dirtyTop = g_image.dirtyRight = g_image.dirtyBottom = 0;
    g_image.sizeVersion++;
  }
  g_detach = false;
  g_lastPing = GetTickCount64();
  g_session = true;
  Log("info", std::string("connected; ") + hookStatus + "; " + InputHookSummary());
  std::thread reader(GuardedReader, pipe, stop, readerDone);

  End end = End::PipeLost;
  uint64_t lastRescan = GetTickCount64();
  for (;;) {
    const HANDLE waits[2] = {QueueEvent(), readerDone};
    const DWORD woke = WaitForMultipleObjects(2, waits, FALSE, 100);
    bool lost = false;
    for (const auto& [type, payload] : TakeQueue()) {
      if (!WriteMessage(pipe, writeEvent, type, payload)) {
        lost = true;
        break;
      }
    }
    const uint64_t now = GetTickCount64();
    if (g_faulted.load()) {
      end = End::Fault;
      break;
    }
    if (lost) break;
    if (woke == WAIT_OBJECT_0 + 1) {
      end = g_detach.load() ? End::Detach : End::PipeLost;
      break;
    }
    if (now - g_lastPing.load() > kHeartbeatMs) {
      end = End::Heartbeat;
      break;
    }
    // SHOW with no Present on any swap chain within a second: nothing to draw on.
    const uint32_t gen = g_showGen.load();
    if (g_show.load() && g_answeredGen.load() != gen && now - g_showTick.load() > kNoSwapChainMs &&
        g_lastPresentTick.load() < g_showTick.load()) {
      g_answeredGen = gen;
      Send(proto::MSG_UNSUPPORTED, "{\"reason\":\"no-swapchain\"}");
    }
    if (now - lastRescan > kInputRescanMs) {
      lastRescan = now;
      InstallInputHooks();
    }
  }

  // Dormant: stop drawing, end any hold, unblock input; the hooks only call the originals from here on.
  g_session = false;
  ResetShowState();
  SetEvent(stop);
  CancelIoEx(pipe, nullptr);
  reader.join();
  ClearQueue();
  CloseHandle(pipe);
  for (HANDLE h : {writeEvent, stop, readerDone}) CloseHandle(h);
  return end;
}

const char* EndName(End end) {
  switch (end) {
    case End::PipeLost: return "the pipe was lost";
    case End::Detach: return "PlayOut detached";
    case End::Heartbeat: return "no PING for 2 s";
    case End::Fault: return "a hook faulted";
    case End::Refused: return "the pipe is not PlayOut's";
  }
  return "?";
}

}  // namespace

void WorkerMain() {
  Config config;
  bool haveConfig = false;
  // `inject` writes the mapping before loading the DLL; a few tries cover a slow start.
  for (int i = 0; i < 20 && !haveConfig; i++) {
    haveConfig = ReadConfig(config, {});
    if (!haveConfig) Sleep(100);
  }

  std::string hookError;
  const bool hooked = InstallSwapChainHooks(hookError);
  const std::string hookStatus = hooked ? "swap chain hooked" : "swap chain NOT hooked: " + hookError;
  OutputDebugStringA(("[PlayOutOverlay] " + hookStatus + "\n").c_str());
  InstallInputHooks();

  std::string lastToken;
  for (;;) {
    if (haveConfig) {
      lastToken = config.token;
      const End end = RunSession(config, hookStatus);
      OutputDebugStringA((std::string("[PlayOutOverlay] dormant: ") + EndName(end) + "\n").c_str());
      if (end == End::Fault) return;  // faulted: dormant for good
    }
    haveConfig = false;
    while (!haveConfig) {
      Sleep(kReconnectPollMs);
      if (g_faulted.load()) return;
      haveConfig = ReadConfig(config, lastToken);
    }
  }
}

}  // namespace playout::hook
