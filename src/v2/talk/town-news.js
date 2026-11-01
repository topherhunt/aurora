// A town's gossip (_notes/conversation-and-quests.md §Gossip): a few happenings among its real folk, rolled from the seed, each
// told its own way by every teller (gossip.js), whose ties to those it is about pick the side they take. The first, which all
// know, gives away somewhere near: the next town, the dragon roost or the town's hideout, by its true direction. Most of the
// rest are true hints at how things work, wrapped in a story. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { pick, cap, tellStory } from './gossip.js'

// A roost past `roostM` is too far off for a town to talk of.
export const TOWN_NEWS = { hints: 2, colour: 2, roostM: 2500 }
const SALT = 7130

const pr = (he) => (he ? { he: 'he', him: 'him', his: 'his' } : { he: 'she', him: 'her', his: 'her' })
const grown = (c) => c.t.minds.filter((m) => m.cls !== 'child')
const named = (ms) => ({ n: ms.map((m) => m.name), p: ms.map((m) => pr(m.voice.he)) })
const isKin = (a, b) => a.household.includes(b.index)
/** One of `list` picked on `r` as a story's only party, with fills `more`. */
const one = (r, list, more = {}) => {
  const m = pick(r, list)
  return { parties: [m.index], f: { ...named([m]), ...more } }
}

