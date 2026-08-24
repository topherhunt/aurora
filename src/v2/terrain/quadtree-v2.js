import { WORLD_SIZE, WORLD_HALF, CHUNK_RES, MAX_DEPTH, SLOT_COUNT, PINNED_CHUNKS } from '../config.js'

// ---------------------------------------------------------------------------
// v2 quadtree LOD selection (DESIGN.md §18). Three-free, so scripts/check-v2-quadtree.mjs
// can gate it in node.
//
// THE RULE IS v1's RULE, UNCHANGED:
//
//   split while  cell > range * tan(TRI_DEG)
//
//   cell   the node's grid spacing, size / CHUNK_RES, in metres
//   range  distance from the eye to the node's bounding box, in 3D, floored at
//          the node's own half-size, in metres
//
// A length over a range is an angle, so the knob reads straight off the screen:
// REFINE UNTIL NO TRIANGLE LOOKS BIGGER THAN TRI_DEG DEGREES. src/terrain/quadtree.js
// carries the full argument for why this rule and not another -- a per-node
// GEOMETRIC ERROR term was built, measured and removed because fbm roughness is
// scale-invariant and a cell-size cap therefore already is an error cap; an
// ELEVATION BIAS on splitK before that was removed because it was a hierarchical
// gate keyed on a quantity whose correlation with actual error was 0.16 at the
// depths it acted on. Neither conclusion is re-litigated here and neither becomes
// wrong three levels deeper. Read that file before touching this one.
//
// ONE THING TO WATCH, and it is the one place the v1 argument could flip. The
// error term was rejected because THIS terrain is fractal at every scale. v2's
// field is not: it is an authored coarse image plus band-limited detail plus
// authored river/road carves, and a carved channel is exactly the "rough at one
// scale, smooth at another" feature v1's comment named as the case that flips the
// conclusion. It has not flipped yet -- src/v2/height/detail.js runs a
// broadband octave stack from LAMBDA0 = 512 m down to 25 cm, so error per cell
// is still roughly proportional to cell size over the range that matters -- but
// its amplitude law has a knee rather than being pure fbm, and that is exactly
// the shape that could break the proportionality. The measurement to re-run once
// the carve layers land is probe-lod.mjs's section 1, adapted to the v2 field.
// This file has NOT re-measured it: the claim above is read off detail.js's
// stated octave range, not off an error probe.
//
// WHAT IS DIFFERENT FROM v1, and it is three things, none of them the rule:
//
//   1. MAX_DEPTH 13 rather than 10, from config.js -- and the box is 8192 m
//      rather than v1's 16384 m, so the leaf node is 1 m rather than v1's 16 m
//      and the finest cell is 6.25 cm rather than 1 m. Four levels of resolution,
//      three bought with depth and one with the halved world. WORLD_SIZE and
//      MAX_DEPTH are imported, never re-declared: they moved twice while this
//      file was being written (16384/14, then 4096/12, then 8192/13) and every
//      number below was re-measured each time. That is the whole argument for
//      importing them, and for the gate deriving its own probe positions from
//      WORLD_HALF rather than writing metres down.
//   2. Integer node keys rather than `${depth}|${ix}|${iz}` strings. See nodeKey.
//   3. A finer default triDeg, because v2's primary surface is a desktop editor
//      rather than a Quest 2. See LOD.triDeg.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// THE KNOB. The largest a triangle is ever allowed to look, in degrees.
//
// Mutable so the panel and the [ ] keys can move it live; selection reads it
// every frame, so a change lands on the next one with no regeneration.
// ---------------------------------------------------------------------------
export const LOD = {
  // 3.0, where v1 ships 5.72. That gap is a DEVICE decision, not a change of
  // mind about the rule.
  //
  // v1's 5.72 is a Quest 2 number chosen by eye with the [ ] keys and then
  // measured. v2's primary surface is the desktop /v2 editing route, where the
  // entire point of a 6.25 cm cell is being able to SEE that detail while
  // dragging a spline point through it. Shipping the headset's cap there would
  // hold the ground at 6 degrees per triangle and hide the thing the depth
  // exists to show.
  //
  // Measured over 606 positions x 4 headings, half airborne, worst case over the
  // sweep, 640 tris/chunk (check-v2-quadtree.mjs "MIN_TRI_DEG budget"). The
  // "upper bound" column is the same sweep run with NO vertical bounds, where
  // range degrades to the horizontal distance -- and since hypot(dx,dy,dz) is
  // never less than hypot(dx,dz), that column is a bound no height field can
  // exceed. It is what makes these numbers usable before v2's field exists:
  //
  //     triDeg   sel + 21 pinned   + 21 unbounded   fits 1024?   drawn tris   upper bound   % of terrain's 117k
  //      1.2           886                913             yes        313k          322k            268-275%
  //      2.0           484                499             yes        158k          163k            135-139%
  //      3.0           343                367             yes        101k          106k             86- 91%
  //      4.0           271                289             yes         76k           79k             65- 68%
  //      5.72          199                208             yes         57k           59k             49- 50%
  //
  // §0 holds the whole frame to 350k and terrain to a third of it, 117k. 3.0
  // draws 101k worst case and cannot exceed 106k for any field, so it FITS -- 91%
  // of terrain's share at the bound, which is a fit with no margin worth having.
  // The props, water and aurora that share the frame have to come out of the
  // other two thirds exactly. AN XR ROUTE SHOULD TAKE 4.0 (68% of the share) OR
  // COARSER rather than assume this default leaves it room. The column to
  // re-measure once the real field lands is "drawn tris", which moves with where
  // the ground sits relative to the eye; the "upper bound" column does not move.
  //
  // Note that the two finest rows are over budget on drawn triangles even though
  // they fit the slot pool. The pool and the budget are different walls and the
  // knob crosses the triangle one first: everything from 2.0 down is reachable
  // and resident but not affordable to DRAW on a headset. That is the right
  // shape for an editing knob -- the pool is a hard throw, the budget is a frame
  // rate you can choose to spend -- but it does mean MIN_TRI_DEG is not a
  // "safe to ship anywhere" mark.
  triDeg: 3.0,

  // What the same rule targets OUTSIDE the view cone. A resolution, not a
  // switch, and v1 records why: the first version of the cull stopped descent
  // entirely at the first node that failed the view test, which parks ground
  // behind the player at whatever depth the cone edge happened to cut -- usually
  // 2 or 3 -- so turning around drew a kilometre-wide chunk as a stand-in.
  // Measured there as 4.4 deg worst triangle drawn while panning against 1.2 deg
  // graded.
  //
  // CLAMPED UP to triDeg at the point of use, because a periphery finer than the
  // cone is meaningless. Unlike v1's shipped 5.72, v2's 3.0 default leaves the
  // clamp unbound, so the grading is live -- and it gets MORE load-bearing the
  // finer the knob goes, because the periphery is what the cone's cost is
  // measured against. Worst selection on the sweep, graded against the periphery
  // given the cone's own target:
  //
  //     triDeg 3.0   322 graded   370 flat   (13% saved, both fit the 1024 pool)
  //     triDeg 1.2   865 graded  1279 flat   (32% saved, and 1279 + 21 does NOT fit)
  //
  // So the grading buys headroom at the default and is the entire reason
  // MIN_TRI_DEG can be 1.2 rather than something coarser. The gate asserts it at
  // the floor, which is where the claim has teeth.
  periphDeg: 5.0,

  cull: true,
}


