// ---------------------------------------------------------------------------
// Magenta chroma-key and per-row silhouette extraction for a character sheet
// view (front, side, or back). One image in, an alpha mask and a width
// profile out; loft-mesh.mjs turns two such profiles (front + side) into a
// mesh, bake-texture.mjs samples the source pixels directly.
// ---------------------------------------------------------------------------

import { readPng } from '../props/png.mjs'

/** Reads a character-sheet view. Returns { w, h, rgba } (rgba is Uint8Array, 4 bytes/px). */
export function decodeSheet(file) {
  const { width, height, channels, data } = readPng(file)
  if (channels === 4) return { w: width, h: height, rgba: data }
  if (channels === 3) {
    const rgba = new Uint8Array(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = 255
    }
    return { w: width, h: height, rgba }
  }
  throw new Error(`${file}: expected RGB or RGBA, got ${channels} channels`)
}

// The key is a soft threshold on "magenta-ness" (r and b both high, g low),
// not exact-colour matching, because a generated image's background is
// rarely a flat #FF00FF -- there is JPEG-ish noise and anti-aliased edges
// against the figure. LO/HI is the feather band; tune against real output
// once stage 4 of the plan reaches a real character sheet.
const LO = 60, HI = 140

/** Keys magenta out of `{w,h,rgba}`, returns a Uint8Array alpha mask (0..255), same size. */
export function keyMagenta({ w, h, rgba }) {
  const alpha = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2]
    if (r < 60 || b < 60) { alpha[i] = 255; continue }
    const score = (r + b) / 2 - g
    const t = Math.min(1, Math.max(0, (score - LO) / (HI - LO)))
    alpha[i] = Math.round((1 - t) * 255)
  }
  return alpha
}

// Corner-sampled background key: doesn't assume the background is magenta at
// all, just that it's whatever solid-ish colour sits in the four corners (Flux
// doesn't always land exactly on #FF00FF, especially on side/back views
// generated via an image reference rather than from scratch). Samples a small
// patch at each corner, bilinearly interpolates a per-pixel expected
// background colour across the image (handles a soft gradient/vignette, not
// just a flat fill), and feathers alpha by Euclidean colour distance from
// that expectation -- same LO/HI feather-band idea as keyMagenta, just not
// tied to a specific hue.
const CORNER_PATCH = 10

function cornerColor(rgba, w, h, cx, cy) {
  let r = 0, g = 0, b = 0, n = 0
  for (let y = cy; y < cy + CORNER_PATCH; y++) {
    for (let x = cx; x < cx + CORNER_PATCH; x++) {
      const i = (y * w + x) * 4
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++
    }
  }
  return [r / n, g / n, b / n]
}

const lerp = (a, b, t) => a + (b - a) * t

// Distance is measured in CHROMA space (colour with luma subtracted out), not
// raw RGB -- a chroma-keyed sheet often has a soft coloured contact-shadow
// under the figure's feet (Flux renders ambient bounce off the background
// colour) that's much darker than the flat background but the *same hue*.
// Raw RGB distance treats "darker" as "different", leaving that shadow as a
// visible halo; chroma distance only cares about hue/saturation, so a dim
// magenta shadow keys out just as cleanly as the bright magenta field around
// it, while genuine foreground colours (leather, skin, hair) -- which sit far
// from the background hue regardless of their own brightness -- still don't.
function chroma(r, g, b) {
  const y = (r + g + b) / 3
  return [r - y, g - y, b - y]
}

/**
 * Keys the background out of `{w,h,rgba}` by sampling its four corners
 * instead of assuming a fixed colour. Returns a Uint8Array alpha mask (0..255),
 * same size as keyMagenta. `lo`/`hi` are the feather band in chroma-space
 * Euclidean distance; default tuned against real magenta-background sheet
 * output -- widen if a character's own colours are close to the background
 * hue.
 */
export function keyBackground({ w, h, rgba }, { lo = 25, hi = 65 } = {}) {
  if (w < CORNER_PATCH * 2 || h < CORNER_PATCH * 2) throw new Error(`image ${w}x${h} too small for ${CORNER_PATCH}px corner sampling`)
  const tl = chroma(...cornerColor(rgba, w, h, 0, 0))
  const tr = chroma(...cornerColor(rgba, w, h, w - CORNER_PATCH, 0))
  const bl = chroma(...cornerColor(rgba, w, h, 0, h - CORNER_PATCH))
  const br = chroma(...cornerColor(rgba, w, h, w - CORNER_PATCH, h - CORNER_PATCH))

  const alpha = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const v = h > 1 ? y / (h - 1) : 0
    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0
      const bgCr = lerp(lerp(tl[0], tr[0], u), lerp(bl[0], br[0], u), v)
      const bgCg = lerp(lerp(tl[1], tr[1], u), lerp(bl[1], br[1], u), v)
      const bgCb = lerp(lerp(tl[2], tr[2], u), lerp(bl[2], br[2], u), v)
      const i = (y * w + x) * 4
      const [cr, cg, cb] = chroma(rgba[i], rgba[i + 1], rgba[i + 2])
      const dr = cr - bgCr, dg = cg - bgCg, db = cb - bgCb
      const dist = Math.sqrt(dr * dr + dg * dg + db * db)
      const t = Math.min(1, Math.max(0, (dist - lo) / (hi - lo)))
      alpha[y * w + x] = Math.round(t * 255)
    }
  }
  return alpha
}

/**
 * Crops `{w,h,rgba}` (plus its `alpha` mask and `profile` from
 * silhouetteProfile) down to the figure's own bounding box -- billboard.mjs
 * and the reference-plane endpoint in vite.config.js both need exactly this
 * crop, just at different final uses.
 */
export function cropToFigure({ w, rgba }, alpha, profile) {
  let left = Infinity, right = -Infinity
  for (let y = profile.top; y <= profile.bottom; y++) {
    const row = profile.rows[y]
    if (!row) continue
    if (row.min < left) left = row.min
    if (row.max > right) right = row.max
  }
  const top = profile.top, bottom = profile.bottom
  const cw = right - left + 1, ch = bottom - top + 1

  const out = new Uint8Array(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = ((y + top) * w + (x + left)) * 4
      const dst = (y * cw + x) * 4
      out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2]
      out[dst + 3] = alpha[(y + top) * w + (x + left)]
    }
  }
  return { w: cw, h: ch, rgba: out }
}

/**
 * Per-row [minX, maxX] silhouette extent (alpha > 128), plus the overall
 * figure's top/bottom rows. A row with no opaque pixel is `null` in `rows`.
 * Throws if the figure has fewer than 8 non-empty rows -- too thin a
 * silhouette to loft, almost certainly a keying failure rather than a real
 * character.
 */
export function silhouetteProfile(alpha, w, h) {
  const rows = new Array(h).fill(null)
  let top = -1, bottom = -1, nonEmpty = 0
  for (let y = 0; y < h; y++) {
    let min = -1, max = -1
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 128) { if (min < 0) min = x; max = x }
    }
    if (min >= 0) {
      rows[y] = { min, max }
      nonEmpty++
      if (top < 0) top = y
      bottom = y
    }
  }
  if (nonEmpty < 8) throw new Error('silhouette has fewer than 8 non-empty rows -- chroma key likely failed')
  return { top, bottom, rows }
}
