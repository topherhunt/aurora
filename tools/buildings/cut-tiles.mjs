// ---------------------------------------------------------------------------
// Cut the shipped building tiles from the downloaded photographs.
//
//   node tools/buildings/cut-tiles.mjs
//
// Reads tmp/building-src/ (see the header of each section for what each source
// is and where it came from) and writes public/buildings/*.png, which
// IMAGE_LAYERS in src/textures.js patches over the generators in
// src/buildings/tiles.js a few frames after start-up.
//
// WHAT THIS FILE IS FOR, since the generators already produce something
// shippable: a generated tile is a description of a material and a photograph
// is a sample of one. At 128 px the description wins on layout -- it knows
// exactly where a course line belongs -- and loses badly on everything that is
// not layout, because real timber and real rubble are irregular in ways nobody
// writes down. So the rule here is HYBRID, not replacement: where a tile's
// layout carries meaning the generator keeps it and the photograph supplies
// only the material (`shade()` multiplies one into the other), and where the
// photograph already HAS the right layout it is used whole.
//
//   TIMBER_BEAM   photo material x generated log-course shading  (new layer)
//   TIMBER_HEWN   photo material x generated board grooves
//   TIMBER_PLANK  photo, cropped to a whole number of boards
//   SHINGLE       photo, flipped so the exposed butts face the eave
//   ROOF_TILE     photo, flipped so the scallops face the eave  (new layer)
//   STONE         photo, with moss composited into its own crevices
//   GLASS         photo, cropped inside the frame
//   DOOR          photo, cropped to the leaf; not tiled, addressed 0..1
//
// THE ROW CONVENTION governs half the decisions here and is stated once, in the
// header of tools/buildings/imageops.mjs: row 0 of a shipped PNG is v = 0.
// Every roof source is photographed the way a roof is looked at, courses
// lapping toward the bottom of the frame, so every roof source is flipped.
// Ship one unflipped and the shakes lap uphill.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import {
  clamp01, smooth, lerp,
  decode, decodeMask, seam, healWrap, resample, resampleMask,
  rotate90, flipV, crop, grade, shade, writeTile,
} from './imageops.mjs'

const SRC = 'tmp/building-src'
const OUT = 'public/buildings'
const WORK = `${SRC}/work`
const N = 128

mkdirSync(OUT, { recursive: true })

// The palette these have to land on. Copied from the `P` table in
// src/buildings/tiles.js rather than imported, because that file is browser
// code and pulling it into a build tool to read six constants would drag the
// whole tile generator along with it. If the palette moves, move these.
const TARGET = {
  beam: [100, 90, 74], // weathered raw timber, greyer than the sawn face
  log: [104, 84, 62],
  plank: [96, 83, 70],
  shake: [96, 84, 74],
  stone: [116, 113, 105],
  moss: [76, 92, 54],
  pantile: [110, 58, 46],
  door: [116, 98, 76],
  glass: [150, 162, 174],
}

/** Report a tile's two seam scores, so a regression shows up in the log rather
 *  than only in the gate. Same metric scripts/check-buildings.mjs applies. */
function report(name, img, axes = 'uv') {
  const s = [...axes].map((a) => `${a} ${seam(img, a).toFixed(2)}`).join(', ')
  console.log(`  ${name.padEnd(14)} ${img.w}x${img.h}  seam ${s}`)
}

// Tileable value noise, period exactly 1 in both axes -- so it is only ever
// sampled as f(u, v) and the tile it modulates still wraps. Two octaves is all
// the patchiness the moss needs.
function noise(seed, gx, gy) {
  const h = (a, b) => {
    let x = Math.imul(((a % gx) + gx) % gx + 374761393, 1274126177)
    x ^= Math.imul(((b % gy) + gy) % gy + seed * 668265263, 2246822519)
    x = Math.imul(x ^ (x >>> 13), 1103515245)
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296
  }
  return (u, v) => {
    const fx = u * gx
    const fy = v * gy
    const i = Math.floor(fx)
    const j = Math.floor(fy)
    const tx = smooth(fx - i)
    const ty = smooth(fy - j)
    return lerp(
      lerp(h(i, j), h(i + 1, j), tx),
      lerp(h(i, j + 1), h(i + 1, j + 1), tx),
      ty
    )
  }
}

