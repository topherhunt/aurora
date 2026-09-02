// ---------------------------------------------------------------------------
// Vertex generation for the v2 surface layers: the lake disc and the path ribbon.
//
// THREE-FREE ON PURPOSE, even though it lives under src/v2/render/ where §18 says three.js starts. Same exemption chunk-mesh-v2.js gets and for the same reason: only the renderer calls it, but the thing that can actually be WRONG here is arithmetic -- a ribbon that folds through itself on a hairpin, a disc whose segment count is a guess -- and arithmetic is checkable in node. scripts/check-v2-surfaces.mjs imports this file and nothing else, so the gate costs no GL context and no stub renderer.
//
// Both generators emit WORLD-space positions. The meshes that wrap them sit at identity under a group at the origin, which is not an accident: src/water.js's fragment shader recovers world position as `modelMatrix * position` and feeds it straight into the wave field, so a river ribbon carrying a local origin would sample the waves from the wrong place and drift against the lake beside it.
// ---------------------------------------------------------------------------

// How far a lake disc reaches past its authored rx/rz, in metres.
//
// Same trick as Water.setFromPhaseA's one-cell mask dilation, for the same reason spelled out in its header: a polygon edge that stops exactly where the water meets the ground is a straight line you can see, and it moves with the LOD. Push it a metre and a half under the bank instead and the shoreline you see is where the full-resolution terrain crosses the plane -- free, exact, and as detailed as the chunk happens to be. v1 needed a whole 16 m sim cell because its mask was a raster; here the ellipse is exact, so this only has to cover the lake carve's feather (the last 15% of the radius, where the ground is still coming down to meet the water) plus the mesher's 50 cm leaf.
export const LAKE_OVERHANG = 1.5

// How many segments a lake rim gets. EIGHT, at every size, which is the shape of the request that produced it: a lake is a flat quad-ish sheet of water, and 128 triangles of rim were buying a curve nobody was ever close enough to read. Eight is also the smallest count that still puts a vertex on all four axes AND all four diagonals, so a rotated or elongated lake keeps its own axes rather than reading as a tilted stop sign.
//
// The rim is CIRCUMSCRIBED, not inscribed, and at eight segments that stops being a detail. An inscribed polygon has its edge midpoints INSIDE the footprint, by 7.6% of the radius here -- on a 400 m lake that is a 30 m band of carved lake bed showing through a hole in the water, at eight places around the shore. So every vertex is pushed out by RIM_SCALE below, which puts the edge midpoints exactly on the footprint + overhang and leaves the whole error on the outside, where the bank hides it. The old sag-budget-picks-the-count rule was solving the same problem from the other end and could afford to be inscribed because the error was half a metre.
//
// WHAT THE CORNERS COST, since it is the price of this: a vertex now sticks out 8.2% of the radius past the rim -- 1.6 m on the default 20 m pond, 33 m on a 400 m lake -- lying on natural terrain rather than on anything the lake carved. That is buried wherever the ground keeps rising away from the water, which is what a basin does; where it does not, a corner of the sheet can show over falling ground. The same assumption already justifies LAKE_OVERHANG, just at 1.5 m rather than at a fraction, and it is the reason to reach for a shorter, wider lake rather than one huge one.
const LAKE_SEGMENTS = 8

// Vertex radius / rim radius: sec(pi/N). The edge midpoint of a circumscribed regular N-gon sits at cos(pi/N) of its vertex radius, so this is exactly the factor that puts that midpoint back on the rim. Exact for an ellipse as well as a circle -- the rim is the affine image of a circle and an affine map preserves midpoints -- and measured rather than assumed for the superellipse, in check-v2-surfaces.mjs.
const RIM_SCALE = 1 / Math.cos(Math.PI / LAKE_SEGMENTS)

// A shape-1 lake's rim is the RECTANGLE ITSELF, exactly, which is why there is no superellipse exponent here any more. There was one -- 8, a rectangle with a corner radius of about a tenth of the short half-extent, "what a lake edge actually looks like" -- and it was drawing a shape the document does not have: water-bodies.js's footprint() tests shape 1 as max(|x/rx|, |z/rz|), a hard rectangle with square corners, and that is what the basin is carved to and what the player reads as wet. A rounded rim over a square basin leaves the four corners of the bed uncovered, which is bare ground inside the lake. Rounding is authored by choosing shape 0.
//
// It falls out of the fan for free at a multiple of eight segments: cast a ray at every multiple of 45 degrees onto the rectangle and the hits ARE its four corners and its four edge midpoints, so the polygon through them is the rectangle and not an approximation of one.
if (LAKE_SEGMENTS % 8 !== 0) throw new Error(`ribbon.js: LAKE_SEGMENTS is ${LAKE_SEGMENTS}; it must be a multiple of 8 or a shape-1 lake's rim cuts its own corners off`)

