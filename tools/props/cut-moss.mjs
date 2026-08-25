// ---------------------------------------------------------------------------
// Cut the shipped moss tile from the downloaded photograph.
//
//   node tools/props/cut-moss.mjs
//
// Reads tmp/downloaded-to-maybe-use/moss.png and writes public/rocks/moss.png,
// which IMAGE_LAYERS in src/textures.js loads into LAYER.MOSS.
//
// THE GRADE IS THE OPPOSITE OF cut-rock.mjs's, and the reason is worth stating
// because the two files sit next to each other and look like they should agree.
// stone.png is graded BRIGHT and NEAR-NEUTRAL because every rock in the world
// wears it under a per-instance tint, and a tint is a multiply: the tile's mean
// is the ceiling, and any hue left in it fights the tint. Moss is not tinted by
// anything. material.js lays it over the rock's ALREADY-TINTED diffuse (see
// MOSS_APPLY), so what is graded here is what ends up on screen -- moss on a
// basalt boulder and moss on a sandstone one should be the same green, because
// in a landscape it is.
//
// So this grade has to land the final value, and the source makes that a real
// move: the photograph means 46/45/21, which is nearly black. Left alone it
// would read as a dark stain rather than as a plant, and at night -- where
// check-daynight.mjs has gully rock at 16 -- it would be pure black. Graded to
// TARGET below it sits a little under the tinted granite it grows on, which is
// where moss actually sits: darker than the rock in sun, and the first thing to
// disappear at dusk.
//
// It is also graded much less desaturated than the stone. The green IS the
// information here -- it is the entire reason the layer earns its slot under
// §9's rule -- where the stone's buff cast was noise to be thrown away.
//
// THE ROW CONVENTION is stated in tools/buildings/imageops.mjs: row 0 of a
// shipped PNG is v = 0. It does not bite here, for the same reason it does not
// bite for stone: moss has no up, and it is sampled through the same per-face
// dominant-axis projection the rock's own tile uses.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import { decode, crop, seam, healWrap, resample, grade, writeTile } from '../buildings/imageops.mjs'

const SRC = 'tmp/downloaded-to-maybe-use/moss.png'
const OUT = 'public/rocks'
const WORK = 'tmp/moss-src/work'
const N = 128

// A cool, slightly yellow-shifted green -- forest moss rather than lawn. The
// blue channel is held well down because the thing that makes a green read as
// living rather than as painted plastic is how little blue is in it.
//
// The level, ~93 luma, is chosen against the neighbour it will be seen with: the
// bench's neutral granite tint (~0.78) through stone.png's mean of 142 lands
// around 111, so this is about 0.84 of the rock it grows on.
const TARGET = [78, 100, 52]

// A wider spread than the stone's 0.5, and a low ceiling. Moss at 128 px is
// almost entirely texture -- clumps and shadow between them -- and that texture
// is what has to survive, but it must not throw specular-looking highlights,
// because moss is the least shiny thing in the landscape.
const SPREAD = 0.62
const CEILING = 0.42

// A third rather than the stone's 0.62. See the header: the hue is the payload.
const DESATURATE = 0.33

// Same guard as cut-rock.mjs, and here it is a real step rather than a guard --
// this photograph is a crop of a larger picture and does not tile at all.
const SEAM_LIMIT = 1.0
const HEAL_BAND = 0.12

mkdirSync(OUT, { recursive: true })

let img = decode(SRC, WORK)
console.log(`  source        ${img.w}x${img.h}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)

// Square first. resample() squashes whatever it is given into n x n, so feeding
// it 302x284 would stretch the clumps 6% along u -- invisible on its own, and
// exactly the kind of thing that reads as "off" when it is repeated across a
// boulder next to an unstretched tile.
const side = Math.min(img.w, img.h)
img = crop(img, Math.round((img.w - side) / 2), Math.round((img.h - side) / 2), side, side)

for (const axis of ['u', 'v']) {
  if (seam(img, axis) > SEAM_LIMIT) {
    img = healWrap(img, axis, HEAL_BAND)
    console.log(`  healed ${axis}      -> ${img.w}x${img.h}  seam ${seam(img, axis).toFixed(2)}`)
  }
}

img = resample(img, N)
img = grade(img, { target: TARGET, spread: SPREAD, desaturate: DESATURATE, ceiling: CEILING })

writeTile(`${OUT}/moss.png`, img)

// Report what actually shipped. Unlike the stone's report these are not headroom
// figures, they are the pixels: nothing multiplies this tile before it is lit.
let mean = [0, 0, 0]
for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) mean[c] += img.px[i * 3 + c]
mean = mean.map((v) => v / (N * N))
const luma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2]
let sat = 0
for (let i = 0; i < N * N; i++) {
  const r = img.px[i * 3], g = img.px[i * 3 + 1], b = img.px[i * 3 + 2]
  const hi = Math.max(r, g, b)
  sat += hi > 0 ? (hi - Math.min(r, g, b)) / hi : 0
}
sat /= N * N

console.log(`  moss.png      ${N}x${N}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)
console.log(`                mean ${mean.map((v) => (v * 255).toFixed(0)).join('/')}, luma ${(luma * 255).toFixed(0)}/255, saturation ${sat.toFixed(2)}`)
