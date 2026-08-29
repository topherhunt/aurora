// ---------------------------------------------------------------------------
// The screen: one quad, one generated shader, and the plumbing between the
// panel and the GPU.
//
// ===========================================================================
// WHY THE SHADER IS ASSEMBLED RATHER THAN WRITTEN
// ===========================================================================
//
// The fragment source is concatenated at runtime from six or seven chunks, and
// the uniform block at the top of it is GENERATED from the param schema in
// algorithms.js. Neither is cleverness for its own sake; both close a specific
// hole.
//
// The uniform block closes the typo hole. Hand-written uniforms and hand-written
// sliders are two lists that must agree, and when they disagree the symptom is a
// slider that does nothing -- no error, no console line, just a control that
// silently writes to a name the shader never declared. Generating one from the
// other makes the two impossible to disagree: a param that exists has a uniform,
// and GLSL that references a uniform no param declares fails to compile with the
// missing identifier named. Loud beats silent (DESIGN.md §2).
//
// The chunk concatenation closes the combinatorial hole. Three algorithms times
// the shared frame is three shaders; hand-maintaining three copies of a
// hundred-line raymarch means fixing every bug three times and, in practice,
// fixing it twice and forgetting the third. Here the frame exists once and each
// algorithm is the forty lines that differ.
//
// Every chunk carries its own include guard, so the `needs` list on an algorithm
// can be over-broad without cost and the base set can be emitted unconditionally.
// It is emitted unconditionally on purpose: the frame itself uses hash, value
// noise and fBm regardless of the algorithm, so making those conditional would
// only create a way to get it wrong.
//
// ===========================================================================
// THE SCREEN IS A WORLD-LOCKED DOME, NOT A BILLBOARD
// ===========================================================================
//
// The brief asked for the aurora on "a giant sky-wide rectangular screen", and
// this was one for a while: a camera-facing quad, sized from the FOV, rebuilt
// every frame. It works, and it is the wrong shape for the thing being drawn.
//
// What makes any shape legal is what the shader does with the geometry.
// `main()` uses the fragment's world position for exactly one thing -- to
// subtract the eye from it and recover a ray direction -- and then throws it
// away. The mesh is a WINDOW, not a surface, so any surface that covers the same
// set of directions produces byte-identical pixels. That is what let the screen
// go from a billboard to a northern sector to a dome without a single pixel of
// the shader changing: only the SET OF DIRECTIONS covered moves.
//
// The dome covers all of them, and where the aurora is bright inside that set is
// the belt's decision rather than the mesh's -- u_beltOffset is negative because
// -z is north, and u_beltAmt says how far the sky falls away from the oval. The
// mesh no longer encodes an opinion about where the aurora lives, which is the
// point: an edge in the geometry is a heading at which the sky stops, and there
// is no such heading outdoors.
//
// The cost of that is real and worth stating plainly. A sector could leave the
// frustum, so facing south used to cost nothing at all; a dome is always in view
// and every fragment it covers is paid for at every heading. Under the skymap
// frame that is a fetch and does not matter. Under the per-pixel algorithms it
// is a full march, and the belt cannot win the cost back -- see the note in
// glsl/frame.js explaining why there is no belt cull.
//
// It sits at 5200 units: beyond the mountains at 1500 so they occlude it
// through the depth test, and well inside the stars at 15000 so it does not
// fight them for depth. Being world-locked, it is built once -- there is no FOV
// to track, because it is not sized to the view any more.
//
// ===========================================================================
// ADDITIVE, AND WHY NO SORTING IS NEEDED
// ===========================================================================
//
// Same reasoning as the archived band mesh: an aurora is optically thin, so what reaches
// the eye is the sum of the emission along the ray with nothing occluding
// anything else. Addition commutes, so draw order within the sky does not
// matter, and depth writing would be actively wrong -- it would let one part of
// a transparent sky hide another. depthTest stays ON so the mountains can cut
// the aurora off at the skyline, which is the one occlusion that is real.
// ---------------------------------------------------------------------------

import THREE from '../three-instance.js'

import { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL, FILAMENT_GLSL } from './glsl/noise.js'
import { PALETTE_GLSL } from './glsl/palette.js'
import { VERTEX_GLSL, MARCH_GLSL, MAIN_GLSL } from './glsl/frame.js'
import { LUT_GLSL } from './glsl/lut.js'
import { SLAB_MARCH_GLSL } from './glsl/slab.js'
import { noiseLutTexture } from './lut-texture.js'
import { PLANMAP_GLSL } from './planmap/glsl.js'
import { planMapTexture } from './planmap/target.js'
import { SKYMAP_GLSL, SKYMAP_FRAME_GLSL } from './skymap/glsl.js'
import { skyMapTexture, skyLanesTexture, skyHueTexture, skyKernelTexture } from './skymap/target.js'
import { algorithmById, paramsFor, defaultsFor } from './algorithms.js'

