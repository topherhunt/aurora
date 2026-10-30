// A castle's dungeon (design/44-castles.md, Dungeon): a spiral down from a tower's ground room to a foot chamber, a locked door, and
// past it a maze of passages and rooms on a lattice, a drain gutter down its longest run, flooded rooms and puddles. Plain data on a
// 1 m grid in interior metres, floors about y -6 (storey k -1): dungeon-mesh.js draws it, solids.js walks it, furnish.js fills it.
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE } from './layout.js'

const C = CASTLE.cell, S = CASTLE.scale, SH = CASTLE.storey * CASTLE.tall
export const DUNGEON = {
  floor: -SH,
  // The foot chamber's half-width; its 1 m rim is roofed at `rim`, the rest open to the ground room's slab underside at `slab`.
  foot: { half: 4, rim: -0.8, slab: -0.3 },
  door: { hw: 1, h: 3 },
  step: 8, drain: 6,
  // Floor and water heights over `floor`.
  gutter: [-0.4, -0.15], flood: [-0.2, -0.05], puddle: [-0.1, -0.03],
}
const F = DUNGEON.floor

const plans = new WeakMap()

/** The ground room the dungeon's spiral climbs into, and the cell centre it climbs about (exterior metres): a corner tower's when one
 * is in use, continuing the helix of a spiral already rising from that room. */
function stairOf(lay, rng) {
  const corners = lay.sections.slice(0, 4).filter((s) => s.kind === 'tower' && !s.rooms[0][0].unused)
  const pool = corners.length ? corners : lay.sections.filter((s) => s.kind !== 'wall' && s.kind !== 'gate' && s.rooms[0].some((r) => !r.unused))
  if (!pool.length) throw new Error(`castle ${lay.seed}: no ground room for the dungeon stair`)
  const sec = pool[Math.floor(rng() * pool.length)], room = sec.rooms[0].find((r) => !r.unused)
  const up = lay.edges.find((e) => e.stair && e.a === room && e.stair.k === 0)
  if (up) return { node: room, x: up.stair.x, z: up.stair.z }
  const doors = lay.edges.filter((e) => e.a === room || e.b === room).flatMap((e) => e.doors).filter((d) => d.y === 0)
  let best = null, far = -1
  for (let gx = room.x0; gx < room.x0 + room.w; gx++) for (let gz = room.z0; gz < room.z0 + room.d; gz++) {
    const x = lay.X(gx + 0.5), z = lay.Z(gz + 0.5), d = Math.min(...doors.map((q) => Math.hypot(q.x - x, q.z - z)))
    if (d > far) { far = d; best = { node: room, x, z } }
  }
  return best
}

/**
 * A layout's dungeon: `stair` { node, x, z } (exterior metres), the grid (`x0`, `z0` its corner, `W` x `D` cells, cell i + j * W
 * covering x0 + i .. x0 + i + 1; `lo` floor and `hi` ceiling, NaN where rock; `water` its surface, NaN where dry; `roof` 0 where the
 * slab above is the ceiling), `foot` and `door` (interior metres, the door's normal `side` along `axis` pointing into the maze), and
 * `rooms` { rect, lo, hi, junction, flooded, depth, portals }, `chest` the index of the room the chest stands in.
 */
