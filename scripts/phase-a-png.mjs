// Renders every Phase A map layer to a PNG, so the global pass can be judged by
// eye without a browser.
//
// map.html is the interactive view and is the better tool -- it has hover
// readout, zoom, and overlay toggles. This script exists because the layers it
// draws are the only honest way to answer "does this world drain like a world",
// and that question should not be gated on having a canvas in front of you. It
// imports the SAME layer painters the page uses (src/map-layers.js), so the two
// cannot disagree.
//
//   node scripts/phase-a-png.mjs [seed] [gridN] [outDir]
//
// PNG is hand-encoded, matching heightmap-png.mjs, to keep this a zero-
// dependency repo. Truecolour (type 2) rather than that script's grayscale.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runPhaseA } from '../src/sim/phase-a.js'
import { LAYERS, derive, paintInto } from '../src/map-layers.js'

const SEED = Number(process.argv[2] ?? 20260804)
const N = Number(process.argv[3] ?? 1024)
const OUT = process.argv[4] ?? tmpdir()

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

/** `px` is RGBA, w*h*4; the alpha channel is dropped on the way out. */
function writeRgbPng(path, w, h, px) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour

  const raw = Buffer.alloc(h * (w * 3 + 1))
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1)
    raw[o] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      raw[o + 1 + x * 3] = px[s]
      raw[o + 2 + x * 3] = px[s + 1]
      raw[o + 3 + x * 3] = px[s + 2]
    }
  }

  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

console.log(`phase A, seed ${SEED}, ${N}^2`)
const r = derive(runPhaseA(SEED, N, (line) => console.log(`  ${line}`)))

// Which overlays make sense per layer. Water is drawn on top of most of them
// because the whole point of the pass is where the water went, but NOT on the
// three layers that are themselves about water -- painting the stream mask over
// the flow accumulation hides the very threshold the mask was cut at.
const OVERLAY = {
  relief: { water: true, contour: false },
  elev: { water: true, contour: true },
  carve: { water: false },
  fill: { water: false },
  flow: { water: false },
  moist: { water: true },
  biome: { water: true },
  slope: { water: true },
  reach: { water: false },
}

const px = new Uint8ClampedArray(N * N * 4)
for (const [id, label] of LAYERS) {
  paintInto(px, r, id, OVERLAY[id] ?? { water: true })
  const path = `${OUT}/phase-a-${id}.png`
  writeRgbPng(path, N, N, px)
  console.log(`  ${label.padEnd(22)} ${path}`)
}
