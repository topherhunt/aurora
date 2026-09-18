// Compile the world's shaders -- the shared prop material, the terrain, the
// water, the sky and the probes -- with a real GLSL ES 3.00 front end.
//
// There is no WebGL in node, so this reconstructs what three actually hands the
// driver: the shader source with the prologue WebGLProgram.js prepends for a
// ShaderMaterial under GLSL3 (lines 536-700 and 858-890), or nothing at all for
// a RawShaderMaterial beyond the #version line. Get that prologue wrong in the
// permissive direction and the harness passes shaders the browser rejects, so
// it is copied from three's source rather than remembered.
//
// The prop material (src/material.js) is a different problem and is handled
// separately below: its GLSL does not exist as a literal anywhere, so it has to
// be ASSEMBLED by actually running the onBeforeCompile hook.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createPropMaterial, createImpostorBakeMaterial } from '../src/material.js'
import { Water } from '../src/water.js'
import { Sky } from '../src/sky.js'
import { WorldLighting } from '../src/lighting.js'
import { AZIMUTHS } from '../src/sim/horizon.js'
import { SkyProbe } from '../src/sky-probe.js'
import { WorldProbe } from '../src/world-probe.js'
import { createPlainTerrainMaterial, createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { createBladeMaterial } from '../src/props/grass-blades.js'
import { Fish } from '../src/v2/render/fish.js'
import { GLINT, createCritterCardMaterial, glint, hueVary } from '../src/v2/render/critters.js'
import { createGenPropMaterial } from '../src/v2/render/gen-props.js'
import { Grasshoppers } from '../src/v2/render/grasshoppers.js'

const tmp = mkdtempSync(join(tmpdir(), 'glsl-'))

// glslang is a native binary, not something npm can install, and making the
// whole check suite refuse to run without `brew install glslang` would be a bad
// trade. Skip LOUDLY instead -- a shader check that silently reports success
// when it never ran is worse than not having one at all.
const VALIDATOR = 'glslangValidator'
try {
  execFileSync(VALIDATOR, ['--version'], { stdio: 'ignore' })
} catch {
  console.log('SKIP  check-shaders: glslangValidator not on PATH (brew install glslang)')
  process.exit(0)
}

// --- three's prologue -------------------------------------------------------
const V_PRE = `#version 300 es
#define attribute in
#define varying out
#define texture2D texture
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
#define SHADER_TYPE ShaderMaterial
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`

const F_PRE = `#version 300 es
#define varying in
#define gl_FragDepthEXT gl_FragDepth
#define texture2D texture
#define textureCube texture
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
#define SHADER_TYPE ShaderMaterial
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
`

const SHADERS = []

// --- src/material.js: the one shared prop material --------------------------
// Nothing above can reach this shader. It is not a template literal: it is
// three's MeshLambertMaterial program with our chunks string-replaced into it by
// an onBeforeCompile hook. So run the hook, then do by hand the four source
// transforms WebGLProgram.js does between the hook and the driver -- resolve
// #include, substitute the light counts, substitute the clipping-plane counts,
// unroll the #pragma loops -- and prepend the BUILT-IN-material prologue, which
// is a different and much longer thing than the ShaderMaterial one above.

const CHUNK = THREE.ShaderChunk
const resolveIncludes = (src, depth = 0) => {
  if (depth > 16) throw new Error('#include recursion')
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
    const c = CHUNK[name]
    if (c === undefined) throw new Error(`unknown chunk <${name}>`)
    return resolveIncludes(c, depth + 1)
  })
}

// The scene the props actually render in: one directional sun, one hemisphere
// fill, no spots, no points, no clipping planes, and NO SHADOW MAP -- nothing in
// src/ ever sets renderer.shadowMap.enabled, so three never defines
// USE_SHADOWMAP and the shadow declarations must stay out of the prologue too.
// Order copied from WebGLProgram.js replaceLightNums: SHADOWS_WITH_MAPS has to
// be substituted before SHADOWS or the longer name never matches.
const LIGHT_NUMS = [
  ['NUM_DIR_LIGHTS', 1],
  ['NUM_SPOT_LIGHTS', 0],
  ['NUM_SPOT_LIGHT_MAPS', 0],
  ['NUM_SPOT_LIGHT_COORDS', 0],
  ['NUM_RECT_AREA_LIGHTS', 0],
  ['NUM_POINT_LIGHTS', 0],
  ['NUM_HEMI_LIGHTS', 1],
  ['NUM_DIR_LIGHT_SHADOWS', 0],
  ['NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS', 0],
  ['NUM_SPOT_LIGHT_SHADOWS', 0],
  ['NUM_POINT_LIGHT_SHADOWS', 0],
  ['NUM_CLIPPING_PLANES', 0],
  ['UNION_CLIPPING_PLANES', 0],
]

const unrollLoops = (src) =>
  src.replace(
    /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g,
    (_, start, end, snippet) => {
      let out = ''
      for (let i = Number(start); i < Number(end); i++) {
        out += snippet.replace(/\[\s*i\s*\]/g, `[ ${i} ]`).replace(/UNROLLED_LOOP_INDEX/g, i)
      }
      return out
    }
  )

// glslang 11/16.5 carries built-in ESSL 3.x symbols that ESSL 3.00 itself does
// not define, and `average` -- which three declares in its <common> chunk, in
// every material, in every browser -- is one of them. `--glsl-version 330` and
// `100` accept the identical declaration; only the `es` profiles reject it. So
// this is the validator's symbol table being wrong, not the shader.
//
// The dodge is a UNIFORM rename of the identifier across the whole source, not a
// deletion: every declaration and every call still has to agree, so a genuine
// arity, type or undeclared-identifier error at that call site still fails. Add
// to this list only after confirming, as above, that plain desktop GLSL accepts
// the same line.
const GLSLANG_PHANTOM_BUILTINS = ['average']
const dodgePhantomBuiltins = (src) => {
  let s = src
  for (const n of GLSLANG_PHANTOM_BUILTINS) s = s.replace(new RegExp(`\\b${n}\\b`, 'g'), `three_${n}`)
  return s
}

const finish = (src) => {
  let s = resolveIncludes(src)
  for (const [name, n] of LIGHT_NUMS) s = s.replaceAll(name, String(n))
  return dodgePhantomBuiltins(unrollLoops(s))
}

// WebGLProgram.js generatePrecision(), with precision 'highp'.
const PRECISION = [
  'float', 'int', 'sampler2D', 'samplerCube', 'sampler3D', 'sampler2DArray',
  'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow',
  'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DArray',
  'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray',
].map((t) => `precision highp ${t};`).join('\n') + '\n#define HIGH_PRECISION'

// SHORTCUT, stated plainly: three builds the two colour-management helpers by
// baking the working-colour-space matrix and the luminance weights into the
// source at compile time (getTexelEncodingFunction / getLuminanceFunction). The
// NUMBERS in them cannot affect whether anything compiles, so identity and the
// Rec.709 weights stand in for whatever ColorManagement is configured to. Every
// other line of both prologues is transcribed from WebGLProgram.js.
const COLOR_FNS = [
  CHUNK.colorspace_pars_fragment,
  'vec4 linearToOutputTexel( vec4 value ) {',
  '\treturn sRGBTransferOETF( vec4( value.rgb * mat3( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ), value.a ) );',
  '}',
  'float luminance( const in vec3 rgb ) {',
  '\tconst vec3 weights = vec3( 0.2126, 0.7152, 0.0722 );',
  '\treturn dot( weights, rgb );',
  '}',
].join('\n')

// NO TONE MAPPING, deliberately. Nothing in src/ assigns renderer.toneMapping,
// so it is NoToneMapping, so three emits neither `#define TONE_MAPPING` nor the
// tonemapping_pars_fragment chunk nor a toneMapping() function -- and
// <tonemapping_fragment> is `#ifdef TONE_MAPPING`-guarded, so nothing wants
// them. Declaring them anyway would be the permissive direction. Add them the
// day someone sets renderer.toneMapping, and not before.

