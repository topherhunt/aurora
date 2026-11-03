// ---------------------------------------------------------------------------
// THE BAKED PUPPET: Puppet's API over every clip pre-sampled into a texture, so
// every creature of one look and tier is ONE InstancedMesh draw, skinned in
// the vertex shader from a per-instance (row, row, blend). No mixer, no bone
// texture upload, no per-animal draw. Given up against Puppet: foot IK, clip
// crossfades, and the solvers (dragon tail lag, wild strider head turn), which
// `solverStub` stands in for. design/27-creature-pipeline.md §Baked
// puppets has the layout and the swap.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { Puppet, cloneBones, lodFadeS, poseSphere } from './puppet.js'
import { TIER_TINTS, tierTintOn } from './critters.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32, keyHash } from '../../sim/score.js'

// Clip sample rates, coarsest first: a clip takes the first whose blend between rows stays within TOL of its RATES[last] samples.
const RATES = [5, 10, 15, 30]
// Of the body's pose-sphere radius, on a per-bone bound that overstates the vertex error: on townsfolk it costs at most 0.4% of body height.
const TOL = 0.025
const MAX_ROWS = 4096
// Milliseconds of bake a flush may spend, over every skeleton waiting; a body whose skeleton is still waiting is drawn from the flush that finishes it.
const BAKE_MS = 0.5
// Values converted to half float between budget checks.
const HALF_CHUNK = 4096
const MODE_KEY = 'v2.puppets'
const IDENTITY = new THREE.Matrix4()
// The longest a body glides on from its last write: one the layer stops writing stops this far on.
export const GLIDE_S = 0.1
// Wall seconds a puppet's step may disagree with the clock before its clip is re-anchored to the step's time.
const OWED_S = 1e-3
const TIME_HI = 1024

// THE CLOCK every baked clip and glide runs on, in the shader and in `time`: the frame's dt summed. A layer stepping its puppets by that same dt writes nothing; any other step (dt * rate, a held 0) re-anchors the clip.
let clockNow = 0
let clockDt = 0
const uVatT = { value: new THREE.Vector2() }

/** Once a frame, before the layers step their puppets. */
export function advanceBakedClock(dt) {
  clockNow += dt
  clockDt = dt
}

/** `seconds` as the shader's (multiple of TIME_HI, remainder), into `out` at `o`: float32 alone loses milliseconds past an hour. */
function stampOf(seconds, out, o) {
  const hi = Math.floor(seconds / TIME_HI) * TIME_HI
  out[o] = hi
  out[o + 1] = seconds - hi
}

/** 'baked' or 'skinned': `?puppets=` wins and is remembered, then the remembered one, then baked. */
function readMode() {
  if (typeof location === 'undefined') return 'baked'
  const asked = new URLSearchParams(location.search).get('puppets')
  if (asked !== null) {
    if (asked !== 'baked' && asked !== 'skinned') throw new Error(`?puppets= is baked or skinned, not ${asked}`)
    localStorage.setItem(MODE_KEY, asked)
    return asked
  }
  return localStorage.getItem(MODE_KEY) === 'skinned' ? 'skinned' : 'baked'
}

let mode = readMode()

export function puppetMode() { return mode }

/** Which kind makePuppet builds from now on; remembered in the browser. Pools already built keep theirs. */
export function setPuppetMode(next) {
  if (next !== 'baked' && next !== 'skinned') throw new Error(`setPuppetMode: ${next}`)
  mode = next
  if (typeof location !== 'undefined') localStorage.setItem(MODE_KEY, next)
}

/** A layer's pool puppet: baked or skinned by puppetMode(). Measuring and photographing puppets stay `new Puppet`. */
export function makePuppet(asset, mats, opts) {
  return mode === 'baked' ? new BakedPuppet(asset, mats, opts) : new Puppet(asset, mats, opts)
}

/** What a baked body wears where a skinned one carries a solver: every call a no-op, `look` there to be written. */
export function solverStub() {
  return { look: { yaw: 0, pitch: 0, roll: 0 }, then: null, start() {}, steer() {}, set() {}, restore() {}, solve() {}, reset() {} }
}

/**
 * A creature's own colour from `rand`, for a baked puppet's `tint`: a multiplier
 * on its texture, any hue at a light saturation, its channel mean in
 * [0.85, 1.2] so no roll reads as lit differently. It rides the instance colour,
 * so it costs no draw; a skinned puppet has nowhere to wear it (puppet.js
 * makePuppetMaterials says why).
 */
export function rollTint(rand, out = new THREE.Color()) {
  const hue = rand(), s = 0.3 + 0.35 * rand(), v = 0.85 + 0.35 * rand()
  out.setHSL(hue, 1, 0.5)
  out.setRGB(1 - s + s * out.r, 1 - s + s * out.g, 1 - s + s * out.b)
  return out.multiplyScalar((3 * v) / (out.r + out.g + out.b))
}

/**
 * A roll like rollTint's kept to a species' natural range: anywhere along `path`,
 * linear RGB multipliers on its texture walked end to end, brightness spread
 * `spread` either way.
 */
