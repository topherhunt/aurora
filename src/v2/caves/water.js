// Where each pool's and sump's water actually lies (design/39-caves.md §5): the floor under its planned level flooded from the body's deepest point, and the shoreline as a grid the renderer and the walk both read.

const CELL = 0.5
// A body's home: its node's ellipse times HOME, or for a sump its line widened by SUMP_HOME and its ends' ellipses. Flooding past it, the water would spill down a passage; it stops a cell out instead of settling to the lip, because the planned level is what floats her past a dish's steep wall to a bank she can mantle onto (check-caves walks every exit, and fails with the water 0.1 m lower).
const HOME = 1.4
const SUMP_HOME = 2
// The water plane runs on to where the floor is TUCK over it, so its edge is under the shore's rock, not short of it.
const TUCK = 0.04
// Neighbouring columns are one shore only if both are air LIP over the higher floor: over a drop the water spills, under rock it is another passage.
const LIP = 0.1
const DEEP = 14

/**
 * Settles every pool and sump in `graph.pools` against the field: sets `shore` = { x0, z0, nx, nz, cell, s, floor }, s per grid corner being the floor's rise over level + TUCK: negative where the water reaches, the true rise on its shore, 0 in a wall, so the plane runs exactly into a wall corner. A pool a sump's water already covers takes the sump's level and shore null, so the two planes don't fight. Pure in the seed, so the worker and main thread settle the same water.
 */
export function settleWaters(graph, field) {
  for (const p of graph.pools) settle(p, graph, field)
  for (const sump of graph.pools) {
    if (sump.edge === undefined) continue
    for (const p of graph.pools) {
      if (p.node === undefined || p.shore === null) continue
      const n = graph.nodes[p.node]
      if (!wetAt(sump.shore, n.x, n.z)) continue
      p.level = sump.level
      p.shore = null
    }
  }
}

function settle(p, graph, field) {
  const homes = []
  let seed
  if (p.node !== undefined) {
    const n = graph.nodes[p.node]
    homes.push(ellipse(n, HOME))
    seed = [n.x, n.z]
  } else {
    const e = graph.edges[p.edge]
    homes.push(ellipse(graph.nodes[e.a], HOME), ellipse(graph.nodes[e.b], HOME), line(e.pts, SUMP_HOME))
    const dip = e.pts.reduce((a, b) => (b.y < a.y ? b : a))
    seed = [dip.x, dip.z]
  }
  const ref = p.level + 0.3
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const h of homes) { x0 = Math.min(x0, h.x0); x1 = Math.max(x1, h.x1); z0 = Math.min(z0, h.z0); z1 = Math.max(z1, h.z1) }
  x0 -= CELL; z0 -= CELL
  const nx = Math.ceil((x1 - x0) / CELL) + 2, nz = Math.ceil((z1 - z0) / CELL) + 2
  const floor = new Float32Array(nx * nz).fill(NaN)
  const key = new Float32Array(nx * nz).fill(Infinity)
  const done = new Uint8Array(nx * nz)
  const floorOf = (c) => {
    if (Number.isNaN(floor[c])) floor[c] = floorUnder(field, x0 + (c % nx) * CELL, z0 + Math.floor(c / nx) * CELL, ref)
    return floor[c]
  }
  const home = (c) => {
    const x = x0 + (c % nx) * CELL, z = z0 + Math.floor(c / nx) * CELL
    return homes.some((h) => h.has(x, z))
  }

  // Priority flood: each corner's key is the lowest water that reaches it from the seed, the highest floor on its best path.
  const heap = new Heap()
  const s0 = Math.round((seed[1] - z0) / CELL) * nx + Math.round((seed[0] - x0) / CELL)
  if (!(floorOf(s0) < p.level)) throw new Error(`settleWaters: ${p.node !== undefined ? `pool ${p.node}` : `sump ${p.edge}`} has no floor under its level at its deepest point`)
  key[s0] = floorOf(s0)
  heap.push(key[s0], s0)
  const level = p.level
  while (heap.size > 0) {
    const c = heap.pop()
    if (done[c]) continue
    if (key[c] >= level) break
    done[c] = 1
    if (!home(c)) continue
    const i = c % nx, k = Math.floor(c / nx)
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = k + dk
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue
      const d = b * nx + a
      const f = floorOf(d)
      if (!(f < Infinity) || !open(field, x0 + a * CELL, z0 + b * CELL, x0 + i * CELL, z0 + k * CELL, Math.max(f, floor[c]) + LIP)) continue
      const kd = Math.max(key[c], f)
      if (kd < key[d]) { key[d] = kd; heap.push(kd, d) }
    }
  }

  const s = new Float32Array(nx * nz)
  for (let c = 0; c < s.length; c++) {
    if (key[c] < level) s[c] = floor[c] - level - TUCK
    else if (Number.isNaN(floor[c])) s[c] = 1
    else if (floor[c] === Infinity) s[c] = 0
    else s[c] = Math.max(floor[c] - level - TUCK, 0)
  }
  p.shore = refine({ x0, z0, nx, nz, cell: CELL, s, floor }, field, level, ref)
}

