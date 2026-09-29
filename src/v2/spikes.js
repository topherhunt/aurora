// Temporary long-frame logger (window.v2spikes). tick() calls begin() first and lap(name) after each stage; tock() laps 'render' on entry and calls end() on exit. A frame interval over SPIKES.ms warns the previous frame's stages, slowest first, and log-ship posts the warning to tmp/client-log.txt. `between` is tock's end to the next tick: A-Frame's systems and later tocks, worker replies, timers, GC, and the browser waiting on the GPU. `longtask` is how much of `between` Chrome saw as main-thread tasks over 50 ms; a long `between` with none is the browser or GPU, not script. Long-task entries arrive late, so a spike is reported SPIKES.wait ms after it.
export const SPIKES = { ms: 25, floor: 0.3, keep: 100, wait: 500 }

export class Spikes {
  constructor() {
    this.names = []
    this.ms = []
    this.n = 0
    this.at = 0
    this.ended = 0
    this.recent = []
    this.tasks = []
    this.pending = []
    this.observed = PerformanceObserver.supportedEntryTypes.includes('longtask')
    if (this.observed) new PerformanceObserver((list) => this.tasks.push(...list.getEntries())).observe({ type: 'longtask' })
  }

  // A gap past a second is a background tab, not a stutter.
  begin(now, raw) {
    if (this.ended > 0) {
      this.names[this.n] = 'between'
      this.ms[this.n++] = now - this.ended
    }
    if (raw > SPIKES.ms && raw < 1000 && this.n > 0) this._hold(raw, now)
    while (this.pending.length > 0 && now - this.pending[0].to > SPIKES.wait) this._report(this.pending.shift())
    this.tasks = this.tasks.filter((t) => now - t.startTime < 4 * SPIKES.wait)
    this.n = 0
    this.at = now
    this.ended = 0
  }

  lap(name) {
    const now = performance.now()
    this.names[this.n] = name
    this.ms[this.n++] = now - this.at
    this.at = now
  }

  end() {
    this.lap('overlay')
    this.ended = this.at
  }

  _hold(raw, now) {
    let sum = 0
    const parts = []
    for (let i = 0; i < this.n; i++) {
      sum += this.ms[i]
      if (this.ms[i] >= SPIKES.floor) parts.push([this.names[i], this.ms[i]])
    }
    if (raw - sum >= SPIKES.floor) parts.push(['other', raw - sum])
    this.pending.push({ raw, parts, from: this.ended, to: now })
  }

  _report({ raw, parts, from, to }) {
    if (this.observed && from > 0) {
      let long = 0
      for (const t of this.tasks) if (t.startTime >= from && t.startTime < to) long += t.duration
      parts.push(['longtask', long])
    }
    parts.sort((a, b) => b[1] - a[1])
    const line = `spike ${raw.toFixed(1)} ms: ${parts.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`
    this.recent.push(line)
    if (this.recent.length > SPIKES.keep) this.recent.shift()
    console.warn(line)
  }
}
