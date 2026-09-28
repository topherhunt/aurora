// A stone road bridge (design/34-bridges.md): masonry arches on cutwatered piers under a deck that rises from each bank's road level in one rounded hill, low parapets, and corner posts whose tops are sockets for lanterns, cairns and the like. y = 0 is the water, the road runs along x, the river along z. One merged geometry per LOD in the shared prop material's layout, all LAYER.STONE.
import THREE from '../three-instance.js'
import { mulberry32, smoothstep } from '../sim/mathx.js'
import { LAYER, TILE_METRES } from '../textures.js'

const TAU = 2 * Math.PI

export const BRIDGE_DEFAULTS = {
  seed: 1,
  span: 14, // bank to bank: the water the arches clear
  road: 3.2, // clear width between the parapets
  clearance: 3.2, // water to the soffit at the middle arch's crown, at least
  bankA: 3, // road level at the -x end
  bankB: 3, // road level at the +x end
  depth: 2, // foundations below the water
  maxArch: 11, // widest arch before the span takes more piers
  pier: 2,
  abut: 1.5, // deck beyond each bank, at most MAX_ABUT
  wallH: 0.8,
  wallT: 0.45,
  ring: 0.5, // arch ring depth
  cover: 0.45, // masonry over the ring's crown
  jitter: 1, // scales every irregularity; 0 builds the drafted bridge
  pierPosts: true,
  stone: 1, // stone size, as a multiple of the tile's own
}
export const MAX_ABUT = 2
export const LODS = 3

export const DECOR_KINDS = ['lantern', 'cairn', 'cap', 'brazier', 'runestone', 'bare']
const DECOR_WEIGHTS = { lantern: 3, cairn: 3, cap: 2, brazier: 1, runestone: 1, bare: 1 }

const TINT = {
  body: [0.94, 0.92, 0.87], deck: [0.78, 0.76, 0.72], ring: [1.04, 1.0, 0.93], wall: [0.98, 0.95, 0.9],
  post: [1.02, 0.98, 0.92], iron: [0.13, 0.12, 0.11], glass: [2.2, 1.6, 0.8], coal: [0.35, 0.12, 0.06],
  damp: [0.5, 0.56, 0.46],
}
export const CAMBER = 0.06
// The deck is base + rise * sin(pi u)^HILL over the bridge's length: level where it meets the road, round over the crest.
const HILL = 1.4

// --- plan -------------------------------------------------------------------

