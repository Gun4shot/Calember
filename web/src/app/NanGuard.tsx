// Post-processing guard against black-frame flicker (Observatory and story film).
//
// A single NaN or infinite pixel in the scene (an undefined shader op, e.g. pow() of a value a hair below zero, which
// Intel/D3D11 drivers turn into NaN) is smeared over the whole screen by the mipmap bloom: the frame goes black. On the
// team's laptop that hit about 1 frame in 5 in the area stations. Every shader was fixed at the source; this effect
// runs as its own pass BEFORE the bloom
// and replaces any non-finite pixel, so a future shader slip can never flash the screen again.
// (Bloom is NOT split off by the composer on its own: its blur step reads the pass input before any merged effect runs,
// which is why the guard needs its own pass, see below.)
// It uses BlendFunction.SRC: blending with a NaN input would keep the NaN.
import { BlendFunction, Effect, EffectAttribute } from "postprocessing";
import { forwardRef, useMemo } from "react";

// isnan()/isinf() and NaN-dropping clamps are optimised away by the D3D11 shader compiler (it assumes floats are
// finite), so the test reads the raw bits: NaN and ±Inf are exactly the values whose exponent bits are all ones.
const FRAG = /* glsl */ `
bool nonFinite(vec4 c) {
  uvec4 e = floatBitsToUint(c) & uvec4(0x7f800000u);
  return any(equal(e, uvec4(0x7f800000u)));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec4 c = inputColor;
  if (nonFinite(c)) c = vec4(0.0, 0.0, 0.0, 1.0);
  outputColor = vec4(clamp(c.rgb, vec3(0.0), vec3(64.0)), clamp(c.a, 0.0, 1.0));
}
`;

class NanGuardEffect extends Effect {
  constructor() {
    // CONVOLUTION makes the composer give this effect a pass of its own; the next pass (bloom + vignette) then reads
    // the cleaned buffer. Merged into one pass, the bloom's own blur step would still read the raw scene.
    super("NanGuardEffect", FRAG, { blendFunction: BlendFunction.SRC, attributes: EffectAttribute.CONVOLUTION });
  }
}

/** Put it first inside <EffectComposer>, before <Bloom>. */
export const NanGuard = forwardRef<NanGuardEffect>(function NanGuard(_props, ref) {
  const effect = useMemo(() => new NanGuardEffect(), []);
  return <primitive ref={ref} object={effect} dispose={null} />;
});