export function tintRange(path, spread = 0.08) {
  const cols = path.map((c) => new THREE.Color().setRGB(...c))
  return (rand, out) => {
    const t = rand() * (cols.length - 1), i = Math.min(Math.floor(t), cols.length - 2)
    return out.copy(cols[i]).lerp(cols[i + 1], t - i).multiplyScalar(1 - spread + 2 * spread * rand())
  }
}

/** A baked puppet taken for the creature keyed `key` wears its `roll` (rollTint, a tintRange) seeded by that key, so every peer and every visit agree; a skinned one is left white. */
export function tintFor(puppet, key, roll) {
  if (puppet.baked) tintOf(key, roll, puppet.tint)
}

/** The colour `roll` gives the creature keyed `key`, into `out`: what tintFor dresses its baked puppet in. */
export function tintOf(key, roll, out) {
  roll(mulberry32(hash32(keyHash(key), 0x71a7)), out)
  return out
}

// ---------------------------------------------------------------------------
// THE BAKE, once per skeleton and kept, BAKE_MS a flush from the first flush
// that draws one of its bodies (or all at once on a bone read). Each clip is n+1 rows at duration/n apart, the last row the clip's
// end, so a sample between two rows never wraps; n is set by the clip's own
// rate (RATES). A row is three half-float texels a bone: the top three rows of
// bone.matrixWorld x boneInverse. A layer reading a bone gets that times the
// bone's bind matrix, so no creature-space copy is kept.
// ---------------------------------------------------------------------------
const vats = new WeakMap()

/** A skeleton's layout, known before its bake: clip lengths, bones, feet, sphere. `clips` rows (start, n) are filled by the bake. */
function vatFor(asset) {
  let v = vats.get(asset.skeleton)
  if (!v) {
    const src = asset.skeleton
    const rig = cloneBones(asset.root, new Map())
    rig.updateMatrixWorld(true)
    const nb = src.bones.length
    const bind = new Float32Array(nb * 16)
    src.boneInverses.forEach((m, j) => _m4.copy(m).invert().toArray(bind, j * 16))
    v = {
      asset, texture: null, data: null, job: null, uVat: { value: null }, nb, rows: 0, bind,
      clips: new Map(asset.clips.map((c) => [c.name, { start: -1, n: 0, duration: c.duration }])),
      feet: asset.legs ? restFeet(rig, asset.legs) : null,
      sphere: poseSphere(asset.tiers),
      names: src.bones.map((b) => b.name),
    }
    vats.set(asset.skeleton, v)
    asset.tiers[0].addEventListener('dispose', () => evict(v))
  } else if (v.clips.size !== asset.clips.length || asset.clips.some((c) => v.clips.get(c.name)?.duration !== c.duration)) {
    throw new Error('BakedPuppet: two assets share a skeleton but not their clips')
  }
  return v
}

const _m4 = new THREE.Matrix4()

/** Each bone's furthest bind-pose vertex from the origin, over every tier: how far a bone-matrix error can carry a vertex. */
function boneReach(asset, nb) {
  const reach = new Float32Array(nb)
  const p = new THREE.Vector3()
  for (const g of asset.tiers) {
    const pos = g.getAttribute('position'), si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight')
    for (let i = 0; i < pos.count; i++) {
      const r = p.fromBufferAttribute(pos, i).length()
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0) { const j = si.getComponent(i, k); if (r > reach[j]) reach[j] = r }
    }
  }
  return reach
}

/**
 * The worst distance a vertex strays when `clip`'s 3x4 rows `got` (n+1 of them) are blended at the
 * times of `truth` (m+1 rows over the same clip): per bone, the row error's translation plus its
 * linear part's Frobenius norm times the bone's reach.
 */
function blendError(got, n, truth, m, nb, reach) {
  let worst = 0
  for (let f = 0; f <= m; f++) {
    const x = (f / m) * n, r0 = Math.min(Math.floor(x), n), r1 = Math.min(r0 + 1, n), s = x - r0
    for (let j = 0; j < nb; j++) {
      const a = (r0 * nb + j) * 12, b = (r1 * nb + j) * 12, t = (f * nb + j) * 12
      let lin = 0, mov = 0
      for (let k = 0; k < 12; k++) {
        const d = got[a + k] + (got[b + k] - got[a + k]) * s - truth[t + k]
        if (k % 4 === 3) mov += d * d
        else lin += d * d
      }
      const e = Math.sqrt(mov) + Math.sqrt(lin) * reach[j]
      if (e > worst) worst = e
    }
  }
  return worst
}

/** Every `stride`th row of `truth`'s n+1. */
function strided(truth, n, stride, nb) {
  const m = n / stride, w = nb * 12
  const out = new Float32Array((m + 1) * w)
  for (let r = 0; r <= m; r++) out.set(truth.subarray(r * stride * w, (r * stride + 1) * w), r * w)
  return out
}

/**
 * More of `v`'s bake, until `budgetMs` has gone (Infinity: all of it); the last step lays every
 * clip's rows into the texture. A clip is sampled once, at RATES[last] rounded up to a multiple of
 * every coarser rate's step count, so each coarser rate's rows are a stride of those samples.
 */
