// Castle collision and portals (design/44-castles.md, Collision): plain data from a layout, built in the worker, and the column
// spans the walk reads from it. Exterior data is castle-local metres with y from the castle floor; interior data is interior metres
// (CASTLE.scale across, CASTLE.tall upward). Neither follows the warp, which bends the masonry up to about 0.27 m.
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'
import { courtProps, dungeonProps, keySpot, roofProps, roomProps, roomPlan, PARTITION } from './furnish.js'
import { dungeonCell, dungeonPlan } from './dungeon.js'
import { sectionFrame, edgeNormals, interiorWarp, offsetLoop, ROOT, SPIRAL, spiralStart } from './shell.js'

const C = CASTLE.cell, H = CASTLE.storey, S = CASTLE.scale, V = CASTLE.tall, SH = H * V
const INSET = 0.4, WT = 0.3, G = INSET * S
// Collision tops; 0 for what hangs on a wall, lies on the floor or stands on a table, which stops nothing.
const PROP_TOP = {
  barrel: 0.9, crate: 0.8, sacks: 0.9, bench: 0.47, table: 0.82, longtable: 0.82, stool: 0.47, bed: 0.95, chest: 0.6, rack: 1.9, shelf: 1.8,
  hay: 0.7, cart: 1.0, well: 2.3, dummy: 1.7, throne: 1.76, brazier: 1.0, woodpile: 0.5, banner: 0,
  hearth: 1.5, oven: 1.5, cauldron: 0.8, herbs: 0, cask: 0.85, bucket: 0.4, basket: 0.45, bunk: 1.9, shields: 0, armour: 1.85, arrows: 1.1,
  grind: 1.05, anvil: 0.75, dais: 0.3, carpet: 0, tapestry: 0, chandelier: 0, fourposter: 0.95, wardrobe: 2.0, desk: 0.8, rug: 0, altar: 1.0,
  maptable: 0.83, cot: 0.5, workbench: 0.9, candles: 1.2, sconce: 0, target: 1.6, pell: 1.6, yard: 0, forge: 2.3, trough: 0.6, block: 0.5,
  bowrack: 1.5, stones: 0.45, jug: 0, bowl: 0, loaf: 0, cup: 0, candle: 0, book: 0,
}
// A parapet's band reaches past the merlons, so her reach (1.2 m) never finds its top; within STEP_GAP of where a step crosses it
// only the 0.6 m wall under the merlons stands, which she steps over.
const BAND = 1.3, STEP_BAND = 0.6, STEP_GAP = 0.9
// The root crown's top by distance out from the face (shell.js profile): footing at 1.3 m out, grade at 0.8, the waist at 0.096.
const CROWN = [[ROOT + 0.5, -6], [ROOT, 0], [ROOT * 0.45, 0.9], [ROOT * 0.12, 2.4]]
const BODY = 0.1
// Where the walk reads a column as solid at every height (walk.js SPAN_CAP).
export const SPAN_CAP = 8
const FAR = 1e3

const box = (x0, z0, x1, z1, lo, hi) => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, c: 1, s: 0, hu: Math.abs(x1 - x0) / 2, hv: Math.abs(z1 - z0) / 2, lo, hi })
const solid = (o) => { if (!(o.kind in PROP_TOP)) throw new Error(`castle prop: no collision top for '${o.kind}'`); return PROP_TOP[o.kind] > 0 }
const propBox = (o, y0) => ({ x: o.x, z: o.z, c: Math.cos(o.yaw), s: Math.sin(o.yaw), hu: o.w / 2, hv: o.d / 2, lo: y0, hi: y0 + PROP_TOP[o.kind] })
/** A convex loop with its outward normals, degenerate edges dropped. */
const convex = (P) => { const Q = P.filter((p, i) => Math.hypot(p[0] - P[(i + 1) % P.length][0], p[1] - P[(i + 1) % P.length][1]) > 1e-4); return { P: Q, N: edgeNormals(Q) } }
const doorAlong = (d) => (d.axis === 'x' ? [d.side, 0] : [0, d.side])

