// PlayOutIngame64.exe: PlayOut's in-game overlay helper. Runs beside PlayOut (never inside the game) and answers one
// command with exactly one JSON line on stdout (PROTOCOL.md, section 1):
//   probe  --pid <pid>                         what the game is and whether the overlay may be injected
//   inject --pid <pid> --dll <path> --pipe <name> --token <64 hex> --playout-pid <pid>
//   watch  --pid <pid>                         waits for the game to end and reports its exit code
//   peerparty-invite                           asks the PeerParty game last in front to invite everyone on the LAN
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>

#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "common/anticheat_names.h"
#include "common/names.h"
#include "hook/protocol.h"
#include "playout_version.h"

namespace {

using playout::BaseName;
using playout::FirstMatch;
using playout::Lower;
namespace proto = playout::protocol;

constexpr wchar_t kDllName[] = L"playoutoverlay64.dll";
constexpr DWORD kInjectRights = PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ |
                                PROCESS_QUERY_INFORMATION | SYNCHRONIZE;

// ---- output ---------------------------------------------------------------------------------------------------

std::string Utf8(const std::wstring& text) {
  if (text.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0,
                                       nullptr, nullptr);
  std::string out(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), out.data(), size, nullptr, nullptr);
  return out;
}

std::string Quote(const std::string& text) {
  std::string out = "\"";
  for (const char c : text) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += c;
        }
    }
  }
  return out + "\"";
}

/** One JSON object, built field by field in order. */
class Json {
 public:
  Json& Str(const char* key, const std::string& value) { return Raw(key, Quote(value)); }
  Json& Num(const char* key, uint64_t value) { return Raw(key, std::to_string(value)); }
  Json& Bool(const char* key, bool value) { return Raw(key, value ? "true" : "false"); }
  Json& List(const char* key, const std::vector<std::string>& values) {
    std::string out = "[";
    for (size_t i = 0; i < values.size(); i++) out += (i ? "," : "") + Quote(values[i]);
    return Raw(key, out + "]");
  }
  Json& Raw(const char* key, const std::string& json) {
    text_ += (text_.size() > 1 ? "," : "") + Quote(key) + ":" + json;
    return *this;
  }
  std::string Done() const { return text_ + "}"; }

 private:
  std::string text_ = "{";
};

void PrintLine(const std::string& line) {
  const std::string out = line + "\n";
  DWORD written = 0;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), out.data(), static_cast<DWORD>(out.size()), &written, nullptr);
}

std::string Failure(DWORD pid, const std::string& error, const char* step) {
  return Json().Bool("ok", false).Num("pid", pid).Str("error", error).Str("step", step).Done();
}

std::string LastError(const char* what) {
  return std::string(what) + " (Windows error " + std::to_string(GetLastError()) + ")";
}

// ---- handles --------------------------------------------------------------------------------------------------

class Handle {
 public:
  explicit Handle(HANDLE h = nullptr) : h_(h == INVALID_HANDLE_VALUE ? nullptr : h) {}
  ~Handle() {
    if (h_) CloseHandle(h_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return h_; }
  explicit operator bool() const { return h_ != nullptr; }

 private:
  HANDLE h_;
};

// ---- probe ----------------------------------------------------------------------------------------------------

struct ProbeResult {
  bool ok = false;
  std::string error;
  std::string step;
  std::string arch = "unknown";
  bool elevated = false;
  bool isProtected = false;
  bool appContainer = false;
  bool injected = false;
  std::vector<std::string> antiCheat;
  std::vector<std::string> graphics;
  std::wstring exe;
  // How many drivers, processes and modules the anti-cheat check looked at (0 drivers: that source was unreadable).
  size_t drivers = 0;
  size_t processes = 0;
  size_t modules = 0;
};

/** The mandatory integrity level RID of a token, or -1 when it cannot be read. */
long IntegrityOf(HANDLE token) {
  DWORD size = 0;
  GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &size);
  if (!size) return -1;
  std::vector<uint8_t> buffer(size);
  if (!GetTokenInformation(token, TokenIntegrityLevel, buffer.data(), size, &size)) return -1;
  const auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
  const DWORD count = *GetSidSubAuthorityCount(label->Label.Sid);
  return static_cast<long>(*GetSidSubAuthority(label->Label.Sid, count - 1));
}

