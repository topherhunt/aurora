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
//   The ROUND TRIP. The claim make-heightmap.mjs makes is that public/world/height.png is reference/skyrim-height-map.jpg, deblocked and fitted into the square world, to within the quantisation step. So the gate re-runs the whole bake in memory -- same JPEG, same converter, same deblock, same resample -- and compares. Comparing against numbers copied out of height.json would be circular: a bug that corrupted the write corrupted the numbers written beside it too. Anything wrong in the encoding, the byte order, the grid registration, the vertical range or the non-square fit shows up here as metres and nowhere else as anything.
//
//   THE FIT. The image is 1024 x 873 and the world is square, so Z is the axis where a world-scale error hides: it costs nothing at load time and shows up later as a landscape that is silently 17% too tall in one direction. The gate pins the mapping at three points and then runs the same residual against a deliberately WRONG mapping -- Z stretched to fill the square -- and demands that one be an order of magnitude worse.
//
//   C1 CONTINUITY. §18 makes bicubic load-bearing over bilinear, and the reason
//   is a slope discontinuity that is invisible until the cells reach 6 cm. A
//   check that only ever passes proves nothing about the instrument, so this
//   one runs the same measurement against sampleBilinear and demands that it
//   FAILS by a wide margin. Both numbers are printed.

import { deflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { decodePng, readPng } from '../src/v2/height/png.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { WORLD_HALF, WORLD_SIZE } from '../src/v2/config.js'
import {
  bakeLevels,
  blockRatio,
  ridgeStat,
  toMetres,
  MIN_Y,
  MAX_Y,
  MAX_SLOPE_DEG,
  SRC_W,
  SRC_H,
  SRC_Z_SPAN,
  MIRROR_BAND,
  SEAM_Z,
} from './make-heightmap.mjs'

const PLAYER_PATH = new URL('../src/player.js', import.meta.url)

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

// The deblock control: one separable 1-2-1 binomial pass. Three of them flatten the 8 px grid completely, which is the point -- it is the too-aggressive filter the ridge test has to be able to reject.
function binomial(f, w, h) {
  const a = new Float64Array(f.length)
  const b = new Float64Array(f.length)
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) a[j * w + i] = (f[j * w + Math.max(0, i - 1)] + 2 * f[j * w + i] + f[j * w + Math.min(w - 1, i + 1)]) / 4
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) b[j * w + i] = (a[Math.max(0, j - 1) * w + i] + 2 * a[j * w + i] + a[Math.min(h - 1, j + 1) * w + i]) / 4
  return b
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

  console.log('\nround trip against the source image')

  // The whole bake, re-run in memory from reference/skyrim-height-map.jpg, so that every number below is a comparison against the source rather than against height.json's own account of itself.
  const baked = await bakeLevels()
  const meta = JSON.parse(await readFile(JSON_PATH, 'utf8'))
  const hm = await Heightmap.read({ path: PNG_PATH, metaPath: JSON_PATH })

  // A SCULPTED WORLD IS NOT THE SOURCE IMAGE ANY MORE, and most of this section
  // asserts that it is. The v2 terrain brush writes texels straight into
  // height.png and the /__height endpoint stamps `sculpted` into the meta, so
  // once one stroke is saved every comparison against a fresh bake is measuring
  // the sculpt rather than the importer.
  //
  // Those comparisons become MEASUREMENTS -- still computed, still printed, and
  // now readable as "how far has this world been moved from its import" --
  // through `asImported` below. Everything about the FILE stays a check:
  // dimensions, encoding, the vertical range, the C1 claim, the corners, the
  // 65535 in the encoder. A sculpt excuses none of those, and a re-bake brings
  // the rest of the assertions back.
  const sculpted = meta.sculpted === true
  const asImported = (ok, label, detail = '') => {
    if (!sculpted) return check(ok, label, detail)
    console.log(`  --   ${label}   [sculpted: measured, not asserted]${detail ? `   ${detail}` : ''}`)
  }
  if (sculpted) console.log('        height.json says sculpted -- the round trip below is a measurement, not a gate')
  const quantum = (meta.maxY - meta.minY) / 65535
  const step = WORLD_SIZE / (meta.size - 1)

  console.log(
    `        ${hm.width}x${hm.height}  ${hm.texelSize.toFixed(4)} m/texel  ` +
      `decoded ${hm.min.toFixed(2)}..${hm.max.toFixed(2)} m  quantum ${(quantum * 100).toFixed(3)} cm  encoding ${meta.encoding}`
  )

  // heightmap.js throws when meta.world disagrees with config, and that is the only one of these guarded anywhere. metresPerTexel and the vertical range are the same class of drift -- everything downstream is sized against them -- and nothing else checks either.
  check(meta.world === WORLD_SIZE, 'height.json world matches src/v2/config.js', `${meta.world} vs ${WORLD_SIZE}`)
  check(meta.size === baked.size && hm.width === meta.size && hm.height === meta.size, 'the image is square at meta.size', `${hm.width}x${hm.height}, meta ${meta.size}`)
  check(meta.metresPerTexel === step, 'metresPerTexel is WORLD_SIZE / (size - 1)', `${meta.metresPerTexel} vs ${step}`)
  check(meta.encoding === 'rg16' && meta.minY === MIN_Y && meta.maxY === MAX_Y, 'encoding and vertical range match the bake', `${meta.encoding} ${meta.minY}..${meta.maxY}`)
  check(meta.source === 'reference/skyrim-height-map.jpg', 'the meta names the real source', meta.source)

  // EVERY texel, on the raw bytes rather than through sample(), because this one is about the file: high byte, low byte, row order, the 65535 in the encoder. A half-quantum result is the encoder's round() and nothing else.
  {
    const png = await readPng(PNG_PATH)
    check(png.width === meta.size && png.height === meta.size && png.channels === 3 && png.depth === 8, 'the PNG on disk is 8-bit RGB at meta.size', `${png.width}x${png.height} ch ${png.channels} depth ${png.depth}`)
    let max = 0
    let worst = -1
    for (let i = 0; i < meta.size * meta.size; i++) {
      const o = i * png.channels
      const q = (png.data[o] << 8) | png.data[o + 1]
      const err = Math.abs(meta.minY + (q / 65535) * (meta.maxY - meta.minY) - toMetres(baked.levels[i], meta.minY, meta.maxY))
      if (err > max) {
        max = err
        worst = i
      }
    }
    console.log(`        ${meta.size * meta.size} texels: max ${(max * 100).toFixed(4)} cm at texel ${worst % meta.size},${Math.floor(worst / meta.size)}`)
    asImported(max <= quantum, 'every texel of the shipped PNG is within one quantisation step of the bake', `max ${(max * 100).toFixed(4)} cm vs ${(quantum * 100).toFixed(3)} cm`)
  }

  // A full-white texel has to land exactly on maxY -- that is the 65535-not-65536 in the encoder, and getting it wrong tilts the whole field by a quantum in a way no visual check would ever show.
  {
    const white = Heightmap.fromDecoded(
      { width: 4, height: 4, channels: 3, depth: 8, data: Uint8Array.from({ length: 4 * 4 * 3 }, () => 255) },
      { world: WORLD_SIZE, minY: MIN_Y, maxY: MAX_Y, encoding: 'rg16' }
    )
    check(white.max === MAX_Y && white.min === MAX_Y, 'a full-white rg16 texel decodes to exactly maxY', `${white.max}`)
  }

  // The range is a container, not a fit: the field is free to stop short of maxY. What would be wrong is stopping a long way short, which means the range was picked for a different image than the one that shipped.
  {
    const span = (hm.max - hm.min) / (meta.maxY - meta.minY)
    check(hm.min >= meta.minY - quantum && hm.max <= meta.maxY + quantum, 'the decoded field stays inside minY..maxY', `${hm.min.toFixed(3)}..${hm.max.toFixed(3)}`)
    check(span > 0.99, 'and uses essentially all of it', `${(span * 100).toFixed(2)}% of the ${(meta.maxY - meta.minY).toFixed(0)} m range`)
  }

  // Registration, through sample(): Catmull-Rom is interpolating, so AT a texel it must return that texel and not an average of its neighbours. The four corners are the ones that matter most -- they are what pins the field to the world half-extent -- and they are also the only samples where the _tap clamp is on the path in both axes at once.
  {
    let s = 0x2545f491
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
    let max = 0
    for (let n = 0; n < 4000; n++) {
      const i = Math.min(hm.width - 1, Math.floor(rand() * hm.width))
      const j = Math.min(hm.height - 1, Math.floor(rand() * hm.height))
      max = Math.max(max, Math.abs(hm.sample(-WORLD_HALF + i * hm.texelSize, -WORLD_HALF + j * hm.texelSize) - toMetres(baked.levels[j * meta.size + i], meta.minY, meta.maxY)))
    }
    let corner = 0
    for (const [i, j] of [[0, 0], [meta.size - 1, 0], [0, meta.size - 1], [meta.size - 1, meta.size - 1]])
      corner = Math.max(corner, Math.abs(hm.sample(i === 0 ? -WORLD_HALF : WORLD_HALF, j === 0 ? -WORLD_HALF : WORLD_HALF) - toMetres(baked.levels[j * meta.size + i], meta.minY, meta.maxY)))
    asImported(max <= quantum, 'sample() at a texel position returns that texel', `max ${(max * 100).toFixed(4)} cm over 4000 texels`)
    asImported(corner <= quantum, 'and the four corners land on +-WORLD_HALF', `max ${(corner * 100).toFixed(4)} cm`)
  }

  // --- the non-square fit --------------------------------------------------

  console.log('\nthe fit of a 1024x873 image into a square world')

  const srcStepX = WORLD_SIZE / (SRC_W - 1)
  const srcStepZ = SRC_Z_SPAN / (SRC_H - 1)
  console.log(
    `        source ${SRC_W}x${SRC_H} covers ${SRC_Z_SPAN.toFixed(1)} m of Z centred, seam at +-${SEAM_Z.toFixed(1)} m, ` +
      `${MIRROR_BAND.toFixed(1)} m mirrored at each edge   x ${srcStepX.toFixed(4)} m/px, z ${srcStepZ.toFixed(4)} m/px`
  )

  // Pinned rather than derived, so that a change to the fit has to be made here as well as there. The middle source row sits on z = 0 and the last one on the seam; if either drifts the whole field slides in Z.
  check(SRC_Z_SPAN === (SRC_H / SRC_W) * WORLD_SIZE && SEAM_Z === SRC_Z_SPAN / 2, 'the source spans SRC_H/SRC_W of the world in Z, centred', `${SRC_Z_SPAN} m, seam ${SEAM_Z} m`)
  check(MIRROR_BAND === 604, 'the mirrored band is 604 m at each edge and has not grown', `${MIRROR_BAND} m`)
  check(Math.abs(-SEAM_Z + ((SRC_H - 1) / 2) * srcStepZ) < 1e-9, 'the middle source row maps to z = 0', `${(-SEAM_Z + ((SRC_H - 1) / 2) * srcStepZ).toExponential(1)} m`)
  check(Math.abs(-SEAM_Z + (SRC_H - 1) * srcStepZ - SEAM_Z) < 1e-9, 'the last source row maps to the seam', `${(-SEAM_Z + (SRC_H - 1) * srcStepZ).toFixed(6)} vs ${SEAM_Z}`)
  check(Math.abs(srcStepZ / srcStepX - 1) < 0.001, 'the source is isotropic -- the terrain is not stretched', `z/x ${(srcStepZ / srcStepX).toFixed(6)}`)

  // The residual between the shipped field and the deblocked source ON THE SOURCE'S OWN GRID. Small means the fit put every source pixel where the mapping above says it goes. The control runs the same residual with Z stretched to fill the square -- the mistake that costs nothing at load time and makes the world 17% too tall in one axis -- and has to be far worse, or the measurement is not looking at the mapping at all.
  {
    const db = baked.deblock.field
    const residual = (zScale) => {
      let sse = 0
      let n = 0
      let max = 0
      for (let j = 2; j < SRC_H - 2; j += 3) {
        const z = (-SEAM_Z + j * srcStepZ) * zScale
        if (Math.abs(z) > WORLD_HALF - 8) continue
        for (let i = 2; i < SRC_W - 2; i += 3) {
          const d = hm.sample(-WORLD_HALF + i * srcStepX, z) - toMetres(db[j * SRC_W + i], meta.minY, meta.maxY)
          sse += d * d
          n++
          if (Math.abs(d) > max) max = Math.abs(d)
        }
      }
      return { rms: Math.sqrt(sse / n), max, n }
    }
    const fit = residual(1)
    const stretched = residual(WORLD_SIZE / SRC_Z_SPAN)
    console.log(
      `        ${fit.n} source pixels: rms ${fit.rms.toFixed(4)} m, max ${fit.max.toFixed(2)} m   ` +
        `with Z stretched to fill the square: rms ${stretched.rms.toFixed(2)} m, max ${stretched.max.toFixed(1)} m`
    )
    // The tolerance is a FRACTION OF THE RELIEF, not a number of metres. Every
    // term in this residual -- the quantisation step, the deblock's correction,
    // the fit itself -- is a fraction of maxY, so an absolute threshold silently
    // tightens or loosens whenever make-heightmap.mjs is re-run with a different
    // --maxY. It was 1 m against a 300 m range; the same 1/300 against whatever
    // range is shipped is the check that was actually meant.
    const rel = fit.rms / (meta.maxY - meta.minY)
    asImported(rel < 1 / 300, 'the shipped field is the source, pixel for pixel, under the stated mapping', `rms ${fit.rms.toFixed(4)} m = ${(rel * 100).toFixed(3)}% of the ${(meta.maxY - meta.minY).toFixed(0)} m range`)
    asImported(stretched.rms > 10 * fit.rms, 'and the measurement can see a wrong mapping -- a stretched Z fails it', `${(stretched.rms / fit.rms).toFixed(0)}x worse`)
  }

  // The mirror. A whole-sample mirror is C0 with ZERO Z-gradient at the seam by construction, so "continuous" is not the interesting claim -- the seam is a watershed line running the full width of the map whether the code is right or wrong. What IS checkable is that the band beyond it reflects rather than clamps, and those two predict very different fields: mirror says h(seam + t) == h(seam - t), clamp says h(seam + t) == h(seam). Both residuals are measured and they have to disagree by orders of magnitude.
  for (const side of [-1, 1]) {
    const sz = side * SEAM_Z
    let jump = 0
    let mirrorErr = 0
    let clampErr = 0
    let n = 0
    for (let k = 0; k < 256; k++) {
      const x = -WORLD_HALF + 16 + (k / 255) * (WORLD_SIZE - 32)
      jump = Math.max(jump, Math.abs(hm.sample(x, sz + 0.5) - hm.sample(x, sz - 0.5)))
      const at = hm.sample(x, sz)
      for (let t = 8; t <= MIRROR_BAND - 8; t += 8) {
        const out = hm.sample(x, sz + side * t)
        mirrorErr += Math.abs(out - hm.sample(x, sz - side * t))
        clampErr += Math.abs(out - at)
        n++
      }
    }
    mirrorErr /= n
    clampErr /= n
    // Relief across the band against relief in the strip of real terrain just inside the seam. A clamp would read as a band of near-zero relief here, and so would any fit that ran off the end of the source.
    const relief = (z0, z1) => {
      let lo = Infinity
      let hi = -Infinity
      for (let k = 0; k < 512; k++) {
        const x = -WORLD_HALF + 16 + (k / 511) * (WORLD_SIZE - 32)
        for (let t = 0; t <= 1; t++) {
          const v = hm.sample(x, z0 + t * (z1 - z0))
          if (v < lo) lo = v
          if (v > hi) hi = v
        }
      }
      return hi - lo
    }
    const band = relief(sz + side * 8, sz + side * (MIRROR_BAND - 8))
    const inside = relief(sz - side * 8, sz - side * (MIRROR_BAND - 8))
    const label = side < 0 ? 'north' : 'south'
    console.log(
      `        ${label} seam z=${sz.toFixed(0)}: step across 1 m ${(jump * 100).toFixed(2)} cm   ` +
        `mirror residual ${mirrorErr.toFixed(4)} m vs clamp residual ${clampErr.toFixed(3)} m   ` +
        `relief ${band.toFixed(1)} m in the band, ${inside.toFixed(1)} m just inside`
    )
    asImported(jump < 0.25, `the ${label} seam has no step in metres`, `${(jump * 100).toFixed(2)} cm across 1 m`)
    asImported(mirrorErr < 0.25 && clampErr > 20 * mirrorErr, `the ${label} band mirrors rather than clamps`, `mirror ${mirrorErr.toFixed(4)} m, clamp ${clampErr.toFixed(3)} m`)
    asImported(band > 0.9 * inside, `and the ${label} band carries the same relief as the terrain it reflects`, `${band.toFixed(1)} vs ${inside.toFixed(1)} m`)
  }

  // --- the deblocking pass -------------------------------------------------

  console.log('\ndeblocking the JPEG')

  // Two halves, and the SECOND is the load-bearing one. Any filter at all drives the block ratio down; what a deblocker has to do is drive it down without taking the ridges with it. The control below is three passes of a separable 1-2-1 binomial blur -- it passes the block test outright and destroys the ridges, which is exactly the failure the ridge test exists to catch.
  {
    const db = baked.deblock
    const before = db.before
    const after = db.after
    console.log(
      `        block-boundary / interior mean |d2|:  X ${before.x.ratio.toFixed(4)} -> ${after.x.ratio.toFixed(4)}   Z ${before.y.ratio.toFixed(4)} -> ${after.y.ratio.toFixed(4)}   ` +
        `k ${db.kx.toFixed(3)} / ${db.kz.toFixed(3)}, cap ${db.cap} level, moved rms ${db.rms.toFixed(4)} levels`
    )
    check(before.x.ratio > 1.25 && before.y.ratio > 1.25, 'the raw JPEG really is rougher on the 8 px grid -- the instrument sees something', `X ${before.x.ratio.toFixed(4)}, Z ${before.y.ratio.toFixed(4)}`)
    check(Math.abs(after.x.ratio - 1) < 0.05 && Math.abs(after.y.ratio - 1) < 0.05, 'and afterwards the 8 px grid is invisible to it', `X ${after.x.ratio.toFixed(4)}, Z ${after.y.ratio.toFixed(4)}`)

    const kept = { tv: after.ridge.tv / before.ridge.tv, p9999: after.ridge.p9999 / before.ridge.p9999, max: after.ridge.max / before.ridge.max }
    console.log(`        ridge kept: tv ${(kept.tv * 100).toFixed(2)}%  p99.99 ${(kept.p9999 * 100).toFixed(2)}%  max ${(kept.max * 100).toFixed(2)}%`)
    check(kept.tv > 0.97 && kept.p9999 > 0.95 && kept.max > 0.95, 'the ridges survive it', `tv ${(kept.tv * 100).toFixed(2)}%, p99.99 ${(kept.p9999 * 100).toFixed(2)}%, max ${(kept.max * 100).toFixed(2)}%`)

    const src = baked.src
    let g = src.levels
    for (let pass = 0; pass < 3; pass++) g = binomial(g, src.width, src.height)
    const gBlockX = blockRatio(g, src.width, src.height, 'x').ratio
    const gBlockZ = blockRatio(g, src.width, src.height, 'z').ratio
    const gRidge = ridgeStat(g, src.width, src.height)
    const gKept = { tv: gRidge.tv / before.ridge.tv, p9999: gRidge.p9999 / before.ridge.p9999, max: gRidge.max / before.ridge.max }
    console.log(
      `        control, 3x binomial blur: block X ${gBlockX.toFixed(4)} Z ${gBlockZ.toFixed(4)}   ` +
        `ridge kept tv ${(gKept.tv * 100).toFixed(2)}%  p99.99 ${(gKept.p9999 * 100).toFixed(2)}%  max ${(gKept.max * 100).toFixed(2)}%`
    )
    check(Math.abs(gBlockX - 1) < 0.05 && Math.abs(gBlockZ - 1) < 0.05, 'the blur control passes the block test, so that test alone proves nothing', `X ${gBlockX.toFixed(4)}, Z ${gBlockZ.toFixed(4)}`)
    check(gKept.p9999 < 0.6 && gKept.max < 0.6, 'and fails the ridge test outright, which is what makes the ridge test the gate', `p99.99 ${(gKept.p9999 * 100).toFixed(2)}%, max ${(gKept.max * 100).toFixed(2)}%`)
  }

  // The chosen range was argued from the walkable fraction at LOCOMOTION.maxSlopeDeg, and make-heightmap.mjs carries its own copy of that number because src/player.js pulls in three.js and cannot be imported here. Copies drift.
  {
    const text = await readFile(PLAYER_PATH, 'utf8')
    const m = /maxSlopeDeg:\s*(-?\d+(?:\.\d+)?)/.exec(text)
    check(m !== null && Number(m[1]) === MAX_SLOPE_DEG, 'make-heightmap.mjs still agrees with LOCOMOTION.maxSlopeDeg in src/player.js', m === null ? 'not found in player.js' : `${m[1]} vs ${MAX_SLOPE_DEG}`)
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
      { world: WORLD_SIZE, minY: 0, maxY: WORLD_SIZE, encoding: 'gray' }
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
    return { ratio: seam / Math.max(interior, 1e-12), interior }
  }

  let worstBicubic = 0
  let bestBilinear = Infinity
  let usable = 0
  const SITES = 24
  for (let n = 0; n < SITES; n++) {
    const i0 = 97 + n * 37
    const j0 = 141 + n * 29
    const x0 = -WORLD_HALF + i0 * hm.texelSize
    const z0 = -WORLD_HALF + (j0 + 0.5) * hm.texelSize
    const bicubic = sweep((x, z) => hm.sample(x, z), x0, z0)
    const bilinear = sweep((x, z) => hm.sampleBilinear(x, z), x0, z0)
    // A site the imported world happens to put on flat water has no interior curvature to compare the seam against, and a ratio of 0/0 is not evidence either way. v1's procedural field had curvature everywhere and this never arose; the imported one is 9.8% dead flat, so the degenerate sites are skipped by name rather than allowed to answer.
    if (bicubic.interior === 0 || bilinear.interior === 0) continue
    usable++
    worstBicubic = Math.max(worstBicubic, bicubic.ratio)
    bestBilinear = Math.min(bestBilinear, bilinear.ratio)
  }
  console.log(
    `        seam/interior second difference over ${usable} of ${SITES} boundaries (the rest are flat water): ` +
      `bicubic worst ${worstBicubic.toFixed(2)}x, bilinear best ${bestBilinear.toFixed(0)}x`
  )
  check(usable >= 20, 'enough of the sample sites land on terrain with curvature to measure', `${usable} of ${SITES}`)
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