/** The exterior's solids: sections as loops, every straight thing as a box, the gate ramps, and the door notches cut back out. */
function exteriorSolids(lay) {
  const secs = [], boxes = [], ramps = [], notches = [], steps = []
  for (const e of lay.edges) if (e.kind === 'step') steps.push(e.pts[1])
  lay.sections.forEach((s, i) => {
    const rng = mulberry32(lay.seed * 131 + i)
    if (s.kind === 'wall') {
      const alongX = s.axis === 'x', inn = alongX ? s.inner[1] : s.inner[0]
      const a0 = (alongX ? lay.X(s.x0) : lay.Z(s.z0)) - 0.6, a1 = (alongX ? lay.X(s.x0 + s.w) : lay.Z(s.z0 + s.d)) + 0.6
      const cc = alongX ? lay.Z(s.z0) + C / 2 : lay.X(s.x0) + C / 2
      const put = (v0, v1, lo, hi) => boxes.push(alongX ? box(a0, cc + inn * v0, a1, cc + inn * v1, lo, hi) : box(cc + inn * v0, a0, cc + inn * v1, a1, lo, hi))
      put(-1.3, 1.26, -6, 2 * H)
      put(-1.65, -1.25, 2 * H - 1.1, 2 * H + BAND)
      return
    }
    const f = sectionFrame(lay, s, rng)
    const T = offsetLoop(f.pts, f.N, f.touch.map((t) => (t ? 0 : f.fl))).map(f.clamp)
    const t = convex(T)
    const skip = t.P.map((p, k) => f.ceded(p, t.P[(k + 1) % t.P.length]))
    const level = steps.filter((p) => Math.abs(p[1] - 0.4 - f.top) < 0.1).map((p) => [p[0], p[2]])
    secs.push({ body: convex(f.pts), T: t, skip, top: f.top, spire: s.roof.unused ? Math.min(s.w, s.d) * C * 1.1 + 1 : 0, steps: level })
  })
  for (const e of lay.edges) {
    const seen = e.a.out || e.b.out || e.kind === 'bridge'
    if (seen) for (const d of e.doors) if (d.look !== 'barred') {
      const depth = d.y === 0 ? ROOT + 0.05 : 0.05
      notches.push({ x: d.x, z: d.z, axis: d.axis, side: d.side, hw: d.w / 2, depth, out: depth + 0.6, lo: d.y + 0.06, hi: d.y + d.h })
    }
    if (e.a.kind === 'entry') { const d = e.doors[0]; ramps.push({ x: d.x, z: d.z, axis: d.axis, side: d.side, hw: d.w / 2 }) }
    if (e.flight) {
      const fl = e.flight, n = Math.max(4, Math.round(fl.rise / 0.4)), dir = Math.sign(fl.a1 - fl.a0), run = Math.abs(fl.a1 - fl.a0) - fl.landing
      for (let k = 0; k < n; k++) {
        const u0 = fl.a0 + dir * run * k / n, u1 = k === n - 1 ? fl.a1 : fl.a0 + dir * run * (k + 1) / n
        const y = k === n - 1 ? fl.rise - 0.08 : fl.rise * (k + 1) / n
        boxes.push(fl.axis === 'x' ? box(u0, fl.c0, u1, fl.c1, -1, y) : box(fl.c0, u0, fl.c1, u1, -1, y))
      }
    }
    if (e.bridge) {
      const b = e.bridge, A0 = Math.min(b.a0, b.a1) - 0.3, A1 = Math.max(b.a0, b.a1) + 0.3
      const put = (c0, c1, lo, hi) => boxes.push(b.axis === 'x' ? box(A0, b.c + c0, A1, b.c + c1, lo, hi) : box(b.c + c0, A0, b.c + c1, A1, lo, hi))
      put(-1.1, 1.1, b.y - 0.6, b.y)
      put(-1.1, -0.8, b.y, b.y + BAND)
      put(0.8, 1.1, b.y, b.y + BAND)
    }
    if (e.ladder) { const l = e.ladder, y = (l.k + 1) * H; boxes.push(box(l.x - 0.5, l.z - 0.5, l.x + 0.5, l.z + 0.5, y, y + 0.2)) }
  }
  boxes.push(box(lay.X(0), lay.Z(0), lay.X(lay.cw), lay.Z(lay.cd), -1, 0.05))
  const [sx, sy, sz] = lay.nodes.find((n) => n.kind === 'summit').pos
  boxes.push(box(sx - 0.5, sz - 0.3, sx + 0.5, sz + 0.3, sy - 0.4, sy + 0.2), box(sx - 0.52, sz - 0.36, sx + 0.52, sz - 0.28, sy + 0.2, sy + 0.8))
  for (const o of [...courtProps(lay), ...roofProps(lay)]) if (solid(o)) boxes.push(propBox(o, o.y))
  for (const p of [...secs.map((q) => q.body.P), ...secs.map((q) => q.T.P)]) for (const q of p) if (!Number.isFinite(q[0] + q[1])) throw new Error(`castle ${lay.seed}: a section loop is not finite`)
  return { secs, boxes, ramps, notches }
}

