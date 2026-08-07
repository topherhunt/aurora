import * as THREE from 'three'
import { MOON } from './clock.js'

// ---------------------------------------------------------------------------
// Sky dome: a vertical gradient, a horizon glow that tracks the sun's azimuth,
// the sun disc, and the moon with a real terminator.
//
// What this replaces is `scene.background = FOG_COLOR`, a single flat colour.
// Flat is not merely dull, it actively costs depth: real sky is deep overhead
// and pale at the horizon because you are looking through far more atmosphere
// sideways than up, and that gradient is one of the cues the eye uses to place
// the horizon at infinity. Without it the sky reads as a wall a few hundred
// metres out, which fights the fog doing the opposite job on the terrain.
//
// Drawn as an inverted sphere rather than a cubemap or a fullscreen pass:
//   - No texture, so nothing to author, load, or spend a KTX2 round trip on.
//   - A gradient sampled per-fragment from the view ray has no banding to speak
//     of, where an 8-bit cubemap of a smooth gradient bands badly on a headset.
//   - It costs one draw of 300-odd triangles with no depth write.
//
// The dome follows the camera each frame (see update). It has to: at a 9000 m
// radius inside a 16 km world, walking a kilometre would visibly slide the sun
// across the sky. Following the camera POSITION but not its rotation is what
// makes it read as infinitely far away, and it keeps the sky correctly fixed to
// the world when a snap turn rotates the rig underneath her.
//
// EVERY COLOUR HERE IS A UNIFORM, not a constant. The whole day-night cycle is
// clock.js choosing values and this shader drawing them; there is no second
// "night sky" path, no crossfade between two domes, and no branch on time of
// day anywhere below. That is why sunset works: it is not a special case, it is
// just where the numbers happen to be at 17:40.
// ---------------------------------------------------------------------------

// Comfortably inside the camera's 20000 m far plane, comfortably outside the
// terrain's draw distance so no peak ever pokes through it.
const RADIUS = 9000

const DEG = Math.PI / 180

