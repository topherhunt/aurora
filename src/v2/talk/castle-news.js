// A castle's gossip (design/44-castles.md §Garrison): a few happenings rolled from its seed, so all its folk talk of the same
// ones, each told in the teller's way: their temper's lead-in and sign-off, their side in a quarrel, a detail a spacey one
// gets wrong, and the first person from whoever the story is about. Each knows only some of the stories. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { fits } from './caption.js'

export const NEWS = {
  stories: 4,
  // Odds a teller knows each story past the first, which all know.
  knows: 0.6,
  // Muddle odds against a fully spacey teller; odds of a lead-in, a sign-off and a side taken.
  muddle: 0.4, lead: 0.7, tail: 0.5, side: 0.5,
}
const SALT = { story: 7120, know: 7121, side: 7122 }

const pick = (rand, list) => list[(rand() * list.length) | 0]
const cap = (s) => s[0].toUpperCase() + s.slice(1)
// How a party is named; only the four with a castle to themselves can own up to a story.
const ROLE = { lord: 'the lord', steward: 'the steward', cook: 'the cook', maid: 'the maid', guard: 'one of the guards' }
const OWN = new Set(['lord', 'steward', 'cook', 'maid'])
const R = (role) => ROLE[role]
function two(rand, roles) {
  const a = pick(rand, roles)
  return [a, pick(rand, roles.filter((r) => r !== a))]
}

