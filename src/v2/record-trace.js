// The manual recorder: press the debug row to start, walk or fly somewhere slow, press it again to stop
// and upload. Unlike perf-trace.js it changes nothing in the world -- it logs what the frames cost where
// the player actually was, in WINDOW_MS windows, plus the worst frames with their per-stage breakdown
// (the Spikes laps from tick()/tock()). Read with `node scripts/trace-report.mjs`.

import { TraceHud, postTrace, quantile, r2 } from './perf-trace.js'
import { SPIKES } from './spikes.js'

const WINDOW_MS = 2000
// Keeps the upload far under the server's 1 MB cap (about 300 windows of ~0.7 KB).
const MAX_MS = 10 * 60 * 1000
const MAX_SPIKES = 40
const MAX_FRAMES = 512
const DONE_SHOWN_MS = 12000

export class RecordTrace {
  /**
   * host: {
   *   camera, spikes (the Spikes instance, whose laps for the current frame are read in frame()),
   *   position() -> {x, y, z}, flying() -> bool, context(), hidePanel(),
   *   play(clip, rate, gain), pulse(intensity, ms), refresh()
   * }
   */
  constructor(host) {
    this.host = host
    this.state = 'idle' // 'idle' | 'recording' | 'saving' | 'done' | 'failed'
    this.status = ''
    this.hud = new TraceHud(host.camera)
    this.frameMs = new Float32Array(MAX_FRAMES)
    this.lastAt = 0
  }

  get recording() { return this.state === 'recording' }

  /** The debug row's value. */
  label() {
    if (this.state === 'recording') return `stop ${Math.round((performance.now() - this.startedAt) / 1000)}s`
    return this.status || 'start'
  }

  /** The debug row's action: start, or stop and upload. */
  toggle() {
    if (this.state === 'recording') this.stop(false)
    else if (this.state !== 'saving') this.start()
  }

  start() {
    this.host.hidePanel()
    const now = performance.now()
    this.startedAt = now
    this.lastAt = now
    this.trace = {
      mode: 'record',
      startedAt: new Date().toISOString(),
      context: this.host.context(),
      samples: [],
      spikes: [],
    }
    this.openWindow(now)
    this.state = 'recording'
    this.status = ''
    this.host.play('uiPop', 1, 0.4)
    this.host.refresh()
  }

  openWindow(now) {
    this.windowAt = now
    this.n = 0
    this.js = this.render = this.calls = this.tris = 0
    this.stages = {}
    this.stageMs = 0
  }

  /** Every frame, after the main render and before the overlay lap. `f` is { jsMs, renderMs, calls, tris }. */
  frame(f) {
    const now = performance.now()
    const ms = now - this.lastAt
    this.lastAt = now
    if (this.state === 'done' || this.state === 'failed') {
      if (now - this.endedAt > DONE_SHOWN_MS) this.hud.hide()
      return
    }
    if (this.state !== 'recording') return
    this.hud.show(`REC ${Math.round((now - this.startedAt) / 1000)}s  press the row again to stop`, '#ff9a9a')
    // A gap past a second is a background tab, not a stutter (as in Spikes).
    if (ms < 1000) this.record(now, ms, f)
    if (now - this.windowAt >= WINDOW_MS) this.bank(now)
    if (now - this.startedAt >= MAX_MS) this.stop(true)
  }

  record(now, ms, f) {
    const { spikes } = this.host
    if (this.n < MAX_FRAMES) this.frameMs[this.n] = ms
    this.n++
    this.js += f.jsMs
    this.render += f.renderMs
    this.calls += f.calls
    this.tris += f.tris
    let sum = 0
    for (let i = 0; i < spikes.n; i++) {
      this.stages[spikes.names[i]] = (this.stages[spikes.names[i]] ?? 0) + spikes.ms[i]
      sum += spikes.ms[i]
    }
    this.stageMs += sum
    if (ms > SPIKES.ms) this.keepSpike(now, ms, sum)
  }

  /** The worst MAX_SPIKES frames, stages under SPIKES.floor dropped; `other` is the part of the interval the laps did not cover. */
  keepSpike(now, ms, sum) {
    const { spikes } = this.host
    const spikeList = this.trace.spikes
    if (spikeList.length >= MAX_SPIKES && ms <= spikeList[spikeList.length - 1].ms) return
    const stages = {}
    for (let i = 0; i < spikes.n; i++) if (spikes.ms[i] >= SPIKES.floor) stages[spikes.names[i]] = r2(spikes.ms[i])
    stages.other = r2(Math.max(0, ms - sum))
    const p = this.host.position()
    spikeList.push({ t: r2((now - this.startedAt) / 1000), ms: r2(ms), x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), flying: this.host.flying(), stages })
    spikeList.sort((a, b) => b.ms - a.ms)
    if (spikeList.length > MAX_SPIKES) spikeList.pop()
  }

  bank(now) {
    const { n } = this
    if (n > 0) {
      const kept = Math.min(n, MAX_FRAMES)
      const sorted = Array.from(this.frameMs.subarray(0, kept)).sort((a, b) => a - b)
      const span = now - this.windowAt
      const p = this.host.position()
      const stages = {}
      for (const [k, v] of Object.entries(this.stages)) if (v / n >= SPIKES.floor) stages[k] = r2(v / n)
      this.trace.samples.push({
        t: r2((now - this.startedAt) / 1000),
        x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), flying: this.host.flying(),
        frames: n, ms: r2(span / n), p50: r2(quantile(sorted, 0.5)), p95: r2(quantile(sorted, 0.95)), max: r2(sorted[kept - 1]),
        jsMs: r2(this.js / n), renderMs: r2(this.render / n),
        calls: Math.round(this.calls / n), tris: Math.round(this.tris / n),
        stages,
      })
    }
    this.openWindow(now)
  }

  stop(auto) {
    const now = performance.now()
    this.bank(now)
    this.trace.aborted = false
    this.trace.autoStopped = auto
    this.trace.seconds = r2((now - this.startedAt) / 1000)
    window.v2record = this.trace // console: the last recording, uploaded or not
    if (!this.trace.samples.length) {
      this.end('failed', 'NOTHING RECORDED', 'RECORDING EMPTY, nothing saved', '#ff6b6b')
      return
    }
    this.state = 'saving'
    this.status = 'saving'
    this.hud.show('REC STOPPED, saving', '#cfe3ff')
    this.host.refresh()
    this.upload()
  }

  async upload() {
    try {
      const id = await postTrace(this.trace)
      this.end('done', `saved ${id}`, `REC DONE  saved ${id}`, '#8fd48f')
      for (const [i, rate] of [1, 1.26, 1.5].entries()) setTimeout(() => this.host.play('uiPop', rate, 0.6), i * 180)
      this.host.pulse(0.8, 300)
    } catch (err) {
      console.error('record trace upload failed', err)
      this.end('failed', 'UPLOAD FAILED', `REC UPLOAD FAILED: ${err.message}`.slice(0, 44), '#ff6b6b')
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
