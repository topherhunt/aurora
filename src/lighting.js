import * as THREE from 'three'
import { WORLD_SIZE, WORLD_HALF } from './sim/terrain-height.js'
import { AZIMUTHS, HORIZON_SOFT } from './sim/horizon.js'

// ---------------------------------------------------------------------------
// World lighting: the render-side half of the horizon map (§8).
//
// src/sim/horizon.js bakes the data and explains the technique. This file owns
// the two textures it becomes, the handful of uniforms that point the sun at
// them, and the GLSL that every lit material in the scene shares.
//
// The shared-uniform trick is worth stating because it is what makes this
// tractable: the objects in `this.uniforms` are handed BY REFERENCE into each
// material's compiled shader.uniforms. So there are five materials reading the
// sun's position and exactly one place that writes it, and no per-material
// update loop that can fall out of step. It also means the textures can arrive
// LATE -- Phase A takes four seconds and the world is already on screen -- and
// every material picks them up on the frame they land, with no recompile.
//
// TWO GRANULARITIES, on purpose:
//
//   PER-FRAGMENT for the terrain. The shadow of a ridge falls across the ground
//   in the middle of a triangle, and terrain triangles at the far LOD rings are
//   64 m across. Per-vertex there would put the shadow edge on the mesh's
//   quadtree boundaries, which is exactly where the eye is already looking for
//   seams.
//
//   PER-VERTEX for everything else. A tree, a cabin wall and a smoke puff are
//   all small compared to a mountain shadow, so one sample at each vertex is
//   indistinguishable from one per pixel -- and props are the triangle budget
//   (§5), so two texture fetches per fragment across a forest is real money for
//   an answer that does not change.
// ---------------------------------------------------------------------------

// GLSL shared by both paths. The sampling function is deliberately identical in
// vertex and fragment shaders: if the terrain and the trees standing on it
// disagreed about where a shadow edge is, the trees would appear to float.
const SAMPLE_GLSL = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uHorizonMap;
  uniform sampler2D uSkyView;
  // x = light azimuth in TURNS (0..1, north, clockwise), y = elevation in
  // radians, z = 1 when the maps have arrived and 0 before.
  uniform vec3 uSunSky;

  vec2 wlUv( vec2 worldXZ ) {
    return ( worldXZ + ${WORLD_HALF.toFixed(1)} ) * ( 1.0 / ${WORLD_SIZE.toFixed(1)} );
  }

  // Sun visibility, 0 in full shadow to 1 in full sun.
  float wlSun( vec2 worldXZ ) {
    if ( uSunSky.z < 0.5 ) return 1.0;

    // Blend the two baked azimuths straddling the sun. Without this the shadow
    // edge jumps 22.5 degrees at a time as the sun moves, which on a ridge a
    // kilometre off is a shadow line leaping a couple of hundred metres --
    // impossible to miss, and the reason 16 slices are enough WITH the blend
    // and nowhere near enough without it.
    float f = uSunSky.x * ${AZIMUTHS}.0;
    float f0 = floor( f );
    float t = f - f0;
    // mod, not clamp: azimuth wraps, and slice 15 blends into slice 0.
    float a0 = mod( f0, ${AZIMUTHS}.0 );
    float a1 = mod( f0 + 1.0, ${AZIMUTHS}.0 );

    vec2 uv = wlUv( worldXZ );
    float h0 = texture( uHorizonMap, vec3( uv, a0 ) ).r;
    float h1 = texture( uHorizonMap, vec3( uv, a1 ) ).r;
    float h = mix( h0, h1, t ) * 1.5707963;

    return smoothstep( h - ${HORIZON_SOFT.toFixed(5)}, h + ${HORIZON_SOFT.toFixed(5)}, uSunSky.y );
  }

  // Fraction of the sky hemisphere this point can see: the ambient occlusion
  // term. Sun-independent, so it is the same number at noon and at midnight.
  float wlSky( vec2 worldXZ ) {
    if ( uSunSky.z < 0.5 ) return 1.0;
    return texture( uSkyView, wlUv( worldXZ ) ).r;
  }
