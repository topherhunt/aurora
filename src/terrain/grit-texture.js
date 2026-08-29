import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// THE TWO TEXTURES THE TERRAIN'S SURFACE DETAIL IS MADE OF, BAKED ONCE ON THE
// CPU INSTEAD OF EVALUATED PER FRAGMENT.
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
// now: the fields are generated once at boot into two small tileable RGBA
// images and read back with texture fetches, which is the operation a GPU has
// dedicated silicon and a cache for. Four fetches replace twenty noises in the
// worst case; one fetch replaces two in the far field.
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

// Both textures are 256 square. The number is not arbitrary at either end: it
// is what makes the coarse grit tile land on ~4.6 cm texels (see GRIT_METRES in
// terrain-material.js), and it is small enough that four decorrelated fbm grids
// generate in a few tens of milliseconds and cost 256 KB of VRAM each.
export const GRIT_SIZE = 256

// How the gradient channels are packed. The generator stores
// 0.5 + clamp( dh/du, -R, R ) / ( 2R ) with R = GRIT_GRAD_RANGE, where h is the
// equalised field in 0..1 and u is measured in TILES. The shader undoes it as
// ( gb - 0.5 ) * GRIT_GRAD_SCALE, giving dh/du back, then divides by the tile's
// size in metres to get a real slope. Keeping the round trip named here rather
// than as a bare number in the shader is the point: the two constants are one
// decision and they must move together.
//
// 16 is MEASURED, not chosen. On the shipped field |dh/du| runs p50 2.7, p90
// 8.3, p99 14.6, max 24.3, so a range of 16 clips 0.55% of texels -- the tail
// of the tail, where a clipped slope reads as a slightly flatter fleck. The
// numbers below it are worse than they look: at 8 the clip is 11% of texels,
// which is a visible plateau across every steep face. Going the other way costs
// resolution, since the pack is 8 bits: at 16 one step is 0.125 of dh/du, which
// over the 11.7 m tile is 0.2 degrees of normal tilt and invisible.
export const GRIT_GRAD_RANGE = 16
export const GRIT_GRAD_SCALE = GRIT_GRAD_RANGE * 2

// Tileable value noise on a g x g lattice, over uv in 0..1. Wrapping the
// lattice indices is the whole trick -- without the wrap every sample of these
// textures would seam along its tile edges, which on terrain means a visible
// grid at whatever the sampling scale happens to be.
//
// Same construction as preview-stage.js's bench ground, and deliberately so:
// that ground is the look this file is aiming at ("speckled pixelated Perlin
// green" was the ask, and the bench is where it already exists). It is copied
// rather than imported because preview-stage is a tuning-bench module that also
// pulls in a renderer and a lighting patch, and the game's terrain should not
// depend on a bench.
function lattice(rand, g) {
  const v = new Float32Array(g * g)
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = x * g
    const fy = y * g
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const x0 = ((ix % g) + g) % g
    const y0 = ((iy % g) + g) % g
    const x1 = (x0 + 1) % g
    const y1 = (y0 + 1) % g
    const tx = smooth(fx - ix)
    const ty = smooth(fy - iy)
    const a = v[y0 * g + x0]
    const b = v[y0 * g + x1]
    const c = v[y1 * g + x0]
    const d = v[y1 * g + x1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
}

/**
 * One fbm field, rendered into a Float32Array of size x size in 0..1.
 *
 * Rendered to a GRID rather than returned as a function on purpose: the
 * gradient channels are finite differences of this field, and differencing a
 * grid that already exists is free where re-evaluating five lattices per
 * neighbour would quadruple the generation cost.
 */
function fbmGrid(rand, size, g0, octaves, gain) {
  const layers = []
  let g = g0
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    layers.push([lattice(rand, g), amp])
    norm += amp
    g *= 2
    amp *= gain
  }
  const out = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      let s = 0
      for (const [f, a] of layers) s += f(u, v) * a
      out[y * size + x] = s / norm
    }
  }
  return out
}

/**
 * Flatten a field's histogram so its values are UNIFORM on 0..1, in place.
 *
 * This is not cosmetic and it is not optional. An fbm is a sum of independent
 * octaves, so by the central limit theorem its values pile up around the mean:
 * the raw five-octave field here measures p1 = 0.26, p50 = 0.48, p99 = 0.78. It
 * replaces a SINGLE octave of value noise, which spans nearly the whole 0..1
 * range -- and every threshold in the terrain shader was tuned against that
 * span. `smoothstep( 0.86, 1.0, x )` picks out the top few percent of a single
 * octave and picks out NOTHING at all from a raw fbm; the snow sparkle would
 * simply not exist, and the dirt and moss mottles would be a fraction of the
 * strength they were tuned to.
 *
 * Rank equalisation makes each threshold mean exactly what it reads as: after
 * this, smoothstep( 0.86, 1.0, x ) covers the top 14% of texels by
 * construction, at any octave count and any gain. Which is a stronger guarantee
 * than the noise it replaces ever gave, and it is why the shader's constants
 * could be carried across unchanged.
 *
 * Done BEFORE the gradient is differenced off, so the slope channels are the
 * slope of the field that actually ships rather than of an intermediate.
 */
function equalise(grid) {
  const order = Array.from(grid.keys()).sort((a, b) => grid[a] - grid[b])
  const last = order.length - 1
  for (let r = 0; r <= last; r++) grid[order[r]] = r / last
  return grid
}

// Central difference on a wrapped grid, in units of h per TILE. The texel
// spacing is 1/size of a tile, so the difference over two texels is divided by
// 2/size -- hence the multiply by size/2.
function gradAt(grid, size, x, y) {
  const w = (i) => ((i % size) + size) % size
  const l = grid[y * size + w(x - 1)]
  const r = grid[y * size + w(x + 1)]
  const d = grid[w(y - 1) * size + x]
  const u = grid[w(y + 1) * size + x]
  return [((r - l) * size) / 2, ((u - d) * size) / 2]
}

