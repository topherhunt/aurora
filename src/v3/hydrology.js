import { priorityFlood, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { drainBasins, BASINS } from './basins.js'
import { table, CLIFFS, CLIFFS_OFF } from './cliffs.js'
import { Noise } from '../sim/noise.js'

// ---------------------------------------------------------------------------
// Step D -- the island drains. Every basin the jitter left is emptied with a broad rim dish except the deepest handful (basins.js); what still ponds is then read, the kept basins become lakes, the water is routed, and the rivers come off the flow network as polylines for the v2 doc. Three-free and DOM-free like the rest of src/v3: the gate runs it in node.
//
// ONE STEP MOVES THE FIELD AND IT ONLY EVER LOWERS IT: the drain's rim dish. Nothing here raises ground and nothing else here cuts any, so a texel's height is the jitter's own unless the drain took a rim off it. What the drain leaves standing under a metre is left standing -- a puddle the doc does not draw, measured in `stats.puddles` and otherwise untouched. `stats.stranded` is the other thing the drain leaves: water it had counted as a kept lake's that the finished field ponds on its own, below that lake's level, which the lake walk cannot admit either.
//
//   1. BASINS. Every enclosed dip more than a metre deep, ranked on depth alone. The deepest BASINS.keep hold their water down to BASINS.keepDepth; the rest are drained by cutting their lowest rim point with a dish half the pond's width across, over and over, each round on the new rim point.
//   2. CLIFFS. Bands of the steep ground are snapped onto a ladder of benches, standing their slope up into risers (cliffs.js). Off by default (generate.js STEPS), and the one thing in step D that lifts a texel when it is on. It runs before everything else so the lakes, the route and the rivers are all solved on the shape that will be drawn. The field after this is the island's ground.
//   3. LAKES. The basins the drain kept, grown from their deepest cell to the level the flood now stands them at. A lake has no dam: its shore is wherever the ground meets its level, which is why no two of them are the same shape.
//   4. ROUTE. Priority flood, D8 steepest descent, accumulation in cells. What ponds outside the lakes is measured on the way past and left where it is.
//   5. THE LAKES AS ELLIPSES. Each lake goes to the doc as an uncarved ellipse fitted to its pool at its level, so v2 draws water wherever the ground inside the ellipse lies under it -- the ellipse bounds the query, the ground decides the shore.
//   6. RIVERS. A cell with RIVERS.minCatchment of catchment, above the sea and outside a lake, is a river cell. Where two of them come within RIVERS.joinReach with no wall between, the one carrying less water drains into the one carrying more, so two channels a few texels apart become one river at the point they first came near. The network is walked from every mouth up its largest donor to a source, the other donors becoming tributaries whose last point is the trunk cell they join; a source fed by a lake starts inside it. Cell centres are simplified to RIVERS.tolerance and written with a half-width off the catchment, the valley's flatness and a noise, source to mouth. The polyline and its widths are all that go to the doc: v2 cuts the bed at render time (§2 paths.js carveRivers), so the valley a river runs in is v2's and not this file's.
// ---------------------------------------------------------------------------

export const LAKES = {
  minDepth: 1.5,      // metres a kept basin must still pond after the drain to be drawn as a lake
  maxArea: 4e6,       // square metres of surface a lake may keep; a bowl is filled to this or to its spill, whichever comes first
  margin: 1.06,       // the fitted ellipse is scaled by this past the pool cell it is sized to
  cover: 0.985,       // the fraction of pool cells it is sized to hold. Short of 1 because the furthest cell of a curved pool is an outlier that swings the whole ellipse out over the ground at the corners, and a few square metres left dry at the tip of one arm costs far less than that
  holdDepth: 3,       // metres, overriding `cover`: however far out it lies, water this deep is inside the ellipse. A shallow rim drawn as land reads as a beach; a three-metre hole drawn as land reads as a bug
  spill: 0.5,         // metres of water an ellipse may draw OUTSIDE its own body before it is split and then shrunk. This is the one thing the fit is judged on: v2 draws water wherever the ground inside a record lies under its level, so an ellipse overhanging the valley beside the lake draws a sheet standing on the hillside -- a 100 m2 sliver 70 m deep reads as a wall of water and costs nothing by area. Under `spill` it is a puddle at the shore
  splitMax: 16,       // ellipses one pool may be cut into. They share the body's level and may overlap freely: v2 draws water where the ground under a lake lies below its level, so two records over the same ground draw the same water
  splitMin: 40,       // pool cells a part must keep for the cut to be worth making
  shrink: 0.96,       // what a part's axes are multiplied by per shrinking round once splitting has run out. It stops when nothing over `spill` is drawn outside the body or when the part's own deepest cell would fall outside it -- the lake's deepest water is the one thing an ellipse must hold
}

// The drawn water: how wide the sheet in the v2 doc is at every node of every river. The bed under it is not cut here -- v2 solves the river's level and cuts the channel to it at render time -- so these are the only widths on the island and nothing has to be kept in step with them.
export const RIVERS = {
  minCatchment: 5e4,   // square metres draining through a cell before it is a river
  halfAtMin: 2.4,      // metres of water either side of the line at minCatchment. A HALF-width, as the v2 doc's widths are
  widthExp: 0.5,       // the catchment ratio is raised to this for the width, so two branches meeting is twice the catchment and 41% more water. The confluence needs no term of its own
  maxHalf: 20,
  minHalf: 0.5,        // metres. An absolute floor, not a fraction of halfAtMin, or it would undo `tip`
  tip: 0.35,           // the share of its mouth's width a river has at its source, easing to 1 at the mouth. This, not the exponent, is what puts a mouth half again as wide as the river's own average: the catchment along a trunk sits at a median 0.84 of its mouth's, so a pure catchment law gives a flare of 1.16 and an exponent big enough to fix that is no longer a width law
  flatWiden: 0.9,      // how much of itself again the water gains where the valley floor is flat, so a river spreads on a floodplain and runs narrow through a gorge
  steepGrade: 0.25,    // the longitudinal grade at which a reach counts as fully steep. Measured against this terrain, whose median channel grade is 0.275
  gradeLen: 140,       // metres of arc the grade is measured over
  wobble: 0.22,        // the share of its width a reach wanders by along the line, so no river holds one width for long
  wobbleScale: 80,     // metres over which that wander turns
  minLength: 60,       // metres; a shorter tributary with nothing feeding it is not drawn
  joinReach: 20,       // metres within which two rivers are near enough to be one and the smaller is turned into the bigger
  joinWall: 3,         // metres the ground between the two may stand above the higher of them. Over this they are two valleys and not two channels of one, however close they run
  joinBend: 2.5,       // how many times the gap between two cells the water's own way from one to the other may be before they stop being the same channel round a bend and count as two rivers side by side
  lakeEntry: 8,        // metres a river's first node must lie inside the DRAWN edge of the lake it leaves, so v2's bed carve begins under the water and blends out of it instead of starting short of the shore
  lakeWalk: 60,        // metres of lake that first node may be looked for over. Past this the arm the river leaves by is not drawn at all and the river starts at the waterline, as it would with no rule here
  tolerance: 5,        // Douglas-Peucker on the cell centres, metres
  pinDrop: 3,          // metres of fall between one cell and the next that keeps both as nodes through it, so a cliff's lip and foot survive in plan
}

/**
 * `runHydrology(height, n, cell, ground, seed, cliffs = true)` -> { height, lakes, rivers, stats }
 *
 * `height` in is the raw field, `ground` the class grid the tabling reads its bands from, `seed` what the rivers' width noise turns on; `height` out is a new array, drained. `lakes` and `rivers` are doc records without ids. `cliffs` false runs step 2 with every class's share at zero, which moves nothing.
 */
export function runHydrology(height, n, cell, ground, seed, cliffs = true) {
  if (ground.length !== height.length) throw new Error(`runHydrology: ground has ${ground.length} texels, the field ${height.length}`)
  if (!Number.isFinite(seed)) throw new Error(`runHydrology: seed must be a finite number, got ${seed}`)
  const size = n * n
  const half = ((n - 1) * cell) / 2
  const cellArea = cell * cell
  const maxPoolCells = Math.max(1, Math.round(LAKES.maxArea / cellArea))
  const stats = {}

  // --- 1. basins --------------------------------------------------------------
  const elev = Float32Array.from(height)
  const sea = seaMask(height, n)
  const emptied = drainBasins(elev, sea, n, cell, BASINS)
  stats.basins = emptied.stats

  // --- 2. cliffs --------------------------------------------------------------
  const t1 = Date.now()
  stats.cliffs = table(elev, sea, ground, n, cell, seed, cliffs ? CLIFFS : CLIFFS_OFF)
  stats.cliffs.ms = Date.now() - t1

  // --- 3. lakes ---------------------------------------------------------------
  // The drain already chose which basins keep their water; this reads what its rim cuts and the tabling left them standing at. A body is every cell the flood wets round the kept basin's deepest cell, up to and including the new spill, at the spill's level, so the river out of it leaves from the water and not from a step above it. A basin a neighbouring valley happened to open on its way past is no longer a lake and is counted as drained.
  const flood = priorityFlood(elev, n)
  for (let c = 0; c < size; c++) if (flood.filled[c] <= 0) sea[c] = 1
  const filledLand = Float32Array.from(flood.filled)
  for (let c = 0; c < size; c++) if (sea[c]) filledLand[c] = elev[c]
  const wet = new Uint8Array(size)
  const kept = []
  let drained = 0
  for (const b of emptied.lakes) {
    const level = filledLand[b.seed]
    if (wet[b.seed] || sea[b.seed] || level - elev[b.seed] < LAKES.minDepth) {
      drained++
      continue
    }
    const cells = []
    const stack = [b.seed]
    wet[b.seed] = 1
    while (stack.length) {
      const c = stack.pop()
      cells.push(c)
      const ci = c % n
      const cj = (c / n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = ci + NB_DI[k]
        const nj = cj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const nn = nj * n + ni
        if (wet[nn] || filledLand[nn] !== level || elev[nn] > level) continue
        wet[nn] = 1
        stack.push(nn)
      }
    }
    kept.push({ cells, level, pool: poolOf(cells, elev, level, maxPoolCells) })
  }

  // --- 4. route ---------------------------------------------------------------
  // What ponds outside the drawn lakes, MEASURED AND LEFT WHERE IT IS, in the two kinds it comes in.
  //
  // `puddles` is ordinary ground: the shallow remainder the drain stopped at, under BASINS.pond by its own contract, and a hollow with no water drawn in it is what a dry hollow looks like.
  // `stranded` is ground the drain marked as a kept lake's own water and the field no longer ponds with that lake -- a lobe a dish cut off from it, standing at its own level a metre or two below the lake's, which the body walk above cannot admit and the doc therefore draws nothing in. It is the same fault as a lake with a bar across one arm: a dish cutting a rim near a kept lake does not know where that lake's waterline is. Measured, not hidden, until that is fixed in the dish.
  let pondCells = 0
  let pondSum = 0
  let pondDeepest = 0
  let lostCells = 0
  let lostDeepest = 0
  for (let c = 0; c < size; c++) {
    if (sea[c] || wet[c]) continue
    const d = filledLand[c] - elev[c]
    if (d <= 0) continue
    if (emptied.spare[c]) {
      lostCells++
      if (d > lostDeepest) lostDeepest = d
      continue
    }
    pondCells++
    pondSum += d
    if (d > pondDeepest) pondDeepest = d
  }
  stats.puddles = { cells: pondCells, km2: (pondCells * cellArea) / 1e6, mean: pondCells ? pondSum / pondCells : 0, deepest: pondDeepest }
  stats.stranded = { cells: lostCells, km2: (lostCells * cellArea) / 1e6, deepest: lostDeepest }

  // Nothing has moved the field since the flood above, so that flood is the route's too: one priority flood for the island.
  const recv = flowDirections(flood.filled, flood.tree, n)
  // A lake drains through its spill and nowhere else. Steepest descent off the flat would let the cells beside the spill step straight over the rim into the ground falling away past it, and each such step is a source, so one lake would let out three or four rivers a few cells apart; the flood's tree leads every lake cell to the spill.
  for (let c = 0; c < size; c++) if (wet[c]) recv[c] = flood.tree[c]
  let acc = flowAccumulation(recv, flood.order, size)

  // --- 5. the lakes as ellipses -----------------------------------------------
  const lakes = kept.map((b) => fitLake(b, elev, n, cell, half))
  lakes.sort((a, b) => b.km2 - a.km2)
  const lakeRecs = lakes.flatMap((l) => l.recs)
  stats.lakes = { candidates: stats.basins.basins, spared: emptied.lakes.length, drained, count: lakes.length, records: lakeRecs.length, km2: lakes.reduce((s, l) => s + l.km2, 0), leakKm2: lakes.reduce((s, l) => s + l.leakKm2, 0), leakDeepest: lakes.reduce((s, l) => Math.max(s, l.leakDeep), 0), dryKm2: lakes.reduce((s, l) => s + l.dryKm2, 0), dryDeepest: lakes.reduce((s, l) => Math.max(s, l.dryDeepest), 0), bodies: lakes.map(({ recs, ...rest }) => rest) }

  // --- 6. rivers --------------------------------------------------------------
  const river = new Uint8Array(size)
  // The marking is read off the route twice, because the join below changes where the water goes: a line the join emptied falls under the catchment and is no longer a river at all.
  const markRivers = () => {
    let cells = 0
    for (let c = 0; c < size; c++) {
      const r = !sea[c] && !wet[c] && acc[c] * cellArea >= RIVERS.minCatchment ? 1 : 0
      river[c] = r
      cells += r
    }
    return cells
  }
  markRivers()
  stats.joins = joinRivers(river, recv, acc, flood.order, wet, sea, elev, n, cell)
  if (stats.joins.joined) acc = flowAccumulation(recv, flood.order, size)
  const riverCells = markRivers()
  const rivers = traceRivers(river, recv, acc, wet, drawnWater(lakeRecs, elev, n, cell, half), elev, n, cell, half, seed)
  let km = 0
  let longest = 0
  let wSum = 0
  let wCells = 0
  let wMax = 0
  // How much wider a river's mouth is than its own average: the shape of a river along its length rather than across it, so it is measured per trunk and then averaged, and only on the trunks that actually reach the sea.
  let flareSum = 0
  let flares = 0
  for (const r of rivers) {
    km += r.km
    if (r.km > longest) longest = r.km
    for (const w of r.widths) {
      wSum += 2 * w
      wCells++
      if (2 * w > wMax) wMax = 2 * w
    }
    if (r.into === 'sea' && r.widths.length > 1) {
      const mean = r.widths.reduce((s, w) => s + w, 0) / r.widths.length
      if (mean > 0) {
        flareSum += r.widths[r.widths.length - 1] / mean
        flares++
      }
    }
  }
  stats.rivers = { count: rivers.length, cells: riverCells, km, longestKm: longest, intoSea: rivers.filter((r) => r.into === 'sea').length, intoLake: rivers.filter((r) => r.into === 'lake').length, fromLake: rivers.filter((r) => r.fromLake).length, widthMean: wCells ? wSum / wCells : 0, widthMax: wMax, flare: flares ? flareSum / flares : 0 }

  return { height: elev, lakes: lakeRecs, rivers: rivers.map((r) => r.rec), stats }
}

/**
 * Step D switched off: the raw field passed straight through, with the stats record every stage would have filled in, all zero. Every key the map page and the gate read is here, because a missing one reads as `undefined` and prints as NaN rather than failing.
 */
export function noHydrology(height) {
  return {
    height: Float32Array.from(height),
    lakes: [],
    rivers: [],
    stats: {
      basins: { basins: 0, kept: 0, bodies: 0, drained: 0, drainedDeepest: 0, drowned: 0, absorbed: 0, lost: 0, perched: 0, ponds: 0, stuck: 0, cuts: 0, roundMean: 0, roundMax: 0, brushMean: 0, brushMax: 0, keptKm2: 0, keptDeepest: 0, cutCells: 0, cutKm2: 0, cutMean: 0, deepest: 0, raised: 0, sweeps: 0, late: 0, left: 0, ms: 0 },
      cliffs: { cells: 0, km2: 0, meanMove: 0, maxMove: 0, ms: 0, byBiome: [] },
      puddles: { cells: 0, km2: 0, mean: 0, deepest: 0 },
      stranded: { cells: 0, km2: 0, deepest: 0 },
      lakes: { candidates: 0, spared: 0, drained: 0, count: 0, records: 0, km2: 0, leakKm2: 0, leakDeepest: 0, dryKm2: 0, dryDeepest: 0, bodies: [] },
      joins: { joined: 0, gapMean: 0 },
      rivers: { count: 0, cells: 0, km: 0, longestKm: 0, intoSea: 0, intoLake: 0, fromLake: 0, widthMean: 0, widthMax: 0, flare: 0 },
    },
  }
}

/** The open water of a body: the cells under the level the body's surface would reach if it held no more than `maxCells`. A whole bowl at its spill is a drowned valley with a dozen arms, and an ellipse fitted to the arms lies over the ground between them; the pool is the part of it that reads as a lake. */
function poolOf(cells, elev, level, maxCells) {
  const sorted = Array.from(cells).sort((a, b) => elev[a] - elev[b])
  const at = Math.min(maxCells, sorted.length) - 1
  const top = Math.min(level, elev[sorted[at]])
  const pool = []
  for (const c of sorted) {
    if (elev[c] >= top) break
    pool.push(c)
  }
  return pool.length ? pool : [sorted[0]]
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

/** A lake record over a flooded body: the ellipse of its deep pool's principal axes, grown until every pool cell is inside, at the body's level. The pool and not the whole body, because a bowl's shallow arms stretch the ellipse over the ground beside it: `leakKm2` is ground inside the ellipse but outside the body that lies under the level -- water v2 will draw that is not the lake -- and `dryKm2` the body outside the ellipse, hollows v2 will leave dry, `dryDeepest` the deepest of them. */
function fitLake(body, elev, n, cell, half) {
  const { cells: body_, pool, level } = body
  let deepest = 0
  for (const c of body_) if (level - elev[c] > deepest) deepest = level - elev[c]
  const inBody = new Set(body_)
  const deep = body_.filter((c) => level - elev[c] >= LAKES.holdDepth)

  // Cut the worst spiller in two and fit each half again, while one still draws water over `spill` metres deep outside the body. The ellipse round a forked pool covers the ridge between its arms and the hollows past them; splitting the pool along that ellipse's major axis puts each arm in an ellipse of its own, which is the cheap half of the fix.
  let parts = [fitPart(pool, deep, elev, n, level, inBody)]
  while (parts.length < LAKES.splitMax) {
    let worst = -1
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].pool.length < LAKES.splitMin * 2) continue
      if (parts[i].leakDeep <= LAKES.spill) continue
      if (worst < 0 || parts[i].leakDeep > parts[worst].leakDeep) worst = i
    }
    if (worst < 0) break
    const p = parts[worst]
    const side = (c) => p.cr * ((c % n) - p.mx) + p.sr * (((c / n) | 0) - p.mz) >= 0
    const halves = [true, false].map((k) => ({ pool: p.pool.filter((c) => side(c) === k), deep: p.deep.filter((c) => side(c) === k) }))
    if (halves.some((h) => h.pool.length < LAKES.splitMin)) break
    parts.splice(worst, 1, ...halves.map((h) => fitPart(h.pool, h.deep, elev, n, level, inBody)))
  }
  // Then what splitting could not fix is pulled in, and what stops it is the other wrong. Shrinking takes back water drawn OUTSIDE the lake and gives up water INSIDE it, so a part shrinks only while what it draws outside stands deeper than what it would leave undrawn inside: a shallow sheet on the hillside is not worth a deep hollow of bed drawn as ground, and a deep sheet is worth a shallow one. The two figures are `leakDeepest` and `dryDeepest` below.
  for (const q of parts) {
    let rounds = 0
    while (q.leakDeep > LAKES.spill && rounds++ < 120) {
      const a0 = q.a
      const b0 = q.b
      q.a *= LAKES.shrink
      q.b *= LAKES.shrink
      if (dropped(q, parts, elev, n, level) >= q.leakDeep) {
        q.a = a0
        q.b = b0
        break
      }
      scanLeak(q, elev, n, level, inBody)
    }
  }
  // A part the shrinking took off the body altogether draws nothing and is dropped, so the doc carries no record that covers no water.
  if (parts.length > 1) {
    const live = parts.filter((q) => q.pool.some((c) => inEllipse(q, c, n)))
    if (live.length) parts = live
  }
  parts.sort((x, y) => y.a * y.b - x.a * x.b)

  // The union is what gets drawn, so the leak and the dry ground are measured against all of the ellipses together and not one at a time.
  let dry = 0
  let dryDeepest = 0
  for (const c of body_) {
    if (parts.some((q) => inEllipse(q, c, n))) continue
    dry++
    if (level - elev[c] > dryDeepest) dryDeepest = level - elev[c]
  }
  let i0 = n
  let i1 = 0
  let j0 = n
  let j1 = 0
  for (const q of parts) {
    const reach = Math.ceil(Math.max(q.a, q.b))
    i0 = Math.min(i0, Math.max(0, Math.floor(q.mx - reach)))
    i1 = Math.max(i1, Math.min(n - 1, Math.ceil(q.mx + reach)))
    j0 = Math.min(j0, Math.max(0, Math.floor(q.mz - reach)))
    j1 = Math.max(j1, Math.min(n - 1, Math.ceil(q.mz + reach)))
  }
  let leak = 0
  let leakDeep = 0
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * n + i
      if (elev[c] >= level || inBody.has(c)) continue
      if (!parts.some((q) => inEllipse(q, c, n))) continue
      leak++
      if (level - elev[c] > leakDeep) leakDeep = level - elev[c]
    }
  }

  const at = (q) => ({ x: q.mx * cell - half, z: q.mz * cell - half, rx: q.a * cell, rz: q.b * cell, rot: q.rot })
  const first = at(parts[0])
  return {
    ...first,
    level,
    parts: parts.length,
    km2: (body_.length * cell * cell) / 1e6,
    leakKm2: (leak * cell * cell) / 1e6,
    leakDeep,
    dryKm2: (dry * cell * cell) / 1e6,
    dryDeepest,
    deepest,
    recs: parts.map((q) => {
      const e = at(q)
      return { x: round1(e.x), z: round1(e.z), y: round2(level), rx: round1(e.rx), rz: round1(e.rz), rot: Math.round(e.rot * 1000) / 1000, shape: 0, carve: 0, depth: round1(Math.max(1, deepest)) }
    }),
  }
}

