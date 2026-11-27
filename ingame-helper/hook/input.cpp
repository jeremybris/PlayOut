// PlayOutOverlay64.dll: blocking the game's controller reads while the overlay is up (PROTOCOL.md, section 6).
//   XInput: import address table entries of XInputGetState / XInputGetStateEx (ordinal 100) of xinput1_3, xinput1_4
//           and xinput9_1_0, in every loaded module except system DLLs (plain and delay-load imports).
//   DirectInput8: GetDeviceState (9) and GetDeviceData (10) of IDirectInputDevice8W and ...8A, for game controllers.
#define DIRECTINPUT_VERSION 0x0800
#include <windows.h>
#include <dinput.h>
#include <psapi.h>
#include <xinput.h>
#include <delayimp.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "common/names.h"
#include "hook/hooks.h"
#include "hook/state.h"

namespace playout::hook {

namespace {

// ---- XInput -----------------------------------------------------------------------------------------------------

using XInputGetStateFn = DWORD(WINAPI*)(DWORD, XINPUT_STATE*);

constexpr const char* kXInputDlls[] = {"xinput1_3.dll", "xinput1_4.dll", "xinput9_1_0.dll"};
constexpr int kXInputDllCount = 3;
constexpr WORD kGetStateExOrdinal = 100;

/** The original function of each DLL: [dll][0 = XInputGetState, 1 = XInputGetStateEx]. */
std::atomic<XInputGetStateFn> g_xinputOriginal[kXInputDllCount][2];

DWORD InputFilter(DWORD code) {
  ReportFault("input", code);
  return EXCEPTION_EXECUTE_HANDLER;
}

/** "Connected, nothing pressed": the gamepad part is zeroed (the packet number is kept). */
void GuardedClearGamepad(XINPUT_STATE* state) {
  __try {
    std::memset(&state->Gamepad, 0, sizeof state->Gamepad);
  } __except (InputFilter(GetExceptionCode())) {
  }
}

template <int Dll, int Function>
DWORD WINAPI HookXInputGetState(DWORD user, XINPUT_STATE* state) {
  const XInputGetStateFn original = g_xinputOriginal[Dll][Function].load();
  if (!original) return ERROR_DEVICE_NOT_CONNECTED;
  const DWORD result = original(user, state);
  if (result == ERROR_SUCCESS && state && InputBlocked()) GuardedClearGamepad(state);
  return result;
}

constexpr XInputGetStateFn kXInputHooks[kXInputDllCount][2] = {
    {&HookXInputGetState<0, 0>, &HookXInputGetState<0, 1>},
    {&HookXInputGetState<1, 0>, &HookXInputGetState<1, 1>},
    {&HookXInputGetState<2, 0>, &HookXInputGetState<2, 1>},
};

int XInputDllIndex(const char* name) {
  for (int i = 0; i < kXInputDllCount; i++) {
    if (_stricmp(name, kXInputDlls[i]) == 0) return i;
  }
  return -1;
}

bool IsOurHook(void* fn) {
  for (const auto& dll : kXInputHooks) {
    for (const auto hook : dll) {
      if (reinterpret_cast<void*>(hook) == fn) return true;
    }
  }
  return false;
}

/** Which function an import names: 0 XInputGetState, 1 XInputGetStateEx, -1 neither. */
int XInputFunction(const uint8_t* base, ULONGLONG nameThunk) {
  if (IMAGE_SNAP_BY_ORDINAL64(nameThunk)) return IMAGE_ORDINAL64(nameThunk) == kGetStateExOrdinal ? 1 : -1;
  const auto* byName = reinterpret_cast<const IMAGE_IMPORT_BY_NAME*>(base + (nameThunk & 0x7FFFFFFF));
  if (std::strcmp(byName->Name, "XInputGetState") == 0) return 0;
  if (std::strcmp(byName->Name, "XInputGetStateEx") == 0) return 1;
  return -1;
}

/** The real function for a delay-load slot not yet bound (it still points at the module's own stub). */
XInputGetStateFn Resolve(int dll, int function) {
  HMODULE module = GetModuleHandleA(kXInputDlls[dll]);
  if (!module) return nullptr;
  return reinterpret_cast<XInputGetStateFn>(reinterpret_cast<void*>(GetProcAddress(
      module, function ? MAKEINTRESOURCEA(kGetStateExOrdinal) : "XInputGetState")));
}

/** Patches one import address table slot; `bound`: false for a delay-load slot that may still hold its stub. */
int PatchXInputSlot(HMODULE module, uint64_t* slot, int dll, int function, bool bound) {
  void* current = reinterpret_cast<void*>(*slot);
  if (IsOurHook(current)) return 0;
  XInputGetStateFn original = reinterpret_cast<XInputGetStateFn>(current);
  if (!bound) {
    MODULEINFO info{};
    GetModuleInformation(GetCurrentProcess(), module, &info, sizeof info);
    const auto* start = static_cast<const uint8_t*>(info.lpBaseOfDll);
    const auto* at = static_cast<const uint8_t*>(current);
    if (at >= start && at < start + info.SizeOfImage) original = Resolve(dll, function);  // still the stub
    if (!original) return 0;  // the DLL is not loaded yet: the next scan tries again
  }
  XInputGetStateFn expected = nullptr;
  g_xinputOriginal[dll][function].compare_exchange_strong(expected, original);
  return PatchPointer(reinterpret_cast<void**>(slot), reinterpret_cast<void*>(kXInputHooks[dll][function])) ? 1 : 0;
}

int PatchModuleImports(HMODULE module) {
  auto* base = reinterpret_cast<uint8_t*>(module);
  const auto* dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
  const auto* nt = reinterpret_cast<const IMAGE_NT_HEADERS64*>(base + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC) return 0;
  int patched = 0;

  const auto& imports = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  if (imports.VirtualAddress && imports.Size) {
    for (auto* d = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(base + imports.VirtualAddress); d->Name; d++) {
      const int dll = XInputDllIndex(reinterpret_cast<const char*>(base + d->Name));
      if (dll < 0 || !d->OriginalFirstThunk || !d->FirstThunk) continue;
      auto* names = reinterpret_cast<const IMAGE_THUNK_DATA64*>(base + d->OriginalFirstThunk);
      auto* slots = reinterpret_cast<IMAGE_THUNK_DATA64*>(base + d->FirstThunk);
      for (; names->u1.AddressOfData; names++, slots++) {
        const int function = XInputFunction(base, names->u1.AddressOfData);
        if (function >= 0) patched += PatchXInputSlot(module, &slots->u1.Function, dll, function, true);
      }
    }
  }

  const auto& delayed = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT];
  if (delayed.VirtualAddress && delayed.Size) {
    for (auto* d = reinterpret_cast<const ImgDelayDescr*>(base + delayed.VirtualAddress); d->rvaDLLName; d++) {
      if (!(d->grAttrs & dlattrRva)) continue;
      const int dll = XInputDllIndex(reinterpret_cast<const char*>(base + d->rvaDLLName));
      if (dll < 0 || !d->rvaINT || !d->rvaIAT) continue;
      auto* names = reinterpret_cast<const IMAGE_THUNK_DATA64*>(base + d->rvaINT);
      auto* slots = reinterpret_cast<IMAGE_THUNK_DATA64*>(base + d->rvaIAT);
      for (; names->u1.AddressOfData; names++, slots++) {
        const int function = XInputFunction(base, names->u1.AddressOfData);
        if (function >= 0) patched += PatchXInputSlot(module, &slots->u1.Function, dll, function, false);
      }
    }
  }
  return patched;
}

/** Whether the module is part of Windows (under the Windows folder): its imports are left alone. */
bool IsSystemModule(HMODULE module) {
  wchar_t path[MAX_PATH * 2];
  const DWORD length = GetModuleFileNameW(module, path, MAX_PATH * 2);
  if (!length || length >= MAX_PATH * 2) return true;
  wchar_t windows[MAX_PATH];
  const UINT windowsLength = GetWindowsDirectoryW(windows, MAX_PATH);
  if (!windowsLength || windowsLength >= MAX_PATH) return false;
  return _wcsnicmp(path, windows, windowsLength) == 0 && (path[windowsLength] == L'\\' || path[windowsLength] == 0);
}

int PatchXInputImports() {
  std::vector<HMODULE> modules(1024);
  DWORD needed = 0;
  if (!EnumProcessModules(GetCurrentProcess(), modules.data(), static_cast<DWORD>(modules.size() * sizeof(HMODULE)),
                          &needed))
    return 0;
  modules.resize((std::min)(modules.size(), static_cast<size_t>(needed / sizeof(HMODULE))));
  int patched = 0;
  for (HMODULE module : modules) {
    if (module == g_self || IsSystemModule(module)) continue;
    patched += PatchModuleImports(module);
  }
  return patched;
}

// ---- DirectInput8 -----------------------------------------------------------------------------------------------

using GetDeviceStateWFn = HRESULT(STDMETHODCALLTYPE*)(IDirectInputDevice8W*, DWORD, LPVOID);
using GetDeviceDataWFn = HRESULT(STDMETHODCALLTYPE*)(IDirectInputDevice8W*, DWORD, LPDIDEVICEOBJECTDATA, LPDWORD,
                                                     DWORD);
using GetDeviceStateAFn = HRESULT(STDMETHODCALLTYPE*)(IDirectInputDevice8A*, DWORD, LPVOID);
using GetDeviceDataAFn = HRESULT(STDMETHODCALLTYPE*)(IDirectInputDevice8A*, DWORD, LPDIDEVICEOBJECTDATA, LPDWORD,
                                                     DWORD);
using DirectInput8CreateFn = HRESULT(WINAPI*)(HINSTANCE, DWORD, REFIID, LPVOID*, LPUNKNOWN);

constexpr int kGetDeviceStateIndex = 9;
constexpr int kGetDeviceDataIndex = 10;

GetDeviceStateWFn g_stateW = nullptr;
GetDeviceDataWFn g_dataW = nullptr;
GetDeviceStateAFn g_stateA = nullptr;
GetDeviceDataAFn g_dataA = nullptr;
bool g_directInputHooked = false;

/** The stick positions each controller last reported unblocked, so a blocked read keeps them resting there. */
struct RestingAxes {
  void* device = nullptr;
  LONG axes[8] = {};  // lX, lY, lZ, lRx, lRy, lRz, rglSlider[2]
};
SRWLOCK g_axesLock = SRWLOCK_INIT;
RestingAxes g_axes[8];
int g_axesNext = 0;

bool IsJoystickState(DWORD size) { return size == sizeof(DIJOYSTATE) || size == sizeof(DIJOYSTATE2); }

void RememberAxes(void* device, const DIJOYSTATE* state) {
  AcquireSRWLockExclusive(&g_axesLock);
  RestingAxes* slot = nullptr;
  for (auto& a : g_axes) {
    if (a.device == device) slot = &a;
  }
  if (!slot) {
    slot = &g_axes[g_axesNext];
    g_axesNext = (g_axesNext + 1) % 8;
    slot->device = device;
  }
  std::memcpy(slot->axes, &state->lX, sizeof slot->axes);
  ReleaseSRWLockExclusive(&g_axesLock);
}

/** A controller state with nothing pressed: buttons up, hats centred, sticks where they last rested. */
void NeutralState(void* device, DWORD size, void* data) {
  if (!IsJoystickState(size)) {
    std::memset(data, 0, size);  // an unknown data format: zeroed
    return;
  }
  auto* state = static_cast<DIJOYSTATE*>(data);
  LONG axes[8];
  std::memcpy(axes, &state->lX, sizeof axes);
  AcquireSRWLockShared(&g_axesLock);
  for (const auto& a : g_axes) {
    if (a.device == device) std::memcpy(axes, a.axes, sizeof axes);
  }
  ReleaseSRWLockShared(&g_axesLock);
  std::memset(data, 0, size);
  std::memcpy(&state->lX, axes, sizeof axes);
  for (auto& pov : state->rgdwPOV) pov = 0xFFFFFFFF;
}

template <typename Device>
bool IsController(Device* device) {
  DIDEVCAPS caps{};
  caps.dwSize = sizeof caps;
  if (FAILED(device->GetCapabilities(&caps))) return false;
  switch (GET_DIDEVICE_TYPE(caps.dwDevType)) {
    case DI8DEVTYPE_JOYSTICK:
    case DI8DEVTYPE_GAMEPAD:
    case DI8DEVTYPE_DRIVING:
    case DI8DEVTYPE_FLIGHT:
    case DI8DEVTYPE_1STPERSON:
      return true;
    default:
      return false;
  }
}

template <typename Device>
void AfterGetDeviceState(Device* device, DWORD size, void* data) {
  if (!data) return;
  if (!InputBlocked()) {
    if (IsJoystickState(size)) RememberAxes(device, static_cast<DIJOYSTATE*>(data));
    return;
  }
  if (IsController(device)) NeutralState(device, size, data);
}

template <typename Device>
void GuardedAfterGetDeviceState(Device* device, DWORD size, void* data) {
  __try {
    AfterGetDeviceState(device, size, data);
  } __except (InputFilter(GetExceptionCode())) {
  }
}

template <typename Device>
void GuardedAfterGetDeviceData(Device* device, LPDWORD count) {
  __try {
    if (count && InputBlocked() && IsController(device)) *count = 0;  // read (and so dropped), none returned
  } __except (InputFilter(GetExceptionCode())) {
  }
}

HRESULT STDMETHODCALLTYPE HookGetDeviceStateW(IDirectInputDevice8W* self, DWORD size, LPVOID data) {
  const HRESULT hr = g_stateW(self, size, data);
  if (SUCCEEDED(hr) && !g_faulted.load()) GuardedAfterGetDeviceState(self, size, data);
  return hr;
}

HRESULT STDMETHODCALLTYPE HookGetDeviceStateA(IDirectInputDevice8A* self, DWORD size, LPVOID data) {
  const HRESULT hr = g_stateA(self, size, data);
  if (SUCCEEDED(hr) && !g_faulted.load()) GuardedAfterGetDeviceState(self, size, data);
  return hr;
}

HRESULT STDMETHODCALLTYPE HookGetDeviceDataW(IDirectInputDevice8W* self, DWORD objectSize, LPDIDEVICEOBJECTDATA data,
                                             LPDWORD count, DWORD flags) {
  const HRESULT hr = g_dataW(self, objectSize, data, count, flags);
  if (SUCCEEDED(hr) && !g_faulted.load()) GuardedAfterGetDeviceData(self, count);
  return hr;
}

HRESULT STDMETHODCALLTYPE HookGetDeviceDataA(IDirectInputDevice8A* self, DWORD objectSize, LPDIDEVICEOBJECTDATA data,
                                             LPDWORD count, DWORD flags) {
  const HRESULT hr = g_dataA(self, objectSize, data, count, flags);
  if (SUCCEEDED(hr) && !g_faulted.load()) GuardedAfterGetDeviceData(self, count);
  return hr;
}

template <typename Fn>
void PatchVtable(void** vtable, int index, Fn hook, Fn& original) {
  if (vtable[index] == reinterpret_cast<void*>(hook)) return;
  original = reinterpret_cast<Fn>(vtable[index]);
  PatchPointer(&vtable[index], reinterpret_cast<void*>(hook));
}

/** The vtable of a dummy system keyboard device (every DirectInput8 device shares its class). */
template <typename DirectInput, typename Device>
void** DeviceVtable(DirectInput8CreateFn create, REFIID iid) {
  DirectInput* input = nullptr;
  if (FAILED(create(g_self, DIRECTINPUT_VERSION, iid, reinterpret_cast<void**>(&input), nullptr)) || !input)
    return nullptr;
  Device* device = nullptr;
  void** vtable = nullptr;
  if (SUCCEEDED(input->CreateDevice(GUID_SysKeyboard, &device, nullptr)) && device) {
    vtable = *reinterpret_cast<void***>(device);
    device->Release();
  }
  input->Release();
  return vtable;
}

/** Hooks DirectInput8 once dinput8.dll is loaded by the game (never loaded by the DLL itself). */
void HookDirectInput() {
  if (g_directInputHooked) return;
  HMODULE dinput = GetModuleHandleW(L"dinput8.dll");
  if (!dinput) return;
  auto create = reinterpret_cast<DirectInput8CreateFn>(
      reinterpret_cast<void*>(GetProcAddress(dinput, "DirectInput8Create")));
  if (!create) return;
  g_directInputHooked = true;
  if (void** w = DeviceVtable<IDirectInput8W, IDirectInputDevice8W>(create, IID_IDirectInput8W)) {
    PatchVtable(w, kGetDeviceStateIndex, &HookGetDeviceStateW, g_stateW);
    PatchVtable(w, kGetDeviceDataIndex, &HookGetDeviceDataW, g_dataW);
  }
  if (void** a = DeviceVtable<IDirectInput8A, IDirectInputDevice8A>(create, IID_IDirectInput8A)) {
    PatchVtable(a, kGetDeviceStateIndex, &HookGetDeviceStateA, g_stateA);
    PatchVtable(a, kGetDeviceDataIndex, &HookGetDeviceDataA, g_dataA);
  }
  Log("info", "DirectInput8 controller reads hooked");
}

std::mutex g_installMutex;
int g_xinputSlots = 0;

}  // namespace

void InstallInputHooks() {
  std::lock_guard lock(g_installMutex);
  if (const int patched = PatchXInputImports()) {
    g_xinputSlots += patched;
    Log("info", "XInput imports hooked: " + std::to_string(patched));
  }
  HookDirectInput();
}

std::string InputHookSummary() {
  std::lock_guard lock(g_installMutex);
  return "XInput import slots: " + std::to_string(g_xinputSlots) + ", DirectInput8: " + (g_directInputHooked ? "yes" : "no");
}

}  // namespace playout::hook
