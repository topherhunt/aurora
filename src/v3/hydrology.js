import { priorityFlood, breachDepressions, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { selectLakes } from '../sim/phase-a.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { clamp } from '../sim/mathx.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// Step D -- the island drains. The jittered cone is a field of closed bowls; this chooses a few of them to keep as lakes, cuts an outlet channel through every other rim, routes the water, deepens the ground under it by biome, and reads the rivers off the result as polylines for the v2 doc. Three-free and DOM-free like the rest of src/v3: the gate runs it in node.
//
//   1. LAKES. The bowls a priority flood finds, each filled to LAKES.maxArea of surface or to its spill, whichever comes first, scored by the widest open water in them (Phase A's selectLakes); the widest LAKES.keep are lakes. They are held flat at their level through the breaching so the breacher walks past them, then the bowl goes back. A lake has no dam: its shore is wherever the ground meets its level.
//   2. BREACH. Every other bowl gets a least-cost channel cut from its floor through its rim (sim/hydrology.js), repeated until nothing is left to cut. After this every drop of rain on land has a path to the sea that never climbs, except into a kept lake.
//   3. ROUTE. Priority flood, D8 steepest descent, accumulation in cells.
//   4. CARVE. Implicit stream-power incision along the network: each cell is pulled toward its receiver by kdt * A^m / dx, the constant scaled per biome, so the canyon cuts deep, the swamp barely, and the arctic between. Cannot make a pit, so the routing stays valid across passes.
//   5. RIVERS. A cell with RIVERS.minCatchment of catchment, above the sea and outside a lake, is a river cell. The network is walked from every mouth up its largest donor to a source, the other donors becoming tributaries whose last point is the trunk cell they join; a source fed by a lake starts inside it. Cell centres are simplified to RIVERS.tolerance and written with a width from the sqrt of the catchment, source to mouth.
//   6. THE DOC. Each lake is an uncarved ellipse fitted to its pool at its level, so v2 draws water wherever the ground inside the ellipse lies under it, which is the bowl.
// ---------------------------------------------------------------------------

export const LAKES = {
  keep: 12,           // at most this many lakes
  minDepth: 1.5,      // metres a bowl must pond before it is a candidate
  maxArea: 0.3e6,     // square metres of surface a lake may keep; a bowl is filled to this or to its spill, whichever comes first
  minWidth: 80,       // metres of open water across the widest inscribed disc, under which a candidate is a spider of arms and not a lake
  drawdown: 6,        // metres under its chosen level a lake may stand after its outlet is cut before it is given up as emptied
  margin: 1.06,       // the fitted ellipse is scaled by this past the last pool cell
}

export const BREACH = {
  maxLakeArea: 0,     // drain everything not chosen above
  maxLakeDepth: 60,
  maxCut: 200,
  maxLength: 2500,
  passes: 30,         // outer loop cap; the loop stops when a pass cuts nothing
  rounds: 8,          // cap on the re-read rounds round the passes; the loop stops when every lake holds and no other bowl does
}

export const CARVE = {
  passes: 20,
  kdt: 4e-4,          // K dt lumped; a trunk of 5 km2 at 8 m sees f ~ 0.11 a pass, a headwater of 4 ha ~ 0.01
  m: 0.5,
  minArea: 4e4,       // square metres of catchment under which a cell is hillslope and is not cut
  // Multipliers on kdt per class, by BIOMES id.
  byBiome: { arctic: 0.5, forest: 1, plains: 1, jungle: 1.3, swamp: 0.15, canyon: 3, desert: 1.5 },
}

export const RIVERS = {
  minCatchment: 5e4,   // square metres draining through a cell before it is a river
  widthAtMin: 1.2,     // metres of water at minCatchment, growing with the square root of the catchment
  maxWidth: 14,
  minLength: 60,       // metres; a shorter tributary with nothing feeding it is not drawn
  tolerance: 5,        // Douglas-Peucker on the cell centres, metres
}

/**
 * `runHydrology(height, n, cell, ground)` -> { height, lakes, rivers, stats }
 *
 * `height` in is the raw field, `ground` the class grid the carve reads its knobs from; `height` out is a new array, carved. `lakes` and `rivers` are doc records without ids.
 */
export function runHydrology(height, n, cell, ground) {
  if (ground.length !== height.length) throw new Error(`runHydrology: ground has ${ground.length} texels, the field ${height.length}`)
  const size = n * n
  const half = ((n - 1) * cell) / 2
  const cellArea = cell * cell
  const stats = {}

  // --- 1. lakes ---------------------------------------------------------------
  // The jitter over the sea leaves bowls in the sea floor too, and they are the widest. The flood is read as the ground itself over the sea -- every texel under the waterline reachable from the box edge -- so only the land's bowls are candidates.
  const pond = priorityFlood(height, n)
  const sea = seaMask(height, n)
  const filledLand = Float32Array.from(pond.filled)
  for (let c = 0; c < size; c++) if (sea[c]) filledLand[c] = height[c]
  const picked = selectLakes(height, filledLand, n, cell, LAKES.keep, LAKES.minDepth, LAKES.maxArea)
  let kept = picked.chosen.filter((b) => b.width >= LAKES.minWidth).map((b) => ({ cells: b.cells, level: b.level, chosen: b.level, floor: floorOf(b, height) }))

  // --- 2. breach --------------------------------------------------------------
  // A lake filled short of its spill is still a depression to the breacher, which cuts its outlet from the flat's edge through the rim at the channel grade, so the water it holds afterwards stands a little under the level it was chosen at. That is the lake's own outlet. A channel from ANOTHER basin, one whose floor lies under this lake's surface and so cannot drain into it, may run straight across the flat and empty it; a lake drawn down past LAKES.drawdown that way is given up. Either way the water that stands afterwards is re-read from the flood, and the next round holds each lake flat at THAT level over THOSE cells, so any pocket of the chosen pool left above the water is a bowl the breacher now sees and drains. Rounds run until no lake is lost and no bowl but the lakes holds water.
  let elev = height
  let flood
  let passes = 0
  let channels = 0
  let deepestCut = 0
  let refused = 0
  let rounds = 0
  let dropped = 0
  for (;;) {
    rounds++
    // Each round starts from the last round's ground, channels and all, so a lake's outlet, once cut, is there when the lake is held flat at the level it drew down to; from the raw field again, the flat would be a bowl under an uncut rim and get a fresh outlet a little lower every round.
    const before = elev
    elev = Float32Array.from(before)
    for (const b of kept) for (const c of b.cells) elev[c] = b.level
    for (let pass = 0; pass < BREACH.passes; pass++) {
      const r = breachDepressions(elev, n, cell, BREACH)
      elev = r.elev
      passes++
      channels += r.breached
      refused = r.refused
      if (r.deepestCut > deepestCut) deepestCut = r.deepestCut
      if (r.breached === 0) break
    }
    for (const b of kept) for (const c of b.cells) elev[c] = Math.min(elev[c], before[c])
    flood = priorityFlood(elev, n)
    const read = readLakes(kept, elev, flood.filled, sea, n)
    dropped += read.dropped
    const settled = read.held.length === kept.length && read.residue.length === 0
    kept = read.held
    if (settled) break
    if (rounds >= BREACH.rounds) throw new Error(`runHydrology: after ${rounds} rounds ${read.residue.length} bowls still hold water beside the lakes`)
  }
  stats.breach = { passes, channels, deepestCut, refused, rounds, dropped }

  // --- 3. route ---------------------------------------------------------------
  let recv = flowDirections(flood.filled, flood.tree, n)
  let acc = flowAccumulation(recv, flood.order, size)

  // --- 4. carve ---------------------------------------------------------------
  // The lakes: the flat the routing crosses, which the carve must neither cut nor cut toward below its surface.
  const wet = new Uint8Array(size)
  for (const b of kept) for (const c of b.cells) wet[c] = 1
  const kdt = BIOMES.map((b) => {
    const k = CARVE.byBiome[b.id]
    if (!(k >= 0)) throw new Error(`runHydrology: CARVE.byBiome has no ${b.id}`)
    return CARVE.kdt * k
  })
  let deepestIncision = 0
  for (let p = 0; p < CARVE.passes; p++) {
    const d = incise(elev, flood.filled, recv, flood.order, acc, n, cell, kdt, ground, wet, sea)
    if (d > deepestIncision) deepestIncision = d
  }
  let cutSum = 0
  let cutCells = 0
  for (let c = 0; c < size; c++) {
    if (sea[c] || wet[c]) continue
    const d = height[c] - elev[c]
    if (d > 0.5) {
      cutSum += d
      cutCells++
    }
  }
  stats.carve = { deepest: deepestIncision, meanCut: cutCells ? cutSum / cutCells : 0, cutKm2: (cutCells * cellArea) / 1e6 }

  // Route again on the carved ground: the incision keeps every receiver under its donor, but the steepest of eight can change. It makes no pit, so the water that stands is the water that stood.
  flood = priorityFlood(elev, n)
  recv = flowDirections(flood.filled, flood.tree, n)
  acc = flowAccumulation(recv, flood.order, size)
  const after = readLakes(kept, elev, flood.filled, sea, n)
  if (after.held.length !== kept.length || after.residue.length > 0) throw new Error(`runHydrology: the carve left ${after.held.length} of ${kept.length} lakes and ${after.residue.length} bowls of water`)
  kept = after.held
  wet.fill(0)
  for (const b of kept) for (const c of b.cells) wet[c] = 1
  // A coastal pocket the carve opened to the sea is the sea's now.
  for (let c = 0; c < size; c++) if (flood.filled[c] <= 0) sea[c] = 1

  // --- 5. the lakes as records ------------------------------------------------
  const lakes = kept.map((b) => fitLake(b, elev, n, cell, half))
  lakes.sort((a, b) => b.km2 - a.km2)
  stats.lakes = { candidates: picked.total, count: lakes.length, km2: lakes.reduce((s, l) => s + l.km2, 0), leakKm2: lakes.reduce((s, l) => s + l.leakKm2, 0), bodies: lakes.map(({ rec, ...rest }) => rest) }

  // --- 6. rivers --------------------------------------------------------------
  const river = new Uint8Array(size)
  let riverCells = 0
  for (let c = 0; c < size; c++) {
    if (!sea[c] && !wet[c] && acc[c] * cellArea >= RIVERS.minCatchment) {
      river[c] = 1
      riverCells++
    }
  }
  const rivers = traceRivers(river, recv, acc, wet, n, cell, half)
  let km = 0
  let longest = 0
  for (const r of rivers) {
    km += r.km
    if (r.km > longest) longest = r.km
  }
  stats.rivers = { count: rivers.length, cells: riverCells, km, longestKm: longest, intoSea: rivers.filter((r) => r.into === 'sea').length, intoLake: rivers.filter((r) => r.into === 'lake').length, fromLake: rivers.filter((r) => r.fromLake).length }

  return { height: elev, lakes: lakes.map((l) => l.rec), rivers: rivers.map((r) => r.rec), stats }
}

/** The deepest cell of a chosen bowl. */
function floorOf(b, height) {
  let floor = b.cells[0]
  for (const c of b.cells) if (height[c] < height[floor]) floor = c
  return floor
}

/** Metres of standing water a cell needs to count as part of a lake's pool. */
const POOL_MIN = 0.01

/**
 * The lakes as the flood now holds them: `held` is each kept lake re-read as its whole pool, `dropped` how many hold no lake any more, `residue` every body of LAKES.minDepth or more of water that is no lake's.
 *
 * A lake is its whole pool, every cell under its surface: a flat over only the deep cells leaves a ring of shallows round it that the breacher drains through the rim, and the lake drops by that ring's depth each round, for ever. A bowl is residue only when its pool is no lake's, since one pool can hold two deep bodies over a shallow saddle. A residue whose pool touches a lake's and whose floor lies under the lake's surface is given to the lake: left alone, the breacher would drain that pocket THROUGH the lake, its floor being the lowest ground about, and empty the lake with it; held flat at the lake's level, the saddle between them is the pocket's whole rim and the breacher cuts it.
 */
function readLakes(kept, elev, filled, sea, n) {
  const pools = wetBodies(elev, filled, sea, n, POOL_MIN)
  const deep = wetBodies(elev, filled, sea, n, LAKES.minDepth)
  const held = []
  let dropped = 0
  for (const b of kept) {
    const pool = pools.at(b.floor)
    if (pool === null || pool.level < b.chosen - LAKES.drawdown || pool.level - elev[b.floor] < LAKES.minDepth) {
      dropped++
      continue
    }
    pool.lake = { cells: pool.cells.slice(), level: pool.level, chosen: b.chosen, floor: b.floor }
    held.push(pool.lake)
  }
  const residue = []
  for (const body of deep.list) {
    const pool = pools.at(body.cells[0])
    if (pool.lake) continue
    let floor = Infinity
    for (const c of pool.cells) if (elev[c] < floor) floor = elev[c]
    let lake = null
    for (const c of pool.cells) {
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8 && lake === null; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const beside = pools.at(nj * n + ni)
        if (beside !== null && beside.lake && floor < beside.lake.level) lake = beside.lake
      }
      if (lake !== null) break
    }
    if (lake === null) residue.push(body)
    else {
      lake.cells.push(...pool.cells)
      pool.lake = lake
    }
  }
  return { held, dropped, residue }
}

