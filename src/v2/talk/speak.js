// The conversation engine (_notes/conversation-and-quests.md, "How an answer is made"): a topic becomes a fact, the fact passes through what the speaker knows, will share, will admit and gets right, and comes out as a short line in their voice. Lies are rolled per (speaker, fact, epoch) so they hold steady and every client hears the same one; muddles are rolled per ask, so they drift. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { TITLES } from './world.js'
import { MESSAGES } from './quests.js'
import { LORE, TOPICS, knowOdds, expertise, expertBody, beliefOdds, sawOdds } from './lore.js'
import { MANNERS, MOVES, reception, isNight } from './manners.js'
import { LK, lkLine } from './leafkin.js'
import { dress } from './words.js'
import { fits } from './caption.js'
import * as trade from './trade.js'
import { armedRefusal } from './armed.js'
import { QUIRKS, quirkLines } from './quirks.js'

export const SPEAK = {
  // A claimed place within this of the truth is the truth (a told belief, a check).
  same: 8,
  // How far each class has walked the roads, metres: past it a town is unknown.
  reach: { travel: 2500, folk: 1200, guard: 900, child: 300, leafkin: 0 },
  // A lie with no motive is this rare against a fully dishonest temperament.
  idleLie: 0.12,
  // Muddle odds against a fully spacey temperament, per ask.
  muddle: 0.5,
  // A planted belief the listener cannot check is caught with chance wariness times this.
  detect: 0.5,
  // Standing a friend's name lends, or a rival's costs.
  sentBy: 0.3,
  // Standing a witness needs before telling her what they saw of a contested fact (lore.js `seen`): a favour, or kind words over two days.
  confide: 0.3,
}

const TRADE_WORDS = {
  smith: 'work the forge', potions: 'brew potions', inn: 'keep the inn', farm: 'work the farm',
}
const BODY_WORDS = {
  woodcutter: 'cut wood', hunter: 'hunt the woods', miner: 'dig in the hills', fisherman: 'fish', herbalist: 'gather herbs',
  thief: 'come and go', trapper: 'trap in the hills', healer: 'mend the sick', skald: 'sing for my supper',
  guard: 'keep the watch', shieldmaiden: 'keep the watch', jarlsthane: 'look after this town', battlemage: 'keep the peace',
  'child-villager-2': 'play', shepherd: 'mind the sheep',
}
// What a body wants: the items the world already holds.
const WANTS = {
  alchemist: 'red mushrooms', innkeeper: 'fish', farmer: 'eggs', shepherd: 'carrots', herbalist: 'mushrooms', healer: 'mushrooms',
  fisherman: 'butterflies', woodcutter: 'a sharp stick', hunter: 'carrots', leafkin: 'mushrooms',
}

// What a body is called when someone is sent to them: "Ask Edvin the skald", "A trapper would know".
const CALLING = {
  alchemist: 'potion master', herbalist: 'herbalist', healer: 'healer', blacksmith: 'smith', miner: 'miner', hunter: 'hunter', trapper: 'trapper',
  shepherd: 'shepherd', farmer: 'farmer', thief: 'wanderer', skald: 'skald', innkeeper: 'innkeeper', jarlsthane: 'elder',
  guard: 'guard', shieldmaiden: 'shield maiden', battlemage: 'battle mage', woodcutter: 'woodcutter', fisherman: 'fisherman', 'child-villager-2': 'child',
}
// Where a speaker sends her for tall tales: the skald, else a boaster this sure of themself.
const TALE_TELLER = 0.6

// What a body's work brings up in conversation: gated lore topics (lore.js) told of it opens.
const BODY_UNLOCKS = {
  miner: ['ores', 'caves', 'mining'], alchemist: ['mushrooms', 'flares'], herbalist: ['mushrooms', 'eating'], thief: ['gems'], trapper: ['labyrinths', 'yetis', 'spiders'], blacksmith: ['ores', 'weapons', 'mining'], healer: ['eating'],
  guard: ['weapons'], shieldmaiden: ['weapons'], battlemage: ['weapons', 'giants'], jarlsthane: ['weapons'], skald: ['giants'], woodcutter: ['giants'], hunter: ['spiders'], 'child-villager-2': ['giants'],
}
// How each lore topic is asked (grid.js): fragments, the last one punctuated.
const LORE_PATH = {
  striders: ['Tell me about', 'striders.'], dragons: ['Tell me about', 'dragons.'], snowlands: ['Tell me about', 'the snowlands.'], yetis: ['Tell me about', 'yetis.'],
  leafkin: ['Tell me about', 'leafkin.'], caves: ['Tell me about', 'caves.'], labyrinths: ['Tell me about', 'labyrinths.'],
  alchemist: ['What does', 'the alchemist', 'do?'], blacksmith: ['What does', 'the blacksmith', 'do?'],
  coins: ['What are', 'coins', 'good for?'], gems: ['What are', 'gems', 'worth?'], ores: ['What are', 'flint and ores', 'worth?'],
  mushrooms: ['What are', 'mushrooms', 'good for?'], eating: ['Can I eat', 'wild things?'],
  curses: ['Tell me about', 'mushroom curses.'], flares: ['What are', 'flare guns', 'good for?'],
  weapons: ['Tell me about', 'swords and shields.'], mining: ['How do I', 'mine ore?'], spiders: ['Tell me about', 'cave spiders.'], giants: ['Tell me about', 'green giants.'],
  pets: ['Tell me about', 'pets.'], roads: ['Where do', 'the roads go?'],
}

// What a speaker says when they know more of a topic than they will tell her yet, by tone.
const HOLD_BACK = {
  curt: ['Not for strangers.', 'Not to you.', 'That I keep.'],
  cheery: ["There's more I could tell you. Another time, when I know you better.", 'I know more, and gladly, once we are better friends.', 'Come back when we know each other, and I will tell you the rest.'],
  plain: ["There's more to it. But I don't know you well enough.", 'There is more. Not to a stranger, though.', "I could say more, but I don't know you yet."],
}

// Small talk, where a need's story may wander in (`_aside`).
const SMALL_TALK = new Set(['talk:town', 'nice:work', 'nice:life'])
const LEAFKIN_FAR = { "right here": 'here-here', "a stone's throw": 'close', 'a short walk': 'little walk', 'a fair walk': 'far', 'a long walk': 'far-far', 'a long road': 'far-far-far' }

const HE = { he: 'he', him: 'him', his: 'his', He: 'He', His: 'His' }
const SHE = { he: 'she', him: 'her', his: 'her', He: 'She', His: 'Her' }

// Where each wanted item (WANTS) is had, as the world holds it (main.js hands sources, roosts.js eggs).
const FIND = {
  fish: "Wade into a lake or a stream and grab one. They're quick, mind.",
  mushrooms: 'Under the trees, where it stays damp. Mind which ones you eat.',
  'red mushrooms': "The red caps grow in the woods. Don't eat them yourself.",
  carrots: 'Out in the farm fields, along the rows.',
  eggs: 'Up in the dragon roosts on the high peaks. Rather you than me.',
  butterflies: 'Over any meadow, on a fair day.',
  'a sharp stick': 'The woods are full of sticks. Find a good straight one.',
}

/** FNV-1a: a string as a 32-bit int for hash32. */
export function strHash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h | 0
}

const roll = (...parts) => mulberry32(hash32(...parts.map((p) => (typeof p === 'string' ? strHash(p) : p))))()

const pickBy = (r, list) => list[Math.min(list.length - 1, (r * list.length) | 0)]

/** A conversation between her and one person: `menu()` lists the chips, `say(topic)` and `tell(belief)` return lines. */
export class Conversation {
  /** `ctx`: `{ world, rapport, quests (Map id -> quest), log (QuestLog), epoch, from: { x, z }, hour, known (Set of what she has heard of, from anyone: lore topics, and `person:<id>`), pack (count/freeLarge/add/remove/held), wants (the kind of her held item they want, or null), inWorkshop (the smith is at his forge), inShop (the alchemist is at his shop), armed (she holds a sword in a town), wronged (a glade she wronged, trust.js), witness (the leafkin id who saw it, or null) }`, `from` where the speaker stands, `hour` the clock's 0..24. `salt` tells this talk from her others with them. */
  constructor(mind, ctx, salt = 0) {
    if (typeof ctx.hour !== 'number') throw new Error('Conversation: ctx.hour is required')
    for (const m of ['count', 'freeLarge', 'add', 'remove', 'held']) if (typeof ctx.pack?.[m] !== 'function') throw new Error(`Conversation: ctx.pack.${m} is required`)
    if (ctx.wants !== null && typeof ctx.wants !== 'string') throw new Error('Conversation: ctx.wants must be an item kind or null')
    for (const k of ['inWorkshop', 'inShop', 'armed']) if (typeof ctx[k] !== 'boolean') throw new Error(`Conversation: ctx.${k} must be a boolean`)
    if (typeof ctx.wronged !== 'boolean') throw new Error('Conversation: ctx.wronged must be a boolean')
    if (ctx.witness !== null && typeof ctx.witness !== 'string') throw new Error('Conversation: ctx.witness must be an id or null')
    this.mind = mind
    this.ctx = ctx
    this.salt = salt
    this.ask = 0
    // The `ask` their quirk last showed an aside on.
    this.asideAt = -Infinity
    // Ids of those `_sentTo` has sent her to in this talk.
    this.sent = new Set()
    // Chips her questions have opened: topic -> label, in the order heard.
    this.mentions = new Map()
    // What their last line was about (a line's `about`), whose follow-ups lead the menu.
    this.about = []
    // The message quest whose words the speaker has asked her to repeat, or null.
    this.delivering = null
    // Lore told this conversation: topic -> Set of fact ids, so asking again tells another fact.
    this.lore = new Map()
    // Kind words (manners.js): praise and small talk said in a row, whether their last line told her something, whether she has heard their work.
    this.fawn = 0
    this.useful = false
    this.heardWork = false
    // Whether they have listed what they trade (trade.js): their deals then all show as chips.
    this.offered = false
  }

  get leafkin() {
    return this.mind.kind === 'leafkin'
  }

  /** A roll fixed by this speaker, quest epoch and `key`, the same every question and talk that day. */
  _daily(key) {
    return roll(this.mind.id, this.ctx.epoch, key)
  }

  /** A roll fixed by this speaker, talk and question, and `key`. */
  _roll(key, n = 0) {
    return roll(this.mind.id, this.salt, this.ask, key, n)
  }

