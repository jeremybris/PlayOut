// PlayOutOverlay64.dll: the state its threads share (the pipe worker, the pipe reader and the game's render thread).
#pragma once
#include <windows.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace playout::hook {

// ---- session ----------------------------------------------------------------------------------------------------

/** Connected to PlayOut and HELLO sent: the hooks may draw and block input. */
extern std::atomic<bool> g_session;
/** A hook faulted: every hook only calls the original from now on, for good. */
extern std::atomic<bool> g_faulted;
/** SHOW is on: draw the overlay on the target swap chain. */
extern std::atomic<bool> g_show;
/** The last SHOW asked for the hold loop (Pause the game). */
extern std::atomic<bool> g_holdWanted;
/** Test-only SHOW field: draw on swap chains that are not in exclusive full screen too. */
extern std::atomic<bool> g_anyMode;
/** The game's controller reads return "nothing pressed" (SHOW until INPUT_RELEASE). */
extern std::atomic<bool> g_inputBlocked;
/** The render thread is inside the hold loop. */
extern std::atomic<bool> g_inHold;
/** Counts SHOW messages; the render thread answers each one once (PRESENTING or UNSUPPORTED). */
extern std::atomic<uint32_t> g_showGen;
/** The SHOW generation already answered with PRESENTING or UNSUPPORTED. */
extern std::atomic<uint32_t> g_answeredGen;
/** GetTickCount64 of the last SHOW and of the last Present of any swap chain. */
extern std::atomic<uint64_t> g_showTick;
extern std::atomic<uint64_t> g_lastPresentTick;

/** Whether the hooks may act (a session is up and nothing faulted). */
inline bool Active() { return g_session.load() && !g_faulted.load(); }
/** Whether the game's controller reads are blocked right now. */
inline bool InputBlocked() { return Active() && (g_inputBlocked.load() || g_inHold.load()); }

/** Ends showing, holding and input blocking (going dormant). */
void ResetShowState();

// ---- the swap chain being drawn on --------------------------------------------------------------------------------

struct TargetInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t format = 0;
  bool exclusive = false;
  uint64_t hwnd = 0;
};

/** The back buffer of the swap chain last presented (for HELLO and RESIZE). */
TargetInfo GetTarget();
/** Stores `info`; true when it differs from what was stored. */
bool SetTarget(const TargetInfo& info);

// ---- the overlay image (FRAME) ------------------------------------------------------------------------------------

struct OverlayImage {
  std::mutex mutex;
  std::vector<uint8_t> pixels;  // width * height * 4, BGRA premultiplied
  uint32_t width = 0;
  uint32_t height = 0;
  // The rectangle changed since the GPU copy was last updated (right/bottom exclusive); empty when none.
  uint32_t dirtyLeft = 0;
  uint32_t dirtyTop = 0;
  uint32_t dirtyRight = 0;
  uint32_t dirtyBottom = 0;
  // Bumped when the size changes: the GPU texture is made again from the whole image.
  uint64_t sizeVersion = 0;
};
extern OverlayImage g_image;

/** Applies one FRAME payload to g_image; false when it is malformed. */
bool ApplyFrame(const uint8_t* payload, size_t length);

// ---- messages to PlayOut ------------------------------------------------------------------------------------------

/** Queues a message for the pipe worker to write (dropped while no session is up). */
void Send(uint32_t type, std::string payload = {});
/** Queues a LOG message (and writes it to the debugger output). */
void Log(const char* level, const std::string& message);
/** Marks the DLL faulted, ends showing and queues FAULT; called from the hooks' exception filters. */
void ReportFault(const char* where, unsigned long code);

/** Takes the queued messages (the worker writes them). */
std::vector<std::pair<uint32_t, std::string>> TakeQueue();
/** Drops the queued messages (a session ended). */
void ClearQueue();
/** Signalled when a message is queued. */
HANDLE QueueEvent();

// ---- small JSON helpers -------------------------------------------------------------------------------------------

std::string JsonString(const std::string& text);
/** The boolean `key` of a flat JSON object `json`, or `fallback` when it is missing. */
bool JsonBool(const std::string& json, const char* key, bool fallback);

}  // namespace playout::hook
