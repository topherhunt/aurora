import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'

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

// Every layer here is 256 square. The number is not arbitrary at either end: it
// is what makes the coarse grit tile land on ~4.6 cm texels (see GRIT_METRES in
// terrain-material.js), and it is small enough that the ten decorrelated fbm
// grids behind the four tiles generate in about 0.15 s at boot. The
// whole set is 1 MB of VRAM: 256 KB for the macro tile and 256 KB per grit
// layer.
export const GRIT_SIZE = 256

// How the gradient channels are packed. The generator stores
// 0.5 + clamp( dh/du, -R, R ) / ( 2R ) with R = GRIT_GRAD_RANGE, where h is the
// equalised field in 0..1 and u is measured in TILES. The shader undoes it as
// ( gb - 0.5 ) * GRIT_GRAD_SCALE, giving dh/du back, then divides by the tile's
// size in metres to get a real slope. Keeping the round trip named here rather
// than as a bare number in the shader is the point: the two constants are one
// decision and they must move together.
//
// 32 is MEASURED, not chosen. Measured |dh/du| on the three shipped fields,
// after each spec's `relief` factor, and the share each range would clip:
//
//            mean   p50    p90    p99     @16     @24     @32
//   grass    4.86   3.4   11.4   19.7   3.10%   0.20%   0.02%
//   rock     4.77   3.6   10.7   19.5   2.51%   0.22%   0.00%
//   snow     4.66   2.9   11.4   24.5   4.70%   1.09%   0.28%
//
// SNOW sets it: its drift field is stretched 2.2:1, and a stretched lattice is
// steep across the grain wherever it is gentle along it, so its p99 runs well
// above the other two's. 16 was right for the single smooth field this replaced
// and is wrong now -- it flattens 4.7% of every drift, and a clipped slope is a
// PLATEAU, a facet of dead-flat lighting in the middle of a rough surface,
// which is the one artefact this layer exists to avoid. 24 still costs snow a
// full percent. 32 puts all three in the tail of the tail.
//
// What it costs is resolution, since the pack is 8 bits: one step is 0.251 of
// dh/du, which over the 11.7 m tile at uRelief is 0.4 degrees of normal tilt.
// That is double what 16 gave and still under the ~1 degree where banding on a
// smooth slope starts to be visible.
export const GRIT_GRAD_RANGE = 32
export const GRIT_GRAD_SCALE = GRIT_GRAD_RANGE * 2

