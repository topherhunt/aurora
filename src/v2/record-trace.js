// The manual recorder: press the debug row to start, walk or fly somewhere slow, press it again to stop
// and upload. Unlike perf-trace.js it changes nothing in the world -- it logs what the frames cost where
// the player actually was, in WINDOW_MS windows, plus the worst frames with their per-stage breakdown
// (the Spikes laps from tick()/tock()). ambient-trace.js runs the same windows with no HUD.
// Read with `node scripts/trace-report.mjs`.

import { TraceHud, postTrace, quantile, r2 } from './perf-trace.js'
import { SPIKES } from './spikes.js'

export const WINDOW_MS = 2000
// Keeps the upload far under the server's 1 MB cap (about 300 windows of ~1 KB).
const MAX_MS = 10 * 60 * 1000
const MAX_SPIKES = 40
const MAX_FRAMES = 512
const DONE_SHOWN_MS = 12000

/**
 * Frames folded into WINDOW_MS samples: frame ms quantiles, js/render/GPU ms, mean laps per stage, the
 * window's slowest frame with its laps, and host.layers() (what each layer drew) as the window closes.
 * host: { spikes, gpuTake(), position() -> {x, y, z}, flying() -> bool, layers() -> object }
 */
export class TraceWindows {
  constructor(host, originAt) {
    this.host = host
    this.originAt = originAt
    this.frameMs = new Float32Array(MAX_FRAMES)
    this.open(originAt)
  }

  open(now) {
    this.windowAt = now
    this.n = 0
    this.js = this.render = this.calls = this.tris = 0
    this.stages = {}
    this.worst = null
    this.worstMs = SPIKES.ms
    this.host.gpuTake()
  }

  /** One frame `ms` long; `f` is { jsMs, renderMs, calls, tris }. Returns the sum of its laps. */
  add(ms, f) {
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
    if (ms > this.worstMs) {
      this.worstMs = ms
      this.worst = { ms: r2(ms), stages: lapsOf(spikes, ms, sum) }
    }
    return sum
  }

  /** Closes the window at `now` and opens the next; its sample, or null when no frame landed in it. */
  bank(now) {
    const { n } = this
    let sample = null
    if (n > 0) {
      const kept = Math.min(n, MAX_FRAMES)
      const sorted = Array.from(this.frameMs.subarray(0, kept)).sort((a, b) => a - b)
      const span = now - this.windowAt
      const p = this.host.position()
      const stages = {}
      for (const [k, v] of Object.entries(this.stages)) if (v / n >= SPIKES.floor) stages[k] = r2(v / n)
      const gpu = this.host.gpuTake()
      sample = {
        t: r2((now - this.originAt) / 1000),
        x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), flying: this.host.flying(),
        frames: n, ms: r2(span / n), p50: r2(quantile(sorted, 0.5)), p95: r2(quantile(sorted, 0.95)), max: r2(sorted[kept - 1]),
        jsMs: r2(this.js / n), renderMs: r2(this.render / n), gpuMs: gpu === null ? null : r2(gpu),
        calls: Math.round(this.calls / n), tris: Math.round(this.tris / n),
        stages, worst: this.worst, layers: this.host.layers(),
      }
    }
    this.open(now)
    return sample
  }
}

/** A frame's laps, those under SPIKES.floor dropped; `other` is the part of the interval the laps did not cover. */
function lapsOf(spikes, ms, sum) {
  const stages = {}
  for (let i = 0; i < spikes.n; i++) if (spikes.ms[i] >= SPIKES.floor) stages[spikes.names[i]] = r2(spikes.ms[i])
  stages.other = r2(Math.max(0, ms - sum))
  return stages
}

export class RecordTrace {
  /**
   * host: TraceWindows' host, plus {
   *   camera, context(), hidePanel(), play(clip, rate, gain), pulse(intensity, ms), refresh()
   * }
   */
  constructor(host) {
    this.host = host
    this.state = 'idle' // 'idle' | 'recording' | 'saving' | 'done' | 'failed'
    this.status = ''
    this.hud = new TraceHud(host.camera)
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
    this.windows = new TraceWindows(this.host, now)
    this.state = 'recording'
    this.status = ''
    this.host.play('uiPop', 1, 0.4)
    this.host.refresh()
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
    if (ms < 1000) {
      const sum = this.windows.add(ms, f)
      if (ms > SPIKES.ms) this.keepSpike(now, ms, sum)
    }
    if (now - this.windows.windowAt >= WINDOW_MS) this.bank(now)
    if (now - this.startedAt >= MAX_MS) this.stop(true)
  }

  /** The worst MAX_SPIKES frames of the recording. */
  keepSpike(now, ms, sum) {
    const spikeList = this.trace.spikes
    if (spikeList.length >= MAX_SPIKES && ms <= spikeList[spikeList.length - 1].ms) return
    const p = this.host.position()
    spikeList.push({ t: r2((now - this.startedAt) / 1000), ms: r2(ms), x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), flying: this.host.flying(), stages: lapsOf(this.host.spikes, ms, sum) })
    spikeList.sort((a, b) => b.ms - a.ms)
    if (spikeList.length > MAX_SPIKES) spikeList.pop()
  }

  bank(now) {
    const sample = this.windows.bank(now)
    if (sample !== null) this.trace.samples.push(sample)
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
