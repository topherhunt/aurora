// The townsfolk at home in the house she has gone into (design/38-town-interiors.md): the house's own folk indoors (townsfolk.js, state 'inside'), each going between the room's places (rooms/town-interior.js `spots`) -- the potion master's counter, the table, the reading chair, the kitchen and the hearth, a window, a pair talking in the hall, a wander -- and upstairs to sleep. They walk navRoute's ways over the house's walking grid. Local to this client and stepped by the frame; residents.js is the leafkin's.

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet } from './baked-puppet.js'
import { residentLight, roomLit } from './residents.js'
import { TOWNSFOLK } from './townsfolk.js'
import { SIT, SIT_CUT, TALKS, TURN_RATE } from './villagers.js'
import { navRoute } from '../rooms/town-interior.js'

// The lie clip's hold between lying back and sitting up (tools/creatures/anim/clips/human/lie.json), and how far it shuffles up the bed as it lies.
const LIE_CUT = [1.7, 3.7]
const LIE_SLIDE = 0.4
const HOLD_S = { shop: [30, 70], seat: [20, 50], read: [25, 60], cook: [10, 25], gaze: [8, 20], bed: [40, 90], wander: [3, 8], talk: [10, 20] }
const PICK = [['seat', 0.25], ['read', 0.12], ['cook', 0.2], ['gaze', 0.1], ['bed', 0.12], ['wander', 0.13], ['talk', 0.08]]
const NEAR_M = 0.05
// Who keeps a `shop` spot: the potion master's counter, the innkeeper's bar.
const KEEPERS = ['alchemist', 'innkeeper'].map((b) => TOWNSFOLK.bodies.indexOf(b))
const FADE_S = 0.25

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const UP = new THREE.Vector3(0, 1, 0)
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scl = new THREE.Vector3()

export class TownResidents {
  /**
   * @param room     rollTownInterior's room, set down at (ox, oy, oz)
   * @param bodies   the townsfolk's loaded bodies (Townsfolk.bodies)
   * @param who      the house's folk indoors, `[{ id, body, size, pace }]`
   */
  constructor(scene, room, { bodies, who, seed, ox, oy, oz }) {
    if (!bodies) throw new Error('TownResidents: need the townsfolk\'s loaded bodies')
    this.room = room
    // Not `this.bodies`: that would shadow bodies(into), which ambience calls.
    this.kinds = bodies
    this.group = new THREE.Group()
    this.group.position.set(ox, oy, oz)
    scene.add(this.group)
    this.light = { value: new THREE.Vector3(1, 1, 1) }
    this.plain = bodies.map((b, i) => {
      const m = roomLit(makeSettledMaterial(`town-residents-${i}`), this.light)
      m.map = b.asset.map
      return m
    })
    this.materials = [...this.plain]
    this.rand = mulberry32(hash32(seed, room.index, 0x7e5))
    this.taken = new Map()
    this.all = []
    for (const w of who) this._add(w.id, w.body, w.size, w.pace, false)
    if (this.all.length >= 2 && this.rand() < 0.4 && room.spots.some((s) => s.kind === 'talk')) this._talk(this.all[0], this.all[1], true)
    for (const r of this.all) if (!r.spot) this._choose(r, true)
  }

  /** The house's folk indoors now, by id: one come in walks in at the door, one gone out walks to it and is gone. */
  sync(inside) {
    for (const r of this.all) if (typeof r.id === 'number' && !inside.has(r.id) && r.state !== 'leave' && r.state !== 'gone' && !r.leaving) this._leave(r)
    for (const [id, c] of inside) if (!this.all.some((r) => r.id === id)) this._add(id, c.body, c.size, c.pace, true)
  }

  _add(id, body, size, pace, atDoor) {
    const b = this.kinds[body]
    const mats = makePuppetMaterials(`town-residents-${body}`, this.plain[body])
    for (const m of [mats.in, mats.out]) roomLit(m, this.light).map = b.asset.map
    this.materials.push(mats.in, mats.out)
    const puppet = makePuppet(b.asset, mats, { clipFade: FADE_S })
    puppet.mixer.timeScale = pace
    this.group.add(puppet.group)
    puppet.show(0, atDoor ? FADE_S : 0.01)
    const d = this.room.doorIn
    const r = {
      id, kind: body, b, size, pace, k: size / b.height, puppet, x: d.x, z: d.z, y: 0, heading: Math.PI, level: 0,
      state: 'walk', spot: null, phase: '', hold: 0, clip: 'idle', from: -1, cue: 0, left: 0, route: [], slide: 0, on: 0, partner: null, leaving: false,
      body: { x: 0, y: 0, z: 0, size, speed: 0, clip: 'walk', cycle: b.durations.walk / pace },
    }
    this.all.push(r)
    if (atDoor) this._choose(r, false)
    return r
  }