/**
 * The texels v2 actually draws lake water on: inside a record's ellipse with the ground STRICTLY under that record's level. It is read off the finished records and not off the flooded bodies, because the fitting shrinks an ellipse back off water it would otherwise draw on the hillside, and a cell the record misses is dry ground however wet the body was. A cell exactly at the waterline is not drawn either, which is why a river that steps a single cell into a lake still begins off the water.
 */
function drawnWater(recs, elev, n, cell, half) {
  const drawn = new Uint8Array(n * n)
  for (const l of recs) {
    const cr = Math.cos(l.rot)
    const sr = Math.sin(l.rot)
    const mx = (l.x + half) / cell
    const mz = (l.z + half) / cell
    const a = l.rx / cell
    const b = l.rz / cell
    const reach = Math.ceil(Math.max(a, b)) + 1
    for (let j = Math.max(0, Math.floor(mz - reach)); j <= Math.min(n - 1, Math.ceil(mz + reach)); j++) {
      for (let i = Math.max(0, Math.floor(mx - reach)); i <= Math.min(n - 1, Math.ceil(mx + reach)); i++) {
        const c = j * n + i
        if (drawn[c] || elev[c] >= l.y) continue
        const u = (cr * (i - mx) + sr * (j - mz)) / a
        const v = (-sr * (i - mx) + cr * (j - mz)) / b
        if (u * u + v * v < 1) drawn[c] = 1
      }
    }
  }
  return drawn
}

