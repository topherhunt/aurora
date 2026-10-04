// A cave system's topology (design/39-caves.md §3, §5): chambers and the passages between them, rolled from the system's seed. Pure.
//
// THE NO-TRAP RULE IS STRUCTURAL. Every node hangs off a spanning tree of two-way edges (walks and sumps), so any node reaches a mouth by walking and swimming alone. One-way drops are only ever added on top of the tree, as shortcuts down. check-caves.mjs proves it on the graph and then on the built walk surface.
//
// Cave-local metres: the mouths stand at y = 0 and everything else is below.

import { mulberry32 } from '../../sim/mathx.js'
import { PALETTES, GLOWS } from './regions.js'

// Steepest walk grade (rise over run) a passage is given; well under the 50 degree limit with the floor's rubble on it.
export const GRADE_MAX = 0.36
// The fraction of a node's radius (toward the passage) its passage stays flat for: out to where the node's own floor meets its wall, so no step is left at the doorway.
const FLAT_IN = 0.92
const SPACING = 26
const LINK_MAX = 82
// Metres of a drop's lip: over her reach, so it cannot be climbed back up.
export const DROP_MIN = 2.2
// Headroom a drop's passage keeps above its lip, inside the chamber it opens onto.
const DROP_ROOM = 3.0
// How far a river's channel is cut below its passage's floor, and how far under the floor line its water stands.
export const RIVER_DEPTH = 0.6
export const RIVER_FREEBOARD = 0.15
// Steepest flank of a sump's dip: a swimmer stands up out of it and climbs on.
const SUMP_GRADE = 0.75
// Passage profile samples, metres apart.
const SAMPLE = 2

/**
 * `entries` are the mouths in cave-local plan, [{ x, z, dx, dz }] with (dx, dz) the unit direction the passage leads in.
 * Returns `{ nodes, edges, pools, rivers, glows, regions }`; see the field shapes where each is built.
 */