  _play(r, clip, seconds, from = -1) {
    r.clip = clip
    r.left = seconds
    r.from = from
    r.cue++
  }

  _free(spot) { return !this.taken.has(spot) }

  /** Its next place: a keeper (KEEPERS) mostly to its counter, else by PICK among the free ones; `now` puts it there already at its hold. */
  _choose(r, now) {
    const room = this.room
    if (KEEPERS.includes(r.kind) && this.rand() < 0.7) {
      const shop = room.spots.find((s) => s.kind === 'shop' && this._free(s))
      if (shop) { this._goTo(r, shop, now); return }
    }
    for (let tries = 0; tries < 8; tries++) {
      let u = this.rand(), kind = PICK[PICK.length - 1][0]
      for (const [k, w] of PICK) { if (u < w) { kind = k; break } u -= w }
      if (kind === 'talk') {
        const other = this.all.find((o) => o !== r && o.state === 'act' && (o.spot.kind === 'wander' || o.spot.kind === 'gaze'))
        if (other && !now && room.spots.some((s) => s.kind === 'talk' && this._free(s))) { this._release(other); this._talk(r, other, false); return }
        continue
      }
      if (kind === 'wander') { this._goTo(r, this._roam(), now); return }
      const free = room.spots.filter((s) => s.kind === kind && this._free(s))
      if (free.length === 0) continue
      this._goTo(r, free[Math.floor(this.rand() * free.length)], now)
      return
    }
    this._goTo(r, this._roam(), now)
  }

  /** A random walkable cell of a random level, to stand at and look about. */
  _roam() {
    const n = this.room.nav
    const level = n.reach.length > 1 && this.rand() < 0.3 ? 1 : 0
    const reach = n.reach[level]
    for (;;) {
      const c = Math.floor(this.rand() * reach.length)
      if (!reach[c]) continue
      const a = this.rand() * Math.PI * 2
      return { kind: 'wander', x: n.X0 + ((c % n.nx) + 0.5) * n.cell, z: n.Z0 + (Math.floor(c / n.nx) + 0.5) * n.cell, lookX: Math.sin(a), lookZ: Math.cos(a), level }
    }
  }

  _talk(a, b, now) {
    const pair = this.room.spots.filter((s) => s.kind === 'talk')
    a.partner = b
    b.partner = a
    this._goTo(a, pair[0], now)
    this._goTo(b, pair[1], now)
  }

  _release(r) {
    if (r.spot) this.taken.delete(r.spot)
    r.spot = null
    r.on = 0
    r.slide = 0
  }

  /** Where its feet stand for `spot`, and which way it faces: a seat's and a bed's set back so the hips land on them (villagers.js SIT), the rest at the spot's own stand. */
  _stand(r, s) {
    const len = Math.hypot(s.lookX, s.lookZ)
    const ux = s.lookX / len, uz = s.lookZ / len
    if (s.kind === 'seat' || s.kind === 'read') {
      const fore = Math.max(SIT.back * r.b.wheelbase * r.k, s.r + SIT.clear)
      return { x: s.x + ux * fore, z: s.z + uz * fore, heading: Math.atan2(ux, uz) }
    }
    if (s.kind === 'bed') {
      // Sat on its foot end facing away from the pillow, so lying back puts the head on it.
      const fore = SIT.back * r.b.wheelbase * r.k
      const hx = s.x - ux * (s.len / 2 - 0.15), hz = s.z - uz * (s.len / 2 - 0.15)
      return { x: hx - ux * fore, z: hz - uz * fore, heading: Math.atan2(-ux, -uz) }
    }
    if (s.kind === 'wander') return { x: s.x, z: s.z, heading: Math.atan2(ux, uz) }
    return { x: s.standX, z: s.standZ, heading: Math.atan2(ux, uz) }
  }

