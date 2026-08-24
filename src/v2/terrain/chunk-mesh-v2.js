import { clamp01, lerp, smoothstep } from '../../sim/mathx.js'
import { CHUNK_VERTS, CHUNK_INDICES } from '../config.js'

// ---------------------------------------------------------------------------
// The v2 chunk mesher. Pure math -- no three.js, no worker globals -- so it runs
// under node in scripts/check-v2-field.mjs. It lives under terrain/ rather than
// height/ only because the renderer is its sole caller.
//
// This is v1's src/sim/chunk-mesh.js grown a content-layer branch. Four things
// carried across unchanged in substance, each of which was paid for once and
// should not be rediscovered:
//
//   THE EXTRA SAMPLING RING. Heights are taken one cell outside the chunk on
//   every side so edge normals come from real neighbours. Without it two
//   adjacent chunks compute different normals for the same shared edge and a
//   lighting seam runs along every chunk join, brightest exactly where the sun
//   is lowest -- which in this game is most of the time.
//
//   SKIRTS. Vertical flanges hiding the crack between two LOD levels, with the
//   winding worked out per edge so they face outward; see `edges` below. Far
//   simpler than stitching resolutions and invisible in practice, because a
//   skirt is only ever seen edge-on through the crack it is filling.
//
//   THE SHORTER DIAGONAL. Every quad has to pick a diagonal and picking the same
//   one everywhere is visible: vertex colours interpolate along triangle edges,
//   so a snow-to-rock boundary can only run straight along the chosen diagonal
//   and staircases across it. Connecting the two corners closest in height also
//   happens to be the better surface, because splitting a saddle the wrong way
//   invents a ridge that is not in the field.
//
//   THE FIXED-WORLD-SCALE CLASSIFICATION SLOPE. See CLASS_EPS. This is the fix
//   for "coarsening a chunk REPAINTED it and the world flashed white in
//   chunk-shaped squares", and v2 needs it more than v1 did, not less.
//
// New in v2, and both are §18 claims rather than conveniences:
//
//   PER-CHUNK LAYER CULLING. One `layers.overlaps` call decides whether this
//   chunk's 361 samples walk the carve chain or skip it entirely.
//
//   A PER-CHUNK BAND LIMIT. `cell = size / res` goes into every field query,
//   including the ring's, so the octaves a chunk's triangles cannot resolve fade
//   out instead of aliasing.
// ---------------------------------------------------------------------------

// v1's palette, unchanged, and the values are LINEAR. The first pass had them
// far too high -- linear 0.33 is sRGB 0.60, which under a 2.1-intensity sun came
// out a pale mint green. Dark gritty ground lives near linear 0.05.
//
// Grass is deliberately green-dominant: terrain-material.js classifies "is this
// ground vegetated" off exactly that, so do not neutralise it.
const C_GRASS = [0.048, 0.088, 0.03]
const C_SCRUB = [0.075, 0.07, 0.042]
const C_ROCK = [0.085, 0.082, 0.078]
const C_SNOW = [0.86, 0.88, 0.93]

// New in v2. Packed earth, for ground a road or a carved lake bed has flattened.
// Warmer and lighter than C_SCRUB and much less saturated than C_GRASS, so a
// road reads as a line of bare ground through vegetation rather than as
// suspiciously smooth grass -- which is what flattening alone looks like, and
// was the first thing anyone noticed about an early road.
const C_DIRT = [0.070, 0.058, 0.041]

// How far toward C_DIRT fully-flattened ground goes. Not 1.0: a road surface
// that ignores altitude entirely reads as a decal pasted over the terrain, and
// keeping 15% of the underlying colour lets a road high on a mountain stay
// visibly paler than the same road in a valley.
const DIRT_MAX = 0.85

// THE ALTITUDE RAMP IS NOT IN THIS FILE, and that is the point.
//
// v1 hardcodes clamp01((h - 107) / 100), tuned against v1's own relief, and its
// own comment records that a band written for the previous relief silently puts
// snow nowhere at all and that this has already happened twice. The failure mode
// is not a crash: the world renders, nothing looks broken, the mountains are
// simply the wrong colour and nobody can say why.
//
// §18's premise is that the coarse shape is an IMPORT and a human replaces it.
// During this build alone the world went 16 km at 16 m texels, to 4 km at 4 m,
// to 8 km at 8 m, with the vertical range still being surveyed off the source
// jpg -- an 8-bit image, which carries no metres at all, so its min and max are
// CHOSEN at bake time. Any literal here would be a number describing a world
// that is no longer being rendered, and it would look plausible while being
// wrong.
//
// So `altLo` and `altSpan` arrive from V2Height.bands, measured off whatever
// image is loaded (p25 and p90 of its texels). When the vertical range lands the
// shading follows it with no second edit pass, and check-v2-field asserts the
// RELATIONSHIPS -- ramp monotone, anchors inside the relief, snow line above the
// ramp's foot -- rather than any value.