console.log('cutting building tiles')

// --- TIMBER_BEAM ------------------------------------------------------------
//
// Source: wood-beam.jpeg, a straight-on 1627x1699 photograph of one weathered
// baulk -- silvered surface, open checks, a black split running most of its
// length. It is the tile every RAW member wears: the log courses of a cabin
// wall, the log ends poking past the corner, posts, rails, jambs.
//
// ROTATED, because the beam was shot standing up: its grain runs down the frame
// and a log course needs it running ALONG the course, which is u. That same
// rotation is what lets one tile serve a standing post too -- prism() swaps u
// and v for a member whose grain follows its own axis, so the grain ends up
// along the post and the course shading below ends up wrapped around it, which
// is exactly where a round log wants both.
//
// The generated two-course cylinder shading is then multiplied back in, because
// that shading is the entire reason a flat tile reads as stacked round logs
// (see tileLogs) and no photograph of one beam can supply it.
{
  let img = rotate90(decode(`${SRC}/wood-beam.jpeg`, WORK))
  img = healWrap(img, 'u', 0.1)
  img = healWrap(img, 'v', 0.1)
  img = resample(img, N)
  img = grade(img, { target: TARGET.beam, spread: 0.44, desaturate: 0.3, ceiling: 0.74 })

  // Two courses per tile, matching TILE_METRES[TIMBER_BEAM] = 0.84.
  img = shade(img, (u, v) => {
    const f = v * 2 - Math.floor(v * 2)
    const belly = Math.sin(Math.PI * f) // lit along the log's belly
    const chink = smooth(clamp01(Math.min(f, 1 - f) / 0.09)) // dark where two meet
    return (0.5 + 0.6 * belly) * lerp(0.3, 1, chink)
  }, 0.9)

  writeTile(`${OUT}/timber_beam.png`, img)
  report('timber_beam', img)
}

// --- TIMBER_HEWN ------------------------------------------------------------
//
// Source: the basecolor of wood_beam_v2.glb, unpacked to beam_0.jpg. It is a
// UV atlas, not a tile -- the top two thirds are the beam's four long faces
// and the bottom third is its ends and chamfers -- so the clean region is cut
// out by hand and everything below y = 700 is dropped.
//
// This USED to be the log tile and is now rough-sawn boarding: porch decks,
// the soffit under an eave, wide planking that is cut but not planed. The
// source did not change; what changed is that wood-beam.jpeg is a better log
// than a squared beam is, and that one tile serving both logs and boards was
// serving neither. So the same crop gets board grooves instead of a cylinder
// belly, three per tile against TIMBER_PLANK's three at a smaller pitch -- a
// 0.3 m rough board beside a 0.24 m sawn one, which is the difference a saw
// mill makes and is legible at the scale a porch is walked onto.
{
  const raw = crop(decode(`${SRC}/beam_0.jpg`, WORK), 24, 16, 760, 680)
  let img = rotate90(raw)
  img = healWrap(img, 'u', 0.1)
  img = healWrap(img, 'v', 0.1)
  img = resample(img, N)
  img = grade(img, { target: TARGET.log, spread: 0.42, desaturate: 0.34, ceiling: 0.72 })

  // Three boards per tile, matching TILE_METRES[TIMBER_HEWN] = 0.9. Boards run
  // along u, so the grooves are lines of constant v.
  img = shade(img, (u, v) => {
    const f = v * 3 - Math.floor(v * 3)
    const groove = smooth(clamp01(Math.min(f, 1 - f) / 0.055))
    return lerp(0.34, 1, groove)
  }, 0.85)

  writeTile(`${OUT}/timber_hewn.png`, img)
  report('timber_hewn', img)
}

