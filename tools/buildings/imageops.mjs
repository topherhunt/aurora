// ---------------------------------------------------------------------------
// The shared image pipeline behind every shipped building tile.
//
// Not a general image library: these are exactly the operations it takes to
// turn a downloaded photograph into a 128x128 tile this kit can wear, and they
// were all written once for the thatch and are here because the other seven
// layers need the same five steps in the same order.
//
//   decode -> heal the wrap -> resample to 128 -> grade -> write
//
// THE ROW CONVENTION, which is the one thing in here that is easy to get wrong
// and impossible to see afterwards: row 0 of every buffer is v = 0. There is no
// flip anywhere between here and the sampler -- `DataArrayTexture.flipY` is
// false and cannot be otherwise, since UNPACK_FLIP_Y does not apply to the
// texImage3D an array texture uploads with, and `loadImageLayers` decodes
// through drawImage/getImageData, which is image order. So a tile whose content
// has a direction (the thatch fringe) looks upside down in an image viewer and
// is right on the roof. See the paint() header in src/buildings/tiles.js.
//
// Everything here works on `{ w, h, px }` where `px` is a Float64Array of RGB
// in 0-1, still sRGB-encoded. Alpha is carried separately when a tile needs it,
// because only two of them do.
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readPng, writePng } from '../props/png.mjs'

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
export const smooth = (t) => t * t * (3 - 2 * t)
export const lerp = (a, b, t) => a + (b - a) * t

export const SRGB_TO_LIN = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const LIN_TO_SRGB = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

/**
 * Decode any image `sips` can read into `{ w, h, px }`.
 *
 * sips rather than a JPEG decoder in JS, for the same reason extract-frond.mjs
 * uses it: it is native, it is already a build dependency on macOS, and writing
 * a baseline JPEG decoder to read one file is not a good trade.
 */
export function decode(src, workDir) {
  mkdirSync(workDir, { recursive: true })
  const png = `${workDir}/${src.replace(/[^\w.]/g, '_')}.png`
  execFileSync('sips', ['-s', 'format', 'png', src, '--out', png], { stdio: 'pipe' })
  const raw = readPng(png)
  // Grey (1) broadcasts to RGB through the Math.min below, and RGB/RGBA (3/4)
  // read straight off. Grey+alpha (2) is the one layout that trick gets wrong
  // -- it would read the alpha as green -- so it is refused rather than
  // silently decoded into a green-cast image.
  if (raw.channels === 2) throw new Error(`${src}: grey+alpha is unsupported, convert it first`)
  const { width: w, height: h, channels: ch, data } = raw
  const px = new Float64Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) px[i * 3 + c] = data[i * ch + Math.min(c, ch - 1)] / 255
  }
  return { w, h, px }
}

/** The single-channel version, for a height or AO map used as a mask. */
export function decodeMask(src, workDir) {
  const img = decode(src, workDir)
  const m = new Float64Array(img.w * img.h)
  for (let i = 0; i < m.length; i++) {
    m[i] = 0.2126 * img.px[i * 3] + 0.7152 * img.px[i * 3 + 1] + 0.0722 * img.px[i * 3 + 2]
  }
  return { w: img.w, h: img.h, m }
}

/**
 * The seam score: the step across the wrap edge over the strongest step
 * anywhere inside the tile, in the same axis. <= 1 means the join is
 * indistinguishable from a line the tile already contains.
 *
 * Reproduced from scripts/check-buildings.mjs rather than imported, because
 * importing a gate's metric into the tool that has to satisfy it is how a
 * metric quietly becomes a no-op.
 */
export function seam(img, axis) {
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

/**
 * Make an axis wrap by CROSS-FADE, not by mirroring.
 *
 * Mirroring is the usual trick and it is wrong for anything with grain: it puts
 * an axis of symmetry down the middle of the tile, and once you have seen the
 * butterfly you cannot unsee it on a whole village of roofs.
 *
 * Drop a band of B pixels from one end and dissolve what was there into the
 * other end, so the output is B narrower and its two edges are pixels that WERE
 * adjacent in the source:
 *
 *   out[x] = S[x]                                for x in [B, W)
 *   out[x] = lerp(S[W-B+x], S[x], smooth(x/B))   for x in [0, B)
 */
export function healWrap(img, axis, bandFrac) {
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

/**
 * Area-average down to n x n, WITH WRAP.
 *
 * The wrap matters: a clamped footprint in the last output column throws away
 * the healing just done at the edge. And an area average rather than a box
 * filter on integer pixel counts, because the ratios here are never integers
 * and a box filter would alias one column in five.
 */
export function resample(img, n) {
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

/** Bilinear resample of a mask to n x n, with wrap. Masks are only ever used to
 *  steer a blend, so bilinear is enough and the area filter is not worth it. */
export function resampleMask(mask, n) {
  const { w, h, m } = mask
  const out = new Float64Array(n * n)
  const at = (x, y) => m[(((y % h) + h) % h) * w + (((x % w) + w) % w)]
  for (let y = 0; y < n; y++) {
    const fy = ((y + 0.5) / n) * h - 0.5
    const j = Math.floor(fy)
    const ty = fy - j
    for (let x = 0; x < n; x++) {
      const fx = ((x + 0.5) / n) * w - 0.5
      const i = Math.floor(fx)
      const tx = fx - i
      out[y * n + x] = lerp(
        lerp(at(i, j), at(i + 1, j), tx),
        lerp(at(i, j + 1), at(i + 1, j + 1), tx),
        ty
      )
    }
  }
  return { w: n, h: n, m: out }
}

/** Rotate 90 degrees. `dir` +1 turns the image's +y toward +x. Used where a
 *  source's grain runs the wrong way for the surface it has to cover -- a beam
 *  scanned standing up, laid down as a log course. */
export function rotate90(img, dir = 1) {
  const { w, h, px } = img
  const out = new Float64Array(px.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [nx, ny] = dir > 0 ? [h - 1 - y, x] : [y, w - 1 - x]
      for (let c = 0; c < 3; c++) out[(ny * h + nx) * 3 + c] = px[(y * w + x) * 3 + c]
    }
  }
  return { w: h, h: w, px: out }
}

/**
 * Mirror top to bottom.
 *
 * Needed more often than it sounds. Roof photographs are shot the way a roof is
 * seen -- courses lapping downward, butts at the bottom of the frame -- and row
 * 0 here is v = 0, which is the EAVE. Ship one unflipped and every shake on the
 * roof laps uphill, which sheds water into the building and looks it.
 */
export function flipV(img) {
  const { w, h, px } = img
  const out = new Float64Array(px.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) out[((h - 1 - y) * w + x) * 3 + c] = px[(y * w + x) * 3 + c]
    }
  }
  return { w, h, px: out }
}

