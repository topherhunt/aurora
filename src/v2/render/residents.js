// ---------------------------------------------------------------------------
// THE LEAFKIN AT HOME (design/30-leafkin.md, Interiors): who is in the house
// she has gone into -- its villagers that are indoors, and the house's own
// homebodies -- each going from one of the room's places (rooms/interior.js
// `spots`) to the next: eating at the table, thinking in the reading chair,
// busy at the kitchen, gazing out of a window, a pair talking on the walk
// round the table, wandering it, and up the stairs to lie down and sleep.
// One home with a mushroom -- a forager's gift, one it found, or hers (villagers.js `feast`) -- sits and eats it first, squealing.
// They walk the ring round the table and the stairs' `climb`, never probed:
// the roll keeps both clear. Local to this client and stepped by the frame.
// One that does not trust the players (trust.js), awake and not eating, cowers
// facing her, whimpering, while she stands within COWER_M; a mushroom in her
// hand draws it to her round the ring instead, and held over it is taken and
// trusted as the glade's are (villagers.js `court`).
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { CARRIERS } from '../hands.js'
import { CARRY_SPAN } from './leafkin.js'
import { makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet } from './baked-puppet.js'
import { DARK_FILL, HELD_TORCH } from './interior.js'
import { BECKONS, CALM_S, COURT_STOP_M, FUSS_S, LURE_M, OFFER_M, OFFER_UP, PACE, REPLAN_M, SIT, SIT_CUT, SIZE_M, SIZE_VAR, TALKS, gripAt, pickIndoors } from './villagers.js'

// The house's own leafkin, beyond its villagers indoors: up to this many, trusted under ids from HOMEBODY_ID (trust.js keeps ids under 256).
export const HOMEBODIES = 2
export const HOMEBODY_ID = 128
export const homebodyId = (house, i) => HOMEBODY_ID + house * HOMEBODIES + i
// Her within this of one that does not trust her, it cowers; past COWER_OFF_M it goes back to what it was about.
export const COWER_M = 2
const COWER_OFF_M = 2.5
// One that does not trust her picks its next place at least this far from her where the room has one, so backing off does not walk it straight back to cower again.
const SHY_M = 3
// Seconds from one cowering whimper's start to the next: the 3.6 s clip, then 2-10 s quiet.
export const COWER_WHIMPER_S = [5.6, 13.6]
// The lie clip's hold between its lying back and its sitting up (tools/creatures/anim/clips/human/lie.json), and how far it shuffles up the bed as it lies.
const LIE_CUT = [1.7, 3.7]
const LIE_SLIDE = 0.4
// Seconds each activity holds, and how likely each is picked.
const HOLD_S = { seat: [20, 50], read: [25, 60], cook: [10, 25], gaze: [8, 20], bed: [40, 90], wander: [3, 8], talk: [10, 20] }
export const PICK = [['seat', 0.25], ['read', 0.15], ['cook', 0.15], ['gaze', 0.1], ['bed', 0.12], ['wander', 0.15], ['talk', 0.08]]
// Seconds between one's mutters to itself while it walks, sits or potters; a pair talking, a third of that. Never asleep.
const MUTTER_S = [15, 45]
// A feast's hold at the table, and the seconds between its squeals.
const FEAST_S = [25, 40]
const SQUEAL_S = [4, 9]
const CHATTERS = 4
const CHEST = 0.5
const TURN_RATE = 5
const NEAR_M = 0.05
const FADE_S = 0.25
// What lights them, against the room's own light terms (render/interior.js): ambient, candle, window.
const LIGHT = { amb: 0.75, candle: 0.3, win: 0.35, tint: new THREE.Color(1.0, 0.86, 0.7) }

