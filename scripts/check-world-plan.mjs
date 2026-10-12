// Node-side gate for the baked overworld plan (src/v2/layers/world-plan.js, scripts/bake-world-plan.mjs).
//
//   node scripts/check-world-plan.mjs
//
// A baked plan read back must be the live plan to the bit, down to which objects are shared, since the client trusts it in place of laying one.

import { readFileSync } from 'node:fs'
import { SEED, SPAWN, WORLD_HALF } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED, RELIEF_DEFAULTS } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { applyWorldPlan, packShores, planWorld, packWorldPlan, unpackWorldPlan, worldPlanKey } from '../src/v2/layers/world-plan.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const root = new URL('../public/world/', import.meta.url)
const doc = JSON.parse(readFileSync(new URL('layers.json', root), 'utf8'))
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(doc)
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const live = planWorld({ heightmap: hm, ground: (x, z) => hm.sample(x, z), field, surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, spawn: SPAWN })

const text = JSON.stringify(packWorldPlan(live))
const back = unpackWorldPlan(JSON.parse(text))
console.log(`  packed ${(text.length / 1024).toFixed(0)} KB`)

// Deep equality that also holds the sharing: a live object reached twice must come back as one object reached twice, and two live objects must not come back as one.
const pairs = new Map()
const seen = new Set()
let firstDiff = null
const same = (a, b, path) => {
  if (firstDiff !== null) return
  if (typeof a !== 'object' || a === null) {
    if (!Object.is(a, b)) firstDiff = `${path}: ${String(a)} vs ${String(b)}`
    return
  }
  if (typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) {
    firstDiff = `${path}: object vs ${String(b)}`
    return
  }
  if (pairs.has(a)) {
    if (pairs.get(a) !== b) firstDiff = `${path}: shared live object came back split`
    return
  }
  if (seen.has(b)) {
    firstDiff = `${path}: two live objects came back as one`
    return
  }
  pairs.set(a, b)
  seen.add(b)
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length || ka.some((k) => !Object.hasOwn(b, k))) {
    firstDiff = `${path}: keys [${ka.filter((k) => !Object.hasOwn(b, k))}] vs [${kb.filter((k) => !Object.hasOwn(a, k))}]`
    return
  }
  for (const k of ka) same(a[k], b[k], `${path}.${k}`)
}
same(live, back, 'plan')
check(firstDiff === null, 'a baked plan read back is the live plan, sharing and all', firstDiff ?? `${pairs.size} objects`)

// The bake traces its shores on the layers planWorld grew in place; the boot rebuilds them from the unpacked records. Any difference between the two grounds is a shore that sits off its bank with nothing to say so.
applyWorldPlan(layers, live)
const baked = JSON.stringify(packShores(layers, field))
const bootLayers = Layers.deserialize(JSON.parse(JSON.stringify(doc)))
const bootField = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
bootField.setLayers(bootLayers)
for (const p of [back.townPlan, back.roadPlan, back.trailPlan, back.labyrinthPlan]) bootLayers.addGenerated(p.records)
applyWorldPlan(bootLayers, back)
const traced = JSON.stringify(packShores(bootLayers, bootField))
check(baked === traced && baked.length > 2, "the baked lake shores are the ones the boot's ground traces", `${Object.keys(JSON.parse(baked)).length} shores, ${(baked.length / 1024).toFixed(0)} KB`)

{
  // DESIGN.md §41: the boot's labyrinths are the plan's, and a trail runs from each gate to the roads without crossing any labyrinth.
  const labs = new BiomeField({ seed: SEED, ground: bootField }).labyrinths
  const { sites, trails, records, failed } = back.labyrinthPlan
  const read = labs.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF)
  check(sites.length > 0 && read.length === sites.length && read.every((s, i) => JSON.stringify(s) === JSON.stringify(sites[i])), "the boot reads the plan's labyrinth footprints", `${sites.length} labyrinths`)
  let unmoored = 0, crossing = 0
  for (const t of trails) {
    const [rx, rz] = t.mouth.split(',').map(Number)
    const m = labs.mazeOf(labs.siteOf(rx, rz))
    const pts = records.find((r) => r.id === t.record).pts
    const gx = (m.torches[0][0] + m.torches[1][0]) / 2, gz = (m.torches[0][1] + m.torches[1][1]) / 2
    if (Math.hypot(pts[0][0] - gx, pts[0][2] - gz) > 0.01) unmoored++
    for (let k = 1; k < pts.length; k++) {
      for (let i = 0; i < 8; i++) {
        const x = pts[k - 1][0] + ((pts[k][0] - pts[k - 1][0]) * i) / 8, z = pts[k - 1][2] + ((pts[k][2] - pts[k - 1][2]) * i) / 8
        if (labs.insideAt(x, z, -0.5)) crossing++
      }
    }
  }
  check(trails.length + failed.length === sites.length && trails.length >= sites.length * 0.8 && unmoored === 0 && crossing === 0, "a trail runs from most labyrinths' gates to the roads, through no labyrinth", `${trails.length} trails, no road reaches ${failed.length}, ${trails.filter((t) => t.onto !== 'road').length} join another`)
}

const key = worldPlanKey({ doc, relief: RELIEF_SHIPPED, seed: SEED, spawn: SPAWN })
check(key === worldPlanKey({ doc: JSON.parse(JSON.stringify(doc)), relief: { ...RELIEF_SHIPPED }, seed: SEED, spawn: { ...SPAWN } }), 'the key reads the inputs, not their identity')
check(key !== worldPlanKey({ doc, relief: RELIEF_DEFAULTS, seed: SEED, spawn: SPAWN }), 'another relief is another key')
check(key !== worldPlanKey({ doc: { ...doc, roads: [{ id: 'x', pts: [] }] }, relief: RELIEF_SHIPPED, seed: SEED, spawn: SPAWN }), 'another document is another key')

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
