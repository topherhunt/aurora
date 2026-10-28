// The castle's stonework tile and gate leaves (design/44-castles.md): FLUX Klein photographs (~$0.015 a call). The stone is made
// seamless by tools/tileable.sh and shipped at 256 px as webp; the gate is cropped to the doors and shipped at 128 px, opaque.
//
//   node --env-file=.env tools/buildings/castle-textures.mjs gen [n]    n stone candidates into tmp/castle-tex, each with a tiled 2x2 preview
//   node tools/buildings/castle-textures.mjs ship <candidate.png>      tile, resize and ship to public/buildings/castle_stone.webp
//   node --env-file=.env tools/buildings/castle-textures.mjs gen-gate [n]
//   node tools/buildings/castle-textures.mjs ship-gate <candidate.png> [WxH+X+Y]   crop to the doors' bounding box, ship castle_gate.png
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateImage } from '../characters/openrouter.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = join(ROOT, 'tmp/castle-tex')
const OUT = join(ROOT, 'public/buildings')

// FLUX paints every noun (design/29-prop-pipeline.md), so the prompts name only the masonry.
const PROMPTS = [
  'Flat frontal texture photograph of an old medieval castle wall of rough grey limestone blocks in uneven courses, weathered chipped edges, crumbling lime mortar joints, dark grime streaks and patches of lichen, gritty pitted stone surface, overcast even light, filling the frame edge to edge.',
  'Flat frontal texture photograph of ancient rubble masonry, irregular rough-hewn grey and brown fieldstones packed tightly with deep weathered mortar, grimy and worn, small chips and cracks, overcast even light, filling the frame edge to edge.',
]
const GATE = 'Flat frontal photograph of a pair of tall closed medieval oak castle gate doors with a semicircular arched top, vertical dark weathered planks, heavy black iron strap hinges and rows of iron studs, two iron ring pulls meeting at the centre seam, the doors filling the frame edge to edge, overcast even light.'

const [cmd, arg] = process.argv.slice(2)
mkdirSync(WORK, { recursive: true })
if (cmd === 'gen') {
  const n = Number(arg ?? 1)
  let spent = 0
  for (let k = 0; k < n; k++) {
    const { buffer, cost } = await generateImage({ prompt: PROMPTS[k % PROMPTS.length], aspectRatio: '1:1', resolution: '1K' })
    const file = join(WORK, `stone-${Date.now()}-${k}.png`)
    writeFileSync(file, buffer)
    const tiled = file.replace('.png', '-tiled.png')
    execFileSync('bash', [join(ROOT, 'tools/tileable.sh'), 'tile', file, tiled], { stdio: 'inherit' })
    execFileSync('magick', [tiled, '-resize', '512x512', '(', '+clone', ')', '+append', '(', '+clone', ')', '-append', file.replace('.png', '-preview.png')])
    spent += cost
    console.log(`${file}: $${cost.toFixed(4)}`)
  }
  console.log(`spent $${spent.toFixed(4)}`)
} else if (cmd === 'ship') {
  if (!arg) throw new Error('castle-textures: ship needs a candidate png')
  const tiled = join(WORK, 'castle_stone-tiled.png')
  execFileSync('bash', [join(ROOT, 'tools/tileable.sh'), 'tile', arg, tiled], { stdio: 'inherit' })
  mkdirSync(OUT, { recursive: true })
  execFileSync('magick', [tiled, '-resize', '256x256!', '-strip', '-quality', '88', join(OUT, 'castle_stone.webp')])
  console.log(`shipped ${join(OUT, 'castle_stone.webp')}`)
} else if (cmd === 'gen-gate') {
  let spent = 0
  for (let k = 0; k < Number(arg ?? 1); k++) {
    const { buffer, cost } = await generateImage({ prompt: GATE, aspectRatio: '3:4', resolution: '1K' })
    const file = join(WORK, `gate-${Date.now()}-${k}.png`)
    writeFileSync(file, buffer)
    spent += cost
    console.log(`${file}: $${cost.toFixed(4)}`)
  }
  console.log(`spent $${spent.toFixed(4)}`)
} else if (cmd === 'ship-gate') {
  if (!arg) throw new Error('castle-textures: ship-gate needs a candidate png')
  const crop = process.argv[4]
  execFileSync('magick', [arg, ...(crop ? ['-crop', crop, '+repage'] : []), '-alpha', 'off', '-resize', '128x128!', '-strip', join(OUT, 'castle_gate.png')])
  console.log(`shipped ${join(OUT, 'castle_gate.png')}`)
} else throw new Error('castle-textures: gen [n] | ship <png> | gen-gate [n] | ship-gate <png> [crop]')
