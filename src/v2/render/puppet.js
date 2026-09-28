// ---------------------------------------------------------------------------
// THE PUPPET: one animated creature drawn near, shared by every layer that
// draws one -- the wildlife, the spiders, and the village NPCs when they come.
//
// A shipped animated GLB (tools/creatures/ship-quadruped.mjs, ship-spider.mjs)
// is N SKINNED TIERS OVER ONE SKELETON AND ONE SET OF CLIPS: the tiers are the
// decimation ladder, every one of them carrying the same JOINTS_0 and
// WEIGHTS_0 through (tools/creatures/skin-ladder.mjs), so stepping down the
// ladder is choosing which geometry is visible and nothing else. A puppet
// clones the bone tree once, binds every tier to that one clone, and runs one
// mixer. THE COST OF A TIER IS ITS TRIANGLES AND NOT ITS BONES: three uploads
// a skeleton's bone texture once a frame whichever tier is drawn from it, so
// the ladder buys triangles and draw distance and buys nothing at all on the
// skinning.
//
// NOTHING POPS. Appearing, vanishing and every step of the ladder is a
// DISSOLVE: over LOD_FADE_S the incoming tier keeps a growing share of its
// pixels and the outgoing tier keeps exactly the rest. The share is a
// screen-space hash of gl_FragCoord -- interleaved gradient noise, no time
// term, so it does not shimmer -- and the two tiers read the same hash at the
// same pixel and compare it the opposite way round (uSide), which is what makes
// the masks complementary rather than merely both dithered. A cull is the
// outgoing half alone, a pop-in the incoming half alone, one code path.
//
// The fade is TIMED, NOT BANDED: a fade driven by distance across a band edge
// would pop whenever the camera crosses the band in one frame. Under teleport
// locomotion every dissolve is a cut instead (lodFadeS, material.js setDissolves).
//
// A STANDING BODY PUTS ITS FEET ON THE GROUND (FootIK below). The clips are
// made on a flat floor and the body stands on the world vertical, so on a
// hillside a clip's uphill feet are in the hill and its downhill feet in the
// air. While a layer says the body is planted -- a still clip, stopped -- each
// foot is offset vertically to the ground under it, by a two-bone bend of the
// leg it hangs from, and the root sinks so the legs share the reach. It is an
// OFFSET on the clip's pose, not a target in place of it: the pose's own foot
// motion (a graze's weight shift) is kept whole, and a gait is never touched.
//
// WHAT IT COSTS, honestly. Not fill -- the discarded fragments are the ones the
// other tier draws, so a fade is very nearly the fill of one creature. The real
// cost is that `discard` turns off early-Z on tiled mobile GPUs (the Quest's
// Adreno above all), which is why a settled puppet draws through `plain`, a
// material with no discard in its shader at all, and only a FADING one draws
// through the dissolve pair. A fading creature is two draw calls for that third
// of a second. In stereo each eye hashes its own gl_FragCoord, so a fade is not
// the same pattern in both eyes -- at these sizes and for this long it reads as
// a shimmer, not as doubled geometry. Nothing here casts a shadow, so the
// shadow map never sees a half-dissolved animal.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { cullTripoBackfaces } from '../../tripo-culling.js'
import { TIER_TINTS, glint, gltfLoader, tierTintOn } from './critters.js'
import { dissolvesOn } from '../../material.js'

// How long a tier change, an appearance or a vanishing takes. Long enough that
// the eye reads a dissolve rather than a flicker, short enough that a creature
// walking a threshold is not permanently half-there.
export const LOD_FADE_S = 0.35

/** The LOD dissolve's length right now: 0, a cut, while material.js's dissolves are off. */
export function lodFadeS() {
  return dissolvesOn() ? LOD_FADE_S : 0
}

/** A card's LOD dissolve `p` advanced by `dt`, in step with a puppet's. */
export function stepLodFade(p, dt) {
  return dissolvesOn() ? Math.min(1, p + dt / LOD_FADE_S) : 1
}

const IDENTITY = new THREE.Matrix4()

