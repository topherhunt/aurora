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
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
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

// The PADDED cut, which is what a procedural pine wears. It was cut this way
// for a tiled-branch scheme that has since been thrown out (tree.js), and it
// survives that on its own merits: the plain `leaf_pine` cut is cropped to its
// alpha bounds, so opaque pixels run hard into all four edges and the card
// reads as a slab of needles rather than as one twig with air around it. It
// cannot be the same file as `leaf_pine`, which the scanned props still want
// cropped tight.
const TILING = [{ name: 'pine', out: 'spray_pine', pad: 0.09 }]

// --- the WARPED cuts, which is what a v2 spray wears -------------------------
//
// The cut above crops to the alpha box and stretches that RECTANGLE to fill the
// square. A leaf spray does not grow along an axis of its own bounding box -- it
// leaves its twig at a corner and fans out diagonally -- so the box is mostly
// air, and the four cuts spend 25 to 40% of their texels on it.
//
// These take four hand-marked corners instead and project the QUAD onto the
// square. That roughly doubles the opaque fraction (30.5 -> 56.2% on pine), and
// the fraction is what sets how many overlapping cards a crown needs to read as
// solid: the same canopy at twice the fill is half the shaded fragments, which
// on a near tree is the whole bill. tree.js then builds the card at the quad's
// own proportions (`sprayQuad`), so applying the texture reverses the warp.
//
// SOURCES ARE NOT node_modules. These are the atlases cleaned by hand -- single
// spray, background cut away, padded to a 1200px square -- and they live in
// `tmp/leaves/`, which is gitignored. The shipped PNGs under public/trees are
// therefore the artifact of record: if tmp/ is empty this cannot be rebuilt from
// the repo, and it says so rather than quietly skipping.
//
// The corners are given STEM FIRST and wind counterclockwise on screen in all
// four, so the destination winds counterclockwise too -- stem at bottom-right,
// then the other three round -- which is what keeps the art off its own mirror.
const WARP_SRC = path.join(ROOT, 'tmp/leaves')
const WARPED = {
  pine: [[552, 1144], [1011, 669], [515, 74], [56, 474]],
  oak: [[569, 1181], [903, 918], [930, 257], [193, 47]],
  aspen: [[582, 1140], [907, 539], [581, 7], [200, 539]],
  ash: [[567, 1118], [982, 401], [584, 44], [97, 230]],
}
const WARP_SS = 8 // subsamples per axis, per output texel

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

// The ONE-TRIANGLE card (tree.js `cardTris: 1`) draws a spray as a single
// triangle with its apex at the stem instead of a quad, which halves the cost
// of every card in a canopy. In UV terms that triangle is (0.5, 0) at the stem
// and (0, 1) / (1, 1) across the tip: at height v it reaches |u - 0.5| <= k*v
// with k = 0.5. So it keeps half the square, and the half it drops is the two
// BOTTOM CORNERS -- which on a spray, leaving its twig at a point, is mostly
// transparent already.
//
// MOSTLY. Not entirely, and the difference is a look decision rather than an
// arithmetic one, so this measures it rather than asserting it. `kept` is the
// fraction of OPAQUE texels the triangle keeps, and it is reported at a spread
// of k so the shape of the trade is visible: every cut here is well over 90% by
// k = 1.
//
// WHY k IS NEVER RAISED PAST 0.5 EVEN SO. Widening the triangle means UVs
// outside [0, 1], and the whole texture array is RepeatWrapping (textures.js,
// which the bark tiling depends on) -- so a card reaching past the edge does not
// find empty space there, it finds the NEXT COPY of the leaf and draws it. A
// padded cut buys back exactly its margin and no more. If the clipping at k =
// 0.5 ever matters, the fix is in the cut: resample each row horizontally by v
// so the art fills the triangle instead of being cropped by it, which loses no
// leaf and instead tapers the spray toward its stem.
const TRI_KS = [0.5, 0.75, 1, 1.5, 2]

function triangleFit(px) {
  const ratios = []
  for (let y = 0; y < SIZE; y++) {
    const v = (y + 0.5) / SIZE
    for (let x = 0; x < SIZE; x++) {
      if (px[(y * SIZE + x) * 4 + 3] < ALPHA) continue
      ratios.push(Math.abs((x + 0.5) / SIZE - 0.5) / v)
    }
  }
  if (!ratios.length) throw new Error('triangleFit: nothing survives the alpha test')
  const kept = {}
  for (const t of TRI_KS) kept[t] = ratios.filter((r) => r <= t).length / ratios.length
  return kept
}

// --- the two jobs -----------------------------------------------------------

const aspects = {}
const triKept = {}