std::string ArchOf(HANDLE process) {
  PROCESS_MACHINE_INFORMATION machine{};
  if (GetProcessInformation(process, ProcessMachineTypeInfo, &machine, sizeof machine)) {
    switch (machine.ProcessMachine) {
      case IMAGE_FILE_MACHINE_AMD64: return "x64";
      case IMAGE_FILE_MACHINE_I386: return "x86";
      case IMAGE_FILE_MACHINE_ARM64: return "arm64";
      default: break;
    }
  }
  USHORT processMachine = 0;
  USHORT nativeMachine = 0;
  if (!IsWow64Process2(process, &processMachine, &nativeMachine)) return "unknown";
  const USHORT m = processMachine == IMAGE_FILE_MACHINE_UNKNOWN ? nativeMachine : processMachine;
  switch (m) {
    case IMAGE_FILE_MACHINE_AMD64: return "x64";
    case IMAGE_FILE_MACHINE_I386: return "x86";
    case IMAGE_FILE_MACHINE_ARM64: return "arm64";
    default: return "unknown";
  }
}

/** Lower-case base names of the modules loaded in `process`; false when they could not be listed. */
bool ModulesOf(HANDLE process, std::vector<std::wstring>& names) {
  // A process that is still starting can answer ERROR_PARTIAL_COPY; try a few times.
  for (int attempt = 0; attempt < 5; attempt++) {
    DWORD needed = 0;
    std::vector<HMODULE> modules(1024);
    if (EnumProcessModulesEx(process, modules.data(), static_cast<DWORD>(modules.size() * sizeof(HMODULE)), &needed,
                             LIST_MODULES_ALL)) {
      if (needed > modules.size() * sizeof(HMODULE)) {
        modules.resize(needed / sizeof(HMODULE));
        if (!EnumProcessModulesEx(process, modules.data(), static_cast<DWORD>(modules.size() * sizeof(HMODULE)),
                                  &needed, LIST_MODULES_ALL))
          continue;
      }
      modules.resize(needed / sizeof(HMODULE));
      names.clear();
      for (HMODULE m : modules) {
        wchar_t name[MAX_PATH];
        if (GetModuleBaseNameW(process, m, name, MAX_PATH)) names.push_back(Lower(name));
      }
      return true;
    }
    Sleep(50);
  }
  return false;
}

/** Lower-case base names of the kernel drivers loaded on the system (two sources; either may come back empty). */
std::set<std::wstring> LoadedDrivers() {
  std::set<std::wstring> names;
  std::vector<LPVOID> bases(2048);
  DWORD needed = 0;
  if (EnumDeviceDrivers(bases.data(), static_cast<DWORD>(bases.size() * sizeof(LPVOID)), &needed)) {
    if (needed > bases.size() * sizeof(LPVOID)) {
      bases.resize(needed / sizeof(LPVOID));
      if (!EnumDeviceDrivers(bases.data(), static_cast<DWORD>(bases.size() * sizeof(LPVOID)), &needed)) needed = 0;
    }
    bases.resize(needed / sizeof(LPVOID));
    for (LPVOID base : bases) {
      wchar_t name[MAX_PATH];
      if (base && GetDeviceDriverBaseNameW(base, name, MAX_PATH)) names.insert(Lower(name));
    }
  }
  // Windows 11 24H2 hides driver addresses from processes without SeDebugPrivilege, so the list above can be empty:
  // the running kernel driver services (and their image files) are the second source.
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_ENUMERATE_SERVICE);
  if (!scm) return names;
  DWORD bytes = 0;
  DWORD count = 0;
  DWORD resume = 0;
  EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_DRIVER, SERVICE_ACTIVE, nullptr, 0, &bytes, &count,
                        &resume, nullptr);
  std::vector<uint8_t> buffer(bytes + 4096);
  resume = 0;
  if (EnumServicesStatusExW(scm, SC_ENUM_PROCESS_INFO, SERVICE_DRIVER, SERVICE_ACTIVE, buffer.data(),
                            static_cast<DWORD>(buffer.size()), &bytes, &count, &resume, nullptr)) {
    const auto* services = reinterpret_cast<const ENUM_SERVICE_STATUS_PROCESSW*>(buffer.data());
    for (DWORD i = 0; i < count; i++) {
      names.insert(Lower(services[i].lpServiceName) + L".sys");
      SC_HANDLE service = OpenServiceW(scm, services[i].lpServiceName, SERVICE_QUERY_CONFIG);
      if (!service) continue;
      DWORD configBytes = 0;
      QueryServiceConfigW(service, nullptr, 0, &configBytes);
      if (configBytes) {
        std::vector<uint8_t> config(configBytes);
        auto* cfg = reinterpret_cast<QUERY_SERVICE_CONFIGW*>(config.data());
        if (QueryServiceConfigW(service, cfg, configBytes, &configBytes) && cfg->lpBinaryPathName)
          names.insert(Lower(BaseName(cfg->lpBinaryPathName)));
      }
      CloseServiceHandle(service);
    }
  }
  CloseServiceHandle(scm);
  return names;
}