export function buildGraph({ seed, entries }) {
  if (entries.length === 0) throw new Error('buildGraph: a system needs at least one mouth')
  const rand = mulberry32(seed)
  const rr = (a, b) => a + (b - a) * rand()
  const nodes = []
  const add = (n) => { n.i = nodes.length; n.region = -1; n.dish = 0; nodes.push(n); return n }

  // The mouths and their throats.
  const throats = []
  for (let e = 0; e < entries.length; e++) {
    const { x, z, dx, dz } = entries[e]
    add({ kind: 'mouth', entry: e, x, z, y: 0, rx: 1.4, rz: 1.4, rot: 0, h: 2.7 })
    throats.push(add({ kind: 'junction', entry: -1, x: x + dx * 18, z: z + dz * 18, y: 0, rx: 3, rz: 3, rot: 0, h: 3.4 }))
  }

  // The body: darts in a disc round the throats, at SPACING.
  const want = Math.min(64, 22 + 12 * entries.length)
  const cx = throats.reduce((s, n) => s + n.x, 0) / throats.length
  const cz = throats.reduce((s, n) => s + n.z, 0) / throats.length
  const R = 16 * Math.sqrt(want) + 20
  for (let tries = 0; tries < 4000 && nodes.length < want + 2 * entries.length; tries++) {
    const a = rand() * Math.PI * 2, r = R * Math.sqrt(rand())
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (nodes.some((n) => Math.hypot(n.x - x, n.z - z) < (n.kind === 'mouth' ? SPACING * 1.4 : SPACING))) continue
    add({ kind: 'junction', entry: -1, x, z, y: 0, rx: 3, rz: 3, rot: 0, h: 3.4 })
  }

  // Caverns where the darts are furthest from any mouth, and the nodes they swallow dropped.
  const fromMouth = (n) => Math.min(...nodes.filter((m) => m.kind === 'mouth').map((m) => Math.hypot(m.x - n.x, m.z - n.z)))
  const body = nodes.filter((n) => n.kind === 'junction' && !throats.includes(n))
  const byFar = [...body].sort((a, b) => fromMouth(b) - fromMouth(a))
  const caverns = []
  for (const n of byFar) {
    if (caverns.length >= 1 + Math.floor(want / 26)) break
    if (fromMouth(n) < 70 || caverns.some((c) => Math.hypot(c.x - n.x, c.z - n.z) < 90)) continue
    n.kind = 'cavern'
    n.rx = rr(17, 25); n.rz = rr(14, 21); n.rot = rand() * Math.PI; n.h = rr(30, 48)
    caverns.push(n)
  }
  const swallowed = new Set()
  for (const c of caverns) for (const n of nodes) if (n !== c && n.kind === 'junction' && !throats.includes(n) && Math.hypot(n.x - c.x, n.z - c.z) < Math.max(c.rx, c.rz) + 8) swallowed.add(n)
  for (const n of body) {
    if (swallowed.has(n) || n.kind !== 'junction') continue
    if (rand() < 0.5) {
      n.kind = 'chamber'
      n.rx = rr(5, 9); n.rz = rr(4, 8); n.rot = rand() * Math.PI; n.h = rr(5, 9)
    } else {
      n.rx = n.rz = rr(2.2, 3.2); n.h = rr(3, 4.2)
    }
  }
  const live = nodes.filter((n) => !swallowed.has(n))
  const remap = new Map(live.map((n, i) => [n, i]))
  nodes.length = 0
  for (const n of live) { n.i = remap.get(n); nodes.push(n) }

  // Candidate links, then a randomly weighted spanning tree over them.
  const reachOf = (n) => (n.kind === 'cavern' ? Math.max(n.rx, n.rz) : 0)
  const cands = []
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const A = nodes[a], B = nodes[b]
      if (A.kind === 'mouth' || B.kind === 'mouth') continue
      const d = Math.hypot(A.x - B.x, A.z - B.z)
      if (d > LINK_MAX + reachOf(A) + reachOf(B)) continue
      cands.push({ a, b, d, w: d * (0.6 + 0.8 * rand()) })
    }
  }
  cands.sort((p, q) => p.w - q.w)
  const up = nodes.map((_, i) => i)
  const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])))
  const edges = []
  const link = (a, b, tree) => {
    const e = { i: edges.length, a, b, kind: 'walk', tree, squeeze: false, river: false, sump: null, drop: 0, pts: null }
    edges.push(e)
    return e
  }
  for (let e = 0; e < entries.length; e++) {
    const m = nodes.find((n) => n.kind === 'mouth' && n.entry === e)
    const t = throats[e]
    link(m.i, t.i, true)
    up[find(m.i)] = find(t.i)
  }
  const extra = []
  for (const c of cands) {
    if (find(c.a) !== find(c.b)) { up[find(c.a)] = find(c.b); link(c.a, c.b, true) } else extra.push(c)
  }
  // Anything LINK_MAX left stranded joins its nearest neighbour in the main body.
  for (;;) {
    const root = find(nodes[0].i)
    const lost = nodes.filter((n) => find(n.i) !== root)
    if (lost.length === 0) break
    let best = null
    for (const n of lost) for (const m of nodes) {
      if (find(m.i) !== root || m.kind === 'mouth' || n.kind === 'mouth') continue
      const d = Math.hypot(n.x - m.x, n.z - m.z)
      if (best === null || d < best.d) best = { a: n.i, b: m.i, d }
    }
    if (best === null) throw new Error('buildGraph: a stranded node has nothing to join')
    up[find(best.a)] = find(best.b)
    link(best.a, best.b, true)
  }

  // Depth, outward from the mouths along the tree.
  const adj = nodes.map(() => [])
  for (const e of edges) { adj[e.a].push(e); adj[e.b].push(e) }
  const seen = new Set()
  const queue = []
  for (const n of nodes) if (n.kind === 'mouth') { n.y = 0; seen.add(n.i); queue.push(n.i) }
  while (queue.length > 0) {
    const i = queue.shift()
    for (const e of adj[i]) {
      const j = e.a === i ? e.b : e.a
      if (seen.has(j)) continue
      seen.add(j)
      const A = nodes[i], B = nodes[j]
      const run = between(A, B)
      const g = B.kind === 'cavern' ? GRADE_MAX * 0.95 : A.kind === 'mouth' ? 0.12 : rand() < 0.15 ? -0.08 : rr(0.06, 0.32)
      B.y = Math.max(-160, A.y - run * g)
      queue.push(j)
    }
  }
  // The tree edges where two mouths' fronts met were never graded: lift the lower end of any too steep, until none is. Only ever up, so it settles.
  for (let moved = true; moved;) {
    moved = false
    for (const e of edges) {
      const A = nodes[e.a], B = nodes[e.b]
      const lo = A.y < B.y ? A : B, hi = lo === A ? B : A
      const floor = hi.y - between(A, B) * GRADE_MAX * 0.95
      if (lo.y < floor - 1e-6) { lo.y = floor; moved = true }
    }
  }

  // Braids: walks where the grade allows, drops where it does not and the lower chamber can take the lip.
  const degree = nodes.map((n) => adj[n.i].length)
  let braids = 0
  for (const c of extra) {
    if (braids >= Math.ceil(nodes.length * 0.3)) break
    if (degree[c.a] >= 4 || degree[c.b] >= 4 || rand() > 0.4) continue
    const hi = nodes[c.a].y >= nodes[c.b].y ? nodes[c.a] : nodes[c.b]
    const lo = hi === nodes[c.a] ? nodes[c.b] : nodes[c.a]
    const run = between(hi, lo)
    const dy = hi.y - lo.y
    if (dy <= run * GRADE_MAX) {
      link(c.a, c.b, false)
    } else {
      const lip = dy - run * GRADE_MAX * 0.8
      if (lo.kind === 'junction' || lip < DROP_MIN || lip > lo.h - DROP_ROOM - 2.6) continue
      const e = link(hi.i, lo.i, false)
      e.kind = 'drop'
      e.drop = lip
    }
    degree[c.a]++; degree[c.b]++
    braids++
  }

  // Regions: grown along the tree from scattered seeds, 3-8 nodes each, then coloured so neighbours differ.
  const order = nodes.map((n) => n.i).sort(() => rand() - 0.5)
  const regions = []
  for (const s of order) {
    if (nodes[s].region >= 0 || nodes[s].kind === 'mouth') continue
    const r = { i: regions.length, nodes: [], palette: -1, landmark: -1 }
    regions.push(r)
    const size = 3 + Math.floor(rand() * 6)
    const front = [s]
    while (front.length > 0 && r.nodes.length < size) {
      const k = front.shift()
      if (nodes[k].region >= 0 || nodes[k].kind === 'mouth') continue
      nodes[k].region = r.i
      r.nodes.push(k)
      for (const e of adj[k]) if (e.tree) front.push(e.a === k ? e.b : e.a)
    }
  }
  for (const n of nodes) if (n.kind === 'mouth') { const t = adj[n.i][0]; n.region = nodes[t.a === n.i ? t.b : t.a].region }
  const touch = regions.map(() => new Set())
  for (const e of edges) {
    const ra = nodes[e.a].region, rb = nodes[e.b].region
    if (ra !== rb) { touch[ra].add(rb); touch[rb].add(ra) }
  }
  const used = PALETTES.map(() => 0)
  for (const r of regions) {
    const ban = new Set([...touch[r.i]].map((k) => regions[k].palette).filter((p) => p >= 0))
    const free = PALETTES.map((_, p) => p).filter((p) => !ban.has(p))
    const least = Math.min(...free.map((p) => used[p]))
    const pick = free.filter((p) => used[p] === least)
    r.palette = pick[Math.floor(rand() * pick.length)]
    used[r.palette]++
    const big = r.nodes.map((k) => nodes[k]).filter((n) => n.kind !== 'junction').sort((a, b) => b.rx * b.rz - a.rx * a.rz)[0]
    r.landmark = big ? big.i : -1
  }

  // Squeezes where a tree passage crosses between regions; rivers along the gentle ones; sumps dipped under water.
  const pools = []
  const rivers = []
  let sumps = 0
  for (const e of edges) {
    const A = nodes[e.a], B = nodes[e.b]
    const run = between(A, B)
    const nearMouth = A.kind === 'mouth' || B.kind === 'mouth' || throats.includes(A) || throats.includes(B)
    if (e.tree && !nearMouth && A.region !== B.region && rand() < 0.5) e.squeeze = true
    // Deep enough under the lower end that the roof at the dip is a metre under the water, and long enough that the cosine's steepest flank (dip pi / run) stays a swimmer's climb out.
    const dip = rr(4.2, 5.2) + Math.abs(A.y - B.y) / 2
    if (e.kind === 'walk' && e.tree && !nearMouth && !e.squeeze && sumps < 3 && (dip * Math.PI) / run <= SUMP_GRADE && Math.abs(A.y - B.y) < 6 && rand() < 0.2) {
      e.kind = 'sump'
      e.sump = { dip, level: Math.min(A.y, B.y) - 0.2 }
      sumps++
    } else if (e.kind === 'walk' && !nearMouth && run >= 20 && Math.abs(A.y - B.y) / run <= 0.14 && rand() < 0.3) {
      e.river = true
    }
  }
  for (const n of nodes) {
    if (n.kind === 'chamber' && rand() < 0.22) n.dish = rr(1.6, 3.6)
    if (n.kind === 'cavern' && rand() < 0.65) n.dish = rr(3, 7)
    if (n.dish > 0) pools.push({ node: n.i, x: n.x, z: n.z, level: n.y - 0.25, r: Math.min(n.rx, n.rz) * (n.kind === 'cavern' ? 0.62 : 0.66), depth: n.dish })
  }

  // Passages that would breach another's floor or a foreign node: a tree passage rerolls its bend, a braid is given up.
  const built = []
  for (const e of [...edges.filter((q) => q.tree), ...edges.filter((q) => !q.tree)]) {
    for (let k = 0; k < 8 && (e.pts === null || clashes(e, built, nodes)); k++) e.pts = profile(e, nodes, rand)
    if (!e.tree && clashes(e, built, nodes)) { e.pts = null; continue }
    built.push(e)
  }
  for (let k = edges.length - 1; k >= 0; k--) if (edges[k].pts === null) edges.splice(k, 1)
  edges.forEach((e, i) => { e.i = i })
  for (const e of edges) if (e.kind === 'sump') pools.push({ edge: e.i, level: e.sump.level, depth: e.sump.dip })
  for (const e of edges) if (e.river) rivers.push(e.i)

  // Glows: mushroom lights by palette, and by both ends of every sump.
  const glows = []
  for (const n of nodes) {
    if (n.kind === 'mouth') continue
    const pal = PALETTES[regions[n.region].palette]
    const sumpEnd = edges.some((e) => e.kind === 'sump' && (e.a === n.i || e.b === n.i))
    if (!(sumpEnd ? rand() < 0.85 : rand() < pal.glow)) continue
    const a = rand() * Math.PI * 2, r = Math.min(n.rx, n.rz) * 0.55
    glows.push({ node: n.i, x: n.x + Math.cos(a) * r, z: n.z + Math.sin(a) * r, color: GLOWS[Math.floor(rand() * GLOWS.length)], reach: n.kind === 'cavern' ? 16 : 9 })
  }

  return { nodes, edges, pools, rivers, glows, regions }
}