// ---------------------------------------------------------------------------
// HOW OFTEN A PUPPET RE-POSES, BY THE RUNG IT DRAWS ON: every frame on the top
// rung, then every second, third and sixth frame -- 72, 36, 24 and 12 Hz in a
// headset. A pose is the mixer, every bone's matrix, the leg IK and the rig's
// world pass, then the bone texture's upload, and a crowd's posing is most of
// what the wildlife costs a frame; the top rung is the one where a held frame
// is visible, and the rungs below it hold the animal at a size where it is
// not. This is the one lever the
// ladder does NOT give us -- three uploads a skeleton's bone texture once a
// frame per skeleton drawn, whichever tier that is, so a rung-3 stag costs the
// same skinning as a rung-0 one. Skipping the pose is what makes a distant
// animal cheap: no mixer, no bone composed, no bone texture re-uploaded.
//
// The mixer's dt is BANKED and spent in one go, so a clip plays at its own
// speed however coarsely it is sampled -- this is a lower sample rate, not a
// slower animation.
//
// WHAT A HELD FRAME LOOKS LIKE: the body slides on smoothly in the pose it
// last took. The rig is DETACHED -- the bones hang under no scene node, so
// their world matrices are creature-space, the bone texture holds the pose
// alone, and the group's matrix is what places it. A layer writes the group
// every frame, which costs the group and its tier meshes a multiply each and
// never touches the bones; had the rig hung under the group (an attached
// bind), the bone texture would hold world matrices, a stale one would draw
// the body frozen where it stood, and the animal would cross the ground in
// hops of its own cadence.
// ---------------------------------------------------------------------------
export const POSE_EVERY = [1, 2, 3, 6]
const poseEvery = (tier) => (tier < 0 ? POSE_EVERY[POSE_EVERY.length - 1] : POSE_EVERY[Math.min(tier, POSE_EVERY.length - 1)])
// Puppets built one after another start their count on different frames, so a
// herd re-poses a few bodies a frame instead of all of them on every fourth.
let posePhase = 0

// How much bigger than its REST bounds a body is allowed to get before the
// frustum test is wrong about it. A sphere already round the whole creature,
// half as wide again, covers a rear, a leap or a stretched gallop.
const POSE_SLACK = 1.6

/** One sphere over every tier's rest bounds, slack enough for any pose the clips reach. */
function poseSphere(tiers) {
  const box = new THREE.Box3()
  for (const geo of tiers) {
    if (!geo.boundingBox) geo.computeBoundingBox()
    box.union(geo.boundingBox)
  }
  const sphere = new THREE.Sphere()
  box.getBoundingSphere(sphere)
  sphere.radius *= POSE_SLACK
  return sphere
}

/**
 * A shipped animated GLB as the parts a puppet is built from: the skeleton's
 * root bone and Skeleton, one geometry per tier in ladder order (most triangles
 * first), the clips, the colour map, and whatever the shipper hung on the
 * scene's userData.
 *
 * `tiers` is the number of tiers the file must carry, `clips` the names it must
 * carry, and `extras` the userData key the caller needs -- all three throw
 * rather than degrade, because a file missing any of them is a shipping bug and
 * not a runtime condition.
 */
export async function loadSkinnedAsset(url, { tiers = 0, clips = [], extras = null } = {}) {
  const loader = await gltfLoader()
  const gltf = await loader.loadAsync(url)
  cullTripoBackfaces(gltf.scene)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o) })
  if (!meshes.length) throw new Error(`${url}: carries no skinned mesh`)
  if (tiers && meshes.length !== tiers) throw new Error(`${url}: expected ${tiers} skinned tiers, found ${meshes.length}`)
  meshes.sort((a, b) => b.geometry.index.count - a.geometry.index.count)
  const skeleton = meshes[0].skeleton
  for (const m of meshes) {
    if (m.skeleton !== skeleton) throw new Error(`${url}: the tiers do not share one skeleton`)
    for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
      if (!m.geometry.getAttribute(name)) throw new Error(`${url}: a tier has no ${name} attribute`)
    }
  }
  const root = skeleton.bones.find((b) => !b.parent?.isBone)
  if (!root) throw new Error(`${url}: the skeleton has no root bone`)
  if (!gltf.animations.length) throw new Error(`${url}: carries no clips`)
  for (const name of clips) {
    if (!gltf.animations.some((c) => c.name === name)) throw new Error(`${url}: no clip named ${name}`)
  }
  const map = meshes[0].material.map
  if (!map) throw new Error(`${url}: material has no base colour map`)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 4
  for (const m of new Set(meshes.map((m) => m.material))) m.dispose()
  const extra = extras ? gltf.scene.userData[extras] : null
  if (extras && !extra) throw new Error(`${url}: no ${extras} extras -- re-ship it`)
  return { root, skeleton, tiers: meshes.map((m) => m.geometry), clips: gltf.animations, map, extras: extra }
}

