// ---------------------------------------------------------------------------
// Cut single fronds out of the Lady Fern megascan sheet.
//
// The source (8192x8192 BaseColor + Opacity) is ~20 individually isolated
// scanned fronds on one sheet, with a hard binary alpha. That is the whole
// reason procedural ferns are cheap here: we need ONE frond as a texture, and
// the geometry that arranges it is generated (src/props/fern.js). Nothing in
// this pipeline ever decimates a fern, so the boundary-edge floor that made
// photoreal card foliage unusable (DESIGN.md §9 bugs 10-11) never applies.
//
// Pipeline: sips downscales the 8K JPGs to a working PNG (sips is native and
// already a build dependency on macOS; decoding an 8K JPEG in pure JS is not
// worth writing). Then connected-component labelling on the thresholded
// opacity finds each frond, they get scored, and the best few are cut to
// 128x128 RGBA layers matching the existing atlas slice format.
//
//   node tools/props/extract-frond.mjs [--list] [--count N]
//
// --list reports every component and writes a contact sheet without cutting
// anything, which is how the picks below were chosen.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from './png.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = join(
  ROOT,
  'tmp/placeholder-props/high-poly-to-decimate/_new/lady_fern_wdvlditia_raw'
)
const BASE_COLOR = join(SRC, 'Lady_Fern_wdvlditia_Raw_8K_BaseColor.jpg')
const OPACITY = join(SRC, 'Lady_Fern_wdvlditia_Raw_8K_Opacity.jpg')
// Deliberately not public/props/layers/: that is the props pipeline's output,
// and check-props.mjs asserts every PNG in it belongs to a built GLB. These
// cutouts belong to a generator, not to a baked asset.
const OUT_DIR = join(ROOT, 'public/ferns')
const WORK = join(ROOT, 'tmp/frond-work')

// 2048 is the working resolution: a frond occupies roughly 400x900 of it, so
// there is 3-7x of headroom over the 128px slice we end up writing.
const WORK_SIZE = 2048
const SLICE = 128
const ALPHA_CUT = 128 // opacity byte above which a pixel is "frond"

// --- de-lighting ------------------------------------------------------------
// Megascans' "Raw" means NOT de-lit: the BaseColor is a photograph of a fern
// standing in the shaded understory it was scanned in, and the shading is baked
// into the pixels. Measured over the opaque texels of the cut, the raw frond
// sits at a mean LINEAR luminance of 0.018 and its single BRIGHTEST texel is
// 0.042. For comparison the tree atlas's oak leaf is 0.178 and the grass tuft
// is 0.271. That is not a dark green, it is very nearly black, and no amount of
// per-instance tint rescues it -- setColorAt multiplies, so it can only take
// the 0.018 down. Dropped into a lit scene the result reads exactly as what it
// is: a plant photographed in shade, sitting on ground that is not.
//
// So the grade is applied HERE, once, into the checked-in cutout, the same way
// cut-rock.mjs and cut-tiles.mjs grade their photographs -- rather than at load
// (a per-frame-zero cost for a constant) or per instance (it is a property of
// the art, not of the plant).
//
// TWO STEPS, and they are separate on purpose:
//
//   EXPOSURE is the de-light. A flat linear gain, so every ratio the scan
//   recorded -- pinna against rachis, lit face against shaded one -- survives
//   exactly. 6.6 puts the mean at 0.119, between the oak leaf and a real
//   fern's albedo, and the brightest texel at 0.275.
//
//   PULL fixes the hue, and it is needed because the scan's blue channel is
//   flat on the floor: bytes 1, 3, 7 at the 10th, 50th and 90th percentiles.
//   Gaining that up to a plausible leaf blue would need a 25x on a channel with
//   three distinct values in it, which is banding. Instead the colour is lerped
//   toward TARGET renormalised to the pixel's OWN luminance, so the pull moves
//   hue and saturation and leaves the brightness the exposure just set alone,
//   and the blue arrives smooth because most of it comes from the constant.
//
// TARGET is a linear leaf albedo, a little deeper and greener than the oak
// leaf's (0.115, 0.212, 0.036) because a fern is an understory plant and should
// still read as one. The three numbers land the cut at a mean of about
// (74, 106, 35) sRGB.
const DELIGHT = {
  exposure: 6.6,
  target: [0.068, 0.158, 0.027],
  pull: 0.55,
}

const s2l = (v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
const l2s = (v) => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(s * 255)))
}
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const TARGET_LUM = lum(...DELIGHT.target)

