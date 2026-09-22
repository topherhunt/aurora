// THROWAWAY. LeafkinGround on the shipped overworld: cost, and the rock superset.
//   node scripts/_lkg-probe.mjs
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { validate } from '../src/v2/layers/doc.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { buildTextureArray } from '../src/textures.js'
import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Rocks } from '../src/v2/render/rocks.js'
import { Trees } from '../src/v2/render/trees.js'
import { Deadwood, deadwoodBankFrom } from '../src/v2/render/deadwood.js'
import { Mushrooms } from '../src/v2/render/mushrooms.js'
import { Entrances, mouthBankFrom } from '../src/v2/render/entrances.js'
import { LeafkinGround, OPEN, BLOCKED, STONE, CELL } from '../src/v2/render/leafkin-ground.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'

const layers = Layers.deserialize(validate(JSON.parse(await readFile('public/world/layers.json', 'utf8'))))
const field = new V2Height({ heightmap: await Heightmap.read({ path: 'public/world/height.png', metaPath: 'public/world/height.json' }), layers, seed: SEED, relief: RELIEF_SHIPPED })
const water = new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field })
water.rebuild()
const tex = buildTextureArray()
const S = () => new THREE.Scene()
const [cx, cz] = (process.argv[2] ?? '160,-356').split(',').map(Number)
const rocks = new Rocks(S(), field, water, layers, tex, { seed: SEED, bank: buildRockBank() })
rocks.syncBands(layers)
rocks.place(cx, cz)
const deadwood = new Deadwood(S(), field, water, layers, { seed: SEED, bank: deadwoodBankFrom({ stump: readShippedLadder('stump-rotting'), log: readShippedLadder('log-fallen', { longAxisZ: true }) }), biome: new BiomeField({ seed: SEED }) })
deadwood.place(cx, cz)
const trees = new Trees(S(), field, water, tex, { seed: SEED, rocks, biome: new BiomeField({ seed: SEED }), deadwood, paths: layers.paths })
trees.place(cx, cz)
const mushrooms = new Mushrooms(S(), field, water, layers, tex, [trees, rocks], { seed: SEED })
mushrooms.syncSnowLine(layers)
mushrooms.place(cx, cz)
const ent = new Entrances(S(), field, water, rocks, { seed: SEED, bank: mouthBankFrom(readShippedLadder('cave-mouth')) })
ent.place(cx, cz)
const site = ent.sites([]).sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
console.log('site', site.key, site.x.toFixed(1), site.z.toFixed(1))

const g = new LeafkinGround({ field, water, trees, rocks, deadwood, mushrooms })
// Cost: fresh cells across the roam disc, random.
let r = 1
const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296)
let t0 = performance.now()
const tally = [0, 0, 0]
for (let i = 0; i < 20000; i++) {
  const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 150
  tally[g.cell(site.x + Math.cos(a) * d, site.z + Math.sin(a) * d)]++
}
let ms = performance.now() - t0
console.log(`20000 scattered cells: ${ms.toFixed(0)} ms (${(ms / 20000 * 1000).toFixed(1)} us each, tiles read ${g.tilesRead}), open ${tally[OPEN]} blocked ${tally[BLOCKED]} stone ${tally[STONE]}`)
// Warm: a contiguous 60 m square, the shape a walk asks.
t0 = performance.now()
const a0 = g.asked, tr0 = g.tilesRead
for (let x = -30; x < 30; x += CELL) for (let z = -30; z < 30; z += CELL) g.cell(site.x + 40 + x, site.z + z)
ms = performance.now() - t0
console.log(`a 60 m square, ${g.asked - a0} cells: ${ms.toFixed(0)} ms (${(ms / (g.asked - a0) * 1000).toFixed(1)} us each), ${g.tilesRead - tr0} tiles`)
t0 = performance.now()
for (let x = -30; x < 30; x += CELL) for (let z = -30; z < 30; z += CELL) g.cell(site.x + 40 + x, site.z + z)
console.log(`again, memoized: ${(performance.now() - t0).toFixed(1)} ms`)
t0 = performance.now()
let caps = 0
for (let i = 0; i < 200; i++) caps += g.capsNear(site.x + rand() * 100 - 50, site.z + rand() * 100 - 50, 3, []).length / 2
console.log(`200 capsNear(3 m): ${(performance.now() - t0).toFixed(1)} ms, ${caps} caps`)

