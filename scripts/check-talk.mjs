// Node-side gates for the conversation engine (src/v2/talk/; _notes/conversation-and-quests.md).
//
//   node scripts/check-talk.mjs [--transcript]
//
// Plans the real towns as main.js does, casts their minds and quests, and holds the engine to its promises: honest answers point at the truth, lies hold steady and every client hears the same one, muddles drift, wary people refuse strangers, coverers hide a missing child, planted lies get caught. What this can NOT check: whether the lines read well. `--transcript` prints a sample conversation for eyes.

import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planTowns } from '../src/v2/layers/towns.js'
import { TRAITS, VOICE, castMinds, villageMinds } from '../src/v2/talk/mind.js'
import { LORE, TOPICS, TRUST, expertise, expertBody } from '../src/v2/talk/lore.js'
import { DialogGrid, NEXT } from '../src/v2/talk/grid.js'
import { Chat, CHAT, EXCHANGES, chatterStep } from '../src/v2/talk/chat.js'
import { LinePicker, leafkinTier, LEAFKIN_ATOM } from '../src/v2/talk/lines.js'
import { TalkWorld, compass } from '../src/v2/talk/world.js'
import { storyNames, tellTown } from '../src/v2/talk/town-news.js'
import { Rapport } from '../src/v2/talk/rapport.js'
import { QuestLog, questsFor, missingChild, hideouts, MESSAGES, GHOST_WORDS, QUESTS, ODD } from '../src/v2/talk/quests.js'
import { ghostSays } from '../src/v2/talk/ghost.js'
import { Conversation, SPEAK, gossip, strHash } from '../src/v2/talk/speak.js'
import { MANNERS } from '../src/v2/talk/manners.js'
import { LK } from '../src/v2/talk/leafkin.js'
import * as trade from '../src/v2/talk/trade.js'
import { jeer, swordWarning } from '../src/v2/talk/armed.js'
import { quirkLines, allQuirkLines } from '../src/v2/talk/quirks.js'
import { ITEMS } from '../src/v2/items.js'
import { CAPTION, captionRows } from '../src/v2/talk/caption.js'
import { walkTalks } from './lib/talk-walk.mjs'
import { CastleChat, VIEW, WARD_TALK, allCastleLines, castleTemper, wardTier } from '../src/v2/talk/castle.js'
import { GIFT, GIFT_KINDS, allGiftLines, giftSays, offerable, planGifts } from '../src/v2/talk/castle-gifts.js'
import { allCastleBodies, castleNews, tellCastle } from '../src/v2/talk/castle-news.js'
import { maidSays, insideCast, outsideCast } from '../src/v2/render/castle-folk.js'
import { places, route, steps, standing, hereName, roleName, shutEdges, townWay, bearing } from '../src/v2/talk/castle-ways.js'
import { castleLayout } from '../src/v2/castles/layout.js'
import { roomPlan } from '../src/v2/castles/furnish.js'
import { COMMON } from '../src/v2/talk/gossip.js'
import { mulberry32 } from '../src/sim/mathx.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// A muddled teller's second thought (gossip.js HEDGE): true when it names a detail of story `x` the telling before it got wrong.
const HEDGED = /I forget|One of those|No, wait/
// A telling that stumbles: a hedge cutting a question off from its answer, or two leads each ending ", but".
const CLUMSY = /\? (Or was it|Or [^.?!]+\. One of those|No, wait)|, but [^.?!]*, but /
const hedgeTrue = (x, text) => {
  const m = /Or was it ([^?]+)\? I forget\.|Or ([^.]+)\. One of those\.|No, wait\. It was ([^.]+), I think\./.exec(text)
  if (m === null) return false
  const named = (m[1] ?? m[2] ?? m[3]).toLowerCase(), before = text.slice(0, m.index).toLowerCase()
  return Object.values(x.f).some((v) => typeof v === 'string' && named.includes(v.toLowerCase()) && !before.includes(v.toLowerCase()))
}
const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const { towns } = planTowns({ ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })

const world = new TalkWorld(SEED, towns)
// Stand-in hideouts: a cave mouth 300 m off each town but the last, which has none, and a castle by the first.
const fakeCaves = towns.slice(0, -1).map((t, i) => ({ system: i, mouth: i, x: t.x + 300 * Math.sin(i * 2.4), z: t.z - 300 * Math.cos(i * 2.4) }))
const fakeKeeps = [{ site: 'k0', x: towns[0].x + 200, z: towns[0].z }]
world.seatHideouts(hideouts(towns, fakeCaves, fakeKeeps))
const EPOCH = 7
const quests = questsFor(world, EPOCH)
// A pack in the shape main.js's has: `have` counts by kind, `slots` the large slots in all. Like main.js's it throws on a
// kind it cannot hold: the items, plus the roosts' eggs.
const PACKABLE = new Set([...Object.keys(ITEMS), 'egg'])
const LARGE_KINDS = new Set([...PACKABLE].filter((k) => k === 'egg' || !ITEMS[k].small))
const stubPack = (have = {}, slots = 12) => {
  const n = { ...have }
  const known = (k) => { if (!PACKABLE.has(k)) throw new Error(`pack: no item ${k}`); return k }
  for (const k of Object.keys(n)) known(k)
  const used = () => Object.entries(n).filter(([k]) => LARGE_KINDS.has(k)).reduce((a, [, c]) => a + c, 0)
  return {
    n,
    count: (k) => n[known(k)] ?? 0,
    freeLarge: () => slots - used(),
    held: () => null,
    add(k, c = 1) { if (LARGE_KINDS.has(k) && slots - used() < c) return false; n[k] = (n[k] ?? 0) + c; return true },
    remove(k, c = 1) { if ((n[k] ?? 0) < c) return false; n[k] -= c; return true },
  }
}
const ctxAt = (from, more = {}) => ({ world, rapport: new Rapport(), quests, log: new QuestLog(), epoch: EPOCH, from, hour: 12, known: new Set(), pack: stubPack(), wants: null, inWorkshop: false, inShop: false, armed: false, wronged: false, witness: null, ...more })
const fire = (t) => ({ x: t.town.x, z: t.town.z })
// A mind with some traits pinned, for testing one lever at a time.
const as = (m, traits) => ({ ...m, traits: { ...m.traits, ...traits } })
const STRAIGHT = { honesty: 1, accuracy: 1, boast: 0, wariness: 0 }
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

// --- minds ---
const all = world.towns.flatMap((t) => t.minds)
check(world.towns.every((t) => t.minds.length === t.town.folk.length), 'every town folk has a mind', `${all.length} people in ${world.towns.length} towns`)
check(world.towns.every((t) => new Set(t.minds.map((m) => m.name)).size === t.minds.length), 'no two people in a town share a name')
check(all.every((m) => TRAITS.every((k) => m.traits[k] >= 0 && m.traits[k] <= 1)), 'every trait lies in 0..1')
const again = castMinds(SEED, towns[3], 3)
check(JSON.stringify(again) === JSON.stringify(world.towns[3].minds), 'minds are a pure function of the seed and town (every client meets the same people)')
const tiesOk = world.towns.every((t) => t.minds.every((m) => m.friends.every((i) => t.minds[i].friends.includes(m.index)) && m.household.every((i) => t.minds[i].household.includes(m.index)) && (m.rival === null || t.minds[m.rival].rival === m.index)))
check(tiesOk, 'friendship, household and rivalry run both ways')
const spread = TRAITS.map((k) => {
  const v = all.map((m) => m.traits[k])
  return [k, Math.min(...v), Math.max(...v)]
})
check(spread.every(([, lo, hi]) => lo < 0.25 && hi > 0.75), 'every trait reaches both its extremes somewhere in the world', spread.map(([k, lo, hi]) => `${k} ${lo.toFixed(2)}-${hi.toFixed(2)}`).join(', '))
const thieves = all.filter((m) => m.body === 'thief'), guards = all.filter((m) => m.cls === 'guard')
const mean = (xs, k) => xs.reduce((s, m) => s + m.traits[k], 0) / xs.length
if (thieves.length > 0) check(mean(thieves, 'honesty') < mean(guards, 'honesty'), 'thieves lean less honest than guards', `${mean(thieves, 'honesty').toFixed(2)} vs ${mean(guards, 'honesty').toFixed(2)}`)

// --- honest answers point at the truth ---
let pointed = 0, wrong = []
for (const t of world.towns) {
  const asker = t.minds.find((m) => m.cls !== 'child' && m.body !== 'blacksmith')
  const smith = world.titled(t, 'smith')
  if (smith === null || asker === undefined) continue
  const from = fire(t)
  const line = new Conversation(as(asker, STRAIGHT), ctxAt(from)).say('where:title:smith')
  const truth = world.placeOf(smith)
  if (line.claim !== null && dist(line.claim, truth) < SPEAK.same && line.toward === line.claim && line.gesture === 'talk-point') pointed++
  else wrong.push(`${t.name}: ${line.text}`)
}
check(wrong.length === 0 && pointed > 0, 'an honest, accurate townsperson points at the real smithy', `${pointed} towns${wrong.length ? `; ${wrong.slice(0, 2).join(' | ')}` : ''}`)
const noElder = world.towns.find((t) => world.titled(t, 'elder') === null)
if (noElder) check(/no elder/.test(new Conversation(as(noElder.minds[0], STRAIGHT), ctxAt(fire(noElder))).say('where:title:elder').text), 'a town without a jarlsthane says it has no elder')

// --- knowledge has a reach ---
const kid = all.find((m) => m.cls === 'child')
const kidTown = world.townOf(kid)
const farTown = world.towns.reduce((a, b) => (dist(fire(b), fire(kidTown)) > dist(fire(a), fire(kidTown)) ? b : a))
const far = new Conversation(as(kid, { boast: 0 }), ctxAt(fire(kidTown))).say(`where:town:${farTown.index}`)
check(far.claim === null && far.gesture === 'talk-shrug', 'a child knows nothing of a town across the map, and shrugs', far.text)
const boaster = new Conversation(as(kid, { boast: 1 }), ctxAt(fire(kidTown))).say(`where:town:${farTown.index}`)
const trav = world.towns.flatMap((t) => t.minds).find((m) => m.cls === 'travel')
const travFar = world.towns.find((t) => t.index !== trav.town && dist(fire(t), fire(world.townOf(trav))) < SPEAK.reach.travel * 0.5)
if (travFar) check(new Conversation(as(trav, STRAIGHT), ctxAt(fire(world.townOf(trav)))).say(`where:town:${travFar.index}`).claim !== null, 'a traveller knows a town down the road')
console.log(`       a boastful child on the same far town: "${boaster.text}"`)

// --- liars hold steady, muddles drift ---
const t0 = world.towns[0]
const liar = as(t0.minds.find((m) => m.cls !== 'child'), { honesty: 0, accuracy: 1, wariness: 0, boast: 0 })
const target = t0.minds.find((m) => m.id !== liar.id && !liar.household.includes(m.index))
// With no motive a liar still lies sometimes; find a fact this one lies about.
let lied = null
for (const p of t0.minds) {
  if (p.id === liar.id || liar.household.includes(p.index)) continue
  const a = new Conversation(liar, ctxAt(fire(t0))).say(`where:person:${p.id}`)
  if (a.claim !== null && dist(a.claim, world.placeOf(p)) > SPEAK.same) { lied = p; break }
}
if (lied === null) {
  // Unlikely at idleLie 0.12 over a town; report rather than pass.
  check(false, 'a dishonest townsperson lies about someone in town')
} else {
  const c1 = new Conversation(liar, ctxAt(fire(t0)))
  const a1 = c1.say(`where:person:${lied.id}`), a2 = c1.say(`where:person:${lied.id}`)
  const peer = new Conversation(liar, ctxAt(fire(t0))).say(`where:person:${lied.id}`)
  check(dist(a1.claim, a2.claim) < 0.01 && dist(a1.claim, peer.claim) < 0.01, 'a lie holds steady when asked twice, and a second client hears the same lie', a1.text)
  check(/^(Like I said|Same as before|As I told you)\. /.test(a2.text), 'asked again, they say they said it already', a2.text)
}
const spacey = as(liar, { honesty: 1, accuracy: 0 })
const cs = new Conversation(spacey, ctxAt(fire(t0)))
const steady = new Set(Array.from({ length: 12 }, () => cs.say(`where:person:${target.id}`).claim).map((c) => `${c.x.toFixed(1)},${c.z.toFixed(1)}`))
check(steady.size === 1, 'a spacey grown townsperson still points the same way at a neighbour every time', `${steady.size} distinct`)
const nextTown = world.nearestTown(t0.town.x, t0.town.z, t0.index).index
const drifts = Array.from({ length: 12 }, () => cs.say(`where:town:${nextTown}`))
const drift = new Set(drifts.map((l) => `${l.claim.x.toFixed(1)},${l.claim.z.toFixed(1)}`))
check(drift.size >= 2, 'a spacey townsperson asked the way to the next town twelve times gives drifting answers', `${drift.size} distinct`)
const moved = drifts.find((l, i) => i > 0 && dist(l.claim, drifts[i - 1].claim) > 8)
check(moved !== undefined && /^Or no, wait\./.test(moved.text), 'an answer that moved owns up to it', moved && moved.text)

// --- wariness and standing ---
const wary = as(all.find((m) => m.household.length > 0 && m.cls !== 'child'), { wariness: 1, honesty: 1, accuracy: 1, greed: 0 })
const wt = world.townOf(wary)
const kin = wt.minds[wary.household[0]]
const wctx = ctxAt(fire(wt))
const cold = new Conversation(wary, wctx).say(`where:person:${kin.id}`)
check(cold.claim === null && cold.mood === 'cold', 'a wary stranger will not say where their own kin is', cold.text)
wctx.rapport.owe(wary.id, 1)
const warm = new Conversation(wary, wctx).say(`where:person:${kin.id}`)
check(warm.claim !== null, 'once in her debt, they will', warm.text)
const greedy = new Conversation(as(wary, { greed: 1 }), ctxAt(fire(wt))).say(`where:person:${kin.id}`)
check(greedy.price === true, 'a greedy one names a price instead', greedy.text)

// --- quests ---
const qs = [...quests.values()].filter((x) => x.kind === 'missing-child')
const byKeep = (t) => Math.hypot(t.x - fakeKeeps[0].x, t.z - fakeKeeps[0].z) < QUESTS.castleM
check(world.hideouts[0].kind === 'castle' && world.hideouts.every((h, i) => (h === null ? i === towns.length - 1 && !byKeep(towns[i]) : (h.kind === 'castle') === byKeep(towns[i]))), 'a town by a castle hides its child there, the rest in their nearest cave, a town with neither has none', world.hideouts.map((h) => (h === null ? '-' : h.kind)).join(' '))
check(world.hideouts.every((h, i) => h === null || Math.hypot(h.x - towns[i].x, h.z - towns[i].z) < QUESTS.caveM), 'every hideout lies within reach of its town')
const withKids = world.towns.filter((t) => world.hideouts[t.index] !== null && t.minds.some((m) => m.cls === 'child' && m.household.some((i) => t.minds[i].cls !== 'child')))
check(qs.length === withKids.length && !qs.some((x) => world.hideouts[x.town] === null), 'every town with a family and a hideout has a missing child', `${qs.length} of ${withKids.length}`)
check(JSON.stringify([...questsFor(world, EPOCH).values()]) === JSON.stringify([...quests.values()]), 'quests are a pure function of the seed and epoch')
check(JSON.stringify(missingChild(world, qs[0].town, EPOCH + 1)) !== JSON.stringify(qs[0]), 'the next epoch rolls afresh')
const qOk = qs.every((q) => {
  const child = world.person(q.child), parent = world.person(q.parent)
  return child.cls === 'child' && child.household.includes(parent.index) && !q.witnesses.some((w) => w.who === q.parent) && dist(q.witnesses[0]?.clue ?? q.where, q.where) < 0.01 && q.where.variant === world.hideouts[q.town].kind
})
check(qOk, 'every quest: the child lives with the parent, hides in the town hideout, no witness is the parent, the first witness saw where the child went')
check(qs.every((q) => q.witnesses[0].clue.odd === null) && qs.some((q) => q.witnesses.some((w) => w.clue.odd !== null)), 'later witnesses caught the child at something odd, the first only saw where they went')
check(qs.filter((q) => world.person(q.child).voice.he).length >= qs.length * 0.7, 'the missing child is a boy wherever the town has one', `${qs.filter((q) => world.person(q.child).voice.he).length} of ${qs.length}`)