// Tileable value noise on a gx x gy lattice, over uv in 0..1. Wrapping the
// lattice indices is the whole trick -- without the wrap every sample of these
// textures would seam along its tile edges, which on terrain means a visible
// grid at whatever the sampling scale happens to be.
//
// gx and gy are separate so a field can be ANISOTROPIC, which is the only way
// to bake a direction into noise -- snow drifts across the wind and rock beds
// along a face, and an isotropic field cannot express "along". Both axes still
// wrap independently, so the tile stays seamless at any ratio.
//
// Same construction as preview-stage.js's bench ground, and deliberately so:
// that ground is the look this file is aiming at ("speckled pixelated Perlin
// green" was the ask, and the bench is where it already exists). It is copied
// rather than imported because preview-stage is a tuning-bench module that also
// pulls in a renderer and a lighting patch, and the game's terrain should not
// depend on a bench.
function lattice(rand, gx, gy = gx) {
  const v = new Float32Array(gx * gy)
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = x * gx
    const fy = y * gy
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const x0 = ((ix % gx) + gx) % gx
    const y0 = ((iy % gy) + gy) % gy
    const x1 = (x0 + 1) % gx
    const y1 = (y0 + 1) % gy
    const tx = smooth(fx - ix)
    const ty = smooth(fy - iy)
    const a = v[y0 * gx + x0]
    const b = v[y0 * gx + x1]
    const c = v[y1 * gx + x0]
    const d = v[y1 * gx + x1]
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
 *
 * `spec` is the whole character of a surface, and the three that ship are the
 * three ways this generator can be pointed:
 *
 *   g0       the coarsest lattice, in cells across the tile. Small = big
 *            blotches, and `gain` decides how much of the field they carry.
 *   aspect   cells along y as a multiple of cells along x. 1 is isotropic;
 *            anything else bakes in a DIRECTION -- how snow drifts across the
 *            wind, and the faint grain in rock.
 *   octaves,
 *   gain     the usual pair. gain above 0.5 keeps the energy in the coarse
 *            octaves, which is what reads as blotches rather than as fizz.
 */
function fbmGrid(rand, size, { g0, aspect = 1, octaves, gain }) {
  const layers = []
  let g = g0
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    layers.push([lattice(rand, g, Math.max(1, Math.round(g * aspect))), amp])
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
      for (const [f, a] of layers) {
        s += f(u, v) * a
      }
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

// ---------------------------------------------------------------------------
// THE GRIT ARRAY: three near-field surfaces, one fetch.
//
// It used to be a single sampler2D and every surface wore the same field,
// distinguished only by which palette pair the shader ran it through. That is
// enough to say "this is rock and that is grass" and not enough to say what
// either is MADE of: a lawn and a cliff had the same blotches in the same
// places at the same size, in two colour schemes.
//
// Three layers of a DataArrayTexture fixes that for the price of an index.
// `texture( arr, vec3( uv, layer ) )` is ONE fetch whatever the layer is, so a
// grass field with clumps, a rock field with fracture lines and a snow field
// with wind-scour cost exactly what one shared field cost. The alternative --
// three sampler2Ds and a blend -- is three fetches to draw one surface.
//
// WHAT THE INDEX COSTS: the layer is chosen per fragment from the surface
// classification, so the transition from grass to rock is a HARD SWITCH rather
// than a blend. That is a deliberate trade (a blend is a second fetch, i.e. the
// entire saving), and the seam is broken up rather than hidden -- see the
// dither on the selection in terrain-material.js.
// ---------------------------------------------------------------------------

export const GRIT_LAYER = { GRASS: 0, ROCK: 1, SNOW: 2 }
export const GRIT_LAYER_COUNT = 3

// The three characters, and this table IS the difference between the surfaces.
// See fbmGrid for what each field means; the sizes below are quoted over the
// coarse sample's 11.7 m tile (GRIT_METRES), which is where they are read.
const GRIT_SPECS = [
  {
    // GRASS: chaotic, non-repeating blotches. g0 = 3 puts the coarsest clump at
    // ~3.9 m and the finest at ~24 cm, and the gain is well above the usual 0.5
    // so most of the field's energy sits in the COARSE octaves -- which is what
    // makes it read as patches of meadow rather than as uniform green fizz.
    // Isotropic, because a lawn has no grain.
    h: { g0: 3, octaves: 5, gain: 0.62 },
    alt: { g0: 8, octaves: 4, gain: 0.5 },
    speckle: 0.18,
  },
  {
    // ROCK: coarse mottle with a mineral grain over it. What separates it from
    // grass is coarseness and grain, not shape -- g0 = 2 makes the blotches
    // twice the size of the meadow's, the highest speckle of the three roughens
    // every texel, and a mild 1.5:1 aspect leaves a hint of bedding direction
    // without resolving into stripes. Coarsest cell is ~5.9 x 3.9 m, finest
    // ~37 x 24 cm.
    h: { g0: 2, aspect: 1.5, octaves: 5, gain: 0.6 },
    // Isotropic, because this one is the mineral flecking between the blotches
    // and flecks that queue up in rows read as a weave.
    alt: { g0: 6, octaves: 4, gain: 0.5 },
    speckle: 0.26,
    // This field is the gentlest of the three -- gain sits high and the aspect
    // is mild, so its raw mean |dh/du| is 2.84 against the other two's 4.76 --
    // and a cliff that lights flatter than the meadow below it is wrong however
    // good its albedo is. 1.68 puts it on their mean, so one uRelief still means
    // one strength everywhere.
    relief: 1.68,
  },
  {
    // SNOW: wind-scoured drift. Soft (gain 0.45 drops the fine octaves fast,
    // and there are only four) and directional, because a drift is laid down
    // across the wind. The 2.2:1 stretch that does that is also what makes this
    // the steepest of the three fields across its grain, which is why it and
    // not rock is what sets GRIT_GRAD_RANGE.
    //
    // Its ALT channel is the sparkle, and that one wants the opposite: a fine,
    // isotropic field, because a crystal catching the sun is a point and points
    // must not line up in rows. The threshold that reads it (0.994) is only
    // meaningful because equalise() makes it exactly the top 0.6% of texels.
    h: { g0: 4, aspect: 2.2, octaves: 4, gain: 0.45 },
    alt: { g0: 20, octaves: 3, gain: 0.5 },
    speckle: 0.1,
  },
]

/**
 * ONE LAYER OF THE GRIT ARRAY, written into `data` at `layer`.
 *
 *   R  the albedo field, QUANTISED to six steps and then speckled per texel
 *   G  0.5 + dh/du of the SMOOTH field, packed by GRIT_GRAD_RANGE
 *   B  0.5 + dh/dv, likewise
 *   A  a second, decorrelated, unquantised field
 *
 * `spec.relief` scales G and B only, leaving R alone, so a surface can light
 * rougher or smoother than it looks. It is baked rather than sent as a uniform
 * because the shader reads all three layers through one fetch and one uRelief:
 * a per-surface strength there would mean a dynamic index into a vec3 in the
 * hot path, and here it is free.
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
 *
 * @returns {number} the share of texels whose gradient clipped at
 *   GRIT_GRAD_RANGE, which is the number gritArrayTexture reports.
 */
function bakeGritLayer(data, layer, spec, seed) {
  const size = GRIT_SIZE
  const rand = mulberry32(seed)
  const { relief = 1 } = spec
  const h = equalise(fbmGrid(rand, size, spec.h))
  const alt = equalise(fbmGrid(rand, size, spec.alt))

  const base = layer * size * size * 4
  let clipped = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const o = base + i * 4
      let n = Math.round(h[i] * 5) / 5
      n = Math.min(1, Math.max(0, n + (rand() - 0.5) * spec.speckle))
      const [rawGx, rawGy] = gradAt(h, size, x, y)
      const gx = rawGx * relief
      const gy = rawGy * relief
      if (Math.abs(gx) > GRIT_GRAD_RANGE || Math.abs(gy) > GRIT_GRAD_RANGE) clipped++
      data[o] = pack(n)
      data[o + 1] = pack(0.5 + gx / GRIT_GRAD_SCALE)
      data[o + 2] = pack(0.5 + gy / GRIT_GRAD_SCALE)
      data[o + 3] = pack(alt[i])
    }
  }
  return clipped / (size * size)
}

