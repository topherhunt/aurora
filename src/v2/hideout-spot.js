// Where a missing child sits in his hideout (talk/quests.js hideouts): off the beaten path in a cave, a quiet ground-floor
// corner of a castle's tallest tower. Pure and deterministic per plan; three-free.

import { CASTLE } from './castles/layout.js'

const H = CASTLE.storey, S = CASTLE.scale, V = CASTLE.tall
// Passages she can walk both ways: not under water, not down a drop she could not climb back.
const WALKABLE = new Set(['walk'])
// A castle corner keeps this clear of every portal, and is this far in from the walls.
const CLEAR_M = 1.5
const INSET_M = 1.1

/**
 * A cave plan's hideout node: the dry chamber the most walkable passages from any door, else such a cavern or junction.
 * `{ node, x, z, y }`, y the node's floor in plan metres; null when no dry room is reached.
 */
export function caveSpot(graph) {
  const { nodes, edges } = graph
  const hops = nodes.map(() => Infinity)
  const queue = []
  for (const n of nodes) if (n.kind === 'mouth') { hops[n.i] = 0; queue.push(n.i) }
  const adj = nodes.map(() => [])
  for (const e of edges) if (WALKABLE.has(e.kind)) { adj[e.a].push(e.b); adj[e.b].push(e.a) }
  for (let q = 0; q < queue.length; q++) {
    for (const j of adj[queue[q]]) if (hops[j] === Infinity) { hops[j] = hops[queue[q]] + 1; queue.push(j) }
  }
  for (const kind of ['chamber', 'cavern', 'junction']) {
    let best = null
    for (const n of nodes) if (n.kind === kind && n.dish === 0 && hops[n.i] < Infinity && (best === null || hops[n.i] > hops[best.i])) best = n
    if (best !== null) return { node: best.i, x: best.x, z: best.z, y: best.y }
  }
  return null
}

/** The interior metres of every portal a room `n` of `lay` has, as roomProps (castles/furnish.js) keeps clear. */
function portalsOf(lay, n) {
  const out = []
  for (const e of lay.edges) {
    if (e.a !== n && e.b !== n) continue
    for (const d of e.doors) if (Math.abs(d.y - n.k * H) < 0.1) out.push([d.x * S, d.z * S])
    if (e.stair) out.push([e.stair.x * S, e.stair.z * S])
    if (e.ladder) out.push([e.ladder.x * S, e.ladder.z * S])
  }
  return out
}

/**
 * A castle's hideout: a corner of a ground-floor room, the tallest tower's foot first, then the keep's store, CLEAR_M off
 * every portal and out of every prop (roomProps). `{ lx, lz, ly, face, room }` in interior metres about the castle centre,
 * `face` the yaw (a +X body turned about up) looking into the room; null when no room has such a corner.
 */
export function castleSpot(lay, props) {
  const rooms = lay.nodes.filter((n) => n.kind === 'room' && !n.unused && n.k === 0)
  const rank = (n) => (n.sec.kind === 'lookout' || n.sec.kind === 'tower' ? 100 + n.sec.floors : n.sec.kind === 'keep' ? 50 : 0)
  rooms.sort((a, b) => rank(b) - rank(a) || a.x0 - b.x0 || a.z0 - b.z0)
  for (const n of rooms) {
    const portals = portalsOf(lay, n)
    if (portals.length === 0) continue
    const x0 = lay.X(n.x0) * S + INSET_M, z0 = lay.Z(n.z0) * S + INSET_M
    const x1 = lay.X(n.x0 + n.w) * S - INSET_M, z1 = lay.Z(n.z0 + n.d) * S - INSET_M
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
    // A round tower has no corners: its spots sit on the disc the wall inscribes, at the diagonals.
    const r = Math.min(x1 - x0, z1 - z0) / 2 / Math.SQRT2
    const spots = n.sec.round
      ? [[cx - r, cz - r], [cx + r, cz - r], [cx - r, cz + r], [cx + r, cz + r]]
      : [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]
    let best = null
    for (const [lx, lz] of spots) {
      const clear = Math.min(...portals.map(([px, pz]) => Math.hypot(px - lx, pz - lz)))
      if (clear < CLEAR_M) continue
      if (props.some((p) => p.k === 0 && Math.hypot(p.x - lx, p.z - lz) < Math.hypot(p.w, p.d) / 2 + 0.5)) continue
      if (best === null || clear > best.clear) best = { lx, lz, clear }
    }
    if (best === null) continue
    return { lx: best.lx, lz: best.lz, ly: n.k * H * V, face: Math.atan2(-(cz - best.lz), cx - best.lx), room: n.id }
  }
  return null
}