/** Where everything goes, before any geometry: arches, deck profile, posts. */
export function planBridge(opts = {}) {
  const o = { ...BRIDGE_DEFAULTS, ...opts }
  for (const k of ['span', 'road', 'clearance', 'depth', 'maxArch', 'pier', 'abut', 'wallH', 'wallT', 'ring', 'stone']) {
    if (!(o[k] > 0)) throw new Error(`planBridge: ${k} must be > 0, got ${o[k]}`)
  }
  if (o.abut > MAX_ABUT) throw new Error(`planBridge: abut ${o.abut} m is past the ${MAX_ABUT} m a bridge may reach beyond its bank`)
  const rng = mulberry32(o.seed * 7919 + 17)
  const j = (a) => (rng() * 2 - 1) * a * o.jitter

  // An odd count, so an arch and not a pier stands under the crest.
  let n = Math.max(1, Math.ceil((o.span + o.pier) / (o.maxArch + o.pier)))
  if (n % 2 === 0) n += 1
  const clear = o.span - (n - 1) * o.pier
  if (clear <= 0) throw new Error(`planBridge: ${n - 1} piers of ${o.pier} m do not fit a ${o.span} m span`)
  const mid = (n - 1) / 2
  const centrality = (i) => (n === 1 ? 1 : 1 - Math.abs(i - mid) / mid)
  const wts = Array.from({ length: n }, (_, i) => 1 + 0.3 * centrality(i) + j(0.08))
  const wsum = wts.reduce((s, w) => s + w, 0)
  const shape = (ar, crown) => {
    // A semicircle on legs when the crown clears it, a flattened ellipse when it does not.
    ar.crown = crown
    ar.b = Math.min(ar.a, Math.max(crown * 0.5, crown - 0.3))
    ar.spring = crown - ar.b
  }
  const arches = []
  let x = -o.span / 2
  for (let i = 0; i < n; i++) {
    const a = ((wts[i] / wsum) * clear) / 2
    const ar = { cx: x + a, a, want: o.clearance * (0.78 + 0.22 * centrality(i)) * (1 + Math.abs(j(0.04))), ringT: o.ring * (0.8 + 0.035 * a) * (1 + j(0.1)) }
    shape(ar, ar.want)
    arches.push(ar)
    x += 2 * a + o.pier
  }
  const piers = arches.slice(1).map((ar, i) => ({ x0: arches[i].cx + arches[i].a, x1: ar.cx - ar.a }))

  const h = o.span / 2
  const xa = -h - o.abut
  const xb = h + o.abut
  const L = xb - xa
  const base = (x) => o.bankA + (o.bankB - o.bankA) * smoothstep(xa, xb, x)
  const bell = (x) => Math.sin((Math.PI * (x - xa)) / L) ** HILL
  const over = (ar, x) => { const t = (x - ar.cx) / ar.a; return ar.spring + ar.b * Math.sqrt(Math.max(0, 1 - t * t)) + ar.ringT + o.cover }
  const fits = (ar, deck) => { for (let k = 0; k <= 16; k++) { const xx = ar.cx + ar.a * (k / 8 - 1); if (over(ar, xx) > deck(xx)) return false } return true }
  // The least rise that carries the middle arch at its full height; the others sink until their rings clear the deck.
  const middle = arches[mid]
  let rise = Math.max(0.03 * L, (over(middle, middle.cx) - base(middle.cx)) / bell(middle.cx))
  let deckY
  for (let it = 0; ; it++) {
    if (it > 200) throw new Error(`planBridge: no hill over ${L.toFixed(1)} m clears these arches`)
    const r = rise
    deckY = (xx) => base(xx) + r * bell(xx)
    for (const ar of arches) { shape(ar, ar.want); while (!fits(ar, deckY) && ar.crown > 0.5) shape(ar, ar.crown * 0.97) }
    if (arches.every((ar) => fits(ar, deckY)) && middle.crown === middle.want) break
    rise *= 1.04
  }
  const hw = o.road / 2 + o.wallT
  const inner = hw - o.wallT
  /** The walkable surface: the deck's camber between the parapets, their foot outside it. */
  const deckAt = (xx, z) => deckY(xx) + (Math.abs(z) < inner ? CAMBER * (1 - (z / inner) ** 2) : 0)

  let grade = 0
  let top = -Infinity
  for (let k = 0; k < 200; k++) {
    const x0 = xa + (L * k) / 200
    const x1 = xa + (L * (k + 1)) / 200
    grade = Math.max(grade, Math.abs(deckY(x1) - deckY(x0)) / (x1 - x0))
    top = Math.max(top, deckY(x1))
  }

  const ph = o.wallT * 0.8
  const postH = o.wallH + 0.35
  const posts = []
  const pair = (px, kind) => { for (const s of [-1, 1]) posts.push({ x: px, z: s * (hw - o.wallT / 2), side: s, kind, h: postH * (1 + j(0.06)) }) }
  pair(xa + ph, 'end')
  pair(xb - ph, 'end')
  if (o.pierPosts) for (const p of piers) pair((p.x0 + p.x1) / 2, 'pier')

  return { o, arches, piers, xa, xb, hw, inner, top, rise, grade, deckY, deckAt, posts, postHalf: ph }
}

// --- the mesher ---------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const rot = (v, k, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(k, v) * (1 - c), x = cross(k, v)
  return [v[0] * c + x[0] * s + k[0] * d, v[1] * c + x[1] * s + k[1] * d, v[2] * c + x[2] * s + k[2] * d]
}

