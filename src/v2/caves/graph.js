// A cave system's topology (design/39-caves.md §3, §5): chambers and the passages between them, rolled from the system's seed. Pure.
//
// THE NO-TRAP RULE IS STRUCTURAL. Every node hangs off a spanning tree of two-way edges (walks and sumps), so any node reaches a mouth by walking and swimming alone. One-way drops are only ever added on top of the tree, as shortcuts down. check-caves.mjs proves it on the graph and then on the built walk surface.
//
// Cave-local metres: the mouths stand at y = 0 and everything else is below.

import { mulberry32 } from '../../sim/mathx.js'
import { PALETTES, GLOWS } from './regions.js'
import { Noise3 } from './noise3.js'

// Steepest walk grade (rise over run) a passage is given; well under the 50 degree limit with the floor's rubble on it.
export const GRADE_MAX = 0.42
// The fraction of a node's radius (toward the passage) its passage stays flat for: out to where the node's own floor meets its wall, so no step is left at the doorway.
const FLAT_IN = 0.92
const FLAT_OUT = 0.97
// Plan metres between body nodes, the longest link a passage is laid for, and the plan area one body node takes. The disc the body fills is at least BODY_R, and no node stands more than NODE_LIMIT from the system's centre (chalk.js packs points about it).
const SPACING = 26
const LINK_MAX = 76
const NODE_AREA = 900
const BODY_R = 240
const BODY_CAP = 260
const NODE_LIMIT = 540
// Rock kept between two nodes' ellipses, so no two floors merge into a step.
const NODE_GAP = 4
// Metres of a drop's lip: over her reach, so it cannot be climbed back up, and short of a fall that hurts her badly (vitals.js FALL).
export const DROP_MIN = 2.2
const DROP_MAX = 9
// Headroom a drop's passage keeps above its lip, inside the chamber it opens onto.
const DROP_ROOM = 3.0
// How far a river's channel is cut below its passage's floor; its water stands under its banks (water.js `stream`).
export const RIVER_DEPTH = 0.6
// Steepest flank of a sump's dip: a swimmer stands up out of it and climbs on.
const SUMP_GRADE = 0.75
// A drowned passage: out of a pool at least DROWN_DISH deep, DROWN_H high with its roof DROWN_ROOF under the surface until it is DROWN_OUT of the cavern's radius out, under the dry rim; it swims up at DROWN_RISE to the surface, then walks.
const DROWN_DISH = 6
const DROWN_H = 2.3
const DROWN_ROOF = 1
const DROWN_OUT = 1.15
const DROWN_RISE = 0.6
// A room holds water only if every neighbour stands SINK_RISE over it; a flooded one stands FLOOD metres deep over its nominal floor.
const SINK_RISE = 0.3
const FLOOD = [0.4, 1.6]
// Odds a plain braid is choked by a rockfall.
const CHOKE_ODDS = 0.4
const drownedFloor = (A) => A.y - 0.25 - DROWN_ROOF - DROWN_H
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
    add({ kind: 'mouth', entry: e, x, z, y: 0, rx: 1.4, rz: 1.4, rot: 0, h: 2.7, dx, dz, cellar: entries[e].cellar === true })
    throats.push(add({ kind: 'junction', entry: -1, x: x + dx * 14, z: z + dz * 14, y: 0, rx: 3, rz: 3, rot: 0, h: 3.4 }))
  }

  // The body: darts in a disc round the throats, at SPACING, as many as the disc holds.
  const cx = throats.reduce((s, n) => s + n.x, 0) / throats.length
  const cz = throats.reduce((s, n) => s + n.z, 0) / throats.length
  const R = Math.max(BODY_R, 60 + Math.max(...throats.map((n) => Math.hypot(n.x - cx, n.z - cz))))
  const want = Math.min(BODY_CAP, Math.round((Math.PI * R * R) / NODE_AREA))
  const sys = entries.filter((q) => q.cellar !== true)
  const sx = (sys.length > 0 ? sys : entries).reduce((s, q) => s + q.x, 0) / (sys.length > 0 ? sys.length : entries.length)
  const sz = (sys.length > 0 ? sys : entries).reduce((s, q) => s + q.z, 0) / (sys.length > 0 ? sys.length : entries.length)
  for (let tries = 0; tries < 12000 && nodes.length < want + 2 * entries.length; tries++) {
    const a = rand() * Math.PI * 2, r = R * Math.sqrt(rand())
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r
    if (Math.hypot(x - sx, z - sz) > NODE_LIMIT) continue
    if (nodes.some((n) => Math.hypot(n.x - x, n.z - z) < (n.kind === 'mouth' ? SPACING * 1.4 : SPACING))) continue
    add({ kind: 'junction', entry: -1, x, z, y: 0, rx: 3, rz: 3, rot: 0, h: 3.4 })
  }

  // Caverns where the darts are furthest from any mouth, and the nodes they swallow dropped.
  const fromMouth = (n) => Math.min(...nodes.filter((m) => m.kind === 'mouth').map((m) => Math.hypot(m.x - n.x, m.z - n.z)))
  const body = nodes.filter((n) => n.kind === 'junction' && !throats.includes(n))
  const byFar = [...body].sort((a, b) => fromMouth(b) - fromMouth(a))
  // The first, where there is room, is a great cavern (§3): 60 to 400 m long, its roof out of a torch's sight, kept 70 m clear of every mouth.
  const caverns = []
  for (const n of byFar) {
    if (caverns.length >= 1 + Math.floor(want / 40)) break
    if (fromMouth(n) < 110 || caverns.some((c) => Math.hypot(c.x - n.x, c.z - n.z) < 160 + Math.max(c.rx, c.rz))) continue
    n.kind = 'cavern'
    n.rot = rand() * Math.PI
    const len = 30 + 170 * rand() ** 1.3
    if (caverns.length === 0 && fromMouth(n) - 70 >= 30) {
      n.great = true
      n.rx = Math.min(len, fromMouth(n) - 70); n.rz = Math.max(24, n.rx * rr(0.35, 0.7)); n.h = rr(55, 90)
    } else {
      n.rx = rr(34, 50); n.rz = rr(28, 42); n.h = rr(45, 70)
      // A pool's cavern is two to four times the size, as far as the mouths and the caverns before it leave room.
      n.pool = rand() < 0.65
      if (n.pool) {
        const room = Math.min(fromMouth(n) - 70, ...caverns.map((c) => Math.hypot(c.x - n.x, c.z - n.z) - Math.max(c.rx, c.rz) - 40))
        const k = Math.max(1, Math.min(rr(2, 4), room / Math.max(n.rx, n.rz)))
        n.rx *= k; n.rz *= k; n.h = Math.min(100, n.h * Math.sqrt(k))
      }
    }
    caverns.push(n)
  }
  const swallowed = new Set()
  for (const c of caverns) for (const n of nodes) if (n !== c && n.kind === 'junction' && !throats.includes(n) && rhoOf(c, n, 8) < 1) swallowed.add(n)
  for (const n of body) {
    if (swallowed.has(n) || n.kind !== 'junction') continue
    n.rx = n.rz = rr(3.4, 5); n.h = rr(4, 5.6)
  }
  const live = nodes.filter((n) => !swallowed.has(n))
  // Chambers grow only as far as their neighbours leave room.
  const room = (n) => Math.min(...live.filter((m) => m !== n).map((m) => Math.hypot(m.x - n.x, m.z - n.z) - Math.max(m.rx, m.rz) - NODE_GAP))
  for (const n of live) {
    if (n.kind !== 'junction' || throats.includes(n) || rand() < 0.45) continue
    const r = Math.min(18, room(n))
    if (r < 9) continue
    n.kind = 'chamber'
    n.rx = rr(9, r); n.rz = rr(8, Math.min(16, n.rx)); n.rot = rand() * Math.PI; n.h = rr(8, 14)
  }
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
    const e = { i: edges.length, a, b, kind: 'walk', tree, squeeze: false, river: false, sump: null, drop: 0, choke: null, pts: null }
    edges.push(e)
    return e
  }
  for (let e = 0; e < entries.length; e++) {
    const m = nodes.find((n) => n.kind === 'mouth' && n.entry === e)
    const t = throats[e]
    link(m.i, t.i, true)
    up[find(m.i)] = find(t.i)
  }
  // A link may not cross another in plan, graze a node it does not end at, or leave a node alongside another: its passage would breach a floor no reroll could clear, or climb off its neighbour's floor in a ledge.
  const tangles = (a, b) => {
    const A = nodes[a], B = nodes[b]
    for (const e of edges) {
      if (alongside(e, a, b) || alongside(e, b, a)) return true
      if (e.a === a || e.a === b || e.b === a || e.b === b) continue
      if (cross(A, B, nodes[e.a], nodes[e.b])) return true
    }
    for (const n of nodes) {
      if (n.i === a || n.i === b) continue
      if (n.great ? grazes(n, A, B, 3) : segDist(n, A, B) < Math.max(n.rx, n.rz) + 3) return true
    }
    return false
  }
  // Within 50 degrees (or acos `near`) of each other out of node i, toward j and toward e's other end.
  const alongside = (e, i, j, near = 0.643) => {
    if (e.a !== i && e.b !== i) return false
    const N = nodes[i], J = nodes[j], K = nodes[e.a === i ? e.b : e.a]
    if (K === J) return false
    const ax = J.x - N.x, az = J.z - N.z, bx = K.x - N.x, bz = K.z - N.z
    return (ax * bx + az * bz) / Math.hypot(ax, az) / Math.hypot(bx, bz) > near
  }
  const extra = []
  for (const c of cands) {
    if (find(c.a) !== find(c.b) && !tangles(c.a, c.b)) { up[find(c.a)] = find(c.b); link(c.a, c.b, true) } else extra.push(c)
  }
  // Anything left stranded joins its nearest neighbour in the main body, untangled if it can be.
  for (;;) {
    const root = find(nodes[0].i)
    const lost = nodes.filter((n) => find(n.i) !== root)
    if (lost.length === 0) break
    let best = null
    for (const n of lost) for (const m of nodes) {
      if (find(m.i) !== root || m.kind === 'mouth' || n.kind === 'mouth') continue
      const d = Math.hypot(n.x - m.x, n.z - m.z) + (tangles(n.i, m.i) ? 1e4 : 0)
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
      const g = B.kind === 'cavern' ? GRADE_MAX * 0.95 : A.kind === 'mouth' ? 0.12 : (rand() < 0.2 ? -rr(0.04, 0.3) : rr(0.04, 0.38)) * 0.65
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

  // Braids: walks where the grade allows, and drops into any chamber that can take the lip, the passage graded up or down to it, so some open high in the wall near the roof. A great cavern takes every braid it can: its many branching tunnels.
  const degree = nodes.map((n) => adj[n.i].length)
  const cap = (n) => (n.great ? 16 : 4)
  // A braid from candidate c, laid at odds `odds` unless within acos `near` of a passage at either end, a walk where the grade allows (at odds 1 always) and else a drop: whether it was laid.
  const braid = (c, odds, near) => {
    const A = nodes[c.a], B = nodes[c.b]
    if (degree[c.a] >= cap(A) || degree[c.b] >= cap(B) || (odds < 1 && rand() > odds) || edges.some((e) => alongside(e, c.a, c.b, near) || alongside(e, c.b, c.a, near))) return false
    const hi = A.y >= B.y ? A : B
    const lo = hi === A ? B : A
    const run = between(hi, lo)
    const dy = hi.y - lo.y
    if (dy <= run * GRADE_MAX && (odds === 1 || lo.kind === 'junction' || rand() < 0.6)) {
      link(c.a, c.b, false)
    } else {
      if (lo.kind === 'junction') return false
      const bottom = Math.max(DROP_MIN, dy - run * GRADE_MAX * 0.8), top = Math.min(DROP_MAX, lo.h - DROP_ROOM, dy + run * GRADE_MAX * 0.8)
      if (bottom > top) return false
      const e = link(hi.i, lo.i, false)
      e.kind = 'drop'
      e.drop = bottom + (top - bottom) * rand() ** 0.7
    }
    degree[c.a]++; degree[c.b]++
    return true
  }
  let braids = 0
  for (const c of extra) {
    const great = nodes[c.a].great || nodes[c.b].great
    if (!great && braids >= Math.ceil(nodes.length * 0.3)) continue
    if (braid(c, great ? 0.95 : 0.5) && !great) braids++
  }

  // Regions: grown along the tree from scattered seeds, 3-8 nodes each, then coloured so neighbours differ.
  const order = nodes.map((n) => n.i).sort(() => rand() - 0.5)
  const regions = []
  for (const s of order) {
    if (nodes[s].region >= 0 || nodes[s].kind === 'mouth') continue
    const r = { i: regions.length, nodes: [], palette: -1, landmark: -1, touch: [] }
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
    r.touch = [...touch[r.i]]
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
    // Deep enough under the lower end that the roof at the dip is most of a metre under the water, and long enough that the cosine's steepest flank (dip pi / run) stays a swimmer's climb out.
    const dip = rr(3.6, 4.4) + Math.abs(A.y - B.y) / 2
    if (e.kind === 'walk' && e.tree && !nearMouth && !e.squeeze && sumps < 3 && (dip * Math.PI) / run <= SUMP_GRADE && Math.abs(A.y - B.y) < 6 && rand() < 0.45) {
      e.kind = 'sump'
      e.sump = { dip, level: Math.min(A.y, B.y) - 0.2 }
      sumps++
    } else if (e.kind === 'walk' && !nearMouth && run >= 12 && Math.abs(A.y - B.y) / run <= 0.14 && rand() < 0.3) {
      e.river = true
    }
  }
  // Water only in a room no passage leads down out of: a dish in its floor filled to under the rim, or flooded FLOOD over it. Its planned level is a wish; settleWaters holds it under where the rock would let it pour away. The dish also smooths the room's relief, whose hollows and overhangs would otherwise make low drowned crawls at its shore. A dish is no deeper than a third of its node's radius: its wall then stays a climb out where the water is too shallow to float her up it.
  // Its own stream, so where the water goes never reshapes the passages laid after.
  const wet = mulberry32(seed ^ 0x3a7e)
  const wr = (a, b) => a + (b - a) * wet()
  for (const n of nodes) {
    if (n.kind !== 'chamber' && (n.kind !== 'cavern' || n.great)) continue
    if (edges.some((e) => (e.a === n.i || e.b === n.i) && (e.kind === 'sump' || (e.kind === 'drop' && e.a === n.i) || nodes[e.a === n.i ? e.b : e.a].y < n.y + SINK_RISE))) continue
    n.dish = Math.min(n.pool ? wr(3, 7) * wr(2, 4) : wr(1.6, 3.6), 0.33 * Math.min(n.rx, n.rz))
    const level = wet() < 0.5 ? n.y - 0.25 : n.y + wr(FLOOD[0], FLOOD[1])
    pools.push({ node: n.i, x: n.x, z: n.z, level, r: Math.min(n.rx, n.rz) * (n.kind === 'cavern' ? 0.62 : 0.66), depth: n.dish + level - n.y })
  }
  // Drowned passages: now and then a deep pool's bowl opens under its surface onto a braid that swims out under the rim and climbs to a higher node, its floor walkable once it is out of the water.
  for (const A of nodes) {
    if (!A.pool || A.dish < DROWN_DISH || degree[A.i] >= cap(A) || wet() > 0.5) continue
    const yd = drownedFloor(A)
    for (const c of extra) {
      if (c.a !== A.i && c.b !== A.i) continue
      const B = nodes[c.a === A.i ? c.b : c.a]
      if (B.kind === 'mouth' || B.y < A.y + 0.5 || degree[B.i] >= cap(B) || edges.some((e) => (e.a === A.i && e.b === B.i) || (e.a === B.i && e.b === A.i)) || tangles(A.i, B.i)) continue
      const climb = Math.hypot(B.x - A.x, B.z - A.z) - (DROWN_OUT * flatOf(A, B.x, B.z)) / FLAT_IN - flatOf(B, A.x, A.z) - (A.y - 0.25 - yd) / DROWN_RISE
      if (climb * GRADE_MAX * 0.8 < B.y - A.y + 0.25) continue
      link(A.i, B.i, false).kind = 'drowned'
      degree[A.i]++; degree[B.i]++
      break
    }
  }

  // Passages that would breach another's floor or a foreign node: a tree passage rerolls its bend, unwandering and unbellied after 8 tries and swung wider after 12; a braid is given up.
  const built = []
  for (const e of [...edges.filter((q) => q.tree), ...edges.filter((q) => !q.tree)]) {
    for (let k = 0; k < 16 && (e.pts === null || clashes(e, built, nodes)); k++) e.pts = profile(e, nodes, rand, k >= 8, k >= 12)
    if (!e.tree && clashes(e, built, nodes)) { e.pts = null; continue }
    built.push(e)
  }
  for (let k = edges.length - 1; k >= 0; k--) if (edges[k].pts === null) edges.splice(k, 1)
  // A great cavern is never a dead end: one left with a single passage takes the first braid that can be laid without a clash, 20 degrees off its others being far apart at its rim.
  degree.fill(0)
  for (const e of edges) { degree[e.a]++; degree[e.b]++ }
  for (const n of nodes) {
    for (const c of extra) {
      if (!n.great || degree[n.i] >= 2) break
      if ((c.a !== n.i && c.b !== n.i) || edges.some((q) => (q.a === c.a && q.b === c.b) || (q.a === c.b && q.b === c.a)) || !braid(c, 1, 0.94)) continue
      const e = edges[edges.length - 1]
      for (let k = 0; k < 16 && (e.pts === null || clashes(e, built, nodes)); k++) e.pts = profile(e, nodes, rand, k >= 8, k >= 12)
      if (clashes(e, built, nodes)) { edges.pop(); degree[c.a]--; degree[c.b]-- } else built.push(e)
    }
  }
  edges.forEach((e, i) => { e.i = i })
  for (const p of pools) p.drowned = edges.filter((e) => e.kind === 'drowned' && e.a === p.node).map((e) => e.i)
  for (const e of edges) if (e.kind === 'sump') pools.push({ edge: e.i, level: e.sump.level, depth: e.sump.dip })
  for (const e of edges) if (e.river) rivers.push(e.i)
  const { lobes, nooks } = lobesAndNooks(nodes, edges, rand)
  for (const n of nodes) if (n.kind === 'chamber' || n.kind === 'cavern') relieve(n, edges, nooks, lobes, pools, rand)

  // Glows: mushroom lights by palette, and by both ends of every sump.
  const glows = []
  for (const n of nodes) {
    if (n.kind === 'mouth') continue
    const pal = PALETTES[regions[n.region].palette]
    const sumpEnd = edges.some((e) => e.kind === 'sump' && (e.a === n.i || e.b === n.i))
    if (!(sumpEnd ? rand() < 0.85 : rand() < Math.min(1, 2 * pal.glow))) continue
    const a = rand() * Math.PI * 2, r = Math.min(n.rx, n.rz) * 0.55
    glows.push({ node: n.i, x: n.x + Math.cos(a) * r, z: n.z + Math.sin(a) * r, color: GLOWS[Math.floor(rand() * GLOWS.length)], reach: n.kind === 'cavern' ? 16 : 9 })
  }

  // Rockfalls: a plain braid choked partway by a pile of boulders (props.js), its `choke` the metres along it, at a spot no other passage's run comes near. Never a tree passage, so every node keeps its way out, nor one that would leave a great cavern under two open.
  const open = (n) => edges.filter((f) => (f.a === n.i || f.b === n.i) && f.choke === null).length
  for (const e of edges) {
    if (e.tree || e.kind !== 'walk' || e.river || nodes[e.a].kind === 'mouth' || nodes[e.b].kind === 'mouth' || rand() >= CHOKE_ODDS) continue
    if ([nodes[e.a], nodes[e.b]].some((n) => n.great && open(n) <= 2)) continue
    for (let k = 0; k < 5 && e.choke === null; k++) {
      const c = e.pts[Math.floor(e.pts.length * rr(0.35, 0.65))]
      const near = edges.some((f) => f !== e && f.pts.some((q, j) => {
        const r = f.pts[Math.min(j + 1, f.pts.length - 1)]
        const d = r === q ? Math.hypot(q.x - c.x, q.z - c.z) : segDist(c, q, r)
        return Math.min(Math.abs(q.y - c.y), Math.abs(r.y - c.y)) < 6 && d < 2 * (c.w + Math.max(q.w, r.w)) + 3
      }))
      if (!near) e.choke = c.s
    }
  }
  return { nodes, edges, pools, rivers, glows, regions, lobes, nooks }
}

/**
 * Dead ends that make a region read as lobed, none of which the graph's passages know of:
 * lobes, domes bellied out of a node's wall on its own floor, `{ node, region, x, z, y, rx, rz, rot, h }`;
 * nooks, crevices running a few metres off a node or a passage and pinching shut, `{ region, pts }` with pts as a passage's.
 * Either is given up where it would open onto another floor than its own, so neither leaves a step nor joins two passages.
 */
function lobesAndNooks(nodes, edges, rand) {
  const rr = (a, b) => a + (b - a) * rand()
  const lobes = []
  const nooks = []
  const rDir = (n, a) => {
    const lx = Math.cos(a - n.rot) / n.rx, lz = Math.sin(a - n.rot) / n.rz
    return 1 / Math.hypot(lx, lz)
  }
  // Air at (x, z) over the floor y, `w` round, that would meet a floor other than y: any passage sample, node or lobe off this one's level.
  const foreign = (x, z, y, top, w, skipNode, skipEdge) => {
    for (const e of edges) {
      if (e === skipEdge) continue
      for (const q of e.pts) {
        if (Math.abs(q.y - y) < 0.05 && e.a === skipNode) continue
        if (Math.abs(q.y - y) < 0.05 && e.b === skipNode) continue
        if (Math.hypot(q.x - x, q.z - z) < w + q.w + 0.8 && y - SILL < q.y + q.h && q.y - SILL < top) return true
      }
    }
    for (const n of nodes) {
      if (n.i === skipNode) continue
      if (Math.hypot(n.x - x, n.z - z) < w + Math.max(n.rx, n.rz) + 1.5 && y - SILL < n.y + n.h && n.y - n.dish - SILL < top) return true
    }
    for (const l of lobes) {
      if (Math.abs(l.y - y) < 0.05) continue
      if (Math.hypot(l.x - x, l.z - z) < w + Math.max(l.rx, l.rz) + 1 && y - SILL < l.y + l.h && l.y - SILL < top) return true
    }
    for (const o of nooks) for (const q of o.pts) if (Math.hypot(q.x - x, q.z - z) < w + q.w + 0.6 && y - SILL < q.y + q.h && q.y - SILL < top) return true
    return false
  }
  const crevice = (region, x, z, y, a, len, w0, h0, rise, skipNode, skipEdge, free) => {
    const pts = []
    const n = Math.max(3, Math.ceil(len / 1.5))
    const x0 = x, z0 = z
    for (let k = 0; k <= n; k++) {
      const t = k / n
      const pinch = t < 0.35 ? 0 : ((t - 0.35) / 0.65) ** 1.5
      const p = { x, z, y: y + rise * t, w: Math.max(0.18, w0 * (1 - 0.82 * pinch)), h: Math.max(0.5, h0 * (1 - 0.75 * pinch)), s: t * len, cut: 0 }
      if (Math.hypot(x - x0, z - z0) > free && foreign(p.x, p.z, p.y, p.y + p.h, p.w, skipNode, skipEdge)) return null
      pts.push(p)
      a += (rand() - 0.5) * 0.6
      x += Math.cos(a) * (len / n); z += Math.sin(a) * (len / n)
    }
    return { region, pts }
  }
  for (const n of nodes) {
    if (n.kind === 'mouth') continue
    const cavern = n.kind === 'cavern', chamber = n.kind === 'chamber', great = n.great === true
    // A great cavern's outline is mostly lobes: big bays all round its rim, and a dozen blind tunnels.
    const nl = great ? 10 + Math.floor(rand() * 10) : cavern ? 4 + Math.floor(rand() * 5) : chamber ? 2 + Math.floor(rand() * 4) : Math.floor(rand() * 3)
    for (let k = 0; k < nl; k++) {
      const a = rand() * Math.PI * 2
      const r = great ? rr(6, Math.max(8, n.rz * 0.6)) : cavern ? rr(5, 11) : chamber ? rr(2.4, 5) : rr(1.4, 2.4)
      const at = rDir(n, a) * rr(0.8, 1.0)
      const l = { node: n.i, region: n.region, x: n.x + Math.cos(a) * at, z: n.z + Math.sin(a) * at, y: n.y, rx: r, rz: r * rr(0.6, 1), rot: a, h: great ? rr(12, 30) : cavern ? rr(6, 14) : chamber ? rr(3, 6) : rr(2.4, 3.4) }
      if (!foreign(l.x, l.z, l.y, l.y + l.h, r, n.i, null)) lobes.push(l)
    }
    const nn = great ? 8 + Math.floor(rand() * 6) : cavern ? 2 + Math.floor(rand() * 4) : chamber ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 3)
    for (let k = 0; k < nn; k++) {
      const a = rand() * Math.PI * 2
      const at = rDir(n, a)
      const o = crevice(n.region, n.x + Math.cos(a) * at * 0.7, n.z + Math.sin(a) * at * 0.7, n.y, a, great ? rr(8, 20) : rr(3.5, 8), great ? rr(0.9, 1.6) : rr(0.7, 1.1), great ? rr(2.4, 4) : rr(1.9, 2.6), rr(-0.3, 1.4), n.i, null, at * 0.3 + 0.5)
      if (o !== null) nooks.push({ ...o, node: n.i })
    }
  }
  for (const e of edges) {
    if (e.kind !== 'walk') continue
    const total = e.pts[e.pts.length - 1].s
    for (let s = rr(4, 9); s < total - 4; s += rr(6, 14)) {
      const p = e.pts.find((q) => q.s >= s)
      const i = e.pts.indexOf(p)
      const q = e.pts[Math.min(i + 1, e.pts.length - 1)], o = e.pts[Math.max(i - 1, 0)]
      const a = Math.atan2(q.z - o.z, q.x - o.x) + (rand() < 0.5 ? 1 : -1) * (Math.PI / 2 + rr(-0.4, 0.4))
      const c = crevice(nodes[i < e.pts.length / 2 ? e.a : e.b].region, p.x, p.z, p.y, a, rr(3, 6), Math.min(p.w, rr(0.6, 1)), Math.min(p.h, rr(1.6, 2.4)), rr(-0.2, 1), -1, e, p.w + 0.5)
      if (c !== null) nooks.push({ ...c, edge: e.i })
    }
  }
  return { lobes, nooks }
}