// The shore at half the flood's cell: interpolated inside the water and on dry ground, sampled afresh only in the cells the shoreline crosses, where a dip between two corners would leave the plane's edge in the air.
function refine(sh, field, level, ref) {
  const NX = 2 * sh.nx - 1, NZ = 2 * sh.nz - 1, cell = sh.cell / 2
  const s = new Float32Array(NX * NZ), floor = new Float32Array(NX * NZ)
  const corners = [0, 0, 0, 0]
  for (let K = 0; K < NZ; K++) {
    for (let I = 0; I < NX; I++) {
      const C = K * NX + I
      const c0 = (K >> 1) * sh.nx + (I >> 1), di = I & 1, dk = (K & 1) * sh.nx
      corners[0] = c0; corners[1] = c0 + di; corners[2] = c0 + dk; corners[3] = c0 + dk + di
      let wet = 0, sum = 0, fsum = 0
      for (const c of corners) { if (sh.s[c] < 0) wet++; sum += sh.s[c]; fsum += sh.floor[c] }
      if (wet === 0 || wet === 4) {
        s[C] = sum / 4
        floor[C] = fsum / 4
        continue
      }
      const x = sh.x0 + I * cell, z = sh.z0 + K * cell
      const f = floorUnder(field, x, z, ref)
      floor[C] = f
      const reached = f < level && corners.some((c) => sh.s[c] < 0 && open(field, x, z, sh.x0 + (c % sh.nx) * sh.cell, sh.z0 + Math.floor(c / sh.nx) * sh.cell, Math.max(f, sh.floor[c]) + LIP))
      s[C] = reached ? f - level - TUCK : f === Infinity ? 0 : Math.max(f - level - TUCK, 0)
    }
  }
  return { x0: sh.x0, z0: sh.z0, nx: NX, nz: NZ, cell, s, floor }
}

function ellipse(n, k) {
  const c = Math.cos(n.rot), s = Math.sin(n.rot), rx = n.rx * k, rz = n.rz * k, r = Math.max(rx, rz)
  return {
    x0: n.x - r, x1: n.x + r, z0: n.z - r, z1: n.z + r,
    has(x, z) {
      const dx = x - n.x, dz = z - n.z
      const lx = (dx * c + dz * s) / rx, lz = (dz * c - dx * s) / rz
      return lx * lx + lz * lz <= 1
    },
  }
}

function line(pts, pad) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const q of pts) { x0 = Math.min(x0, q.x - q.w - pad); x1 = Math.max(x1, q.x + q.w + pad); z0 = Math.min(z0, q.z - q.w - pad); z1 = Math.max(z1, q.z + q.w + pad) }
  return {
    x0, x1, z0, z1,
    has(x, z) {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1]
        const ex = b.x - a.x, ez = b.z - a.z
        let u = ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)
        u = u < 0 ? 0 : u > 1 ? 1 : u
        if (Math.hypot(x - a.x - u * ex, z - a.z - u * ez) <= a.w + (b.w - a.w) * u + pad) return true
      }
      return false
    },
  }
}

