// Surface nets over the cave field (design/39-caves.md §4): one vertex per sign-changing voxel, one quad per sign-changing edge. Pure; runs in the cave worker.
//
// A chunk samples one voxel past each face but emits quads only for the edges it owns, so neighbouring chunks share their seam vertices exactly and the walls close without cracks.

import { PALETTES } from './regions.js'

export const CHUNK = 16
// Each LOD's voxel and the chunk gap CaveRoom draws it out to; all tile the same chunks. Past the last nothing is drawn, and only her region and those it touches ever are. The 2 m tier can drop a thin wall or close a narrow passage, which the black fog past 25 m hides.
export const LODS = [{ voxel: 0.5, to: 10 }, { voxel: 1, to: 25 }, { voxel: 2, to: 85 }]
export const CULL_M = LODS[LODS.length - 1].to

/** The tier of `lods` (one per LODS tier, null where missing) drawn at chunk gap `d`: the one wanted there, else the nearest present, since a tier may still be meshing or too coarse to catch a small surface. -1 past CULL_M or with none. */
export function drawnLod(lods, d) {
  const want = LODS.findIndex((l) => d < l.to)
  let lod = -1
  if (want >= 0) for (let l = 0; l < LODS.length; l++) if (lods[l] !== null && (lod < 0 || Math.abs(l - want) < Math.abs(lod - want))) lod = l
  return lod
}

/** The regions drawn from inside region `r`: it and the regions it touches. */
export function drawnRegions(graph, r) {
  return new Set([r, ...graph.regions[r].touch])
}

/** Metres from (x, y, z) to the nearest point of chunk `c`'s box, `c` holding its centre in x, y, z. */
export function chunkGap(c, x, y, z) {
  const h = CHUNK / 2
  return Math.hypot(Math.max(0, Math.abs(x - c.x) - h), Math.max(0, Math.abs(y - c.y) - h), Math.max(0, Math.abs(z - c.z) - h))
}

/** The chunk coordinates [i, j, k] worth building: those any prim's box reaches. */
export function chunkList(field) {
  const out = new Set()
  for (const p of field.prims) {
    for (let k = Math.floor(p.z0 / CHUNK); k <= Math.floor(p.z1 / CHUNK); k++) {
      for (let j = Math.floor(p.y0 / CHUNK); j <= Math.floor(p.y1 / CHUNK); j++) {
        for (let i = Math.floor(p.x0 / CHUNK); i <= Math.floor(p.x1 / CHUNK); i++) out.add(`${i},${j},${k}`)
      }
    }
  }
  return [...out].map((s) => s.split(',').map(Number))
}

/**
 * Meshes chunk [ci, cj, ck] on a grid of `voxel` metres. `lights` are [{ x, y, z, color, reach }] baked into the glow attribute where they can see the wall.
 * Returns null for a chunk with no surface, else { position, normal, color, glow, index, parts } typed arrays, the triangles grouped by region and `parts` holding [region, first index, index count] for each group.
 */
