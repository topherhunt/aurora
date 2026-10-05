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
import { TRAITS, castMinds, villageMinds } from '../src/v2/talk/mind.js'
import { TalkWorld, compass } from '../src/v2/talk/world.js'
import { Rapport } from '../src/v2/talk/rapport.js'
import { QuestLog, questsFor, missingChild, MESSAGES } from '../src/v2/talk/quests.js'
import { Conversation, SPEAK, gossip } from '../src/v2/talk/speak.js'

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
const ctxAt = (from, more = {}) => ({ world, rapport: new Rapport(), quests, log: new QuestLog(), epoch: EPOCH, from, ...more })
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
  if (line.claim !== null && dist(line.claim, truth) < SPEAK.same && line.text.includes(compass(truth.x - from.x, truth.z - from.z)) && line.gesture === 'talk-point') pointed++
  else wrong.push(`${t.name}: ${line.text}`)
}
check(wrong.length === 0 && pointed > 0, 'an honest, accurate townsperson points at the real smithy, by the real compass bearing', `${pointed} towns${wrong.length ? `; ${wrong.slice(0, 2).join(' | ')}` : ''}`)
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
const drift = new Set(Array.from({ length: 12 }, () => cs.say(`where:person:${target.id}`).claim).map((c) => `${c.x.toFixed(1)},${c.z.toFixed(1)}`))
check(drift.size >= 2, 'a spacey townsperson asked the same thing twelve times gives drifting answers', `${drift.size} distinct`)

// --- wariness and standing ---
const wary = as(t0.minds.find((m) => m.household.length > 0 && m.cls !== 'child'), { wariness: 1, honesty: 1, accuracy: 1, greed: 0 })
const kin = t0.minds[wary.household[0]]
const wctx = ctxAt(fire(t0))
const cold = new Conversation(wary, wctx).say(`where:person:${kin.id}`)
check(cold.claim === null && cold.mood === 'cold', 'a wary stranger will not say where their own kin is', cold.text)
wctx.rapport.owe(wary.id, 1)
const warm = new Conversation(wary, wctx).say(`where:person:${kin.id}`)
check(warm.claim !== null, 'once in her debt, they will', warm.text)
const greedy = new Conversation(as(wary, { greed: 1 }), ctxAt(fire(t0))).say(`where:person:${kin.id}`)
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
