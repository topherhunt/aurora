// ---------------------------------------------------------------------------
// The frog's skinned animation, played from a texture (tools/creatures/
// ship-frog.mjs bakes it from the bogpip rig). A frame of a clip is one texture
// row holding every bone's 3x4 skin matrix; the vertex shader blends its four
// bones' rows from the two frames around the instance's clip time and moves the
// vertex and its normal by the sum. One draw call per tier serves every frog.
//
// Per instance `frogAnim` = (row of frame A, row of frame B, blend of B over A,
// weight of the pose over the bind pose). A hop plays the hop clip across its
// flight and fades in from the bind pose and out to it over HOP_FADE of it at
// either end; a sit plays the idle loop, faded over IDLE_FADE_S at either end
// of the sit. The idle sits within a few percent of the bind pose, so the hand-
// offs between the two are near-seamless. A frog on its plan has `frogAnim`
// built in the vertex shader (frogs.js); one the CPU draws, and a held copy
// (all zeros: the bind pose), reads it from `aAnim`.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

export const FROG_ANIM_URL = 'creatures/bogpip-anim.bin'
/** The fraction of a hop's flight its pose fades in over, and out over. */
export const HOP_FADE = 0.2
/** Seconds a sit's idle fades in over, and out over. */
export const IDLE_FADE_S = 0.15

/** Parse the baked file (ship-frog.mjs): `{ bones, rows, idle, hop, texture }`, each clip `{ base, frames, seconds }` over `frames + 1` rows, its last the same pose as its first. */
export function parseFrogAnim(buffer) {
  const hl = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hl)))
  const data = new Uint16Array(buffer.slice(4 + hl))
  if (data.length !== header.rows * header.bones * 12) throw new Error(`frog-anim: ${data.length} halves for ${header.rows} rows of ${header.bones} bones`)
  const idle = header.clips.find((c) => c.name === 'idle')
  const hop = header.clips.find((c) => c.name === 'hop')
  if (!idle || !hop) throw new Error('frog-anim: the file needs an idle and a hop')
  const texture = new THREE.DataTexture(data, header.bones * 3, header.rows, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return { bones: header.bones, rows: header.rows, idle, hop, data, texture }
}

export async function loadFrogAnim(url = FROG_ANIM_URL) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`frog-anim: ${url} ${res.status}`)
  return parseFrogAnim(await res.arrayBuffer())
}

const smooth = (u) => u * u * (3 - 2 * u)
const clamp01 = (u) => Math.max(0, Math.min(1, u))

/** `aAnim` at `out[o..o+3]` for `clip` at `u` of its length (0..1) with pose weight `w`. */
export function writeAnim(clip, u, w, out, o) {
  const f = clamp01(u) * clip.frames
  const r = Math.min(Math.floor(f), clip.frames - 1)
  out[o] = clip.base + r
  out[o + 1] = clip.base + r + 1
  out[o + 2] = f - r
  out[o + 3] = w
}

/** A hop's pose weight at `u` of its flight. */
export const hopWeight = (u) => smooth(clamp01(Math.min(u, 1 - u) / HOP_FADE))
/** A sit's idle weight `e` seconds into it, of `dur` (an endless or zero-length one fades in only). */
export const idleWeight = (e, dur) => smooth(clamp01(Math.min(e, dur > 0 && dur < Infinity ? dur - e : Infinity) / IDLE_FADE_S))

/**
 * The GLSL. uFrogClips = idle base, idle frames, hop base, hop frames; uFrogIdle the room's clock in idle loops,
 * folded to [0, 1). frogIdle and frogHop build `frogAnim` for MOTION_GLSL; `turn` is the frog's own offset in turns.
 */
export const FROG_ANIM_PARS = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aAnim;
uniform highp sampler2D uFrogAnim;
uniform vec4 uFrogClips;
uniform float uFrogIdle;
vec4 frogAnim = vec4( 0.0 );
float frogFade( float x ) { x = clamp( x, 0.0, 1.0 ); return x * x * ( 3.0 - 2.0 * x ); }
vec4 frogClip( float base, float frames, float u, float w ) {
  float f = clamp( u, 0.0, 1.0 ) * frames;
  float r = min( floor( f ), frames - 1.0 );
  return vec4( base + r, base + r + 1.0, f - r, w );
}
vec4 frogIdle( float turn, float e, float dur ) {
  return frogClip( uFrogClips.x, uFrogClips.y, fract( uFrogIdle + turn ), frogFade( min( e, dur - e ) / ${IDLE_FADE_S.toFixed(4)} ) );
}
vec4 frogHop( float u ) {
  return frogClip( uFrogClips.z, uFrogClips.w, u, frogFade( min( u, 1.0 - u ) / ${HOP_FADE.toFixed(4)} ) );
}
vec4 frogRows( int a, int b, int x ) {
  return mix( texelFetch( uFrogAnim, ivec2( x, a ), 0 ), texelFetch( uFrogAnim, ivec2( x, b ), 0 ), frogAnim.z );
}
`
/** The skin's three rows, mixed from the bind pose by the weight; then the normal through them. */
export const FROG_ANIM_NORMAL = /* glsl */ `
#ifndef USE_INSTANCING
frogAnim = aAnim;
#endif
vec4 frogR0 = vec4( 0.0 ), frogR1 = vec4( 0.0 ), frogR2 = vec4( 0.0 );
{
  int a = int( frogAnim.x + 0.5 ), b = int( frogAnim.y + 0.5 );
  for ( int j = 0; j < 4; j ++ ) {
    int x = int( skinIndex[ j ] + 0.5 ) * 3;
    float sw = skinWeight[ j ];
    frogR0 += sw * frogRows( a, b, x );
    frogR1 += sw * frogRows( a, b, x + 1 );
    frogR2 += sw * frogRows( a, b, x + 2 );
  }
  frogR0 = mix( vec4( 1.0, 0.0, 0.0, 0.0 ), frogR0, frogAnim.w );
  frogR1 = mix( vec4( 0.0, 1.0, 0.0, 0.0 ), frogR1, frogAnim.w );
  frogR2 = mix( vec4( 0.0, 0.0, 1.0, 0.0 ), frogR2, frogAnim.w );
}
objectNormal = vec3( dot( frogR0.xyz, objectNormal ), dot( frogR1.xyz, objectNormal ), dot( frogR2.xyz, objectNormal ) );
`
export const FROG_ANIM_VERTEX = /* glsl */ `
transformed = vec3( dot( frogR0.xyz, transformed ) + frogR0.w, dot( frogR1.xyz, transformed ) + frogR1.w, dot( frogR2.xyz, transformed ) + frogR2.w );
`
