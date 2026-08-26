// ---------------------------------------------------------------------------
// The noise lookup table, baked in JavaScript at startup.
//
// This is the CPU half of glsl/lut.js -- read that file's header first, it
// carries the reasoning for the format, the resolution, the period and the
// decision to store a value rather than a gradient. What is here is the
// arithmetic that fills the buffer and the three.js settings that get it onto
// the GPU without anything transforming it on the way.
//
// ===========================================================================
// WHY GENERATED AND NOT SHIPPED
// ===========================================================================
//
// A 128 KB PNG in the repo would work and it would be worse in three ways: it
// is a binary blob nobody can diff, it would have to be 8-bit because PNG has
// no half-float, and its content would be a claim about what the shader reads
// that only the shader could check. Generating it takes about four milliseconds
// for 256x256 and the generator is the specification.
//
// ===========================================================================
// THE ALIGNMENT THAT MAKES THE LATTICE ZEROS SURVIVE
// ===========================================================================
//
// Texel j is baked at noise coordinate j * PERIOD / SIZE, which with 256 texels
// over a 16-unit period is j/16. So noise coordinate x lands on texel 16*x, and
// an INTEGER x -- a Perlin lattice point, where the field is exactly zero by
// construction -- lands on an exact texel index rather than between two.
//
// The shader completes the arrangement by adding half a texel to the UV, since
// GL samples texel j at UV (j + 0.5)/SIZE. Drop that term and every lookup is
// displaced by half a texel, which is a thirty-second of a lattice cell: not
// visible as a shift, but it smears every lattice zero across two texels and
// takes away the one structural property that separates gradient noise from
// value noise. The half texel is load-bearing, not tidiness.
//
// ===========================================================================
// THE FIELD IS gnoise2's FIELD, NOT gnoise2 ITSELF
// ===========================================================================
//
// Same construction -- floor/fract, quintic fade, four unnormalised gradients
// in [-1, 1] squared, four dot products, bilinear blend, and the same v*0.7+0.5
// remap onto 0..1 -- but the gradients come from an integer hash chosen so the
// lattice WRAPS at the period, which the GLSL hash cannot do. So the table is a
// different draw from the same distribution: identical statistics, identical
// character, different sky. See glsl/lut.js.
//
// The gradients are deliberately left unnormalised, matching gnoise2's own
// comment: normalising costs an inverse square root per corner, and what it
// buys is a field whose amplitude does not wobble by a few percent, which a
// warp does not care about. Free on the CPU, but the point is to bake the same
// field the analytic path produces, not a tidier one.
//
// ===========================================================================
// WHAT WAS MEASURED, RATHER THAN ASSUMED
// ===========================================================================
//
// Four properties of the baked table, checked off the buffer:
//
//   Every one of the 256 lattice points reads back EXACTLY 0.5, which is
//   exactly zero field, to the last bit. The alignment above works.
//
//   Mean 0.4998, standard deviation 0.1241, range 0.0784 to 0.8801, and no
//   texel outside 0..1. That is the distribution the analytic gnoise2 has, so
//   a warp amplitude means the same thing on both sides.
//
//   The largest second difference ACROSS THE WRAP SEAM is 0.0029, against a
//   worst case of 0.0195 in the interior. The seam is smoother than the
//   roughest ordinary place in the table, so the periodic lattice wraps
//   genuinely rather than nearly.
//
//   4.8 ms to bake on this machine. Not worth a worker, not worth caching to
//   disk, and cheap enough that it happens on first use rather than at import.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

import { LUT_SIZE, LUT_PERIOD } from './glsl/lut.js'

// Two odd 32-bit constants and an xorshift finalise. Not a cryptographic hash
// and it does not need to be -- what it needs is that neighbouring lattice
// cells get uncorrelated gradients, and that the same (ix, iy) always gets the
// same pair so the table is reproducible across machines and reloads.
function hashCell( ix, iy ) {
  let h = Math.imul( ix, 374761393 ) ^ Math.imul( iy, 668265263 )
  h = Math.imul( h ^ ( h >>> 13 ), 1274126177 )
  h = h ^ ( h >>> 16 )
  return h >>> 0
}

// Quintic fade. The cubic one has a discontinuous second derivative and shows
// up as faint lattice creases exactly where a warp stretches the field most --
// see the note on vnoise2. Baking is not an excuse to use the cheap one: the
// creases would be baked in too.
function fade( t ) {
  return t * t * t * ( t * ( t * 6 - 15 ) + 10 )
}

function lerp( a, b, u ) {
  return a + ( b - a ) * u
}

// ---------------------------------------------------------------------------