// The usable band. BOTH ends are hard walls rather than taste, and both were
// re-measured for this tree rather than inherited.
//
// FLOOR -- 1.2, which is exactly v1's number, and arriving back at it was not
// the expected result. Three more levels of depth against a pool only 1.33x
// larger ought to cost the knob range. It does not, because two changes push
// opposite ways and land within a hair of each other: the deeper cap only
// refines what is already near the camera and adds about one ring of leaves per
// level, while the halved box deletes a whole level of FAR-FIELD coarse nodes,
// which are the numerous ones. That near-cancellation is a coincidence of these
// particular numbers and not a law -- when this file was briefly measured
// against a 4 km / depth-12 box the floor came out at 1.1, one step finer.
// Re-measure rather than assume 1.2 travels.
//
// terrain-v2.js keeps v1's rule that the current selection is exempt from
// eviction, so the WORST-CASE leaf count has to fit SLOT_COUNT alongside the
// PINNED_CHUNKS base layer, and overflow THROWS rather than degrading. A knob
// whose range includes values that cannot work is a knob that fails late.
//
// Measured over 606 positions x 4 headings, half of them airborne
// (check-v2-quadtree.mjs, "MIN_TRI_DEG budget"). Two columns, because a floor
// measured against a stand-in height field would be a floor that moves when the
// real field lands: "bounded" uses the analytic stand-in's per-node minY/maxY,
// "unbounded" runs the same sweep with no bounds at all, where range degrades to
// the horizontal distance. hypot(dx,dy,dz) >= hypot(dx,dz) always, so the
// unbounded column is a HARD upper bound that NO height field can exceed.
//
//     cap    bounded   + 21   unbounded   + 21   fits 1024?
//     0.9      1288     1309     1312      1333      no
//     1.0      1099     1120     1135      1156      no
//     1.1       979     1000     1072      1093      no
//     1.2       865      886      892       913     yes
//     1.5       664      685      712       733     yes
//     2.0       463      484      478       499     yes
//
// THE FLOOR IS SET ON THE UNBOUNDED COLUMN, and that choice is what makes 1.1
// wrong rather than marginal. At 1.1 the bounded worst is 979, which plus the 21
// pinned is 1000 -- it fits with room to spare, for one particular stand-in
// field. The unbounded column says 1093, and no height field can beat that
// column downward, so a 1.1 chosen on the stand-in would throw on the real one.
// 1.2 is the finest cap that is safe for whatever v2's field turns out to be.
// The gate asserts both directions on that same column -- 1.2 fits, 1.1 does not
// -- so the number is shown to be tight rather than picked, and it is asserted
// on the column the floor was chosen on rather than whichever one makes it pass.
//
// WHY THE EXTRA LEVELS ARE NEARLY FREE, which is the measurement SLOT_COUNT 1024
// rests on. Same sweep, same 1.2 cap, varying only MAX_DEPTH:
//
//     depth 6 -> 322    8 -> 481    10 -> 628    12 -> 793    13 -> 865
//
// Each level adds roughly one RING of leaves around the camera, not a
// quadrupling, because a deeper cap only refines what is already close enough to
// want it -- and the rings stop growing once the ring's own range makes the
// target cell coarser than the level provides. Four levels, 9 to 13, cost 1.53x,
// not 256x. Note also that the grading is doing a third of this work: without it
// the 1.2 row is 1279 rather than 865 (see LOD.periphDeg).
//
// CEILING -- 7.0. CHUNK_RES is 16 in v2 as in v1, so v1's derivation carries over
// unchanged. Range is floored at a node's own half-size, so for any node
// containing the camera the split test is
//
//     cell / range  =  (size / CHUNK_RES) / (size / 2)  =  2 / CHUNK_RES  =  1/8
//
// -- independent of size, so past atan(0.125) = 7.125 deg it either splits every
// such node or none of them, and "none" means the entire 8 km world draws as a
// single chunk with 512 m triangles. MEASURED here rather than inherited,
// because the depth changed and an assertion carried over untested is the
// failure mode design/lessons.md counts thirteen times. From a ground-level
// camera:
//
//     depth 13:  7.0 -> 130 leaves (55 drawn)     7.2 -> 1 leaf
//     depth 10:  7.0 -> 106 leaves (44 drawn)     7.2 -> 1 leaf
//
// v1's file reports "59 drawn leaves at 7.0, 1 at 7.2" for depth 10 on its own
// field; 44 here is the same measurement on a different height field, and the
// 7.2 column is exactly 1 on both, which is the part that matters -- the cliff
// is a property of CHUNK_RES and the range floor, not of the terrain. The extra
// 24 leaves at depth 13 are the staircase running three levels further down
// beside the one node that contains the camera, confirming that at the ceiling
// depth buys a handful of leaves and nothing else. This ceiling moves only if
// CHUNK_RES does.
export const MIN_TRI_DEG = 1.2
export const MAX_TRI_DEG = 7.0


