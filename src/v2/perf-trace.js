// The perf trace: one debug-panel press runs the battery in perf-suite.js --
// takes groups of layers away, measures each state, drills into the groups that
// mattered -- and POSTs the result to /__trace on the dev server (vite.config.js) or /trace on
// the deployed relay (server/src/main.js), so a headset with no devtools can be
// profiled by sitting still for a minute. record-trace.js shares the HUD and upload.
// Read the result with `node scripts/trace-report.mjs`.
//
// Baselines are re-measured between states and every saving is taken against
// the baseline INTERPOLATED to that state's moment, because a Quest warms up and
// throttles over a run and a fixed baseline would read the drift as a cost. The
// groups run forward and then in reverse for the same reason, and the two
// rounds' disagreement is reported as the measurement's own error bar.

import * as THREE from 'three'
import { SPIKES } from './spikes.js'
import { SETTLE_MS, MEASURE_MS, BASELINE_EVERY, DRILL_MIN_MS, MAX_DRILL, GROUPS } from './perf-suite.js'

const ENDPOINT = import.meta.env.DEV ? '/__trace' : '/trace'
// Presses this soon after the start are the press that started it (the trigger is still down).
const ABORT_GRACE_MS = 1500
const DONE_SHOWN_MS = 12000
const MAX_FRAMES = 1024
// A sample runs past MEASURE_MS until it has this many frames, so a slow desktop still yields a p95.
const MIN_FRAMES = 30

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()

export const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
export const r2 = (v) => Math.round(v * 100) / 100

/** POSTs a finished trace; resolves to the id the server filed it under. */
export async function postTrace(trace) {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(trace) })
  if (!res.ok) throw new Error(`${ENDPOINT} answered ${res.status}: ${(await res.text()).slice(0, 120)}`)
  return (await res.json()).id
}

/** A text strip floating below the gaze, shared by the traces; redrawn only when the text changes so it stays one draw call. */
export class TraceHud {
  constructor(camera) {
    const canvas = document.createElement('canvas')
    canvas.width = 768
    canvas.height = 96
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.tex = new THREE.CanvasTexture(canvas)
    this.tex.colorSpace = THREE.SRGBColorSpace
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.075),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, toneMapped: false, depthTest: false, depthWrite: false }),
    )
    this.mesh.position.set(0, -0.3, -1.2)
    this.mesh.renderOrder = 999
    this.mesh.visible = false
    this.text = ''
    camera.add(this.mesh)
  }

  show(text, color) {
    this.mesh.visible = true
    if (text === this.text) return
    this.text = text
    const { canvas, ctx } = this
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(10,16,28,0.8)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = color
    ctx.font = '38px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, canvas.width / 2, canvas.height / 2)
    this.tex.needsUpdate = true
  }

  hide() { this.mesh.visible = false }
}

/** Baselines on either side of `t`, linearly interpolated; one side alone when the other does not exist. */
function baselineAt(bases, t, field) {
  let before = null
  let after = null
  for (const b of bases) {
    if (b.t <= t) before = b
    else if (!after) after = b
  }
  if (!before && !after) throw new Error('perf trace: no baseline sample to compare against')
  if (!before) return after[field]
  if (!after) return before[field]
  const f = (t - before.t) / (after.t - before.t)
  return before[field] + (after[field] - before[field]) * f
}

export class PerfTrace {
  /**
   * host: {
   *   camera,                         the head, for the HUD and for movement during a sample
   *   gpuTake(),                      mean GPU ms per frame since the last call, or null (gpu-timer.js)
   *   spikes(),                       the Spikes instance, whose laps for the current frame are summed per stage
   *   toggles,                        main.js questToggles, read only
   *   setToggle(key, on),             flip a row to `on` the way its button would
   *   present(key),                   whether the row's layer exists in this room; drills on absent layers are skipped
   *   anyPress(),                     whether any controller button went down this frame
   *   hidePanel(),                    close the menu, whose stats texture would be measured too
   *   context(),                      what to record about where and how the run happened
   *   play(clip, rate, gain), pulse(intensity, ms)
   *   refresh(),                      repaint the debug row that shows label()
   * }
   */
  constructor(host) {
    this.host = host
    this.state = 'idle' // 'idle' | 'running' | 'saving' | 'done' | 'failed'
    this.status = ''
    this.trace = null
    this.frameMs = new Float32Array(MAX_FRAMES)
    this.hud = new TraceHud(host.camera)
    this.lastAt = 0
  }

  get running() { return this.state === 'running' }

  /** The debug row's value. */
  label() {
    if (this.state === 'running') return `step ${this.trace.samples.length + 1}`
    return this.status || 'press'
  }