/** Sets `out` (a vec3 uniform's value) to a resident's light in a house of uniforms `u`: the night's fill and the candles, and the daylit fill and the windows in the colour of the light through the glass. */
export function residentLight(u, out) {
  const k = LIGHT.amb * u.uAmb.value * DARK_FILL + LIGHT.candle * u.uCandle.value * u.uFlicker.value
  const w = LIGHT.amb * u.uAmb.value * (1 - DARK_FILL) + LIGHT.win * u.uWin.value, sky = u.uSky.value
  return out.set(LIGHT.tint.r * (k + w * sky.r), LIGHT.tint.g * (k + w * sky.g), LIGHT.tint.b * (k + w * sky.b))
}

// A body lit by the bake where it stands is the walls' own sum times this, which keeps the townsfolk on average as bright as residentLight's.
const BODY_GAIN = 1.35
/** Sets colour `out` to a body's light in a house of uniforms `u` from the bake `L` at its chest (town-interior.js townLight) and the held torches' light there (heldTorchAt). */
export function residentLightAt(u, L, torch, out) {
  const k = u.uAmb.value * L[0] + u.uCandle.value * u.uFlicker.value * L[1], w = u.uWin.value * L[2], sky = u.uSky.value, T = HELD_TORCH.color
  return out.setRGB(
    BODY_GAIN * LIGHT.tint.r * (k + w * sky.r + torch * T[0]),
    BODY_GAIN * LIGHT.tint.g * (k + w * sky.g + torch * T[1]),
    BODY_GAIN * LIGHT.tint.b * (k + w * sky.b + torch * T[2]))
}

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scl = new THREE.Vector3()
const _grip = new THREE.Vector3()

/** A puppet material lit by `light` (a vec3 uniform) instead of the world's sun: the room's candles and windows reach no further than its own shell. */
export function roomLit(m, light) {
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer)
    shader.uniforms.uResLight = light
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uResLight;')
      .replace('#include <opaque_fragment>', 'outgoingLight = diffuseColor.rgb * uResLight * ( 0.65 + 0.35 * max( normal.z, 0.0 ) );\n#include <opaque_fragment>')
  }
  return m
}

export class Residents {
  /**
   * @param room     rollInterior's room, set down at (ox, oy, oz)
   * @param asset    the villagers' loaded leafkin (Villagers.asset), its `sitY` the seated underside
   * @param who      the villagers indoors, `[{ id, size, pace, feast }]`; the homebodies are rolled here
   * @param seed     the village's seed
   * @param hands    hands.js, and the mushrooms layer its feasts hold, both or neither
   */
  constructor(scene, room, { asset, sitY, who, seed, ox, oy, oz, hands = null, mushrooms = null, hour = () => 12 }) {
    if (!asset || !(sitY > 0)) throw new Error('Residents: need the villagers\' loaded asset and its seated height')
    if ((hands === null) !== (mushrooms === null)) throw new Error('Residents: hands and mushrooms come together')
    this.hands = hands
    this.mushrooms = mushrooms
    this.hour = hour
    this.seed = seed
    this.room = room
    this.asset = asset
    this.sitY = sitY
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    this.group = new THREE.Group()
    this.group.position.set(ox, oy, oz)
    scene.add(this.group)
    this.light = { value: new THREE.Vector3(1, 1, 1) }
    this.plain = roomLit(makeSettledMaterial('residents'), this.light)
    this.plain.map = asset.map
    this.materials = [this.plain]
    this.rand = mulberry32(hash32(seed, room.index, 0x1d2))
    this.calls = []
    // Who has taken her mushroom since befriended() last drained them, by trust id.
    this.won = []
    // Each spot's resident, and the climb's heights: its foot on the floor, each tread's top, the loft.
    this.taken = new Map()
    const treads = room.stairs.map((s) => s.top).reverse()
    this.climbY = room.climb.map((p, i) => (i === 0 ? 0 : i === room.climb.length - 1 ? room.loft.y : treads[i - 1]))
    this.all = []
    if (who.some((w) => w.id >= HOMEBODY_ID) || homebodyId(room.index, HOMEBODIES - 1) > 255) throw new Error(`Residents: house ${room.index}'s trust ids overrun HOMEBODY_ID or 255`)
    for (const w of who) this._add(w.id, w.size, w.pace, false, w.feast)
    const homebodies = Math.floor(this.rand() * (HOMEBODIES + 1))
    for (let i = 0; i < homebodies; i++) this._add(homebodyId(room.index, i), SIZE_M * (1 + SIZE_VAR * (2 * this.rand() - 1)), between(this.rand, PACE), false)
    // Two at home at once are likelier talking than not.
    if (this.all.length >= 2 && this.rand() < 0.5) this._talk(this.all[0], this.all[1], true)
    for (const r of this.all) if (!r.spot) this._choose(r, true)
  }

