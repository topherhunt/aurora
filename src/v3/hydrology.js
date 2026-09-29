import { priorityFlood, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { drainBasins, BASINS } from './basins.js'
import { table, CLIFFS, CLIFFS_OFF } from './cliffs.js'
import { Noise } from '../sim/noise.js'
import { ringArea, inRing, simplifyRing, spaced, ringBox } from '../sim/rings.js'

// ---------------------------------------------------------------------------
// Step D -- the island drains. Every basin the jitter left is emptied with a broad rim dish except the deepest handful (basins.js); what still ponds is then read, the kept basins become lakes, the water is routed, and the rivers come off the flow network as polylines for the v2 doc. Three-free and DOM-free like the rest of src/v3: the gate runs it in node.
//
// ONE STEP MOVES THE FIELD AND IT ONLY EVER LOWERS IT: the drain's rim dish. Nothing here raises ground and nothing else here cuts any, so a texel's height is the jitter's own unless the drain took a rim off it. What the drain leaves standing under a metre is left standing -- a puddle the doc does not draw, measured in `stats.puddles` and otherwise untouched. `stats.stranded` is the other thing the drain leaves: water it had counted as a kept lake's that the finished field ponds on its own, below that lake's level, which the lake walk cannot admit either.
//
//   1. BASINS. Every enclosed dip more than a metre deep, ranked on depth alone. The deepest BASINS.keep hold their water down to BASINS.keepDepth; the rest are drained by cutting their lowest rim point with a dish half the pond's width across, over and over, each round on the new rim point.
//   2. CLIFFS. Bands of the steep ground are snapped onto a ladder of benches, standing their slope up into risers (cliffs.js). Off by default (generate.js STEPS), and the one thing in step D that lifts a texel when it is on. It runs before everything else so the lakes, the route and the rivers are all solved on the shape that will be drawn. The field after this is the island's ground.
//   3. LAKES. The basins the drain kept, grown from their deepest cell to the level the flood now stands them at. A lake has no dam: its shore is wherever the ground meets its level, which is why no two of them are the same shape.
//   4. ROUTE. Priority flood, D8 steepest descent, accumulation in cells. What ponds outside the lakes is measured on the way past and left where it is.
//   5. THE LAKES AS RINGS. Each lake goes to the doc as one uncarved record carrying its own shore: the contour round the texels its water covers, simplified to LAKES.tolerance and cut into segments of at most LAKES.spacing. v2 triangulates that ring and reads no ground of its own, so what is drawn is exactly what flooded -- a dip beside the lake that the water does not reach is not drawn, and a bay is not left dry.
//   6. RIVERS. A cell with RIVERS.minCatchment of catchment, above the sea and outside a lake, is a river cell. Where two of them come within RIVERS.joinReach with no wall between, the one carrying less water drains into the one carrying more, so two channels a few texels apart become one river at the point they first came near. The network is walked from every mouth up its largest donor to a source, the other donors becoming tributaries whose last point is the trunk cell they join; a source fed by a lake starts inside it. Cell centres are simplified to RIVERS.tolerance and written with a half-width off the catchment, the valley's flatness and a noise, source to mouth. The polyline and its widths are all that go to the doc: v2 cuts the bed at render time (§2 paths.js carveRivers), so the valley a river runs in is v2's and not this file's.
// ---------------------------------------------------------------------------

export const LAKES = {
  minDepth: 1.5,      // metres a kept basin must still pond after the drain to be drawn as a lake
  spacing: 10,        // metres between shore vertices at the most. A straight bank is a run of 10 m segments and a crooked one is cut finer by the simplification below, which is what 'finer where the shore is complicated' means in practice
  tolerance: 1.5,     // metres a simplified shore may move off the traced waterline. It never goes under three quarters of a texel: the contour round a grid of cells is a staircase half a texel tall, and a tolerance finer than that keeps every stair as a vertex
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
  wobble: 0.1,         // the share of its width a reach wanders by along the line, so no river holds one width for long and its two banks are never parallel
  wobbleScale: 40,     // metres over which that wander turns. Short on purpose: over hundreds of metres the catchment and the valley's grade already vary the width, and what they cannot give is a bank that changes every few tens of metres
  meander: 2.5,        // how many channel widths a reach wanders SIDEWAYS off the line the steepest descent took. D8 walks a river down eight headings and the simplification straightens what is left, so without this a river is a chain of long diagonals; with it the line bends inside its own valley floor
  meanderScale: 130,   // metres of arc the main bend turns over, with a second octave at a third of it for the small ones
  meanderClimb: 1.5,   // metres of relief the offset line may stand off the channel it came from, either way. THIS IS WHAT PUTS THE CURVES ON THE FLATS: on a floodplain the ground beside the channel is level with it and the bend runs to its full amplitude, in a gorge the wall stops it within a metre or two, and no separate flatness term is needed. That a bend may not sit far BELOW its channel either is the same rule read the other way -- a node drawn down into a side hollow is one the node after it has to climb out of (`descend`)
  meanderEnds: 40,     // metres of arc at each end over which the offset eases to nothing, so a source stays in its lake and a mouth on the water or the trunk it joins
  bendRate: 0.5,       // metres the offset may change per metre of channel (`limitBends`). UNDER 1 THE LINE CANNOT FOLD BACK ON ITSELF: the drawn step is the channel's step plus the change in offset, so at 1 the two cancel and the river is drawn standing still. Half of it leaves every drawn step within 30 degrees of the channel it came from, which is what stops a D8 heading swinging 45 degrees in one cell from swinging the whole amplitude with it
  flare: 0.2,          // how much of itself again the water gains at a mouth entering standing water. It stands ON TOP of the taper, which already puts a mouth 1.6 times the river's own mean, so this is what takes it to the 1.86 measured
  spout: 0.5,          // the same at a source leaving a lake, where the taper is pulling the other way: `tip` makes a source the narrowest point of its river, and the outlet of a lake is as wide as the lake lets it be rather than a trickle, so this end needs the bigger share to come out wider than the reach below it. A source no lake feeds keeps its tiny tip
  flareLen: 30,        // metres of arc either flare eases out over
  minLength: 60,       // metres; a shorter tributary with nothing feeding it is not drawn
  joinReach: 20,       // metres within which two rivers are near enough to be one and the smaller is turned into the bigger
  joinWall: 3,         // metres the ground between the two may stand above the higher of them. Over this they are two valleys and not two channels of one, however close they run
  joinBend: 2.5,       // how many times the gap between two cells the water's own way from one to the other may be before they stop being the same channel round a bend and count as two rivers side by side
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
    kept.push({ cells, level })
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

  // Where each lake lets its water out: a wet cell the flood's tree sends to dry ground. The river out of the lake begins exactly there (`outletOf`), so the shore has to keep that texel inside it and the ring below is told not to simplify it away. The join in step 6 rewires river cells only and never a wet one, so this list does not go stale.
  const spills = []
  for (let c = 0; c < size; c++) if (wet[c] && recv[c] >= 0 && !wet[recv[c]]) spills.push(c)

  // --- 5. the lakes as rings --------------------------------------------------
  const lakes = kept.map((b) => ringLake(b, elev, n, cell, half, spills))
  lakes.sort((a, b) => b.km2 - a.km2)
  const lakeRecs = lakes.map((l) => l.rec)
  stats.lakes = { candidates: stats.basins.basins, spared: emptied.lakes.length, drained, count: lakes.length, records: lakeRecs.length, km2: lakes.reduce((s, l) => s + l.km2, 0), vertices: lakes.reduce((s, l) => s + l.vertices, 0), islands: lakes.reduce((s, l) => s + l.islands, 0), spanMax: lakes.reduce((s, l) => Math.max(s, l.spanMax), 0), offKm2: lakes.reduce((s, l) => s + l.offKm2, 0), bodies: lakes.map(({ rec, ...rest }) => rest) }

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
  const rivers = traceRivers(river, recv, acc, wet, elev, n, cell, half, seed)
  let km = 0
  let longest = 0
  let wSum = 0
  let wCells = 0
  let wMax = 0
  // How much wider a river's mouth is than its own average: the shape of a river along its length rather than across it, so it is measured per trunk and then averaged, and only on the trunks that actually reach the sea.
  let flareSum = 0
  let flares = 0
  // How much a bank wavers along one reach: the share the wobble added to or took off the width at each cell, straight off the term that did it rather than inferred from the profile, where the catchment's own trend and the flares would swamp it. `waverMax` is the bound the knob sets -- the +/- the banks are allowed.
  let wavSum = 0
  let wavCells = 0
  let wavMax = 0
  let sinSum = 0
  let bendSum = 0
  let bendMax = 0
  for (const r of rivers) {
    km += r.km
    if (r.km > longest) longest = r.km
    sinSum += r.sinuosity
    bendSum += r.bend
    if (r.bendMax > bendMax) bendMax = r.bendMax
    const W = r.widths
    for (let k = 0; k < W.length; k++) {
      wSum += 2 * W[k]
      wCells++
      if (2 * W[k] > wMax) wMax = 2 * W[k]
      const a = Math.abs(r.share[k])
      wavSum += a
      wavCells++
      if (a > wavMax) wavMax = a
    }
    if (r.into === 'sea' && W.length > 1) {
      const mean = W.reduce((s, w) => s + w, 0) / W.length
      if (mean > 0) {
        flareSum += W[W.length - 1] / mean
        flares++
      }
    }
  }
  stats.rivers = { count: rivers.length, cells: riverCells, km, longestKm: longest, intoSea: rivers.filter((r) => r.into === 'sea').length, intoLake: rivers.filter((r) => r.into === 'lake').length, fromLake: rivers.filter((r) => r.fromLake).length, widthMean: wCells ? wSum / wCells : 0, widthMax: wMax, flare: flares ? flareSum / flares : 0, waver: wavCells ? wavSum / wavCells : 0, waverMax: wavMax, sinuosity: rivers.length ? sinSum / rivers.length : 0, bend: rivers.length ? bendSum / rivers.length : 0, bendMax }

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
      lakes: { candidates: 0, spared: 0, drained: 0, count: 0, records: 0, km2: 0, vertices: 0, islands: 0, spanMax: 0, offKm2: 0, bodies: [] },
      joins: { joined: 0, gapMean: 0 },
      rivers: { count: 0, cells: 0, km: 0, longestKm: 0, intoSea: 0, intoLake: 0, fromLake: 0, widthMean: 0, widthMax: 0, flare: 0, waver: 0, waverMax: 0, sinuosity: 0, bend: 0, bendMax: 0 },
    },
  }
}