function bakeSome(v, budgetMs) {
  const t0 = performance.now()
  const { asset, nb } = v
  const src = asset.skeleton
  if (!v.job) {
    const copies = new Map()
    const rig = cloneBones(asset.root, copies)
    const bones = src.bones.map((b) => {
      const c = copies.get(b)
      if (!c) throw new Error(`BakedPuppet: bone ${b.name} is not under the root`)
      return c
    })
    v.job = { rig, bones, mixer: new THREE.AnimationMixer(rig), chosen: [], ms: 0, flushes: 0, clip: null, half: null }
    v.reach ??= boneReach(asset, nb)
  }
  const job = v.job
  const { rig, bones, mixer, chosen } = job
  const top = RATES[RATES.length - 1]
  for (const r of RATES) if (top % r) throw new Error(`BakedPuppet: rate ${r} does not divide ${top}`)
  const m = _m4
  while (chosen.length < asset.clips.length && performance.now() - t0 < budgetMs) {
    if (job.half) {
      const h = job.half, end = Math.min(h.from.length, h.i + HALF_CHUNK)
      for (; h.i < end; h.i++) h.to[h.i] = THREE.DataUtils.toHalfFloat(h.from[h.i])
      if (h.i === h.from.length) { chosen.push(h.to); job.half = null }
      continue
    }
    if (!job.clip) {
      const clip = asset.clips[chosen.length]
      const n = Math.max(1, Math.ceil(clip.duration * RATES[0])) * (top / RATES[0])
      mixer.stopAllAction()
      job.clip = { clip, n, f: 0, r: 0, truth: new Float32Array((n + 1) * nb * 12), action: mixer.clipAction(clip).reset().play() }
    }
    const c = job.clip
    if (c.f <= c.n) {
      c.action.time = (c.clip.duration * c.f) / c.n
      mixer.update(0)
      rig.updateMatrixWorld(true)
      const out = c.truth
      for (let j = 0; j < nb; j++) {
        m.multiplyMatrices(bones[j].matrixWorld, src.boneInverses[j])
        const e = m.elements, o = (c.f * nb + j) * 12
        // Rows of the column-major 4x4: the shader rebuilds it with transpose().
        out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12]
        out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13]
        out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14]
      }
      c.f++
      continue
    }
    // One coarser rate tried a step, coarsest first; the first within TOL is the clip's, else all its samples are.
    const k = v.clips.get(c.clip.name)
    let got = null
    if (c.r < RATES.length - 1) {
      const stride = top / RATES[c.r++], rows = strided(c.truth, c.n, stride, nb)
      if (blendError(rows, c.n / stride, c.truth, c.n, nb, v.reach) > TOL * v.sphere.radius) continue
      k.n = c.n / stride
      got = rows
    } else {
      k.n = c.n
      got = c.truth
    }
    job.half = { from: got, to: new Uint16Array(got.length), i: 0 }
    job.clip = null
  }
  job.ms += performance.now() - t0
  job.flushes++
  if (chosen.length < asset.clips.length) return

  mixer.stopAllAction()
  mixer.uncacheRoot(rig)
  let rows = 0
  for (const cl of asset.clips) { const k = v.clips.get(cl.name); k.start = rows; rows += k.n + 1 }
  if (rows > MAX_ROWS) throw new Error(`BakedPuppet: ${rows} rows of clip, past ${MAX_ROWS}`)
  const data = new Uint16Array(rows * nb * 12)
  let o = 0
  for (const rowsOf of chosen) { data.set(rowsOf, o); o += rowsOf.length }

  const texture = new THREE.DataTexture(data, nb * 3, rows, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  v.data = data
  v.texture = texture
  v.uVat.value = texture
  v.rows = rows
  console.log(`[baked-puppet] ${nb} bones x ${rows} rows (${(data.byteLength / 1024).toFixed(0)} KB) in ${v.job.ms.toFixed(0)} ms over ${v.job.flushes} flushes`)
  v.job = null
}

/** `v` baked, now, whatever the flush budget: a bone read cannot wait. */
function ensureBaked(v) {
  if (!v.data) bakeSome(v, Infinity)
}

/** The asset's tiers are gone: the texture goes with them. */
function evict(v) {
  if (!v.texture) return
  v.texture.dispose()
  v.texture = v.data = v.uVat.value = null
}

/** Each leg's last joint at rest, creature space -- FootIK's `feet`, for a layer to read the ground under. */
function restFeet(rig, legs) {
  const byName = new Map()
  rig.traverse((b) => byName.set(b.name, b))
  const p = new THREE.Vector3()
  return legs.map((l) => {
    const name = THREE.PropertyBinding.sanitizeNodeName(l.chain[l.chain.length - 1])
    const b = byName.get(name)
    if (!b) throw new Error(`BakedPuppet: no bone named ${name}`)
    p.setFromMatrixPosition(b.matrixWorld)
    return { x: p.x, z: p.z }
  })
}

/** The (row, row, blend) of `clip` at `time`, into `out`: the shader's vatRows. */
function rowsAt(clip, time, out) {
  const f = clip.duration > 0 ? (time / clip.duration) * clip.n : 0
  const r0 = Math.min(Math.floor(f), clip.n)
  out[0] = clip.start + r0
  out[1] = clip.start + Math.min(r0 + 1, clip.n)
  out[2] = f - r0
  return out
}

