// The scaffold of a tower labyrinth (design/41-palisade-labyrinths.md, "The scaffold tower"): sixteen giant posts in a 4x4 grid 1.5 m apart round a 3x3 lattice of cells, with a 3D maze of ladders and net floors between them, a plank deck on top, the altar on the plank.
//
// Three-free and pure, a function of its seed and the labyrinth's door bearing. A scaffold is a 3x3 grid of `bay` metres' square bays seen from above, stacked in `floors` net floors `rise` apart and a plank over them all. A bay's floor may be missing (a pit: a one-way drop to the floor below) and the edge between two bays is open or a net wall; the outer edge of a floored bay is always a wall. A ladder joins one bay's floor to the next level's, through a hatch in that floor.
//
// Frame: u is the unit toward the labyrinth's door, v = (-uz, ux); bay (i, j) spans a in [(i-1.5) bay, (i-0.5) bay] along u and b in [(j-1.5) bay, (j-0.5) bay] along v. Sides d: 0 +a, 1 +b, 2 -a, 3 -b.
import { mulberry32 } from '../../sim/mathx.js'

export const SCAFFOLD = {
  // The open middle's radius of a tower labyrinth: its 4.5 m square (3.18 m to a corner) stands clear of the innermost ring.
  centre: 5.4,
  bay: 1.5,
  bays: 3,
  floors: 4,
  // Metres between floors, the first above the highest ground under the scaffold, and the plank `rise` over the last.
  rise: 2,
  // The net walls' height, the posts' height over the same ground (their girth a share of a palisade post's).
  wall: 1.6,
  post: 11,
  girth: 1.7,
  // A ladder hangs `ladderIn` inside its bay's edge on side d; its climber stands `foot` in, steps off at `exit`, and the hatch in the floor above spans `hatch` in from the edge and `hatchHalf` either side of the edge's middle.
  ladderIn: 0.25,
  foot: 0.58,
  exit: 1.1,
  hatch: [0.05, 0.8],
  hatchHalf: 0.35,
  // The rope's coil stands `ropeIn` inside the plank's edge; its rope hangs `ropeOut` outside, and she goes down it at `ropeSpeed` m/s.
  ropeIn: 0.35,
  ropeOut: 0.2,
  ropeSpeed: 2,
  // Metres over the highest sampled ground that the lowest floor stands above its headroom.
  margin: 0.15,
}

const B = SCAFFOLD.bay
const N = SCAFFOLD.bays
export const PLANK = SCAFFOLD.floors + 1
export const SIDES = [[1, 0], [0, 1], [-1, 0], [0, -1]]
// Node ids of the walkable graph: the ground, each floored bay of each net floor, the plank.
export const GROUND = 0
export const PLANK_NODE = 1 + SCAFFOLD.floors * N * N
export const nodeOf = (l, i, j) => (l === 0 ? GROUND : l === PLANK ? PLANK_NODE : 1 + (l - 1) * N * N + i * N + j)
/** Node id back to `{ l, i, j }` (the ground and the plank have i = j = -1). */
export function placeOf(id) {
  if (id === GROUND) return { l: 0, i: -1, j: -1 }
  if (id === PLANK_NODE) return { l: PLANK, i: -1, j: -1 }
  const k = id - 1, c = k % (N * N)
  return { l: 1 + Math.floor(k / (N * N)), i: Math.floor(c / N), j: c % N }
}
const ATTEMPTS = 400
const LOOPS = 0.12
const inGrid = (i, j) => i >= 0 && j >= 0 && i < N && j < N

/** The index in a floor's `walls` of the edge on side d of bay (i, j): the i-edges (N + 1 rows of N) then the j-edges. */
export function edgeOf(i, j, d) {
  if (d === 0) return (i + 1) * N + j
  if (d === 2) return i * N + j
  if (d === 1) return (N + 1) * N + (j + 1) * N + i
  return (N + 1) * N + j * N + i
}

/** Bay (i, j)'s centre, moved `da` along u and `db` along v, into `out` as world [x, z]. */
export function bayPoint(sc, i, j, da, db, out) {
  const a = (i - (N - 1) / 2) * B + da, b = (j - (N - 1) / 2) * B + db
  out[0] = sc.cx + sc.ux * a + sc.vx * b
  out[1] = sc.cz + sc.uz * a + sc.vz * b
  return out
}

/** The point `inward` metres inside bay (i, j)'s edge on side d, on the line from the bay's middle to that edge, into `out` as world [x, z]. */
export function sidePoint(sc, i, j, d, inward, out) {
  const k = B / 2 - inward
  return bayPoint(sc, i, j, SIDES[d][0] * k, SIDES[d][1] * k, out)
}