// Floor relief: metres per grid cell, and the steepest its slope is left, well under her 50 degrees with the floor's bump on top.
const RELIEF_CELL = 1
const RELIEF_SLOPE = 0.6

/**
 * Rolls node n's floor relief, `n.relief = { x0, z0, nx, nz, cell, v, lo }`, v the metres over the nominal floor per grid corner over the node and its lobes, lo its least.
 * A tilt and mounds, held to zero where passages meet the rim (and under a drop's lip, so the fall stays over her reach), and out of a dish. A great cavern's is rolled bigger and rough, with a channel down its length, its hills free to run on up into its wall (its grid reaches past its shape octaves' carve, field.js); each hollow in it deep enough is pushed to `pools`.
 */
function relieve(n, edges, nooks, lobes, pools, rand) {
  const rr = (a, b) => a + (b - a) * rand()
  const great = n.great === true
  const mine = lobes.filter((l) => l.node === n.i)
  const r = Math.max(n.rx, n.rz)
  let x0 = n.x - r, x1 = n.x + r, z0 = n.z - r, z1 = n.z + r
  for (const l of mine) { const lr = Math.max(l.rx, l.rz); x0 = Math.min(x0, l.x - lr); x1 = Math.max(x1, l.x + lr); z0 = Math.min(z0, l.z - lr); z1 = Math.max(z1, l.z + lr) }
  const cell = RELIEF_CELL
  const pad = great ? 18 : 2
  x0 = Math.floor(x0) - pad; z0 = Math.floor(z0) - pad
  const nx = Math.ceil((x1 - x0) / cell) + pad + 1, nz = Math.ceil((z1 - z0) / cell) + pad + 1
  const ta = rand() * Math.PI * 2, tilt = great ? rr(0.02, 0.08) : rr(0.04, 0.15)
  const mounds = Array.from({ length: great ? 10 + Math.floor((n.rx * n.rz) / 120) : 2 + Math.floor(rand() * 4) }, () => {
    const a = rand() * Math.PI * 2, at = Math.sqrt(rand()) * 0.9
    return { x: n.x + Math.cos(a) * at * n.rx, z: n.z + Math.sin(a) * at * n.rz, A: great ? rr(-6, 8) : rr(-1.5, 2), s: great ? rr(6, 20) : rr(1.5, 3.5) }
  })
  const chan = great ? channel(n, rand) : null
  const capOf = (x, z) => 0.25 * n.h * (great ? 1 : Math.min(1, 1.6 * Math.max(0, 1 - rhoOf(n, { x, z }) ** 2)))
  // Not from `rand`: this stream feeds every node after this one.
  const rough = great ? new Noise3(Math.imul(Math.floor(n.x * 131 + n.z * 71), 0x9e3779b1) ^ 0x6c1e) : null
  const floored = (x, z) => rhoOf(n, { x, z }) < 0.95 || mine.some((l) => rhoOf(l, { x, z }) < 0.95)
  const P = new Float32Array(nx * nz), N = new Float32Array(nx * nz)
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = x0 + i * cell, z = z0 + k * cell
    let v = tilt * ((x - n.x) * Math.cos(ta) + (z - n.z) * Math.sin(ta))
    for (const m of mounds) v += m.A * Math.exp(-((x - m.x) ** 2 + (z - m.z) ** 2) / (2 * m.s * m.s))
    if (rough !== null) v += 2.4 * rough.at2(x * 0.035, z * 0.035) + 1.4 * (1 - 2 * Math.abs(rough.at2(x * 0.1 + 13, z * 0.1))) + 0.6 * rough.at2(x * 0.28 + 5, z * 0.28)
    if (chan !== null) { const d = lineDist(chan.pts, x, z); if (d < chan.w) v = Math.min(v, -chan.depth) }
    const c = k * nx + i
    P[c] = Math.min(Math.max(v, 0), capOf(x, z))
    // Hollows only where there is floor, so every basin holds its water in air.
    N[c] = n.dish > 0 || !floored(x, z) ? 0 : Math.max(-v, 0)
    if (n.dish > 0 && rhoOf(n, { x, z }) < 0.7) P[c] = 0
    if (i === 0 || k === 0 || i === nx - 1 || k === nz - 1) P[c] = N[c] = 0
  }
  // Level where a passage or nook crosses the rim band, and under a drop's whole line in. Hollows keep out from under a passage's whole line in any room: its floor runs level to the centre, and over a hollow it is a ledge (in a great cavern, wherever the wall's octaves stand a pillar beside it).
  const lines = [...edges.filter((e) => e.a === n.i || e.b === n.i).map((e) => ({ pts: e.pts, drop: e.kind === 'drop' })), ...nooks.filter((o) => o.node === n.i).map((o) => ({ pts: o.pts, drop: false }))]
  for (const { pts, drop } of lines) for (const q of pts) {
    const rho = rhoOf(n, q), rim = drop || rho >= (great ? 0.8 : 0.55)
    if (rho > 1.6) continue
    const reach = q.w + (drop ? 2.5 : 1)
    for (let k = Math.max(0, Math.floor((q.z - reach - z0) / cell)); k <= Math.min(nz - 1, Math.ceil((q.z + reach - z0) / cell)); k++) {
      for (let i = Math.max(0, Math.floor((q.x - reach - x0) / cell)); i <= Math.min(nx - 1, Math.ceil((q.x + reach - x0) / cell)); i++) {
        if (Math.hypot(x0 + i * cell - q.x, z0 + k * cell - q.z) > reach) continue
        if (rim) P[k * nx + i] = 0
        if (!drop) N[k * nx + i] = 0
      }
    }
  }
  slopeLimit(P, nx, nz, RELIEF_SLOPE * cell)
  slopeLimit(N, nx, nz, RELIEF_SLOPE * cell)
  const v = new Float32Array(nx * nz)
  let lo = 0
  for (let c = 0; c < v.length; c++) { v[c] = P[c] - N[c]; lo = Math.min(lo, v[c]) }
  n.relief = { x0, z0, nx, nz, cell, v, lo }
  if (great) hollows(n, pools, floored)
}