/** The interior's air: every room's floor-to-ceiling, every door's way through the walls, every spiral's hole up through the slab
 * over its high steps, and what stands in it; the dungeon's air is its grid (`dungeon`), its door a `lock` box till unlocked. */
function interiorSolids(lay) {
  const airs = [], spirals = [], boxes = [], g = dungeonPlan(lay)
  let storeys = 0
  for (const n of lay.nodes) {
    if (n.kind !== 'room') continue
    storeys = Math.max(storeys, n.k + 1)
    const ex = [lay.X(n.x0), lay.Z(n.z0), lay.X(n.x0 + n.w), lay.Z(n.z0 + n.d)], y = n.k * SH
    if (n.sec.round) {
      const cx = (ex[0] + ex[2]) / 2 * S, cz = (ex[1] + ex[3]) / 2 * S, R = (ex[2] - ex[0] - 2 * INSET) / 2 * S / Math.cos(Math.PI / 12)
      const O = Array.from({ length: 12 }, (_, i) => [cx + Math.cos((i + 0.5) * Math.PI / 6) * R, cz + Math.sin((i + 0.5) * Math.PI / 6) * R])
      airs.push({ k: n.k, poly: convex(offsetLoop(O, edgeNormals(O), -WT)), lo: y, hi: y + SH - 0.3 })
    } else airs.push({ k: n.k, rect: [(ex[0] + INSET) * S + WT, (ex[1] + INSET) * S + WT, (ex[2] - INSET) * S - WT, (ex[3] - INSET) * S - WT], lo: y, hi: y + SH - 0.3 })
  }
  for (const e of [...lay.edges, { stair: { k: -1, x: g.stair.x, z: g.stair.z }, doors: [] }]) {
    if (e.stair) {
      const { k } = e.stair, x = e.stair.x * S, z = e.stair.z * S, a0 = spiralStart(x, z), Rh = SPIRAL.R + 0.05
      spirals.push({ k, x, z, a0 })
      const arc = Array.from({ length: SPIRAL.steps - SPIRAL.hole + 1 }, (_, i) => [x + Math.cos(a0 + (SPIRAL.hole + i) * Math.PI / 8) * Rh, z + Math.sin(a0 + (SPIRAL.hole + i) * Math.PI / 8) * Rh])
      airs.push({ k, poly: convex([[x, z], ...arc]), lo: k * SH, hi: (k + 1) * SH })
    }
    for (const d of e.doors) {
      if (d.look === 'barred') continue
      const k = Math.round(d.y / H), y = k * SH, cx = d.x * S, cz = d.z * S, hw = d.w * S / 2
      const inner = e.a.kind === 'room' && e.b.kind === 'room' && e.kind !== 'bridge'
      // Between two rooms the way runs through both walls; out of the castle it runs from the room to the leaves.
      const [a0, a1] = inner ? [-(G + WT + 0.05), G + WT + 0.05] : [-d.side * (G + WT + 0.05), -d.side * (G - 0.05)].sort((p, q) => p - q)
      const rect = d.axis === 'x' ? [cx + a0, cz - hw, cx + a1, cz + hw] : [cx - hw, cz + a0, cx + hw, cz + a1]
      airs.push({ k, rect, lo: y, hi: y + d.h * V })
    }
  }
  for (const o of [...roomProps(lay), ...dungeonProps(lay)]) if (solid(o)) boxes.push(propBox(o, o.y))
  const { door } = g, t = 0.1
  boxes.push({ ...(door.axis === 'x' ? box(door.x - t, door.z - door.hw, door.x + t, door.z + door.hw, door.lo, door.hi) : box(door.x - door.hw, door.z - t, door.x + door.hw, door.z + t, door.lo, door.hi)), lock: true })
  // Partitions are solid boxes standing in a room's air, open under their lintels.
  for (const w of roomPlan(lay).walls) {
    const t = PARTITION.t / 2, top = w.y + SH - 0.3
    const put = (u0, u1, lo) => boxes.push(w.axis === 'x' ? box(w.at - t, u0, w.at + t, u1, lo, top) : box(u0, w.at - t, u1, w.at + t, lo, top))
    put(w.lo - 0.15, w.door[0], w.y); put(w.door[1], w.hi + 0.15, w.y); put(w.door[0], w.door[1], w.y + PARTITION.doorH)
  }
  return { airs, spirals, boxes, storeys, dungeon: { x0: g.x0, z0: g.z0, W: g.W, D: g.D, lo: g.lo, hi: g.hi }, unlocked: false }
}

