// The leafkin house exterior's two layers (design/36-leafkin-houses.md): ROOF_LEAF, a FLUX Klein photograph (~$0.015 a call) made seamless by tools/tileable.sh, and IVY_LEAF, one leaf drawn here in code. Both ship at the texture array's 128 px.
//
//   node --env-file=.env tools/buildings/leafkin-textures.mjs gen [n]    n roof candidates into tmp/leafkin-tex (default 1)
//   node tools/buildings/leafkin-textures.mjs ship <candidate.png>      tile, resize and ship the roof
//   node tools/buildings/leafkin-textures.mjs ivy                       draw and ship the ivy leaf
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateImage } from '../characters/openrouter.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = join(ROOT, 'tmp/leafkin-tex')
const OUT = join(ROOT, 'public/buildings')

// FLUX paints every noun (design/29-prop-pipeline.md), so the prompt names only the leaves.
const ROOF_PROMPT = 'Flat texture photograph of a roof covered in overlapping dry oak leaves laid in rows like shingles, each leaf overlapping the one below, olive green, ochre and russet brown leaves, visible leaf veins and lobed edges, dull matte surface, soft even light, filling the frame edge to edge.'

const [cmd, arg] = process.argv.slice(2)
mkdirSync(WORK, { recursive: true })
if (cmd === 'gen') {
  const n = Number(arg ?? 1)
  let spent = 0
  for (let k = 0; k < n; k++) {
    const { buffer, cost } = await generateImage({ prompt: ROOF_PROMPT, aspectRatio: '1:1', resolution: '1K' })
    const file = join(WORK, `roof_leaf-${Date.now()}-${k}.png`)
    writeFileSync(file, buffer)
    spent += cost
    console.log(`${file}: $${cost.toFixed(4)}`)
  }
  console.log(`spent $${spent.toFixed(4)}`)
} else if (cmd === 'ship') {
  if (!arg) throw new Error('leafkin-textures: ship needs a candidate png')
  const tiled = join(WORK, 'roof_leaf-tiled.png')
  // The centre half, so a leaf spans ~30 px of the 128 rather than 15.
  const crop = join(WORK, 'roof_leaf-crop.png')
  execFileSync('magick', [arg, '-gravity', 'center', '-crop', '50%x50%+0+0', '+repage', crop])
  execFileSync('bash', [join(ROOT, 'tools/tileable.sh'), 'tile', crop, tiled], { stdio: 'inherit' })
  execFileSync('magick', [tiled, '-resize', '128x128!', '-strip', join(OUT, 'roof_leaf.png')])
  console.log(`shipped ${join(OUT, 'roof_leaf.png')}`)
} else if (cmd === 'ivy') {
  // Five rounded lobes as bumps on a polar outline round the stem's foot, drawn at 4x and shrunk so the alpha edge is antialiased.
  const S = 4, C = [64, 76], deg = Math.PI / 180
  const LOBES = [[90, 1], [22, 0.78], [158, 0.78], [-28, 0.5], [208, 0.5]]
  const at = (a, r) => `${(C[0] + Math.cos(a) * r) * S},${(C[1] - Math.sin(a) * r) * S}`
  const radius = (a) => 22 + 44 * Math.max(...LOBES.map(([c, k]) => { const d = Math.atan2(Math.sin(a - c * deg), Math.cos(a - c * deg)) / 0.42; return k * Math.exp(-d * d) }))
  const outline = Array.from({ length: 90 }, (_, i) => { const a = (i / 90) * 2 * Math.PI; return at(a, radius(a)) })
  const veins = LOBES.flatMap(([c, k]) => ['-draw', `line ${at(0, 0)} ${at(c * deg, radius(c * deg) - 8)}`])
  const file = join(OUT, 'ivy_leaf.png')
  execFileSync('magick', [
    '-size', `${128 * S}x${128 * S}`, 'xc:none',
    '-fill', '#355f26', '-stroke', '#20401a', '-strokewidth', `${3 * S}`, '-draw', `polygon ${outline.join(' ')}`,
    '-fill', 'none', '-stroke', '#86a860', '-strokewidth', `${1.6 * S}`, ...veins,
    '-stroke', '#4a3a22', '-strokewidth', `${3 * S}`, '-draw', `line ${at(0, 0)} ${at(-90 * deg, 50)}`,
    '-resize', '128x128', '-strip', file,
  ])
  console.log(`shipped ${file}`)
} else throw new Error('leafkin-textures: gen [n] | ship <png> | ivy')