// The quest played: the parent pleads, a witness points true, a coverer lies or, trusted and honest, admits.
const q = qs.find((x) => x.opening === 'direction' && !x.wolf) ?? qs[0]
const qt = world.towns[q.town]
const qctx = ctxAt(fire(qt))
const parent = world.person(q.parent)
const plea = new Conversation(parent, qctx).opener()
check(plea.quest === q.id && plea.mood === 'distress' && qctx.log.state(q.id) === 'accepted', 'the parent hails her with the plea, and she has taken the quest', plea.text)
const w0 = world.person(q.witnesses[0].who)
const seen = new Conversation(as(w0, STRAIGHT), qctx).say(`ask:person:${q.child}`)
check(seen.claim !== null && dist(seen.claim, q.where) < SPEAK.same, 'an honest witness points where the child really went', seen.text)
const passer = qt.minds.find((m) => m.id !== q.parent && m.cls !== 'child' && !q.witnesses.some((w) => w.who === m.id) && !trade.isAlchemist(m) && !trade.isSmith(m))
if (passer) check(new Conversation(as(passer, STRAIGHT), qctx).say(`ask:person:${q.child}`).claim === null, 'someone who saw nothing says so')
const again2 = new Conversation(parent, qctx).say(`ask:person:${q.child}`)
check(again2.moment === 'missing.worry' && !/^Please/.test(again2.text), 'asked after the child once she has taken the search on, the parent says what they know rather than plead again', again2.text)
if (passer) {
  const child = world.person(q.child)
  const ac = new Chat(as(passer, { kindness: 1, chattiness: 1, wariness: 0 }), ctxAt(fire(qt)), { approached: true })
  const al = ac.open()
  check(al.text.includes(`${child.name} has gone missing`) && ac.conv.menu()[0].label === `Where was ${child.name} last seen?`, 'one who comes to her says plainly what is on their mind, and her first chip follows it up', `${al.text} -> ${ac.conv.menu()[0].label}`)
  // Heard from the parent, the child is hers to raise with anyone in that town, and only that town.
  const labels = new Conversation(passer, qctx).menu().map((c) => c.label)
  const elsewhere = world.towns.find((t) => t.index !== qt.index).minds.find((m) => m.cls !== 'child')
  const away = new Conversation(elsewhere, qctx).menu().map((c) => c.label)
  check(qctx.known.has(`person:${child.id}`) && labels.includes(`Where was ${child.name} last seen?`) && labels.includes(`What about ${child.name}?`) && !labels.includes(`Where is ${child.name}?`) && !away.includes(`What about ${child.name}?`), 'told of the missing child by one, she can ask anyone else in that town after (but not "where is" them, as if at home), and no one in another', labels.filter((l) => l.includes(child.name)).join(' / '))
}
// A worried parent never sends her off: asked of other things past patience, they turn her back to the search.
const worried = new Chat(as(parent, { chattiness: 0, kindness: 0, wariness: 1 }), qctx)
const hello = worried.open()
const offTopic = Array.from({ length: 10 }, (_, i) => worried.ask(i % 2 ? 'talk:self' : 'lore:striders'))
const lastOff = offTopic[offTopic.length - 1]
check(/^Any word of/.test(hello.text) && !worried.ended && lastOff.moment === 'missing.worry' && lastOff.text.includes(world.person(q.child).name) && worried.ask(`ask:person:${q.child}`).moment === 'missing.worry', 'a worried parent asks after the child, never dismisses her, and steers ten idle questions back to the search', `${hello.text} ... ${lastOff.text}`)
{
  const oddW = q.witnesses.find((w) => w.clue.odd !== null)
  if (oddW) {
    const said = new Conversation(as(world.person(oddW.who), STRAIGHT), ctxAt(fire(qt))).say(`ask:person:${q.child}`)
    check(said.text.includes(ODD[oddW.clue.odd].split(' ')[0]) && said.claim !== null && dist(said.claim, q.where) < SPEAK.same, 'a witness who caught the child at something odd says so, and still points the way', said.text)
  }
  const wolf = qs.find((x) => x.wolf)
  check(wolf !== undefined && /not cryin' wolf anymore/.test(new Conversation(world.person(wolf.parent), ctxAt(fire(world.towns[wolf.town]))).opener().text), "now and then the parent swears it is no false alarm this time")
  // Found, the child is home: the parent thanks her once, and the town stops talking of it.
  const fctx = ctxAt(fire(qt))
  fctx.log.accept(q)
  fctx.log.set(q.id, 'found')
  const thanked = new Conversation(parent, fctx).opener()
  check(thanked.moment === 'missing.found' && fctx.log.state(q.id) === 'done' && thanked.text.includes(world.person(q.child).name), 'once she has found the child, the parent thanks her and the quest is done', thanked.text)
  const after = new Conversation(parent, fctx).opener()
  const stale = passer ? new Conversation(passer, fctx).news() : null
  check(after.moment !== 'missing.worry' && after.moment !== 'missing.plea' && stale === null, 'after, the parent frets no more and no one tells of it as news', `${after.text} / ${stale}`)
}

// --- the message ---
const msgs = [...quests.values()].filter((x) => x.kind === 'message' && x.ghost === null)
check(msgs.length > world.towns.length * 0.3 && msgs.every((x) => {
  const to = world.person(x.to)
  return to.cls !== 'child' && to.town === world.nearestTown(fire(world.towns[x.town]).x, fire(world.towns[x.town]).z, x.town).index && [...x.choices].sort().join() === '0,1,2,3'
}), 'many towns have word to send, always to a grown-up in the nearest town, with four phrasings to choose from', `${msgs.length} of ${world.towns.length}`)
check(msgs.filter((x) => x.choices[0] === 0).length < msgs.length * 0.5, 'the true phrasing is not always offered first', `first in ${msgs.filter((x) => x.choices[0] === 0).length} of ${msgs.length}`)
const msg = msgs.find((x) => world.person(x.giver).id !== qs.find((c) => c.town === x.town)?.parent) ?? msgs[0]
const mctx = ctxAt(fire(world.towns[msg.town]))
const giver = world.person(msg.giver), to = world.person(msg.to)
const ask = new Conversation(giver, mctx).say('talk:needs')
check(mctx.log.state(msg.id) === 'accepted' && MESSAGES.includes(msg.words) && ask.text.includes(msg.words[0]) && ask.text.includes(to.name), 'asked what they need, the sender hands her the message word for word, and she has taken it', ask.text)
const rc = new Conversation(to, { ...mctx, from: fire(world.townOf(to)) })
check(!new Conversation(to, ctxAt(fire(world.townOf(to)))).menu().some((c) => c.topic.startsWith('deliver:')), 'the recipient offers no "word from" chip to someone carrying none')
check(rc.menu().some((c) => c.topic === `deliver:${msg.id}`), 'the recipient offers a "word from" chip to her')
rc.say(`deliver:${msg.id}`)
const offered = rc.menu().filter((c) => c.topic.startsWith('word:'))
check(offered.length === 4 && offered.some((c) => c.label.includes(msg.words[0])), 'asked what was said, she chooses among the true words and three near-misses', offered.map((c) => c.label).join(' / '))
const s0 = mctx.rapport.standing(to.id)
const got = rc.say(`word:0:${msg.id}`)
check(got.mood === 'warm' && mctx.log.state(msg.id) === 'delivered' && mctx.rapport.standing(to.id) > s0, 'the true words delivered warm the recipient', got.text)
const thanks = new Conversation(giver, mctx).opener()
check(thanks.mood === 'warm' && mctx.log.state(msg.id) === 'done' && mctx.rapport.standing(giver.id) > 0, 'back home, the sender hails her with thanks and owes her', thanks.text)
const gctx = ctxAt(fire(world.townOf(to)))
gctx.log.accept(msg)
const gc = new Conversation(to, gctx)
gc.say(`deliver:${msg.id}`)
const garbled = gc.say(`word:${msg.choices.find((k) => k !== 0)}:${msg.id}`)
check(garbled.mood === 'cold' && gctx.log.state(msg.id) === 'garbled' && gctx.rapport.standing(to.id) < 0 && !gc.menu().some((c) => /^(deliver|word):/.test(c.topic)),'garbled words leave the recipient cold, and the errand cannot be retried', garbled.text)
check(new Conversation(as(to, { wariness: 1 }), gctx).tell({ kind: 'sent', by: msg.giver }).caught === false, 'once the sender has asked her, "they sent me" is the truth')

// --- the castle ghost ---
{
const ghosts = [...quests.values()].filter((x) => x.kind === 'message' && x.ghost !== null)
const castleTowns = world.hideouts.map((h, i) => (h !== null && h.kind === 'castle' ? i : -1)).filter((i) => i >= 0)
check(castleTowns.length > 0 && ghosts.length === 1 && ghosts[0].town === castleTowns[0] && ghosts[0].ghost.site === 'k0' && ghosts[0].giver === null, 'one ghost haunts the castle, with word for the first town that hides its child there', `${ghosts.length} ghosts, castle towns ${castleTowns}`)
const gq = ghosts[0]
const heir = world.person(gq.to)
check(heir.cls !== 'child' && heir.town === gq.town && GHOST_WORDS.includes(gq.words), 'its word goes to a grown-up of that town, in a ghost\'s words', heir.name)
check(JSON.stringify(questsFor(world, EPOCH + 3).get(gq.id)) === JSON.stringify(gq), 'the ghost asks the same of every epoch')
const hctx = ctxAt(fire(world.townOf(heir)))
check(!new Conversation(heir, hctx).menu().some((c) => c.topic === `deliver:${gq.id}`), 'the heir offers no word from the ghost before she has met it')
const ask0 = ghostSays(gq, hctx.log, world)
check(hctx.log.state(gq.id) === 'accepted' && ask0.text.includes(gq.words[0]) && ask0.text.includes(heir.name) && ask0.text.includes(gq.ghost.name), 'met, the ghost names itself and gives her its words for the heir', ask0.text)
const keepAt = world.hideouts[gq.town], heirTown = world.townOf(heir), errandWay = `${heirTown.name} is ${gq.bond}, ${townWay(keepAt, heirTown.town)} of this castle`
const ask1 = ghostSays(gq, hctx.log, world)
check(ask0.text.includes(errandWay), 'the ghost\'s first telling names the heir\'s town and its bearing and distance from the castle', ask0.text)
check(ask1.text.includes(errandWay) && ask1.text.includes(gq.words[0]) && ask1.text.includes(heirTown.name) && hctx.log.state(gq.id) === 'accepted', 'met again, the ghost tells the whole errand again: the heir, the heir\'s town, the way there and the words', ask1.text)
const hc = new Conversation(heir, hctx)
check(hc.menu().some((c) => c.topic === `deliver:${gq.id}` && c.label.includes(gq.ghost.name)), 'the heir offers a "word from" the ghost by name', hc.menu().filter((c) => c.topic.startsWith('deliver:')).map((c) => c.label).join(' / '))
const recall = hc.say(`deliver:${gq.id}`)
check(recall.text.includes(gq.ghost.name) && hc.menu().filter((c) => c.topic.startsWith('word:')).length === 4, 'the heir knows the name from old stories and asks what was said', recall.text)
const heard = hc.say(`word:0:${gq.id}`)
check(heard.mood === 'warm' && hctx.log.state(gq.id) === 'delivered', 'the true words warm the heir', heard.text)
const rest = ghostSays(gq, hctx.log, world)
check(rest.mood === 'warm' && hctx.log.state(gq.id) === 'done' && ghostSays(gq, hctx.log, world) === null, 'back at the castle the ghost thanks her and is at rest', rest.text)
const sctx = ctxAt(fire(world.townOf(heir)))
ghostSays(gq, sctx.log, world)
const sc = new Conversation(heir, sctx)
sc.say(`deliver:${gq.id}`)
sc.say(`word:${gq.choices.find((k) => k !== 0)}:${gq.id}`)
const sigh = ghostSays(gq, sctx.log, world)
check(sigh.mood === 'cold' && sctx.log.state(gq.id) === 'done', 'garbled, the ghost is sorry but thanks her for trying, and rests', sigh.text)
}

// --- telling ---
const listener = qt.minds.find((m) => m.friends.includes(parent.index) && m.cls !== 'child')
if (listener) {
  const sctx = ctxAt(fire(qt))
  const before = new Conversation(listener, sctx)._standing()
  const fakeSent = new Conversation(as(listener, { wariness: 0 }), sctx).tell({ kind: 'sent', by: parent.id })
  check(fakeSent.caught === false && new Conversation(listener, sctx)._standing() > before, "an unwary friend believes her claim that the parent sent her, and warms to her", fakeSent.text)
}
const kinOfParent = qt.minds[parent.household.find((i) => qt.minds[i].cls !== 'child' && i !== parent.index) ?? -1]
if (kinOfParent) {
  const lie2 = new Conversation(kinOfParent, ctxAt(fire(qt))).tell({ kind: 'sent', by: parent.id })
  check(lie2.caught === true, "the parent's own household catches a false 'they sent me'", lie2.text)
}
const g = new Rapport()
g.get('a').beliefs.set('k', { x: 1, z: 2, label: 'x' })
g.catchLie('a')
gossip(g, 'a', 'b')
check(g.get('b').beliefs.has('k') && g.get('b').suspicion > 0, 'gossip passes a belief and a caught lie on')

// --- chips and voices ---
const chatty = all.find((m) => m.friends.length > 0 && m.traits.chattiness > 0.6)
const cc = new Conversation(chatty, ctxAt(fire(world.townOf(chatty))))
cc.say('talk:self')
const friend = world.townOf(chatty).minds[chatty.friends[0]]
check(cc.menu().some((c) => c.topic.startsWith('ask:person:')), 'a chatty person mentions people, who become chips to ask about', cc.menu().filter((c) => c.topic.startsWith('ask:')).map((c) => c.label).join(', '))
const leaf = villageMinds(12345, 6, [0, 1, 2, 3, 4, 0])
const lc = new Conversation(leaf[0], ctxAt({ x: 0, z: 0 }))
const lself = lc.say('talk:self').text
check(lself.includes(leaf[0].name) && !/\b(I|I'm|the|a)\b/.test(lself), 'a leafkin speaks pidgin: its own name, no "I", no articles', lself)
check(!lc.menu().some((c) => c.topic.startsWith('where:title')), 'a leafkin is not asked for the smith')
const retold = (topic) => new Set(Array.from({ length: 16 }, (_, salt) => new Conversation(leaf[0], ctxAt({ x: 0, z: 0 }), salt).say(topic).text))
check(retold('talk:self').size >= 3 && retold('lore:striders').size >= 3, 'a leafkin asked the same thing in sixteen talks words it at least three ways', [...retold('talk:self'), ...retold('lore:striders')].join(' / '))
const pidgin = [...Object.values(LK).flat(), ...Object.values(LORE).flatMap((fs) => fs.flatMap((x) => x.lk ?? []))].filter((l) => /\b(I|I'm|the|a)\b/.test(l))
check(pidgin.length === 0, 'every leafkin wording keeps to pidgin: no "I", no articles', pidgin.join(' / '))

// --- lore ---
const folk = all.filter((m) => m.cls === 'folk')
const asked = (m, topic, more = {}, ctx = ctxAt(fire(world.townOf(m)))) => new Conversation(as(m, more), ctx).say(`lore:${topic}`)
const truths = new Set(LORE.dragons.map((x) => x.truth))
const knew = folk.map((m) => asked(m, 'dragons', STRAIGHT)).filter((l) => l.claim !== null)
check(knew.length > folk.length * 0.2 && knew.every((l) => truths.has(l.claim)), 'honest folk who know of dragons tell a true thing about them', `${knew.length} of ${folk.length}`)
const dunnos = folk.map((m) => asked(m, 'leafkin', { ...STRAIGHT, boast: 0 })).filter((l) => l.claim === null)
check(dunnos.length > 0 && dunnos.every((l) => l.moment === 'answer.unknown'), 'someone who does not know and will not boast shrugs it off', dunnos[0]?.text)
const tales = new Set(LORE.leafkin.flatMap((x) => x.tales))
const boasts = folk.map((m) => asked(m, 'leafkin', { boast: 1 })).filter((l) => l.how?.boast && tales.has(l.claim))
check(boasts.length > 0 && boasts.every((l) => l.moment === 'answer.boast'), 'a boaster who does not know tells a tall tale instead', boasts[0]?.text)
const lies = new Set(Object.values(LORE).flatMap((fs) => fs.flatMap((x) => x.lies)))
const liars = all.flatMap((m) => Object.keys(LORE).map((t) => asked(m, t, { honesty: 0, accuracy: 1, boast: 0, wariness: 0 }))).filter((l) => lies.has(l.claim))
check(liars.length > 0, 'a dishonest person sometimes spreads misinformation', liars[0]?.text)
const kctx = ctxAt(fire(t0))
check(!new Conversation(t0.minds[0], kctx).menu().some((c) => c.topic === 'lore:gems'), 'gems have no button until someone mentions them')
const gemTeller = all.map((m) => {
  const ctx = ctxAt(fire(world.townOf(m)))
  const c = new Conversation(as(m, { ...STRAIGHT, greed: 0 }), ctx)
  return [c.say('lore:coins'), c.say('lore:coins')].some((l) => l.unlocks.includes('gems')) ? ctx : null
}).find((ctx) => ctx !== null)
check(gemTeller !== undefined && new Conversation(t0.minds[0], gemTeller).menu().some((c) => c.topic === 'lore:gems'), 'told of traders and gems, she can ask anyone about gems after', gemTeller && [...gemTeller.known].join(', '))
check(Object.values(LORE).every((fs) => fs.length > 0) && Object.keys(TOPICS).every((t) => LORE[t] !== undefined), 'every topic has lore')
// Whatever a fact names, she can follow up: each topic its words name is in its `unlocks`.
const NAMES = { mushrooms: /mushroom|chanterelle|agaric|porcini|ink cap|parasol/i, curses: /\bcurse/i, flares: /\bflare/i, caves: /\bcaves?\b/i, labyrinths: /\bmazes?\b/i, gems: /\bgems?\b|diamond|ruby|jade/i, leafkin: /leafkin/i, ores: /\bflint\b|\bores?\b|\biron\b|copper|titanium|firestone/i, eating: /\beat\b/i, dragons: /dragon/i, snowlands: /\bsnow\b/i, yetis: /\byetis?\b/i, weapons: /\bswords?\b|\bshields?\b/i, mining: /pickaxe/i, spiders: /spider/i, giants: /giants?\b/i }
const unnamed = Object.entries(LORE).flatMap(([t, fs]) => fs.flatMap((x) => Object.entries(NAMES).filter(([k, re]) => k !== t && re.test(x.truth) && !x.unlocks.includes(k)).map(([k]) => `${t}.${x.id} names ${k}`)))
check(unnamed.length === 0, 'every topic a fact names is one she may ask of next', unnamed.join(', '))
const heard = new Set(Object.keys(TOPICS).filter((t) => !TOPICS[t].gated))
for (let grew = true; grew;) { grew = false; for (const t of [...heard]) for (const x of LORE[t]) for (const u of x.unlocks) if (!heard.has(u)) { heard.add(u); grew = true } }
check(Object.keys(TOPICS).every((t) => heard.has(t)), 'every gated topic can be heard of, starting from the open ones', Object.keys(TOPICS).filter((t) => !heard.has(t)).join(', '))
const adults = all.filter((m) => m.kind === 'human' && m.cls !== 'child')
const brews = LORE.alchemist.find((x) => x.id === 'brews').truth
let brewed = null
for (const m of adults) {
  const ctx = ctxAt(fire(world.townOf(m)))
  const c = new Conversation(as(m, { ...STRAIGHT, greed: 0 }), ctx)
  for (let i = 0; i < LORE.alchemist.length && brewed === null; i++) if (c.say('lore:alchemist').claim === brews) brewed = { c, ctx, m }
  if (brewed !== null) break
}
const firstChips = brewed && brewed.c.menu().slice(0, 3).map((x) => x.label)
const stranger = brewed && all.find((m) => m.kind === 'human' && m.town !== brewed.m.town)
check(brewed !== null && firstChips.includes('What are mushrooms good for?') && firstChips.includes('Can I eat wild things?') && new Conversation(stranger, brewed.ctx).menu().some((x) => x.topic === 'lore:mushrooms'), 'told the potion master brews from mushrooms, she is offered "What are mushrooms good for?" at once, and may ask anyone after', firstChips && firstChips.join(' / '))
const leafLore = new Conversation(leaf[0], ctxAt({ x: 0, z: 0 })).say('lore:alchemist')
check(leafLore.claim === null, 'a leafkin has no words for the alchemist', leafLore.text)
const striderTruths = new Set(LORE.striders.map((x) => x.truth))
const striderTold = adults.filter((m) => striderTruths.has(asked(m, 'striders', STRAIGHT).claim))
check(striderTold.length > adults.length * 0.85, 'nearly every grown-up can tell her something true about striders', `${striderTold.length} of ${adults.length}`)
let referred = null
for (const m of folk) {
  const c = new Conversation(as(m, { ...STRAIGHT, boast: 0 }), ctxAt(fire(world.townOf(m))))
  const l = c.say('lore:labyrinths')
  if (l.claim === null && /Ask |Try |would know/.test(l.text) && l.about.length > 0) { referred = { l, menu: c.menu() }; break }
}
check(referred !== null && referred.menu.some((x) => x.topic === `where:person:${referred.l.about[0].id}`), 'one who does not know sends her to whoever in town knows best, and she can ask where they are', referred?.l.text)
// Contested lore: the same honest asking draws belief, scoffing, and (from a witness who trusts her) a sighting.
const yeti = LORE.yetis.find((x) => x.id === 'wastes')
const yetiSay = (warmth) => adults.map((m) => {
  const ctx = ctxAt(fire(world.townOf(m)))
  ctx.rapport.warm(m.id, warmth)
  const c = new Conversation(as(m, { ...STRAIGHT, greed: 0 }), ctx)
  return { m, claims: LORE.yetis.map(() => c.say('lore:yetis').claim) }
})
const yetiCold = yetiSay(0), yetiWarm = yetiSay(0.5)
const held = (rows, pred) => rows.filter((r) => r.claims.some(pred))
const believers = held(yetiCold, (c) => c === yeti.truth), doubters = held(yetiCold, (c) => yeti.doubt.includes(c))
check(believers.length > 0 && doubters.length > 0, 'honest folk split on yetis: some tell of them, some scoff', `${believers.length} believe, ${doubters.length} scoff`)
const travelShare = (rows) => rows.filter((r) => r.m.cls === 'travel').length / rows.length
check(travelShare(believers) > travelShare(doubters), 'travellers believe in yetis more than stay-at-homes do', `${travelShare(believers).toFixed(2)} of believers, ${travelShare(doubters).toFixed(2)} of doubters`)
const witnesses = held(yetiWarm, (c) => c === yeti.seen)
check(held(yetiCold, (c) => c === yeti.seen).length === 0 && witnesses.length > 0 && witnesses.every((r) => r.m.cls === 'travel' || r.m.body === 'hunter'), 'only a traveller or hunter tells of seeing a yeti, and only to someone they trust', `${witnesses.length} witnesses: ${witnesses.map((r) => r.m.body).join(', ')}`)

// Sent on: a friendly speaker who cannot help names who can; asked who knows, they point; a scoffer still sends her to the tale-teller.
const FRIENDLY = { ...STRAIGHT, boast: 0, kindness: 1, chattiness: 1 }, SURLY = { ...STRAIGHT, boast: 0, kindness: 0, chattiness: 0, wariness: 1 }
const dunnoOf = (traits) => folk.map((m) => asked(m, 'labyrinths', traits)).filter((l) => l.moment === 'answer.unknown')
check(dunnoOf(SURLY).every((l) => !/Ask |Try |would know/.test(l.text)), 'a curt speaker who does not know sends her nowhere', dunnoOf(SURLY)[0]?.text)
check(dunnoOf(FRIENDLY).every((l) => /(Ask|Try) \w+ the \w+\.|would know/.test(l.text)), 'a friendly speaker who does not know names who would, by name and calling', dunnoOf(FRIENDLY)[0]?.text)
const whoOf = (m, topic, traits, known = []) => {
  const c = new Conversation(as(m, traits), ctxAt(fire(world.townOf(m)), { known: new Set(known) }))
  return { c, l: c.say(`who:${topic}`) }
}
const pointer = folk.map((m) => ({ m, ...whoOf(m, 'ores', FRIENDLY) })).find(({ m, l }) => m.body !== 'blacksmith' && l.about.length > 0)
check(pointer !== undefined && pointer.c.menu().some((x) => x.label === 'Who knows about striders?') && pointer.c.menu().some((x) => x.topic === `where:person:${pointer.l.about[0].id}`), 'asked who knows of ores, a friendly non-smith names the expert, and she can ask where they are', pointer?.l.text)
const smiths = all.filter((m) => m.body === 'blacksmith').map((m) => whoOf(m, 'ores', FRIENDLY).l)
check(smiths.length > 0 && smiths.every((l) => /looking at one|would be me/.test(l.text)), 'asked who knows of ores, the smith says they do', smiths[0]?.text)
check(folk.every((m) => whoOf(m, 'ores', SURLY).l.mood === 'cold'), 'a surly speaker will not say who knows')
const yetiScoffs = adults.map((m) => whoOf(m, 'yetis', FRIENDLY, ['yetis']).l).filter((l) => /no yetis/.test(l.text))
check(yetiScoffs.length > 0 && yetiScoffs.some((l) => /tall tales you want, ask \w+/.test(l.text)), 'asked who knows of yetis, a doubter says nobody, and sends her to the tale-teller', yetiScoffs.find((l) => /tall tales/.test(l.text))?.text)
const yetiDoubts = LORE.yetis.flatMap((x) => x.doubt)
const scoffsOf = (traits) => adults.flatMap((m) => {
  const c = new Conversation(as(m, traits), ctxAt(fire(world.townOf(m))))
  return LORE.yetis.map(() => c.say('lore:yetis'))
}).filter((l) => yetiDoubts.includes(l.claim))
const talesTo = (ls) => ls.filter((l) => /tall tales you want/.test(l.text))
check(talesTo(scoffsOf(FRIENDLY)).length > 0 && scoffsOf(SURLY).length > 0 && talesTo(scoffsOf(SURLY)).length === 0, 'a friendly scoffer at yetis points her to the tale-teller, a surly one does not', talesTo(scoffsOf(FRIENDLY))[0]?.text)

const humans = adults.filter((m) => m.kind === 'human')
// Guarded lore: what mushrooms do and who was cursed by one is told only to someone they have warmed to.
const guarded = Object.values(LORE).flatMap((fs) => fs.filter((x) => x.trust > 0)).flatMap((x) => [x.truth, ...x.lies, ...x.tales])
const allKnown = () => new Set(Object.keys(TOPICS))
const tellings = (m, warmth, topics = ['mushrooms', 'curses', 'striders']) => {
  const ctx = ctxAt(fire(world.townOf(m)), { known: allKnown() })
  if (warmth > 0) ctx.rapport.warm(m.id, warmth)
  const c = new Conversation(m, ctx)
  return topics.flatMap((t) => [0, 1, 2, 3, 4, 5].map(() => c.say(`lore:${t}`)))
}
const leaked = humans.flatMap((m) => tellings(m, 0).filter((l) => guarded.some((g) => l.text.includes(g.replace(/^([^.!?]*[.!?]).*$/, '$1'))))).map((l) => l.text)
check(leaked.length === 0, 'no stranger tells her what mushrooms do or of a mushroom curse, truth, lie or tall tale', leaked.slice(0, 2).join(' | '))
const holding = humans.flatMap((m) => tellings(m, 0, ['curses'])).filter((l) => l.moment === 'refuse.wary' && l.about.some((a) => a.kind === 'lore'))
check(holding.length > humans.length * 0.2 && holding.some((l) => /know you/.test(l.text)), 'one who knows a guarded thing tells a stranger there is more, once she knows them better', holding[0]?.text)
const effectTruths = LORE.mushrooms.filter((x) => x.trust === TRUST.told).map((x) => x.truth)
const curseTruths = LORE.curses.map((x) => x.truth)
const toldAt = (warmth, truths, topic) => humans.filter((m) => tellings(as(m, STRAIGHT), warmth, [topic]).some((l) => truths.some((t) => l.text.includes(t.slice(0, 30))))).length
const effectsWarm = toldAt(TRUST.told, effectTruths, 'mushrooms'), cursesTold = toldAt(TRUST.told, curseTruths, 'curses'), cursesClose = toldAt(TRUST.close, curseTruths, 'curses')
check(effectsWarm > humans.length * 0.4 && cursesTold === 0 && cursesClose > humans.length * 0.2, 'a few kind words open what mushrooms do; a curse tale wants a friendlier footing', `effects ${effectsWarm}, curses at told ${cursesTold}, at close ${cursesClose} of ${humans.length}`)
const befriended = humans.filter((m) => {
  const ctx = ctxAt(fire(world.townOf(m)))
  const c = new Conversation(m, ctx)
  for (const t of ['nice:greet', 'talk:self', 'nice:work', 'talk:town', 'nice:life', 'talk:needs', 'nice:town']) c.say(t)
  return ctx.rapport.standing(m.id) >= TRUST.told
}).length
check(befriended > humans.length * 0.8, 'one friendly talk of kind words earns most people\'s trust enough to hear what mushrooms do', `${befriended} of ${humans.length}`)
const effectTeller = humans.map((m) => {
  const ctx = ctxAt(fire(world.townOf(m)), { known: allKnown() })
  ctx.rapport.warm(m.id, TRUST.told)
  const c = new Conversation(as(m, STRAIGHT), ctx)
  for (let i = 0; i < 6; i++) { const l = c.say('lore:mushrooms'); if (l.claim !== null && l.claim === LORE.mushrooms.find((x) => x.id === 'chanterelle').truth) return c }
  return null
}).find((c) => c !== null)
check(effectTeller !== undefined && effectTeller.menu().some((x) => x.topic === 'lore:curses'), 'told what a chanterelle does, she may ask about mushroom curses next', effectTeller?.menu().slice(0, 3).map((x) => x.label).join(' / '))
const flareRecall = LORE.flares.find((x) => x.id === 'recall').truth
const trappers = all.filter((m) => m.body === 'trapper')
const recallTold = trappers.filter((m) => tellings(as(m, STRAIGHT), 0, ['flares']).some((l) => l.claim === flareRecall)).length
check(LORE.alchemist.find((x) => x.id === 'flare').unlocks.includes('flares') && recallTold > trappers.length * 0.5, 'told of flare guns, she can ask what they are for, and a trapper explains recalling a flare for its charge', `${recallTold} of ${trappers.length} trappers`)

// --- follow-ups and wording ---
const grudger = all.find((m) => m.rival !== null && m.cls !== 'child')
const rival = world.townOf(grudger).minds[grudger.rival]
const grudge = new Conversation(as(grudger, STRAIGHT), ctxAt(fire(world.townOf(grudger))))
const opinion = grudge.say(`ask:person:${rival.id}`)
const fm = grudge.menu()
check(fm[0].topic === `why:person:${rival.id}` && fm.some((x) => x.label === `Where is ${rival.name}?`), 'told of a rival, her first chips ask why, and where the rival is', `${opinion.text} -> ${fm.slice(0, 3).map((x) => x.label).join(' / ')}`)
const why = grudge.say(`why:person:${rival.id}`)
check(why.text.includes(`${rival.name}? `) && why.moment === 'nv.sigh', 'asked why, they tell the grudge', why.text)
let late = null
for (const t of world.towns) {
  const speaker = t.minds.find((m) => m.cls !== 'child')
  const p = speaker && t.minds.find((o) => o.id !== speaker.id && !speaker.household.includes(o.index) && world.placeOf(o).building === o.home && world.placeOf(o).label !== 'the inn')
  if (p) { late = { p, l: new Conversation(as(speaker, STRAIGHT), ctxAt(fire(t), { hour: 22 })).say(`where:person:${p.id}`) }; break }
}
check(late !== null && late.l.text.includes(late.p.voice.he ? "He's likely home by now." : "She's likely home by now.") && !late.l.text.includes(`${late.p.name}'s house`), 'asked at night where someone is, they say the person is likely home by now', late?.l.text)

// --- kind words ---
const MOVE_NAMES = ['greet', 'thanks', 'work', 'life', 'town', 'craft', 'sorry', 'leave']
// One with nothing on their mind, for the single-person checks.
const calm = humans.filter((m) => !qs.some((x) => x.parent === m.id))
const gainOf = (m, topic, ctx = ctxAt(fire(world.townOf(m)))) => {
  const before = ctx.rapport.standing(m.id)
  const line = new Conversation(m, ctx).say(topic)
  return { gain: ctx.rapport.standing(m.id) - before, line }
}
const unwarmed = MOVE_NAMES.flatMap((mv) => humans.filter((m) => !(gainOf(m, `nice:${mv}`).gain > 0)).map((m) => `${mv}:${m.name}`))
check(unwarmed.length === 0, 'every kind word warms everyone a little on first saying', unwarmed.slice(0, 6).join(', '))
const landed = MOVE_NAMES.map((mv) => [mv, humans.filter((m) => gainOf(m, `nice:${mv}`).line.mood === 'warm').length / humans.length])
check(landed.every(([, f]) => f >= 0.3 && f < 1), 'each kind word visibly lands with many people but not all', landed.map(([mv, f]) => `${mv} ${(f * 100) | 0}%`).join(', '))
const chatterer = gainOf(as(calm[0], { chattiness: 1, boast: 1 }), 'nice:work').gain, mute = gainOf(as(calm[0], { chattiness: 0, boast: 0 }), 'nice:work').gain
check(chatterer > 2 * mute && mute > 0, 'asked after their work, a chatty boaster warms far more than a quiet modest soul, who still warms', `${chatterer.toFixed(3)} vs ${mute.toFixed(3)}`)
const helpGain = gainOf(as(calm[0], { kindness: 1, greed: 1 }), 'talk:needs')
check(helpGain.gain > 0 && helpGain.line.mood === 'warm', 'offering help warms them', helpGain.line.text)
const greetCtx = ctxAt(fire(world.townOf(calm[0])))
const greets = [0, 1, 2].map(() => gainOf(calm[0], 'nice:greet', greetCtx).gain)
const nextDay = gainOf(calm[0], 'nice:greet', { ...greetCtx, epoch: EPOCH + 1 }).gain
check(greets[1] < greets[0] && greets[2] === 0 && nextDay > 0, 'the same kind word warms less said again, nothing a third time that day, and anew the next', greets.map((g) => g.toFixed(3)).join(' ') + ` / ${nextDay.toFixed(3)}`)
const fctx = ctxAt(fire(world.townOf(calm[0])))
const fawner = new Conversation(calm[0], fctx)
const fawned = ['work', 'life', 'town'].map((mv) => fawner.say(`nice:${mv}`))
const paced = new Conversation(calm[1], ctxAt(fire(world.townOf(calm[1]))))
const pacedLines = ['nice:work', 'talk:self', 'nice:life', 'talk:town', 'nice:town'].map((t) => paced.say(t))
check(fawned[2].mood === 'cold' && fctx.rapport.standing(calm[0].id) < fawned.slice(0, 2).length * 0.2 && !pacedLines.some((l) => l.mood === 'cold'), 'praise and small talk three in a row reads as buttering up, but spaced with real talk it does not', fawned[2].text)
const capCtx = ctxAt(fire(world.townOf(calm[0])))
const keen = as(calm[0], { chattiness: 1, boast: 1, kindness: 1, greed: 1, wariness: 1 })
for (const mv of MOVE_NAMES) for (let i = 0; i < 2; i++) { const c = new Conversation(keen, capCtx); c.say('talk:self'); c.say(`nice:${mv}`) }
check(Math.abs(capCtx.rapport.standing(keen.id) - MANNERS.cap) < 1e-9, 'kind words alone warm one person only so far in a day', capCtx.rapport.standing(keen.id).toFixed(3))
const toneCtx = ctxAt(fire(world.townOf(calm[0])))
const cheeryBefore = humans.filter((m) => new Conversation(m, toneCtx).tone === 'cheery').length
for (const m of humans) for (const [i, mv] of ['greet', 'work', 'town', 'thanks', 'life', 'leave'].entries()) { const c = new Conversation(m, toneCtx); if (i % 2) c.say('talk:self'); c.say(`nice:${mv}`) }
const cheeryAfter = humans.filter((m) => new Conversation(m, toneCtx).tone === 'cheery').length
check(cheeryAfter > cheeryBefore, 'a day of kind words turns some people cheery', `${cheeryBefore} -> ${cheeryAfter} of ${humans.length}`)
const nctx = ctxAt(fire(world.townOf(calm[0])))
const firstMenu = new Conversation(calm[0], nctx).menu().map((x) => x.label)
new Conversation(calm[0], nctx).say('talk:self')
const knownMenu = new Conversation(calm[0], nctx).menu().map((x) => x.label)
const laterConv = new Conversation(calm[0], nctx)
laterConv.say('talk:town')
check(firstMenu.includes('Good day to you.') && knownMenu.includes(`Good day, ${calm[0].name}.`) && !laterConv.menu().some((x) => x.topic === 'nice:greet'), 'she greets someone by name once she knows it, and only on meeting', knownMenu.filter((l) => l.startsWith('Good day')).join(''))
const craftLater = new Conversation(calm[0], ctxAt(fire(world.townOf(calm[0]))))
const craftBefore = craftLater.menu().some((x) => x.topic === 'nice:craft')
craftLater.say('nice:work')
check(!craftBefore && craftLater.menu().some((x) => x.topic === 'nice:craft'), 'she praises their work only once she has heard what it is')
const pConv = new Conversation(parent, ctxAt(fire(world.townOf(parent))))
const sorry = pConv.menu().find((x) => x.topic === 'nice:sorry')
check(sorry !== undefined && !new Conversation(calm[0], ctxAt(fire(world.townOf(calm[0])))).menu().some((x) => x.topic === 'nice:sorry') && pConv.say('nice:sorry').text.includes(world.person(q.child).name), 'she offers sympathy only where there is a worry, and it is heard', sorry?.label)
check(!new Conversation(leaf[0], ctxAt({ x: 0, z: 0 })).menu().some((x) => x.topic.startsWith('nice:')), 'a leafkin is offered no pleasantries')
const lctx = ctxAt(fire(world.townOf(calm[0])))
const leaver = new Chat(calm[0], lctx)
leaver.ask('talk:town')
const left = leaver.ask('nice:leave')
check(left.ended && left.alone >= CHAT.alone.bye && lctx.rapport.standing(calm[0].id) > 0, '"I won\'t keep you" ends the talk and leaves them warmer', left.text)
const octx = ctxAt(fire(world.townOf(calm[0])))
const pest = new Chat(as(calm[0], { chattiness: 0, kindness: 0, wariness: 1 }), octx)
let pestLast = null
for (let i = 0; i < 40 && pest.parting === null; i++) pestLast = pest.ask('talk:town')
check(pest.parting !== null && !pestLast.ended && octx.rapport.standing(calm[0].id) < 0, 'pushing past someone\'s patience until sent off cools them', pestLast.text)
const pestMenu = pest.menu()
const pestOff = pest.ask(NEXT.topic)
check(pestMenu.length === 1 && pestMenu[0] === NEXT && !pestLast.text.includes(pestOff.text) && pestOff.ended && pestOff.moment === 'bye.curt', 'sent off, her only chip is the arrow, and the sign-off comes alone on the page after', `${pestLast.text} -> ${pestOff.text}`)

// --- the dialog grid ---
const menuCtx = ctxAt(fire(t0), { known: new Set(Object.keys(TOPICS)) })
const gm = new Conversation(t0.minds[0], menuCtx).menu()
check(gm.every((c) => (c.path.length >= 2 && c.path.length <= 5) || c.topic === 'bye') && gm.every((c) => /[.?!"]$/.test(c.path.at(-1))), 'every sentence is 2-5 fragments, its last one punctuated (goodbye stands alone)', gm.filter((c) => c.path.length > 5 || c.path.length < 2).map((c) => c.label).join(' | '))
const grid = new DialogGrid()
const top = grid.cells(gm)
check(top.length === 16 && top[0].kind === 'empty' && top.some((c) => c.text === 'Goodbye.' && c.kind === 'send'), 'the top grid is 4x4, goodbye among its first fragments, no back arrow yet', top.filter((c) => c.text).map((c) => c.text).join(' / '))
let sent = null
for (const want of ['Where', 'is the', 'smith?']) sent = grid.press(gm, grid.cells(gm).findIndex((c) => c.text === want))
check(sent === 'where:title:smith' && grid.path.length === 0, 'three fragments build "Where is the smith?" and send it', sent)
grid.press(gm, grid.cells(gm).findIndex((c) => c.text === 'Where'))
grid.press(gm, grid.cells(gm).findIndex((c) => c.text === 'is the'))
grid.press(gm, 0)
check(grid.path.join(' ') === 'Where' && grid.cells(gm)[0].kind === 'back', 'the back arrow steps back one fragment', grid.path.join(' '))
const reach = new Set()
const walk = (g, depth) => {
  for (let i = 0; i < 16; i++) {
    const c = g.cells(gm)[i]
    if (c.kind === 'send') reach.add(c.topic)
    if (c.kind === 'stem' || c.kind === 'more') {
      const h = new DialogGrid()
      h.path = [...g.path]
      h.page = g.page
      h.press(gm, i)
      if (depth < 6) walk(h, depth + 1)
    }
  }
}
walk(new DialogGrid(), 0)
check(gm.every((c) => reach.has(c.topic)), 'every chip can be reached through the grid', gm.filter((c) => !reach.has(c.topic)).map((c) => c.label).join(' | '))

// --- a conversation lived ---
const cheery = as(all.find((m) => m.cls === 'folk' && !trade.isSmith(m) && !trade.isAlchemist(m)), { kindness: 1, chattiness: 1, wariness: 0 })
const open1 = new Chat(cheery, ctxAt(fire(world.townOf(cheery)))).open()
check(!open1.ended && open1.moment.startsWith('greet.'), 'a cheery person hailed by a stranger greets her', open1.text)
const shunned = ctxAt(fire(world.townOf(cheery)))
shunned.rapport.catchLie(cheery.id)
shunned.rapport.catchLie(cheery.id)
const no = new Chat(cheery, shunned).open()
check(no.ended && no.alone > 0, 'someone she has lied to twice will not talk to her, and she is left alone a while', no.text)
const busy = [0, 1, 2, 3, 4, 5].map((s) => new Chat(as(cheery, { chattiness: 0 }), ctxAt(fire(world.townOf(cheery))), { busy: true, salt: s }).open())
check(busy.some((l) => l.ended && l.moment === 'mood.busy'), 'a busy, unchatty person may decline', busy.find((l) => l.ended)?.text)
const wild = new Chat(leaf[0], ctxAt({ x: 0, z: 0 }), { trusted: false }).open()
check(wild.ended && wild.moment === 'refuse.wary', 'a leafkin that does not trust her will not talk', wild.text)
const terse = new Chat(as(cheery, { chattiness: 0, kindness: 0, wariness: 1 }), ctxAt(fire(world.townOf(cheery))))
let turns = 0, last = null
while (terse.parting === null && turns < 40) { last = terse.ask('talk:town'); turns++ }
const terseOff = terse.ask(NEXT.topic)
check(terse.parting !== null && turns <= terse.patience && last.alone > 0 && terseOff.ended, 'a curt person runs out of patience and sends her off', `${turns} questions: ${last.text} -> ${terseOff.text}`)
const byeChat = new Chat(cheery, ctxAt(fire(world.townOf(cheery))))
const bye = byeChat.ask('bye')
check(bye.ended && bye.moment === 'bye.warm' && bye.alone >= CHAT.alone.bye, 'goodbye ends it warmly, and they leave her be after', bye.text)
const byeAt = (t, hour, w = world) => new Conversation(as(t.minds.find((m) => m.cls !== 'child'), STRAIGHT), ctxAt(fire(t), { hour, world: w })).bye()
const hidden = world.towns.find((t) => world.hideouts[t.index] !== null)
const duskBye = byeAt(hidden, 18)
check(duskBye.moment === 'observe.dusk' && duskBye.text.includes(world.hideouts[hidden.index].label), 'at dusk a friendly goodbye warns her off her town\'s hideout by name', duskBye.text)
check(byeAt(hidden, 12).moment === 'bye.warm' && byeAt(hidden, 18, new TalkWorld(SEED, towns)).moment === 'bye.warm', 'by day, or in a town with no hideout, it is only goodbye')

// --- voices ---
const table = JSON.parse(readFileSync(new URL('../public/sounds/voice/moments.json', import.meta.url), 'utf8'))
const lines = new LinePicker(table, SEED)
const speaker = all.find((m) => m.voice.pack === 'man')
const heardLines = Array.from({ length: 6 }, (_, i) => lines.pick(speaker, 'greet.stranger', { now: i * 100 }).line)
check(heardLines.every((l, i) => i === 0 || l !== heardLines[i - 1]) && table.human['greet.stranger'].includes(heardLines[0]), 'a speaker greets from their moment\'s pool, never the same line twice running', heardLines.join(' '))
check(lines.pick(speaker, 'pass.nod', { now: 500.5 }) === null && lines.pick(speaker, 'pass.nod', { now: 500.5, force: true }) !== null, 'a speaker says nothing again within the gap, unless answering her')
const moments = new Set(Object.keys(table.human))
const said = []
for (const m of [t0.minds[0], leaf[0]]) {
  const c = new Conversation(m, ctxAt(fire(t0), { known: new Set(Object.keys(TOPICS)) }))
  said.push(c.opener(), c.bye(), ...c.menu().filter((x) => x.topic !== 'bye').map((x) => c.say(x.topic)))
}
check(said.every((l) => moments.has(l.moment)), 'every line the engine says names a recorded moment', said.filter((l) => !moments.has(l.moment)).map((l) => l.moment).join(', '))
const lk = leaf[0]
const tiers = ['native', 'mixed', 'pidgin'].map((t) => lines.pick(lk, 'greet.stranger', { now: 1e4, force: true, tier: t }).line)
check(tiers.every((l, i) => l.includes(['native', 'mixed', 'pidgin'][i])) && leafkinTier(false, 1) === 'native' && leafkinTier(true, 0) === 'mixed' && leafkinTier(true, 1) === 'pidgin', 'a leafkin speaks its own tongue until it trusts her, then pidgin as she warms it', tiers.join(' '))
const he = all.find((m) => m.voice.he), she = all.find((m) => !m.voice.he && m.kind === 'human')
check(he.voice.pack !== she.voice.pack && all.every((m) => Math.abs(m.voice.rate - 1) <= VOICE.rate && Math.abs(m.voice.tilt) <= VOICE.tilt), 'each person speaks with their body\'s voice, shifted a little in pitch and tone of their own')
const unvoiced = []
for (const [kind, book] of Object.entries(EXCHANGES)) for (const [ex, steps] of Object.entries(book)) for (const step of steps) {
  if (step.split(' | ').every((alt) => /^(warm|cold)> /.test(alt))) unvoiced.push(`${ex}: ${step} has nothing for a plain speaker`)
}
for (const [kind, book] of Object.entries(EXCHANGES)) for (const [ex, steps] of Object.entries(book)) for (const step of steps) for (const alt of step.split(' | ').map((a) => a.replace(/^(warm|cold)> /, ''))) {
  const [moment, ids] = alt.split(': ')
  if (kind === 'leafkin') { if (ids !== undefined || LEAFKIN_ATOM[moment] === undefined) unvoiced.push(`${ex}: ${alt}`); continue }
  const have = new Set((table.human[moment] ?? []).map((l) => l.slice(0, l.indexOf('.'))))
  for (const id of ids === undefined ? [] : ids.split(' ')) if (!have.has(id)) unvoiced.push(`${ex}: ${moment} ${id}`)
  if (ids === undefined) unvoiced.push(`${ex}: ${alt} names no words`)
}
check(unvoiced.length === 0, 'every chatter exchange step names words recorded for its moment (leafkin, a moment with an atom)', unvoiced.join(', '))
const pair = [t0.minds[0], t0.minds[1]]
const heardSteps = []
let at = null
for (let i = 0; i < 40; i++) {
  const s = chatterStep(pair[i % 2], ctxAt(fire(t0)), at, { hour: 14, r: (i * 0.37) % 1, alt: (i * 0.61) % 1 })
  if (s === null) break
  if (s.moment === null) continue
  heardSteps.push(`${s.at.ex}.${s.at.step}`)
  at = s.at
}
const inOrder = heardSteps.every((s, i) => {
  const [ex, n] = s.split('.')
  return i === 0 ? ex === 'greet' && n === '1' : n === '1' ? heardSteps[i - 1].split('.')[1] === String(EXCHANGES.human[heardSteps[i - 1].split('.')[0]].length) : heardSteps[i - 1] === `${ex}.${n - 1}`
})
check(inOrder, 'two neighbours meet with a greeting, then talk each exchange through in order before the next', heardSteps.join(' '))
// Overheard, the cheery chat and laugh and the curt grunt, cut it short or keep quiet.
const chatterOf = (tone) => {
  const ctx = ctxAt(fire(t0))
  const minds = world.towns.flatMap((t) => t.minds).filter((m) => m.kind === 'human' && new Conversation(m, ctx).tone === tone && !new Conversation(m, ctx)._worried())
  const heard = { warm: 0, cold: 0, all: 0 }
  minds.forEach((m, k) => {
    let at = null
    for (let i = 0; i < 30; i++) {
      const s = chatterStep(m, ctx, at, { hour: 14, r: ((k + 1) * 0.618 + i * 0.37) % 1, alt: ((k + 1) * 0.29 + i * 0.61) % 1 })
      if (s === null) { at = null; continue }
      heard.all++
      at = s.at
      if (s.moment === null || /^(social\.(ack|cut|disagree)|greet\.curt)$/.test(s.moment)) heard.cold++
      if (/^(gossip|small|nv\.laugh|social\.comfort|greet\.friend)/.test(s.moment ?? '')) heard.warm++
    }
  })
  return { n: minds.length, warm: heard.warm / heard.all, cold: heard.cold / heard.all }
}
const cheeryTalk = chatterOf('cheery'), curtTalk = chatterOf('curt')
check(cheeryTalk.n > 0 && curtTalk.n > 0 && cheeryTalk.warm > curtTalk.warm * 2 && curtTalk.cold > cheeryTalk.cold * 2, 'overheard, a cheery neighbour chats and laughs and a curt one grunts, cuts it short or keeps quiet', JSON.stringify({ cheeryTalk, curtTalk }))
const parted = chatterStep(t0.minds[0], ctxAt(fire(t0)), { ex: 'tired', step: 4, done: true }, { hour: 22, r: 0.5, alt: 0.5 })
check(parted === null, 'a pair who have said goodbye say nothing more until they meet afresh')
const lone = new LinePicker(table, SEED).pick(t0.minds[0], 'gossip.lead', { now: 1e4, force: true, only: ['between-us'] })
check(lone !== null && lone.line.startsWith('between-us.'), 'a chatter step says only the words it names', lone?.line)
const formed = Object.entries(table.human).find(([, ls]) => ls.some((l) => l.includes('{')))
if (formed) {
  const [mom] = formed
  const p = new LinePicker(table, 1).pool(speaker, mom, { form: 'she' })
  check(p.length > 0 && p.every((l) => !l.includes('{') && !/-(he|him)$/.test(l)), 'a line recorded in forms is said in the form for who is meant', `${mom}: ${p.join(' ')}`)
}

// --- stream T: wording, pointing, shop, trade, hearsay, fury ---
{
const human = as(all.find((m) => m.cls === 'folk' && !trade.isSmith(m) && !trade.isAlchemist(m)), STRAIGHT)
const humanTown = world.townOf(human)
const askMany = (mind, topic, ctx, n = 20) => {
  const conv = new Conversation(mind, ctx)
  return Array.from({ length: n }, () => conv.say(topic).text)
}
for (const [who, topics] of [[human, ['talk:self', 'talk:town', 'talk:needs', 'where:title:smith', 'where:here', 'lore:striders', 'nice:work']], [leaf[0], ['talk:self', 'lore:striders', 'talk:needs']]]) {
  for (const topic of topics) {
    const texts = askMany(who, topic, ctxAt(fire(humanTown)))
    const backToBack = texts.filter((t, i) => i > 0 && t === texts[i - 1]).length
    check(backToBack === 0 && new Set(texts).size >= 6, `${who.kind} asked ${topic} 20 times: no back-to-back repeat, 6+ wordings`, `${new Set(texts).size} distinct, ${backToBack} repeats: ${texts.slice(4, 12).join(' // ')}`)
  }
}

const busyTown = humanTown
const passed = []
for (let salt = 0; salt < 40; salt++) {
  const o = new Chat(as(human, { chattiness: 0 }), ctxAt(fire(busyTown)), { busy: true, salt }).open()
  if (o.ended && o.moment === 'mood.busy' && o.about.length > 0) passed.push(o)
}
check(passed.length > 0, 'a busy person sometimes points her to a friendlier person and says where to find them', passed[0]?.text)
check(passed.every((o) => o.about.some((a) => a.kind === 'person') && o.about.filter((a) => a.kind === 'person').every((a) => world.person(a.id).town === humanTown.index)), 'the person a busy one points to lives in the same town', JSON.stringify(passed[0]?.about))

const smithTown = world.towns.find((t) => world.titled(t, 'smith'))
const smith = as(world.titled(smithTown, 'smith'), STRAIGHT)
const inShop = (pack, more = {}) => ctxAt(fire(smithTown), { inWorkshop: true, pack, ...more })
const opening = new Conversation(smith, inShop(stubPack())).opener()
check(opening.shop === true && /quick|orders|piling|need/i.test(opening.text), 'the blacksmith in his workshop asks what she needs and hurries her', opening.text)
const away = new Conversation(smith, ctxAt(fire(smithTown))).opener()
check(away.shop === 'tired' && /workshop|smithy|forge/i.test(away.text), 'the blacksmith elsewhere is tired and tells her to come to his workshop', away.text)
const shopChips = new Conversation(smith, inShop(stubPack())).menu().map((c) => c.topic)
check(['shop:buy:sword', 'shop:buy:shield', 'shop:buy:pickaxe', 'shop:offer'].every((t) => shopChips.includes(t)), 'in his workshop her options are to buy each tool or ask what he has on offer', shopChips.join(' '))
check(!new Conversation(smith, ctxAt(fire(smithTown))).menu().some((c) => c.topic.startsWith('shop:')), 'away from his workshop the blacksmith offers no shop chips')
const offer = new Conversation(smith, inShop(stubPack())).say('shop:offer').text
check(/sword/.test(offer) && /shield/.test(offer) && /pickaxe/.test(offer) && /100 coins/.test(offer) && /3 bog iron/.test(offer) && /50 coins/.test(offer), 'asked what he has, he lists the sword, shield and pickaxe with their prices', offer)
check(trade.SHOP.sword.coin === 100 && trade.SHOP.sword['bog-iron'] === 3 && trade.SHOP.shield.coin === 100 && trade.SHOP.shield['bog-iron'] === 3 && trade.SHOP.pickaxe.coin === 50 && trade.SHOP.pickaxe['bog-iron'] === undefined, 'the shop prices are sword and shield 100 coins and 3 bog iron, pickaxe 50 coins')
for (const [item, have] of [['sword', { coin: 100, 'bog-iron': 3 }], ['shield', { coin: 100, 'bog-iron': 3 }], ['pickaxe', { coin: 50 }]]) {
  const pk = stubPack(have)
  const sold = new Conversation(smith, inShop(pk)).say(`shop:buy:${item}`)
  check(pk.count(item) === 1 && pk.count('coin') === 0 && pk.count('bog-iron') === 0 && sold.moment === 'trade.done', `buying a ${item} with the coins and iron it costs hands it over and takes the payment`, JSON.stringify(pk.n))
}
const lack = [['no coins', { 'bog-iron': 3 }, /coin/], ['too little iron', { coin: 100, 'bog-iron': 2 }, /iron/]]
for (const [what, have, word] of lack) {
  const pk = stubPack(have)
  const before = JSON.stringify(pk.n)
  const no = new Conversation(smith, inShop(pk)).say('shop:buy:sword')
  check(JSON.stringify(pk.n) === before && word.test(no.text) && no.moment === 'trade.short', `a sword sale with ${what} fails, says what is short and leaves the pack as it was`, no.text)
}
const full = stubPack({ coin: 50, lodestone: 12 }, 12)
const fullBefore = JSON.stringify(full.n)
const noRoom = new Conversation(smith, inShop(full)).say('shop:buy:pickaxe')
check(JSON.stringify(full.n) === fullBefore && /room|space|slot|full|pack|hands/i.test(noRoom.text), 'a pickaxe sale with every large slot held fails, says there is no room, and changes nothing', noRoom.text)
const tight = stubPack({ coin: 100, 'bog-iron': 3 }, 3)
const squeezed = new Conversation(smith, inShop(tight)).say('shop:buy:sword')
check(tight.count('sword') === 1 && squeezed.moment === 'trade.done', 'the iron paid frees its slots, so a full pack of exactly the iron still buys a sword', JSON.stringify(tight.n))
const elsewhere = stubPack({ coin: 100, 'bog-iron': 3 })
const elseBefore = JSON.stringify(elsewhere.n)
const refused = new Conversation(smith, ctxAt(fire(smithTown), { pack: elsewhere })).say('shop:buy:sword')
check(JSON.stringify(elsewhere.n) === elseBefore && /workshop|smithy|forge/i.test(refused.text), 'the blacksmith away from his workshop will not sell, even to someone who can pay', refused.text)

const gearAsker = as(humanTown.minds.find((m) => !trade.isSmith(m) && m.cls !== 'child'), STRAIGHT)
const gearChips = new Conversation(gearAsker, ctxAt(fire(humanTown))).menu().map((c) => c.topic)
check(gearChips.includes('where:gear'), 'townsfolk have a "where do I get weapons, armour and gear" option', gearChips.join(' '))
const smithsHome = world.towns.find((t) => world.titled(t, 'smith'))
const gearHere = as(smithsHome.minds.find((m) => !trade.isSmith(m) && m.cls !== 'child'), STRAIGHT)
const gear = new Conversation(gearHere, ctxAt(fire(smithsHome))).say('where:gear')
check(gear.text.includes(smith.name) && /workshop|smithy/i.test(gear.text) && /grump|surly|sour|short-tempered|ill-tempered|sharp/i.test(gear.text) && /blame/i.test(gear.text), 'asked about gear they name the blacksmith, warn he only talks shop in his workshop and is grumpy elsewhere, and do not blame him', gear.text)

const buyer = as(world.towns.flatMap((t) => t.minds).find((m) => m.body === 'innkeeper'), STRAIGHT)
const buyerTown = world.townOf(buyer)
const wantsCtx = (kind, have) => ctxAt(fire(buyerTown), { wants: kind, pack: stubPack(have) })
const traded = new Set([...trade.GEMS, ...trade.ORES, ...Object.keys(trade.SHOP), ...Object.values(trade.SHOP).flatMap((c) => Object.keys(c)), ...world.towns.flatMap((t) => t.minds).flatMap((m) => [...trade.buys(m), ...trade.deals(m, 'ruby').flatMap((d) => [...Object.keys(d.take), ...Object.keys(d.give)])])])
check([...traded].every((k) => PACKABLE.has(k)), 'every kind anyone buys, sells or prices is one her pack can hold', [...traded].filter((k) => !PACKABLE.has(k)).join(' '))
for (const body of ['blacksmith', 'thief', 'innkeeper', 'alchemist']) {
  const m = world.towns.flatMap((t) => t.minds).find((x) => x.kind === 'human' && x.body === body)
  if (m === undefined) continue
  const t = world.townOf(m)
  let threw = null
  try { new Conversation(as(m, STRAIGHT), ctxAt(fire(t), { inWorkshop: true, inShop: true, hour: 23 })).menu() } catch (e) { threw = e.message }
  check(threw === null, `talking to a ${body} at night in their shop builds the menu without throwing`, threw)
}
{
  const thief = as(thieves[0], STRAIGHT)
  const tc = new Conversation(thief, ctxAt(fire(world.townOf(thief)), { pack: stubPack({ coin: 999, ruby: 1 }) }))
  tc.say('trade:offer')
  const gems = []
  for (let i = 0; i < 12; i++) { gems.push(tc.menu().map((c) => c.topic).find((t) => t.startsWith('trade:take:stolen:'))); tc.say('nice:work') }
  const chip = gems[0]
  let threw = null
  try { tc.say(chip) } catch (e) { threw = e.message }
  check(chip !== undefined && new Set(gems).size === 1 && threw === null, "a thief's stolen gem stays the same gem all talk, and its chip can be pressed", `${[...new Set(gems)].join(' ')} ${threw ?? ''}`)
}
const tradeOpen = new Conversation(buyer, wantsCtx('ruby', { ruby: 2 })).opener()
check(tradeOpen.trade === true && /ruby/i.test(tradeOpen.text) && /interest|trade|offer|swap/i.test(tradeOpen.text), 'someone who wants what she holds says they are very interested and asks what she would trade', tradeOpen.text)
const tradeChips = new Conversation(buyer, wantsCtx('ruby', { ruby: 2 })).menu().map((c) => c.topic)
check(tradeChips.includes('trade:offer') && tradeChips.some((t) => t.startsWith('trade:take:')), 'her options are to ask what they have on offer or to name something she would take', tradeChips.join(' '))
const noWant = new Conversation(buyer, wantsCtx(null, {})).opener()
check(noWant.trade === undefined, 'someone who wants nothing she holds does not open with a trade')
const pk2 = stubPack({ ruby: 2 })
const sellCtx = ctxAt(fire(buyerTown), { wants: 'ruby', pack: pk2 })
const sc = new Conversation(buyer, sellCtx)
const sellTopic = sc.menu().map((c) => c.topic).find((t) => t === 'trade:take:sell:ruby')
const sold = sellTopic ? sc.say(sellTopic) : null
check(sold !== null && pk2.count('ruby') === 1 && pk2.count('coin') === trade.PRICE.ruby, 'selling a ruby pays the table price in coins', JSON.stringify(pk2.n))
const emptyHanded = stubPack({})
const noGoods = new Conversation(buyer, ctxAt(fire(buyerTown), { pack: emptyHanded })).say('trade:take:sell:ruby')
check(emptyHanded.count('coin') === 0 && noGoods.moment === 'trade.short', 'a trade she cannot cover gives nothing and says so', noGoods.text)
check(trade.buys(smith).every((k) => trade.ORES.includes(k)) && trade.buys(smith).length > 0, 'the blacksmith buys ores and nothing else')
check(trade.buys(leaf[0]).includes('coin') && trade.buys(leaf[0]).every((k) => trade.GEMS.includes(k) || k === 'coin'), 'leafkin take gems and coin, no ore')
const lkPack = stubPack({ jade: 1 })
const lkc = new Conversation(leaf[0], ctxAt({ x: 0, z: 0 }, { pack: lkPack, wants: 'jade' }))
check(/jade/i.test(lkc.opener().text) && lkc.opener().trade === true, 'a leafkin wanting her jade opens in pidgin about it', lkc.opener().text)
const lkDeal = lkc.menu().map((c) => c.topic).find((t) => t.startsWith('trade:take:'))
const lkSaid = lkDeal ? lkc.say(lkDeal) : null
check(lkSaid !== null && lkSaid.moment === 'trade.done' && lkPack.count('jade') === 0 && lkPack.count('bog-iron') + lkPack.count('lodestone') > 0, 'a leafkin trade swaps her jade for iron or lodestone', JSON.stringify(lkPack.n))

// Dragon-fighting deer, cave rabbit and fox hearsay.
const dw = new TalkWorld(SEED, towns)
const deerSame = new TalkWorld(SEED, towns).deer
check(JSON.stringify(dw.deer) === JSON.stringify(deerSame), 'the town of the dragon-fighting deer is the same for every client of one world')
const nearSite = { x: dw.towns[dw.towns.length - 1].town.x + 30, z: dw.towns[dw.towns.length - 1].town.z }
check(dw.seatDeer([nearSite]).town === dw.towns.length - 1, 'the deer town is the town nearest a roost')
const ownerMind = dw.person(dw.deer.owner)
check(ownerMind.town === dw.deer.town && ownerMind.cls !== 'child', 'the man who took the credit lives in the deer town and is grown')
const deerCtx = (mind) => ({ ...ctxAt(fire(dw.townOf(mind))), world: dw })
const heardFrom = (minds, topic) => minds.filter((m) => m.cls !== 'child').flatMap((m) => {
  const conv = new Conversation(as(m, STRAIGHT), deerCtx(m))
  return Array.from({ length: 6 }, () => conv.say(topic).text)
})
const awayMinds = dw.towns.filter((t) => t.index !== dw.deer.town).flatMap((t) => t.minds)
const away1 = heardFrom(awayMinds, 'lore:dragons').filter((t) => /fought off a dragon/i.test(t))
check(away1.length > 0, 'elsewhere they say someone in the deer town fought off a dragon', away1[0])
check(away1.every((t) => t.includes(dw.towns[dw.deer.town].name)), 'the hearsay names the deer town, so people point the way', away1[0])
check(away1.every((t) => !/pet deer/i.test(t)), 'outside the deer town nobody knows it was a deer')
const home1 = heardFrom(dw.towns[dw.deer.town].minds, 'lore:dragons').filter((t) => /deer/i.test(t))
const ownerName = dw.person(dw.deer.owner).name
check(home1.some((t) => t.includes(ownerName) && /enormous pet deer/i.test(t) && /feisty/i.test(t) && /credit/i.test(t)), 'in the deer town they say who took the credit, that it was his enormous pet deer, and that deer turn feisty if fed enough', home1[0])
const cavesAll = world.towns.flatMap((t) => t.minds).filter((m) => m.cls !== 'child').slice(0, 60).flatMap((m) => { const c = new Conversation(as(m, STRAIGHT), ctxAt(fire(world.townOf(m)))); return Array.from({ length: 10 }, () => c.say('lore:caves').text) })
check(cavesAll.some((t) => /rabbit/i.test(t) && /(lost|child)/i.test(t)), 'someone tells of getting lost in a cave as a child and being led out by a pet rabbit', cavesAll.find((t) => /rabbit/i.test(t)))
check(cavesAll.some((t) => /fox/i.test(t) && /smell gems/i.test(t)), 'someone tells of a fox that could smell gems in the caves', cavesAll.find((t) => /fox/i.test(t)))

// Furious leafkin of a glade she wronged.
const fl = leaf[0]
const furyCtx = (witness) => ctxAt({ x: 0, z: 0 }, { wronged: true, witness })
const furious = new Chat(fl, furyCtx(null), { trusted: true, salt: 1 }).open()
check(furious.mood === 'angry' && /hob|bad|keesh|frog/i.test(furious.text), 'a leafkin of a wronged glade greets her furious about the hob', furious.text)
const wit = new Chat(fl, furyCtx(fl.id), { trusted: true, salt: 1 }).open()
check(wit.mood === 'angry' && (wit.fury ?? 0) > (furious.fury ?? 0), 'the leafkin who witnessed it is angrier than the rest', `${wit.fury} vs ${furious.fury}: ${wit.text}`)
check(LK.scold.length >= 6 && LK.scold.every((l) => /hob|frog|bad/i.test(l)), 'the scolding a leafkin shouts following her is six or more pidgin lines about the hob')
const calm = new Chat(fl, ctxAt({ x: 0, z: 0 }), { trusted: true, salt: 1 }).open()
check(calm.mood !== 'angry', 'a leafkin of a glade she has not wronged is not furious', calm.text)

}

// --- Alchemist's shop, armed talk, and who knows what (design/42-valuables.md "Flows"; src/v2/talk/armed.js) ---
const alchTown = world.towns.find((t) => t.minds.some(trade.isAlchemist))
const alch = as(alchTown.minds.find(trade.isAlchemist), STRAIGHT)
const inPotions = (pack, more = {}) => ctxAt(fire(alchTown), { inShop: true, pack, ...more })
const alchOpen = new Conversation(alch, inPotions(stubPack())).opener()
check(alchOpen.shop === true && /\?/.test(alchOpen.text), 'the alchemist in his shop welcomes her and asks what she needs', alchOpen.text)
const alchChips = new Conversation(alch, inPotions(stubPack())).menu().map((c) => c.topic)
check(alchChips.includes('shop:buy:flare-charges') && alchChips.includes('shop:offer'), 'in his shop she may buy flare charges or ask what he has', alchChips.join(' '))
check(!new Conversation(alch, ctxAt(fire(alchTown))).menu().some((c) => c.topic.startsWith('shop:')), 'out of his shop the alchemist offers no shop chips')
check(trade.SHOP['flare-charges'].coin === 40 && trade.SHOP['flare-charges'].firestone === 1, 'flare charges cost 40 coins and a firestone')
const alchOffer = new Conversation(alch, inPotions(stubPack())).say('shop:offer').text
check(/flare charges/.test(alchOffer) && /40 coins/.test(alchOffer) && /firestone/.test(alchOffer), 'asked what he has, the alchemist lists the flare charges and their price', alchOffer)
const jar = stubPack({ coin: 40, firestone: 1 })
const jarSold = new Conversation(alch, inPotions(jar)).say('shop:buy:flare-charges')
check(jar.count('flare-charges') === 1 && jar.count('coin') === 0 && jar.count('firestone') === 0 && jarSold.moment === 'trade.done' && jarSold.sold.item === 'flare-charges', 'with 40 coins and a firestone she buys a jar of flare charges and pays for it', JSON.stringify(jar.n))
for (const [what, have, word] of [['no coins', { firestone: 1 }, /coin/], ['no firestone', { coin: 40 }, /firestone/]]) {
  const pk = stubPack(have), before = JSON.stringify(pk.n)
  const no = new Conversation(alch, inPotions(pk)).say('shop:buy:flare-charges')
  check(JSON.stringify(pk.n) === before && word.test(no.text) && no.moment === 'trade.short', `a flare-charge sale with ${what} fails, names what she lacks and changes nothing`, no.text)
}
const jarTight = stubPack({ coin: 40, firestone: 1, lodestone: 11 }, 12)
const jarSqueezed = new Conversation(alch, inPotions(jarTight)).say('shop:buy:flare-charges')
check(jarTight.count('flare-charges') === 1 && jarSqueezed.moment === 'trade.done', 'the firestone paid frees its slot, so a full pack still buys the jar', JSON.stringify(jarTight.n))
const jarFull = stubPack({ coin: 40, firestone: 2, lodestone: 10 }, 12)
const jarFullBefore = JSON.stringify(jarFull.n)
const jarFullSay = new Conversation(alch, inPotions(jarFull)).say('shop:buy:flare-charges')
check(jarFull.count('flare-charges') === 1 && jarFullSay.moment === 'trade.done', 'with the firestone paid freeing a slot the jar fits', jarFullBefore)
const awayPack = stubPack({ coin: 40, firestone: 1 }), awayBefore = JSON.stringify(awayPack.n)
const alchAway = new Conversation(alch, ctxAt(fire(alchTown), { pack: awayPack, hour: 12 })).opener()
const alchAwayBuy = new Conversation(alch, ctxAt(fire(alchTown), { pack: awayPack, hour: 12 })).say('shop:buy:flare-charges')
check(alchAway.shop === 'away' && /shop/i.test(alchAway.text) && /shop/i.test(alchAwayBuy.text) && JSON.stringify(awayPack.n) === awayBefore, 'the alchemist out of his shop by day says to come to the shop and will not sell', alchAway.text)
const alchLate = new Conversation(alch, ctxAt(fire(alchTown), { hour: 2 })).opener()
check(alchLate.shop === 'late' && alchLate.moment === 'greet.evening' && /shut till morning|opens in the morning|in the morning/i.test(alchLate.text) && !/sleep|yawn/i.test(alchLate.text), 'met in the street at night, the alchemist says the shop opens in the morning, not that they are asleep', alchLate.text)
const notKeeper = as(alchTown.minds.find((m) => m.kind === 'human' && !trade.isAlchemist(m) && !trade.isSmith(m)), STRAIGHT)
let keeperThrew = false
try { new Conversation(notKeeper, inPotions(stubPack())).say('shop:buy:flare-charges') } catch { keeperThrew = true }
check(keeperThrew, 'a flare-charge purchase from someone who keeps no shop throws')

const guardMind = world.towns.flatMap((t) => t.minds).find((m) => m.cls === 'guard')
const folkMind = world.towns.flatMap((t) => t.minds).find((m) => m.kind === 'human' && m.cls !== 'guard' && m.cls !== 'child')
const throws = (f) => { try { f(); return false } catch { return true } }
check(throws(() => jeer(guardMind, 0.3)) && throws(() => swordWarning(folkMind, 0.3)) && throws(() => jeer(folkMind)) && throws(() => swordWarning(guardMind)), 'jeer is not for guards, swordWarning is only for guards, and both need a roll')
const hmns = world.towns.flatMap((t) => t.minds).filter((m) => m.kind === 'human' && m.cls !== 'guard')
const wardens = world.towns.flatMap((t) => t.minds).filter((m) => m.cls === 'guard')
const rolls = [0, 0.13, 0.27, 0.41, 0.55, 0.69, 0.83, 0.97]
const jeers = new Set(hmns.flatMap((m) => rolls.map((r) => jeer(m, r).text)))
const warns = new Set(wardens.flatMap((m) => rolls.map((r) => swordWarning(m, r).text)))
check(jeers.size >= 15 && [...jeers].some((t) => /uncouth/i.test(t)) && hmns.every((m) => rolls.every((r) => jeer(m, r).moment === 'social.disagree')), 'passers-by jeer in many wordings, some calling her uncouth', `${jeers.size} wordings`)
check(warns.size >= 6 && wardens.every((m) => rolls.every((r) => swordWarning(m, r).moment === 'refuse.wary' && /away|sheathe|put it|stays|stop|no blades/i.test(swordWarning(m, r).text))), 'guards warn her to put the sword away, in several wordings', `${warns.size} wordings`)
check(new Set(hmns.map((m) => jeer(m, 0.9).text)).size > 1 && new Set(hmns.map((m) => jeer(m, 0.9).text)).size >= 3, 'jeers vary with the speaker\'s temperament and trade')
const armedCtx = (m, more = {}) => ctxAt(fire(world.townOf(m)), { armed: true, ...more })
const armedAll = world.towns.flatMap((t) => t.minds).filter((m) => m.kind === 'human')
let armedBad = ''
for (const m of armedAll) {
  const chat = new Chat(m, armedCtx(m), { trusted: true, salt: 1 })
  const o = chat.open()
  const menu = chat.menu()
  if (!(!o.ended && o.moment === 'refuse.wary' && /uncouth|rude|manners|bad people|sword/i.test(o.text) && o.text.split(/(?<=[.!?])\s+/).length >= 2)) armedBad = `${m.id}: ${o.text}`
  else if (menu.length !== 1 || menu[0] !== NEXT) armedBad = `${m.id} menu ${menu.map((c) => c.topic).join(' ')}`
  else {
    const off = chat.ask(NEXT.topic)
    if (!off.ended || off.moment !== 'bye.curt' || o.text.includes(off.text)) armedBad = `${m.id}: ${o.text} -> ${off.text}`
  }
  if (armedBad) break
}
check(armedBad === '', 'armed in town, anyone she hails calls her uncouth and tells her off, offers only the arrow, and ends it on the page after', armedBad)
const armedLines = new Set(armedAll.map((m) => new Chat(m, armedCtx(m), { trusted: true, salt: 2 }).open().text))
check(armedLines.size >= 12, 'armed-in-town refusals vary by person', `${armedLines.size} wordings`)
const armedConv = new Conversation(armedAll[0], armedCtx(armedAll[0]))
const armedA = armedConv.refuseArmed().said.text, armedB = armedConv.refuseArmed().said.text
check(armedA !== armedB, 'the same person does not refuse twice in the same words')
const unarmed = new Chat(armedAll[0], ctxAt(fire(world.townOf(armedAll[0]))), { trusted: true, salt: 1 }).open()
check(!/uncouth/i.test(unarmed.text), 'unarmed she is greeted normally')

// Every topic has a knower in every town, and a non-knower points to one by calling.
const uncovered = world.towns.flatMap((t) => Object.keys(TOPICS).filter((k) => !t.minds.some((m) => m.kind === 'human' && expertise(m.body, k) > 0)).map((k) => `${t.name}:${k}`))
check(uncovered.length === 0, 'every topic has someone who knows it in every town', uncovered.slice(0, 8).join(', '))
const unreferred = Object.keys(TOPICS).filter((k) => expertBody(k) === null)
check(unreferred.length === 0, 'every topic has a body that knows it best, so a non-knower can name a calling', unreferred.join(', '))
let blind = ''
for (const k of Object.keys(TOPICS)) for (const t of world.towns) {
  const non = t.minds.find((m) => m.kind === 'human' && m.cls !== 'child' && expertise(m.body, k) === 0)
  if (non === undefined) continue
  const l = whoOf(non, k, FRIENDLY, [k]).l
  if (!/(Ask|Try) \w+|would know|looking at one|would be me|tall tales|no \w+/i.test(l.text)) blind = `${t.name} ${non.body} ${k}: ${l.text}`
}
check(blind === '', 'a friendly non-knower asked who knows any topic names a person or calling, or scoffs at a tall tale', blind)
const giantsTales = [...LORE.spiders, ...LORE.giants].map((x) => [x.truth, ...x.tales, ...x.lies].join(' ')).join(' ')
check(LORE.giants.some((x) => /afraid of spiders/i.test(x.truth)) && LORE.giants.some((x) => /tailor/i.test(x.truth) && x.tales.length > 0) && LORE.spiders.some((x) => /bigger things/i.test(x.truth) && x.unlocks.includes('giants')), 'there is lore that green giants fear spiders: an old tale, a fairytale, and a hint in the spiders lore that leads to giants', giantsTales.slice(0, 60))
const flareLore = [...LORE.flares, ...LORE.caves, ...LORE.labyrinths].map((x) => x.truth).join(' ')
check(/ground|wall/i.test(LORE.flares.map((x) => x.truth).join(' ')) && /flare/i.test(LORE.caves.concat(LORE.labyrinths).map((x) => x.truth).join(' ')) && /glow/i.test(flareLore), 'there is lore that a flare shot at the ground or a wall keeps glowing and so marks the way in caves and labyrinths')

// --- quirks (src/v2/talk/quirks.js) ---
const people = all.filter((m) => m.kind === 'human')
const kinds = new Set(people.map((m) => m.quirk.kind))
check(['bitter', 'timid', 'adoring', 'need'].every((k) => kinds.has(k)), 'every townsperson has a quirk, and all four kinds walk the towns', [...kinds].join(', '))
const meanKind = (k) => { const g = people.filter((m) => m.quirk.kind === k); return g.reduce((s, m) => s + m.traits.kindness, 0) / g.length }
check(meanKind('bitter') < meanKind('adoring'), 'the bitter run less kind than the adoring', `${meanKind('bitter').toFixed(2)} vs ${meanKind('adoring').toFixed(2)}`)
const childNeeds = new Set(people.filter((m) => m.cls === 'child' && m.quirk.kind === 'need').map((m) => m.quirk.need)), adultNeeds = new Set(people.filter((m) => m.cls !== 'child' && m.quirk.kind === 'need').map((m) => m.quirk.need))
check([...childNeeds].every((n) => !adultNeeds.has(n)), 'no child pines for a grown-up\'s need, nor a grown-up for a child\'s', `${[...childNeeds]} / ${[...adultNeeds]}`)
const topical = allQuirkLines().flatMap((l) => Object.entries(NAMES).filter(([, re]) => re.test(l)).map(([k]) => `${k}: ${l}`))
check(topical.length === 0, 'no quirk line names a lore topic', topical[0])
const quirkCtx = (m) => { const ctx = ctxAt(fire(world.townOf(m))); ctx.rapport.warm(m.id, 0.5); return ctx }
const parents = new Set([...quests.values()].map((q) => q.parent).filter((id) => id !== undefined))
const selves = people.filter((m) => !parents.has(m.id) && !new Conversation(m, quirkCtx(m)).say('talk:self', true).text.includes(quirkLines(m.quirk).self))
check(selves.length === 0, 'asked about themself by a friend, everyone owns up to their quirk but a parent whose child is missing', selves.map((m) => m.name).join(', '))
const selfFret = people.filter((m) => parents.has(m.id) && new Conversation(m, quirkCtx(m)).say('talk:self', true).text.includes(quirkLines(m.quirk).self))
check(parents.size > 0 && selfFret.length === 0, 'telling of themself, a parent whose child is missing leaves their quirk out', selfFret.map((m) => m.name).join(', '))
const needy = people.filter((m) => m.quirk.kind === 'need' && new Conversation(m, quirkCtx(m)).wish() === null)
const wanting = needy.filter((m) => { const l = new Conversation(m, quirkCtx(m)).say('talk:needs', true); return l.quest === undefined && l.text !== quirkLines(m.quirk).want })
check(needy.length > 0 && wanting.length === 0, 'asked what they need, one with a need and no errand or wish of their own names it', `${needy.length} needy, ${wanting.length} who did not say`)
const gnomer = people.find((m) => m.quirk.need === 'gnome') ?? people.find((m) => m.quirk.kind === 'need')
const gconv = new Conversation(gnomer, quirkCtx(gnomer)), gasides = quirkLines(gnomer.quirk).aside
const told = []
for (let i = 0; i < 40; i++) { const t = gconv.say(['talk:town', 'nice:work', 'nice:life'][i % 3]).text; const a = gasides.find((x) => t.includes(x)); if (a !== undefined) told.push(gasides.indexOf(a)) }
check(told.length >= 6 && told.length <= 24 && told.every((x, i) => x === i % gasides.length), 'a need keeps filtering into small talk now and then, its story told in order', `${gnomer.name} (${gnomer.quirk.need}): ${told.join(' ')}`)
const moody = people.filter((m) => m.quirk.kind !== 'need').slice(0, 40)
const greeted = moody.filter((m) => { const l = quirkLines(m.quirk); return [0, 1, 2, 3, 4, 5].some((salt) => l.greet.some((g) => new Conversation(m, quirkCtx(m), salt).opener().text.includes(g))) })
check(greeted.length > moody.length * 0.7, 'greetings often carry the quirk', `${greeted.length} of ${moody.length}`)
const worriedTalk = new Conversation(parent, quirkCtx(parent)), parentLines = quirkLines(parent.quirk)
const fretful = Array.from({ length: 12 }, () => worriedTalk.say('talk:town').text).filter((t) => parentLines.aside.some((x) => t.includes(x)))
check(fretful.length === 0, 'a parent whose child is missing has no room for their quirk', fretful[0])
const leafQuirk = new Conversation(leaf[0], ctxAt({ x: 0, z: 0 }))
check(leaf.every((m) => m.quirk === undefined) && !allQuirkLines().some((l) => [0, 1, 2, 3].map(() => leafQuirk.say('talk:self').text).join(' ').includes(l)), 'leafkin have no quirk')

// --- the caption (src/v2/talk/caption.js): no line past its rows ---
const longestTown = world.towns.map((t) => t.name).sort((a, b) => b.length - a.length)[0]
const longestName = all.map((m) => m.name).sort((a, b) => b.length - a.length)[0]
const fill = (s) => s.replaceAll('{town}', longestTown).replaceAll('{owner}', longestName)
// A lore line at its longest: hedged, or boasted (a lead-in is added only when it fits, speak.js `_dress`).
const loreWorst = Object.entries(LORE).flatMap(([t, fs]) => fs.flatMap((x) => [x.truth, ...x.lies, ...x.tales, ...x.doubt, ...(x.seen ? [x.seen] : [])].map((s) => [`${t}.${x.id}`, fill(s)])))
  .flatMap(([k, s]) => [[k, `${s} If I remember right.`], [k, `Everyone knows this. ${s}`]])
const lkWorst = [...Object.entries(LORE).flatMap(([t, fs]) => fs.flatMap((x) => (x.lk ?? []).map((s) => [`${t}.${x.id} lk`, s]))), ...Object.entries(LK).flatMap(([k, v]) => (Array.isArray(v) ? v : []).map((s) => [`LK.${k}`, s]))]
const longStatic = [...loreWorst, ...lkWorst, ...allQuirkLines().map((s) => ['quirk', s])].filter(([, s]) => captionRows(s) > CAPTION.rows)
check(longStatic.length === 0, `every lore, leafkin and quirk line fits the caption's ${CAPTION.rows} rows at its longest`, longStatic.slice(0, 40).map(([k, s]) => `${k}: ${s}`).join(' || '))
const walked = { lines: 0, long: [], odd: [], again: [], crow: [], home: [], refer: [] }
for (const seed of [1, 2, 3]) walkTalks(world, seed, 500, (mind, who, topic, line) => {
  walked.lines++
  const at = `${who} [${topic}] ${line.moment}: ${line.text}`
  if (captionRows(line.text) > CAPTION.rows) walked.long.push(`${who} [${topic}] ${line.text}`)
  if (!/^[\x20-\x7e]*$/.test(line.text)) walked.odd.push(`${who} [${topic}] ${line.text}`)
  if (mind.kind === 'leafkin') return
  if (/Like I said|Same as before|As I told you/.test(line.text) !== (line.moment === 'answer.again')) walked.again.push(at)
  if (/Easy\. |Everyone knows this|Or no, wait/.test(line.text) && ['answer.nervous', 'answer.sure', 'answer.again'].includes(line.moment)) walked.crow.push(at)
  if (mind.cls === 'travel' && ['talk.home', 'talk.town'].includes(line.moment)) walked.home.push(at)
  if (/^who:/.test(topic) && /\bAsk [A-Z]/.test(line.text) && line.moment !== 'answer.refer') walked.refer.push(at)
})
check(walked.long.length === 0, `in 1500 random conversations no line runs past the caption's ${CAPTION.rows} rows`, `${walked.long.length} of ${walked.lines}: ${walked.long[0]}`)
check(walked.odd.length === 0, 'and every line is plain ASCII, the alphabet the caption is measured in', walked.odd[0])
check(walked.again.length === 0, 'the "like I said" clip plays exactly when the words repeat themselves', walked.again.slice(0, 3).join(' || '))
check(walked.crow.length === 0, 'a crow or a second thought in the words is never voiced as plain, nervous or a repeat', walked.crow.slice(0, 3).join(' || '))
check(walked.home.length === 0, 'a traveller never voices the town as their home', walked.home.slice(0, 3).join(' || '))
check(walked.refer.length === 0, 'sending her on to someone else is voiced as a referral', walked.refer.slice(0, 3).join(' || '))

// Castle folk: every line fits, every sentence answers in a recorded moment, most press the summit's view, and the summit guard tells of the ghost.
{
  const moments = JSON.parse(readFileSync('public/sounds/voice/moments.json', 'utf8')).human
  const long = allCastleLines().filter((t) => captionRows(t) > CAPTION.rows)
  const YAW = 0.7, wardsAt = (open, total, mask = (1 << open) - 1) => ({ open, total, mask })
  const nearTowns = (lay) => world.towns.slice(0, 3).map((t) => ({ name: t.name, x: t.town.x, z: t.town.z }))
  // The ways ctx for castle `lay` and the folk `who`: where that kind of person stands in it.
  const waysFor = (lay, who) => {
    const spec = [...insideCast(lay), ...outsideCast(lay, { yaw: YAW }, null)].find((q) => q.who === who) ?? { who: 'yard' }
    return { lay, yaw: YAW, at: standing(lay, spec), name: 'the old castle', x: 0, z: 0, towns: nearTowns(lay) }
  }
  check(long.length === 0, `no castle line runs past the caption's ${CAPTION.rows} rows`, `${long.length}: ${long[0]}`)
  const unvoiced = [], urged = new Set(), ghosts = []
  for (const who of ['lord', 'steward', 'cook', 'maid', 'servant', 'guard', 'watch', 'gate', 'yard', 'traveller', 'lore']) for (let salt = 0; salt < 40; salt++) {
    const id = `castle:1:${who}:${salt}`
    const chat = new CastleChat({ id, name: who, who, castle: 1, ...castleTemper(who, id) }, { rooms: 17, wards: [wardsAt(0, 6), wardsAt(2, 6), wardsAt(4, 6), wardsAt(6, 6)][salt % 4], ways: waysFor(castleLayout(1), who) }, { approached: salt % 4 === 0, salt })
    const lines = [chat.open()]
    for (const { topic } of chat.menu()) if (!chat.ended) lines.push(chat.ask(chat.parting === null ? topic : NEXT.topic))
    for (const l of lines) {
      if (moments[l.moment] === undefined) unvoiced.push(`${who}: ${l.moment}`)
      if (captionRows(l.text) > CAPTION.rows) unvoiced.push(`${who} too long: ${l.text}`)
      if (VIEW.some((v) => l.text.includes(v))) urged.add(who)
      if (who === 'lore' && l.text.includes('forlorn ghost')) ghosts.push(l.text)
    }
  }
  const said = (wards, who, salt) => {
    const id = `castle:2:${who}:${salt}`
    const chat = new CastleChat({ id, name: who, who, castle: 2, ...castleTemper(who, id) }, { rooms: 17, wards: wardsAt(wards.open, wards.total), ways: waysFor(castleLayout(2), who) }, { approached: salt % 4 === 0, salt })
    const lines = [chat.open()]
    for (const { topic } of chat.menu()) if (!chat.ended) lines.push(chat.ask(chat.parting === null ? topic : NEXT.topic))
    if (!chat.ended) lines.push(chat.ask('bye'))
    return lines
  }
  const tiersOf = { shut: { open: 0, total: 7 }, some: { open: 2, total: 7 }, most: { open: 4, total: 7 }, all: { open: 7, total: 7 } }
  const owner = new Map()
  for (const [tier, lists] of Object.entries(WARD_TALK)) for (const t of Object.values(lists).flat()) owner.set(t, [...(owner.get(t) ?? []), tier])
  const heard = { shut: [], some: [], most: [], all: [] }, stray = []
  for (const tier of Object.keys(tiersOf)) for (const who of ['lord', 'maid', 'guard', 'lore']) for (let salt = 0; salt < 40; salt++) for (const l of said(tiersOf[tier], who, salt)) {
    const o = owner.get(l.text)
    if (o === undefined) continue
    if (!o.includes(tier)) stray.push(`${tier}: ${l.text}`)
    else heard[tier].push(l.text)
  }
  check(Object.entries(tiersOf).every(([t, w]) => wardTier(w.open, w.total) === t) && wardTier(3, 7) === 'some' && wardTier(4, 8) === 'most' && wardTier(7, 8) === 'most' && wardTier(1, 8) === 'some', 'wardTier is shut at none open, some under half, most from half up to all but one, all when every ward is open', '')
  check(Object.values(heard).every((h) => h.length > 0) && stray.length === 0, 'castle folk speak the lines of the tier their opened wards earn, and never another tier\'s', `${Object.entries(heard).map(([t, h]) => `${t} ${h.length}`).join(', ')}; stray ${stray[0]}`)
  check([...owner.values()].every((o) => o.length === 1), 'no ward line is shared between two tiers', [...owner].find(([, o]) => o.length > 1)?.[0])
  check(WARD_TALK.shut.castle.some((t) => /grateful/.test(t)) && WARD_TALK.shut.castle.some((t) => /careful|mind yourself|take care/i.test(t)) && heard.shut.some((t) => /trapped|stuck|locked/.test(t)), 'while every ward is shut the folk are distressed, warn her of being trapped and promise gratitude', '')
  check(WARD_TALK.some.greet.every((t) => /thank|bless/i.test(t)) && WARD_TALK.most.greet.every((t) => /thank|bless/i.test(t)) && WARD_TALK.all.greet.every((t) => /thank|debt|saved|saviour|did it/i.test(t)) && !Object.values(WARD_TALK.all).flat().some((t) => /trapped in the walls too|unknot this|take care/.test(t)), 'once wards are open the folk are thankful, and once all are open jubilant with nothing left to fear', '')
  check(['some', 'most', 'all'].every((t) => WARD_TALK[t].bye.length > 0) && WARD_TALK.shut.bye.length === 0, 'folk say a warm goodbye once any ward is open and none while all are shut', '')
  check(Object.values(WARD_TALK).flatMap((l) => Object.values(l).flat()).every((t) => captionRows(t) <= CAPTION.rows && !t.includes('\u2014')), 'every ward line fits the caption', '')
  const lay = castleLayout(1)
  check(maidSays(lay, false, true, 'shut').includes('locked down') && maidSays(lay, false, true, 'shut').includes('dungeons') && !maidSays(lay, false, true, 'all').includes('locked down') && /owe it all/.test(maidSays(lay, false, true, 'all')) && /Nearly the whole keep/.test(maidSays(lay, false, true, 'most')) && /Some of the wards/.test(maidSays(lay, false, true, 'some')), 'the kitchen maid tells of the keep by how many wards are open, and still tells her tale', '')
  let threw = false
  try { new CastleChat({ id: 'castle:3:lord:0', name: 'x', who: 'lord', castle: 3, ...castleTemper('lord', 'castle:3:lord:0') }, { rooms: 17, ways: waysFor(castleLayout(3), 'lord') }) } catch { threw = true }
  check(threw, 'a castle chat built without its wards fails explicitly', '')
  threw = false
  try { new CastleChat({ id: 'castle:3:lord:0', name: 'x', who: 'lord', castle: 3, ...castleTemper('lord', 'castle:3:lord:0') }, { rooms: 17, wards: wardsAt(1, 5) }) } catch { threw = true }
  check(threw, 'a castle chat built without its ways fails explicitly', '')
  threw = false
  try { new CastleChat({ id: 'castle:3:lord:0', name: 'x', who: 'lord', castle: 3, ...castleTemper('lord', 'castle:3:lord:0') }, { rooms: 17, wards: { open: 1, total: 5 }, ways: waysFor(castleLayout(3), 'lord') }) } catch { threw = true }
  check(threw, 'a castle chat whose wards carry no open mask fails explicitly', '')
  threw = false

  // Ways: where am I, and the way to a room, grounded in the real layout.
  const sure = (id, ways, wards, salt = 0, accuracy = 1) => {
    const mind = { id, name: 'x', who: 'guard', castle: 1, ...castleTemper('guard', id) }
    mind.traits.accuracy = accuracy
    mind.mood = 'plain'
    return new CastleChat(mind, { rooms: 17, wards, ways }, { salt })
  }
  const SEED_WAY = 215679, wl = castleLayout(SEED_WAY), wplan = roomPlan(wl)
  const hallRoom = wplan.chambers.find((c) => c.role === 'hall'), throneRoom = wplan.chambers.find((c) => c.role === 'throne')
  const inHall = { lay: wl, yaw: YAW, at: { node: hallRoom.node, chamber: hallRoom }, name: 'the old castle', x: 0, z: 0, towns: nearTowns(wl) }
  const open = wardsAt(wl.wards.length, wl.wards.length)
  const menuTopics = sure('castle:1:guard:1', inHall, open).menu().map((c) => c.topic)
  check(['where:here', 'way:throne', 'way:hall', 'way:chapel', 'way:library', 'way:bedchamber', 'way:dungeon', 'way:summit', 'way:court', 'way:gate', 'way:town:0', 'way:town:1', 'way:town:2'].filter((t) => !t.startsWith('way:chapel') && !t.startsWith('way:library') && !t.startsWith('way:bedchamber') || places(wl).some((p) => t === `way:${p.id}`)).every((t) => menuTopics.includes(t)) && menuTopics.at(-1) === 'bye', 'the castle menu offers where-am-I and a way to each room, door and nearby town the castle has, before goodbye', menuTopics.join(' '))
  const hereSaid = sure('castle:1:guard:1', inHall, open).ask('where:here').text
  check(hereSaid.includes('the hall and kitchen') && hereSaid.includes('the ground floor') && hereSaid.includes(nearTowns(wl)[0].name), `asked where she is in castle ${SEED_WAY}'s hall, an exact guard names the hall, its floor and the nearest town`, hereSaid)
  const inThrone = { ...inHall, at: { node: throneRoom.node, chamber: throneRoom } }
  const thereSaid = sure('castle:1:guard:1', inThrone, open).ask('where:here').text
  check(thereSaid.includes('the throne room') && thereSaid.includes(throneRoom.k === 0 ? 'the ground floor' : hereName(wl, YAW, inThrone.at).split(', ')[1]), `and in the throne room, on the throne room's own storey`, thereSaid)
  const path = route(wl, hallRoom.node, new Set([throneRoom.node]), shutEdges(wl, open.mask)), spoken = steps(YAW, path)
  const way = sure('castle:1:guard:1', inHall, open).ask('way:throne').text
  const net = spoken.reduce((n, s) => n + s.floors, 0)
  check(way.startsWith('The throne room? Go ') && way.includes(spoken[0].text) && net === throneRoom.node.k - hallRoom.node.k && /\b(up|down) (one|two|three|four) floors?\b/.test(way), `from castle ${SEED_WAY}'s hall an exact guard names the throne room and gives its real first step and storey change`, `${way} | route ${spoken.map((s) => s.text).join(' | ')}`)
  const muddled = sure('castle:1:guard:2', inHall, open, 0, 0.1).ask('way:throne').text
  const unknown = Array.from({ length: 60 }, (_, salt) => sure('castle:1:guard:2', inHall, open, salt, 0).ask('way:throne').text).find((t) => !t.includes('Go '))
  check(unknown !== undefined && unknown.startsWith('The throne room? '), 'a guard who knows nothing of the way says so instead of inventing a route', unknown)
  check(muddled.startsWith('The throne room? ') && (muddled.includes('Go ') ? muddled.includes(spoken[0].text) : true), 'a muddled guard still starts with the real first step, never a made-up one', muddled)
  const townSaid = sure('castle:1:guard:1', inHall, open).ask('way:town:0').text, t0 = nearTowns(wl)[0]
  check(townSaid.startsWith(`${t0.name}? Go `) && townSaid.includes('out through the gate') && townSaid.includes(`Then it is ${townWay(inHall, t0)}.`), 'the way to a town leads out through the gate, then gives that town\'s real bearing and distance from the castle', townSaid)
  let shutCase = null
  for (let seed = 1; seed <= 200 && shutCase === null; seed++) {
    const l = castleLayout(seed), cut = shutEdges(l, 0), pl = places(l), start = l.nodes.find((n) => n.kind === 'court')
    if (l.wards === null) continue
    const p = pl.find((q) => route(l, start, q.goals, new Set()) !== null && route(l, start, q.goals, cut) === null)
    if (p !== undefined) shutCase = { l, p }
  }
  check(shutCase !== null, 'some castle has a room a shut ward cuts off from the court', '')
  if (shutCase !== null) {
    const { l, p } = shutCase, court = l.nodes.find((n) => n.kind === 'court')
    const ctx = { lay: l, yaw: YAW, at: { node: court, chamber: null }, name: 'the old castle', x: 0, z: 0, towns: nearTowns(l) }
    const blocked = sure('castle:1:guard:3', ctx, wardsAt(0, l.wards.length, 0)).ask(`way:${p.id}`).text
    const cleared = sure('castle:1:guard:3', ctx, wardsAt(l.wards.length, l.wards.length)).ask(`way:${p.id}`).text
    check(/ward/i.test(blocked) && blocked.includes('Break it first') && !blocked.includes('Go ') && cleared.includes('Go '), `with the wards shut, the way to ${p.label} in castle ${l.seed} is blocked by a ward; with them open it is a route`, `${blocked} || ${cleared}`)
  }
  const unfit = [], plain = []
  for (let seed = 1; seed <= 60; seed++) for (const who of ['lord', 'steward', 'cook', 'maid', 'servant', 'guard', 'watch', 'gate', 'yard', 'traveller', 'lore']) {
    const l = castleLayout(seed), ways = waysFor(l, who)
    if (l.wards === null) continue
    for (const acc of [0.05, 0.6, 1]) {
      const fresh = () => sure(`castle:${seed}:${who}:${acc}`, ways, wardsAt(seed % 2 ? 0 : l.wards.length, l.wards.length), seed, acc)
      for (const { topic } of fresh().menu()) {
        if (!topic.startsWith('way:') && topic !== 'where:here') continue
        const t = fresh().ask(topic).text
        if (captionRows(t) > CAPTION.rows) unfit.push(`${seed} ${who} ${topic}: ${t}`)
        if (/undefined|NaN|—/.test(t)) plain.push(`${seed} ${who} ${topic}: ${t}`)
      }
    }
  }
  check(unfit.length === 0, 'in 60 castles every folk\'s where-am-I and way answer fits the caption', `${unfit.length}: ${unfit[0]}`)
  check(plain.length === 0, 'and none says "undefined", "NaN" or an em dash', plain[0])
  try { wardTier(8, 7) } catch { threw = true }
  check(threw, 'more wards open than there are fails explicitly', '')

  // Gifts: who gives what, once.
  const roles = ['lord', 'steward', 'cook', 'maid', 'servant', 'servant', 'servant', 'guard']
  const badKind = [], overMax = [], dup = []
  for (let seed = 1; seed <= 200; seed++) {
    const gifts = planGifts(roles, seed)
    if (gifts.length > GIFT.max) overMax.push(seed)
    if (new Set(gifts.map((g) => g.bit)).size !== gifts.length || new Set(gifts.map((g) => g.person)).size !== gifts.length) dup.push(seed)
    for (const g of gifts) if (!GIFT_KINDS[roles[g.person]].includes(g.kind) || !ITEMS[g.kind] || g.bit < GIFT.bit || g.bit >= GIFT.bit + GIFT.max) badKind.push(`${roles[g.person]} ${g.kind} bit ${g.bit}`)
  }
  check(badKind.length === 0, 'each giver holds out a kind their role gives, that the game has as an item, on a reserved gift bit', badKind[0])
  check(overMax.length === 0 && planGifts(roles, 1).length === 3 && GIFT.max === 3, 'a castle has at most 3 gifts, and 3 when it has the folk for them', overMax.join(' '))
  check(dup.length === 0, 'no giver and no ledger bit is used twice in one castle', dup.join(' '))
  const kindsFor = (who) => new Set(Array.from({ length: 200 }, (_, seed) => planGifts([who], seed)[0].kind))
  check(['sword', 'shield', 'knife'].every((k) => kindsFor('guard').has(k)) && [...kindsFor('lord')].every((k) => ['coin', 'diamond', 'sapphire', 'ruby'].includes(k)) && kindsFor('cook').has('knife') && kindsFor('maid').has('flare-charges'), 'guards give blades and shields, lords coins and gems, cooks a knife, maids a flare recharge bottle', '')
  check(planGifts(['maid', 'servant'], 1).length === 2 && planGifts(['yard', 'traveller', 'lore', 'watch'], 1).length === 0, 'only folk with a gift to give are chosen, and a castle without them gives none', '')
  const taken = new Set([GIFT.bit])
  const stillOffered = offerable(planGifts(roles, 1), (bit) => taken.has(bit))
  check(stillOffered.length === 2 && stillOffered.every((g) => g.bit !== GIFT.bit), 'a gift whose ledger bit is taken is not offered again', stillOffered.map((g) => g.bit).join(' '))
  const says = Object.keys(ITEMS).filter((k) => Object.values(GIFT_KINDS).flat().includes(k)).map((k) => giftSays(k, 12345))
  check(says.every((t) => captionRows(t) <= CAPTION.rows && /[a-z]/.test(t)) && allGiftLines().every((t) => captionRows(t) <= CAPTION.rows), 'every thanks a giver says fits the caption', allGiftLines().find((t) => captionRows(t) > CAPTION.rows))
  check(says.some((t) => t.includes('knife')) && says.some((t) => t.includes('flare recharge bottle')), 'the thanks names the thing held out', says[0])
  check(unvoiced.length === 0, 'every castle line is voiced by a recorded moment and fits', unvoiced[0])
  check(['lord', 'steward', 'cook', 'maid', 'servant', 'guard', 'watch', 'gate', 'yard', 'traveller'].every((w) => urged.has(w)) && !urged.has('lore'), 'everyone in a castle but the summit guard presses the view from the top of the highest tower', [...urged].join(' '))
  check(ghosts.length > 0, "the summit guard tells of the dungeon's forlorn ghost", ghosts[0])

  // Gossip: each castle has its own stories, and every teller puts the one all of them know their own way.
  const newses = Array.from({ length: 20 }, (_, seed) => castleNews(seed + 1)), sets = new Set(newses.map((n) => JSON.stringify(n)))
  check(sets.size === 20, 'castles have their own news, not one shared list', `${sets.size} distinct sets of news in 20 castles`)
  check(newses.every((n) => ['key', 'hoard', 'summit', 'noise'].includes(n[0].kind)) && new Set(newses.map((n) => n[0].kind)).size === 4, "the story all a castle's folk know hints at the dungeon key, the dungeon chest, the summit chest or the dungeon itself", newses.map((n) => n[0].kind).join(' '))
  const story = castleNews(1)[0], tellings = new Set(), tempers = new Set()
  for (const who of ['lord', 'steward', 'cook', 'maid', 'servant', 'guard', 'watch', 'gate', 'yard', 'traveller', 'lore']) for (let i = 0; i < 4; i++) {
    const id = `castle:1:${who}:${i}`, mind = { who, ...castleTemper(who, id) }
    tempers.add(mind.mood)
    tellings.add(tellCastle(story, mind, mulberry32(mind.h)))
  }
  check(tellings.size >= 30 && tempers.size === 4, 'one story is told in many ways across a castle, by folk of every mood', `${tellings.size} tellings of 44, moods ${[...tempers].join(' ')}: ${[...tellings].slice(0, 3).join(' || ')}`)
  const owned = []
  for (let seed = 1; seed < 60 && owned.length < 3; seed++) for (const s of castleNews(seed)) {
    const party = ['lord', 'steward', 'cook', 'maid'].find((r) => s.parties.includes(r))
    if (party === undefined || !['key', 'feud', 'pet', 'broke', 'sweet'].includes(s.kind)) continue
    const id = `castle:${seed}:${party}`, text = tellCastle(s, { who: party, ...castleTemper(party, id) }, mulberry32(seed))
    if (!/\b(I|my|My)\b/.test(text)) owned.push(`NOT OWNED ${party}: ${text}`)
    else if (owned.length < 3) owned.push(text)
  }
  check(owned.length > 0 && owned.every((t) => !t.startsWith('NOT OWNED')), 'whoever a story is about tells it as their own', owned.join(' || '))
  const noise = Array.from({ length: 200 }, (_, seed) => castleNews(seed)).flat().filter((x) => x.kind === 'noise')
  const guardSays = noise.map((x) => tellCastle(x, { who: 'guard', ...castleTemper('guard', 'castle:9:guard') }, mulberry32(x.key)))
  check(noise.length > 0 && guardSays.every((t) => /^On night watch I hear/.test(t)), 'a guard tells of noises in the dungeon as one who stands the night watch herself', guardSays[0])
  const ends = new Map()
  for (const x of noise) ends.set(x.f.sound, new Set([...(ends.get(x.f.sound) ?? []), tellCastle(x, { who: 'cook', ...castleTemper('cook', 'castle:9:cook') }, mulberry32(1)).split(/(?<=[.!?]) /).at(-1)]))
  check(ends.size >= 4 && [...ends.values()].every((e) => e.size === 1) && new Set([...ends.values()].map((e) => [...e][0])).size === ends.size, 'each noise in the dungeon is followed by its own remark', [...ends].map(([k, e]) => `${k}: ${[...e][0]}`).join(' | '))
  const bodies = allCastleBodies().filter((b) => !/^(I|My|On|Yes)\b/.test(b))
  check(bodies.every((b) => COMMON.test(b)), 'every castle story opens on a word a run-in lead knows to lowercase', bodies.find((b) => !COMMON.test(b)))
  const roll = mulberry32(3)
  const told = Array.from({ length: 40 }, (_, seed) => castleNews(seed)).flat().flatMap((x) => ['cook', 'yard', 'traveller'].flatMap((who) => Array.from({ length: 6 }, (_, k) => [x, tellCastle(x, { who, ...castleTemper(who, `castle:${k}:${who}`) }, roll)])))
  const hedged = told.filter(([, t]) => HEDGED.test(t))
  const clumsy = told.find(([, t]) => CLUMSY.test(t) || /\ba [aeiou]/i.test(t))
  check(hedged.length > 0 && clumsy === undefined && hedged.every(([x, t]) => hedgeTrue(x, t)), 'castle gossip never says "a owl", stacks two leads or hedges between a question and its answer, and a muddled teller\'s second thought names the true detail', clumsy?.[1] ?? hedged.find(([x, t]) => !hedgeTrue(x, t))?.[1] ?? hedged[0]?.[1])
  const sent = new CastleChat({ id: 'castle:1:guard:7', name: 'guard', who: 'guard', castle: 1, ...castleTemper('guard', 'castle:1:guard:7') }, { rooms: 17, wards: wardsAt(5, 5), ways: waysFor(castleLayout(1), 'guard') }, { salt: 7 })
  sent.open()
  let pushed = null
  for (let i = 0; i < 20 && sent.parting === null; i++) pushed = sent.ask(sent.menu().find((c) => c.topic !== 'bye').topic)
  const sentMenu = sent.menu(), sentOff = sent.ask(NEXT.topic)
  check(sent.parting !== null && !pushed.ended && pushed.alone > 0 && sentMenu.length === 1 && sentMenu[0] === NEXT && sentOff.ended && sentOff.moment === 'bye.curt' && !pushed.text.includes(sentOff.text), 'a castle guard pushed past patience answers, then sends her off on a page of its own', `${pushed.text} -> ${sentOff.text}`)
}

// Town gossip: each town's own happenings among its own folk, told from where each teller stands, with true places and hints in it.
{
  const nw = new TalkWorld(SEED, towns)
  nw.seatHideouts(hideouts(towns, fakeCaves, fakeKeeps))
  // A roost 900 m north of every other town.
  const roostAt = (t) => ({ x: t.town.x, z: t.town.z - 900 })
  nw.seatDeer(nw.towns.filter((t) => t.index % 2 === 0).map(roostAt))
  const newses = nw.towns.map((t) => nw.news(t.index))
  check(new Set(newses.map((n) => JSON.stringify(n))).size === nw.towns.length && new Set(newses.map((n) => n.map((s) => s.kind).join())).size >= nw.towns.length / 2, 'every town has its own news, not one list', newses.slice(0, 4).map((n) => n.map((s) => s.kind).join(' ')).join(' | '))
  check(newses.every((n) => ['lover', 'dragon', 'cave', 'castle'].includes(n[0].kind)), 'the story a whole town knows tells of a place near it', newses.map((n) => n[0].kind).join(' '))
  const wrong = []
  for (const t of nw.towns) for (const s of nw.news(t.index)) {
    const names = storyNames(nw, t, s)
    if (s.kind === 'lover') {
      const near = nw.nearestTown(t.town.x, t.town.z, t.index)
      if (s.f.town !== near.name || s.f.dir !== compass(near.town.x - t.town.x, near.town.z - t.town.z) || names.town !== near.index) wrong.push(`${t.name} lover: ${JSON.stringify(s.f)}`)
    }
    if (s.kind === 'dragon') {
      const d = (o) => Math.hypot(o.x - t.town.x, o.z - t.town.z), roost = nw.roosts.reduce((a, o) => (d(o) < d(a) ? o : a))
      if (s.f.dir !== compass(roost.x - t.town.x, roost.z - t.town.z) || names.toward.x !== roost.x || names.toward.z !== roost.z) wrong.push(`${t.name} dragon: ${JSON.stringify(s.f)}`)
    }
    if (s.kind === 'cave' && s.f.cave !== nw.hideouts[t.index].label) wrong.push(`${t.name} cave: ${s.f.cave}`)
  }
  check(wrong.length === 0, 'a place in the news lies where they say: the next town, the roost and the cave by their true direction', wrong[0])
  check(newses.some((n) => n.some((s) => s.kind === 'dragon')) && newses.some((n) => n.some((s) => s.kind === 'lover')), 'towns tell of both a roost and the next town over', newses.map((n) => n[0].kind).join(' '))

  // Perspective: a feud as the two parties, their kin, their friends and a bystander tell it.
  let feud = null
  for (const t of nw.towns) for (const s of nw.news(t.index)) if (feud === null && s.kind === 'feud') feud = { t, s }
  check(feud !== null, 'some town is feuding')
  const { t: ft, s: fs } = feud
  const [a, b] = fs.parties.map((p) => ft.minds[p])
  const told = (m, k = 0) => tellTown(fs, { ...m, h: strHash(m.id) + k }, mulberry32(k + 1))
  const blames = (m, who) => Array.from({ length: 12 }, (_, k) => told(m, k)).some((x) => x.includes(`${who.name} started it`))
  const friendOf = (x, y) => ft.minds.find((m) => m.friends.includes(x.index) && !m.friends.includes(y.index) && m.rival !== x.index && m !== y && !m.household.includes(x.index) && !m.household.includes(y.index))
  const fa = friendOf(a, b), fb = friendOf(b, a)
  check(/\bI\b/.test(told(a)) && /\bI\b/.test(told(b)) && told(a).includes(b.name) && told(b).includes(a.name), 'each party to a feud tells it as their own', `${told(a)} || ${told(b)}`)
  check(fa !== undefined && fb !== undefined && blames(fa, b) && !blames(fa, a) && blames(fb, a) && !blames(fb, b), "a friend of either side blames the other one", `${fa?.name}: ${told(fa)} || ${fb?.name}: ${told(fb)}`)
  const kinOf = (x) => ft.minds.find((m) => m.household.includes(x.index))
  const ka = kinOf(a) ?? kinOf(b)
  check(ka === undefined || /^Our /.test(told(ka)), "a party's household tells it as family", ka === undefined ? 'no kin' : told(ka))

  // The pumpkins: the child owns up, the farmer complains, and both are true of the knife and the striders.
  let pump = null
  for (const t of nw.towns) for (const s of nw.news(t.index)) if (pump === null && s.kind === 'pumpkins') pump = { t, s }
  check(pump !== null, 'some town tells of the carved pumpkins')
  const [kid, farmer] = pump.s.parties.map((p) => pump.t.minds[p])
  const kidSays = tellTown(pump.s, { ...kid, h: strHash(kid.id) }, mulberry32(1)), farmerSays = tellTown(pump.s, { ...farmer, h: strHash(farmer.id) }, mulberry32(1))
  check(kid.cls === 'child' && farmer.trade === 'farm' && /knife/.test(kidSays) && /my pumpkins/.test(farmerSays) && /fish/.test(farmerSays), "the child who carved a farmer's pumpkins owns to the smith's knife, and the farmer learnt striders only eat fish", `${kidSays} || ${farmerSays}`)

  // Every telling by every townsperson fits, in plain text.
  const bad = []
  let n = 0, hedges = 0
  for (const t of nw.towns) for (const s of nw.news(t.index)) for (const m of t.minds) for (let k = 0; k < 3; k++) {
    const text = tellTown(s, { ...m, h: strHash(m.id) + k }, mulberry32(k))
    n++
    if (HEDGED.test(text)) hedges++
    if (!/^[\x20-\x7e]+$/.test(text) || captionRows(text) > CAPTION.rows || /undefined|null/.test(text) || /\ba [aeiou]/i.test(text) || CLUMSY.test(text) || (HEDGED.test(text) && !hedgeTrue(s, text))) bad.push(text)
  }
  check(bad.length === 0 && n > 500 && hedges > 0, 'every town story, told by anyone, fits the caption in plain text, never says "a owl", never stumbles, and any second thought names the true detail', `${n} tellings, ${hedges} with second thoughts: ${bad[0]}`)

  // Asked in conversation: the missing child first, then each story heard, never twice, then nothing more; its hints unlock lore.
  const qt = nw.towns.find((t) => [...quests.values()].some((q) => q.kind === 'missing-child' && q.town === t.index))
  const q = [...quests.values()].find((x) => x.kind === 'missing-child' && x.town === qt.index)
  const asker = qt.minds.find((m) => m.id !== q.parent && m.id !== q.child && m.cls !== 'child')
  const nctx = ctxAt(fire(qt), { world: nw })
  const c = new Conversation(asker, nctx)
  const said = []
  check(c.menu().some((x) => x.topic === 'talk:news'), 'townsfolk can be asked for news')
  for (let i = 0; i < 8; i++) said.push(c.say('talk:news'))
  const stories = said.filter((l) => l.moment === 'gossip.lead')
  check(said[0].about.some((a) => a.kind === 'missing') && stories.length >= 2 && new Set(stories.map((l) => l.text)).size === stories.length && said[7].moment === 'answer.spent', 'asked for news, they tell of the missing child, then each story they know once, then have no more', said.map((l) => l.text).join(' || '))
  const voiced = new LinePicker(table, SEED), clips = stories.slice(1).flatMap((l) => Array.from({ length: 12 }, (_, i) => voiced.pick(asker, l.moment, { now: 1e4 + i, force: true, only: l.only }).line))
  check(clips.length > 0 && clips.every((l) => !l.startsWith('someones-missing')), "a story is never voiced as someone's missing", [...new Set(clips)].join(' '))
  const opened = stories.flatMap((l) => l.unlocks)
  check(opened.some((u) => TOPICS[u].gated) && opened.every((u) => nctx.known.has(u)), 'a hint in the news opens its lore to ask about', opened.join(' '))
  const pointed = stories.filter((l) => l.gesture === 'talk-point')
  check(pointed.length > 0 && pointed.every((l) => l.toward !== null), 'telling of a place, they point toward it', pointed.map((l) => l.text).join(' || '))

  if (process.argv.includes('--news')) for (const t of nw.towns.slice(0, 6)) {
    console.log(`\n${t.name}`)
    for (const s of nw.news(t.index)) for (const m of t.minds.slice(0, 3)) console.log(`  ${m.name.padEnd(8)} ${tellTown(s, { ...m, h: strHash(m.id) }, mulberry32(strHash(m.id)))}`)
  }
}

if (process.argv.includes('--transcript')) {
  for (const who of [parent, w0, friend]) {
    const c = new Conversation(who, ctxAt(fire(world.townOf(who))))
    const T = Object.entries(who.traits).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' ')
    console.log(`\n--- ${who.name} the ${who.body} of ${world.townOf(who).name} (${T}; ${who.quirk.need ?? who.quirk.kind})`)
    console.log(`  > ${c.opener().text}`)
    for (const topic of ['talk:self', 'talk:town', 'talk:needs', 'where:title:smith', 'where:title:potionmaster', `ask:person:${q.child}`, 'where:here']) console.log(`  [${topic}] ${c.say(topic).text}`)
    console.log(`  chips: ${c.menu().map((x) => x.label).join(' / ')}`)
  }
}

console.log(failures === 0 ? '\nall talk checks pass' : `\n${failures} talk check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
