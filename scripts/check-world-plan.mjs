// Node-side gate for the baked overworld plan (src/v2/layers/world-plan.js, scripts/bake-world-plan.mjs).
//
//   node scripts/check-world-plan.mjs
//
// A baked plan read back must be the live plan to the bit, down to which objects are shared, since the client trusts it in place of laying one.

import { readFileSync } from 'node:fs'
import { SEED, SPAWN } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED, RELIEF_DEFAULTS } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planWorld, packWorldPlan, unpackWorldPlan, worldPlanKey } from '../src/v2/layers/world-plan.js'

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
const live = planWorld({ heightmap: hm, ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, spawn: SPAWN })

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

const key = worldPlanKey({ doc, relief: RELIEF_SHIPPED, seed: SEED, spawn: SPAWN })
check(key === worldPlanKey({ doc: JSON.parse(JSON.stringify(doc)), relief: { ...RELIEF_SHIPPED }, seed: SEED, spawn: { ...SPAWN } }), 'the key reads the inputs, not their identity')
check(key !== worldPlanKey({ doc, relief: RELIEF_DEFAULTS, seed: SEED, spawn: SPAWN }), 'another relief is another key')
check(key !== worldPlanKey({ doc: { ...doc, roads: [{ id: 'x', pts: [] }] }, relief: RELIEF_SHIPPED, seed: SEED, spawn: SPAWN }), 'another document is another key')

if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
