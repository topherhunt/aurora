// The conversation engine (_notes/conversation-and-quests.md, "How an answer is made"): a topic becomes a fact, the fact passes through what the speaker knows, will share, will admit and gets right, and comes out as a short line in their voice. Lies are rolled per (speaker, fact, epoch) so they hold steady and every client hears the same one; muddles are rolled per ask, so they drift. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { TITLES } from './world.js'
import { MESSAGES } from './quests.js'

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

const LEAFKIN_FAR = { "right here": 'here-here', "a stone's throw": 'close', 'a short walk': 'little walk', 'a fair walk': 'far', 'a long walk': 'far-far', 'a long road': 'far-far-far' }

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
  /** `ctx`: `{ world, rapport, quests (Map id -> quest), log (QuestLog), epoch, from: { x, z } }`, `from` where the speaker stands. */
  constructor(mind, ctx) {
    this.mind = mind
    this.ctx = ctx
    this.ask = 0
    // Chips her questions have opened: topic -> label, in the order heard.
    this.mentions = new Map()
    // The message quest whose words the speaker has asked her to repeat, or null.
    this.delivering = null
  }

  get leafkin() {
    return this.mind.kind === 'leafkin'
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

  menu() {
    const chips = [['talk:self', 'Tell me about yourself'], ['talk:needs', 'Do you need anything?']]
    if (!this.leafkin) {
      chips.push(['talk:town', 'Tell me about this town'], ['where:here', 'Where am I?'], ['where:home', 'Where is your house?'])
      for (const title of Object.keys(TITLES)) chips.push([`where:title:${title}`, `Where is the ${title === 'potionmaster' ? 'potion master' : title}?`])
    }
    const m = this._message('to')
    if (m !== null && this.ctx.log.state(m.id) === 'accepted') {
      if (this.delivering === m.id) for (const k of m.choices) chips.push([`word:${k}:${m.id}`,`"${MESSAGES[m.message][k]}"`])
      else chips.push([`deliver:${m.id}`, `I bring word from ${this.ctx.world.person(m.giver).name}`])
    }
    for (const [topic, label] of this.mentions) chips.push([topic, `Ask about ${label}`])
    chips.push(['bye', 'Goodbye'])
    return chips.map(([topic, label]) => ({ topic, label }))
  }

  _mention(topic, label) {
    if (topic !== `ask:person:${this.mind.id}` && !this.mentions.has(topic)) this.mentions.set(topic, label)
  }

  /** Her question `topic` (a chip's topic) answered: `{ text, gesture, toward, claim, mood }`. */
  say(topic) {
    this.ask++
    const [head, ...rest] = topic.split(':')
    const arg = rest.join(':')
    if (head === 'talk') return this._talk(arg)
    if (head === 'where') return this._where(arg)
    if (head === 'ask') return this._askAbout(arg)
    if (head === 'deliver') return this._deliver(arg, null)
    if (head === 'word') return this._deliver(rest.slice(1).join(':'), Number(rest[0]))
    if (head === 'bye') return this._line(this.leafkin ? 'Bye-bye.' : 'Safe roads.', 'wave')
    throw new Error(`Conversation: no topic ${topic}`)
  }

  /** Their first line, when they hail her or she hails them: a parent with an untaken quest pleads, the rest greet her by how they stand with her. */
  opener() {
    const q = this.quest
    if (q !== null && q.parent === this.mind.id && this.ctx.log.state(q.id) === null) return this._plea(q)
    const m = this._message('giver')
    if (m !== null && this.ctx.log.state(m.id) === 'delivered') return this._errand(m)
    const s = this._standing()
    if (this.leafkin) return this._line(s > 0.3 ? `Friend! ${this.mind.name} here!` : 'Hm? Big-folk?', s > 0.3 ? 'wave' : 'talk-shrug')
    if (s < -0.2) return this._line('You again.', 'talk-shrug', { mood: 'cold' })
    return this._line(s > 0.3 ? 'Good to see you!' : 'Well met, stranger.', 'wave')
  }

  _line(text, gesture = 'talk-gesture', more = {}) {
    return { text, gesture, toward: null, claim: null, mood: 'neutral', ...more }
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
      if (f.alts.length > 0 && roll(ctx.world.seed, mind.id, f.key, ctx.epoch, 'boast') < T.boast * 0.7) {
        return this._claim(f, pickBy(lieRoll, f.alts), { sure: 1, hedge: false, boast: true, again: false })
      }
      return this._line(this._dunno(), 'talk-shrug')
    }
    // A stranger stands at 0: public facts (sens 0.15) pass everyone, kin's whereabouts (0.5) stop the wary half.
    const need = f.sens * T.wariness * 2 - 0.4
    if (this._standing() < need) {
      if (T.greed > 0.6 && !f.motive) return this._line(this.leafkin ? 'Give shroom, then tell.' : "What's it worth to you?", 'talk-gesture', { mood: 'cold', price: true })
      return this._line(this._refuse(), 'talk-shrug', { mood: 'cold' })
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
    const again = !muddled && r.said.has(f.key)
    r.said.set(f.key, claim)
    return this._claim(f, claim, { sure, hedge: !boast && sure < 0.6, boast: boast && (lie || sure < 0.6), again, lie })
  }

  _claim(f, claim, how) {
    const line = f.render(claim, how)
    let text = line.text
    if (how.again) text = (this.leafkin ? 'Said already. ' : 'Like I said, ') + lower(text)
    else if (how.boast) text = pickBy(roll(this.mind.id, this.ask, 'b'), this.leafkin ? ['Leafkin know! ', 'Sure-sure. '] : ['Everyone knows ', 'Oh, easy: ', 'Ha! ']) + lower(text)
    else if (how.hedge) text = pickBy(roll(this.mind.id, this.ask, 'h'), this.leafkin ? ['Maybe... ', 'Think... '] : ['I think ', 'If I remember right, ', 'Maybe ']) + lower(text)
    return { ...this._line(text, line.gesture ?? 'talk-gesture'), toward: line.toward ?? null, claim, how }
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
    return pickBy(roll(this.mind.id, this.ask, 'd'), this.leafkin ? ['No know.', 'Leafkin no know that.'] : ["No idea.", "Couldn't tell you.", "Never heard of it."])
  }

  _refuse() {
    return pickBy(roll(this.mind.id, this.ask, 'r'), this.leafkin ? ['No tell big-folk.', 'Hmph. No.'] : ['Why do you want to know?', "That's not your business.", "I don't know you."])
  }

  // --- places ------------------------------------------------------------

  /** A place claim `{ x, z, label }` as words from where the speaker stands. */
  _wayTo(claim, prefix) {
    const w = this.ctx.world.way(this.ctx.from, claim, this.town)
    if (this.leafkin) return { text: `${prefix ? prefix + ' ' : ''}${claim.label}. There. ${LEAFKIN_FAR[w.far]}.`, gesture: 'talk-point', toward: claim }
    const by = w.near !== null && w.near !== claim.label ? `, by ${w.near}` : ''
    const where = w.d < 6 ? 'right here' : `${w.far} ${w.dir}${by}`
    return { text: `${prefix ? prefix + ' ' : ''}${claim.label}, ${where}.`, gesture: 'talk-point', toward: claim }
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

  _wherePerson(p) {
    const place = this.ctx.world.placeOf(p)
    const self = p.id === this.mind.id
    const motive = this._covering(p.id)
    const rel = this._relation(p)
    this._mention(`ask:person:${p.id}`, p.name)
    return this._answer({
      key: `where:${p.id}`,
      conf: self ? 1 : this._knowsTown(p.town),
      // Strangers asking after kin get the guard up.
      sens: self ? 0 : rel === 'household' ? 0.5 : 0.15,
      motive,
      truth: place,
      alts: this._otherPlaces(place),
      muddle: this._swing,
      render: (claim) => this._wayTo(claim, self ? (this.leafkin ? 'Me at' : "I'm mostly at") : this.leafkin ? `${p.name} at` : `You'll find ${p.name} at`),
    })
  }

  _where(arg) {
    const { world } = this.ctx
    if (arg.startsWith('title:')) {
      const title = arg.slice(6)
      const p = world.titled(this.town, title)
      if (p === null) return this._line(`We've no ${title === 'potionmaster' ? 'potion master' : title} here.`, 'talk-shrug', { claim: null })
      return this._wherePerson(p)
    }
    if (arg.startsWith('person:')) return this._wherePerson(world.person(arg.slice(7)))
    if (arg.startsWith('town:')) return this._whereTown(Number(arg.slice(5)))
    if (arg === 'home') {
      const t = this.town
      const place = world.buildingPlace(t, this.mind.home)
      const lodger = place.label === 'the inn' && this.mind.trade !== 'inn'
      return this._answer({
        key: `where:home:${this.mind.id}`, conf: 1, sens: 0.35, motive: false, truth: lodger ? place : { ...place, label: 'my house' }, alts: [], muddle: null,
        render: (claim) => this._wayTo(claim, lodger ? "I'm lodging at" : "That's"),
      })
    }
    if (arg === 'here') {
      const { from } = this.ctx
      const here = world.townAt(from.x, from.z)
      const near = world.nearestTown(from.x, from.z, here?.index ?? null)
      this._mention(`ask:town:${near.index}`, near.name)
      if (here !== null) {
        const w = world.way(from, { x: near.town.x, z: near.town.z })
        return this._line(`This is ${here.name}. ${near.name} is ${w.far} ${w.dir}.`)
      }
      return this._whereTown(near.index, 'Wild country. The nearest town is')
    }
    throw new Error(`Conversation: no where:${arg}`)
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
      render: (claim) => {
        const w = world.way(this.ctx.from, claim)
        if (this.leafkin) return { text: `Big-folk nest. There. ${LEAFKIN_FAR[w.far]}.`, gesture: 'talk-point', toward: claim }
        return { text: `${prefix ? prefix + ' ' + t.name + ',' : t.name + "? That's"} ${w.far} ${w.dir}.`, gesture: 'talk-point', toward: claim }
      },
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
      if (this.leafkin) return this._line(`${mind.name}. ${mind.name} find shroom. ${mind.name} good.`, 'talk-nod')
      if (this._standing() < T.wariness - 0.85) return this._line(this._refuse(), 'talk-shrug', { mood: 'cold' })
      let text = `I'm ${mind.name}. I ${this._work(mind)}.`
      const kin = mind.household.map((i) => this.town.minds[i])
      if (kin.length > 0) {
        text += ` I live with ${kin.map((k) => k.name).join(' and ')}.`
        for (const k of kin) this._mention(`ask:person:${k.id}`, k.name)
      }
      if (T.chattiness > 0.55 && mind.friends.length > 0) {
        const f = this.town.minds[pickBy(r, mind.friends)]
        text += ` ${f.name} and I go way back.`
        this._mention(`ask:person:${f.id}`, f.name)
      }
      if (T.chattiness > 0.65 && mind.rival !== null) {
        const o = this.town.minds[mind.rival]
        text += ` Don't get me started on ${o.name}.`
        this._mention(`ask:person:${o.id}`, o.name)
      }
      return this._line(text)
    }
    if (arg === 'town') {
      const t = this.town
      const shops = ['smith', 'inn', 'potions'].filter((k) => t.town.buildings.some((b) => b.trade === k) || (k === 'smith' && t.minds.some((m) => m.trade === 'smith')))
      let text = `This is ${t.name}.`
      if (shops.length > 0) text += ` We've ${shops.map((k) => ({ smith: 'a smithy', inn: 'an inn', potions: 'a potion shop' })[k]).join(', ')}.`
      const q = this.quest
      // Bad news travels: anyone in town may bring up the missing child, the chattier the likelier.
      if (q !== null && q.parent !== mind.id && r < 0.3 + T.chattiness * 0.6) {
        const parent = ctx.world.person(q.parent)
        const child = ctx.world.person(q.child)
        text += ` ${parent.name}'s ${child.name} has gone missing, poor thing.`
        this._mention(`ask:person:${parent.id}`, parent.name)
        this._mention(`ask:person:${child.id}`, child.name)
      }
      if (T.chattiness > 0.5) {
        const near = ctx.world.nearestTown(t.town.x, t.town.z, t.index)
        if (this._knowsTown(near.index) > 0) {
          text += ` ${near.name} is the next town over.`
          this._mention(`ask:town:${near.index}`, near.name)
        }
      }
      return this._line(text)
    }
    if (arg === 'needs') return this._needs()
    throw new Error(`Conversation: no talk:${arg}`)
  }

  _needs() {
    const { mind, ctx } = this
    const q = this.quest
    if (q !== null && q.parent === mind.id && ctx.log.state(q.id) !== 'done') return this._plea(q)
    const m = this._message('giver')
    if (m !== null && [null, 'accepted', 'delivered'].includes(ctx.log.state(m.id))) return this._errand(m)
    const want = WANTS[mind.body]
    if (want === undefined || mind.traits.kindness > 0.75) return this._line(this.leafkin ? 'Need nothing. Happy.' : "I'm all right, thank you.", 'talk-nod')
    return this._line(this.leafkin ? `Want ${want}! ${mind.name} love ${want}.` : `I could use some ${want}, if you come by any.`, 'talk-gesture', { want })
  }

  /** The parent's plea; answering it accepts the quest. */
  _plea(q) {
    const { world, log, from } = this.ctx
    const child = world.person(q.child)
    this._mention(`ask:person:${child.id}`, child.name)
    log.accept(q)
    let text = `Please, my ${child.name} is missing! Have you seen ${child.name}?`
    if (q.opening === 'direction') {
      const w = world.way(from, q.where)
      text += ` Someone saw ${child.name} heading ${w.dir}.`
      return this._line(text, 'talk-point', { mood: 'distress', toward: q.where, quest: q.id })
    }
    return this._line(text, 'beckon', { mood: 'distress', quest: q.id })
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
      return this._line(`You told ${to.name}? Thank you. I won't forget it.`, 'talk-nod', { mood: 'warm', quest: m.id })
    }
    if (state === 'accepted') return this._line(`Have you seen ${to.name} yet? Remember: "${words}"`, 'talk-nod', { quest: m.id })
    log.accept(m)
    return this._line(`Would you carry word to ${to.name} in ${town.name}? ${to.name} is ${m.bond}. Tell ${to.name}: "${words}" Those words exactly.`, 'talk-gesture', { quest: m.id })
  }

  /** The recipient's side: with `k` null they ask what was said; else she answers with phrasing `k` of MESSAGES. */
  _deliver(id, k) {
    const { world, log, rapport } = this.ctx
    const m = this._message('to')
    if (m === null || m.id !== id || log.state(m.id) !== 'accepted') throw new Error(`Conversation: ${this.mind.id} awaits no word ${id}`)
    const giver = world.person(m.giver)
    if (k === null) {
      this.delivering = m.id
      return this._line(`Word from ${giver.name}? What did ${giver.name} say?`, 'talk-nod')
    }
    this.delivering = null
    const words = MESSAGES[m.message][k]
    if (k === 0) {
      log.set(m.id, 'delivered')
      rapport.warm(this.mind.id, 0.25)
      rapport.owe(this.mind.id, 0.2)
      return this._line(`"${words}" Oh... Thank you for carrying that all this way.`, 'talk-nod', { mood: 'warm', quest: m.id })
    }
    log.set(m.id, 'garbled')
    rapport.warm(this.mind.id, -0.15)
    return this._line(`"${words.slice(0, -1)}"? That can't be right. ${giver.name} would never say that.`, 'talk-shrug', { mood: 'cold', quest: m.id })
  }

  _askAbout(arg) {
    const { world } = this.ctx
    if (arg.startsWith('town:')) return this._whereTown(Number(arg.slice(5)))
    if (!arg.startsWith('person:')) throw new Error(`Conversation: no ask:${arg}`)
    const p = world.person(arg.slice(7))
    const q = [...this.ctx.quests.values()].find((x) => x.child === p.id)
    if (q !== undefined) return q.parent === this.mind.id ? this._plea(q) : this._missing(q, p)
    const rel = this._relation(p)
    if (p.id === this.mind.id) return this._talk('self')
    if (rel === 'stranger') return this._line(this._dunno(), 'talk-shrug')
    const opinion = {
      household: `${p.name}? We share a roof.`,
      friend: `${p.name}'s a good sort.`,
      rival: `${p.name}? Don't trust a word ${p.name} says.`,
      neighbour: `${p.name}? Keeps to themselves.`,
    }[rel]
    const where = this._wherePerson(p)
    if (where.claim === null) return { ...where, text: `${opinion} ${where.text}` }
    return { ...where, text: `${opinion} ${p.name} ${third(this._work(p))}. ${where.text}` }
  }

  /** What the speaker says of a missing child: a witness's clue, a coverer's lie, or nothing. */
  _missing(q, child) {
    const { world } = this.ctx
    const seen = q.witnesses.find((w) => w.who === this.mind.id)
    const alts = this._otherPlaces(q.where).filter((p) => p.building !== q.where.building)
    if (q.covers.includes(this.mind.id)) {
      return this._answer({
        key: `${q.id}:where`, conf: 1, sens: 0.6, motive: true, truth: q.where, alts, muddle: null,
        render: (claim) => (claim === q.where ? { text: `All right... ${child.name} is safe, here with us. Don't tell anyone.`, gesture: 'talk-nod' } : this._wayTo(claim, `${child.name}? Haven't seen them. Try`)),
      })
    }
    if (seen === undefined) return this._line(`${child.name}? I haven't seen ${child.name} today.`, 'talk-shrug')
    const c = seen.clue
    if (c.with !== undefined) {
      const host = world.person(c.with)
      this._mention(`ask:person:${host.id}`, host.name)
    }
    return this._answer({
      key: `${q.id}:where`, conf: c.conf, sens: 0.1, motive: false, truth: { x: c.x, z: c.z, label: c.label }, alts, muddle: this._swing,
      render: (claim) => {
        if (c.kind === 'with') return { text: `I saw ${child.name} with ${world.person(c.with).name} earlier.`, gesture: 'talk-gesture' }
        const w = world.way(this.ctx.from, claim, this.town)
        const lead = c.kind === 'heard' ? `Someone said ${child.name} went` : `I saw ${child.name} go`
        return { text: `${lead} ${w.dir}, toward ${claim.label}.`, gesture: 'talk-point', toward: claim }
      },
    })
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
      return this._line(this.leafkin ? 'Liar! Big-folk lie!' : knows ? "That's a lie, and you know it." : "I don't believe you.", 'talk-shrug', { mood: 'angry', caught: true })
    }
    if (b.kind === 'sent') r.sentBy = b.by
    else r.beliefs.set(key, { x: b.x, z: b.z, label: b.label })
    return this._line(this.leafkin ? 'Oh! Leafkin see.' : 'Is that so.', 'talk-nod', { caught: false })
  }

  /** Her gift of `item`: a want met warms them and puts them in her debt. */
  give(item) {
    this.ask++
    const want = WANTS[this.mind.body]
    if (want !== item) return this._line(this.leafkin ? 'Hm. Thank.' : "That's kind of you.", 'talk-nod')
    this.ctx.rapport.owe(this.mind.id, 0.3)
    this.ctx.rapport.warm(this.mind.id, 0.2)
    return this._line(this.leafkin ? `${item}! Friend! Friend!` : `Oh, ${item}! I won't forget this.`, 'talk-nod', { mood: 'warm' })
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

const lower = (s) => (/^(You|That|This|Someone|We|Haven|The|There|All|Me|Big)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s)