const inBox = (b, x, z) => { const dx = x - b.x, dz = z - b.z; return Math.abs(dx * b.c - dz * b.s) <= b.hu && Math.abs(dx * b.s + dz * b.c) <= b.hv }
/** Signed distance out of convex loop {P, N} (the largest edge distance), and the edge it is measured from. */
function outOf(L, x, z, at) {
  let d = -Infinity
  for (let i = 0; i < L.P.length; i++) {
    const e = (x - L.P[i][0]) * L.N[i][0] + (z - L.P[i][1]) * L.N[i][1]
    if (e > d) { d = e; if (at) at.i = i }
  }
  return d
}
function crownAt(d) {
  for (let i = 0; i + 1 < CROWN.length; i++) {
    const [d0, y0] = CROWN[i], [d1, y1] = CROWN[i + 1]
    if (d <= d0 && d >= d1) return y0 + (y1 - y0) * (d0 - d) / (d0 - d1)
  }
  return d > CROWN[0][0] ? -Infinity : CROWN.at(-1)[1]
}

/** Spans sorted, merged, then `cut` intervals taken out; returns the count left in lo/hi. */
function settle(lo, hi, n, cuts) {
  for (let a = 1; a < n; a++) {
    const l = lo[a], h = hi[a]
    let j = a - 1
    while (j >= 0 && lo[j] > l) { lo[j + 1] = lo[j]; hi[j + 1] = hi[j]; j-- }
    lo[j + 1] = l; hi[j + 1] = h
  }
  let m = 0
  for (let a = 0; a < n; a++) {
    if (m > 0 && lo[a] <= hi[m - 1]) hi[m - 1] = Math.max(hi[m - 1], hi[a])
    else { lo[m] = lo[a]; hi[m] = hi[a]; m++ }
  }
  for (const [c0, c1] of cuts) {
    for (let a = 0; a < m; a++) {
      if (hi[a] <= c0 || lo[a] >= c1) continue
      if (lo[a] < c0 && hi[a] > c1) {
        for (let b = m; b > a + 1; b--) { lo[b] = lo[b - 1]; hi[b] = hi[b - 1] }
        lo[a + 1] = c1; hi[a + 1] = hi[a]; hi[a] = c0; m++; a++
      } else if (lo[a] < c0) hi[a] = c0
      else if (hi[a] > c1) lo[a] = c1
      else { for (let b = a; b + 1 < m; b++) { lo[b] = lo[b + 1]; hi[b] = hi[b + 1] } m--; a-- }
    }
  }
  return m
}

const LO = new Float64Array(64), HI = new Float64Array(64), CELL = { k: -1, lo: 0, hi: 0 }
/** The buffers exteriorSpans and interiorSpans leave their spans in, valid until the next call. */
export const SPANS = { LO, HI }
const edgeAt = { i: 0 }

