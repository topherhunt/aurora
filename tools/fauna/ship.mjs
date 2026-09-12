// ---------------------------------------------------------------------------
// Ships every roster fish into public/fauna/, the world's only view of the
// bench's art:
//
//   node tools/fauna/ship.mjs
//
// Writes public/fauna/fish.json -- one lofted LOD0 mesh per species
// (loft-fish-mesh.mjs, ~75 triangles), with the side view projected onto it
// as UVs -- and public/fauna/<id>.png, the keyed cutout of that side view
// downsampled to TEX_WIDTH. The projection is planar: every vertex takes the
// texel the silhouette has at its own (z, y), so both flanks wear the one
// painted profile and the fin triangles, which overshoot the painted fin,
// are trimmed back to it by the material's alphaTest. Re-run after picking
// a new side view in gen-fish.html, and commit what it writes.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeSheet, keyBackground, silhouetteProfile, columnProfile } from '../characters/chromakey.mjs'
import { writePng } from '../props/png.mjs'
import { buildFishMesh } from './loft-fish-mesh.mjs'
import { SPECIES } from './fish-roster.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/fauna')
// A fish is a hand's width on screen at the range the murk allows, so a 256 px sheet is already more than any texel will be drawn at.
const TEX_WIDTH = 256

/** Alpha-weighted box downsample of a keyed crop, so the magenta the key half-removed at the edge does not bleed back in as a fringe. */
function downsample(crop, factor) {
  const w = Math.ceil(crop.w / factor), h = Math.ceil(crop.h / factor)
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y * factor; sy < Math.min(crop.h, (y + 1) * factor); sy++) {
        for (let sx = x * factor; sx < Math.min(crop.w, (x + 1) * factor); sx++) {
          const i = (sy * crop.w + sx) * 4
          const wa = crop.rgba[i + 3]
          r += crop.rgba[i] * wa; g += crop.rgba[i + 1] * wa; b += crop.rgba[i + 2] * wa
          a += wa; n++
        }
      }
      const o = (y * w + x) * 4
      if (a > 0) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a }
      out[o + 3] = a / n
    }
  }
  return { w, h, rgba: out }
}

fs.mkdirSync(OUT, { recursive: true })
const species = []
for (const s of SPECIES) {
  const file = path.join(ROOT, 'tools/fauna/sheets', s.id, 'side.png')
  if (!fs.existsSync(file)) throw new Error(`${s.id}: no picked side view at ${path.relative(ROOT, file)} -- pick one in gen-fish.html`)
  const decoded = decodeSheet(file)
  // closeRadius 4 for the same reason vite.config.js's /__fish-reference uses it: one solid silhouette, and a purple species keyed against magenta keeps its body.
  const alpha = keyBackground(decoded, { closeRadius: 4 })
  const rows = silhouetteProfile(alpha, decoded.w, decoded.h)
  const cp = columnProfile(alpha, decoded.w, decoded.h)
  const lengthM = s.lengthCm / 100
  const mesh = buildFishMesh(cp, { lengthM, lod: 0 })

  // The crop is the silhouette's tight box; the mesh maps back into it through the loft's own pxToM and yShift.
  const left = cp.left, right = cp.right, top = rows.top, bottom = rows.bottom
  const cw = right - left + 1, ch = bottom - top + 1
  const crop = { w: cw, h: ch, rgba: new Uint8Array(cw * ch * 4) }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = ((y + top) * decoded.w + (x + left)) * 4
      const dst = (y * cw + x) * 4
      crop.rgba[dst] = decoded.rgba[src]; crop.rgba[dst + 1] = decoded.rgba[src + 1]; crop.rgba[dst + 2] = decoded.rgba[src + 2]
      crop.rgba[dst + 3] = alpha[(y + top) * decoded.w + (x + left)]
    }
  }
  const uv = []
  for (let i = 0; i < mesh.pos.length; i += 3) {
    const y = mesh.pos[i + 1], z = mesh.pos[i + 2]
    const px = left + (z / lengthM + 0.5) * (right - left)
    const py = -(y - mesh.yShift) / mesh.pxToM
    // v runs bottom-up: three flips PNG rows on upload (flipY), so v=0 is the crop's last row.
    uv.push((px - left) / cw, 1 - (py - top) / ch)
  }

  const factor = Math.max(1, Math.ceil(cw / TEX_WIDTH))
  const tex = downsample(crop, factor)
  writePng(path.join(OUT, `${s.id}.png`), tex.w, tex.h, tex.rgba, 4)

  const round = (v) => Math.round(v * 1e4) / 1e4
  species.push({
    id: s.id,
    lengthM,
    texture: `${s.id}.png`,
    pos: mesh.pos.map(round),
    nrm: mesh.nrm.map(round),
    uv: uv.map(round),
    bend: mesh.bend.map(round),
    idx: mesh.idx,
  })
  console.log(`ship ${s.id}: ${mesh.idx.length / 3} tris, ${lengthM} m, texture ${tex.w}x${tex.h} (crop ${cw}x${ch} / ${factor})`)
}
fs.writeFileSync(path.join(OUT, 'fish.json'), JSON.stringify({ species }) + '\n')
console.log(`wrote public/fauna/fish.json with ${species.length} species`)
