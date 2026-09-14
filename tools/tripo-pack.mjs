// ---------------------------------------------------------------------------
// What the two shippers of Tripo picks share (tools/fauna/ship.mjs,
// tools/creatures/ship.mjs): reading a GLB's chunks, finding the base colour
// JPEG Tripo embeds, and boxing it down to the creature's shipping size as a
// WebP. Only the colour ships. Tripo's roughness/metalness and normal maps stay
// in the work dir with the pick and are never packed: the roughness was tried
// as per-texel shine on frogs, crabs and fish and is too inaccurate, and the
// normal map is too subtle to earn a channel (design/27-creature-pipeline.md).
// Needs ImageMagick 7 (`magick`) on the path.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { TEX_PX_MAX } from './creatures/creature-roster.mjs'

/** The JSON and BIN chunks of a GLB. */
export function readGlbChunks(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB (bad magic)`)
  let off = 12, json = null, bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json || !bin) throw new Error(`${file}: missing JSON or BIN chunk`)
  return { json, bin }
}

/** The bytes of bufferView `i`. */
export function viewOf(json, bin, i) {
  const v = json.bufferViews[i]
  return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
}

/** The base colour JPEG of material `m`. */
export function tripoColourJpeg(file, json, bin, m) {
  const slot = json.materials[m].pbrMetallicRoughness?.baseColorTexture
  if (!slot) throw new Error(`${file}: no base colour map -- the pick was generated without a texture`)
  const image = json.images[json.textures[slot.index].source]
  if (image.mimeType !== 'image/jpeg') throw new Error(`${file}: base colour is ${image.mimeType}, expected JPEG`)
  return viewOf(json, bin, image.bufferView)
}

/** Loudly, and with the command, because the next person's machine is the one this fails on. */
export function magick(args) {
  try {
    return execFileSync('magick', args, { stdio: 'pipe' }).toString('utf8')
  } catch (e) {
    throw new Error(`ship: ImageMagick failed. Ran: magick ${args.join(' ')}\n${e.message}`)
  }
}

/**
 * Width and height of a WebP from its header, so a gate can hold a shipped map
 * to the cap without ImageMagick. Covers the three container layouts libwebp
 * writes: lossy VP8, lossless VP8L and the extended VP8X.
 */
export function webpSize(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP')
  const chunk = buf.toString('latin1', 12, 16)
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  throw new Error(`unknown WebP chunk ${chunk}`)
}

/**
 * The colour map boxed down to `texPx` a side, written to `out` as an opaque
 * WebP. The JPEG goes through a temp dir because magick reads files, not glb
 * chunks. Refuses a size over TEX_PX_MAX: this is the one door into public/.
 */
export function packTexture(jpeg, out, texPx) {
  if (!(texPx > 0 && texPx <= TEX_PX_MAX)) throw new Error(`packTexture: ${texPx}px is not within the ${TEX_PX_MAX}px cap`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pack-'))
  try {
    const colour = path.join(dir, 'colour.jpg')
    fs.writeFileSync(colour, jpeg)
    magick([colour, '-resize', `${texPx}x${texPx}`, '-alpha', 'off', '-quality', '90', out])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
