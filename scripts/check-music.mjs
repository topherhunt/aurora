// Node-side gate for the score (src/v2/audio/music.js):
//
//   node scripts/check-music.mjs
//
// POOLS is checked against the folders under public/music/, and poolFor
// against every place and hour. The PLAYER runs against a fake engine and
// fake elements that record play/pause and what each param is told, driven
// frame by frame: nothing before the first silence ends, a song from the pool
// standing when it does, a silence in PAUSE_S after a song ends, a pool change
// (a step out of town, into a cave, dusk) fading the song over FADE_OUT_S and
// pausing it when the fade lands, and indoors muffling it without stopping it.
// Then the room owner's lead: a client in its pool plays the owner's song
// from the owner's world second, fading it in when late, starts none of its
// own while the owner is silent, and runs its own silences outside it.
//
// What this can NOT check: that a browser streams the mp3s, or how they sit
// under the ambience. That needs ears.

import fs from 'node:fs'
import { Music, POOLS, ALOFT_M, PAUSE_S, LEVEL, MUSIC_VOLUMES, FADE_OUT_S, FADE_IN_S, LATE_S, INDOOR_GAIN, INDOOR_LP, OPEN_LP, poolFor, musicFromWire } from '../src/v2/audio/music.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the pools -------------------------------------------------------------------
console.log('pools')
{
  const root = new URL('../public/music/', import.meta.url)
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  check(dirs.join() === Object.keys(POOLS).sort().join(), 'POOLS names every folder under public/music/ and no other', dirs.join(' '))
  for (const pool of dirs) {
    const onDisk = fs.readdirSync(new URL(`${pool}/`, root)).filter((f) => /\.(mp3|m4a)$/.test(f)).sort()
    check((POOLS[pool] ?? []).slice().sort().join('|') === onDisk.join('|'), `${pool}: POOLS lists exactly its ${onDisk.length} songs`)
  }
}

// --- where she is ------------------------------------------------------------------
console.log('poolFor')
{
  const at = (o) => poolFor({ underwater: false, cave: false, aloft: 0, castle: false, glade: false, town: false, aboveSnow: false, day: true, ...o })
  check(at({}) === 'forest-day' && at({ day: false }) === 'forest-night', 'the wild below the snow is the forest, by day and by night')
  check(at({ aboveSnow: true }) === 'snow-day' && at({ aboveSnow: true, day: false }) === 'snow-night', 'above the snowline is the snow, by day and by night')
  check(at({ town: true }) === 'human-town-day' && at({ town: true, day: false }) === 'human-town-night', 'a town is the town, by day and by night')
  check(at({ town: true, aboveSnow: true }) === 'human-town-day', 'a town above the snowline is still the town')
  check(at({ castle: true }) === 'castle-day' && at({ castle: true, day: false }) === 'castle-night', 'a castle is the castle, by day and by night')
  check(at({ castle: true, aboveSnow: true, town: true }) === 'castle-day' && at({ castle: true, cave: true }) === 'caverns' && at({ castle: true, aloft: ALOFT_M + 1 }) === null, 'a castle over the snow and a town, under a cave and the sky')
  check(at({ glade: true }) === 'leafkin-glade' && at({ glade: true, day: false }) === 'leafkin-glade', 'the glade at any hour')
  check(at({ cave: true, day: false }) === 'caverns' && at({ cave: true, glade: true, town: true }) === 'caverns', 'a cave at any hour, over everything')
  check(at({ underwater: true, day: false }) === 'underwater' && at({ underwater: true, cave: true, town: true, glade: true }) === 'underwater', 'under water at any hour, over everything')
  check(at({ aloft: ALOFT_M + 1 }) === null && at({ aloft: ALOFT_M + 1, town: true, day: false }) === null && at({ aloft: ALOFT_M - 1 }) === 'forest-day', `more than ${ALOFT_M} m up there is no pool, below it the ground's`)
  for (const o of [{}, { day: false }, { aboveSnow: true }, { town: true, day: false }, { castle: true }, { castle: true, day: false }, { glade: true }, { cave: true }, { underwater: true }]) if (!(at(o) in POOLS)) check(false, `${at(o)} is a pool`)
}


console.log('wire')
{
  check(musicFromWire(['forest-day', 2, 12.5])?.song === 2 && musicFromWire(['caverns', -1, 0])?.song === -1, 'a well-formed wire reads back')
  check([undefined, null, ['swamp', 0, 0], ['snow-night', 1, 0], ['caverns', 0.5, 0], ['caverns', -2, 0], ['caverns', 0, NaN], ['caverns', 0]].every((w) => musicFromWire(w) === null), 'an unknown pool, a song out of range or a bad start reads as no lead')
}

