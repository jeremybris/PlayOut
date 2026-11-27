// PlayOutOverlay64.dll: draws the overlay image on a Direct3D 11 swap chain's back buffer.
#pragma once
#include <d3d11_1.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <cstdint>

namespace playout::hook {

/**
 * Everything the overlay needs on the game's device: shaders, states, the overlay texture (a GPU copy of g_image,
 * updated from its dirty rectangle) and the snapshot used by the hold loop. It never keeps a reference to a back
 * buffer between calls (views on it are made and released per draw), so the game's ResizeBuffers always succeeds.
 * Used on the game's render thread only.
 */
class Renderer {
 public:
  /** Gets ready to draw with the swap chain's device; false when it is not a usable Direct3D 11 device. */
  bool Prepare(IDXGISwapChain* swapChain);
  /** Uploads pending FRAME changes and draws the overlay over back buffer 0; false on a failure. */
  bool Draw(IDXGISwapChain* swapChain);
  /** Copies back buffer 0 to the snapshot (the frame the hold loop shows). */
  bool TakeSnapshot(IDXGISwapChain* swapChain);
  /** Copies the snapshot back to back buffer 0; false when the back buffer no longer matches it. */
  bool RestoreSnapshot(IDXGISwapChain* swapChain);
  void ReleaseSnapshot();
  /** Drops every resource (going dormant, or another device). */
  void ReleaseAll();
  bool HasResources() const { return device_ != nullptr; }

 private:
  bool CreateResources();
  bool UploadImage(bool srgb);
  void SetPipeline(ID3D11RenderTargetView* target, UINT width, UINT height);

  template <typename T>
  using ComPtr = Microsoft::WRL::ComPtr<T>;

  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> context_;
  ComPtr<ID3D11DeviceContext1> context1_;
  ComPtr<ID3DDeviceContextState> state_;
  ComPtr<ID3D11VertexShader> vs_;
  ComPtr<ID3D11PixelShader> ps_;
  ComPtr<ID3D11SamplerState> sampler_;
  ComPtr<ID3D11BlendState> blend_;
  ComPtr<ID3D11RasterizerState> raster_;
  ComPtr<ID3D11DepthStencilState> depth_;
  ComPtr<ID3D11Texture2D> texture_;
  ComPtr<ID3D11ShaderResourceView> srv_;
  ComPtr<ID3D11Texture2D> snapshot_;
  uint32_t textureWidth_ = 0;
  uint32_t textureHeight_ = 0;
  uint64_t textureSizeVersion_ = 0;
  bool srvSrgb_ = false;
};

}  // namespace playout::hook