/** Buffers plus a per-vertex outward hint that `tri` winds each face to, so no builder has to. `wet` marks masonry the waterline darkens. A zero-area triangle is dropped, so a builder may collapse a row or repeat a point for free. */
class Mesher {
  constructor() { this.p = []; this.h = []; this.t = []; this.w = []; this.idx = [] }
  get count() { return this.p.length / 3 }
  v(p, hint, tint, wet = 1) {
    this.p.push(p[0], p[1], p[2]); this.h.push(hint[0], hint[1], hint[2]); this.t.push(tint[0], tint[1], tint[2]); this.w.push(wet)
    return this.count - 1
  }
  tri(a, b, c) {
    const P = this.p, H = this.h
    const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]]
    const v = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]]
    const f = cross(u, v)
    if (dot(f, f) < 1e-14) return
    const hs = [0, 1, 2].map((k) => H[a * 3 + k] + H[b * 3 + k] + H[c * 3 + k])
    if (dot(f, hs) < 0) this.idx.push(a, c, b)
    else this.idx.push(a, b, c)
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d) }
  /** (ni+1) x (nj+1) points from `at(i, j)` -> [p, hint]; `wrap` joins column ni back to 0 instead of emitting it; `skip(i, j)` leaves a quad out. Returns the first vertex; point (i, j) is at base + j * cols + i. */
  grid(ni, nj, at, tint, { wrap = false, wet = 1, skip = null } = {}) {
    const cols = wrap ? ni : ni + 1, base = this.count
    for (let jj = 0; jj <= nj; jj++) for (let i = 0; i < cols; i++) { const [p, h] = at(i, jj); this.v(p, h, tint, wet) }
    for (let jj = 0; jj < nj; jj++) for (let i = 0; i < ni; i++) {
      if (skip && skip(i, jj)) continue
      const i1 = wrap ? (i + 1) % ni : i + 1
      this.quad(base + jj * cols + i, base + jj * cols + i1, base + (jj + 1) * cols + i1, base + (jj + 1) * cols + i)
    }
    return base
  }
}

/**
 * A 2D profile swept through `stations` { o, u, v }: profile point [x, y] lands at o + u x + v y. `profile(k)` may differ per station but keeps its point count. A closed profile wraps; an `open` one is a strip whose ends meet other masonry. `caps` fans both ends shut.
 */
function sweep(m, stations, profile, tint, { caps = false, open = false, wet = 1 } = {}) {
  const profs = stations.map((_, k) => profile(k))
  const np = profs[0].length
  const pt = (k, i) => { const S = stations[k], q = profs[k][i]; return add(add(S.o, S.u, q[0]), S.v, q[1]) }
  const hint = (k, i) => {
    // The profile's own outward normal, from its centroid; good enough to wind by.
    const q = profs[k][i], c = profs[k].reduce((s, r) => [s[0] + r[0] / np, s[1] + r[1] / np], [0, 0])
    return add(add([0, 0, 0], stations[k].u, q[0] - c[0]), stations[k].v, q[1] - c[1])
  }
  m.grid(open ? np - 1 : np, stations.length - 1, (i, k) => [pt(k, i), hint(k, i)], tint, { wrap: !open, wet })
  if (!caps) return
  for (const k of [0, stations.length - 1]) {
    const out = norm(k === 0 ? sub(stations[0].o, stations[1].o) : sub(stations[k].o, stations[k - 1].o))
    const ids = profs[k].map((_, i) => m.v(pt(k, i), out, tint, wet))
    const c = ids.reduce((s, id) => add(s, m.p.slice(id * 3, id * 3 + 3), 1 / np), [0, 0, 0])
    const mid = m.v(c, out, tint, wet)
    for (let i = 0; i < np; i++) m.tri(mid, ids[i], ids[(i + 1) % np])
  }
}

// --- the kit ------------------------------------------------------------------

/** A frame { o, ax, ay, az } upright at `o`, yawed. */
const frame = (o, yaw = 0) => ({ o, ax: [Math.cos(yaw), 0, -Math.sin(yaw)], ay: [0, 1, 0], az: [Math.sin(yaw), 0, Math.cos(yaw)] })
const tip = (F, key, ang) => { const k = F[key]; return { ...F, ax: rot(F.ax, k, ang), ay: rot(F.ay, k, ang), az: rot(F.az, k, ang) } }
const put = (F, x, y, z) => add(add(add(F.o, F.ax, x), F.ay, y), F.az, z)
const scaled = (F, s) => ({ ...F, ax: F.ax.map((c) => c * s[0]), ay: F.ay.map((c) => c * s[1]), az: F.az.map((c) => c * s[2]) })

