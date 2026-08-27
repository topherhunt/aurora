// ---------------------------------------------------------------------------
// AuroraCurtains -- the geometry aurora, as a drop-in sibling of AuroraScreen.
//
// Same surface: new AuroraCurtains(scene, { values }), setValues(v), setParam(k, v), getParam(k), snapshot(), fragmentSource(), update(camera, elapsed), dispose(). The lab page can hold one or the other in the same variable and treat them alike; the only thing this does not have is setAlgorithm, because it IS the algorithm.
//
// ===========================================================================
// WHAT THIS IS FOR, STATED PLAINLY
// ===========================================================================
//
// The raymarch is better. It integrates a real 3D field along the view ray, it gets branching and merging for free because the field has topology and geometry does not, and every fold is correctly self-occluding without anyone thinking about it. If it hits 72 Hz on the headset, ship it and delete this.
//
// This exists because it will hit 72 Hz. It replaces a per-pixel loop over forty steps with a fixed count of very cheap fragments, and the cost is bounded by something you can count on paper before you build it -- how many curtains overlap in the worst direction -- rather than by how many steps a march needed in the worst direction. That is the whole argument. It is not a claim that this is fast; it is a claim that its cost is knowable and capped, which the march's is not.
//
// ===========================================================================
// WHY THE OLD POLYGON AURORA LOOKS THE WAY IT DOES, AND WHAT IS DIFFERENT HERE
// ===========================================================================
//
// src/aurora.js has all the right individual ideas and still reads as wiggling polygons. Five reasons, and each one has an answer in this module:
//
// 1. Eleven curtains is a countable number. The eye counts them, and once it has counted them they are objects. Here there are eighteen, independently dimmed, so the count is never stable long enough to be taken. At the shipped gate amount none of them goes fully out: measured minimum brightness in the middle 40% of azimuth is 0.126, not 0. A curtain that DID reach zero would be collapsed to zero-area triangles rather than drawn and multiplied by nothing, and at cuGateAmt 1 that is worth a measured 29% of the overdraw -- so the collapse is a real mechanism sitting idle at the shipped tuning, which is a choice about how the sky should look and is spelled out at the collapse in glsl.js.
//
// 2. Every band was drawn to its full extent, so every band had two ends and a top, and an end is a silhouette. Here the ends, the hem and the crown all fade to exactly zero before the mesh runs out: no boundary of the geometry is ever a boundary of the image.
//
// 3. Animation moved the meshes. Objects that translate read as objects. Here the curve is evaluated in the vertex shader from time, so the curtains are the current state of a field rather than props being pushed around, and the far members swing further on the shared curve than the near ones (u_cuShear) so the family deforms instead of sliding.
//
// 4. Nothing was gained from having many curtains, because they were all on one circle at one distance and stacked on the same pixels. Here they occupy a 550 km range of distance, so perspective separates them in elevation and in apparent size, and the overlaps are between things at visibly different depths.
//
// 5. No fine vertical structure. The striations are the aurora -- they are the visible field lines, and they are what makes it read as a plasma rather than as cloth. Here they are two octaves of ridged detail with no height term at all, so they are exactly vertical, plus an interference shimmer that never repeats.
//
// The one thing that does not transfer is branching. A contour of a scalar field splits and merges because the field has saddle points; a strip of triangles has fixed topology and cannot. What is offered instead is curtains that cross in the plan, which additively read as merges, plus enough patchiness along each curtain that no single one reads as an object with a shape.
//
// ===========================================================================
// OVERDRAW, MEASURED
// ===========================================================================
//
// Overdraw is the only cost here that matters, so it gets a number. These are counted layer-by-layer off a real draw at the schema defaults, facing north, over seven values of t, by aurora-curtain-probe.html under headless Chrome and SwiftShader. They are LAYER COUNTS, not times: nothing in this repository has been run on a headset, and nothing here should be read as a frame-time prediction.
//
//   worst pixel .................... 26 layers
//   mean over covered pixels ....... 8.93
//   frame average .................. 5.46 screen-equivalents
//   fraction of frame covered ...... 61.1%
//   facing south ................... 0 lit pixels
//
// The estimate this replaces reasoned its way to "about 9 worst case, about 4.2 frame-average", and it was wrong in a specific and instructive way: 9 is almost exactly the mean over covered pixels, so the arithmetic was computing an AVERAGE and calling it a worst case. The real worst case is 26, about three times that, and the frame average is 5.46 rather than 4.2 because the curtains cover 61% of the frame rather than the 47% the belt's elevation span suggested -- the crown and the hem fade out gradually, so the geometry reaches well past the band the belt occupies.
//
// The other assumption that did not survive contact: the gate was expected to leave "roughly two thirds with any brightness at all", cutting 18 curtains to 12. It cuts nothing. Measured across the gate amount, the mean depth is 5.43 at cuGateAmt 0, 5.42 at the default 0.72, and 5.41 at 0.9 -- flat, because the gate DIMS a curtain and only a curtain that reaches exactly zero can be collapsed to zero-area triangles. At cuGateAmt exactly 1 the mean drops to 3.85, a 29% saving, which is the whole of what that mechanism is worth and is why the slider's own hint now says so. u_cuCull is worth 2% at the default gate and 16% at a full one; it is a real knob only in the regime where vis can reach zero.
//
// u_cuLeaves multiplies the mean essentially exactly -- 5.42, 10.85, 16.28 at 1, 2 and 3 -- which is why it defaults to 1.
//
// The fragment shader is straight-line ALU: no loop, no branch, no texture fetch, no discard. I am deliberately not converting that into an operation count and comparing it with the march's, because a ratio of static instruction counts is not a performance result and presenting it as one is how this project has previously talked itself into things. The honest statement is: the work per fragment is fixed and small, the number of fragments is now counted rather than guessed, and neither has been timed on a GPU.
//
// WHAT IS VERIFIED: the stock vertex and fragment shaders LINK on real GL and the mesh draws (238k lit pixels facing north, 0 facing south); the placement math produces no NaN or Inf over 40500 vertices at ten times t, and the smallest tangent reaching normalize() is 0.0024 rather than 0; every vertex stays inside its bounding sphere; the surface matches AuroraScreen's; the project builds and the lab's checker passes.
//
// WHAT IS NOT: any frame time, anywhere, on any device. Whether it compiles on the Adreno driver -- SwiftShader is ANGLE's software path and shares ANGLE's front end, which is what caught the reserved word, but it is not the headset's compiler. Whether the defaults look good, which is a question for a person at the panel.
// ---------------------------------------------------------------------------