// Rock under this much between two passages stacked in one plan spot.
const SILL = 1.5

/** Whether passage e's samples come within a wall of another built passage or a node it does not end at, with less than SILL of rock between them. */
export function clashes(e, built, nodes) {
  for (const f of built) {
    // Two passages from one node meet in it; past its walls they must part like any other two.
    const shared = [e.a, e.b].filter((i) => i === f.a || i === f.b).map((i) => nodes[i])
    if (shared.length === 2) continue
    const near = (p) => shared.some((n) => Math.hypot(p.x - n.x, p.z - n.z) < Math.max(n.rx, n.rz) + 3)
    for (const p of e.pts) {
      if (near(p)) continue
      for (const q of f.pts) {
        if (!near(q) && Math.hypot(p.x - q.x, p.z - q.z) < p.w + q.w + 1 && p.y - SILL < q.y + q.h && q.y - SILL < p.y + p.h) return true
      }
    }
  }
  for (const n of nodes) {
    if (n.i === e.a || n.i === e.b) continue
    const c = Math.cos(n.rot), s = Math.sin(n.rot)
    for (const p of e.pts) {
      const dx = p.x - n.x, dz = p.z - n.z
      const lx = (dx * c + dz * s) / (n.rx + p.w + 1), lz = (dz * c - dx * s) / (n.rz + p.w + 1)
      if (lx * lx + lz * lz < 1 && p.y - SILL < n.y + n.h && n.y - n.dish - SILL < p.y + p.h) return true
    }
  }
  return false
}