/**
 * A LAKE IS THE TEXELS ITS WATER COVERS, AND ITS SHORE IS THE LINE ROUND THEM. The body walk in step 3 already knows every one of those texels; this traces the boundary of that set and bakes it into the record, so v2 draws the lake by triangulating the ring and never by asking the ground a second time.
 *
 * WHY NOT AN ELLIPSE. An ellipse fitted to a pool is a guess at the shore that v2 then has to correct by contouring the ground inside it, and the two disagree in ways the eye catches at once: a dip beside the lake that lies under the level is inside the ellipse, so it is drawn as a sheet of water with dry ground between it and the lake; an arm that reaches past the fit is left dry; and nothing about the fit can tell a hollow the water reaches from one it does not, because the ellipse does not know which cells are connected. The flood does know. The ring is that knowledge, written down.
 *
 * Marching squares over the cell mask, so every vertex starts on a half-texel between a wet centre and a dry one. Where two wet cells meet corner to corner the contour is resolved in favour of the water, which is how the body was walked (eight neighbours), so one body always comes out as one ring. Then Douglas-Peucker at `tolerance` -- which is what makes a straight bank cheap and a crooked one detailed -- and every remaining segment cut to at most `spacing`.
 */
function ringLake(body, elev, n, cell, half, pins) {
  const { cells, level } = body
  let deepest = 0
  for (const c of cells) if (level - elev[c] > deepest) deepest = level - elev[c]

  // A local mask with a dry texel of margin all round, so every contour closes inside it.
  let i0 = n, i1 = 0, j0 = n, j1 = 0
  for (const c of cells) {
    const ci = c % n
    const cj = (c / n) | 0
    if (ci < i0) i0 = ci
    if (ci > i1) i1 = ci
    if (cj < j0) j0 = cj
    if (cj > j1) j1 = cj
  }
  i0--; j0--; i1++; j1++
  const W = i1 - i0 + 1
  const H = j1 - j0 + 1
  const mask = new Uint8Array(W * H)
  for (const c of cells) mask[((c / n | 0) - j0) * W + (c % n) - i0] = 1

  // The contour, a segment at a time. `wet -> dry` in counter-clockwise corner order is where a segment starts and `dry -> wet` where it ends, which puts the water on the left of every one of them.
  const segs = []
  const byStart = new Map()
  const px = (i, di) => (i0 + i + di) * cell - half
  const pz = (j, dj) => (j0 + j + dj) * cell - half
  for (let j = 0; j + 1 < H; j++) {
    for (let i = 0; i + 1 < W; i++) {
      const a = mask[j * W + i]
      const b = mask[j * W + i + 1]
      const d = mask[(j + 1) * W + i + 1]
      const e = mask[(j + 1) * W + i]
      const code = a + b + d + e
      if (code === 0 || code === 4) continue
      const bottom = { k: (j * W + i) * 2, x: px(i, 0.5), z: pz(j, 0) }
      const right = { k: (j * W + i + 1) * 2 + 1, x: px(i, 1), z: pz(j, 0.5) }
      const top = { k: ((j + 1) * W + i) * 2, x: px(i, 0.5), z: pz(j, 1) }
      const left = { k: (j * W + i) * 2 + 1, x: px(i, 0), z: pz(j, 0.5) }
      const emit = (from, to) => {
        if (byStart.has(from.k)) throw new Error(`ringLake: two shore segments leave the edge between texels at ${from.x},${from.z}`)
        byStart.set(from.k, segs.length)
        segs.push({ from, to })
      }
      // The saddles first: two wet corners touching only at this crossing are ONE body, so the pair of segments is the one that leaves the water joined and cuts the dry corners off.
      if (code === 2 && a === d && b === e) {
        if (a) { emit(bottom, right); emit(top, left) } else { emit(right, top); emit(left, bottom) }
        continue
      }
      const out = []
      const into = []
      if (a && !b) out.push(bottom); else if (!a && b) into.push(bottom)
      if (b && !d) out.push(right); else if (!b && d) into.push(right)
      if (d && !e) out.push(top); else if (!d && e) into.push(top)
      if (e && !a) out.push(left); else if (!e && a) into.push(left)
      emit(out[0], into[0])
    }
  }

  // The spills this body lets a river out of. Every vertex on the boundary of one survives the simplification: a shore that cuts that corner leaves the river's own first node outside the water it starts in. A contour vertex sits half a texel from the centre it belongs to, so the test is a radius and not an index.
  const held = []
  for (const c of pins) if (mask[((c / n | 0) - j0) * W + (c % n) - i0] === 1) held.push((c % n) * cell - half, ((c / n) | 0) * cell - half)
  const reach = cell * 0.6

  // Chained into closed rings, then simplified and evenly cut.
  const tol = Math.max(LAKES.tolerance, cell * 0.75)
  const rings = []
  const used = new Uint8Array(segs.length)
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    const pts = []
    const pinned = []
    let at = i
    do {
      used[at] = 1
      const p = segs[at].from
      for (let h = 0; h < held.length; h += 2) {
        if (Math.abs(p.x - held[h]) < reach && Math.abs(p.z - held[h + 1]) < reach) {
          pinned.push(pts.length / 2)
          break
        }
      }
      pts.push(p.x, p.z)
      const next = byStart.get(segs[at].to.k)
      if (next === undefined) throw new Error(`ringLake: a shore segment ends in the open at ${segs[at].to.x},${segs[at].to.z}`)
      at = next
    } while (at !== i)
    const ring = spaced(simplifyRing(pts, tol, pinned), LAKES.spacing)
    if (ring.length >= 6) rings.push(ring)
  }
  const outer = rings.filter((r) => ringArea(r) > 0)
  const islands = rings.filter((r) => ringArea(r) < 0)
  if (outer.length !== 1) throw new Error(`ringLake: a lake of ${cells.length} texels traced ${outer.length} shores; the body walk joins diagonals, so it has exactly one`)

  // What the simplification cost, measured against the texels themselves: the texels the ring puts on the wrong side of the waterline, which is the only error a baked shore has. They lie on the shore and nowhere else, so this is a length times `tolerance` and not a hole anywhere in the sheet.
  const box = ringBox(rings)
  let off = 0
  const inside = (x, z) => inRing(outer[0], x, z) && !islands.some((r) => inRing(r, x, z))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const wetHere = mask[(j - j0) * W + i - i0] === 1
      if (wetHere !== inside(i * cell - half, j * cell - half)) off++
    }
  }
  let spanMax = 0
  for (const r of rings) {
    for (let k = 0; k < r.length; k += 2) {
      const m = (k + 2) % r.length
      spanMax = Math.max(spanMax, Math.hypot(r[m] - r[k], r[m + 1] - r[k + 1]))
    }
  }
  const ring = [outer[0], ...islands]
  return {
    level,
    x: round1((box.minX + box.maxX) / 2),
    z: round1((box.minZ + box.maxZ) / 2),
    km2: (cells.length * cell * cell) / 1e6,
    deepest,
    vertices: ring.reduce((t, r) => t + r.length / 2, 0),
    islands: islands.length,
    spanMax,
    offKm2: (off * cell * cell) / 1e6,
    rec: {
      x: round1((box.minX + box.maxX) / 2),
      z: round1((box.minZ + box.maxZ) / 2),
      y: round2(level),
      rx: round1(Math.max(cell / 2, (box.maxX - box.minX) / 2)),
      rz: round1(Math.max(cell / 2, (box.maxZ - box.minZ) / 2)),
      rot: 0,
      shape: 0,
      carve: 0,
      depth: round1(Math.max(1, deepest)),
      ring: ring.map((r) => r.map(round1)),
    },
  }
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
 * WHERE A RIVER LEAVING A LAKE BEGINS: THE LAKE'S OUTLET, one cell inside the water, and nowhere deeper.
 *
 * The outlet is the wettest wet cell draining into the source, and a wet cell is one the flood covered, so it is inside the baked ring and v2's `levelAt` answers the lake's own level there. That is the whole requirement: the first node must sit EXACTLY at the lake's surface. Walking any further up the flood tree puts the node in open water metres below the surface, and v2 cuts a river bed under every node it is given -- which is how a channel came to be gouged across a lake bed and the river to start well under the level it left.
 *
 * Returns -1 for a source no lake feeds.
 */
