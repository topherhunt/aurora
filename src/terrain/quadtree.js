import { WORLD_SIZE, WORLD_HALF } from '../sim/terrain-height.js'

// ---------------------------------------------------------------------------
// Distance-driven quadtree LOD selection (DESIGN.md §5).
//
// A node is subdivided when the camera is closer to it than `splitK` times its
// own edge length. That single rule produces concentric rings of roughly
// constant screen-space triangle size, which is the property that actually
// matters -- a fixed distance table would over-tessellate small chunks far away
// and under-tessellate large ones nearby.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MAX_DEPTH, DEFAULT_SPLIT_K and chunk-mesh.js's CHUNK_RES are one decision,
// not three. Together they fix both the triangle cost of an empty world and
// its silhouette quality:
//
//   leaves selected  ~= f(splitK, MAX_DEPTH)     -- independent of CHUNK_RES
//   triangles        =  leaves x 2 x CHUNK_RES x (CHUNK_RES + 2)
//   angular error    ~= 1 / (CHUNK_RES x splitK) -- a leaf's nearest possible
//                       viewing distance is splitK x its own edge length, so
//                       one cell subtends (size/res) / (size x K) radians
//
// The first version shipped res 24 / K 2.1 / depth 9: 1.14 deg, but 502 leaves
// and 675k triangles -- 79% of §0's measured 800k budget with nothing in the
// world but ground. Sweeping the frontier at equal angular error moved that to
// res 16 / depth 10, with 1.00 m leaf cells, which is §2's stated heightmap
// resolution.
//
// K then came down again, to 1.0, after looking at it: chunky distant terrain
// turns out to be perfectly acceptable, and the fog is doing most of that work
// anyway. Measured worst-case selections over 400 random viewpoints:
//
//   K 0.8 -> 187 leaves, 120k tris, 4.48 deg
//   K 1.0 -> 223 leaves, 143k tris, 3.58 deg     <- default
//   K 1.3 -> 319 leaves, 204k tris, 2.75 deg     <- previous default
//
// Note how flat that curve is below K 1.3. Ring size bottoms out at low K, so
// most of what a higher K buys is near-field chunks you are looking straight
// down at. That is also why raising CHUNK_RES while lowering splitK costs MORE
// triangles at constant angular error, not fewer -- you pay res^2 without ever
// getting the K^2 saving back. Do not "optimise" that direction.
//
// splitK is live-tunable at runtime ([ and ]) precisely because 3.58 deg is a
// judgement call that has to be made by looking at ridgelines, not at a table.
// ---------------------------------------------------------------------------

export const MAX_DEPTH = 10 // 16384 m root / 2^10 = 16 m leaves
export const DEFAULT_SPLIT_K = 1.0

// The terrain slot pool is sized for the worst selection at this splitK.
export const MAX_SPLIT_K = 2.1
export const MIN_SPLIT_K = 0.8

export function nodeKey(depth, ix, iz) {
  return `${depth}|${ix}|${iz}`
}

export function parentKey(depth, ix, iz) {
  if (depth === 0) return null
  return nodeKey(depth - 1, ix >> 1, iz >> 1)
}

function boxDistance(camX, camZ, x, z, size) {
  const dx = Math.max(x - camX, 0, camX - (x + size))
  const dz = Math.max(z - camZ, 0, camZ - (z + size))
  return Math.hypot(dx, dz)
}

// Returns the visible leaf set: {key, depth, ix, iz, x, z, size}.
export function selectNodes(camX, camZ, maxDepth = MAX_DEPTH, splitK = DEFAULT_SPLIT_K) {
  const out = []

  const visit = (depth, ix, iz) => {
    const size = WORLD_SIZE / (1 << depth)
    const x = -WORLD_HALF + ix * size
    const z = -WORLD_HALF + iz * size

    if (depth < maxDepth && boxDistance(camX, camZ, x, z, size) < size * splitK) {
      const cd = depth + 1
      visit(cd, ix * 2, iz * 2)
      visit(cd, ix * 2 + 1, iz * 2)
      visit(cd, ix * 2, iz * 2 + 1)
      visit(cd, ix * 2 + 1, iz * 2 + 1)
      return
    }

    out.push({ key: nodeKey(depth, ix, iz), depth, ix, iz, x, z, size })
  }

  visit(0, 0, 0)
  return out
}