/** Lower-case image names of the running processes. */
std::set<std::wstring> RunningProcesses() {
  std::set<std::wstring> names;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return names;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof entry;
  for (BOOL more = Process32FirstW(snapshot.get(), &entry); more; more = Process32NextW(snapshot.get(), &entry))
    names.insert(Lower(entry.szExeFile));
  return names;
}

void AddOnce(std::vector<std::string>& list, const std::string& value) {
  for (const auto& v : list) {
    if (v == value) return;
  }
  list.push_back(value);
}

ProbeResult Probe(DWORD pid) {
  ProbeResult r;
  Handle query(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!query) {
    r.error = GetLastError() == ERROR_INVALID_PARAMETER ? "No process has that id."
                                                        : LastError("The process could not be opened");
    r.step = "open";
    return r;
  }
  DWORD exitCode = 0;
  if (GetExitCodeProcess(query.get(), &exitCode) && exitCode != STILL_ACTIVE) {
    r.error = "The process has ended.";
    r.step = "open";
    return r;
  }
  r.ok = true;
  wchar_t path[MAX_PATH * 2];
  DWORD pathSize = MAX_PATH * 2;
  if (QueryFullProcessImageNameW(query.get(), 0, path, &pathSize)) r.exe.assign(path, pathSize);
  r.arch = ArchOf(query.get());

  // Integrity: the helper's own level against the target's. A token that cannot be read counts as higher.
  long own = -1;
  {
    HANDLE token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
      own = IntegrityOf(token);
      CloseHandle(token);
    }
  }
  HANDLE targetToken = nullptr;
  if (OpenProcessToken(query.get(), TOKEN_QUERY, &targetToken)) {
    const long level = IntegrityOf(targetToken);
    r.elevated = level < 0 || own < 0 || level > own;
    DWORD isApp = 0;
    DWORD size = 0;
    if (GetTokenInformation(targetToken, TokenIsAppContainer, &isApp, sizeof isApp, &size) && isApp)
      r.appContainer = true;
    CloseHandle(targetToken);
  } else {
    r.elevated = true;
  }
  if (Lower(r.exe).find(L"\\windowsapps\\") != std::wstring::npos) r.appContainer = true;

  PROCESS_PROTECTION_LEVEL_INFORMATION protection{};
  if (GetProcessInformation(query.get(), ProcessProtectionLevelInfo, &protection, sizeof protection) &&
      protection.ProtectionLevel != PROTECTION_LEVEL_NONE)
    r.isProtected = true;
  Handle full(OpenProcess(kInjectRights, FALSE, pid));
  if (!full) r.isProtected = true;

  // Anti-cheat: drivers on the system, programs running, modules in the target. Modules that cannot be listed count
  // as anti-cheat ("unknown"): unknown is never safe.
  const auto drivers = LoadedDrivers();
  const auto processes = RunningProcesses();
  r.drivers = drivers.size();
  r.processes = processes.size();
  for (const auto& driver : drivers) {
    if (const wchar_t* hit = FirstMatch(driver, playout::anticheat::kDrivers)) AddOnce(r.antiCheat, Utf8(hit));
  }
  for (const auto& process : processes) {
    if (const wchar_t* hit = FirstMatch(process, playout::anticheat::kProcesses)) AddOnce(r.antiCheat, Utf8(hit));
  }
  std::vector<std::wstring> modules;
  Handle reader(full ? nullptr : OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  if (ModulesOf(full ? full.get() : reader.get(), modules)) {
    r.modules = modules.size();
    bool d3d10 = false;
    std::map<std::wstring, const char*> api = {{L"d3d9.dll", "d3d9"},       {L"d3d11.dll", "d3d11"},
                                               {L"d3d12.dll", "d3d12"},     {L"dxgi.dll", "dxgi"},
                                               {L"vulkan-1.dll", "vulkan"}, {L"opengl32.dll", "opengl"}};
    std::set<std::string> found;
    for (const auto& m : modules) {
      if (const wchar_t* hit = FirstMatch(m, playout::anticheat::kModules)) AddOnce(r.antiCheat, Utf8(hit));
      if (m == kDllName) r.injected = true;
      if (m.rfind(L"d3d10", 0) == 0 && m.size() > 4 && m.substr(m.size() - 4) == L".dll") d3d10 = true;
      if (auto it = api.find(m); it != api.end()) found.insert(it->second);
    }
    if (d3d10) found.insert("d3d10");
    for (const char* name : {"d3d9", "d3d10", "d3d11", "d3d12", "dxgi", "vulkan", "opengl"}) {
      if (found.count(name)) r.graphics.push_back(name);
    }
  } else {
    AddOnce(r.antiCheat, "unknown");
  }
  return r;
}

