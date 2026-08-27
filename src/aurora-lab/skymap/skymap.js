// ---------------------------------------------------------------------------
// The four passes that fill the sky map. All of them run once per frame, before anything is drawn, in the order they appear below.
//
// Read skymap/glsl.js for what the maps ARE and why the integral is a convolution at all. This file is only the plumbing, and it is PlanMapAurora's plumbing with one pass turned into four -- deliberately the same shape, so the page drives it the same way.
//
// ===========================================================================
// THE ORDER IS THE DEPENDENCY, AND IT IS THE WHOLE OF THE SCHEDULING
// ===========================================================================
//
//   1. KERNEL, u_smTaps by 1. Depends on nothing.
//   2. LANES, the emission at three weather slices. Depends on nothing; one auroraField call per texel.
//   3. HUE, the neon palette's colour. Depends on nothing; one auroraField call per texel.
//   4. CONVOLVE. Reads all three of the above and writes the map the screen fetches.
//
// So 1, 2 and 3 are mutually independent and 4 waits on all of them. There is no barrier to issue: consecutive renderer.render calls to different targets are ordered by the GL pipeline, and the only thing that would break it is a pass reading a target it is also writing.
//
// ===========================================================================
// FOUR MATERIALS, NOT ONE MATERIAL WITH A PASS UNIFORM
// ===========================================================================
//
// The obvious economy is one program with `uniform int u_smPass` and a four-way branch, and it is rejected for a reason that shows up on exactly the hardware this is aimed at. A uniform branch does not diverge, but the register allocator still budgets for the union of the branches, so the two generator passes -- which are one field evaluation and some shaping -- would be allocated as though they also contained the forty-tap loop, and occupancy on a tile GPU is decided by that allocation. The generator is 82k invocations of a small shader; making it look like a large one costs more than three extra programs do.
//
// The cost of the split is three additional compiles at page load, of a shader that is already being compiled for the screen. It is paid once, off the frame, and three.js does it lazily on each pass's first draw.
//
// The four materials SHARE their param uniform slots by reference and own their sampler slots separately. That is not a micro-optimisation: it is what makes "write the panel values once per frame" true rather than "write them four times and hope the four loops stay in step".
//
// ===========================================================================
// WHY THE SAMPLERS ARE NULL IN THREE OF THE FOUR
// ===========================================================================
//
// The chunk declares all four samplers in every program that compiles it, because the reader half and the convolution half are in one chunk for the same reason planmap's two halves are. But BINDING a texture that is also attached to the framebuffer is undefined in GL whether or not the fetch is reached, and passes 2 and 3 write the very targets the convolution reads. So only pass 4 binds anything, and it leaves u_skyMap null because u_skyMap is the target it is writing. three binds its 1x1 empty texture for a null slot, so no loop can be formed.
//
// ===========================================================================
// THE LANE HEIGHT IS DERIVED, WHICH IS THE ONE PIECE OF ARITHMETIC IN HERE
// ===========================================================================
//
// Every other size on this page is a slider. The lane maps' height cannot be, because they have to hold one altitude window PAST the output map at each end -- the ray that leaves the top row of the map still integrates upward from it -- at a spacing of one tap. So it follows from the taps, the altitude range, the sector's extent and the perspective, and laneRowsFor below is the JS restatement of the same four lines the shader computes in smSpan, smKw and smDv. That restatement is a duplicated formula, which this codebase does not like, and the alternative is worse: the shader cannot resize a render target and the JS cannot read a uniform back, so somebody has to know both. It is kept to four expressions and every one of them is named after the GLSL function it mirrors.
//
// ===========================================================================
// TIME IS ITS OWN UNIFORM AND NOT uTime
// ===========================================================================
//
// Same as PlanMapAurora, and the same failure if it is got wrong: the page must hand render() the SAME accumulated shader time it hands screen.update, and a mismatch renders the sky from a different instant than the frame that reads it, which looks like the aurora lagging its own controls.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

import { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL } from '../glsl/noise.js'
import { PALETTE_GLSL } from '../glsl/palette.js'
import { ALGORITHMS, paramsFor } from '../algorithms.js'
import { GLSL_TYPE, toUniformValue, writeUniformValue } from '../screen.js'
import { SKYMAP } from './algorithm.js'
import { SKYMAP_GLSL, SKYMAP_FRAME_GLSL } from './glsl.js'
import {
  DEFAULT_AZIMUTH, DEFAULT_ROWS, DEFAULT_TAPS, DEFAULT_LANE_ROWS, MIN_TEXELS, MAX_TEXELS,
  skyKernelTarget, skyLanesTarget, skyHueTarget, skyMapTarget,
  skyKernelTexture, skyLanesTexture, skyHueTexture, skyMapTexture,
  setSkyKernelSize, setSkyLaneSize, setSkyMapSize,
} from './target.js'

