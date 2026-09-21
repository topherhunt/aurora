// Node-side gates for the ambient sound (src/v2/audio/).
//
//   node scripts/check-ambience.mjs
//
// Three layers, three fakes. The LOOP VOICE (sound-engine.js) runs against a
// fake AudioContext that records every cycle it schedules, so the crossfade
// range, the 0.9x-1.1x rate band, the 5%-per-cycle walk of rate and gain, and
// the seamless join of one cycle into the next are all asserted on the numbers
// the real context would receive; the same fake carries the FAR treatment's
// graph -- the synthesized reverb impulse, the echo taps, and a far shot's
// filter, sends and late start -- as nodes that record their connections. The
// SENSE (sense.js) runs against a synthetic
// world -- flat ground, a straight river, a lake, a snowy end, a boulder, a
// forest patch, a few frogs -- to see it name each of them and point the right
// way at the shores. The RULES (ambience.js) run against a fake engine and a
// scripted sense, driven for simulated minutes, so every cadence and every gate
// in the spec is a count: raptors only above the snow or by a cliff, an owl only
// at night in dense wood, crickets on their 1.5-3 s beat, footsteps on theirs
// and after a teleport, the brook loop on only by the river, the wind only over
// the snow, high off the ground or under an overcast, the rain loop by precip, a dragon's wingbeats and treads on their
// clips' cycles and its roars and growls on theirs, and nothing at all above the surface
// while she is under it.
//
// What this can NOT check: what any of it sounds like. That needs ears, in the
// world.

import fs from 'node:fs'
import {
  SoundEngine, LoopVoice, LOOP_XFADE_S, LOOP_RATE, LOOP_STEP, VOICE_FLOOR, MAX_VOICES,
  SPEED_OF_SOUND, LP_MAX, LP_MIN, AIR_M, WET_M, WET_MAX, REVERB_S, REVERB_RT60, REVERB_PRE_S, ECHO_TAPS,
} from '../src/v2/audio/sound-engine.js'
import { WorldSense, SENSE_HZ, SHORE_REACH, FROG_REACH } from '../src/v2/audio/sense.js'
import { Ambience, SOUNDS, RULES, RATE, FOOTFALLS } from '../src/v2/audio/ambience.js'
import { SLEET_BAND_M } from '../src/v2/render/precip.js'
import { mulberry32 } from '../src/sim/mathx.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const within = (v, lo, hi) => v >= lo - 1e-9 && v <= hi + 1e-9

// --- the shipped clips -------------------------------------------------------
console.log('clips')
{
  const missing = Object.entries(SOUNDS).filter(([, p]) => !fs.existsSync(new URL(`../public/${p}`, import.meta.url)))
  check(missing.length === 0, `every clip in SOUNDS is under public/`, missing.map(([k]) => k).join(' '))
  check(Object.values(SOUNDS).every((p) => !p.startsWith('/')), 'clip paths are public-relative, no leading slash')
}

// --- a fake AudioContext that records what it is asked to schedule -------------
function fakeParam(name, log) {
  return {
    value: 1,
    setValueAtTime(v, t) { log.push({ name, op: 'set', v, t }) },
    setValueCurveAtTime(curve, t, dur) { log.push({ name, op: 'curve', lo: curve[0], hi: curve[curve.length - 1], t, dur }) },
    setTargetAtTime(v, t, tau) { log.push({ name, op: 'target', v, t, tau }) },
    cancelScheduledValues() {},
  }
}
function fakeCtx() {
  // Every node records what it is connected to, so a graph can be walked.
  const node = (extra) => { const n = { outs: [], connect(to) { n.outs.push(to) }, disconnect() { n.outs.length = 0 }, ...extra }; return n }
  const ctx = {
    currentTime: 0,
    sampleRate: 48000,
    state: 'suspended',
    destination: node({}),
    listener: {},
    sources: [],
    convolvers: [],
    delays: [],
    resume() { ctx.state = 'running' },
    createGain() {
      const log = []
      return node({ log, gain: fakeParam('gain', log) })
    },
    createPanner() {
      return node({ positionX: fakeParam('x', []), positionY: fakeParam('y', []), positionZ: fakeParam('z', []) })
    },
    createBiquadFilter() {
      return node({ type: null, frequency: fakeParam('frequency', []), Q: fakeParam('Q', []) })
    },
    createConvolver() {
      const c = node({ buffer: null, normalize: true })
      ctx.convolvers.push(c)
      return c
    },
    createDelay(max) {
      const d = node({ max, delayTime: fakeParam('delayTime', []) })
      ctx.delays.push(d)
      return d
    },
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (ch) => data[ch] }
    },
    createBufferSource() {
      // `env` is the voice's gain, found through a filter if one sits between.
      const s = node({ buffer: null, playbackRate: { value: 1 }, startAt: null, stopAt: null, onended: null,
        start(t = ctx.currentTime) { s.startAt = t }, stop(t) { s.stopAt = t } })
      Object.defineProperties(s, {
        env: { get() { const first = s.outs[0]; return first?.gain ? first : first?.outs[0] ?? null } },
        lp: { get() { return s.outs[0]?.frequency ? s.outs[0] : null } },
      })
      ctx.sources.push(s)
      return s
    },
  }
  return ctx
}

// --- the loop voice ----------------------------------------------------------
console.log('loop voice')
{
  const ctx = fakeCtx()
  const engine = new SoundEngine({ ctx })
  const DUR = 4.0
  engine.buffers.set('brook', { duration: DUR })
  const rand = mulberry32(11)
  const voice = engine.loop('brook', { directional: true, gain: [0.7, 1.0], rand })
  voice.start()
  const cycles = []
  let prevRate = voice.rate, prevGain = voice.cycleGain
  const before = ctx.sources.length
  // Sixty seconds of frames at 60 Hz.
  for (let i = 0; i < 60 * 60; i++) {
    ctx.currentTime = i / 60
    engine.update()
    while (ctx.sources.length > before + cycles.length) {
      const s = ctx.sources[before + cycles.length]
      const env = s.env.log
      const fadeIn = env.find((e) => e.op === 'curve')
      const fadeOut = env.filter((e) => e.op === 'curve')[1]
      cycles.push({ start: s.startAt, stop: s.stopAt, rate: s.playbackRate.value, fadeIn, fadeOut, gain: fadeIn.hi, prevRate, prevGain, ops: env.map((e) => e.op) })
      prevRate = s.playbackRate.value
      prevGain = fadeIn.hi
    }
  }
  check(cycles.length >= 13 && cycles.length <= 17, 'a 4 s clip cycles about 15 times a minute', `${cycles.length} cycles`)
  check(cycles.every((c) => c.start < c.stop && c.start >= 0), 'every cycle starts before it stops')
  check(cycles.every((c) => within(c.rate, LOOP_RATE[0], LOOP_RATE[1])), `every cycle's rate is within ${LOOP_RATE.join('-')}x`)
  check(cycles.slice(1).every((c) => Math.abs(c.rate - c.prevRate) <= LOOP_STEP + 1e-9), `rate walks at most ${LOOP_STEP} from the previous cycle`, `max step ${Math.max(...cycles.slice(1).map((c) => Math.abs(c.rate - c.prevRate))).toFixed(3)}`)
  check(new Set(cycles.map((c) => c.rate.toFixed(4))).size > cycles.length / 2, 'the rate actually varies cycle to cycle')
  check(cycles.every((c) => within(c.gain, 0.7, 1.0)), 'every cycle gain is within the voice range')
  check(cycles.slice(1).every((c) => Math.abs(c.gain - c.prevGain) <= LOOP_STEP + 1e-9), `gain walks at most ${LOOP_STEP} from the previous cycle`)
  const xfades = cycles.slice(0, -1).map((c) => c.fadeOut.dur)
  check(xfades.every((x) => within(x, LOOP_XFADE_S[0], LOOP_XFADE_S[1])), `every crossfade is ${LOOP_XFADE_S[0]}-${LOOP_XFADE_S[1]} s`, `${Math.min(...xfades).toFixed(2)}-${Math.max(...xfades).toFixed(2)} s`)
  check(Math.max(...xfades) - Math.min(...xfades) > 0.3, 'the crossfade is re-rolled each cycle')
  const joins = cycles.slice(1).map((c, i) => ({ nextIn: c.fadeIn.t, prevOut: cycles[i].fadeOut.t, inDur: c.fadeIn.dur, outDur: cycles[i].fadeOut.dur }))
  check(joins.every((j) => Math.abs(j.nextIn - j.prevOut) < 1e-6 && Math.abs(j.inDur - j.outDur) < 1e-6), 'each cycle fades in exactly while the previous fades out')
  check(cycles.slice(1).every((c, i) => Math.abs(c.start - (cycles[i].start + DUR / cycles[i].rate - cycles[i].fadeOut.dur)) < 1e-6), 'a cycle lasts duration / rate, less the crossfade')
  check(cycles.every((c) => c.fadeIn.lo === 0 && c.fadeOut.hi === 0), 'the envelopes start and end at silence')
  // Chrome throws NotSupportedError on any event that lands inside or on the end of a value curve.
  check(cycles.every((c) => c.ops.length === 2 && c.ops.every((o) => o === 'curve')), 'an envelope is two curves and no other event, so nothing overlaps a curve')
  check(cycles.every((c) => c.fadeOut.t >= c.fadeIn.t + c.fadeIn.dur + 1e-6), 'the fade-out curve starts after the fade-in curve ends')
  check(cycles.every((c) => c.start <= (Math.ceil(c.start * 60) / 60) + 0.4 + 1e-6), 'cycles are queued no more than the lookahead ahead')

  // A stall longer than the lookahead: the browser clamps past automation times
  // to now, so a cycle queued into the past would land both its curves on one
  // instant and throw. The voice must skip ahead instead.
  const stalledFrom = ctx.sources.length
  ctx.currentTime += 3
  engine.update()
  const late = ctx.sources.slice(stalledFrom)
  check(late.length >= 1 && late.every((s) => s.startAt >= ctx.currentTime), 'after a 3 s stall the loop resumes from now, nothing queued into the past', `${late.length} queued, first at +${(late[0]?.startAt - ctx.currentTime).toFixed(3)} s`)
  check(late.every((s) => { const c = s.env.log.filter((e) => e.op === 'curve'); return c[1].t > c[0].t + c[0].dur }), 'the resumed cycle keeps its fade-out after its fade-in')

  voice.stop(0.5)
  const n = ctx.sources.length
  ctx.currentTime += 5
  engine.update()
  check(ctx.sources.length === n && !voice.active, 'a stopped voice queues nothing more')

  // Rate walks clamp at the band edge.
  const r = mulberry32(3)
  let v = 1.0
  let clampedHi = false, clampedLo = false
  for (let i = 0; i < 2000; i++) {
    v = LoopVoice.walk(v, LOOP_RATE[0], LOOP_RATE[1], r)
    if (v === LOOP_RATE[1]) clampedHi = true
    if (v === LOOP_RATE[0]) clampedLo = true
    if (!within(v, LOOP_RATE[0], LOOP_RATE[1])) { clampedHi = clampedLo = false; break }
  }
  check(clampedHi && clampedLo, 'the walk reaches both band edges and never leaves the band')
}