function outletOf(src, recv, acc, wet, n) {
  let best = -1
  for (let k = 0; k < 8; k++) {
    const ni = (src % n) + NB_DI[k]
    const nj = ((src / n) | 0) + NB_DJ[k]
    if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue
    const nn = nj * n + ni
    if (recv[nn] === src && wet[nn] && (best < 0 || acc[nn] > acc[best])) best = nn
  }
  return best
}

/**
 * The river polylines. Donors are gathered per cell; every mouth (a river cell whose receiver is not one) is walked up its largest donor to a source, and each other donor met on the way is the mouth of a tributary, walked the same way. A river ends one cell past its mouth -- in the sea, in a lake, or on the trunk cell it joins -- and begins at the outlet of the lake that feeds it (`outletOf`), so v2 pins its level to the water at either end.
 *
 * Trunks are traced before their own tributaries, and `bends` carries every offset already given to a cell, so the cell a tributary joins at keeps the trunk's offset and the tributary's last point lands on the trunk's line.
 */
function traceRivers(river, recv, acc, wet, elev, n, cell, half, seed) {
  const size = n * n
  const wobN = new Noise((seed * 7 + 971) | 0)
  const bendN = new Noise((seed * 13 + 4409) | 0)
  const bends = new Map()
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
    const fromLake = outletOf(src, recv, acc, wet, n)
    const arc = arcOf(cells, n, cell)
    const len = arc[arc.length - 1]
    // A stub joining a trunk with nothing of its own is not drawn; one with branches is, or they would end on nothing.
    if (len < RIVERS.minLength && branches.length === 0 && head.into === 'river') continue
    heads.push(...branches)
    const { widths, share } = widthsOf(cells, arc, acc, elev, n, cell, wobN, fromLake >= 0, head.into)
    const offs = bendsOf(cells, arc, widths, elev, wet, n, cell, half, bendN, bends, head.tail)
    let bendSum = 0
    let bendMax = 0
    const apex = new Uint8Array(cells.length)
    const off = new Float64Array(cells.length)
    for (let k = 0; k < cells.length; k++) off[k] = Math.hypot(offs[k * 2], offs[k * 2 + 1])
    // The TOP OF EACH BEND is a node the simplification may not drop. It reads the line in plan against a tolerance of several metres, and a meander whose amplitude is of that order is exactly what it is built to delete -- so the bends would be computed and then straightened back out. Only an apex worth a vertex is pinned: under the tolerance there is nothing to preserve.
    for (let k = 1; k + 1 < cells.length; k++) if (off[k] > RIVERS.tolerance && off[k] >= off[k - 1] && off[k] > off[k + 1]) apex[k] = 1
    const pts = []
    const pinned = []
    // The channel cell each point was drawn off, so the descent pass below knows where to pull a node back to.
    const pcell = []
    if (fromLake >= 0) {
      pts.push(point(fromLake, widths[0], n, cell, half))
      pcell.push(fromLake)
    }
    // The cell a tributary joins at stays a node through the simplification, so the tributary's last point lies on the trunk's line and v2 pins its mouth to the trunk.
    const junctions = new Set(branches.map((b) => b.tail))
    // A fall of more than RIVERS.pinDrop between one cell and the next keeps both of them as nodes. The simplification is in PLAN and reads no elevation at all, so on a straight reach it would drop the lip and the foot of a cliff and leave v2 a chord that its router is free to lay up to RIVERS.tolerance metres to the side -- off the notch the water cut and onto the face beside it. Pinned, the leg over the fall is a couple of cells long and the line stays in the notch.
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      const fall = k + 1 < cells.length ? elev[c] - elev[cells[k + 1]] : 0
      if (apex[k] || junctions.has(c) || fall > RIVERS.pinDrop || (k > 0 && elev[cells[k - 1]] - elev[c] > RIVERS.pinDrop)) pinned.push(pts.length)
      pts.push(point(c, widths[k], n, cell, half, offs[k * 2], offs[k * 2 + 1]))
      pcell.push(c)
    }
    if (head.tail >= 0) {
      const t = bends.get(head.tail)
      pts.push(point(head.tail, widths[cells.length - 1], n, cell, half, t === undefined ? 0 : t[0], t === undefined ? 0 : t[1]))
      pcell.push(head.tail)
    }
    const idx = simplify(pts, RIVERS.tolerance, pinned)
    descend(pts, idx, pcell, elev, n, cell, half, bends)
    const kept = idx.map((i) => pts[i])
    // How far the line that is DRAWN stands off the descent, read at the nodes that survived: the amplitude asked for above is not what is left once the pass has pulled the uphill bends back in.
    for (const i of idx) {
      const d = Math.hypot(pts[i][0] - ((pcell[i] % n) * cell - half), pts[i][1] - (((pcell[i] / n) | 0) * cell - half))
      bendSum += d
      if (d > bendMax) bendMax = d
    }
    // Sinuosity as it is normally meant: the line's own length over the straight line from its source to its mouth. A river down a curved valley is over 1 before any meander is added, so this is read as a trend across a seed and not per river.
    let line = 0
    for (let k = 1; k < kept.length; k++) line += Math.hypot(kept[k][0] - kept[k - 1][0], kept[k][1] - kept[k - 1][1])
    const chord = Math.hypot(kept[kept.length - 1][0] - kept[0][0], kept[kept.length - 1][1] - kept[0][1])
    out.push({ km: len / 1000, into: head.into, fromLake: fromLake >= 0, widths, share, sinuosity: chord > 0 ? line / chord : 1, bend: bendSum / idx.length, bendMax, rec: { pts: kept.map((p) => [round1(p[0]), round1(p[1]), round1(p[2])]) } })
  }
  return out
}

