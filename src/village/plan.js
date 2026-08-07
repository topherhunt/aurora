import { clamp, clamp01, lerp, mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// Village PLANNING. Pure data, no three.js -- same rule as src/sim, and for the
// same two reasons: it has to run in a Web Worker eventually, and it has to be
// gateable from node (scripts/check-village.mjs). Geometry lives in
// village/shapes.js, the runtime in village/village.js.
//
// SITING IS NOT HERE, deliberately. phase-a.js already scores sites on slope,
// openness and distance to fresh water, and the moment lakes and rivers move,
// every site moves with them. This module answers the question that does NOT
// depend on where the village lands: given a patch of ground, what is a village
// MADE of and how is it arranged? It takes a site and a height sampler and
// returns a plan. Feed it phase-a's `villages[]` and it plans those.
//
// The layout is radial, because that is what a village that grew around a
// meeting place actually looks like from the air, and because it gives every
// element a natural home:
//
//   plaza  ->  ring road  ->  dwellings  ->  work buildings  ->  fields
//
// Three rules run through all of it and they are the ones worth keeping if the
// rest is rewritten:
//
//   EVERY DOOR IS ON LOCAL +Z. Not a style choice -- the spur path from a
//   building to the road has to start at the door, and a building whose door
//   position is implicit in its geometry cannot tell the planner where that is.
//   One convention, and `doorOf()` is three lines instead of a switch.
//
//   BUILDINGS ARE LEVELLED, NOT DRAPED. A 6 m building on 8 degrees spans 84 cm
//   of ground, which no fixed plinth hides -- one corner floats or one is
//   buried. So the plan samples four corners, sits the floor at the HIGHEST of
//   them and grows the plinth down to the lowest. Real buildings on slopes do
//   exactly this, and it turns the one artefact that makes procedural
//   settlements look pasted-on into a detail that sells them.
//
//   PATHS ARE ROUTED, NOT DRAWN. Each artery takes the flattest of three
//   candidate headings at every step, inside a cone around its bearing. That is
//   §6's slope-penalised A* with the search collapsed to one ply, which is all
//   a 200 m road out of a village needs, and it costs three height samples a
//   step instead of a priority queue.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const DEG = Math.PI / 180

export const VILLAGE_PLAN = {
  // --- zoning radii, metres from the centre ---------------------------------
  // A village is ~240 m across at the field fence. That is large, but the ring
  // of fields is most of it and fields are how a farming settlement reads as a
  // farming settlement rather than as a cluster of huts. VILLAGE.minSeparation
  // in phase-a.js is 1400 m, so there is a clear 1.1 km of wild between any two.
  plazaRadius: 12,
  ringRadius: 31, // the ring road the dwellings face onto
  coreRadius: 48, // dwellings live inside this
  workRadius: 76, // barns, sheds, pens, drying racks
  fieldInner: 88,
  fieldOuter: 122,

  // --- counts, as [min, max] inclusive --------------------------------------
  arteries: [3, 5], // roads leaving town
  dwellings: [9, 15],
  workBuildings: [3, 6],
  fields: [5, 8],
  bonfires: [2, 3],

  // --- paths ----------------------------------------------------------------
  arteryWidth: 3.4,
  ringWidth: 2.8,
  laneWidth: 2.0, // field gate -> artery
  spurWidth: 1.4, // door -> nearest road
  pathStep: 5, // metres between routed polyline vertices
  arteryCone: 34 * DEG, // how far a road may stray from its bearing
  arteryProbe: 13 * DEG, // the three candidate headings at each step
  arteryOverrun: 34, // metres a road continues past the outer fence

  // --- building siting ------------------------------------------------------
  //
  // These are set off a measurement, not off taste, and the measurement was a
  // surprise: sampling low ground (25-95 m) across an 10 km box, the flattest
  // 1% has a neighbourhood-average slope of 10.3 degrees and the median is
  // 21.2. There is no flat ground in this world. Phase A's VILLAGE.maxSlope of
  // 9 degrees is a test on ONE cell, not on the neighbourhood, so a village
  // site is a gentle spot on a hillside and never a plain.
  //
  // The whole module is built around that. A 13-degree cap and a 1.9 m spread
  // limit -- the first numbers here, chosen by eye -- refused the great hall
  // outright at every one of the four flattest sites in the world. Buildings
  // now terrace into the hill rather than looking for somewhere level.
  buildSlopeTan: Math.tan(20 * DEG),
  maxCornerSpread: 2.4, // metres of fall across a footprint before it is refused
  plinthMin: 0.35,
  buildingGap: 3.2, // metres of clear ground between two footprints
  pathClear: 1.6, // ...and between a footprint and a road edge

  // --- fields ---------------------------------------------------------------
  fieldSlopeTan: Math.tan(17 * DEG),
  plotLong: [20, 30], // along the ring
  plotDeep: [13, 19], // radially
  rowSpacing: 2.1,
  rowSegment: 6, // a crop row is instanced in segments this long, so it
  // follows the ground instead of spearing through it
  fenceRun: 3.0, // one fence instance spans this much

  // --- fixtures -------------------------------------------------------------
  lampSpacing: 18,
  lampOffset: 1.1, // beyond the path edge
  seatsPerFire: [4, 7],
  seatRing: 3.3,
  stallGap: 5.0, // arc metres between market stalls
  arteryMouth: 15 * DEG, // no stall blocks a road out of the plaza
}

// Crops. `hue` pairs are LINEAR colours (see props/shapes.js) -- a crop mixed at
// sRGB values glows like plastic next to linear-0.05 ground.
export const CROPS = [
  { name: 'grain', height: 1.05, spacing: 0.62, form: 'stalk' },
  { name: 'cabbage', height: 0.42, spacing: 0.78, form: 'ball' },
  { name: 'turnip', height: 0.5, spacing: 0.66, form: 'tuft' },
  { name: 'flax', height: 0.78, spacing: 0.55, form: 'wisp' },
  { name: 'squash', height: 0.34, spacing: 0.95, form: 'vine' },
]

export const STALL_GOODS = ['fruit', 'veg', 'fish', 'meat', 'bread', 'tools']

const LIVESTOCK = ['sheep', 'sheep', 'sheep', 'cow', 'goat', 'chicken', 'chicken']

// --- small geometry helpers -------------------------------------------------

// Rotation about Y that points a prop's local +Z at (tx, tz). Local +Z maps to
// (sin y, 0, cos y), hence the argument order -- atan2(x, z), not (z, x).
const yawToward = (x, z, tx, tz) => Math.atan2(tx - x, tz - z)

const doorOf = (b) => ({
  x: b.x + Math.sin(b.yaw) * (b.d / 2 + 0.6),
  z: b.z + Math.cos(b.yaw) * (b.d / 2 + 0.6),
})

function distToSeg(px, pz, ax, az, bx, bz) {
  const vx = bx - ax
  const vz = bz - az
  const len2 = vx * vx + vz * vz
  const t = len2 > 0 ? clamp01(((px - ax) * vx + (pz - az) * vz) / len2) : 0
  const dx = px - (ax + vx * t)
  const dz = pz - (az + vz * t)
  return { d: Math.hypot(dx, dz), t, x: ax + vx * t, z: az + vz * t }
}

// Nearest point on a whole path network, returned with which path it was on so
// a spur can be recorded as joining something specific.
function nearestOnPaths(paths, px, pz) {
  let best = { d: Infinity, x: px, z: pz, path: null }
  for (const p of paths) {
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i]
      const b = p.pts[i + 1]
      const hit = distToSeg(px, pz, a.x, a.z, b.x, b.z)
      if (hit.d < best.d) best = { d: hit.d, x: hit.x, z: hit.z, path: p }
    }
  }
  return best
}

