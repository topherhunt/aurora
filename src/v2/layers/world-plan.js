// The overworld's towns, names, roads, cave mouths, labyrinths and their trails as one plan, which scripts/bake-world-plan.mjs lays at build time and the client lays live only when the baked one was laid against other inputs. Three-free.
import { planBuilding } from '../../buildings/plan.js'
import { TOWN, planTowns, townsOccupyAt } from './towns.js'
import { nameTowns } from './names.js'
import { ROAD, planRoads } from './roads.js'
import { routeTrails } from './trails.js'
import { Labyrinths } from './labyrinths.js'
import { WORLD_HALF } from '../config.js'
import { siteMouths } from '../caves/sites.js'
import { RELIEF_KNOBS } from '../height/relief.js'
import { earlyFetch } from '../early-fetch.js'
import { traceShore, shoreKey } from '../render/shoreline.js'
import { fieldRecord } from './trades.js'

/** Lays towns, names, roads, cave trails and labyrinth trails into `layers` (adding their records), as the overworld boot needs them. `ground` samples the raw `heightmap`, `field` is the live V2Height over `layers` and `surface` its heightAt. The mouths are sited on the roads' ground and the labyrinths on the cave trails', each before their own trails, which would move them. */
export function planWorld({ heightmap, ground, field, surface, layers, seed, spawn }) {
  const townPlan = planTowns({ ground, surface, layers, seed, keepClear: [{ ...spawn, r: 0 }] })
  layers.addGenerated(townPlan.records)
  nameTowns(townPlan.towns, { ground, layers, seed })
  const roadPlan = planRoads({ towns: townPlan.towns, ground, surface, layers, seed })
  layers.addGenerated(roadPlan.records)
  const wet = (x, z) => {
    const level = layers.waterLevelAt(x, z)
    return level !== null && surface(x, z) < level + 0.3
  }
  const route = routeTrails({ towns: townPlan.towns, roadPlan, surface, layers })
  // Off the mirrored strip past the real map, as the roads keep (roads.js buildGrid), and only where a trail can reach.
  const mouths = siteMouths({ heightmap, field: { heightAt: surface }, wet, keepOut: (x, z, r) => Math.abs(z) > TOWN.realZ - 60 || townsOccupyAt(townPlan.towns, x, z, r), reaches: (m) => route.start(m) >= 0 })
  const trailPlan = route.lay(mouths)
  layers.addGenerated(trailPlan.records)
  const labyrinthPlan = planLabyrinths({ towns: townPlan.towns, roadPlan, field, surface, layers, seed })
  layers.addGenerated(labyrinthPlan.records)
  return { townPlan, roadPlan, mouths, trailPlan, labyrinthPlan }
}

// Every labyrinth's footprint, and a trail (trails.js, ids `lane<k>`) from the gate between its torches to the roads, which keeps a half cell off every labyrinth's ground.
function planLabyrinths({ towns, roadPlan, field, surface, layers, seed }) {
  if (field.layers !== layers) throw new Error('planWorld: field must be the live height over layers')
  const labs = new Labyrinths({ seed, ground: field })
  const sites = labs.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF)
  const gates = sites.map((s) => {
    const { torches: [[ax, az], [bx, bz]], mouth } = labs.mazeOf(s)
    const x = (ax + bx) / 2, z = (az + bz) / 2, d = Math.hypot(mouth[0] - x, mouth[1] - z)
    return { id: `${s.rx},${s.rz}`, x, z, nx: (mouth[0] - x) / d, nz: (mouth[1] - z) / d, y: surface(x, z) }
  })
  const route = routeTrails({ towns, roadPlan, surface, layers, avoid: (x, z) => labs.reaches(x, z, ROAD.cell / 2) })
  return { sites, ...route.lay(gates, { prefix: 'lane', foot: (m, out) => ({ pins: [out(0)], level: 0 }) }) }
}

