import THREE from '../../three-instance.js'
import { createPropMaterial } from '../../material.js'
import { LAYER } from '../../textures.js'
import { LOD_RUNGS, critterTier } from './critters.js'
import { lodFadeS, cloneBones, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet, solverStub } from './baked-puppet.js'
import { addGeometry, propArrays, toGeometry } from './signposts.js'
import { Cords } from './cord.js'
import { StriderShake } from './strider-shake.js'
import { StriderPaddle } from './strider-paddle.js'

// The towns' frost striders (DESIGN.md §32): their puppets, the hitching rails they stand at, and the reins. The sim (townsfolk.js TownLife) says where each is and what it does; this draws it, and says where its saddle is for a rider.

export const STRIDER = {
  url: 'creatures/frost-strider.glb',
  clips: ['idle', 'fidget', 'walk', 'run'],
  puppets: 8,
  // A rail's posts and bar in metres: the bar `h` over the ground, the posts sunk `sink` into it.
  rail: { h: 1.0, post: 0.12, bar: 0.07, sink: 0.3 },
  // The most reins drawn, the points along each, and its droop mid-span per metre of it, at most `max`; a cord (cord.js) `width` m wide, never under `px` pixels. Hers riding is `held` m long at the mean size, hanging as a cord of that length would.
  rein: { most: 48, points: 12, droop: 0.12, max: 0.35, width: 0.015, px: 2, color: 0x4a2e1a, held: 1.0 },
  // Running off or at her it is never quite straight: its aim wanders up to `wobble` rad, rolled afresh every `every` m, and veers by the first of `veer` rad each way that clears the way `look` s (at least `near` m times its size) ahead (clearAhead). Stone standing `wall` m over both the ground and its feet is a wall to it.
  dash: { wobble: 0.2, every: [0.7, 1.5], look: 0.4, near: 1.2, veer: [0.4, 0.8, 1.2], wall: 0.5 },
  // Seconds between a drawn strider's chirps; its flutter and shake (strider-shake.js) are on each fidget.
  call: [25, 70],
  said: 32,
  // Each strider is `mean` times the shipped body, spread over `vary` of that, and grows by `fed` a fish once tame.
  size: { mean: 1.5, vary: [0.85, 1.2], fed: 1.05 },
  // A fish within `bite` m times its size of the middle of its head, beak and all, is at its mouth.
  bite: 0.4,
}

/** A strider's size against the shipped body, from `u` in 0..1. */
export const striderSize = (u) => STRIDER.size.mean * (STRIDER.size.vary[0] + (STRIDER.size.vary[1] - STRIDER.size.vary[0]) * u)

const PLANTED = new Set(['idle'])
const between = ([lo, hi]) => lo + (hi - lo) * Math.random()
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const _wall = { x: 0, z: 0, r: 0 }
const clamp = THREE.MathUtils.clamp
const UP = new THREE.Vector3(0, 1, 0)
const X = new THREE.Vector3(1, 0, 0)
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _m = new THREE.Matrix4()

/**
 * Of the bind-pose vertices mostly skinned to bone `hi`, in that bone's frame: their `middle` (the head bone sits at the neck, half a metre behind the beak), and the `jowl` a rein is tied to, on the right of the head (+x in the bind frame, the beak toward -z) half way down from the middle.
 */
function headPoints(mesh, hi, inverse) {
  const pos = mesh.geometry.attributes.position, idx = mesh.geometry.attributes.skinIndex, wt = mesh.geometry.attributes.skinWeight
  const sum = new THREE.Vector3(), v = new THREE.Vector3(), lo = new THREE.Vector3(Infinity, Infinity, Infinity), top = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
  let n = 0
  for (let i = 0; i < pos.count; i++) {
    let w = 0
    for (let k = 0; k < 4; k++) if (idx.getComponent(i, k) === hi) w += wt.getComponent(i, k)
    if (w < 0.5) continue
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix)
    sum.add(v)
    lo.min(v)
    top.max(v)
    n++
  }
  if (n === 0) throw new Error(`striders: no vertex is skinned to head bone ${hi}`)
  sum.divideScalar(n)
  const jowl = new THREE.Vector3(top.x, 0.5 * (sum.y + lo.y), sum.z).applyMatrix4(inverse)
  return { middle: sum.applyMatrix4(inverse), jowl }
}

