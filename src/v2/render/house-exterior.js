// A leafkin house (design/36-leafkin-houses.md): a hollow oak stump on buttress roots with a splintered crown, a coursed leaf, shake or thatch roof, a plank door between the roots and round windows, rolled whole from a seed. Metres, floor centre at the origin, y up, the door facing +X. One geometry in the shared prop material's layout, plus one for the window and lantern glass.
import THREE from '../../three-instance.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { LAYER, TILE_METRES } from '../../textures.js'

const TAU = 2 * Math.PI

export const HOUSE_KINDS = {
  roof: ['cone', 'dome', 'tiers'],
  skin: ['leaf', 'shake', 'thatch'],
  doorShape: ['arch', 'round', 'pointed'],
  chimney: ['none', 'stone', 'pipe'],
  awning: ['leaf', 'hood', 'none'],
}

const TILE = { ...TILE_METRES, [LAYER.BARK]: 1.8, [LAYER.DIRT]: 1.2, [LAYER.IRON]: 0.6, [LAYER.MOSS]: 1.2, [LAYER.DOOR]: 1 }
const mat = (layer, tint, wet = 0) => ({ layer, tint, wet })
const MAT = {
  bark: mat(LAYER.BARK, [1.08, 0.9, 0.74], 1),
  wood: mat(LAYER.TIMBER_HEWN, [1.12, 1.0, 0.84]),
  stick: mat(LAYER.TIMBER_BEAM, [0.95, 0.82, 0.68]),
  door: mat(LAYER.DOOR, [1, 0.94, 0.86]),
  stone: mat(LAYER.STONE, [0.92, 0.9, 0.86], 1),
  iron: mat(LAYER.IRON, [0.42, 0.38, 0.34]),
  leaf: mat(LAYER.SHINGLE, [1.25, 0.95, 0.6]),
  shake: mat(LAYER.SHINGLE, [1.05, 0.95, 0.85]),
  thatch: mat(LAYER.THATCH, [1.0, 0.95, 0.85]),
  soffit: mat(LAYER.TIMBER_HEWN, [0.6, 0.52, 0.44]),
  tarp: mat(LAYER.PLASTER, [0.95, 0.6, 0.32]),
  straw: mat(LAYER.THATCH, [1.15, 1.05, 0.8]),
  clay: mat(LAYER.DIRT, [1.2, 0.86, 0.66]),
  fungus: mat(LAYER.PLASTER, [1.05, 0.82, 0.55]),
  stem: mat(LAYER.PLASTER, [1.1, 1.05, 0.95]),
  green: mat(LAYER.PLASTER, [0.45, 0.62, 0.3]),
  cone: mat(LAYER.BARK, [0.8, 0.6, 0.42]),
  bead: mat(LAYER.PLASTER, [1.0, 0.86, 0.62]),
  glow: mat(0, [1, 1, 1]),
}
const CAPS = [[1.25, 0.3, 0.22], [0.95, 0.62, 0.38], [1.15, 1.05, 0.9], [0.85, 0.4, 0.3]]
const DAMP = [0.55, 0.68, 0.42]

// --- roll ---------------------------------------------------------------------

const pickW = (rng, list, w) => {
  let x = rng() * w.reduce((a, b) => a + b, 0)
  for (let i = 0; i < list.length; i++) if ((x -= w[i]) < 0) return list[i]
  return list[list.length - 1]
}

/** Every choice a house makes, from `seed` at `height` (ground to roof tip). The bench's sliders edit this object; buildHouse reads nothing else. */
export function rollHouse(seed, height = 6) {
  const rng = mulberry32(seed * 7919 + 17)
  const r = (a, b) => a + (b - a) * rng()
  return {
    seed, height,
    girth: r(0.31, 0.39), // trunk radius at the floor, as a fraction of height
    trunk: r(0.44, 0.56), // trunk top, where the roof sits, as a fraction of height
    taper: r(-0.02, 0.22),
    belly: r(-0.04, 0.12),
    flare: r(0.15, 0.4),
    lean: rng() < 0.6 ? r(0.01, 0.06) : 0,
    leanDir: r(0, TAU),
    roots: 4 + Math.floor(rng() * 5),
    spires: pickW(rng, [0, 1, 2, 3], [3, 3, 3, 1]),
    spireH: r(0.14, 0.3),
    windows: 1 + Math.floor(rng() * (height < 5 ? 2 : 4)),
    winSize: r(0.22, 0.36),
    door: r(1.05, 1.35),
    doorWidth: r(0.62, 0.8),
    sill: r(0.18, 0.34),
    doorShape: pickW(rng, HOUSE_KINDS.doorShape, [4, 3, 2]),
    roof: pickW(rng, HOUSE_KINDS.roof, [5, 2, 2]),
    skin: pickW(rng, HOUSE_KINDS.skin, [4, 2, 2]),
    overhang: r(0.3, 0.7),
    droop: r(0.1, 0.35),
    concave: r(0.1, 0.65),
    bend: rng() < 0.5 ? r(0.02, 0.1) : 0,
    chimney: pickW(rng, HOUSE_KINDS.chimney, [4, 3, 3]),
    awning: pickW(rng, HOUSE_KINDS.awning, [4, 3, 2]),
    decor: r(0.35, 0.9),
    jitter: 1,
  }
}

// --- vector kit ---------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const lerp = (a, b, t) => a + (b - a) * t
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d }
const radial = (th) => [Math.cos(th), 0, Math.sin(th)]
const rot = (v, k, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v) * (1 - c), x = cross(k, v)
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d]
}
/** A frame { o, ax, ay, az } with ay along `up` and ax as near `out` as that allows. */
const basis = (o, out, up = [0, 1, 0]) => {
  const ay = norm(up), az = norm(cross(out, ay))
  return { o, ax: cross(ay, az), ay, az }
}
const tip = (F, key, ang) => { const k = F[key]; return { ...F, ax: rot(F.ax, k, ang), ay: rot(F.ay, k, ang), az: rot(F.az, k, ang) } }
const put = (F, x, y, z) => add(add(add(F.o, F.ax, x), F.ay, y), F.az, z)
const scaled = (F, s) => ({ ...F, ax: mul(F.ax, s[0]), ay: mul(F.ay, s[1]), az: mul(F.az, s[2]) })

