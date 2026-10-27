// ---------------------------------------------------------------------------
// Music: an occasional song for the place she is in (DESIGN.md §30, The score).
// Each POOLS key is a folder of public/music/; poolFor() names the one for
// where she stands and the hour. Silence of PAUSE_S comes before the first
// song and after every one, a song is drawn at random from the pool standing
// when the silence ends, and it plays to its end unless the pool changes
// under it, which fades it out over FADE_OUT_S. Indoors (only ever a town's
// or a glade's house) the song goes on, and may start, through a low-pass and
// at INDOOR_GAIN.
//
// THE ROOM OWNER LEADS. Every client puts wire() on its pose; the relay names
// the owner (its oldest client). A client in the owner's pool follows it
// instead of its own silences: the owner's song, from the world second it
// started at (clock.seconds, the same on every client), faded in over
// FADE_IN_S when joined late, and no song of its own while the owner is
// silent. Out of the owner's pool it runs its own, from a fresh silence.
//
// THE SONGS ARE STREAMED, NOT DECODED: a decoded three-minute song is 60 MB of
// PCM. Each is an HTMLMediaElement made the first time it is drawn, through
// its own gain (its fade) onto the master bus, so the panel's Sound row takes
// it. No three, no DOM beyond the elements: the gate hands in a fake engine,
// a fake element factory and a seeded random.
// ---------------------------------------------------------------------------

/** Each pool's songs, public/-relative under music/<pool>/. check-music.mjs pins these to the folders on disk; the wire carries a song as its index here. */
export const POOLS = {
  caverns: ['Abyss 1.mp3', 'Abyss 2.mp3', 'Abyss 3.mp3', 'Abyss 4.mp3', 'Caverns 5.mp3', 'Caverns 6.mp3'],
  'forest-day': ['Home Beyond the Vale - 1.mp3', 'Home Beyond the Vale - 2.mp3', 'Home Beyond the Vale - 4 - compass.mp3', 'Home Beyond the Vale - 5.mp3', 'Home Beyond the Vale - 6 - every day.mp3', 'Home Beyond the Vale - 8 - only stories.mp3'],
  'forest-night': ['mirror moors 1.mp3', 'mirror moors 2.mp3', 'mirror moors 3.mp3', 'mirror moors 4.mp3', 'mirror moors 5.mp3'],
  'human-town-day': ['02 Clockwork Continent.mp3', 'Salt and Copper - Meridians.mp3', 'The Ship Awaits - 4 - seaspray, victory.mp3'],
  'human-town-night': ['05 Day after Day.mp3', 'The Ship Awaits - 2 - dogs and children, peace.mp3'],
  'leafkin-glade': ['Caverns 1.mp3', 'Caverns 2.mp3', 'Caverns 3.mp3', 'Caverns 4.mp3', 'OH - Swamp - Soft raindrops.mp3'],
  'snow-day': ['OH - Snow - White Silence 1.mp3', 'OH - Snow - White Silence 2.mp3'],
  'snow-night': ['The Ship Awaits - bonechill, snow and swamp.mp3'],
}
export const songUrl = (pool, song) => `music/${pool}/${POOLS[pool][song]}`

/** The silence before each song, seconds. */
export const PAUSE_S = [180, 360]
export const LEVEL = 0.5
export const FADE_OUT_S = 10
/** A followed song joined more than LATE_S into it fades in over FADE_IN_S; one joined sooner just starts. */
export const FADE_IN_S = 3
export const LATE_S = 1
/** Indoors: the song's level is multiplied by INDOOR_GAIN and low-passed at INDOOR_LP Hz, eased over INDOOR_TAU. */
export const INDOOR_GAIN = 0.7
export const INDOOR_LP = 2000
export const OPEN_LP = 20000
export const INDOOR_TAU = 0.3

/** The pool for where she is: a cave over everything, then the glade room, a town's ground, above the snowline, else the forest; day by `day` (dayness >= 0.5). */
export function poolFor({ cave, glade, town, aboveSnow, day }) {
  if (cave) return 'caverns'
  if (glade) return 'leafkin-glade'
  const half = day ? 'day' : 'night'
  if (town) return `human-town-${half}`
  return aboveSnow ? `snow-${half}` : `forest-${half}`
}

/** A peer's wire() as `{ pool, song, startS }`, or null when it is not one this build can play (an older or newer client's pools). */
export function musicFromWire(w) {
  if (!Array.isArray(w) || w.length !== 3 || !(w[0] in POOLS) || !Number.isInteger(w[1]) || w[1] < -1 || w[1] >= POOLS[w[0]].length || !Number.isFinite(w[2])) return null
  return { pool: w[0], song: w[1], startS: w[2] }
}

