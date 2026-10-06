// ---------------------------------------------------------------------------
// What the generated props (design/29-prop-pipeline.md) share once they are in
// the world: loading a shipped ladder into geometries in one frame, the metres
// a scatter seats and sizes it by, and the material a prop is drawn through.
// The scatters are render/deadwood.js (the stump and the log) and render/bones.js.
//
// A GENERATED PROP WEARS ITS OWN MAP, not the 128 px atlas. Its colour map ships
// at 512 px (tools/props/gen/ship.mjs), four times the atlas's side, so it
// cannot be a layer of it and a prop cannot draw through createPropMaterial:
// each variant is a Lambert with its own `map` on one shared program, and the
// far tier is a critters.js card photographed off the loaded mesh at runtime
// rather than a bench-baked impostor layer. What the material keeps of the
// props' shader is the rim dissolve -- material.js's FADE_VERTEX and
// FADE_FRAGMENT over the arena's `aPropFade` attribute -- so a generated prop
// dithers out at the draw radius exactly as a procedural one does.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { HEAD_EYE_DECL, bindHeadEye } from '../../head-eye.js'
import { FADE_FRAGMENT, FADE_VERTEX, IGN_GLSL, propClockUniform } from '../../material.js'
import { LOD_DEG, SPIN_ATTRIBUTE, billboardVertex, critterLodUrl, distAt, loadCritterGlb } from './critters.js'

// What tools/props/gen/ship.mjs writes for each prop, relative to the page like the critters' URLs: the pick, and its ladder as critterLodUrl.
export const GEN_PROP_GLB = {
  stump: 'gen-props/stump-rotting.glb',
  log: 'gen-props/log-fallen.glb',
  skeleton: 'gen-props/skeleton-deer.glb',
  skull: 'gen-props/skull-elk.glb',
}
// Decimated tiers beside every pick, lod1 the finest. The bench cuts three.
export const GEN_PROP_LODS = 3

// THE LADDER A PROP SCATTER DRAWS: two of the shipped tiers as meshes and a
// card past them, on the creatures' rule (critters.js ladderTier) with its own
// spacing. On an instanced prop every rung is a draw call per variant, so the
// shipped T1 and T3 are not drawn: the first rung is the animals' (LOD_DEG,
// 4.5 sizes), the mesh gives way to the card at half that arc, 9 sizes --
// where a piece is ~128 px tall on a headset, the card's own texel count --
// and the card holds to 72 sizes, the animals' card reach, so a 2 m piece
// steps at 9 and 18 m and is gone past 144, and a 10 m one holds its card to
// 720 m.
export const PROP_MESH_TIERS = [0, 2]
export const PROP_STEPS = [1, 2, 16]
export const PROP_RUNGS = PROP_STEPS.length
/** How far a prop of `size` metres is drawn at rung `k`. */
export const propReach = (size, k) => distAt(size, LOD_DEG) * PROP_STEPS[k]
/** Past this a prop of `size` metres is not drawn at all. */
export const propCull = (size) => propReach(size, PROP_RUNGS - 1)

/** The shipped tiers a scatter's bank draws as meshes, in rung order, from a ladder's geometries. */
export function propMeshTiers(picks) {
  return PROP_MESH_TIERS.map((t) => ({ geometries: picks.map((l) => l.geometries[t]) }))
}

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

// The normal a card is lit by, in place of its own. A card is a rounded body
// photographed in flat albedo, so it is lit as that body reads in the
// aggregate: the mean normal of the surface she sees, halfway between the
// world's up and the way to her -- bright with the sun behind her, dim looking
// into it, like the mesh it stands in for. Taken from the world and not from
// the instance, whose matrix turns the authored normal with the piece: a log
// rolled about its axis (deadwood.js) had its card lit from underneath, ground
// bounce and no sun, and read as a grey slab beside the mesh. Straight down at
// it the two directions agree and it is lit as a top.
export const CARD_NORMAL = /* glsl */ `
  {
    vec3 cnUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 cnSum = cnUp + normalize( vViewPosition );
    float cnLen = length( cnSum );
    normal = cnLen > 1e-4 ? cnSum / cnLen : cnUp;
  }`

/**
 * Lights `points` of a material's mesh from inside: the leafkin huts' windows
 * (§30). Each point is `{ x, y, z, r }` in the geometry's OWN frame (the
 * pick's, before the instance matrix), so one list authored on the pick lights
 * every decimated tier. Inside a disc that is full at 0.6 r and gone at r the
 * surface is UNLIT by `material.uGlowOn` (0..1): its lit colour gives way to
 * its own albedo times `material.uGlow`, so a pane's amber cells come up amber
 * whatever the night, and the dark bars painted between them stay dark -- an
 * additive glow lifted the bars with the cells and read as an orange wash. At
 * uGlowOn 0 the disc shades like the wall about it. The mix goes in before
 * opaque_fragment, after lighting.patch's shading and the lamps, and before
 * its aerial mix. The count is baked into the program, so materials with
 * different lists compile apart. Chains onBeforeCompile the way
 * lighting.patch does, so it composes with createGenPropMaterial and with a
 * plain Lambert alike.
 */
