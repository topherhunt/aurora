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
export const SAMPLE_GLSL = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray uHorizonMap;
  uniform sampler2D uSkyView;
  // x = light azimuth in TURNS (0..1, north, clockwise), y = elevation in
  // radians, z = 1 when the maps have arrived and 0 before.
  uniform vec3 uSunSky;

  vec2 wlUv( vec2 worldXZ ) {
    return ( worldXZ + ${WORLD_HALF.toFixed(1)} ) * ( 1.0 / ${WORLD_SIZE.toFixed(1)} );
  }

  // How high the ground rises, in radians above level, looking from worldXZ
  // along a compass azimuth given in TURNS (0 = north, growing clockwise).
  // Beyond that angle you are looking at sky; below it, at a mountain.
  //
  // Blends the two baked azimuths straddling the query. Without this the answer
  // jumps 22.5 degrees at a time, which on a ridge a kilometre off is a shadow
  // line leaping a couple of hundred metres -- impossible to miss, and the
  // reason 16 slices are enough WITH the blend and nowhere near enough without.
  //
  // Returns 0 -- open sky in every direction -- until the maps arrive.
  float wlHorizon( vec2 worldXZ, float azTurns ) {
    if ( uSunSky.z < 0.5 ) return 0.0;

    float f = azTurns * ${AZIMUTHS}.0;
    float f0 = floor( f );
    float t = f - f0;
    // mod, not clamp: azimuth wraps, and slice 15 blends into slice 0.
    float a0 = mod( f0, ${AZIMUTHS}.0 );
    float a1 = mod( f0 + 1.0, ${AZIMUTHS}.0 );

    vec2 uv = wlUv( worldXZ );
    float h0 = texture( uHorizonMap, vec3( uv, a0 ) ).r;
    float h1 = texture( uHorizonMap, vec3( uv, a1 ) ).r;
    return mix( h0, h1, t ) * 1.5707963;
  }

  // The compass azimuth of a world-space direction, in turns.
  //
  // THE CONVENTION IS FIXED BY THE BAKE AND IT IS EASY TO GET WRONG SILENTLY.
  // horizon.js walks each azimuth as di = sin(ang), dj = -cos(ang), and the sim
  // grid maps +i to +x and +j to +z. So north is -z, east is +x, and the angle
  // grows clockwise from north -- which is atan(x, -z), not the atan(z, x) that
  // a maths convention would suggest. Swapping them puts every mountain in the
  // reflection 90 degrees from where it belongs, and nothing about the image
  // says so. scripts/check-water-shader.mjs pins this against the raw grid.
  float wlAzimuth( vec3 dir ) {
    return fract( atan( dir.x, -dir.z ) * ${(1 / (2 * Math.PI)).toFixed(9)} + 1.0 );
  }

  // 1 where terrain blocks the sky along dir, 0 where the sky is open, with
  // the same soft edge the sun shadow uses.
  float wlBlocked( vec2 worldXZ, vec3 dir ) {
    float h = wlHorizon( worldXZ, wlAzimuth( dir ) );
    float elev = asin( clamp( dir.y, -1.0, 1.0 ) );
    return 1.0 - smoothstep( h - ${HORIZON_SOFT.toFixed(5)}, h + ${HORIZON_SOFT.toFixed(5)}, elev );
  }

  // Sun visibility, 0 in full shadow to 1 in full sun.
  float wlSun( vec2 worldXZ ) {
    if ( uSunSky.z < 0.5 ) return 1.0;
    float h = wlHorizon( worldXZ, uSunSky.x );
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
//
// ---- The NEAR-FIELD envelope, `near`, which is 1 within WL_NEAR_M of the head
// and 0 beyond WL_FAR_M.
//
// It scales the two AMBIENT terms to uFarLight.y and the DIRECTIONAL term to
// uFarLight.x out in the far field. Both are 1.0 while the sun is up, so this
// is inert by day; see the FAR FIELD block in clock.js for why they are (0.40,
// 0.0) at full dark and what it costs.
//
// The directional keeps its shadow multiply either way -- the far field is not
// "no lighting", it is "lighting that answers only to where the moon is",
// which means a ridge shadow is still a ridge shadow out there.
const APPLY = (sun, sky, near) => /* glsl */ `
  float wlNear = ${near};
  reflectedLight.directDiffuse *= ${sun} * mix( uFarLight.x, 1.0, wlNear );
  float wlSkyF = mix( uSkyFloor, 1.0, ${sky} ) * mix( uFarLight.y, 1.0, wlNear );
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
  uniform vec2 uFarLight;
  uniform vec3 uAirNear;
  uniform vec3 uAirFar;
`

// The two radii of the near-field envelope, in metres.
//
// The inner radius is 0 on purpose. It was 25, which made the envelope a flat
// fully-lit DISC around her with the whole falloff crammed into the 25 m ring
// outside it -- and a disc with an edge is a spotlight, which is what it looked
// like. With the inner radius at 0 there is no plateau: the lift is strongest
// underfoot and thins continuously outward, so the gradient reads as her own
// eyes adapting rather than as a light she is carrying.
//
// The outer radius went 50 -> 75 to pay for that. smoothstep is symmetric about
// its midpoint, so 0..75 puts the half-strength point at 37.5 m, exactly where
// 25..50 had it; what changes is that the curve now starts at her feet and has
// a long tail instead of a hard start and a short one. The near field ends up
// slightly dimmer at 10-25 m and slightly brighter at 50-70 m, which is the
// trade that removes the ring.
const WL_NEAR_M = 0
const WL_FAR_M = 75

const NEAR_GLSL = (worldPos) =>
  `( 1.0 - smoothstep( ${WL_NEAR_M.toFixed(1)}, ${WL_FAR_M.toFixed(1)}, distance( ${worldPos}, cameraPosition ) ) )`

// ---------------------------------------------------------------------------
// AERIAL PERSPECTIVE: distance has a COLOUR, and it is not one colour.
//
// Three's fog is a single lerp toward a single colour, so everything past the
// point where it saturates is the same flat wash and a range of mountains
// three, six and twelve kilometres out is one silhouette. Real distance does
// not do that, and neither does a painting of it: the near ridge is the DARKEST
// thing on the skyline and each one behind it is LIGHTER, until the furthest
// melts into the sky. That ladder is the entire cue that says "those are three
// separate ranges" rather than "that is a wall with a bumpy top".
//
// It comes out of two independent terms that three collapses into one:
//
//   EXTINCTION  how much of the surface's own colour survives the trip. Falls
//               off fast, saturates early, and once it is gone it is gone --
//               past its range every surface is pure air whatever it is made
//               of. This is what turns a hillside into a silhouette.
//
//   IN-SCATTER  what the air between you and the surface is glowing with, which
//               is sunlight bounced sideways off the whole column of it. Builds
//               SLOWLY and never saturates over any distance we draw, because
//               there is always more air. This is what makes the far ranges
//               lighter than the near ones.
//
// So: extinction picks WHEN a surface stops being itself, in-scatter picks WHAT
// it becomes, and the two run on completely different length scales. One term
// cannot have both, which is why one term gives a wall.
//
// THE ARITHMETIC IS STILL THREE'S FOG, and deliberately so. `c * keep + air *
// (1 - keep)` is `mix( c, air, 1 - keep )`, i.e. exactly the lerp the stock
// chunk does, with a distance-varying colour in place of the constant one. That
// means it inherits three's colour-space handling for free: the mix happens
// after `colorspace_fragment`, in output space, and `uAirNear` is fed as raw
// sRGB components for the same reason `fogColor` arrives that way (see three's
// refreshFogUniforms, which converts on upload). Set both ends of the ramp to
// `fogColor` and this is bit-for-bit the stock chunk.
//
// EXTINCTION REUSES `fogDensity` rather than adding a rate of its own -- the
// scene's FogExp2 density IS the extinction coefficient, and letting it stay
// that keeps everything reading one number. v2 feeds that uniform the palette's
// `hazeDensity`, which is a genuinely different quantity from `fogDensity` and
// has to be: see the note in clock.js on why the night rows may not simply be
// the day rows scaled.
//
// WHY THE FALL-OFF RATE IS A CONSTANT AND NOT A PALETTE ROW: it is the depth of
// the atmosphere, which is the one thing in this file that does not care what
// time it is. What time it is changes the COLOUR the air glows (both ends of the
// ramp come from the palette) and how quickly a surface is lost behind it
// (hazeDensity), not how many kilometres of sky are stacked over the valley.
//
// 1/4000 m puts the in-scatter at 22% of the way from the near haze to the far
// one at 1 km, 39% at 2 km, 71% at 5 km and 92% at 10 km -- three distinguishable
// depth planes inside the range anything is actually drawn at.
const AIR_FALL = 1 / 4000

// THE FAR END OF THE RAMP IS THE WATER, NOT THE SKY.
//
// In-scatter never saturates, so the only thing deciding how light a distant
// ridge is allowed to get is what its far target is. Aimed at `fogColor` -- the
// palette row tuned to match the horizon sky -- a range at 5 km comes out
// LIGHTER than the lake in front of it, which is backwards and reads instantly
// as wrong: water at distance is seen at a grazing angle where Fresnel is
// essentially 1, so it is a near-perfect mirror of that same horizon sky and is
// therefore the brightest thing on the skyline that is not the sky itself. Land
// is never brighter than the mirror of the thing it is standing under.
//
// So the ramp ends where the water ends. water.js fades a distant water pixel to
// `skyRadiance( horizon ) * uReflTint`, i.e. the horizon sky dimmed by the light
// a reflection loses; this is that same dim applied to fogColor, which is that
// same horizon sky. The far field then orders itself sky > water > land at every
// distance and every hour, with land and water meeting at one colour instead of
// crossing over.
//
// It is WATER.reflTint * WATER.reflDim, built the way water.js builds uReflTint
// so the two are the same number in the same space. It is copied rather than
// imported because water.js imports THIS file and a cycle to share one constant
// is a bad trade; check-water-shader.mjs asserts the copy still agrees.
export const AIR_CEILING = new THREE.Color(0xc2d4ee).multiplyScalar(0.8)

// Scratch for the once-a-frame trip fogColor -> linear -> ceiling -> sRGB.
const _airLin = new THREE.Color()
const _airOut = { r: 0, g: 0, b: 0 }

// Replaces `#include <fog_fragment>`. Guarded exactly the way the stock chunk
// is, so a material with `fog: false` compiles to nothing here as before.
const AERIAL_GLSL = /* glsl */ `
  #ifdef USE_FOG
    // fogDensity only exists on the exponential path. Rather than silently
    // falling back to fogNear/fogFar and shipping a world whose distance is
    // subtly the wrong shape, refuse to compile.
    #ifndef FOG_EXP2
      #error aerial perspective requires scene.fog to be a THREE.FogExp2
    #endif
    float aerialTau = vFogDepth * fogDensity;
    float aerialKeep = exp( - aerialTau * aerialTau );
    vec3 aerialAir = mix( uAirNear, uAirFar, 1.0 - exp( - vFogDepth * ${AIR_FALL.toExponential()} ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, aerialAir, 1.0 - aerialKeep );
  #endif
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
      // x scales the directional term in the far field, y the ambient ones.
      // (1, 1) is "no envelope at all", which is what daylight wants.
      uFarLight: { value: new THREE.Vector2(1, 1) },
      // The near end of the aerial-perspective ramp -- the colour a surface has
      // become by the time extinction has eaten it, before the in-scatter has
      // had room to lighten it again. A Vector3 of RAW sRGB components, not a
      // Color: the mix it feeds happens after colorspace_fragment, in output
      // space, which is the same space three uploads fogColor in. Converting to
      // linear here would put the two halves of one lerp in two spaces.
      uAirNear: { value: new THREE.Vector3(0, 0, 0) },
      // The far end of it, in the same raw-sRGB terms and for the same reason.
      // Not fogColor but fogColor under AIR_CEILING -- see the note there.
      uAirFar: { value: new THREE.Vector3(0, 0, 0) },
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
    this.uniforms.uFarLight.value.set(state.farDirect, state.farAmbient)
    // Straight across, no colour-space trip -- see the uniform's declaration.
    this.uniforms.uAirNear.value.set(state.haze[0], state.haze[1], state.haze[2])
    // The far end does take the trip, because the ceiling it is multiplied by is
    // a light loss and light losses are linear. sRGB in, linear, ceiling, sRGB
    // back out -- the same round trip water.js's uReflTint gets, so the two land
    // on the same colour rather than on two versions of it.
    _airLin.setRGB(state.fog[0], state.fog[1], state.fog[2], THREE.SRGBColorSpace)
    _airLin.multiply(AIR_CEILING)
    _airLin.getRGB(_airOut, THREE.SRGBColorSpace)
    this.uniforms.uAirFar.value.set(_airOut.r, _airOut.g, _airOut.b)
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
            ${APPLY(
              `wlSun( ${worldPosVarying}.xz )`,
              `wlSky( ${worldPosVarying}.xz )`,
              NEAR_GLSL(`${worldPosVarying}.xyz`)
            )}`
          )
          .replace('#include <fog_fragment>', AERIAL_GLSL)
      } else {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${SAMPLE_GLSL}\nvarying vec3 vWlShade;`)
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            ${WORLD_POS_GLSL}
            vWlShade = vec3( wlSun( wlWorld.xz ), wlSky( wlWorld.xz ),
                             ${NEAR_GLSL('wlWorld')} );`
          )
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vWlShade;\n${NIGHT_GLSL}`)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            ${APPLY('vWlShade.x', 'vWlShade.y', 'vWlShade.z')}`
          )
          .replace('#include <fog_fragment>', AERIAL_GLSL)
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
