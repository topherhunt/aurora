// Ambient traces: while she plays in the headset, short captures of what the frames cost upload in the
// background, with nothing shown or heard. record-trace.js's windows run all the time into a ring, and a
// capture is the ring's tail, cut when one of these fires (each at least GAP_MS after the last capture):
//   'place'  -- an environment (where she is, day or night, dry or rain or snow) has held for STABLE_MS plus a
//               random wait; each environment at most twice a session, PLACE_REPEAT_MS apart.
//   'flight' -- flying faster than FAST_MPS for the whole capture, at most once per FLIGHT_EVERY_MS.
//   'slow'   -- SLOW.run windows in a row over SLOW.factor x the session's median, with the lead-up kept.
// Anything that would skew the windows -- out of XR, the panel open, the battery or the manual recorder
// running, a pause past a second -- empties the ring. Read with `node scripts/trace-report.mjs --ambient`.

import { postTrace, r2 } from './perf-trace.js'
import { TraceWindows, WINDOW_MS } from './record-trace.js'

const RING = 30
const CAPTURE = 10
const GAP_MS = 60 * 1000
const STABLE_MS = 20 * 1000
const RANDOM_MS = 60 * 1000
const PLACE_REPEAT_MS = 10 * 60 * 1000
const FAST_MPS = 40
const FLIGHT_EVERY_MS = 15 * 60 * 1000
const SLOW = { factor: 1.4, run: 3, after: 3, windows: 15, history: 150, minHistory: 30, max: 4, everyMs: 5 * 60 * 1000 }
// Thresholds in pairs, so a reading hovering on one does not flip the environment every window.
const DAY = [0.45, 0.55] // dayness
const WET = [0.25, 0.4] // visible precip intensity
const SNOW = 0.5 // precip.snow, the rain-to-snow blend
const FOREST = [20, 30] // trunks in the host's box round her
const ALOFT_M = 40 // metres over the ground

export class AmbientTrace {
  /**
   * host: TraceWindows' host, plus {
   *   active() -> bool (in XR, nothing open or running that skews a frame), context(),
   *   env() -> { room: 'overworld' | 'glade' | 'house' | 'hut' | 'cave', town: bool, trunks, agl, dayness, precip, snow }
   * }
   */
  constructor(host) {
    this.host = host
    this.session = Math.random().toString(36).slice(2, 8)
    this.saved = 0
    this.failed = 0
    this.lastError = ''
    this.lastCaptureAt = -Infinity
    this.lastFlightAt = -Infinity
    this.lastSlowAt = -Infinity
    this.slowCount = 0
    this.places = new Map() // env key -> times captured this session
    this.placeAt = new Map() // env key -> when it was last captured
    this.history = []
    this.env = { place: 'open', time: 'day', sky: 'dry', key: '' }
    this.reset(performance.now())
  }

  reset(now) {
    this.windows = null
    this.ring = []
    this.lastAt = now
    this.lastPos = null
    this.fastWindows = 0
    this.slowRun = 0
    this.pending = null
    this.envSince = now
    this.envWait = STABLE_MS + Math.random() * RANDOM_MS
  }

  /** The debug panel's cells: captures saved and failed, and the environment she is in. */
  status() {
    return { saved: this.saved, failed: this.failed, env: this.env.key, error: this.lastError }
  }

  /** Every frame, after the main render. `f` is { jsMs, renderMs, calls, tris }. */
  frame(f) {
    const now = performance.now()
    const ms = now - this.lastAt
    this.lastAt = now
    if (!this.host.active() || ms >= 1000) {
      if (this.windows !== null) this.reset(now)
      return
    }
    if (this.windows === null) this.windows = new TraceWindows(this.host, now)
    this.windows.add(ms, f)
    if (now - this.windows.windowAt >= WINDOW_MS) this.bank(now)
  }

  bank(now) {
    const span = now - this.windows.windowAt
    const sample = this.windows.bank(now)
    if (sample === null) return
    const speed = this.lastPos === null ? 0 : Math.hypot(sample.x - this.lastPos.x, sample.z - this.lastPos.z) / (span / 1000)
    this.lastPos = { x: sample.x, z: sample.z }
    const e = this.classify(now)
    sample.at = now
    sample.trunks = e.trunks
    sample.speed = Math.round(speed)
    sample.env = this.env.key
    this.ring.push(sample)
    if (this.ring.length > RING) this.ring.shift()
    this.fastWindows = sample.flying && speed > FAST_MPS ? this.fastWindows + 1 : 0
    this.countSlow(sample)
    if (this.pending !== null) {
      if (--this.pending.after <= 0) this.cut(now)
      return
    }
    this.watchSlow(now)
    if (this.pending === null) this.watchPlace(now)
    if (this.pending === null) this.watchFlight(now)
  }

