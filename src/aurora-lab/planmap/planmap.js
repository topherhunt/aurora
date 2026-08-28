// ---------------------------------------------------------------------------
// The pass that fills the plan map. One full-target quad, once per frame, before anything else is drawn.
//
// Read planmap/glsl.js for what the map IS and why it is shaped the way it is. This file is only the plumbing: a class in the shape of LowResAurora, so the page drives it the same way it drives that one.
//
// ===========================================================================
// WHAT THIS PASS COSTS AND WHY IT IS NOT A BAKE
// ===========================================================================
//
// This runs EVERY FRAME, on the CURRENT time, from the SAME field the analytic path evaluates. Nothing is retained between frames; nothing is authored; the map is a scratch buffer whose contents are stale after 16 ms and are thrown away. Skipping the pass on frames where nothing moved would be a bake, and it is not done, because `morph rate` means something is always moving.
//
// At the default 384x1024 the pass is 393,216 invocations of the same field the march would otherwise evaluate about 83 million times at 1080p and 40 steps. The pass is therefore roughly half a percent of what it replaces, and that ratio is the whole argument. It is a fact about the algorithm and not a measurement: see the report for what has and has not been measured.
//
// ===========================================================================
// THE UNIFORM BLOCK IS GENERATED, FOR THE SAME REASON SCREEN.JS GENERATES ITS OWN
// ===========================================================================
//
// The generator compiles the SAME chunk the screen compiles, so it needs the same uniforms declared with the same names and types. Hand-writing that block would mean a second list of fifteen names that has to be kept in step with the schema by hand, and the failure mode of getting it wrong is a link error in a shader nobody looks at until the sky goes black.
//
// So the block is built from PLANMAP.groups here exactly as declarationsFor builds it in screen.js -- one authority, the schema -- plus an explicit short list of the SHARED params the chunk also reads (u_fieldScale, u_altHigh, u_persp, u_horizonCut, u_fieldSeed, u_warpStages). That list is written out rather than generated from SHARED_GROUPS because declaring all fifty shared uniforms in a shader that reads six of them is how you end up unable to tell which ones matter. It is short, it is asserted against the schema on construction, and if the chunk ever reads a seventh the compile fails loudly on the next reload.
//
// u_planMap is declared and bound to NULL. The chunk defines pmSample, which fetches it, and the generator compiles pmSample even though it never calls it (see the note above PLANMAP_GLSL for why the two halves share one chunk). Declaring it costs a sampler slot; BINDING IT WOULD BE BINDING THE RENDER TARGET TO ITSELF, which is undefined behaviour in GL whether or not the fetch is reached. three binds its 1x1 empty texture for a null slot, so the loop cannot be formed.
//
// ===========================================================================
// TIME IS ITS OWN UNIFORM AND NOT uTime
// ===========================================================================
//
// screen.js declares `uniform float uTime` by hand at the top of every fragment it assembles, and the march passes it straight down as auroraField's `t`. This material is not built by screen.js, so it declares u_pmTime instead, and the page must hand it the SAME number it hands screen.update -- the accumulated shader time, after the timeScale multiply. A mismatch does not error; it renders the map from a different instant than the frame that reads it, which looks like the aurora lagging its own controls.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

import { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL } from '../glsl/noise.js'
import { ALGORITHMS } from '../algorithms.js'
import { PLANMAP } from './algorithm.js'
import { PLANMAP_GLSL } from './glsl.js'
import { DEFAULT_AZIMUTH, DEFAULT_RADIAL, planMapTarget, setPlanMapSize } from './target.js'

// The shared params the chunk reads. Every one of these is a `float` in the schema and is asserted to exist on construction, so a rename in algorithms.js surfaces here as a thrown message rather than as a shader that will not link.
const SHARED_UNIFORMS = [ 'fieldScale', 'altHigh', 'persp', 'horizonCut', 'fieldSeed', 'warpStages' ]

// Every algorithm whose shader compiles the planmap chunk, and therefore every algorithm that can fetch the map and needs it to be current. Derived from the registry rather than listed, so adding an entry that pairs this field with a different frame needs no edit here -- and, more to the point, FORGETTING to edit here is not a failure mode, because there is nothing to forget. Computed once at module load; the registry is a static list.
const MAP_READERS = new Set( ALGORITHMS.filter( a => a.needs.indexOf( 'planmap' ) !== -1 ).map( a => a.id ) )
if ( !MAP_READERS.has( PLANMAP.id ) ) throw new Error( 'PlanMapAurora: the planmap algorithm does not declare "planmap" in its needs, so nothing would regenerate the map' )

