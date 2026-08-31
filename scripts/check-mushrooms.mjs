// Node-side gates for the procedural mushrooms (src/props/mushroom.js,
// src/props/mushroom-texture.js and src/props/mushroom-bank.js).
//
//   node scripts/check-mushrooms.mjs
//
// A mushroom is the first prop in this project that is a SURFACE OF REVOLUTION
// WITH A POLAR UV, and every failure below is one of the two things that costs:
// a parametrisation that does not close, or a winding that does not agree with
// the normals it was authored beside. Neither throws. Both are invisible until
// you are standing under one.
//
//   THE ATTRIBUTE LAYOUT DRIFTS. Same boot failure as rocks and ferns:
//   BatchedMesh fixes its attribute set from the first geometry it is handed and
//   `_validateGeometry` throws on any later one that disagrees, so a stray `uv`
//   on a mushroom takes the whole prop batch down rather than the mushroom.
//
//   THE TRIANGLE FORMULA STOPS BEING TRUE. `mushroomTriangles` is what the bench
//   prices a tier with before it is built and what any budget is written
//   against. It is a closed-form transcription of what `addMushroom` emits --
//   which is to say a duplication -- so the only thing that keeps it honest is
//   building the geometry and counting.
//
//   THE MUSHROOM STOPS BEING THE HEIGHT IT SAYS. `height` is in metres and the
//   generator hits it by building at unit scale, measuring and rescaling,
//   because `capRise`, `stemCurve` and `cluster` all move the top. A funnel cap
//   (`capRise` < 0) and a leaning stem are the two cases where the measured top
//   is not the obvious one, so they are the two that get bracketed here.
//
//   THE WINDING INVERTS. The prop material is DoubleSide, so an inverted face
//   still draws -- it is lit by a normal pointing into the solid, which reads as
//   a patch of the mushroom that is dark when it should be bright and does not
//   move with the sun. Nothing else in the pipeline notices.
//
//   THE POLAR SEAM COMES BACK. A polar UV needs a duplicated vertex column at
//   theta = 0 = TAU because one vertex cannot hold both u = 0 and u = 1. Those
//   duplicates must be coincident in space AND agree about their normal;
//   mushroom.js takes normals from the parametric surface rather than from the
//   triangles for exactly this reason, and if that ever reverts to
//   `computeVertexNormals` the duplicates get half a neighbourhood each and
//   every cap in the world grows a bright meridian from apex to rim.
//
//   A UV ESCAPES ITS CELL. The sheets are 2x2 grids of 64 px cells and a
//   mushroom picks its colour by addressing one of them. A UV a texel outside
//   its cell does not fail -- it samples the mushroom NEXT DOOR, so a white
//   gilled cap gets a hairline of the brown one all the way round its rim.
//
//   A SHEET GETS A HOLE, OR A MERIDIAN. The shared prop material runs
//   `alphaTest: 0.5` with `transparent: false`, so a texel under 128 alpha is
//   not a soft edge -- it is a hole punched clean through the cap. And the cap
//   chart's u axis is an ANGLE, so a cell whose left and right columns disagree
//   paints a seam down every cap that wears it.
//
// Sections 11 to 15 gate the BANK instead of the generator, and the failures
// there are a different family -- nothing about one mushroom is wrong, and the
// ladder around it is:
//
//   THE BILLBOARD STOPS SPINNING. The ladder is two mesh tiers and one card, and
//   the card is a single triangle that only works because the vertex shader
//   turns it toward the eye. It does that when the geometry's texLayer is in
//   `createPropMaterial({ billboardLayers })` AND its vertex normal is at or over
//   CARD_UP_MARK, and there is no room for a third condition: BatchedMesh fixes
//   its attribute set from the first geometry it is handed, so a per-vertex
//   `isBillboard` on this one prop would be a change to every generator in the
//   project. A card that fell off either test is a plane seen edge-on, which
//   covers no pixels at all -- every distant mushroom vanishing for a quarter of
//   the compass. Sections 12 and 13 are those two tests, written down.
//
//   THE CARD STOPS BEING PER VARIANT. The photograph is shared five ways, one
//   per species, but the triangle it is stretched over is built at each
//   variant's own measured height. Hoist that out of the variant loop and
//   nothing throws -- every size-0.8 instance simply grows 25% at the swap, and
//   the arena quietly holds eighteen copies of each of five cards.
//
//   THE MEASURED NUMBERS IN THE COMMENTS GO STALE. mushroom-bank.js quotes a
//   silhouette table for the apex-down billboard and render/mushrooms.js quotes
//   a per-species parallax crossover, and both say THIS SCRIPT gates them.
//   Sections 14 and 15 are what makes that true -- not by pinning the decimals,
//   which move with the seed, but by asserting the CLAIMS the numbers were
//   quoted to support.

import { MUSHROOM_DEFAULTS, buildMushroom, mushroomTriangles } from '../src/props/mushroom.js'
import {
  mushroomCapSheet, mushroomCaveSheet, mushroomFleshSheet, MUSHROOM_CELL_PX,
  capCell, fleshCell, CAP_FOREST, CAP_CAVE, FLESH,
} from '../src/props/mushroom-texture.js'
import {
  MUSHROOM_NAMES, MUSHROOM_SPECIES,
  MUSHROOM_BILLBOARD_TRI,
  MUSHROOM_MESH_RADIAL, MUSHROOM_LOD_SPANS,
  mushroomVariants, mushroomImpostorLayers, mushroomParams,
  buildMushroomBank, mushroomBankTriangles,
} from '../src/props/mushroom-bank.js'
import { CARD_UP_MARK } from '../src/material.js'
import { LAYER, LAYER_COUNT } from '../src/textures.js'
import { readFileSync } from 'node:fs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// A spread of SHAPES rather than of seeds, for the same reason check-rocks.mjs
// spreads shapes: the noise field is not where the bugs are. Every knob that
// changes the vertex layout is moved by at least one entry here, and the corners
// that switch a whole block on or off -- `underside`, `gillBlades`, `ring`,
// `stemHeight: 0`, `cluster` -- are each bracketed from both sides.
//
// TWO OF THOSE BRACKETS ARE WRITTEN OUT EXPLICITLY RATHER THAN LEFT TO THE
// DEFAULT, and both for the same reason: the default moved under them.
// `underside` is now false by default, so every shape that means to exercise the
// gill sheet says `underside: true` out loud -- left implicit, six of these
// shapes would have quietly stopped building an underside at all and the blades,
// which mushroom.js only emits when there is an underside to hang them from,
// would have gone with it. `stemCurve` is now 0.3, and section 5's absolute
// reference ("the cap top faces the sky") can only be asserted on a mushroom
// that is standing up straight, so the shapes it leans on say `stemCurve: 0`.
const SHAPES = [
  { name: 'default', over: {} },
  { name: 'fly agaric', over: { radial: 10, capRings: 3, underside: true, underRings: 2, ring: 0.55, bulb: 0.4, capCell: 1, fleshCell: 0 } },
  { name: 'button', over: { radial: 6, capRings: 2, underside: true, underRings: 1, inroll: 0.5, capRise: 0.34, margin: -0.03, umbo: 0.05, stemCurve: 0 } },
  { name: 'parasol', over: { radial: 12, stemRadial: 8, capRings: 3, capCurve: 5.5, capRise: 0.14, ring: 0.4, stemRings: 4, stemCurve: 0.3, capCell: 2, fleshCell: 3 } },
  { name: 'funnel', over: { capRise: -0.18, capCurve: 1.6, wavy: 0.22, lobes: 5, underside: true, underRings: 2, stemCurve: 0, capCell: 3, fleshCell: 2 } },
  { name: 'cave giant', over: { height: 3, radial: 14, stemRadial: 12, capRings: 3, underside: true, underRings: 3, stemRings: 5, gillBlades: 24, ring: 0.7, capLayer: LAYER.MUSHROOM_CAP_CAVE, capCell: 1, fleshCell: 3 } },
  { name: 'no underside', over: { underside: false, radial: 5, capRings: 1, stemRings: 1, stemCurve: 0 } },
  { name: 'blades, no ring', over: { gillBlades: 12, ring: 0, radial: 9, underside: true, underRings: 2 } },
  // stemRadial 6 against radial 9 is the case the ring block cares about: the
  // skirt's inner edge has to land on the stalk, so it is swept with the STEM's
  // column count and not the cap's.
  { name: 'ring, no blades', over: { gillBlades: 0, ring: 0.8, radial: 9, stemRadial: 6, underside: true } },
  { name: 'leaning', over: { lean: 0.35, stemCurve: 0.5, stemRings: 4, stemTaper: -0.4, capTilt: 0.12 } },
  // stemRadial 1 is below the floor on purpose. A prism needs three sides and
  // both addMushroom and layout() below clamp to it; a clamp only one of them
  // applies is a vertex-count mismatch that section 1 would catch, which is
  // exactly what this entry is here to make it catch.
  { name: 'troop', over: { cluster: 6, clusterSpread: 0.7, radial: 7, stemRadial: 1, ring: 0.3 } },
  // stemHeight 0 is the bracket fungus: no stem block, no ring block, and the
  // cap attaches at y = 0 instead of riding a frame.
  { name: 'bracket', over: { stemHeight: 0, capTilt: 0.5, sweep: Math.PI, capRadius: 0.6, underside: true, gillBlades: 6 } },
  { name: 'troop of brackets', over: { cluster: 3, stemHeight: 0, underside: true, gillBlades: 5, radial: 6 } },
]

console.log(`\n=== mushroom checks, ${SHAPES.length} shapes ===\n`)

// ---------------------------------------------------------------------------
// The vertex layout, transcribed from addMushroom's emission order.
//
// Sections 5, 6 and 7 all need to know WHICH SURFACE a vertex belongs to, and
// there is no attribute that says so -- `texLayer` distinguishes cap from flesh
// but not underside from stem from ring. So the blocks are re-derived here from
// the same parameters addMushroom reads, and then section 1 asserts the total
// against the geometry. That assertion is what makes this transcription safe: if
// the emission order ever changes, the vertex count stops matching and every
// section built on this fails loudly rather than checking the wrong vertices.
//
// One stride serves every member of a clump: a clump varies age, lean and cap
// curvature per member, and none of those change how many vertices a member
// emits.
// ---------------------------------------------------------------------------