// --- the engine's buses ------------------------------------------------------
console.log('buses')
{
  const ctx = fakeCtx()
  const engine = new SoundEngine({ ctx })
  check(engine.water.gain.value === 0 || engine.water.log.length === 0, 'the water bus starts silent')
  engine.setSubmerged(true)
  const air = engine.air.log.at(-1), water = engine.water.log.at(-1)
  check(air.v === 0 && water.v === 1, 'submerging silences air and opens water')
  engine.setSubmerged(false)
  check(engine.air.log.at(-1).v === 1 && engine.water.log.at(-1).v === 0, 'surfacing swaps them back')
  engine.setMuted(true)
  check(engine.master.log.at(-1).v === 0, 'mute is the master fader')
  check(!engine.running, 'the context starts suspended')
  engine.buffers.set('clip', { duration: 1 })
  check(engine.play('clip') === null && engine.oneShots === 0, 'a one-shot while suspended is dropped, not queued for the unlock')
  engine.unlock()
  check(engine.running, 'unlock resumes it')
  let threw = false
  try { engine.play('nothing') } catch { threw = true }
  check(threw, 'playing an unloaded clip throws')
  const src = engine.play('clip', { rate: 1.05, gain: 0.4, at: { x: 1, y: 2, z: 3 } })
  check(src.playbackRate.value === 1.05 && src.env.gain.value === 0.4, 'play sets rate and gain on the voice')

  // The one-shot budget: a shot under the floor is not started; past the cap a shot displaces the quietest voice if it is louder, and is dropped if not.
  check(engine.oneShots === 1 && engine.play('clip', { gain: VOICE_FLOOR / 2 }) === null && engine.oneShots === 1 && engine.floored === 1, `a shot under the ${VOICE_FLOOR} floor is never started`)
  const quiet = []
  while (engine.oneShots < MAX_VOICES) quiet.push(engine.play('clip', { gain: 0.2 + 0.01 * quiet.length }))
  check(engine.oneShots === MAX_VOICES && quiet.every((s) => s !== null) && engine.culled === 0, `${MAX_VOICES} voices play at once`)
  check(engine.play('clip', { gain: 0.15 }) === null && engine.oneShots === MAX_VOICES && engine.culled === 1, 'at the cap a quieter shot is dropped')
  check(engine.play('clip', { gain: 0.2 }) === null && engine.culled === 2, 'and one no louder than the quietest is dropped too')
  const loud = engine.play('clip', { gain: 0.9 })
  const first = quiet[0]
  check(loud !== null && engine.oneShots === MAX_VOICES && engine.culled === 3 && first.stopAt !== null && first.stopAt > ctx.currentTime && first.env.log.at(-1).v === 0, 'a louder one plays, and the quietest is faded out and stopped for it', `stop at +${(first.stopAt - ctx.currentTime).toFixed(3)} s`)
  first.onended()
  check(engine.oneShots === MAX_VOICES, 'the displaced voice ending does not free a second slot')
  loud.onended()
  check(engine.oneShots === MAX_VOICES - 1, 'a voice ending on its own frees its slot')
}

// --- the far treatment -------------------------------------------------------
console.log('far')
{
  const ctx = fakeCtx()
  const engine = new SoundEngine({ ctx })
  engine.unlock()
  engine.buffers.set('clip', { duration: 1 })
  // The buses: one convolver carrying a synthesized impulse, its return on air; two echo taps, each a delay looped through a low-pass, their return on air and into the reverb.
  check(ctx.convolvers.length === 1 && engine.reverb === ctx.convolvers[0], 'one convolver for the whole scene')
  const ir = engine.reverb.buffer
  check(ir && ir.numberOfChannels === 2 && Math.abs(ir.duration - REVERB_S) < 1e-3, `its impulse is ${REVERB_S} s, stereo`)
  const pre = Math.floor(REVERB_PRE_S * ctx.sampleRate)
  const L = ir.getChannelData(0), R = ir.getChannelData(1)
  const rms = (data, from, to) => { let a = 0; for (let i = from; i < to; i++) a += data[i] * data[i]; return Math.sqrt(a / (to - from)) }
  check(L.slice(0, pre).every((v) => v === 0) && L[pre + 5] !== 0, `silent for the ${REVERB_PRE_S} s pre-delay, then noise`)
  const early = rms(L, pre, pre + 4800), late = rms(L, pre + Math.floor(REVERB_RT60 * ctx.sampleRate) - 4800, pre + Math.floor(REVERB_RT60 * ctx.sampleRate))
  check(early > 0 && late / early < 0.01 && late / early > 0.0001, `it decays by about 60 dB over RT60 ${REVERB_RT60} s`, `${(20 * Math.log10(late / early)).toFixed(0)} dB`)
  check(L.slice(pre, pre + 1000).some((v, i) => v !== R[pre + i]), 'the two channels are different noise')
  check(engine.reverb.outs.length === 1 && engine.reverb.outs[0].outs.includes(engine.air), 'the reverb returns onto air')
  check(ctx.delays.length === ECHO_TAPS.length && ctx.delays.every((d, i) => d.delayTime.value === ECHO_TAPS[i][0] && d.max >= ECHO_TAPS[i][0]), `${ECHO_TAPS.length} echo taps at ${ECHO_TAPS.map((t) => t[0]).join(' and ')} s`)
  check(ctx.delays.every((d) => engine.echo.outs.includes(d)), 'the echo send feeds every tap')
  const loops = ctx.delays.map((d) => { const dull = d.outs[0]; const back = dull.outs.find((n) => n.gain && n.outs.includes(d)); return { dull, back } })
  check(loops.every((l, i) => l.dull.type === 'lowpass' && l.back && l.back.gain.value === ECHO_TAPS[i][1]), 'each tap loops back through a low-pass at its feedback')
  const echoOut = loops[0].dull.outs.find((n) => n.gain && !n.outs.includes(ctx.delays[0]))
  check(echoOut && echoOut.outs.includes(engine.air) && echoOut.outs.includes(engine.reverb), 'the returns go onto air and into the reverb')

  // A shot with no distance is the plain chain; one with a distance is low-passed, sent to the reverb, and started late by the speed of sound.
  const plain = engine.play('clip', { gain: 0.5, at: { x: 1, y: 0, z: 0 } })
  check(plain.lp === null && plain.startAt === ctx.currentTime && plain.env.outs.length === 1, 'without a distance a shot is dry, undelayed and unfiltered')
  const sends = (src) => src.env.outs.filter((n) => n.gain && n !== engine.air)
  const near = engine.play('clip', { gain: 0.5, at: { x: 3, y: 0, z: 0 }, distance: 3 })
  const far = engine.play('clip', { gain: 0.5, at: { x: 250, y: 0, z: 0 }, distance: 250 })
  check(near.lp && far.lp && near.lp.type === 'lowpass' && far.lp.frequency.value < near.lp.frequency.value && near.lp.frequency.value < LP_MAX, 'a far shot is low-passed lower than a near one', `${near.lp.frequency.value.toFixed(0)} Hz at 3 m, ${far.lp.frequency.value.toFixed(0)} Hz at 250 m`)
  check(Math.abs(far.lp.frequency.value - Math.max(LP_MIN, (LP_MAX * AIR_M) / (AIR_M + 250))) < 1e-6, 'the cutoff is LP_MAX * AIR_M / (AIR_M + d), floored')
  check(engine.play('clip', { gain: 0.5, distance: 1e6 }).lp.frequency.value === LP_MIN, `and never below ${LP_MIN} Hz`)
  const nearSend = sends(near)[0], farSend = sends(far)[0]
  check(nearSend && farSend && nearSend.outs.includes(engine.reverb) && farSend.gain.value > nearSend.gain.value && farSend.gain.value <= WET_MAX, 'a far shot sends more of itself to the reverb than a near one', `${nearSend.gain.value.toFixed(2)} at 3 m, ${farSend.gain.value.toFixed(2)} at 250 m`)
  check(Math.abs(farSend.gain.value - (WET_MAX * 250) / (250 + WET_M)) < 1e-6, 'the send is WET_MAX * d / (d + WET_M)')
  check(Math.abs(far.startAt - ctx.currentTime - 250 / SPEED_OF_SOUND) < 1e-9 && far.startAt > near.startAt, `a shot 250 m off starts ${(250 / SPEED_OF_SOUND).toFixed(2)} s late`)
  check(!sends(far).some((n) => n.outs.includes(engine.echo)), 'no echo unless asked')
  const roar = engine.play('clip', { gain: 0.5, distance: 100, echo: 0.8 })
  const echoSend = sends(roar).find((n) => n.outs.includes(engine.echo))
  check(echoSend && echoSend.gain.value === 0.8 && sends(roar).some((n) => n.outs.includes(engine.reverb)), 'asked for, the echo send is the amount given, beside the reverb send')
  check(engine.play('clip', { gain: 0.5, echo: 0.5 }).lp === null, 'an echo alone does not filter')
  const nodes = [roar, roar.lp, roar.env, ...sends(roar)]
  roar.onended()
  check(nodes.every((n) => n.outs.length === 0), 'a far voice ending takes its filter and sends off the graph')
  let threw = 0
  try { engine.play('clip', { distance: -1 }) } catch { threw++ }
  try { engine.play('clip', { echo: 2 }) } catch { threw++ }
  check(threw === 2, 'a negative distance or an echo past 1 throws')
}

// --- the sense, against a synthetic world -------------------------------------
console.log('sense')
const GROUND = 10
const RIVER_X = 0, RIVER_HALF = 3
// A basin `r` wide sunk under a plane whose footprint runs `plane` wide: the shore is where the ground crosses the water, not where the footprint ends.
const LAKE = { x: 100, z: 0, r: 30, plane: 40, y: GROUND - 1, bed: GROUND - 3 }
const inLake = (x, z) => Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r
const COLD_Z = 200
const ROCK = { x: 30, z: 30, r: 1.5, top: 11.2 }
const FOREST = { x0: -60, x1: -20 }
const inRock = (x, z) => Math.hypot(x - ROCK.x, z - ROCK.z) < ROCK.r
const clampReach = (d, reach) => (d > reach ? reach : d < -reach ? -reach : d)
const field = {
  scatterAt(x, z, cell, out) {
    if (!(cell > 0)) throw new Error('cell')
    out.h = inLake(x, z) ? LAKE.bed : GROUND
    // A cliff face along x = 60: the ring probe should see it from 55 m.
    out.tan = Math.abs(x - 60) < 4 ? 3 : 0
    return out
  },
  snowLineAt: (x, z) => (z > COLD_Z ? GROUND - 50 : GROUND + 500),
}
const water = {
  riverShoreDistAt: (x, z, reach) => clampReach(Math.abs(x - RIVER_X) - RIVER_HALF, reach),
  lakeLevelAt: (x, z) => (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.plane ? LAKE.y : null),
}
const rocks = {
  blockTopAt: (x, z) => (inRock(x, z) ? ROCK.top : -Infinity),
  looseCountIn: (x0, z0, x1, z1) => (x0 < ROCK.x && ROCK.x < x1 && z0 < ROCK.z && ROCK.z < z1 ? 40 : 0),
}
const frogs = { batch: { visible: true }, tiles: new Map([[0, { frogs: [{ x: 5, y: GROUND, z: 0 }, { x: 8, y: GROUND, z: 2 }, { x: 40, y: GROUND, z: 0 }] }]]) }
const biome = { coverAt: (x) => (x > FOREST.x0 && x < FOREST.x1 ? 1 : 0) }
{
  const sense = new WorldSense({ field, water, rocks, frogs, biome })
  const s = WorldSense.blank()
  sense.sample(-40, GROUND + 1.6, 0, s)
  check(s.forest > 0.95, 'deep in the wood the forest reads near 1', s.forest.toFixed(3))
  check(s.aboveSnow < 0 && s.cliff === 0 && s.boulders === 0, 'the wood is below the snow, off the cliff, out of the talus')
  sense.sample(-80, GROUND + 1.6, 0, s)
  check(s.forest < 0.05, 'in the meadow the forest reads near 0', s.forest.toFixed(3))
  sense.sample(0, GROUND + 1.6, COLD_Z + 50, s)
  check(s.aboveSnow === 50 && s.forest < 0.05, 'past the cold line she is 50 m above the snow in a thinned meadow', `${s.aboveSnow} forest ${s.forest.toFixed(3)}`)
  sense.sample(-40, GROUND + 1.6, COLD_Z + 50, s)
  check(s.forest > 0.2 && s.forest < 0.5, 'wood 50 m above the snow is thinned below the leaves threshold', s.forest.toFixed(3))
  sense.sample(55, GROUND + 1.6, 0, s)
  check(s.cliff >= 3, 'the cliff face 5 m off is seen on the ring', s.cliff.toFixed(2))
  sense.sample(ROCK.x, ROCK.top + 1.6, ROCK.z, s)
  check(s.onBoulder && s.groundH === ROCK.top, 'standing on the boulder is felt, ground at its top')
  check(s.boulders === 40, 'the loose count comes from the rocks')
  sense.sample(RIVER_X + 8, GROUND + 1.6, 0, s)
  check(Math.abs(s.riverShore - 5) < 1e-6, '8 m from a 3 m half-width river is 5 m from its shore', s.riverShore.toFixed(2))
  check(s.riverDirX < -0.99 && Math.abs(s.riverDirZ) < 1e-6, 'the river bearing points at the river', `${s.riverDirX.toFixed(2)}, ${s.riverDirZ.toFixed(2)}`)
  check(s.frogCount === 2, `two of three frogs are within ${FROG_REACH} m`, `${s.frogCount}`)
  check(s.frogs[0] === 5 && s.frogs[3] === 8, 'the frog positions come through')
  frogs.batch.visible = false
  sense.sample(RIVER_X + 8, GROUND + 1.6, 0, s)
  check(s.frogCount === 0, 'a hidden frog layer croaks from nowhere', `${s.frogCount}`)
  frogs.batch.visible = true
  sense.sample(RIVER_X + 40, GROUND + 1.6, 0, s)
  check(s.riverShore === SHORE_REACH && s.riverDirX === 0, 'far from the river the shore reads the reach, no bearing')
  check(s.lakeShore === SHORE_REACH && s.lakeLevel === -Infinity, 'far from the lake the shore reads the reach, no level')
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z - LAKE.r - 6, s)
  check(Math.abs(s.lakeShore - 6) < 1.5 && s.lakeDirZ > 0.99, '6 m off the lake, bearing at the water', `${s.lakeShore.toFixed(2)} dir ${s.lakeDirX.toFixed(2)},${s.lakeDirZ.toFixed(2)}`)
  check(s.lakeLevel === LAKE.y, 'on the bank over the buried plane she knows the water level at the shore')
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z - LAKE.r - 18, s)
  check(Math.abs(s.lakeShore - 18) < 1.5 && s.lakeDirZ > 0.99, '18 m off the lake the shore is still found', `${s.lakeShore.toFixed(2)} dir ${s.lakeDirZ.toFixed(2)}`)
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z - LAKE.r + 4, s)
  check(Math.abs(s.lakeShore + 4) < 1.5 && s.lakeDirZ > 0.99, 'wading 4 m out, the distance is negative and the bearing still points into the lake', `${s.lakeShore.toFixed(2)} dir ${s.lakeDirZ.toFixed(2)}`)
  check(s.lakeLevel === LAKE.y, 'wading, she knows the level under her')
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z, s)
  check(s.lakeShore === -SHORE_REACH && s.lakeLevel === LAKE.y && s.lakeDirX === 0 && s.lakeDirZ === 0, 'mid-lake, no shore in reach but the level is the water under her')
}