/** Buffers plus a per-vertex outward hint that `tri` winds each face to. A vertex with no uv is box-projected at finish; a zero-area triangle is dropped, so a builder may collapse a row for free. */
class Mesher {
  constructor() { this.p = []; this.h = []; this.t = []; this.l = []; this.w = []; this.uv = []; this.idx = []; this.twins = [] }
  get count() { return this.p.length / 3 }
  v(p, hint, m, uv = null) {
    this.p.push(p[0], p[1], p[2]); this.h.push(hint[0], hint[1], hint[2])
    this.t.push(m.tint[0], m.tint[1], m.tint[2]); this.l.push(m.layer); this.w.push(m.wet)
    if (uv) this.uv.push(uv[0], uv[1]); else this.uv.push(NaN, NaN)
    return this.count - 1
  }
  tri(a, b, c) {
    const P = this.p, H = this.h, A = a * 3, B = b * 3, C = c * 3
    const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2]
    const vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    if (fx * fx + fy * fy + fz * fz < 1e-14) return
    if (fx * (H[A] + H[B] + H[C]) + fy * (H[A + 1] + H[B + 1] + H[C + 1]) + fz * (H[A + 2] + H[B + 2] + H[C + 2]) < 0) this.idx.push(a, c, b)
    else this.idx.push(a, b, c)
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d) }
  /** (ni+1) x (nj+1) points from `at(i, j)` -> [p, hint]. `wrap` closes column ni onto 0; with a `uv(i, j)` the seam column is emitted twice so the texture can wrap, and its normals are joined at finish. */
  grid(ni, nj, at, m, { wrap = false, uv = null, skip = null } = {}) {
    const cols = wrap && !uv ? ni : ni + 1, base = this.count
    for (let j = 0; j <= nj; j++) for (let i = 0; i < cols; i++) { const [p, h] = at(i, j); this.v(p, h, m, uv ? uv(i, j) : null) }
    if (wrap && uv) for (let j = 0; j <= nj; j++) this.twins.push([base + j * cols + ni, base + j * cols])
    for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
      if (skip && skip(i, j)) continue
      const i1 = cols === ni ? (i + 1) % ni : i + 1
      this.quad(base + j * cols + i, base + j * cols + i1, base + (j + 1) * cols + i1, base + (j + 1) * cols + i)
    }
    return base
  }
}

/** A profile [[r, y]], outward on its right as it climbs, turned about F's y axis between angles a0 and a1; `uv` wraps the texture round it instead of box-projecting. */
function lathe(m, F, prof, mt, { segs = 8, uv = false, a0 = 0, a1 = TAU } = {}) {
  const full = a1 - a0 >= TAU - 1e-9
  let len = 0
  const arc = prof.map((q, k) => (k ? (len += Math.hypot(q[0] - prof[k - 1][0], q[1] - prof[k - 1][1])) : 0))
  const rMax = Math.max(...prof.map((q) => q[0])), tile = TILE[mt.layer]
  m.grid(segs, prof.length - 1, (i, k) => {
    const q = a0 + (i / segs) * (a1 - a0), [r, y] = prof[k]
    const prev = prof[Math.max(0, k - 1)], next = prof[Math.min(prof.length - 1, k + 1)]
    const rad = add(mul(F.ax, Math.cos(q)), F.az, Math.sin(q))
    return [add(add(F.o, rad, r), F.ay, y), add(mul(F.ay, -(next[0] - prev[0])), rad, next[1] - prev[1])]
  }, mt, { wrap: full, uv: uv ? (i, k) => [((i / segs) * (a1 - a0) * rMax) / tile, arc[k] / tile] : null })
}

/** A tube through `pts` with per-point radii, its frame carried along by parallel transport; `flat` squashes it toward the transported horizontal. */
function tube(m, pts, radii, mt, { sides = 6, flat = 1 } = {}) {
  const n = pts.length
  let u = null
  const st = pts.map((c, k) => {
    const t = norm(sub(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)]))
    if (!u) { u = cross(t, [0, 1, 0]); if (dot(u, u) < 1e-6) u = [1, 0, 0] }
    u = norm(sub(u, mul(t, dot(u, t))))
    return { c, u, v: cross(u, t) }
  })
  m.grid(sides, n - 1, (i, k) => {
    const a = (i / sides) * TAU, S = st[k], r = radii[k]
    const off = add(mul(S.u, Math.cos(a) * r), S.v, Math.sin(a) * r * flat)
    return [add(S.c, off), off]
  }, mt, { wrap: true })
}

const OCT = 0.55
const RING8 = [[1, -OCT], [1, OCT], [OCT, 1], [-OCT, 1], [-1, OCT], [-1, -OCT], [-OCT, -1], [OCT, -1]]
const RING4 = [[1, -1], [1, 1], [-1, 1], [-1, -1]]
/** A block of half-sizes h about F's origin with chamfered uprights, a bevelled top and crooked corners. */
function block(m, rng, F, h, mt, { sides = 8, bevel = 0.04, crook = 0.02, bottom = false } = {}) {
  const ring = sides === 8 ? RING8 : RING4
  const jit = Array.from({ length: 8 }, () => [(rng() * 2 - 1) * crook, (rng() * 2 - 1) * crook * 0.5, (rng() * 2 - 1) * crook])
  const b = Math.min(bevel, h[0] * 0.5, h[1], h[2] * 0.5)
  const at = (x, y, z) => {
    const fx = (x / h[0] + 1) / 2, fy = (y / h[1] + 1) / 2, fz = (z / h[2] + 1) / 2
    let d = [0, 0, 0]
    for (let c = 0; c < 8; c++) d = add(d, jit[c], (c & 1 ? fx : 1 - fx) * (c & 2 ? fy : 1 - fy) * (c & 4 ? fz : 1 - fz))
    const p = put(F, x + d[0], y + d[1], z + d[2])
    return [p, sub(p, F.o)]
  }
  const rows = [[-h[1], 0], [h[1] - b, 0], [h[1], b]]
  const n = ring.length
  const base = m.grid(n, 2, (i, k) => at(ring[i][0] * (h[0] - rows[k][1]), rows[k][0], ring[i][1] * (h[2] - rows[k][1])), mt, { wrap: true })
  const fan = (row, y) => {
    const [p, hint] = at(0, y, 0)
    const c = m.v(p, hint, mt)
    for (let i = 0; i < n; i++) m.tri(c, base + row * n + i, base + row * n + ((i + 1) % n))
  }
  fan(2, h[1])
  if (bottom) fan(0, -h[1])
}

const PEBBLE = [[0, -1], [1, -0.25], [0.8, 0.55], [0, 1]]
const pebble = (m, rng, F, r, mt) => lathe(m, scaled(tip(F, 'ay', rng() * TAU), r), PEBBLE, mt, { segs: 5 })

/** A ring of radius R and tube radius r in F's ay/az plane. */
function torus(m, F, R, r, mt, { segs = 10, sides = 5 } = {}) {
  m.grid(segs, sides, (i, j) => {
    const a = (i / segs) * TAU, b = (j / sides) * TAU
    const d = add(mul(F.az, Math.cos(a)), F.ay, Math.sin(a))
    const off = add(mul(d, Math.cos(b) * r), F.ax, Math.sin(b) * r)
    return [add(add(F.o, d, R), off), off]
  }, mt, { wrap: true })
}

/** A cylinder along F's ay, its ends in a second material. */
function log(m, F, r, len, side, ends, segs = 7) {
  lathe(m, F, [[r, -len / 2], [r, len / 2]], side, { segs })
  lathe(m, F, [[0, -len / 2 - 0.004], [r, -len / 2 - 0.004]], ends, { segs })
  lathe(m, F, [[r, len / 2 + 0.004], [0, len / 2 + 0.004]], ends, { segs })
}

// --- openings -------------------------------------------------------------------

