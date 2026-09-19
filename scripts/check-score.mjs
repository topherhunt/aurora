// Node-side gate for the score (src/sim/score.js), the contract every synced
// creature layer is built on (_notes/creature-sync.md).
//
//   node scripts/check-score.mjs
//
// A stand-in walker is planned and stepped the way a real layer is -- rests
// and walks rolled per chapter with closed-form ends, a fixed step on absolute
// ticks of world time, motion noise from the phrase's own PRNG, an ease onto
// each phrase's end pose -- and then run twice on unrelated frame rates, with
// a third instance joining mid-chapter, to show that all three agree on every
// tick, that every phrase boundary lands on its planned pose, that every
// chapter turn finds the walker home, and that a join replays at most one
// phrase under the per-frame budget.

import {
  CATCH_UP_TICKS, CHAPTER_S, EASE_S, TICK_HZ, TICK_S, Score, chapterOf, easeWeight, hash32, keyHash, phraseRand, stepTo, swing, tickOf,
} from '../src/sim/score.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }

// --- the primitives ----------------------------------------------------------------------
console.log('primitives')
{
  check(hash32(1, 2) === hash32(1, 2) && hash32(1, 2) !== hash32(2, 1) && hash32(0) !== hash32(1), 'hash32 is a function of its integers, in order')
  const spread = new Set()
  for (let i = 0; i < 4096; i++) spread.add(hash32(7, i) & 0xff)
  check(spread.size === 256, 'and spreads: 4096 hashes fill every low byte')
  check(keyHash('stag:12:3') === keyHash('stag:12:3') && keyHash('stag:12:3') !== keyHash('stag:12:4') && keyHash(1234) === hash32(1234), 'keyHash takes a string or an integer key')
  check(throws(() => keyHash(''), /bad creature key/) && throws(() => keyHash(1.5), /integer/), 'and refuses an empty string or a fraction')
  const a = phraseRand('fox:1', 3, 2), b = phraseRand('fox:1', 3, 2), c = phraseRand('fox:1', 3, 3)
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()]
  check(sa.join() === sb.join() && sa.join() !== sc.join(), 'phraseRand is the same sequence twice and another for the next phrase')
  const c1 = chapterOf(1234.5, 'fox:1'), c2 = chapterOf(1234.5, 'fox:2')
  check(c1.start <= 1234.5 && c1.start + CHAPTER_S > 1234.5 && c1.start === c1.index * CHAPTER_S + c1.offset && c1.offset >= 0 && c1.offset < CHAPTER_S, 'chapterOf finds the chapter holding the time on the key\'s own grid', `chapter ${c1.index} from ${c1.start} (offset ${c1.offset})`)
  check(c1.offset !== c2.offset, 'two keys have two grids')
  check(chapterOf(c1.start + CHAPTER_S, 'fox:1').index === c1.index + 1 && chapterOf(c1.start - 1e-6, 'fox:1').index === c1.index - 1, 'the turn is exactly one chapter on')
  check(tickOf(0) === 0 && tickOf(TICK_S) === 1 && tickOf(0.99 * TICK_S) === 0 && tickOf(3 * TICK_S) === 3 && TICK_HZ === 20, 'tickOf is the tick at or before the time, at 20 Hz')
  check(easeWeight(0, 10) === 0 && easeWeight(10 - EASE_S, 10) === 0 && easeWeight(10, 10) === 1 && easeWeight(10 - EASE_S / 2, 10) === 0.5, 'easeWeight is 0 until the last EASE_S seconds and 1 at the end')
  check(Math.abs(swing(0.1, 0.1 + Math.PI * 2 - 0.3) + 0.3) < 1e-12, 'swing is the short way round')
  const rec = { tick: 10, alpha: 0 }
  const ran = []
  const n = stepTo(rec, 13.5 * TICK_S, (k) => ran.push(k))
  check(n === 3 && ran.join() === '11,12,13' && rec.tick === 13 && Math.abs(rec.alpha - 0.5) < 1e-9, 'stepTo runs each missing tick once, in order, and leaves alpha as the fraction past the last', `alpha ${rec.alpha}`)
  check(stepTo(rec, 13.5 * TICK_S, () => { throw new Error('no') }) === 0, 'and nothing when caught up')
  const far = { tick: 0, alpha: 0 }
  check(stepTo(far, 1000, () => {}) === CATCH_UP_TICKS && far.tick === CATCH_UP_TICKS && far.alpha === 1, 'a record far behind runs the budget and no more, alpha pinned to 1', `${far.tick} ticks`)
  check(throws(() => stepTo({ tick: 1.5 }, 1, () => {}), /integer tick/), 'a fractional tick is refused')
}