function open(field, xa, za, xb, zb, y) {
  return field.at(xa, y, za) <= 0 && field.at(xb, y, zb) <= 0
}

// The floor of the first air under `ref` at (x, z), down through at most DEEP of rock; Infinity for a wall.
function floorUnder(field, x, z, ref) {
  let y = ref
  let v = field.at(x, y, z)
  while (v > 0) {
    y -= Math.max(0.05, v * 0.6)
    if (y < ref - DEEP) return Infinity
    v = field.at(x, y, z)
  }
  for (;;) {
    const y2 = y - Math.max(0.05, -v * 0.6)
    if (y2 < ref - 3 * DEEP) return -Infinity
    const v2 = field.at(x, y2, z)
    if (v2 > 0) return y2 + ((y - y2) * v2) / (v2 - v)
    y = y2
    v = v2
  }
}

/** Whether `shore`'s plane is drawn over (x, z): its corners' rise, bilinear, under 0. */
export function wetAt(shore, x, z) {
  const u = (x - shore.x0) / shore.cell, w = (z - shore.z0) / shore.cell
  const i = Math.floor(u), k = Math.floor(w)
  if (i < 0 || k < 0 || i + 1 >= shore.nx || k + 1 >= shore.nz) return false
  const fu = u - i, fw = w - k, s = shore.s, c = k * shore.nx + i
  const v = (s[c] * (1 - fu) + s[c + 1] * fu) * (1 - fw) + (s[c + shore.nx] * (1 - fu) + s[c + shore.nx + 1] * fu) * fw
  return v < 0
}

/** The water plane over `shore` at `level`: each grid cell clipped to where its corners' rise interpolates under 0, as { position, index }. */
export function shoreMesh(shore, level) {
  const { x0, z0, nx, nz, cell, s } = shore
  const pos = [], idx = []
  const poly = []
  for (let k = 0; k + 1 < nz; k++) {
    for (let i = 0; i + 1 < nx; i++) {
      const cs = [k * nx + i, k * nx + i + 1, (k + 1) * nx + i + 1, (k + 1) * nx + i]
      const xs = [i, i + 1, i + 1, i], zs = [k, k, k + 1, k + 1]
      if (cs.every((c) => s[c] >= 0)) continue
      poly.length = 0
      for (let j = 0; j < 4; j++) {
        const a = s[cs[j]], b = s[cs[(j + 1) % 4]]
        if (a < 0) poly.push(xs[j], zs[j])
        if (a < 0 !== b < 0) {
          const u = a / (a - b)
          poly.push(xs[j] + (xs[(j + 1) % 4] - xs[j]) * u, zs[j] + (zs[(j + 1) % 4] - zs[j]) * u)
        }
      }
      const base = pos.length / 3
      for (let j = 0; j < poly.length; j += 2) pos.push(x0 + poly[j] * cell, level, z0 + poly[j + 1] * cell)
      for (let j = 2; j < poly.length / 2; j++) idx.push(base, base + j - 1, base + j)
    }
  }
  return { position: new Float32Array(pos), index: idx }
}

// A min-heap of (key, corner) pairs, keyed by value at push: a corner is pushed again when its key drops, and the stale entry popped later is skipped as done.
class Heap {
  constructor() { this.k = []; this.c = [] }
  get size() { return this.k.length }
  push(key, v) {
    const K = this.k, C = this.c
    let i = K.length
    K.push(key); C.push(v)
    while (i > 0) {
      const j = (i - 1) >> 1
      if (K[j] <= key) break
      K[i] = K[j]; C[i] = C[j]; i = j
    }
    K[i] = key; C[i] = v
  }
  pop() {
    const K = this.k, C = this.c, top = C[0], lk = K.pop(), lc = C.pop()
    if (K.length > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= K.length) break
        const r = l + 1 < K.length && K[l + 1] < K[l] ? l + 1 : l
        if (K[r] >= lk) break
        K[i] = K[r]; C[i] = C[r]; i = r
      }
      K[i] = lk; C[i] = lc
    }
    return top
  }
}
