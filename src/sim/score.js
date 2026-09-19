// ---------------------------------------------------------------------------
// The score: what every creature layer shares so that every client in a room
// plays the same creature the same way at the same moment (_notes/creature-sync.md).
//
// Time is the room's world clock in seconds (clock.js WorldClock.seconds). A
// creature's life is cut into CHAPTER_S chapters, its own grid offset by the
// hash of its key, and each chapter is a chain of phrases rolled from
// hash(key, chapter, index) whose durations and end poses are closed-form.
// Inside a phrase the creature integrates at TICK_HZ on absolute tick indexes
// of world time, so two clients run the same tick sequence with the same
// per-phrase PRNG and land on the same pose; the frame interpolates between
// the last two ticks. The integrated pose is eased onto the phrase's planned
// end pose over its last EASE_S seconds and snapped there at the boundary,
// which is what keeps a last-ulp difference between two engines from ever
// growing into something the eye reads.
//
// No three.js here: src/sim is pure arithmetic (DESIGN.md §1).
// ---------------------------------------------------------------------------

import { clamp01, mulberry32 } from './mathx.js'

export const TICK_HZ = 20
export const TICK_S = 1 / TICK_HZ
// A chapter of a creature's life: at its turn every creature is at its home pose and the next chapter starts from nothing, so a join, an anchor and the relay's memory are all bounded by one of these.
export const CHAPTER_S = 600
// The tail of a phrase over which the integrated pose is blended onto the planned end pose.
export const EASE_S = 3
// A swarm creature's grid (frogs, fish): its motion is cut into segments this long, each from one pose that is a pure function of (key, segment index) to the next, so a client meeting the bed mid-segment plans that segment alone. Its chapter for chapterOf.
export const GRID_S = 8
// Ticks a frame may spend replaying one creature toward now: a join replays at most one phrase, spread over frames at this rate (20 s of world time a frame).
export const CATCH_UP_TICKS = 400

/** A 32-bit mix of integers, the same on every engine: the seed of everything a creature rolls. */
export function hash32(...ints) {
  let h = 0x9e3779b1
  for (const v of ints) {
    h = Math.imul(h ^ (v | 0), 0x27d4eb2d)
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  }
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** A creature key -- an integer, or a string such as "stag:1234:2" -- as a 32-bit hash. */
export function keyHash(key) {
  if (typeof key === 'number') {
    if (!Number.isInteger(key)) throw new Error(`score: a numeric key must be an integer, got ${key}`)
    return hash32(key)
  }
  if (typeof key !== 'string' || key === '') throw new Error(`score: bad creature key ${key}`)
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return hash32(h)
}

/** The PRNG for one phrase of one creature's chapter: the same sequence on every client, whoever rolls it first. */
export function phraseRand(key, chapter, index) {
  return mulberry32(hash32(keyHash(key), chapter, index))
}

/**
 * Which chapter world time `seconds` falls in for the creature `key`: its
 * index, its start, and the key's grid offset. The offset spreads the turns
 * across the chapter so a valley of creatures does not all go home at once.
 */
export function chapterOf(seconds, key, chapterS = CHAPTER_S) {
  if (!Number.isFinite(seconds)) throw new Error(`score: bad time ${seconds}`)
  const offset = keyHash(key) % chapterS
  const index = Math.floor((seconds - offset) / chapterS)
  return { index, start: index * chapterS + offset, offset }
}

/** The absolute tick index of world time `seconds`: the last tick at or before it. */
export function tickOf(seconds) {
  return Math.floor(seconds * TICK_HZ + 1e-7)
}

/** The first tick index at or after world time `seconds`: the tick a phrase starting then is entered on, so a joiner placed at its start pose steps from the tick before. */
export function tickAfter(seconds) {
  return Math.ceil(seconds * TICK_HZ - 1e-7)
}

/**
 * Advance a creature's tick record to world time `now`, calling `fn(tickIndex)`
 * once per tick in order, at most `budget` times; returns how many ran. `rec`
 * carries `tick`, the last index run (the caller sets it to tickOf(the time
 * its pose is true at) before the first call), and `alpha`, how far `now` is
 * past that tick as a fraction of one, for the frame to interpolate the last
 * two poses by. A record more than `budget` ticks behind keeps catching up
 * next call, its alpha pinned to 1 meanwhile.
 */
export function stepTo(rec, now, fn, budget = CATCH_UP_TICKS) {
  if (!Number.isInteger(rec.tick)) throw new Error(`score: stepTo needs an integer tick, got ${rec.tick}`)
  const want = tickOf(now)
  let n = 0
  while (rec.tick < want && n < budget) {
    rec.tick++
    fn(rec.tick)
    n++
  }
  rec.alpha = rec.tick < want ? 1 : clamp01((now - rec.tick * TICK_S) * TICK_HZ)
  return n
}

/** The blend weight onto a phrase's end pose at `elapsed` seconds of its `dur`: 0 until the last EASE_S, smoothly 1 at the end. */
export function easeWeight(elapsed, dur, easeS = EASE_S) {
  const t = clamp01((elapsed - (dur - easeS)) / easeS)
  return t * t * (3 - 2 * t)
}

/** The shortest signed turn from heading `a` to `b`. */
export function swing(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a))
}