/** The three-layer grit array. See the block above GRIT_LAYER. */
export function gritArrayTexture() {
  const size = GRIT_SIZE
  const data = new Uint8Array(size * size * 4 * GRIT_LAYER_COUNT)
  // Distinct seeds, so the three fields are independent rather than three
  // filters over one -- otherwise a boulder in a meadow would sit in a dip that
  // the grass around it also has.
  const seeds = [0x6717, 0x1d3b, 0x40a9]
  const clip = GRIT_SPECS.map((spec, i) => bakeGritLayer(data, i, spec, seeds[i]))
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
  const macro = { g0: 1, octaves: 6, gain: 0.5 }
  const r = equalise(fbmGrid(rand, size, macro))
  const g = equalise(fbmGrid(rand, size, macro))
  const b = equalise(fbmGrid(rand, size, macro))
  const a = equalise(fbmGrid(rand, size, macro))

  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    data[o] = pack(r[i])
    data[o + 1] = pack(g[i])
    data[o + 2] = pack(b[i])
    data[o + 3] = pack(a[i])
  }
  const tex = new THREE.DataTexture(data, size, size)
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

// ONE PAIR FOR THE WHOLE WORLD, built on first use. createTerrainMaterial is
// called by v1's terrain, v2's terrain, the macro diagnostic mesh and three
// gates; they all want the same fields, and generating them per material would
// pay the ~60 ms of lattice arithmetic and the 512 KB of VRAM once per caller
// for identical bytes.
let cached = null

export function terrainDetailTextures() {
  if (!cached) cached = { grit: gritArrayTexture(), macro: macroTexture() }
  return cached
}
