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
