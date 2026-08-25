// Compile every shader on /v2-new-grass with a real GLSL ES 3.00 front end.
//
// There is no WebGL in node, so this reconstructs what three actually hands the
// driver: the shader source with the prologue WebGLProgram.js prepends for a
// ShaderMaterial under GLSL3 (lines 536-700 and 858-890), or nothing at all for
// a RawShaderMaterial beyond the #version line. Get that prologue wrong in the
// permissive direction and the harness passes shaders the browser rejects, so
// it is copied from three's source rather than remembered.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
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

// --- pull the shader template literals out of the modules -------------------
// They are module-private consts, and importing the modules would drag in three
// and a fetch for the heightmap. The literals only interpolate four simple
// values, so lifting the text and evaluating it in a tiny scope is exact.
function literal(src, name) {
  const m = new RegExp(`const ${name} = (?:/\\* glsl \\*/ )?\``).exec(src)
  if (!m) throw new Error(`no const ${name}`)
  const start = m.index + m[0].length
  let i = start
  while (src[i] !== '`') {
    if (src[i] === '\\') i++
    i++
    if (i > src.length) throw new Error(`unterminated ${name}`)
  }
  return src.slice(start, i)
}

const heightSrc = readFileSync(`${ROOT}/src/newgrass/gpu-height.js`, 'utf8')
const groundSrc = readFileSync(`${ROOT}/src/newgrass/ground.js`, 'utf8')
const grassSrc = readFileSync(`${ROOT}/src/newgrass/grass-field.js`, 'utf8')

const scope = {
  HEIGHT_UNIFORMS: null,
  HEIGHT_GLSL: null,
  PROBE_LO: Number(/const PROBE_LO = ([-\d.]+)/.exec(heightSrc)[1]),
  PROBE_SPAN: Number(/const PROBE_SPAN = ([-\d.]+)/.exec(heightSrc)[1]),
  CULL_FADE: Number(/const CULL_FADE = ([-\d.]+)/.exec(grassSrc)[1]),
}
const bake = (raw) =>
  new Function(...Object.keys(scope), `return \`${raw}\``)(...Object.values(scope))

scope.HEIGHT_UNIFORMS = bake(literal(heightSrc, 'HEIGHT_UNIFORMS'))
scope.HEIGHT_GLSL = bake(literal(heightSrc, 'HEIGHT_GLSL'))

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

// A RawShaderMaterial gets only the #version line -- three injects no precision
// qualifiers and no built-ins, which is why PROBE_FRAG declares its own.
const RAW_PRE = `#version 300 es\n`

const SHADERS = [
  ['gpu-height.js  PROBE_FRAG', 'frag', RAW_PRE, bake(literal(heightSrc, 'PROBE_FRAG')), true],
  ['ground.js      GROUND_VERT', 'vert', V_PRE, bake(literal(groundSrc, 'GROUND_VERT'))],
  ['ground.js      GROUND_FRAG', 'frag', F_PRE, bake(literal(groundSrc, 'GROUND_FRAG'))],
  ['ground.js      SHELL_VERT', 'vert', V_PRE, bake(literal(groundSrc, 'SHELL_VERT'))],
  ['ground.js      SHELL_FRAG', 'frag', F_PRE, bake(literal(groundSrc, 'SHELL_FRAG'))],
  ['grass-field.js VERT', 'vert', V_PRE, bake(literal(grassSrc, 'VERT'))],
  ['grass-field.js FRAG', 'frag', F_PRE, bake(literal(grassSrc, 'FRAG'))],
]

// PROBE_VERT is built inline in the HeightProbe constructor rather than as a
// named const, so it is matched separately.
const pv = /vertexShader: (?:\/\* glsl \*\/ )?`([\s\S]*?)`/.exec(heightSrc)
if (pv) SHADERS.unshift(['gpu-height.js  PROBE_VERT', 'vert', RAW_PRE, bake(pv[1]), true])

let bad = 0
for (const [name, stage, pre, body, raw] of SHADERS) {
  // The shader may carry its own #version (raw materials must not, but check
  // rather than assume) -- strip it so the prologue's is the only one.
  const cleaned = body.replace(/^\s*#version[^\n]*\n/, '')
  const full = pre + cleaned
  const file = join(tmp, `s.${stage}`)
  writeFileSync(file, full)
  try {
    execFileSync(VALIDATOR, ['-S', stage, file], { stdio: 'pipe' })
    console.log(`  ok    ${name}${raw ? '   (raw)' : ''}`)
  } catch (e) {
    bad++
    const out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '')
    console.log(`  FAIL  ${name}`)
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
}
console.log(bad ? `\n${bad} shader(s) failed to compile` : `\nall ${SHADERS.length} shaders compile`)
process.exit(bad ? 1 : 0)