/** Is cell `c` inside the fitted part `q`? */
function inEllipse(q, c, n) {
  const dx = (c % n) - q.mx
  const dz = ((c / n) | 0) - q.mz
  const u = (q.cr * dx + q.sr * dz) / q.a
  const v = (-q.sr * dx + q.cr * dz) / q.b
  return u * u + v * v <= 1
}

/**
 * One ellipse over one set of pool cells: the principal axes of their second moments, grown until all but the outlying LAKES.cover of them is inside and `deep` -- the water this part is answerable for that is deeper than holdDepth -- is inside whatever that costs. `leak` comes back in cells, for the split test.
 */
function fitPart(pool, deep, elev, n, level, inBody) {
  let mx = 0
  let mz = 0
  for (const c of pool) {
    mx += c % n
    mz += (c / n) | 0
  }
  mx /= pool.length
  mz /= pool.length
  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const c of pool) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  sxx /= pool.length
  sxz /= pool.length
  szz /= pool.length
  // The doc's `rot` turns the query INTO the lake's frame by (cos, sin; -sin, cos), so the frame's x axis is the world direction (cos rot, sin rot): the major eigenvector's angle is the rotation itself.
  const rot = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const l1 = cr * cr * sxx + 2 * cr * sr * sxz + sr * sr * szz
  const l2 = sr * sr * sxx - 2 * cr * sr * sxz + cr * cr * szz
  // A uniform ellipse's variance along a semi-axis a is a^2 / 4; then grown until all but the outlying LAKES.cover of the pool is inside, plus half a cell.
  let a = Math.max(2 * Math.sqrt(Math.max(l1, 0)), 0.5)
  let b = Math.max(2 * Math.sqrt(Math.max(l2, 0)), 0.5)
  const q2 = (c) => {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    const u = (cr * dx + sr * dz) / a
    const v = (-sr * dx + cr * dz) / b
    return u * u + v * v
  }
  const qs = Float64Array.from(pool, q2)
  qs.sort()
  let far = qs[Math.min(qs.length - 1, Math.floor((qs.length - 1) * LAKES.cover))]
  for (const c of deep) {
    const q = q2(c)
    if (q > far) far = q
  }
  const grow = Math.sqrt(far) * LAKES.margin
  a = a * grow + 0.5
  b = b * grow + 0.5
  const part = { pool, deep, mx, mz, a, b, cr, sr, rot, leak: 0, leakDeep: 0 }
  scanLeak(part, elev, n, level, inBody)
  return part
}