/** A bone tree copied bone by bone, `map` filled with source -> copy. */
export function cloneBones(src, map) {
  const b = new THREE.Bone()
  b.name = src.name
  b.position.copy(src.position)
  b.quaternion.copy(src.quaternion)
  b.scale.copy(src.scale)
  map.set(src, b)
  for (const c of src.children) if (c.isBone) b.add(cloneBones(c, map))
  return b
}

/** The screen-space keep test, spliced ahead of every texture fetch so a dropped fragment costs nothing but its own test. */
function dissolve(shader) {
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform float uCut;\nuniform float uSide;')
    .replace(
      '#include <clipping_planes_fragment>',
      '#include <clipping_planes_fragment>\n' +
        '{\n' +
        '\tfloat ign = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );\n' +
        '\tif ( ( ign < uCut ? 1.0 : -1.0 ) * uSide < 0.0 ) discard;\n' +
        '}'
    )
}

/**
 * The material a SETTLED puppet draws through, shared by every puppet of a
 * species. Nothing in it is per-animal, which is the point: see below.
 *
 * Lambert, unless `gloss` is a roughness: then a Standard at it, metalness 0,
 * wearing the wet creatures' glint (critters.js) -- the sun's lobe at half --
 * for a hide that gleams, like a dragon's scales. The fade pair follows suit
 * (makePuppetMaterials), so a puppet is the same surface dissolving or settled.
 *
 * The caller patches it with the world's lighting; lighting.js chains
 * onBeforeCompile, so a splice here survives it.
 */
export function makeSettledMaterial(cacheKey, { gloss = false } = {}) {
  const m = puppetMaterial(gloss)
  if (gloss !== false) m.onBeforeCompile = glint
  m.customProgramCacheKey = () => cacheKey
  return m
}

function puppetMaterial(gloss) {
  if (gloss === false) return new THREE.MeshLambertMaterial({ color: 0xffffff })
  if (!(gloss > 0 && gloss < 1)) throw new Error(`puppet: gloss is a roughness in (0, 1), not ${gloss}`)
  return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: gloss, metalness: 0 })
}

/**
 * The two halves of ONE puppet's dissolve -- `in` and `out` -- over its own
 * cut, handed the species' settled material as `plain`. One program between
 * every puppet of a species, `cacheKey`-fade, the cut being a uniform and not
 * a define.
 *
 * A PUPPET WEARS NO COLOUR OF ITS OWN, and that is a rendering limit rather
 * than a taste. An InstancedMesh varies its instances through an attribute
 * (critters.js `makeHueAttribute`) and the whole scatter stays one material and
 * one draw. A skinned body has no instances, so the only place a per-animal
 * value can sit is a uniform, and a uniform belongs to a MATERIAL: twenty hues
 * meant twenty materials, and three refreshes every uniform of a material it
 * did not just bind, so each drawn animal cost a full uniform upload -- twice
 * over, there being no multiview in the WebGL renderer. A settled herd is now
 * one material change a frame instead of one an animal. The per-animal SIZE
 * roll stays: a transform is free. See design/27-creature-pipeline.md.
 */
export function makePuppetMaterials(cacheKey, plain, { gloss = false } = {}) {
  if ((gloss !== false) !== !!plain.isMeshStandardMaterial) throw new Error(`makePuppetMaterials(${cacheKey}): the fade pair must wear the settled material's gloss`)
  const uCut = { value: 1 }
  const make = (side) => {
    const m = puppetMaterial(gloss)
    const uSide = { value: side }
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uCut = uCut
      shader.uniforms.uSide = uSide
      dissolve(shader)
      if (gloss !== false) glint(shader)
    }
    m.customProgramCacheKey = () => `${cacheKey}-fade`
    m.userData.uCut = uCut
    return m
  }
  return { plain, in: make(1), out: make(-1), uCut }
}

