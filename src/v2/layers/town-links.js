// Which towns a road joins, and which way each town's main roads leave it (DESIGN.md §35 The network). Before any town is laid out, a coarse A* from each site to each neighbour it will be paired with reads the bearing its way out takes, so a town grows a road toward every neighbour a road will come from rather than a count it picks for itself. Three-free.
import { WORLD_HALF, WORLD_SIZE } from '../config.js'
import { BANK } from './paths.js'
import { Heap } from './route.js'
import { lakeLevelOf } from './water-bodies.js'

export const LINK = {
  // Each town is paired with its `near.k` nearest within `near.r` m, and with every town no third is nearer to both.
  near: { k: 4, r: 2000 },
  // The coarse route's `cell` m grid: a step costs its metres times 1 + (grade / grade)^2 and one steeper than `steep` is refused. Lakes are walls; entering a river costs `river` m, as a bridge would.
  cell: 16,
  grade: 0.07,
  steep: 0.28,
  river: 150,
  // A route's bearing is read where it first stands `read` m from its town. A route walking past `over` times its straight distance gives none, unless its town would get none at all.
  read: 100,
  over: 2,
}

// The pairs a road is tried between, shortest first: each town's `near.k` nearest within `near.r` m, and the relative-neighbourhood pairs (no third town nearer to both) that hold the web together.
export function neighbourPairs(towns) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
  const keys = new Set()
  const pairs = []
  const add = (a, b) => {
    const key = Math.min(a, b) * towns.length + Math.max(a, b)
    if (keys.has(key)) return
    keys.add(key)
    pairs.push({ a, b, len: d(towns[a], towns[b]) })
  }
  for (let a = 0; a < towns.length; a++) {
    towns.map((t, b) => [b, d(towns[a], t)]).filter(([b, ab]) => b !== a && ab < LINK.near.r).sort((p, q) => p[1] - q[1]).slice(0, LINK.near.k).forEach(([b]) => add(a, b))
    for (let b = a + 1; b < towns.length; b++) {
      const ab = d(towns[a], towns[b])
      if (!towns.some((t, c) => c !== a && c !== b && Math.max(d(towns[a], t), d(towns[b], t)) < ab)) add(a, b)
    }
  }
  return pairs.sort((p, q) => p.len - q.len)
}

/**
 * The bearings (radians, atan2(dz, dx)) each site's main roads should leave on, at least `apart` radians apart, nearest neighbour's first. `ground` is the raw heightmap, `surface` the live field (which water the drawn lakes cover); nothing past |z| = `zMax` is walked.
 */
