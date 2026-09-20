import { Noise } from '../sim/noise.js'
import { clamp01 } from '../sim/mathx.js'
import { boxBlur } from './generate.js'

// ---------------------------------------------------------------------------
// CLIMATE AND BIOMES -- §31 step C.
//
// Temperature from elevation and a north-south gradient across the box, moisture from a westerly that rains out as it climbs (the rain shadow falls out of the march, nothing draws it) plus the sea's own humidity near the coast; the seven classes by thresholds on the pair set at the land's own quantiles so each holds a seventh of it, their borders warped by noise; specks under a threshold given to their neighbours; the classes TRACED as polygons and the polygons rasterised back, so that what the mesher tints is what the document says and an edited polygon is all an editor will ever need to move.
//
// Three-free and DOM-free. The grid is 0..6 by BIOMES' order; the polygons are in world metres.
// ---------------------------------------------------------------------------

export const BIOMES = [
  // Linear RGB on the scale chunk-mesh-v2's palette uses (its grass is 0.048, 0.088, 0.03): the flat ground colour of each class until its props exist to tell it apart.
  { id: 'arctic', name: 'arctic', colour: [0.150, 0.160, 0.170], map: [196, 206, 214] },
  { id: 'forest', name: 'temperate forest', colour: [0.038, 0.084, 0.026], map: [56, 112, 48] },
  { id: 'plains', name: 'temperate plains', colour: [0.092, 0.108, 0.038], map: [150, 170, 70] },
  { id: 'jungle', name: 'humid jungle', colour: [0.018, 0.072, 0.020], map: [20, 90, 40] },
  { id: 'swamp', name: 'swamp', colour: [0.048, 0.062, 0.032], map: [86, 96, 56] },
  { id: 'canyon', name: 'dry canyon', colour: [0.140, 0.068, 0.034], map: [176, 96, 52] },
  { id: 'desert', name: 'desert', colour: [0.195, 0.165, 0.098], map: [222, 198, 130] },
]
const ARCTIC = 0
const FOREST = 1
const PLAINS = 2
const JUNGLE = 3
const SWAMP = 4
const CANYON = 5
const DESERT = 6

export const CLIMATE = {
  // Temperature, 0 cold .. 1 hot: `base` at sea level mid-box, `latitude` the swing from the north edge to the south, `lapse` metres of climb per unit lost, `noise` the amplitude at `noiseScale` metres.
  base: 0.56, latitude: 0.36, lapse: 1300, noise: 0.07, noiseScale: 1400,
  // The westerly: air arrives at the west edge holding `air`; over the sea it takes on `evap` of what it lacks per texel, over land it drops a share per metre of climb, `dry` per texel regardless. A texel's rain is what falls on it; its moisture is a blend of rain (smoothed over `rainBlur` metres) and the humidity of the air above it, plus `coast` of the sea's own damp within `coastBlur` metres of it.
  air: 1.0, evap: 0.012, uplift: 0.0025, dry: 0.0004, rainBlur: 300, coastBlur: 500, coast: 0.2, rainWeight: 40, humidWeight: 0.55,
  // The border warp: metres of displacement at this wavelength, read when a texel looks up its class.
  warp: 70, warpScale: 260,
  // Patches smaller than this many hectares are given to the class around them.
  speck: 6,
  // Douglas-Peucker tolerance for the traced polygons, metres.
  simplify: 10,
}

/** Temperature and moisture grids, each n x n in 0..1, from the height grid. */
export function climate(H, n, cell, seed, C = CLIMATE) {
  const half = ((n - 1) * cell) / 2
  const noise = new Noise(seed * 7 + 503)
  const T = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    const z = j * cell - half
    for (let i = 0; i < n; i++) {
      const x = i * cell - half
      const h = Math.max(0, H[j * n + i])
      const lat = z / half
      T[j * n + i] = clamp01(C.base + 0.5 * C.latitude * lat - h / C.lapse + C.noise * noise.simplex2(x / C.noiseScale, z / C.noiseScale))
    }
  }

  // The march, one row at a time from the west edge. `air` is the parcel's water; what it drops on a climb is this texel's rain.
  const rain = new Float32Array(n * n)
  const humid = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    let air = C.air
    let prev = 0
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const h = Math.max(0, H[c])
      let fall = 0
      if (H[c] <= 0) {
        air += C.evap * (1 - air)
      } else {
        const up = Math.max(0, h - prev)
        fall = air * Math.min(0.6, C.uplift * up + C.dry)
        air -= fall
      }
      rain[c] = fall
      humid[c] = air
      prev = h
    }
  }
  const rainS = boxBlur(rain, n, Math.round(C.rainBlur / cell))
  const sea = new Float32Array(n * n)
  for (let c = 0; c < n * n; c++) sea[c] = H[c] <= 0 ? 1 : 0
  const coast = boxBlur(sea, n, Math.round(C.coastBlur / cell))

  const M = new Float32Array(n * n)
  for (let c = 0; c < n * n; c++) M[c] = clamp01(C.humidWeight * humid[c] + C.rainWeight * rainS[c] + C.coast * coast[c])
  return { T, M }
}

