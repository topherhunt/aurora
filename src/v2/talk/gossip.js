// Telling a story of local news (castle-news.js, town-news.js) in one teller's way: their temper's lead-in, their side in a
// quarrel (a friend's or a rival's, else a side they always take), a detail a spacey one gets wrong, and the first person from
// whoever the story is about or their kin. A story has no sign-off: leaving is its own line (chat.js `parting`). Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { fits } from './caption.js'

export const GOSSIP = {
  // Odds a teller knows each story past the first, which all know.
  knows: 0.6,
  // Muddle odds against a fully spacey teller; odds of a lead-in and a side taken by one with no tie to either party.
  muddle: 0.4, lead: 0.7, side: 0.5,
}
const SALT = { know: 7121, side: 7122 }

export const pick = (rand, list) => list[(rand() * list.length) | 0]
export const cap = (s) => s[0].toUpperCase() + s.slice(1)
/** `noun` with its "a" or "an". */
export const an = (noun) => `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`

// A teller's temper, by their strongest lean: how they lead into a story. Each must sit before any story.
const LEADS = {
  hush: ['Keep this to yourself, but', 'Between us,', "Don't say you heard it from me, but"],
  gush: ['Oh, have you heard?', "Oh, you'll love this.", 'Listen to this.'],
  first: ["Nobody's heard this yet but me.", 'I always hear things first.', 'You can thank me for this one.'],
  sour: ['Not that anyone tells me anything, but', 'The usual nonsense.', 'News? Here? Fine.'],
  fond: ['Oh, this place.', 'You have to love this place.', 'Well, now.'],
  curt: ['Hm.', "Here's some news.", 'Since you ask.'],
}
// The gossip.lead clips that suit any story: not someones-missing.
export const NEWS_CLIPS = ['listen', 'hear-that', 'did-you-hear', 'never-guess', 'between-us', 'listen-this']
// A spacey teller's afterthought, naming the true detail (`v`, a noun phrase) they swapped out.
const HEDGE = [(v) => `Or was it ${v}? I forget.`, (v) => `Or ${v}. One of those.`, (v) => `${cap(v)}, maybe. I forget which.`]
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
 * party i's own and `kin(f, i)` their household's, `side(f, i)` blaming party i, `muddle` the fill a spacey one gets wrong from `pools`,
 * `as(v, f)` that fill as a noun phrase for the hedge (default `v` itself).
 */
export function tellStory(K, s, teller, rand, rel = () => null) {
  const f = s.f, ties = s.parties.map(rel)
  for (const [tie, say] of [['me', K.mine], ['kin', K.kin]]) {
    const i = ties.indexOf(tie)
    if (i >= 0 && say !== undefined) return fitted([say(f, i)], null)
  }
  if (K.muddle === undefined || rand() >= (1 - teller.traits.accuracy) * GOSSIP.muddle) return told(K, s, teller, rand, ties, [pick(rand, K.told)(f)])
  const wrong = pick(rand, K.pools[K.muddle].filter((v) => v !== f[K.muddle]))
  const hedge = pick(rand, HEDGE)((K.as ?? ((v) => v))(f[K.muddle], f))
  // The hedge follows the sentence it corrects; anywhere later it reads as a second thought about something else.
  const said = pick(rand, K.told)({ ...f, [K.muddle]: wrong }).split(/(?<=[.!?]) /)
  const at = said.findIndex((x) => new RegExp(`\\b${wrong}\\b`, 'i').test(x))
  if (at < 0) throw new Error(`gossip: ${s.kind} told without its muddled ${K.muddle} "${wrong}": ${said.join(' ')}`)
  const hedged = [...said.slice(0, at + 1), hedge, ...said.slice(at + 1)].join(' ')
  return told(K, s, teller, rand, ties, [fits(hedged) ? hedged : said.join(' ')])
}

/** `body` sentences with the teller's side in a quarrel after and their lead before. */
function told(K, s, teller, rand, ties, body) {
  if (K.side !== undefined) {
    // A friend blames the other party and a rival their rival, always; one with no tie takes a side now and then, the same one each time.
    const blame = ties[0] === 'friend' || ties[1] === 'rival' ? 1 : ties[1] === 'friend' || ties[0] === 'rival' ? 0 : null
    if (blame !== null) body.push(K.side(s.f, blame))
    else if (rand() < GOSSIP.side) body.push(K.side(s.f, mulberry32(hash32(teller.h, SALT.side, s.key))() < 0.5 ? 0 : 1))
  }
  const lead = rand() < GOSSIP.lead ? pick(rand, LEADS[toneOf(teller.traits)]) : null
  // A body that opens "Did you hear?" is its own lead, and a question lead before a question is one question too many.
  return fitted(body, /^Did you hear\?/.test(body[0]) || (lead !== null && lead.endsWith('?') && /^[^.!]*\?/.test(body[0])) ? null : lead)
}

// Opening words a run-in lead lowercases; anything else (a name) keeps its capital. check-talk walks every story's first word against it.
export const COMMON = /^(The|A|An|There|Someone|Somebody|Some|We|You|Nobody|It|They|Did|Have|Guess|Don't|Word|Kids|Every|Up|One|Climb|Our)\b/

/** `lead` and `body` joined: a lead ending in a comma or "but" runs into the body. */
export function joined(lead, body) {
  return /(,| but)$/.test(lead) && COMMON.test(body) ? `${lead} ${body[0].toLowerCase()}${body.slice(1)}` : `${lead} ${body}`
}

/** `body` sentences with `lead` before, dropping the lead, then later sentences until it fits. */
function fitted(body, lead) {
  const parts = [...body]
  for (;;) {
    const core = parts.join(' ')
    for (const l of [lead, null]) {
      const text = l === null ? core : joined(l, core)
      if (fits(text)) return text
    }
    if (parts.length === 1) throw new Error(`gossip: "${core}" does not fit the caption`)
    parts.pop()
  }
}

/** What a teller says once they have no story left to tell her. */
export const nothingMore = (rand) => pick(rand, DONE)