// A built-in material is NOT a RawShaderMaterial, so under GLSL3 three rewrites
// `attribute`/`varying` into `in`/`out`, aliases texture2D, and injects the
// built-in matrices and vertex attributes. Straight from WebGLProgram.js lines
// 536-700 (vertex), 719-846 (fragment) and 866-889 (the GLSL3 rewrite).
const builtinPrologue = (stage, defines) => {
  const d = defines.filter(Boolean).join('\n')
  if (stage === 'vert') {
    return `#version 300 es
#define attribute in
#define varying out
#define texture2D texture
${PRECISION}
#define SHADER_TYPE MeshLambertMaterial
#define SHADER_NAME lambert
${d}
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
#ifdef USE_INSTANCING
	attribute mat4 instanceMatrix;
#endif
#ifdef USE_INSTANCING_COLOR
	attribute vec3 instanceColor;
#endif
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
#ifdef USE_TANGENT
	attribute vec4 tangent;
#endif
#if defined( USE_COLOR_ALPHA )
	attribute vec4 color;
#elif defined( USE_COLOR )
	attribute vec3 color;
#endif
`
  }
  return `#version 300 es
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define gl_FragDepthEXT gl_FragDepth
#define texture2D texture
#define textureCube texture
#define texture2DProj textureProj
#define texture2DLodEXT textureLod
#define texture2DProjLodEXT textureProjLod
#define textureCubeLodEXT textureLod
#define texture2DGradEXT textureGrad
#define texture2DProjGradEXT textureProjGrad
#define textureCubeGradEXT textureGrad
${PRECISION}
#define SHADER_TYPE MeshLambertMaterial
#define SHADER_NAME lambert
${d}
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;

${COLOR_FNS}
`
}

// The prop geometry: a BatchedMesh with a texture-layer attribute, lit by a sun
// and a hemisphere, in the scene's FogExp2, cut out (alphaTest 0.5) rather than
// blended, DoubleSide. Deliberately NOTHING beyond that -- every extra #define
// declares more built-ins, and a prologue that declares more than three does is
// the one failure mode worth fearing here: it would compile a superset of the
// real source and pass shaders the browser rejects. `batched: false` covers the
// gen-*.html editors, which put the same material on a plain Mesh -- a real
// second path, because the snow patch branches on USE_BATCHING.
//
// A BATCH ALSO CARRIES A COLOUR TEXTURE here, because every scatter calls
// setColorAt and because the LOD dissolve reads its alpha (material.js) -- so
// USE_BATCHING_COLOR is what compiles FADE_VERTEX at all, and without it this
// harness was type-checking the dissolve by not looking at it.
//
// The FRAGMENT half of that pair is USE_COLOR_ALPHA and NOT USE_COLOR, which is
// the shape three hands us today: r181 and the fork A-Frame 1.8 ships make the
// per-instance colour a vec4 and define USE_COLOR_ALPHA for any batch with a
// colour texture, where r180 defined USE_COLOR and kept vColor a vec3. Modelling
// the newer rule is the point -- it is what makes `diffuseColor *= vColor` reach
// diffuseColor.a, which is what COLOR_FRAGMENT exists to prevent. Three's own
// chunks are npm's, so this pairing also gives vColor the vec4 it has in both
// stages of the real program and the cross-stage check stays honest.
// AN INSTANCED MESH DEFINES USE_COLOR IN THE FRAGMENT STAGE ONLY, which is the
// one asymmetry here worth copying rather than tidying: three's vertex prologue
// keys USE_COLOR off `vertexColors` alone and lets <color_vertex> fold
// instanceColor in behind USE_INSTANCING_COLOR, while its fragment prologue
// defines USE_COLOR for any of the three colour sources (WebGLPrograms, the two
// prologue builders). Getting it backwards would compile COLOR_FRAGMENT out and
// pass a harness that never looks at the per-instance tint.
const propDefines = ({ batched = true, instanced = false, vertexColors = false } = {}) => {
  const shared = [
    '#define USE_FOG',
    '#define FOG_EXP2',
    vertexColors ? '#define USE_COLOR' : '',
    '#define DOUBLE_SIDED',
  ]
  const batchColor = batched ? '#define USE_COLOR_ALPHA' : ''
  return {
    vert: [
      batched ? '#define USE_BATCHING' : '', batched ? '#define USE_BATCHING_COLOR' : '',
      instanced ? '#define USE_INSTANCING' : '', instanced ? '#define USE_INSTANCING_COLOR' : '',
      batchColor, ...shared,
    ],
    frag: ['#define USE_ALPHATEST', instanced ? '#define USE_COLOR' : '', batchColor, ...shared],
  }
}

// A DataArrayTexture is all createPropMaterial wants of its atlas -- it never
// reads it, it only hands it to a uniform -- so a 1x1x1 stand-in is exact.
const atlas = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)

// A CLEAN COMPILE IS NOT EVIDENCE THE PATCHES LANDED. Every one of them is a
// plain string .replace() against three's shader; when the pattern does not
// match -- three renames a chunk, someone edits the anchor -- the replace is
// silent, the unpatched lambert shader compiles perfectly, and the check goes
// green on a shader containing none of our code. So each variant names the text
// it MUST contain, and a missing marker fails as loudly as a syntax error.
//
// SNOW AND MOSS ARE OPT-IN (`seasons: true`) and nothing in the world asks for
// them, so the marks split two ways: what every prop program carries, and what
// only a seasons program carries -- asserted PRESENT there and ABSENT everywhere
// else, because the whole point of the flag is that a default program pays for
// none of it, and a splice that leaked back in would compile perfectly.
const SEASON_MARKS = {
  vert: ['varying vec2 vMoss;', 'vMoss = vec2(', 'snowRoll', 'mossRoll', 'vSnowPos = vec4('],
  frag: [
    'float blobField( vec3 p, float warp, float fray )',
    'log( mossLoad',
    'snowNear > 0.004',
    'mossNear > 0.004',
  ],
}
const PROP_MARKS = {
  vert: ['attribute float texLayer;', 'vPropFade = propFade;'],
  frag: [
    'uniform sampler2DArray uAtlas;',
    'float ign( vec2 p )',
    'normal *= faceDirection;',
    // The dissolve's alpha channel, defended. If this line is missing, three's
    // own color_fragment is back and a fading prop is discarded whole by the
    // alphaTest instead of dithering -- which compiles perfectly and is only
    // visible from inside the world. See COLOR_FRAGMENT in material.js.
    'diffuseColor.rgb *= vColor.rgb;',
  ],
  absent: SEASON_MARKS,
}

