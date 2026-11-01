// Telling a story of local news (castle-news.js, town-news.js) in one teller's way: their temper's lead-in and sign-off,
// their side in a quarrel (a friend's or a rival's, else a side they always take), a detail a spacey one gets wrong, and the
// first person from whoever the story is about or their kin. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { fits } from './caption.js'

export const GOSSIP = {
  // Odds a teller knows each story past the first, which all know.
  knows: 0.6,
  // Muddle odds against a fully spacey teller; odds of a lead-in, a sign-off and a side taken by one with no tie to either party.
  muddle: 0.4, lead: 0.7, tail: 0.5, side: 0.5,
}
const SALT = { know: 7121, side: 7122 }

export const pick = (rand, list) => list[(rand() * list.length) | 0]
export const cap = (s) => s[0].toUpperCase() + s.slice(1)

// A teller's temper, by their strongest lean: how they lead into a story and sign off.
const TONES = {
  hush: { lead: ['Keep this to yourself, but', 'Between us,', "Don't say you heard it from me, but"], tail: ['Not a word, mind.', 'You never heard it from me.', 'Shh.'] },
  gush: { lead: ['Oh, have you heard?', "Oh, you'll love this.", 'Listen, listen.'], tail: ['Can you believe it?', "I haven't stopped laughing.", 'Best thing all week.'] },
  first: { lead: ['I heard it first, mind.', 'Nobody knows this yet but me.', 'You can thank me for this one.'], tail: ['You heard it here first.', 'Remember who told you.', 'I always know first.'] },
  sour: { lead: ['Not that anyone tells me anything, but', 'The usual nonsense.', 'News? Here? Fine.'], tail: ['Typical.', 'As if we had nothing better to do.', 'And who cleans up after? Me.'] },
  fond: { lead: ['Oh, bless them all.', 'You have to love this place.', 'Well, now.'], tail: ['Poor dears.', 'Sweet, really.', 'It does make me smile.'] },
  curt: { lead: ['Hm.', 'News.', 'One thing.'], tail: ['That is all.', 'Nothing else.', 'Move along.'] },
}
// The gossip.lead clips that suit any story: not someones-missing.
export const NEWS_CLIPS = ['listen', 'hear-that', 'did-you-hear', 'never-guess', 'between-us', 'listen-this']
const HEDGE = ['Or something like that.', "I think. Don't quote me.", 'Or so I heard it.', 'One of those.']
const DONE = ['That is all I have heard.', "You've had all my news.", "Nothing more, I'm afraid.", 'That is the lot.']

/** Temper `traits` ({ chattiness, accuracy, wariness, kindness, boast }) as a tone: whichever lean is strongest. */
export function toneOf(t) {
  const leans = { hush: t.wariness, gush: t.chattiness, first: t.boast, sour: 1 - t.kindness, fond: t.kindness, curt: 1 - t.chattiness }
  return Object.entries(leans).sort((a, b) => b[1] - a[1])[0][0]
}

/** The indexes of `n` stories the teller hashed `h` has heard: always the first, and every one `has(i)` says is theirs. */
export function heardOf(n, h, has = () => false) {
  return Array.from({ length: n }, (_, i) => i).filter((i) => i === 0 || has(i) || mulberry32(hash32(h, SALT.know, i))() < GOSSIP.knows)
}

/**
 * Story `s` ({ kind, f, parties, key }) of kind `K` as told by `teller` ({ traits, h }) on draws from `rand`. `rel(party)` is how
 * the teller stands to a party: 'me', 'kin', 'friend', 'rival' or null. `K`: `told` bystanders' wordings of fills `f`, `mine(f, i)`
 * party i's own and `kin(f, i)` their household's, `side(f, i)` blaming party i, `muddle` the fill a spacey one gets wrong from `pools`.
 */
export function tellStory(K, s, teller, rand, rel = () => null) {
  const f = s.f, tone = TONES[toneOf(teller.traits)], ties = s.parties.map(rel)
  const tail = () => (rand() < GOSSIP.tail ? pick(rand, tone.tail) : null)
  for (const [tie, say] of [['me', K.mine], ['kin', K.kin]]) {
    const i = ties.indexOf(tie)
    if (i >= 0 && say !== undefined) return fitted([say(f, i)], tail(), null)
  }
  let g = f, hedge = null
  if (K.muddle !== undefined && rand() < (1 - teller.traits.accuracy) * GOSSIP.muddle) {
    g = { ...f, [K.muddle]: pick(rand, K.pools[K.muddle].filter((v) => v !== f[K.muddle])) }
    hedge = pick(rand, HEDGE)
  }
  const body = [pick(rand, K.told)(g)]
  if (hedge !== null) body.push(hedge)
  if (K.side !== undefined) {
    // A friend blames the other party and a rival their rival, always; one with no tie takes a side now and then, the same one each time.
    const blame = ties[0] === 'friend' || ties[1] === 'rival' ? 1 : ties[1] === 'friend' || ties[0] === 'rival' ? 0 : null
    if (blame !== null) body.push(K.side(f, blame))
    else if (rand() < GOSSIP.side) body.push(K.side(f, mulberry32(hash32(teller.h, SALT.side, s.key))() < 0.5 ? 0 : 1))
  }
  return fitted(body, tail(), rand() < GOSSIP.lead ? pick(rand, tone.lead) : null)
}

// Opening words a run-in lead lowercases; anything else (a name) keeps its capital.
const COMMON = /^(The|A|An|There|Someone|Somebody|We|You|Nobody|It|They|Did|Have|Guess|Don't|Word|Snap|Kids|Every|Up|One)\b/

/** `lead` and `body` joined: a lead ending in a comma or "but" runs into the body. */
function joined(lead, body) {
  return /(,| but)$/.test(lead) && COMMON.test(body) ? `${lead} ${body[0].toLowerCase()}${body.slice(1)}` : `${lead} ${body}`
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
    if (parts.length === 1) throw new Error(`gossip: "${core}" does not fit the caption`)
    parts.pop()
  }
}

/** What a teller says once they have no story left to tell her. */
export const nothingMore = (rand) => pick(rand, DONE)
