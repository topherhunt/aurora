// ---------------------------------------------------------------------------
// DEV FIXTURE ONLY -- not part of the shipped pipeline. Draws a synthetic
// magenta-keyed character sheet (front/side/back, analytic width profiles,
// no actual art) so stages 4-8 of the character pipeline can be built and
// tested before any OpenRouter call happens, per the plan's sequencing.
//
//   node tools/characters/make-placeholder.mjs <outDir>
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { writePng } from '../props/png.mjs'

const W = 400, H = 800
const MAGENTA = [255, 0, 255]

// [v (height fraction, 1 = head top), half-extent as a fraction of image width]
const FRONT_PROFILE = [
  [1.00, 0.00], [0.97, 0.085], [0.90, 0.055], [0.83, 0.155],
  [0.65, 0.115], [0.50, 0.135], [0.28, 0.085], [0.04, 0.065], [0.00, 0.09],
]
const SIDE_PROFILE = [
  [1.00, 0.00], [0.97, 0.075], [0.90, 0.045], [0.83, 0.085],
  [0.65, 0.065], [0.50, 0.075], [0.28, 0.05], [0.04, 0.045], [0.00, 0.07],
]

function halfExtent(profile, v) {
  const pts = [...profile].sort((a, b) => b[0] - a[0])
  for (let i = 0; i < pts.length - 1; i++) {
    const [va, fa] = pts[i], [vb, fb] = pts[i + 1]
    if (v <= va && v >= vb) {
      const t = (va - v) / (va - vb || 1)
      return (fa + (fb - fa) * t) * W
    }
  }
  return 0
}

function drawSheet(profile, bodyColor) {
  const rgba = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = MAGENTA[0]; rgba[i * 4 + 1] = MAGENTA[1]; rgba[i * 4 + 2] = MAGENTA[2]; rgba[i * 4 + 3] = 255
  }
  const top = 40, bottom = H - 40 // margin so the figure doesn't touch the frame edge
  for (let y = top; y <= bottom; y++) {
    const v = 1 - (y - top) / (bottom - top)
    const half = halfExtent(profile, v)
    if (half <= 0) continue
    const cx = W / 2
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      if (x < 0 || x >= W) continue
      const i = (y * W + x) * 4
      rgba[i] = bodyColor[0]; rgba[i + 1] = bodyColor[1]; rgba[i + 2] = bodyColor[2]; rgba[i + 3] = 255
    }
  }
  return rgba
}

const outDir = path.resolve(process.argv[2] || 'tmp/character-placeholder')
fs.mkdirSync(outDir, { recursive: true })
writePng(path.join(outDir, 'front.png'), W, H, drawSheet(FRONT_PROFILE, [210, 160, 130]), 4)
writePng(path.join(outDir, 'side.png'), W, H, drawSheet(SIDE_PROFILE, [200, 150, 120]), 4)
writePng(path.join(outDir, 'back.png'), W, H, drawSheet(FRONT_PROFILE, [190, 140, 110]), 4)
console.log(`-> ${outDir}/{front,side,back}.png`)
