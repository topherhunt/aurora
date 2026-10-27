// Chalk marks on cave walls (design/39-caves.md §8). Three-free.
//
// A stroke is `[system, id, player, points]`: `system` is its seed (caves/sites.js), `id` counts the player's strokes, `points` is base64 of int16 triples, QUANT_M a step, about the system's centre (x, z) and the cave's own y. Kept in the save (hers only), told to the room once, and taught to every client in it, like trust.js.

export const STEP_M = 0.03
export const QUANT_M = 0.02
// Points a stroke holds before the pen starts the next one; server/src/main.js CHALK_B64 is its base64 length.
export const STROKE_MAX = 200
// Strokes a message carries; server/src/main.js CHALK_BATCH.
export const BATCH = 8
// A pen that moves further than this between frames has left the wall: the stroke ends and a new one starts.
const JUMP_M = 0.25
const LIMIT = 32767
// The ribbon's half-width.
const HALF_M = 0.012
// Ribbons sit OFF_M out from the drawn surface; a stroke point further than SNAP_M from it is not on this cave.
export const OFF_M = 0.025
const SNAP_M = 0.6

export function encode(pts, ox, oz) {
  if (pts.length % 3 !== 0 || pts.length === 0 || pts.length > STROKE_MAX * 3) throw new Error(`chalk.encode: ${pts.length / 3} points`)
  const view = new DataView(new ArrayBuffer(pts.length * 2))
  for (let i = 0; i < pts.length; i++) {
    const q = Math.round((pts[i] - (i % 3 === 0 ? ox : i % 3 === 2 ? oz : 0)) / QUANT_M)
    if (q < -LIMIT || q > LIMIT) throw new Error(`chalk.encode: a point ${(q * QUANT_M).toFixed(0)} m from the system's centre`)
    view.setInt16(i * 2, q, true)
  }
  let s = ''
  for (let i = 0; i < view.byteLength; i++) s += String.fromCharCode(view.getUint8(i))
  return btoa(s)
}

export function decode(b64, ox, oz) {
  const s = atob(b64)
  const view = new DataView(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) view.setUint8(i, s.charCodeAt(i))
  const out = new Float32Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) * QUANT_M + (i % 3 === 0 ? ox : i % 3 === 2 ? oz : 0)
  return out
}

export function valid(t) {
  return Array.isArray(t) && t.length === 4 && Number.isInteger(t[0]) && t[0] >= 0 && t[0] < 2 ** 32 && Number.isInteger(t[1]) && t[1] >= 0 && t[1] < 2 ** 31 &&
    typeof t[2] === 'string' && /^[0-9a-z]{6,16}$/.test(t[2]) && typeof t[3] === 'string' && t[3].length > 0 && t[3].length % 8 === 0 && t[3].length <= STROKE_MAX * 8 && /^[A-Za-z0-9+/]+$/.test(t[3])
}

export class Chalk {
  /** `player()` is her saved game's player id (trust.js), read at each stroke. */
  constructor(player) {
    this.player = player
    this.known = new Map()
    // system -> { rev, list: entries, pts: decoded points by entry, origin }
    this.bySys = new Map()
    this.unsent = []
    this.next = 0
  }

  _sys(sys) {
    let s = this.bySys.get(sys)
    if (!s) this.bySys.set(sys, (s = { rev: 0, list: [], pts: new Map(), origin: null }))
    return s
  }

  _add(t) {
    if (!valid(t)) throw new Error(`Chalk: a malformed stroke ${JSON.stringify(t).slice(0, 120)}`)
    const key = `${t[2]} ${t[1]}`
    if (this.known.has(key)) return false
    this.known.set(key, t)
    const s = this._sys(t[0])
    s.list.push(t)
    s.rev++
    return true
  }

  /** Her stroke of cave-local points `pts` ([x, y, z, ...]) on system `sys`, centred on (ox, oz). */
  draw(sys, pts, ox, oz) {
    const t = [sys, this.next++, this.player(), encode(pts, ox, oz)]
    this._add(t)
    this.unsent.push(t)
    return t
  }

  merge(list) {
    for (const t of list) this._add(t)
  }

