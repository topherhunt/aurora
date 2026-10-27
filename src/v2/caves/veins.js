// Ore veins and gems in a cave's walls, and the routes pets lead her along to them (design/39-caves.md §11). Pure in the plan: the same seed places the same veins on every client, so a vein's id is its place in the ledger.
//
// `system` below is anything with { plan, oy, mined }: the plan from planCave, the cave's world height, and the Set of vein ids already taken (CaveRoom has all three).

import { mulberry32 } from '../../sim/mathx.js'
import { columnAt } from './props.js'
import { rayRock, gradient } from './chalk.js'
import { buildNet, nearestVertex, shortest, walkBack, onFloor } from './route.js'

export const ORES = ['bog-iron', 'lodestone', 'rimesilver']
export const GEMS = ['jade', 'ruby', 'sapphire', 'diamond']

export const VEINS = {
  // No vein or gem within this many metres of a mouth by path.
  minPath: 100,
  // Lodestone only past this, and a vein or gem grows commoner out to FULL_PATH.
  lodePath: 250,
  fullPath: 500,
  // Height of a vein above the floor.
  height: [0.5, 2],
  // Rimesilver in the great cavern.
  rime: [5, 10],
}

// A wall hit reads as a wall, not floor or roof, when its normal is this near horizontal.
const WALL_NY = 0.55
// Along a passage, a vein is tried this often.
const EDGE_STEP = [16, 34]

const memo = new WeakMap()

/** Shortest walking distance from a mouth to each node centre, over every passage whichever way it runs. */
function pathFromMouths(graph) {
  const n = graph.nodes.length
  const dist = new Array(n).fill(Infinity)
  for (const m of graph.nodes) if (m.kind === 'mouth') dist[m.i] = 0
  const done = new Array(n).fill(false)
  for (;;) {
    let u = -1
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u === -1 || dist[i] < dist[u])) u = i
    if (u === -1) break
    done[u] = true
    for (const e of graph.edges) {
      const o = e.a === u ? e.b : e.b === u ? e.a : -1
      if (o === -1) continue
      const len = e.pts[e.pts.length - 1].s
      if (dist[u] + len < dist[o]) dist[o] = dist[u] + len
    }
  }
  return dist
}

/** A wall spot: from (x, z) in air with a floor near `y`, a ray out at `ang` meets the wall, and the spot is `lift` metres over the floor there. { x, y, z, nx, ny, nz, floor } in cave-local metres, or null. */
function wallSpot(field, x, y, z, ang, lift, reach) {
  const col = columnAt(field, x, z, y)
  if (col === null) return null
  const dx = Math.cos(ang), dz = Math.sin(ang)
  const hit = [0, 0, 0]
  if (!rayRock(field, x, col.floor + 1, z, dx, 0, dz, reach, hit)) return null
  const fx = hit[0] - dx * 0.4, fz = hit[2] - dz * 0.4
  const foot = columnAt(field, fx, fz, hit[1])
  if (foot === null) return null
  const ty = foot.floor + lift
  if (foot.roof - ty < 0.4 || field.at(fx, ty, fz) > -0.15) return null
  if (!rayRock(field, fx, ty, fz, dx, 0, dz, 1.6, hit)) return null
  const at = columnAt(field, hit[0] - dx * 0.15, hit[2] - dz * 0.15, hit[1])
  if (at === null || hit[1] - at.floor < VEINS.height[0] || hit[1] - at.floor > VEINS.height[1]) return null
  const g = [0, 0, 0]
  if (gradient(field, hit[0], hit[1], hit[2], g) === 0) return null
  const nx = -g[0], ny = -g[1], nz = -g[2]
  if (Math.abs(ny) > WALL_NY || Math.abs(field.at(hit[0], hit[1], hit[2])) > 0.3 || field.at(hit[0] + nx * 0.5, hit[1] + ny * 0.5, hit[2] + nz * 0.5) >= 0) return null
  return { x: hit[0], y: hit[1], z: hit[2], nx, ny, nz, floor: at.floor }
}

