// One conversation as she lives it (_notes/conversation-and-quests.md, "A conversation"): whether they will talk at
// all, how long they will put up with her, and when they send her off. Words come from speak.js; this decides when.
// Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { Conversation, strHash } from './speak.js'
import { OPEN_TOPICS, TOPICS } from './lore.js'
import { MANNERS } from './manners.js'

export const CHAT = {
  // Questions they will answer before they have had enough: base, plus chattiness and standing (each 0..1) times these.
  patience: { base: 3, chatty: 6, standing: 4 },
  // Per answer, the odds they cut her off early anyway, by tone.
  dismiss: { cheery: 0.02, plain: 0.05, curt: 0.14 },
  // Odds a stranger is turned away while busy, against a fully unchatty temperament.
  busy: 0.85,
  // Odds a busy human points her to someone chattier (speak.js `passOn`) instead of just turning her away.
  passOn: 0.75,
  // Odds a leafkin of a glade she wronged cuts her off at once (the one who saw it always does).
  furyEnds: 0.5,
  // Standing below which they will not talk to her at all.
  shun: -0.4,
  // Odds, times chattiness, they open with a rumour of their own.
  volunteer: 0.6,
  // Seconds they leave her be after a goodbye, a dismissal or a refusal.
  alone: { bye: 120, dismissed: 90, declined: 45 },
}

const rollOf = (...parts) => mulberry32(hash32(...parts.map((p) => (typeof p === 'string' ? strHash(p) : p))))()

/**
 * Her conversation with `mind`. `open()` is their answer to her hail: a greeting, or a refusal that ends it.
 * `ask(topic)` answers a grid sentence. A line with `ended` true is their last; `alone` is how many seconds to leave them be.
 */
export class Chat {
  /** `ctx` as speak.js Conversation's; `trusted` whether a leafkin trusts her (trust.js), `busy` whether they are about something, `approached` whether they came to her. */
  constructor(mind, ctx, { trusted = true, busy = false, approached = false, salt = 0 } = {}) {
    this.mind = mind
    this.conv = new Conversation(mind, ctx, salt)
    this.trusted = trusted
    this.busy = busy
    this.approached = approached
    this.salt = salt
    this.turns = 0
    this.ended = false
    const T = mind.traits
    this.patience = Math.max(2, Math.round(CHAT.patience.base + T.chattiness * CHAT.patience.chatty + Math.max(0, this.conv._standing()) * CHAT.patience.standing))
  }

  _roll(what) {
    return rollOf(this.conv.ctx.world.seed, this.mind.id, this.salt, this.turns, what)
  }

  _end(line, why) {
    this.ended = true
    if (why === 'dismissed') this.conv.ctx.rapport.warm(this.mind.id, MANNERS.overstay)
    return { ...line, ended: true, alone: CHAT.alone[why] }
  }

  open() {
    const { mind, conv } = this
    const T = mind.traits
    if (conv.ctx.armed) return this._end(conv.refuseArmed(), 'declined')
    if (mind.kind === 'leafkin' && conv.ctx.wronged) {
      const fury = conv.opener()
      return fury.fury > 1 || this._roll('fury') < CHAT.furyEnds ? this._end(fury, 'declined') : fury
    }
    if (mind.kind === 'leafkin' && !this.trusted) return this._end(conv._line(conv._lk('wary'), 'talk-shrug', { moment: 'refuse.wary', mood: 'cold' }), 'declined')
    if (conv._standing() < CHAT.shun) return this._end(conv._line(mind.kind === 'leafkin' ? conv._lk('shun') : "I've nothing to say to you.", 'talk-shrug', { moment: 'refuse.wary', mood: 'cold' }), 'declined')
    const opener = conv.opener()
    // A plea, an errand or a missing child is why they want her; busy or not, they will say it.
    if (opener.quest === undefined && opener.shop === undefined && opener.trade === undefined && this.busy && this._roll('busy') < CHAT.busy * (1 - T.chattiness)) {
      const on = this._roll('passon') < CHAT.passOn ? conv.passOn() : null
      if (on !== null) return this._end(on, 'declined')
      return this._end(conv._line(mind.kind === 'leafkin' ? conv._lk('busy') : conv._pick('busy', ["Not now, I've work to do.", 'Sorry, I am in a hurry.', 'Another time.', 'Busy, busy. Later.']), 'talk-shrug', { moment: 'mood.busy' }), 'declined')
    }
    if (opener.quest !== undefined || opener.shop !== undefined || opener.trade !== undefined) return opener
    // Having come to her, they say plainly what brought them; a chatty one hailed may bring up a rumour unasked.
    const lead = this.approached ? conv.news() ?? conv.wish() ?? this._rumour() : this._roll('volunteer') < CHAT.volunteer * T.chattiness ? this._rumour() : null
    if (lead === null) return opener
    conv.about = lead.about
    conv._hear(lead.about)
    return { ...opener, text: `${opener.text} ${lead.text}`, unlocks: lead.unlocks, about: lead.about }
  }

