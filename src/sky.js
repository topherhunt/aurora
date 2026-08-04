import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Sky dome: a vertical gradient plus a sun disc.
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
// The dome follows the camera each frame (see update). It has to: at a 4000 m
// radius inside a 16 km world, walking a kilometre would visibly slide the sun
// across the sky. Following the camera POSITION but not its rotation is what
// makes it read as infinitely far away, and it keeps the sky correctly fixed to
// the world when a snap turn rotates the rig underneath her.
// ---------------------------------------------------------------------------

// Comfortably inside the camera's 20000 m far plane, comfortably outside the
// terrain's draw distance so no peak ever pokes through it.
const RADIUS = 9000

export class Sky {
  // sunDir must be the same normalised vector the DirectionalLight uses, or the
  // disc will not be where the terrain's highlights say the sun is.
  constructor(scene, sunDir, { horizon = 0xa9c4e2, zenith = 0x1f56ad } = {}) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        // NOT convertSRGBToLinear'd. three's ColorManagement is on by default
        // and `new Color(hex)` already reads the hex as sRGB and stores linear
        // working-space values, so converting again would square the transfer
        // curve and land both colours at roughly a third of their intended
        // brightness -- a navy sky at noon. The shader below works in linear
        // and hands off to <colorspace_fragment> for the trip back out.
        uHorizon: { value: new THREE.Color(horizon) },
        uZenith: { value: new THREE.Color(zenith) },
        uSunDir: { value: sunDir.clone().normalize() },
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
        uniform vec3 uSunDir;

        void main() {
          vec3 dir = normalize( vDir );

          // Height above the horizon, 0..1. The exponent is the whole character
          // of the gradient: a linear ramp puts the midpoint 45 deg up, which
          // is far too high and makes the sky look washed out, because most of
          // what she can see through a headset is the lower half of the sky.
          //
          // This was 0.42, which still left a wide pale band -- the midpoint of
          // the mix sat at asin(0.5^(1/0.42)) = 11 deg, but the approach to it
          // is slow and the sky did not read as properly blue until ~40 deg up.
          // 0.21 halves the exponent, which squares the ramp: the same midpoint
          // lands at 2.4 deg and the pale band collapses into the bottom of the
          // view, where real haze actually sits.
          float up = pow( clamp( dir.y, 0.0, 1.0 ), 0.21 );
          vec3 col = mix( uHorizon, uZenith, up );

          // Below the horizon the terrain covers everything, but the dome is
          // still drawn where distant terrain has faded out entirely. Holding
          // the horizon colour there means the seam is invisible.
          float sun = dot( dir, uSunDir );

          // Two-part sun. The core is a small hard disc, about 1.1 deg across
          // -- the real sun is 0.53, but Quest 3 resolves roughly 15 px per
          // degree, so a true-size disc is eight pixels and reads as a speck of
          // dead pixel rather than as the sun. It is deliberately pushed well
          // above 1.0 so it clips to white and reads as something you cannot
          // look at directly. The halo is the wide, weak forward-scatter around
          // it, and it is what actually sells the sun as being IN the
          // atmosphere rather than painted on the inside of it.
          float core = smoothstep( 0.99985, 0.99995, sun );
          float halo = pow( max( sun, 0.0 ), 1400.0 ) * 0.55
                     + pow( max( sun, 0.0 ), 60.0 ) * 0.10;

          vec3 sunTint = vec3( 1.0, 0.96, 0.80 );   // yellow-white
          col += sunTint * halo;
          col = mix( col, sunTint * 4.0, core );

          gl_FragColor = vec4( col, 1.0 );
          #include <colorspace_fragment>
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
  }

  // Call once per frame, before render, with her head position in world space.
  //
  // Position only: the rotation must stay identity, so that a snap turn -- which
  // rotates the rig, i.e. spins the world around her -- carries the sun with the
  // world rather than dragging it along with her view.
  //
  // Takes a position rather than the camera on purpose. In XR the camera's
  // matrixWorld is written by the XR manager DURING render, from the pose, so
  // reading it here would be a frame stale; the caller already has the current
  // head position from the player.
  update(head) {
    this.mesh.position.copy(head)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
