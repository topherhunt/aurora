// Which recorded line a speaker says for a moment (_notes/conversation-and-quests.md, "Voice"): the pool is
// public/sounds/voice/moments.json (tools/voice/pack.mjs), the voice is the speaker's own (mind.js `voice`). Picks are
// seeded by the speaker and how often they have said the moment, never the same line twice running, and no line
// again anywhere within `lineCool` s. Three-free.

import { mulberry32 } from '../../sim/mathx.js'
import { hash32 } from '../../sim/score.js'
import { strHash } from './speak.js'

export const LINES = {
  // A speaker says nothing within this of their last line, unless forced (a reply in a conversation).
  speakerGap: 1.5,
  // A line heard is not picked again, by anyone, for this long while the pool has another.
  lineCool: 40,
  // Standing a trusting leafkin needs before it speaks plain pidgin.
  pidgin: 0.6,
}

// The leafkin atom (tools/voice/atoms.js LEAFKIN) each moment is said with.
export const LEAFKIN_ATOM = {
  'greet.stranger': 'lk.greet', 'greet.friend': 'lk.greet', 'greet.cold': 'lk.wary', 'greet.curt': 'lk.wary', 'greet.shop': 'lk.greet', 'greet.morning': 'lk.greet', 'greet.evening': 'lk.greet',
  'pass.nod': 'lk.nv', 'hail.attention': 'lk.greet',
  'bye.warm': 'lk.bye', 'bye.curt': 'lk.bye',
  'answer.sure': 'lk.sure', 'answer.boast': 'lk.sure', 'answer.hedge': 'lk.hedge', 'answer.nervous': 'lk.hedge', 'answer.unknown': 'lk.unknown', 'answer.again': 'lk.again',
  'answer.muse': 'lk.sure', 'answer.self': 'lk.sure', 'answer.refer': 'lk.sure', 'answer.spent': 'lk.unknown', 'answer.none': 'lk.unknown',
  'refuse.wary': 'lk.refuse', 'refuse.price': 'lk.price',
  'tell.believe': 'lk.believe', 'tell.caught': 'lk.caught', 'give.thanks': 'lk.thanks', 'give.polite': 'lk.polite',
  'talk.self': 'lk.happy', 'talk.home': 'lk.happy', 'needs.yes': 'lk.want', 'needs.no': 'lk.content',
  'trade.want': 'lk.want', 'trade.offer': 'lk.sure', 'trade.done': 'lk.thanks', 'trade.short': 'lk.price',
  'gossip.lead': 'lk.curious', 'gossip.react': 'lk.happy', 'social.agree': 'lk.sure', 'social.disagree': 'lk.refuse', 'social.curious': 'lk.curious', 'social.surprise': 'lk.nv',
  'social.welcome': 'lk.happy', 'social.ack': 'lk.sure', 'social.comfort': 'lk.happy', 'social.cut': 'lk.bye', 'small.ask': 'lk.curious', 'small.reply': 'lk.happy',
  'mood.content': 'lk.happy', 'mood.bored': 'lk.nv', 'nv.laugh': 'lk.happy', 'sky.aurora': 'lk.sky', 'observe.marvel': 'lk.sky',
  'fear.uneasy': 'lk.uneasy', 'fear.danger': 'lk.fear', 'missing.plea': 'lk.lost',
}

/** How plainly a leafkin speaks to her: its own tongue until it trusts her (trust.js), pidgin once it is warm. */
export function leafkinTier(trusted, standing) {
  if (!trusted) return 'native'
  return standing >= LINES.pidgin ? 'pidgin' : 'mixed'
}

const TIER_FALLBACK = { native: ['native', 'mixed', 'pidgin'], mixed: ['mixed', 'native', 'pidgin'], pidgin: ['pidgin', 'mixed', 'native'] }
// A recorded form for who is meant: `{he|she}` and `{him|her}` lines alike.
const FORM = { he: ['he', 'him'], she: ['she', 'her'], it: ['it'] }

export class LinePicker {
  /** `table` is moments.json: `{ human: { moment: [line] }, leafkin: { atom: { tier: [line] } } }`. */
  constructor(table, seed) {
    this.table = table
    this.seed = seed
    this.said = new Map()
    this.heard = new Map()
    this.last = new Map()
    this.spoke = new Map()
  }

  /** The lines speaker `mind` may say for `moment` (a leafkin in `tier`), forms resolved by `form`. */
  pool(mind, moment, { form = null, tier = 'native' } = {}) {
    if (mind.kind === 'leafkin') {
      const atom = LEAFKIN_ATOM[moment]
      if (atom === undefined) return []
      const tiers = this.table.leafkin[atom]
      if (tiers === undefined) throw new Error(`LinePicker: no leafkin atom ${atom}`)
      for (const t of TIER_FALLBACK[tier]) if (tiers[t].length > 0) return tiers[t]
      return []
    }
    const lines = this.table.human[moment]
    if (lines === undefined) throw new Error(`LinePicker: no moment ${moment}`)
    const out = []
    for (const line of lines) {
      const forms = /\{([^}]+)\}$/.exec(line)
      if (forms === null) { out.push(line); continue }
      if (form === null) continue
      const f = forms[1].split('|').find((x) => FORM[form].includes(x))
      if (f !== undefined) out.push(line.replace(/\{[^}]+\}$/, f))
    }
    return out
  }

  /** What `mind` says for `moment` at `now` s: `{ pack, line, rate, tilt }`, or null when they have nothing for it or spoke too lately. `only` limits it to those utterance ids. */
  pick(mind, moment, { now, form = null, tier = 'native', force = false, only = null }) {
    if (!force && now - (this.spoke.get(mind.id) ?? -Infinity) < LINES.speakerGap) return null
    const all = this.pool(mind, moment, { form, tier })
    const pool = only === null ? all : all.filter((l) => only.includes(l.slice(0, l.indexOf('.'))))
    if (pool.length === 0) return null
    const key = `${mind.id} ${moment}`
    const n = this.said.get(key) ?? 0
    const fresh = pool.filter((l) => now - (this.heard.get(`${mind.voice.pack} ${l}`) ?? -Infinity) >= LINES.lineCool)
    const from = fresh.length > 0 ? fresh : pool
    let line = from[(mulberry32(hash32(this.seed, strHash(key), n))() * from.length) | 0]
    // Never the same line twice running from one speaker while there is another.
    if (from.length > 1 && line === this.last.get(key)) line = from[(from.indexOf(line) + 1) % from.length]
    this.said.set(key, n + 1)
    this.last.set(key, line)
    this.spoke.set(mind.id, now)
    this.heard.set(`${mind.voice.pack} ${line}`, now)
    return { pack: mind.voice.pack, line, rate: mind.voice.rate, tilt: mind.voice.tilt }
  }
}
