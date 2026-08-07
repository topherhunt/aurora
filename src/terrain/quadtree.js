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
// SCALE-INVARIANT: measured error per cell is 0.37 at the median and 0.66 at p90
// at EVERY node size. Error is therefore very nearly proportional to cell size
// everywhere, which means a cell-size cap already IS an error cap, and measuring
// the error re-derives what the geometry guarantees.
//
// Priced at matched worst-case slot cost over 60 cameras (scripts/probe-lod.mjs):
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
// anything in _render), so the WORST-CASE leaf count has to fit under
// MAX_CACHED = 720, with enough left over for the LRU retention that makes
// turning your head free. Measured over 60 cameras, half airborne:
//
//     cap    leaf~   leafMAX   slots to spare   visible tris MAX
//    1.0      609      751          -31              280k
//    1.1      541      664           56              250k
//    1.2      489      580          140              222k
//    1.3      459      526          194              208k
//
// At 1.0 the pool does not merely thrash, it throws `terrain slot pool
// exhausted`. At 1.1 it survives on 56 slots of slack, which is less than one
// head-turn of retention. 1.2 keeps 140, holds visible terrain to 222k against
// its ~266k third of TRI_BUDGET, and is still a 7.7x improvement on the 9.22 deg
// worst case it replaces.
//
// Two ways to buy the last 0.2 deg, neither of them this knob: 45% of selected
// leaves fall outside the 110 deg eye cone and are never drawn, because
// VIEW_HALF_ANGLE is a deliberately generous streaming margin -- narrowing it
// trades pop-in on fast head turns for slots. Or raise SLOT_COUNT, which is a
// device-memory question rather than a tuning one.
// ---------------------------------------------------------------------------
export const LOD = {
  triDeg: 1.2,

  // Angular slack granted to terrain outside the view cone. Nodes fully outside
  // stop descending, so they stay present as coarse geometry rather than
  // vanishing -- there is no such thing as a hole here, only a low-poly stand-in
  // waiting for you to turn towards it.
  //
  // The cone is generous on purpose (see VIEW_HALF_ANGLE). This is the release
  // valve that makes a degree affordable at all: measured, roughly two thirds of
  // a 360-degree selection is terrain behind the player's head, which the GPU
  // was already culling per-instance -- so it cost slots and streaming without
  // ever costing or contributing a drawn triangle.
  cull: true,
}

export const MIN_TRI_DEG = 0.6
export const MAX_TRI_DEG = 8.0


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
function nodeRange(cam, x, z, size, info) {
  const dx = Math.max(x - cam.x, 0, cam.x - (x + size))
  const dz = Math.max(z - cam.z, 0, cam.z - (z + size))
  if (!info || cam.y === undefined) return Math.hypot(dx, dz)
  const dy = Math.max(info.minY - cam.y, 0, cam.y - info.maxY)
  return Math.hypot(dx, dy, dz)
}

// Is any part of this node inside the view cone? Conservative in both directions
// that matter: a node containing the camera always passes, and a node is widened
// by the angle it subtends so a big one straddling the edge is never cut.
function inView(cam, x, z, size) {
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
  return Math.abs(d) <= VIEW_HALF_ANGLE + spread
}

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
  { maxDepth = MAX_DEPTH, triDeg = LOD.triDeg, info = null, cull = LOD.cull } = {}
) {
  const out = []
  // tan rather than the small-angle shortcut: the panel range reaches 8 degrees,
  // where they differ by 1.2%, and the whole point of this file is that the knob
  // means what it says.
  const tanTri = Math.tan((triDeg * Math.PI) / 180)
  const culling = cull && cam.yaw !== undefined

  const visit = (depth, ix, iz) => {
    const size = WORLD_SIZE / (1 << depth)
    const x = -WORLD_HALF + ix * size
    const z = -WORLD_HALF + iz * size

    if (depth < maxDepth && (!culling || inView(cam, x, z, size))) {
      // Range is floored at the node's own half-size: inside the box the
      // distance is zero and every node would split to maxDepth regardless of
      // how flat it is, which is a spike of triangles under her feet and the one
      // place they buy nothing.
      const bounds = info ? info.get(nodeKey(depth, ix, iz)) : null
      const range = Math.max(nodeRange(cam, x, z, size, bounds), size * 0.5)
      if (size / CHUNK_RES > range * tanTri) {
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
