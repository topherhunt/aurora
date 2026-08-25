import * as THREE from 'three'
import { SNOW_LAYERS } from './textures.js'

// ---------------------------------------------------------------------------
// Snow.
//
// Three uniforms for the whole world, shared by reference into every program
// this module compiles, so `setSnow` drives props and buildings together and
// costs nothing per frame. There is no per-object snow DATA and there does not
// need to be: what a prop wears is derived in the vertex shader from where it
// STANDS, by testing its own root against the snow line. Two pines a hundred
// metres apart in elevation wear visibly different loads from the same uniform.
//
// The test uses the instance ORIGIN, not the fragment's own height. With a 47 m
// band a 25 m tree spans half of it, so per-fragment would paint a gradient up
// a single trunk -- white crown, green skirt -- which is not what a treeline
// looks like. A tree is snowed by where it grows, as a whole.
//
// What this does NOT read is the PAINTED snow-line delta (SnowField.deltaAt):
// the shader knows the base and the band, not the editor's local edits. Where a
// delta has been painted a tree will disagree with the ground under it by that
// delta. Fixing it properly means a per-instance channel -- BatchedMesh's own
// per-instance colour is already spent on stand tinting, so it would be a new
// DataTexture indexed by batchId. Worth it only if painted deltas get large.
//
// It lands only on the layers textures.js lists as foliage. The shader tests
// that with a fixed loop rather than by indexing a mask array with vTexLayer.
// Note that three emits `#version 300 es` for every non-raw material and shims
// the ES 1.00 spelling with #defines (WebGLProgram.js), so the compiled language
// is ES 3.00 and a dynamic index WOULD be legal -- the loop stays because at
// nine iterations of abs+step, unrolled by any compiler, it costs the same and
// says what it means. The whole block is inside a `uSnow > 0.0` branch that is
// uniform across the draw and therefore free when the sun is out.
//
// That ES 3.00 fact is also what lets the edge use fwidth() without an extension
// guard -- see SNOW_EDGE_MIN.
// ---------------------------------------------------------------------------

const snowAmount = { value: 0 }
const snowLayers = { value: Float32Array.from(SNOW_LAYERS) }

// The snow line, in world metres, and how many metres it takes to go from bare
// to loaded. Defaults are a deliberate NO-OP: a line at -1e6 puts every prop in
// the world above it, so `uSnow` alone drives the whole scene until the game
// calls setSnowLine. That is what /gen-tree wants, where there is no terrain.
const snowLine = { value: -1e6 }
const snowBand = { value: 1 }

/**
 * Season, 0 = bare, 1 = nearly all white. This is a CEILING, not the value each
 * prop wears: what a prop actually gets is this scaled by where it stands
 * against the snow line. Takes effect on the next frame.
 */
export function setSnow(amount) {
  if (!Number.isFinite(amount)) throw new Error(`setSnow: need a number, got ${amount}`)
  snowAmount.value = Math.min(1, Math.max(0, amount))
}

export function getSnow() {
  return snowAmount.value
}

/**
 * Where snow starts, and over how many metres it comes in. Pass the same
 * numbers the terrain shades itself with (`layers.snow.base` / `.band`) so a
 * tree and the ground it stands on cross the line together.
 */
export function setSnowLine(base, band) {
  if (!Number.isFinite(base)) throw new Error(`setSnowLine: need a number for base, got ${base}`)
  if (!(band > 0)) throw new Error(`setSnowLine: band must be positive, got ${band}`)
  snowLine.value = base
  snowBand.value = band
}

// Blob size, in cycles per world metre. At 12.8 a clump is roughly 7.5 cm
// across, so a 2 m spray card carries a couple of dozen and the snow reads as
// settled crystals rather than as paint.
const SNOW_FREQ = 12.8

// Where the world-space blobs stop being resolvable and start shimmering.
// Procedural noise has NO MIP CHAIN: at 7.5 cm a blob is under a pixel past ten
// metres or so, and undersampled noise crawls when you move your head -- which
// in a headset is the worst artefact there is. Past SNOW_FADE_FAR the noise is
// blended to its own mean, so a distant tree gets the slider's average coverage
// flat, which is what a mip would have converged to anyway.
const SNOW_FADE_NEAR = 12.0
const SNOW_FADE_FAR = 40.0

