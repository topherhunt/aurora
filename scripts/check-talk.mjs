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
import { LORE, TOPICS, TRUST } from '../src/v2/talk/lore.js'
import { DialogGrid } from '../src/v2/talk/grid.js'
import { Chat, CHAT, EXCHANGES, chatterStep } from '../src/v2/talk/chat.js'
import { LinePicker, leafkinTier, LEAFKIN_ATOM } from '../src/v2/talk/lines.js'
import { TalkWorld } from '../src/v2/talk/world.js'
import { Rapport } from '../src/v2/talk/rapport.js'
import { QuestLog, questsFor, missingChild, MESSAGES } from '../src/v2/talk/quests.js'
import { Conversation, SPEAK, gossip } from '../src/v2/talk/speak.js'
import { MANNERS } from '../src/v2/talk/manners.js'
import { LK } from '../src/v2/talk/leafkin.js'
import * as trade from '../src/v2/talk/trade.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const { towns } = planTowns({ ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })

const world = new TalkWorld(SEED, towns)
const EPOCH = 7
const quests = questsFor(world, EPOCH)
// A pack in the shape main.js's has: `have` counts by kind, `slots` the large slots in all.
const LARGE_KINDS = new Set(['bog-iron', 'lodestone', 'rimesilver', 'firestone', 'flint', 'egg', 'pickaxe', 'sword', 'shield'])
const stubPack = (have = {}, slots = 12) => {
  const n = { ...have }
  const used = () => Object.entries(n).filter(([k]) => LARGE_KINDS.has(k)).reduce((a, [, c]) => a + c, 0)
  return {
    n,
    count: (k) => n[k] ?? 0,
    freeLarge: () => slots - used(),
    held: () => null,
    add(k, c = 1) { if (LARGE_KINDS.has(k) && slots - used() < c) return false; n[k] = (n[k] ?? 0) + c; return true },
    remove(k, c = 1) { if ((n[k] ?? 0) < c) return false; n[k] -= c; return true },
  }
}
const ctxAt = (from, more = {}) => ({ world, rapport: new Rapport(), quests, log: new QuestLog(), epoch: EPOCH, from, hour: 12, known: new Set(), pack: stubPack(), wants: null, inWorkshop: false, wronged: false, witness: null, ...more })
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
  check(/^Like I said/.test(a2.text), 'asked again, they say "like I said"', a2.text)
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
check(qs.length > world.towns.length * 0.2 && qs.length < world.towns.length * 0.8, 'about half the towns have a missing child this epoch', `${qs.length} of ${world.towns.length}`)
check(JSON.stringify([...questsFor(world, EPOCH).values()]) === JSON.stringify([...quests.values()]), 'quests are a pure function of the seed and epoch')
check(JSON.stringify(missingChild(world, qs[0].town, EPOCH + 1)) !== JSON.stringify(qs[0]), 'the next epoch rolls afresh')
const qOk = qs.every((q) => {
  const child = world.person(q.child), parent = world.person(q.parent)
  return child.cls === 'child' && child.household.includes(parent.index) && !q.witnesses.some((w) => w.who === q.parent || q.covers.includes(w.who)) && dist(q.witnesses[0]?.clue ?? q.where, q.where) < 0.01
})
check(qOk, 'every quest: the child lives with the parent, no witness is the parent or a coverer, the first witness saw where the child went')
const variants = new Set(qs.map((q) => q.where.variant))
check(variants.size === 3, 'children go missing in all three ways across the world', [...variants].join(', '))
const hiding = qs.filter((q) => q.where.variant === 'hiding')
check(hiding.every((q) => q.where.building !== world.person(q.child).home && q.covers.length > 0), "a hiding child is in another household's house, which covers for them")
const road = qs.filter((q) => q.where.variant === 'road')
check(road.every((q) => q.where.toward !== q.town), 'a child gone by road went toward another town')

