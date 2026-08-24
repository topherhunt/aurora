// ---------------------------------------------------------------------------
// Cut the thatch tile and the frayed-fringe alpha from the thatch photograph.
//
//   node tools/props/extract-thatch.mjs [--report]
//
// Writes public/buildings/thatch.png and public/buildings/thatch_fringe.png,
// both 128x128 RGBA, both registered in IMAGE_LAYERS (DESIGN.md §19).
//
// WHY THESE TWO FIRST, ahead of the other six building tiles. §19 says the
// procedural tiles are placeholders that can be replaced later without touching
// geometry, because a wall's texture is not its silhouette. THATCH_FRINGE is
// one of the three exceptions -- its alpha IS the outline of the roof, it is
// on screen at the LOD1 boundary, and no amount of later tinting fixes a
// placeholder shape. And a fringe cut from one straw field with the roof cut
// from another does not join at the eave, so the two have to come out of the
// same photo in the same pass. Hence one script, two files.
//
// The source is a 614x614 photograph of combed straw, and the straw already
// runs the right way: DOWN the image, which is the tile convention (§19, "roof
// V runs up the slope"). Three things are wrong with it as shipped, and this
// script fixes each one:
//
//   1. It does not wrap. Measured on the max-interior-step metric that
//      check-buildings.mjs uses, its seams score ~1.2 in u and ~3.3 in v --
//      the v edge is three times the strongest line anywhere inside the tile,
//      which on a roof is a hard horizontal stripe every 1.6 m. Healed by
//      cross-fade (see `healWrap`).
//   2. It has no courses. It is a flat field of straw with no butt line
//      anywhere, because it was shot as a wall panel and not as a roof. Thatch
//      is combed rather than lapped, so the only hard line in real thatch is
//      the butt ends of each course -- and that line is most of what says
//      "roof" rather than "hay bale". Added back procedurally, which is the
//      half the generator was always good at.
//   3. It is far too saturated and too dark to tint. The roof kit gets its old
//      and new thatch, and its moss, from a per-vertex colour MULTIPLY, and a
//      multiply can only ever take colour away. A tile that ships already
//      orange has nowhere to go. Graded toward the shared straw palette so
//      there is headroom in every direction.
//
// The fringe takes its RGB from this same graded tile and its ALPHA from the
// procedural `tileFringe`, unchanged. That split is deliberate: the photo has
// no cut edge in it to trace -- it is a continuous field, there is no fringe
// anywhere in frame -- so the hanging profile has to be generated either way,
// and the generated one is already gated (eave solid, tip ragged, wraps in u).
// What the photo supplies is the straw the fringe is made of, and that is
// exactly the half that has to match the roof above it.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPng, writePng } from './png.mjs'
import { tileFringe } from '../../src/buildings/tiles.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = join(ROOT, 'tmp/downloaded-to-maybe-use/thatch-roof-texture.jpg')
// Not public/props/layers/: check-props.mjs asserts everything in there belongs
// to a built GLB, and these belong to a generator. Same reasoning as the fern
// cutouts in public/ferns/.
const OUT_DIR = join(ROOT, 'public/buildings')
const WORK = join(ROOT, 'tmp/thatch-work')

const N = 128 // TEX_SIZE. Not imported: src/textures.js pulls in three.js.
const BANDS = 4 // courses per tile, matching tileThatch's default
const REPORT = process.argv.includes('--report')

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (t) => t * t * (3 - 2 * t)
const lerp = (a, b, t) => a + (b - a) * t

// --- 1. decode --------------------------------------------------------------
// sips rather than a JPEG decoder in JS, for the same reason extract-frond.mjs
// uses it: it is native, it is already a build dependency on macOS, and writing
// a baseline JPEG decoder to read one file is not a good trade.

mkdirSync(WORK, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

const decoded = join(WORK, 'source.png')
execFileSync('sips', ['-s', 'format', 'png', SRC, '--out', decoded], { stdio: 'pipe' })
const src = readPng(decoded)
if (src.channels < 3) throw new Error(`${SRC}: ${src.channels} channels, expected RGB`)

// Float RGB in 0-1, sRGB-encoded still. Grading happens in linear light further
// down; the seam work is a blend of neighbours a few pixels apart and does not
// care which encoding it runs in.
function toFloat(png) {
  const { width: w, height: h, channels: ch, data } = png
  const out = new Float64Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = data[i * ch + Math.min(c, ch - 1)] / 255
  }
  return { w, h, px: out }
}

// --- 2. seam measurement ----------------------------------------------------
// The same metric as check-buildings.mjs: the step across the wrap edge over
// the strongest step anywhere inside the tile, in the same axis. <= 1 means the
// join is indistinguishable from a line the tile already contains. Reproduced
// here rather than imported because the check script is a gate and importing a
// gate's metric into the tool that has to satisfy it is how a metric quietly
// becomes a no-op.