std::string ProbeJson(DWORD pid, const ProbeResult& r) {
  if (!r.ok) return Failure(pid, r.error, r.step.c_str());
  return Json()
      .Bool("ok", true)
      .Num("pid", pid)
      .Str("arch", r.arch)
      .Bool("elevated", r.elevated)
      .Bool("protected", r.isProtected)
      .Bool("appContainer", r.appContainer)
      .List("antiCheat", r.antiCheat)
      .List("graphics", r.graphics)
      .Bool("injected", r.injected)
      .Str("exe", Utf8(r.exe))
      .Raw("checked", Json().Num("drivers", r.drivers).Num("processes", r.processes).Num("modules", r.modules).Done())
      .Str("helper", PLAYOUT_INGAME_VERSION)
      .Done();
}

// ---- inject ---------------------------------------------------------------------------------------------------

/** Why `inject` must not go ahead, or "" when it may. */
std::string Refusal(const ProbeResult& r) {
  if (r.arch != "x64") return "The game is not a 64-bit x64 program (" + r.arch + ").";
  if (r.elevated) return "The game runs as administrator or at a higher integrity level than PlayOut.";
  if (r.isProtected) return "The game is a protected process or cannot be opened for injection.";
  if (r.appContainer) return "The game is a Microsoft Store (AppContainer) app.";
  if (!r.antiCheat.empty()) {
    std::string names;
    for (const auto& a : r.antiCheat) names += (names.empty() ? "" : ", ") + a;
    return "Anti-cheat found: " + names + ".";
  }
  bool dx = false;
  for (const auto& g : r.graphics) dx = dx || g == "d3d11" || g == "dxgi";
  if (!dx) return "The game has not loaded Direct3D 11 / DXGI.";
  return {};
}

bool IsHexToken(const std::wstring& token) {
  if (token.size() != 64) return false;
  for (const wchar_t c : token) {
    if (!iswxdigit(c)) return false;
  }
  return true;
}

/** Waits up to `ms` for the DLL to mark the mapping consumed. */
bool WaitConsumed(volatile proto::ConfigMapping* config, DWORD ms) {
  const ULONGLONG until = GetTickCount64() + ms;
  while (GetTickCount64() < until) {
    if (InterlockedCompareExchange(&config->consumed, 0, 0) == 1) return true;
    Sleep(20);
  }
  return InterlockedCompareExchange(&config->consumed, 0, 0) == 1;
}