// ---------------------------------------------------------------------------
// THE SHADER. Three's skinning chunks, fed from the texture instead of the
// bone uniforms; the program is otherwise the settled material's, lighting
// patch and all. USE_SKINNING is never defined, so skinIndex and skinWeight
// are declared here.
// ---------------------------------------------------------------------------
// aClip: first row, n, duration, 1 for a one-shot. aClock: anchor second (hi, lo), clip time there, rate. aGlide: m/s and rad/s about y from aGlideAt (hi, lo).
const VAT_PARS = /* glsl */ `
uniform highp sampler2D uVat;
uniform vec2 uVatT;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aClip;
attribute vec4 aClock;
attribute vec4 aGlide;
attribute vec2 aGlideAt;
vec3 vatRows() {
  float t = aClock.z + aClock.w * ( ( uVatT.x - aClock.x ) + ( uVatT.y - aClock.y ) );
  t = aClip.w > 0.5 ? clamp( t, 0.0, aClip.z ) : aClip.z > 0.0 ? mod( t, aClip.z ) : 0.0;
  float f = aClip.z > 0.0 ? t / aClip.z * aClip.y : 0.0;
  float r0 = min( floor( f ), aClip.y );
  return vec3( aClip.x + r0, aClip.x + min( r0 + 1.0, aClip.y ), f - r0 );
}
mat4 vatBone( float i, vec3 rows ) {
  int x = int( i + 0.5 ) * 3, a = int( rows.x + 0.5 ), b = int( rows.y + 0.5 );
  vec4 r0 = mix( texelFetch( uVat, ivec2( x, a ), 0 ), texelFetch( uVat, ivec2( x, b ), 0 ), rows.z );
  vec4 r1 = mix( texelFetch( uVat, ivec2( x + 1, a ), 0 ), texelFetch( uVat, ivec2( x + 1, b ), 0 ), rows.z );
  vec4 r2 = mix( texelFetch( uVat, ivec2( x + 2, a ), 0 ), texelFetch( uVat, ivec2( x + 2, b ), 0 ), rows.z );
  return transpose( mat4( r0, r1, r2, vec4( 0.0, 0.0, 0.0, 1.0 ) ) );
}
mat4 vatGlide() {
  float g = clamp( ( uVatT.x - aGlideAt.x ) + ( uVatT.y - aGlideAt.y ), 0.0, ${GLIDE_S.toFixed(3)} );
  float a = aGlide.w * g, c = cos( a ), s = sin( a );
  mat3 r = mat3( c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c );
  mat4 m = instanceMatrix;
  return mat4( vec4( r * m[0].xyz, 0.0 ), vec4( r * m[1].xyz, 0.0 ), vec4( r * m[2].xyz, 0.0 ), vec4( m[3].xyz + aGlide.xyz * g, 1.0 ) );
}
mat4 vatInstance;
#define instanceMatrix vatInstance
`
const VAT_BASE = /* glsl */ `
vec3 vatR = vatRows();
mat4 boneMatX = vatBone( skinIndex.x, vatR );
mat4 boneMatY = vatBone( skinIndex.y, vatR );
mat4 boneMatZ = vatBone( skinIndex.z, vatR );
mat4 boneMatW = vatBone( skinIndex.w, vatR );
`
const VAT_NORMAL = /* glsl */ `
mat4 skinMatrix = skinWeight.x * boneMatX + skinWeight.y * boneMatY + skinWeight.z * boneMatZ + skinWeight.w * boneMatW;
objectNormal = vec4( skinMatrix * vec4( objectNormal, 0.0 ) ).xyz;
`
const VAT_SKIN = /* glsl */ `
{
  vec4 v = vec4( transformed, 1.0 );
  transformed = ( boneMatX * v * skinWeight.x + boneMatY * v * skinWeight.y + boneMatZ * v * skinWeight.z + boneMatW * v * skinWeight.w ).xyz;
}
`

/**
 * The splice. `fade` adds the per-instance dissolve: puppet.js `dissolve` with
 * (cut, side) from `aFade`. An unlit material compiles its normal chunks only
 * under USE_ENVMAP, so `lit` false fetches the bones at the skinning instead.
 */
function vatSplice(shader, uVat, fade, lit = true) {
  shader.uniforms.uVat = uVat
  shader.uniforms.uVatT = uVatT
  const swap = (src, chunk, by) => {
    if (!src.includes(chunk)) throw new Error(`BakedPuppet: the shader has no ${chunk}`)
    return src.replace(chunk, by)
  }
  let vs = shader.vertexShader
  vs = swap(vs, '#include <common>', `#include <common>\n${VAT_PARS}${fade ? 'attribute vec2 aFade;\nvarying vec2 vFade;\n' : ''}`)
  vs = swap(vs, 'void main() {', 'void main() {\nvatInstance = vatGlide();')
  vs = swap(vs, '#include <skinbase_vertex>', lit ? VAT_BASE : '')
  vs = swap(vs, '#include <skinnormal_vertex>', lit ? VAT_NORMAL : '')
  vs = swap(vs, '#include <skinning_vertex>', (lit ? '' : VAT_BASE) + VAT_SKIN + (fade ? 'vFade = aFade;\n' : ''))
  shader.vertexShader = vs
  if (fade) {
    let fs = shader.fragmentShader
    fs = swap(fs, '#include <common>', '#include <common>\nvarying vec2 vFade;')
    fs = swap(
      fs,
      '#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n' +
        '{\n' +
        '\tfloat ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );\n' +
        '\tif ( ( ign < vFade.x ? 1.0 : -1.0 ) * vFade.y < 0.0 ) discard;\n' +
        '}'
    )
    shader.fragmentShader = fs
  }
}

