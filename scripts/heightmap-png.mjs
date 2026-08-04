// Renders the height field as a grayscale PNG so terrain CHARACTER can be
// compared against reference/skyrim-height-map.jpg directly instead of inferred
// from percentiles. The reference is ~4 miles (6437 m) across at 1024 px, i.e.
// 6.29 m/px, and the crop below matches that exactly so the two images can be
// put side by side without mentally rescaling either.
//
//   node scripts/heightmap-png.mjs [seed] [outDir]
//
// Writes a reference-scale crop and a full-16km overview.
//
// This exists because probe-terrain.mjs cannot see character. The ridged
// backbone this replaced measured perfectly well on every number the probe
// reports, for two tuning passes, while looking like crumpled cloth -- one look
// at it as an image made the cause obvious in a way no percentile did. Numbers
// catch scale errors; images catch shape errors. Run both.
//
// PNG is hand-encoded rather than pulled from a dependency: signature, IHDR,
// one deflated IDAT, IEND. A grayscale 8-bit image is about forty lines of it
// and this stays a zero-dependency repo.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { TerrainHeight, SHRINK, WORLD_SIZE } from '../src/sim/terrain-height.js'

const SEED = Number(process.argv[2] ?? 20260804)
const OUT = process.argv[3] ?? tmpdir()

const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function writeGrayPng(path, w, h, pixels) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: grayscale
  // 10..12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(h * (w + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0
    pixels.copy(raw, y * (w + 1) + 1, y * w, y * w + w)
  }

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

const th = new TerrainHeight(SEED)

// Raw elevation answers "how high", which is the question the percentiles
// already answer better. SHAPE is a question about the gradient, and the eye
// reads a gradient far more readily as shading than as brightness -- a smooth
// mountainside and a shattered one occupy the same grey in an elevation map and
// look nothing alike under a light. Anything being judged by character (is this
// jagged? does it drain? is that a ridge or a smear?) wants `shade: true`.
function render(name, originX, originZ, span, size, { shade = false } = {}) {
  const step = span / size
  const H = new Float32Array(size * size)
  let lo = Infinity
  let hi = -Infinity
  for (let j = 0; j < size; j++) {
    const z = originZ + j * step
    for (let i = 0; i < size; i++) {
      const v = th.heightAt(originX + i * step, z)
      H[j * size + i] = v
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const px = Buffer.alloc(size * size)
  if (shade) {
    // Lambert against a low sun from the northwest, the convention every
    // topographic map uses -- and low, because a high sun flattens exactly the
    // fine relief this is here to inspect.
    const L = [-0.5, 0.75, -0.43]
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const l = H[j * size + Math.max(0, i - 1)]
        const r = H[j * size + Math.min(size - 1, i + 1)]
        const u = H[Math.max(0, j - 1) * size + i]
        const d = H[Math.min(size - 1, j + 1) * size + i]
        // Surface normal from central differences, unnormalised then scaled.
        const nx = (l - r) / (2 * step)
        const nz = (u - d) / (2 * step)
        const inv = 1 / Math.hypot(nx, 1, nz)
        const dot = Math.max(0, (nx * L[0] + L[1] + nz * L[2]) * inv)
        px[j * size + i] = Math.round(255 * Math.min(1, 0.12 + 0.95 * dot))
      }
    }
  } else {
    for (let i = 0; i < H.length; i++) px[i] = Math.round(255 * ((H[i] - lo) / (hi - lo)))
  }
  const path = `${OUT}/${name}.png`
  writeGrayPng(path, size, size, px)
  console.log(
    `${path}  ${size}x${size}  ${step.toFixed(2)} m/px  span ${(span / 1000).toFixed(2)} km  elev ${lo.toFixed(0)}..${hi.toFixed(0)} m`
  )
}

// Reference scale. The reference is 6437 m at 1024 px and this crop used to be
// the same, so the two could be laid side by side without rescaling either.
// SHRINK broke that, and it is worth being precise about why rather than just
// dividing: the point of the comparison is LANDFORM CHARACTER, so what has to
// match is features per pixel, not metres per pixel. At SHRINK 2 this world
// carries twice the landforms per kilometre, so the crop that reads like the
// reference is half as wide. Rendered at the old 6437 m the whole frame came
// out as an even carpet of same-sized lumps -- not because the terrain had lost
// its structure, but because the instrument was under-resolving it. Fifth time
// a measurement here has quietly stopped measuring what it names.
render('hm-ref-scale', -3200, -3200, 6437 / SHRINK, 1024)
// Whole world, for the regional distribution of ranges and basins.
render('hm-world', -WORLD_SIZE / 2, -WORLD_SIZE / 2, WORLD_SIZE, 1024)
// The same reference crop under a light, for shape rather than height.
render('hm-ref-shaded', -3200, -3200, 6437 / SHRINK, 1024, { shade: true })
// 1.5 km at 1.5 m/px: roughly what she can see from one spot, and the only
// scale at which "rolling hills of clay" versus "jagged" is actually decided.
render('hm-local-shaded', -800, -800, 1536, 1024, { shade: true })
// 300 m at 0.3 m/px -- three and a half minutes of walking across the frame,
// and the ONLY render at which a 10 m feature is big enough to have a shape.
// Everything above smears the 10 m scale into texture: at 1.5 m/px a 10 m
// hummock is seven pixels, which is a smudge whether it is a crisp scarp or a
// clay mound. "Less rounded at the 10 m level" cannot be judged anywhere else.
render('hm-human-shaded', -150, -150, 300, 1024, { shade: true })