// --- a fake engine and fake elements ----------------------------------------------
function fakeParam(value) {
  return {
    value, log: [],
    setValueAtTime(v, t) { this.log.push({ op: 'set', v, t }); this.value = v },
    linearRampToValueAtTime(v, t) { this.log.push({ op: 'ramp', v, t }) },
    setTargetAtTime(v, t) { this.log.push({ op: 'target', v, t }); this.value = v },
    cancelScheduledValues(t) { this.log.push({ op: 'cancel', t }) },
  }
}
function fakeEngine() {
  const ctx = { currentTime: 0 }
  ctx.createGain = () => ({ gain: fakeParam(1), connect(to) { this.to = to } })
  ctx.createBiquadFilter = () => ({ type: '', frequency: fakeParam(350), connect(to) { this.to = to } })
  ctx.createMediaElementSource = (el) => ({ connect(to) { el.source = to } })
  return { ctx, master: { name: 'master' } }
}
function fakeElements() {
  const els = []
  const createElement = (url) => {
    const el = {
      src: url, preload: '', currentTime: 0, paused: true, ended: false, error: null, plays: 0,
      play() { this.paused = false; this.ended = false; this.plays++; return Promise.resolve() },
      pause() { this.paused = true },
    }
    els.push(el)
    return el
  }
  return { els, createElement }
}
// A seeded random, so the rolls repeat run to run.
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
const STEP = 0.1
const make = (seed = 1) => {
  const engine = fakeEngine(), f = fakeElements()
  const music = new Music({ engine, createElement: f.createElement, random: mulberry(seed) })
  // `world` stands in for clock.seconds, a room's hour from long before she came.
  const m = { engine, music, ...f, world: 5000 }
  m.step = (pool, indoors = false, lead = null) => { engine.ctx.currentTime += STEP; m.world += STEP; music.update(STEP, { pool, indoors, seconds: m.world, lead }) }
  /** Steps in `pool` until a song plays or `limit` seconds pass: the seconds it took, or null. */
  m.until = (pool, limit, indoors = false, lead = null) => {
    for (let s = STEP; s <= limit + 1e-9; s += STEP) { m.step(pool, indoors, lead); if (music.playing !== null) return s }
    return null
  }
  return m
}
const gainOf = (m) => m.music.playing.track.gain.gain