// ---------------------------------------------------------------------------
// LOOKS AND BATCHES. A look is a settled material's baked twins -- settled and
// fading -- built from it and following it: its onBeforeCompile runs first,
// its program key prefixes theirs, and a recompile of it (lighting flips bump
// its version) recompiles them. Colour is white on the twins and rides each
// instance (plain.color x puppet.tint). A batch is one InstancedMesh: one
// look, one fade state, one tier geometry.
// ---------------------------------------------------------------------------
export const bakedRoot = new THREE.Object3D()
bakedRoot.name = 'baked-puppets'
bakedRoot.updateMatrixWorld = function (force) {
  THREE.Object3D.prototype.updateMatrixWorld.call(this, force)
  flushBaked()
}

const looks = new Map() // plain -> look
const tintLooks = new Map() // vat -> look, the tier-tint row's
const active = new Set()

function twin(plain, vat, fade) {
  const m = new plain.constructor()
  m.copy(plain)
  m.color.set(0xffffff)
  m.onBeforeCompile = (shader, renderer) => {
    plain.onBeforeCompile(shader, renderer)
    vatSplice(shader, vat.uVat, fade)
  }
  m.customProgramCacheKey = () => `${plain.customProgramCacheKey()}|vat${fade ? '-fade' : ''}`
  return m
}

function lookFor(plain, vat) {
  let look = looks.get(plain)
  if (look) {
    if (look.vat !== vat) throw new Error('BakedPuppet: one settled material is worn by two skeletons')
    return look
  }
  look = { plain, vat, version: plain.version, settled: twin(plain, vat, false), fading: twin(plain, vat, true), batches: new Map() }
  looks.set(plain, look)
  plain.addEventListener('dispose', () => {
    dropLook(look)
    looks.delete(plain)
    for (const p of active) if (p.mats.plain === plain) active.delete(p)
  })
  return look
}

function tintLookFor(vat) {
  let look = tintLooks.get(vat)
  if (!look) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff })
    m.onBeforeCompile = (shader) => vatSplice(shader, vat.uVat, false, false)
    m.customProgramCacheKey = () => 'tier-tint|vat'
    look = { plain: null, vat, settled: m, fading: m, batches: new Map() }
    tintLooks.set(vat, look)
  }
  return look
}

function dropLook(look) {
  for (const pair of look.batches.values()) for (const b of pair) if (b) dropBatch(b)
  look.batches.clear()
  look.settled.dispose()
  look.fading.dispose()
}

function dropBatch(b) {
  b.mesh.removeFromParent()
  b.mesh.dispose()
  b.geometry.dispose()
}

/** The batch drawing `geometry` through `look`, settled (0) or fading (1). */
function batchFor(look, geometry, fade) {
  let pair = look.batches.get(geometry)
  if (!pair) {
    pair = [null, null]
    look.batches.set(geometry, pair)
    geometry.addEventListener('dispose', () => {
      const p = look.batches.get(geometry)
      if (!p) return
      look.batches.delete(geometry)
      for (const b of p) if (b) dropBatch(b)
    })
  }
  return (pair[fade] ??= makeBatch(geometry, fade ? look.fading : look.settled, !!fade, 32))
}

function makeBatch(tier, material, fade, cap) {
  const geometry = new THREE.BufferGeometry()
  geometry.setIndex(tier.index)
  for (const name in tier.attributes) geometry.setAttribute(name, tier.attributes[name])
  // A wild strider's bare tier is its full one drawn short of the tack: dropped here, every wild one wears a saddle.
  geometry.setDrawRange(tier.drawRange.start, tier.drawRange.count)
  const b = { geometry, material, fade, cap: 0, n: 0, mesh: null, clip: null, clock: null, glide: null, glideAt: null, fadeAttr: null, dirty: 0 }
  grow(b, cap)
  return b
}

