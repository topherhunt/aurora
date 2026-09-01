/**
 * Build a `_solid` variant of every leaf layer: the same art stamped over
 * itself, randomly rotated and translated, until no pixel has any alpha left.
 *
 *     node tools/trees/solidify-leaves.mjs [--out public/trees]
 *
 * WHY. A leaf cut is ~25% opaque, so wearing it means an alpha test, and an
 * alpha test costs the whole draw its low-resolution-Z on Adreno. A solid
 * variant is the same needles with the holes packed by more needles, so a
 * triangle can wear leaf ART without ever asking the alpha test a question --
 * the triangle's own edge is the leaf's edge. See design/24-voxel-foliage.md.
 *
 * SEAMLESS BY CONSTRUCTION. Every stamp is composited onto a TORUS: a copy
 * that runs off the right edge comes back on the left, so the result tiles
 * with no seam and a leaf can sample any offset into it. That is what lets
 * every leaf in a crown wear a different patch of one 128px image.
 *
 * Stamps go UNDER what is already there, not over. The first copy stays whole
 * and legible on top and each later one only fills what is still open, so the
 * result reads as a drift of leaves rather than as a soup.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'
import { join, basename } from 'node:path'

// --- the smallest PNG codec that reads what tools/trees/layers.py writes ----
//
// 8-bit RGBA, no interlace, which is every layer in the library. Anything else
// is a hard error rather than a silent half-decode.

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function readPng(file) {
  const buf = readFileSync(file)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`)
  let off = 8
  let ihdr = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += len + 12
  }
  if (!ihdr) throw new Error(`${file}: no IHDR`)
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4)
  const depth = ihdr[8], color = ihdr[9], interlace = ihdr[12]
  if (depth !== 8 || color !== 6 || interlace !== 0) {
    throw new Error(`${file}: need 8-bit RGBA non-interlaced, got depth ${depth} colour ${color} interlace ${interlace}`)
  }
  const raw = inflateSync(Buffer.concat(idat))
  const out = new Uint8Array(w * h * 4)
  const stride = w * 4
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, y * stride + stride)
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0
      const b = up ? up[x] : 0
      const c = up && x >= 4 ? up[x - 4] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else if (filter !== 0) throw new Error(`${file}: bad filter ${filter} on row ${y}`)
      cur[x] = v & 0xff
    }
  }
  return { w, h, data: out }
}

function writePng(file, { w, h, data }) {
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(data.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1)
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    Buffer.from(body).copy(out, 8)
    out.writeUInt32BE(CRC(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

// --- the stamping ----------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Bilinear sample of the source in PREMULTIPLIED colour. Straight RGB is
 * meaningless where alpha is zero -- these cuts carry black there -- so
 * interpolating it is how a leaf gets a dark fringe. Premultiplied does not
 * have the problem, because a transparent texel contributes nothing.
 */
function samplePremul(src, n, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  out[0] = out[1] = out[2] = out[3] = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const sx = x0 + dx, sy = y0 + dy
      if (sx < 0 || sy < 0 || sx >= n || sy >= n) continue
      const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
      if (wgt <= 0) continue
      const i = (sy * n + sx) * 4
      const a = src[i + 3] / 255
      out[0] += (src[i] / 255) * a * wgt
      out[1] += (src[i + 1] / 255) * a * wgt
      out[2] += (src[i + 2] / 255) * a * wgt
      out[3] += a * wgt
    }
  }
}

const MAX_STAMPS = 900

// Under-compositing approaches full alpha asymptotically: a stamp whose edge
// texel is 0.98 opaque closes 98% of what is left and never the last of it. A
// pixel is done once it rounds to 255, because that is what gets written.
const SOLID = 1 - 0.5 / 255

function solidify(src, n, seed) {
  const rand = mulberry32(seed)
  // The accumulator is premultiplied too, so an under-composite is one
  // multiply-add per channel and no divide until the very end.
  const acc = new Float32Array(n * n * 4)
  let open = n * n            // pixels that still have some alpha left
  const texel = new Float32Array(4)
  let stamps = 0

  // A rotated copy has corners sqrt(2)/2 further out than the source's own
  // half-width, so the destination window has to cover the whole rotated
  // square or the copy is clipped to a box.
  const reach = Math.ceil((n * Math.SQRT2) / 2) + 1

  while (open > 0 && stamps < MAX_STAMPS) {
    stamps++
    const ang = rand() * Math.PI * 2
    // A little scale spread so the mat does not read as one leaf size, and a
    // free mirror so a chiral cut does not lay down in only one handedness.
    const scale = 0.78 + rand() * 0.5
    const flip = rand() < 0.5 ? 1 : -1
    const ox = rand() * n, oy = rand() * n
    const cs = Math.cos(ang) / scale, sn = Math.sin(ang) / scale
    const half = (n - 1) / 2

    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Inverse map: destination offset -> source texel.
        const sx = (dx * cs + dy * sn) * flip + half
        const sy = (-dx * sn + dy * cs) + half
        if (sx < -1 || sy < -1 || sx > n || sy > n) continue
        const px = (((Math.round(ox) + dx) % n) + n) % n
        const py = (((Math.round(oy) + dy) % n) + n) % n
        const o = (py * n + px) * 4
        const have = acc[o + 3]
        if (have >= SOLID) continue
        samplePremul(src, n, sx, sy, texel)
        if (texel[3] <= 0) continue
        const room = 1 - have
        acc[o] += texel[0] * room
        acc[o + 1] += texel[1] * room
        acc[o + 2] += texel[2] * room
        const a = Math.min(1, have + texel[3] * room)
        if (a >= SOLID) open--
        acc[o + 3] = a
      }
    }
  }

  if (open > 0) throw new Error(`still ${open} translucent pixels after ${stamps} stamps`)

  const out = new Uint8Array(n * n * 4)
  let sum = [0, 0, 0]
  for (let i = 0; i < n * n; i++) {
    const a = acc[i * 4 + 3]
    for (let k = 0; k < 3; k++) {
      const v = Math.max(0, Math.min(255, Math.round((acc[i * 4 + k] / a) * 255)))
      out[i * 4 + k] = v
      sum[k] += v
    }
    out[i * 4 + 3] = 255
  }
  return { out, stamps, mean: sum.map((s) => +(s / (n * n)).toFixed(1)) }
}

// --- run -------------------------------------------------------------------

const argv = process.argv.slice(2)
const dir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'public/trees'

// Every leaf cut in the directory, and only those: bark is already solid and
// a `_solid` of a `_solid` is nonsense.
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.png') && !f.endsWith('_solid.png'))
  .filter((f) => /^(leaf|leaf2|spray)_/.test(f))
  .sort()

if (!files.length) throw new Error(`no leaf PNGs under ${dir}`)

let seed = 20260901
for (const f of files) {
  const src = readPng(join(dir, f))
  if (src.w !== src.h) throw new Error(`${f}: expected a square layer, got ${src.w}x${src.h}`)
  let opaque = 0
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] > 127) opaque++
  const { out, stamps, mean } = solidify(src.data, src.w, seed++)
  const name = `${basename(f, '.png')}_solid.png`
  writePng(join(dir, name), { w: src.w, h: src.h, data: out })
  const cover = ((opaque / (src.w * src.h)) * 100).toFixed(1)
  console.log(`${name.padEnd(24)} ${src.w}px  ${cover.padStart(5)}% opaque in  ->  100.0% out  ${String(stamps).padStart(3)} stamps  mean rgb ${mean.join(',')}`)
}