// `pad` leaves that fraction of the square transparent at each SIDE, so the cut
// tiles horizontally without its neighbours touching. 0 fills the square, which
// is what a single card wants -- there every texel should be art.
function buildLeaf(name, outName = `leaf_${name}`, pad = 0) {
  const src = readPng(path.join(EZ, 'leaves', `${name}_color.png`))
  const box = alphaBounds(src.data, src.width, src.height)

  // Stretched to fill the square (less the margin), NOT letterboxed, and the
  // aspect is handed back so the card in tree.js can be built at the art's real
  // proportions and un-stretch it. Letterboxing would spend up to half the
  // texels on nothing.
  const inner = SIZE - 2 * Math.round(SIZE * pad)
  const x0 = Math.round((SIZE - inner) / 2)
  const scaled = resample(src.data, src.width, src.height, box.x0, box.y0, box.w, box.h, inner, SIZE)
  const px = new Uint8Array(SIZE * SIZE * 4) // zeroed: the margin is transparent
  for (let y = 0; y < SIZE; y++) {
    px.set(scaled.subarray(y * inner * 4, (y + 1) * inner * 4), (y * SIZE + x0) * 4)
  }

  // Row 0 of the file is the TOP of the image, and `decodeLayer` in
  // textures.js writes file rows straight into the array with no flip, so file
  // row 0 lands at v = 0. tree.js attaches its cards at v = 0, and in all four
  // atlases the stem end is at the BOTTOM of the image -- so flip.
  const flipped = new Uint8Array(px.length)
  for (let y = 0; y < SIZE; y++) {
    flipped.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4)
  }

  const file = path.join(OUT, `${outName}.png`)
  writePng(file, SIZE, SIZE, flipped, 4)
  // The aspect of the SQUARE as drawn, not of the art inside it: a padded cut
  // stands for a wider piece of world than the art covers, and tree.js sizes
  // the whole square. Dividing by the margin fraction is what keeps needles
  // un-stretched once the tile is laid down.
  aspects[outName] = box.w / box.h / (inner / SIZE)
  const kept = triangleFit(flipped)
  triKept[outName] = kept
  report(file, `crop ${box.w}x${box.h}`, `aspect ${aspects[outName].toFixed(3)}`,
    pad ? `${(pad * 100).toFixed(0)}% side margin` : 'fills the square',
    `${(coverage(flipped) * 100).toFixed(0)}% opaque`,
    `1-tri card keeps ${(kept[0.5] * 100).toFixed(0)}%`)
}

// --- the warped cut ----------------------------------------------------------

// Heckbert's unit-square-to-quad, corners in scan order: (0,0) -> p0, (1,0) ->
// p1, (1,1) -> p2, (0,1) -> p3. This is the INVERSE of the map we want, which is
// exactly what a resampler needs -- every output texel asks where it came from.
function squareToQuad(p0, p1, p2, p3) {
  const [x0, y0] = p0
  const [x1, y1] = p1
  const [x2, y2] = p2
  const [x3, y3] = p3
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  if (dx3 === 0 && dy3 === 0) {
    return { a: x1 - x0, b: x2 - x1, c: x0, d: y1 - y0, e: y2 - y1, f: y0, g: 0, h: 0 }
  }
  const den = dx1 * dy2 - dx2 * dy1
  if (!den) throw new Error('squareToQuad: degenerate quad')
  const g = (dx3 * dy2 - dx2 * dy3) / den
  const h = (dx1 * dy3 - dx3 * dy1) / den
  return {
    a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0,
    d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
    g, h,
  }
}

// Bilinear, premultiplied, for the same reason resample() is -- see its note.
// An out-of-image read is TRANSPARENT rather than clamped: a clamp would smear
// the border colour along the edge the artist just finished cutting.
function bilinear(src, x, y, out) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  out[0] = out[1] = out[2] = out[3] = 0
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j
    if (yy < 0 || yy >= src.height) continue
    const wy = j ? fy : 1 - fy
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i
      if (xx < 0 || xx >= src.width) continue
      const w = wy * (i ? fx : 1 - fx)
      if (!w) continue
      const p = (yy * src.width + xx) * 4
      const av = src.data[p + 3] / 255
      out[0] += src.data[p] * av * w
      out[1] += src.data[p + 1] * av * w
      out[2] += src.data[p + 2] * av * w
      out[3] += src.data[p + 3] * w
    }
  }
}

const quads = {}

