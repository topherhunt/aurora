// ---------------------------------------------------------------------------
// The noise library the aurora lab's shaders are built out of.
//
// Every algorithm in the lab is a different arrangement of the same handful of
// primitives, so they live here once rather than being pasted into each. Each
// export is a GLSL source string; assemble() in ../screen.js concatenates the
// ones an algorithm asks for, in dependency order, ahead of its body.
//
// ===========================================================================
// THE LANGUAGE THESE COMPILE AS
// ===========================================================================
//
// ESSL 3.00. three.js prepends `#version 300 es` to every non-Raw material --
// WebGLProgram.js line 864, unconditionally, not only when `glslVersion` is set
// -- so dynamic loop bounds, integer operations and `uint` are all available
// here. `src/aurora.js`'s integer hash is legal for that reason and not by
// luck.
//
// This file still hashes in FLOAT, and the reason is not portability. It is
// that the fbm and the raymarch below evaluate a hash forty to two hundred
// times per fragment, and on a mobile GPU the integer pipeline is narrower than
// the float one -- a uint multiply-and-xor costs more there than the three
// fract-and-dot it replaces. The lab is a desktop tool, but what comes out of
// it has to end up in a headset (DESIGN.md §17), and a field that is cheap on
// the target is worth choosing now rather than porting later.
//
// ===========================================================================
// THREE FAMILIES, AND WHEN TO REACH FOR WHICH
// ===========================================================================
//
// VALUE NOISE (`vnoise2`, `vnoise3`). Four hashes and three mixes. This is the
//   hot-loop noise: inside a raymarch that evaluates the field forty times per
//   fragment, the difference between this and gradient noise is the difference
//   between 60 fps and 20. Its tell is that it has visible axis alignment --
//   blobs line up with the grid -- which matters when you are looking at one
//   octave and disappears once four are summed at rotated angles.
//
// GRADIENT NOISE (`gnoise2`). Perlin, with quintic interpolation and gradients
//   pulled from the hash rather than from a permutation table. Twice the cost
//   and no grid tell. Use it for DOMAIN WARPING, where the artefact would
//   otherwise be amplified by the warp instead of averaged away by the sum.
//
// FILAMENT NOISE (`filament2`). Not noise in the interpolated-lattice sense at
//   all: it is an iterated triangle-wave domain warp, and it has no hash in it,
//   so it costs no texture-like scatter and returns a field whose LEVEL SETS
//   ARE LONG THIN CURVES. That property is the entire reason it is here. Value
//   and gradient noise both produce blobs, and a curtain made of blobs reads as
//   fog; a curtain made of filaments reads as an aurora. The technique is the
//   one behind every good procedural aurora on Shadertoy -- fold the plane with
//   abs(fract(x) - 0.5), advance, rotate, fold again -- and what it buys is
//   structure at every scale from one evaluation instead of from four.
//
// ===========================================================================
// ROTATION BETWEEN OCTAVES, WHICH IS NOT OPTIONAL
// ===========================================================================
//
// An fbm that only scales between octaves stacks every octave's grid on the
// same axes, and the axis alignment that one octave hides, four octaves
// advertise: you get a plaid. The 2x2 in `fbm2` turns the plane by about 37
// degrees per octave, an angle chosen because it is not a rational fraction of
// 90, so no two octaves in the stack ever come back into alignment.
// ---------------------------------------------------------------------------

