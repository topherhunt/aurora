import { priorityFlood, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { clamp } from '../sim/mathx.js'
import { runChannels } from './channels.js'
import { table, CLIFFS, CLIFFS_OFF } from './cliffs.js'

// ---------------------------------------------------------------------------
// Step D -- the island drains. The raw field is read by one priority flood and the valley network is cut into it as channels whose width and depth come from the catchment (channels.js); then what still ponds is read, the spared bowls become lakes and the rest is silted up to its spill, the water is routed, and the rivers come off the network as polylines for the v2 doc. Three-free and DOM-free like the rest of src/v3: the gate runs it in node.
//
//   1. CHANNELS. Every bowl, the flow network, and a meandering bed cut along each chain of it. The carve only ever lowers a texel; it spares the bowls that are to be lakes and drains the rest.
//   2. CLIFFS. Bands of the steep ground are snapped onto a ladder of benches, standing their slope up into risers (cliffs.js). It runs here, after the carve so the tabling cannot be cut back into a slope and before everything else so the lakes, the silt, the route and the rivers are all solved on the shape that will be drawn. The field after this is the island's ground.
//   3. LAKES. The bowls the carve spared, grown from their deepest cell to the level the flood now stands them at. A lake has no dam: its shore is wherever the ground meets its level.
//   4. SILT. Every other ponded cell is raised to its water's level: a bowl too small for the carve to reach is a bowl it filled, and a bench the tabling closed off is a flat that drains through its notch. What is left of a lake's bowl above its pool is silted the same way.
//   5. ROUTE. Priority flood, D8 steepest descent, accumulation in cells.
//   6. RIVERS. A cell with RIVERS.minCatchment of catchment, above the sea and outside a lake, is a river cell. The network is walked from every mouth up its largest donor to a source, the other donors becoming tributaries whose last point is the trunk cell they join; a source fed by a lake starts inside it. Cell centres are simplified to RIVERS.tolerance and written with a width from the sqrt of the catchment, source to mouth.
//   7. THE DOC. Each lake is an uncarved ellipse fitted to its pool at its level, so v2 draws water wherever the ground inside the ellipse lies under it, which is the bowl.
// ---------------------------------------------------------------------------

export const LAKES = {
  keep: 12,           // at most this many lakes
  minDepth: 1.5,      // metres a bowl must pond before it is a candidate
  maxArea: 4e6,       // square metres of surface a lake may keep; a bowl is filled to this or to its spill, whichever comes first
  minWidth: 80,       // metres of open water across the widest inscribed disc, under which a candidate is a spider of arms and not a lake
  margin: 1.06,       // the fitted ellipse is scaled by this past the pool cell it is sized to
  cover: 0.985,       // the fraction of pool cells it is sized to hold. Short of 1 because the furthest cell of a curved pool is an outlier that swings the whole ellipse out over the ground at the corners, and a few square metres left dry at the tip of one arm costs far less than that
  holdDepth: 3,       // metres, overriding `cover`: however far out it lies, water this deep is inside the ellipse. A shallow rim drawn as land reads as a beach; a three-metre hole drawn as land reads as a bug
}

export const RIVERS = {
  minCatchment: 5e4,   // square metres draining through a cell before it is a river
  widthAtMin: 1.2,     // metres of water at minCatchment, growing with the square root of the catchment
  maxWidth: 14,
  minLength: 60,       // metres; a shorter tributary with nothing feeding it is not drawn
  tolerance: 5,        // Douglas-Peucker on the cell centres, metres
  pinDrop: 3,          // metres of fall between one cell and the next that keeps both as nodes through it, so a cliff's lip and foot survive in plan
}

/**
 * `runHydrology(height, n, cell, ground, seed, cliffs = true)` -> { height, lakes, rivers, stats }
 *
 * `height` in is the raw field, `ground` the class grid the tabling reads its bands from, `seed` what the meander swirls by; `height` out is a new array, carved and silted. `lakes` and `rivers` are doc records without ids. `cliffs` false runs step 2 with every class's share at zero, which moves nothing.
 */
export function runHydrology(height, n, cell, ground, seed, cliffs = true) {
  if (ground.length !== height.length) throw new Error(`runHydrology: ground has ${ground.length} texels, the field ${height.length}`)
  if (!Number.isFinite(seed)) throw new Error(`runHydrology: seed must be a finite number, got ${seed}`)
  const size = n * n
  const half = ((n - 1) * cell) / 2
  const cellArea = cell * cell
  const maxPoolCells = Math.max(1, Math.round(LAKES.maxArea / cellArea))
  const stats = {}

  // --- 1. channels --------------------------------------------------------------
  const elev = Float32Array.from(height)
  const sea = seaMask(height, n)
  const carved = runChannels(elev, sea, n, cell, seed, LAKES)
  stats.channels = carved.stats

  // --- 2. cliffs --------------------------------------------------------------
  const t1 = Date.now()
  stats.cliffs = table(elev, sea, ground, n, cell, seed, cliffs ? CLIFFS : CLIFFS_OFF)
  stats.cliffs.ms = Date.now() - t1

  // --- 3. lakes ---------------------------------------------------------------
  // The carve already chose which bowls keep their water; this reads what the tabling and the notched outlets left them standing at. A body is every cell the flood wets round the spared bowl's deepest cell, up to and including the new spill, at the spill's level, so the river out of it leaves from the water and not from a step above it. A bowl a neighbouring valley happened to open on its way past is no longer a lake and is counted as drained.
  let flood = priorityFlood(elev, n)
  for (let c = 0; c < size; c++) if (flood.filled[c] <= 0) sea[c] = 1
  const filledLand = Float32Array.from(flood.filled)
  for (let c = 0; c < size; c++) if (sea[c]) filledLand[c] = elev[c]
  const wet = new Uint8Array(size)
  const kept = []
  let drained = 0
  for (const b of carved.spared) {
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

  // --- 4. silt ----------------------------------------------------------------
  let siltCells = 0
  let siltSum = 0
  let siltDeepest = 0
  for (let c = 0; c < size; c++) {
    if (sea[c] || wet[c]) continue
    const d = filledLand[c] - elev[c]
    if (d <= 0) continue
    siltCells++
    siltSum += d
    if (d > siltDeepest) siltDeepest = d
    elev[c] = filledLand[c]
  }
  stats.silt = { cells: siltCells, km2: (siltCells * cellArea) / 1e6, mean: siltCells ? siltSum / siltCells : 0, deepest: siltDeepest }

  // --- 5. route ---------------------------------------------------------------
  flood = priorityFlood(elev, n)
  const recv = flowDirections(flood.filled, flood.tree, n)
  // A lake drains through its spill and nowhere else. Steepest descent off the flat would let the cells beside the spill step straight over the rim into the ground falling away past it, and each such step is a source, so one lake would let out three or four rivers a few cells apart; the flood's tree leads every lake cell to the spill.
  for (let c = 0; c < size; c++) if (wet[c]) recv[c] = flood.tree[c]
  const acc = flowAccumulation(recv, flood.order, size)
  // Nothing but the lakes may pond now: the silt raised every other cell to its water.
  for (let c = 0; c < size; c++) {
    if (sea[c] || wet[c]) continue
    if (flood.filled[c] - elev[c] > 1e-3) throw new Error(`runHydrology: ${(flood.filled[c] - elev[c]).toFixed(2)} m of water still stands outside the lakes at ${((c % n) * cell - half).toFixed(0)},${(((c / n) | 0) * cell - half).toFixed(0)}`)
  }

  // --- 6. the lakes as records ------------------------------------------------
  const lakes = kept.map((b) => fitLake(b, elev, n, cell, half))
  lakes.sort((a, b) => b.km2 - a.km2)
  stats.lakes = { candidates: stats.channels.bowls, spared: carved.spared.length, held: stats.channels.held, drained, count: lakes.length, km2: lakes.reduce((s, l) => s + l.km2, 0), leakKm2: lakes.reduce((s, l) => s + l.leakKm2, 0), dryKm2: lakes.reduce((s, l) => s + l.dryKm2, 0), dryDeepest: lakes.reduce((s, l) => Math.max(s, l.dryDeepest), 0), bodies: lakes.map(({ rec, ...rest }) => rest) }

  // --- 7. rivers --------------------------------------------------------------
  const river = new Uint8Array(size)
  let riverCells = 0
  for (let c = 0; c < size; c++) {
    if (!sea[c] && !wet[c] && acc[c] * cellArea >= RIVERS.minCatchment) {
      river[c] = 1
      riverCells++
    }
  }
  const rivers = traceRivers(river, recv, acc, wet, elev, n, cell, half)
  let km = 0
  let longest = 0
  for (const r of rivers) {
    km += r.km
    if (r.km > longest) longest = r.km
  }
  stats.rivers = { count: rivers.length, cells: riverCells, km, longestKm: longest, intoSea: rivers.filter((r) => r.into === 'sea').length, intoLake: rivers.filter((r) => r.into === 'lake').length, fromLake: rivers.filter((r) => r.fromLake).length }

  return { height: elev, lakes: lakes.map((l) => l.rec), rivers: rivers.map((r) => r.rec), stats }
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
      channels: { bowls: 0, spared: 0, held: 0, chains: 0, samples: 0, cells: 0, km: 0, bendMean: 0, bendMax: 0, walled: 0, notch: 0, cutCells: 0, cutKm2: 0, cutMean: 0, deepest: 0, raised: 0, ms: 0 },
      cliffs: { cells: 0, km2: 0, meanMove: 0, maxMove: 0, ms: 0, byBiome: [] },
      silt: { cells: 0, km2: 0, mean: 0, deepest: 0 },
      lakes: { candidates: 0, spared: 0, held: 0, drained: 0, count: 0, km2: 0, leakKm2: 0, dryKm2: 0, dryDeepest: 0, bodies: [] },
      rivers: { count: 0, cells: 0, km: 0, longestKm: 0, intoSea: 0, intoLake: 0, fromLake: 0 },
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
  const { cells: body_, pool: cells, level } = body
  let deepest = 0
  for (const c of body_) if (level - elev[c] > deepest) deepest = level - elev[c]
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
  // A uniform ellipse's variance along a semi-axis a is a^2 / 4; then grown until all but the outlying LAKES.cover of the pool is inside, plus half a cell.
  let a = Math.max(2 * Math.sqrt(Math.max(l1, 0)), 0.5)
  let b = Math.max(2 * Math.sqrt(Math.max(l2, 0)), 0.5)
  const qs = new Float64Array(cells.length)
  let k = 0
  for (const c of cells) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    const u = (cr * dx + sr * dz) / a
    const v = (-sr * dx + cr * dz) / b
    qs[k++] = u * u + v * v
  }
  qs.sort()
  let far = qs[Math.min(qs.length - 1, Math.floor((qs.length - 1) * LAKES.cover))]
  for (const c of body_) {
    if (level - elev[c] < LAKES.holdDepth) continue
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
  const inBody = new Set(body_)
  let dry = 0
  let dryDeepest = 0
  for (const c of body_) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    const u = (cr * dx + sr * dz) / a
    const v = (-sr * dx + cr * dz) / b
    if (u * u + v * v <= 1) continue
    dry++
    if (level - elev[c] > dryDeepest) dryDeepest = level - elev[c]
  }
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
    km2: (body_.length * cell * cell) / 1e6,
    leakKm2: (leak * cell * cell) / 1e6,
    dryKm2: (dry * cell * cell) / 1e6,
    dryDeepest,
    deepest,
    rec: { x: round1(x), z: round1(z), y: round2(level), rx: round1(rx), rz: round1(rz), rot: Math.round(rot * 1000) / 1000, shape: 0, carve: 0, depth: round1(Math.max(1, deepest)) },
  }
}

/**
 * The river polylines. Donors are gathered per cell; every mouth (a river cell whose receiver is not one) is walked up its largest donor to a source, and each other donor met on the way is the mouth of a tributary, walked the same way. A river ends one cell past its mouth -- in the sea, in a lake, or on the trunk cell it joins -- and begins one cell early when its source is fed by a lake, so v2 pins its level to the water at either end.
 */
function traceRivers(river, recv, acc, wet, elev, n, cell, half) {
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
    // A fall of more than RIVERS.pinDrop between one cell and the next keeps both of them as nodes. The simplification is in PLAN and reads no elevation at all, so on a straight reach it would drop the lip and the foot of a cliff and leave v2 a chord that its router is free to lay up to RIVERS.tolerance metres to the side -- off the notch the water cut and onto the face beside it. Pinned, the leg over the fall is a couple of cells long and the line stays in the notch.
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k]
      const fall = k + 1 < cells.length ? elev[c] - elev[cells[k + 1]] : 0
      if (junctions.has(c) || fall > RIVERS.pinDrop || (k > 0 && elev[cells[k - 1]] - elev[c] > RIVERS.pinDrop)) pinned.push(pts.length)
      pts.push(point(c, acc[c], n, cell, half))
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