// A meandering channel down a great cavern's long axis, inside its rim band.
function channel(n, rand) {
  const c = Math.cos(n.rot), s = Math.sin(n.rot)
  const amp = n.rz * (0.15 + 0.25 * rand()), f = (2 + 3 * rand()) * Math.PI, ph = rand() * 6.28
  const pts = []
  for (let u = -0.7; u <= 0.7001; u += 0.05) {
    const a = u * n.rx, b = amp * Math.sin(u * f + ph) * (1 - Math.abs(u))
    pts.push({ x: n.x + a * c - b * s, z: n.z + a * s + b * c })
  }
  return { pts, w: 1.5 + 2 * rand(), depth: 1.8 + rand() }
}

function lineDist(pts, x, z) {
  let best = Infinity
  for (let k = 0; k + 1 < pts.length; k++) best = Math.min(best, segDist({ x, z }, pts[k], pts[k + 1]))
  return best
}

// Lowers v so no corner stands more than `k` per cell over a neighbour: two chamfer sweeps of a min-envelope.
function slopeLimit(v, nx, nz, k) {
  const d = k * Math.SQRT2
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const c = z * nx + x
    if (x > 0) v[c] = Math.min(v[c], v[c - 1] + k)
    if (z > 0) {
      v[c] = Math.min(v[c], v[c - nx] + k)
      if (x > 0) v[c] = Math.min(v[c], v[c - nx - 1] + d)
      if (x + 1 < nx) v[c] = Math.min(v[c], v[c - nx + 1] + d)
    }
  }
  for (let z = nz - 1; z >= 0; z--) for (let x = nx - 1; x >= 0; x--) {
    const c = z * nx + x
    if (x + 1 < nx) v[c] = Math.min(v[c], v[c + 1] + k)
    if (z + 1 < nz) {
      v[c] = Math.min(v[c], v[c + nx] + k)
      if (x + 1 < nx) v[c] = Math.min(v[c], v[c + nx + 1] + d)
      if (x > 0) v[c] = Math.min(v[c], v[c + nx - 1] + d)
    }
  }
}