const OCT = 0.55
const RINGS = {
  4: [[1, -1], [1, 1], [-1, 1], [-1, -1]],
  8: [[1, -OCT], [1, OCT], [OCT, 1], [-OCT, 1], [-1, OCT], [-1, -OCT], [-OCT, -1], [OCT, -1]],
}

/** A block of half-sizes h about F's origin, 4-sided or 8 with its upright edges chamfered, with a bevelled top and its corners pushed up to `crook` so no two are alike. Normals smooth across the chamfers, so it shades as rounded stone. */
function block(m, rng, F, h, tint, { sides = 8, bevel = 0.05, crook = 0.02, bottom = false, wet = 0 } = {}) {
  const ring = RINGS[sides]
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
  const base = m.grid(ring.length, 2, (i, k) => at(ring[i][0] * (h[0] - rows[k][1]), rows[k][0], ring[i][1] * (h[2] - rows[k][1])), tint, { wrap: true, wet })
  const n = ring.length
  const fan = (row, y) => {
    const [p, hint] = at(0, y, 0)
    const c = m.v(p, hint, tint, wet)
    for (let i = 0; i < n; i++) m.tri(c, base + row * n + i, base + row * n + ((i + 1) % n))
  }
  fan(2, h[1])
  if (bottom) fan(0, -h[1])
}

/** A profile [[r, y]] turned about F's y axis; a point on the axis closes it. */
function lathe(m, F, prof, tint, { segs = 6 } = {}) {
  m.grid(segs, prof.length - 1, (i, k) => {
    const q = (i / segs) * TAU, [r, y] = prof[k]
    const prev = prof[Math.max(0, k - 1)], next = prof[Math.min(prof.length - 1, k + 1)]
    const t = [next[0] - prev[0], next[1] - prev[1]]
    const p = put(F, Math.cos(q) * r, y, Math.sin(q) * r)
    const radial = add(F.ax.map((c) => c * Math.cos(q)), F.az, Math.sin(q))
    return [p, add(F.ay.map((c) => c * -t[0]), radial, t[1])]
  }, tint, { wrap: true, wet: 0 })
}

const PEBBLE = [[0, -1], [1, -0.25], [0.8, 0.55], [0, 1]]
/** A rounded stone of radii r, 20 triangles. */
const pebble = (m, rng, F, r, tint) => lathe(m, scaled(tip(F, 'ay', rng() * TAU), r), PEBBLE, tint, { segs: 5 })

// --- the bridge ---------------------------------------------------------------

/**
 * The geometry for `plan` at `lod`:
 * - 0 is the full bridge.
 * - 1 is its silhouette, the parapets filled in to their top.
 * - 2 is one rectangle over its footprint.
 *
 * `decor` names one DECOR_KINDS entry for every post, 'random' to roll them from `decorSeed`, or an array with one kind per plan.posts entry. Sockets and lights are the same at every LOD, in the displaced frame the mesh is in.
 */
export function buildBridge(plan, { decor = 'random', decorSeed = plan.o.seed, lod = 0 } = {}) {
  if (!(lod >= 0 && lod < LODS && Number.isInteger(lod))) throw new Error(`buildBridge: lod ${lod} is not one of 0..${LODS - 1}`)
  const { o, xa, xb, hw, deckY } = plan
  const m = new Mesher()
  if (lod === 2) {
    let y = 0
    for (let k = 0; k <= 20; k++) y += deckY(xa + ((xb - xa) * k) / 20) / 21
    const ids = [[xa, -hw], [xb, -hw], [xb, hw], [xa, hw]].map(([x, z]) => m.v([x, y, z], [0, 1, 0], TINT.deck, 0))
    m.quad(...ids)
  } else {
    body(m, plan, lod)
  }
  // Posts and their tops are built at every LOD so the sockets and lights agree; below LOD 0 they go to a mesher nobody keeps.
  const { sockets, lights } = posts(lod === 0 ? m : new Mesher(), plan, decor, decorSeed)
  return finish(m, o, sockets, lights)
}

