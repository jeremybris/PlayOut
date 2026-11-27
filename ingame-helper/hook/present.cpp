// PlayOutOverlay64.dll: the Present / Present1 / ResizeBuffers hooks, the choice of the swap chain to draw on and the
// hold loop (PROTOCOL.md, sections 5 and 7).
#include <d3d11.h>
#include <dxgi1_2.h>

#include <cstdio>

#include "hook/hooks.h"
#include "hook/protocol.h"
#include "hook/renderer.h"
#include "hook/state.h"

namespace playout::hook {

namespace proto = playout::protocol;

namespace {

using PresentFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT);
using Present1Fn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain1*, UINT, UINT, const DXGI_PRESENT_PARAMETERS*);
using ResizeBuffersFn = HRESULT(STDMETHODCALLTYPE*)(IDXGISwapChain*, UINT, UINT, UINT, DXGI_FORMAT, UINT);

constexpr int kPresentIndex = 8;
constexpr int kResizeBuffersIndex = 13;
constexpr int kPresent1Index = 22;

PresentFn g_presentOriginal = nullptr;
Present1Fn g_present1Original = nullptr;
ResizeBuffersFn g_resizeOriginal = nullptr;

/** Nesting of the hooks on this thread: a Present called from inside one (DXGI's own, the hold loop) passes through. */
thread_local int t_depth = 0;

/** Serialises the drawing between threads; a second thread presenting at the same time just passes through. */
SRWLOCK g_renderLock = SRWLOCK_INIT;
Renderer g_renderer;
IDXGISwapChain* g_target = nullptr;  // compared only, never dereferenced outside a Present of it
uint64_t g_targetTick = 0;
uint32_t g_presentingGen = 0;
uint32_t g_unsupportedGen = 0;
/** Bumped by every ResizeBuffers: the hold loop ends when the back buffer it snapshotted was replaced. */
std::atomic<uint32_t> g_resizeCount{0};

struct DepthGuard {
  DepthGuard() { t_depth++; }
  ~DepthGuard() { t_depth--; }
};

struct HoldFlag {
  HoldFlag() { g_inHold = true; }
  ~HoldFlag() {
    g_inHold = false;
    g_renderer.ReleaseSnapshot();
  }
};

bool Drawable(DXGI_FORMAT format) {
  return format == DXGI_FORMAT_R8G8B8A8_UNORM || format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB ||
         format == DXGI_FORMAT_B8G8R8A8_UNORM || format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
}

void AnswerUnsupported(uint32_t gen, const char* reason) {
  if (g_unsupportedGen == gen) return;
  g_unsupportedGen = gen;
  g_answeredGen = gen;
  Send(proto::MSG_UNSUPPORTED, std::string("{\"reason\":\"") + reason + "\"}");
  Log("warn", std::string("cannot draw on this swap chain: ") + reason);
}

void AnswerPresenting(uint32_t gen, bool held) {
  if (g_presentingGen == gen) return;
  g_presentingGen = gen;
  g_answeredGen = gen;
  Send(proto::MSG_PRESENTING, held ? "{\"held\":true}" : "{\"held\":false}");
}

/** Whether `swapChain` is the one to draw on: the one presenting, unless another presented within the last 500 ms. */
bool IsTarget(IDXGISwapChain* swapChain, uint64_t now) {
  if (swapChain != g_target) {
    if (g_target && now - g_targetTick < 500) return false;
    if (g_target) Log("info", "the game presents on another swap chain now");
    g_target = swapChain;
  }
  g_targetTick = now;
  return true;
}

