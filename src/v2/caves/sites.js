// Cave mouths on the overworld and the systems they open onto (design/39-caves.md §2). Pure: no three, runs under node.
//
// A mouth stands at a cliff foot: level ground she can stand on, a face rising hard behind it. Candidates are scanned on the raw 8 m texels (integer taps, no bicubic), then each survivor is refined against the exact field the walker reads, so the hole's floor is the ground her feet are on. Every peer runs this on the same heightmap and gets the same list.

import { mulberry32 } from '../../sim/mathx.js'
// The mouth's own shape: the arch (render/cave-mouths.js), the notch it stands in (layers/clefts.js) and the portal all read these.
export const MOUTH = {
  // The leafkin arch (render/entrances.js) at this times its 1.5 m: 3.3 m tall, 4 m across, 2.7 m out of the wall, its hole 2.7 m across. check-caves holds the notch round it.
  scale: 2.2,
  // Metres in past the foot the notch's back wall stands, the arch against it.
  wall: 1.0,
  // The notch's level floor: its half-width, and how far out of the wall it runs.
  floorW: 3.0,
  floorOut: 4.5,
  // The portal: her feet within `reach` of the hole's plane and `holeW` of its axis take her under.
  holeW: 1.2,
  reach: 0.8,
}
import { hash32 } from '../../sim/score.js'
import { WORLD_HALF } from '../config.js'

// The eight scan directions as texel offsets, two texels out (16 m, 22.6 m on the diagonals).
const DIRS = [[2, 0], [2, 2], [0, 2], [-2, 2], [-2, 0], [-2, -2], [0, -2], [2, -2]]
// Metres the face must rise over its two texels, scaled by the diagonal's length.
const RISE_MIN = 11
// Metres the apron two texels out the other way may differ from the foot.
const APRON_MAX = 3
export const MOUTH_SPACING = 160
export const MOUTH_CAP = 160
// Mouths closer than this may share a system, each such pair with LINK_ODDS. Union-find chains links, so at MOUTH_SPACING this is what keeps a system a few mouths across, well inside chalk's ±655 m (caves/chalk.js); check-caves measures the shipped world's.
export const LINK_M = 250
const LINK_ODDS = 0.6
// Odds a town house roomier than a hut has a cellar door down to a cave, and the least distance between two cellars.
const CELLAR_ODDS = 0.15
const CELLAR_SPACING = 40
// A cellar joins the nearest cliff system whose centre is this near, on LINK_ODDS; chalk packs its points about that centre (caves/chalk.js), so this stays well inside its ±655 m.
export const CELLAR_LINK_M = 250

/**
 * The mouths, best faces first, as `{ id, x, z, y, nx, nz }`: the foot of the face at (x, z), its floor `y`, and (nx, nz) the unit plan direction OUT of the cliff.
 * `field.heightAt` is the walker's height; `wet(x, z)` and `keepOut(x, z, r)` refuse water and towns, and `reaches(m)` a mouth no trail can reach (layers/trails.js).
 */
export function siteMouths({ heightmap, field, wet, keepOut, reaches = () => true }) {
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
    if (m === null || wet(m.x, m.z) || wet(m.x + m.nx * 3, m.z + m.nz * 3) || keepOut(m.x, m.z, 30) || !reaches(m)) continue
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
    // 0 - d, not -d: a -0 comes back from the baked plan's JSON as 0.
    return { id: -1, x, z, y, nx: 0 - dx, nz: 0 - dz }
  }
  return null
}

/**
 * The town houses with a door down to a cave, as `{ id, t, i, x, z, dx, dz }`: town `t`'s building `i`, its cave entered under its centre (x, z) heading (dx, dz).
 * Huts are too small to fit the door reliably; check-towns rolls every one chosen here with it.
 */
export function siteCellars(towns, seed) {
  const cellars = []
  towns.forEach((town, t) => town.buildings.forEach((b, i) => {
    if (b.kind === 'hut') return
    const rng = mulberry32(hash32(seed, t, i, 0xce11))
    if (rng() >= CELLAR_ODDS || cellars.some((c) => Math.hypot(c.x - b.x, c.z - b.z) < CELLAR_SPACING)) return
    const a = rng() * Math.PI * 2
    cellars.push({ id: cellars.length, t, i, x: b.x, z: b.z, dx: Math.cos(a), dz: Math.sin(a) })
  }))
  return cellars
}

/** System `sys`'s entries for planCave, its mouths' then its cellars', in its doors' order. */
export function caveEntries(sys, mouths, cellars) {
  return [
    ...sys.mouths.map((k) => ({ x: mouths[k].x, z: mouths[k].z, dx: -mouths[k].nx, dz: -mouths[k].nz })),
    ...sys.cellars.map((k) => ({ x: cellars[k].x, z: cellars[k].z, dx: cellars[k].dx, dz: cellars[k].dz, cellar: true })),
  ]
}

/**
 * The systems: union-find over mouth pairs within LINK_M, each joined on a hashed coin so some neighbours share a cave and some do not.
 * Each is `{ id, seed, mouths: [mouth ids], cellars: [cellar ids], cx, cz }`, (cx, cz) the mean of its mouths.
 * A cellar then joins the nearest cliff system within CELLAR_LINK_M on its own coin, leaving the cliff systems' ids, seeds and centres as they were; the rest join a cellar-only system whose first cellar is that near, centred on that first cellar, or found their own.
 */
export function groupSystems(mouths, seed, cellars = []) {
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
    systems.push({ id: systems.length, seed: hash32(seed, ids[0], 0xca7e), mouths: ids, cellars: [], cx, cz })
  }
  for (const s of systems) for (const i of s.mouths) mouths[i].system = s.id
  for (const c of cellars) {
    let best = null, bd = CELLAR_LINK_M
    for (const s of systems) {
      const d = Math.hypot(s.cx - c.x, s.cz - c.z)
      if (d <= bd) { best = s; bd = d }
    }
    if (best !== null && mulberry32(hash32(seed, c.id, best.id, 0xce11))() < LINK_ODDS) best.cellars.push(c.id)
    else systems.push({ id: systems.length, seed: hash32(seed, c.id, 0xce11, 0xca7e), mouths: [], cellars: [c.id], cx: c.x, cz: c.z })
  }
  for (const s of systems) for (const i of s.cellars) cellars[i].system = s.id
  return systems
}