const distToPaths = (paths, x, z) => nearestOnPaths(paths, x, z).d

// The nearest point on EACH path, closest first. A spur's first choice of join
// is often walled off by the building next door, and the second-nearest road is
// a better answer than no path at all.
function nearestPerPath(paths, px, pz) {
  const out = []
  for (const p of paths) {
    let best = null
    for (let i = 0; i + 1 < p.pts.length; i++) {
      const a = p.pts[i]
      const b = p.pts[i + 1]
      const hit = distToSeg(px, pz, a.x, a.z, b.x, b.z)
      if (!best || hit.d < best.d) best = { d: hit.d, x: hit.x, z: hit.z, path: p }
    }
    if (best) out.push(best)
  }
  out.sort((a, b) => a.d - b.d)
  return out
}

const pick = (rand, arr) => arr[Math.min(arr.length - 1, (rand() * arr.length) | 0)]
const between = (rand, [lo, hi]) => lo + rand() * (hi - lo)
const countIn = (rand, [lo, hi]) => lo + ((rand() * (hi - lo + 1)) | 0)

// Quantised to 25 cm, so sub-quantum jitter in a site does not reroll the
// RANDOM STREAM -- the road bearings, the counts, the crop choices. It cannot
// promise an identical village, and does not: the planner accepts and rejects
// on terrain samples, so a footprint sitting on the edge of the slope cap can
// flip, and every draw after it shifts. What is guaranteed is that the same
// site plans the same village every time, and that a site which MOVES gets a
// different one, which is correct -- it is different ground.
function siteSeed(seed, x, z) {
  const xi = Math.round(x * 4) | 0
  const zi = Math.round(z * 4) | 0
  return (seed ^ Math.imul(xi, 73856093) ^ Math.imul(zi, 19349663) ^ 0x5bd1e995) >>> 0
}

// --- terrain access ---------------------------------------------------------
//
// The planner asks the height field a few thousand questions per village.
// `heightAt` is one field evaluation with SCARP off (see terrain-height.js) and
// `heightAndSlopeAt` answers both from one shared stencil, so the rule is:
// route with heights alone, and pay for slope only where a decision turns on it
// -- siting a building, siting a field.

function makeProbe(terrain) {
  if (!terrain || typeof terrain.heightAt !== 'function') {
    throw new Error('planVillage needs a terrain sampler with heightAt(x, z)')
  }
  const hs =
    typeof terrain.heightAndSlopeAt === 'function'
      ? (x, z) => terrain.heightAndSlopeAt(x, z)
      : (x, z) => ({ h: terrain.heightAt(x, z), tan: Math.tan(terrain.slopeAt(x, z)) })
  const probe = {
    calls: 0,
    h(x, z) {
      probe.calls++
      return terrain.heightAt(x, z)
    },
    hs(x, z) {
      probe.calls++
      return hs(x, z)
    },
  }
  return probe
}

// --- path routing -----------------------------------------------------------

/**
 * Walk a road outward from (x, z) on `bearing` for `length` metres, taking the
 * flattest of three candidate headings at every step and never straying further
 * than `arteryCone` from the bearing it set out on.
 *
 * The flatness test is |dh| over one step rather than a slope query, on
 * purpose: what a road cares about is the climb it is committing to, and that
 * is exactly the height difference between here and the next vertex. It is also
 * one height sample per candidate where a slope costs six.
 */
function routeOutward(P, probe, x, z, bearing, length, rand) {
  const pts = [{ x, z, y: probe.h(x, z) }]
  let heading = bearing
  let cx = x
  let cz = z
  const steps = Math.max(2, Math.round(length / P.pathStep))

  for (let s = 0; s < steps; s++) {
    const from = pts[pts.length - 1]
    let bestCost = Infinity
    let bestHeading = heading
    let bestX = cx + Math.sin(heading) * P.pathStep
    let bestZ = cz + Math.cos(heading) * P.pathStep
    let bestY = from.y

    for (const turn of [-P.arteryProbe, 0, P.arteryProbe]) {
      const cand = heading + turn
      // The cone is measured from the ORIGINAL bearing, not from the current
      // heading -- against the current heading a road integrates its own wander
      // and spirals.
      const off = Math.atan2(Math.sin(cand - bearing), Math.cos(cand - bearing))
      if (Math.abs(off) > P.arteryCone) continue
      const nx = cx + Math.sin(cand) * P.pathStep
      const nz = cz + Math.cos(cand) * P.pathStep
      const ny = probe.h(nx, nz)
      // Flat first, straight second. The straightness term only breaks ties
      // between two equally level headings, so a road never wiggles for free
      // but always takes the gentler grade when there is one.
      const cost = Math.abs(ny - from.y) + Math.abs(turn) * 1.4
      if (cost < bestCost) {
        bestCost = cost
        bestHeading = cand
        bestX = nx
        bestZ = nz
        bestY = ny
      }
    }

    // A little wander that is not a response to the ground, so a road across a
    // dead-flat valley floor is not a ruler line. Small enough that the slope
    // term still wins wherever there is a slope to have an opinion about.
    heading = bestHeading + (rand() - 0.5) * 4 * DEG
    cx = bestX
    cz = bestZ
    pts.push({ x: cx, z: cz, y: bestY })
  }
  return pts
}