function seam(img, axis) {
  const { w, h, px } = img
  const n = axis === 'u' ? w : h
  const m = axis === 'u' ? h : w
  const step = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < m; i++) {
      const a = axis === 'u' ? (i * w + k) * 3 : (k * w + i) * 3
      const b = axis === 'u' ? (i * w + ((k + 1) % w)) * 3 : (((k + 1) % h) * w + i) * 3
      for (let c = 0; c < 3; c++) step[k] += Math.abs(px[a + c] - px[b + c])
    }
  }
  let max = 0
  for (let k = 0; k < n - 1; k++) max = Math.max(max, step[k])
  return step[n - 1] / Math.max(1e-9, max)
}

// --- 3. heal the wrap -------------------------------------------------------
//
// Cross-fade, not mirror. Mirroring an image to make it tile is the usual
// trick and it is wrong for anything with grain: it puts an axis of symmetry
// down the middle of the tile, and once you have seen the butterfly you cannot
// unsee it on a whole village of roofs.
//
// The construction: drop a band of B pixels from one end and dissolve what was
// there into the other end, so the output is W-B wide and its two edges are
// pixels that WERE adjacent in the source.
//
//   out[x] = S[x]                                   for x in [B, W)
//   out[x] = lerp(S[W-B+x], S[x], smooth(x/B))      for x in [0, B)
//
// At x = B the blend has reached S[B] and joins the untouched interior. At
// x = 0 it is S[W-B], whose left neighbour in the source is S[W-B-1] -- which
// is out's last column. So the wrap edge is a join the photograph already made.
function healWrap(img, axis, bandFrac) {
  const { w, h, px } = img
  const n = axis === 'u' ? w : h
  const B = Math.max(1, Math.round(n * bandFrac))
  const ow = axis === 'u' ? w - B : w
  const oh = axis === 'u' ? h : h - B
  const out = new Float64Array(ow * oh * 3)

  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const k = axis === 'u' ? x : y
      const near = (y * w + x) * 3
      const d = (y * ow + x) * 3
      // Outside the band there is nothing to dissolve, and the `far` index does
      // not exist there -- it would run off the end of the source row.
      if (k >= B) {
        for (let c = 0; c < 3; c++) out[d + c] = px[near + c]
        continue
      }
      const far = axis === 'u' ? (y * w + (n - B + x)) * 3 : ((n - B + y) * w + x) * 3
      const t = smooth(k / B)
      for (let c = 0; c < 3; c++) out[d + c] = lerp(px[far + c], px[near + c], t)
    }
  }
  return { w: ow, h: oh, px: out }
}

// --- 4. resample to 128 -----------------------------------------------------
// Area average with wrap. 614 into 128 is not an integer ratio, so a box filter
// on integer pixel counts would alias one column in five; and the filter has to
// wrap, or the healing just done at the edges gets thrown away by a clamped
// footprint in the last output column.
function resample(img, n) {
  const { w, h, px } = img
  const out = new Float64Array(n * n * 3)
  const sx = w / n
  const sy = h / n
  for (let y = 0; y < n; y++) {
    const y0 = y * sy
    const y1 = y0 + sy
    for (let x = 0; x < n; x++) {
      const x0 = x * sx
      const x1 = x0 + sx
      let r = 0, g = 0, b = 0, wsum = 0
      for (let j = Math.floor(y0); j < Math.ceil(y1); j++) {
        const wy = Math.min(j + 1, y1) - Math.max(j, y0)
        for (let i = Math.floor(x0); i < Math.ceil(x1); i++) {
          const wx = Math.min(i + 1, x1) - Math.max(i, x0)
          const p = (((j % h) + h) % h) * w + (((i % w) + w) % w)
          const a = wx * wy
          r += px[p * 3] * a
          g += px[p * 3 + 1] * a
          b += px[p * 3 + 2] * a
          wsum += a
        }
      }
      out[(y * n + x) * 3] = r / wsum
      out[(y * n + x) * 3 + 1] = g / wsum
      out[(y * n + x) * 3 + 2] = b / wsum
    }
  }
  return { w: n, h: n, px: out }
}

// --- 5. grade ---------------------------------------------------------------
//
// In LINEAR light, because this is a photometric operation and doing it on
// sRGB bytes crushes the shadows. Three moves, in order:
//
//   Desaturate toward the photo's own luminance. The scan is a strong orange
//   and the palette straw (P.strawMid) is a muted ochre; northern thatch that
//   has stood a winter has had the red taken out of it, the same argument the
//   whole palette is built on.
//   Re-anchor: map the field's own mean and spread onto the palette's, so the
//   tile sits where the rest of the kit sits and the roof tints (thatchNew,
//   thatchOld, and the moss multiply) all have room to move it.
//   Clamp the top. A multiply-only tint means anything already at 1.0 can never
//   be made brighter, only dimmer, so the tile ships with headroom on purpose.

