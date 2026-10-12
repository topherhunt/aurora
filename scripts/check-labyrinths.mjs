// Gates for the palisade labyrinths (src/v2/layers/labyrinths.js, render/palisades.js; DESIGN.md §41), on the shipped world.
//
//   node scripts/check-labyrinths.mjs [every=1]
//
// Pure, every labyrinth: the cells are one maze -- every cell reached from the one entrance, one door to the middle --
// and every metre of wall line has a post within half a spacing. Walked, every `every`th labyrinth: flooded on a
// quarter-metre grid by WalkSurface's own heightAt and fits against Palisades' columnAt, every cell is reached from
// outside, and with the gate plugged none is.

import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { POST_R, POST_SPACING, POST_STRIDE } from '../src/v2/layers/labyrinths.js'
import { Palisades } from '../src/v2/render/palisades.js'
import { WalkSurface } from '../src/v2/walk.js'
import { LOCOMOTION } from '../src/player.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'

const EVERY = Number(process.argv[2] ?? 1)
const MIN_LABYRINTHS = 80
// A corridor leaves the walker's centre a band about 0.75 m across; a 0.5 m grid cannot step diagonally through it.
const GRID = 0.25

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const hm = await Heightmap.read({ path: new URL('../public/world/height.png', import.meta.url), metaPath: new URL('../public/world/height.json', import.meta.url) })
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
field.setLayers(layers)
new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field }).rebuild()
const labyrinths = new BiomeField({ seed: SEED, ground: field }).labyrinths

const sites = labyrinths.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF).slice()
check(sites.length >= MIN_LABYRINTHS, `the world holds at least ${MIN_LABYRINTHS} labyrinths`, `${sites.length}`)

console.log('\nthe maze and its posts')
let worstGap = 0
for (const s of sites) {
  const m = labyrinths.mazeOf(s)
  const { sectors, offs, wallCw, wallIn, wallOut } = m
  const rings = sectors.length
  const label = `labyrinth at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)})`
  // Through open walls only, from the entrance cell.
  const seen = new Uint8Array(offs[rings])
  const queue = [offs[rings - 1] + m.entrance]
  seen[queue[0]] = 1
  const go = (k, j) => { const id = offs[k] + j; if (!seen[id]) { seen[id] = 1; queue.push(id) } }
  for (let q = 0; q < queue.length; q++) {
    let k = 0
    while (queue[q] >= offs[k + 1]) k++
    const j = queue[q] - offs[k], n = sectors[k]
    if (!wallCw[k][j]) go(k, (j + 1) % n)
    if (!wallCw[k][(j - 1 + n) % n]) go(k, (j - 1 + n) % n)
    if (k > 0 && !wallIn[k][j]) go(k - 1, Math.floor((j * sectors[k - 1]) / n))
    if (k + 1 < rings) {
      const f = sectors[k + 1] / n
      for (let i = 0; i < f; i++) if (!wallIn[k + 1][j * f + i]) go(k + 1, j * f + i)
    }
  }
  const reached = seen.reduce((a, b) => a + b, 0)
  const ways = wallOut.length - wallOut.reduce((a, b) => a + b, 0)
  const doors = wallIn[0].length - wallIn[0].reduce((a, b) => a + b, 0)
  check(reached === offs[rings] && ways === 1 && doors === 1 && m.torches.length === 2,
    `${label}: every cell reached from the one entrance, one door to the middle, two torches`,
    `${reached}/${offs[rings]} reached, ${ways} ways in, ${doors} doors, ${m.torches.length} torches`)

  // Every point of every wall line within half a spacing of a post, so neighbours stand at most a spacing apart.
  const posts = labyrinths.postsOf(s)
  const H = 1, grid = new Map()
  for (let i = 0; i < posts.length; i += POST_STRIDE) {
    const key = Math.floor(posts[i] / H) * 65536 + Math.floor(posts[i + 1] / H)
    if (!grid.has(key)) grid.set(key, [])
    grid.get(key).push(posts[i], posts[i + 1])
  }
  const nearest = (x, z) => {
    let best = Infinity
    const gx = Math.floor(x / H), gz = Math.floor(z / H)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = grid.get((gx + dx) * 65536 + gz + dz)
      if (list) for (let q = 0; q < list.length; q += 2) best = Math.min(best, Math.hypot(list[q] - x, list[q + 1] - z))
    }
    return best
  }
  let gap = 0
  const seg = m.segments
  for (let k = 0; k < seg.length; k += 4) {
    const L = Math.hypot(seg[k + 2] - seg[k], seg[k + 3] - seg[k + 1])
    for (let t = 0; t <= L; t += 0.05) gap = Math.max(gap, nearest(seg[k] + ((seg[k + 2] - seg[k]) * t) / L, seg[k + 1] + ((seg[k + 3] - seg[k + 1]) * t) / L))
  }
  worstGap = Math.max(worstGap, gap)
  if (gap > POST_SPACING / 2 + 1e-3) check(false, `${label}: a post within half a spacing of every point of wall`, `${gap.toFixed(3)} m`)
}
check(worstGap <= POST_SPACING / 2 + 1e-3, `every labyrinth: a post within ${POST_SPACING / 2} m of every point of wall`, `worst ${worstGap.toFixed(3)} m`)