/** The ladder's climbing spots in world space: `plane` its plane's middle, `foot` where she stands, `exit` where the upper floor steps her off, `face` the unit along which she climbs (toward the plane). */
export function ladderSpots(sc, ld) {
  const [dx, dz] = [SIDES[ld.d][0] * sc.ux + SIDES[ld.d][1] * sc.vx, SIDES[ld.d][0] * sc.uz + SIDES[ld.d][1] * sc.vz]
  return {
    plane: sidePoint(sc, ld.i, ld.j, ld.d, SCAFFOLD.ladderIn, [0, 0]),
    foot: sidePoint(sc, ld.i, ld.j, ld.d, SCAFFOLD.foot, [0, 0]),
    exit: sidePoint(sc, ld.i, ld.j, ld.d, SCAFFOLD.exit, [0, 0]),
    face: [dx, dz],
  }
}

/** World (x, z) into the frame: `out` = [a, b, i, j] with (i, j) the bay, or -1 outside the 4.5 m square. */
export function frameOf(sc, x, z, out) {
  const dx = x - sc.cx, dz = z - sc.cz
  const a = dx * sc.ux + dz * sc.uz, b = dx * sc.vx + dz * sc.vz
  out[0] = a
  out[1] = b
  const i = Math.floor(a / B + N / 2), j = Math.floor(b / B + N / 2)
  out[2] = inGrid(i, j) ? i : -1
  out[3] = inGrid(i, j) ? j : -1
  return out
}

/** Whether the point (a, b) of the frame, in bay (i, j), is over the hatch of a ladder arriving at `level` there. */
export function inHatch(sc, level, i, j, a, b) {
  for (const ld of sc.ladders) {
    if (ld.l + 1 !== level || ld.i !== i || ld.j !== j) continue
    const ca = (i - (N - 1) / 2) * B, cb = (j - (N - 1) / 2) * B
    const [dx, dz] = SIDES[ld.d]
    const along = B / 2 - ((a - ca) * dx + (b - cb) * dz), across = Math.abs(-(a - ca) * dz + (b - cb) * dx)
    if (along >= SCAFFOLD.hatch[0] && along <= SCAFFOLD.hatch[1] && across <= SCAFFOLD.hatchHalf) return true
  }
  return false
}

/** The sixteen posts' world [x, z]: every lattice point of the bays' corners, the footprint's rim included. */
export function postsAt(sc) {
  const out = []
  for (let p = 0; p <= N; p++) for (let q = 0; q <= N; q++) out.push(bayPoint(sc, p, q, -B / 2, -B / 2, [0, 0]))
  return out
}

/** The ground the scaffold's levels stand over: the highest of `ground`'s samples over its footprint plus `margin`, so the lowest floor clears the head wherever the ground rises under it. Memoized on `sc`. */
export function scaffoldBase(sc, ground) {
  if (sc._base !== null) return sc._base
  let top = -Infinity
  const half = (N * B) / 2 + 0.5
  for (let a = -half; a <= half + 1e-6; a += 1) {
    for (let b = -half; b <= half + 1e-6; b += 1) top = Math.max(top, ground(sc.cx + sc.ux * a + sc.vx * b, sc.cz + sc.uz * a + sc.vz * b))
  }
  sc._base = top + SCAFFOLD.margin
  return sc._base
}

/** The top of level `l` (1..floors the net floors, PLANK the deck). */
export const levelY = (sc, ground, l) => scaffoldBase(sc, ground) + SCAFFOLD.rise * l

/** The directed walkable graph as [from, to, kind] with kind `walk`, `up`, `down` (a ladder) or `drop` (off a floor's open edge into a pit, to the floor below or the ground). A one-way edge is `drop`. */
export function graphOf(sc) {
  const edges = []
  for (let l = 1; l <= SCAFFOLD.floors; l++) {
    const F = sc.floor[l], W = sc.walls[l]
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (!F[i * N + j]) continue
        for (let d = 0; d < 4; d++) {
          const i2 = i + SIDES[d][0], j2 = j + SIDES[d][1]
          if (!inGrid(i2, j2)) continue
          if (F[i2 * N + j2]) {
            if (!W[edgeOf(i, j, d)]) edges.push([nodeOf(l, i, j), nodeOf(l, i2, j2), 'walk'])
          } else if (l === 1) edges.push([nodeOf(l, i, j), GROUND, 'drop'])
          else if (sc.floor[l - 1][i2 * N + j2]) edges.push([nodeOf(l, i, j), nodeOf(l - 1, i2, j2), 'drop'])
          else edges.push([nodeOf(l, i, j), -1, 'drop'])
        }
      }
    }
  }
  for (const ld of sc.ladders) {
    const lo = nodeOf(ld.l, ld.i, ld.j), hi = nodeOf(ld.l + 1, ld.i, ld.j)
    edges.push([lo, hi, 'up'], [hi, lo, 'down'])
  }
  return edges
}