  /** The text `build(n)` makes for the first attempt `n` that differs from the last wording of `key` they gave her (any talk this session). */
  _fresh(key, build) {
    const worded = this.ctx.rapport.get(this.mind.id).worded
    const last = worded.get(key)
    for (let n = 0; n < 24; n++) {
      const text = build(n)
      if (text !== last) {
        worded.set(key, text)
        return text
      }
    }
    throw new Error(`Conversation: ${this.mind.id} has no second wording for ${key}`)
  }

  /** One of `list` (two or more), never the one they said last for `key`. */
  _pick(key, list) {
    const base = (this._roll(key) * list.length) | 0
    return this._fresh(key, (n) => list[(base + n) % list.length])
  }

  /** A leafkin's wording of line `key` (leafkin.js), never the one they said last. */
  _lk(key, vars = {}) {
    const len = LK[key]?.length
    if (len === undefined) throw new Error(`leafkin: no line ${key}`)
    const base = (this._roll(key) * len) | 0
    return this._fresh(`lk:${key}`, (n) => lkLine(key, ((base + n) % len + 0.5) / len, { name: this.mind.name, ...vars }))
  }

  /** How they come across to her now: 'cheery', 'plain' or 'curt', from kindness, chattiness, wariness and standing. */
  get tone() {
    const T = this.mind.traits
    const t = T.kindness * 0.6 + T.chattiness * 0.6 - T.wariness * 0.5 + this._standing() * 0.8 - (this._worried() ? 0.4 : 0)
    return t > 0.55 ? 'cheery' : t < 0.15 ? 'curt' : 'plain'
  }

  /** A parent whose child is missing has room for nothing else. */
  _worried() {
    const q = this.quest
    return q !== null && q.parent === this.mind.id && this.ctx.log.state(q.id) !== 'done'
  }

  get town() {
    return this.mind.kind === 'human' ? this.ctx.world.townOf(this.mind) : null
  }

  /** The missing child of the speaker's town this epoch, or null. */
  get quest() {
    if (this.town === null) return null
    for (const q of this.ctx.quests.values()) if (q.kind === 'missing-child' && q.town === this.town.index) return q
    return null
  }

  /** The message quest the speaker gives (`role` 'giver') or receives ('to'), or null. */
  _message(role) {
    for (const q of this.ctx.quests.values()) if (q.kind === 'message' && q[role] === this.mind.id) return q
    return null
  }

  /** What she may say: `{ topic, label, path }`, `path` the fragments the dialog grid (grid.js) builds it from. Gated lore shows once she has heard of it (`ctx.known`). */
  menu() {
    if (this.ctx.armed) return [{ topic: 'bye', label: 'Goodbye.', path: ['Goodbye.'] }]
    const nice = this._niceties()
    const chips = [...trade.chips(this), ...this._followUps(), ...nice.lead]
    chips.push(['talk:self', ['Tell me about', 'yourself.']], ['talk:needs', ['Do you', 'need anything?']], ...nice.rest)
    if (!this.leafkin) {
      chips.push(['talk:town', ['Tell me about', 'this town.']], ['where:here', ['Where', 'am I?']], ['where:home', ['Where', 'do you live?']])
      for (const title of Object.keys(TITLES)) chips.push([`where:title:${title}`, ['Where', 'is the', `${title === 'potionmaster' ? 'potion master' : title}?`]])
      if (!trade.isSmith(this.mind)) chips.push(['where:gear', ['Where can I get', 'weapons, armour', 'and gear?']])
    }
    for (const t of Object.keys(TOPICS)) if (!TOPICS[t].gated || this.ctx.known.has(t)) chips.push([`lore:${t}`, LORE_PATH[t]])
    if (!this.leafkin) for (const t of Object.keys(TOPICS)) if (!TOPICS[t].gated || this.ctx.known.has(t)) chips.push([`who:${t}`, ['Who knows', `about ${TOPICS[t].label}?`]])
    const m = this._message('to')
    if (m !== null && this.ctx.log.state(m.id) === 'accepted') {
      if (this.delivering === m.id) for (const k of m.choices) chips.push([`word:${k}:${m.id}`, ['The words were', `"${MESSAGES[m.message][k]}"`]])
      else chips.push([`deliver:${m.id}`, ['I bring word', `from ${this.ctx.world.person(m.giver).name}.`]])
    }
    for (const [topic, label] of this.mentions) chips.push([topic, ['What about', `${label}?`]])
    chips.push(...this._heardOf())
    chips.push(['bye', ['Goodbye.']])
    const seen = new Set()
    return chips.map(([topic, path]) => ({ topic, label: path.join(' '), path })).filter((c) => !seen.has(c.label) && seen.add(c.label))
  }

  /** Kind words she may say now (manners.js): `lead` fits this moment and follows the follow-ups, `rest` follows the everyday chips. */
  _niceties() {
    if (this.leafkin) return { lead: [], rest: [] }
    const { mind } = this
    const lead = []
    if (this.ask === 0) lead.push(['nice:greet', this.ctx.known.has(`person:${mind.id}`) ? ['Good day,', `${mind.name}.`] : ['Good day', 'to you.']])
    if (this.useful) lead.push(['nice:thanks', ['Thank you,', 'that helps.']])
    const sad = this._sadAbout()
    if (sad !== null) lead.push(['nice:sorry', ['I hope', `${sad.name} is found.`]])
    const child = mind.cls === 'child'
    const rest = [['nice:work', child ? ['What are', 'you up to today?'] : ['How is', 'the work going?']]]
    if (!child) rest.push(['nice:life', ['How long have', 'you lived here?']])
    rest.push(['nice:town', ['This is', 'a lovely town.']])
    if (this.heardWork && !child) rest.push(['nice:craft', ['You do', 'fine work.']])
    if (this.ask > 0) rest.push(['nice:leave', ["I won't", 'keep you.']])
    return { lead, rest }
  }

  /** The missing child weighing on them, their own or the one their last line told of, or null. */
  _sadAbout() {
    if (this._worried()) return this.ctx.world.person(this.quest.child)
    const a = this.about.find((x) => x.kind === 'missing')
    return a === undefined ? null : this.ctx.world.person(a.id)
  }

  /** The questions their last line invites, first in the menu so the grid offers them first. */
  _followUps() {
    const { world } = this.ctx
    const out = []
    for (const a of this.about) {
      if (a.kind === 'person') {
        const p = world.person(a.id)
        if (p.id === this.mind.id) continue
        if (a.rel === 'rival') out.push([`why:person:${p.id}`, ["Why don't you", `trust ${p.name}?`]], [`why:person:${p.id}`, ["You don't like", `${p.name}?`]])
        if (a.rel === 'friend') out.push([`why:person:${p.id}`, ['How do you know', `${p.name}?`]])
        if (a.rel === 'neighbour') out.push([`why:person:${p.id}`, ['You don\'t know', `${p.name} well?`]])
        if (!this.leafkin) out.push([`where:person:${p.id}`, ['Where', `is ${p.name}?`]])
        if (a.rel === undefined) out.push([`ask:person:${p.id}`, ['Who is', `${p.name}?`]])
      } else if (a.kind === 'missing') {
        const child = world.person(a.id)
        out.push([`ask:person:${child.id}`, ['Where', a.parent ? `did ${child.name} go?` : `was ${child.name} last seen?`]])
        if (!a.parent) {
          const parent = world.person(this._quest(a.id).parent)
          out.push([`where:person:${parent.id}`, ['Where', `is ${parent.name}?`]])
        }
      } else if (a.kind === 'town' && !this.leafkin) out.push([`where:town:${a.index}`, ['Where', `is ${world.towns[a.index].name}?`]])
      else if (a.kind === 'lore') out.push([`lore:${a.topic}`, a.named ? LORE_PATH[a.topic] : ['Tell me more', `about ${TOPICS[a.topic].label}.`]])
      else if (a.kind === 'want') out.push([`find:${a.item}`, ['Where can I', `find ${a.item}?`]])
    }
    return out
  }

  /** What she may raise of the speaker's townsfolk she has heard of from anyone: the missing child first. */
  _heardOf() {
    const { world, known } = this.ctx
    if (this.town === null) return []
    const q = this.quest
    const out = []
    if (q !== null && q.parent !== this.mind.id && known.has(`person:${q.child}`)) out.push([`ask:person:${q.child}`, ['Where', `was ${world.person(q.child).name} last seen?`]])
    for (const k of known) {
      if (!k.startsWith('person:')) continue
      const p = world.person(k.slice(7))
      if (p.town !== this.mind.town || p.id === this.mind.id) continue
      out.push([`ask:person:${p.id}`, ['What about', `${p.name}?`]])
      if (q === null || p.id !== q.child) out.push([`where:person:${p.id}`, ['Where', `is ${p.name}?`]])
    }
    return out
  }

  /** The people line `about` names, now heard of. */
  _hear(about) {
    for (const a of about) if (a.kind === 'person' || a.kind === 'missing') this.ctx.known.add(`person:${a.id}`)
  }

  _quest(child) {
    for (const q of this.ctx.quests.values()) if (q.child === child) return q
    throw new Error(`Conversation: no quest for ${child}`)
  }

  /** `p`'s pronouns, by the voice their body speaks with. */
  _pr(p) {
    return p.voice.he ? HE : SHE
  }

  _mention(topic, label) {
    if (topic === `ask:person:${this.mind.id}`) return
    if (!this.mentions.has(topic)) this.mentions.set(topic, label)
    if (topic.startsWith('ask:person:')) this.ctx.known.add(topic.slice(4))
  }

  /** Lore topics a line names in passing, as `about`: each a follow-up asked its own way (LORE_PATH). */
  _named(topics) {
    return topics.map((topic) => ({ kind: 'lore', topic, named: true }))
  }

  /** Gated lore topics the speaker just named, now known to her: those not known before. */
  _unlock(topics) {
    const fresh = topics.filter((t) => !this.ctx.known.has(t))
    for (const t of fresh) this.ctx.known.add(t)
    return fresh
  }

  /** Her question `topic` (a chip's topic) answered: `{ text, gesture, toward, claim, mood }`. `plain` leaves the wording undressed (chat.js strips a rumour's tail). */
  say(topic, plain = false) {
    this.ask++
    if (!topic.startsWith('nice:')) this.fawn = 0
    let line = this._say(topic)
    if (this.ctx.wronged && this.leafkin && topic !== 'bye') line = this._furious(line)
    else if (!plain) line = this._dress(topic, line)
    this.about = line.about
    this.useful = line.claim !== null
    this._hear(line.about)
    return line
  }