/** Every 8-connected body of land the flood holds `minDepth` or more of water over: `list` of { cells, level, deepest }, and `at(c)` the body over a cell, or null. Water whose surface is under the waterline is the sea's, whether or not the raw field's sea reached it: a channel or the carve can open a coastal pocket to the sea. */
function wetBodies(elev, filled, sea, n, minDepth) {
  const size = n * n
  const label = new Int32Array(size).fill(-1)
  const list = []
  const stack = new Int32Array(size)
  for (let s = 0; s < size; s++) {
    if (label[s] >= 0 || sea[s] || filled[s] <= 0 || filled[s] - elev[s] < minDepth) continue
    const id = list.length
    const cells = []
    let top = 0
    stack[top++] = s
    label[s] = id
    let deepest = 0
    while (top > 0) {
      const c = stack[--top]
      cells.push(c)
      const d = filled[c] - elev[c]
      if (d > deepest) deepest = d
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (label[nn] >= 0 || sea[nn] || filled[nn] <= 0 || filled[nn] - elev[nn] < minDepth) continue
        label[nn] = id
        stack[top++] = nn
      }
    }
    list.push({ cells, level: filled[s], deepest })
  }
  return { list, at: (c) => (label[c] >= 0 ? list[label[c]] : null) }
}

/** The sea: every texel at or under the waterline reachable from the box edge through such texels. */
function seaMask(height, n) {
  const size = n * n
  const sea = new Uint8Array(size)
  const stack = new Int32Array(size)
  let top = 0
  const push = (c) => {
    if (sea[c] || height[c] > 0) return
    sea[c] = 1
    stack[top++] = c
  }
  for (let i = 0; i < n; i++) {
    push(i)
    push((n - 1) * n + i)
    push(i * n)
    push(i * n + n - 1)
  }
  while (top > 0) {
    const c = stack[--top]
    const ci = c % n
    const cj = (c / n) | 0
    if (ci > 0) push(c - 1)
    if (ci < n - 1) push(c + 1)
    if (cj > 0) push(c - n)
    if (cj < n - 1) push(c + n)
  }
  return sea
}