const SRGB_TO_LIN = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const LIN_TO_SRGB = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

// The shared straw palette, sRGB bytes (tiles.js P.strawDark/Mid/Lit).
const STRAW_MID = [138, 104, 60].map((b) => SRGB_TO_LIN(b / 255))
const STRAW_SPREAD = 0.5 // of the mid, in linear light: how far dark and lit reach
const DESATURATE = 0.35
const CEILING = 0.7 // linear, per channel: the headroom a multiply-tint needs

function grade(img) {
  const { w, h, px } = img
  const n = w * h
  const lin = new Float64Array(px.length)
  for (let i = 0; i < px.length; i++) lin[i] = SRGB_TO_LIN(px[i])

  for (let i = 0; i < n; i++) {
    const y = 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2]
    for (let c = 0; c < 3; c++) lin[i * 3 + c] = lerp(lin[i * 3 + c], y, DESATURATE)
  }

  // Re-anchor PER CHANNEL, each onto its own palette target. Normalising all
  // three against one shared luminance statistic instead -- which is the
  // obvious way to write this -- leaves the photo's average hue exactly where
  // it was, because a channel that sits far above the mean is pushed far above
  // the target too. The scan is a strong orange, so that version desaturates
  // the mottling and keeps the cast, which is precisely backwards.
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += lin[i * 3 + c]
  for (let c = 0; c < 3; c++) mean[c] /= n

  const sd = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sd[c] += (lin[i * 3 + c] - mean[c]) ** 2
  for (let c = 0; c < 3; c++) sd[c] = Math.sqrt(sd[c] / n)

  const gain = STRAW_MID.map((m, c) => (m * STRAW_SPREAD) / Math.max(1e-6, sd[c]))
  const out = new Float64Array(px.length)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = STRAW_MID[c] + (lin[i * 3 + c] - mean[c]) * gain[c]
      out[i * 3 + c] = LIN_TO_SRGB(clamp01(Math.min(v, CEILING)))
    }
  }
  return { w, h, px: out }
}

// --- 6. courses -------------------------------------------------------------
// The one thing the photograph does not contain. Same shape as tileThatch's:
// a butt highlight where each course starts and the head of the course below
// falling into its shadow, wobbled so the line is not a ruler.
//
// Deliberately a second implementation rather than a shared helper. The
// procedural tile is the placeholder that runs for the few frames before this
// PNG loads (§19, and the same arrangement BARK and LEAVES already have); tying
// the two together would mean a change to the placeholder silently re-cutting
// the shipped asset the next time someone ran this script.

// Sums of sines at integer frequencies, so the wobble is periodic in u with
// period exactly 1 and the course line does not step at the tile edge. The
// phase is taken from the COURSE index: with one wobble shared by every course
// the four butt lines run parallel like corrugated iron, which is the exact
// thing a hand-combed roof is not.
function wobble(u, band) {
  const p = band * 2.399
  return (
    Math.sin(u * Math.PI * 2 * 2 + p) * 0.5 +
    Math.sin(u * Math.PI * 2 * 5 + p * 3.1) * 0.32 +
    Math.sin(u * Math.PI * 2 * 11 + p * 1.7) * 0.18
  ) * 0.055
}

function courses(img, bands) {
  const { w, h, px } = img
  const out = new Float64Array(px.length)
  for (let y = 0; y < h; y++) {
    // Row 0 is v = 0. Nothing flips between here and the sampler: the PNG is
    // decoded with drawImage/getImageData and uploaded to a DataArrayTexture
    // whose flipY is false. See the paint() header in src/buildings/tiles.js.
    const v = (y + 0.5) / h
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      const fb = v * bands
      const bi = Math.floor(fb)
      const bf = fb - bi
      const wob = wobble(u, bi)
      // Butt ends sit proud and catch the light; the head of the course below
      // is in their shadow. Both bands are smoothstepped over several texels,
      // so nothing here is a one-texel line that the mip chain would erase --
      // and the shadow is the wide one, because at 15 m what reads as a course
      // is the band of darkness under it, not the highlight on it.
      const butt = 1 + 0.14 * (1 - smooth(clamp01((bf - wob) / 0.2)))
      const shadow = lerp(1, 0.74, smooth(clamp01((bf - wob - 0.66) / 0.34)))
      const k = butt * shadow
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = clamp01(px[(y * w + x) * 3 + c] * k)
    }
  }
  return { w, h, px: out }
}

// --- run it -----------------------------------------------------------------

const raw = toFloat(src)
const before = { u: seam(raw, 'u'), v: seam(raw, 'v') }