import * as THREE from 'three'
import { CURTAIN_ENTRY, STRUCTURAL_KEYS, curtainGroups, curtainParams, curtainDefaults } from './params.js'
import { CURTAIN_VERTEX, CURTAIN_FRAGMENT, auditUniformUse } from './glsl.js'
import { buildCurtainGeometry, WORLD_PER_KM } from './geometry.js'

export { CURTAIN_ENTRY }

function toUniformValue( param, value ) {
  if ( param.type === 'color' ) return new THREE.Vector3( value[ 0 ], value[ 1 ], value[ 2 ] )
  return value
}

function writeUniformValue( param, slot, value ) {
  if ( param.type === 'color' ) {
    slot.value.set( value[ 0 ], value[ 1 ], value[ 2 ] )
    return
  }
  slot.value = value
}

export class AuroraCurtains {

  constructor( scene, opts = {} ) {
    this.scene = scene
    this.algorithmId = CURTAIN_ENTRY.id

    // Checked once at construction rather than trusted: a param whose uniform no GLSL line reads is a slider that moves and does nothing, and that is a bug you only find by wondering why a knob has no effect.
    auditUniformUse()

    this.paramList = curtainParams()
    this.paramIndex = new Map( this.paramList.map( p => [ p.key, p ] ) )

    this.values = curtainDefaults()
    if ( opts.values ) {
      for ( const k of Object.keys( opts.values ) ) {
        if ( this.paramIndex.has( k ) ) this.values[ k ] = opts.values[ k ]
      }
    }

    this.geometry = null
    this.material = null
    this.mesh = null

    this._buildMaterial()
    this._buildGeometry()

    this.mesh = new THREE.Mesh( this.geometry, this.material )
    // Nothing here is where the position attribute says it is -- the vertex shader places every vertex from a time-dependent curve -- so a frustum test against a bounding volume derived from the buffer would be answering a question about a mesh that does not exist. The band wraps 124 degrees of sky and follows the eye, so it is almost always partly in view anyway and the test would rarely pay.
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -800
    this.scene.add( this.mesh )
  }

  // -------------------------------------------------------------------------

  groups() {
    return curtainGroups()
  }