  /** `line` with a lead-in and their quirk's aside (words.js, quirks.js), not the same as last time for `topic`. Replies that are not information (refusals, pleas, prices, trade) go bare; kind words and goodbyes take an aside but no lead-in. */
  _dress(topic, line) {
    if (line.plain || line.quest !== undefined || line.price || line.mood === 'distress' || line.mood === 'cold' || line.mood === 'angry') return line
    if (/^(bye|shop|trade)\b/.test(topic) || ['refuse.wary', 'refuse.price', 'answer.unknown', 'answer.none', 'answer.spent'].includes(line.moment)) return line
    const aside = this._aside(topic, line)
    const said = aside === '' ? line.text : `${line.text} ${aside}`
    if (topic.startsWith('nice:')) return { ...line, text: said }
    const prefixed = line.how !== undefined && (line.how.again || line.how.changed || line.how.boast)
    // Worded unlike last time when a wording that fits allows it; a long line may come back the same.
    const worded = this.ctx.rapport.get(this.mind.id).worded, key = `say:${topic}`
    let text = said
    for (let n = 0; n < 24; n++) {
      const r = [0, 1, 2, 3, 4, 5].map((i) => this._roll(`dress${i}`, n))
      const t = this.leafkin
        ? `${r[0] < 0.6 && !prefixed ? `${this._leaf('lead', r[1])} ` : ''}${said}${r[2] < 0.3 ? ` ${this._leaf('detail', r[3])}` : ''}${r[4] < 0.3 ? ` ${this._leaf('tail', r[5])}` : ''}`
        : dress(said, this.tone, r, !prefixed)
      if (t !== worded.get(key) && fits(t)) {
        text = t
        break
      }
    }
    worded.set(key, text)
    return { ...line, text }
  }

  /**
   * Their quirk's aside after an answer to `topic`, or ''. A mood (bitter, timid, adoring) may colour an answer that told her something (lore, who, where, ask); a need
   * is a story they tell in order, and comes up only in small talk (SMALL_TALK), where wandering off is natural. Never two
   * answers running, never past the caption, never after bad news, and never while their child is missing.
   */
  _aside(topic, line) {
    const { text } = line
    if (this.leafkin || this._worried() || this.asideAt === this.ask - 1 || line.about.some((a) => a.kind === 'missing')) return ''
    const need = this.mind.quirk.kind === 'need'
    if (need ? !SMALL_TALK.has(topic) : !/^(lore|who|where|ask):/.test(topic)) return ''
    if (this._roll('quirk:aside') >= QUIRKS.odds[need ? 'need' : 'aside']) return ''
    const lines = quirkLines(this.mind.quirk).aside
    const r = this.ctx.rapport.get(this.mind.id)
    const aside = need ? lines[r.quirked % lines.length] : this._pick('quirk:aside', lines)
    if (!fits(`${text} ${aside}`)) return ''
    if (need) r.quirked++
    this.asideAt = this.ask
    return aside
  }

  /** A word from a human's quirk (quirks.js) for `where` ('greet' or 'bye'), or '' when it does not show this time or their child is missing. */
  _quirk(where) {
    if (this.leafkin || this._worried() || this._roll(`quirk:${where}`) >= QUIRKS.odds[where]) return ''
    const lines = quirkLines(this.mind.quirk)[where]
    return lines.length === 1 ? lines[0] : this._pick(`quirk:${where}`, lines)
  }

  /** `text` with their quirk's word for `where` after it, when it shows. */
  _withQuirk(text, where) {
    const q = this._quirk(where)
    return q === '' ? text : `${text} ${q}`
  }

  _leaf(key, r) {
    return lkLine(key, r, {})
  }

  /** A leafkin of a glade she wronged: the one who saw it will say only that, the rest lead their answers with a curse. */
  _furious(line) {
    if (this.ctx.witness === this.mind.id) return this._line(this._lk('furiousWitness'), 'talk-shrug', { mood: 'angry', moment: 'tell.caught', fury: 2, plain: true })
    return { ...line, text: `${this._lk('furiousLead')} ${line.text}`, mood: 'angry', moment: 'tell.caught', fury: 1 }
  }

  _say(topic) {
    const [head, ...rest] = topic.split(':')
    const arg = rest.join(':')
    if (head === 'shop' || head === 'trade') return trade.say(this, head, arg)
    if (head === 'talk') return this._talk(arg)
    if (head === 'where') return this._where(arg)
    if (head === 'ask') return this._askAbout(arg)
    if (head === 'why') return this._why(this.ctx.world.person(arg.slice(7)))
    if (head === 'find') return this._find(arg)
    if (head === 'deliver') return this._deliver(arg, null)
    if (head === 'word') return this._deliver(rest.slice(1).join(':'), Number(rest[0]))
    if (head === 'lore') return this._lore(arg)
    if (head === 'who') return this._who(arg)
    if (head === 'nice') return this._nice(arg)
    if (head === 'bye') return this.bye()
    throw new Error(`Conversation: no topic ${topic}`)
  }

  /** Their parting line: warm or curt by standing and tone. */
  bye() {
    const warm = this._standing() >= 0 && this.tone !== 'curt'
    if (this.leafkin) return this._line(this._lk(warm ? 'byeWarm' : 'byeCurt'), 'wave', { moment: warm ? 'bye.warm' : 'bye.curt' })
    const text = this._withQuirk(warm ? this._pick('bye', ['Safe roads.', 'Take care of yourself.', 'Come back any time.', 'Go well.', 'Until next time.']) : this._pick('bye', ['Right.', 'Well, then.', 'Off you go.', 'Mm.']), 'bye')
    return this._line(text, warm ? 'wave' : 'talk-shrug', { moment: warm ? 'bye.warm' : 'bye.curt', mood: warm ? 'warm' : 'cold', plain: true })
  }

  /** Their refusal to talk to an armed stranger (armed.js), another wording each time. */
  refuseArmed() {
    const text = this._fresh('armed', (n) => armedRefusal(this.mind, (this._roll('armed') + n * 0.6180339887) % 1).text)
    return this._line(text, 'talk-shrug', { mood: 'cold', moment: 'refuse.wary', plain: true })
  }

  /** Their first line, when they hail her or she hails them: a parent with an untaken quest pleads, the rest greet her by how they stand with her. */
  opener() {
    const line = this._opener()
    this.about = line.about
    this._hear(line.about)
    return line
  }

  _opener() {
    const q = this.quest
    if (q !== null && q.parent === this.mind.id && this.ctx.log.state(q.id) === null) return this._plea(q)
    if (this._worried()) {
      const child = this.ctx.world.person(q.child)
      return this._line(`Any word of ${child.name}?`, 'talk-gesture', { mood: 'distress', quest: q.id, moment: 'missing.worry', about: [{ kind: 'missing', id: child.id, parent: true }] })
    }
    const m = this._message('giver')
    if (m !== null && this.ctx.log.state(m.id) === 'delivered') return this._errand(m)
    const s = this._standing()
    if (this.leafkin && this.ctx.wronged) {
      const saw = this.ctx.witness === this.mind.id
      return this._line(this._lk(saw ? 'furiousWitness' : 'furiousGreet'), 'talk-shrug', { mood: 'angry', moment: 'tell.caught', fury: saw ? 2 : 1, plain: true })
    }
    if (s > -0.2) {
      const shop = trade.opener(this)
      if (shop !== null) return shop
    }
    if (this.leafkin) return this._line(this._lk(s > 0.3 ? 'greetFriend' : 'greetCold'), s > 0.3 ? 'wave' : 'talk-shrug', { moment: s > 0.3 ? 'greet.friend' : 'greet.cold' })
    if (s < -0.2) return this._line('You again.', 'talk-shrug', { mood: 'cold', moment: 'greet.cold' })
    if (s > 0.3) return this._greet(this.mind.quirk.kind === 'bitter' ? "Oh. It's you." : 'Good to see you!', 'wave', { mood: 'warm', moment: 'greet.friend' })
    const tone = this.tone
    if (tone === 'curt') return this._greet('What is it?', 'talk-shrug', { moment: 'greet.curt' })
    if (tone === 'cheery') this.ctx.known.add(`person:${this.mind.id}`)
    return this._greet(tone === 'cheery' ? `Well met, stranger! I'm ${this.mind.name}.` : 'Well met, stranger.', 'wave', { moment: 'greet.stranger' })
  }

  /** A greeting with their quirk's word when it shows (a timid start comes first); `quirked` tells chat.js to keep a rumour back. */
  _greet(text, gesture, more) {
    const q = this._quirk('greet')
    const said = q === '' ? text : this.mind.quirk.kind === 'timid' ? `${q} ${text}` : `${text} ${q}`
    return this._line(said, gesture, { ...more, quirked: q !== '' })
  }

  /** A line: `{ text, gesture, toward, claim, mood, moment, unlocks, about }`, `moment` what its voice clip says (lines.js), `about` what it names for follow-ups (`_followUps`). */
  _line(text, gesture = 'talk-gesture', more = {}) {
    if (more.moment === undefined) throw new Error(`Conversation: no voice moment for "${text}"`)
    return { text, gesture, toward: null, claim: null, mood: 'neutral', unlocks: [], about: [], ...more }
  }

  // --- the pipeline ------------------------------------------------------