function layout(over) {
  const p = { ...MUSHROOM_DEFAULTS, ...over }
  const cols = Math.max(3, Math.round(p.radial))
  // The stem and its ring are swept with their OWN column count. addMushroom
  // splits the two knobs deliberately -- a cap is a broad silhouette where every
  // facet shows and a stalk is a few millimetres wide in its own cap's shadow --
  // so a transcription that reuses `cols` here counts vertices that were never
  // emitted, and does it silently on every mushroom in the file.
  const stemCols = Math.max(3, Math.round(p.stemRadial))
  const capRings = Math.max(1, Math.round(p.capRings))
  const underRings = Math.max(1, Math.round(p.underRings))
  const stemRings = Math.max(1, Math.round(p.stemRings))
  const blades = Math.max(0, Math.round(p.gillBlades))
  const hasStem = p.stemHeight > 1e-4
  const closed = p.sweep >= Math.PI * 2 - 1e-6

  const blocks = []
  let at = 0
  // `wraps` says whether this block's first and last column are the same point
  // in space -- true for anything swept the whole way round the axis. The stem
  // and the ring are always swept full circle; the cap and its underside follow
  // `sweep`, which a bracket cuts short.
  const grid = (name, rows, wraps, c = cols) => {
    blocks.push({ name, first: at, rows, cols: c, verts: rows * (c + 1), wraps })
    at += rows * (c + 1)
  }

  grid('cap', capRings + 1, closed)
  if (p.underside) grid('underside', underRings + 1, closed)
  if (blades > 0 && p.underside) {
    blocks.push({ name: 'blades', first: at, rows: 0, cols: 0, verts: blades * 4, wraps: false })
    at += blades * 4
  }
  if (hasStem) grid('stem', stemRings + 1, true, stemCols)
  if (hasStem && p.ring > 1e-4) grid('ring', 2, true, stemCols)

  return { stride: at, blocks, cluster: Math.max(1, Math.round(p.cluster)), p }
}

// Which block a vertex index falls in, across every member of a clump.
function blockOf(lay, vertex) {
  const local = vertex % lay.stride
  for (const b of lay.blocks) if (local >= b.first && local < b.first + b.verts) return b
  throw new Error(`vertex ${vertex} falls outside the transcribed layout`)
}

// ---------------------------------------------------------------------------
// 1. Attribute layout, and the vertex count the rest of this file stands on.
// ---------------------------------------------------------------------------

console.log('geometry')

const LAYOUT = ['normal', 'position', 'texLayer', 'uvProj'] // sorted
{
  let wrongAttrs = 0
  let unindexed = 0
  let nan = 0
  let wrongCount = 0
  let firstWrong = ''
  for (const shape of SHAPES) {
    const geo = buildMushroom(shape.over)
    // The SET, not just presence. An extra attribute is exactly as fatal as a
    // missing one, and it is the more likely of the two to be added by accident.
    const names = Object.keys(geo.attributes).sort()
    if (names.join(',') !== LAYOUT.join(',')) {
      wrongAttrs++
      if (!firstWrong) firstWrong = `${shape.name}: ${names.join(',')}`
    }
    if (!geo.index) unindexed++
    for (const a of ['position', 'normal', 'uvProj', 'texLayer']) {
      if (!geo.attributes[a]) continue
      for (const v of geo.attributes[a].array) if (!Number.isFinite(v)) { nan++; break }
    }
    const lay = layout(shape.over)
    const want = lay.stride * lay.cluster
    if (geo.attributes.position.count !== want) {
      wrongCount++
      if (!firstWrong) firstWrong = `${shape.name}: ${geo.attributes.position.count} verts, layout says ${want}`
    }
    geo.dispose()
  }
  check(wrongAttrs === 0, 'every geometry is exactly { position, normal, uvProj, texLayer }',
    wrongAttrs === 0 ? `${SHAPES.length} shapes` : `${wrongAttrs} wrong -- ${firstWrong}`)
  check(unindexed === 0, 'every geometry is indexed (the triangle count the scatter prices with needs it)', `${unindexed} not`)
  check(nan === 0, 'no NaN in any attribute', `${nan} shapes with NaN`)
  check(wrongCount === 0, 'the vertex layout this file assumes is the one addMushroom emits',
    wrongCount === 0 ? 'cap / underside / blades / stem / ring, per member' : firstWrong)
}

// ---------------------------------------------------------------------------
// 2. mushroomTriangles is the truth, not the intention.
// ---------------------------------------------------------------------------

console.log('\ntriangle formula')

{
  let mismatch = null
  let total = 0
  for (const shape of SHAPES) {
    const geo = buildMushroom(shape.over)
    const built = geo.index.count / 3
    const predicted = mushroomTriangles(shape.over)
    if (built !== predicted && mismatch === null) {
      mismatch = `${shape.name}: predicted ${predicted}, built ${built}`
    }
    total += built
    geo.dispose()
  }
  check(mismatch === null, 'mushroomTriangles() equals index.count / 3 for every shape',
    mismatch === null ? `${SHAPES.length} shapes, ${total} triangles` : mismatch)
}

// ---------------------------------------------------------------------------
// 3. It sits on the ground and is the height it says.
//
// Both halves matter and they fail differently. A mushroom whose min.y is not 0
// floats or is buried, and the scatter has no way to know. A mushroom whose
// measured height is not `height` breaks the size classes the scatter sorts by,
// so a 3 m cave mushroom gets scattered at forest-floor density.
// ---------------------------------------------------------------------------

console.log('\nground and height')

const HEIGHTS = [0.05, 0.09, 0.22, 1.4, 3.0]
{
  let offGround = null
  let wrongHeight = null
  let worstGround = 0
  let worstHeight = 0
  let builds = 0
  for (const shape of SHAPES) {
    for (const height of HEIGHTS) {
      const geo = buildMushroom({ ...shape.over, height })
      geo.computeBoundingBox()
      const bb = geo.boundingBox
      const groundErr = Math.abs(bb.min.y)
      const heightErr = Math.abs(bb.max.y - bb.min.y - height)
      if (groundErr > worstGround) worstGround = groundErr
      if (heightErr > worstHeight) worstHeight = heightErr
      if (groundErr > 1e-5 && offGround === null) offGround = `${shape.name} at ${height} m: min.y ${bb.min.y.toExponential(2)}`
      if (heightErr > 1e-4 && wrongHeight === null) wrongHeight = `${shape.name} at ${height} m: measured ${(bb.max.y - bb.min.y).toFixed(5)}`
      builds++
      geo.dispose()
    }
  }
  check(offGround === null, 'every mushroom stands on y = 0',
    offGround === null ? `${builds} builds, worst |min.y| ${worstGround.toExponential(1)}` : offGround)
  check(wrongHeight === null, 'every mushroom is exactly `height` metres tall, funnels and leaners included',
    wrongHeight === null ? `worst error ${worstHeight.toExponential(1)} m` : wrongHeight)
}

// ---------------------------------------------------------------------------
// 4. The stalk does not come up through its own cap.
//
// A dome sits above the stem tip and cannot penetrate anything. A FUNNEL can:
// with `capRise` negative the cap profile's low point is the axis, which is
// exactly where the stalk is, so a chanterelle built naively wears its own stem
// through the middle of its cap. addMushroom answers this with `capLift`,
// raising the cap until its surface meets the stalk at the stalk's INSCRIBED
// radius; this is the gate that keeps that true.
//
// THE TEST IS A RAY CAST, AND IT IS CAST ALONG THE STEM'S OWN TANGENT AT THE
// TOP RATHER THAN ALONG WORLD UP. That distinction is the difference between
// testing the geometry and testing the pose. `stemCurve` walks the cap off the
// world axis -- 0.7 radians is forty degrees -- and a world-vertical ray fired
// from the joint of a cap tilted that far escapes past the rim with nothing at
// all wrong: the joint is still tucked under the cap along the cap's OWN axis,
// which is the axis the overhang is built about. Anything phrased in radius
// from the origin has the same flaw and worse.
//
// Only the stalk's TOP ring is cast from, and only the CAP is cast at. The top
// ring is the only one that can penetrate, since every ring below it is further
// from the cap by construction; and the cap is the only surface whose cover
// counts, because the underside is optional and off by default.
//
// CALIBRATED BY BREAKING IT: with `capLift` forced to zero in mushroom.js this
// section fails on `funnel` -- and off this file, on all 54 chanterelle cells of
// the /gen-mushroom variant matrix, 4 of 4 stalk-top vertices proud on every
// one. It is a real gate rather than a tautology, and `funnel` is the shape
// carrying it: it is the only entry in SHAPES with a negative `capRise`, so
// deleting that one shape silently retires the whole section.
// ---------------------------------------------------------------------------

console.log('\nstalk and cap')

{
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const centroid = (pts) => [0, 1, 2].map((k) => pts.reduce((s, q) => s + q[k], 0) / pts.length)
  const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }

  // Moller-Trumbore, in the general-direction form -- the ray is the stem's
  // tangent, which points wherever `stemCurve` and `lean` left it.
  const hits = (o, d, tris) => {
    for (const [a, b, c] of tris) {
      const e1 = sub(b, a)
      const e2 = sub(c, a)
      const pv = cross(d, e2)
      const det = dot(e1, pv)
      if (Math.abs(det) < 1e-14) continue
      const inv = 1 / det
      const tv = sub(o, a)
      const u = dot(tv, pv) * inv
      if (u < 0 || u > 1) continue
      const qv = cross(tv, e1)
      const v = dot(d, qv) * inv
      if (v < 0 || u + v > 1) continue
      if (dot(e2, qv) * inv > 1e-9) return true
    }
    return false
  }

  let firstProud = null
  let castsMade = 0
  let shapesTested = 0
  for (const shape of SHAPES) {
    const lay = layout(shape.over)
    const stem = lay.blocks.find((b) => b.name === 'stem')
    const cap = lay.blocks.find((b) => b.name === 'cap')
    // No stem is nothing to hide (the bracket fungus). A cap swept less than the
    // whole way round genuinely does not cover the axis, and asserting that it
    // does would be asserting a bug.
    if (!stem || !cap.wraps) continue
    shapesTested++

    const geo = buildMushroom(shape.over)
    const pos = geo.attributes.position.array
    const idx = geo.index.array
    const at = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]

    // Cap triangles, split per member of the clump: a troop's members lean
    // outward independently, so member 2's cap is no defence for member 0's
    // stalk and must not be allowed to stand in for it.
    const capTris = Array.from({ length: lay.cluster }, () => [])
    for (let f = 0; f < idx.length; f += 3) {
      const b = blockOf(lay, idx[f])
      if (b.name !== 'cap') continue
      capTris[Math.floor(idx[f] / lay.stride)].push([at(idx[f]), at(idx[f + 1]), at(idx[f + 2])])
    }

    for (let m = 0; m < lay.cluster; m++) {
      const row = (r) => {
        const out = []
        const base = m * lay.stride + stem.first + r * (stem.cols + 1)
        // Column `stem.cols` is the duplicate of column 0, so it is skipped --
        // casting from it twice would double one vertex's vote.
        for (let j = 0; j < stem.cols; j++) out.push(at(base + j))
        return out
      }
      const top = row(stem.rows - 1)
      const d = unit(sub(centroid(top), centroid(row(stem.rows - 2))))
      for (const v of top) {
        // Start a hair back down the stalk, so a joint sitting exactly on the
        // cap surface counts as covered rather than as a coin flip on a plane.
        const o = [v[0] - d[0] * 1e-6, v[1] - d[1] * 1e-6, v[2] - d[2] * 1e-6]
        castsMade++
        if (!hits(o, d, capTris[m]) && firstProud === null) {
          firstProud = `${shape.name}, member ${m}: a stalk-top vertex at (${v.map((n) => n.toFixed(3)).join(', ')}) has no cap above it`
        }
      }
    }
    geo.dispose()
  }

  check(firstProud === null, 'every vertex of the stalk top has cap over it, funnels included',
    firstProud === null ? `${castsMade} rays from ${shapesTested} stemmed shapes` : firstProud)
}

