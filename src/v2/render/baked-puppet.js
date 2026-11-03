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
// Clips a flush may bake; a body whose skeleton is still waiting is drawn from the flush that finishes it.
const CLIPS_PER_FLUSH = 1
const MODE_KEY = 'v2.puppets'
const IDENTITY = new THREE.Matrix4()

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
// THE BAKE, once per skeleton and kept, one clip a flush from the first flush
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

/** One more clip of `v` sampled; the last lays every clip's rows into the texture. */
function bakeClip(v) {
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
    v.job = { rig, bones, mixer: new THREE.AnimationMixer(rig), chosen: [], ms: 0 }
    v.reach ??= boneReach(asset, nb)
  }
  const { rig, bones, mixer, chosen } = v.job
  const m = new THREE.Matrix4()
  /** `clip` at n+1 even times as 3x4 rows. */
  const sample = (clip, n) => {
    const out = new Float32Array((n + 1) * nb * 12)
    mixer.stopAllAction()
    const action = mixer.clipAction(clip).reset().play()
    for (let f = 0; f <= n; f++) {
      action.time = (clip.duration * f) / n
      mixer.update(0)
      rig.updateMatrixWorld(true)
      for (let j = 0; j < nb; j++) {
        m.multiplyMatrices(bones[j].matrixWorld, src.boneInverses[j])
        const e = m.elements, o = (f * nb + j) * 12
        // Rows of the column-major 4x4: the shader rebuilds it with transpose().
        out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = e[12]
        out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = e[13]
        out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = e[14]
      }
    }
    return out
  }
  const steps = (clip, fps) => Math.max(1, Math.ceil(clip.duration * fps))

  const clip = asset.clips[chosen.length]
  const c = v.clips.get(clip.name)
  const mTop = steps(clip, RATES[RATES.length - 1])
  const truth = sample(clip, mTop)
  const tol = TOL * v.sphere.radius
  let got = null
  for (const fps of RATES.slice(0, -1)) {
    const n = steps(clip, fps)
    if (n >= mTop) break
    const rows = sample(clip, n)
    if (blendError(rows, n, truth, mTop, nb, v.reach) <= tol) { c.n = n; got = rows; break }
  }
  if (!got) { c.n = mTop; got = truth }
  chosen.push(got)
  v.job.ms += performance.now() - t0
  if (chosen.length < asset.clips.length) return

  mixer.stopAllAction()
  mixer.uncacheRoot(rig)
  let rows = 0
  for (const cl of asset.clips) { const k = v.clips.get(cl.name); k.start = rows; rows += k.n + 1 }
  if (rows > MAX_ROWS) throw new Error(`BakedPuppet: ${rows} rows of clip, past ${MAX_ROWS}`)
  const data = new Uint16Array(rows * nb * 12)
  let o = 0
  for (const rowsOf of chosen) for (let k = 0; k < rowsOf.length; k++) data[o++] = THREE.DataUtils.toHalfFloat(rowsOf[k])

  const texture = new THREE.DataTexture(data, nb * 3, rows, THREE.RGBAFormat, THREE.HalfFloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  v.data = data
  v.texture = texture
  v.uVat.value = texture
  v.rows = rows
  console.log(`[baked-puppet] ${nb} bones x ${rows} rows (${(data.byteLength / 1024).toFixed(0)} KB) in ${v.job.ms.toFixed(0)} ms over ${asset.clips.length} flushes`)
  v.job = null
}

/** `v` baked, now, whatever the flush budget: a bone read cannot wait. */
function ensureBaked(v) {
  while (!v.data) bakeClip(v)
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

/** The (row, row, blend) of `clip` at `time`, into `out`. */
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
const VAT_PARS = /* glsl */ `
uniform highp sampler2D uVat;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec3 aVat;
mat4 vatBone( float i ) {
  int x = int( i + 0.5 ) * 3, a = int( aVat.x ), b = int( aVat.y );
  vec4 r0 = mix( texelFetch( uVat, ivec2( x, a ), 0 ), texelFetch( uVat, ivec2( x, b ), 0 ), aVat.z );
  vec4 r1 = mix( texelFetch( uVat, ivec2( x + 1, a ), 0 ), texelFetch( uVat, ivec2( x + 1, b ), 0 ), aVat.z );
  vec4 r2 = mix( texelFetch( uVat, ivec2( x + 2, a ), 0 ), texelFetch( uVat, ivec2( x + 2, b ), 0 ), aVat.z );
  return transpose( mat4( r0, r1, r2, vec4( 0.0, 0.0, 0.0, 1.0 ) ) );
}
`
const VAT_BASE = /* glsl */ `
mat4 boneMatX = vatBone( skinIndex.x );
mat4 boneMatY = vatBone( skinIndex.y );
mat4 boneMatZ = vatBone( skinIndex.z );
mat4 boneMatW = vatBone( skinIndex.w );
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
  const swap = (src, chunk, by) => {
    if (!src.includes(chunk)) throw new Error(`BakedPuppet: the shader has no ${chunk}`)
    return src.replace(chunk, by)
  }
  let vs = shader.vertexShader
  vs = swap(vs, '#include <common>', `#include <common>\n${VAT_PARS}${fade ? 'attribute vec2 aFade;\nvarying vec2 vFade;\n' : ''}`)
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
  const b = { geometry, material, fade, cap: 0, n: 0, mesh: null, vat: null, fadeAttr: null, dirty: 0 }
  grow(b, cap)
  return b
}