/** Arc length along a cell chain, in metres, from its source. */
function arcOf(cells, n, cell) {
  const s = new Float64Array(cells.length)
  for (let k = 1; k < cells.length; k++) s[k] = s[k - 1] + Math.hypot((cells[k] % n) - (cells[k - 1] % n), ((cells[k] / n) | 0) - ((cells[k - 1] / n) | 0)) * cell
  return s
}

/**
 * THE MEANDERS: how far off the steepest-descent line each cell of one chain is drawn, as an (x, z) offset in metres.
 *
 * The line the route gives is a D8 walk -- eight headings, and the simplification straightens most of what is left -- so on its own a river is a chain of long diagonals with only the valley's own macro curve in it. The offset here is perpendicular to the local heading, two octaves of noise over RIVERS.meanderScale, and as many as RIVERS.meander channel widths at full amplitude, which makes the small bends proportional to the water rather than a fixed wobble on a creek and a trickle alike.
 *
 * Three things hold it down:
 * - THE VALLEY. The offset is cut back by whatever fraction keeps the ground under it within RIVERS.meanderClimb of the channel it came from, so a floodplain lets the bend run and a gorge wall stops it dead. This is the whole of 'more curvature on flat terrain': no flatness term, just the ground refusing to be climbed. Water is refused outright -- a bend does not reach into a lake.
 * - THE ENDS. The offset eases to nothing over RIVERS.meanderEnds at the source, so a river still leaves its lake at the outlet, and at a mouth in standing water; at a mouth on a trunk it eases to the offset that trunk cell already has instead, so the tributary meets the line the trunk is actually drawn along.
 * - THE RATE (`limitBends`). The line may leave its channel no faster than it runs down it, which is what keeps it from folding back on itself.
 * - THE NOISE IS SAMPLED IN WORLD SPACE, not along the arc. Two chains crossing the same cell then want the same offset, which is what keeps a junction from kinking; `bends` pins it exactly, first chain to claim a cell winning.
 */