  /** The system's strokes as cave-local Float32Arrays, and a revision that moves when they change. */
  strokes(sys, ox, oz) {
    const s = this._sys(sys)
    if (s.origin === null || s.origin[0] !== ox || s.origin[1] !== oz) { s.origin = [ox, oz]; s.pts.clear() }
    const out = []
    for (const t of s.list) {
      let p = s.pts.get(t)
      if (!p) s.pts.set(t, (p = decode(t[3], ox, oz)))
      out.push(p)
    }
    return out
  }

  rev(sys) {
    return this._sys(sys).rev
  }

  /** Hers owed to the room again: a relay just welcomed her, and may have forgotten. */
  resend() {
    const me = this.player()
    this.unsent = [...this.known.values()].filter((t) => t[2] === me)
  }

  /** One BATCH of her owed strokes to `send`, if it takes it: a resend after a welcome trickles out a batch a frame. */
  flush(send) {
    if (this.unsent.length === 0) return
    const batch = this.unsent.slice(0, BATCH)
    if (send(batch)) this.unsent.splice(0, batch.length)
  }

  save() {
    const me = this.player()
    return { next: this.next, mine: [...this.known.values()].filter((t) => t[2] === me) }
  }

  load(doc) {
    if (!doc || !Number.isInteger(doc.next) || !Array.isArray(doc.mine)) throw new Error(`Chalk: a malformed save ${JSON.stringify(doc).slice(0, 120)}`)
    this.merge(doc.mine)
    this.next = Math.max(this.next, doc.next)
    this.resend()
  }

  /** A new game: her old self's strokes rubbed out, before trust.js forgets who she was. What the room taught of others is kept. */
  clear() {
    const me = this.player()
    for (const [key, t] of this.known) {
      if (t[2] !== me) continue
      this.known.delete(key)
      const s = this._sys(t[0])
      s.list.splice(s.list.indexOf(t), 1)
      s.rev++
    }
    this.next = 0
    this.unsent.length = 0
  }
}

/** One hand's line: surface points in, `onStroke(pts)` out each time a stroke is finished; `live` is the stroke being drawn. */
export class ChalkPen {
  constructor(onStroke) {
    this.onStroke = onStroke
    this.live = []
  }

  touch(x, y, z) {
    const p = this.live
    if (p.length === 0) { p.push(x, y, z); return }
    const n = p.length
    const lx = p[n - 3], ly = p[n - 2], lz = p[n - 1]
    const d = Math.hypot(x - lx, y - ly, z - lz)
    if (d > JUMP_M) { this.lift(); p.push(x, y, z); return }
    if (d < STEP_M) return
    const k = Math.floor(d / STEP_M)
    for (let i = 1; i <= k; i++) {
      const f = (i * STEP_M) / d
      p.push(lx + (x - lx) * f, ly + (y - ly) * f, lz + (z - lz) * f)
      if (p.length === STROKE_MAX * 3) {
        const tail = p.slice(-3)
        this.lift()
        p.push(...tail)
      }
    }
  }

  lift() {
    if (this.live.length > 0) this.onStroke(this.live.slice())
    this.live.length = 0
  }
}

// The field's gradient at (x, y, z): out of the rock is minus it.
function gradient(field, x, y, z, out) {
  const e = 0.02
  out[0] = field.at(x + e, y, z) - field.at(x - e, y, z)
  out[1] = field.at(x, y + e, z) - field.at(x, y - e, z)
  out[2] = field.at(x, y, z + e) - field.at(x, y, z - e)
  const l = Math.hypot(out[0], out[1], out[2])
  if (l < 1e-9) return 0
  out[0] /= l; out[1] /= l; out[2] /= l
  return l / (2 * e)
}

const _g = [0, 0, 0]
/**
 * The rock's surface nearest a point within `reach` of it, by two Newton steps on the field (positive in rock), into `out` as [x, y, z]; false when the point is further than `reach` out in the air, or a step would leap over a metre: where shape octaves fold the rock the field's gradient can flatten, and the step would land tens of metres off.
 */