  /**
   * Fact `f` through the speaker: `{ key, conf, sens, motive, truth, alts, muddle(claim, r), render(claim, how) }`. `conf` is how surely they know it (0 not at all), `sens` how guarded it is, `motive` whether they want it hidden, `alts` false claims a lie or a boast may take, `render` the line for a claim, `how` `{ sure, hedge, boast, again }`.
   */
  _answer(f) {
    const { mind, ctx } = this
    const T = mind.traits
    const r = ctx.rapport.get(mind.id)
    let truth = f.truth
    let conf = f.conf
    // A planted belief stands in for the truth: they pass on what they were told, sure enough.
    if (r.beliefs.has(f.key)) {
      truth = r.beliefs.get(f.key)
      conf = Math.max(conf, 0.7)
    }
    const lieRoll = roll(ctx.world.seed, mind.id, f.key, ctx.epoch, 'lie')
    if (conf === 0) {
      // Not knowing, a boaster makes something up: a tall tale where there is one.
      const made = f.tales?.length > 0 ? f.tales : f.alts
      if (made.length > 0 && roll(ctx.world.seed, mind.id, f.key, ctx.epoch, 'boast') < T.boast * 0.7) {
        return this._claim(f, pickBy(lieRoll, made), { sure: 1, hedge: false, boast: true, again: false })
      }
      return this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' })
    }
    // A stranger stands at 0: public facts (sens 0.15) pass everyone, kin's whereabouts (0.5) stop the wary half.
    const need = f.sens * T.wariness * 2 - 0.4
    if (this._standing() < need) {
      if (T.greed > 0.6 && !f.motive) return this._line(this.leafkin ? this._lk('price') : "What's it worth to you?", 'talk-gesture', { mood: 'cold', price: true, moment: 'refuse.price' })
      return this._line(this._refuse(), 'talk-shrug', { mood: 'cold', moment: 'refuse.wary' })
    }
    const lie = f.alts.length > 0 && lieRoll < (1 - T.honesty) * (f.motive ? 1 : SPEAK.idleLie)
    let claim = lie ? pickBy(roll(lieRoll * 4294967296, 'alt'), f.alts) : truth
    let muddled = false
    if (f.muddle && roll(ctx.world.seed, mind.id, f.key, ctx.epoch, this.ask, 'muddle') < (1 - T.accuracy) * SPEAK.muddle) {
      claim = f.muddle(claim, roll(ctx.world.seed, mind.id, f.key, this.ask, 'how'))
      muddled = true
    }
    const sure = muddled ? conf * 0.6 : conf
    const boast = T.boast > 0.6
    // A place that moved from what they said before is owned up to, so a drifting answer reads as a muddle, not a bug.
    const was = r.said.get(f.key)
    const changed = was !== undefined && claim.x !== undefined && Math.hypot(was.x - claim.x, was.z - claim.z) > SPEAK.same
    const again = !muddled && was !== undefined && !changed
    r.said.set(f.key, claim)
    return this._claim(f, claim, { sure, hedge: !boast && sure < 0.6, boast: boast && (lie || sure < 0.6), again, changed, lie })
  }

  _claim(f, claim, how) {
    const line = f.render(claim, how)
    let text = line.text
    // A poor liar gives themself away in the voice, so never crows in the words.
    const nervous = !how.changed && !how.again && how.lie && this.mind.traits.honesty > 0.6
    // Whole sentences around the answer, which may open with a name or a story's first word, so nothing is lowercased.
    if (how.changed) text = (this.leafkin ? this._lk('changed') : 'Or no, wait. ') + text
    else if (how.again) text = (this.leafkin ? this._lk('again') : this._pick('again', ['Like I said. ', 'Same as before. ', 'As I told you. '])) + text
    else if (how.boast && !nervous) text = (this.leafkin ? this._lk('boast') : pickBy(roll(this.mind.id, this.ask, 'b'), ['Oh, easy. ', 'Ha! Easy. ', 'Everyone knows this. '])) + text
    else if (how.hedge) text = this.leafkin ? this._lk('hedge') + text : `${text} ${pickBy(roll(this.mind.id, this.ask, 'h'), ['I think.', 'If I remember right.', 'Or so I heard.'])}`
    // The clip says what the words open with: a second thought, a repeat, a stammer, a crow, a doubt.
    const moment = how.changed ? 'answer.hedge' : how.again ? 'answer.again' : nervous ? 'answer.nervous' : how.boast ? 'answer.boast' : how.hedge ? 'answer.hedge' : 'answer.sure'
    return { ...this._line(text, line.gesture ?? 'talk-gesture', { moment, about: line.about ?? [] }), toward: line.toward ?? null, claim, how, bare: line.text }
  }

  _standing() {
    const { mind, ctx } = this
    const r = ctx.rapport.get(mind.id)
    let s = ctx.rapport.standing(mind.id)
    if (r.sentBy !== null) {
      const by = ctx.world.people.get(r.sentBy)
      if (by !== undefined && by.town === mind.town) {
        if (mind.friends.includes(by.index) || mind.household.includes(by.index)) s += SPEAK.sentBy
        if (mind.rival === by.index) s -= SPEAK.sentBy
      }
    }
    return s
  }

  _dunno() {
    if (this.leafkin) return this._lk('dunno')
    return this._pick('dunno', ['No idea.', "Couldn't tell you.", 'Never heard of it.', "I wouldn't know.", 'Not a word of it, sorry.'])
  }

  _refuse() {
    if (this.leafkin) return this._lk('refuse')
    return this._pick('refuse', ['Why do you want to know?', "That's not your business.", "I don't know you.", 'Ask someone else.', 'And who are you to ask?'])
  }

  // --- places ------------------------------------------------------------

  /** Which way a place claim `{ x, z }` lies, said while pointing at it: the compass only past a fair walk, where a point is too rough. */
  _there(claim) {
    const w = this.ctx.world.way(this.ctx.from, claim)
    if (this.leafkin) return this._lk('there', { far: LEAFKIN_FAR[w.far] })
    if (w.d < 6) return 'Just here.'
    if (w.d < 25) return 'Just over there.'
    if (w.d < 400) return `That way, ${w.far}.`
    return `Off that way, ${w.dir}. ${cap(w.far)}.`
  }

  /** `text` said pointing at `claim`. */
  _pointing(text, claim) {
    return { text: `${text} ${this._there(claim)}`, gesture: 'talk-point', toward: claim }
  }

  /** A building claim in the speaker's own words: "my house" for theirs. */
  _placeName(claim) {
    return this.town !== null && claim.building === this.mind.home && claim.label !== 'the inn' ? 'my house' : claim.label
  }

  /** Where `p` is to be found, as the speaker puts it: at home or at work by the hour, else wherever the claim says. */
  _personAt(p, claim) {
    const { hour } = this.ctx
    const self = p.id === this.mind.id
    if (this.leafkin) return self ? this._lk('atSelf', { place: claim.label }) : this._lk('atOther', { who: p.name, place: claim.label })
    const pr = self ? null : this._pr(p)
    const late = hour >= 18 || hour < 6
    const home = claim.building !== null && claim.building === p.home
    const lodger = home && claim.label === 'the inn' && p.trade !== 'inn'
    if (self) return lodger ? "I'm lodging at the inn." : home ? "I'm mostly at home." : `I'm mostly at ${claim.label}.`
    if (lodger) return `${pr.He}'s lodging at the inn.`
    if (home) return late ? `${pr.He}'s likely home by now.` : pickBy(roll(this.mind.id, p.id, 'home'), [`Try ${pr.his} house.`, `${pr.He}'ll be about ${pr.his} house.`])
    if (claim.label === 'the smithy') return late ? `${pr.He} works the smithy, if ${pr.he}'s not home.` : `${pr.He}'ll be at the smithy this time of day.`
    return `Try ${this._placeName(claim)}.`
  }

  /** A muddle of a place: its bearing from the speaker swung 45-120 degrees. */
  _swing = (claim, r) => {
    const { from } = this.ctx
    const a = (r < 0.5 ? -1 : 1) * (Math.PI / 4 + (r % 0.5) * 2 * (Math.PI * 0.42))
    const dx = claim.x - from.x, dz = claim.z - from.z
    return { ...claim, x: from.x + dx * Math.cos(a) - dz * Math.sin(a), z: from.z + dx * Math.sin(a) + dz * Math.cos(a) }
  }

  /** How surely the speaker knows a place in town `townIndex` at distance `d` from their own town. */
  _knowsTown(townIndex) {
    const { mind, ctx } = this
    if (mind.kind !== 'human') return 0
    const home = ctx.world.towns[mind.town].town
    if (townIndex === mind.town) return mind.cls === 'child' ? 0.75 : 0.95
    const t = ctx.world.towns[townIndex].town
    const d = Math.hypot(t.x - home.x, t.z - home.z)
    const reach = SPEAK.reach[mind.cls]
    return d >= reach ? 0 : 0.4 + 0.55 * (1 - d / reach)
  }

  /** Every other place in the speaker's town a lie about where `not` is may point to. */
  _otherPlaces(not) {
    const t = this.town
    if (t === null) return []
    return t.town.buildings.map((_, bi) => this.ctx.world.buildingPlace(t, bi)).filter((p) => Math.hypot(p.x - not.x, p.z - not.z) > SPEAK.same)
  }

  /** Where `p` is, `lead` said first (who they are, when she asked by title). */
  _wherePerson(p, lead = '') {
    const place = this.ctx.world.placeOf(p)
    const self = p.id === this.mind.id
    const motive = this._covering(p.id)
    const rel = this._relation(p)
    this._mention(`ask:person:${p.id}`, p.name)
    const line = this._answer({
      key: `where:${p.id}`,
      conf: self ? 1 : this._knowsTown(p.town),
      // Strangers asking after kin get the guard up.
      sens: self ? 0 : rel === 'household' ? 0.5 : 0.15,
      motive,
      truth: place,
      alts: this._otherPlaces(place),
      // A grown neighbour knows their own town's doors; only a child or an outsider gets the way wrong.
      muddle: p.town === this.mind.town && this.mind.cls !== 'child' ? null : this._swing,
      render: (claim) => this._pointing(lead + this._personAt(p, claim), claim),
    })
    return self ? line : { ...line, about: [{ kind: 'person', id: p.id }] }
  }

  _where(arg) {
    const { world } = this.ctx
    if (arg.startsWith('title:')) {
      const title = arg.slice(6)
      const p = world.titled(this.town, title)
      if (p === null) return this._line(`We've no ${title === 'potionmaster' ? 'potion master' : title} here.`, 'talk-shrug', { moment: 'answer.none' })
      if (p.id === this.mind.id) return this._line(this._pick('where:me', ["That's me. You've found me.", "You're looking at me.", 'Me. That would be me.']), 'talk-nod', { moment: 'answer.self' })
      return this._wherePerson(p, `That's ${p.name}. `)
    }
    if (arg.startsWith('person:')) return this._wherePerson(world.person(arg.slice(7)))
    if (arg.startsWith('town:')) return this._whereTown(Number(arg.slice(5)))
    if (arg === 'home') {
      const t = this.town
      const place = world.buildingPlace(t, this.mind.home)
      const lodger = place.label === 'the inn' && this.mind.trade !== 'inn'
      return this._answer({
        key: `where:home:${this.mind.id}`, conf: 1, sens: 0.35, motive: false, truth: lodger ? place : { ...place, label: 'my house' }, alts: [], muddle: null,
        render: (claim) => this._pointing(lodger ? "I'm lodging at the inn." : "That's my house.", claim),
      })
    }
    if (arg === 'here') {
      const { from } = this.ctx
      const here = world.townAt(from.x, from.z)
      const near = world.nearestTown(from.x, from.z, here === null ? null : here.index)
      this._mention(`ask:town:${near.index}`, near.name)
      if (here !== null) {
        const to = { x: near.town.x, z: near.town.z }
        return this._line(`This is ${here.name}. ${near.name} is the next town over. ${this._there(to)}`, 'talk-point', { toward: to, moment: 'answer.sure', about: [{ kind: 'town', index: near.index }] })
      }
      return this._whereTown(near.index, 'Wild country. The nearest town is')
    }
    if (arg === 'gear') return this._gear()
    throw new Error(`Conversation: no where:${arg}`)
  }