  /** The villagers indoors now, by id: one come in walks in at the door, one gone out walks to it and is gone. */
  sync(inside) {
    for (const r of this.all) if (r.id < HOMEBODY_ID && !inside.has(r.id) && r.state !== 'leave' && r.state !== 'gone') this._leave(r)
    for (const [id, c] of inside) if (!this.all.some((r) => r.id === id)) this._add(id, c.size, c.pace, true, c.feast)
  }

  _add(id, size, pace, atDoor, feast = false) {
    const mats = makePuppetMaterials('residents', this.plain)
    for (const m of [mats.in, mats.out]) roomLit(m, this.light).map = this.asset.map
    this.materials.push(mats.in, mats.out)
    const puppet = makePuppet(this.asset, mats, { clipFade: FADE_S })
    puppet.mixer.timeScale = pace
    this.group.add(puppet.group)
    puppet.show(0, atDoor ? FADE_S : 0.01)
    const d = this.room.doorIn
    const r = {
      id, size, pace, k: size / this.asset.height, puppet, x: d.x, z: d.z, y: 0, heading: Math.PI / 2, level: 0,
      state: 'walk', spot: null, phase: '', hold: 0, clip: 'idle', from: -1, cue: 0, left: 0, route: [], slide: 0, on: 0, partner: null, feast, carrier: null,
      calm: 0, voice: 0, hx: 0, hz: 0, wary: false, planX: 0, planZ: 0,
      mutter: between(this.rand, MUTTER_S), body: { x: 0, y: 0, z: 0, size, speed: 0, clip: 'walk', cycle: this.durations.walk / pace },
    }
    this.all.push(r)
    if (atDoor) this._choose(r, false)
    return r
  }

  /** The clip for `seconds`, from `from` seconds into it (-1 to fade to it). */
  _play(r, clip, seconds, from = -1) {
    r.clip = clip
    r.left = seconds
    r.from = from
    r.cue++
  }

  _free(spot) { return !this.taken.has(spot) }

  /** Its next place, by PICK among the free ones; `now` puts it there already at its hold. */
  _choose(r, now) {
    const room = this.room
    if (r.feast) {
      const seats = room.spots.filter((s) => s.kind === 'seat' && this._free(s))
      if (seats.length > 0) { this._goTo(r, seats[Math.floor(this.rand() * seats.length)], now); return }
      r.feast = false
    }
    const shy = (p) => !r.wary || Math.hypot(p.x - r.hx, p.z - r.hz) >= SHY_M
    for (let tries = 0; tries < 8; tries++) {
      const kind = pickIndoors(this.rand, PICK, this.hour())
      if (kind === 'talk') {
        const other = this.all.find((o) => o !== r && o.state === 'act' && (o.spot?.kind === 'wander' || o.spot?.kind === 'gaze'))
        if (other && !now && room.spots.every((s) => s.kind !== 'talk' || shy(s))) { this._release(other); this._talk(r, other, false); return }
        continue
      }
      if (kind === 'wander') {
        const pts = room.ringPts.filter(shy)
        if (pts.length === 0) continue
        const p = pts[Math.floor(this.rand() * pts.length)]
        this._goTo(r, { kind: 'wander', x: p.x, z: p.z, lookX: p.x - room.ring.x, lookZ: p.z - room.ring.z, level: 0 }, now)
        return
      }
      const free = room.spots.filter((s) => s.kind === kind && this._free(s) && shy(s))
      if (free.length === 0) continue
      this._goTo(r, free[Math.floor(this.rand() * free.length)], now)
      return
    }
    const p = room.ringPts.reduce((a, q) => (Math.hypot(q.x - r.hx, q.z - r.hz) > Math.hypot(a.x - r.hx, a.z - r.hz) ? q : a))
    this._goTo(r, { kind: 'wander', x: p.x, z: p.z, lookX: 1, lookZ: 0, level: 0 }, now)
  }