// Small shared helpers. Kept in their own chunk because every other chunk here
// needs at least one of them and GLSL has no include guard of its own -- the
// assembler dedupes by chunk identity, so `rot2` can be depended on freely.
export const UTIL_GLSL = `
  #ifndef AURLAB_UTIL
  #define AURLAB_UTIL

  const float TAU = 6.28318530718;

  float sat( float x ) { return clamp( x, 0.0, 1.0 ); }
  vec3  sat3( vec3 v )  { return clamp( v, 0.0, 1.0 ); }

  mat2 rot2( float a ) {
    float c = cos( a ), s = sin( a );
    return mat2( c, -s, s, c );
  }

  // A triangle wave on 0..1 with period 1. The building block of the filament
  // family: it is continuous, it is cheap, and unlike a sine its derivative is
  // constant, so folding with it does not pile detail up near the turning
  // points the way sin-based folding does.
  float tri( float x ) { return abs( fract( x ) - 0.5 ) * 2.0; }

  // Ridged remap: takes a 0..1 field to a 0..1 field whose maxima are creases
  // rather than plateaus. This is what turns a smooth fbm into something with
  // filaments in it, and it is the cheapest way to get an edge the eye can
  // track.
  float ridge( float n ) { return 1.0 - abs( n * 2.0 - 1.0 ); }

  // Smooth maximum. Used where two glowing things overlap and a plain max would
  // leave a visible crease along the seam. k is the blend width in field units.
  float smax( float a, float b, float k ) {
    float h = sat( 0.5 + 0.5 * ( a - b ) / k );
    return mix( b, a, h ) + k * h * ( 1.0 - h );
  }

  #endif
`

// Dave Hoskins' "Hash without Sine" family. Chosen over the fract(sin(dot()))
// idiom that every tutorial uses because that idiom depends on the precision of
// sin() for large arguments, which is explicitly implementation-defined -- it
// gives one pattern on desktop, a visibly different one on mobile, and banding
// on anything that evaluates sin in fewer bits than it advertises. These are
// pure multiply-and-fract, so the field is the same field everywhere.
export const HASH_GLSL = `
  #ifndef AURLAB_HASH
  #define AURLAB_HASH

  float hash21( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  vec2 hash22( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.xx + p3.yz ) * p3.zy );
  }

  float hash31( vec3 p ) {
    p = fract( p * 0.1031 );
    p += dot( p, p.zyx + 31.32 );
    return fract( ( p.x + p.y ) * p.z );
  }

  #endif
`

// Value noise. `vnoise2` returns 0..1; the quintic fade is worth its four extra
// multiplies because the cubic one has a discontinuous second derivative, and
// that shows up as faint lattice creases exactly where a warp stretches the
// field most.
export const VALUE_GLSL = `
  #ifndef AURLAB_VALUE
  #define AURLAB_VALUE

  float vnoise2( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    return mix( mix( hash21( i ),                     hash21( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( hash21( i + vec2( 0.0, 1.0 ) ),  hash21( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }

  float vnoise3( vec3 p ) {
    vec3 i = floor( p ), f = fract( p );
    vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float n000 = hash31( i + vec3( 0.0, 0.0, 0.0 ) );
    float n100 = hash31( i + vec3( 1.0, 0.0, 0.0 ) );
    float n010 = hash31( i + vec3( 0.0, 1.0, 0.0 ) );
    float n110 = hash31( i + vec3( 1.0, 1.0, 0.0 ) );
    float n001 = hash31( i + vec3( 0.0, 0.0, 1.0 ) );
    float n101 = hash31( i + vec3( 1.0, 0.0, 1.0 ) );
    float n011 = hash31( i + vec3( 0.0, 1.0, 1.0 ) );
    float n111 = hash31( i + vec3( 1.0, 1.0, 1.0 ) );
    return mix( mix( mix( n000, n100, u.x ), mix( n010, n110, u.x ), u.y ),
                mix( mix( n001, n101, u.x ), mix( n011, n111, u.x ), u.y ), u.z );
  }

  #endif
`

// Gradient (Perlin) noise, returned on 0..1 for interchangeability with the
// value noise above. The gradients are the raw hash mapped to -1..1 and left
// UNNORMALISED on purpose: normalising costs an inverse square root per corner,
// four per sample, and the only visible consequence of skipping it is that the
// field's amplitude wobbles by a few percent -- which a warp does not care
// about and a sum of octaves erases.
export const GRAD_GLSL = `
  #ifndef AURLAB_GRAD
  #define AURLAB_GRAD

  float gnoise2( vec2 p ) {
    vec2 i = floor( p ), f = fract( p );
    vec2 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    float a = dot( hash22( i + vec2( 0.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 0.0 ) );
    float b = dot( hash22( i + vec2( 1.0, 0.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 0.0 ) );
    float c = dot( hash22( i + vec2( 0.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 0.0, 1.0 ) );
    float d = dot( hash22( i + vec2( 1.0, 1.0 ) ) * 2.0 - 1.0, f - vec2( 1.0, 1.0 ) );
    return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 0.7 + 0.5;
  }

  #endif
`