/** The underside path, -x to +x: foundation runs at -depth, each arch's legs and soffit. Each station carries the way the masonry faces there. */
function underside(plan, nArc, runStep, waterline) {
  const { o, arches, xa, xb } = plan
  const U = []
  const push = (x, y, h) => {
    const last = U[U.length - 1]
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.y - y) < 1e-6) return
    U.push({ x, y, h })
  }
  const run = (x0, x1) => { const n = Math.max(1, Math.ceil((x1 - x0) / runStep)); for (let k = 0; k <= n; k++) push(x0 + ((x1 - x0) * k) / n, -o.depth, [0, -1, 0]) }
  // Legs keep a station at the waterline, where the damp tint turns.
  const leg = (x, ys, hx) => { for (const y of ys) push(x, y, [hx, 0, 0]) }
  let cursor = xa
  for (const ar of arches) {
    const n = Math.max(nArc, Math.round((nArc * ar.a) / 3.5))
    run(cursor, ar.cx - ar.a)
    const wl = waterline ? Math.min(0.6, ar.spring) : -o.depth
    leg(ar.cx - ar.a, [-o.depth, wl, ar.spring], 1)
    for (let k = 0; k <= n; k++) {
      const q = (k / n) * Math.PI, c = Math.cos(q), s = Math.sin(q)
      push(ar.cx - ar.a * c, ar.spring + ar.b * s, [ar.a * c, -ar.b * s, 0])
    }
    leg(ar.cx + ar.a, [ar.spring, wl, -o.depth], -1)
    cursor = ar.cx + ar.a
  }
  run(cursor, xb)
  return U
}