// --- the rules, against a fake engine and a scripted sense --------------------
console.log('rules')
function fakeEngine() {
  const plays = []
  const loops = {}
  return {
    plays, loops, wet: null,
    play(name, opts) { plays.push({ name, ...opts }) },
    loop(name, opts) {
      const v = { name, opts, active: false, level: null, at: null, starts: 0, stops: 0,
        start() { v.active = true; v.starts++ }, stop() { v.active = false; v.stops++ },
        setLevel(l) { v.level = l }, setPosition(x, y, z) { v.at = { x, y, z } } }
      loops[name] = v
      return v
    },
    setSubmerged(w) { this.wet = w },
    duration(name) { return { growl: 3.84 }[name] ?? 1 },
    update() {},
  }
}
function scripted() {
  const s = WorldSense.blank()
  return { s, samples: 0, sample(hx, hy, hz, out) { this.samples++; Object.assign(out, this.s); return out } }
}
const HEAD = { x: 0, y: GROUND + 1.6, z: 0 }
const DAY = 1, NIGHT = 0
/** Drive `amb` for `seconds` at 60 Hz with a fixed frame context. */
function run(amb, seconds, ctx) {
  const frames = Math.round(seconds * 60)
  for (let i = 0; i < frames; i++) amb.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true, ...ctx })
}
const count = (engine, ...names) => engine.plays.filter((p) => names.includes(p.name)).length
const RAPTORS = ['crow', 'eagle', 'hawk']
const SONGBIRDS = ['songbird1', 'songbird2', 'songbird3', 'songbird4', 'songbird5', 'songbird6']

