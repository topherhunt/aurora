// Castle preview shells for gen-castle.html: the exterior the layout implies (sections, battlements, the doors, flights and bridges
// its chosen edges use) and the interior rooms at CASTLE.scale. Sections are lofted footprints with bevelled, jittered corners and a
// root crown and a flared top; every vertex then goes through one position-only warp, which keeps coincident vertices coincident (see
// src/buildings/v2/warp.js). The court floor and gate ramps are a separate flagstone mesh. Z-fight rules: design/44-castles.md, Shell.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { makeWarp } from '../../buildings/v2/warp.js'
import { CASTLE } from './layout.js'
import { courtProps, roofProps, roomProps, roomPlan, PARTITION } from './furnish.js'
import { dungeonPlan } from './dungeon.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale, V = CASTLE.tall
// Metres of mesh per stone tile (public/buildings/castle_stone.webp, about 30 cm courses).
export const UV_METRES = 4
// Metres per plank tile (public/buildings/timber_plank.png, textures.js LAYER.TIMBER_PLANK).
export const PLANK_METRES = 0.72
// Material slots, as geometry groups: castle stone, planks, door leaves (public/buildings/door.png once across each) and gates
// (public/buildings/castle_gate.png once across both leaves), the last two by explicit UVs. Each slot's tile metres.
export const STONE_SLOT = 0, WOOD_SLOT = 1, DOOR_SLOT = 2, GATE_SLOT = 3
const SLOTS = [UV_METRES, PLANK_METRES, 1, 1]
// castle_gate.png's arch rises this fraction of the doors' height, so the gate's arch is drawn to match it.
const GATE_ARCH = 0.34
// sRGB hex to linear, as THREE.Color(hex) gives it; three itself is a stub in the castle worker (vite.config.js noThreeInWorkers).
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export const rgb = (hex) => [hex >> 16, (hex >> 8) & 255, hex & 255].map((v) => lin(v / 255))
const STONE = { keep: rgb(0x8d877c), hall: rgb(0x958b7a), gate: rgb(0x8a857d), tower: rgb(0x878580), lookout: rgb(0x7d7d84), wall: rgb(0x8b867e) }
const BAND = rgb(0x6f6a63), SLATE = rgb(0x3f4652), DARK = rgb(0x15120f), GOLD = rgb(0xc9a33a)
const FLOOR = { keep: rgb(0x7a5a3a), hall: rgb(0x80603e), gate: rgb(0x6d6a66), tower: rgb(0x6d6a66), lookout: rgb(0x75645f) }
const INNER = rgb(0xb8b0a2), STEP = rgb(0x8f8a83), FLAG = [1, 1, 1], LEAF = [1, 1, 1]
// A spiral stair (interior metres): 15 steps round a post, each 1/16 turn, the 16th its landing in the storey above. That storey's slab
// is open over steps `hole` on, where her head would meet it; over the rest it is the landing.
export const SPIRAL = { R: 2, post: 0.3, steps: 15, hole: 7 }
/** The bearing a spiral about interior (x, z) climbs from, on a 1/16 turn so its segments' corners meet its hole's square. */
export const spiralStart = (x, z) => Math.round(Math.atan2(z, x) / (Math.PI / 8)) * Math.PI / 8

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(...a)
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const warpOf = (seed, s) => makeWarp({ strength: 1, seed, amp: 0.22 * s, scale: 6 * s, amp2: 0.05 * s, scale2: 1.8 * s, leanX: 0, leanZ: 0, leanPow: 1 })

const HEXA_FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]

export class Mesher {
  constructor(seed, warp = null, full = true) { this.bufs = SLOTS.map(() => ({ p: [], n: [], c: [], uv: [] })); this.slot = STONE_SLOT; this.rng = mulberry32(seed); this.warp = warp; this.full = full }
  tint(col, j = 0.08) { const f = 1 + (this.rng() - 0.5) * j; return col.map((v) => v * f) }
  /** Draws `fn` into material slot `slot`, unwarped when `straight`. */
  with(slot, fn, straight = false) {
    const [s0, w0] = [this.slot, this.warp]
    this.slot = slot; if (straight) this.warp = null
    fn()
    this.slot = s0; this.warp = w0
  }
  /** A quad a-b-c-d facing the side of normal hint n, with UVs `uv` per corner when given. */
  quad(a, b, c, d, col, n, uv) { this.face([a, b, c], n, col, uv && [uv[0], uv[1], uv[2]]); this.face([a, c, d], n, col, uv && [uv[0], uv[2], uv[3]]) }
  tri(a, b, c, col, away) { this.face([a, b, c], sub(a, away), col) }
  /** One triangle wound to face the side of hint n (each half of a bent quad on its own), its normal taken from the warped corners
   * and its UVs from the unwarped ones, projected along the main axis in the slot's tile metres (or `uv`). Degenerate triangles are
   * dropped. */
  face(raw, n, col, uv) {
    let nr = cross(sub(raw[1], raw[0]), sub(raw[2], raw[0]))
    if (len(nr) < 1e-9) return
    if (dot(nr, n) < 0) { raw = [raw[0], raw[2], raw[1]]; nr = nr.map((v) => -v); if (uv) uv = [uv[0], uv[2], uv[1]] }
    const w = raw.map((p) => (this.warp ? this.warp(p[0], p[1], p[2]) : p))
    const fn = cross(sub(w[1], w[0]), sub(w[2], w[0]))
    if (len(fn) < 1e-10) return
    const u = norm(fn), ax = Math.abs(nr[0]) > Math.abs(nr[1]) && Math.abs(nr[0]) > Math.abs(nr[2]) ? 0 : Math.abs(nr[1]) > Math.abs(nr[2]) ? 1 : 2
    const b = this.bufs[this.slot], T = SLOTS[this.slot]
    for (let i = 0; i < 3; i++) {
      b.p.push(...w[i]); b.n.push(...u); b.c.push(...col)
      if (uv) b.uv.push(...uv[i])
      else b.uv.push(ax === 0 ? raw[i][2] / T : raw[i][0] / T, ax === 1 ? raw[i][2] / T : raw[i][1] / T)
    }
  }
  box(x0, y0, z0, x1, y1, z1, col, bottom = false) {
    const [xa, xb] = [Math.min(x0, x1), Math.max(x0, x1)], [za, zb] = [Math.min(z0, z1), Math.max(z0, z1)]
    const P = (x, y, z) => [x ? xb : xa, y ? y1 : y0, z ? zb : za]
    this.quad(P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1), col, [1, 0, 0])
    this.quad(P(0, 0, 0), P(0, 1, 0), P(0, 1, 1), P(0, 0, 1), col, [-1, 0, 0])
    this.quad(P(0, 1, 0), P(1, 1, 0), P(1, 1, 1), P(0, 1, 1), col, [0, 1, 0])
    if (bottom) this.quad(P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1), col, [0, -1, 0])
    this.quad(P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1), col, [0, 0, 1])
    this.quad(P(0, 0, 0), P(1, 0, 0), P(1, 1, 0), P(0, 1, 0), col, [0, 0, -1])
  }
  /** Eight corners, bottom ring then top ring, each ring going round; `open` leaves the bottom face off. */
  hexa(v, col, open = false) {
    const mid = v.reduce((a, p) => [a[0] + p[0] / 8, a[1] + p[1] / 8, a[2] + p[2] / 8], [0, 0, 0])
    for (const f of open ? HEXA_FACES.slice(1) : HEXA_FACES) {
      const q = f.map((i) => v[i]), c = q.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0])
      this.quad(...q, col, sub(c, mid))
    }
  }
  /** One mesh as plain arrays (toGeometry makes it a BufferGeometry), a group per material slot in SLOTS order (empty slots keep their empty group). */
  arrays() {
    const cat = (k) => new Float32Array(this.bufs.flatMap((b) => b[k]))
    let at = 0
    const groups = this.bufs.map((b, i) => { const g = [at, b.p.length / 3, i]; at += b.p.length / 3; return g })
    return { position: cat('p'), normal: cat('n'), color: cat('c'), uv: cat('uv'), groups }
  }
}

/** A shell mesh's arrays as a BufferGeometry. */
export function toGeometry(d) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3))
  g.setAttribute('color', new THREE.BufferAttribute(d.color, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2))
  for (const [start, count, slot] of d.groups) g.addGroup(start, count, slot)
  return g
}

// Footprints are convex loops of [x, z].
const centroid = (P) => P.reduce((a, p) => [a[0] + p[0] / P.length, a[1] + p[1] / P.length], [0, 0])
const lerp2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
const at3 = (p, y) => [p[0], y, p[1]]
/** Outward unit normals, edge i running P[i] to P[i+1]. */
export function edgeNormals(P) {
  const c = centroid(P)
  return P.map((p, i) => {
    const q = P[(i + 1) % P.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]), n = [(q[1] - p[1]) / l, (p[0] - q[0]) / l]
    return n[0] * ((p[0] + q[0]) / 2 - c[0]) + n[1] * ((p[1] + q[1]) / 2 - c[1]) < 0 ? [-n[0], -n[1]] : n
  })
}
/** The loop with edge i pushed out by d[i] (or a number for all); where two collinear edges differ, their shared vertex takes the smaller. */
export function offsetLoop(P, N, d) {
  const D = (i) => (typeof d === 'number' ? d : d[i])
  return P.map((p, i) => {
    const j = (i + P.length - 1) % P.length, n1 = N[j], n2 = N[i], d1 = D(j), d2 = D(i)
    const det = n1[0] * n2[1] - n1[1] * n2[0]
    if (Math.abs(det) < 1e-3) { const dd = Math.min(d1, d2); return [p[0] + n2[0] * dd, p[1] + n2[1] * dd] }
    return [p[0] + (d1 * n2[1] - n1[1] * d2) / det, p[1] + (n1[0] * d2 - d1 * n2[0]) / det]
  })
}