const pack = (v) => Math.max(0, Math.min(255, Math.round(v * 255)))

/**
 * THE GRIT TILE: the near-field surface itself.
 *
 *   R  the albedo field, QUANTISED to six steps and then speckled per texel
 *   G  0.5 + dh/du of the SMOOTH field, packed by GRIT_GRAD_RANGE
 *   B  0.5 + dh/dv, likewise
 *   A  a second, decorrelated, unquantised field
 *
 * The quantisation in R is the look, not a compression. A console of this era
 * could not afford a smooth gradient across a ground texture, and the eye reads
 * the steps as clumps rather than as an artefact -- the same judgement
 * preview-stage.js makes about the bench ground, which is the surface this was
 * asked to resemble. The per-texel speckle goes on AFTER the quantise so the
 * bands do not read as flat plates of colour.
 *
 * G and B are differenced off the field BEFORE the quantise and the speckle,
 * and that is load bearing: a gradient taken from a six-step staircase is zero
 * across each tread and enormous at every riser, which lights as a field of
 * hard-edged terraces rather than as a rough surface.
 *
 * A is separate rather than another octave of R because two layers keyed to the
 * same field stack their peaks in the same places, and the whole reason there
 * are two is to break that up: R decides how bright a speck is and A decides
 * which way it is tinted, and they should not agree.
 */
export function gritTexture() {
  const size = GRIT_SIZE
  const rand = mulberry32(0x6717)
  // Five octaves from a 4x4 lattice, so the coarsest wavelength is a quarter of
  // the tile and the finest is a sixty-fourth of it -- with the per-texel
  // speckle a further two octaves below that. Over the coarse sample's 11.7 m
  // tile that ladder is 2.9 m down to 18 cm, which is where the two layers this
  // replaces (a ~3.5 m patch noise and a ~0.5 m grain) both lived.
  const h = equalise(fbmGrid(rand, size, 4, 5, 0.5))
  const alt = equalise(fbmGrid(rand, size, 4, 5, 0.5))

  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const o = i * 4
      let n = Math.round(h[i] * 5) / 5
      n = Math.min(1, Math.max(0, n + (rand() - 0.5) * 0.18))
      const [gx, gy] = gradAt(h, size, x, y)
      data[o] = pack(n)
      data[o + 1] = pack(0.5 + gx / GRIT_GRAD_SCALE)
      data[o + 2] = pack(0.5 + gy / GRIT_GRAD_SCALE)
      data[o + 3] = pack(alt[i])
    }
  }
  return finish(data, size, THREE.NearestFilter, THREE.NearestMipmapLinearFilter)
}

/**
 * THE MACRO TILE: regional colour, and where the snow line wanders.
 *
 *   R  the region / macro value field
 *   G  a decorrelated field, used for mineral staining on rock
 *   B  a third decorrelated field, spare capacity for a future layer
 *   A  the snow-boundary displacement field
 *
 * SMOOTH, unquantised, and filtered linearly, where the grit tile is stepped
 * and filtered nearest. These layers are looked at from hundreds of metres
 * away, where a hard texel edge is a hard edge on a hillside rather than a
 * pixel, and the stepping that reads as clumps at arm's length reads as
 * contour banding at range.
 *
 * A is its own field rather than a channel of R because the snow line and the
 * grass tint must be able to disagree. They are the same shape if they share a
 * field, and a snow border that follows the dry patches is a border that looks
 * painted on.
 */
export function macroTexture() {
  const size = GRIT_SIZE
  const rand = mulberry32(0x2c4f)
  // Six octaves rather than the grit tile's five, from a 1x1 lattice rather
  // than a 4x4: this one is sampled at 1024 m and at 137 m, so its coarsest
  // wavelength has to be the whole tile to give the 1 km regions their shape,
  // and it needs one more octave underneath to reach the ~16 m mottle at the
  // fine sample.
  const r = equalise(fbmGrid(rand, size, 1, 6, 0.5))
  const g = equalise(fbmGrid(rand, size, 1, 6, 0.5))
  const b = equalise(fbmGrid(rand, size, 1, 6, 0.5))
  const a = equalise(fbmGrid(rand, size, 1, 6, 0.5))

  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    data[o] = pack(r[i])
    data[o + 1] = pack(g[i])
    data[o + 2] = pack(b[i])
    data[o + 3] = pack(a[i])
  }
  return finish(data, size, THREE.LinearFilter, THREE.LinearMipmapLinearFilter)
}

// NoColorSpace, and this is the one line in the file that would fail silently
// and look like a tuning problem. Every channel here is a FIELD -- a 0..1
// weight, a packed derivative -- and not one of them is a colour. Tagging the
// texture sRGB would put three.js's decode on the fetch, which would bend the
// value field through a gamma curve, recentre the gradient channels away from
// 0.5, and leave the terrain looking merely mis-tuned.
function finish(data, size, magFilter, minFilter) {
  const tex = new THREE.DataTexture(data, size, size)
  tex.colorSpace = THREE.NoColorSpace
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = magFilter
  tex.minFilter = minFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

// ONE PAIR FOR THE WHOLE WORLD, built on first use. createTerrainMaterial is
// called by v1's terrain, v2's terrain, the macro diagnostic mesh and three
// gates; they all want the same fields, and generating them per material would
// pay the ~60 ms of lattice arithmetic and the 512 KB of VRAM once per caller
// for identical bytes.
let cached = null

export function terrainDetailTextures() {
  if (!cached) cached = { grit: gritTexture(), macro: macroTexture() }
  return cached
}
