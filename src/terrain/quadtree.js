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
//   K 0.8 -> 148 leaves,  95k tris, 4.48 deg
//   K 0.9 -> 178 leaves, 114k tris, 3.98 deg
//   K 1.0 -> 211 leaves, 135k tris, 3.58 deg
//   K 1.1 -> 304 leaves, 195k tris, 3.26 deg     <- default
//   K 1.2 -> 304 leaves, 195k tris, 2.98 deg
//   K 1.3 -> 304 leaves, 195k tris, 2.75 deg     <- original default
//   K 1.6 -> 400 leaves, 256k tris, 2.24 deg
//
// Read that table carefully, because it is not a smooth curve and the flat spot
// is the interesting part. 1.1, 1.2 and 1.3 select the SAME 304 leaves: subdivision
// is a discrete test, so a whole band of K values lands on one ring layout and
// costs exactly the same. The visible quality step between 1.0 and 1.1 is that
// boundary, and it means the extra detail from 1.1 up to 1.3 is free -- and that
// dropping from 1.1 to 1.0 saves a real 60k triangles.
//
// 1.1 is therefore the cheapest K on its plateau, which is why it is the default.
// If distant ridgelines ever need more, go to 1.3 before 1.6; it costs nothing.
//
// Note also how flat the curve is below 1.3. Ring size bottoms out at low K, so
// most of what a higher K buys is near-field chunks you are looking straight
// down at. That is also why raising CHUNK_RES while lowering splitK costs MORE
// triangles at constant angular error, not fewer -- you pay res^2 without ever
// getting the K^2 saving back. Do not "optimise" that direction.
//
// Regenerate this table by sweeping selectNodes() over the CAMS list in
// check-sim.mjs section 5; the numbers above come from exactly that.
// ---------------------------------------------------------------------------

export const MAX_DEPTH = 10 // 16384 m root / 2^10 = 16 m leaves
export const DEFAULT_SPLIT_K = 1.1

// The terrain slot pool is sized for the worst selection at this splitK.
export const MAX_SPLIT_K = 2.1
export const MIN_SPLIT_K = 0.8

