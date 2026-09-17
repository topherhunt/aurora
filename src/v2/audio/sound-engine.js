// ---------------------------------------------------------------------------
// SoundEngine: the Web Audio half of the ambience. It knows nothing about the
// world -- Ambience (ambience.js) decides WHAT plays and hands this WHERE and
// HOW LOUD. Raw Web Audio rather than three's Audio classes, so the same code
// runs under A-Frame's bundled three, and so the loop crossfade below can be
// scheduled sample-accurately rather than from the frame loop.
//
// TWO BUSES, `air` and `water`. Every sound above the surface goes through
// `air`; the underwater loop is the only thing on `water`. Submersion is one
// gain swap between them, which is what silences a croak already in flight the
// instant her head goes under, with no per-sound bookkeeping.
//
// DIRECTION IS THE PANNER, DISTANCE IS OURS. A positioned sound sits at its
// true world position so the equal-power pan puts it on the right side of her
// head, but the panner's own distance rolloff is switched off (rolloffFactor 0):
// Ambience fades every sound by its own rule, and two rolloffs stacked would
// make a frog three metres off inaudible.
//
// THE ONE-SHOTS ARE BUDGETED. Every voice is a live resampler on the audio
// thread until its clip ends, so a shot quieter than VOICE_FLOOR is not started
// at all (a hare's step at forty metres is a voice for nothing), and no more
// than MAX_VOICES play at once: a shot past the cap displaces the quietest one
// playing if it is louder than that, and is dropped if it is not. The gain
// asked for is the whole loudness, the panner having no rolloff, so it is the
// right thing to rank on. Loops are not counted: they are the bed itself, a
// fixed handful, and a footfall should never cut the wind.
//
// FAR IS A TREATMENT, NOT JUST A LEVEL. A shot given its `distance` in metres
// is dulled, wetted and late by it, the three things besides loudness that say
// how far off a sound is: a low-pass whose cutoff falls with the metres (air
// soaks up the highs first), a send into one shared VALLEY REVERB that grows
// with them (the direct sound shrinks with distance, the reflected field
// hardly does, so a far sound is mostly wash), and a start delayed by the
// speed of sound, so a roar seen at 250 m lands three-quarters of a second
// after the mouth opens. A shot may also ask for `echo`: a send into one
// shared pair of feedback delays, each return duller than the last, which is
// what a roar does off two hillsides. The reverb's impulse is synthesized at
// boot -- decaying low-passed noise -- and both buses hang off `air`, so the
// surface silences them with everything else. The convolver is the one dear
// node here, which is why there is one of it and not one per voice.
// ---------------------------------------------------------------------------

import { mulberry32 } from '../../sim/mathx.js'

export const VOICE_FLOOR = 0.01
export const MAX_VOICES = 24
// A displaced voice is faded out over this, not cut: a cut is a click.
const CULL_FADE_S = 0.03

// How far ahead of the clock a loop's next cycle is scheduled. Longer than the
// worst frame gap (tick clamps at 100 ms) so a hitch never leaves a gap in the
// brook; short enough that a stop() has little already-queued sound to cut.
const LOOP_LOOKAHEAD_S = 0.4

// The far treatment, by a shot's `distance` in metres. The low-pass cutoff is
// LP_MAX * AIR_M / (AIR_M + d), floored at LP_MIN: 18 kHz beside her, 9 kHz at
// 40 m, 2.5 kHz at 250 m. The reverb send is WET_MAX * d / (d + WET_M) of the
// voice's own gain: a tenth at 3 m, half at 30 m, nine tenths at 250 m.
export const SPEED_OF_SOUND = 343
export const LP_MAX = 18000
export const LP_MIN = 800
export const AIR_M = 40
export const WET_M = 30
export const WET_MAX = 0.8
// The valley reverb's impulse: seconds long, its -60 dB point, the pre-delay
// before the first reflection, and the one-pole cutoff on the noise, so the
// tail is the dull wash of hillsides and not a bathroom. REVERB_LEVEL is its
// return into `air`.
export const REVERB_S = 2.4
export const REVERB_RT60 = 1.8
export const REVERB_PRE_S = 0.03
export const REVERB_LP = 2500
export const REVERB_LEVEL = 0.6
// The echo: two taps, [delay s, feedback], each looped through a low-pass at
// ECHO_LP so every return is duller; ECHO_LEVEL is their return into `air`,
// and they feed the reverb too, so a return is as washed as a far sound.
export const ECHO_TAPS = [[0.47, 0.32], [1.05, 0.25]]
export const ECHO_LP = 1500
export const ECHO_LEVEL = 0.7

