import { clamp01, lerp, smoothstep } from './mathx.js'

// ---------------------------------------------------------------------------
// Chunk mesh generation. Pure math, no three.js and no worker globals, so it
// can be exercised in Node -- see scripts/check-sim.mjs.
// ---------------------------------------------------------------------------

// Grid cells per chunk edge. Lives here rather than in terrain.js so the Node
// checks and the renderer cannot disagree about chunk size -- and they must
// not, because terrain.js pre-allocates fixed-size GPU slots from it.
//
// Chosen with quadtree.js's MAX_DEPTH and DEFAULT_SPLIT_K as one decision; see
// the note there. 16 gives 640 tris/chunk and 1.00 m leaf cells.
export const CHUNK_RES = 16

// Placeholder surface colour. The real terrain material is §7 (splat blending,
// height-blend, triplanar) and lands at build step 6. This exists so terrain
// SHAPE is legible during step 2 -- flat grey terrain hides exactly the cliffs
// and gorges we are trying to tune.
//
// These are LINEAR values and the first pass had them far too high: linear 0.33
// is sRGB 0.60, which with a 2.1-intensity sun on top came out as a pale mint
// green. Roughly linear 0.05 -> sRGB 0.25, and that is the range dark gritty
// ground actually lives in.
//
// Only the base classification lives here. The dirt-and-moss mottling and the
// fine speckle are in terrain/terrain-material.js, in the fragment shader,
// because anything baked per-vertex would rescale itself at every LOD ring.
// Grass is deliberately green-dominant: the shader classifies "is this ground
// vegetated" off exactly that, so do not neutralise it.
const C_GRASS = [0.048, 0.088, 0.03]
const C_SCRUB = [0.075, 0.07, 0.042]
const C_ROCK = [0.085, 0.082, 0.078]
const C_SNOW = [0.86, 0.88, 0.93]

function shade(h, ny, out, o) {
  // ny is the normal's Y component: 1 = flat, 0 = vertical.
  const steep = smoothstep(0.86, 0.62, ny)
  // Both bands track the world's actual elevation range, so they have to be
  // re-read off `node scripts/probe-terrain.mjs` whenever TUNING moves -- a band
  // written for the previous relief silently puts snow nowhere at all, which has
  // now happened twice. Current probe: ground p10 170, p25 214, median 276,
  // p75 350, p90 415, p99 512, max 661. The green-to-scrub ramp spans roughly
  // p25..p90 so that most of the walkable world gets some of the gradient.
  const alt = clamp01((h - 214) / 200)

  let r = lerp(C_GRASS[0], C_SCRUB[0], alt)
  let g = lerp(C_GRASS[1], C_SCRUB[1], alt)
  let b = lerp(C_GRASS[2], C_SCRUB[2], alt)

  // Snow accumulates with altitude but not on near-vertical faces -- it slides
  // off. Without that term the cliffs read as white walls and all the relief
  // we just generated becomes invisible.
  //
  // 295..390 is a compromise between two failure modes that pull opposite ways,
  // and the sweep behind it is worth keeping: at a 260 m line 57% of the map is
  // white, which stops reading as a snow line at all; at 420 m only 9% is, and
  // the straight-line gap between one patch of snow and the next runs 4.1 km at
  // p90, which is the "you can walk for kilometres without crossing any snow"
  // complaint. 295 starts the dusting where ~41% of the map can catch some and
  // the median gap is ~370 m; full cover at 390 keeps solid white to the top
  // sixth. The soft band between them is what makes it look like a snow line
  // rather than a contour: the same-shaped peak is white in the high country
  // and bare in the low, because the regional swell moves it across the ramp.
  const snow = clamp01(smoothstep(295, 390, h) * (1 - steep * 0.85))
  r = lerp(r, C_ROCK[0], steep)
  g = lerp(g, C_ROCK[1], steep)
  b = lerp(b, C_ROCK[2], steep)
  r = lerp(r, C_SNOW[0], snow)
  g = lerp(g, C_SNOW[1], snow)
  b = lerp(b, C_SNOW[2], snow)

  out[o] = r
  out[o + 1] = g
  out[o + 2] = b
}