// The ring road: a closed loop at `radius` with per-vertex radial jitter, which
// is what stops it reading as a drawn circle. Closed by repeating the first
// point, so every consumer can treat it as a plain polyline.
function routeRing(P, probe, cx, cz, radius, rand) {
  const n = 20
  const jitter = radius * 0.12
  const wobble = []
  for (let i = 0; i < n; i++) wobble.push((rand() - 0.5) * 2 * jitter)
  const pts = []
  for (let i = 0; i <= n; i++) {
    const k = i % n
    // Averaged with its neighbours so the loop is smooth rather than a star.
    const r = radius + (wobble[k] + wobble[(k + 1) % n] + wobble[(k + n - 1) % n]) / 3
    const a = (k / n) * TAU
    const x = cx + Math.sin(a) * r
    const z = cz + Math.cos(a) * r
    pts.push({ x, z, y: probe.h(x, z) })
  }
  return pts
}

// Door -> nearest road. Two segments with the corner pushed off the straight
// line, because a path that leaves a door and turns once looks trodden and one
// that runs dead straight to the kerb looks surveyed.
function routeSpur(probe, from, to, rand, bendScale = 1) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const len = Math.hypot(dx, dz) || 1
  const bend = (rand() - 0.5) * Math.min(2.4, len * 0.3) * bendScale
  const bx = (from.x + to.x) / 2 + (-dz / len) * bend
  const bz = (from.z + to.z) / 2 + (dx / len) * bend
  return [
    { x: from.x, z: from.z, y: probe.h(from.x, from.z) },
    { x: bx, z: bz, y: probe.h(bx, bz) },
    { x: to.x, z: to.z, y: probe.h(to.x, to.z) },
  ]
}

/**
 * The same route, but refusing to walk through a wall.
 *
 * The field lanes and the door spurs are both routed after every building is
 * standing, and neither knows the buildings are there -- measured, that put a
 * field lane straight through a workshop. Rather than give the spur router a
 * cost field, this draws the bend up to four times and keeps the first version
 * that clears everything: the same bend mirrored, then straight, then a wide
 * swing. `skip` exempts the building whose door the spur starts at, since a
 * spur touches that footprint by construction.
 *
 * Returns null when nothing clears, and the caller drops the path. A door with
 * no spur is a cosmetic loss; a lane through a barn is not.
 */
function routeAround(probe, from, to, rand, buildings, skip, margin) {
  const draws = [1, -1, 0, 2.2]
  for (const scale of draws) {
    const pts = routeSpur(probe, from, to, rand, scale)
    let blocked = false
    for (const b of buildings) {
      if (b === skip) continue
      if (pathEntersRect(pts, b.x, b.z, b.yaw, b.w, b.d, margin)) {
        blocked = true
        break
      }
    }
    if (!blocked) return pts
  }
  return null
}

// --- building siting --------------------------------------------------------

/**
 * Which way is downhill, as a yaw. Returns the rotation whose local +Z points
 * down the fall line, plus the grade it found.
 *
 * This is the single most useful query in the module and it is worth saying
 * why. Nothing in this world is flat -- see the note on `buildSlopeTan` -- so
 * every rectangle the planner places has a good orientation and a bad one that
 * differ by 90 degrees and by a factor of `long/deep` in how much ground they
 * span. A 17 m great hall across a 12-degree slope has to bridge 3.6 m and is
 * refused; the same hall along the contour bridges 1.4 m and stands. Real
 * longhouses and real terraced fields both run along the contour for exactly
 * this reason, so the constraint and the vernacular agree, which is the
 * pleasant case.
 *
 * `eps` is deliberately larger than slopeAt's 0.75 m: what a 17 m building
 * cares about is the hillside, not the grain of the ground under it.
 */
function downhillAt(probe, x, z, eps = 6) {
  const hx = probe.h(x + eps, z) - probe.h(x - eps, z)
  const hz = probe.h(x, z + eps) - probe.h(x, z - eps)
  const mag = Math.hypot(hx, hz)
  if (mag < 1e-6) return { yaw: 0, grade: 0, flat: true }
  // Downhill is the negative gradient, and yaw is atan2(x, z) per the note on
  // yawToward.
  return { yaw: Math.atan2(-hx, -hz), grade: mag / (2 * eps), flat: false }
}

/**
 * Can a `w` x `d` building stand here, and if so how tall does its plinth have
 * to be? Samples the four corners plus the centre.
 *
 * Floor goes at the HIGHEST corner and the plinth grows down to the lowest --
 * see the header. Sitting the floor at the mean instead would bury the uphill
 * corner, which is the one failure a stone plinth cannot rescue.
 */
function siteBuilding(P, probe, x, z, yaw, w, d, spreadLimit = P.maxCornerSpread) {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  const hw = w / 2
  const hd = d / 2
  let hi = -Infinity
  let lo = Infinity
  let steepest = 0
  for (const [ox, oz] of [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0]]) {
    const px = x + ox * c + oz * s
    const pz = z - ox * s + oz * c
    const { h, tan } = probe.hs(px, pz)
    if (h > hi) hi = h
    if (h < lo) lo = h
    if (tan > steepest) steepest = tan
  }
  const spread = hi - lo
  if (steepest > P.buildSlopeTan || spread > spreadLimit) return null
  // +0.12 so the downhill face of the plinth is buried rather than exactly
  // flush, which shows as a hairline of daylight under the wall at any LOD.
  return { y: hi, plinth: Math.max(P.plinthMin, spread + 0.12), spread }
}

/**
 * Try a footprint both ways round and keep the one that sits better.
 *
 * The door stays on local +Z either way, so this does not rotate the building
 * away from the road it faces -- it decides whether the building presents its
 * long side or its gable end to that road. On sloping ground those two differ
 * by a factor of `long/short` in how much fall the footprint has to bridge,
 * which is frequently the difference between standing and being refused, and
 * the two readings look equally at home in a village.
 */
function fitEitherWay(P, probe, x, z, yaw, long, short) {
  const a = siteBuilding(P, probe, x, z, yaw, long, short)
  const b = siteBuilding(P, probe, x, z, yaw, short, long)
  if (a && (!b || a.spread <= b.spread)) return { w: long, d: short, fit: a }
  if (b) return { w: short, d: long, fit: b }
  return null
}

const radiusOf = (b) => Math.hypot(b.w, b.d) / 2
const collides = (a, b, gap) => Math.hypot(a.x - b.x, a.z - b.z) < radiusOf(a) + radiusOf(b) + gap

/**
 * Does a road run through this rectangle? Tested exactly, in the rectangle's
 * own frame, rather than as circle-against-circle.
 *
 * Worth the extra dozen lines because a field plot is 25 m by 16 m and its
 * bounding circle is 30 m across: a circle test refuses every plot within 15 m
 * of a road, which on a village with four roads out is most of the field ring.
 * Measured, the circle test was giving 1-2 fields where the plan asks for 5-8.
 */
