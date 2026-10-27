// The scaffold nets' texture (design/41-palisade-labyrinths.md, "The scaffold tower"): a 256 px square of twisted rope on a 4 x 4 mesh, knotted at each crossing, alpha 0 in the holes. Deterministic and seamless on both axes; written to public/gen-props/rope-net.png.
//
//   node scripts/gen-rope-net.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROPE_NET = { size: 256, cells: 4, half: 5.5, twist: 16, knot: 11, tint: [178, 142, 94] }
export const ROPE_NET_PNG = fileURLToPath(new URL('../public/gen-props/rope-net.png', import.meta.url))

// Distance from v to the nearest multiple of `period` (signed toward v), wrapping.
const nearest = (v, period) => v - Math.round(v / period) * period
// An integer hash in [0, 1) of a pixel, so the grain tiles with the image.
const grain = (x, y) => {
  let h = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  return ((h ^ (h >>> 12)) >>> 0) / 0x100000000
}
const smooth = (edge, d) => Math.min(1, Math.max(0, edge - d + 0.5))

/** The texture as `size * size * 4` RGBA bytes. */
export function ropeNet() {
  const { size, cells, half, twist, knot, tint } = ROPE_NET
  const pitch = size / cells
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // A strand along x lies on the lines y = k pitch, one along y on x = k pitch; its twist is a diagonal stripe along its length.
      const dy = nearest(y, pitch), dx = nearest(x, pitch)
      const strand = (along, across) => {
        const cover = smooth(half, Math.abs(across))
        const round = Math.sqrt(Math.max(0, 1 - (across / half) ** 2))
        const stripe = 0.5 + 0.5 * Math.sin((2 * Math.PI * along) / twist + 1.7 * (across / half))
        return { cover, shade: (0.52 + 0.3 * round) * (0.78 + 0.22 * stripe) }
      }
      const h = strand(x, dy), v = strand(y, dx)
      const cx = Math.floor((x + pitch / 2) / pitch), cy = Math.floor((y + pitch / 2) / pitch)
      const hOver = (cx + cy) % 2 === 0
      let cover = Math.max(h.cover, v.cover)
      let shade = h.cover > 0 && v.cover > 0 ? (hOver ? h.shade : v.shade) : h.cover >= v.cover ? h.shade : v.shade
      // The knot: a ringed bulge on the crossing.
      const r = Math.hypot(dx, dy)
      const bulge = smooth(knot, r)
      if (bulge > 0) {
        cover = Math.max(cover, bulge)
        const ring = 0.5 + 0.5 * Math.sin(r * 1.35)
        shade = shade * (1 - bulge) + bulge * (0.5 + 0.42 * Math.sqrt(Math.max(0, 1 - (r / knot) ** 2)) ) * (0.8 + 0.2 * ring)
      }
      shade *= 0.93 + 0.14 * grain(x, y)
      const k = (y * size + x) * 4
      for (let c = 0; c < 3; c++) out[k + c] = Math.min(255, Math.round(tint[c] * shade * 1.15))
      out[k + 3] = Math.round(cover * 255)
    }
  }
  return out
}

const CRC = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC[n] = c
}
const crc32 = (buf) => {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** `rgba` (width * height * 4 bytes) as an 8-bit RGBA PNG. */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(rows, y * (width * 4 + 1) + 1)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

export const ropeNetPng = () => encodePng(ropeNet(), ROPE_NET.size, ROPE_NET.size)

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(ROPE_NET_PNG, ropeNetPng())
  console.log(`wrote ${ROPE_NET_PNG}`)
}