// Every distinct program src/material.js can emit. The options are not cosmetic:
// billboardLayers and stripTiling each splice in a chunk that appears under NO
// other option, which is exactly where a bug hides unseen.
const PROP_VARIANTS = [
  ['plain, batched', createPropMaterial(atlas), { batched: true }, PROP_MARKS],
  ['plain, unbatched', createPropMaterial(atlas), { batched: false }, PROP_MARKS],
  ['vertexColors', createPropMaterial(atlas, { vertexColors: true }), { vertexColors: true }, PROP_MARKS],
  [
    'billboardLayers',
    createPropMaterial(atlas, { billboardLayers: [0, 1, 2] }),
    {},
    { vert: [...PROP_MARKS.vert, 'uBillboardLayers'], frag: PROP_MARKS.frag },
  ],
  // WHAT THE ROCK BEDS ACTUALLY DRAW, and the only INSTANCED compile in this
  // table. Since the beds came off BatchedMesh their dissolve slot is the
  // `aPropFade` attribute, which lives behind USE_INSTANCING and
  // PROP_FADE_ATTRIBUTE -- so a batched compile type-checks the OTHER branch of
  // FADE_VERTEX and reports success on a bed whose dissolve is dead GLSL, which
  // is exactly what shipped. `bump` rides along because it is the one option no
  // other variant here carries.
  [
    'instancedFade, bump',
    createPropMaterial(atlas, { instancedFade: true, bump: true }),
    { batched: false, instanced: true },
    {
      vert: [...PROP_MARKS.vert, '#define PROP_FADE_ATTRIBUTE', 'float fadeSlot = aPropFade'],
      frag: [...PROP_MARKS.frag, 'abs( vPropFade ) <= fadeT ) discard'],
    },
  ],
  [
    'stripTiling',
    createPropMaterial(atlas, { stripTiling: true }),
    {},
    { vert: [...PROP_MARKS.vert, 'vStripSeed'], frag: PROP_MARKS.frag },
  ],
  // THE WIND EMITS THREE DIFFERENT BODIES and all three have to be compiled
  // here, because the height weight is chosen at build time from the same two
  // flags: a strip reads its fraction straight out of uvProj, a bed that bakes
  // cards mixes the card fraction against the mesh ramp, and a bed with neither
  // takes the mesh ramp alone. Only the middle one has ever shipped in two
  // classes, so the outer two are exactly where an unseen bug would sit.
  //
  // Batched, because windVertex's yaw division and its root both go through
  // batchingMatrix and USE_BATCHING is what selects those lines -- an unbatched
  // compile would type-check the arithmetic and skip the part that can be wrong.
  [
    'wind, cards',
    createPropMaterial(atlas, { billboardLayers: [0, 1, 2], wind: 'tree' }),
    { batched: true },
    { vert: [...PROP_MARKS.vert, 'uWindDir', 'propSpun', 'wDirObj'], frag: PROP_MARKS.frag },
  ],
  [
    'wind, strips',
    createPropMaterial(atlas, { stripTiling: true, wind: 'grass' }),
    { batched: true },
    { vert: [...PROP_MARKS.vert, 'uWindDir', 'wAspect', 'vStripSeed'], frag: PROP_MARKS.frag },
  ],
  [
    'wind, meshes only',
    createPropMaterial(atlas, { wind: 'fern' }),
    { batched: true },
    { vert: [...PROP_MARKS.vert, 'uWindDir', 'uWindStrength'], frag: PROP_MARKS.frag },
  ],
  // THE PRESERVED SEASON CODE, compiled both ways SEASONS_VERTEX can go: batched
  // with cards (the card snow path and USE_BATCHING) and instanced with bump
  // (what the rock beds drew with it on, and USE_INSTANCING). Nothing in the
  // world builds either; the /gen benches with snow and moss sliders do.
  [
    'seasons, cards, batched',
    createPropMaterial(atlas, { billboardLayers: [0, 1, 2], seasons: true }),
    { batched: true },
    { vert: [...PROP_MARKS.vert, ...SEASON_MARKS.vert], frag: [...PROP_MARKS.frag, ...SEASON_MARKS.frag] },
  ],
  [
    'seasons, instanced, bump',
    createPropMaterial(atlas, { instancedFade: true, bump: true, seasons: true }),
    { batched: false, instanced: true },
    { vert: [...PROP_MARKS.vert, ...SEASON_MARKS.vert], frag: [...PROP_MARKS.frag, ...SEASON_MARKS.frag] },
  ],
  // THE FOREST'S OWN PROGRAM, with three things that appear under no other
  // option: the hem fray -- a `hem` attribute carried to the fragment stage and
  // a discard keyed on it -- the layer shift, a per-instance `aLayerShift`
  // added to the geometry's layer so one clump quad draws every clump picture,
  // and the tilt, a damped pitch away from the eye on the clump layers alone.
  // Instanced, as trees.js draws it, so aPropFade compiles too.
  [
    'trees: wind, cards, hem fray, layer shift, clump tilt, instanced',
    createPropMaterial(atlas, {
      billboardLayers: [0, 1, 2], wind: 'tree', vertexColors: true, instancedFade: true, layerShift: true,
      billboardTilt: { amount: 0.5, layers: [1, 2] },
      hemFray: { keep: 0.7, band: 0.6, straws: 24, wisp: 0.12, lumaLo: 0.05, lumaHi: 0.2 },
    }),
    { batched: false, instanced: true },
    {
      vert: [...PROP_MARKS.vert, 'attribute float hem;', 'vHem = hem;', 'aPropFade',
        'attribute float aLayerShift;', 'float propLayer = texLayer + aLayerShift;',
        'float bbTilt = step( 1.0 - 0.5, propLayer ) * step( propLayer, 2.0 + 0.5 );', 'atan( bbOrigin.y - cameraPosition.y, bbLen ) * 0.500 * bbTilt'],
      frag: [...PROP_MARKS.frag, 'varying float vHem;', 'hemTooth(', 'if ( vHem >'],
    },
  ],
  [
    'impostor bake',
    createImpostorBakeMaterial(atlas),
    { batched: false },
    {
      vert: ['attribute float texLayer;', 'vUvProj = uvProj;'],
      frag: ['uniform sampler2DArray uAtlas;', 'texture( uAtlas', 'normal *= faceDirection;'],
    },
  ],
  [
    'impostor bake: tree, hem fray',
    createImpostorBakeMaterial(atlas, { vertexColors: true, hemFray: { keep: 0.7, band: 0.6, straws: 24, wisp: 0.12, lumaLo: 0.05, lumaHi: 0.2 } }),
    { batched: false },
    {
      vert: ['attribute float texLayer;', 'vUvProj = uvProj;', 'attribute float hem;', 'vHem = hem;'],
      frag: ['uniform sampler2DArray uAtlas;', 'texture( uAtlas', 'varying float vHem;', 'hemTooth(', 'if ( vHem >'],
    },
  ],
]

// Collected here and checked after the compile loop: glslangValidator takes one
// stage at a time, so a varying declared `vec2` in the vertex stage and `float`
// in the fragment stage compiles TWICE and fails only when the driver links the
// two together. Nothing a single-stage front end does can see it.
const CROSS_STAGE = []
const MISSING_MARKS = []

for (const [label, material, opts, marks] of PROP_VARIANTS) {
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const defines = propDefines(opts)
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  const pad = `material.js    ${label}`.padEnd(38)
  SHADERS.push([`${pad}vert`, 'vert', builtinPrologue('vert', defines.vert), vert])
  SHADERS.push([`${pad}frag`, 'frag', builtinPrologue('frag', defines.frag), frag])
  // The file name goes IN the label rather than being printed in front of it,
  // because this list is no longer all one file -- water.js joins it below.
  CROSS_STAGE.push([`material.js    ${label}`, vert, frag])
  for (const [stage, src] of [['vert', vert], ['frag', frag]]) {
    for (const mark of marks[stage]) {
      if (!src.includes(mark)) MISSING_MARKS.push(`${label} ${stage}: ${mark}`)
    }
    for (const mark of marks.absent ? marks.absent[stage] : []) {
      if (src.includes(mark)) MISSING_MARKS.push(`${label} ${stage}: must NOT contain ${mark}`)
    }
  }
}

// --- src/water.js: the shared water material --------------------------------
//
// The lake surface, and the one ShaderMaterial in the world that `literal`
// cannot reach: its source is assembled in a constructor out of four imported
// GLSL blocks rather than living in one named const. So it is BUILT, from the
// same three stubs check-water-shader.mjs uses, and the finished strings are
// taken off the material.
//
// It earns the ten lines twice over. water.js says it in its own comments: a
// ShaderMaterial that fails to compile does not draw a dimmer lake, it draws
// nothing at all. And §11's underside path is a branch that nobody exercises
// by looking at the world -- you have to be standing in a river.
//
// THE TWO DEFINES ARE LOAD-BEARING. Without USE_FOG the fog chunks, the whole
// distance-fade block and the underside's own fade all compile to nothing and
// this check passes vacuously. Both worlds set scene.fog to a FogExp2, so both
// are what three would actually emit. COLOR_FNS is in the prologue because the
// shader ends on <colorspace_fragment>, which calls linearToOutputTexel -- a
// function three generates into the prologue rather than into a chunk.
//
// AND THE FRAGMENT STAGE IS COMPILED TWICE, once per state of WATER_CUBES,
// because both of them ship: the desktop draws with the cube captures and quest
// mode's `cubemap reflections` row compiles them out. Three injects
// material.defines into the prologue, so an untested variant here is a variant
// nothing compiles until the button is pressed in a headset -- and a
// ShaderMaterial that fails to compile draws no lake at all.
{
  const waterScene = new THREE.Scene()
  const water = new Water(waterScene, {
    sky: new Sky(waterScene),
    lighting: new WorldLighting(),
    probe: new SkyProbe(),
    world: new WorldProbe(),
  })
  // AND ONE MORE PROLOGUE LINE THAN F_PRE CARRIES, because this material is a
  // different KIND of ShaderMaterial from the four at the top of the table.
  // Those set `glslVersion: THREE.GLSL3` and declare their own `out vec4
  // fragColor`; water.js does not, so it is authored as GLSL1 and three
  // upgrades it -- and the upgrade is exactly this pair, which is what lets a
  // shader written against gl_FragColor keep working under ES 3.00. F_PRE
  // cannot simply grow it: handing a second output to a shader that already
  // declares one is a different error, not a fix.
  const GLSL1_OUT = 'out highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n'
  const FOG = '#define USE_FOG\n#define FOG_EXP2\n'
  const vert = finish(water.material.vertexShader)
  const frag = finish(water.material.fragmentShader)
  SHADERS.push(['water.js       VERT', 'vert', V_PRE + FOG, vert])
  for (const [label, cubes] of [['cubes', '#define WATER_CUBES\n'], ['sky only', '']]) {
    SHADERS.push([`water.js       FRAG ${label}`, 'frag', F_PRE + GLSL1_OUT + FOG + cubes + COLOR_FNS + '\n', frag])
    // The vertex stage has no WATER_CUBES in it, so the varyings it hands over
    // are the same pair either way -- but the fragment stage's READS of them
    // move between branches, which is exactly what this check is for.
    CROSS_STAGE.push([`water.js ${label}`, vert, cubes + frag])
  }
}