/** A section's ground loop: a 12- or 16-gon whose edge midpoints touch the cell faces (doors sit there), or the rect with each corner
 * cut askew in two facets and every side broken at half cells so the warp has vertices to bend. `corner` flags the facet joints. */
function footprint(lay, s, rng) {
  const [x0, z0, x1, z1] = [lay.X(s.x0), lay.Z(s.z0), lay.X(s.x0 + s.w), lay.Z(s.z0 + s.d)]
  if (s.round) {
    const n = rng() < 0.5 ? 12 : 16, R = (x1 - x0) / 2 / Math.cos(Math.PI / n), c = [(x0 + x1) / 2, (z0 + z1) / 2]
    const pts = Array.from({ length: n }, (_, i) => { const a = (i + 0.5) * Math.PI * 2 / n, r = R * (1 + (rng() - 0.5) * 0.02); return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r] })
    return { pts, corner: pts.map(() => false) }
  }
  const K = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
  const cut = K.map(() => [0.6 + rng() * 0.6, 0.6 + rng() * 0.6, 0.1 + rng() * 0.3])
  const toward = (p, q, d) => lerp2(p, q, d / Math.hypot(q[0] - p[0], q[1] - p[1]))
  const pts = [], corner = []
  for (let i = 0; i < 4; i++) {
    const c = K[i], q = K[(i + 1) % 4], [a, b, t] = cut[i]
    const A = toward(c, K[(i + 3) % 4], a), B = toward(c, q, b)
    pts.push(A, lerp2(lerp2(A, B, 0.5), c, t), B); corner.push(false, true, false)
    const L = Math.hypot(q[0] - c[0], q[1] - c[1])
    for (let u = C / 2; u < L - cut[(i + 1) % 4][0] - 0.3; u += C / 2) if (u > b + 0.3) { pts.push(toward(c, q, u)); corner.push(false) }
  }
  return { pts, corner }
}

/** The section in the cell beside (x, z), or null. */
const beside = (lay, x, z) => lay.occAt(Math.floor((x - lay.X(0)) / C), Math.floor((z - lay.Z(0)) / C))

/** Ring heights and outward offsets: a footing deep below ground, a root crown spreading at grade, a narrow jittered waist, a slow
 * swell, then a corbelled flare. Rings from BAND_FROM up are the band. */
export const ROOT = 0.8
const profile = (top, fl, j) => [[-6, ROOT + 0.5], [0, ROOT], [0.9, ROOT * 0.45], [2.4, ROOT * 0.12], [top * 0.5, j()], [top * 0.75, 0.06 + j()],
  [top - 1.1, 0.16 + j()], [top - 0.55, fl * 0.8], [top, fl]]
const BAND_FROM = 6

/** A section's footprint and its neighbours: which faces stay plumb (`touch`), the hard planes its rings clamp to, and which
 * parapet edges it cedes. Takes `rng` first, before sectionShell's own draws, so solids.js reproduces the shell exactly. */
export function sectionFrame(lay, s, rng) {
  const top = s.floors * H, fl = s.kind === 'hall' ? 0.25 : 0.7
  const { pts, corner } = footprint(lay, s, rng)
  const N = edgeNormals(pts), n = pts.length, nx = (i) => (i + 1) % n
  // A face against a neighbour that reaches the flare stays plumb, or the two flares would cross into one another.
  const touch = pts.map((p, i) => {
    const q = pts[nx(i)], by = beside(lay, (p[0] + q[0]) / 2 + N[i][0] * C / 2, (p[1] + q[1]) / 2 + N[i][1] * C / 2)
    return !!by && by !== s && by.kind !== 'wall' && by.floors * H > top - 1.2
  })
  // A box side that a tall neighbour stands against is a hard plane for every ring, else bevel facets, which probe a diagonal
  // cell, flare into the neighbour and their caps overlap. Along it one parapet stands, the taller section's (on a tie, the earlier).
  const tall = (by) => !!by && by !== s && by.kind !== 'wall' && by.floors * H > top - 1.2
  const me = lay.sections.indexOf(s)
  const sides = [[0, lay.X(s.x0), 1, s.d, (i) => lay.occAt(s.x0 - 1, s.z0 + i)], [0, lay.X(s.x0 + s.w), -1, s.d, (i) => lay.occAt(s.x0 + s.w, s.z0 + i)],
    [1, lay.Z(s.z0), 1, s.w, (i) => lay.occAt(s.x0 + i, s.z0 - 1)], [1, lay.Z(s.z0 + s.d), -1, s.w, (i) => lay.occAt(s.x0 + i, s.z0 + s.d)]]
    .map(([ax, v, dir, cnt, cell]) => {
      const by = Array.from({ length: cnt }, (_, i) => cell(i)).filter(tall)
      return { ax, v, dir, on: by.length > 0, cede: by.some((o) => o.floors * H > top || (o.floors * H === top && lay.sections.indexOf(o) < me)) }
    }).filter((d) => d.on)
  const clamp = (p) => { for (const d of sides) p[d.ax] = d.dir > 0 ? Math.max(p[d.ax], d.v) : Math.min(p[d.ax], d.v); return p }
  const ceded = (p, q) => sides.some((d) => d.cede && Math.abs(p[d.ax] - d.v) < 1e-6 && Math.abs(q[d.ax] - d.v) < 1e-6)
  return { top, fl, pts, corner, N, n, nx, touch, clamp, ceded }
}

function sectionShell(m, lay, s, rng) {
  const { top, fl, pts, corner, N, n, nx, touch, clamp, ceded } = sectionFrame(lay, s, rng)
  const col = m.tint(STONE[s.kind]), band = m.tint(BAND)
  const j = () => (rng() - 0.5) * 0.06
  const rings = profile(top, fl, j).map(([y, off], r) => {
    const loop = offsetLoop(pts, N, touch.map((t) => (t && r >= BAND_FROM ? 0 : off)))
    if (r > 1) loop.forEach((p, i) => { if (corner[i]) { p[0] += (rng() - 0.5) * 0.1; p[1] += (rng() - 0.5) * 0.1 } })
    return { y, loop: r ? loop.map(clamp) : loop }
  })
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r], B = rings[r + 1]
    for (let i = 0; i < n; i++) m.quad(at3(A.loop[i], A.y), at3(A.loop[nx(i)], A.y), at3(B.loop[nx(i)], B.y), at3(B.loop[i], B.y), r >= BAND_FROM ? band : col, [N[i][0], 0, N[i][1]])
  }
  const T = rings.at(-1).loop, c = centroid(T)
  if (s.roof.unused) spire(m, T, N, touch, clamp, top, Math.min(s.w, s.d) * C * 1.1 + 1, rng)
  else {
    for (let i = 0; i < n; i++) m.tri(at3(c, top), at3(T[i], top), at3(T[nx(i)], top), col, at3(c, top - 1))
    parapet(m, T, top, col, T.map((p, i) => ceded(p, T[nx(i)])), rng)
  }
  // Arrow slits on the faces of each upper storey that nothing taller stands against.
  if (m.full) for (let k = 1; k < s.floors; k++) for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[nx(i)], L = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (L < 0.9) continue
    const mid = lerp2(p, q, 0.5), by = beside(lay, mid[0] + N[i][0] * C / 2, mid[1] + N[i][1] * C / 2)
    if ((by && by !== s && by.floors * H > k * H + 1) || rng() < 0.65) continue
    const o = [mid[0] + N[i][0] * 0.07, mid[1] + N[i][1] * 0.07], t = [(q[0] - p[0]) / L * 0.15, (q[1] - p[1]) / L * 0.15], y0 = k * H + 1.3, y1 = k * H + 2.5
    m.quad([o[0] - t[0], y0, o[1] - t[1]], [o[0] + t[0], y0, o[1] + t[1]], [o[0] + t[0], y1, o[1] + t[1]], [o[0] - t[0], y1, o[1] - t[1]], DARK, [N[i][0], 0, N[i][1]])
  }
}

/** A parapet round the top loop T, merlons standing on it edge by edge; edges flagged in `skip` are left open. */
function parapet(m, T, y, col, skip, rng) {
  const NT = edgeNormals(T), I = offsetLoop(T, NT, -0.36), y1 = y + 0.6, y2 = y + 1.2
  for (let i = 0; i < T.length; i++) {
    const i2 = (i + 1) % T.length, h = [NT[i][0], 0, NT[i][1]]
    if (skip[i]) continue
    // An open neighbour edge leaves this run's end showing.
    const along = [T[i2][0] - T[i][0], 0, T[i2][1] - T[i][1]]
    if (skip[(i + T.length - 1) % T.length]) m.quad(at3(T[i], y), at3(I[i], y), at3(I[i], y1), at3(T[i], y1), col, along.map((v) => -v))
    if (skip[i2]) m.quad(at3(T[i2], y), at3(I[i2], y), at3(I[i2], y1), at3(T[i2], y1), col, along)
    m.quad(at3(T[i], y), at3(T[i2], y), at3(T[i2], y1), at3(T[i], y1), col, h)
    m.quad(at3(I[i], y), at3(I[i2], y), at3(I[i2], y1), at3(I[i], y1), col, h.map((v) => -v))
    m.quad(at3(T[i], y1), at3(T[i2], y1), at3(I[i2], y1), at3(I[i], y1), col, [0, 1, 0])
    const L = Math.hypot(T[i2][0] - T[i][0], T[i2][1] - T[i][1]), cnt = L < 0.7 ? 0 : Math.max(1, Math.round(L / 1.3)), w = Math.min(0.6, L / cnt * 0.55) / L
    for (let k = 0; k < cnt; k++) {
      const t0 = (k + 0.5) / cnt - w / 2, t1 = t0 + w
      const q = [lerp2(T[i], T[i2], t0), lerp2(T[i], T[i2], t1), lerp2(I[i], I[i2], t1), lerp2(I[i], I[i2], t0)]
      merlon(m, q, y1, y2, col, rng)
    }
  }
}

