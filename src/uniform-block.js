// ---------------------------------------------------------------------------
// SHARED UNIFORM BLOCK -- A PERFORMANCE MANDATE, NOT A TIDYING.
//
// On the Quest the main thread spends about 6 us per WebGL call and a frame
// issues ~1000 of them (DESIGN: _notes/perf-ledger.md "What the frame is made
// of"). Over half are `uniform*`. three keeps a uniform cache PER PROGRAM, so a
// value every material shares (sun, haze, torches, ...) is re-sent once for each
// of the ~16 lit programs whenever it changes, and array uniforms (`uTorch[]`)
// are re-sent every pass whether they changed or not.
//
// A UniformBlock puts those shared values in one std140 UBO: the CPU packs them
// into a Float32Array, uploads it once if anything changed, and every program
// that declares the block reads the same buffer with ZERO per-draw calls.
// Do not turn a field back into a plain `uniform` to "simplify" a shader: that
// pays the per-program upload again, on every program, every frame.
//
// A field's value stays in the source uniform object it always lived in
// (`{ value }`), so writers are unchanged; `sync()` packs from those objects.
// `patch(shader)` rewrites a compiled shader: it deletes the field's plain
// `uniform` declarations and declares the block instead. `attach(renderer)` must
// run before the first program using the block compiles; `renderer.render` is
// wrapped to `sync()` first, so a bracketed change (airToLinear) lands too.
// ---------------------------------------------------------------------------

const SIZES = { float: [4, 4], vec2: [8, 8], vec3: [16, 12], vec4: [16, 16] }

export class UniformBlock {
  /**
   * @param name      GLSL block name (shared by every stage and program)
   * @param binding   UNIFORM_BUFFER binding point, not used by anything else
   * @param fields    `{ name, type: 'float'|'vec2'|'vec3'|'vec4', count?, source }` in std140 order of declaration;
   *                  `count` makes an array (std140 pads every element of one to a vec4), `source` is `{ value }`
   *                  holding a number, Vector2/3/4, Color, a Float32Array or an array of Vector4
   */
  constructor(name, binding, fields) {
    this.name = name
    this.binding = binding
    this.fields = []
    let at = 0
    for (const f of fields) {
      const size = SIZES[f.type]
      if (!size) throw new Error(`UniformBlock ${name}: bad type ${f.type} for ${f.name}`)
      const [align, bytes] = f.count ? [16, 16 * f.count] : size
      at = Math.ceil(at / align) * align
      this.fields.push({ ...f, at: at / 4 })
      at += bytes
    }
    this.data = new Float32Array(Math.ceil(at / 16) * 4)
    this.sent = new Float32Array(this.data.length)
    this.sent.fill(NaN)
    this.gl = null
    this.names = this.fields.map((f) => f.name)
    const decl = (f) => `${f.type} ${f.name}${f.count ? `[${f.count}]` : ''};`
    this.glsl = `layout( std140 ) uniform ${name} {\n${this.fields.map(decl).join('\n')}\n};\n`
    this.strip = this.fields.map((f) => new RegExp(`^[ \\t]*uniform[ \\t]+${f.type}[ \\t]+${f.name}[ \\t]*(\\[[^\\]]*\\])?[ \\t]*;[^\\n]*$`, 'gm'))
    this.used = new RegExp(`\\b(${this.names.join('|')})\\b`)
    this.calls = 0
  }

  /** Create the buffer and make every program that declares the block read it; call once, before any such program compiles. */
  attach(renderer) {
    const gl = renderer.getContext()
    if (this.gl) throw new Error(`UniformBlock ${this.name}: attached twice`)
    this.gl = gl
    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer)
    gl.bufferData(gl.UNIFORM_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW)
    gl.bindBufferBase(gl.UNIFORM_BUFFER, this.binding, this.buffer)

    // A program is told its block binding the first time it is used: it is linked by then (asking at linkProgram would stall the parallel compile).
    const proto = Object.getPrototypeOf(gl)
    const useProgram = proto.useProgram
    const seen = new WeakSet()
    const block = this
    proto.useProgram = function (program) {
      if (this === gl && program && !seen.has(program)) {
        seen.add(program)
        const i = gl.getUniformBlockIndex(program, block.name)
        if (i !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, i, block.binding)
      }
      return useProgram.call(this, program)
    }
    const render = renderer.render
    renderer.render = function (...args) {
      block.sync()
      return render.apply(this, args)
    }
    this.sync()
  }

  /** Pack the sources; upload if any value differs from what the GPU holds. */
  sync() {
    const d = this.data
    for (const f of this.fields) {
      const v = f.source.value
      let o = f.at
      if (f.count) {
        for (let i = 0; i < f.count; i++, o += 4) {
          if (f.type === 'vec4') { if (v.length === f.count * 4) { d[o] = v[i * 4]; d[o + 1] = v[i * 4 + 1]; d[o + 2] = v[i * 4 + 2]; d[o + 3] = v[i * 4 + 3] } else { const e = v[i]; d[o] = e.x; d[o + 1] = e.y; d[o + 2] = e.z; d[o + 3] = e.w } } else d[o] = v[i]
        }
      } else if (f.type === 'float') d[o] = v
      else if (f.type === 'vec2') { d[o] = v.x; d[o + 1] = v.y }
      else if (f.type === 'vec3') { if (v.r !== undefined) { d[o] = v.r; d[o + 1] = v.g; d[o + 2] = v.b } else { d[o] = v.x; d[o + 1] = v.y; d[o + 2] = v.z } }
      else { d[o] = v.x; d[o + 1] = v.y; d[o + 2] = v.z; d[o + 3] = v.w }
    }
    let same = true
    for (let i = 0; i < d.length; i++) if (d[i] !== this.sent[i]) { same = false; break }
    if (same) return
    const gl = this.gl
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.buffer)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, d)
    this.sent.set(d)
    this.calls++
  }

  /** Swap the fields' plain declarations for the block, in whichever stages use them; returns the shader. */
  patch(shader) {
    for (const stage of ['vertexShader', 'fragmentShader']) {
      let src = shader[stage]
      for (const re of this.strip) src = src.replace(re, '')
      shader[stage] = this.used.test(src) ? this.glsl + src : src
    }
    // The block's members have no location: left in `shader.uniforms`, three would call uniform*(null, ...) for each, every draw.
    for (const name of this.names) delete shader.uniforms[name]
    return shader
  }
}