// How far above the road spline's y the road ribbon sits, in metres.
//
// THIS IS Z-FIGHTING MARGIN, NOT A KERB. PathSet.smoothRoads returns the spline's own y verbatim inside halfWidth, so a ribbon at exactly that y is coplanar with the ground it lies on and the depth test decides between them per fragment, per frame, per camera position -- the classic stipple. 5 cm wins that test everywhere and is below the noise of the surface it sits on: at a walking eye height of 1.65 m it subtends about a twentieth of a degree at 5 m, which is under a pixel. Nothing steps up onto a road here.
//
// It lives in this file rather than in road-surfaces.js because it is a number the GATE has to know: check-v2-surfaces.mjs asserts the ribbon clears the flattened terrain by exactly this and no more, and importing road-surfaces.js to learn it would drag three.js into a node script that deliberately has none.
export const ROAD_LIFT = 0.05

// How far a river ribbon reaches past its own halfWidth, and the cap on that as a fraction of the halfWidth. Absolute metres alone would turn a 3 m stream into a 4.5 m one; a fraction alone would push a 60 m river 15 m into its bank. The river carve bottoms out at the centreline and returns to zero at halfWidth, so the ground is already rising at the ribbon's edge and a quarter of a half-width is enough to bury it.
export const RIVER_WIDEN = 0.75
export const RIVER_WIDEN_FRAC = 0.25

// How much of the corner's own circumradius the offset is allowed to use before the miter limit bites. Below 1.0 the inner offset edge cannot reach the centre of curvature, which is the point at which it inverts. 0.8 leaves headroom for the fact that a flattened spline's corner circumradius is a discrete estimate of a continuous curvature.
const MITER_SAFETY = 0.8

// The narrowest a clamped ribbon may get, in metres. A hairpin degenerates toward a point; this stops it degenerating to an exactly-zero-area triangle, which is a NaN normal and a hole rather than a pinch.
const MIN_HALF = 0.02

// Halving passes the exact repair loop gets before it gives up. It converges by construction -- at w = 0 every offset edge is the segment itself, whose dot with its own direction is its squared length -- so exhausting this means the polyline has a genuine cusp and the caller gets a throw rather than inverted triangles.
const REPAIR_PASSES = 24

// Signed area x2 of a triangle projected to XZ. Sign convention: this is the NEGATIVE of the y component of the 3D cross product, so an upward-facing (+Y normal) triangle comes out NEGATIVE here. Every triangle both generators emit must be negative; the gate checks exactly that.
const cross2 = (ax, az, bx, bz) => ax * bz - az * bx

/**
 * Segments in a lake's rim: eight, always. See LAKE_SEGMENTS.
 *
 * It stays a FUNCTION of the extents rather than becoming a bare constant because it is also where a degenerate lake is caught -- discVertices would happily emit a fan of zero-area triangles for rx 0 -- and because the count being size-independent is a decision that could be revisited, whereas callers asking "how many segments does this lake get" is not.
 */
export function discSegments(rx, rz) {
  const r = Math.max(rx, rz)
  if (!(r > 0)) throw new Error(`discSegments: lake half-extents must be positive, got rx ${rx} rz ${rz}`)
  return LAKE_SEGMENTS
}

/**
 * A lake's water surface: a radial fan at `lake.y`, in world space.
 *
 * `lake` is a LakeSet record -- { x, z, y, rx, rz, rot, shape } -- and `rot` is radians about +Y, matching three's own rotation matrix so the disc and the gizmo cannot disagree about which way positive is.
 *
 * A fan rather than a strip because the surface is flat and the shading is entirely a function of world XZ (see src/water.js): interior vertices buy nothing at all, so N + 1 vertices and N triangles is the whole cost -- nine vertices and eight triangles, for a pond and for a lake the width of the world alike.
 */
