// A castle's spiral stairs (design/44-castles.md, Layout and Shell), shared by the shell, the collision and the furnishing.
import { CASTLE } from './layout.js'
import { dungeonPlan } from './dungeon.js'

const S = CASTLE.scale, INSET = 0.4, WT = 0.3, SEG = Math.PI / 8
// Interior metres. 15 segments of 1/16 turn round a post, each `treads` steps, the 16th its landing in the storey above, whose slab
// is open over segments `hole` on. A drum `wall` thick stands round the steps at `well` on each storey a flight climbs from, open
// over segments 14 and 15 up to `door` high, where she steps off at a landing and onto the next flight; on the storey a helix ends
// in it walls only the hole's segments, with a spur along the hole's first edge. `square` is the half side of the slab square cut
// round each well. A post no spiral climbs on from ends in a finial `cap` tall.
export const SPIRAL = { well: 1.75, wall: 0.12, square: 2.1, post: 0.3, steps: 15, treads: 2, hole: 7, door: 2.8, cap: 1.3 }
/** Segment (0-15) of bearing a from a helix climbing from a0. */
export const segmentOf = (a, a0) => Math.floor((((a - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / SEG) % 16

const starts = new WeakMap()
/** The bearing the helix about interior (x, z) climbs from, shared by every flight in that cell: a multiple of 1/16 turn, so its
 * segments' corners meet its square. */
export function spiralStart(lay, x, z) {
  if (!starts.has(lay)) starts.set(lay, new Map())
  const memo = starts.get(lay), key = `${x},${z}`
  if (!memo.has(key)) memo.set(key, bestStart(lay, x, z))
  return memo.get(key)
}

/** The start that leaves the most room before each landing's doorway and before the open half of the storey the helix ends in
 * (the least of those first, then the next), keeping that storey's roof ladder on the open half. A way out through a door counts
 * as room enough, so in a one-cell tower she steps from the door straight into the drum rather than edging round it. */
function bestStart(lay, x, z) {
  const flights = lay.edges.filter((e) => e.stair && e.stair.x * S === x && e.stair.z * S === z)
  const down = dungeonPlan(lay).stair, dungeon = down.x * S === x && down.z * S === z
  if (!flights.length && !dungeon) throw new Error(`castle ${lay.seed}: no spiral at ${x}, ${z}`)
  const ks = new Set(flights.map((e) => e.stair.k))
  // [room, bearing from a0 that must open onto it, the ladders that must stand on the open half]
  const views = flights.map((e) => [e.a, -SEG, []])
  const ends = flights.filter((e) => !ks.has(e.stair.k + 1)).map((e) => e.b).concat(dungeon && !ks.has(0) ? [down.node] : [])
  for (const n of ends) views.push([n, 3 * SEG, lay.edges.filter((e) => e.ladder && e.a === n).map((e) => Math.atan2(e.ladder.z * S - z, e.ladder.x * S - x))])
  const walled = (b, a0) => [b - 0.2, b + 0.2].some((c) => { const j = segmentOf(c, a0); return j >= SPIRAL.hole && j < 15 })
  let best = null, most = null
  for (let i = 0; i < 16; i++) {
    const a0 = i * SEG
    if (views.some(([, , ladders]) => ladders.some((b) => walled(b, a0)))) continue
    const score = views.map(([n, off]) => reach(lay, n, x, z, a0 + off)).sort((p, q) => p - q)
    const j = most && score.findIndex((v, i) => v !== most[i])
    if (!most || (j >= 0 && score[j] > most[j])) { most = score; best = a0 }
  }
  if (most === null) throw new Error(`castle ${lay.seed}: no start for the spiral at ${x}, ${z} clears its ladder`)
  return best
}

/** How far from interior (x, z) along bearing a room node n's air runs, or THROUGH when the ray leaves by one of its doors. */
function reach(lay, n, x, z, a) {
  const ex = [lay.X(n.x0), lay.Z(n.z0), lay.X(n.x0 + n.w), lay.Z(n.z0 + n.d)], ux = Math.cos(a), uz = Math.sin(a)
  let t
  if (n.sec.round) {
    const dx = x - (ex[0] + ex[2]) / 2 * S, dz = z - (ex[1] + ex[3]) / 2 * S, rho = (ex[2] - ex[0] - 2 * INSET) / 2 * S - WT, b = dx * ux + dz * uz
    t = -b + Math.sqrt(b * b - dx * dx - dz * dz + rho * rho)
  } else {
    const r = [(ex[0] + INSET) * S + WT, (ex[1] + INSET) * S + WT, (ex[2] - INSET) * S - WT, (ex[3] - INSET) * S - WT]
    t = Math.min(ux > 1e-9 ? (r[2] - x) / ux : ux < -1e-9 ? (r[0] - x) / ux : Infinity, uz > 1e-9 ? (r[3] - z) / uz : uz < -1e-9 ? (r[1] - z) / uz : Infinity)
  }
  const px = x + ux * t, pz = z + uz * t
  const out = lay.edges.some((e) => (e.a === n || e.b === n) && e.doors.some((d) => Math.abs(d.y - n.k * CASTLE.storey) < 0.1
    && Math.abs(d.axis === 'x' ? pz - d.z * S : px - d.x * S) < d.w * S / 2 - 0.3 && Math.abs(d.axis === 'x' ? px - d.x * S : pz - d.z * S) < 1.6))
  return out ? THROUGH : t
}
const THROUGH = 8
