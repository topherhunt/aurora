import * as THREE from 'three'
import { MOON } from './clock.js'

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
  }
}

const SUN_TMP = new THREE.Vector3()
const MOON_TMP = new THREE.Vector3()

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
export const SKY_GLSL = /* glsl */ `
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

  vec3 skyRadiance( vec3 dir, float coreGain ) {
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
    col += sunTint * halo * uSunFade;
    col = mix( col, sunTint * 4.0, core * uSunFade * coreGain );

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

    return col;
  }
`
