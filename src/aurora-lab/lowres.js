// ---------------------------------------------------------------------------
// The aurora, rendered small and put back big.
//
// ===========================================================================
// WHY THIS IS THE FIRST OPTIMISATION AND NOT THE LAST
// ===========================================================================
//
// The march costs roughly `steps` field evaluations per fragment and each field
// evaluation is fourteen to twenty-one noise lookups, so the shader's whole cost
// is (fragments) x (steps) x (lookups). Every other lever in the lab pulls on
// one of the last two factors and each of them changes the PICTURE: fewer steps
// means banding the dither has to work harder to hide, one warp stage means the
// marbling inside a bend goes away, a cheaper algorithm means a different sky.
//
// The first factor is the only one that can be pulled without changing what is
// being drawn, and it is quadratic. Rendering at 1/4 in each axis is 1/16 the
// fragments -- the same saving as taking 40 steps down to 2.5, which is not a
// number the march can be given -- and the sky it draws is the same sky, just
// carrying less detail than a 1080p screen could have shown. An aurora is the
// most forgiving possible subject for that trade: it is a smooth emissive
// gradient with no edges of its own anywhere, so the high frequencies being
// thrown away are almost entirely frequencies the shader invented by accident.
//
// ===========================================================================
// THE UPSCALE IS ALSO THE FIX FOR THE GRAIN, WHICH IS THE BIGGER HALF
// ===========================================================================
//
// The march offsets each fragment's sample positions by a per-pixel hash (see
// the banding section in glsl/frame.js). That converts a coherent shell into
// incoherent per-pixel noise, which is a straight improvement -- the eye
// integrates the noise away and cannot integrate a shell away -- but it is
// still a Monte-Carlo estimate with one sample per pixel, and the estimator's
// variance shows up as speckle: isolated dark pixels in the dim parts of the
// sky, worst exactly where the deposition curve is steepest.
//
// Blurring at full resolution would fix that and would cost a full-resolution
// blur. Here it is free, and better than free: the bilinear fetch that reads a
// 1/4-scale target already averages four samples of the estimator, and the tent
// below averages a neighbourhood of them. Rendering small does not merely make
// the noise cheaper to produce, it makes each output pixel the mean of several
// independent estimates, which is the actual definition of reducing variance.
// The artefact and the cost go away in the same pass.
//
// ===========================================================================
// TWO MESHES, ONE GEOMETRY, AND WHY THE COMPOSITE IS NOT A FULLSCREEN QUAD
// ===========================================================================
//
// The obvious composite is a fullscreen triangle with depth off. It is wrong
// here for one reason: the mountains. The aurora sits at 5200 units and is cut
// off at the skyline by the depth test against the backdrop (see the header of
// screen.js -- that is the one occlusion in this scene that is real). A
// fullscreen quad has no depth, so it would paint the aurora straight over the
// mountains and the horizon would stop existing.
//
// So the composite is drawn on the SAME northern sector, at the SAME world
// position, with the same depthTest/depthWrite/blending as the real thing. The
// depth test then does exactly what it did before, because as far as the
// rasteriser is concerned nothing about the aurora's geometry has changed --
// only the shader that fills it in got cheap.
//
// The two meshes share `screen.geometry` by reference. That is not a memory
// micro-optimisation (it is four thousand triangles); it is what makes it
// impossible for the offscreen pass and the composite to disagree about where
// the sector is. If they ever disagreed by a single vertex the composite would
// sample the target outside the region the target drew, and the seam would be a
// hard edge in the sky that no amount of blur could explain.
//
// For the same reason the composite reuses VERTEX_GLSL verbatim rather than
// writing the equivalent projection with modelViewMatrix. It IS the equivalent,
// to within a float rounding, and "to within a float rounding" is precisely the
// budget available before a silhouette pixel moves.
//
// ===========================================================================
// THE SCREEN-SPACE MAPPING, AND WHY IT NEEDS NO REPROJECTION
// ===========================================================================
//
// Pass 1 renders the sector with THE SAME CAMERA into a viewport that covers
// the whole target. A vertex at clip position p lands at framebuffer x
// (p.x/p.w * 0.5 + 0.5) * W for whatever W that framebuffer is. So the ratio
// gl_FragCoord.x / W is the same number in both passes, and reading the target
// at uv = gl_FragCoord.xy / viewportSize is exact -- not approximate, not a
// reprojection, the same point. Nothing has to be told the camera moved,
// because the mapping never referred to the camera in the first place.
//
// The one assumption is that the pass-2 viewport starts at the drawing
// buffer's origin, which is why the uniform is a vec4 rect and not a vec2 size.
// In a WebXR side-by-side framebuffer it does not: the right eye draws into the
// right half, so gl_FragCoord.x runs from W/2 to W while the target still holds
// a 0..W image of ONE eye. Getting that right means one target per eye and a
// viewport set per eye, and this class does not do it yet -- see the report.
// Written as a rect so that fix is a setter and not a shader rewrite.
//
// ===========================================================================
// COLOUR SPACE -- WHAT THE THREE SOURCE ACTUALLY DOES HERE
// ===========================================================================
//
// MAIN_GLSL ends with #include <colorspace_fragment>, which expands to
// `gl_FragColor = linearToOutputTexel( gl_FragColor )`. That function is
// GENERATED per program, and the colour space it is generated for is decided in
// WebGLPrograms.js line 202 (and re-checked in WebGLRenderer.js line 2189):
//
//   ( currentRenderTarget === null ) ? renderer.outputColorSpace
//     : ( currentRenderTarget.isXRRenderTarget ? target.texture.colorSpace
//                                              : LinearSRGBColorSpace )
//
// So the encode is NOT unconditional. Drawn to the canvas it is the sRGB OETF,
// because the page sets renderer.outputColorSpace = SRGBColorSpace. Drawn into
// an ordinary render target it is forced to LinearSRGBColorSpace, and
// getEncodingComponents then returns the identity matrix and LinearTransferOETF
// -- a passthrough. The aurora therefore lands in the target LINEAR, exactly
// once un-encoded, whatever the target texture's own colorSpace says.
//
// That settles the double-encode question in both directions:
//
//   - the target holds linear radiance, so the tent below averages linear
//     values, which is the only space in which averaging light is meaningful;
//   - the composite must therefore do the sRGB encode ITSELF, which is why it
//     carries the same #include. Leaving it off is the "zero times" failure and
//     it is not subtle: the whole sky comes out crushed and dark.
//
// One trap follows from the same code. WebGLRenderer.js line 2242 rebuilds a
// program when a material's cached outputColorSpace no longer matches the
// destination. `screen.material` is one material instance on two meshes, so
// drawing it to the target AND to the canvas in the same frame would recompile
// this shader twice a frame forever. That is why `screen.mesh.visible` is
// driven from here: in low-res mode the expensive material is only ever drawn
// into the target, and in bypass mode only ever to the canvas. Exactly one
// destination per frame, so the cache holds.
//
// ===========================================================================
// HALF FLOAT, AND WHAT IT COSTS ON A QUEST
// ===========================================================================
//
// The target is RGBA16F. Two reasons, and the second is the one that decided it.
//
// The aurora is additive HDR: gl_FragColor is max(c * exposure, 0) with no tone
// map and no clamp, and bright channel cores routinely land above 1. An 8-bit
// target would clip those to white before the composite ever saw them, so a
// blown highlight would stop being a highlight and start being a flat patch.
//
// Worse, an 8-bit target would hold LINEAR values in 8 bits. sRGB's whole
// purpose is that 8 bits of a linear ramp is not enough near black, and near
// black is where most of an aurora lives -- the skirt, the top fade, the dim
// two thirds of the belt. Quantising linearly there and then applying the sRGB
// OETF in the composite stretches the quantisation steps apart and gives visible
// banding in exactly the regions the dither was added to protect. Half float has
// no such floor.
//
// Cost on a Quest 2: eight bytes a texel instead of four. That sounds bad and is
// not, because the whole point of this file is that the target is tiny. At a
// 2064x2208 per-eye buffer and div = 4 the target is 516x552, which is 285k
// texels, which is 2.3 MB written once and read once per eye per frame. At 72 Hz
// that is well under a gigabyte a second on a part with ~25 GB/s to spare, and
// it replaces something like 80 million noise lookups. There is no version of
// this trade where the bandwidth is the problem.
//
// (RGBA16F is filterable in core WebGL2 -- no OES_texture_half_float_linear
// extension needed -- which matters because the bilinear fetch is doing half the
// denoising.)
// ---------------------------------------------------------------------------