  _talk(a, b, now) {
    const pair = this.room.spots.filter((s) => s.kind === 'talk')
    a.partner = b
    b.partner = a
    this._goTo(a, pair[0], now)
    this._goTo(b, pair[1], now)
  }

  /** Off its spot and out of its talk. */
  _drop(r) {
    if (r.partner) { r.partner.partner = null; r.partner = null }
    this._release(r)
  }

  _release(r) {
    if (r.spot) this.taken.delete(r.spot)
    r.spot = null
    r.on = 0
    r.slide = 0
  }

  /** Where its feet stand for `spot`, and which way it faces there: a seat's and a bed's set back so the hips land on them (villagers.js SIT). */
  _stand(r, s) {
    const len = Math.hypot(s.lookX, s.lookZ) || 1
    const ux = s.lookX / len, uz = s.lookZ / len
    if (s.kind === 'seat' || s.kind === 'read') {
      const fore = Math.max(SIT.back * this.asset.wheelbase * r.k, s.r + SIT.clear)
      return { x: s.x + ux * fore, z: s.z + uz * fore, heading: Math.atan2(ux, uz) }
    }
    if (s.kind === 'bed') {
      // Sat on its foot end facing away from the pillow, so lying back puts the head on it.
      const fore = SIT.back * this.asset.wheelbase * r.k
      const hx = s.x - ux * (s.len / 2 - 0.12), hz = s.z - uz * (s.len / 2 - 0.12)
      return { x: hx - ux * fore, z: hz - uz * fore, heading: Math.atan2(-ux, -uz) }
    }
    return { x: s.x, z: s.z, heading: Math.atan2(ux, uz) }
  }

  /** Off to `spot` along the ring, and up or down the stairs if it is on the other level; `now` sets it there at once. */
  _goTo(r, spot, now) {
    if (spot.kind !== 'wander') this.taken.set(spot, r)
    r.spot = spot
    const at = this._stand(r, spot)
    if (now) {
      r.x = at.x; r.z = at.z; r.heading = at.heading; r.level = spot.level
      r.y = spot.level === 1 ? this.room.loft.y : 0
      this._begin(r, true)
      return
    }
    const room = this.room, pts = room.ringPts
    const nearest = (x, z) => {
      let best = 0, d = Infinity
      for (let i = 0; i < pts.length; i++) { const e = Math.hypot(pts[i].x - x, pts[i].z - z); if (e < d) { d = e; best = i } }
      return best
    }
    const route = []
    const floorY = (level) => (level === 1 ? room.loft.y : 0)
    const round = (from, to) => {
      const n = pts.length, fwd = (to - from + n) % n, dir = fwd <= n / 2 ? 1 : -1
      for (let i = from; ; i = (i + dir + n) % n) { route.push({ x: pts[i].x, z: pts[i].z, y: 0 }); if (i === to) break }
    }
    const climb = room.climb.map((p, i) => ({ x: p.x, z: p.z, y: this.climbY[i] }))
    let from = { x: r.x, z: r.z }
    if (r.level === 1) {
      route.push(...climb.slice().reverse())
      from = climb[0]
    }
    if (spot.level === 1) {
      round(nearest(from.x, from.z), nearest(climb[0].x, climb[0].z))
      route.push(...climb)
    } else {
      round(nearest(from.x, from.z), nearest(at.x, at.z))
    }
    route.push({ x: at.x, z: at.z, y: floorY(spot.level) })
    r.route = route
    r.state = 'walk'
    r.level = spot.level
    this._play(r, 'walk', Infinity)
  }