// Water in a great cavern's hollows: each basin of the relief whose bed is `floored` (not between hills in the rock past the rim), flooded in from its rim, deep enough that its water stands clear of the floor's bump at both its bed and its spill, is a pool at three fifths of its depth.
function hollows(n, pools, floored) {
  const { nx, nz, v, x0, z0, cell } = n.relief
  const fill = new Float32Array(nx * nz).fill(Infinity)
  const done = new Uint8Array(nx * nz)
  // A binary heap of cells by fill height; a cell is pushed again whenever its fill drops, and the stale entries are skipped when popped.
  const heap = []
  const push = (c, h) => {
    if (h >= fill[c]) return
    fill[c] = h
    let i = heap.length
    heap.push(c)
    while (i > 0) {
      const up = (i - 1) >> 1
      if (fill[heap[up]] <= fill[c]) break
      heap[i] = heap[up]; i = up
    }
    heap[i] = c
  }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length > 0) {
      let i = 0
      for (;;) {
        let k = 2 * i + 1
        if (k >= heap.length) break
        if (k + 1 < heap.length && fill[heap[k + 1]] < fill[heap[k]]) k++
        if (fill[heap[k]] >= fill[last]) break
        heap[i] = heap[k]; i = k
      }
      heap[i] = last
    }
    return top
  }
  for (let i = 0; i < nx; i++) { push(i, v[i]); push((nz - 1) * nx + i, v[(nz - 1) * nx + i]) }
  for (let k = 0; k < nz; k++) { push(k * nx, v[k * nx]); push(k * nx + nx - 1, v[k * nx + nx - 1]) }
  while (heap.length > 0) {
    const c = pop()
    if (done[c]) continue
    done[c] = 1
    const i = c % nx, k = Math.floor(c / nx)
    for (const [a, w] of [[i - 1, k], [i + 1, k], [i, k - 1], [i, k + 1]]) if (a >= 0 && w >= 0 && a < nx && w < nz && !done[w * nx + a]) push(w * nx + a, Math.max(fill[c], v[w * nx + a]))
  }
  const seen = new Uint8Array(nx * nz)
  for (let c0 = 0; c0 < v.length; c0++) {
    if (seen[c0] || fill[c0] - v[c0] < 0.05) continue
    const basin = [c0]
    seen[c0] = 1
    for (let j = 0; j < basin.length; j++) {
      const c = basin[j], i = c % nx, k = Math.floor(c / nx)
      for (const [a, w] of [[i - 1, k], [i + 1, k], [i, k - 1], [i, k + 1]]) {
        const d = w * nx + a
        if (a >= 0 && w >= 0 && a < nx && w < nz && !seen[d] && fill[d] - v[d] >= 0.05) { seen[d] = 1; basin.push(d) }
      }
    }
    const low = basin.reduce((a, b) => (v[b] < v[a] ? b : a))
    const spill = fill[low], min = v[low]
    if (spill - min < 1.5 || basin.length < 12 || !floored(x0 + (low % nx) * cell, z0 + Math.floor(low / nx) * cell)) continue
    const level = n.y + min + 0.6 * (spill - min) - 0.3
    pools.push({ node: n.i, x: x0 + (low % nx) * cell, z: z0 + Math.floor(low / nx) * cell, level, r: Math.sqrt(basin.length / Math.PI) * cell, depth: level - n.y - min, drowned: [] })
  }
}

