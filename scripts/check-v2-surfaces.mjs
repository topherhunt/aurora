// The v2 surface geometry, checked without a browser.
//
// src/v2/render/ribbon.js is the arithmetic behind every lake disc, river ribbon and road ribbon in a v2 world, and it is deliberately three-free so that this file can exercise it directly -- no GL context, no stub renderer, no shader compile. What is being checked is not that something drew: it is that the vertices are in the right places, that the winding is uniform, and that the miter clamp really does stop an inside corner folding the ribbon through itself. All three fail silently on screen. A folded ribbon looks like a dark smear, a mis-wound disc looks like a lake that is only visible from underneath, and a segment rule that is quietly wrong looks like a slightly polygonal shoreline nobody mentions for a month.
//
// Section 6 is the exception and imports three.js, because Markers is a three class and the bug it guards is not arithmetic. three constructs InstancedMesh, Scene and BufferGeometry perfectly well in node -- what needs a GPU is rendering, and nothing here renders.
//
//   node scripts/check-v2-surfaces.mjs

import { pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { Markers } from '../src/v2/render/markers.js'
import { ribbonVertices, discVertices, discSegments, LAKE_OVERHANG, RIVER_WIDEN, RIVER_WIDEN_FRAC, ROAD_LIFT } from '../src/v2/render/ribbon.js'
import { Layers } from '../src/v2/layers/layers.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
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
  // A lake rim is EIGHT segments at every size (ribbon.js, LAKE_SEGMENTS), circumscribed rather than inscribed so the polygon covers the water it stands for. The old rule picked the count from a sag budget and could afford to be inscribed because the error was under half a metre; at eight segments the inscribed error is 7.6% of the radius, which on a 400 m lake is a 30 m bite of bare lake bed showing through the water at each of eight places around the shore.
  //
  // So COVERAGE is the assertion this section is really about, and it is checked by sampling the chords rather than by re-deriving sec(pi/N) here: every point on every rim edge must be outside the authored footprint, at every size, at both shapes, elongated, and rotated. That is the property that survives a change of parametrisation -- and it is exactly what failed for a long shape-1 lake before the superellipse switched to sampling the unit curve.
  {
    // Sizes: the pond the lake tool places by default, a mid-sized lake, a big one, and WORLD_HALF -- read from config rather than typed, so that if the world box moves again (it has, twice) this follows it instead of testing a size the box can no longer hold.
    for (const rmax of [40, 400, 1500, WORLD_HALF]) {
      const lake = { id: `l${rmax}`, x: 100, z: -250, y: 130, rx: rmax, rz: rmax * 0.6, rot: 0.4, shape: 0, carve: 1, depth: 8 }
      const d = discVertices(lake)
      check(
        d.segments === 8 && d.vertices === 9 && d.triangles === 8,
        `a ${rmax} m half-extent lake is an octagon`,
        `${d.segments} segments, ${d.vertices} verts, ${d.triangles} tris`
      )
      check(discSegments(rmax, rmax * 0.6) === 8, `discSegments agrees for ${rmax} m`)
    }

    // Coverage, over the cases that can break it independently: both shapes, round and long, unrotated and rotated. `footprint` is 0 outside the rim and positive inside, so a single non-zero sample anywhere on a chord is water that is not being drawn.
    for (const shape of [0, 1]) {
      for (const [rx, rz] of [[20, 20], [400, 240], [100, 10], [10, 100]]) {
        for (const rot of [0, 0.9, -2.1]) {
          const lake = { id: 'lc', x: -30, z: 70, y: 12, rx, rz, rot, shape, carve: 1, depth: 4 }
          const d = discVertices(lake)
          let worst = 0
          for (let k = 0; k < d.segments; k++) {
            const a = (k + 1) * 3
            const b = ((k + 1) % d.segments + 1) * 3
            // Nine samples per chord rather than the midpoint alone: the midpoint is the deepest cut only when the two vertices are equidistant from the centre, which they are not on a long lake.
            for (let t = 0; t <= 8; t++) {
              const u = t / 8
              const px = d.positions[a] + (d.positions[b] - d.positions[a]) * u
              const pz = d.positions[a + 2] + (d.positions[b + 2] - d.positions[a + 2]) * u
              worst = Math.max(worst, footprint(lake, px, pz))
            }
          }
          check(worst === 0, `a ${rx}x${rz} m shape-${shape} lake at ${rot} rad is covered by its own rim`, `deepest uncovered footprint ${worst.toFixed(3)}`)
        }
      }
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

    // And the plain algebra, so the check still says something if water-bodies.js ever moves. SEC is ribbon.js's RIM_SCALE, re-derived here rather than imported: the point of this assertion is that the two derivations agree.
    const SEC = 1 / Math.cos(Math.PI / d.segments)
    const cs = Math.cos(lake.rot)
    const sn = Math.sin(lake.rot)
    let worst = 0
    for (let k = 0; k < d.segments; k++) {
      const th = (2 * Math.PI * k) / d.segments
      const lx = (lake.rx + LAKE_OVERHANG) * SEC * Math.cos(th)
      const lz = (lake.rz + LAKE_OVERHANG) * SEC * Math.sin(th)
      worst = Math.max(
        worst,
        Math.abs(d.positions[(k + 1) * 3] - (lake.x + lx * cs - lz * sn)),
        Math.abs(d.positions[(k + 1) * 3 + 2] - (lake.z + lx * sn + lz * cs))
      )
    }
    check(worst < 1e-3, 'rim vertices land on the circumscribed rotated ellipse', `worst ${worst.toExponential(1)} m`)

    // The edge midpoint of the circumscribed octagon lands ON the dilated rim, which is the whole reason for the sec(pi/N): further out wastes overhang, further in is uncovered water. Measured on a round lake, where the ellipse's affine argument and the circle's are the same number.
    {
      const round = { id: 'lr8', x: 0, z: 0, y: 0, rx: 100, rz: 100, rot: 0, shape: 0, carve: 1, depth: 4 }
      const r8 = discVertices(round)
      const mx = (r8.positions[3] + r8.positions[6]) / 2
      const mz = (r8.positions[5] + r8.positions[8]) / 2
      const mid = Math.hypot(mx, mz)
      check(Math.abs(mid - (round.rx + LAKE_OVERHANG)) < 1e-3, 'the rim edge midpoint sits exactly on the dilated footprint', `${mid.toFixed(4)} m vs ${(round.rx + LAKE_OVERHANG).toFixed(4)} m`)
    }

    // A rectangle is a superellipse, so it has to reach further into its corners than an ellipse does -- 1.40 normalised against the ellipse's flat 1.08 -- while still being the same eight vertices.
    const rect = discVertices({ ...lake, id: 'lr', rot: 0, shape: 1 })
    let corner = 0
    for (let k = 0; k < rect.segments; k++) {
      const px = rect.positions[(k + 1) * 3] - lake.x
      const pz = rect.positions[(k + 1) * 3 + 2] - lake.z
      corner = Math.max(corner, Math.hypot(px / (lake.rx + LAKE_OVERHANG), pz / (lake.rz + LAKE_OVERHANG)))
    }
    check(corner > 1.2, 'a rectangular lake actually reaches into its corners', `furthest normalised radius ${corner.toFixed(2)} vs ${(1 / Math.cos(Math.PI / rect.segments)).toFixed(2)} for an ellipse`)
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

  // --- 6. handles survive a deletion -----------------------------------------
  //
  // THIS IS A CRASH THAT ONLY EXISTS AFTER AN EDIT, which is why it needs a check that edits. Both layers tombstone a removed point (`pts[i] = null`, `points[i] = null`) instead of splicing, so a handle index stays pinned to the point it was pinned to; the cost is that every consumer walking the raw array meets a null. Markers.sync walked one of those arrays by destructuring, which is a TypeError the moment anyone deletes a control point, and no amount of checking the geometry of an unedited world would have found it.
  //
  // The second half matters as much as the first. Not crashing is easy -- a loop that compacts as it goes does not crash either, and it silently repoints every handle above the hole, so the editor's selection jumps to a different point and a drag moves the wrong one. So this asserts the identity, not just the survival: a marker that addressed control point 3 still addresses control point 3, and still sits where control point 3 sits.
  {
    const doc = {
      v: 1,
      snow: { base: 100, band: 40, points: [[0, 0, 10, 200], [300, 300, -8, 150]] },
      lakes: [],
      rivers: [],
      roads: [{ id: 'd', feather: 8, pts: [[-500, 80, 400, 4], [-120, 74, 320, 4], [300, 66, 380, 5], [700, 61, 520, 5]] }],
    }
    const layers = new Layers(doc)
    const markers = new Markers({ scene: new THREE.Scene(), layers })
    markers.sync()

    const slotOf = (index) => markers.kinds.spline.records.findIndex((r) => r.id === 'd' && r.index === index)
    const posOf = (slot) => [markers.kinds.spline.positions[slot * 3], markers.kinds.spline.positions[slot * 3 + 1], markers.kinds.spline.positions[slot * 3 + 2]]
    const before = posOf(slotOf(3))
    check(markers.kinds.spline.count === 4, 'four control points, four handles', `${markers.kinds.spline.count}`)

    // Point 1 is a middle point: deleting an end would not shift anything even under a splice, so it would prove nothing.
    layers.paths.removePoint('d', 1)
    let threw = null
    try {
      markers.sync()
    } catch (e) {
      threw = e
    }
    check(threw === null, 'deleting a middle control point does not crash the next sync', threw === null ? '' : threw.message)

    if (threw === null) {
      check(markers.kinds.spline.count === 3, 'the deleted point loses its handle and nothing else does', `${markers.kinds.spline.count} handles`)
      check(slotOf(1) === -1, 'no handle still claims the tombstoned index')
      const slot = slotOf(3)
      check(slot !== -1, 'the handle above the hole is still published under its own index')
      if (slot !== -1) {
        const after = posOf(slot)
        check(
          Math.abs(after[0] - before[0]) < 1e-6 && Math.abs(after[1] - before[1]) < 1e-6 && Math.abs(after[2] - before[2]) < 1e-6,
          'and it still sits exactly where control point 3 sits',
          `${after.map((v) => v.toFixed(1)).join(', ')}`
        )
      }
      // The same convention on the other layer, and the loop that already had it right: deleting snow point 0 must leave point 1 addressed as 1.
      layers.snow.removePoint(0)
      markers.sync()
      check(markers.kinds.snow.count === 1 && markers.kinds.snow.records[0].index === 1, 'a snow handle above a hole keeps its own index too', `index ${markers.kinds.snow.records[0].index}`)
    }

    markers.dispose()
  }

  // --- 7. the invariants that must throw ------------------------------------
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

  // --- 8. the shoreline fringe -----------------------------------------------
  //
  // shoreDistAt is what the fern, grass and boulder scatters read to run lusher along the water, and it fails the way levelAt fails: silently, as a fringe that is a few metres off, or missing on one side of a river. So the distances are pinned by hand on bodies whose geometry makes the answer obvious -- a circle, an unrotated rectangle, a straight river -- and then the SIGN is checked against levelAt over a spray of points, because the two are the same footprint asked two questions and must never disagree about which side of the edge a point is on.
  //
  // The first half stands on a bed well under every surface and dead level, which silences the waterline term and measures the footprints alone. The second half is the waterline term on its own: the shipped world's ocean is a 20 km plane under the whole landscape, and the fringe must be where the ground meets it, not around a rim in the next county.
  {
    // The document authors the FULL width; the flattened samples carry the half.
    const WIDTH = 12
    const HW = WIDTH / 2
    const doc = {
      v: 1,
      snow: { base: 100, band: 40, points: [] },
      lakes: [
        { id: 'round', x: 0, z: 0, y: 10, rx: 40, rz: 40, rot: 0, shape: 0, carve: 1, depth: 4 },
        { id: 'rect', x: 300, z: 0, y: 10, rx: 50, rz: 30, rot: 0, shape: 1, carve: 1, depth: 4 },
      ],
      rivers: [{ id: 'r', depth: 2, pts: [[-200, 5, -300, WIDTH], [-60, 5, -300, WIDTH], [60, 5, -300, WIDTH], [200, 5, -300, WIDTH]] }],
      roads: [],
    }
    const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers: new Layers(doc) })
    ws.rebuild()
    const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol
    const REACH = 20
    const BED = 0
    const dist = (x, z, reach) => ws.shoreDistAt(x, z, reach, BED, 0)

    check(near(dist(60, 0, REACH), 20), 'a circle answers its rim distance on the dry side', `${dist(60, 0, REACH).toFixed(3)}`)
    check(near(dist(30, 0, REACH), -10), 'and the same distance, negative, inside', `${dist(30, 0, REACH).toFixed(3)}`)
    check(dist(0, 0, REACH) === -REACH, 'the centre of a lake clamps to -reach')
    check(near(dist(360, 0, REACH), 10), 'a rectangle answers its edge distance', `${dist(360, 0, REACH).toFixed(3)}`)
    check(near(dist(360, 40, REACH), Math.hypot(10, 10)), 'and the corner distance past a corner', `${dist(360, 40, REACH).toFixed(3)}`)
    check(near(dist(340, 20, REACH), -10), 'and the nearest edge, negative, inside', `${dist(340, 20, REACH).toFixed(3)}`)
    check(near(dist(0, -291, REACH), 3), 'a river answers the distance past its authored half-width', `${dist(0, -291, REACH).toFixed(3)}`)
    check(near(dist(0, -300, REACH), -HW), 'and its half-width, negative, on the centreline', `${dist(0, -300, REACH).toFixed(3)}`)
    check(dist(150, 150, REACH) === REACH, 'nothing within reach answers reach itself')
    check(dist(0, 0, 2 * REACH) === -2 * REACH, 'the clamp scales with reach', `${dist(0, 0, 2 * REACH)}`)

    // The sign against levelAt, on the three bodies at once. Points on the boundary itself are excluded rather than chased, since the two tests are `<` and `<=` of the same distance.
    let disagree = 0
    let wetSeen = 0
    let samples = 0
    for (const [cx, cz, r] of [[0, 0, 55], [300, 0, 65], [0, -300, 25]]) {
      for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 60; j++) {
          const x = cx + (i / 59 - 0.5) * 2 * r + 0.137
          const z = cz + (j / 59 - 0.5) * 2 * r + 0.071
          const d = dist(x, z, REACH)
          if (Math.abs(d) < 1e-3) continue
          samples++
          const wet = ws.levelAt(x, z) !== null
          if (wet) wetSeen++
          if (wet !== d < 0) disagree++
        }
      }
    }
    check(disagree === 0 && wetSeen > 0, 'negative exactly where levelAt is wet, on every body', `${disagree} of ${samples} disagree, ${wetSeen} wet`)

    const threw = (fn) => {
      try {
        fn()
        return false
      } catch {
        return true
      }
    }
    check(threw(() => dist(0, 0, 0)) && threw(() => dist(0, 0, -1)), 'a non-positive reach throws')
    // The 3x3 bucket block is 64 m on a side; a reach that, past the widest river, could see past it would miss segments and leave holes in the fringe.
    check(ws.maxHalfWidth === HW, 'the widest authored half-width is recorded', `${ws.maxHalfWidth}`)
    check(!threw(() => dist(0, 0, 64 - HW)) && threw(() => dist(0, 0, 64 - HW + 1)), 'a reach that overruns the lookup bucket throws')
    check(threw(() => ws.shoreDistAt(0, 0, REACH)) && threw(() => ws.shoreDistAt(0, 0, REACH, 5, -1)), 'a call without the ground height and slope throws')
    ws.dispose()

    // The waterline term, on a plane the size of the ocean: ground above it is dry by how far it has to run down its slope to meet the surface, ground below it is wet by the same measure, and a plateau over it is nowhere near a shore however deep inside the footprint it stands.
    const LEVEL = 100
    const sea = new WaterSurfaces({
      water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() },
      layers: new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [{ id: 'sea', x: 0, z: 0, y: LEVEL, rx: 10000, rz: 10000, rot: 0, shape: 1, carve: 0, depth: 8 }], rivers: [], roads: [] }),
    })
    sea.rebuild()
    check(sea.shoreDistAt(0, 0, REACH, LEVEL + 150, 0.3) === REACH, 'a landscape over a buried plane is not a shore')
    check(sea.shoreDistAt(0, 0, REACH, LEVEL + 0.3, 0) === REACH, 'nor is level ground a hand above it')
    check(near(sea.shoreDistAt(0, 0, REACH, LEVEL + 2, 0.5), 4), 'a bank 2 m over the plane at 1:2 is 4 m from the shore', `${sea.shoreDistAt(0, 0, REACH, LEVEL + 2, 0.5).toFixed(3)}`)
    check(near(sea.shoreDistAt(0, 0, REACH, LEVEL - 2, 0.5), -4), 'and a floor 2 m under it is 4 m out', `${sea.shoreDistAt(0, 0, REACH, LEVEL - 2, 0.5).toFixed(3)}`)
    check(sea.shoreDistAt(0, 0, REACH, LEVEL - 30, 0.5) === -REACH, 'deep water clamps to -reach')
    check(sea.levelAt(0, 0) === LEVEL, 'while levelAt still answers the plane everywhere under it')
    sea.dispose()
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  // THROW rather than return the count. scripts/check-v2.mjs runs each section inside a try/catch and ignores what run() returns, so a section that reports failure by returning a number reports it to nobody: the FAIL lines scroll past and the aggregator still prints ALL SECTIONS PASSED. Every other check-v2-*.mjs throws here; this one did not, which made the combined gate silently blind to this whole section.
  if (failures > 0) throw new Error(`check-v2-surfaces: ${failures} check(s) failed`)
  return failures
}

// Guarded against argv[1] being undefined, which is what happens under `node -e` and inside any harness that imports run() without a script path. pathToFileURL(undefined) THROWS, so the old form turned "someone imported this module" into a crash from the module's own tail -- a failure that looks like a broken gate rather than a missing argument.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
