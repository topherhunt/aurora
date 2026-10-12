// One conversation as she lives it (_notes/conversation-and-quests.md, "A conversation"): whether they will talk at
// all, how long they will put up with her, and when they send her off. Words come from speak.js; this decides when.
// Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { Conversation, strHash } from './speak.js'
import { OPEN_TOPICS, TOPICS } from './lore.js'
import { LEAFKIN_ATOM } from './lines.js'

export const CHAT = {
  // Questions they will answer before they have had enough: base, plus chattiness and standing (each 0..1) times these.
  patience: { base: 3, chatty: 6, standing: 4 },
  // Per answer, the odds they cut her off early anyway, by tone.
  dismiss: { cheery: 0.02, plain: 0.05, curt: 0.14 },
  // Odds a stranger is turned away while busy, against a fully unchatty temperament.
  busy: 0.85,
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
  /** `ctx` as speak.js Conversation's; `trusted` whether a leafkin trusts her (trust.js), `busy` whether they are about something. */
  constructor(mind, ctx, { trusted = true, busy = false, salt = 0 } = {}) {
    this.mind = mind
    this.conv = new Conversation(mind, ctx)
    this.trusted = trusted
    this.busy = busy
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
    return { ...line, ended: true, alone: CHAT.alone[why] }
  }

  open() {
    const { mind, conv } = this
    const T = mind.traits
    if (mind.kind === 'leafkin' && !this.trusted) return this._end(conv._line('Kee? Hmm-hm.', 'talk-shrug', { moment: 'refuse.wary', mood: 'cold' }), 'declined')
    if (conv._standing() < CHAT.shun) return this._end(conv._line(mind.kind === 'leafkin' ? 'No. Go.' : "I've nothing to say to you.", 'talk-shrug', { moment: 'refuse.wary', mood: 'cold' }), 'declined')
    const opener = conv.opener()
    // A plea or an errand is why they want her; busy or not, they will say it.
    if (opener.quest === undefined && this.busy && this._roll('busy') < CHAT.busy * (1 - T.chattiness)) {
      return this._end(conv._line(mind.kind === 'leafkin' ? 'Busy-busy! Later.' : pick(this._roll('busy-line'), ["Not now, I've work to do.", 'Sorry, I am in a hurry.', 'Another time.']), 'talk-shrug', { moment: 'mood.busy' }), 'declined')
    }
    if (opener.quest !== undefined || this._roll('volunteer') >= CHAT.volunteer * T.chattiness) return opener
    // A chatty one brings something up unasked: a rumour, sometimes of a thing she has never heard of.
    const topics = [...OPEN_TOPICS, ...Object.keys(TOPICS).filter((t) => TOPICS[t].gated)]
    const rumour = conv.say(`lore:${pick(this._roll('rumour'), topics)}`)
    if (rumour.claim === null) return opener
    return { ...opener, text: `${opener.text} ${mind.kind === 'leafkin' ? 'Listen!' : 'Have you heard?'} ${rumour.text}`, unlocks: rumour.unlocks }
  }

  /** Her sentence `topic` (grid.js) answered. */
  ask(topic) {
    if (this.ended) throw new Error(`Chat: ${this.mind.id} has already ended the conversation`)
    if (topic === 'bye') return this._end(this.conv.bye(), 'bye')
    this.turns++
    const line = this.conv.say(topic)
    if (this.turns < this.patience && this._roll('dismiss') >= CHAT.dismiss[this.conv.tone]) return line
    const off = this.mind.kind === 'leafkin' ? 'Leafkin go now.' : pick(this._roll('off'), ["That's enough questions.", 'I must get on.', 'Well. I have things to do.'])
    return this._end({ ...line, text: `${line.text} ${off}` }, 'dismissed')
  }
}

const pick = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]

/**
 * What `mind` says on its `turn` (0 the first) of a chat with a neighbour at `hour`, `r` a roll: a moment (lines.js).
 * The opener leads with gossip; after, they answer by temperament and the time of day, a worried parent of nothing else.
 */
export function chatterMoment(mind, ctx, { turn, hour, r }) {
  const conv = new Conversation(mind, ctx)
  if (conv._worried()) return r < 0.5 ? 'missing.worry' : 'worry.general'
  if (turn === 0) return 'gossip.lead'
  const T = mind.traits
  const cheery = conv.tone === 'cheery'
  const night = hour >= 21 || hour < 5
  const dusk = hour >= 17 && hour < 21
  const weights = [
    ['gossip.react', 3], ['social.agree', 2], ['social.curious', 1 + T.chattiness], ['social.surprise', 1], ['social.disagree', T.wariness * 2],
    ['gossip.lead', T.chattiness * 1.5], ['nv.laugh', cheery ? 2 : 0.3], ['nv.think', 0.8], ['mood.content', cheery ? 1.5 : 0.4], ['mood.bored', cheery ? 0.2 : 1],
    ['observe.dusk', dusk ? 1.5 : 0], ['sky.aurora', night ? 1.5 : 0], ['observe.marvel', night ? 0.5 : 0], ['mood.tired', night ? 1.2 : 0], ['weather.cold', night ? 0.6 : 0], ['talk.town', 0.8],
  ].filter(([m, w]) => w > 0 && (mind.kind !== 'leafkin' || LEAFKIN_ATOM[m] !== undefined))
  let left = r * weights.reduce((s, [, w]) => s + w, 0)
  for (const [m, w] of weights) if ((left -= w) < 0) return m
  return weights[weights.length - 1][0]
}

/** Whether `mind` would come to her unasked: a plea or an errand to give, or a warm, chatty sort with time on their hands. */
export function wantsHer(mind, ctx, r) {
  const conv = new Conversation(mind, ctx)
  const q = conv.quest
  if (q !== null && q.parent === mind.id && ctx.log.state(q.id) === null) return true
  const m = conv._message('giver')
  if (m !== null && [null, 'delivered'].includes(ctx.log.state(m.id))) return true
  return conv.tone === 'cheery' && r < mind.traits.chattiness * 0.5
}
