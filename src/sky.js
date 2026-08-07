import * as THREE from 'three'
import { SKY_GLSL, makeSkyUniforms, writeSkyUniforms } from './sky-glsl.js'

// ---------------------------------------------------------------------------
// Sky dome: a vertical gradient, a horizon glow that tracks the sun's azimuth,
// the sun disc, and the moon with a real terminator.
//
// THE SHADING ITSELF LIVES IN sky-glsl.js, because the water reflects it and
// there must be exactly one implementation of what the sky looks like in a given
// direction. This file owns the dome: its geometry, its place in the draw order,
// and the once-per-frame write of the uniforms both consumers read. See the
// header of sky-glsl.js for why that split exists.
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

export class Sky {
  constructor(scene) {
    // Public, and shared BY REFERENCE with water.js -- see sky-glsl.js. Anything
    // reading these must not write them; `update` below is the only writer.
    this.uniforms = makeSkyUniforms()

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
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
        ${SKY_GLSL}

        void main() {
          // 1.0: the dome is the one surface that draws the sun's and the moon's
          // hard discs. Water passes 0.0 and adds its own broadened highlight.
          gl_FragColor = vec4( skyRadiance( normalize( vDir ), 1.0 ), 1.0 );
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
    writeSkyUniforms(this.uniforms, state)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
