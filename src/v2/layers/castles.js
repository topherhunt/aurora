// Castle sites (design/44-castles.md, Siting): one per region at most, on the most prominent hill whose ground the castle's
// footing covers, and the footprint queries the scatter layers keep out of. Three-free; a site is plain JSON for the plan bake.
import { mulberry32 } from '../../sim/mathx.js'
import { CASTLE, castleLayout } from '../castles/layout.js'
import { WORLD_HALF } from '../config.js'
import { TOWN, townsOccupyAt } from './towns.js'

// `region` metres a side, `chance` of a castle in one; candidates every `grid` m, prominence against a ring `ring` m out, at least
// `rise` m. `footing`: how far below the floor the shell's footing reaches (shell.js profile) less a margin.
export const CASTLE_SITE = { region: 1400, chance: 0.75, grid: 40, ring: 120, rise: 3, keep: 12, footing: 5.5, roadClear: 6, shoreRise: 1.6, pad: 1.6 }
// The gate ramp (shell.js ramp): a flat run out of the door, then `run` m falling at 30 deg; its skirts reach `skirt` below the floor.
export const RAMP = { flat: 1.2, run: 11, slope: Math.tan(Math.PI / 6), skirt: 6.8, half: 2.2 }
const YAWS = 8

function regionHash(rx, rz, seed) {
  let h = Math.imul(rx | 0, 0x1b873593) ^ Math.imul(rz | 0, 0x2c1b3c6d) ^ Math.imul(seed | 0, 0x297a2d39) ^ 0x4341534c
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** A layout's plan extents about its centre and its gate door, in castle-local metres (+z out of the gate). */
export function castleExtents(lay) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const s of lay.sections) { x0 = Math.min(x0, s.x0); x1 = Math.max(x1, s.x0 + s.w); z0 = Math.min(z0, s.z0); z1 = Math.max(z1, s.z0 + s.d) }
  const gate = lay.edges.find((e) => e.kind === 'gate').doors[0]
  return { hx: (x1 - x0) * CASTLE.cell / 2, hz: (z1 - z0) * CASTLE.cell / 2, court: [lay.X(0), lay.Z(0), lay.X(lay.cw), lay.Z(lay.cd)], gate: [gate.x, gate.z] }
}

/** Castle-local (lx, lz) to world, for a site at (x, z) turned by yaw (gate toward (sin yaw, cos yaw)). */
export const toWorld = (s, lx, lz) => [s.x + lx * Math.cos(s.yaw) + lz * Math.sin(s.yaw), s.z - lx * Math.sin(s.yaw) + lz * Math.cos(s.yaw)]
export const toLocal = (s, x, z) => { const dx = x - s.x, dz = z - s.z; return [dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw), dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw)] }

/** Whether the castle fits at (x, z, yaw): its floor y set over the ground, nothing it covers below its footing, dry, off every
 * road, and its gate ramp bedded in the ground; the site record, or null. */
function fitAt(ext, x, z, yaw, { surface, layers }) {
  const site = { x, z, yaw }, P = CASTLE_SITE.pad, [c0, c1, c2, c3] = ext.court
  let lo = Infinity, sum = 0, n = 0, courtHi = -Infinity
  for (let lx = -ext.hx - P; lx <= ext.hx + P + 1e-6; lx += 3) for (let lz = -ext.hz - P; lz <= ext.hz + P + 1e-6; lz += 3) {
    const [wx, wz] = toWorld(site, lx, lz), h = surface(wx, wz)
    const level = layers.waterLevelAt(wx, wz)
    if (level !== null && h < level + CASTLE_SITE.shoreRise) return null
    const road = layers.paths.nearest(wx, wz, 'road')
    if (road !== null && road.dist < road.halfWidth + CASTLE_SITE.roadClear) return null
    lo = Math.min(lo, h); sum += h; n++
    if (lx >= c0 && lx <= c2 && lz >= c1 && lz <= c3) courtHi = Math.max(courtHi, h)
  }
  const y = Math.max(courtHi + 0.3, sum / n + CASTLE.raise)
  if (lo < y - CASTLE_SITE.footing) return null
  // The ramp meets the ground where the slope comes down to it; never floating past its skirts on the way.
  let foot = null
  for (let t = RAMP.flat; t <= RAMP.flat + RAMP.run + 1e-6; t += 0.5) {
    const [wx, wz] = toWorld(site, ext.gate[0], ext.gate[1] + t), g = surface(wx, wz), top = y + 0.05 - (t - RAMP.flat) * RAMP.slope
    if (g < y - RAMP.skirt) return null
    if (g >= top) { foot = t; break }
  }
  if (foot === null) return null
  return { y, foot }
}