std::string Inject(DWORD pid, const std::wstring& dll, const std::wstring& pipe, const std::wstring& token,
                   DWORD playoutPid) {
  const ProbeResult r = Probe(pid);
  if (!r.ok) return Failure(pid, r.error, r.step.c_str());
  if (const std::string refusal = Refusal(r); !refusal.empty()) return Failure(pid, refusal, "check");

  const std::wstring name = std::wstring(proto::CONFIG_MAPPING_PREFIX) + std::to_wstring(pid);
  Handle mapping(CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0,
                                    sizeof(proto::ConfigMapping), name.c_str()));
  if (!mapping) return Failure(pid, LastError("The config mapping could not be created"), "mapping");
  auto* config = static_cast<proto::ConfigMapping*>(
      MapViewOfFile(mapping.get(), FILE_MAP_WRITE, 0, 0, sizeof(proto::ConfigMapping)));
  if (!config) return Failure(pid, LastError("The config mapping could not be mapped"), "mapping");
  struct Unmap {
    void* view;
    ~Unmap() { UnmapViewOfFile(view); }
  } unmap{config};
  ZeroMemory(config, sizeof *config);
  config->version = proto::CONFIG_VERSION;
  config->playoutPid = playoutPid;
  wcsncpy_s(config->pipe, pipe.c_str(), _TRUNCATE);
  for (size_t i = 0; i < 64; i++) config->token[i] = static_cast<char>(token[i]);
  config->token[64] = '\0';
  MemoryBarrier();
  config->magic = proto::CONFIG_MAGIC;  // written last: a reader that sees the magic sees the rest

  if (r.injected) {
    if (!WaitConsumed(config, 10000))
      return Failure(pid, "The overlay already in the game did not pick up the new connection.", "consume");
    return Json().Bool("ok", true).Num("pid", pid).Str("step", "already").Done();
  }

  Handle process(OpenProcess(kInjectRights, FALSE, pid));
  if (!process) return Failure(pid, LastError("The game could not be opened"), "check");
  const size_t bytes = (dll.size() + 1) * sizeof(wchar_t);
  void* remote = VirtualAllocEx(process.get(), nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote) return Failure(pid, LastError("Memory could not be allocated in the game"), "alloc");
  if (!WriteProcessMemory(process.get(), remote, dll.c_str(), bytes, nullptr)) {
    VirtualFreeEx(process.get(), remote, 0, MEM_RELEASE);
    return Failure(pid, LastError("The DLL path could not be written into the game"), "alloc");
  }
  auto* loadLibrary = reinterpret_cast<LPTHREAD_START_ROUTINE>(
      reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW")));
  Handle thread(CreateRemoteThread(process.get(), nullptr, 0, loadLibrary, remote, 0, nullptr));
  if (!thread) {
    VirtualFreeEx(process.get(), remote, 0, MEM_RELEASE);
    return Failure(pid, LastError("The loader thread could not be started in the game"), "thread");
  }
  if (WaitForSingleObject(thread.get(), 5000) != WAIT_OBJECT_0)
    return Failure(pid, "LoadLibraryW did not finish within 5 seconds.", "thread");  // memory left: still in use
  DWORD loaded = 0;
  GetExitCodeThread(thread.get(), &loaded);
  VirtualFreeEx(process.get(), remote, 0, MEM_RELEASE);
  if (!loaded) return Failure(pid, "The game could not load the overlay DLL.", "load");
  if (!WaitConsumed(config, 10000))
    return Failure(pid, "The overlay DLL did not read its configuration within 10 seconds.", "consume");
  return Json().Bool("ok", true).Num("pid", pid).Str("step", "done").Done();
}

// ---- watch ----------------------------------------------------------------------------------------------------