// Half-width of the stencil the SURFACE CLASSIFICATION measures slope over, in
// metres, and the reason it is a fixed world distance rather than the chunk's
// own cell.
//
// shade() decides rock-vs-grass and, far more visibly, snow-vs-no-snow off
// steepness. The mesh normal is a central difference over the chunk's OWN cell,
// and in v2 that ranges from 6.25 cm at a leaf to 512 m at the root -- a factor
// of 8192. An alpine face standing at 74 deg over a metre averages to 24 deg
// over 128 m, so the identical ground classified itself as bare rock up close
// and as solid snow from far away, and since chunks coarsen one at a time as you
// fly away the world flashed white in chunk-shaped squares. Measuring over a
// fixed world distance instead makes the colour a function of position alone.
//
// 1.0 m, which is half of LOCOMOTION.stride's 1.5 m -- so the steepness the
// shader paints and the steepness the slope limiter refuses are measured at
// nearly the same scale, and ground drawn as rock is ground she cannot climb.
// The two ramps are one decision: LOCOMOTION.maxSlopeDeg 50 was DERIVED from
// shade()'s smoothstep(0.86, 0.62, ny) below. Moving either moves both.
//
// v1 SKIPS this stencil whenever `step <= CLASS_EPS`, on the grounds that for a
// leaf the mesh normal already IS the fixed-scale slope. That argument holds
// only where step EQUALS CLASS_EPS, which in v1 was true of the leaf by
// construction. It is false in v2: below a metre the field still has real
// energy -- that is what detail.js is for -- so a 6.25 cm central difference
// reports a systematically steeper slope than a 1 m one, and taking the skip
// would reintroduce the very repaint it was written to fix, running the other
// way (fine chunks too dark rather than coarse chunks too white). So the skip
// here is an EQUALITY, and it costs four extra field evaluations per vertex at
// every other depth. Those four are cheap: they are taken at cell = CLASS_EPS,
// which fades out every octave below 4 m, so a classification sample runs about
// eight simplex octaves against the geometry sample's twelve.
const CLASS_EPS = 1.0

// The chunk's own AABB has to be grown before asking the layers whether anything
// touches it, and the amount is set by THIS FILE's stencils, not by the layers':
// every layer already pads its own index entries by its own reach (a path's
// swept box by halfWidth + feather, a snow point by its radius, a lake by its
// box, outside which the footprint is exactly zero). What the layers cannot know
// about is that the mesher reads one cell outside the chunk for the normal ring
// and another CLASS_EPS outside that for the classification slope.
const cullMargin = (step) => step + CLASS_EPS

// Vertex colour. v1's construction -- alt ramp, then rock over it by steepness,
// then snow over that -- with the dirt blend appended.
//
// `ny` is the Y component of the CLASSIFICATION normal, not the mesh normal.
// Feeding the mesh normal in here was the bug in the CLASS_EPS banner above.
function shade(h, ny, snowLine, snowBand, flatten01, altLo, altSpan, out, o) {
  const steep = smoothstep(0.86, 0.62, ny)
  const alt = clamp01((h - altLo) / altSpan)

  let r = lerp(C_GRASS[0], C_SCRUB[0], alt)
  let g = lerp(C_GRASS[1], C_SCRUB[1], alt)
  let b = lerp(C_GRASS[2], C_SCRUB[2], alt)

  // Snow accumulates with altitude but slides off near-vertical faces. Without
  // that term the cliffs read as white walls and all the relief goes invisible.
  // The soft band is what makes it a snow LINE rather than a contour: the same
  // peak is white in the high country and bare in the low.
  const snow = clamp01(smoothstep(snowLine, snowLine + snowBand, h) * (1 - steep * 0.85))
  r = lerp(r, C_ROCK[0], steep)
  g = lerp(g, C_ROCK[1], steep)
  b = lerp(b, C_ROCK[2], steep)
  r = lerp(r, C_SNOW[0], snow)
  g = lerp(g, C_SNOW[1], snow)
  b = lerp(b, C_SNOW[2], snow)

  // LAST, after snow: a road above the snow line is a road that has been
  // cleared, and a road that disappears under the snow layer is a road the
  // player cannot follow to the pass it was drawn to reach.
  if (flatten01 > 0) {
    const t = flatten01 * DIRT_MAX
    r = lerp(r, C_DIRT[0], t)
    g = lerp(g, C_DIRT[1], t)
    b = lerp(b, C_DIRT[2], t)
  }

  out[o] = r
  out[o + 1] = g
  out[o + 2] = b
}