// --- src/lighting.js: the terrain's fragment patch ---------------------------
//
// THE ONE PATCH NOTHING ELSE HERE COVERS, and the gap was worth closing the day
// something went into it. `mode: 'vertex'` reaches this table already -- every
// prop variant above is patched by it -- but `mode: 'fragment'` has exactly one
// caller in the whole project, v2's terrain, and its extra code was until now
// compiled for the first time by whichever headset was pointed at a lake.
//
// It is also the branch that carries the most: the shadow and occlusion sample
// per pixel, the night lift, the aerial ramp and the caustic net. A
// ShaderMaterial that fails here does not draw a dimmer world; it drops the
// terrain.
//
// `vWorldPos` is declared into the stub rather than patched in, because that is
// where it comes from in the real thing -- terrain-material.js has carried the
// varying since v1's surface grain, which is why the patch takes its name as an
// argument instead of declaring one of its own.
//
// AND BOTH MODES ACROSS ALL THREE VARIANTS, which is nine programs and is the
// point. The patch has two compile-time axes now (see the header of
// lighting.js): `maps`, which the whole /v2 route currently runs on the unready
// side of, and `enabled`, the cost A/B (setEnabled), which no menu row flips
// any more and which stays compiled here so it still can be. The unready one
// is what every material in the world actually ships as today.
//
// The vertex mode is here in its own right rather than only under the blade bed
// below, because its builds declare DIFFERENT VARYINGS -- vec3 vWlShade with
// maps, float vWlNear without, plus vWlBed when caustics are asked for -- and a
// cross-stage mismatch there is a link error, which is the one class of failure
// a per-stage compile cannot see.
const WL_MAPS_N = 4
for (const variant of ['maps', 'unready', 'off']) {
  const lighting = new WorldLighting()
  if (variant === 'maps') {
    lighting.setMaps(
      new Uint8Array(WL_MAPS_N * WL_MAPS_N * AZIMUTHS),
      new Uint8Array(WL_MAPS_N * WL_MAPS_N),
      WL_MAPS_N
    )
  }
  if (variant === 'off') lighting.setEnabled(false)

  const lib = THREE.ShaderLib.lambert
  const fragStub = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: `varying vec3 vWorldPos;\n${lib.fragmentShader}`,
    defines: {},
  }
  const fragMat = new THREE.MeshLambertMaterial()
  lighting.patch(fragMat, { mode: 'fragment', cacheKey: 'check', worldPosVarying: 'vWorldPos' })
  fragMat.onBeforeCompile(fragStub, { capabilities: { isWebGL2: true } })

  const defines = ['#define USE_FOG', '#define FOG_EXP2']
  const frag = finish(fragStub.fragmentShader)
  SHADERS.push([`lighting.js    fragment ${variant.padEnd(7)}   frag`, 'frag', builtinPrologue('frag', defines), frag])

  const vertStub = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const vertMat = new THREE.MeshLambertMaterial()
  lighting.patch(vertMat, { mode: 'vertex', cacheKey: 'check-vertex' })
  vertMat.onBeforeCompile(vertStub, { capabilities: { isWebGL2: true } })

  const vsrc = finish(vertStub.vertexShader)
  const fsrc = finish(vertStub.fragmentShader)
  SHADERS.push([`lighting.js    vertex   ${variant.padEnd(7)}   vert`, 'vert', builtinPrologue('vert', defines), vsrc])
  SHADERS.push([`lighting.js    vertex   ${variant.padEnd(7)}   frag`, 'frag', builtinPrologue('frag', defines), fsrc])
  CROSS_STAGE.push([`lighting.js vertex ${variant}`, vsrc, fsrc])

  // AND THE WET VERTEX BUILD, which is a fourth program per variant and the only
  // one anything is ever drawn with under a lake: the plain terrain rung swaps to
  // it at the waterline (v2/main.js). It is the one build where the caustic net
  // rides a varying this file declares rather than one the material already had,
  // so a `vWlBed` that reached only one stage would be a link error at the exact
  // moment she wades in -- which is what CROSS_STAGE is for.
  const wetStub = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const wetMat = new THREE.MeshLambertMaterial()
  lighting.patch(wetMat, { mode: 'vertex', cacheKey: 'check-vertex-wet', caustics: true })
  wetMat.onBeforeCompile(wetStub, { capabilities: { isWebGL2: true } })

  const wvsrc = finish(wetStub.vertexShader)
  const wfsrc = finish(wetStub.fragmentShader)
  SHADERS.push([`lighting.js    wet vert ${variant.padEnd(7)}   vert`, 'vert', builtinPrologue('vert', defines), wvsrc])
  SHADERS.push([`lighting.js    wet vert ${variant.padEnd(7)}   frag`, 'frag', builtinPrologue('frag', defines), wfsrc])
  CROSS_STAGE.push([`lighting.js vertex wet ${variant}`, wvsrc, wfsrc])

  // The marks, per variant, and the ABSENCES are as load-bearing as the
  // presences: a horizon lookup surviving into the unready build is the dead
  // fetch this variant exists to remove, and anything at all surviving into the
  // `off` build is a row that cannot be switched off -- which is exactly the
  // state this axis was added to get out of.
  //
  // The aerial mix and the caustic net share the fog slot, so one anchor going
  // stale takes both out at once and neither absence is visible from anywhere
  // but a lake bed.
  const wlCore = ['float wlCaustic( vec2 p, float t )', 'uCaustic.x > 0.0', 'aerialKeep']
  const expectFrag = variant === 'off' ? [] : [...wlCore, ...(variant === 'maps' ? ['wlSun( vWorldPos.xz )'] : [])]
  const banFrag = variant === 'off' ? [...wlCore, 'wlSun'] : (variant === 'unready' ? ['wlSun', 'uHorizonMap'] : [])
  for (const mark of expectFrag) {
    if (!frag.includes(mark)) MISSING_MARKS.push(`lighting.js fragment ${variant} frag: ${mark}`)
  }
  for (const mark of banFrag) {
    if (frag.includes(mark)) MISSING_MARKS.push(`lighting.js fragment ${variant} frag: emitted ${mark}, should not`)
  }
  const expectVert = { maps: ['vWlShade'], unready: ['vWlNear'], off: [] }[variant]
  const banVert = { maps: [], unready: ['uHorizonMap', 'wlSun'], off: ['vWlShade', 'vWlNear'] }[variant]
  for (const mark of expectVert) {
    if (!vsrc.includes(mark) || !fsrc.includes(mark)) MISSING_MARKS.push(`lighting.js vertex ${variant}: ${mark}`)
  }
  for (const mark of banVert) {
    if (vsrc.includes(mark)) MISSING_MARKS.push(`lighting.js vertex ${variant} vert: emitted ${mark}, should not`)
  }

  // THE DRY VERTEX BUILD MUST STAY CLEAN, and that absence is the whole reason
  // the wet one is a second program rather than a uniform: a `vWlBed` or a
  // `wlCaustic` in the build every hillside in the world is drawn with is the
  // cost this arrangement exists to keep off them, and nothing about the picture
  // would say it had leaked.
  for (const mark of ['vWlBed', 'wlCaustic']) {
    if (vsrc.includes(mark) || fsrc.includes(mark)) {
      MISSING_MARKS.push(`lighting.js vertex ${variant}: emitted ${mark} on the dry build, should not`)
    }
  }
  if (variant === 'off') {
    // `off` wins over the flag, like it wins over everything else here: the row
    // that switches this system out has to switch the net out with it.
    if (wvsrc.includes('vWlBed') || wfsrc.includes('wlCaustic')) {
      MISSING_MARKS.push('lighting.js vertex wet off: emitted the net with the whole system off')
    }
  } else {
    if (!wvsrc.includes('vWlBed = wlWorld;')) MISSING_MARKS.push(`lighting.js vertex wet ${variant} vert: vWlBed`)
    for (const mark of ['varying vec3 vWlBed;', 'float wlCaustic( vec2 p, float t )', 'uCaustic.x > 0.0']) {
      if (!wfsrc.includes(mark)) MISSING_MARKS.push(`lighting.js vertex wet ${variant} frag: ${mark}`)
    }
  }
}