export function buildChunk(terrain, { ox, oz, size, res }) {
  const step = size / res
  const vpr = res + 1 // vertices per row
  const innerCount = vpr * vpr
  const skirtCount = 4 * vpr
  const total = innerCount + skirtCount

  // Sample one extra ring on every side so edge normals are computed from real
  // neighbours rather than clamped ones. Without this, adjacent chunks disagree
  // about their shared edge normal and a lighting seam appears at every join.
  const epr = res + 3
  const H = new Float32Array(epr * epr)
  for (let j = 0; j < epr; j++) {
    const wz = oz + (j - 1) * step
    for (let i = 0; i < epr; i++) {
      H[j * epr + i] = terrain.heightAt(ox + (i - 1) * step, wz)
    }
  }

  const positions = new Float32Array(total * 3)
  const normals = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)

  let minY = Infinity
  let maxY = -Infinity

  for (let j = 0; j <= res; j++) {
    for (let i = 0; i <= res; i++) {
      const vi = j * vpr + i
      const e = (j + 1) * epr + (i + 1)
      const h = H[e]
      if (h < minY) minY = h
      if (h > maxY) maxY = h

      const o = vi * 3
      // Local coordinates; the mesh is positioned at the chunk origin. Keeping
      // vertex values small preserves float precision 8 km from the origin.
      positions[o] = i * step
      positions[o + 1] = h
      positions[o + 2] = j * step

      const dx = (H[e + 1] - H[e - 1]) / (2 * step)
      const dz = (H[e + epr] - H[e - epr]) / (2 * step)
      const len = Math.hypot(dx, 1, dz)
      const nx = -dx / len
      const ny = 1 / len
      const nz = -dz / len
      normals[o] = nx
      normals[o + 1] = ny
      normals[o + 2] = nz

      shade(h, ny, colors, o)
    }
  }

  const idx = (i, j) => j * vpr + i

  // Skirts (DESIGN.md §5): vertical flanges hiding the cracks between LOD
  // levels. Far simpler than stitching neighbouring resolutions and invisible
  // in practice, because you only ever see them edge-on across a crack.
  //
  // Depth scales with cell size: coarse chunks have bigger vertical gaps to
  // hide, and a fixed depth would either be visible on leaves or too short on
  // the root.
  const skirtDepth = Math.max(2, step * 3)

  // Each edge is traversed in the direction that makes the generated triangles
  // face outward. With e1 = travel direction and e2 = (0,-depth,0), the face
  // normal works out to (dz, 0, -dx), so: north needs dx=+1, south dx=-1,
  // west dz=-1, east dz=+1. Getting this wrong makes skirts invisible from
  // outside, which is the only place they are ever seen.
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
  const skirtIndex = [] // parallel to edges: the skirt vertex for each inner vertex
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

  const triCount = res * res * 2 + 4 * res * 2
  const indices = new Uint16Array(triCount * 3)
  let k = 0

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = idx(i, j)
      const b = idx(i + 1, j)
      const c = idx(i, j + 1)
      const d = idx(i + 1, j + 1)
      indices[k++] = a
      indices[k++] = c
      indices[k++] = b
      indices[k++] = b
      indices[k++] = c
      indices[k++] = d
    }
  }

  for (let e = 0; e < 4; e++) {
    const edge = edges[e]
    const skirt = skirtIndex[e]
    for (let n = 0; n < edge.length - 1; n++) {
      const cur = edge[n]
      const next = edge[n + 1]
      const sCur = skirt[n]
      const sNext = skirt[n + 1]
      indices[k++] = cur
      indices[k++] = next
      indices[k++] = sCur
      indices[k++] = next
      indices[k++] = sNext
      indices[k++] = sCur
    }
  }

  if (k !== indices.length) {
    throw new Error(`index count mismatch: wrote ${k}, allocated ${indices.length}`)
  }

  return { positions, normals, colors, indices, minY, maxY, skirtDepth }
}