// Half-width of the snow's edge, as a range of `drift`. The edge is meant to be
// a CUTOVER, not a gradient -- snow has a rim, and a soft ramp reads as airbrush
// -- so the width is taken from fwidth(), which is the amount `drift` changes
// across one screen pixel. That makes the edge exactly one pixel wide at any
// distance: as firm as a step() but without the crawling a raw step() would give
// on noise this fine. The floor keeps it from ever becoming a true step; the
// CEILING is load-bearing, because SNOW_CUT_BIAS below is sized against it.
const SNOW_EDGE_MIN = 0.002
const SNOW_EDGE_MAX = 0.06

// The cut runs from SNOW_CUT_BIAS down by SNOW_CUT_SPAN as an instance's own
// load (vSnowPos.w) goes 0->1. Both ends are promises. At a load of 0 the cut MINUS a full-width edge still sits
// above drift's ceiling of 1.0, so "off" means off and not a faint rime; at
// a load of 1 the cut PLUS a full-width edge sits below drift's floor of 0.0, so the
// upward lean stops mattering and the whole canopy goes white. The span is only
// just wide enough to keep the second promise (1.08 + 0.06 = 1.14) because any
// slack past that is slider travel spent on a canopy that is already fully white.
const SNOW_CUT_BIAS = 1.08
const SNOW_CUT_SPAN = 1.16

// Cold white rather than 1.0 flat: snow in daylight is the sky's colour, and a
// pure-white canopy against this game's blue night reads as a hole in the tree.
const SNOW_TINT = 'vec3( 0.93, 0.95, 1.0 )'

// How dark the darkest snowed fragment gets, as a fraction of that tint. Snow
// is not a flat fill -- it takes the LEAF'S OWN LUMINANCE, throws the hue away
// and stretches what is left across this range, so the spray's shape and its
// internal shading still read through the white. The stretch is the point: a
// leaf's luminance only spans about 0.1 to 0.45, and lifting that straight
// toward white would leave four percent of contrast, which is invisible.
const SNOW_FLOOR = 0.62
const SNOW_LUM_HI = 0.45

const SNOW_COMMON = /* glsl */ `
  uniform float uSnow;
  uniform float uSnowLayers[ ${SNOW_LAYERS.length} ];
  varying vec4 vSnowPos;

  float snowHash( vec3 p ) {
    p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }

  // One octave of value noise. Blobs want a single low frequency; a second
  // octave only adds per-pixel fizz that the mip chain then eats anyway.
  float snowNoise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( snowHash( i + vec3( 0.0, 0.0, 0.0 ) ), snowHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ),
           mix( snowHash( i + vec3( 0.0, 1.0, 0.0 ) ), snowHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
      mix( mix( snowHash( i + vec3( 0.0, 0.0, 1.0 ) ), snowHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ),
           mix( snowHash( i + vec3( 0.0, 1.0, 1.0 ) ), snowHash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ), f.z );
  }
`

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

