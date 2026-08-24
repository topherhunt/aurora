// ---------------------------------------------------------------------------
// Zero-dependency PNG decode, node and browser off the same code path. §18.
//
// Everything under src/v2/height/ is three-free and has to run in node, which
// is what lets scripts/check-v2.mjs gate the imported world headlessly. That
// rules out the two obvious ways to read a PNG: an npm decoder (this repo ships
// exactly one runtime dependency and it is three) and the browser's own
// Image + canvas + getImageData path (no canvas in node).
//
// The canvas path would be wrong in the browser regardless. drawImage applies
// the file's colour management and premultiplies alpha before getImageData sees
// anything, so bytes come back off by a least significant bit in places, and
// the whole point of the rg16 encoding in scripts/make-heightmap.mjs is that
// the low byte survives the trip exactly. One bit of the high byte is 1.4 cm of
// cliff; one bit of the LOW byte is what makes the round-trip check in
// check-v2-heightmap.mjs assert quantisation error instead of decoder error.
//
// Scope: colour types 0/2/4/6 at bit depth 8 or 16, non-interlaced. Palette and
// Adam7 throw by name rather than degrading, per the repo's fail-explicitly
// rule -- a heightmap silently decoded through a palette would be a plausible
// looking world made of the wrong numbers, which is the worst failure mode
// available here.
// ---------------------------------------------------------------------------

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// PNG colour type -> samples per pixel. Type 3 (palette) is absent on purpose.
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 }

const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node

// Cached so a streaming decoder that touches a hundred tiles pays the module
// resolution once. The specifier is opaque to vite (@vite-ignore) and the
// branch is unreachable in a browser bundle, so nothing tries to shim zlib.
let nodeZlib = null

async function inflate(bytes) {
  if (IS_NODE) {
    if (!nodeZlib) nodeZlib = await import(/* @vite-ignore */ 'node:zlib')
    return new Uint8Array(nodeZlib.inflateSync(bytes))
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('png: no inflate available -- not node, and this browser has no DecompressionStream')
  }
  // 'deflate' is the zlib-wrapped variant, which is what an IDAT stream is.
  // 'deflate-raw' would reject the two-byte zlib header on the first chunk.
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// Reverses the per-scanline filters in place-ish: reads the inflated stream
// (one filter byte then `stride` bytes, per row) and writes the reconstructed
// rows out contiguously without the filter bytes.
//
// Every filter is defined on the RECONSTRUCTED bytes of the previous pixel and
// the previous row, never on the filtered ones, so this has to run strictly
// top-to-bottom left-to-right and cannot be vectorised per row. Getting the
// order or the bpp offset wrong produces an image that decodes without error
// and looks like a smear -- which is why check-v2-heightmap.mjs synthesises one
// PNG per filter type and demands an exact pixel match rather than eyeballing
// the result.
function unfilter(src, width, height, bpp) {
  const stride = width * bpp
  const out = new Uint8Array(stride * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    const ft = src[p++]
    const row = y * stride
    const prev = row - stride
    switch (ft) {
      case 0:
        for (let i = 0; i < stride; i++) out[row + i] = src[p + i]
        break
      case 1:
        for (let i = 0; i < bpp; i++) out[row + i] = src[p + i]
        for (let i = bpp; i < stride; i++) out[row + i] = (src[p + i] + out[row + i - bpp]) & 0xff
        break
      case 2:
        if (y === 0) for (let i = 0; i < stride; i++) out[row + i] = src[p + i]
        else for (let i = 0; i < stride; i++) out[row + i] = (src[p + i] + out[prev + i]) & 0xff
        break
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0
          const b = y > 0 ? out[prev + i] : 0
          out[row + i] = (src[p + i] + ((a + b) >> 1)) & 0xff
        }
        break
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0
          const b = y > 0 ? out[prev + i] : 0
          const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0
          out[row + i] = (src[p + i] + paeth(a, b, c)) & 0xff
        }
        break
      default:
        throw new Error(`png: unknown scanline filter ${ft} on row ${y} (PNG defines 0..4)`)
    }
    p += stride
  }
  return out
}

