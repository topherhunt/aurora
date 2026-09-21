// Node-side gate for the glade's score (src/v2/audio/music.js). OFF `npm run
// check` while the music is unwired and SONGS is empty (see the module
// header); run it by hand:
//
//   node scripts/check-music.mjs
//
// The timeline and the player run on POOL, a fixture of four songs of the
// lengths the glade's had, so the numbers below hold whatever SONGS lists;
// what SONGS does list is checked to exist under public/.
//
// The TIMELINE is pure and is checked on its numbers: every pause in
// PAUSE_S, no song twice running, the same slots for the same seed and
// different slots for another, and `at()` landing on the slot whose span
// holds the time. The PLAYER runs against a fake engine and fake elements
// that record play/pause/currentTime and what the level gain is told, driven
// frame by frame on a world clock: entering mid-song or mid-pause plays
// nothing until the next start's second, which then plays from 0 on every
// client at once, a start within LATE_S plays and one later is passed over,
// the next song starts on its own second after the element's `ended`,
// leave() and the switch going off ramp the level to 0 over FADE_OUT_S and
// pause the element once the ramp lands, and entering again mid-fade cuts it
// dead.
//
// What this can NOT check: that a browser streams the mp3s, or how they sit
// under the ambience. That needs ears, in a glade.

import fs from 'node:fs'
import { Music, SONGS, PAUSE_S, LEVEL, FADE_OUT_S, LATE_S, timeline } from '../src/v2/audio/music.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

const POOL = [
  { url: 'music/fixture/a.mp3', s: 132.2 },
  { url: 'music/fixture/b.mp3', s: 119.7 },
  { url: 'music/fixture/c.mp3', s: 158.4 },
  { url: 'music/fixture/d.mp3', s: 159.6 },
]

// --- the shipped songs ---------------------------------------------------------
console.log('songs')
{
  const missing = SONGS.filter(({ url }) => !fs.existsSync(new URL(`../public/${url}`, import.meta.url)))
  check(missing.length === 0, 'every song in SONGS is under public/', missing.map((s) => s.url).join(' '))
  check(SONGS.every(({ url }) => !url.startsWith('/')), 'song paths are public-relative, no leading slash')
  check(SONGS.every(({ s }) => s > 60 && s < 600), 'every song is pinned to a length of minutes', SONGS.map((s) => s.s).join(' '))
  check(SONGS.length === 0 || SONGS.length >= 2, 'a pool of at least two, so no song follows itself, or none yet', `${SONGS.length} songs`)
  let threw = false
  try { timeline(1, []) } catch { threw = true }
  check(threw, 'an empty pool throws rather than playing silence on a timetable')
}