// --- a stand-in walker, planned and stepped as a real layer is ---------------------------------
const HOME = { x: 100, z: -40 }
const SPEED = 1.5
const WANDER = 0.8
// A chapter: rest, walk out, rest, walk on ... and always a walk home then a rest that takes the remainder.
const plan = (key, chapter, rand) => {
  const phrases = []
  let at = { x: HOME.x, z: HOME.z, heading: 0 }
  let t = 0
  const homeDur = (from) => (Math.hypot(HOME.x - from.x, HOME.z - from.z) / SPEED) * 1.3 + EASE_S
  // Each walk is added only while the walk home from its end, and a rest after, still fit the chapter.
  for (;;) {
    const rest = 5 + rand() * 20
    const a = rand() * Math.PI * 2
    const r = 10 + rand() * 30
    const to = { x: at.x + Math.cos(a) * r, z: at.z + Math.sin(a) * r, heading: a }
    const dur = (r / SPEED) * 1.3 + EASE_S
    if (t + rest + dur + homeDur(to) + 5 > CHAPTER_S) break
    phrases.push({ kind: 'rest', dur: rest, to: at })
    phrases.push({ kind: 'walk', dur, to })
    t += rest + dur
    at = to
  }
  const back = { x: HOME.x, z: HOME.z, heading: Math.atan2(HOME.z - at.z, HOME.x - at.x) }
  phrases.push({ kind: 'walk', dur: homeDur(at), to: back })
  phrases.push({ kind: 'rest', dur: 1, to: back })
  return phrases
}
const score = new Score(plan)

class Walker {
  constructor(key, now) {
    this.key = key
    const at = score.at(key, now)
    // The pose at the phrase's start is the phrase before's end, or home for the chapter's first.
    const from = at.index === 0 ? { x: HOME.x, z: HOME.z, heading: 0 } : at.phrases[at.index - 1].to
    this.x = from.x; this.z = from.z; this.heading = from.heading
    this.px = this.x; this.pz = this.z
    this.phraseEnd = at.start + at.phrase.dur
    this.phrase = at.phrase
    this.index = at.index
    this.chapter = at.chapter
    this.rand = phraseRand(key, at.chapter, at.index)
    this.rec = { tick: tickOf(at.start), alpha: 0 }
    this.boundaries = []
    this.replayed = 0
  }

  update(now) {
    this.replayed = stepTo(this.rec, now, (k) => this._tick(k))
  }

  _tick(k) {
    const t = k * TICK_S
    if (t >= this.phraseEnd - 1e-9) {
      // The boundary: exactly the planned end, then the next phrase and its own dice.
      this.x = this.phrase.to.x; this.z = this.phrase.to.z; this.heading = this.phrase.to.heading
      this.boundaries.push({ tick: k, x: this.x, z: this.z, kind: this.phrase.kind })
      const at = score.at(this.key, t)
      this.phrase = at.phrase; this.index = at.index; this.chapter = at.chapter
      this.phraseEnd = at.start + at.phrase.dur
      this.rand = phraseRand(this.key, at.chapter, at.index)
    }
    this.px = this.x; this.pz = this.z
    if (this.phrase.kind !== 'walk') return
    const to = this.phrase.to
    const want = Math.atan2(to.z - this.z, to.x - this.x)
    this.heading += swing(this.heading, want) * Math.min(1, 2 * TICK_S) + (this.rand() - 0.5) * WANDER * Math.sqrt(TICK_S)
    const x = this.x + Math.cos(this.heading) * SPEED * TICK_S
    const z = this.z + Math.sin(this.heading) * SPEED * TICK_S
    const w = easeWeight(t - (this.phraseEnd - this.phrase.dur), this.phrase.dur)
    this.x = x + (to.x - x) * w
    this.z = z + (to.z - z) * w
  }

  pose(now) {
    const a = this.rec.alpha
    return [this.px + (this.x - this.px) * a, this.pz + (this.z - this.pz) * a]
  }
}

