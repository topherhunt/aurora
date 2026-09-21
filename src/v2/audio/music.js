// ---------------------------------------------------------------------------
// Music: the background score of a leafkin glade (DESIGN.md §30). NOT WIRED
// AND NO SONGS: nothing in main.js constructs a Music, SONGS is empty and the
// gate (scripts/check-music.mjs, which runs the player on a fixture pool) is
// off `npm run check`, because no song auditioned so far is the glade's. To
// wire it back: mp3s under public/music/ listed in SONGS with their afinfo
// lengths, a Music constructed on the SoundEngine at boot, enter(seed) where
// the village is built, leave() where the room is disposed and
// update(clock.seconds) once a frame.
//
// THE PLAYLIST IS A TIMETABLE, AND SHE KEEPS TO IT. The playlist is a timeline
// over the room's world clock (clock.js WorldClock.seconds, the same number on
// every client): slot k of village `seed` is a pause of PAUSE_S rolled from
// hash(seed, k) and then the song rolled from it, never the song before, and
// slot k + 1 starts where k ends -- so the second every song starts on is
// fixed by the seed, and every client in a glade hears the same song start at
// the same moment. A song is only ever heard from its beginning: walking in
// mid-song hears nothing until the next song's second comes round, and a
// start the frame loop slept through (a hidden tab) is passed over for the
// one after. A song that has started plays to its end unless she leaves, or
// turns the music off; back on, she waits for the next start like anyone
// walking in. The slot lengths come from SONGS' pinned `s`, not the decoder's
// report, so the timeline is the same numbers on every browser.
//
// THE SONGS ARE STREAMED, NOT DECODED: a decoded two-minute song is 45 MB of
// PCM, four of them more than a Quest should hold for a bed. Each is an
// HTMLMediaElement fed into the engine through a MediaElementAudioSourceNode
// and one level gain, on the master bus so the panel's Sound row takes it and
// the water does not (a score is not in the world). No three, no DOM beyond
// the elements: the gate hands in a fake engine and a fake element factory.
// ---------------------------------------------------------------------------

import { hash32 } from '../../sim/score.js'

/** The glade's pool, `{ url, s }`: public/-relative paths and each clip's length in seconds (afinfo), the number the timeline is cut on. Empty until the right songs are found. */
export const SONGS = []
/** The silence before each song, seconds: one to five minutes. */
export const PAUSE_S = [60, 300]
export const LEVEL = 0.125
export const FADE_OUT_S = 3
/** A start reached this many seconds late still plays from the top; later is a start missed, and the next is waited for. */
export const LATE_S = 2

/**
 * The timeline of village `seed` over `songs`: `slot(k)` is `{ song, pause,
 * start, on }`, the song's index into `songs`, the pause before it, the world
 * second the pause begins and the world second the song starts; `at(seconds)`
 * the slot standing at a world time, with `pauseLeft` the seconds of its
 * pause still to run (0 inside its song). Slots are walked from 0 and kept,
 * so a lookup is one pass the first time.
 */
export function timeline(seed, songs = SONGS) {
  if (!Number.isInteger(seed)) throw new Error(`music: the seed must be an integer, got ${seed}`)
  if (songs.length === 0) throw new Error('music: no songs')
  for (const s of songs) if (!(s.s > 0)) throw new Error(`music: ${s.url} has no length`)
  const slots = []
  const slot = (k) => {
    if (!Number.isInteger(k) || k < 0) throw new Error(`music: bad slot ${k}`)
    while (slots.length <= k) {
      const i = slots.length
      const prev = i > 0 ? slots[i - 1] : null
      const pause = PAUSE_S[0] + (PAUSE_S[1] - PAUSE_S[0]) * (hash32(seed, i, 1) / 2 ** 32)
      // Any song but the one before, so a pool of four never plays one twice running.
      const song = prev === null ? hash32(seed, i, 0) % songs.length
        : songs.length === 1 ? 0 : (prev.song + 1 + (hash32(seed, i, 0) % (songs.length - 1))) % songs.length
      const start = prev === null ? 0 : prev.start + prev.pause + songs[prev.song].s
      slots.push({ song, pause, start, on: start + pause })
    }
    return slots[k]
  }
  const at = (seconds) => {
    if (!Number.isFinite(seconds)) throw new Error(`music: bad time ${seconds}`)
    const t = Math.max(0, seconds)
    let k = 0
    while (slot(k + 1).start <= t) k++
    const s = slot(k)
    return { k, song: s.song, pauseLeft: Math.max(0, s.on - t) }
  }
  return { slot, at }
}