// In place, over the whole slice including the transparent texels: a texel at
// (0,0,0) maps to (0,0,0), which is what `dilate` below reads as "no data yet".
function delight(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    let r = s2l(rgba[i]) * DELIGHT.exposure
    let g = s2l(rgba[i + 1]) * DELIGHT.exposure
    let b = s2l(rgba[i + 2]) * DELIGHT.exposure

    const k = lum(r, g, b) / TARGET_LUM
    r += (DELIGHT.target[0] * k - r) * DELIGHT.pull
    g += (DELIGHT.target[1] * k - g) * DELIGHT.pull
    b += (DELIGHT.target[2] * k - b) * DELIGHT.pull

    rgba[i] = l2s(r)
    rgba[i + 1] = l2s(g)
    rgba[i + 2] = l2s(b)
  }
  return rgba
}

const args = process.argv.slice(2)
const LIST_ONLY = args.includes('--list')
const COUNT = Number(args[args.indexOf('--count') + 1]) || 3

function sipsTo(src, out, size) {
  execFileSync('sips', ['-Z', String(size), '-s', 'format', 'png', src, '--out', out], {
    stdio: 'pipe',
  })
}

// --- connected components ---------------------------------------------------
// Iterative flood fill with an explicit stack. 8-connectivity, because a
// feathery pinna tip can be diagonally attached by a single pixel and
// 4-connectivity shatters one frond into a dozen fragments.

function components(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1)
  const found = []
  const stack = new Int32Array(w * h)

  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start] !== -1) continue
    const id = found.length
    let sp = 0
    stack[sp++] = start
    label[start] = id

    let minX = w, minY = h, maxX = -1, maxY = -1, area = 0

    while (sp > 0) {
      const p = stack[--sp]
      const x = p % w
      const y = (p / w) | 0
      area++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (mask[q] && label[q] === -1) {
            label[q] = id
            stack[sp++] = q
          }
        }
      }
    }
    found.push({ id, area, minX, minY, maxX, maxY })
  }
  return { label, found }
}

// --- scoring ----------------------------------------------------------------
// What makes a good procedural frond card, in order of how much it matters:
//
//  - complete: does not touch the sheet edge (a clipped frond tiles wrong)
//  - upright and elongated: the generator rotates cards about their base, so a
//    frond stored vertically maps to the arch curve without a pre-rotation
//  - feathery, not blobby: fill ratio separates fronds from the rhizome clumps
//    and root balls that also live on this sheet
//  - big: more source pixels per output texel

function score(c, w, h) {
  const bw = c.maxX - c.minX + 1
  const bh = c.maxY - c.minY + 1
  const fill = c.area / (bw * bh)
  const aspect = bh / bw

  const touchesEdge = c.minX === 0 || c.minY === 0 || c.maxX === w - 1 || c.maxY === h - 1
  const reasons = []
  if (touchesEdge) reasons.push('clipped by sheet edge')
  if (c.area < 4000) reasons.push('too small')
  if (aspect < 1.15) reasons.push('not elongated')
  if (fill > 0.62) reasons.push('too solid (root ball, not a frond)')
  if (fill < 0.14) reasons.push('too sparse (stray stipe)')

  // Reward: area, uprightness up to ~3:1, and a mid fill ratio.
  const s = reasons.length
    ? 0
    : Math.sqrt(c.area) * Math.min(aspect, 3.0) * (1 - Math.abs(fill - 0.36))

  return { bw, bh, fill, aspect, score: s, reasons }
}

// --- resampling -------------------------------------------------------------
// Box filter down to the slice. RGB is weighted BY ALPHA and then divided by
// the accumulated alpha, which matters more than it sounds: the sheet's
// background is not empty, it is an out-of-focus green haze, and an unweighted
// average pulls that haze into every frond edge. Weighting means a texel that
// is 10% frond takes its colour from the frond, not from a 90% blur of the
// backdrop behind it.

function cutSlice(color, opacity, label, id, box, w) {
  const aStep = opacity.channels
  const { minX, minY, bw, bh } = box
  const out = new Uint8Array(SLICE * SLICE * 4)

  for (let oy = 0; oy < SLICE; oy++) {
    // Source row span for this output row.
    const y0 = minY + Math.floor((oy * bh) / SLICE)
    const y1 = Math.max(y0 + 1, minY + Math.floor(((oy + 1) * bh) / SLICE))
    for (let ox = 0; ox < SLICE; ox++) {
      const x0 = minX + Math.floor((ox * bw) / SLICE)
      const x1 = Math.max(x0 + 1, minX + Math.floor(((ox + 1) * bw) / SLICE))

      let r = 0, g = 0, b = 0, aSum = 0, n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = y * w + x
          // Only this component contributes. Neighbouring fronds on the sheet
          // can overlap this bounding box and must not leak into the cut.
          const a = label[p] === id ? opacity.data[p * aStep] : 0
          const c = p * color.step
          r += color.data[c] * a
          g += color.data[c + 1] * a
          b += color.data[c + 2] * a
          aSum += a
          n++
        }
      }

      const o = (oy * SLICE + ox) * 4
      if (aSum > 0) {
        out[o] = Math.round(r / aSum)
        out[o + 1] = Math.round(g / aSum)
        out[o + 2] = Math.round(b / aSum)
      }
      out[o + 3] = Math.round(aSum / n)
    }
  }
  return out
}

