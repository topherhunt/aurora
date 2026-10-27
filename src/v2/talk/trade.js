// What people buy and sell, and the blacksmith's shop (design/42-valuables.md "Flows"). Pure data plus helpers that take the
// speaking `conv` (speak.js Conversation) and move items through `conv.ctx.pack`. Three-free.

export const GEMS = ['jade', 'ruby', 'sapphire', 'diamond']
export const ORES = ['flint', 'bog-iron', 'lodestone', 'firestone', 'rimesilver']
export const LARGE = new Set([...ORES, 'egg', 'pickaxe', 'sword', 'shield'])

// Coins a human pays for one. Rimesilver and eggs have no table price (a rare ore, a thief's prize): these are set here.
export const PRICE = { flint: 2, 'bog-iron': 5, lodestone: 25, firestone: 30, jade: 40, ruby: 60, sapphire: 75, diamond: 100, rimesilver: 200, egg: 150 }
// The blacksmith's tools: coins and bog iron for each.
export const SHOP = { sword: { coin: 100, 'bog-iron': 3 }, shield: { coin: 100, 'bog-iron': 3 }, pickaxe: { coin: 50 } }
// A thief's one stolen gem sells at this times its price.
const STOLEN = 3

const NAME = {
  coin: ['coin', 'coins'], jade: ['jade', 'jade'], ruby: ['ruby', 'rubies'], sapphire: ['sapphire', 'sapphires'], diamond: ['diamond', 'diamonds'],
  'bog-iron': ['bog iron', 'bog iron'], lodestone: ['lodestone', 'lodestones'], rimesilver: ['rimesilver', 'rimesilver'], firestone: ['firestone', 'firestone'],
  flint: ['flint', 'flint'], egg: ['dragon egg', 'dragon eggs'], pickaxe: ['pickaxe', 'pickaxes'], sword: ['sword', 'swords'], shield: ['shield', 'shields'],
}

/** `n` of `kind` in words: "1 ruby", "3 bog iron". */
export function count(kind, n) {
  if (NAME[kind] === undefined) throw new Error(`trade: no item kind ${kind}`)
  return `${n} ${NAME[kind][n === 1 ? 0 : 1]}`
}

/** `kind` alone, singular: "bog iron", "sword". */
export const label = (kind) => NAME[kind][0]

