// Her talk with a castle's folk (design/44-castles.md §Garrison): a few topics by who they are, the summit's view pressed on her
// by most of them, and the summit guard's tall tales. Its lines are `Conversation._line`'s shape, so conversations.js voices
// and shows them as a townsperson's. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { strHash } from './speak.js'
import { fits } from './caption.js'

export const CASTLE_TALK = {
  // Questions answered before they send her off; the summit guard never tires of her.
  patience: { lore: 40, guard: 4, rest: 5 },
  // Odds a greeting, or an answer about the castle, goes on to the summit's view.
  view: 0.55,
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

const NEWS = [
  "The cook and the steward aren't speaking. Something about a turnip.",
  'A traveller says the roads are bad past the river.',
  "The lord's hound ate a boot. Again. Same boot.",
  'Someone hears noises below at night. I would not go down there.',
  'They found a crow nesting in the armoury. It has a helmet now.',
  'The well rope snapped. We have a new one. It is very proud.',
]

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
  const out = [...VIEW, ...CASTLE, ...NEWS, ...VIEW_HERE, ...Object.values(SELF).flat()]
  for (const o of TALE.open) for (const w of TALE.who) for (const [d, t] of TALE.did) out.push(`${o} ${w} ${d}, ${t}`)
  for (const g of GHOST.of) for (const t of GHOST.then) out.push(ghostTale(g, t))
  return out
}

const ghostTale = (of, then) => `Old stories say the dungeon is haunted by the forlorn ghost of ${of}. ${then}`

/**
 * Her conversation with castle folk `mind` ({ id, name, who }): `open()` their greeting, `ask(topic)` the answer to a grid sentence,
 * `conv.menu()` the sentences she may say. `ctx.rooms` counts the castle's rooms; `approached` whether they came to her.
 */
export class CastleChat {
  constructor(mind, { rooms }, { approached = false, salt = 0 } = {}) {
    this.mind = mind
    this.rooms = rooms
    this.approached = approached
    this.rand = mulberry32(hash32(strHash(mind.id), salt))
    this.turns = 0
    this.ended = false
    this.used = new Set()
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

  _end(l, why) {
    this.ended = true
    return { ...l, ended: true, alone: CASTLE_TALK.alone[why] }
  }

  menu() {
    const chips = [['self', ['Tell me about', 'yourself.']], ['castle', ['Tell me about', 'this castle.']], ['news', ['Any news?']]]
    if (this.mind.who === 'lore') chips.push(['tale', ['Tell me', 'a tale.']], ['ghost', ['Is the dungeon', 'haunted?']], ['count', ['How big', 'is this castle?']], ['view', ['What can you', 'see from here?']])
    else chips.push(['see', ['Is there anything', 'worth seeing?']])
    chips.push(['bye', ['Goodbye.']])
    return chips.map(([topic, path]) => ({ topic, label: path.join(' '), path }))
  }

  open() {
    const who = this.mind.who
    if (who === 'lore') return line(this._pick(['Welcome to the top! Finest view in the realm, this. Ask me anything about the castle.', 'Up at last! Catch your breath. I know every tale these walls have.']), 'wave', { moment: 'greet.stranger' })
    if (this.approached) return line(this._urge(this._pick(['Hold there. A visitor? Mind yourself, then.', 'You there. No trouble, now.'])), 'talk-point', { moment: 'castle.halt' })
    const hi = { lord: 'castle.lord', steward: 'castle.steward', cook: 'castle.cook', maid: 'castle.maid', servant: 'castle.servant' }[who]
    const text = this._pick(GUARDS.has(who) ? ['Hm. What is it?', 'Keep it short.'] : ['Oh! A visitor.', 'Yes? Can I help?', 'Well met.'])
    return line(this._urge(text), 'wave', { moment: hi === undefined ? 'greet.stranger' : hi })
  }

  /** Her sentence `topic` answered. */
  ask(topic) {
    if (this.ended) throw new Error(`CastleChat: ${this.mind.id} has already ended the conversation`)
    if (topic === 'bye') return this._end(line(this._pick(BYE), 'wave', { moment: 'bye.warm' }), 'bye')
    this.turns++
    const said = this._answer(topic)
    if (this.turns < this.patience) return said
    const off = this._pick(OFF)
    return this._end(fits(`${said.text} ${off}`) ? { ...said, text: `${said.text} ${off}` } : said, 'dismissed')
  }

  _answer(topic) {
    const who = this.mind.who
    if (topic === 'self') return line(this._pick(SELF[GUARDS.has(who) && who !== 'lore' ? 'guard' : who]), 'talk-gesture', { moment: 'answer.self' })
    if (topic === 'castle') return line(this._urge(this._pick(CASTLE)), 'talk-gesture', { moment: 'answer.muse' })
    if (topic === 'news') return line(this._pick(NEWS), 'talk-nod', { moment: 'gossip.lead' })
    if (topic === 'see') return line(this._pick(VIEW), 'talk-point', { moment: 'observe.marvel' })
    if (topic === 'view') return line(this._pick(VIEW_HERE), 'talk-point', { moment: 'observe.marvel' })
    if (topic === 'ghost') return line(ghostTale(this._pick(GHOST.of), this._pick(GHOST.then)), 'talk-gesture', { moment: 'gossip.lead' })
    if (topic === 'count') return line(`This castle has ${this.rooms} rooms. I have counted ${this.rooms + 1}. Nobody believes me about the extra one.`, 'talk-shrug', { moment: 'answer.boast' })
    if (topic === 'tale') {
      if (this.rand() < CASTLE_TALK.ghost) return this._answer('ghost')
      const [d, t] = this._pick(TALE.did)
      return line(`${this._pick(TALE.open)} ${this._pick(TALE.who)} ${d}, ${t}`, 'talk-gesture', { moment: 'answer.sure' })
    }
    throw new Error(`CastleChat: no answer for ${topic}`)
  }
}

/** A line in `Conversation._line`'s shape. */
function line(text, gesture, more) {
  if (more.moment === undefined) throw new Error(`CastleChat: no voice moment for "${text}"`)
  return { text, gesture, toward: null, claim: null, mood: 'neutral', unlocks: [], about: [], ...more }
}