// Push colour outward into fully transparent texels. Nothing samples them at
// alphaTest, but the mip chain averages them in, and un-dilated black fringe
// is exactly the dark halo that shows up on cutout foliage at distance.
function dilate(rgba, size, rounds = 4) {
  for (let r = 0; r < rounds; r++) {
    const src = rgba.slice()
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4
        if (src[o + 3] > 8) continue
        let rr = 0, gg = 0, bb = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
            const q = (ny * size + nx) * 4
            if (src[q + 3] <= 8 && !(src[q] | src[q + 1] | src[q + 2])) continue
            rr += src[q]; gg += src[q + 1]; bb += src[q + 2]; n++
          }
        }
        if (n) {
          rgba[o] = Math.round(rr / n)
          rgba[o + 1] = Math.round(gg / n)
          rgba[o + 2] = Math.round(bb / n)
          // alpha deliberately untouched -- this fills colour, not coverage
        }
      }
    }
  }
  return rgba
}

// --- main -------------------------------------------------------------------

mkdirSync(WORK, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const colorPng = join(WORK, `basecolor_${WORK_SIZE}.png`)
const opacityPng = join(WORK, `opacity_${WORK_SIZE}.png`)
console.log(`downscaling 8K source to ${WORK_SIZE}px (sips)...`)
sipsTo(BASE_COLOR, colorPng, WORK_SIZE)
sipsTo(OPACITY, opacityPng, WORK_SIZE)

const color = readPng(colorPng)
const opac = readPng(opacityPng)
color.step = color.channels
opac.step = opac.channels
const w = color.width
const h = color.height
if (opac.width !== w || opac.height !== h) {
  throw new Error('base colour and opacity resampled to different sizes')
}

const mask = new Uint8Array(w * h)
for (let i = 0; i < w * h; i++) mask[i] = opac.data[i * opac.step] > ALPHA_CUT ? 1 : 0

console.log('labelling components...')
const { label, found } = components(mask, w, h)

const ranked = found
  .map((c) => ({ ...c, ...score(c, w, h) }))
  .sort((a, b) => b.score - a.score)

console.log(`\n${found.length} components (${ranked.filter((c) => c.score > 0).length} usable)\n`)
console.log('  rank  area    bbox        aspect  fill   score   note')
for (const [i, c] of ranked.slice(0, 24).entries()) {
  console.log(
    `  ${String(i).padStart(4)}  ${String(c.area).padStart(6)}  ` +
      `${String(c.bw).padStart(4)}x${String(c.bh).padEnd(4)}  ` +
      `${c.aspect.toFixed(2).padStart(6)}  ${c.fill.toFixed(2)}  ` +
      `${String(Math.round(c.score)).padStart(6)}   ${c.reasons.join(', ') || 'ok'}`
  )
}

if (LIST_ONLY) {
  console.log('\n--list: nothing written')
  process.exit(0)
}

const picks = ranked.filter((c) => c.score > 0).slice(0, COUNT)
if (!picks.length) throw new Error('no usable fronds found on the sheet')

const meta = []
for (const [i, c] of picks.entries()) {
  const name = `fern_frond_${i}`
  const file = join(OUT_DIR, `${name}.png`)
  // De-light BEFORE the dilate, so the colour that bleeds outward into the
  // transparent margin is the graded colour and the mip chain does not average
  // a raw near-black fringe back in.
  const rgba = dilate(
    delight(cutSlice(color, opac, label, c.id, { minX: c.minX, minY: c.minY, bw: c.bw, bh: c.bh }, w)),
    SLICE
  )
  writePng(file, SLICE, SLICE, rgba, 4)

  // The card is stored stretched to fill a square slice, so the generator has
  // to know the frond's true proportions to build a quad that is not squashed.
  meta.push({ name, aspect: Number((c.bw / c.bh).toFixed(4)), bytes: statSync(file).size })
  console.log(
    `\nwrote ${name}.png  ${c.bw}x${c.bh} source -> ${SLICE}x${SLICE}  ` +
      `aspect ${(c.bw / c.bh).toFixed(3)}  ${statSync(file).size} B`
  )
}

writeFileSync(join(OUT_DIR, 'fern_fronds.json'), JSON.stringify({ slice: SLICE, fronds: meta }, null, 2))
console.log(`\nwrote fern_fronds.json (${meta.length} fronds)`)
