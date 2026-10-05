// The quests a town holds (_notes/conversation-and-quests.md), rolled from the seed, the town and the epoch, so every client in a room meets the same distressed parent and the same child is truly in the same place. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'

export const QUESTS = {
  // A quest's life: long enough to ask round a town and walk out to a neighbour.
  epochS: 1800,
  // A town's odds of a missing child in an epoch.
  odds: 0.5,
  // Where a child gone missing may be: [hiding with a friend, gone up a road, lost in the wild], cumulative.
  where: [0.35, 0.7, 1],
  // A child lost in the wild is this far from the fire, metres.
  wild: [120, 350],
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

const SALT = 7201
const SALT_MESSAGE = 7202

export const epochOf = (seconds) => Math.floor(seconds / QUESTS.epochS)

const pick = (rand, list) => list[(rand() * list.length) | 0]

/** Town `townIndex`'s missing child in `epoch`, or null: `{ id, kind, town, parent, child, where, witnesses, covers, opening }`. `where` is `{ variant, x, z, label, host?, toward? }`; each witness `{ who, clue }` with `clue` `{ kind, conf, x, z, label, with? }`; `covers` the ids who will lie to hide the child. */
export function missingChild(world, townIndex, epoch) {
  const t = world.towns[townIndex]
  const rand = mulberry32(hash32(world.seed, SALT, townIndex, epoch))
  if (rand() >= QUESTS.odds) return null
  const families = t.minds.filter((m) => m.cls === 'child' && m.household.some((i) => t.minds[i].cls !== 'child'))
  if (families.length === 0) return null
  const child = pick(rand, families)
  const parent = t.minds[child.household.find((i) => t.minds[i].cls !== 'child')]
  const inn = t.town.buildings.findIndex((b) => b.trade === 'inn')
  const fire = { x: t.town.x, z: t.town.z }

  let roll = rand()
  let where = null
  let covers = []
  if (roll < QUESTS.where[0]) {
    const hosts = child.friends.map((i) => t.minds[i]).filter((m) => m.home !== child.home && m.home !== inn && m.cls !== 'child')
    if (hosts.length > 0) {
      const host = pick(rand, hosts)
      where = { variant: 'hiding', ...world.buildingPlace(t, host.home), host: host.id }
      covers = t.minds.filter((m) => m.home === host.home && m !== child).map((m) => m.id)
    } else roll = QUESTS.where[0]
  }
  if (where === null && roll < QUESTS.where[1] && t.town.roads.length > 0) {
    const toward = world.nearestTown(fire.x, fire.z, townIndex)
    // The road whose far end points most nearly at that town.
    const aim = Math.atan2(toward.town.x - fire.x, toward.town.z - fire.z)
    const off = (pts) => {
      const [x, , z] = pts[pts.length - 1]
      return Math.abs(Math.atan2(Math.sin(Math.atan2(x - fire.x, z - fire.z) - aim), Math.cos(Math.atan2(x - fire.x, z - fire.z) - aim)))
    }
    const road = [...t.town.roads].sort((p, q) => off(p) - off(q))[0]
    const [x, , z] = road[road.length - 1]
    where = { variant: 'road', x, z, label: `the road to ${toward.name}`, toward: toward.index }
  }
  if (where === null) {
    const a = rand() * Math.PI * 2
    const d = QUESTS.wild[0] + rand() * (QUESTS.wild[1] - QUESTS.wild[0])
    where = { variant: 'wild', x: fire.x + Math.sin(a) * d, z: fire.z - Math.cos(a) * d, label: 'out in the wild' }
  }

  const seen = { x: where.x, z: where.z, label: where.label }
  const pool = t.minds.filter((m) => m.cls !== 'child' && m !== parent && !child.household.includes(m.index) && !covers.includes(m.id))
  const n = Math.min(pool.length, QUESTS.witnesses[0] + ((rand() * (QUESTS.witnesses[1] - QUESTS.witnesses[0] + 1)) | 0))
  const witnesses = []
  for (let k = 0; k < n; k++) {
    const who = pool.splice((rand() * pool.length) | 0, 1)[0]
    const conf = 0.55 + rand() * 0.4
    // The first saw where the child went; later ones saw whom the child was with or only heard talk.
    let clue
    if (k === 0) clue = { kind: 'saw', conf, ...seen }
    else if (where.variant === 'hiding' && rand() < 0.6) clue = { kind: 'with', conf, ...seen, with: where.host }
    else clue = { kind: 'heard', conf: conf * 0.7, ...seen }
    witnesses.push({ who: who.id, clue })
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
    covers,
    opening: rand() < QUESTS.nameOnly ? 'name' : 'direction',
  }
}

/** Town `townIndex`'s word to carry in `epoch`, or null: `{ id, kind, town, giver, to, bond, message, choices }`. `to` is a grown-up in the nearest town, `message` an index into MESSAGES, `choices` its four phrasings in the order the recipient offers them. */
export function message(world, townIndex, epoch) {
  const t = world.towns[townIndex]
  const rand = mulberry32(hash32(world.seed, SALT_MESSAGE, townIndex, epoch))
  if (rand() >= QUESTS.message) return null
  const givers = t.minds.filter((m) => m.cls !== 'child')
  const near = world.nearestTown(t.town.x, t.town.z, townIndex)
  const takers = near.minds.filter((m) => m.cls !== 'child')
  if (givers.length === 0 || takers.length === 0) return null
  const choices = [0, 1, 2, 3]
  for (let i = choices.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0
    ;[choices[i], choices[j]] = [choices[j], choices[i]]
  }
  return {
    id: `msg:${t.town.id}:${epoch}`,
    kind: 'message',
    town: townIndex,
    giver: pick(rand, givers).id,
    to: pick(rand, takers).id,
    bond: pick(rand, BONDS),
    message: (rand() * MESSAGES.length) | 0,
    choices,
  }
}

/** Every quest live in `epoch`, keyed by id. */
export function questsFor(world, epoch) {
  const out = new Map()
  for (const t of world.towns) {
    for (const q of [missingChild(world, t.index, epoch), message(world, t.index, epoch)]) if (q !== null) out.set(q.id, q)
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
