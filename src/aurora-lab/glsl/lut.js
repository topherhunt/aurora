// ---------------------------------------------------------------------------
// The texture-backed noise basis: the same fields as glsl/noise.js, read out of
// a small tiling lookup table instead of being computed from a hash.
//
// ===========================================================================
// WHAT IS BAKED AND WHAT IS NOT -- READ THIS FIRST
// ===========================================================================
//
// What is baked is ONE GENERIC TILING NOISE FIELD. Nothing else. It is a
// function of position only, it has no time in it, it does not know what an
// aurora is, and it would be exactly the same table if the algorithm on top of
// it were water caustics or a cloud layer.
//
// The aurora is NOT baked. Every part of the construction that makes the sky an
// aurora still runs per pixel per frame: the two-stage domain warp, the fold
// through the triangle wave, the bend field, the channel identity, the gating,
// the along-channel patchiness, and the frame's march, deposition, flow and
// shimmer on top of all of it. Time enters the warp on its own axis exactly as
// it does in the analytic version, so the pattern morphs in place and never
// repeats. Baking a texture of the aurora ITSELF -- a loop of frames, or a flow
// map -- was ruled out on purpose and nothing here reopens it.
//
// The distinction that makes this legal: a noise basis is an argument the
// algorithm calls, not an output the algorithm produces.
//
// ===========================================================================
// WHY A VALUE TABLE AND NOT A GRADIENT TABLE
// ===========================================================================
//
// Gradient noise is not directly a texture the way value noise is. There are
// two ways to put it in one, and they are not close:
//
//   BAKE THE GRADIENT VECTORS into RG and do Perlin's four dot products in the
//     shader. This is faithful by construction, and it is pointless: it needs
//     four point-sampled fetches per noise evaluation rather than one, plus the
//     dots, the fade and the lerps, so it keeps almost all of the arithmetic
//     AND adds four times the fetches. It is strictly worse than the analytic
//     version on both axes.
//
//   BAKE THE NOISE VALUE and let the texture unit's bilinear filter do the
//     reconstruction. One fetch, four ALU ops, done.
//
// The second is what is here, and the usual objection to it -- that you get
// value-noise character rather than gradient-noise character -- is an artefact
// of baking at ONE TEXEL PER LATTICE CELL, which is the only resolution anyone
// ever writes about because it is the one that makes the table small. This
// table is baked at SIXTEEN texels per lattice cell (256 texels over a
// 16-cell period). At that density the bilinear reconstruction is a piecewise
// approximation of the true quintic-blended Perlin surface with a sampling
// interval of 1/16 of a cell, and the reconstruction error is on the order of
// h*h/8 times the field's curvature, which lands around 1% of the field's
// standard deviation.
//
// The structural property that gradient noise has and value noise does not --
// the field being exactly ZERO at every lattice point, which is what makes its
// extrema fall between the grid lines rather than on them -- survives exactly,
// not approximately. A lattice point sits at x = an integer, which is texel
// index 16*x, which is a texel CENTRE, and a bilinear fetch at a texel centre
// returns that texel unblended. So the zeros are in the table and they are read
// back unmodified.
//
// What does NOT survive is the identity of the field. This table is a different
// draw from the same distribution as gnoise2, because its gradients come from a
// different hash. The sky will have the same character and will not be the same
// sky. That is what u_fieldSeed already establishes as acceptable.
//
// ===========================================================================
// HALF FLOAT, NOT BYTES
// ===========================================================================
//
// Eight bits per texel would halve the table to 64 KB, and it was rejected for
// two reasons that compound.
//
// The first is terracing. A quantised table read through a bilinear filter is
// piecewise linear between quantisation levels, and the warp multiplies that
// staircase by its amplitude before the field is folded through tri(), which
// has a derivative discontinuity of its own at every peak. Steps of 1/255 in
// the basis become steps of about 0.017 field units in the warped coordinate,
// against a channel spacing of about 1.8 -- one percent, which is under the eye
// on a still frame and is exactly the kind of thing that crawls once the warp
// starts morphing.
//
// The second is that only part of a byte would be doing any work. The baked
// table measures mean 0.4998, standard deviation 0.1241, actual range 0.0784 to
// 0.8801 -- gnoise2's v*0.7 + 0.5 remap with unnormalised gradients does not
// fill 0..1, by design, so a byte table would spend 205 of its 256 levels and
// deliver an effective 7.7 bits. Rescaling to fill the byte and undoing it in
// the shader would recover them and cost a multiply-add per fetch, which is
// half the arithmetic in tnoise2.
//
// (The range figure also retires a third argument that looks good and is not
// true: gnoise2's remap CAN overshoot 0..1 in principle, and over all 65536
// texels of this table it never does, so "a byte table has to clamp the tails"
// is not a real objection. Measured, not assumed.)
//
// R16F at 256x256 is 128 KB, which still sits inside any GPU's L2 with room,
// and half-float LINEAR filtering is core in WebGL2 rather than an extension.
//
// ===========================================================================
// TILING, AND THE THREE THINGS THAT HIDE IT
// ===========================================================================
//
// The table is periodic with period 16 in noise-coordinate units. Three
// separate mechanisms keep that period from showing:
//
//   THE OCTAVE ROTATION, which is already in the analytic fbm and is inherited
//     unchanged. Octave 1 is read at 37 degrees to octave 0 and at 2.13 times
//     the frequency, so its repeat lattice is both rotated and scaled against
//     octave 0's. The two lattices coincide only where 16*m and 16*n/2.13 land
//     on the same point after a 37 degree turn, which is nowhere.
//
//   THE PER-OCTAVE OFFSET, which is new here and is what u_ltDecorr controls.
//     It shifts each octave's phase in the table so that even the places where
//     two octaves nearly align are reading different parts of it.
//
//   THE SCALE THE FIELD IS ACTUALLY USED AT. At the default u_ltWarpFreq of
//     0.34 the base octave repeats every 16/0.34 = 47 field units. The plan
//     coordinate reaches about 34 field units at the horizon in the very worst
//     case and about 3 over the part of the sky anyone looks at, so the base
//     octave does not complete a single period anywhere in the visible sky. The
//     third octave repeats every 10.4 field units and does recur near the
//     horizon, where it carries 14% of the fbm amplitude and is compressed into
//     a few degrees of foreshortened, extinction-dimmed sky.
//
// Where it WILL show: drive u_ltWarpFreq toward its 2.5 maximum and the base
// octave repeats every 6.4 field units, which is roughly ten times across the
// sky. That is the honest limit of a 16-unit table and the fix is a bigger one
// (512 texels over a 32-unit period keeps the same 16 texels per cell for 512
// KB), which costs cache rather than arithmetic.
//
// CONSIDERED AND REJECTED: four decorrelated fields in RGBA, one per octave,
// which would kill repeat alignment outright at no extra fetch COUNT. Rejected
// because RGBA16F is 64 bits per texel and bilinear filtering of a 64-bit
// format runs at half rate on most mobile texture units, and this construction
// is already fetch-bound rather than ALU-bound on the target hardware. Paying
// double for the fetches to fix an artefact that the octave rotation already
// hides is the wrong side of the trade.
//
// ===========================================================================
// NO MIPMAPS, ON PURPOSE
// ===========================================================================
//
// The warp needs the field's value at a point, not its average over a
// footprint. A mip-filtered fetch would smooth the warp by an amount that
// varies with screen-space derivatives, so the channels would soften in a band
// across the sky wherever the LOD crossed a level -- a visible seam with no
// physical cause. minFilter is LinearFilter with no mip chain, which also means
// the texture unit never computes an LOD at all, which is one less thing to be
// undefined inside the march's loop.
//
// The cost is that the horizon aliases. It aliased before too: the analytic
// version does no filtering either, and this is the same field.
// ---------------------------------------------------------------------------

