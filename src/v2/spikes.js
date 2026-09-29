// Temporary long-frame logger (window.v2spikes). tick() calls begin() first and lap(name) after each stage; tock() laps 'render'. A frame interval over SPIKES.ms warns the previous frame's stages, slowest first, and log-ship posts the warning to tmp/client-log.txt. `other` is the interval no stage covers: A-Frame's other components, GC, the browser.
export const SPIKES = { ms: 25, floor: 0.3, keep: 100 }

export class Spikes {
  constructor() {
    this.names = []
    this.ms = []
    this.n = 0
    this.at = 0
    this.recent = []
  }

  // A gap past a second is a background tab, not a stutter.
  begin(now, raw) {
    if (raw > SPIKES.ms && raw < 1000 && this.n > 0) this._report(raw)
    this.n = 0
    this.at = now
  }

  lap(name) {
    const now = performance.now()
    this.names[this.n] = name
    this.ms[this.n++] = now - this.at
    this.at = now
  }

  _report(raw) {
    let sum = 0
    const parts = []
    for (let i = 0; i < this.n; i++) {
      sum += this.ms[i]
      if (this.ms[i] >= SPIKES.floor) parts.push([this.names[i], this.ms[i]])
    }
    parts.push(['other', raw - sum])
    parts.sort((a, b) => b[1] - a[1])
    const line = `spike ${raw.toFixed(1)} ms: ${parts.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`
    this.recent.push(line)
    if (this.recent.length > SPIKES.keep) this.recent.shift()
    console.warn(line)
  }
}
