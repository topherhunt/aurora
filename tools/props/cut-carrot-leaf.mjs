// ---------------------------------------------------------------------------
// The carrot's leaf texture: one photographed leaf, cut from a hand-marked
// quad of tmp/carrot-leaf.png and warped to fill a 128px square.
//
//     node tools/props/cut-carrot-leaf.mjs
//
// The corners are marked TIP FIRST and wind clockwise on screen: tip, right,
// stem, left. They go onto the square with the stem in the bottom-left corner
// and the tip in the top-right, so the leaf's axis runs the square's diagonal
// and its two side corners take the other two: that is what "full use of the
// square" means for a diamond-shaped leaf, and src/props/carrot.js builds each
// leaf ribbon on the quad's own outline to undo the warp. The quad in the
// leaf's frame -- stem at the origin, the tip one unit up the Y axis, X across
// to the photograph's right -- is printed for CARROT_LEAF_QUAD there, in the
// texture's own scan order.
//
// The source lives in gitignored tmp/, so public/gen-props/carrot-leaf.png is
// the artifact of record, and this says so rather than skipping.
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from './png.mjs'
import { coverage, warpQuadToSquare } from './warp-quad.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'tmp/carrot-leaf.png')
const OUT = path.join(ROOT, 'public/gen-props/carrot-leaf.png')
const SIZE = 128

const IMAGE = { width: 1024, height: 1376 }
const TIP = [522.35, 135.01]
const RIGHT = [875.59, 520.76]
const STEM = [514.09, 968.09]
const LEFT = [155.45, 536.21]

if (!existsSync(SRC)) {
  throw new Error(`${path.relative(ROOT, SRC)} is missing; tmp/ is gitignored and ${path.relative(ROOT, OUT)} is the artifact of record`)
}
const src = readPng(SRC)
if (src.width !== IMAGE.width || src.height !== IMAGE.height) {
  throw new Error(`${path.relative(ROOT, SRC)} is ${src.width}x${src.height}; the corners were marked on ${IMAGE.width}x${IMAGE.height}`)
}

// Scan order of the destination square: (0,0) left, (1,0) tip, (1,1) right,
// (0,1) stem. y is down in both the image and the file, so a quad that winds
// clockwise on screen keeps the art off its mirror; asserted, since a mirrored
// leaf is not a bug anyone can see.
const corners = [LEFT, TIP, RIGHT, STEM]
let area = 0
for (let i = 0; i < 4; i++) {
  const [ax, ay] = corners[i]
  const [bx, by] = corners[(i + 1) % 4]
  area += ax * by - bx * ay
}
if (area <= 0) throw new Error('the corners wind counterclockwise on screen; the square assumes clockwise')

const px = warpQuadToSquare(src, corners, SIZE)
writePng(OUT, SIZE, SIZE, px, 4)
console.log(`${path.relative(ROOT, OUT)}: quad ${Math.round(area / 2)} px^2, ${(coverage(px) * 100).toFixed(0)}% opaque at alpha 128`)

// The quad in the leaf's own frame, for CARROT_LEAF_QUAD.
const ax = TIP[0] - STEM[0]
const ay = TIP[1] - STEM[1]
const len = Math.hypot(ax, ay)
const yx = ax / len, yy = ay / len
const xx = -yy, xy = yx
const frame = ([px0, py0]) => {
  const dx = px0 - STEM[0], dy = py0 - STEM[1]
  return [+((dx * xx + dy * xy) / len).toFixed(4), +((dx * yx + dy * yy) / len).toFixed(4)]
}
console.log(`CARROT_LEAF_QUAD (left, tip, right, stem; stem at 0, tip at y = 1): ${JSON.stringify(corners.map(frame))}`)
