// What someone away from home has to say (_notes/conversation-and-quests.md, "On the road"): where they are from and bound, what lies around, where she might go, and the tall tales of the road. Called with their Conversation, like trade.js. Three-free.

import { cap, nothingMore, NEWS_CLIPS } from './gossip.js'
import { fits } from './caption.js'

export const ROAD = {
  // Tales one telling holds, before the teller runs dry.
  tales: 3,
  // Traits past which a teller swears to it, or crows.
  liar: 0.35,
  boaster: 0.6,
  // A dragon roost further than this, in metres, is not "around here".
  roost: 1500,
}

const HAILS = ['Ho there, traveller!', 'Well met on the road!', 'Hold up, friend!', 'You there! Good road to you!']

export const LEADS = ['True story.', 'Swear on my boots.', 'You will not believe this.', 'Saw it with my own eyes.', 'Hand on my heart.']
export const TAILS = { liar: ['Not a word of a lie.', 'Ask anyone.'], boaster: ['And that was a slow day.', 'I have seen stranger.'] }

// `topics` are the lore each tale names (lore.js), offered after it.
export const TALES = [
  { text: 'A strider near {town} once counted my coins for me. Came up two short, and looked at me like I had done it.', topics: ['striders', 'coins'] },
  { text: 'I asked a yeti the way in the snowlands. It pointed with a whole tree, and it was right, too.', topics: ['yetis', 'snowlands'] },
  { text: 'Saw a green giant picking its teeth with a pine outside {town}. Nodded to me, polite as you like.', topics: ['giants'] },
  { text: 'A dragon slept across this very road by {town}. We tiptoed round its tail for a day and a half.', topics: ['dragons', 'roads'] },
  { text: 'Bought a map at {town}. Every road on it led back to the stall. So I bought another.', topics: ['roads'] },
  { text: 'There is a cave spider past {town} that knits. It gave me a sock. Just the one.', topics: ['spiders', 'caves'] },
  { text: 'Met a mushroom twice my size, with a leafkin under it. Said the mushroom was taking it for a walk.', topics: ['leafkin', 'mushrooms'] },
  { text: 'The milestone outside {town} moves. I passed it three times before noon, and it looked smug.', topics: ['roads'] },
  { text: 'Fog ate my left boot on the way out of {town}. Spat it out a mile on, with a better lace in it.', topics: [] },
  { text: 'Took a shortcut through a labyrinth. Went in on a Monday, and came out the Tuesday before.', topics: ['labyrinths'] },
  { text: 'My cousin has a pickaxe that hums when ore is near. It hums all night at {town}. Nobody sleeps.', topics: ['mining', 'ores'] },
  { text: 'A lantern walked past me at dusk outside {town}. No one holding it. It wished me good evening.', topics: [] },
  { text: 'Two bards duelled at {town} till dawn. The loser sings the winner to sleep, and both say they won.', topics: [] },
  { text: 'I traded a gem to a trout once. Fair deal. That trout owns a stretch of the river now.', topics: ['gems'] },
  { text: 'I licked the aurora once, from a hilltop. Tastes of cold pennies. Do not ask how I reached.', topics: [] },
  { text: 'A fox at {town} pays for its own room. Leaves a coin on the bar each morning, and never a word.', topics: ['pets', 'coins'] },
  { text: 'I bet a man at {town} I could roll a wheel of cheese home. That was in spring. The cheese is still ahead of me.', topics: [] },
  { text: 'Ate a red mushroom on a dare. For a week my own left hand called me sir.', topics: ['mushrooms', 'curses'] },
  { text: 'A flare I fired at {town} still has not come down. They set the harvest by it now.', topics: ['flares'] },
]

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const spot = ({ index, name, town }) => ({ x: town.x, z: town.z, label: name, index })

/** What a traveller calls out as they pull up to her: `{ text, moment }`, for `r` in 0..1. */
export const roadHail = (r) => ({ text: HAILS[Math.min(HAILS.length - 1, (r * HAILS.length) | 0)], moment: 'hail.attention' })