  /** At its place: into the activity's first phase. */
  _begin(r, now) {
    r.state = 'act'
    const s = r.spot
    r.hold = between(this.rand, r.feast ? FEAST_S : HOLD_S[s.kind])
    if (s.kind === 'seat' || s.kind === 'read' || s.kind === 'bed') {
      if (now) { r.phase = s.kind === 'bed' ? 'sleep' : 'hold'; r.on = 1; r.slide = s.kind === 'bed' ? LIE_SLIDE : 0; this._play(r, s.kind === 'bed' ? 'sleep' : r.feast ? 'eat' : 'idle-sit', r.hold) }
      else { r.phase = 'down'; this._play(r, 'sit', SIT_CUT[0], 0) }
    } else if (s.kind === 'cook') {
      r.phase = 'busy'; this._play(r, 'gather', this.durations.gather, 0)
    } else if (s.kind === 'talk') {
      r.phase = 'talk'; this._play(r, TALKS[Math.floor(this.rand() * TALKS.length)], this.durations['talk-gesture'])
    } else {
      r.phase = 'stand'; this._play(r, 'idle', r.hold)
    }
  }

  /** Its clip has run out: the activity's next phase, or its end. */
  _next(r) {
    const s = r.spot
    const sit = SIT_CUT, lie = LIE_CUT
    switch (r.phase) {
      case 'down':
        if (s.kind === 'bed') { r.phase = 'lie'; this._play(r, 'lie', lie[0], 0) }
        else { r.phase = 'hold'; if (r.feast) r.mutter = 0.5; this._play(r, r.feast || (s.kind === 'seat' && this.rand() < 0.6) ? 'eat' : 'idle-sit', Math.min(r.hold, 8)) }
        return
      case 'hold':
        if (r.hold > 0) { this._play(r, r.feast || (s.kind === 'seat' && this.rand() < 0.5) ? 'eat' : 'idle-sit', Math.min(r.hold, 8)); return }
        r.feast = false
        r.phase = 'up'; this._play(r, 'sit', this.durations.sit - sit[1], sit[1]); return
      case 'lie': r.phase = 'sleep'; this._play(r, 'sleep', r.hold); return
      case 'sleep':
        if (r.hold > 0) { this._play(r, 'sleep', r.hold); return }
        r.phase = 'rise'; this._play(r, 'lie', this.durations.lie - lie[1], lie[1]); return
      case 'rise': r.phase = 'up'; this._play(r, 'sit', this.durations.sit - sit[1], sit[1]); return
      case 'busy':
        if (r.hold > 0) { this._play(r, this.rand() < 0.5 ? 'gather' : 'idle', this.rand() < 0.5 ? this.durations.gather : 2, this.rand() < 0.5 ? 0 : -1); return }
        break
      case 'talk':
        if (r.hold > 0 && r.partner?.spot?.kind === 'talk') { this._play(r, this.rand() < 0.4 ? 'idle' : TALKS[Math.floor(this.rand() * TALKS.length)], 1.5 + this.rand() * 1.5); return }
        break
      case 'stand':
        if (r.hold > 0) { this._play(r, 'idle', r.hold); return }
        break
      case 'up': break
      default: throw new Error(`Residents: no phase ${r.phase}`)
    }
    this._drop(r)
    this._choose(r, false)
  }

  _leave(r) {
    r.feast = false
    if (r.state === 'act' && (r.phase === 'hold' || r.phase === 'sleep')) r.hold = 0
    this._release(r)
    const d = this.room.doorIn
    this._goTo(r, { kind: 'wander', x: d.x, z: d.z, lookX: -1, lookZ: 0, level: 0 }, false)
    r.state = 'leave'
  }