function bendsOf(cells, arc, widths, elev, wet, n, cell, half, bendN, bends, tail) {
  const K = cells.length
  // The chain's own cells, and after them the cell its mouth joins: the point drawn there is the trunk's own, so the last leg has to obey the rate too.
  const M = tail >= 0 ? K + 1 : K
  const out = new Float64Array(M * 2)
  const fixed = new Uint8Array(M)
  const ds = new Float64Array(M)
  const S = arc[K - 1]
  const L = RIVERS.meanderScale
  const tailOff = bends.get(tail)
  const ex = tailOff === undefined ? 0 : tailOff[0]
  const ez = tailOff === undefined ? 0 : tailOff[1]
  const at = (x, z) => {
    const i = Math.round((x + half) / cell)
    const j = Math.round((z + half) / cell)
    if (i < 0 || j < 0 || i >= n || j >= n) return null
    return j * n + i
  }
  for (let k = 0; k < K; k++) {
    const c = cells[k]
    if (k > 0) ds[k] = arc[k] - arc[k - 1]
    const had = bends.get(c)
    if (had !== undefined) {
      out[k * 2] = had[0]
      out[k * 2 + 1] = had[1]
      fixed[k] = 1
      continue
    }
    const a = cells[Math.max(0, k - 1)]
    const b = cells[Math.min(K - 1, k + 1)]
    let tx = (b % n) - (a % n)
    let tz = ((b / n) | 0) - ((a / n) | 0)
    const tl = Math.hypot(tx, tz)
    let dx = 0
    let dz = 0
    if (tl > 0) {
      tx /= tl
      tz /= tl
      const x = (c % n) * cell - half
      const z = ((c / n) | 0) * cell - half
      const m = bendN.simplex2(x / L, z / L) * 0.7 + bendN.simplex2((x / L) * 3 + 17.3, (z / L) * 3 - 8.1) * 0.3
      const wSrc = Math.min(1, arc[k] / RIVERS.meanderEnds)
      const wEnd = Math.min(1, (S - arc[k]) / RIVERS.meanderEnds)
      let amp = m * RIVERS.meander * 2 * widths[k] * wSrc * wEnd
      // Two passes: the first reads the ground at the full offset and scales by how much of the relief allowance it overspends, the second checks what is left. Smooth in the excess, so the amplitude has no steps in it. The allowance is SYMMETRIC: a bend that drops into a side gully has left the valley floor exactly as one that climbs the wall has, and a node drawn into a hollow is a node the next one has to climb out of.
      for (let pass = 0; pass < 2 && amp !== 0; pass++) {
        const q = at(x - tz * amp, z + tx * amp)
        if (q === null || wet[q]) {
          amp = 0
          break
        }
        const off = Math.abs(elev[q] - elev[c])
        if (off > RIVERS.meanderClimb) amp *= RIVERS.meanderClimb / off
      }
      dx = -tz * amp + ex * (1 - wEnd)
      dz = tx * amp + ez * (1 - wEnd)
    }
    out[k * 2] = dx
    out[k * 2 + 1] = dz
  }
  if (M > K) {
    out[K * 2] = ex
    out[K * 2 + 1] = ez
    fixed[K] = 1
    ds[K] = Math.hypot((tail % n) - (cells[K - 1] % n), ((tail / n) | 0) - ((cells[K - 1] / n) | 0)) * cell
  }
  limitBends(out, fixed, ds, M)
  for (let k = 0; k < K; k++) if (!fixed[k]) bends.set(cells[k], [out[k * 2], out[k * 2 + 1]])
  return out
}