function grow(b, cap) {
  if (b.mesh) { b.mesh.removeFromParent(); b.mesh.dispose() }
  const dyn = (n, size) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage)
  b.cap = cap
  b.dirty = DIRTY_ALL
  b.clip = dyn(cap, 4)
  b.clock = dyn(cap, 4)
  b.glide = dyn(cap, 4)
  b.glideAt = dyn(cap, 2)
  b.geometry.setAttribute('aClip', b.clip)
  b.geometry.setAttribute('aClock', b.clock)
  b.geometry.setAttribute('aGlide', b.glide)
  b.geometry.setAttribute('aGlideAt', b.glideAt)
  if (b.fade) {
    b.fadeAttr = dyn(cap, 2)
    b.geometry.setAttribute('aFade', b.fadeAttr)
  }
  const mesh = new THREE.InstancedMesh(b.geometry, b.material, cap)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.instanceColor = dyn(cap, 3)
  // Instances are culled one by one in flushBaked; the mesh's bounds are one rest body's.
  mesh.frustumCulled = false
  mesh.count = 0
  mesh.visible = false
  mesh.name = 'baked-puppet'
  b.mesh = mesh
  bakedRoot.add(mesh)
}

const _rows = [0, 0, 0]
// Which of a batch's buffers a frame changed; an unchanged one is not re-uploaded (a body playing on, gliding or standing writes none).
const D_MATRIX = 1, D_COLOR = 2, D_CLIP = 4, D_FADE = 8, D_GLIDE = 16, DIRTY_ALL = 31
const _m16 = new Float32Array(16)
const f32 = Math.fround
const _col = new THREE.Color()
const touched = new Set()

/** Copy `n` floats of `src` into `attr` at instance `i`, true if any differed. */
function copyIn(attr, i, src, n) {
  const a = attr.array, o = i * n
  let diff = false
  for (let k = 0; k < n; k++) if (a[o + k] !== src[k]) { a[o + k] = src[k]; diff = true }
  return diff
}

function put(b, p, matrix, color, cut, side) {
  if (b.n === b.cap) {
    const n = b.n, keep = [b.mesh.instanceMatrix, b.mesh.instanceColor, b.clip, b.clock, b.glide, b.glideAt, b.fadeAttr].map((a) => a && a.array.slice(0, n * a.itemSize))
    grow(b, b.cap * 2)
    ;[b.mesh.instanceMatrix, b.mesh.instanceColor, b.clip, b.clock, b.glide, b.glideAt, b.fadeAttr].forEach((a, k) => { if (a) a.array.set(keep[k]) })
  }
  const i = b.n++
  matrix.toArray(_m16)
  const ma = b.mesh.instanceMatrix.array
  for (let k = 0; k < 16; k++) if (ma[i * 16 + k] !== _m16[k]) { ma.set(_m16, i * 16); b.dirty |= D_MATRIX; break }
  const ca = b.mesh.instanceColor.array
  if (ca[i * 3] !== f32(color.r) || ca[i * 3 + 1] !== f32(color.g) || ca[i * 3 + 2] !== f32(color.b)) {
    ca[i * 3] = color.r; ca[i * 3 + 1] = color.g; ca[i * 3 + 2] = color.b
    b.dirty |= D_COLOR
  }
  if (copyIn(b.clip, i, p._clip4, 4) | copyIn(b.clock, i, p._clock4, 4)) b.dirty |= D_CLIP
  if (copyIn(b.glide, i, p._glide, 4) | copyIn(b.glideAt, i, p._glideAt, 2)) b.dirty |= D_GLIDE
  if (b.fade) {
    const fa = b.fadeAttr.array
    if (fa[i * 2] !== f32(cut) || fa[i * 2 + 1] !== f32(side)) {
      fa[i * 2] = cut; fa[i * 2 + 1] = side
      b.dirty |= D_FADE
    }
  }
  touched.add(b)
}

/** True if `o` and every ancestor are visible and the chain ends in a scene. */
function drawn(o) {
  for (; o; o = o.parent) {
    if (!o.visible) return false
    if (o.isScene) return true
  }
  return false
}

const live = new Set()

// The camera the bodies are culled against (cullBakedTo); none, every body is drawn.
let view = null
// The sphere's growth for a frame's head turn (rad, times its distance) and travel (m). In the headset the flush runs before three poses this frame's eyes, so the test is against the last frame's: three leaves both eyes' union on the camera after each render.
const CULL_TURN = 0.15, CULL_PAD = 0.5
const _now2 = [0, 0]
const _frustum = new THREE.Frustum()
const _pv = new THREE.Matrix4()
const _sphere = new THREE.Sphere()
const _eye = new THREE.Vector3()

/** Cull each baked body against `camera`'s frustum from now on; null draws every one. */
export function cullBakedTo(camera) { view = camera }

function inView(p) {
  _sphere.copy(p.vat.sphere).applyMatrix4(p.group.matrixWorld)
  const g = p._glide
  _sphere.radius += CULL_PAD + CULL_TURN * _sphere.center.distanceTo(_eye) + Math.hypot(g[0], g[1], g[2]) * GLIDE_S
  return _frustum.intersectsSphere(_sphere)
}