// Plan metres of a passage's sloping run between two nodes' flat floors.
export function between(A, B) {
  const d = Math.hypot(A.x - B.x, A.z - B.z)
  return Math.max(6, d - flatOf(A, B.x, B.z) - flatOf(B, A.x, A.z))
}

// How far node n's flat floor reaches toward (x, z): its ellipse's radius that way, times FLAT_IN.
function flatOf(n, x, z) {
  const ux = x - n.x, uz = z - n.z
  const l = Math.hypot(ux, uz)
  const c = Math.cos(n.rot), s = Math.sin(n.rot)
  const lx = (ux * c + uz * s) / l / n.rx, lz = (uz * c - ux * s) / l / n.rz
  return FLAT_IN / Math.hypot(lx, lz)
}

/**
 * The passage as samples every SAMPLE metres from node a to node b: { x, z, y, w, h }, y the floor, w the half-width, h the height above it.
 * The plan line bends through a rolled midpoint; the floor is flat inside each node, a straight grade between, dipped for a sump and held at the lip for a drop.
 */
function profile(e, nodes, rand) {
  const A = nodes[e.a], B = nodes[e.b]
  const dx = B.x - A.x, dz = B.z - A.z
  const d = Math.hypot(dx, dz)
  // The mouth's passage runs straight in, so the daylight at its end shows from the throat.
  const mouth = A.kind === 'mouth' || B.kind === 'mouth'
  const bend = mouth ? 0 : (rand() - 0.5) * 0.5 * d
  const mx = (A.x + B.x) / 2 - (dz / d) * bend, mz = (A.z + B.z) / 2 + (dx / d) * bend
  const n = Math.max(3, Math.ceil(d / SAMPLE))
  let flatA = flatOf(A, mx, mz), flatB = flatOf(B, mx, mz)
  const yB = e.kind === 'drop' ? B.y + e.drop : B.y
  const baseW = e.kind === 'drop' || mouth ? 1.2 : 0.95 + rand() * 0.6
  const phase = rand() * 10
  const tall = rand() < 0.3 ? 1 : 0
  const pts = []
  let run = 0
  let px = A.x, pz = A.z
  for (let k = 0; k <= n; k++) {
    const u = k / n
    const x = (1 - u) * (1 - u) * A.x + 2 * u * (1 - u) * mx + u * u * B.x
    const z = (1 - u) * (1 - u) * A.z + 2 * u * (1 - u) * mz + u * u * B.z
    run += Math.hypot(x - px, z - pz)
    px = x; pz = z
    pts.push({ x, z, y: 0, w: 0, h: 0, s: run, cut: 0 })
  }
  const total = run
  // Close nodes give their flats up in proportion, so the slope always has 6 m to run over.
  if (total - flatA - flatB < 6) { const k = Math.max(0, total - 6) / (flatA + flatB); flatA *= k; flatB *= k }
  // A walk steeper than GRADE_MAX starts its slope further into the high node, where it cuts a ramp down through that floor; in the low node it would leave a step at the wall.
  const short = e.kind === 'walk' ? Math.abs(yB - A.y) / GRADE_MAX - (total - flatA - flatB) : 0
  if (short > 0 && A.y > yB) flatA = Math.max(0, flatA - short)
  else if (short > 0) flatB = Math.max(0, flatB - short)
  const lo = flatA, hi = total - flatB
  for (const p of pts) {
    const t = p.s <= lo ? 0 : p.s >= hi ? 1 : (p.s - lo) / (hi - lo)
    p.y = A.y + (yB - A.y) * t
    if (e.kind === 'drop' && p.s >= hi) p.y = yB
    // A river's channel fades out over 3 m before each node's floor, so it never ends in a step.
    p.cut = e.river ? RIVER_DEPTH * Math.min(1, Math.max(0, Math.min(p.s - lo, hi - p.s) / 3)) : 0
    const wave = Math.sin(p.s * 0.21 + phase) * 0.5 + Math.sin(p.s * 0.53 + phase * 2) * 0.3
    p.w = baseW * (1 + 0.32 * wave)
    p.h = 2.3 + 0.3 * (wave + 1) + tall * 2.4 * Math.max(0, Math.sin(p.s * 0.09 + phase))
    if (e.squeeze) {
      const mid = 1 - Math.min(1, Math.abs(p.s / total - 0.5) / 0.18)
      p.w = Math.max(0.9, p.w * (1 - 0.45 * mid))
      p.h = Math.max(2.4, p.h - 0.6 * mid)
    }
    if (e.kind === 'sump' && t > 0 && t < 1) {
      p.y -= e.sump.dip * (0.5 - 0.5 * Math.cos(2 * Math.PI * t))
      p.h = 2.8
    }
  }
  pts[0].w = pts[pts.length - 1].w = Math.max(pts[0].w, 1.1)
  return pts
}