/** What the part would draw outside the body: `leak` in cells, `leakDeep` in metres at the worst of them. The depth is what the fit is steered by -- a wide shallow spill at the shore is a beach, a narrow deep one is a wall of water. */
function scanLeak(part, elev, n, level, inBody) {
  part.leak = 0
  part.leakDeep = 0
  const reach = Math.ceil(Math.max(part.a, part.b))
  for (let j = Math.max(0, Math.floor(part.mz - reach)); j <= Math.min(n - 1, Math.ceil(part.mz + reach)); j++) {
    for (let i = Math.max(0, Math.floor(part.mx - reach)); i <= Math.min(n - 1, Math.ceil(part.mx + reach)); i++) {
      const c = j * n + i
      if (elev[c] >= level || inBody.has(c) || !inEllipse(part, c, n)) continue
      part.leak++
      const d = level - elev[c]
      if (d > part.leakDeep) part.leakDeep = d
    }
  }
}

/** How deep the water is that the ellipses would leave undrawn if `q` shrank: the deepest cell of the body `q` is answerable for that no ellipse covers. The parts overlap freely, so a cell a sibling draws is drawn, and a part whose whole contribution was its spill may shrink away to nothing. */
function dropped(q, parts, elev, n, level) {
  let d = 0
  for (const c of q.deep) {
    const w = level - elev[c]
    if (w <= d) continue
    if (inEllipse(q, c, n) || parts.some((o) => o !== q && inEllipse(o, c, n))) continue
    d = w
  }
  return d
}