console.log('player')
{
  // The first silence, over many seeds.
  let lo = Infinity, hi = -Infinity, fromPool = true
  for (let seed = 1; seed <= 40; seed++) {
    const m = make(seed)
    const t = m.until('forest-night', PAUSE_S[1] + 1)
    if (t === null) { lo = -1; break }
    lo = Math.min(lo, t); hi = Math.max(hi, t)
    if (m.music.playing.pool !== 'forest-night' || m.els[0].src !== `music/forest-night/${POOLS['forest-night'][m.music.playing.song]}`) fromPool = false
  }
  check(lo >= PAUSE_S[0] && hi <= PAUSE_S[1] + STEP, `the first song comes after ${PAUSE_S[0] / 60}-${PAUSE_S[1] / 60} minutes of silence`, `${lo.toFixed(1)}..${hi.toFixed(1)} s`)
  check(hi - lo > 60, 'the first silence varies seed to seed')
  check(fromPool, 'the song is drawn from the pool standing when the silence ends')

  const m = make(7)
  m.until('forest-day', PAUSE_S[1] + 1)
  const el = m.els[0], track = m.music.playing.track
  check(el.plays === 1 && !el.paused && el.currentTime === 0, 'the song plays from its start')
  check(gainOf(m).value === LEVEL && LEVEL === 0.25, 'at quarter volume')
  check(el.source === track.gain && track.gain.to === m.music.room && m.music.room.to === m.music.muffle && m.music.muffle.to === m.music.fader && m.music.fader.to === m.engine.master, 'through its own gain, the room gain, the muffle and the fader, onto the master bus')
  check(m.music.fader.gain.value === 1, 'the fader starts open')
  const half = MUSIC_VOLUMES.find((v) => v.name === '50%').gain
  m.music.setVolume(half)
  check(LEVEL * m.music.fader.gain.value === 0.125, 'the Music row at 50% plays a song at 0.125')
  m.music.setVolume(MUSIC_VOLUMES.find((v) => v.name === 'Off').gain)
  check(m.music.fader.gain.value === 0 && !el.paused, 'Off silences the song without stopping it')
  m.music.setVolume(1)
  check(new Music({ engine: fakeEngine(), createElement: fakeElements().createElement, volume: half }).fader.gain.value === half, 'a Music made after the row is set starts at its volume')
  const w = m.music.wire()
  check(w[0] === 'forest-day' && w[1] === m.music.playing.song && Math.abs(w[2] - m.world) < 1e-6, 'its wire names the pool, the song and the world second it started')

  // Indoors: muffled and quieter, still playing; out again: open.
  for (let i = 0; i < 20; i++) m.step('forest-day', true)
  check(!el.paused && m.music.playing !== null, 'going indoors does not stop the song')
  check(m.music.room.gain.value === INDOOR_GAIN && INDOOR_GAIN === 0.7, 'indoors is 30% quieter')
  check(m.music.muffle.frequency.value === INDOOR_LP && INDOOR_LP < OPEN_LP / 4, 'indoors is low-passed', `${INDOOR_LP} Hz`)
  m.step('forest-day', false)
  check(m.music.room.gain.value === 1 && m.music.muffle.frequency.value === OPEN_LP, 'back out, the song opens up again')

  // The song ends: a fresh silence, then another.
  el.ended = true
  m.step('forest-day')
  check(m.music.playing === null && m.music.wire()[1] === -1, 'an ended song leaves the player silent, and its wire says so')
  const gap = m.until('forest-day', PAUSE_S[1] + 1)
  check(gap !== null && gap >= PAUSE_S[0] - STEP && gap <= PAUSE_S[1] + STEP, 'the next song waits out a silence in PAUSE_S', `${gap} s`)

  // A pool change mid-song: a fade over FADE_OUT_S, the element paused when it lands.
  const playing = m.music.playing.track
  m.step('forest-night')
  const ramp = playing.gain.gain.log.at(-1)
  check(m.music.playing === null && ramp.op === 'ramp' && ramp.v === 0 && Math.abs(ramp.t - m.engine.ctx.currentTime - FADE_OUT_S) < 1e-9 && FADE_OUT_S === 10, 'a change of pool fades the song to nothing over 10 s')
  for (let s = 0; s < FADE_OUT_S - 1; s += STEP) m.step('forest-night')
  check(!playing.el.paused, 'the song sounds on through its fade')
  for (let s = 0; s < 1.5; s += STEP) m.step('forest-night')
  check(playing.el.paused, 'and is paused when the fade lands')
  const after = m.until('forest-night', PAUSE_S[1] + 1)
  check(after !== null && after >= PAUSE_S[0] - FADE_OUT_S - 2 && m.music.playing.pool === 'forest-night', 'a silence follows the fade, then a song from the new pool')

  // Indoors is a muffle, not a pool: a town's song plays on through the door, and may start there.
  const h = make(3)
  h.until('human-town-day', PAUSE_S[1] + 1, true)
  check(h.music.playing !== null && h.music.playing.pool === 'human-town-day' && h.music.room.gain.value === INDOOR_GAIN, 'a song may start indoors, muffled')
  for (let i = 0; i < 50; i++) h.step('human-town-day', false)
  check(h.music.playing !== null, 'walking out of the house keeps the town\'s song')
  h.step('forest-day')
  check(h.music.playing === null && h.music.fading.length === 1, 'walking out of town fades it')

  // A failed load is said, and the player goes on to the next silence.
  const e = make(5)
  e.until('caverns', PAUSE_S[1] + 1)
  const err = console.error
  let said = 0
  console.error = () => { said++ }
  e.music.playing.track.el.error = { code: 4 }
  e.step('caverns')
  console.error = err
  check(said === 1 && e.music.playing === null, 'a song that fails to load is reported and skipped')

  let threw = false
  try { e.music.update(STEP, { pool: 'swamp', indoors: false, seconds: 0, lead: null }) } catch { threw = true }
  check(threw, 'an unknown pool throws')
}