function pathEntersRect(pts, x, z, yaw, w, d, margin) {
  const hw = w / 2 + margin
  const hd = d / 2 + margin
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const toLocal = (p) => ({
    x: (p.x - x) * c - (p.z - z) * s,
    z: (p.x - x) * s + (p.z - z) * c,
  })
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = toLocal(pts[i])
    const b = toLocal(pts[i + 1])
    // Separating axis on the rectangle's own two axes is exact for a segment
    // against an AABB in this frame.
    if (Math.min(a.x, b.x) > hw || Math.max(a.x, b.x) < -hw) continue
    if (Math.min(a.z, b.z) > hd || Math.max(a.z, b.z) < -hd) continue
    return true
  }
  return false
}

// Rotation about Y that lays a prop's local +X along (dx, dz). Local +X maps to
// (cos y, 0, -sin y), hence the negated z. Fences and crop rows are built along
// their local X, so this is the one they want; everything with a front face
// wants yawToward instead.
const yawAlong = (dx, dz) => Math.atan2(-dz, dx)

// Local (lx, lz) -> world, for a prop at (x, z) rotated by yaw.
const toWorld = (x, z, yaw, lx, lz) => ({
  x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw),
  z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw),
})

// Walk `dist` metres along a polyline and report where you are and which way
// you are pointing. Used by everything that hangs off a road -- lampposts,
// bonfire clearings, barns, field lanes -- so they all agree about what "40 m
// out along the north road" means.
function pointAlong(pts, dist) {
  let acc = 0
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const seg = Math.hypot(b.x - a.x, b.z - a.z)
    if (acc + seg >= dist || i + 2 === pts.length) {
      const t = seg > 0 ? clamp01((dist - acc) / seg) : 0
      return {
        x: lerp(a.x, b.x, t),
        z: lerp(a.z, b.z, t),
        y: lerp(a.y, b.y, t),
        tx: seg > 0 ? (b.x - a.x) / seg : 0,
        tz: seg > 0 ? (b.z - a.z) / seg : 1,
      }
    }
    acc += seg
  }
  const last = pts[pts.length - 1]
  return { x: last.x, z: last.z, y: last.y, tx: 0, tz: 1 }
}

const pathLength = (pts) => {
  let d = 0
  for (let i = 0; i + 1 < pts.length; i++) d += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z)
  return d
}

// ---------------------------------------------------------------------------
// The plan itself.
// ---------------------------------------------------------------------------

/**
 * @param site    {x, z} -- from phase-a.js `villages[]`, or anywhere else.
 * @param terrain anything with heightAt(x,z), ideally heightAndSlopeAt too.
 * @param opts    {seed, id}
 * @returns a plain-data plan. No three.js types anywhere in it.
 */
