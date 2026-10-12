// Gates for the boulder mazes (src/v2/layers/mazes.js and the rocks' `maze`
// bed; DESIGN.md §41), on the shipped world.
//
//   node scripts/check-mazes.mjs [every=1]
//
// Pure, every maze: the block grid is a maze -- every cell reachable from an
// entrance through open blocks, the rim closed but for the entrances -- and the
// world holds enough of them. Grown, every `every`th maze: the real rocks
// placed, then flooded on a half-metre grid by WalkSurface's own heightAt and
// fits, so a wall is what the walker finds it to be. Every cell is reached from
// outside the footprint, and across each wall between two cells the walker,
// held to the strip those two cells and the wall make, does not get through;
// across each open edge she does.

import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import { Rocks } from '../src/v2/render/rocks.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { buildTextureArray } from '../src/textures.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { MAZE, OPEN } from '../src/v2/layers/mazes.js'
import { WalkSurface } from '../src/v2/walk.js'
import { LOCOMOTION } from '../src/player.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'

const EVERY = Number(process.argv[2] ?? 1)
const MIN_MAZES = 80
const GRID = 0.5

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const hm = await Heightmap.read({ path: new URL('../public/world/height.png', import.meta.url), metaPath: new URL('../public/world/height.json', import.meta.url) })
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
field.setLayers(layers)
const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field })
water.rebuild()
const rocks = new Rocks(new THREE.Scene(), field, water, layers, buildTextureArray(), { seed: SEED })
const bed = rocks.beds.find((b) => b.cfg.maze)
const mazes = bed.mazes
const walk = new WalkSurface(field, rocks, {})

const sites = mazes.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF).slice()
check(sites.length >= MIN_MAZES, `the world holds at least ${MIN_MAZES} mazes`, `${sites.length}`)

console.log('\nthe block grid')
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
for (const s of sites) {
  const m = mazes.mazeOf(s)
  const { n, nb } = s
  const isIn = (i, j) => i >= 0 && j >= 0 && i < n && j < n && m.inside[j * n + i] === 1
  const block = (bi, bj) => m.blocks[bj * nb + bi]
  // Every cell from the entrances, through open edge blocks only.
  const seen = new Uint8Array(n * n)
  const queue = m.entrances.map(([i, j]) => j * n + i)
  for (const k of queue) seen[k] = 1
  let rimOpen = 0
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q] % n, j = (queue[q] / n) | 0
    for (const [di, dj] of STEPS) {
      if (block(2 * i + 1 + di, 2 * j + 1 + dj) !== OPEN) continue
      if (!isIn(i + di, j + dj)) { rimOpen++; continue }
      const k = (j + dj) * n + i + di
      if (!seen[k]) { seen[k] = 1; queue.push(k) }
    }
  }
  let cells = 0, reached = 0, cellWalled = 0
  for (let k = 0; k < n * n; k++) {
    if (!m.inside[k]) continue
    cells++
    if (seen[k]) reached++
    if (block(2 * (k % n) + 1, 2 * ((k / n) | 0) + 1) !== OPEN) cellWalled++
  }
  check(reached === cells && cellWalled === 0 && rimOpen >= 2 && rimOpen <= m.entrances.length,
    `maze at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)}): every cell open and reached from its entrances, the rim shut but for them`,
    `${reached}/${cells} reached, ${cellWalled} walled, ${rimOpen} rim openings for ${m.entrances.length} entrances`)
}

console.log('\nthe walker in the grown maze')
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
  return { at: (x, z) => !Number.isNaN(y[Math.round((z - z0) / GRID) * w + Math.round((x - x0) / GRID)]) }
}

const B = MAZE.block
for (let si = 0; si < sites.length; si += EVERY) {
  const s = sites[si]
  for (let r = 0; r < 3; r++) {
    rocks.place(s.cx, s.cz)
    for (const b of rocks.beds) b.walkAll = true
    rocks.update(s.cx, field.heightAt(s.cx, s.cz) + 1.6, s.cz)
  }
  const m = mazes.mazeOf(s)
  const { n, nb } = s
  const isIn = (i, j) => i >= 0 && j >= 0 && i < n && j < n && m.inside[j * n + i] === 1
  const cellX = (i) => s.x0 + (2 * i + 1.5) * B, cellZ = (j) => s.z0 + (2 * j + 1.5) * B
  const label = `maze at (${s.cx.toFixed(0)}, ${s.cz.toFixed(0)})`

  // From all round the footprint, a block out.
  const pad = B, side = nb * B
  const bx0 = s.x0 - pad, bz0 = s.z0 - pad, bx1 = s.x0 + side + pad, bz1 = s.z0 + side + pad
  const ring = []
  for (let t = 0; t <= side + 2 * pad; t += GRID) ring.push([bx0 + t, bz0], [bx0 + t, bz1], [bx0, bz0 + t], [bx1, bz0 + t])
  const all = flood(bx0, bz0, bx1, bz1, ring)
  let cells = 0, reached = 0
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (isIn(i, j)) { cells++; if (all.at(cellX(i), cellZ(j))) reached++ }
  check(reached === cells, `${label}: the walker reaches every cell from outside`, `${reached}/${cells}`)

  // Edge by edge, held to the strip of its two cells.
  let walls = 0, held = 0, opens = 0, passed = 0
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!isIn(i, j)) continue
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        if (!isIn(i + di, j + dj)) continue
        const shut = m.blocks[(2 * j + 1 + dj) * nb + 2 * i + 1 + di] !== OPEN
        const ax = cellX(i), az = cellZ(j), bxc = cellX(i + di), bzc = cellZ(j + dj)
        const half = B / 2
        const strip = flood(Math.min(ax, bxc) - half, Math.min(az, bzc) - half, Math.max(ax, bxc) + half, Math.max(az, bzc) + half, [[ax, az]])
        const through = strip.at(bxc, bzc)
        if (shut) { walls++; if (!through) held++ } else { opens++; if (through) passed++ }
      }
    }
  }
  check(held === walls, `${label}: no wall between two cells lets the walker through`, `${held}/${walls} held`)
  check(passed === opens, `${label}: every open edge does`, `${passed}/${opens} passed`)
}

console.log(failures === 0 ? '\nall maze checks passed' : `\n${failures} maze check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
