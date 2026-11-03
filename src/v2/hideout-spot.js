// Where a missing child sits in his hideout (talk/quests.js hideouts): off the beaten path in a cave, a back corner of a dry
// dungeon room in a castle; and where a castle's ghost drifts. Pure and deterministic per plan; three-free.

import { dungeonProps } from './castles/furnish.js'
import { dungeonCell, dungeonPlan } from './castles/dungeon.js'
import { castleSolids, interiorSpans, SPANS } from './castles/solids.js'

// Passages she can walk both ways: not under water, not down a drop she could not climb back.
const WALKABLE = new Set(['walk'])
// A castle hideout keeps CLEAR_M off every room opening (TIGHT_M, and half GHOST_M from the ghost, in a dungeon with no room that allows it); each body's disc is BODY_M round with HEAD_M of air over its floor; the boy
// sits BOY_M from the skeleton, and GHOST_M clear of the ghost (whose own corner keeps GHOST_CLEAR_M off its openings).
const CLEAR_M = 1.2, TIGHT_M = 0.8
export const BODY_M = 0.5
export const HEAD_M = 1.9
const BOY_M = 0.9
const GHOST_M = 3, GHOST_CLEAR_M = 1.5

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

/** Whether a `r` disc about interior (x, z) is dry open dungeon floor at height `y` with `HEAD_M` over it, by `lay`'s real interior
 * collision (interiorSpans) at the centre and a ring of sixteen. */
export function clearDisc(lay, x, z, y, r) {
  const g = dungeonPlan(lay), it = interiorOf(lay)
  for (let k = -1; k < 16; k++) {
    const px = k < 0 ? x : x + Math.cos(k * Math.PI / 8) * r, pz = k < 0 ? z : z + Math.sin(k * Math.PI / 8) * r
    const c = dungeonCell(g, px, pz)
    if (c < 0 || Number.isNaN(g.lo[c]) || !Number.isNaN(g.water[c])) return false
    const n = interiorSpans(it, px, pz, y + 0.5)
    let floor = false
    for (let i = 0; i < n; i++) {
      if (Math.abs(SPANS.HI[i] - y) > 0.05) continue
      if (i + 1 >= n || SPANS.LO[i + 1] - SPANS.HI[i] >= HEAD_M) floor = true
    }
    if (!floor) return false
  }
  return true
}

const solids = new WeakMap()
function interiorOf(lay) {
  let it = solids.get(lay)
  if (it === undefined) { it = castleSolids(lay).it; solids.set(lay, it) }
  return it
}

/**
 * A castle's hideout: a corner of a dry dungeon room (dungeonPlan) reached through the locked door, the shallowest room that is
 * neither flooded, the chest's, nor the ghost's (rooms with a proper floor before junctions). The foot chamber has no room for it:
 * collision leaves the stair's well and a passage a metre wide to the door. The skeleton's disc, the boy's beside it and both its
 * `lx`/`lz`, `boy.lx`/`boy.lz` are open floor by clearDisc, off every opening and prop; `face` is the yaw (a +X body turned about
 * up) looking into the room. `{ lx, lz, ly, face, boy, room }` in interior metres; null when no room has such a corner.
 */
export function castleSpot(lay) {
  const g = dungeonPlan(lay), props = dungeonProps(lay), ghost = ghostPick(lay)
  const rooms = g.rooms.filter((r, i) => i !== g.chest && r !== ghost?.room && !r.flooded)
  rooms.sort((a, b) => a.junction - b.junction || a.depth - b.depth)
  // A dungeon with no other dry room gives them the ghost's room, then the chest's, a ghost's reach apart.
  rooms.push(...[ghost?.room, g.rooms[g.chest]].filter((r) => r !== undefined && !r.flooded))
  for (const [clear, away] of [[CLEAR_M, GHOST_M], [TIGHT_M, GHOST_M / 2]]) {
    for (const r of rooms) {
      const [x0, z0, x1, z1] = r.rect, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2
      // Every half metre of the room, the ones nearest a corner first.
      const grid = []
      for (let lx = x0 + 0.5; lx < x1; lx += 0.5) for (let lz = z0 + 0.5; lz < z1; lz += 0.5) {
        grid.push({ lx, lz, wall: Math.min(lx - x0, x1 - lx) + Math.min(lz - z0, z1 - lz) })
      }
      grid.sort((p, q) => p.wall - q.wall)
      for (const { lx, lz } of grid) {
        const c = dungeonCell(g, lx, lz)
        if (c < 0 || Number.isNaN(g.lo[c])) continue
        const ly = g.lo[c], face = Math.atan2(-(cz - lz), cx - lx)
        const apart = (x, z) => (ghost === null || Math.hypot(ghost.lx - x, ghost.lz - z) >= away) && r.portals.every(([px, pz]) => Math.hypot(px - x, pz - z) >= clear) && props.every((p) => Math.hypot(p.x - x, p.z - z) >= Math.hypot(p.w, p.d) / 2 + BODY_M)
        if (!apart(lx, lz) || !clearDisc(lay, lx, lz, ly, BODY_M)) continue
        for (const s of [1, -1]) {
          const b = { lx: lx - s * Math.sin(face) * BOY_M, lz: lz - s * Math.cos(face) * BOY_M }
          if (apart(b.lx, b.lz) && clearDisc(lay, b.lx, b.lz, ly, BODY_M)) return { lx, lz, ly, face, boy: b, room: g.rooms.indexOf(r) }
        }
      }
    }
  }
  return null
}

/** The dungeon room the ghost drifts in and its spot: a dry back corner of the deepest dead-end room past the locked door that is
 * not the chest's (else the deepest room), clear of its openings and props. `{ room, lx, lz, ly }`; null with no such corner. */
function ghostPick(lay) {
  const g = dungeonPlan(lay), props = dungeonProps(lay)
  const rooms = g.rooms.filter((r, i) => i !== g.chest && r !== g.entry).sort((a, b) => (a.portals.length === 2) - (b.portals.length === 2) || a.depth - b.depth).reverse()
  for (const r of [...rooms, g.rooms[g.chest]]) {
    const [i0, j0, i1, j1] = r.cells
    for (const [i, j] of [[i0, j0], [i1 - 1, j0], [i0, j1 - 1], [i1 - 1, j1 - 1]]) {
      const c = i + j * g.W, lx = g.x0 + i + 0.5, lz = g.z0 + j + 0.5
      if (Number.isNaN(g.lo[c]) || !Number.isNaN(g.water[c])) continue
      if (r.portals.some(([px, pz]) => Math.hypot(px - lx, pz - lz) < GHOST_CLEAR_M)) continue
      if (props.some((p) => Math.hypot(p.x - lx, p.z - lz) < Math.hypot(p.w, p.d) / 2 + 0.3)) continue
      return { room: r, lx, lz, ly: g.lo[c] }
    }
  }
  return null
}

/** Where a castle's ghost drifts (ghostPick): `{ lx, lz, ly }` in interior metres; null with no such corner. */
export function ghostSpot(lay) {
  const p = ghostPick(lay)
  return p && { lx: p.lx, lz: p.lz, ly: p.ly }
}