/** Whether (x, z) shuts the way of a strider `m` standing at height `y`: a trunk or another body (walk.obstacleAt), a townsperson within half its size in metres (`crowd(x, z, pad)`, Townsfolk.folkAt), `water` over the ground, or stone (STRIDER.dash.wall). */
export function walled(walk, m, x, z, y, crowd = null, water = true) {
  if (walk.obstacleAt(x, z, _wall, m) || (crowd && crowd(x, z, 0.5 * m.pose.size))) return true
  const level = water ? walk.waterAt(x, z) : null
  if (level !== null && level > walk.heightAt(x, z, y)) return true
  const top = walk.heightAt(x, z), w = STRIDER.dash.wall
  return top - y > w && top - walk.heightAt(x, z, -Infinity) > w
}

/** Whether the way `L` m ahead of strider `m` along `heading` is open, at half way and at the end (walled). */
export function clearAhead(walk, m, heading, L, crowd = null, water = true) {
  const p = m.pose, c = Math.cos(heading), s = Math.sin(heading)
  return !walled(walk, m, p.x + c * L * 0.5, p.z - s * L * 0.5, p.y, crowd, water) && !walled(walk, m, p.x + c * L, p.z - s * L, p.y, crowd, water)
}

/** The heading a strider `m` running at `v` m/s toward `want` takes this frame (STRIDER.dash): wobbled, and veered round what is ahead toward the side it already leans. Its wobble is kept on `m.dash`. */
export function dashAim(walk, m, want, v, dt, crowd = null) {
  const D = STRIDER.dash, p = m.pose, d = m.dash
  if ((d.left -= v * dt) <= 0) { d.left = between(D.every); d.wob = between([-D.wobble, D.wobble]) }
  const h = want + d.wob, L = Math.max(D.near * p.size, v * D.look)
  if (clearAhead(walk, m, h, L, crowd)) return h
  const side = Math.sign(wrap(p.heading - h)) || 1
  for (const a of D.veer) for (const o of [a * side, -a * side]) if (clearAhead(walk, m, h + o, L, crowd)) return h + o
  return h
}

/** What this layer keeps on a mount the sim or the road hands it, `size` times the shipped body (striderSize). */
export function mountFields(size) {
  if (!(size > 0)) throw new Error(`mountFields: a strider's size must be positive, not ${size}`)
  const [lo, hi] = STRIDER.call
  return { pose: { x: 0, y: 0, z: 0, heading: 0, k: 0, size, speed: 0, clip: 'idle', cue: 0, swim: false }, lod: LOD_RUNGS, puppet: null, dist: 0, gone: false, dash: { wob: 0, left: 0 }, heard: -1, call: lo + (hi - lo) * Math.random(), tread: { x: 0, y: 0, z: 0, size: 0, clip: 'idle', cycle: 1, speed: 0 } }
}

/** A body's matrix from its pose: at x, y, z, turned `heading` about the up, scaled `k`. */
export function poseMatrix(pose, k, out) {
  return out.compose(_v.set(pose.x, pose.y, pose.z), _q.setFromAxisAngle(UP, pose.heading), _s.setScalar(k))
}

/** Whether `head` is more to the side of a body at `pose` than before or behind it: where a rider mounts from. */
export function fromSide(pose, head) {
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading), dx = head.x - pose.x, dz = head.z - pose.z
  return Math.abs(-dx * s - dz * c) > Math.abs(dx * c - dz * s)
}

/**
 * The saddle, as the lowest crest of the back's midline between the hips and
 * chest joints in the bind frame, carried on the hips bone (`seat`) so a posed
 * body's saddle is hips.matrixWorld times it; `rest` is it on the idle's
 * first frame in creature units, for a body drawn without a puppet. Only the
 * first `verts` vertices are read, so a bare body (wild-striders.js) is
 * measured without its tack.
 */
