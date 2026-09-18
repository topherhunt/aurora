// ---------------------------------------------------------------------------
// Resamples a hand-marked QUAD of an RGBA photograph onto a square: every
// output texel asks squareToQuad where it came from and averages `ss` x `ss`
// bilinear taps there. Premultiplied across alpha, so the colour of a
// transparent neighbour never bleeds into an edge, and an out-of-image read is
// transparent rather than clamped. The same warp tools/trees/gen-layers.mjs
// runs for the v2 sprays, for a cut that lives outside that build.
// ---------------------------------------------------------------------------

import { squareToQuad } from '../../src/mesh/homography.js'

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

/**
 * `src` is readPng's { width, height, channels: 4, data }; `corners` are four
 * [x, y] image points in scan order of the destination square (see
 * squareToQuad). Returns `size` x `size` straight-alpha RGBA, row 0 the
 * square's top edge.
 */
export function warpQuadToSquare(src, corners, size, ss = 8) {
  if (src.channels !== 4) throw new Error(`warpQuadToSquare: ${src.channels} channels, expected RGBA`)
  const m = squareToQuad(...corners)
  const px = new Uint8Array(size * size * 4)
  const acc = new Float64Array(4)
  const one = new Float64Array(4)
  const inv = 1 / (ss * ss)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      acc[0] = acc[1] = acc[2] = acc[3] = 0
      for (let sy = 0; sy < ss; sy++) {
        const v = (y + (sy + 0.5) / ss) / size
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size
          const w = m[6] * u + m[7] * v + m[8]
          bilinear(src, (m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w, one)
          for (let c = 0; c < 4; c++) acc[c] += one[c]
        }
      }
      const a = acc[3] * inv
      const o = (y * size + x) * 4
      px[o + 3] = Math.round(Math.min(255, a))
      const k = a > 0.5 ? 255 / a : 0
      for (let c = 0; c < 3; c++) px[o + c] = Math.round(Math.min(255, acc[c] * inv * k))
    }
  }
  return px
}

/** Fraction of texels at or over `alpha`. */
export function coverage(px, alpha = 128) {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] >= alpha) n++
  return n / (px.length / 4)
}
