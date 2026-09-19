// Bakes public/world/clouds.png: a 256x256 seamless fBm, grayscale, the one
// cloud texture the sky layer and the summit wreaths sample (§10). Offline
// rather than at load because 256^2 of fBm in JS is 20-50 ms on the Quest 2
// main thread, and the texture is the same in every game -- the weather varies
// the coverage remap, not the noise.
//
//   node scripts/make-clouds.mjs
//
// Periodic gradient noise: the lattice wraps at the octave's period, so every
// octave tiles and so does the sum. Five octaves from four cells across to
// sixty-four. The result is remapped to fill 0..255, because the coverage
// remap in the shader is written against a texture that uses its whole range.

import { writePng } from '../tools/props/png.mjs'

const SIZE = 256
const OCTAVES = [
  { period: 4, amp: 1.0 },
  { period: 8, amp: 0.5 },
  { period: 16, amp: 0.25 },
  { period: 32, amp: 0.125 },
  { period: 64, amp: 0.0625 },
]

function hash(x, y, seed) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

// Gradient noise on a lattice of `period` cells, wrapped.
function gradient(u, v, period, seed) {
  const x = u * period, y = v * period
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  const g = (ix, iy, dx, dy) => {
    const a = hash(((ix % period) + period) % period, ((iy % period) + period) % period, seed) * Math.PI * 2
    return Math.cos(a) * dx + Math.sin(a) * dy
  }
  const n00 = g(x0, y0, fx, fy), n10 = g(x0 + 1, y0, fx - 1, fy)
  const n01 = g(x0, y0 + 1, fx, fy - 1), n11 = g(x0 + 1, y0 + 1, fx - 1, fy - 1)
  const sx = fade(fx), sy = fade(fy)
  return (n00 + (n10 - n00) * sx) + ((n01 + (n11 - n01) * sx) - (n00 + (n10 - n00) * sx)) * sy
}

const px = new Float32Array(SIZE * SIZE)
let lo = Infinity, hi = -Infinity
for (let j = 0; j < SIZE; j++) {
  for (let i = 0; i < SIZE; i++) {
    const u = i / SIZE, v = j / SIZE
    let n = 0
    for (let o = 0; o < OCTAVES.length; o++) n += gradient(u, v, OCTAVES[o].period, 11 + o) * OCTAVES[o].amp
    px[j * SIZE + i] = n
    if (n < lo) lo = n
    if (n > hi) hi = n
  }
}
const out = new Uint8Array(SIZE * SIZE)
for (let k = 0; k < px.length; k++) out[k] = Math.round(((px[k] - lo) / (hi - lo)) * 255)

// Seam check: the wrapped lattice makes column 0 continue column 255, and the
// gate for the texture is that this holds, so it is asserted where it is made.
let seam = 0
for (let j = 0; j < SIZE; j++) seam = Math.max(seam, Math.abs(out[j * SIZE] - out[j * SIZE + SIZE - 1]), Math.abs(out[j] - out[(SIZE - 1) * SIZE + j]))
if (seam > 24) throw new Error(`clouds.png does not tile: seam step ${seam}`)

writePng('public/world/clouds.png', SIZE, SIZE, out, 1)
let mean = 0
for (const v of out) mean += v
console.log(`public/world/clouds.png: ${SIZE}x${SIZE} gray, mean ${(mean / out.length).toFixed(1)}, worst seam step ${seam}`)