export function discVertices(lake, opts = {}) {
  const { overhang = LAKE_OVERHANG } = opts
  const { x, z, y, rx, rz, rot, shape } = lake
  for (const [name, v] of [['x', x], ['z', z], ['y', y], ['rx', rx], ['rz', rz], ['rot', rot]]) {
    if (!Number.isFinite(v)) throw new Error(`discVertices: lake ${lake.id} has non-finite ${name} (${v})`)
  }
  if (shape !== 0 && shape !== 1) throw new Error(`discVertices: lake ${lake.id} has shape ${shape}, expected 0 (ellipse) or 1 (rectangle)`)

  const segments = discSegments(rx, rz)
  const ax = rx + overhang
  const bz = rz + overhang
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)

  const positions = new Float32Array((segments + 1) * 3)
  const indices = new Uint32Array(segments * 3)

  positions[0] = x
  positions[1] = y
  positions[2] = z

  for (let k = 0; k < segments; k++) {
    const th = (2 * Math.PI * k) / segments
    const c = Math.cos(th)
    const s = Math.sin(th)
    let lx
    let lz
    if (shape === 0) {
      // RIM_SCALE here and not on the rectangle: an ellipse can only be approximated by a polygon, so its rim is pushed out until the edge midpoints land back on the footprint, while the rectangle's rim is exact and needs no push at all.
      lx = ax * RIM_SCALE * c
      lz = bz * RIM_SCALE * s
    } else {
      // The UNIT SQUARE cast along the ray at angle th, then stretched by (ax, bz): the affine image of a unit-square polygon, exactly as the ellipse case is the affine image of a circle.
      //
      // NOT a ray cast against the already-stretched shape, which is what this was. The two agree on a square lake and diverge hard on a long one: casting at uniform WORLD angle puts almost every vertex in the short direction, so a 100 x 10 m rectangular lake spent seven of its eight vertices on the ends and the rim along the flat fell to 0.58 of the footprint -- 42 m of bed showing. Sampling the unit shape instead makes the coverage independent of how elongated the lake is, which is the only reason eight vertices can be enough for both shapes.
      const t = 1 / Math.max(Math.abs(c), Math.abs(s))
      lx = ax * t * c
      lz = bz * t * s
    }
    // Local -> world, and it is the INVERSE of the rotation water-bodies.js's footprint() applies. That function takes a world offset to the lake's frame with [[c, s], [-s, c]]; getting back out wants [[c, -s], [s, c]], and using the first matrix in both directions is a bug that is invisible on a round lake and silently mirrors the rotation of an elongated one -- the drawn water at ninety degrees to the basin it was carved into. The gate checks the drawn rim against footprint() itself for exactly this reason.
    const o = (k + 1) * 3
    positions[o] = x + lx * cs - lz * sn
    positions[o + 1] = y
    positions[o + 2] = z + lx * sn + lz * cs
  }

  // Wound (centre, k+1, k) rather than (centre, k, k+1): with theta increasing the naive order faces -Y, which draws a lake you can only see from underneath.
  for (let k = 0; k < segments; k++) {
    const o = k * 3
    indices[o] = 0
    indices[o + 1] = ((k + 1) % segments) + 1
    indices[o + 2] = k + 1
  }

  return { segments, positions, indices, triangles: segments, vertices: segments + 1 }
}

/**
 * A path's surface ribbon: two vertices per sample, offset along the 2D normal of the tangent, triangulated as a strip.
 *
 * `samples` is a flattened spline -- a Float32Array of packed (x, y, z, halfWidth) quads, which is what Spline.flatten returns. The offset is XZ-ONLY: a water surface is horizontal across its width whatever the valley wall is doing, and a road that banked with its own tangent would roll the camera on every bend.
 *
 * Options:
 *   widen / widenFrac  extra half-width, min(widen, halfWidth * widenFrac). See RIVER_WIDEN.
 *   lift               metres added to every y. Roads use it; see road-surfaces.js.
 *   minHalf            the miter clamp's floor.
 *
 * THE THING THAT WILL BITE, and it is the reason this function is longer than a strip has any right to be. On a turn tighter than the half-width the inner offset edge crosses itself: the ribbon folds, the folded quad's triangles come out with the opposite winding, and what you get is a black wedge that is lit from underneath and z-fights with the half of the ribbon it is folded over. It is not a rare case -- one control point dragged past its neighbour produces it -- so it is handled twice over: an analytic cap from the corner's circumradius, which narrows the ribbon SMOOTHLY through the turn, and then an exact per-triangle orientation test that halves whatever the analytic cap missed. The exact test is the same predicate the gate asserts, so the generator and the check cannot drift apart.
 */