/** The masonry: the body, and at LOD 0 its parapets, string course, arch rings and cutwaters. */
function body(m, plan, lod) {
  const { o, arches, piers, xa, xb, hw, deckY, deckAt } = plan
  const rng = mulberry32(o.seed * 104729 + 3)
  const j = (a) => (rng() * 2 - 1) * a * o.jitter
  const full = lod === 0
  const U = underside(plan, full ? 10 : 4, full ? 2.2 : Infinity, full)
  // LOD 1 stands the walls' tops on the deck's edge: from afar the parapets are the bridge's outline.
  const topY = full ? deckY : (x) => deckY(x) + o.wallH
  const L = xb - xa
  const nX = Math.ceil(L / (full ? 1.5 : 4))
  const X = Array.from({ length: nX + 1 }, (_, k) => xa + (L * k) / nX)
  const Z = full ? [-hw, 0, hw] : [-hw, hw]
  const deckOf = full ? deckAt : topY
  const onBed = (k) => U[k].y === -o.depth && U[k + 1].y === -o.depth

  // Two spandrel faces, split at the waterline at LOD 0; the underside, less the foundations' buried floor; the deck; the two ends.
  for (const s of [-1, 1]) {
    const ys = (k) => { const y0 = U[k].y, y1 = topY(U[k].x); return full ? [y0, Math.min(y1, Math.max(y0, 0.6)), y1] : [y0, y1] }
    m.grid(U.length - 1, full ? 2 : 1, (k, r) => [[U[k].x, ys(k)[r], s * hw], [0, 0, s]], TINT.body)
  }
  m.grid(U.length - 1, 1, (k, zi) => [[U[k].x, U[k].y, (2 * zi - 1) * hw], U[k].h], TINT.body, { skip: onBed })
  m.grid(X.length - 1, Z.length - 1, (k, zi) => [[X[k], deckOf(X[k], Z[zi]), Z[zi]], [0, 1, 0]], TINT.deck, { wet: 0 })
  for (const [x, hx] of [[xa, -1], [xb, 1]]) {
    m.grid(Z.length - 1, 1, (zi, r) => [[x, r ? deckOf(x, Z[zi]) : -o.depth, Z[zi]], [hx, 0, 0]], TINT.body)
  }
  if (!full) return

  // Parapets and the string course under them: swept along x, standing plumb whatever the deck's slope.
  const px0 = xa + 0.12, px1 = xb - 0.12
  const np = Math.max(4, Math.ceil((px1 - px0) / 2.2))
  const wob = Array.from({ length: np + 1 }, () => j(1))
  const smoothWob = wob.map((_, k) => (wob[Math.max(0, k - 1)] + 2 * wob[k] + wob[Math.min(np, k + 1)]) / 4)
  const rr = Math.min(0.15, o.wallT * 0.35)
  for (const s of [-1, 1]) {
    const st = Array.from({ length: np + 1 }, (_, k) => {
      const x = px0 + ((px1 - px0) * k) / np
      return { o: [x, deckY(x), s * (hw + smoothWob[k] * 0.025)], u: [0, 0, s], v: [0, 1, 0] }
    })
    sweep(m, st, (k) => {
      const t = o.wallH * (1 + 0.06 * smoothWob[(k + 3) % (np + 1)])
      const lean = 0.03 * smoothWob[(k + 7) % (np + 1)]
      const prof = [[0.03, -0.25], [0.03, t - rr], [0.03 - rr, t], [-o.wallT + rr, t], [-o.wallT, t - rr], [-o.wallT, -0.25]]
      return prof.map(([u, v]) => [u + (lean * Math.max(0, v)) / o.wallH, v])
    }, TINT.wall, { caps: true, wet: 0 })
    sweep(m, st, () => [[-0.02, -0.08], [0.07, -0.11], [0.07, -0.27], [-0.02, -0.31]], TINT.ring, { open: true, wet: 0 })
  }

  // Arch rings, proud of the spandrel, each station its own depth, and a keystone.
  for (const ar of arches) {
    const nq = Math.max(6, Math.round((10 * ar.a) / 3.5))
    const depthOf = Array.from({ length: nq + 1 }, () => ar.ringT * (1 + j(0.14)))
    for (const s of [-1, 1]) {
      const st = Array.from({ length: nq + 1 }, (_, k) => {
        const q = (k / nq) * Math.PI, c = Math.cos(q), sn = Math.sin(q)
        return { o: [ar.cx - ar.a * c, ar.spring + ar.b * sn, s * hw], u: norm([-c / ar.a, sn / ar.b, 0]), v: [0, 0, s] }
      })
      sweep(m, st, (k) => [[-0.04, -0.02], [-0.04, 0.06], [depthOf[k], 0.06], [depthOf[k], -0.02]], TINT.ring, { open: true })
      const kF = frame([ar.cx, ar.spring + ar.b + ar.ringT * 0.5, s * (hw + 0.03)])
      block(m, rng, tip(kF, 'az', j(0.04)), [0.2, ar.ringT * 0.62 + 0.06, 0.13], TINT.ring, { sides: 4, bevel: 0.04, crook: 0.025, bottom: true })
    }
  }

  // Cutwaters: a pointed nose each side of every pier, hooded back into the wall above the springing.
  for (const p of piers) {
    const near = arches.filter((ar) => Math.abs(ar.cx + ar.a - p.x0) < 1e-6 || Math.abs(ar.cx - ar.a - p.x1) < 1e-6)
    const yTop = Math.max(0.8, Math.min(...near.map((ar) => ar.spring)) + 0.2)
    const x0 = p.x0 + 0.03, x1 = p.x1 - 0.03, xm = (x0 + x1) / 2
    const nose = (x1 - x0) * 0.6
    const foot = (len) => [[x0, 0], [x0 + (xm - x0) * 0.85, len * 0.85], [xm, len * 0.96], [x1 + (xm - x1) * 0.85, len * 0.85], [x1, 0]]
    const ys = [[-o.depth, nose], [Math.min(0.6, yTop - 0.1), nose], [yTop, nose], [yTop + nose * 0.7, 0]]
    for (const s of [-1, 1]) {
      const rings = ys.map(([y, len]) => foot(len).map(([x, zo]) => [x, y, s * (hw + zo)]))
      m.grid(4, ys.length - 1, (i, k) => {
        const q = rings[k][i]
        return [q, [q[0] - xm, k === ys.length - 1 ? 0.6 : 0, s * (q[2] * s - hw + 0.1)]]
      }, TINT.body)
    }
  }
}