  /** Off to `spot` over the walking grid, up or down the stair on the way; `now` sets it there at once. */
  _goTo(r, spot, now) {
    if (spot.kind !== 'wander') this.taken.set(spot, r)
    r.spot = spot
    const at = this._stand(r, spot)
    const y = this.room.nav.floors[spot.level]
    if (now) {
      r.x = at.x; r.z = at.z; r.y = y; r.heading = at.heading; r.level = spot.level
      this._begin(r, true)
      return
    }
    const route = navRoute(this.room, { x: r.x, z: r.z, level: r.level }, { x: at.x, z: at.z, level: spot.level })
    if (!route) throw new Error(`TownResidents: no way from (${r.x.toFixed(2)}, ${r.z.toFixed(2)}) on ${r.level} to a ${spot.kind} on ${spot.level} in house ${this.room.index}`)
    route.push({ x: at.x, y, z: at.z })
    r.route = route
    r.state = 'walk'
    r.level = spot.level
    this._play(r, 'walk', Infinity)
  }

  _begin(r, now) {
    r.state = 'act'
    const s = r.spot
    r.hold = between(this.rand, HOLD_S[s.kind])
    if (s.kind === 'seat' || s.kind === 'read' || s.kind === 'bed') {
      if (now) { r.phase = s.kind === 'bed' ? 'sleep' : 'hold'; r.on = 1; r.slide = s.kind === 'bed' ? LIE_SLIDE : 0; this._play(r, s.kind === 'bed' ? 'sleep' : 'idle-sit', r.hold) }
      else { r.phase = 'down'; this._play(r, 'sit', SIT_CUT[0], 0) }
    } else if (s.kind === 'cook' || s.kind === 'shop') {
      r.phase = 'busy'; this._play(r, 'gather', r.b.durations.gather, 0)
    } else if (s.kind === 'talk') {
      r.phase = 'talk'; this._play(r, TALKS[Math.floor(this.rand() * TALKS.length)], r.b.durations['talk-gesture'])
    } else {
      r.phase = 'stand'; this._play(r, 'idle', r.hold)
    }
  }

  _next(r) {
    const s = r.spot, d = r.b.durations
    switch (r.phase) {
      case 'down':
        if (s.kind === 'bed') { r.phase = 'lie'; this._play(r, 'lie', LIE_CUT[0], 0) }
        else { r.phase = 'hold'; this._play(r, s.kind === 'seat' && this.rand() < 0.6 ? 'eat' : 'idle-sit', Math.min(r.hold, 8)) }
        return
      case 'hold':
        if (r.hold > 0) { this._play(r, s.kind === 'seat' && this.rand() < 0.5 ? 'eat' : 'idle-sit', Math.min(r.hold, 8)); return }
        r.phase = 'up'; this._play(r, 'sit', d.sit - SIT_CUT[1], SIT_CUT[1]); return
      case 'lie': r.phase = 'sleep'; this._play(r, 'sleep', r.hold); return
      case 'sleep':
        if (r.hold > 0) { this._play(r, 'sleep', r.hold); return }
        r.phase = 'rise'; this._play(r, 'lie', d.lie - LIE_CUT[1], LIE_CUT[1]); return
      case 'rise': r.phase = 'up'; this._play(r, 'sit', d.sit - SIT_CUT[1], SIT_CUT[1]); return
      case 'busy':
        if (r.hold > 0) { this._play(r, this.rand() < 0.6 ? 'gather' : 'idle', this.rand() < 0.6 ? d.gather : 2, this.rand() < 0.5 ? 0 : -1); return }
        break
      case 'talk':
        if (r.hold > 0 && r.partner && r.partner.spot && r.partner.spot.kind === 'talk') { this._play(r, this.rand() < 0.4 ? 'idle' : TALKS[Math.floor(this.rand() * TALKS.length)], 1.5 + this.rand() * 1.5); return }
        break
      case 'stand':
        if (r.hold > 0) { this._play(r, 'idle', r.hold); return }
        break
      case 'up': break
      default: throw new Error(`TownResidents: no phase ${r.phase}`)
    }
    if (r.partner) { r.partner.partner = null; r.partner = null }
    this._release(r)
    this._choose(r, false)
  }

