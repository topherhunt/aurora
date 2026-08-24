// ---------------------------------------------------------------------------
// The texture layers the PROCEDURAL trees wear (src/props/tree.js, /gen-tree).
//
//     node tools/trees/gen-layers.mjs
//
// Not to be confused with `layers.py`, which builds layers for the EZ-Tree
// GENERATED props -- those carry the bark and the leaf in one image, in the
// PATCH_V layout, because a generated tree's trunk and canopy share a material
// and a UV set. The procedural trees do not: `tree.js` puts a per-VERTEX
// `texLayer` on the mesh, so the trunk samples a bark layer and the spray cards
// sample a leaf layer, and each of those wants the whole 128x128 square.
//
// SOURCES. EZ-Tree (MIT, Daniel Greenheck), which is already a build-time
// dependency for `generate.mjs`. Its bark maps credit texturecan.com and
// polyhaven in a sibling README; its leaf atlases carry no attribution. See the
// provenance note at the top of `layers.py` -- the decision on record is to use
// them and settle attribution later.
//
// WHY sips FOR THE BARK. The leaf atlases are palette PNGs and `png.mjs` reads
// those now. The bark maps are JPEG, and there is no JPEG decoder in this repo
// or in any dependency of it. `sips` ships with macOS, is used only to get from
// JPEG to a full-resolution PNG, and every pixel decision below is still made
// here.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from '../props/png.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EZ = path.join(ROOT, 'node_modules/@dgreenheck/ez-tree/src/lib/assets')
const OUT = path.join(ROOT, 'public/trees')
const SIZE = 128 // TEX_SIZE in src/textures.js -- every layer of the array must match

// Which EZ-Tree art each species wears. Birch takes the ash atlas: EZ-Tree has
// no birch leaf, and of the four it ships, ash's small paired leaflets read
// closer to a birch twig at 128 px than oak's lobes or aspen's coins do.
const LEAVES = ['oak', 'ash', 'aspen', 'pine']
const BARK = ['oak', 'birch', 'pine']

const ALPHA = 128 // the alphaTest the props material uses; the cutout is judged at this

// --- resampling -------------------------------------------------------------

// Box filter, and PREMULTIPLIED across the alpha channel. Averaging straight
// RGBA would mix the colour of fully transparent texels into the edge -- and in
// these atlases those texels are black, so every leaf would come back with a
// dark rim that gets worse the further we downsample. 1024 -> 128 is an 8x8 box,
// so an edge texel is mostly transparent neighbours: this is not a subtlety.
function resample(src, sw, sh, x0, y0, cw, ch, dw, dh) {
  const out = new Uint8Array(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = y0 + (dy * ch) / dh
    const sy1 = y0 + ((dy + 1) * ch) / dh
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = x0 + (dx * cw) / dw
      const sx1 = x0 + ((dx + 1) * cw) / dw

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
        if (sy < 0 || sy >= sh) continue
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
          if (sx < 0 || sx >= sw) continue
          const i = (sy * sw + sx) * 4
          const av = src[i + 3] / 255
          r += src[i] * av
          g += src[i + 1] * av
          b += src[i + 2] * av
          a += src[i + 3]
          n++
        }
      }
      if (!n) throw new Error(`resample: empty box at ${dx},${dy}`)

      const o = (dy * dw + dx) * 4
      const am = a / n / 255
      // Un-premultiply. Where the box was entirely transparent there is no
      // colour to recover, so leave it black -- nothing samples it above the
      // alpha test.
      if (am > 0) {
        out[o] = Math.min(255, Math.round(r / n / am))
        out[o + 1] = Math.min(255, Math.round(g / n / am))
        out[o + 2] = Math.min(255, Math.round(b / n / am))
      }
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

// The tight box of everything the alpha test will keep. Cropping to it and then
// filling the square is the difference between a leaf that uses 128x128 texels
// and one that uses the third of them the artist happened to draw in.
function alphaBounds(px, w, h) {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] < ALPHA) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('alphaBounds: nothing survives the alpha test')
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function coverage(px) {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] >= ALPHA) n++
  return n / (px.length / 4)
}

// --- the two jobs -----------------------------------------------------------

const aspects = {}

function buildLeaf(name) {
  const src = readPng(path.join(EZ, 'leaves', `${name}_color.png`))
  const box = alphaBounds(src.data, src.width, src.height)

  // Stretched to fill the square, NOT letterboxed, and the aspect is handed
  // back so the card in tree.js can be built at the art's real proportions and
  // un-stretch it. Letterboxing would spend up to half the texels on nothing.
  const px = resample(src.data, src.width, src.height, box.x0, box.y0, box.w, box.h, SIZE, SIZE)

  // Row 0 of the file is the TOP of the image, and `decodeLayer` in
  // textures.js writes file rows straight into the array with no flip, so file
  // row 0 lands at v = 0. tree.js attaches its cards at v = 0, and in all four
  // atlases the stem end is at the BOTTOM of the image -- so flip.
  const flipped = new Uint8Array(px.length)
  for (let y = 0; y < SIZE; y++) {
    flipped.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4)
  }

  const file = path.join(OUT, `leaf_${name}.png`)
  writePng(file, SIZE, SIZE, flipped, 4)
  aspects[name] = box.w / box.h
  report(file, `crop ${box.w}x${box.h}`, `aspect ${(box.w / box.h).toFixed(3)}`, `${(coverage(flipped) * 100).toFixed(0)}% opaque`)
}

function buildBark(name, scratch) {
  // Bark tiles around the trunk, so it is NOT cropped and NOT stretched -- the
  // source is a seamless square and any crop would break the seam.
  const png = path.join(scratch, `bark_${name}.png`)
  execFileSync('sips', ['-s', 'format', 'png', path.join(EZ, 'bark', `${name}_color_1k.jpg`), '--out', png], { stdio: 'ignore' })
  const src = readPng(png)
  if (src.width !== src.height) throw new Error(`bark ${name}: ${src.width}x${src.height} is not square`)

  // readPng hands back 3 channels for a JPEG-turned-PNG; resample() wants 4.
  const rgba = new Uint8Array(src.width * src.height * 4)
  for (let i = 0; i < src.width * src.height; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = src.data[i * src.channels + Math.min(c, src.channels - 1)]
    rgba[i * 4 + 3] = 255
  }

  const px = resample(rgba, src.width, src.height, 0, 0, src.width, src.height, SIZE, SIZE)
  const file = path.join(OUT, `bark_${name}.png`)
  writePng(file, SIZE, SIZE, px, 4)
  report(file, `from ${src.width}px`, 'seamless, uncropped')
}

function report(file, ...notes) {
  const kb = statSync(file).size / 1024
  console.log(`  ${path.relative(ROOT, file).padEnd(30)} ${kb.toFixed(1).padStart(6)} KB   ${notes.join('  ')}`)
}

mkdirSync(OUT, { recursive: true })
const scratch = mkdtempSync(path.join(tmpdir(), 'aurora-bark-'))
try {
  console.log('leaves')
  for (const n of LEAVES) buildLeaf(n)
  console.log('bark')
  for (const n of BARK) buildBark(n, scratch)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// The card aspects, for pasting into TREE_SPECIES. Printed rather than written
// to a JSON the runtime reads: they are a property of art that changes about
// never, and a build-time file the game must fetch to draw a leaf correctly is
// a whole failure mode bought for nothing.
console.log('\nsprayAspect per species (art width / height):')
for (const [k, v] of Object.entries(aspects)) console.log(`  ${k.padEnd(8)} ${v.toFixed(3)}`)