export class Music {
  /**
   * @param engine         a SoundEngine (or the gate's fake): `ctx` and `master`.
   * @param createElement  url -> an HTMLMediaElement (or the gate's fake); `new Audio(url)`.
   * @param random         () -> [0, 1); Math.random.
   */
  constructor({ engine, createElement = (url) => new Audio(encodeURI(url)), random = Math.random }) {
    if (!engine || !engine.ctx || !engine.master) throw new Error('Music: missing engine')
    this.engine = engine
    this.createElement = createElement
    this.random = random
    const ctx = engine.ctx
    // Each song's gain -> room (indoor gain) -> muffle -> master.
    this.room = ctx.createGain()
    this.room.gain.value = 1
    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = OPEN_LP
    this.room.connect(this.muffle)
    this.muffle.connect(engine.master)
    // url -> { el, gain }, made on first draw: an element attaches to a source node once for good.
    this.tracks = new Map()
    this.silence = this._rollPause()
    // { track, pool, song, startS } while a song plays; the fading tracks with the ctx time each lands.
    this.playing = null
    this.fading = []
    this.indoors = false
    this.pool = null
    this.following = false
    // The followed song's `pool/song@startS` since she came into the owner's pool, so one that has ended here is not started again while the owner still says it plays.
    this.heard = null
  }

  _rollPause() {
    return PAUSE_S[0] + (PAUSE_S[1] - PAUSE_S[0]) * this.random()
  }

  _track(url) {
    let t = this.tracks.get(url)
    if (t === undefined) {
      const ctx = this.engine.ctx
      const el = this.createElement(url)
      el.preload = 'auto'
      const gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(this.room)
      ctx.createMediaElementSource(el).connect(gain)
      t = { el, gain, url }
      this.tracks.set(url, t)
    }
    return t
  }

  /** Song `song` of `pool` from `offset` seconds in, which the room calls world second `startS`. */
  _start(pool, song, startS, offset) {
    const track = this._track(songUrl(pool, song))
    this.fading = this.fading.filter((f) => f.track !== track)
    const now = this.engine.ctx.currentTime
    const g = track.gain.gain
    g.cancelScheduledValues(now)
    if (offset > LATE_S) {
      g.setValueAtTime(0, now)
      g.linearRampToValueAtTime(LEVEL, now + FADE_IN_S)
    } else g.setValueAtTime(LEVEL, now)
    track.el.currentTime = offset
    this.playing = { track, pool, song, startS }
    const p = track.el.play()
    if (p && typeof p.catch === 'function') p.catch((err) => console.error(`[music] ${track.url} would not play:`, err))
  }

  _fade() {
    const { track } = this.playing
    const now = this.engine.ctx.currentTime
    const g = track.gain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + FADE_OUT_S)
    this.fading.push({ track, until: now + FADE_OUT_S })
    this.playing = null
  }

  /** What the pose carries: `[pool, song or -1, startS]`. */
  wire() {
    if (this.pool === null) return null
    return this.playing === null ? [this.pool, -1, 0] : [this.pool, this.playing.song, Math.round(this.playing.startS * 100) / 100]
  }

  /**
   * Once a frame: `dt` seconds, `pool` a POOLS key for where she is (poolFor),
   * `indoors` whether she is in a house, `seconds` the room's world clock and
   * `lead` the room owner's musicFromWire() (null when she is the owner, or it is
   * unknown).
   */
  update(dt, { pool, indoors, seconds, lead }) {
    if (!(pool in POOLS)) throw new Error(`Music.update: no pool ${pool}`)
    this.pool = pool
    const now = this.engine.ctx.currentTime
    if (indoors !== this.indoors) {
      this.indoors = indoors
      this.room.gain.setTargetAtTime(indoors ? INDOOR_GAIN : 1, now, INDOOR_TAU)
      this.muffle.frequency.setTargetAtTime(indoors ? INDOOR_LP : OPEN_LP, now, INDOOR_TAU)
    }
    this.fading = this.fading.filter((f) => {
      if (now < f.until) return true
      f.track.el.pause()
      return false
    })
    if (this.playing !== null) {
      const { el, url } = this.playing.track
      if (el.error) console.error(`[music] ${url} failed to load:`, el.error)
      if (el.error || el.ended) {
        this.playing = null
        this.silence = this._rollPause()
      } else if (this.playing.pool !== pool) {
        this._fade()
        this.silence = this._rollPause()
      }
    }
    const follow = lead !== null && lead.pool === pool
    if (follow) {
      this.following = true
      if (lead.song < 0) return
      const key = `${lead.pool}/${lead.song}@${lead.startS}`
      if (key === this.heard) return
      this.heard = key
      if (this.playing !== null) this._fade()
      this._start(pool, lead.song, lead.startS, Math.max(0, seconds - lead.startS))
      return
    }
    if (this.following) {
      this.following = false
      this.heard = null
      this.silence = this._rollPause()
    }
    if (this.playing !== null) return
    this.silence -= dt
    if (this.silence <= 0) this._start(pool, Math.floor(this.random() * POOLS[pool].length), seconds, 0)
  }
}