  /**
   * Her feet in the world, her held things (hands.js lures) and `trusts(id)`
   * whether resident `id` trusts the players (trust.js): who cowers from her,
   * who comes to her mushroom, and who takes it.
   */
  _her(dt, feet, lures, trusts) {
    const g = this.group.position
    const fx = feet.x - g.x, fy = feet.y - g.y, fz = feet.z - g.z
    const herLevel = this.room.loft && fy > this.room.loft.y / 2 ? 1 : 0
    const held = this.hands === null ? [] : lures.filter((l) => l.by === null && l.kind === 'mushroom')
    for (const r of this.all) {
      r.calm = Math.max(0, r.calm - dt)
      r.hx = fx; r.hz = fz
      r.wary = !trusts(r.id)
      const fearing = r.state === 'cower' || r.state === 'court'
      if (trusts(r.id)) { if (fearing) this._choose(r, false); continue }
      const lure = r.state === 'court' ? held.find((l) => this._under(r, l)) : undefined
      if (lure !== undefined) {
        if (!this.hands.eatLure(lure, 'leafkin')) throw new Error('Residents: her mushroom was offered from no hand of hers')
        held.splice(held.indexOf(lure), 1)
        this.won.push(r.id)
        r.feast = true
        r.calm = CALM_S
        this._say(r, 'leafkinSqueal')
        this._choose(r, false)
        continue
      }
      if (r.feast || r.state === 'leave' || r.state === 'gone') continue
      const d = Math.hypot(r.x - fx, r.y - fy, r.z - fz)
      const want = held.length > 0
        ? (d < LURE_M && r.level === 0 && herLevel === 0 ? 'court' : null)
        : r.calm <= 0 && d < (r.state === 'cower' ? COWER_OFF_M : COWER_M) ? 'cower' : null
      if (want === r.state) {
        if (want === 'court' && Math.hypot(r.planX - fx, r.planZ - fz) >= REPLAN_M) this._court(r, false)
        continue
      }
      if (want === null) {
        if (r.state === 'court') r.calm = CALM_S
        if (fearing) this._choose(r, false)
        continue
      }
      if (r.state === 'act' && r.phase === 'hold' && !r.feast) { r.hold = 0; r.left = 0; continue }
      if (!(fearing || r.state === 'walk' || (r.state === 'act' && (r.phase === 'stand' || r.phase === 'busy' || r.phase === 'talk')))) continue
      this._drop(r)
      if (want === 'court') this._court(r, true)
      else { r.state = 'cower'; r.route = []; r.voice = 0; this._play(r, 'cower', this.durations.cower) }
    }
  }

  /** To her round the ring, to stand COURT_STOP_M short of her feet toward the nearest ring point no nearer her than that; a squeal if `fresh`. */
  _court(r, fresh) {
    const her = { x: r.hx, z: r.hz }
    let ring = null, off = Infinity
    for (const p of this.room.ringPts) {
      const d = Math.hypot(p.x - her.x, p.z - her.z)
      if (d >= COURT_STOP_M && d < off) { ring = p; off = d }
    }
    if (ring === null) throw new Error(`Residents: house ${this.room.index}'s ring lies within ${COURT_STOP_M} m of her`)
    const k = COURT_STOP_M / off
    this._goTo(r, { kind: 'wander', x: her.x + (ring.x - her.x) * k, z: her.z + (ring.z - her.z) * k, lookX: her.x - ring.x, lookZ: her.z - ring.z, level: 0 }, false)
    r.state = 'court'
    r.phase = 'go'
    r.planX = her.x; r.planZ = her.z
    if (fresh) this._say(r, 'leafkinSqueal')
  }

  /** Whether `lure` is held over its body or its fist: within OFFER_M across, and between its feet and OFFER_UP of its size (villagers.js _under). */
  _under(r, lure) {
    const g = this.group.position
    const x = lure.x - g.x, y = lure.y - g.y, z = lure.z - g.z
    if (y < r.y || y > r.y + r.size * OFFER_UP) return false
    if (Math.hypot(x - r.x, z - r.z) <= OFFER_M) return true
    return gripAt(r.puppet, _grip) && Math.hypot(x - _grip.x, z - _grip.z) <= OFFER_M
  }

  /** A call from its chest. */
  _say(r, sound) {
    const g = this.group.position
    this.calls.push({ sound, x: g.x + r.x, y: g.y + r.y + r.size * CHEST, z: g.z + r.z })
  }