// 8% of the frame per axis. Enough band to dissolve straw a few stalks wide,
// small enough that the tile keeps 84% of its original pixels in each axis.
let img = healWrap(raw, 'u', 0.08)
img = healWrap(img, 'v', 0.08)
const healed = { u: seam(img, 'u'), v: seam(img, 'v') }

img = resample(img, N)
img = grade(img)
img = courses(img, BANDS)
const final = { u: seam(img, 'u'), v: seam(img, 'v') }

console.log(`thatch  ${src.width}x${src.height} -> ${N}x${N}`)
console.log(`  seam u  ${before.u.toFixed(2)} -> ${healed.u.toFixed(2)} healed -> ${final.u.toFixed(2)} final`)
console.log(`  seam v  ${before.v.toFixed(2)} -> ${healed.v.toFixed(2)} healed -> ${final.v.toFixed(2)} final`)

const rgba = new Uint8Array(N * N * 4)
for (let i = 0; i < N * N; i++) {
  for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(clamp01(img.px[i * 3 + c]) * 255)
  rgba[i * 4 + 3] = 255
}
writePng(join(OUT_DIR, 'thatch.png'), N, N, rgba, 4)

// --- the fringe -------------------------------------------------------------
//
// RGB from the tile just cut, ALPHA from the generator. Two details that are
// not obvious and both matter:
//
//   The fringe is sampled from the BOTTOM of the roof tile, wrapped. Row 0 of
//   both images is v = 0, so the fringe's eave line (v = 1, the last row) reads
//   the tile's row 0 and walks BACKWARDS from there, wrapping to the top of the
//   tile -- which is the row that would be immediately below the eave if the
//   roof carried on. The straw continues across the join instead of restarting
//   at a course butt.
//
//   The tips are darkened, not lightened. A cut straw end is end-grain in
//   shadow, hanging clear of the roof with nothing behind it to bounce light
//   back; the generator's placeholder bleaches them, which is what a fringe
//   looks like lit from below and nothing here is lit from below.

const fringeAlpha = tileFringe(N)
const fringe = new Uint8Array(N * N * 4)
for (let y = 0; y < N; y++) {
  const v = (y + 0.5) / N
  // v = 1 at the eave maps to row 0 of the tile and v = 0 at the tip to row
  // -FRINGE_DROP of it, wrapped: the fringe hangs less than a full course, so
  // it must not walk the whole tile or it re-crosses a butt line halfway down
  // the fray.
  const FRINGE_DROP = Math.round(N / BANDS)
  const sy = ((-Math.round((1 - v) * FRINGE_DROP) % N) + N) % N
  for (let x = 0; x < N; x++) {
    const s = (sy * N + x) * 4
    const d = (y * N + x) * 4
    const tip = lerp(1, 0.72, smooth(clamp01((1 - v) / 0.85)))
    for (let c = 0; c < 3; c++) fringe[d + c] = Math.round(clamp01((rgba[s + c] / 255) * tip) * 255)
    fringe[d + 3] = fringeAlpha[d + 3]
  }
}
writePng(join(OUT_DIR, 'thatch_fringe.png'), N, N, fringe, 4)

// Row N-1 is v = 1, the eave line; row 0 is v = 0, the hanging tip.
let solid = 0
for (let x = 0; x < N; x++) solid += fringe[((N - 1) * N + x) * 4 + 3]
let ragged = 0
for (let x = 0; x < N; x++) ragged += fringe[x * 4 + 3]
console.log(`fringe  alpha ${(solid / N / 255).toFixed(2)} at the eave, ${(ragged / N / 255).toFixed(2)} at the tip`)
console.log(`wrote   public/buildings/thatch.png, public/buildings/thatch_fringe.png`)

// A contact sheet, because the numbers above cannot tell you whether it looks
// like straw. Roof on the left, repeated 4x4 so a seam that survived reads as a
// grid line; the fringe on the right, one repeat per row against sky blue --
// composited, because an alpha channel viewed as opaque RGB shows nothing at
// all and the fringe is entirely an alpha channel.
if (REPORT) {
  const R = 4
  const W = N * R * 2
  const H = N * R
  const SKY = [92, 122, 160]
  const sheet = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4
      sheet[d + 3] = 255
      if (x < N * R) {
        const s = ((y % N) * N + (x % N)) * 4
        for (let c = 0; c < 3; c++) sheet[d + c] = rgba[s + c]
      } else {
        // Each row of the right half is one hanging fringe over sky, with the
        // roof tile above it, so the join at the eave is visible.
        const ry = y % N
        const s = (ry * N + (x % N)) * 4
        const a = fringe[s + 3] / 255
        for (let c = 0; c < 3; c++) sheet[d + c] = Math.round(lerp(SKY[c], fringe[s + c], a))
      }
    }
  }
  writePng(join(WORK, 'contact.png'), W, H, sheet, 4)
  console.log(`report  tmp/thatch-work/contact.png`)
}
