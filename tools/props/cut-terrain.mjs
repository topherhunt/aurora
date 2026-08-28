// ---------------------------------------------------------------------------
// Cut the two GROUND tiles from downloaded photographs.
//
//   node tools/props/cut-terrain.mjs
//
// Reads tmp/grass.jpg and tmp/snow.jpg, writes public/terrain/grass.png and
// public/terrain/snow.png -- the tiles LAYER.TERRAIN_GRASS and
// LAYER.TERRAIN_SNOW carry, which src/terrain/terrain-material.js lays over the
// meadow and the snowfield at one metre per tile.
//
// WHAT MAKES THESE DIFFERENT FROM EVERY OTHER TILE IN THIS DIRECTORY: they are
// never worn as an albedo. The terrain shader divides each by its own linear
// per-channel mean and MULTIPLIES the palette by the result, exactly as it does
// with stone.png on a cliff -- so what ships is a CONTRAST FIELD that averages
// (1,1,1) and moves neither the value nor the hue the palette was tuned to.
//
// Two consequences for the grade, and they are the whole reason this file is not
// a copy of cut-rock.mjs:
//
//   THE TARGET COLOUR BARELY MATTERS. It is divided back out. It is set to a
//   plausible meadow green and a plausible snow grey anyway, so that opening the
//   PNG shows what the tile is rather than a grey smear, and so the 8-bit
//   quantisation lands where the detail is.
//
//   `spread` IS THE ONLY NUMBER THAT REALLY SHIPS. grade() re-anchors each
//   channel to mean = target and sd = target * spread, so after the divide the
//   field has mean 1 and relative sd = `spread` per channel, exactly. 0.30 on
//   grass is a swing of roughly 0.4x to 1.9x at three sigma, which is the range
//   between a lit blade and the shadow under it. Snow is a smoother surface and
//   takes half of that.
//
//   AND `desaturate` DECIDES HOW MUCH HUE VARIATION SURVIVES. It runs before the
//   per-channel re-anchor, so at 1.0 the three channels become proportional and
//   the field is value-only; at 0 the photograph's full chroma swing is kept and
//   then INDEPENDENTLY re-spread per channel, which exaggerates whichever
//   channel had the least variance to begin with -- on a green photograph that
//   is blue, and the result is a meadow flecked with mauve. Grass keeps a little
//   under half its chroma, which is what makes a dry blade read yellower and a
//   gap between clumps read browner. Snow keeps a third: a drift is not grey,
//   but it is nowhere near as coloured as a photograph of one in flat light.
//
// THE ROW CONVENTION (row 0 is v = 0, see tools/buildings/imageops.mjs) does not
// bite here for the same reason it does not bite on stone: ground seen from
// above has no up.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import { decode, seam, healWrap, resample, grade, writeTile } from '../buildings/imageops.mjs'
import { SRGB_TO_LIN } from '../buildings/imageops.mjs'

const OUT = 'public/terrain'
const WORK = 'tmp/terrain-src/work'
const N = 128

// Above this the wrap edge is a visible line rather than one of the many edges
// the tile already contains. Both sources are sold as seamless, so this is a
// guard rather than a step -- and "seamless" and "seamless after a 16x
// downsample" are not the same claim.
const SEAM_LIMIT = 1.0
const HEAL_BAND = 0.1

const TILES = [
  {
    src: 'tmp/grass.jpg',
    out: 'grass.png',
    // A mid meadow green. Divided back out by the shader; see the header.
    target: [104, 122, 68],
    spread: 0.3,
    desaturate: 0.55,
    ceiling: 0.72,
  },
  {
    src: 'tmp/snow.jpg',
    out: 'snow.png',
    // Deliberately NOT white. The tile is a contrast field, so its level is
    // divided out, and grading a near-white photograph to near-white would put
    // every texel in the top eighth of the 8-bit range where the sRGB curve has
    // its coarsest steps -- the crumple detail would quantise into bands.
    target: [158, 159, 163],
    spread: 0.15,
    desaturate: 0.66,
    ceiling: 0.72,
  },
]

mkdirSync(OUT, { recursive: true })

for (const tile of TILES) {
  let img = decode(tile.src, WORK)
  console.log(`\n${tile.src}`)
  console.log(`  source        ${img.w}x${img.h}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)

  for (const axis of ['u', 'v']) {
    if (seam(img, axis) > SEAM_LIMIT) {
      img = healWrap(img, axis, HEAL_BAND)
      console.log(`  healed ${axis}      -> ${img.w}x${img.h}  seam ${seam(img, axis).toFixed(2)}`)
    }
  }

  img = resample(img, N)
  img = grade(img, { target: tile.target, spread: tile.spread, desaturate: tile.desaturate, ceiling: tile.ceiling })

  writeTile(`${OUT}/${tile.out}`, img)

  // The number that has to be copied into src/textures.js. The shader divides by
  // it, so a stale copy here does not fail -- it quietly darkens or tints every
  // metre of ground in the world. scripts/check-rocks.mjs re-measures it.
  const mean = [0, 0, 0]
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) mean[c] += SRGB_TO_LIN(img.px[i * 3 + c])
  for (let c = 0; c < 3; c++) mean[c] /= N * N

  const sd = [0, 0, 0]
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) sd[c] += (SRGB_TO_LIN(img.px[i * 3 + c]) - mean[c]) ** 2
  for (let c = 0; c < 3; c++) sd[c] = Math.sqrt(sd[c] / (N * N))

  console.log(`  ${tile.out.padEnd(13)} ${N}x${N}  seam u ${seam(img, 'u').toFixed(2)}, v ${seam(img, 'v').toFixed(2)}`)
  console.log(`                linear mean  [${mean.map((v) => v.toFixed(4)).join(', ')}]  <- copy into src/textures.js`)
  console.log(`                field sd     ${sd.map((v, c) => (v / mean[c]).toFixed(3)).join(' ')} relative -- the swing the surface gets`)
}