const DEG = Math.PI / 180

// Every algorithm whose shader compiles the skymap chunk, and therefore every algorithm that fetches the map and needs it to be current. Derived from the registry rather than listed, for the reason PlanMapAurora gives: forgetting to edit a list is only a failure mode if there is a list to forget.
const MAP_READERS = new Set( ALGORITHMS.filter( a => a.needs.indexOf( 'skymap' ) !== -1 ).map( a => a.id ) )
if ( !MAP_READERS.has( SKYMAP.id ) ) throw new Error( 'SkyMapAurora: the skymap algorithm does not declare "skymap" in its needs, so the chunk would not be compiled and nothing would regenerate the map' )

// The four samplers the chunk declares, in the order screen.js's CHUNK_SAMPLERS lists them. Named here rather than imported because what this file needs is the NAMES, and CHUNK_SAMPLERS carries the runtime texture accessors alongside them.
const SAMPLERS = [ 'u_skyMap', 'u_skyLanes', 'u_skyHue', 'u_skyKernel' ]

// A quad in clip space with no matrices at all, exactly as in planmap/planmap.js. uv IS the map coordinate; a projection in the path would only be somewhere for a half-texel offset to hide.
const VERTEX_GLSL = `
  varying vec2 vSkyUv;

  void main() {
    vSkyUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`

// No #include <colorspace_fragment> on any of them. Three of the four are not colour at all, and the fourth is linear radiance that the screen multiplies by the extinction before MAIN_GLSL encodes it once. Nothing appends it on our behalf either: three only injects that into its own materials.
function mainFor( call ) {
  return `
  varying vec2 vSkyUv;

  void main() {
    gl_FragColor = ${ call };
  }
`
}

// The four passes, in dependency order. `target` is called per frame rather than captured, because a resize replaces the GL storage behind it.
const PASSES = [
  { key: 'kernel', call: 'smKernel( vSkyUv )', target: skyKernelTarget, binds: [] },
  { key: 'lanes', call: 'smLanes( vSkyUv, u_smTime )', target: skyLanesTarget, binds: [] },
  { key: 'hue', call: 'smHue( vSkyUv, u_smTime )', target: skyHueTarget, binds: [] },
  {
    key: 'convolve',
    call: 'smConvolve( vSkyUv, u_smTime )',
    target: skyMapTarget,
    // Everything except u_skyMap, which is this pass's own output. See the header.
    binds: [
      { uniform: 'u_skyLanes', texture: skyLanesTexture },
      { uniform: 'u_skyHue', texture: skyHueTexture },
      { uniform: 'u_skyKernel', texture: skyKernelTexture },
    ],
  },
]

// ---------------------------------------------------------------------------

// The JS restatement of smSpan, smKw and smDv. See the header for why it exists. Named after the GLSL it mirrors so that the two can be read side by side.
function smDenom( ny, persp ) {
  return Math.max( ny * persp + ( 1 - persp ), 0.035 )
}

function smLogScale( ny, persp, fieldScale ) {
  return Math.log( Math.sqrt( Math.max( 1 - ny * ny, 1e-12 ) ) * fieldScale / smDenom( ny, persp ) )
}

// One tap of margin past the output map at each end, in texels of one tap.
//
// Clamped rather than thrown on, and that is a considered exception to the house rule. The panel permits altHigh below altLow, which makes log( altHigh / altLow ) negative and the altitude window inside-out; the march renders that configuration as a black sky and this pass would render it as an exception thrown out of the frame loop. A slider drag must not be able to take the page down, and a degenerate sky is already telling the user what they did.
function laneRowsFor( values ) {
  const sMax = smLogScale( values.horizonCut, values.persp, values.fieldScale )
  const sMin = smLogScale( Math.sin( values.smTopDeg * DEG ), values.persp, values.fieldScale )
  const span = sMax - sMin
  const kw = Math.log( values.altHigh / values.altLow )
  const dv = kw / Math.max( values.smTaps, 1 )
  const rows = Math.round( ( span + kw ) / dv )
  if ( !Number.isFinite( rows ) ) return DEFAULT_LANE_ROWS
  return Math.min( Math.max( rows, MIN_TEXELS ), MAX_TEXELS )
}

// ---------------------------------------------------------------------------

