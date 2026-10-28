// A pet or snowman following her keeps up: on her heels it goes as fast as she does, `over` her pace, and one `stallS` s further than `near` without closing `moveM` on her is warped to ground `backM` behind her that she cannot see, from a spot she cannot see either. Unseen is off her gaze by more than `deg`, or past `farM`. Past `m` she is out of its ken: never warped, and each layer has it give up following and stay where it is.
export const KEEP_UP = { m: 20, near: 6, stallS: 2, moveM: 0.5, over: 1.15, tau: 0.5, jumpM: 3, backM: [4, 6, 3], deg: 70, farM: 80, trail: 60, stillMps: 0.3 }

/** Her, as her followers keep up with her: her ground speed, her gaze, and the ground she walked since her last jump. One a frame from main.js. */
export class Her {
  constructor() {
    this.x = NaN
    this.z = NaN
    this.t = NaN
    this.speed = 0
    // When her speed was last past KEEP_UP.stillMps, or she last jumped.
    this.moved = -Infinity
    this.fx = 1
    this.fz = 0
    // Her last KEEP_UP.trail footfalls a metre apart, newest last: ground she stood on.
    this.trail = []
  }

  /** Her head at (x, z) at `now`, looking along (fx, fz). A step past KEEP_UP.jumpM in a frame is a teleport: no speed, and the trail starts again. */
  update(x, z, fx, fz, now) {
    const d = Math.hypot(x - this.x, z - this.z)
    const dt = now - this.t
    if (!(d <= KEEP_UP.jumpM)) this.trail.length = 0
    else if (dt > 0) this.speed += (d / dt - this.speed) * Math.min(1, dt / KEEP_UP.tau)
    if (!(d <= KEEP_UP.jumpM) || this.speed > KEEP_UP.stillMps) this.moved = now
    const last = this.trail[this.trail.length - 1]
    if (last === undefined || Math.hypot(x - last.x, z - last.z) >= 1) {
      if (this.trail.length === KEEP_UP.trail) this.trail.shift()
      this.trail.push({ x, z })
    }
    const f = Math.hypot(fx, fz)
    if (f > 1e-6) { this.fx = fx / f; this.fz = fz / f }
    this.x = x
    this.z = z
    this.t = now
  }

  /** A follower's speed whose own gait goes at `own`: KEEP_UP.over hers when that is the faster. */
  pace(own) { return Math.max(own, this.speed * KEEP_UP.over) }

  /** Seconds she has stood still at `now`. */
  stillFor(now) { return now - this.moved }

  /** Whether (x, z) is in her sight. */
  sees(x, z) {
    const dx = x - this.x, dz = z - this.z
    const d = Math.hypot(dx, dz)
    return d < KEEP_UP.farM && dx * this.fx + dz * this.fz > Math.cos((KEEP_UP.deg * Math.PI) / 180) * d
  }

  /** Ground KEEP_UP.backM behind her, out of her sight, that `stands(x, z)` takes: along her trail first, then straight back from her gaze; null for none. */
  behind(stands) {
    for (const m of KEEP_UP.backM) {
      for (let i = this.trail.length - 1; i >= 0; i--) {
        const p = this.trail[i]
        if (Math.hypot(p.x - this.x, p.z - this.z) < m) continue
        if (!this.sees(p.x, p.z) && stands(p.x, p.z)) return p
        break
      }
      const x = this.x - this.fx * m, z = this.z - this.fz * m
      if (!this.sees(x, z) && stands(x, z)) return { x, z }
    }
    return null
  }

  /**
   * Where a follower at (x, z) is warped to keep up, or null to walk on.
   * `way` is its own { d, t }: the nearest it has come to her since `t`;
   * `far` whether it is out of reach of her and should be closing. A warp
   * only ever brings it nearer.
   */
  keepUp(way, x, z, far, now, stands) {
    const d = Math.hypot(x - this.x, z - this.z)
    if (!far || d <= KEEP_UP.near || !(d > way.d - KEEP_UP.moveM)) { way.d = d; way.t = now }
    if (d > KEEP_UP.m || now - way.t <= KEEP_UP.stallS || this.sees(x, z)) return null
    const to = this.behind(stands)
    if (to === null || Math.hypot(to.x - this.x, to.z - this.z) >= d) return null
    way.d = Math.hypot(to.x - this.x, to.z - this.z)
    way.t = now
    return to
  }
}

/** A follower's headway mark, for Her.keepUp. */
export function headway() { return { d: NaN, t: 0 } }
