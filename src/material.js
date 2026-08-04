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

export function createPropMaterial(textureArray) {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    // Binary cutout only. Alpha blending cannot be sorted within a batched
    // draw call, so it is architecturally unavailable to us (DESIGN.md §7).
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide, // foliage cards are single-sided geometry
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
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        diffuseColor *= texture( uAtlas, vec3( vUvProj, vTexLayer ) );`
      )

    material.userData.shader = shader
  }

  // Force a distinct program cache key so this patched material never gets
  // conflated with an unpatched MeshLambertMaterial.
  material.customProgramCacheKey = () => 'prop-array-v1'

  return material
}
