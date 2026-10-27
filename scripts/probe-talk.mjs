// Prints random conversations (lib/talk-walk.mjs) for a read for realism, and flags what reads as stitched: a sentence
// said twice in one talk to different questions, a need's aside outside small talk, a caption past its rows, a throw.
//   node scripts/probe-talk.mjs [--n 60] [--seed 1] [--quiet]   (--quiet prints only the flags and their tally)

import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planTowns } from '../src/v2/layers/towns.js'
import { TalkWorld } from '../src/v2/talk/world.js'
import { quirkLines } from '../src/v2/talk/quirks.js'
import { captionRows, CAPTION } from '../src/v2/talk/caption.js'
import { walkTalks } from './lib/talk-walk.mjs'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : Number(process.argv[i + 1]) }
const N = arg('--n', 60), quiet = process.argv.includes('--quiet')

const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const { towns } = planTowns({ ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })
const world = new TalkWorld(SEED, towns)

const SMALL_TALK = new Set(['talk:town', 'nice:work', 'nice:life'])
const flags = []
const tally = {}
const flag = (kind, who, text) => { flags.push(`  ! ${kind}: ${who} -- ${text}`); tally[kind] = (tally[kind] ?? 0) + 1 }

let talk = null
const done = () => { if (talk !== null && !quiet) console.log(`\n--- ${talk.who}\n${talk.lines.join('\n')}`) }
try {
  walkTalks(world, arg('--seed', 1), N, (mind, who, topic, line) => {
    if (topic === null) { done(); talk = { who, lines: [], said: new Map() } }
    talk.lines.push(`  ${topic === null ? '>' : `[${topic}]`} ${line.text}`)
    const rows = captionRows(line.text)
    if (rows > CAPTION.rows) flag('overflow', who, `${rows} rows: ${line.text}`)
    if (topic !== null && !SMALL_TALK.has(topic) && mind.quirk?.kind === 'need') for (const a of quirkLines(mind.quirk).aside) if (line.text.includes(a)) flag('need off small talk', who, `[${topic}] ${line.text}`)
    for (const s of line.text.match(/[^.!?]+[.!?]+/g) ?? []) {
      const k = s.trim()
      if (k.split(' ').length >= 4 && talk.said.has(k) && talk.said.get(k) !== topic) flag('repeat', who, `[${talk.said.get(k)} / ${topic}] ${k}`)
      talk.said.set(k, topic)
    }
  })
} catch (e) {
  flag('throw', '', e.stack.split('\n').slice(0, 3).join(' | '))
}
done()

console.log(`\n${flags.length} flag(s) over ${N} conversations${flags.length ? '\n' + flags.join('\n') : ''}`)
console.log(Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', '))
