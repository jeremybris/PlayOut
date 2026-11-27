// PlayOutOverlay64.dll: the Direct3D 11 renderer (see renderer.h).
#include "hook/renderer.h"

#include <cstring>

#include "hook/state.h"
#include "overlay_ps.h"
#include "overlay_vs.h"

namespace playout::hook {

namespace {

bool IsSrgb(DXGI_FORMAT format) {
  return format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB || format == DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
}

/**
 * The game's pipeline state around one overlay draw. With ID3D11DeviceContext1 the whole state is swapped for the
 * overlay's own (SwapDeviceContextState) and swapped back; otherwise exactly the bindings the draw changes are saved
 * and restored. Restores in its destructor, so a structured exception (the DLL builds with /EHa) still restores.
 */
class SavedState {
 public:
  SavedState(ID3D11DeviceContext* context, ID3D11DeviceContext1* context1, ID3DDeviceContextState* state)
      : context_(context), context1_(context1) {
    if (context1_ && state) {
      context1_->SwapDeviceContextState(state, &previous_);
      swapped_ = true;
      return;
    }
    context_->IAGetInputLayout(&layout_);
    context_->IAGetPrimitiveTopology(&topology_);
    context_->VSGetShader(&vs_, nullptr, nullptr);
    context_->GSGetShader(&gs_, nullptr, nullptr);
    context_->HSGetShader(&hs_, nullptr, nullptr);
    context_->DSGetShader(&ds_, nullptr, nullptr);
    context_->PSGetShader(&ps_, nullptr, nullptr);
    context_->PSGetShaderResources(0, 1, &srv_);
    context_->PSGetSamplers(0, 1, &sampler_);
    context_->RSGetState(&raster_);
    viewportCount_ = D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE;
    context_->RSGetViewports(&viewportCount_, viewports_);
    context_->OMGetRenderTargets(D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, rtvs_, &dsv_);
    context_->OMGetBlendState(&blend_, blendFactor_, &sampleMask_);
    context_->OMGetDepthStencilState(&depth_, &stencilRef_);
  }

  ~SavedState() {
    if (swapped_) {
      context1_->SwapDeviceContextState(previous_, nullptr);
      if (previous_) previous_->Release();
      return;
    }
    context_->IASetInputLayout(layout_);
    context_->IASetPrimitiveTopology(topology_);
    context_->VSSetShader(vs_, nullptr, 0);
    context_->GSSetShader(gs_, nullptr, 0);
    context_->HSSetShader(hs_, nullptr, 0);
    context_->DSSetShader(ds_, nullptr, 0);
    context_->PSSetShader(ps_, nullptr, 0);
    context_->PSSetShaderResources(0, 1, &srv_);
    context_->PSSetSamplers(0, 1, &sampler_);
    context_->RSSetState(raster_);
    context_->RSSetViewports(viewportCount_, viewports_);
    context_->OMSetRenderTargets(D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT, rtvs_, dsv_);
    context_->OMSetBlendState(blend_, blendFactor_, sampleMask_);
    context_->OMSetDepthStencilState(depth_, stencilRef_);
    for (IUnknown* p : std::initializer_list<IUnknown*>{layout_, vs_, gs_, hs_, ds_, ps_, srv_, sampler_, raster_, dsv_,
                                                       blend_, depth_}) {
      if (p) p->Release();
    }
    for (ID3D11RenderTargetView* rtv : rtvs_) {
      if (rtv) rtv->Release();
    }
  }

  SavedState(const SavedState&) = delete;
  SavedState& operator=(const SavedState&) = delete;