// Beyond the mountains (1500), well inside the stars (15000).
const DIST = 5200

// ---- The dome, which used to be a 200-degree northern sector.
//
// The sector was the right call while the aurora cost a forty-step raymarch per
// fragment: it deleted two thirds of the fragments at the rasteriser, and facing
// south cost literally nothing because the whole mesh left the frustum. What it
// also did was put a hard boundary in the sky, and `u_edgeFade` could only blur
// that boundary, never remove it -- turn far enough east or west and the aurora
// ends at a heading rather than at a horizon.
//
// The full dome gives that boundary up, and the reason it is now affordable is
// the skymap frame: its map is built over the whole compass (smAz in
// skymap/glsl.js wraps atan over 0..1, not over a sector) and a screen fragment
// costs one bilinear fetch, so covering four times the solid angle costs four
// times almost nothing. Under the per-pixel algorithms it is NOT free -- the
// march runs on every fragment the dome covers, at every heading, and there is
// no cull to win the cost back, because the belt term floors at 1 - u_beltAmt
// rather than at zero. See the long note in glsl/frame.js at the belt cull that
// is deliberately not there.
//
// The northward bias is the belt's job, not the mesh's: u_beltOffset is negative
// (-z is north) and u_beltAmt sets how dark the sky gets away from the oval --
// 0.85 leaves the southern sky at fifteen percent, 1.0 extinguishes it.
const AZIMUTH_DEG = 360

// Elevation runs from a little under the horizon -- the march's own horizon cut
// wants to be the thing that ends the sky, not the geometry -- to the zenith.
// The last twelve degrees used to be cut off as the most expensive
// per-solid-angle part of a sphere's tessellation with no aurora in them; that
// was true of the geometry and false of the picture, because cutting them left a
// disc of missing sky overhead. The zenith dissolve (u_zenFade) is what handles
// them now, and it fades brightness rather than removing the surface.
const ELEV_LOW_DEG = -6
const ELEV_HIGH_DEG = 90

// The mesh is a SCREEN, not the aurora: the shader recovers a ray direction per
// fragment and never consults the geometry's shape, so tessellation buys exactly
// one thing -- how closely linear interpolation across a face tracks the arc it
// is standing in for.
//
// That error is computable rather than a matter of taste. Interpolating across a
// chord of angle T gives a worst-case direction error of atan(s*tan(T/2)) - s*T/2
// maximised over s, which is zero at both ends and at the midpoint and peaks near
// s = 0.577. Against a Quest 2 panel at 1832 px over 90 degrees:
//
//   deg/face   max err   px
//    3.1       0.0001    0.00
//   12.5       0.0096    0.19
//   20.0       0.0393    0.80
//   25.0       0.0771    1.57
//   33.3       0.1841    3.75
//   50.0       0.6350   12.93
//
// Twenty degrees per face is where the error goes under one headset pixel, so the
// dome is tessellated to roughly that in both axes: 360/18 is exactly 20, and the
// 96 degrees of elevation over 5 rows is 19.2. The pole row degenerates to one
// triangle per segment rather than two, so the whole sky is 18*5*2 - 18 = 162
// triangles. That is a fifth of a percent of the 200k the landscape spends, and
// it will not move the frame rate in either direction -- this shader is
// fragment-bound to about three decimal places -- but the triangle budget is
// shared and there is no reason to spend more of it than the panel can resolve.
//
// Do not push this much lower. Under about 12 degrees per face nothing improves;
// over about 30 the sky visibly warps, because the error is quartic in the face
// angle and 33 degrees is already 3.75 px.
const SEG_AZ = 18
const SEG_EL = 5

// three's SphereGeometry puts phi = 0 at -x (west) and winds toward +z (south),
// so north (-z) is at -PI/2. Everything else here is measured off that.
const NORTH_PHI = -Math.PI / 2

const CHUNKS = {
  util: UTIL_GLSL,
  hash: HASH_GLSL,
  value: VALUE_GLSL,
  grad: GRAD_GLSL,
  fbm: FBM_GLSL,
  warp: WARP_GLSL,
  filament: FILAMENT_GLSL,
  lut: LUT_GLSL,
  planmap: PLANMAP_GLSL,
  skymap: SKYMAP_GLSL,
}

