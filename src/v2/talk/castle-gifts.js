// The thanks castle folk give once every ward in their keep is open (design/46-castle-wards.md §Gratitude and gifts): up to GIFT.max of
// them, picked by role, each holding out one item of ITEMS for her to take.

import { hash32 } from '../../sim/score.js'
import { ITEMS } from '../items.js'

export const GIFT = {
  // Loot-ledger bits of a castle's gifts, `bit` + slot (main.js, DUNGEON_BITS and WARD_BITS sit below it).
  bit: 60,
  max: 3,
}

// What each role hands over, a kind of ITEMS. The game has no carrot, fish, flint & steel or flare gun among the things that lie
// in the world, so a cook gives her knife and a servant or maid the flare recharge bottle.
export const GIFT_KINDS = {
  lord: ['coin', 'diamond', 'sapphire', 'ruby'],
  steward: ['coin', 'jade'],
  cook: ['knife'],
  guard: ['sword', 'shield', 'knife'],
  servant: ['flare-charges'],
  maid: ['flare-charges'],
}

// Who gives first when there are more roles than GIFT.max: a spread of kinds before a second of the same sort.
const ORDER = ['lord', 'guard', 'cook', 'steward', 'servant', 'maid']

const NOUN = {
  coin: 'purse of coins', jade: 'piece of jade', diamond: 'diamond', sapphire: 'sapphire', ruby: 'ruby', knife: 'knife', sword: 'sword', shield: 'shield', 'flare-charges': 'flare recharge bottle',
}
const LEAD = [
  'You freed the whole keep! Please, take this',
  'The walls are ours again, thanks to you. Take this',
  'Words fall short, so take this',
  'Every ward is gone, and we owe you everything. Take this',
]
const TAIL = ['as our thanks.', 'with our gratitude.', 'and know you are always welcome here.']

/** The gifts of a castle `seed` whose folk are `roles` (cast order): `[{ person, bit, kind }]`, `person` an index into `roles`, at most GIFT.max, one per person. */
export function planGifts(roles, seed) {
  const out = []
  for (const who of ORDER) {
    if (out.length === GIFT.max) break
    const person = roles.indexOf(who)
    if (person < 0) continue
    const kinds = GIFT_KINDS[who]
    out.push({ person, bit: GIFT.bit + out.length, kind: kinds[hash32(seed, person, 91) % kinds.length] })
  }
  for (const g of out) if (!ITEMS[g.kind]) throw new Error(`planGifts: no item ${g.kind}`)
  return out
}

/** The gifts of `gifts` (planGifts) not yet taken, `taken(bit)` the ledger's answer: those a giver may still hold out. */
export const offerable = (gifts, taken) => gifts.filter((g) => !taken(g.bit))

/** What a giver says as they hold out `kind`; `h` a hash fixing which wording. */
export function giftSays(kind, h) {
  if (NOUN[kind] === undefined) throw new Error(`giftSays: no words for ${kind}`)
  return `${LEAD[h % LEAD.length]} ${NOUN[kind]} ${TAIL[(h >>> 8) % TAIL.length]}`
}

/** Every thanks a giver can say, for check-talk to walk against the caption. */
export function allGiftLines() {
  const out = []
  for (const kind of Object.keys(NOUN)) for (const l of LEAD) for (const t of TAIL) out.push(`${l} ${NOUN[kind]} ${t}`)
  return out
}
