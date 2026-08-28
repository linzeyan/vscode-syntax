// Minimal post-process pass: tonemap plus vignette.
cbuffer FrameConstants : register(b0)
{
    float4x4 ViewProjection;
    float2   ScreenSize;
    float    Exposure;
    float    VignetteStrength;
};

Texture2D<float4> SceneColor : register(t0);
SamplerState      LinearClamp : register(s0);

struct VSOutput
{
    float4 Position : SV_POSITION;
    float2 UV       : TEXCOORD0;
};

VSOutput VSMain(uint id : SV_VertexID)
{
    VSOutput o;
    o.UV = float2((id << 1) & 2, id & 2);
    o.Position = float4(o.UV * float2(2.0f, -2.0f) + float2(-1.0f, 1.0f), 0.0f, 1.0f);
    return o;
}

float3 Tonemap(float3 c)
{
    return saturate(c / (c + 1.0f.xxx));
}

float4 PSMain(VSOutput input) : SV_TARGET
{
    float3 color = SceneColor.Sample(LinearClamp, input.UV).rgb * Exposure;
    float  d = distance(input.UV, float2(0.5f, 0.5f));
    color *= lerp(1.0f, 1.0f - VignetteStrength, saturate(d * 2.0f));
    return float4(Tonemap(color), 1.0f);
}
