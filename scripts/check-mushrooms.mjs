// Node-side gates for the procedural mushrooms (src/props/mushroom.js and
// src/props/mushroom-texture.js).
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

import { MUSHROOM_DEFAULTS, buildMushroom, mushroomTriangles } from '../src/props/mushroom.js'
import {
  mushroomCapSheet, mushroomCaveSheet, mushroomFleshSheet, MUSHROOM_CELL_PX,
  capCell, fleshCell, CAP_FOREST, CAP_CAVE, FLESH,
} from '../src/props/mushroom-texture.js'
import { LAYER, LAYER_COUNT } from '../src/textures.js'

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
const SHAPES = [
  { name: 'default', over: {} },
  { name: 'fly agaric', over: { radial: 10, capRings: 3, underRings: 2, ring: 0.55, bulb: 0.4, capCell: 1, fleshCell: 0 } },
  { name: 'button', over: { radial: 6, capRings: 2, underRings: 1, inroll: 0.5, capRise: 0.34, margin: -0.03, umbo: 0.05 } },
  { name: 'parasol', over: { radial: 12, capRings: 3, capCurve: 5.5, capRise: 0.14, ring: 0.4, stemRings: 4, stemCurve: 0.3, capCell: 2, fleshCell: 3 } },
  { name: 'funnel', over: { capRise: -0.18, capCurve: 1.6, wavy: 0.22, lobes: 5, underRings: 2, capCell: 3, fleshCell: 2 } },
  { name: 'cave giant', over: { height: 3, radial: 14, capRings: 3, underRings: 3, stemRings: 5, gillBlades: 24, ring: 0.7, capLayer: LAYER.MUSHROOM_CAP_CAVE, capCell: 1, fleshCell: 3 } },
  { name: 'no underside', over: { underside: false, radial: 5, capRings: 1, stemRings: 1 } },
  { name: 'blades, no ring', over: { gillBlades: 12, ring: 0, radial: 9, underRings: 2 } },
  { name: 'ring, no blades', over: { gillBlades: 0, ring: 0.8, radial: 9 } },
  { name: 'leaning', over: { lean: 0.35, stemCurve: 0.5, stemRings: 4, stemTaper: -0.4, capTilt: 0.12 } },
  { name: 'troop', over: { cluster: 6, clusterSpread: 0.7, radial: 7, ring: 0.3 } },
  // stemHeight 0 is the bracket fungus: no stem block, no ring block, and the
  // cap attaches at y = 0 instead of riding a frame.
  { name: 'bracket', over: { stemHeight: 0, capTilt: 0.5, sweep: Math.PI, capRadius: 0.6, gillBlades: 6 } },
  { name: 'troop of brackets', over: { cluster: 3, stemHeight: 0, gillBlades: 5, radial: 6 } },
]

console.log(`\n=== mushroom checks, ${SHAPES.length} shapes ===\n`)