/**
 * TWO RIVERS THAT COME NEAR EACH OTHER ARE ONE RIVER. D8 hands every cell a single receiver, so two channels can run a handful of texels apart either side of a divide no higher than the water and never meet -- and since v2 cuts a bed under each polyline, what gets drawn is two trenches with a thin wall between them. So every river cell looks for a cell of MORE catchment within `joinReach` and drains straight into it. The line below that new junction then carries nothing of its own, falls under `minCatchment` and stops being a river: the two become one where they first came near.
 *
 * Three things disqualify a neighbour. Ground between the two standing more than `joinWall` above the higher of them means two valleys rather than two channels of one, however close they run. Water or sea on the line between them means the join would run a river through a lake. And a cell the water already reaches by a way no more than `joinBend` times as long as the gap is this same channel round a bend rather than another river -- without which every straight reach would short-circuit itself and be cut to every tenth cell. A tributary that has run a hundred metres alongside its trunk fails none of the three: its water's way to the trunk cell beside it is the whole of that run.
 *
 * No edge drawn here can close a loop: `acc` never falls downstream, an edge is only ever drawn towards STRICTLY more of it, and the receiver must come earlier in the flood's own order, which is also the order the accumulation after this reads the cells in and where a receiver visited before its donor would lose that donor's water.
 */