  /** Where weapons, armour and gear are had: the smith of the speaker's town, else the nearest town that has one; with the warning that he talks shop only in his workshop. */
  _gear() {
    const { world } = this.ctx
    if (this.leafkin || trade.isSmith(this.mind)) throw new Error(`Conversation: ${this.mind.id} has no gear to point to`)
    let smith = world.titled(this.town, 'smith')
    if (smith === null) {
      const other = world.towns.filter((t) => t.index !== this.town.index && world.titled(t, 'smith') !== null).sort((a, b) => Math.hypot(a.town.x - this.town.x, a.town.z - this.town.z) - Math.hypot(b.town.x - this.town.x, b.town.z - this.town.z))[0]
      if (other === undefined) return this._line(this._pick('gear:none', ['Weapons? No smith that I know of.', 'Gear? I know of nowhere to buy it.', "There's no smith that I've heard of."]), 'talk-shrug', { moment: 'answer.none' })
      return this._whereTown(other.index, 'For weapons and gear, the smith in')
    }
    const line = this._wherePerson(smith, `That's ${this._called(smith)}. `)
    if (line.claim === null) return line
    const pr = this._pr(smith)
    const warn = this._pick('gear:warn', [
      `Only in ${pr.his} workshop, mind. Grumpy elsewhere, and who'd blame ${pr.him}.`,
      `Catch ${pr.him} in the workshop. Grumpy elsewhere. Can't blame ${pr.him}.`,
      `Workshop only, mind. Grumpy anywhere else, and I don't blame ${pr.him}.`,
    ])
    return fits(`${line.text} ${warn}`) ? { ...line, text: `${line.text} ${warn}` } : line
  }

  _whereTown(index, prefix = null) {
    const { world } = this.ctx
    const t = world.towns[index]
    this._mention(`ask:town:${index}`, t.name)
    const truth = { x: t.town.x, z: t.town.z, label: t.name }
    return this._answer({
      key: `where:town:${index}`, conf: this._knowsTown(index), sens: 0, motive: false, truth,
      // A lie about a town points at one of the four nearest others.
      alts: world.towns.filter((o) => o.index !== index).sort((p, q) => Math.hypot(p.town.x - t.town.x, p.town.z - t.town.z) - Math.hypot(q.town.x - t.town.x, q.town.z - t.town.z)).slice(0, 4).map((o) => ({ x: o.town.x, z: o.town.z, label: t.name })),
      muddle: this._swing,
      render: (claim) => this._pointing(this.leafkin ? this._lk('bigFolkNest') : prefix ? `${prefix} ${t.name}.` : `${t.name}?`, claim),
    })
  }

  // --- people ------------------------------------------------------------

  _relation(p) {
    const m = this.mind
    if (p.town !== m.town) return 'stranger'
    if (m.household.includes(p.index)) return 'household'
    if (m.friends.includes(p.index)) return 'friend'
    if (m.rival === p.index) return 'rival'
    return 'neighbour'
  }

  /** Whether the speaker is hiding a missing child, and so lies about where it is. */
  _covering(id) {
    for (const q of this.ctx.quests.values()) if (q.child === id && q.covers.includes(this.mind.id)) return true
    return false
  }

  _work(p) {
    return TRADE_WORDS[p.trade] ?? BODY_WORDS[p.body] ?? 'get by'
  }

  _talk(arg) {
    const { mind, ctx } = this
    const T = mind.traits
    const r = roll(mind.id, this.ask, 'talk')
    if (arg === 'self') {
      if (this.leafkin) return this._line(this._lk('self'), 'talk-nod', { moment: 'talk.self', unlocks: this._unlock(['mushrooms']), about: this._named(['mushrooms']) })
      if (this._standing() < T.wariness - 0.85) return this._line(this._refuse(), 'talk-shrug', { mood: 'cold', moment: 'refuse.wary' })
      let text = `I'm ${mind.name}. I ${this._work(mind)}.`
      ctx.known.add(`person:${mind.id}`)
      this.heardWork = true
      const trade = BODY_UNLOCKS[mind.body] ?? []
      const unlocks = this._unlock(trade)
      // A parent whose child is missing has no room for their quirk.
      const quirk = this._worried() ? '' : ` ${quirkLines(mind.quirk).self}`
      if (this.tone === 'curt') return this._line(`${text}${quirk}`, 'talk-gesture', { moment: 'talk.self', unlocks, about: this._named(trade) })
      const about = this._named(trade)
      // Who they live with, a friend, a rival: each said while the line still fits the caption.
      const kin = mind.household.map((i) => this.town.minds[i])
      const more = []
      if (kin.length > 0) more.push({ say: ` I live with ${kin.map((k) => k.name).join(' and ')}.`, named: kin })
      if (T.chattiness > 0.55 && mind.friends.length > 0) {
        const f = this.town.minds[pickBy(r, mind.friends)]
        more.push({ say: ` ${f.name} and I go way back.`, named: [f], rel: 'friend' })
      }
      if (T.chattiness > 0.65 && mind.rival !== null) {
        const o = this.town.minds[mind.rival]
        more.push({ say: ` Don't get me started on ${o.name}.`, named: [o], rel: 'rival' })
      }
      for (const m of more) {
        if (!fits(`${text}${m.say}${quirk}`)) continue
        text += m.say
        for (const k of m.named) {
          this._mention(`ask:person:${k.id}`, k.name)
          if (m.rel !== undefined) about.push({ kind: 'person', id: k.id, rel: m.rel })
        }
      }
      return this._line(`${text}${quirk}`, 'talk-gesture', { moment: 'talk.self', unlocks, about })
    }
    if (arg === 'town') {
      const t = this.town
      const shops = ['smith', 'inn', 'potions'].filter((k) => t.town.buildings.some((b) => b.trade === k) || (k === 'smith' && t.minds.some((m) => m.trade === 'smith')))
      let text = `This is ${t.name}.`
      if (shops.length > 0) text += ` We've ${shops.map((k) => ({ smith: 'a smithy', inn: 'an inn', potions: 'a potion shop' })[k]).join(', ')}.`
      const about = []
      const q = this.quest
      if (T.chattiness > 0.5) {
        const near = ctx.world.nearestTown(t.town.x, t.town.z, t.index)
        if (this._knowsTown(near.index) > 0) {
          text += ` ${near.name} is the next town over.`
          this._mention(`ask:town:${near.index}`, near.name)
          about.push({ kind: 'town', index: near.index })
        }
      }
      // Bad news travels, told last: anyone in town may bring up the missing child, the chattier the likelier.
      if (q !== null && q.parent !== mind.id && r < 0.3 + T.chattiness * 0.6) {
        const parent = ctx.world.person(q.parent)
        const child = ctx.world.person(q.child)
        text += ` ${parent.name}'s ${child.name} has gone missing, poor thing.`
        this._mention(`ask:person:${parent.id}`, parent.name)
        this._mention(`ask:person:${child.id}`, child.name)
        about.push({ kind: 'missing', id: child.id })
      }
      // A traveller tells the town as a fact, not as their home.
      return this._line(text, 'talk-gesture', { moment: mind.cls === 'travel' ? 'answer.sure' : 'talk.town', about })
    }
    if (arg === 'needs') {
      const line = this._needs()
      if (this.leafkin || !this._warmBy('help') || line.mood !== 'neutral') return line
      return { ...line, mood: 'warm' }
    }
    throw new Error(`Conversation: no talk:${arg}`)
  }

  _needs() {
    const { mind, ctx } = this
    const q = this.quest
    if (q !== null && q.parent === mind.id && ctx.log.state(q.id) !== 'done') return ctx.log.state(q.id) === null ? this._plea(q) : this._lastSeen(q)
    const m = this._message('giver')
    if (m !== null && [null, 'accepted', 'delivered'].includes(ctx.log.state(m.id))) return this._errand(m)
    const wish = this.wish()
    if (wish !== null) return wish
    const want = this.leafkin ? null : quirkLines(mind.quirk).want
    if (want !== null) return this._line(want, 'talk-gesture', { moment: 'needs.yes' })
    return this._line(this.leafkin ? this._lk('needsNo') : this._pick('needsNo', ["I'm all right, thank you.", 'Nothing, thank you.', 'I have all I need.', 'Not a thing, but thank you for asking.', 'I manage. Thank you.']), 'talk-nod', { moment: 'needs.no' })
  }

  /** Move `move` of manners.js said to them: its warmth applied, and their reply, warm and nodding when it lands. Praise and small talk past MANNERS.fawn in a row reads as buttering up. */
  _nice(move) {
    if (MOVES[move] === undefined) throw new Error(`Conversation: no nicety ${move}`)
    if (MOVES[move].fawns && ++this.fawn >= MANNERS.fawn) {
      this.ctx.rapport.warm(this.mind.id, MANNERS.sour)
      return this._line(this._pick('nice:thick', ["You're laying it on a bit thick.", 'That is a lot of sugar.', 'Steady on with the flattery.', 'You can stop buttering me up now.', 'All this talk. What do you want?']), 'talk-shrug', { mood: 'cold', moment: 'social.disagree' })
    }
    const high = this._warmBy(move)
    const [text, moment] = this._niceReply(move, high || this.tone === 'cheery')
    return this._line(text, high ? 'talk-nod' : 'talk-gesture', { mood: high ? 'warm' : 'neutral', moment })
  }

  /** The warmth `move` earns now, applied: its base times their reception, less each saying this epoch, within the epoch's cap. True when it showed. */
  _warmBy(move) {
    const { mind, ctx } = this
    const words = ctx.rapport.words(mind.id, ctx.epoch)
    const n = words.used.get(move) ?? 0
    words.used.set(move, n + 1)
    const k = reception(mind, move, { worried: this._worried(), night: isNight(ctx.hour), standing: this._standing() })
    const gain = Math.min(MOVES[move].base * k * MANNERS.repeat[Math.min(n, MANNERS.repeat.length - 1)], MANNERS.cap - words.gained)
    words.gained += gain
    ctx.rapport.warm(mind.id, gain)
    return gain >= MOVES[move].base * MANNERS.shows
  }

