import THREE from '../../three-instance.js'
import { PROP_FADE_SECONDS, dissolvesOn, getPropClock, setPropFadeTimerAt, setPropSolidAt } from '../../material.js'
import { LAYER } from '../../textures.js'
import { CARD_RUNGS, LOD_DEG, LOD_RUNGS, LOD_STEP, distAt, ladderTier } from './critters.js'
import { Puppet, lodFadeS, cloneBones, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet, tintFor, tintOf, tintRange } from './baked-puppet.js'
import { cardPicture } from './litter-cards.js'
import { PropArena } from './prop-arena.js'
import { addGeometry } from './signposts.js'
import { PADDLE, paddleHz, striderClips } from './strider-clips.js'

// The towns' frost striders (DESIGN.md §32): their puppets and the hitching rails they stand at. The sim (townsfolk.js TownLife) says where each is and what it does; this draws it, and says where its saddle is for a rider.

export const STRIDER = {
  url: 'creatures/frost-strider.glb',
  clips: ['idle', 'fidget', 'walk', 'run'],
  puppets: 8,
  // A rail's posts and bar in metres: the bar `h` over the ground, the posts sunk `sink` into it.
  rail: { h: 1.0, post: 0.12, bar: 0.07, sink: 0.3 },
  // Running off or at her it is never quite straight: its aim wanders up to `wobble` rad, rolled afresh every `every` m, and veers by the first of `veer` rad each way that clears the way `look` s (at least `near` m times its size) ahead (clearAhead). Stone standing `wall` m over both the ground and its feet is a wall to it.
  dash: { wobble: 0.2, every: [0.7, 1.5], look: 0.4, near: 1.2, veer: [0.4, 0.8, 1.2], wall: 0.5 },
  // Seconds between a drawn strider's chirps; its flutter is on each fidget, whose clip carries the shake (strider-clips.js).
  call: [25, 70],
  said: 32,
  // Each strider is `mean` times the shipped body, spread over `vary` of that, and grows by `fed` a fish once tame.
  size: { mean: 1.5, vary: [0.85, 1.2], fed: 1.05 },
  // Each one's colour, browner through its own slate to bluer (tintRange).
  tint: tintRange([[1.15, 1, 0.8], [1, 1, 1], [0.85, 0.95, 1.18]], 0.06),
  // A fish within `bite` m times its size of the middle of its head, beak and all, is at its mouth.
  bite: 0.4,
}

/** A strider's size against the shipped body, from `u` in 0..1. */
export const striderSize = (u) => STRIDER.size.mean * (STRIDER.size.vary[0] + (STRIDER.size.vary[1] - STRIDER.size.vary[0]) * u)

// The arc ladder (critters.js ladderTier): puppet tiers 0..2, then the side card (litter-cards.js HEADING) from where tier 3 began out to the wildlife cards' cull, the CARD_RUNGS ladder's last reach; RUNGS is undrawn.
const STEPS = [1, LOD_STEP, LOD_STEP ** 2, LOD_STEP ** (CARD_RUNGS - 1)]
const CARD_RUNG = 3
const RUNGS = LOD_RUNGS
// Shared-pool ids per layer (LitterCards.claim): more than the live striders of either layer.
const CARD_IDS = 64

const PLANTED = new Set(['idle'])
// Afloat it paddles, unless it is shaking off.
const clipOf = (pose) => (pose.swim && pose.clip !== 'fidget' ? 'paddle' : pose.clip)
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
const RAIL_BOX = new THREE.BoxGeometry(1, 1, 1)
const _c = new THREE.Color()

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

