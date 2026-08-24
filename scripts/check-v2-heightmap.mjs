// Gate for the v2 heightmap import path -- §18 section 1 of the check.
//
//   node scripts/check-v2-heightmap.mjs
//
// Exported as run() as well, so scripts/check-v2.mjs can fold this in as one
// section without shelling out; run() throws on any failure.
//
// Three things here are checkable only by machine, and all three fail silently:
//
//   The PNG FILTERS. A decoder that gets Average or Paeth subtly wrong still
//   produces an image -- a smeared one, drifting further off with every row --
//   and a smeared heightmap is a landscape, just not the authored one. So each
//   of the five filters gets its own synthesised image and an EXACT byte match.
//
//   The ROUND TRIP. The claim make-heightmap.mjs makes is that public/world/
//   height.png is v1's field to within the quantisation step. Anything wrong in
//   the encoding, the byte order, the grid registration or the meta range shows
//   up here as metres and nowhere else as anything.
//
//   C1 CONTINUITY. §18 makes bicubic load-bearing over bilinear, and the reason
//   is a slope discontinuity that is invisible until the cells reach 6 cm. A
//   check that only ever passes proves nothing about the instrument, so this
//   one runs the same measurement against sampleBilinear and demands that it
//   FAILS by a wide margin. Both numbers are printed.

import { deflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { decodePng } from '../src/v2/height/png.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { WORLD_HALF } from '../src/v2/config.js'
import { TerrainHeight } from '../src/sim/terrain-height.js'

const PNG_PATH = new URL('../public/world/height.png', import.meta.url)
const JSON_PATH = new URL('../public/world/height.json', import.meta.url)

// --- a minimal PNG writer, so the filter checks have something to decode -----
// Deliberately separate from the one in make-heightmap.mjs: that one writes the
// shipped asset with one fixed filter, and this one has to be able to write a
// deliberately awkward image with any filter, any channel count, either depth.

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

const COLOUR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 }

function encodePng(width, height, channels, depth, samples, filterType, { colourType = COLOUR_TYPE[channels], interlace = 0 } = {}) {
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  const flat = Buffer.alloc(stride * height)
  if (depth === 8) {
    for (let i = 0; i < samples.length; i++) flat[i] = samples[i] & 0xff
  } else {
    for (let i = 0; i < samples.length; i++) {
      flat[i * 2] = (samples[i] >> 8) & 0xff
      flat[i * 2 + 1] = samples[i] & 0xff
    }
  }

  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1)
    raw[o] = filterType
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? flat[y * stride + i - bpp] : 0
      const b = y > 0 ? flat[(y - 1) * stride + i] : 0
      const c = i >= bpp && y > 0 ? flat[(y - 1) * stride + i - bpp] : 0
      let pred = 0
      if (filterType === 1) pred = a
      else if (filterType === 2) pred = b
      else if (filterType === 3) pred = (a + b) >> 1
      else if (filterType === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      raw[o + 1 + i] = (flat[y * stride + i] - pred) & 0xff
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = colourType
  ihdr[12] = interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Deterministic, and deliberately not smooth: a gradient would let a broken Sub
// or Up filter accumulate an error that still looks like a gradient. High-
// frequency content makes every filter's prediction wrong most of the time,
// which is exactly when the reconstruction has to be exact.
function noisySamples(n, max) {
  const out = new Array(n)
  let s = 0x9e3779b9
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s % (max + 1)
  }
  return out
}

