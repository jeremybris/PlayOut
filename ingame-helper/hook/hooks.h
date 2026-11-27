// PlayOutOverlay64.dll: installing the hooks (PROTOCOL.md, section 7) and the worker that talks to PlayOut.
#pragma once
#include <windows.h>

#include <string>

namespace playout::hook {

/** This DLL's module handle (set in DllMain). */
extern HMODULE g_self;

/**
 * Replaces the function pointer at `slot` (a vtable entry or an import address table entry) with `hook`:
 * VirtualProtect to writable, an interlocked write, the old protection back. Returns the pointer it replaced, or
 * nullptr when the page could not be made writable.
 */
void* PatchPointer(void** slot, void* hook);

/** The vtables of the DXGI swap chain implementation, read from a dummy device and swap chain. */
struct SwapChainVtables {
  void** swapChain = nullptr;   // IDXGISwapChain
  void** swapChain1 = nullptr;  // IDXGISwapChain1 (nullptr before DXGI 1.2)
};
/** Creates the dummy device and swap chain on a message-only window of its own; `error` says why it failed. */
bool FindSwapChainVtables(SwapChainVtables& out, std::string& error);

/** Patches Present, ResizeBuffers and Present1 (present.cpp). */
bool InstallSwapChainHooks(std::string& error);

/** Patches the XInput imports and the DirectInput8 device vtables (input.cpp); safe to call again (new modules). */
void InstallInputHooks();
/** What the input hooks cover, for the log ("XInput slots: 2, DirectInput8: no"). */
std::string InputHookSummary();

/** The worker thread's body (pipe.cpp): config mapping, hooks, sessions with PlayOut, reconnects. */
void WorkerMain();

}  // namespace playout::hook
