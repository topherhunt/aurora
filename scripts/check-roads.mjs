// Node-side gates for the procedural roads, names, bridges and signposts (src/v2/layers/roads.js, names.js, src/v2/render/bridges.js; DESIGN.md §35).
//
//   node scripts/check-roads.mjs
//
// Plans towns, names and roads against the shipped world exactly as main.js does, then checks each rule the network promises. What this can NOT check: whether the roads look like they follow the valleys, or how the signs read. That needs eyes (tmp/roads/probe1.mjs draws the map).

import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { planTowns } from '../src/v2/layers/towns.js'
import { nameTowns } from '../src/v2/layers/names.js'
import { ROAD, STONE_BRIDGE, planRoads } from '../src/v2/layers/roads.js'
import { Bridges } from '../src/v2/render/bridges.js'
import { parseStoneBridge, stoneBridgeDeckAt } from '../src/bridges/stone-bridge.js'
import { buildTextureArray } from '../src/textures.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const root = new URL('../public/world/', import.meta.url)
const doc = JSON.parse(readFileSync(new URL('layers.json', root), 'utf8'))
check(doc.roads.length === 0, 'the overworld carries no hand-drawn roads', doc.roads.map((r) => r.id).join(', '))
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const layers = Layers.deserialize(doc)
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const ground = (x, z) => hm.sample(x, z)
const surface = (x, z) => field.heightAt(x, z)
const { towns, records: townRecords } = planTowns({ ground, surface, layers, seed: SEED, keepClear: [{ x: -320, z: 1367, r: 0 }] })
layers.addGenerated(townRecords)

// --- names ---
nameTowns(towns, { ground, layers, seed: SEED })
const names = towns.map((t) => t.name)
check(new Set(names).size === names.length, 'every town has a unique name', `${names.length} names`)
check(names.every((n) => /^[A-ZÅÄÖØÆ][a-zåäöøæ]{3,}$/.test(n)), 'every name is one capitalised word', names.filter((n) => !/^[A-ZÅÄÖØÆ][a-zåäöøæ]{3,}$/.test(n)).join(', '))
const featured = towns.filter((t) => t.features[0] !== 'plain').length
check(featured > towns.length / 2, 'most names draw on a nearby feature', `${featured} of ${towns.length}`)

// --- plan ---
const t0 = performance.now()
const plan = planRoads({ towns, ground, surface, layers, seed: SEED })
const ms = performance.now() - t0
check(ms < 2000, 'planning costs under 2 s of boot', `${ms.toFixed(0)} ms`)
const again = planRoads({ towns, ground, surface, layers, seed: SEED })
check(JSON.stringify(again.records) === JSON.stringify(plan.records), 'a second plan is identical to the bit')
const { records, ways, nodes, bridges, signs, failed } = plan

// Town connectivity over the ways, a town joining its own stubs through its streets.
const parent = [...nodes.map((_, i) => i), ...towns.map((_, i) => nodes.length + i)]
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
for (const w of ways) parent[find(w.a)] = find(w.b)
for (const n of nodes) if (n.town >= 0 && n.ways.length > 0) parent[find(n.id)] = find(nodes.length + n.town)
const sizes = new Map()
towns.forEach((_, i) => sizes.set(find(nodes.length + i), (sizes.get(find(nodes.length + i)) ?? 0) + 1))
const main = Math.max(...sizes.values())
const cut = towns.filter((_, i) => sizes.get(find(nodes.length + i)) !== main).map((t) => t.id)
check(main >= towns.length - 2, 'one web joins every town but at most two cut off by water or cliff', `${main} of ${towns.length}; cut off: ${cut.join(', ') || 'none'}; failed: ${failed.join(', ') || 'none'}`)
const ports = nodes.filter((n) => n.port)
const unused = ports.filter((n) => n.ways.length === 0)
check(unused.length <= ports.length * 0.1, 'nearly every stub out of a town carries on as a road', `${unused.length} of ${ports.length} unused`)
const forks = nodes.filter((n) => !n.port && n.town < 0 && n.bank === null && n.ways.length >= 3).length
check(forks >= towns.length / 2, 'roads often meet between towns', `${forks} forks`)

// Geometry of every laid way.
const laid = ways.filter((w) => w.pts)
let worst = 0
let wet = 0
let straightest = Infinity
let straightId = ''
for (const w of laid) {
  let len = 0
  for (let k = 1; k < w.pts.length; k++) {
    const [ax, ay, az] = w.pts[k - 1]
    const [bx, by, bz] = w.pts[k]
    const d = Math.hypot(bx - ax, bz - az)
    len += d
    worst = Math.max(worst, Math.abs(by - ay) / d)
  }
  for (const [x, , z] of w.pts) {
    const l = layers.waterLevelAt(x, z)
    if (l !== null && ground(x, z) < l) wet++
  }
  // Windiness: the largest sideways departure from the straight line between its ends, for ways long enough to wander.
  const [ax, , az] = w.pts[0]
  const [bx, , bz] = w.pts.at(-1)
  const chord = Math.hypot(bx - ax, bz - az)
  if (len < 150 || chord < 1) continue
  const off = Math.max(...w.pts.map(([x, , z]) => Math.abs((x - ax) * (bz - az) - (z - az) * (bx - ax)) / chord))
  if (off < straightest) { straightest = off; straightId = w.record }
}
check(worst <= 0.25, 'no stretch of road climbs steeper than 1 in 4', `worst segment ${worst.toFixed(3)}`)
check(wet === 0, 'no road point stands in a river or lake', `${wet} wet`)
check(straightest >= 6, 'no road 150 m or longer runs straight', `least wander ${straightest.toFixed(1)} m (${straightId})`)
check(records.every((r) => /^road\d/.test(r.id)) && new Set(records.map((r) => r.id)).size === records.length, 'every road record carries a unique generated id')
layers.addGenerated(records)
check(layers.serialize({ authored: true }).roads.length === 0, 'a save drops every generated road')

