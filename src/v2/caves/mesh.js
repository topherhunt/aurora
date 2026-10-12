// Surface nets over the cave field (design/39-caves.md §4): one vertex per sign-changing voxel, one quad per sign-changing edge. Pure; runs in the cave worker.
//
// A chunk samples one voxel past each face but emits quads only for the edges it owns, so neighbouring chunks share their seam vertices exactly and the walls close without cracks. Every LOD is the finest mesh vertex-clustered, the seam rows (cells -1 and CELLS-1 on any axis) clustered at 1 m in every tier: a chunk's seam is the same at every tier, so a coarse chunk meets a finer neighbour without a crack.

import { PALETTES } from './regions.js'

export const CHUNK = 16
// Each LOD's cluster size and the chunk gap CaveRoom draws it out to; all tile the same chunks. Past the last nothing is drawn, and only her region and those it touches ever are. The 2 m and 4 m tiers can drop a thin wall or close a narrow passage, which the black fog past 25 m hides.
export const LODS = [{ voxel: 0.5, to: 10 }, { voxel: 1, to: 25 }, { voxel: 2, to: 50 }, { voxel: 4, to: 85 }]
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
 * Meshes chunk [ci, cj, ck] at every LOD, an array with one entry per LODS tier. `lights` are [{ x, y, z, color, reach, power }] baked into the glow attribute where they can see the wall, or into the `day` scalar for a light with `day` set, which the room tints by the hour.
 * Each entry is null where the tier has no surface, else { position, normal, color, glow, day, index, parts } typed arrays, the triangles grouped by region and `parts` holding [region, first index, index count] for each group.
 */
export function meshChunk(field, ci, cj, ck, lights) {
  const voxel = LODS[0].voxel
  const none = LODS.map(() => null)
  const CELLS = Math.round(CHUNK / voxel)
  const S = CELLS + 3
  const idx = (i, j, k) => ((k + 1) * S + (j + 1)) * S + (i + 1)
  const ox = ci * CHUNK, oy = cj * CHUNK, oz = ck * CHUNK
  const pad = voxel * 2
  const list = field.primsIn(ox - pad, oy - pad, oz - pad, ox + CHUNK + pad, oy + CHUNK + pad, oz + CHUNK + pad)
  if (list.length === 0) return none
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
  if (!air || !rock) return none

  // A vertex in every cell (-1..CELLS) whose corners disagree, at the mean of its edge crossings.
  const vid = new Int32Array(S * S * S).fill(-1)
  const pos = [], cell = []
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
        cell.push(i, j, k)
      }
    }
  }

  // A quad across every owned edge whose ends disagree, wound to face the air.
  const index = []
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) index.push(a, c, b, a, d, c); else index.push(a, b, c, a, c, d)
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
  if (index.length === 0) return none
  return LODS.map((l, lod) => {
    const m = cluster(pos, cell, index, Math.round(l.voxel / voxel), CELLS)
    return m.index.length === 0 ? null : shade(field, list, lights, ox, oy, oz, m.pos, m.index)
  })
}

// The fine mesh with every vertex merged into one per `k`-cell cube, at their mean, and the triangles that collapse dropped. A seam row's vertices merge in pairs along the face instead, the same at every tier. Cell CELLS's vertices belong to no triangle and are skipped: their cube slot would spill into the next row's. A seam vertex whose every triangle the cubes collapse keeps those triangles with their fine corners, or it would vanish from this tier only and open a crack.
function cluster(pos, cell, index, k, CELLS) {
  const H = 2
  const G = Math.ceil(CELLS / k), K = CELLS / H + 3
  const axis = (c) => (c === -1 ? -1 : c === CELLS - 1 ? -2 : Math.floor(c / H))
  const slot = new Int32Array(G * G * G).fill(-1)
  const seams = new Map()
  const rep = new Int32Array(pos.length / 3)
  const onSeam = new Uint8Array(rep.length)
  const out = [], sum = []
  for (let v = 0; v < rep.length; v++) {
    const i = cell[v * 3], j = cell[v * 3 + 1], q = cell[v * 3 + 2]
    let o
    if (i === CELLS || j === CELLS || q === CELLS) continue
    if (i === -1 || j === -1 || q === -1 || i === CELLS - 1 || j === CELLS - 1 || q === CELLS - 1) {
      const key = ((axis(q) + 2) * K + axis(j) + 2) * K + axis(i) + 2
      o = seams.get(key)
      onSeam[v] = 1
      if (o === undefined) { o = out.length / 3; seams.set(key, o); out.push(0, 0, 0); sum.push(0) }
    } else {
      const g = (Math.floor(q / k) * G + Math.floor(j / k)) * G + Math.floor(i / k)
      if (slot[g] < 0) { slot[g] = out.length / 3; out.push(0, 0, 0); sum.push(0) }
      o = slot[g]
    }
    out[o * 3] += pos[v * 3]; out[o * 3 + 1] += pos[v * 3 + 1]; out[o * 3 + 2] += pos[v * 3 + 2]
    sum[o]++
    rep[v] = o
  }
  for (let o = 0; o < sum.length; o++) if (sum[o] > 1) { out[o * 3] /= sum[o]; out[o * 3 + 1] /= sum[o]; out[o * 3 + 2] /= sum[o] }
  const tris = []
  for (let t = 0; t < index.length; t += 3) {
    const a = rep[index[t]], b = rep[index[t + 1]], c = rep[index[t + 2]]
    if (a !== b && b !== c && a !== c) tris.push(a, b, c)
  }
  const used = new Set(tris)
  for (let t = 0; t < index.length; t += 3) {
    const corners = [index[t], index[t + 1], index[t + 2]]
    if (!corners.some((v) => onSeam[v] && !used.has(rep[v]))) continue
    const own = corners.map((v) => (onSeam[v] ? rep[v] : -1 - v))
    if (own[0] === own[1] || own[1] === own[2] || own[0] === own[2]) continue
    for (const v of corners) {
      if (onSeam[v]) { used.add(rep[v]); tris.push(rep[v]); continue }
      tris.push(out.length / 3)
      out.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
    }
  }
  return { pos: out, index: tris }
}

