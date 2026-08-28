// ---------------------------------------------------------------------------
// The sky map's four render targets, as module singletons.
//
// Same ownership argument as planmap/target.js, which should be read first: screen.js binds a chunk's samplers at MATERIAL BUILD TIME out of CHUNK_SAMPLERS, _buildMaterial runs again on every algorithm switch, and a texture owned by an instance the page constructs or reconstructs on its own schedule would leave a material pointing at a freed GL object. So these are owned here, borrowed by SkyMapAurora and by screen.js, and outlived by neither. setSize is used for every resize rather than a fresh target, because three's WebGLRenderTarget.setSize reallocates the GL storage and leaves the Texture OBJECT alone, so a uniform slot already holding it goes on holding the right one.
//
// ===========================================================================
// FOUR TARGETS, AND WHAT EACH ONE IS
// ===========================================================================
//
//   KERNEL. u_smTaps by 1. The part of the ray integral that is the same everywhere in the sky: quadrature weight times deposition times the physical colour ramp, premultiplied. NearestFilter, because the convolution reads it at exact texel centres and any interpolation there would be interpolating between two different taps.
//
//   LANES. The emission profile at three fixed values of the weather scalar, in xyz. Its row count is DERIVED rather than dialled: it has to reach one altitude window past the output map at each end, at a spacing of one tap, so it follows from the taps, the altitude range and how much sky the output map covers. SkyMapAurora computes it and calls setSkyLaneSize every frame; the setter early-returns when nothing moved.
//
//   HUE. The neon palette's colour at the same texels, in xyz. Same size as LANES and always resized with it. It is a separate target rather than a second half of the first one because six channels do not fit in one RGBA and this lab's GLSL is ESSL 1.00 throughout, so MRT would mean a version switch across every shared chunk -- see the header of skymap/glsl.js.
//
//   MAP. The convolved answer: the sky's radiance, already through the saturation matrix and already multiplied by the weather gain, on a lattice about ten times coarser than the screen along both axes. This is the only one the screen shader actually reads.
//
// ===========================================================================
// FORMAT, AND WHY HALF FLOAT IS COMFORTABLE HERE
// ===========================================================================
//
// RGBA16F on all four, filterable in core WebGL2 with no extension consulted. On LANES, HUE and MAP the bilinear tap IS the reconstruction rather than a nicety: the taps land at arbitrary sub-texel positions along x, and the screen reads MAP at arbitrary positions along both.
//
// Everything stored is bounded by a slider and of order one -- an emission profile in 0..3, a palette colour in 0..1, a premultiplied kernel weight of order a hundredth, a radiance of order one. None of them is a plan coordinate, so the eleven bits of mantissa sit where they are worth the most. That is a consequence of storing the SHADED quantity rather than the field, which is the opposite of planmap's choice and is correct for the opposite reason: there, the nonlinearities had to stay downstream of the filter, and here the filter is applied to a quantity that has already been through all of them and is smooth.
//
// Size at the defaults: LANES and HUE are 165 by 512 at eight bytes, so 676 KB each, and MAP is 64 by 512, or 262 KB. All three together are smaller than planmap's single 3.1 MB table, which is the point -- the convolution's forty taps per texel are only affordable because the thing being convolved fits in cache.
//
// x is the log-radius axis on all three of the two-dimensional targets and y is azimuth, so a convolution's forty consecutive taps walk one contiguous row. Azimuth wraps and log radius clamps, for the reasons planmap/target.js gives: a clamped azimuth draws a hard line down the sky at due south, and a wrapped radius folds the far horizon onto the zenith. Both ends of the log-radius axis clamp correctly here -- below u_horizonCut nothing is drawn at all, and above u_smTopDeg the sector's mesh has already ended.
//
// No depth buffer and no stencil: every pass is one full-target quad with depth off. colorSpace is NoColorSpace on all four, including MAP, which does carry colour: it carries LINEAR radiance that the screen shader multiplies by the extinction and hands to MAIN_GLSL, and MAIN_GLSL is where the one encode belongs.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

// Matching the defaults of smAzRes, smRows and smTaps in skymap/algorithm.js. Three copies of a number, which is the shape of mistake this codebase has a standing opinion about, so SkyMapAurora asserts they agree on construction rather than trusting this comment.
export const DEFAULT_AZIMUTH = 512
export const DEFAULT_ROWS = 64
export const DEFAULT_TAPS = 40

// The lane maps' initial row count. This one is NOT a schema default and cannot be asserted against one, because it is derived from six panel values -- it is the allocation the targets start life at, and SkyMapAurora replaces it from the live values on the first render. Getting it wrong costs exactly one reallocation on the first frame and nothing else, which is why it is allowed to be approximate where the three above are not. 168 is what the schema defaults work out to, rounded up.
export const DEFAULT_LANE_ROWS = 168