function joinRivers(river, recv, acc, order, wet, sea, elev, n, cell) {
  const size = n * n
  const rank = new Int32Array(size)
  for (let k = 0; k < size; k++) rank[order[k]] = k
  const steps = Math.max(1, Math.round(RIVERS.joinReach / cell))
  const path = new Map()
  let joined = 0
  let gapSum = 0
  for (let c = 0; c < size; c++) {
    if (!river[c]) continue
    const ci = c % n
    const cj = (c / n) | 0
    // The water's own way down from here, as far as any cell in reach could need it. A cell on it is measured against its own gap below.
    path.clear()
    let run = 0
    for (let p = c; ;) {
      const q = recv[p]
      if (q < 0) break
      run += Math.hypot((q % n) - (p % n), ((q / n) | 0) - ((p / n) | 0)) * cell
      if (run > RIVERS.joinBend * RIVERS.joinReach) break
      path.set(q, run)
      p = q
    }
    let best = -1
    let bestGap = Infinity
    for (let dj = -steps; dj <= steps; dj++) {
      for (let di = -steps; di <= steps; di++) {
        const ni = ci + di
        const nj = cj + dj
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
        const d = nj * n + ni
        if (!river[d] || acc[d] <= acc[c] || rank[d] >= rank[c]) continue
        const gap = Math.hypot(di, dj) * cell
        if (gap > RIVERS.joinReach || gap >= bestGap) continue
        if (path.has(d) && path.get(d) <= RIVERS.joinBend * gap) continue
        if (!clearBetween(c, d, wet, sea, elev, n, RIVERS.joinWall)) continue
        best = d
        bestGap = gap
      }
    }
    if (best < 0 || best === recv[c]) continue
    recv[c] = best
    joined++
    gapSum += bestGap
  }
  return { joined, gapMean: joined ? gapSum / joined : 0 }
}