export function onRock(field, x, y, z, reach, out) {
  if (field.at(x, y, z) < -reach) return false
  for (let i = 0; i < 2; i++) {
    const v = field.at(x, y, z)
    const len = gradient(field, x, y, z, _g)
    if (len === 0 || Math.abs(v) > len) return false
    x -= (_g[0] * v) / len; y -= (_g[1] * v) / len; z -= (_g[2] * v) / len
  }
  out[0] = x; out[1] = y; out[2] = z
  return true
}

/** The first rock along a ray within `maxDist`, marched on the field, into `out`; false if it meets none. */
export function rayRock(field, ox, oy, oz, dx, dy, dz, maxDist, out) {
  let t = 0
  while (t < maxDist) {
    const v = field.at(ox + dx * t, oy + dy * t, oz + dz * t)
    if (v > -0.004) return onRock(field, ox + dx * t, oy + dy * t, oz + dz * t, 0.05, out)
    t += Math.max(0.01, -v * 0.8)
  }
  return false
}

/**
 * Strokes as one ribbon each, laid OFF_M out from the drawn surface (surface.js) along its face normal: { position, normal, grain, index, skipped }. `grain` is (metres along, -1..1 across, a seed per stroke) for the shader's broken chalk; a one-point stroke is a dab.
 * A stroke with a point further than SNAP_M from the drawn surface is left out and counted in `skipped`: its chunk has not meshed yet, or the cave it was drawn on no longer exists.
 */
export function ribbons(strokes, surface) {
  const lifted = []
  const lift = [0, 0, 0, 0, 0, 0]
  let skipped = 0
  strokes.forEach((p, s) => {
    const pts = new Float32Array(p.length * 2)
    for (let k = 0; k < p.length / 3; k++) {
      if (!surface.lifted(p[k * 3], p[k * 3 + 1], p[k * 3 + 2], SNAP_M, OFF_M, lift)) { skipped++; return }
      pts.set(lift, k * 6)
    }
    lifted.push({ p, pts, s })
  })
  let verts = 0, tris = 0
  for (const { p } of lifted) { const n = Math.max(2, p.length / 3); verts += n * 2; tris += (n - 1) * 2 }
  const position = new Float32Array(verts * 3), normal = new Float32Array(verts * 3), grain = new Float32Array(verts * 3)
  const index = new Uint32Array(tris * 3)
  let v = 0, f = 0
  for (const { p, pts: lp, s } of lifted) {
    const seed = ((s * 0.618034) % 1) * 97
    const dab = p.length === 3
    const at = (k, c) => lp[(dab ? 0 : k) * 6 + c]
    const count = dab ? 2 : p.length / 3
    let along = 0
    for (let k = 0; k < count; k++) {
      const n = [at(k, 3), at(k, 4), at(k, 5)]
      const a = Math.max(0, k - 1), b = Math.min(count - 1, k + 1)
      let tx = at(b, 0) - at(a, 0), ty = at(b, 1) - at(a, 1), tz = at(b, 2) - at(a, 2)
      // A dab has no direction: any line across the wall.
      if (Math.hypot(tx, ty, tz) < 1e-6) { tx = Math.abs(n[1]) < 0.9 ? 0 : 1; ty = Math.abs(n[1]) < 0.9 ? 1 : 0; tz = 0 }
      let sx = n[1] * tz - n[2] * ty, sy = n[2] * tx - n[0] * tz, sz = n[0] * ty - n[1] * tx
      const sl = Math.hypot(sx, sy, sz) || 1
      const w = dab ? HALF_M * 1.5 : HALF_M
      sx *= w / sl; sy *= w / sl; sz *= w / sl
      if (k > 0) along += Math.hypot(at(k, 0) - at(k - 1, 0), at(k, 1) - at(k - 1, 1), at(k, 2) - at(k - 1, 2))
      const cx = at(k, 0), cy = at(k, 1), cz = at(k, 2)
      for (const side of [-1, 1]) {
        position.set([cx + sx * side, cy + sy * side, cz + sz * side], v * 3)
        normal.set(n, v * 3)
        grain.set([dab ? (k - 0.5) * 2 * w : along, side, seed], v * 3)
        v++
      }
      if (k > 0) {
        const i = v - 4
        index.set([i, i + 2, i + 1, i + 1, i + 2, i + 3], f)
        f += 6
      }
    }
  }
  return { position, normal, grain, index, skipped }
}
