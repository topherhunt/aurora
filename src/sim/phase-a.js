import { TerrainHeight, WORLD_SIZE } from './terrain-height.js'
import { Noise } from './noise.js'
import { clamp, clamp01, smoothstep } from './mathx.js'
import { GRID_N, CELL, NB_DI, NB_DJ, NB_DIST, sampleElevation, gridSlope } from './world-grid.js'
import { priorityFlood, flowDirections, flowAccumulation, distanceTo, breachDepressions } from './hydrology.js'

// ---------------------------------------------------------------------------
// Phase A: the global pass (§2). Runs once at load, in a Web Worker, on the
// 2048^2 sim grid. Produces the skeleton of the world -- where water is, how wet
// each place is, what grows there, where the villages go, and whether any of it
// can actually be walked to.
//
// Nothing here renders. Nothing here imports three.js. §1's porting escape hatch
// says the sim layer has to survive being lifted into Godot, and this is the
// largest piece of it.
//
// WHAT THIS ROUND DOES AND DOES NOT DO with §2 step 4, channel carving:
//
// It DOES carve, at grid resolution, and it has to. Measured on this terrain,
// 43% of the map has no downhill path to the map edge -- fbm has as many closed
// bowls as it has peaks and nothing has ever eroded them -- so without cutting
// outlets there is no flow to route and no river network to compute. The carved
// surface is returned as `elev`; the raw analytic surface is returned alongside
// it as `base`, and their difference is the carve delta.
//
// It does NOT write that delta back into TerrainHeight. `heightAt` is still a
// pure function of the noise stack, every existing gate still measures the
// surface it has always measured, and nothing the player walks on has moved.
// Applying the delta per chunk is Phase B's job (§2: "Interpolate the global
// grid, add high-frequency detail noise, apply carved channels") and it is a
// pass of its own, because it needs the D8 path splined and given a channel
// profile before it touches a 0.5 m heightmap. Until then the streams computed
// here are correct routes over a surface the renderer does not yet show.
// ---------------------------------------------------------------------------

// The spawn band, hoisted here because main.js makes the same decision and two
// implementations of one decision is how this project has broken its own
// instruments ten times (§14). Phase A is the owner; main.js should consume
// these rather than restate them.
export const SPAWN = {
  minElev: 85, // valley floor, above the lowest ground
  maxElev: 140, // below the mean snow line, so she starts on green
  maxSlope: (15 * Math.PI) / 180,
  searchRadius: 3000,
}

export const BREACH = {
  // Square metres of standing water a basin may keep. See breachDepressions for
  // why this is the knob and why two more obvious knobs are not.
  //
  // ZERO -- a fully drained world -- and that is a real decision, not a default
  // nobody looked at. Measured on seed 20260804 at 1024^2:
  //
  //     maxLakeArea   water%   bodies   biggest   passes to converge
  //          0 km^2    0.05%      546    0.001      6
  //       0.02          11.9    17104    0.020     16+ (did not converge)
  //       0.05          15.0    16219    0.050     16+
  //       0.12          18.7    15326    0.120     16+
  //       0.25          22.6    14455    0.245     16+
  //       0.60          27.1    13530    0.565     16+
  //
  // Every non-zero setting leaves thirteen to seventeen THOUSAND ponds, because
  // a basin under the cap is kept whole and this terrain has ten thousand small
  // basins. Twelve percent of the map as water is enough to saturate the
  // distance-to-water field, which collapses the moisture range, which collapses
  // §2's five biomes into two. So the lakes are not merely ugly at that setting,
  // they take the biome system with them.
  //
  // Zero gives the world §2, §6 and §11 actually describe: river valleys,
  // villages sited on them, streams as ribbon meshes. The cost is that there are
  // then no lakes at all, and §11's flat lake planes have nothing to render.
  // The right fix for that is DELIBERATE ponding -- pick N good basins and dam
  // them -- rather than keeping whatever the fill happens to leave behind, and
  // that is a follow-up rather than a knob.
  maxLakeArea: 0,
  maxLakeDepth: 60,
  maxCut: 200,
  maxLength: 2500,
  // Safety stop, not a target. Least-cost routing converges in 13 at
  // maxLakeArea 0 (the spanning-tree router took 6, and drew straight lines);
  // the last six passes cut fewer than 25 channels each while the basin count
  // oscillates by a dozen, because cutting a channel can carve a new pinhole
  // depression beside it. Set at 20 so a slightly different seed has room.
  passes: 20,
}

