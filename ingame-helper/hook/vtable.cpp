// PlayOutOverlay64.dll: pointer patching and the dummy device that gives the swap chain vtables.
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include "hook/hooks.h"

namespace playout::hook {

using Microsoft::WRL::ComPtr;

void* PatchPointer(void** slot, void* hook) {
  DWORD old = 0;
  if (!VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &old)) return nullptr;
  void* previous = InterlockedExchangePointer(slot, hook);
  DWORD unused = 0;
  VirtualProtect(slot, sizeof(void*), old, &unused);
  FlushInstructionCache(GetCurrentProcess(), slot, sizeof(void*));
  return previous;
}

namespace {

constexpr wchar_t kWindowClass[] = L"PlayOutOverlayDummy";

/** A window of the DLL's own for the dummy swap chain: message-only first, a hidden 8x8 popup if DXGI refuses it. */
HWND MakeWindow(bool messageOnly) {
  return CreateWindowExW(0, kWindowClass, L"PlayOut overlay", messageOnly ? 0 : WS_POPUP, 0, 0, 8, 8,
                         messageOnly ? HWND_MESSAGE : nullptr, nullptr, g_self, nullptr);
}

HRESULT CreateDummy(HWND window, ComPtr<IDXGISwapChain>& swapChain) {
  DXGI_SWAP_CHAIN_DESC desc{};
  desc.BufferDesc.Width = 8;
  desc.BufferDesc.Height = 8;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 1;
  desc.OutputWindow = window;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  ComPtr<ID3D11Device> device;
  HRESULT hr = E_FAIL;
  for (const D3D_DRIVER_TYPE type : {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP}) {
    hr = D3D11CreateDeviceAndSwapChain(nullptr, type, nullptr, 0, nullptr, 0, D3D11_SDK_VERSION, &desc,
                                       swapChain.ReleaseAndGetAddressOf(), device.ReleaseAndGetAddressOf(), nullptr,
                                       nullptr);
    if (SUCCEEDED(hr)) break;
  }
  return hr;
}

}  // namespace

bool FindSwapChainVtables(SwapChainVtables& out, std::string& error) {
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof wc;
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = g_self;
  wc.lpszClassName = kWindowClass;
  RegisterClassExW(&wc);
  HRESULT hr = E_FAIL;
  ComPtr<IDXGISwapChain> swapChain;
  for (const bool messageOnly : {true, false}) {
    HWND window = MakeWindow(messageOnly);
    if (!window) continue;
    hr = CreateDummy(window, swapChain);
    if (SUCCEEDED(hr)) {
      out.swapChain = *reinterpret_cast<void***>(swapChain.Get());
      ComPtr<IDXGISwapChain1> swapChain1;
      if (SUCCEEDED(swapChain.As(&swapChain1))) out.swapChain1 = *reinterpret_cast<void***>(swapChain1.Get());
    }
    swapChain.Reset();
    DestroyWindow(window);
    if (SUCCEEDED(hr)) break;
  }
  UnregisterClassW(kWindowClass, g_self);
  if (!out.swapChain) {
    char text[96];
    wsprintfA(text, "the dummy Direct3D 11 swap chain could not be created (0x%08lX)", static_cast<unsigned long>(hr));
    error = text;
    return false;
  }
  return true;
}

}  // namespace playout::hook