`

// Recovering world position inside a patched vertex shader. Handles both of the
// transforms this project uses -- BatchedMesh for terrain and props, and
// InstancedMesh for the village's flames and smoke -- because `transformed` is
// still in object-local space at this point and neither matrix is folded into
// modelMatrix. Injected AFTER <project_vertex>, where both are in scope.
const WORLD_POS_GLSL = /* glsl */ `
  vec4 wlLocal = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    wlLocal = batchingMatrix * wlLocal;
  #endif
  #ifdef USE_INSTANCING
    wlLocal = instanceMatrix * wlLocal;
  #endif
  vec3 wlWorld = ( modelMatrix * wlLocal ).xyz;
`

// Where the shading terms are applied. AFTER <lights_fragment_end>, so
// reflectedLight is fully accumulated and both terms land on the right halves:
//
//   directDiffuse   is the one directional light -- the sun, or the moon after
//                   dark. Shadowing multiplies THIS.
//   indirectDiffuse is the hemisphere fill, i.e. skylight. Occlusion multiplies
//                   THIS.
//
// Applying either to the wrong one is the classic mistake and it is visible
// both ways round: AO on the direct term double-darkens creases that are
// already facing away, and shadow on the indirect term makes a shadowed valley
// pitch black instead of blue.
//
// The two NIGHT terms are applied here too, and both exist because a
// hemisphere light is a multiplier -- see the NIGHT block in clock.js.
//
//   uSkyFloor remaps occlusion so that "fully occluded" means uSkyFloor rather
//   than zero. Zero is right at noon, when the sun fills the gully the AO term
//   is darkening. It is wrong after dark, when the ambient IS the light and an
//   occlusion of 0.1 leaves the gully with a tenth of the only illumination
//   there is.
//
//   uNightLift is ADDED, not multiplied, and that is the entire point: it does
//   not touch diffuseColor, so it lifts a 4% albedo tree trunk by the same
//   amount it lifts snow. Multiplied light cannot do this at any intensity.
//   It is airglow and scattered starlight, it is zero during the day, and it is
//   what the eye reads as "dark but navigable" rather than "off".
//
// It is added AFTER the floor multiply and scaled by the same floored sky term,
// so an enclosed space still reads as darker than an open one -- just never as
// nothing.
const APPLY = (sun, sky) => /* glsl */ `
  reflectedLight.directDiffuse *= ${sun};
  float wlSkyF = mix( uSkyFloor, 1.0, ${sky} );
  reflectedLight.indirectDiffuse *= wlSkyF;
  reflectedLight.indirectDiffuse += uNightLift * wlSkyF;
`

// Declared separately from SAMPLE_GLSL because the vertex-shaded path does not
// put SAMPLE_GLSL in its fragment shader at all -- it only carries the two
// sampled values across as a varying. These two uniforms are needed in the
// fragment shader either way.
const NIGHT_GLSL = /* glsl */ `
  uniform vec3 uNightLift;
  uniform float uSkyFloor;
