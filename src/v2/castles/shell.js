// Castle preview shells for gen-castle.html: the exterior the layout implies (sections, battlements, the doors, flights and bridges
// its chosen edges use) and the interior rooms at CASTLE.scale. Sections are lofted footprints with bevelled, jittered corners and a
// flared top; every vertex then goes through one position-only warp, which keeps coincident vertices coincident (see
// src/buildings/v2/warp.js). Crenellations stay plain boxes. The rules that keep faces from z-fighting: design/44-castles.md, Shell.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { makeWarp } from '../../buildings/v2/warp.js'
import { CASTLE } from './layout.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale
const UV_M = 2
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b] }
const STONE = { keep: rgb(0x8d877c), hall: rgb(0x958b7a), gate: rgb(0x8a857d), tower: rgb(0x878580), lookout: rgb(0x7d7d84), wall: rgb(0x8b867e) }
const BAND = rgb(0x6f6a63), SLATE = rgb(0x3f4652), DARK = rgb(0x15120f), WOOD = rgb(0x6b4a2a), GOLD = rgb(0xc9a33a)
const FLOOR = { keep: rgb(0x7a5a3a), hall: rgb(0x80603e), gate: rgb(0x6d6a66), tower: rgb(0x6d6a66), lookout: rgb(0x75645f) }
const INNER = rgb(0xb8b0a2), STEP = rgb(0x8f8a83)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a) => Math.hypot(...a)
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const warpOf = (seed, s) => makeWarp({ strength: 1, seed, amp: 0.22 * s, scale: 6 * s, amp2: 0.05 * s, scale2: 1.8 * s, leanX: 0, leanZ: 0, leanPow: 1 })

