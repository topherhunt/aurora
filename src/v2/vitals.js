// Her health and her sleep (design/33-vitals.md): the rules, free of three.js so
// scripts/check-vitals.mjs can hold them to account. main.js wires them to the
// player, the HUD (render/vitals-hud.js), the relay and the save.
import { celestial, CLOCK } from '../clock.js'

export const MAX_HP = 100
// A fall up to `safeM` of her own metres (`riddenM` on a strider's back) is free; every metre past it costs `hpPerM`.
export const FALL = { safeM: 4, riddenM: 8, hpPerM: 10 }
export const fallDamage = (m, safe = FALL.safeM) => Math.round(Math.max(0, m - safe) * FALL.hpPerM)

export class Health {
  constructor() {
    this.hp = MAX_HP
  }

  get dead() {
    return this.hp <= 0
  }

  /** 0 from half health up, rising to 1 at death: what the veil and the heartbeat follow. */
  get hurt() {
    return Math.max(0, Math.min(1, 1 - this.hp / (MAX_HP / 2)))
  }

  /** Take `n`; true when it killed her. */
  harm(n) {
    if (this.dead || n <= 0) return false
    this.hp = Math.max(0, this.hp - n)
    return this.dead
  }

  heal() {
    this.hp = MAX_HP
  }
}

// Hours from `hour` to the sun's next crossing of the horizon, to the minute: what a room that all sleeps skips.
export function hoursToBoundary(hour, lat = CLOCK.latitude, dec = CLOCK.declination) {
  const up = celestial(hour, lat, dec).elevDeg > 0
  for (let m = 1; m <= 24 * 60; m++) {
    if (celestial(hour + m / 60, lat, dec).elevDeg > 0 !== up) return m / 60
  }
  throw new Error(`hoursToBoundary: the sun never crosses the horizon at latitude ${lat}, declination ${dec}`)
}

// The one client of a sleeping room that asks the relay for the skip: the lowest id, so exactly one asks.
// The relay grants it only once every client's pose says it sleeps, so the leader asks again until the room's clock moves.
export const leadsSleep = (selfId, peerIds) => [...peerIds].every((id) => selfId < id)

// A bed as she lies in it (a rooms/interior.js or rooms/town-interior.js spot 'bed', in world metres): her
// head over the pillow end, low over the mattress, face up. `bed` is { x, z,
// top, floor, yaw, len, wid }; `head` and `fwd` are world vectors; `scale` is hers.
export const LIE = { pillowIn: 0.5, pillowOut: 0.1, rise: 1.0, sink: 0.3, faceUp: 0.7 }
export function liesOn(bed, head, fwd, scale) {
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const dx = head.x - bed.x, dz = head.z - bed.z
  const along = dx * s + dz * c, across = dx * c - dz * s
  const hl = bed.len / 2
  const rise = (head.y - bed.top) / scale
  return Math.abs(across) < bed.wid / 2 && along > hl - LIE.pillowIn && along < hl + LIE.pillowOut &&
    rise < LIE.rise && rise > -LIE.sink && fwd.y > LIE.faceUp
}

/** Whether a peer's `head` (at the peer's `scale`) is in `bed`: over its mattress and low over it, whichever way it faces. */
export function inBed(bed, head, scale) {
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const dx = head.x - bed.x, dz = head.z - bed.z
  const rise = (head.y - bed.top) / scale
  return Math.abs(dx * c - dz * s) < bed.wid / 2 && Math.abs(dx * s + dz * c) < bed.len / 2 + LIE.pillowOut && rise < LIE.rise && rise > -LIE.sink
}

/** Whether her `feet` (world) are on `bed`: within `margin` of its outline, from its floor to a little over its mattress. Walking or teleporting there lays her in it. */
export function feetOnBed(bed, feet, margin) {
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const dx = feet.x - bed.x, dz = feet.z - bed.z
  const rise = feet.y - bed.floor
  return Math.abs(dx * c - dz * s) < bed.wid / 2 + margin && Math.abs(dx * s + dz * c) < bed.len / 2 + margin && rise > -0.15 && rise < bed.top - bed.floor + 0.3
}

/**
 * Where a load made in a house stands her: on a ring just off `bed`'s outline
 * (a rooms/interior.js spot, room-local with the room's middle at 0, 0),
 * nearest the middle of its side toward the room's middle -- a loft bed fills
 * its ledge, so there it is along the ledge past an end. The first spot where
 * `walk` (the house's WalkSurface, its room set down at `o`) has her on the
 * bed's own floor with room for her body; room-local, facing the bed.
 */