// Fractal sums. The octave count is a literal rather than a uniform even though
// ESSL 3.00 would allow the uniform, because a draggable octave count is a
// trap: adding an octave changes the field's MEAN as well as its detail, so
// every other knob has to be retuned to get back to the sky you had before you
// touched it. Detail is exposed as AMPLITUDE on the high octaves instead --
// see `fbm2Amp`, which normalises by the weights it actually used and so leaves
// the mean where it was.
export const FBM_GLSL = `
  #ifndef AURLAB_FBM
  #define AURLAB_FBM

  // Four octaves, each rotated 37 degrees from the last so no two grids align.
  float fbm2( vec2 p ) {
    mat2 m = rot2( 0.6458 );
    float a = 0.5, s = 0.0, norm = 0.0;
    for ( int i = 0; i < 4; i++ ) {
      s += a * vnoise2( p );
      norm += a;
      p = m * p * 2.02;
      a *= 0.5;
    }
    return s / norm;
  }

  // The same sum with the top two octaves scaled by det. At det = 0 this is a
  // smooth two-octave swell; at det = 1 it is fbm2. Normalising by the actual
  // weight sum is what keeps the MEAN fixed as it moves, which is the whole
  // point -- a detail slider that also brightens the sky is unusable, because
  // you cannot tell which of the two you just changed.
  float fbm2Amp( vec2 p, float det ) {
    mat2 m = rot2( 0.6458 );
    float a = 0.5, s = 0.0, norm = 0.0;
    for ( int i = 0; i < 4; i++ ) {
      float w = a * ( i < 2 ? 1.0 : det );
      s += w * vnoise2( p );
      norm += w;
      p = m * p * 2.02;
      a *= 0.5;
    }
    return s / max( norm, 1e-4 );
  }

  // Gradient-noise fbm, three octaves. Used for warping only, where the extra
  // cost buys the absence of a grid tell that the warp would otherwise magnify.
  float gfbm2( vec2 p ) {
    mat2 m = rot2( 0.6458 );
    float a = 0.5, s = 0.0, norm = 0.0;
    for ( int i = 0; i < 3; i++ ) {
      s += a * gnoise2( p );
      norm += a;
      p = m * p * 2.13;
      a *= 0.5;
    }
    return s / norm;
  }

  float fbm3( vec3 p ) {
    mat2 m = rot2( 0.6458 );
    float a = 0.5, s = 0.0, norm = 0.0;
    for ( int i = 0; i < 3; i++ ) {
      s += a * vnoise3( p );
      norm += a;
      p.xz = m * p.xz * 2.05;
      p.y *= 2.05;
      a *= 0.5;
    }
    return s / norm;
  }

  #endif
`