class Mesher {
  constructor(seed, warp = null) { this.p = []; this.n = []; this.c = []; this.uv = []; this.rng = mulberry32(seed); this.warp = warp }
  tint(col, j = 0.08) { const f = 1 + (this.rng() - 0.5) * j; return col.map((v) => v * f) }
  /** A quad a-b-c-d facing the side of normal hint n. */
  quad(a, b, c, d, col, n) { this.face([a, b, c], n, col); this.face([a, c, d], n, col) }
  tri(a, b, c, col, away) { this.face([a, b, c], sub(a, away), col) }
  /** One triangle wound to face the side of hint n (each half of a bent quad on its own), its normal taken from the warped corners
   * and its UVs from the unwarped ones, projected along the main axis. Degenerate triangles are dropped. */
  face(raw, n, col) {
    let nr = cross(sub(raw[1], raw[0]), sub(raw[2], raw[0]))
    if (len(nr) < 1e-9) return
    if (dot(nr, n) < 0) { raw = [raw[0], raw[2], raw[1]]; nr = nr.map((v) => -v) }
    const w = raw.map((p) => (this.warp ? this.warp(p[0], p[1], p[2]) : p))
    const fn = cross(sub(w[1], w[0]), sub(w[2], w[0]))
    if (len(fn) < 1e-10) return
    const u = norm(fn), ax = Math.abs(nr[0]) > Math.abs(nr[1]) && Math.abs(nr[0]) > Math.abs(nr[2]) ? 0 : Math.abs(nr[1]) > Math.abs(nr[2]) ? 1 : 2
    for (let i = 0; i < 3; i++) {
      this.p.push(...w[i]); this.n.push(...u); this.c.push(...col)
      this.uv.push(ax === 0 ? raw[i][2] / UV_M : raw[i][0] / UV_M, ax === 1 ? raw[i][2] / UV_M : raw[i][1] / UV_M)
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
  /** Eight corners, bottom ring then top ring, each ring going round. */
  hexa(v, col) {
    const mid = v.reduce((a, p) => [a[0] + p[0] / 8, a[1] + p[1] / 8, a[2] + p[2] / 8], [0, 0, 0])
    const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    for (const f of faces) {
      const q = f.map((i) => v[i]), c = q.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4, a[2] + p[2] / 4], [0, 0, 0])
      this.quad(...q, col, sub(c, mid))
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    return g
  }
}

// Footprints are convex loops of [x, z].
const centroid = (P) => P.reduce((a, p) => [a[0] + p[0] / P.length, a[1] + p[1] / P.length], [0, 0])
const lerp2 = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
const at3 = (p, y) => [p[0], y, p[1]]
/** Outward unit normals, edge i running P[i] to P[i+1]. */
function edgeNormals(P) {
  const c = centroid(P)
  return P.map((p, i) => {
    const q = P[(i + 1) % P.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]), n = [(q[1] - p[1]) / l, (p[0] - q[0]) / l]
    return n[0] * ((p[0] + q[0]) / 2 - c[0]) + n[1] * ((p[1] + q[1]) / 2 - c[1]) < 0 ? [-n[0], -n[1]] : n
  })
}
/** The loop with edge i pushed out by d[i] (or a number for all); where two collinear edges differ, their shared vertex takes the smaller. */
function offsetLoop(P, N, d) {
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

/** Ring heights and outward offsets: a footing splayed below ground, three jittered segments up the shaft, then a corbelled flare. */
const profile = (top, fl, j) => [[-4, 0.35], [0, 0], [top * 0.36, j()], [top * 0.68, j()], [top - 1, 0.05 + j()], [top - 0.55, fl * 0.8], [top, fl]]
const BAND_FROM = 4

function sectionShell(m, lay, s, rng) {
  const col = m.tint(STONE[s.kind]), band = m.tint(BAND), top = s.floors * H, fl = s.kind === 'hall' ? 0.15 : 0.45
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
    parapet(m, T, top, col, T.map((p, i) => ceded(p, T[nx(i)])))
  }
  // Arrow slits on the faces of each upper storey that nothing taller stands against.
  for (let k = 1; k < s.floors; k++) for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[nx(i)], L = Math.hypot(q[0] - p[0], q[1] - p[1])
    if (L < 0.9) continue
    const mid = lerp2(p, q, 0.5), by = beside(lay, mid[0] + N[i][0] * C / 2, mid[1] + N[i][1] * C / 2)
    if ((by && by !== s && by.floors * H > k * H + 1) || rng() < 0.65) continue
    const o = [mid[0] + N[i][0] * 0.07, mid[1] + N[i][1] * 0.07], t = [(q[0] - p[0]) / L * 0.15, (q[1] - p[1]) / L * 0.15], y0 = k * H + 1.3, y1 = k * H + 2.5
    m.quad([o[0] - t[0], y0, o[1] - t[1]], [o[0] + t[0], y0, o[1] + t[1]], [o[0] + t[0], y1, o[1] + t[1]], [o[0] - t[0], y1, o[1] - t[1]], DARK, [N[i][0], 0, N[i][1]])
  }
}

/** A parapet round the top loop T, merlons standing on it edge by edge; edges flagged in `skip` are left open. */
function parapet(m, T, y, col, skip) {
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
      m.hexa([...q.map((p) => at3(p, y1)), ...q.map((p) => at3(p, y2))], col)
    }
  }
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

/** A parapet along one edge with merlons on it; `axis` runs the length, `c` is the across-centre. */
function crenels(m, axis, a0, a1, c, y, col) {
  const [lo, hi] = [Math.min(a0, a1), Math.max(a0, a1)]
  const run = (u0, u1, v0, v1, y0, y1) => (axis === 'x' ? m.box(u0, y0, v0, u1, y1, v1, col) : m.box(v0, y0, u0, v1, y1, u1, col))
  run(lo, hi, c - 0.18, c + 0.18, y, y + 0.6)
  const n = Math.max(2, Math.round((hi - lo) / 1.3))
  for (let i = 0; i < n; i++) { const u = lo + (hi - lo) * (i + 0.5) / n; run(u - 0.3, u + 0.3, c - 0.18, c + 0.18, y + 0.6, y + 1.2) }
}

