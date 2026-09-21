import { priorityFlood, flowDirections, flowAccumulation } from '../sim/hydrology.js'
import { selectLakes } from '../sim/phase-a.js'
import { NB_DI, NB_DJ } from '../sim/world-grid.js'
import { clamp } from '../sim/mathx.js'
import { erode } from './erosion.js'

// ---------------------------------------------------------------------------
// Step D -- the island drains. Rain is thrown at the raw field and walked to the sea, cutting the valleys (erosion.js); then what still ponds is read, a few of the bowls are kept as lakes and the rest are silted up to their spill, the water is routed, and the rivers come off the network as polylines for the v2 doc. Three-free and DOM-free like the rest of src/v3: the gate runs it in node.
//
//   1. RAIN. EROSION.droplets droplets over the land, each grooving its way down. The field after this is the island's ground.
//   2. LAKES. The bowls a priority flood still finds on land, each filled to LAKES.maxArea of surface or to its spill, whichever comes first, scored by the widest open water in them (Phase A's selectLakes); the widest LAKES.keep are lakes. A lake has no dam: its shore is wherever the ground meets its level.
//   3. SILT. Every other ponded cell is raised to its water's level: a bowl the rain did not cut an outlet for is a bowl it filled. What is left of a lake's bowl above its pool is silted the same way.
//   4. ROUTE. Priority flood, D8 steepest descent, accumulation in cells.
//   5. RIVERS. A cell with RIVERS.minCatchment of catchment, above the sea and outside a lake, is a river cell. The network is walked from every mouth up its largest donor to a source, the other donors becoming tributaries whose last point is the trunk cell they join; a source fed by a lake starts inside it. Cell centres are simplified to RIVERS.tolerance and written with a width from the sqrt of the catchment, source to mouth.
//   6. THE DOC. Each lake is an uncarved ellipse fitted to its pool at its level, so v2 draws water wherever the ground inside the ellipse lies under it, which is the bowl.
// ---------------------------------------------------------------------------

export const LAKES = {
  keep: 12,           // at most this many lakes
  minDepth: 1.5,      // metres a bowl must pond before it is a candidate
  maxArea: 4e6,       // square metres of surface a lake may keep; a bowl is filled to this or to its spill, whichever comes first
  minWidth: 80,       // metres of open water across the widest inscribed disc, under which a candidate is a spider of arms and not a lake
  margin: 1.06,       // the fitted ellipse is scaled by this past the last pool cell
}

export const RIVERS = {
  minCatchment: 5e4,   // square metres draining through a cell before it is a river
  widthAtMin: 1.2,     // metres of water at minCatchment, growing with the square root of the catchment
  maxWidth: 14,
  minLength: 60,       // metres; a shorter tributary with nothing feeding it is not drawn
  tolerance: 5,        // Douglas-Peucker on the cell centres, metres
}

/**
 * `runHydrology(height, n, cell, ground, seed)` -> { height, lakes, rivers, stats }
 *
 * `height` in is the raw field, `ground` the class grid the erosion reads its yield from, `seed` what the rain falls by; `height` out is a new array, eroded and silted. `lakes` and `rivers` are doc records without ids.
 */
export function runHydrology(height, n, cell, ground, seed) {
  if (ground.length !== height.length) throw new Error(`runHydrology: ground has ${ground.length} texels, the field ${height.length}`)
  if (!Number.isFinite(seed)) throw new Error(`runHydrology: seed must be a finite number, got ${seed}`)
  const size = n * n
  const half = ((n - 1) * cell) / 2
  const cellArea = cell * cell
  const stats = {}

  // --- 1. rain ----------------------------------------------------------------
  const elev = Float32Array.from(height)
  const sea = seaMask(height, n)
  const t0 = Date.now()
  stats.erosion = erode(elev, sea, ground, n, seed)
  stats.erosion.ms = Date.now() - t0

  // --- 2. lakes ---------------------------------------------------------------
  // The jitter over the sea leaves bowls in the sea floor too, and they are the widest. The flood is read as the ground itself over the sea, and a coastal pocket the rain opened to the sea is the sea's now, so only the land's bowls are candidates.
  let flood = priorityFlood(elev, n)
  for (let c = 0; c < size; c++) if (flood.filled[c] <= 0) sea[c] = 1
  const filledLand = Float32Array.from(flood.filled)
  for (let c = 0; c < size; c++) if (sea[c]) filledLand[c] = elev[c]
  const picked = selectLakes(elev, filledLand, n, cell, LAKES.keep, LAKES.minDepth, LAKES.maxArea)
  // A chosen bowl is scored on its deep water but kept whole: every cell the flood wets round that pool, up to and including the spill, at the spill's level, so the river out of it leaves from the water and not from a step above it. The rain lays sediment on a bowl's floor up to the water and no higher, so a lake has cells a hair under its level and at it; they are the lake too, or the silt would raise them to a dry flat in the water for the route to run rivers over.
  const wet = new Uint8Array(size)
  const kept = []
  for (const b of picked.chosen) {
    if (b.width < LAKES.minWidth || wet[b.cells[0]]) continue
    const level = filledLand[b.cells[0]]
    const cells = []
    const stack = [b.cells[0]]
    wet[b.cells[0]] = 1
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
    kept.push({ cells, level, pool: b.cells })
  }

  // --- 3. silt ----------------------------------------------------------------
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

  // --- 4. route ---------------------------------------------------------------
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

/** A lake record over a flooded body: the ellipse of the pool's principal axes, grown until every pool cell is inside, at the body's level. `leakKm2` is ground inside the ellipse but outside the body that lies under the level -- water v2 will draw that is not the lake. */
function fitLake(body, elev, n, cell, half) {
  const { cells: body_, level } = body
  const cells = globalThis.POOL_FIT ? body.pool : body_
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
  for (const c of body_) {
    if (level - elev[c] < (globalThis.GROW_DEPTH ?? 0)) continue
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
  const inBody = new Set(body_)
  let dry = 0
  let dryDeep = 0
  for (const c of body_) {
    const dx = (c % n) - mx
    const dz = ((c / n) | 0) - mz
    const u = (cr * dx + sr * dz) / a
    const v = (-sr * dx + cr * dz) / b
    if (u * u + v * v > 1) { dry++; dryDeep = Math.max(dryDeep, level - elev[c]) }
  }
  if (globalThis.POOL_FIT) console.log('dry', dry, 'deepest', dryDeep.toFixed(2))
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
    if (fromLake >= 0 && globalThis.DEBUG_FROMLAKE) console.log('fromLake', (fromLake % n) * cell - half, ((fromLake / n) | 0) * cell - half, 'src', (src % n) * cell - half, ((src / n) | 0) * cell - half, 'acc', acc[fromLake], acc[src], 'cells', cells.length, 'into', head.into)
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
