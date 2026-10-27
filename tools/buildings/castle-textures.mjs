// The castle's stonework tile (design/44-castles.md): a FLUX Klein photograph (~$0.015 a call) made seamless by tools/tileable.sh, shipped at 256 px as webp.
//
//   node --env-file=.env tools/buildings/castle-textures.mjs gen [n]    n candidates into tmp/castle-tex, each with a tiled 2x2 preview
//   node tools/buildings/castle-textures.mjs ship <candidate.png>      tile, resize and ship to public/buildings/castle_stone.webp
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
} else throw new Error('castle-textures: gen [n] | ship <png>')