/** The value `share` of the way up a sorted copy of `values`. */
function quantile(values, share) {
  if (values.length === 0) throw new Error('biomes.quantile: no values')
  const sorted = Float32Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
}

/**
 * The thresholds that give every class a seventh of the land: the coldest seventh is arctic, the next two sevenths temperate and split at their median moisture into plains and forest, the warmest four sevenths hot and split at their moisture quartiles into desert, canyon, jungle and swamp. Read off the land texels only -- the sea floor would otherwise be most of the field.
 */
export function thresholds(H, T, M) {
  const land = []
  for (let c = 0; c < H.length; c++) if (H[c] > 0) land.push(c)
  const tLand = land.map((c) => T[c])
  const tArctic = quantile(tLand, 1 / 7)
  const tHot = quantile(tLand, 3 / 7)
  const mTemperate = []
  const mHot = []
  for (const c of land) {
    if (T[c] < tArctic) continue
    if (T[c] < tHot) mTemperate.push(M[c])
    else mHot.push(M[c])
  }
  return {
    tArctic,
    tHot,
    mForest: quantile(mTemperate, 0.5),
    mHot: [quantile(mHot, 0.25), quantile(mHot, 0.5), quantile(mHot, 0.75)],
  }
}

/** One texel's class from its temperature and moisture against the island's thresholds. */
export function classify(t, m, q) {
  if (t < q.tArctic) return ARCTIC
  if (t < q.tHot) return m < q.mForest ? PLAINS : FOREST
  if (m < q.mHot[0]) return DESERT
  if (m < q.mHot[1]) return CANYON
  return m < q.mHot[2] ? JUNGLE : SWAMP
}

/** The class grid: every texel classified at a noise-warped position, then specks given to their surroundings. */
export function classGrid(H, T, M, n, cell, seed, C = CLIMATE) {
  const half = ((n - 1) * cell) / 2
  const wx = new Noise(seed * 7 + 509)
  const wz = new Noise(seed * 7 + 511)
  const q = thresholds(H, T, M)
  const grid = new Uint8Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i * cell - half
      const z = j * cell - half
      const dx = (C.warp * wx.simplex2(x / C.warpScale, z / C.warpScale)) / cell
      const dz = (C.warp * wz.simplex2(x / C.warpScale + 4.1, z / C.warpScale - 2.6)) / cell
      const si = Math.max(0, Math.min(n - 1, Math.round(i + dx)))
      const sj = Math.max(0, Math.min(n - 1, Math.round(j + dz)))
      const s = sj * n + si
      grid[j * n + i] = classify(T[s], M[s], q)
    }
  }
  despeckle(grid, n, Math.round((C.speck * 1e4) / (cell * cell)))
  return grid
}

// Four-connected components under `minCells` texels are relabelled to the class most of their border touches. One pass, largest neighbour wins; a speck inside a speck is handled by the second being relabelled after the first, in scan order.
function despeckle(grid, n, minCells) {
  const size = n * n
  const seen = new Uint8Array(size)
  const stack = new Int32Array(size)
  const cells = new Int32Array(size)
  const border = new Int32Array(BIOMES.length)
  for (let start = 0; start < size; start++) {
    if (seen[start]) continue
    const cls = grid[start]
    let top = 0
    let count = 0
    stack[top++] = start
    seen[start] = 1
    border.fill(0)
    while (top > 0) {
      const k = stack[--top]
      cells[count++] = k
      const ki = k % n
      const kj = (k / n) | 0
      for (let d = 0; d < 4; d++) {
        const ni = ki + (d === 0 ? 1 : d === 1 ? -1 : 0)
        const nj = kj + (d === 2 ? 1 : d === 3 ? -1 : 0)
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (grid[nn] !== cls) {
          border[grid[nn]]++
          continue
        }
        if (seen[nn]) continue
        seen[nn] = 1
        stack[top++] = nn
      }
    }
    if (count >= minCells) continue
    let best = -1
    let bestN = 0
    for (let b = 0; b < border.length; b++) if (border[b] > bestN) { bestN = border[b]; best = b }
    if (best < 0) continue
    for (let k = 0; k < count; k++) grid[cells[k]] = best
  }
}

