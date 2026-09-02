/**
 * Build the `_solid` leaf mats the voxel crowns wear: one hand-cut photo of
 * leaves, stamped over itself at random rotations and offsets until no pixel
 * has any alpha left, then box-downressed once to 128px.
 *
 *     node tools/trees/solidify-leaves.mjs [--src tmp/leaves] [--out public/trees]
 *
 * WHY SOLID. A leaf cut is ~25% opaque, so wearing it means an alpha test, and
 * an alpha test costs the whole draw its low-resolution-Z on Adreno. A solid
 * mat is the same leaves with the holes packed by more leaves, so a triangle
 * can wear leaf ART without ever asking the alpha test a question -- the
 * triangle's own edge is the leaf's edge. See design/24-voxel-foliage.md.
 *
 * WHY SUPERSAMPLE. Stamping at the output's own 128px resamples the source
 * hundreds of times at random angles and under-composites every one of them,
 * and each pass softens what the last pass softened: the result is a mat with
 * no individual leaf left in it. Composing at SUPER x the output and box-
 * filtering ONCE at the end means every leaf edge is resampled exactly twice,
 * so the leaves survive as leaves.
 *
 * SEAMLESS BY CONSTRUCTION. Every stamp is composited onto a TORUS: a copy
 * that runs off the right edge comes back on the left, so the result tiles
 * with no seam and a leaf triangle can sample any offset into it. That is what
 * lets every leaf in a crown wear a different patch of one 128px image.
 *
 * Stamps go UNDER what is already there, not over. The first copy stays whole
 * and legible on top and each later one only fills what is still open, so the
 * result reads as a drift of leaves rather than as a soup.
 *
 * THE SOURCES ARE NOT VERSIONED. tmp/ is gitignored, so a clean checkout can
 * run the trees but cannot rebuild these mats. The four PNGs it wants are hand
 * cuts, not generated -- if they matter beyond this bench they have to be
 * moved somewhere tracked first.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'
import { join } from 'node:path'

/**
 * The four mats, and the crop each is stamped from. One entry per species in
 * VOXEL_SPECIES; the `tile` fields there name the outputs.
 */
const MATS = [
  { src: 'pine_color copy.png', out: 'leaf_pine_solid.png' },
  { src: 'oak_color copy.png', out: 'leaf_oak_solid.png' },
  { src: 'aspen_color copy.png', out: 'leaf_aspen_solid.png' },
  { src: 'ash_color copy.png', out: 'leaf_ash_solid.png' },
]

const OUT = 128            // the tile the shader samples
const SUPER = 4            // compose at OUT * SUPER, downres once
const N = OUT * SUPER
// The crop's long side, as a fraction of the composing canvas. This is the one
// knob that sets how big a single leaf reads in the finished mat: at 0.75 the
// whole crop lands on ~96 of the output's 128 pixels, so a leaf triangle
// (leafPatch ~0.6 of the tile) shows four or five distinct leaves across it.
const FILL = 0.75

// --- the smallest PNG codec that reads what tools/trees/layers.py writes ----
//
// 8-bit RGBA, no interlace, which is every layer in the library and every crop
// under tmp/leaves. Anything else is a hard error rather than a silent
// half-decode.

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

// --- colour ----------------------------------------------------------------
//
// Every average here runs in LINEAR light. A box filter over sRGB bytes is not
// a box filter over light: it darkens every edge it crosses, and a mat that is
// nothing but leaf edges comes out most of a stop under where it should be.

const toLinear = (b) => {
  const c = b / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const toSrgb = (v) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
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
 * Bilinear sample of the source in PREMULTIPLIED LINEAR colour. Straight RGB
 * is meaningless where alpha is zero -- these cuts carry black there -- so
 * interpolating it is how a leaf gets a dark fringe. Premultiplied does not
 * have the problem, because a transparent texel contributes nothing.
 */
function samplePremul(src, sw, sh, x, y, out) {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  out[0] = out[1] = out[2] = out[3] = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const sx = x0 + dx, sy = y0 + dy
      if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue
      const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy)
      if (wgt <= 0) continue
      const i = (sy * sw + sx) * 4
      const a = src[i + 3] / 255
      out[0] += toLinear(src[i]) * a * wgt
      out[1] += toLinear(src[i + 1]) * a * wgt
      out[2] += toLinear(src[i + 2]) * a * wgt
      out[3] += a * wgt
    }
  }
}

const MAX_STAMPS = 4000