import * as THREE from 'three'

import { VERTEX_GLSL } from './glsl/frame.js'

// The tent's radius in taps, as a compile-time constant so the double loop
// unrolls into nine texture fetches with no branch. 1 gives the classic 1-2-1
// separable tent; the weight expression below generalises to any radius, which
// is a courtesy to whoever tries 2 rather than an invitation -- nine taps is
// already past the point where more taps beat a larger u_blur, because bilinear
// is doing the interpolation between them anyway.
const TAP_RADIUS = 1

// Guard rails on the divisor. Above about 8 the sector's own silhouette starts
// to be the thing that is undersampled rather than the sky inside it, and there
// is no point going further; 10 is a round number past that for anyone who
// wants to see the failure clearly.
const DIV_MIN = 1
const DIV_MAX = 10

// ---------------------------------------------------------------------------
// The composite shader. Cheap by construction: no march, no noise, one to nine
// texture fetches and an sRGB encode.
//
// Note the uniform names are in the u_ namespace but are NOT generated from the
// param schema -- this material is built here, by hand, and never goes through
// screen.js's declarationsFor. The two knobs that DO come from the schema
// (lowRes, lowBlur) are `uniform: false` params that drive this class's setters,
// so there is no u_lowRes anywhere and no collision to worry about.

const COMPOSITE_FRAGMENT_GLSL = `
  uniform sampler2D u_source;
  uniform vec4 u_viewport;
  uniform vec2 u_texel;
  uniform float u_blur;

  vec3 sourceAt( vec2 uv ) {
    return texture2D( u_source, uv ).rgb;
  }

  void main() {
    // See the header: pass 1 used this camera and a full-target viewport, so
    // this ratio is the same number it was over there. No reprojection.
    vec2 uv = ( gl_FragCoord.xy - u_viewport.xy ) / u_viewport.zw;

    vec3 c;

    // Gated on a uniform, so every fragment in the draw takes the same branch
    // and a blur of zero costs the compare rather than the kernel -- the same
    // argument the march makes for its three optional per-step terms.
    if ( u_blur > 0.0 ) {
      // The offset is in TEXELS OF THE TARGET, which is the whole reason
      // u_texel is a uniform rather than a constant. A blur measured in screen
      // pixels would have to be re-tuned every time the divisor moved; measured
      // in target texels, "one texel of softening" means the same amount of
      // softening at every divisor, and the knob stays where you left it.
      vec2 o = u_texel * u_blur;

      c = vec3( 0.0 );
      float wsum = 0.0;
      for ( int j = -TAP_RADIUS; j <= TAP_RADIUS; j++ ) {
        for ( int i = -TAP_RADIUS; i <= TAP_RADIUS; i++ ) {
          // Separable tent: 2 at the centre tap, 1 at the edge, so the 3x3 case
          // is 1-2-1 by 1-2-1 over 16. Normalised by the running sum rather
          // than by a constant, so changing TAP_RADIUS cannot silently change
          // the brightness of the sky.
          float w = ( float( TAP_RADIUS ) + 1.0 - abs( float( i ) ) )
                  * ( float( TAP_RADIUS ) + 1.0 - abs( float( j ) ) );
          c += sourceAt( uv + vec2( float( i ), float( j ) ) * o ) * w;
          wsum += w;
        }
      }
      c /= wsum;
    } else {
      c = sourceAt( uv );
    }

    gl_FragColor = vec4( c, 1.0 );

    // The target held LINEAR radiance -- three forces linearToOutputTexel to a
    // passthrough when the destination is an ordinary render target -- so this
    // is the sRGB encode the aurora would have done for itself if it had been
    // drawn straight to the canvas. See the colour-space section of the header.
    #include <colorspace_fragment>
  }
`