/** What this layer keeps on a mount the sim or the road hands it, `size` times the shipped body (striderSize), its colour rolled from `hue` (a creature key, tintFor). */
export function mountFields(size, hue) {
  if (!(size > 0)) throw new Error(`mountFields: a strider's size must be positive, not ${size}`)
  const [lo, hi] = STRIDER.call
  return { hue, pose: { x: 0, y: 0, z: 0, heading: 0, k: 0, size, speed: 0, clip: 'idle', cue: 0, swim: false }, lod: RUNGS, puppet: null, card: -1, cardAt: -1, drawn: -1, dist: 0, gone: false, dash: { wob: 0, left: 0 }, heard: -1, call: lo + (hi - lo) * Math.random(), tread: { x: 0, y: 0, z: 0, size: 0, clip: 'idle', cycle: 1, speed: 0 } }
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

/** Whether `head` is at its face: more ahead of `pose` than to its side. */
export function atFace(pose, head) {
  const c = Math.cos(pose.heading), s = Math.sin(pose.heading), dx = head.x - pose.x, dz = head.z - pose.z
  return dx * c - dz * s > Math.abs(-dx * s - dz * c)
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
  out.clips = striderClips(out)
  return { ...out, saddle: saddleOf(url, out) }
}

export class Striders {
  /** `walk` is the WalkSurface their feet stand on; `cards` the shared LitterCards their card rung is drawn by. */
  constructor(scene, { walk, cards }) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Striders needs the LitterCards its far card is drawn by')
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
    // The frame's walking bodies for the ear, and the calls not yet heard (audio/ambience.js herds and voiced).
    this.treading = []
    this.said = []
    this.rank = 0
    this.frame = 0
    this.starved = 0
    // The card rung: ids in the shared pool, its pictures (bakeCards; -1 until then, and the rung draws nothing), the mounts holding a card, and the cards dissolving out { id, at }.
    cards.claim('striders', CARD_IDS)
    this.litterCards = cards
    this.cardView = PropArena.over(cards.meshes, CARD_IDS, 'v2-strider-card')
    for (let i = 0; i < CARD_IDS; i++) {
      this.cardView.addInstance(0)
      this.cardView.setVisibleAt(i, false)
    }
    this.cardIds = Array.from({ length: CARD_IDS }, (_, i) => CARD_IDS - 1 - i)
    this.picture = -1
    this.tackPicture = -1
    this.carded = new Set()
    this.fading = []
    this.dark = 0
  }

  /** Every body drawn `dark` 0..1 of the way to black: her chanterelle (eating.js). */
  darken(dark) {
    this.dark = dark
    for (const m of this.materials) m.color.setScalar(1 - dark)
  }

  setAsset(asset) {
    this.asset = asset
    this.k = asset.sizeM / asset.span
    this.paddleHz = paddleHz(asset.clips.find((c) => c.name === 'idle'))
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.mats) {
      for (const m of [mats.in, mats.out]) { m.map = asset.map; m.needsUpdate = true }
      this.puppets.push(makePuppet(asset, mats, { clipFade: 0.3 }))
    }
    this.free = this.puppets.slice()
    this.clipS = new Map(asset.clips.map((c) => [c.name, c.duration]))
  }

  /**
   * Photograph the side card off a throwaway puppet posed in `idle`, as the
   * wildlife's (wildlife.js bakeCards), and start drawing the card rung; with
   * `tack` tiers, a second picture of the body wearing them, for a mount whose
   * `m.tack` is set (wild-striders.js). Once, after the asset has landed.
   */
  bakeCards(renderer, tack = null) {
    if (!this.asset) throw new Error('Striders.bakeCards: the asset has not landed')
    const a = this.asset, bounds = { halfX: a.span / 2, halfZ: a.width / 2, height: a.height }
    const bake = (tiers) => {
      const flat = new THREE.MeshBasicMaterial({ map: a.map, toneMapped: false })
      const p = new Puppet({ ...a, tiers }, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, {})
      p.show(0)
      p.play('idle')
      p.step(0)
      p.group.updateMatrixWorld(true)
      const i = this.litterCards.addPicture(cardPicture('heading', bounds))
      this.litterCards.bake(renderer, i, p.group, a.map, bounds, 'heading')
      p.release()
      p.skeleton.dispose()
      flat.dispose()
      return i
    }
    this.picture = bake(a.tiers)
    if (tack) this.tackPicture = bake(tack)
  }

  /** What the sim needs of it: its walk in m/s and its fidget clip's seconds. */
  get sim() {
    return { walk: this.asset.gait.walk * this.k, fidget: this.asset.clips.find((c) => c.name === 'fidget').duration }
  }

  /** A new frame: the puppets go nearest first from here. */
  begin() {
    this.frame++
    this.rank = 0
    this.treading.length = 0
  }

  /**
   * One mount's frame, nearest first: `m.pose` is { x, y, z, heading, speed,
   * clip, cue, swim }, `m.dist` its distance from her, `m.gone` true once it has left
   * the sim, and the rest this layer's (mountFields).
   */
  draw(m, dt) {
    const pose = m.pose, k = this.k * pose.size, base = distAt(this.asset.sizeM * pose.size, LOD_DEG)
    pose.k = k
    m.drawn = this.frame
    m.lod = ladderTier(base, STEPS, RUNGS, m.dist, m.lod)
    let want = m.gone || m.lod >= CARD_RUNG || this.rank++ >= STRIDER.puppets ? -1 : m.lod
    if (want !== -1 && !m.puppet) {
      const p = this.free.pop()
      if (p) {
        m.puppet = p
        tintFor(p, m.hue, STRIDER.tint)
        this.batch.add(p.group)
        p.play(clipOf(pose), pose.cue, 0)
      } else { this.starved++; want = -1 }
    }
    // Past the puppets, the card: dissolved in over a puppet that cuts out once it is whole, and dissolved out from over a puppet that cuts in.
    const had = m.card >= 0, card = this._card(m, !m.gone && m.lod < RUNGS && want === -1, k)
    const clip = clipOf(pose), gait = this.asset.gait[clip]
    // On the clip's own action, not the mixer: the mixer's clock also times the fade between clips, which run backward never ends. Afloat the strokes quicken with its speed.
    let scale = gait === undefined ? 1 : pose.speed / (gait * k)
    if (clip === 'paddle') scale = (PADDLE.hz[0] + (PADDLE.hz[1] - PADDLE.hz[0]) * clamp(Math.abs(pose.speed) / (this.asset.gait.walk * k), 0, 1)) / this.paddleHz
    const p = m.puppet
    if (p) {
      if (card) { if (this._settled(m.cardAt)) p.show(-1, 0) }
      else p.show(want, had && want !== -1 ? 0 : lodFadeS())
      p.play(clip, pose.cue)
      p.current.timeScale = scale
      if (pose.swim) p.unplant()
      else groundFeet(p, pose, this.walk, PLANTED, (this.frame + m.id) % 6 === 0)
      p.step(dt)
      poseMatrix(pose, k, p.group.matrix)
      p.group.matrixWorldNeedsUpdate = true
      if (p.done) this._unpuppet(m)
    }
    // Heard as far as the puppets reached before the card rung took tier 3's span.
    if (want === -1 && !(card && m.dist <= base * LOD_STEP ** (LOD_RUNGS - 1))) return
    Object.assign(m.tread, { x: pose.x, y: pose.y, z: pose.z, size: this.asset.sizeM * pose.size, clip: pose.clip, cycle: this.clipS.get(clip) / Math.abs(scale), speed: Math.abs(pose.speed) })
    if (!pose.swim) this.treading.push(m.tread)
    if (pose.clip === 'fidget' && m.heard !== pose.cue) this.say('striderFlutter', pose)
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

  /** Whether a dissolve stamped at `at` on the prop clock is over: past PROP_FADE_SECONDS, or across the clock's wrap (material.js setPropClock). */
  _settled(at) {
    const age = getPropClock() - at
    return !(age >= 0 && age < PROP_FADE_SECONDS)
  }

  /** `m`'s card on or off as `on` asks, posed at scale `k` if on; whether it has one now. */
  _card(m, on, k) {
    on &&= (m.tack && this.tackPicture >= 0 ? this.tackPicture : this.picture) >= 0
    if (!on) {
      this._uncard(m)
      return false
    }
    const V = this.cardView
    if (m.card < 0) {
      if (this.cardIds.length === 0) { this.starved++; return false }
      m.card = this.cardIds.pop()
      m.cardAt = dissolvesOn() ? getPropClock() : -1
      if (m.cardAt >= 0) setPropFadeTimerAt(V, m.card, m.cardAt, true)
      else setPropSolidAt(V, m.card)
      this.carded.add(m)
    }
    V.setLayerShiftAt(m.card, m.tack && this.tackPicture >= 0 ? this.tackPicture : this.picture)
    V.setMatrixAt(m.card, poseMatrix(m.pose, k, _m))
    // The baked puppet's colour (tintFor); a skinned one wears none.
    V.setColorAt(m.card, (this.puppets[0].baked ? tintOf(m.hue, STRIDER.tint, _c) : _c.setScalar(1)).multiplyScalar(1 - this.dark))
    V.setVisibleAt(m.card, true)
    return true
  }

  /** `m`'s card, if any, dissolving out (finished in end). */
  _uncard(m) {
    if (m.card < 0) return
    const at = dissolvesOn() ? getPropClock() : -1
    if (at >= 0) setPropFadeTimerAt(this.cardView, m.card, at, false)
    this.fading.push({ id: m.card, at })
    this.carded.delete(m)
    m.card = -1
  }

  release(m) {
    this._uncard(m)
    this._unpuppet(m)
  }

  _unpuppet(m) {
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

  /** The frame's cards that went undrawn are put away, and the faded ones settled. */
  end() {
    for (const m of this.carded) if (m.drawn !== this.frame) this._uncard(m)
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]
      if (!this._settled(f.at)) continue
      this.cardView.setVisibleAt(f.id, false)
      setPropSolidAt(this.cardView, f.id)
      this.cardIds.push(f.id)
      this.fading[i] = this.fading[this.fading.length - 1]
      this.fading.pop()
    }
  }

  /** The height of a rail's bar over (x, z). */
  barY(x, z) { return this.walk.heightAt(x, z, -Infinity) + STRIDER.rail.h }

  /** A town's rails into `prop` (signposts.js propArrays) in the town's frame, for trades.js to merge into its mesh: posts at each rail's ends and middle, a bar between each two. `ground` is the field, the ground barY reads. */
  static addRails(prop, town, ground) {
    const R = STRIDER.rail, tint = [0.62, 0.5, 0.4]
    for (const { rail: [[ax, az], [bx, bz]] } of town.posts) {
      const ups = [0, 0.5, 1].map((u) => {
        const x = ax + (bx - ax) * u, z = az + (bz - az) * u
        return new THREE.Vector3(x - town.x, ground(x, z), z - town.z)
      })
      const tall = R.h + R.bar + R.sink
      for (const p of ups) {
        _m.compose(_v.set(p.x, p.y - R.sink + tall / 2, p.z), _q.identity(), _s.set(R.post, tall, R.post))
        addGeometry(prop, RAIL_BOX, _m, LAYER.TIMBER_HEWN, tint)
      }
      for (let i = 1; i < ups.length; i++) {
        const a = ups[i - 1].clone().setY(ups[i - 1].y + R.h), b = ups[i].clone().setY(ups[i].y + R.h)
        const dir = b.clone().sub(a), len = dir.length()
        _m.compose(a.add(b).multiplyScalar(0.5), _q.setFromUnitVectors(X, dir.normalize()), _s.set(len + R.post, R.bar, R.bar))
        addGeometry(prop, RAIL_BOX, _m, LAYER.TIMBER_HEWN, tint)
      }
    }
  }

  dispose() {
    for (let i = 0; i < CARD_IDS; i++) this.cardView.setVisibleAt(i, false)
    for (const p of this.puppets) this.batch.remove(p.group)
    this.batch.removeFromParent()
    for (const m of this.materials) m.dispose()
  }
}