/** A closed outline [[lat, up]] with its foot at up = 0. */
function outline(shape, w, h, n = 22) {
  const hw = w / 2, pts = [[-hw, 0], [hw, 0]]
  if (shape === 'round') {
    // An egg cut flat at its foot: the sides bow out past the sill's width.
    const cy = h * 0.46, ry = h - cy, a0 = Math.asin(cy / ry)
    return Array.from({ length: n + 1 }, (_, k) => { const a = -a0 + ((Math.PI + 2 * a0) * k) / n; return [Math.cos(a) * hw * 1.25, cy + Math.sin(a) * ry] })
  }
  if (shape === 'circle') {
    const out = []
    for (let k = 0; k < n; k++) { const a = -Math.PI / 2 + (k / n) * TAU; out.push([Math.cos(a) * hw, hw + Math.sin(a) * hw]) }
    return out
  }
  if (shape === 'pointed') {
    const hs = Math.max(0.1, h - w * 0.85), half = Math.floor(n / 2)
    for (let k = 0; k <= half; k++) { const t = k / half; pts.push([hw * (1 - t * t), hs + (h - hs) * Math.sin((t * Math.PI) / 2)]) }
    for (let k = half - 1; k >= 0; k--) { const t = k / half; pts.push([-hw * (1 - t * t), hs + (h - hs) * Math.sin((t * Math.PI) / 2)]) }
    return pts
  }
  const hs = Math.max(0.05, h - hw)
  for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI; pts.push([Math.cos(a) * hw, hs + Math.sin(a) * hw]) }
  return pts
}

/** A proud jamb round `pts` from `back` (inside the wall) to `front`, `w` wide, rounded on its face. */
function rim(m, F, pts, mt, w, front, back) {
  const n = pts.length
  const cx = pts.reduce((s, p) => s + p[0], 0) / n, cy = pts.reduce((s, p) => s + p[1], 0) / n
  const nrm2 = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n]
    let d = [b[1] - a[1], -(b[0] - a[0])]
    const l = Math.hypot(d[0], d[1]) || 1
    d = [d[0] / l, d[1] / l]
    return d[0] * (p[0] - cx) + d[1] * (p[1] - cy) < 0 ? [-d[0], -d[1]] : d
  })
  const prof = [[0, back, -1, 0], [0, front * 0.75, -1, 0.5], [w * 0.5, front, 0, 1], [w, front * 0.75, 1, 0.5], [w, back, 1, 0]]
  m.grid(n, prof.length - 1, (i, j) => {
    const [s, d, hs, hd] = prof[j], p = pts[i], q = nrm2[i]
    const lat = p[0] + q[0] * s, up = p[1] + q[1] * s
    return [put(F, d, up, lat), add(add(mul(F.az, q[0] * hs), F.ay, q[1] * hs), F.ax, hd)]
  }, mt, { wrap: true })
}

/** `pts` filled by a fan at depth d, uv 0-1 over its bounds. */
function panel(m, F, pts, mt, d, w, h) {
  const uv = (p) => [(p[0] + w / 2) / w, p[1] / h]
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const c = m.v(put(F, d, cy, cx), F.ax, mt, uv([cx, cy]))
  const ids = pts.map((p) => m.v(put(F, d, p[1], p[0]), F.ax, mt, uv(p)))
  for (let i = 0; i < ids.length; i++) m.tri(c, ids[i], ids[(i + 1) % ids.length])
}

// --- the house --------------------------------------------------------------------