// ---------------------------------------------------------------------------

export class LowResAurora {
  constructor( renderer, screen ) {
    if ( !renderer || !renderer.isWebGLRenderer ) throw new Error( 'LowResAurora: needs a WebGLRenderer' )
    if ( !screen || !screen.geometry || !screen.material ) throw new Error( 'LowResAurora: needs an AuroraScreen with a built material' )

    this._renderer = renderer
    this._screen = screen

    this._div = 1
    this._blur = 1
    // Deliberately not defaulted to the canvas size. The caller's resize() is
    // the one place that knows the drawing-buffer size, and a default here
    // would let a page that forgot to call setSize limp along at whatever
    // resolution this file guessed. render() throws instead.
    this._w = 0
    this._h = 0

    this._target = null

    // Pass 1's scene holds the aurora and NOTHING else, which is the entire
    // reason it is a separate scene rather than a layer mask on the main one:
    // the stars and the mountains must not land in the target, and a layer
    // discipline that has to be maintained across three other files is a rule
    // someone will break, whereas an empty scene cannot acquire members.
    this._offscreenScene = new THREE.Scene()
    this._offscreenMesh = new THREE.Mesh( screen.geometry, screen.material )
    this._offscreenMesh.frustumCulled = true
    this._offscreenScene.add( this._offscreenMesh )

    this._compositeMaterial = new THREE.ShaderMaterial( {
      uniforms: {
        u_source: { value: null },
        u_viewport: { value: new THREE.Vector4( 0, 0, 1, 1 ) },
        u_texel: { value: new THREE.Vector2( 1, 1 ) },
        u_blur: { value: this._blur },
      },
      vertexShader: VERTEX_GLSL,
      fragmentShader: COMPOSITE_FRAGMENT_GLSL,
      defines: { TAP_RADIUS: TAP_RADIUS },
      // Every one of these matches screen.js exactly, and they have to: the
      // composite stands in for that mesh, so anything it does differently is a
      // difference the A/B against div = 1 would show as a change in the sky
      // rather than as a change in the resolution.
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    } )

    this._compositeMesh = new THREE.Mesh( screen.geometry, this._compositeMaterial )
    this._compositeMesh.frustumCulled = true
    this._compositeMesh.renderOrder = screen.mesh.renderOrder

    // Boot in bypass: the reference sky is what the lab should show until
    // somebody asks for something cheaper.
    this._applyVisibility()
  }

