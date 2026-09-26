// ---------------------------------------------------------------------------
// Takes the baked top-down light out of a pick's colour map.
//
//   node tools/props/gen/delight.mjs <id>     preview only, nothing shipped
//
// Tripo paints the side of a thing the concept image never showed, and it
// paints it in shadow: the fallen log's map is five times darker where the
// mesh faces down than where it faces up, a gradient the world's own light
// then adds to again, and which is what the far card photographs on its
// flanks. The map should be albedo -- flat -- and the sun and the ground do
// the shading at runtime.
//
// The fit is the map's luminance against the mesh's own normal, rasterised
// into UV space: L ~ a + b * normal.y, least squares over every texel the mesh
// covers. Each texel is then scaled to the fit's mean, capped at GAIN_MAX so a
// texel the fit puts near black is brightened, not blown out, and texels the
// mesh never touches take their nearest covered neighbour's gain so a mip that
// averages across a UV island's edge does not pull the shadow back in. Hue is
// untouched: one gain for all three channels.
//
// The roster's `delight` flag makes ship.mjs run this on the way to the WebP.
// Run bare it writes work/<id>/delight-preview.png, the map before and after
// side by side, and prints the luminance by facing before and after, which is
// how to judge whether a prop wants the flag.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { magick, readGlbChunks, tripoColourJpeg, viewOf } from '../../tripo-pack.mjs'
import { readMeta, readState, workDir } from './workspace.mjs'

// The most a texel is brightened by. The log's fit asks for ~3x at straight
// down; past this the map's own noise is what is being amplified.
const GAIN_MAX = 4

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const ARRAYS = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }

/** Accessor `i` as a typed array. Tightly packed, which is what Tripo and three's exporter write. */
export function readAccessor(json, bin, i) {
  const acc = json.accessors[i]
  const view = json.bufferViews[acc.bufferView]
  const Arr = ARRAYS[acc.componentType]
  const n = COMPONENTS[acc.type]
  if (!Arr || !n) throw new Error(`delight: accessor ${i} is ${acc.type}/${acc.componentType}, which this reader does not carry`)
  if (view.byteStride && view.byteStride !== n * Arr.BYTES_PER_ELEMENT) throw new Error(`delight: accessor ${i} is interleaved`)
  const off = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  return new Arr(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + acc.count * n * Arr.BYTES_PER_ELEMENT))
}

/** The pick's normals in the frame the map was baked in, its UVs and its triangles. */
export function meshOf(file) {
  const { json, bin } = readGlbChunks(file)
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  const prim = json.meshes[0].primitives[0]
  if (prim.indices === undefined) throw new Error(`${file}: mesh is not indexed`)
  const nrm = readAccessor(json, bin, prim.attributes.NORMAL)
  const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0)
  const idx = readAccessor(json, bin, prim.indices)
  // Up is the NODE's up: Tripo's node carries a yaw, and a yaw moves nothing
  // off Y, but a mesh under any other matrix would fit the wrong axis.
  const node = json.nodes.find((n) => n.mesh !== undefined)
  const m = node.matrix
  if (m && (Math.abs(m[1]) > 1e-6 || Math.abs(m[9]) > 1e-6 || Math.abs(m[5] - 1) > 1e-6)) {
    throw new Error(`${file}: the mesh node turns Y, and the fit reads normal.y as up`)
  }
  return { nrm, uv, idx, json, bin }
}

/**
 * The map delighted, in place: `rgb` is W x W x 3 bytes, glTF UV origin top-left.
 * Returns the fit and the mean luminance by facing before and after.
 */