// ---------------------------------------------------------------------------
// FOOT IK. Each shipped leg is a joint chain, hip to foot (the GLB extras'
// `legs`, tools/creatures/ship-skinned.mjs), and is solved as a VIRTUAL
// two-bone leg: the hip A is the chain's first joint, the foot C its last, and
// the knee B the interior joint furthest from both -- a Tripo leg zig-zags
// through three or four joints, and the one in the middle is where bending it
// reads as a knee. Everything between is carried rigidly.
//
// Per leg, per posed frame: the foot's target is its posed position plus the
// leg's vertical offset. The knee angle comes from the law of cosines over the
// hip-foot distance, the bend axis from the pose itself (the normal of the
// hip-knee-foot triangle, so a knee always bends the way the clip already has
// it bent), and the hip is then turned so the straightened-or-folded leg points
// at the target. Two rotations, no iteration: a few hundred flops a leg.
//
// THE ROOT DROPS by the mean of the offsets, and further whenever a downhill
// leg would otherwise have to reach past its length -- so a body across a
// slope sits lower and bends its uphill knees rather than hovering a foot. A
// leg is never folded shorter than FOLD of its posed length: past that the
// foot goes into the hill, which reads better than a knee folded flat. A
// plant may also ask the root down by a `sink` of its own, a crouch: the knees
// fold as far as that asks, and the feet stay on the ground.
//
// Every offset and the root drop are eased with the clip's own crossfade and
// smoothed, so planting, unplanting and a re-plant after a turn on the spot
// all slide rather than snap. What the solver writes it also UNDOES before the
// mixer next runs: the mixer only rewrites the properties a clip tracks, and a
// bend left on an untracked joint would compound frame on frame.
// ---------------------------------------------------------------------------

// A leg is never folded shorter than this fraction of its posed hip-foot length, nor stretched past this fraction of straight.
const FOLD = 0.55
const REACH = 0.995
// Seconds the offsets and the root drop take to settle after a plant or a re-plant; the on/off ramp is the clip crossfade.
const SETTLE_S = 0.12

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _t = new THREE.Vector3()
const _n = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qp = new THREE.Quaternion()

/**
 * The feet of one puppet, planted or not. `bones` is the puppet's whole tree
 * in traverse order (parents first), at rest; `legs` the shipped chains.
 */
class FootIK {
  constructor(bones, legs) {
    if (!legs.length) throw new Error('FootIK: no legs')
    const byName = new Map(bones.map((b) => [b.name, b]))
    const index = new Map(bones.map((b, i) => [b, i]))
    const resolve = (name) => {
      const b = byName.get(THREE.PropertyBinding.sanitizeNodeName(name))
      if (!b) throw new Error(`FootIK: no bone named ${name}`)
      return b
    }
    // Rest transforms in creature space, for choosing knees and reading the feet.
    const rest = bones.map(() => ({ p: new THREE.Vector3(), q: new THREE.Quaternion() }))
    bones.forEach((b, i) => {
      if (Math.abs(b.scale.x - 1) > 1e-3 || Math.abs(b.scale.y - 1) > 1e-3 || Math.abs(b.scale.z - 1) > 1e-3) throw new Error(`FootIK: bone ${b.name} is scaled, and the solver composes unscaled`)
      const par = b.parent?.isBone ? rest[index.get(b.parent)] : null
      if (par) {
        rest[i].q.multiplyQuaternions(par.q, b.quaternion)
        rest[i].p.copy(b.position).applyQuaternion(par.q).add(par.p)
      } else {
        rest[i].q.copy(b.quaternion)
        rest[i].p.copy(b.position)
      }
    })
    this.root = bones[0]
    this.legs = legs.map((l) => {
      const chain = l.chain.map(resolve)
      if (chain.length < 3) throw new Error(`FootIK: leg ${l.id} has ${chain.length} joints, a bend needs three`)
      const A = chain[0], C = chain[chain.length - 1]
      let B = null, best = -1
      for (let k = 1; k < chain.length - 1; k++) {
        const pk = rest[index.get(chain[k])].p
        const s = Math.min(pk.distanceTo(rest[index.get(A)].p), pk.distanceTo(rest[index.get(C)].p))
        if (s > best) { best = s; B = chain[k] }
      }
      const foot = rest[index.get(C)].p
      return {
        id: l.id, A, B, C, iA: index.get(A), iB: index.get(B), iC: index.get(C), iPA: A.parent?.isBone ? index.get(A.parent) : -1, iPB: index.get(B.parent),
        foot: { x: foot.x, z: foot.z }, dy: 0, dyTo: 0, savedA: new THREE.Quaternion(), savedB: new THREE.Quaternion(),
      }
    })
    // The shortest rest hip-to-foot line: what a crouch may fold a leg from.
    this.legRest = Math.min(...this.legs.map((l) => rest[l.iA].p.distanceTo(rest[l.iC].p)))
    // Every bone a solve has to compose: the ancestors of every hip, knee and foot, in tree order, with each one's parent's slot.
    const need = new Set()
    for (const l of this.legs) for (let b = l.C; b?.isBone; b = b.parent) need.add(b)
    this.path = bones.map((b, i) => (need.has(b) ? i : -1)).filter((i) => i >= 0).map((i) => ({ bone: bones[i], i, par: bones[i].parent?.isBone ? index.get(bones[i].parent) : -1 }))
    this.pos = bones.map(() => new THREE.Vector3())
    this.quat = bones.map(() => new THREE.Quaternion())
    this.savedRoot = new THREE.Vector3()
    // Rest foot positions in creature space, for the layer to read the ground under.
    this.feet = this.legs.map((l) => l.foot)
    this.dirty = false
    this.w = 0
    this.wTo = 0
    this.rootDy = 0
    this.sink = 0
    this.sinkTo = 0
    this.fresh = false
    this.heading = 0
  }