export function addGlow(material, points) {
  if (!Array.isArray(points) || points.length === 0 || points.some((p) => ![p.x, p.y, p.z, p.r].every(Number.isFinite) || !(p.r > 0))) {
    throw new Error('addGlow: points is a non-empty list of { x, y, z, r }')
  }
  const n = points.length
  material.uGlow = { value: new THREE.Color(0, 0, 0) }
  material.uGlowOn = { value: 0 }
  const pts = { value: points.map((p) => new THREE.Vector4(p.x, p.y, p.z, p.r)) }
  const prev = material.onBeforeCompile
  const prevKey = material.customProgramCacheKey
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(material, shader, renderer)
    shader.uniforms.uGlow = material.uGlow
    shader.uniforms.uGlowOn = material.uGlowOn
    shader.uniforms.uGlowPts = pts
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlowPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowPos = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGlowPos;\nuniform vec3 uGlow;\nuniform float uGlowOn;\nuniform vec4 uGlowPts[${n}];`)
      .replace(
        '#include <opaque_fragment>',
        `{
          float glowMask = 0.0;
          for ( int i = 0; i < ${n}; i++ ) {
            vec4 g = uGlowPts[i];
            glowMask += 1.0 - smoothstep( g.w * 0.6, g.w, distance( vGlowPos, g.xyz ) );
          }
          outgoingLight = mix( outgoingLight, diffuseColor.rgb * uGlow, min( glowMask, 1.0 ) * uGlowOn );
        }
        #include <opaque_fragment>`
      )
  }
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|glow${n}`
  return material
}

/**
 * The material one generated prop draws through: Lambert with its own map and
 * the rim dissolve. A `card` is a far card off critters.js -- a cutout,
 * double-sided, lit by CARD_NORMAL on both faces of every quad so a cross's
 * seam is not a step in brightness. A `billboard` card is one quad spun about
 * the instance's Y to face her in the vertex shader (two triangles; flat in a
 * headset, which past the parallax range it always is); `billboard: 'mixed'`
 * spins only the vertices whose `aSpin` is 1 (critters.js setSpunTopCard).
 * A `foliage` mesh is a cutout of one-cell-thick leaves (the carrots' greens):
 * double-sided, alpha-tested, and lit by the normal the geometry authored on
 * BOTH faces -- the same undo of three's double-sided flip that
 * createPropMaterial does (material.js), without which the underside of every
 * leaf is lit by a normal pointing at the ground and goes black.
 * A `gloss` mesh is a Standard material at that roughness in place of the
 * Lambert, metalness 0, the sun's whole GGX lobe on it (the dragon egg's
 * shell): the one prop that shines, on a program of its own. There is no
 * environment map, so the shine is the sun's alone and lighting.js gates it
 * with the diffuse's shadow, as it does the wet creatures' glint (critters.js).
 * `glow` is addGlow's list of points lit from inside, on a mesh only.
 * THE PROGRAM IS KEYED ON THESE FLAGS AND NOTHING ELSE, so every mesh variant of
 * every prop scatter compiles to one program and its calls differ by material
 * only -- a map bind, not a useProgram with the lights and camera re-uploaded
 * behind it. What three keys on its own (alphaTest, the double side, whether a
 * map is set) needs no help here. The lighting patch (lighting.js) composes
 * its key onto this one, so its callers must share theirs too.
 */
export function createGenPropMaterial({ tint = 0xffffff, card = false, billboard = false, foliage = false, gloss = false, glow = null } = {}) {
  if (billboard && !card) throw new Error('createGenPropMaterial: a billboard is a card')
  if (billboard !== false && billboard !== true && billboard !== 'mixed') throw new Error(`createGenPropMaterial: billboard is true, false or 'mixed', not ${billboard}`)
  if (foliage && card) throw new Error('createGenPropMaterial: foliage is a mesh, not a card')
  if (gloss !== false && !(gloss > 0 && gloss < 1)) throw new Error(`createGenPropMaterial: gloss is a roughness in (0, 1), not ${gloss}`)
  if (gloss !== false && (card || foliage)) throw new Error('createGenPropMaterial: gloss is a solid mesh, not a cutout')
  if (glow !== null && card) throw new Error('createGenPropMaterial: glow lights a mesh, not a card')
  const mixed = billboard === 'mixed'
  const params = {
    color: tint,
    alphaTest: card || foliage ? 0.5 : 0,
    side: card || foliage ? THREE.DoubleSide : THREE.FrontSide,
  }
  const material = gloss !== false
    ? new THREE.MeshStandardMaterial({ ...params, roughness: gloss, metalness: 0 })
    : new THREE.MeshLambertMaterial(params)
  material.onBeforeCompile = (shader) => {
    // By reference, so the one clock drives every program.
    shader.uniforms.uPropClock = propClockUniform()
    if (billboard) bindHeadEye(shader.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        #define PROP_FADE_ATTRIBUTE
        attribute float aPropFade;
        uniform float uPropClock;
        varying float vPropFade;
        ${mixed ? SPIN_ATTRIBUTE : ''}
        ${billboard ? HEAD_EYE_DECL : ''}`
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${billboard ? billboardVertex(mixed) : ''}\n${FADE_VERTEX}`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vPropFade;\n${IGN_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FADE_FRAGMENT}`)
    if (card) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${CARD_NORMAL}`)
    } else if (foliage) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;')
    }
  }
  material.customProgramCacheKey = () => `gen-prop${mixed ? '-billboard-mixed' : billboard ? '-billboard' : card ? '-card' : foliage ? '-foliage' : gloss !== false ? '-gloss' : ''}`
  return glow !== null ? addGlow(material, glow) : material
}
