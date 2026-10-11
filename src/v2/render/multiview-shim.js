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

function patch(shader) {
  if (!/\bviewMatrix\b/.test(resolveIncludes(shader.fragmentShader))) return
  shader.fragmentShader = resolveIncludes(shader.fragmentShader).replace(/\bviewMatrix\b/g, 'gViewMatrix')
  shader.fragmentShader = `flat varying vec4 vGVM0;\nflat varying vec4 vGVM1;\nflat varying vec4 vGVM2;\nflat varying vec4 vGVM3;\n#define gViewMatrix mat4( vGVM0, vGVM1, vGVM2, vGVM3 )\n${shader.fragmentShader}`
  shader.vertexShader = `flat varying vec4 vGVM0;\nflat varying vec4 vGVM1;\nflat varying vec4 vGVM2;\nflat varying vec4 vGVM3;\n${shader.vertexShader}`
    .replace(/void main\(\s*\)\s*\{/, 'void main() {\n vGVM0 = viewMatrix[ 0 ]; vGVM1 = viewMatrix[ 1 ]; vGVM2 = viewMatrix[ 2 ]; vGVM3 = viewMatrix[ 3 ];')
}

/** Route every material's compile through `patch`; call before any material compiles. */
export function installMultiviewShim() {
  const proto = THREE.Material.prototype
  const base = proto.onBeforeCompile
  Object.defineProperty(proto, 'onBeforeCompile', {
    configurable: true,
    get() {
      const own = this._mvObc ?? base
      return (shader, renderer) => { own.call(this, shader, renderer); patch(shader) }
    },
    set(fn) { this._mvObc = fn },
  })
}

/** Programs that failed to link or compile, as `{ name, log }`; the headset has no console to read. */
export function failedPrograms(renderer) {
  return (renderer.info.programs ?? [])
    .filter((p) => p.diagnostics && p.diagnostics.runnable === false)
    .map((p) => ({ name: p.name, log: `${p.diagnostics.programLog ?? ''} ${p.diagnostics.vertexShader?.log ?? ''} ${p.diagnostics.fragmentShader?.log ?? ''}`.trim().slice(0, 300) }))
}