console.log('following the owner')
{
  // In the owner's pool while it is silent: none of her own.
  const b = make(11)
  const quiet = { pool: 'human-town-day', song: -1, startS: 0 }
  check(b.until('human-town-day', PAUSE_S[1] * 2, false, quiet) === null, 'in the owner\'s pool, no song of her own while the owner is silent')

  // The owner starts a song beside her: she starts it too, at once, from its top.
  const now = { pool: 'human-town-day', song: 1, startS: b.world + 0.15 }
  b.step('human-town-day', false, now)
  check(b.music.playing?.song === 1 && b.music.playing.startS === now.startS && b.els.at(-1).currentTime <= LATE_S, 'the owner\'s song starts for her on the owner\'s second')
  check(gainOf(b).value === LEVEL, 'joined on time, it starts at full level rather than fading in')
  for (let i = 0; i < 30; i++) b.step('human-town-day', false, now)
  check(b.els.at(-1).plays === 1, 'and is not restarted while the owner goes on playing it')

  // It ends here a beat before the owner says so: not played again.
  b.els.at(-1).ended = true
  for (let i = 0; i < 5; i++) b.step('human-town-day', false, now)
  check(b.music.playing === null && b.els.at(-1).plays === 1, 'a followed song that has ended is not started again on a late wire')

  // Walking into the owner's pool mid-song: the song at the owner's second, faded in.
  const c = make(12)
  for (let i = 0; i < 50; i++) c.step('forest-day')
  const mid = { pool: 'human-town-day', song: 0, startS: c.world - 60 }
  c.step('forest-day', false, mid)
  check(c.music.playing === null, 'outside the owner\'s pool, its song is not heard')
  c.step('human-town-day', false, mid)
  const joined = c.els.at(-1), g = gainOf(c).log
  check(c.music.playing?.song === 0 && Math.abs(joined.currentTime - (c.world - mid.startS)) < 1e-6 && joined.currentTime > 60, 'walking in mid-song, she hears it at the owner\'s second', `${joined.currentTime.toFixed(2)} s in`)
  check(g.at(-2).op === 'set' && g.at(-2).v === 0 && g.at(-1).op === 'ramp' && g.at(-1).v === LEVEL && Math.abs(g.at(-1).t - g.at(-2).t - FADE_IN_S) < 1e-9, `and it fades in over ${FADE_IN_S} s`)

  // Out and back in while it plays: faded out, then faded in again where the owner is.
  c.step('forest-day', false, mid)
  check(c.music.playing === null && c.music.fading.length === 1, 'stepping out of the owner\'s pool fades its song')
  for (let i = 0; i < 20; i++) c.step('forest-day', false, mid)
  c.step('human-town-day', false, mid)
  check(c.music.playing?.song === 0 && c.music.fading.length === 0 && Math.abs(joined.currentTime - (c.world - mid.startS)) < 1e-6 && joined.plays === 2, 'and stepping back in picks it up again at the owner\'s second')

  // Her own song when the owner's starts in her pool: hers fades, the owner's plays.
  const d = make(13)
  d.until('caverns', PAUSE_S[1] + 1)
  const own = d.music.playing.track
  const theirs = { pool: 'caverns', song: (d.music.playing.song + 1) % POOLS.caverns.length, startS: d.world }
  d.step('caverns', false, theirs)
  check(d.music.playing.song === theirs.song && d.music.fading.some((f) => f.track === own), 'the owner\'s song takes over from her own, hers fading')

  // Out of the owner's pool: her own silences, from a fresh one.
  const e = make(14)
  for (let i = 0; i < 100; i++) e.step('snow-day', false, { pool: 'snow-day', song: -1, startS: 0 })
  const t = e.until('snow-night', PAUSE_S[1] + 1, false, { pool: 'snow-day', song: -1, startS: 0 })
  check(t !== null && t >= PAUSE_S[0], 'out of the owner\'s pool she runs her own, after a fresh silence', `${t?.toFixed(1)} s`)
}

console.log('no pool')
{
  // Aloft: the song fades as for any pool change, and none starts however long she stays up.
  const m = make(9)
  m.until('forest-day', PAUSE_S[1] + 1)
  const own = m.music.playing.track
  m.step(null)
  check(m.music.playing === null && m.music.fading.some((f) => f.track === own) && m.music.wire() === null, 'with no pool the song fades out and the wire carries none')
  check(m.until(null, PAUSE_S[1] * 2) === null, 'with no pool no song starts, however long she stays')
  const t = m.until('forest-day', PAUSE_S[1] + 1)
  check(t !== null && t >= PAUSE_S[0], 'back on the ground a song comes after a fresh silence', `${t?.toFixed(1)} s`)
}

console.log(failures === 0 ? '\nall music checks pass' : `\n${failures} music check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
