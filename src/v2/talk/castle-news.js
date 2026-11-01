// A castle's gossip (design/44-castles.md §Garrison): a few happenings rolled from its seed, so all its folk talk of the same
// ones, each telling them their own way (gossip.js). The first, which all know, is a hint at something there to find. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { pick, cap, an, tellStory } from './gossip.js'

export const CASTLE_NEWS = { stories: 4 }
const SALT = 7120

// How a party is named; only the four with a castle to themselves can own up to a story.
const ROLE = { lord: 'the lord', steward: 'the steward', cook: 'the cook', maid: 'the maid', guard: 'one of the guards' }
const OWN = new Set(['lord', 'steward', 'cook', 'maid'])
// Those on the night watch, who tell a story about it as their own.
const WATCH = new Set(['guard', 'watch', 'gate', 'lore'])
const R = (role) => ROLE[role]
function two(rand, roles) {
  const a = pick(rand, roles)
  return [a, pick(rand, roles.filter((r) => r !== a))]
}

// What the dungeon's noises sound like, and what folk make of each.
const NOISE = {
  footsteps: 'Nobody will say whose.',
  singing: 'Nobody here can carry a tune.',
  'someone counting coins': 'Nobody down there has coin to count.',
  'chains rattling': "The door's locked, and nobody has the key.",
  scratching: 'Rats, the cook says. Very big rats.',
}
// Each room a beast can move into, and what the castle has done about it: true of any beast in that room.
const LODGE = {
  armoury: ['It sleeps in a helmet now.', 'The guards salute it on the way past.'],
  chapel: ['The chaplain says it is a sign and will not let anyone touch it.', 'It sits in the front pew for prayers.'],
  'bell tower': ['Nobody has rung the bell since, in case it minds.', 'It has a name now. Gerald.'],
  'wine cellar': ["It's been at the wine, or so the steward says.", 'The lord says it has better taste than the steward.'],
  'bread oven': ['The cook bakes round it now.', "The bread's been late all week."],
  privy: ["Everyone's been using the bushes.", 'It has a name now. Gerald. Knock first.'],
}
// Who came calling, and what each did.
const VISIT = {
  'a pedlar': 'sold the cook a ladle from our own kitchen',
  'a knight in rusty armour': 'squeaked all the way up the stairs',
  'a man selling bells': 'rang every one of them until the lord bought one',
  'a lady with nine cats': 'left with ten',
  'a very tall monk': 'hit his head on every door in the place',
  'a bard with no lute': 'sang for supper anyway, until the lord paid for some quiet',
}