std::string Watch(DWORD pid) {
  Handle process(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  if (!process) return Failure(pid, LastError("The process could not be opened"), "open");
  WaitForSingleObject(process.get(), INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(process.get(), &code);
  return Json().Num("pid", pid).Num("exitCode", code).Done();
}

// ---- peerparty-invite -----------------------------------------------------------------------------------------

// PeerParty's invite events (its launcher/src/backend/windows/invite.rs and hook/src/invite/mod.rs). The hooked game
// that was last in front (it keeps its process id in the shared mapping Local\peerparty.front) answers kInviteLast,
// even while PlayOut's overlay window is in front: it sets kInviteAck and invites every player of the game on the LAN.
constexpr wchar_t kInviteLastEvent[] = L"Local\\peerparty.invite.last";
constexpr wchar_t kInviteAckEvent[] = L"Local\\peerparty.invite.ack";
constexpr DWORD kInviteWaitMs = 1500;

// What PeerParty's own Invite button does (signal_named): clear an answer left from before, set the event, wait for a
// game's answer, then clear both, so a game started later is not triggered by it. Both events are manual-reset; making
// them here when no game has them yet is harmless (nobody waits on them, and they go when this helper exits).
std::string PeerPartyInvite() {
  Handle event(CreateEventW(nullptr, TRUE, FALSE, kInviteLastEvent));
  Handle ack(CreateEventW(nullptr, TRUE, FALSE, kInviteAckEvent));
  if (!event || !ack) {
    return Json()
        .Bool("ok", false)
        .Str("error", LastError("PeerParty's invite event could not be opened"))
        .Str("step", "event")
        .Done();
  }
  ResetEvent(ack.get());
  SetEvent(event.get());
  // A game's invite thread wakes on the event; one that is busy takes a moment.
  const bool taken = WaitForSingleObject(ack.get(), kInviteWaitMs) == WAIT_OBJECT_0;
  ResetEvent(event.get());
  ResetEvent(ack.get());
  return Json().Bool("ok", true).Bool("taken", taken).Done();
}

// ---- arguments ------------------------------------------------------------------------------------------------

int Usage(const std::string& why) {
  PrintLine(Json().Bool("ok", false).Str("error", why).Str("step", "usage").Done());
  std::fputs(
      "usage: PlayOutIngame64 probe --pid <pid>\n"
      "       PlayOutIngame64 inject --pid <pid> --dll <path> --pipe <name> --token <64 hex> --playout-pid <pid>\n"
      "       PlayOutIngame64 watch --pid <pid>\n"
      "       PlayOutIngame64 peerparty-invite\n",
      stderr);
  return 2;
}

bool ParsePid(const std::wstring& text, DWORD& out) {
  if (text.empty() || text.size() > 10) return false;
  uint64_t value = 0;
  for (const wchar_t c : text) {
    if (c < L'0' || c > L'9') return false;
    value = value * 10 + static_cast<uint64_t>(c - L'0');
  }
  if (value == 0 || value > 0xFFFFFFFFull) return false;
  out = static_cast<DWORD>(value);
  return true;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return Usage("no command");
  const std::wstring command = argv[1];
  std::map<std::wstring, std::wstring> args;
  for (int i = 2; i < argc; i++) {
    const std::wstring key = argv[i];
    if (key.rfind(L"--", 0) != 0 || i + 1 >= argc) return Usage("bad argument " + Utf8(key));
    args[key.substr(2)] = argv[++i];
  }
  // The one command without a process: it takes no arguments at all.
  if (command == L"peerparty-invite") {
    if (!args.empty()) return Usage("peerparty-invite takes no arguments");
    PrintLine(PeerPartyInvite());
    return 0;
  }
  DWORD pid = 0;
  if (!ParsePid(args[L"pid"], pid)) return Usage("--pid is missing or not a process id");

  if (command == L"probe") {
    PrintLine(ProbeJson(pid, Probe(pid)));
    return 0;
  }
  if (command == L"watch") {
    PrintLine(Watch(pid));
    return 0;
  }
  if (command == L"inject") {
    DWORD playoutPid = 0;
    const std::wstring dll = args[L"dll"];
    const std::wstring pipe = args[L"pipe"];
    const std::wstring token = args[L"token"];
    if (!ParsePid(args[L"playout-pid"], playoutPid)) return Usage("--playout-pid is missing");
    if (dll.size() < 4 || dll.size() >= MAX_PATH * 4 || dll.find(L":\\") != 1)
      return Usage("--dll must be an absolute path");
    if (GetFileAttributesW(dll.c_str()) == INVALID_FILE_ATTRIBUTES) return Usage("--dll does not exist");
    if (pipe.rfind(L"\\\\.\\pipe\\PlayOut-ingame-", 0) != 0 || pipe.size() >= 256)
      return Usage("--pipe must be \\\\.\\pipe\\PlayOut-ingame-<hex>");
    if (!IsHexToken(token)) return Usage("--token must be 64 hex characters");
    PrintLine(Inject(pid, dll, pipe, token, playoutPid));
    return 0;
  }
  return Usage("unknown command " + Utf8(command));
}