export function saddleOf(url, asset, verts = Infinity) {
  const { bones, boneInverses } = asset.skeleton
  const index = (name) => {
    const i = bones.findIndex((b) => b.name === THREE.PropertyBinding.sanitizeNodeName(name))
    if (i < 0) throw new Error(`${url}: no bone named ${name}`)
    return i
  }
  const hips = index(asset.spine[0]), chest = index(asset.spine[1]), head = index(asset.head[asset.head.length - 1])
  const bindZ = (i) => new THREE.Vector3().setFromMatrixPosition(boneInverses[i].clone().invert()).z
  const z0 = Math.min(bindZ(hips), bindZ(chest)), z1 = Math.max(bindZ(hips), bindZ(chest))
  const pos = asset.tiers[0].getAttribute('position')
  const tops = new Map()
  for (let i = 0; i < Math.min(pos.count, verts); i++) {
    const z = pos.getZ(i)
    // The belly is skipped: a row with no back vertex on the midline would otherwise crest at it.
    if (Math.abs(pos.getX(i)) > 0.05 || z < z0 || z > z1 || pos.getY(i) < 0.4 * asset.height) continue
    const k = Math.round(z * 25), top = tops.get(k)
    if (top === undefined || pos.getY(i) > top) tops.set(k, pos.getY(i))
  }
  let best = null
  for (const [k, y] of tops) if (best === null || y < best.y) best = { y, z: k / 25 }
  if (best === null || !(best.y < asset.height)) throw new Error(`${url}: the saddle measures ${best && best.y} on a body ${asset.height} tall`)
  const seat = new THREE.Vector3(0, best.y, best.z).applyMatrix4(boneInverses[hips])
  const copies = new Map()
  const rig = cloneBones(asset.root, copies)
  const mixer = new THREE.AnimationMixer(rig)
  mixer.clipAction(asset.clips.find((c) => c.name === 'idle')).play()
  mixer.update(0)
  rig.updateMatrixWorld(true)
  const rest = seat.clone().applyMatrix4(copies.get(bones[hips]).matrixWorld)
  return { hips, head, seat, rest }
}

/**
 * One load per url, shared by the town and wild layers: two loads of one GLB
 * racing through A-Frame's image cache leave the second texture with no image,
 * which draws the body black.
 */
export function loadStriderGlb(url = STRIDER.url) {
  if (!loads.has(url)) loads.set(url, loadStrider(url))
  return loads.get(url)
}
const loads = new Map()

async function loadStrider(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: STRIDER.clips, extras: 'bird' })
  const x = asset.extras
  if (!(x.span > 0) || !(x.sizeM > 0) || !(x.height > 0) || !(x.gait && x.gait.walk > 0 && x.gait.run > 0)) throw new Error(`${url}: no span, size, height or gaits in its bird extras -- re-ship it`)
  if (!(x.legs && x.legs.length === 2 && x.spine && x.spine.length >= 2 && x.head && x.head.length > 0)) throw new Error(`${url}: no legs, spine and head named -- re-ship it`)
  const out = { ...asset, ...x }
  return { ...out, saddle: saddleOf(url, out) }
}

export class Striders {
  /** `walk` is the WalkSurface their feet and the rails stand on; `patch` the lighting patch. */
  constructor(scene, { walk, textures, patch }) {
    this.scene = scene
    this.walk = walk
    this.batch = new THREE.Group()
    this.batch.name = 'v2-striders'
    scene.add(this.batch)
    this.plain = makeSettledMaterial('strider')
    this.mats = Array.from({ length: STRIDER.puppets }, () => makePuppetMaterials('strider', this.plain))
    this.materials = [this.plain, ...this.mats.flatMap((m) => [m.in, m.out])]
    this.puppets = []
    this.free = []
    this.asset = null
    this.k = 0
    this.railMaterial = patch(createPropMaterial(textures, { side: THREE.FrontSide, vertexColors: true }), 'v2-strider-rail')
    this.box = new THREE.BoxGeometry(1, 1, 1)
    // The reins: one buffer drawn three times a pixel apart.
    const R = STRIDER.rein
    const material = new THREE.MeshLambertMaterial({ color: R.color })
    this.reins = new Cords(scene, { most: R.most, points: R.points, width: R.width, minPx: R.px, material, name: 'v2-strider-reins' })
    patch(material, 'v2-strider-reins')
    this.reinXyz = new Float32Array(R.points * 3)
    // The frame's walking bodies for the ear, and the calls not yet heard (audio/ambience.js herds and voiced).
    this.treading = []
    this.said = []
    this.rank = 0
    this.frame = 0
    this.starved = 0
  }