// The quest played: the parent pleads, a witness points true, a coverer lies or, trusted and honest, admits.
const q = hiding[0] ?? qs[0]
const qt = world.towns[q.town]
const qctx = ctxAt(fire(qt))
const parent = world.person(q.parent)
const plea = new Conversation(parent, qctx).opener()
check(plea.quest === q.id && plea.mood === 'distress' && qctx.log.state(q.id) === 'accepted', 'the parent hails her with the plea, and she has taken the quest', plea.text)
const w0 = world.person(q.witnesses[0].who)
const seen = new Conversation(as(w0, STRAIGHT), qctx).say(`ask:person:${q.child}`)
check(seen.claim !== null && dist(seen.claim, q.where) < SPEAK.same, 'an honest witness points where the child really went', seen.text)
const passer = qt.minds.find((m) => m.id !== q.parent && m.cls !== 'child' && !q.witnesses.some((w) => w.who === m.id) && !q.covers.includes(m.id))
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
if (q.covers.length > 0) {
  const cv = world.person(q.covers[0])
  const lie = new Conversation(as(cv, { honesty: 0, wariness: 0, accuracy: 1 }), ctxAt(fire(qt))).say(`ask:person:${q.child}`)
  check(lie.claim !== null && dist(lie.claim, q.where) > SPEAK.same, 'a dishonest coverer sends her somewhere else', lie.text)
  const tctx = ctxAt(fire(qt))
  tctx.rapport.owe(cv.id, 1)
  const truth = new Conversation(as(cv, { honesty: 1, wariness: 0.5 }), tctx).say(`ask:person:${q.child}`)
  check(truth.claim === q.where && /safe/.test(truth.text), 'an honest coverer who trusts her admits the child is safe with them', truth.text)
  // Telling a coverer a lie about where the child is: they know better.
  const fake = world.buildingPlace(qt, world.person(q.parent).home)
  const told = new Conversation(cv, ctxAt(fire(qt))).tell({ kind: 'where', about: q.child, ...fake })
  check(told.caught === true, 'a coverer catches her lying about where the child is', told.text)
}

