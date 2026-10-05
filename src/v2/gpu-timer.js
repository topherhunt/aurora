// GPU time per frame through EXT_disjoint_timer_query_webgl2, wrapped round every renderer.render call (the probes' and the sky map's passes included, so the sum is the frame's whole GPU draw time). Results land two or three frames late; `take()` returns what arrived since the last call so a trace window can mean it. `supported` is false where the extension is missing (the headset browser may not expose it), and the traces then record null rather than a guess.

const MAX_PENDING = 64

export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext()
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2')
    this.supported = this.ext !== null
    this.pending = []
    this.free = []
    this.depth = 0
    this.sumMs = 0
    this.frames = 0
    this.frameQueries = 0
    if (!this.supported) return
    const render = renderer.render.bind(renderer)
    renderer.render = (...args) => {
      if (this.depth > 0 || this.pending.length >= MAX_PENDING) return render(...args)
      const q = this.free.pop() ?? this.gl.createQuery()
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q)
      this.depth++
      try {
        return render(...args)
      } finally {
        this.depth--
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT)
        this.pending.push(q)
        this.frameQueries++
      }
    }
  }

  /** Once a frame (tock): reads every finished query, oldest first. */
  poll() {
    if (!this.supported) return
    const { gl, ext } = this
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT)
    while (this.pending.length > 0) {
      const q = this.pending[0]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break
      this.pending.shift()
      if (!disjoint) this.sumMs += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6
      this.free.push(q)
    }
    if (this.frameQueries > 0) this.frames++
    this.frameQueries = 0
  }

  /** The mean GPU ms per frame since the last take(), or null when nothing resolved (or no extension). */
  take() {
    if (!this.supported || this.frames === 0) return null
    const ms = this.sumMs / this.frames
    this.sumMs = 0
    this.frames = 0
    return ms
  }
}