export function planVillage(site, terrain, { seed = 1337, id = 0 } = {}) {
  const P = VILLAGE_PLAN
  const probe = makeProbe(terrain)
  const rand = mulberry32(siteSeed(seed, site.x, site.z))
  const cx = site.x
  const cz = site.z
  const centreY = probe.h(cx, cz)
  const warnings = []

  const paths = []
  const buildings = []
  const props = []
  const lamps = []
  const bonfires = []
  const fields = []
  const fences = []
  const clearings = []

  const addProp = (kind, x, z, yaw, extra = {}) =>
    props.push({ kind, x, z, y: probe.h(x, z), yaw, scale: 1, ...extra })

  // --- 1. the roads out -----------------------------------------------------
  // Laid first, because everything else in the village is positioned relative
  // to a road: the ring closes around them, the dwellings face them, the fields
  // are gated onto them.
  const nArteries = countIn(rand, P.arteries)
  const north = rand() * TAU
  const arteries = []
  for (let i = 0; i < nArteries; i++) {
    const bearing = north + (i / nArteries) * TAU + (rand() - 0.5) * (TAU / nArteries) * 0.4
    const sx = cx + Math.sin(bearing) * (P.plazaRadius - 1)
    const sz = cz + Math.cos(bearing) * (P.plazaRadius - 1)
    const road = {
      cls: 'artery',
      width: P.arteryWidth,
      bearing,
      pts: routeOutward(P, probe, sx, sz, bearing, P.fieldOuter - P.plazaRadius + P.arteryOverrun, rand),
    }
    paths.push(road)
    arteries.push(road)
  }

  // --- 2. the ring road -----------------------------------------------------
  const ring = {
    cls: 'ring',
    width: P.ringWidth,
    pts: routeRing(P, probe, cx, cz, P.ringRadius, rand),
  }
  paths.push(ring)

  // --- 3. the great hall ----------------------------------------------------
  // The one building whose position is chosen by search rather than by rule: it
  // is the largest footprint in the village by a factor of three, so it is the
  // one most likely to be refused, and giving it first pick of the plaza rim is
  // cheaper than placing it last and discovering nothing fits.
  // Sited by search, because it is three times the footprint of anything else
  // and therefore the thing most likely to be refused -- giving it first pick
  // is cheaper than placing it last and finding nothing fits.
  //
  // Two rules, and both come out of the slope measurement on `buildSlopeTan`:
  // the hall stands on the UPHILL side of the plaza, looking down over it, and
  // its long axis runs along the contour. The first is what every hall on a
  // hillside does and it costs nothing; the second is what makes a 17 m
  // building possible on 12-degree ground at all.
  const hallW = between(rand, [15.5, 19])
  const hallD = 6.6
  const fall = downhillAt(probe, cx, cz, 14)
  let hall = null
  for (const [wScale, spreadLimit] of [[1, 2.4], [1, 3.0], [0.72, 3.6]]) {
    let best = null
    for (let k = 0; k < 21; k++) {
      // Sweep the arc centred UPHILL of the plaza -- the downhill yaw plus a
      // half turn -- rather than the whole rim.
      const a = fall.yaw + Math.PI + ((k / 20) - 0.5) * 150 * DEG
      const r = P.plazaRadius + hallD / 2 + 2.2
      const x = cx + Math.sin(a) * r
      const z = cz + Math.cos(a) * r
      // Door and eave face downhill; the ridge runs along the contour. On flat
      // ground there is no contour to follow, so fall back to facing the plaza.
      const local = downhillAt(probe, x, z, 8)
      const yaw = local.flat ? yawToward(x, z, cx, cz) : local.yaw
      const fit = siteBuilding(P, probe, x, z, yaw, hallW * wScale, hallD, spreadLimit)
      if (!fit) continue
      // The arteries leave the plaza on their own bearings and the hall stands
      // on the plaza rim, so the two compete for the same ground. Measured, one
      // site in six put a road straight through the hall.
      if (arteries.some((r) => pathEntersRect(r.pts, x, z, yaw, hallW * wScale, hallD, P.pathClear))) continue
      // Prefer the flattest footprint, but break ties toward the candidate
      // whose door actually looks at the plaza -- along a contour there are two
      // ways to stand and only one of them faces the village.
      const facing = Math.cos(yaw - yawToward(x, z, cx, cz))
      const score = fit.spread - facing * 0.35
      if (!best || score < best.score) best = { x, z, yaw, a, fit, score, w: hallW * wScale }
    }
    if (best) {
      hall = {
        kind: 'hall',
        variant: 0,
        x: best.x,
        z: best.z,
        y: best.fit.y,
        yaw: best.yaw,
        w: best.w,
        d: hallD,
        plinth: best.fit.plinth,
        angle: best.a,
      }
      break
    }
  }
  if (!hall) {
    // Phase A only sites villages on ground under 9 degrees, so this means the
    // site moved or the sampler is not the one that scored it. Say so loudly
    // rather than shipping a village with a hole where its hall goes.
    warnings.push('no buildable arc on the plaza rim for the great hall')
  } else {
    buildings.push(hall)
  }

  // --- 4. dwellings ---------------------------------------------------------
  // Strung along the ring road, alternating inside and outside it, every one
  // facing the road. That alternation is what makes the ring read as a street
  // rather than as a fence of houses.
  const wantDwellings = countIn(rand, P.dwellings)
  let attempts = 0
  while (buildings.filter((b) => b.kind === 'hut').length < wantDwellings && attempts < 90) {
    attempts++
    const a = rand() * TAU
    const outside = rand() < 0.62
    const offset = between(rand, [8.5, 15.5]) * (outside ? 1 : -1)
    const r = P.ringRadius + offset
    if (r < P.plazaRadius + 5 || r > P.coreRadius) continue
    const x = cx + Math.sin(a) * r
    const z = cz + Math.cos(a) * r
    const long = between(rand, [5.4, 7.2])
    const short = between(rand, [4.2, 5.2])
    // Face the ring: local +Z (the door) points back at the road.
    const yaw = yawToward(x, z, cx + Math.sin(a) * P.ringRadius, cz + Math.cos(a) * P.ringRadius)
    const cand = { x, z, w: long, d: short }
    if (buildings.some((b) => collides(cand, b, P.buildingGap))) continue
    if (distToPaths(paths, x, z) < radiusOf(cand) + P.pathClear) continue
    const sited = fitEitherWay(P, probe, x, z, yaw, long, short)
    if (!sited) continue
    buildings.push({
      kind: 'hut',
      variant: (rand() * 3) | 0,
      x,
      z,
      y: sited.fit.y,
      yaw,
      w: sited.w,
      d: sited.d,
      plinth: sited.fit.plinth,
    })
  }

  // --- 5. barns, sheds, workshops -------------------------------------------
  // Out past the dwellings and hard against an artery, because a barn is a
  // building you drive a cart into.
  const wantWork = countIn(rand, P.workBuildings)
  attempts = 0
  const workKinds = ['barn', 'shed', 'shed', 'barn', 'workshop']
  while (buildings.filter((b) => b.kind !== 'hut' && b.kind !== 'hall').length < wantWork && attempts < 70) {
    attempts++
    const road = pick(rand, arteries)
    const along = between(rand, [P.coreRadius + 6, P.workRadius])
    const at = pointAlong(road.pts, along - P.plazaRadius)
    const side = rand() < 0.5 ? 1 : -1
    const off = road.width / 2 + between(rand, [5, 10])
    const x = at.x + at.tz * off * side
    const z = at.z - at.tx * off * side
    const kind = pick(rand, workKinds)
    const long = kind === 'barn' ? between(rand, [8.5, 11]) : between(rand, [4.4, 5.6])
    const short = kind === 'barn' ? between(rand, [6, 7.5]) : between(rand, [3.4, 4.2])
    const yaw = yawToward(x, z, at.x, at.z)
    const cand = { x, z, w: long, d: short }
    if (buildings.some((b) => collides(cand, b, P.buildingGap))) continue
    if (distToPaths(paths, x, z) < radiusOf(cand) + P.pathClear) continue
    const sited = fitEitherWay(P, probe, x, z, yaw, long, short)
    if (!sited) continue
    const w = sited.w
    const d = sited.d
    buildings.push({ kind, variant: (rand() * 2) | 0, x, z, y: sited.fit.y, yaw, w, d, plinth: sited.fit.plinth })
    // A barn earns its clutter: hay, a woodpile, a cart on the road side.
    if (kind === 'barn') {
      for (let i = 0; i < 3; i++) {
        const p = toWorld(x, z, yaw, between(rand, [-w / 2, w / 2]), d / 2 + between(rand, [1.4, 3.2]))
        addProp(pick(rand, ['haybale', 'haybale', 'crate', 'woodpile']), p.x, p.z, rand() * TAU)
      }
      const c = toWorld(x, z, yaw, between(rand, [-w / 3, w / 3]), d / 2 + 4.2)
      addProp('cart', c.x, c.z, yaw + (rand() - 0.5) * 0.6)
    }
  }

  // --- 6. bonfires, and the clearings they sit in ---------------------------
  // On an artery, off to one side, in a widening of the path. The clearing disc
  // is recorded here rather than derived at render time because the seating
  // ring, the lamppost spacing and the prop exclusion all need to agree about
  // where the bare ground is.
  const wantFires = countIn(rand, P.bonfires)
  // Attempts, not slots. One draw per fire loses the slot whenever the spot it
  // picked was already taken by a barn, and a village with no fire in it is the
  // one thing on the list that is not decoration.
  let fireTries = 0
  while (bonfires.length < wantFires && fireTries < 24) {
    const road = arteries[fireTries % arteries.length]
    fireTries++
    const along = between(rand, [P.coreRadius * 0.5, P.coreRadius * 0.95])
    const at = pointAlong(road.pts, along - P.plazaRadius)
    const side = rand() < 0.5 ? 1 : -1
    const off = road.width / 2 + between(rand, [2.6, 3.8])
    const fx = at.x + at.tz * off * side
    const fz = at.z - at.tx * off * side
    if (bonfires.some((b) => Math.hypot(b.x - fx, b.z - fz) < 24)) continue
    if (buildings.some((b) => Math.hypot(b.x - fx, b.z - fz) < radiusOf(b) + 6)) continue
    const fy = probe.h(fx, fz)
    bonfires.push({ x: fx, z: fz, y: fy, r: between(rand, [1.1, 1.5]) })
    // The clearing straddles the fire and the road it opens off.
    clearings.push({
      x: (fx + at.x) / 2,
      z: (fz + at.z) / 2,
      y: probe.h((fx + at.x) / 2, (fz + at.z) / 2),
      r: P.seatRing + 3.4,
    })

    // Seats on an arc, facing in, with the road side left open so you can walk
    // up to the fire instead of climbing over a bench to reach it.
    const roadAngle = Math.atan2(at.x - fx, at.z - fz)
    const nSeats = countIn(rand, P.seatsPerFire)
    for (let s = 0; s < nSeats; s++) {
      const a = roadAngle + Math.PI + ((s + 0.5) / nSeats - 0.5) * (TAU - 100 * DEG)
      const rr = P.seatRing + (rand() - 0.5) * 0.5
      const sx = fx + Math.sin(a) * rr
      const sz = fz + Math.cos(a) * rr
      addProp(rand() < 0.55 ? 'bench' : 'stool', sx, sz, yawToward(sx, sz, fx, fz))
    }
    // Firewood, because a fire nobody feeds is a light fixture.
    const wx = fx + Math.sin(roadAngle + 2.4) * (P.seatRing + 1.6)
    const wz = fz + Math.cos(roadAngle + 2.4) * (P.seatRing + 1.6)
    addProp('woodpile', wx, wz, rand() * TAU)
  }

  return finishPlan({
    P,
    probe,
    rand,
    id,
    seed,
    site,
    cx,
    cz,
    centreY,
    paths,
    arteries,
    ring,
    buildings,
    hall,
    props,
    lamps,
    bonfires,
    fields,
    fences,
    clearings,
    warnings,
    addProp,
  })
}