export class SkyMapAurora {
  constructor( renderer ) {
    if ( !renderer || !renderer.isWebGLRenderer ) throw new Error( 'SkyMapAurora: needs a WebGLRenderer' )
    this._renderer = renderer

    // The WHOLE param list for this algorithm, not a hand-picked subset of shared names the way PlanMapAurora keeps one. That file's argument -- that declaring fifty uniforms in a shader which reads six is how you lose track of which ones matter -- inverts here: the generator reads the channel shape, the emitting layer, the belt, the flow, the shimmer, the palette and the weather, which is nearly the whole shared schema. An explicit list of thirty-eight names would be a maintenance liability with no discriminating value, and it is the same list screen.js declares anyway, since this compiles the same chunks.
    const params = paramsFor( SKYMAP.id )

    // Two copies of a number is the mistake this module is most exposed to: the schema's defaults size the panel's sliders and target.js's constants size the buffers that are allocated before the panel has said anything. If they disagree, the map is one resolution and the readout says another, which is invisible in the picture.
    const decl = key => {
      const p = params.find( x => x.key === key )
      if ( !p ) throw new Error( 'SkyMapAurora: the skymap schema has no "' + key + '" param' )
      return p
    }
    const azDefault = decl( 'smAzRes' ).value
    const rowDefault = decl( 'smRows' ).value
    const tapDefault = decl( 'smTaps' ).value
    if ( azDefault !== DEFAULT_AZIMUTH ) throw new Error( 'SkyMapAurora: smAzRes default ' + azDefault + ' disagrees with DEFAULT_AZIMUTH ' + DEFAULT_AZIMUTH )
    if ( rowDefault !== DEFAULT_ROWS ) throw new Error( 'SkyMapAurora: smRows default ' + rowDefault + ' disagrees with DEFAULT_ROWS ' + DEFAULT_ROWS )
    if ( tapDefault !== DEFAULT_TAPS ) throw new Error( 'SkyMapAurora: smTaps default ' + tapDefault + ' disagrees with DEFAULT_TAPS ' + DEFAULT_TAPS )

    // The params that actually become uniforms, resolved once. render() runs per frame and has no business re-walking the schema.
    this._uniformParams = params.filter( p => p.uniform !== false )

    const lines = [ 'uniform float u_smTime;' ]
    for ( const s of SAMPLERS ) lines.push( 'uniform sampler2D ' + s + ';' )
    for ( const p of this._uniformParams ) {
      const t = GLSL_TYPE[ p.type ]
      if ( !t ) throw new Error( 'SkyMapAurora: param "' + p.key + '" has unmappable type "' + p.type + '"' )
      lines.push( 'uniform ' + t + ' u_' + p.key + ';' )
    }

    // Shared BY REFERENCE across the four materials, so one write per frame reaches all of them. See the header.
    this._time = { value: 0 }
    const shared = { u_smTime: this._time }
    for ( const p of this._uniformParams ) shared[ 'u_' + p.key ] = { value: toUniformValue( p, p.value ) }
    this._shared = shared

    // Library order, matching screen.js's `ordered`: grad before fbm because gfbm2 calls gnoise2, fbm before warp, warp before the algorithm's field, and PALETTE before the frame that calls emissionRamp and neonRamp. GLSL has no forward declarations here, so this list is load-bearing rather than tidy.
    const fragment = [
      lines.join( '\n' ),
      UTIL_GLSL,
      HASH_GLSL,
      VALUE_GLSL,
      GRAD_GLSL,
      FBM_GLSL,
      WARP_GLSL,
      SKYMAP_GLSL,
      PALETTE_GLSL,
      SKYMAP.glsl,
      SKYMAP_FRAME_GLSL,
    ].join( '\n' )

    this._scene = new THREE.Scene()
    // A bare Camera, not an OrthographicCamera. renderer.render insists on one and reads nothing off it here, and an ortho camera would suggest the vertex shader used its matrices.
    this._camera = new THREE.Camera()
    // One quad, reused by all four passes, with the material swapped between them. The geometry is 24 vertices of nothing; four copies of it would be four things to dispose.
    this._geometry = new THREE.PlaneGeometry( 2, 2 )

    this._passes = PASSES.map( pass => {
      const uniforms = Object.assign( {}, shared )
      // Declared in every program because the chunk declares them; bound only where binding one is not binding a target to itself.
      for ( const s of SAMPLERS ) uniforms[ s ] = { value: null }
      for ( const b of pass.binds ) uniforms[ b.uniform ] = { value: b.texture() }

      const material = new THREE.ShaderMaterial( {
        uniforms,
        vertexShader: VERTEX_GLSL,
        fragmentShader: [ fragment, mainFor( pass.call ) ].join( '\n' ),
        // Every texel is written by one opaque quad. Blending would mix in what the previous frame left; depth would have to be allocated to be tested against.
        blending: THREE.NoBlending,
        transparent: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      } )

      const mesh = new THREE.Mesh( this._geometry, material )
      // The vertex shader ignores every matrix, so the mesh has no position in any space three understands and its bounding sphere is meaningless. Culling it would be culling against a lie.
      mesh.frustumCulled = false

      return { key: pass.key, target: pass.target, material, mesh }
    } )

    this._azimuth = DEFAULT_AZIMUTH
    this._rows = DEFAULT_ROWS
    this._taps = DEFAULT_TAPS
    this._laneRows = DEFAULT_LANE_ROWS
  }

