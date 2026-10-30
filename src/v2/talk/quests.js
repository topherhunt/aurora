// The quests a town holds (_notes/conversation-and-quests.md), rolled from the seed, the town and the epoch, so every client in a room meets the same distressed parent and the same child is truly in the same place. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { compass } from './world.js'

export const QUESTS = {
  // A quest's life: long enough to ask round a town and walk out to a neighbour.
  epochS: 1800,
  // A town's child hides in the castle whose gate is within `castleM` of its fire, else in the cave whose mouth is nearest within `caveM`.
  castleM: 700,
  caveM: 1200,
  // Witnesses asked round town who saw something.
  witnesses: [2, 4],
  // The parent gives only the child's name with this chance; otherwise a direction too.
  nameOnly: 0.5,
  // A town's odds of someone with word to send to the next town over, per epoch.
  message: 0.6,
}

// Each message with its near-misses: the first is what was said, the rest what a careless memory makes of it.
export const MESSAGES = [
  ['The debt is forgiven.', 'The debt is forgotten.', 'The debt is due.', 'The debt is doubled.'],
  ['The wedding is on for midsummer.', 'The wedding is off.', 'The wedding is on for midwinter.', 'The wedding is moved to spring.'],
  ['The boat is sold.', 'The boat is sunk.', 'The boat is yours.', 'The goat is sold.'],
  ['Come home before the snow.', 'Come home after the snow.', 'Stay put until the snow.', 'Come home before the thaw.'],
  ['The north field is yours.', 'The north field is ours.', 'The south field is yours.', 'The north field is sold.'],
  ['The quarrel is over.', 'The quarrel is not over.', 'The quarrel is yours to end.', 'The quarrel has just begun.'],
  ['The mare has foaled.', 'The mare has bolted.', 'The mare has died.', 'The cow has calved.'],
  ['Bring the axe back by the full moon.', 'Keep the axe till the full moon.', 'Bring the axe back by the new moon.', 'Bring the saw back by the full moon.'],
]
const BONDS = ['an old friend', 'my cousin', 'my old partner', 'someone I owe']

// A castle ghost's word for the last of its line in the town below, with its near-misses as MESSAGES.
export const GHOST_WORDS = [
  ['The ring is under the third stair.', 'The ring is under the third stone.', 'The ring is over the third stair.', 'The rope is under the third stair.'],
  ['I was never angry with you.', 'I was always angry with you.', 'I was never afraid of you.', 'I was never angry with him.'],
  ['Plant the apple tree by the well.', 'Plant the pear tree by the well.', 'Fell the apple tree by the well.', 'Plant the apple tree by the wall.'],
  ['The old song ends on a high note.', 'The old song ends on a low note.', 'The old song starts on a high note.', 'The old song ends on a sad note.'],
]
const GHOSTS = [
  { name: 'Lady Ysolde', she: true },
  { name: 'Sir Brannoc', she: false },
  { name: 'Mistress Hale', she: true },
  { name: 'Old Grandsire Orm', she: false },
]

const SALT = 7201
const SALT_MESSAGE = 7202
const SALT_GHOST = 7203

export const epochOf = (seconds) => Math.floor(seconds / QUESTS.epochS)

const pick = (rand, list) => list[(rand() * list.length) | 0]

// What a witness caught the child at before they went, each said after "I caught him".
export const ODD = [
  'pinching bones out of the soup pot',
  "talking to someone who wasn't there",
  'stuffing {his} pockets with chicken bones',
  'asking how many bones a body has',
  'sneaking a lantern out after supper',
  'whistling at the ground like {he} was calling a dog',
]

/**
 * Each town's hideout, or null: the castle whose gate is within QUESTS.castleM of its fire, else the cave mouth nearest
 * within QUESTS.caveM. `caves` `{ system, mouth, x, z }` (the mouth), `castles` `{ site, x, z }` (the gate). Each hideout
 * is `{ kind: 'cave', system, mouth, x, z, label }` or `{ kind: 'castle', site, x, z, label }`, the label said from town.
 */
export function hideouts(towns, caves, castles) {
  const nearest = (list, x, z, max) => list.reduce((best, p) => {
    const d = Math.hypot(p.x - x, p.z - z)
    return d < max && (best === null || d < best.d) ? { p, d } : best
  }, null)
  return towns.map((town) => {
    const keep = nearest(castles, town.x, town.z, QUESTS.castleM)
    if (keep !== null) return { kind: 'castle', site: keep.p.site, x: keep.p.x, z: keep.p.z, label: 'the old castle' }
    const mouth = nearest(caves, town.x, town.z, QUESTS.caveM)
    if (mouth === null) return null
    return { kind: 'cave', system: mouth.p.system, mouth: mouth.p.mouth, x: mouth.p.x, z: mouth.p.z, label: `the cave to the ${compass(mouth.p.x - town.x, mouth.p.z - town.z)}` }
  })
}