// Each kind: `roll` its fills, `told` ways a bystander tells it, `mine` the way a party does (`me` the teller's role, `other`
// the other party's), `side` a two-party story's take, `muddle` the fill a spacey teller may get wrong.
const KINDS = {
  feud: {
    pools: { thing: ['a turnip', 'a ladle', 'the last pie', 'a borrowed spoon', 'the warm chair', 'a goose', 'a hat', 'who snores'] },
    roll: (r, P) => { const [a, b] = two(r, ['lord', 'steward', 'cook', 'maid', 'guard']); return { a, b, thing: pick(r, P.thing) } },
    told: [
      (f) => `${cap(R(f.a))} and ${R(f.b)} aren't speaking. Something about ${f.thing}.`,
      (f) => `${cap(R(f.a))} won't sit at table with ${R(f.b)}. Over ${f.thing}, of all things.`,
      (f) => `There's a war on between ${R(f.a)} and ${R(f.b)}. It started with ${f.thing}.`,
    ],
    mine: (f, other) => `${cap(R(other))} and I aren't speaking. It's about ${f.thing}, and I was in the right.`,
    side: (f, a) => `If you ask me, ${R(a ? f.a : f.b)} started it.`,
    muddle: 'thing',
  },
  pet: {
    pools: { beast: ['hound', 'cat', 'falcon', 'goat', 'pig', 'ferret'], did: ['ate a boot', 'chewed the tapestry', "stole the steward's hat", 'slept on the throne', 'got into the larder', 'bit the bishop', 'fell in the well'] },
    roll: (r, P) => ({ a: 'lord', beast: pick(r, P.beast), did: pick(r, P.did) }),
    told: [
      (f) => `The lord's ${f.beast} ${f.did}. Again.`,
      (f) => `Have you met the lord's ${f.beast}? It ${f.did} this morning.`,
      (f) => `Nobody is to mention it, but the lord's ${f.beast} ${f.did}.`,
    ],
    mine: (f) => `My ${f.beast} ${f.did}. I am told this is somehow my fault.`,
    muddle: 'beast',
  },
  nest: {
    pools: { beast: ['crow', 'owl', 'family of bats', 'badger', 'swan', 'hedgehog'], room: ['armoury', 'chapel', 'bell tower', 'lord\'s best boot', 'bread oven', 'privy'], twist: ['It has a helmet now.', "It won't leave.", 'Nobody dares move it.', 'It bites.', 'The guards salute it.', 'It has a name now. Gerald.'] },
    roll: (r, P) => ({ beast: pick(r, P.beast), room: pick(r, P.room), twist: pick(r, P.twist) }),
    told: [
      (f) => `A ${f.beast} has moved into the ${f.room}. ${f.twist}`,
      (f) => `We have a new lodger. A ${f.beast}, in the ${f.room}. ${f.twist}`,
      (f) => `Don't go in the ${f.room}. There's a ${f.beast}. ${f.twist}`,
    ],
    muddle: 'beast',
  },
  noise: {
    pools: { sound: ['scratching', 'singing', 'footsteps', 'a fiddle', 'someone counting', 'snoring'], where: ['below the floors', 'in the walls', 'up the north stair', 'in the empty room'] },
    roll: (r, P) => ({ sound: pick(r, P.sound), where: pick(r, P.where) }),
    told: [
      (f) => `Someone hears ${f.sound} ${f.where} at night. I would not go looking.`,
      (f) => `There's ${f.sound} ${f.where}, nights. Nobody goes to check.`,
      (f) => `The night watch swears there's ${f.sound} ${f.where}. Nobody will say whose.`,
    ],
    muddle: 'sound',
  },
  visitor: {
    pools: { who: ['a pedlar', 'a knight in rusty armour', 'a man selling bells', 'a lady with nine cats', 'a very tall monk', 'a bard with no lute'], then: ['left without a word', 'is still in the guest room', 'took a spoon on the way out', 'asked for the lord and then hid', 'has been here a week now'] },
    roll: (r, P) => ({ who: pick(r, P.who), then: pick(r, P.then) }),
    told: [
      (f) => `${cap(f.who)} came to the gate yesterday, and ${f.then}.`,
      (f) => `We had a visitor. ${cap(f.who)}. ${cap(f.then)}.`,
      (f) => `You missed ${f.who}. Came up the road, and ${f.then}.`,
    ],
    muddle: 'who',
  },
  broke: {
    pools: { thing: ['well rope', 'kitchen bell', 'gate chain', 'big soup pot', 'throne leg', 'chapel door'], after: ['The new one is very proud.', 'We use string now.', 'The steward blames the cook.', 'The cook blames the steward.', 'Nobody will own up.'] },
    roll: (r, P) => ({ a: 'steward', thing: pick(r, P.thing), after: pick(r, P.after) }),
    told: [
      (f) => `The ${f.thing} gave out. ${f.after}`,
      (f) => `Did you hear the ${f.thing} broke? ${f.after}`,
      (f) => `Snap, went the ${f.thing}. ${f.after}`,
    ],
    mine: (f) => `The ${f.thing} broke, and the mending comes out of my accounts. ${f.after}`,
    muddle: 'thing',
  },
  road: {
    pools: { bad: ['washed out', 'thick with wolves', 'full of lost sheep', 'deep in mud', 'blocked by a fallen oak'], where: ['the river', 'the old bridge', 'the mill', 'the long bend'] },
    roll: (r, P) => ({ bad: pick(r, P.bad), where: pick(r, P.where) }),
    told: [
      (f) => `The travellers say the road is ${f.bad} past ${f.where}.`,
      (f) => `Word from the road: it's ${f.bad} past ${f.where}. Mind how you go.`,
      (f) => `Don't take the road past ${f.where}. ${cap(f.bad)}, they say.`,
    ],
    muddle: 'bad',
  },
  sweet: {
    pools: { did: ['walking the walls', 'sharing a pie', 'laughing in the stairwell', 'holding hands in the pantry', 'writing each other verses'] },
    roll: (r, P) => { const [a, b] = two(r, ['steward', 'cook', 'maid', 'guard']); return { a, b, did: pick(r, P.did) } },
    told: [
      (f) => `${cap(R(f.a))} and ${R(f.b)} were seen ${f.did} together.`,
      (f) => `Guess who was caught ${f.did}? ${cap(R(f.a))} and ${R(f.b)}!`,
      (f) => `${cap(R(f.a))} has been ${f.did} with ${R(f.b)}. Every evening.`,
    ],
    mine: (f, other) => `Yes, ${R(other)} and I were ${f.did}. What of it?`,
    side: (f, a) => `I always said ${R(a ? f.a : f.b)} was sweet on them.`,
    muddle: 'did',
  },
}

/** Castle `seed`'s stories, the same on every client: `[{ kind, f }]`, no two of a kind. */
export function castleNews(seed) {
  const rand = mulberry32(hash32(seed, SALT.story))
  const kinds = Object.keys(KINDS)
  const out = []
  while (out.length < NEWS.stories) {
    const kind = kinds.splice((rand() * kinds.length) | 0, 1)[0]
    out.push({ kind, f: KINDS[kind].roll(rand, KINDS[kind].pools) })
  }
  return out
}

/** The indexes of `stories` the teller hashed `h` has heard: always the first. */
export function heardOf(stories, h) {
  return stories.map((_, i) => i).filter((i) => i === 0 || mulberry32(hash32(h, SALT.know, i))() < NEWS.knows)
}

