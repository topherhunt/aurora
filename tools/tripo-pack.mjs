// ---------------------------------------------------------------------------
// What the two shippers of Tripo picks share (tools/fauna/ship.mjs,
// tools/creatures/ship.mjs): reading a GLB's chunks, finding the base colour
// and metallic-roughness JPEGs Tripo embeds, and packing them into ONE WebP --
// the colour boxed down, with Tripo's roughness in its alpha -- plus the mean
// of the metalness map as a scalar. One texture on the GPU carries both, since
// an RGB upload is padded to RGBA anyway; the material reads roughness from
// the alpha of its colour sample (critters.js packedPbr). WebP because JPEG
// has no alpha and a PNG of a photographic map is five times the download.
// Needs ImageMagick 7 (`magick`) on the path.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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

/** The base colour and metallic-roughness JPEGs of material `m`. Throws on a pick generated with pbr off, which has no roughness to ship. */
export function tripoJpegs(file, json, bin, m) {
  const pbr = json.materials[m].pbrMetallicRoughness
  const jpeg = (slot, what) => {
    if (!pbr[slot]) throw new Error(`${file}: no ${what} map -- the pick was generated with pbr off`)
    const image = json.images[json.textures[pbr[slot].index].source]
    if (image.mimeType !== 'image/jpeg') throw new Error(`${file}: ${what} is ${image.mimeType}, expected JPEG`)
    return viewOf(json, bin, image.bufferView)
  }
  // glTF's occlusion-roughness-metallic pack: roughness in G, metalness in B.
  return { jpeg: jpeg('baseColorTexture', 'base colour'), orm: jpeg('metallicRoughnessTexture', 'metallic-roughness') }
}

/** Loudly, and with the command, because the next person's machine is the one this fails on. */
export function magick(args) {
  try {
    return execFileSync('magick', args, { stdio: 'pipe' }).toString('utf8')
  } catch (e) {
    throw new Error(`ship: ImageMagick failed. Ran: magick ${args.join(' ')}\n${e.message}`)
  }
}

// Roughness ships no lower than this, which is where three clamps it in the shader (lights_physical_fragment) so the floor costs no shading. It matters because it is the ALPHA: a texel at zero is one whose colour a lossy encoder is free to drop and a premultiplying decoder cannot get back, and 12% of the glimmerfin's map is Tripo's zero.
export const ROUGHNESS_FLOOR = 0.0525

/**
 * The colour map boxed down to `texPx` a side with the roughness map's G
 * channel as its alpha, written to `out`; returns the mean of the metalness
 * (B) channel. The two source JPEGs go through a temp dir because magick reads
 * files, not glb chunks. `webp:exact` keeps the colour under low alpha as it
 * is, which libwebp otherwise rewrites to compress better.
 */
export function packTexture({ jpeg, orm }, out, texPx) {
  if (!(texPx > 0)) throw new Error(`packTexture: bad size ${texPx}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pack-'))
  try {
    const colour = path.join(dir, 'colour.jpg'), rough = path.join(dir, 'orm.jpg')
    fs.writeFileSync(colour, jpeg)
    fs.writeFileSync(rough, orm)
    const size = `${texPx}x${texPx}`
    magick([colour, '-resize', size, '(', rough, '-resize', size, '-channel', 'G', '-separate', '+channel', '-evaluate', 'Max', `${ROUGHNESS_FLOOR * 100}%`, ')', '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', '-define', 'webp:exact=true', '-quality', '90', out])
    const metalness = Number(magick([rough, '-channel', 'B', '-separate', '+channel', '-format', '%[fx:mean]', 'info:']))
    if (!(metalness >= 0 && metalness <= 1)) throw new Error(`ship: metalness mean of ${rough} came out ${metalness}`)
    return metalness
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