// --- src/props/grass-blades.js: the blade bed --------------------------------
//
// BOTH BUILDS, because they are two programs -- see the cacheKey -- and because
// the wind flag is a toggle on /gen-grass, so the still one is compiled by
// anyone who presses it. And with the vertex-mode lighting patch chained on
// top, which is what the bed actually draws with: `lighting.patch` wraps
// onBeforeCompile rather than replacing it, so compiling the material alone
// would be checking a shader nothing renders.
//
// USE_INSTANCING and USE_INSTANCING_COLOR are not optional here. Everything
// this material adds -- the wind bend, the per-clump tip brightness -- lives
// inside `#ifdef USE_INSTANCING`, so a compile without them type-checks an
// empty patch and reports success.
// AND BOTH FADE BUILDS, which is a separate program again and is the one the
// bed actually ships. The dissolve spans both stages -- FADE_VERTEX resolves the
// coverage, FADE_FRAGMENT stipples against it -- and the vertex half sits behind
// PROP_FADE_ATTRIBUTE, a define this material has to make for itself because the
// card beds get theirs from createPropMaterial. Compiling only the
// `instancedFade: false` build type-checks the bed with its dissolve deleted,
// which is exactly the shape of failure the marks below are here to name: a
// program that compiles, links, draws, and pops.
for (const wind of [true, false]) for (const instancedFade of [false, true]) {
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const mat = createBladeMaterial({ wind, instancedFade })
  new WorldLighting().patch(mat, { mode: 'vertex', cacheKey: 'check-blade' })
  mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const defines = [
    '#define USE_COLOR', '#define USE_INSTANCING', '#define USE_INSTANCING_COLOR',
    '#define USE_FOG', '#define FOG_EXP2', '#define DOUBLE_SIDED',
  ]
  const label = `grass-blades ${wind ? 'wind   ' : 'no wind'}${instancedFade ? ' fade' : '     '}`
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}       vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}       frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])

  // The tip ramp is the anchor that would go stale silently: three renaming or
  // reordering <color_vertex> takes the gradient out of every blade in the bed
  // and leaves a shader that compiles and draws a flat clump.
  const marks = ['vColor.rgb *= mix( 1.0, aTipMul, aBladeT )', 'attribute float aTipMul']
  if (wind) marks.push('transformed.xz += bladeDir * bend', 'attribute float aBladeSeed')
  // The dissolve, named at all three ends: the define that makes the block live
  // GLSL, the slot it reads, and the collapse that is the whole visible effect
  // of it. The mix in particular is the difference between a bed that thins out
  // a blade at a time and one that grows back out of the ground.
  if (instancedFade) {
    marks.push('#define PROP_FADE_ATTRIBUTE', 'float fadeSlot = aPropFade', 'vPropFade = propFade')
  }
  for (const mark of marks) {
    if (!vert.includes(mark)) MISSING_MARKS.push(`${label} vert: ${mark}`)
  }
  // Undoing three's double-sided normal flip. Loud here because losing it is
  // silent at runtime: the bed still draws, and half of every clump is black.
  if (!frag.includes('normal *= faceDirection')) {
    MISSING_MARKS.push(`${label} frag: normal *= faceDirection`)
  }
  // The half that is actually visible. A vertex stage that resolves vPropFade
  // and a fragment stage that never tests it is a bed that pops, and the
  // varying check below will not catch it -- vPropFade would be declared in
  // both stages and simply unused in one.
  if (instancedFade) {
    for (const mark of ['float fadeT = ign( gl_FragCoord.xy )', 'abs( vPropFade ) <= fadeT ) discard']) {
      if (!frag.includes(mark)) MISSING_MARKS.push(`${label} frag: ${mark}`)
    }
  } else if (frag.includes('vPropFade')) {
    MISSING_MARKS.push(`${label} frag: the dissolve leaked into the build that is meant to have none`)
  }
  if (!wind && vert.includes('uWindAmp')) MISSING_MARKS.push(`${label} vert: wind leaked into the still build`)
}

// --- src/v2/render/fish.js: the swim bend --------------------------------------
//
// One program per species (the wave number is a define), each a Lambert with
// the fish's own onBeforeCompile under the vertex-mode lighting patch, which is
// the only way it ever compiles. USE_INSTANCING and USE_INSTANCING_COLOR because
// every fish is an instance and the bend reads a per-instance attribute; a
// compile without them would type-check the tail against nothing. USE_MAP
// because the map is the one texture a fish ever wears.
{
  const FISH_ASSETS = JSON.parse(readFileSync(new URL('../public/fauna/fish.json', import.meta.url), 'utf8'))
  const fish = new Fish(new THREE.Scene(), { heightAt: () => 0 }, { levelAt: () => null }, { assets: FISH_ASSETS })
  for (const sp of fish.species) {
    const lib = THREE.ShaderLib.lambert
    const shader = {
      uniforms: THREE.UniformsUtils.clone(lib.uniforms),
      vertexShader: lib.vertexShader,
      fragmentShader: lib.fragmentShader,
      defines: {},
    }
    new WorldLighting().patch(sp.material, { mode: 'vertex', cacheKey: `check-fish-${sp.id}` })
    sp.material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
    const defines = [
      `#define FISH_WAVE_K ${sp.material.defines.FISH_WAVE_K}`,
      '#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv',
      '#define USE_FOG', '#define FOG_EXP2',
    ]
    const label = `fish ${sp.id.padEnd(15)}`
    const vert = finish(shader.vertexShader)
    const frag = finish(shader.fragmentShader)
    SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
    SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
    CROSS_STAGE.push([label, vert, frag])
    // The bend itself. Losing it is silent: the fish still draw, stiff as decoys.
    if (!vert.includes('transformed.x += aBend * ( aSwim.y * sin( aSwim.x - FISH_WAVE_K * position.z ) + aSwim.z )')) MISSING_MARKS.push(`${label} vert: the swim bend`)
    if (!vert.includes('transformed.y += aBend * aSwim.w')) MISSING_MARKS.push(`${label} vert: the climb lift`)
    // Underwater a fish has no glint of its own -- the surface does that -- so no specular term may creep in.
    if (frag.includes('reflectedLight.directSpecular +=')) MISSING_MARKS.push(`${label} frag: a specular term on an underwater fish`)
  }
}

// --- src/v2/render/critters.js: the glint, the hue and the card -----------------
//
// What a frog wears exactly, and a crab's fragment stage: a Standard at a
// uniform roughness whose onBeforeCompile is glint then hueVary, under the
// vertex-mode lighting patch. Compiled here because the glint line lands in the
// slot the lighting patch also splices into, and the hue turn is a block of
// GLSL of its own after map_fragment.
{
  const material = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0 })
  material.onBeforeCompile = (shader) => { glint(shader); hueVary(shader) }
  new WorldLighting().patch(material, { mode: 'vertex', cacheKey: 'check-glint' })
  const lib = THREE.ShaderLib.standard
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
  const defines = ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_FOG', '#define FOG_EXP2']
  const label = 'critters glint       '
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])
  // The glint is the sun's GGX lobe, and it has to sit in the same shadow as the diffuse or a frog shines in the dark under a ridge.
  if (!frag.includes('reflectedLight.directSpecular +=') || !/reflectedLight\.directSpecular \*= .* mix\( uFarLight\.x, 1\.0, wlNear \);/.test(frag)) MISSING_MARKS.push(`${label} frag: the shadowed glint`)
  // ...and then GLINT tames it; without the scale a jaw edge catches the whole lobe.
  if (!frag.includes(`reflectedLight.directSpecular *= ${GLINT.toFixed(2)};`)) MISSING_MARKS.push(`${label} frag: the glint scale`)
  // Tripo's roughness map is not shipped, so nothing may read the colour alpha as roughness.
  if (frag.includes('sampledDiffuseColor.a')) MISSING_MARKS.push(`${label} frag: the colour alpha read as roughness`)
  // The hue turn, at both ends: the per-instance attribute in, the rotation applied to the sampled colour.
  if (!vert.includes('vHue = aHue;')) MISSING_MARKS.push(`${label} vert: the hue attribute`)
  if (!frag.includes('cross( hueK, diffuseColor.rgb )')) MISSING_MARKS.push(`${label} frag: the hue turn`)
}

