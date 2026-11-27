// PlayOutOverlay64.dll: shared state, the outgoing message queue, FRAME handling and the small JSON helpers.
#include "hook/state.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "hook/protocol.h"

namespace playout::hook {

namespace proto = playout::protocol;

std::atomic<bool> g_session{false};
std::atomic<bool> g_faulted{false};
std::atomic<bool> g_show{false};
std::atomic<bool> g_holdWanted{false};
std::atomic<bool> g_anyMode{false};
std::atomic<bool> g_inputBlocked{false};
std::atomic<bool> g_inHold{false};
std::atomic<uint32_t> g_showGen{0};
std::atomic<uint32_t> g_answeredGen{0};
std::atomic<uint64_t> g_showTick{0};
std::atomic<uint64_t> g_lastPresentTick{0};
OverlayImage g_image;

namespace {

std::mutex g_targetMutex;
TargetInfo g_target;

std::mutex g_queueMutex;
std::vector<std::pair<uint32_t, std::string>> g_queue;
HANDLE g_queueEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);

/** Most messages that can wait to be written; beyond it LOG messages are dropped first. */
constexpr size_t kQueueLimit = 256;

}  // namespace

void ResetShowState() {
  g_show = false;
  g_holdWanted = false;
  g_anyMode = false;
  g_inputBlocked = false;
}

TargetInfo GetTarget() {
  std::lock_guard lock(g_targetMutex);
  return g_target;
}

bool SetTarget(const TargetInfo& info) {
  std::lock_guard lock(g_targetMutex);
  const bool changed = info.width != g_target.width || info.height != g_target.height ||
                       info.format != g_target.format || info.exclusive != g_target.exclusive ||
                       info.hwnd != g_target.hwnd;
  g_target = info;
  return changed;
}

bool ApplyFrame(const uint8_t* payload, size_t length) {
  if (length < proto::FRAME_HEADER_BYTES) return false;
  proto::FrameHeader h;
  std::memcpy(&h, payload, sizeof h);
  if (h.fullWidth == 0 || h.fullHeight == 0 || h.fullWidth > 16384 || h.fullHeight > 16384) return false;
  if (h.w > h.fullWidth || h.h > h.fullHeight || h.x > h.fullWidth - h.w || h.y > h.fullHeight - h.h) return false;
  if (length != proto::FRAME_HEADER_BYTES + static_cast<size_t>(h.w) * h.h * 4) return false;
  std::lock_guard lock(g_image.mutex);
  if (h.fullWidth != g_image.width || h.fullHeight != g_image.height) {
    // A new size: transparent at the new size first; the texture is made again from the whole image.
    g_image.width = h.fullWidth;
    g_image.height = h.fullHeight;
    g_image.pixels.assign(static_cast<size_t>(h.fullWidth) * h.fullHeight * 4, 0);
    g_image.sizeVersion++;
    g_image.dirtyLeft = g_image.dirtyTop = g_image.dirtyRight = g_image.dirtyBottom = 0;
  }
  const uint8_t* src = payload + proto::FRAME_HEADER_BYTES;
  const size_t rowBytes = static_cast<size_t>(h.w) * 4;
  for (uint32_t row = 0; row < h.h; row++) {
    std::memcpy(&g_image.pixels[(static_cast<size_t>(h.y + row) * h.fullWidth + h.x) * 4], src + row * rowBytes,
                rowBytes);
  }
  if (h.w && h.h) {
    if (g_image.dirtyRight <= g_image.dirtyLeft || g_image.dirtyBottom <= g_image.dirtyTop) {
      g_image.dirtyLeft = h.x;
      g_image.dirtyTop = h.y;
      g_image.dirtyRight = h.x + h.w;
      g_image.dirtyBottom = h.y + h.h;
    } else {
      g_image.dirtyLeft = (std::min)(g_image.dirtyLeft, h.x);
      g_image.dirtyTop = (std::min)(g_image.dirtyTop, h.y);
      g_image.dirtyRight = (std::max)(g_image.dirtyRight, h.x + h.w);
      g_image.dirtyBottom = (std::max)(g_image.dirtyBottom, h.y + h.h);
    }
  }
  return true;
}

void Send(uint32_t type, std::string payload) {
  if (!g_session.load()) return;
  {
    std::lock_guard lock(g_queueMutex);
    if (g_queue.size() >= kQueueLimit) {
      const auto log = std::find_if(g_queue.begin(), g_queue.end(),
                                    [](const auto& m) { return m.first == proto::MSG_LOG; });
      if (log == g_queue.end()) return;
      g_queue.erase(log);
    }
    g_queue.emplace_back(type, std::move(payload));
  }
  SetEvent(g_queueEvent);
}

void Log(const char* level, const std::string& message) {
  OutputDebugStringA(("[PlayOutOverlay] " + message + "\n").c_str());
  Send(proto::MSG_LOG, std::string("{\"level\":") + JsonString(level) + ",\"message\":" + JsonString(message) + "}");
}

void ReportFault(const char* where, unsigned long code) {
  if (g_faulted.exchange(true)) return;
  ResetShowState();
  char text[160];
  std::snprintf(text, sizeof text, "{\"where\":\"%s\",\"code\":%lu}", where, code);
  OutputDebugStringA("[PlayOutOverlay] a hook faulted; the overlay is off until the game restarts\n");
  Send(proto::MSG_FAULT, text);
}

std::vector<std::pair<uint32_t, std::string>> TakeQueue() {
  std::lock_guard lock(g_queueMutex);
  return std::exchange(g_queue, {});
}

void ClearQueue() {
  std::lock_guard lock(g_queueMutex);
  g_queue.clear();
}

HANDLE QueueEvent() { return g_queueEvent; }

std::string JsonString(const std::string& text) {
  std::string out = "\"";
  for (const char c : text) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", static_cast<unsigned>(c));
      out += buf;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

bool JsonBool(const std::string& json, const char* key, bool fallback) {
  const std::string quoted = std::string("\"") + key + "\"";
  size_t at = json.find(quoted);
  if (at == std::string::npos) return fallback;
  at = json.find(':', at + quoted.size());
  if (at == std::string::npos) return fallback;
  at = json.find_first_not_of(" \t\r\n", at + 1);
  if (at == std::string::npos) return fallback;
  if (json.compare(at, 4, "true") == 0) return true;
  if (json.compare(at, 5, "false") == 0) return false;
  return fallback;
}

}  // namespace playout::hook