export const LAKE = {
  minDepth: 1.5, // metres of fill before a raised cell counts as water rather than a smoothed dimple
  minCells: 8, // ~512 m^2. Smaller ponds are below the resolution that a flat water plane can honestly represent
}

export const STREAM = {
  // Cells of upslope drainage before a channel exists. 2500 cells x 64 m^2 =
  // 0.16 km^2 of catchment, which is roughly where real channels initiate.
  // §2 calls this "a single tunable, tune it by eye" -- the map view is the eye.
  minAcc: 2500,
  widthAtMin: 1.2, // metres
  maxWidth: 14,
}

export const MOISTURE = {
  // 250 m rather than 420. In a fully drained world 2.4% of cells are stream, so
  // almost all valley floor sits within a few hundred metres of running water --
  // at 420 m the proximity term was near 1 across every valley in the map, which
  // made "low and dry" impossible and left §2's heather band at 1% of the world.
  // The riparian strip really is narrow; the field should say so.
  reach: 250, // e-folding distance from water, metres
  nearWater: 0.55, // how much of the field proximity-to-water can account for
  regional: 0.45, // amplitude of the low-frequency wet/dry regions
  regionalFreq: 0.00035, // ~2.9 km at SHRINK 2
  // 0.3 is a floor, not a preference. Lowering it wets the high ground and turns
  // bare rock into pine, which the map wants -- but "low" is a smoothstep, so it
  // also wets the mid-elevation cells that are the only ones heather can live on.
  // Measured: 0.30 -> bare 44 / pine 10 / heath 3; 0.25 -> 40/13/2; 0.20 -> 37/17/2.
  // Heather falls below the 2% gate before pine gets interesting. The real fix is
  // more low ground, not more knob, so this stays where the five bands survive.
  altitudeDry: 0.3, // how much altitude alone dries a place out
  base: 0.3, // dry by default; water and the regional belts are what add to it
}

// Biome ids. Five bands, straight out of §2's table. Kept as small integers
// because the grid stores one Uint8 layer of them; the *blend* between them is
// not stored -- see biomeWeights.
export const BIOME = {
  BARE: 0, // high + dry: rock, snow, sparse windswept pines
  PINE: 1, // high + moist: dense pine
  MIXED: 2, // mid: pine and scrub, heather
  HEATH: 3, // low + dry: heather, scrub brush, exposed rock
  LUSH: 4, // low + moist: river valleys, broadleaf, tall grass
}
export const BIOME_NAMES = ['bare', 'pine', 'mixed', 'heath', 'lush']

export const BIOME_TUNING = {
  // "High" and "low" are measured against the LOCAL snow line, not an absolute
  // elevation, because the snow line is a field with 43 m of swing across the
  // map (§14 step 2). An absolute band would put one region's treeline halfway
  // up its mountains and another's underground.
  // Set from the measured distribution of (elevation - local snow line), not by
  // eye: p05 -76 m, p25 -42, p50 -11, p75 +26, p90 +61, and the whole field
  // bottoms out at -124. The first pass used -150/-20 and produced ZERO low
  // ground anywhere on the map, because -150 is below the world's minimum: two
  // of §2's five biomes could not exist and the gate said so.
  lowEdge: -95, // metres relative to the local snow line: below this is unambiguously "low"
  highEdge: 5, // above this is unambiguously "high"
  dryEdge: 0.38, // moisture below this is "dry"
  wetEdge: 0.62, // above this is "moist"
  // §2: "Perturb the biome lookup with low-frequency noise so borders wander
  // instead of following clean contour lines." This perturbs the *inputs*, which
  // is what makes the border wander rather than merely get noisy.
  jitterFreq: 0.0016, // ~570 m at SHRINK 2
  jitterElev: 28, // metres
  jitterMoist: 0.1,
}

