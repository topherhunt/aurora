// Her voice as a trigger (_notes/conversation-and-quests.md, "Starting a conversation"): only a spike in the mic's
// level counts, what she says is never heard. getUserMedia needs a secure page and a permission prompt; the Quest
// browser grants both over HTTPS. Until the mic is on (or where it is refused), a key stands in.

export const MIC = {
  // RMS, 0..1, over the running floor that counts as speech.
  over: 0.04,
  // ...and as a multiple of the floor, so a windy room does not chatter.
  ratio: 3,
  // How fast the floor follows a quieter level, per second, and a louder one.
  fall: 2,
  rise: 0.2,
  // A spike then holds off the next for this long, s.
  holdoff: 1.2,
}

export class Mic {
  constructor(ctx) {
    this.ctx = ctx
    this.analyser = null
    this.data = null
    this.floor = 0.01
    this.last = -Infinity
    this.state = 'off'
    this.error = null
  }

  /** Ask for the mic; call from a user gesture. Resolves once it is listening, or with `state` 'denied'. */
  async start() {
    if (this.state !== 'off') return
    this.state = 'asking'
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
      const src = this.ctx.createMediaStreamSource(stream)
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 1024
      this.data = new Float32Array(this.analyser.fftSize)
      // Into a muted gain to the output: some browsers never pull an analyser that leads nowhere, and it reads silence.
      const mute = this.ctx.createGain()
      mute.gain.value = 0
      src.connect(this.analyser).connect(mute).connect(this.ctx.destination)
      this.state = 'on'
    } catch (e) {
      this.state = 'denied'
      this.error = e
      console.warn('Mic: no microphone, a key stands in --', e)
    }
  }

  /** The level now, 0..1 RMS. */
  level() {
    this.analyser.getFloatTimeDomainData(this.data)
    let s = 0
    for (const v of this.data) s += v * v
    return Math.sqrt(s / this.data.length)
  }

  /** Whether she just spoke up: call once a frame. */
  spike(now, dt) {
    if (this.state !== 'on') return false
    const v = this.level()
    const k = Math.min(1, dt * (v < this.floor ? MIC.fall : MIC.rise))
    const hit = v > this.floor + MIC.over && v > this.floor * MIC.ratio && now - this.last > MIC.holdoff
    this.floor += (v - this.floor) * k
    if (hit) this.last = now
    return hit
  }
}
