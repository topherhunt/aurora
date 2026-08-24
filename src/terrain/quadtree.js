import { WORLD_SIZE, WORLD_HALF } from '../sim/terrain-height.js'
import { CHUNK_RES } from '../sim/chunk-mesh.js'

// ---------------------------------------------------------------------------
// Quadtree LOD selection (DESIGN.md §5).
//
// ONE RULE, ONE KNOB, ONE UNIT:
//
//   split while  cell > range * tan(TRI_DEG)
//
//   cell   the node's grid spacing, size / CHUNK_RES, in metres
//   range  distance from the eye to the node's bounding box, in 3D, in metres
//
// A length over a range is an angle, so the rule reads straight off the screen:
// REFINE UNTIL NO TRIANGLE LOOKS BIGGER THAN TRI_DEG DEGREES. That is the whole
// LOD policy. It gives every visible triangle, underfoot or on the horizon, the
// same angular size -- which is exactly what "consistent screen-relative
// resolution" means, and it is bounded by construction rather than on average.
//
// WHAT IS DELIBERATELY ABSENT, because it was built, measured and removed:
//
// The obvious next move is a per-node GEOMETRIC ERROR -- mesh each chunk, measure
// how far it departs from the height field, and spend triangles where the shape
// is genuinely wrong instead of spreading them evenly. That is the textbook
// chunked-LOD rule and it was implemented here in full, including the worker
// plumbing and the monotonicity repair a top-down descent needs.
//
// It does not pay, and the reason is a property of this terrain rather than a
// property of the technique. The height field is fbm, so its roughness is
// SCALE-INVARIANT: error per cell holds near 0.45 at the median across node
// sizes from 4 km down to 256 m, then FALLS to 0.16 by 32 m
// (scripts/probe-error.mjs). Error is therefore proportional to cell size over
// the range that matters and sub-proportional below it, which means a cell-size
// cap already IS an error cap -- conservatively so at the fine end -- and
// measuring the error re-derives what the geometry already guarantees.
//
// Priced at matched worst-case slot cost over 60 cameras (scripts/probe-lod.mjs),
// with the error term capped at 1.0 m so the two rules cost the same slots:
//
//                            leaf~  leafMAX   err p90   err p99   tri p90  triMAX
//   error term + 1.3 cap      477      622     0.595     0.946      1.06    1.30
//   plain 1.2 cap             489      580     0.547     1.101      1.00    1.20
//
// The plain cap wins worst-case slots, mean error and both triangle numbers, and
// loses only the error tail -- one leaf in a hundred, and one outlier. That is
// not worth 256 extra heightAt calls per chunk (~70% of the mesh cost), a field
// on every worker message, a learned per-node table, and a monotonicity
// invariant that has to hold or a coarse ancestor silently vetoes detail
// underneath it. If the terrain ever grows features that are rough at one scale
// and smooth at another -- cliffs, erosion channels, anything non-fractal -- this
// conclusion flips, and the measurement to re-run is in probe-lod.mjs.
//
// WHAT THIS REPLACES, because the correction is the point. The previous rule was
// a raw distance test, `boxDistance < size * splitK`, plus an ELEVATION BIAS
// that multiplied splitK per node by up to 3.4x or down to 0.30x according to
// how high that node's MEAN ground was relative to other nodes of its size. It
// was applied at depths 3-6 -- 2048 m, 1024 m, 512 m and 256 m squares -- and it
// produced exactly the artifact you would predict from that granularity:
// measured over 240 camera positions, a 1024 m quadrant 401 m away drawn at
// 9.14 deg per cell while a 256 m node five times further out was drawn at 0.44.
// Whole quadrants of near ground coarser than far ground, with a hard seam.
//
// It failed for two structural reasons, not for want of tuning:
//
//   1. It was a HIERARCHICAL GATE. A 1024 m quadrant whose mean sat below the
//      pivot never descended, so every summit inside it was pinned at 64 m
//      cells no matter how tall. Detail was vetoed by an ancestor that could not
//      possibly know what it contained -- the file's own comment measured that
//      signal at 0.15 and shipped anyway.
//
//   2. It keyed on the WRONG QUANTITY. Elevation is a proxy for "needs
//      triangles"; geometric error is the thing itself. Measured correlation
//      between a node's mean elevation and its actual error (probe-error.mjs):
//
//        depth 3 (2048 m): 0.16      depth 7 (128 m): 0.70
//        depth 4 (1024 m): 0.16      depth 8 ( 64 m): 0.68
//        depth 5 ( 512 m): 0.43      depth 9 ( 32 m): 0.63
//
//      The bias put its strongest swing at depths 3-5 and exactly zero from
//      depth 7 in. It was strongest where the signal is 0.16 and absent where
//      the signal is 0.70 -- upside down against its own premise.
//
//   Measured over 60 cameras, half of them airborne, against the rule below:
//
//                        leaf~  leafMAX   tri p90   triMAX   angular inversions
//     elevation bias      259      325      2.51      9.22        30.8%
//     this file           489      580      1.00      1.20        12.1%
//
//   "Angular inversion" is the reported artifact stated as a number: nearer
//   ground drawn BLOCKIER than ground at least 1.5x further away. Note that a
//   nearer leaf being physically LARGER is not a defect -- that is what LOD is --
//   so the metric is in degrees, not metres.
//
//   The 9.22 deg worst case is the complaint itself: a 1024 m quadrant 398 m from
//   the camera,its triangles twenty times coarser, sitting next to a 256 m node
//   five times further out drawn at 0.44 deg.
//
export const MAX_DEPTH = 10 // 16384 m root / 2^10 = 16 m leaves