  /** Out: from a seat or a bed straight up, then to the door and gone. */
  _leave(r) {
    if (r.partner) { r.partner.partner = null; r.partner = null }
    if (r.state === 'act' && r.on > 0) {
      r.hold = 0
      r.leaving = true
      if (r.phase === 'lie' || r.phase === 'sleep') { r.phase = 'rise'; this._play(r, 'lie', r.b.durations.lie - LIE_CUT[1], LIE_CUT[1]) }
      else if (r.phase !== 'rise' && r.phase !== 'up') { r.phase = 'up'; this._play(r, 'sit', r.b.durations.sit - SIT_CUT[1], SIT_CUT[1]) }
      return
    }
    this._release(r)
    const d = this.room.doorIn
    this._goTo(r, { kind: 'wander', x: d.x, z: d.z, lookX: 0, lookZ: 1, level: 0 }, false)
    r.route.push({ x: d.x, y: 0, z: this.room.door.z - 0.25 })
    r.state = 'leave'
  }

  update(dt, view) {
    residentLight(view.uniforms, this.light.value)
    for (const r of this.all.slice()) this._step(r, dt)
  }

  /** The ones walking, in world metres, for their footfalls (ambience.js herds): one record each, rewritten per call. */
  bodies(into) {
    const g = this.group.position
    for (const r of this.all) {
      if (r.state !== 'walk' && r.state !== 'leave') continue
      Object.assign(r.body, { x: g.x + r.x, y: g.y + r.y, z: g.z + r.z, speed: r.b.gait.walk * r.k * r.pace })
      into.push(r.body)
    }
    return into
  }

  /** Nothing: the townsfolk have no voices yet. Here for main.js atHome, which drains whichever residents are in. */
  voices(into) { return into }

  _step(r, dt) {
    if (r.state === 'walk' || r.state === 'leave') {
      const p = r.route[0]
      const dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz)
      const v = r.b.gait.walk * r.k * r.pace
      if (d <= Math.max(NEAR_M, v * dt)) {
        r.x = p.x; r.z = p.z; r.y = p.y
        r.route.shift()
        if (r.route.length === 0) {
          if (r.state === 'leave') { r.puppet.show(-1, FADE_S); r.state = 'gone' }
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
      const t = r.left === Infinity ? 1 : Math.max(0, Math.min(1, 1 - r.left / Math.max(1e-3, this._len(r))))
      if (r.phase === 'down') r.on = t
      else if (r.phase === 'up') r.on = 1 - t
      else if (r.phase === 'lie') r.slide = LIE_SLIDE * t
      else if (r.phase === 'rise') r.slide = LIE_SLIDE * (1 - t)
      if (r.left <= 0) {
        if (r.leaving && r.phase === 'up') { r.leaving = false; r.on = 0; r.state = 'walk'; this._leave(r) }
        else this._next(r)
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

  _len(r) {
    const d = r.b.durations
    if (r.phase === 'down') return SIT_CUT[0]
    if (r.phase === 'up') return d.sit - SIT_CUT[1]
    if (r.phase === 'lie') return LIE_CUT[0]
    if (r.phase === 'rise') return d.lie - LIE_CUT[1]
    return 1
  }

  _draw(r, dt) {
    const s = r.spot
    let x = r.x, y = r.y, z = r.z
    if (s && r.state === 'act' && (s.kind === 'seat' || s.kind === 'read' || s.kind === 'bed')) {
      y += r.on * (s.top - r.b.sitY * r.k - y)
      x -= Math.sin(r.heading) * r.slide
      z -= Math.cos(r.heading) * r.slide
    }
    const p = r.puppet
    p.play(r.clip, r.cue, r.from)
    p.step(dt)
    _pos.set(x, y, z)
    // The townsfolk mesh looks down its +X (townsfolk.js walks along (cos h, -sin h)); a heading here looks along (sin h, cos h).
    _quat.setFromAxisAngle(UP, r.heading - Math.PI / 2)
    _scl.setScalar(r.k)
    p.group.matrix.compose(_pos, _quat, _scl)
    p.group.matrixWorldNeedsUpdate = true
  }

  dispose() {
    for (const r of this.all) { r.puppet.release(); r.puppet.skeleton.dispose() }
    this.group.removeFromParent()
    for (const m of this.materials) m.dispose()
  }
}
