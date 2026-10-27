// Random conversations the way she has them -- a hail, then chips pressed at random -- across towns, leafkin, hours,
// packs, held items, standing, workshop and shop, busy and approached. probe-talk.mjs prints them; check-talk.mjs holds
// every line to the caption's rows.
import { villageMinds } from '../../src/v2/talk/mind.js'
import { Rapport } from '../../src/v2/talk/rapport.js'
import { QuestLog, questsFor } from '../../src/v2/talk/quests.js'
import { Chat } from '../../src/v2/talk/chat.js'
import { ITEMS } from '../../src/v2/items.js'

// What her pack may hold (main.js PACKABLE): a stub that throws on any other kind, as the real pack does.
export const PACKABLE = [...Object.keys(ITEMS), 'egg']
export const stubPack = (have) => {
  const n = { ...have }
  const known = (k) => { if (!PACKABLE.includes(k)) throw new Error(`pack: no item ${k}`); return k }
  return {
    n,
    count: (k) => n[known(k)] ?? 0,
    freeLarge: () => 6,
    held: () => null,
    holds: () => false,
    add(k, c = 1) { n[known(k)] = (n[k] ?? 0) + c; return true },
    remove(k, c = 1) { if ((n[known(k)] ?? 0) < c) return false; n[k] -= c; return true },
  }
}

/** Walks `n` conversations in `world` from seed `seed`, calling `hear(mind, who, topic, line)` per line (`topic` null for the opener). A throw is passed on with `who` in its message. */
export function walkTalks(world, seed, n, hear) {
  let state = seed >>> 0
  const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pick = (a) => a[Math.floor(rand() * a.length)]
  const people = world.towns.flatMap((t) => t.minds)
  const leaf = villageMinds(world.seed, 8, [0, 1, 2, 3, 4, 5, 6, 7])
  for (let i = 0; i < n; i++) {
    const epoch = Math.floor(rand() * 20)
    const isLeaf = rand() < 0.12
    const mind = isLeaf ? pick(leaf) : pick(people)
    const town = isLeaf ? null : world.townOf(mind).town
    const hour = pick([2, 7, 12, 16, 20, 23])
    const have = {}
    for (const k of PACKABLE) if (rand() < 0.15) have[k] = 1 + Math.floor(rand() * 4)
    const held = rand() < 0.3 ? pick(Object.keys(have).concat([null])) ?? null : null
    const rapport = new Rapport()
    rapport.warm(mind.id, rand() * 0.8 - 0.2)
    const ctx = {
      world, rapport, quests: questsFor(world, epoch), log: new QuestLog(), epoch, from: town ? { x: town.x, z: town.z } : { x: 0, z: 0 }, hour, known: new Set(),
      pack: stubPack(have), wants: held, inWorkshop: rand() < 0.5, inShop: rand() < 0.5, armed: false, wronged: false, witness: null,
    }
    const who = `${mind.name} the ${mind.body}${town ? ` of ${world.townOf(mind).name}` : ''} (${isLeaf ? 'leafkin' : mind.quirk.need ?? mind.quirk.kind}; ${hour}h${ctx.inWorkshop ? ' workshop' : ''}${ctx.inShop ? ' shop' : ''}${held ? ` holding ${held}` : ''})`
    try {
      const chat = new Chat(mind, ctx, { busy: rand() < 0.3, approached: rand() < 0.25, salt: i })
      let line = chat.open()
      hear(mind, who, null, line)
      for (let turn = 0; turn < 8 && !line.ended; turn++) {
        const topic = pick(chat.conv.menu().filter((c) => c.topic !== 'bye' || turn > 5)).topic
        line = chat.ask(topic)
        hear(mind, who, topic, line)
      }
    } catch (e) {
      e.message = `${who}: ${e.message}`
      throw e
    }
  }
}