export function meshChunk(field, ci, cj, ck, lights, voxel = LODS[0].voxel) {
  const CELLS = Math.round(CHUNK / voxel)
  const S = CELLS + 3
  const idx = (i, j, k) => ((k + 1) * S + (j + 1)) * S + (i + 1)
  const ox = ci * CHUNK, oy = cj * CHUNK, oz = ck * CHUNK
  const pad = voxel * 2
  const list = field.primsIn(ox - pad, oy - pad, oz - pad, ox + CHUNK + pad, oy + CHUNK + pad, oz + CHUNK + pad)
  if (list.length === 0) return null
  const f = new Float32Array(S * S * S)
  let air = false, rock = false
  for (let k = -1; k <= CELLS + 1; k++) {
    for (let j = -1; j <= CELLS + 1; j++) {
      for (let i = -1; i <= CELLS + 1; i++) {
        const v = field.at(ox + i * voxel, oy + j * voxel, oz + k * voxel, list)
        f[idx(i, j, k)] = v
        if (v < 0) air = true; else rock = true
      }
    }
  }
  if (!air || !rock) return null

  // A vertex in every cell (-1..CELLS) whose corners disagree, at the mean of its edge crossings.
  const vid = new Int32Array(S * S * S).fill(-1)
  const pos = []
  const corner = new Float32Array(8)
  for (let k = -1; k <= CELLS; k++) {
    for (let j = -1; j <= CELLS; j++) {
      for (let i = -1; i <= CELLS; i++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const v = f[idx(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2))]
          corner[c] = v
          if (v < 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0, sy = 0, sz = 0, n = 0
        for (let c = 0; c < 8; c++) {
          for (let b = 0; b < 3; b++) {
            const d = c | (1 << b)
            if (d === c) continue
            const a0 = corner[c], a1 = corner[d]
            if ((a0 < 0) === (a1 < 0)) continue
            const t = a0 / (a0 - a1)
            sx += (c & 1) + (b === 0 ? t : 0)
            sy += ((c >> 1) & 1) + (b === 1 ? t : 0)
            sz += (c >> 2) + (b === 2 ? t : 0)
            n++
          }
        }
        vid[idx(i, j, k)] = pos.length / 3
        pos.push(ox + (i + sx / n) * voxel, oy + (j + sy / n) * voxel, oz + (k + sz / n) * voxel)
      }
    }
  }

  // A quad across every owned edge whose ends disagree, wound to face the air.
  const index = []
  const used = new Uint8Array(pos.length / 3)
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d)
    used[a] = used[b] = used[c] = used[d] = 1
  }
  for (let k = 0; k < CELLS; k++) {
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const v = f[idx(i, j, k)]
        const air0 = v < 0
        if (air0 !== (f[idx(i + 1, j, k)] < 0)) quad(vid[idx(i, j - 1, k - 1)], vid[idx(i, j, k - 1)], vid[idx(i, j, k)], vid[idx(i, j - 1, k)], air0)
        if (air0 !== (f[idx(i, j + 1, k)] < 0)) quad(vid[idx(i - 1, j, k - 1)], vid[idx(i - 1, j, k)], vid[idx(i, j, k)], vid[idx(i, j, k - 1)], air0)
        if (air0 !== (f[idx(i, j, k + 1)] < 0)) quad(vid[idx(i - 1, j - 1, k)], vid[idx(i, j - 1, k)], vid[idx(i, j, k)], vid[idx(i - 1, j, k)], air0)
      }
    }
  }
  if (index.length === 0) return null

  // Keep only vertices a quad uses, then shade them.
  const remap = new Int32Array(used.length).fill(-1)
  let count = 0
  for (let v = 0; v < used.length; v++) if (used[v]) remap[v] = count++
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)
  const glow = new Float32Array(count * 3)
  const regionOf = new Int32Array(count)
  const e = 0.25
  const near = lights.filter((l) => l.x + l.reach > ox && l.x - l.reach < ox + CHUNK && l.y + l.reach > oy && l.y - l.reach < oy + CHUNK && l.z + l.reach > oz && l.z - l.reach < oz + CHUNK)
  for (let v = 0; v < used.length; v++) {
    const o = remap[v]
    if (o < 0) continue
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    position[o * 3] = x; position[o * 3 + 1] = y; position[o * 3 + 2] = z
    let nx = field.at(x - e, y, z, list) - field.at(x + e, y, z, list)
    let ny = field.at(x, y - e, z, list) - field.at(x, y + e, z, list)
    let nz = field.at(x, y, z - e, list) - field.at(x, y, z + e, list)
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    normal[o * 3] = nx; normal[o * 3 + 1] = ny; normal[o * 3 + 2] = nz

    // Occlusion: how much rock crowds the open air just off the wall.
    let occ = 0
    for (const s of [0.5, 1.2, 2.4]) occ += Math.max(0, s + field.at(x + nx * s, y + ny * s, z + nz * s, list)) / s
    const ao = Math.max(0.35, 1 - occ * 0.32)

    field.at(x, y, z, list)
    const region = field.owner < 0 ? 0 : field.prims[field.owner].region
    regionOf[o] = region
    const pal = PALETTES[field.graph.regions[region].palette]
    const band = Math.sin(y * 1.9 + 2.2 * field.noise.at3(x * 0.15, y * 0.3, z * 0.15))
    const base = ny > 0.65 ? pal.floor : band > 0.55 ? pal.vein : pal.rock
    const grain = 0.85 + 0.3 * (0.5 + 0.5 * field.floorNoise.at2(x * 3.1 + y * 1.7, z * 3.1 - y * 1.3))
    color[o * 3] = base[0] * ao * grain; color[o * 3 + 1] = base[1] * ao * grain; color[o * 3 + 2] = base[2] * ao * grain

    let gr = 0, gg = 0, gb = 0
    for (const l of near) {
      const lx = l.x - x, ly = l.y - y, lz = l.z - z
      const d = Math.hypot(lx, ly, lz)
      if (d >= l.reach) continue
      const facing = (lx * nx + ly * ny + lz * nz) / (d || 1)
      if (facing <= 0) continue
      let lit = 1
      for (let s = 1; s < 5 && lit > 0; s++) if (field.at(x + (lx * s) / 5, y + (ly * s) / 5, z + (lz * s) / 5) > 0.25) lit = 0
      const fall = (1 - d / l.reach) ** 2 * facing * lit * l.power
      gr += l.color[0] * fall; gg += l.color[1] * fall; gb += l.color[2] * fall
    }
    glow[o * 3] = gr * ao; glow[o * 3 + 1] = gg * ao; glow[o * 3 + 2] = gb * ao
  }
  // Triangles grouped by their first vertex's region, so the room can draw a region's share of the chunk alone.
  const byRegion = new Map()
  for (let t = 0; t < index.length; t += 3) {
    const r = regionOf[remap[index[t]]]
    if (!byRegion.has(r)) byRegion.set(r, [])
    byRegion.get(r).push(t)
  }
  const out = new (count > 65535 ? Uint32Array : Uint16Array)(index.length)
  const parts = new Int32Array(byRegion.size * 3)
  let w = 0, p = 0
  for (const [r, tris] of byRegion) {
    parts[p++] = r; parts[p++] = w; parts[p++] = tris.length * 3
    for (const t of tris) { out[w++] = remap[index[t]]; out[w++] = remap[index[t + 1]]; out[w++] = remap[index[t + 2]] }
  }
  return { position, normal, color, glow, index: out, parts }
}
