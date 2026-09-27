// The leafkin house interiors' textures (design/30-leafkin.md, Interiors): one
// FLUX Klein image each, kept at full size in tmp/interiors/tex and shipped to
// public/interiors/<id>.webp at 128 px, run through tools/tileable.sh first
// where the texture repeats. Each call costs about $0.015.
//
//   node --env-file=.env tools/interiors/gen-textures.mjs [id ...]   generate (all by default) and ship
//   node tools/interiors/gen-textures.mjs --ship     re-ship what tmp/ already holds
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateImage } from '../characters/openrouter.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = join(ROOT, 'tmp/interiors/tex')
const OUT = join(ROOT, 'public/interiors')
export const PX = 128

// FLUX is literal (design/29-prop-pipeline.md): every noun is painted, so each prompt names only what is in the picture.
export const TEXTURES = {
  floor: { prep: ['-gravity', 'center', '-crop', '60%x60%+0+0', '+repage'], prompt: 'Top-down photograph of the worn flat cross-section of a huge old tree trunk, concentric growth rings centred in the frame and filling it edge to edge, dark aged brown wood darkened by years of use, fine radial cracks, dull matte surface, soft even light.' },
  wall: { tile: 'mirror', prompt: 'Flat texture photograph of old weathered hand-carved wood grain, long vertical fibres, dark grey-brown aged heartwood with darker stains, shallow gouge marks and fine cracks, dull matte surface, soft even light, filling the frame.' },
  window: { prep: ['-gravity', 'center', '-crop', '85%x85%+0+0', '+repage'], prompt: 'Flat front view of a honeycomb lattice of dark carved wood holding small hexagonal panes of amber glass, warm golden light glowing through the glass, filling the frame.' },
  door: { prep: ['-fuzz', '12%', '-trim', '+repage'], prompt: 'Front view of a round wooden hobbit door filling the square frame, rounded vertical oak planks, a round iron ring handle at the centre, dark iron hinge straps, a carved wooden rim around the circle, soft even light.' },
  grain: { tile: 'mirror', prompt: 'Flat texture photograph of an old worn wooden plank, fine straight grain lines, weathered muted grey-brown colour, scuffs and small dark knots, dull matte surface, soft even light, filling the frame.' },
  pot: { tile: true, prompt: 'Flat texture photograph of dark brown earthenware clay with a hand-incised repeating pattern of zigzag bands and rows of dots, matte, soft even light, filling the frame.' },
  soil: { tile: true, prompt: 'Top-down texture photograph of dark brown moist potting soil with small pale speckles of grit and bark crumbs, soft even light, filling the frame.' },
  linen: { tile: true, prompt: 'Flat texture photograph of coarse woven linen cloth, pale cream threads, visible basket weave, soft even light, filling the frame.' },
}

function ship(id) {
  const src = join(WORK, `${id}.png`)
  if (!existsSync(src)) throw new Error(`gen-textures: no ${src} to ship`)
  const { tile, prep = [] } = TEXTURES[id]
  let from = src
  if (tile === true) {
    from = join(WORK, `${id}-tiled.png`)
    execFileSync('bash', [join(ROOT, 'tools/tileable.sh'), 'tile', src, from], { stdio: 'inherit' })
  }
  // Bookmatched: the image beside its mirror and over its flip, which wraps exactly and reads as wood.
  const mirror = tile === 'mirror' ? ['(', '+clone', '-flop', ')', '+append', '(', '+clone', '-flip', ')', '-append'] : []
  mkdirSync(OUT, { recursive: true })
  const out = join(OUT, `${id}.webp`)
  execFileSync('magick', [from, ...prep, ...mirror, '-resize', `${PX}x${PX}!`, '-quality', '88', out])
  console.log(`shipped ${out}`)
}

const args = process.argv.slice(2)
const shipOnly = args.includes('--ship')
const ids = args.filter((a) => !a.startsWith('--'))
for (const id of ids) if (!TEXTURES[id]) throw new Error(`gen-textures: no texture ${id}; one of ${Object.keys(TEXTURES).join(', ')}`)
mkdirSync(WORK, { recursive: true })
let spent = 0
for (const id of ids.length > 0 ? ids : Object.keys(TEXTURES)) {
  if (!shipOnly) {
    const { buffer, cost } = await generateImage({ prompt: TEXTURES[id].prompt, aspectRatio: '1:1', resolution: '1K' })
    writeFileSync(join(WORK, `${id}.png`), buffer)
    spent += cost
    console.log(`${id}: $${cost.toFixed(4)}`)
  }
  ship(id)
}
if (!shipOnly) console.log(`spent $${spent.toFixed(4)}`)