/**
 * One pass of implicit stream-power incision with a per-class constant: h_c <- (h_c + f h_r) / (1 + f), f = kdt[class] A^m / dx. Walking `order` forwards, every receiver is already updated, and h_c' is a mean of h_c and h_r' so it never falls under h_r': no pit is ever made. A receiver in a lake or in the sea stands at the water's surface, not the bed, so a shore is not pulled down into the bowl and a mouth is not dug under the sea; a cell in a lake or in the sea is not cut.
 */
function incise(elev, filled, recv, order, acc, n, cell, kdt, ground, inLake, sea) {
  const cellArea = cell * cell
  let deepest = 0
  for (let k = 0; k < order.length; k++) {
    const c = order[k]
    const r = recv[c]
    if (r < 0 || inLake[c] || sea[c]) continue
    const area = acc[c] * cellArea
    if (area < CARVE.minArea) continue
    const di = (c % n) - (r % n)
    const dj = ((c / n) | 0) - ((r / n) | 0)
    const dx = cell * (di !== 0 && dj !== 0 ? Math.SQRT2 : 1)
    const f = (kdt[ground[c]] * Math.pow(area, CARVE.m)) / dx
    const hr = inLake[r] ? filled[r] : sea[r] ? 0 : elev[r]
    const before = elev[c]
    const after = (before + f * hr) / (1 + f)
    elev[c] = after
    if (before - after > deepest) deepest = before - after
  }
  return deepest
}