// ---------------------------------------------------------------------------
// 5. The winding agrees with the normals.
//
// For every triangle, the geometric face normal (the cross product of its two
// edges, which is what the rasteriser calls the front face) must point the same
// way as the average of its three authored vertex normals. On a single-sided
// material a disagreement is an invisible face; on this one -- DoubleSide, with
// `normal *= faceDirection` undone in src/material.js -- it is a face lit by a
// normal pointing into the solid, which is a permanently dark patch that does
// not move with the sun.
//
// GILL BLADES ARE EXCLUDED, BY IDENTITY RATHER THAN BY TOLERANCE. A blade is a
// free-standing fin, not part of a closed surface: mushroom.js emits ONE quad
// per blade and says out loud why -- "the shared prop material is already
// `side: DoubleSide` and undoes three's back-face normal flip ... so a single
// quad is lit by its AUTHORED normal from both sides". A fin has no outside, so
// which way it is wound carries no information and asserting a sign on it would
// be asserting a coin flip. What IS asserted about them is below: the two
// triangles of one blade must at least agree with EACH OTHER, since a quad
// folded against itself is a real bug that this exclusion would otherwise hide.
// ---------------------------------------------------------------------------

console.log('\nwinding')

{
  let firstBad = null
  let checked = 0
  let worstDot = 1
  let foldedBlades = 0
  // Tallied per surface as well as reported once, because "the underside" and
  // "one triangle of the underside" are different bugs with different causes.
  const perBlock = new Map()
  const totalBlock = new Map()
  for (const shape of SHAPES) {
    const geo = buildMushroom(shape.over)
    const lay = layout(shape.over)
    // The two triangles of one blade quad share their first index, which is what
    // groups them here.
    const bladeSign = new Map()
    const pos = geo.attributes.position.array
    const nrm = geo.attributes.normal.array
    const idx = geo.index.array

    for (let f = 0; f < idx.length; f += 3) {
      const i0 = idx[f], i1 = idx[f + 1], i2 = idx[f + 2]
      const block = blockOf(lay, i0)

      const ax = pos[i1 * 3] - pos[i0 * 3]
      const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1]
      const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2]
      const bx = pos[i2 * 3] - pos[i0 * 3]
      const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1]
      const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2]
      const cx = ay * bz - az * by
      const cy = az * bx - ax * bz
      const cz = ax * by - ay * bx
      const len = Math.hypot(cx, cy, cz)
      if (len < 1e-12) {
        if (firstBad === null) firstBad = `${shape.name} ${block.name} tri ${f / 3}: zero-area face`
        continue
      }

      const vx = (nrm[i0 * 3] + nrm[i1 * 3] + nrm[i2 * 3]) / 3
      const vy = (nrm[i0 * 3 + 1] + nrm[i1 * 3 + 1] + nrm[i2 * 3 + 1]) / 3
      const vz = (nrm[i0 * 3 + 2] + nrm[i1 * 3 + 2] + nrm[i2 * 3 + 2]) / 3
      const vlen = Math.hypot(vx, vy, vz)
      const dot = (cx * vx + cy * vy + cz * vz) / (len * Math.max(1e-12, vlen))

      if (block.name === 'blades') {
        // Fins: only self-consistency. Both triangles of one quad are measured
        // against the same authored normal, so if their signs disagree the quad
        // is folded against itself.
        const sign = dot > 0
        if (bladeSign.has(i0)) {
          if (bladeSign.get(i0) !== sign) foldedBlades++
        } else {
          bladeSign.set(i0, sign)
        }
        continue
      }

      checked++
      if (dot < worstDot) worstDot = dot
      totalBlock.set(block.name, (totalBlock.get(block.name) || 0) + 1)
      if (dot <= 0) {
        perBlock.set(block.name, (perBlock.get(block.name) || 0) + 1)
        if (firstBad === null) {
          firstBad = `${shape.name} ${block.name} tri ${f / 3} (verts ${i0},${i1},${i2}): dot ${dot.toFixed(4)}`
        }
      }
    }
    geo.dispose()
  }
  const tally = [...totalBlock.keys()]
    .map((k) => `${k} ${perBlock.get(k) || 0}/${totalBlock.get(k)}`)
    .join(', ')
  check(firstBad === null, 'every closed-surface triangle is wound to match its vertex normals',
    firstBad === null ? `${checked} triangles, worst dot ${worstDot.toFixed(3)}`
      : `first ${firstBad}; inverted per surface: ${tally}`)
  check(foldedBlades === 0, 'a gill blade is one flat quad, not a folded one', `${foldedBlades} folded`)

  // AND THE PAIR HAS TO POINT OUT OF THE SOLID, not merely agree with itself.
  //
  // Agreement alone is half a test, and the half it misses is the worse one: a
  // surface whose winding AND normals are both inverted is perfectly
  // self-consistent and perfectly wrong -- it draws (DoubleSide) and is lit from
  // inside. So one absolute reference is nailed down here, and it needs no
  // frames or conventions to state: THE TOP OF A CAP FACES THE SKY and THE
  // UNDERSIDE FACES THE GROUND. True of a dome, a cone, a parasol and a funnel
  // alike -- a funnel is a bowl, and the inside of a bowl still looks up.
  //
  // Only upright, single mushrooms are measured, because `capTilt`, `lean`,
  // `stemCurve` and a clump's outward flop all tip the cap on purpose and there
  // is no fixed sign to assert once they do.
  let firstInward = null
  let sampled = 0
  for (const shape of SHAPES) {
    const p = { ...MUSHROOM_DEFAULTS, ...shape.over }
    if (p.capTilt !== 0 || p.lean !== 0 || p.stemCurve !== 0 || Math.round(p.cluster) !== 1) continue
    const lay = layout(shape.over)
    const geo = buildMushroom(shape.over)
    const nrm = geo.attributes.normal.array
    const capRings = Math.max(1, Math.round(p.capRings))

    for (const b of lay.blocks) {
      if (b.name === 'cap') {
        // Rows in the inner half of the cap, skipping the apex row -- its
        // normal is surfaceNormal's degenerate fallback, a hard-coded (0,1,0),
        // so it is up whether or not anything else is.
        for (let r = 1; r < b.rows; r++) {
          if (r / capRings > 0.5) break
          for (let j = 0; j <= b.cols; j++) {
            const i = b.first + r * (b.cols + 1) + j
            sampled++
            if (nrm[i * 3 + 1] <= 0 && firstInward === null) {
              firstInward = `${shape.name} cap vertex ${i}: normal.y ${nrm[i * 3 + 1].toFixed(3)}, the cap top faces down`
            }
          }
        }
      } else if (b.name === 'underside') {
        // Row 0 is the rim, which hangs below the cap edge by `gillDrop` and so
        // faces the ground whatever the profile above it does.
        for (let j = 0; j <= b.cols; j++) {
          const i = b.first + j
          sampled++
          if (nrm[i * 3 + 1] >= 0 && firstInward === null) {
            firstInward = `${shape.name} underside vertex ${i}: normal.y ${nrm[i * 3 + 1].toFixed(3)}, the gills face up`
          }
        }
      }
    }
    geo.dispose()
  }
  check(firstInward === null, 'and the pair points out of the solid -- cap top up, gills down',
    firstInward === null ? `${sampled} normals on upright mushrooms` : firstInward)
}

// ---------------------------------------------------------------------------
// 6. No polar seam.
//
// Column 0 and column `cols` of every ring of every full-sweep block are the
// SAME POINT at theta = 0 = TAU, duplicated only so u can run 0..1. If their
// positions drift the cap has a crack in it; if their normals disagree it has a
// meridian, which is the failure mushroom.js abandoned `computeVertexNormals`
// to avoid. A bracket's cap is swept less than the whole way round, so its
// columns are genuinely different points and it is skipped -- its stem, which is
// still a full tube, is not.
// ---------------------------------------------------------------------------

console.log('\npolar seam')

{
  let badPos = null
  let badNormal = null
  let pairs = 0
  let worstGap = 0
  let worstDot = 1
  for (const shape of SHAPES) {
    const geo = buildMushroom(shape.over)
    const lay = layout(shape.over)
    const pos = geo.attributes.position.array
    const nrm = geo.attributes.normal.array

    for (let m = 0; m < lay.cluster; m++) {
      for (const b of lay.blocks) {
        if (!b.wraps || b.rows === 0) continue
        for (let r = 0; r < b.rows; r++) {
          const a = m * lay.stride + b.first + r * (b.cols + 1)
          const z = a + b.cols
          const gap = Math.hypot(
            pos[a * 3] - pos[z * 3],
            pos[a * 3 + 1] - pos[z * 3 + 1],
            pos[a * 3 + 2] - pos[z * 3 + 2],
          )
          const dot = nrm[a * 3] * nrm[z * 3] + nrm[a * 3 + 1] * nrm[z * 3 + 1] + nrm[a * 3 + 2] * nrm[z * 3 + 2]
          if (gap > worstGap) worstGap = gap
          if (dot < worstDot) worstDot = dot
          if (gap > 1e-6 && badPos === null) badPos = `${shape.name} ${b.name} ring ${r}: ${gap.toExponential(2)} m apart`
          if (dot < 0.999 && badNormal === null) badNormal = `${shape.name} ${b.name} ring ${r}: dot ${dot.toFixed(4)}`
          pairs++
        }
      }
    }
    geo.dispose()
  }
  check(badPos === null, 'the theta = 0 and theta = TAU columns are the same point',
    badPos === null ? `${pairs} pairs, worst gap ${worstGap.toExponential(1)} m` : badPos)
  check(badNormal === null, 'and they agree about their normal, so there is no meridian',
    badNormal === null ? `worst dot ${worstDot.toFixed(6)}` : badNormal)
}

// ---------------------------------------------------------------------------
// 7. Every UV stays inside the cell it declared.
//
// A UV outside its cell does not fail -- it samples the NEIGHBOURING mushroom,
// which is a hairline of the wrong colour round the rim of every cap that wears
// the cell. Which cell a vertex should be in is decided by its `texLayer`: the
// cap sheet takes `capCell`, and the flesh sheet -- underside, gill blades,
// stem and ring alike -- takes `fleshCell`.
//
// Both sheets are a 2x2 grid of 64 px cells inset by one texel on every side,
// so a legal UV lives in [cell + 1/128, cell + 1/2 - 1/128] on either. Section
// 7b then asserts the stronger thing the CAP has to satisfy, which the box
// alone does not catch.
// ---------------------------------------------------------------------------

console.log('\nsheet cells')

const SHEET_GRID = 2
const CELL_UV = 1 / SHEET_GRID
const INSET = 1 / 128

