// The v2 surface geometry, checked without a browser.
//
// src/v2/render/ribbon.js is the arithmetic behind every river ribbon in a v2 world and shoreline.js behind every lake, and both are deliberately three-free so that this file can exercise it directly -- no GL context, no stub renderer, no shader compile. What is being checked is not that something drew: it is that the vertices are in the right places, that the winding is uniform, and that the miter clamp really does stop an inside corner folding the ribbon through itself. All three fail silently on screen. A folded ribbon looks like a dark smear, a mis-wound sheet looks like a lake that is only visible from underneath, and a segment rule that is quietly wrong looks like a slightly polygonal shoreline nobody mentions for a month.
//
// Section 6 is the exception and imports three.js, because Markers is a three class and the bug it guards is not arithmetic. three constructs InstancedMesh, Scene and BufferGeometry perfectly well in node -- what needs a GPU is rendering, and nothing here renders.
//
//   node scripts/check-v2-surfaces.mjs

import { pathToFileURL } from 'node:url'
import * as THREE from 'three'
import { Markers } from '../src/v2/render/markers.js'
import { ribbonVertices, ribbonLod, lodIndices, FLOW_FADE_HALF_WIDTHS, FLOW_FADE_MIN, LOD_FINE, LOD_SPACING, LOD_TURN, LOD_CHUNK, LOD_STEP, LOD_STATE_FINE, LOD_STATE_COARSE } from '../src/v2/render/ribbon.js'
import { riverRaise, DrawnTerrain, RAISE_RUNGS, RAISE_MARGIN, RAISE_END, RUNG_AT_DEPTH } from '../src/v2/render/river-raise.js'
import { nodeKey } from '../src/v2/terrain/quadtree-v2.js'
import { Layers } from '../src/v2/layers/layers.js'
import { SAMPLE_SPACING, RIVER_WIDEN, RIVER_WIDEN_FRAC, drawnHalfWidth } from '../src/v2/layers/paths.js'
import { WaterSurfaces, lakeVertices } from '../src/v2/render/water-surfaces.js'
import { traceShore, ringArea, inRing, SHORE_BURY, SHORE_SPACING, WORLD_SKIRT } from '../src/v2/render/shoreline.js'
// The one thing this file imports from outside its own subject, and deliberately: a lake sheet that disagrees with the footprint it is drawn over is the failure that renders perfectly and is still wrong, so the two are checked against each other rather than against two copies of the same algebra.
import { footprint } from '../src/v2/layers/water-bodies.js'
import { WORLD_HALF } from '../src/v2/config.js'
import { terrainOf } from './lib/synthetic-terrain.mjs'

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

    // The turn is to the +normal side, so the INSIDE edge is halfRight. It must degenerate toward a point, not merely nudge: at the apex the half-width has to come down from 3.75 m to under the 0.6 m turning radius or the ribbon is still folded, whatever the triangle test says about this particular sampling.
    const full = HALF + Math.min(RIVER_WIDEN, HALF * RIVER_WIDEN_FRAC)
    let narrowest = Infinity
    for (const w of r.halfRight) narrowest = Math.min(narrowest, w)
    check(narrowest < R, 'the inside edge narrows below its own turning radius at the apex', `narrowest ${narrowest.toFixed(3)} m vs R ${R} m`)
    // ...and the straight approach must be untouched, or a miter limit is just a global narrowing.
    check(Math.abs(r.halfRight[0] - full) < 1e-4, 'the straight approach keeps its full width', `${r.halfRight[0].toFixed(3)} m`)
    // The OUTSIDE edge cannot fold and must not be touched, or the bend leaves a wedge of bare bed between the sheet and the outer bank -- the visible gap on every shipped bend before the cap went per-side.
    let outerMin = Infinity
    for (const w of r.halfLeft) outerMin = Math.min(outerMin, w)
    check(Math.abs(outerMin - full) < 1e-4, 'the outside edge keeps its full width through the hairpin', `narrowest outer ${outerMin.toFixed(3)} m vs ${full.toFixed(3)} m`)
    // And the inside vertices land on a tiny arc around the centre of curvature (0, R), not past it: past it is the fold the clamp exists to prevent.
    let farthest = 0
    for (let i = 10; i <= 22; i++) {
      const o = i * 6
      farthest = Math.max(farthest, Math.hypot(r.positions[o], r.positions[o + 2] - R))
    }
    check(farthest <= R, 'every inside vertex of the arc sits within the turning radius of its centre', `farthest ${farthest.toFixed(3)} m vs R ${R} m`)
  }

  // --- 2b. a corner tighter than the half-width, between two straights --------
  //
  // THE SHIPPED CASE. Every authored river corner is one of these: a 3 m half-width turning through 90 degrees on a 1.5 m radius. The cap alone leaves the channel between the centre of curvature and the inner bank bare, so the inside vertices of the corner must collapse onto the point where the two straights' inner offset lines meet -- (R - full, full) here -- and the sheet must then cover every wet point once: coverage is asserted by sampling, and so is single coverage, because a fan that overlapped its neighbours would double-blend a transparent water surface.
  {
    const HALF = 3
    const R = 1.5
    const full = HALF + Math.min(RIVER_WIDEN, HALF * RIVER_WIDEN_FRAC)
    const pts = []
    for (let x = -20; x < 0; x += 1) pts.push([x, 5, 0, HALF])
    for (let k = 0; k <= 6; k++) {
      const th = -Math.PI / 2 + (k * Math.PI) / 12
      pts.push([R * Math.cos(th), 5, R + R * Math.sin(th), HALF])
    }
    for (let z = R + 1; z <= R + 20; z += 1) pts.push([R, 5, z, HALF])
    const r = ribbonVertices(packed(pts), { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
    const P = r.positions
    const areas = triAreas(r)
    let inverted = 0
    let badZero = 0
    for (let t = 0; t < areas.length; t++) {
      if (areas[t] > 0) inverted++
      if (areas[t] === 0) {
        // Zero area is allowed only for the collapsed quad's spare triangle, whose two inside vertices coincide.
        const [a, b, c] = [0, 1, 2].map((k) => r.indices[t * 3 + k] * 3)
        const same = (u, v) => P[u] === P[v] && P[u + 2] === P[v + 2]
        if (!(same(a, b) || same(b, c) || same(a, c))) badZero++
      }
    }
    check(inverted === 0 && badZero === 0, 'a corner tighter than the half-width emits no inverted or accidental zero-area triangles', `${inverted} inverted, ${badZero} zero-area with distinct vertices`)
    check(r.collapsed > 0, 'the corner collapses its inside vertices', `${r.collapsed} collapsed`)
    let farFromM = 0
    for (let i = 0; i < pts.length; i++) {
      if (r.halfRight[i] > full + 1e-3) {
        if (Math.hypot(P[i * 6] - (R - full), P[i * 6 + 2] - full) > 1e-3) farFromM++
      }
    }
    check(farFromM === 0, 'every collapsed inside vertex sits on the meeting point of the two straights\' inner offset lines', `${farFromM} elsewhere`)
    let outerMin = Infinity
    for (const w of r.halfLeft) outerMin = Math.min(outerMin, w)
    check(Math.abs(outerMin - full) < 1e-4, 'the outside edge keeps its full width through the corner', `${outerMin.toFixed(3)} m`)

    // Coverage by sampling: every point within HALF of the centreline (a hair inside, so the sample is not on the bank itself) lies under exactly one triangle. The grid is offset by an irrational fraction so no sample lands on a triangle edge, where "inside" is a coin toss.
    const segDist = (x, z) => {
      let best = Infinity
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, , az] = pts[i]
        const [bx, , bz] = pts[i + 1]
        const ex = bx - ax
        const ez = bz - az
        const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)))
        best = Math.min(best, Math.hypot(x - ax - u * ex, z - az - u * ez))
      }
      return best
    }
    const inTri = (x, z, a, b, c) => {
      const d0 = cross2(P[b] - P[a], P[b + 2] - P[a + 2], x - P[a], z - P[a + 2])
      const d1 = cross2(P[c] - P[b], P[c + 2] - P[b + 2], x - P[b], z - P[b + 2])
      const d2 = cross2(P[a] - P[c], P[a + 2] - P[c + 2], x - P[c], z - P[c + 2])
      return (d0 < 0 && d1 < 0 && d2 < 0) || (d0 > 0 && d1 > 0 && d2 > 0)
    }
    let wet = 0
    let uncovered = 0
    let doubled = 0
    for (let x = -12 + Math.SQRT2 / 10; x < 6; x += 0.25) {
      for (let z = -5 + Math.SQRT2 / 10; z < 14; z += 0.25) {
        if (segDist(x, z) > HALF - 0.05) continue
        wet++
        let hits = 0
        for (let t = 0; t < areas.length; t++) {
          if (inTri(x, z, r.indices[t * 3] * 3, r.indices[t * 3 + 1] * 3, r.indices[t * 3 + 2] * 3)) hits++
        }
        if (hits === 0) uncovered++
        if (hits > 1) doubled++
      }
    }
    check(wet > 500 && uncovered === 0, 'the sheet covers every wet point of the channel through the corner', `${uncovered} of ${wet} bare`)
    check(doubled === 0, 'and covers none of them twice', `${doubled} of ${wet} under two triangles`)
  }

  // --- 3. the traced shoreline -------------------------------------------------
  //
  // A lake is the region of its footprint where the ground lies under its plane plus SHORE_BURY, traced by shoreline.js from the height field and ear-clipped by lakeVertices. Every way this fails is silent on screen: a ring a cell short of the bank shows lake bed through the water, an island filed under the wrong ring is drawn over, a mis-wound triangle is a lake seen only from underneath, and a rebuild that re-traces the ocean on every brush stroke is 180 ms nobody attributes. So the tracer runs over a closed-form bowl with an island in it, and everything is checked against that ground rather than against the tracer's own arithmetic.
  {
    const LEVEL = 120
    const PLANE = LEVEL + SHORE_BURY
    // A paraboloid bowl with a gaussian island off centre, both smooth enough that the fine grid's linear crossings land on the true contour.
    const ground = (x, z) => 100 + 0.004 * (x * x + z * z) + 30 * Math.exp(-((x - 30) ** 2 + z * z) / 225)
    const lake = { id: 'bowl', x: 0, z: 0, y: LEVEL, rx: 150, rz: 150, rot: 0, shape: 0, carve: 0, depth: 8 }
    const field = { reads: 0, heightAt(x, z) { this.reads++; return ground(x, z) } }
    const shore = traceShore(lake, field)
    check(shore.polygons.length === 1 && shore.slabs.length === 0, 'a bowl inside the world traces one water ring and no slabs', `${shore.polygons.length} rings, ${shore.slabs.length} slabs`)
    const [poly] = shore.polygons
    check(poly.area > 0 && poly.holes.length === 1 && ringArea(poly.holes[0]) < 0, 'wound with the water on the left: the ring positive, its one island negative', `${poly.holes.length} holes`)
    check(inRing(poly.outer, 30, 0) && inRing(poly.holes[0], 30, 0) && !inRing(poly.holes[0], -30, 0), 'the island is where the ground rises above the plane')
    check(shore.vertices === poly.outer.length / 2 + poly.holes[0].length / 2, 'and the vertex count is the rings\'')

    // Every vertex sits on the contour: SHORE_BURY under the bank, within what a 1 m simplification can move it on this slope.
    let worstOff = 0
    let longest = 0
    for (const ring of [poly.outer, poly.holes[0]]) {
      for (let i = 0, n = ring.length; i < n; i += 2) {
        worstOff = Math.max(worstOff, Math.abs(ground(ring[i], ring[i + 1]) - PLANE))
        longest = Math.max(longest, Math.hypot(ring[(i + 2) % n] - ring[i], ring[(i + 3) % n] - ring[i + 1]))
      }
    }
    check(worstOff < 2, `every ring vertex is ${SHORE_BURY} m under the bank`, `worst ${worstOff.toFixed(2)} m off the plane`)
    check(longest <= SHORE_SPACING + 1e-6, `no edge is longer than ${SHORE_SPACING} m`, `longest ${longest.toFixed(2)} m`)
    const circumference = 2 * Math.PI * Math.sqrt((PLANE - 100) / 0.004)
    check(poly.outer.length / 2 >= circumference / SHORE_SPACING && poly.outer.length / 2 <= circumference / 4, 'about one vertex per ten metres of shore', `${poly.outer.length / 2} vertices round ${circumference.toFixed(0)} m`)

    // Coverage against the ground itself, well clear of the tolerance band: a point under the plane is in the water ring and out of the island, a point over it is not.
    let missed = 0
    let flooded = 0
    for (let z = -150; z <= 150; z += 3) {
      for (let x = -150; x <= 150; x += 3) {
        if (footprint(lake, x, z) <= 0) continue
        const wet = inRing(poly.outer, x, z) && !inRing(poly.holes[0], x, z)
        const g = ground(x, z)
        if (g < PLANE - 2.5 && !wet) missed++
        if (g > PLANE + 2.5 && wet) flooded++
      }
    }
    check(missed === 0 && flooded === 0, 'the ring covers the water and nothing else', `${missed} wet points bare, ${flooded} dry points flooded`)

    // The sheet: every triangle faces +Y and together they weigh the ring less its island.
    const mesh = lakeVertices(shore, LEVEL)
    let wrongSign = 0
    let sheet = 0
    for (const twice of triAreas(mesh)) {
      if (twice >= 0) wrongSign++
      sheet -= twice
    }
    check(wrongSign === 0, 'every lake triangle faces up', `${wrongSign} of ${mesh.triangles} wound the other way`)
    check(Math.abs(sheet - (poly.area + ringArea(poly.holes[0]))) < 1e-6 * poly.area, 'and the sheet is exactly the ring less its island', `${(sheet / 2).toFixed(1)} vs ${((poly.area + ringArea(poly.holes[0])) / 2).toFixed(1)} m^2`)
    check(mesh.positions.every((v, i) => i % 3 !== 1 || v === LEVEL), 'at the lake\'s level')

    // The ocean: an unrotated rectangle past the world traces the skirt and fills the rest with slabs that meet it exactly, so the sheet is the whole box with no gap and no overlap.
    const sea = { id: 'sea', x: 0, z: 0, y: 100, rx: 10000, rz: 10000, rot: 0, shape: 1, carve: 0, depth: 8 }
    const deep = traceShore(sea, { heightAt: () => 0 })
    check(deep.polygons.length === 1 && deep.polygons[0].holes.length === 0 && deep.slabs.length === 4, 'an ocean over a drowned world is one ring and four slabs', `${deep.polygons.length} rings, ${deep.slabs.length} slabs`)
    {
      const ring = deep.polygons[0].outer
      let ext = 0
      for (let i = 0; i < ring.length; i += 2) ext = Math.max(ext, Math.abs(ring[i]), Math.abs(ring[i + 1]))
      check(ext > WORLD_HALF && ext <= WORLD_HALF + WORLD_SKIRT + 2, 'the ring runs a skirt past the world', `${ext.toFixed(1)} m`)
      let covered = deep.polygons[0].area / 2
      let flush = true
      for (const s of deep.slabs) {
        covered += (s.maxX - s.minX) * (s.maxZ - s.minZ)
        flush &&= [s.minX, s.maxX, s.minZ, s.maxZ].every((e) => Math.abs(e) === ext || Math.abs(e) === sea.rx)
      }
      check(flush && Math.abs(covered - 4 * sea.rx * sea.rx) < 1e-3, 'and the slabs meet it exactly, the sheet the whole authored box', `${covered.toExponential(4)} vs ${(4 * sea.rx * sea.rx).toExponential(4)} m^2`)
    }
    check(traceShore({ ...lake, y: 50 }, field).vertices === 0, 'a lake sunk wholly under its ground draws nothing')

    // A BAKED SHORE IS THE RECORD'S OWN, AND THE FIELD IS NOT CONSULTED AT ALL. v3's lakes come this way (§D.5 hydrology.js): the ring is the waterline the flood actually stood at, so re-contouring it here against v2's own field would move the bank off the water it was traced from and take the island with it. A square with a triangular island in it, whose two areas are exact, so the sheet's area is arithmetic and not the tracer's.
    {
      const outer = [-100, -100, 100, -100, 100, 100, -100, 100]
      const island = [20, -20, 20, 20, 60, 20, 60, -20]
      const baked = { ...lake, id: 'baked', ring: [outer, island] }
      const reads = field.reads
      const rs = traceShore(baked, field)
      check(field.reads === reads && rs.samples === 0, 'a baked shore reads no height at all', `${field.reads - reads} reads`)
      check(rs.polygons.length === 1 && rs.slabs.length === 0 && rs.polygons[0].outer === outer && rs.polygons[0].holes.length === 1 && rs.polygons[0].holes[0] === island, 'and is handed back vertex for vertex, islands as holes', `${rs.polygons.length} rings, ${rs.polygons[0].holes.length} holes`)
      check(rs.vertices === 8, 'the vertex count is the two rings\'', `${rs.vertices} vertices`)
      const baker = lakeVertices(rs, baked.y)
      let sheet = 0
      let up = true
      for (const twice of triAreas(baker)) {
        up &&= twice < 0
        sheet -= twice
      }
      let flat = true
      for (let i = 1; i < baker.positions.length; i += 3) flat &&= baker.positions[i] === baked.y
      check(up && flat && Math.abs(sheet / 2 - (200 * 200 - 40 * 40)) < 1e-6, 'and ear-clips to a flat sheet at the lake\'s level, the square less its island', `${(sheet / 2).toFixed(0)} vs ${200 * 200 - 40 * 40} m^2`)
      const threw = (fn) => {
        try {
          fn()
          return false
        } catch {
          return true
        }
      }
      check(threw(() => traceShore({ ...baked, ring: [island] }, field)), 'a ring wound with the water on the right throws')
      check(threw(() => traceShore({ ...baked, ring: [outer, [200, -20, 200, 20, 240, 20, 240, -20]] }, field)), 'and so does an island outside its ring')
    }

    // The cache: WaterSurfaces keeps a shore across rebuilds and re-traces only the lakes a rect touches or whose record changed.
    {
      const layers = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [lake], rivers: [], roads: [] })
      const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers, field })
      ws.rebuild()
      const first = ws.meshes.get('bowl').userData.shore
      const reads = field.reads
      ws.rebuild({ minX: 1000, minZ: 1000, maxX: 1100, maxZ: 1100 })
      check(ws.meshes.get('bowl').userData.shore === first && field.reads === reads, 'a rebuild over a rect clear of the lake keeps its shore without reading the field')
      ws.rebuild({ minX: 100, minZ: 100, maxX: 200, maxZ: 200 })
      check(ws.meshes.get('bowl').userData.shore !== first && field.reads > reads, 'a rect touching the lake\'s box re-traces it')
      const second = ws.meshes.get('bowl').userData.shore
      layers.lakes.update('bowl', { y: LEVEL + 1 })
      ws.rebuild({ minX: 1000, minZ: 1000, maxX: 1100, maxZ: 1100 })
      check(ws.meshes.get('bowl').userData.shore !== second, 'and so does a change to the record, whatever the rect')
      check(ws.meshes.get('bowl').geometry.getAttribute('position').count === ws.meshes.get('bowl').userData.shore.vertices, 'the mesh carries one position per traced vertex')
      // A RING IS NOT IN THE CACHE KEY, so a lake whose shore is re-baked with every scalar unchanged has to be caught by the identity of the contours themselves. Uncaught, a v3 lake reshaped by a regenerate keeps the sheet of the one before it.
      const square = [-60, -60, 60, -60, 60, 60, -60, 60]
      layers.lakes.add({ id: 'baked', x: 0, z: 0, y: LEVEL, rx: 60, rz: 60, rot: 0, shape: 0, carve: 0, depth: 8, ring: [square] })
      ws.rebuild()
      const third = ws.meshes.get('baked').userData.shore
      layers.lakes.update('baked', { ring: [[-50, -50, 50, -50, 50, 50, -50, 50]] })
      ws.rebuild({ minX: 1000, minZ: 1000, maxX: 1100, maxZ: 1100 })
      check(ws.meshes.get('baked').userData.shore !== third && ws.meshes.get('baked').userData.shore.polygons[0].area / 2 === 100 * 100, 'a re-baked ring re-traces the lake though every scalar on the record holds', `${(ws.meshes.get('baked').userData.shore.polygons[0].area / 2).toFixed(0)} m^2`)
      ws.dispose()
    }
  }

  // --- 4. arc length ---------------------------------------------------------
  //
  // `u` is metres along the path in 3D, not a 0..1 parameter: normalised UVs over a 3 km river mean a texture repeat of 3000 that has to be re-authored the moment a control point moves. So it has to be monotone, it has to be in metres, and it has to be the length of the thing it is measuring.
  {
    const R = 100
    const CLIMB = 30
    const STEPS = 80
    const pts = []
    for (let k = 0; k <= STEPS; k++) {
      const th = (k / STEPS) * (Math.PI / 2)
      pts.push([R * Math.cos(th), (k / STEPS) * CLIMB, R * Math.sin(th), 6])
    }
    const r = ribbonVertices(packed(pts))

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

    // The offset is XZ-only, so every vertex carries its sample's y verbatim.
    let level = true
    for (let i = 0; i < r.count; i++) if (Math.abs(r.positions[i * 6 + 1] - pts[i][1]) > 1e-4 || Math.abs(r.positions[i * 6 + 4] - pts[i][1]) > 1e-4) level = false
    check(level, 'both vertices of a sample sit at the sample y')

    const areas = triAreas(r)
    let wrongSign = 0
    for (const a of areas) if (a >= 0) wrongSign++
    check(wrongSign === 0, 'a climbing, curving ribbon still winds consistently', `${wrongSign} of ${areas.length}`)
  }

  // --- 5. the drawn surface against the carved ground ------------------------
  //
  // Sections 1 to 4 check the ribbon against itself. This one checks it against the terrain it has to sit on, which is the only place the two halves of the feature can disagree, and it does it in RELATIONSHIPS rather than in elevations: the world's vertical range is still being surveyed out of the reference jpg, so every number here is a difference between two heights the document itself supplies. An absolute metre literal in this section would be a check with a shelf life.
  //
  // The river is solved against a synthetic hillside, so the ground handed to carve() under it is that hillside. A road is not here: it draws nothing, and check-v2-layers asserts the smooth puts the terrain on its spline.
  {
    const DEPTH = 2
    const HALF = 6
    // Falling 1 m in 60 along +x: about 16 m over the river's run, so the level solve has a real slope to follow.
    const ground = (x) => 60 - x / 60
    const doc = {
      v: 1,
      snow: { base: 100, band: 40, points: [] },
      lakes: [],
      rivers: [{ id: 'r', depth: DEPTH, pts: [[-400, -200, 2 * HALF], [-100, -60], [220, 90], [560, 300, 2 * HALF]] }],
      roads: [],
    }
    const layers = new Layers(doc)
    layers.paths.setTerrain(terrainOf(ground))
    void layers.paths.segmentCount

    const river = layers.paths.paths.get('r')
    const rr = ribbonVertices(river.samples, { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })

    // The stated river depth is 2 m at the middle, and it is the ribbon that has to be 2 m above the bed -- not the solved level, which nobody sees. Measured at every sample's centreline, where the carve is the full depth.
    let worstDepth = 0
    for (let i = 0; i < rr.count; i++) {
      const x = river.samples[i * 4]
      const y = river.samples[i * 4 + 1]
      const z = river.samples[i * 4 + 2]
      // Both ribbon vertices of this sample carry the solved level verbatim; the river gets no lift.
      const surface = rr.positions[i * 6 + 1]
      if (Math.abs(surface - y) > 1e-4) worstDepth = Infinity
      worstDepth = Math.max(worstDepth, Math.abs(surface - layers.carve(x, z, ground(x, z)) - DEPTH))
    }
    check(worstDepth < 1e-3, `the river surface sits ${DEPTH} m above its own carved bed`, `worst error ${worstDepth.toExponential(1)} m`)

    // The widened edge exists to be buried. The carve returns the ground to the water level at halfWidth and climbs the bank from there, so the ground at the ribbon's outer edge must be ABOVE the water plane -- otherwise the overhang is drawn over open air and the shoreline is the polygon edge after all.
    let exposed = 0
    for (let i = 0; i < rr.count; i++) {
      const surface = rr.positions[i * 6 + 1]
      for (const v of [0, 1]) {
        const ex = rr.positions[i * 6 + v * 3]
        const ez = rr.positions[i * 6 + v * 3 + 2]
        if (layers.carve(ex, ez, ground(ex, ez)) < surface) exposed++
      }
    }
    check(exposed === 0, 'the widened river edge is under ground, not over air', `${exposed} of ${rr.vertices} edge vertices exposed`)

    // levelAt is the submersion test, and it has to answer the surface DRAWN over the point, which on a grade is the nearest quad's level and not the highest level of every segment whose half-width reaches the point: a segment's reach runs a half-width past its own ends, so the highest is up to that far upstream, and on this 1:5 rapid that is 1.4 m of water over her head while she stands on the bank. Measured at every sample and across the wet width, where the nearest segment's y is the sample's own.
    {
      const STEEP = 5
      const rapid = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [], roads: [], rivers: [{ id: 'r', depth: DEPTH, pts: [[-200, 0, 2 * HALF], [200, 0, 2 * HALF]] }] })
      rapid.paths.setTerrain(terrainOf((x) => 100 - x / STEEP))
      const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers: rapid, field: { heightAt: (x) => 100 - x / STEEP } })
      ws.rebuild()
      const s = rapid.paths.paths.get('r').samples
      let worst = 0
      for (let i = 0; i < s.length / 4; i++) {
        for (const f of [-0.9, 0, 0.9]) {
          const level = ws.levelAt(s[i * 4], s[i * 4 + 2] + f * s[i * 4 + 3], true)
          worst = Math.max(worst, level === null ? Infinity : Math.abs(level - s[i * 4 + 1]))
        }
      }
      check(worst < 1e-3, `levelAt on a 1:${STEEP} rapid is the level drawn over the point, not the one a half-width upstream`, `worst ${worst.toExponential(1)} m off the sample's own level`)
    }
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
    const deep = { heightAt: () => 0 }
    check(threw(() => traceShore({ id: 'x', x: 0, z: 0, y: 0, rx: 40, rz: 40, rot: 0, shape: 2 }, deep)), 'an unknown lake shape throws')
    check(threw(() => traceShore({ id: 'x', x: 0, z: 0, y: 0, rx: 0, rz: 0, rot: 0, shape: 0 }, deep)), 'a zero-extent lake throws')
    check(threw(() => traceShore({ id: 'x', x: 0, z: 0, y: 0, rx: 40, rz: 40, rot: 0, shape: 0 }, {})), 'a field without heightAt throws')
    check(threw(() => traceShore({ id: 'x', x: 0, z: 0, y: 0, rx: 10000, rz: 10000, rot: 0.1, shape: 1 }, deep)) && threw(() => traceShore({ id: 'x', x: 0, z: 0, y: 0, rx: 10000, rz: 10000, rot: 0, shape: 0 }, deep)), 'a lake past the world throws unless it is an unrotated rectangle')
    check(threw(() => new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers: new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [], rivers: [], roads: [] }) })), 'WaterSurfaces without a field throws')
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
      rivers: [{ id: 'r', depth: 2, pts: [[-200, -300, WIDTH], [-60, -300], [60, -300], [200, -300, WIDTH]] }],
      roads: [],
    }
    const layers = new Layers(doc)
    layers.paths.setTerrain(terrainOf(() => 12))
    const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers, field: { heightAt: () => 12 } })
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

    // The current the boats drift on (flowAt): the river's downstream direction at full weight in its run, fading over the same reach the shader's frame does at either end, and nothing off the river or on a lake. Level ground puts the source at the first authored point, so the flow runs +x.
    const f = { x: 0, z: 0 }
    const flowAt = (x, z) => ws.flowAt(x, z, f)
    check(flowAt(0, -300) === 1 && near(f.x, 1) && near(f.z, 0), 'on the river the current runs downstream at full weight', `${flowAt(0, -300)} along (${f.x.toFixed(3)}, ${f.z.toFixed(3)})`)
    check(flowAt(0, -295) === 1 && near(f.x, 1) && near(f.z, 0) && flowAt(0, -291) === 0, 'across its authored width, and not past it', `${flowAt(0, -295)} at 5 m, ${flowAt(0, -291)} at 9 m`)
    check(flowAt(0, 0) === 0 && flowAt(150, 150) === 0, 'and none on a lake or on dry ground')
    const fadeM = Math.max(FLOW_FADE_HALF_WIDTHS * HW, FLOW_FADE_MIN)
    check(near(flowAt(-200 + fadeM / 2, -300), 0.5) && near(flowAt(200 - fadeM / 2, -300), 0.5) && flowAt(-200 + fadeM + 1, -300) === 1,
      'fading in from the source and out to the mouth over the frame\'s reach', `${flowAt(-200 + fadeM / 2, -300).toFixed(3)} and ${flowAt(200 - fadeM / 2, -300).toFixed(3)} at half of ${fadeM} m`)

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
      field: { heightAt: () => 0 },
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

  // --- 9. the river flow frame -----------------------------------------------
  //
  // The waves on a river drift downstream because every ribbon vertex carries `aFlow` (ribbon.js flowFrame): metres along from the source, signed metres across, a weight, and the downstream angle. Every one of those fails silently -- a river whose waves run uphill, or drift sideways, or stop dead where it enters a lake -- so each is pinned on a straight river where the answer is plain, in both stored orders, and then the fade against the lake the river ends in is measured against PathSet.flowReach.
  {
    const HALF = 4
    const W = HALF + Math.min(RIVER_WIDEN, HALF * RIVER_WIDEN_FRAC)
    const FADE = Math.max(FLOW_FADE_HALF_WIDTHS * W, FLOW_FADE_MIN)
    // Falling along +x, so +x is downstream whichever way the points are stored.
    const ground = (x) => 60 - x / 60
    const build = (pts, lakes = []) => {
      const layers = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes, rivers: [{ id: 'r', depth: 2, pts }], roads: [] })
      layers.paths.setTerrain(terrainOf(ground))
      const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers, field: { heightAt: ground } })
      ws.rebuild()
      const mesh = ws.meshes.get('r')
      return { layers, ws, mesh, flow: mesh.geometry.getAttribute('aFlow'), n: mesh.userData.lod.count }
    }
    const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol

    const fwd = build([[-200, 0, 2 * HALF], [-60, 0], [60, 0], [200, 0, 2 * HALF]])
    check(fwd.layers.paths.flowsForward('r') === true, 'the river stored source first flows forward')
    check(fwd.flow !== undefined && fwd.flow.itemSize === 4 && fwd.flow.count === fwd.mesh.geometry.getAttribute('position').count, 'every river vertex carries a vec4 aFlow', fwd.flow ? `${fwd.flow.count} x ${fwd.flow.itemSize}` : 'no attribute')
    {
      const f = fwd.flow.array
      const p = fwd.mesh.geometry.getAttribute('position').array
      const n = fwd.n
      const length = f[(n - 1) * 8]
      let uMono = true
      let uArc = 0
      let vSign = 0
      let angle = 0
      let midWeight = 1
      for (let i = 0; i < n; i++) {
        const o = i * 8
        if (i > 0 && f[o] <= f[o - 8]) uMono = false
        // u is arc from the source: on a straight river, plan distance from the first sample plus the few centimetres its 1:60 fall adds.
        uArc = Math.max(uArc, Math.abs(f[o] - (p[i * 6] - p[0])))
        // Vertex a sits at +z of a +x tangent, which is the RIGHT bank looking downstream: v positive there, negative across.
        if (!(near(f[o + 1], W) && near(f[o + 5], -W) && p[i * 6 + 2] > p[i * 6 + 5])) vSign++
        angle = Math.max(angle, Math.abs(f[o + 3]), Math.abs(f[o + 7]))
        if (f[o] > FADE && f[o] < length - FADE) midWeight = Math.min(midWeight, f[o + 2], f[o + 6])
      }
      check(uMono && uArc < 0.1, 'u runs from the source as arc metres', `worst ${uArc.toExponential(1)} m off plan distance`)
      check(vSign === 0, 'v is the widened half-width, positive on the right bank looking downstream', `${vSign} samples off`)
      check(angle < 1e-6, 'the downstream angle on a river flowing +x is 0', `${angle.toExponential(1)} rad`)
      check(near(f[2], 0) && near(f[(n - 1) * 8 + 2], 0), 'a free end starts at weight 0', `${f[2]}, ${f[(n - 1) * 8 + 2]}`)
      check(midWeight === 1, `and is at weight 1 once ${FADE.toFixed(1)} m in from both ends`, `${midWeight}`)
      const reach = fwd.layers.paths.flowReach('r')
      check(reach.source === 0 && reach.mouth === 0, 'a river touching no other water reports no reach at either end', JSON.stringify(reach))
    }

    // The same river stored mouth first. Downstream is still +x, so u, v and the angle must come out identical per WORLD position -- the frame follows the water, not the array.
    const rev = build([[200, 0, 2 * HALF], [60, 0], [-60, 0], [-200, 0, 2 * HALF]])
    check(rev.layers.paths.flowsForward('r') === false, 'the river stored mouth first flows backward')
    {
      const f = rev.flow.array
      const p = rev.mesh.geometry.getAttribute('position').array
      const n = rev.n
      let uArc = 0
      let vSign = 0
      let angle = 0
      const x0 = p[(n - 1) * 6]
      for (let i = 0; i < n; i++) {
        const o = i * 8
        uArc = Math.max(uArc, Math.abs(f[o] - (p[i * 6] - x0)))
        // Sample order runs -x here, so vertex a is at -z: the LEFT bank looking downstream, and v must say so.
        if (!(near(f[o + 1], -W) && near(f[o + 5], W) && p[i * 6 + 2] < p[i * 6 + 5])) vSign++
        angle = Math.max(angle, Math.abs(f[o + 3]), Math.abs(f[o + 7]))
      }
      check(uArc < 0.1, 'stored backward, u still counts from the source', `worst ${uArc.toExponential(1)} m off plan distance`)
      check(vSign === 0, 'and v still reads positive on the right bank looking downstream', `${vSign} samples off`)
      check(angle < 1e-6, 'and the angle still points +x', `${angle.toExponential(1)} rad`)
    }

    // Ending in a lake. Its footprint reaches 60 m back up the river, and the frame must hold the world drift over all of it and only come up to the river's own over the fade beyond, so the waves crossing the lake's edge are the lake's.
    const R = 60
    const lakeDoc = [{ id: 'l', x: 300, z: 0, y: ground(300) - 1, rx: R, rz: R, rot: 0, shape: 0, carve: 1, depth: 4 }]
    const into = build([[-200, 0, 2 * HALF], [-60, 0], [120, 0], [300, 0, 2 * HALF]], lakeDoc)
    {
      const reach = into.layers.paths.flowReach('r')
      check(reach.source === 0 && Math.abs(reach.mouth - R) <= 2 * SAMPLE_SPACING, `a river ending at a lake's centre reports the lake's radius as its mouth reach`, `mouth ${reach.mouth.toFixed(1)} m vs ${R} m`)
      const f = into.flow.array
      const p = into.mesh.geometry.getAttribute('position').array
      const n = into.n
      let inLake = 0
      let inLakeBad = 0
      let clear = 0
      let clearBad = 0
      for (let i = 0; i < n; i++) {
        const x = p[i * 6]
        const w = f[i * 8 + 2]
        if (x > 300 - R + SAMPLE_SPACING) {
          inLake++
          if (w !== 0) inLakeBad++
        } else if (x < 300 - R - FADE - SAMPLE_SPACING && x > -200 + FADE + SAMPLE_SPACING) {
          clear++
          if (w !== 1) clearBad++
        }
      }
      check(inLake > 10 && inLakeBad === 0, 'inside the lake footprint the river takes the world frame', `${inLakeBad} of ${inLake} vertices weighted`)
      check(clear > 10 && clearBad === 0, 'and its own frame once it is a fade clear of the lake', `${clearBad} of ${clear} vertices short of 1`)
    }

    // A lake sheet carries no aFlow at all: it takes the material's default, which is the world frame. Asserted here because a sheet that grew the attribute by accident would drift the lake with whatever zeros or garbage it was given.
    check(into.ws.meshes.get('l').geometry.getAttribute('aFlow') === undefined, 'a lake sheet carries no aFlow and takes the default')
    fwd.ws.dispose()
    rev.ws.dispose()
    into.ws.dispose()
  }

  // --- 9b. a tributary's sheet ends on its trunk's ------------------------------
  //
  // The water material writes depth, so a tributary drawn on into its trunk's plane is two sheets one depth test apart, sorted per pixel. PathSet dives the tributary's level under the trunk's once its whole drawn width is inside the trunk's drawn width and ends the drawn samples where the sheets cross (drawnSamples); the mesh has to be built from those samples and nothing else, while the wet index -- levelAt, and the carve under it -- keeps the full run, so the water past the cut is still water. Pinned through WaterSurfaces on the same square-on confluence check-v2-layers pins the samples on.
  {
    const ground = (x) => 100 - 0.001 * x - 5 * Math.exp(-(((x + 200) / 60) ** 2))
    const layers = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [], roads: [], rivers: [
      { id: 'trunk', depth: 3, pts: [[-500, 0, 40], [500, 0, 40]] },
      { id: 'trib', depth: 2, pts: [[0, 400, 10], [0, 0, 10]] },
    ] })
    layers.paths.setTerrain(terrainOf(ground))
    const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers, field: { heightAt: ground } })
    ws.rebuild()
    const drawn = layers.paths.drawnSamples('trib')
    const full = layers.paths.paths.get('trib').samples
    const mesh = ws.meshes.get('trib')
    const p = mesh.geometry.getAttribute('position')
    const n = mesh.userData.lod.count
    const trunkLevel = layers.paths.riverLevelAt(0, 0)
    check(drawn.length < full.length && n === drawn.length / 4 && p.count === 2 * n, 'the tributary mesh is built from the drawn samples, which stop short of the mouth', `${n} samples drawn of ${full.length / 4}, ${p.count} vertices`)
    // Every vertex over the trunk's water is at its surface or above it: none is left under the trunk's sheet for the depth test to sort.
    const wet = drawnHalfWidth(20)
    let over = 0
    let under = 0
    let lowest = Infinity
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i)
      if (Math.abs(z) > wet) continue
      over++
      const y = p.getY(i)
      if (y < lowest) lowest = y
      if (y < trunkLevel - 1e-3) under++
    }
    check(over > 0 && under === 0 && lowest < trunkLevel + 1e-3, "and every tributary vertex over the trunk's drawn width is on its surface or above it", `${over} vertices over the trunk, lowest ${lowest.toFixed(3)} vs ${trunkLevel.toFixed(3)} m, ${under} under`)
    const lastZ = p.getZ((n - 1) * 2)
    check(lastZ > 0 && lastZ < wet, 'with the last pair at the crossing, inside the trunk', `z = ${lastZ.toFixed(2)} of ${wet.toFixed(2)}`)
    const l10 = ws.levelAt(0, 10)
    const l30 = ws.levelAt(0, 30)
    check(l10 !== null && Math.abs(l10 - trunkLevel) < 1e-3 && l30 !== null && l30 > trunkLevel + 1, "while the wet index still answers water at the mouth, at the trunk's level, and the tributary's own further up", `${l10} at z = 10, ${l30} at z = 30`)
    ws.dispose()
  }

  // --- 10. the river distance ladder and the lift -----------------------------
  //
  // A river is drawn at every sample inside LOD_FINE and at one sample per LOD_SPACING beyond (ribbonLod, lodIndices), and every vertex is lifted in the vertex stage by the lift built for the terrain rung drawn under it (riverRaise, WaterSurfaces.updateLod). Each piece fails silently in its own way: a coarse quad that skips the samples a bend needed folds into a dark smear; a lift short of the drawn envelope buries the river from a hillside; a lift read from the wrong rung floats it; a ladder read per frame is the cost the ladder was built to avoid. The counts are pinned on a straight, the repair and the coverage on a river with real bends, the lift against the replica on that river and against a flat plane in closed form, and the update through WaterSurfaces against a stub terrain whose drawn rung is a known function of place.
  {
    check(LOD_FINE === 100 && LOD_SPACING === 10, 'fine inside 100 m, coarse at 10 m beyond', `${LOD_FINE} ${LOD_SPACING}`)

    // The coarse strip's triangles, split three ways: inverted, zero-area on coincident vertices (a collapsed corner, allowed), and zero-area on distinct ones (a folded quad, not allowed).
    const audit = (r, lod) => {
      lod.states.fill(LOD_STATE_COARSE)
      const idx = new Uint32Array(lod.capacity)
      const count = lodIndices(lod, idx)
      const P = r.positions
      let inverted = 0
      let badZero = 0
      for (let t = 0; t < count; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => idx[t + k] * 3)
        const cr = cross2(P[b] - P[a], P[b + 2] - P[a + 2], P[c] - P[a], P[c + 2] - P[a + 2])
        if (cr > 0) inverted++
        const same = (u, v) => P[u] === P[v] && P[u + 2] === P[v + 2]
        if (cr === 0 && !(same(a, b) || same(b, c) || same(a, c))) badZero++
      }
      return { idx, count, inverted, badZero }
    }
    const R = RAISE_RUNGS.length

    // A straight at 2 m samples: coarse every fifth sample, chunks every LOD_CHUNK sharing their cut, no vertices of its own. Its lift over a flat plane is closed form: nothing where the plane is under the level, the plane's excess plus the rung's margin where it is over, ramped from zero over RAISE_END of arc at each end.
    {
      const N = 251
      const pts = []
      for (let i = 0; i < N; i++) pts.push([i * SAMPLE_SPACING, 20, 0, 4])
      const r = ribbonVertices(packed(pts), { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
      const lod = ribbonLod(r)
      const m = lod.coarse.length
      let gapOff = 0
      for (let k = 1; k < m; k++) if (Math.abs(r.arc[lod.coarse[k]] - r.arc[lod.coarse[k - 1]] - LOD_SPACING) > 1e-6) gapOff++
      check(lod.coarse[0] === 0 && lod.coarse[m - 1] === N - 1 && m === Math.round(r.length / LOD_SPACING) + 1 && gapOff === 0, `a straight picks both ends and one sample per ${LOD_SPACING} m between`, `${m} coarse of ${N}, ${gapOff} gaps off`)
      const L = lod.chunks.length
      let shared = true
      let span = 0
      for (let c = 0; c < L; c++) {
        const { c0, c1 } = lod.chunks[c]
        if (c > 0 && lod.chunks[c - 1].c1 !== c0) shared = false
        if (c < L - 1) span = Math.max(span, Math.abs(r.arc[lod.coarse[c1]] - r.arc[lod.coarse[c0]] - LOD_CHUNK))
      }
      check(L === Math.round(r.length / LOD_CHUNK) && lod.chunks[0].c0 === 0 && lod.chunks[L - 1].c1 === m - 1 && shared, `chunks tile the river end to end, each sharing its cut sample with the next`, `${L} chunks`)
      check(span < 1e-6, `and each is ${LOD_CHUNK} m of arc`, `worst ${span.toExponential(1)} m off`)
      check(lod.positions === undefined && lod.count === r.count, 'the ladder adds no vertices of its own: it is an index recipe over the fine strip')
      const a = audit(r, lod)
      check(lod.capacity === (N - 1) * 6 && a.count === (m - 1) * 6 && a.count <= lod.capacity, 'the index buffer holds the all-fine strip and the coarse strip fits inside it', `${a.count} of ${lod.capacity}`)
      check(a.inverted === 0 && a.badZero === 0, 'the coarse strip of a straight is clean', `${a.inverted} inverted, ${a.badZero} folded`)

      const bare = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [], rivers: [], roads: [] })
      const under = riverRaise(r, lod, terrainOf(() => 12).coarse(), bare, false)
      const over = riverRaise(r, lod, terrainOf(() => 22).coarse(), bare, true)
      let underOff = 0
      let overOff = 0
      let ramped = 0
      for (let v = 0; v < r.count * 2; v++) {
        const ramp = Math.min(1, r.arc[v >> 1] / RAISE_END, (r.arc[r.count - 1] - r.arc[v >> 1]) / RAISE_END)
        if (ramp < 1) ramped++
        for (let k = 0; k < R; k++) {
          if (under[v * R + k] !== 0) underOff++
          if (Math.abs(over[v * R + k] - (2 + RAISE_MARGIN[k]) * ramp) > 1e-5) overOff++
        }
      }
      check(under.length === r.count * 2 * R && underOff === 0, `${R} lifts per vertex, all zero over a plane 8 m under the level`, `${underOff} off`)
      check(overOff === 0 && ramped === 4 * Math.ceil(RAISE_END / SAMPLE_SPACING), `and each the plane's 2 m excess plus its rung's margin over a plane 2 m above it, ramped from nothing over ${RAISE_END} m at either end`, `${overOff} off, ${ramped} ramped`)
      const ends = [0, (r.count - 1) * 2 * R]
      check(ends.every((at) => over.subarray(at, at + 2 * R).every((v) => v === 0)) && over[1 * 2 * R] > 0, 'both end samples carry exactly no lift at any rung on either bank, and the next sample already some', `${over[0]} ${over[ends[1]]} ${over[2 * R]}`)
    }

    // A river with real bends, solved over terrain the way a shipped one is. The repair is what keeps this strip from folding, so it is measured here where the turn rule alone would fold it; the pick must also have spent extra samples on the bends, and the strip must still cover the channel a metre in from each bank, which is what the chord across a LOD_TURN bend costs at most.
    const ground = (x, z) => 60 - x / 60 + Math.sin(z / 90) * 8
    const bendy = [[-400, -200, 12], [-250, 40], [-100, -60], [40, 120], [220, 90], [380, 260], [560, 300, 12]]
    const layers = new Layers({ v: 1, snow: { base: 100, band: 40, points: [] }, lakes: [{ id: 'pond', x: 0, z: -3000, y: 56, rx: 40, rz: 40, rot: 0, shape: 1, carve: 0, depth: 8 }], roads: [], rivers: [{ id: 'r', depth: 2, pts: bendy }, { id: 'far', depth: 2, pts: [[-400, 3000, 12], [400, 3000, 12]] }] })
    layers.paths.setTerrain(terrainOf(ground))
    const ws = new WaterSurfaces({ water: { material: new THREE.MeshBasicMaterial(), group: new THREE.Group() }, layers, field: { heightAt: ground } })
    ws.rebuild()
    {
      const s = ws.riverSamples.get('r')
      const r = ribbonVertices(s, { widen: RIVER_WIDEN, widenFrac: RIVER_WIDEN_FRAC })
      const lod = ribbonLod(r)
      // The pick rule, read back: no fine sample strictly between two coarse ones has turned LOD_TURN or run LOD_SPACING since the earlier of them, and some coarse pairs end on the turn rather than the spacing.
      const turned = (i, j) => Math.abs(Math.atan2(cross2(r.tangents[i * 2], r.tangents[i * 2 + 1], r.tangents[j * 2], r.tangents[j * 2 + 1]), r.tangents[i * 2] * r.tangents[j * 2] + r.tangents[i * 2 + 1] * r.tangents[j * 2 + 1]))
      let late = 0
      let byTurn = 0
      for (let k = 1; k < lod.coarse.length; k++) {
        const i = lod.coarse[k - 1], j = lod.coarse[k]
        for (let q = i + 1; q < j; q++) if (turned(i, q) >= LOD_TURN || r.arc[q] - r.arc[i] >= LOD_SPACING) late++
        if (turned(i, j) >= LOD_TURN && r.arc[j] - r.arc[i] < LOD_SPACING) byTurn++
      }
      check(late === 0 && byTurn > 0, `a coarse sample lands wherever the heading has turned ${((LOD_TURN * 180) / Math.PI).toFixed(0)} degrees or the arc has run ${LOD_SPACING} m, whichever first`, `${late} picked late, ${byTurn} of ${lod.coarse.length - 1} gaps closed by the turn`)
      const a = audit(r, lod)
      check(a.inverted === 0 && a.badZero === 0, 'the coarse strip through the bends has no inverted or folded triangle', `${a.inverted} inverted, ${a.badZero} folded, ${a.count / 3} triangles`)
      check(a.count < r.triangles * 3 / 4, 'and is a fraction of the fine strip', `${a.count / 3} vs ${r.triangles}`)
      const P = r.positions
      const inTri = (x, z, a, b, c) => {
        const d0 = cross2(P[b] - P[a], P[b + 2] - P[a + 2], x - P[a], z - P[a + 2])
        const d1 = cross2(P[c] - P[b], P[c + 2] - P[b + 2], x - P[b], z - P[b + 2])
        const d2 = cross2(P[a] - P[c], P[a + 2] - P[c + 2], x - P[c], z - P[c + 2])
        return (d0 <= 0 && d1 <= 0 && d2 <= 0) || (d0 >= 0 && d1 >= 0 && d2 >= 0)
      }
      let wet = 0
      let bare = 0
      for (let i = 0; i + 1 < r.count; i++) {
        const x0 = s[i * 4], z0 = s[i * 4 + 2], x1 = s[i * 4 + 4], z1 = s[i * 4 + 6]
        const hw = Math.min(s[i * 4 + 3], s[i * 4 + 7])
        const len = Math.hypot(x1 - x0, z1 - z0)
        const nx = -(z1 - z0) / len, nz = (x1 - x0) / len
        for (let v = -(hw - 1); v <= hw - 1; v += 0.5) {
          const px = (x0 + x1) / 2 + nx * v + Math.SQRT2 / 100
          const pz = (z0 + z1) / 2 + nz * v + Math.SQRT2 / 100
          wet++
          let hit = false
          for (let t = 0; t < a.count && !hit; t += 3) hit = inTri(px, pz, a.idx[t] * 3, a.idx[t + 1] * 3, a.idx[t + 2] * 3)
          if (!hit) bare++
        }
      }
      check(wet > 2000 && bare === 0, 'the coarse strip covers the channel a metre in from either bank all the way down', `${bare} of ${wet} bare`)

      // The lift on this river, built for both settings of the peaks knob: the replica is the mesher's own recipe (the point sample, or the footprint max over peaksStencil, and the shorter diagonal), checked at one vertex against the taps written out; then at every rung the lifted edge, interpolated bank to bank, clears the replica by the margin at the solved stations across every fine sample, and a coarse sample carries at least what every fine sample it spans does.
      const { ground: hm, peaks: shippedPeaks } = layers.paths.drawnGround()
      const carve = (x, z, h) => layers.carve(x, z, h, 64)
      {
        const gi = 66, gj = 63
        const x = -WORLD_HALF + gi * 64, z = -WORLD_HALF + gj * 64
        let top = -Infinity
        for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) top = Math.max(top, carve(x - 32 + c * 32, z - 32 + b * 32, hm.sample(x - 32 + c * 32, z - 32 + b * 32)))
        const on = new DrawnTerrain(hm, 64, carve, true), off = new DrawnTerrain(hm, 64, carve, false)
        check(on.vertex(gi, gj) === top && on.at(x, z) === top && off.vertex(gi, gj) === carve(x, z, hm.sample(x, z)) && off.vertex(gi, gj) < top, 'a 64 m vertex over a 32 m texel is the max of the 3 x 3 taps at 32 m pitch through the carve with peaks up, the carved point sample with it down', `${on.vertex(gi, gj).toFixed(3)} vs ${top.toFixed(3)}, ${off.vertex(gi, gj).toFixed(3)} sampled`)
      }
      let threwPeaks = false
      try { riverRaise(r, lod, hm, layers) } catch { threwPeaks = true }
      check(threwPeaks, 'riverRaise without the peaks knob throws')
      for (const peaks of [true, false]) {
        const raise = riverRaise(r, lod, hm, layers, peaks)
        // The solve holds the margin at its five taps; between taps the replica's triangles can bow into the margin, which is what the margin is for, so there the edge only has to stay above the replica. Coarse samples are skipped: they carry their span's max, not their own need. So is RAISE_END of arc at each end, where the lift is ramped away on purpose.
        let short = 0
        let buried = 0
        let tested = 0
        const isCoarse = new Uint8Array(r.count)
        for (const i of lod.coarse) isCoarse[i] = 1
        const ramped = (i) => r.arc[i] < RAISE_END || r.length - r.arc[i] < RAISE_END
        for (let k = 0; k < R; k++) {
          const step = RAISE_RUNGS[k]
          const drawn = new DrawnTerrain(hm, step, (x, z, h) => layers.carve(x, z, h, step), peaks)
          for (let i = 0; i < r.count; i++) {
            if (isCoarse[i] || ramped(i)) continue
            const o = i * 6
            const lr = raise[(i * 2) * R + k], ll = raise[(i * 2 + 1) * R + k]
            for (let q = 0; q <= 8; q++) {
              const t = q / 8
              const x = P[o] + (P[o + 3] - P[o]) * t, z = P[o + 2] + (P[o + 5] - P[o + 2]) * t
              const gap = drawn.at(x, z) - (P[o + 1] + lr + (ll - lr) * t)
              tested++
              if (gap > 1e-4) buried++
              if (q % 2 === 0 && gap + RAISE_MARGIN[k] > 1e-4) short++
            }
          }
        }
        check(tested > 50000 && short === 0 && buried === 0, `peaks ${peaks ? 'up' : 'down'}: at every rung the lifted edge holds the margin over the replica at the five solved stations and stays above it between them, across every fine sample`, `${short} short of the margin, ${buried} buried, of ${tested}`)
        let lifted = 0
        let coarseShort = 0
        for (let c = 0; c + 1 < lod.coarse.length; c++) {
          if (ramped(lod.coarse[c]) || ramped(lod.coarse[c + 1])) continue
          for (let side = 0; side < 2; side++) {
            for (let k = 0; k < R; k++) {
              const a = raise[(lod.coarse[c] * 2 + side) * R + k], b = raise[(lod.coarse[c + 1] * 2 + side) * R + k]
              if (a > 0) lifted++
              for (let i = lod.coarse[c] + 1; i < lod.coarse[c + 1]; i++) {
                const fine = raise[(i * 2 + side) * R + k]
                if (fine > a || fine > b) coarseShort++
              }
            }
          }
        }
        check(lifted > lod.coarse.length && coarseShort === 0, 'both coarse samples either side of a fine sample carry at least its lift, so the coarse strip clears wherever the fine one does', `${coarseShort} short, ${lifted} lifted`)
        // The ends of a river solved over real ground: exactly nothing at the end samples, at any rung, on either bank, while the samples beside them already lift.
        const last = r.count - 1
        let endOff = 0
        for (let k = 0; k < R; k++) {
          for (let side = 0; side < 2; side++) {
            if (raise[side * R + k] !== 0 || raise[(last * 2 + side) * R + k] !== 0) endOff++
          }
        }
        check(endOff === 0 && raise[2 * R] > 0 && raise[(last - 1) * 2 * R] > 0, 'both ends carry no lift at any rung on either bank while the samples beside them do', `${endOff} end lifts, ${raise[2 * R].toFixed(2)} / ${raise[(last - 1) * 2 * R].toFixed(2)} m beside`)
        if (peaks === shippedPeaks) {
          const built = ws.meshes.get('r').geometry.getAttribute('aRaise').data.array
          check(built.length === raise.length && built.every((v, i) => v === raise[i]), 'and the river mesh carries the lift built for the shipped peaks setting')
        }
      }
    }

    check(RUNG_AT_DEPTH.length === 11 && RUNG_AT_DEPTH.join() === '7,6,5,4,3,2,1,0,0,0,0', 'a quadtree depth maps to its rung: 512 m at depth 0 is the seventh, 8 m at depth 6 the first, 4 m and finer none', RUNG_AT_DEPTH.join())

    // updateLod through WaterSurfaces against a stub terrain: the ladder and the rungs are read once the eye has moved LOD_STEP or the terrain's render set has changed, the states follow chunk distance, the rung follows the drawn chunk under each vertex with a seam lifted for the coarser side, and nothing is uploaded when nothing changed.
    {
      const mesh = ws.meshes.get('r')
      const far = ws.meshes.get('far')
      const pond = ws.meshes.get('pond')
      const lod = mesh.userData.lod
      const geo = mesh.geometry
      const n = geo.getAttribute('position').count
      const aRaise = geo.getAttribute('aRaise'), aRaiseFar = geo.getAttribute('aRaiseFar'), aRung = geo.getAttribute('aRung')
      check(aRaise.isInterleavedBufferAttribute && aRaise.itemSize === 4 && aRaise.offset === 0 && aRaiseFar.itemSize === 3 && aRaiseFar.offset === 4 && aRaise.data === aRaiseFar.data && aRaise.data.stride === R && aRaise.count === n, 'a river\'s seven lifts ride one interleaved buffer as a vec4 and a vec3')
      check(aRung.itemSize === 1 && aRung.count === n && aRung.array instanceof Uint8Array && aRung.usage === THREE.DynamicDrawUsage && aRung.array.every((v) => v === 0), 'and a dynamic byte per vertex for the rung, built at zero')
      check(pond !== undefined && pond.geometry.getAttribute('aRaise') === undefined && pond.geometry.getAttribute('aRung') === undefined && pond.geometry.getAttribute('aFlow') === undefined, 'a lake carries none of the river attributes and takes the material\'s zero defaults')
      // The lake flag runs the other way: every lake vertex carries aLake 1 so the sheet laps and lifts with the shader's lake terms, and a river has no aLake and takes the still default.
      const aLake = pond.geometry.getAttribute('aLake')
      check(aLake !== undefined && aLake.itemSize === 1 && aLake.count > 0 && aLake.count === pond.geometry.getAttribute('position').count && aLake.array.every((v) => v === 1), 'a lake carries aLake 1 on every vertex', aLake ? `${aLake.count} of ${pond.geometry.getAttribute('position').count}` : 'no attribute')
      check(geo.getAttribute('aLake') === undefined && far.geometry.getAttribute('aLake') === undefined, 'a river carries no aLake and holds still on the default')
      check(geo.index.array.length === lod.capacity && geo.drawRange.count === lod.capacity && geo.index.usage === THREE.DynamicDrawUsage, 'a river is built all-fine into a dynamic index buffer of exactly that size', `${geo.drawRange.count} of ${lod.capacity}`)

      // The stub draws depth 5 (32 m, rung 2) west of `seam`, depth 6 (8 m, rung 1) for 300 m east of it, and depth 7 (4 m, no lift) beyond; from the eye both seams are within 400 m, so the near river reads every coarse sample there. Both rivers run monotone in x, so a vertex between two read samples has the drawn rung of one of them or between, and the fill can only lift it to the coarser neighbour.
      const stub = { seam: -250, reads: 0, groundVersion: 0, groundKeyAt(x) { this.reads++; return nodeKey(x < this.seam ? 5 : x < this.seam + 300 ? 6 : 7, 0, 0) } }
      const rungAudit = (m, reach) => {
        const rungs = m.geometry.getAttribute('aRung').array
        const Q = m.geometry.getAttribute('position').array
        let under = 0, seamLift = 0, farLift = 0, pairOff = 0
        const seen = new Set()
        for (let i = 0; i < rungs.length / 2; i++) {
          const x = (Q[i * 6] + Q[i * 6 + 3]) / 2
          const w = x < stub.seam ? 2 : x < stub.seam + 300 ? 1 : 0
          const got = rungs[i * 2]
          seen.add(got)
          if (rungs[i * 2 + 1] !== got) pairOff++
          if (got < w) under++
          else if (got > w) {
            if (Math.min(Math.abs(x - stub.seam), Math.abs(x - stub.seam - 300)) <= reach) seamLift++
            else farLift++
          }
        }
        return { under, seamLift, farLift, pairOff, seen }
      }
      const eye = { x: -300, z: 0 }
      const stateAt = (c) => {
        const b = lod.chunks[c]
        const ex = eye.x < b.minX ? b.minX - eye.x : eye.x > b.maxX ? eye.x - b.maxX : 0
        const ez = eye.z < b.minZ ? b.minZ - eye.z : eye.z > b.maxZ ? eye.z - b.maxZ : 0
        return Math.hypot(ex, ez) < LOD_FINE ? LOD_STATE_FINE : LOD_STATE_COARSE
      }
      const statesMatch = () => lod.states.every((s, c) => s === stateAt(c))
      const tally = () => [0, 1].map((s) => lod.states.filter((v) => v === s).length)
      const drawn = () => geo.drawRange.count
      const first = ws.updateLod(eye.x, eye.z, stub)
      const t1 = tally()
      check(first === 2 && statesMatch() && t1[0] > 0 && t1[1] > 0, 'the first read rewrites both rivers and grades the near one fine and coarse by chunk distance', `${first} rewritten, states ${t1.join('/')}`)
      const before = drawn()
      check(before < lod.capacity && before === lodIndices(lod, new Uint32Array(lod.capacity)), 'the draw range is the mixed strip\'s index count', `${before} of ${lod.capacity}`)
      const nearReads = stub.reads
      check(nearReads > 0 && nearReads < lod.coarse.length + far.userData.lod.coarse.length, 'the rung is read at the coarse samples alone, and past 400 m at a stride of them', `${nearReads} reads for ${lod.coarse.length + far.userData.lod.coarse.length} coarse samples`)
      {
        const near = rungAudit(mesh, LOD_SPACING)
        check(near.under === 0 && near.farLift === 0 && near.seamLift > 0 && near.pairOff === 0 && near.seen.size === 3, 'within 400 m every vertex has the rung drawn under it, the seam vertices the coarser side\'s, both banks alike, all three rungs present', `${near.under} under, ${near.seamLift} seam-lifted, ${near.farLift} lifted elsewhere, seen ${[...near.seen].sort().join('/')}`)
        const off = rungAudit(far, LOD_SPACING * 4)
        check(off.under === 0 && off.farLift === 0 && off.pairOff === 0 && off.seen.size === 3, 'past 400 m the same holds with the seam lifted for up to a stride', `${off.under} under, ${off.seamLift} seam-lifted, ${off.farLift} lifted elsewhere`)
      }
      const rungVersion = aRung.version
      check(rungVersion > 0 && geo.index.version > 0, 'the rewritten rungs and index are flagged for upload', `${rungVersion} ${geo.index.version}`)

      stub.reads = 0
      lod.states[0] = 99
      const nudged = ws.updateLod(eye.x + LOD_STEP * 0.9, eye.z, stub)
      check(nudged === 0 && lod.states[0] === 99 && stub.reads === 0, `a move under ${LOD_STEP} m with the terrain unchanged reads nothing`)
      lod.states[0] = stateAt(0)
      stub.groundVersion++
      const ticked = ws.updateLod(eye.x + LOD_STEP * 0.9, eye.z, stub)
      check(ticked === 0 && stub.reads > 0 && aRung.version === rungVersion && drawn() === before, 'a terrain re-split with the eye still re-reads the rungs and uploads nothing when they hold', `${ticked} rewritten, ${stub.reads} reads`)
      stub.seam = 0
      stub.groundVersion++
      const shifted = ws.updateLod(eye.x + LOD_STEP * 0.9, eye.z, stub)
      const after = rungAudit(mesh, LOD_SPACING * 4)
      check(shifted === 2 && after.under === 0 && after.farLift === 0 && aRung.version > rungVersion && statesMatch() && drawn() === before, 'a re-split that moves the rungs rewrites them without touching the index', `${shifted} rewritten, ${after.under} under, ${after.farLift} lifted elsewhere`)
      eye.x += LOD_STEP * 1.1
      const same = ws.updateLod(eye.x, eye.z, stub)
      check(same === 0 && statesMatch() && drawn() === before, 'a move past the step that changes no chunk and no rung rewrites no river', `${same} rewritten`)
      eye.x = 40
      eye.z = 120
      const moved = ws.updateLod(eye.x, eye.z, stub)
      const t2 = tally()
      check(moved === 1 && statesMatch() && drawn() !== before && drawn() === lodIndices(lod, new Uint32Array(lod.capacity)), 'from mid-river only the near river is rewritten, the far one out of reach of any change', `${moved} rewritten, states ${t2.join('/')}`)
      let threw = 0
      try { ws.updateLod(NaN, 0, stub) } catch { threw++ }
      try { ws.updateLod(0, 0) } catch { threw++ }
      try { ws.updateLod(0, 0, { groundVersion: 0 }) } catch { threw++ }
      check(threw === 3, 'a non-finite eye, a missing terrain and one without groundKeyAt each throw', `${threw} of 3`)
    }
    ws.dispose()
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
