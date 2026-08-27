// ---------------------------------------------------------------------------
// The map's render target, as a module singleton.
//
// ===========================================================================
// WHY A SINGLETON AND NOT A FIELD ON THE CLASS
// ===========================================================================
//
// screen.js binds a chunk's sampler at MATERIAL BUILD TIME, out of CHUNK_SAMPLERS, and _buildMaterial runs again on every algorithm switch. The bind is `{ value: s.texture() }`, so whatever `texture()` returns at that instant is what the material holds until the next switch. A texture owned by an instance that the page happens to construct after the screen -- or reconstructs on a resize, or disposes on a teardown -- would leave a material pointing at a freed GL object, and the symptom of that is a black sector with nothing in the console.
//
// So the target is owned here, at module scope, exactly as the noise LUT is owned by lut-texture.js and for the same reason that file gives. PlanMapAurora borrows it; screen.js borrows it; neither can outlive it.
//
// The identity of `target.texture` is what has to be stable, not the identity of the target's GL storage. three's WebGLRenderTarget.setSize disposes the underlying GL resources and lets the renderer recreate them, and it leaves the Texture OBJECT alone -- so changing the map's resolution reallocates the memory without ever invalidating a uniform slot. That is why setSize is used below and a fresh target is never constructed for a resize.
//
// ===========================================================================
// FORMAT
// ===========================================================================
//
// RGBA16F, filterable in core WebGL2 with no extension consulted, which matters because the bilinear tap IS the reconstruction here rather than a nicety. Four channels because the map stores four things (see planmap/glsl.js), two of which are SIGNED -- the warp displacement runs either way -- so an unsigned byte format is out on correctness before it is out on precision.
//
// Half float is not merely adequate here, it is comfortable, and that is a consequence of the decision to store the warp DISPLACEMENT rather than the warped position: everything in the texture is bounded by a slider, so the eleven bits of mantissa sit on a quantity of order one instead of on a plan coordinate of order five hundred. At the default warp amplitude the quantisation step is about a thousandth of a channel spacing.
//
// Size at the default 384 by 1024: 393,216 texels at eight bytes, which is 3.1 MB written once and read by every march step. Neither number is the interesting one; the interesting one is that 3.1 MB is larger than the L2 of a mobile part, which is why the layout in planmap/glsl.js puts a ray's forty consecutive fetches along one contiguous row, and why pmAzRes and pmRadRes are on the panel rather than being constants. Dropping to 256 by 512 is 1 MB and is the first thing to try on hardware where this is not winning.
//
// No depth buffer, no stencil: the generator is one full-target quad with depth off, so there is nothing for either to do, and on a tiled part not allocating them is a tile-memory saving rather than only a VRAM one.
//
// colorSpace is NoColorSpace because this is not colour. It is inert either way -- three forces LinearSRGBColorSpace for the ENCODE into any non-XR render target regardless of this field, and a hand-written sampler2D gets no decode injected on the way out -- so it is set for the next reader rather than for the renderer. It would stop being inert the moment anyone dropped this to eight-bit RGBA, which is exactly when getting it wrong would cost an afternoon.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

// Matching the defaults of pmRadRes and pmAzRes in planmap/algorithm.js. Two copies of a number, which is the shape of mistake this codebase has a standing opinion about -- so PlanMapAurora asserts they agree on construction rather than trusting the comment.
export const DEFAULT_RADIAL = 384
export const DEFAULT_AZIMUTH = 1024

// Guard rails. Below 64 azimuthal texels a texel is nearly six degrees wide and the sky is a polygon; above 2048 by 1024 the map is 16 MB and has stopped being a cache of anything.
const MIN_TEXELS = 32
const MAX_TEXELS = 4096

let _target = null

export function planMapTarget() {
  if ( _target === null ) {
    _target = new THREE.WebGLRenderTarget( DEFAULT_RADIAL, DEFAULT_AZIMUTH, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,

      // The bilinear tap is half the algorithm: it is what turns a 393k-texel grid into a field defined at every one of two million pixels. Not a smoothing pass that could be dropped.
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,

      // Radius clamps and azimuth wraps. Getting these the wrong way round is not subtle: a clamped azimuth draws a hard line down the sky at due south, and a wrapped radius folds the far horizon back onto the zenith.
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.RepeatWrapping,

      depthBuffer: false,
      stencilBuffer: false,
    } )
    _target.texture.name = 'aurora-lab plan map'
  }
  return _target
}

// The accessor screen.js's CHUNK_SAMPLERS calls. Same shape as noiseLutTexture, and it must stay a plain zero-argument function for that reason.
export function planMapTexture() {
  return planMapTarget().texture
}

export function setPlanMapSize( radialTexels, azimuthTexels ) {
  for ( const [ label, n ] of [ [ 'radial', radialTexels ], [ 'azimuth', azimuthTexels ] ] ) {
    if ( !Number.isFinite( n ) ) throw new Error( 'planmap: ' + label + ' texel count must be a finite number, got ' + n )
    if ( n < MIN_TEXELS || n > MAX_TEXELS ) {
      throw new Error( 'planmap: ' + label + ' texel count must be ' + MIN_TEXELS + '..' + MAX_TEXELS + ', got ' + n )
    }
  }

  const target = planMapTarget()
  const w = Math.round( radialTexels )
  const h = Math.round( azimuthTexels )
  if ( target.width === w && target.height === h ) return

  // Reallocates the GL storage and keeps target.texture's identity, so every material already holding this texture goes on holding the right one. See the header.
  target.setSize( w, h )
}

// Only correct at page teardown. Any AuroraScreen material built on the `planmap` algorithm is holding this texture, and three does not dispose textures when a material is disposed, so freeing it while such a material can still be drawn is the freed-GL-object failure the header describes. The lab never tears down; this exists so that a page which does can.
export function disposePlanMap() {
  if ( _target === null ) return
  _target.dispose()
  _target = null
}