export function delight(rgb, W, { nrm, uv, idx }) {
  const ny = new Float32Array(W * W)
  const hit = new Uint8Array(W * W)
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2]
    const x0 = uv[i0 * 2] * W, y0 = uv[i0 * 2 + 1] * W
    const x1 = uv[i1 * 2] * W, y1 = uv[i1 * 2 + 1] * W
    const x2 = uv[i2 * 2] * W, y2 = uv[i2 * 2 + 1] * W
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
    if (Math.abs(det) < 1e-9) continue
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)))
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(W - 1, Math.ceil(Math.max(y0, y1, y2)))
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5
        const l1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / det
        const l2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / det
        const l0 = 1 - l1 - l2
        // A hair of slack so the texels a triangle's edge runs through are its.
        if (l0 < -0.01 || l1 < -0.01 || l2 < -0.01) continue
        const o = y * W + x
        ny[o] = l0 * nrm[i0 * 3 + 1] + l1 * nrm[i1 * 3 + 1] + l2 * nrm[i2 * 3 + 1]
        hit[o] = 1
      }
    }
  }

  const lum = (o) => (0.2126 * rgb[o * 3] + 0.7152 * rgb[o * 3 + 1] + 0.0722 * rgb[o * 3 + 2]) / 255
  // Least squares L = a + b * ny over the covered texels.
  let n = 0, sy = 0, syy = 0, sl = 0, syl = 0
  for (let o = 0; o < W * W; o++) {
    if (!hit[o]) continue
    const y = ny[o], l = lum(o)
    n++; sy += y; syy += y * y; sl += l; syl += y * l
  }
  if (n < W * W * 0.05) throw new Error(`delight: the mesh covers ${n} of ${W * W} texels -- the UVs do not match this map`)
  const b = (n * syl - sy * sl) / (n * syy - sy * sy)
  const a = (sl - b * sy) / n
  const mean = sl / n
  const before = facing(rgb, W, ny, hit, lum)

  // Gain per texel, then spread to the uncovered texels from the nearest
  // covered one, pass by pass, so nothing under a UV seam keeps the old level.
  const gain = new Float32Array(W * W)
  let open = 0
  for (let o = 0; o < W * W; o++) {
    if (hit[o]) gain[o] = Math.min(GAIN_MAX, Math.max(1 / GAIN_MAX, mean / Math.max(1e-3, a + b * ny[o])))
    else open++
  }
  const filled = Uint8Array.from(hit)
  while (open > 0) {
    let spread = 0
    const next = Uint8Array.from(filled)
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const o = y * W + x
        if (filled[o]) continue
        let sum = 0, k = 0
        if (x > 0 && filled[o - 1]) { sum += gain[o - 1]; k++ }
        if (x < W - 1 && filled[o + 1]) { sum += gain[o + 1]; k++ }
        if (y > 0 && filled[o - W]) { sum += gain[o - W]; k++ }
        if (y < W - 1 && filled[o + W]) { sum += gain[o + W]; k++ }
        if (k === 0) continue
        gain[o] = sum / k
        next[o] = 1
        spread++
      }
    }
    if (spread === 0) throw new Error('delight: uncovered texels with no covered neighbour anywhere -- an empty map?')
    filled.set(next)
    open -= spread
  }
  for (let o = 0; o < W * W; o++) {
    const g = gain[o]
    for (let c = 0; c < 3; c++) rgb[o * 3 + c] = Math.min(255, Math.round(rgb[o * 3 + c] * g))
  }
  return { a, b, mean, covered: n / (W * W), before, after: facing(rgb, W, ny, hit, lum) }
}

/** Mean luminance in five bands of normal.y from straight down to straight up. */
function facing(rgb, W, ny, hit, lum) {
  const bands = Array.from({ length: 5 }, () => ({ n: 0, l: 0 }))
  for (let o = 0; o < W * W; o++) {
    if (!hit[o]) continue
    const band = bands[Math.min(4, Math.floor(((ny[o] + 1) / 2) * 5))]
    band.n++
    band.l += lum(o)
  }
  return bands.map((band) => (band.n ? band.l / band.n : NaN))
}

/**
 * The pick's colour JPEG delighted against the pick's mesh, as a PNG buffer
 * for packTexture to box. `file` is the pick's GLB, `jpeg` its embedded map.
 */
export function delightJpeg(file, jpeg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delight-'))
  try {
    const src = path.join(dir, 'colour.jpg')
    fs.writeFileSync(src, jpeg)
    const [w, h] = magick(['identify', '-format', '%w %h', src]).split(' ').map(Number)
    if (w !== h) throw new Error(`${file}: the colour map is ${w}x${h}, and the fit rasterises a square`)
    const raw = path.join(dir, 'colour.rgb')
    magick([src, '-depth', '8', `rgb:${raw}`])
    const rgb = fs.readFileSync(raw)
    const fit = delight(rgb, w, meshOf(file))
    fs.writeFileSync(raw, rgb)
    const out = path.join(dir, 'delit.png')
    magick(['-size', `${w}x${h}`, '-depth', '8', `rgb:${raw}`, out])
    return { png: fs.readFileSync(out), fit, side: w }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const id = process.argv[2]
  if (!id) throw new Error('usage: node tools/props/gen/delight.mjs <id>')
  readMeta(id)
  const { pickedMesh } = readState(id)
  if (!pickedMesh) throw new Error(`${id}: no picked mesh -- pick one in gen-prop.html first`)
  const file = path.join(workDir(id), 'meshes', pickedMesh)
  const { json, bin } = readGlbChunks(file)
  const jpeg = tripoColourJpeg(file, json, bin, 0)
  const { png, fit, side } = delightJpeg(file, jpeg)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delight-'))
  try {
    fs.writeFileSync(path.join(dir, 'before.jpg'), jpeg)
    fs.writeFileSync(path.join(dir, 'after.png'), png)
    const preview = path.join(workDir(id), 'delight-preview.png')
    magick([path.join(dir, 'before.jpg'), path.join(dir, 'after.png'), '-resize', '1024x1024', '+append', preview])
    console.log(`${id}: L ~ ${fit.a.toFixed(3)} + ${fit.b.toFixed(3)} * normal.y over ${(fit.covered * 100).toFixed(0)}% of ${side}px, mean ${fit.mean.toFixed(3)}`)
    const row = (l) => l.map((v) => v.toFixed(3)).join('  ')
    console.log(`  luminance down..up  before  ${row(fit.before)}`)
    console.log(`                      after   ${row(fit.after)}`)
    console.log(`  wrote ${path.relative(process.cwd(), preview)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