  /** A fact of lore they know, sometimes of a thing she has never heard of, or null. */
  _rumour() {
    const topics = [...OPEN_TOPICS, ...Object.keys(TOPICS).filter((t) => TOPICS[t].gated)]
    const rumour = this.conv.say(`lore:${pick(this._roll('rumour'), topics)}`, true)
    if (rumour.claim === null) return null
    return { ...rumour, text: `${this.mind.kind === 'leafkin' ? this.conv._lk('rumour') : 'Have you heard?'} ${rumour.text.replace(/ Glad to help\.$/, '')}` }
  }

  /** Her sentence `topic` (grid.js) answered. */
  ask(topic) {
    if (this.ended) throw new Error(`Chat: ${this.mind.id} has already ended the conversation`)
    if (topic === 'bye') return this._end(this.conv.bye(), 'bye')
    if (topic === 'nice:leave') return this._end(this.conv.say(topic), 'bye')
    this.turns++
    // A parent whose child is missing never sends her off. Past patience, what is not about the search turns them back to it.
    if (this.conv._worried()) {
      const q = this.conv.quest
      if (this.turns < this.patience || topic === `ask:person:${q.child}` || topic === 'talk:needs' || topic.startsWith('where:')) return this.conv.say(topic)
      return this.conv.urge(q)
    }
    const line = this.conv.say(topic)
    if (this.turns < this.patience && this._roll('dismiss') >= CHAT.dismiss[this.conv.tone]) return line
    const off = this.mind.kind === 'leafkin' ? this.conv._lk('off') : this.conv._pick('off', ["That's enough questions.", 'I must get on.', 'Well. I have things to do.', 'No more questions now.'])
    return this._end({ ...line, text: `${line.text} ${off}` }, 'dismissed')
  }
}

const pick = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]

// Two neighbours' chatter as short exchanges, so each remark is answered in kind. A step is said by the next speaker of
// the pair: `moment: ids` (the recorded utterances it may be, tools/voice/atoms.js), or a bare moment for any of its
// lines; ` | ` parts are alternatives. Leafkin atoms carry no words, so theirs are bare moments.
export const EXCHANGES = {
  human: {
    greet: ['greet.stranger: good-day hey-there well-met', 'greet.stranger: good-day well-met'],
    morning: ['greet.morning: morning', 'greet.morning: morning up-early'],
    evening: ['greet.evening: evening', 'greet.evening: evening'],
    gossip: ['gossip.lead: did-you-hear never-guess', 'gossip.react: go-on really', 'gossip.lead: between-us', 'gossip.react: dont-believe who-told-you truly | social.disagree: nonsense dont-think-so', 'answer.boast: own-eyes', 'nv.laugh: laugh chuckle | social.disagree: bah tsk | observe.marvel: well-ill-be'],
    cold: ['weather.cold: bitter-cold feel-wind smell-snow', 'social.agree: aye true-enough | weather.cold: brr', 'worry.winter: long-winter stores-last', 'worry.general: hard-times | social.agree: true-enough'],
    fine: ['weather.fine: fine-day sun-out', 'social.agree: aye | mood.content: cant-complain the-life', 'mood.content: sigh-content hum'],
    foul: ['weather.foul: rain-again storm-brewing', 'social.agree: aye true-enough', 'weather.foul: get-indoors'],
    tired: ['mood.tired: long-day back-aches', 'social.agree: aye true-enough | nv.sigh: sigh-long', 'mood.tired: bed-soon', 'bye.warm: get-home-safe go-well'],
    hungry: ['mood.hungry: eat-a-horse', 'mood.hungry: whats-supper | nv.laugh: chuckle'],
    aurora: ['sky.aurora: lights-out sky-dancing look-at-sky', 'observe.marvel: never-tired well-ill-be', 'mood.content: sigh-content'],
    beasts: ['worry.beast: at-the-livestock', 'gossip.react: really truly', 'worry.beast: saw-tracks', 'worry.beast: doors-shut | fear.uneasy: dont-like-this'],
    leafkin: ['worry.leafkin: little-folk', 'worry.leafkin: fairy-stories | social.disagree: nonsense bah', 'answer.boast: own-eyes', 'nv.laugh: snort | social.disagree: tsk'],
    bored: ['mood.bored: nothing-happens', 'nv.laugh: chuckle | talk.town: quiet-place | mood.content: cant-complain', 'mood.bored: sigh-long bah'],
    busy: ['mood.busy: busy-busy no-rest', 'mood.busy: keep-busy | social.agree: aye'],
    missing: ['gossip.lead: someones-missing', 'gossip.react: truly | social.surprise: by-the-gods', 'worry.general: terrible-business', 'missing.sympathy: poor-soul hard-times'],
    worried: ['worry.general: i-worry what-will-we-do', 'missing.sympathy: poor-soul hard-times'],
    dusk: ['observe.dusk: getting-dark', 'social.agree: aye', 'bye.warm: get-home-safe'],
  },
  leafkin: {
    greet: ['greet.friend', 'greet.friend'],
    gossip: ['gossip.lead', 'gossip.react', 'social.agree', 'nv.laugh'],
    curious: ['social.curious', 'social.surprise', 'gossip.react'],
    happy: ['mood.content', 'nv.laugh'],
    aurora: ['sky.aurora', 'observe.marvel', 'mood.content'],
    uneasy: ['fear.uneasy', 'social.agree'],
  },
}