// The critter card: a Lambert cutout with the hue turn again, and the double-sided normal flip undone.
{
  const material = createCritterCardMaterial('check-card')
  new WorldLighting().patch(material, { mode: 'vertex', cacheKey: 'check-card' })
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
  const defines = ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_ALPHATEST', '#define DOUBLE_SIDED', '#define USE_FOG', '#define FOG_EXP2']
  const label = 'critters card        '
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])
  if (!frag.includes('cross( hueK, diffuseColor.rgb )')) MISSING_MARKS.push(`${label} frag: the hue turn`)
  if (!frag.includes('normal *= faceDirection;')) MISSING_MARKS.push(`${label} frag: the flip undone`)
  if (frag.includes('gl_FragCoord.x + gl_FragCoord.y')) MISSING_MARKS.push(`${label} frag: a dither the card no longer wears`)
}

// The grasshopper card (grasshoppers.js): a Lambert cutout under a per-instance
// tint whose triangle overhangs its quad, so the fragment stage cuts
// everything past 0..1 UV before the map is read, then the double-sided flip
// undone as the critter card does. Compiled here because the cut reads vMapUv, which only USE_MAP
// declares, and it lands before the slot the lighting patch splices around.
{
  const stub = { heightAt: () => 0, heightAndSlopeAt: () => ({ h: 0, tan: 0, gx: 0, gz: 0 }), snowLineAt: () => 100 }
  const material = new Grasshoppers(new THREE.Scene(), stub, { levelAt: () => null }, { walk: stub, map: new THREE.Texture() }).material
  new WorldLighting().patch(material, { mode: 'vertex', cacheKey: 'check-grasshopper' })
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
  const defines = ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_ALPHATEST', '#define DOUBLE_SIDED', '#define USE_FOG', '#define FOG_EXP2']
  const label = 'grasshopper card     '
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])
  const cut = frag.indexOf('vMapUv.x > 1.0 || vMapUv.y < 0.0 || vMapUv.y > 1.0 ) discard;')
  if (cut < 0 || cut > frag.indexOf('texture2D( map, vMapUv )')) MISSING_MARKS.push(`${label} frag: the overhang cut before the map read`)
  if (!frag.includes('normal *= faceDirection;')) MISSING_MARKS.push(`${label} frag: the flip undone`)
}

// The generated props' three programs (gen-props.js): the mesh with the rim
// dissolve over `aPropFade`, the axis card and the spun card. The card's normal
// is the world's, not the instance's, and both card programs are checked for it.
for (const [label, opts, defines] of [
  ['gen-prop mesh        ', {}, ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_FOG', '#define FOG_EXP2']],
  ['gen-prop card        ', { card: true }, ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_ALPHATEST', '#define DOUBLE_SIDED', '#define USE_FOG', '#define FOG_EXP2']],
  ['gen-prop spun card   ', { card: true, billboard: true }, ['#define USE_INSTANCING', '#define USE_INSTANCING_COLOR', '#define USE_MAP', '#define MAP_UV uv', '#define USE_ALPHATEST', '#define DOUBLE_SIDED', '#define USE_FOG', '#define FOG_EXP2']],
]) {
  const material = createGenPropMaterial(opts)
  new WorldLighting().patch(material, { mode: 'vertex', cacheKey: `check-${label.trim()}` })
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  material.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])
  if (!vert.includes('float fadeSlot = aPropFade')) MISSING_MARKS.push(`${label} vert: the instanced fade slot`)
  if (!frag.includes('abs( vPropFade ) <= fadeT ) discard')) MISSING_MARKS.push(`${label} frag: the dither`)
  if (!!opts.card !== frag.includes('vec3 cnUp = normalize( ( viewMatrix')) MISSING_MARKS.push(`${label} frag: the card normal ${opts.card ? 'missing' : 'on a mesh'}`)
  if (!!opts.billboard !== vert.includes('vec2 bbTo = cameraPosition.xz')) MISSING_MARKS.push(`${label} vert: the spin ${opts.billboard ? 'missing' : 'on a flat card'}`)
}