// The uniforms in this subsystem that are NOT generated from the param schema, because the schema has four types and none of them is a sampler -- and giving it one would mean a panel row for a texture, which is a control with nothing to control.
//
// A chunk that needs samplers names them here instead, and they are declared and bound only when that chunk is actually in the assembly, so the algorithms that do not use them are untouched. The value is a LIST because one chunk can need several: the sky map's reader needs the output map, while its generator and convolution halves -- which are compiled into the same program as dead code -- need the three intermediate maps. The textures are module singletons in lut-texture.js and the subsystems' own target.js: _buildMaterial runs again on every algorithm switch and must not re-bake a 128 KB table each time.
const CHUNK_SAMPLERS = {
  lut: [ { uniform: 'u_noiseLut', texture: noiseLutTexture } ],
  planmap: [ { uniform: 'u_planMap', texture: planMapTexture } ],
  skymap: [
    { uniform: 'u_skyMap', texture: skyMapTexture },
    { uniform: 'u_skyLanes', texture: skyLanesTexture },
    { uniform: 'u_skyHue', texture: skyHueTexture },
    { uniform: 'u_skyKernel', texture: skyKernelTexture },
  ],
}

// An algorithm's optional `frame` marker picks an alternative integrator in place of the shared march. EXCLUSIVE by construction: every entry here defines auroraRadiance, so emitting two is a redefinition error -- and the include guards deliberately do NOT protect against that, because a guard that silently dropped the second definition would make which frame you got depend on concatenation order.
const FRAMES = {
  slab: SLAB_MARCH_GLSL,
  skymap: SKYMAP_FRAME_GLSL,
}

// Emitted for every algorithm whether it asks or not, because the FRAME uses
// them regardless of which field is plugged in: hash for the dither, value noise
// for the striations, flow and shimmer, fBm for the global weather field.
//
// `grad` is in this list for a different and less obvious reason, and it cost a
// compile to find: FBM_GLSL defines `gfbm2`, which calls `gnoise2`, which lives
// in GRAD_GLSL. So grad is a dependency of fbm, and fbm is unconditional, so
// grad is too -- even for filaments, which use neither directly. An algorithm's
// `needs` list therefore describes what IT calls, not what has to be present,
// and the two are not the same thing.
const BASE_CHUNKS = [ 'util', 'hash', 'value', 'grad', 'fbm' ]

// The one mapping from a schema type to a GLSL type. Exported because the prepass classes compile the SAME chunks this file compiles and so must declare the same uniforms with the same types -- a second copy of this table would be four lines that agree today and a link error the day somebody adds a type.
export const GLSL_TYPE = {
  float: 'float',
  color: 'vec3',
  bool: 'float',
  enum: 'int',
}

// ---------------------------------------------------------------------------

// `uDitherScale` sits outside the u_ namespace alongside uTime for the same reason uTime does: it is not a knob. There is no slider for it and no preset records it, because it is not an opinion about the sky -- it is the low-res divisor, which the panel already owns, arriving in the one place that needs to know the size of a texel. See the dither in glsl/frame.js for what it does with it.
function declarationsFor( params, chunks ) {
  const lines = [ 'uniform float uTime;', 'uniform float uDitherScale;' ]
  for ( const name of chunks ) {
    if ( !CHUNK_SAMPLERS[ name ] ) continue
    for ( const s of CHUNK_SAMPLERS[ name ] ) lines.push( 'uniform sampler2D ' + s.uniform + ';' )
  }
  for ( const p of params ) {
    if ( p.uniform === false ) continue
    const t = GLSL_TYPE[ p.type ]
    if ( !t ) throw new Error( 'aurora-lab: param "' + p.key + '" has unmappable type "' + p.type + '"' )
    lines.push( 'uniform ' + t + ' u_' + p.key + ';' )
  }
  return lines.join( '\n' )
}

// A param's value as three.js wants it in a uniform slot. Colours arrive from
// the panel as a linear triple, not as a hex string, because everything the
// palette does with a colour is arithmetic and a THREE.Color would invite a
// second gamma conversion nobody asked for.
//
// Exported alongside writeUniformValue for the prepass classes, whose uniform blocks are generated from the same schema and whose values come out of the same panel state. PlanMapAurora predates this and refuses any non-float param outright, with a comment saying the fix is to share the marshalling rather than to copy it; SkyMapAurora needs u_tint, which is a colour, so this is that fix. The refusal in PlanMapAurora is left alone -- it is still true that the planmap generator reads only scalars, and a throw that has never fired is not worth relaxing on speculation.
export function toUniformValue( param, value ) {
  if ( param.type === 'color' ) return new THREE.Vector3( value[ 0 ], value[ 1 ], value[ 2 ] )
  if ( param.type === 'bool' ) return value ? 1 : 0
  if ( param.type === 'enum' ) return value | 0
  return value
}