 private:
  ID3D11DeviceContext* context_;
  ID3D11DeviceContext1* context1_;
  bool swapped_ = false;
  ID3DDeviceContextState* previous_ = nullptr;
  ID3D11InputLayout* layout_ = nullptr;
  D3D11_PRIMITIVE_TOPOLOGY topology_ = D3D11_PRIMITIVE_TOPOLOGY_UNDEFINED;
  ID3D11VertexShader* vs_ = nullptr;
  ID3D11GeometryShader* gs_ = nullptr;
  ID3D11HullShader* hs_ = nullptr;
  ID3D11DomainShader* ds_ = nullptr;
  ID3D11PixelShader* ps_ = nullptr;
  ID3D11ShaderResourceView* srv_ = nullptr;
  ID3D11SamplerState* sampler_ = nullptr;
  ID3D11RasterizerState* raster_ = nullptr;
  UINT viewportCount_ = 0;
  D3D11_VIEWPORT viewports_[D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE] = {};
  ID3D11RenderTargetView* rtvs_[D3D11_SIMULTANEOUS_RENDER_TARGET_COUNT] = {};
  ID3D11DepthStencilView* dsv_ = nullptr;
  ID3D11BlendState* blend_ = nullptr;
  FLOAT blendFactor_[4] = {};
  UINT sampleMask_ = 0xFFFFFFFF;
  ID3D11DepthStencilState* depth_ = nullptr;
  UINT stencilRef_ = 0;
};

}  // namespace

bool Renderer::Prepare(IDXGISwapChain* swapChain) {
  ComPtr<ID3D11Device> device;
  if (FAILED(swapChain->GetDevice(IID_PPV_ARGS(&device)))) return false;  // not Direct3D 11 (Direct3D 12, 10)
  if (device.Get() == device_.Get()) return true;
  ReleaseAll();
  if (device->GetFeatureLevel() < D3D_FEATURE_LEVEL_10_0) return false;
  device_ = device;
  device_->GetImmediateContext(&context_);
  if (!CreateResources()) {
    Log("error", "the overlay's Direct3D 11 resources could not be created");
    ReleaseAll();
    return false;
  }
  Log("info", context1_ ? "renderer ready (device context state swap)" : "renderer ready (saved bindings)");
  return true;
}

bool Renderer::CreateResources() {
  if (FAILED(device_->CreateVertexShader(g_overlayVs, sizeof g_overlayVs, nullptr, &vs_))) return false;
  if (FAILED(device_->CreatePixelShader(g_overlayPs, sizeof g_overlayPs, nullptr, &ps_))) return false;

  D3D11_SAMPLER_DESC sampler{};
  sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  sampler.ComparisonFunc = D3D11_COMPARISON_NEVER;
  sampler.MaxLOD = D3D11_FLOAT32_MAX;
  if (FAILED(device_->CreateSamplerState(&sampler, &sampler_))) return false;

  // Premultiplied alpha: result = overlay + game * (1 - overlay alpha).
  D3D11_BLEND_DESC blend{};
  auto& rt = blend.RenderTarget[0];
  rt.BlendEnable = TRUE;
  rt.SrcBlend = D3D11_BLEND_ONE;
  rt.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
  rt.BlendOp = D3D11_BLEND_OP_ADD;
  rt.SrcBlendAlpha = D3D11_BLEND_ONE;
  rt.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
  rt.BlendOpAlpha = D3D11_BLEND_OP_ADD;
  rt.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
  if (FAILED(device_->CreateBlendState(&blend, &blend_))) return false;

  D3D11_RASTERIZER_DESC raster{};
  raster.FillMode = D3D11_FILL_SOLID;
  raster.CullMode = D3D11_CULL_NONE;
  raster.DepthClipEnable = TRUE;
  if (FAILED(device_->CreateRasterizerState(&raster, &raster_))) return false;

  D3D11_DEPTH_STENCIL_DESC depth{};
  depth.DepthEnable = FALSE;
  depth.DepthWriteMask = D3D11_DEPTH_WRITE_MASK_ZERO;
  depth.DepthFunc = D3D11_COMPARISON_ALWAYS;
  depth.StencilEnable = FALSE;
  if (FAILED(device_->CreateDepthStencilState(&depth, &depth_))) return false;

  // The overlay's own context state, swapped in for each draw (Windows 8 and later).
  ComPtr<ID3D11Device1> device1;
  if (SUCCEEDED(device_.As(&device1)) && SUCCEEDED(context_.As(&context1_))) {
    const D3D_FEATURE_LEVEL level = device_->GetFeatureLevel();
    const UINT flags = (device_->GetCreationFlags() & D3D11_CREATE_DEVICE_SINGLETHREADED)
                           ? D3D11_1_CREATE_DEVICE_CONTEXT_STATE_SINGLETHREADED
                           : 0;
    if (FAILED(device1->CreateDeviceContextState(flags, &level, 1, D3D11_SDK_VERSION, __uuidof(ID3D11Device1),
                                                 nullptr, &state_))) {
      state_.Reset();
      context1_.Reset();
    }
  }
  return true;
}

bool Renderer::UploadImage(bool srgb) {
  std::lock_guard lock(g_image.mutex);
  if (!g_image.width || !g_image.height) return false;
  if (!texture_ || textureWidth_ != g_image.width || textureHeight_ != g_image.height ||
      textureSizeVersion_ != g_image.sizeVersion) {
    texture_.Reset();
    srv_.Reset();
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = g_image.width;
    desc.Height = g_image.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_TYPELESS;  // viewed as UNORM, or UNORM_SRGB on an sRGB back buffer
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA data{g_image.pixels.data(), g_image.width * 4, 0};
    if (FAILED(device_->CreateTexture2D(&desc, &data, &texture_))) return false;
    textureWidth_ = g_image.width;
    textureHeight_ = g_image.height;
    textureSizeVersion_ = g_image.sizeVersion;
  } else if (g_image.dirtyRight > g_image.dirtyLeft && g_image.dirtyBottom > g_image.dirtyTop) {
    const D3D11_BOX box{g_image.dirtyLeft, g_image.dirtyTop, 0, g_image.dirtyRight, g_image.dirtyBottom, 1};
    const uint8_t* src = &g_image.pixels[(static_cast<size_t>(g_image.dirtyTop) * g_image.width + g_image.dirtyLeft) * 4];
    context_->UpdateSubresource(texture_.Get(), 0, &box, src, g_image.width * 4, 0);
  }
  g_image.dirtyLeft = g_image.dirtyTop = g_image.dirtyRight = g_image.dirtyBottom = 0;
  if (!srv_ || srvSrgb_ != srgb) {
    srv_.Reset();
    D3D11_SHADER_RESOURCE_VIEW_DESC view{};
    view.Format = srgb ? DXGI_FORMAT_B8G8R8A8_UNORM_SRGB : DXGI_FORMAT_B8G8R8A8_UNORM;
    view.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
    view.Texture2D.MipLevels = 1;
    if (FAILED(device_->CreateShaderResourceView(texture_.Get(), &view, &srv_))) return false;
    srvSrgb_ = srgb;
  }
  return true;
}

void Renderer::SetPipeline(ID3D11RenderTargetView* target, UINT width, UINT height) {
  context_->IASetInputLayout(nullptr);
  context_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  context_->VSSetShader(vs_.Get(), nullptr, 0);
  context_->GSSetShader(nullptr, nullptr, 0);
  context_->HSSetShader(nullptr, nullptr, 0);
  context_->DSSetShader(nullptr, nullptr, 0);
  context_->PSSetShader(ps_.Get(), nullptr, 0);
  ID3D11ShaderResourceView* srv = srv_.Get();
  context_->PSSetShaderResources(0, 1, &srv);
  ID3D11SamplerState* sampler = sampler_.Get();
  context_->PSSetSamplers(0, 1, &sampler);
  context_->RSSetState(raster_.Get());
  const D3D11_VIEWPORT viewport{0.0f, 0.0f, static_cast<float>(width), static_cast<float>(height), 0.0f, 1.0f};
  context_->RSSetViewports(1, &viewport);
  context_->OMSetRenderTargets(1, &target, nullptr);
  const float factor[4] = {0, 0, 0, 0};
  context_->OMSetBlendState(blend_.Get(), factor, 0xFFFFFFFF);
  context_->OMSetDepthStencilState(depth_.Get(), 0);
}

bool Renderer::Draw(IDXGISwapChain* swapChain) {
  if (!device_) return false;
  ComPtr<ID3D11Texture2D> backBuffer;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer)))) return false;
  D3D11_TEXTURE2D_DESC desc{};
  backBuffer->GetDesc(&desc);
  if (!UploadImage(IsSrgb(desc.Format))) return true;  // nothing received yet: nothing to draw
  D3D11_RENDER_TARGET_VIEW_DESC view{};
  view.Format = desc.Format;
  view.ViewDimension = desc.SampleDesc.Count > 1 ? D3D11_RTV_DIMENSION_TEXTURE2DMS : D3D11_RTV_DIMENSION_TEXTURE2D;
  ComPtr<ID3D11RenderTargetView> rtv;
  if (FAILED(device_->CreateRenderTargetView(backBuffer.Get(), &view, &rtv))) return false;
  {
    SavedState saved(context_.Get(), context1_.Get(), state_.Get());
    SetPipeline(rtv.Get(), desc.Width, desc.Height);
    context_->Draw(3, 0);
    // Unbind before the game's state comes back, so the overlay's state object keeps no back buffer reference.
    ID3D11ShaderResourceView* noSrv = nullptr;
    context_->PSSetShaderResources(0, 1, &noSrv);
    context_->OMSetRenderTargets(0, nullptr, nullptr);
  }
  return true;
}