export function dungeonPlan(lay) {
  if (plans.has(lay)) return plans.get(lay)
  const rng = mulberry32(lay.seed * 9151 + 5)
  const int = (a, b) => a + Math.floor(rng() * (b - a + 1))
  const height = (a, b) => Math.round((a + rng() * (b - a)) * 10) / 10
  const stair = stairOf(lay, rng)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const s of lay.sections) { minX = Math.min(minX, s.x0); maxX = Math.max(maxX, s.x0 + s.w); minZ = Math.min(minZ, s.z0); maxZ = Math.max(maxZ, s.z0 + s.d) }
  const x0 = lay.X(minX) * S, z0 = lay.Z(minZ) * S, W = (maxX - minX) * C * S, D = (maxZ - minZ) * C * S
  const lo = new Float32Array(W * D).fill(NaN), hi = new Float32Array(W * D).fill(NaN), water = new Float32Array(W * D).fill(NaN), roof = new Uint8Array(W * D)
  const inGrid = (i, j) => i >= 0 && i < W && j >= 0 && j < D
  const stamp = (i0, j0, i1, j1, l, h, r = 1) => {
    if (!inGrid(i0, j0) || !inGrid(i1 - 1, j1 - 1)) throw new Error(`castle ${lay.seed}: dungeon cells ${i0},${j0}..${i1},${j1} leave its ${W} x ${D} grid`)
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
      const c = i + j * W
      if (Number.isNaN(lo[c])) { lo[c] = l; hi[c] = h; roof[c] = r } else { lo[c] = Math.min(lo[c], l); hi[c] = Math.max(hi[c], h); roof[c] = Math.min(roof[c], r) }
    }
  }
  // Sinks open cells to floor `l` under water `w`.
  const dip = (i0, j0, i1, j1, [l, w]) => {
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) {
      const c = i + j * W
      if (Number.isNaN(lo[c])) throw new Error(`castle ${lay.seed}: dungeon water in rock at ${i},${j}`)
      lo[c] = Math.min(lo[c], F + l)
      water[c] = Number.isNaN(water[c]) ? F + w : Math.max(water[c], F + w)
    }
  }

  // The foot chamber about the spiral.
  const { half } = DUNGEON.foot, cx = stair.x * S, cz = stair.z * S
  const fi0 = cx - half - x0, fj0 = cz - half - z0
  if (!Number.isInteger(fi0) || !Number.isInteger(fj0)) throw new Error(`castle ${lay.seed}: dungeon stair off the 1 m grid`)
  const foot = [fi0, fj0, fi0 + 2 * half, fj0 + 2 * half]
  stamp(...foot, F, DUNGEON.foot.rim)
  stamp(fi0 + 1, fj0 + 1, fi0 + 2 * half - 1, fj0 + 2 * half - 1, F, DUNGEON.foot.slab, 0)

  // The door, on the foot's side toward the castle's middle. Along/lateral (a, l) cells map to (i, j) by its axis.
  const axis = Math.abs(cx) >= Math.abs(cz) ? 'x' : 'z', side = (axis === 'x' ? cx : cz) > 0 ? -1 : 1
  const IJ = (a, l) => (axis === 'x' ? [a, l] : [l, a])
  const rectAL = (a0, a1, l0, l1) => { const [i0, j0] = IJ(Math.min(a0, a1), Math.min(l0, l1)), [i1, j1] = IJ(Math.max(a0, a1), Math.max(l0, l1)); return [i0, j0, i1, j1] }
  const [fa0, fa1, fl] = axis === 'x' ? [fi0, fi0 + 2 * half, fj0 + half] : [fj0, fj0 + 2 * half, fi0 + half]
  // `out` is the first passage cell past the doorway.
  const doorA = side > 0 ? fa1 : fa0 - 1, out = doorA + side
  const { hw, h: doorH } = DUNGEON.door
  stamp(...rectAL(doorA, doorA + 1, fl - hw, fl + hw), F, F + doorH)
  const plane = (side > 0 ? fa1 : fa0) + side * 0.5
  const door = { axis, side, x: axis === 'x' ? x0 + plane : x0 + fl, z: axis === 'x' ? z0 + fl : z0 + plane, hw, lo: F, hi: F + doorH }

  // The lattice: node cells every `step` metres, three cells in from the grid's edge.
  const lattice = (n) => { const L = n - 7, k = Math.floor(L / DUNGEON.step) + 1; return { k, off: 3 + Math.floor((L - DUNGEON.step * (k - 1)) / 2) } }
  const LX = lattice(W), LZ = lattice(D)
  const nodes = []
  for (let a = 0; a < LX.k; a++) for (let b = 0; b < LZ.k; b++) nodes.push({ a, b, i: LX.off + a * DUNGEON.step, j: LZ.off + b * DUNGEON.step, kept: true, links: [] })
  const nodeAt = (a, b) => (a >= 0 && a < LX.k && b >= 0 && b < LZ.k ? nodes[a * LZ.k + b] : null)
  const rectGap = (r, q) => Math.max(r[0] - q[2], q[0] - r[2], r[1] - q[3], q[1] - r[3])
  for (const n of nodes) if (rectGap([n.i, n.j, n.i + 1, n.j + 1], foot) < 5) n.kept = false
  // The entry node: straight out from the door at least 4 m past its doorway, nearest its line.
  const ahead = (n) => ((axis === 'x' ? n.i : n.j) - out) * side
  const lateral = (n) => (axis === 'x' ? n.j : n.i)
  const entry = nodes.filter((n) => n.kept && ahead(n) >= 4).reduce((p, q) => (p === null || Math.abs(lateral(q) - fl) + ahead(q) * 0.5 < Math.abs(lateral(p) - fl) + ahead(p) * 0.5 ? q : p), null)
  if (entry === null) throw new Error(`castle ${lay.seed}: no dungeon node ahead of the door`)
  for (const n of nodes) if (n !== entry && rng() < 0.12) n.kept = false
  // Lattice edges between kept nodes, but none whose widest passage would come within a cell of the foot chamber.
  const edges = []
  for (const n of nodes) for (const m of [nodeAt(n.a + 1, n.b), nodeAt(n.a, n.b + 1)]) {
    if (m === null || !n.kept || !m.kept) continue
    const r = [Math.min(n.i, m.i) - 1, Math.min(n.j, m.j) - 1, Math.max(n.i, m.i) + 2, Math.max(n.j, m.j) + 2]
    if (rectGap(r, foot) < 1) continue
    const e = { n, m, tree: false, drain: false }
    edges.push(e); n.links.push(e); m.links.push(e)
  }
  // A spanning tree from the entry by depth-first backtracking, then loops back in.
  const seen = new Set([entry]), stack = [entry]
  entry.depth = 0; entry.up = null
  while (stack.length) {
    const n = stack.at(-1), open = n.links.filter((e) => !seen.has(e.n === n ? e.m : e.n))
    if (!open.length) { stack.pop(); continue }
    const e = open[Math.floor(rng() * open.length)], m = e.n === n ? e.m : e.n
    e.tree = true; seen.add(m); m.depth = n.depth + 1; m.up = e; stack.push(m)
  }
  const live = nodes.filter((n) => seen.has(n))
  const ways = edges.filter((e) => e.tree || (seen.has(e.n) && seen.has(e.m) && rng() < 0.15))
  // The drain: the last `drain` edges of the tree's path from the entry to its deepest node.
  const deepest = live.reduce((p, q) => (q.depth > p.depth ? q : p))
  for (let n = deepest, k = 0; n.up !== null && k < DUNGEON.drain; n = n.up.n === n ? n.up.m : n.up.n, k++) n.up.drain = true

  // Rooms: a junction where passages just meet, else a room of 2 to 6 cells a side about its node.
  const rooms = []
  for (const n of live) {
    const junction = n !== deepest && rng() < 0.4
    const w = junction ? 3 : int(2, 6), d = junction ? 3 : int(2, 6), h = junction ? height(2.6, 3.4) : height(2.8, 4.6)
    const at = (c, s) => (junction ? c - 1 : int(Math.max(c - s + 1, c - 3), Math.min(c, c + 3 - s)))
    const i0 = at(n.i, w), j0 = at(n.j, d)
    n.room = { node: n, cells: [i0, j0, i0 + w, j0 + d], lo: F, hi: F + h, junction, flooded: false, depth: n.depth, portals: [] }
    rooms.push(n.room)
  }
  const big = (r) => !r.junction && r.cells[2] - r.cells[0] >= 4 && r.cells[3] - r.cells[1] >= 4
  for (const r of rooms) if (!r.junction && r.node !== entry && rng() < 0.2) r.flooded = true
  const dry = rooms.filter((r) => big(r) && !r.flooded)
  const chestRoom = dry.length ? dry.reduce((p, q) => (q.depth > p.depth ? q : p)) : deepest.room
  if (!big(chestRoom)) { chestRoom.cells = [deepest.i - 2, deepest.j - 2, deepest.i + 2, deepest.j + 2]; chestRoom.junction = false }
  chestRoom.flooded = false
  for (const r of rooms) {
    stamp(...r.cells, r.lo, r.hi)
    stamp(r.node.i - 1, r.node.j - 1, r.node.i + 2, r.node.j + 2, r.lo, r.hi)
  }
  // Passages: 2 or 3 wide at a random offset within their nodes' middle three cells, the drain's 3 wide.
  for (const e of ways) {
    const alongX = e.n.i !== e.m.i, wide = e.drain ? 3 : int(2, 3), s = e.drain ? -1 : -1 + int(0, 3 - wide), h = height(2.5, 3.6)
    const [p, q] = [e.n, e.m].sort((u, v) => (alongX ? u.i - v.i : u.j - v.j))
    e.cells = alongX ? [p.i, p.j + s, q.i + 1, p.j + s + wide] : [p.i + s, p.j, p.i + s + wide, q.j + 1]
    stamp(...e.cells, F, F + h)
  }
  // The way in: out from the doorway to the entry node's line, then across to it.
  const ea = axis === 'x' ? entry.i : entry.j, el = lateral(entry)
  stamp(...rectAL(Math.min(out, ea), Math.max(out, ea) + 1, fl - hw, fl + hw), F, F + doorH)
  stamp(...rectAL(ea - 1, ea + 1, Math.min(fl, el), Math.max(fl, el) + 1), F, F + doorH)

  // Water: rooms awash, the gutter down the drain's middle, puddles in some passages.
  for (const r of rooms) if (r.flooded) dip(...r.cells, DUNGEON.flood)
  for (const e of ways) {
    if (e.drain) {
      const [p, q] = [e.n, e.m]
      dip(Math.min(p.i, q.i), Math.min(p.j, q.j), Math.max(p.i, q.i) + 1, Math.max(p.j, q.j) + 1, DUNGEON.gutter)
    } else if (rng() < 0.3) {
      const alongX = e.cells[2] - e.cells[0] > e.cells[3] - e.cells[1], [a0, a1] = alongX ? [e.cells[0], e.cells[2]] : [e.cells[1], e.cells[3]]
      const t = int(a0 + 3, a1 - 5), n = int(1, 2)
      dip(...(alongX ? [t, e.cells[1], t + n, e.cells[3]] : [e.cells[0], t, e.cells[2], t + n]), DUNGEON.puddle)
    }
  }

  // Each room's openings: a point at the middle of every run of open cells just outside each side, and its node's centre.
  const open = (i, j) => inGrid(i, j) && !Number.isNaN(lo[i + j * W])
  for (const r of rooms) {
    const [i0, j0, i1, j1] = r.cells
    r.rect = [x0 + i0, z0 + j0, x0 + i1, z0 + j1]
    r.portals.push([x0 + r.node.i + 0.5, z0 + r.node.j + 0.5])
    for (const [u0, u1, fixed, alongI] of [[i0, i1, j0 - 1, true], [i0, i1, j1, true], [j0, j1, i0 - 1, false], [j0, j1, i1, false]]) {
      let run = null
      for (let u = u0; u <= u1; u++) {
        const isOpen = u < u1 && (alongI ? open(u, fixed) : open(fixed, u))
        if (isOpen && run === null) run = u
        if (!isOpen && run !== null) {
          const mid = (run + u) / 2, edge = fixed < (alongI ? j0 : i0) ? fixed + 1 : fixed
          r.portals.push(alongI ? [x0 + mid, z0 + edge] : [x0 + edge, z0 + mid])
          run = null
        }
      }
    }
  }

  const plan = { stair, x0, z0, W, D, lo, hi, water, roof, foot: { cells: foot, x: cx, z: cz }, door, rooms, chest: rooms.indexOf(chestRoom), entry: entry.room, nodes: live.length }
  plans.set(lay, plan)
  return plan
}

/** The grid cell holding interior (x, z), or -1 outside the grid. */
export function dungeonCell(g, x, z) {
  const i = Math.floor(x - g.x0), j = Math.floor(z - g.z0)
  return i >= 0 && i < g.W && j >= 0 && j < g.D ? i + j * g.W : -1
}
