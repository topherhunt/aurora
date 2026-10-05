// Who each person is beneath their trade (_notes/conversation-and-quests.md): a name, a household, friends and a rival, and a temperament, rolled from the world seed and the town so every client meets the same people. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { TRADES } from '../layers/trades.js'

const SALT = { town: 7101, mind: 7102, ties: 7103, leafkin: 7104 }

export const TRAITS = ['honesty', 'accuracy', 'chattiness', 'boast', 'wariness', 'greed', 'kindness']

// Added to a uniform roll before clamping: what a body's trade or class leans toward.
const LEAN = {
  travel: { honesty: -0.1, wariness: 0.1 },
  guard: { honesty: 0.15, wariness: 0.25, chattiness: -0.15 },
  child: { accuracy: -0.3, wariness: -0.3, boast: 0.15, greed: -0.2 },
  thief: { honesty: -0.4, greed: 0.3 },
  skald: { boast: 0.4, chattiness: 0.35, accuracy: -0.1 },
  healer: { kindness: 0.35, honesty: 0.15 },
  trapper: { chattiness: -0.25, accuracy: 0.15 },
  innkeeper: { chattiness: 0.35, wariness: -0.15 },
  blacksmith: { greed: 0.2, honesty: 0.1 },
  alchemist: { accuracy: 0.2, boast: 0.15 },
  jarlsthane: { wariness: 0.2, boast: 0.15 },
  herbalist: { kindness: 0.2, accuracy: 0.1 },
  shepherd: { kindness: 0.1 },
}

// Names carry no sex: the avatars are not tagged, so every name may belong to anyone.
const NAMES = [
  'Ragna', 'Tove', 'Eirik', 'Sigrun', 'Halvard', 'Ylva', 'Bjarni', 'Asta', 'Torvald', 'Gisela', 'Leif', 'Solveig', 'Orm', 'Hilde', 'Arne', 'Ingrid',
  'Sten', 'Brynja', 'Kare', 'Freydis', 'Ulf', 'Gunnhild', 'Ivar', 'Thora', 'Rune', 'Dagny', 'Finn', 'Signe', 'Hakon', 'Embla', 'Odd', 'Liv',
  'Tomas', 'Wenna', 'Mara', 'Edvin', 'Runa', 'Alvar', 'Kelda', 'Jorun', 'Bodil', 'Esben', 'Hedda', 'Ketil', 'Maren', 'Njal', 'Vigdis', 'Yngve',
]
const TOWN_HEAD = ['Brack', 'Ost', 'Hollin', 'Gray', 'Ash', 'Thorn', 'Elder', 'Fenn', 'Kettle', 'Mire', 'Wolf', 'Stone', 'Birch', 'Raven', 'Cold', 'Haw']
const TOWN_TAIL = ['water', 'ry', 'stead', 'by', 'ford', 'mere', 'holt', 'wick', 'dale', 'fell', 'heim', 'vik', 'ness', 'garth']
const LEAFKIN_NAMES = ['Pip', 'Nub', 'Tuk', 'Mossle', 'Burr', 'Snib', 'Quill', 'Dob', 'Fennick', 'Wort', 'Grub', 'Tansy', 'Lumm', 'Skib', 'Hob', 'Peck']

const pick = (rand, list) => list[(rand() * list.length) | 0]
const clamp01 = (v) => Math.max(0, Math.min(1, v))

function temperament(rand, leans) {
  const t = {}
  for (const k of TRAITS) {
    // The mean of two rolls: most people sit near the middle, the extremes are rare and so remembered.
    let v = (rand() + rand()) / 2
    for (const lean of leans) v += lean?.[k] ?? 0
    t[k] = clamp01(v)
  }
  return t
}

/** Town `index`'s name, the same on every client. */
export function townName(seed, index) {
  const rand = mulberry32(hash32(seed, SALT.town, index))
  const head = pick(rand, TOWN_HEAD)
  let tail = pick(rand, TOWN_TAIL)
  if (head.toLowerCase().endsWith(tail[0])) tail = TOWN_TAIL[(TOWN_TAIL.indexOf(tail) + 1) % TOWN_TAIL.length]
  return head + tail
}

/** A mind for each of the town's folk (layers/towns.js `town.folk`), in folk order: `{ id, kind, name, body, trade, cls, home, work, household, friends, rival, traits }`, ties as folk indexes. */
export function castMinds(seed, town, townIndex) {
  const rand = mulberry32(hash32(seed, SALT.mind, townIndex))
  const names = [...NAMES]
  const minds = town.folk.map((f, i) => {
    const cls = TRADES.roles[f.body]
    if (cls === undefined) throw new Error(`castMinds: ${f.body} has no class in TRADES.roles`)
    const name = names.splice((rand() * names.length) | 0, 1)[0]
    return { id: `${town.id}:${i}`, index: i, kind: 'human', town: townIndex, name, body: f.body, trade: f.trade, cls, home: f.home, work: f.work, household: [], friends: [], rival: null, traits: temperament(rand, [LEAN[cls], LEAN[f.body]]) }
  })
  // Lodgers at the inn are not the innkeeper's household.
  const inn = town.buildings.findIndex((b) => b.trade === 'inn')
  for (const m of minds) {
    if (m.home === inn && m.trade !== 'inn') continue
    m.household = minds.filter((o) => o !== m && o.home === m.home && !(o.home === inn && o.trade !== 'inn')).map((o) => o.index)
  }
  const ties = mulberry32(hash32(seed, SALT.ties, townIndex))
  for (const m of minds) {
    const others = minds.filter((o) => o !== m && !m.household.includes(o.index))
    while (m.friends.length < 2 && others.length > 0) {
      const o = others.splice((ties() * others.length) | 0, 1)[0]
      if (o.rival === m.index) continue
      m.friends.push(o.index)
      if (!o.friends.includes(m.index)) o.friends.push(m.index)
    }
    if (m.rival === null && ties() < 0.4) {
      const free = others.filter((o) => o.rival === null && !m.friends.includes(o.index))
      if (free.length > 0) {
        const o = pick(ties, free)
        m.rival = o.index
        o.rival = m.index
      }
    }
  }
  return minds
}

/** Minds for a leafkin village's `count` villagers seeded `seed` (villagers.js), `homes[i]` villager i's house. Leafkin are honest and spacey, wary until fed. */
export function villageMinds(seed, count, homes) {
  const rand = mulberry32(hash32(seed, SALT.leafkin))
  const names = [...LEAFKIN_NAMES]
  const lean = { honesty: 0.2, accuracy: -0.25, wariness: 0.3, boast: -0.1 }
  const minds = Array.from({ length: count }, (_, i) => {
    const name = names.length > 0 ? names.splice((rand() * names.length) | 0, 1)[0] : `${pick(rand, LEAFKIN_NAMES)}-${i}`
    return { id: `lk${seed.toString(36)}:${i}`, index: i, kind: 'leafkin', name, body: 'leafkin', trade: 'gather', cls: 'leafkin', home: homes[i], work: null, household: [], friends: [], rival: null, traits: temperament(rand, [lean]) }
  })
  for (const m of minds) m.household = minds.filter((o) => o !== m && o.home === m.home).map((o) => o.index)
  return minds
}