  start() {
    if (this.state === 'running' || this.state === 'saving') return
    const { toggles } = this.host
    for (const g of GROUPS) {
      for (const key of [...g.off, ...g.drill.flatMap((d) => d.off)]) {
        if (!(key in toggles)) throw new Error(`perf-suite.js names toggle "${key}", which main.js questToggles does not have`)
      }
    }
    this.host.hidePanel()
    this.baseline = { ...toggles }
    const now = performance.now()
    this.startedAt = now
    this.trace = {
      startedAt: new Date().toISOString(),
      suite: { SETTLE_MS, MEASURE_MS, BASELINE_EVERY, DRILL_MIN_MS, MAX_DRILL },
      context: this.host.context(),
      samples: [],
    }
    this.queue = this.withBaselines(GROUPS.map((g) => ({ kind: 'group', name: g.name, off: g.off, round: 1 })), true)
    this.queue.push(...this.withBaselines(GROUPS.filter((g) => !g.once).map((g) => ({ kind: 'group', name: g.name, off: g.off, round: 2 })).reverse(), false))
    this.drilled = false
    this.state = 'running'
    this.host.play('uiPop', 1, 0.4)
    this.lastAt = now
    this.begin(now)
  }

  /** `steps` with a baseline after every BASELINE_EVERY of them and at the end, and at the start when `lead`. */
  withBaselines(steps, lead) {
    const out = lead ? [{ kind: 'base', name: 'baseline', off: [] }] : []
    steps.forEach((s, i) => {
      out.push(s)
      if ((i + 1) % BASELINE_EVERY === 0 || i === steps.length - 1) out.push({ kind: 'base', name: 'baseline', off: [] })
    })
    return out
  }

  begin(now) {
    this.step = this.queue.shift()
    this.applyState(this.step.off)
    this.stepAt = now
    this.n = 0
    this.js = this.render = this.calls = this.tris = 0
    this.stages = {}
    this.worstMs = 0
    this.worstStages = {}
    this.host.gpuTake()
    this.moveM = this.turnRad = 0
    this.pos0 = null
  }

  applyState(off) {
    const { baseline } = this
    for (const key of Object.keys(baseline)) {
      if (typeof baseline[key] !== 'boolean') continue
      const want = baseline[key] && !off.includes(key)
      if (this.host.toggles[key] !== want) this.host.setToggle(key, want)
    }
  }

  /** Every frame, after the main render. `f` is { jsMs, renderMs, calls, tris }. */
  frame(f) {
    try {
      this.advance(f)
    } catch (err) {
      // Once, not every frame: the run is over and the world is put back.
      if (this.state === 'running') this.applyState([])
      this.end('failed', 'FAILED', `TRACE FAILED: ${err.message}`.slice(0, 44), '#ff6b6b')
      throw err
    }
  }

  advance(f) {
    const now = performance.now()
    const ms = now - this.lastAt
    this.lastAt = now
    if (this.state === 'done' || this.state === 'failed') {
      if (now - this.endedAt > DONE_SHOWN_MS) this.hud.hide()
      return
    }
    if (this.state !== 'running') return
    if (now - this.startedAt > ABORT_GRACE_MS && this.host.anyPress()) {
      this.finish(now, true)
      return
    }
    const into = now - this.stepAt
    const left = Math.ceil((this.queue.length * (SETTLE_MS + MEASURE_MS) + Math.max(0, SETTLE_MS + MEASURE_MS - into)) / 1000)
    const what = this.step.kind === 'base' ? 'baseline' : `${this.step.name} off`
    this.hud.show(`TRACE ${this.trace.samples.length + 1}  ${what}  ~${left}s${this.drilled ? '' : '+'}  hold still`, '#ffd27a')
    if (into < SETTLE_MS) return

    const cam = this.host.camera
    cam.getWorldPosition(_pos)
    cam.getWorldQuaternion(_quat)
    if (!this.pos0) {
      this.host.gpuTake()
      this.pos0 = _pos.clone()
      this.quat0 = _quat.clone()
    } else if (this.n < MAX_FRAMES) {
      this.frameMs[this.n] = ms
      this.js += f.jsMs
      this.render += f.renderMs
      this.calls += f.calls
      this.tris += f.tris
      const { names, ms: lapMs, n: laps } = this.host.spikes()
      for (let i = 0; i < laps; i++) this.stages[names[i]] = (this.stages[names[i]] ?? 0) + lapMs[i]
      if (ms > this.worstMs) {
        this.worstMs = ms
        this.worstStages = {}
        for (let i = 0; i < laps; i++) this.worstStages[names[i]] = (this.worstStages[names[i]] ?? 0) + lapMs[i]
      }
      this.moveM = Math.max(this.moveM, _pos.distanceTo(this.pos0))
      this.turnRad = Math.max(this.turnRad, _quat.angleTo(this.quat0))
      this.n++
    }
    if (into < SETTLE_MS + MEASURE_MS || this.n < MIN_FRAMES) return
    this.bank(now)
    if (!this.queue.length && !this.drilled) this.queueDrill()
    if (this.queue.length) this.begin(now)
    else this.finish(now, false)
  }