// Each kind: `when(c)` it can happen in town context `c`, `roll(r, c)` its `parties` (mind indexes) and fills `f` (`n` and `p`
// the parties' names and pronouns), `unlocks` the gated lore it names, `towns` the town indexes it names; the rest as
// gossip.js tellStory takes them. A place kind's direction is a fact, so only a colour fill may `muddle`.
const KINDS = {
  // Places, one of which every town knows.
  lover: {
    place: true,
    when: (c) => c.near !== null,
    roll: (r, c) => ({ parties: [], f: { town: c.near.name, dir: c.near.dir, mood: pick(r, KINDS.lover.pools.mood) } }),
    told: [
      (f) => `One of our striders is sweet on a strider in ${f.town}. It won't take a road unless it leads ${f.dir}.`,
      (f) => `Our striders all pull ${f.dir} now. One of them has a sweetheart over in ${f.town}, and the rest take its side.`,
      (f) => `There's a strider at the rail that ${f.mood} all night, facing ${f.dir}. It's in love with one in ${f.town}.`,
    ],
    pools: { mood: ['sulks', 'sighs', 'stamps', 'sings'] },
  },
  dragon: {
    place: true,
    when: (c) => c.roost !== null,
    roll: (r, c) => one(r, grown(c), { dir: c.roost.dir, far: c.roost.far, lost: pick(r, KINDS.dragon.pools.lost) }),
    told: [
      (f) => `${f.n[0]} went ${f.dir} to the dragon's roost after an egg. ${cap(f.far)} there and back, and ${f.p[0].he} came home without ${f.p[0].his} ${f.lost}.`,
      (f) => `Did you hear? ${f.n[0]} climbed to the dragon's roost, ${f.far} ${f.dir} of here. Lost ${f.p[0].his} ${f.lost}, and no egg.`,
      (f) => `${f.n[0]} swears there's an egg in the dragon's nest ${f.dir} of here. Went for it. Came back without ${f.p[0].his} ${f.lost}.`,
    ],
    mine: (f) => `I went for the egg at the dragon's roost, ${f.far} ${f.dir} of here. I lost my ${f.lost}. I'll go again.`,
    kin: (f) => `Our ${f.n[0]} went for a dragon's egg, ${f.dir} of here, and came home without ${f.p[0].his} ${f.lost}. Never again, I said.`,
    pools: { lost: ['eyebrows', 'hat', 'cloak', 'boots'] },
    muddle: 'lost',
    as: (v, f) => `${f.p[0].his} ${v}`,
    unlocks: ['dragons'],
  },
  cave: {
    place: true,
    when: (c) => c.hide !== null && c.hide.kind === 'cave' && c.kids.length > 0,
    roll: (r, c) => one(r, c.kids, { cave: c.hide.label }),
    told: [
      (f) => `The children dare each other into ${f.cave}. ${f.n[0]} went in furthest and came out with a green stone.`,
      (f) => `${f.n[0]} went into ${f.cave} on a dare. Came back with a lump of jade and no candle.`,
      (f) => `Keep the children out of ${f.cave}. ${f.n[0]} found a green stone near the mouth, and now they all want one.`,
    ],
    mine: (f) => `I went into ${f.cave}, furthest of anyone! I found a green stone by the mouth. It's mine, I'm keeping it.`,
    kin: (f) => `Our ${f.n[0]} went into ${f.cave} on a dare. Came home with a green stone and got a scolding for it.`,
    unlocks: ['caves', 'gems'],
  },
  castle: {
    place: true,
    when: (c) => c.hide !== null && c.hide.kind === 'castle',
    roll: (r, c) => one(r, grown(c), { dir: c.hide.dir, ware: pick(r, ['eggs', 'cheese', 'candles', 'wool']) }),
    told: [
      (f) => `${f.n[0]} took ${f.ware} up to the old castle, ${f.dir} of here. Their lord's lost the dungeon key again, ${f.p[0].he} says.`,
      (f) => `Word from the old castle to the ${f.dir}: the lord mislaid the dungeon key. ${f.n[0]} heard it selling ${f.ware}.`,
    ],
    mine: (f) => `I sell ${f.ware} at the old castle, ${f.dir} of here. Their lord's lost the dungeon key again. Hides it, loses it.`,
    pools: { ware: ['eggs', 'cheese', 'candles', 'wool'] },
    muddle: 'ware',
  },

  // How things work, wrapped in a story.
  pumpkins: {
    hint: true,
    when: (c) => c.farmer !== null && c.kids.length > 0,
    roll: (r, c) => {
      const kid = pick(r, c.kids)
      return { parties: [kid.index, c.farmer.index], f: named([kid, c.farmer]) }
    },
    told: [
      (f) => `${f.n[0]} carved rude faces in all of ${f.n[1]}'s pumpkins with a knife from the smith. No more knives for ${f.p[0].him}.`,
      (f) => `${f.n[0]} cut faces in every pumpkin on ${f.n[1]}'s back row, then lit them with a flint. ${f.n[1]} screamed the place down.`,
      (f) => `${f.n[1]} won't touch ${f.p[1].his} pumpkins. ${f.n[0]} carved faces in them all. Even the striders won't eat them. Fish or nothing.`,
    ],
    mine: (f, i) => (i === 0
      ? `I only carved a few faces in the pumpkins. With the smith's little knife. Now nobody will let me near a knife.`
      : `${f.n[0]} carved faces in every one of my pumpkins. I tried them on the striders. They'll only eat fish.`),
    kin: (f, i) => (i === 0
      ? `Our ${f.n[0]} is banned from knives. Carved faces in every pumpkin ${f.n[1]} had, and lit them with a flint.`
      : `${f.n[0]} carved faces in all our pumpkins. We can't sell them, and the striders only eat fish.`),
    side: (f, i) => (i === 0 ? `I blame ${f.n[0]}, the little horror.` : `Mind you, ${f.n[1]} leaves that field wide open.`),
  },
  agaric: {
    hint: true,
    when: (c) => grown(c).length > 0,
    roll: (r, c) => one(r, grown(c), { seen: pick(r, ['green fire on the hills', 'green flames far off', 'things burning green']) }),
    told: [
      (f) => `${f.n[0]} ate a red mushroom with white spots and swore ${f.p[0].he} saw ${f.seen}. Far off, where nothing was.`,
      (f) => `${f.n[0]} ate a fly agaric for a bet. Saw ${f.seen} till morning, and went out digging after it.`,
    ],
    mine: (f) => `I ate a fly agaric for a bet. I saw ${f.seen}, far off. Something's out there, I tell you.`,
    kin: (f) => `Our ${f.n[0]} ate a fly agaric and saw ${f.seen} all night. Wants to go looking for it now.`,
    pools: { seen: ['green fire on the hills', 'green flames far off', 'things burning green'] },
    unlocks: ['mushrooms'],
  },
  flare: {
    hint: true,
    when: (c) => grown(c).length > 0,
    roll: (r, c) => one(r, grown(c), { at: pick(r, ['the privy', 'the inn', 'the well', 'home']) }),
    told: [
      (f) => `${f.n[0]} fired a flare onto ${f.p[0].his} roof to find ${f.at} in the dark. It's still burning up there.`,
      (f) => `There's a flare stuck on ${f.n[0]}'s roof, glowing day and night. ${cap(f.p[0].he)} says it's to find ${f.at} by.`,
    ],
    mine: (f) => `Yes, the flare on my roof is mine. I put it there to find ${f.at} by. Never once lost my way since.`,
    pools: { at: ['the privy', 'the inn', 'the well', 'home'] },
    muddle: 'at',
    unlocks: ['flares'],
  },
  spiders: {
    hint: true,
    when: (c) => c.kids.length > 0,
    roll: (r, c) => one(r, c.kids),
    told: [
      (f) => `${f.n[0]} brought a spider home in ${f.p[0].his} fist and held it up to a strider. The poor beast bolted halfway to the hills.`,
      (f) => `${f.n[0]} keeps a little wood spider in a cup. Holds it up and the striders shy off. Nobody can catch ${f.p[0].him}.`,
    ],
    mine: (f) => `I've got a spider! A little one from the woods. Hold it up and the striders all jump. Want to see?`,
    kin: (f) => `Our ${f.n[0]} keeps a spider in a cup. Scared a strider off its rail with it. I've had words.`,
    unlocks: ['spiders'],
  },
  sword: {
    hint: true,
    when: (c) => c.guard !== null && grown(c).length > 1,
    roll: (r, c) => {
      const who = pick(r, grown(c).filter((m) => m !== c.guard))
      return { parties: [who.index, c.guard.index], f: named([who, c.guard]) }
    },
    told: [
      (f) => `${f.n[0]} walked into town waving a new sword. ${f.n[1]} had words, and nobody would sell ${f.p[0].him} so much as a turnip.`,
      (f) => `${f.n[0]} came up the road with a sword out. ${f.n[1]} made ${f.p[0].him} put it away before anyone would speak to ${f.p[0].him}.`,
    ],
    mine: (f, i) => (i === 0
      ? `I only had my sword out to show it off. ${f.n[1]} told me off, and the whole town shunned me. Lesson learnt.`
      : `${f.n[0]} came in with a sword drawn. I had words. Nobody talks to a drawn blade here.`),
    side: (f, i) => (i === 0 ? `Serves ${f.p[0].him} right.` : `${f.n[1]} was too hard on ${f.p[0].him}, if you ask me.`),
    unlocks: ['weapons'],
  },
  leafkin: {
    hint: true,
    when: (c) => c.kids.length > 0,
    roll: (r, c) => one(r, c.kids),
    told: [
      (f) => `${f.n[0]} says a little leaf-man came up to ${f.p[0].him} in the woods, after a mushroom ${f.p[0].he} had. They're friends now.`,
      (f) => `${f.n[0]} swears ${f.p[0].he} gave a mushroom to a leafkin, and it talked to ${f.p[0].him}. Nobody believes a word.`,
    ],
    mine: (f) => `I gave a leafkin my mushroom and it talked to me! Nobody believes me. You believe me, don't you?`,
    kin: (f) => `Our ${f.n[0]} keeps saying a leafkin talked to ${f.p[0].him}, after ${f.p[0].he} gave it a mushroom. Children.`,
    unlocks: ['leafkin', 'mushrooms'],
  },
  yeti: {
    hint: true,
    when: (c) => grown(c).length > 0,
    roll: (r, c) => one(r, grown(c)),
    told: [
      (f) => `${f.n[0]} went up into the snow and came back white as milk. Says something hooted and threw snow at ${f.p[0].him}.`,
      (f) => `${f.n[0]} heard drumming up in the snow, and a great white thing came for ${f.p[0].him}. Ran all the way home.`,
    ],
    mine: (f) => `Up in the snow, something hooted at me and threw snow. Then it came. I didn't stay to see what.`,
    unlocks: ['yetis'],
  },

  // Colour.
  feud: {
    when: (c) => c.rivals.length > 0,
    roll: (r, c) => {
      const [a, b] = pick(r, c.rivals)
      return { parties: [a.index, b.index], f: { ...named([a, b]), thing: pick(r, KINDS.feud.pools.thing) } }
    },
    pools: { thing: ['a goose', 'a fence', 'the last pie', 'a borrowed ladder', 'whose turn it was', 'a pig', 'a song'] },
    told: [
      (f) => `${f.n[0]} and ${f.n[1]} aren't speaking. It's about ${f.thing}.`,
      (f) => `${f.n[0]} won't sit near ${f.n[1]} at the fire. Over ${f.thing}, of all things.`,
      (f) => `There's war on between ${f.n[0]} and ${f.n[1]}. It started with ${f.thing}.`,
    ],
    mine: (f, i) => `${f.n[1 - i]} and I aren't speaking. It's about ${f.thing}, and I was in the right.`,
    kin: (f, i) => `Our ${f.n[i]} and ${f.n[1 - i]} are at it again. Over ${f.thing}. ${f.n[1 - i]} started it.`,
    side: (f, i) => `If you ask me, ${f.n[i]} started it.`,
    muddle: 'thing',
  },
  sweet: {
    when: (c) => c.pairs.length > 0,
    roll: (r, c) => {
      const [a, b] = pick(r, c.pairs)
      return { parties: [a.index, b.index], f: { ...named([a, b]), did: pick(r, KINDS.sweet.pools.did) } }
    },
    pools: { did: ['walking out by the fields', 'sharing a pie', 'singing by the fire', 'holding hands at the well', 'picking flowers'] },
    told: [
      (f) => `${f.n[0]} and ${f.n[1]} were seen ${f.did} together.`,
      (f) => `Guess who was caught ${f.did}? ${f.n[0]} and ${f.n[1]}!`,
      (f) => `${f.n[0]} has been ${f.did} with ${f.n[1]}. Every evening.`,
    ],
    mine: (f, i) => `Yes, ${f.n[1 - i]} and I were ${f.did}. What of it?`,
    kin: (f, i) => `Our ${f.n[i]} is sweet on ${f.n[1 - i]}. We're all pretending not to notice.`,
    side: (f, i) => `I always said ${f.n[i]} was sweet on ${f.p[1 - i].him}.`,
    muddle: 'did',
  },
  goat: {
    when: (c) => grown(c).length > 0,
    roll: (r, c) => one(r, grown(c), { beast: pick(r, KINDS.goat.pools.beast), did: pick(r, KINDS.goat.pools.did) }),
    pools: { beast: ['goat', 'goose', 'pig', 'hen', 'cat'], did: ['ate the washing', 'got onto the roof', 'chased the jarl', 'fell in the well', 'slept in the bread oven', 'won a race'] },
    told: [
      (f) => `${f.n[0]}'s ${f.beast} ${f.did} again.`,
      (f) => `Have you met ${f.n[0]}'s ${f.beast}? It ${f.did} this morning.`,
      (f) => `Don't tell ${f.n[0]} I said, but ${f.p[0].his} ${f.beast} ${f.did}.`,
    ],
    mine: (f) => `My ${f.beast} ${f.did}. Somehow this is my fault.`,
    kin: (f) => `Our ${f.beast} ${f.did}. ${f.n[0]} won't hear a word against it.`,
    muddle: 'beast',
    as: (v) => `the ${v}`,
  },
}