// --- the timeline ---------------------------------------------------------------
console.log('timeline')
{
  const N = 400
  const seeds = [1, 2, 3, 0x7fffffff, 12345]
  let pauseOk = true, repeatOk = true, sameOk = true, chainOk = true, onOk = true
  let lo = Infinity, hi = -Infinity
  for (const seed of seeds) {
    const a = timeline(seed, POOL), b = timeline(seed, POOL)
    for (let k = 0; k < N; k++) {
      const s = a.slot(k), t = b.slot(k)
      if (!(s.pause >= PAUSE_S[0] && s.pause <= PAUSE_S[1])) pauseOk = false
      lo = Math.min(lo, s.pause); hi = Math.max(hi, s.pause)
      if (k > 0 && s.song === a.slot(k - 1).song) repeatOk = false
      if (s.song !== t.song || s.pause !== t.pause || s.start !== t.start) sameOk = false
      if (!near(s.on, s.start + s.pause)) onOk = false
      if (k > 0) {
        const p = a.slot(k - 1)
        if (!near(s.start, p.start + p.pause + POOL[p.song].s)) chainOk = false
      }
    }
  }
  check(PAUSE_S[0] === 60 && PAUSE_S[1] === 300, 'the silence between songs is one to five minutes', PAUSE_S.join('..'))
  check(pauseOk, `every pause in [${PAUSE_S}]`, `${lo.toFixed(1)}..${hi.toFixed(1)} over ${N * seeds.length}`)
  check(lo < PAUSE_S[0] + 5 && hi > PAUSE_S[1] - 5, 'the pauses reach both ends of the range')
  check(repeatOk, 'no song twice running')
  check(sameOk, 'the same seed rolls the same slots twice')
  check(chainOk, 'each slot starts where the last one ends, on the pinned lengths')
  check(onOk, 'a slot\'s song starts when its pause ends')
  check(timeline(1, POOL).slot(0).start === 0, 'the first slot starts at world second 0')
  const counts = new Array(POOL.length).fill(0)
  for (const seed of seeds) for (let k = 0; k < N; k++) counts[timeline(seed, POOL).slot(k).song]++
  check(counts.every((c) => c > (N * seeds.length) / POOL.length / 2), 'every song is played a fair share', counts.join(' '))
  const songs1 = [], songs2 = []
  for (let k = 0; k < 12; k++) { songs1.push(timeline(7, POOL).slot(k).song); songs2.push(timeline(8, POOL).slot(k).song) }
  check(songs1.join() !== songs2.join(), 'two seeds roll two playlists', `${songs1.join('')} vs ${songs2.join('')}`)

  const tl = timeline(42, POOL)
  const s1 = tl.slot(1), s2 = tl.slot(2)
  check(tl.at(0).k === 0 && near(tl.at(0).pauseLeft, tl.slot(0).pause), 'at(0) is slot 0 with its whole pause to run')
  check(tl.at(-5).k === 0, 'a time before the anchor is slot 0')
  check(tl.at(s1.start + 1).k === 1 && near(tl.at(s1.start + 1).pauseLeft, s1.pause - 1), 'a second into slot 1 has the rest of its pause left')
  check(tl.at(s1.on + 10).k === 1 && tl.at(s1.on + 10).pauseLeft === 0, 'ten seconds into slot 1\'s song is slot 1 with no pause left')
  check(tl.at(s2.start - 1e-3).k === 1 && tl.at(s2.start).k === 2, 'the boundary belongs to the later slot')
  const far = tl.at(3 * 86400)
  check(far.k > 500 && far.k < 1500, 'three days in lands hundreds of slots along', `k=${far.k}`)
  let threw = false
  try { timeline(1.5, POOL) } catch { threw = true }
  check(threw, 'a non-integer seed throws')
}

// --- a fake engine and fake elements ----------------------------------------------
function fakeEngine() {
  const ctx = { currentTime: 0 }
  const gainLog = []
  const param = {
    value: 0,
    setValueAtTime(v, t) { gainLog.push({ op: 'set', v, t }) },
    linearRampToValueAtTime(v, t) { gainLog.push({ op: 'ramp', v, t }) },
    cancelScheduledValues(t) { gainLog.push({ op: 'cancel', t }) },
  }
  ctx.createGain = () => ({ gain: param, connect(to) { this.to = to } })
  ctx.createMediaElementSource = (el) => ({ el, connect(to) { el.source = to } })
  return { ctx, master: { name: 'master' }, gainLog }
}
function fakeElements() {
  const els = []
  const createElement = (url) => {
    const el = {
      src: url, preload: '', currentTime: 0, paused: true, ended: false, error: null, log: [], loads: 0,
      play() { this.paused = false; this.ended = false; this.log.push('play'); return Promise.resolve() },
      pause() { this.paused = true; this.log.push('pause') },
      load() { this.loads++ },
    }
    els.push(el)
    return el
  }
  return { els, createElement }
}
const playing = (els) => els.filter((e) => !e.paused)
/** Frames of `step` world seconds from `from` until something plays or `until`: the world second it started, or null. */
const runUntilPlaying = (music, els, from, until, step = 0.1) => {
  for (let w = from; w <= until + 1e-9; w += step) {
    music.update(w)
    if (playing(els).length) return w
  }
  return null
}