  // -------------------------------------------------------------------------

  get mesh() {
    return this._compositeMesh
  }

  get div() {
    return this._div
  }

  // Exactly one of the two meshes draws in any frame. See the program-cache
  // trap in the header: screen.material rendered to two different destinations
  // in one frame recompiles itself twice a frame, forever, silently.
  _applyVisibility() {
    const bypass = this._div === 1
    this._screen.mesh.visible = bypass
    this._compositeMesh.visible = !bypass
  }

  setDiv( div ) {
    if ( !Number.isFinite( div ) ) throw new Error( 'LowResAurora: div must be a finite number, got ' + div )
    // The slider hands over a float with step 1, and a target sized from 3.9999
    // would be one pixel short of the one sized from 4. Round once, here, so
    // there is a single integer the target size and the bypass test both read.
    const d = Math.round( div )
    if ( d < DIV_MIN || d > DIV_MAX ) throw new Error( 'LowResAurora: div must be ' + DIV_MIN + '..' + DIV_MAX + ', got ' + div )
    if ( d === this._div ) return
    this._div = d

    // A true bypass, not a 1:1 round trip. The whole value of div = 1 is that
    // it is the REFERENCE -- the pixels the shader would have produced with
    // this file absent -- so it must not pay for a target, a copy, a bilinear
    // fetch or an extra encode/decode, any of which would make the A/B a
    // comparison between two lossy paths instead of against the truth.
    if ( d === 1 ) this._releaseTarget()
    else this._resizeTarget()

    this._applyVisibility()
  }

