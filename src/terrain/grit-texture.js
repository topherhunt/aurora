import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { GRIT_LAYER_COUNT, GRIT_SIZE, gradAt, gritData, macroData, pack } from './grit-fields.js'

// ---------------------------------------------------------------------------
// THE TEXTURES THE TERRAIN'S SURFACE DETAIL IS MADE OF, BAKED ONCE ON THE CPU
// INSTEAD OF EVALUATED PER FRAGMENT.
//
// This file exists because of one measurement. With the terrain hidden the
// headset holds 85 fps; with the terrain drawn and its stock Lambert material
// it still holds 85; with the terrain drawn and the patched material it falls
// to 30. Same meshes, same triangles, same draw calls, same fog, same lights --
// the ONLY difference is the fragment shader. So the terrain was never triangle
// bound and the LOD work could not have fixed it: it was fill bound, and the
// bill was being run up inside a single `#include <color_fragment>` patch.
//
// What that patch was doing, per fragment, in the near field: about twenty
// evaluations of a hash-based value noise. Each one is four hashes and each
// hash is three integer multiplies, so twenty noises is roughly 240 integer
// multiplies plus the shifts, xors and interpolations around them -- on an
// Adreno, where integer multiply is slower than the float ops it replaced. That
// arithmetic bought seven distinct layers (a four-octave snow-line dither, a
// three-octave macro/region tint, a two-octave grain, a sparkle, a fleck tint
// and two octaves of normal relief), every one of which is some band-limited
// noise field sampled at world XZ.
//
// A band-limited noise field sampled at world XZ is a TEXTURE. So it is one
// now: the fields are generated once at boot into a three-layer tileable RGBA
// array (one layer per surface) plus one RGBA macro tile, and read back with
// texture fetches, which is the operation a GPU has dedicated silicon and a
// cache for. Four fetches replace twenty noises in the worst case; one fetch
// replaces two in the far field.
//
// WHAT IS LOST, honestly: a tileable texture repeats and world-space noise does
// not. That is bought back three ways rather than hidden -- the two textures are
// sampled at FOUR scales whose ratios are deliberately not small integers, so
// the combined pattern's period is the least common multiple of numbers that do
// not have one; the finer sample of each pair is rotated ~37 degrees off the
// coarser, so the two lattices do not line up; and the layers that survive
// furthest are the coarsest, where one repeat is 1 km and the fog has taken the
// contrast out long before a second one is on screen.
//
// WHAT IS GAINED beyond the fill rate: mipmaps. The old noise layers each
// needed a hand-tuned distance fade whose only job was to stop a sub-pixel
// feature aliasing into shimmer. A mipped texture does that for free and
// exactly, and the fades that remain are there to stop PAYING for a fetch
// rather than to hide a crawl.
// ---------------------------------------------------------------------------

export { GRIT_SIZE, GRIT_GRAD_RANGE, GRIT_GRAD_SCALE, GRIT_LAYER, GRIT_LAYER_COUNT } from './grit-fields.js'

/** The three-layer grit array (grit-fields.js), from `computed` when the worker made it. */
export function gritArrayTexture(computed = gritData()) {
  const size = GRIT_SIZE
  const { data, clip } = computed
  if (clip.some((c) => c > 0.02)) {
    console.warn(
      `[grit] gradient clipping over 2%: grass ${(clip[0] * 100).toFixed(2)}%, ` +
        `rock ${(clip[1] * 100).toFixed(2)}%, snow ${(clip[2] * 100).toFixed(2)}% ` +
        '-- raise GRIT_GRAD_RANGE'
    )
  }

  const tex = new THREE.DataArrayTexture(data, size, size, GRIT_LAYER_COUNT)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  applyFieldSampling(tex, THREE.NearestFilter, THREE.NearestMipmapLinearFilter)
  return tex
}

/** The macro tile (grit-fields.js macroData), from `data` when the worker made it. */
export function macroTexture(data = macroData()) {
  const tex = new THREE.DataTexture(data, GRIT_SIZE, GRIT_SIZE)
  applyFieldSampling(tex, THREE.LinearFilter, THREE.LinearMipmapLinearFilter)
  return tex
}

