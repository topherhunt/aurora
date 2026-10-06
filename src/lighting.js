import THREE from './three-instance.js'
import { WORLD_SIZE, WORLD_HALF } from './sim/terrain-height.js'
import { AZIMUTHS, HORIZON_SOFT } from './sim/horizon.js'
import { HEARTHS } from './v2/hearth-light.js'

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
// update loop that can fall out of step.
//
// WHAT IS COMPILED IN IS A DECISION, NOT A UNIFORM, and there are two axes of
// it. See the registry on the class: a uniform whose value says "do nothing"
// still pays for every instruction guarded by it, which on a Quest 2 is the
// whole cost and none of the effect.
//
//   `enabled`, which the headset panel's `terrain & prop lighting` row owns.
//   Off, the patch emits NOTHING -- stock Lambert, stock fog -- so the A/B
//   against on is this system's price in milliseconds.
//
//   `ready`, which is whether setMaps() has been called. Until it has, wlSun
//   and wlSky can only ever return 1.0, so emitting them means two sampler
//   declarations, an atan, an asin and two dead texture fetches per terrain
//   FRAGMENT and two dead varying components per prop VERTEX, in every material
//   in the world, for a constant. Unready compiles the constant instead.
//
// Both cost a recompile of every patched material on the frame they flip, which
// is a one-off hitch and is the price of not paying for them every frame.
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
//
// ---- `liftAlbedo`, a patch() option: uLiftAlbedo = (mix, gain) blends the
// lift from flat toward `albedo * gain`. Flat lift is a grey floor under every
// texel, which reads as grey shadow in a canopy; albedo-weighted lift keeps
// greens green and lets dark texels fall toward black, at the cost of dark
// trunks sinking back toward the hole the NIGHT block in clock.js describes.
const APPLY = (sun, sky, near, liftAlbedo) => /* glsl */ `
  float wlNear = ${near};
  reflectedLight.directDiffuse *= ${sun} * mix( uFarLight.x, 1.0, wlNear );
  reflectedLight.directSpecular *= ${sun} * mix( uFarLight.x, 1.0, wlNear );
  float wlSkyF = mix( uSkyFloor, 1.0, ${sky} ) * mix( uFarLight.y, 1.0, wlNear );
  reflectedLight.indirectDiffuse *= wlSkyF;
  reflectedLight.indirectDiffuse += uNightLift * wlSkyF${liftAlbedo ? ' * mix( vec3( 1.0 ), diffuseColor.rgb * uLiftAlbedo.y, uLiftAlbedo.x )' : ''};
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
export const AIR_FALL = 1 / 4000

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

// The ceiling lifts with cloud cover (§10): it exists for a sunny far range
// against a lake, and under an overcast, where nothing shows past a kilometre,
// it would only darken the fog itself with distance and cut a dark band
// between the near fog and the sky's. The sky dome ends its own haze here too.
export function airCeiling(cover, out) {
  return out.copy(AIR_CEILING).lerp(WHITE, cover)
}
const WHITE = new THREE.Color(1, 1, 1)

// Scratch for the once-a-frame trip fogColor -> linear -> ceiling -> sRGB.
const _airLin = new THREE.Color()
const _ceil = new THREE.Color()
const _airOut = { r: 0, g: 0, b: 0 }
// The output-space ramp ends, held while a capture has the linear ones in.
const _airSavedNear = new THREE.Vector3()
const _airSavedFar = new THREE.Vector3()

// CAUSTICS: the moving net of focused sunlight on a bed under water (§11).
//
// The definitions. Emitted only where `caustics` is asked for, which is the
// fragment patch and the one vertex-patched material that is ever a lake bed --
// see patch(). Either way it is the TERRAIN, because the terrain is the bed.
// Rocks and props take the murk and the darkening like everything else and
// simply do not catch the net; the alternative is a third varying on every
// material in the world to light the six per cent of them that are ever under a
// lake.
//
// WHY THIS IS NOT THE WATER'S OWN WAVE FIELD, which would be the physical
// answer and was the first instinct. Caustics are the SECOND derivative of the
// surface -- the convergence of the refracted rays, not their direction -- and
// water.js's field is built to hand back a normal, i.e. the first. Getting the
// focus out of it means differentiating it again, which is four more noise
// evaluations per pixel for a pattern nobody can check: the bed is a couple of
// metres under a rippling ceiling she is not looking at while she looks at it.
// So this is its own field, and the honest claim for it is that it moves like
// caustics rather than that it is caustics.
//
// The shape, which is where the look comes from and is worth spelling out: a
// ridge, 1 - |2n - 1|, turns a smooth noise field into thin bright LINES along
// its half-level -- filaments, not blobs, which is the whole visual signature.
// Two of them, at different scales and drifting different ways, multiply to a
// net that crosses and uncrosses instead of sliding rigidly past. The power
// then thins the filaments and darkens everything between them, so the result
// is mostly black with sharp bright threads in it rather than a grey wash --
// which is what makes it read as light being focused rather than as a texture.
const CAUSTIC_DEFS = /* glsl */ `
  uniform vec4 uCaustic; // gain, 1/metres, surface y, 1/fade metres
  uniform float uCausticT;

  float wlCHash( vec2 c ) {
    vec3 p3 = fract( vec3( c.x, c.y, c.x ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }

  float wlCNoise( vec2 p ) {
    vec2 i = floor( p );
    vec2 f = p - i;
    // Smoothstep rather than the quintic the wave field uses: nothing here
    // differentiates the result, and the quintic's only advantage is a
    // continuous second derivative.
    vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( wlCHash( i ), wlCHash( i + vec2( 1.0, 0.0 ) ), u.x ),
                mix( wlCHash( i + vec2( 0.0, 1.0 ) ), wlCHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
  }

  // THE DRIFT RATES ARE IN CELLS PER SECOND, not metres per second, because p
  // arrives already divided by uCaustic.y -- so at a 1.6 m cell the first layer
  // crosses about 115 cm of bed a second. Eight times the first pass, which read
  // as a slow slide rather than as waves: the eye reads a caustic net as MOVING
  // WATER only when the threads reorganise at roughly the rate ripples cross,
  // and a net that drifts more slowly than that reads as a projected texture on
  // a floor. The two layers stay at their own rates and their own headings --
  // what makes it look alive is them shearing past each other, and scaling both
  // by one number keeps that shear intact while speeding it up.
  //
  // The ceiling on this is the noise field's own cell, not taste: once a layer
  // crosses more than about one cell per second the net stops reorganising and
  // starts SLIDING as a rigid pattern, because the eye can follow an individual
  // thread across the screen. The first layer is at 0.72 of a cell a second, so
  // there is one more doubling in this before it goes.
  float wlCaustic( vec2 p, float t ) {
    vec2 a = p + vec2( 0.72, 0.40 ) * t;
    vec2 b = p * 1.63 - vec2( 0.56, 0.88 ) * t;
    float ra = 1.0 - abs( wlCNoise( a ) * 2.0 - 1.0 );
    float rb = 1.0 - abs( wlCNoise( b ) * 2.0 - 1.0 );
    float net = ra * rb;
    net *= net;
    return net * net * net;
  }
`

// Where the net is applied, at the top of the fog slot and therefore in OUTPUT
// space -- three orders `<colorspace_fragment>` before `<fog_fragment>`, which
// is the same reason uAirNear and uAirFar are raw sRGB. Additive light after
// tone mapping is not where a physical model would put it, and here that is the
// right trade twice: the threads survive intact instead of being rolled off by
// the shoulder exactly where they are brightest, and they are still added
// BEFORE the aerial mix below, so a bed twenty metres away loses its caustics
// to the murk along with everything else rather than glowing through it.
//
// The branch is on a uniform, so every fragment in the draw takes the same side
// of it and it costs nothing while she is dry. `wlDepth > 0.0` is what keeps
// the net off the bank: ground above the surface is lit by the same sun through
// no water at all.
const CAUSTIC_APPLY = (worldPos) => /* glsl */ `
  if ( uCaustic.x > 0.0 ) {
    float wlDepth = uCaustic.z - ${worldPos}.y;
    if ( wlDepth > 0.0 ) {
      // Facing up, in world terms. THREE's own 'normal' is view-space here, and
      // vec4 * mat is the transpose product, which for the rotation part of a
      // view matrix is its inverse -- the cheap way back out to world without
      // uploading a second matrix. Squared, so a wall catches a little and a
      // ledge catches most, with no edge between them.
      vec3 wlCN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
      float wlUp = clamp( wlCN.y, 0.0, 1.0 );
      // Depth fade. Light that has come this far down has already been scattered
      // out of a beam and into a glow, so the net dissolves rather than dims:
      // by two fade lengths there is nothing left to focus.
      float wlFade = exp( - wlDepth * uCaustic.w );
      gl_FragColor.rgb += uCaustic.x * wlUp * wlUp * wlFade
        * wlCaustic( ${worldPos}.xz * uCaustic.y, uCausticT );
    }
  }
`

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

// LAMPS: the village's flames after dark (§30, render/lamps.js), a third
// compile-time axis so the overworld pays nothing for them.
//
// Not point lights. Every lit material in the world shares one program, and a
// loop over twenty lamps in it is twenty distances per vertex of every tree in
// the wood and per FRAGMENT of the ground, on a Quest 2. The lamps' light is
// instead BAKED once into a map over the room's plan when the room boots -- the
// sum of each lamp's falloff, one fetch per vertex or fragment -- and the
// shader reads it like it reads the horizon map. Three channels carry three
// groups of lamps so uLampGlow can flicker them out of step; the alpha carries
// the flames' height, so a roof ten metres over a lamp stays dark and the
// hut wall beside it does not. The light multiplies the surface's own colour,
// which is what makes it read as a flame's light and not as the night lift.
// Metres above or below a flame at which its light on a surface has gone.
const LAMP_TALL = 7
const LAMP_GLSL = /* glsl */ `
  uniform sampler2D uLampMap;
  // x, z of the map's corner and the reciprocal of its size, metres.
  uniform vec4 uLampRect;
  // The flames' height range the alpha spans: base and span, metres.
  uniform vec2 uLampY;
  // Linear, the flame's colour at full glow.
  uniform vec3 uLampColor;
  // Each group's glow this frame: 0 by day, the flicker by night.
  uniform vec3 uLampGlow;

  vec3 wlLamp( vec3 p ) {
    vec2 uv = ( p.xz - uLampRect.xy ) * uLampRect.zw;
    vec4 s = texture2D( uLampMap, uv );
    float tall = 1.0 - smoothstep( 0.0, ${LAMP_TALL.toFixed(1)}, abs( p.y - uLampY.x - s.a * uLampY.y ) );
    return uLampColor * ( dot( s.rgb, uLampGlow ) * tall );
  }
`

// TORCHES are the one dynamic light: up to TORCHES of them, each a point that moves, so they are uniforms and not the lamp map's bake. Like a lamp's the light multiplies the surface's own colour and ignores its normal; it fades to nothing at its slot's reach (TORCH_REACH for a torch), as the square of the distance left. A slot with no strength is skipped, so a world with none lit pays only the loop's test.
export const TORCHES = 4
export const TORCH_REACH = 15
const TORCH_GLSL = /* glsl */ `
  // xyz the flame, w its strength (0 = out).
  uniform vec4 uTorch[${TORCHES}];
  // 1 / each slot's reach, metres.
  uniform float uTorchInvReach[${TORCHES}];
  uniform vec3 uTorchColor;

  vec3 wlTorch( vec3 p ) {
    vec3 sum = vec3( 0.0 );
    for ( int i = 0; i < ${TORCHES}; i++ ) {
      float s = uTorch[ i ].w;
      if ( s <= 0.0 ) continue;
      float k = clamp( 1.0 - length( p - uTorch[ i ].xyz ) * uTorchInvReach[ i ], 0.0, 1.0 );
      sum += uTorchColor * ( s * k * k );
    }
    return sum;
  }
`

export class WorldLighting {
  constructor() {
    this.ready = false
    // Whether the patch emits anything at all. See the two axes in the header.
    this.enabled = true
    // THE MATERIALS, held as hard references for the reason material.js's
    // windMaterials are: a uniform reaches every program for free, a PROGRAM
    // change reaches none of them -- three only recompiles a material whose
    // needsUpdate is set, and these are built in a dozen different modules.
    // Bounded by the number of lit materials in the world, and nothing else
    // keeps them alive at the moment we need to walk them, so a WeakSet would
    // be wrong.
    this.materials = new Set()

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
      // linear here would put the two halves of one lerp in two spaces -- which
      // is exactly what a render into a LINEAR target does; see airToLinear.
      uAirNear: { value: new THREE.Vector3(0, 0, 0) },
      // The far end of it, in the same raw-sRGB terms and for the same reason.
      // Not fogColor but fogColor under AIR_CEILING -- see the note there.
      uAirFar: { value: new THREE.Vector3(0, 0, 0) },
      // The caustic net: gain, 1/metres of feature size, the water's surface y,
      // and 1/metres of depth fade. A gain of zero is OFF and is the resting
      // state -- there is no separate enable, because a second flag saying the
      // same thing as a zero is a second thing to leave set.
      uCaustic: { value: new THREE.Vector4(0, 0.5, 0, 1 / 6) },
      // Its own clock rather than a share of anything else's. Seconds, and it
      // is fed the same wrapped value the props run on, for the same reason:
      // a float that has been counting since page load loses its low bits by
      // the time anyone has walked anywhere.
      uCausticT: { value: 0 },
      // The lamp map and its frame (LAMP_GLSL); null and inert in the overworld.
      uLampMap: { value: null },
      uLampRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uLampY: { value: new THREE.Vector2(0, 1) },
      uLampColor: { value: new THREE.Color(0, 0, 0) },
      uLampGlow: { value: new THREE.Vector3(0, 0, 0) },
      // The torches (TORCH_GLSL): each a point, a strength and a reach, and the warm colour they share, linear.
      uTorch: { value: Array.from({ length: TORCHES }, () => new THREE.Vector4(0, 0, 0, 0)) },
      uTorchInvReach: { value: new Float32Array(TORCHES).fill(1 / TORCH_REACH) },
      uTorchColor: { value: new THREE.Color(1.0, 0.42, 0.12) },
      // Each town hearth's baked glow strength (hearth-light.js), read only by a patch with `hearths`.
      uHearthFar: { value: new Float32Array(HEARTHS) },
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
    // The maps are a COMPILE-TIME axis, so their arrival is a recompile rather
    // than an upload -- see the header. One hitch, on the frame Phase A lands.
    this.recompile()
  }

  /**
   * The lamps' light is in every lit material from here until clearLamps:
   * `map` over the plan from (x0, z0) `w` by `h` metres, its alpha spanning
   * flame heights y0 to y0 + span, at `color` (linear). A recompile.
   */
  setLamps(map, { x0, z0, w, h, y0, span, color }) {
    if (!map || !map.isTexture) throw new Error('setLamps: needs the lamp map texture')
    if (![x0, z0, w, h, y0, span].every(Number.isFinite) || !(w > 0 && h > 0 && span > 0)) throw new Error('setLamps: bad frame')
    this.uniforms.uLampMap.value = map
    this.uniforms.uLampRect.value.set(x0, z0, 1 / w, 1 / h)
    this.uniforms.uLampY.value.set(y0, span)
    this.uniforms.uLampColor.value.copy(color)
    this.recompile()
  }

  /** The torches' light this frame: up to TORCHES of `{ x, y, z, strength, reach }`, the rest put out. Not a recompile. */
  setTorches(list) {
    const slots = this.uniforms.uTorch.value, inv = this.uniforms.uTorchInvReach.value
    for (let i = 0; i < TORCHES; i++) {
      const t = list[i]
      if (!t) { slots[i].w = 0; continue }
      if (!(t.reach > 0)) throw new Error(`setTorches: slot ${i} needs a reach, got ${t.reach}`)
      slots[i].set(t.x, t.y, t.z, t.strength)
      inv[i] = 1 / t.reach
    }
  }

  clearLamps() {
    if (this.uniforms.uLampMap.value === null) return
    this.uniforms.uLampMap.value = null
    this.uniforms.uLampGlow.value.set(0, 0, 0)
    this.recompile()
  }

  /**
   * Compile this whole system in or out of every material it has patched.
   *
   * Off is stock Lambert with stock fog: no shadow or occlusion lookup, no
   * night lift, no near-field envelope, no aerial ramp, no caustics. The lights
   * themselves are not ours -- the host owns whether the sun and hemi still
   * hear about the hour, and has to say so separately.
   *
   * Costs a shader recompile per material on the frame it is called, which on a
   * headset is one visible hitch and is the price of the measurement.
   */
  setEnabled(on) {
    if (typeof on !== 'boolean') throw new Error(`setEnabled: need a boolean, got ${on}`)
    if (on === this.enabled) return
    this.enabled = on
    this.recompile()
  }

  // The compile-time axes, as three's program cache sees them. Composed
  // into every patched material's customProgramCacheKey, or a recompile would
  // find the program the other variant already built and hand that back --
  // which is how the wind switch once measured "no difference". See patch().
  variantKey() {
    if (!this.enabled) return 'wl-off'
    return `${this.ready ? 'wl-maps' : 'wl-flat'}${this.uniforms.uLampMap.value ? '-lamps' : ''}`
  }

  recompile() {
    for (const material of this.materials) material.needsUpdate = true
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
    _airLin.multiply(airCeiling(state.cover, _ceil))
    _airLin.getRGB(_airOut, THREE.SRGBColorSpace)
    this.uniforms.uAirFar.value.set(_airOut.r, _airOut.g, _airOut.b)
  }

  /**
   * Replace the air with something that is not air -- today, the water she is
   * standing in (§11). Both ends of the aerial ramp go to one colour, which is
   * what collapses a model built for kilometres of atmosphere into a medium
   * you cannot see twenty metres through: with the two ends equal, the
   * in-scatter ramp has nowhere to go and only the extinction term is left.
   *
   * `air` is a Vector3 of RAW sRGB COMPONENTS, in the same terms uAirNear and
   * uAirFar are declared in and for the same reason -- the mix it feeds runs
   * after colorspace_fragment. Handing it linear values gives a murk that is
   * too dark by exactly one gamma curve, which looks like a tuning problem and
   * is not one.
   *
   * MUST BE CALLED AFTER `update` IN THE SAME FRAME, and it holds for one frame
   * only. This is a later writer over the two uniforms update() sets from the
   * palette, not a mode with state of its own -- so stopping calling it is all
   * that surfacing takes, and there is no flag that can be left set.
   */
  setAir(air) {
    this.uniforms.uAirNear.value.copy(air)
    this.uniforms.uAirFar.value.copy(air)
  }

  /**
   * THE RAMP ENDS ARE OUTPUT-SPACE COLOURS, and a render into a linear target
   * has no output encoding: colorspace_fragment compiles to nothing there, so
   * the aerial mix runs on LINEAR surface colour against ends that are still
   * sRGB -- roughly twice too bright, read as linear. Every distant ridge in
   * such a capture comes back with its haze encoded twice over once the reader
   * encodes it for the screen: pale and washed out, and the water mirrors
   * exactly that. three makes this switch for its own fogColor on every draw
   * (getUnlitUniformColorSpace); this is the same switch for the two uniforms
   * the patch added. Bracket a capture with the pair. A frame drawn to the
   * canvas never calls either, and a second airToLinear before the airToOutput
   * would linearise linear, so the two must strictly alternate.
   */
  airToLinear() {
    const near = this.uniforms.uAirNear.value
    const far = this.uniforms.uAirFar.value
    _airSavedNear.copy(near)
    _airSavedFar.copy(far)
    _airLin.setRGB(near.x, near.y, near.z, THREE.SRGBColorSpace)
    near.set(_airLin.r, _airLin.g, _airLin.b)
    _airLin.setRGB(far.x, far.y, far.z, THREE.SRGBColorSpace)
    far.set(_airLin.r, _airLin.g, _airLin.b)
  }

  airToOutput() {
    this.uniforms.uAirNear.value.copy(_airSavedNear)
    this.uniforms.uAirFar.value.copy(_airSavedFar)
  }

  /**
   * The caustic net on the bed (§11). `gain` of 0 turns it off, which is the
   * resting state and the only off there is.
   *
   * `surfaceY` is the WATER's elevation, not the eye's: the shader shades a
   * point on the ground and needs to know how much water is stacked over THAT
   * point. Passing the eye instead gives a net that brightens and dims as she
   * swims up and down, which is backwards -- the bed does not care where she is.
   *
   * Written every frame she is under, like setAir, and for the same reason: a
   * later writer with no state beats a mode with an off switch that can be
   * missed. `t` is seconds, already wrapped.
   */
  setCaustic(gain, scale, surfaceY, fade, t) {
    if (!(fade > 0)) throw new Error(`setCaustic: fade must be > 0 metres, got ${fade}`)
    if (!(scale > 0)) throw new Error(`setCaustic: scale must be > 0 metres, got ${scale}`)
    this.uniforms.uCaustic.value.set(gain, 1 / scale, surfaceY, 1 / fade)
    this.uniforms.uCausticT.value = t
  }

  /**
   * Patch a MeshLambertMaterial (or a MeshPhongMaterial -- same chunks, and its
   * specular takes the sun's shadow too) to be shadowed and occluded by the terrain.
   *
   * `mode` is 'fragment' for the terrain and 'vertex' for everything else --
   * see the header for why the two exist.
   *
   * `worldPosVarying` lets a material that ALREADY carries a world-position
   * varying reuse it instead of declaring a second one; terrain-material.js
   * has had `vWorldPos` since the surface grain was written.
   *
   * `cacheKey` must be distinct per compiled source, because three keys its
   * program cache on it and two differently-patched Lamberts would otherwise
   * share a compiled program. Materials whose source is identical (the same
   * patch over the same base, differing by a map) SHOULD share one, so their
   * calls switch material and not program.
   *
   * `caustics` is whether the net on a lake bed is compiled in at all, and it
   * defaults to the fragment path because that path already has a world
   * position per pixel and pays nothing extra for it. A VERTEX patch that asks
   * for it declares a vec3 varying that nothing else in this file needs, so it
   * is a second program rather than a second uniform: the caller compiles one
   * material with it and one without, and hands the wet one to the mesh only
   * while she is in the water. See v2/main.js's plain terrain rung, which is
   * how the shipping ground gets caustics without carrying the varying across
   * every hillside in the world.
   *
   * IT IS COMPOSED WITH WHATEVER KEY THE MATERIAL ALREADY HAD, not substituted
   * for it, and that is not tidiness. createPropMaterial builds a key that
   * varies with the things it compiles in and out -- billboard layers, strip
   * tiling, and whether the wind block is present at all (setWindEnabled).
   * Replacing that key pins the material to ONE entry in three's program cache,
   * so `material.needsUpdate = true` re-runs onBeforeCompile, three looks the
   * result up under the unchanged key, finds the program it compiled the first
   * time and hands that back. The new source is never compiled and the toggle
   * silently does nothing -- which is exactly how the menu's wind switch came
   * to read "no difference" on a headset. variantKey() rides in the same key
   * for the same reason: this file's own two axes are three programs.
   */
  patch(material, { mode, cacheKey, worldPosVarying = null, caustics = mode === 'fragment', liftAlbedo = null, hearths = false }) {
    if (mode !== 'fragment' && mode !== 'vertex') throw new Error(`patch: bad mode ${mode}`)
    // The baked glow rides a per-vertex `hearth` attribute only the terrain carries.
    if (hearths && mode !== 'vertex') throw new Error('patch: hearths needs vertex mode')
    // vec4-packed: a float[] may take a whole vector slot per element, and HEARTHS of those would crowd the vertex stage's uniform budget.
    const hearthDecl = hearths ? `\nattribute float hearth;\nuniform vec4 uHearthFar[${HEARTHS / 4}];` : ''
    // Per material, and on userData so a console can tune it live.
    const liftU = liftAlbedo && { value: new THREE.Vector2(liftAlbedo.mix, liftAlbedo.gain) }
    if (liftU) material.userData.wlLiftAlbedo = liftU
    const liftDecl = liftU ? '\nuniform vec2 uLiftAlbedo;' : ''

    const prev = material.onBeforeCompile
    const self = this
    this.materials.add(material)
    // Hard references, so the registry has to be told when one dies or a
    // session spent cycling grass styles accumulates a disposed material per
    // press -- buildGrass tears the whole bed down and patches a fresh one.
    // three's Material dispatches this from dispose(), so no caller owes us
    // anything.
    material.addEventListener('dispose', () => self.materials.delete(material))

    material.onBeforeCompile = (shader, renderer) => {
      // Chained, not replaced. Every material this is applied to already has an
      // onBeforeCompile doing its own job -- the prop atlas, the terrain grain
      // -- and silently dropping it would remove the textures from every tree
      // in the world.
      if (prev) prev.call(material, shader, renderer)
      // Read here and not captured at patch() time, so a material built before
      // the first flip still compiles the current state.
      if (!self.enabled) return
      Object.assign(shader.uniforms, self.uniforms)
      if (liftU) shader.uniforms.uLiftAlbedo = liftU

      // The horizon axis, spelled out once for both stages: with no maps the
      // two lookups ARE the constant 1.0, so they are folded in as one and
      // nothing that would have sampled them is emitted.
      const maps = self.ready
      // The lamp axis: the fragment path reads the map where it stands, the
      // vertex path reads it per vertex and carries the light across.
      const lamps = self.uniforms.uLampMap.value !== null

      if (mode === 'fragment') {
        if (!worldPosVarying) throw new Error('patch: fragment mode needs worldPosVarying')
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${maps ? `${SAMPLE_GLSL}\n` : ''}${NIGHT_GLSL}${liftDecl}\n${caustics ? CAUSTIC_DEFS : ''}${lamps ? LAMP_GLSL : ''}${TORCH_GLSL}`)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            ${APPLY(
              maps ? `wlSun( ${worldPosVarying}.xz )` : '1.0',
              maps ? `wlSky( ${worldPosVarying}.xz )` : '1.0',
              NEAR_GLSL(`${worldPosVarying}.xyz`),
              liftU
            )}
            ${lamps ? `reflectedLight.directDiffuse += diffuseColor.rgb * wlLamp( ${worldPosVarying}.xyz );` : ''}
            reflectedLight.directDiffuse += diffuseColor.rgb * wlTorch( ${worldPosVarying}.xyz );`
          )
          // Caustics ahead of the aerial mix, in the same slot, so the murk
          // gets the last word on a bed at range.
          .replace(
            '#include <fog_fragment>',
            caustics ? `${CAUSTIC_APPLY(worldPosVarying)}\n${AERIAL_GLSL}` : AERIAL_GLSL
          )
      } else {
        // A vec3 of (sun, sky, near) when there are maps to sample, a bare
        // float of `near` when there are not -- the point of the unready build
        // is that the other two components are interpolated constants, and a
        // varying is paid for at every vertex in the forest.
        const varying = maps ? 'varying vec3 vWlShade;' : 'varying float vWlNear;'
        // The bed's world position, carried across ONLY for a wet build. This
        // is the varying the note above CAUSTIC_DEFS refuses to put on every
        // material in the world, so it is here on exactly one of them and only
        // in the program she is under water for.
        const bed = caustics ? '\nvarying vec3 vWlBed;' : ''
        // The lamps' light at the vertex, a varying only while a room has lamps.
        const lamp = (lamps ? '\nvarying vec3 vWlLamp;' : '') + '\nvarying vec3 vWlTorch;'
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${maps ? `${SAMPLE_GLSL}\n` : ''}${varying}${bed}${lamp}${lamps ? LAMP_GLSL : ''}${TORCH_GLSL}${hearthDecl}`)
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            ${WORLD_POS_GLSL}
            ${maps
              ? `vWlShade = vec3( wlSun( wlWorld.xz ), wlSky( wlWorld.xz ),
                             ${NEAR_GLSL('wlWorld')} );`
              : `vWlNear = ${NEAR_GLSL('wlWorld')};`}
            ${caustics ? 'vWlBed = wlWorld;' : ''}
            ${lamps ? 'vWlLamp = wlLamp( wlWorld );' : ''}
            vWlTorch = wlTorch( wlWorld );
            ${hearths ? 'int wlHi = int( hearth ); vWlTorch += uTorchColor * ( fract( hearth ) * uHearthFar[ wlHi / 4 ][ wlHi % 4 ] );' : ''}`
          )
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${varying}${bed}${lamp}\n${NIGHT_GLSL}${liftDecl}\n${caustics ? CAUSTIC_DEFS : ''}`)
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            ${APPLY(
              maps ? 'vWlShade.x' : '1.0',
              maps ? 'vWlShade.y' : '1.0',
              maps ? 'vWlShade.z' : 'vWlNear',
              liftU
            )}
            ${lamps ? 'reflectedLight.directDiffuse += diffuseColor.rgb * vWlLamp;' : ''}
            reflectedLight.directDiffuse += diffuseColor.rgb * vWlTorch;`
          )
          // Same slot and same order as the fragment path: the net goes on
          // before the murk gets the last word.
          .replace('#include <fog_fragment>', caustics ? `${CAUSTIC_APPLY('vWlBed')}\n${AERIAL_GLSL}` : AERIAL_GLSL)
      }
    }

    const prevKey = material.customProgramCacheKey
    material.customProgramCacheKey = () => `${cacheKey}|${self.variantKey()}|${prevKey.call(material)}`
    return material
  }

  dispose() {
    if (this.horizonTex) this.horizonTex.dispose()
    if (this.skyTex) this.skyTex.dispose()
  }
}