/** A lake record over a flooded body: the ellipse of the pool's principal axes, grown until every pool cell is inside, at the body's level. `leakKm2` is ground inside the ellipse but outside the body that lies under the level -- water v2 will draw that is not the lake. */
function fitLake(body, elev, n, cell, half) {
  const { cells, level } = body
  let deepest = 0
  for (const c of cells) if (level - elev[c] > deepest) deepest = level - elev[c]
  let mx = 0
  let mz = 0
  for (const c of cells) {
    mx += c % n
    mz += (c / n) | 0
  }
  mx /= cells.length
  mz /= cells.length
  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const c of cells) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  sxx /= cells.length
  sxz /= cells.length
  szz /= cells.length
  // The doc's `rot` turns the query INTO the lake's frame by (cos, sin; -sin, cos), so the frame's x axis is the world direction (cos rot, sin rot): the major eigenvector's angle is the rotation itself.
  const rot = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const l1 = cr * cr * sxx + 2 * cr * sr * sxz + sr * sr * szz
  const l2 = sr * sr * sxx - 2 * cr * sr * sxz + cr * cr * szz
  // A uniform ellipse's variance along a semi-axis a is a^2 / 4; then grown until the furthest cell centre is inside, plus half a cell.
  let a = Math.max(2 * Math.sqrt(Math.max(l1, 0)), 0.5)
  let b = Math.max(2 * Math.sqrt(Math.max(l2, 0)), 0.5)
  let far = 0
  for (const c of cells) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    const u = (cr * dx + sr * dz) / a
    const v = (-sr * dx + cr * dz) / b
    const q = u * u + v * v
    if (q > far) far = q
  }
  const grow = Math.sqrt(far) * LAKES.margin
  a = a * grow + 0.5
  b = b * grow + 0.5
  const x = mx * cell - half
  const z = mz * cell - half
  const rx = a * cell
  const rz = b * cell
  // The leak: texels the ellipse covers, under the level, that are not the body.
  const inBody = new Set(cells)
  let leak = 0
  const reach = Math.ceil(Math.max(a, b))
  for (let j = Math.max(0, Math.floor(mz - reach)); j <= Math.min(n - 1, Math.ceil(mz + reach)); j++) {
    for (let i = Math.max(0, Math.floor(mx - reach)); i <= Math.min(n - 1, Math.ceil(mx + reach)); i++) {
      const dx = i - mx
      const dz = j - mz
      const u = (cr * dx + sr * dz) / a
      const v = (-sr * dx + cr * dz) / b
      if (u * u + v * v > 1) continue
      const c = j * n + i
      if (elev[c] < level && !inBody.has(c)) leak++
    }
  }
  return {
    x, z, level, rx, rz, rot,
    km2: (cells.length * cell * cell) / 1e6,
    leakKm2: (leak * cell * cell) / 1e6,
    deepest,
    rec: { x: round1(x), z: round1(z), y: round2(level), rx: round1(rx), rz: round1(rz), rot: Math.round(rot * 1000) / 1000, shape: 0, carve: 0, depth: round1(Math.max(1, deepest)) },
  }
}

