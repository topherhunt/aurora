import * as THREE from 'three'

// ---------------------------------------------------------------------------
// The single shared prop material.
//
// This is the load-bearing constraint of the whole renderer (DESIGN.md §5):
// every prop, every LOD tier, every species uses this one material so that
// BatchedMesh can collapse them into one multi-draw call. Adding a second prop
// material splits every batch.
//
// MeshLambertMaterial rather than Standard: no PBR cost, and all our lighting
// is baked anyway (DESIGN.md §8). Meta's guidance is one real-time light max.
//
// Patched via onBeforeCompile to sample a sampler2DArray. We deliberately do
// NOT use material.map -- three's map path assumes sampler2D. Instead we carry
// our own uv varying plus a per-vertex texLayer index.
// ---------------------------------------------------------------------------

/**
 * `vertexColors` opts into a per-vertex tint multiplied over the array sample.
 *
 * Off for props, and it has to stay off for them: turning it on changes the
 * program, and every geometry in a batch would then need a `color` attribute it
 * does not have. Buildings pass true, because they are a SEPARATE merged mesh
 * (DESIGN.md §6 -- a village is ~450 static pieces inside 240 m, so per-instance
 * culling would cull nothing and one merged mesh beats a BatchedMesh), so the
 * cost of the second program is one extra draw call for a whole village.
 *
 * What it buys is most of the variation the buildings need without spending
 * texture layers on it: thatch weathering from new straw to grey, moss on the
 * north side of a roof, grime up a plaster panel, one shared timber tile
 * reading as oak on one cottage and pine on the next.
 */
export function createPropMaterial(textureArray, { vertexColors = false } = {}) {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    // Binary cutout only. Alpha blending cannot be sorted within a batched
    // draw call, so it is architecturally unavailable to us (DESIGN.md §7).
    alphaTest: 0.5,
    transparent: false,
    // Foliage cards are single-sided geometry, and both of their sides are the
    // same leaf. See the normal_fragment_begin patch below: three's flip is
    // undone so a card is lit by its authored normal from either side.
    side: THREE.DoubleSide,
    vertexColors,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: textureArray }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float texLayer;
        attribute vec2 uvProj;
        varying float vTexLayer;
        varying vec2 vUvProj;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTexLayer = texLayer;
        vUvProj = uvProj;`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        varying float vTexLayer;
        varying vec2 vUvProj;`
      )
      // BOTH SIDES OF A CUTOUT ARE THE SAME SURFACE. Three's double-sided path
      // flips the normal toward the VIEWER (`normal *= faceDirection` in
      // normal_fragment_begin), which is right for a solid seen from inside and
      // catastrophic for a leaf: stand under a canopy, look up, and every card
      // hands the lighting a normal pointing at the ground -- dotNL 0 from the
      // sun and the hemisphere's near-black ground colour -- so the whole
      // underside of the tree goes black. Undoing the flip (faceDirection twice
      // is the identity) means a fragment is lit by the normal the GEOMETRY
      // authored, whichever side you are on. tree.js gives every leaf vertex
      // the canopy shell's normal for exactly this reason, and a leaf really is
      // one cell thick and lit from every side at once.
      //
      // What is left is a gentle darkening when you are looking at the back of
      // that normal, which is the underside of a canopy and the inside of a
      // wall. Ramped rather than stepped so a solid's silhouette, where the dot
      // passes through zero, does not get a hard rim.
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        normal *= faceDirection;
        diffuseColor.rgb *= mix( 0.72, 1.0,
          smoothstep( -0.35, 0.15, dot( normal, normalize( vViewPosition ) ) ) );`
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );`
      )

    material.userData.shader = shader
  }

  // Force a distinct program cache key so this patched material never gets
  // conflated with an unpatched MeshLambertMaterial.
  material.customProgramCacheKey = () => (vertexColors ? 'prop-array-v1-vc' : 'prop-array-v1')

  return material
}