/** Geometry and contract for one rolled house. Every irregularity is drawn from the spec's seed, so a slider moves the house without reshuffling it. */
export function buildHouse(o) {
  const t0 = performance.now()
  const rngFor = (tag) => mulberry32(o.seed * 104729 + tag * 7919 + 3)
  const H = o.height, yT = o.trunk * H, R0 = o.girth * H
  const nWall = noise3(o.seed + 11)
  const m = new Mesher(), g = new Mesher()
  const lights = []

  // --- layout: door at 0, then chimney, windows, spires, roots round the rest
  const lay = rngFor(1)
  const openings = []
  const clear = (th, gap) => openings.every((q) => Math.abs(angDiff(th, q.th)) > gap + q.ha)
  const place = (gap, lo, hi) => {
    for (let k = 0; k < 24; k++) {
      const th = (lay() < 0.5 ? -1 : 1) * lerp(lo, hi, lay())
      if (clear(th, gap)) return th
    }
    return null
  }
  const sill = o.sill
  const droop = o.droop
  const doorH = Math.max(0.8, Math.min(o.door, yT - droop - sill - 0.25))
  const doorW = o.doorWidth
  openings.push({ kind: 'door', th: 0, yc: sill + doorH / 2, hw: doorW / 2 + 0.12, hh: doorH / 2 + 0.1, ha: (doorW / 2 + 0.3) / R0 })
  const chimTh = o.chimney === 'none' ? null : place(0.2, 1.3, 2.7)
  if (chimTh !== null) openings.push({ kind: 'chimney', th: chimTh, yc: yT / 2, hw: 0.3, hh: yT, ha: 0.35 / R0 })
  const wins = []
  for (let k = 0; k < o.windows; k++) {
    const r = o.winSize * lerp(0.8, 1.15, lay())
    const th = place(0.12, 0.85, Math.PI)
    if (th === null) break
    const lo = sill + 0.55 + r, hi = Math.max(lo, yT - droop - 0.3 - r)
    const yc = lerp(lo, hi, lay())
    const kind = lay() < 0.65 ? 'circle' : 'arch'
    const w = { th, yc, r, kind, sill: lay() < 0.5, hood: lay() < 0.35, straw: lay() < 0.4, cross: kind === 'arch' || lay() < 0.3 }
    wins.push(w)
    openings.push({ kind: 'window', th, yc, hw: r + 0.12, hh: r + 0.12, ha: (r + 0.2) / R0 })
  }
  const spireTh = []
  for (let k = 0; k < o.spires; k++) { const th = lay() * TAU; if (Math.abs(angDiff(th, 0)) > 0.5) spireTh.push(th) }
  const rootA = []
  const flank = lerp(0.55, 0.8, lay())
  rootA.push(flank, -flank)
  for (let k = 2; k < o.roots; k++) rootA.push(lerp(flank + 0.5, TAU - flank - 0.5, (k - 1.5 + (lay() - 0.5) * 0.6) / (o.roots - 2)))
  const rootAmp = rootA.map(() => lerp(0.18, 0.32, lay()))

  // --- the wall: one function every fixture reads, so nothing floats or sinks
  const baseR = (y) => { const t = Math.min(1, Math.max(0, y / yT)); return R0 * (1 - o.taper * t) * (1 + o.belly * Math.sin(Math.PI * t)) }
  const lean = (y) => mul(radial(o.leanDir), o.lean * H * Math.pow(Math.max(0, y) / yT, 2))
  const calm = (th, y) => {
    let c = 1
    for (const q of openings) {
      if (q.kind === 'chimney') continue
      const lat = Math.abs(angDiff(th, q.th)) * R0
      c = Math.min(c, 1 - (1 - smoothstep(q.hw, q.hw + 0.3, lat)) * (1 - smoothstep(q.hh, q.hh + 0.3, Math.abs(y - q.yc))))
    }
    return c
  }
  const wallR = (th, y, detail = true) => {
    const doorCalm = smoothstep(0.3, 0.7, Math.abs(angDiff(th, 0)))
    const yy = Math.max(y, 0)
    let s = 1 + o.flare * Math.exp(-yy / 0.45) * (1 + Math.max(0, -y) * 0.6) * lerp(0.25, 1, doorCalm)
    for (let k = 0; k < rootA.length; k++) { const d = angDiff(th, rootA[k]) / 0.3; s += rootAmp[k] * Math.exp(-d * d) * Math.exp(-yy / 0.9) }
    let r = baseR(y) * s
    if (detail) {
      const c = Math.cos(th), sn = Math.sin(th)
      r += calm(th, y) * R0 * (0.045 * nWall(c * 2.4, y * 0.3, sn * 2.4) + 0.022 * nWall(c * 7 + 5, y * 1.1, sn * 7))
    }
    return r
  }
  const wallPt = (th, y, out = 0) => add(lean(y), add(mul(radial(th), wallR(th, y) + out), [0, y, 0]))

  /** A frame on the wall at angle th spanning y0..y1 and lateral +-hw, flat in front of every point of the wall behind it; `back` is how deep a jamb must reach to meet the wall everywhere. */
  const openingFrame = (th, y0, y1, hw) => {
    const n = radial(th), lat = [-Math.sin(th), 0, Math.cos(th)]
    const row = (y) => {
      let hi = -Infinity, lo = Infinity
      for (const l of [-hw, -hw / 2, 0, hw / 2, hw]) {
        const a = th + l / R0, d = dot(add(lean(y), mul(radial(a), wallR(a, y, false))), n)
        hi = Math.max(hi, d); lo = Math.min(lo, d)
      }
      return [hi, lo]
    }
    const [b, bl] = row(y0), [t, tl] = row(y1), [mid, ml] = row((y0 + y1) / 2)
    const lift = Math.max(0, mid - (b + t) / 2) + 0.02
    const B = add(mul(n, b + lift), [0, y0, 0]), T = add(mul(n, t + lift), [0, y1, 0])
    const ay = norm(sub(T, B)), az = lat
    const F = { o: add(B, mul(lat, dot(lean(y0), lat))), ax: cross(ay, az), ay, az }
    return { F, back: -(Math.max(b, t, mid) - Math.min(bl, tl, ml)) - 0.1, len: Math.hypot(...sub(T, B)) }
  }

  // --- trunk
  const yB = -0.6
  const segs = Math.max(40, Math.min(72, Math.round((TAU * R0) / 0.2)))
  const rows = Math.ceil((yT - yB) / 0.22)
  const barkTile = TILE[LAYER.BARK]
  m.grid(segs, rows, (i, j) => {
    const th = (i / segs) * TAU, y = yB + ((yT - yB) * j) / rows
    return [wallPt(th, y), radial(th)]
  }, MAT.bark, { wrap: true, uv: (i, j) => [((i / segs) * TAU * R0) / barkTile, (yB + ((yT - yB) * j) / rows) / barkTile] })

  // --- roof profile, solved so it clears the trunk top where it crosses the wall
  const rT = baseR(yT), rE = rT + o.overhang, yA = H
  const bend = mul(radial(o.leanDir + 1.3), o.bend * H)
  const c = o.concave
  const tiers = (yE) => {
    const hR = yA - yE
    if (o.roof === 'dome') return [(s) => { const a = (s * Math.PI) / 2; return [rE * Math.cos(a), yE + hR * Math.pow(Math.sin(a), 0.85)] }]
    if (o.roof === 'tiers') return [
      (s) => [rE * (1 - 0.45 * s), yE + 0.4 * hR * s],
      (s) => [0.72 * rE * (1 - s), yE + 0.33 * hR + 0.67 * hR * ((1 - c) * s + c * s * s)],
    ]
    return [(s) => [rE * (1 - s), yE + hR * ((1 - c) * s + c * Math.pow(s, 2.2))]]
  }
  let yE = yT - droop
  for (let k = 0; k < 8; k++) {
    const f = tiers(yE)[0]
    let s = 0
    while (s < 1 && f(s)[0] > rT) s += 0.01
    const deficit = yT + 0.1 - f(s)[1]
    if (deficit <= 0.001) break
    yE += deficit
  }
  const profile = tiers(yE)
  const roofCentre = (y) => add(lean(yT), bend, Math.pow(Math.max(0, (y - yE) / (yA - yE)), 3))
  const roofY = (r) => Math.max(...profile.map((f) => { if (f(0)[0] <= r) return -Infinity; let s = 0; while (s < 1 && f(s)[0] > r) s += 0.01; return f(s)[1] }))

  // --- spires: jagged shell sectors carrying the trunk up through the roof
  const sp = rngFor(2)
  for (const th of spireTh) {
    const hw = lerp(0.12, 0.3, sp()), cols = Math.max(3, Math.round((2 * hw * R0) / 0.16))
    const top0 = roofY(rT) - yT + o.spireH * H * lerp(0.6, 1.2, sp())
    const peak = lerp(0.3, 0.7, sp())
    const tops = Array.from({ length: cols + 1 }, (_, i) => {
      const u = i / cols, env = 1 - Math.abs(u - peak) / Math.max(peak, 1 - peak)
      return yT + top0 * Math.pow(Math.max(0, env), 0.6) * lerp(0.55, 1.1, sp()) - 0.25 * (i === 0 || i === cols ? 1 : 0)
    })
    const th0 = th - hw, thick = Math.min(0.2, R0 * 0.1), y0 = yT - 0.35, nj = Math.max(2, Math.ceil(top0 / 0.25))
    const at = (i, j, inset) => {
      const a = th0 + (2 * hw * i) / cols, y = y0 + ((tops[i] - y0) * j) / nj, lift = Math.max(0, y - yT)
      return wallPt(a, y, -inset + 0.25 * R0 * Math.pow(lift / H, 2) * 4)
    }
    m.grid(cols, nj, (i, j) => [at(i, j, 0), radial(th0 + (2 * hw * i) / cols)], MAT.bark)
    m.grid(cols, nj, (i, j) => [at(i, j, thick), mul(radial(th0 + (2 * hw * i) / cols), -1)], MAT.wood)
    m.grid(cols, 1, (i, j) => [at(i, nj, j * thick), [0, 1, 0]], MAT.wood)
    for (const i of [0, cols]) m.grid(1, nj, (k, j) => [at(i, j, k * thick), mul([-Math.sin(th0 + (2 * hw * i) / cols), 0, Math.cos(th0 + (2 * hw * i) / cols)], i ? 1 : -1)], MAT.wood)
  }

  // --- roof courses
  const rr = rngFor(3)
  const skin = { leaf: { ch: 0.3, lip: 0.06, scal: 0.4, jit: 0.15, per: 3 }, shake: { ch: 0.36, lip: 0.05, scal: 0.08, jit: 0.3, per: 2 }, thatch: { ch: 0.7, lip: 0.13, scal: 0.12, jit: 0.35, per: 4 } }[o.skin]
  const skinMat = o.skin === 'leaf' ? MAT.leaf : o.skin === 'shake' ? MAT.shake : MAT.thatch
  const rSegs = skin.per * Math.max(12, Math.round((TAU * rE) / (0.2 * skin.per)))
  const roofTile = TILE[skinMat.layer]
  profile.forEach((f, tier) => {
    const N = 48, tab = [0]
    for (let k = 1; k <= N; k++) { const a = f((k - 1) / N), b = f(k / N); tab.push(tab[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])) }
    const L = tab[N]
    const sAt = (len) => { let k = 1; while (k < N && tab[k] < len) k++; return (k - 1 + (len - tab[k - 1]) / (tab[k] - tab[k - 1])) / N }
    const surf = (len) => {
      const l = Math.max(0, Math.min(L, len)), s = sAt(l), a = f(Math.max(0, s - 0.01)), b = f(Math.min(1, s + 0.01))
      const t = norm([b[0] - a[0], b[1] - a[1], 0]), p = f(s)
      return { r: p[0] + t[0] * (len - l), y: p[1] + t[1] * (len - l), n: [t[1], -t[0]], t }
    }
    const at = (th, len, off) => {
      const S = surf(len), r = Math.max(0, S.r + S.n[0] * off), y = S.y + S.n[1] * off
      return add(roofCentre(y), [Math.cos(th) * r, y, Math.sin(th) * r])
    }
    const nC = Math.max(2, Math.round(L / skin.ch)), ch = L / nC
    for (let k = 0; k < nC; k++) {
      const l0 = k * ch, l1 = Math.min(L, (k + 1) * ch + (k < nC - 1 ? ch * 0.2 : 0))
      const jit = Array.from({ length: rSegs }, () => rr())
      const drop = (i) => ch * (skin.scal * (0.5 + 0.5 * Math.cos((TAU * (i / skin.per + k * 0.5)))) + skin.jit * jit[i % rSegs])
      const tint = skinMat.tint.map((v, ci) => v * (1 + (rr() - 0.5) * (o.skin === 'leaf' ? [0.2, 0.3, 0.4][ci] : 0.12)))
      const cm = { ...skinMat, tint }
      const rMid = surf((l0 + l1) / 2).r, uv = (i, len) => [((i / rSegs) * TAU * Math.max(rMid, 0.3)) / roofTile, -len / roofTile]
      const face = (i, j) => { const th = (i / rSegs) * TAU; return j ? at(th, l1, 0.004) : at(th, l0 - drop(i), skin.lip) }
      const hint = (i, len) => { const S = surf(len), th = (i / rSegs) * TAU; return [Math.cos(th) * S.n[0], S.n[1], Math.sin(th) * S.n[0]] }
      m.grid(rSegs, 1, (i, j) => [face(i, j), hint(i, j ? l1 : l0)], cm, { wrap: true, uv: (i, j) => uv(i, j ? l1 : l0 - drop(i)) })
      m.grid(rSegs, 1, (i, j) => {
        const th = (i / rSegs) * TAU, S = surf(l0)
        const p = j ? at(th, l0 - drop(i), skin.lip) : at(th, l0 - drop(i) + skin.lip, -0.015)
        return [p, [Math.cos(th) * -S.t[0], -S.t[1], Math.sin(th) * -S.t[0]]]
      }, { ...cm, tint: tint.map((v) => v * 0.7) }, { wrap: true, uv: (i, j) => uv(i, l0 - drop(i) + (j ? 0 : skin.lip)) })
    }
    // Soffit: the eave's underside back into the trunk, or for an upper tier a disc over the tier below.
    const e = surf(-ch * skin.scal * 0.5)
    const rIn = tier === 0 ? rT * 0.9 : 0, yIn = tier === 0 ? yT - 0.12 : e.y - 0.05
    m.grid(rSegs, 1, (i, j) => {
      const th = (i / rSegs) * TAU, r = j ? rIn : e.r - 0.02, y = j ? yIn : e.y - 0.02
      return [add(roofCentre(y), [Math.cos(th) * r, y, Math.sin(th) * r]), [0, -1, 0]]
    }, MAT.soffit, { wrap: true })
  })
  // Finial: a crooked stalk off the apex.
  {
    const apex = add(roofCentre(yA), [0, yA - 0.05, 0]), dir = radial(rr() * TAU), len = lerp(0.25, 0.55, rr()) * Math.sqrt(H / 6)
    const pts = [0, 0.33, 0.66, 1].map((t) => add(apex, add(mul(dir, len * 0.5 * t * t), [0, len * t, 0])))
    tube(m, pts, [0.06, 0.045, 0.03, 0.012], MAT.stick, { sides: 5 })
  }

  // --- roots
  const ro = rngFor(4)
  rootA.forEach((a, k) => {
    const y0 = lerp(0.7, 1.3, ro()) * Math.sqrt(R0 / 2), L = lerp(0.6, 1.1, ro()) * Math.sqrt(R0 / 2), tw = (ro() - 0.5) * 0.4
    const r0 = R0 * lerp(0.14, 0.2, ro()) * (0.7 + rootAmp[k])
    const P0 = wallPt(a, y0, -r0 * 0.9), P1 = wallPt(a + tw * 0.3, 0.05, L * 0.25), P2 = wallPt(a + tw, -0.3, L)
    const n = 9, pts = [], radii = []
    for (let s = 0; s <= n; s++) {
      const t = s / n, u = 1 - t
      pts.push(add(add(mul(P0, u * u), P1, 2 * u * t), P2, t * t))
      radii.push(lerp(r0, 0.05, Math.pow(t, 0.9)))
    }
    tube(m, pts, radii, MAT.bark, { sides: 8, flat: 0.8 })
  })

  // --- door, jamb, steps, knocker
  const dr = rngFor(5)
  const D = openingFrame(0, sill, sill + doorH, doorW / 2 + 0.12)
  const dPts = outline(o.doorShape, doorW, doorH)
  panel(m, D.F, dPts, MAT.door, 0, doorW, doorH)
  rim(m, D.F, dPts, MAT.wood, 0.11, 0.08, D.back)
  const nSteps = Math.max(1, Math.round(sill / 0.14))
  for (let k = 0; k < nSteps; k++) {
    const top = (sill * (nSteps - k)) / (nSteps + 1) + 0.02, hx = 0.2 + k * 0.03
    const Fk = basis(add(D.F.o, [0.1 + hx + k * 0.3, (top - 0.2) / 2 - sill, (dr() - 0.5) * 0.06]), [1, 0, 0])
    block(m, dr, tip(Fk, 'ay', (dr() - 0.5) * 0.15), [hx, (top + 0.2) / 2, doorW / 2 + 0.14 + k * 0.07], MAT.stone, { crook: 0.03 })
  }
  const kn = basis(put(D.F, 0.03, doorH * 0.5, -doorW * 0.26), D.F.ax, D.F.ay)
  torus(m, { ...kn, o: put(kn, 0.012, -0.06, 0) }, 0.055, 0.011, MAT.iron)
  pebble(m, dr, kn, [0.025, 0.02, 0.025], MAT.iron)
  const doorTop = sill + doorH

  // --- awning
  const aw = rngFor(6)
  if (o.awning === 'leaf') {
    const len = lerp(0.9, 1.35, aw()) * Math.min(1, Math.sqrt(H / 5)), W = doorW + lerp(0.7, 1.1, aw())
    const y0 = Math.min(doorTop + 0.3, yE - 0.05), sag = lerp(0.15, 0.35, aw()), x0 = dot(D.F.o, [1, 0, 0]) - 0.15
    const leafAt = (u, v) => {
      const half = (W / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + 0.88 * v)), 0.6) * (1 + 0.06 * Math.sin(v * 31))
      return [x0 + v * len, y0 - sag * v * v - 0.18 * u * u * v + 0.04 * (1 - u * u), u * half]
    }
    m.grid(8, 8, (i, j) => [leafAt(i / 4 - 1, j / 8), [0, 1, 0]], MAT.tarp)
    tube(m, [0, 0.3, 0.6, 0.9, 1].map((v) => add(leafAt(0, v), [0, 0.02, 0])), [0.03, 0.025, 0.018, 0.01, 0.004], { ...MAT.tarp, tint: [0.7, 0.42, 0.22] }, { sides: 4 })
    for (const s of [-1, 1]) {
      const top = leafAt(s * 0.72, 0.82), foot = [top[0] + 0.05, -0.1, top[2] + s * 0.08]
      const mid = add(mul(add(top, foot), 0.5), [(aw() - 0.5) * 0.08, 0, (aw() - 0.5) * 0.08])
      tube(m, [foot, mid, top], [0.045, 0.04, 0.035], MAT.stick, { sides: 5 })
    }
  } else if (o.awning === 'hood') {
    const Fh = tip(basis(put(D.F, 0.28, doorH + 0.14, 0), D.F.ax, D.F.ay), 'az', -0.35)
    block(m, aw, Fh, [0.34, 0.035, doorW / 2 + 0.22], MAT.shake, { sides: 4, crook: 0.02 })
    for (const s of [-1, 1]) tube(m, [put(D.F, -0.02, doorH - 0.15, s * (doorW / 2 + 0.12)), put(D.F, 0.3, doorH + 0.05, s * (doorW / 2 + 0.12))], [0.03, 0.025], MAT.stick, { sides: 5 })
  }

  // --- windows
  const wr = rngFor(7)
  const windowsOut = []
  for (const w of wins) {
    const h = w.kind === 'arch' ? w.r * 2.3 : w.r * 2, width = w.kind === 'arch' ? w.r * 1.7 : w.r * 2
    const y0 = w.yc - h / 2
    const W = openingFrame(w.th, y0, y0 + h, width / 2 + 0.1)
    const pts = outline(w.kind, width, h, w.kind === 'circle' ? 18 : 14)
    rim(m, W.F, pts, wr() < 0.6 ? MAT.wood : MAT.bark, 0.09, 0.07, W.back)
    panel(g, W.F, pts, MAT.glow, 0.005, width, h)
    if (w.cross) {
      block(m, wr, basis(put(W.F, 0.02, h / 2, 0), W.F.ax, W.F.ay), [0.015, h / 2 - 0.01, 0.018], MAT.wood, { sides: 4, crook: 0 })
      block(m, wr, basis(put(W.F, 0.02, h * 0.45, 0), W.F.ax, W.F.ay), [0.015, 0.018, width / 2 - 0.01], MAT.wood, { sides: 4, crook: 0 })
    }
    if (w.sill) block(m, wr, basis(put(W.F, 0.06, -0.06, 0), W.F.ax, W.F.ay), [0.1, 0.035, width / 2 + 0.12], MAT.wood, { sides: 4, crook: 0.015 })
    if (w.hood) {
      const Fh = tip(basis(put(W.F, 0.16, h + 0.08, 0), W.F.ax, W.F.ay), 'az', -0.45)
      block(m, wr, Fh, [0.17, 0.025, width / 2 + 0.14], skinMat === MAT.thatch ? MAT.shake : skinMat, { sides: 4, crook: 0.02 })
    }
    if (w.straw) {
      const n = 13
      for (let k = 0; k < n; k++) {
        const a = Math.PI * (0.05 + (0.9 * k) / (n - 1)) + (wr() - 0.5) * 0.1, dir = [Math.cos(a), Math.sin(a)]
        const r0 = Math.max(width / 2, h / 2) + 0.06, r1 = r0 + lerp(0.1, 0.22, wr()), cy = w.kind === 'arch' ? h - width / 2 : h / 2
        const side = [-dir[1] * 0.035, dir[0] * 0.035]
        const q = [[r0, -1], [r0, 1], [r1, 1], [r1, -1]].map(([rad, s]) => put(W.F, 0.03 + (rad - r0) * 0.3, cy + dir[1] * rad + side[1] * s, dir[0] * rad + side[0] * s))
        const ids = q.map((p) => m.v(p, W.F.ax, MAT.straw))
        m.quad(ids[0], ids[1], ids[2], ids[3])
      }
    }
    const c = put(W.F, 0, h / 2, 0)
    windowsOut.push({ p: c, n: W.F.ax, r: Math.max(width, h) / 2 })
    lights.push({ kind: 'window', p: put(W.F, 0.25, h / 2, 0) })
  }

  // --- chimney
  const ch = rngFor(8)
  if (chimTh !== null) {
    const out = radial(chimTh)
    if (o.chimney === 'stone') {
      // Plumb, standing off the wall where it is widest below the eave so no block hangs in the air.
      const topY = Math.max(yE + 0.9, roofY(rT + 0.25) + 0.6)
      let dist = 0
      for (let y = 0.3; y < yE; y += 0.3) dist = Math.max(dist, dot(wallPt(chimTh, y), out))
      let y = -0.15
      while (y < topY) {
        const hh = lerp(0.11, 0.16, ch()), hs = lerp(0.32, 0.25, y / topY)
        const F = basis(add(mul(out, dist + hs * 0.4), [0, y + hh, 0]), out)
        block(m, ch, tip(F, 'ay', (ch() - 0.5) * 0.25), [hs, hh, hs * lerp(0.9, 1.1, ch())], MAT.stone, { crook: 0.025 })
        y += hh * 2 - 0.01
      }
      const capF = basis(add(mul(out, dist + 0.25 * 0.4), [0, y + 0.04, 0]), out)
      block(m, ch, capF, [0.33, 0.04, 0.33], MAT.stone, { crook: 0.02 })
      if (ch() < 0.45) hangLantern(put(capF, 0, 0.04, 0), 0.8)
    } else {
      const y0 = Math.min(yT * 0.65, yE - 0.4), reach = rE - rT + 0.3, topY = Math.max(yE + 0.8, roofY(rT) + 0.7)
      const base = wallPt(chimTh, y0, -0.1), elbow = wallPt(chimTh, y0 + 0.1, reach), up = add(elbow, [0, topY - y0, 0])
      const pts = [base, add(base, out, reach * 0.55), add(elbow, [0, 0.18, 0]), add(elbow, [0, 0.55, 0]), add(up, mul(out, (ch() - 0.5) * 0.2))]
      const pr = lerp(0.16, 0.2, ch())
      tube(m, pts, [pr * 1.25, pr, pr, pr, pr * 0.9], MAT.clay, { sides: 10 })
      const band = (p) => torus(m, { o: p, ax: [0, 1, 0], ay: out, az: [-out[2], 0, out[0]] }, pr * 1.02, 0.025, MAT.iron, { segs: 10, sides: 4 })
      for (let k = 1; k <= 3; k++) band(add(pts[3], sub(pts[4], pts[3]), k / 4))
      band(add(pts[4], [0, 0.02, 0]))
      const hat = basis(add(pts[4], [0, 0.14, 0]), out)
      lathe(m, hat, [[0, -0.03], [pr * 1.6, -0.06], [pr * 1.85, -0.02], [pr * 0.6, 0.12], [0, 0.22]], MAT.shake, { segs: 10 })
      tube(m, [add(pts[4], out, pr * 0.9), add(hat.o, out, pr * 1.2)], [0.02, 0.02], MAT.iron, { sides: 4 })
      tube(m, [add(pts[4], out, -pr * 0.9), add(hat.o, out, -pr * 1.2)], [0.02, 0.02], MAT.iron, { sides: 4 })
      tube(m, [wallPt(chimTh, y0 - 0.45, -0.05), add(elbow, [0, -0.08, 0])], [0.03, 0.025], MAT.stick, { sides: 4 })
    }
  }

  function hangLantern(p, s = 1) {
    const F = basis(p, [1, 0, 0])
    lathe(m, F, [[0, 0], [0.07 * s, 0], [0.07 * s, 0.02 * s]], MAT.iron, { segs: 6 })
    lathe(g, F, [[0.055 * s, 0.02 * s], [0.06 * s, 0.1 * s], [0.055 * s, 0.17 * s]], MAT.glow, { segs: 6, uv: true })
    lathe(m, F, [[0.08 * s, 0.17 * s], [0, 0.26 * s]], MAT.iron, { segs: 6 })
    lights.push({ kind: 'lantern', p: add(p, [0, 0.1 * s, 0]) })
  }

  // --- decor
  const de = rngFor(9)
  const spot = (lo, hi, gap = 0.15) => {
    for (let k = 0; k < 16; k++) {
      const th = de() * TAU, y = lerp(lo, hi, de())
      if (calm(th, y) > 0.99 && clear(th, gap) && Math.abs(angDiff(th, 0)) > 0.5) return { th, y }
    }
    return null
  }
  const ground = (th, out) => wallPt(th, 0, out)
  const DECOR = {
    fungi() {
      const s = spot(0.4, yT - 0.5)
      if (!s) return
      for (let k = 0, n = 2 + Math.floor(de() * 3); k < n; k++) {
        const th = s.th + (de() - 0.5) * 0.25, y = s.y + k * lerp(0.12, 0.2, de()), r = lerp(0.1, 0.2, de()) * Math.sqrt(R0 / 1.8)
        lathe(m, basis(wallPt(th, y, -0.03), radial(th)), [[0, -0.035], [r * 0.85, -0.03], [r, 0], [r * 0.7, 0.035], [0, 0.04]], MAT.fungus, { segs: 9 })
      }
    },
    mushrooms() {
      const th = rootA[Math.floor(de() * rootA.length)] + (de() - 0.5) * 0.4
      const cap = { ...MAT.fungus, tint: CAPS[Math.floor(de() * CAPS.length)] }
      for (let k = 0, n = 2 + Math.floor(de() * 4); k < n; k++) {
        const a = th + (de() - 0.5) * 0.35, F = tip(basis(ground(a, lerp(0.35, 0.9, de())), radial(a)), 'az', (de() - 0.5) * 0.3)
        const h = lerp(0.07, 0.2, de()), cr = lerp(0.05, 0.12, de())
        lathe(m, F, [[0.02, -0.05], [0.018, h]], MAT.stem, { segs: 5 })
        lathe(m, F, [[0, h], [cr * 0.8, h - 0.01], [cr, h + cr * 0.05], [cr * 0.75, h + cr * 0.6], [0, h + cr * 0.8]], cap, { segs: 7 })
      }
    },
    pinecones() {
      const a = de() * TAU
      if (Math.abs(angDiff(a, 0)) < 0.5) return
      for (let k = 0, n = 2 + Math.floor(de() * 3); k < n; k++) {
        const b = a + (de() - 0.5) * 0.3, F = tip(tip(basis(add(ground(b, lerp(0.25, 0.6, de())), [0, 0.05, 0]), radial(b)), 'ay', de() * TAU), 'az', 1.3)
        const L = lerp(0.12, 0.18, de()), prof = []
        for (let i = 0; i <= 6; i++) prof.push([i === 0 || i === 6 ? 0.005 : L * 0.35 * Math.sin((Math.PI * i) / 6) * (i % 2 ? 1 : 0.7), (L * i) / 6])
        lathe(m, F, prof, MAT.cone, { segs: 6 })
      }
    },
    woodpile() {
      const s = spot(0.3, 0.31, 0.3)
      if (!s) return
      const t = [-Math.sin(s.th), 0, Math.cos(s.th)]
      for (let row = 0; row < 3; row++) for (let k = 0; k < 4 - row; k++) {
        const r = 0.07, p = add(ground(s.th, 0.28), add(mul(t, (k - (3 - row) / 2) * r * 2.05), [0, r + row * r * 1.75, 0]))
        log(m, basis(p, radial(s.th), t), r * lerp(0.85, 1.1, de()), lerp(0.45, 0.6, de()), MAT.bark, MAT.wood)
      }
    },
    pot() {
      const s = spot(0.3, 0.31, 0.2)
      if (!s) return
      const F = basis(ground(s.th, lerp(0.25, 0.4, de())), radial(s.th)), k = lerp(0.8, 1.3, de())
      lathe(m, F, [[0, -0.02], [0.12 * k, -0.02], [0.17 * k, 0.12 * k], [0.12 * k, 0.24 * k], [0.13 * k, 0.28 * k], [0, 0.27 * k]], MAT.clay, { segs: 9 })
    },
    straw() {
      const s = spot(0.3, 0.31, 0.2)
      if (!s) return
      const hgt = lerp(0.6, 0.9, de()), foot = ground(s.th, 0.3), F = tip(basis(foot, radial(s.th)), 'az', 0.25)
      lathe(m, F, [[0, 0], [0.1, 0], [0.09, hgt * 0.6], [0.14, hgt], [0, hgt + 0.02]], MAT.straw, { segs: 7 })
      lathe(m, F, [[0.1, hgt * 0.45], [0.1, hgt * 0.53]], { ...MAT.stick, tint: [0.6, 0.45, 0.3] }, { segs: 7 })
    },
    garland() {
      const a = de() * TAU, b = a + lerp(0.5, 0.9, de()), y = yE - 0.02, rad = rE - 0.08
      const at = (t) => { const th = lerp(a, b, t); return add(roofCentre(y), [Math.cos(th) * rad, y - 0.35 * Math.sin(Math.PI * t) * (b - a) * rad * 0.6, Math.sin(th) * rad]) }
      const n = 12, pts = Array.from({ length: n + 1 }, (_, k) => at(k / n))
      tube(m, pts, pts.map(() => 0.008), MAT.stick, { sides: 3 })
      for (let k = 1; k < n; k++) {
        const bead = { ...MAT.bead, tint: [[1.0, 0.86, 0.62], [0.55, 0.38, 0.25], [1.15, 1.1, 1.0]][k % 3] }
        pebble(m, de, basis(add(pts[k], [0, -0.05, 0]), [1, 0, 0]), [0.035, 0.05, 0.035], bead)
      }
    },
    vine() {
      const th0 = de() * TAU
      if (Math.abs(angDiff(th0, 0)) < 0.6) return
      const turn = (de() - 0.5) * 1.6, top = yT - 0.3, n = 24, pts = []
      for (let k = 0; k <= n; k++) { const t = k / n; pts.push(wallPt(th0 + turn * t + 0.12 * Math.sin(t * 9), -0.1 + t * top, 0.03)) }
      tube(m, pts, pts.map((_, k) => lerp(0.03, 0.01, k / n)), { ...MAT.stick, tint: [0.55, 0.5, 0.32] }, { sides: 4 })
      for (let k = 2; k < n; k++) {
        const th = th0 + turn * (k / n), out = radial(th), side = (k % 2 ? 1 : -1)
        const L = lerp(0.12, 0.2, de()), t = [-Math.sin(th), 0, Math.cos(th)], d = norm(add(add(mul(t, side), [0, 0.5, 0]), out, 0.3))
        const p0 = pts[k], p2 = add(p0, d, L), mid = add(p0, d, L * 0.5), wide = mul(norm(cross(d, out)), L * 0.3)
        const ids = [p0, add(mid, wide), p2, add(mid, wide, -1)].map((p) => m.v(p, out, MAT.green))
        m.quad(ids[0], ids[1], ids[2], ids[3])
      }
    },
    lantern() {
      const s = de() < 0.5 ? -1 : 1, base = put(D.F, -0.05, doorH * 0.85, s * (doorW / 2 + 0.2)), arm = put(D.F, 0.3, doorH * 0.92, s * (doorW / 2 + 0.2))
      tube(m, [base, add(base, D.F.ax, 0.15), arm], [0.025, 0.02, 0.015], MAT.stick, { sides: 4 })
      hangLantern(add(arm, [0, -0.28, 0]))
    },
    stones() {
      if (o.skin === 'thatch') return
      for (let k = 0, n = 2 + Math.floor(de() * 4); k < n; k++) {
        const th = de() * TAU, r = lerp(rE * 0.6, rE * 0.9, de()), y = roofY(r) + 0.03
        pebble(m, de, basis(add(roofCentre(y), [Math.cos(th) * r, y, Math.sin(th) * r]), radial(th)), [0.14, 0.05, 0.11], MAT.stone)
      }
    },
  }
  const pool = ['fungi', 'fungi', 'mushrooms', 'mushrooms', 'pinecones', 'woodpile', 'pot', 'straw', 'garland', 'vine', 'lantern', 'stones']
  const decor = []
  for (let k = 0, n = Math.round(o.decor * 9); k < n; k++) {
    const kind = pool[Math.floor(de() * pool.length)]
    if (['woodpile', 'vine', 'lantern', 'garland'].includes(kind) && decor.includes(kind)) continue
    decor.push(kind)
    DECOR[kind]()
  }

  // --- finish
  const nA = noise3(o.seed), nB = noise3(o.seed + 101), nC = noise3(o.seed + 202)
  const amp = 0.035 * o.jitter
  const warp = (p) => {
    const [x, y, z] = p, l = 1 / 1.6
    return [x + amp * nA(x * l, y * l, z * l), y + 0.5 * amp * nB(x * l, y * l, z * l), z + amp * nC(x * l, y * l, z * l)]
  }
  const geometry = finish(m, warp, o.seed, false)
  const glow = finish(g, warp, o.seed, true)
  const pos = geometry.getAttribute('position')
  let reach = 0
  for (let i = 0; i < pos.count; i++) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)))
  const dc = warp(put(D.F, 0, 0, 0))
  return {
    geometry, glow, decor,
    door: { p: dc, n: D.F.ax, w: doorW, h: doorH, sill },
    windows: windowsOut.map((w) => ({ ...w, p: warp(w.p) })),
    lights: lights.map((l) => ({ ...l, p: warp(l.p) })),
    trunk: { r: R0, top: yT }, eave: { r: rE, y: yE }, reach, top: geometry.boundingBox.max.y,
    stats: { triangles: geometry.index.count / 3, glowTriangles: glow.index.count / 3, vertices: pos.count, ms: performance.now() - t0 },
  }
}

