/**
 * The hob weevils: the leafkin's pets, one at most houses (design/30-leafkin.md
 * §Hobs). An adult keeps its yard in front of its door, or trails its owner --
 * the villager of that house -- while the owner is out; each of its babies
 * trails it. Size and tint are rolled from the room's seed.
 *
 * NOT ON THE SCORE. Where a hob makes for is a function of the world clock,
 * the seed and the villagers' drawn poses alone, and it is put straight there
 * on a boot, after a clock jump, or when undrawn and LOSE_M off it; between
 * those it steers there each frame. Never sent and never exactly agreed.
 * A frog chasing one (frogs.js chasers) sends it squealing FLEE_M off.
 */

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32, swing } from '../../sim/score.js'
import { LOD_RUNGS, critterTier } from './critters.js'
import { LOD_FADE_S, Puppet, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const HOB_GLB = 'creatures/hob-weevil.glb'
export const CLIPS = ['idle', 'walk', 'run', 'eat']
const PLANTED = new Set(['idle', 'eat'])
export const PUPPETS = 12
// The odds a house keeps a hob, that it trails its owner rather than keeping the yard, and of 0, 1, 2 or 3 babies.
export const KEPT = 0.85
export const FOLLOWERS = 0.6
export const BROODS = [0.35, 0.35, 0.2, 0.1]
// An adult's length in metres and its spread; a baby's as a share of its parent's.
export const SIZE_M = 0.45
export const SIZE_VAR = 0.15
export const BABY = [0.33, 0.45]
// Multipliers on the moss-green texture, one settled material each (puppet.js makePuppetMaterials says why not one a hob); a baby wears its parent's at TINT_KEPT.
export const TINTS = [[1, 1, 1], [1.35, 1.15, 0.7], [0.75, 1, 1.3], [1.5, 0.85, 0.65], [1.05, 0.8, 1.25], [0.6, 0.65, 0.6]]
export const TINT_KEPT = 0.7
// The yard: a disc of YARD_R about a point YARD_M out from the door, away from its sill; a new spot in it every slot of SLOT_S, eaten at with odds EAT.
export const YARD_M = 1.2
export const YARD_R = 1.3
export const SLOT_S = [5, 12]
export const EAT = 0.5
// Trailing: GAP_M behind the leader's rim, stopped within STOP of its own lengths and off again past twice that.
// A hob undrawn and LOSE_M off its spot is put on it; a clock step past RESYNC_S puts every hob on its spot.
export const GAP_M = 0.2
export const STOP = 0.6
export const LOSE_M = 12
// Each hob cries once every CRY_S seconds, from its middle (ambience.js RULES.hobCry sets how far it carries).
export const CRY_S = [40, 120]
// Chased by a frog: it makes for a spot FLEE_M straight away from it (swung up to FLEE_SWING off where that is wet), squealing -- its cry -- at once and every SQUEAL_S.
export const FLEE_M = 3
const FLEE_SWING = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8]
export const SQUEAL_S = [1.2, 2.5]
const NO_CHASERS = []
const RESYNC_S = 1
const VILLAGER_R = 0.25
// Steering: speed per metre still to go, the turn rate, and the cadence caps -- a walk to WALK_PACE, then a run to an adult's or a baby's, a parent held to BROOD_KEEP of its slowest baby's top speed.
const GAIN = 1.5
const TURN_RATE = 5
const WALK_PACE = 2
const RUN_PACE = 3
const BABY_PACE = 6
const BROOD_KEEP = 0.9
const MIN_PACE = 0.6
const FADE_S = 0.25

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const pick = (rand, odds) => {
  let r = rand()
  for (let i = 0; i < odds.length; i++) if ((r -= odds[i]) < 0) return i
  return odds.length - 1
}

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()