// Each kind: `pools` its fills, `roll` them and its `parties` (roles), the rest as gossip.js tellStory takes them. `hint` kinds
// tell of something there to find: the dungeon key (layout.js keySpot: the lord's throne room, treasury or bedchamber), the
// dungeon chest, the summit chest and the dungeon itself.
const KINDS = {
  key: {
    hint: true,
    pools: { odd: ['the soup', 'a boot', "the hound's bed", 'the flour bin', 'a pie', 'the privy'] },
    roll: (r, P) => ({ parties: [pick(r, ['cook', 'maid', 'steward', 'guard'])], f: { odd: pick(r, P.odd) } }),
    told: [
      (f, p) => `${cap(R(p[0]))} found the dungeon key in ${f.odd}. The lord has hidden it again, among the lord's own things.`,
      (f, p) => `The dungeon key turned up in ${f.odd}, if you please. ${cap(R(p[0]))} found it. The lord keeps it close now.`,
      (f, p) => `The lord lost the dungeon key, and ${R(p[0])} found it in ${f.odd}. It's locked up with the lord's treasures now.`,
    ],
    mine: (f) => `I found the dungeon key in ${f.odd}. The lord snatched it back and hid it in the lord's rooms. I know which.`,
    muddle: 'odd',
  },
  hoard: {
    hint: true,
    pools: { who: ['the first lord', 'a miser king', 'a dragon-slayer', 'the old steward', 'a smuggler'], what: ['coin', 'gold', 'treasure', 'loot'] },
    roll: (r, P) => ({ parties: [], f: { who: pick(r, P.who), what: pick(r, P.what) } }),
    told: [
      (f) => `They say ${f.who} left a chest of ${f.what} at the bottom of the dungeon. Behind a locked door, of course.`,
      (f) => `There's ${f.what} down in the dungeon, they say. ${cap(f.who)} put it there. Nobody has the nerve to fetch it.`,
      (f) => `Somebody's grandad swore ${f.who} hid ${f.what} in the deepest room of the dungeon. The door is always locked.`,
    ],
    muddle: 'who',
  },
  summit: {
    hint: true,
    pools: { in: ['his lunch', 'a crown', 'his old boots', 'love letters', 'gold', 'a very small goat'] },
    roll: (r, P) => ({ parties: [], f: { in: pick(r, P.in) } }),
    told: [
      (f) => `The old guard keeps a chest at the very top of the lookout. Says it's ${f.in}. Nobody believes him.`,
      (f) => `There's a chest up on the summit. The old guard sits on it all day. ${cap(f.in)}, he says.`,
      (f) => `Climb the lookout and you'll find a chest by the old guard. ${cap(f.in)} in it, if you believe him.`,
    ],
    muddle: 'in',
  },
  feud: {
    pools: { thing: ['a turnip', 'a ladle', 'the last pie', 'a borrowed spoon', 'the warm chair', 'a goose', 'a hat', 'who snores'] },
    roll: (r, P) => ({ parties: two(r, ['lord', 'steward', 'cook', 'maid', 'guard']), f: { thing: pick(r, P.thing) } }),
    told: [
      (f, p) => `${cap(R(p[0]))} and ${R(p[1])} aren't speaking. Something about ${f.thing}.`,
      (f, p) => `${cap(R(p[0]))} won't sit at table with ${R(p[1])}. Over ${f.thing}, of all things.`,
      (f, p) => `There's a war on between ${R(p[0])} and ${R(p[1])}. It started with ${f.thing}.`,
    ],
    mine: (f, i, p) => `${cap(R(p[1 - i]))} and I aren't speaking. It's about ${f.thing}, and I was in the right.`,
    side: (f, i, p) => `If you ask me, ${R(p[i])} started it.`,
    muddle: 'thing',
  },
  pet: {
    pools: { beast: ['hound', 'cat', 'goose', 'goat', 'pig', 'ferret'], did: ['chewed a boot', 'chewed the tapestry', "stole the steward's hat", 'slept on the throne', 'got into the larder', 'bit the chaplain', 'fell in the well'] },
    roll: (r, P) => ({ parties: ['lord'], f: { beast: pick(r, P.beast), did: pick(r, P.did) } }),
    told: [
      (f) => `The lord's ${f.beast} ${f.did} again.`,
      (f) => `Have you met the lord's ${f.beast}? It ${f.did} this morning.`,
      (f) => `Nobody is to mention it, but the lord's ${f.beast} ${f.did}.`,
    ],
    mine: (f) => `My ${f.beast} ${f.did}. I am told this is somehow my fault.`,
    muddle: 'beast',
    as: (v) => `the ${v}`,
  },
  nest: {
    pools: { beast: ['crow', 'owl', 'bat', 'badger', 'swan', 'hedgehog'], room: Object.keys(LODGE) },
    roll: (r, P) => {
      const room = pick(r, P.room)
      return { parties: [], f: { beast: pick(r, P.beast), room, twist: pick(r, LODGE[room]) } }
    },
    told: [
      (f) => `${cap(an(f.beast))} has moved into the ${f.room}. ${f.twist}`,
      (f) => `We have a new lodger: ${an(f.beast)}, in the ${f.room}. ${f.twist}`,
      (f) => `Don't go in the ${f.room}. There's ${an(f.beast)} in there. ${f.twist}`,
    ],
    muddle: 'beast',
    as: an,
  },
  noise: {
    hint: true,
    pools: { sound: Object.keys(NOISE) },
    roll: (r, P) => ({ parties: ['watch'], f: { sound: pick(r, P.sound) } }),
    told: [
      (f) => `Some nights you can hear ${f.sound} down in the dungeon. ${NOISE[f.sound]}`,
      (f) => `The night watch hears ${f.sound} under the floors, where the dungeon is. ${NOISE[f.sound]}`,
      (f) => `Nobody goes down to the dungeon, but at night you hear ${f.sound} from it. ${NOISE[f.sound]}`,
    ],
    mine: (f) => `On night watch I hear ${f.sound} under the floors, down by the dungeon. ${NOISE[f.sound]}`,
    muddle: 'sound',
  },
  visitor: {
    pools: { who: Object.keys(VISIT) },
    roll: (r, P) => ({ parties: [], f: { who: pick(r, P.who) } }),
    told: [
      (f) => `${cap(f.who)} came to the gate yesterday and ${VISIT[f.who]}.`,
      (f) => `We had a guest the other day, ${f.who}, who ${VISIT[f.who]}.`,
      (f) => `${cap(f.who)} stayed the night and ${VISIT[f.who]}.`,
    ],
  },
  broke: {
    pools: { thing: ['well rope', 'kitchen bell', 'gate chain', 'big soup pot', 'throne leg', 'chapel door'], after: ['Nobody will own up.', 'Everybody blames everybody.', 'The new one cost a fortune.', "It's tied up with string for now."] },
    roll: (r, P) => ({ parties: ['steward'], f: { thing: pick(r, P.thing), after: pick(r, P.after) } }),
    told: [
      (f) => `The ${f.thing} gave out. ${f.after}`,
      (f) => `Did you hear the ${f.thing} broke? ${f.after}`,
      (f) => `The ${f.thing} broke again. ${f.after}`,
    ],
    mine: (f) => `The ${f.thing} broke, and the mending comes out of my accounts. ${f.after}`,
    muddle: 'thing',
    as: (v) => `the ${v}`,
  },
  sweet: {
    pools: { did: ['walking the walls', 'sharing a pie', 'laughing in the stairwell', 'holding hands in the pantry', 'swapping verses'] },
    roll: (r, P) => ({ parties: two(r, ['steward', 'cook', 'maid', 'guard']), f: { did: pick(r, P.did) } }),
    told: [
      (f, p) => `${cap(R(p[0]))} and ${R(p[1])} were seen ${f.did} together.`,
      (f, p) => `Guess who was caught ${f.did}? ${cap(R(p[0]))} and ${R(p[1])}!`,
      (f, p) => `${cap(R(p[0]))} has been ${f.did} with ${R(p[1])} every evening.`,
    ],
    mine: (f, i, p) => `Yes, ${R(p[1 - i])} and I were ${f.did}. What of it?`,
    side: (f, i, p) => `${cap(R(p[i]))} has been mooning about for months, if you ask me.`,
    muddle: 'did',
  },
}

