// Her talk with a castle's folk (design/44-castles.md §Garrison): a few topics by who they are, the castle's gossip told each their
// own way (castle-news.js), where she is and the way to a room or a town (castle-ways.js), a mood's asides (quirks.js), the summit's view pressed on her by most of them,
// and the summit guard's tall tales. Its lines are `Conversation._line`'s shape, so conversations.js voices and shows them as a townsperson's. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { strHash } from './speak.js'
import { fits } from './caption.js'
import { QUIRKS, quirkLines } from './quirks.js'
import { castleNews, tellCastle, allCastleBodies } from './castle-news.js'
import { heardOf, nothingMore, cap, NEWS_CLIPS } from './gossip.js'
import { NEXT } from './grid.js'
import { allGiftLines } from './castle-gifts.js'
import { ASKED, places, route, shutEdges, steps, hereName, sectionName, townWay } from './castle-ways.js'

export const CASTLE_TALK = {
  // Questions answered before they send her off; the summit guard never tires of her.
  patience: { lore: 40, guard: 4, rest: 5 },
  // A way asked is known at this base plus `know` times their accuracy; under `clear` accuracy they give only the first step, and under `sure` they cannot place the town's bearing.
  way: { base: 0.4, know: 0.6, clear: 0.45, sure: 0.35 },
  // Odds a greeting, or an answer about the castle, goes on to the summit's view.
  view: 0.55,
  // Odds a greeting, and a goodbye once any ward is open, is about the wards (WARD_TALK).
  tone: 0.7,
  // Of the summit guard's tales, the odds it is the dungeon's ghost.
  ghost: 0.3,
  alone: { bye: 60, dismissed: 45, declined: 30 },
}

const GUARDS = new Set(['guard', 'watch', 'gate', 'lore'])
const TITLE = { lord: ['Lord', 'Lady'], steward: ['Steward', 'Steward'], cook: ['Cook', 'Cook'], maid: ['Maid', 'Maid'], servant: ['', ''], guard: ['Guard', 'Guard'], watch: ['Guard', 'Guard'], gate: ['Guard', 'Guard'], lore: ['Old', 'Old'], yard: ['', ''], traveller: ['', ''] }
const NAMES = [
  ['Osric', 'Bertram', 'Aldo', 'Godric', 'Wulf', 'Edmund', 'Hamo', 'Piers', 'Tobin', 'Ulric', 'Rolf', 'Anselm'],
  ['Hulda', 'Maud', 'Edith', 'Agnes', 'Sigrid', 'Rowena', 'Elsbet', 'Ida', 'Gisla', 'Wenna', 'Alys', 'Brida'],
]

// Added to a uniform roll: what each post leans toward.
const LEAN = {
  lord: { boast: 0.3, wariness: 0.1 }, steward: { accuracy: 0.25, boast: 0.15 }, cook: { chattiness: 0.2 }, maid: { wariness: 0.25, chattiness: 0.15 },
  guard: { chattiness: -0.2, wariness: 0.2 }, watch: { chattiness: -0.2, wariness: 0.2 }, gate: { chattiness: -0.25, wariness: 0.25 },
  lore: { chattiness: 0.4, boast: 0.3, accuracy: -0.2 }, traveller: { chattiness: 0.2, accuracy: -0.1 },
}
const TEMPER = ['chattiness', 'accuracy', 'wariness', 'kindness', 'boast']
const MOOD_SALT = 7123

/** Castle folk `who`'s temper, fixed by their mind `id`: `{ h, traits, mood }`, `h` the id's hash, `mood` a quirks.js mood or 'plain'. */
export function castleTemper(who, id) {
  const h = strHash(id), rand = mulberry32(hash32(h, MOOD_SALT))
  const traits = {}
  for (const k of TEMPER) traits[k] = Math.max(0, Math.min(1, (rand() + rand()) / 2 + (LEAN[who]?.[k] ?? 0)))
  const weight = { bitter: 1 - traits.kindness, timid: traits.wariness, adoring: traits.kindness, plain: 1.2 }
  let r = rand() * Object.values(weight).reduce((a, b) => a + b, 0), mood = 'plain'
  for (const [k, w] of Object.entries(weight)) if ((r -= w) < 0) { mood = k; break }
  return { h, traits, mood }
}

/** The name castle folk `who` (castle-folk.js) goes by, `he` its pronoun, `h` a hash fixing which. */
export function castleName(who, he, h) {
  const given = NAMES[he ? 0 : 1][h % NAMES[0].length], title = TITLE[who][he ? 0 : 1]
  return title === '' ? given : `${title} ${given}`
}

