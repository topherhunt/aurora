// Castle preview shells for gen-castle.html: the exterior the layout implies (sections, battlements, the doors, flights and bridges
// its chosen edges use) and the interior rooms at CASTLE.scale, as flat boxes with world-mapped stone UVs and vertex tints.
import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale
const UV_M = 2
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b] }
const STONE = { keep: rgb(0x8d877c), hall: rgb(0x958b7a), gate: rgb(0x8a857d), tower: rgb(0x878580), lookout: rgb(0x7d7d84), wall: rgb(0x8b867e) }
const BAND = rgb(0x6f6a63), SLATE = rgb(0x3f4652), DARK = rgb(0x15120f), IRON = rgb(0x2a2b2e), WOOD = rgb(0x6b4a2a), GOLD = rgb(0xc9a33a)
const FLOOR = { keep: rgb(0x7a5a3a), hall: rgb(0x80603e), gate: rgb(0x6d6a66), tower: rgb(0x6d6a66), lookout: rgb(0x75645f) }
const INNER = rgb(0xb8b0a2), STEP = rgb(0x8f8a83)

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }

class Mesher {
  constructor(seed) { this.p = []; this.n = []; this.c = []; this.uv = []; this.rng = mulberry32(seed) }
  tint(col, j = 0.08) { const f = 1 + (this.rng() - 0.5) * j; return col.map((v) => v * f) }
  /** A planar quad a-b-c-d, wound to face the side of normal hint n. */
  quad(a, b, c, d, col, n) {
    let nr = norm(cross(sub(b, a), sub(c, a)))
    if (dot(nr, n) < 0) { [b, d] = [d, b]; nr = nr.map((v) => -v) }
    const ax = Math.abs(nr[0]) > Math.abs(nr[1]) && Math.abs(nr[0]) > Math.abs(nr[2]) ? 0 : Math.abs(nr[1]) > Math.abs(nr[2]) ? 1 : 2
    for (const p of [a, b, c, a, c, d]) {
      this.p.push(...p); this.n.push(...nr); this.c.push(...col)
      this.uv.push(ax === 0 ? p[2] / UV_M : p[0] / UV_M, ax === 1 ? p[2] / UV_M : p[1] / UV_M)
    }
  }
  tri(a, b, c, col, away) {
    let nr = norm(cross(sub(b, a), sub(c, a)))
    if (dot(nr, sub(a, away)) < 0) { [b, c] = [c, b]; nr = nr.map((v) => -v) }
    for (const p of [a, b, c]) { this.p.push(...p); this.n.push(...nr); this.c.push(...col); this.uv.push(p[0] / UV_M + p[2] / UV_M, p[1] / UV_M) }
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

/** A parapet along one edge with merlons on it; `axis` runs the length, `c` is the across-centre. */
function crenels(m, axis, a0, a1, c, y, col) {
  const [lo, hi] = [Math.min(a0, a1), Math.max(a0, a1)]
  const run = (u0, u1, v0, v1, y0, y1) => (axis === 'x' ? m.box(u0, y0, v0, u1, y1, v1, col) : m.box(v0, y0, u0, v1, y1, u1, col))
  run(lo, hi, c - 0.18, c + 0.18, y, y + 0.6)
  const n = Math.max(2, Math.round((hi - lo) / 1.3))
  for (let i = 0; i < n; i++) { const u = lo + (hi - lo) * (i + 0.5) / n; run(u - 0.3, u + 0.3, c - 0.18, c + 0.18, y + 0.6, y + 1.2) }
}
const ring = (m, x0, z0, x1, z1, y, col) => {
  crenels(m, 'x', x0, x1, z0 + 0.18, y, col); crenels(m, 'x', x0, x1, z1 - 0.18, y, col)
  crenels(m, 'z', z0, z1, x0 + 0.18, y, col); crenels(m, 'z', z0, z1, x1 - 0.18, y, col)
}

/** A flight of solid steps from the ground (or y0) along `axis`, ending in a flat landing. */
function flight(m, f, col, scale = 1) {
  const n = Math.max(4, Math.round(f.rise / 0.4)), dir = Math.sign(f.a1 - f.a0)
  const run = Math.abs(f.a1 - f.a0) - f.landing
  for (let i = 0; i < n; i++) {
    const u0 = f.a0 + dir * run * i / n, u1 = i === n - 1 ? f.a1 : f.a0 + dir * run * (i + 1) / n, y = f.rise * (i + 1) / n
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
  const t0 = Math.min(0, d.side * 0.18), t1 = Math.max(0, d.side * 0.18)
  along(-hw - 0.25, -hw, d.y, d.y + d.h + 0.25, t0, t1)
  along(hw, hw + 0.25, d.y, d.y + d.h + 0.25, t0, t1)
  along(-hw - 0.25, hw + 0.25, d.y + d.h, d.y + d.h + 0.3, t0, t1)
  if (d.look === 'barred') for (const u of [-0.35, 0, 0.35]) along(u - 0.04, u + 0.04, d.y, d.y + d.h, Math.min(0, d.side * 0.1), Math.max(0, d.side * 0.1))
}

export function exteriorGeometry(lay) {
  const m = new Mesher(lay.seed)
  const { X, Z } = lay
  for (const s of lay.sections) {
    const col = m.tint(STONE[s.kind])
    if (s.kind === 'wall') {
      const top = 2 * H, half = CASTLE.wallT / 2
      if (s.axis === 'x') {
        const cz = Z(s.z0) + C / 2, outer = cz - s.inner[1] * (half - 0.18)
        m.box(X(s.x0), -4, cz - half, X(s.x0 + s.w), top, cz + half, col)
        crenels(m, 'x', X(s.x0), X(s.x0 + s.w), outer, top, col)
      } else {
        const cx = X(s.x0) + C / 2, outer = cx - s.inner[0] * (half - 0.18)
        m.box(cx - half, -4, Z(s.z0), cx + half, top, Z(s.z0 + s.d), col)
        crenels(m, 'z', Z(s.z0), Z(s.z0 + s.d), outer, top, col)
      }
      continue
    }
    const [x0, z0, x1, z1] = [X(s.x0), Z(s.z0), X(s.x0 + s.w), Z(s.z0 + s.d)], top = s.floors * H
    m.box(x0, -4, z0, x1, top, z1, col)
    const ov = s.kind === 'hall' ? 0 : 0.3
    if (ov) m.box(x0 - ov, top - 0.7, z0 - ov, x1 + ov, top, z1 + ov, m.tint(BAND), true)
    if (s.roof.unused) {
      const lift = Math.min(s.w, s.d) * C * 0.75, apex = [(x0 + x1) / 2, top + lift, (z0 + z1) / 2]
      const e = [[x0 - ov - 0.2, top, z0 - ov - 0.2], [x1 + ov + 0.2, top, z0 - ov - 0.2], [x1 + ov + 0.2, top, z1 + ov + 0.2], [x0 - ov - 0.2, top, z1 + ov + 0.2]]
      const slate = m.tint(SLATE)
      for (let i = 0; i < 4; i++) m.tri(e[i], e[(i + 1) % 4], apex, slate, [apex[0], top, apex[2]])
    } else ring(m, x0 - ov, z0 - ov, x1 + ov, z1 + ov, top, col)
    // Arrow slits on each storey's open faces, one cell in two.
    for (let k = 1; k < s.floors; k++) for (let x = s.x0; x < s.x0 + s.w; x++) for (let z = s.z0; z < s.z0 + s.d; z++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (nx >= s.x0 && nx < s.x0 + s.w && nz >= s.z0 && nz < s.z0 + s.d) continue
      const by = lay.occAt(nx, nz)
      if ((by && by.floors * H > k * H + 1) || m.rng() < 0.5) continue
      const y0 = k * H + 1.3, y1 = k * H + 2.5
      if (dx) { const fx = X(dx > 0 ? x + 1 : x) + dx * 0.03, cz = Z(z + 0.5); m.quad([fx, y0, cz - 0.15], [fx, y0, cz + 0.15], [fx, y1, cz + 0.15], [fx, y1, cz - 0.15], DARK, [dx, 0, 0]) }
      else { const fz = Z(dz > 0 ? z + 1 : z) + dz * 0.03, cx = X(x + 0.5); m.quad([cx - 0.15, y0, fz], [cx + 0.15, y0, fz], [cx + 0.15, y1, fz], [cx - 0.15, y1, fz], DARK, [0, 0, dz]) }
    }
  }
  for (const e of lay.edges) {
    const seen = e.a.out || e.b.out || e.kind === 'bridge'
    if (seen) for (const d of e.doors) doorway(m, d, m.tint(BAND))
    if (e.flight) flight(m, e.flight, m.tint(STONE.wall))
    if (e.bridge) {
      const b = e.bridge, col = m.tint(STONE.wall)
      const span = (c0, c1, y0, y1) => (b.axis === 'x' ? m.box(b.a0, y0, c0, b.a1, y1, c1, col, true) : m.box(c0, y0, b.a0, c1, y1, b.a1, col, true))
      span(b.c - 1.1, b.c + 1.1, b.y - 0.6, b.y)
      span(b.c - 1.1, b.c - 0.8, b.y, b.y + 0.9)
      span(b.c + 0.8, b.c + 1.1, b.y, b.y + 0.9)
    }
    if (e.ladder) m.box(e.ladder.x - 0.5, (e.ladder.k + 1) * H, e.ladder.z - 0.5, e.ladder.x + 0.5, (e.ladder.k + 1) * H + 0.2, e.ladder.z + 0.5, WOOD)
    if (e.rope) m.box(e.rope.x - 0.05, 0, e.rope.z - 0.05, e.rope.x + 0.05, e.rope.top + 0.6, e.rope.z + 0.05, WOOD)
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
  const meshers = new Map()
  const at = (k) => { if (!meshers.has(k)) meshers.set(k, new Mesher(lay.seed * 31 + k)); return meshers.get(k) }
  const SH = H * S, WT = 0.3, INSET = 0.4
  for (const n of lay.nodes) if (n.kind === 'room') {
    const y = n.k * SH
    for (const [m, low] of [[at(n.k), false], [at(-1 - n.k), true]]) {
      const ex = [X(n.x0), Z(n.z0), X(n.x0 + n.w), Z(n.z0 + n.d)]
      const [ix0, iz0, ix1, iz1] = [(ex[0] + INSET) * S, (ex[1] + INSET) * S, (ex[2] - INSET) * S, (ex[3] - INSET) * S]
      const mine = lay.edges.filter((e) => e.a === n || e.b === n)
      const slab = mine.filter((e) => e.stair && e.b === n)
        .reduce((rects, e) => rects.flatMap((r) => minusHole(r, e.stair.x * S, e.stair.z * S, 1.25)), [[ix0, iz0, ix1, iz1]])
      const floor = m.tint(FLOOR[n.sec.kind])
      for (const [a, b, c, d] of slab) m.box(a, y - 0.3, b, c, y, d, floor, true)
      // Walls round the room's inset rect, broken by this room's doors on each side.
      const doors = mine.flatMap((e) => e.doors).filter((d) => d.axis === 'x' ? Math.abs(d.x - ex[0]) < 1e-6 || Math.abs(d.x - ex[2]) < 1e-6 : Math.abs(d.z - ex[1]) < 1e-6 || Math.abs(d.z - ex[3]) < 1e-6)
      const wall = m.tint(INNER), top = y + (low ? 1.4 : SH - 0.3)
      for (const [axis, plane, lo, hi, t0, t1] of [['x', ex[0], iz0, iz1, ix0, ix0 + WT], ['x', ex[2], iz0, iz1, ix1 - WT, ix1], ['z', ex[1], ix0, ix1, iz0, iz0 + WT], ['z', ex[3], ix0, ix1, iz1 - WT, iz1]]) {
        const gaps = doors.filter((d) => d.axis === axis && Math.abs((axis === 'x' ? d.x : d.z) - plane) < 1e-6)
          .map((d) => [(axis === 'x' ? d.z : d.x) * S - d.w * S / 2, (axis === 'x' ? d.z : d.x) * S + d.w * S / 2, d.h * S]).sort((p, q) => p[0] - q[0])
        const piece = (u0, u1, y0, y1) => (u1 - u0 > 0.01) && (axis === 'x' ? m.box(t0, y0, u0, t1, y1, u1, wall) : m.box(u0, y0, t0, u1, y1, t1, wall))
        let u = lo
        for (const [g0, g1, gh] of gaps) { piece(u, g0, y, top); if (y + gh < top) piece(g0, g1, y + gh, top); u = g1 }
        piece(u, hi, y, top)
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
  }
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