/** Reports the target's back buffer (RESIZE when it changed); fills `desc`. */
bool ReadTarget(IDXGISwapChain* swapChain, DXGI_SWAP_CHAIN_DESC& desc, bool& exclusive) {
  if (FAILED(swapChain->GetDesc(&desc))) return false;
  BOOL fullscreen = FALSE;
  if (FAILED(swapChain->GetFullscreenState(&fullscreen, nullptr))) fullscreen = FALSE;
  exclusive = fullscreen != FALSE;
  TargetInfo info;
  info.width = desc.BufferDesc.Width;
  info.height = desc.BufferDesc.Height;
  info.format = static_cast<uint32_t>(desc.BufferDesc.Format);
  info.exclusive = exclusive;
  info.hwnd = reinterpret_cast<uint64_t>(desc.OutputWindow);
  if (SetTarget(info)) {
    char text[128];
    std::snprintf(text, sizeof text, "{\"width\":%u,\"height\":%u,\"format\":%u,\"exclusive\":%s}", info.width,
                  info.height, info.format, exclusive ? "true" : "false");
    Send(proto::MSG_RESIZE, text);
  }
  return true;
}

/**
 * Handles messages while the game is held: keyboard, mouse and raw input are dropped, everything else is
 * dispatched so Windows never sees the game as hung. False when the game was asked to quit (WM_QUIT is posted again).
 */
bool PumpMessages() {
  MSG msg;
  for (int i = 0; i < 200 && PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE); i++) {
    if (msg.message == WM_QUIT) {
      PostQuitMessage(static_cast<int>(msg.wParam));
      return false;
    }
    if ((msg.message >= WM_KEYFIRST && msg.message <= WM_KEYLAST) ||
        (msg.message >= WM_MOUSEFIRST && msg.message <= WM_MOUSELAST) || msg.message == WM_INPUT)
      continue;
    DispatchMessageW(&msg);
  }
  return true;
}

/** The hold loop (section 5): the snapshot plus the overlay, presented until HIDE. Returns the last Present result. */
HRESULT HoldLoop(IDXGISwapChain* swapChain, uint32_t gen) {
  HoldFlag hold;
  const uint32_t resizes = g_resizeCount.load();
  HRESULT last = S_OK;
  bool first = true;
  Log("info", "holding the game");
  while (Active() && g_show.load() && g_holdWanted.load()) {
    if (g_resizeCount.load() != resizes || !g_renderer.RestoreSnapshot(swapChain)) break;
    g_renderer.Draw(swapChain);
    last = g_presentOriginal(swapChain, 1, 0);
    if (first) {
      AnswerPresenting(gen, true);
      first = false;
    }
    if (last != S_OK && last != DXGI_STATUS_OCCLUDED) {
      char text[96];
      std::snprintf(text, sizeof text, "the hold ended: Present returned 0x%08lX", static_cast<unsigned long>(last));
      Log("warn", text);
      break;
    }
    if (last == DXGI_STATUS_OCCLUDED) Sleep(50);
    if (!PumpMessages()) break;
  }
  Log("info", "the game runs again");
  return last;
}

/**
 * Before the game's Present: draws the overlay, or runs the hold loop. True when the hold loop ran (the caller then
 * returns `*result` without presenting again).
 */
bool BeforePresent(IDXGISwapChain* swapChain, UINT flags, HRESULT* result) {
  const uint64_t now = GetTickCount64();
  g_lastPresentTick = now;
  if (flags & DXGI_PRESENT_TEST) return false;
  if (!TryAcquireSRWLockExclusive(&g_renderLock)) return false;
  struct Unlock {
    ~Unlock() { ReleaseSRWLockExclusive(&g_renderLock); }
  } unlock;

  if (!Active()) {
    // Dormant: drop everything held on the game's device, on its own render thread.
    if (g_renderer.HasResources()) g_renderer.ReleaseAll();
    g_target = nullptr;
    return false;
  }
  if (!IsTarget(swapChain, now)) return false;
  DXGI_SWAP_CHAIN_DESC desc{};
  bool exclusive = false;
  if (!ReadTarget(swapChain, desc, exclusive)) return false;
  if (!g_show.load()) return false;

  const uint32_t gen = g_showGen.load();
  if (!Drawable(desc.BufferDesc.Format)) {
    AnswerUnsupported(gen, "format");
    return false;
  }
  if (!exclusive && !g_anyMode.load()) {
    AnswerUnsupported(gen, "not-exclusive");
    return false;
  }
  if (!g_renderer.Prepare(swapChain)) {
    AnswerUnsupported(gen, "device");
    return false;
  }
  if (g_holdWanted.load() && g_renderer.TakeSnapshot(swapChain)) {
    *result = HoldLoop(swapChain, gen);
    return true;
  }
  if (g_renderer.Draw(swapChain)) AnswerPresenting(gen, false);
  return false;
}