export const VIEW = [
  'Have you been up the lookout? The view from the very top is a treasure. Truly.',
  'Climb to the top of the highest tower, if your legs allow. Best view in the realm.',
  "Whatever you do, see the top of the tallest tower. It's a treasure up there.",
  'From the top of the lookout you can see three valleys and one very small goat.',
  "Go up the highest tower, right to the top. You'll thank me.",
  'The lookout, all the way up. I go just to breathe. Finest sight I know.',
  'If you see one thing here, make it the view from the top of the highest tower.',
]

const SELF = {
  lord: ['I rule here. My steward says so, and I believe him.', 'Lord of these halls. It is mostly signing things and frowning.'],
  steward: ['I keep the accounts, the keys and the lord\'s temper. Two of those are easy.', 'I am the steward. If a candle is lit here, I have counted it.'],
  cook: ['I feed forty mouths three times a day. Mind the soup.', 'Forty years at this hearth. Burnt a pie only twice.'],
  maid: ['I keep the kitchen tidy. And I keep well away from the dungeon door.', 'Scrubbing, mostly. The pots never end.'],
  servant: ['I fetch, I carry, I polish. Mostly polish.', 'Sweeping. Always sweeping. This castle makes dust out of nothing.'],
  guard: ['I stand here and I guard. Harder than it looks.', 'Twelve years on watch. Two bandits and a great many crows.'],
  yard: ['I draw the water and split the wood. Honest work.', 'Water from the well, wood for the hearths. Every day.'],
  traveller: ['Just passing through. I bring the castle its salt and its gossip.', 'On the road to town and back. Long climb, this.'],
  lore: ['Forty years on this tower. I know every stone by name. That one is Gerald.', 'I keep the summit. Someone has to, and nobody else wanted the stairs.'],
}

const CASTLE = [
  'These walls are older than anyone remembers. Well, except the steward.',
  'Getting about is a maze. Doors lead to doors. I was lost a week once.',
  'Every stair here winds up to something. The best of them winds to the lookout.',
  'There is a dungeon below. Nobody goes down. Nobody wants to.',
  'The lord likes visitors. Polite ones. The rest he has us show out.',
  'Mind the walls in the wind. The parapets are good, but the wind is better.',
]

// What folk say of the wards by how many are open (wardTier): all shut, distress and a warning; some open, thanks and hope; most open, warm and
// effusive; all open, jubilant. `greet` opens a talk, `castle` answers the castle topic, `bye` (once any is open) is a warm goodbye.
export const WARD_TALK = {
  shut: {
    greet: [
      'Oh, a visitor! Half the keep is locked down by an enchantment, and some of us are trapped in the walls.',
      'Please, mind yourself. An enchantment has sealed half the keep, and folk are stuck in the walls.',
      'Thank goodness. Half the keep is shut up by sorcery, and people are trapped inside the walls.',
    ],
    castle: [
      'Half the keep is locked down by an enchantment. If you go in, be careful, or you will be trapped in the walls too.',
      'Some of us are trapped in the walls. Mind yourself in there, lest you be caught as well.',
      'If you can unknot this enchantment, we will be deeply grateful. Only take care it does not trap you too.',
    ],
    bye: [],
  },
  some: {
    greet: [
      'Oh, a visitor! Some of the wards are broken, I hear. Bless you for it.',
      'Is it true? A few doors are free of the sorcery. We have you to thank, I think.',
      'Thank you, truly. Part of the keep breathes again. Please, keep on.',
    ],
    castle: [
      'Some of the doors are free now, and folk are slipping out of the walls. Thank you! There are more to unknot, if you can.',
      'You have broken a few of the wards, and we are grateful. The rest still hold, so take care.',
      'A little of the enchantment has lifted, bless you. Unknot the others, and we will be forever grateful.',
    ],
    bye: ['Go well, and thank you.', 'Bless you for the doors.'],
  },
  most: {
    greet: [
      'You! The one unknotting the wards! Bless you a hundred times, the keep is nearly free.',
      'Oh, my friend! Nearly every ward is broken. We cannot thank you enough.',
      'Welcome, welcome, and thank you! The keep breathes again, because of you.',
    ],
    castle: [
      'The keep is nearly free, and all because of you! Only a ward or two still hold. Bless you, truly.',
      'We cannot thank you enough. Nearly the whole keep is open to us again. One more push, and we are free.',
      'You are a marvel! Almost every ward is broken. We will sing of you in the kitchens.',
    ],
    bye: ['Bless you! Come again soon.', 'A hundred thanks, and a hundred more.'],
  },
  all: {
    greet: [
      'The wards are all broken! You saved us, you did. Welcome, welcome, a thousand times!',
      'Our saviour! The whole keep is free. We are in your debt forever.',
      'You did it! Every ward is gone. Whatever you need here is yours, with our thanks.',
    ],
    castle: [
      'The enchantment is gone, every knot of it, and we are free. We owe you everything.',
      'No more trapped in the walls, thanks to you. This castle is yours as long as you wish it.',
      'You broke every ward! There will be feasting tonight, and you are the guest of honour.',
    ],
    bye: ['Our thanks go with you, always.', 'Come back and feast with us!', 'You are always welcome here.'],
  },
}
const TIERS = Object.keys(WARD_TALK)