  get planted() { return this.wTo > 0 }

  /** True while a solve has anything to write: on, or still fading off. */
  get active() { return this.w > 0 || this.wTo > 0 }

  /**
   * Each foot's vertical offset to the ground, in creature units, in leg order;
   * `heading` is whatever the layer wants back from `heading` to decide a
   * re-plant; `sink` how far below that the root is asked, a crouch.
   */
  plant(dys, heading, sink = 0) {
    if (dys.length < this.legs.length) throw new Error(`FootIK: ${this.legs.length} legs, ${dys.length} offsets`)
    if (!(sink >= 0)) throw new Error(`FootIK: sink ${sink}`)
    // A fresh plant starts at its targets and ramps in through w; only a re-plant slides.
    const fresh = this.wTo === 0
    this.fresh = fresh
    this.wTo = 1
    this.heading = heading
    this.sinkTo = sink
    if (fresh) this.sink = sink
    for (let i = 0; i < this.legs.length; i++) {
      const l = this.legs[i]
      l.dyTo = dys[i]
      if (fresh) l.dy = dys[i]
    }
  }

  unplant() { this.wTo = 0 }

  /** Off at once, nothing written: for a puppet handed back. */
  reset() {
    this.restore()
    this.w = 0
    this.wTo = 0
    this.rootDy = 0
    this.sink = 0
    this.sinkTo = 0
  }

  /** Put back what the last solve wrote, so the mixer starts from the clip. */
  restore() {
    if (!this.dirty) return
    this.dirty = false
    this.root.position.copy(this.savedRoot)
    for (const l of this.legs) {
      l.A.quaternion.copy(l.savedA)
      l.B.quaternion.copy(l.savedB)
    }
  }

