// ---------------------------------------------------------------------------
// v2 constants (DESIGN.md §18). Three-free on purpose: the node gate, the
// worker and the renderer all read this file, and none of them may disagree
// about the size of a chunk or the depth of the tree.
//
// v1's numbers live in src/sim/terrain-height.js and src/terrain/quadtree.js
// and are NOT imported here. The two worlds share a coordinate box and nothing
// else -- see §18 "v2 does not replace v1".
// ---------------------------------------------------------------------------

// THE WORLD BOX, and it is 8 km rather than v1's 16 km because the coarse shape
// is now IMPORTED and the import decides the scale. `reference/skyrim-height-map.jpg`
// is the source and it measures 8 km edge to edge horizontally, so that is the
// width of the world; the quadtree needs a square root node, so the box is
// 8192 m on both axes.
//
// At 1024 px across 8192 m the imported field is 8 m/texel, which is the number
// most of the rest of v2 is actually sized against -- the detail band limit, the
// snow grid's resolution, the slope stencil. It is not an independent constant;
// it moves whenever this one does.
//
// NOTE THE NEAR-AGREEMENT, because it is worth one line rather than a silent
// rediscovery later: `scripts/heightmap-png.mjs` has recorded the same reference
// image as "~4 miles (6437 m) across at 1024 px, i.e. 6.29 m/px" since build
// step 2, and every §3 terrain-character comparison made against it used that
// scale. 8 km is the number to use -- it is the one stated for this build -- and
// it is within 27% of the older reading rather than the 1.57x the 4 km draft of
// this file implied, so those §3 comparisons remain roughly meaningful.
//
// The source is 1024 x 873, not square, so it covers the full 8192 m in X and
// 873/1024 * 8192 = 6984 m in Z, centred. Beyond that the IMPORT mirror-extends
// the edge rows: 604 m at each Z edge. Clamping instead would extrude the last
// row into flat ridges running the width of the map, which is exactly the kind
// of artifact that reads as a bug in the mesher.
//
// That fit happens once, in scripts/make-heightmap.mjs, and the baked PNG is
// square -- so heightmap.js keeps its plain edge-to-edge registration and the
// runtime never branches on the shape of whatever image the world came from.
export const WORLD_SIZE = 8192
export const WORLD_HALF = WORLD_SIZE / 2

// Cells per chunk edge. Identical topology for every chunk at every depth is
// what lets terrain-v2.js pre-allocate fixed-size BatchedMesh slots and recycle
// a freed one for whatever arrives next. Changing this changes the LOD ceiling
// (see MAX_TRI_DEG) and the slot pool's memory, in that order.
export const CHUNK_RES = 16

// Derived; every chunk is exactly this size. Inner grid plus a skirt ring.
export const CHUNK_VERTS = (CHUNK_RES + 1) * (CHUNK_RES + 1) + 4 * (CHUNK_RES + 1)
export const CHUNK_INDICES = (CHUNK_RES * CHUNK_RES * 2 + 4 * CHUNK_RES * 2) * 3

// THE 4 METRE CHUNK, and the reason there is no smaller one.
//
// 8192 / 2^11 = 4 m leaf NODE, and a node holds CHUNK_RES cells, so the finest
// CELL is 25 cm. That is exactly detail.js's fractal floor, so the field is now
// sampled to exhaustion: there is no octave below this one to go and get.
//
// THE COST IS ONE RING OF LEAVES, priced on the unbounded column of
// check-v2-quadtree.mjs's ladder, which is an upper bound for any height field:
//
//     triDeg    leaves 10 -> 11    worst drawn tris 10 -> 11
//      3.00       256 -> 286            80k ->  88k
//      5.72       142 -> 157            46k ->  51k
//
// About +10% of leaves and +6k triangles wherever the knob sits, and the XR
// route (5.72) lands at 51k against terrain's 117k third. The pool is not close
// to binding either: MIN_TRI_DEG still fits at 748 of 1024.
//
// WHY 11 IS AFFORDABLE WHERE 13 WAS NOT, since 13 is where this started. The
// split rule floors range at the node's own half-size (see quadtree-v2.js), so
// the node CONTAINING the camera splits to the cap however flat it is, and a
// chunk is 640 triangles whatever its size. At 13 that staircase spent 640
// triangles on one square metre of ground, and spent it on the ground already
// closest to being flat underfoot -- 152k triangles both eyes against 102k at
// 10. A 4 m leaf is 16 square metres, so the same staircase costs one level of
// it rather than three, and the ladder above is what that is worth.
//
// The cap is the SAME on desktop and in XR, deliberately. It was briefly a
// per-route override (13 on desktop, 10 in the headset) and that is the wrong
// trade for this project: a desktop that renders ground the headset cannot is a
// second fidelity story to keep in sync, and §18's whole premise is one world
// that looks the same in both. Consistency beats a better desktop.
//
// Still a CAP, not a target. The split rule decides what depth is actually
// reached from range; this only says where refining stops. At the XR route's
// 5.72 deg the rule wants a 25 cm cell only within about 2.5 m of the eye, so
// this level is bought for the ground she is standing on and nothing further.
export const MAX_DEPTH = 11

// Hard ceiling on simultaneously-resident chunks, and a fixed ~17 MB of GPU
// buffers. Overflow THROWS in terrain-v2.js rather than degrading, so this has
// to cover the worst selection at the finest reachable triDeg plus the pinned
// base layer plus LRU headroom.
//
// v1 ships 768 for MAX_DEPTH 10 over a 16 km world. v2 goes one level deeper
// over a world half the size -- a 4 m leaf against v1's 16 m -- and those two
// effects push in opposite directions: the deeper cap only refines nodes near
// the camera and adds roughly one ring of leaves, while the smaller box removes
// one level of far-field coarse nodes entirely. Re-measure with check-v2.mjs section "slot pool" before
// moving MIN_TRI_DEG -- do not reason about it from this comment.
export const SLOT_COUNT = 1024

// Depths 0-2, pinned forever so there is always SOMETHING to draw: 1 + 4 + 16.
export const PINNED_CHUNKS = 21

// Where the baked world lives, relative to the site root.
export const HEIGHTMAP_URL = 'world/height.png'
export const HEIGHTMAP_META_URL = 'world/height.json'
export const LAYERS_URL = 'world/layers.json'

// The one seed every generated thing in v2 is derived from: the prop banks, the
// scatters' placement, the shape of the rocks in the rock bank. It lives here
// rather than in main.js because the previewers need it too -- /gen-rock has to
// be able to resolve a shape id the running world printed (`shingle-1`) back to
// the seed that built it, and it can only do that against the same bank seed the
// world used. See NAMING ONE SHAPE in props/rock-bank.js.
export const SEED = 20260824