/** The exterior's spans at local (x, z) into LO/HI, relative to the castle floor; returns the count. */
export function exteriorSpans(ex, x, z) {
  let n = 0
  const put = (lo, hi) => { if (n >= LO.length) throw new Error('castle exteriorSpans: more than 64 spans before merging'); LO[n] = lo; HI[n++] = hi }
  for (const s of ex.secs) {
    const d = outOf(s.body, x, z)
    if (d > CROWN[0][0]) continue
    if (d <= BODY) put(-6, s.top)
    else put(-6, crownAt(d))
    const dT = outOf(s.T, x, z, edgeAt)
    if (dT > 0) continue
    if (d > BODY) put(s.top - 1.1, s.top)
    if (s.spire) { put(s.top, s.top + s.spire); continue }
    let band = false
    for (let i = 0; i < s.T.P.length && !band; i++) {
      if (s.skip[i]) continue
      band = (x - s.T.P[i][0]) * s.T.N[i][0] + (z - s.T.P[i][1]) * s.T.N[i][1] >= -0.36
    }
    if (!band) continue
    const low = s.steps.some((p) => Math.hypot(x - p[0], z - p[1]) < STEP_GAP)
    put(s.top, s.top + (low ? STEP_BAND : BAND))
  }
  for (const b of ex.boxes) if (inBox(b, x, z)) put(b.lo, b.hi)
  for (const r of ex.ramps) {
    const t = (r.axis === 'x' ? x - r.x : z - r.z) * r.side, u = Math.abs(r.axis === 'x' ? z - r.z : x - r.x)
    if (t < -0.3 || t > RAMP_END) continue
    const hw = r.hw + 0.3 + Math.max(0, t - RAMP_FLAT) / 11 * 0.9, top = 0.05 - Math.max(0, t - RAMP_FLAT) * RAMP_SLOPE
    if (u > hw + 0.3) continue
    put(RAMP_DEEP, u <= hw ? top : top - (u - hw))
  }
  // A door's leaves close its notch: solid behind them, cut out in front.
  const cuts = []
  for (const c of ex.notches) {
    const q = ((c.axis === 'x' ? x - c.x : z - c.z)) * c.side, u = Math.abs(c.axis === 'x' ? z - c.z : x - c.x)
    if (u > c.hw || q < -0.8 || q > c.out) continue
    if (q < c.depth) put(-6, c.hi)
    else cuts.push([c.lo, c.hi])
  }
  return settle(LO, HI, n, cuts)
}
const RAMP_FLAT = ROOT + 0.4, RAMP_SLOPE = Math.tan(Math.PI / 6), RAMP_END = RAMP_FLAT + 11, RAMP_DEEP = 0.05 - 11 * RAMP_SLOPE - 0.5

/** The interior's spans at interior (x, z) into LO/HI: solid but for the air of storeys within one of `ref`'s, then what stands in
 * that air. A column holding every storey of a tall tower would pass the walk's cap, so the storeys far from her are left solid. */