/**
 * THE DRAWN LINE MAY NOT LEAVE ITS CHANNEL FASTER THAN IT RUNS DOWN IT.
 *
 * One cell to the next the channel advances 2 m, or 2.83 on a diagonal, while the offset hung off it can change by far more: the noise is slow, but the offset is PERPENDICULAR to a D8 heading, and that heading swings 45 degrees between two cells with as much as thirty metres of amplitude on the end of it -- so the offset vector sweeps twenty metres while the channel advances two. At a mouth the same thing happens in one step as the offset blends into the trunk's. The step that gets DRAWN is the channel's step plus the change in offset, so once the offset outruns the channel the drawn step points back up the line: the river folds on itself, and v2's ribbon throws on the cusp rather than miter it (§2 render/ribbon.js).
 *
 * Held to RIVERS.bendRate of the channel's own step the drawn step keeps a component along it and the line always advances. The bound is on the offset VECTOR and says nothing about where the offset came from, so it covers the heading, the noise and the junction blend alike. Sweeps alternate direction so that neither end of a reach drags the whole of it, and a cell another chain already drew is an ANCHOR the sweeps may not move -- it is the node that chain is drawn through, and a tributary has to meet it exactly.
 */
function limitBends(out, fixed, ds, M) {
  const pull = (k, from) => {
    const cap = ds[Math.max(k, from)] * RIVERS.bendRate
    const dx = out[k * 2] - out[from * 2]
    const dz = out[k * 2 + 1] - out[from * 2 + 1]
    const d = Math.hypot(dx, dz)
    if (d <= cap || fixed[k]) return 0
    out[k * 2] = out[from * 2] + (dx * cap) / d
    out[k * 2 + 1] = out[from * 2 + 1] + (dz * cap) / d
    return d - cap
  }
  // Each sweep only ever shortens a gap, so this converges; the cap is there for the one case it cannot satisfy, two anchors a single step apart with the trunk's own offset between them.
  for (let sweep = 0; sweep < 8; sweep++) {
    let moved = 0
    for (let k = 1; k < M; k++) moved += pull(k, k - 1)
    for (let k = M - 2; k >= 0; k--) moved += pull(k, k + 1)
    if (moved === 0) break
  }
}