/**
 * Everything downstream of the roads: fields, gates and lanes, the spur from
 * every door, lampposts, the market, livestock.
 *
 * Split out of planVillage purely for length -- it takes the same mutable
 * arrays and keeps filling them. The ORDER inside it is load-bearing in one
 * place, marked below: spurs are routed last so a hut can join a field lane.
 */
function finishPlan(ctx) {
  const { P, probe, rand, cx, cz, paths, arteries, buildings, props, lamps, bonfires, fields, fences, clearings, warnings, addProp, hall } = ctx

  // --- 7. the fields ring the town -----------------------------------------
  // Local axes for a plot: +X is the long side and the direction the crop rows
  // run, +Z is downhill. Rows run ALONG the contour -- same reasoning as the
  // great hall (see downhillAt), and the same happy coincidence: contour
  // ploughing is what a real hillside farm does, because rows down the fall
  // line wash out in the first storm.
  //
  // Because the plot is oriented by the hill rather than by the village, the
  // gate cannot be assumed onto a fixed side. It goes on whichever of the four
  // sides faces the village, worked out from the side normals below.
  const wantFields = countIn(rand, P.fields)
  const fieldBase = rand() * TAU
  const crops = []

  // Sited first, filled second. The two passes exist so that the pasture can be
  // chosen from the plots that actually LANDED: picking it up front, by sector,
  // silently gives a village no pasture at all whenever the sector it picked
  // was one of the ones the hillside refused.
  const plots = []

  // One draw at a given angle and size. Returns the sited plot or null.
  const tryPlot = (a, shrink) => {
    const long = between(rand, P.plotLong) * shrink
    const deep = between(rand, P.plotDeep) * shrink
    const span = Math.max(0, P.fieldOuter - P.fieldInner - deep)
    const rMid = P.fieldInner + deep / 2 + rand() * span
    const x = cx + Math.sin(a) * rMid
    const z = cz + Math.cos(a) * rMid
    const localFall = downhillAt(probe, x, z, 8)
    const yaw = localFall.flat ? a : localFall.yaw
    const hw = long / 2
    const hd = deep / 2

    // A plot follows the hill -- it has no plinth to sit on -- so it is tested
    // on the MEAN of its samples rather than on the worst of them. A single
    // steep corner on an otherwise good shelf is a hummock, and refusing the
    // whole plot for it was most of why fields were scarce. The worst sample
    // still gets a cap, at 1.7x, so a plot cannot span a cliff.
    let hi = -Infinity
    let lo = Infinity
    let steepest = 0
    let tanSum = 0
    const samples = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [0, 0]]
    for (const [ox, oz] of samples) {
      const p = toWorld(x, z, yaw, ox, oz)
      const { h, tan } = probe.hs(p.x, p.z)
      if (h > hi) hi = h
      if (h < lo) lo = h
      if (tan > steepest) steepest = tan
      tanSum += tan
    }
    if (tanSum / samples.length > P.fieldSlopeTan) return null
    if (steepest > P.fieldSlopeTan * 1.7) return null
    // The spread allowance scales with the plot, because the fall a plot has to
    // absorb is its depth times the grade -- a fixed metre figure refuses big
    // plots on gentle ground and admits small ones on steep.
    if (hi - lo > deep * 0.3 + 1.4) return null

    const plot = { x, z, w: long, d: deep }
    if (buildings.some((b) => collides(plot, b, 3))) return null
    if (plots.some((f) => collides(plot, { x: f.x, z: f.z, w: f.long, d: f.deep }, 5))) return null
    // The arteries run straight out through the field ring, so plots go in the
    // gaps between them. Tested against the rectangle, not its bounding circle
    // -- see pathEntersRect.
    if (arteries.some((r) => pathEntersRect(r.pts, x, z, yaw, long, deep, 3.5))) return null
    return { a, x, z, yaw, long, deep, hw, hd }
  }

  // Six draws per sector, shrinking as they go and roaming a little further
  // from the sector centre each time. One draw per sector gave 1-2 plots out of
  // 5-8 wanted, and the reason is not that the ground is bad -- it is that a
  // 30 m x 19 m plot on a hillside has to find a shelf, and the 21 m x 13 m
  // fallback finds one nearly everywhere. A village ringed by six small fields
  // reads far better than one with two large ones and four gaps.
  for (let i = 0; i < wantFields; i++) {
    let sited = null
    for (let attempt = 0; attempt < 6 && !sited; attempt++) {
      const spread = 0.5 + attempt * 0.14
      const a = fieldBase + (i / wantFields) * TAU + (rand() - 0.5) * (TAU / wantFields) * spread
      sited = tryPlot(a, 1 - attempt * 0.08)
    }
    if (sited) plots.push(sited)
  }

  // Mop-up. On the steepest sites the sector sweep comes back with two plots,
  // and two fields is a smallholding rather than a village. This drops the
  // sector constraint entirely and takes whatever the ring will give.
  for (let t = 0; plots.length < 4 && t < 40; t++) {
    const sited = tryPlot(rand() * TAU, 0.62)
    if (sited) plots.push(sited)
  }

  // One plot in every village is pasture, and a second once there are seven --
  // a village always has somewhere to keep its animals.
  const pastureAt = new Set()
  if (plots.length) pastureAt.add((rand() * plots.length) | 0)
  if (plots.length >= 7) pastureAt.add((rand() * plots.length) | 0)

  for (let i = 0; i < plots.length; i++) {
    const { x, z, yaw, long, deep, hw, hd } = plots[i]

    const pasture = pastureAt.has(i)
    const crop = pasture ? null : pick(rand, CROPS)
    if (crop && !crops.includes(crop.name)) crops.push(crop.name)

    const rows = []
    if (crop) {
      const nRows = Math.max(3, Math.floor(deep / P.rowSpacing))
      const rowGap = deep / nRows
      const wobblePhase = rand() * TAU
      for (let j = 0; j < nRows; j++) {
        const lz = -hd + (j + 0.5) * rowGap
        const segs = Math.max(1, Math.round(long / P.rowSegment))
        const segLen = long / segs
        for (let s = 0; s < segs; s++) {
          const lx = -hw + (s + 0.5) * segLen
          // The weave. Rows that are dead straight read as printed; a lateral
          // wobble that is a smooth function of position along the row reads as
          // hand-ploughed, which is the whole difference.
          const wob = Math.sin(s * 1.7 + j * 0.9 + wobblePhase) * 0.3
          const p = toWorld(x, z, yaw, lx, lz + wob)
          rows.push({
            x: p.x,
            z: p.z,
            y: probe.h(p.x, p.z),
            yaw,
            len: segLen,
            crop: crop.name,
            variant: (rand() * 3) | 0,
          })
        }
      }
    }

    // Fence the perimeter in runs. The gate goes on the side whose outward
    // normal points most nearly at the village -- see the note at the top of
    // this section for why that side is not a constant.
    const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]]
    const toVillage = Math.hypot(cx - x, cz - z) || 1
    let gateSide = 0
    let bestDot = -Infinity
    for (let s = 0; s < 4; s++) {
      const [nx, nz] = normals[s]
      const wnx = nx * Math.cos(yaw) + nz * Math.sin(yaw)
      const wnz = -nx * Math.sin(yaw) + nz * Math.cos(yaw)
      const dot = (wnx * (cx - x) + wnz * (cz - z)) / toVillage
      if (dot > bestDot) {
        bestDot = dot
        gateSide = s
      }
    }

    let gate = null
    for (let s = 0; s < 4; s++) {
      const [ax, az] = corners[s]
      const [bx, bz] = corners[(s + 1) % 4]
      const sideLen = Math.hypot(bx - ax, bz - az)
      const runs = Math.max(1, Math.round(sideLen / P.fenceRun))
      const runLen = sideLen / runs
      const gateRun = s === gateSide ? clamp(((runs / 2) | 0) + ((rand() * 3) | 0) - 1, 0, runs - 1) : -1
      for (let r = 0; r < runs; r++) {
        const t = (r + 0.5) / runs
        const p = toWorld(x, z, yaw, ax + (bx - ax) * t, az + (bz - az) * t)
        const dirA = toWorld(x, z, yaw, ax, az)
        const dirB = toWorld(x, z, yaw, bx, bz)
        const dx = (dirB.x - dirA.x) / sideLen
        const dz = (dirB.z - dirA.z) / sideLen
        const isGate = r === gateRun
        fences.push({
          x: p.x,
          z: p.z,
          y: probe.h(p.x, p.z),
          yaw: yawAlong(dx, dz),
          len: runLen,
          kind: isGate ? 'gate' : 'rail',
        })
        if (isGate) gate = { x: p.x, z: p.z }
      }
    }

    // The lane from the gate to the nearest road. Started 2 m clear of the gate
    // so the ribbon does not run under the fence line.
    if (gate) {
      const outX = gate.x + (gate.x - x) * (2 / Math.max(1, Math.hypot(gate.x - x, gate.z - z)))
      const outZ = gate.z + (gate.z - z) * (2 / Math.max(1, Math.hypot(gate.x - x, gate.z - z)))
      const join = nearestOnPaths(arteries.concat([ctx.ring]), outX, outZ)
      if (join.d < 90) {
        const pts = routeAround(probe, { x: outX, z: outZ }, join, rand, buildings, null, 0.6)
        if (pts) paths.push({ cls: 'lane', width: P.laneWidth, pts })
      }
    }

    if (pasture) {
      const nStock = 3 + ((rand() * 5) | 0)
      for (let k = 0; k < nStock; k++) {
        const p = toWorld(x, z, yaw, between(rand, [-hw * 0.8, hw * 0.8]), between(rand, [-hd * 0.8, hd * 0.8]))
        addProp(pick(rand, LIVESTOCK), p.x, p.z, rand() * TAU)
      }
      const t = toWorld(x, z, yaw, between(rand, [-hw * 0.5, hw * 0.5]), -hd * 0.6)
      addProp('trough', t.x, t.z, yaw)
    }

    fields.push({ x, z, y: probe.h(x, z), yaw, w: long, d: deep, crop: crop ? crop.name : null, pasture, rows, gate })
  }

  // --- 8. drying racks and pens in the work ring ---------------------------
  // Fish and meat hung to dry is the single most Norse piece of set dressing
  // there is, and it is four sticks and some slabs.
  for (let i = 0; i < 2 + ((rand() * 3) | 0); i++) {
    const road = pick(rand, arteries)
    const at = pointAlong(road.pts, between(rand, [P.coreRadius, P.workRadius]) - P.plazaRadius)
    const side = rand() < 0.5 ? 1 : -1
    const off = road.width / 2 + between(rand, [3, 7])
    const x = at.x + at.tz * off * side
    const z = at.z - at.tx * off * side
    if (buildings.some((b) => Math.hypot(b.x - x, b.z - z) < radiusOf(b) + 2.5)) continue
    addProp('dryingrack', x, z, yawToward(x, z, at.x, at.z))
  }

  // --- 9. lampposts --------------------------------------------------------
  // Along both sides of every road, alternating, so a road at night is lit from
  // staggered points rather than framed like a runway.
  const addLamp = (x, z, yaw) =>
    lamps.push({ x, z, y: probe.h(x, z), yaw, phase: rand() * TAU })

  for (const road of arteries) {
    const usable = Math.min(pathLength(road.pts), P.fieldInner - P.plazaRadius)
    let side = rand() < 0.5 ? 1 : -1
    for (let d = 7; d < usable; d += P.lampSpacing) {
      const at = pointAlong(road.pts, d)
      const off = road.width / 2 + P.lampOffset
      const x = at.x + at.tz * off * side
      const z = at.z - at.tx * off * side
      addLamp(x, z, yawToward(x, z, at.x, at.z))
      side = -side
    }
  }
  {
    const loop = pathLength(ctx.ring.pts)
    let side = 1
    for (let d = 4; d < loop; d += P.lampSpacing * 1.25) {
      const at = pointAlong(ctx.ring.pts, d)
      const off = ctx.ring.width / 2 + P.lampOffset
      const x = at.x + at.tz * off * side
      const z = at.z - at.tx * off * side
      addLamp(x, z, yawToward(x, z, at.x, at.z))
      side = -side
    }
  }

  // --- 10. the plaza and its market ----------------------------------------
  // Stalls face inward around the rim, with a gap left at the mouth of every
  // road out and in front of the hall. A market that seals the plaza off is a
  // courtyard, not a market.
  const stallR = P.plazaRadius - 2.2
  const stallCount = Math.max(4, Math.floor((TAU * stallR) / P.stallGap))
  const goods = STALL_GOODS.slice()
  for (let i = goods.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    const t = goods[i]
    goods[i] = goods[j]
    goods[j] = t
  }
  let placedStalls = 0
  for (let i = 0; i < stallCount; i++) {
    const a = (i / stallCount) * TAU + rand() * 0.06
    const blockedByRoad = arteries.some((r) => {
      const off = Math.atan2(Math.sin(a - r.bearing), Math.cos(a - r.bearing))
      return Math.abs(off) < P.arteryMouth
    })
    if (blockedByRoad) continue
    if (hall) {
      const off = Math.atan2(Math.sin(a - hall.angle), Math.cos(a - hall.angle))
      if (Math.abs(off) < 26 * DEG) continue
    }
    const x = cx + Math.sin(a) * stallR
    const z = cz + Math.cos(a) * stallR
    addProp('stall', x, z, yawToward(x, z, cx, cz), { goods: goods[placedStalls % goods.length] })
    placedStalls++
    // Stock spilling out behind the stall.
    if (rand() < 0.7) {
      const bx = x + Math.sin(a) * 1.3
      const bz = z + Math.cos(a) * 1.3
      addProp(pick(rand, ['crate', 'barrel', 'crate']), bx, bz, rand() * TAU)
    }
  }

  // The well sits off-centre. Dead centre reads as a roundabout, and a plaza
  // with its one fixed feature to one side is a place people walk through.
  {
    const a = rand() * TAU
    const r = P.plazaRadius * between(rand, [0.25, 0.45])
    addProp('well', cx + Math.sin(a) * r, cz + Math.cos(a) * r, rand() * TAU)
  }
  for (let i = 0; i < 2 + ((rand() * 3) | 0); i++) {
    const a = rand() * TAU
    const r = P.plazaRadius * between(rand, [0.4, 0.8])
    addProp(pick(rand, ['barrel', 'crate', 'bench']), cx + Math.sin(a) * r, cz + Math.cos(a) * r, rand() * TAU)
  }

  // --- 11. loose livestock and dooryard clutter ----------------------------
  for (const b of buildings) {
    if (b.kind !== 'hut') continue
    if (rand() < 0.45) {
      const p = toWorld(b.x, b.z, b.yaw, between(rand, [-b.w / 2, b.w / 2]), b.d / 2 + between(rand, [2, 4]))
      addProp(rand() < 0.6 ? 'chicken' : 'woodpile', p.x, p.z, rand() * TAU)
    }
    if (rand() < 0.35) {
      const p = toWorld(b.x, b.z, b.yaw, b.w / 2 + between(rand, [0.6, 1.6]), between(rand, [-b.d / 3, b.d / 3]))
      addProp(pick(rand, ['barrel', 'crate', 'haybale']), p.x, p.z, rand() * TAU)
    }
  }

  // --- 12. spurs, LAST ------------------------------------------------------
  // Every door gets a path to the nearest road, and this runs after the field
  // lanes so a hut on the outer edge can join a lane rather than trekking all
  // the way back to the ring. Each spur searches only the paths that already
  // exist, which is what guarantees the network stays a connected tree rather
  // than growing a detached pair of spurs that join only each other.
  for (const b of buildings) {
    const door = doorOf(b)
    // The hall opens straight onto the plaza, which is bare ground already.
    if (Math.hypot(door.x - cx, door.z - cz) < P.plazaRadius + 1.5) continue
    // Four candidate joins, not one. The nearest road is frequently on the far
    // side of the neighbour's barn, and a door with no path to it is the most
    // visible thing a village can get wrong.
    let spur = null
    for (const join of nearestPerPath(paths, door.x, door.z).slice(0, 4)) {
      if (join.d < 1.2) { spur = 'already there'; break }
      if (join.d > 70) break
      const pts = routeAround(probe, door, join, rand, buildings, b, 0.6)
      if (pts) {
        spur = pts
        break
      }
    }
    if (Array.isArray(spur)) paths.push({ cls: 'spur', width: P.spurWidth, pts: spur })
  }

  const rowCount = fields.reduce((n, f) => n + f.rows.length, 0)
  const instances =
    buildings.length + fences.length + rowCount + props.length + lamps.length + bonfires.length

  return {
    id: ctx.id,
    seed: ctx.seed,
    x: cx,
    z: cz,
    y: ctx.centreY,
    // What the prop scatter has to stay out of (§6: "reject ... inside village
    // footprints"). Slightly beyond the outer fence so the treeline does not
    // grow through a field's back rail.
    clearRadius: P.fieldOuter + 14,
    plaza: { x: cx, z: cz, y: ctx.centreY, r: P.plazaRadius },
    clearings,
    buildings,
    paths,
    fields,
    fences,
    props,
    lamps,
    bonfires,
    warnings,
    stats: {
      instances,
      buildings: buildings.length,
      dwellings: buildings.filter((b) => b.kind === 'hut').length,
      paths: paths.length,
      pathMetres: Math.round(paths.reduce((m, p) => m + pathLength(p.pts), 0)),
      fields: fields.length,
      cropRows: rowCount,
      crops,
      fences: fences.length,
      props: props.length,
      lamps: lamps.length,
      bonfires: bonfires.length,
      probeCalls: probe.calls,
    },
  }
}