  /** Whom she has fed since the last call, by trust id, drained: each trusts the players now (trust.js). */
  befriended(into) {
    for (const id of this.won) into.push(id)
    this.won.length = 0
    return into
  }

  update(dt, view, feet, lures, trusts) {
    this._her(dt, feet, lures, trusts)
    residentLight(view.uniforms, this.light.value)
    for (const r of this.all.slice()) {
      this._step(r, dt)
      if (r.state === 'gone' || r.state === 'cower' || r.state === 'court' || r.phase === 'sleep' || r.phase === 'lie' || r.phase === 'rise') continue
      r.mutter -= r.phase === 'talk' ? dt * 3 : dt
      if (r.mutter > 0) continue
      const eating = r.feast && r.phase === 'hold'
      r.mutter = between(this.rand, eating ? SQUEAL_S : MUTTER_S)
      const g = this.group.position
      this.calls.push({ sound: eating ? 'leafkinSqueal' : `leafkinChatter${1 + Math.floor(this.rand() * CHATTERS)}`, x: g.x + r.x, y: g.y + r.y + r.size * CHEST, z: g.z + r.z })
    }
  }

  /** The ones walking, in world metres, for their footfalls (ambience.js herds): one record each, rewritten per call. */
  bodies(into) {
    const g = this.group.position
    for (const r of this.all) {
      if (r.state !== 'walk' && r.state !== 'leave' && !(r.state === 'court' && r.route.length > 0)) continue
      Object.assign(r.body, { x: g.x + r.x, y: g.y + r.y, z: g.z + r.z, speed: this.asset.gait.walk * r.k * r.pace })
      into.push(r.body)
    }
    return into
  }

  /** Their mutters since the last call, each `{ sound, x, y, z }` in world metres, drained. */
  voices(into) {
    for (const v of this.calls) into.push(v)
    this.calls.length = 0
    return into
  }