// Half-angle of the cone treated as "she can see this", in radians.
//
// 90 -- a full forward hemisphere -- rather than the honest ~55 the hardware
// renders. The extra 35 degrees are the streaming margin: selection runs at
// 12 Hz, so a 200 deg/s head turn moves 17 degrees between selections and the
// margin is worth about two seconds of it. Nodes outside it are emitted COARSE,
// never dropped, so turning further than the margin finds low-poly ground rather
// than sky.
export const VIEW_HALF_ANGLE = (90 * Math.PI) / 180
// Half the horizontal field the device actually renders. Not a tuning knob -- it
// describes the hardware, and it is here so that "drawn" can be counted. Counting
// the streaming cone's triangles as drawn overstates the ground's share of the
// frame by about 70%.
export const EYE_HALF_ANGLE = (55 * Math.PI) / 180


// ---------------------------------------------------------------------------
// NODE KEYS ARE PACKED INTEGERS, not `${depth}|${ix}|${iz}` strings.
//
// v1 uses the string and it is fine there. It is not fine here, and the reason
// is traffic rather than taste: the worst selection is 346 leaves at the default
// and 892 at MIN_TRI_DEG against v1's 163, selection runs at 12 Hz, and every
// node touched -- leaf or interior -- builds a key to probe the `info` bounds
// table, with terrain-v2.js probing the same key again per node for the slot
// map. A string key allocates on every one of those.
//
// Priced against v1's exact string form over the same 2424-selection sweep, both
// descending the same tree over an equivalent lazy bounds table:
//
//                        p50        p99
//     triDeg 3.0   packed 0.018  0.046 ms      string 0.038  0.102 ms   2.22x
//     triDeg 1.2   packed 0.055  0.151 ms      string 0.108  0.299 ms   1.98x
//
// The packed numbers INCLUDE the bounds assertion below, so the whole change --
// integer key plus a validation v1 does not do -- still runs about 2x faster
// than the string it replaces.
//
// THE PACKING. At MAX_DEPTH 13 depth is 0..13 and ix/iz are each 0..8191, so
// 4 + 13 + 13 bits would do. The strides are 2**28 and 2**14 anyway, sized for
// ix/iz up to 16383, so that MAX_DEPTH moving again -- it moved twice during
// this file's first hour, 14 to 12 to 13 -- changes no key arithmetic and
// invalidates no persisted key. That headroom costs nothing except that the
// field is 32 bits wide, one too many for a safe int32, so this is NOT a bitwise
// expression. It is float arithmetic on a Number:
//
//     key = depth * 2**28  +  iz * 2**14  +  ix
//
// Max key at depth 13 is 13 * 2**28 + 8191 * 2**14 + 8191 = 3623870463, and the
// stride ceiling at depth 14 would be 4026531839. Both are far inside 2**53, so
// every key is an exact integer and Map hashing sees a dense integer rather than
// a fresh string. Depth bands cannot overlap because at depth d both indices are
// < 2**d <= 2**14, so the low 28 bits never reach 2**28; the gate asserts that
// band-disjointness for every depth, which together with ix < 2**14 is a
// complete injectivity proof rather than a spot check.
//
// The bounds are asserted on every call rather than trusted. An out-of-range ix
// would silently alias onto another node's key -- a chunk drawn in the wrong
// place, or worse, a slot handed to two owners -- and that is precisely the
// failure that must not degrade quietly. It is affordable because the thing it
// replaced was slower even without it; see the table above.
// ---------------------------------------------------------------------------
const KEY_DEPTH_STRIDE = 2 ** 28
const KEY_IZ_STRIDE = 2 ** 14