// --- src/terrain/terrain-material.js: the ground itself ----------------------
//
// THE LARGEST onBeforeCompile PATCH IN THE PROJECT and, until this block, the
// only one compiled for the first time by the headset it was deployed to. That
// is a bad loop to be in: the edit-to-error path ran through a build, a deploy
// and a Quest, and a terrain shader that fails to link does not draw a plainer
// hillside, it draws nothing at all.
//
// ALL FOUR VARIANTS, because each one is a different body of GLSL and each is
// invisible to a check that compiles the others. The atlas branch carries the
// triplanar stone fetches, the fine stone layer and the ground tiles, all inside
// `${stone ? ... : ''}`. The LO-FI branch is the headset's middle rung: it
// deletes those and grows a triplanar grit path and a set of `${lofi ? ...}`
// gates that exist under no other option. LEAN is lo-fi again with two more
// fetches gone, and it is the ONLY variant that patches the vertex shader, so it
// is the only one where a cross-stage varying mismatch is even possible. All
// four are separate programs in the real renderer too; see the cacheKey at the
// bottom of terrain-material.js.
//
// USE_COLOR because the material is built with vertexColors, and the fog pair
// because v2's scene carries FogExp2 -- which is now load-bearing rather than
// incidental, since auroraDetailK reads `fogDensity` out of the fog chunk.
//
// USE_COLOR_ALPHA ALONGSIDE IT, AND vColor IS A vec4 HERE. Not because the
// terrain geometry has a four-wide colour attribute -- it does not -- but
// because the three A-Frame 1.8 ships declares `varying vec4 vColor` for every
// spelling of the guard, with no vec3 form left in the bundle at all. npm's r180
// still has both, so pairing the defines is what gives this harness the type the
// headset actually compiles; without it a `vColor *= vec3(...)` type-checks in
// node and fails to compile on the device. Same trick, same reason, as
// propDefines above.
const TERRAIN_DEFINES = ['#define USE_COLOR', '#define USE_COLOR_ALPHA', '#define USE_FOG', '#define FOG_EXP2']
const TERRAIN_VARIANTS = [
  ['no atlas   ', { atlas: false, lofi: false }],
  ['with atlas ', { atlas: true, lofi: false }],
  // Built WITH an atlas on purpose: that is how main.js builds it, and `lofi`
  // has to win over a non-null atlas or the headset compiles the stone fetches
  // it asked to be rid of. The banned marks below are what hold that.
  ['lo-fi      ', { atlas: true, lofi: true }],
  // Same, one rung down. `lean` has to win over BOTH a non-null atlas and an
  // unset lofi flag, since it implies lofi inside the factory.
  ['lean       ', { atlas: true, lean: true }],
  // Same again, one flag further down: `axis` has to win over an unset `lean`
  // as well, since it implies lean which implies lofi. The marks below are what
  // hold the swap itself -- one helper in, the triplanar one out.
  ['axis       ', { atlas: true, axis: true }],
  // The bottom rung. Implies axis, so it inherits every axis expectation; what is
  // its own is that the colour half keeps the speckle and loses the two mixes and
  // the guard that wrapped them.
  ['grain      ', { atlas: true, grain: true }],
]
for (const [variant, opts] of TERRAIN_VARIANTS) {
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const atlas = opts.atlas ? new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1) : null
  const mat = createTerrainMaterial({ atlas, lofi: opts.lofi, lean: opts.lean, axis: opts.axis, grain: opts.grain })
  mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const defines = TERRAIN_DEFINES
  const label = `terrain-material ${variant}`
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', defines), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', defines), frag])
  CROSS_STAGE.push([label, vert, frag])

  // Anchors, not prose. Each one is a replace target that would take a whole
  // layer out silently if it ever went stale: the two baked detail fields
  // everything is built on, the snow line, the haze gate that decides what the
  // far field pays for, the bump the normal pass consumes from the colour pass,
  // and -- for the atlas variant only -- the triplanar block.
  //
  // The grit mark includes `textureGrad(` deliberately. Every grit fetch sits
  // inside a guard that folds in distance and the surface classification, so
  // none is quad-uniform and an implicit-LOD `texture()` there is undefined --
  // it compiles, it looks right on desktop, and it draws a line of sparkling
  // pixels down every snow border on the headset. The mark is what makes that a
  // gate failure rather than a bug report.
  //
  // The coarse macro sample is the single exception and is marked separately
  // below, because it is the one that sits at top-level flow.
  const marks = [
    'textureGrad( uGritArr',
    'auroraSnowD',
    'auroraDetailK',
    'auroraBW',
    'normal + ( viewMatrix * vec4( auroraBump, 0.0 ) )',
    // The coarse grit's two fades, which must stay TWO. One fetch feeds both
    // the grain and the relief, and the relief outlives the grain by 29 m; a
    // well-meaning tidy that collapses them back into one auroraNear is exactly
    // how the lighting silently loses that range again.
    'auroraReliefAmt = auroraRelief * uRelief',
    'auroraGrain = mix( 0.5, auroraGR, auroraNear )',
  ]
  const banned = []
  const vertMarks = []
  // Each flag implies the one above it inside the factory -- grain => axis =>
  // lean => lofi -- so every expectation has to be asserted from the lowest rung
  // that reaches it. Reading opts.lofi alone would let the lean and axis rows
  // pass while silently compiling the stone fetches.
  const axis = opts.axis || opts.grain
  const lean = opts.lean || axis
  const cheap = opts.lofi || lean
  if (cheap) {
    // Whatever keeps a cliff reading as rock once the stone photograph is gone.
    // Exactly ONE of these two exists in any build, and which one is the whole
    // difference between the lean and axis rungs: three fetches behind a
    // divergent branch, or one at uniform flow.
    marks.push(axis ? 'float auroraGritAxis(' : 'float auroraGritTri(')
    banned.push(axis ? 'auroraGritTri' : 'auroraGritAxis')
    // What lo-fi is FOR. Each of these is a fetch per fragment that the middle
    // rung exists to delete, and every one of them would come back silently if
    // a `${stone ? ...}` guard ever went back to `${atlas ? ...}`.
    banned.push('uAtlas', 'auroraStoneK', 'auroraGroundTile', 'auroraMF = textureGrad')
  } else {
    banned.push('auroraGritTri', 'auroraGritAxis')
    if (opts.atlas) marks.push('auroraStoneK > 0.004')
  }
  if (lean) {
    // What LEAN is for, and both halves have to be checked from both ends.
    //
    // The 1 km layer moved to the vertex stage, so the fragment stage must not
    // so much as DECLARE the sampler -- banning the uniform name is what makes
    // a half-done revert (varying added, fetch left behind) a gate failure
    // rather than a shader that quietly costs what it always did.
    vertMarks.push('textureLod( uMacroMap', 'varying vec2 vMacro')
    marks.push('float auroraMR = vMacro.x')
    banned.push('uMacroMap')
    // The fine grit rung, with the sparkle and the flecks that rode on it. Its
    // fade is the one name that appears nowhere else, so its absence is the
    // whole block's absence.
    banned.push('auroraMicroFade')
  } else {
    // THE ONE FETCH IN THE FILE THAT MAY TAKE AN IMPLICIT LOD, because it is
    // the only one at top-level flow. See the note above the marks.
    marks.push('texture( uMacroMap, auroraMU )')
  }
  if (opts.grain) {
    // What grain is for, from both ends. The speckle is the one colour effect
    // that survives -- lose it and the rung stops being a texture setting -- and
    // the two mixes and the guard that wrapped them must be gone from the source,
    // not merely reaching zero at runtime.
    marks.push('( auroraGrain - 0.5 ) * uSpeckle * auroraProc')
    banned.push('uDirt, smoothstep( 0.813, 1.0, auroraGrain )', 'if ( auroraNear > 0.004 ) {')
  } else if (lean) {
    // The colour guard, which every rung above grain still pays a branch for so
    // that fragments past FADE_FAR skip both mixes. See the GRAIN block.
    marks.push('if ( auroraNear > 0.004 ) {')
  }
  for (const mark of marks) {
    if (!frag.includes(mark)) MISSING_MARKS.push(`${label} frag: ${mark}`)
  }
  for (const mark of banned) {
    if (frag.includes(mark)) MISSING_MARKS.push(`${label} frag: emitted ${mark}, should not`)
  }
  for (const mark of vertMarks) {
    if (!vert.includes(mark)) MISSING_MARKS.push(`${label} vert: ${mark}`)
  }
}