/** Every active baked puppet into its batches. bakedRoot runs this inside the scene's matrix pass; a check script may call it itself. */
export function flushBaked() {
  for (const b of live) b.n = 0
  touched.clear()
  for (const look of looks.values()) {
    if (look.version !== look.plain.version) {
      look.version = look.plain.version
      for (const m of [look.settled, look.fading]) { m.map = look.plain.map; m.needsUpdate = true }
    }
  }
  const tint = tierTintOn()
  stampOf(clockNow, _now2, 0)
  uVatT.value.set(_now2[0], _now2[1])
  if (view) {
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse))
    _eye.setFromMatrixPosition(view.matrixWorld)
  }
  const bakeBy = performance.now() + BAKE_MS
  for (const p of active) {
    if (p.done) { active.delete(p); continue }
    if (!drawn(p.group)) continue
    if (!p.vat.data) {
      const left = bakeBy - performance.now()
      if (left <= 0) continue
      bakeSome(p.vat, left)
      if (!p.vat.data) continue
    }
    p.group.updateWorldMatrix(true, false)
    p._latch()
    if (view && !inView(p)) continue
    const settled = p.fade >= 1
    if (tint) {
      if (p.to < 0) continue
      put(batchFor(tintLookFor(p.vat), p.meshes[p.to].geometry, 0), p, p.group.matrixWorld, TIER_TINTS[p.to].color, 1, 1)
      continue
    }
    const look = lookFor(p.mats.plain, p.vat)
    _col.copy(p.mats.plain.color).multiply(p.tint)
    if (p.to >= 0) put(batchFor(look, p.meshes[p.to].geometry, settled ? 0 : 1), p, p.group.matrixWorld, _col, settled ? 1 : p.fade, 1)
    if (!settled && p.from >= 0) put(batchFor(look, p.meshes[p.from].geometry, 1), p, p.group.matrixWorld, _col, p.fade, -1)
  }
  for (const b of live) if (!touched.has(b)) { b.mesh.count = 0; b.mesh.visible = false }
  for (const b of touched) {
    b.mesh.count = b.n
    b.mesh.visible = true
    if (b.dirty & D_MATRIX) b.mesh.instanceMatrix.needsUpdate = true
    if (b.dirty & D_COLOR) b.mesh.instanceColor.needsUpdate = true
    if (b.dirty & D_CLIP) { b.clip.needsUpdate = true; b.clock.needsUpdate = true }
    if (b.dirty & D_GLIDE) { b.glide.needsUpdate = true; b.glideAt.needsUpdate = true }
    if (b.fade && b.dirty & D_FADE) b.fadeAttr.needsUpdate = true
    b.dirty = 0
  }
  live.clear()
  for (const b of touched) live.add(b)
}

/** The batches drawing right now, for a check script: `[{ mesh, n, fade }]`. */
export function bakedBatches() {
  return [...live].map((b) => ({ mesh: b.mesh, n: b.n, fade: b.fade }))
}

// ---------------------------------------------------------------------------
// THE PUPPET. What a layer reads off a Puppet, kept: `actions` and `current`
// with a writable `time` and `timeScale` and getClip(), `mixer.timeScale`,
// `skeleton.bones[i].matrixWorld` and `bones` by name (creature space, at the
// current time), `meshes[k].geometry` (swappable), `feet` and plant/unplant
// (recorded, not solved).
// ---------------------------------------------------------------------------
/** A clip's clock: anchored at clock second `_at` to clip time `_t0`, running on at its rate while it is its puppet's current one, held where it was left otherwise. A loop wraps either way; a one-shot holds its end, as clampWhenFinished does. */
class BakedAction {
  constructor(owner, clip, baked, once) {
    this.owner = owner
    this._source = clip
    this._clip = baked
    this.once = once
    this._t0 = 0
    this._at = clockNow
    this._scale = 1
  }

  getClip() { return this._source }

  get rate() { return this.owner.mixer.timeScale * this._scale }

  get time() {
    const t = this.owner.current === this ? this._t0 + this.rate * (clockNow - this._at) : this._t0
    const d = this._clip.duration
    return this.once ? Math.min(Math.max(t, 0), d) : d > 0 ? ((t % d) + d) % d : 0
  }

  set time(t) {
    this._t0 = t
    this._at = clockNow
  }

  get timeScale() { return this._scale }

  set timeScale(s) {
    if (s === this._scale) return
    const t = this.time
    this._scale = s
    this.time = t
  }
}

const fromHalf = THREE.DataUtils.fromHalfFloat
const _skin = new THREE.Matrix4()
const _bind = new THREE.Matrix4()

class BakedBone {
  constructor(owner, i, name) {
    this.owner = owner
    this.i = i
    this.name = name
    this._m = new THREE.Matrix4()
    this._at = null
    this._t = NaN
  }

  /** This bone in creature space at the puppet's current time, as Puppet's detached rig has it. */
  get matrixWorld() {
    const p = this.owner
    const a = p.current
    const t = a ? a.time : 0
    if (this._at === a && this._t === t) return this._m
    this._at = a
    this._t = t
    const v = p.vat
    ensureBaked(v)
    rowsAt(a ? a._clip : p._rest, t, _rows)
    const d = v.data, nb = v.nb, e = _skin.elements
    const o0 = (_rows[0] * nb + this.i) * 12, o1 = (_rows[1] * nb + this.i) * 12, s = _rows[2]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const x = fromHalf(d[o0 + r * 4 + c])
        e[c * 4 + r] = x + (fromHalf(d[o1 + r * 4 + c]) - x) * s
      }
    }
    e[3] = e[7] = e[11] = 0
    e[15] = 1
    return this._m.multiplyMatrices(_skin, _bind.fromArray(v.bind, this.i * 16))
  }
}