// A quad in clip space, drawn with no matrices at all. The generator has no camera and no scene in any meaningful sense -- uv IS the map coordinate -- so putting a projection in the path would only be an opportunity for a half-texel offset between where a texel is written and where pmMapUv says it lives.
const VERTEX_GLSL = `
  varying vec2 vPlanUv;

  void main() {
    vPlanUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`

// No #include <colorspace_fragment>. This is not colour and must not be encoded; see the colorSpace note in planmap/target.js. Nothing appends it on our behalf either -- three only injects that into its own materials' shaders, not into a hand-written ShaderMaterial.
const FRAGMENT_MAIN_GLSL = `
  varying vec2 vPlanUv;

  void main() {
    gl_FragColor = pmFieldStore( pmPlan( vPlanUv ), u_pmTime );
  }
`

// ---------------------------------------------------------------------------

function planmapParams() {
  const out = []
  for ( const g of PLANMAP.groups ) {
    for ( const p of g.params ) out.push( p )
  }
  return out
}

// ---------------------------------------------------------------------------

export class PlanMapAurora {
  constructor( renderer ) {
    if ( !renderer || !renderer.isWebGLRenderer ) throw new Error( 'PlanMapAurora: needs a WebGLRenderer' )
    this._renderer = renderer

    const params = planmapParams()

    // Two copies of a number is the mistake this module is most exposed to: the schema's defaults size the panel's sliders and target.js's constants size the buffer that is allocated before the panel has said anything. If they ever disagree, the map is one resolution and the readout says another, which is not visible in the picture at all.
    const decl = key => {
      const p = params.find( x => x.key === key )
      if ( !p ) throw new Error( 'PlanMapAurora: the planmap schema has no "' + key + '" param' )
      return p
    }
    const radDefault = decl( 'pmRadRes' ).value
    const azDefault = decl( 'pmAzRes' ).value
    if ( radDefault !== DEFAULT_RADIAL ) throw new Error( 'PlanMapAurora: pmRadRes default ' + radDefault + ' disagrees with DEFAULT_RADIAL ' + DEFAULT_RADIAL )
    if ( azDefault !== DEFAULT_AZIMUTH ) throw new Error( 'PlanMapAurora: pmAzRes default ' + azDefault + ' disagrees with DEFAULT_AZIMUTH ' + DEFAULT_AZIMUTH )

    // The params that actually become uniforms, resolved once. render() runs per frame and has no business re-walking the schema.
    this._uniformParams = params.filter( p => p.uniform !== false )

    const lines = [ 'uniform float u_pmTime;', 'uniform sampler2D u_planMap;' ]
    for ( const key of SHARED_UNIFORMS ) lines.push( 'uniform float u_' + key + ';' )
    for ( const p of this._uniformParams ) {
      // Only `float` is handled, and that is a deliberate refusal rather than an oversight. screen.js maps four schema types onto three GLSL types and marshals each one into its uniform slot differently -- a colour becomes a Vector3, an enum an int -- and reimplementing that here would be a second copy of a conversion whose whole failure mode is being subtly out of step with the first. Every knob this map needs is a scalar. If one ever is not, this throws on the next reload and the answer is to move the marshalling into a shared helper, not to widen this line.
      if ( p.type !== 'float' ) throw new Error( 'PlanMapAurora: param "' + p.key + '" has type "' + p.type + '", and the generator only handles float' )
      lines.push( 'uniform float u_' + p.key + ';' )
    }

    const uniforms = {
      u_pmTime: { value: 0 },
      // See the header: declared so pmSample compiles, deliberately never bound, because the only texture it could be bound to is the one being written.
      u_planMap: { value: null },
    }
    for ( const key of SHARED_UNIFORMS ) uniforms[ 'u_' + key ] = { value: 0 }
    for ( const p of this._uniformParams ) uniforms[ 'u_' + p.key ] = { value: p.value }

    // Library order, matching screen.js's `ordered`: grad before fbm because gfbm2 calls gnoise2, fbm before warp, and everything before planmap. GLSL has no forward declarations here, so this list is load-bearing rather than tidy.
    const fragment = [
      lines.join( '\n' ),
      UTIL_GLSL,
      HASH_GLSL,
      VALUE_GLSL,
      GRAD_GLSL,
      FBM_GLSL,
      WARP_GLSL,
      PLANMAP_GLSL,
      FRAGMENT_MAIN_GLSL,
    ].join( '\n' )

    this._material = new THREE.ShaderMaterial( {
      uniforms,
      vertexShader: VERTEX_GLSL,
      fragmentShader: fragment,
      // Every texel is written by this one opaque quad. Blending would mix in whatever the previous frame left; depth would have to be allocated to be tested against.
      blending: THREE.NoBlending,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    } )

    this._mesh = new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), this._material )
    // The vertex shader ignores every matrix, so the mesh has no position in any space three understands and its bounding sphere is meaningless. Culling it would be culling against a lie.
    this._mesh.frustumCulled = false

    this._scene = new THREE.Scene()
    this._scene.add( this._mesh )

    // A bare Camera, not an OrthographicCamera. renderer.render insists on one and reads nothing off it here, and a perspective or ortho camera would suggest the vertex shader used its matrices.
    this._camera = new THREE.Camera()

    this._radial = DEFAULT_RADIAL
    this._azimuth = DEFAULT_AZIMUTH
  }

  // -------------------------------------------------------------------------

  // What screen.js's material is bound to through CHUNK_SAMPLERS. Stable across every resize -- see the header of planmap/target.js.
  get texture() {
    return planMapTarget().texture
  }

  get radialTexels() {
    return this._radial
  }

  get azimuthTexels() {
    return this._azimuth
  }

  // Texels, not pixels: unlike LowResAurora this has nothing to do with the size of the window. The map's resolution is a quality knob on a fixed-size table, and the page routes pmRadRes and pmAzRes here the same way it routes lowRes into LowResAurora.
  setSize( radialTexels, azimuthTexels ) {
    setPlanMapSize( radialTexels, azimuthTexels )
    this._radial = Math.round( radialTexels )
    this._azimuth = Math.round( azimuthTexels )
  }

  // -------------------------------------------------------------------------

  // Called once per frame, BEFORE the frame that reads the map. `values` is the panel's whole state, in schema units, exactly as AuroraScreen holds it.
  //
  // A no-op under every algorithm that does not read the map. The map is worth 393k field evaluations a frame and the leyline path does not read it, so paying for it while `ley lines` is selected would make every A/B on the panel a comparison against a handicapped reference.
  //
  // The test is on `needs` and not on the id, and that is the difference between a gate and a bug waiting to happen. There is more than one algorithm reading this map -- `plan map` marches it, `plan map (slab)` integrates it in six strata -- and the two are the same field, so any future pairing of this field with another frame is a two-line file that would silently read a map nobody had regenerated. `needs` is the same authority screen.js uses to decide whether the chunk is compiled into the shader at all, so an algorithm that can fetch the map is exactly an algorithm that regenerates it.
  render( algorithmId, values, time ) {
    if ( !MAP_READERS.has( algorithmId ) ) return

    if ( !Number.isFinite( time ) ) throw new Error( 'PlanMapAurora: render() needs a finite time, got ' + time )
    if ( !values ) throw new Error( 'PlanMapAurora: render() needs the panel values' )

    const uniforms = this._material.uniforms
    uniforms.u_pmTime.value = time

    // Read straight out of the panel state rather than from a cached copy. There is no setter per knob here and there should not be: the whole map is rebuilt from scratch every frame anyway, so a dirty flag would be bookkeeping that can go wrong in exchange for saving twenty assignments.
    for ( const key of SHARED_UNIFORMS ) {
      const v = values[ key ]
      if ( !Number.isFinite( v ) ) throw new Error( 'PlanMapAurora: shared param "' + key + '" is not a finite number, got ' + v )
      uniforms[ 'u_' + key ].value = v
    }
    for ( const p of this._uniformParams ) {
      const v = values[ p.key ]
      if ( !Number.isFinite( v ) ) throw new Error( 'PlanMapAurora: param "' + p.key + '" is not a finite number, got ' + v )
      uniforms[ 'u_' + p.key ].value = v
    }

    const renderer = this._renderer

    // Restore whatever was bound rather than assuming null, for the reason LowResAurora gives: on this page it is null, inside a post chain or an XR frame it is not, and hardcoding null there redirects the rest of the frame to the canvas with no error.
    const prevTarget = renderer.getRenderTarget()

    renderer.setRenderTarget( planMapTarget() )

    // autoClear is left ON, and the clear is not waste. The quad covers every texel with NoBlending, so the previous contents are irrelevant either way -- but on a tile-based GPU a render pass that does not begin with a clear must LOAD the old 3 MB into tile memory before it can start, and that load is exactly the bandwidth this whole file exists to avoid. Clearing tells the driver not to bother. The clear COLOUR is not saved and restored (unlike LowResAurora, whose target is additive and must start at transparent black) because nothing here can read it.
    renderer.render( this._scene, this._camera )

    renderer.setRenderTarget( prevTarget )
  }

  // -------------------------------------------------------------------------

  // The target is deliberately NOT disposed here. It is a module singleton that any AuroraScreen material built on the `planmap` algorithm is still holding; freeing it from an instance teardown is the freed-GL-object failure planmap/target.js describes. Call disposePlanMap() at page teardown, once, after the screen is gone.
  dispose() {
    this._scene.remove( this._mesh )
    this._mesh.geometry.dispose()
    this._material.dispose()
  }
}