export function besideBed(bed, walk, o = { x: 0, y: 0, z: 0 }) {
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const inward = bed.x * c - bed.z * s > 0 ? -1 : 1
  const floor = o.y + bed.floor
  const ring = []
  for (const gap of [walk.radius + 0.03, walk.radius + 0.2]) {
    const hw = bed.wid / 2 + gap, hl = bed.len / 2 + gap
    for (let t = -1; t <= 1.001; t += 0.05) ring.push([inward * hw, t * hl], [-inward * hw, t * hl], [t * hw, -hl], [t * hw, hl])
  }
  const off = ([across, along]) => Math.hypot(across - (inward * bed.wid) / 2, along)
  ring.sort((p, q) => off(p) - off(q))
  for (const [across, along] of ring) {
    const x = bed.x + across * c + along * s, z = bed.z - across * s + along * c
    if (Math.abs(walk.heightAt(o.x + x, o.z + z, floor) - floor) < 0.01 && walk.fits(o.x + x, o.z + z, floor, null)) return { x, z, fx: bed.x - x, fz: bed.z - z }
  }
  throw new Error(`besideBed: nowhere to stand by the bed at ${bed.x.toFixed(2)}, ${bed.z.toFixed(2)}`)
}

// How far off, in her metres, a desktop click lays her in a bed.
export const BED_REACH_M = 3

/** How far along the ray (origin `o`, unit direction `d`) it enters the bed's box, from its floor to a pillow over its top; null on a miss. */
export function rayHitsBed(bed, o, d) {
  const s = Math.sin(bed.yaw), c = Math.cos(bed.yaw)
  const ox = o.x - bed.x, oz = o.z - bed.z
  const lo = [ -bed.wid / 2, bed.floor, -bed.len / 2 ], hi = [ bed.wid / 2, bed.top + 0.1, bed.len / 2 ]
  const p = [ox * c - oz * s, o.y, ox * s + oz * c], v = [d.x * c - d.z * s, d.y, d.x * s + d.z * c]
  let near = 0, far = Infinity
  for (let i = 0; i < 3; i++) {
    if (Math.abs(v[i]) < 1e-9) { if (p[i] < lo[i] || p[i] > hi[i]) return null; continue }
    const a = (lo[i] - p[i]) / v[i], b = (hi[i] - p[i]) / v[i]
    near = Math.max(near, Math.min(a, b))
    far = Math.min(far, Math.max(a, b))
  }
  return near <= far ? near : null
}

// awake -> lying (in bed, the stillness counting) -> closing (the lids coming
// down) -> asleep (black until she stirs) -> opening -> awake. Getting up from
// lying or closing is back to awake with the lids going up. `upS` is how long
// one laid in a bed lies awake once her lids are open before she stands.
export const SLEEP = { stillS: 5, closeS: 2.5, openS: 1.5, driftM: 0.15, turnDeg: 20, wakeM: 0.25, wakeDeg: 35, upS: 2 }

export class Sleep {
  constructor() {
    this.state = 'awake'
    this.lid = 0 // 0 open, 1 shut
    this.still = 0
    this._at = { x: 0, y: 0, z: 0 }
    this._fwd = { x: 0, y: 0, z: 0 }
  }

  get asleep() {
    return this.state === 'asleep'
  }

  _anchor(head, fwd) {
    Object.assign(this._at, { x: head.x, y: head.y, z: head.z })
    Object.assign(this._fwd, { x: fwd.x, y: fwd.y, z: fwd.z })
  }

  _turned(fwd) {
    const f = this._fwd
    const dot = (f.x * fwd.x + f.y * fwd.y + f.z * fwd.z) / Math.hypot(f.x, f.y, f.z) / Math.hypot(fwd.x, fwd.y, fwd.z)
    return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI
  }

  /**
   * One frame. `lying` is whether she is in a bed as liesOn has it (or, on a
   * desktop, has been laid in one), `press` whether any button went down this
   * frame. Returns 'asleep' on the frame she falls asleep, 'woke' on the frame
   * she stirs (the lids still shut), 'up' when she gets up before sleeping, else null.
   */
  update(dt, { lying, press, head, fwd, scale }) {
    let event = null
    const S = SLEEP
    if (this.state === 'awake' && lying && !press) {
      this.state = 'lying'
      this.still = 0
      this._anchor(head, fwd)
    } else if (this.state === 'lying' || this.state === 'closing') {
      if (!lying || press) {
        this.state = 'opening'
        event = 'up'
      } else if (Math.hypot(head.x - this._at.x, head.y - this._at.y, head.z - this._at.z) > S.driftM * scale || this._turned(fwd) > S.turnDeg) {
        this.state = 'lying'
        this.still = 0
        this._anchor(head, fwd)
      } else if ((this.still += dt) >= S.stillS) {
        this.state = 'closing'
      }
    } else if (this.state === 'asleep') {
      if (press || Math.abs(head.y - this._at.y) > S.wakeM * scale || this._turned(fwd) > S.wakeDeg) {
        this.state = 'opening'
        event = 'woke'
      }
    }
    if (this.state === 'closing') {
      this.lid = Math.min(1, this.lid + dt / S.closeS)
      if (this.lid === 1) {
        this.state = 'asleep'
        this._anchor(head, fwd)
        event = 'asleep'
      }
    } else if (this.state !== 'asleep') {
      this.lid = Math.max(0, this.lid - dt / S.openS)
      if (this.state === 'opening' && this.lid === 0) this.state = 'awake'
    }
    return event
  }
}