// The companion case, and it is not redundant -- it is here because the noise
// fixture above provably cannot see the bug it catches.
//
// Paeth picks between three predictors by absolute distance, and the spec's
// tie-break is `pa <= pb && pa <= pc` then `pb <= pc`. Writing `<` for `<=` is
// a one-character bug that agrees with the spec on almost every pixel. The only
// tie that changes the answer is pb == pc with pa larger, and working it
// through in terms of the three neighbours that is b == 3c - 2a -- a narrow
// arithmetic coincidence that full-entropy bytes essentially never produce.
// Measured: a decoder with the wrong tie-break passed the noise fixture with
// zero bytes wrong while decoding the real 1024^2 world 318 m off.
//
// So this draws from a DENSE small alphabet, 0..7, where neighbouring triples
// land on b == 3c - 2a constantly. A sparse alphabet is no good either: over
// {0, 1, 2, 255} the relation has no solutions with b != c at all, and that
// fixture missed the bug too.
function tiedSamples(n) {
  const out = new Array(n)
  let s = 0x243f6a88
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = (s >>> 13) & 7
  }
  return out
}

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log('\n=== v2 heightmap import ===\n')
  console.log('png decode')

  // --- every scanline filter, exactly -------------------------------------
  for (let ft = 0; ft <= 4; ft++) {
    const w = 23
    const h = 17
    let bad = 0
    let shape = true
    for (const samples of [noisySamples(w * h * 3, 255), tiedSamples(w * h * 3)]) {
      const png = await decodePng(new Uint8Array(encodePng(w, h, 3, 8, samples, ft)))
      shape = shape && png.width === w && png.height === h && png.channels === 3 && png.depth === 8
      for (let i = 0; i < samples.length; i++) if (png.data[i] !== samples[i]) bad++
    }
    check(
      bad === 0 && shape,
      `filter ${ft} (${['None', 'Sub', 'Up', 'Average', 'Paeth'][ft]}) reconstructs exactly, noisy and tie-prone`,
      `${bad} of ${w * h * 3 * 2} bytes wrong`
    )
  }

  // 16-bit grayscale. The file is big-endian and the decoder is supposed to
  // hand back native-order Uint16 -- a byte-swapped 16-bit heightmap decodes to
  // a world of 256 m cliffs, so this is worth its own assertion.
  {
    const w = 19
    const h = 13
    const samples = noisySamples(w * h, 65535)
    const png = await decodePng(new Uint8Array(encodePng(w, h, 1, 16, samples, 4)))
    let bad = 0
    for (let i = 0; i < samples.length; i++) if (png.data[i] !== samples[i]) bad++
    check(
      bad === 0 && png.depth === 16 && png.channels === 1 && png.data instanceof Uint16Array,
      '16-bit grayscale decodes to native-order Uint16Array',
      `${bad} of ${samples.length} samples wrong`
    )
  }

  // RGBA, which is what anything exported from a paint program will be.
  {
    const w = 21
    const h = 11
    const samples = noisySamples(w * h * 4, 255)
    const png = await decodePng(new Uint8Array(encodePng(w, h, 4, 8, samples, 3)))
    let bad = 0
    for (let i = 0; i < samples.length; i++) if (png.data[i] !== samples[i]) bad++
    check(bad === 0 && png.channels === 4, 'RGBA 8-bit decodes with alpha intact', `${bad} of ${samples.length} bytes wrong`)
  }

  // 16-bit RGBA at once, since the depth and channel paths are independent.
  {
    const w = 9
    const h = 7
    const samples = noisySamples(w * h * 4, 65535)
    const png = await decodePng(new Uint8Array(encodePng(w, h, 4, 16, samples, 1)))
    let bad = 0
    for (let i = 0; i < samples.length; i++) if (png.data[i] !== samples[i]) bad++
    check(bad === 0 && png.channels === 4 && png.depth === 16, 'RGBA 16-bit decodes exactly', `${bad} of ${samples.length} samples wrong`)
  }

  // --- the formats that must throw rather than decode to something ---------
  const throwsWith = async (bytes, needle) => {
    try {
      await decodePng(new Uint8Array(bytes))
      return null
    } catch (e) {
      return e.message.includes(needle) ? e.message : `wrong message: ${e.message}`
    }
  }
  {
    const bad = encodePng(8, 8, 1, 8, noisySamples(64, 255), 0, { colourType: 3 })
    const msg = await throwsWith(bad, 'palette')
    check(msg !== null && !msg.startsWith('wrong'), 'palette PNG is refused by name, not decoded', msg ?? 'decoded silently')
  }
  {
    const bad = encodePng(8, 8, 1, 8, noisySamples(64, 255), 0, { interlace: 1 })
    const msg = await throwsWith(bad, 'interlaced')
    check(msg !== null && !msg.startsWith('wrong'), 'interlaced PNG is refused by name, not decoded', msg ?? 'decoded silently')
  }

  // --- the browser's inflate, run from node --------------------------------
  //
  // png.js picks zlib.inflateSync or DecompressionStream('deflate') off a
  // process.versions probe, and in node only the first branch ever runs -- so
  // without this the entire browser path ships untested and the first thing to
  // load v2.html is the test. Blanking process.versions and re-importing under
  // a fresh specifier gets the other branch evaluated here instead. The classic
  // way to get this wrong is 'deflate-raw', which rejects the two-byte zlib
  // header an IDAT stream starts with.
  {
    const w = 37
    const h = 29
    const samples = noisySamples(w * h * 3, 255)
    const bytes = new Uint8Array(encodePng(w, h, 3, 8, samples, 4))
    const real = process
    globalThis.process = { ...real, versions: {} }
    let browserPng
    try {
      browserPng = await (await import('../src/v2/height/png.js?browser=1')).decodePng(bytes)
    } finally {
      globalThis.process = real
    }
    let bad = 0
    for (let i = 0; i < samples.length; i++) if (browserPng.data[i] !== samples[i]) bad++
    check(bad === 0, "the browser branch (DecompressionStream 'deflate') decodes identically", `${bad} of ${samples.length} bytes wrong`)
  }

  // --- the shipped world ---------------------------------------------------

  console.log('\nround trip against v1')

  const meta = JSON.parse(await (await import('node:fs/promises')).readFile(JSON_PATH, 'utf8'))
  const hm = await Heightmap.read({ path: PNG_PATH, metaPath: JSON_PATH })
  const seed = Number(/seed (-?\d+)/.exec(meta.source)[1])
  const th = new TerrainHeight(seed)
  const quantum = (meta.maxY - meta.minY) / 65535

  console.log(
    `        ${hm.width}x${hm.height}  ${hm.texelSize.toFixed(4)} m/texel  ` +
      `decoded ${hm.min.toFixed(2)}..${hm.max.toFixed(2)} m  quantum ${(quantum * 100).toFixed(3)} cm  encoding ${meta.encoding}`
  )

  // The extremes have to survive the encoding exactly, because they are what
  // every other value is scaled against. A half-quantum tolerance covers the
  // round() in the encoder and nothing else.
  check(
    Math.abs(hm.min - meta.minY) <= quantum && Math.abs(hm.max - meta.maxY) <= quantum,
    'decoded metre range matches height.json',
    `${(hm.min - meta.minY).toExponential(1)} / ${(hm.max - meta.maxY).toExponential(1)} m off`
  )

  // AT TEXEL POSITIONS the image is the field, and quantisation is the only
  // thing between them. Off-texel the two must NOT agree -- v1's field has
  // metres of relief below 16 m and a 16 m grid cannot carry it -- which is the
  // whole reason §18 has a detail term. That gap is reported below, not
  // asserted on, because its size is a property of v1's spectrum.
  {
    let s = 0x2545f491
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    const errs = []
    for (let n = 0; n < 2400; n++) {
      // Border texels included on purpose: the edge-extend clamp in _tap is on
      // the path for every one of them.
      const i = Math.min(hm.width - 1, Math.floor(rand() * hm.width))
      const j = Math.min(hm.height - 1, Math.floor(rand() * hm.height))
      const x = -WORLD_HALF + i * hm.texelSize
      const z = -WORLD_HALF + j * hm.texelSize
      errs.push(Math.abs(hm.sample(x, z) - th.heightAt(x, z)))
    }
    errs.sort((a, b) => a - b)
    const max = errs[errs.length - 1]
    const p99 = errs[Math.floor(errs.length * 0.99)]
    console.log(
      `        ${errs.length} texel positions: max ${(max * 100).toFixed(3)} cm, p99 ${(p99 * 100).toFixed(3)} cm, ` +
        `quantum ${(quantum * 100).toFixed(3)} cm`
    )
    check(max <= quantum, 'every sampled texel is within one quantisation step of v1', `max ${(max * 100).toFixed(3)} cm vs ${(quantum * 100).toFixed(3)} cm`)
  }

  {
    let s = 0x85ebca6b
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    let sum = 0
    let n = 0
    for (; n < 2000; n++) {
      const x = (rand() * 2 - 1) * (WORLD_HALF - 64)
      const z = (rand() * 2 - 1) * (WORLD_HALF - 64)
      sum += Math.abs(hm.sample(x, z) - th.heightAt(x, z))
    }
    console.log(`        between texels the coarse field is off v1 by ${(sum / n).toFixed(2)} m on average -- that residual is what detail.js is for`)
  }

  // --- slopeAt's contract --------------------------------------------------
  {
    let s = 0xc2b2ae35
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    let out = 0
    let peak = 0
    for (let n = 0; n < 4000; n++) {
      const v = hm.slopeAt((rand() * 2 - 1) * (WORLD_HALF - 64), (rand() * 2 - 1) * (WORLD_HALF - 64))
      if (!(v >= 0 && v <= 1)) out++
      if (v > peak) peak = v
    }
    // detail.js multiplies by this, so a value outside 0..1 would either kill
    // the detail term or blow it up, and neither reads as a bug in slopeAt.
    check(out === 0, 'slopeAt stays inside 0..1 over the world', `${out} of 4000 outside, peak ${peak.toFixed(3)}`)
    // A flat run must map to 0 and a 45-degree run to 0.5 -- the documented
    // anchors of g / (1 + g). Checked against a synthetic ramp rather than the
    // world, because the world has no exact 45-degree texel.
    const ramp = Heightmap.fromDecoded(
      { width: 64, height: 64, channels: 1, depth: 16, data: Uint16Array.from({ length: 64 * 64 }, (_, k) => Math.round((k % 64) * (65535 / 63))) },
      { world: 16384, minY: 0, maxY: 16384 * (63 / 63), encoding: 'gray' }
    )
    // The ramp rises maxY over the world's width, i.e. gradient 1.0 exactly.
    const mid = ramp.slopeAt(0, 0)
    check(Math.abs(mid - 0.5) < 1e-3, 'a 45-degree ramp maps to slopeAt 0.5', `${mid.toFixed(6)}`)
  }

  // --- C1 continuity, and proof the measurement discriminates ---------------

  console.log('\nC1 continuity across a texel boundary')

  // Second differences at 1 cm spacing along a line that crosses ONE texel
  // boundary in x. For a C1 field the second difference is O(f'' * h^2) on both
  // sides and stays that order across the seam; for a field whose first
  // derivative jumps it is O(df' * h) at the seam, which at h = 0.01 is two
  // orders of magnitude larger than the interior.
  //
  // The line is oblique (dz/dx = 0.5) rather than axis-aligned for one reason:
  // along a pure x sweep, bilinear is exactly linear inside a cell, so its
  // interior second difference is float noise and the ratio would be measuring
  // rounding rather than curvature. Obliquely it is quadratic inside a cell,
  // which gives an honest interior to compare the seam against. The sweep is
  // +-2 m so z moves +-1 m and never leaves its own texel row.
  const H = 0.01
  const N = 401
  const sweep = (fn, x0, z0) => {
    const f = new Float64Array(N)
    for (let k = 0; k < N; k++) {
      const t = -2 + k * H
      f[k] = fn(x0 + t, z0 + 0.5 * t)
    }
    let seam = 0
    let interior = 0
    for (let k = 1; k < N - 1; k++) {
      const t = -2 + k * H
      const d2 = Math.abs(f[k - 1] - 2 * f[k] + f[k + 1])
      if (Math.abs(t) <= 1.5 * H) seam = Math.max(seam, d2)
      else if (Math.abs(t) > 0.25) interior = Math.max(interior, d2)
    }
    return seam / Math.max(interior, 1e-12)
  }

  let worstBicubic = 0
  let bestBilinear = Infinity
  const SITES = 24
  for (let n = 0; n < SITES; n++) {
    const i0 = 97 + n * 37
    const j0 = 141 + n * 29
    const x0 = -WORLD_HALF + i0 * hm.texelSize
    const z0 = -WORLD_HALF + (j0 + 0.5) * hm.texelSize
    worstBicubic = Math.max(worstBicubic, sweep((x, z) => hm.sample(x, z), x0, z0))
    bestBilinear = Math.min(bestBilinear, sweep((x, z) => hm.sampleBilinear(x, z), x0, z0))
  }
  console.log(
    `        seam/interior second difference over ${SITES} boundaries: ` +
      `bicubic worst ${worstBicubic.toFixed(2)}x, bilinear best ${bestBilinear.toFixed(0)}x`
  )
  check(worstBicubic < 2, 'bicubic has no slope discontinuity at a texel boundary', `worst ${worstBicubic.toFixed(2)}x interior`)
  check(bestBilinear > 10, 'and the measurement can see one -- bilinear fails it everywhere', `best ${bestBilinear.toFixed(0)}x interior`)

  if (failures > 0) throw new Error(`check-v2-heightmap: ${failures} check(s) failed`)
  return { failures: 0 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await run()
    console.log('\nv2 heightmap: ALL CHECKS PASSED\n')
  } catch (e) {
    console.log(`\nv2 heightmap: ${e.message}\n`)
    process.exit(1)
  }
}