export function interiorSpans(it, x, z, ref) {
  const k0 = Math.floor(ref / SH) - 1, k1 = k0 + 2
  let n = 0, top = -FAR
  const air = []
  for (const a of it.airs) {
    if (a.k < k0 || a.k > k1) continue
    if (a.rect ? x < a.rect[0] || x > a.rect[2] || z < a.rect[1] || z > a.rect[3] : outOf(a.poly, x, z) > 0) continue
    air.push(a)
  }
  if (k0 <= -1 && k1 >= -1) {
    const c = dungeonCell(it.dungeon, x, z)
    if (c >= 0 && !Number.isNaN(it.dungeon.lo[c])) { CELL.lo = it.dungeon.lo[c]; CELL.hi = it.dungeon.hi[c]; air.push(CELL) }
  }
  air.sort((p, q) => p.lo - q.lo || q.hi - p.hi)
  for (const a of air) {
    if (a.lo > top) { LO[n] = top; HI[n++] = a.lo }
    top = Math.max(top, a.hi)
  }
  LO[n] = top; HI[n++] = FAR
  if (air.length) {
    for (const s of it.spirals) {
      if (s.k < k0 || s.k > k1) continue
      const r = Math.hypot(x - s.x, z - s.z), y = s.k * SH, rise = SH / SPIRAL.steps
      if (r < SPIRAL.post) { LO[n] = y; HI[n++] = y + SH; continue }
      if (r >= SPIRAL.R) continue
      const j = Math.floor((((Math.atan2(z - s.z, x - s.x) - s.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 8))
      if (j < SPIRAL.steps) { LO[n] = y + j * rise; HI[n++] = y + (j + 1) * rise }
    }
    for (const b of it.boxes) if (!(b.lock && it.unlocked) && inBox(b, x, z) && b.lo >= k0 * SH - 1 && b.lo <= (k1 + 1) * SH) { LO[n] = b.lo; HI[n++] = b.hi }
  }
  return settle(LO, HI, n, [])
}

/** Where she stands at (x, z) with her feet about `y` (the highest floor from 0.8 m below it to 0.6 above), when that floor runs on
 * round a ring of `r` with 1.9 m of air over all of it: [x, y, z], or null. */
function standAt(spans, x, y, z, r = 0.4) {
  let fy = -Infinity
  const m0 = spans(x, z)
  for (let i = 0; i < m0; i++) if (HI[i] >= y - 0.8 && HI[i] <= y + 0.6) fy = Math.max(fy, HI[i])
  if (fy === -Infinity) return null
  for (const [px, pz] of [[x, z], [x + r, z], [x - r, z], [x, z + r], [x, z - r]]) {
    const m = spans(px, pz)
    let floor = false
    for (let i = 0; i < m; i++) {
      if (Math.abs(HI[i] - fy) < 0.3) floor = true
      if (LO[i] < fy + 1.9 && HI[i] > fy + 0.35) return null
    }
    if (!floor) return null
  }
  return [x, fy, z]
}
/** The first standing spot (standAt) round (x, z) at radius r, starting toward bearing (fx, fz), then further out, then nearer in (a
 * crowded small room). Every portal fires on entering its zone, so a spot inside one never sends her straight back. */
function spotNear(spans, x, y, z, r, fx, fz) {
  const a0 = Math.atan2(fz, fx)
  for (const rr of [r, r + 0.4, r + 0.8, r - 0.4, r - 0.8].filter((v) => v > 0.3)) for (let i = 0; i < 16; i++) {
    const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * Math.PI / 8, p = standAt(spans, x + Math.cos(a) * rr, y, z + Math.sin(a) * rr)
    if (p !== null) return p
  }
  throw new Error(`castle: nowhere to stand 0.3 to ${r + 0.8} m from ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`)
}
/** standAt (x, y, z), else the nearest spot round it. */
const spot = (spans, x, y, z, fx, fz) => standAt(spans, x, y, z) ?? spotNear(spans, x, y, z, 0.5, fx, fz)

/** Every way through the shell: doors between the exterior and the interior (each its leaves' face either side, and where it sets
 * her down), ladders as blinks, the summit's rope and its chest. Exterior points are local, interior points interior metres. */
function portals(lay, ex, it) {
  const exSpans = (x, z) => exteriorSpans(ex, x, z)
  const inSpans = (y) => (x, z) => interiorSpans(it, x, z, y + 0.5)
  const doors = [], ladders = []
  for (const e of lay.edges) {
    const seen = e.a.out || e.b.out || e.kind === 'bridge'
    if (seen) for (const d of e.doors) {
      if (d.look === 'barred') continue
      const [nx, nz] = doorAlong(d), depth = d.y === 0 ? ROOT + 0.05 : 0.05, k = Math.round(d.y / H)
      const iy = k * SH, ix = d.x * S - nx * (G + WT + 0.9), iz = d.z * S - nz * (G + WT + 0.9)
      doors.push({
        hw: d.w / 2,
        ext: { x: d.x + nx * depth, y: d.y, z: d.z + nz * depth, nx, nz },
        int: { x: d.x * S - nx * (G - 0.05), y: iy, z: d.z * S - nz * (G - 0.05), nx, nz },
        out: spot(exSpans, d.x + nx * (depth + 1.2), d.y, d.z + nz * (depth + 1.2), nx, nz),
        in: spot(inSpans(iy), ix, iy, iz, -nx, -nz),
      })
    }
    if (e.ladder) {
      const { x, z, k } = e.ladder, y = (k + 1) * H, lo = k * SH
      ladders.push({ k, x: x * S, z: z * S, hatch: [x, y + 0.2, z], roof: spotNear(exSpans, x, y, z, 1.2, -x, -z), down: spotNear(inSpans(lo), x * S, lo, z * S, 1.3, -x, -z) })
    }
  }
  const rope = lay.edges.find((e) => e.rope).rope, summit = lay.nodes.find((n) => n.kind === 'summit')
  // The dungeon's door faces the foot chamber she comes to it from; its key and chest lie where the warp moved what they lie on.
  const { door } = dungeonPlan(lay), warp = interiorWarp(lay), [nx, nz] = door.axis === 'x' ? [-door.side, 0] : [0, -door.side]
  const at = ([x, y, z]) => { const [wx, , wz] = warp(x, y, z); return [wx, y, wz] }
  const chest = dungeonProps(lay).find((o) => o.kind === 'chest')
  const dungeon = { door: { x: door.x, y: door.lo, z: door.z, nx, nz, hw: door.hw }, key: at(keySpot(lay)), chest: at([chest.x, chest.y + PROP_TOP.chest, chest.z]) }
  return { doors, ladders, rope: { x: rope.x, z: rope.z, top: rope.top, from: [summit.pos[0], summit.pos[2]] }, chest: summit.pos.slice(), dungeon }
}

/** A layout's collision and portals, as plain data (structured-clonable, for the worker's reply). */
export function castleSolids(lay) {
  const ex = exteriorSolids(lay), it = interiorSolids(lay)
  return { ex, it, portals: portals(lay, ex, it) }
}