// ---------------------------------------------------------------------------
// THE KNOB. The largest a triangle is ever allowed to look, in degrees.
//
// Mutable so the tuning panel and the [ ] keys can move it live; selection reads
// it every frame, so a change lands on the next one with no regeneration.
//
// The stated goal was 1.0 -- "no visible triangle wider than a degree", about a
// thumbnail at arm's length. 1.2 ships instead, and the gap is a slot-pool
// decision rather than a modelling one, so it is worth being precise about.
//
// The current selection is exempt from eviction (terrain.js _evict skips
// anything in _render), so the WORST-CASE leaf count has to fit in SLOT_COUNT
// alongside the 21 pinned base-layer chunks -- and overrunning it THROWS rather
// than degrading. Measured over 605 positions x 4 headings, half of them
// airborne (check-sim.mjs "quadtree LOD budget"):
//
//     cap    worst selection   + 21 pinned   fits 768?   drawn tris
//    1.0          814              835          no          301k
//    1.1          766              787          no          264k
//    1.2          610              631         yes          237k
//    1.3          577              598         yes          210k
//
// So 1.2 is not a preference, it is the floor of what this pool can hold, which
// is why MIN_TRI_DEG sits there too: a knob whose range includes values that
// cannot work is a knob that fails late and in the headset.
//
// The lever that WOULD buy the stated 1.0 is not this knob but VIEW_HALF_ANGLE.
// 45% of the selection sits in the streaming margin outside the 110 deg eye cone
// and is culled per-instance by the GPU, so narrowing the margin is nearly free
// in drawn triangles and pays for itself in slots:
//
//     margin    cap 1.0    cap 1.1    cap 1.2
//     90 deg      835        787        631
//     80 deg      742        655        592
//     70 deg      673        616        541
//
// At an 80 deg margin a 1.1 cap fits with 65 slots to spare. What it costs is
// 10 degrees of margin, and the failure mode is not a hole -- out-of-cone nodes
// are still emitted, just coarse -- but briefly low-poly terrain at the edge of
// vision during a fast head turn. That is a judgement about peripheral vision in
// a headset and cannot be settled from a Node script, so it is left as a lever
// rather than taken. Raising SLOT_COUNT is the other one, and that is a
// device-memory question.
// ---------------------------------------------------------------------------
export const LOD = {
  // The widest triangle allowed inside the view cone, in degrees. This is the
  // whole LOD system: one number, meaning what it says.
  //
  // 5.72 is a Quest 2 number, not a quality preference. At 1.2 the ground alone
  // draws 237k triangles worst case -- 68% of the 350k device budget for a world
  // containing nothing but terrain. The ladder, measured over 606 positions x 4
  // headings in scripts/probe-trideg.mjs:
  //
  //     1.2 -> 237k (68%)     2.2 -> 113k (32%)     5.72 -> 45k (13%)
  //
  // 5.72 was chosen by eye with the [ ] keys and then measured, which is the
  // right order for this knob. It is chunky and it is meant to be.
  triDeg: 5.72,

  // What the same rule targets OUTSIDE the cone. This is a resolution, not a
  // switch -- peripheral ground still refines, just coarsely -- and getting that
  // distinction wrong was a shipped bug worth recording.
  //
  // The first version of the cull stopped descent entirely at the first node
  // that failed the view test. That is far coarser than it sounds: the test
  // fails at whatever depth the cone edge happens to cut, typically 2 or 3, so
  // ground behind the player was cached at 256 m per cell. Turning towards it
  // then asked for depth 8, the only loaded ancestor was that depth-2 leaf, and
  // terrain.js drew it as a stand-in -- a 4 km chunk whose triangles are 256 m
  // across. That is the "big flat facet for a split second" that got reported.
  //
  // scripts/probe-popping.mjs measures it as the angular size of the largest
  // triangle actually drawn, which is the same quantity this file caps, so the
  // steady-state guarantee and the streaming failure are on one scale:
  //
  //                             worst triangle drawn   frames over 2x the cap
  //   binary cull, panning              4.4 deg               16 / 60
  //   graded cull, panning              1.2 deg                0 / 60
  //
  // Panning is the case with no excuse: turning the head moves nothing and
  // changes no node's range, so everything the new heading wants was already the
  // right answer a moment ago. Refining the periphery to a coarse target keeps
  // it that way -- a node waiting behind the player now sits within a level or
  // two of what turning will ask for, so the stand-in is nearly right instead of
  // nearly flat.
  //
  // This is CLAMPED UP to triDeg at the point of use, because a periphery finer
  // than the cone is meaningless. At the shipped 5.72 cap the clamp binds and
  // the grading does nothing -- peripheral ground gets the same target as the
  // cone, which is the better outcome anyway now that the worst-case selection
  // is 163 slots against a pool of 768. The grading resumes on its own if the
  // knob is taken back below 5.
  //
  // 5 degrees is the number the terrain was specified with, and it is affordable
  // because the periphery is cheap in exactly the way the cone is expensive:
  // going from no cull to a 5 degree periphery drops the worst-case selection
  // from 937 leaves to 643, which is the difference between overflowing the slot
  // pool and fitting in it with room spare.
  periphDeg: 5.0,

  cull: true,
}