// Equal-power fade curve, sampled once; scaled per cycle by the cycle's gain.
const FADE_STEPS = 32
const FADE_IN = new Float32Array(FADE_STEPS)
const FADE_OUT = new Float32Array(FADE_STEPS)
for (let i = 0; i < FADE_STEPS; i++) {
  const t = (i / (FADE_STEPS - 1)) * (Math.PI / 2)
  FADE_IN[i] = Math.sin(t)
  FADE_OUT[i] = Math.cos(t)
}
// cos(pi/2) is 6e-17, not 0: pin the ends so a cycle lands on true silence.
FADE_IN[FADE_STEPS - 1] = 1
FADE_OUT[FADE_STEPS - 1] = 0

function scaled(curve, k) {
  const out = new Float32Array(curve.length)
  for (let i = 0; i < curve.length; i++) out[i] = curve[i] * k
  return out
}

function setParam(param, value, now, tau) {
  if (param && typeof param.setTargetAtTime === 'function') param.setTargetAtTime(value, now, tau)
}

/** The valley's impulse response: REVERB_S of low-passed noise decaying to -60 dB at REVERB_RT60, silent for the pre-delay; a fresh noise per channel so the tail has width. Seeded, so two boots sound the same. */
function valleyImpulse(ctx) {
  const sr = ctx.sampleRate
  const n = Math.ceil(REVERB_S * sr)
  const buffer = ctx.createBuffer(2, n, sr)
  const rand = mulberry32(0x5eed)
  const k = 1 - Math.exp((-2 * Math.PI * REVERB_LP) / sr)
  const pre = Math.floor(REVERB_PRE_S * sr)
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch)
    let lp = 0
    for (let i = pre; i < n; i++) {
      lp += k * (rand() * 2 - 1 - lp)
      data[i] = lp * Math.pow(10, (-3 * (i - pre)) / sr / REVERB_RT60)
    }
  }
  return buffer
}