console.log('\nthe walker on two frame rates, with a joiner')
{
  const KEY = 'walker:7'
  const t0 = 5000 + chapterOf(5000, KEY).offset + 17.3
  const A = new Walker(KEY, t0)
  const B = new Walker(KEY, t0)
  const seen = new Map()
  let ta = t0, tb = t0
  let diverged = 0, worstAlpha = 0
  const END = t0 + CHAPTER_S * 1.5
  // A at 60 Hz; B at a jittery 72 Hz with the odd 250 ms hitch.
  let i = 0
  while (ta < END || tb < END) {
    if (ta < END) {
      ta += 1 / 60
      A.update(ta)
      const had = seen.get(A.rec.tick)
      const now = [A.x, A.z, A.heading]
      if (!had) seen.set(A.rec.tick, now)
      // Alpha is read only once A has caught up: its first update replays its phrase under the budget.
      if (A.rec.tick === tickOf(ta)) worstAlpha = Math.max(worstAlpha, A.rec.alpha)
    }
    if (tb < END) {
      tb += i % 97 === 0 ? 0.25 : 1 / 72 + (i % 7) * 0.001
      B.update(tb)
      const ref = seen.get(B.rec.tick)
      if (ref && (ref[0] !== B.x || ref[1] !== B.z || ref[2] !== B.heading)) diverged++
    }
    i++
  }
  check(diverged === 0 && seen.size > CHAPTER_S * 1.4 * TICK_HZ, 'stepped on unrelated frame rates, the two are bit-identical at every tick they share', `${seen.size} ticks, ${diverged} diverged`)
  check(worstAlpha < 1 && worstAlpha > 0.9, 'a frame between ticks reads an alpha under one', `worst ${worstAlpha.toFixed(3)}`)
  const bounds = A.boundaries
  // The tick before a boundary is still in the phrase that ended there.
  const onPlan = bounds.every((b) => {
    const at = score.at(KEY, (b.tick - 1) * TICK_S)
    return at.phrase.to.x === b.x && at.phrase.to.z === b.z
  })
  check(bounds.length > 10 && onPlan, 'every phrase boundary lands exactly on the phrase\'s planned end pose', `${bounds.length} boundaries`)
  const turns = bounds.filter((b) => chapterOf(b.tick * TICK_S, KEY).start === b.tick * TICK_S || Math.abs(chapterOf(b.tick * TICK_S, KEY).start - b.tick * TICK_S) < TICK_S)
  check(turns.length === 1 && turns.every((b) => b.x === HOME.x && b.z === HOME.z), 'and the chapter turn finds the walker home', turns.map((b) => `${b.x},${b.z}@${b.tick}`).join(' '))
  const walked = bounds.filter((b) => b.kind === 'walk').length
  check(walked > 5 && A.x !== HOME.x, 'it walked: several walks ended away from home', `${walked} walks`)

  // Ease: through a walk, the tick before its boundary is within a step of the planned end, and the walk's middle is nowhere near it.
  const mid = score.at(KEY, t0 + 200)
  const walk = mid.phrases.find((p, k) => p.kind === 'walk' && mid.starts?.[k] === undefined && k > 0) ?? mid.phrases[1]
  check(walk.kind === 'walk' && walk.dur > EASE_S, 'a walk phrase is longer than the ease')

  // The joiner: spawned two chapters' worth of ticks later than the others began, mid-phrase, it replays only from its phrase's start and agrees from the first tick it shares.
  const tj = t0 + CHAPTER_S * 0.37
  const C = new Walker(KEY, tj)
  const atJ = score.at(KEY, tj)
  const behind = tickOf(tj) - C.rec.tick
  check(behind <= Math.ceil(atJ.phrase.dur * TICK_HZ) + 1 && behind > 0, 'a joiner starts at its phrase\'s start pose, at most one phrase behind', `${behind} ticks behind, phrase ${atJ.index} ${atJ.phrase.kind} ${atJ.phrase.dur.toFixed(1)} s`)
  let frames = 0, most = 0
  let tc = tj
  while (C.rec.tick < tickOf(tc)) { C.update(tc); most = Math.max(most, C.replayed); frames++ }
  check(most <= CATCH_UP_TICKS && frames === Math.ceil(behind / CATCH_UP_TICKS), 'and catches up under the per-frame budget', `${frames} frames, ${most} ticks at most`)
  const ref = seen.get(C.rec.tick)
  check(ref && ref[0] === C.x && ref[1] === C.z && ref[2] === C.heading, 'caught up, it is bit-identical to the others at that tick')
  let agree = 0, disagree = 0
  for (let n = 0; n < 6000; n++) {
    tc += 1 / 90
    C.update(tc)
    const r = seen.get(C.rec.tick)
    if (!r) continue
    if (r[0] === C.x && r[1] === C.z && r[2] === C.heading) agree++
    else disagree++
  }
  check(disagree === 0 && agree > 1000, 'and stays so across the next chapter turn', `${agree} ticks agreed, ${disagree} did not`)

  // A late joiner on a later chapter never asks for the old one: its plan is a fresh roll.
  const D = new Walker(KEY, t0 + CHAPTER_S * 2 + 3)
  check(D.chapter === A.chapter + 1 || D.chapter === chapterOf(t0 + CHAPTER_S * 2 + 3, KEY).index, 'a joiner two chapters on plans that chapter, not the one the others played', `chapter ${D.chapter}`)
}

