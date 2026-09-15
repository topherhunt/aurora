// ---------------------------------------------------------------------------
// What the generated props (design/29-prop-pipeline.md) share once they are in
// the world: loading a shipped ladder into geometries in one frame, the metres
// a scatter seats and sizes it by, and the material a prop is drawn through.
// The scatters are render/deadwood.js (the stump and the log) and render/bones.js.
//
// A GENERATED PROP WEARS ITS OWN MAP, not the 128 px atlas. Its colour map ships
// at 512 px (tools/props/gen/ship.mjs), four times the atlas's side, so it
// cannot be a layer of it and a prop cannot draw through createPropMaterial:
// each variant is a Lambert with `map`, one program per variant, and the far
// tier is the critters' cross card photographed off the loaded mesh at runtime
// rather than a bench-baked impostor layer. What the material keeps of the
// props' shader is the rim dissolve -- material.js's FADE_VERTEX and
// FADE_FRAGMENT over the arena's `aPropFade` attribute -- so a generated prop
// dithers out at the draw radius exactly as a procedural one does.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { FADE_FRAGMENT, FADE_VERTEX, IGN_GLSL, propClockUniform } from '../../material.js'
import { critterLodUrl, loadCritterGlb } from './critters.js'

// What tools/props/gen/ship.mjs writes for each prop, relative to the page like the critters' URLs: the pick, and its ladder as critterLodUrl.
export const GEN_PROP_GLB = {
  stump: 'gen-props/stump-rotting.glb',
  log: 'gen-props/log-fallen.glb',
  skeleton: 'gen-props/skeleton-deer.glb',
  skull: 'gen-props/skull-elk.glb',
}
// Decimated tiers beside every pick, lod1 the finest. The bench cuts three.
export const GEN_PROP_LODS = 3

/**
 * A ladder's geometries from its loaded assets, pick first, every tier already
 * in the pick's frame (loadCritterGlb's `origin`). With `longAxisZ` a mesh whose
 * longer horizontal extent lies along X is turned onto Z, which is the axis a
 * lying prop's scatter pitches and measures it along: Tripo lays a log along X
 * and the shipper keeps its frame.
 */
export function ladderGeometries(assets, { longAxisZ = false } = {}) {
  if (!assets.length) throw new Error('ladderGeometries: no tiers')
  const geometries = assets.map((a) => {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(a.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(a.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(a.uv), 2))
    geo.setIndex(a.idx)
    geo.computeBoundingBox()
    return geo
  })
  const b = geometries[0].boundingBox
  if (longAxisZ && b.max.x - b.min.x > b.max.z - b.min.z) {
    for (const geo of geometries) {
      geo.rotateY(Math.PI / 2)
      geo.computeBoundingBox()
    }
  }
  return geometries
}

/**
 * The metres a scatter works in, off the pick's box: `long` the Z extent,
 * `width` the X extent, `height` the top over the feet, `lodSize` the longest
 * of the three (what a ladder measured in apparent size counts). The critters'
 * card bounds ride along so the far tier is built from the same numbers.
 */
export function ladderBounds(geometry) {
  const b = geometry.boundingBox
  const width = b.max.x - b.min.x
  const long = b.max.z - b.min.z
  const height = b.max.y - b.min.y
  if (!(width > 1e-3 && long > 1e-3 && height > 1e-3)) throw new Error('ladderBounds: a flat prop')
  return { long, width, height, lodSize: Math.max(long, width, height), halfX: width / 2, halfZ: long / 2 }
}

/**
 * A shipped prop's ladder: the pick and its GEN_PROP_LODS decimated tiers as
 * geometries in one frame, the colour map, and the bounds. The tiers are
 * fetched together, so a caller has the whole ladder or nothing.
 */
export async function loadGenProp(url, { longAxisZ = false } = {}) {
  const pick = await loadCritterGlb(url)
  const lods = await Promise.all(
    Array.from({ length: GEN_PROP_LODS }, (_, k) => loadCritterGlb(critterLodUrl(url, k + 1), { origin: pick.origin }))
  )
  // The ladder shares the pick's map; the tiers' own decoded copies are dropped.
  for (const lod of lods) lod.map.dispose()
  const geometries = ladderGeometries([pick, ...lods], { longAxisZ })
  return { geometries, map: pick.map, bounds: ladderBounds(geometries[0]) }
}

/** Triangles per tier of a ladder, for a scatter's per-frame count. */
export const ladderTris = (geometries) => geometries.map((g) => g.index.count / 3)

/**
 * The material one generated prop draws through: Lambert with its own map and
 * the rim dissolve. A `card` is the far cross card -- a cutout, double-sided,
 * with three's double-sided normal flip undone so both faces of both quads
 * take the authored up-normal and the seam between them is not a step in
 * brightness (critters.js). `label` keys the program: two materials differing
 * only in `card` are two programs.
 */
export function createGenPropMaterial(label, { tint = 0xffffff, card = false } = {}) {
  const material = new THREE.MeshLambertMaterial({
    color: tint,
    alphaTest: card ? 0.5 : 0,
    side: card ? THREE.DoubleSide : THREE.FrontSide,
  })
  material.onBeforeCompile = (shader) => {
    // By reference, so the one clock drives every program.
    shader.uniforms.uPropClock = propClockUniform()
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        #define PROP_FADE_ATTRIBUTE
        attribute float aPropFade;
        uniform float uPropClock;
        varying float vPropFade;`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FADE_VERTEX}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vPropFade;\n${IGN_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FADE_FRAGMENT}`)
    if (card) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;')
    }
  }
  material.customProgramCacheKey = () => `gen-prop-${label}${card ? '-card' : ''}`
  return material
}