/** The questions only someone away from home is asked. */
export function chips(conv) {
  if (conv.ctx.trip === null) return []
  return [
    ['road:tale', ['Seen anything', 'on the road?']],
    ['road:from', ['Where are', 'you from?']],
    ['road:to', ['Where are', 'you headed?']],
    ['road:around', ['What is', 'around here?']],
    ['road:go', ['Where should', 'I go?']],
  ]
}

/** How a stranger away from home greets her, by `tone`: the words, and what they invite her to ask after. */
export function greeting(conv, tone) {
  const { world, trip } = conv.ctx, cheery = tone === 'cheery', { name } = conv.mind
  const index = trip.arrived ? conv.mind.town : trip.to, place = world.towns[index].name
  const text = trip.arrived
    ? cheery ? `Well met, stranger! I'm ${name}, just in from ${place}.` : `Well met. Just in from ${place}.`
    : cheery ? `Well met, stranger! I'm ${name}, on my way to ${place}.` : `Well met, stranger. I'm bound for ${place}.`
  return { text, about: [{ kind: 'town', index }] }
}

/** `text` said pointing at place `at` ({ x, z, label }, `index` its town if it is one), which line then claims. */
function pointed(conv, text, at) {
  const { text: said, gesture, toward } = conv._pointing(text, at)
  return conv._line(said, gesture, { toward, claim: at, moment: 'answer.sure', about: at.index === undefined ? [] : [{ kind: 'town', index: at.index }] })
}

/** The next of `lines` for `key`, one per ask, and a shrug once they run out. */
function next(conv, key, lines) {
  const line = lines[conv.road[key]]
  if (line === undefined) return conv._line(conv._pick('road:spent', ["That's all I know of these parts.", 'Past that, I just walk.', 'You have had all I know.']), 'talk-shrug', { moment: 'answer.spent' })
  conv.road[key]++
  return line()
}

/** What lies around where they stand: the road they are on, the next town, a place folk avoid, a roost. */
function around(conv) {
  const { world, from, trip } = conv.ctx, here = world.townAt(from.x, from.z), lines = []
  if (!trip.arrived) lines.push(() => pointed(conv, `This road runs from ${world.townOf(conv.mind).name} to ${world.towns[trip.to].name}.`, spot(world.towns[trip.to])))
  const near = world.nearestTown(from.x, from.z, here === null ? null : here.index)
  lines.push(() => pointed(conv, `The nearest town from here is ${near.name}.`, spot(near)))
  const hide = hideout(world, from)
  if (hide !== null) lines.push(() => pointed(conv, `Folk keep clear of ${hide.named}.`, hide))
  const roost = [...world.roosts].sort((a, b) => dist(a, from) - dist(b, from))[0]
  if (roost !== undefined && dist(roost, from) < ROAD.roost) lines.push(() => pointed(conv, 'Dragons roost on the high ground.', { x: roost.x, z: roost.z, label: 'the roost' }))
  return next(conv, 'around', lines)
}

/** The hideout (world.hideouts) nearest `from`, `named` with its town, or null. */
function hideout(world, from) {
  let best = null
  world.hideouts.forEach((h, i) => {
    if (h !== null && (best === null || dist(h, from) < dist(best, from))) best = { x: h.x, z: h.z, label: h.label, named: `${h.label} ${h.kind === 'cave' ? 'of' : 'by'} ${world.towns[i].name}` }
  })
  return best
}