  bank(now) {
    const { n } = this
    const sorted = Array.from(this.frameMs.subarray(0, n)).sort((a, b) => a - b)
    const mean = sorted.reduce((s, v) => s + v, 0) / n
    const stages = {}
    for (const [k, v] of Object.entries(this.stages)) if (v / n >= SPIKES.floor) stages[k] = r2(v / n)
    this.trace.samples.push({
      kind: this.step.kind, name: this.step.name, round: this.step.round ?? null,
      off: this.step.off.filter((k) => this.baseline[k]),
      alreadyOff: this.step.off.filter((k) => !this.baseline[k]),
      t: r2(now - this.startedAt - MEASURE_MS / 2),
      frames: n,
      ms: r2(mean), p50: r2(quantile(sorted, 0.5)), p95: r2(quantile(sorted, 0.95)), max: r2(sorted[n - 1]),
      jsMs: r2(this.js / n), renderMs: r2(this.render / n),
      // The frame interval no js or render lap explains: compositor, GPU and vsync wait.
      gpuMs: this.gpuMs(),
      waitMs: r2(Math.max(0, mean - this.js / n - this.render / n)),
      stages,
      // The slowest frame of the sample and where its laps went: what a stall was, without a record trace.
      worst: { ms: r2(this.worstMs), stages: Object.fromEntries(Object.entries(this.worstStages).filter(([, v]) => v >= SPIKES.floor).map(([k, v]) => [k, r2(v)])) },
      calls: Math.round(this.calls / n), tris: Math.round(this.tris / n),
      moveCm: Math.round(this.moveM * 100), turnDeg: Math.round(THREE.MathUtils.radToDeg(this.turnRad)),
    })
  }

  gpuMs() {
    const ms = this.host.gpuTake()
    return ms === null ? null : r2(ms)
  }

  /** Per non-baseline sample, frame and CPU ms saved against the drift-corrected baseline. */
  savings() {
    const bases = this.trace.samples.filter((s) => s.kind === 'base')
    return this.trace.samples.filter((s) => s.kind !== 'base').map((s) => ({
      name: s.name, kind: s.kind, round: s.round,
      savedMs: r2(baselineAt(bases, s.t, 'ms') - s.ms),
      savedP50: r2(baselineAt(bases, s.t, 'p50') - s.p50),
      savedJsMs: r2(baselineAt(bases, s.t, 'jsMs') - s.jsMs),
      savedRenderMs: r2(baselineAt(bases, s.t, 'renderMs') - s.renderMs),
      savedCalls: Math.round(baselineAt(bases, s.t, 'calls') - s.calls),
      savedTris: Math.round(baselineAt(bases, s.t, 'tris') - s.tris),
    }))
  }

  queueDrill() {
    this.drilled = true
    const saved = this.savings()
    const meanSaved = (name) => {
      const rows = saved.filter((r) => r.kind === 'group' && r.name === name)
      return rows.reduce((s, r) => s + r.savedP50, 0) / rows.length
    }
    const guilty = GROUPS
      .map((g) => ({ g, saved: meanSaved(g.name) }))
      .filter(({ saved }) => saved >= DRILL_MIN_MS)
      .sort((a, b) => b.saved - a.saved)
      .map(({ g }) => g.drill
        .map((d) => ({ kind: 'drill', name: `${g.name}/${d.name}`, off: d.off }))
        .filter((d) => d.off.some((k) => this.host.present(k))))
    // Round-robin across the guilty groups, costliest first within each, so the cap trims every group's tail and no
    // group is starved by a bigger one ahead of it. A ladder's rungs are nested, so any prefix is still valid.
    const drill = []
    for (let rung = 0; guilty.some((d) => rung < d.length); rung++) for (const d of guilty) if (rung < d.length) drill.push(d[rung])
    this.trace.drillSkipped = drill.slice(MAX_DRILL).map((d) => d.name)
    if (drill.length) this.queue.push(...this.withBaselines(drill.slice(0, MAX_DRILL), false))
  }

  finish(now, aborted) {
    this.applyState([])
    this.trace.aborted = aborted
    this.trace.seconds = r2((now - this.startedAt) / 1000)
    this.trace.savings = this.trace.samples.some((s) => s.kind === 'base') ? this.savings() : []
    window.v2trace = this.trace // console: the last run, uploaded or not
    this.state = 'saving'
    this.hud.show(aborted ? 'TRACE ABORTED, saving partial' : 'TRACE MEASURED, saving', '#cfe3ff')
    this.upload()
  }

  async upload() {
    try {
      const id = await postTrace(this.trace)
      this.end('done', `saved ${id}`, `TRACE ${this.trace.aborted ? 'ABORTED' : 'DONE'}  saved ${id}`, '#8fd48f')
      for (const [i, rate] of [1, 1.26, 1.5].entries()) setTimeout(() => this.host.play('uiPop', rate, 0.6), i * 180)
      this.host.pulse(0.8, 300)
    } catch (err) {
      console.error('perf trace upload failed', err)
      this.end('failed', 'UPLOAD FAILED', `TRACE UPLOAD FAILED: ${err.message}`.slice(0, 44), '#ff6b6b')
      this.host.play('uiClose', 0.6, 0.8)
    }
  }

  end(state, status, hud, color) {
    this.state = state
    this.status = status
    this.endedAt = performance.now()
    this.hud.show(hud, color)
    this.host.refresh()
  }
}