/** How far `open` of a castle's `total` wards are open: 'shut' none, 'some' under half, 'most' half or more but not all, 'all'. */
export function wardTier(open, total) {
  if (!Number.isInteger(open) || !Number.isInteger(total) || total < 1 || open < 0 || open > total) throw new Error(`wardTier: ${open} of ${total} wards`)
  if (open === 0) return 'shut'
  if (open === total) return 'all'
  return open * 2 < total ? 'some' : 'most'
}

const VIEW_HERE = [
  'That is the road to town. That speck? A sheep. Or a cloud. Hard to say from up here.',
  'On a clear day you can see the next castle, and its guard waving. I wave back.',
  'Look there, where the land folds. That is where the river hides.',
  'Breathe it in. The whole world laid out like a supper. I never tire of it.',
]

const BYE = ['Go well.', 'Safe roads.', 'Mind the stairs.', 'Off you go, then.']
const OFF = ['Back to my post.', 'I must get on.', 'That will do, now.', 'Work to do.']

// The summit guard's tales, a part from each list.
const TALE = {
  open: ['They say', 'Legend has it', 'My gran swore', 'True story:', 'Old tale:'],
  who: ['the first lord', 'a baker named Hulda', 'King Ottmar the Damp', 'a very stubborn goose', 'twelve monks', 'a giant with a bad back', 'a wizard on holiday', 'three sisters and a mule'],
  did: [
    ['built this keep in one night', 'and the mortar is mostly porridge.'],
    ['lost a wager to a badger here', 'and the badger still collects rent.'],
    ['buried a cheese under the gate', 'and nobody has found it since.'],
    ['taught the walls to sing', 'so on still nights you hear humming.'],
    ['won this hill in a staring match', 'and never blinked again.'],
    ['laid the stairs in a hurry', 'which is why they wind the wrong way.'],
    ['hid a crown in the chimney', 'so the cook still checks the soot.'],
    ['fell asleep on the summit', 'and woke up a hundred years later.'],
  ],
}
const GHOST = {
  of: ['a lovesick pastry cook', 'a goat who wished to be a knight', 'the third-best juggler in the land', 'a tax collector, still owed', 'a bard who forgot the last verse', 'a jester nobody laughed at', 'a wizard who sneezed mid-spell', 'a very good dog'],
  then: ['It moans on cold nights.', 'Some nights you hear it sigh.', 'It waits down there still, they say.', 'I have never gone to look, mind.'],
}

/** Every tale the summit guard can tell, for check-talk to walk against the caption. */
export function allCastleLines() {
  const out = [...VIEW, ...CASTLE, ...TIERS.flatMap((t) => Object.values(WARD_TALK[t]).flat()), ...allGiftLines(), ...allCastleBodies(), ...VIEW_HERE, ...Object.values(SELF).flat()]
  for (const o of TALE.open) for (const w of TALE.who) for (const [d, t] of TALE.did) out.push(`${o} ${w} ${d}, ${t}`)
  for (const g of GHOST.of) for (const t of GHOST.then) out.push(ghostTale(g, t))
  return out
}

// What they say of a way they cannot give: they do not know it, know only its start, or know a ward holds it.
const DUNNO = ['Never been. Ask someone else.', 'I could not say. This place is a maze.', "Don't ask me. I only know my own corner.", 'No idea, truly. I keep to my post.']
const MUDDLE = ['After that? I lose the thread.', 'And then, er... I forget the rest.', 'Then it gets muddled. Ask again up there.']
const HERE = ['You are standing in it.', 'You are in it now. Look about.']
const NEAR = ['Close. On this very floor, through a door or two.', 'Very near. Try the next room over.']
const SHUT = ['A ward holds the way shut, by', 'The way is warded shut, by', 'You cannot pass the ward by']