  /** Solve over the pose the mixer just wrote (every bone's local matrix current), `dt` seconds after the last solve. */
  solve(dt, fadeS) {
    const step = dt / fadeS
    this.w = this.wTo > this.w ? Math.min(this.wTo, this.w + step) : Math.max(this.wTo, this.w - step)
    if (this.w <= 0) return
    const ease = 1 - Math.exp(-dt / SETTLE_S)

    // The pose in creature space, root down.
    for (const { bone, i, par } of this.path) {
      if (par < 0) {
        this.pos[i].copy(bone.position)
        this.quat[i].copy(bone.quaternion)
      } else {
        this.quat[i].multiplyQuaternions(this.quat[par], bone.quaternion)
        this.pos[i].copy(bone.position).applyQuaternion(this.quat[par]).add(this.pos[par])
      }
    }

    // The root drop: the mean offset, and lower while any leg cannot reach its own.
    let mean = 0
    let ceiling = Infinity
    for (const l of this.legs) {
      l.dy += (l.dyTo - l.dy) * ease
      mean += l.dy
      const a = this.pos[l.iA].distanceTo(this.pos[l.iB])
      const b = this.pos[l.iB].distanceTo(this.pos[l.iC])
      const d0 = this.pos[l.iA].distanceTo(this.pos[l.iC])
      ceiling = Math.min(ceiling, l.dy + REACH * (a + b) - d0)
    }
    this.sink += (this.sinkTo - this.sink) * ease
    const rootDy = Math.min(mean / this.legs.length, ceiling) - this.sink
    this.rootDy = this.fresh ? rootDy : this.rootDy + (rootDy - this.rootDy) * ease
    this.fresh = false

    this.savedRoot.copy(this.root.position)
    for (const l of this.legs) {
      l.savedA.copy(l.A.quaternion)
      l.savedB.copy(l.B.quaternion)
    }
    this.dirty = true

    for (const l of this.legs) {
      const delta = this.w * (l.dy - this.rootDy)
      if (Math.abs(delta) < 1e-5) continue
      const A = this.pos[l.iA], B = this.pos[l.iB], C = this.pos[l.iC]
      const a = A.distanceTo(B)
      const b = B.distanceTo(C)
      const d0 = A.distanceTo(C)
      _t.copy(C); _t.y += delta
      const dMax = REACH * (a + b)
      // The fold floor gives way to a crouch, which is asking for exactly that.
      const d = Math.min(dMax, Math.max(Math.abs(a - b) + 1e-4, Math.min(FOLD * d0, d0 - this.w * this.sink), _t.distanceTo(A)))
      // The knee, about the axis the pose already bends it on.
      _a.subVectors(A, B); _c.subVectors(C, B)
      _n.crossVectors(_a, _c)
      if (_n.lengthSq() > 1e-12 * a * a * b * b) {
        _n.normalize()
        const cos0 = Math.max(-1, Math.min(1, (a * a + b * b - d0 * d0) / (2 * a * b)))
        const cos1 = Math.max(-1, Math.min(1, (a * a + b * b - d * d) / (2 * a * b)))
        _q.setFromAxisAngle(_n, Math.acos(cos1) - Math.acos(cos0))
        _qp.copy(this.quat[l.iPB]).invert().multiply(_q).multiply(this.quat[l.iPB])
        l.B.quaternion.premultiply(_qp)
        // The foot the bend moved it to, still about the unturned hip.
        _c.applyQuaternion(_q).add(B)
      } else {
        _c.copy(C)
      }
      // The hip, so the leg points down its target.
      _a.subVectors(_c, A).normalize()
      _b.subVectors(_t, A).normalize()
      _q.setFromUnitVectors(_a, _b)
      if (l.iPA < 0) _qp.copy(_q)
      else _qp.copy(this.quat[l.iPA]).invert().multiply(_q).multiply(this.quat[l.iPA])
      l.A.quaternion.premultiply(_qp)
      l.A.updateMatrix()
      l.B.updateMatrix()
    }
    this.root.position.y += this.w * this.rootDy
    this.root.updateMatrix()
  }
}

// A planted body that has turned this far on the spot reads the ground under its feet again, on its next probe: a foot half a metre out swings a tenth of a metre, which on a 20-degree hillside is the few centimetres it may hover or sink between readings.
export const REPLANT = 0.2
const _dys = [0, 0, 0, 0, 0, 0]

/**
 * A layer's one call a frame for its puppet's feet: a still body's to the
 * ground, a moving one's back to its clip. `c` is the layer's creature -- x,
 * y, z on the ground, heading about the world up, k its scale, speed and clip
 * -- `planted` the clips whose feet stay put, `walk` the ground. The ground is
 * read under each rest foot, turned and scaled as the body is, against the
 * body's own height: once when the body stops, and again on a probe frame once
 * it has turned REPLANT on the spot. In between the heights are not read at all.
 */
export function groundFeet(puppet, c, walk, planted, probing) {
  if (!(c.speed === 0 && planted.has(c.clip))) { puppet.unplant(); return }
  if (puppet.planted && !(probing && Math.abs(Math.atan2(Math.sin(c.heading - puppet.plantHeading), Math.cos(c.heading - puppet.plantHeading))) > REPLANT)) return
  const cs = Math.cos(c.heading), sn = Math.sin(c.heading)
  const feet = puppet.feet
  for (let i = 0; i < feet.length; i++) {
    const fx = feet[i].x * c.k, fz = feet[i].z * c.k
    _dys[i] = (walk.heightAt(c.x + fx * cs + fz * sn, c.z - fx * sn + fz * cs) - c.y) / c.k
  }
  puppet.plant(_dys, c.heading)
}

/**
 * One near creature's body: its own bones, every shared tier geometry bound to
 * them, and a mixer over the shared clips.
 *
 * `show(tier)` asks for a tier (-1 for gone) and `step(dt)` runs the mixer and
 * the dissolve. A puppet is DONE only once it has faded out, which is what a
 * pool must wait for before handing it to somebody else.
 */
