// ---------------------------------------------------------------------------
// The crab's rigid-rig animation, played from a texture (design §27, "The
// crab"; tools/creatures/ship-crab.mjs bakes it). Every vertex is one bone's;
// a frame of a clip is one texture row holding every bone's 3x4 delta from the
// bind pose; the vertex shader reads the two frames around the instance's clip
// time, blends them, and moves the vertex and its normal by that one matrix.
// One draw call serves every crab and a crab costs four floats of attribute.
//
// Per instance `aAnim` = (row of frame A, row of frame B, blend of B over A,
// weight of the pose over the bind pose). The weight is the crossfade: every
// clip passes through the bind pose at its own start, so a clip fades in from
// it and out to it and nothing pops. The clip and its time are chosen by the
// pure functions below, from the crab's key and a clock only.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { phraseRand } from '../../sim/score.js'

export const CRAB_ANIM_URL = 'creatures/shore-crab-anim.bin'
/** Seconds a clip fades in from, and out to, the bind pose. */
export const FADE_S = 0.3
/** An idle holds for a bout this long, then the crab rolls the next; every idle's length divides it, so a bout ends on the bind pose. */
export const BOUT_S = 24

/** Parse the baked file (ship-crab.mjs): `{ bones, rows, walk, idles, tiers, texture }`. */
export function parseCrabAnim(buffer) {
  const hl = new DataView(buffer).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, hl)))
  const data = new Uint16Array(buffer.slice(4 + hl))
  if (data.length !== header.rows * header.bones * 12) throw new Error(`crab-anim: ${data.length} texels for ${header.rows} rows of ${header.bones} bones`)
  const walk = header.clips.find((c) => c.kind === 'walk')
  const idles = header.clips.filter((c) => c.kind === 'idle')
  if (!walk || idles.length === 0) throw new Error('crab-anim: the file needs a walk and an idle')
  for (const c of idles) if (BOUT_S % c.seconds !== 0) throw new Error(`crab-anim: idle ${c.name} (${c.seconds} s) does not divide a ${BOUT_S} s bout`)
  const texture = new THREE.DataTexture(data, header.bones * 3, header.rows, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return { ...header, walk, idles, data, texture }
}

export async function loadCrabAnim(url = CRAB_ANIM_URL) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`crab-anim: ${url} ${res.status}`)
  return parseCrabAnim(await res.arrayBuffer())
}

/** Which idle a crab holds in bout `bout` of the standstill `salt`: a weighted roll off its key. */
export function pickIdle(anim, key, salt, bout) {
  let r = phraseRand(key, salt, bout)() * anim.idles.reduce((s, c) => s + c.weight, 0)
  for (const c of anim.idles) { r -= c.weight; if (r < 0) return c }
  return anim.idles[anim.idles.length - 1]
}

const smooth = (u) => u * u * (3 - 2 * u)
/** The pose weight `e` seconds into a phrase of `dur` seconds: up over FADE_S, down over the last FADE_S. */
export function poseWeight(e, dur) {
  return smooth(Math.max(0, Math.min(1, e / FADE_S, (dur - e) / FADE_S)))
}

/**
 * Write crab `c`'s `aAnim` at `out[o..o+3]`. `c.state` is 'go' or 'pause'; `c.phase` is the walk in cycles
 * (signed by `c.side`: the end that leads), `c.still` the seconds a standstill has lasted with `c.stillSalt`
 * telling one standstill from the next, `c.w` the pose weight.
 */
export function writeAnim(anim, c, out, o) {
  let clip, t
  if (c.state === 'go') {
    clip = anim.walk
    t = (c.phase + c.phase0) * c.side * clip.frames
  } else {
    // The key's own offset keeps a shoal of crabs out of step; bouts count from the standstill's start shifted by it.
    const s = c.still + c.phase0 * BOUT_S
    const bout = Math.floor(s / BOUT_S)
    clip = pickIdle(anim, c.key, c.stillSalt, bout)
    t = ((s - bout * BOUT_S) / clip.seconds) * clip.frames
  }
  t = ((t % clip.frames) + clip.frames) % clip.frames
  const f = Math.floor(t)
  out[o] = clip.base + f
  out[o + 1] = clip.base + ((f + 1) % clip.frames)
  out[o + 2] = t - f
  out[o + 3] = c.w
}

/** The GLSL that moves a vertex by its bone's matrix; `uCrabAnim` is the texture. */
export const CRAB_ANIM_PARS = /* glsl */ `
attribute float aBone;
attribute vec4 aAnim;
uniform highp sampler2D uCrabAnim;
vec4 crabRow( int x, int a, int b, vec4 bind ) {
  return mix( bind, mix( texelFetch( uCrabAnim, ivec2( x, a ), 0 ), texelFetch( uCrabAnim, ivec2( x, b ), 0 ), aAnim.z ), aAnim.w );
}
`
export const CRAB_ANIM_NORMAL = /* glsl */ `
int crabX = int( aBone + 0.5 ) * 3;
int crabA = int( aAnim.x + 0.5 ), crabB = int( aAnim.y + 0.5 );
vec4 crabR0 = crabRow( crabX, crabA, crabB, vec4( 1.0, 0.0, 0.0, 0.0 ) );
vec4 crabR1 = crabRow( crabX + 1, crabA, crabB, vec4( 0.0, 1.0, 0.0, 0.0 ) );
vec4 crabR2 = crabRow( crabX + 2, crabA, crabB, vec4( 0.0, 0.0, 1.0, 0.0 ) );
objectNormal = vec3( dot( crabR0.xyz, objectNormal ), dot( crabR1.xyz, objectNormal ), dot( crabR2.xyz, objectNormal ) );
`
export const CRAB_ANIM_VERTEX = /* glsl */ `
transformed = vec3( dot( crabR0.xyz, transformed ) + crabR0.w, dot( crabR1.xyz, transformed ) + crabR1.w, dot( crabR2.xyz, transformed ) + crabR2.w );
`
