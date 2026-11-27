// PlayOutIngameTest.exe: a tiny Direct3D 11 "game" for scripts/ingame-harness.mjs (never shipped). It clears its
// window to an animated colour, reads XInputGetState (imported from xinput9_1_0.dll) every frame, and prints one JSON
// line per second on stdout:
//   {"frames":..,"presents":..,"fullscreen":..,"xinputButtons":..,"xinputHooked":..,"loopTicks":..,"pixel":".."}
// frames / loopTicks count the game's own loop (they stop while the overlay holds the game); presents is the swap
// chain's own Present count (it keeps going in the hold loop). pixel (with --readback) is the centre pixel of the
// last presented frame as RRGGBBAA, read back from the back buffer before the next frame is drawn.
// Arguments: --windowed (default) | --exclusive, --seconds <n> (default 30), --readback, --width/--height <px>.
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <xinput.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

extern "C" void* __imp_XInputGetState;  // the import address table slot the overlay patches

namespace {

std::atomic<uint64_t> g_frames{0};
std::atomic<uint64_t> g_loopTicks{0};
std::atomic<bool> g_fullscreen{false};
std::atomic<unsigned> g_buttons{0};
std::atomic<uint32_t> g_pixel{0};
std::atomic<bool> g_quit{false};
bool g_readback = false;

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

/** Whether the XInputGetState import slot points outside xinput9_1_0.dll (the overlay hooked it). */
bool XInputHooked() {
  HMODULE owner = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     static_cast<LPCWSTR>(__imp_XInputGetState), &owner);
  return owner != GetModuleHandleW(L"xinput9_1_0.dll");
}

