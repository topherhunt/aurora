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
// THE SCREEN IS A NORTHERN SECTOR, NOT A BILLBOARD
// ===========================================================================
//
// The brief asked for the aurora on "a giant sky-wide rectangular screen", and
// this was one for a while: a camera-facing quad, sized from the FOV, rebuilt
// every frame. It works, and it is the wrong shape for the thing being drawn.
//
// What makes either shape legal is what the shader does with the geometry.
// `main()` uses the fragment's world position for exactly one thing -- to
// subtract the eye from it and recover a ray direction -- and then throws it
// away. The mesh is a WINDOW, not a surface, so any surface that covers the same
// set of directions produces byte-identical pixels. A billboard covers the
// directions you are looking at. A sector covers the directions the aurora is
// in. Those are different sets, and the second one is much smaller.
//
// The aurora lives in a belt to the north (u_beltOffset is negative by default,
// -z is north), so a quad that follows the camera spends most of its fragments
// marching rays that the belt term is going to multiply to nothing -- and pays
// full price for them, because a fragment that integrates to black costs exactly
// what a bright one does. Locking the mesh to the world and cutting it down to
// the northern sector deletes those fragments at the rasteriser instead, which
// is free. Turn south now and there is nothing drawn at all, which is also what
// standing under a real auroral oval looks like.
//
// The second win is the one the pixels came from: the fragments that remain are
// the ones worth spending on, so the same frame budget buys a higher render
// scale over the part of the sky that has an aurora in it.
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
// Same reasoning as src/aurora.js: an aurora is optically thin, so what reaches
// the eye is the sum of the emission along the ray with nothing occluding
// anything else. Addition commutes, so draw order within the sky does not
// matter, and depth writing would be actively wrong -- it would let one part of
// a transparent sky hide another. depthTest stays ON so the mountains can cut
// the aurora off at the skyline, which is the one occlusion that is real.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

import { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL, FILAMENT_GLSL } from './glsl/noise.js'
import { PALETTE_GLSL } from './glsl/palette.js'
import { VERTEX_GLSL, MARCH_GLSL, MAIN_GLSL } from './glsl/frame.js'
import { LUT_GLSL } from './glsl/lut.js'
import { noiseLutTexture } from './lut-texture.js'
import { algorithmById, paramsFor, defaultsFor } from './algorithms.js'

// Beyond the mountains (1500), well inside the stars (15000).
const DIST = 5200

// ---- The sector, in the sky the mesh is cut out of.
//
// Azimuth is a touch over half the compass rather than exactly half. A hard 180
// would put the sector's two vertical edges due east and due west, which are
// headings you look along, and `u_edgeFade` needs a few degrees of sky on the
// far side of the belt to fade across or the boundary reads as a wall. 200
// degrees puts each edge ten degrees behind you at those headings.
const AZIMUTH_DEG = 200

// Elevation runs from a little under the horizon -- the march's own horizon cut
// wants to be the thing that ends the sky, not the geometry -- up to 78, which
// is above anything the deposition profile still has brightness in at any
// sensible u_persp. The last twelve degrees to the zenith are the most expensive
// per-solid-angle part of a sphere's tessellation and there has never been an
// aurora in them.
const ELEV_LOW_DEG = -6
const ELEV_HIGH_DEG = 78

// Enough that the linear interpolation of world position across a face is a
// good sphere: 200 degrees over 64 segments is about three degrees a face. The
// vertex cost of 4k triangles is nothing next to one fragment of this shader.
const SEG_AZ = 64
const SEG_EL = 32

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
}

// The one uniform in this subsystem that is NOT generated from the param schema, because the schema has four types and none of them is a sampler -- and giving it one would mean a panel row for a texture, which is a control with nothing to control.
//
// A chunk that needs a sampler names it here instead, and it is declared and bound only when that chunk is actually in the assembly, so the algorithms that do not use it are untouched. The texture is a module singleton in lut-texture.js: _buildMaterial runs again on every algorithm switch and must not re-bake a 128 KB table each time.
const CHUNK_SAMPLERS = {
  lut: { uniform: 'u_noiseLut', texture: noiseLutTexture },
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

const GLSL_TYPE = {
  float: 'float',
  color: 'vec3',
  bool: 'float',
  enum: 'int',
}

// ---------------------------------------------------------------------------

function declarationsFor( params, chunks ) {
  const lines = [ 'uniform float uTime;' ]
  for ( const name of chunks ) {
    const s = CHUNK_SAMPLERS[ name ]
    if ( s ) lines.push( 'uniform sampler2D ' + s.uniform + ';' )
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
function toUniformValue( param, value ) {
  if ( param.type === 'color' ) return new THREE.Vector3( value[ 0 ], value[ 1 ], value[ 2 ] )
  if ( param.type === 'bool' ) return value ? 1 : 0
  if ( param.type === 'enum' ) return value | 0
  return value
}

function writeUniformValue( param, slot, value ) {
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
    // Culling is worth having now that the mesh is a fixed piece of the world
    // rather than a quad pinned to the near plane: face south and the sector is
    // outside the frustum, three drops the draw, and the aurora costs nothing at
    // all. The billboard could never be culled because it was always in view.
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

    const fragment = [
      declarationsFor( params, ordered ),
      'varying vec3 vWorld;',
      'varying vec2 vUv;',
      ...ordered.map( n => CHUNKS[ n ] ),
      PALETTE_GLSL,
      algo.glsl,
      MARCH_GLSL,
      MAIN_GLSL,
    ].join( '\n' )

    const uniforms = { uTime: { value: 0 } }
    for ( const name of ordered ) {
      const s = CHUNK_SAMPLERS[ name ]
      if ( s ) uniforms[ s.uniform ] = { value: s.texture() }
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

  // Called every frame, and it now does one thing: keep the sector centred on
  // the eye. It is NOT rotated with the camera -- that is the whole point, the
  // sector is a piece of the world's northern sky and turning your head has to
  // move you across it. Recentring it on the camera is not parallax either: the
  // shader marches from a fixed origin regardless, so this only keeps the mesh
  // from sliding out from under a walking player.
  update( camera, elapsed ) {
    this.material.uniforms.uTime.value = elapsed
    this.mesh.position.copy( camera.position )
  }

  dispose() {
    this.scene.remove( this.mesh )
    this.geometry.dispose()
    this.material.dispose()
  }
}