/**
 * @param {V2Height} field
 * @param {Layers} layers
 * @param {{ox:number, oz:number, size:number, res:number}} spec
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array, indices:Uint16Array, minY:number, maxY:number, skirtDepth:number, culled:boolean}}
 */
export function buildChunkV2(field, layers, { ox, oz, size, res }) {
  const step = size / res
  const vpr = res + 1
  const innerCount = vpr * vpr
  const total = innerCount + 4 * vpr
  const triCount = res * res * 2 + 4 * res * 2

  // terrain-v2.js pre-allocates one fixed-size BatchedMesh slot per chunk from
  // CHUNK_VERTS / CHUNK_INDICES and recycles a freed slot for whatever arrives
  // next, so a chunk of a different size is not a smaller chunk -- it is memory
  // corruption in the shape of terrain. Throw here, at the one place that knows
  // both numbers.
  if (total !== CHUNK_VERTS) throw new Error(`buildChunkV2: res ${res} yields ${total} vertices, config CHUNK_VERTS is ${CHUNK_VERTS}`)
  if (triCount * 3 !== CHUNK_INDICES) throw new Error(`buildChunkV2: res ${res} yields ${triCount * 3} indices, config CHUNK_INDICES is ${CHUNK_INDICES}`)

  // THE PER-CHUNK CULL. One index query decides for all 361 samples.
  //
  // The margin covers this file's own stencils; the layers pad their own reach.
  // Conservative in the right direction: over-reporting costs one chunk a
  // pointless carve pass, under-reporting leaves a river half-carved with a hard
  // edge at the chunk boundary.
  const m = cullMargin(step)
  const touched = layers.overlaps(ox - m, oz - m, ox + size + m, oz + size + m)

  // Selected ONCE per chunk, not per vertex. The culled path never enters
  // Layers at all -- not flattenAt, not carve, not one Map lookup.
  const heightAtCell = touched
    ? (x, z) => field.heightAt(x, z, step)
    : (x, z) => field.baseAt(x, z, step)
  const heightAtClass = touched
    ? (x, z) => field.heightAt(x, z, CLASS_EPS)
    : (x, z) => field.baseAt(x, z, CLASS_EPS)

  // One extra ring on every side, sampled at THE SAME cell as the interior. Two
  // different band limits either side of a chunk edge would put back exactly the
  // seam the ring exists to remove, with the added insult that it would only
  // appear on chunk boundaries where the LOD changes.
  const epr = res + 3
  const H = new Float32Array(epr * epr)
  for (let j = 0; j < epr; j++) {
    const wz = oz + (j - 1) * step
    for (let i = 0; i < epr; i++) {
      H[j * epr + i] = heightAtCell(ox + (i - 1) * step, wz)
    }
  }

  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)

  let minY = Infinity
  let maxY = -Infinity

  // Bit-identical reuse, not an approximation: when the cell equals the stencil
  // width, the ring's central difference IS the classification central
  // difference, same four samples at the same band limit.
  const reuseMeshNormal = step === CLASS_EPS
  const snowBand = layers.snow.band
  // Hoisted: `bands` is a lazy percentile pass over the whole texel array, and
  // reading the getter per vertex would hide a Map-shaped property lookup inside
  // the innermost loop of the only function whose ms/chunk anyone measures.
  const { altLo, altSpan } = field.bands

  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const vi = j * vpr + i
      const e = (j + 1) * epr + (i + 1)
      const h = H[e]
      if (h < minY) minY = h
      if (h > maxY) maxY = h

      const o = vi * 3
      // Chunk-local coordinates; the mesh is positioned at the chunk origin.
      // Keeping vertex values small is what preserves float precision two
      // kilometres from the world centre.
      positions[o] = i * step
      positions[o + 1] = h
      positions[o + 2] = j * step

      const dx = (H[e + 1] - H[e - 1]) / (2 * step)
      const dz = (H[e + epr] - H[e - epr]) / (2 * step)
      const len = Math.hypot(dx, 1, dz)
      const ny = 1 / len
      normals[o] = -dx / len
      normals[o + 1] = ny
      normals[o + 2] = -dz / len

      const wx = ox + i * step
      const wz = oz + j * step

      let nyClass = ny
      if (!reuseMeshNormal) {
        const gx = (heightAtClass(wx + CLASS_EPS, wz) - heightAtClass(wx - CLASS_EPS, wz)) / (2 * CLASS_EPS)
        const gz = (heightAtClass(wx, wz + CLASS_EPS) - heightAtClass(wx, wz - CLASS_EPS)) / (2 * CLASS_EPS)
        nyClass = 1 / Math.hypot(gx, 1, gz)
      }

      shade(h, nyClass, field.snowLineAt(wx, wz), snowBand, touched ? layers.flattenAt(wx, wz) : 0, altLo, altSpan, colors, o)
    }
  }

  const idx = (i, j) => j * vpr + i

  // Skirt depth scales with cell size -- coarse chunks have bigger vertical gaps
  // to hide -- with a 2 m floor so a leaf's 6.25 cm cell does not produce a 19 cm
  // flange that a one-level LOD difference can see straight past.
  const skirtDepth = Math.max(2, step * 3)

  // Each edge is traversed in the direction that makes its triangles face
  // outward. With e1 = travel direction and e2 = (0, -depth, 0) the face normal
  // is (dz, 0, -dx), so north needs dx = +1, south dx = -1, west dz = -1, east
  // dz = +1. Getting this wrong makes the skirts invisible from outside, which
  // is the only place they are ever seen.
  const edges = []
  {
    const north = []
    for (let i = 0; i <= res; i++) north.push(idx(i, 0))
    const south = []
    for (let i = res; i >= 0; i--) south.push(idx(i, res))
    const west = []
    for (let j = res; j >= 0; j--) west.push(idx(0, j))
    const east = []
    for (let j = 0; j <= res; j++) east.push(idx(res, j))
    edges.push(north, south, west, east)
  }

  let sv = innerCount
  const skirtIndex = []
  for (const edge of edges) {
    const row = []
    for (const vi of edge) {
      const o = sv * 3
      positions[o] = positions[vi * 3]
      positions[o + 1] = positions[vi * 3 + 1] - skirtDepth
      positions[o + 2] = positions[vi * 3 + 2]
      normals[o] = normals[vi * 3]
      normals[o + 1] = normals[vi * 3 + 1]
      normals[o + 2] = normals[vi * 3 + 2]
      colors[o] = colors[vi * 3]
      colors[o + 1] = colors[vi * 3 + 1]
      colors[o + 2] = colors[vi * 3 + 2]
      row.push(sv)
      sv++
    }
    skirtIndex.push(row)
  }

  const indices = new Uint16Array(triCount * 3)
  let k = 0

  // Shorter diagonal per quad -- see the banner. Data-dependent, so the pattern
  // is irregular and a colour boundary wanders instead of stepping.
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = idx(i, j)
      const b = idx(i + 1, j)
      const c = idx(i, j + 1)
      const d = idx(i + 1, j + 1)
      if (Math.abs(positions[a * 3 + 1] - positions[d * 3 + 1]) <
          Math.abs(positions[b * 3 + 1] - positions[c * 3 + 1])) {
        indices[k++] = a
        indices[k++] = d
        indices[k++] = b
        indices[k++] = a
        indices[k++] = c
        indices[k++] = d
      } else {
        indices[k++] = a
        indices[k++] = c
        indices[k++] = b
        indices[k++] = b
        indices[k++] = c
        indices[k++] = d
      }
    }
  }

  for (let e = 0; e < 4; e++) {
    const edge = edges[e]
    const skirt = skirtIndex[e]
    for (let n = 0; n < edge.length - 1; n++) {
      indices[k++] = edge[n]
      indices[k++] = edge[n + 1]
      indices[k++] = skirt[n]
      indices[k++] = edge[n + 1]
      indices[k++] = skirt[n + 1]
      indices[k++] = skirt[n]
    }
  }

  if (k !== indices.length) throw new Error(`buildChunkV2: index count mismatch, wrote ${k} of ${indices.length}`)

  // `culled` travels with the mesh so the panel and the gate can report the
  // fraction of chunks that took the cheap path -- §18 puts a number on that
  // claim rather than asserting it.
  return { positions, normals, colors, indices, minY, maxY, skirtDepth, culled: !touched }
}

export { CLASS_EPS, cullMargin, shade }