// ---------------------------------------------------------------------------
// Domain warp.
//
// `warp2` is the two-stage warp: offset the plane by a vector field, then
// offset it again by a second field READ AT THE ALREADY-OFFSET POSITION. One
// stage gives wobble. Two stages give the swirling, self-similar, taffy-pulled
// look, because the second field's coordinates have themselves been stretched,
// so its features are compressed where the first field converged and smeared
// where it diverged. That divergence is what reads as flow, and it is why an
// aurora built on a warped field looks like something moving through a medium
// rather than like a texture sliding past.
//
// The time argument enters as the SECOND coordinate of the noise lookups rather
// than as an addition to the first. Adding to the coordinate translates the
// pattern -- structure slides across the sky, which is the single most reliable
// way to make an aurora look like a scrolling texture. Putting time on its own
// axis makes the pattern MORPH IN PLACE, and the difference between the two is
// most of the difference between this and the polygon bands it replaces.
// ---------------------------------------------------------------------------
export const WARP_GLSL = `
  #ifndef AURLAB_WARP
  #define AURLAB_WARP

  // stages is a COST knob, and it is the most expensive single number in the
  // whole shader. Each stage is two gfbm2 calls at three octaves, so it is six
  // gradient-noise lookups, and this function runs once per march step: at two
  // stages it is twelve of the twenty-one lookups a step costs, which is more
  // than the rest of the sky put together.
  //
  // What the second stage buys is warp applied to warp -- the fine, curdled,
  // marbled detail inside a meander, as opposed to the meander itself. Dropping
  // it does not straighten the channels, because the first stage is what bends
  // them; it makes their edges smoother. On anything mobile that is the first
  // trade to take, and it is close to a 30% saving for it.
  vec2 warp2( vec2 p, float t, float amp, float freq, float stages ) {
    vec2 q = vec2( gfbm2( p * freq + vec2( 0.0, t * 0.11 ) ),
                   gfbm2( p * freq + vec2( 5.2, 1.3 + t * 0.09 ) ) ) - 0.5;

    // Uniform-valued branch: every fragment in the draw takes the same side, so
    // there is no divergence and the cost is the test, not both paths.
    if ( stages < 1.5 ) return p + amp * q * 2.0;

    vec2 r = vec2( gfbm2( p * freq * 2.1 + 3.4 * q + vec2( 1.7, t * 0.15 ) ),
                   gfbm2( p * freq * 2.1 + 3.4 * q + vec2( 8.3, 2.8 - t * 0.13 ) ) ) - 0.5;
    return p + amp * ( q * 2.0 + r * 0.9 );
  }

  #endif
`

// ---------------------------------------------------------------------------
// Filament noise: the curtain generator.
//
// Six folds of an iterated triangle-wave warp. Each iteration displaces the
// plane by a triangle wave of itself, rotates, and scales up; the accumulator
// takes a weighted triangle wave of the result. Because the displacement is a
// function of position and the rotation is irrational, points that start close
// together are pulled apart along ONE axis and squeezed along the other, which
// is what makes the level sets of the sum long and thin rather than round.
//
// The final reciprocal-power is the shaping step and it is where the look comes
// from: it takes a field that spends most of its range near the middle and
// crushes it, so almost everything is dark and the few places where the folds
// happened to align are very bright. That is the right statistic for an
// emissive medium -- an aurora is mostly empty sky with a few bright ribbons in
// it -- and it is why an ordinary fbm, whose values pile up around 0.5, always
// looks like fog no matter how it is coloured.
//
// `spd` rotates the displacement vectors over time rather than translating
// them, so the folds turn in place. See the note in WARP_GLSL: nothing in this
// file is ever allowed to slide.
// ---------------------------------------------------------------------------
export const FILAMENT_GLSL = `
  #ifndef AURLAB_FILAMENT
  #define AURLAB_FILAMENT

  vec2 triPair( vec2 p ) {
    return vec2( tri( p.x + tri( p.y ) ), tri( p.y + tri( p.x ) ) ) - 0.5;
  }

  // crush is the exponent on the reciprocal: low is soft and cloudy, high is
  // a few hard filaments on black. It is exposed rather than fixed because it
  // is the single most expressive number in the whole lab.
  float filament2( vec2 p, float t, float spd, float crush ) {
    float z = 1.55, z2 = 2.1, acc = 0.0;
    p *= rot2( 0.42 );
    vec2 bp = p;
    for ( int i = 0; i < 6; i++ ) {
      vec2 dg = triPair( bp * 1.85 ) * 0.9;
      dg *= rot2( t * spd );
      p -= dg / z2;
      bp *= 1.32;
      z2 *= 0.47;
      z *= 0.43;
      p *= 1.23 + ( acc - 1.0 ) * 0.02;
      acc += tri( p.x + tri( p.y ) ) * z;
      p *= -rot2( 0.318 );
    }
    return sat( 1.0 / pow( max( acc, 1e-3 ) * 26.0, crush ) );
  }

  #endif
`
