// PlayOutOverlay64.dll: the entry point. DllMain only starts the worker thread (PROTOCOL.md, section 4); everything
// else happens on that thread, outside the loader lock.
#include "hook/hooks.h"
#include "hook/state.h"

namespace playout::hook {

HMODULE g_self = nullptr;

namespace {

DWORD WorkerFilter(DWORD code) {
  ReportFault("worker", code);
  return EXCEPTION_EXECUTE_HANDLER;
}

void GuardedWorker() {
  __try {
    WorkerMain();
  } __except (WorkerFilter(GetExceptionCode())) {
  }
}

DWORD WINAPI WorkerThread(LPVOID) {
  // The hooks point into this DLL: pin it so nothing can unload it while the game runs.
  HMODULE pinned = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                     reinterpret_cast<LPCWSTR>(&WorkerThread), &pinned);
  GuardedWorker();
  return 0;
}

}  // namespace

}  // namespace playout::hook

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    playout::hook::g_self = module;
    HANDLE thread = CreateThread(nullptr, 0, playout::hook::WorkerThread, nullptr, 0, nullptr);
    if (thread) CloseHandle(thread);
  }
  // PROCESS_DETACH: nothing. PlayOut never unloads the DLL (it is pinned) and at process exit there is nothing to do.
  return TRUE;
}
