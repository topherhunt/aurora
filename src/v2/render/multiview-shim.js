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

const SELF_VS = (mv, fetch) => `#version 300 es
${mv ? '#extension GL_OVR_multiview2 : require\nlayout( num_views = 2 ) in;\n' : ''}precision highp float; precision highp sampler2D;
uniform sampler2D d;
out vec4 c;
void main() { c = ${fetch === 'vertex' ? 'texelFetch( d, ivec2( 0, 0 ), 0 )' : 'vec4( 0.0 )'}; gl_Position = vec4( 0.0, 0.0, 0.0, 1.0 ); gl_PointSize = 4.0; }`
const SELF_FS = (mv, fetch) => `#version 300 es
${mv ? '#extension GL_OVR_multiview2 : require\n' : ''}precision highp float; precision highp sampler2D;
uniform sampler2D d;
in vec4 c;
out vec4 o;
void main() { o = ${fetch === 'fragment' ? 'texelFetch( d, ivec2( 0, 0 ), 0 )' : 'c'}; }`

/** Whether reading a data texture in each stage survives multiview on this device: draws one point per case and reads pixel (2,2) back, per eye. Expect 64,128,191,255. */
export function multiviewSelfTest() {
  const gl = document.createElement('canvas').getContext('webgl2')
  if (!gl) return { error: 'no second webgl2 context' }
  const ext = gl.getExtension('OVR_multiview2') ?? gl.getExtension('OCULUS_multiview')
  if (!ext) return { error: 'no multiview extension' }
  gl.getExtension('EXT_color_buffer_float')
  const out = {}
  const compile = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s))
    return s
  }
  const texel = (type) => {
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (type === 'float') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0.25, 0.5, 0.75, 1, 0, 0, 0, 0]))
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([64, 128, 191, 255, 0, 0, 0, 0]))
    return t
  }
  for (const mv of [false, true]) {
    for (const [fetch, type] of [['vertex', 'float'], ['vertex', 'byte'], ['fragment', 'float'], ['fragment', 'byte']]) {
      const key = `${mv ? 'multiview' : 'mono'} ${fetch} ${type}`
      try {
        const prog = gl.createProgram()
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, SELF_VS(mv, fetch)))
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, SELF_FS(mv, fetch)))
        gl.linkProgram(prog)
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog))
        const target = gl.createTexture()
        const kind = mv ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D
        gl.bindTexture(kind, target)
        if (mv) gl.texStorage3D(kind, 1, gl.RGBA8, 4, 4, 2)
        else gl.texStorage2D(kind, 1, gl.RGBA8, 4, 4)
        const fb = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
        if (mv) ext.framebufferTextureMultiviewOVR(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target, 0, 0, 2)
        else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer status ${status}`)
        gl.viewport(0, 0, 4, 4)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(prog)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, texel(type))
        gl.uniform1i(gl.getUniformLocation(prog, 'd'), 0)
        gl.drawArrays(gl.POINTS, 0, 1)
        const read = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, read)
        const px = new Uint8Array(4)
        const layers = []
        for (let layer = 0; layer < (mv ? 2 : 1); layer++) {
          if (mv) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target, 0, layer)
          else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
          gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
          layers.push(Array.from(px).join(','))
        }
        const err = gl.getError()
        out[key] = layers.join(' | ') + (err ? ` GL ${err}` : '')
      } catch (e) {
        out[key] = `ERROR ${String(e.message).slice(0, 160)}`
      }
    }
  }
  return out
}
