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
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { createPropMaterial, createImpostorBakeMaterial } from '../src/material.js'
import { Water } from '../src/water.js'
import { Sky } from '../src/sky.js'
import { WorldLighting } from '../src/lighting.js'
import { SkyProbe } from '../src/sky-probe.js'
import { WorldProbe } from '../src/world-probe.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'

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
const propDefines = ({ batched = true, vertexColors = false } = {}) => {
  const shared = [
    '#define USE_FOG',
    '#define FOG_EXP2',
    vertexColors ? '#define USE_COLOR' : '',
    '#define DOUBLE_SIDED',
  ]
  const batchColor = batched ? '#define USE_COLOR_ALPHA' : ''
  return {
    vert: [batched ? '#define USE_BATCHING' : '', batched ? '#define USE_BATCHING_COLOR' : '', batchColor, ...shared],
    frag: ['#define USE_ALPHATEST', batchColor, ...shared],
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
const PROP_MARKS = {
  vert: [
    'attribute float texLayer;', 'varying vec2 vMoss;', 'vMoss = vec2(', 'snowRoll', 'mossRoll',
    'vPropFade = propFade;',
  ],
  frag: [
    'uniform sampler2DArray uAtlas;',
    'float ign( vec2 p )',
    'float blobField( vec3 p )',
    'log( mossLoad',
    'snowNear > 0.004',
    'mossNear > 0.004',
    'normal *= faceDirection;',
    // The dissolve's alpha channel, defended. If this line is missing, three's
    // own color_fragment is back and a fading prop is discarded whole by the
    // alphaTest instead of dithering -- which compiles perfectly and is only
    // visible from inside the world. See COLOR_FRAGMENT in material.js.
    'diffuseColor.rgb *= vColor.rgb;',
  ],
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
  // The spherical spin is a SECOND body for the same branch, not an extra one
  // spliced on top -- so the variant above cannot cover it, and it is the only
  // GLSL in the file that touches the batching matrix as a mat3 or indexes
  // viewMatrix by hand. Both are easy to get wrong in a way that compiles
  // everywhere except a real driver, which is what this harness is for. Batched,
  // because that is how rocks draw and USE_BATCHING is what selects the line.
  [
    'billboardLayers, spherical',
    createPropMaterial(atlas, { billboardLayers: [0, 1, 2], sphericalBillboard: true }),
    { batched: true },
    { vert: [...PROP_MARKS.vert, 'uBillboardLayers', 'mat3( batchingMatrix )'], frag: PROP_MARKS.frag },
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
  [
    'impostor bake',
    createImpostorBakeMaterial(atlas),
    { batched: false },
    {
      vert: ['attribute float texLayer;', 'vUvProj = uvProj;'],
      frag: ['uniform sampler2DArray uAtlas;', 'texture( uAtlas', 'normal *= faceDirection;'],
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
  SHADERS.push(['water.js       FRAG', 'frag', F_PRE + GLSL1_OUT + FOG + COLOR_FNS + '\n', frag])
  CROSS_STAGE.push(['water.js', vert, frag])
}

// --- src/lighting.js: the terrain's fragment patch ---------------------------
//
// THE ONE PATCH NOTHING ELSE HERE COVERS, and the gap was worth closing the day
// something went into it. `mode: 'vertex'` reaches this table already -- every
// prop variant above is patched by it -- but `mode: 'fragment'` has exactly one
// caller in the whole project, v2's terrain, and its extra code was until now
// compiled for the first time by whichever headset was pointed at a lake.
//
// It is also the branch that carries the most: the shadow and occlusion sample,
// the night lift, the aerial ramp AND the caustic net, none of which the vertex
// path emits. A ShaderMaterial that fails here does not draw a dimmer world; it
// drops the terrain.
//
// `vWorldPos` is declared into the stub rather than patched in, because that is
// where it comes from in the real thing -- terrain-material.js has carried the
// varying since v1's surface grain, which is why the patch takes its name as an
// argument instead of declaring one of its own.
{
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: `varying vec3 vWorldPos;\n${lib.fragmentShader}`,
    defines: {},
  }
  const mat = new THREE.MeshLambertMaterial()
  new WorldLighting().patch(mat, { mode: 'fragment', cacheKey: 'check', worldPosVarying: 'vWorldPos' })
  mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const frag = finish(shader.fragmentShader)
  SHADERS.push(['lighting.js    fragment patch     frag', 'frag', builtinPrologue('frag', ['#define USE_FOG', '#define FOG_EXP2']), frag])
  // Three replaces, three markers. The aerial mix and the caustic net share the
  // fog slot, so one anchor going stale takes both out at once and neither
  // absence is visible from anywhere but a lake bed.
  for (const mark of ['float wlCaustic( vec2 p, float t )', 'uCaustic.x > 0.0', 'aerialKeep', 'wlSun( vWorldPos.xz )']) {
    if (!frag.includes(mark)) MISSING_MARKS.push(`lighting.js fragment patch frag: ${mark}`)
  }
}

// --- src/terrain/terrain-material.js: the ground itself ----------------------
//
// THE LARGEST onBeforeCompile PATCH IN THE PROJECT and, until this block, the
// only one compiled for the first time by the headset it was deployed to. That
// is a bad loop to be in: the edit-to-error path ran through a build, a deploy
// and a Quest, and a terrain shader that fails to link does not draw a plainer
// hillside, it draws nothing at all.
//
// Both variants, because the atlas branch is not a small addition -- it carries
// the triplanar stone fetches, the fine layer and the ground tiles, all of it
// inside `${atlas ? ... : ''}` and therefore INVISIBLE to a check that only ever
// passes null. The two are separate programs in the real renderer too; see the
// cacheKey at the bottom of terrain-material.js.
//
// USE_COLOR because the material is built with vertexColors, and the fog pair
// because v2's scene carries FogExp2 -- which is now load-bearing rather than
// incidental, since auroraDetailK reads `fogDensity` out of the fog chunk.
for (const withAtlas of [false, true]) {
  const lib = THREE.ShaderLib.lambert
  const shader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
    defines: {},
  }
  const atlas = withAtlas ? new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1) : null
  const mat = createTerrainMaterial({ atlas })
  mat.onBeforeCompile(shader, { capabilities: { isWebGL2: true } })

  const defines = ['#define USE_COLOR', '#define USE_FOG', '#define FOG_EXP2']
  const label = `terrain-material ${withAtlas ? 'with atlas' : 'no atlas   '}`
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
  // The grit and macro marks include `textureGrad(` deliberately. Every fetch
  // in this shader sits inside a guard that folds in distance and the surface
  // classification, so none is quad-uniform and an implicit-LOD `texture()`
  // there is undefined -- it compiles, it looks right on desktop, and it draws
  // a line of sparkling pixels down every snow border on the headset. The mark
  // is what makes that a gate failure rather than a bug report.
  const marks = [
    'textureGrad( uGritMap',
    'textureGrad( uMacroMap',
    'auroraSnowD',
    'auroraDetailK',
    'auroraBW',
    'normal + ( viewMatrix * vec4( auroraBump, 0.0 ) )',
  ]
  if (withAtlas) marks.push('auroraStoneK > 0.004')
  for (const mark of marks) {
    if (!frag.includes(mark)) MISSING_MARKS.push(`${label} frag: ${mark}`)
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
  console.log(`  ok    material.js    every onBeforeCompile patch landed in the assembled source`)
} else {
  console.log(`  FAIL  material.js    an onBeforeCompile replace silently did not match`)
  for (const m of MISSING_MARKS) console.log(`        missing: ${m}`)
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
  const [, vert, frag] = CROSS_STAGE[0]
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