/** Castle `seed`'s stories, the same on every client: `[{ kind, f, parties, key }]`, no two of a kind, the first a hint. */
export function castleNews(seed) {
  const rand = mulberry32(hash32(seed, SALT))
  const kinds = Object.keys(KINDS), hints = kinds.filter((k) => KINDS[k].hint)
  const order = [pick(rand, hints)]
  while (order.length < CASTLE_NEWS.stories) {
    const rest = kinds.filter((k) => !order.includes(k))
    order.push(pick(rand, rest))
  }
  return order.map((kind, key) => ({ kind, key, ...KINDS[kind].roll(rand, KINDS[kind].pools) }))
}

/** Story `s` as castle folk `mind` ({ who, traits, h }) tells it. */
export function tellCastle(s, mind, rand) {
  const me = (p) => (OWN.has(mind.who) && p === mind.who) || (p === 'watch' && WATCH.has(mind.who))
  return tellStory(bound(KINDS[s.kind], s.parties), s, mind, rand, (p) => (me(p) ? 'me' : null))
}

/** Kind `K` with its wordings handed `parties`, as gossip.js takes them. */
function bound(K, parties) {
  const out = { ...K, told: K.told.map((t) => (f) => t(f, parties)) }
  if (K.mine !== undefined) out.mine = (f, i) => K.mine(f, i, parties)
  if (K.side !== undefined) out.side = (f, i) => K.side(f, i, parties)
  return out
}

/** Every bare telling of every fill, for check-talk to walk against the caption. */
export function allCastleBodies() {
  const out = []
  for (const [kind, K] of Object.entries(KINDS)) for (let i = 0; i < 40; i++) {
    const s = K.roll(mulberry32(hash32(i, SALT, Object.keys(KINDS).indexOf(kind))), K.pools)
    out.push(...K.told.map((t) => t(s.f, s.parties)))
    if (K.mine !== undefined) out.push(K.mine(s.f, 0, s.parties))
  }
  return out
}