/**
 * THE DRAWN LINE MAY NOT CLIMB WHERE THE CHANNEL DID NOT, over the nodes that are actually kept.
 *
 * Each bend is inside its own relief allowance and that says nothing about a pair of them: two nodes pushed opposite ways off the descent stand metres apart in height, and v2 cuts the bed under the line it is handed (§2 paths.js carveRivers), so the pair is what has to fall. Each kept node is pulled back toward its own channel cell until it stands no higher than the node before it plus whatever the channel itself rose between the two -- a hollow the route crossed on the flooded surface, at most BASINS.pond. The channel cell is always there to fall back on: at no offset at all this is the descent D8 walked.
 *
 * It runs on the SIMPLIFIED line and not on every cell, because the pair that has to fall is the pair that gets drawn. Cell to cell the channel falls by whatever one texel of grade gives -- centimetres at 2 m spacing -- while a bend swings tens of metres sideways onto ground of its own, so a cell-wise rule tightens as the grid gets finer and would sand the meanders off the fine field while leaving them on the coarse one.
 *
 * Two nodes are left alone. The first leg starts inside the lake that feeds it, below its own outlet, and the last node is the mouth: v2 pins it to the sea, to the lake or to the trunk it joins, so the ground under it is nobody's bed -- and on a trunk it carries that trunk's own offset, which is what puts the two lines on the same point.
 */