/**
 * Trace every class as closed loops by marching squares over the texel centres, simplified. Returns [{ cls, pts: [[x, z], ...] }] in world metres; a class's holes are its own loops, so an even-odd fill of all its loops together is exact.
 */
export function trace(grid, n, cell, tolerance) {
  const half = ((n - 1) * cell) / 2
  const polygons = []
  for (let cls = 0; cls < BIOMES.length; cls++) {
    const loops = marchingSquares(grid, n, cls)
    for (const loop of loops) {
      const pts = simplifyLoop(loop.map(([i, j]) => [i * cell - half, j * cell - half]), tolerance)
      if (pts.length >= 3) polygons.push({ cls, pts })
    }
  }
  return polygons
}

// Loops in texel units, vertices on edge midpoints. Cells run one past the grid on every side with the outside read as not-this-class, so a class touching the box edge still closes.
function marchingSquares(grid, n, cls) {
  const inside = (i, j) => (i >= 0 && j >= 0 && i < n && j < n && grid[j * n + i] === cls ? 1 : 0)
  // Edge ids: the horizontal edge between texels (i, j) and (i + 1, j) is 2 * key, the vertical between (i, j) and (i, j + 1) is 2 * key + 1, with key offset so i, j = -1 stays positive.
  const key = (i, j) => (j + 1) * (n + 2) + (i + 1)
  const hEdge = (i, j) => 2 * key(i, j)
  const vEdge = (i, j) => 2 * key(i, j) + 1
  const segs = []
  for (let j = -1; j < n; j++) {
    for (let i = -1; i < n; i++) {
      const code = inside(i, j) | (inside(i + 1, j) << 1) | (inside(i + 1, j + 1) << 2) | (inside(i, j + 1) << 3)
      if (code === 0 || code === 15) continue
      const T = hEdge(i, j)
      const B = hEdge(i, j + 1)
      const L = vEdge(i, j)
      const R = vEdge(i + 1, j)
      switch (code) {
        case 1: case 14: segs.push([L, T]); break
        case 2: case 13: segs.push([T, R]); break
        case 3: case 12: segs.push([L, R]); break
        case 4: case 11: segs.push([R, B]); break
        case 5: segs.push([L, T], [R, B]); break
        case 6: case 9: segs.push([T, B]); break
        case 7: case 8: segs.push([L, B]); break
        case 10: segs.push([T, R], [B, L]); break
      }
    }
  }
  // Link: every edge point meets exactly two segments, so walking from any unused segment returns to its start.
  const at = new Map()
  for (let s = 0; s < segs.length; s++) {
    for (const e of segs[s]) {
      const list = at.get(e)
      if (list) list.push(s)
      else at.set(e, [s])
    }
  }
  const point = (e) => {
    const k = e >> 1
    const i = (k % (n + 2)) - 1
    const j = Math.floor(k / (n + 2)) - 1
    return e & 1 ? [i, j + 0.5] : [i + 0.5, j]
  }
  const used = new Uint8Array(segs.length)
  const loops = []
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue
    const loop = []
    let s = s0
    let e = segs[s0][0]
    while (!used[s]) {
      used[s] = 1
      loop.push(point(e))
      const next = segs[s][0] === e ? segs[s][1] : segs[s][0]
      const pair = at.get(next)
      if (pair.length !== 2) throw new Error(`marchingSquares: edge point ${next} meets ${pair.length} segments`)
      s = pair[0] === s ? pair[1] : pair[0]
      e = next
    }
    loops.push(loop)
  }
  return loops
}

// Douglas-Peucker on a closed loop: split at the two points furthest apart, simplify each arc, join.
function simplifyLoop(pts, tol) {
  if (pts.length < 4) return pts
  let a = 0
  let b = 0
  let far = -1
  for (let k = 1; k < pts.length; k++) {
    const d = (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2
    if (d > far) { far = d; b = k }
  }
  const arc1 = simplifyArc(pts.slice(a, b + 1), tol)
  const arc2 = simplifyArc(pts.slice(b).concat([pts[0]]), tol)
  return arc1.concat(arc2.slice(1, -1))
}

function simplifyArc(pts, tol) {
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [lo, hi] = stack.pop()
    if (hi - lo < 2) continue
    const [ax, az] = pts[lo]
    const [bx, bz] = pts[hi]
    const dx = bx - ax
    const dz = bz - az
    const len2 = dx * dx + dz * dz
    let worst = -1
    let at = -1
    for (let k = lo + 1; k < hi; k++) {
      const [px, pz] = pts[k]
      let d2
      if (len2 === 0) d2 = (px - ax) ** 2 + (pz - az) ** 2
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2))
        d2 = (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2
      }
      if (d2 > worst) { worst = d2; at = k }
    }
    if (worst > tol2) {
      keep[at] = 1
      stack.push([lo, at], [at, hi])
    }
  }
  const out = []
  for (let k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k])
  return out
}