  _param( key ) {
    const p = this.paramIndex.get( key )
    if ( !p ) throw new Error( 'AuroraCurtains: no param "' + key + '"' )
    return p
  }

  _buildMaterial() {
    const uniforms = {}
    for ( const p of this.paramList ) {
      if ( !p.uniform ) continue
      uniforms[ 'u_' + p.key ] = { value: toUniformValue( p, this.values[ p.key ] ) }
    }
    uniforms.u_cuTime = { value: 0 }
    uniforms.u_cuKm = { value: WORLD_PER_KM }
    uniforms.u_cuOrigin = { value: new THREE.Vector3( 0, 0, 0 ) }

    this._fragment = CURTAIN_FRAGMENT

    const mat = new THREE.ShaderMaterial( {
      uniforms,
      vertexShader: CURTAIN_VERTEX,
      fragmentShader: CURTAIN_FRAGMENT,
      // Additive, because emission adds and an optically thin medium has no occlusion within itself. That is also why the sheets need no sorting: addition commutes, so draw order cannot change the image, which is the single largest thing this approach gets for free and the reason a transparent mesh aurora is tractable at all where a transparent anything-else is not.
      blending: THREE.AdditiveBlending,
      // Depth TEST on, so mountains occlude the aurora. Depth WRITE off, so curtains do not occlude one another -- a curtain in front writing depth would punch a hole in the one behind, and there is no hole, there is more glowing gas.
      depthTest: true,
      depthWrite: false,
      // A sheet seen from behind is the same sheet. The grazing term already uses abs() of the view-normal dot for exactly this reason.
      side: THREE.DoubleSide,
      fog: false,
      transparent: true,
    } )

    const old = this.material
    this.material = mat
    if ( this.mesh ) this.mesh.material = mat
    if ( old ) old.dispose()
  }

  _buildGeometry() {
    const geo = buildCurtainGeometry(
      Math.round( this.values.cuCurtains ),
      Math.round( this.values.cuSegs ),
      Math.round( this.values.cuRows ),
      Math.round( this.values.cuLeaves )
    )
    const old = this.geometry
    this.geometry = geo
    if ( this.mesh ) this.mesh.geometry = geo
    if ( old ) old.dispose()
  }

  // -------------------------------------------------------------------------

  setParam( key, value ) {
    const p = this._param( key )
    this.values[ key ] = value
    if ( p.uniform ) writeUniformValue( p, this.material.uniforms[ 'u_' + key ], value )
    if ( STRUCTURAL_KEYS.indexOf( key ) !== -1 ) this._buildGeometry()
  }

  getParam( key ) {
    this._param( key )
    return this.values[ key ]
  }

  setValues( values ) {
    let rebuild = false
    for ( const k of Object.keys( values ) ) {
      const p = this.paramIndex.get( k )
      // Presets outlive the schema they were saved against. Skipped rather than thrown on, because renaming one knob should not brick every preset on disk -- but skipped loudly, because a preset that half-applies is a tuning nobody can reproduce. Same call, same reason, as AuroraScreen.
      if ( !p ) {
        console.warn( 'aurora-curtains: ignoring unknown param "' + k + '" (schema changed?)' )
        continue
      }
      this.values[ k ] = values[ k ]
      if ( p.uniform ) writeUniformValue( p, this.material.uniforms[ 'u_' + k ], values[ k ] )
      if ( STRUCTURAL_KEYS.indexOf( k ) !== -1 ) rebuild = true
    }
    if ( rebuild ) this._buildGeometry()
  }

  snapshot() {
    return { algorithm: this.algorithmId, values: { ...this.values } }
  }

  fragmentSource() {
    return this._fragment
  }

  vertexSource() {
    return CURTAIN_VERTEX
  }

  stats() {
    return this.geometry.userData.curtainStats
  }

  // -------------------------------------------------------------------------

  update( camera, elapsed ) {
    this.material.uniforms.u_cuTime.value = elapsed
    // Horizontal only. The aurora follows a walking player so they never reach its edge, but its altitude stays absolute so climbing genuinely raises the hem's elevation angle. Not parallax -- at 230 km there is none to have -- just the difference between a sky and a very large prop.
    const o = this.material.uniforms.u_cuOrigin.value
    o.x = camera.position.x
    o.z = camera.position.z
  }

  dispose() {
    this.scene.remove( this.mesh )
    this.geometry.dispose()
    this.material.dispose()
  }
}