export function nodeKey(depth, ix, iz) {
  const span = 1 << depth
  if (!(depth >= 0 && depth <= MAX_DEPTH && ix >= 0 && ix < span && iz >= 0 && iz < span)) {
    throw new Error(`nodeKey out of range: depth ${depth} ix ${ix} iz ${iz} (span ${span}, MAX_DEPTH ${MAX_DEPTH})`)
  }
  return depth * KEY_DEPTH_STRIDE + iz * KEY_IZ_STRIDE + ix
}

export function parentKey(depth, ix, iz) {
  if (depth === 0) return null
  return nodeKey(depth - 1, ix >> 1, iz >> 1)
}

// The inverse. Exported because the packing is opaque by construction and two
// callers need to see through it: the HUD, which prints the node under the
// cursor, and the gate, which round-trips it.
export function unpackKey(key) {
  if (!Number.isInteger(key) || key < 0 || key >= (MAX_DEPTH + 1) * KEY_DEPTH_STRIDE) {
    throw new Error(`unpackKey: ${key} is not a node key`)
  }
  const depth = Math.floor(key / KEY_DEPTH_STRIDE)
  const rest = key - depth * KEY_DEPTH_STRIDE
  const iz = Math.floor(rest / KEY_IZ_STRIDE)
  const ix = rest - iz * KEY_IZ_STRIDE
  return { depth, ix, iz }
}