/** Which exchange `mind` turns their pair's chatter to next, at `hour`, `r` a roll, `not` the one just had. */
function nextExchange(mind, ctx, hour, r, not) {
  const conv = new Conversation(mind, ctx)
  const night = hour >= 21 || hour < 5
  if (mind.kind === 'leafkin') return weighed([['gossip', 2], ['curious', 1], ['happy', 1.5], ['aurora', night ? 2.5 : 0], ['uneasy', night ? 0.8 : 0.3]], r, not)
  if (conv._worried()) return 'worried'
  const T = mind.traits
  const q = conv.quest
  const cheery = conv.tone === 'cheery'
  const meal = (hour >= 11 && hour < 13) || (hour >= 17 && hour < 19)
  return weighed([
    ['gossip', 1 + T.chattiness * 2], ['cold', 1], ['fine', hour >= 7 && hour < 18 ? 1 : 0], ['foul', 0.5], ['tired', hour >= 17 || hour < 5 ? 1.5 : 0.3],
    ['hungry', meal ? 1.2 : 0.2], ['aurora', night ? 2 : 0], ['beasts', 0.4 + T.wariness], ['leafkin', 0.4], ['bored', cheery ? 0.3 : 1], ['busy', 0.5],
    ['missing', q !== null && ctx.log.state(q.id) !== 'done' ? 3 : 0], ['dusk', hour >= 17 && hour < 21 ? 1.5 : 0],
  ], r, not)
}

function weighed(weights, r, not) {
  const live = weights.filter(([k, w]) => w > 0 && k !== not)
  let left = r * live.reduce((s, [, w]) => s + w, 0)
  for (const [k, w] of live) if ((left -= w) < 0) return k
  return live[live.length - 1][0]
}

/**
 * The next line of a pair's chatter, said by `mind` at `hour`, `r` and `alt` rolls: `at` is where the pair stands (`{ ex, step }`,
 * null for a fresh meeting, which opens with a greeting). Returns `{ moment, only, at }`, `only` the utterance ids the
 * line may be (null for any) and `at` where the pair stands after it.
 */
export function chatterStep(mind, ctx, at, { hour, r, alt }) {
  const book = EXCHANGES[mind.kind === 'leafkin' ? 'leafkin' : 'human']
  let ex = at === null ? (mind.kind === 'leafkin' ? 'greet' : hour >= 5 && hour < 10 ? 'morning' : hour >= 18 ? 'evening' : 'greet') : at.ex
  let step = at === null ? 0 : at.step
  if (step >= book[ex].length) {
    ex = nextExchange(mind, ctx, hour, r, ex)
    step = 0
  }
  const alts = book[ex][step].split(' | ')
  const [moment, ids] = pick(alt, alts).split(': ')
  return { moment, only: ids === undefined ? null : ids.split(' '), at: { ex, step: step + 1 } }
}

/** Whether `mind` would come to her unasked: a plea or an errand to give, or a warm, chatty sort with time on their hands. */
export function wantsHer(mind, ctx, r) {
  if (ctx.wants !== null) return true
  const conv = new Conversation(mind, ctx)
  const q = conv.quest
  if (q !== null && q.parent === mind.id && ctx.log.state(q.id) === null) return true
  const m = conv._message('giver')
  if (m !== null && [null, 'delivered'].includes(ctx.log.state(m.id))) return true
  return conv.tone === 'cheery' && r < mind.traits.chattiness * 0.5
}