export class SoundEngine {
  /** @param ctx  an AudioContext; built here when not given, suspended until unlock(). */
  constructor({ ctx = null } = {}) {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!AC) throw new Error('SoundEngine: no AudioContext in this environment')
      ctx = new AC()
    }
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
    this.air = ctx.createGain()
    this.air.connect(this.master)
    this.water = ctx.createGain()
    this.water.gain.value = 0
    this.water.connect(this.master)
    // The valley reverb and the echo, both on air: `reverb` and `echo` are what a voice sends into.
    this.reverb = ctx.createConvolver()
    this.reverb.buffer = valleyImpulse(ctx)
    const reverbOut = ctx.createGain()
    reverbOut.gain.value = REVERB_LEVEL
    this.reverb.connect(reverbOut)
    reverbOut.connect(this.air)
    this.echo = ctx.createGain()
    const echoOut = ctx.createGain()
    echoOut.gain.value = ECHO_LEVEL
    echoOut.connect(this.air)
    echoOut.connect(this.reverb)
    for (const [seconds, feedback] of ECHO_TAPS) {
      const delay = ctx.createDelay(seconds)
      delay.delayTime.value = seconds
      const dull = ctx.createBiquadFilter()
      dull.type = 'lowpass'
      dull.frequency.value = ECHO_LP
      const back = ctx.createGain()
      back.gain.value = feedback
      this.echo.connect(delay)
      delay.connect(dull)
      dull.connect(back)
      back.connect(delay)
      dull.connect(echoOut)
    }
    this.buffers = new Map()
    this.loops = new Set()
    // The one-shots playing, { src, g, nodes, gain }, and the shots lost: under the floor, or to the cap (dropped at it, or displaced by a louder one).
    this.voices = []
    this.floored = 0
    this.culled = 0
  }

  get oneShots() {
    return this.voices.length
  }

  /** Browsers start a context suspended until a user gesture; call from one. Idempotent. */
  unlock() {
    if (this.ctx.state !== 'running') this.ctx.resume()
  }

  get running() {
    return this.ctx.state === 'running'
  }

  /** Fetch and decode every clip in `manifest` ({ name: url }). Rejects on the first clip that fails, naming it. */
  async load(manifest) {
    const jobs = Object.entries(manifest).map(async ([name, url]) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`SoundEngine: ${name} -- ${url} answered ${res.status}`)
      const bytes = await res.arrayBuffer()
      const buffer = await this.ctx.decodeAudioData(bytes)
      this.buffers.set(name, buffer)
    })
    await Promise.all(jobs)
  }

  has(name) {
    return this.buffers.has(name)
  }

  buffer(name) {
    const b = this.buffers.get(name)
    if (!b) throw new Error(`SoundEngine: no clip named ${name} is loaded`)
    return b
  }

  /** Seconds a clip runs at rate 1. */
  duration(name) {
    return this.buffer(name).duration
  }

  /**
   * Where her ears are and which way they face. World units, called once a
   * frame from the camera's world matrix.
   */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz) {
    const L = this.ctx.listener
    const now = this.ctx.currentTime
    if (L.positionX) {
      // A short smoothing constant, not a snap: the head moves every frame and a
      // stepped position is a zipper on every panned source.
      setParam(L.positionX, px, now, 0.02)
      setParam(L.positionY, py, now, 0.02)
      setParam(L.positionZ, pz, now, 0.02)
      setParam(L.forwardX, fx, now, 0.02)
      setParam(L.forwardY, fy, now, 0.02)
      setParam(L.forwardZ, fz, now, 0.02)
      setParam(L.upX, ux, now, 0.02)
      setParam(L.upY, uy, now, 0.02)
      setParam(L.upZ, uz, now, 0.02)
    } else {
      L.setPosition(px, py, pz)
      L.setOrientation(fx, fy, fz, ux, uy, uz)
    }
  }

  /** Whole-scene mute/unmute; the quest panel's `sound` row. */
  setMuted(muted) {
    setParam(this.master.gain, muted ? 0 : 1, this.ctx.currentTime, 0.05)
  }

  /**
   * Cross the two buses. `wet` 1 is head under: air silent, the underwater loop
   * up. Fast on the way down so nothing airborne survives the surface; a little
   * slower coming up, so the ear gets a beat of the water leaving.
   */
  setSubmerged(wet) {
    const now = this.ctx.currentTime
    setParam(this.air.gain, wet ? 0 : 1, now, wet ? 0.04 : 0.15)
    setParam(this.water.gain, wet ? 1 : 0, now, wet ? 0.08 : 0.1)
  }

  _panner() {
    const p = this.ctx.createPanner()
    p.panningModel = 'equalpower'
    p.distanceModel = 'inverse'
    p.refDistance = 1
    p.rolloffFactor = 0
    return p
  }

  _place(panner, x, y, z, tau) {
    if (panner.positionX) {
      const now = this.ctx.currentTime
      setParam(panner.positionX, x, now, tau)
      setParam(panner.positionY, y, now, tau)
      setParam(panner.positionZ, z, now, tau)
    } else {
      panner.setPosition(x, y, z)
    }
  }

  /**
   * Fire a clip once. `at` is a world position {x, y, z} for a directional
   * sound, or null for one with no bearing (her own footsteps, the cricket bed).
   * `distance` in metres gives the shot the far treatment (dulled, wetted,
   * late; see the top), and `echo` is its send, 0-1 of its gain, into the
   * valley echo. Returns the source, or null when the shot is not started:
   * under the floor, over the cap, or while the context is still suspended --
   * its clock is frozen then, so every shot started would queue on the same
   * instant and the lot would fire together the moment unlock() lands.
   */
  play(name, { rate = 1, gain = 1, at = null, bus = 'air', distance = 0, echo = 0 } = {}) {
    if (!(rate > 0)) throw new Error(`SoundEngine.play(${name}): rate must be positive, got ${rate}`)
    if (!(gain >= 0)) throw new Error(`SoundEngine.play(${name}): gain must be non-negative, got ${gain}`)
    if (!(distance >= 0)) throw new Error(`SoundEngine.play(${name}): distance must be non-negative, got ${distance}`)
    if (!(echo >= 0 && echo <= 1)) throw new Error(`SoundEngine.play(${name}): echo must be 0-1, got ${echo}`)
    if (!this.running) return null
    if (gain < VOICE_FLOOR) {
      this.floored++
      return null
    }
    if (this.voices.length >= MAX_VOICES) {
      let quietest = this.voices[0]
      for (const v of this.voices) if (v.gain < quietest.gain) quietest = v
      if (quietest.gain >= gain) {
        this.culled++
        return null
      }
      this._cull(quietest)
    }
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.buffer(name)
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = gain
    const nodes = [src, g]
    let head = src
    if (distance > 0) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = Math.max(LP_MIN, (LP_MAX * AIR_M) / (AIR_M + distance))
      src.connect(lp)
      head = lp
      nodes.push(lp)
    }
    head.connect(g)
    let tail = g
    if (at) {
      const p = this._panner()
      if (p.positionX) {
        p.positionX.value = at.x
        p.positionY.value = at.y
        p.positionZ.value = at.z
      } else {
        p.setPosition(at.x, at.y, at.z)
      }
      g.connect(p)
      tail = p
      nodes.push(p)
    }
    tail.connect(this[bus])
    // The sends leave before the panner: a wash and a hillside's return have no one bearing.
    if (distance > 0) {
      const send = ctx.createGain()
      send.gain.value = (WET_MAX * distance) / (distance + WET_M)
      g.connect(send)
      send.connect(this.reverb)
      nodes.push(send)
    }
    if (echo > 0) {
      const send = ctx.createGain()
      send.gain.value = echo
      g.connect(send)
      send.connect(this.echo)
      nodes.push(send)
    }
    const voice = { src, g, nodes, gain }
    this.voices.push(voice)
    src.onended = () => this._release(voice)
    src.start(ctx.currentTime + distance / SPEED_OF_SOUND)
    return src
  }

  /** The voice has ended, on its own or culled: off the graph, and out of the budget if it is still counted. */
  _release(voice) {
    const i = this.voices.indexOf(voice)
    if (i >= 0) this.voices.splice(i, 1)
    for (const n of voice.nodes) n.disconnect()
  }

  /** Displace a playing voice: out of the budget now, a short fade to silence, then the stop; onended takes it off the graph. */
  _cull(voice) {
    this.culled++
    this.voices.splice(this.voices.indexOf(voice), 1)
    const now = this.ctx.currentTime
    setParam(voice.g.gain, 0, now, CULL_FADE_S / 3)
    voice.src.stop(now + CULL_FADE_S)
  }

  /** A self-crossfading loop; see LoopVoice. Idle until start(). */
  loop(name, opts = {}) {
    const voice = new LoopVoice(this, name, opts)
    this.loops.add(voice)
    return voice
  }

  /** Once a frame: lets every running loop queue its next cycle. */
  update() {
    for (const v of this.loops) v._tick()
  }
}