// ---------------------------------------------------------------------------
// The vertex layout, transcribed from addMushroom's emission order.
//
// Sections 4, 5 and 6 all need to know WHICH SURFACE a vertex belongs to, and
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
  const grid = (name, rows, wraps) => {
    blocks.push({ name, first: at, rows, cols, verts: rows * (cols + 1), wraps })
    at += rows * (cols + 1)
  }

  grid('cap', capRings + 1, closed)
  if (p.underside) grid('underside', underRings + 1, closed)
  if (blades > 0 && p.underside) {
    blocks.push({ name: 'blades', first: at, rows: 0, cols: 0, verts: blades * 4, wraps: false })
    at += blades * 4
  }
  if (hasStem) grid('stem', stemRings + 1, true)
  if (hasStem && p.ring > 1e-4) grid('ring', 2, true)

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
  check(unindexed === 0, 'every geometry is indexed (BatchedMesh refuses otherwise)', `${unindexed} not`)
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
// 4. The winding agrees with the normals.
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
// 5. No polar seam.
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
// 6. Every UV stays inside the cell it declared.
//
// The sheets are a 2x2 grid of 64 px cells in a 128 px layer and mushroom.js
// insets by one texel on every side, so a legal UV lives in
// [cell + 1/128, cell + 1/2 - 1/128]. A UV outside that does not fail -- it
// samples the NEIGHBOURING mushroom, which is a hairline of the wrong colour
// round the rim of every cap that wears the cell. Which cell a vertex should be
// in is decided by its `texLayer`: the cap sheet takes `capCell`, and the flesh
// sheet -- underside, gill blades, stem and ring alike -- takes `fleshCell`.
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
      const cx = (cell % SHEET_GRID) * CELL_UV
      const cy = Math.floor(cell / SHEET_GRID) * CELL_UV
      const u = uv[i * 2]
      const v = uv[i * 2 + 1]
      // 1e-6 for the float32 the attribute is stored as; the inset itself is
      // 1/128, four orders of magnitude larger, so this cannot mask an escape.
      const inU = u >= cx + INSET - 1e-6 && u <= cx + CELL_UV - INSET + 1e-6
      const inV = v >= cy + INSET - 1e-6 && v <= cy + CELL_UV - INSET + 1e-6
      if (!(inU && inV) && escaped === null) {
        escaped = `${shape.name} vertex ${i} (layer ${lay[i]}, cell ${cell}): uv ${u.toFixed(5)},${v.toFixed(5)} outside [${(cx + INSET).toFixed(5)}..${(cx + CELL_UV - INSET).toFixed(5)}] x [${(cy + INSET).toFixed(5)}..${(cy + CELL_UV - INSET).toFixed(5)}]`
      }
      verts++
    }
    geo.dispose()
  }
  check(unknownLayer === null, 'every vertex wears either the cap layer or the flesh layer',
    unknownLayer === null ? '' : unknownLayer)
  check(escaped === null, 'every uvProj lies inside its own inset cell',
    escaped === null ? `${verts} vertices, ${cellsSeen.size} distinct (layer, cell) pairs` : escaped)
  // A test that only ever exercised cell 0 would pass with the cell offset
  // dropped entirely, which is the one edit this section exists to catch.
  check(cellsSeen.size >= 4, 'and the spread of shapes actually addresses cells other than 0',
    [...cellsSeen].sort().join(' '))
}

// ---------------------------------------------------------------------------
// 7. The sheets are opaque.
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
// 8. Every cell closes across u.
//
// A cell's u axis is an ANGLE around the axis of revolution, so its leftmost and
// rightmost pixel columns are adjacent samples one texel apart on the real
// surface -- 1/64 of a turn. If they disagree, every cap wearing that cell has a
// meridian painted from apex to rim.
//
// THIS IS MEASURED OVER EIGHT SEEDS PER CELL, not over the one raster that ships,
// and that is the whole design of the gate. A single raster cannot answer the
// question: `scarlet`'s warts are hard white edges on red, and whether one of
// them happens to straddle u = 0 swings the measured wrap step from 0.33x to
// 1.03x of the cell's worst interior step -- across nothing but the seed. A
// threshold tight enough to catch a real break fails an unlucky wart; one loose
// enough to pass the wart catches nothing. Averaged over seeds the wart lands on
// the seam sometimes and not others, so the average reports the GENERATOR's
// periodicity instead of one roll of the dice. A genuinely non-periodic cell is
// broken at every seed and the average does not rescue it.
//
// Both bounds are scale-free -- ratios against the cell's own interior. An
// absolute byte threshold was tried first and had to go for the same reason:
// there is no byte count that separates a hard wart edge from a discontinuity.
//
//   VS THE WORST INTERIOR STEP, mean under 0.85. The wrap is 1 of 64 column
//   boundaries, so on a continuous cell it is rarely the worst; a discontinuity
//   almost always is. Real cells measure 0.01x to 0.72x.
//
//   VS THE MEDIAN INTERIOR STEP, mean under 1.7. Catches the cell that is smooth
//   nearly everywhere and has one hard interior edge, which would give the first
//   bound a large denominator to hide behind. Real cells measure 0.01x to 1.23x.
//
// CALIBRATION. Every cell was re-rendered with its wrap deliberately broken --
// 64 seamless columns resampled into 63, an unrelated column pasted at the join,
// interior left as smooth as it was. The two bounds together flag 7 of the 12
// while passing all 12 real cells at every seed. Stated rather than rounded up:
// the ones it misses vary slowly enough in u that a broken join barely moves any
// statistic. This gate is a guard against a coarse mistake, not a proof of
// periodicity -- the proof is structural, in wrapNoise's modulo lattice and in
// wrapDelta.
// ---------------------------------------------------------------------------