/** A merlon on base quad q (four [x, z] going round at y0), its top flared and every corner jittered, so no edge meets square. */
function merlon(m, q, y0, y1, col, rng) {
  if (!m.full) return
  const c = centroid(q), f = 1.1 + rng() * 0.08, h = y1 + (rng() - 0.5) * 0.16, J = () => (rng() - 0.5) * 0.06
  const base = q.map((p) => at3([p[0] + J(), p[1] + J()], y0))
  const top = q.map((p) => at3([c[0] + (p[0] - c[0]) * f + J(), c[1] + (p[1] - c[1]) * f + J()], h + J()))
  m.hexa([...base, ...top], col)
}

/** A two-stage spire over loop T: a shallow lower skirt and a steep upper needle, so the profile is concave. */
function spire(m, T, N, touch, clamp, y, lift, rng) {
  const E = offsetLoop(T, N, touch.map((t) => (t ? 0 : 0.25))).map(clamp), c = centroid(T), slate = m.tint(SLATE), ym = y + lift * 0.38
  const shrink = 0.4 + rng() * 0.06, M = E.map((p) => lerp2(c, p, shrink)), apex = [c[0], y + lift, c[1]]
  for (let i = 0; i < T.length; i++) {
    const i2 = (i + 1) % T.length
    m.quad(at3(T[i], y), at3(T[i2], y), at3(E[i2], y), at3(E[i], y), slate, [0, -1, 0])
    m.quad(at3(E[i], y), at3(E[i2], y), at3(M[i2], ym), at3(M[i], ym), slate, [N[i][0], 1, N[i][1]])
    m.tri(at3(M[i], ym), at3(M[i2], ym), apex, slate, at3(c, ym))
  }
}

/** A wall's parapet, standing on the outer edge of its top ring: the outer face shares that edge's vertices, so the warp bends both
 * alike and no sky shows between them. Merlons stand along [m0, m1]. */
function crenels(m, P, us, out, inn, nOut, m0, m1, y, col, rng) {
  const y1 = y + 0.6, v = (i) => out[i] + inn * 0.36
  for (let i = 0; i + 1 < us.length; i++) {
    m.quad(P(us[i], out[i], y), P(us[i + 1], out[i + 1], y), P(us[i + 1], out[i + 1], y1), P(us[i], out[i], y1), col, nOut)
    m.quad(P(us[i], v(i), y), P(us[i + 1], v(i + 1), y), P(us[i + 1], v(i + 1), y1), P(us[i], v(i), y1), col, nOut.map((x) => -x))
    m.quad(P(us[i], out[i], y1), P(us[i + 1], out[i + 1], y1), P(us[i + 1], v(i + 1), y1), P(us[i], v(i), y1), col, [0, 1, 0])
  }
  const c = out[0] + inn * 0.18, n = Math.max(2, Math.round((m1 - m0) / 1.3)), Q = (u, w) => { const p = P(u, w, 0); return [p[0], p[2]] }
  for (let i = 0; i < n; i++) {
    const u = m0 + (m1 - m0) * (i + 0.5) / n
    merlon(m, [Q(u - 0.3, c - 0.18), Q(u + 0.3, c - 0.18), Q(u + 0.3, c + 0.18), Q(u - 0.3, c + 0.18)], y1, y + 1.2, col, rng)
  }
}

/** A curtain wall lofted like a section, its ends buried 0.6 m in the towers, its court face barely flaring. */
function wallShell(m, lay, s, rng) {
  const col = m.tint(STONE.wall), band = m.tint(BAND), top = 2 * H, half = CASTLE.wallT / 2, fl = 0.45
  const alongX = s.axis === 'x', inn = alongX ? s.inner[1] : s.inner[0]
  const a0 = (alongX ? lay.X(s.x0) : lay.Z(s.z0)) - 0.6, a1 = (alongX ? lay.X(s.x0 + s.w) : lay.Z(s.z0 + s.d)) + 0.6
  const cc = alongX ? lay.Z(s.z0) + C / 2 : lay.X(s.x0) + C / 2
  const us = [a0]
  for (let u = a0 + C / 2; u < a1 - 0.5; u += C / 2) us.push(u)
  us.push(a1)
  const P = (u, v, y) => (alongX ? [u, y, v] : [v, y, u])
  const j = () => (rng() - 0.5) * 0.06
  const rings = profile(top, fl, j).map(([y, off], r) => ({
    y, out: us.map(() => cc - inn * (half + off + (r > 1 && r < BAND_FROM ? j() : 0))), in: us.map(() => cc + inn * (half + (r >= BAND_FROM ? 0.06 : Math.min(off, 0.3)))),
  }))
  const nOut = alongX ? [0, 0, -inn] : [-inn, 0, 0]
  for (let r = 0; r + 1 < rings.length; r++) {
    const A = rings[r], B = rings[r + 1], cl = r >= BAND_FROM ? band : col
    for (let i = 0; i + 1 < us.length; i++) {
      m.quad(P(us[i], A.out[i], A.y), P(us[i + 1], A.out[i + 1], A.y), P(us[i + 1], B.out[i + 1], B.y), P(us[i], B.out[i], B.y), cl, nOut)
      m.quad(P(us[i], A.in[i], A.y), P(us[i + 1], A.in[i + 1], A.y), P(us[i + 1], B.in[i + 1], B.y), P(us[i], B.in[i], B.y), col, nOut.map((v) => -v))
    }
  }
  const T = rings.at(-1)
  for (let i = 0; i + 1 < us.length; i++) m.quad(P(us[i], T.out[i], top), P(us[i + 1], T.out[i + 1], top), P(us[i + 1], T.in[i + 1], top), P(us[i], T.in[i], top), col, [0, 1, 0])
  crenels(m, P, us, T.out, inn, nOut, a0 + 0.6, a1 - 0.6, top, col, rng)
}

/** A flight of solid steps from the ground (or y0) along `axis`, ending in a flat landing. */
function flight(m, f, col, scale = 1) {
  const n = Math.max(4, Math.round(f.rise / 0.4)), dir = Math.sign(f.a1 - f.a0)
  const run = Math.abs(f.a1 - f.a0) - f.landing
  for (let i = 0; i < n; i++) {
    const u0 = f.a0 + dir * run * i / n, u1 = i === n - 1 ? f.a1 : f.a0 + dir * run * (i + 1) / n
    // The landing stops just short of the cap it meets: the warp bends two tessellations of one plane apart by a few cm.
    const y = i === n - 1 ? f.rise - 0.08 : f.rise * (i + 1) / n
    if (f.axis === 'x') m.box(u0 * scale, -1, f.c0 * scale, u1 * scale, y * scale, f.c1 * scale, col)
    else m.box(f.c0 * scale, -1, u0 * scale, f.c1 * scale, y * scale, u1 * scale, col)
  }
}

/** Door leaves `hw` either side of `base` (its foot's middle) and `h` tall, facing horizontal n: a door's one, or a gate's pair
 * under an arch, its spandrels up to `h` filled in stone tinted `col`. */
export function leaves(m, base, n, hw, h, gate, col) {
  // The viewer's right, looking at the face.
  const r = [n[2], 0, -n[0]], P = (u, y) => [base[0] + r[0] * u, base[1] + y, base[2] + r[2] * u]
  if (!gate) return m.with(DOOR_SLOT, () => m.quad(P(-hw, 0), P(hw, 0), P(hw, h), P(-hw, h), LEAF, n, [[0, 0], [1, 0], [1, 1], [0, 1]]))
  const y0 = h * (1 - GATE_ARCH), arc = Array.from({ length: 9 }, (_, i) => [hw * Math.cos(i * Math.PI / 8), y0 + h * GATE_ARCH * Math.sin(i * Math.PI / 8)])
  const UV = ([u, y]) => [(u + hw) / (2 * hw), y / h], mid = [0, y0 / 2]
  const ring = [[-hw, 0], [hw, 0], ...arc]
  m.with(GATE_SLOT, () => ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; m.face([P(...mid), P(...p), P(...q)], n, LEAF, [UV(mid), UV(p), UV(q)]) }))
  for (let i = 0; i < 8; i++) { const c = i < 4 ? [hw, h] : [-hw, h]; m.face([P(...c), P(...arc[i]), P(...arc[i + 1])], n, col) }
}

/** A door as its leaves with a stone frame, bars over them when barred. A ground door stands proud of the root crown as a portal,
 * or the flare would bury it. */
function doorway(m, d, col) {
  const depth = d.y === 0 ? ROOT + 0.05 : 0.05, o = d.side * depth, hw = d.w / 2
  const along = (u0, u1, y0, y1, t0, t1) => (d.axis === 'x' ? m.box(d.x + t0, y0, d.z + u0, d.x + t1, y1, d.z + u1, col) : m.box(d.x + u0, y0, d.z + t0, d.x + u1, y1, d.z + t1, col))
  const n = d.axis === 'x' ? [d.side, 0, 0] : [0, 0, d.side]
  leaves(m, d.axis === 'x' ? [d.x + o, d.y, d.z] : [d.x, d.y, d.z + o], n, hw, d.h, d.look === 'gate', col)
  const t0 = Math.min(-d.side * 0.1, d.side * (depth + 0.13)), t1 = Math.max(-d.side * 0.1, d.side * (depth + 0.13))
  along(-hw - 0.25, -hw, d.y, d.y + d.h + 0.25, t0, t1)
  along(hw, hw + 0.25, d.y, d.y + d.h + 0.25, t0, t1)
  along(-hw - 0.25, hw + 0.25, d.y + d.h, d.y + d.h + 0.3, t0, t1)
  if (d.look === 'barred' && m.full) for (const u of [-0.35, 0, 0.35]) along(u - 0.04, u + 0.04, d.y, d.y + d.h, o, o + d.side * 0.08)
}