/** Every castle site in the world, and a trail (trails.js, ids `keep<k>`) from each ramp's foot to the roads. Sited after the
 * labyrinths, whose trails are roads it keeps off; `routeTrails(avoid)` is trails.js routeTrails keeping off the labyrinths and `avoid`. */
export function planCastles({ towns, routeTrails, labs, surface, ground, layers, seed }) {
  const R = CASTLE_SITE.region, sites = []
  const n0 = Math.ceil(-WORLD_HALF / R), n1 = Math.floor(WORLD_HALF / R) - 1
  for (let rx = n0; rx <= n1; rx++) for (let rz = n0; rz <= n1; rz++) {
    const rand = mulberry32(regionHash(rx, rz, seed))
    if (rand() > CASTLE_SITE.chance) continue
    let lay = null
    for (let i = 0; i < 8 && (lay === null || !lay.stats.ok); i++) lay = castleLayout(1 + Math.floor(rand() * 1e6))
    if (!lay.stats.ok) continue
    const ext = castleExtents(lay), reach = Math.hypot(ext.hx, ext.hz + RAMP.flat + RAMP.run) + CASTLE_SITE.pad
    const margin = reach + CASTLE_SITE.ring
    const cands = []
    for (let x = rx * R + margin; x <= (rx + 1) * R - margin; x += CASTLE_SITE.grid) for (let z = rz * R + margin; z <= (rz + 1) * R - margin; z += CASTLE_SITE.grid) {
      if (Math.abs(z) + margin > TOWN.realZ) continue
      let ring = 0
      for (let k = 0; k < 12; k++) ring += ground(x + Math.cos(k * Math.PI / 6) * CASTLE_SITE.ring, z + Math.sin(k * Math.PI / 6) * CASTLE_SITE.ring) / 12
      const rise = ground(x, z) - ring
      if (rise >= CASTLE_SITE.rise) cands.push([rise, x, z])
    }
    cands.sort((p, q) => q[0] - p[0])
    let best = null
    for (const [, x, z] of cands.slice(0, 96)) {
      if (labs.reaches(x, z, reach + CASTLE_SITE.keep) || townsOccupyAt(towns, x, z, reach + CASTLE_SITE.keep)) continue
      if (towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius + reach + 60)) continue
      const a0 = rand() * Math.PI * 2
      for (let k = 0; k < YAWS && best === null; k++) {
        const yaw = a0 + k * Math.PI * 2 / YAWS, fit = fitAt(ext, x, z, yaw, { surface, layers })
        if (fit !== null) best = { id: `${rx},${rz}`, seed: lay.seed, x, z, y: fit.y, yaw, hx: ext.hx, hz: ext.hz, reach, gate: ext.gate, foot: fit.foot }
      }
      if (best !== null) break
    }
    if (best !== null) sites.push(best)
  }
  const castles = new CastleSites(sites)
  const ends = sites.map((s) => {
    const [x, z] = toWorld(s, s.gate[0], s.gate[1] + s.foot)
    return { id: s.id, x, z, nx: Math.sin(s.yaw), nz: Math.cos(s.yaw), y: surface(x, z) }
  })
  const route = routeTrails((x, z, r) => castles.occupiesAt(x, z, r))
  return { sites, ...route.lay(ends, { prefix: 'keep', foot: (m, out) => ({ pins: [out(0)], level: 0 }) }) }
}

/** The sited castles' footprints, for the layers that must keep off them. */
export class CastleSites {
  constructor(list) {
    this.list = list
  }

  /** Whether (x, z) lies within `pad` of a castle's masonry or its gate ramp, down to where the ramp meets the ground. */
  occupiesAt(x, z, pad) {
    for (const s of this.list) {
      if (Math.hypot(x - s.x, z - s.z) > s.reach + pad) continue
      const [lx, lz] = toLocal(s, x, z), P = CASTLE_SITE.pad + pad
      if (Math.abs(lx) <= s.hx + P && Math.abs(lz) <= s.hz + P) return true
      if (Math.abs(lx - s.gate[0]) <= RAMP.half + pad && lz >= s.gate[1] && lz <= s.gate[1] + s.foot + pad) return true
    }
    return false
  }

  /** The sites within `r` of (x, z). */
  near(x, z, r, out = []) {
    out.length = 0
    for (const s of this.list) if (Math.hypot(x - s.x, z - s.z) < s.reach + r) out.push(s)
    return out
  }
}
