// PlayOut's in-game overlay: one full-screen triangle that samples the overlay texture (premultiplied BGRA).
// Compiled by fxc at build time into overlay_vs.h / overlay_ps.h (CMakeLists.txt).

struct VsOut {
  float4 position : SV_Position;
  float2 uv : TEXCOORD0;
};

VsOut VSMain(uint id : SV_VertexID) {
  VsOut o;
  // Vertices 0, 1, 2 -> uv (0,0), (2,0), (0,2): one triangle covering the whole viewport.
  float2 uv = float2((id << 1) & 2, id & 2);
  o.uv = uv;
  o.position = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
  return o;
}

Texture2D overlayTexture : register(t0);
SamplerState overlaySampler : register(s0);

float4 PSMain(VsOut i) : SV_Target {
  return overlayTexture.Sample(overlaySampler, i.uv);
}
