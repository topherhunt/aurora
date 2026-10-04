// The overworld's towns, names and roads as one plan, which scripts/bake-world-plan.mjs lays at build time and the client lays live only when the baked one was laid against other inputs. Three-free.
import { planBuilding } from '../../buildings/plan.js'
import { planTowns } from './towns.js'
import { nameTowns } from './names.js'
import { planRoads } from './roads.js'
import { RELIEF_KNOBS } from '../height/relief.js'

/** Lays towns, names and roads into `layers` (adding their records), as the overworld boot needs them. `ground` is the raw heightmap, `surface` the live field over `layers`. */
export function planWorld({ ground, surface, layers, seed, spawn }) {
  const townPlan = planTowns({ ground, surface, layers, seed, keepClear: [{ ...spawn, r: 0 }] })
  layers.addGenerated(townPlan.records)
  nameTowns(townPlan.towns, { ground, layers, seed })
  const roadPlan = planRoads({ towns: townPlan.towns, ground, surface, layers, seed })
  layers.addGenerated(roadPlan.records)
  return { townPlan, roadPlan }
}

/** What a plan was laid against, short of the heightmap and the planner code, which ship in the same deploy as the bake. `doc` is the layers document as loaded, before Layers.deserialize. */
export function worldPlanKey({ doc, relief, seed, spawn }) {
  return cyrb53(JSON.stringify([doc, RELIEF_KNOBS.map((k) => relief[k.key]), seed, spawn.x, spawn.z]))
}

// Each building plan travels as the planBuilding inputs plus the two fields layoutTown seats it with, since the full plan is half the file and regenerates in ~20 ms for the lot. A post's `gate` is its first tether's `reach` and townPlan.records is every town's records: both are shared objects that JSON would split, so they are dropped here and rejoined in unpack.
export function packWorldPlan({ townPlan, roadPlan }) {
  const towns = townPlan.towns.map((t) => ({
    ...t,
    buildings: t.buildings.map((b) => ({
      ...b,
      plan: { seed: b.plan.seed, style: b.plan.style, roof: b.plan.roofKind, plinthBottom: b.plan.plinthBottom, groundY: b.plan.steps ? b.plan.steps.groundY : null },
    })),
    posts: t.posts.map(({ gate, ...p }) => p),
  }))
  return { towns, roadPlan }
}

export function unpackWorldPlan({ towns, roadPlan }) {
  for (const t of towns) {
    for (const b of t.buildings) {
      const p = b.plan
      b.plan = planBuilding({ seed: p.seed, kind: b.kind, style: p.style, roof: p.roof })
      b.plan.plinthBottom = p.plinthBottom
      if (b.plan.steps) b.plan.steps.groundY = p.groundY
    }
    for (const post of t.posts) post.gate = post.tethers[0].reach
  }
  return { townPlan: { towns, records: towns.flatMap((t) => t.records) }, roadPlan }
}

/** The baked `{ key, plan }`, or null when the deploy carries none (the dev server answers index.html for a missing file). */
export async function loadWorldPlan(url) {
  const res = await fetch(url, { cache: 'no-cache' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`load ${url} failed: HTTP ${res.status}`)
  const text = await res.text()
  if (text.trimStart().startsWith('<')) return null
  return JSON.parse(text)
}

// cyrb53: a fast 53-bit string hash, as a hex string.
function cyrb53(str) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