// --- TIMBER_PLANK -----------------------------------------------------------
//
// Source: wood-planks.png, a straight-on photograph of four weathered vertical
// boards. Cropped groove-to-groove -- the dark columns sit at x = 47, 146, 250
// and 352, so [47, 352) is exactly three boards -- and then healed by a band
// just wide enough to fuse the leading groove into the trailing one. Crop
// anywhere else and the wrap either doubles a groove or splits a board.
{
  let img = crop(decode(`${SRC}/wood-planks.png`, WORK), 47, 0, 305, 418)
  img = healWrap(img, 'u', 8 / 305)
  img = healWrap(img, 'v', 0.12)
  img = resample(img, N)
  img = grade(img, { target: TARGET.plank, spread: 0.4, desaturate: 0.28, ceiling: 0.72 })
  writeTile(`${OUT}/timber_plank.png`, img)
  report('timber_plank', img)
}

// --- SHINGLE ----------------------------------------------------------------
//
// Source: WoodenShingles_basecolor.png, already seamless at 2048. Only two
// things to do: flip it (the bright exposed butts are at the bottom of the
// frame and belong at v = 0, the eave -- see tileShingles, which shades
// `lerp(0.55, 1.12, ...)` brightest at the low end of each course), and grade
// it down to leave headroom, because TINT.slate multiplies this same layer by
// 0.52 and a tile that ships bright has nowhere to go.
{
  let img = flipV(decode(`${SRC}/WoodenShingles_basecolor.png`, WORK))
  img = resample(img, N)
  img = grade(img, { target: TARGET.shake, spread: 0.46, desaturate: 0.3, ceiling: 0.72 })
  writeTile(`${OUT}/shingle.png`, img)
  report('shingle', img)
}

// --- ROOF_TILE --------------------------------------------------------------
//
// Source: RoundCompositeRoof_basecolor.jpg, seamless at 2048. A NEW layer
// rather than a tint of SHINGLE, which is the opposite of the call made for
// slate -- and for the reason textures.js gives: slate differs from a shake in
// hue and value only, but a scalloped pantile differs in SHAPE, and shape is
// what survives at 128 px from fifteen metres. Flipped for the same reason the
// shakes are: the scallops have to hang toward the eave.
//
// Desaturated far less than the timber. The red IS the material here; grade
// this to the same 0.3 as everything else and it comes out as brown roofing
// felt.
{
  let img = flipV(decode(`${SRC}/RoundCompositeRoof_basecolor.jpg`, WORK))
  img = resample(img, N)
  img = grade(img, { target: TARGET.pantile, spread: 0.3, desaturate: 0.26, ceiling: 0.72 })
  writeTile(`${OUT}/roof_tile.png`, img)
  report('roof_tile', img)
}

// --- STONE ------------------------------------------------------------------
//
// Source: Masonry_basecolor.jpg, seamless at 2048, with moss.png composited
// into the joints. This is the one place the moss photograph can be used at
// all: §9 rules out a moss LAYER, because a second blended pass over a surface
// splits the batch, so the only moss this renderer can afford is moss that is
// already baked into another material's texels.
//
// WHERE it goes is not a decision -- the pack ships the answer. Moss grows
// where water sits, water sits in the crevices, and the crevices are exactly
// what the height and ambient-occlusion maps mark. Both are used: height alone
// puts moss on any low stone, AO alone puts it in any shadow, and the product
// is specifically "low AND enclosed", which is a joint. A low-frequency patch
// field on top of that, because a wall with moss in every joint and nowhere
// else reads as a diagram of a wall.
{
  let img = resample(decode(`${SRC}/Masonry_basecolor.jpg`, WORK), N)
  img = grade(img, { target: TARGET.stone, spread: 0.44, desaturate: 0.38, ceiling: 0.74 })

  let mossImg = decode(`${SRC}/moss.png`, WORK)
  mossImg = healWrap(mossImg, 'u', 0.12)
  mossImg = healWrap(mossImg, 'v', 0.12)
  mossImg = resample(mossImg, N)
  mossImg = grade(mossImg, { target: TARGET.moss, spread: 0.4, desaturate: 0.12, ceiling: 0.6 })

  const height = resampleMask(decodeMask(`${SRC}/Masonry_height.jpg`, WORK), N)
  const ao = resampleMask(decodeMask(`${SRC}/Masonry_ambientOcclusion.jpg`, WORK), N)
  // Normalise each map against its own range: these are 8-bit scans and neither
  // one uses the full 0..1, so a fixed threshold would be a guess about this
  // particular file rather than a statement about crevices.
  const norm = (m) => {
    let lo = 1
    let hi = 0
    for (const v of m.m ?? m) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return (v) => clamp01((v - lo) / Math.max(1e-6, hi - lo))
  }
  const nh = norm(height.m)
  const na = norm(ao.m)
  const patch = noise(3, 4, 4)

  // The raw crevice mask is one texel wide, because a mortar joint at 128 px
  // IS one texel wide -- used directly it draws a green pen line round every
  // stone. Blurring it is not softening for its own sake: real moss starts in
  // the joint and creeps out onto the stone above it, so the blur is what makes
  // this read as growth rather than as an outline.
  let crev = new Float64Array(N * N)
  for (let i = 0; i < N * N; i++) {
    const deep = smooth(clamp01((0.62 - nh(height.m[i])) / 0.42))
    const dark = smooth(clamp01((0.72 - na(ao.m[i])) / 0.5))
    crev[i] = deep * dark
  }
  for (let pass = 0; pass < 3; pass++) {
    const next = new Float64Array(N * N)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            s += crev[(((y + j) % N) + N) % N * N + ((((x + i) % N) + N) % N)]
          }
        }
        next[y * N + x] = s / 9
      }
    }
    crev = next
  }

  let covered = 0
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      const p = smooth(clamp01((patch((x + 0.5) / N, (y + 0.5) / N) - 0.22) / 0.45))
      const t = clamp01(crev[i] * 4.5) * p * 0.85
      if (t > 0.25) covered++
      for (let c = 0; c < 3; c++) {
        img.px[i * 3 + c] = lerp(img.px[i * 3 + c], mossImg.px[i * 3 + c], t)
      }
    }
  }
  writeTile(`${OUT}/stone.png`, img)
  report('stone', img)
  console.log(`  ${''.padEnd(14)} moss over ${((covered / (N * N)) * 100).toFixed(1)}% of the tile`)
}