export async function loadHobGlb(url = HOB_GLB) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: CLIPS, extras: 'insect' })
  if (!(asset.extras.span > 0) || !(asset.extras.gait?.walk > 0) || !(asset.extras.gait?.run > 0)) throw new Error(`${url}: no span or gait speeds in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

export class Hobs {
  /**
   * @param opts.walk       WalkSurface: heightAt
   * @param opts.villagers  the glade's Villagers: their graph, drawn poses and seat()
   * @param opts.seed       the room's seed, a uint32 every client of the room shares
   * @param opts.asset      a loaded asset, for a gate; the world fetches the GLB
   */
  constructor(scene, { walk, villagers, seed = 1, asset = null } = {}) {
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Hobs need the WalkSurface, for heightAt')
    if (!villagers?.graph || typeof villagers.seat !== 'function') throw new Error('Hobs need the Villagers, to trail and to stand beside')
    if (!Number.isInteger(seed) || seed < 0) throw new Error(`Hobs: the seed is a uint32, got ${seed}`)
    this.walk = walk
    this.villagers = villagers
    this.seed = seed
    this.batch = new THREE.Group()
    this.batch.name = 'v2-hobs'
    scene.add(this.batch)
    this.plains = TINTS.map(([r, g, b]) => {
      const m = makeSettledMaterial('hobs')
      m.color.setRGB(r, g, b)
      return m
    })
    this.materials = this.plains.slice()
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('hobs', this.plains[0])
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    this.all = []
    this.calls = []
    this.cryRand = mulberry32(hash32(seed, 0xc41))
    const { nodes, doorNodes } = villagers.graph
    doorNodes.forEach((home, house) => {
      const rand = mulberry32(hash32(seed, 0x40b, house))
      if (rand() >= KEPT) return
      const owner = villagers.all[house]
      if (owner?.home !== home) throw new Error(`Hobs: villager ${house} does not live at door ${house}`)
      const door = nodes[home], ox = door.x - door.sill.x, oz = door.z - door.sill.z, L = Math.hypot(ox, oz)
      if (!(L > 1e-3)) throw new Error(`Hobs: door ${house} stands on its own sill`)
      const yard = { x: door.x + (ox / L) * YARD_M, z: door.z + (oz / L) * YARD_M }
      const adult = this._hob(rand, yard, SIZE_M * (1 + SIZE_VAR * (2 * rand() - 1)), (rand() * TINTS.length) | 0)
      adult.owner = rand() < FOLLOWERS ? owner : null
      adult.side = rand() < 0.5 ? -1 : 1
      const brood = pick(rand, BROODS)
      for (let i = 0; i < brood; i++) {
        const baby = this._hob(rand, yard, adult.size * between(rand, BABY), rand() < TINT_KEPT ? adult.tint : (rand() * TINTS.length) | 0)
        baby.parent = adult
        baby.side = i % 2 ? 1 : -1
        baby.row = i >> 1
      }
    })
    this.puppets = []
    this.freePuppets = []
    this.asset = null
    this.head = { x: 0, y: 0, z: 0 }
    this.frame = 0
    this.seconds = null
    this.loaded = false
    this.starved = 0
    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  _hob(rand, yard, size, tint) {
    const h = {
      id: this.all.length, yard, size, tint, k: 1, owner: null, parent: null, side: 1, row: 0,
      slotS: between(rand, SLOT_S), cry: between(this.cryRand, CRY_S), slot: -1, spotX: yard.x, spotZ: yard.z, eats: false,
      x: 0, y: 0, z: 0, heading: rand() * 2 * Math.PI, aim: 0, moving: false,
      clip: 'idle', cue: 0, pace: 1, speed: 0, top: 0, lod: LOD_RUNGS, puppet: null,
      // The frog after it this frame, and what the frogs chase it as.
      chaser: null, lure: { kind: 'hob', x: 0, y: 0, z: 0, by: 'hob', id: this.all.length },
    }
    this.all.push(h)
    return h
  }

  async load() {
    this.setAsset(await loadHobGlb())
    return true
  }

  setAsset(asset) {
    this.asset = asset
    for (const m of this.materials) {
      m.map = asset.map
      m.needsUpdate = true
    }
    for (const mats of this.puppetMats) this.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S }))
    this.freePuppets = this.puppets.slice()
    for (const h of this.all) {
      h.k = h.size / asset.span
      h.top = asset.gait.run * h.k * (h.parent ? BABY_PACE : RUN_PACE)
    }
    // A parent goes no faster than its slowest baby can follow.
    for (const h of this.all) if (h.parent) h.parent.top = Math.min(h.parent.top, BROOD_KEEP * h.top)
    this.loaded = true
  }

  get stats() {
    const babies = this.all.filter((h) => h.parent).length
    return { count: this.all.length, adults: this.all.length - babies, babies, trailing: this.all.filter((h) => h.owner && this._out(h)).length, puppets: this.puppets.length - this.freePuppets.length, starved: this.starved }
  }

  /** Whether an adult's owner is out to trail. */
  _out(h) {
    const o = h.owner
    return !o.hidden && o.state !== 'inside'
  }

  /** `h` put straight on the spot it makes for now, or on its leader or yard where that spot is wet; a parent before its babies. */
  _place(h, seconds) {
    const lead = this._target(h, seconds)
    let x = h.spotX, z = h.spotZ
    if (this.villagers.seat(x, z) === null) ({ x, z } = lead ?? h.yard)
    h.x = x
    h.z = z
    h.y = this.walk.heightAt(x, z, -Infinity)
    if (lead) h.heading = lead.heading
    h.moving = false
  }

  /** Where `h` makes for now, and what it faces once there (null: whichever way it came). */
  _target(h, seconds) {
    const lead = h.parent ?? (h.owner && this._out(h) ? h.owner.pose : null)
    if (lead) {
      const rim = h.parent ? h.parent.size * 0.5 : VILLAGER_R
      const back = rim + GAP_M + h.size * (0.5 + h.row), lat = h.side * (h.parent ? h.parent.size * 0.5 : 0.3)
      const fx = Math.cos(lead.heading), fz = -Math.sin(lead.heading)
      h.spotX = lead.x - fx * back - fz * lat
      h.spotZ = lead.z - fz * back + fx * lat
      h.eats = false
      h.slot = -1
      return lead
    }
    const slot = Math.floor(seconds / h.slotS)
    if (slot !== h.slot) {
      h.slot = slot
      const rand = mulberry32(hash32(this.seed, h.id, slot))
      const a = rand() * 2 * Math.PI, r = YARD_R * Math.sqrt(rand())
      h.spotX = h.yard.x + Math.cos(a) * r
      h.spotZ = h.yard.z + Math.sin(a) * r
      h.eats = rand() < EAT
    }
    return null
  }

  /** A spot FLEE_M from its chaser, straight away where that is dry, else swung off it. */
  _flee(h) {
    const c = h.chaser, away = Math.atan2(h.z - c.z, h.x - c.x)
    h.eats = false
    h.slot = -1
    for (const a of FLEE_SWING) {
      const x = h.x + Math.cos(away + a) * FLEE_M, z = h.z + Math.sin(away + a) * FLEE_M
      if (this.villagers.seat(x, z) !== null) { h.spotX = x; h.spotZ = z; return }
    }
  }

  /** One frame of steering: toward the spot at a speed that eases in on it, the gait and cadence picked from the speed. */
  _steer(h, seconds, dt) {
    let lead = null
    if (h.chaser !== null) this._flee(h)
    else lead = this._target(h, seconds)
    if (!h.puppet && Math.hypot(h.spotX - h.x, h.spotZ - h.z) > LOSE_M) this._place(h, seconds)
    const d = Math.hypot(h.spotX - h.x, h.spotZ - h.z), stop = STOP * h.size
    h.moving = h.moving ? d > stop : d > 2 * stop
    const walk = this.asset.gait.walk * h.k, run = this.asset.gait.run * h.k
    let clip = h.eats ? 'eat' : 'idle', pace = 1
    if (h.moving) {
      const v = Math.min(GAIN * (d - stop), h.top)
      const walking = v <= walk * WALK_PACE * (h.clip === 'run' ? 0.8 : 1)
      clip = walking ? 'walk' : 'run'
      pace = Math.max(MIN_PACE, v / (walking ? walk : run))
      h.aim = Math.atan2(-(h.spotZ - h.z), h.spotX - h.x)
    } else if (lead) {
      h.aim = Math.atan2(-(lead.z - h.z), lead.x - h.x)
    }
    if (clip !== h.clip) { h.clip = clip; h.cue++ }
    h.pace = pace
    h.speed = h.moving ? pace * (clip === 'walk' ? walk : run) : 0
    const s = swing(h.heading, h.aim)
    h.heading += Math.sign(s) * Math.min(Math.abs(s), TURN_RATE * dt)
    if (!h.moving) return
    const m = Math.min(d, h.speed * dt * Math.max(0, Math.cos(s)))
    const x = h.x + Math.cos(h.heading) * m, z = h.z - Math.sin(h.heading) * m
    // Never into the water: it waits at the edge for its leader to come back round.
    if (this.villagers.seat(x, z) === null) return
    h.x = x
    h.z = z
    h.y = this.walk.heightAt(x, z, h.y)
  }

  /** What the frogs chase, onto `into`: every hob, as a lure (frogs.js LURES). */
  lures(into) {
    if (!this.loaded || this.villagers.tick === null || !this.batch.visible) return into
    for (const h of this.all) {
      h.lure.x = h.x; h.lure.y = h.y; h.lure.z = h.z
      into.push(h.lure)
    }
    return into
  }

  /** One frame, after the villagers' own: `head` her eyes, `seconds` the world clock, `dt` the frame's time, `chasers` the frogs after a hob (frogs.js chasers). */
  update(head, seconds, dt, chasers = NO_CHASERS) {
    if (!this.loaded || !this.villagers.loaded || this.villagers.tick === null) return
    this.frame++
    this.head.x = head.x; this.head.y = head.y; this.head.z = head.z
    const jumped = this.seconds === null || Math.abs(seconds - this.seconds) > RESYNC_S
    this.seconds = seconds
    this.calls.length = 0
    for (const h of this.all) {
      const was = h.chaser
      h.chaser = null
      for (const c of chasers) if (c.hob === h.id) h.chaser = c
      if (h.chaser !== null && was === null) h.cry = 0
      if (jumped) this._place(h, seconds)
      this._steer(h, seconds, dt)
      this._draw(h, dt)
      if ((h.cry -= dt) <= 0) {
        h.cry = between(this.cryRand, h.chaser !== null ? SQUEAL_S : CRY_S)
        this.calls.push({ sound: 'hobCry', x: h.x, y: h.y + h.size * 0.5, z: h.z })
      }
    }
  }

  /** Drains this frame's cries into `into` for ambience.js, each { sound, x, y, z }. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
  }

  _takePuppet(h) {
    if (!h.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      h.puppet = p
      p.mats.plain = this.plains[h.tint]
      p.mats.in.color.copy(p.mats.plain.color)
      p.mats.out.color.copy(p.mats.plain.color)
      this.batch.add(p.group)
      p.play(h.clip, h.cue, 0)
    }
    return h.puppet
  }

  _releasePuppet(h) {
    const p = h.puppet
    if (!p) return
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
    h.puppet = null
  }

  _draw(h, dt) {
    const dist = Math.hypot(h.x - this.head.x, h.y - this.head.y, h.z - this.head.z)
    h.lod = critterTier(h.size, dist, h.lod, LOD_RUNGS)
    const want = h.lod === LOD_RUNGS ? -1 : h.lod
    const puppet = want === -1 && !h.puppet ? null : this._takePuppet(h)
    if (!puppet) return
    puppet.show(want, LOD_FADE_S)
    puppet.mixer.timeScale = h.pace
    puppet.play(h.clip, h.cue)
    groundFeet(puppet, h, this.walk, PLANTED, (this.frame + h.id) % 6 === 0)
    puppet.step(dt)
    _pos.set(h.x, h.y, h.z)
    _quat.setFromAxisAngle(UP, h.heading)
    _scl.setScalar(h.k)
    puppet.group.matrix.copy(_mat.compose(_pos, _quat, _scl))
    puppet.group.matrixWorldNeedsUpdate = true
    if (puppet.done) this._releasePuppet(h)
  }

  dispose() {
    for (const h of this.all) this._releasePuppet(h)
    this.batch.parent?.remove(this.batch)
    for (const m of this.materials) m.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