export function writeUniformValue( param, slot, value ) {
  if ( param.type === 'color' ) {
    slot.value.set( value[ 0 ], value[ 1 ], value[ 2 ] )
    return
  }
  slot.value = toUniformValue( param, value )
}

// ---------------------------------------------------------------------------

export class AuroraScreen {
  constructor( scene, opts = {} ) {
    this.scene = scene
    this.algorithmId = opts.algorithm || 'leyline'

    // The panel's whole state for the current algorithm, in schema units. This
    // is the authority -- the uniforms are a projection of it, not the other way
    // round -- which is what makes switching algorithms and restoring a preset
    // the same operation.
    this.values = defaultsFor( this.algorithmId )
    // Read by _buildMaterial, which runs again on every algorithm switch, so it
    // has to live on the instance rather than in the uniform it initialises --
    // otherwise changing algorithm silently resets the dither to full-res.
    this._ditherScale = 1
    if ( opts.values ) this.setValues( opts.values )

    // theta is measured DOWN from the zenith, so the high elevation is the low
    // theta and the band is entered from the top.
    const az = THREE.MathUtils.degToRad( AZIMUTH_DEG )
    const thetaStart = THREE.MathUtils.degToRad( 90 - ELEV_HIGH_DEG )
    const thetaEnd = THREE.MathUtils.degToRad( 90 - ELEV_LOW_DEG )
    this.geometry = new THREE.SphereGeometry(
      DIST, SEG_AZ, SEG_EL,
      NORTH_PHI - az * 0.5, az,
      thetaStart, thetaEnd - thetaStart
    )
    this.material = null
    this.mesh = new THREE.Mesh( this.geometry, new THREE.MeshBasicMaterial() )
    // Left on, though a dome centred on the eye can never actually be culled --
    // the test costs one bounding-sphere check per frame and turning it off
    // would only be a claim about the geometry that stops being true the moment
    // somebody narrows AZIMUTH_DEG again.
    this.mesh.frustumCulled = true
    this.mesh.renderOrder = -800
    this.scene.add( this.mesh )

    this._buildMaterial()
  }

  // -------------------------------------------------------------------------

  _params() {
    return paramsFor( this.algorithmId )
  }

  _param( key ) {
    const p = this._params().find( x => x.key === key )
    if ( !p ) throw new Error( 'AuroraScreen: no param "' + key + '" for algorithm "' + this.algorithmId + '"' )
    return p
  }

  _buildMaterial() {
    const algo = algorithmById( this.algorithmId )
    const params = this._params()

    const wanted = []
    for ( const name of [ ...BASE_CHUNKS, ...( algo.needs || [] ) ] ) {
      if ( !CHUNKS[ name ] ) throw new Error( 'AuroraScreen: algorithm "' + algo.id + '" needs unknown chunk "' + name + '"' )
      if ( !wanted.includes( name ) ) wanted.push( name )
    }
    // Declaration order matters -- grad and warp call into each other's helpers,
    // and GLSL has no forward declarations here -- so emit in library order
    // rather than in the order the algorithm happened to list them.
    const ordered = Object.keys( CHUNKS ).filter( n => wanted.includes( n ) )

    const march = algo.frame ? FRAMES[ algo.frame ] : MARCH_GLSL
    if ( !march ) throw new Error( 'AuroraScreen: algorithm "' + algo.id + '" names unknown frame "' + algo.frame + '"' )

    const fragment = [
      declarationsFor( params, ordered ),
      'varying vec3 vWorld;',
      'varying vec2 vUv;',
      ...ordered.map( n => CHUNKS[ n ] ),
      PALETTE_GLSL,
      algo.glsl,
      march,
      MAIN_GLSL,
    ].join( '\n' )

    const uniforms = { uTime: { value: 0 }, uDitherScale: { value: this._ditherScale } }
    for ( const name of ordered ) {
      if ( !CHUNK_SAMPLERS[ name ] ) continue
      for ( const s of CHUNK_SAMPLERS[ name ] ) uniforms[ s.uniform ] = { value: s.texture() }
    }
    for ( const p of params ) {
      if ( p.uniform === false ) continue
      uniforms[ 'u_' + p.key ] = { value: toUniformValue( p, this.values[ p.key ] ) }
    }

    const material = new THREE.ShaderMaterial( {
      uniforms,
      vertexShader: VERTEX_GLSL,
      fragmentShader: fragment,
      // Optically thin: the sum along the ray is the answer, addition commutes,
      // so nothing needs sorting and nothing may write depth. Depth TEST stays
      // on so the mountains cut the aurora at the skyline.
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      fog: false,
    } )

    const old = this.mesh.material
    this.mesh.material = material
    this.material = material
    this._fragment = fragment
    if ( old ) old.dispose()
  }

