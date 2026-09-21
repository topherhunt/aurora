import { WORLD_SIZE } from '../v2/config.js'
import { DOC_VERSION, validate } from '../v2/layers/doc.js'
import { priorityFlood } from '../sim/hydrology.js'
import { Island, JITTER, rasterise } from './island.js'
import { buildBiomes, serialise } from './biomes.js'
import { runHydrology } from './hydrology.js'

// ---------------------------------------------------------------------------
// The v3 pipeline -- §31. Seed in, the coarse field and its layers document out, with the numbers the map page and the gate read off it.
//
// VERSION is the cache key's other half: bump it whenever a change to any stage would produce a different field for the same seed, or every client keeps drawing the island it generated last week.
// ---------------------------------------------------------------------------

export const VERSION = 'd1'
export const TEXELS = 1025
export const CELL = WORLD_SIZE / (TEXELS - 1)

// The rg16 encoding's range. Not the field's extremes -- those are measured -- but the metres a texel can hold, at 2.4 cm a step; the gate asserts the field stays inside it, because Heightmap.toPng clamps rather than throws.
export const MIN_Y = -600
export const MAX_Y = 1000

// Relief by scale: the rms of what a box blur of this radius removes, over land. Step B's target law is read off this table.
export const BLUR_RADII = [32, 128, 512, 2048]

/**
 * `generate({ seed, n = TEXELS, log, jitter })` -> { v, seed, n, cell, height, meta, doc, biomes, ground, stats, ms }
 *
 * `height` is the field in metres, row-major, `n` x `n` over the WORLD_SIZE box centred on the origin, after the hydrology has carved it; `meta` is what Heightmap.fromRaw wants beside it. `log` gets one line per stage. `jitter` overrides keys of JITTER for an experiment; the cache never sees an overridden field.
 *
 * The biomes are classed on the raw field and the carve reads its knobs from them; they are not reclassed afterwards, since the carve moves a few percent of the land by tens of metres and the classes are quantiles of the whole.
 */