  setBlur( texels ) {
    if ( !Number.isFinite( texels ) || texels < 0 ) throw new Error( 'LowResAurora: blur must be a finite number >= 0, got ' + texels )
    this._blur = texels
    this._compositeMaterial.uniforms.u_blur.value = texels
  }

  // Drawing-buffer pixels, not CSS pixels: gl_FragCoord counts framebuffer
  // texels, so anything measured in CSS units here would be wrong by the pixel
  // ratio the moment the page ran on a retina display or moved the render-scale
  // slider off 1.
  setSize( widthPx, heightPx ) {
    if ( !Number.isFinite( widthPx ) || !Number.isFinite( heightPx ) || widthPx < 1 || heightPx < 1 ) {
      throw new Error( 'LowResAurora: setSize needs positive drawing-buffer pixels, got ' + widthPx + 'x' + heightPx )
    }
    const w = Math.round( widthPx )
    const h = Math.round( heightPx )
    if ( w === this._w && h === this._h ) return
    this._w = w
    this._h = h

    this._compositeMaterial.uniforms.u_viewport.value.set( 0, 0, w, h )
    this._resizeTarget()
  }

  // -------------------------------------------------------------------------

  _targetSize() {
    // ceil, never floor. A floor can round the target down to a size whose
    // rasterised sector is a hair smaller than the composite's, and the
    // composite would then read the clamped edge texel along one side -- a
    // one-pixel smear down the right of the sky that only appears at some
    // window widths, which is the worst kind of bug to be handed.
    return {
      w: Math.max( 1, Math.ceil( this._w / this._div ) ),
      h: Math.max( 1, Math.ceil( this._h / this._div ) ),
    }
  }

  _resizeTarget() {
    if ( this._div === 1 ) return
    if ( this._w === 0 || this._h === 0 ) return

    const { w, h } = this._targetSize()

    if ( !this._target ) {
      this._target = new THREE.WebGLRenderTarget( w, h, {
        // See the header for the full argument. Short version: the aurora is
        // additive HDR and the target holds LINEAR values, and eight bits of a
        // linear ramp bands visibly in the dim two thirds of the sky.
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        // Documents what is in the texture. It does not change the encode --
        // three forces LinearSRGBColorSpace for any non-XR render target
        // regardless of this field -- and it does not decode on read either,
        // because a hand-written sampler2D in a ShaderMaterial gets no
        // conversion injected. It is here so the next reader does not have to
        // go and find that out.
        colorSpace: THREE.LinearSRGBColorSpace,
        // Bilinear on the way up is not a nicety, it is half of the denoising.
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
        // Pass 1's scene contains one mesh with depthWrite off, so there is
        // nothing for a depth buffer to do. GL defines the depth test as always
        // passing when no depth buffer is attached, so depthTest can stay true
        // on the shared material and the attachment is simply not allocated --
        // which on a tiled part is a tile-memory and bandwidth saving, not just
        // a VRAM one.
        depthBuffer: false,
        stencilBuffer: false,
      } )
      this._compositeMaterial.uniforms.u_source.value = this._target.texture
    } else {
      this._target.setSize( w, h )
    }

    this._compositeMaterial.uniforms.u_texel.value.set( 1 / w, 1 / h )
  }