// Guard rails. The kernel legitimately goes down to a handful of texels, so the floor is lower than planmap's; the ceiling is the same, and above it none of these is a cache of anything. Exported because the lane row count is DERIVED from six sliders rather than dialled, so the one caller that computes it has to clamp against the same numbers it will be checked against -- see the note over laneRowsFor in skymap.js.
export const MIN_TEXELS = 4
export const MAX_TEXELS = 4096

// The options every one of these shares. Written once because four copies of a format is four chances for one of them to be the odd one out, and the symptom of that is a single map going blocky while the others do not.
const COMMON = {
  type: THREE.HalfFloatType,
  format: THREE.RGBAFormat,
  colorSpace: THREE.NoColorSpace,
  generateMipmaps: false,
  depthBuffer: false,
  stencilBuffer: false,
}

const FILTERED = Object.assign( {}, COMMON, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.RepeatWrapping,
} )

// The kernel is indexed, not sampled. Linear filtering would blend two adjacent taps' premultiplied colours together, which is not a smoother kernel, it is the wrong kernel.
const INDEXED = Object.assign( {}, COMMON, {
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  wrapS: THREE.ClampToEdgeWrapping,
  wrapT: THREE.ClampToEdgeWrapping,
} )

let _lanes = null
let _hue = null
let _map = null
let _kernel = null

function make( w, h, options, name ) {
  const t = new THREE.WebGLRenderTarget( w, h, options )
  t.texture.name = name
  return t
}

export function skyLanesTarget() {
  if ( _lanes === null ) _lanes = make( DEFAULT_LANE_ROWS, DEFAULT_AZIMUTH, FILTERED, 'aurora-lab sky lanes' )
  return _lanes
}

export function skyHueTarget() {
  if ( _hue === null ) _hue = make( DEFAULT_LANE_ROWS, DEFAULT_AZIMUTH, FILTERED, 'aurora-lab sky hue' )
  return _hue
}

export function skyMapTarget() {
  if ( _map === null ) _map = make( DEFAULT_ROWS, DEFAULT_AZIMUTH, FILTERED, 'aurora-lab sky map' )
  return _map
}

export function skyKernelTarget() {
  if ( _kernel === null ) _kernel = make( DEFAULT_TAPS, 1, INDEXED, 'aurora-lab sky kernel' )
  return _kernel
}

// The accessors screen.js's CHUNK_SAMPLERS calls. Same shape as noiseLutTexture and planMapTexture, and they must stay plain zero-argument functions for that reason.
export function skyLanesTexture() { return skyLanesTarget().texture }
export function skyHueTexture() { return skyHueTarget().texture }
export function skyMapTexture() { return skyMapTarget().texture }
export function skyKernelTexture() { return skyKernelTarget().texture }

// ---------------------------------------------------------------------------

function checkTexels( label, n ) {
  if ( !Number.isFinite( n ) ) throw new Error( 'skymap: ' + label + ' texel count must be a finite number, got ' + n )
  if ( n < MIN_TEXELS || n > MAX_TEXELS ) {
    throw new Error( 'skymap: ' + label + ' texel count must be ' + MIN_TEXELS + '..' + MAX_TEXELS + ', got ' + n )
  }
}

function resize( target, w, h ) {
  if ( target.width === w && target.height === h ) return
  // Reallocates the GL storage and keeps target.texture's identity, so every material already holding this texture goes on holding the right one. See the header.
  target.setSize( w, h )
}

// The lane and hue maps are always the same size as each other, because a convolution tap fetches the same uv from both and a difference of one texel between them would be a hue read from the wrong altitude. One setter for the pair rather than two setters and a convention.
export function setSkyLaneSize( laneRows, azimuthTexels ) {
  checkTexels( 'lane row', laneRows )
  checkTexels( 'azimuth', azimuthTexels )
  const w = Math.round( laneRows )
  const h = Math.round( azimuthTexels )
  resize( skyLanesTarget(), w, h )
  resize( skyHueTarget(), w, h )
}

export function setSkyMapSize( rows, azimuthTexels ) {
  checkTexels( 'output row', rows )
  checkTexels( 'azimuth', azimuthTexels )
  resize( skyMapTarget(), Math.round( rows ), Math.round( azimuthTexels ) )
}

// One texel per tap, exactly. The convolution reads texel i at ( i + 0.5 ) / u_smTaps with nearest filtering, so a target one texel wide of the tap count is not a resolution choice at all -- a mismatch reads the wrong tap's weight and dims or brightens the whole sky.
export function setSkyKernelSize( taps ) {
  checkTexels( 'kernel', taps )
  resize( skyKernelTarget(), Math.round( taps ), 1 )
}

// ---------------------------------------------------------------------------

// Only correct at page teardown. Any AuroraScreen material built on the `sky map` algorithm is holding all four of these textures, and three does not dispose textures when a material is disposed, so freeing them while such a material can still be drawn is the freed-GL-object failure the header describes. The lab never tears down; this exists so that a page which does can.
export function disposeSkyMap() {
  for ( const t of [ _lanes, _hue, _map, _kernel ] ) {
    if ( t !== null ) t.dispose()
  }
  _lanes = null
  _hue = null
  _map = null
  _kernel = null
}