export const VILLAGE = {
  count: 6, // how many to try for
  minSeparation: 1400, // metres between sites
  maxSlope: (9 * Math.PI) / 180, // buildable ground
  maxWaterDist: 260, // metres to fresh water -- a village is on a river for a reason
  minElev: 45,
  // Must sit this far under the LOCAL snow line. 90 m looked reasonable and was
  // not: the snow line runs 127-170 m, so it admitted only ground below ~58 m,
  // which is under the 5th percentile of the whole world. Every village landed
  // on the absolute floor of the map, all six in the same southern corner.
  elevBelowSnow: 25,
  openRef: (20 * Math.PI) / 180, // the slope at which surrounding ground stops reading as open
  edgeMargin: 900, // metres of world edge to stay out of
}

const MAX_WALK_SLOPE = (38 * Math.PI) / 180 // §4

/**
 * Run the whole global pass.
 *
 * `n` exists so the check script and the map view can run a 512^2 or 1024^2
 * version in a second instead of five. Everything scales: CELL is derived, and
 * every constant above is in metres or dimensionless, never in cells -- except
 * LAKE.minCells and STREAM.minAcc, which are areas in cells and therefore have
 * to be rescaled. They are, below, and that rescaling is the single easiest
 * thing in this file to get wrong.
 */