export class Puppet {
  constructor(asset, mats, { clipFade = 0.25, oneShot = null } = {}) {
    this.group = new THREE.Group()
    this.group.matrixAutoUpdate = false
    const copies = new Map()
    // The rig hangs under NOTHING: its world matrices are creature-space, so
    // the bone texture holds the pose alone and the group's matrix places it --
    // see POSE_EVERY. The tree is composed by hand on the frames this puppet
    // poses and walked by `step` then and only then; a held frame never touches
    // it, and a group written every frame re-multiplies the meshes, not the bones.
    this.rig = cloneBones(asset.root, copies)
    this.skeleton = new THREE.Skeleton(asset.skeleton.bones.map((b) => copies.get(b)), asset.skeleton.boneInverses.map((m) => m.clone()))
    this.bones = []
    this.rig.traverse((b) => { b.matrixAutoUpdate = false; this.bones.push(b) })
    // Its feet, if the shipper named its legs; a body without them cannot plant.
    this.ik = asset.legs ? new FootIK(this.bones, asset.legs) : null
    // A second solver over the pose, on the same contract -- restore before the
    // mixer, solve after the feet, reset on release -- for a body posed off a
    // headset (avatar-rig.js VrBody).
    this.solver = null
    const sphere = poseSphere(asset.tiers)
    this.meshes = asset.tiers.map((geo) => {
      const m = new THREE.SkinnedMesh(geo, mats.plain)
      // FRUSTUM CULLED, ON A SPHERE OF ITS OWN. three's projectObject calls
      // objects.update INSIDE the frustum branch, so a body behind her loses its
      // bone-texture upload along with its draw; and an explicit sphere is what
      // keeps SkinnedMesh.computeBoundingSphere -- which CPU-skins every vertex
      // -- from ever being reached.
      m.boundingSphere = sphere
      m.matrixAutoUpdate = false
      m.visible = false
      // DETACHED, on the identity: a vertex is modelMatrix * boneMatrix * position
      // with nothing cancelling, so the bones pose it and the group places it.
      // An attached bind would put the mesh's own world matrix in the bind
      // inverse and want the bones in world space with it.
      m.bindMode = THREE.DetachedBindMode
      m.bind(this.skeleton, IDENTITY)
      this.group.add(m)
      return m
    })
    this.mats = mats
    this.tinted = false
    this.clipFade = clipFade
    this.mixer = new THREE.AnimationMixer(this.rig)
    this.actions = new Map(asset.clips.map((clip) => {
      const action = this.mixer.clipAction(clip)
      if (oneShot?.has(clip.name)) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      }
      return [clip.name, action]
    }))
    this.current = null
    // True on the frames this puppet re-poses, which is what opens the gate
    // below. Frames until the next pose, and the dt banked for the mixer while
    // it waits.
    this.posed = true
    this.poseIn = posePhase++ % POSE_EVERY[POSE_EVERY.length - 1]
    this.held = 0
    // THE GATE. three calls skeleton.update() once a frame for every skeleton it
    // draws (WebGLObjects.update), which multiplies every bone into the bone
    // texture and flags the upload. On a held frame it does neither and the
    // texture keeps the pose it has -- unless it has never been built since the
    // clip or tier changed (`stale`): the renderer calls this only for a body
    // that passed the frustum test, so a pose frame spent behind her fills
    // nothing, and the texture would otherwise show the animal before this one
    // (or, fresh from the pool, all zeros) until the next pose frame.
    this.stale = true
    const update = THREE.Skeleton.prototype.update.bind(this.skeleton)
    this.skeleton.update = () => {
      if (!this.posed && !this.stale) return
      this.stale = false
      update()
    }
    // The slot's step counter, so the same clip twice running is re-cued rather than left playing.
    this.cue = -1
    // The tier being faded out of, the one being faded into, and how far along.
    this.from = -1
    this.to = -1
    this.fade = 1
    this.fadeS = LOD_FADE_S
  }

  /** The tier a puppet has settled on, or is on its way to; -1 is gone. */
  get tier() { return this.to }

  /** True once it has faded out and is drawing nothing -- the pool's signal to take it back. */
  get done() { return this.to === -1 && this.fade >= 1 }

  /** `name` from `at` seconds in, or faded to from whatever plays. `cue` changing is what says this is a new step and not the same one still running. */
  play(name, cue = 0, at = -1) {
    const next = this.actions.get(name)
    if (!next) throw new Error(`Puppet: no clip named ${name}`)
    if (this.current === next && this.cue === cue) return
    this.cue = cue
    // A new clip shows on the next frame whatever rung it is on, and on the first
    // frame the renderer sees it if that one is spent out of view.
    this.poseIn = 0
    this.stale = true
    // The mixer snapshots a property it starts driving, so it must not see a solved foot.
    this.ik?.restore()
    this.solver?.restore()
    if (this.current && this.current !== next && at < 0) {
      next.reset().fadeIn(this.clipFade).play()
      this.current.fadeOut(this.clipFade)
    } else {
      this.mixer.stopAllAction()
      next.reset().play()
      if (at >= 0) next.time = at % next.getClip().duration
    }
    this.current = next
  }

  /** Ask for `tier`, -1 for gone. Starts a dissolve over `seconds`, or cuts at 0; a reversal mid-fade rewinds the one already running rather than starting a third. */
  show(tier, seconds = lodFadeS()) {
    if (tier === this.to) return
    this.fadeS = seconds
    const reversing = tier === this.from && this.fade < 1
    this.from = this.to
    this.to = tier
    this.fade = seconds <= 0 ? 1 : reversing ? 1 - this.fade : 0
    this.poseIn = 0
    this.stale = true
    this._apply()
  }

  /** The rest position of each foot in creature space, in leg order, to read the ground under. */
  get feet() {
    if (!this.ik) throw new Error('Puppet: this body has no legs named -- re-ship it')
    return this.ik.feet
  }

  /** True while its feet are asked to the ground; `plantHeading` is what the last plant was handed. */
  get planted() { return this.ik?.planted ?? false }

  get plantHeading() { return this.ik.heading }

  /** Feet to the ground: `dys` is each foot's vertical offset in creature units, in `feet` order, `sink` a crouch below that. Eases in over the clip fade. */
  plant(dys, heading = 0, sink = 0) {
    if (!this.ik) throw new Error('Puppet: this body has no legs named -- re-ship it')
    this.ik.plant(dys, heading, sink)
  }

  /** Feet back to the clip's, eased out over the clip fade. Nothing to undo is fine. */
  unplant() { this.ik?.unplant() }

  /** One frame: the mixer at this rung's cadence, the feet if planted, then the dissolve. */
  step(dt) {
    this.held += dt
    this.posed = --this.poseIn <= 0
    if (this.posed) {
      // Mid-fade the finer of the two rungs wins, so a body arriving on rung 0
      // is at full rate the moment it starts arriving rather than a rung later.
      this.poseIn = this.fade < 1 ? Math.min(poseEvery(this.from), poseEvery(this.to)) : poseEvery(this.to)
      const solving = this.ik?.active ?? false
      if (solving) this.ik.restore()
      this.solver?.restore()
      this.mixer.update(this.held)
      for (const b of this.bones) b.updateMatrix()
      if (solving) this.ik.solve(this.held, this.clipFade)
      this.solver?.solve(this.held)
      this.rig.updateMatrixWorld(true)
      this.held = 0
    }
    // A settled puppet holds its materials, so the tint row flipping is the one
    // thing besides a fade that has to repaint one.
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeS)
      this._apply()
    } else if (this.tinted !== tierTintOn()) this._apply()
  }

  /**
   * Which tiers are visible, through which material, at what cut. Under the
   * tint row (critters.js TIER_TINTS) a fade draws only the tier it is fading
   * TO, so two colours never overlap and the frame she reads is unambiguous.
   */
  _apply() {
    const settled = this.fade >= 1
    const tint = (this.tinted = tierTintOn())
    this.mats.uCut.value = settled ? 1 : this.fade
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k]
      if (k === this.to) {
        m.visible = true
        m.material = tint ? TIER_TINTS[k] : settled ? this.mats.plain : this.mats.in
      } else if (k === this.from && !settled) {
        m.visible = !tint
        m.material = this.mats.out
      } else {
        m.visible = false
      }
    }
  }

  /** Back to nothing at all, at once and without a fade: its creature has gone, not walked off. */
  release() {
    this.ik?.reset()
    this.solver?.reset()
    this.mixer.stopAllAction()
    this.current = null
    this.cue = -1
    this.from = -1
    this.to = -1
    this.fade = 1
    this.poseIn = 0
    this._apply()
  }
}
