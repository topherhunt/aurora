// Cave mouths on the overworld and the systems they open onto (design/39-caves.md §2). Pure: no three, runs under node.
//
// A mouth stands at a cliff foot: level ground she can stand on, a face rising hard behind it. Candidates are scanned on the raw 8 m texels (integer taps, no bicubic), then each survivor is refined against the exact field the walker reads, so the hole's floor is the ground her feet are on. Every peer runs this on the same heightmap and gets the same list.

import { mulberry32 } from '../../sim/mathx.js'
// The mouth's own shape: the hood (render/cave-mouths.js), the cleft under it (layers/clefts.js) and the portal all read these.
export const MOUTH = {
  // Half-width and height of the hole she walks into.
  holeW: 1.3,
  holeH: 2.6,
  // Metres in past the lip at which the walk-in fades her under.
  into: 1.6,
  // Metres past the lip the black cap closes the throat.
  throat: 3.6,
  // The hood's half-width and how far it stands out of the face.
  hoodW: 4.4,
  hoodOut: 2.2,
}
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF } from '../config.js'

// The eight scan directions as texel offsets, two texels out (16 m, 22.6 m on the diagonals).
const DIRS = [[2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2]]
// Metres the face must rise over its two texels, scaled by the diagonal's length.
const RISE_MIN = 11
// Metres the apron two texels out the other way may differ from the foot.
const APRON_MAX = 3
export const MOUTH_SPACING = 350
export const MOUTH_CAP = 30
// Mouths closer than this may share a system, each such pair with LINK_ODDS.
export const LINK_M = 500
const LINK_ODDS = 0.6

/**
 * The mouths, best faces first, as `{ id, x, z, y, nx, nz }`: the foot of the face at (x, z), its floor `y`, and (nx, nz) the unit plan direction OUT of the cliff.
 * `field.heightAt` is the walker's height; `wet(x, z)` and `keepOut(x, z, r)` refuse water and towns.
 */
export function siteMouths({ heightmap, field, wet, keepOut }) {
  const { width: W, height: H, field: t } = heightmap
  const step = heightmap.texelSize
  const cands = []
  for (let j = 4; j < H - 4; j++) {
    for (let i = 4; i < W - 4; i++) {
      const h0 = t[j * W + i]
      let best = 0, bd = -1
      for (let d = 0; d < 8; d++) {
        const [di, dj] = DIRS[d]
        const scale = di !== 0 && dj !== 0 ? Math.SQRT2 : 1
        const rise = (t[(j + dj) * W + i + di] - h0) / scale
        if (rise < RISE_MIN || Math.abs(t[(j - dj) * W + i - di] - h0) > APRON_MAX) continue
        if (rise > best) { best = rise; bd = d }
      }
      if (bd >= 0) cands.push({ i, j, d: bd, score: best })
    }
  }
  cands.sort((a, b) => b.score - a.score || a.j - b.j || a.i - b.i)

  const mouths = []
  for (const c of cands) {
    if (mouths.length >= MOUTH_CAP) break
    const x0 = c.i * step - WORLD_HALF, z0 = c.j * step - WORLD_HALF
    if (mouths.some((m) => Math.hypot(m.x - x0, m.z - z0) < MOUTH_SPACING)) continue
    const [di, dj] = DIRS[c.d]
    const len = Math.hypot(di, dj)
    const m = refine(field, x0, z0, di / len, dj / len)
    if (m === null || wet(m.x, m.z) || wet(m.x + m.nx * 3, m.z + m.nz * 3) || keepOut(m.x, m.z, 30)) continue
    m.id = mouths.length
    mouths.push(m)
  }
  return mouths
}

// The foot along the fall line's reverse (dx, dz, INTO the cliff) near (x0, z0), or null where the face is not a face up close.
function refine(field, x0, z0, dx, dz) {
  const h = (x, z) => field.heightAt(x, z)
  for (let s = -12; s <= 14; s += 0.5) {
    const x = x0 + dx * s, z = z0 + dz * s
    const y = h(x, z)
    if (h(x + dx * 1.5, z + dz * 1.5) - y < 1.1) continue
    // A level apron to stand on, and the face really standing behind the foot.
    if (Math.abs(h(x - dx * 3, z - dz * 3) - y) > 1.0) return null
    if (Math.abs(h(x - dz * 2, z + dx * 2) - h(x + dz * 2, z - dx * 2)) > 2.0) return null
    if (h(x + dx * 5, z + dz * 5) - y < 4.5) return null
    return { id: -1, x, z, y, nx: -dx, nz: -dz }
  }
  return null
}

/**
 * The systems: union-find over mouth pairs within LINK_M, each joined on a hashed coin so some neighbours share a cave and some do not.
 * Each is `{ id, seed, mouths: [mouth ids], cx, cz }`, (cx, cz) the mean of its mouths.
 */
export function groupSystems(mouths, seed) {
  const up = mouths.map((_, i) => i)
  const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])))
  for (let a = 0; a < mouths.length; a++) {
    for (let b = a + 1; b < mouths.length; b++) {
      if (Math.hypot(mouths[a].x - mouths[b].x, mouths[a].z - mouths[b].z) > LINK_M) continue
      if (mulberry32(hash32(seed, a, b, 0x3a7e))() >= LINK_ODDS) continue
      up[find(a)] = find(b)
    }
  }
  const by = new Map()
  for (let i = 0; i < mouths.length; i++) {
    const r = find(i)
    if (!by.has(r)) by.set(r, [])
    by.get(r).push(i)
  }
  const systems = []
  for (const ids of by.values()) {
    ids.sort((a, b) => a - b)
    const cx = ids.reduce((s, i) => s + mouths[i].x, 0) / ids.length
    const cz = ids.reduce((s, i) => s + mouths[i].z, 0) / ids.length
    systems.push({ id: systems.length, seed: hash32(seed, ids[0], 0xca7e), mouths: ids, cx, cz })
  }
  for (const s of systems) for (const i of s.mouths) mouths[i].system = s.id
  return systems
}