/** A curtain wall lofted like a section, its ends buried 0.6 m in the towers, flaring only on the outer face. */
function wallShell(m, lay, s, rng) {
  const col = m.tint(STONE.wall), band = m.tint(BAND), top = 2 * H, half = CASTLE.wallT / 2, fl = 0.3
  const alongX = s.axis === 'x', inn = alongX ? s.inner[1] : s.inner[0]
  const a0 = (alongX ? lay.X(s.x0) : lay.Z(s.z0)) - 0.6, a1 = (alongX ? lay.X(s.x0 + s.w) : lay.Z(s.z0 + s.d)) + 0.6
  const cc = alongX ? lay.Z(s.z0) + C / 2 : lay.X(s.x0) + C / 2
  const us = [a0]
  for (let u = a0 + C / 2; u < a1 - 0.5; u += C / 2) us.push(u)
  us.push(a1)
  const P = (u, v, y) => (alongX ? [u, y, v] : [v, y, u])
  const j = () => (rng() - 0.5) * 0.06
  const rings = profile(top, fl, j).map(([y, off], r) => ({
    y, out: us.map(() => cc - inn * (half + off + (r > 1 && r < BAND_FROM ? j() : 0))), in: us.map(() => cc + inn * (half + (r >= BAND_FROM ? 0.06 : off))),
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
  crenels(m, s.axis, a0 + 0.6, a1 - 0.6, cc - inn * (half + fl - 0.18), top, col)
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

/** A door as a dark plane on its face with a stone frame, bars when barred. */
function doorway(m, d, col) {
  const o = d.side * 0.05, hw = d.w / 2
  const along = (u0, u1, y0, y1, t0, t1) => (d.axis === 'x' ? m.box(d.x + t0, y0, d.z + u0, d.x + t1, y1, d.z + u1, col) : m.box(d.x + u0, y0, d.z + t0, d.x + u1, y1, d.z + t1, col))
  const p = d.axis === 'x'
    ? [[d.x + o, d.y, d.z - hw], [d.x + o, d.y, d.z + hw], [d.x + o, d.y + d.h, d.z + hw], [d.x + o, d.y + d.h, d.z - hw]]
    : [[d.x - hw, d.y, d.z + o], [d.x + hw, d.y, d.z + o], [d.x + hw, d.y + d.h, d.z + o], [d.x - hw, d.y + d.h, d.z + o]]
  m.quad(...p, DARK, d.axis === 'x' ? [d.side, 0, 0] : [0, 0, d.side])
  const t0 = Math.min(-d.side * 0.1, d.side * 0.18), t1 = Math.max(-d.side * 0.1, d.side * 0.18)
  along(-hw - 0.25, -hw, d.y, d.y + d.h + 0.25, t0, t1)
  along(hw, hw + 0.25, d.y, d.y + d.h + 0.25, t0, t1)
  along(-hw - 0.25, hw + 0.25, d.y + d.h, d.y + d.h + 0.3, t0, t1)
  if (d.look === 'barred') for (const u of [-0.35, 0, 0.35]) along(u - 0.04, u + 0.04, d.y, d.y + d.h, Math.min(0, d.side * 0.1), Math.max(0, d.side * 0.1))
}

/** `warp: false` builds the straight shell, which the gate scans for coplanar overlaps (the warp moves coincident faces together). */
export function exteriorGeometry(lay, { warp = true } = {}) {
  const m = new Mesher(lay.seed, warp ? warpOf(lay.seed, 1) : null)
  lay.sections.forEach((s, i) => {
    const rng = mulberry32(lay.seed * 131 + i)
    if (s.kind === 'wall') wallShell(m, lay, s, rng)
    else sectionShell(m, lay, s, rng)
  })
  for (const e of lay.edges) {
    const seen = e.a.out || e.b.out || e.kind === 'bridge'
    if (seen) for (const d of e.doors) doorway(m, d, m.tint(BAND))
    if (e.flight) flight(m, e.flight, m.tint(STONE.wall))
    if (e.bridge) {
      const b = e.bridge, col = m.tint(STONE.wall)
      // The ends run 0.3 m into the masonry, so no end face lies in a wall's plane.
      const lo = Math.min(b.a0, b.a1) - 0.3, hi = Math.max(b.a0, b.a1) + 0.3
      const span = (c0, c1, y0, y1) => (b.axis === 'x' ? m.box(lo, y0, c0, hi, y1, c1, col, true) : m.box(c0, y0, lo, c1, y1, hi, col, true))
      span(b.c - 1.1, b.c + 1.1, b.y - 0.6, b.y)
      span(b.c - 1.1, b.c - 0.8, b.y, b.y + 0.9)
      span(b.c + 0.8, b.c + 1.1, b.y, b.y + 0.9)
    }
    if (e.ladder) m.box(e.ladder.x - 0.5, (e.ladder.k + 1) * H, e.ladder.z - 0.5, e.ladder.x + 0.5, (e.ladder.k + 1) * H + 0.2, e.ladder.z + 0.5, WOOD)
    if (e.rope) m.box(e.rope.x - 0.05, 0, e.rope.z - 0.05, e.rope.x + 0.05, e.rope.top + 0.45, e.rope.z + 0.05, WOOD)
  }
  const summit = lay.nodes.find((n) => n.kind === 'summit')
  const [sx, sy, sz] = summit.pos
  m.box(sx - 0.5, sy - 0.4, sz - 0.3, sx + 0.5, sy + 0.2, sz + 0.3, WOOD)
  m.box(sx - 0.52, sy + 0.05, sz - 0.32, sx + 0.52, sy + 0.12, sz + 0.32, GOLD)
  return m.geometry()
}

/** The rect r minus the square hole (cx, cz, half), as up to four rects [x0, z0, x1, z1]. */
function minusHole([x0, z0, x1, z1], cx, cz, h) {
  const [hx0, hz0, hx1, hz1] = [Math.max(x0, cx - h), Math.max(z0, cz - h), Math.min(x1, cx + h), Math.min(z1, cz + h)]
  if (hx0 >= hx1 || hz0 >= hz1) return [[x0, z0, x1, z1]]
  return [[x0, z0, x1, hz0], [x0, hz1, x1, z1], [x0, hz0, hx0, hz1], [hx1, hz0, x1, hz1]].filter(([a, b, c, d]) => c - a > 0.01 && d - b > 0.01)
}

/** One geometry per storey, so a cut can hide the storeys above it. Interior units are exterior metres times CASTLE.scale. */
export function interiorGeometries(lay) {
  const { X, Z } = lay
  const meshers = new Map(), warp = warpOf(lay.seed + 1, S * 0.6)
  const at = (k) => { if (!meshers.has(k)) meshers.set(k, new Mesher(lay.seed * 31 + k, warp)); return meshers.get(k) }
  const SH = H * S, WT = 0.3, INSET = 0.4
  lay.nodes.forEach((n, ni) => {
    if (n.kind !== 'room') return
    const y = n.k * SH
    for (const [m, low] of [[at(n.k), false], [at(-1 - n.k), true]]) {
      const rng = mulberry32(lay.seed * 977 + ni)
      const ex = [X(n.x0), Z(n.z0), X(n.x0 + n.w), Z(n.z0 + n.d)]
      const [ix0, iz0, ix1, iz1] = [(ex[0] + INSET) * S, (ex[1] + INSET) * S, (ex[2] - INSET) * S, (ex[3] - INSET) * S]
      const mine = lay.edges.filter((e) => e.a === n || e.b === n)
      const slab = mine.filter((e) => e.stair && e.b === n)
        .reduce((rects, e) => rects.flatMap((r) => minusHole(r, e.stair.x * S, e.stair.z * S, 1.25)), [[ix0, iz0, ix1, iz1]])
      const floor = m.tint(FLOOR[n.sec.kind])
      for (const [a, b, c, d] of slab) m.box(a, y - 0.3, b, c, y, d, floor, true)
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
          const y0 = d ? y + d.h * S : y
          if (y0 < top) m.hexa([O[i], O[i2], I[i2], I[i]].map((p) => at3(p, y0)).concat([O[i], O[i2], I[i2], I[i]].map((p) => at3(p, top))), wall)
        }
      } else {
        // Walls round the room's inset rect, broken by its doors, each corner cut by an askew facet slab.
        const cut = [0, 1, 2, 3].map(() => [0.45 + rng() * 0.45, 0.45 + rng() * 0.45])
        const [c00, c10, c11, c01] = cut
        for (const [axis, plane, lo, hi, t0, t1] of [['x', ex[0], iz0 + c00[1], iz1 - c01[1], ix0, ix0 + WT], ['x', ex[2], iz0 + c10[1], iz1 - c11[1], ix1 - WT, ix1], ['z', ex[1], ix0 + c00[0], ix1 - c10[0], iz0, iz0 + WT], ['z', ex[3], ix0 + c01[0], ix1 - c11[0], iz1 - WT, iz1]]) {
          const gaps = doors.filter((d) => d.axis === axis && Math.abs((axis === 'x' ? d.x : d.z) - plane) < 1e-6)
            .map((d) => [(axis === 'x' ? d.z : d.x) * S - d.w * S / 2, (axis === 'x' ? d.z : d.x) * S + d.w * S / 2, d.h * S]).sort((p, q) => p[0] - q[0])
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
        if (e.stair && e.a === n) {
          const cx = e.stair.x * S, cz = e.stair.z * S, steps = 16, R = 1.05, r0 = 0.15
          const a0 = Math.atan2(cz, cx)
          for (let i = 0; i < steps; i++) {
            const a = a0 + i * Math.PI * 2 / steps * 0.94, b = a + Math.PI * 2 / steps * 0.94, yt = y + SH * (i + 1) / steps
            const P = (ang, rad, yy) => [cx + Math.cos(ang) * rad, yy, cz + Math.sin(ang) * rad]
            m.hexa([P(a, r0, yt - 0.3), P(a, R, yt - 0.3), P(b, R, yt - 0.3), P(b, r0, yt - 0.3), P(a, r0, yt), P(a, R, yt), P(b, R, yt), P(b, r0, yt)], m.tint(STEP))
          }
          m.box(cx - 0.15, y, cz - 0.15, cx + 0.15, y + SH, cz + 0.15, m.tint(STEP))
        }
        if (e.ladder) {
          const lx = e.ladder.x * S, lz = e.ladder.z * S
          for (const o of [-0.3, 0.3]) m.box(lx + o - 0.04, y, lz - 0.04, lx + o + 0.04, y + SH, lz + 0.04, WOOD)
          for (let r = 0.4; r < SH; r += 0.4) m.box(lx - 0.3, y + r - 0.03, lz - 0.03, lx + 0.3, y + r + 0.03, lz + 0.03, WOOD)
        }
      }
    }
  })
  // Negative keys hold each storey's waist-high-wall twin, drawn when that storey is the plan cut.
  return [...meshers.entries()].filter(([k]) => k >= 0).sort((p, q) => p[0] - q[0])
    .map(([k, m]) => ({ k, geometry: m.geometry(), low: meshers.get(-1 - k).geometry() }))
}

/** A 256 px ashlar tile for the preview, drawn in code until the real rock-wall texture is generated. */
export function stoneTexture(seed = 3) {
  const rng = mulberry32(seed), N = 256, cv = document.createElement('canvas')
  cv.width = cv.height = N
  const g = cv.getContext('2d')
  g.fillStyle = '#5c5852'; g.fillRect(0, 0, N, N)
  const rows = 8, rh = N / rows
  for (let r = 0; r < rows; r++) {
    let x = -rng() * 60
    while (x < N) {
      const w = 40 + rng() * 50, v = 150 + rng() * 60 | 0
      g.fillStyle = `rgb(${v},${v - 4},${v - 10})`
      for (const o of [0, -N, N]) g.fillRect(x + o + 2, r * rh + 2, w - 4, rh - 4)
      x += w
    }
  }
  for (let i = 0; i < 2500; i++) { const v = rng() * 60 | 0; g.fillStyle = `rgba(${v},${v},${v},0.12)`; g.fillRect(rng() * N, rng() * N, 2, 2) }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}
