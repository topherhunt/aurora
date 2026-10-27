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
// THE SONGS ARE STREAMED, NOT DECODED: a decoded three-minute song is 60 MB of
// PCM. Each is an HTMLMediaElement made the first time it is drawn, fed into
// the engine through a MediaElementAudioSourceNode, on the master bus so the
// panel's Sound row takes it. No three, no DOM beyond the elements: the gate
// hands in a fake engine, a fake element factory and a seeded random.
// ---------------------------------------------------------------------------

/** Each pool's songs, public/-relative under music/<pool>/. check-music.mjs pins these to the folders on disk. */
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
export const songUrl = (pool, file) => `music/${pool}/${file}`

/** The silence before each song, seconds. */
export const PAUSE_S = [180, 360]
export const LEVEL = 0.5
export const FADE_OUT_S = 10
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
    // Elements -> level (the fade) -> room (indoor gain) -> muffle -> master.
    this.level = ctx.createGain()
    this.level.gain.value = 0
    this.room = ctx.createGain()
    this.room.gain.value = 1
    this.muffle = ctx.createBiquadFilter()
    this.muffle.type = 'lowpass'
    this.muffle.frequency.value = OPEN_LP
    this.level.connect(this.room)
    this.room.connect(this.muffle)
    this.muffle.connect(engine.master)
    // url -> element, made on first draw: an element attaches to a source node once for good.
    this.elements = new Map()
    this.silence = this._rollPause()
    // { el, pool } while a song plays; the fading element and the ctx time its fade lands.
    this.playing = null
    this.fading = null
    this.indoors = false
  }

  _rollPause() {
    return PAUSE_S[0] + (PAUSE_S[1] - PAUSE_S[0]) * this.random()
  }

  _element(url) {
    let el = this.elements.get(url)
    if (el === undefined) {
      el = this.createElement(url)
      el.preload = 'auto'
      this.engine.ctx.createMediaElementSource(el).connect(this.level)
      this.elements.set(url, el)
    }
    return el
  }

  _play(pool) {
    const files = POOLS[pool]
    const url = songUrl(pool, files[Math.floor(this.random() * files.length)])
    const el = this._element(url)
    el.currentTime = 0
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setValueAtTime(LEVEL, now)
    this.playing = { el, pool, url }
    const p = el.play()
    if (p && typeof p.catch === 'function') p.catch((err) => console.error(`[music] ${url} would not play:`, err))
  }

  _fade() {
    const now = this.engine.ctx.currentTime
    this.level.gain.cancelScheduledValues(now)
    this.level.gain.setValueAtTime(this.level.gain.value, now)
    this.level.gain.linearRampToValueAtTime(0, now + FADE_OUT_S)
    this.fading = { el: this.playing.el, until: now + FADE_OUT_S }
    this.playing = null
    this.silence = this._rollPause()
  }

  /** Once a frame: `dt` seconds, `pool` a POOLS key for where she is (poolFor), `indoors` whether she is in a house. */
  update(dt, pool, indoors) {
    if (!(pool in POOLS)) throw new Error(`Music.update: no pool ${pool}`)
    const now = this.engine.ctx.currentTime
    if (indoors !== this.indoors) {
      this.indoors = indoors
      this.room.gain.setTargetAtTime(indoors ? INDOOR_GAIN : 1, now, INDOOR_TAU)
      this.muffle.frequency.setTargetAtTime(indoors ? INDOOR_LP : OPEN_LP, now, INDOOR_TAU)
    }
    if (this.fading !== null && now >= this.fading.until) {
      this.fading.el.pause()
      this.fading = null
    }
    if (this.playing !== null) {
      const { el, url } = this.playing
      if (el.error) console.error(`[music] ${url} failed to load:`, el.error)
      if (el.error || el.ended) {
        this.playing = null
        this.silence = this._rollPause()
      } else if (this.playing.pool !== pool) this._fade()
      return
    }
    this.silence -= dt
    if (this.silence <= 0 && this.fading === null) this._play(pool)
  }
}