/** Is the ground between two cells low enough and dry enough for them to be one channel? Walks the straight line a texel at a time and fails on any interior cell that is water, sea, or standing more than `wall` above the higher end. */
function clearBetween(a, b, wet, sea, elev, n, wall) {
  const ai = a % n
  const aj = (a / n) | 0
  const bi = b % n
  const bj = (b / n) | 0
  const hops = Math.max(Math.abs(bi - ai), Math.abs(bj - aj))
  const top = Math.max(elev[a], elev[b]) + wall
  for (let k = 1; k < hops; k++) {
    const q = Math.round(aj + ((bj - aj) * k) / hops) * n + Math.round(ai + ((bi - ai) * k) / hops)
    if (wet[q] || sea[q] || elev[q] > top) return false
  }
  return true
}

/**
 * WHERE A RIVER LEAVING A LAKE BEGINS. The source's own wet neighbour sits on the waterline: `wet` takes a cell at exactly the lake's level, and that cell is not one the lake is drawn on, which needs the ground strictly under the level and the cell inside the fitted ellipse the fitting has shrunk back. A first node there leaves the two sheets a few metres apart with dry ground between them.
 *
 * So the walk carries on INTO the lake, up the flood tree by the wettest cell draining into the one it is at -- which is the lake's main inflow and so its open water rather than a shallow arm -- and stops at the first cell lying `lakeEntry` clear of the drawn edge on every side. The river's first leg is then a chord of open water: v2 pins it to the lake's level and cuts its bed under the surface, so the channel blends out of the lake instead of starting short of it.
 *
 * Where `lakeWalk` of lake turns up no cell that clear of the edge, the first DRAWN cell on the walk will do: a node just inside the sheet still touches it, and a narrow arm is never `lakeEntry` from its own banks. Returns -1 for a source no lake feeds, and the waterline cell as before where the walk draws nothing at all.
 */
function lakeEntryOf(src, recv, acc, wet, drawn, n, cell) {
  const wettestInto = (p) => {
    let best = -1
    for (let k = 0; k < 8; k++) {
      const ni = (p % n) + NB_DI[k]
      const nj = ((p / n) | 0) + NB_DJ[k]
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
      const nn = nj * n + ni
      if (recv[nn] === p && wet[nn] && (best < 0 || acc[nn] > acc[best])) best = nn
    }
    return best
  }
  const edge = Math.max(1, Math.round(RIVERS.lakeEntry / cell))
  const wellIn = (c) => {
    const ci = c % n
    const cj = (c / n) | 0
    if (ci < edge || cj < edge || ci >= n - edge || cj >= n - edge) return false
    for (let dj = -edge; dj <= edge; dj++) for (let di = -edge; di <= edge; di++) if (!drawn[(cj + dj) * n + ci + di]) return false
    return true
  }
  const first = wettestInto(src)
  if (first < 0) return -1
  let p = first
  let walked = 0
  let edged = -1
  while (walked <= RIVERS.lakeWalk) {
    if (wellIn(p)) return p
    if (edged < 0 && drawn[p]) edged = p
    const q = wettestInto(p)
    if (q < 0) break
    walked += Math.hypot((q % n) - (p % n), ((q / n) | 0) - ((p / n) | 0)) * cell
    p = q
  }
  return edged >= 0 ? edged : first
}