DWORD FaultFilter(const char* where, DWORD code) {
  ReportFault(where, code);
  return EXCEPTION_EXECUTE_HANDLER;
}

bool GuardedBeforePresent(IDXGISwapChain* swapChain, UINT flags, HRESULT* result) {
  __try {
    return BeforePresent(swapChain, flags, result);
  } __except (FaultFilter("present", GetExceptionCode())) {
    return false;
  }
}

void AfterResize() {
  g_resizeCount++;
  Log("info", "the game resized its swap chain");
}

void GuardedAfterResize() {
  __try {
    AfterResize();
  } __except (FaultFilter("resize", GetExceptionCode())) {
  }
}

HRESULT STDMETHODCALLTYPE HookPresent(IDXGISwapChain* swapChain, UINT syncInterval, UINT flags) {
  if (t_depth > 0 || g_faulted.load()) return g_presentOriginal(swapChain, syncInterval, flags);
  DepthGuard depth;
  HRESULT held = S_OK;
  if (GuardedBeforePresent(swapChain, flags, &held)) return held;
  return g_presentOriginal(swapChain, syncInterval, flags);
}

HRESULT STDMETHODCALLTYPE HookPresent1(IDXGISwapChain1* swapChain, UINT syncInterval, UINT flags,
                                       const DXGI_PRESENT_PARAMETERS* parameters) {
  if (t_depth > 0 || g_faulted.load()) return g_present1Original(swapChain, syncInterval, flags, parameters);
  DepthGuard depth;
  HRESULT held = S_OK;
  if (GuardedBeforePresent(swapChain, flags, &held)) return held;
  return g_present1Original(swapChain, syncInterval, flags, parameters);
}

HRESULT STDMETHODCALLTYPE HookResizeBuffers(IDXGISwapChain* swapChain, UINT count, UINT width, UINT height,
                                            DXGI_FORMAT format, UINT flags) {
  // No back buffer reference is ever kept between Presents, so there is nothing to release first.
  const HRESULT hr = g_resizeOriginal(swapChain, count, width, height, format, flags);
  if (SUCCEEDED(hr) && !g_faulted.load()) GuardedAfterResize();
  return hr;
}

/** Saves the original at `vtable[index]` in `original` and patches in `hook` (once). */
template <typename Fn>
bool PatchSlot(void** vtable, int index, Fn hook, Fn& original) {
  void** slot = &vtable[index];
  if (*slot == reinterpret_cast<void*>(hook)) return true;
  original = reinterpret_cast<Fn>(*slot);
  return PatchPointer(slot, reinterpret_cast<void*>(hook)) != nullptr;
}

}  // namespace

bool InstallSwapChainHooks(std::string& error) {
  SwapChainVtables vtables;
  if (!FindSwapChainVtables(vtables, error)) return false;
  if (!PatchSlot(vtables.swapChain, kResizeBuffersIndex, &HookResizeBuffers, g_resizeOriginal) ||
      !PatchSlot(vtables.swapChain, kPresentIndex, &HookPresent, g_presentOriginal)) {
    error = "the swap chain vtable could not be patched";
    return false;
  }
  if (vtables.swapChain1) {
    if (vtables.swapChain1 != vtables.swapChain)
      Log("warn", "IDXGISwapChain1 has a vtable of its own; only its Present1 is hooked");
    if (!PatchSlot(vtables.swapChain1, kPresent1Index, &HookPresent1, g_present1Original))
      Log("warn", "Present1 could not be hooked");
  }
  return true;
}

}  // namespace playout::hook