  /** Their reply to `move`, `high` when it landed or they are cheery anyway: `[text, moment]`, never the wording they gave this move last. */
  _niceReply(move, high) {
    const { mind } = this
    const travel = mind.cls === 'travel'
    const say = (pool, moment) => [this._pick(`nice:${move}`, pool), moment]
    if (move === 'greet') return say(high ? ['And a good day to you!', 'Good day to you too!', 'A fine day to you, friend.', 'Well, hello!', 'Good day, and welcome.'] : ['Good day.', 'Day.', 'Aye, good day.', 'Hello.', 'Morning enough.'], 'greet.stranger')
    if (move === 'thanks') return say(high ? ['Glad to be of use.', 'Happy to help.', 'Any time.', 'It was nothing.', 'You are most welcome.'] : ['Mm.', 'Aye.', 'Think nothing of it.', 'Mm-hm.', 'Hm.'], high ? 'social.welcome' : 'social.ack')
    if (move === 'work') {
      this.heardWork = true
      if (mind.cls === 'child') return say(high ? ['Playing! It is the best day.', 'Playing! Want to join?', 'I play all day. Nobody stops me!', 'Playing, and I am winning.', 'Playing! It is never boring.'] : ['Nothing.', 'Playing.', 'Not much.', 'Just playing.', 'Nothing much.'], 'talk.self')
      const work = this._work(mind)
      return say(high ? [`Busy enough. I ${work}, and I like it.`, `I ${work}. There are worse ways to spend a day.`, `Oh, I ${work}. It keeps me going.`, `I ${work}, mostly. I can't complain.`, `Same as ever: I ${work}.`] : ['It gets done.', 'Work is work.', 'Same as ever.', 'It pays.', 'Keeps me busy.'], 'talk.self')
    }
    if (move === 'life') {
      if (travel) return say(high ? ['I come and go. Here a while, then on down the road.', 'Here a while, then gone again. That is my life.', 'I never stay long. The road calls.', 'A bit of everywhere, really. Never long in one place.', 'Always on the move. I like it that way.'] : ['Not long.', 'Passing through.', 'Not long at all.', 'Just passing.', 'A while.'], 'talk.self')
      return say(high ? [`All my life. ${this.town.name} is home.`, `Born here. ${this.town.name} is all I know, and I like it.`, `Since I was small. ${this.town.name} is home.`, `Always. I would not live anywhere but ${this.town.name}.`, `A lifetime. ${this.town.name} has been good to me.`] : ['Long enough.', 'A good while.', 'Always, near enough.', 'Years.', 'Long enough to know it.'], 'talk.home')
    }
    if (move === 'town') {
      if (travel) return say(high ? ["It's a fair place to rest, I'll give it that.", 'A decent place. Good beds, I hear.', 'Friendly enough. I could stay a night.', "Not bad, for a stop on the road.", 'Pleasant. Fair people here.'] : ["It's not my town.", 'Not mine to judge.', 'I only pass through.', "It's a town.", 'Ask a local.'], high ? 'mood.content' : 'social.ack')
      return say(high ? [`We're proud of ${this.town.name}.`, `${this.town.name} is the best place there is.`, `We do well here, in ${this.town.name}. Thank you for saying.`, `It's a good town, ${this.town.name}. Good folk.`, `${this.town.name} has its charms, and we love it.`] : ["It's all right.", 'It does.', 'Well enough.', 'It has its faults.', 'Not bad.'], 'talk.town')
    }
    if (move === 'craft') return say(high ? ['Ha! Someone noticed.', 'You have a keen eye. Thank you!', 'Kind of you to say. I worked hard on it.', 'Well! That is good to hear.', 'Oh, thank you. It does me good to hear it.'] : ["It's only work.", 'Mm. It does the job.', 'Plain work, that.', 'It will do.', 'Hm. Thanks.'], high ? 'nv.laugh' : 'social.ack')
    if (move === 'sorry') {
      if (this._worried()) return say(high ? [`Thank you. I just want ${this._sadAbout().name} home.`, `You're kind. All I want is ${this._sadAbout().name} back.`, `Thank you. Every hour without ${this._sadAbout().name} is a year.`, `Bless you. I only want ${this._sadAbout().name} home safe.`, `That means a lot. Please, help me find ${this._sadAbout().name}.`] : ['Mm. Thank you.', 'Thank you.', 'Mm. Thanks.', 'Thank you, truly.', 'I know. Thank you.'], 'give.polite')
      return say(high ? ['Aye. A hard business.', 'Aye, it is hard. Thank you.', 'It is. A bad time for everyone.', 'Aye. We carry on.', 'A hard business, truly.'] : ['Aye.', 'Mm.', 'Aye, it is.', 'It is.', 'So it is.'], high ? 'social.agree' : 'social.ack')
    }
    if (move === 'leave') return say(high ? ['Kind of you. Go well.', 'Thank you. Safe roads.', 'Go well, then. Come back soon.', 'Of course. Go well.', 'Take care out there.'] : ['Oh, already? Well, go well.', 'Off already? Go well.', 'Right. Go well.', 'Well, mind how you go.', 'Mm. Go well, then.'], 'bye.warm')
    throw new Error(`Conversation: no reply for ${move}`)
  }

  /** A busy speaker's brush-off that sends her to someone chattier and says where to find them, or null when nobody in town fits: the smith at his forge, the innkeeper, or the most talkative soul, never themself. */
  passOn() {
    if (this.leafkin) return null
    const { world } = this.ctx
    const T = this.mind.traits
    const others = this.town.minds.filter((m) => m.id !== this.mind.id && m.cls !== 'child')
    const smith = others.find((m) => trade.isSmith(m) && world.placeOf(m).label === 'the smithy')
    const inn = others.find((m) => m.body === 'innkeeper')
    const chatty = others.filter((m) => m.traits.chattiness > T.chattiness).sort((a, b) => b.traits.chattiness - a.traits.chattiness || a.index - b.index)[0]
    const cands = [smith, inn, chatty].filter((m, i, all) => m !== undefined && all.indexOf(m) === i)
    if (cands.length === 0) return null
    const p = cands[Math.min(cands.length - 1, (this._roll('passon') * cands.length) | 0)]
    const claim = world.placeOf(p)
    this._mention(`ask:person:${p.id}`, p.name)
    const brush = this._pick('passon:brush', ["Not now, I've work to do.", 'Sorry, I am in a hurry.', "I can't stop."])
    const who = this._called(p)
    // The smith is grumpy away from his anvil and the innkeeper hears the news; only the chattiest is sold as chatty.
    const lead = p === smith ? this._pick('passon:smith', [`Try ${who}.`, `Ask ${who}.`])
      : p === inn ? this._pick('passon:inn', [`${who} hears all the news. Ask there.`, `Try ${who}. Innkeepers know everything.`])
      : this._pick('passon:lead', [`${who} is more the talking sort.`, `Try ${who}, who always has time for a chat.`, `${who} loves to talk. Ask there.`, `If it's talk you want, ${who} is your sort.`])
    const at = this._pointing(`${brush} ${lead} ${this._personAt(p, claim)}`, claim)
    return this._line(at.text, at.gesture, { toward: claim, claim, moment: 'mood.busy', plain: true, about: [{ kind: 'person', id: p.id }] })
  }

  /** What they would like of her (WANTS), or null: a kindly sort asks nothing. */
  get want() {
    const want = WANTS[this.mind.body]
    return want === undefined || this.mind.traits.kindness > 0.75 ? null : want
  }

  /** Their wish told to her, or null. */
  wish() {
    const want = this.want
    if (want === null) return null
    const topics = /mushroom/.test(want) ? ['mushrooms'] : []
    const some = want.startsWith('a ') ? want : `some ${want}`
    const text = this.leafkin ? this._lk('want', { want }) : this._pick('wish', [`I could use ${some}, if you come by any.`, `If you come by ${some}, I'd take it off your hands.`, `I'm short of ${some}, if you see any.`])
    return this._line(text, 'talk-gesture', { want, moment: 'needs.yes', unlocks: this._unlock(topics), about: [{ kind: 'want', item: want }, ...this._named(topics)] })
  }

  /** The town's bad news, told plainly to her unasked, or null: a missing child not their own. */
  news() {
    const q = this.quest
    if (q === null || q.parent === this.mind.id || this.ctx.log.state(q.id) === 'done') return null
    const { world } = this.ctx
    const parent = world.person(q.parent)
    const child = world.person(q.child)
    this._mention(`ask:person:${child.id}`, child.name)
    const pr = this._pr(parent)
    return this._line(`Have you heard? ${parent.name}'s ${child.name} has gone missing. ${pr.He}'s beside ${pr.him}self.`, 'talk-gesture', { moment: 'gossip.lead', about: [{ kind: 'missing', id: child.id }] })
  }

  /** The parent's plea; answering it accepts the quest. */
  _plea(q) {
    const { world, log } = this.ctx
    const child = world.person(q.child)
    this._mention(`ask:person:${child.id}`, child.name)
    log.accept(q)
    const text = `Please, my ${child.name} is missing! Have you seen ${this._pr(child).him}?`
    const about = [{ kind: 'missing', id: child.id, parent: true }]
    if (q.opening === 'direction') return this._line(`Please, my ${child.name} is missing! Someone saw ${this._pr(child).him} heading off. ${this._there(q.where)} Have you seen ${this._pr(child).him}?`, 'talk-point', { mood: 'distress', toward: q.where, quest: q.id, moment: 'missing.plea', about })
    return this._line(text, 'beckon', { mood: 'distress', quest: q.id, moment: 'missing.plea', about })
  }

  /** The parent, asked again once she has taken the search on: what little they know. */
  _lastSeen(q) {
    const child = this.ctx.world.person(q.child)
    if (q.opening === 'direction') return this._line(`${child.name} was last seen going off alone. ${this._there(q.where)} Please hurry.`, 'talk-point', { mood: 'distress', toward: q.where, quest: q.id, moment: 'missing.worry' })
    return this._line(`${child.name} was here this morning, then gone. Ask around, someone must have seen ${this._pr(child).him}.`, 'talk-shrug', { mood: 'distress', quest: q.id, moment: 'missing.worry' })
  }

  /** The parent, asked of other things while their child is missing, turning her back to the search. */
  urge(q) {
    const child = this.ctx.world.person(q.child)
    const pr = this._pr(child)
    this.ask++
    const text = pickBy(roll(this.mind.id, this.ask, 'urge'), [`I can't think of that now. Please, find ${child.name}.`, `Not now, please. ${child.name}'s out there somewhere.`, `Please, just ask around for ${pr.him}.`])
    this.about = [{ kind: 'missing', id: child.id, parent: true }]
    return this._line(text, 'beckon', { mood: 'distress', quest: q.id, moment: 'missing.worry', about: this.about })
  }