function buildWarped(name) {
  const file = path.join(WARP_SRC, `${name}_color.png`)
  if (!existsSync(file)) {
    throw new Error(
      `${path.relative(ROOT, file)} is missing. The warped cuts come from the ` +
      'hand-cleaned 1200px atlases in tmp/leaves, not from node_modules, and ' +
      'tmp/ is gitignored -- public/trees/leaf2_*.png are the artifact of record.'
    )
  }
  const src = readPng(file)
  if (src.channels !== 4) throw new Error(`${name}: ${src.channels} channels, expected RGBA`)
  const quad = WARPED[name]

  // y is DOWN in image space, so a counterclockwise-on-screen quad signs
  // negative -- and so does the destination square below. Matching signs is the
  // whole of what keeps the art off its mirror, so it is asserted, not assumed.
  let area = 0
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i]
    const [bx, by] = quad[(i + 1) % 4]
    area += ax * by - bx * ay
  }
  if (area >= 0) throw new Error(`${name}: corners wind clockwise; the destination assumes CCW`)

  // Destination corners, stem at bottom-right: (0,0) top-left is the quad's
  // third vertex, (1,0) top-right its second, (1,1) bottom-right the stem,
  // (0,1) bottom-left its fourth.
  const m = squareToQuad(quad[2], quad[1], quad[0], quad[3])

  const px = new Uint8Array(SIZE * SIZE * 4)
  const acc = new Float64Array(4)
  const one = new Float64Array(4)
  const inv = 1 / (WARP_SS * WARP_SS)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0
      for (let sy = 0; sy < WARP_SS; sy++) {
        const v = (y + (sy + 0.5) / WARP_SS) / SIZE
        for (let sx = 0; sx < WARP_SS; sx++) {
          const u = (x + (sx + 0.5) / WARP_SS) / SIZE
          const w = m.g * u + m.h * v + 1
          bilinear(src, (m.a * u + m.b * v + m.c) / w, (m.d * u + m.e * v + m.f) / w, one)
          for (let c = 0; c < 4; c++) acc[c] += one[c]
        }
      }
      const a = acc[3] * inv
      const o = (y * SIZE + x) * 4
      px[o + 3] = Math.round(Math.min(255, a))
      const k = a > 0.5 ? 255 / a : 0
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(Math.min(255, acc[c] * inv * k))
    }
  }

  // Same flip as buildLeaf, for the same reason: file row 0 lands at v = 0 and
  // tree.js attaches its cards there, so the stem has to be in row 0.
  const flipped = new Uint8Array(px.length)
  for (let y = 0; y < SIZE; y++) {
    flipped.set(px.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4)
  }
  const out = path.join(OUT, `leaf2_${name}.png`)
  writePng(out, SIZE, SIZE, flipped, 4)

  // The card tree.js builds: the quad in its own frame, y UP so the stem end is
  // at 0, scaled so the longer side of its bounding box is 1. Stem first, and
  // the corner OPPOSITE it -- index 2 -- is the tip, which is the axis the card
  // is creased along.
  const xs = quad.map((q) => q[0])
  const ys = quad.map((q) => q[1])
  const minX = Math.min(...xs)
  const maxY = Math.max(...ys)
  const s = 1 / Math.max(Math.max(...xs) - minX, maxY - Math.min(...ys))
  quads[name] = quad.map(([qx, qy]) => [+((qx - minX) * s).toFixed(4), +((maxY - qy) * s).toFixed(4)])

  report(out, `quad ${Math.round(-area)} px^2`, `${(coverage(flipped) * 100).toFixed(0)}% opaque`)
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
  console.log('tiling sprays')
  for (const t of TILING) buildLeaf(t.name, t.out, t.pad)
  console.log('warped sprays')
  for (const n of Object.keys(WARPED)) buildWarped(n)
  console.log('bark')
  for (const n of BARK) buildBark(n, scratch)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// The card aspects, for pasting into TREE_SPECIES. Printed rather than written
// to a JSON the runtime reads: they are a property of art that changes about
// never, and a build-time file the game must fetch to draw a leaf correctly is
// a whole failure mode bought for nothing.
console.log('\nsprayAspect per cut (square width / height as drawn):')
for (const [k, v] of Object.entries(aspects)) console.log(`  ${k.padEnd(11)} ${v.toFixed(3)}`)
// The warped cuts do not have an aspect -- a quad is not a rectangle -- so this
// is what replaces it: `sprayQuad` in TREE_SPECIES, stem first, y up, in the
// card's own frame. Same reasoning as the aspects for why it is printed.
console.log('\nsprayQuad per warped cut (stem first, y up, longer bbox side = 1):')
for (const [k, q] of Object.entries(quads)) {
  console.log(`  ${k.padEnd(11)} ${JSON.stringify(q)}`)
}

console.log('\nopaque art a ONE-TRIANGLE card keeps, at each triangle half-width k.')
console.log('k = 0.5 is what tree.js draws; the rest is what widening would buy if the')
console.log('array were not RepeatWrapping. See the note on triangleFit.')
console.log(`  ${'cut'.padEnd(11)} ${TRI_KS.map((t) => `k=${t}`.padStart(6)).join(' ')}`)
for (const [n, kept] of Object.entries(triKept)) {
  console.log(`  ${n.padEnd(11)} ${TRI_KS.map((t) => `${(kept[t] * 100).toFixed(0)}%`.padStart(6)).join(' ')}`)
}