export class Sky {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // NOT convertSRGBToLinear'd on the way in. three's ColorManagement is
        // on by default and `Color.setRGB(r,g,b,SRGBColorSpace)` already stores
        // linear working-space values, so converting again would square the
        // transfer curve and land everything at roughly a third of its intended
        // brightness -- a navy sky at noon. The shader works in linear and
        // hands off to <colorspace_fragment> for the trip back out.
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
        // Illumination axis on the moon's disc, world space. Built on the CPU:
        // it is two cross products and a normalise per frame, and doing it per
        // fragment would be the same arithmetic a million times over for an
        // answer that is constant across the whole disc.
        uMoonU: { value: new THREE.Vector3(1, 0, 0) },
        uMoonV: { value: new THREE.Vector3(0, 1, 0) },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          // Direction in WORLD space, so the gradient and the sun stay put
          // while the head turns. The dome is never scaled or rotated, so the
          // local position is already the world direction from its centre.
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }
      `,
      fragmentShader: `
        varying vec3 vDir;
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

        void main() {
          vec3 dir = normalize( vDir );

          // Height above the horizon, 0..1.
          //
          // THIS WAS pow(dir.y, 0.21) AND THE EXPONENT WAS THE BUG. Every
          // pow(x, p) with p < 1 has INFINITE slope at x = 0, so however
          // carefully the colours are matched, the gradient leaves the horizon
          // colour instantaneously: measured against uHorizon 0x9db4cf, half a
          // degree above the horizon was already 128,154,195 against the band
          // below at 157,180,207. A 29-unit step across half a degree reads as a
          // hard line, and it is the line under "below the horizon it is
          // suddenly very light blue, almost white". The colours were never
          // mismatched -- FOG_COLOR and uHorizon are literally the same constant
          // (main.js) -- the DERIVATIVE was.
          //
          // A smoothstep has zero slope at both ends, so the sky now leaves the
          // horizon colour gently and distant fogged terrain melts into it with
          // no seam to find. The trailing linear term keeps a little gradient
          // running all the way to the zenith, so the top of the dome does not
          // flatten into one colour once the smoothstep has saturated.
          //
          // 0.35 is the knee, picked by rendering the ramp as a strip rather
          // than by eye in the headset: it is the widest band that still reads
          // as properly blue by 20 deg. Wider (0.5, 0.65) brings back the washed
          // out lower sky that dropping the old exponent to 0.21 was fixing.
          float t = clamp( dir.y, 0.0, 1.0 );
          float up = smoothstep( 0.0, 0.35, t ) * 0.86 + t * 0.14;
          vec3 col = mix( uHorizon, uZenith, up );

          // ---- Horizon glow.
          //
          // At noon this is a faint warm wash and nobody notices it. At sunset
          // it IS the sunset: the reason the sky is orange in one direction and
          // still blue in the other. A gradient that only varies with height
          // cannot do that -- it would turn the ENTIRE sky orange at once,
          // which is the thing that makes most real-time skies read as fake.
          //
          // Azimuth term: the horizontal angle between the view ray and the
          // sun, sharpened by a power. Height term: an exponential that hugs
          // the horizon, because the glow is scattered light coming through the
          // thickest air. Both are evaluated below the horizon too (dir.y is
          // clamped at 0 for the height term), so the fogged-out far terrain
          // and the sky it sits against stay the same colour.
          vec3 sunHoriz = normalize( vec3( uSunDir.x, 0.0, uSunDir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
          vec3 dirHoriz = normalize( vec3( dir.x, 0.0, dir.z ) + vec3( 1e-5, 0.0, 0.0 ) );
          float az = max( dot( dirHoriz, sunHoriz ), 0.0 );
          float band = exp( -max( dir.y, 0.0 ) * 4.5 );
          col += uGlow * ( uGlowAmt * pow( az, uGlowSharp ) * band );

          // ---- Sun.
          //
          // Two-part. The core is a small hard disc, about 1.1 deg across --
          // the real sun is 0.53, but Quest 3 resolves roughly 15 px per
          // degree, so a true-size disc is eight pixels and reads as a speck of
          // dead pixel rather than as the sun. It is deliberately pushed well
          // above 1.0 so it clips to white and reads as something you cannot
          // look at directly. The halo is the wide, weak forward-scatter around
          // it, and it is what actually sells the sun as being IN the
          // atmosphere rather than painted on the inside of it.
          //
          // uSunFade takes both to zero once the sun is properly down. Without
          // it the disc keeps burning through the fogged-out distance long
          // after it has set, since the dome is drawn below the horizon too.
          float sun = dot( dir, uSunDir );
          float core = smoothstep( 0.99985, 0.99995, sun );
          float halo = pow( max( sun, 0.0 ), 1400.0 ) * 0.55
                     + pow( max( sun, 0.0 ), 60.0 ) * 0.10;
          vec3 sunTint = mix( vec3( 1.0, 0.55, 0.28 ), vec3( 1.0, 0.96, 0.80 ), uSunFade );
          col += sunTint * halo * uSunFade;
          col = mix( col, sunTint * 4.0, core * uSunFade );

          // ---- Moon.
          //
          // The terminator is the real one, not a texture and not a shifted
          // second circle. Work on the disc in units of the moon's radius:
          // (u,v) across it, and z out of it toward the eye, so that
          // (u,v,z) is a point on the unit sphere the moon actually is. It is
          // lit where that point faces the sun.
          //
          // With the illumination axis rotated onto u, the sun direction in
          // this frame is (sin a, 0, cos a) for phase angle a, and the lit test
          // is the plain dot product u*sin a + z*cos a > 0. cos a is uMoon.z,
          // handed down from clock.js where the phase is decided.
          //
          // This is worth doing properly rather than eyeballing, because the
          // horns of a crescent point directly away from the sun and that is a
          // relationship people read without knowing they are reading it. A
          // crescent lit from the wrong side looks wrong immediately even to
          // someone who could not say why.
          float md = dot( dir, uMoonDir );
          if ( uMoon.y > 0.001 && md > 0.9 ) {
            // Small-angle: the offset from the moon's centre, projected onto
            // its disc basis, is the angular offset in radians to well within
            // a pixel over a 1.3 deg disc.
            float ang = acos( clamp( md, -1.0, 1.0 ) );
            float rad = acos( clamp( uMoon.x, -1.0, 1.0 ) );
            float u = dot( dir, uMoonU ) / rad;
            float v = dot( dir, uMoonV ) / rad;
            float r2 = u * u + v * v;

            // Limb softness of one part in 60 of the radius, so the edge is
            // antialiased rather than stair-stepped -- at 40 px across, a hard
            // circle test crawls with jaggies every time the head moves.
            float disc = 1.0 - smoothstep( 0.97, 1.0, sqrt( r2 ) );
            float c = uMoon.z;
            float z = sqrt( max( 0.0, 1.0 - r2 ) );
            float litTest = u * sqrt( max( 0.0, 1.0 - c * c ) ) + z * c;
            // The terminator is genuinely soft on the real thing -- it crosses
            // mountains at a grazing angle -- and softening it here also hides
            // the aliasing along a curve that can pass very close to vertical.
            float lit = smoothstep( -0.06, 0.06, litTest );

            // Limb darkening, inverted from how a planet works: the moon is
            // notoriously FLAT-looking because its dust backscatters, so the
            // limb stays nearly as bright as the centre. A weak term only.
            float shade = 0.82 + 0.18 * z;

            vec3 moonTint = vec3( 1.0, 0.97, 0.90 );
            col += moonTint * ( disc * lit * shade * 2.2 * uMoon.y );
          }

          // A soft glow around the moon regardless of phase: the atmosphere
          // scatters its light the same way it scatters the sun's, and a moon
          // with a knife edge against the sky reads as a sticker. Cheap --
          // one pow on a dot product already computed.
          col += vec3( 0.62, 0.70, 0.90 ) * ( pow( max( md, 0.0 ), 900.0 ) * 0.30 * uMoon.y );

          gl_FragColor = vec4( col, 1.0 );
          #include <colorspace_fragment>

          // ---- Dither, AFTER the trip to sRGB.
          //
          // The night sky is a smooth gradient across nearly the whole field of
          // view at very low brightness, which is the exact worst case for an
          // 8-bit framebuffer: the bands are several degrees wide and they move
          // with the head. A quarter-LSB of hash noise breaks them up and is
          // itself invisible.
          //
          // It has to be applied here, not in linear space, because near black
          // one 8-bit code step is about 0.0003 in linear -- an amplitude that
          // matters at the top of the range does nothing at the bottom, and one
          // that works at the bottom is a snowstorm at the top. In sRGB the
          // step is 1/255 everywhere by definition.
          float dither = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          gl_FragColor.rgb += ( dither - 0.5 ) / 255.0;
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })

    // Enough segments that the sun disc's silhouette is a circle rather than a
    // polygon: the disc is computed per fragment, so this only has to be dense
    // enough that `position` interpolates smoothly, and 32x16 is plenty.
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 32, 16), this.material)
    // Drawn first, and never culled -- the camera is always inside it, which
    // frustum culling against its bounding sphere handles correctly, but the
    // flag costs nothing and removes a class of surprise.
    this.mesh.renderOrder = -1000
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    this._u = this.material.uniforms
    this._tmp = new THREE.Vector3()
  }

  // Call once per frame, before render, with her head position in world space
  // and the current clock state.
  //
  // Position only: the rotation must stay identity, so that a snap turn -- which
  // rotates the rig, i.e. spins the world around her -- carries the sun with the
  // world rather than dragging it along with her view.
  //
  // Takes a position rather than the camera on purpose. In XR the camera's
  // matrixWorld is written by the XR manager DURING render, from the pose, so
  // reading it here would be a frame stale; the caller already has the current
  // head position from the player.
  update(head, state) {
    this.mesh.position.copy(head)

    const u = this._u
    u.uHorizon.value.setRGB(state.horizon[0], state.horizon[1], state.horizon[2], THREE.SRGBColorSpace)
    u.uZenith.value.setRGB(state.zenith[0], state.zenith[1], state.zenith[2], THREE.SRGBColorSpace)
    u.uGlow.value.setRGB(state.glow[0], state.glow[1], state.glow[2], THREE.SRGBColorSpace)
    u.uGlowAmt.value = state.glowAmt
    u.uGlowSharp.value = state.glowSharp

    u.uSunDir.value.set(state.sun.x, state.sun.y, state.sun.z)
    // The disc lingers a little past geometric sunset before going, matching
    // the refraction that makes the real sun visibly sit on the horizon after
    // it has technically set, then fades out over the next couple of degrees.
    u.uSunFade.value = smoothstep(-0.055, 0.004, state.sun.y)

    const moonDir = this._tmp.set(state.moon.x, state.moon.y, state.moon.z)
    u.uMoonDir.value.copy(moonDir)
    u.uMoon.value.set(
      Math.cos(MOON.radiusDeg * DEG),
      // Fades in as the sky darkens (state.moonBright) and out as the moon
      // sets. A moon still drawn at full strength against a bright afternoon
      // sky is the single most common tell in a game day-night cycle.
      state.moonBright * smoothstep(-0.06, 0.03, state.moon.y),
      2 * state.moonLit - 1
    )

    // Illumination axis: the sun direction with the moon direction projected
    // out of it, i.e. which way "toward the sun" points once flattened onto the
    // moon's disc. Degenerate only if the sun is exactly at or opposite the
    // moon -- a total eclipse either way -- so fall back to any perpendicular.
    const s = SUN_TMP.set(state.sun.x, state.sun.y, state.sun.z)
    s.addScaledVector(moonDir, -s.dot(moonDir))
    if (s.lengthSq() < 1e-8) s.set(moonDir.z, 0, -moonDir.x)
    s.normalize()
    u.uMoonU.value.copy(s)
    u.uMoonV.value.crossVectors(moonDir, s).normalize()
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

const SUN_TMP = new THREE.Vector3()

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
