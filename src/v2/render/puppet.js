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
// The fade is TIMED, NOT BANDED, because teleport locomotion crosses a whole
// distance band in one frame: a fade driven by distance across the band edge
// would still pop under a teleport, and this one always takes its LOD_FADE_S.
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
import { gltfLoader } from './critters.js'

// How long a tier change, an appearance or a vanishing takes. Long enough that
// the eye reads a dissolve rather than a flicker, short enough that a creature
// walking a threshold is not permanently half-there.
export const LOD_FADE_S = 0.35

const IDENTITY = new THREE.Matrix4()

// ---------------------------------------------------------------------------
// HOW OFTEN A PUPPET RE-POSES, BY THE RUNG IT DRAWS ON: every frame on the top
// rung, then every second, fourth and eighth frame. This is the one lever the
// ladder does NOT give us -- three uploads a skeleton's bone texture once a
// frame per skeleton drawn, whichever tier that is, so a rung-3 stag costs the
// same skinning as a rung-0 one. Skipping the pose is what makes a distant
// animal cheap: no mixer, no bone composed, no bone texture re-uploaded.
//
// The mixer's dt is BANKED and spent in one go, so a clip plays at its own
// speed however coarsely it is sampled -- this is a lower sample rate, not a
// slower animation.
//
// WHAT A HELD FRAME LOOKS LIKE. The bone texture holds WORLD matrices (the
// bones hang under the creature's own group), and a skinned vertex is
// bindMatrixInverse * boneMatrix * position with the mesh's model matrix put
// back on top -- the two cancel. So a body whose bone texture is stale draws
// frozen where it stood rather than sliding away from its pose, and the animal
// crosses the ground in hops of its own cadence: 2 cm a hop on rung 1, 16 cm on
// rung 3 for a stag at a walk, which is a couple of pixels at the distance that
// rung starts at. The layers therefore leave the group's matrix alone on a held
// frame too, since writing it would cost the bone tree a full re-multiply and
// change nothing on screen. Sliding on smoothly while holding the pose would
// need the rig in local space (a detached bind), which is a bigger change than
// the hop is worth.
// ---------------------------------------------------------------------------
export const POSE_EVERY = [1, 2, 4, 8]
const poseEvery = (tier) => (tier < 0 ? POSE_EVERY[POSE_EVERY.length - 1] : POSE_EVERY[Math.min(tier, POSE_EVERY.length - 1)])
// Puppets built one after another start their count on different frames, so a
// herd re-poses a few bodies a frame instead of all of them on every eighth.
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
 * The caller patches it with the world's lighting; lighting.js chains
 * onBeforeCompile, so a splice here survives it.
 */
export function makeSettledMaterial(cacheKey) {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff })
  m.customProgramCacheKey = () => cacheKey
  return m
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
export function makePuppetMaterials(cacheKey, plain) {
  const uCut = { value: 1 }
  const make = (side) => {
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff })
    const uSide = { value: side }
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uCut = uCut
      shader.uniforms.uSide = uSide
      dissolve(shader)
    }
    m.customProgramCacheKey = () => `${cacheKey}-fade`
    m.userData.uCut = uCut
    return m
  }
  return { plain, in: make(1), out: make(-1), uCut }
}

// A flat colour a rung -- green, yellow, orange, red -- so which tier a body is
// drawing on is a thing she can see from across the meadow rather than guess at.
// Halving triangles on a smooth mesh barely moves the silhouette, which is the
// whole point of an LOD and also why a swap is unverifiable by eye without this.
// While it is on, a fade draws only the tier it is fading TO, so the two colours
// never overlap and the frame she reads is unambiguous.
const TIER_TINTS = [0x4caf50, 0xffd54f, 0xff9800, 0xe53935].map((color) => new THREE.MeshBasicMaterial({ color }))
let tierTint = false