  // -------------------------------------------------------------------------

  setAlgorithm( id ) {
    if ( id === this.algorithmId ) return

    // Carry across every knob the new algorithm also has, and take its own
    // defaults for the rest. Anything else makes the panel lie: switch away and
    // back and you would silently get a different sky than you left, which
    // destroys the one thing the lab is for -- comparing two algorithms under
    // the same settings.
    const carried = this.values
    this.algorithmId = id
    const next = defaultsFor( id )
    for ( const k of Object.keys( next ) ) {
      if ( k in carried ) next[ k ] = carried[ k ]
    }
    // ...except the algorithm's own overrides, which are its opinion about how
    // the shared knobs should start and would be wiped by the carry above.
    const over = algorithmById( id ).overrides || {}
    for ( const k of Object.keys( over ) ) {
      if ( !( k in carried ) ) next[ k ] = over[ k ]
    }
    this.values = next
    this._buildMaterial()
  }

  setParam( key, value ) {
    const p = this._param( key )
    this.values[ key ] = value
    if ( p.uniform === false ) return
    writeUniformValue( p, this.material.uniforms[ 'u_' + key ], value )
  }

  getParam( key ) {
    this._param( key )
    return this.values[ key ]
  }

  // The low-res divisor, handed to the march because its dither is measured in
  // TEXELS OF THE BUFFER IT IS DRAWING INTO and has to stay measured in pixels of
  // the finished frame. Passed raw rather than clamped: the shader needs the true
  // divisor, because at 3.5 and above it switches the dither from a lattice to a
  // per-texel hash rather than scaling the lattice further. See the dither in
  // glsl/frame.js for why that crossover is the same intent and not a downgrade.
  setDitherScale( div ) {
    this._ditherScale = Math.max( div, 1 )
    this.material.uniforms.uDitherScale.value = this._ditherScale
  }

  setValues( values ) {
    for ( const k of Object.keys( values ) ) {
      // Presets and pasted JSON outlive the schema they were written against.
      // A key that no longer exists is skipped rather than thrown on -- the
      // alternative is that renaming one knob bricks every preset on disk --
      // but it is skipped loudly, because a preset that silently half-applies
      // is a tuning you cannot reproduce.
      if ( !( k in this.values ) && !this._params().some( p => p.key === k ) ) {
        console.warn( 'aurora-lab: ignoring unknown param "' + k + '" (schema changed?)' )
        continue
      }
      if ( this.material ) this.setParam( k, values[ k ] )
      else this.values[ k ] = values[ k ]
    }
  }

  snapshot() {
    return { algorithm: this.algorithmId, values: { ...this.values } }
  }

  fragmentSource() {
    return this._fragment
  }

  // -------------------------------------------------------------------------

  // Called every frame, and it now does one thing: keep the dome centred on the
  // eye. It is NOT rotated with the camera -- that is the whole point, the dome
  // is a piece of the world's sky and turning your head has to move you across
  // it. Recentring it on the eye is not parallax either: the shader marches from
  // a fixed origin regardless, so this only keeps the mesh from sliding out from
  // under a walking player.
  //
  // Takes either a camera or a bare position. The lab has a camera in hand and
  // /v2 has the player's head as a Vector3, and accepting both is two lines
  // where converting at every call site is a Vector3 allocated per frame. The
  // else-branch THROWS rather than silently copying undefined -- Vector3.copy on
  // an object with no .x writes NaN, the dome vanishes, and nothing says why.
  update( eye, elapsed ) {
    this.material.uniforms.uTime.value = elapsed
    if ( eye.isVector3 ) this.mesh.position.copy( eye )
    else if ( eye.position ) this.mesh.position.copy( eye.position )
    else throw new Error( 'AuroraScreen.update: needs a Vector3 or an Object3D, got ' + eye )
  }

  dispose() {
    this.scene.remove( this.mesh )
    this.geometry.dispose()
    this.material.dispose()
  }
}
