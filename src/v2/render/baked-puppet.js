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

// Samples per second of clip, lowered per skeleton until its rows fit MAX_ROWS.
const FPS = 30
const MAX_ROWS = 4096
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

// ---------------------------------------------------------------------------
// THE BAKE, once per skeleton. Each clip is n+1 rows at duration/n apart, the
// last row the clip's end, so a sample between two rows never wraps. A row is
// three texels a bone: the top three rows of bone.matrixWorld x boneInverse.
// `world` keeps the bones' own creature-space matrices on the CPU for the
// layers that read a bone (a saddle, a wrist, a grip).
// ---------------------------------------------------------------------------
const vats = new WeakMap()

function vatFor(asset) {
  let v = vats.get(asset.skeleton)
  if (!v) {
    v = bakeVat(asset)
    vats.set(asset.skeleton, v)
    // Off the GPU with the tiers; the data stays, so a later draw re-uploads it.
    asset.tiers[0].addEventListener('dispose', () => v.texture.dispose())
  } else if (v.clips.size !== asset.clips.length || asset.clips.some((c) => v.clips.get(c.name)?.duration !== c.duration)) {
    throw new Error('BakedPuppet: two assets share a skeleton but not their clips')
  }
  return v
}

function bakeVat(asset) {
  const t0 = performance.now()
  const src = asset.skeleton
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const bones = src.bones.map((b) => {
    const c = copies.get(b)
    if (!c) throw new Error(`BakedPuppet: bone ${b.name} is not under the root`)
    return c
  })
  const nb = bones.length
  let fps = FPS
  const rowCount = (f) => asset.clips.reduce((s, c) => s + Math.max(1, Math.ceil(c.duration * f)) + 1, 0)
  while (rowCount(fps) > MAX_ROWS && fps > 1) fps--
  const rows = rowCount(fps)
  if (rows > MAX_ROWS) throw new Error(`BakedPuppet: ${rows} rows of clip at 1 fps`)

  rig.updateMatrixWorld(true)
  const feet = asset.legs ? restFeet(rig, asset.legs) : null

  const world = new Float32Array(rows * nb * 16)
  const data = new Float32Array(rows * nb * 12)
  const mixer = new THREE.AnimationMixer(rig)
  const clips = new Map()
  const m = new THREE.Matrix4()
  let row = 0
  for (const clip of asset.clips) {
    const n = Math.max(1, Math.ceil(clip.duration * fps))
    clips.set(clip.name, { start: row, n, duration: clip.duration })
    mixer.stopAllAction()
    const action = mixer.clipAction(clip).reset().play()
    for (let f = 0; f <= n; f++, row++) {
      action.time = (clip.duration * f) / n
      mixer.update(0)
      rig.updateMatrixWorld(true)
      for (let j = 0; j < nb; j++) {
        bones[j].matrixWorld.toArray(world, (row * nb + j) * 16)
        m.multiplyMatrices(bones[j].matrixWorld, src.boneInverses[j])
        const e = m.elements, o = (row * nb + j) * 12
        // Rows of the column-major 4x4: the shader rebuilds it with transpose().
        data[o] = e[0]; data[o + 1] = e[4]; data[o + 2] = e[8]; data[o + 3] = e[12]
        data[o + 4] = e[1]; data[o + 5] = e[5]; data[o + 6] = e[9]; data[o + 7] = e[13]
        data[o + 8] = e[2]; data[o + 9] = e[6]; data[o + 10] = e[10]; data[o + 11] = e[14]
      }
    }
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(rig)

  const texture = new THREE.DataTexture(data, nb * 3, rows, THREE.RGBAFormat, THREE.FloatType)
  texture.minFilter = texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  const v = { texture, uVat: { value: texture }, world, nb, rows, fps, clips, feet, sphere: poseSphere(asset.tiers), names: src.bones.map((b) => b.name) }
  console.log(`[baked-puppet] ${nb} bones x ${rows} rows at ${fps} fps in ${(performance.now() - t0).toFixed(0)} ms`)
  return v
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
  const b = { geometry, material, fade, cap: 0, n: 0, mesh: null, vat: null, fadeAttr: null }
  grow(b, cap)
  return b
}

function grow(b, cap) {
  if (b.mesh) { b.mesh.removeFromParent(); b.mesh.dispose() }
  const dyn = (n, size) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage)
  b.cap = cap
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
  matrix.toArray(b.mesh.instanceMatrix.array, i * 16)
  color.toArray(b.mesh.instanceColor.array, i * 3)
  b.vat.array[i * 3] = rows[0]
  b.vat.array[i * 3 + 1] = rows[1]
  b.vat.array[i * 3 + 2] = rows[2]
  if (b.fade) {
    b.fadeAttr.array[i * 2] = cut
    b.fadeAttr.array[i * 2 + 1] = side
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
  for (const p of active) {
    if (p.done) { active.delete(p); continue }
    if (!drawn(p.group)) continue
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
    b.mesh.instanceMatrix.needsUpdate = true
    b.mesh.instanceColor.needsUpdate = true
    b.vat.needsUpdate = true
    if (b.fade) b.fadeAttr.needsUpdate = true
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
    rowsAt(a ? a._clip : p._rest, t, _rows)
    const w = p.vat.world, nb = p.vat.nb, e = this._m.elements
    const o0 = (_rows[0] * nb + this.i) * 16, o1 = (_rows[1] * nb + this.i) * 16, s = _rows[2]
    for (let k = 0; k < 16; k++) e[k] = w[o0 + k] + (w[o1 + k] - w[o0 + k]) * s
    return this._m
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
