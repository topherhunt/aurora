// Node-side gates for the ambient sound (src/v2/audio/).
//
//   node scripts/check-ambience.mjs
//
// Three layers, three fakes. The LOOP VOICE (sound-engine.js) runs against a
// fake AudioContext that records every cycle it schedules, so the crossfade
// range, the 0.9x-1.1x rate band, the 5%-per-cycle walk of rate and gain, and
// the seamless join of one cycle into the next are all asserted on the numbers
// the real context would receive. The SENSE (sense.js) runs against a synthetic
// world -- flat ground, a straight river, a lake, a snowy end, a boulder, a
// forest patch, a few frogs -- to see it name each of them and point the right
// way at the shores. The RULES (ambience.js) run against a fake engine and a
// scripted sense, driven for simulated minutes, so every cadence and every gate
// in the spec is a count: raptors only above the snow or by a cliff, an owl only
// at night in dense wood, crickets on their 1.5-3 s beat, footsteps on theirs
// and after a teleport, the brook loop on only by the river, the wind only over
// the snow or high off the ground, and nothing at all above the surface while
// she is under it.
//
// What this can NOT check: what any of it sounds like. That needs ears, in the
// world.

import fs from 'node:fs'
import { SoundEngine, LoopVoice, LOOP_XFADE_S, LOOP_RATE, LOOP_STEP } from '../src/v2/audio/sound-engine.js'
import { WorldSense, SENSE_HZ, SHORE_REACH, FROG_REACH } from '../src/v2/audio/sense.js'
import { Ambience, SOUNDS, RULES, RATE } from '../src/v2/audio/ambience.js'
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
  const ctx = {
    currentTime: 0,
    state: 'suspended',
    destination: { connect() {}, disconnect() {} },
    listener: {},
    sources: [],
    resume() { ctx.state = 'running' },
    createGain() {
      const log = []
      return { log, gain: fakeParam('gain', log), connect() {}, disconnect() {} }
    },
    createPanner() {
      return { positionX: fakeParam('x', []), positionY: fakeParam('y', []), positionZ: fakeParam('z', []), connect() {}, disconnect() {} }
    },
    createBufferSource() {
      const s = { buffer: null, playbackRate: { value: 1 }, startAt: null, stopAt: null, onended: null, env: null,
        connect(node) { if (node.gain) s.env = node }, disconnect() {},
        start(t = ctx.currentTime) { s.startAt = t }, stop(t) { s.stopAt = t } }
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
  engine.unlock()
  check(engine.running, 'unlock resumes it')
  let threw = false
  try { engine.play('nothing') } catch { threw = true }
  check(threw, 'playing an unloaded clip throws')
  engine.buffers.set('clip', { duration: 1 })
  const src = engine.play('clip', { rate: 1.05, gain: 0.4, at: { x: 1, y: 2, z: 3 } })
  check(src.playbackRate.value === 1.05 && src.env.gain.value === 0.4, 'play sets rate and gain on the voice')
}

// --- the sense, against a synthetic world -------------------------------------
console.log('sense')
const GROUND = 10
const RIVER_X = 0, RIVER_HALF = 3
const LAKE = { x: 100, z: 0, r: 20 }
const COLD_Z = 200
const ROCK = { x: 30, z: 30, r: 1.5, top: 11.2 }
const FOREST = { x0: -60, x1: -20 }
const inRock = (x, z) => Math.hypot(x - ROCK.x, z - ROCK.z) < ROCK.r
const clampReach = (d, reach) => (d > reach ? reach : d < -reach ? -reach : d)
const field = {
  scatterAt(x, z, cell, out) {
    if (!(cell > 0)) throw new Error('cell')
    out.h = GROUND
    // A cliff face along x = 60: the ring probe should see it from 55 m.
    out.tan = Math.abs(x - 60) < 4 ? 3 : 0
    return out
  },
  snowLineAt: (x, z) => (z > COLD_Z ? GROUND - 50 : GROUND + 500),
}
const water = {
  riverShoreDistAt: (x, z, reach) => clampReach(Math.abs(x - RIVER_X) - RIVER_HALF, reach),
  lakeShoreDistAt: (x, z, reach) => clampReach(Math.hypot(x - LAKE.x, z - LAKE.z) - LAKE.r, reach),
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
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z - LAKE.r - 6, s)
  check(Math.abs(s.lakeShore - 6) < 1e-6 && s.lakeDirZ > 0.99, '6 m off the lake, bearing at the water', `${s.lakeShore.toFixed(2)} dir ${s.lakeDirX.toFixed(2)},${s.lakeDirZ.toFixed(2)}`)
  sense.sample(LAKE.x, GROUND + 1.6, LAKE.z - LAKE.r + 4, s)
  check(Math.abs(s.lakeShore + 4) < 1e-6 && s.lakeDirZ > 0.99, 'wading 4 m out, the distance is negative and the bearing still points into the lake')
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
const SONGBIRDS = ['songbird1', 'songbird2', 'songbird3', 'songbird4', 'songbird5']

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
  const birds = count(engine, ...SONGBIRDS)
  check(birds >= 8 && birds <= 40, 'songbirds every 3-12 s in a daytime meadow', `${birds} in 120 s`)
  check(count(engine, ...RAPTORS) === 0, 'no raptor below the snow with no cliff')
  check(count(engine, 'owl', 'woodpecker', 'cricket', 'footstep', 'croak1', 'croak2', 'rockslide1', 'rockslide2', 'wave') === 0, 'nothing else fires standing still in a daytime meadow')
  check(!engine.loops.brook.active && !engine.loops.leaves.active && !engine.loops.lakeBed.active && !engine.loops.wind.active && !engine.loops.underwater.active, 'no loop runs in a dry meadow')
  const song = engine.plays.filter((p) => SONGBIRDS.includes(p.name))
  check(song.every((p) => within(p.rate, RATE[0], RATE[1])), `every songbird is pitched ${RATE[0]}-${RATE[1]}x`)
  check(song.every((p) => within(p.gain, ...RULES.songbird.gain)), 'every songbird is within its gain range')
  check(new Set(song.map((p) => p.gain.toFixed(2))).size > song.length / 2, 'songbird volume varies widely')
  check(song.every((p) => p.at && p.at.y > HEAD.y), 'every songbird is placed somewhere above her')
  check(new Set(song.map((p) => p.name)).size >= 3, 'the five songbird clips are all in play', `${new Set(song.map((p) => p.name)).size} distinct`)
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
  check(near.length >= 6 && near.length <= 32, 'a cricket beside her every 6-20 s', `${near.length}`)
  check(near.every((p) => within(p.gain, ...RULES.cricketNear.gain) && Math.hypot(p.at.x - HEAD.x, p.at.z - HEAD.z) <= RULES.cricketNear.range[1] + 1e-6), 'the near cricket is louder and placed within reach')
  check(new Set(near.map((p) => Math.atan2(p.at.z - HEAD.z, p.at.x - HEAD.x).toFixed(1))).size > 3, 'the near cricket comes from different directions')
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
  // Frogs croak within reach, fading with distance, from where they sit.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.frogCount = 2
  sense.s.frogs.set([2, GROUND, 0, 0, GROUND, 8])
  run(new Ambience({ engine, sense, rand: mulberry32(9) }), 120, {})
  const croaks = engine.plays.filter((p) => p.name === 'croak1' || p.name === 'croak2')
  check(croaks.length >= 15 && croaks.length <= 50, 'two frogs croak about every 8 s each', `${croaks.length} in 120 s`)
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
  check(engine.plays.filter((p) => p.name.startsWith('rockslide')).every((p) => within(p.gain, ...RULES.rockslideNear.gain) && p.at && Math.hypot(p.at.x, p.at.z) >= RULES.rockslideNear.range[0] - 1e-6), 'a talus slide is quiet and off in the distance')
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
  // Lake shore: a wave every 1.5-3 s within 10 m, fading out to the reach, from the shore's bearing; the lapping bed loops.
  const engine = fakeEngine(), sense = scripted()
  sense.s.aboveSnow = -200
  sense.s.lakeShore = 2
  sense.s.lakeDirX = 1
  const amb = new Ambience({ engine, sense, rand: mulberry32(12) })
  run(amb, 60, {})
  const waves = engine.plays.filter((p) => p.name === 'wave')
  check(waves.length >= 60 / 3 - 2 && waves.length <= 60 / 1.5 + 2, 'a wave every 1.5-3 s at the water', `${waves.length} in 60 s`)
  check(waves.every((p) => within(p.gain, ...RULES.wave.gain) && p.at.x > HEAD.x), 'waves at full volume from the water side')
  check(engine.loops.lakeBed.active && engine.loops.lakeBed.at.x > HEAD.x, 'the lapping bed loops from the water side')
  const bedLevel = engine.loops.lakeBed.level
  sense.s.lakeShore = 9
  run(amb, 60, {})
  const farWaves = engine.plays.filter((p) => p.name === 'wave').slice(waves.length)
  check(farWaves.length > 15 && farWaves.every((p) => p.gain <= RULES.wave.gain[1] * 0.4), 'at 9 m the waves are faded well down', `max ${Math.max(...farWaves.map((p) => p.gain)).toFixed(2)}`)
  check(engine.loops.lakeBed.level < bedLevel * 0.5, 'the bed fades with distance too')
  sense.s.lakeShore = SHORE_REACH
  run(amb, 2, {})
  check(!engine.loops.lakeBed.active && engine.plays.filter((p) => p.name === 'wave').length === waves.length + farWaves.length, 'past 10 m the lake goes quiet')
  // Wading: the sound comes from behind, toward the shore.
  const wade = fakeEngine()
  sense.s.lakeShore = -3
  run(new Ambience({ engine: wade, sense, rand: mulberry32(12) }), 20, {})
  check(wade.plays.filter((p) => p.name === 'wave').every((p) => p.at.x < HEAD.x), 'wading out, the lapping comes from the shore behind her')
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