/**
 * The river polylines. Donors are gathered per cell; every mouth (a river cell whose receiver is not one) is walked up its largest donor to a source, and each other donor met on the way is the mouth of a tributary, walked the same way. A river ends one cell past its mouth -- in the sea, in a lake, or on the trunk cell it joins -- and begins one cell early when its source is fed by a lake, so v2 pins its level to the water at either end.
 */
function traceRivers(river, recv, acc, wet, n, cell, half) {
  const size = n * n
  const start = new Int32Array(size + 1)
  for (let c = 0; c < size; c++) {
    if (!river[c]) continue
    const r = recv[c]
    if (r >= 0 && river[r]) start[r + 1]++
  }
  for (let c = 0; c < size; c++) start[c + 1] += start[c]
  const donors = new Int32Array(start[size])
  const fill = Int32Array.from(start.subarray(0, size))
  for (let c = 0; c < size; c++) {
    if (!river[c]) continue
    const r = recv[c]
    if (r >= 0 && river[r]) donors[fill[r]++] = c
  }

  const out = []
  const heads = []
  for (let c = 0; c < size; c++) {
    if (!river[c]) continue
    const r = recv[c]
    if (r >= 0 && river[r]) continue
    heads.push({ mouth: c, tail: r, into: r < 0 ? 'edge' : wet[r] ? 'lake' : 'sea' })
  }
  while (heads.length) {
    const head = heads.pop()
    const cells = []
    const branches = []
    let c = head.mouth
    for (;;) {
      cells.push(c)
      let best = -1
      for (let k = start[c]; k < start[c + 1]; k++) if (best < 0 || acc[donors[k]] > acc[best]) best = donors[k]
      if (best < 0) break
      for (let k = start[c]; k < start[c + 1]; k++) if (donors[k] !== best) branches.push({ mouth: donors[k], tail: c, into: 'river' })
      c = best
    }
    cells.reverse()
    // A source fed by a lake: the wettest neighbour draining into it, so the river begins on the water.
    const src = cells[0]
    let fromLake = -1
    const si = src % n
    const sj = (src / n) | 0
    for (let k = 0; k < 8; k++) {
      const ni = si + NB_DI[k]
      const nj = sj + NB_DJ[k]
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nn = nj * n + ni
      if (recv[nn] === src && wet[nn] && (fromLake < 0 || acc[nn] > acc[fromLake])) fromLake = nn
    }
    let km = 0
    for (let k = 1; k < cells.length; k++) km += Math.hypot((cells[k] % n) - (cells[k - 1] % n), ((cells[k] / n) | 0) - ((cells[k - 1] / n) | 0)) * cell
    // A stub joining a trunk with nothing of its own is not drawn; one with branches is, or they would end on nothing.
    if (km * 1000 < RIVERS.minLength && branches.length === 0 && head.into === 'river') continue
    heads.push(...branches)
    const pts = []
    const pinned = []
    if (fromLake >= 0) pts.push(point(fromLake, acc[src], n, cell, half))
    // The cell a tributary joins at stays a node through the simplification, so the tributary's last point lies on the trunk's line and v2 pins its mouth to the trunk.
    const junctions = new Set(branches.map((b) => b.tail))
    for (const k of cells) {
      if (junctions.has(k)) pinned.push(pts.length)
      pts.push(point(k, acc[k], n, cell, half))
    }
    if (head.tail >= 0) pts.push(point(head.tail, acc[cells[cells.length - 1]], n, cell, half))
    const kept = simplify(pts, RIVERS.tolerance, pinned)
    out.push({ km: km / 1000, into: head.into, fromLake: fromLake >= 0, rec: { pts: kept.map((p) => [round1(p[0]), round1(p[1]), round1(p[2])]) } })
  }
  return out
}

function point(c, a, n, cell, half) {
  return [(c % n) * cell - half, ((c / n) | 0) * cell - half, clamp(RIVERS.widthAtMin * Math.sqrt((a * cell * cell) / RIVERS.minCatchment), RIVERS.widthAtMin, RIVERS.maxWidth)]
}

/** Douglas-Peucker on an open polyline of [x, z, w], keeping the endpoints and the `pinned` indices. */
function simplify(pts, tol, pinned) {
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  for (const i of pinned) keep[i] = 1
  const stack = []
  let last = 0
  for (let i = 1; i < pts.length; i++) {
    if (!keep[i]) continue
    stack.push([last, i])
    last = i
  }
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    const ax = pts[a][0]
    const az = pts[a][1]
    const dx = pts[b][0] - ax
    const dz = pts[b][1] - az
    const len = Math.hypot(dx, dz) || 1
    let far = -1
    let farD = tol
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / len
      if (d > farD) {
        farD = d
        far = i
      }
    }
    if (far < 0) continue
    keep[far] = 1
    stack.push([a, far], [far, b])
  }
  return pts.filter((_, i) => keep[i])
}

const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100
