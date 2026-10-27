// Cut the stipple terrain's two photographed tiles (terrain-material.js COBBLES
// and FOREST FLOOR) to their shipped size:   node tools/props/cut-ground-tiles.mjs
//
// Sources are gitignored bakes: tmp/cobble/cobble.png is the seamless road photo
// with its 0..1 stone mask in alpha, shipped as 0.5 + 0.5 * mask so the browser's
// premultiply cannot wipe the dirt's colour; tmp/forest/a-tiled.png is the
// seamless forest-floor photo (tools/tileable.sh). Prints each tile's linear
// mean, which the shader divides out and which must be copied into
// terrain-material.js. Needs ImageMagick 7 (`magick`).

import { execFileSync } from 'node:child_process'

const N = 256
const TILES = [
  { src: 'tmp/cobble/cobble.png', out: 'public/terrain/cobble.webp', alpha: true, name: 'COBBLE_MEAN' },
  { src: 'tmp/forest/a-tiled.png', out: 'public/terrain/forest.webp', alpha: false, name: 'FOREST_MEAN' },
]

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

for (const t of TILES) {
  // Colour and mask are resized apart: a resize of RGBA weights colour by alpha,
  // which here means by stone, and drifts the mean toward the stones' grey.
  const size = ['-filter', 'Lanczos', '-resize', `${N}x${N}!`]
  const colour = ['(', t.src, '-alpha', 'off', ...size, ')']
  const args = t.alpha
    ? [...colour, '(', t.src, '-alpha', 'extract', ...size, '-function', 'polynomial', '0.5,0.5', ')', '-compose', 'CopyOpacity', '-composite',
        '-define', 'webp:exact=true', '-define', 'webp:alpha-quality=100']
    : colour
  execFileSync('magick', [...args, '-strip', '-quality', '90', t.out])
  const px = execFileSync('magick', [t.out, '-depth', '8', 'rgba:-'])
  if (px.length !== N * N * 4) throw new Error(`${t.out}: expected ${N}x${N} RGBA, got ${px.length} bytes`)
  const mean = [0, 0, 0]
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) mean[c] += lin(px[i * 4 + c] / 255)
  console.log(`${t.out}  ${N}x${N}  ${t.name} = [${mean.map((v) => (v / (N * N)).toFixed(3)).join(', ')}]`)
}