/** A point at fraction (u, angle a) of node `n`'s ellipse, in the field's own rotation (field.js). */
// Rimesilver stays within this many of the great cavern's radii: a ray from inside can run on into a lobe's tunnel.
const RIME_RHO = 1.3

function rhoOf(n, p) {
  const dx = p.x - n.x, dz = p.z - n.z, c = Math.cos(n.rot), s = Math.sin(n.rot)
  return Math.hypot((dx * c + dz * s) / n.rx, (dz * c - dx * s) / n.rz)
}

function inNode(n, u, a) {
  const lx = Math.cos(a) * u * n.rx, lz = Math.sin(a) * u * n.rz, c = Math.cos(n.rot), s = Math.sin(n.rot)
  return [n.x + lx * c - lz * s, n.z + lx * s + lz * c]
}

function wet(waters, x, y, z) {
  for (const b of waters) {
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue
    const level = b.levelAt(x, z)
    if (level !== null && y < level + 0.2 && y > b.bed - 1.5) return true
  }
  return false
}

function pickGem(depth, r) {
  const k = (a, b) => Math.min(1, Math.max(0, (depth - a) / b))
  const w = [3, 2 * k(100, 150), 2 * k(150, 250), 1.5 * k(250, 300)]
  let t = r * (w[0] + w[1] + w[2] + w[3])
  for (let i = 0; i < 4; i++) { if (t < w[i]) return GEMS[i]; t -= w[i] }
  return GEMS[0]
}

