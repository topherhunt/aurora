// `?multiview` support for A-Frame 1.8's bundled three. Its multiview rewrites a fragment shader's `viewMatrix` to `viewMatrices[gl_ViewID_OVR]` under `#extension GL_OVR_multiview` (v1), which only allows the view id in the vertex stage, so every material that reads `viewMatrix` in its fragment shader (terrain, rocks, anything built on material.js) breaks. The shim resolves a material's includes, renames fragment `viewMatrix` to `gViewMatrix`, and feeds it from flat varyings written in the vertex stage.
import THREE from '../../three-instance.js'

const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm

function resolveIncludes(src) {
  return src.replace(INCLUDE, (_, name) => {
    const chunk = THREE.ShaderChunk[name]
    if (chunk === undefined) throw new Error(`multiview-shim: unknown shader chunk <${name}>`)
    return resolveIncludes(chunk)
  })
}

// The declarations go after the shader's last `#extension` line: a directive after any token is an error in ESSL3.
function declare(src, decl) {
  const at = [...src.matchAll(/^[ \t]*#extension[^\n]*\n/gm)].pop()
  const i = at ? at.index + at[0].length : 0
  return src.slice(0, i) + decl + src.slice(i)
}

const VARYINGS = 'flat varying vec4 vGVM0;\nflat varying vec4 vGVM1;\nflat varying vec4 vGVM2;\nflat varying vec4 vGVM3;\n'

function patch(shader) {
  const fs = resolveIncludes(shader.fragmentShader)
  if (!/\bviewMatrix\b/.test(fs)) return
  shader.fragmentShader = declare(fs.replace(/\bviewMatrix\b/g, 'gViewMatrix'), `${VARYINGS}#define gViewMatrix mat4( vGVM0, vGVM1, vGVM2, vGVM3 )\n`)
  shader.vertexShader = declare(shader.vertexShader, VARYINGS)
    .replace(/void main\(\s*\)\s*\{/, 'void main() {\n vGVM0 = viewMatrix[ 0 ]; vGVM1 = viewMatrix[ 1 ]; vGVM2 = viewMatrix[ 2 ]; vGVM3 = viewMatrix[ 3 ];')
}

// three declares GL_OVR_multiview (v1), which lets the view id feed only gl_Position; every other use (view-space varyings, fades, fog depth) is undefined, so the declaration is raised to multiview2.
// three's multiview prefix puts `layout( num_views ) in;` ahead of its own `#extension GL_ANGLE_multi_draw` (BatchedMesh, the terrain), which ESSL3 rejects; no onBeforeCompile can reach the prefix, so the lines are hoisted as the source reaches the driver.
function hoistExtensions(src) {
  src = src.replace(/#extension GL_OVR_multiview\s*:/g, '#extension GL_OVR_multiview2 :')
  const lines = src.match(/^[ \t]*#extension[^\n]*\n/gm)
  if (!lines) return src
  const rest = src.replace(/^[ \t]*#extension[^\n]*\n/gm, '')
  const v = rest.match(/^[ \t]*#version[^\n]*\n/)
  return v ? v[0] + lines.join('') + rest.slice(v[0].length) : lines.join('') + rest
}

/** Route every material's compile through `patch`; call before any material compiles. */
export function installMultiviewShim() {
  const gl2 = WebGL2RenderingContext.prototype
  const shaderSource = gl2.shaderSource
  gl2.shaderSource = function (shader, src) { return shaderSource.call(this, shader, hoistExtensions(src)) }
  const proto = THREE.Material.prototype
  const base = proto.onBeforeCompile
  // Materials chain their handlers (`prev = material.onBeforeCompile`), so only the outermost call may patch: an inner one would resolve the includes the outer handlers still splice into.
  let depth = 0
  // One stable function per material: callers compare `onBeforeCompile` against the prototype's (cord.js refuses a material that is already patched).
  const wrap = (own) => function (shader, renderer) {
    depth++
    try { own.call(this, shader, renderer) } finally { depth-- }
    if (depth === 0) patch(shader)
  }
  const plain = wrap(base)
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get() { return this._mvWrapped ?? plain },
    set(fn) { this._mvWrapped = wrap(fn) },
  })
}

/** Programs that failed to link or compile, as `{ name, log }`; the headset has no console to read. */
export function failedPrograms(renderer) {
  return (renderer.info.programs ?? [])
    .filter((p) => p.diagnostics && p.diagnostics.runnable === false)
    .map((p) => ({ name: p.name, log: `${p.diagnostics.programLog ?? ''} ${p.diagnostics.vertexShader?.log ?? ''} ${p.diagnostics.fragmentShader?.log ?? ''}`.trim().slice(0, 300) }))
}