/** Smooth 3D value noise in [-1, 1]. */
function noise3(seed) {
  const hash = (x, y, z) => {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177)
    h = Math.imul(h ^ (h >>> 13), 1103515245)
    return ((h ^ (h >>> 16)) & 0xffff) / 32767.5 - 1
  }
  const f = (t) => t * t * (3 - 2 * t)
  return (x, y, z) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
    const fx = f(x - ix), fy = f(y - iy), fz = f(z - iz)
    let r = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      r += hash(ix + dx, iy + dy, iz + dz) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
    }
    return r
  }
}

/** Warp, normals, UVs, colour. A vertex without a uv is box-projected per TRIANGLE (split where two projections meet); the damp creeps up whatever is marked wet. The glow mesh keeps plain position/normal/uv. */
function finish(m, warp, seed, glow) {
  const nv = m.count
  const P = new Float32Array(nv * 3)
  for (let i = 0; i < nv; i++) P.set(warp([m.p[i * 3], m.p[i * 3 + 1], m.p[i * 3 + 2]]), i * 3)
  const I = m.idx, nt = I.length / 3, N = new Float32Array(nv * 3), FN = new Float32Array(nt * 3)
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2]
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2]
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx
    FN[t * 3] = fx; FN[t * 3 + 1] = fy; FN[t * 3 + 2] = fz
    for (let k = 0; k < 3; k++) { const o = I[t * 3 + k] * 3; N[o] += fx; N[o + 1] += fy; N[o + 2] += fz }
  }
  for (const [a, b] of m.twins) for (let c = 0; c < 3; c++) { const s = N[a * 3 + c] + N[b * 3 + c]; N[a * 3 + c] = s; N[b * 3 + c] = s }

  const nV = noise3(seed + 303)
  const cap = I.length, pos = new Float32Array(cap * 3), nrm = new Float32Array(cap * 3), uv = new Float32Array(cap * 2)
  const col = glow ? null : new Float32Array(cap * 3), lay = glow ? null : new Float32Array(cap), index = new Uint32Array(cap)
  const split = new Int32Array(nv * 4).fill(-1)
  let n = 0
  for (let t = 0; t < nt; t++) {
    const fx = Math.abs(FN[t * 3]), fy = Math.abs(FN[t * 3 + 1]), fz = Math.abs(FN[t * 3 + 2])
    const ax = fx >= fy && fx >= fz ? 0 : fy >= fz ? 1 : 2
    for (let k = 0; k < 3; k++) {
      const v = I[t * 3 + k], own = !Number.isNaN(m.uv[v * 2]), key = v * 4 + (own ? 3 : ax)
      let id = split[key]
      if (id < 0) {
        id = split[key] = n++
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]
        pos[id * 3] = x; pos[id * 3 + 1] = y; pos[id * 3 + 2] = z
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2], il = 1 / (Math.hypot(nx, ny, nz) || 1)
        nrm[id * 3] = nx * il; nrm[id * 3 + 1] = ny * il; nrm[id * 3 + 2] = nz * il
        if (own) { uv[id * 2] = m.uv[v * 2]; uv[id * 2 + 1] = m.uv[v * 2 + 1] } else {
          const tile = TILE[m.l[v]]
          if (!(tile > 0)) throw new Error(`house-exterior: no tile size for layer ${m.l[v]}`)
          uv[id * 2] = (ax === 0 ? z : x) / tile; uv[id * 2 + 1] = (ax === 1 ? z : y) / tile
        }
        if (!glow) {
          const vary = 1 + 0.1 * nV(x * 0.9, y * 0.9, z * 0.9)
          const wet = m.w[v] * smoothstep(1.1, -0.1, y) * 0.7
          for (let c = 0; c < 3; c++) col[id * 3 + c] = m.t[v * 3 + c] * vary * (1 - wet + wet * DAMP[c])
          lay[id] = m.l[v]
        }
      }
      index[t * 3 + k] = id
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, n * 3), 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nrm.slice(0, n * 3), 3))
  if (glow) g.setAttribute('uv', new THREE.BufferAttribute(uv.slice(0, n * 2), 2))
  else {
    g.setAttribute('uvProj', new THREE.BufferAttribute(uv.slice(0, n * 2), 2))
    g.setAttribute('texLayer', new THREE.BufferAttribute(lay.slice(0, n), 1))
    g.setAttribute('color', new THREE.BufferAttribute(col.slice(0, n * 3), 3))
  }
  g.setIndex(new THREE.BufferAttribute(n > 65535 ? index : Uint16Array.from(index), 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}