/** Town `townIndex`'s missing child in `epoch`, or null when it has no child or no hideout (world.hideouts): `{ id, kind, town, parent, child, where, witnesses, opening }`. `where` is the hideout with `variant` its kind; each witness `{ who, clue }` with `clue` `{ kind, conf, x, z, label, odd }`, `odd` an index into ODD or null. */
export function missingChild(world, townIndex, epoch) {
  const t = world.towns[townIndex]
  const hide = world.hideouts[townIndex]
  if (hide === null) return null
  const rand = mulberry32(hash32(world.seed, SALT, townIndex, epoch))
  const families = t.minds.filter((m) => m.cls === 'child' && m.household.some((i) => t.minds[i].cls !== 'child'))
  if (families.length === 0) return null
  const boys = families.filter((m) => m.voice.he)
  const child = pick(rand, boys.length > 0 ? boys : families)
  const parent = t.minds[child.household.find((i) => t.minds[i].cls !== 'child')]
  const where = { variant: hide.kind, ...hide }

  const pool = t.minds.filter((m) => m.cls !== 'child' && m !== parent && !child.household.includes(m.index))
  const n = Math.min(pool.length, QUESTS.witnesses[0] + ((rand() * (QUESTS.witnesses[1] - QUESTS.witnesses[0] + 1)) | 0))
  const odds = ODD.map((_, i) => i)
  const witnesses = []
  for (let k = 0; k < n; k++) {
    const who = pool.splice((rand() * pool.length) | 0, 1)[0]
    const conf = 0.55 + rand() * 0.4
    // The first saw where the child went; the rest only heard, and most caught the child at something odd first.
    const odd = k > 0 && rand() < 0.75 ? odds.splice((rand() * odds.length) | 0, 1)[0] : null
    witnesses.push({ who: who.id, clue: { kind: k === 0 ? 'saw' : 'heard', conf: k === 0 ? conf : conf * 0.7, x: where.x, z: where.z, label: where.label, odd } })
  }
  return {
    id: `child:${t.town.id}:${epoch}`,
    kind: 'missing-child',
    town: townIndex,
    giver: parent.id,
    parent: parent.id,
    child: child.id,
    where,
    witnesses,
    opening: rand() < QUESTS.nameOnly ? 'name' : 'direction',
    // Whether the parent swears this time it is no false alarm.
    wolf: rand() < 0.5,
  }
}

/** Town `townIndex`'s word to carry in `epoch`, or null: `{ id, kind, town, giver, ghost, to, bond, words, choices }`. `to` is a grown-up in the nearest town, `words` one of MESSAGES, `choices` its four phrasings in the order the recipient offers them; `ghost` null (ghostMessage). */
export function message(world, townIndex, epoch) {
  const t = world.towns[townIndex]
  const rand = mulberry32(hash32(world.seed, SALT_MESSAGE, townIndex, epoch))
  if (rand() >= QUESTS.message) return null
  const givers = t.minds.filter((m) => m.cls !== 'child')
  const near = world.nearestTown(t.town.x, t.town.z, townIndex)
  const takers = near.minds.filter((m) => m.cls !== 'child')
  if (givers.length === 0 || takers.length === 0) return null
  const choices = shuffled(rand)
  return {
    id: `msg:${t.town.id}:${epoch}`,
    kind: 'message',
    town: townIndex,
    giver: pick(rand, givers).id,
    ghost: null,
    to: pick(rand, takers).id,
    bond: pick(rand, BONDS),
    words: pick(rand, MESSAGES),
    choices,
  }
}

/** The four phrasings' indices in the order the recipient offers them. */
function shuffled(rand) {
  const choices = [0, 1, 2, 3]
  for (let i = choices.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    ;[choices[i], choices[j]] = [choices[j], choices[i]]
  }
  return choices
}

/**
 * The ghost of the castle that is town `townIndex`'s hideout, with word for the last of its line in that town, or null:
 * a message (as message) whose `giver` is null and `ghost` `{ name, she, site }`. One ghost a castle, the first town's;
 * the same in every epoch, since a ghost has waited long enough already.
 */
export function ghostMessage(world, townIndex) {
  const hide = world.hideouts[townIndex]
  if (hide === null || hide.kind !== 'castle') return null
  if (world.hideouts.findIndex((h) => h !== null && h.kind === 'castle' && h.site === hide.site) !== townIndex) return null
  const t = world.towns[townIndex]
  const takers = t.minds.filter((m) => m.cls !== 'child')
  if (takers.length === 0) return null
  const rand = mulberry32(hash32(world.seed, SALT_GHOST, townIndex))
  return {
    id: `ghost:${t.town.id}`,
    kind: 'message',
    town: townIndex,
    giver: null,
    ghost: { ...pick(rand, GHOSTS), site: hide.site },
    to: pick(rand, takers).id,
    bond: 'the last of my line',
    words: pick(rand, GHOST_WORDS),
    choices: shuffled(rand),
  }
}

/** Every quest live in `epoch`, keyed by id. */
export function questsFor(world, epoch) {
  const out = new Map()
  for (const t of world.towns) {
    for (const q of [missingChild(world, t.index, epoch), message(world, t.index, epoch), ghostMessage(world, t.index)]) if (q !== null) out.set(q.id, q)
  }
  return out
}

/** Her quests: who asked what, and how far along each is (accepted, then found or delivered or garbled, then done). No hints beyond that. */
export class QuestLog {
  constructor() {
    this.of = new Map()
  }

  accept(q) {
    if (!this.of.has(q.id)) this.of.set(q.id, { quest: q, state: 'accepted' })
  }

  state(id) {
    return this.of.get(id)?.state ?? null
  }

  /** Moves quest `id` to `state`: found, delivered, garbled or done. */
  set(id, state) {
    const e = this.of.get(id)
    if (e === undefined) throw new Error(`QuestLog: ${id} was never accepted`)
    e.state = state
  }

  /** Whether `by` asked her anything still open. */
  askedBy(by) {
    for (const { quest, state } of this.of.values()) if (quest.giver === by && state !== 'done') return true
    return false
  }
}