// The usable band, and BOTH ends are hard walls rather than taste.
//
// FLOOR: 1.2 is as fine as the slot pool goes (see above) -- the current
// selection is exempt from eviction, so a finer setting throws rather than
// degrading. The default no longer sits on the floor, so the knob now refines as
// well as coarsens, but it still cannot reach a value that cannot work.
//
// CEILING: at 7.125 degrees terrain LOD stops existing. Range is floored at a
// node's own half-size, so for any node containing the camera the split test is
//
//     cell / range  =  (size / CHUNK_RES) / (size / 2)  =  2 / CHUNK_RES  =  1/8
//
// -- independent of size, so it either splits every such node or none of them.
// tan(7.125 deg) = 0.125, and one step past it the root stops subdividing and
// the entire 16 km world draws as a single chunk with 1 km triangles. Measured:
// 7.0 deg gives 59 drawn leaves, 7.2 gives 1. This ceiling is a function of
// CHUNK_RES and moves if that does.
export const MIN_TRI_DEG = 1.2
export const MAX_TRI_DEG = 7.0


// Half-angle of the cone treated as "she can see this", in radians.
//
// Quest 3 is ~110 degrees horizontal, so 55 would be the honest frustum. This is
// 90 -- a full forward hemisphere -- and the extra 35 degrees are not timidity,
// they are the streaming margin. Selection runs at 12 Hz, so a 200 deg/s head
// turn moves 17 degrees between selections and the margin is worth about two
// seconds of it. Chunks that leave the cone stay in the LRU cache and come back
// visible without a worker round trip (terrain.js), so the margin only has to
// cover ground that was never loaded at all.
//
// It is also why nodes outside the cone are emitted as coarse leaves rather than
// dropped: turning further than the margin should find low-poly ground, never
// sky. Measured cost of the whole scheme is in check-sim.mjs section 5.
export const VIEW_HALF_ANGLE = (90 * Math.PI) / 180
// Half the horizontal field the headset actually renders. Not a tuning knob --
// it describes the hardware, and it is here so that "drawn" can be counted.
export const EYE_HALF_ANGLE = (55 * Math.PI) / 180

export function nodeKey(depth, ix, iz) {
  return `${depth}|${ix}|${iz}`
}

export function parentKey(depth, ix, iz) {
  if (depth === 0) return null
  return nodeKey(depth - 1, ix >> 1, iz >> 1)
}

// Distance from the eye to the node's bounding box.
//
// The Y term is why this is not the old boxDistance. That one measured
// horizontally and terrain.update() was never even given the camera's altitude,
// so at 500 m up, ground 100 m away on the map -- 510 m away in fact -- was
// tessellated as though she could touch it. That is a 5x over-refinement of
// everything directly below, which is most of what is on screen when flying, and
// it is the second half of why the reported artifact was worst from the air.
//
// `info` is what the mesher learned about this node's vertical extent, and is
// absent until the chunk has been built once. Without it the test falls back to
// the horizontal distance, which over-estimates how close the node is and
// therefore over-refines: the conservative direction, and the same answer the
// old rule gave.
// Exported so probes measure range the way the selection does. A probe that
// reimplements this is measuring a renderer that does not exist -- and one that
// used the horizontal distance made ground under a flying camera look infinitely
// under-refined, because it is ~0 m away on the map and 300 m away in fact.
export function nodeRange(cam, x, z, size, info) {
  const dx = Math.max(x - cam.x, 0, cam.x - (x + size))
  const dz = Math.max(z - cam.z, 0, cam.z - (z + size))
  if (!info || cam.y === undefined) return Math.hypot(dx, dz)
  const dy = Math.max(info.minY - cam.y, 0, cam.y - info.maxY)
  return Math.hypot(dx, dy, dz)
}