// --- the message ---
const msgs = [...quests.values()].filter((x) => x.kind === 'message')
check(msgs.length > world.towns.length * 0.3 && msgs.every((x) => {
  const to = world.person(x.to)
  return to.cls !== 'child' && to.town === world.nearestTown(fire(world.towns[x.town]).x, fire(world.towns[x.town]).z, x.town).index && [...x.choices].sort().join() === '0,1,2,3'
}), 'many towns have word to send, always to a grown-up in the nearest town, with four phrasings to choose from', `${msgs.length} of ${world.towns.length}`)
check(msgs.filter((x) => x.choices[0] === 0).length < msgs.length * 0.5, 'the true phrasing is not always offered first', `first in ${msgs.filter((x) => x.choices[0] === 0).length} of ${msgs.length}`)
const msg = msgs.find((x) => world.person(x.giver).id !== qs.find((c) => c.town === x.town)?.parent) ?? msgs[0]
const mctx = ctxAt(fire(world.towns[msg.town]))
const giver = world.person(msg.giver), to = world.person(msg.to)
const ask = new Conversation(giver, mctx).say('talk:needs')
check(mctx.log.state(msg.id) === 'accepted' && ask.text.includes(MESSAGES[msg.message][0]) && ask.text.includes(to.name), 'asked what they need, the sender hands her the message word for word, and she has taken it', ask.text)
const rc = new Conversation(to, { ...mctx, from: fire(world.townOf(to)) })
check(!new Conversation(to, ctxAt(fire(world.townOf(to)))).menu().some((c) => c.topic.startsWith('deliver:')), 'the recipient offers no "word from" chip to someone carrying none')
check(rc.menu().some((c) => c.topic === `deliver:${msg.id}`), 'the recipient offers a "word from" chip to her')
rc.say(`deliver:${msg.id}`)
const offered = rc.menu().filter((c) => c.topic.startsWith('word:'))
check(offered.length === 4 && offered.some((c) => c.label.includes(MESSAGES[msg.message][0])), 'asked what was said, she chooses among the true words and three near-misses', offered.map((c) => c.label).join(' / '))
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
const NAMES = { mushrooms: /mushroom|chanterelle|agaric|porcini|ink cap|parasol/i, curses: /\bcurse/i, flares: /\bflare/i, caves: /\bcaves?\b/i, labyrinths: /\bmazes?\b/i, gems: /\bgems?\b|diamond|ruby|jade/i, leafkin: /leafkin/i, ores: /\bflint\b|\bores?\b|\biron\b|copper|titanium|firestone/i, eating: /\beat\b/i, dragons: /dragon/i, snowlands: /\bsnow\b/i, yetis: /\byetis?\b/i }
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
  if (l.claim === null && /Ask /.test(l.text)) { referred = { l, menu: c.menu() }; break }
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
check(dunnoOf(SURLY).every((l) => !/Ask |would know/.test(l.text)), 'a curt speaker who does not know sends her nowhere', dunnoOf(SURLY)[0]?.text)
check(dunnoOf(FRIENDLY).every((l) => /Ask \w+ the \w+\.|would know/.test(l.text)), 'a friendly speaker who does not know names who would, by name and calling', dunnoOf(FRIENDLY)[0]?.text)
const whoOf = (m, topic, traits, known = []) => {
  const c = new Conversation(as(m, traits), ctxAt(fire(world.townOf(m)), { known: new Set(known) }))
  return { c, l: c.say(`who:${topic}`) }
}
const pointer = folk.map((m) => ({ m, ...whoOf(m, 'ores', FRIENDLY) })).find(({ m, l }) => m.body !== 'blacksmith' && l.about.length > 0)
check(pointer !== undefined && pointer.c.menu().some((x) => x.label === 'Who knows about striders?') && pointer.c.menu().some((x) => x.topic === `where:person:${pointer.l.about[0].id}`), 'asked who knows of ores, a friendly non-smith names the expert, and she can ask where they are', pointer?.l.text)
const smiths = all.filter((m) => m.body === 'blacksmith').map((m) => whoOf(m, 'ores', FRIENDLY).l)
check(smiths.length > 0 && smiths.every((l) => /looking at them/.test(l.text)), 'asked who knows of ores, the smith says they do', smiths[0]?.text)
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
for (let i = 0; i < 40 && !pest.ended; i++) pestLast = pest.ask('talk:town')
check(pest.ended && octx.rapport.standing(calm[0].id) < 0, 'pushing past someone\'s patience until sent off cools them', pestLast.text)

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
const cheery = as(all.find((m) => m.cls === 'folk' && !trade.isSmith(m)), { kindness: 1, chattiness: 1, wariness: 0 })
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
while (!terse.ended && turns < 40) { last = terse.ask('talk:town'); turns++ }
check(terse.ended && turns <= terse.patience && last.alone > 0, 'a curt person runs out of patience and sends her off', `${turns} questions: ${last.text}`)
const byeChat = new Chat(cheery, ctxAt(fire(world.townOf(cheery))))
const bye = byeChat.ask('bye')
check(bye.ended && bye.moment === 'bye.warm' && bye.alone >= CHAT.alone.bye, 'goodbye ends it warmly, and they leave her be after', bye.text)

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
for (const [kind, book] of Object.entries(EXCHANGES)) for (const [ex, steps] of Object.entries(book)) for (const step of steps) for (const alt of step.split(' | ')) {
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
for (let i = 0; i < 14; i++) {
  const s = chatterStep(pair[i % 2], ctxAt(fire(t0)), at, { hour: 14, r: (i * 0.37) % 1, alt: (i * 0.61) % 1 })
  heardSteps.push(`${s.at.ex}.${s.at.step}`)
  at = s.at
}
const inOrder = heardSteps.every((s, i) => {
  const [ex, n] = s.split('.')
  return i === 0 ? ex === 'greet' && n === '1' : n === '1' ? heardSteps[i - 1].split('.')[1] === String(EXCHANGES.human[heardSteps[i - 1].split('.')[0]].length) : heardSteps[i - 1] === `${ex}.${n - 1}`
})
check(inOrder, 'two neighbours meet with a greeting, then talk each exchange through in order before the next', heardSteps.join(' '))
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
const human = as(all.find((m) => m.cls === 'folk' && !trade.isSmith(m)), STRAIGHT)
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
  check(pk.count(item) === 1 && pk.count('coin') === 0 && pk.count('bog-iron') === 0 && sold.moment === 'give.thanks', `buying a ${item} with the coins and iron it costs hands it over and takes the payment`, JSON.stringify(pk.n))
}
const lack = [['no coins', { 'bog-iron': 3 }, /coin/], ['too little iron', { coin: 100, 'bog-iron': 2 }, /iron/]]
for (const [what, have, word] of lack) {
  const pk = stubPack(have)
  const before = JSON.stringify(pk.n)
  const no = new Conversation(smith, inShop(pk)).say('shop:buy:sword')
  check(JSON.stringify(pk.n) === before && word.test(no.text) && no.moment === 'refuse.price', `a sword sale with ${what} fails, says what is short and leaves the pack as it was`, no.text)
}
const full = stubPack({ coin: 50, flint: 12 }, 12)
const fullBefore = JSON.stringify(full.n)
const noRoom = new Conversation(smith, inShop(full)).say('shop:buy:pickaxe')
check(JSON.stringify(full.n) === fullBefore && /room|space|slot|full|pack|hands/i.test(noRoom.text), 'a pickaxe sale with every large slot held fails, says there is no room, and changes nothing', noRoom.text)
const tight = stubPack({ coin: 100, 'bog-iron': 3 }, 3)
const squeezed = new Conversation(smith, inShop(tight)).say('shop:buy:sword')
check(tight.count('sword') === 1 && squeezed.moment === 'give.thanks', 'the iron paid frees its slots, so a full pack of exactly the iron still buys a sword', JSON.stringify(tight.n))
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
check(emptyHanded.count('coin') === 0 && noGoods.moment === 'refuse.price', 'a trade she cannot cover gives nothing and says so', noGoods.text)
check(trade.buys(smith).every((k) => trade.ORES.includes(k)) && trade.buys(smith).length > 0, 'the blacksmith buys ores and nothing else')
check(trade.buys(leaf[0]).includes('coin') && trade.buys(leaf[0]).every((k) => trade.GEMS.includes(k) || k === 'coin'), 'leafkin take gems and coin, no ore')
const lkPack = stubPack({ jade: 1 })
const lkc = new Conversation(leaf[0], ctxAt({ x: 0, z: 0 }, { pack: lkPack, wants: 'jade' }))
check(/jade/i.test(lkc.opener().text) && lkc.opener().trade === true, 'a leafkin wanting her jade opens in pidgin about it', lkc.opener().text)
const lkDeal = lkc.menu().map((c) => c.topic).find((t) => t.startsWith('trade:take:'))
const lkSaid = lkDeal ? lkc.say(lkDeal) : null
check(lkSaid !== null && lkSaid.moment === 'give.thanks' && lkPack.count('jade') === 0 && lkPack.count('bog-iron') + lkPack.count('lodestone') > 0, 'a leafkin trade swaps her jade for iron or lodestone', JSON.stringify(lkPack.n))

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
const cavesAll = world.towns.flatMap((t) => t.minds).filter((m) => m.cls !== 'child').slice(0, 60).flatMap((m) => Array.from({ length: 12 }, (_, salt) => new Conversation(as(m, STRAIGHT), ctxAt(fire(world.townOf(m))), salt).say('lore:caves').text))
check(cavesAll.some((t) => /rabbit/i.test(t) && /(lost|child)/i.test(t)), 'someone tells of getting lost in a cave as a child and being led out by a pet rabbit', cavesAll.find((t) => /rabbit/i.test(t)))
check(cavesAll.some((t) => /fox/i.test(t) && /(sniff|treasure)/i.test(t)), 'someone tells that foxes sniff out cave treasure', cavesAll.find((t) => /fox/i.test(t)))

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

if (process.argv.includes('--transcript')) {
  for (const who of [parent, w0, ...q.covers.map((id) => world.person(id)).slice(0, 1), friend]) {
    const c = new Conversation(who, ctxAt(fire(world.townOf(who))))
    const T = Object.entries(who.traits).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' ')
    console.log(`\n--- ${who.name} the ${who.body} of ${world.townOf(who).name} (${T})`)
    console.log(`  > ${c.opener().text}`)
    for (const topic of ['talk:self', 'talk:town', 'talk:needs', 'where:title:smith', 'where:title:potionmaster', `ask:person:${q.child}`, 'where:here']) console.log(`  [${topic}] ${c.say(topic).text}`)
    console.log(`  chips: ${c.menu().map((x) => x.label).join(' / ')}`)
  }
}

console.log(failures === 0 ? '\nall talk checks pass' : `\n${failures} talk check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