{
  let escaped = null
  let unknownLayer = null
  let verts = 0
  let cellsSeen = new Set()
  for (const shape of SHAPES) {
    const p = { ...MUSHROOM_DEFAULTS, ...shape.over }
    const geo = buildMushroom(shape.over)
    const uv = geo.attributes.uvProj.array
    const lay = geo.attributes.texLayer.array

    for (let i = 0; i < lay.length; i++) {
      let cell
      if (lay[i] === p.capLayer) cell = p.capCell
      else if (lay[i] === p.fleshLayer) cell = p.fleshCell
      else {
        if (unknownLayer === null) unknownLayer = `${shape.name} vertex ${i}: texLayer ${lay[i]}`
        continue
      }
      cellsSeen.add(`${lay[i]}:${cell}`)
      const u0 = (cell % SHEET_GRID) * CELL_UV + INSET
      const u1 = (cell % SHEET_GRID) * CELL_UV + CELL_UV - INSET
      const v0 = Math.floor(cell / SHEET_GRID) * CELL_UV + INSET
      const v1 = Math.floor(cell / SHEET_GRID) * CELL_UV + CELL_UV - INSET
      const u = uv[i * 2]
      const v = uv[i * 2 + 1]
      // 1e-6 for the float32 the attribute is stored as; the inset itself is
      // 1/128, four orders of magnitude larger, so this cannot mask an escape.
      const inU = u >= u0 - 1e-6 && u <= u1 + 1e-6
      const inV = v >= v0 - 1e-6 && v <= v1 + 1e-6
      if (!(inU && inV) && escaped === null) {
        escaped = `${shape.name} vertex ${i} (layer ${lay[i]}, cell ${cell}): uv ${u.toFixed(5)},${v.toFixed(5)} outside [${u0.toFixed(5)}..${u1.toFixed(5)}] x [${v0.toFixed(5)}..${v1.toFixed(5)}]`
      }
      verts++
    }
    geo.dispose()
  }
  check(unknownLayer === null, 'every vertex wears either the cap layer or the flesh layer',
    unknownLayer === null ? '' : unknownLayer)
  check(escaped === null, 'every uvProj lies inside its own cell, inset on all four sides so no sample crosses into a neighbour',
    escaped === null ? `${verts} vertices, ${cellsSeen.size} distinct (layer, cell) pairs` : escaped)
  // A test that only ever exercised cell 0 would pass with the cell offset
  // dropped entirely, which is the one edit this section exists to catch.
  check(cellsSeen.size >= 4, 'and the spread of shapes actually addresses cells other than 0',
    [...cellsSeen].sort().join(' '))
}

// ---------------------------------------------------------------------------
// 7b. The cap's UV is a planar projection, which is the whole reason the spots
// stopped being sliced.
//
// Section 7 only proves no cap UV leaves its cell. That is satisfied by the
// polar chart this replaced, and the polar chart is what put a kink through
// every wart near the crown: it handed each of the `radial` apex triangles a
// wedge of the chart and let the GPU interpolate the ANGLE linearly across it,
// which the true angle does not do. An inner-ring wart is 1.02 wedges wide on a
// 9-gon, so every one of them was cut by an edge.
//
// The property that kills that artefact is not resolution, it is AFFINITY: UV
// must be an affine map of the cap's own position. A triangle's position is
// already linear in its barycentric coordinates, so an affine UV is
// interpolated EXACTLY by the hardware and triangle count stops mattering to
// the texture. That is the whole claim, and it is checked by fitting the map
// by least squares over every cap vertex and requiring the residual to be
// zero: anything nonlinear -- an atan2 creeping back in, a radius passed
// through a curve -- shows up here and nowhere else.
//
// Fitted rather than compared against a formula because the cap frame is free
// to be rotated and tipped (`capSide` / `capFwd` / `capTilt` / `lean`) and a
// cluster carries several caps at several scales, so only the SHAPE of the map
// is being asserted, not any particular one.
//
// The apex collapse is then a corollary worth stating on its own, because it is
// the artefact in its most visible form: the `cols + 1` coincident vertices at
// the apex used to carry `cols + 1` different u values, which is what made the
// middle of the cap a pinwheel of wedges.
// ---------------------------------------------------------------------------

{
  // A cluster is several caps in one buffer, each with its own origin, its own
  // scale and its own axis, so they are fitted separately. capLayer is worn by
  // exactly one loop in mushroom.js -- the cap top -- and each member writes its
  // grid in one go, so a maximal contiguous run of cap-layer vertices is one
  // cap.
  let worstResid = 0
  let worstRadius = 0
  let at = ''
  let runs = 0
  let capVerts = 0
  for (const shape of SHAPES) {
    const p = { ...MUSHROOM_DEFAULTS, ...shape.over }
    const geo = buildMushroom(shape.over)
    const uv = geo.attributes.uvProj.array
    const pos = geo.attributes.position.array
    const lay = geo.attributes.texLayer.array
    const cu = (p.capCell % SHEET_GRID) * CELL_UV + CELL_UV / 2
    const cv = Math.floor(p.capCell / SHEET_GRID) * CELL_UV + CELL_UV / 2
    const half = (CELL_UV - 2 * INSET) / 2

    const groups = []
    for (let i = 0; i < lay.length; i++) {
      if (lay[i] !== p.capLayer) continue
      if (groups.length > 0 && groups[groups.length - 1].at(-1) === i - 1) groups[groups.length - 1].push(i)
      else groups.push([i])
    }
    if (groups.length === 0) throw new Error(`check-mushrooms: ${shape.name} has no cap vertices`)

    for (const ids of groups) {
      capVerts += ids.length
      for (const i of ids) {
        worstRadius = Math.max(worstRadius, Math.hypot(uv[i * 2] - cu, uv[i * 2 + 1] - cv))
      }
      if (ids.length < 6) continue // too few samples to say anything about a fit
      runs++

      // Least squares by modified Gram-Schmidt on the three centred position
      // columns. Orthogonalising rather than solving normal equations because a
      // FLAT cap (no rise, no umbo, no margin) has a constant y and a singular
      // Gram matrix, and a flat cap is the case most worth checking.
      const n = ids.length
      let mx = 0, my = 0, mz = 0, mu = 0, mv = 0
      for (const i of ids) {
        mx += pos[i * 3]; my += pos[i * 3 + 1]; mz += pos[i * 3 + 2]
        mu += uv[i * 2]; mv += uv[i * 2 + 1]
      }
      mx /= n; my /= n; mz /= n; mu /= n; mv /= n
      const cols = [
        ids.map((i) => pos[i * 3] - mx),
        ids.map((i) => pos[i * 3 + 1] - my),
        ids.map((i) => pos[i * 3 + 2] - mz),
      ]
      const scale = Math.max(...cols.map((c) => Math.hypot(...c)))
      const basis = []
      for (const col of cols) {
        const q = col.slice()
        for (const b of basis) {
          let d = 0
          for (let k = 0; k < n; k++) d += q[k] * b[k]
          for (let k = 0; k < n; k++) q[k] -= d * b[k]
        }
        const len = Math.hypot(...q)
        if (len <= 1e-7 * scale) continue // a direction the cap does not span
        for (let k = 0; k < n; k++) q[k] /= len
        basis.push(q)
      }
      const du = ids.map((i) => uv[i * 2] - mu)
      const dv = ids.map((i) => uv[i * 2 + 1] - mv)
      for (const b of basis) {
        let a = 0, c = 0
        for (let k = 0; k < n; k++) { a += du[k] * b[k]; c += dv[k] * b[k] }
        for (let k = 0; k < n; k++) { du[k] -= a * b[k]; dv[k] -= c * b[k] }
      }
      let resid = 0
      for (let k = 0; k < n; k++) resid = Math.max(resid, Math.hypot(du[k], dv[k]))
      if (resid > worstResid) at = `${shape.name}, a run of ${n} cap vertices`
      worstResid = Math.max(worstResid, resid)
    }
    geo.dispose()
  }
  // 1e-6 of a cell is under a thousandth of a texel and comfortably above
  // float32's own resolution on a number of order 0.25, which is what uvProj is
  // stored as. Anything structural is orders of magnitude above it.
  check(worstResid < 1e-6 && runs >= SHAPES.length,
    "the cap's UV is EXACTLY affine in the cap's own position, so the GPU interpolates it without error",
    `${runs} caps fitted over ${capVerts} vertices, worst residual ${worstResid.toExponential(1)} of a cell${at === '' ? '' : ` (${at})`}`)

  // And the projected disc is inscribed in the cell EXACTLY: capMaxR is measured
  // over the grid that is emitted, so some vertex sits on the rim of the
  // inscribed circle and none sits outside it. Too big overflows the inset and
  // samples the neighbouring cell; too small throws away resolution.
  const HALF = (CELL_UV - 2 * INSET) / 2
  check(Math.abs(worstRadius - HALF) < 1e-6,
    'and its disc is inscribed in the cell exactly -- it touches the inset and never crosses it',
    `widest cap UV ${worstRadius.toFixed(5)} from its cell centre, inset half-span ${HALF.toFixed(5)}`)
}

// The apex collapse, stated on its own because it is the artefact at its worst.
{
  let worst = 0
  let at = ''
  let groups = 0
  for (const shape of SHAPES) {
    const p = { ...MUSHROOM_DEFAULTS, ...shape.over }
    const geo = buildMushroom(shape.over)
    const uv = geo.attributes.uvProj.array
    const pos = geo.attributes.position.array
    const lay = geo.attributes.texLayer.array
    const seen = new Map()
    for (let i = 0; i < lay.length; i++) {
      if (lay[i] !== p.capLayer) continue
      const k = `${pos[i * 3].toFixed(6)},${pos[i * 3 + 1].toFixed(6)},${pos[i * 3 + 2].toFixed(6)}`
      if (!seen.has(k)) { seen.set(k, [uv[i * 2], uv[i * 2 + 1]]); continue }
      const [u0, v0] = seen.get(k)
      const gap = Math.hypot(uv[i * 2] - u0, uv[i * 2 + 1] - v0)
      if (gap > worst) { worst = gap; at = `${shape.name} at ${k}` }
    }
    groups += seen.size
    geo.dispose()
  }
  check(worst < 1e-6,
    'and cap vertices that share a position share a UV -- the apex fan is ONE texel, not `radial` of them',
    worst < 1e-6 ? `${groups} distinct cap positions, worst disagreement ${worst.toExponential(1)}`
                 : `${at}: UVs differ by ${worst.toFixed(5)}`)
}

// ---------------------------------------------------------------------------
// 8. The sheets are opaque.
//
// Not a nicety. The shared prop material runs `alphaTest: 0.5` with
// `transparent: false`, so a texel under 128 alpha is discarded outright: not a
// soft edge, a hole straight through the cap. mushroom-texture.js writes 255
// everywhere and says so; this is what keeps that true after somebody adds a
// pattern that writes four bytes instead of three.
// ---------------------------------------------------------------------------

console.log('\nsheet alpha')

const SHEETS = [
  ['cap (forest)', mushroomCapSheet()],
  ['cap (cave)', mushroomCaveSheet()],
  ['flesh', mushroomFleshSheet()],
]
const SHEET_PX = MUSHROOM_CELL_PX * SHEET_GRID