  _step(r, dt) {
    if (r.state === 'walk' || r.state === 'leave' || (r.state === 'court' && r.route.length > 0)) {
      const p = r.route[0]
      const dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz)
      const v = this.asset.gait.walk * r.k * r.pace
      if (d <= Math.max(NEAR_M, v * dt)) {
        r.x = p.x; r.z = p.z; r.y = p.y
        r.route.shift()
        if (r.route.length === 0) {
          if (r.state === 'leave') { r.puppet.show(-1, FADE_S); r.state = 'gone' }
          else if (r.state === 'court') { r.phase = 'wait'; r.voice = 0.5; this._play(r, 'idle', Infinity) }
          else { r.heading = this._stand(r, r.spot).heading; this._begin(r, false) }
        }
      } else {
        const t = (v * dt) / d
        r.x += dx * t; r.z += dz * t; r.y += (p.y - r.y) * t
        const want = Math.atan2(dx, dz)
        r.heading += Math.atan2(Math.sin(want - r.heading), Math.cos(want - r.heading)) * Math.min(1, TURN_RATE * dt)
      }
    } else if (r.state === 'act') {
      r.hold -= dt
      r.left -= dt
      if (r.spot.kind === 'talk' && r.partner) {
        const want = Math.atan2(r.partner.x - r.x, r.partner.z - r.z)
        r.heading += Math.atan2(Math.sin(want - r.heading), Math.cos(want - r.heading)) * Math.min(1, TURN_RATE * dt)
      }
      // Onto the seat or the bed and off again over the clip's own cuts, and up the bed while it lies back.
      const t = r.left === Infinity ? 1 : Math.max(0, Math.min(1, 1 - r.left / Math.max(1e-3, this._len(r))))
      if (r.phase === 'down') r.on = t
      else if (r.phase === 'up') r.on = 1 - t
      else if (r.phase === 'lie') r.slide = LIE_SLIDE * t
      else if (r.phase === 'rise') r.slide = LIE_SLIDE * (1 - t)
      if (r.left <= 0) this._next(r)
    } else if (r.state === 'cower' || r.state === 'court') {
      // Facing her: a cower whimpering (it stands still, so never panting), a court beckoning, chattering half the time.
      const want = Math.atan2(r.hx - r.x, r.hz - r.z)
      r.heading += Math.atan2(Math.sin(want - r.heading), Math.cos(want - r.heading)) * Math.min(1, TURN_RATE * dt)
      r.voice -= dt
      r.left -= dt
      if (r.state === 'cower') {
        if (r.voice <= 0) { r.voice = between(this.rand, COWER_WHIMPER_S); this._say(r, 'leafkinWhimper') }
        if (r.left <= 0) { const c = this.rand() < 0.25 ? 'recoil' : 'cower'; this._play(r, c, this.durations[c]) }
      } else {
        if (r.voice <= 0) {
          r.voice = between(this.rand, FUSS_S)
          if (this.rand() < 0.5) this._say(r, `leafkinChatter${1 + Math.floor(this.rand() * CHATTERS)}`)
          const b = BECKONS[Math.floor(this.rand() * BECKONS.length)]
          this._play(r, b, this.durations[b])
        }
        if (r.left <= 0) this._play(r, 'idle', Infinity)
      }
    } else if (r.state === 'gone') {
      r.puppet.step(dt)
      if (r.puppet.done) {
        r.puppet.group.removeFromParent()
        r.puppet.skeleton.dispose()
        this.all.splice(this.all.indexOf(r), 1)
      }
      return
    }
    this._draw(r, dt)
  }

  /** The whole length of the step playing, for its phase's ease. */
  _len(r) {
    if (r.phase === 'down') return SIT_CUT[0]
    if (r.phase === 'up') return this.durations.sit - SIT_CUT[1]
    if (r.phase === 'lie') return LIE_CUT[0]
    if (r.phase === 'rise') return this.durations.lie - LIE_CUT[1]
    return 1
  }

  _draw(r, dt) {
    const s = r.spot
    let x = r.x, y = r.y, z = r.z
    if (s && r.state === 'act' && (s.kind === 'seat' || s.kind === 'read' || s.kind === 'bed')) {
      y += r.on * (s.top - this.sitY * r.k - y)
      // Up the bed toward the pillow: backward from the way it faces.
      x -= Math.sin(r.heading) * r.slide
      z -= Math.cos(r.heading) * r.slide
    }
    const p = r.puppet
    p.play(r.clip, r.cue, r.from)
    p.step(dt)
    _pos.set(x, y, z)
    // The leafkin mesh looks down its +X (villagers.js walks along (cos h, -sin h)); a heading here looks along (sin h, cos h).
    _quat.setFromAxisAngle(UP, r.heading - Math.PI / 2)
    _scl.setScalar(r.k)
    p.group.matrix.compose(_pos, _quat, _scl)
    p.group.matrixWorldNeedsUpdate = true
    if (this.hands) this._carry(r)
  }

  /** A feast's mushroom in its fist, the one its villager carried in (villagers.js _carry), until it is eaten. */
  _carry(r) {
    if (!r.feast) {
      if (r.carrier !== null) { r.carrier.release(); r.carrier = null }
      return
    }
    if (r.carrier === null) {
      if (this.hands.carriers >= CARRIERS) return
      r.carrier = this.hands.carry(`resident:${r.id}`, r.size * CARRY_SPAN)
      r.carrier.add(this.mushrooms.record(hash32(this.seed, r.id, 0)), this.mushrooms)
    }
    if (!gripAt(r.puppet, _grip)) throw new Error('Residents: the leafkin has no right fist to hold its mushroom')
    _grip.add(this.group.position)
    r.carrier.grip(_grip.x, _grip.y, _grip.z, r.heading - Math.PI / 2)
  }

  dispose() {
    for (const r of this.all) { r.carrier?.release(); r.puppet.release(); r.puppet.skeleton.dispose() }
    this.group.removeFromParent()
    for (const m of this.materials) m.dispose()
  }
}