/** Metres node n's floor relief stands over its nominal floor at (x, z): bilinear, 0 off its grid or where it has none. */
export function reliefAt(n, x, z) {
  return n.relief === undefined ? 0 : reliefIn(n.relief, x, z)
}

/** reliefAt on a node's relief grid itself. */
export function reliefIn(R, x, z) {
  const u = (x - R.x0) / R.cell, w = (z - R.z0) / R.cell
  const i = Math.floor(u), k = Math.floor(w)
  if (i < 0 || k < 0 || i + 1 >= R.nx || k + 1 >= R.nz) return 0
  const fu = u - i, fw = w - k, v = R.v, c = k * R.nx + i
  return (v[c] * (1 - fu) + v[c + 1] * fu) * (1 - fw) + (v[c + R.nx] * (1 - fu) + v[c + R.nx + 1] * fu) * fw
}

// Rock under this much between two passages stacked in one plan spot. The field eats about 3.5 m of it: the lower vault's octaves and roughness carve up, the upper floor's bump dips down.
const SILL = 4

// A passage's plan box grown by its widest half-width plus the clash margin, cached on its pts array.
const BOXES = new WeakMap()
function planBox(e) {
  let b = BOXES.get(e.pts)
  if (b === undefined) {
    b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
    for (const q of e.pts) {
      b.x0 = Math.min(b.x0, q.x - q.w - 1); b.x1 = Math.max(b.x1, q.x + q.w + 1)
      b.z0 = Math.min(b.z0, q.z - q.w - 1); b.z1 = Math.max(b.z1, q.z + q.w + 1)
    }
    BOXES.set(e.pts, b)
  }
  return b
}