// The PLAIN rung, the base of the stipple rung the world draws -- see
// plainTerrainRung in v2/main.js. It shares nothing with the six above: a stock Lambert whose only
// patch is the forest tint and two exposure stages in the VERTEX shader, so the
// fragment half here is three's own and the whole risk lives in five lines of GLSL.
//
// Compiled because those five lines touch vColor, which is the one name in this
// file whose TYPE differs between npm's three and the headset's. Under the
// TERRAIN_DEFINES pair it is the vec4 the device declares, so a bare assignment
// fails here instead of on a Quest.
{
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const source = createTerrainMaterial({ atlas: null, axis: true })
  const mat = createPlainTerrainMaterial(source)
  mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const label = 'terrain-material plain      '
  const vert = finish(shader.vertexShader)
  const frag = finish(shader.fragmentShader)
  SHADERS.push([`${label}  vert`, 'vert', builtinPrologue('vert', TERRAIN_DEFINES), vert])
  SHADERS.push([`${label}  frag`, 'frag', builtinPrologue('frag', TERRAIN_DEFINES), frag])
  CROSS_STAGE.push([label, vert, frag])

  // JUST THE INJECTED BLOCK, which is what the patch owns: three's own
  // color_vertex writes `vColor *= color` further up and is not ours to judge.
  // The patch lands after project_vertex -- the first hook past the batching
  // matrix, so mvPosition is the real view-space position -- and before the
  // next include.
  const from = shader.vertexShader.indexOf('#include <project_vertex>')
  const block = shader.vertexShader.slice(from, shader.vertexShader.indexOf('#include', from + 26))

  // The tint and the two multiplies are the whole material -- lose the tint and
  // the far wood is a scatter of cards on meadow, lose either multiply and the
  // ground ships at the wrong level, green ground grey or a snowfield clipped
  // to a flat sheet. The tint must ramp on mvPosition, which is the batched
  // position; a modelMatrix * position here is the chunk-local one.
  for (const mark of [
    'vColor.rgb = mix( vColor.rgb, uForestTint, forest * smoothstep( 100.0, 250.0, length( mvPosition.xyz ) ) )',
    'vColor.rgb *= mix( vec3( 1.0 ), uGrassTone',
    'vColor.rgb *= mix( 1.0, uSnowAlbedo',
  ]) {
    if (!block.includes(mark)) MISSING_MARKS.push(`${label} vert: ${mark}`)
  }
  if (!vert.includes('attribute float forest;')) MISSING_MARKS.push(`${label} vert: attribute float forest`)
  // None may be written bare, for the vec4 reason above. The vec3 form fails
  // to compile on the device, which the row above now catches; the FLOAT form
  // compiles there and silently scales alpha, which nothing else would catch.
  const code = block.replace(/\/\/[^\n]*/g, '').replace(/vColor\.rgb\s*\*?=/g, '')
  if (/vColor\s*\*?=/.test(code)) {
    MISSING_MARKS.push(`${label} vert: assigns to bare vColor, which is a vec4 on the headset`)
  }
  // Nothing of the fragment ladder may follow it here. This rung exists to not
  // pay for that, so a grit fetch appearing in it is the whole point being lost.
  for (const mark of ['uGritArr', 'auroraDetailK', 'uMacroMap']) {
    if (frag.includes(mark)) MISSING_MARKS.push(`${label} frag: emitted ${mark}, should not`)
  }

  // THE STIPPLE TWIN: the same rung with the per-face fetch, compiled under the
  // same defines.
  const stippleShader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const stippleMat = createPlainTerrainMaterial(source, { stipple: true })
  stippleMat.onBeforeCompile(stippleShader, { capabilities: { isWebGL2: true } })
  const sLabel = 'terrain-material stipple    '
  const sVert = finish(stippleShader.vertexShader)
  const sFrag = finish(stippleShader.fragmentShader)
  SHADERS.push([`${sLabel}  vert`, 'vert', builtinPrologue('vert', TERRAIN_DEFINES), sVert])
  SHADERS.push([`${sLabel}  frag`, 'frag', builtinPrologue('frag', TERRAIN_DEFINES), sFrag])
  CROSS_STAGE.push([sLabel, sVert, sFrag])
  // Exactly the one implicit-LOD fetch on the FLAT face frame and the tilt, and
  // none of the ladder: a textureGrad appearing here is the cost creeping back
  // in, a second fetch is the macro layer creeping back in. (dFdx is not
  // checked: three's own FLAT_SHADED guard carries one in every Lambert.)
  if (!sVert.includes('attribute vec4 stipple;')) MISSING_MARKS.push(`${sLabel} vert: attribute vec4 stipple`)
  for (const mark of ['flat varying vec4 vStipFrame;', 'texture( uStippleMap, auroraStipUv )', 'auroraStippleTilt']) {
    if (!sFrag.includes(mark)) MISSING_MARKS.push(`${sLabel} frag: ${mark}`)
  }
  const fetches = sFrag.replace(/\/\/[^\n]*/g, '').match(/texture\( uStippleMap/g)?.length ?? 0
  if (fetches !== 1) MISSING_MARKS.push(`${sLabel} frag: ${fetches} stipple fetches, wants exactly 1`)
  for (const mark of ['textureGrad', 'auroraDetailK', 'auroraDist', 'uMacroMap', 'uGritArr', 'sampler2DArray']) {
    if (sFrag.includes(mark)) MISSING_MARKS.push(`${sLabel} frag: emitted ${mark}, should not`)
  }
}

// Returns null when the shader compiled, or the validator's output when it did
// not. Also hands back the file it wrote, which for the assembled prop programs
// is the only copy of that text that exists anywhere.
function compile(name, stage, pre, body) {
  // The shader may carry its own #version (raw materials must not, but check
  // rather than assume) -- strip it so the prologue's is the only one.
  const full = pre + body.replace(/^\s*#version[^\n]*\n/, '')
  const file = join(tmp, `${name.trim().replace(/\W+/g, '-')}.${stage}`)
  writeFileSync(file, full)
  try {
    execFileSync(VALIDATOR, ['-S', stage, file], { stdio: 'pipe' })
    return { file, full, out: null }
  } catch (e) {
    return { file, full, out: (e.stdout?.toString() || '') + (e.stderr?.toString() || '') }
  }
}

let bad = 0
for (const [name, stage, pre, body, raw] of SHADERS) {
  const { file, full, out } = compile(name, stage, pre, body)
  if (out === null) {
    console.log(`  ok    ${name}${raw ? '   (raw)' : ''}`)
    continue
  }
  bad++
  console.log(`  FAIL  ${name}`)
  console.log(`        source: ${file}`)
  const lines = full.split('\n')
  for (const line of out.split('\n')) {
    if (!/^ERROR: \d+:(\d+)/.test(line)) continue
    const n = Number(/^ERROR: \d+:(\d+)/.exec(line)[1])
    // Report the line in the ORIGINAL shader, not the concatenated one, so
    // the number is something you can go and edit.
    const own = n - pre.split('\n').length + 1
    console.log(`        ${line.trim()}`)
    if (lines[n - 1] !== undefined) console.log(`          line ${own} of the literal: ${lines[n - 1].trim()}`)
  }
}
// --- the cross-stage contract -----------------------------------------------
// A varying declared with two different types is a LINK error. Each stage
// compiled clean above, because each stage declares the name it uses; the
// mismatch only exists in the pair. This is what a half-landed float -> vec2
// migration looks like, and it is invisible to `node --check`, to `vite build`,
// and to the compile loop above.
const varyingTypes = (src) => {
  const m = new Map()
  for (const d of src.matchAll(/\b(?:varying|in|out)\s+(\w+)\s+(v[A-Z]\w*)/g)) m.set(d[2], d[1])
  return m
}
let clashes = 0
for (const [label, vert, frag] of CROSS_STAGE) {
  const vt = varyingTypes(vert)
  const ft = varyingTypes(frag)
  const clash = []
  for (const [name, type] of ft) {
    if (vt.has(name) && vt.get(name) !== type) clash.push(`${name}: vertex ${vt.get(name)} vs fragment ${type}`)
  }
  if (clash.length === 0) {
    console.log(`  ok    ${label.padEnd(38)}varyings agree across stages`)
  } else {
    clashes += clash.length
    console.log(`  FAIL  material.js    ${label.padEnd(23)}varyings disagree across stages`)
    for (const c of clash) console.log(`        ${c}`)
  }
}

// --- did our code actually get into the shader ------------------------------
if (MISSING_MARKS.length === 0) {
  console.log(`  ok    material.js    every onBeforeCompile patch landed in the assembled source, and the season blocks only where asked`)
} else {
  console.log(`  FAIL  material.js    an onBeforeCompile replace silently did not match, or a block leaked`)
  for (const m of MISSING_MARKS) console.log(`        ${m.includes('must NOT') ? 'leaked' : 'missing'}: ${m}`)
}

// --- does the harness itself work -------------------------------------------
// Everything above reports success by printing ' ok '. A harness that is not
// really running -- a validator invocation that never sees the file, a
// cross-stage regex that matches nothing -- prints exactly the same thing. So
// give both of them a case whose answer is already known and make them get it
// right. These hack COPIES of the assembled source; nothing here touches
// src/material.js.
let selfTest = 0
{
  // The seasons variant, because the planted clash below is on vMoss and only a
  // seasons program declares it; looked up by label rather than by index so a
  // reordered table cannot hand this a source with nothing to retype.
  const entry = CROSS_STAGE.find(([label]) => label === 'material.js    seasons, cards, batched')
  if (!entry) throw new Error('check-shaders: the seasons variant is missing from CROSS_STAGE')
  const [, vert, frag] = entry
  const defines = propDefines({ batched: true })

  // 1. The validator must REJECT source it should reject. If this compiles, the
  //    compile loop above is not compiling anything.
  const broken = vert.replace('void main() {', 'void main() {\n\tvec3 harnessSelfTest = ;')
  if (broken === vert) {
    selfTest++
    console.log('  FAIL  self-test      could not inject a syntax error (no `void main() {` found)')
  } else if (compile('self-test broken', 'vert', builtinPrologue('vert', defines.vert), broken).out === null) {
    selfTest++
    console.log('  FAIL  self-test      the validator ACCEPTED a shader with `vec3 x = ;` in it')
  } else {
    console.log('  ok    self-test      the validator rejects a deliberately broken shader')
  }

  // 2. The cross-stage check must CATCH a type it should catch. vMoss is the one
  //    that shipped broken -- vec2 in the vertex stage, float in the fragment --
  //    so retype it here, in a copy, and require the check to see it.
  const clashed = frag.replace(/\bvarying vec2 vMoss;/, 'varying float vMoss;')
  if (clashed === frag) {
    selfTest++
    console.log('  FAIL  self-test      no `varying vec2 vMoss;` in the fragment stage to retype')
  } else {
    const vt = varyingTypes(vert)
    const ft = varyingTypes(clashed)
    const caught = [...ft].some(([n, t]) => vt.has(n) && vt.get(n) !== t)
    if (!caught) {
      selfTest++
      console.log('  FAIL  self-test      the cross-stage check MISSED a planted vMoss vec2/float clash')
    } else {
      console.log('  ok    self-test      the cross-stage check catches a planted vMoss vec2/float clash')
    }
  }
}

const lines = []
if (bad) lines.push(`${bad} shader(s) failed to compile`)
if (clashes) lines.push(`${clashes} varying type mismatch(es) across stages`)
if (MISSING_MARKS.length) lines.push(`${MISSING_MARKS.length} onBeforeCompile patch(es) did not land`)
if (selfTest) lines.push(`${selfTest} harness self-test(s) failed -- do not trust the rest of this run`)
console.log(
  lines.length
    ? `\n${lines.join('\n')}`
    : `\nall ${SHADERS.length} shaders compile, ${CROSS_STAGE.length} programs link, and the harness self-test passes`
)
process.exit(bad || clashes || MISSING_MARKS.length || selfTest ? 1 : 0)