function descend(pts, idx, pcell, elev, n, cell, half, bends) {
  const ground = (i) => {
    const gx = Math.round((pts[i][0] + half) / cell)
    const gz = Math.round((pts[i][1] + half) / cell)
    if (gx < 0 || gz < 0 || gx >= n || gz >= n) return elev[pcell[i]]
    return elev[gz * n + gx]
  }
  if (idx.length < 4) return
  let prevG = ground(idx[1])
  for (let k = 2; k < idx.length - 1; k++) {
    const i = idx[k]
    const c = pcell[i]
    const cap = prevG + Math.max(0, elev[c] - elev[pcell[idx[k - 1]]])
    const cx = (c % n) * cell - half
    const cz = ((c / n) | 0) * cell - half
    for (let t = 0; t < 6 && ground(i) > cap; t++) {
      pts[i][0] = t === 5 ? cx : cx + (pts[i][0] - cx) * 0.5
      pts[i][1] = t === 5 ? cz : cz + (pts[i][1] - cz) * 0.5
    }
    // The memo carries where the cell is DRAWN, not where the bend asked for it: a tributary traced later joins this cell and has to land on the node the trunk actually ends up with.
    bends.set(c, [pts[i][0] - cx, pts[i][1] - cz])
    prevG = ground(i)
  }
}

/**
 * The half-width at every cell of one chain, source to mouth. The catchment sets the trend -- and with it the confluence, since two branches meeting is two catchments and needs no term of its own -- the valley's longitudinal grade spreads the water where the floor is flat and pinches it where the ground falls away, and a two-octave noise keeps two reaches of the same size from being the same width. The grade is read over RIVERS.gradeLen of arc on purpose: over a few cells it is the jitter's grade and not the valley's.
 *
 * On top of that, both ends flare where they meet standing water: a river leaving a lake starts as that lake's outlet and not as a trickle (`spout`), and one entering a lake or the sea opens out into it (`flare`). Each is a share of the LOCAL width, over RIVERS.flareLen of arc, quadratic so the widening is all in the last few metres. A source no lake feeds keeps its tiny tip.
 */
function widthsOf(cells, s, acc, elev, n, cell, wobN, fromLake, into) {
  const K = cells.length
  const out = new Float64Array(K)
  const share = new Float64Array(K)
  const sWob = RIVERS.wobbleScale / cell
  const flareMouth = into === 'sea' || into === 'lake'
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
    let flare = 0
    if (fromLake && s[k] < RIVERS.flareLen) flare = RIVERS.spout * (1 - s[k] / RIVERS.flareLen) ** 2
    if (flareMouth && s[K - 1] - s[k] < RIVERS.flareLen) flare = Math.max(flare, RIVERS.flare * (1 - (s[K - 1] - s[k]) / RIVERS.flareLen) ** 2)
    share[k] = RIVERS.wobble * wob
    const w = RIVERS.halfAtMin * Math.pow(ratio, RIVERS.widthExp) * taper * (1 + RIVERS.flatWiden * flat) * (1 + share[k]) * (1 + flare)
    out[k] = Math.min(RIVERS.maxHalf, Math.max(RIVERS.minHalf, w))
  }
  return { widths: out, share }
}

function point(c, w, n, cell, half, dx = 0, dz = 0) {
  return [(c % n) * cell - half + dx, ((c / n) | 0) * cell - half + dz, w]
}

/** Douglas-Peucker on an open polyline of [x, z, w], keeping the endpoints and the `pinned` indices. Gives back the indices it kept, not the points: the descent pass afterwards needs to know which cell each surviving node came off. */
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
  const idx = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) idx.push(i)
  return idx
}

const round1 = (v) => Math.round(v * 10) / 10
const round2 = (v) => Math.round(v * 100) / 100
