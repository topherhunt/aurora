import THREE from './three-instance.js'
import { MOON } from './clock.js'
import { AIR_FALL, airCeiling } from './lighting.js'

// ---------------------------------------------------------------------------
// The sky, as a function of direction -- shared by the dome that draws it and
// the water that reflects it.
//
// WHY THIS FILE EXISTS. sky.js computes the sky analytically from a world-space
// ray: gradient, horizon glow, sun disc, moon with a real terminator. Water that
// mirrors the sky needs exactly that answer along the REFLECTED ray. There are
// three ways to get it and only one of them is right:
//
//   - Render the sky to a cubemap each frame. A second full pass, six faces,
//     and an 8-bit round trip that bands the night gradient badly (the reason
//     the dome is not a cubemap in the first place -- see sky.js).
//   - Copy the gradient maths into water.js. Free today, wrong within a month:
//     this project's most-documented failure mode is exactly two constants that
//     drift apart under one name. A sunset where the lake is still blue is the
//     kind of thing nobody notices until it is a week old.
//   - Call the same function. One implementation, no extra pass, and the
//     reflection is correct at every time of day for free -- including sunset,
//     the moon's phase, and whatever the day-night cycle does next.
//
// So the shader body lives here and both consumers include it. Neither owns it.
//
// THE UNIFORMS ARE SHARED BY REFERENCE, the same trick lighting.js uses and for
// the same reason: `Sky` writes them once per frame and the water's material
// sees the new values with no per-material update loop to fall out of step.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180

/**
 * The cloud layer's own block (§10), what CLOUD_GLSL reads: the stars and the
 * aurora take the sky's by reference so that one cloud hides all three. The
 * texture is public/world/clouds.png, handed in by Sky.setClouds; until then,
 * and while the debug row has clouds off, uCloud.w is 0 and every shader skips
 * the fetches. x = cover, y/z = the coverage remap's lo/hi, w = on.
 */
export function makeCloudUniforms() {
  return {
    uClouds: { value: null },
    uCloud: { value: new THREE.Vector4(0, 1, 1.3, 0) },
    uCloudDrift: { value: new THREE.Vector2(0, 0) },
  }
}

/**
 * The uniform block the GLSL below reads. Created once by `Sky` and handed to
 * anything else that needs to evaluate the sky; see writeSkyUniforms for the
 * single writer.
 *
 * NOT convertSRGBToLinear'd on the way in. three's ColorManagement is on by
 * default and `Color.setRGB(r,g,b,SRGBColorSpace)` already stores linear
 * working-space values, so converting again would square the transfer curve and
 * land everything at roughly a third of its intended brightness -- a navy sky
 * at noon.
 */