  classify(now) {
    const e = this.host.env()
    const prev = this.env
    let place = e.room
    if (e.room === 'overworld') {
      if (e.agl > ALOFT_M) place = 'aloft'
      else if (e.town) place = 'town'
      else place = e.trunks >= FOREST[1] || (prev.place === 'forest' && e.trunks >= FOREST[0]) ? 'forest' : 'open'
    }
    const time = e.dayness > DAY[1] ? 'day' : e.dayness < DAY[0] ? 'night' : prev.time
    const wet = e.precip > WET[1] || (prev.sky !== 'dry' && e.precip > WET[0])
    const sky = wet ? (e.snow > SNOW ? 'snow' : 'rain') : 'dry'
    const indoors = place === 'house' || place === 'hut' || place === 'cave'
    const key = indoors ? place : `${place}/${time}/${sky}`
    if (key !== prev.key) {
      this.envSince = now
      this.envWait = STABLE_MS + Math.random() * RANDOM_MS
    }
    this.env = { place, time, sky, key }
    return e
  }

  watchPlace(now) {
    const { key } = this.env
    const n = this.places.get(key) ?? 0
    if (n >= 2 || (n === 1 && now - this.placeAt.get(key) < PLACE_REPEAT_MS)) return
    if (now - this.envSince < this.envWait || now - this.lastCaptureAt < GAP_MS || this.ring.length < CAPTURE) return
    this.places.set(key, n + 1)
    this.placeAt.set(key, now)
    this.capture(now, 'place', CAPTURE, 0)
  }

  watchFlight(now) {
    if (this.fastWindows < CAPTURE || now - this.lastFlightAt < FLIGHT_EVERY_MS || now - this.lastCaptureAt < GAP_MS) return
    this.lastFlightAt = now
    this.capture(now, 'flight', CAPTURE, 0)
  }

  /** Whether this window is over SLOW.factor x the median of the SLOW.history before it, and how many in a row have been. */
  countSlow(sample) {
    const h = this.history
    this.median = h.length >= SLOW.minHistory ? [...h].sort((a, b) => a - b)[h.length >> 1] : Infinity
    h.push(sample.ms)
    if (h.length > SLOW.history) h.shift()
    this.slowRun = sample.ms > SLOW.factor * this.median ? this.slowRun + 1 : 0
  }

  /** SLOW.run slow windows in a row cut a capture SLOW.after windows later, so it holds the lead-up and the recovery. */
  watchSlow(now) {
    if (this.slowRun < SLOW.run || this.slowCount >= SLOW.max) return
    if (now - this.lastSlowAt < SLOW.everyMs || now - this.lastCaptureAt < GAP_MS) return
    this.slowCount++
    this.lastSlowAt = now
    this.capture(now, 'slow', SLOW.windows, SLOW.after, { medianMs: r2(this.median) })
  }

  capture(now, trigger, windows, after, extra = {}) {
    this.lastCaptureAt = now
    this.pending = { trigger, windows, after, env: this.env.key, extra }
    if (after === 0) this.cut(now)
  }

  /** The ring's last `windows` samples as one trace, uploaded once the browser is idle. */
  cut(now) {
    const { trigger, windows, env, extra } = this.pending
    this.pending = null
    const samples = this.ring.slice(-windows)
    const t0 = samples[0].at - WINDOW_MS
    const trace = {
      mode: 'ambient',
      trigger,
      env,
      session: this.session,
      ...extra,
      startedAt: new Date(Date.now() - (now - t0)).toISOString(),
      seconds: r2((now - t0) / 1000),
      context: this.host.context(),
      samples: samples.map(({ at, ...s }) => ({ ...s, t: r2((at - t0) / 1000) })),
    }
    const send = () => this.upload(trace)
    if (window.requestIdleCallback) requestIdleCallback(send, { timeout: 5000 })
    else setTimeout(send, 0)
  }

  async upload(trace) {
    try {
      await postTrace(trace)
      this.saved++
    } catch (err) {
      this.failed++
      this.lastError = err.message
      console.error(`ambient trace (${trace.trigger} ${trace.env}) upload failed`, err)
    }
  }
}
