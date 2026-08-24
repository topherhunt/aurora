// The v2 surface geometry, checked without a browser and without three.js.
//
// src/v2/render/ribbon.js is the arithmetic behind every lake disc, river ribbon and road ribbon in a v2 world, and it is deliberately three-free so that this file can exercise it directly -- no GL context, no stub renderer, no shader compile. What is being checked is not that something drew: it is that the vertices are in the right places, that the winding is uniform, and that the miter clamp really does stop an inside corner folding the ribbon through itself. All three fail silently on screen. A folded ribbon looks like a dark smear, a mis-wound disc looks like a lake that is only visible from underneath, and a segment rule that is quietly wrong looks like a slightly polygonal shoreline nobody mentions for a month.
//
//   node scripts/check-v2-surfaces.mjs

import { pathToFileURL } from 'node:url'
import { ribbonVertices, discVertices, discSegments, LAKE_OVERHANG, RIVER_WIDEN, RIVER_WIDEN_FRAC, ROAD_LIFT } from '../src/v2/render/ribbon.js'
import { Layers } from '../src/v2/layers/layers.js'
// The one thing this file imports from outside its own subject, and deliberately: a lake disc that disagrees with the footprint it is drawn over is the failure that renders perfectly and is still wrong, so the two are checked against each other rather than against two copies of the same algebra.
import { footprint } from '../src/v2/layers/water-bodies.js'
import { WORLD_HALF } from '../src/v2/config.js'

// Signed area x2 in XZ, matching ribbon.js's convention exactly: NEGATIVE is an upward-facing triangle. Written out again here rather than imported, because a check that borrows the predicate it is checking proves only that a function equals itself.
const cross2 = (ax, az, bx, bz) => ax * bz - az * bx

function triAreas({ positions, indices }) {
  const out = new Float64Array(indices.length / 3)
  for (let t = 0; t < out.length; t++) {
    const a = indices[t * 3] * 3
    const b = indices[t * 3 + 1] * 3
    const c = indices[t * 3 + 2] * 3
    out[t] = cross2(
      positions[b] - positions[a],
      positions[b + 2] - positions[a + 2],
      positions[c] - positions[a],
      positions[c + 2] - positions[a + 2]
    )
  }
  return out
}