console.log('\nsheet seams')

const SEAM_VS_MAX = 0.85
const SEAM_VS_MEDIAN = 1.7
const SEAM_SEEDS = 8

function columnStep(px, w, x0, x1, oy, ox, cell) {
  // MEAN per-channel difference down two whole pixel columns, not the worst
  // single pixel. A seam is a line you see along its whole length, so the mean
  // is the statistic that matches the artefact; a max is dominated by whichever
  // single wart edge happens to cross the column, which is a feature of the art
  // rather than a discontinuity in it.
  let sum = 0
  for (let y = 0; y < cell; y++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(px[((oy + y) * w + ox + x0) * 4 + c] - px[((oy + y) * w + ox + x1) * 4 + c])
    }
  }
  return sum / (cell * 3)
}

function seamRatios(px) {
  const N = MUSHROOM_CELL_PX
  const steps = []
  for (let x = 0; x < N - 1; x++) steps.push(columnStep(px, N, x, x + 1, 0, 0, N))
  steps.sort((a, b) => a - b)
  const seam = columnStep(px, N, N - 1, 0, 0, 0, N)
  // Floored, so a cell that is flat down some column cannot divide by ~0 and
  // report an infinite ratio on a difference nobody could see.
  return {
    seam,
    vsMax: seam / Math.max(0.5, steps[steps.length - 1]),
    vsMedian: seam / Math.max(0.5, steps[steps.length >> 1]),
  }
}

for (const [name, specs, render] of [
  ['cap (forest)', CAP_FOREST, capCell],
  ['cap (cave)', CAP_CAVE, capCell],
  ['flesh', FLESH, fleshCell],
]) {
  let bad = null
  let worstMax = 0
  let worstMed = 0
  for (const spec of specs) {
    let sumMax = 0
    let sumMed = 0
    let shipped = 0
    for (let k = 0; k < SEAM_SEEDS; k++) {
      const r = seamRatios(render({ ...spec, seed: spec.seed + k * 7 }))
      sumMax += r.vsMax
      sumMed += r.vsMedian
      if (k === 0) shipped = r.seam
    }
    const vsMax = sumMax / SEAM_SEEDS
    const vsMed = sumMed / SEAM_SEEDS
    if (vsMax > worstMax) worstMax = vsMax
    if (vsMed > worstMed) worstMed = vsMed
    if ((vsMax > SEAM_VS_MAX || vsMed > SEAM_VS_MEDIAN) && bad === null) {
      bad = `${spec.name}: over ${SEAM_SEEDS} seeds the wrap step averages ${vsMax.toFixed(2)}x the worst interior step and ${vsMed.toFixed(2)}x the median (shipped seed's wrap step ${shipped.toFixed(1)}/255)`
    }
  }
  check(bad === null, `the ${name} sheet closes across u in all ${specs.length} cells`,
    bad === null ? `over ${SEAM_SEEDS} seeds each: worst mean ${worstMax.toFixed(2)}x the worst interior step, ${worstMed.toFixed(2)}x the median` : bad)
}

// And the packing is not scrambling them: whatever the generator produced has
// to be what lands in the sheet, or every measurement above is of a cell nobody
// ever samples.
{
  const SHEET_W = MUSHROOM_CELL_PX * SHEET_GRID
  let mismatch = null
  let compared = 0
  for (const [name, specs, render, sheet] of [
    ['cap (forest)', CAP_FOREST, capCell, mushroomCapSheet()],
    ['cap (cave)', CAP_CAVE, capCell, mushroomCaveSheet()],
    ['flesh', FLESH, fleshCell, mushroomFleshSheet()],
  ]) {
    specs.forEach((spec, cell) => {
      const px = render(spec)
      const ox = (cell % SHEET_GRID) * MUSHROOM_CELL_PX
      const oy = Math.floor(cell / SHEET_GRID) * MUSHROOM_CELL_PX
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
  check(mismatch === null, 'and pack() puts each cell where its cellUV says it is',
    mismatch === null ? `${(compared / 1024).toFixed(0)}k bytes compared, 12 cells` : mismatch)
}

// ---------------------------------------------------------------------------
// 9. The layer registry.
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

console.log(`\n${failures === 0 ? 'all mushroom checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