`

export class WorldLighting {
  constructor() {
    this.ready = false

    this.uniforms = {
      uHorizonMap: { value: null },
      uSkyView: { value: null },
      uSunSky: { value: new THREE.Vector3(0, 1, 0) },
      // Linear-space, because it is added straight into reflectedLight. The
      // palette stores it as sRGB like every other colour, and `update` does
      // the conversion in one place.
      uNightLift: { value: new THREE.Color(0, 0, 0) },
      uSkyFloor: { value: 0 },
    }

    this.horizonTex = null
    this.skyTex = null
  }

  // Called once, when the worker's Phase A result lands.
  setMaps(horizon, sky, n) {
    if (horizon.length !== n * n * AZIMUTHS) {
      throw new Error(`horizon map is ${horizon.length}, expected ${n * n * AZIMUTHS}`)
    }
    if (sky.length !== n * n) throw new Error(`sky map is ${sky.length}, expected ${n * n}`)

    // RedFormat / UnsignedByteType: one byte per texel, which is all an angle
    // quantised to 0.35 degrees needs. Packing four azimuths into RGBA would
    // save nothing -- same bytes -- and would cost a channel-select branch in
    // the shader, because the layer index has to be computed from the sun.
    // A non-constant layer index into a sampler2DArray is legal in GLSL ES 3.0,
    // which is what makes the array form the simpler one.
    const tex = new THREE.DataArrayTexture(horizon, n, n, AZIMUTHS)
    tex.format = THREE.RedFormat
    tex.type = THREE.UnsignedByteType
    // LINEAR gives bilinear filtering WITHIN each layer for free, which is what
    // smooths a 16 m/texel shadow edge into a curve. It does NOT filter across
    // layers -- that is what the manual blend in wlSun is for.
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.ClampToEdgeWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
    // Rows are n bytes wide and n is a power of two here, but the default
    // 4-byte row alignment would shear the image for any n that is not a
    // multiple of 4 -- and the resolution is a tuning knob. Set it explicitly
    // rather than leave a landmine under a constant someone will change.
    tex.unpackAlignment = 1
    tex.needsUpdate = true

    const skyTex = new THREE.DataTexture(sky, n, n, THREE.RedFormat, THREE.UnsignedByteType)
    skyTex.minFilter = THREE.LinearFilter
    skyTex.magFilter = THREE.LinearFilter
    skyTex.wrapS = THREE.ClampToEdgeWrapping
    skyTex.wrapT = THREE.ClampToEdgeWrapping
    skyTex.unpackAlignment = 1
    skyTex.needsUpdate = true

    this.horizonTex = tex
    this.skyTex = skyTex
    this.uniforms.uHorizonMap.value = tex
    this.uniforms.uSkyView.value = skyTex
    this.uniforms.uSunSky.value.z = 1
    this.ready = true
  }

  // Once per frame, from the clock state.
  update(state) {
    const u = this.uniforms.uSunSky.value
    // state.lightDir is whichever body the single directional light is
    // currently standing in for -- the sun by day, the moon after -6 degrees.
    // Shadows are cast by the light that exists, so moonlight casts them too,
    // and a moonlit valley has the same ridge shadow across it that it had at
    // noon, from a different angle and far weaker.
    u.x = state.lightDir.azDeg / 360
    u.y = (state.lightDir.elevDeg * Math.PI) / 180

    // setRGB with SRGBColorSpace converts into the renderer's working space,
    // which is linear -- the same trip every other palette colour makes on its
    // way into a THREE.Color, done here rather than in main.js because this is
    // the only consumer.
    const lift = this.uniforms.uNightLift.value
    lift.setRGB(state.skyGlow[0], state.skyGlow[1], state.skyGlow[2], THREE.SRGBColorSpace)
    lift.multiplyScalar(state.skyGlowAmt)
    this.uniforms.uSkyFloor.value = state.skyFloor
  }

  /**
   * Patch a MeshLambertMaterial to be shadowed and occluded by the terrain.
   *
   * `mode` is 'fragment' for the terrain and 'vertex' for everything else --
   * see the header for why the two exist.
   *
   * `worldPosVarying` lets a material that ALREADY carries a world-position
   * varying reuse it instead of declaring a second one; terrain-material.js
   * has had `vWorldPos` since the surface grain was written.
   *
   * `cacheKey` must be distinct per material, because three keys its program
   * cache on it and two differently-patched Lamberts would otherwise share a
   * compiled program.
   */
  patch(material, { mode, cacheKey, worldPosVarying = null }) {
    if (mode !== 'fragment' && mode !== 'vertex') throw new Error(`patch: bad mode ${mode}`)

    const prev = material.onBeforeCompile
    const uniforms = this.uniforms

    material.onBeforeCompile = (shader, renderer) => {
      // Chained, not replaced. Every material this is applied to already has an
      // onBeforeCompile doing its own job -- the prop atlas, the terrain grain
      // -- and silently dropping it would remove the textures from every tree
      // in the world.
      if (prev) prev.call(material, shader, renderer)
      Object.assign(shader.uniforms, uniforms)

      if (mode === 'fragment') {
        if (!worldPosVarying) throw new Error('patch: fragment mode needs worldPosVarying')
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${SAMPLE_GLSL}\n${NIGHT_GLSL}`)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            ${APPLY(`wlSun( ${worldPosVarying}.xz )`, `wlSky( ${worldPosVarying}.xz )`)}`
          )
      } else {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${SAMPLE_GLSL}\nvarying vec2 vWlShade;`)
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            ${WORLD_POS_GLSL}
            vWlShade = vec2( wlSun( wlWorld.xz ), wlSky( wlWorld.xz ) );`
          )
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec2 vWlShade;\n${NIGHT_GLSL}`)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            ${APPLY('vWlShade.x', 'vWlShade.y')}`
          )
      }
    }

    material.customProgramCacheKey = () => cacheKey
    return material
  }

  dispose() {
    if (this.horizonTex) this.horizonTex.dispose()
    if (this.skyTex) this.skyTex.dispose()
  }
}