/** The lights whose reach touches the CHUNK cube at (ox, oy, oz). */
export function lightsIn(lights, ox, oy, oz) {
  return lights.filter((l) => l.x + l.reach > ox && l.x - l.reach < ox + CHUNK && l.y + l.reach > oy && l.y - l.reach < oy + CHUNK && l.z + l.reach > oz && l.z - l.reach < oz + CHUNK)
}

// Floats rockAt writes: normal, colour, glow, daylight.
export const ROCK_AT = 10

/** The rock as baked at surface point (x, y, z): into `out` its normal, region colour under occlusion and grain, the glow of the lights in `near` and their daylight (out[9]). Returns its region. The room asks it at a prop's foot, so the prop wears the rock it stands on. */
export function rockAt(field, x, y, z, near, out, list) {
  const e = 0.25
  let nx = field.at(x - e, y, z, list) - field.at(x + e, y, z, list)
  let ny = field.at(x, y - e, z, list) - field.at(x, y + e, z, list)
  let nz = field.at(x, y, z - e, list) - field.at(x, y, z + e, list)
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl; ny /= nl; nz /= nl
  out[0] = nx; out[1] = ny; out[2] = nz

  // Occlusion: how much rock crowds the open air just off the wall.
  let occ = 0
  for (const s of [0.5, 1.2, 2.4]) occ += Math.max(0, s + field.at(x + nx * s, y + ny * s, z + nz * s, list)) / s
  const ao = Math.max(0.35, 1 - occ * 0.32)

  field.at(x, y, z, list)
  const region = field.owner < 0 ? 0 : field.prims[field.owner].region
  const pal = PALETTES[field.graph.regions[region].palette]
  const band = Math.sin(y * 1.9 + 2.2 * field.noise.at3(x * 0.15, y * 0.3, z * 0.15))
  const base = ny > 0.65 ? pal.floor : band > 0.55 ? pal.vein : pal.rock
  const grain = 0.85 + 0.3 * (0.5 + 0.5 * field.floorNoise.at2(x * 3.1 + y * 1.7, z * 3.1 - y * 1.3))
  out[3] = base[0] * ao * grain; out[4] = base[1] * ao * grain; out[5] = base[2] * ao * grain

  let gr = 0, gg = 0, gb = 0, gd = 0
  for (const l of near) {
    const lx = l.x - x, ly = l.y - y, lz = l.z - z
    const d = Math.hypot(lx, ly, lz)
    if (d >= l.reach) continue
    const facing = (lx * nx + ly * ny + lz * nz) / (d || 1)
    if (facing <= 0) continue
    let lit = 1
    for (let s = 1; s < 5 && lit > 0; s++) if (field.at(x + (lx * s) / 5, y + (ly * s) / 5, z + (lz * s) / 5) > 0.25) lit = 0
    const fall = (1 - d / l.reach) ** 2 * facing * lit * l.power
    if (l.day) gd += fall
    else { gr += l.color[0] * fall; gg += l.color[1] * fall; gb += l.color[2] * fall }
  }
  out[6] = gr * ao; out[7] = gg * ao; out[8] = gb * ao
  out[9] = gd * ao
  return region
}

// Keeps only the vertices a triangle uses, then shades them (rockAt).
function shade(field, list, lights, ox, oy, oz, pos, index) {
  const used = new Uint8Array(pos.length / 3)
  for (const v of index) used[v] = 1
  const remap = new Int32Array(used.length).fill(-1)
  let count = 0
  for (let v = 0; v < used.length; v++) if (used[v]) remap[v] = count++
  const position = new Float32Array(count * 3)
  const normal = new Float32Array(count * 3)
  const color = new Float32Array(count * 3)
  const glow = new Float32Array(count * 3)
  const day = new Float32Array(count)
  const regionOf = new Int32Array(count)
  const near = lightsIn(lights, ox, oy, oz)
  const rock = new Float32Array(ROCK_AT)
  for (let v = 0; v < used.length; v++) {
    const o = remap[v]
    if (o < 0) continue
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    position[o * 3] = x; position[o * 3 + 1] = y; position[o * 3 + 2] = z
    regionOf[o] = rockAt(field, x, y, z, near, rock, list)
    normal.set(rock.subarray(0, 3), o * 3)
    color.set(rock.subarray(3, 6), o * 3)
    glow.set(rock.subarray(6, 9), o * 3)
    day[o] = rock[9]
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
  return { position, normal, color, glow, day, index: out, parts }
}