/**
 * A clip played end to end forever, each pass crossfaded into the next.
 *
 * Every cycle re-rolls three things: the crossfade into the next cycle
 * (LOOP_XFADE_S), its playback rate, and its gain -- and the last two WALK
 * rather than jump: a step of at most LOOP_STEP from the previous cycle, held
 * inside [0.9, 1.1] for rate and inside `gain` for level, so a brook drifts in
 * pitch over a minute rather than lurching every four seconds. The rate walk is
 * why a cycle's length is not the clip's: it is duration / rate.
 *
 * `level` is the caller's fader on top of all that -- distance, enter/exit --
 * and lives on a separate gain node so the per-cycle envelopes never fight it.
 */
export const LOOP_XFADE_S = [0.1, 1.0]
export const LOOP_RATE = [0.9, 1.1]
export const LOOP_STEP = 0.05

export class LoopVoice {
  constructor(engine, name, { bus = 'air', directional = false, gain = [0.7, 1.0], rand = Math.random } = {}) {
    this.engine = engine
    this.name = name
    this.rand = rand
    this.gainRange = gain
    const ctx = engine.ctx
    this.level = ctx.createGain()
    this.level.gain.value = 0
    this.panner = directional ? engine._panner() : null
    if (this.panner) {
      this.level.connect(this.panner)
      this.panner.connect(engine[bus])
    } else {
      this.level.connect(engine[bus])
    }
    this.rate = LOOP_RATE[0] + rand() * (LOOP_RATE[1] - LOOP_RATE[0])
    this.cycleGain = gain[0] + rand() * (gain[1] - gain[0])
    this.active = false
    // ctx time the next cycle starts, and how long its fade-in is (the previous cycle's fade-out).
    this.nextAt = 0
    this.nextFadeIn = 0
    this.sources = []
  }

