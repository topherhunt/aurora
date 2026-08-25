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
// WHY THE QUAD FACES THE CAMERA
// ===========================================================================
//
// The brief asked for the aurora on "a giant sky-wide rectangular screen", and
// a literal fixed rectangle is a trap: turn ninety degrees and you are looking
// past its edge at empty sky, and the lab becomes a rig you can only use from
// one heading.
//
// A billboard fixes that without giving anything up, because of what the shader
// actually does with the quad. `main()` uses the fragment's world position for
// exactly one thing -- to recover a ray direction -- and then throws it away.
// The quad is a window, not a surface. Rotating the window does not move
// anything behind it, so a camera-facing quad and a sky-sized dome produce
// identical pixels, and the quad is two triangles.
//
// It sits at 5200 units: beyond the mountains at 1500 so they occlude it
// through the depth test, and well inside the stars at 15000 so it does not
// fight them for depth. It is sized from the camera's own FOV each time either
// changes, with margin, because a quad sized once for a 60-degree view develops
// visible corners the moment the FOV widens.
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
import { algorithmById, paramsFor, defaultsFor } from './algorithms.js'

// Beyond the mountains (1500), well inside the stars (15000).
const DIST = 5200

// How much wider than the frustum the quad is cut. Covers a FOV drag and the
// couple of degrees of slop a billboard has when the camera rolls.
const MARGIN = 1.7

const CHUNKS = {
  util: UTIL_GLSL,
  hash: HASH_GLSL,
  value: VALUE_GLSL,
  grad: GRAD_GLSL,
  fbm: FBM_GLSL,
  warp: WARP_GLSL,
  filament: FILAMENT_GLSL,
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

function declarationsFor( params ) {
  const lines = [ 'uniform float uTime;' ]
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

    this.geometry = new THREE.PlaneGeometry( 1, 1 )
    this.material = null
    this.mesh = new THREE.Mesh( this.geometry, new THREE.MeshBasicMaterial() )
    this.mesh.frustumCulled = false
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
      declarationsFor( params ),
      'varying vec3 vWorld;',
      'varying vec2 vUv;',
      ...ordered.map( n => CHUNKS[ n ] ),
      PALETTE_GLSL,
      algo.glsl,
      MARCH_GLSL,
      MAIN_GLSL,
    ].join( '\n' )

    const uniforms = { uTime: { value: 0 } }
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

  // Called every frame. The quad is a window onto the raymarch, so keeping it
  // square to the camera costs two copies and removes the whole class of "the
  // aurora ends over there" bugs a fixed rectangle has.
  update( camera, elapsed ) {
    this.material.uniforms.uTime.value = elapsed

    const halfH = Math.tan( THREE.MathUtils.degToRad( camera.fov ) * 0.5 ) * DIST * MARGIN
    const halfW = halfH * camera.aspect
    this.mesh.scale.set( halfW * 2, halfH * 2, 1 )

    this.mesh.quaternion.copy( camera.quaternion )
    camera.getWorldDirection( _fwd )
    this.mesh.position.copy( camera.position ).addScaledVector( _fwd, DIST )
  }

  dispose() {
    this.scene.remove( this.mesh )
    this.geometry.dispose()
    this.material.dispose()
  }
}

const _fwd = new THREE.Vector3()