const list = (parts) => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`)

/** Whether `mind` is the town smith, whose shop opens in his workshop. */
export const isSmith = (mind) => mind.kind === 'human' && mind.body === 'blacksmith'

const TRADERS = new Set(['innkeeper', 'trapper', 'skald', 'jarlsthane', 'miner'])

/** The kinds `mind` takes from her. */
export function buys(mind) {
  if (mind.kind === 'leafkin') return [...GEMS, 'coin']
  if (mind.body === 'blacksmith') return ORES
  if (mind.body === 'alchemist') return [...GEMS, 'firestone']
  if (mind.body === 'thief') return [...GEMS, ...ORES, 'egg']
  if (TRADERS.has(mind.body)) return [...GEMS, ...ORES]
  return []
}

export const wants = (mind, kind) => buys(mind).includes(kind)

/**
 * Every deal `mind` offers, `{ id, take, give }`: what she hands over and what she gets, kind -> count. `stolen` is the
 * gem a thief will part with (rapport `sold` holds it once sold), or null.
 */
export function deals(mind, stolen = null) {
  const out = []
  if (mind.kind === 'leafkin') {
    out.push({ id: 'iron:jade', take: { jade: 1 }, give: { 'bog-iron': 3 } })
    for (const g of GEMS.slice(1)) out.push({ id: `iron:${g}`, take: { [g]: 1 }, give: { 'bog-iron': 2 } })
    for (const g of GEMS) out.push({ id: `lode:${g}`, take: { [g]: 1 }, give: { lodestone: 1 } })
    out.push({ id: 'iron:coin', take: { coin: 20 }, give: { 'bog-iron': 1 } }, { id: 'lode:coin', take: { coin: 100 }, give: { lodestone: 1 } })
    return out
  }
  for (const k of buys(mind)) out.push({ id: `sell:${k}`, take: { [k]: 1 }, give: { coin: PRICE[k] } })
  if (mind.body === 'thief' && stolen !== null) out.push({ id: `stolen:${stolen}`, take: { coin: PRICE[stolen] * STOLEN }, give: { [stolen]: 1 } })
  return out
}

/** The gem `mind` (a thief) has stolen to sell, by a roll `r`, or null for anyone else. */
export const stolenGem = (mind, r) => (mind.body === 'thief' ? GEMS[Math.min(GEMS.length - 1, (r * GEMS.length) | 0)] : null)

const phrase = (bag) => list(Object.entries(bag).map(([k, n]) => count(k, n)))

/** What a deal says she would hand over for what: "1 ruby for 60 coins". */
export const dealText = (d) => `${phrase(d.take)} for ${phrase(d.give)}`

/** Her side of a deal chip: fragments the dialog grid builds a sentence from. */
export const dealPath = (d) => (d.id.startsWith('stolen:') ? ['Buy', count(...Object.entries(d.give)[0]), `for ${phrase(d.take)}.`] : ['Trade', phrase(d.take), `for ${phrase(d.give)}.`])

/**
 * Take `take` from the pack and put `give` in, all or nothing. Returns `null` on success, else what is missing:
 * `{ short: [{ kind, have, need }], full: boolean }`. A pack that disagrees with its own counts throws.
 */
export function swap(pack, take, give) {
  const freed = Object.entries(take).filter(([k]) => LARGE.has(k)).reduce((s, [, n]) => s + n, 0)
  const got = Object.entries(give).filter(([k]) => LARGE.has(k)).reduce((s, [, n]) => s + n, 0)
  const short = Object.entries(take).filter(([k, n]) => pack.count(k) < n).map(([k, n]) => ({ kind: k, have: pack.count(k), need: n }))
  const full = pack.freeLarge() + freed < got
  if (short.length > 0 || full) return { short, full }
  const done = []
  const undo = () => { for (const [k, n] of done.reverse()) if (!pack.add(k, n)) throw new Error(`trade: could not restore ${n} ${k}`) }
  for (const [k, n] of Object.entries(take)) {
    if (!pack.remove(k, n)) { undo(); throw new Error(`trade: pack counted ${n} ${k} but would not give them up`) }
    done.push([k, n])
  }
  const added = []
  for (const [k, n] of Object.entries(give)) {
    if (!pack.add(k, n)) {
      for (const [ak, an] of added) if (!pack.remove(ak, an)) throw new Error(`trade: could not undo ${an} ${ak}`)
      undo()
      throw new Error(`trade: pack counted room for ${n} ${k} but would not take them`)
    }
    added.push([k, n])
  }
  return null
}

const MISSING = (m) => {
  const parts = m.short.map((s) => `${count(s.kind, s.need)} (you have ${s.have})`)
  if (m.full) parts.push('a free large slot')
  return list(parts)
}

// --- speech ---------------------------------------------------------------

/** The line for a pack refusing `m`. */
function refusal(conv, m, kind) {
  const more = { moment: 'refuse.price', plain: true, lacking: m }
  if (conv.leafkin) return conv._line(m.short.length === 0 ? conv._lk('tradeFull') : conv._lk('tradeShort', { need: list(m.short.map((s) => count(s.kind, s.need))) }), 'talk-shrug', more)
  return conv._line(conv._pick(`${kind}:fail`, kind === 'shop' ? SHOP_FAIL : TRADE_FAIL).replace('{need}', MISSING(m)), 'talk-shrug', more)
}

const SHOP_FAIL = ["Can't sell you that. You're short: {need}.", 'No deal yet. You still need {need}.', "Not like this. You lack {need}.", "Come back when you've {need}."]
const TRADE_FAIL = ["I'd like to, but you're short: {need}.", 'Not yet. You lack {need}.', "You haven't got it all: {need}."]
const SHOP_ELSEWHERE = ["Not here. Find me in my workshop.", "I don't do business out here. Come to the workshop.", 'Workshop. Not out here.']
const SHOP_DONE = ['There. Pleasure doing business.', 'Done. Mind the edge.', 'Sold. Now let me get back to work.', "That's that. Next!"]
const TRADE_DONE = ['A fair trade. Pleasure.', 'Done, then.', "It's a deal. Thank you.", 'Good business. Come back any time.']
const WANT_OPEN = ['Very interested in that {item}! What would you trade for it?', 'Is that {item}? I am very interested. What would you trade?', 'That {item} in your hand has my eye. What would you trade for it?', 'Now there is a fine {item}. What would you trade it for?']
const SHOP_OPEN = ['What do you need? Make it quick, orders are piling up.', 'Well? Make it quick, I have orders piling up.', "What is it you need? Quick, now, there's a pile of orders waiting.", 'Out with it. What do you need? I have orders piling up.']
const SHOP_TIRED = ["I'm worn out. Come find me in my workshop.", 'Not now, I am dead on my feet. Come to my workshop.', "Ask me in the workshop. Out here I'm only tired.", 'Too tired for this. Find me at the workshop.']

/** Whether she can trade now: they buy something and she holds it (or carries something they take). */
export function tradeable(conv) {
  const { mind, ctx } = conv
  if (isSmith(mind) && !ctx.inWorkshop) return false
  return ctx.wants !== null || buys(mind).some((k) => ctx.pack.count(k) > 0)
}

/** The deals this speaker offers her now. */
export function dealsNow(conv) {
  const stolen = stolenGem(conv.mind, conv._roll('stolen'))
  const r = conv.ctx.rapport.get(conv.mind.id)
  return deals(conv.mind, stolen !== null && !r.sold.has(stolen) ? stolen : null)
}

/** Menu chips of the shop and trade, first in the menu: `[topic, path]`. */
export function chips(conv) {
  const { mind, ctx } = conv
  const out = []
  if (isSmith(mind) && ctx.inWorkshop) {
    for (const item of Object.keys(SHOP)) out.push([`shop:buy:${item}`, ['Can I buy', `${/^[aeiou]/.test(item) ? 'an' : 'a'} ${item}?`]])
    out.push(['shop:offer', ['What do you', 'have on offer?']])
  }
  if (tradeable(conv)) {
    out.push(['trade:offer', ['What do you', 'have on offer?']])
    for (const d of dealsNow(conv)) {
      const kind = Object.keys(d.take)[0]
      if (conv.offered || kind === ctx.wants || (ctx.pack.count(kind) > 0 && kind !== 'coin')) out.push([`trade:take:${d.id}`, dealPath(d)])
    }
  }
  return out
}

/** The opener when they want what she holds, or the smith's shop greeting: a line or null. */
export function opener(conv) {
  const { mind, ctx } = conv
  if (isSmith(mind)) {
    const open = ctx.inWorkshop
    return conv._line(conv._pick('shop:open', open ? SHOP_OPEN : SHOP_TIRED), 'talk-gesture', { moment: open ? 'mood.busy' : 'mood.tired', shop: open ? true : 'tired', plain: true })
  }
  if (ctx.wants === null) return null
  const item = label(ctx.wants)
  const text = conv.leafkin ? conv._lk('tradeWant', { item }) : conv._pick('trade:open', WANT_OPEN).replace('{item}', item)
  return conv._line(text, 'talk-gesture', { moment: 'needs.yes', plain: true, trade: true })
}

/** Her `topic` of the shop (`shop:buy:<item>`, `shop:offer`) or trade (`trade:offer`, `trade:take:<id>`) answered. */
export function say(conv, head, arg) {
  const { mind, ctx } = conv
  if (head === 'shop') {
    if (!isSmith(mind)) throw new Error(`Conversation: ${mind.id} keeps no shop`)
    if (!ctx.inWorkshop) return conv._line(conv._pick('shop:elsewhere', SHOP_ELSEWHERE), 'talk-shrug', { moment: 'mood.tired', plain: true })
    if (arg === 'offer') {
      const stock = Object.entries(SHOP).map(([item, cost]) => `${count(item, 1)} for ${phrase(cost)}`)
      const text = conv._pick('shop:offer', ['I make {stock}. And I buy ore: ask me what ores are worth.', 'On offer: {stock}. Bring me ore and I pay coin for that too.', 'Tools, mostly. {stock}. Ore I buy, if you have any.'])
      return conv._line(text.replace('{stock}', list(stock)), 'talk-gesture', { moment: 'answer.sure', plain: true, unlocks: conv._unlock(['ores']), about: conv._named(['ores']) })
    }
    if (!arg.startsWith('buy:')) throw new Error(`Conversation: no shop:${arg}`)
    const item = arg.slice(4)
    const cost = SHOP[item]
    if (cost === undefined) throw new Error(`Conversation: the smith does not sell ${item}`)
    const m = swap(ctx.pack, cost, { [item]: 1 })
    if (m !== null) return refusal(conv, m, 'shop')
    ctx.rapport.warm(mind.id, 0.05)
    return conv._line(conv._pick('shop:done', SHOP_DONE), 'talk-nod', { mood: 'warm', moment: 'give.thanks', plain: true, sold: { item, paid: cost } })
  }
  if (head === 'trade') {
    if (arg === 'offer') {
      conv.offered = true
      const all = dealsNow(conv)
      if (all.length === 0) return conv._line(conv.leafkin ? conv._lk('tradeNone') : "I've nothing to trade you.", 'talk-shrug', { moment: 'answer.unknown', plain: true })
      const text = conv.leafkin
        ? conv._lk('tradeOffer', { list: list(all.map((d) => `${phrase(d.give)} for ${phrase(d.take)}`)) })
        : conv._pick('trade:offer', ['I would take {items}.', 'Here is what I deal in: {items}.', 'My offers: {items}.']).replace('{items}', list(all.map(dealText)))
      return conv._line(text, 'talk-gesture', { moment: 'answer.sure', plain: true, unlocks: conv._unlock(['gems']), about: conv._named(['gems']), deals: all.map((d) => d.id) })
    }
    if (!arg.startsWith('take:')) throw new Error(`Conversation: no trade:${arg}`)
    const id = arg.slice(5)
    const deal = dealsNow(conv).find((d) => d.id === id)
    if (deal === undefined) throw new Error(`Conversation: ${mind.id} offers no deal ${id}`)
    const m = swap(ctx.pack, deal.take, deal.give)
    if (m !== null) return refusal(conv, m, 'trade')
    if (id.startsWith('stolen:')) ctx.rapport.get(mind.id).sold.add(id.slice(7))
    ctx.rapport.warm(mind.id, 0.03)
    const text = conv.leafkin ? conv._lk('tradeDone') : conv._pick('trade:done', TRADE_DONE)
    return conv._line(text, 'talk-nod', { mood: 'warm', moment: 'give.thanks', plain: true, sold: { id, take: deal.take, give: deal.give } })
  }
  throw new Error(`Conversation: no ${head}:${arg}`)
}