  setAsset(asset) {
    this.asset = asset
    this.k = asset.sizeM / asset.span
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.mats) {
      for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
      const p = makePuppet(asset, mats, { clipFade: 0.3 })
      // Shake, then paddle, then whatever a layer chains after `paddle.then`.
      p.paddle = p.baked ? solverStub() : new StriderPaddle(p, asset)
      p.solver = p.baked ? solverStub() : new StriderShake(p, asset)
      p.solver.then = p.paddle
      this.puppets.push(p)
    }
    this.free = this.puppets.slice()
  }

  /** What the sim needs of it: its walk in m/s and its fidget clip's seconds. */
  get sim() {
    return { walk: this.asset.gait.walk * this.k, fidget: this.asset.clips.find((c) => c.name === 'fidget').duration }
  }

  /** A new frame: the puppets go nearest first from here, and the reins are laid afresh. */
  begin() {
    this.frame++
    this.rank = 0
    this.reins.begin()
    this.treading.length = 0
  }

  /**
   * One mount's frame, nearest first: `m.pose` is { x, y, z, heading, speed,
   * clip, cue, swim }, `m.dist` its distance from her, `m.gone` true once it has left
   * the sim, and the rest this layer's (mountFields).
   */
  draw(m, dt) {
    const pose = m.pose, k = this.k * pose.size
    pose.k = k
    m.lod = critterTier(this.asset.sizeM * pose.size, m.dist, m.lod, LOD_RUNGS)
    const want = m.gone || m.lod === LOD_RUNGS || this.rank++ >= STRIDER.puppets ? -1 : m.lod
    if (want !== -1 && !m.puppet) {
      const p = this.free.pop()
      if (!p) { this.starved++; return }
      m.puppet = p
      this.batch.add(p.group)
      p.play(pose.clip, pose.cue, 0)
    }
    const p = m.puppet
    if (!p) return
    p.show(want, lodFadeS())
    const gait = this.asset.gait[pose.clip]
    p.play(pose.clip, pose.cue)
    // On the clip's own action, not the mixer: the mixer's clock also times the fade between clips, which run backward never ends.
    p.current.timeScale = gait === undefined ? 1 : pose.speed / (gait * k)
    // Afloat its feet paddle (strider-paddle.js) rather than stand.
    if (pose.swim) p.unplant()
    else groundFeet(p, pose, this.walk, PLANTED, (this.frame + m.id) % 6 === 0)
    p.paddle.set(pose.swim ? 1 : 0, Math.abs(pose.speed) / (this.asset.gait.walk * k))
    p.step(dt)
    poseMatrix(pose, k, p.group.matrix)
    p.group.matrixWorldNeedsUpdate = true
    if (p.done) { this.release(m); return }
    if (want === -1) return
    Object.assign(m.tread, { x: pose.x, y: pose.y, z: pose.z, size: this.asset.sizeM * pose.size, clip: pose.clip, cycle: p.current.getClip().duration / Math.abs(p.current.timeScale), speed: Math.abs(pose.speed) })
    if (!pose.swim) this.treading.push(m.tread)
    if (pose.clip === 'fidget' && m.heard !== pose.cue) {
      this.say('striderFlutter', pose)
      p.solver.start()
    }
    m.heard = pose.cue
    if ((m.call -= dt) <= 0) {
      const [lo, hi] = STRIDER.call
      m.call = lo + (hi - lo) * Math.random()
      this.say(Math.random() < 0.5 ? 'striderChirp1' : 'striderChirp2', pose)
    }
  }

  /** The striders walking this frame, for the ear (audio/ambience.js herds). */
  bodies(into) { into.push(...this.treading) }

  /** Their chirps and flutters since the last call (audio/ambience.js voiced). */
  voices(into) {
    into.push(...this.said)
    this.said.length = 0
  }

  /** `sound` from the head of a body at `pose`, played at `rate` and `gain` (audio/ambience.js voiced). */
  say(sound, { x, y, z, size }, rate = 1, gain = 1) {
    if (this.said.length < STRIDER.said) this.said.push({ sound, x, y: y + 0.6 * this.k * size * this.asset.height, z, rate, gain })
  }

  release(m) {
    if (!m.puppet) return
    m.puppet.release()
    this.batch.remove(m.puppet.group)
    this.free.push(m.puppet)
    m.puppet = null
  }

  /** Where a rider's underside sits on `m` this frame, in the world, into `out`; after its draw. */
  saddle(m, out) {
    const s = this.asset.saddle
    if (m.puppet) return out.copy(s.seat).applyMatrix4(m.puppet.skeleton.bones[s.hips].matrixWorld).applyMatrix4(m.puppet.group.matrix)
    return out.copy(s.rest).applyMatrix4(poseMatrix(m.pose, this.k * m.pose.size, _m))
  }

  /**
   * Whether (x, z) is within `pad` of `m`'s body, a capsule along its heading;
   * if so the nearest point of its axis and the capsule's radius and pad into
   * `out` {x, z, r}, as WalkSurface.obstacleAt answers.
   */
  bodyAt(m, x, z, pad, out) {
    const p = m.pose, L = this.asset.sizeM * p.size, half = 0.25 * L, r = 0.2 * L + pad
    const dx = x - p.x, dz = z - p.z
    if (dx * dx + dz * dz > (half + r) * (half + r)) return null
    const c = Math.cos(p.heading), s = -Math.sin(p.heading)
    const u = clamp(dx * c + dz * s, -half, half)
    const ax = p.x + c * u, az = p.z + s * u
    if ((x - ax) ** 2 + (z - az) ** 2 > r * r) return null
    out.x = ax
    out.z = az
    out.r = r
    return out
  }

  /** The right of its jowl in the world, where a rein is tied, into `out`; or false with no puppet to read it off. */
  jowl(m, out) {
    const P = m.puppet
    if (!P) return false
    out.copy(this._head(P).jowl).applyMatrix4(P.skeleton.bones[this.asset.saddle.head].matrixWorld).applyMatrix4(P.group.matrix)
    return true
  }

  _head(P) {
    const hi = this.asset.saddle.head
    return (this.headAt ??= headPoints(P.meshes[0], hi, P.skeleton.boneInverses[hi]))
  }

  /** Whether (x, y, z) is at `m`'s mouth (STRIDER.bite, times `slack`); false with no puppet. */
  bites(m, x, y, z, slack = 1) {
    const P = m.puppet
    if (!P) return false
    _v.copy(this._head(P).middle).applyMatrix4(P.skeleton.bones[this.asset.saddle.head].matrixWorld).applyMatrix4(P.group.matrix)
    return _v.distanceToSquared(_s.set(x, y, z)) < (STRIDER.bite * m.pose.size * slack) ** 2
  }

  /** A rein from `a` to `b`, sagging; `length` m long if given, hanging as a cord that long (taut past it), else by STRIDER.rein.droop. */
  rein(a, b, length = 0) {
    const R = STRIDER.rein, d = a.distanceTo(b), xyz = this.reinXyz
    // A parabola `droop` deep over span d is about d + 8 droop^2 / 3d long.
    const droop = length > 0 ? Math.min(0.5 * length, Math.sqrt((3 * d * Math.max(0, length - d)) / 8)) : Math.min(R.max, R.droop * d)
    for (let i = 0; i < R.points; i++) {
      const u = i / (R.points - 1)
      xyz[i * 3] = a.x + (b.x - a.x) * u
      xyz[i * 3 + 1] = a.y + (b.y - a.y) * u - droop * 4 * u * (1 - u)
      xyz[i * 3 + 2] = a.z + (b.z - a.z) * u
    }
    this.reins.add(xyz)
  }

  /** The frame's reins to the GPU. */
  end() {
    this.reins.end()
  }

  /** The height of a rail's bar over (x, z). */
  barY(x, z) { return this.walk.heightAt(x, z, -Infinity) + STRIDER.rail.h }

  /** A town's rails as one mesh in the scene: posts at each rail's ends and middle, a bar between each two. */
  rails(town) {
    const R = STRIDER.rail, prop = propArrays(), tint = [0.62, 0.5, 0.4]
    for (const { rail: [[ax, az], [bx, bz]] } of town.posts) {
      const ups = [0, 0.5, 1].map((u) => {
        const x = ax + (bx - ax) * u, z = az + (bz - az) * u
        return new THREE.Vector3(x, this.walk.heightAt(x, z, -Infinity), z)
      })
      const tall = R.h + R.bar + R.sink
      for (const p of ups) {
        _m.compose(_v.set(p.x, p.y - R.sink + tall / 2, p.z), _q.identity(), _s.set(R.post, tall, R.post))
        addGeometry(prop, this.box, _m, LAYER.TIMBER_HEWN, tint)
      }
      for (let i = 1; i < ups.length; i++) {
        const a = ups[i - 1].clone().setY(ups[i - 1].y + R.h), b = ups[i].clone().setY(ups[i].y + R.h)
        const dir = b.clone().sub(a), len = dir.length()
        _m.compose(a.add(b).multiplyScalar(0.5), _q.setFromUnitVectors(X, dir.normalize()), _s.set(len + R.post, R.bar, R.bar))
        addGeometry(prop, this.box, _m, LAYER.TIMBER_HEWN, tint)
      }
    }
    const mesh = new THREE.Mesh(toGeometry(prop), this.railMaterial)
    mesh.name = `strider-rails-${town.id}`
    this.scene.add(mesh)
    return mesh
  }

  dropRails(mesh) {
    this.scene.remove(mesh)
    mesh.geometry.dispose()
  }

  dispose() {
    for (const p of this.puppets) this.batch.remove(p.group)
    this.batch.removeFromParent()
    this.reins.dispose()
    this.box.dispose()
    this.railMaterial.dispose()
    for (const m of this.materials) m.dispose()
  }
}