export function generate({ seed, n = TEXELS, log = () => {}, jitter = null }) {
  if (!Number.isInteger(seed)) throw new Error(`generate: seed must be an integer, got ${seed}`)
  if (!Number.isInteger(n) || n < 3) throw new Error(`generate: n must be an integer >= 3, got ${n}`)
  const cell = WORLD_SIZE / (n - 1)
  const t0 = now()

  const island = new Island(seed, undefined, jitter ? { ...JITTER, ...jitter } : JITTER)
  const raw = rasterise(island, n, cell)
  const tMacro = now()
  log(`cone+jitter    ${ms(tMacro - t0)}  ${n}^2 at ${cell.toFixed(1)} m`)

  const biomes = buildBiomes(raw, n, cell, seed)
  const tBiomes = now()
  log(`biomes         ${ms(tBiomes - tMacro)}  ${biomes.stats.polygons} polygons, ${biomes.stats.vertices} vertices, rebuilt grid agrees ${(biomes.stats.agree * 100).toFixed(2)}%`)

  const hydro = runHydrology(raw, n, cell, biomes.grid)
  const height = hydro.height
  const tHydro = now()
  const hs = hydro.stats
  log(`hydrology      ${ms(tHydro - tBiomes)}  ${hs.lakes.count} lakes of ${hs.lakes.candidates} (${hs.lakes.km2.toFixed(2)} km2, ${hs.breach.dropped} cut away in ${hs.breach.rounds} rounds), ${hs.breach.channels} channels in ${hs.breach.passes} passes (deepest ${hs.breach.deepestCut.toFixed(0)} m), carved ${hs.carve.meanCut.toFixed(1)} m mean over ${hs.carve.cutKm2.toFixed(2)} km2, ${hs.rivers.count} rivers ${hs.rivers.km.toFixed(1)} km`)

  const stats = measure(height, n, cell, island)
  // The bowls are the raw field's: what the hydrology had to choose its lakes from and drain.
  stats.bowls = bowls(raw, n, cell)
  stats.biomes = biomes.stats
  stats.hydrology = hs
  const tStats = now()
  log(`instruments    ${ms(tStats - tHydro)}  land ${(stats.landFraction * 100).toFixed(1)}%, summit ${stats.summit.h.toFixed(0)} m, ${stats.bowls.count} bowls`)

  const doc = validate({
    v: DOC_VERSION,
    snow: { base: stats.snowLine, band: 60, points: [] },
    // The sea is one uncarved lake at y = 0 larger than the box, as the shipped world's ocean is (§18): its surface runs under the whole island and breaks it at the coast. The island's lakes follow it.
    lakes: [{ id: 'l1', x: 0, z: 0, y: 0, rx: 10000, rz: 10000, rot: 0, shape: 1, carve: 0, depth: 8 }, ...hydro.lakes.map((l, i) => ({ id: `l${i + 2}`, ...l }))],
    rivers: hydro.rivers.map((r, i) => ({ id: `r${i + 1}`, ...r })),
    roads: [],
  })

  const meta = { world: WORLD_SIZE, size: n, minY: MIN_Y, maxY: MAX_Y, encoding: 'rg16', exaggeration: 1, v3: VERSION, seed }
  // `biomes` is the drawn truth (polygons in world metres), `ground` the class grid rebuilt from it, which is what the mesher tints from.
  return { v: VERSION, seed, n, cell, height, meta, doc, biomes: serialise(biomes.polygons), ground: biomes.grid, stats, ms: now() - t0 }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const ms = (t) => `${t.toFixed(0)} ms`.padStart(8)

// --- instruments -------------------------------------------------------------

function measure(H, n, cell, island) {
  const size = n * n
  let land = 0
  let lo = Infinity
  let hi = -Infinity
  let hiAt = 0
  for (let c = 0; c < size; c++) {
    const h = H[c]
    if (!Number.isFinite(h)) throw new Error(`generate: texel ${c} is ${h}`)
    if (h > 0) land++
    if (h < lo) lo = h
    if (h > hi) {
      hi = h
      hiAt = c
    }
  }
  const half = ((n - 1) * cell) / 2
  const summit = { h: hi, x: (hiAt % n) * cell - half, z: Math.floor(hiAt / n) * cell - half }
  summit.offset = Math.hypot(summit.x, summit.z)

  // The height a seventh of the land lies above: where the snow line goes so v2's snow and the arctic class (the coldest seventh) roughly agree.
  const landHeights = new Float32Array(land)
  for (let c = 0, k = 0; c < size; c++) if (H[c] > 0) landHeights[k++] = H[c]
  landHeights.sort()
  const snowLine = landHeights[Math.floor((land * 6) / 7)]

  // The sea floor at the box edge (the outermost ring of texels) and one kilometre past the mean coast, so "keeps falling" is two numbers.
  let edgeSum = 0
  let edgeN = 0
  for (let i = 0; i < n; i++) {
    edgeSum += H[i] + H[(n - 1) * n + i]
    edgeN += 2
  }
  for (let j = 1; j < n - 1; j++) {
    edgeSum += H[j * n] + H[j * n + n - 1]
    edgeN += 2
  }
  const offshore = ringMean(island, island.macro.coastRadius + 1000, 256)

  return {
    landFraction: land / size,
    landKm2: (land * cell * cell) / 1e6,
    min: lo,
    max: hi,
    summit,
    snowLine,
    seaFloor: { offshore1km: offshore, boxEdge: edgeSum / edgeN },
    coast: coastIrregularity(H, n, cell, land),
    relief: reliefByScale(H, n, cell),
    bowls: bowls(H, n, cell),
  }
}

/** Mean of the macro field on a circle of radius `r` about the centre, `k` samples. */
function ringMean(island, r, k) {
  let s = 0
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2
    s += island.at(Math.cos(a) * r, Math.sin(a) * r)
  }
  return s / k
}

/**
 * The shoreline's length against the circumference of the circle holding the island's area: 1 for a disc, higher the more bays and headlands there are. The length is counted as sign changes between neighbouring texels, which over-reads a smooth curve by 4/pi, so the circle is measured the same way and the ratio is honest.
 */