export function runPhaseA(seed, n = GRID_N, log = () => {}) {
  const th = new TerrainHeight(seed)
  const cell = WORLD_SIZE / n
  const size = n * n
  // Areas are in cells, so a coarser grid needs proportionally fewer of them to
  // mean the same square metres.
  const areaScale = (CELL * CELL) / (cell * cell)
  const minAcc = STREAM.minAcc * areaScale
  const minLakeCells = Math.max(2, Math.round(LAKE.minCells * areaScale))

  const t0 = now()
  const base = sampleElevation(th, n)
  log(`elevation      ${ms(t0)}  ${n}^2 samples`)

  // --- 2+4. breach, then fill the residue -----------------------------------
  //
  // Order matters and it is the opposite of §2's numbering. Carving is listed as
  // step 4, after routing, because the mental model is "route the water, then
  // cut where it runs". But on uneroded fbm you cannot route anything first:
  // 43% of this map has no downhill path to the edge at all, and routing a
  // surface like that produces a network of ten thousand disconnected puddles.
  // The cut has to come first, and then the routing is over a surface that
  // actually drains.
  const t1 = now()
  let elev = base
  let passes = 0
  let deepestCut = 0
  let totalBreached = 0
  let refused = 0
  for (let p = 0; p < BREACH.passes; p++) {
    const c = breachDepressions(elev, n, cell, BREACH)
    elev = c.elev
    passes++
    totalBreached += c.breached
    refused = c.refused
    // Across passes, not within one. The last pass is by definition the one that
    // cut nothing, so reporting its figure reports 0 m every time.
    if (c.deepestCut > deepestCut) deepestCut = c.deepestCut
    if (c.breached === 0) break
  }
  const breach = { passes, breached: totalBreached, refused, deepestCut }
  log(`breach         ${ms(t1)}  ${passes} passes, ${totalBreached} channels, deepest cut ${deepestCut.toFixed(0)}m`)

  const t1b = now()
  let { filled, order, tree } = priorityFlood(elev, n)
  log(`priority-flood ${ms(t1b)}`)

  // --- 3. flow routing + accumulation ---------------------------------------
  const t2 = now()
  const recv = flowDirections(filled, tree, n)
  tree = null // the spanning tree has done its job; 16 MB back
  const acc = flowAccumulation(recv, order, size)
  order = null
  log(`flow routing   ${ms(t2)}`)

  // --- lakes ----------------------------------------------------------------
  //
  // priorityFlood raises anything it floods, which at 2048^2 is 44% of the map
  // -- almost all of it by millimetres, because fractal noise has a local
  // minimum every few cells. Those are not lakes, they are the roughness of the
  // field. A lake needs depth AND area, and both filters are load-bearing:
  // without depth you get 1.8M "water" cells, without area you get ten thousand
  // puddles each needing its own flat plane and draw call (§11).
  const t3 = now()
  const lake = new Uint8Array(size)
  for (let c = 0; c < size; c++) if (filled[c] - elev[c] >= LAKE.minDepth) lake[c] = 1
  const lakes = labelLakes(lake, filled, elev, n, cell, minLakeCells)
  log(`lakes          ${ms(t3)}  ${lakes.length} bodies`)

  // --- streams --------------------------------------------------------------
  //
  // A stream cell is one with enough catchment that is not inside a lake. The
  // second half matters: without it, every lake fills solid with "stream"
  // because accumulation keeps climbing across the flat surface, and the map
  // view shows rivers running through the middle of ponds.
  const stream = new Uint8Array(size)
  let streamCells = 0
  for (let c = 0; c < size; c++) {
    if (acc[c] >= minAcc && !lake[c]) {
      stream[c] = 1
      streamCells++
    }
  }

  // --- 5. moisture ----------------------------------------------------------
  const t4 = now()
  const water = new Uint8Array(size)
  for (let c = 0; c < size; c++) water[c] = lake[c] | stream[c]
  let dist = distanceTo(water, n, cell)
  const nMoist = new Noise(seed + 907)
  const moisture = new Float32Array(size)
  const snowLine = new Float32Array(size) // reused by the biome pass and worth the 16 MB
  for (let j = 0; j < n; j++) {
    const z = -WORLD_SIZE / 2 + (j + 0.5) * cell
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const x = -WORLD_SIZE / 2 + (i + 0.5) * cell
      const sl = th.snowLineAt(x, z)
      snowLine[c] = sl
      const near = Math.exp(-dist[c] / MOISTURE.reach)
      // Regional wet and dry belts. This -- not altitude -- is what splits §2's
      // "high + dry" from "high + moist"; if altitude alone decided moisture,
      // two of the five biome bands could never coexist and the table would
      // collapse to three.
      const region = nMoist.simplex2(x * MOISTURE.regionalFreq, z * MOISTURE.regionalFreq)
      // Altitude dries a place out, but only weakly, and measured against the
      // local snow line rather than sea level.
      const high = clamp01((elev[c] - (sl - 170)) / 190)
      moisture[c] = clamp01(MOISTURE.base + MOISTURE.nearWater * near + MOISTURE.regional * region - MOISTURE.altitudeDry * high)
    }
  }
  dist = null
  log(`moisture       ${ms(t4)}`)

  // --- biomes ---------------------------------------------------------------
  const t5 = now()
  const nJit = new Noise(seed + 1319)
  const biome = new Uint8Array(size)
  const biomeArea = new Int32Array(5)
  for (let j = 0; j < n; j++) {
    const z = -WORLD_SIZE / 2 + (j + 0.5) * cell
    for (let i = 0; i < n; i++) {
      const c = j * n + i
      const x = -WORLD_SIZE / 2 + (i + 0.5) * cell
      const b = dominantBiome(elev[c], moisture[c], snowLine[c], x, z, nJit)
      biome[c] = b
      biomeArea[b]++
    }
  }
  log(`biomes         ${ms(t5)}`)

  // --- 6. village siting ----------------------------------------------------
  const t6 = now()
  const spawn = findSpawn(th, elev, n, cell)
  const villages = siteVillages(elev, filled, lake, water, moisture, snowLine, acc, n, cell, minAcc)
  log(`villages       ${ms(t6)}  ${villages.length} sites`)

  // --- 7. connectivity ------------------------------------------------------
  const t7 = now()
  const summit = findSummit(elev, n, cell)
  const conn = connectivity(elev, lake, filled, n, cell, spawn, [...villages, summit])
  log(`connectivity   ${ms(t7)}  ${(conn.reachableFraction * 100).toFixed(1)}% reachable`)

  return {
    seed,
    n,
    cell,
    base, // the raw analytic surface, before breaching
    elev, // the carved surface: what Phase B must reproduce per chunk
    breach,
    filled,
    acc,
    recv,
    lake,
    lakes,
    stream,
    streamCells,
    water,
    moisture,
    snowLine,
    biome,
    biomeArea,
    spawn,
    summit,
    villages,
    reachable: conn.reachable,
    reachableFraction: conn.reachableFraction,
    unreachable: conn.unreachable,
    ms: ms(t0, true),
  }
}