  // -------------------------------------------------------------------------

  // What screen.js's material is bound to through CHUNK_SAMPLERS. Stable across every resize -- see the header of skymap/target.js.
  get texture() {
    return skyMapTexture()
  }

  get azimuthTexels() {
    return this._azimuth
  }

  get rowTexels() {
    return this._rows
  }

  // Derived, not dialled. Exposed so the panel's readout can say how large the intermediates actually are, which is the number that decides whether this pass fits in cache.
  get laneRowTexels() {
    return this._laneRows
  }

  // -------------------------------------------------------------------------

  // Called once per frame, BEFORE the frame that reads the map. `values` is the panel's whole state, in schema units, exactly as AuroraScreen holds it.
  //
  // A no-op under every algorithm that does not read the map, for the reason PlanMapAurora gives at length: paying for a prepass the selected algorithm does not read makes every A/B on the panel a comparison against a handicapped reference. The test is on `needs` rather than on the id, so any future pairing of this field with another frame regenerates the map without an edit here.
  render( algorithmId, values, time ) {
    if ( !MAP_READERS.has( algorithmId ) ) return

    if ( !Number.isFinite( time ) ) throw new Error( 'SkyMapAurora: render() needs a finite time, got ' + time )
    if ( !values ) throw new Error( 'SkyMapAurora: render() needs the panel values' )

    this._time.value = time

    // Read straight out of the panel state rather than from a cached copy. Every map is rebuilt from scratch every frame anyway, so a dirty flag would be bookkeeping that can go wrong in exchange for saving sixty assignments. The write goes to the SHARED slot, so it lands in all four materials.
    for ( const p of this._uniformParams ) {
      const v = values[ p.key ]
      if ( p.type === 'color' ) {
        if ( !Array.isArray( v ) || v.length !== 3 || !v.every( c => Number.isFinite( c ) ) ) {
          throw new Error( 'SkyMapAurora: param "' + p.key + '" is a colour and must be three finite numbers, got ' + JSON.stringify( v ) )
        }
      } else if ( !Number.isFinite( v ) ) {
        throw new Error( 'SkyMapAurora: param "' + p.key + '" is not a finite number, got ' + v )
      }
      writeUniformValue( p, this._shared[ 'u_' + p.key ], v )
    }

    // Sizes follow the panel every frame. Each setter early-returns when nothing moved, so this is three comparisons on a still frame and a reallocation on the frame a slider crosses a step.
    this._taps = Math.round( values.smTaps )
    this._azimuth = Math.round( values.smAzRes )
    this._rows = Math.round( values.smRows )
    this._laneRows = laneRowsFor( values )
    setSkyKernelSize( this._taps )
    setSkyLaneSize( this._laneRows, this._azimuth )
    setSkyMapSize( this._rows, this._azimuth )

    const renderer = this._renderer

    // Restore whatever was bound rather than assuming null: on this page it is null, inside a post chain or an XR frame it is not, and hardcoding null there redirects the rest of the frame to the canvas with no error.
    const prevTarget = renderer.getRenderTarget()

    for ( const pass of this._passes ) {
      this._mesh( pass )
      renderer.setRenderTarget( pass.target() )
      // autoClear is left ON and the clear is not waste: on a tile-based GPU a pass that does not begin with a clear must LOAD the old contents into tile memory first, and that load is bandwidth this file exists to avoid. The clear COLOUR is not saved and restored because every texel is overwritten by the quad and nothing here can read it.
      renderer.render( this._scene, this._camera )
    }

    this._scene.clear()
    renderer.setRenderTarget( prevTarget )
  }

  // One mesh in the scene at a time. Swapping the child rather than toggling four `visible` flags means a pass that is somehow not in PASSES cannot draw by accident.
  _mesh( pass ) {
    this._scene.clear()
    this._scene.add( pass.mesh )
  }

  // -------------------------------------------------------------------------

  // The targets are deliberately NOT disposed here. They are module singletons that any AuroraScreen material built on a skymap-reading algorithm is still holding; freeing them from an instance teardown is the freed-GL-object failure skymap/target.js describes. Call disposeSkyMap() at page teardown, once, after the screen is gone.
  dispose() {
    this._scene.clear()
    for ( const pass of this._passes ) pass.material.dispose()
    this._geometry.dispose()
  }
}