/** A deck on a stone arch springing from the two faces it joins. The ends run 0.3 m into the masonry, so no end face lies in a
 * wall's plane. */
function bridge(m, b, col) {
  const A0 = Math.min(b.a0, b.a1), A1 = Math.max(b.a0, b.a1), mid = (A0 + A1) / 2, half = (A1 - A0) / 2
  const rise = Math.min(half * 0.75, 2.4), spring = b.y - 0.6 - rise, W = 1.1
  const us = [A0 - 0.3], ys = [spring]
  for (let i = 0; i <= 10; i++) { const t = i / 5 - 1; us.push(mid + t * half); ys.push(spring + rise * Math.sqrt(1 - t * t)) }
  us.push(A1 + 0.3); ys.push(spring)
  const P = (u, c, y) => (b.axis === 'x' ? [u, y, c] : [c, y, u]), across = b.axis === 'x' ? [0, 0, 1] : [1, 0, 0]
  for (let i = 0; i + 1 < us.length; i++) {
    const [u0, u1, y0, y1] = [us[i], us[i + 1], ys[i], ys[i + 1]]
    for (const s of [-1, 1]) m.quad(P(u0, b.c + s * W, y0), P(u1, b.c + s * W, y1), P(u1, b.c + s * W, b.y), P(u0, b.c + s * W, b.y), col, across.map((v) => v * s))
    // The soffit faces the arch's centre; the flat ends inside the masonry face down.
    const n = i === 0 || i === us.length - 2 ? [0, -1, 0] : sub(P(mid, b.c, spring), P((u0 + u1) / 2, b.c, (y0 + y1) / 2))
    m.quad(P(u0, b.c - W, y0), P(u1, b.c - W, y1), P(u1, b.c + W, y1), P(u0, b.c + W, y0), col, n)
  }
  const lo = us[0], hi = us.at(-1)
  m.quad(P(lo, b.c - W, b.y), P(hi, b.c - W, b.y), P(hi, b.c + W, b.y), P(lo, b.c + W, b.y), col, [0, 1, 0])
  const rail = (c0, c1) => (b.axis === 'x' ? m.box(lo, b.y, c0, hi, b.y + 0.9, c1, col) : m.box(c0, b.y, lo, c1, b.y + 0.9, hi, col))
  rail(b.c - W, b.c - 0.8); rail(b.c + 0.8, b.c + W)
}

/** A flagstone ramp falling 30 deg out of a ground door, long enough to dive into a hillside: a cambered top with bevelled edges,
 * widening and jittered station by station, its sides skirted below its foot. */
function ramp(m, d) {
  const s = d.side, flat = ROOT + 0.4, run = 11, slope = Math.tan(Math.PI / 6), deep = 0.05 - run * slope - 0.5, J = (a) => (m.rng() - 0.5) * a
  const P = (t, u, y) => (d.axis === 'x' ? [d.x + s * t, y, d.z + u] : [d.x + u, y, d.z + s * t])
  const out = d.axis === 'x' ? [s, 0, 0] : [0, 0, s], side = d.axis === 'x' ? [0, 0, 1] : [1, 0, 0]
  const ts = [-0.3, flat]
  for (let k = 1; k <= 8; k++) ts.push(flat + run * k / 8 + (k < 8 ? J(0.5) : 0))
  // Across each station: bevel foot, edge, crown, edge, bevel foot; the first station stays square inside the door.
  const rows = ts.map((t, k) => {
    const y = 0.05 - Math.max(0, t - flat) * slope + (k > 1 ? J(0.08) : 0), hw = d.w / 2 + 0.3 + Math.max(0, t - flat) / run * 0.9
    const e = k ? 0.3 + J(0.12) : 0.3, a = k ? J(0.15) : 0, b = k ? J(0.15) : 0
    return [[-hw - e + a, y - 0.3], [-hw + a, y], [J(0.2), y + 0.05], [hw + b, y], [hw + e + b, y - 0.3]].map(([u, yy]) => P(t, u, yy))
  })
  const down = (p) => [p[0], deep, p[2]], up = (k) => [side[0] * k, 1, side[2] * k], hint = [up(-1), up(0), up(0), up(1)]
  for (let k = 0; k + 1 < rows.length; k++) {
    const A = rows[k], B = rows[k + 1]
    for (let i = 0; i < 4; i++) m.quad(A[i], B[i], B[i + 1], A[i + 1], FLAG, hint[i])
    m.quad(A[0], B[0], down(B[0]), down(A[0]), FLAG, side.map((v) => -v))
    m.quad(A[4], B[4], down(B[4]), down(A[4]), FLAG, side)
  }
  const E = rows.at(-1)
  for (let i = 0; i < 4; i++) m.quad(E[i], E[i + 1], down(E[i + 1]), down(E[i]), FLAG, out)
}

/** The court's flagstone floor, solid so no terrain need show under it, and a ramp out of every door the entry uses. Unwarped, so
 * both stay true. UVs are in UV_METRES. */
export function courtGeometry(lay) {
  const m = new Mesher(lay.seed)
  m.box(lay.X(0), -1, lay.Z(0), lay.X(lay.cw), 0.05, lay.Z(lay.cd), FLAG)
  for (const e of lay.edges) if (e.a.kind === 'entry') ramp(m, e.doors[0])
  return m.arrays()
}

/** `warp: false` builds the straight shell, which the gate scans for coplanar overlaps (the warp moves coincident faces together).
 * `full: false` is the mid-distance tier: no merlons, arrow slits, door bars or props. */
export function exteriorGeometry(lay, { warp = true, full = true } = {}) {
  const m = new Mesher(lay.seed, warp ? warpOf(lay.seed, 1) : null, full)
  lay.sections.forEach((s, i) => {
    const rng = mulberry32(lay.seed * 131 + i)
    if (s.kind === 'wall') wallShell(m, lay, s, rng)
    else sectionShell(m, lay, s, rng)
  })
  for (const e of lay.edges) {
    const seen = e.a.out || e.b.out || e.kind === 'bridge'
    if (seen) for (const d of e.doors) doorway(m, d, m.tint(BAND))
    if (e.flight) flight(m, e.flight, m.tint(STONE.wall))
    if (e.bridge) bridge(m, e.bridge, m.tint(STONE.wall))
    m.with(WOOD_SLOT, () => {
      if (e.ladder) m.box(e.ladder.x - 0.5, (e.ladder.k + 1) * H, e.ladder.z - 0.5, e.ladder.x + 0.5, (e.ladder.k + 1) * H + 0.2, e.ladder.z + 0.5, m.tint(DARKWOOD))
      if (e.rope) m.box(e.rope.x - 0.05, -CASTLE.raise, e.rope.z - 0.05, e.rope.x + 0.05, e.rope.top + 0.45, e.rope.z + 0.05, ROPE)
    }, true)
  }
  // The summit chest, open: its lid stands up behind it.
  const [sx, sy, sz] = lay.nodes.find((n) => n.kind === 'summit').pos
  m.with(WOOD_SLOT, () => {
    m.box(sx - 0.5, sy - 0.4, sz - 0.3, sx + 0.5, sy + 0.2, sz + 0.3, PLANK)
    m.box(sx - 0.52, sy + 0.2, sz - 0.36, sx + 0.52, sy + 0.8, sz - 0.28, DARKWOOD)
    m.box(sx - 0.53, sy + 0.05, sz - 0.31, sx + 0.53, sy + 0.12, sz + 0.31, GOLD)
  }, true)
  if (full) for (const o of [...courtProps(lay), ...roofProps(lay)]) prop(m, o)
  return m.arrays()
}

// Prop colours multiply the plank or stone texture; cloth and straw ride the planks.
const PLANK = rgb(0xe6d6bf), DARKWOOD = rgb(0x9c8068), CLOTH = rgb(0xd9cfb8), STRAW = rgb(0xf2d98a), RED = rgb(0xa8342c), IRON = rgb(0x4a4744), EMBER = rgb(0xff9a3c), ROPE = rgb(0xe0c890)
const BLUE = rgb(0x3a5a9a), GREEN = rgb(0x4f7a3a), CLAY = rgb(0xb06a40), BREAD = rgb(0xd2a060), SAND = rgb(0xd8c49a), WATER = rgb(0x3d6a78), PARCH = rgb(0xead9a8), PEWTER = rgb(0x9a9894)
// Wall hangings and anything else picked by where it stands, so it is the same in every build.
const DYES = [RED, BLUE, GREEN]
const dye = (o) => DYES[Math.abs(Math.floor(o.x * 7.3 + o.z * 13.1)) % 3]
// Kinds hung high on a wall or from the ceiling, left out of a storey's waist-high cut.
const HIGH = new Set(['chandelier', 'banner', 'tapestry', 'herbs', 'sconce', 'shields'])

/** A furnish.js prop record drawn from primitives in its own frame: u along its width, v along its depth (its back at -d/2),
 * y up from its floor. Everything is planks but the well's stone. */