const ghostTale = (of, then) => `Old stories say the dungeon is haunted by the forlorn ghost of ${of}. ${then}`

/**
 * Her conversation with castle folk `mind` ({ id, name, who, castle, h, traits, mood }, `castle` its castle's seed): `open()` their greeting, `ask(topic)` the answer to a grid sentence,
 * `menu()` the sentences she may say. `ctx.rooms` counts the castle's rooms, `ctx.wards` its `{ open, total }` wards (wardTier); `approached` whether they came to her.
 */
export class CastleChat {
  constructor(mind, { rooms, wards, ways }, { approached = false, salt = 0 } = {}) {
    if (wards === undefined || wards === null) throw new Error(`CastleChat: ${mind.id} needs ctx.wards as { open, total, mask }`)
    if (!Number.isInteger(wards.mask)) throw new Error(`CastleChat: ${mind.id} needs ctx.wards.mask, the bitmask of opened wards`)
    if (ways === undefined || ways === null) throw new Error(`CastleChat: ${mind.id} needs ctx.ways from castle-ways.js (lay, yaw, at, name, x, z, towns)`)
    this.mind = mind
    this.rooms = rooms
    this.ways = ways
    this.places = places(ways.lay)
    this.shut = shutEdges(ways.lay, wards.mask)
    this.tier = wardTier(wards.open, wards.total)
    this.approached = approached
    this.rand = mulberry32(hash32(strHash(mind.id), salt))
    this.turns = 0
    this.ended = false
    // Their sign-off once they have had enough, said on its own page when she presses NEXT, or null.
    this.parting = null
    this.used = new Set()
    const stories = castleNews(mind.castle)
    this.news = heardOf(stories.length, mind.h, (i) => stories[i].parties.includes(mind.who)).map((i) => stories[i])
    this.patience = mind.who === 'lore' ? CASTLE_TALK.patience.lore : GUARDS.has(mind.who) ? CASTLE_TALK.patience.guard : CASTLE_TALK.patience.rest
    this.conv = { menu: () => this.menu(), _line: (text, gesture, more) => line(text, gesture, more) }
  }

  /** One of `list` not said yet in this talk, while any is left. */
  _pick(list) {
    const fresh = list.filter((t) => !this.used.has(t)), from = fresh.length > 0 ? fresh : list
    const t = from[(this.rand() * from.length) | 0]
    this.used.add(t)
    return t
  }

  /** `text`, with the view pressed on her when the roll says and it fits. */
  _urge(text) {
    if (this.mind.who === 'lore' || this.rand() >= CASTLE_TALK.view) return text
    const both = `${text} ${this._pick(VIEW)}`
    return fits(both) ? both : text
  }

  /** `text` with their mood's word for `where` ('aside', 'greet' or 'bye') after it, when it shows and fits. */
  _mood(text, where) {
    if (this.mind.mood === 'plain' || this.rand() >= QUIRKS.odds[where]) return text
    const both = `${text} ${this._pick(quirkLines({ kind: this.mind.mood })[where])}`
    return fits(both) ? both : text
  }

  _end(l, why) {
    this.ended = true
    return { ...l, ended: true, alone: CASTLE_TALK.alone[why] }
  }

  menu() {
    if (this.parting !== null) return [NEXT]
    const chips = [['self', ['Tell me about', 'yourself.']], ['castle', ['Tell me about', 'this castle.']], ['news', ['Any news?']]]
    if (this.mind.who === 'lore') chips.push(['tale', ['Tell me', 'a tale.']], ['ghost', ['Is the dungeon', 'haunted?']], ['count', ['How big', 'is this castle?']], ['view', ['What can you', 'see from here?']])
    else chips.push(['see', ['Is there anything', 'worth seeing?']])
    chips.push(['where:here', ['Where', 'am I?']])
    for (const p of this.places) chips.push([`way:${p.id}`, ['How do I get to', `${p.label}?`]])
    this.ways.towns.forEach((t, i) => chips.push([`way:town:${i}`, ['How do I get to', `${t.name}?`]]))
    chips.push(['bye', ['Goodbye.']])
    return chips.map(([topic, path]) => ({ topic, label: path.join(' '), path }))
  }