/** The context town entry `t` of TalkWorld `world` rolls its news in. */
function townContext(world, t) {
  const { x, z } = t.town, minds = t.minds
  const kids = minds.filter((m) => m.cls === 'child')
  const rivals = minds.filter((m) => m.rival !== null && m.index < m.rival).map((m) => [m, minds[m.rival]])
  const adults = minds.filter((m) => m.cls !== 'child')
  const pairs = adults.flatMap((a) => adults.filter((b) => a.index < b.index && !isKin(a, b) && a.rival !== b.index).map((b) => [a, b]))
  const near = world.towns.length > 1 ? world.nearestTown(x, z, t.index) : null
  const hide = world.hideouts[t.index]
  const roost = world.roosts.filter((o) => Math.hypot(o.x - x, o.z - z) < TOWN_NEWS.roostM).reduce((a, b) => (a === null || Math.hypot(b.x - x, b.z - z) < Math.hypot(a.x - x, a.z - z) ? b : a), null)
  return {
    t, kids, rivals, pairs,
    farmer: minds.find((m) => m.trade === 'farm' && m.cls !== 'child') ?? null,
    guard: minds.find((m) => m.cls === 'guard') ?? null,
    near: near === null ? null : { name: near.name, index: near.index, x: near.town.x, z: near.town.z, dir: world.way(t.town, near.town).dir },
    roost: roost === null ? null : { ...world.way(t.town, roost), x: roost.x, z: roost.z },
    hide: hide === null ? null : { ...hide, dir: world.way(t.town, hide).dir },
  }
}