uint32_t ReadCentre(ID3D11Device* device, ID3D11DeviceContext* context, IDXGISwapChain* swapChain) {
  ComPtr<ID3D11Texture2D> backBuffer;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer)))) return 0;
  D3D11_TEXTURE2D_DESC desc{};
  backBuffer->GetDesc(&desc);
  D3D11_TEXTURE2D_DESC staging = desc;
  staging.Width = staging.Height = 1;
  staging.Usage = D3D11_USAGE_STAGING;
  staging.BindFlags = 0;
  staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  staging.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> texture;
  if (FAILED(device->CreateTexture2D(&staging, nullptr, &texture))) return 0;
  const D3D11_BOX box{desc.Width / 2, desc.Height / 2, 0, desc.Width / 2 + 1, desc.Height / 2 + 1, 1};
  context->CopySubresourceRegion(texture.Get(), 0, 0, 0, 0, backBuffer.Get(), 0, &box);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  if (FAILED(context->Map(texture.Get(), 0, D3D11_MAP_READ, 0, &mapped))) return 0;
  const auto* p = static_cast<const uint8_t*>(mapped.pData);
  const uint32_t rgba = (uint32_t{p[0]} << 24) | (uint32_t{p[1]} << 16) | (uint32_t{p[2]} << 8) | p[3];  // R8G8B8A8
  context->Unmap(texture.Get(), 0);
  return rgba;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  bool exclusive = false;
  int seconds = 30;
  UINT width = 1280;
  UINT height = 720;
  for (int i = 1; i < argc; i++) {
    const std::wstring arg = argv[i];
    if (arg == L"--exclusive") exclusive = true;
    else if (arg == L"--windowed") exclusive = false;
    else if (arg == L"--readback") g_readback = true;
    else if (arg == L"--seconds" && i + 1 < argc) seconds = _wtoi(argv[++i]);
    else if (arg == L"--width" && i + 1 < argc) width = static_cast<UINT>(_wtoi(argv[++i]));
    else if (arg == L"--height" && i + 1 < argc) height = static_cast<UINT>(_wtoi(argv[++i]));
  }

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof wc;
  wc.lpfnWndProc = WindowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.lpszClassName = L"PlayOutIngameTest";
  RegisterClassExW(&wc);
  RECT rect{0, 0, static_cast<LONG>(width), static_cast<LONG>(height)};
  AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
  HWND window = CreateWindowExW(0, wc.lpszClassName, L"PlayOut in-game overlay test", WS_OVERLAPPEDWINDOW,
                                CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left, rect.bottom - rect.top, nullptr,
                                nullptr, wc.hInstance, nullptr);
  ShowWindow(window, SW_SHOW);

  DXGI_SWAP_CHAIN_DESC desc{};
  desc.BufferDesc.Width = width;
  desc.BufferDesc.Height = height;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 1;
  desc.OutputWindow = window;
  desc.Windowed = TRUE;
  // Sequential (blt model): the back buffer keeps the presented frame, so --readback sees what was shown.
  desc.SwapEffect = DXGI_SWAP_EFFECT_SEQUENTIAL;
  desc.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
  ComPtr<IDXGISwapChain> swapChain;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  if (FAILED(D3D11CreateDeviceAndSwapChain(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
                                           D3D11_SDK_VERSION, &desc, &swapChain, &device, nullptr, &context))) {
    std::fprintf(stderr, "no Direct3D 11 device\n");
    return 1;
  }
  if (exclusive && FAILED(swapChain->SetFullscreenState(TRUE, nullptr))) {
    std::fprintf(stderr, "SetFullscreenState failed\n");
  }
  if (exclusive) {
    swapChain->ResizeBuffers(0, 0, 0, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH);
  }

  // One JSON line per second, from a thread of its own: it keeps reporting while the game loop is held.
  std::thread reporter([&] {
    for (int s = 0; s < seconds && !g_quit.load(); s++) {
      Sleep(1000);
      UINT presents = 0;
      swapChain->GetLastPresentCount(&presents);
      char pixel[16];
      std::snprintf(pixel, sizeof pixel, "%08x", g_pixel.load());
      std::printf(
          "{\"t\":%d,\"frames\":%llu,\"presents\":%u,\"fullscreen\":%s,\"xinputButtons\":%u,\"xinputHooked\":%s,"
          "\"loopTicks\":%llu,\"pixel\":\"%s\"}\n",
          s + 1, static_cast<unsigned long long>(g_frames.load()), presents, g_fullscreen.load() ? "true" : "false",
          g_buttons.load(), XInputHooked() ? "true" : "false", static_cast<unsigned long long>(g_loopTicks.load()),
          pixel);
      std::fflush(stdout);
    }
    g_quit = true;
    PostMessageW(window, WM_CLOSE, 0, 0);
  });

  ComPtr<ID3D11RenderTargetView> rtv;
  UINT rtvWidth = 0;
  UINT rtvHeight = 0;
  const ULONGLONG start = GetTickCount64();
  ULONGLONG lastReadback = 0;
  MSG msg{};
  while (!g_quit.load()) {
    g_loopTicks++;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) g_quit = true;
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (g_quit.load()) break;

    XINPUT_STATE state{};
    g_buttons = XInputGetState(0, &state) == ERROR_SUCCESS ? state.Gamepad.wButtons : 0u;
    BOOL fullscreen = FALSE;
    swapChain->GetFullscreenState(&fullscreen, nullptr);
    g_fullscreen = fullscreen != FALSE;

    if (g_readback && GetTickCount64() - lastReadback >= 250) {
      lastReadback = GetTickCount64();
      g_pixel = ReadCentre(device.Get(), context.Get(), swapChain.Get());
    }

    DXGI_SWAP_CHAIN_DESC current{};
    swapChain->GetDesc(&current);
    if (!rtv || current.BufferDesc.Width != rtvWidth || current.BufferDesc.Height != rtvHeight) {
      rtv.Reset();
      ComPtr<ID3D11Texture2D> backBuffer;
      swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer));
      device->CreateRenderTargetView(backBuffer.Get(), nullptr, &rtv);
      rtvWidth = current.BufferDesc.Width;
      rtvHeight = current.BufferDesc.Height;
    }
    const float t = static_cast<float>(GetTickCount64() - start) / 1000.0f;
    const float colour[4] = {0.5f + 0.5f * std::sin(t), 0.5f + 0.5f * std::sin(t * 1.3f + 2.0f),
                             0.5f + 0.5f * std::sin(t * 0.7f + 4.0f), 1.0f};
    ID3D11RenderTargetView* target = rtv.Get();
    context->OMSetRenderTargets(1, &target, nullptr);
    context->ClearRenderTargetView(rtv.Get(), colour);
    swapChain->Present(1, 0);
    g_frames++;
  }
  reporter.join();
  if (exclusive) swapChain->SetFullscreenState(FALSE, nullptr);
  return 0;
}