/** The nodes reached from the ground along `edges` whose kind `follow` accepts; a Set. */
export function reachFrom(edges, follow) {
  const out = new Map()
  for (const [a, b, k] of edges) {
    if (!follow(k) || b < 0) continue
    if (!out.has(a)) out.set(a, [])
    out.get(a).push(b)
  }
  const seen = new Set([GROUND]), queue = [GROUND]
  for (let q = 0; q < queue.length; q++) for (const n of out.get(queue[q]) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n) }
  return seen
}

/** The nodes of the cheapest way from the ground to the plank along graphOf, `cost(kind)` metres or seconds an edge of that kind (`walk`, `up`, `down`, `drop`; Infinity forbids it); Dijkstra over the few dozen nodes. */
export function routeOf(sc, cost) {
  const edges = graphOf(sc).filter(([, b]) => b >= 0)
  const dist = new Map([[GROUND, 0]]), prev = new Map(), done = new Set()
  for (;;) {
    let at = -1
    for (const [n, d] of dist) if (!done.has(n) && (at < 0 || d < dist.get(at))) at = n
    if (at < 0) throw new Error('routeOf: the plank is not reached')
    if (at === PLANK_NODE) break
    done.add(at)
    for (const [a, b, kind] of edges) {
      if (a !== at) continue
      const c = cost(kind)
      if (!Number.isFinite(c)) continue
      const d = dist.get(at) + c
      if (!dist.has(b) || d < dist.get(b)) { dist.set(b, d); prev.set(b, at) }
    }
  }
  const out = [PLANK_NODE]
  while (out[0] !== GROUND) out.unshift(prev.get(out[0]))
  return out
}

/**
 * One attempt at the layout, or null. The levels' shape: levels 3 and 4 are each cut across at row `cut` (the rows of a random orientation, the middle row of three): level 3 by a wall between its rows `cut - 1` and `cut`, level 4 by a stripe of pits at row `cut`. The way to the plank climbs to level 4 on the near side, drops down the stripe onto level 3's far side, and climbs again to level 4's far side, whose ladders alone reach the plank.
 */