  open() {
    const who = this.mind.who
    if (this.rand() < CASTLE_TALK.tone) {
      if (this.tier === 'shut') return line(this._pick(WARD_TALK.shut.greet), 'talk-gesture', { moment: this.approached ? 'castle.halt' : who === 'lore' ? 'greet.stranger' : { lord: 'castle.lord', steward: 'castle.steward', cook: 'castle.cook', maid: 'castle.maid', servant: 'castle.servant' }[who] ?? 'greet.stranger' })
      return line(this._pick(WARD_TALK[this.tier].greet), this.tier === 'some' ? 'talk-nod' : 'wave', { moment: 'give.thanks' })
    }
    if (who === 'lore') return line(this._pick(['Welcome to the top! Finest view in the realm, this. Ask me anything about the castle.', 'Up at last! Catch your breath. I know every tale these walls have.']), 'wave', { moment: 'greet.stranger' })
    if (this.approached) return line(this._urge(this._mood(this._pick(['Hold there. A visitor? Mind yourself, then.', 'You there. No trouble, now.']), 'greet')), 'talk-point', { moment: 'castle.halt' })
    const hi = { lord: 'castle.lord', steward: 'castle.steward', cook: 'castle.cook', maid: 'castle.maid', servant: 'castle.servant' }[who]
    const text = this._pick(GUARDS.has(who) ? ['Hm. What is it?', 'Keep it short.'] : ['Oh! A visitor.', 'Yes? Can I help?', 'Well met.'])
    return line(this._urge(this._mood(text, 'greet')), 'wave', { moment: hi === undefined ? 'greet.stranger' : hi })
  }

  /** Her sentence `topic` answered. */
  ask(topic) {
    if (this.ended) throw new Error(`CastleChat: ${this.mind.id} has already ended the conversation`)
    if (this.parting !== null) {
      if (topic !== NEXT.topic) throw new Error(`CastleChat: ${this.mind.id} is parting and takes only ${NEXT.topic}, not ${topic}`)
      return this._end(this.parting, 'dismissed')
    }
    if (topic === 'bye' && this.tier !== 'shut' && this.rand() < CASTLE_TALK.tone) return this._end(line(this._pick(WARD_TALK[this.tier].bye), 'wave', { moment: 'bye.warm' }), 'bye')
    if (topic === 'bye') return this._end(line(this._mood(this._pick(BYE), 'bye'), 'wave', { moment: 'bye.warm' }), 'bye')
    this.turns++
    const said = this._answer(topic)
    if (this.turns < this.patience) return said
    // She is left alone from now, even if she walks off before the sign-off.
    this.parting = line(this._pick(OFF), 'talk-shrug', { moment: 'bye.curt' })
    return { ...said, alone: CASTLE_TALK.alone.dismissed }
  }

  _answer(topic) {
    const who = this.mind.who
    if (topic === 'self') {
      const text = this._pick(SELF[GUARDS.has(who) && who !== 'lore' ? 'guard' : who]), more = this.mind.mood === 'plain' ? '' : ` ${quirkLines({ kind: this.mind.mood }).self}`
      return line(fits(text + more) ? text + more : text, 'talk-gesture', { moment: 'answer.self' })
    }
    if (topic === 'castle' && this.tier !== 'shut') return line(this._pick(WARD_TALK[this.tier].castle), 'talk-gesture', { moment: 'give.thanks' })
    if (topic === 'castle') return line(this._pick(WARD_TALK.shut.castle), 'talk-gesture', { moment: 'answer.muse' })
    if (topic === 'castle') return line(this._urge(this._mood(this._pick(CASTLE), 'aside')), 'talk-gesture', { moment: 'answer.muse' })
    if (topic === 'news') {
      const fresh = this.news.filter((s) => !this.used.has(s))
      if (fresh.length === 0) return line(nothingMore(this.rand), 'talk-shrug', { moment: 'answer.spent' })
      const s = fresh[(this.rand() * fresh.length) | 0]
      this.used.add(s)
      return line(this._mood(tellCastle(s, this.mind, this.rand), 'aside'), 'talk-nod', { moment: 'gossip.lead', only: NEWS_CLIPS })
    }
    if (topic === 'see') return line(this._pick(VIEW), 'talk-point', { moment: 'observe.marvel' })
    if (topic === 'view') return line(this._pick(VIEW_HERE), 'talk-point', { moment: 'observe.marvel' })
    if (topic === 'ghost') return line(ghostTale(this._pick(GHOST.of), this._pick(GHOST.then)), 'talk-gesture', { moment: 'gossip.lead', only: NEWS_CLIPS })
    if (topic === 'count') return line(`This castle has ${this.rooms} rooms. I have counted ${this.rooms + 1}. Nobody believes me about the extra one.`, 'talk-shrug', { moment: 'answer.boast' })
    if (topic === 'tale') {
      if (this.rand() < CASTLE_TALK.ghost) return this._answer('ghost')
      const [d, t] = this._pick(TALE.did)
      return line(`${this._pick(TALE.open)} ${this._pick(TALE.who)} ${d}, ${t}`, 'talk-gesture', { moment: 'answer.sure' })
    }
    if (topic === 'where:here') return this._where()
    if (topic.startsWith('way:')) return this._way(topic.slice(4))
    throw new Error(`CastleChat: no answer for ${topic}`)
  }