// --- GLASS ------------------------------------------------------------------
//
// Source: glass-2.jpg, and it is 54x65, which is the smallest thing in the kit
// by an order of magnitude. It upscales, and it is still worth having: what a
// leaded window has to say from three metres is "two diamond quarries across,
// each one a different thickness of glass", and this says that where a smooth
// generated lattice does not.
//
// Cropped inside the frame -- the photograph includes the timber surround,
// which parts.js draws as geometry and must not also draw as texels.
{
  let img = crop(decode(`${SRC}/glass-2.jpg`, WORK), 3, 2, 48, 61)
  img = healWrap(img, 'u', 0.14)
  img = healWrap(img, 'v', 0.14)
  img = resample(img, N)
  // Barely desaturated and a high ceiling: TINT.glass is [1, 1, 1], so this
  // layer never gets multiplied down, and a window is supposed to be the
  // brightest thing on a wall.
  img = grade(img, { target: TARGET.glass, spread: 0.4, desaturate: 0.16, ceiling: 0.92 })
  writeTile(`${OUT}/glass.png`, img)
  report('glass', img)
}

// --- DOOR -------------------------------------------------------------------
//
// Source: medieval-door.png, cropped to the leaf. NOT healed and NOT tiled --
// this is a decal-style layer addressed 0..1 by island, like IRON and RUNE, so
// it is absent from TILE_METRES and no seam applies to it.
//
// The crop stops below the arch springing: the photograph's door is round
// headed and sits in a stone surround, and doorway() draws a rectangular leaf
// in a timber one. Taking only the rectangular part of the leaf is the whole
// trick, and it is why the two hinge straps and the ring pull come free -- they
// are inside the crop, painted on, which is twelve triangles of decal that
// doorway() no longer has to emit.
//
// Flipped, for the row convention: quad()'s island mapping puts v0 at the
// quad's first two corners, which are the BOTTOM of the leaf.
{
  let img = crop(decode(`${SRC}/medieval-door.png`, WORK), 47, 130, 316, 566)
  img = flipV(img)
  img = resample(img, N)
  img = grade(img, { target: TARGET.door, spread: 0.44, desaturate: 0.2, ceiling: 0.86 })
  writeTile(`${OUT}/door.png`, img)
  console.log(`  ${'door'.padEnd(14)} ${img.w}x${img.h}  (island, no seam)`)
}

console.log('done')
