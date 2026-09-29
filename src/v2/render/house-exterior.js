// A leafkin house (design/36-leafkin-houses.md): a hollow oak stump on lobed buttress feet, splintered shards or a hollow tower through one lumpy mound of leaf, shake or thatch, a plank door and honeycomb windows, rolled whole from a seed. Metres, floor centre at the origin, y up, the door facing +X. One geometry in the shared prop material's layout, plus one for the window and lantern glass.
import THREE from '../../three-instance.js'
import { mulberry32, smoothstep } from '../../sim/mathx.js'
import { LAYER, TILE_METRES } from '../../textures.js'

const TAU = 2 * Math.PI

export const HOUSE_KINDS = {
  skin: ['leaf', 'shake', 'thatch'],
  crown: ['shards', 'tower'],
  doorShape: ['arch', 'round', 'pointed'],
  transom: ['none', 'round'],
  chimney: ['none', 'stone', 'pipe'],
  awning: ['leaf', 'hood', 'none'],
}

const TILE = { ...TILE_METRES, [LAYER.BARK]: 1.8, [LAYER.DIRT]: 1.2, [LAYER.IRON]: 0.6, [LAYER.MOSS]: 1.2, [LAYER.DOOR]: 1, [LAYER.ROOF_LEAF]: 1.4 }
const mat = (layer, tint, wet = 0) => ({ layer, tint, wet })
const MAT = {
  bark: mat(LAYER.BARK, [1.08, 0.9, 0.74], 1),
  wood: mat(LAYER.TIMBER_HEWN, [1.12, 1.0, 0.84]),
  dark: mat(LAYER.TIMBER_HEWN, [0.5, 0.42, 0.36]),
  stick: mat(LAYER.TIMBER_BEAM, [0.95, 0.82, 0.68]),
  door: mat(LAYER.DOOR, [1, 0.94, 0.86]),
  stone: mat(LAYER.STONE, [0.92, 0.9, 0.86], 1),
  iron: mat(LAYER.IRON, [0.42, 0.38, 0.34]),
  leaf: mat(LAYER.ROOF_LEAF, [1, 1, 1]),
  shake: mat(LAYER.SHINGLE, [1.05, 0.95, 0.85]),
  thatch: mat(LAYER.THATCH, [1.0, 0.95, 0.85]),
  tarp: mat(LAYER.PLASTER, [0.95, 0.6, 0.32]),
  straw: mat(LAYER.THATCH, [1.15, 1.05, 0.8]),
  rope: mat(LAYER.TIMBER_BEAM, [0.9, 0.78, 0.55]),
  vine: mat(LAYER.BARK, [0.8, 0.72, 0.5]),
  ivy: mat(LAYER.IVY_LEAF, [1, 1, 1]),
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
    girth: r(0.29, 0.36), // trunk radius at the floor, as a fraction of height
    trunk: r(0.44, 0.56), // trunk top, where the roof sits, as a fraction of height
    taper: r(-0.02, 0.22),
    belly: r(-0.04, 0.12),
    flare: r(0.08, 0.25),
    lobes: 3 + Math.floor(rng() * 6),
    lobeReach: r(0.3, 0.8), // how far a buttress lobe juts at the ground, as a fraction of the trunk radius
    lean: rng() < 0.6 ? r(0.01, 0.06) : 0,
    leanDir: r(0, TAU),
    spires: pickW(rng, [0, 1, 2, 3], [2, 3, 3, 2]),
    spireH: r(0.14, 0.3),
    crown: pickW(rng, HOUSE_KINDS.crown, [3, 2]),
    windows: 1 + Math.floor(rng() * (height < 5 ? 2 : 4)),
    winSize: r(0.22, 0.36),
    door: r(1.05, 1.35),
    doorWidth: r(0.62, 0.8),
    sill: r(0.18, 0.34),
    doorShape: pickW(rng, HOUSE_KINDS.doorShape, [4, 3, 2]),
    transom: pickW(rng, HOUSE_KINDS.transom, [3, 2]),
    skin: pickW(rng, HOUSE_KINDS.skin, [5, 3, 2]),
    overhang: r(0.35, 0.75),
    droop: r(0.1, 0.35),
    swell: r(1.15, 2.4), // roof profile exponent: near 1 a cone, past 2 a dome
    lump: r(0.08, 0.2),
    tilt: r(0.05, 0.25),
    bend: rng() < 0.6 ? r(0.02, 0.1) : 0,
    chimney: pickW(rng, HOUSE_KINDS.chimney, [4, 3, 3]),
    awning: pickW(rng, HOUSE_KINDS.awning, [4, 3, 2]),
    decor: r(0.45, 1),
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
const jit = (rng, J) => (rng() * 2 - 1) * J
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
  const jitC = Array.from({ length: 8 }, () => [jit(rng, crook), jit(rng, crook * 0.5), jit(rng, crook)])
  const b = Math.min(bevel, h[0] * 0.5, h[1], h[2] * 0.5)
  const at = (x, y, z) => {
    const fx = (x / h[0] + 1) / 2, fy = (y / h[1] + 1) / 2, fz = (z / h[2] + 1) / 2
    let d = [0, 0, 0]
    for (let c = 0; c < 8; c++) d = add(d, jitC[c], (c & 1 ? fx : 1 - fx) * (c & 2 ? fy : 1 - fy) * (c & 4 ? fz : 1 - fz))
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

/** A rough board out of F along ax, `d` deep and 2hy thick, its half-width along az flaring from zb at the wall to zf at its front edge, every vertex jittered by up to J. */
function slab(m, rng, F, d, hy, zb, zf, mt, J, nz = 4) {
  const sec = [[0, -hy], [d, -hy], [d, hy], [0, hy]]
  const base = m.grid(4, nz, (i, k) => {
    const [x, y] = sec[i], s = -1 + (2 * k) / nz
    return [put(F, x + jit(rng, J), y + jit(rng, J * 0.5), s * lerp(zb, zf, x / d) + jit(rng, J)), add(add(mul(F.ax, x - d / 2), F.ay, y), F.az, s * zb)]
  }, mt, { wrap: true })
  for (const k of [0, nz]) { const r = base + k * 4; m.tri(r, r + 1, r + 2); m.tri(r, r + 2, r + 3) }
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

/** A pinecone of length L up F's ay. */
function pinecone(m, F, L) {
  const prof = []
  for (let i = 0; i <= 6; i++) prof.push([i === 0 || i === 6 ? 0.005 : L * 0.35 * Math.sin((Math.PI * i) / 6) * (i % 2 ? 1 : 0.7), (L * i) / 6])
  lathe(m, F, prof, MAT.cone, { segs: 6 })
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

/** `pts` turned by up to +-ang about (0, cy) and stretched a few percent, so no two openings are square. */
function skew(pts, rng, ang, cy) {
  const a = jit(rng, ang), c = Math.cos(a), s = Math.sin(a), k = 1 + jit(rng, 0.05)
  return pts.map(([x, y]) => [(x * c - (y - cy) * s) * k, cy + x * s + (y - cy) * c])
}

/** A rough-hewn jamb round `pts` from `back` (inside the wall) to `front`: about `w` wide on its face and flaring wider where it meets the wall, its width and every vertex jittered by up to J. The inner edge only ever moves inward, so no wall shows between the frame and what it frames. */
function rim(m, rng, F, pts, mt, w, front, back, J) {
  const n = pts.length
  const cx = pts.reduce((s, p) => s + p[0], 0) / n, cy = pts.reduce((s, p) => s + p[1], 0) / n
  const nrm2 = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n]
    let d = [b[1] - a[1], -(b[0] - a[0])]
    const l = Math.hypot(d[0], d[1]) || 1
    d = [d[0] / l, d[1] / l]
    return d[0] * (p[0] - cx) + d[1] * (p[1] - cy) < 0 ? [-d[0], -d[1]] : d
  })
  const wide = pts.map(() => w * lerp(0.75, 1.3, rng()))
  const prof = [[0, back, -1, 0], [0, front * 0.75, -1, 0.5], [0.5, front, 0, 1], [1, front * 0.6, 1, 0.5], [1.6, back, 1, 0]]
  m.grid(n, prof.length - 1, (i, j) => {
    const [s, d, hs, hd] = prof[j], p = pts[i], q = nrm2[i]
    const o = j < 2 ? -rng() * J : s * wide[i] + jit(rng, J), t = j < 2 ? 0 : jit(rng, J * 0.6)
    const lat = p[0] + q[0] * o - q[1] * t, up = p[1] + q[1] * o + q[0] * t
    return [put(F, d + (j === 2 || j === 3 ? jit(rng, J) : 0), up, lat), add(add(mul(F.az, q[0] * hs), F.ay, q[1] * hs), F.ax, hd)]
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

/** A window's [width, height] for its kind and radius. */
const winDims = (kind, r) => (kind === 'arch' ? [r * 1.7, r * 2.3] : [r * 2, r * 2])

// --- the house --------------------------------------------------------------------

/** Geometry and contract for one rolled house. Every irregularity is drawn from the spec's seed, so a slider moves the house without reshuffling it. */
export function buildHouse(o) {
  const t0 = performance.now()
  const rngFor = (tag) => mulberry32(o.seed * 104729 + tag * 7919 + 3)
  const H = o.height, yT = o.trunk * H, R0 = o.girth * H
  const nWall = noise3(o.seed + 11), nRoof = noise3(o.seed + 23), nSpire = noise3(o.seed + 41)
  const m = new Mesher(), g = new Mesher()
  const lights = [], wr = rngFor(7)

  const baseR = (y) => { const t = Math.min(1, Math.max(0, y / yT)); return R0 * (1 - o.taper * t) * (1 + o.belly * Math.sin(Math.PI * t)) }
  const lean = (y) => mul(radial(o.leanDir), o.lean * H * Math.pow(Math.max(0, y) / yT, 2))

  // --- the roof mound (§Roof): an eave [r, y] per angle, and roofAt(θ, u) from the eave (u 0) to the apex (u 1)
  const rr = rngFor(3)
  const rT = baseR(yT) * 1.08 + 0.05, yA = H, k = o.swell
  const tiltDir = rr() * TAU, tilt = o.tilt * Math.sqrt(H / 6)
  const bend = mul(radial(o.leanDir + 1.3), o.bend * H)
  const clearY = yT + 0.12 + o.lump * (yA - yT) * 0.5
  // The eave never rises above the trunk top (that would open a slot into the stump); where the mound then could not clear the wall, the eave reaches wider instead.
  const eave = (th) => {
    const c = Math.cos(th), s = Math.sin(th)
    const y = Math.min(yT - 0.02, yT - o.droop + tilt * Math.cos(th - tiltDir) + 0.12 * nRoof(c * 2 + 7, 1.5, s * 2))
    const need = (clearY - y) / (yA - y)
    return [Math.max((rT + o.overhang) * (1 + 0.12 * nRoof(c * 1.4, 0.5, s * 1.4)), rT / Math.pow(1 - need, 1 / k)), y]
  }
  const roofAt = (th, u) => {
    const c = Math.cos(th), s = Math.sin(th), [eR, eY] = eave(th), w = Math.sin(Math.PI * Math.min(1, Math.max(0, u)))
    const r = eR * (1 - u) * (1 + o.lump * 0.6 * w * nRoof(c * 1.8, u * 2.2 + 3, s * 1.8))
    const y = eY + (yA - eY) * (1 - Math.pow(1 - u, k)) + o.lump * (yA - yT) * w * nRoof(c * 1.5 + 11, u * 2, s * 1.5)
    const C = add(lean(yT), bend, u * u)
    return [C[0] + c * r, y, C[2] + s * r]
  }
  const roofY = (th, r) => roofAt(th, Math.min(1, Math.max(0, 1 - r / eave(th)[0])))[1]

  // --- layout: door at 0, then chimney, windows, spires, lobes round the rest
  const lay = rngFor(1)
  const openings = []
  const clear = (th, gap) => openings.every((q) => Math.abs(angDiff(th, q.th)) > gap + q.ha)
  const place = (gap, lo, hi) => {
    for (let n = 0; n < 24; n++) {
      const th = (lay() < 0.5 ? -1 : 1) * lerp(lo, hi, lay())
      if (clear(th, gap)) return th
    }
    return null
  }
  const sill = o.sill, eaveDoor = eave(0)[1]
  const doorH = Math.max(0.8, Math.min(o.door, eaveDoor - sill - 0.35))
  const doorW = o.doorWidth, doorTop = sill + doorH
  openings.push({ kind: 'door', th: 0, yc: sill + doorH / 2, hw: doorW / 2 + 0.12, hh: doorH / 2 + 0.1, ha: (doorW / 2 + 0.3) / R0 })
  const chimTh = o.chimney === 'none' ? null : place(0.2, 1.3, 2.7)
  if (chimTh !== null) openings.push({ kind: 'chimney', th: chimTh, yc: yT / 2, hw: 0.3, hh: yT, ha: 0.35 / R0 })
  const wins = []
  const tr = lerp(0.13, 0.17, lay()), trY = doorTop + { leaf: 0.5, hood: 0.42, none: 0.25 }[o.awning] + tr
  if (o.transom === 'round' && trY + tr + 0.3 < eaveDoor) {
    wins.push({ th: 0, yc: trY, r: tr, kind: 'circle', pot: false })
    openings.push({ kind: 'window', th: 0, yc: trY, hw: tr + 0.12, hh: tr + 0.12, ha: 0 })
  }
  for (let n = 0; n < o.windows; n++) {
    const r = o.winSize * lerp(0.8, 1.15, lay())
    const th = place(0.12, 0.85, Math.PI)
    if (th === null) break
    const lo = sill + 0.55 + r, hi = Math.max(lo, eave(th)[1] - 0.35 - r)
    const yc = lerp(lo, hi, lay())
    const kind = lay() < 0.65 ? 'circle' : 'arch'
    wins.push({ th, yc, r, kind, sill: kind === 'arch' && lay() < 0.6, hood: kind === 'arch' && lay() < 0.45, pot: lay() < 0.35, cross: kind === 'arch' && lay() < 0.5 })
    openings.push({ kind: 'window', th, yc, hw: r + 0.12, hh: r + 0.12, ha: (r + 0.2) / R0 })
  }
  const spireTh = []
  for (let n = 0, want = Math.max(o.spires, o.crown === 'tower' ? 1 : 0); n < 16 && spireTh.length < want; n++) {
    const th = lay() * TAU
    if (Math.abs(angDiff(th, 0)) > 0.7 && (chimTh === null || Math.abs(angDiff(th, chimTh)) > 0.6) && spireTh.every((a) => Math.abs(angDiff(th, a)) > 0.8)) spireTh.push(th)
  }
  const doorHa = (doorW / 2 + 0.15) / R0
  const flank = doorHa + 0.35 + lerp(0.05, 0.25, lay())
  const lobeA = [flank, -flank]
  for (let n = 2; n < o.lobes; n++) lobeA.push(lerp(flank + 0.5, TAU - flank - 0.5, (n - 1.5 + (lay() - 0.5) * 0.6) / (o.lobes - 2)))
  const lobes = lobeA.map((a) => ({ a, amp: o.lobeReach * lerp(0.6, 1.25, lay()), w: lerp(0.2, 0.34, lay()), h: lerp(0.5, 1.1, lay()) * Math.sqrt(R0 / 2), tw: jit(lay, 0.25) }))

  // --- the wall: one function every fixture reads, so nothing floats or sinks
  const calm = (th, y) => {
    let c = 1
    for (const q of openings) {
      if (q.kind === 'chimney') continue
      const lat = Math.abs(angDiff(th, q.th)) * R0
      c = Math.min(c, 1 - (1 - smoothstep(q.hw, q.hw + 0.3, lat)) * (1 - smoothstep(q.hh, q.hh + 0.3, Math.abs(y - q.yc))))
    }
    return c
  }
  // The buttress lobes are the trunk's own radius, gaussian in angle, twisting and dying away up the trunk and still widening below ground; the door and the windows calm them and the flare, or their frames would tip skyward.
  const quiet = [{ th: 0, ha: doorHa }, ...openings.filter((q) => q.kind === 'window' && q.ha).map((q) => ({ th: q.th, ha: q.ha }))]
  const wallR = (th, y, detail = true) => {
    const yy = Math.max(y, 0), deep = 1 + Math.max(0, -y) * 0.8
    let door = 1
    for (const q of quiet) door = Math.min(door, lerp(0.15, 1, smoothstep(q.ha, q.ha + 0.35, Math.abs(angDiff(th, q.th)))))
    let s = 1 + o.flare * Math.exp(-yy / 0.5) * deep * door
    for (const L of lobes) { const d = angDiff(th, L.a + L.tw * yy) / L.w; s += L.amp * Math.exp(-d * d - yy / L.h) * deep * door }
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
    return { F, back: -(Math.max(b, t, mid) - Math.min(bl, tl, ml)) - 0.1 }
  }

  // --- trunk, its rows packed toward the ground where the lobes turn
  const yB = -0.6
  const segs = Math.max(36, Math.min(56, Math.round((TAU * R0) / 0.24)))
  const rows = Math.max(8, Math.ceil((yT - yB) / 0.3))
  const rowY = (j) => yB + (yT - yB) * Math.pow(j / rows, 1.5)
  const barkTile = TILE[LAYER.BARK]
  m.grid(segs, rows, (i, j) => {
    const th = (i / segs) * TAU
    return [wallPt(th, rowY(j)), radial(th)]
  }, MAT.bark, { wrap: true, uv: (i, j) => [((i / segs) * TAU * R0) / barkTile, rowY(j) / barkTile] })

  // --- roof: a 14-column mound, doubled to 28 columns for the frayed lip (§Roof)
  const roofTris0 = m.idx.length
  const skinMat = MAT[o.skin], roofTile = TILE[skinMat.layer]
  const slant = Math.hypot(rT + o.overhang, yA - yT)
  // v runs the true distance down the slope from the apex, or a dome's steep eave smears the texture.
  const roofUV = (th, u) => {
    let v = 0, q = roofAt(th, 1)
    for (let s = 1; s <= 8; s++) { const p = roofAt(th, 1 - ((1 - u) * s) / 8); v += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); q = p }
    return [(th * (rT + o.overhang) * (1 - u)) / roofTile, v / roofTile]
  }
  const roofHint = (th) => [Math.cos(th), 1, Math.sin(th)]
  const NS = 14, N2 = 2 * NS, U = [0.12, 0.32, 0.52, 0.7, 0.86, 1]
  const th1 = (i) => -Math.PI + (TAU * i) / NS, th2 = (i) => -Math.PI + (TAU * i) / N2
  const body = m.grid(NS, U.length - 1, (i, j) => [roofAt(th1(i), U[j]), roofHint(th1(i))], skinMat, { wrap: true, uv: (i, j) => roofUV(th1(i), U[j]) })
  const lip = m.count
  for (let i = 0; i <= N2; i++) m.v(roofAt(th2(i), 0.03), roofHint(th2(i)), skinMat, roofUV(th2(i), 0.03))
  const fray = Array.from({ length: N2 }, () => [(rr() < 0.15 ? lerp(0.25, 0.4, rr()) : lerp(0.04, 0.18, rr())) / slant, jit(rr, 0.4 * (TAU / N2))])
  const frayed = m.count
  for (let i = 0; i <= N2; i++) { const [du, dth] = fray[i % N2], th = th2(i) + dth; m.v(roofAt(th, -du), roofHint(th), skinMat, roofUV(th, -du)) }
  m.twins.push([lip + N2, lip], [frayed + N2, frayed])
  for (let i = 0; i < NS; i++) { const a = lip + 2 * i, b = body + i; m.tri(a, a + 1, b); m.tri(a + 1, a + 2, b + 1); m.tri(a + 1, b + 1, b) }
  for (let i = 0; i < N2; i++) m.quad(lip + i, lip + i + 1, frayed + i + 1, frayed + i)
  const roofTriangles = (m.idx.length - roofTris0) / 3

  // --- shards and towers: the stump's shell carried up through the roof, splintered at the top
  const sp = rngFor(2)
  spireTh.forEach((th, idx) => {
    const tower = o.crown === 'tower' && idx === 0
    const out = radial(th), tan = [-Math.sin(th), 0, Math.cos(th)]
    const rad = (tower ? lerp(0.42, 0.62, sp()) : lerp(0.22, 0.36, sp())) * Math.sqrt(H / 6)
    const elong = lerp(1, tower ? 1.3 : 1.45, sp()), S = tower ? 16 : 12
    const rc = wallR(th, yT, false) - rad * 0.85, y0 = yT - 0.45, roofTop = roofY(th, rc - rad)
    const rise = o.spireH * H * lerp(0.6, 1.2, sp()) + (tower ? 0.6 : 0), top0 = Math.min(H + 0.3, roofTop + rise)
    const tops = Array.from({ length: S }, () => top0 - (top0 - roofTop) * Math.pow(sp(), 1.6) * (tower ? 0.45 : 0.7))
    for (let n = 0, spikes = 1 + Math.floor(sp() * (tower ? 3 : 2)); n < spikes; n++) tops[Math.floor(sp() * S)] = Math.min(H + 0.6, top0 + rise * lerp(0.1, 0.4, sp()))
    const win = tower ? { r: lerp(0.15, 0.2, sp()) } : null
    if (win) {
      win.y = roofY(th, rc + rad) + 0.3 + win.r
      for (let i = S / 4 - 2; i <= S / 4 + 2; i++) tops[i] = Math.max(tops[i], win.y + win.r + 0.25 + sp() * 0.15)
    }
    const sec = Array.from({ length: S }, (_, i) => { const a = (TAU * i) / S; return [Math.cos(a) * elong, Math.sin(a), 1 + 0.22 * nSpire(Math.cos(a) * 1.5 + idx * 9, 0, Math.sin(a) * 1.5)] })
    // A point of column i at height y, `s` of the way out from the axis; the top fifth splinters.
    const at = (i, y, s) => {
      const t = (y - y0) / (top0 - y0), [cx, cz, f] = sec[i]
      const r = rad * f * s * (1 - (tower ? 0.08 : 0.15) * t) * (1 + 0.3 * Math.pow(Math.min(1, t), 4) * jit(sp, 1))
      return add(add(add(lean(y), out, rc + rad * 0.3 * t * t), [0, y, 0]), add(mul(tan, cx * r), out, cz * r))
    }
    const hint = (i, s) => mul(add(mul(tan, sec[i][0]), out, sec[i][1]), s)
    const nj = Math.max(3, Math.ceil((top0 - y0) / 0.3))
    const outer = Array.from({ length: nj + 1 }, (_, j) => Array.from({ length: S }, (_, i) => at(i, y0 + ((tops[i] - y0) * j) / nj, 1)))
    m.grid(S, nj, (i, j) => [outer[j][i], hint(i, 1)], MAT.bark, { wrap: true })
    if (!tower) {
      const ids = outer[nj].map((p) => m.v(p, [0, 1, 0], MAT.wood))
      const cy = lerp(Math.min(...tops), top0, 0.3), c = m.v(add(add(lean(cy), out, rc + rad * 0.3), [0, cy, 0]), [0, 1, 0], MAT.wood)
      for (let i = 0; i < S; i++) m.tri(c, ids[i], ids[(i + 1) % S])
      return
    }
    const yF = roofTop + 0.08, ni = Math.max(2, Math.ceil((Math.min(...tops) - yF) / 0.35)), wall = 1 - lerp(0.2, 0.3, sp())
    const inner = Array.from({ length: ni + 1 }, (_, j) => Array.from({ length: S }, (_, i) => at(i, yF + ((tops[i] - 0.03 - yF) * j) / ni, wall)))
    m.grid(S, ni, (i, j) => [inner[j][i], hint(i, -1)], MAT.wood, { wrap: true })
    m.grid(S, 1, (i, j) => [j ? inner[ni][i] : outer[nj][i], [0, 1, 0]], MAT.wood, { wrap: true })
    const floor = inner[0].map((p) => m.v(p, [0, 1, 0], MAT.dark)), c = m.v(add(add(lean(yF), out, rc), [0, yF, 0]), [0, 1, 0], MAT.dark)
    for (let i = 0; i < S; i++) m.tri(c, floor[i], floor[(i + 1) % S])
    const foot = at(S / 4, win.y - win.r, 1)
    glazed(basis(add(foot, out, 0.015), out), -0.12, { kind: 'circle', r: win.r, pot: false })
  })

  // --- door, jamb, steps, knocker
  const dr = rngFor(5)
  const D = openingFrame(0, sill, doorTop, doorW / 2 + 0.12)
  const dPts = skew(outline(o.doorShape, doorW, doorH), dr, 0.035, 0)
  panel(m, D.F, dPts, MAT.door, 0, doorW, doorH)
  rim(m, dr, D.F, dPts, MAT.wood, 0.12, 0.08, D.back, 0.02)
  const nSteps = Math.max(1, Math.round(sill / 0.14))
  for (let n = 0; n < nSteps; n++) {
    const top = (sill * (nSteps - n)) / (nSteps + 1) + 0.02, hx = 0.2 + n * 0.03
    const Fk = basis(add(D.F.o, [0.1 + hx + n * 0.3, (top - 0.2) / 2 - sill, jit(dr, 0.03)]), [1, 0, 0])
    block(m, dr, tip(Fk, 'ay', jit(dr, 0.075)), [hx, (top + 0.2) / 2, doorW / 2 + 0.14 + n * 0.07], MAT.stone, { crook: 0.03 })
  }
  const kn = basis(put(D.F, 0.03, doorH * 0.5, -doorW * 0.26), D.F.ax, D.F.ay)
  torus(m, { ...kn, o: put(kn, 0.012, -0.06, 0) }, 0.055, 0.011, MAT.iron, { segs: 8, sides: 4 })
  pebble(m, dr, kn, [0.025, 0.02, 0.025], MAT.iron)

  // --- awning, always hung crooked
  const aw = rngFor(6)
  const crook = (aw() < 0.5 ? -1 : 1) * lerp(0.06, 0.15, aw())
  if (o.awning === 'leaf') {
    const len = lerp(0.9, 1.35, aw()) * Math.min(1, Math.sqrt(H / 5)), W = doorW + lerp(0.7, 1.1, aw())
    const y0 = Math.min(doorTop + 0.3, eaveDoor - 0.05), sag = lerp(0.15, 0.35, aw()), x0 = dot(D.F.o, [1, 0, 0]) - 0.15
    const leafAt = (u, v) => {
      const half = (W / 2) * (0.75 + 0.35 * v) * Math.pow(Math.sin(Math.PI * (0.1 + 0.82 * v)), 0.5) * (1 + 0.06 * Math.sin(v * 31))
      const y = -sag * v * v - 0.18 * u * u * v + 0.04 * (1 - u * u), z = u * half
      return [x0 + v * len, y0 + y * Math.cos(crook) - z * Math.sin(crook), y * Math.sin(crook) + z * Math.cos(crook)]
    }
    m.grid(8, 8, (i, j) => [add(leafAt(i / 4 - 1, j / 8), [jit(aw, 0.02), jit(aw, 0.025), jit(aw, 0.02)]), [0, 1, 0]], MAT.tarp)
    tube(m, [0, 0.3, 0.6, 0.9, 1].map((v) => add(leafAt(0, v), [0, 0.02, 0])), [0.03, 0.025, 0.018, 0.01, 0.004], { ...MAT.tarp, tint: [0.7, 0.42, 0.22] }, { sides: 4 })
    for (const s of [-1, 1]) {
      const top = leafAt(s * 0.72, 0.82), foot = [top[0] + 0.05, -0.1, top[2] + s * 0.08]
      const mid = add(mul(add(top, foot), 0.5), [jit(aw, 0.04), 0, jit(aw, 0.04)])
      tube(m, [foot, mid, top], [0.045, 0.04, 0.035], MAT.stick, { sides: 5 })
    }
  } else if (o.awning === 'hood') {
    const Fh = tip(tip(basis(put(D.F, -0.03, doorH + 0.12, 0), D.F.ax, D.F.ay), 'az', -lerp(0.3, 0.5, aw())), 'ax', crook)
    const d = lerp(0.45, 0.6, aw()), zb = doorW / 2 + 0.2
    slab(m, aw, Fh, d, 0.035, zb, zb * lerp(1.15, 1.35, aw()), MAT.shake, 0.02, 5)
    for (const s of [-1, 1]) tube(m, [put(D.F, -0.02, doorH - 0.15 + jit(aw, 0.05), s * (doorW / 2 + 0.12)), put(Fh, d * 0.65, -0.035, s * (doorW / 2 + 0.12))], [0.03, 0.025], MAT.stick, { sides: 5 })
  }

  // --- windows: honeycomb glass in a rough frame; only an arch takes a sill or a hood
  const windowsOut = []
  function glazed(F, back, w) {
    const [width, h] = winDims(w.kind, w.r)
    const pts = skew(outline(w.kind, width, h, w.kind === 'circle' ? 16 : 14), wr, 0.08, h / 2)
    rim(m, wr, F, pts, wr() < 0.6 ? MAT.wood : MAT.bark, 0.09, 0.07, back, w.kind === 'circle' ? 0.022 : 0.015)
    panel(g, F, pts, MAT.glow, 0.005, width, h)
    if (w.cross) {
      block(m, wr, basis(put(F, 0.02, h / 2, 0), F.ax, F.ay), [0.015, h / 2 - 0.01, 0.018], MAT.wood, { sides: 4, crook: 0.008 })
      block(m, wr, basis(put(F, 0.02, h * 0.45, 0), F.ax, F.ay), [0.015, 0.018, width / 2 - 0.01], MAT.wood, { sides: 4, crook: 0.008 })
    }
    if (w.sill) slab(m, wr, tip(tip(basis(put(F, -0.03, -0.035, 0), F.ax, F.ay), 'az', -0.08), 'ax', jit(wr, 0.07)), 0.17, 0.03, width / 2 + 0.1, width / 2 + lerp(0.14, 0.2, wr()), MAT.wood, 0.014)
    if (w.hood) slab(m, wr, tip(tip(basis(put(F, -0.03, h + 0.05, 0), F.ax, F.ay), 'az', -0.45), 'ax', jit(wr, 0.1)), 0.2, 0.025, width / 2 + 0.1, width / 2 + 0.2, skinMat === MAT.thatch ? MAT.shake : skinMat, 0.015)
    if (w.pot) {
      const z = (wr() < 0.5 ? -1 : 1) * (width / 2 + 0.2), arm = put(F, 0.28, h * 0.85, z)
      tube(m, [put(F, -0.02, h * 0.8, z), arm], [0.02, 0.016], MAT.stick, { sides: 4 })
      const foot = add(arm, [0, -lerp(0.3, 0.45, wr()), 0]), P = basis(foot, F.ax)
      tube(m, [arm, add(foot, [0, 0.15, 0])], [0.006, 0.006], MAT.rope, { sides: 3 })
      lathe(m, P, [[0, 0], [0.07, 0], [0.1, 0.1], [0.11, 0.16], [0.09, 0.15]], MAT.clay, { segs: 8 })
      for (let n = 0; n < 3; n++) pebble(m, wr, basis(add(foot, [jit(wr, 0.04), 0.16 + wr() * 0.04, jit(wr, 0.04)]), F.ax), [0.06, 0.05, 0.06], MAT.green)
      for (let n = 0; n < 3; n++) pebble(m, wr, basis(add(foot, [jit(wr, 0.07), 0.2 + wr() * 0.05, jit(wr, 0.07)]), F.ax), [0.025, 0.02, 0.025], { ...MAT.fungus, tint: CAPS[Math.floor(wr() * CAPS.length)] })
    }
    lights.push({ kind: 'window', p: put(F, 0.25, h / 2, 0) })
    return { p: put(F, 0, h / 2, 0), n: F.ax, r: Math.max(width, h) / 2 }
  }
  for (const w of wins) {
    const [width, h] = winDims(w.kind, w.r), y0 = w.yc - h / 2
    const W = openingFrame(w.th, y0, y0 + h, width / 2 + 0.1)
    windowsOut.push(glazed(W.F, W.back, w))
  }

  // --- chimney
  const ch = rngFor(8)
  if (chimTh !== null) {
    const out = radial(chimTh), [cR, cY] = eave(chimTh)
    if (o.chimney === 'stone') {
      // Plumb, standing off the wall where it is widest below the eave so no block hangs in the air.
      let dist = 0
      for (let y = 0.3; y < cY; y += 0.3) dist = Math.max(dist, dot(wallPt(chimTh, y), out))
      const topY = Math.max(cY + 0.9, roofY(chimTh, dist + 0.15) + 0.6)
      let y = -0.15
      while (y < topY) {
        const hh = lerp(0.11, 0.16, ch()), hs = lerp(0.32, 0.25, y / topY)
        const F = basis(add(mul(out, dist + hs * 0.4), [0, y + hh, 0]), out)
        block(m, ch, tip(F, 'ay', jit(ch, 0.125)), [hs, hh, hs * lerp(0.9, 1.1, ch())], MAT.stone, { crook: 0.025 })
        y += hh * 2 - 0.01
      }
      const capF = basis(add(mul(out, dist + 0.25 * 0.4), [0, y + 0.04, 0]), out)
      block(m, ch, capF, [0.33, 0.04, 0.33], MAT.stone, { crook: 0.02 })
      if (ch() < 0.45) hangLantern(put(capF, 0, 0.04, 0), 0.8)
    } else {
      const y0 = Math.min(yT * 0.65, cY - 0.4), reach = cR - rT + 0.45, topY = Math.max(cY + 0.8, roofY(chimTh, rT) + 0.7)
      const base = wallPt(chimTh, y0, -0.1), elbow = wallPt(chimTh, y0 + 0.1, reach), up = add(elbow, [0, topY - y0, 0])
      const pts = [base, add(base, out, reach * 0.55), add(elbow, [0, 0.18, 0]), add(elbow, [0, 0.55, 0]), add(up, mul(out, jit(ch, 0.1)))]
      const pr = lerp(0.16, 0.2, ch())
      tube(m, pts, [pr * 1.25, pr, pr, pr, pr * 0.9], MAT.clay, { sides: 10 })
      const band = (p) => torus(m, { o: p, ax: [0, 1, 0], ay: out, az: [-out[2], 0, out[0]] }, pr * 1.02, 0.025, MAT.iron, { segs: 10, sides: 4 })
      for (let n = 1; n <= 3; n++) band(add(pts[3], sub(pts[4], pts[3]), n / 4))
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
    for (let n = 0; n < 16; n++) {
      const th = de() * TAU, y = lerp(lo, hi, de())
      if (calm(th, y) > 0.99 && clear(th, gap) && Math.abs(angDiff(th, 0)) > 0.5) return { th, y }
    }
    return null
  }
  const ground = (th, out) => wallPt(th, 0, out)
  const offDoor = (th, gap) => Math.abs(angDiff(th, 0)) > gap
  /** One ivy leaf, its stem (the texture's bottom centre) at p, spun about the wall normal and lifted off it. */
  const ivy = (p, out, s) => {
    const dir = norm(add(rot([0, 1, 0], out, de() * TAU), out, lerp(0.2, 0.7, de())))
    const side = mul(norm(cross(dir, out)), s / 2), tipP = add(p, dir, s)
    const ids = [[add(p, side, -1), [0, 1]], [add(p, side), [1, 1]], [add(tipP, side), [1, 0]], [add(tipP, side, -1), [0, 0]]].map(([q, uv]) => m.v(q, out, MAT.ivy, uv))
    m.quad(ids[0], ids[1], ids[2], ids[3])
  }
  /** A knotted tendril wandering up the wall from (th0, y0), turning dth and climbing dy over n steps, in leaf. */
  const strand = (th0, y0, dth, dy, n, r0, r1) => {
    const ph = de() * 50, pts = [], ths = [], radii = []
    for (let s = 0; s <= n; s++) {
      const t = s / n, th = th0 + dth * t + 0.2 * (nWall(ph, t * 3, 0) - nWall(ph, 0, 0)) + 0.07 * (nWall(ph + 9, t * 11, 3) - nWall(ph + 9, 0, 3))
      const r = lerp(r0, r1, t) * (s && de() < 0.14 ? lerp(1.7, 2.5, de()) : lerp(0.85, 1.15, de()))
      pts.push(wallPt(th, y0 + dy * t + (s ? jit(de, 0.04) : 0), r * 0.8)); ths.push(th); radii.push(r)
    }
    tube(m, pts, radii, MAT.vine, { sides: 4 })
    for (let s = 1; s <= n; s++) if (de() < 0.65) ivy(pts[s], radial(ths[s]), lerp(0.09, 0.17, de()))
    return { pts, ths }
  }
  /** A strand hanging from the eave at th, `len` long. */
  const hang = (th, len, n) => {
    const top = roofAt(th, 0.02), side = [-Math.sin(th), 0, Math.cos(th)], sway = jit(de, 0.15)
    return Array.from({ length: n + 1 }, (_, s) => { const t = s / n; return add(top, add(mul(side, sway * t * t + (s ? jit(de, 0.02) : 0)), [0, -len * t, 0])) })
  }
  const DECOR = {
    fungi() {
      const s = spot(0.4, yT - 0.6)
      if (!s) return
      for (let n = 0, count = 2 + Math.floor(de() * 3); n < count; n++) {
        const th = s.th + jit(de, 0.15), y = s.y + n * lerp(0.2, 0.32, de()), r = lerp(0.2, 0.4, de()) * Math.sqrt(R0 / 1.8), t = r / 0.15
        const F = tip(basis(wallPt(th, y, -r * 0.15), radial(th)), 'az', jit(de, 0.12))
        lathe(m, F, [[0, -0.05 * t], [r * 0.85, -0.04 * t], [r, 0], [r * 0.7, 0.045 * t], [0, 0.055 * t]], MAT.fungus, { segs: 8 })
      }
    },
    mushrooms() {
      const th = lobes[Math.floor(de() * lobes.length)].a + jit(de, 0.2)
      const cap = { ...MAT.fungus, tint: CAPS[Math.floor(de() * CAPS.length)] }
      for (let n = 0, count = 2 + Math.floor(de() * 4); n < count; n++) {
        const a = th + jit(de, 0.18), F = tip(basis(ground(a, lerp(0.35, 0.9, de())), radial(a)), 'az', jit(de, 0.15))
        const h = lerp(0.07, 0.2, de()), cr = lerp(0.05, 0.12, de())
        lathe(m, F, [[0.02, -0.05], [0.018, h]], MAT.stem, { segs: 5 })
        lathe(m, F, [[0, h], [cr * 0.8, h - 0.01], [cr, h + cr * 0.05], [cr * 0.75, h + cr * 0.6], [0, h + cr * 0.8]], cap, { segs: 7 })
      }
    },
    pinecones() {
      const a = de() * TAU
      if (!offDoor(a, 0.5)) return
      for (let n = 0, count = 2 + Math.floor(de() * 3); n < count; n++) {
        const b = a + jit(de, 0.15)
        pinecone(m, tip(tip(basis(add(ground(b, lerp(0.25, 0.6, de())), [0, 0.05, 0]), radial(b)), 'ay', de() * TAU), 'az', 1.3), lerp(0.12, 0.18, de()))
      }
    },
    woodpile() {
      const s = spot(0.3, 0.31, 0.3)
      if (!s) return
      const t = [-Math.sin(s.th), 0, Math.cos(s.th)]
      for (let row = 0; row < 3; row++) for (let n = 0; n < 4 - row; n++) {
        const r = 0.07, p = add(ground(s.th, 0.28), add(mul(t, (n - (3 - row) / 2) * r * 2.05), [0, r + row * r * 1.75, 0]))
        log(m, basis(p, radial(s.th), t), r * lerp(0.85, 1.1, de()), lerp(0.45, 0.6, de()), MAT.bark, MAT.wood)
      }
    },
    pot() {
      const s = spot(0.3, 0.31, 0.2)
      if (!s) return
      const F = basis(ground(s.th, lerp(0.25, 0.4, de())), radial(s.th)), sc = lerp(0.8, 1.3, de())
      lathe(m, F, [[0, -0.02], [0.12 * sc, -0.02], [0.17 * sc, 0.12 * sc], [0.12 * sc, 0.24 * sc], [0.13 * sc, 0.28 * sc], [0, 0.27 * sc]], MAT.clay, { segs: 9 })
    },
    straw() {
      const s = spot(0.3, 0.31, 0.2)
      if (!s) return
      const hgt = lerp(0.6, 0.9, de()), F = tip(basis(ground(s.th, 0.3), radial(s.th)), 'az', 0.25)
      lathe(m, F, [[0, 0], [0.1, 0], [0.09, hgt * 0.6], [0.14, hgt], [0, hgt + 0.02]], MAT.straw, { segs: 7 })
      lathe(m, F, [[0.1, hgt * 0.45], [0.1, hgt * 0.53]], { ...MAT.stick, tint: [0.6, 0.45, 0.3] }, { segs: 7 })
    },
    garland() {
      const a = de() * TAU, b = a + lerp(0.5, 0.9, de()), sag = lerp(0.2, 0.4, de())
      const n = 12, pts = Array.from({ length: n + 1 }, (_, s) => add(roofAt(lerp(a, b, s / n), 0.02), [0, -sag * Math.sin((Math.PI * s) / n), 0]))
      tube(m, pts, pts.map(() => 0.008), MAT.rope, { sides: 3 })
      for (let s = 1; s < n; s++) {
        const bead = { ...MAT.bead, tint: [[1.0, 0.86, 0.62], [0.55, 0.38, 0.25], [1.15, 1.1, 1.0]][s % 3] }
        pebble(m, de, basis(add(pts[s], [0, -0.05, 0]), [1, 0, 0]), [0.035, 0.05, 0.035], bead)
      }
    },
    vine() {
      const th0 = de() * TAU
      if (!offDoor(th0, 0.6)) return
      const top = lerp(0.55, 0.95, de()) * yT, n = Math.max(10, Math.round(top / 0.1))
      const main = strand(th0, -0.1, jit(de, 0.8), top, n, 0.034, 0.012)
      for (let b = 0, nb = 1 + Math.floor(de() * 3); b < nb; b++) {
        const s = 4 + Math.floor(de() * (n - 6))
        strand(main.ths[s], main.pts[s][1], (de() < 0.5 ? -1 : 1) * lerp(0.15, 0.35, de()), lerp(0.1, 0.5, de()), 6, 0.016, 0.006)
      }
    },
    hangvine() {
      const th = de() * TAU
      if (!offDoor(th, 0.5)) return
      const n = 8, pts = hang(th, lerp(0.5, 1.3, de()), n)
      tube(m, pts, pts.map((_, s) => lerp(0.018, 0.008, s / n)), MAT.vine, { sides: 3 })
      for (let s = 1; s <= n; s++) ivy(pts[s], radial(th), lerp(0.08, 0.14, de()))
    },
    rope() {
      const th = de() * TAU
      if (!offDoor(th, 0.5)) return
      const out = radial(th), pts = hang(th, lerp(0.5, 1.2, de()), 5), end = pts[5]
      tube(m, pts, pts.map(() => 0.012), MAT.rope, { sides: 3 })
      pebble(m, de, basis(add(pts[1], [0, -0.02, 0]), out), [0.028, 0.03, 0.028], MAT.rope)
      const pick = de()
      if (pick < 0.4) lathe(m, basis(end, out), [[0, -0.35], [0.07, -0.3], [0.05, -0.05], [0.03, 0], [0, 0.01]], MAT.straw, { segs: 7 })
      else if (pick < 0.7) pinecone(m, tip(basis(end, out), 'az', Math.PI), lerp(0.12, 0.18, de()))
      else for (let s = 1; s <= 3; s++) pebble(m, de, basis(add(end, [0, -0.07 * s, 0]), out), [0.035, 0.05, 0.035], { ...MAT.bead, tint: [0.55, 0.38, 0.25] })
    },
    lantern() {
      const s = de() < 0.5 ? -1 : 1, base = put(D.F, -0.05, doorH * 0.85, s * (doorW / 2 + 0.2)), arm = put(D.F, 0.3, doorH * 0.92, s * (doorW / 2 + 0.2))
      tube(m, [base, add(base, D.F.ax, 0.15), arm], [0.025, 0.02, 0.015], MAT.stick, { sides: 4 })
      hangLantern(add(arm, [0, -0.28, 0]))
    },
    stones() {
      if (o.skin === 'thatch') return
      for (let n = 0, count = 2 + Math.floor(de() * 4); n < count; n++) {
        const th = de() * TAU
        pebble(m, de, basis(add(roofAt(th, lerp(0.15, 0.5, de())), [0, 0.03, 0]), radial(th)), [0.14, 0.05, 0.11], MAT.stone)
      }
    },
  }
  const pool = ['fungi', 'fungi', 'fungi', 'mushrooms', 'mushrooms', 'pinecones', 'woodpile', 'pot', 'straw', 'garland', 'vine', 'vine', 'hangvine', 'hangvine', 'rope', 'rope', 'lantern', 'stones']
  const most = { woodpile: 1, lantern: 1, garland: 1, vine: 2, hangvine: 3, rope: 3 }
  const decor = []
  for (let n = 0, count = Math.round(o.decor * 14); n < count; n++) {
    const kind = pool[Math.floor(de() * pool.length)]
    if (kind in most && decor.filter((d) => d === kind).length >= most[kind]) continue
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
  const eaves = Array.from({ length: 16 }, (_, i) => eave((i / 16) * TAU))
  return {
    geometry, glow, decor,
    door: { p: warp(D.F.o), n: D.F.ax, w: doorW, h: doorH, sill },
    windows: windowsOut.map((w) => ({ ...w, p: warp(w.p) })),
    lights: lights.map((l) => ({ ...l, p: warp(l.p) })),
    trunk: { r: R0, top: yT }, eave: { r: eaves.reduce((s, e) => s + e[0], 0) / 16, y: Math.max(...eaves.map((e) => e[1])) },
    reach, top: geometry.boundingBox.max.y,
    stats: { triangles: geometry.index.count / 3, roofTriangles, glowTriangles: glow.index.count / 3, vertices: pos.count, ms: performance.now() - t0 },
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