/** A rectangular crop, in pixels. */
export function crop(img, x0, y0, w, h) {
  const out = new Float64Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = img.px[((y + y0) * img.w + x + x0) * 3 + c]
    }
  }
  return { w, h, px: out }
}

/**
 * Grade a field onto a target colour, in LINEAR light.
 *
 * This is the step that makes a downloaded texture belong to this kit rather
 * than sit in it, and it exists because every tint in the building kit is a
 * per-vertex colour MULTIPLY. A multiply can only ever take colour away, so a
 * tile that ships already saturated and already bright has nowhere to go: no
 * amount of `thatchOld` or `slate` or the moss multiply will move it.
 *
 *   desaturate  toward the field's own luminance, by `desaturate`
 *   re-anchor   the field's mean and spread onto `target` and `spread`
 *   clamp       at `ceiling`, which is the headroom the multiply needs
 *
 * PER CHANNEL, each onto its own target. Normalising all three against one
 * shared luminance statistic -- the obvious way to write it -- leaves the
 * source's average hue exactly where it was, because a channel far above the
 * mean is pushed far above the target too. A strongly cast scan then comes out
 * with its mottling desaturated and its cast intact, which is backwards.
 */
export function grade(img, { target, spread = 0.5, desaturate = 0.3, ceiling = 0.72 }) {
  const { w, h, px } = img
  const n = w * h
  const tgt = target.map((b) => SRGB_TO_LIN(b / 255))
  const lin = new Float64Array(px.length)
  for (let i = 0; i < px.length; i++) lin[i] = SRGB_TO_LIN(px[i])

  for (let i = 0; i < n; i++) {
    const y = 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2]
    for (let c = 0; c < 3; c++) lin[i * 3 + c] = lerp(lin[i * 3 + c], y, desaturate)
  }

  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += lin[i * 3 + c]
  for (let c = 0; c < 3; c++) mean[c] /= n

  const sd = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sd[c] += (lin[i * 3 + c] - mean[c]) ** 2
  for (let c = 0; c < 3; c++) sd[c] = Math.sqrt(sd[c] / n)

  const gain = tgt.map((m, c) => (m * spread) / Math.max(1e-6, sd[c]))
  const out = new Float64Array(px.length)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = tgt[c] + (lin[i * 3 + c] - mean[c]) * gain[c]
      out[i * 3 + c] = LIN_TO_SRGB(clamp01(Math.min(v, ceiling)))
    }
  }
  return { w, h, px: out }
}

/** Multiply a field by a shading field normalised to mean 1, in linear light.
 *  Used where the photograph supplies the material and a generator supplies the
 *  structure -- log courses, plank gaps -- and the two have to combine without
 *  either one changing the tile's overall level. */
export function shade(img, lumaOf, strength = 1) {
  const { w, h, px } = img
  const s = new Float64Array(w * h)
  let mean = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = lumaOf((x + 0.5) / w, (y + 0.5) / h)
      s[y * w + x] = v
      mean += v
    }
  }
  mean /= w * h
  const out = new Float64Array(px.length)
  for (let i = 0; i < w * h; i++) {
    const k = lerp(1, s[i] / Math.max(1e-6, mean), strength)
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = LIN_TO_SRGB(clamp01(SRGB_TO_LIN(px[i * 3 + c]) * k))
    }
  }
  return { w, h, px: out }
}

/** Write a 128x128 RGBA PNG. `alpha` is a Float64Array of n*n or null for
 *  opaque -- every tiling layer is opaque and only the fringe is not. */
export function writeTile(path, img, alpha = null) {
  const { w, h, px } = img
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(clamp01(px[i * 3 + c]) * 255)
    data[i * 4 + 3] = alpha ? Math.round(clamp01(alpha[i]) * 255) : 255
  }
  writePng(path, w, h, data, 4)
}