export function townBearings({ sites, ground, surface, layers, zMax, apart }) {
  const G = LINK.cell
  const N = WORLD_SIZE / G
  const cx = (c) => -WORLD_HALF + ((c % N) + 0.5) * G
  const cz = (c) => -WORLD_HALF + (Math.floor(c / N) + 0.5) * G
  const toI = (v) => Math.max(0, Math.min(N - 1, Math.floor((v + WORLD_HALF) / G)))
  const lakeLevel = lakeLevelOf(layers)
  const H = new Float32Array(N * N)
  // 1 a wall, 2 a river.
  const cell = new Uint8Array(N * N)
  for (let c = 0; c < N * N; c++) {
    const x = cx(c)
    const z = cz(c)
    const h = (H[c] = ground(x, z))
    const level = lakeLevel(x, z)
    if (Math.abs(z) > zMax || Math.abs(x) > WORLD_HALF - 60 || (level !== null && h < level + 4 && surface(x, z) < level + 0.5)) cell[c] = 1
  }
  for (const r of layers.paths.toJSON('river')) {
    const s = layers.paths.drawnSamples(r.id)
    for (let k = 0; k < s.length; k += 4) {
      const reach = s[k + 3] * BANK + G / 2
      const i0 = toI(s[k])
      const j0 = toI(s[k + 2])
      const n = Math.ceil(reach / G)
      for (let j = Math.max(0, j0 - n); j <= Math.min(N - 1, j0 + n); j++) for (let i = Math.max(0, i0 - n); i <= Math.min(N - 1, i0 + n); i++) {
        const c = j * N + i
        if (cell[c] === 0 && Math.hypot(cx(c) - s[k], cz(c) - s[k + 2]) <= reach) cell[c] = 2
      }
    }
  }

  const g = new Float64Array(N * N)
  const came = new Int32Array(N * N)
  const stamp = new Int32Array(N * N)
  let sid = 0
  // The cheapest cell path from a to b inside box, or null.
  const route = (a, b, box) => {
    sid++
    const heap = new Heap(1024)
    const bx = cx(b)
    const bz = cz(b)
    g[a] = 0
    came[a] = -1
    stamp[a] = sid
    heap.push(Math.hypot(cx(a) - bx, cz(a) - bz), a)
    while (heap.n > 0) {
      const f = heap.f[0]
      const c = heap.pop()
      if (f - Math.hypot(cx(c) - bx, cz(c) - bz) > g[c] + 1e-6) continue
      if (c === b) {
        const path = []
        for (let p = b; p !== -1; p = came[p]) path.push(p)
        return path.reverse()
      }
      const i = c % N
      const j = (c - i) / N
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di
        const nj = j + dj
        if ((di === 0 && dj === 0) || ni < box.i0 || ni > box.i1 || nj < box.j0 || nj > box.j1) continue
        const n = nj * N + ni
        if (cell[n] === 1) continue
        const d = di !== 0 && dj !== 0 ? G * Math.SQRT2 : G
        const grade = Math.abs(H[n] - H[c]) / d
        if (grade > LINK.steep) continue
        const gn = g[c] + d * (1 + (grade / LINK.grade) ** 2) + (cell[n] === 2 && cell[c] !== 2 ? LINK.river : 0)
        if (stamp[n] === sid && gn >= g[n]) continue
        stamp[n] = sid
        g[n] = gn
        came[n] = c
        heap.push(gn + Math.hypot(cx(n) - bx, cz(n) - bz), n)
      }
    }
    return null
  }

  // Each site's candidate bearings, nearest neighbour first: [bearing, walk over straight distance].
  const cands = sites.map(() => [])
  const cellAt = (s) => toI(s.z) * N + toI(s.x)
  const bearingFrom = (s, path) => {
    for (const c of path) if (Math.hypot(cx(c) - s.x, cz(c) - s.z) >= LINK.read) return Math.atan2(cz(c) - s.z, cx(c) - s.x)
    const e = path.at(-1)
    return Math.atan2(cz(e) - s.z, cx(e) - s.x)
  }
  for (const { a, b, len } of neighbourPairs(sites)) {
    const A = sites[a]
    const B = sites[b]
    let path = null
    for (const pad of [Math.max(300, len * 0.5), Math.max(900, len * 1.2)]) {
      const box = { i0: toI(Math.min(A.x, B.x) - pad), i1: toI(Math.max(A.x, B.x) + pad), j0: toI(Math.min(A.z, B.z) - pad), j1: toI(Math.max(A.z, B.z) + pad) }
      path = route(cellAt(A), cellAt(B), box)
      if (path !== null) break
    }
    if (path === null) continue
    let walk = 0
    for (let k = 1; k < path.length; k++) walk += Math.hypot(cx(path[k]) - cx(path[k - 1]), cz(path[k]) - cz(path[k - 1]))
    cands[a].push([bearingFrom(A, path), walk / len])
    cands[b].push([bearingFrom(B, [...path].reverse()), walk / len])
  }
  return cands.map((list) => {
    const fit = list.filter(([, r]) => r <= LINK.over)
    const use = fit.length > 0 ? fit : list.length > 0 ? [list.reduce((p, q) => (q[1] < p[1] ? q : p))] : []
    const out = []
    for (const [t] of use) if (out.every((o) => Math.abs(Math.atan2(Math.sin(t - o), Math.cos(t - o))) >= apart)) out.push(t)
    return out
  })
}