// ---------------------------------------------------------------------------
// ELEVATION BIAS -- spend the triangle budget where she can actually see it.
//
// The pure distance rule above is elevation-blind, and in a mountain world that
// is the wrong instinct twice over. Distant VALLEY floors are hidden behind
// their own ridgelines nearly all the time, so tessellating them is triangles
// spent on geometry no one ever sees; distant PEAKS are the silhouette against
// the sky, where the eye is most sensitive to faceting and where §5's ~3.3 deg
// angular error reads as visible polygon edges on a skyline.
//
// So the split test gets a per-node multiplier keyed on how high that node's
// ground is, and the multiplier gets STRONGER with distance. Near the camera it
// is exactly 1.0 and the old behaviour is unchanged -- she is standing on that
// ground, and biasing it would be visible as detail popping in underfoot.
//
// `swing` is indexed by the depth being TESTED for subdivision, and depth is the
// honest proxy for ring: a node of size S only ever survives as a leaf beyond
// splitK x S, so depth 3 (2048 m nodes) is the far field by construction and
// depth 9 (32 m) is arm's reach. Measured leaf depth by distance band, which is
// what the shape of the array is fitted to:
//
//      0- 500 m: depths 6-10      2000-3000 m: depth 4
//    500-1000 m: depths 5-6       3000-5000 m: depths 3-4
//   1000-2000 m: depth 5          5000-8000 m: depths 2-3
//
// The array does NOT ramp monotonically outward, and that is a measurement
// result rather than a preference. A node can only be biased on what its own
// pooled elevation knows, and past about 1 km the nodes are too big to know
// anything. Measured as the gap in mean node-rank between summit ground and
// valley ground inside the node:
//
//   depth 3 (2048 m): 0.15      depth 6 (256 m): 0.73
//   depth 4 (1024 m): 0.29      depth 7 (128 m): 0.85
//   depth 5 ( 512 m): 0.51
//
// A 2 km square in this world contains a summit AND a valley, so its elevation
// predicts almost nothing about any particular point inside it; 0.15 is close to
// no signal at all. The swing therefore peaks at depths 4-5 -- the outermost
// ring where the question is still answerable -- tapers at 3 rather than leading
// there, and is 0 from depth 7 in, which is the 0-500 m band she is standing on
// and where shifting detail would read as popping underfoot.
//
// The hierarchy is what makes a modest depth-3/4 swing still matter for the
// skyline: a node only reaches depth 5 if its depth-3 and depth-4 ancestors both
// split, so the coarse levels act as a gate on whether the better-informed test
// downstream ever gets to run.
//
// The multiplier is 2^(swing x (rank - pivot) x 2), i.e. `swing` is measured in
// LOD LEVELS, not in raw multiplier. That is the natural unit here -- each level
// of the tree halves the node size, so "give the top of the band one extra level
// and take one off the bottom" is swing 1.0, and it reads directly off the
// constant. The first version was linear, `1 + s x (rank - pivot)`, and it had a
// landmine in it: at depth 3 with s 2.25 a bottom-band node computed k = -0.01. A
// negative split threshold happens to do the right thing (never subdivide) but
// only by accident, and one constant further would have made it large-negative
// with the same behaviour, hiding the fact that the knob had stopped meaning
// anything. An exponential cannot go negative, and its ends stay interpretable.
//
// The pivot is what makes this a redistribution rather than a global detail
// hike: nodes above it gain, nodes below it lose.
//
// Depths 0-2 are deliberately 0, and not as a tuning choice. The bias ranks a
// node against the other nodes OF ITS OWN SIZE, and at depth 0 there is exactly
// one -- its band came out 322-322, `t` went NaN, `boxDistance < size * NaN` was
// false forever and the entire world rendered as a single 16 km leaf. Depths 1
// and 2 (4 and 16 nodes) are not degenerate but are still too few for a
// percentile to mean anything, and those nodes are 8 km and 4 km across: the one
// under the camera always splits regardless. Depth 3 is the first level with a
// real population (64) and the first where the answer changes anything.
// Swept as a scale on the shape below, measured as the share of far-field probe
// points whose covering leaf moved a full LOD level. The false-positive column is
// the one that matters -- a promotion rate means nothing without it:
//
//            summit finer / coarser   valley finer / coarser   worst leaves  at K 2.1
//   x1.00          15%   11%                 7%   17%           292 ( -4%)    619
//   x1.50          26%   12%                11%   18%           304 (  0%)    673
//   x1.75          31%   13%                14%   19%           328 ( +8%)    700   <- shipped
//   x2.00          34%   13%                16%   19%           337 (+11%)    745
//   x2.50          37%   13%                18%   20%           385 (+27%)    820   overflows pool
//
// 2.00 fits the 768-slot pool by two slots, which is not headroom, and the curve
// has already flattened by then. 1.75 keeps 47 slots spare and still refines
// summit ground 2.2x as often as valley ground, for 178k triangles against the
// 266k that §0's budget leaves to terrain.
export const ELEV_LOD = {
  swing: [0, 0, 0, 1.4, 1.75, 1.75, 1.05, 0, 0, 0, 0],
  pivot: 0.5,
  // Base grid is 2^baseDepth per side: 7 -> 128x128 at 128 m, one level finer
  // than the deepest biased ring (6), so a depth-6 node averages 4 cells.
  //
  // 8 (256x256 at 64 m) was measured against it and is not worth it: 72 ms of
  // heightAt at load against 22 ms, for 31%/14% summit-vs-valley refinement
  // against 32%/15%. Identical inside the noise. On a Quest that 50 ms is more
  // like 200, and it buys nothing.
  baseDepth: 7,
}