{
  // Sense cadence.
  const engine = fakeEngine(), sense = scripted()
  const amb = new Ambience({ engine, sense, rand: mulberry32(1) })
  run(amb, 10, {})
  check(sense.samples >= 10 * SENSE_HZ - 1 && sense.samples <= 10 * SENSE_HZ + 2, `the world is sensed at ${SENSE_HZ} Hz`, `${sense.samples} in 10 s`)
}
{
  // A quiet meadow by day: songbirds and nothing else.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -300
  const amb = new Ambience({ engine, sense, rand: mulberry32(2) })
  run(amb, 120, {})
  const song = engine.plays.filter((p) => SONGBIRDS.includes(p.name))
  const far = song.filter((p) => p.distance > 0), near = song.filter((p) => !(p.distance > 0))
  const F = RULES.songbirdFar, N = RULES.songbirdNear
  check(far.length >= 30 && far.length <= 120, 'the far songbird bed chatters every 1-4 s in a daytime meadow', `${far.length} in 120 s`)
  check(near.length >= 1 && near.length <= 12, 'a songbird beside her a few times in two minutes', `${near.length} in 120 s`)
  check(count(engine, ...RAPTORS) === 0, 'no raptor below the snow with no cliff')
  check(count(engine, 'owl', 'woodpecker', 'cricket', 'footstep', 'croak1', 'croak2', 'rockslide1', 'rockslide2', 'wave') === 0, 'nothing else fires standing still in a daytime meadow')
  check(!engine.loops.brook.active && !engine.loops.leaves.active && !engine.loops.lakeBed.active && !engine.loops.wind.active && !engine.loops.underwater.active, 'no loop runs in a dry meadow')
  check(song.every((p) => within(p.rate, RATE[0], RATE[1])), `every songbird is pitched ${RATE[0]}-${RATE[1]}x`)
  check(far.every((p) => within(p.gain, ...F.gain)) && near.every((p) => within(p.gain, ...N.gain)), 'the far bed is quiet and the near bird loud, each within its gain range')
  check(F.gain[1] < N.gain[0], 'the loudest far bird is quieter than the softest near one')
  check(far.every((p) => within(p.distance, ...F.range) && Math.abs(Math.hypot(p.at.x - HEAD.x, p.at.y - HEAD.y, p.at.z - HEAD.z) - p.distance) < 1e-6), 'every far bird is placed across the valley and given that as its distance for the far treatment')
  check(near.every((p) => p.distance === undefined && Math.hypot(p.at.x - HEAD.x, p.at.y - HEAD.y, p.at.z - HEAD.z) <= N.range[1] + 1e-6), 'every near bird is within reach and dry')
  check(new Set(far.map((p) => p.gain.toFixed(3))).size > far.length / 2 && new Set(near.map((p) => p.gain.toFixed(2))).size > near.length / 2, 'songbird volume varies widely in both pools')
  check(song.every((p) => p.at && p.at.y > HEAD.y), 'every songbird is placed somewhere above her')
  check(new Set(song.map((p) => p.name)).size >= 4, 'the six songbird clips are all in play', `${new Set(song.map((p) => p.name)).size} distinct`)
}
{
  // Which songbird sings: half the time one heard in the last 15 s, otherwise any of the six.
  const V = RULES.songbirdVoice
  const rolls = []
  const amb = new Ambience({ engine: fakeEngine(), sense: scripted(), rand: () => rolls.shift() })
  rolls.push(0.5)
  const first = amb.songbird()
  check(first === 'songbird4' && rolls.length === 0, 'with nothing heard lately the pick is straight from the six, no bias roll spent', first)
  amb.clock += V.recent - 1
  rolls.push(V.bias - 0.01, 0.99)
  check(amb.songbird() === first && rolls.length === 0, 'under the bias the pick is from the recent voices, here the one heard 14 s ago')
  amb.clock += V.recent
  rolls.push(0.99)
  check(amb.songbird() === 'songbird6' && rolls.length === 0, 'once its last song is older than the window a voice is no longer recent, so no bias roll is spent')
  rolls.push(V.bias + 0.01, 0)
  check(amb.songbird() === 'songbird1' && rolls.length === 0, 'past the bias the pick is from all six, recent or not')
  const meadow = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -300
  const bed = new Ambience({ engine: meadow, sense, rand: mulberry32(2) })
  run(bed, 120, {})
  const names = meadow.plays.filter((p) => SONGBIRDS.includes(p.name)).map((p) => p.name)
  const repeats = names.filter((n, i) => names.slice(Math.max(0, i - 4), i).includes(n)).length
  check(repeats / names.length > 0.6, 'in the bed a song is usually one heard in the last four', `${repeats}/${names.length}`)
}
{
  // The near bird's cadence: an hour in the meadow, its gaps mostly short with a tail of long silences, never a beat.
  const N = RULES.songbirdNear
  const meadow = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -300
  const amb = new Ambience({ engine: meadow, sense, rand: mulberry32(5) })
  let t = 0
  const at = []
  for (let i = 0; i < 3600 * 60; i++) {
    const before = meadow.plays.length
    amb.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
    t += 1 / 60
    for (const p of meadow.plays.slice(before)) if (SONGBIRDS.includes(p.name) && !(p.distance > 0)) at.push(t)
  }
  const gaps = at.slice(1).map((x, i) => x - at[i]).sort((a, b) => a - b)
  const q = (f) => gaps[Math.floor(f * (gaps.length - 1))]
  check(gaps.length >= 60, 'a near bird sings dozens of times an hour', `${gaps.length + 1}`)
  check(gaps.every((g) => g >= N.interval[0] - 0.02 && g <= N.interval[1] + 0.02), `every gap is within ${N.interval[0]}-${N.interval[1]} s`, `${q(0).toFixed(1)}-${q(1).toFixed(1)}`)
  check(q(0.5) < (N.interval[0] + N.interval[1]) / 2 - 10, 'the median gap is well short of the midpoint', `${q(0.5).toFixed(1)} s`)
  check(q(0.1) < 12 && q(0.9) > 60, 'a tenth of the gaps are under 12 s and a tenth are over a minute', `${q(0.1).toFixed(1)} / ${q(0.9).toFixed(1)}`)
}
{
  // Aloft over the meadow and the wood: the perched birds thin across their band and fall silent past its top; the raptors soar on.
  const sense = scripted()
  sense.s.aboveSnow = -300
  sense.s.forest = 0.9
  const S = RULES.songbirdFar, N = RULES.songbirdNear, P = RULES.woodpecker, O = RULES.owl
  if (S.aloft[0] !== N.aloft[0] || S.aloft[1] !== N.aloft[1]) throw new Error('the far and near songbird rules share one aloft band')
  const aloft = (m) => ({ x: 0, y: sense.s.groundH + m, z: 0 })
  const mid = fakeEngine()
  run(new Ambience({ engine: mid, sense, rand: mulberry32(11) }), 120, { head: aloft((S.aloft[0] + S.aloft[1]) / 2) })
  const song = mid.plays.filter((p) => SONGBIRDS.includes(p.name))
  const halved = (p) => within(p.gain, ...(p.distance > 0 ? S : N).gain.map((g) => g / 2))
  check(song.length >= 30 && song.every(halved), 'halfway up the songbird band the birds sing on at half their gain', `${song.length}, ${Math.min(...song.map((p) => p.gain)).toFixed(2)}-${Math.max(...song.map((p) => p.gain)).toFixed(2)}`)
  const high = fakeEngine()
  const amb = new Ambience({ engine: high, sense, rand: mulberry32(12) })
  run(amb, 300, { head: aloft(Math.max(S.aloft[1], P.aloft[1], O.aloft[1]) + 5) })
  run(amb, 300, { head: aloft(Math.max(S.aloft[1], P.aloft[1], O.aloft[1]) + 5), dayness: NIGHT })
  check(count(high, ...SONGBIRDS, 'woodpecker', 'owl') === 0, 'past the top of the band no songbird, woodpecker or owl is heard, day or night')
  sense.s.aboveSnow = 30
  run(amb, 120, { head: aloft(200) })
  check(count(high, ...RAPTORS) >= 2, 'the raptors still call around her high over the snow', `${count(high, ...RAPTORS)}`)
}
{
  // Above the snowline: raptors, no songbirds.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = 30
  const amb = new Ambience({ engine, sense, rand: mulberry32(3) })
  run(amb, 300, {})
  const n = count(engine, ...RAPTORS)
  check(n >= 5 && n <= 22, 'raptors every 15-45 s above the snow', `${n} in 300 s`)
  check(count(engine, ...SONGBIRDS) === 0 && count(engine, 'cricket') === 0, 'no songbird or cricket above the snow')
  const raptors = engine.plays.filter((p) => RAPTORS.includes(p.name))
  check(raptors.every((p) => p.at.y - HEAD.y > Math.sin(RULES.raptor.elev[0] * Math.PI / 180) * RULES.raptor.range[0] - 1e-6), 'every raptor is high above her')
  check(raptors.every((p) => within(p.rate, RATE[0], RATE[1]) && within(p.gain, ...RULES.raptor.gain)), 'raptors are pitched and levelled in range')
  const night = fakeEngine()
  run(new Ambience({ engine: night, sense, rand: mulberry32(3) }), 300, { dayness: NIGHT })
  check(count(night, ...RAPTORS) === 0, 'no crow, eagle or hawk at night, even above the snow', `${count(night, ...RAPTORS)}`)
  const dusk = fakeEngine()
  run(new Ambience({ engine: dusk, sense, rand: mulberry32(3) }), 300, { dayness: 0.3 })
  check(count(dusk, ...RAPTORS) === 0, 'nor at dusk below the daylight threshold')
  // The first one does not fire the moment the rule turns on.
  const first = engine.plays.find((p) => RAPTORS.includes(p.name))
  check(first !== undefined && engine.plays.indexOf(first) >= 0 && amb.timers.raptor.armed, 'the raptor timer arms on entry')
}
{
  // High on a hillside under the snow, with a cliff: raptors too.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -60
  sense.s.cliff = 2.5
  run(new Ambience({ engine, sense, rand: mulberry32(4) }), 300, {})
  check(count(engine, ...RAPTORS) >= 5, 'raptors by a cliff just under the snow', `${count(engine, ...RAPTORS)}`)
  sense.s.aboveSnow = -300
  const far = fakeEngine()
  run(new Ambience({ engine: far, sense, rand: mulberry32(4) }), 300, {})
  check(count(far, ...RAPTORS) === 0, 'no raptor by a low cliff far below the snow')
}
{
  // Night in dense forest: owl, crickets, leaves; no songbirds.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.forest = 0.9
  const amb = new Ambience({ engine, sense, rand: mulberry32(5) })
  run(amb, 180, { dayness: NIGHT })
  const owls = count(engine, 'owl')
  check(owls >= 4 && owls <= 16, 'an owl every 12-35 s at night in dense wood', `${owls} in 180 s`)
  check(count(engine, ...SONGBIRDS) === 0, 'no songbirds at night')
  const crickets = engine.plays.filter((p) => p.name === 'cricket')
  const bed = crickets.filter((p) => !p.at), near = crickets.filter((p) => p.at)
  check(bed.length >= 180 / 3 - 2 && bed.length <= 180 / 1.5 + 2, 'the cricket bed chirps every 1.5-3 s', `${bed.length} in 180 s`)
  check(bed.every((p) => within(p.gain, ...RULES.cricketBed.gain)), 'the bed is low and varies', `${Math.min(...bed.map((p) => p.gain)).toFixed(2)}-${Math.max(...bed.map((p) => p.gain)).toFixed(2)}`)
  check(near.length === 0, 'no cricket is placed beside her without a grasshopper to place it at', `${near.length}`)
  check(engine.loops.leaves.active && engine.loops.leaves.level > 0.5, 'the leaves rustle in the wood', `level ${engine.loops.leaves.level?.toFixed(2)}`)
  const pecks = engine.plays.filter((p) => p.name === 'woodpecker')
  check(pecks.length >= 2 && pecks.length <= 9, 'a woodpecker every 20-70 s in the wood, night or day', `${pecks.length} in 180 s`)
  check(pecks.every((p) => within(p.rate, RATE[0], RATE[1]) && within(p.gain, ...RULES.woodpecker.gain) && p.at && p.at.y > HEAD.y), 'each burst is pitched, levelled, and placed up in a tree')
  // The woodpecker has no snow gate: thinned wood just under the treeline top still has one, if the wood is dense enough.
  const high = fakeEngine()
  sense.s.aboveSnow = 30
  run(new Ambience({ engine: high, sense, rand: mulberry32(5) }), 300, {})
  check(count(high, 'woodpecker') >= 3 && count(high, 'owl') === 0 && count(high, ...SONGBIRDS) === 0, 'above the snow the woodpecker drums on where the owl and songbirds do not', `${count(high, 'woodpecker')} pecks`)
  sense.s.aboveSnow = -200
  // Sparse wood: no owl, no leaves.
  const sparse = fakeEngine()
  sense.s.forest = 0.3
  run(new Ambience({ engine: sparse, sense, rand: mulberry32(5) }), 180, { dayness: NIGHT })
  check(count(sparse, 'owl') === 0 && count(sparse, 'woodpecker') === 0, 'no owl or woodpecker in sparse wood')
  check(!sparse.loops.leaves.active, 'no leaves loop in sparse wood')
  check(count(sparse, 'cricket') > 50, 'crickets still chirp in the sparse night')
}
{
  // The leaves loop has hysteresis at the wood's edge.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(6) })
  sense.s.forest = 0.6
  run(amb, 1, {})
  check(engine.loops.leaves.active, 'leaves on past 0.5')
  sense.s.forest = 0.45
  run(amb, 1, {})
  check(engine.loops.leaves.active, 'leaves stay on at 0.45')
  sense.s.forest = 0.35
  run(amb, 1, {})
  check(!engine.loops.leaves.active && engine.loops.leaves.stops === 1, 'leaves off below 0.4, stopped once')
}
{
  // The leaves are the canopy: heard from the ground, gone 20 m above it.
  const A = RULES.leaves.aloft
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.forest = 0.9
  sense.s.groundH = GROUND
  const amb = new Ambience({ engine, sense, rand: mulberry32(6) })
  run(amb, 1, {})
  const full = engine.loops.leaves.level
  check(engine.loops.leaves.active && full > 0.5, 'on the ground in the wood the leaves rustle')
  run(amb, 1, { head: { x: 0, y: GROUND + (A[0] + A[1]) / 2, z: 0 } })
  check(engine.loops.leaves.active && engine.loops.leaves.level < full * 0.6, 'half way up the aloft band they are faded', engine.loops.leaves.level.toFixed(2))
  run(amb, 1, { head: { x: 0, y: GROUND + A[1] + 1, z: 0 } })
  check(!engine.loops.leaves.active, `no leaves ${A[1]} m above the wood's ground`)
  run(amb, 1, {})
  check(engine.loops.leaves.active, 'back on the ground they return')
}
{
  // The wind: quiet, undirected, up over the snow or aloft, rising through each band.
  const W = RULES.wind
  const engine = fakeEngine(), sense = scripted()
  sense.s.groundH = GROUND
  sense.s.aboveSnow = W.snow[0] - 50
  const amb = new Ambience({ engine, sense, rand: mulberry32(11) })
  const wind = engine.loops.wind
  check(wind.opts.directional !== true && wind.opts.gain === W.gain, 'the wind loop has no bearing and walks inside its own gain range')
  run(amb, 1, {})
  check(!wind.active, 'no wind well below the snow on the ground')
  sense.s.aboveSnow = 0
  run(amb, 1, {})
  const half = wind.level
  check(wind.active && half > 0 && half < W.level, 'the wind is up at the snowline, at part strength', `level ${half?.toFixed(3)}`)
  sense.s.aboveSnow = W.snow[1] + 20
  run(amb, 1, {})
  check(wind.active && Math.abs(wind.level - W.level) < 1e-9, 'full strength past the top of the snow band', `level ${wind.level?.toFixed(3)}`)
  sense.s.aboveSnow = W.snow[0] - 50
  run(amb, 1, {})
  check(!wind.active && wind.stops === 1, 'down off the snow the wind stops once')
  // Aloft: her head high above the ground with no snow anywhere near.
  const up = { x: 0, y: GROUND + W.height[1] + 10, z: 0 }
  run(amb, 1, { head: up })
  check(wind.active && Math.abs(wind.level - W.level) < 1e-9, 'full wind flying high above snowless ground', `level ${wind.level?.toFixed(3)}`)
  run(amb, 1, { head: { x: 0, y: GROUND + (W.height[0] + W.height[1]) / 2, z: 0 } })
  check(wind.active && wind.level > 0 && wind.level < W.level, 'part strength midway up the height band', `level ${wind.level?.toFixed(3)}`)
  run(amb, 1, {})
  check(!wind.active && wind.stops === 2, 'back on the ground it stops again')
  // Standing on a boulder, height is measured from its top, not the field.
  sense.s.groundH = GROUND + W.height[1]
  run(amb, 1, { head: { x: 0, y: GROUND + W.height[1] + 1.6, z: 0 } })
  check(!wind.active, 'on top of a tall boulder the ground is the boulder')
  // The weather (§10): a closing sky raises the wind on the ground, and rain is its own loop.
  sense.s.groundH = GROUND
  run(amb, 1, { cover: 1 })
  check(wind.active && Math.abs(wind.level - W.level * W.cover) < 1e-9, 'full overcast is wind on the ground, at its cover share', `level ${wind.level?.toFixed(3)}`)
  sense.s.aboveSnow = W.snow[1] + 20
  run(amb, 1, { cover: 1 })
  check(Math.abs(wind.level - W.level) < 1e-9, 'and over the snow the cover adds nothing past full')
  sense.s.aboveSnow = W.snow[0] - 50
  run(amb, 1, { cover: 0 })
  check(!wind.active, 'a clear sky on the ground is no wind')
  const R = RULES.rain
  const rain = engine.loops.rain
  check(rain.opts.directional !== true && rain.opts.gain === R.gain && !rain.active, 'the rain loop has no bearing and is silent in dry weather')
  run(amb, 1, { precip: 1 })
  check(rain.active && Math.abs(rain.level - R.level) < 1e-9, 'a downpour below the snow is rain at full level', `level ${rain.level?.toFixed(3)}`)
  run(amb, 1, { precip: 0.5 })
  check(rain.active && Math.abs(rain.level - R.level * 0.5) < 1e-9, 'half the precip is half the level')
  check(R.sleet[0] === -SLEET_BAND_M && R.sleet[1] === SLEET_BAND_M, 'the sleet band is the precip draw\'s, so the sound of rain thins as the drops turn to flakes', `${R.sleet}`)
  sense.s.aboveSnow = 0
  run(amb, 1, { precip: 1 })
  check(rain.active && Math.abs(rain.level - R.level * 0.5) < 1e-9, 'on the snow line half the fall is rain, and so is half the sound', `level ${rain.level?.toFixed(3)}`)
  sense.s.aboveSnow = R.sleet[1] + 20
  run(amb, 1, { precip: 1 })
  check(!rain.active && rain.stops === 1, 'over the sleet band the same fall is snow, and snow makes no sound')
  sense.s.aboveSnow = R.sleet[0] - 50
  run(amb, 1, { precip: 1 })
  run(amb, 1, { precip: R.off / 2 })
  check(!rain.active && rain.stops === 2, 'and it stops once the precip is under the off threshold')
  // Aloft: the patter is on the ground, so it thins as she climbs off it and is gone at the top of the band.
  const rainAt = (m) => ({ x: 0, y: GROUND + m, z: 0 })
  run(amb, 1, { precip: 1, head: rainAt(R.aloft[0] - 0.5) })
  check(rain.active && Math.abs(rain.level - R.level) < 1e-9, 'a downpour is at full level with her head at standing height', `level ${rain.level?.toFixed(3)}`)
  run(amb, 1, { precip: 1, head: rainAt((R.aloft[0] + R.aloft[1]) / 2) })
  check(rain.active && Math.abs(rain.level - R.level * 0.5) < 1e-9, 'half way up the aloft band it is half the level', `level ${rain.level?.toFixed(3)}`)
  run(amb, 1, { precip: 1, head: rainAt(R.aloft[1] + 1) })
  check(!rain.active && rain.stops === 3 && R.aloft[1] === 20, 'and above 20 m in the same downpour the loop is off', `${R.aloft}`)
  run(amb, 1, { precip: 1, head: rainAt(R.aloft[0] - 0.5) })
  check(rain.active && Math.abs(rain.level - R.level) < 1e-9, 'and it is back at full level once she lands')
}
{
  // Footsteps: only while walking, and after a teleport.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(7) })
  run(amb, 30, { speed: 1.4 })
  const steps = count(engine, 'footstep')
  check(steps >= 30 / 0.6 - 2 && steps <= 30 / 0.4 + 2, 'a footstep every 0.4-0.6 s while walking', `${steps} in 30 s`)
  const step = engine.plays.filter((p) => p.name === 'footstep')
  check(step.every((p) => within(p.rate, RATE[0], RATE[1]) && within(p.gain, ...RULES.footstep.gain) && !p.at), 'footsteps are pitched, levelled, and not placed')
  const still = fakeEngine()
  run(new Ambience({ engine: still, sense, rand: mulberry32(7) }), 30, { speed: 0 })
  check(count(still, 'footstep') === 0, 'no footsteps standing still')
  const flying = fakeEngine()
  run(new Ambience({ engine: flying, sense, rand: mulberry32(7) }), 30, { speed: 3, afoot: false })
  check(count(flying, 'footstep') === 0, 'no footsteps flying')
  const tp = fakeEngine()
  const amb2 = new Ambience({ engine: tp, sense, rand: mulberry32(8) })
  amb2.onTeleport(6, 6)
  check(Math.abs(amb2.teleportCredit - 2) < 1e-9, 'a full-range teleport is worth 2 s of walking')
  run(amb2, 5, { speed: 0 })
  const tpSteps = count(tp, 'footstep')
  check(tpSteps >= 3 && tpSteps <= 5, 'a teleport lands 3-5 footsteps and then stops', `${tpSteps}`)
  amb2.onTeleport(0.6, 6)
  check(Math.abs(amb2.teleportCredit - 1.1) < 1e-9, 'a short teleport is worth just over 1 s')
  let threw = false
  try { amb2.onTeleport(1, 0) } catch { threw = true }
  check(threw, 'a teleport with no range throws')
}
{
  // The footfall tables are the clip files' own phases: one beat per distinct landing, in order.
  for (const [lib, gaits] of Object.entries(FOOTFALLS)) {
    for (const [gait, beats] of Object.entries(gaits)) {
      const spec = JSON.parse(fs.readFileSync(new URL(`../tools/creatures/anim/clips/${lib}/${gait}.json`, import.meta.url), 'utf8'))
      const phases = [...new Set(Object.values(spec.phases))].sort((a, b) => a - b)
      check(beats.join(',') === phases.join(','), `${lib} ${gait} footfalls are the clip's distinct phases in order`, `${beats.join(' ')} vs ${phases.join(' ')}`)
    }
  }
}
{
  // The animals' feet: a herd's walking bodies each land a step per beat of their gait, at their size and distance.
  const F = RULES.footfall
  const hare = { x: 1, y: GROUND, z: 0, size: 0.5, clip: 'walk', cycle: 1.1, speed: 1 }
  const stag = { x: 0, y: GROUND, z: 10, size: 2, clip: 'trot', cycle: 0.51, speed: 1 }
  const far = { x: 0, y: GROUND, z: F.reach + 5, size: 2, clip: 'run', cycle: 0.38, speed: 1 }
  const herd = { alive: [], bodies(into) { into.push(...this.alive); return into } }
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(15), herds: [{ layer: herd, clips: 'quadruped' }] })
  run(amb, 30, {})
  check(count(engine, 'footfall') === 0, 'an empty herd is silent')
  herd.alive.push(hare, stag, far)
  const head = { x: 0, y: GROUND, z: 0 }
  run(amb, 30, { head })
  const steps = engine.plays.filter((p) => p.name === 'footfall')
  const hareSteps = steps.filter((p) => p.at.x === 1), stagSteps = steps.filter((p) => p.at.z === 10), farSteps = steps.filter((p) => p.at.z === far.z)
  check(Math.abs(hareSteps.length - (30 / 1.1) * 4) <= 4, 'a walking hare lands four footfalls a cycle', `${hareSteps.length} in 30 s of a 1.1 s walk`)
  check(Math.abs(stagSteps.length - (30 / 0.51) * 2) <= 4, 'a trotting stag lands two: its diagonal pairs together', `${stagSteps.length} in 30 s of a 0.51 s trot`)
  check(farSteps.length === 0 && amb.bodies.size === 2, `a body past ${F.reach} m is neither heard nor clocked`)
  check(hareSteps.every((p) => within(p.rate, RATE[0], RATE[1])), 'a hare at arm\'s length steps at rate 1, give or take the pitch band')
  check(hareSteps.every((p) => within(p.gain, F.level * F.gain[0], F.level * F.gain[1])) && hareSteps.some((p) => p.gain > F.level * 0.95), `and at ${F.level} of full volume`, `${Math.min(...hareSteps.map((p) => p.gain)).toFixed(3)} to ${Math.max(...hareSteps.map((p) => p.gain)).toFixed(3)}`)
  const stagRate = Math.pow(F.size / 2, F.deep)
  check(stagSteps.every((p) => within(p.rate, stagRate * RATE[0], stagRate * RATE[1])) && stagRate < 0.6, 'a stag steps slower and deeper', `rate ${stagRate.toFixed(2)}x`)
  const stagLevel = Math.min(F.max, F.level * (2 / F.size)) * (F.near / 10)
  check(stagSteps.every((p) => within(p.gain, stagLevel * F.gain[0], stagLevel * F.gain[1])) && Math.abs(stagLevel - 0.1) < 1e-9, 'a stag at 10 m is full volume for its size, over ten for its distance', `${stagLevel.toFixed(3)}`)
  check(steps.every((p) => p.at && p.at.y === GROUND), 'every footfall comes from where the body is')
  // The beat is jittered, not a metronome: the gaps between a hare's steps vary, and stay within the jitter of the beat's own spacing.
  const gaps = []
  {
    // Re-run alone at 60 Hz, timing each footfall by frame, so the gaps are readable.
    const e2 = fakeEngine()
    const a2 = new Ambience({ engine: e2, sense, rand: mulberry32(16), herds: [{ layer: { bodies: (into) => { into.push(hare); return into } }, clips: 'quadruped' }] })
    const frames = 60 * 30
    let last = null
    const steps = () => e2.plays.filter((p) => p.name === 'footfall').length
    for (let i = 0; i < frames; i++) {
      const before = steps()
      a2.update(1 / 60, { head, dayness: DAY, submerged: false, speed: 0, afoot: true })
      if (steps() > before) { if (last !== null) gaps.push((i - last) / 60); last = i }
    }
  }
  const beat = 1.1 / 4
  check(new Set(gaps.map((g) => g.toFixed(3))).size >= 4, 'the gaps between a hare\'s footfalls vary', `${new Set(gaps.map((g) => g.toFixed(3))).size} distinct gaps`)
  check(gaps.every((g) => g >= beat - 2 * F.jitter * 1.1 - 1 / 60 - 1e-9 && g <= beat + 2 * F.jitter * 1.1 + 1 / 60 + 1e-9), `and every gap is the beat within ${F.jitter} of a cycle either side`, `${Math.min(...gaps).toFixed(3)} to ${Math.max(...gaps).toFixed(3)} s about ${beat.toFixed(3)}`)
  // A body that stops is dropped from the clock; one that changes gait starts a fresh cycle.
  hare.speed = 0
  run(amb, 1, { head })
  check(amb.bodies.size === 1 && !amb.bodies.has(hare), 'a body that stops walking, and has no call, is forgotten')
  const before = engine.plays.length
  stag.clip = 'run'
  stag.cycle = 0.38
  run(amb, 1 / 60, { head })
  check(amb.bodies.get(stag).clip === 'run' && amb.bodies.get(stag).phase < 0.1, 'a change of gait restarts the cycle on that gait')
  run(amb, 10, { head })
  check(Math.abs(engine.plays.length - before - (10 / 0.38) * 4) <= 8, 'and a gallop lands four beats a cycle', `${engine.plays.length - before} in 10 s of a 0.38 s run`)
  // A hidden or frozen layer lists nothing, so nothing is heard; a gait with no footfalls is a bug, not silence.
  let threw = 0
  try { new Ambience({ engine, sense, herds: [{ layer: {}, clips: 'quadruped' }] }) } catch { threw++ }
  try { new Ambience({ engine, sense, herds: [{ layer: herd, clips: 'insect' }] }) } catch { threw++ }
  stag.clip = 'idle'
  try { run(amb, 1 / 60, { head }) } catch { threw++ }
  check(threw === 3, 'a herd without bodies(), an unknown clip library, or a body walking a clip with no footfalls throws')
}
{
  // The fox's yip: every so often from each fox within reach, standing or walking, at its distance.
  const Y = RULES.foxYip
  const near = { x: 3, y: GROUND + 1.6, z: 0, size: 0.7, clip: 'idle', cycle: 0, speed: 0, sp: { key: 'fox' } }
  const far = { x: 0, y: GROUND + 1.6, z: 20, size: 0.7, clip: 'walk', cycle: 1.1, speed: 1, sp: { key: 'fox' } }
  const gone = { x: 0, y: GROUND + 1.6, z: Y.reach + 5, size: 0.7, clip: 'idle', cycle: 0, speed: 0, sp: { key: 'fox' } }
  const hare = { x: 2, y: GROUND + 1.6, z: 2, size: 0.5, clip: 'idle', cycle: 0, speed: 0, sp: { key: 'hare' } }
  // And the stag's grunt, the same machinery on its own rule: one 3 m off, one past its reach.
  const D = RULES.deerGrunt
  const stag = { x: -3, y: GROUND + 1.6, z: 0, size: 1.6, clip: 'idle', cycle: 0, speed: 0, sp: { key: 'stag' } }
  const farStag = { x: 0, y: GROUND + 1.6, z: -(D.reach + 5), size: 1.6, clip: 'idle', cycle: 0, speed: 0, sp: { key: 'stag' } }
  const herd = { bodies(into) { into.push(near, far, gone, hare, stag, farStag); return into } }
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(21), herds: [{ layer: herd, clips: 'quadruped', calls: { fox: 'foxYip', stag: 'deerGrunt' } }] })
  run(amb, 600, {})
  const grunts = engine.plays.filter((p) => p.name === 'deerGrunt')
  const meanD = (D.every[0] + D.every[1]) / 2
  check(grunts.length >= 600 / meanD / 2 && grunts.length <= (600 / meanD) * 2 && grunts.every((p) => p.at.x === -3), `a stag standing ${-stag.x} m off grunts every ${D.every[0]}-${D.every[1]} s, and one past ${D.reach} m never`, `${grunts.length} in 600 s`)
  check(grunts.every((p) => within(p.gain, D.level * D.gain[0], D.level * D.gain[1]) && within(p.rate, RATE[0], RATE[1])), `within ${D.near} m a grunt is at its ${D.level} level, pitched within the band`, `${Math.min(...grunts.map((p) => p.gain)).toFixed(2)}-${Math.max(...grunts.map((p) => p.gain)).toFixed(2)}`)
  const yips = engine.plays.filter((p) => p.name === 'foxYip')
  const nearY = yips.filter((p) => p.at.x === 3), farY = yips.filter((p) => p.at.z === 20)
  const mean = (Y.every[0] + Y.every[1]) / 2
  check(nearY.length >= 600 / mean / 2 && nearY.length <= (600 / mean) * 2, `a fox standing ${near.x} m off yips every ${Y.every[0]}-${Y.every[1]} s`, `${nearY.length} in 600 s`)
  check(farY.length >= 600 / mean / 2 && farY.length <= (600 / mean) * 2 && yips.length === nearY.length + farY.length, 'so does a walking one at 20 m, and one past the reach never', `${farY.length}`)
  check(nearY.every((p) => within(p.gain, Y.level * Y.gain[0], Y.level * Y.gain[1])), `within ${Y.near} m a yip is at its level`, `${Math.min(...nearY.map((p) => p.gain)).toFixed(2)}-${Math.max(...nearY.map((p) => p.gain)).toFixed(2)}`)
  check(farY.every((p) => within(p.gain, (Y.level * Y.gain[0] * Y.near) / 20, (Y.level * Y.gain[1] * Y.near) / 20)), 'at 20 m it is a fifth as loud', `${Math.max(...farY.map((p) => p.gain)).toFixed(3)}`)
  check(yips.every((p) => within(p.rate, RATE[0], RATE[1])), 'pitched within the band')
  check(amb.bodies.has(near) && !amb.bodies.has(gone) && !amb.bodies.has(hare) && count(engine, 'footfall') === engine.plays.filter((p) => p.name === 'footfall' && p.at.z === 20).length, 'a standing fox is kept for its call and lands no footfalls; a hare has no call and is not kept standing')
  let threw = false
  try { new Ambience({ engine, sense, herds: [{ layer: herd, clips: 'quadruped', calls: { fox: 'bark' } }] }) } catch { threw = true }
  check(threw, 'a call with no rule throws')
}
{
  // The crawlers' feet: one quiet loop while any crab within reach is moving, sat at the nearest. A spider is a startler: silent on its feet, heard once when it takes fright.
  const C = RULES.crawl
  const spider = { x: 2, y: GROUND + 1.6, z: 0, size: 0.2, speed: 0.05 }
  const crab = { x: 0, y: GROUND + 1.6, z: 1, size: 0.4, speed: 0 }
  const nearCrab = { x: 2, y: GROUND + 1.6, z: 0, size: 0.4, speed: 0.3 }
  const farCrab = { x: 0, y: GROUND + 1.6, z: C.reach + 1, size: 0.4, speed: 0.5 }
  const spiders = { bodies(into) { into.push(spider); return into }, startled(into) { return into } }
  const crabs = { bodies(into) { into.push(crab, nearCrab, farCrab); return into } }
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(23), crawlers: [crabs], startlers: [spiders] })
  const loop = engine.loops.crawl
  run(amb, 1, {})
  check(loop.opts.directional && loop.active && loop.starts === 1 && Math.abs(loop.level - C.level * (C.near / 2)) < 1e-9 && loop.at.x === 2, `a crab scuttling 2 m off holds the crawl loop at half its ${C.level} level, from the crab`, `${loop.level.toFixed(3)}`)
  crab.speed = 0.3
  run(amb, 1, {})
  check(loop.active && loop.starts === 1 && Math.abs(loop.level - C.level * Math.min(1, C.near / 2 + C.near / 1)) < 1e-9 && loop.at.z === 1, 'a crab scuttling 1 m off adds to it, capped at the level, and takes the loop over as the nearer', `${loop.level.toFixed(3)}`)
  nearCrab.speed = 0
  crab.speed = 0
  run(amb, 1, {})
  check(!loop.active && loop.stops === 1, `both paused, the loop stops; a crab past ${C.reach} m never held it, and the crawling spider 2 m off never did`)
  crab.speed = 0.3
  run(amb, 1, {})
  check(loop.active && loop.starts === 2, 'and starts again when one moves')
  run(amb, 1, { submerged: true })
  check(loop.active && loop.starts === 2, 'it is held through a dive like the other loops, the bus silencing it')
  // A spider that takes fright plays the clip once, from where it is, at `startle` times the level; a layer without startled() (the crabs) is only ever the loop.
  spiders.startled = (into) => { into.push(spider); return into }
  const before = engine.plays.length
  run(amb, 1 / 60, {})
  const shot = engine.plays.slice(before).filter((p) => p.name === 'crawl')
  check(shot.length === 1 && shot[0].at === spider && shot[0].gain >= C.startle * C.level * C.gain[0] - 1e-9 && shot[0].gain <= C.startle * C.level * C.gain[1] + 1e-9, `a startled spider plays the crawl once, from itself, at ${C.startle}x the level`, `${shot.length} shots, gain ${shot[0]?.gain.toFixed(3)}`)
  check(C.startle === 1, 'the startle is no louder than the loop')
  spiders.startled = (into) => into
  run(amb, 1, {})
  check(engine.plays.filter((p) => p.name === 'crawl').length === 1, 'and no more once it is no longer listed')
  let threw = false
  try { new Ambience({ engine, sense, crawlers: [{}] }) } catch { threw = true }
  check(threw, 'a crawler layer without bodies() throws')
  threw = false
  try { new Ambience({ engine, sense, startlers: [{}] }) } catch { threw = true }
  check(threw, 'a startler layer without startled() throws')
}
{
  // A voiced layer: each one-shot it says is fired once, from where it was said, at the voice rule's level for its distance and not at all past its reach.
  const V = RULES.voice
  const said = []
  const leafkin = { voices(into) { into.push(...said); said.length = 0; return into } }
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(31), voiced: [leafkin] })
  run(amb, 1, {})
  check(count(engine, 'leafkinScream', 'leafkinSqueal', 'leafkinWhimper', 'leafkinChatter1', 'panting') === 0, 'a silent layer fires nothing')
  said.push({ sound: 'leafkinScream', x: HEAD.x + 4, y: HEAD.y, z: HEAD.z }, { sound: 'leafkinChatter2', x: HEAD.x, y: HEAD.y, z: HEAD.z + V.reach + 1 })
  run(amb, 1, {})
  const screams = engine.plays.filter((p) => p.name === 'leafkinScream')
  check(screams.length === 1 && screams[0].at.x === HEAD.x + 4, 'a scream said 4 m off is fired once, from there', `${screams.length}`)
  const fallAt = (d) => (V.near / Math.max(V.near, d)) * Math.min(1, (V.reach - d) / V.edge)
  const fall = fallAt(4)
  check(screams.every((p) => within(p.gain, V.level * fall * V.gain[0], V.level * fall * V.gain[1])), 'at the voice level over its distance')
  check(count(engine, 'leafkinChatter2') === 0 && said.length === 0, `chatter past ${V.reach} m is not heard, and the layer is drained either way`)
  said.push({ sound: 'panting', x: HEAD.x, y: HEAD.y, z: HEAD.z + 5 }, { sound: 'leafkinChatter3', x: HEAD.x, y: HEAD.y, z: HEAD.z + V.reach - 0.5 })
  run(amb, 1, {})
  const pants = engine.plays.filter((p) => p.name === 'panting')
  check(pants.length === 1 && pants[0].at.z === HEAD.z + 5 && within(pants[0].gain, V.level * fallAt(5) * V.gain[0], V.level * fallAt(5) * V.gain[1]), 'a pant said 5 m off is a one-shot at the voice level over its distance, from there', `${pants.length}`)
  const edge = engine.plays.filter((p) => p.name === 'leafkinChatter3')
  check(edge.length === 1 && edge[0].gain < V.level * fallAt(5) * 0.25, `chatter half a metre inside the ${V.reach} m reach has faded almost to nothing`, edge.map((p) => p.gain.toFixed(3)).join(','))
  let threw = 0
  try { new Ambience({ engine, sense, voiced: [{ bodies() {} }] }) } catch { threw++ }
  said.push({ sound: 'leafkinChanting', x: HEAD.x, y: HEAD.y, z: HEAD.z })
  try { run(amb, 1, {}) } catch { threw++ }
  check(threw === 2, 'a voiced layer without voices(), and a sound the table does not list, throw')
}
{
  // The fish: a swoosh on the water bus from each that sets off fast within reach, as loud and as deep as it is long, and only on the frame it is listed.
  const S = RULES.swoosh
  const pike = { x: HEAD.x + 1, y: HEAD.y, z: HEAD.z, size: 2 }
  const fry = { x: HEAD.x, y: HEAD.y, z: HEAD.z + 4, size: 0.1 }
  const far = { x: HEAD.x + S.reach + 1, y: HEAD.y, z: HEAD.z, size: 2 }
  const listed = []
  const fish = { startled(into) { into.push(...listed); return into } }
  const engine = fakeEngine(), sense = scripted()
  const amb = new Ambience({ engine, sense, rand: mulberry32(24), fish })
  run(amb, 1, { submerged: true })
  check(count(engine, 'swoosh') === 0, 'no fish setting off, no swoosh')
  listed.push(pike, fry, far)
  run(amb, 1 / 60, { submerged: true })
  listed.length = 0
  const shots = engine.plays.filter((p) => p.name === 'swoosh')
  check(shots.length === 2 && shots.every((p) => p.bus === 'water'), `a fish setting off within ${S.reach} m swooshes once, on the water bus, and one past the reach not at all`, `${shots.length} shots`)
  const big = shots.find((p) => p.at.x === pike.x), small = shots.find((p) => p.at.z === fry.z)
  const deep = (size) => Math.pow(S.size / size, S.deep)
  check(big && within(big.gain, S.max * S.gain[0], S.max * S.gain[1]) && within(big.rate, RATE[0] * deep(pike.size), RATE[1] * deep(pike.size)), 'a 2 m pike setting off at arm\'s length is the full level, slow and deep', `gain ${big?.gain.toFixed(3)} rate ${big?.rate.toFixed(3)}`)
  const fryLevel = S.level * (fry.size / S.size) * (S.near / 4)
  check(small && within(small.gain, fryLevel * S.gain[0], fryLevel * S.gain[1]) && within(small.rate, RATE[0] * deep(fry.size), RATE[1] * deep(fry.size)), 'a 10 cm glimmerfin 4 m off is a faint high flick', `gain ${small?.gain.toFixed(4)} rate ${small?.rate.toFixed(3)}`)
  run(amb, 1, { submerged: true })
  check(count(engine, 'swoosh') === 2, 'and no more once they are no longer listed')
  let threw = false
  try { new Ambience({ engine, sense, fish: {} }) } catch { threw = true }
  check(threw, 'a fish layer without startled() throws')
}
{
  // The grasshoppers: each shown one within reach chirps the cricket clip from where it sits, on average once per `every` seconds, by day; none past the reach.
  const C = RULES.chirp
  const near = { x: HEAD.x + 1, y: GROUND, z: HEAD.z }
  const mid = { x: HEAD.x, y: GROUND, z: HEAD.z + 4 }
  const far = { x: HEAD.x + C.reach + 1, y: GROUND, z: HEAD.z }
  const listed = [near, mid, far]
  const grasshoppers = { bodies(into) { into.push(...listed); return into } }
  const engine = fakeEngine(), sense = scripted()
  const amb = new Ambience({ engine, sense, rand: mulberry32(25), grasshoppers })
  const SECONDS = 600
  run(amb, SECONDS, { dayness: DAY })
  const chirps = engine.plays.filter((p) => p.name === 'cricket')
  check(chirps.length > 0 && chirps.every((p) => p.at && listed.some((b) => p.at.x === b.x && p.at.y === b.y && p.at.z === b.z)), 'by day every cricket is a grasshopper\'s, from where it sits', `${chirps.length} chirps`)
  const from = (b) => chirps.filter((p) => p.at.x === b.x && p.at.z === b.z)
  const expect = SECONDS / C.every
  check(within(from(near).length, expect * 0.5, expect * 1.6) && within(from(mid).length, expect * 0.5, expect * 1.6), `each one within ${C.reach} m chirps about once per ${C.every} s`, `${from(near).length} and ${from(mid).length} in ${SECONDS} s, ${expect} expected`)
  check(from(far).length === 0, 'one past the reach never does')
  // The distance is from her head, 1.6 m over the ground it sits on.
  const level = (b) => C.level * (C.near / Math.max(C.near, Math.hypot(b.x - HEAD.x, b.y - HEAD.y, b.z - HEAD.z)))
  check(from(near).every((p) => within(p.gain, level(near) * C.gain[0], level(near) * C.gain[1]) && within(p.rate, RATE[0], RATE[1])), 'at her feet it is the level over its distance from her head, in the pitch band')
  check(from(mid).every((p) => within(p.gain, level(mid) * C.gain[0], level(mid) * C.gain[1])) && level(mid) < level(near), '4 m off it falls as 1 / distance')
  // At night, below the snow: the bed goes on unplaced, and the only placed crickets are still the grasshoppers.
  sense.s.aboveSnow = -200
  const dayChirps = chirps.length
  run(amb, SECONDS, { dayness: NIGHT })
  const night = engine.plays.filter((p) => p.name === 'cricket').slice(dayChirps)
  const bed = night.filter((p) => !p.at), placed = night.filter((p) => p.at)
  check(bed.length >= SECONDS / 3 - 2 && bed.length <= SECONDS / 1.5 + 2, 'the far bed chirps every 1.5-3 s at night', `${bed.length} in ${SECONDS} s`)
  check(placed.length > 0 && placed.every((p) => listed.some((b) => p.at.x === b.x && p.at.y === b.y && p.at.z === b.z)), 'every placed night cricket is a grasshopper', `${placed.length} placed`)
  const nightFrom = (b) => placed.filter((p) => p.at.x === b.x && p.at.z === b.z).length
  check(within(nightFrom(near), expect * 0.5, expect * 1.6) && nightFrom(far) === 0, 'at the same rate as by day, and none past the reach', `${nightFrom(near)} near, ${nightFrom(far)} far`)
  listed.length = 0
  const before = count(engine, 'cricket')
  run(amb, 60, { dayness: DAY })
  check(count(engine, 'cricket') === before, 'and none once nothing is listed')
  let threw = false
  try { new Ambience({ engine, sense, grasshoppers: {} }) } catch { threw = true }
  check(threw, 'a grasshopper layer without bodies() throws')
}
{
  // The dragons: wingbeats on the fly clip's cycle near, roars across the valley with the far treatment and the echo, growls with pauses from a nest, treads on the walk clip's beats from one pottering.
  const W = RULES.wingbeat, R = RULES.roar, G = RULES.growl
  const FLY = 0.9
  // The flights at her ears' height, so a body's distance is its x.
  const nearFly = { x: 10, y: HEAD.y, z: 0, state: 'patrol', clip: 'fly', cycle: FLY, speed: 12 }
  const midFly = { x: 100, y: HEAD.y, z: 0, state: 'hunt', clip: 'fly', cycle: FLY, speed: 16 }
  const farFly = { x: 200, y: HEAD.y, z: 0, state: 'patrol', clip: 'fly', cycle: FLY, speed: 12 }
  const goneFly = { x: R.reach + 20, y: HEAD.y, z: 0, state: 'patrol', clip: 'fly', cycle: FLY, speed: 12 }
  const nest = { x: 0, y: GROUND + 1.6, z: 5, state: 'roost', clip: 'idle', cycle: 4, speed: 0 }
  const farNest = { x: 0, y: GROUND + 1.6, z: G.reach + 5, state: 'roost', clip: 'alert', cycle: 2, speed: 0 }
  // One potters on a perch 20 m off at the shipped walk's cycle, one past the tread's reach, and one's speed is still dying under the idle its walk ended on.
  const T = RULES.tread, WALK = 1.24
  const walker = { x: 20, y: HEAD.y, z: 0, state: 'perch', clip: 'walk', cycle: WALK, speed: 1.2 }
  const farWalker = { x: T.reach + 10, y: HEAD.y, z: 0, state: 'roost', clip: 'walk', cycle: WALK, speed: 1.2 }
  const slowing = { x: 0, y: HEAD.y, z: -8, state: 'perch', clip: 'idle', cycle: 4, speed: 0.3 }
  const dragons = { bodies(into) { into.push(nearFly, midFly, farFly, goneFly, nest, farNest, walker, farWalker, slowing); return into } }
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  const amb = new Ambience({ engine, sense, rand: mulberry32(27), dragons })
  run(amb, 600, {})
  const treads = engine.plays.filter((p) => p.name === 'tread')
  check(treads.length > 0 && treads.every((p) => p.at.x === 20), `only the dragon walking within ${T.reach} m is heard treading; one slowing to a stand on its idle lands none`, `${treads.length} treads`)
  check(Math.abs(treads.length - (600 / WALK) * FOOTFALLS.wyvern.walk.length) <= 3, `a tread per foot, two a cycle of the ${WALK} s walk clip`, `${treads.length} in 600 s`)
  check(treads.every((p) => within(p.gain, T.level * (T.near / 20) * T.gain[0], T.level * (T.near / 20) * T.gain[1]) && p.distance === 20 && within(p.rate, RATE[0], RATE[1])), 'a tread plays at its level for 20 m, at its distance, in the one-shot rate band')
  check(!amb.wings.has(slowing) && !amb.wings.has(farWalker), 'a dragon slowing on its idle, or walking past the reach, is not kept')
  const beats = engine.plays.filter((p) => p.name === 'wingbeat')
  check(beats.length > 0 && beats.every((p) => p.at.x === 10), `only the dragon flying within ${W.reach} m beats its wings`, `${beats.length} beats`)
  check(Math.abs(beats.length - 600 / FLY) <= 3, `one beat a cycle of the ${FLY} s fly clip`, `${beats.length} in 600 s`)
  check(beats.every((p) => within(p.gain, W.level * (W.near / 10) * W.gain[0], W.level * (W.near / 10) * W.gain[1]) && p.distance === 10 && within(p.rate, W.rate[0], W.rate[1])), `at its level for 10 m, at its distance, slowed to ${W.rate[0]}-${W.rate[1]}x`)
  const roars = engine.plays.filter((p) => p.name === 'roar')
  const roarsAt = (x) => roars.filter((p) => p.at.x === x)
  const mean = (R.every[0] + R.every[1]) / 2
  check(roarsAt(10).length + roarsAt(100).length + roarsAt(200).length === roars.length && roarsAt(R.reach + 20).length === 0, `only dragons flying within ${R.reach} m roar`, `${roars.length} roars`)
  check([10, 100, 200].every((x) => roarsAt(x).length >= 600 / mean / 2 && roarsAt(x).length <= (600 / mean) * 2), `each roars every ${R.every[0]}-${R.every[1]} s`, `${[10, 100, 200].map((x) => roarsAt(x).length).join(' ')}`)
  const level = (d) => R.level * Math.pow(R.near / Math.max(R.near, d), R.roll) * Math.min(1, (R.reach - d) / R.edge)
  check([10, 100, 200].every((x) => roarsAt(x).every((p) => within(p.gain, level(x) * R.gain[0], level(x) * R.gain[1]))), 'a roar falls off as (near/distance)^roll, fading over the last metres of the reach', `${[10, 100, 200].map((x) => level(x).toFixed(2)).join(' ')}`)
  check(roars.every((p) => p.distance === p.at.x && p.echo === R.echo), 'every roar carries its distance for the far treatment and its echo send')
  check(engine.plays.filter((p) => p.name === 'growl' && p.at.z === G.reach + 5).length === 0 && !amb.wings.has(farNest) && !amb.wings.has(goneFly), `a nest past ${G.reach} m and a flight past ${R.reach} m are neither heard nor kept`)
  check(engine.plays.filter((p) => p.name === 'growl').every((p) => p.at.z === 5 && p.distance === Math.hypot(5, 0) && within(p.rate, G.rate[0], G.rate[1]) && within(p.gain, G.level * (G.near / 5) * G.gain[0], G.level * (G.near / 5) * G.gain[1])), 'a dragon on its nest 5 m off growls at its level, at its distance, at a rate rolled in the growl band')
  walker.speed = 0
  const stood = engine.plays.length
  run(amb, 10, {})
  check(engine.plays.slice(stood).every((p) => p.name !== 'tread') && !amb.wings.has(walker), 'stood still, a dragon lands no tread and is let go')
  walker.speed = 1.2

  // The growls' spacing, timed by frame: each starts after the previous has ended plus a pause, and the first waits a pause too.
  const e2 = fakeEngine()
  const a2 = new Ambience({ engine: e2, sense, rand: mulberry32(28), dragons: { bodies(into) { into.push(nest); return into } } })
  const at = []
  for (let i = 0; i < 60 * 120; i++) {
    const n = e2.plays.length
    a2.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
    for (const p of e2.plays.slice(n)) if (p.name === 'growl') at.push({ t: i / 60, rate: p.rate })
  }
  const gaps = at.slice(1).map((g, i) => g.t - at[i].t - e2.duration('growl') / at[i].rate)
  check(at.length >= 10 && at[0].t >= G.pause[0] - 1 / 60 && at[0].t <= G.pause[1] + 1 / 60, `the first growl waits a ${G.pause[0]}-${G.pause[1]} s pause`, `${at[0]?.t.toFixed(2)} s`)
  check(gaps.every((g) => g >= G.pause[0] - 1 / 30 && g <= G.pause[1] + 1 / 30), 'each next growl starts after the last has ended, plus a pause in the band', `${Math.min(...gaps).toFixed(2)}-${Math.max(...gaps).toFixed(2)} s`)
  check(new Set(gaps.map((g) => g.toFixed(2))).size >= 5 && new Set(at.map((a) => a.rate.toFixed(3))).size >= 5, 'the pauses and the rates vary growl to growl')
  // She walks in on a resting dragon, and it takes off: the growls stop; landing again, the pause is rolled fresh.
  nest.state = 'patrol'; nest.clip = 'fly'; nest.cycle = FLY
  const n = e2.plays.length
  for (let i = 0; i < 60; i++) a2.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
  check(e2.plays.slice(n).every((p) => p.name !== 'growl') && e2.plays.slice(n).some((p) => p.name === 'wingbeat'), 'taken off, a dragon stops growling and starts beating')
  nest.state = 'roost'; nest.clip = 'idle'
  // The fish in her hand: the frame it comes after her it roars, and every R.menace seconds after; put away, the roaring stops with the growls back.
  for (let i = 0; i < 60; i++) a2.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
  nest.state = 'menace'; nest.clip = 'walk'; nest.cycle = WALK; nest.speed = 1.1
  const setOut = e2.plays.length
  const roared = []
  for (let i = 0; i < 60 * 60; i++) {
    const n = e2.plays.length
    a2.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
    for (const p of e2.plays.slice(n)) if (p.name === 'roar') roared.push(i / 60)
  }
  const spacing = roared.slice(1).map((t, i) => t - roared[i])
  check(roared.length > 0 && roared[0] === 0, 'after the fish in her hand, a dragon roars the frame it sets out', `first at ${roared[0]?.toFixed(2)} s`)
  check(spacing.length >= 3 && spacing.every((g) => g >= R.menace[0] - 1 / 30 && g <= R.menace[1] + 1 / 30) && new Set(spacing.map((g) => g.toFixed(2))).size >= 3, `and every ${R.menace[0]}-${R.menace[1]} s after, on the ground`, `${roared.length} roars in 60 s, ${Math.min(...spacing).toFixed(2)}-${Math.max(...spacing).toFixed(2)} s apart`)
  check(e2.plays.slice(setOut).every((p) => p.name !== 'growl') && e2.plays.slice(setOut).some((p) => p.name === 'tread') && a2.wings.get(nest).menacing, 'off the nest after her it growls no more, and its steps are heard')
  nest.state = 'roost'; nest.clip = 'idle'; nest.cycle = 4; nest.speed = 0
  const back = e2.plays.length
  for (let i = 0; i < 60 * 40; i++) a2.update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true })
  check(e2.plays.slice(back).every((p) => p.name !== 'roar') && e2.plays.slice(back).some((p) => p.name === 'growl'), 'the fish put away and the dragon home, it roars no more and growls again')
  let threw = 0
  try { new Ambience({ engine, sense, dragons: {} }) } catch { threw++ }
  try { new Ambience({ engine, sense, dragons: { bodies(into) { into.push({ ...nearFly, cycle: 0 }); return into } } }).update(1 / 60, { head: HEAD, dayness: DAY, submerged: false, speed: 0, afoot: true }) } catch { threw++ }
  check(threw === 2, 'a dragon layer without bodies(), or a flight with no cycle, throws')
}
{
  // Frogs croak within reach, fading with distance, from where they sit.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.frogCount = 2
  sense.s.frogs.set([2, GROUND, 0, 0, GROUND, 8])
  run(new Ambience({ engine, sense, rand: mulberry32(9) }), 120, {})
  const croaks = engine.plays.filter((p) => p.name === 'croak1' || p.name === 'croak2')
  check(RULES.frog.every === 16 && croaks.length >= 7 && croaks.length <= 25, 'two frogs croak about every 16 s each', `${croaks.length} in 120 s`)
  const nearC = croaks.filter((p) => p.at.x === 2), farC = croaks.filter((p) => p.at.z === 8)
  check(nearC.length > 0 && farC.length > 0 && nearC.every((p) => p.at.z === 0), 'each croak comes from its frog')
  const d2 = Math.hypot(2, 1.6), d8 = Math.hypot(8, 1.6)
  check(nearC.every((p) => within(p.gain, RULES.frog.gain[0] * (1 - d2 / FROG_REACH), RULES.frog.gain[1] * (1 - d2 / FROG_REACH))), 'the near frog is faded for its distance')
  check(farC.every((p) => within(p.gain, RULES.frog.gain[0] * (1 - d8 / FROG_REACH), RULES.frog.gain[1] * (1 - d8 / FROG_REACH))), 'the far frog is faded more')
  check(new Set(croaks.map((p) => p.name)).size === 2, 'both croak clips are used')
}
{
  // Rockslides: in the talus, and underfoot on a boulder.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.boulders = 40
  run(new Ambience({ engine, sense, rand: mulberry32(10) }), 600, {})
  const slides = count(engine, 'rockslide1', 'rockslide2')
  check(slides >= 8 && slides <= 32, 'a rockslide every 20-60 s in a boulder field', `${slides} in 600 s`)
  const R = RULES.rockslideNear
  // The gain a slide was rolled at, its distance fall-off undone.
  const rolled = (head) => (p) => p.gain / (R.near / Math.max(R.near, Math.hypot(p.at.x - head.x, p.at.y - head.y, p.at.z - head.z)))
  const talus = engine.plays.filter((p) => p.name.startsWith('rockslide'))
  check(talus.every((p) => within(rolled(HEAD)(p), ...R.gain) && p.at && Math.hypot(p.at.x, p.at.z) >= R.range[0] - 1e-6), 'a talus slide is quiet and off in the distance')
  check(talus.every((p) => Math.abs(p.distance - Math.hypot(p.at.x - HEAD.x, p.at.y - HEAD.y, p.at.z - HEAD.z)) < 1e-6), 'and given its metres as the far treatment')
  check(talus.some((p) => p.gain < R.gain[0]) && talus.some((p) => p.gain > R.gain[0]), 'and quieter the further off it is', `${Math.min(...talus.map((p) => p.gain)).toFixed(2)}-${Math.max(...talus.map((p) => p.gain)).toFixed(2)}`)
  // Flying 40 m over the field: the same slides at no more than a quarter of their rolled gain.
  const up = { x: 0, y: sense.s.groundH + 40, z: 0 }
  const aloft = fakeEngine()
  run(new Ambience({ engine: aloft, sense, rand: mulberry32(10) }), 600, { head: up })
  const high = aloft.plays.filter((p) => p.name.startsWith('rockslide'))
  check(high.length >= 8 && high.every((p) => within(rolled(up)(p), ...R.gain) && p.gain <= R.gain[1] * R.near / (40 - R.rise[1])), 'high over the field the slides are heard from far below', `${high.length}, loudest ${Math.max(...high.map((p) => p.gain)).toFixed(3)}`)
  const few = fakeEngine()
  sense.s.boulders = 3
  run(new Ambience({ engine: few, sense, rand: mulberry32(10) }), 600, {})
  check(count(few, 'rockslide1', 'rockslide2') === 0, 'three loose rocks are not a talus')
  const foot = fakeEngine()
  sense.s.boulders = 0
  sense.s.onBoulder = true
  run(new Ambience({ engine: foot, sense, rand: mulberry32(10) }), 120, { speed: 1.4 })
  const underfoot = count(foot, 'rockslide1', 'rockslide2')
  check(underfoot >= 6 && underfoot <= 36, 'stones scatter now and then walking across a boulder', `${underfoot} in 120 s`)
  const stillFoot = fakeEngine()
  run(new Ambience({ engine: stillFoot, sense, rand: mulberry32(10) }), 120, { speed: 0 })
  check(count(stillFoot, 'rockslide1', 'rockslide2') === 0, 'standing still on a boulder scatters nothing')
}
{
  // Lake shore: a wave every 2-5 s from the shore's bearing while one is within `reach`, fading to nothing at the reach and given its metres as the far treatment; the lapping bed loops and fades with it.
  const W = RULES.wave
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.lakeShore = 2
  sense.s.lakeDirX = 1
  sense.s.lakeLevel = GROUND
  const amb = new Ambience({ engine, sense, rand: mulberry32(12) })
  run(amb, 60, {})
  const waves = engine.plays.filter((p) => p.name === 'wave')
  check(waves.length >= 60 / W.interval[1] - 2 && waves.length <= 60 / W.interval[0] + 2, `a wave every ${W.interval[0]}-${W.interval[1]} s at the water`, `${waves.length} in 60 s`)
  check(waves.every((p) => within(p.gain, ...W.gain) && p.at.x > HEAD.x && p.distance === 2), 'waves at full volume from the water side, 2 m off')
  check(engine.loops.lakeBed.active && engine.loops.lakeBed.at.x > HEAD.x, 'the lapping bed loops from the water side')
  const bedLevel = engine.loops.lakeBed.level
  sense.s.lakeShore = 12
  run(amb, 60, {})
  const midWaves = engine.plays.filter((p) => p.name === 'wave').slice(waves.length)
  check(midWaves.length > 10 && midWaves.every((p) => p.gain <= W.gain[1] * 0.5 && p.distance === 12), 'at 12 m the waves are faded well down and given their metres', `max ${Math.max(...midWaves.map((p) => p.gain)).toFixed(2)}`)
  check(engine.loops.lakeBed.level < bedLevel * 0.6, 'the bed fades with distance too')
  sense.s.lakeShore = 18
  run(amb, 60, {})
  const farWaves = engine.plays.filter((p) => p.name === 'wave').slice(waves.length + midWaves.length)
  check(farWaves.length > 10 && farWaves.every((p) => p.gain > 0 && p.gain < W.gain[1] * 0.1 && p.distance === 18), 'at 18 m the waves still come, quiet and far', `max ${Math.max(...farWaves.map((p) => p.gain)).toFixed(3)}`)
  check(engine.loops.lakeBed.active && engine.loops.lakeBed.level < bedLevel * 0.1, 'the bed is nearly gone at 18 m', engine.loops.lakeBed.level.toFixed(3))
  sense.s.lakeShore = W.reach
  run(amb, 2, {})
  const heard = waves.length + midWaves.length + farWaves.length
  check(!engine.loops.lakeBed.active && engine.plays.filter((p) => p.name === 'wave').length === heard, `at ${W.reach} m the lake goes quiet`)
  // Wading: the sound comes from behind, toward the shore.
  const wade = fakeEngine()
  sense.s.lakeShore = -3
  run(new Ambience({ engine: wade, sense, rand: mulberry32(12) }), 20, {})
  const wading = wade.plays.filter((p) => p.name === 'wave')
  check(wading.length > 2 && wading.every((p) => p.at.x < HEAD.x && p.distance === 3), 'wading out, the lapping comes from the shore behind her')
  // Out over open water with no shore in reach there is nothing to lap on: silence.
  const open = fakeEngine()
  sense.s.lakeShore = -SHORE_REACH
  sense.s.lakeDirX = 0
  const aloft = new Ambience({ engine: open, sense, rand: mulberry32(12) })
  run(aloft, 30, {})
  check(count(open, 'wave') === 0 && !open.loops.lakeBed.active, 'mid-lake, with no shore in reach, the water is silent')
  // The height cap: a shore in reach is faded as she rises above the water and gone past `height`.
  sense.s.lakeShore = 4
  sense.s.lakeDirX = 1
  run(aloft, 30, {})
  const bank = count(open, 'wave')
  const bedFull = open.loops.lakeBed.level
  check(bank >= 30 / W.interval[1] - 2 && open.loops.lakeBed.active, 'on the bank the lake is heard', `${bank} in 30 s`)
  run(aloft, 30, { head: { x: 0, y: GROUND + (W.near + W.height) / 2, z: 0 } })
  const risen = open.plays.filter((p) => p.name === 'wave').slice(bank)
  check(risen.length > 3 && risen.every((p) => p.gain < W.gain[1] * 0.7) && open.loops.lakeBed.level < bedFull * 0.7, 'half way up to the height cap the lake is faded', `max ${Math.max(...risen.map((p) => p.gain)).toFixed(2)} bed ${open.loops.lakeBed.level.toFixed(2)}`)
  run(aloft, 5, { head: { x: 0, y: GROUND + W.height + 1, z: 0 } })
  check(!open.loops.lakeBed.active && count(open, 'wave') === bank + risen.length, `${W.height} m above the shore the lake goes quiet`)
  run(aloft, 5, {})
  check(open.loops.lakeBed.active, 'and back on the bank it returns')
}
{
  // The brook loops within 10 m of a river, from its bearing, fading with distance.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.riverShore = 1
  sense.s.riverDirZ = -1
  const amb = new Ambience({ engine, sense, rand: mulberry32(13) })
  run(amb, 2, {})
  const brook = engine.loops.brook
  check(brook.active && brook.starts === 1 && brook.at.z < HEAD.z, 'the brook loops from the river side')
  check(Math.abs(brook.level - RULES.brook.level) < 1e-9, 'at the bank the brook is at full level')
  sense.s.riverShore = 8
  run(amb, 2, {})
  check(brook.active && brook.level < RULES.brook.level * 0.6, 'at 8 m the brook is faded', brook.level.toFixed(2))
  sense.s.riverShore = SHORE_REACH
  run(amb, 2, {})
  check(!brook.active && brook.stops === 1, 'past 10 m the brook stops')
  check(brook.opts.directional === true && engine.loops.leaves.opts.directional !== true, 'the brook is directional, the leaves are not')
  check(engine.loops.underwater.opts.bus === 'water', 'the underwater loop sits on the water bus')
}
{
  // Underwater: only the underwater loop, and nothing from above.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.forest = 0.9
  sense.s.frogCount = 1
  sense.s.frogs.set([1, GROUND, 0])
  sense.s.lakeShore = -2
  sense.s.boulders = 40
  const amb = new Ambience({ engine, sense, rand: mulberry32(14) })
  run(amb, 60, { dayness: NIGHT, speed: 1.4, submerged: true })
  check(engine.wet === true && engine.loops.underwater.active && engine.loops.underwater.level === RULES.underwater.level, 'submerged: the buses swap and the underwater loop runs')
  check(engine.plays.length === 0, 'nothing above the surface fires while she is under', `${engine.plays.length} plays`)
  run(amb, 30, { dayness: NIGHT, speed: 1.4, submerged: false })
  check(engine.wet === false && !engine.loops.underwater.active, 'surfacing: buses back, underwater loop stopped')
  check(engine.plays.length > 40, 'the world comes back the moment she surfaces', `${engine.plays.length} plays in 30 s`)
  check(engine.loops.underwater.starts === 1 && engine.loops.underwater.stops === 1, 'the underwater loop started and stopped once')
}
{
  // Bad input throws.
  const engine = fakeEngine(), sense = scripted()
  let threw = 0
  try { new Ambience({ sense }) } catch { threw++ }
  try { new Ambience({ engine }) } catch { threw++ }
  try { new Ambience({ engine, sense }).update(-1, { head: HEAD, dayness: 1, submerged: false, speed: 0, afoot: true }) } catch { threw++ }
  check(threw === 3, 'a missing engine or sense, or a negative dt, throws')
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