  /** Where they and she stand: the room and storey, the castle, and the nearest town's bearing when they can place it. */
  _where() {
    const { lay, yaw, at, name, towns } = this.ways
    const here = `You are ${hereName(lay, yaw, at)} of ${name}.`
    const sure = this.mind.traits.accuracy >= CASTLE_TALK.way.sure
    const town = towns.length === 0 ? '' : sure ? ` ${towns[0].name} lies ${townWay(this.ways, towns[0])}.` : ` ${towns[0].name} is somewhere down the hill.`
    return line(this._mood(fits(here + town) ? here + town : here, 'aside'), 'talk-point', { moment: 'answer.sure' })
  }

  /** The way to place `id` (castle-ways.js places, or `town:<i>`): a spoken route over the real layout, muddled, unknown or blocked by a shut ward as they are. */
  _way(id) {
    const { lay, yaw, at, towns } = this.ways, acc = this.mind.traits.accuracy
    const town = id.startsWith('town:') ? towns[Number(id.slice(5))] : null
    if (id.startsWith('town:') && town === undefined) throw new Error(`CastleChat: no town ${id}`)
    const place = town === null ? this.places.find((p) => p.id === id) : { label: town.name, goals: new Set([lay.nodes.find((n) => n.kind === 'entry')]) }
    if (place === undefined) throw new Error(`CastleChat: no place ${id}`)
    const lead = `${cap(place.label)}? `, W = CASTLE_TALK.way
    const said = (text, moment, gesture = 'talk-point') => line(this._mood(text, 'aside'), gesture, { moment })
    if (town !== null && at.node.kind === 'entry') {
      if (this.rand() >= W.base + W.know * acc) return said(lead + this._pick(DUNNO), 'answer.unknown', 'talk-shrug')
      return said(`${lead}Follow the road. It is ${townWay(this.ways, town)}.`, 'answer.sure')
    }
    if (town === null && place.goals.has(at.node)) {
      const own = at.chamber !== null && (!ASKED.includes(id) || at.chamber.role !== id)
      return said(lead + this._pick(own ? NEAR : HERE), 'answer.sure')
    }
    if (this.rand() >= W.base + W.know * acc) return said(lead + this._pick(DUNNO), 'answer.unknown', 'talk-shrug')
    const path = route(lay, at.node, place.goals, this.shut)
    if (path === null) {
      const free = route(lay, at.node, place.goals, new Set()), i = free.edges.findIndex((e) => this.shut.has(e))
      return said(`${lead}${this._pick(SHUT)} ${sectionName(yaw, free.nodes[i])}. Break it first.`, 'answer.sure')
    }
    const tail = town === null ? '' : ` Then it is ${townWay(this.ways, town)}.`
    const sp = steps(yaw, path).map((s) => s.text)
    if (acc < W.clear && sp.length > 1) return said(`${lead}Go ${sp[0]}.${tail} ${this._pick(MUDDLE)}`, 'answer.hedge', 'talk-gesture')
    for (let n = sp.length; n >= 1; n--) {
      const text = `${lead}Go ${sp.slice(0, n).join(', then ')}.${tail}`
      if (fits(text)) return said(text, 'answer.sure')
    }
    throw new Error(`CastleChat: the way to ${id} from ${at.node.id} does not fit the caption: ${lead}${sp.join(', then ')}`)
  }
}

/** A line in `Conversation._line`'s shape. */
function line(text, gesture, more) {
  if (more.moment === undefined) throw new Error(`CastleChat: no voice moment for "${text}"`)
  return { text, gesture, toward: null, claim: null, mood: 'neutral', unlocks: [], about: [], only: null, ...more }
}