for (const [name, px] of SHEETS) {
  check(px.length === SHEET_PX * SHEET_PX * 4, `the ${name} sheet is ${SHEET_PX}x${SHEET_PX} RGBA`,
    `${px.length} bytes`)
  let holes = 0
  let dimmest = 255
  for (let i = 3; i < px.length; i += 4) {
    if (px[i] !== 255) holes++
    if (px[i] < dimmest) dimmest = px[i]
  }
  check(holes === 0, `the ${name} sheet is opaque everywhere -- alphaTest 0.5 punches holes, not soft edges`,
    holes === 0 ? 'all alpha 255' : `${holes} texels under 255, dimmest ${dimmest}`)
}

// ---------------------------------------------------------------------------
// 9. Every cell closes across its angular seam.
//
// Both sheet kinds paint a pattern that runs AROUND the axis of revolution, so
// both have a place where angle 0 meets angle 1. If the generator is not
// periodic there, every mushroom wearing that cell gets a line painted from
// apex to rim. The two kinds put that seam in different places, so they are
// measured differently:
//
//   A FLESH CELL IS A POLAR CHART -- u is the angle outright. Its seam is the
//   join between the last pixel column and the first, which RepeatWrapping
//   makes adjacent on the real surface.
//
//   A CAP CELL IS A DISC seen from above, so its angle is atan2 of the texel's
//   offset from the centre and its seam is the +x RAY: the two pixel rows
//   straddling the centre line, compared across the right half of the disc.
//   The disc layout is why the cap's spots stopped being sliced (section 7b),
//   but it does not make the seam go away -- the pattern layer on top of the
//   grain (fibres, wrinkles, warts) is still genuinely radial and still has to
//   close. Only the columns inside the disc for BOTH rows are compared, so the
//   clamped corners cannot pad the statistic with flat texels.
//
// THIS IS MEASURED OVER EIGHT SEEDS PER CELL, not over the one raster that ships,
// and that is the whole design of the gate. A single raster cannot answer the
// question: `scarlet`'s warts are hard white edges on red, and whether one of
// them happens to straddle the seam swings the measured step from 0.12x to 0.78x
// of the cell's worst interior step -- across nothing but the seed. A threshold
// tight enough to catch a real break fails an unlucky wart; one loose enough to
// pass the wart catches nothing. Averaged over seeds the wart lands on the seam
// sometimes and not others, so the average reports the GENERATOR's periodicity
// instead of one roll of the dice. A genuinely non-periodic cell is broken at
// every seed and the average does not rescue it.
//
// Both bounds are scale-free -- ratios against the cell's own interior. An
// absolute byte threshold was tried first and had to go for the same reason:
// there is no byte count that separates a hard wart edge from a discontinuity.
//
//   VS THE WORST INTERIOR STEP, mean under 0.85. The seam is 1 of ~60 adjacent
//   pairs, so on a continuous cell it is rarely the worst; a discontinuity
//   almost always is. Real cells measure 0.01x to 0.76x, the binding case being
//   cap `violet`. That margin is thinner than it looks in isolation, so it was
//   checked across five independent eight-seed blocks per cell: the block means
//   move by at most 0.09x and no cell's mean reaches 0.8x.
//
//   VS THE MEDIAN INTERIOR STEP, mean under 1.7. Catches the cell that is smooth
//   nearly everywhere and has one hard interior edge, which would give the first
//   bound a large denominator to hide behind. Real cells measure 0.01x to 1.12x.
//
// CALIBRATION. Every cell was re-rendered with its wrap deliberately broken. A
// flesh cell's columns were resampled into one fewer, so it no longer completes
// a turn, and a column of an unrelated cell pasted at the join; a cap disc was
// resampled at a squeezed ANGLE, 63/64 of a turn spread over the whole disc, so
// the pattern fails to meet itself at the ray. Interiors left as smooth as they
// were. The two bounds together flag 9 of the 12 while passing all 12 real cells
// at every seed. Stated rather than rounded up: the misses are flesh `buff`, cap
// `ivory` and cap `verdigris`, each of which varies slowly enough around the
// axis that a broken join barely moves any statistic. This gate is a guard
// against a coarse mistake, not a proof of periodicity -- the proof is
// structural, in wrapNoise's modulo lattice and in wrapDelta.
// ---------------------------------------------------------------------------

console.log('\nsheet seams')

const SEAM_VS_MAX = 0.85
const SEAM_VS_MEDIAN = 1.7
const SEAM_SEEDS = 8

// MEAN per-channel difference down two whole pixel lines, not the worst single
// pixel. A seam is a line you see along its whole length, so the mean is the
// statistic that matches the artefact; a max is dominated by whichever single
// wart edge happens to cross the line, which is a feature of the art rather
// than a discontinuity in it.
function columnStep(px, n, x0, x1) {
  let sum = 0
  for (let y = 0; y < n; y++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(px[(y * n + x0) * 4 + c] - px[(y * n + x1) * 4 + c])
    }
  }
  return sum / (n * 3)
}

// The same, for two rows of a disc, over the right half only and only where
// both rows are inside the circle.
function rowStep(px, n, y0, y1) {
  const d0 = ((y0 + 0.5) / n) * 2 - 1
  const d1 = ((y1 + 0.5) / n) * 2 - 1
  const lim = Math.sqrt(Math.max(0, 1 - Math.max(d0 * d0, d1 * d1)))
  let sum = 0
  let cols = 0
  for (let x = n / 2; x < n; x++) {
    if (((x + 0.5) / n) * 2 - 1 > lim) break
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(px[(y0 * n + x) * 4 + c] - px[(y1 * n + x) * 4 + c])
    }
    cols++
  }
  // Under 8 columns the row pair is a sliver of rim and its step is noise.
  return cols >= 8 ? sum / (cols * 3) : null
}

// Floored denominators, so a cell that is flat along some line cannot divide by
// ~0 and report an infinite ratio on a difference nobody could see.
function ratios(seam, steps) {
  steps.sort((a, b) => a - b)
  return {
    seam,
    vsMax: seam / Math.max(0.5, steps[steps.length - 1]),
    vsMedian: seam / Math.max(0.5, steps[steps.length >> 1]),
  }
}

function fleshSeam(px, n) {
  const steps = []
  for (let x = 0; x < n - 1; x++) steps.push(columnStep(px, n, x, x + 1))
  return ratios(columnStep(px, n, n - 1, 0), steps)
}

function capSeam(px, n) {
  const steps = []
  for (let y = 0; y < n - 1; y++) {
    if (y === n / 2 - 1) continue // the seam pair itself
    const s = rowStep(px, n, y, y + 1)
    if (s !== null) steps.push(s)
  }
  return ratios(rowStep(px, n, n / 2 - 1, n / 2), steps)
}

for (const [name, specs, render, measure, seam] of [
  ['cap (forest)', CAP_FOREST, capCell, capSeam, 'the +x ray'],
  ['cap (cave)', CAP_CAVE, capCell, capSeam, 'the +x ray'],
  ['flesh', FLESH, fleshCell, fleshSeam, 'the u wrap'],
]) {
  let bad = null
  let worstMax = 0
  let worstMed = 0
  for (const spec of specs) {
    let sumMax = 0
    let sumMed = 0
    let shipped = 0
    for (let k = 0; k < SEAM_SEEDS; k++) {
      const r = measure(render({ ...spec, seed: spec.seed + k * 7 }), MUSHROOM_CELL_PX)
      sumMax += r.vsMax
      sumMed += r.vsMedian
      if (k === 0) shipped = r.seam
    }
    const vsMax = sumMax / SEAM_SEEDS
    const vsMed = sumMed / SEAM_SEEDS
    if (vsMax > worstMax) worstMax = vsMax
    if (vsMed > worstMed) worstMed = vsMed
    if ((vsMax > SEAM_VS_MAX || vsMed > SEAM_VS_MEDIAN) && bad === null) {
      bad = `${spec.name}: over ${SEAM_SEEDS} seeds the seam step averages ${vsMax.toFixed(2)}x the worst interior step and ${vsMed.toFixed(2)}x the median (shipped seed's seam step ${shipped.toFixed(1)}/255)`
    }
  }
  check(bad === null, `the ${name} sheet closes across ${seam} in all ${specs.length} cells`,
    bad === null ? `over ${SEAM_SEEDS} seeds each: worst mean ${worstMax.toFixed(2)}x the worst interior step, ${worstMed.toFixed(2)}x the median` : bad)
}

// And the packing is not scrambling them: whatever the generator produced has
// to be what lands in the sheet, or every measurement above is of a cell nobody
// ever samples. Read back against the very offsets capUV/cellUV hand the
// shader, so a packer that disagreed with either would be caught here rather
// than showing up as a mushroom wearing its neighbour.
{
  const SHEET_W = MUSHROOM_CELL_PX * SHEET_GRID
  let mismatch = null
  let compared = 0
  let cells = 0
  for (const [name, specs, render, sheet] of [
    ['cap (forest)', CAP_FOREST, capCell, mushroomCapSheet()],
    ['cap (cave)', CAP_CAVE, capCell, mushroomCaveSheet()],
    ['flesh', FLESH, fleshCell, mushroomFleshSheet()],
  ]) {
    specs.forEach((spec, cell) => {
      const px = render(spec)
      const ox = (cell % SHEET_GRID) * MUSHROOM_CELL_PX
      const oy = Math.floor(cell / SHEET_GRID) * MUSHROOM_CELL_PX
      cells++
      for (let y = 0; y < MUSHROOM_CELL_PX; y++) {
        for (let x = 0; x < MUSHROOM_CELL_PX * 4; x++) {
          compared++
          if (sheet[(oy + y) * SHEET_W * 4 + ox * 4 + x] !== px[y * MUSHROOM_CELL_PX * 4 + x] && mismatch === null) {
            mismatch = `${name} cell ${cell} (${spec.name}) differs from its generator at row ${y}, byte ${x}`
          }
        }
      }
    })
  }
  check(mismatch === null, 'and the packer puts each cell where its capUV/cellUV says it is',
    mismatch === null ? `${(compared / 1024).toFixed(0)}k bytes compared, ${cells} cells` : mismatch)
}

// ---------------------------------------------------------------------------
// 10. The layer registry.
//
// Three slices of the shared DataArrayTexture, and the only thing standing
// between them and somebody else's texture is that these constants are distinct
// and inside LAYER_COUNT. A collision is a SILENT RE-SKIN: nothing throws, the
// mushroom simply wears bark. An index past LAYER_COUNT writes off the end of
// the upload buffer instead.
// ---------------------------------------------------------------------------

console.log('\nlayers')