/**
 * Blended biome weights at a point, for consumers that want a mix rather than a
 * label -- prop density, ground colour, grass species.
 *
 * These are deliberately NOT stored on the grid. Five float layers is 84 MB on
 * top of a pass already budgeted at ~100 MB, and every consumer works at a finer
 * resolution than 8 m anyway, so a stored blend would be upsampled garbage. The
 * grid stores the two *inputs* (elevation, moisture); the blend is a pure
 * function evaluated wherever it is needed, at whatever resolution is needed.
 *
 * `out` is a 5-array, written in place and returned, so scatter loops can run
 * without allocating.
 */
export function biomeWeights(h, moist, snowLine, x, z, jitterNoise, out = new Array(5)) {
  const T = BIOME_TUNING
  const jx = x * T.jitterFreq
  const jz = z * T.jitterFreq
  const he = h + jitterNoise.simplex2(jx, jz) * T.jitterElev
  const mo = moist + jitterNoise.simplex2(jx + 71.3, jz - 18.9) * T.jitterMoist

  // One axis for altitude, one for wetness, both soft. `mid` is what is left
  // over between low and high rather than its own band -- that keeps the three
  // altitude weights summing to exactly 1 with no third smoothstep to keep in
  // sync.
  const rel = he - snowLine
  const wHigh = smoothstep(T.lowEdge, T.highEdge, rel)
  const wLow = 1 - wHigh
  const wWet = smoothstep(T.dryEdge, T.wetEdge, mo)
  const wDry = 1 - wWet
  // "Mid" is the band where the altitude signal is genuinely ambiguous. Peaked
  // at the midpoint of the low/high ramp, zero at either end.
  const mid = 4 * wHigh * wLow

  out[BIOME.BARE] = wHigh * wDry * (1 - mid)
  out[BIOME.PINE] = wHigh * wWet * (1 - mid)
  out[BIOME.MIXED] = mid
  out[BIOME.HEATH] = wLow * wDry * (1 - mid)
  out[BIOME.LUSH] = wLow * wWet * (1 - mid)
  return out
}

const _w = new Array(5)
function dominantBiome(h, moist, snowLine, x, z, jitterNoise) {
  biomeWeights(h, moist, snowLine, x, z, jitterNoise, _w)
  let best = 0
  for (let k = 1; k < 5; k++) if (_w[k] > _w[best]) best = k
  return best
}

/**
 * Connected components of the lake mask, with an area filter.
 *
 * Returns one record per surviving body: cell count, surface level, and a
 * centre. The level is `filled` at any member cell -- priority-flood makes the
 * whole body flat by construction, so there is nothing to average and §11's "one
 * flat plane per body at the spill elevation" is literally a lookup.
 *
 * Bodies that fail the area filter are erased from the mask, not just dropped
 * from the list, so downstream `lake[c]` and the returned list never disagree.
 */
function labelLakes(lake, filled, elev, n, cell, minCells) {
  const size = n * n
  const seen = new Uint8Array(size)
  const queue = new Int32Array(size)
  const bodies = []
  for (let s = 0; s < size; s++) {
    if (!lake[s] || seen[s]) continue
    let head = 0
    let tail = 0
    queue[tail++] = s
    seen[s] = 1
    let sumI = 0
    let sumJ = 0
    let deepest = 0
    while (head < tail) {
      const c = queue[head++]
      const ci = c % n
      const cj = (c / n) | 0
      sumI += ci
      sumJ += cj
      const d = filled[c] - elev[c]
      if (d > deepest) deepest = d
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (seen[nn] || !lake[nn]) continue
        seen[nn] = 1
        queue[tail++] = nn
      }
    }
    if (tail < minCells) {
      for (let k = 0; k < tail; k++) lake[queue[k]] = 0
      continue
    }
    const ci = Math.round(sumI / tail)
    const cj = Math.round(sumJ / tail)
    bodies.push({
      cells: tail,
      level: filled[s],
      maxDepth: deepest,
      i: ci,
      j: cj,
      x: centre(ci, cell),
      z: centre(cj, cell),
    })
  }
  bodies.sort((a, b) => b.cells - a.cells)
  return bodies
}

/** Metres of surface width for a stream carrying `a` cells of drainage (§11). */
export function streamWidth(a, minAcc = STREAM.minAcc) {
  return clamp(STREAM.widthAtMin * Math.sqrt(a / minAcc), STREAM.widthAtMin, STREAM.maxWidth)
}