// A teller's temper, by their strongest lean: how they lead into a story and sign off.
const TONES = {
  hush: { lead: ['Keep this to yourself, but', 'Between us,', "Don't say you heard it from me, but"], tail: ['Not a word, mind.', 'You never heard it from me.', 'Shh.'] },
  gush: { lead: ['Oh, have you heard?', "Oh, you'll love this.", 'Listen, listen.'], tail: ['Can you believe it?', "I haven't stopped laughing.", 'Best thing all week.'] },
  first: { lead: ['I heard it first, mind.', 'Nobody knows this yet but me.', 'You can thank me for this one.'], tail: ['You heard it here first.', 'Remember who told you.', 'I always know first.'] },
  sour: { lead: ['Not that anyone tells me anything, but', 'The usual nonsense.', 'News? Here? Fine.'], tail: ['Typical.', 'As if we had nothing better to do.', 'And who cleans up after? Me.'] },
  fond: { lead: ['Oh, bless them all.', 'You have to love this place.', 'Well, now.'], tail: ['Poor dears.', 'Sweet, really.', 'It does make me smile.'] },
  curt: { lead: ['Hm.', 'News.', 'One thing.'], tail: ['That is all.', 'Nothing else.', 'Move along.'] },
}
const HEDGE = ['Or something like that.', "I think. Don't quote me.", 'Or so I heard it.', 'One of those.']
const DONE = ['That is all I have heard.', "You've had all my news.", "Nothing more, I'm afraid.", 'That is the lot.']

/** Temper `traits` ({ chattiness, accuracy, wariness, kindness, boast }) as a tone: whichever lean is strongest. */
export function toneOf(t) {
  const leans = { hush: t.wariness, gush: t.chattiness, first: t.boast, sour: 1 - t.kindness, fond: t.kindness, curt: 1 - t.chattiness }
  return Object.entries(leans).sort((a, b) => b[1] - a[1])[0][0]
}

/** `lead` and `body` joined: a lead ending in a comma or "but" runs into the body. */
function joined(lead, body) {
  return /(,| but)$/.test(lead) ? `${lead} ${body[0].toLowerCase()}${body.slice(1)}` : `${lead} ${body}`
}

/**
 * Story `s` as told by `mind` ({ who, traits, h }) on draws from `rand`: its own words if `mind` is a party, else one bystander's
 * telling, maybe muddled, maybe with a side taken, in the teller's tone, trimmed to fit the caption.
 */
export function tellStory(s, mind, rand) {
  const K = KINDS[s.kind], f = s.f, parties = [f.a, f.b].filter((p) => p !== undefined)
  const tone = TONES[toneOf(mind.traits)]
  if (K.mine !== undefined && OWN.has(mind.who) && parties.includes(mind.who)) {
    const other = parties.find((p) => p !== mind.who)
    return fitted([K.mine(f, other)], rand() < NEWS.tail ? pick(rand, tone.tail) : null, null)
  }
  let g = f, hedge = null
  if (rand() < (1 - mind.traits.accuracy) * NEWS.muddle) {
    const pool = K.pools[K.muddle].filter((v) => v !== f[K.muddle])
    g = { ...f, [K.muddle]: pick(rand, pool) }
    hedge = pick(rand, HEDGE)
  }
  const body = [pick(rand, K.told)(g)]
  if (hedge !== null) body.push(hedge)
  // A bystander's side holds for them: the same teller always blames the same party.
  if (K.side !== undefined && rand() < NEWS.side) body.push(K.side(f, mulberry32(hash32(mind.h, SALT.side, Object.keys(KINDS).indexOf(s.kind)))() < 0.5))
  return fitted(body, rand() < NEWS.tail ? pick(rand, tone.tail) : null, rand() < NEWS.lead ? pick(rand, tone.lead) : null)
}

/** `body` sentences with `tail` after and `lead` before, dropping the tail, then the lead, then later sentences until it fits. */
function fitted(body, tail, lead) {
  const parts = [...body]
  for (;;) {
    const core = parts.join(' ')
    for (const [l, t] of [[lead, tail], [null, tail], [lead, null], [null, null]]) {
      const text = [l === null ? core : joined(l, core), t].filter((x) => x !== null).join(' ')
      if (fits(text)) return text
    }
    if (parts.length === 1) throw new Error(`castle-news: "${core}" does not fit the caption`)
    parts.pop()
  }
}

/** What a teller says once they have no story left to tell her. */
export const nothingMore = (rand) => pick(rand, DONE)

/** Every bare telling of every fill, for check-talk to walk against the caption. */
export function allStoryBodies() {
  const out = []
  for (const [kind, K] of Object.entries(KINDS)) for (let i = 0; i < 40; i++) {
    const f = K.roll(mulberry32(hash32(i, SALT.story, Object.keys(KINDS).indexOf(kind))), K.pools)
    for (const t of K.told) out.push(t(f))
    if (K.mine !== undefined) out.push(K.mine(f, [f.a, f.b].find((p) => p !== f.a) ?? 'cook'))
  }
  return out
}