/**
 * The river polylines. Donors are gathered per cell; every mouth (a river cell whose receiver is not one) is walked up its largest donor to a source, and each other donor met on the way is the mouth of a tributary, walked the same way. A river ends one cell past its mouth -- in the sea, in a lake, or on the trunk cell it joins -- and begins inside the lake that feeds it (`lakeEntryOf`), so v2 pins its level to the water at either end.
 */
function traceRivers(river, recv, acc, wet, drawn, elev, n, cell, half, seed) {
  const size = n * n
  const wobN = new Noise((seed * 7 + 971) | 0)
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
    const src = cells[0]
    const fromLake = lakeEntryOf(src, recv, acc, wet, drawn, n, cell)
    let km = 0
    for (let k = 1; k < cells.length; k++) km += Math.hypot((cells[k] % n) - (cells[k - 1] % n), ((cells[k] / n) | 0) - ((cells[k - 1] / n) | 0)) * cell
    // A stub joining a trunk with nothing of its own is not drawn; one with branches is, or they would end on nothing.
    if (km * 1000 < RIVERS.minLength && branches.length === 0 && head.into === 'river') continue
    heads.push(...branches)
    const widths = widthsOf(cells, acc, elev, n, cell, wobN)
    const pts = []
    const pinned = []
    if (fromLake >= 0) pts.push(point(fromLake, widths[0], n, cell, half))
    // The cell a tributary joins at stays a node through the simplification, so the tributary's last point lies on the trunk's line and v2 pins its mouth to the trunk.
    const junctions = new Set(branches.map((b) => b.tail))
    // A fall of more than RIVERS.pinDrop between one cell and the next keeps both of them as nodes. The simplification is in PLAN and reads no elevation at all, so on a straight reach it would drop the lip and the foot of a cliff and leave v2 a chord that its router is free to lay up to RIVERS.tolerance metres to the side -- off the notch the water cut and onto the face beside it. Pinned, the leg over the fall is a couple of cells long and the line stays in the notch.
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      const fall = k + 1 < cells.length ? elev[c] - elev[cells[k + 1]] : 0
      if (junctions.has(c) || fall > RIVERS.pinDrop || (k > 0 && elev[cells[k - 1]] - elev[c] > RIVERS.pinDrop)) pinned.push(pts.length)
      pts.push(point(c, widths[k], n, cell, half))
    }
    if (head.tail >= 0) pts.push(point(head.tail, widths[cells.length - 1], n, cell, half))
    const kept = simplify(pts, RIVERS.tolerance, pinned)
    out.push({ km: km / 1000, into: head.into, fromLake: fromLake >= 0, widths, rec: { pts: kept.map((p) => [round1(p[0]), round1(p[1]), round1(p[2])]) } })
  }
  return out
}

/**
 * The half-width at every cell of one chain, source to mouth. The catchment sets the trend -- and with it the confluence, since two branches meeting is two catchments and needs no term of its own -- the valley's longitudinal grade spreads the water where the floor is flat and pinches it where the ground falls away, and a two-octave noise keeps two reaches of the same size from being the same width. The grade is read over RIVERS.gradeLen of arc on purpose: over a few cells it is the jitter's grade and not the valley's.
 */
function widthsOf(cells, acc, elev, n, cell, wobN) {
  const K = cells.length
  const s = new Float64Array(K)
  for (let k = 1; k < K; k++) s[k] = s[k - 1] + Math.hypot((cells[k] % n) - (cells[k - 1] % n), ((cells[k] / n) | 0) - ((cells[k - 1] / n) | 0)) * cell
  const out = new Float64Array(K)
  const sWob = RIVERS.wobbleScale / cell
  let a = 0
  let b = 0
  for (let k = 0; k < K; k++) {
    while (a < k && s[k] - s[a] > RIVERS.gradeLen / 2) a++
    while (b < K - 1 && s[b] - s[k] < RIVERS.gradeLen / 2) b++
    const run = s[b] - s[a]
    const grade = run > 1 ? Math.abs(elev[cells[a]] - elev[cells[b]]) / run : 0
    const flat = 1 - Math.min(1, grade / RIVERS.steepGrade)
    const ci = cells[k] % n
    const cj = (cells[k] / n) | 0
    const wob = wobN.simplex2(ci / sWob, cj / sWob) * 0.7 + wobN.simplex2(ci / (sWob * 0.4) + 11.7, cj / (sWob * 0.4) - 4.3) * 0.3
    const ratio = Math.max(1, (acc[cells[k]] * cell * cell) / RIVERS.minCatchment)
    const taper = RIVERS.tip + (1 - RIVERS.tip) * ((k + 0.5) / K)
    const w = RIVERS.halfAtMin * Math.pow(ratio, RIVERS.widthExp) * taper * (1 + RIVERS.flatWiden * flat) * (1 + RIVERS.wobble * wob)
    out[k] = Math.min(RIVERS.maxHalf, Math.max(RIVERS.minHalf, w))
  }
  return out
}

function point(c, w, n, cell, half) {
  return [(c % n) * cell - half, ((c / n) | 0) * cell - half, w]
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