function grow(b, cap) {
  if (b.mesh) { b.mesh.removeFromParent(); b.mesh.dispose() }
  const dyn = (n, size) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage)
  b.cap = cap
  b.dirty = DIRTY_ALL
  b.vat = dyn(cap, 3)
  b.geometry.setAttribute('aVat', b.vat)
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
// Which of a batch's buffers a frame changed; an unchanged one is not re-uploaded (a standing townsman's matrix, colour and rows repeat).
const D_MATRIX = 1, D_COLOR = 2, D_VAT = 4, D_FADE = 8, DIRTY_ALL = 15
const _m16 = new Float32Array(16)
const f32 = Math.fround
const _col = new THREE.Color()
const touched = new Set()

function put(b, matrix, rows, color, cut, side) {
  if (b.n === b.cap) {
    const keep = { m: b.mesh.instanceMatrix.array.slice(0, b.n * 16), c: b.mesh.instanceColor.array.slice(0, b.n * 3), v: b.vat.array.slice(0, b.n * 3), f: b.fadeAttr?.array.slice(0, b.n * 2) }
    grow(b, b.cap * 2)
    b.mesh.instanceMatrix.array.set(keep.m)
    b.mesh.instanceColor.array.set(keep.c)
    b.vat.array.set(keep.v)
    if (b.fade) b.fadeAttr.array.set(keep.f)
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
  const va = b.vat.array
  if (va[i * 3] !== f32(rows[0]) || va[i * 3 + 1] !== f32(rows[1]) || va[i * 3 + 2] !== f32(rows[2])) {
    va[i * 3] = rows[0]; va[i * 3 + 1] = rows[1]; va[i * 3 + 2] = rows[2]
    b.dirty |= D_VAT
  }
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
const _frustum = new THREE.Frustum()
const _pv = new THREE.Matrix4()
const _sphere = new THREE.Sphere()
const _eye = new THREE.Vector3()

/** Cull each baked body against `camera`'s frustum from now on; null draws every one. */
export function cullBakedTo(camera) { view = camera }

function inView(p) {
  _sphere.copy(p.vat.sphere).applyMatrix4(p.group.matrixWorld)
  _sphere.radius += CULL_PAD + CULL_TURN * _sphere.center.distanceTo(_eye)
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
  if (view) {
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse))
    _eye.setFromMatrixPosition(view.matrixWorld)
  }
  let clips = CLIPS_PER_FLUSH
  for (const p of active) {
    if (p.done) { active.delete(p); continue }
    if (!drawn(p.group)) continue
    if (!p.vat.data) {
      if (clips === 0) continue
      clips--
      bakeClip(p.vat)
      if (!p.vat.data) continue
    }
    p.group.updateWorldMatrix(true, false)
    if (view && !inView(p)) continue
    const clip = p.current ? p.current._clip : p._rest
    rowsAt(clip, p.current ? p.current.time : 0, _rows)
    const settled = p.fade >= 1
    if (tint) {
      if (p.to < 0) continue
      put(batchFor(tintLookFor(p.vat), p.meshes[p.to].geometry, 0), p.group.matrixWorld, _rows, TIER_TINTS[p.to].color, 1, 1)
      continue
    }
    const look = lookFor(p.mats.plain, p.vat)
    _col.copy(p.mats.plain.color).multiply(p.tint)
    if (p.to >= 0) put(batchFor(look, p.meshes[p.to].geometry, settled ? 0 : 1), p.group.matrixWorld, _rows, _col, settled ? 1 : p.fade, 1)
    if (!settled && p.from >= 0) put(batchFor(look, p.meshes[p.from].geometry, 1), p.group.matrixWorld, _rows, _col, p.fade, -1)
  }
  for (const b of live) if (!touched.has(b)) { b.mesh.count = 0; b.mesh.visible = false }
  for (const b of touched) {
    b.mesh.count = b.n
    b.mesh.visible = true
    if (b.dirty & D_MATRIX) b.mesh.instanceMatrix.needsUpdate = true
    if (b.dirty & D_COLOR) b.mesh.instanceColor.needsUpdate = true
    if (b.dirty & D_VAT) b.vat.needsUpdate = true
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
class BakedAction {
  constructor(clip, baked, once) {
    this._source = clip
    this._clip = baked
    this.once = once
    this.time = 0
    this.timeScale = 1
  }

  getClip() { return this._source }
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
    this.mixer = { timeScale: 1 }
    this.actions = new Map(asset.clips.map((clip) => [clip.name, new BakedAction(clip, this.vat.clips.get(clip.name), !!oneShot?.has(clip.name))]))
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
  }

  get tier() { return this.to }

  get done() { return this.to === -1 && this.fade >= 1 }

  /** Puppet.play without the crossfade: a new clip cuts in at 0, or at `at` seconds. */
  play(name, cue = 0, at = -1) {
    const next = this.actions.get(name)
    if (!next) throw new Error(`BakedPuppet: no clip named ${name}`)
    if (this.current === next && this.cue === cue) return
    this.cue = cue
    next.time = at >= 0 ? at % next._clip.duration : 0
    this.current = next
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

  /** The clip's clock and the dissolve. A loop wraps either way; a one-shot holds its end, as clampWhenFinished does. */
  step(dt) {
    const a = this.current
    if (a) {
      const d = a._clip.duration
      const t = a.time + dt * this.mixer.timeScale * a.timeScale
      a.time = a.once ? Math.min(Math.max(t, 0), d) : d > 0 ? ((t % d) + d) % d : 0
    }
    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt / this.fadeS)
    if (this.done) active.delete(this)
  }

  release() {
    this.current = null
    this.cue = -1
    this.from = -1
    this.to = -1
    this.fade = 1
    this._planted = false
    active.delete(this)
  }
}