{
  const named = ['MUSHROOM_CAP', 'MUSHROOM_CAP_CAVE', 'MUSHROOM_FLESH']
  const missing = named.filter((k) => typeof LAYER[k] !== 'number')
  check(missing.length === 0, 'the three mushroom layers exist in src/textures.js',
    missing.length === 0 ? named.map((k) => `${k}=${LAYER[k]}`).join(' ') : `missing ${missing.join(', ')}`)

  const mine = named.map((k) => LAYER[k])
  check(new Set(mine).size === mine.length, 'and they are three distinct slices, not one wearing three names',
    mine.join(' '))
  const over = named.filter((k) => !(LAYER[k] < LAYER_COUNT))
  check(over.length === 0, 'and all three are inside LAYER_COUNT',
    over.length === 0 ? `< ${LAYER_COUNT}` : over.map((k) => `${k}=${LAYER[k]}`).join(', '))

  // The whole registry, not just the mushroom's corner of it: two names sharing
  // an index is the same silent re-skin whoever it happens to.
  const byIndex = new Map()
  const collisions = []
  for (const [k, v] of Object.entries(LAYER)) {
    if (byIndex.has(v)) collisions.push(`${byIndex.get(v)} and ${k} both = ${v}`)
    else byIndex.set(v, k)
  }
  check(collisions.length === 0, 'no two LAYER entries share an index',
    collisions.length === 0 ? `${Object.keys(LAYER).length} names, ${byIndex.size} indices, ${LAYER_COUNT} slices`
      : collisions.join('; '))
}

// ---------------------------------------------------------------------------
// 11. The bank is three tiers of ninety, in one attribute layout, over two
// hundred and seventy distinct buffers.
//
// Everything above this line is about ONE mushroom. From here down it is about
// the BANK -- the whole distance ladder, built once at load by
// buildMushroomBank and handed straight to a BatchedMesh -- and the failures
// change character with it.
//
// THE ATTRIBUTE SET IS THE SAME HARD REQUIREMENT SECTION 1 STATES, asserted a
// second time because the card tier does not come from addMushroom. It comes
// from buildImpostorCard, which is shared with the trees and the ferns, so a
// tree-driven edit there lands in the mushroom batch without anybody looking at
// this prop. BatchedMesh fixes its attribute set from the FIRST geometry it is
// given and `_validateGeometry` throws on any later one that disagrees, so a
// single stray attribute on a single card does not degrade the cards -- it
// takes the whole prop layer down at construction.
//
// THREE TIERS OF NINETY AND NOTHING SHARED. Every tier is 90 slots long so that
// a band index and a variant id stay independent lookups, and every slot holds
// its OWN buffer -- the card included, because it is sized to the variant it
// stands in for rather than to the species' middle size. render/mushrooms.js
// dedupes on object identity before it sizes the arena, which is defensive
// against exactly the edit this section would otherwise miss: hoist the card
// build out of the variant loop and nothing throws and nothing looks wrong, but
// the size-0.8 instances grow 25% at the swap and the `bytes` the bank reports
// stop describing the bank in the batch.
// ---------------------------------------------------------------------------

console.log('\nbank')

const BANK_SEED = 1
const BANK = buildMushroomBank({ seed: BANK_SEED })
const VARIANTS = mushroomVariants()

// The card tier sits after the mesh tiers, however many of those there are.
// Named rather than written as 2, because the mesh tiers have been added to and
// taken from before now and a hard-coded index went on pointing at a tier that
// still existed and was no longer a card.
const CARD_TIER = MUSHROOM_MESH_RADIAL.length

// The distinct geometry objects behind the tier arrays, in first-seen order --
// the same identity dedupe render/mushrooms.js does before it sizes the arena.
const DISTINCT = []
{
  const seen = new Set()
  for (const tier of BANK.tiers) {
    for (const g of tier.geometries) {
      if (seen.has(g)) continue
      seen.add(g)
      DISTINCT.push(g)
    }
  }
}

{
  const lens = BANK.tiers.map((t) => t.geometries.length)
  const want = VARIANTS.length
  check(BANK.tiers.length === MUSHROOM_MESH_RADIAL.length + 1 && lens.every((n) => n === want),
    `the bank is ${MUSHROOM_MESH_RADIAL.length + 1} tiers deep -- ${MUSHROOM_MESH_RADIAL.length} mesh and the billboard -- and every tier holds one slot per variant`,
    `${BANK.tiers.length} tiers of ${lens.join('/')}; mushroomVariants() is ${want}, one per species, and MUSHROOM_NAMES holds ${MUSHROOM_NAMES.length}`)

  let wrongAttrs = ''
  let unindexed = 0
  for (const g of DISTINCT) {
    const names = Object.keys(g.attributes).sort()
    if (names.join(',') !== LAYOUT.join(',') && !wrongAttrs) wrongAttrs = names.join(',')
    if (!g.index) unindexed++
  }
  check(wrongAttrs === '', 'every bank geometry is exactly { position, normal, uvProj, texLayer }',
    wrongAttrs === '' ? `${DISTINCT.length} distinct geometries, meshes and cards alike` : `first wrong set: ${wrongAttrs}`)
  check(unindexed === 0, 'and every one of them is indexed (the triangle count the scatter prices with needs it)',
    `${unindexed} not`)

  // Section 2 proves the formula against buildMushroom's own output; this
  // proves the BANK is built from the parameters the formula was priced with.
  // The count itself does not depend on the seed -- it falls out of the ring and
  // column counts -- so what this catches is a bank that resolves a variant's
  // multipliers differently from mushroomParams, which would price ninety
  // meshes against ninety other meshes.
  let offBy = null
  const meshTris = MUSHROOM_MESH_RADIAL.map(() => 0)
  MUSHROOM_MESH_RADIAL.forEach((radial, t) => {
    VARIANTS.forEach((v, i) => {
      const built = BANK.tiers[t].geometries[i].index.count / 3
      const predicted = mushroomTriangles(mushroomParams(v, BANK_SEED + i * 101, t))
      meshTris[t] += built
      if (built !== predicted && offBy === null) {
        offBy = `tier ${t} (radial ${radial}) variant ${i} (${v.species}): built ${built}, mushroomTriangles says ${predicted}`
      }
    })
  })
  check(offBy === null, 'every mesh-tier slot is exactly mushroomTriangles(mushroomParams(variant, tier))',
    offBy === null ? `${MUSHROOM_MESH_RADIAL.length} tiers x ${VARIANTS.length} meshes, ${meshTris.join(' + ')} triangles` : offBy)

  // The two mesh tiers exist because the cap's UV is a planar decal now. Under
  // the old polar chart a coarse cap SLICED its own texture -- column count and
  // texture quality were the same knob -- so there was no coarse tier to have.
  // With the decal, dropping 16 columns to 6 costs silhouette and nothing else,
  // which is what a distance tier is allowed to cost.
  const perTier = MUSHROOM_MESH_RADIAL.map((_, t) =>
    BANK.tiers[t].geometries.map((g) => g.index.count / 3))
  const halves = MUSHROOM_MESH_RADIAL.map((_, t) => meshTris[t] / meshTris[0])
  check(halves.every((r, t) => t === 0 || r < 0.6),
    'and each coarser mesh tier is under 60% of the finest tier\'s triangles, so the tier pays for the geometry id it burns',
    MUSHROOM_MESH_RADIAL.map((r, t) => `radial ${r}: ${Math.min(...perTier[t])}-${Math.max(...perTier[t])} tris, ${(halves[t] * 100).toFixed(0)}%`).join('; '))

  // And the price the bench quotes before anything is allocated is that same
  // total. mushroomBankTriangles never builds a geometry, so this is the only
  // thing standing between it and a budget written against a bank that does not
  // exist.
  const priced = mushroomBankTriangles({ seed: BANK_SEED })
  const pricedOk = priced.mesh.length === meshTris.length
    && priced.mesh.every((n, t) => n === meshTris[t])
  check(pricedOk && priced.variants === VARIANTS.length,
    'and mushroomBankTriangles() prices those same mesh tiers without building them',
    `priced ${priced.mesh.join(' + ')} over ${priced.variants} variants, built ${meshTris.join(' + ')} over ${VARIANTS.length}`)

  // The card tier is a fixed count by construction -- one plane is one triangle
  // -- but it is the number render/mushrooms.js multiplies a whole far tile by
  // in one go (`tris += tile.n * farTris[0]`), so a tier that stopped being
  // uniform would make the reported triangle count fiction.
  const cardTris = new Set(BANK.tiers[CARD_TIER].geometries.map((g) => g.index.count / 3))
  check(cardTris.size === 1 && cardTris.has(1),
    `tier ${CARD_TIER} is 1 triangle in all ${VARIANTS.length} slots -- the apex-${MUSHROOM_BILLBOARD_TRI} billboard`,
    `counts seen: ${[...cardTris].join(', ')}`)

  // THE SHARING IS OF PHOTOGRAPHS, NOT OF BUFFERS, and section 12 is where that
  // is gated. The card is per variant on purpose: it is one triangle, and one
  // sized for the middle variant made a size-0.8 instance grow 25% at the
  // instant it crossed the LOD band, with nothing to hide it. What the user
  // capped was the texture budget, and that is atlas layers -- still five.
  const wantDistinct = VARIANTS.length * BANK.tiers.length
  check(DISTINCT.length === wantDistinct,
    `every slot has its own buffer -- ${BANK.tiers.length} tiers x ${VARIANTS.length} variants, so a card is sized for the variant it stands in for`,
    `${DISTINCT.length} distinct, want ${wantDistinct}`)

  // The reason that costs nothing anybody budgeted: bytes and triangles are both
  // summed over distinct geometries, so this is the whole arena.
  check(BANK.triangles === priced.meshTotal + priced.card,
    'and buildMushroomBank() and mushroomBankTriangles() agree on what that arena costs',
    `built ${BANK.triangles}, priced ${priced.meshTotal} + ${priced.card} = ${priced.meshTotal + priced.card}`)

  // The pop the per-variant quad exists to remove. Each card must stand as tall
  // as the mesh it replaces, within the margin impostorCardExtents adds around
  // the silhouette so the bake is not clipped at its own edge.
  let worstPop = 0
  let worstPopAt = ''
  let worstMesh = 0
  let worstMeshAt = ''
  VARIANTS.forEach((v, i) => {
    const mesh = BANK.tiers[0].geometries[i]
    mesh.computeBoundingBox()
    const mh = mesh.boundingBox.max.y - mesh.boundingBox.min.y
    for (let t = 1; t < BANK.tiers.length; t++) {
      const g = BANK.tiers[t].geometries[i]
      g.computeBoundingBox()
      const err = Math.abs((g.boundingBox.max.y - g.boundingBox.min.y) / mh - 1)
      const card = t >= CARD_TIER
      if (card && err > worstPop) {
        worstPop = err
        worstPopAt = `${v.species} size ${v.size} tier ${t}`
      }
      if (!card && err > worstMesh) {
        worstMesh = err
        worstMeshAt = `${v.species} size ${v.size} tier ${t}`
      }
    }
  })
  check(worstPop < 0.10,
    'and no card is more than 10% the wrong height for the mesh it replaces, so the LOD swap does not resize the mushroom',
    `worst ${(worstPop * 100).toFixed(1)}% at ${worstPopAt}; a card cut for one size and worn by a 0.8 one would be 25%`)

  // The coarse mesh tier is held to a far tighter line than a card, because it
  // is the SAME mesh with fewer columns rather than a stand-in: height comes off
  // the stem and the cap profile, neither of which is sampled per column, so any
  // drift here would mean a tier that resolved its parameters differently.
  check(worstMesh < 1e-6,
    'and every coarser mesh tier stands exactly as tall as the finest one, columns being the only thing it gave up',
    `worst ${worstMesh.toExponential(1)}${worstMeshAt ? ` at ${worstMeshAt}` : ''}`)
}