/** Town entry `t`'s stories, the same on every client: `[{ kind, f, parties, key }]`, a place first, then hints and colour in turn. */
export function townNews(world, t) {
  const c = townContext(world, t), rand = mulberry32(hash32(world.seed, SALT, t.index))
  const can = (p) => Object.keys(KINDS).filter((k) => p(KINDS[k]) && KINDS[k].when(c))
  const draw = (pool, n) => {
    const out = []
    while (out.length < n && pool.length > 0) out.push(pool.splice((rand() * pool.length) | 0, 1)[0])
    return out
  }
  const places = can((K) => K.place), hints = draw(can((K) => K.hint), TOWN_NEWS.hints), colour = draw(can((K) => !K.place && !K.hint), TOWN_NEWS.colour)
  const order = [...draw(places, 1)]
  for (let i = 0; i < Math.max(hints.length, colour.length); i++) order.push(...[hints[i], colour[i]].filter((k) => k !== undefined))
  return order.map((kind, key) => ({ kind, key, ...KINDS[kind].roll(rand, c) }))
}

/** What story `s` of town entry `t` names: `{ unlocks, people (mind indexes), town (an index or null), toward ({ x, z } of the place it tells of, or null) }`. */
export function storyNames(world, t, s) {
  const K = KINDS[s.kind], c = townContext(world, t)
  const at = { lover: () => c.near, dragon: () => c.roost, cave: () => c.hide, castle: () => c.hide }[s.kind]
  return { unlocks: K.unlocks ?? [], people: s.parties, town: s.kind === 'lover' ? c.near.index : null, toward: at === undefined ? null : { x: at().x, z: at().z } }
}

/** How townsperson `mind` stands to party index `p` of their own town: 'me', 'kin', 'friend', 'rival' or null. */
export function tie(mind, p) {
  if (p === mind.index) return 'me'
  if (mind.household.includes(p)) return 'kin'
  if (mind.friends.includes(p)) return 'friend'
  return mind.rival === p ? 'rival' : null
}

/** Story `s` as townsperson `teller` ({ index, household, friends, rival, traits, h }) tells it. */
export function tellTown(s, teller, rand) {
  return tellStory(KINDS[s.kind], s, teller, rand, (p) => tie(teller, p))
}

export const allTownKinds = () => Object.keys(KINDS)