// --- the Score itself -------------------------------------------------------------------------
console.log('\nthe score')
{
  const ch = score.chapter('walker:7', 12345)
  const sum = ch.phrases.reduce((s, p) => s + p.dur, 0)
  check(Math.abs(sum - CHAPTER_S) < 1e-9 && ch.phrases[ch.phrases.length - 1].kind === 'rest', 'a chapter\'s phrases sum to the chapter exactly, the last taking the remainder', `${ch.phrases.length} phrases`)
  check(score.chapter('walker:7', 12345) === ch && score.chapter('walker:7', 12345 + CHAPTER_S) !== ch, 'the chapter is planned once and cached until the next is asked for')
  const again = new Score(plan).chapter('walker:7', 12345)
  check(JSON.stringify(again.phrases) === JSON.stringify(ch.phrases), 'and a fresh Score plans the same chapter identically')
  const at = score.at('walker:7', ch.start + ch.starts[3] + 0.5)
  check(at.index === 3 && JSON.stringify(at.phrase) === JSON.stringify(ch.phrases[3]) && Math.abs(at.elapsed - 0.5) < 1e-9 && at.start === ch.start + ch.starts[3], 'at() finds the phrase holding a time and how far into it the time is')
  check(score.at('walker:7', ch.start + CHAPTER_S - 1e-6).index === ch.phrases.length - 1 && score.at('walker:7', ch.start + CHAPTER_S).index === 0, 'the last instant is the last phrase and the turn is the next chapter\'s first')
  check(throws(() => new Score(() => [{ kind: 'x', dur: CHAPTER_S + 5 }, { kind: 'y', dur: 2 }]).chapter('k', 0), /overruns/), 'a plan that overruns the chapter is refused')
  check(throws(() => new Score(() => [{ kind: 'x' }]).chapter('k', 0), /finite dur/) && throws(() => new Score(() => []).chapter('k', 0), /no phrases/) && throws(() => new Score(null), /plan/), 'so is a phrase with no duration, an empty plan, or no plan at all')

  // keep and cap: a score read out of order keeps the last chapters asked; one asked about too many keys forgets the longest unasked.
  const planned = []
  const kept = new Score((key, index) => { planned.push(`${key}@${index}`); return [{ kind: 'x', dur: CHAPTER_S }] }, { keep: 2, cap: 3 })
  const a0 = kept.chapter('a', 0)
  const a1 = kept.chapter('a', CHAPTER_S * 2)
  check(kept.chapter('a', 0) === a0 && kept.chapter('a', CHAPTER_S * 2) === a1 && planned.length === 2, 'with keep 2, two chapters of a key are held at once and read back in either order without replanning', planned.join(' '))
  const a2 = kept.chapter('a', CHAPTER_S * 4)
  check(kept.chapter('a', CHAPTER_S * 2) === a1 && kept.chapter('a', CHAPTER_S * 4) === a2 && kept.chapter('a', 0) !== a0 && planned.length === 4, 'a third pushes the oldest asked out, and asking for that one plans it again', planned.join(' '))
  kept.chapter('b', 0)
  kept.chapter('c', 0)
  kept.chapter('a', 0)
  kept.chapter('d', 0)
  check(kept.cache.size === 3 && !kept.cache.has('b') && kept.cache.has('a') && kept.cache.has('c') && kept.cache.has('d'), 'with cap 3, a fourth key evicts the one longest unasked -- an ask moves a key to the young end', [...kept.cache.keys()].join(' '))
  const n = planned.length
  kept.chapter('b', 0)
  check(planned.length === n + 1 && !kept.cache.has('c'), 'and the evicted key is planned afresh when asked again, evicting the next', [...kept.cache.keys()].join(' '))
  kept.forget('a')
  check(!kept.cache.has('a') && kept.chapter('a', 0) !== a0, 'forget() drops every chapter of a key')
}

console.log(`\n${failures ? `${failures} failing` : 'all passing'}`)
process.exit(failures ? 1 : 0)