/** Where they would send her: a bed if night is coming, a smith if she has no blade, then trouble worth finding, then the next town. */
function advice(conv) {
  const { world, from, trip, hour, pack } = conv.ctx, lines = []
  const nearest = (ok) => world.towns.filter(ok).sort((a, b) => dist(a.town, from) - dist(b.town, from))[0]
  if (hour >= 17 || hour < 6) {
    const inn = nearest((t) => t.town.buildings.some((b) => b.trade === 'inn'))
    if (inn !== undefined) lines.push(() => pointed(conv, `Find a bed before the dark finds you. There's an inn at ${inn.name}.`, spot(inn)))
  }
  if (pack.count('sword') === 0) {
    const smith = nearest((t) => world.titled(t, 'smith') !== null)
    if (smith !== undefined) lines.push(() => pointed(conv, `I'd not go far without a blade. There's a smith at ${smith.name}.`, spot(smith)))
  }
  const hide = hideout(world, from)
  if (hide !== null) lines.push(() => pointed(conv, `If it's trouble you want, try ${hide.named}.`, hide))
  const to = world.towns[trip.to]
  lines.push(() => pointed(conv, trip.arrived ? `You could do worse than ${to.name}, now I see it.` : `Same way as me, if you've any sense. ${to.name} is a fine town.`, spot(to)))
  return next(conv, 'go', lines)
}

/** `core` as this teller tells it: led in, and sworn to or crowed over by their nature, as much as the caption takes. */
function told(conv, core) {
  const T = conv.mind.traits, lead = LEADS[(conv._roll('tale:lead') * LEADS.length) | 0]
  const tails = T.boast > ROAD.boaster ? TAILS.boaster : T.honesty < ROAD.liar ? TAILS.liar : null
  const tail = tails === null ? null : tails[(conv._roll('tale:tail') * tails.length) | 0]
  for (const text of [tail === null ? null : `${lead} ${core} ${tail}`, `${lead} ${core}`]) if (text !== null && fits(text)) return text
  throw new Error(`road: "${lead} ${core}" does not fit the caption`)
}

function tale(conv) {
  const { world } = conv.ctx, heard = conv.road.tales, left = TALES.filter((t) => !heard.has(t))
  if (heard.size >= ROAD.tales) return conv._line(nothingMore(() => conv._roll('tale:done')), 'talk-shrug', { moment: 'answer.spent' })
  const t = left[(conv._roll('tale') * left.length) | 0]
  heard.add(t)
  const index = (conv._roll('tale:town') * world.towns.length) | 0, slot = t.text.includes('{town}')
  const about = conv._named(t.topics)
  if (slot) about.push({ kind: 'town', index })
  return conv._line(told(conv, t.text.replace('{town}', world.towns[index].name)), 'talk-gesture', { moment: 'gossip.lead', only: NEWS_CLIPS, plain: true, unlocks: conv._unlock(t.topics), about })
}

/** Topic `road:<arg>` answered. */
export function say(conv, arg) {
  const { world, trip } = conv.ctx
  if (trip === null) throw new Error(`road: ${conv.mind.id} is at home, so no road:${arg}`)
  if (arg === 'tale') return tale(conv)
  if (arg === 'around') return around(conv)
  if (arg === 'go') return advice(conv)
  if (arg === 'from') return pointed(conv, conv._pick('road:from', [`${world.townOf(conv.mind).name}, born and raised.`, `I hail from ${world.townOf(conv.mind).name}.`, `Out of ${world.townOf(conv.mind).name}, like my mother before me.`]), spot(world.townOf(conv.mind)))
  if (arg === 'to') {
    const to = world.towns[trip.to]
    return trip.arrived ? conv._line(`Right here, ${to.name}. I'm in, and my feet are glad of it.`, 'talk-nod', { claim: spot(to), moment: 'answer.sure' }) : pointed(conv, conv._pick('road:to', [`${to.name}, if the road holds.`, `I'm for ${to.name}.`, `${to.name}, and a hot supper.`]), spot(to))
  }
  throw new Error(`road: no road:${arg}`)
}

/** Every tale at its fullest told, in the longest town name of `names`, for check-talk.mjs. */
export function allTales(names) {
  const long = [...names].sort((a, b) => b.length - a.length)[0]
  return TALES.flatMap((t) => LEADS.flatMap((lead) => [...TAILS.liar, ...TAILS.boaster].map((tail) => `${lead} ${t.text.replace('{town}', long)} ${tail}`)))
}