// ---------------------------------------------------------------------------
// 12. One photograph per species, and every card in the tier wearing it.
//
// Five layers for ninety variants. That is the whole economy of the card tier
// -- a card gives up shape and keeps hue, and hue is what still separates a
// scarlet cap from an ink cap at 8 m -- and it means the layer a card addresses
// is a SPECIES fact. A card that addressed its variant's layer instead would
// need ninety bakes and ninety slices of an array that only has 44.
//
// A CONSTANT texLayer per geometry, not merely a legal one. The attribute is
// per-vertex, and a card whose three vertices disagreed would be sampling three
// different photographs across one triangle -- the interpolated value lands
// between two layers and the shader rounds it to whichever is nearer, so the
// triangle would be cut in half down an invisible line.
//
// The registry checks are section 10's, aimed at the five impostor slices
// rather than the three sheet slices: a collision is the same silent re-skin,
// and here it would be a mushroom card wearing a photograph of a fern.
// ---------------------------------------------------------------------------

console.log('\nimpostor layers')

const IMPOSTOR_NAMES = [
  'IMPOSTOR_MUSHROOM_AGARIC', 'IMPOSTOR_MUSHROOM_PORCINI',
  'IMPOSTOR_MUSHROOM_CHANTERELLE', 'IMPOSTOR_MUSHROOM_PARASOL',
  'IMPOSTOR_MUSHROOM_INKCAP',
]

{
  const missing = IMPOSTOR_NAMES.filter((k) => typeof LAYER[k] !== 'number')
  check(missing.length === 0, 'the five IMPOSTOR_MUSHROOM_* layers exist in src/textures.js',
    missing.length === 0 ? IMPOSTOR_NAMES.map((k) => `${k.replace('IMPOSTOR_MUSHROOM_', '')}=${LAYER[k]}`).join(' ') : `missing ${missing.join(', ')}`)

  const layers = mushroomImpostorLayers()
  check(layers.length === MUSHROOM_NAMES.length && new Set(layers).size === layers.length,
    'mushroomImpostorLayers() is five distinct slices, one per species',
    `${layers.join(' ')} for ${MUSHROOM_NAMES.join(', ')}`)

  const over = layers.filter((n) => !(n < LAYER_COUNT))
  check(over.length === 0, 'and all five are inside LAYER_COUNT',
    over.length === 0 ? `< ${LAYER_COUNT}` : `${over.join(', ')} past ${LAYER_COUNT}`)

  // The mushroom's own non-impostor slices. The whole-registry collision sweep
  // is section 10's; this is the pair that would be easiest to get wrong,
  // because both halves are edited in the same file for the same prop.
  const sheets = [LAYER.MUSHROOM_CAP, LAYER.MUSHROOM_CAP_CAVE, LAYER.MUSHROOM_FLESH]
  const clash = layers.filter((n) => sheets.includes(n))
  check(clash.length === 0, 'and none of them collides with a mushroom sheet layer -- a card is not a cap texture',
    clash.length === 0 ? `impostors ${layers.join(' ')} vs sheets ${sheets.join(' ')}` : `${clash.join(', ')} in both`)

  // Every slot of the card tier: the geometry in slot i must wear the layer
  // that slot's SPECIES declared, and wear it on every vertex.
  let wrongLayer = null
  let varying = null
  let cardsChecked = 0
  VARIANTS.forEach((v, i) => {
    const arr = BANK.tiers[CARD_TIER].geometries[i].attributes.texLayer.array
    const want = MUSHROOM_SPECIES[v.species].impostorLayer
    cardsChecked++
    for (let k = 0; k < arr.length; k++) {
      if (arr[k] !== arr[0] && varying === null) {
        varying = `slot ${i} (${v.species}): vertex 0 is layer ${arr[0]}, vertex ${k} is ${arr[k]}`
      }
      if (arr[k] !== want && wrongLayer === null) {
        wrongLayer = `slot ${i} (${v.species}): layer ${arr[k]}, species declares ${want}`
      }
    }
  })
  check(varying === null, 'every card geometry addresses ONE layer across all its vertices',
    varying === null ? `${cardsChecked} tier-${CARD_TIER} slots` : varying)
  check(wrongLayer === null, 'and it is its own species\' layer',
    wrongLayer === null ? `${MUSHROOM_NAMES.length} photographs for ${VARIANTS.length} variants` : wrongLayer)

  // AND NO MESH TIER WEARS ONE, which is the other half of the same fact and
  // the thing section 13 leans on. `billboardLayers` selects by texLayer, so a
  // mesh that addressed an impostor slice would be spun toward the eye by the
  // vertex shader the moment its normal came up -- and a cap's apex normal IS
  // (0, 1, 0). The mesh tiers wear the cap and flesh sheets and nothing else.
  const impostors = new Set(mushroomImpostorLayers())
  let meshWearsCard = null
  for (let t = 0; t < CARD_TIER; t++) {
    VARIANTS.forEach((v, i) => {
      const arr = BANK.tiers[t].geometries[i].attributes.texLayer.array
      for (let k = 0; k < arr.length; k++) {
        if (impostors.has(arr[k]) && meshWearsCard === null) {
          meshWearsCard = `tier ${t} slot ${i} (${v.species}) vertex ${k}: layer ${arr[k]} is an impostor slice`
        }
      }
    })
  }
  check(meshWearsCard === null,
    'and no MESH tier wears an impostor layer, so the card tier is the only thing billboardLayers can select',
    meshWearsCard === null ? `${CARD_TIER} mesh tiers x ${VARIANTS.length} slots against impostors ${[...impostors].join(' ')}` : meshWearsCard)
}

// ---------------------------------------------------------------------------
// 13. THE CARD_UP_MARK CONDITION. This is the one that has no second line of
// defence.
//
// createPropMaterial is handed the five impostor layers as `billboardLayers`,
// and its vertex shader spins a card toward the eye when
//
//     texLayer is in the billboard list   AND   normal.y > CARD_UP_MARK
//
// Section 12 asserted both halves of the first test -- the card tier wears those
// layers and no mesh tier does. This is the second half, and between them they
// are the whole mechanism. There is no flag beside it and cannot be one:
// BatchedMesh fixes its attribute set from the first geometry into the arena, so
// a per-vertex `isBillboard` for this one prop means adding it to every
// generator in the project. That is why the spin rides on a value that already
// exists.
//
// WHAT FAILING LOOKS LIKE. A billboard that drops below the mark stops spinning,
// and a single fixed plane seen along its own plane covers no pixels at all.
// Every mushroom past 40 spans vanishes for a quarter of the compass and comes
// back -- and because the card band runs from there to the draw radius, that is
// most of the layer flickering as the player turns.
//
// THE MARK IS 0.99, a thin gap, and the thinness is inherited rather than needed
// here: the shared buildImpostorCard also authors CANOPY normals, which lean
// mostly up and top out around 0.88, and a TREE's fixed crossed tier wears the
// same impostor layer its billboard does with nothing but that gap holding it
// still. The mushroom ladder has no crossed tier, so nothing here leans on the
// gap -- but the mark is shared, and a mushroom card that wandered under it
// would be the failure above.
//
// (0,1,0) EXACTLY, not merely over the line. `upNormal` authors literal
// (0, 1, 0) and the attribute is read in the shader before anything transforms
// it, so exact is what is available and exact is what is asserted. 1e-5 is
// float32 slack on a value that is stored as 1.0.
//
// buildImpostorCard asserts this too, at the moment it authors the normals. That
// assert is on the SHARED helper and phrased in terms of the flags it was
// passed; this one is on the mushroom bank's own output and phrased in terms of
// the tier. They fail on different edits: dropping `upNormal: true` trips both,
// but handing a mesh tier's geometry to the card tier's slot trips only this
// one.
//
// CALIBRATED BY BREAKING IT: with `upNormal: true` dropped from the card call in
// mushroom-bank.js -- which buildImpostorCard accepts without complaint, since a
// plane normal's y is 0 and 0 is on the correct side of the mark for a card that
// claims not to be a billboard -- this reports `tier 2 slot 0 (fly agaric)
// vertex 0: normal (0.00000, 0.00000, 1.00000), 1.41e+0 off (0,1,0)`, and every
// distant mushroom stops turning. Restored byte for byte afterwards.
// ---------------------------------------------------------------------------

console.log('\nbillboard marker')

{
  let notUp = null
  let upVerts = 0

  VARIANTS.forEach((v, i) => {
    const nb = BANK.tiers[CARD_TIER].geometries[i].attributes.normal.array
    for (let k = 0; k < nb.length; k += 3) {
      upVerts++
      const off = Math.hypot(nb[k], nb[k + 1] - 1, nb[k + 2])
      if ((!(nb[k + 1] >= CARD_UP_MARK) || off > 1e-5) && notUp === null) {
        notUp = `tier ${CARD_TIER} slot ${i} (${v.species}) vertex ${k / 3}: normal (${nb[k].toFixed(5)}, ${nb[k + 1].toFixed(5)}, ${nb[k + 2].toFixed(5)}), ${off.toExponential(2)} off (0,1,0) and CARD_UP_MARK is ${CARD_UP_MARK}`
      }
    }
  })

  check(notUp === null, `every tier-${CARD_TIER} vertex normal is exactly (0,1,0), so the shader spins the billboard`,
    notUp === null ? `${upVerts} normals over ${VARIANTS.length} slots, all within 1e-5 of up` : notUp)
}

for (const g of DISTINCT) g.dispose()

// ---------------------------------------------------------------------------
// 14. The apex-down billboard really is the better triangle.
//
// MUSHROOM_BILLBOARD_TRI is 'down', and the comment on it in mushroom-bank.js
// quotes a measured table and says THIS SCRIPT gates it. So it has to.
//
// THE MEASUREMENT. Each species' LOD0 mesh is rasterised orthographically into
// its OWN `{spread x height}` frame -- the same frame bakeImpostor photographs
// it in, which is what makes the pixel fractions below comparable to what the
// card will really keep -- and the covered pixels are counted against each of
// the two inscribed triangles buildImpostorCard can author. The subject is the
// shape-0, size-1.0 build AT THE BANK'S OWN SEED, because that is exactly what
// `cardFrame` hands the bake: the card is a photograph of this mushroom and of
// no other, so measuring the silhouette of any other build would be measuring
// something no card ever shows.
//
// WHAT IS ASSERTED IS THE CLAIM, NOT THE DECIMALS. The numbers move with the
// bank seed -- the wavy rim and the lobe phase are seeded -- so pinning
// `parasol === 93.7` would make this gate fail on a change that has nothing to
// do with it, which is the fastest way to get a gate deleted. What the choice
// of 'down' actually rests on is two things that are stable across seeds and
// across reasonable presets: apex-down BEATS apex-up on every species by a wide
// margin, and apex-down keeps most of the prop in absolute terms. Those are the
// two bounds. The table is printed so a reader can see the real numbers drift
// and judge whether the margin is thinning, which is the thing that would
// actually warn them.
//
// PORCINI IS THE SPECIES TO WATCH and the bank says so: a bolete is a bun on a
// BARREL, so the widest part of its silhouette near the ground is real stem and
// not empty air, and an apex-down triangle clips exactly that. It sits nearest
// both bounds. A future preset fatter in the stem than in the cap is the one
// that would push through them.
// ---------------------------------------------------------------------------