/**
 * Decode a PNG from bytes.
 * @param {Uint8Array} bytes
 * @returns {Promise<{width:number, height:number, channels:number, depth:number, data:Uint8Array|Uint16Array}>}
 *   `data` is row-major, `channels` samples per pixel, and is a Uint16Array in
 *   NATIVE order for depth 16 -- the file's big-endian pairs are converted here
 *   so no caller has to know which way round its machine is.
 */
export async function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`png: expected Uint8Array, got ${Object.prototype.toString.call(bytes)}`)
  if (bytes.length < 8) throw new Error(`png: ${bytes.length} bytes is too short to be a PNG`)
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error(`png: bad signature at byte ${i} (0x${bytes[i].toString(16)})`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let depth = 0
  let colourType = -1
  const idat = []
  let idatLength = 0
  let sawIhdr = false

  let off = 8
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off)
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7])
    const body = off + 8
    if (body + len + 4 > bytes.length) throw new Error(`png: chunk ${type} claims ${len} bytes but the file ends first`)
    if (type === 'IHDR') {
      width = view.getUint32(body)
      height = view.getUint32(body + 4)
      depth = bytes[body + 8]
      colourType = bytes[body + 9]
      const compression = bytes[body + 10]
      const filterMethod = bytes[body + 11]
      const interlace = bytes[body + 12]
      if (compression !== 0) throw new Error(`png: compression method ${compression} (only 0, deflate, exists)`)
      if (filterMethod !== 0) throw new Error(`png: filter method ${filterMethod} (only 0 exists)`)
      if (interlace !== 0) throw new Error('png: Adam7 interlaced image -- re-export non-interlaced')
      if (colourType === 3) throw new Error('png: palette (colour type 3) -- re-export as grayscale or RGB; a palette heightmap decodes to plausible garbage')
      if (CHANNELS[colourType] === undefined) throw new Error(`png: unknown colour type ${colourType}`)
      if (depth !== 8 && depth !== 16) throw new Error(`png: bit depth ${depth} -- only 8 and 16 are supported`)
      if (width === 0 || height === 0) throw new Error(`png: zero-sized image ${width}x${height}`)
      sawIhdr = true
    } else if (type === 'IDAT') {
      // Encoders split the zlib stream across as many IDATs as they like, and
      // the split can land mid-deflate-block, so these have to be concatenated
      // before a single inflate rather than inflated one at a time.
      idat.push(bytes.subarray(body, body + len))
      idatLength += len
    } else if (type === 'IEND') {
      break
    }
    off = body + len + 4
  }

  if (!sawIhdr) throw new Error('png: no IHDR chunk')
  if (idatLength === 0) throw new Error('png: no IDAT data')

  let deflated
  if (idat.length === 1) {
    deflated = idat[0]
  } else {
    deflated = new Uint8Array(idatLength)
    let at = 0
    for (const part of idat) {
      deflated.set(part, at)
      at += part.length
    }
  }

  const raw = await inflate(deflated)
  const channels = CHANNELS[colourType]
  const bpp = channels * (depth / 8)
  const stride = width * bpp
  const want = height * (stride + 1)
  if (raw.length !== want) throw new Error(`png: inflated to ${raw.length} bytes, expected ${want} for ${width}x${height} ${channels}ch@${depth}`)

  const flat = unfilter(raw, width, height, bpp)
  if (depth === 8) return { width, height, channels, depth, data: flat }

  const data = new Uint16Array(width * height * channels)
  for (let i = 0, b = 0; i < data.length; i++, b += 2) data[i] = (flat[b] << 8) | flat[b + 1]
  return { width, height, channels, depth, data }
}

/** Browser: fetch and decode. Throws on a non-2xx rather than decoding an error page. */
export async function loadPng(url) {
  if (IS_NODE) throw new Error('png: loadPng is the browser path -- use readPng in node')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`png: ${res.status} ${res.statusText} fetching ${url}`)
  return decodePng(new Uint8Array(await res.arrayBuffer()))
}

/** Node: read from disk and decode. */
export async function readPng(path) {
  if (!IS_NODE) throw new Error('png: readPng is the node path -- use loadPng in the browser')
  const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises')
  return decodePng(new Uint8Array(await readFile(path)))
}