export class Music {
  /**
   * @param engine         a SoundEngine (or the gate's fake): `ctx` and `master`.
   * @param songs          the pool; SONGS.
   * @param createElement  url -> an HTMLMediaElement (or the gate's fake); `new Audio(url)`.
   */
  constructor({ engine, songs = SONGS, createElement = (url) => new Audio(url) }) {
    if (!engine || !engine.ctx || !engine.master) throw new Error('Music: missing engine')
    this.engine = engine
    this.songs = songs
    const ctx = engine.ctx
    this.level = ctx.createGain()
    this.level.gain.value = 0
    this.level.connect(engine.master)
    // One element and one source node a song: an element attaches to a source once for good.
    this.tracks = songs.map(({ url }) => {
      const el = createElement(url)
      el.preload = 'none'
      ctx.createMediaElementSource(el).connect(this.level)
      return el
    })
    // The glade she is in: its timeline, the slot whose start she is waiting
    // for (-1: to be aimed from the clock on the next update) and the element
    // playing.
    this.tl = null
    this.next = -1
    this.playing = null
    // The element fading out and the ctx time its fade lands, after leave() or the row going off.
    this.fading = null
    // A song that failed to load: the music is off until the next room, and says so once.
    this.dead = false
    // For a menu row beside the Sound one, when the music is wired.
    this.enabled = true
  }

  get active() {
    return this.tl !== null
  }

  /** She is in the glade of `seed`: from the next update, she waits on its timeline for a song's start. */
  enter(seed) {
    if (this.tl !== null) throw new Error('Music.enter: already in a glade')
    this._cut()
    this.tl = timeline(seed, this.songs)
    this.next = -1
    this.dead = false
  }

  /** She has left: the song fades over FADE_OUT_S and is stopped when the fade lands; the playlist is dropped. */
  leave() {
    if (this.tl === null) return
    this.tl = null
    this.next = -1
    this._fade()
  }

  /** A menu row's switch: off fades the song out and starts none; on waits for the next start, as walking in does. */
  setEnabled(on) {
    if (typeof on !== 'boolean') throw new Error(`Music.setEnabled: expected a boolean, got ${on}`)
    if (on === this.enabled) return
    this.enabled = on
    this.next = -1
    if (!on) this._fade()
  }

  _fade() {
    if (this.playing === null) return
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setValueAtTime(LEVEL, now)
    this.level.gain.linearRampToValueAtTime(0, now + FADE_OUT_S)
    this.fading = { el: this.playing, until: now + FADE_OUT_S }
    this.playing = null
  }

  /** A fade cut short, and whatever was playing stopped: silence, now. */
  _cut() {
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setValueAtTime(0, now)
    for (const el of [this.fading?.el, this.playing]) if (el) { el.pause(); el.currentTime = 0 }
    this.fading = null
    this.playing = null
  }

  _play(song) {
    const el = this.tracks[song]
    el.currentTime = 0
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setValueAtTime(LEVEL, now)
    this.playing = el
    const p = el.play()
    if (p && typeof p.catch === 'function') p.catch((err) => console.error(`[music] ${this.songs[song].url} would not play:`, err))
  }

  /** The slot whose start is next from world time `seconds`: this one if its pause is running or its start is within LATE_S, else the one after. */
  _aim(seconds) {
    const { k, pauseLeft } = this.tl.at(seconds)
    this.next = pauseLeft > 0 || seconds - this.tl.slot(k).on <= LATE_S ? k : k + 1
    // Told to fetch during the pause before it, so it starts on the beat.
    const el = this.tracks[this.tl.slot(this.next).song]
    el.preload = 'auto'
    el.load()
  }

  /** Once a frame, with the room's world clock: a song starts on its slot's second and plays to the element's own end. */
  update(seconds) {
    if (this.fading !== null && this.engine.ctx.currentTime >= this.fading.until) {
      this.fading.el.pause()
      this.fading.el.currentTime = 0
      this.fading = null
    }
    if (this.tl === null || this.dead || !this.enabled) return
    if (this.playing !== null) {
      if (this.playing.error) {
        this.dead = true
        console.error(`[music] ${this.playing.src} failed to load; the glade's music is off:`, this.playing.error)
        this.playing.pause()
        this.playing = null
        return
      }
      if (!this.playing.ended) return
      this.playing = null
    }
    if (this.next < 0) this._aim(seconds)
    const { song, on } = this.tl.slot(this.next)
    if (seconds < on) return
    // A start the loop slept through is passed over, not played late.
    if (seconds - on > LATE_S) { this._aim(seconds); return }
    this._play(song)
    this.next = -1
  }
}