// Is any part of this node inside the view cone? Conservative in both directions
// that matter: a node containing the camera always passes, and a node is widened
// by the angle it subtends so a big one straddling the edge is never cut.
//
// The half-angle is a parameter because two different cones matter and confusing
// them is expensive. VIEW_HALF_ANGLE is the STREAMING cone -- deliberately wider
// than anyone can see, so terrain is resident before it is looked at. EYE_HALF_ANGLE
// is what is actually drawn, because BatchedMesh culls the rest per instance.
// Counting the streaming cone's triangles as drawn overstates the ground's share
// of the frame by about 70%.
export function inCone(cam, x, z, size, halfAngle) {
  const cx = x + size / 2
  const cz = z + size / 2
  if (Math.abs(cam.x - cx) <= size / 2 && Math.abs(cam.z - cz) <= size / 2) return true
  const dx = cx - cam.x
  const dz = cz - cam.z
  const dist = Math.hypot(dx, dz)
  // Half-diagonal over range: the angular half-width of the node itself.
  const spread = Math.atan2(size * 0.71, Math.max(dist, 1))
  let d = Math.atan2(dx, dz) - cam.yaw
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return Math.abs(d) <= halfAngle + spread
}

const inView = (cam, x, z, size) => inCone(cam, x, z, size, VIEW_HALF_ANGLE)

/**
 * Select the visible leaf set: [{key, depth, ix, iz, x, z, size}].
 *
 * `cam` is {x, z} at minimum; add `y` to enable the 3D range term and `yaw` to
 * enable view-cone culling. Both degrade to the conservative answer when absent,
 * which keeps this callable from the Node checks with a bare position.
 *
 * `info` is terrain.js's table of per-node vertical bounds, `key -> {minY, maxY}`,
 * learned as chunks are meshed. It only sharpens the range term; the split
 * decision itself needs nothing that has to be built first, so selection never
 * waits on the worker and never changes its mind about a node once the reply
 * lands. Omit it and every node falls back to its horizontal distance, which
 * under-estimates range and therefore over-refines -- the safe direction.
 */
export function selectNodes(
  cam,
  {
    maxDepth = MAX_DEPTH,
    triDeg = LOD.triDeg,
    periphDeg = LOD.periphDeg,
    info = null,
    cull = LOD.cull,
  } = {}
) {
  const out = []
  // tan rather than the small-angle shortcut: the panel range reaches 8 degrees,
  // where they differ by 1.2%, and the whole point of this file is that the knob
  // means what it says.
  const tanTri = Math.tan((triDeg * Math.PI) / 180)
  // The periphery is a COARSER target, never a finer one. Without this clamp the
  // pair inverts as soon as triDeg passes periphDeg -- ground behind the player
  // refined harder than ground in front of her -- which is nonsense that costs
  // slots and shows up nowhere. Measured at triDeg 5.72: 178 slots inverted,
  // 163 clamped, identical drawn triangles.
  const tanPeriph = Math.tan((Math.max(periphDeg, triDeg) * Math.PI) / 180)
  const culling = cull && cam.yaw !== undefined

  const visit = (depth, ix, iz) => {
    const size = WORLD_SIZE / (1 << depth)
    const x = -WORLD_HALF + ix * size
    const z = -WORLD_HALF + iz * size

    // One rule, two targets. Being outside the cone changes how fine the ground
    // gets, never whether it descends at all -- see LOD.periphDeg.
    const tan = !culling || inView(cam, x, z, size) ? tanTri : tanPeriph

    if (depth < maxDepth) {
      // Range is floored at the node's own half-size: inside the box the
      // distance is zero and every node would split to maxDepth regardless of
      // how flat it is, which is a spike of triangles under her feet and the one
      // place they buy nothing.
      const bounds = info ? info.get(nodeKey(depth, ix, iz)) : null
      const range = Math.max(nodeRange(cam, x, z, size, bounds), size * 0.5)
      if (size / CHUNK_RES > range * tan) {
        const cd = depth + 1
        visit(cd, ix * 2, iz * 2)
        visit(cd, ix * 2 + 1, iz * 2)
        visit(cd, ix * 2, iz * 2 + 1)
        visit(cd, ix * 2 + 1, iz * 2 + 1)
        return
      }
    }

    out.push({ key: nodeKey(depth, ix, iz), depth, ix, iz, x, z, size })
  }

  visit(0, 0, 0)
  return out
}