// The superset: every point a placed blocking rock (not embedded) covers is not OPEN.
let covered = 0, missed = 0
const beds = rocks.beds.filter((b) => b.blocks && !b.fitSlope)
for (let x = -60; x < 60; x += 0.25) for (let z = -60; z < 60; z += 0.25) {
  const px = site.x + x, pz = site.z + z
  let stone = null
  for (const b of beds) if (b._blockAt(px, pz, 0.5, -Infinity, false) > -Infinity) { stone = b; break }
  if (!stone) continue
  covered++
  if (g.cell(px, pz) === OPEN) { if (missed++ < 5) console.log('  missed', x.toFixed(2), z.toFixed(2), stone.cfg.name, stone.tiles.has(Math.floor(px / stone.tile) * 0x10000 + Math.floor(pz / stone.tile))) }
}
console.log(`superset: ${covered} stone points, ${missed} open`)
// Stone share by bed, over the roam disc.
const src = {}
for (let i = 0; i < 4000; i++) {
  const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * 150
  const px = site.x + Math.cos(a) * d, pz = site.z + Math.sin(a) * d
  if (g.cell(px, pz) !== STONE) continue
  let who = 'hollowOver'
  for (let b = 0; b < g.beds.length; b++) {
    const bed = g.beds[b], T = bed.tile
    for (let tx = Math.floor(px / T) - 1; tx <= Math.floor(px / T) + 1; tx++) for (let tz = Math.floor(pz / T) - 1; tz <= Math.floor(pz / T) + 1; tz++) {
      const s = g._stones(b, tx, tz)
      for (let n = 0; n < s.length; n += 3) if (Math.hypot(px - s[n], pz - s[n + 1]) < s[n + 2] + 0.36) who = `${bed.cfg.name} r${s[n + 2].toFixed(1)}`
    }
  }
  const key = who.split(' ')[0]
  src[key] = (src[key] ?? 0) + 1
  if (who.startsWith('giants') && !src.ex) src.ex = who
}
console.log('stone by source', JSON.stringify(src))
for (let b = 0; b < g.beds.length; b++) { let n = 0, rs = 0; for (const s of g.stones[b].values()) { n += s.length / 3; for (let k = 2; k < s.length; k += 3) rs += s[k] } console.log(`  ${g.beds[b].cfg.name}: ${n} pure stones, mean r ${(rs / n).toFixed(2)}`) }
const placed = []
for (const b of rocks.beds) placed.push(`${b.cfg.name} ${b.placed}`)
console.log(placed.join(', '), '| caps placed', mushrooms.stats?.placed)
{
  const all = g.capsNear(site.x, site.z, 150, [])
  let real = 0
  for (const t of mushrooms.tiles?.values?.() ?? []) real += t.n ?? 0
  console.log(`pure caps within 150 m: ${all.length / 2}; mushrooms placed ${mushrooms.placed ?? JSON.stringify(Object.keys(mushrooms.stats ?? {}))}, tile n ${real}`)
}
console.log('mushroom stats', JSON.stringify(mushrooms.stats).slice(0, 400), mushrooms.tiles.size, mushrooms.queue.length)
{
  // Placed caps within the full radius against the pure ones there.
  const pure = g.capsNear(cx, cz, 20, [])
  const placed = []
  for (const t of mushrooms.tiles.values()) for (let k = 0; k < t.n; k++) { const id = t.ids[k]; if (Math.hypot(mushrooms.instX[id] - cx, mushrooms.instZ[id] - cz) <= 20) placed.push([mushrooms.instX[id], mushrooms.instZ[id]]) }
  let matched = 0
  for (const [x, z] of placed) for (let n = 0; n < pure.length; n += 2) if (Math.hypot(pure[n] - x, pure[n + 1] - z) < 0.05) { matched++; break }
  console.log(`caps within 20 m of the boot: ${placed.length} placed, ${pure.length / 2} pure, ${matched} placed matched a pure one`)
}
{
  const all = g.capsNear(site.x, site.z, 150, [])
  let worst = 0, total = 0, hit = 0
  for (let q = 0; q < Math.min(8, all.length / 2); q++) {
    const qx = all[q * 2 * 37 % all.length & ~1], qz = all[(q * 2 * 37 % all.length & ~1) + 1]
    const rocks = new Rocks(S(), field, water, layers, tex, { seed: SEED, bank: buildRockBank() })
    rocks.syncBands(layers)
    rocks.place(qx, qz)
    const trees = new Trees(S(), field, water, tex, { seed: SEED, rocks, biome: new BiomeField({ seed: SEED }), deadwood, paths: layers.paths })
    trees.place(qx, qz)
    const m = new Mushrooms(S(), field, water, layers, tex, [trees, rocks], { seed: SEED })
    m.place(qx, qz)
    const pure = g.capsNear(qx, qz, 20, [])
    const placed = []
    for (const t of m.tiles.values()) for (let k = 0; k < t.n; k++) { const id = t.ids[k]; if (Math.hypot(m.instX[id] - qx, m.instZ[id] - qz) <= 20) placed.push([m.instX[id], m.instZ[id]]) }
    let matched = 0
    for (const [x, z] of placed) for (let n = 0; n < pure.length; n += 2) if (Math.hypot(pure[n] - x, pure[n + 1] - z) < 0.05) { matched++; break }
    total += placed.length; hit += matched
    console.log(`  at ${qx.toFixed(0)},${qz.toFixed(0)}: ${placed.length} placed within 20 m, ${pure.length / 2} pure, ${matched} matched`)
  }
  console.log(`caps: ${hit} of ${total} placed matched`)
}
{
  const [qx, qz] = [254, -280]
  const trees = new Trees(S(), field, water, tex, { seed: SEED, rocks, biome: new BiomeField({ seed: SEED }), deadwood, paths: layers.paths })
  trees.place(qx, qz)
  const TT = 25
  let pure = 0, placedN = 0, both = 0
  const miss = []
  for (let tx = Math.floor((qx - 30) / TT); tx <= Math.floor((qx + 30) / TT); tx++) for (let tz = Math.floor((qz - 30) / TT); tz <= Math.floor((qz + 30) / TT); tz++) {
    const p = trees.pureTrunksInto(tx, tz, [])
    const a = new Float32Array(4 * 400)
    const n = trees.anchorsInto(tx * TT, tz * TT, (tx + 1) * TT, (tz + 1) * TT, a)
    pure += p.length / 3; for (let k = 0; k < n; k++) if (Math.hypot(a[k * 4] - qx, a[k * 4 + 2] - qz) <= 35) placedN++
    for (let i = 0; i < p.length; i += 3) {
      if (Math.hypot(p[i] - qx, p[i + 1] - qz) > 35) { pure--; continue }
      let f = false
      for (let k = 0; k < n; k++) if (a[k * 4] === p[i] && a[k * 4 + 2] === p[i + 1]) { f = true; break }
      if (f) both++; else if (miss.length < 40 && (miss.length < 4 || Math.hypot(p[i] - qx, p[i + 1] - qz) < 20)) miss.push(`${p[i].toFixed(1)},${p[i + 1].toFixed(1)} r${p[i + 2].toFixed(2)} d${Math.hypot(p[i] - qx, p[i + 1] - qz).toFixed(0)}`)
    }
  }
  console.log(`trunks: ${pure} pure, ${placedN} placed, ${both} in both; pure unplaced e.g. ${miss.join(' | ')}`, trees.stats.fullRadius, trees.stats.density)
}