/**
 * The spawn point: walkable, low, in a green valley.
 *
 * Spiral outward from the origin and take the first cell that qualifies, which
 * makes it deterministic and near the middle of the map. Uses the analytic field
 * rather than the grid for the final slope test, because 8 m is far too coarse
 * to certify the one place in the world she is guaranteed to stand.
 */
export function findSpawn(th, elev, n, cell) {
  for (let r = 0; r <= SPAWN.searchRadius; r += 60) {
    const steps = r === 0 ? 1 : 24
    for (let a = 0; a < steps; a++) {
      const ang = (a / steps) * Math.PI * 2 + r * 0.21
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      const h = th.heightAt(x, z)
      if (h < SPAWN.minElev || h > SPAWN.maxElev) continue
      if (th.slopeAt(x, z) > SPAWN.maxSlope) continue
      return { x, z, h, i: cellOf(x, cell, n), j: cellOf(z, cell, n), kind: 'spawn' }
    }
  }
  throw new Error('no walkable spawn found within 3 km of the origin -- check TUNING in terrain-height.js')
}

function findSummit(elev, n, cell) {
  let best = 0
  for (let c = 1; c < n * n; c++) if (elev[c] > elev[best]) best = c
  const i = best % n
  const j = (best / n) | 0
  return { i, j, x: centre(i, cell), z: centre(j, cell), h: elev[best], kind: 'summit' }
}

/**
 * §2 step 6: score valley-floor cells by (low slope) x (proximity to fresh
 * water) x (not in a lake), then take local maxima with a minimum separation.
 *
 * The separation pass is greedy non-maximum suppression: sort by score, walk the
 * list, keep a candidate only if it is far enough from everything already kept.
 * That is O(k * kept) rather than the O(size^2) a true local-maximum search
 * over a 1.4 km radius would cost, and it gives the same answer for any scoring
 * function without a plateau -- which this one, being a product of continuous
 * fields, does not have.
 */
function siteVillages(elev, filled, lake, water, moisture, snowLine, acc, n, cell, minAcc) {
  const half = WORLD_SIZE / 2
  const V = VILLAGE
  const cands = []
  // Distance to water is needed only as a score term, and a full second
  // distance transform is 16 MB for a field we sample a few thousand times. A
  // local ring search is cheaper and its cap doubles as the hard cutoff.
  const ring = Math.ceil(V.maxWaterDist / cell)
  const step = Math.max(1, Math.round(60 / cell)) // one candidate per ~60 m; villages are 1.4 km apart
  for (let j = ring; j < n - ring; j += step) {
    const z = -half + (j + 0.5) * cell
    if (Math.abs(z) > half - V.edgeMargin) continue
    for (let i = ring; i < n - ring; i += step) {
      const c = j * n + i
      if (lake[c]) continue
      const x = -half + (i + 0.5) * cell
      if (Math.abs(x) > half - V.edgeMargin) continue
      const h = elev[c]
      if (h < V.minElev) continue
      if (h > snowLine[c] - V.elevBelowSnow) continue
      const slope = gridSlope(elev, i, j, n, cell)
      if (slope > V.maxSlope) continue

      // Nearest water within the ring. Squared compare, sqrt once.
      let bestD2 = Infinity
      for (let dj = -ring; dj <= ring; dj++) {
        const rowBase = (j + dj) * n
        for (let di = -ring; di <= ring; di++) {
          if (!water[rowBase + i + di]) continue
          const d2 = di * di + dj * dj
          if (d2 < bestD2) bestD2 = d2
        }
      }
      if (bestD2 === Infinity) continue
      const waterDist = Math.sqrt(bestD2) * cell
      if (waterDist > V.maxWaterDist) continue

      // A flat cell in a field of cliffs is a ledge, not a valley floor. Average
      // the slope over ~200 m so the score rewards genuinely open ground.
      const r2 = Math.max(1, Math.round(100 / cell))
      let slopeSum = 0
      let slopeCount = 0
      for (let dj = -r2; dj <= r2; dj += r2) {
        for (let di = -r2; di <= r2; di += r2) {
          const ii = clamp(i + di, 1, n - 2)
          const jj = clamp(j + dj, 1, n - 2)
          slopeSum += gridSlope(elev, ii, jj, n, cell)
          slopeCount++
        }
      }
      // Measured against openRef, not maxSlope. Against maxSlope (9 deg) this
      // term was zero almost everywhere -- neighbourhood-average slope in a
      // mountain range is rarely under 9 degrees even where the cell itself is
      // flat -- so every candidate scored exactly 0.000 and the six sites were
      // chosen by array order rather than by merit.
      const openness = 1 - smoothstep(0, V.openRef, slopeSum / slopeCount)

      const flat = clamp01(1 - slope / V.maxSlope)
      const nearWater = 1 - smoothstep(40, V.maxWaterDist, waterDist)
      const score = flat * openness * nearWater * (0.5 + 0.5 * moisture[c])
      cands.push({ i, j, x, z, h, score, waterDist, slope })
    }
  }

  cands.sort((a, b) => b.score - a.score)
  const kept = []
  const minSep2 = V.minSeparation * V.minSeparation
  for (const cnd of cands) {
    if (kept.length >= V.count) break
    let ok = true
    for (const k of kept) {
      const dx = k.x - cnd.x
      const dz = k.z - cnd.z
      if (dx * dx + dz * dz < minSep2) {
        ok = false
        break
      }
    }
    if (ok) kept.push({ ...cnd, kind: 'village' })
  }
  return kept
}