export class BakedPuppet {
  constructor(asset, mats, { oneShot = null } = {}) {
    this.baked = true
    this.vat = vatFor(asset)
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = false
    this.mats = mats
    this.tint = new THREE.Color(1, 1, 1)
    this.meshes = asset.tiers.map((geometry) => ({ geometry, bindMatrix: IDENTITY }))
    this.bones = this.vat.names.map((name, i) => new BakedBone(this, i, name))
    this.skeleton = { bones: this.bones, boneInverses: asset.skeleton.boneInverses, dispose: () => active.delete(this) }
    let scale = 1
    const self = this
    this.mixer = {
      get timeScale() { return scale },
      set timeScale(s) {
        if (s === scale) return
        const a = self.current, t = a && a.time
        scale = s
        if (a) a.time = t
      },
    }
    this.actions = new Map(asset.clips.map((clip) => [clip.name, new BakedAction(this, clip, this.vat.clips.get(clip.name), !!oneShot?.has(clip.name))]))
    // Before any clip plays a body holds the first clip's first frame.
    this._rest = this.vat.clips.get(asset.clips[0].name)
    this.current = null
    this.cue = -1
    this.solver = null
    this._planted = false
    this._heading = 0
    this.from = -1
    this.to = -1
    this.fade = 1
    this.fadeS = 0
    this._owed = 0
    // What flushBaked writes for this body: its clip and clock (VAT_PARS), its glide and when that began.
    this._clip4 = new Float32Array(4)
    this._clock4 = new Float32Array(4)
    this._glide = new Float32Array(4)
    this._glideAt = new Float32Array(2)
    this._glideSet = -1
    this._world = new Float32Array(16)
  }

  get tier() { return this.to }

  /**
   * Glide on from where the group stands now at (vx, vy, vz) m/s, turning `w` rad/s
   * about y, for up to GLIDE_S: the shader carries the body between the layer's writes.
   * Call it on the frame the group is written; a frame that moves the group without it stops the glide.
   */
  glide(vx, vy, vz, w) {
    const g = this._glide
    g[0] = vx; g[1] = vy; g[2] = vz; g[3] = w
    stampOf(clockNow, this._glideAt, 0)
    this._glideSet = clockNow
  }

  /** This frame's clip, clock and glide as flushBaked writes them. */
  _latch() {
    const a = this.current, clip = a ? a._clip : this._rest, c = this._clip4, k = this._clock4
    c[0] = clip.start; c[1] = clip.n; c[2] = clip.duration; c[3] = a && a.once ? 1 : 0
    if (a) { stampOf(a._at, k, 0); k[2] = a._t0; k[3] = a.rate } else k.fill(0)
    const e = this.group.matrixWorld.elements, w = this._world
    let moved = false
    for (let i = 0; i < 16; i++) if (w[i] !== f32(e[i])) { w[i] = e[i]; moved = true }
    if (moved && this._glideSet !== clockNow) this._glide.fill(0)
  }

  get done() { return this.to === -1 && this.fade >= 1 }
  /** Its skeleton still baking: it is not drawn, and a bone read now bakes the rest in one go. */
  get baking() { return this.vat.data === null }

  /** Puppet.play without the crossfade: a new clip cuts in at 0, or at `at` seconds. */
  play(name, cue = 0, at = -1) {
    const next = this.actions.get(name)
    if (!next) throw new Error(`BakedPuppet: no clip named ${name}`)
    if (this.current === next && this.cue === cue) return
    this.cue = cue
    const was = this.current
    if (was && was !== next) was._t0 = was.time
    this.current = next
    next.time = at >= 0 ? at % next._clip.duration : 0
    this._owed = 0
  }

  show(tier, seconds = lodFadeS()) {
    if (tier === this.to) return
    this.fadeS = seconds
    const reversing = tier === this.from && this.fade < 1
    this.from = this.to
    this.to = tier
    this.fade = seconds <= 0 ? 1 : reversing ? 1 - this.fade : 0
    if (!this.done) active.add(this)
  }

  get feet() {
    if (!this.vat.feet) throw new Error('BakedPuppet: this body has no legs named -- re-ship it')
    return this.vat.feet
  }

  get planted() { return this._planted }

  get plantHeading() { return this._heading }

  plant(dys, heading = 0) {
    if (!this.vat.feet) throw new Error('BakedPuppet: this body has no legs named -- re-ship it')
    this._planted = true
    this._heading = heading
  }

  unplant() { this._planted = false }

  /** The dissolve, and the clip by `dt` where that is not the clock's own frame (BakedAction). */
  step(dt) {
    const a = this.current
    if (a) {
      this._owed += dt - clockDt
      if (Math.abs(this._owed) > OWED_S) {
        a.time = a.time + this._owed * a.rate
        this._owed = 0
      }
    }
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / this.fadeS)
    if (this.done) active.delete(this)
  }

  release() {
    this._glide.fill(0)
    this.current = null
    this.cue = -1
    this.from = -1
    this.to = -1
    this.fade = 1
    this._planted = false
    active.delete(this)
  }
}