export function prop(m, o) {
  const c = Math.cos(o.yaw), s = Math.sin(o.yaw)
  const W = (u, y, v) => [o.x + u * c + v * s, o.y + y, o.z - u * s + v * c]
  // Only what hangs overhead (`under`) draws its bottom.
  const blk = (u0, y0, v0, u1, y1, v1, col, under = false) => m.hexa([W(u0, y0, v0), W(u1, y0, v0), W(u1, y0, v1), W(u0, y0, v1), W(u0, y1, v0), W(u1, y1, v0), W(u1, y1, v1), W(u0, y1, v1)], col, !under)
  // An n-gon prism of radius r: its sides and the cap at `y1`. Upright about (u, v), or a log lying along u with its axis at (y, v).
  const ring = (P, n, col, cap, out) => {
    for (let i = 0; i < n; i++) m.quad(P(i, 0), P(i + 1, 0), P(i + 1, 1), P(i, 1), col, out(i + 0.5))
    for (let i = 1; i < n - 1; i++) m.face([P(0, 1), P(i, 1), P(i + 1, 1)], cap, col)
  }
  const prism = (u, v, y0, y1, r, n, col) => {
    const ang = (i) => i * Math.PI * 2 / n
    ring((i, t) => W(u + Math.cos(ang(i)) * r, t ? y1 : y0, v + Math.sin(ang(i)) * r), n, col, [0, 1, 0], (i) => [Math.cos(ang(i)) * c + Math.sin(ang(i)) * s, 0, -Math.cos(ang(i)) * s + Math.sin(ang(i)) * c])
  }
  const log = (u0, u1, y, v, r, col) => {
    const ang = (i) => i * Math.PI / 3, P = (i, t) => W(t ? u1 : u0, y + Math.cos(ang(i)) * r, v + Math.sin(ang(i)) * r)
    ring(P, 6, col, [c, 0, -s], (i) => [Math.sin(ang(i)) * s, Math.cos(ang(i)), Math.sin(ang(i)) * c])
    for (let i = 1; i < 5; i++) m.face([P(0, 0), P(i, 0), P(i + 1, 0)], [-c, 0, s], col)
  }
  // A disc of radius r facing +v, about (u, y), from v0 to v1, both faces drawn.
  const drum = (u, y, v0, v1, r, n, col) => {
    const ang = (i) => i * Math.PI * 2 / n, P = (i, t) => W(u + Math.cos(ang(i)) * r, y + Math.sin(ang(i)) * r, t ? v1 : v0)
    ring(P, n, col, [s, 0, c], (i) => [Math.cos(ang(i)) * c, Math.sin(ang(i)), -Math.cos(ang(i)) * s])
    for (let i = 1; i < n - 1; i++) m.face([P(0, 0), P(i, 0), P(i + 1, 0)], [-s, 0, -c], col)
  }
  const legs = (hw, hd, h, t, col) => { for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) blk(a * hw - t, 0, b * hd - t, a * hw + t, h, b * hd + t, col) }
  const w = o.w / 2, d = o.d / 2, wood = m.tint(PLANK, 0.16), stone = m.tint(STONE.wall, 0.1)
  const masonry = (fn) => m.with(STONE_SLOT, fn)
  m.with(WOOD_SLOT, () => {
    switch (o.kind) {
      case 'barrel': prism(0, 0, 0, 0.9, 0.33, 8, wood); prism(0, 0, 0.2, 0.26, 0.345, 8, IRON); prism(0, 0, 0.64, 0.7, 0.345, 8, IRON); break
      case 'crate': blk(-w, 0, -d, w, 0.8, d, wood); blk(-w - 0.02, 0.36, -d - 0.02, w + 0.02, 0.44, d + 0.02, DARKWOOD); break
      case 'sacks': for (const u of [-0.22, 0.22]) blk(u - 0.2, 0, -d, u + 0.2, 0.55, d, m.tint(CLOTH, 0.12)); blk(-0.2, 0.55, -0.25, 0.2, 0.9, 0.25, m.tint(CLOTH, 0.12)); break
      case 'bench': blk(-w, 0.4, -d, w, 0.47, d, wood); for (const u of [-w + 0.15, w - 0.15]) blk(u - 0.05, 0, -d + 0.05, u + 0.05, 0.4, d - 0.05, DARKWOOD); break
      case 'table': case 'longtable': blk(-w, 0.74, -d, w, 0.82, d, wood); legs(w - 0.12, d - 0.12, 0.74, 0.05, DARKWOOD); break
      case 'stool': blk(-w, 0.42, -d, w, 0.47, d, wood); blk(-0.05, 0, -0.05, 0.05, 0.42, 0.05, DARKWOOD); break
      case 'bed': blk(-w, 0, -d, w, 0.35, d, DARKWOOD); blk(-w + 0.05, 0.35, -d + 0.1, w - 0.05, 0.5, d - 0.05, m.tint(CLOTH, 0.12)); blk(-w, 0, -d, w, 0.95, -d + 0.08, DARKWOOD); blk(-w + 0.15, 0.5, -d + 0.15, w - 0.15, 0.6, -d + 0.45, m.tint(CLOTH, 0.05)); break
      case 'chest': blk(-w, 0, -d, w, 0.5, d, wood); blk(-w - 0.02, 0.5, -d - 0.02, w + 0.02, 0.6, d + 0.02, DARKWOOD); blk(-0.08, 0.32, d, 0.08, 0.5, d + 0.03, GOLD); break
      case 'rack':
        for (const u of [-w + 0.05, w - 0.05]) blk(u - 0.05, 0, -0.05, u + 0.05, 1.6, 0.05, DARKWOOD)
        for (const y of [0.3, 1.3]) blk(-w, y, -0.04, w, y + 0.06, 0.04, DARKWOOD)
        for (let u = -w + 0.25; u < w - 0.2; u += 0.22) blk(u - 0.02, 0.05, 0.06, u + 0.02, 1.9, 0.1, wood)
        break
      case 'shelf':
        for (const u of [-w, w - 0.06]) blk(u, 0, -d, u + 0.06, 1.8, d, DARKWOOD)
        blk(-w + 0.06, 0, -d, w - 0.06, 1.8, -d + 0.03, DARKWOOD)
        for (const y of [0.05, 0.6, 1.15, 1.7]) blk(-w + 0.06, y, -d + 0.03, w - 0.06, y + 0.05, d - 0.01, wood)
        for (let u = -w + 0.2; u < w - 0.2; u += 0.3) blk(u - 0.08, 0.65, -d + 0.05, u + 0.08, 0.65 + 0.2 + (u * 7 % 1 + 1) % 1 * 0.15, d - 0.1, m.tint(CLOTH, 0.4))
        break
      case 'hay': blk(-w, 0, -d, w, 0.7, d, m.tint(STRAW, 0.12)); break
      case 'cart':
        blk(-w, 0.55, -d, w, 0.65, d, wood)
        for (const u of [-w, w - 0.06]) blk(u, 0.65, -d, u + 0.06, 1.0, d, wood)
        blk(-0.04, 0.45, d, 0.04, 0.55, d + 1.2, DARKWOOD)
        for (const u of [-w - 0.08, w + 0.02]) log(u, u + 0.06, 0.45, 0.2, 0.45, DARKWOOD)
        break
      case 'well':
        m.with(STONE_SLOT, () => prism(0, 0, 0, 0.8, 0.8, 10, m.tint(STONE.wall)))
        prism(0, 0, 0.6, 0.62, 0.62, 10, DARK)
        for (const u of [-0.72, 0.66]) blk(u, 0.8, -0.06, u + 0.06, 2.2, 0.06, DARKWOOD)
        blk(-0.8, 2.2, -0.08, 0.8, 2.3, 0.08, DARKWOOD)
        prism(0, 0, 1.5, 1.8, 0.1, 6, ROPE)
        break
      case 'dummy': blk(-0.05, 0, -0.05, 0.05, 1.6, 0.05, DARKWOOD); blk(-0.45, 1.25, -0.04, 0.45, 1.32, 0.04, DARKWOOD); blk(-0.2, 0.8, -0.15, 0.2, 1.45, 0.15, m.tint(STRAW, 0.1)); blk(-0.12, 1.45, -0.12, 0.12, 1.7, 0.12, m.tint(CLOTH, 0.1)); break
      case 'throne':
        blk(-w, 0, -d, w, 0.5, d, DARKWOOD); blk(-w, 0.5, -d, w, 1.7, -d + 0.12, DARKWOOD)
        for (const u of [-w, w - 0.1]) blk(u, 0.5, -d, u + 0.1, 0.8, d, DARKWOOD)
        blk(-w + 0.08, 0.5, -d + 0.12, w - 0.08, 0.56, d - 0.05, RED); blk(-w - 0.02, 1.62, -d - 0.02, w + 0.02, 1.76, -d + 0.14, GOLD)
        break
      case 'brazier': legs(0.2, 0.2, 0.7, 0.025, IRON); prism(0, 0, 0.7, 0.95, 0.3, 8, IRON); prism(0, 0, 0.95, 1.0, 0.24, 8, EMBER); break
      case 'banner': blk(-w, 3.3, -d, w, 3.36, d + 0.04, DARKWOOD); blk(-w + 0.08, 1.4, -d + 0.02, w - 0.08, 3.3, -d + 0.04, m.tint(RED, 0.1)); blk(-0.2, 2.2, -d + 0.035, 0.2, 2.6, -d + 0.05, GOLD); break
      case 'woodpile':
        // Each log's own length, so no two end caps share a plane.
        for (let row = 0; row < 2; row++) for (let i = 0; i < 3 - row; i++) {
          const j = (row * 3 + i) * 0.013
          log(-w + j, w - 0.04 + j, 0.12 + row * 0.19, -d + 0.14 + (i + row * 0.5) * 0.2, 0.11, m.tint(DARKWOOD, 0.2))
        }
        break
      case 'hearth':
        masonry(() => {
          blk(-w, 0, -d, w, 0.15, d, stone)
          for (const u of [-w, w - 0.35]) blk(u, 0.15, -d, u + 0.35, 1.3, d, stone)
          blk(-w - 0.1, 1.3, -d, w + 0.1, 1.5, d + 0.1, stone)
          blk(-w + 0.2, 1.5, -d, w - 0.2, 3.4, -d + 0.6, stone)
        })
        blk(-w + 0.35, 0.15, -d, w - 0.35, 1.3, -d + 0.12, DARK)
        blk(-0.45, 0.15, -0.25, 0.45, 0.19, 0.25, EMBER)
        for (const v of [-0.12, 0.12]) log(-0.5 + v, 0.5 + v, 0.26, v, 0.08, DARKWOOD)
        break
      case 'oven':
        masonry(() => { blk(-w, 0, -d, w, 0.9, d, stone); prism(0, -0.05, 0.9, 1.45, 0.55, 8, stone) })
        blk(-0.3, 0.25, d - 0.01, 0.3, 0.6, d + 0.02, DARK)
        break
      case 'cauldron':
        legs(0.26, 0.26, 0.55, 0.025, IRON)
        prism(0, 0, 0.2, 0.72, 0.33, 8, IRON); prism(0, 0, 0.72, 0.74, 0.28, 8, GREEN)
        log(-0.25, 0.25, 0.06, 0, 0.05, DARKWOOD)
        break
      case 'bunk':
        legs(w - 0.03, d - 0.03, 1.9, 0.04, DARKWOOD)
        for (const y of [0.25, 1.25]) {
          blk(-w, y, -d, w, y + 0.1, d, DARKWOOD, y > 1)
          blk(-w + 0.05, y + 0.1, -d + 0.05, w - 0.05, y + 0.25, d - 0.05, m.tint(CLOTH, 0.12))
          blk(-w + 0.15, y + 0.25, -d + 0.12, w - 0.15, y + 0.33, -d + 0.4, m.tint(CLOTH, 0.05))
        }
        break
      case 'shields':
        for (const [i, u] of [-0.52, 0, 0.52].entries()) {
          const col = DYES[(i + Math.abs(Math.floor(o.x))) % 3]
          blk(u - 0.22, 1.75, -d, u + 0.22, 2.1, -d + 0.06, col); blk(u - 0.15, 1.5, -d, u + 0.15, 1.75, -d + 0.06, col)
          blk(u - 0.06, 1.8, -d + 0.05, u + 0.06, 1.92, -d + 0.1, GOLD)
        }
        break
      case 'armour':
        blk(-0.25, 0, -0.2, 0.25, 0.06, 0.2, DARKWOOD); blk(-0.04, 0.06, -0.04, 0.04, 1.45, 0.04, DARKWOOD)
        blk(-0.2, 0.6, -0.12, 0.2, 0.9, 0.12, m.tint(CLOTH, 0.1)); blk(-0.22, 0.9, -0.13, 0.22, 1.5, 0.13, IRON)
        blk(-0.3, 1.4, -0.14, 0.3, 1.55, 0.14, IRON); blk(-0.12, 1.55, -0.12, 0.12, 1.85, 0.12, IRON)
        break
      case 'arrows':
        prism(0, 0, 0, 0.6, 0.22, 8, wood)
        for (let i = 0; i < 7; i++) {
          const a = i * 2.4, r = 0.05 + (i % 3) * 0.05, u = Math.cos(a) * r, v = Math.sin(a) * r, h = 1.0 + (i % 2) * 0.05
          blk(u - 0.01, 0.5, v - 0.01, u + 0.01, h, v + 0.01, PLANK); blk(u - 0.02, h, v - 0.02, u + 0.02, h + 0.1, v + 0.02, RED)
        }
        break
      case 'grind':
        legs(0.32, 0.15, 0.62, 0.03, DARKWOOD)
        masonry(() => drum(0, 0.75, -0.06, 0.06, 0.3, 10, stone))
        drum(0, 0.75, -0.3, -0.06, 0.03, 4, IRON); drum(0, 0.75, 0.06, 0.3, 0.03, 4, IRON)
        break
      case 'anvil':
        blk(-0.18, 0, -0.15, 0.18, 0.45, 0.15, DARKWOOD); blk(-0.12, 0.45, -0.08, 0.12, 0.6, 0.08, IRON)
        blk(-0.3, 0.6, -0.12, 0.28, 0.75, 0.12, IRON); blk(0.27, 0.64, -0.06, 0.38, 0.73, 0.06, IRON)
        break
      case 'dais': masonry(() => blk(-w, 0, -d, w, 0.3, d, stone)); blk(-w + 0.2, 0.3, -d + 0.2, w - 0.2, 0.32, d - 0.2, RED); break
      case 'carpet':
        blk(-w + 0.05, 0, -d + 0.02, w - 0.05, 0.03, d - 0.02, RED)
        for (const u of [-w, w - 0.12]) blk(u, 0, -d + 0.03, u + 0.12, 0.035, d - 0.03, GOLD)
        break
      case 'tapestry':
        blk(-w - 0.05, 3.4, -d - 0.05, w + 0.05, 3.46, -d + 0.06, DARKWOOD, true)
        blk(-w, 1.2, -d + 0.01, w, 3.4, -d + 0.04, m.tint(dye(o), 0.1), true)
        blk(-w + 0.1, 1.3, -d + 0.035, w - 0.1, 1.36, -d + 0.05, GOLD); blk(-0.3, 2.0, -d + 0.035, 0.3, 2.8, -d + 0.05, GOLD)
        break
      case 'chandelier':
        for (const v of [-0.46, 0.46]) blk(-0.5, 3.6, v - 0.04, 0.5, 3.66, v + 0.04, IRON, true)
        for (const u of [-0.46, 0.46]) blk(u - 0.04, 3.61, -0.44, u + 0.04, 3.65, 0.44, IRON, true)
        blk(-0.48, 3.62, -0.02, 0.48, 3.68, 0.02, IRON, true); blk(-0.02, 3.63, -0.48, 0.02, 3.69, 0.48, IRON, true)
        blk(-0.02, 3.69, -0.02, 0.02, H * V - 0.25, 0.02, IRON)
        for (const [u, v] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]]) prism(u, v, 3.66, 3.88, 0.03, 4, CLOTH)
        break
      case 'fourposter': {
        const cloth = m.tint(dye(o), 0.08)
        legs(w - 0.03, d - 0.03, 2.24, 0.05, DARKWOOD)
        blk(-w, 0.2, -d, w, 0.4, d, DARKWOOD); blk(-w, 0.4, -d, w, 1.3, -d + 0.08, DARKWOOD)
        blk(-w + 0.05, 0.4, -d + 0.05, w - 0.05, 0.6, d - 0.05, m.tint(CLOTH, 0.05)); blk(-w + 0.04, 0.45, -d + 0.6, w - 0.04, 0.62, d - 0.04, cloth)
        blk(-w + 0.15, 0.6, -d + 0.12, w - 0.15, 0.72, -d + 0.42, m.tint(CLOTH, 0.05))
        blk(-w - 0.04, 2.2, -d - 0.04, w + 0.04, 2.3, d + 0.04, cloth, true)
        break
      }
      case 'wardrobe':
        blk(-w, 0, -d, w, 1.95, d, DARKWOOD); blk(-w - 0.04, 1.92, -d + 0.01, w + 0.04, 2.0, d + 0.04, DARKWOOD)
        blk(-0.015, 0.1, d - 0.01, 0.015, 1.85, d + 0.015, IRON)
        for (const u of [-0.08, 0.05]) blk(u, 0.9, d - 0.01, u + 0.03, 1.1, d + 0.03, GOLD)
        break
      case 'desk':
        blk(-w, 0.72, -d, w, 0.8, d, wood); legs(w - 0.08, d - 0.08, 0.72, 0.04, DARKWOOD)
        blk(w - 0.45, 0.45, -d + 0.05, w - 0.05, 0.72, d - 0.05, DARKWOOD)
        break
      case 'rug': blk(-w, 0, -d, w, 0.02, d, m.tint(dye(o), 0.1)); blk(-w + 0.15, 0, -d + 0.15, w - 0.15, 0.025, d - 0.15, GOLD); blk(-w + 0.3, 0, -d + 0.3, w - 0.3, 0.03, d - 0.3, m.tint(dye(o), 0.2)); break
      case 'altar':
        masonry(() => blk(-w, 0, -d, w, 0.95, d, stone))
        blk(-w - 0.02, 0.95, -d - 0.02, w + 0.02, 1.0, d + 0.02, CLOTH); blk(-0.25, 0.55, d - 0.01, 0.25, 1.01, d + 0.03, RED)
        blk(-0.1, 1.0, -d + 0.1, 0.1, 1.3, -d + 0.16, GOLD)
        for (const u of [-0.55, 0.55]) prism(u, 0, 1.0, 1.28, 0.03, 4, CLOTH)
        break
      case 'maptable':
        blk(-w, 0.75, -d, w, 0.83, d, wood); legs(w - 0.12, d - 0.12, 0.75, 0.05, DARKWOOD)
        blk(-w + 0.2, 0.83, -d + 0.15, w - 0.2, 0.835, d - 0.15, PARCH)
        break
      case 'cot':
        blk(-w, 0.3, -d, w, 0.38, d, wood); legs(w - 0.05, d - 0.05, 0.3, 0.03, DARKWOOD)
        blk(-w + 0.04, 0.38, -d + 0.04, w - 0.04, 0.5, d - 0.04, m.tint(CLOTH, 0.12))
        break
      case 'workbench':
        blk(-w, 0.82, -d, w, 0.9, d, wood); legs(w - 0.08, d - 0.08, 0.82, 0.05, DARKWOOD)
        blk(-w + 0.1, 0.2, -d + 0.1, w - 0.1, 0.25, d - 0.1, DARKWOOD)
        blk(-w + 0.1, 0.9, -0.1, -w + 0.3, 1.05, 0.1, IRON); blk(0.1, 0.9, -0.25, 0.9, 0.95, 0.0, m.tint(PLANK, 0.1))
        break
      case 'bucket': prism(0, 0, 0, 0.4, 0.18, 8, wood); prism(0, 0, 0.28, 0.31, 0.19, 8, IRON); prism(0, 0, 0.4, 0.405, 0.15, 8, WATER); break
      case 'basket': prism(0, 0, 0, 0.35, 0.24, 8, m.tint(STRAW, 0.1)); prism(0, 0, 0.35, 0.45, 0.2, 6, BREAD); break
      case 'candles':
        prism(0, 0, 0, 0.05, 0.15, 6, IRON); blk(-0.02, 0.05, -0.02, 0.02, 1.2, 0.02, IRON)
        prism(0, 0, 1.2, 1.23, 0.08, 6, IRON); prism(0, 0, 1.23, 1.35, 0.03, 4, CLOTH)
        break
      case 'cask':
        for (const u of [-w + 0.1, w - 0.2]) blk(u, 0, -d + 0.05, u + 0.1, 0.3, d - 0.05, DARKWOOD)
        log(-w + 0.05, w - 0.05, 0.45, 0, 0.4, wood)
        for (const u of [-w + 0.2, w - 0.26]) log(u, u + 0.06, 0.45, 0, 0.41, IRON)
        blk(w - 0.06, 0.25, -0.03, w + 0.04, 0.31, 0.03, DARKWOOD)
        break
      case 'herbs':
        blk(-w, 2.4, -d - 0.05, w, 2.45, -d + 0.06, DARKWOOD, true)
        for (let u = -w + 0.18; u < w - 0.1; u += 0.36) blk(u - 0.08, 1.95 + (u * 5 % 0.1), -d + 0.02, u + 0.08, 2.4, -d + 0.15, m.tint(GREEN, 0.3), true)
        break
      case 'sconce':
        blk(-0.04, 2.0, -d - 0.06, 0.04, 2.08, 0.06, IRON, true); prism(0, 0.08, 2.05, 2.2, 0.06, 6, IRON)
        blk(-0.025, 2.2, 0.055, 0.025, 2.3, 0.105, DARKWOOD)
        break
      case 'target':
        for (const u of [-0.5, 0.42]) blk(u, 0, -0.05, u + 0.08, 1.4, 0.05, DARKWOOD)
        drum(0, 1.0, -0.1, 0.1, 0.55, 10, m.tint(STRAW, 0.1)); drum(0, 1.0, 0.09, 0.12, 0.35, 10, RED); drum(0, 1.0, 0.11, 0.14, 0.15, 8, GOLD)
        break
      case 'pell': blk(-0.2, 0, -0.2, 0.2, 0.1, 0.2, DARKWOOD); prism(0, 0, 0.1, 1.6, 0.1, 6, DARKWOOD); prism(0, 0, 0.9, 1.1, 0.11, 6, ROPE); break
      case 'yard': blk(-w, 0, -d, w, 0.02, d, SAND); break
      case 'forge':
        masonry(() => {
          blk(-w, 0, -d, w, 0.8, d, stone)
          blk(-0.95, 0.8, -d, 0.25, 2.3, -d + 0.35, stone); blk(-0.65, 2.3, -d, -0.05, 3.8, -d + 0.3, stone)
        })
        blk(-0.75, 0.8, -0.55, 0.05, 0.84, 0.15, EMBER); blk(0.4, 0.8, -0.3, 0.95, 0.95, 0.3, DARKWOOD)
        break
      case 'trough':
        for (const u of [-w, w - 0.06]) blk(u, 0, -d, u + 0.06, 0.6, d, wood)
        for (const v of [-d, d - 0.06]) blk(-w + 0.06, 0, v, w - 0.06, 0.6, v + 0.06, wood)
        blk(-w + 0.06, 0, -d + 0.06, w - 0.06, 0.48, d - 0.06, WATER)
        break
      case 'block': prism(0, 0, 0, 0.5, 0.28, 8, DARKWOOD); blk(0.02, 0.45, -0.03, 0.07, 0.85, 0.03, m.tint(PLANK, 0.1)); blk(-0.04, 0.48, -0.12, 0.08, 0.56, 0.0, IRON); break
      case 'bowrack':
        for (const u of [-w + 0.01, w - 0.09]) blk(u, 0, -d, u + 0.08, 1.5, -d + 0.08, DARKWOOD)
        for (const y of [0.25, 1.2]) blk(-w + 0.09, y, -d, w - 0.09, y + 0.05, -d + 0.08, DARKWOOD)
        for (let u = -w + 0.3; u < w - 0.2; u += 0.3) blk(u - 0.015, 0.3, -d + 0.1, u + 0.015, 1.45, -d + 0.13, DARKWOOD)
        break
      case 'stones':
        masonry(() => {
          for (const [u, v, y0, y1, r, n] of [[-0.2, -0.15, 0, 0.3, 0.22, 6], [0.2, 0.05, 0, 0.25, 0.2, 5], [-0.05, 0.22, 0, 0.22, 0.18, 5], [0, 0, 0.25, 0.45, 0.17, 5]]) prism(u, v, y0, y1, r, n, m.tint(STONE.wall, 0.2))
        })
        break
      case 'jug': prism(0, 0, 0, 0.22, 0.08, 6, CLAY); prism(0, 0, 0.22, 0.28, 0.05, 6, CLAY); break
      case 'bowl': prism(0, 0, 0, 0.07, 0.12, 6, DARKWOOD); break
      case 'loaf': blk(-w, 0, -d, w, 0.1, d, BREAD); break
      case 'cup': prism(0, 0, 0, 0.1, 0.045, 5, PEWTER); break
      case 'candle': prism(0, 0, 0, 0.17, 0.025, 4, CLOTH); break
      case 'book': blk(-w, 0, -d, w, 0.05, d, dye(o)); break
      default: throw new Error(`castle prop: no mesh for '${o.kind}'`)
    }
  }, true)
}

