// ---------------------------------------------------------------------------
// A creature photographed on a flat chroma background, cut out and boxed to a
// small RGBA card map:
//
//   node tools/creatures/key-card.mjs <in.png> <out.png> <WxH>
//   node tools/creatures/key-card.mjs tmp/grasshopper.png public/creatures/grasshopper.png 128x64
//
// The key colour is not given: it is the median of the ring of pixels round
// the frame's edge, so any flat backdrop works and a shot with a slightly
// uneven one still keys. A pixel's alpha is its RGB distance from that colour
// ramped over KEY_LO..KEY_HI, and a part-covered edge pixel has the backdrop
// un-mixed from its colour (c = (p - (1 - a) * key) / a) so the cutout's rim
// carries no magenta fringe. The opaque box is then fitted inside the W x H
// map with MARGIN texels clear on every side, aspect kept, each texel the
// alpha-weighted mean of a SUPERSAMPLE grid of source pixels, and colour is
// dilated into the clear texels (wing-cards.mjs dilate) so bilinear filtering
// at the cutout's edge does not blend toward black.
//
// The margin is load-bearing: src/v2/render/grasshoppers.js draws each card
// as ONE triangle twice the quad's size and cuts everything outside 0..1 UV,
// and the mip chain's edge texels still need to read clear at the sizes the
// card is seen at. Decoding is ImageMagick's (tools/tripo-pack.mjs magick),
// the PNG is wing-cards.mjs's encoder, so nothing here premultiplies.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { dilate, encodePng } from './wing-cards.mjs'

// RGB distance from the key colour at which a pixel is fully backdrop, and at which it is fully creature.
export const KEY_LO = 40
export const KEY_HI = 110
// Clear texels round the boxed creature on every side of the map.
export const MARGIN = 2
// The fraction of the width and height round the edge the key colour is read from.
const EDGE_STRIP = 0.01
const SUPERSAMPLE = 8

/** The median colour of the frame's edge ring. */
export function keyColour(rgba, W, H) {
  const strip = Math.max(1, Math.round(Math.min(W, H) * EDGE_STRIP))
  const ch = [[], [], []]
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= strip && x < W - strip && y >= strip && y < H - strip) continue
      const i = (y * W + x) * 4
      ch[0].push(rgba[i]); ch[1].push(rgba[i + 1]); ch[2].push(rgba[i + 2])
    }
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1])
}

/**
 * Alpha by distance from `key`, the backdrop un-mixed from every part-covered
 * pixel. Returns the RGBA with its alpha written, and the opaque box.
 */
export function keyOut(rgba, W, H, key) {
  const out = new Uint8Array(rgba)
  const box = { x0: W, y0: H, x1: -1, y1: -1 }
  for (let p = 0; p < W * H; p++) {
    const i = p * 4
    const dr = rgba[i] - key[0], dg = rgba[i + 1] - key[1], db = rgba[i + 2] - key[2]
    const d = Math.sqrt(dr * dr + dg * dg + db * db)
    const a = Math.min(1, Math.max(0, (d - KEY_LO) / (KEY_HI - KEY_LO)))
    if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
      continue
    }
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.max(0, Math.round((rgba[i + c] - (1 - a) * key[c]) / a)))
    out[i + 3] = Math.round(a * 255)
    const x = p % W, y = (p - x) / W
    if (x < box.x0) box.x0 = x
    if (x > box.x1) box.x1 = x
    if (y < box.y0) box.y0 = y
    if (y > box.y1) box.y1 = y
  }
  if (box.x1 < 0) throw new Error('key-card: nothing in the frame differs from the key colour')
  return { rgba: out, box }
}

/**
 * The keyed `box` of `rgba` fitted inside a `w` x `h` map with MARGIN clear on
 * every side, aspect kept and centred, then colour-dilated. Row 0 is the top.
 */
export function boxDown(rgba, W, box, w, h) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1
  const scale = Math.min((w - 2 * MARGIN) / bw, (h - 2 * MARGIN) / bh)
  const dw = bw * scale, dh = bh * scale
  const ox = (w - dw) / 2, oy = (h - dh) / 2
  const px = new Uint8Array(w * h * 4)
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const x = Math.floor((tx + (sx + 0.5) / SUPERSAMPLE - ox) / scale)
          const y = Math.floor((ty + (sy + 0.5) / SUPERSAMPLE - oy) / scale)
          n++
          if (x < 0 || y < 0 || x >= bw || y >= bh) continue
          const i = ((box.y0 + y) * W + box.x0 + x) * 4
          const wa = rgba[i + 3] / 255
          r += rgba[i] * wa; g += rgba[i + 1] * wa; b += rgba[i + 2] * wa
          a += wa
        }
      }
      const i = (ty * w + tx) * 4
      if (a > 0) {
        px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a
      }
      px[i + 3] = Math.round((255 * a) / n)
    }
  }
  dilate(px, w, h)
  return px
}

function main() {
  const [inFile, outFile, size] = process.argv.slice(2)
  const m = /^(\d+)x(\d+)$/.exec(size ?? '')
  if (!inFile || !outFile || !m) throw new Error('usage: node tools/creatures/key-card.mjs <in.png> <out.png> <WxH>')
  const [w, h] = [Number(m[1]), Number(m[2])]
  const [W, H] = execFileSync('magick', ['identify', '-format', '%w %h', inFile]).toString().split(' ').map(Number)
  const rgba = new Uint8Array(execFileSync('magick', [inFile, '-depth', '8', 'rgba:-'], { maxBuffer: W * H * 4 + 1024 }))
  if (rgba.length !== W * H * 4) throw new Error(`magick decoded ${rgba.length} bytes for ${W}x${H} ${inFile}`)
  const key = keyColour(rgba, W, H)
  const keyed = keyOut(rgba, W, H, key)
  const px = boxDown(keyed.rgba, W, keyed.box, w, h)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, encodePng(px, w, h))
  const { x0, y0, x1, y1 } = keyed.box
  console.log(`key-card: key rgb(${key.join(',')}), box ${x1 - x0 + 1}x${y1 - y0 + 1} at ${x0},${y0} -> ${w}x${h} ${outFile}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main()