/**
 * §2 step 7 / §4: flood from spawn over walkable EDGES and report what is
 * reachable.
 *
 * Edges, not nodes. DESIGN.md §4 records this as the third instrument to break
 * the same way: masking out cells whose own slope is steep deletes the flat
 * strip at the base of every cliff, which is the one corridor a mountain world
 * most needs, and the same terrain measured 71.8% reachable as nodes against
 * 92.5% as edges. player.js rejects a *step*, so the gate must test a *step*.
 *
 * KNOWN COARSE, and stated rather than discovered later: an 8 m edge cannot see
 * a 3 m ledge in the middle of a cell, so this flood is optimistic. It answers
 * the macro question -- is the summit in the same basin as spawn, is a village
 * walled off by a range -- and check-sim.mjs's finer local flood answers the
 * other one. Neither is a substitute for the other.
 */
function connectivity(elev, lake, filled, n, cell, spawn, targets) {
  const size = n * n
  const maxTan = Math.tan(MAX_WALK_SLOPE)
  const seen = new Uint8Array(size)
  const queue = new Int32Array(size)
  const start = spawn.j * n + spawn.i
  let head = 0
  let tail = 0
  queue[tail++] = start
  seen[start] = 1
  while (head < tail) {
    const c = queue[head++]
    const ci = c % n
    const cj = (c / n) | 0
    const hc = elev[c]
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB_DI[k]
      const nj = cj + NB_DJ[k]
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nn = nj * n + ni
      if (seen[nn]) continue
      // Deep water is a wall. §4 has no swimming and no falling, so a lake is a
      // boundary in exactly the way a cliff is.
      if (lake[nn] && filled[nn] - elev[nn] > 1.2) continue
      if (Math.abs(elev[nn] - hc) / (NB_DIST[k] * cell) > maxTan) continue
      seen[nn] = 1
      queue[tail++] = nn
    }
  }

  const unreachable = []
  for (const t of targets) {
    if (!seen[t.j * n + t.i]) unreachable.push(t)
  }
  return { reachable: seen, reachableFraction: tail / size, unreachable }
}

// world-grid's gridX/cellI are hardwired to GRID_N. Phase A runs at reduced n
// for the check script and the map view, so it derives cell centres from the
// resolution it was actually given. Using the global helpers here would put
// every village and lake centre off by a factor of n/GRID_N -- a silent,
// plausible-looking wrong answer, which is the worst kind.
const centre = (i, cell) => -WORLD_SIZE / 2 + (i + 0.5) * cell
const cellOf = (v, cell, n) => clamp(Math.floor((v + WORLD_SIZE / 2) / cell), 0, n - 1)

const now = () => performance.now()
const ms = (t, raw = false) => (raw ? performance.now() - t : `${(performance.now() - t).toFixed(0)}ms`.padStart(7))