/** Every vein and gem of `plan`, in cave-local metres: { id, kind, x, y, z, nx, ny, nz, floor, path } with `path` the metres from a mouth it is certainly beyond. */
export function placeVeins(plan) {
  const { graph, field, seed } = plan
  const rand = mulberry32((seed ^ 0x7e1a) >>> 0)
  const rr = (a, b) => a + (b - a) * rand()
  const dist = pathFromMouths(graph)
  const mouths = graph.nodes.filter((n) => n.kind === 'mouth')
  const crow = (x, z) => Math.min(...mouths.map((m) => Math.hypot(m.x - x, m.z - z)))
  const lbNode = (n, x, z) => Math.max(crow(x, z), dist[n.i] - Math.max(n.rx, n.rz))
  const lbEdge = (e, s, x, z) => Math.max(crow(x, z), Math.min(dist[e.a] + s, dist[e.b] + e.pts[e.pts.length - 1].s - s))
  const commonness = (d) => 0.4 + 1.6 * Math.min(1, Math.max(0, (d - VEINS.minPath) / (VEINS.fullPath - VEINS.minPath)))
  const out = []
  const keep = (kind, spot, path) => {
    if (path < VEINS.minPath || wet(plan.waters, spot.x, spot.floor, spot.z)) return false
    if (out.some((v) => Math.hypot(v.x - spot.x, v.y - spot.y, v.z - spot.z) < 1.2)) return false
    out.push({ id: `${seed}:${out.length}`, kind, ...spot, path })
    return true
  }
  const oreFor = (d) => (d >= VEINS.lodePath && rand() < 0.6 ? 'lodestone' : 'bog-iron')

  for (const n of graph.nodes) {
    if (n.kind === 'mouth') continue
    const r = Math.max(n.rx, n.rz)
    const want = (0.6 + Math.sqrt(r) / 6) * commonness(dist[n.i])
    const count = Math.floor(want + rand())
    for (let k = 0; k < count; k++) {
      for (let tries = 0; tries < 8; tries++) {
        const a = rand() * Math.PI * 2
        const u = Math.sqrt(rand()) * 0.7
        const [x, z] = inNode(n, u, a)
        const spot = wallSpot(field, x, n.y + 1, z, rand() * Math.PI * 2, rr(...VEINS.height), Math.max(12, r * 1.4))
        if (spot === null) continue
        const d = lbNode(n, spot.x, spot.z)
        if (keep(oreFor(d), spot, d)) break
      }
    }
  }

  for (const e of graph.edges) {
    if (e.kind !== 'walk' && e.kind !== 'drop') continue
    const total = e.pts[e.pts.length - 1].s
    for (let s = rr(...EDGE_STEP); s < total - 6; s += rr(...EDGE_STEP)) {
      const p = e.pts.find((q) => q.s >= s)
      const i = e.pts.indexOf(p)
      const q = e.pts[Math.min(i + 1, e.pts.length - 1)], o = e.pts[Math.max(i - 1, 0)]
      const d = lbEdge(e, s, p.x, p.z)
      if (rand() > 0.5 * commonness(d)) continue
      const side = rand() < 0.5 ? 1 : -1
      const spot = wallSpot(field, p.x, p.y + 1, p.z, Math.atan2(q.z - o.z, q.x - o.x) + side * Math.PI / 2, rr(...VEINS.height), p.w + 4)
      if (spot !== null) keep(oreFor(d), spot, d)
    }
  }

  const great = graph.nodes.find((n) => n.great === true)
  if (great !== undefined) {
    const want = Math.round(rr(...VEINS.rime))
    let placed = 0
    for (let tries = 0; tries < 3000 && placed < want; tries++) {
      const a = rand() * Math.PI * 2, u = Math.sqrt(rand()) * 0.85
      const [x, z] = inNode(great, u, a)
      const spot = wallSpot(field, x, great.y + 1, z, rand() * Math.PI * 2, rr(...VEINS.height), Math.max(20, great.rx))
      if (spot === null || rhoOf(great, spot) > RIME_RHO) continue
      if (keep('rimesilver', spot, lbNode(great, spot.x, spot.z))) placed++
    }
  }

  for (const nook of graph.nooks) {
    const pts = nook.pts
    const t = pts[Math.min(pts.length - 1, Math.floor(pts.length * (0.55 + 0.3 * rand())))]
    const d = nook.edge === undefined ? lbNode(graph.nodes[nook.node], t.x, t.z) : lbEdge(graph.edges[nook.edge], graph.edges[nook.edge].pts[0].s + 0, t.x, t.z)
    if (d < VEINS.minPath || rand() > 0.3 + 0.45 * Math.min(1, (d - VEINS.minPath) / (VEINS.fullPath - VEINS.minPath))) continue
    const i = pts.indexOf(t)
    const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)]
    const lift = Math.min(rr(...VEINS.height), Math.max(0.5, t.h - 0.5))
    const spot = wallSpot(field, t.x, t.y + 0.8, t.z, Math.atan2(q.z - o.z, q.x - o.x) + (rand() < 0.5 ? 1 : -1) * Math.PI / 2, lift, t.w + 1.5)
    if (spot !== null) keep(pickGem(d, rand()), spot, d)
  }
  return out
}

function veinsOfPlan(plan) {
  let v = memo.get(plan)
  if (v === undefined) {
    v = { list: placeVeins(plan), net: null, spots: null, attach: null }
    memo.set(plan, v)
  }
  return v
}

/** Where she stands to work vein `v`: on the floor 0.3 to 0.8 m out from it, or null in a crevice too tight to stand in. */
function standingSpot(field, v) {
  const hl = Math.hypot(v.nx, v.nz)
  for (const d of [0.8, 0.5, 0.3]) {
    const x = v.x + (v.nx / hl) * d, z = v.z + (v.nz / hl) * d
    const col = columnAt(field, x, z, v.floor + 0.6)
    if (col !== null && Math.abs(col.floor - v.floor) < 0.5) return { x, y: col.floor, z }
  }
  return null
}