// The table's shape. Exported so lut-texture.js bakes exactly what the shader
// reads -- these two numbers appearing twice with different values is the one
// way this can go silently wrong, and there is no second copy of them.
export const LUT_SIZE = 256
export const LUT_PERIOD = 16

// Depends on UTIL_GLSL for nothing, actually, but on a `uniform sampler2D
// u_noiseLut` that screen.js declares by hand -- it is the one uniform in this
// subsystem that is not generated from the param schema, because the schema has
// no sampler type. It also reads u_ltOct and u_ltDecorr, which are params of
// the `lut` ALGORITHM: this chunk is not generic and must not be added to
// another algorithm's `needs` list without carrying those two knobs across.
export const LUT_GLSL = `
  #ifndef AURLAB_LUT
  #define AURLAB_LUT

  // 16 texels per lattice cell. LUT_HALF_TEXEL is what puts noise coordinate
  // x on texel 16*x rather than halfway between two of them, and it is the
  // reason an integer coordinate reads back the exact baked zero.
  const float LUT_INV_PERIOD = 0.0625;
  const float LUT_HALF_TEXEL = 0.001953125;

  // rot2( 0.6458 ), written out because a const initialiser in ESSL 3.00 has to
  // be a constant expression and a function call is not one. Same 37 degrees
  // per octave the analytic fbm uses, for the same reason.
  const mat2 LUT_ROT = mat2( 0.798642, -0.601807, 0.601807, 0.798642 );

  // One bilinear fetch and one multiply-add. This is the whole substitution.
  float tnoise2( vec2 p ) {
    return texture( u_noiseLut, p * LUT_INV_PERIOD + LUT_HALF_TEXEL ).x;
  }

  // gfbm2's shape with gfbm2's constants: three octaves, gain 0.5, lacunarity
  // 2.13, 37 degrees of rotation between each.
  //
  // Written UNROLLED with the weights and the normaliser as literals rather
  // than as a loop with accumulators, which matters far more here than it does
  // in the analytic version: the loop bookkeeping was 8% of a call that cost
  // 500 arithmetic ops and would be 40% of one that costs 44.
  //
  // Each early return renormalises so the MEAN of the result is 0.5 whatever
  // the octave count is -- every octave has mean 0.5, so dividing by the weights
  // actually used holds the mean fixed and only the variance moves. That is
  // what makes u_ltOct a pure cost knob rather than a brightness knob, and it
  // is why an octave count is exposed here when noise.js argues against one.
  //
  // Both tests are on a uniform, so every fragment in the draw takes the same
  // branch: no warp divergence, and the cost is the compare rather than both
  // sides of it. Same trick warp2 plays with its stage count.
  float tfbm2( vec2 p ) {
    float s = 0.5 * tnoise2( p );
    if ( u_ltOct < 1.5 ) return s * 2.0;

    p = LUT_ROT * p * 2.13 + vec2( 17.31, 5.77 ) * u_ltDecorr;
    s += 0.25 * tnoise2( p );
    if ( u_ltOct < 2.5 ) return s * 1.33333333;

    p = LUT_ROT * p * 2.13 + vec2( 3.19, 23.47 ) * u_ltDecorr;
    s += 0.125 * tnoise2( p );
    return s * 1.14285714;
  }

  // warp2, term for term, with tfbm2 in place of gfbm2 and nothing else
  // changed. The offsets, the 0.11 / 0.09 / 0.15 / 0.13 time rates, the 2.1
  // second-stage frequency, the 3.4 feedback gain and the 2.0 / 0.9 amplitudes
  // are all the analytic version's numbers, so a tuning carries over.
  //
  // Time is still the SECOND coordinate of the lookups and not an addition to
  // the first, so the pattern morphs in place instead of sliding. See the note
  // in WARP_GLSL: that is the single most load-bearing detail in the warp and
  // swapping the basis does not touch it.
  vec2 twarp2( vec2 p, float t, float amp, float freq, float stages ) {
    vec2 q = vec2( tfbm2( p * freq + vec2( 0.0, t * 0.11 ) ),
                   tfbm2( p * freq + vec2( 5.2, 1.3 + t * 0.09 ) ) ) - 0.5;

    if ( stages < 1.5 ) return p + amp * q * 2.0;

    vec2 r = vec2( tfbm2( p * freq * 2.1 + 3.4 * q + vec2( 1.7, t * 0.15 ) ),
                   tfbm2( p * freq * 2.1 + 3.4 * q + vec2( 8.3, 2.8 - t * 0.13 ) ) ) - 0.5;
    return p + amp * ( q * 2.0 + r * 0.9 );
  }

  #endif
`