  /** The sender's side of a message: the ask (which accepts it), a reminder, or thanks once it is delivered. A garbled message they never hear of. */
  _errand(m) {
    const { world, log, rapport } = this.ctx
    const to = world.person(m.to)
    const town = world.townOf(to)
    const words = MESSAGES[m.message][0]
    this._mention(`ask:person:${to.id}`, to.name)
    this._mention(`ask:town:${town.index}`, town.name)
    const state = log.state(m.id)
    if (state === 'delivered') {
      log.set(m.id, 'done')
      rapport.owe(this.mind.id, 0.3)
      rapport.warm(this.mind.id, 0.2)
      return this._line(`You told ${to.name}? Thank you. I won't forget it.`, 'talk-nod', { mood: 'warm', quest: m.id, moment: 'give.thanks' })
    }
    const about = [{ kind: 'town', index: town.index }]
    if (state === 'accepted') return this._line(`Have you seen ${to.name} yet? Remember: "${words}"`, 'talk-nod', { quest: m.id, moment: 'errand.ask', about })
    log.accept(m)
    return this._line(`Would you carry word to ${to.name} in ${town.name}? ${to.name} is ${m.bond}. Tell ${this._pr(to).him}: "${words}" Those words exactly.`, 'talk-gesture', { quest: m.id, moment: 'errand.ask', about })
  }

  /** The recipient's side: with `k` null they ask what was said; else she answers with phrasing `k` of MESSAGES. */
  _deliver(id, k) {
    const { world, log, rapport } = this.ctx
    const m = this._message('to')
    if (m === null || m.id !== id || log.state(m.id) !== 'accepted') throw new Error(`Conversation: ${this.mind.id} awaits no word ${id}`)
    const giver = world.person(m.giver)
    if (k === null) {
      this.delivering = m.id
      return this._line(`Word from ${giver.name}? What did ${giver.name} say?`, 'talk-nod', { moment: 'errand.recall' })
    }
    this.delivering = null
    const words = MESSAGES[m.message][k]
    if (k === 0) {
      log.set(m.id, 'delivered')
      rapport.warm(this.mind.id, 0.25)
      rapport.owe(this.mind.id, 0.2)
      return this._line(`"${words}" Oh... Thank you for carrying that all this way.`, 'talk-nod', { mood: 'warm', quest: m.id, moment: 'errand.true' })
    }
    log.set(m.id, 'garbled')
    rapport.warm(this.mind.id, -0.15)
    return this._line(`"${words.slice(0, -1)}"? That can't be right. ${giver.name} would never say that.`, 'talk-shrug', { mood: 'cold', quest: m.id, moment: 'errand.garbled' })
  }

  _askAbout(arg) {
    const { world } = this.ctx
    if (arg.startsWith('town:')) return this._whereTown(Number(arg.slice(5)))
    if (!arg.startsWith('person:')) throw new Error(`Conversation: no ask:${arg}`)
    const p = world.person(arg.slice(7))
    const q = [...this.ctx.quests.values()].find((x) => x.child === p.id)
    if (q !== undefined) return q.parent !== this.mind.id ? this._missing(q, p) : this.ctx.log.state(q.id) === null ? this._plea(q) : this._lastSeen(q)
    const rel = this._relation(p)
    if (p.id === this.mind.id) return this._talk('self')
    if (rel === 'stranger') return this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' })
    const pr = this._pr(p)
    const opinion = {
      household: `${p.name}? We share a roof.`,
      friend: `${p.name}'s a good sort.`,
      rival: `${p.name}? Don't trust a word ${pr.he} says.`,
      neighbour: pickBy(roll(this.ctx.world.seed, this.mind.id, p.id, 'opinion'), [`${p.name}? Keeps to ${pr.him}self.`, `${p.name}? Quiet sort.`, `${p.name}? I know ${pr.him} to nod to.`]),
    }[rel]
    const where = this._wherePerson(p)
    const about = [{ kind: 'person', id: p.id, rel }]
    if (where.claim === null) return { ...where, text: `${opinion} ${where.text}`, about }
    // "Like I said" or "Oh, easy" cannot sit mid-line after news of them, so the place is said bare and the voice muses.
    const plain = !where.how.changed && !where.how.hedge && where.moment !== 'answer.nervous'
    const at = plain ? where.bare : where.text
    return { ...where, text: `${opinion} ${pr.He} ${third(this._work(p))}. ${at}`, about, how: { ...where.how, again: false, boast: false }, moment: plain ? 'answer.muse' : where.moment }
  }

  /** Why the speaker feels as they do about `p`: a story seeded per pair, so it holds. */
  _why(p) {
    const rel = this._relation(p)
    if (rel === 'stranger') return this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' })
    const pr = this._pr(p)
    const r = roll(this.ctx.world.seed, this.mind.id, p.id, 'why')
    const text = pickBy(r, {
      rival: [`${pr.He} moved the fence onto my land and swears it was always there.`, `${pr.He} owes me silver from two winters back and acts like ${pr.he} doesn't.`, `${pr.He} sold me a lame goat at market and laughed about it after.`],
      friend: [`We grew up together. ${pr.He}'d give you ${pr.his} last crust.`, `${pr.He} saw my family through a hard winter. I don't forget that.`, `We've fished the same lake since we were children.`],
      neighbour: [`Not really. ${pr.He} nods, I nod, and that's about it.`, `${pr.He} keeps ${pr.his} door shut. Nothing wrong with that.`],
      household: [`${pr.He} lives under my roof. I'd hope I know ${pr.him}.`],
    }[rel])
    return this._line(`${p.name}? ${text}`, rel === 'rival' ? 'talk-shrug' : 'talk-nod', { moment: rel === 'rival' ? 'nv.sigh' : 'answer.muse', about: [{ kind: 'person', id: p.id, rel: 'told' }] })
  }

  /** Where `item` (a WANTS item) is had. */
  _find(item) {
    const text = this.leafkin ? this._lk(`find ${item}`) : FIND[item]
    if (text === undefined) throw new Error(`Conversation: no find ${item}`)
    const topics = /mushroom/.test(item) ? ['mushrooms'] : []
    return this._line(text, 'talk-gesture', { moment: 'answer.sure', unlocks: this._unlock(topics), about: this._named(topics) })
  }

  /** What the speaker says of a missing child: a witness's clue, a coverer's lie, or nothing. */
  _missing(q, child) {
    const { world } = this.ctx
    const seen = q.witnesses.find((w) => w.who === this.mind.id)
    const alts = this._otherPlaces(q.where).filter((p) => p.building !== q.where.building)
    if (q.covers.includes(this.mind.id)) {
      return this._answer({
        key: `${q.id}:where`, conf: 1, sens: 0.6, motive: true, truth: q.where, alts, muddle: null,
        render: (claim) => (claim === q.where ? { text: `All right... ${child.name} is safe, here with us. Don't tell anyone.`, gesture: 'talk-nod' } : this._pointing(`${child.name}? Haven't seen ${this._pr(child).him}. Try ${this._placeName(claim)}.`, claim)),
      })
    }
    if (seen === undefined) return this._line(`${child.name}? I haven't seen ${this._pr(child).him} today.`, 'talk-shrug', { moment: 'answer.none' })
    const c = seen.clue
    if (c.with !== undefined) {
      const host = world.person(c.with)
      this._mention(`ask:person:${host.id}`, host.name)
    }
    return this._answer({
      key: `${q.id}:where`, conf: c.conf, sens: 0.1, motive: false, truth: { x: c.x, z: c.z, label: c.label }, alts, muddle: this._swing,
      render: (claim) => {
        if (c.kind === 'with') return { text: `I saw ${child.name} with ${world.person(c.with).name} earlier.`, gesture: 'talk-gesture', about: [{ kind: 'person', id: c.with }] }
        return this._pointing(`${c.kind === 'heard' ? `Someone said ${child.name} went` : `I saw ${child.name} go`} toward ${claim.label}.`, claim)
      },
    })
  }

  // --- lore --------------------------------------------------------------