/** Prop records (furnish.js) as one geometry: what the checks scan for each kind on its own. */
export function propGeometry(records, seed = 1) {
  const m = new Mesher(seed)
  for (const o of records) prop(m, o)
  return m.arrays()
}

/** The rect r minus the square hole (cx, cz, half), as up to four rects [x0, z0, x1, z1]. */
function minusHole([x0, z0, x1, z1], cx, cz, h) {
  const [hx0, hz0, hx1, hz1] = [Math.max(x0, cx - h), Math.max(z0, cz - h), Math.min(x1, cx + h), Math.min(z1, cz + h)]
  if (hx0 >= hx1 || hz0 >= hz1) return [[x0, z0, x1, z1]]
  return [[x0, z0, x1, hz0], [x0, hz1, x1, z1], [x0, hz0, hx0, hz1], [hx1, hz0, x1, hz1]].filter(([a, b, c, d]) => c - a > 0.01 && d - b > 0.01)
}

/** A spiral stair's steps and post about interior (cx, cz), climbing one storey from y. */
export function spiralSteps(m, cx, cz, y) {
  const SH = H * V, a0 = spiralStart(cx, cz), { R, post, steps } = SPIRAL, rise = SH / steps
  const P = (ang, rad, yy) => [cx + Math.cos(ang) * rad, yy, cz + Math.sin(ang) * rad]
  for (let i = 0; i < steps; i++) {
    const a = a0 + i * Math.PI / 8, b = a + Math.PI / 8, y0 = y + i * rise, y1 = y0 + rise
    m.hexa([P(a, post, y0), P(a, R, y0), P(b, R, y0), P(b, post, y0), P(a, post, y1), P(a, R, y1), P(b, R, y1), P(b, post, y1)], m.tint(STEP))
  }
  m.box(cx - post, y, cz - post, cx + post, y + SH, cz + post, m.tint(STEP))
}