// Applied between the double-sided normal flip and the back-facing ramp, so a
// snowed leaf is shaded like the leaf it is sitting on rather than glowing flat
// white on the shaded side of a canopy.
const SNOW_APPLY = /* glsl */ `
  // Outer test is on the UNIFORM, so a bare season costs nothing anywhere. The
  // inner test is on the varying, which is per-instance and therefore constant
  // across every fragment of a given tree -- a warp never straddles it except
  // on the seam between two trees, so the divergence is cheap and it buys back
  // the whole noise cost for every prop standing below the snow line.
  if ( uSnow > 0.0 && vSnowPos.w > 0.0 ) {
    float snowMask = 0.0;
    for ( int i = 0; i < ${SNOW_LAYERS.length}; i++ ) {
      snowMask += step( abs( vTexLayer - uSnowLayers[ i ] ), 0.5 );
    }
    if ( snowMask > 0.0 ) {
      // Blobs, leaning upward: snow settles on what faces the sky, and without
      // that lean a fully snowed tree reads as bleached rather than as loaded.
      float up = clamp( normal.y * 0.5 + 0.5, 0.0, 1.0 );
      float snowNear = smoothstep( ${SNOW_FADE_FAR.toFixed(1)}, ${SNOW_FADE_NEAR.toFixed(1)},
        length( vViewPosition ) );
      float blob = mix( 0.5, snowNoise( vSnowPos.xyz * ${SNOW_FREQ.toFixed(2)} ), snowNear );
      float drift = blob * 0.75 + up * 0.25;
      float cut = ${SNOW_CUT_BIAS} - vSnowPos.w * ${SNOW_CUT_SPAN};
      // Grayscale-and-tint rather than a flat fill. Eleven ALU against the ~145
      // the noise above already costs, so this is free in every sense that
      // matters -- and it is what stops a snowed canopy reading as a white
      // cut-out of a tree.
      float snowLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec3 snowCol = ${SNOW_TINT} * mix( ${SNOW_FLOOR}, 1.0,
        smoothstep( 0.0, ${SNOW_LUM_HI}, snowLum ) );
      // A one-pixel cutover -- see SNOW_EDGE_MIN. fwidth is core in GLSL ES
      // 3.00, which is what three compiles this to.
      float edge = clamp( fwidth( drift ), ${SNOW_EDGE_MIN}, ${SNOW_EDGE_MAX} );
      diffuseColor.rgb = mix( diffuseColor.rgb, snowCol,
        smoothstep( cut - edge, cut + edge, drift ) );
    }
  }
`

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
    // By REFERENCE, so one setSnow call moves every program compiled here.
    shader.uniforms.uSnow = snowAmount
    shader.uniforms.uSnowLayers = snowLayers
    shader.uniforms.uSnowLine = snowLine
    shader.uniforms.uSnowBand = snowBand

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float texLayer;
        attribute vec2 uvProj;
        varying float vTexLayer;
        varying vec2 vUvProj;
        uniform float uSnow;
        uniform float uSnowLine;
        uniform float uSnowBand;
        varying vec4 vSnowPos;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTexLayer = texLayer;
        vUvProj = uvProj;`
      )
      // Snow is placed in WORLD space so that two instances of the same tree
      // standing side by side do not wear identical drifts, and so a drift does
      // not slide around a trunk when the instance is yawed. That means undoing
      // batching and instancing the way project_vertex does -- `transformed` is
      // still object space here, and modelMatrix alone would put a whole
      // BatchedMesh's worth of trees at one spot.
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 snowWorld = vec4( transformed, 1.0 );
        vec4 snowRoot = vec4( 0.0, 0.0, 0.0, 1.0 );
        #ifdef USE_BATCHING
          snowWorld = batchingMatrix * snowWorld;
          snowRoot = batchingMatrix * snowRoot;
        #endif
        #ifdef USE_INSTANCING
          snowWorld = instanceMatrix * snowWorld;
          snowRoot = instanceMatrix * snowRoot;
        #endif
        // .w is this INSTANCE's snow load: the season ceiling, cut down by how
        // far its own root sits above the snow line. One extra matrix-vector
        // product at vertex rate, and it rides in the varying we already had.
        vSnowPos = vec4( ( modelMatrix * snowWorld ).xyz,
          uSnow * smoothstep( uSnowLine - uSnowBand * 0.5, uSnowLine + uSnowBand * 0.5,
            ( modelMatrix * snowRoot ).y ) );`
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        varying float vTexLayer;
        varying vec2 vUvProj;
        ${SNOW_COMMON}`
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
        ${SNOW_APPLY}
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
  material.customProgramCacheKey = () => (vertexColors ? 'prop-snow-v1-vc' : 'prop-snow-v1')

  return material
}

/**
 * The material an IMPOSTOR IS BAKED WITH -- not one anything in the world is
 * drawn with.
 *
 * This looks like it breaks the one-material rule at the top of this file, and
 * it does not: that rule is about what BatchedMesh can collapse into one
 * multi-draw call, and nothing drawn with this ever enters a batch. It is used
 * for exactly one offscreen render into a 128x128 target, after which the
 * result is bytes in a texture layer and this material is disposed.
 *
 * Basic rather than Lambert, and that is the whole point of its existing.
 * An impostor is shaded TWICE if you let it be: once when the tree is captured
 * and again when the card carrying that capture is lit. Baking unlit albedo
 * leaves all the shading to the card's own normals, which is the same choice
 * tree.js makes for its canopy -- see the canopy-normal pass at the bottom of
 * buildTree, which hands every leaf the crown shell's normal. The impostor card
 * carries an outward horizontal normal per plane for the same reason, so a tree
 * shades the same way either side of the LOD swap.
 */
export function createImpostorBakeMaterial(textureArray) {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    alphaTest: 0.5,
    transparent: false,
    side: THREE.DoubleSide,
    toneMapped: false,
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
  }

  material.customProgramCacheKey = () => 'impostor-bake-v1'
  return material
}
