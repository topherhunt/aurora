// ---------------------------------------------------------------------------
// The pieces of a pick: its triangles joined through shared corners, welded by
// position because Tripo splits a vertex at every UV seam. Tripo models a
// button, a trigger or a strap as a closed lump of its own, so a piece is a
// part of the thing. The roster names one by a point in the pick's own frame
// (the piece holding the vertex nearest it) for ship.mjs to `cut` from the mesh
// or to paint its red texels as dark `glass`.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { magick } from '../../tripo-pack.mjs'
import { readAccessor } from './delight.mjs'

// A named point this far (pick units, the mesh's longest side ~1) from every vertex names nothing: a new pick, not a piece.
const NEAR = 0.02
// Loose enough for the fringe a JPEG blurs between red and its neighbours; the brass bezel around it, bright or in shadow, is r ~1.25 g.
const isRed = (r, g, b) => r > 30 && r > 1.4 * g && r > 1.4 * b
const GLASS = [16, 20, 26]
// Texels past a painted piece's own that are painted too, so a mip averaging across its UV island's edge does not bring the red back.
const BLEED_PX = 4

function primitive(file, json) {
  if (json.meshes.length !== 1 || json.meshes[0].primitives.length !== 1) throw new Error(`${file}: expected one mesh with one primitive`)
  const prim = json.meshes[0].primitives[0]
  if (prim.indices === undefined) throw new Error(`${file}: mesh is not indexed`)
  return prim
}

/** The piece of every triangle, as the welded index of one of its roots. */
export function piecesOf(pos, idx) {
  const weld = new Map(), wid = new Int32Array(pos.length / 3)
  for (let i = 0; i < wid.length; i++) {
    const k = `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`
    if (!weld.has(k)) weld.set(k, weld.size)
    wid[i] = weld.get(k)
  }
  const parent = Int32Array.from({ length: weld.size }, (_, i) => i)
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x }
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(wid[idx[t]])
    parent[find(wid[idx[t + 1]])] = a
    parent[find(wid[idx[t + 2]])] = a
  }
  return Int32Array.from({ length: idx.length / 3 }, (_, t) => find(wid[idx[t * 3]]))
}

/** The pieces the points name. Throws on a point near no vertex. */
function piecesAt(file, pos, idx, piece, points) {
  return new Set(points.map((p) => {
    let best = -1, bd = Infinity
    for (let t = 0; t < piece.length; t++) {
      for (let k = 0; k < 3; k++) {
        const i = idx[t * 3 + k]
        const d = (pos[i * 3] - p[0]) ** 2 + (pos[i * 3 + 1] - p[1]) ** 2 + (pos[i * 3 + 2] - p[2]) ** 2
        if (d < bd) { bd = d; best = piece[t] }
      }
    }
    if (Math.sqrt(bd) > NEAR) throw new Error(`${file}: no piece at ${p.join(', ')} (nearest vertex ${Math.sqrt(bd).toFixed(3)} away) -- a new pick wants its roster points measured again`)
    return best
  }))
}

/**
 * The GLB with the named pieces gone: their triangles dropped, the vertices
 * nothing else uses dropped with them and POSITION's box taken again. Every
 * original bufferView stays (the image among them); the primitive's accessors
 * point at fresh ones appended after, so the originals it read are orphans
 * ship.mjs's pack leaves behind.
 */