/** Posts, and what stands on them. */
function posts(m, plan, decor, decorSeed) {
  const { o, deckY } = plan
  const rng = mulberry32(o.seed * 15485863 + 5)
  const j = (a) => (rng() * 2 - 1) * a * o.jitter
  const kinds = plan.posts.map((_, i) => (Array.isArray(decor) ? decor[i] : decor))
  if (kinds.some((k) => k !== 'random' && !DECOR_KINDS.includes(k))) throw new Error(`buildBridge: unknown decor in ${JSON.stringify(kinds)}`)
  const drng = mulberry32(decorSeed * 2654435761 + 11)
  const roll = () => {
    const tot = DECOR_KINDS.reduce((s, k) => s + DECOR_WEIGHTS[k], 0)
    let r = drng() * tot
    for (const k of DECOR_KINDS) { r -= DECOR_WEIGHTS[k]; if (r <= 0) return k }
    return 'bare'
  }
  // Two posts facing each other across the road usually match; now and then they do not.
  for (let i = 0; i < kinds.length; i += 2) {
    if (kinds[i] !== 'random') continue
    kinds[i] = roll()
    kinds[i + 1] = drng() < 0.7 ? kinds[i] : roll()
  }
  const sockets = []
  const lights = []
  plan.posts.forEach((post, i) => {
    const ph = plan.postHalf
    const y0 = deckY(post.x) - 0.2
    const F = tip(tip(frame([post.x, y0 + (post.h + 0.2) / 2, post.z], j(0.08)), 'ax', j(0.02)), 'az', j(0.02))
    block(m, rng, F, [ph, (post.h + 0.2) / 2, ph], TINT.post, { bevel: 0.07, crook: 0.03 })
    const top = put(F, 0, (post.h + 0.2) / 2 - 0.02, 0)
    sockets.push({ p: top, side: post.side, kind: post.kind, decor: kinds[i] })
    DECOR[kinds[i]](m, rng, top, ph, post.side, lights, j)
  })
  return { sockets, lights }
}

const DECOR = {
  bare() {},
  cap(m, rng, at, ph, side, lights, j) {
    block(m, rng, frame(add(at, [0, 0.06, 0]), j(0.1)), [ph * 1.15, 0.07, ph * 1.15], TINT.post, { sides: 4, bevel: 0.03 })
    pebble(m, rng, frame(add(at, [0, 0.22, 0])), [ph * 0.55, 0.1, ph * 0.55], TINT.post)
  },
  cairn(m, rng, at, ph, side, lights, j) {
    let y = at[1], r = ph * 0.95
    const n = 3 + Math.floor(rng() * 2)
    for (let k = 0; k < n; k++) {
      const ry = r * (0.42 + rng() * 0.15)
      const c = [at[0] + j(0.05), y + ry * 0.9, at[2] + j(0.05)]
      pebble(m, rng, tip(frame(c), 'ax', j(0.12)), [r * (0.9 + rng() * 0.2), ry, r * (0.8 + rng() * 0.2)], TINT.post)
      y += ry * 1.7
      r *= 0.72 + rng() * 0.1
    }
  },
  lantern(m, rng, at, ph, side, lights) {
    const yaw = rng() * TAU, F = frame(at, yaw)
    const at2 = (x, y, z) => ({ ...F, o: put(F, x, y, z) })
    block(m, rng, at2(0, 0.03, 0), [0.15, 0.03, 0.15], TINT.iron, { sides: 4, bevel: 0.01, crook: 0.005 })
    const y0 = 0.06, hgt = 0.34
    block(m, rng, at2(0, y0 + hgt / 2, 0), [0.1, hgt / 2, 0.1], TINT.glass, { sides: 4, bevel: 0.02, crook: 0 })
    lathe(m, frame(put(F, 0, y0 + hgt, 0), yaw + Math.PI / 4), [[0, 0], [0.2, 0], [0.04, 0.15], [0, 0.21]], TINT.iron, { segs: 4 })
    lights.push({ p: put(F, 0, y0 + hgt / 2, 0), kind: 'lantern' })
  },
  brazier(m, rng, at, ph, side, lights) {
    const F = frame(at)
    lathe(m, F, [[0, 0], [0.12, 0], [0.3, 0.22], [0.25, 0.24], [0, 0.14]], TINT.post, { segs: 6 })
    pebble(m, rng, frame(add(at, [0, 0.19, 0])), [0.21, 0.06, 0.21], TINT.coal)
    lights.push({ p: add(at, [0, 0.36, 0]), kind: 'fire' })
  },
  runestone(m, rng, at, ph, side, lights, j) {
    const F = tip(tip(frame(add(at, [0, 0.42, 0]), j(0.15)), 'az', side * 0.06 + j(0.05)), 'ax', j(0.05))
    block(m, rng, F, [ph * 0.8, 0.48, 0.09], TINT.post, { bevel: 0.05, crook: 0.04 })
  },
}

