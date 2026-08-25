// ---------------------------------------------------------------------------
// Cut the shipped rock tile from the downloaded photograph.
//
//   node tools/props/cut-rock.mjs
//
// Reads tmp/downloaded-to-maybe-use/stone-1.jpg and writes public/rocks/stone.png,
// which IMAGE_LAYERS in src/textures.js patches over the `mottled` generator
// that has stood in for LAYER.ROCK since the spike.
//
// ONE TILE FOR EVERY ROCK IN THE WORLD, and the grade below is what makes that
// affordable rather than monotonous. §9's rule is that a layer has to earn
// itself by reading as DIFFERENT at the distance it will be seen, and a second
// granite would not: basalt, sandstone, riverbed shale and snow-dusted scree
// differ from this one in HUE and VALUE, both of which a per-instance tint
// multiply gives away for nothing (BatchedMesh.setColorAt -- see the tint note
// in src/props/rock.js). What a tint cannot change is GRAIN, and the grain here
// is fine crystalline speckle, which is what every hard rock in a glaciated
// landscape looks like at 128 px.
//
// That is why this grade is unlike the building tiles' grades in two ways:
//
//   IT IS GRADED BRIGHT (target ~150, ceiling 0.86) where the building tiles
//   sit around 100-116. A tint is a MULTIPLY, so whatever the tile's mean is,
//   that is the brightest any tinted instance can ever be. Grading to the
//   granite you want on screen would leave the mossy and the wet-shale tints
//   with nowhere to go but black. The neutral granite tint in gen-rock.html is
//   ~0.78 grey, which is what brings this back down to a rock.
//
//   IT IS DESATURATED HARD (0.62). The photograph has a warm buff cast. Left
//   in, it fights every tint applied over it -- a cold basalt tint over a warm
//   tile gives a muddy neutral rather than cold stone. Throwing most of the
//   source hue away is what makes the tint the thing that decides the hue.
//
// THE ROW CONVENTION is stated in tools/buildings/imageops.mjs: row 0 of a
// shipped PNG is v = 0. It does not bite here -- a rock tile has no direction,
// and rock.js projects UVs per face off whichever axis dominates, so there is
// no "up" in this image to get wrong.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import { decode, seam, healWrap, resample, grade, writeTile } from '../buildings/imageops.mjs'

const SRC = 'tmp/downloaded-to-maybe-use/stone-1.jpg'
const OUT = 'public/rocks'
const WORK = 'tmp/rock-src/work'
const N = 128

// Bright neutral grey -- see the header. Not a colour anyone would call granite;
// it is the canvas every tint in the bench's palette is painted onto.
const TARGET = [150, 148, 145]

// Above this the wrap edge is a visible line rather than one of the many edges
// the tile already contains, and healWrap has to dissolve it. stone-1.jpg is
// sold as seamless, so this is a guard rather than a step -- and the guard is
// worth keeping, because "sold as seamless" and "seamless after a 12x
// downsample" are not the same claim.
const SEAM_LIMIT = 1.0
const HEAL_BAND = 0.1

mkdirSync(OUT, { recursive: true })

let img = decode(SRC, WORK)
console.log(`  source        ${img.w}x${img.h}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)

for (const axis of ['u', 'v']) {
  if (seam(img, axis) > SEAM_LIMIT) {
    img = healWrap(img, axis, HEAL_BAND)
    console.log(`  healed ${axis}      -> ${img.w}x${img.h}  seam ${seam(img, axis).toFixed(2)}`)
  }
}

img = resample(img, N)
img = grade(img, { target: TARGET, spread: 0.5, desaturate: 0.62, ceiling: 0.86 })

writeTile(`${OUT}/stone.png`, img)

// Report what a tint has to work with. `mean` is the ceiling every tinted
// instance is measured down from, and `spread` is the contrast that survives
// the multiply -- a tile graded flat cannot be rescued by any tint at all.
let mean = 0
for (let i = 0; i < N * N; i++) {
  mean += (img.px[i * 3] + img.px[i * 3 + 1] + img.px[i * 3 + 2]) / 3
}
mean /= N * N
let sd = 0
for (let i = 0; i < N * N; i++) {
  const v = (img.px[i * 3] + img.px[i * 3 + 1] + img.px[i * 3 + 2]) / 3
  sd += (v - mean) ** 2
}
sd = Math.sqrt(sd / (N * N))

console.log(`  stone.png     ${N}x${N}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)
console.log(`                mean ${(mean * 255).toFixed(0)}/255, sd ${(sd * 255).toFixed(0)} -- the headroom a tint multiplies into`)