console.log('\nbillboard silhouette')

const RES = 128

// Rasterise the mesh into a RES x RES coverage grid over its own extents.
// Scanline-free and unclipped on purpose: a bounding-box loop with a barycentric
// inside-test is short enough to read, and at 128^2 over 45 triangles the cost
// does not matter.
function silhouette(geo) {
  const pos = geo.attributes.position.array
  const idx = geo.index.array
  const u = geo.userData.mushroom
  const halfW = u.spread / 2
  const grid = new Uint8Array(RES * RES)
  const px = (x) => ((x + halfW) / u.spread) * RES
  const py = (y) => (y / u.height) * RES
  for (let f = 0; f < idx.length; f += 3) {
    const ax = px(pos[idx[f] * 3]), ay = py(pos[idx[f] * 3 + 1])
    const bx = px(pos[idx[f + 1] * 3]), by = py(pos[idx[f + 1] * 3 + 1])
    const cx = px(pos[idx[f + 2] * 3]), cy = py(pos[idx[f + 2] * 3 + 1])
    const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxx = Math.min(RES - 1, Math.ceil(Math.max(ax, bx, cx)))
    const miny = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxy = Math.min(RES - 1, Math.ceil(Math.max(ay, by, cy)))
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(d) < 1e-12) continue
    for (let iy = miny; iy <= maxy; iy++) {
      for (let ix = minx; ix <= maxx; ix++) {
        const qx = ix + 0.5, qy = iy + 0.5
        const w0 = ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax)) / d
        const w1 = ((qx - ax) * (cy - ay) - (qy - ay) * (cx - ax)) / d
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue
        grid[iy * RES + ix] = 1
      }
    }
  }
  return grid
}

// The fraction of covered pixels the inscribed triangle keeps. Both triangles
// are symmetric about u = 0.5 -- billboardVertex's per-instance u-flip requires
// it -- so the half-width at a given height is all there is to test.
function coverage(grid, tri) {
  let covered = 0, kept = 0
  for (let iy = 0; iy < RES; iy++) for (let ix = 0; ix < RES; ix++) {
    if (!grid[iy * RES + ix]) continue
    covered++
    const fy = (iy + 0.5) / RES, fx = (ix + 0.5) / RES
    const half = tri === 'down' ? fy / 2 : (1 - fy) / 2
    if (Math.abs(fx - 0.5) <= half) kept++
  }
  return covered === 0 ? 0 : kept / covered
}

// The five subjects the cards are photographed from: the species' one variant,
// at the bank's own seed. Built here rather than taken out of BANK.tiers[0],
// because the bank seeds each variant slot `seed + i * 101` while `cardFrame`
// -- and therefore the bake -- uses `seed` bare.
const SUBJECTS = MUSHROOM_NAMES.map((species) => {
  const v = VARIANTS.find((x) => x.species === species)
  if (!v) throw new Error(`no variant for ${species}`)
  return { species, geo: buildMushroom(mushroomParams(v, BANK_SEED)) }
})

const TRI_MARGIN = 15
const TRI_FLOOR = 70

{
  const rows = SUBJECTS.map(({ species, geo }) => {
    const grid = silhouette(geo)
    return {
      species,
      down: coverage(grid, 'down') * 100,
      up: coverage(grid, 'up') * 100,
    }
  })
  rows.sort((a, b) => b.down - a.down)
  for (const r of rows) {
    console.log(`        ${r.species.padEnd(13)} apex-down ${r.down.toFixed(1).padStart(5)}%   apex-up ${r.up.toFixed(1).padStart(5)}%   margin ${(r.down - r.up).toFixed(1).padStart(5)}`)
  }

  check(MUSHROOM_BILLBOARD_TRI === 'down', "MUSHROOM_BILLBOARD_TRI is 'down', the triangle this section measures",
    `is '${MUSHROOM_BILLBOARD_TRI}'`)

  const beaten = rows.filter((r) => !(r.down - r.up >= TRI_MARGIN))
  const worstMargin = Math.min(...rows.map((r) => r.down - r.up))
  check(beaten.length === 0, `apex-down keeps more of every species than apex-up, by at least ${TRI_MARGIN} points`,
    beaten.length === 0 ? `narrowest margin ${worstMargin.toFixed(1)} points` : beaten.map((r) => `${r.species} only ${(r.down - r.up).toFixed(1)}`).join('; '))

  const thin = rows.filter((r) => !(r.down >= TRI_FLOOR))
  const worstDown = Math.min(...rows.map((r) => r.down))
  check(thin.length === 0, `and apex-down keeps at least ${TRI_FLOOR}% of every species' silhouette in absolute terms`,
    thin.length === 0 ? `worst ${worstDown.toFixed(1)}%` : thin.map((r) => `${r.species} only ${r.down.toFixed(1)}%`).join('; '))
}

// ---------------------------------------------------------------------------
// 15. The card comes in later than the parallax rule allows, for EVERY variant.
//
// DESIGN.md §5's rule is `crossover = depth x 28.6` -- the range past which a
// flat card's failure to turn stays under 2 degrees -- and for a mushroom the
// depth IS the spread, because a cap is as deep as it is wide.
//
// The bands are multiples of a variant's SPAN now, and span is max(height,
// spread), so the rule reduces to pure arithmetic on the band table: the first
// flat tier starts at `span x MUSHROOM_LOD_SPANS[k]`, span >= spread, therefore
// the card cannot arrive before `spread x MUSHROOM_LOD_SPANS[k]`. That holds for
// every variant at every size at once, which is why this section no longer
// enumerates species to find a binding case -- there is not one.
//
// WHAT IS STILL WORTH GATING is the pair of design choices that reduction rests
// on, because both are one edit away from being false:
//
//   - the band the card starts at is at least 28.6, so the multiple itself
//     satisfies §5. Drop it to 20 and every mushroom in the world cards early.
//   - `span` really is the max and not the height. Under height-relative bands
//     the chanterelle at capRise -0.02 is 1.86x wider than tall, so 40 of its
//     heights is 21.5 of its spreads and its card would come in at 75% of the
//     honest range. The per-variant ratio is measured here and printed, and the
//     assertion is that the max covers the worst of them.
//
// The metre distances are printed rather than asserted, for section 14's
// reason: `spread` comes off a seeded build and moves with the seed.
// ---------------------------------------------------------------------------

console.log('\ndistance bands')

const PARALLAX = 28.6

{
  // The first tier that is a flat card: the mesh tiers come first, so the band
  // that governs entry to it is the one before it in the table.
  const cardBand = MUSHROOM_LOD_SPANS[MUSHROOM_MESH_RADIAL.length - 1]

  check(cardBand >= PARALLAX,
    `the card tier starts at ${cardBand} spans, which is at least the ${PARALLAX} spans §5's parallax rule demands`,
    `MUSHROOM_LOD_SPANS = [${MUSHROOM_LOD_SPANS.join(', ')}], mesh tiers ${MUSHROOM_MESH_RADIAL.length}, so the card starts at index ${MUSHROOM_MESH_RADIAL.length - 1}`)

  // Every variant, not the five photographed subjects: `spread / height` moves
  // with the shape multipliers, and shape 4 of the chanterelle is 60% flatter
  // than shape 0 of it.
  const rows = VARIANTS.map((v, i) => {
    const geo = buildMushroom(mushroomParams(v, BANK_SEED + i * 101))
    const u = geo.userData.mushroom
    geo.dispose()
    return {
      species: v.species,
      height: u.height,
      spread: u.spread,
      span: Math.max(u.height, u.spread),
    }
  })

  const bySpecies = new Map()
  for (const r of rows) {
    const cur = bySpecies.get(r.species)
    if (!cur || r.spread / r.height > cur.spread / cur.height) bySpecies.set(r.species, r)
  }
  for (const r of bySpecies.values()) {
    const needs = (r.spread / r.height) * PARALLAX
    console.log(`        ${r.species.padEnd(13)} flattest: spread ${r.spread.toFixed(3)} / height ${r.height.toFixed(3)} = ${(r.spread / r.height).toFixed(2)}   ${needs.toFixed(1)} heights but ${((r.spread / r.span) * PARALLAX).toFixed(1)} spans`)
  }

  const flattest = [...rows].sort((a, b) => b.spread / b.height - a.spread / a.height)[0]
  check((flattest.spread / flattest.height) * PARALLAX > cardBand,
    'and the max in max(height, spread) is load-bearing -- the flattest variant would break a height-relative table of the same numbers',
    `${flattest.species} needs ${((flattest.spread / flattest.height) * PARALLAX).toFixed(1)} heights against a band of ${cardBand}`)

  const short = rows.filter((r) => !(r.span * cardBand >= r.spread * PARALLAX))
  check(short.length === 0,
    `so every one of the ${rows.length} variants gets its card no closer than spread x ${PARALLAX}`,
    short.length === 0
      ? `tightest ${flattest.species}: card at ${(flattest.span * cardBand).toFixed(1)} m, rule wants ${(flattest.spread * PARALLAX).toFixed(1)} m`
      : short.map((r) => r.species).join('; '))

  // The far end of the same table against the scatter's own draw radius. The
  // billboard tier has to START inside the radius or it is a tier nothing is
  // ever drawn in, and the biggest variant in the bank is the one that gets
  // there last.
  const src = readFileSync(new URL('../src/v2/render/mushrooms.js', import.meta.url), 'utf8')
  const dm = src.match(/^const DRAW_RADIUS = ([0-9.]+)/m)
  if (!dm) {
    throw new Error('check-mushrooms: no `const DRAW_RADIUS = ...` in src/v2/render/mushrooms.js -- this section can no longer read the radius it gates')
  }
  const jm = src.match(/^const SIZE_JITTER = \[([^\]]*)\]/m)
  if (!jm) {
    throw new Error('check-mushrooms: no `const SIZE_JITTER = [...]` in src/v2/render/mushrooms.js -- this section can no longer read the jitter it gates')
  }
  const drawRadius = Number(dm[1])
  const maxJitter = Math.max(...jm[1].split(',').map((s) => Number(s.trim())))
  const lastBand = MUSHROOM_LOD_SPANS[MUSHROOM_LOD_SPANS.length - 1]
  const biggest = [...rows].sort((a, b) => b.span - a.span)[0]
  const billboardAt = biggest.span * maxJitter * lastBand
  check(billboardAt < drawRadius,
    'and the billboard tier starts inside the draw radius even for the biggest thing the bank can grow',
    `${biggest.species} spans ${biggest.span.toFixed(3)} m x ${maxJitter} jitter x ${lastBand} = ${billboardAt.toFixed(1)} m, draw radius ${drawRadius} m`)
}

for (const s of SUBJECTS) s.geo.dispose()

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all mushroom checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