// --- bridges ---
const glb = readFileSync(new URL('../public/gen-props/bridge-stone.glb', import.meta.url))
const stone = parseStoneBridge(await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), ''))
const { meta } = stone
check(meta.params.span === STONE_BRIDGE.span && meta.xb === STONE_BRIDGE.xb && meta.bankA === STONE_BRIDGE.bank && Math.abs(meta.inner - STONE_BRIDGE.inner) < 1e-9, 'STONE_BRIDGE matches the shipped mesh', `span ${meta.params.span}, xb ${meta.xb}, bank ${meta.bankA}, inner ${meta.inner}`)
check(bridges.length >= 1, 'the roads cross at least one river on a bridge', `${bridges.length} of ${plan.crossings.length} candidate crossings`)
const scaleOk = bridges.every((b) => b.scale.every((s) => s >= 0.7 - 1e-9 && s <= 1.3 + 1e-9))
check(scaleOk, 'every bridge keeps each axis within 30% of the shipped size', bridges.map((b) => b.scale.map((s) => s.toFixed(2)).join('/')).join(' '))
let skew = 0
for (const b of bridges) {
  const s = layers.paths.drawnSamples(b.river)
  let best = 0
  for (let i = 0; i < s.length; i += 4) if (Math.hypot(s[i] - b.x, s[i + 2] - b.z) < Math.hypot(s[best] - b.x, s[best + 2] - b.z)) best = i
  const i0 = Math.max(0, best - 12)
  const i1 = Math.min(s.length - 4, best + 12)
  const tx = s[i1] - s[i0]
  const tz = s[i1 + 2] - s[i0 + 2]
  const [e0, e1] = b.ends
  const rx = e1[0] - e0[0]
  const rz = e1[2] - e0[2]
  skew = Math.max(skew, Math.abs(tx * rx + tz * rz) / (Math.hypot(tx, tz) * Math.hypot(rx, rz)))
}
check(skew < 0.1, 'every bridge crosses its river square', `worst |cos| ${skew.toFixed(3)}`)

// The mesh as placed: its ends meet the road tips, and the walker stands on its deck.
const layer = new Bridges(new THREE.Scene(), { bridges, stone, textures: buildTextureArray(), patch: (m) => m })
let gap = 0
let deckOk = true
for (const b of bridges) {
  for (const e of b.ends) {
    const lx = ((e[0] - b.x) * Math.cos(b.yaw) - (e[2] - b.z) * Math.sin(b.yaw)) / b.scale[0]
    gap = Math.max(gap, Math.abs(Math.abs(lx) - meta.xb), Math.abs(b.y + stoneBridgeDeckAt(meta, lx, 0) * b.scale[1] - e[1]))
    const road = records.find((r) => r.feather === 1 && Math.hypot(r.pts[1][0] - e[0], r.pts[1][2] - e[2]) < 0.01)
    if (!road || Math.abs(road.pts[1][1] - e[1]) > 0.01) gap = Infinity
  }
  const crest = b.y + stoneBridgeDeckAt(meta, 0, 0) * b.scale[1]
  deckOk &&= layer.deckAt(b.x, b.z) && Math.abs(layer.blockTopAt(b.x, b.z) - crest) < 0.01
}
check(gap < 0.05, 'every bridge end meets its road tip in plan and height', `worst ${gap.toFixed(3)} m`)
check(deckOk, 'the walker stands on the deck at every bridge crest')
layer.dispose()

// --- signposts ---
const signed = new Set(signs.map((s) => s.node))
check(nodes.every((n) => n.port || n.town >= 0 || n.bank !== null || n.ways.length < 3 || signed.has(n.id)), 'every fork between towns has a signpost', `${signs.length} signs`)
const boardsBad = signs.filter((s) => s.boards.length < ROAD.sign.boards[0] || s.boards.length > ROAD.sign.boards[1] || new Set(s.boards.map((b) => b.town)).size !== s.boards.length || s.boards.some((b, k) => k > 0 && b.dist < s.boards[k - 1].dist))
check(boardsBad.length === 0, `every signpost names ${ROAD.sign.boards.join('-')} distinct towns, nearest first`, boardsBad.slice(0, 3).map((s) => `node ${s.node}: ${s.boards.length}`).join(', '))

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nall road checks passed')
