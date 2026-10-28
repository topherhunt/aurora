// What two neighbours' chatter sounds like (talk/chat.js EXCHANGES), clip by clip, with each speaker's tone to her.
//   node scripts/probe-chatter.mjs [--pairs 12] [--turns 12] [--seed 1]

import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planTowns } from '../src/v2/layers/towns.js'
import { TalkWorld } from '../src/v2/talk/world.js'
import { Conversation } from '../src/v2/talk/speak.js'
import { chatterStep } from '../src/v2/talk/chat.js'
import { LinePicker } from '../src/v2/talk/lines.js'
import { Rapport } from '../src/v2/talk/rapport.js'
import { QuestLog, questsFor } from '../src/v2/talk/quests.js'
import { HUMAN } from '../tools/voice/atoms.js'
import { stubPack } from './lib/talk-walk.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : Number(process.argv[i + 1]) }
const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const { towns } = planTowns({ ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })
const world = new TalkWorld(SEED, towns)
const table = JSON.parse(readFileSync(new URL('../public/sounds/voice/moments.json', import.meta.url), 'utf8'))
const text = new Map(HUMAN.map((u) => [u.id, u.text]))
const picker = new LinePicker(table, SEED)

let state = arg('--seed', 1) >>> 0
const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const epoch = 3
const quests = questsFor(world, epoch)
const ctxFor = (mind, hour) => ({
  world, rapport: new Rapport(), quests, log: new QuestLog(), epoch, from: { x: 0, z: 0 }, hour, known: new Set(),
  pack: stubPack({}), wants: null, inWorkshop: false, inShop: false, armed: false, wronged: false, witness: null,
})
const people = world.towns.flatMap((t) => t.minds).filter((m) => m.kind === 'human')
const tally = new Map()
let now = 0
for (let p = 0; p < arg('--pairs', 12); p++) {
  const a = people[(rand() * people.length) | 0]
  const town = world.towns.find((t) => t.minds.includes(a))
  const mates = town.minds.filter((m) => m !== a && m.kind === 'human')
  const b = mates[(rand() * mates.length) | 0]
  const hour = [7, 12, 16, 19, 23][(rand() * 5) | 0]
  const who = (m) => {
    const c = new Conversation(m, ctxFor(m, hour))
    const T = m.traits
    return `${m.name} ${c.tone}${c._worried() ? ' WORRIED' : ''} k${T.kindness.toFixed(1)} c${T.chattiness.toFixed(1)} w${T.wariness.toFixed(1)}`
  }
  console.log(`\n--- ${hour}h  A: ${who(a)}  |  B: ${who(b)}`)
  let at = null
  for (let i = 0; i < arg('--turns', 12); i++) {
    const m = i % 2 === 0 ? a : b
    const tone = new Conversation(m, ctxFor(m, hour)).tone
    const step = chatterStep(m, ctxFor(m, hour), at, { hour, r: rand(), alt: rand() })
    if (step === null) { console.log('  -- they part'); break }
    now += 4
    const k = `${tone} ${step.moment === null ? 'hush' : step.at.ex}`
    tally.set(k, (tally.get(k) ?? 0) + 1)
    if (step.moment === null) { console.log(`  ${i % 2 === 0 ? 'A' : 'B'} ...`); continue }
    const pick = picker.pick(m, step.moment, { now, force: true, only: step.only })
    at = step.at
    const said = pick === null ? `(unrecorded: ${step.only.map((id) => text.get(id)).join(' / ')})` : text.get(pick.line.slice(0, pick.line.indexOf('.')))
    console.log(`  ${i % 2 === 0 ? 'A' : 'B'} ${step.at.ex}.${step.at.step} ${step.moment.padEnd(18)} ${said}`)
  }
}
console.log('\n--- exchanges by tone')
for (const [k, n] of [...tally].sort()) console.log(`  ${k}: ${n}`)