function attempt(c, rand) {
  const orient = Math.floor(rand() * 8)
  const row = (i, j) => { const r = orient & 1 ? j : i; return orient & 2 ? N - 1 - r : r }
  const cut = 1
  const sc = { cx: c.cx, cz: c.cz, ux: c.ux, uz: c.uz, vx: -c.uz, vz: c.ux, floor: [null], walls: [null], ladders: [], altar: null, rope: null, _base: null }
  for (let l = 1; l <= SCAFFOLD.floors; l++) sc.floor.push(new Uint8Array(N * N).fill(1))
  const bays = []
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) bays.push([i, j])
  for (const [i, j] of bays) if (row(i, j) === cut) sc.floor[4][i * N + j] = 0
  // A few pits in the lower floors, each over a floor (or the ground) and none under level 4's stripe where level 3 must hold.
  for (let l = 1; l <= 3; l++) {
    for (let k = Math.floor(rand() * 3); k > 0; k--) {
      const [i, j] = bays[Math.floor(rand() * bays.length)]
      if ((l > 1 && !sc.floor[l - 1][i * N + j]) || (l === 3 && row(i, j) === cut)) continue
      sc.floor[l][i * N + j] = 0
    }
  }
  const region = (l, i, j) => (l === 3 ? (row(i, j) < cut ? 0 : 1) : l === 4 ? (row(i, j) < cut ? 0 : row(i, j) > cut ? 1 : -1) : 0)
  for (let l = 1; l <= SCAFFOLD.floors; l++) {
    const F = sc.floor[l], W = new Uint8Array((N + 1) * N * 2)
    sc.walls.push(W)
    // Every edge between floors and round the outside starts a wall; each region's carve and loops open some.
    for (const [i, j] of bays) {
      if (!F[i * N + j]) continue
      for (let d = 0; d < 4; d++) {
        const i2 = i + SIDES[d][0], j2 = j + SIDES[d][1]
        if (!inGrid(i2, j2) || F[i2 * N + j2]) W[edgeOf(i, j, d)] = 1
      }
    }
    for (const reg of [0, 1]) {
      const mine = bays.filter(([i, j]) => F[i * N + j] && region(l, i, j) === reg)
      if (mine.length === 0) continue
      const seen = new Set([mine[0][0] * N + mine[0][1]]), stack = [mine[0]]
      while (stack.length > 0) {
        const [i, j] = stack[stack.length - 1]
        const next = []
        for (let d = 0; d < 4; d++) {
          const i2 = i + SIDES[d][0], j2 = j + SIDES[d][1]
          if (inGrid(i2, j2) && F[i2 * N + j2] && region(l, i2, j2) === reg && !seen.has(i2 * N + j2)) next.push(d)
        }
        if (next.length === 0) { stack.pop(); continue }
        const d = next[Math.floor(rand() * next.length)], i2 = i + SIDES[d][0], j2 = j + SIDES[d][1]
        W[edgeOf(i, j, d)] = 0
        seen.add(i2 * N + j2)
        stack.push([i2, j2])
      }
      if (seen.size !== mine.length) return null
      for (const [i, j] of mine) {
        for (const d of [0, 1]) {
          const i2 = i + SIDES[d][0], j2 = j + SIDES[d][1]
          if (inGrid(i2, j2) && F[i2 * N + j2] && region(l, i2, j2) === reg && W[edgeOf(i, j, d)] && rand() < LOOPS) W[edgeOf(i, j, d)] = 0
        }
      }
    }
  }
  const used = Array.from({ length: PLANK + 1 }, () => new Set())
  const perimeter = ([i, j]) => i === 0 || j === 0 || i === N - 1 || j === N - 1
  const outward = ([i, j]) => [0, 1, 2, 3].filter((d) => !inGrid(i + SIDES[d][0], j + SIDES[d][1]))
  const pickOf = (list) => (list.length === 0 ? null : list[Math.floor(rand() * list.length)])
  // Place a ladder from level l up from a bay `ok` allows; false when none is left.
  const ladder = (l, ok) => {
    const cands = bays.filter(([i, j]) => {
      if (l === 0 ? !sc.floor[1][i * N + j] || !perimeter([i, j]) : !sc.floor[l][i * N + j] || (l < SCAFFOLD.floors && !sc.floor[l + 1][i * N + j])) return false
      return !used[l + 1].has(i * N + j) && (l === 0 || !used[l].has(i * N + j)) && ok(i, j)
    })
    const at = pickOf(cands)
    if (at === null) return false
    const d = l === 0 ? pickOf(outward(at)) : Math.floor(rand() * 4)
    sc.ladders.push({ l, i: at[0], j: at[1], d })
    used[l + 1].add(at[0] * N + at[1])
    if (l > 0) used[l].add(at[0] * N + at[1])
    return true
  }
  const near = (i, j) => row(i, j) < cut, far = (i, j) => row(i, j) > cut, any = () => true
  if (!ladder(0, any)) return null
  ladder(0, any)
  if (!ladder(1, any)) return null
  ladder(1, any)
  if (!ladder(2, near)) return null
  ladder(2, near)
  if (!ladder(3, near) || !ladder(3, far)) return null
  if (rand() < 0.5) ladder(3, any)
  if (!ladder(4, far)) return null
  ladder(4, far)
  // The altar in an inner bay without a hatch.
  const altar = pickOf(bays.filter(([i, j]) => i > 0 && j > 0 && i < N - 1 && j < N - 1 && !used[PLANK].has(i * N + j)))
  if (altar === null) return null
  sc.altar = { i: altar[0], j: altar[1] }
  const edges = graphOf(sc)
  if (edges.some(([, b]) => b < 0)) return null
  const all = reachFrom(edges, () => true)
  const climbing = reachFrom(edges, (k) => k === 'walk' || k === 'up')
  for (let l = 1; l <= SCAFFOLD.floors; l++) for (const [i, j] of bays) if (sc.floor[l][i * N + j] && !all.has(nodeOf(l, i, j))) return null
  if (!all.has(PLANK_NODE) || climbing.has(PLANK_NODE)) return null
  // The rope's coil on a plank edge bay without a hatch, rolled last so it moves nothing else.
  const rope = pickOf(bays.filter((b) => perimeter(b) && !used[PLANK].has(b[0] * N + b[1])))
  if (rope === null) throw new Error('scaffold: no plank edge bay without a hatch for the rope')
  sc.rope = { i: rope[0], j: rope[1], d: pickOf(outward(rope)) }
  return sc
}

/** The scaffold of a tower labyrinth centred (cx, cz) with its door toward the unit (ux, uz), rolled off `seed`: the first attempt of ATTEMPTS whose graph holds (graphOf). */
export function scaffoldOf(c, seed) {
  for (let k = 0; k < ATTEMPTS; k++) {
    const sc = attempt(c, mulberry32((seed + Math.imul(k, 0x9e3779b1)) >>> 0))
    if (sc !== null) return sc
  }
  throw new Error(`scaffoldOf: no layout in ${ATTEMPTS} attempts for seed ${seed}`)
}