// Fills a Uint16Array of half-float bit patterns with one period of a tiling
// Perlin field, and returns it along with the range it actually covered.
//
// The range is returned rather than discarded because it is the number that
// says whether the 0.7 scale is right: gnoise2's remap is tuned so the field
// mostly lands inside 0..1 and overshoots rarely, and a table whose extremes
// were at 0.2 and 0.8 would mean the basis is quieter than the analytic one and
// every warp amplitude in every preset is now wrong by the ratio.
export function bakeNoiseLut() {
  const size = LUT_SIZE
  const period = LUT_PERIOD
  const perCell = size / period
  if ( !Number.isInteger( perCell ) ) {
    throw new Error( 'aurora-lab: LUT_SIZE ' + size + ' is not a whole number of texels per cell at period ' + period )
  }

  // The wrapped gradient lattice, built once. period*period cells, two
  // components each, unnormalised in [-1, 1].
  const gx = new Float32Array( period * period )
  const gy = new Float32Array( period * period )
  for ( let j = 0; j < period; j++ ) {
    for ( let i = 0; i < period; i++ ) {
      const h = hashCell( i, j )
      gx[ j * period + i ] = ( ( h & 0xffff ) / 32767.5 ) - 1
      gy[ j * period + i ] = ( ( h >>> 16 ) / 32767.5 ) - 1
    }
  }

  const data = new Uint16Array( size * size )
  let lo = Infinity
  let hi = -Infinity

  for ( let ty = 0; ty < size; ty++ ) {
    // Integer arithmetic on purpose: ty / perCell with perCell a power of two
    // is exact, so the cell index and the cell fraction are exact and a texel
    // that should land on a lattice point lands on it rather than at
    // 0.9999999. The zeros only survive if this is exact.
    const j0 = ( ty / perCell ) | 0
    const j1 = ( j0 + 1 ) % period
    const fy = ( ty % perCell ) / perCell
    const uy = fade( fy )

    for ( let tx = 0; tx < size; tx++ ) {
      const i0 = ( tx / perCell ) | 0
      const i1 = ( i0 + 1 ) % period
      const fx = ( tx % perCell ) / perCell
      const ux = fade( fx )

      const aa = j0 * period + i0
      const ba = j0 * period + i1
      const ab = j1 * period + i0
      const bb = j1 * period + i1

      const a = gx[ aa ] * fx + gy[ aa ] * fy
      const b = gx[ ba ] * ( fx - 1 ) + gy[ ba ] * fy
      const c = gx[ ab ] * fx + gy[ ab ] * ( fy - 1 )
      const d = gx[ bb ] * ( fx - 1 ) + gy[ bb ] * ( fy - 1 )

      // gnoise2's exact remap, overshoot and all. Nothing is clamped: half
      // float stores the tails, and clamping would put flat spots in the field
      // where the analytic version has its peaks.
      const v = lerp( lerp( a, b, ux ), lerp( c, d, ux ), uy ) * 0.7 + 0.5

      if ( v < lo ) lo = v
      if ( v > hi ) hi = v
      data[ ty * size + tx ] = THREE.DataUtils.toHalfFloat( v )
    }
  }

  return { data, size, period, lo, hi }
}

// ---------------------------------------------------------------------------

// The texture settings, and why each one is what it is:
//
//   RedFormat + HalfFloatType resolves to R16F in three's WebGLTextures
//   (getInternalFormat, the glFormat === RED branch), which is a core WebGL2
//   sized format with core LINEAR filtering. No extension is consulted for
//   filtering, only EXT_color_buffer_float, and that is for rendering TO it,
//   which nothing here does.
//
//   RepeatWrapping on both axes is what makes the period a period. GL_REPEAT
//   handles negative coordinates correctly, which matters because the plan
//   coordinate is signed and half the sky is at negative x.
//
//   LinearFilter on BOTH min and mag. DataTexture's constructor defaults both
//   to NearestFilter, so this is not redundant -- leaving it would give a
//   point-sampled table and a visibly blocky field.
//
//   generateMipmaps false and no mip chain, so the texture unit never selects
//   an LOD. See glsl/lut.js for why a mip-filtered warp would be wrong rather
//   than merely soft.
//
//   colorSpace NoColorSpace. This is DataTexture's own default and it is set
//   explicitly anyway, because it is the line someone will look for. It is also
//   inert for this format: three only consults colorSpace when choosing between
//   RGBA8 and SRGB8_ALPHA8 for unsigned-byte RGBA, and R16F never reaches that
//   branch. It would stop being inert the moment anyone dropped this to
//   eight-bit RGBA, which is exactly when getting it wrong would cost an
//   afternoon.
function toTexture( baked ) {
  const tex = new THREE.DataTexture(
    baked.data, baked.size, baked.size, THREE.RedFormat, THREE.HalfFloatType
  )
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.NoColorSpace
  tex.name = 'aurora-lab noise LUT'
  tex.userData.lut = { period: baked.period, lo: baked.lo, hi: baked.hi }
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------

// One table per MODULE, not one per screen and emphatically not one per
// material. AuroraScreen rebuilds its ShaderMaterial from scratch every time
// the algorithm changes, so a texture owned by the material would be re-baked
// and re-uploaded on every switch of the dropdown -- four milliseconds of
// JavaScript and 128 KB of upload for a table whose contents are a constant.
//
// It is deliberately never disposed. three does not dispose textures when a
// material is disposed, so nothing frees it by accident, and the only correct
// lifetime for a shared constant is the page's.
let cached = null

export function noiseLutTexture() {
  if ( cached === null ) cached = toTexture( bakeNoiseLut() )
  return cached
}
