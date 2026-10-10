// The per-layer census: for a stretch of frames, what each layer costs in JS and what it asks of the renderer, so a
// layer's "ms saved when off" (perf-suite.js) has a cause beside it. Attribution is by scene graph: a drawn object
// belongs to its nearest ancestor named `v2-*`, else its top-level ancestor, by the name's first word. Every layer that
// draws through the shared baked-puppet batches (townsfolk, leafkin, hobs, villagers, wildlife) is counted under `baked`. Hooks are installed at begin() and
// removed at end(), so nothing runs outside a census. Counts are two-eye sums, as renderer.info is.
//
// Per layer, per frame:
//   jsMs       inclusive time in the layer's `update` (a layer listed by the host; draws are counted for all layers)
//   draws      main-pass draw calls; `offDraws` into offscreen targets (reflections), `shadowDraws` into shadow maps
//   inst       instances drawn in the main pass (1 for a plain mesh, or for a geometry with no instanceCount); `tris` is index count x instances, ignoring groups
//   matSw/progSw  draws whose material / compiled program differs from the previous main-pass draw anywhere in the frame
//   upCalls    attribute uploads, counted as version bumps of the layer's geometry attributes and instance buffers
//   upKbMax    those uploads at full buffer size (an upper bound: partial update ranges are not subtracted)

const isDepth = (m) => m.isMeshDepthMaterial || m.isMeshDistanceMaterial

/** The family an object's name belongs to: its first dash-separated word ('trees-t2-v0' and 'trees-t1-v0' are `trees`). */
const family = (name) => name.replace(/^v2-/, '').split('-')[0]

function layerOf(obj) {
  let top = obj
  for (let o = obj; o; o = o.parent) {
    if (o.name && o.name.startsWith('v2-')) return family(o.name)
    if (o.parent && !o.parent.parent) top = o
  }
  return family(top.name || top.type)
}

function buffersOf(obj) {
  const out = []
  if (obj.geometry) {
    for (const a of Object.values(obj.geometry.attributes)) out.push(a)
    if (obj.geometry.index) out.push(obj.geometry.index)
  }
  if (obj.instanceMatrix) out.push(obj.instanceMatrix)
  if (obj.instanceColor) out.push(obj.instanceColor)
  return out
}

export class Census {
  /**
   * @param scene     the main scene, walked each frame for objects created since
   * @param renderer  read for the current render target and each material's program
   * @param layers    () => [[name, object]]: objects whose `update` is timed under `name`
   */
  constructor(scene, renderer, layers) {
    this.scene = scene
    this.renderer = renderer
    this.layers = layers
    this.active = false
  }

  begin() {
    if (this.active) throw new Error('Census.begin: already running')
    this.active = true
    this.frames = 0
    this.stats = new Map()
    this.js = new Map()
    this.hooked = new Map()
    this.timed = []
    this.lastMat = null
    this.lastProg = null
    for (const [name, obj] of this.layers()) {
      if (!obj || typeof obj.update !== 'function') continue
      const own = Object.prototype.hasOwnProperty.call(obj, 'update')
      const orig = obj.update
      const js = this.js
      js.set(name, 0)
      obj.update = function (...a) {
        const t = performance.now()
        try { return orig.apply(this, a) } finally { js.set(name, js.get(name) + performance.now() - t) }
      }
      this.timed.push({ obj, own, orig })
    }
    this.scan()
  }

  stat(name) {
    let s = this.stats.get(name)
    if (!s) {
      s = { draws: 0, offDraws: 0, shadowDraws: 0, inst: 0, tris: 0, matSw: 0, progSw: 0, upCalls: 0, upKbMax: 0, objects: 0 }
      this.stats.set(name, s)
    }
    return s
  }

  /** Hooks every drawable not yet hooked. */
  scan() {
    this.scene.traverse((obj) => {
      if (this.hooked.has(obj) || !(obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite)) return
      const name = layerOf(obj)
      const st = this.stat(name)
      st.objects++
      const orig = obj.onBeforeRender
      const own = Object.prototype.hasOwnProperty.call(obj, 'onBeforeRender')
      const buffers = buffersOf(obj)
      this.hooked.set(obj, { own, orig, buffers, v0: buffers.map((b) => b.version) })
      obj.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        this.draw(st, obj, geometry, material, renderer)
        orig.call(obj, renderer, scene, camera, geometry, material, group)
      }
    })
  }

  draw(st, obj, geometry, material, renderer) {
    if (isDepth(material)) { st.shadowDraws++; return }
    if (renderer.getRenderTarget() !== null) { st.offDraws++; return }
    st.draws++
    const inst = obj.isInstancedMesh ? obj.count : Number.isFinite(geometry.instanceCount) ? geometry.instanceCount : 1
    st.inst += inst
    const count = geometry.index ? geometry.index.count : geometry.attributes.position.count
    st.tris += (count / 3) * inst
    if (this.lastMat !== material) st.matSw++
    this.lastMat = material
    const prog = this.renderer.properties.get(material).currentProgram ?? null
    if (this.lastProg !== prog) st.progSw++
    this.lastProg = prog
  }

  /** Call once a frame after the main render. */
  frame() {
    this.frames++
    this.scan()
  }

  /** Removes every hook and returns per-frame figures by layer name, costliest JS then draws first. */
  end() {
    this.active = false
    const n = Math.max(1, this.frames)
    for (const [obj, h] of this.hooked) {
      if (h.own) obj.onBeforeRender = h.orig
      else delete obj.onBeforeRender
      const st = this.stat(layerOf(obj))
      h.buffers.forEach((b, i) => {
        const bumps = b.version - h.v0[i]
        st.upCalls += bumps
        st.upKbMax += (bumps * b.array.byteLength) / 1024
      })
    }
    for (const t of this.timed) {
      if (t.own) t.obj.update = t.orig
      else delete t.obj.update
    }
    const r = (v) => Math.round(v * 100) / 100
    const out = {}
    const names = new Set([...this.stats.keys(), ...this.js.keys()])
    for (const name of names) {
      const s = this.stats.get(name)
      out[name] = {
        jsMs: this.js.has(name) ? r(this.js.get(name) / n) : null,
        draws: s ? r(s.draws / n) : 0, offDraws: s ? r(s.offDraws / n) : 0, shadowDraws: s ? r(s.shadowDraws / n) : 0,
        inst: s ? Math.round(s.inst / n) : 0, tris: s ? Math.round(s.tris / n) : 0,
        matSw: s ? r(s.matSw / n) : 0, progSw: s ? r(s.progSw / n) : 0,
        upCalls: s ? r(s.upCalls / n) : 0, upKbMax: s ? r(s.upKbMax / n) : 0,
        objects: s ? s.objects : 0,
      }
    }
    this.hooked = null
    this.timed = null
    return { frames: this.frames, layers: out }
  }
}