// NoColorSpace, and this is the one line in the file that would fail silently
// and look like a tuning problem. Every channel here is a FIELD -- a 0..1
// weight, a packed derivative -- and not one of them is a colour. Tagging the
// texture sRGB would put three.js's decode on the fetch, which would bend the
// value field through a gamma curve, recentre the gradient channels away from
// 0.5, and leave the terrain looking merely mis-tuned.
function applyFieldSampling(tex, magFilter, minFilter) {
  tex.colorSpace = THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = magFilter
  tex.minFilter = minFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// THE STIPPLE TILE: the one field the plain-stipple rung lays over every face
// (terrain-material.js, createPlainTerrainMaterial). Its own bake rather than a
// layer of the grit array because it wants the opposite of everything above:
// no quantise (each riser is a hard edge, and per-face tiling puts hundreds of
// them in the near field), no speckle, no lattice (value noise's grid shows in
// the gradient as crosses), no feature anywhere near the tile size (a blotch a
// third of a tile wide is a visible repeat at 2x2), and LINEAR filtering.
//
// So it is blurred white noise at three radii, summed: isotropic, no grid,
// nothing bigger than about 1/10 of the tile. Wrapped convolution keeps it
// seamless. Each radius is normalised to unit variance before the sum, because
// a blur eats variance in proportion to its radius and the weights below are
// meant as weights.
//
//   R   the field through a tanh, 0..1: the 1st..99th percentiles reach about
//       0.05..0.95 and the rarer extremes squash instead of clipping, because a
//       clipped white speck is a landmark the eye finds again in the next tile
//   GB  0.5 + 0.5 * (dh/du, dh/dv) / p99|grad| -- so (gb - 0.5) * 2 is a unit
//       slope and the shader's bump uniform is the tilt at that slope
//   A   255
export const STIPPLE_SIZE = 256
const STIPPLE_SPEC = [
  { sigma: 1.5, weight: 0.4 },
  { sigma: 3, weight: 0.35 },
  { sigma: 6, weight: 0.25 },
]

function blurredNoise(rand, size, sigma) {
  const radius = Math.ceil(sigma * 3)
  const kernel = new Float32Array(radius * 2 + 1)
  let ksum = 0
  for (let i = -radius; i <= radius; i++) ksum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum
  const w = (i) => ((i % size) + size) % size
  const src = new Float32Array(size * size)
  for (let i = 0; i < src.length; i++) src[i] = rand() - 0.5
  const tmp = new Float32Array(size * size)
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += src[y * size + w(x + k)] * kernel[k + radius]
      tmp[y * size + x] = s
    }
  }
  let sq = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += tmp[w(y + k) * size + x] * kernel[k + radius]
      out[y * size + x] = s
      sq += s * s
    }
  }
  const inv = 1 / Math.sqrt(sq / out.length)
  for (let i = 0; i < out.length; i++) out[i] *= inv
  return out
}

const percentile = (values, p) => {
  const sorted = Float32Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))]
}

export function stippleTexture() {
  const size = STIPPLE_SIZE
  const rand = mulberry32(0x5717)
  const h = new Float32Array(size * size)
  for (const { sigma, weight } of STIPPLE_SPEC) {
    const f = blurredNoise(rand, size, sigma)
    for (let i = 0; i < h.length; i++) h[i] += f[i] * weight
  }
  const hi = percentile(h, 0.99)
  const k = Math.atanh(0.9) / hi
  for (let i = 0; i < h.length; i++) h[i] = 0.5 + 0.5 * Math.tanh(h[i] * k)

  const grad = new Float32Array(size * size * 2)
  const mags = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [gx, gy] = gradAt(h, size, x, y)
      const i = y * size + x
      grad[i * 2] = gx
      grad[i * 2 + 1] = gy
      mags[i] = Math.hypot(gx, gy)
    }
  }
  const gmax = percentile(mags, 0.99)

  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = pack(h[i])
    data[i * 4 + 1] = pack(0.5 + (0.5 * grad[i * 2]) / gmax)
    data[i * 4 + 2] = pack(0.5 + (0.5 * grad[i * 2 + 1]) / gmax)
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  return applyFieldSampling(tex, THREE.LinearFilter, THREE.LinearMipmapLinearFilter)
}

let stippleCached = null

export function stippleTile() {
  if (!stippleCached) stippleCached = stippleTexture()
  return stippleCached
}

// ONE PAIR FOR THE WHOLE WORLD, built on first use. createTerrainMaterial is
// called by v1's terrain, v2's terrain, the macro diagnostic mesh and three
// gates; they all want the same fields, and generating them per material would
// pay the ~60 ms of lattice arithmetic and the 512 KB of VRAM once per caller
// for identical bytes.
// preloadTerrainDetail computes the pair in grit-worker.js from the start of the boot, off the main thread; without it the first terrainDetailTextures() computes it here (gates, benches).
let cached = null
let preload = null

export function preloadTerrainDetail() {
  if (cached !== null) return Promise.resolve(cached)
  if (preload === null) {
    const worker = new Worker(new URL('./grit-worker.js', import.meta.url), { type: 'module' })
    preload = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        worker.terminate()
        cached = { grit: gritArrayTexture(data.grit), macro: macroTexture(data.macro) }
        resolve(cached)
      }
      worker.onerror = (e) => {
        worker.terminate()
        reject(new Error(`grit-worker: ${e.message}`))
      }
    })
  }
  return preload
}

export function terrainDetailTextures() {
  if (cached !== null) return cached
  if (preload !== null) throw new Error('terrainDetailTextures: the worker has not finished; await preloadTerrainDetail() first')
  cached = { grit: gritArrayTexture(), macro: macroTexture() }
  return cached
}