bool Renderer::TakeSnapshot(IDXGISwapChain* swapChain) {
  if (!device_) return false;
  ComPtr<ID3D11Texture2D> backBuffer;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer)))) return false;
  D3D11_TEXTURE2D_DESC desc{};
  backBuffer->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = 0;
  desc.MiscFlags = 0;
  snapshot_.Reset();
  if (FAILED(device_->CreateTexture2D(&desc, nullptr, &snapshot_))) return false;
  context_->CopyResource(snapshot_.Get(), backBuffer.Get());
  return true;
}

bool Renderer::RestoreSnapshot(IDXGISwapChain* swapChain) {
  if (!device_ || !snapshot_) return false;
  ComPtr<ID3D11Texture2D> backBuffer;
  if (FAILED(swapChain->GetBuffer(0, IID_PPV_ARGS(&backBuffer)))) return false;
  D3D11_TEXTURE2D_DESC have{};
  D3D11_TEXTURE2D_DESC want{};
  backBuffer->GetDesc(&have);
  snapshot_->GetDesc(&want);
  if (have.Width != want.Width || have.Height != want.Height || have.Format != want.Format ||
      have.SampleDesc.Count != want.SampleDesc.Count)
    return false;
  context_->CopyResource(backBuffer.Get(), snapshot_.Get());
  return true;
}

void Renderer::ReleaseSnapshot() { snapshot_.Reset(); }

void Renderer::ReleaseAll() {
  snapshot_.Reset();
  srv_.Reset();
  texture_.Reset();
  depth_.Reset();
  raster_.Reset();
  blend_.Reset();
  sampler_.Reset();
  ps_.Reset();
  vs_.Reset();
  state_.Reset();
  context1_.Reset();
  context_.Reset();
  device_.Reset();
  textureWidth_ = textureHeight_ = 0;
  textureSizeVersion_ = 0;
}

}  // namespace playout::hook