// --- finishing ------------------------------------------------------------------

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

/**
 * Displace, shade and texture. The displacement is one smooth field of position, so every surface that shares an edge moves the same way and nothing cracks open. UVs are box-projected per TRIANGLE (a vertex is split where two projections meet), so the rubble meets itself at a corner rather than smearing across it.
 */
function finish(m, o, sockets, lights) {
  const nA = noise3(o.seed), nB = noise3(o.seed + 101), nC = noise3(o.seed + 202), nV = noise3(o.seed + 303)
  const amp1 = 0.055 * o.jitter, amp2 = 0.018 * o.jitter
  const warp = (p) => {
    const [x, y, z] = p
    const l1 = 1 / 3.2, l2 = 1 / 0.8
    return [
      x + amp1 * nA(x * l1, y * l1, z * l1) + amp2 * nA(x * l2 + 9, y * l2, z * l2),
      y + 0.6 * (amp1 * nB(x * l1, y * l1, z * l1) + amp2 * nB(x * l2 + 9, y * l2, z * l2)),
      z + amp1 * nC(x * l1, y * l1, z * l1) + amp2 * nC(x * l2 + 9, y * l2, z * l2),
    ]
  }
  const nv = m.count
  const P = new Float32Array(nv * 3)
  for (let i = 0; i < nv; i++) P.set(warp([m.p[i * 3], m.p[i * 3 + 1], m.p[i * 3 + 2]]), i * 3)

  const N = new Float32Array(nv * 3)
  const I = m.idx
  const face = (t) => {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3
    return cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]])
  }
  for (let t = 0; t < I.length; t += 3) {
    const f = face(t)
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) N[I[t + k] * 3 + c] += f[c]
  }

  const tile = TILE_METRES[LAYER.STONE] * o.stone
  const off = [o.seed * 0.37 % 1, o.seed * 0.61 % 1]
  const pos = [], nrm = [], uv = [], col = [], index = []
  const split = new Map()
  for (let t = 0; t < I.length; t += 3) {
    const f = face(t)
    const ax = Math.abs(f[0]) >= Math.abs(f[1]) && Math.abs(f[0]) >= Math.abs(f[2]) ? 0 : Math.abs(f[1]) >= Math.abs(f[2]) ? 1 : 2
    for (let k = 0; k < 3; k++) {
      const v = I[t + k], key = v * 3 + ax
      let id = split.get(key)
      if (id === undefined) {
        id = pos.length / 3
        split.set(key, id)
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]
        pos.push(x, y, z)
        const n = norm([N[v * 3], N[v * 3 + 1], N[v * 3 + 2]])
        nrm.push(...n)
        const [a, b] = ax === 0 ? [z, y] : ax === 1 ? [x, z] : [x, y]
        uv.push(a / tile + off[0], b / tile + off[1])
        // Stone to stone variation, then the waterline: damp and greened below it on the masonry that stands in the river.
        const vary = 1 + 0.09 * nV(x * 0.8, y * 0.8, z * 0.8)
        const wet = m.w[v] * smoothstep(1.1, -0.2, y) * 0.75
        for (let c = 0; c < 3; c++) col.push(m.t[v * 3 + c] * vary * (1 - wet + wet * TINT.damp[c]))
      }
      index.push(id)
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  g.setAttribute('texLayer', new THREE.BufferAttribute(new Float32Array(pos.length / 3).fill(LAYER.STONE), 1))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return {
    geometry: g,
    sockets: sockets.map((s) => ({ ...s, p: warp(s.p) })),
    lights: lights.map((l) => ({ ...l, p: warp(l.p) })),
    stats: { triangles: index.length / 3, vertices: pos.length / 3 },
  }
}