export function ribbonVertices(samples, opts = {}) {
  const { widen = 0, widenFrac = 0, lift = 0, minHalf = MIN_HALF } = opts
  if (!samples || typeof samples.length !== 'number') throw new Error('ribbonVertices: samples must be an array-like of packed (x, y, z, halfWidth) quads')
  if (samples.length % 4 !== 0) throw new Error(`ribbonVertices: sample buffer length ${samples.length} is not a multiple of 4`)
  const n = samples.length / 4
  if (n < 2) throw new Error(`ribbonVertices: a ribbon needs at least 2 samples, got ${n}`)

  const px = new Float64Array(n)
  const py = new Float64Array(n)
  const pz = new Float64Array(n)
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    px[i] = samples[o]
    py[i] = samples[o + 1] + lift
    pz[i] = samples[o + 2]
    const hw = samples[o + 3]
    if (!Number.isFinite(px[i]) || !Number.isFinite(py[i]) || !Number.isFinite(pz[i])) throw new Error(`ribbonVertices: sample ${i} is not finite`)
    if (!(hw > 0)) throw new Error(`ribbonVertices: sample ${i} has halfWidth ${hw}, expected > 0`)
    w[i] = hw + (widen > 0 ? Math.min(widen, hw * widenFrac) : 0)
  }

  // Segment directions and lengths, XZ only -- everything the offset and the fold test care about is a plan-view question.
  const dx = new Float64Array(n - 1)
  const dz = new Float64Array(n - 1)
  const dl = new Float64Array(n - 1)
  for (let i = 0; i < n - 1; i++) {
    const ex = px[i + 1] - px[i]
    const ez = pz[i + 1] - pz[i]
    const l = Math.hypot(ex, ez)
    if (!(l > 1e-6)) throw new Error(`ribbonVertices: samples ${i} and ${i + 1} are coincident in XZ (${l.toExponential(2)} m apart); a flattened spline must not repeat a point`)
    dx[i] = ex / l
    dz[i] = ez / l
    dl[i] = l
  }

  // Per-sample normal: the angle bisector, NOT scaled by the miter factor 1/cos(half-angle). The miter scale is what blows up to infinity on a sharp turn; a plain bisector holds the width honest through the corner and lets the clamp below decide how much of it survives.
  const nx = new Float64Array(n)
  const nz = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let tx
    let tz
    if (i === 0) {
      tx = dx[0]
      tz = dz[0]
    } else if (i === n - 1) {
      tx = dx[n - 2]
      tz = dz[n - 2]
    } else {
      tx = dx[i - 1] + dx[i]
      tz = dz[i - 1] + dz[i]
      const l = Math.hypot(tx, tz)
      if (!(l > 1e-6)) throw new Error(`ribbonVertices: sample ${i} reverses the path exactly (180 degree cusp); centripetal Catmull-Rom is supposed to make this impossible, so the control points are the bug, not this ribbon`)
      tx /= l
      tz /= l
    }
    nx[i] = -tz
    nz[i] = tx
  }

  // Arc length in 3D, not XZ. `u` is metres along the road as walked, so a switchback that climbs 40 m over 60 m of plan distance gets the 72 m of texture it actually has under it.
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1])
  }

  // Pass 1, analytic: the corner through samples i-1, i, i+1 has circumradius ds / (2 sin(turn / 2)). An offset longer than that reaches past the centre of curvature and comes out the other side, which IS the fold. Capping at MITER_SAFETY of it narrows the ribbon over the whole turn rather than at the one worst vertex, so a river tapers into a hairpin instead of stepping into it.
  let clamped = 0
  for (let i = 1; i < n - 1; i++) {
    const dot = Math.max(-1, Math.min(1, dx[i - 1] * dx[i] + dz[i - 1] * dz[i]))
    const turn = Math.acos(dot)
    if (turn < 1e-4) continue
    const ds = 0.5 * (dl[i - 1] + dl[i])
    const cap = (MITER_SAFETY * ds) / (2 * Math.sin(turn / 2))
    if (w[i] > cap) {
      w[i] = Math.max(cap, minHalf)
      clamped++
    }
  }

  // Pass 2, exact: the analytic cap is a per-vertex estimate and the failure is a per-QUAD one, so the quads get tested directly. Both triangles of every quad must keep the sign an upward-facing triangle has; anything else means this segment folded, and the two samples it spans get halved until it does not. Converges because w = 0 makes both offset edges the segment itself.
  let bad = 0
  for (let pass = 0; pass <= REPAIR_PASSES; pass++) {
    bad = 0
    for (let i = 0; i < n - 1; i++) {
      const a0x = px[i] + w[i] * nx[i]
      const a0z = pz[i] + w[i] * nz[i]
      const b0x = px[i] - w[i] * nx[i]
      const b0z = pz[i] - w[i] * nz[i]
      const a1x = px[i + 1] + w[i + 1] * nx[i + 1]
      const a1z = pz[i + 1] + w[i + 1] * nz[i + 1]
      const b1x = px[i + 1] - w[i + 1] * nx[i + 1]
      const b1z = pz[i + 1] - w[i + 1] * nz[i + 1]
      const t0 = cross2(a1x - a0x, a1z - a0z, b0x - a0x, b0z - a0z)
      const t1 = cross2(a1x - b0x, a1z - b0z, b1x - b0x, b1z - b0z)
      if (t0 >= 0 || t1 >= 0) {
        bad++
        w[i] = Math.max(minHalf, w[i] * 0.5)
        w[i + 1] = Math.max(minHalf, w[i + 1] * 0.5)
        clamped++
      }
    }
    if (bad === 0) break
  }
  if (bad !== 0) throw new Error(`ribbonVertices: ${bad} segment(s) still invert at the ${minHalf} m width floor after ${REPAIR_PASSES} halvings; the polyline has a cusp no miter limit can rescue`)

  const positions = new Float32Array(n * 2 * 3)
  const normals = new Float32Array(n * 2 * 3)
  const uvs = new Float32Array(n * 2 * 2)
  const indices = new Uint32Array((n - 1) * 6)

  for (let i = 0; i < n; i++) {
    // 3D tangent, central difference where there is one, so the surface normal follows the grade rather than the plan.
    const a = i === 0 ? 0 : i - 1
    const b = i === n - 1 ? n - 1 : i + 1
    let tx = px[b] - px[a]
    let ty = py[b] - py[a]
    let tz = pz[b] - pz[a]
    const tl = Math.hypot(tx, ty, tz)
    tx /= tl
    ty /= tl
    tz /= tl
    // The ribbon is a ruled surface between the horizontal offset direction and that tangent, so its normal is their cross product. On flat ground it collapses to (0, 1, 0) exactly.
    let mx = -nz[i] * ty
    let my = nz[i] * tx - nx[i] * tz
    let mz = nx[i] * ty
    const ml = Math.hypot(mx, my, mz)
    mx /= ml
    my /= ml
    mz /= ml

    const o = i * 6
    positions[o] = px[i] + w[i] * nx[i]
    positions[o + 1] = py[i]
    positions[o + 2] = pz[i] + w[i] * nz[i]
    positions[o + 3] = px[i] - w[i] * nx[i]
    positions[o + 4] = py[i]
    positions[o + 5] = pz[i] - w[i] * nz[i]
    normals[o] = mx
    normals[o + 1] = my
    normals[o + 2] = mz
    normals[o + 3] = mx
    normals[o + 4] = my
    normals[o + 5] = mz
    const q = i * 4
    uvs[q] = arc[i]
    uvs[q + 1] = 0
    uvs[q + 2] = arc[i]
    uvs[q + 3] = 1
  }

  for (let i = 0; i < n - 1; i++) {
    const o = i * 6
    const a0 = i * 2
    const b0 = a0 + 1
    const a1 = a0 + 2
    const b1 = a0 + 3
    indices[o] = a0
    indices[o + 1] = a1
    indices[o + 2] = b0
    indices[o + 3] = b0
    indices[o + 4] = a1
    indices[o + 5] = b1
  }

  return {
    count: n,
    positions,
    normals,
    uvs,
    indices,
    // Float64 internally so the repair loop's halvings stay exact; handed out as Float32 because nothing downstream needs more and the editor may hold one of these per path.
    arc: Float32Array.from(arc),
    halfWidths: Float32Array.from(w),
    length: arc[n - 1],
    clamped,
    triangles: (n - 1) * 2,
    vertices: n * 2,
  }
}