export function makeSkyUniforms() {
  return {
    uHorizon: { value: new THREE.Color(0x9db4cf) },
    uZenith: { value: new THREE.Color(0x1f56ad) },
    uGlow: { value: new THREE.Color(0xffe6bd) },
    uGlowAmt: { value: 0.1 },
    uGlowSharp: { value: 5 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunFade: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    // x = cos(angular radius), y = brightness, z = cos(phase angle).
    uMoon: { value: new THREE.Vector3(0.9997, 0, -0.6) },
    // Illumination axis on the moon's disc, world space. Built on the CPU: it
    // is two cross products and a normalise per frame, and doing it per fragment
    // would be the same arithmetic a million times over for an answer that is
    // constant across the whole disc.
    uMoonU: { value: new THREE.Vector3(1, 0, 0) },
    uMoonV: { value: new THREE.Vector3(0, 1, 0) },
    ...makeCloudUniforms(),
    uCloudLit: { value: new THREE.Color(1, 1, 1) },
    uCloudShade: { value: new THREE.Color(0.4, 0.45, 0.5) },
    // The haze the sky is seen through (§10): x = hazeDensity, the terrain's
    // extinction coefficient, y = SKY_HAZE_M, and the two ends of the sky's
    // aerial ramp, in LINEAR space here because skyRadiance runs before the
    // caller's colorspace_fragment.
    uSkyHaze: { value: new THREE.Vector2(0, SKY_HAZE_M) },
    uSkyAirNear: { value: new THREE.Color(0, 0, 0) },
    uSkyAirFar: { value: new THREE.Color(0, 0, 0) },
  }
}

// The haze's depth, as the sky sees it. A view ray at elevation e crosses
// SKY_HAZE_M / sin(e) metres of the air the terrain is fogged by, and the sky
// at that elevation is treated as a ridge at that distance: the same
// extinction, the same in-scatter ramp, so under rain the horizon goes the way
// the land in front of it went, long before the zenith does. 30 m: on a clear
// day (density 0.00113) that is 35% fog at 3 deg, 10% at 6 deg and 1% at 20
// deg, so a far range still stands dark against the sky over it; under rain
// (0.0042) 100% at 3 deg, 76% at 6 deg, 41% at 10 deg and 2% overhead, so the
// clouds stay readable straight up while the land loses its horizon. Under a
// ceiling the whole sky is near the fog's grey anyway, so the number is
// really the width of a clear day's horizon band. The ramp's near end
// is the fog, not lighting.js's near haze: that haze is the shadow blue a
// near ridge takes on a clear day, and a clear sky is brightest at the
// horizon, not darkest. Under cover the palette takes the haze to the fog
// anyway, which is what lets the two meet in the rain.
export const SKY_HAZE_M = 30

// The remap that turns one texture into every sky from a few puffs to a
// ceiling: density = smoothstep(lo, hi, tex). At cover 0 nothing in the texture
// clears lo; at cover 1 nearly all of it does.
export function cloudRemap(cover) {
  const lo = 1.0 - 0.9 * cover
  return [lo, lo + 0.3]
}

// Texture tiles per in-world hour along the wind. 0.08 of a 6 km tile is about
// 480 m per real minute, a slow visible drift overhead; the wreaths take the
// same metres so the two clouds agree about the wind.
const CLOUD_DRIFT = 0.08
export const CLOUD_DRIFT_M = CLOUD_DRIFT * 6000

const SUN_TMP = new THREE.Vector3()
const MOON_TMP = new THREE.Vector3()
const CEIL_TMP = new THREE.Color()

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * The ONLY writer of the block above. Called once per frame by `Sky`; the water
 * reads the same objects and never writes them.
 */
export function writeSkyUniforms(u, state) {
  u.uHorizon.value.setRGB(state.horizon[0], state.horizon[1], state.horizon[2], THREE.SRGBColorSpace)
  u.uZenith.value.setRGB(state.zenith[0], state.zenith[1], state.zenith[2], THREE.SRGBColorSpace)
  u.uGlow.value.setRGB(state.glow[0], state.glow[1], state.glow[2], THREE.SRGBColorSpace)
  u.uGlowAmt.value = state.glowAmt
  u.uGlowSharp.value = state.glowSharp

  u.uSunDir.value.set(state.sun.x, state.sun.y, state.sun.z)
  // The disc lingers a little past geometric sunset before going, matching the
  // refraction that makes the real sun visibly sit on the horizon after it has
  // technically set, then fades out over the next couple of degrees.
  u.uSunFade.value = smoothstep(-0.055, 0.004, state.sun.y)

  const moonDir = MOON_TMP.set(state.moon.x, state.moon.y, state.moon.z)
  u.uMoonDir.value.copy(moonDir)
  u.uMoon.value.set(
    Math.cos(MOON.radiusDeg * DEG),
    // Fades in as the sky darkens (state.moonBright) and out as the moon sets.
    // A moon still drawn at full strength against a bright afternoon sky is the
    // single most common tell in a game day-night cycle.
    state.moonBright * smoothstep(-0.06, 0.03, state.moon.y),
    2 * state.moonLit - 1
  )

  // Illumination axis: the sun direction with the moon direction projected out
  // of it, i.e. which way "toward the sun" points once flattened onto the moon's
  // disc. Degenerate only if the sun is exactly at or opposite the moon -- a
  // total eclipse either way -- so fall back to any perpendicular.
  const s = SUN_TMP.set(state.sun.x, state.sun.y, state.sun.z)
  s.addScaledVector(moonDir, -s.dot(moonDir))
  if (s.lengthSq() < 1e-8) s.set(moonDir.z, 0, -moonDir.x)
  s.normalize()
  u.uMoonU.value.copy(s)
  u.uMoonV.value.crossVectors(moonDir, s).normalize()

  // Clouds. Driven by in-world time and the room's wind, so every peer's sky
  // drifts in step. The colours come off the palette so the layer is right at
  // every hour with no table of its own: lit faces a quarter above the horizon
  // colour (near white by day, peach at sunset, near black at night), bellies
  // a dimmed mean of horizon and zenith, which is what keeps a sunset belly
  // grey-mauve rather than brown.
  const [lo, hi] = cloudRemap(state.cover)
  u.uCloud.value.set(state.cover, lo, hi, u.uCloud.value.w)
  u.uCloudDrift.value.set(state.wind[0] * state.elapsed * CLOUD_DRIFT, state.wind[1] * state.elapsed * CLOUD_DRIFT)
  const h = state.horizon, z = state.zenith
  u.uCloudLit.value.setRGB(Math.min(1, h[0] * 1.25), Math.min(1, h[1] * 1.25), Math.min(1, h[2] * 1.25), THREE.SRGBColorSpace)
  u.uCloudShade.value.setRGB((h[0] + z[0]) * 0.35, (h[1] + z[1]) * 0.35, (h[2] + z[2]) * 0.35, THREE.SRGBColorSpace)

  // The haze: from the fog to the fog under lighting.js's ceiling, which is
  // where its ramp ends for the land, so a fully fogged ridge and the sky
  // above it land on one colour.
  u.uSkyHaze.value.x = state.hazeDensity
  u.uSkyAirNear.value.setRGB(state.fog[0], state.fog[1], state.fog[2], THREE.SRGBColorSpace)
  u.uSkyAirFar.value.copy(u.uSkyAirNear.value).multiply(airCeiling(state.cover, CEIL_TMP))
}

// ---------------------------------------------------------------------------
// The shader body. Declares the uniforms above and one function:
//
//   vec3 skyRadiance( vec3 dir, float coreGain )
//
// `dir` is a normalised WORLD-space direction. Linear working space out; the
// caller does its own <colorspace_fragment>.
//
// coreGain gates the two RAZOR-SHARP terms -- the sun's 1.1 deg disc and the
// moon's lit disc -- and nothing else. The dome passes 1.0. The water passes 0.0
// and supplies its own broadened highlight instead, because a disc that spans
// 0.02 of a radian reflected off a rippled surface is sampled at effectively
// random points from one pixel to the next: it does not read as glitter, it
// reads as static, and it crawls when the head moves. Everything smooth -- the
// gradient, the horizon glow, the sun's forward-scatter halo, the moon's
// atmospheric glow -- reflects unchanged, because smooth things survive being
// sampled through a wavy normal.
// ---------------------------------------------------------------------------
// The cloud layer alone (§10): a plane 1500 m up, above every summit, the view
// ray projected onto it and one seamless fBm sampled at two scales that drift
// with the wind. `cloudAt` gives x = how much of the sky that way the cloud
// hides, 0 with clouds off or below the horizon fade, y = the raw density,
// which the dome darkens the bellies from, and zw = the slope of the cloud's
// coarse shape across the plane (world x, z; relative units, from the bake's
// G/B), which the dome lights each cloud's sun side from. Its own chunk so the
// stars and the aurora, drawn before the dome, can be dimmed by the same cloud
// that the dome composites over the sun.
export const CLOUD_GLSL = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec4 uCloud;
  uniform vec2 uCloudDrift;

  vec4 cloudAt( vec3 dir ) {
    if ( uCloud.w < 0.5 || dir.y <= 0.02 ) return vec4( 0.0 );
    vec2 p = dir.xz * ( 1500.0 / dir.y );
    vec3 a = texture2D( uClouds, p / 6000.0 + uCloudDrift ).rgb;
    vec3 b = texture2D( uClouds, p / 2600.0 * vec2( 0.8, 1.1 ) + uCloudDrift * 1.7 + 0.37 ).rgb;
    float tex = a.r * 0.65 + b.r * 0.35;
    float density = smoothstep( uCloud.y, uCloud.z, tex );
    float fade = smoothstep( 0.02, 0.15, dir.y );
    // Chain rule through both samplings, per 2600 m of plane.
    vec2 slope = ( a.gb - 0.5 ) * ( 0.65 * 2600.0 / 6000.0 ) + ( b.gb - 0.5 ) * vec2( 0.8, 1.1 ) * 0.35;
    return vec4( density * fade, tex, slope );
  }
`

export const SKY_GLSL = /* glsl */ `
  ${CLOUD_GLSL}
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uGlow;
  uniform float uGlowAmt;
  uniform float uGlowSharp;
  uniform vec3 uSunDir;
  uniform float uSunFade;
  uniform vec3 uMoonDir;
  uniform vec3 uMoon;
  uniform vec3 uMoonU;
  uniform vec3 uMoonV;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShade;
  uniform vec2 uSkyHaze;
  uniform vec3 uSkyAirNear;
  uniform vec3 uSkyAirFar;

  // The sky with no air in front of it. The water's distance term wants this
  // one: it fades a far lake to the horizon sky under the reflection's dim, and
  // a horizon already fogged would put that lake under the land it mirrors.
  vec3 skyClear( vec3 dir, float coreGain ) {
    // Height above the horizon, 0..1.
    //
    // THIS WAS pow(dir.y, 0.21) AND THE EXPONENT WAS THE BUG. Every pow(x, p)
    // with p < 1 has INFINITE slope at x = 0, so however carefully the colours
    // are matched, the gradient leaves the horizon colour instantaneously:
    // measured against uHorizon 0x9db4cf, half a degree above the horizon was
    // already 128,154,195 against the band below at 157,180,207. A 29-unit step
    // across half a degree reads as a hard line, and it is the line under "below
    // the horizon it is suddenly very light blue, almost white". The colours
    // were never mismatched -- FOG_COLOR and uHorizon are literally the same
    // constant (main.js) -- the DERIVATIVE was.
    //
    // A smoothstep has zero slope at both ends, so the sky now leaves the
    // horizon colour gently and distant fogged terrain melts into it with no
    // seam to find. The trailing linear term keeps a little gradient running all
    // the way to the zenith, so the top of the dome does not flatten into one
    // colour once the smoothstep has saturated.
    //
    // 0.35 is the knee, picked by rendering the ramp as a strip rather than by
    // eye in the headset: it is the widest band that still reads as properly
    // blue by 20 deg. Wider (0.5, 0.65) brings back the washed out lower sky
    // that dropping the old exponent to 0.21 was fixing.
    float t = clamp( dir.y, 0.0, 1.0 );
    float up = smoothstep( 0.0, 0.35, t ) * 0.86 + t * 0.14;
    vec3 col = mix( uHorizon, uZenith, up );

    // ---- Horizon glow.
    //
    // At noon this is a faint warm wash and nobody notices it. At sunset it IS
    // the sunset: the reason the sky is orange in one direction and still blue
    // in the other. A gradient that only varies with height cannot do that -- it
    // would turn the ENTIRE sky orange at once, which is the thing that makes
    // most real-time skies read as fake.
    //
    // Azimuth term: the horizontal angle between the view ray and the sun,
    // sharpened by a power. Height term: an exponential that hugs the horizon,
    // because the glow is scattered light coming through the thickest air. Both
    // are evaluated below the horizon too (dir.y is clamped at 0 for the height
    // term), so the fogged-out far terrain and the sky it sits against stay the
    // same colour.
    vec3 sunHoriz = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
    vec3 dirHoriz = normalize( vec3( dir.x, 0.0, dir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
    float az = max( dot( dirHoriz, sunHoriz ), 0.0 );
    float band = exp( -max( dir.y, 0.0 ) * 4.5 );
    col += uGlow * ( uGlowAmt * pow( az, uGlowSharp ) * band );

    // ---- Sun.
    //
    // Two-part. The core is a small hard disc, about 1.1 deg across -- the real
    // sun is 0.53, but Quest 3 resolves roughly 15 px per degree, so a true-size
    // disc is eight pixels and reads as a speck of dead pixel rather than as the
    // sun. It is deliberately pushed well above 1.0 so it clips to white and
    // reads as something you cannot look at directly. The halo is the wide, weak
    // forward-scatter around it, and it is what actually sells the sun as being
    // IN the atmosphere rather than painted on the inside of it.
    //
    // uSunFade takes both to zero once the sun is properly down. Without it the
    // disc keeps burning through the fogged-out distance long after it has set,
    // since the dome is drawn below the horizon too.
    float sun = dot( dir, uSunDir );
    float core = smoothstep( 0.99985, 0.99995, sun );
    float halo = pow( max( sun, 0.0 ), 1400.0 ) * 0.55
               + pow( max( sun, 0.0 ), 60.0 ) * 0.10;
    vec3 sunTint = mix( vec3( 1.0, 0.55, 0.28 ), vec3( 1.0, 0.96, 0.80 ), uSunFade );
    // Through cloud (§10): the layer below hides the disc on the dome, but the
    // water never draws the layer, so its highlight would still burn under an
    // overcast without this.
    float through = uSunFade * ( 1.0 - uCloud.x * uCloud.x );
    col += sunTint * halo * through;
    col = mix( col, sunTint * 4.0, core * through * coreGain );

    // ---- Moon.
    //
    // The terminator is the real one, not a texture and not a shifted second
    // circle. Work on the disc in units of the moon's radius: (u,v) across it,
    // and z out of it toward the eye, so that (u,v,z) is a point on the unit
    // sphere the moon actually is. It is lit where that point faces the sun.
    //
    // With the illumination axis rotated onto u, the sun direction in this frame
    // is (sin a, 0, cos a) for phase angle a, and the lit test is the plain dot
    // product u*sin a + z*cos a > 0. cos a is uMoon.z, handed down from clock.js
    // where the phase is decided.
    //
    // This is worth doing properly rather than eyeballing, because the horns of
    // a crescent point directly away from the sun and that is a relationship
    // people read without knowing they are reading it. A crescent lit from the
    // wrong side looks wrong immediately even to someone who could not say why.
    float md = dot( dir, uMoonDir );
    if ( coreGain > 0.001 && uMoon.y > 0.001 && md > 0.9 ) {
      // Small-angle: the offset from the moon's centre, projected onto its disc
      // basis, is the angular offset in radians to well within a pixel over a
      // 1.3 deg disc.
      float rad = acos( clamp( uMoon.x, -1.0, 1.0 ) );
      float u = dot( dir, uMoonU ) / rad;
      float v = dot( dir, uMoonV ) / rad;
      float r2 = u * u + v * v;

      // Limb softness of one part in 60 of the radius, so the edge is
      // antialiased rather than stair-stepped -- at 40 px across, a hard circle
      // test crawls with jaggies every time the head moves.
      float disc = 1.0 - smoothstep( 0.97, 1.0, sqrt( r2 ) );
      float c = uMoon.z;
      float z = sqrt( max( 0.0, 1.0 - r2 ) );
      float litTest = u * sqrt( max( 0.0, 1.0 - c * c ) ) + z * c;
      // The terminator is genuinely soft on the real thing -- it crosses
      // mountains at a grazing angle -- and softening it here also hides the
      // aliasing along a curve that can pass very close to vertical.
      float lit = smoothstep( -0.06, 0.06, litTest );

      // Limb darkening, inverted from how a planet works: the moon is
      // notoriously FLAT-looking because its dust backscatters, so the limb
      // stays nearly as bright as the centre. A weak term only.
      float shade = 0.82 + 0.18 * z;

      vec3 moonTint = vec3( 1.0, 0.97, 0.90 );
      col += moonTint * ( disc * lit * shade * 2.2 * uMoon.y * coreGain );
    }

    // A soft glow around the moon regardless of phase: the atmosphere scatters
    // its light the same way it scatters the sun's, and a moon with a knife edge
    // against the sky reads as a sticker. Cheap -- one pow on a dot product
    // already computed. NOT gated by coreGain: it is smooth, so it reflects off
    // rippled water without aliasing, and it is most of what makes a moonlit
    // lake read as moonlit.
    col += vec3( 0.62, 0.70, 0.90 ) * ( pow( max( md, 0.0 ), 900.0 ) * 0.30 * uMoon.y );

    // ---- Clouds (§10, CLOUD_GLSL). Composited over everything above, so a
    // thick cloud hides the sun and the moon and a thin one dims them, with no
    // switch. Behind the coreGain branch so the water, which calls this three
    // times a pixel, pays none of the fetches; under an overcast it goes grey
    // anyway through uHorizon and uZenith. The horizon fade hands the plane's
    // far stretch to the fog, which is eating the terrain there.
    if ( coreGain > 0.5 ) {
      vec4 cl = cloudAt( dir );
      // Bellies darken with thickness past the remap's edge, so a solid ceiling
      // still shows its texture instead of one flat grey; and the layer takes
      // the horizon colour as it recedes, the aerial perspective the terrain
      // gets from lighting.js, so a ceiling meets the fog instead of ending
      // on it.
      //
      // Away from the sun the layer shows more belly, through the shade mix
      // since by day uCloudLit is already near white. Toward the sun or moon
      // it brightens (forward scatter), after the horizon fade: a low sun's
      // clouds are low too, and the fade would eat the glow exactly when it
      // matters. sunUp reaches below the horizon because the afterglow on cloud
      // outlasts the disc uSunFade tracks. The moon's light is added, not
      // scaled, since a night cloud is near black; uMoon.y carries the cover dim.
      float sunUp = smoothstep( -0.12, 0.02, uSunDir.y );
      float sToward = max( sun, 0.0 );
      float mToward = max( md, 0.0 );
      vec3 moonCol = vec3( 0.62, 0.70, 0.90 );
      float thick = smoothstep( uCloud.y, uCloud.z + 0.35, cl.y );
      // Each cloud's own sides: where its shape thins toward the light it is
      // the lit face, where it thickens it is the far one. The light's
      // horizontal component weights it, so a high sun lights tops we never see.
      // By day uCloudLit is clipped white, so the lit face brightens by shedding
      // shade, not by a gain.
      // Faded out below 30 deg up to none at 10: foreshortened toward the
      // horizon, the shape's slope packs into bands that read as corrugation.
      float sideFade = smoothstep( 0.17, 0.5, dir.y );
      float sunSide = clamp( -dot( cl.zw, uSunDir.xz ) * 4.0, -1.0, 1.0 ) * sunUp * sideFade;
      // The moon is up by day too, faintly: its sides only once the sun's are gone.
      float moonSide = clamp( -dot( cl.zw, uMoonDir.xz ) * 4.0, -1.0, 1.0 ) * step( 0.001, uMoon.y ) * ( 1.0 - sunUp ) * sideFade;
      // The away lean scales thickness, so thin edges stay light; a flat add
      // would push whole clouds past full shade into one grey. The soft cap
      // holds the darkest belly under SHADE_MAX with its texture still in it.
      float away = sunUp * max( -sun, 0.0 );
      float shade = max( thick * ( 1.0 + 0.8 * away ) + 0.15 * away - 0.2 * sunSide, 0.0 );
      const float SHADE_MAX = 0.75;
      vec3 cloud = mix( uCloudLit, uCloudShade, SHADE_MAX * ( 1.0 - exp( -shade / SHADE_MAX ) ) );
      cloud = mix( cloud, uHorizon, ( 1.0 - smoothstep( 0.03, 0.45, dir.y ) ) * 0.85 );
      cloud *= 1.0 + 0.45 * sunUp * pow( sToward, 5.0 ) + 0.2 * max( sunSide, 0.0 );
      cloud += sunTint * ( 0.15 * max( sunSide, 0.0 ) * ( 1.0 - thick ) );
      cloud *= 1.0 - 0.2 * max( -moonSide, 0.0 );
      cloud += moonCol * ( uMoon.y * ( ( 1.0 - thick * 0.7 ) * 0.2 * pow( mToward, 8.0 ) + 0.15 * max( moonSide, 0.0 ) ) );
      col = mix( col, cloud, cl.x );
      // The silver lining: thin edges near the light glow brighter than the sky
      // behind them. Added over the composite with sqrt(cl.x), because those
      // edges are where cl.x is smallest and a mix would hand the glow back to
      // the sky. An overcast has no backlit edge, hence the cover term.
      vec3 rim = sunTint * ( sunUp * ( 1.0 - uCloud.x * uCloud.x ) * 0.8 * pow( sToward, 16.0 ) )
               + moonCol * ( uMoon.y * 0.5 * pow( mToward, 40.0 ) );
      col += rim * ( ( 1.0 - thick ) * sqrt( cl.x ) );
    }

    return col;
  }

  // ---- The haze (§10, SKY_HAZE_M). lighting.js's aerial ramp with the
  // ray's path through the haze layer for its depth, so the sun, the clouds
  // and the horizon all go the way a ridge at that depth goes. Below the
  // horizon the depth is fifteen kilometres: the fog the land there became.
  vec3 skyRadiance( vec3 dir, float coreGain ) {
    float hazeL = uSkyHaze.y / max( dir.y, 0.004 );
    float hazeTau = hazeL * uSkyHaze.x;
    vec3 air = mix( uSkyAirNear, uSkyAirFar, 1.0 - exp( - hazeL * ${AIR_FALL.toExponential()} ) );
    return mix( skyClear( dir, coreGain ), air, 1.0 - exp( - hazeTau * hazeTau ) );
  }
`