// Distance from the eye to the node's bounding box, in 3D.
//
// The Y term is why this is not a horizontal distance. v1 measured horizontally
// and never even passed the camera's altitude, so at 500 m up, ground 100 m away
// on the map -- 510 m away in fact -- was tessellated as though she could touch
// it: a 5x over-refinement of everything directly below, which is most of what is
// on screen when flying.
//
// `info` is what the mesher learned about this node's vertical extent and is
// absent until the chunk has been built once. Without it the test falls back to
// the horizontal distance, which UNDER-estimates range and therefore
// over-refines: the conservative direction.
//
// Exported so probes measure range the way selection does. A probe that
// reimplements this is measuring a renderer that does not exist.
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
// than anyone can see. EYE_HALF_ANGLE is what is actually drawn, because
// BatchedMesh culls the rest per instance.
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
 * which keeps this callable from the node checks with a bare position.
 *
 * `info` is terrain-v2.js's table of per-node vertical bounds, `key -> {minY, maxY}`,
 * learned as chunks are meshed. It only sharpens the range term; the split
 * decision itself needs nothing that has to be built first, so selection never
 * waits on the worker. Omit it and every node falls back to its horizontal
 * distance, which under-estimates range and therefore over-refines -- the safe
 * direction.
 *
 * STILL RECURSIVE, and that was checked rather than assumed. Thirteen levels of
 * four-way recursion is a call stack 13 deep and roughly n/3 interior frames for
 * n leaves, which is nothing; the cost is in the arithmetic per node, not the
 * frames. Measured over the 2424-selection sweep:
 *
 *     triDeg 3.0 (the default)   p50 0.020  p90 0.033  p99 0.039  max 0.24 ms
 *     triDeg 1.2 (MIN_TRI_DEG)   p50 0.058  p90 0.094  p99 0.118  max 0.32 ms
 *
 * Selection runs at 12 Hz, so the worst of those is 0.3 ms once every 83 ms --
 * about 2% of a single 16 ms frame, and it is the fine end of a knob whose
 * default costs a fifth of that. An explicit stack was NOT written, because
 * converting a hot recursion on a hunch is the exact failure mode
 * design/lessons.md is about and there is no number here asking for it. If
 * selection ever shows up in a profile, the p99 above is the thing to beat and
 * check-v2-quadtree.mjs holds it under 1 ms.
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
  // tan rather than the small-angle shortcut: the knob's range reaches 7 degrees,
  // where they differ by 0.50%, and the whole point of this file is that the knob
  // means what it says.
  const tanTri = Math.tan((triDeg * Math.PI) / 180)
  // The periphery is a COARSER target, never a finer one. Without this clamp the
  // pair inverts as soon as triDeg passes periphDeg -- ground behind the player
  // refined harder than ground in front of her. Unlike v1's shipped default the
  // clamp does not bind at 3.0, so this is live grading rather than a no-op.
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
      // how flat it is. At v1's depth 10 that was a spike of triangles under her
      // feet; here the leaf is 1 m rather than v1's 16 m, so the spike would be
      // 256x larger in leaf count, and it is the one place those leaves buy
      // nothing. This `Math.max` is the invariant the gate was verified against
      // by deliberately deleting it: check-v2-quadtree.mjs's "one step past the
      // cliff the whole world is a single chunk" goes from 1 leaf to 124 and
      // fails. Worth knowing that it is the ONLY check that fails -- the pool
      // ladder and the tiling invariants do not notice, because the staircase
      // under the camera is only about three leaves per level. The ceiling
      // section is load-bearing for this specific bug precisely because
      // atan(2/CHUNK_RES) is derived FROM the floor.
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

// Re-exported so a caller that has this module does not also have to reach into
// config.js to know what the selection is being budgeted against. These are the
// two numbers every assertion about the slot pool is written in terms of.
export { MAX_DEPTH, SLOT_COUNT, PINNED_CHUNKS }