/**
 * The chain of phrases for every creature of a layer, planned once per
 * chapter and cached. `plan(key, chapter, rand)` returns the chapter's list,
 * each phrase `{ kind, dur, ... }` with `dur` closed-form; the list is
 * stretched so its durations sum to the chapter exactly (the last phrase
 * takes the remainder, and a list that overruns is refused). `at(key, seconds)`
 * finds the phrase playing at a world time.
 */
export class Score {
  /**
   * `keep` planned chapters a key (the last asked for, and the ones before
   * it), for a score whose chapters are read out of order -- a layer planning
   * against another's; `cap` keys kept at all, the longest unasked forgotten,
   * for one asked about creatures it never wakes.
   */
  constructor(plan, { chapterS = CHAPTER_S, keep = 1, cap = Infinity } = {}) {
    if (typeof plan !== 'function') throw new Error('Score needs a plan(key, chapter, rand) function')
    this.plan = plan
    this.chapterS = chapterS
    this.keep = keep
    this.cap = cap
    // key -> [{ index, start, phrases, starts }], the chapter last asked for last.
    this.cache = new Map()
  }

  /** The planned chapter holding world time `seconds` for `key`. */
  chapter(key, seconds) {
    const { index, start } = chapterOf(seconds, key, this.chapterS)
    let had = this.cache.get(key)
    if (had) {
      // Asked again: the key moves to the young end of the map.
      this.cache.delete(key)
      this.cache.set(key, had)
      for (const entry of had) if (entry.index === index) return entry
    } else {
      if (this.cache.size >= this.cap) this.cache.delete(this.cache.keys().next().value)
      had = []
      this.cache.set(key, had)
    }
    const rand = mulberry32(hash32(keyHash(key), index, 0x5c0e))
    const phrases = this.plan(key, index, rand)
    if (!Array.isArray(phrases) || phrases.length === 0) throw new Error(`score: plan for ${key} chapter ${index} returned no phrases`)
    const starts = new Array(phrases.length)
    let t = 0
    for (let i = 0; i < phrases.length; i++) {
      const p = phrases[i]
      if (!(p.dur >= 0) || !Number.isFinite(p.dur)) throw new Error(`score: phrase ${i} of ${key} chapter ${index} has no finite dur: ${p.dur}`)
      starts[i] = t
      t += p.dur
    }
    const last = phrases[phrases.length - 1]
    const over = t - this.chapterS
    if (over > last.dur + 1e-9) throw new Error(`score: plan for ${key} chapter ${index} overruns the chapter by ${over.toFixed(1)} s`)
    last.dur -= over
    const entry = { index, start, phrases, starts }
    if (had.length >= this.keep) had.shift()
    had.push(entry)
    return entry
  }

  /**
   * `{ chapter, phrases, index, phrase, start, elapsed }` at world time
   * `seconds`: the phrase playing, when it began (absolute) and how far into
   * it the time is.
   */
  at(key, seconds) {
    const ch = this.chapter(key, seconds)
    const t = seconds - ch.start
    let i = ch.phrases.length - 1
    while (i > 0 && ch.starts[i] > t + 1e-9) i--
    return { chapter: ch.index, phrases: ch.phrases, index: i, phrase: ch.phrases[i], start: ch.start + ch.starts[i], elapsed: t - ch.starts[i] }
  }

  forget(key) {
    this.cache.delete(key)
  }
}