export function cutPieces(file, json, bin, points) {
  const prim = primitive(file, json)
  const pos = readAccessor(json, bin, prim.attributes.POSITION)
  const idx = readAccessor(json, bin, prim.indices)
  const piece = piecesOf(pos, idx)
  const drop = piecesAt(file, pos, idx, piece, points)
  const remap = new Int32Array(pos.length / 3).fill(-1)
  const kept = []
  let nv = 0
  for (let t = 0; t < piece.length; t++) {
    if (drop.has(piece[t])) continue
    for (let k = 0; k < 3; k++) {
      const i = idx[t * 3 + k]
      if (remap[i] < 0) remap[i] = nv++
      kept.push(remap[i])
    }
  }
  const order = new Int32Array(nv)
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) order[remap[i]] = i

  const views = json.bufferViews.map((v) => ({ ...v }))
  const parts = json.bufferViews.map((v) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength))
  let off = 0
  for (let k = 0; k < views.length; k++) {
    views[k].byteOffset = off
    const pad = (4 - (parts[k].length % 4)) % 4
    parts[k] = Buffer.concat([parts[k], Buffer.alloc(pad)])
    off += parts[k].length
  }
  const accessors = json.accessors.map((a) => ({ ...a }))
  const append = (arr, target) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
    views.push({ buffer: 0, byteOffset: off, byteLength: bytes.length, target })
    const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)])
    parts.push(padded)
    off += padded.length
    return views.length - 1
  }
  for (const [name, i] of Object.entries(prim.attributes)) {
    const src = readAccessor(json, bin, i)
    const n = src.length / accessors[i].count
    const out = new src.constructor(nv * n)
    for (let v = 0; v < nv; v++) for (let c = 0; c < n; c++) out[v * n + c] = src[order[v] * n + c]
    Object.assign(accessors[i], { bufferView: append(out, 34962), byteOffset: 0, count: nv })
    if (name === 'POSITION') {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
      for (let v = 0; v < nv; v++) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], out[v * 3 + c]); max[c] = Math.max(max[c], out[v * 3 + c]) }
      Object.assign(accessors[i], { min, max })
    }
  }
  const wide = nv > 0xffff
  Object.assign(accessors[prim.indices], {
    bufferView: append(wide ? Uint32Array.from(kept) : Uint16Array.from(kept), 34963),
    byteOffset: 0,
    count: kept.length,
    componentType: wide ? 5125 : 5123,
  })
  return { json: { ...json, accessors, bufferViews: views, buffers: [{ byteLength: off }] }, bin: Buffer.concat(parts), cut: piece.length - kept.length / 3 }
}

/**
 * `image` (the colour map, JPEG or PNG) with the red texels of the named
 * pieces' UV islands, and BLEED_PX past them, painted GLASS; as a PNG buffer.
 * Throws when there are none: the roster names a piece that is not red.
 */
export function paintGlass(file, image, json, bin, points) {
  const prim = primitive(file, json)
  const pos = readAccessor(json, bin, prim.attributes.POSITION)
  const idx = readAccessor(json, bin, prim.indices)
  const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0)
  const piece = piecesOf(pos, idx)
  const want = piecesAt(file, pos, idx, piece, points)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glass-'))
  try {
    const src = path.join(dir, image[0] === 0x89 ? 'colour.png' : 'colour.jpg')
    fs.writeFileSync(src, image)
    const [w, h] = magick(['identify', '-format', '%w %h', src]).split(' ').map(Number)
    const raw = path.join(dir, 'colour.rgb')
    magick([src, '-depth', '8', `rgb:${raw}`])
    const rgb = fs.readFileSync(raw)
    let hit = new Uint8Array(w * h)
    for (let t = 0; t < piece.length; t++) {
      if (!want.has(piece[t])) continue
      const [i0, i1, i2] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]]
      const x0 = uv[i0 * 2] * w, y0 = uv[i0 * 2 + 1] * h, x1 = uv[i1 * 2] * w, y1 = uv[i1 * 2 + 1] * h, x2 = uv[i2 * 2] * w, y2 = uv[i2 * 2 + 1] * h
      const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (Math.abs(det) < 1e-9) continue
      for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
          const px = x + 0.5, py = y + 0.5
          const l1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / det
          const l2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / det
          if (l1 >= -0.01 && l2 >= -0.01 && 1 - l1 - l2 >= -0.01) hit[y * w + x] = 1
        }
      }
    }
    for (let pass = 0; pass < BLEED_PX; pass++) {
      const next = Uint8Array.from(hit)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = y * w + x
        if (!hit[o] && ((x > 0 && hit[o - 1]) || (x < w - 1 && hit[o + 1]) || (y > 0 && hit[o - w]) || (y < h - 1 && hit[o + w]))) next[o] = 1
      }
      hit = next
    }
    let painted = 0
    for (let o = 0; o < w * h; o++) {
      if (!hit[o] || !isRed(rgb[o * 3], rgb[o * 3 + 1], rgb[o * 3 + 2])) continue
      rgb.set(GLASS, o * 3)
      painted++
    }
    if (!painted) throw new Error(`${file}: the glass pieces at ${points.map((p) => p.join(', ')).join('; ')} have no red texels to paint`)
    fs.writeFileSync(raw, rgb)
    const out = path.join(dir, 'glass.png')
    magick(['-size', `${w}x${h}`, '-depth', '8', `rgb:${raw}`, out])
    return { png: fs.readFileSync(out), painted }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