console.log('\nthe walker in the walls')
// Palisades' stone answers off the labyrinths and the field alone, so the gate walks the shipped columnAt without the meshes.
const palisades = Object.assign(Object.create(Palisades.prototype), { labyrinths, field })
let plug = null
const plugStone = {
  columnAt: (x, z, _min, out) => {
    if (plug === null) return 0
    const [ax, az, bx, bz] = plug, dx = bx - ax, dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
    if ((x - ax - t * dx) ** 2 + (z - az - t * dz) ** 2 >= POST_R * POST_R) return 0
    out[0] = -Infinity
    out[1] = Infinity
    return 1
  },
  blockTopAt: () => -Infinity,
}
const walk = new WalkSurface(field, { columnAt: () => 0, blockTopAt: () => -Infinity }, { trunkAt: () => false })
walk.addStone(palisades)
walk.addStone(plugStone)

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
// A flood over [x0, x1] x [z0, z1] from `starts` on the grid, by the walker's step: her foot height carried, the next
// tread whatever heightAt finds within her reach, climbed only as Player._walkable allows, and only where she fits.
const MAX_TAN = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180)
const climbs = (x, z, h0, dx, dz, h1) => (h1 - h0) / GRID <= MAX_TAN ||
  (walk.heightAt(x + dx * LOCOMOTION.stride, z + dz * LOCOMOTION.stride, h0) - h0) / LOCOMOTION.stride <= MAX_TAN
function flood(x0, z0, x1, z1, starts) {
  const w = Math.round((x1 - x0) / GRID) + 1, h = Math.round((z1 - z0) / GRID) + 1
  const y = new Float64Array(w * h).fill(NaN)
  const queue = []
  for (const [sx, sz] of starts) {
    const i = Math.round((sx - x0) / GRID), j = Math.round((sz - z0) / GRID)
    const x = x0 + i * GRID, z = z0 + j * GRID
    const foot = walk.heightAt(x, z)
    if (!Number.isNaN(y[j * w + i]) || !walk.fits(x, z, foot)) continue
    y[j * w + i] = foot
    queue.push(j * w + i)
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q], i = k % w, j = (k / w) | 0
    for (const [di, dj] of STEPS) {
      const a = i + di, b = j + dj
      if (a < 0 || b < 0 || a >= w || b >= h || !Number.isNaN(y[b * w + a])) continue
      const x = x0 + a * GRID, z = z0 + b * GRID
      const foot = walk.heightAt(x, z, y[k])
      if (!climbs(x0 + i * GRID, z0 + j * GRID, y[k], di, dj, foot) || !walk.fits(x, z, foot)) continue
      y[b * w + a] = foot
      queue.push(b * w + a)
    }
  }
  // A cell centre counts as reached when the grid node nearest it, or one beside it, is: a centre can fall within a capsule of a wall's end.
  return {
    at: (x, z) => {
      const i = Math.round((x - x0) / GRID), j = Math.round((z - z0) / GRID)
      for (const [di, dj] of [[0, 0], ...STEPS]) if (!Number.isNaN(y[(j + dj) * w + i + di])) return true
      return false
    },
  }
}

for (let si = 0; si < sites.length; si += EVERY) {
  const s = sites[si]
  const m = labyrinths.mazeOf(s)
  const label = `labyrinth at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)})`
  const pad = s.reach + 2
  const bx0 = s.cx - pad, bz0 = s.cz - pad, bx1 = s.cx + pad, bz1 = s.cz + pad
  const ring = []
  for (let t = 0; t <= 2 * pad; t += GRID) ring.push([bx0 + t, bz0], [bx0 + t, bz1], [bx0, bz0 + t], [bx1, bz0 + t])
  const reachedFrom = () => {
    const f = flood(bx0, bz0, bx1, bz1, ring)
    return m.cells.filter(([x, z]) => f.at(x, z)).length + (f.at(m.centre[0], m.centre[1]) ? 1 : 0)
  }
  plug = null
  const open = reachedFrom()
  check(open === m.cells.length + 1, `${label}: the walker reaches every cell and the middle from outside`, `${open}/${m.cells.length + 1}`)
  // The outer wall is lines[0], one arc from the gate's far post round to its near one: plug the chord between its ends.
  const outer = m.lines[0].xz
  plug = [outer[0], outer[1], outer[outer.length - 2], outer[outer.length - 1]]
  const shut = reachedFrom()
  plug = null
  check(shut === 0, `${label}: and with the gate plugged, none`, `${shut} reached`)
}

console.log(failures === 0 ? '\nall labyrinth checks passed' : `\n${failures} labyrinth check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