/** The net vertex among the 12 nearest to `spot` whose straight way to it is floor all along (no rock between, no step over 0.8 m a metre); the nearest if none is. */
function attachVertex(field, net, v, spot) {
  if (spot === null) return nearestVertex(net, v.x, v.floor, v.z)
  const near = []
  for (let i = 0; i < net.x.length; i++) {
    const d = (net.x[i] - spot.x) ** 2 + (net.y[i] - spot.y) ** 2 + (net.z[i] - spot.z) ** 2
    if (near.length < 12 || d < near[near.length - 1][0]) {
      near.push([d, i])
      near.sort((p, q) => p[0] - q[0])
      if (near.length > 12) near.pop()
    }
  }
  for (const [, i] of near) {
    const len = Math.hypot(net.x[i] - spot.x, net.z[i] - spot.z)
    const n = Math.ceil(len / 1)
    let y = net.y[i], ok = true
    for (let k = 1; k <= n && ok; k++) {
      const c = columnAt(field, net.x[i] + ((spot.x - net.x[i]) * k) / n, net.z[i] + ((spot.z - net.z[i]) * k) / n, y + 0.6)
      if (c === null || Math.abs(c.floor - y) > 0.8) ok = false
      else y = c.floor
    }
    if (ok) return i
  }
  return near[0][1]
}

/** The memoized cave-local list of `plan`'s veins and gems (placeVeins), each with its `floor` and `path`. */
export function veinList(plan) {
  return veinsOfPlan(plan).list
}

function checkSystem(system) {
  if (!system || typeof system.plan !== 'object' || !Number.isFinite(system.oy) || !(system.mined instanceof Set)) throw new Error('veins: system needs { plan, oy, mined: Set }')
}

/** Every vein and gem of the system, taken or not, in world metres: [{ id, kind, x, y, z, nx, ny, nz }]. `id` is stable for a seed. */
export function veinsOf(system) {
  checkSystem(system)
  return veinsOfPlan(system.plan).list.map((v) => ({ id: v.id, kind: v.kind, x: v.x, y: v.y + system.oy, z: v.z, nx: v.nx, ny: v.ny, nz: v.nz }))
}

/** The vein or gem with `id` in cave-local metres, with its floor point; throws on an unknown id. */
export function veinById(system, id) {
  const v = veinsOfPlan(system.plan).list.find((q) => q.id === id)
  if (v === undefined) throw new Error(`veins: no vein ${id}`)
  return v
}

/**
 * The way on foot from the world point `from` to `to`, a polyline of world points along the floor, `from` first: `'treasure'` ends under the nearest vein or gem not in `system.mined` (nearest by walking), `'exit'` at the nearest mouth. Null when nothing is left to lead to or the way is shut.
 */
export function routeFrom(system, from, to) {
  checkSystem(system)
  if (to !== 'treasure' && to !== 'exit') throw new Error(`routeFrom: to is 'treasure' or 'exit', not ${to}`)
  const plan = system.plan
  const cached = veinsOfPlan(plan)
  if (cached.net === null) {
    cached.net = buildNet(plan.graph)
    cached.spots = cached.list.map((v) => standingSpot(plan.field, v))
    cached.attach = cached.list.map((v, i) => attachVertex(plan.field, cached.net, v, cached.spots[i]))
  }
  const net = cached.net
  const fx = from.x, fy = from.y - system.oy, fz = from.z
  const { cost, prev } = shortest(net, nearestVertex(net, fx, fy, fz))
  let best = Infinity, end = null, spot = null
  if (to === 'exit') {
    for (const m of plan.graph.nodes) if (m.kind === 'mouth' && cost[net.nodeV[m.i]] < best) { best = cost[net.nodeV[m.i]]; end = net.nodeV[m.i] }
  } else {
    cached.list.forEach((v, i) => {
      if (system.mined.has(v.id) || cached.spots[i] === null) return
      const a = cached.attach[i]
      const c = cost[a] + Math.hypot(net.x[a] - cached.spots[i].x, net.z[a] - cached.spots[i].z)
      if (c < best) { best = c; end = a; spot = cached.spots[i] }
    })
  }
  if (end === null || best === Infinity) return null
  const pts = [{ x: fx, y: fy, z: fz }, ...walkBack(net, prev, end)]
  if (spot !== null) pts.push(spot)
  return onFloor(plan.field, pts).map((p) => ({ x: p.x, y: p.y + system.oy, z: p.z }))
}
