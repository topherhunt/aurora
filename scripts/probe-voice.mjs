// Which recorded clip plays under which reply (talk/lines.js), for a read of whether the voice fits what was said.
// Walks random conversations (lib/talk-walk.mjs) and groups every human line by the moment it asks the voice for.
//   node scripts/probe-voice.mjs [--n 400] [--seed 1] [--per 6]   (--per: sample lines shown per topic under a moment)

import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planTowns } from '../src/v2/layers/towns.js'
import { TalkWorld } from '../src/v2/talk/world.js'
import { HUMAN } from '../tools/voice/atoms.js'
import { walkTalks } from './lib/talk-walk.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : Number(process.argv[i + 1]) }
const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const { towns } = planTowns({ ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })
const world = new TalkWorld(SEED, towns)
const table = JSON.parse(readFileSync(new URL('../public/sounds/voice/moments.json', import.meta.url), 'utf8')).human
const text = new Map(HUMAN.map((u) => [u.id, u.text]))
const clips = (moment) => (table[moment] ?? []).map((l) => text.get(l.slice(0, l.indexOf('.')))).join(' | ')

// moment -> topic family -> sample lines
const by = new Map()
const family = (topic) => (topic === null ? 'opener' : topic.split(':').slice(0, topic.startsWith('where:title') || topic.startsWith('trade:take') ? 2 : 1).join(':'))
walkTalks(world, arg('--seed', 1), arg('--n', 400), (mind, who, topic, line) => {
  if (mind.kind === 'leafkin') return
  const m = by.get(line.moment) ?? new Map()
  by.set(line.moment, m)
  const f = family(topic)
  const s = m.get(f) ?? []
  m.set(f, s)
  s.push(line.text)
})
const per = arg('--per', 6)
for (const [moment, fams] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
  const n = [...fams.values()].reduce((a, s) => a + s.length, 0)
  console.log(`\n=== ${moment} (${n})  clips: ${clips(moment) || 'NONE'}`)
  for (const [f, s] of [...fams].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  [${f}] x${s.length}`)
    for (const t of [...new Set(s)].slice(0, per)) console.log(`      ${t}`)
  }
}