  start() {
    if (this.active) return
    this.active = true
    this.nextAt = this.engine.ctx.currentTime + 0.01
    this.nextFadeIn = LOOP_XFADE_S[0]
  }

  /** Fade `level` to zero over `fade` seconds and stop queuing cycles; the sources still queued are cut when the fade lands. */
  stop(fade = 0.5) {
    if (!this.active) return
    this.active = false
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setTargetAtTime(0, now, fade / 3)
    for (const s of this.sources) s.stop(now + fade)
    this.sources.length = 0
  }

  setLevel(v, tau = 0.15) {
    if (!(v >= 0)) throw new Error(`LoopVoice(${this.name}).setLevel: got ${v}`)
    setParam(this.level.gain, v, this.engine.ctx.currentTime, tau)
  }

  setPosition(x, y, z) {
    if (!this.panner) throw new Error(`LoopVoice(${this.name}) is not directional; it has no position`)
    this.engine._place(this.panner, x, y, z, 0.1)
  }

  /** Walk a value by at most LOOP_STEP, held inside [lo, hi]. */
  static walk(v, lo, hi, rand) {
    const next = v + (rand() * 2 - 1) * LOOP_STEP
    return next < lo ? lo : next > hi ? hi : next
  }

  _tick() {
    if (!this.active) return
    const ctx = this.engine.ctx
    // A frame that stalled past the lookahead (a shader compile, entering VR)
    // has left a gap in the loop already; skip to now rather than queue the
    // missed cycles into the past. The browser clamps a past automation time
    // to the present, which would put this cycle's two curves on the same
    // instant and throw.
    if (this.nextAt < ctx.currentTime) {
      this.nextAt = ctx.currentTime + 0.01
      this.nextFadeIn = LOOP_XFADE_S[0]
    }
    while (this.nextAt < ctx.currentTime + LOOP_LOOKAHEAD_S) this._cycle()
  }

  _cycle() {
    const ctx = this.engine.ctx
    const buffer = this.engine.buffer(this.name)
    const start = this.nextAt
    const dur = buffer.duration / this.rate
    const fadeIn = this.nextFadeIn
    // The crossfade OUT of this cycle, capped so two fades never overlap inside one clip.
    let xfade = LOOP_XFADE_S[0] + this.rand() * (LOOP_XFADE_S[1] - LOOP_XFADE_S[0])
    if (xfade > dur / 2 - fadeIn / 2) xfade = Math.max(0.05, dur / 2 - fadeIn / 2)

    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = this.rate
    const env = ctx.createGain()
    // Two curves and nothing between them: a curve occupies its whole span, and
    // any other event landing on its end point is an overlap the browser throws
    // on. The param holds the fade-in's last value (the cycle gain) until the
    // fade-out begins.
    env.gain.value = 0
    env.gain.setValueCurveAtTime(scaled(FADE_IN, this.cycleGain), start, fadeIn)
    env.gain.setValueCurveAtTime(scaled(FADE_OUT, this.cycleGain), start + dur - xfade, xfade)
    src.connect(env)
    env.connect(this.level)
    src.start(start)
    src.stop(start + dur + 0.01)
    this.sources.push(src)
    src.onended = () => {
      src.disconnect()
      env.disconnect()
      const i = this.sources.indexOf(src)
      if (i >= 0) this.sources.splice(i, 1)
    }

    this.nextAt = start + dur - xfade
    this.nextFadeIn = xfade
    this.rate = LoopVoice.walk(this.rate, LOOP_RATE[0], LOOP_RATE[1], this.rand)
    this.cycleGain = LoopVoice.walk(this.cycleGain, this.gainRange[0], this.gainRange[1], this.rand)
  }
}
