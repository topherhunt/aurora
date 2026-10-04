// Lays the overworld's towns, roads, cave mouths and trails against the shipped world and writes them as world/plan.json, which the client reads instead of laying them (src/v2/layers/world-plan.js). vite.config.js runs it for `npm run build` and for the dev server.
//
//   node scripts/bake-world-plan.mjs <out.json>

import { readFileSync, writeFileSync } from 'node:fs'
import { SEED, SPAWN } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planWorld, packWorldPlan, worldPlanKey } from '../src/v2/layers/world-plan.js'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/bake-world-plan.mjs <out.json>')
const t0 = performance.now()
const root = new URL('../public/world/', import.meta.url)
const doc = JSON.parse(readFileSync(new URL('layers.json', root), 'utf8'))
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(structuredClone(doc))
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const plan = planWorld({ heightmap: hm, ground: (x, z) => hm.sample(x, z), surface: (x, z) => field.heightAt(x, z), layers, seed: SEED, spawn: SPAWN })
const text = JSON.stringify({ key: worldPlanKey({ doc, relief: RELIEF_SHIPPED, seed: SEED, spawn: SPAWN }), plan: packWorldPlan(plan) })
writeFileSync(out, text)
console.log(`[bake-world-plan] ${plan.townPlan.towns.length} towns, ${plan.roadPlan.ways.length} ways, ${(text.length / 1024).toFixed(0)} KB in ${(performance.now() - t0).toFixed(0)} ms -> ${out}`)