// Under-compositing approaches full alpha asymptotically: a stamp whose edge
// texel is 0.98 opaque closes 98% of what is left and never the last of it. A
// pixel is done once it is within half a byte of opaque, because that is what
// gets written.
const SOLID = 1 - 0.5 / 255

/**
 * Stamp `src` (sw x sh, RGBA) onto an N x N torus until every pixel is opaque.
 * Returns the premultiplied LINEAR accumulator.
 */
function stampToFull(src, sw, sh, seed) {
  const rand = mulberry32(seed)
  // Premultiplied accumulator, so an under-composite is one multiply-add per
  // channel and no divide until the very end.
  const acc = new Float32Array(N * N * 4)
  let open = N * N            // pixels that still have some alpha left
  const texel = new Float32Array(4)
  let stamps = 0

  // Every crop lands at the same size regardless of how big it was cut, so a
  // leaf reads the same across the four species.
  const fit = (N * FILL) / Math.max(sw, sh)

  while (open > 0 && stamps < MAX_STAMPS) {
    stamps++
    const ang = rand() * Math.PI * 2
    // A little scale spread so the mat does not read as one leaf size, and a
    // free mirror so a chiral cut does not lay down in only one handedness.
    const scale = fit * (0.88 + rand() * 0.26)
    const flip = rand() < 0.5 ? 1 : -1
    const ox = Math.round(rand() * N), oy = Math.round(rand() * N)
    const cs = Math.cos(ang) / scale, sn = Math.sin(ang) / scale
    // A rotated copy reaches its own diagonal in the worst case, so the
    // destination window has to cover that or the copy is clipped to a box.
    const reach = Math.ceil((Math.hypot(sw, sh) * scale) / 2) + 1
    const hx = sw / 2 - 0.5, hy = sh / 2 - 0.5

    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        // Inverse map: destination offset -> source texel.
        const sx = (dx * cs + dy * sn) * flip + hx
        const sy = (-dx * sn + dy * cs) + hy
        if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue
        const px = (((ox + dx) % N) + N) % N
        const py = (((oy + dy) % N) + N) % N
        const o = (py * N + px) * 4
        const have = acc[o + 3]
        if (have >= SOLID) continue
        samplePremul(src, sw, sh, sx, sy, texel)
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
  return { acc, stamps }
}

/** Box-filter the N x N premultiplied accumulator down to OUT x OUT, opaque. */
function downres(acc) {
  const out = new Uint8Array(OUT * OUT * 4)
  const mean = [0, 0, 0]
  const cells = SUPER * SUPER
  for (let y = 0; y < OUT; y++) {
    for (let x = 0; x < OUT; x++) {
      const sum = [0, 0, 0]
      for (let j = 0; j < SUPER; j++) {
        for (let i = 0; i < SUPER; i++) {
          const o = ((y * SUPER + j) * N + (x * SUPER + i)) * 4
          // Un-premultiply first: alpha is 1 everywhere by construction, but
          // the last stamp on a pixel can leave it a hair under.
          const a = acc[o + 3] || 1
          sum[0] += acc[o] / a; sum[1] += acc[o + 1] / a; sum[2] += acc[o + 2] / a
        }
      }
      const o = (y * OUT + x) * 4
      for (let k = 0; k < 3; k++) {
        const lin = sum[k] / cells
        mean[k] += lin
        out[o + k] = toSrgb(lin)
      }
      out[o + 3] = 255
    }
  }
  return { out, mean: mean.map((m) => +(m / (OUT * OUT)).toFixed(4)) }
}

// --- run -------------------------------------------------------------------

const argv = process.argv.slice(2)
const arg = (flag, dflt) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : dflt)
const srcDir = arg('--src', 'tmp/leaves')
const outDir = arg('--out', 'public/trees')

let seed = 20260902
for (const mat of MATS) {
  const src = readPng(join(srcDir, mat.src))
  let opaque = 0
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] > 127) opaque++
  const { acc, stamps } = stampToFull(src.data, src.w, src.h, seed++)
  const { out, mean } = downres(acc)
  writePng(join(outDir, mat.out), { w: OUT, h: OUT, data: out })
  const cover = ((opaque / (src.w * src.h)) * 100).toFixed(1)
  console.log(`${mat.out.padEnd(22)} ${String(src.w).padStart(4)}x${String(src.h).padEnd(4)} ${cover.padStart(5)}% opaque`
    + `  ->  ${OUT}px  ${String(stamps).padStart(3)} stamps  linear mean ${mean.join(', ')}`)
}