/** Flat-colour every puppet by the tier it is drawing, for confirming the ladder by walking it. */
export const setTierTint = (on) => {
  tierTint = on
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
    const root = cloneBones(asset.root, copies)
    this.group.add(root)
    this.skeleton = new THREE.Skeleton(asset.skeleton.bones.map((b) => copies.get(b)), asset.skeleton.boneInverses.map((m) => m.clone()))
    // Every bone in the tree, composed BY HAND on the frames this puppet poses.
    // Object3D.updateMatrixWorld composes a bone whose matrixAutoUpdate is on
    // and dirties its world matrix EVERY frame whatever the pose is doing, so
    // turning it off here is what makes a held frame cost a walk of the tree and
    // nothing else. The meshes hold still under the group at identity, so they
    // are composed once and never again.
    this.bones = []
    root.traverse((b) => { b.matrixAutoUpdate = false; this.bones.push(b) })
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
      // The bind matrix is the identity: the tiers and the bones sit under the same group at identity, so the group's matrix is the creature's.
      m.bind(this.skeleton, IDENTITY)
      this.group.add(m)
      return m
    })
    this.mats = mats
    this.tinted = false
    this.clipFade = clipFade
    this.mixer = new THREE.AnimationMixer(this.group)
    this.actions = new Map(asset.clips.map((clip) => {
      const action = this.mixer.clipAction(clip)
      if (oneShot?.has(clip.name)) {
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
      }
      return [clip.name, action]
    }))
    this.current = null
    // True on the frames this puppet re-poses; the layers read it to know
    // whether writing the group's matrix would show. Frames until the next pose,
    // and the dt banked for the mixer while it waits.
    this.posed = true
    this.poseIn = posePhase++ % POSE_EVERY[POSE_EVERY.length - 1]
    this.held = 0
    // THE GATE. three calls skeleton.update() once a frame for every skeleton it
    // draws (WebGLObjects.update), which multiplies every bone into the bone
    // texture and flags the upload. On a held frame it does neither and the
    // texture keeps the pose it has.
    const update = THREE.Skeleton.prototype.update.bind(this.skeleton)
    this.skeleton.update = () => { if (this.posed) update() }
    // The slot's step counter, so the same clip twice running is re-cued rather than left playing.
    this.cue = -1
    // The tier being faded out of, the one being faded into, and how far along.
    this.from = -1
    this.to = -1
    this.fade = 1
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
    // A new clip shows on the next frame whatever rung it is on: a held puppet
    // playing the pose of the animal before it is the one stale frame that reads.
    this.poseIn = 0
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

  /** Ask for `tier`, -1 for gone. Starts a dissolve; a reversal mid-fade rewinds the one already running rather than starting a third. */
  show(tier) {
    if (tier === this.to) return
    const reversing = tier === this.from && this.fade < 1
    this.from = this.to
    this.to = tier
    this.fade = reversing ? 1 - this.fade : 0
    this.poseIn = 0
    this._apply()
  }

  /** One frame: the mixer at this rung's cadence, then the dissolve. */
  step(dt) {
    this.held += dt
    this.posed = --this.poseIn <= 0
    if (this.posed) {
      // Mid-fade the finer of the two rungs wins, so a body arriving on rung 0
      // is at full rate the moment it starts arriving rather than a rung later.
      this.poseIn = this.fade < 1 ? Math.min(poseEvery(this.from), poseEvery(this.to)) : poseEvery(this.to)
      this.mixer.update(this.held)
      this.held = 0
      for (const b of this.bones) b.updateMatrix()
    }
    // A settled puppet holds its materials, so the tint row flipping is the one
    // thing besides a fade that has to repaint one.
    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / LOD_FADE_S)
      this._apply()
    } else if (this.tinted !== tierTint) this._apply()
  }

  /** Which tiers are visible, through which material, at what cut. */
  _apply() {
    const settled = this.fade >= 1
    this.tinted = tierTint
    this.mats.uCut.value = settled ? 1 : this.fade
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k]
      if (k === this.to) {
        m.visible = true
        m.material = tierTint ? TIER_TINTS[k % TIER_TINTS.length] : settled ? this.mats.plain : this.mats.in
      } else if (k === this.from && !settled) {
        m.visible = !tierTint
        m.material = this.mats.out
      } else {
        m.visible = false
      }
    }
  }

  /** Back to nothing at all, at once and without a fade: its creature has gone, not walked off. */
  release() {
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