/** Pack (x, y, z, halfWidth) tuples the way Spline.flatten does. */
const packed = (pts) => Float32Array.from(pts.flat())

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log('\n=== v2 surface geometry ===\n')

  // --- 1. a straight ribbon --------------------------------------------------
  //
  // The easy case, and it is here because it is the one that pins the COUNTS. Everything below deforms the ribbon; this says what an undeformed one weighs.
  {
    const N = 200
    const SPACING = 5
    const HALF = 4
    const pts = []
    for (let i = 0; i < N; i++) pts.push([i * SPACING, 12, 0, HALF])
    const r = ribbonVertices(packed(pts), { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })

    check(r.count === N && r.vertices === N * 2, 'straight ribbon emits two vertices per sample', `${r.count} samples -> ${r.vertices} verts`)
    check(r.positions.length === N * 2 * 3 && r.uvs.length === N * 2 * 2 && r.normals.length === N * 2 * 3, 'position, normal and uv buffers are all sized to the vertex count')
    check(r.indices.length === (N - 1) * 6 && r.triangles === (N - 1) * 2, 'strip is two triangles per segment', `${r.triangles} tris, ${r.indices.length} indices`)
    check(r.clamped === 0, 'a straight ribbon clamps nothing', `${r.clamped} clamped`)

    const areas = triAreas(r)
    let minAbs = Infinity
    let wrongSign = 0
    for (const a of areas) {
      minAbs = Math.min(minAbs, Math.abs(a))
      if (a >= 0) wrongSign++
    }
    check(wrongSign === 0, 'every straight-ribbon triangle faces up', `${wrongSign} of ${areas.length} wound the other way`)
    // A degenerate triangle is a NaN normal and a hole, and it is the failure a naive strip produces at a repeated sample.
    check(minAbs > 1e-6, 'no zero-area triangles anywhere on a straight ribbon', `smallest |2A| ${minAbs.toFixed(3)} m^2`)

    // The widen is min(RIVER_WIDEN, half * RIVER_WIDEN_FRAC): 0.75 against 1.0 here, so the absolute cap is the one that bites.
    const want = HALF + Math.min(RIVER_WIDEN, HALF * RIVER_WIDEN_FRAC)
    const got = Math.abs(r.positions[2] - r.positions[5]) / 2
    check(Math.abs(got - want) < 1e-4, 'the river widen buries the edge past the authored half-width', `${got.toFixed(3)} m vs ${want.toFixed(3)} m`)

    const flat = r.normals.every((v, i) => Math.abs(v - (i % 3 === 1 ? 1 : 0)) < 1e-5)
    check(flat, 'a level ribbon has exactly vertical normals')
  }

  // --- 2. a hairpin tighter than the half-width ------------------------------
  //
  // THE CASE THAT MATTERS. A 0.6 m turning radius under a 3 m half-width: the inner offset edge wants to reach 2.4 m past the centre of curvature and come out the far side, which folds the ribbon and inverts every triangle in the turn. One control point dragged past its neighbour produces exactly this, so it is not an exotic input.
  {
    const HALF = 3
    const R = 0.6
    const pts = []
    for (let x = -20; x < 0; x += 2) pts.push([x, 5, 0, HALF])
    // Semicircle about (0, R), from the -Y side round to the +Y side, 12 steps of 15 degrees. Arc spacing 0.157 m, so the corner circumradius the miter cap computes lands on R itself.
    for (let k = 0; k <= 12; k++) {
      const th = -Math.PI / 2 + (k * Math.PI) / 12
      pts.push([R * Math.cos(th), 5, R + R * Math.sin(th), HALF])
    }
    for (let x = -2; x >= -20; x -= 2) pts.push([x, 5, 2 * R, HALF])

    const r = ribbonVertices(packed(pts), { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
    const areas = triAreas(r)
    let inverted = 0
    for (const a of areas) if (a >= 0) inverted++

    check(inverted === 0, 'a hairpin tighter than the half-width emits no inverted triangles', `${inverted} of ${areas.length} inverted`)
    check(r.clamped > 0, 'the miter limit actually fires on the hairpin', `${r.clamped} clamp events`)
    check(r.positions.every(Number.isFinite) && r.normals.every(Number.isFinite), 'no NaN survives the clamp')

    // The clamp must degenerate toward a point, not merely nudge: at the apex the half-width has to come down from 3.75 m to under the 0.6 m turning radius or the ribbon is still folded, whatever the triangle test says about this particular sampling.
    let narrowest = Infinity
    for (const w of r.halfWidths) narrowest = Math.min(narrowest, w)
    check(narrowest < R, 'the ribbon narrows below its own turning radius at the apex', `narrowest ${narrowest.toFixed(3)} m vs R ${R} m`)
    // ...and the straight approach must be untouched, or a miter limit is just a global narrowing.
    check(Math.abs(r.halfWidths[0] - (HALF + Math.min(RIVER_WIDEN, HALF * RIVER_WIDEN_FRAC))) < 1e-4, 'the straight approach keeps its full width', `${r.halfWidths[0].toFixed(3)} m`)
  }

  // --- 3. lake discs ---------------------------------------------------------
  //
  // The segment rule is sag = max(rx, rz) * pi^2 / (2 N^2), inverted for N at a 0.5 m budget and rounded up to a multiple of 8. Checked at the three sizes the rule is meant to separate: the pond the lake tool places by default, a mid-sized lake, and one big enough to hit the ceiling.
  //
  // WORLD_HALF is the fourth, and it is read from config rather than written as a literal on purpose: it is the largest half-extent the box can hold, so it is where the 128-segment ceiling is under the most strain, and if the world box moves again this check moves with it instead of quietly testing a size that no longer exists. Its sag is over LAKE_SAG and that is expected -- what must hold at every size is that the rim stays buried under LAKE_OVERHANG, which is the assertion below.
  {
    for (const [rmax, want] of [[40, 24], [400, 64], [1500, 128], [WORLD_HALF, 128]]) {
      const lake = { id: `l${rmax}`, x: 100, z: -250, y: 130, rx: rmax, rz: rmax * 0.6, rot: 0.4, shape: 0, carve: 1, depth: 8 }
      const d = discVertices(lake)
      check(
        d.segments === want && d.vertices === want + 1 && d.triangles === want,
        `a ${rmax} m half-extent lake gets ${want} segments`,
        `${d.segments} segments, ${d.vertices} verts, ${d.triangles} tris`
      )
      check(discSegments(rmax, rmax * 0.6) === want, `discSegments agrees for ${rmax} m`)

      // The sag budget is the reason for the count, so measure it rather than trusting the algebra: the deepest a chord cuts inside the rim must stay under 0.5 m, which is what keeps the polygon edge under LAKE_OVERHANG.
      let sag = 0
      const ax = rmax + LAKE_OVERHANG
      const bz = rmax * 0.6 + LAKE_OVERHANG
      for (let k = 0; k < d.segments; k++) {
        const t0 = (2 * Math.PI * k) / d.segments
        const t1 = (2 * Math.PI * (k + 1)) / d.segments
        const mx = (ax * Math.cos(t0) + ax * Math.cos(t1)) / 2
        const mz = (bz * Math.sin(t0) + bz * Math.sin(t1)) / 2
        // Distance from the chord midpoint out to the ellipse along the same ray.
        const s = Math.hypot(mx, mz)
        const ux = mx / s
        const uz = mz / s
        const hit = 1 / Math.hypot(ux / ax, uz / bz)
        sag = Math.max(sag, hit - s)
      }
      check(sag < LAKE_OVERHANG, `the ${rmax} m rim stays buried under the ${LAKE_OVERHANG} m overhang`, `worst chord sag ${sag.toFixed(3)} m`)
    }

    const lake = { id: 'lw', x: 0, z: 0, y: 100, rx: 200, rz: 90, rot: 0.9, shape: 0, carve: 1, depth: 6 }
    const d = discVertices(lake)
    const areas = triAreas(d)
    let wrongSign = 0
    let minAbs = Infinity
    for (const a of areas) {
      if (a >= 0) wrongSign++
      minAbs = Math.min(minAbs, Math.abs(a))
    }
    check(wrongSign === 0, 'every disc triangle faces up', `${wrongSign} of ${areas.length} wound the other way`)
    check(minAbs > 1e-6, 'no zero-area triangles on a disc', `smallest |2A| ${minAbs.toFixed(1)} m^2`)

    // Rotation is about +Y, and the disc has to turn the SAME way the footprint does. This is checked against water-bodies.js's own footprint() rather than against a formula written again here, because the failure it catches is precisely a formula written again here: local-to-world is the inverse of world-to-local, and using the same matrix both ways is invisible on a round lake and mirrors the rotation of an elongated one. A disc drawn at ninety degrees to the basin it was carved into still renders, still ripples, and is wrong.
    let outsideRim = 0
    let insideRim = 0
    for (let k = 0; k < d.segments; k++) {
      const px = d.positions[(k + 1) * 3]
      const pz = d.positions[(k + 1) * 3 + 2]
      // Every rim vertex is past the authored footprint, which is what LAKE_OVERHANG means.
      if (footprint(lake, px, pz) !== 0) outsideRim++
      // ...and pulling it back in by more than the overhang has to land inside it, or the disc is not merely dilated, it is somewhere else.
      const inx = lake.x + (px - lake.x) * 0.9
      const inz = lake.z + (pz - lake.z) * 0.9
      if (footprint(lake, inx, inz) <= 0) insideRim++
    }
    check(outsideRim === 0, 'every rim vertex sits outside the authored footprint', `${outsideRim} of ${d.segments} still inside`)
    check(insideRim === 0, 'the rim is the footprint dilated, not a differently-rotated shape', `${insideRim} of ${d.segments} vertices are not over their own lake`)

    // And the plain algebra, so the check still says something if water-bodies.js ever moves.
    const cs = Math.cos(lake.rot)
    const sn = Math.sin(lake.rot)
    let worst = 0
    for (let k = 0; k < d.segments; k++) {
      const th = (2 * Math.PI * k) / d.segments
      const lx = (lake.rx + LAKE_OVERHANG) * Math.cos(th)
      const lz = (lake.rz + LAKE_OVERHANG) * Math.sin(th)
      worst = Math.max(
        worst,
        Math.abs(d.positions[(k + 1) * 3] - (lake.x + lx * cs - lz * sn)),
        Math.abs(d.positions[(k + 1) * 3 + 2] - (lake.z + lx * sn + lz * cs))
      )
    }
    check(worst < 1e-3, 'rim vertices land on the rotated ellipse', `worst ${worst.toExponential(1)} m`)

    let flat = true
    for (let i = 1; i < d.positions.length; i += 3) if (d.positions[i] !== lake.y) flat = false
    check(flat, 'a lake disc is exactly level at its authored y')

    // A rectangle is a superellipse, so it must stay inside its own half-extents and get closer to the corner than an ellipse does.
    const rect = discVertices({ ...lake, id: 'lr', rot: 0, shape: 1 })
    let outside = 0
    let corner = 0
    for (let k = 0; k < rect.segments; k++) {
      const px = rect.positions[(k + 1) * 3] - lake.x
      const pz = rect.positions[(k + 1) * 3 + 2] - lake.z
      if (Math.abs(px) > lake.rx + LAKE_OVERHANG + 1e-3 || Math.abs(pz) > lake.rz + LAKE_OVERHANG + 1e-3) outside++
      corner = Math.max(corner, Math.hypot(px / (lake.rx + LAKE_OVERHANG), pz / (lake.rz + LAKE_OVERHANG)))
    }
    check(outside === 0, 'a rectangular lake stays inside its own half-extents', `${outside} vertices outside`)
    check(corner > 1.2, 'a rectangular lake actually reaches into its corners', `furthest normalised radius ${corner.toFixed(2)} vs 1.00 for an ellipse`)
  }

  // --- 4. arc length ---------------------------------------------------------
  //
  // `u` is metres along the path in 3D, not a 0..1 parameter: normalised UVs over a 3 km road mean a texture repeat of 3000 that has to be re-authored the moment a control point moves. So it has to be monotone, it has to be in metres, and it has to be the length of the thing it is measuring.
  {
    const R = 100
    const CLIMB = 30
    const STEPS = 80
    const pts = []
    for (let k = 0; k <= STEPS; k++) {
      const th = (k / STEPS) * (Math.PI / 2)
      pts.push([R * Math.cos(th), (k / STEPS) * CLIMB, R * Math.sin(th), 6])
    }
    const r = ribbonVertices(packed(pts), { lift: ROAD_LIFT })

    let monotone = true
    for (let i = 1; i < r.count; i++) if (!(r.arc[i] > r.arc[i - 1])) monotone = false
    check(monotone, 'arc length is strictly increasing along the ribbon')

    let poly = 0
    for (let i = 1; i <= STEPS; i++) {
      poly += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])
    }
    // The analytic length of the curve itself, which the polyline can only approach from below.
    const exact = Math.hypot((R * Math.PI) / 2, CLIMB)
    check(Math.abs(r.length - poly) < 1e-3, 'u totals the polyline length', `${r.length.toFixed(3)} m vs ${poly.toFixed(3)} m`)
    check(Math.abs(r.length - exact) / exact < 0.01, 'u totals the true curve length to 1%', `${r.length.toFixed(2)} m vs ${exact.toFixed(2)} m, ${((Math.abs(r.length - exact) / exact) * 100).toFixed(3)}% short`)

    // u must reach the geometry, and v must span the ribbon: a uv attribute that agrees with `arc` in the return value and not in the buffer is the same bug one indirection later.
    let uvOk = true
    for (let i = 0; i < r.count; i++) {
      if (Math.abs(r.uvs[i * 4] - r.arc[i]) > 1e-3) uvOk = false
      if (Math.abs(r.uvs[i * 4 + 2] - r.arc[i]) > 1e-3) uvOk = false
      if (r.uvs[i * 4 + 1] !== 0 || r.uvs[i * 4 + 3] !== 1) uvOk = false
    }
    check(uvOk, 'the uv buffer carries metres in u and 0..1 across in v')

    // The road lift is z-fighting margin, so it has to be exactly what was asked for and applied once.
    let lifted = true
    for (let i = 0; i < r.count; i++) if (Math.abs(r.positions[i * 6 + 1] - (pts[i][1] + ROAD_LIFT)) > 1e-4) lifted = false
    check(lifted, 'the road lift is applied to y exactly once')

    const areas = triAreas(r)
    let wrongSign = 0
    for (const a of areas) if (a >= 0) wrongSign++
    check(wrongSign === 0, 'a climbing, curving ribbon still winds consistently', `${wrongSign} of ${areas.length}`)
  }

  // --- 5. the drawn surface against the carved ground ------------------------
  //
  // Sections 1 to 4 check the ribbon against itself. This one checks it against the terrain it has to sit on, which is the only place the two halves of the feature can disagree, and it does it in RELATIONSHIPS rather than in elevations: the world's vertical range is still being surveyed out of the reference jpg, so every number here is a difference between two heights the document itself supplies. An absolute metre literal in this section would be a check with a shelf life.
  //
  // The ground handed to carve() is the spline's own y plus AMBIENT, so "the terrain before anyone dug it" is defined relative to the authored path rather than pinned to a sea level nobody has chosen yet.
  {
    const AMBIENT = 5
    const DEPTH = 2
    const HALF = 6
    const doc = {
      v: 1,
      snow: { base: 100, band: 40, points: [] },
      lakes: [],
      rivers: [{ id: 'r', depth: DEPTH, pts: [[-400, 60, -200, HALF], [-100, 55, -60, HALF], [220, 48, 90, HALF], [560, 44, 300, HALF]] }],
      roads: [{ id: 'd', feather: 8, pts: [[-500, 80, 400, 4], [-120, 74, 320, 4], [300, 66, 380, 5], [700, 61, 520, 5]] }],
    }
    const layers = new Layers(doc)
    void layers.paths.segmentCount

    const river = layers.paths.paths.get('r')
    const road = layers.paths.paths.get('d')
    const rr = ribbonVertices(river.samples, { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
    const dr = ribbonVertices(road.samples, { lift: ROAD_LIFT })

    // The stated river depth is 2 m at the middle, and it is the ribbon that has to be 2 m above the bed -- not the spline, which nobody sees. Measured at every sample's centreline, where channelProfile is exactly 1.
    let worstDepth = 0
    for (let i = 0; i < rr.count; i++) {
      const x = river.samples[i * 4]
      const y = river.samples[i * 4 + 1]
      const z = river.samples[i * 4 + 2]
      // Both ribbon vertices of this sample carry the spline y verbatim; the river gets no lift.
      const surface = rr.positions[i * 6 + 1]
      if (Math.abs(surface - y) > 1e-4) worstDepth = Infinity
      worstDepth = Math.max(worstDepth, Math.abs(surface - layers.carve(x, z, y + AMBIENT) - DEPTH))
    }
    check(worstDepth < 1e-3, `the river surface sits ${DEPTH} m above its own carved bed`, `worst error ${worstDepth.toExponential(1)} m`)

    // The widened edge exists to be buried. At halfWidth the carve has already climbed most of the way back, so the ground at the ribbon's outer edge must be ABOVE the water plane -- otherwise the overhang is drawn over open air and the shoreline is the polygon edge after all.
    let exposed = 0
    for (let i = 0; i < rr.count; i++) {
      const surface = rr.positions[i * 6 + 1]
      for (const v of [0, 1]) {
        const ex = rr.positions[i * 6 + v * 3]
        const ez = rr.positions[i * 6 + v * 3 + 2]
        if (layers.carve(ex, ez, surface + AMBIENT) < surface) exposed++
      }
    }
    check(exposed === 0, 'the widened river edge is under ground, not over air', `${exposed} of ${rr.vertices} edge vertices exposed`)

    // A road is a decal on ground that was flattened TO it, so the gap is ROAD_LIFT everywhere: any more is a kerb, any less is a stipple.
    let worstGap = 0
    for (let i = 0; i < dr.count; i++) {
      const x = road.samples[i * 4]
      const z = road.samples[i * 4 + 2]
      worstGap = Math.max(worstGap, Math.abs(dr.positions[i * 6 + 1] - layers.carve(x, z, road.samples[i * 4 + 1] + AMBIENT) - ROAD_LIFT))
    }
    check(worstGap < 1e-3, `the road surface clears the flattened terrain by exactly ${ROAD_LIFT} m`, `worst error ${worstGap.toExponential(1)} m`)
    check(ROAD_LIFT > 0, 'the road lift is a positive gap, so the depth test never has to break a tie', `${ROAD_LIFT} m`)
  }

  // --- 6. the invariants that must throw ------------------------------------
  //
  // Fail explicitly, not gracefully. Each of these is a caller bug that would otherwise produce geometry that renders and is wrong.
  {
    const threw = (fn) => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    check(threw(() => ribbonVertices(packed([[0, 0, 0, 2]]))), 'a one-sample ribbon throws')
    check(threw(() => ribbonVertices(packed([[0, 0, 0, 2], [0, 0, 0, 2], [10, 0, 0, 2]]))), 'coincident samples throw')
    check(threw(() => ribbonVertices(packed([[0, 0, 0, 2], [10, 0, 0, 0]]))), 'a zero half-width throws')
    check(threw(() => ribbonVertices(new Float32Array(7))), 'a sample buffer that is not a multiple of 4 throws')
    check(threw(() => discVertices({ id: 'x', x: 0, z: 0, y: 0, rx: 40, rz: 40, rot: 0, shape: 2 })), 'an unknown lake shape throws')
    check(threw(() => discVertices({ id: 'x', x: 0, z: 0, y: 0, rx: 0, rz: 0, rot: 0, shape: 0 })), 'a zero-extent lake throws')
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  return failures
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit((await run()) === 0 ? 0 : 1)
}