// Mean ground elevation per quadtree node, as a pyramid: `levels[d]` holds
// (2^d)^2 entries indexed `iz * 2^d + ix`, matching the node addressing above.
//
// This was MAX-pooled first, on the reasoning that the silhouette is made of
// summits and a node averaging out to nothing can still own the ridgeline. That
// reasoning is wrong, and measurably so: max separates summit ground from valley
// ground WORSE than mean at every single depth (0.06 vs 0.15 at depth 3, 0.83 vs
// 0.85 at depth 7). The reason is saturation -- in a mountain world nearly every
// node of any size contains something tall, so a max says "yes" everywhere and a
// test that answers yes for all its inputs is not a test. Mean asks how much of
// the node is high, which is the question with an informative answer.
export function buildElevationLod(th, baseDepth = ELEV_LOD.baseDepth) {
  const n = 1 << baseDepth
  const cell = WORLD_SIZE / n
  const levels = new Array(baseDepth + 1)

  const base = new Float32Array(n * n)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      base[j * n + i] = th.heightAt(-WORLD_HALF + (i + 0.5) * cell, -WORLD_HALF + (j + 0.5) * cell)
    }
  }
  levels[baseDepth] = base

  for (let d = baseDepth - 1; d >= 0; d--) {
    const m = 1 << d
    const src = levels[d + 1]
    const dst = new Float32Array(m * m)
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const a = src[2 * j * 2 * m + 2 * i]
        const b = src[2 * j * 2 * m + 2 * i + 1]
        const c = src[(2 * j + 1) * 2 * m + 2 * i]
        const e = src[(2 * j + 1) * 2 * m + 2 * i + 1]
        dst[j * m + i] = (a + b + c + e) / 4
      }
    }
    levels[d] = dst
  }

  // Normalise PER LEVEL, against that level's own percentiles.
  //
  // The first version normalised every level against one pair of percentiles
  // taken from the base grid, and it did not bias anything -- it just raised
  // detail everywhere, 304 leaves to 376, with LOW ground gaining more than
  // high. The reason is what max-pooling does as you climb: a depth-3 node is
  // 2048 m across, and in a mountain world essentially every 2048 m square
  // contains something tall, so every node at that level saturated the top of
  // the range and every node got promoted. A test that answers "yes" for all
  // its inputs is not a test.
  //
  // Per-level percentiles fix it by construction: max-pooling still RANKS the
  // nodes at a level correctly (the ones with the biggest summits stay on top),
  // and re-spreading each level across 0..1 turns that ranking back into a
  // decision. Roughly half of any level now falls below the pivot, which is what
  // makes this a redistribution instead of a detail hike.
  const bands = levels.map((lv) => {
    const sorted = Float32Array.from(lv).sort()
    const q = (p) => sorted[Math.floor(p * (sorted.length - 1))]
    // 0.15/0.9 rather than 0/1: one outlier summit at either end should not own
    // the whole scale, and clamping the tails costs nothing since they are
    // already the nodes we most want fully promoted or fully demoted.
    return { lo: q(0.15), hi: q(0.9) }
  })
  return { levels, bands, baseDepth }
}

// 0..1 for how high this node's ground is relative to OTHER NODES OF ITS OWN
// SIZE. Depths below the pyramid clamp to its finest level; they are never
// biased anyway (strength is 0 there).
function elevNorm(elev, depth, ix, iz) {
  const d = Math.min(depth, elev.baseDepth)
  const shift = depth - d
  const m = 1 << d
  const h = elev.levels[d][(iz >> shift) * m + (ix >> shift)]
  const b = elev.bands[d]
  const t = (h - b.lo) / (b.hi - b.lo)
  return t < 0 ? 0 : t > 1 ? 1 : t
}

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
//
// `elev` is optional: pass a buildElevationLod() result to enable the elevation
// bias described above, or omit it for the plain distance rule. It is optional
// because the rule has to stay measurable in isolation -- check-sim.mjs sweeps
// both, and "what did the bias actually cost" is only answerable if the unbiased
// selection is still one call away.
export function selectNodes(camX, camZ, maxDepth = MAX_DEPTH, splitK = DEFAULT_SPLIT_K, elev = null) {
  const out = []

  const visit = (depth, ix, iz) => {
    const size = WORLD_SIZE / (1 << depth)
    const x = -WORLD_HALF + ix * size
    const z = -WORLD_HALF + iz * size

    let k = splitK
    if (elev) {
      const s = ELEV_LOD.swing[depth] || 0
      if (s > 0) k *= 2 ** (s * (elevNorm(elev, depth, ix, iz) - ELEV_LOD.pivot) * 2)
    }

    if (depth < maxDepth && boxDistance(camX, camZ, x, z, size) < size * k) {
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
