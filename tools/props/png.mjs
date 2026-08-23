// ---------------------------------------------------------------------------
// Minimal PNG read/write. Same reasoning as scripts/heightmap-png.mjs: this
// stays a zero-dependency repo, and the subset we need is small.
//
// Encode: 8-bit RGBA or grayscale, filter 0, one IDAT.
// Decode: 8-bit non-interlaced, colour types 0/2/4/6, all five filter types.
//
// Deliberately NOT supported: 16-bit depth, palettes, interlacing. Nothing in
// this pipeline produces them and a half-working decoder that silently returns
// garbage is worse than one that throws.
// ---------------------------------------------------------------------------

import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

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

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// channels-per-pixel by PNG colour type
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

export function writePng(path, w, h, pixels, channels = 4) {
  if (channels !== 4 && channels !== 1) {
    throw new Error(`writePng supports 1 or 4 channels, got ${channels}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 0

  const stride = w * channels
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    )
  }

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(SIG),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  )
}

// Returns { width, height, channels, data } where data is a Uint8Array of
// `channels` bytes per pixel, row-major.
export function readPng(path) {
  const buf = readFileSync(path)
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error(`${path}: not a PNG`)
  }

  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  let off = 8
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colourType = data[9]
      const interlace = data[12]
      if (depth !== 8) throw new Error(`${path}: bit depth ${depth}, only 8 supported`)
      if (interlace !== 0) throw new Error(`${path}: interlaced PNGs unsupported`)
      channels = CHANNELS[colourType]
      if (!channels) throw new Error(`${path}: colour type ${colourType} unsupported`)
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * channels)

  // Un-filter. Each scanline is prefixed by its filter type and predicts from
  // the already-reconstructed pixel to the left (a) and the row above (b/c).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride

    for (let x = 0; x < stride; x++) {
      const val = raw[src + x]
      const a = x >= channels ? out[dst + x - channels] : 0
      const b = y > 0 ? out[up + x] : 0
      const c = y > 0 && x >= channels ? out[up + x - channels] : 0

      let recon
      switch (filter) {
        case 0: recon = val; break
        case 1: recon = val + a; break
        case 2: recon = val + b; break
        case 3: recon = val + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          recon = val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default:
          throw new Error(`${path}: bad filter type ${filter} on row ${y}`)
      }
      out[dst + x] = recon & 0xff
    }
  }

  return { width, height, channels, data: out }
}