/** The interior's warp. It bends walls across but leaves every height true, so floors stay level under the props and the walk. */
export function interiorWarp(lay) {
  const w = warpOf(lay.seed + 1, S * 0.6)
  return (x, y, z) => { const p = w(x, y, z); return [p[0], y, p[2]] }
}
/** Prop record o moved with the walls about it, so what stands against one stays against it. Props themselves are drawn straight. */
export const warpedProp = (warp, o) => { const [x, , z] = warp(o.x, o.y, o.z); return { ...o, x, z } }

/** One geometry per storey, so a cut can hide the storeys above it. Interior units are exterior metres times CASTLE.scale. */
export function interiorGeometries(lay) {
  const { X, Z } = lay
  const meshers = new Map(), warp = interiorWarp(lay)
  const at = (k) => { if (!meshers.has(k)) meshers.set(k, new Mesher(lay.seed * 31 + k, warp)); return meshers.get(k) }
  const SH = H * V, WT = 0.3, INSET = 0.4
  lay.nodes.forEach((n, ni) => {
    if (n.kind !== 'room') return
    const y = n.k * SH
    for (const [m, low] of [[at(n.k), false], [at(-1 - n.k), true]]) {
      const rng = mulberry32(lay.seed * 977 + ni)
      const ex = [X(n.x0), Z(n.z0), X(n.x0 + n.w), Z(n.z0 + n.d)]
      const [ix0, iz0, ix1, iz1] = [(ex[0] + INSET) * S, (ex[1] + INSET) * S, (ex[2] - INSET) * S, (ex[3] - INSET) * S]
      const mine = lay.edges.filter((e) => e.a === n || e.b === n)
      // The dungeon's spiral comes up into its ground room through a hole as any other does.
      const holes = [...mine.filter((e) => e.stair && e.b === n), ...(dungeonPlan(lay).stair.node === n ? [{ stair: dungeonPlan(lay).stair }] : [])], Rh = SPIRAL.R + 0.05
      const slab = holes.reduce((rects, e) => rects.flatMap((r) => minusHole(r, e.stair.x * S, e.stair.z * S, Rh)), [[ix0, iz0, ix1, iz1]])
      const floor = m.tint(FLOOR[n.sec.kind])
      for (const [a, b, c, d] of slab) m.box(a, y - 0.3, b, c, y, d, floor, true)
      // Each square hole filled back but over the high steps, as faces top and under with the open sector's rim: square corners
      // fall on segment bearings, so a filled segment is one triangle.
      for (const e of holes) {
        const cx = e.stair.x * S, cz = e.stair.z * S, a0 = spiralStart(cx, cz), c = [cx, cz]
        const ring = (a, r) => [cx + Math.cos(a) * r, cz + Math.sin(a) * r], toSquare = (a) => ring(a, Rh / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a))))
        const both = (q) => {
          for (const [yy, away] of [[y, y - 1], [y - 0.3, y + 1]]) {
            m.tri(at3(q[0], yy), at3(q[1], yy), at3(q[2], yy), floor, at3(q[0], away))
            if (q[3]) m.tri(at3(q[0], yy), at3(q[2], yy), at3(q[3], yy), floor, at3(q[0], away))
          }
        }
        const rim = (p, q, n) => m.quad(at3(p, y - 0.3), at3(q, y - 0.3), at3(q, y), at3(p, y), floor, n)
        for (let j = 0; j < 16; j++) {
          const a = a0 + j * Math.PI / 8, b = a + Math.PI / 8, open = j >= SPIRAL.hole && j < SPIRAL.steps
          if (!open) { both([c, toSquare(a), toSquare(b)]); continue }
          both([ring(a, Rh), ring(b, Rh), toSquare(b), toSquare(a)])
          rim(ring(a, Rh), ring(b, Rh), [-Math.cos(a + Math.PI / 16), 0, -Math.sin(a + Math.PI / 16)])
        }
        for (const [j, sg] of [[SPIRAL.hole, 1], [SPIRAL.steps, -1]]) { const a = a0 + j * Math.PI / 8; rim(c, ring(a, Rh), [-Math.sin(a) * sg, 0, Math.cos(a) * sg]) }
      }
      // The top storey's ceiling; below it the next storey's floor slab is the ceiling.
      if (!low && n.k === n.sec.floors - 1) m.box(ix0, y + SH - 0.3, iz0, ix1, y + SH, iz1, m.tint(INNER), true)
      const doors = mine.flatMap((e) => e.doors).filter((d) => d.axis === 'x' ? Math.abs(d.x - ex[0]) < 1e-6 || Math.abs(d.x - ex[2]) < 1e-6 : Math.abs(d.z - ex[1]) < 1e-6 || Math.abs(d.z - ex[3]) < 1e-6)
      const wall = m.tint(INNER), top = y + (low ? 1.4 : SH - 0.3)
      if (n.sec.round) {
        // Twelve slabs round the room; the slab a door faces keeps only its lintel. Edge i is centred on bearing (i + 1) * 30 deg.
        const cx = (ex[0] + ex[2]) / 2 * S, cz = (ex[1] + ex[3]) / 2 * S, R = (ex[2] - ex[0] - 2 * INSET) / 2 * S / Math.cos(Math.PI / 12)
        const O = Array.from({ length: 12 }, (_, i) => [cx + Math.cos((i + 0.5) * Math.PI / 6) * R, cz + Math.sin((i + 0.5) * Math.PI / 6) * R])
        const I = offsetLoop(O, edgeNormals(O), -WT)
        for (let i = 0; i < 12; i++) {
          const i2 = (i + 1) % 12, b = (i + 1) * Math.PI / 6
          const d = doors.find((dd) => Math.abs(Math.atan2(Math.sin(Math.atan2(dd.z * S - cz, dd.x * S - cx) - b), Math.cos(Math.atan2(dd.z * S - cz, dd.x * S - cx) - b))) < 0.1)
          const y0 = d ? y + d.h * V : y
          if (y0 < top) m.hexa([O[i], O[i2], I[i2], I[i]].map((p) => at3(p, y0)).concat([O[i], O[i2], I[i2], I[i]].map((p) => at3(p, top))), wall)
        }
      } else {
        // Walls round the room's inset rect, broken by its doors, each corner cut by an askew facet slab.
        const cut = [0, 1, 2, 3].map(() => [0.45 + rng() * 0.45, 0.45 + rng() * 0.45])
        const [c00, c10, c11, c01] = cut
        for (const [axis, plane, lo, hi, t0, t1] of [['x', ex[0], iz0 + c00[1], iz1 - c01[1], ix0, ix0 + WT], ['x', ex[2], iz0 + c10[1], iz1 - c11[1], ix1 - WT, ix1], ['z', ex[1], ix0 + c00[0], ix1 - c10[0], iz0, iz0 + WT], ['z', ex[3], ix0 + c01[0], ix1 - c11[0], iz1 - WT, iz1]]) {
          const gaps = doors.filter((d) => d.axis === axis && Math.abs((axis === 'x' ? d.x : d.z) - plane) < 1e-6)
            .map((d) => [(axis === 'x' ? d.z : d.x) * S - d.w * S / 2, (axis === 'x' ? d.z : d.x) * S + d.w * S / 2, d.h * V]).sort((p, q) => p[0] - q[0])
          const piece = (u0, u1, y0, y1) => (u1 - u0 > 0.01) && (axis === 'x' ? m.box(t0, y0, u0, t1, y1, u1, wall) : m.box(u0, y0, t0, u1, y1, t1, wall))
          let u = lo
          for (const [g0, g1, gh] of gaps) { piece(u, g0, y, top); if (y + gh < top) piece(g0, g1, y + gh, top); u = g1 }
          piece(u, hi, y, top)
        }
        for (const [[px, pz], [cx, cz]] of [[[ix0, iz0], c00], [[ix1, iz0], c10], [[ix1, iz1], c11], [[ix0, iz1], c01]]) {
          const ux = px === ix0 ? 1 : -1, uz = pz === iz0 ? 1 : -1
          const q = [[px, pz + uz * cz], [px + ux * cx, pz], [px + ux * cx, pz + uz * WT], [px + ux * WT, pz + uz * cz]]
          m.hexa(q.map((p) => at3(p, y)).concat(q.map((p) => at3(p, top))), wall)
        }
      }
      for (const e of mine) {
        if (e.stair && e.a === n) spiralSteps(m, e.stair.x * S, e.stair.z * S, y)
        if (e.ladder) m.with(WOOD_SLOT, () => {
          const lx = e.ladder.x * S, lz = e.ladder.z * S
          for (const o of [-0.3, 0.3]) m.box(lx + o - 0.04, y, lz - 0.04, lx + o + 0.04, y + SH, lz + 0.04, DARKWOOD)
          for (let r = 0.4; r < SH; r += 0.4) m.box(lx - 0.3, y + r - 0.03, lz - 0.03, lx + 0.3, y + r + 0.03, lz + 0.03, DARKWOOD)
        }, true)
      }
    }
  })
  // The gap between two rooms' inset walls at a door: a threshold slab and jambs, and a lintel over it. A door out of the
  // castle (or onto a bridge) is closed by its leaves just past its wall, which take the player out at a touch.
  const G = INSET * S
  for (const e of lay.edges) for (const d of e.doors) {
    const k = Math.round(d.y / H), y = k * SH, cx = d.x * S, cz = d.z * S, hw = d.w * S / 2, top = y + SH - 0.3
    const along = (a0, a1, b0, b1, y0, y1, col, m) => (d.axis === 'x' ? m.box(cx + a0, y0, cz + b0, cx + a1, y1, cz + b1, col) : m.box(cx + b0, y0, cz + a0, cx + b1, y1, cz + a1, col))
    for (const m of [at(k), at(-1 - k)]) {
      const wtop = m === at(k) ? top : y + 1.4
      if (e.a.kind === 'room' && e.b.kind === 'room' && e.kind !== 'bridge') {
        along(-G, G, -hw - WT, hw + WT, y - 0.3, y + 0.01, m.tint(FLOOR.gate), m)
        for (const sgn of [-1, 1]) along(-G, G, sgn > 0 ? hw : -hw - WT, sgn > 0 ? hw + WT : -hw, y, wtop, m.tint(INNER), m)
        if (y + d.h * V < wtop) along(-G, G, -hw, hw, y + d.h * V, wtop, m.tint(INNER), m)
      } else {
        const o = -d.side * (G - 0.05), n = d.axis === 'x' ? [-d.side, 0, 0] : [0, 0, -d.side]
        leaves(m, d.axis === 'x' ? [cx + o, y, cz] : [cx, y, cz + o], n, hw, d.h * V, d.look === 'gate', m.tint(INNER))
      }
    }
  }
  // Partitions, stone through to the slab above, open under a lintel at their doorway; the cut twin's stop at waist height.
  const PT = PARTITION.t / 2
  for (const w of roomPlan(lay).walls) for (const [m, low] of [[at(w.k), false], [at(-1 - w.k), true]]) {
    const top = w.y + (low ? 1.42 : SH - 0.2), col = m.tint(INNER)
    const piece = (u0, u1, y0) => (w.axis === 'x' ? m.box(w.at - PT, y0, u0, w.at + PT, top, u1, col, y0 > w.y) : m.box(u0, y0, w.at - PT, u1, top, w.at + PT, col, y0 > w.y))
    piece(w.lo - 0.15, w.door[0], w.y); piece(w.door[1], w.hi + 0.15, w.y)
    if (!low) piece(w.door[0], w.door[1], w.y + PARTITION.doorH)
  }
  for (const r of roomProps(lay)) {
    const o = warpedProp(warp, r)
    prop(at(o.k), o)
    if (!HIGH.has(o.kind)) prop(at(-1 - o.k), o)
  }
  // Negative keys hold each storey's waist-high-wall twin, drawn when that storey is the plan cut.
  return [...meshers.entries()].filter(([k]) => k >= 0).sort((p, q) => p[0] - q[0])
    .map(([k, m]) => ({ k, geometry: m.arrays(), low: meshers.get(-1 - k).arrays() }))
}