  /** A fact of lore `topic` (lore.js), another each time she asks: the next one they know (true, or a lie), else a tall tale or a shrug that sends her to whoever in town knows best. A leafkin tells only what it has words for. */
  _lore(topic) {
    const { mind, ctx } = this
    if (LORE[topic] === undefined) throw new Error(`Conversation: no lore ${topic}`)
    const home = !this.leafkin && this.mind.town === this.ctx.world.deer.town
    const facts = (this.leafkin ? LORE[topic].filter((x) => x.lk !== null) : LORE[topic]).filter((x) => x.at === null || (x.at === 'home') === home)
    if (facts.length === 0) return this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' })
    if (!this.lore.has(topic)) this.lore.set(topic, new Set())
    const told = this.lore.get(topic)
    const start = (roll(ctx.world.seed, mind.id, topic) * facts.length) | 0
    const ring = facts.map((_, i) => facts[(start + i) % facts.length])
    const knows = (f) => roll(ctx.world.seed, mind.id, 'lore', topic, f.id) < knowOdds(mind, topic, f)
    const trusts = (f) => this._standing() >= f.trust
    let fact = ring.find((f) => !told.has(f.id) && knows(f) && trusts(f))
    if (fact === undefined && ring.some((f) => !told.has(f.id) && knows(f))) return this._holdsBack(topic)
    if (fact === undefined && told.size > 0) {
      if (!this.leafkin) return this._referred(this._line(this._pick(`lore:${topic}:done`, [`That's all I know of ${TOPICS[topic].label}.`, `I have told you all I know of ${TOPICS[topic].label}.`, `There's nothing more I can say of ${TOPICS[topic].label}.`, `Of ${TOPICS[topic].label}, that is the lot.`, `You have had everything I know of ${TOPICS[topic].label}.`]), 'talk-shrug', { moment: 'answer.spent' }), topic)
      told.clear()
      fact = ring.find((f) => knows(f) && trusts(f))
    }
    const known = fact !== undefined
    // Not knowing, a boaster may make up a tale, but never one of a fact they would not yet tell her.
    if (!known) fact = ring.find(trusts)
    if (fact === undefined) return this._referred(this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' }), topic)
    told.add(fact.id)
    const odds = knowOdds(mind, topic, fact)
    const line = this._answer({
      key: `lore:${topic}:${fact.id}`, conf: known ? 0.35 + 0.6 * odds : 0, sens: fact.sens, motive: false,
      truth: this.leafkin ? pickBy(roll(mind.id, this.salt, this.ask, fact.id), fact.lk) : fact.doubt.length > 0 ? this._stance(topic, fact) : fact.truth, alts: this.leafkin ? [] : fact.lies, tales: this.leafkin ? [] : fact.tales, muddle: null,
      // A curt speaker gives the first sentence only.
      render: (claim) => this._loreLine(claim, topic, fact),
    })
    if (line.claim !== null) {
      const told = { ...line, unlocks: this._unlock(fact.unlocks) }
      return fact.doubt.includes(line.claim) ? this._talesTo(told) : told
    }
    return line.moment === 'answer.unknown' ? this._referred(line, topic) : line
  }

  /** The line for `claim` of `fact`: toned, with the deer's `{town}` and `{owner}` filled in and the way to the town pointed out. */
  _loreLine(claim, topic, fact) {
    const { world } = this.ctx
    const named = claim.replace(/\{owner\}/g, world.person(world.deer.owner).name).replace(/\{town\}/g, world.towns[world.deer.town].name)
    const text = this.tone === 'curt' ? named.replace(/^([^.!?]*[.!?]).*$/, '$1') : named
    const about = [{ kind: 'lore', topic }, ...this._named(fact.unlocks)]
    if (!claim.includes('{town}')) return { text, gesture: 'talk-gesture', about }
    const t = world.towns[world.deer.town]
    this._mention(`ask:town:${t.index}`, t.name)
    return { ...this._pointing(text, { x: t.town.x, z: t.town.z, label: t.name }), about: [...about, { kind: 'town', index: t.index }] }
  }

  /** They know more of `topic` than they will tell her yet (lore.js `trust`), and say so, so she knows to win them over. */
  _holdsBack(topic) {
    const tone = this.tone
    const text = this.leafkin ? this._lk('holdBack') : this._pick('holdback', HOLD_BACK[tone])
    return this._line(text, 'talk-shrug', { moment: 'refuse.wary', about: [{ kind: 'lore', topic }] })
  }

  /** Contested `fact` as the speaker holds it: their own sighting if they saw it and trust her, a scoff if they do not believe it, else the fact as they heard it. */
  _stance(topic, fact) {
    const b = this._belief(fact.of ?? topic, topic)
    if (b.saw && fact.seen !== null && this._standing() >= SPEAK.confide) return fact.seen
    return b.doubts ? pickBy(roll(this.ctx.world.seed, this.mind.id, 'stance', topic, fact.id), fact.doubt) : fact.truth
  }

  /** How the speaker holds contested subject `of` (lore.js `of`), whose expertise is `topic`'s: `{ saw, doubts }`, one view however it comes up. */
  _belief(of, topic) {
    const r = (k) => roll(this.ctx.world.seed, this.mind.id, 'stance', of, k)
    const saw = r('saw') < sawOdds(this.mind, topic)
    return { saw, doubts: !saw && r('believe') >= beliefOdds(this.mind, topic) }
  }

  /** A speaker friendly enough to send her on to someone else. */
  _helpful() {
    return this.tone !== 'curt' && this._standing() >= 0
  }

  /** `line` (a shrug) with, from a helpful speaker, who would know `topic`. */
  _referred(line, topic) {
    if (this.leafkin || !this._helpful()) return line
    const to = this._sentTo(topic)
    return to === null ? line : { ...line, text: `${line.text} ${to.text}`, about: to.about }
  }

  /** Who would know `topic`, as `{ text, about }`: the town's expert by name (where they are is another question), else the kind of person to find; or null. */
  _sentTo(topic) {
    const about = this._expertAbout(topic)
    if (about.length > 0) {
      const p = this.ctx.world.person(about[0].id), c = this._called(p), pr = this._pr(p)
      const again = this.sent.has(p.id)
      this.sent.add(p.id)
      return { text: again ? this._pick('sent:again', [`${p.name} again, I'm afraid.`, `Still ${p.name}. ${pr.He} knows a bit of everything.`, `Same answer: ${p.name}.`]) : this._pick('sent', [`Ask ${c}.`, `${c} would know.`, `Try ${c}.`]), about }
    }
    const body = expertBody(topic)
    return body === null ? null : { text: `${cap(article(CALLING[body]))} would know, if you can find one.`, about: [] }
  }

  /** A scoff `line`, from a helpful speaker, sends her to the town's teller of tall tales. */
  _talesTo(line) {
    const teller = this._helpful() ? this._taleTeller() : null
    if (teller === null) return line
    return { ...line, text: `${line.text} If it's tall tales you want, ask ${this._called(teller)}.`, about: [...line.about, { kind: 'person', id: teller.id }] }
  }

  /** The skald of the speaker's town, else its surest boaster, never the speaker; or null. */
  _taleTeller() {
    if (this.town === null) return null
    const others = this.town.minds.filter((m) => m.id !== this.mind.id)
    const skald = others.find((m) => m.body === 'skald')
    if (skald !== undefined) return skald
    const boasters = others.filter((m) => m.traits.boast > TALE_TELLER).sort((a, b) => b.traits.boast - a.traits.boast)
    return boasters[0] ?? null
  }

  /** `p` as sent to: "Edvin the skald", or just the name when their body has no calling. */
  _called(p) {
    return CALLING[p.body] === undefined ? p.name : `${p.name} the ${CALLING[p.body]}`
  }

  /** Who knows of lore `topic`: themself, the town's expert, the kind of person to find, or, from one who holds it a fairy tale, nobody (and the tale-teller). A curt or wary speaker will not say. */
  _who(topic) {
    if (TOPICS[topic] === undefined) throw new Error(`Conversation: no lore ${topic}`)
    if (!this._helpful()) return this._line(this._refuse(), 'talk-shrug', { mood: 'cold', moment: 'refuse.wary' })
    const label = TOPICS[topic].label
    if (TOPICS[topic].contested && this._belief(topic, topic).doubts) {
      return this._talesTo(this._line(`Nobody, because there are no ${label}.`, 'talk-shrug', { moment: 'social.disagree' }))
    }
    const best = this._expertAbout(topic)
    if (expertise(this.mind.body, topic) > 0 && (best.length === 0 || expertise(this.mind.body, topic) >= expertise(this.ctx.world.person(best[0].id).body, topic))) {
      return this._line(this._pick('who:me', ["You're looking at one. What do you want to know?", 'That would be me. Ask away.']), 'talk-nod', { moment: 'answer.self', about: [{ kind: 'lore', topic, named: true }] })
    }
    const to = this._sentTo(topic)
    return to === null ? this._line(this._dunno(), 'talk-shrug', { moment: 'answer.unknown' }) : this._line(to.text, 'talk-gesture', { moment: 'answer.refer', about: to.about })
  }

  /** The one in the speaker's town who knows most of `topic` (lore.js `expertise`), as an `about`, or none. */
  _expertAbout(topic) {
    if (this.town === null) return []
    let best = null
    for (const m of this.town.minds) if (m.id !== this.mind.id && expertise(m.body, topic) > (best === null ? 0 : expertise(best.body, topic))) best = m
    return best === null ? [] : [{ kind: 'person', id: best.id }]
  }

  // --- telling -----------------------------------------------------------

  /**
   * Her belief `b` planted in the speaker: `{ kind: 'sent', by }` (a person sent her) or `{ kind: 'where', about, x, z, label }` (where someone is). Returns a line with `caught` true when they saw through a lie: knowledge first, then a wariness roll.
   */
  tell(b) {
    this.ask++
    const { mind, ctx } = this
    const r = ctx.rapport.get(mind.id)
    let key, isTrue, knows
    if (b.kind === 'sent') {
      const by = ctx.world.person(b.by)
      key = `sent:${b.by}`
      isTrue = ctx.log.askedBy(b.by)
      // Their own household would have said so.
      knows = mind.household.includes(by.index) && by.town === mind.town
    } else if (b.kind === 'where') {
      key = `where:${b.about}`
      const q = [...ctx.quests.values()].find((x) => x.child === b.about)
      const truth = q !== undefined ? q.where : ctx.world.placeOf(ctx.world.person(b.about))
      if (q !== undefined) key = `${q.id}:where`
      isTrue = Math.hypot(truth.x - b.x, truth.z - b.z) <= SPEAK.same
      const seen = q?.witnesses.find((w) => w.who === mind.id)
      knows = q !== undefined ? q.covers.includes(mind.id) || (seen !== undefined && seen.clue.kind === 'saw') : this._knowsTown(ctx.world.person(b.about).town) > 0.6
    } else throw new Error(`Conversation: no belief ${b.kind}`)
    if (!isTrue && (knows || roll(ctx.world.seed, mind.id, key, ctx.epoch, 'detect') < mind.traits.wariness * SPEAK.detect)) {
      ctx.rapport.catchLie(mind.id)
      return this._line(this.leafkin ? this._lk('caught') : knows ? "That's a lie, and you know it." : "I don't believe you.", 'talk-shrug', { mood: 'angry', caught: true, moment: 'tell.caught' })
    }
    if (b.kind === 'sent') r.sentBy = b.by
    else r.beliefs.set(key, { x: b.x, z: b.z, label: b.label })
    return this._line(this.leafkin ? this._lk('believe') : 'Is that so.', 'talk-nod', { caught: false, moment: 'tell.believe' })
  }

  /** Her gift of `item`: a want met warms them and puts them in her debt. */
  give(item) {
    this.ask++
    const want = WANTS[this.mind.body]
    if (want !== item) return this._line(this.leafkin ? this._lk('polite') : "That's kind of you.", 'talk-nod', { moment: 'give.polite' })
    this.ctx.rapport.owe(this.mind.id, 0.3)
    this.ctx.rapport.warm(this.mind.id, 0.2)
    return this._line(this.leafkin ? this._lk('thanks', { item }) : `Oh, ${item}! I won't forget this.`, 'talk-nod', { mood: 'warm', moment: 'give.thanks' })
  }
}

/** Two people stopped talking (the talk state): what `a` was told, `b` now believes too, and a lie `a` caught makes `b` warier of her. */
export function gossip(rapport, a, b) {
  const ra = rapport.get(a)
  const rb = rapport.get(b)
  for (const [k, v] of ra.beliefs) if (!rb.beliefs.has(k)) rb.beliefs.set(k, v)
  if (ra.suspicion > rb.suspicion) rb.suspicion += (ra.suspicion - rb.suspicion) / 2
}

// Lowercases a line's first word after a hedge, unless it is "I" or a name.
// "work the forge" as said of someone else: "works the forge".
const third = (phrase) => phrase.replace(/^(\w+)/, (w) => (/(sh|ch|s|x)$/.test(w) ? `${w}es` : `${w}s`))

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

const article = (noun) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`