/**
 * The class grid from the polygons: each class's loops filled even-odd in class order, later classes over earlier, and the slivers the simplification leaves between neighbours taken by whichever painted texel is nearest.
 */
export function rasterise(polygons, n, cell) {
  const half = ((n - 1) * cell) / 2
  const grid = new Uint8Array(n * n).fill(255)
  const rows = new Array(n)
  for (let cls = 0; cls < BIOMES.length; cls++) {
    for (let j = 0; j < n; j++) rows[j] = null
    for (const poly of polygons) {
      if (poly.cls !== cls) continue
      const pts = poly.pts
      for (let k = 0; k < pts.length; k++) {
        const [x0, z0] = pts[k]
        const [x1, z1] = pts[(k + 1) % pts.length]
        const j0 = (z0 + half) / cell
        const j1 = (z1 + half) / cell
        if (j0 === j1) continue
        const lo = Math.min(j0, j1)
        const hi = Math.max(j0, j1)
        // Half-open in j so a vertex on a scanline is counted once.
        for (let j = Math.max(0, Math.ceil(lo)); j < hi && j < n; j++) {
          const t = (j - j0) / (j1 - j0)
          const x = (x0 + t * (x1 - x0) + half) / cell
          if (!rows[j]) rows[j] = []
          rows[j].push(x)
        }
      }
    }
    for (let j = 0; j < n; j++) {
      const xs = rows[j]
      if (!xs) continue
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k]))
        const i1 = Math.min(n, Math.ceil(xs[k + 1]))
        for (let i = i0; i < i1; i++) grid[j * n + i] = cls
      }
    }
  }
  // Unpainted texels take a painted four-neighbour, in passes, until none are left.
  let left = 0
  for (let c = 0; c < n * n; c++) if (grid[c] === 255) left++
  for (let pass = 0; left > 0 && pass < 64; pass++) {
    const prev = grid.slice()
    left = 0
    for (let c = 0; c < n * n; c++) {
      if (prev[c] !== 255) continue
      const i = c % n
      const j = (c / n) | 0
      const take = (i > 0 && prev[c - 1] !== 255) ? prev[c - 1] : (i < n - 1 && prev[c + 1] !== 255) ? prev[c + 1] : (j > 0 && prev[c - n] !== 255) ? prev[c - n] : (j < n - 1 && prev[c + n] !== 255) ? prev[c + n] : 255
      grid[c] = take
      if (take === 255) left++
    }
  }
  if (left > 0) throw new Error(`biomes.rasterise: ${left} texels lie in no polygon`)
  return grid
}

/** The whole of step C: climate, classes, polygons and the grid rebuilt from them. `agree` is the share of texels the rebuilt grid gives the same class the traced one had. */
export function buildBiomes(H, n, cell, seed, C = CLIMATE) {
  const { T, M } = climate(H, n, cell, seed, C)
  const traced = classGrid(H, T, M, n, cell, seed, C)
  const polygons = trace(traced, n, cell, C.simplify)
  const grid = rasterise(polygons, n, cell)
  let same = 0
  for (let c = 0; c < n * n; c++) if (grid[c] === traced[c]) same++
  const share = new Float64Array(BIOMES.length)
  let land = 0
  for (let c = 0; c < n * n; c++) {
    if (H[c] <= 0) continue
    land++
    share[grid[c]]++
  }
  return {
    T,
    M,
    polygons,
    grid,
    stats: {
      agree: same / (n * n),
      vertices: polygons.reduce((s, p) => s + p.pts.length, 0),
      polygons: polygons.length,
      landShare: Array.from(share, (s) => (land ? s / land : 0)),
    },
  }
}

/** The polygons as they ride in the cache and, later, a document: cls and a flat [x, z, x, z, ...] rounded to the decimetre. */
export function serialise(polygons) {
  return polygons.map((p) => ({ cls: p.cls, pts: p.pts.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]) }))
}

export function deserialise(list) {
  if (!Array.isArray(list)) throw new Error('biomes.deserialise: expected an array of polygons')
  return list.map((p, k) => {
    if (!Number.isInteger(p.cls) || p.cls < 0 || p.cls >= BIOMES.length) throw new Error(`biomes.deserialise: polygon ${k} has class ${p.cls}`)
    if (!Array.isArray(p.pts) || p.pts.length < 6 || p.pts.length % 2) throw new Error(`biomes.deserialise: polygon ${k} has ${p.pts?.length} coordinates`)
    const pts = []
    for (let i = 0; i < p.pts.length; i += 2) pts.push([p.pts[i], p.pts[i + 1]])
    return { cls: p.cls, pts }
  })
}