  _releaseTarget() {
    if ( !this._target ) return
    this._target.dispose()
    this._target = null
    this._compositeMaterial.uniforms.u_source.value = null
  }

  // -------------------------------------------------------------------------

  // Pass 1 only. The caller renders the main scene afterwards, and the
  // composite mesh in that scene is what puts this target on the screen.
  render( camera ) {
    if ( this._div === 1 ) return

    if ( this._w === 0 || this._h === 0 ) throw new Error( 'LowResAurora: render() before setSize() -- nothing knows how big the target should be' )
    if ( !this._target ) throw new Error( 'LowResAurora: render() with no target allocated' )

    // ---- Re-borrow the material, every frame, because it is not stable.
    //
    // AuroraScreen.setAlgorithm rebuilds the ShaderMaterial from scratch and
    // DISPOSES the old one, so a reference captured in the constructor goes
    // stale the first time somebody changes algorithm on the panel. The symptom
    // is a freed GL program being drawn -- a black sector, no console line, and
    // it only happens after a switch, which makes it look like the new algorithm
    // is broken rather than like this file is holding a corpse.
    //
    // Compared rather than assigned unconditionally: assigning a material marks
    // the mesh dirty in three's sorting, and this is a per-frame path.
    if ( this._offscreenMesh.material !== this._screen.material ) {
      this._offscreenMesh.material = this._screen.material
    }

    // screen.update() has already put the sector on the camera this frame. Both
    // of our meshes follow it from there rather than from the camera directly,
    // so if that rule ever changes there is one place it is expressed and two
    // places that obey it, instead of three places that agree by coincidence.
    this._offscreenMesh.position.copy( this._screen.mesh.position )
    this._offscreenMesh.quaternion.copy( this._screen.mesh.quaternion )
    this._compositeMesh.position.copy( this._screen.mesh.position )
    this._compositeMesh.quaternion.copy( this._screen.mesh.quaternion )

    const renderer = this._renderer

    // Restore whatever was bound rather than assuming null. On this page it is
    // null; inside a post chain or an XR frame it is not, and a hardcoded null
    // there would redirect the rest of the frame to the canvas with no error
    // and no obvious symptom beyond "the second half of the scene vanished".
    const prevTarget = renderer.getRenderTarget()

    // The clear colour is saved and restored because pass 1 needs a genuinely
    // transparent black start -- the material is additive, so whatever is in
    // the target is added to, and a stale frame would accumulate into a
    // brightening smear. Not simply read from the page's own clear colour,
    // which happens to be opaque black today: this must not break the day
    // somebody sets the lab's background to anything else.
    // Saved as a Color rather than as a hex: setClearColor stores linear
    // working-space floats, and getHex would push them back out through an
    // 8-bit sRGB quantisation on the way to being handed straight back in.
    // Exact for the black this page uses and lossy for anything else, which is
    // the shape of bug that surfaces six months later on a different branch.
    renderer.getClearColor( _clear )
    const prevAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget( this._target )
    renderer.setClearColor( 0x000000, 0 )
    renderer.clear()
    renderer.render( this._offscreenScene, camera )

    renderer.setRenderTarget( prevTarget )
    renderer.setClearColor( _clear, prevAlpha )
  }

  // -------------------------------------------------------------------------

  dispose() {
    this._releaseTarget()
    this._offscreenScene.remove( this._offscreenMesh )
    this._compositeMaterial.dispose()

    // Neither the geometry nor screen.material is ours -- both are borrowed
    // from the AuroraScreen by reference, which is the point (see the header).
    // Disposing either here would leave the screen holding a freed GL object,
    // and the symptom is a black sector two frames later with nothing in the
    // console.

    // Hand the sky back the way it was found. A dispose that leaves the real
    // mesh hidden is indistinguishable from the aurora having broken.
    this._screen.mesh.visible = true
  }
}

// Scratch for the clear-colour save. Module scope rather than per-call so the
// frame loop allocates nothing.
const _clear = new THREE.Color()