/** Whether passage e's samples come within a wall of another built passage or a node it does not end at, with less than SILL of rock between them. */
export function clashes(e, built, nodes) {
  const be = planBox(e)
  for (const f of built) {
    const bf = planBox(f)
    if (be.x0 > bf.x1 || bf.x0 > be.x1 || be.z0 > bf.z1 || bf.z0 > be.z1) continue
    // Two passages from one node meet in it; past its walls they must part like any other two.
    const shared = [e.a, e.b].filter((i) => i === f.a || i === f.b).map((i) => nodes[i])
    if (shared.length === 2) continue
    const near = (p) => shared.some((n) => rhoOf(n, p, 3) < 1)
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

// Whether plan segments AB and CD cross.
function cross(A, B, C, D) {
  const side = (P, Q, R) => (Q.x - P.x) * (R.z - P.z) - (Q.z - P.z) * (R.x - P.x)
  return side(A, B, C) * side(A, B, D) < 0 && side(C, D, A) * side(C, D, B) < 0
}

// Plan distance from node n to segment AB.
function segDist(n, A, B) {
  const ex = B.x - A.x, ez = B.z - A.z
  const u = Math.max(0, Math.min(1, ((n.x - A.x) * ex + (n.z - A.z) * ez) / (ex * ex + ez * ez)))
  return Math.hypot(n.x - A.x - u * ex, n.z - A.z - u * ez)
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

// Where p lies in node n's ellipse grown by `pad` metres: 1 on its rim.
function rhoOf(n, p, pad = 0) {
  const dx = p.x - n.x, dz = p.z - n.z
  const c = Math.cos(n.rot), s = Math.sin(n.rot)
  return Math.hypot((dx * c + dz * s) / (n.rx + pad), (dz * c - dx * s) / (n.rz + pad))
}

// Whether plan segment AB passes within `pad` of node n's ellipse: a great cavern is too long for segDist's circle.
function grazes(n, A, B, pad) {
  const k = Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 2)
  for (let i = 0; i <= k; i++) if (rhoOf(n, { x: A.x + ((B.x - A.x) * i) / k, z: A.z + ((B.z - A.z) * i) / k }, pad) < 1) return true
  return false
}

/**
 * The passage as samples every SAMPLE metres from node a to node b: { x, z, y, w, h }, y the floor, w the half-width, h the height above it.
 * The plan line bends through a rolled midpoint; the floor is flat inside each node, a straight grade between, dipped for a sump and held at the lip for a drop.
 */
function profile(e, nodes, rand, plain, wide = false) {
  const rr = (a, b) => a + (b - a) * rand()
  const A = nodes[e.a], B = nodes[e.b]
  const dx = B.x - A.x, dz = B.z - A.z
  const d = Math.hypot(dx, dz)
  // The mouth's passage runs straight in, so the daylight at its end shows from the throat.
  const mouth = A.kind === 'mouth' || B.kind === 'mouth'
  const bend = mouth ? 0 : (rand() - 0.5) * (wide ? 1.4 : 0.5) * d
  const mx = (A.x + B.x) / 2 - (dz / d) * bend, mz = (A.z + B.z) / 2 + (dx / d) * bend
  const n = Math.max(3, Math.ceil(d / SAMPLE))
  const yB = e.kind === 'drop' ? B.y + e.drop : B.y
  const baseW = e.kind === 'drop' || mouth ? 1.2 : plain ? 1 : 0.9 + 1.4 * rand() ** 1.6
  const phase = rand() * 10
  const tall = !plain && rand() < 0.35 ? rr(2, 5) : 0
  const hs = mouth || plain ? 1 : rr(0.9, 1.6)
  // The line wanders off the curve between the nodes' walls, so no passage runs straight.
  const wander = mouth || plain ? 0 : rr(0.6, 2.4)
  const wf = rr(0.35, 0.7), wp = rand() * 10
  const rA = Math.max(A.rx, A.rz), rB = Math.max(B.rx, B.rz)
  const pts = []
  let run = 0
  let px = A.x, pz = A.z
  for (let k = 0; k <= n; k++) {
    const u = k / n
    let x = (1 - u) * (1 - u) * A.x + 2 * u * (1 - u) * mx + u * u * B.x
    let z = (1 - u) * (1 - u) * A.z + 2 * u * (1 - u) * mz + u * u * B.z
    const tx = 2 * (1 - u) * (mx - A.x) + 2 * u * (B.x - mx), tz = 2 * (1 - u) * (mz - A.z) + 2 * u * (B.z - mz)
    const tl = Math.hypot(tx, tz)
    const fade = Math.min(1, Math.max(0, Math.min(u * d - rA, (1 - u) * d - rB) / 4))
    const off = wander * fade * (Math.sin(u * d * wf + wp) * 0.7 + Math.sin(u * d * wf * 2.3 + wp * 1.7) * 0.3)
    x -= (tz / tl) * off; z += (tx / tl) * off
    run += Math.hypot(x - px, z - pz)
    px = x; pz = z
    pts.push({ x, z, y: 0, w: 0, h: 0, s: run, cut: 0 })
  }
  // The flats end where the line itself clears each node's floor, which the dome holds out to 0.95 of its radius: a line leaving at a slant runs metres along that rim.
  const leave = (N, list, sOf) => {
    for (let k = 1; k < list.length; k++) {
      const ra = rhoOf(N, list[k - 1]), rb = rhoOf(N, list[k])
      if (rb >= FLAT_OUT) return sOf(list[k - 1]) + (sOf(list[k]) - sOf(list[k - 1])) * Math.max(0, (FLAT_OUT - ra) / (rb - ra))
    }
    return sOf(list[list.length - 1])
  }
  let flatA = leave(A, pts, (p) => p.s), flatB = leave(B, [...pts].reverse(), (p) => run - p.s)
  // Cells along the run, each pinched, plain or bellied out, so the passage narrows and opens of a sudden.
  const cells = []
  for (let s = 0; s < run + 10;) {
    const len = rr(3, 8), q = rand()
    cells.push({ s0: s, s1: s + len, f: mouth || plain || e.kind === 'sump' || e.kind === 'drowned' ? 1 : q < 0.25 ? 0.72 : q < 0.6 ? 1 : q < 0.88 ? 1.55 : 2.1 })
    s += len
  }
  const cellAt = (s) => {
    const c = cells.find((q) => s < q.s1)
    const next = cells[cells.indexOf(c) + 1]
    const t = Math.max(0, Math.min(1, (s - c.s1 + 0.9) / 1.8))
    return c.f + (next.f - c.f) * t * t * (3 - 2 * t)
  }
  const total = run
  // Close nodes give their flats up in proportion, so the slope always has 6 m to run over.
  if (total - flatA - flatB < 6) { const k = Math.max(0, total - 6) / (flatA + flatB); flatA *= k; flatB *= k }
  // A walk steeper than GRADE_MAX starts its slope further into the high node, where it cuts a ramp down through that floor; in the low node it would leave a step at the wall.
  const short = e.kind === 'walk' ? Math.abs(yB - A.y) / GRADE_MAX - (total - flatA - flatB) : 0
  if (short > 0 && A.y > yB) flatA = Math.max(0, flatA - short)
  else if (short > 0) flatB = Math.max(0, flatB - short)
  // A drowned passage holds its pool's depth from the bowl out past the rim, swims up to the surface at `wet`, then climbs.
  const drowned = e.kind === 'drowned'
  const lo = drowned ? pts.find((p) => rhoOf(A, p) >= DROWN_OUT).s : flatA, hi = total - flatB
  const yA = drowned ? drownedFloor(A) : A.y
  const wet = drowned ? lo + (A.y - 0.25 - yA) / DROWN_RISE : lo
  for (const p of pts) {
    const t = p.s <= lo ? 0 : p.s >= hi ? 1 : (p.s - lo) / (hi - lo)
    p.y = !drowned ? yA + (yB - yA) * t
      : p.s < wet ? yA + Math.max(0, p.s - lo) * DROWN_RISE
      : A.y - 0.25 + (yB - A.y + 0.25) * Math.min(1, (p.s - wet) / (hi - wet))
    if (e.kind === 'drop' && p.s >= hi) p.y = yB
    // A river's channel fades out over 3 m before each node's floor, so it never ends in a step.
    p.cut = e.river ? RIVER_DEPTH * Math.min(1, Math.max(0, Math.min(p.s - lo, hi - p.s) / 3)) : 0
    const wave = Math.sin(p.s * 0.21 + phase) * 0.5 + Math.sin(p.s * 0.53 + phase * 2) * 0.3
    const f = cellAt(p.s)
    p.w = Math.max(0.85, baseW * f * (1 + 0.25 * wave))
    p.h = Math.max(2.3, (2.3 + 0.3 * (wave + 1)) * (0.75 + 0.4 * f) * hs + tall * Math.max(0, Math.sin(p.s * 0.09 + phase)))
    // Held at its lip inside the chamber below, a drop's passage keeps under that chamber's roof.
    if (e.kind === 'drop') p.h = Math.min(p.h, DROP_ROOM)
    if (e.squeeze) {
      const mid = 1 - Math.min(1, Math.abs(p.s / total - 0.5) / 0.18)
      p.w = Math.max(0.9, p.w * (1 - 0.45 * mid))
      p.h = Math.max(2.4, p.h - 0.6 * mid)
    }
    if (e.kind === 'sump' && t > 0 && t < 1) {
      p.y -= e.sump.dip * (0.5 - 0.5 * Math.cos(2 * Math.PI * t))
      p.h = 2.3
    }
    if (drowned && t === 0) p.h = DROWN_H
  }
  pts[0].w = pts[pts.length - 1].w = Math.max(pts[0].w, 1.1)
  return pts
}
