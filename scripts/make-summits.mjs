// Bakes public/world/summits.json: the summits that carry cloud wreaths (§10).
// Offline because a 1024^2 heightmap scan is a hundred milliseconds or more on
// the Quest 2 main thread and the answer never changes between boots.
//
//   node scripts/make-summits.mjs
//
// A summit is a local maximum of the shipped field (heightmap plus the shipped
// relief, so the wreath sits on the ground she sees), no closer than SPACING
// to a higher one, above FLOOR. The highest COUNT are written, each with a
// GRID x GRID sample of the ground over the wreath's footprint, which is what
// the client reads to seat each cloud card and fade it where it enters rock
// instead of calling heightAt at boot (§10, render/wreaths.js).

import { writeFileSync } from 'node:fs'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height, WORLD_SEED } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { WORLD_HALF } from '../src/v2/config.js'

const COUNT = 28
const SPACING = 900 // m between wreathed summits; the cards cull one by one, so two in reach is fine
const FLOOR = 420 // m; the wreaths are for the skyline, not the foothills
const FOOTPRINT = 400 // m, the half-width of the ground grid; the client keeps its lozenges inside it
const GRID = 11 // samples across the footprint, 80 m apart
const CELL = 32 // m, the scan grid; the maximum is then refined at the exact field

const hm = await Heightmap.read({
  path: new URL('../public/world/height.png', import.meta.url),
  metaPath: new URL('../public/world/height.json', import.meta.url),
})
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: WORLD_SEED, relief: RELIEF_SHIPPED })
const h = (x, z) => field.heightAt(x, z, 0)

// Coarse scan over the inner world; the border texels are the mirror band and
// the edge clamp, and neither is a mountain anyone looks at.
const n = Math.floor((WORLD_HALF * 2 * 0.92) / CELL)
const x0 = -WORLD_HALF * 0.92
const grid = new Float32Array(n * n)
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) grid[j * n + i] = h(x0 + i * CELL, x0 + j * CELL)

const peaks = []
for (let j = 1; j < n - 1; j++) {
  for (let i = 1; i < n - 1; i++) {
    const v = grid[j * n + i]
    if (v < FLOOR) continue
    let top = true
    for (let dj = -1; dj <= 1 && top; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && grid[(j + dj) * n + i + di] > v) { top = false; break }
    if (top) peaks.push({ x: x0 + i * CELL, z: x0 + j * CELL, y: v })
  }
}
peaks.sort((a, b) => b.y - a.y)

// A hill climb on the exact field, so each centre is the true crest and not
// the scan cell nearest it, then non-maximum suppression, highest first.
const crests = peaks.map((p) => {
  let { x, z, y } = p
  for (let step = CELL / 2; step >= 1; step /= 2) {
    let moved = true
    while (moved) {
      moved = false
      for (const [dx, dz] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const v = h(x + dx, z + dz)
        if (v > y) { x += dx; z += dz; y = v; moved = true }
      }
    }
  }
  return { x, z, y }
}).sort((a, b) => b.y - a.y)
const kept = []
for (const { x, z, y } of crests) {
  if (kept.some((k) => Math.hypot(k.x - x, k.z - z) < SPACING)) continue
  const ground = []
  for (let gj = 0; gj < GRID; gj++) for (let gi = 0; gi < GRID; gi++) {
    ground.push(Math.round(h(x + ((gi / (GRID - 1)) * 2 - 1) * FOOTPRINT, z + ((gj / (GRID - 1)) * 2 - 1) * FOOTPRINT)))
  }
  kept.push({ x: Math.round(x), z: Math.round(z), y: Math.round(y), ground })
  if (kept.length === COUNT) break
}
if (kept.length < COUNT) throw new Error(`summits: only ${kept.length} peaks above ${FLOOR} m at ${SPACING} m spacing; lower FLOOR or SPACING`)

const mean = (g) => g.reduce((a, b) => a + b, 0) / g.length
writeFileSync('public/world/summits.json', JSON.stringify({ spacing: SPACING, footprint: FOOTPRINT, grid: GRID, summits: kept }).replace(/\{"x"/g, '\n{"x"') + '\n')
console.log(`public/world/summits.json: ${kept.length} summits, ${kept[kept.length - 1].y}..${kept[0].y} m, mean drop to the footprint ${(kept.reduce((s, k) => s + k.y - mean(k.ground), 0) / kept.length).toFixed(0)} m`)
for (const k of kept) console.log(`   ${String(k.x).padStart(5)} ${String(k.z).padStart(5)}  ${k.y} m  footprint mean ${mean(k.ground).toFixed(0)} m`)