// --- the player --------------------------------------------------------------------
console.log('player')
{
  const engine = fakeEngine()
  const { els, createElement } = fakeElements()
  const music = new Music({ engine, songs: POOL, createElement })
  check(els.length === POOL.length && els.every((e) => e.source), 'one element a song, each fed into the level gain')
  check(music.level.to === engine.master, 'the level gain hangs off the master bus')
  check(els.every((e) => e.preload === 'none'), 'nothing is fetched before a glade')
  music.update(100)
  check(playing(els).length === 0, 'silent outside a glade')

  // Enter mid-song: silence until the next slot's second, then its song from the top.
  const seed = 42
  const tl = timeline(seed, POOL)
  const s1 = tl.slot(1), s2 = tl.slot(2), s3 = tl.slot(3), s4 = tl.slot(4)
  engine.ctx.currentTime = 10
  music.enter(seed)
  check(playing(els).length === 0, 'enter() alone plays nothing')
  engine.gainLog.length = 0
  music.update(s1.on + 40)
  check(playing(els).length === 0, 'entering mid-song plays nothing', `40 s into slot 1's song`)
  const el2 = els[s2.song]
  check(el2.loads === 1 && el2.preload === 'auto' && els[s1.song].loads === 0, 'the next slot\'s song is told to fetch, not the one half over')
  let t = runUntilPlaying(music, els, s1.on + 40, s2.on + 1)
  check(t !== null && near(t, s2.on, 0.15) && !el2.paused, 'the next slot\'s song starts on its second', `${t?.toFixed(2)} vs ${s2.on.toFixed(2)}`)
  check(el2.currentTime === 0, 'from its beginning')
  const set = engine.gainLog.find((e) => e.op === 'set')
  check(set && set.v === LEVEL && set.t === 10, `the level is set to ${LEVEL} at once`)
  music.update(s2.on + 30)
  check(!el2.paused && el2.log.filter((l) => l === 'play').length === 1, 'and plays on, started once')

  // The song ends: silence until the next slot's second, then its song.
  const el3 = els[s3.song]
  el2.ended = true; el2.paused = true
  music.update(s2.on + POOL[s2.song].s + 0.5)
  check(playing(els).length === 0, 'after the song ends, silence')
  check(el3.loads === 1 && el3.preload === 'auto', 'the next song is told to fetch during the pause')
  music.update(s3.on - 0.2)
  check(playing(els).length === 0, 'still silent a fifth of a second before its second')
  t = runUntilPlaying(music, els, s3.on - 0.2, s3.on + 1)
  check(t !== null && near(t, s3.on, 0.15) && !el3.paused, 'the next song starts on its own second', `${t?.toFixed(2)} vs ${s3.on.toFixed(2)}`)
  check(el3.currentTime === 0 && el2.log.filter((l) => l === 'play').length === 1, 'the next song from the top; the last is not replayed')

  // Leave: a ramp to 0 over FADE_OUT_S, the element paused when it lands.
  engine.ctx.currentTime = 200
  engine.gainLog.length = 0
  music.leave()
  const ramp = engine.gainLog.find((e) => e.op === 'ramp')
  check(ramp && ramp.v === 0 && near(ramp.t, 200 + FADE_OUT_S), `leave() ramps the level to 0 over ${FADE_OUT_S} s`)
  check(!el3.paused, 'the song keeps playing under the fade')
  engine.ctx.currentTime = 200 + FADE_OUT_S - 0.1
  music.update(0)
  check(!el3.paused, 'still playing just before the fade lands')
  engine.ctx.currentTime = 200 + FADE_OUT_S
  music.update(0)
  check(el3.paused && el3.currentTime === 0, 'paused and rewound once the fade lands')
  check(!music.active, 'the playlist is dropped')
  music.update(s4.on); music.update(s4.on + 1)
  check(playing(els).length === 0, 'and nothing plays on, even on a start\'s second')

  // Enter during a pause: wait for the slot's second.
  music.enter(seed)
  music.update(s3.start + 2)
  check(playing(els).length === 0, 'entering mid-pause waits')
  t = runUntilPlaying(music, els, s3.start + 2, s3.on + 1)
  check(t !== null && near(t, s3.on, 0.15) && !els[s3.song].paused, 'then plays the slot\'s song on its second', `${t?.toFixed(2)} vs ${s3.on.toFixed(2)}`)
  music.leave(); music._cut()

  // A start within LATE_S plays from the top; one missed by more is passed over.
  music.enter(seed)
  music.update(s3.on + LATE_S / 2)
  check(!els[s3.song].paused && els[s3.song].currentTime === 0, `entering ${LATE_S / 2} s after a start plays it from the top`)
  music.leave(); music._cut()
  music.enter(seed)
  music.update(s3.on + LATE_S + 1)
  check(playing(els).length === 0, `entering ${LATE_S + 1} s after a start plays nothing`)
  music.update(s3.start + 5)              // waiting on s4 now
  music.update(s4.on + LATE_S + 5)        // the loop slept through s4's second
  check(playing(els).length === 0, 'a start the loop slept through is not played late')
  t = runUntilPlaying(music, els, s4.on + LATE_S + 5, tl.slot(5).on + 1, 0.5)
  check(t !== null && near(t, tl.slot(5).on, 0.6) && !els[tl.slot(5).song].paused, 'the one after is waited for and played on its second', `${t?.toFixed(2)} vs ${tl.slot(5).on.toFixed(2)}`)
  music.leave(); music._cut()

  // Two players entering at different moments of one pause hear the song start together.
  {
    const eA = fakeEngine(), eB = fakeEngine()
    const fA = fakeElements(), fB = fakeElements()
    const a = new Music({ engine: eA, songs: POOL, createElement: fA.createElement })
    const b = new Music({ engine: eB, songs: POOL, createElement: fB.createElement })
    a.enter(seed); a.update(s3.start + 1); a.update(s3.start + 3)
    b.enter(seed); b.update(s3.start + 3)
    let tA = null, tB = null
    for (let i = 0; i < 4000; i++) {
      const w = s3.start + 3 + i * 0.1
      a.update(w); b.update(w)
      if (tA === null && playing(fA.els).length) tA = w
      if (tB === null && playing(fB.els).length) tB = w
    }
    check(tA !== null && tB !== null && near(tA, tB, 1e-6) && near(tA, s3.on, 0.15), 'two who enter in one pause start the song together', `${tA?.toFixed(2)} ${tB?.toFixed(2)} vs ${s3.on.toFixed(2)}`)
  }

  // The switch: off mid-song fades it out and starts none; on waits for the next second.
  {
    const e = fakeEngine()
    const f = fakeElements()
    const m = new Music({ engine: e, songs: POOL, createElement: f.createElement })
    m.enter(seed)
    m.update(s3.on)
    check(!f.els[s3.song].paused, 'plays on its second with the switch on')
    e.ctx.currentTime = 50
    e.gainLog.length = 0
    m.setEnabled(false)
    const r = e.gainLog.find((x) => x.op === 'ramp')
    check(r && r.v === 0 && near(r.t, 50 + FADE_OUT_S), 'off ramps the song out')
    e.ctx.currentTime = 50 + FADE_OUT_S
    m.update(s3.on + 5)
    check(f.els[s3.song].paused, 'and pauses it when the ramp lands')
    m.update(s4.on); m.update(s4.on + 0.1)
    check(playing(f.els).length === 0, 'off, the next start passes in silence')
    m.setEnabled(true)
    m.update(s4.on + 30)
    check(playing(f.els).length === 0, 'back on mid-song, nothing until the next second')
    const w = runUntilPlaying(m, f.els, s4.on + 30, tl.slot(5).on + 1, 0.5)
    check(w !== null && near(w, tl.slot(5).on, 0.6) && !f.els[tl.slot(5).song].paused, 'then the next song on its second')
    let threw = false
    try { m.setEnabled(1) } catch { threw = true }
    check(threw, 'a non-boolean switch throws')
  }

  // Leave and enter again mid-fade: the fade is cut and the new glade starts clean.
  music.enter(seed)
  music.update(s1.on)
  check(!els[s1.song].paused, 'a song playing')
  engine.ctx.currentTime = 300
  music.leave()
  engine.ctx.currentTime = 301
  engine.gainLog.length = 0
  music.enter(seed)
  check(els[s1.song].paused && els[s1.song].currentTime === 0, 'entering mid-fade stops the fading song at once')
  const zero = engine.gainLog.find((e) => e.op === 'set')
  check(zero && zero.v === 0 && zero.t === 301, 'and the level is cut to 0 rather than left ramping')
  music.update(s1.on + 1)
  check(playing(els).length === 1 && !els[s1.song].paused, 'then the new glade plays on the start\'s second')

  // A song that will not load turns the music off, once, and the next glade tries again.
  els[s1.song].error = { code: 4 }
  const warn = console.error
  let said = 0
  console.error = () => { said++ }
  music.update(s1.on + 2); music.update(s1.on + 3); music.update(s1.on + 4)
  console.error = warn
  check(playing(els).length === 0 && said === 1, 'a song that fails to load is stopped and reported once')
  els[s1.song].error = null
  music.leave()
  music.enter(seed)
  music.update(s1.on + 1)
  check(playing(els).length === 1, 'the next glade tries again')

  let threw = false
  try { music.enter(seed) } catch { threw = true }
  check(threw, 'entering a glade from inside one throws')
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