function coastIrregularity(H, n, cell, land) {
  let crossings = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const wet = H[c] <= 0
      if (i + 1 < n && (H[c + 1] <= 0) !== wet) crossings++
      if (j + 1 < n && (H[c + n] <= 0) !== wet) crossings++
    }
  }
  const length = crossings * cell
  const area = land * cell * cell
  const circle = 8 * Math.sqrt(area / Math.PI)
  return { lengthKm: length / 1000, irregularity: length / circle }
}

function reliefByScale(H, n, cell) {
  const rows = []
  for (const radius of BLUR_RADII) {
    const B = boxBlur(H, n, Math.max(1, Math.round(radius / cell)))
    let s2 = 0
    let k = 0
    for (let c = 0; c < H.length; c++) {
      if (H[c] <= 0) continue
      const d = H[c] - B[c]
      s2 += d * d
      k++
    }
    rows.push({ radius, rms: k ? Math.sqrt(s2 / k) : 0 })
  }
  return rows
}

/** Separable box blur, edge-clamped, radius in texels. Two running sums, so a 256-texel radius costs the same as a 4. */
export function boxBlur(H, n, r) {
  const tmp = new Float32Array(n * n)
  const out = new Float32Array(n * n)
  const w = 2 * r + 1
  for (let j = 0; j < n; j++) {
    const row = j * n
    let s = 0
    for (let k = -r; k <= r; k++) s += H[row + clampI(k, n)]
    for (let i = 0; i < n; i++) {
      tmp[row + i] = s / w
      s += H[row + clampI(i + r + 1, n)] - H[row + clampI(i - r, n)]
    }
  }
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[clampI(k, n) * n + i]
    for (let j = 0; j < n; j++) {
      out[j * n + i] = s / w
      s += tmp[clampI(j + r + 1, n) * n + i] - tmp[clampI(j - r, n) * n + i]
    }
  }
  return out
}

const clampI = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i)

/**
 * Closed bowls on land: what a priority flood would pond more than a metre deep, grouped into connected bodies. This is the instrument for the basin term -- how many lakes step D will have to choose from, and how big -- and the sea floor's own fall to the box edge is what keeps the sea out of it.
 */
function bowls(H, n, cell) {
  const { filled } = priorityFlood(H, n)
  const size = n * n
  const label = new Int32Array(size)
  const stack = new Int32Array(size)
  const bodies = []
  for (let c = 0; c < size; c++) {
    if (label[c] || !(H[c] > 0) || filled[c] - H[c] <= 1) continue
    const id = bodies.length + 1
    let top = 0
    stack[top++] = c
    label[c] = id
    let cells = 0
    let deepest = 0
    let sumX = 0
    let sumZ = 0
    while (top > 0) {
      const k = stack[--top]
      cells++
      const depth = filled[k] - H[k]
      if (depth > deepest) deepest = depth
      const ki = k % n
      const kj = (k / n) | 0
      sumX += ki
      sumZ += kj
      for (let d = 0; d < 4; d++) {
        const ni = ki + (d === 0 ? 1 : d === 1 ? -1 : 0)
        const nj = kj + (d === 2 ? 1 : d === 3 ? -1 : 0)
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (label[nn] || !(H[nn] > 0) || filled[nn] - H[nn] <= 1) continue
        label[nn] = id
        stack[top++] = nn
      }
    }
    const half = ((n - 1) * cell) / 2
    bodies.push({ cells, km2: (cells * cell * cell) / 1e6, deepest, level: filled[c], x: (sumX / cells) * cell - half, z: (sumZ / cells) * cell - half })
  }
  bodies.sort((a, b) => b.cells - a.cells)
  const big = bodies.filter((b) => b.km2 >= 0.02)
  return {
    count: big.length,
    km2: big.reduce((s, b) => s + b.km2, 0),
    largest: big.length ? big[0] : null,
    bodies: big.slice(0, 12),
  }
}