/** What a plan was laid against, short of the heightmap and the planner code, which ship in the same deploy as the bake. `doc` is the layers document as loaded, before Layers.deserialize. */
export function worldPlanKey({ doc, relief, seed, spawn }) {
  return cyrb53(JSON.stringify([doc, RELIEF_KNOBS.map((k) => relief[k.key]), seed, spawn.x, spawn.z]))
}

// Each building plan travels as the planBuilding inputs plus the two fields layoutTown seats it with, since the full plan is half the file and regenerates in ~20 ms for the lot. A post's `gate` is its first tether's `reach` and townPlan.records is every town's records: both are shared objects that JSON would split, so they are dropped here and rejoined in unpack.
export function packWorldPlan({ townPlan, roadPlan, mouths, trailPlan, labyrinthPlan }) {
  const towns = townPlan.towns.map((t) => ({
    ...t,
    buildings: t.buildings.map((b) => ({
      ...b,
      plan: { seed: b.plan.seed, style: b.plan.style, roof: b.plan.roofKind, plinthBottom: b.plan.plinthBottom, groundY: b.plan.steps ? b.plan.steps.groundY : null },
    })),
    posts: t.posts.map(({ gate, ...p }) => p),
  }))
  return { towns, roadPlan, mouths, trailPlan, labyrinthPlan }
}

export function unpackWorldPlan({ towns, roadPlan, mouths, trailPlan, labyrinthPlan }) {
  for (const t of towns) {
    for (const b of t.buildings) {
      const p = b.plan
      b.plan = planBuilding({ seed: p.seed, kind: b.kind, style: p.style, roof: p.roof })
      b.plan.plinthBottom = p.plinthBottom
      b.plan.wealth = b.wealth
      if (b.plan.steps) b.plan.steps.groundY = p.groundY
    }
    for (const post of t.posts) post.gate = post.tethers[0].reach
  }
  if (mouths === undefined || trailPlan === undefined) throw new Error('unpackWorldPlan: the plan carries no cave mouths or trails; re-bake it')
  if (labyrinthPlan === undefined) throw new Error('unpackWorldPlan: the plan carries no labyrinths; re-bake it')
  return { townPlan: { towns, records: towns.flatMap((t) => t.records) }, roadPlan, mouths, trailPlan, labyrinthPlan }
}

// What the plan puts in the layers beyond its records: the towns' farm fields, a cleft cut into the face at each cave mouth, and the labyrinths' footprints. The boot and the bake both reach the ground through this, so a shore baked against it is traced on the boot's ground.
export function applyWorldPlan(layers, { townPlan, mouths, labyrinthPlan }) {
  layers.setFields(townPlan.towns.flatMap((t) => t.works.filter((w) => w.kind === 'field').map(fieldRecord)))
  layers.setClefts(mouths.map((m) => [m.x, m.z, m.nx, m.nz, m.y]))
  layers.setLabyrinthSites(labyrinthPlan.sites)
}

// The traced shores (shoreline.js) of the lakes that carry no ring of their own, by lake id, for WaterSurfaces.rebuild's `baked`. `layers` must be as the boot has them when the water is built: the plan's records, the fields and the clefts all reshape the ground a shore is traced on.
export function packShores(layers, field) {
  const mm = (ring) => Array.from(ring, (v) => Math.round(v * 1000) / 1000)
  const out = {}
  for (const lake of layers.lakes.lakes.values()) {
    if (lake.ring) continue
    const s = traceShore(lake, field)
    out[lake.id] = {
      key: shoreKey(lake),
      shore: { polygons: s.polygons.map((p) => ({ outer: mm(p.outer), holes: p.holes.map(mm), area: p.area })), slabs: s.slabs, vertices: s.vertices, samples: 0 },
    }
  }
  return out
}

/** The baked `{ key, plan, shores }`, or null when the deploy carries none (the dev server answers index.html for a missing file). */
export async function loadWorldPlan(url) {
  const res = await earlyFetch(url, { cache: 'no-cache' })
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
