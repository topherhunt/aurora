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
import { Heap } from '../src/v2/layers/route.js'
import { footprint } from '../src/v2/layers/water-bodies.js'
import { BRIDGE_BANDS, Bridges } from '../src/v2/render/bridges.js'
import { LitterCards } from '../src/v2/render/litter-cards.js'
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
check(ms < 2500, 'planning costs under 2.5 s of boot', `${ms.toFixed(0)} ms`)
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

// Geometry of every laid way. The lake drawn over a point is the highest plane covering it, as WaterSurfaces draws; LakeSet.levelAt answers the ocean inside a small lake.
const laid = ways.filter((w) => w.pts)
const lakes = [...layers.lakes.lakes.values()]
const lakeOver = (x, z) => Math.max(-Infinity, ...lakes.filter((l) => footprint(l, x, z) > 0).map((l) => l.y))
let worst = 0
let wet = 0
let drowned = 0
let drownAt = ''
let straightest = Infinity
let straightId = ''
let deepest = 0
let deepAt = ''
for (const w of laid) {
  let len = 0
  for (let k = 1; k < w.pts.length; k++) {
    const [ax, ay, az] = w.pts[k - 1]
    const [bx, by, bz] = w.pts[k]
    const d = Math.hypot(bx - ax, bz - az)
    len += d
    worst = Math.max(worst, Math.abs(by - ay) / d)
    for (let f = 0; f < 1; f += 2 / d) {
      if (ay + (by - ay) * f < lakeOver(ax + (bx - ax) * f, az + (bz - az) * f) + 0.3 && !drowned++) drownAt = `(${(ax + (bx - ax) * f).toFixed(0)}, ${(az + (bz - az) * f).toFixed(0)}) on ${w.record}`
      if ([w.a, w.b].some((id) => nodes[id].port && Math.hypot(nodes[id].port.end[0] - ax - (bx - ax) * f, nodes[id].port.end[2] - az - (bz - az) * f) < 30)) continue
      const cut = surface(ax + (bx - ax) * f, az + (bz - az) * f) - (ay + (by - ay) * f)
      if (cut > deepest) { deepest = cut; deepAt = `(${(ax + (bx - ax) * f).toFixed(0)}, ${(az + (bz - az) * f).toFixed(0)})` }
    }
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
check(drowned === 0, 'no road centre stands under or within 0.3 m of lake water, read every 2 m against the highest lake plane over it', `${drowned} samples${drowned ? `, first at ${drownAt}` : ''}`)
check(straightest >= 6, 'no road 150 m or longer runs straight', `least wander ${straightest.toFixed(1)} m (${straightId})`)
check(deepest <= 2, 'no road centre sinks more than 2 m under the ground, read every 2 m, but within 30 m of a town stub it meets', `deepest ${deepest.toFixed(2)} m at ${deepAt}`)
// Forks: the directions each road leaves a node in, read 20 m out, and a port's stub.
const wayById = new Map(ways.map((w) => [w.id, w]))
const leaving = (n, w) => {
  if (!w.pts) { const o = nodes[w.a === n.id ? w.b : w.a]; return Math.atan2(o.z - n.z, o.x - n.x) }
  const pts = w.a === n.id ? w.pts : [...w.pts].reverse()
  let k = n.port ? 2 : 1
  while (k < pts.length - 1 && Math.hypot(pts[k][0] - n.x, pts[k][2] - n.z) < 20) k++
  return Math.atan2(pts[k][2] - n.z, pts[k][0] - n.x)
}
let sharpest = Math.PI
let sharpAt = ''
for (const n of nodes) {
  const dirs = n.ways.map((id) => leaving(n, wayById.get(id)))
  if (n.port) { const stub = towns[n.town].roads[n.port.stub]; const p = stub.at(-3) ?? stub[0]; dirs.push(Math.atan2(p[2] - n.z, p[0] - n.x)) }
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    const a = Math.abs(((dirs[i] - dirs[j] + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
    if (a < sharpest) { sharpest = a; sharpAt = `(${n.x.toFixed(0)}, ${n.z.toFixed(0)})` }
  }
}
check(sharpest >= Math.PI / 3, 'roads part at a fork 60 deg or wider, read 20 m out', `sharpest ${((sharpest * 180) / Math.PI).toFixed(0)} deg at ${sharpAt}`)
// Crossings: two ways' segments that cross anywhere but at a node they share.
const segs = []
const bins = new Map()
for (const w of laid) for (let k = 1; k < w.pts.length; k++) {
  const sg = { w, a: w.pts[k - 1], b: w.pts[k] }
  const i0 = Math.floor(Math.min(sg.a[0], sg.b[0]) / 32)
  const j0 = Math.floor(Math.min(sg.a[2], sg.b[2]) / 32)
  for (let i = i0; i <= Math.floor(Math.max(sg.a[0], sg.b[0]) / 32); i++) for (let j = j0; j <= Math.floor(Math.max(sg.a[2], sg.b[2]) / 32); j++) {
    const key = `${i},${j}`
    if (!bins.has(key)) bins.set(key, [])
    bins.get(key).push(segs.length)
  }
  segs.push(sg)
}
const side = (o, a, b) => (a[0] - o[0]) * (b[2] - o[2]) - (a[2] - o[2]) * (b[0] - o[0])
const crossings = new Set()
for (const list of bins.values()) for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
  const s = segs[list[x]]
  const t = segs[list[y]]
  if (s.w === t.w || side(s.a, s.b, t.a) > 0 === side(s.a, s.b, t.b) > 0 || side(t.a, t.b, s.a) > 0 === side(t.a, t.b, s.b) > 0) continue
  const f = side(t.a, t.b, s.a) / (side(t.a, t.b, s.a) - side(t.a, t.b, s.b))
  const px = s.a[0] + (s.b[0] - s.a[0]) * f
  const pz = s.a[2] + (s.b[2] - s.a[2]) * f
  const shared = [s.w.a, s.w.b].filter((id) => id === t.w.a || id === t.w.b)
  if (!shared.some((id) => Math.hypot(nodes[id].x - px, nodes[id].z - pz) < 3)) crossings.add(`(${px.toFixed(0)}, ${pz.toFixed(0)})`)
}
check(crossings.size === 0, 'no two roads cross but at a fork', [...crossings].slice(0, 4).join(' '))
// Directness: road distance, through towns' streets, from each town to its ROAD.near nearest, over the straight distance. Cliffs and water force a share of long ways round (town8 to town34: 520 m apart across a 70 m drop).
const adj = Array.from({ length: nodes.length + towns.length }, () => [])
const link = (u, v, l) => { adj[u].push([v, l]); adj[v].push([u, l]) }
for (const w of ways) link(w.a, w.b, w.length ?? Math.hypot(nodes[w.a].x - nodes[w.b].x, nodes[w.a].z - nodes[w.b].z))
for (const n of nodes) if (n.town >= 0) link(n.id, nodes.length + n.town, Math.hypot(n.x - towns[n.town].x, n.z - towns[n.town].z))
const ratios = []
towns.forEach((a, ai) => {
  const D = new Float64Array(adj.length).fill(Infinity)
  D[nodes.length + ai] = 0
  const open = [nodes.length + ai]
  while (open.length) {
    open.sort((p, q) => D[q] - D[p])
    const u = open.pop()
    for (const [v, l] of adj[u]) if (D[u] + l < D[v]) { D[v] = D[u] + l; open.push(v) }
  }
  const near = towns.map((b, bi) => [bi, Math.hypot(a.x - b.x, a.z - b.z)]).filter(([bi, d]) => bi !== ai && d < ROAD.near.r).sort((p, q) => p[1] - q[1]).slice(0, ROAD.near.k)
  for (const [bi, d] of near) if (D[nodes.length + bi] < Infinity) ratios.push(D[nodes.length + bi] / d)
})
ratios.sort((p, q) => p - q)
const median = ratios[Math.floor(ratios.length / 2)]
const past2 = ratios.filter((r) => r > 2).length / ratios.length
check(median < 1.9 && past2 < 0.42, 'a town reaches its nearest neighbours by road at under 1.9x their distance apart, median, and past 2x for under 42%', `median ${median.toFixed(2)}, ${(100 * past2).toFixed(1)}% past 2x`)
// Evenness: roads passing close without a link between them, sampled every 100 m, gathered into 400 m spots. The spots left are across cliffs.
const samples = []
for (const w of laid) {
  let arc = 0
  for (let k = 1, next = 50; k < w.pts.length; k++) {
    arc += Math.hypot(w.pts[k][0] - w.pts[k - 1][0], w.pts[k][2] - w.pts[k - 1][2])
    if (arc >= next) { samples.push({ w, x: w.pts[k][0], z: w.pts[k][2], s: arc }); next += 100 }
  }
}
const spots = []
for (const p of samples) {
  const D = new Float64Array(adj.length).fill(Infinity)
  const heap = new Heap(64)
  for (const [id, d] of [[p.w.a, p.s], [p.w.b, p.w.length - p.s]]) if (d < D[id]) { D[id] = d; heap.push(d, id) }
  while (heap.n > 0) {
    const f = heap.f[0]
    const u = heap.pop()
    if (f > D[u]) continue
    for (const [v, l] of adj[u]) if (f + l < D[v]) { D[v] = f + l; heap.push(D[v], v) }
  }
  const miss = samples.some((q) => {
    const d = Math.hypot(q.x - p.x, q.z - p.z)
    const round = Math.min(D[q.w.a] + q.s, D[q.w.b] + q.w.length - q.s)
    return q.w !== p.w && d < 300 && round > 4 * d && round - d > 1000
  })
  if (miss && !spots.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 400)) spots.push(p)
}
check(spots.length <= 6, 'at most 6 spots where two roads pass within 300 m but are over 4x and 1 km apart by road', `${spots.length}: ${spots.map((s) => `(${s.x.toFixed(0)}, ${s.z.toFixed(0)})`).join(' ')}`)
const forkNodes = nodes.filter((n) => !n.port && n.town < 0 && n.bank === null && n.ways.length >= 3)
const crowded = forkNodes.filter((f) => forkNodes.some((g) => g !== f && Math.hypot(g.x - f.x, g.z - f.z) < 60)).length
check(crowded < forkNodes.length / 4, 'under a quarter of forks stand within 60 m of another', `${crowded} of ${forkNodes.length}`)
check(records.every((r) => /^road\d/.test(r.id)) && new Set(records.map((r) => r.id)).size === records.length, 'every road record carries a unique generated id')
layers.addGenerated(records)
check(layers.serialize({ authored: true }).roads.length === 0, 'a save drops every generated road')

// --- bridges ---
const glb = readFileSync(new URL('../public/gen-props/bridge-stone.glb', import.meta.url))
const stone = parseStoneBridge(await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), ''))
const { meta } = stone
check(meta.params.span === STONE_BRIDGE.span && meta.xb === STONE_BRIDGE.xb && meta.bankA === STONE_BRIDGE.bank && Math.abs(meta.inner - STONE_BRIDGE.inner) < 1e-9, 'STONE_BRIDGE matches the shipped mesh', `span ${meta.params.span}, xb ${meta.xb}, bank ${meta.bankA}, inner ${meta.inner}`)
check(bridges.length >= 1, 'the roads cross at least one river on a bridge', `${bridges.length} of ${plan.crossings.length} candidate crossings`)
const scaleOk = bridges.every((b) => b.scale.every((s, k) => s >= 0.7 - 1e-9 && s <= (k === 0 ? ROAD.cross.stretch : 1.3) + 1e-9))
check(scaleOk, 'every bridge keeps its height and width within 30% of the shipped size, its length 0.7 to 1.8x', bridges.map((b) => b.scale.map((s) => s.toFixed(2)).join('/')).join(' '))
let skew = 0
for (const b of bridges.filter((b) => b.river !== null)) {
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

// The mesh as placed: each span's ends meet a road tip or the next span's end, and the walker stands on its deck.
const litterCards = new LitterCards(64)
const layer = new Bridges(new THREE.Scene(), { bridges, stone, textures: buildTextureArray(), patch: (m) => m, water: { riverLiftAt: () => 0 }, cards: litterCards })
let gap = 0
let deckOk = true
let lakeSpans = 0
let underDeck = 0
for (const b of bridges) {
  for (const e of b.ends) {
    const lx = ((e[0] - b.x) * Math.cos(b.yaw) - (e[2] - b.z) * Math.sin(b.yaw)) / b.scale[0]
    // Read at the deck's edge: the centre line carries the camber, which the road tip does not.
    gap = Math.max(gap, Math.abs(Math.abs(lx) - meta.xb), Math.abs(b.y + stoneBridgeDeckAt(meta, lx, meta.inner) * b.scale[1] - e[1]))
    const road = records.find((r) => r.feather === 1 && Math.hypot(r.pts[1][0] - e[0], r.pts[1][2] - e[2]) < 0.01)
    const span = bridges.find((o) => o !== b && o.ends.some((f) => Math.hypot(f[0] - e[0], f[2] - e[2]) < 0.01 && Math.abs(f[1] - e[1]) < 0.01))
    if (span ? road : !road || Math.abs(road.pts[1][1] - e[1]) > 0.01) gap = Infinity
  }
  if (b.river === null) {
    lakeSpans++
    for (let lx = 1 - meta.xb; lx < meta.xb - 1; lx += 1) {
      const x = b.x + lx * b.scale[0] * Math.cos(b.yaw)
      const z = b.z - lx * b.scale[0] * Math.sin(b.yaw)
      underDeck = Math.max(underDeck, surface(x, z) - (b.y + stoneBridgeDeckAt(meta, lx, 0) * b.scale[1]))
    }
  }
  const crest = b.y + stoneBridgeDeckAt(meta, 0, 0) * b.scale[1]
  deckOk &&= layer.deckAt(b.x, b.z) && Math.abs(layer.blockTopAt(b.x, b.z) - crest) < 0.01
}
check(gap < 0.05, 'every bridge end meets its road tip in plan and height', `worst ${gap.toFixed(3)} m`)
check(deckOk, 'the walker stands on the deck at every bridge crest')
check(underDeck <= 0, 'no ground rises through a lake bridge deck', `${lakeSpans} lake spans; ground at most ${underDeck.toFixed(2)} m against the deck`)
// The far band is the bridge's photograph on the shared litter cards, not a mesh of its own: nothing until the picture is in, then a card lying at the deck.
const far = layer.items[0]
const farEye = { x: far.x + (BRIDGE_BANDS.lod1 + BRIDGE_BANDS.far) / 2, z: far.z }
layer.update(farEye)
const blankBefore = !far.mesh.visible && !layer.cards.getVisibleAt(far.card)
layer.setCard()
layer.update(farEye)
const cardY = layer.cards.getMatrixAt(far.card, new THREE.Matrix4()).elements[13]
check(blankBefore && !far.mesh.visible && layer.cards.getVisibleAt(far.card) && layer.cards.layer[far.card] === layer.cardPicture && Math.abs(cardY - (far.y + stone.lods[2].boundingBox.max.y * far.scale[1])) < 1e-3,
  'a far bridge draws as its card in the shared pool, and nothing before the card is baked', `card ${(cardY - far.y).toFixed(2)} m over the water`)
layer.update({ x: far.x + (BRIDGE_BANDS.lod0 + BRIDGE_BANDS.lod1) / 2, z: far.z })
check(far.mesh.visible && far.mesh.geometry === stone.lods[1] && !layer.cards.getVisibleAt(far.card), 'a bridge in the middle band is its LOD1 mesh and its card is hidden')
layer.dispose()

// --- signposts ---
const signed = new Set(signs.map((s) => s.node))
check(nodes.every((n) => n.port || n.town >= 0 || n.bank !== null || n.ways.length < 3 || signed.has(n.id)), 'every fork between towns has a signpost', `${signs.length} signs`)
// Every way ends at a fork, a town or a bridge, and its waymarks split it into stretches no longer than link.every.
const endsBad = laid.filter((w) => [w.a, w.b].some((id) => { const n = nodes[id]; return !n.port && n.bank === null && n.ways.length < 3 }))
let longest = 0
for (const w of laid) {
  const marks = signs.filter((s) => s.way === w.id)
  const nearRoad = marks.every((s) => w.pts.some(([x, , z]) => Math.hypot(x - s.x, z - s.z) < ROAD.spacing + ROAD.sign.offset))
  longest = Math.max(longest, nearRoad ? w.length / (marks.length + 1) : Infinity)
}
check(endsBad.length === 0 && longest <= ROAD.link.every, `a traveller meets a fork, town, bridge or waymark at least every ${ROAD.link.every} m`, `longest stretch ${longest.toFixed(0)} m; ${signs.filter((s) => s.node < 0).length} waymarks; ${endsBad.length} ways ending nowhere`)
// The towns a sign's roads reach without passing through a town, as the signs count them; a sign reaching fewer than boards[0] names every one.
const up = nodes.map((n) => n.id)
const top = (i) => (up[i] === i ? i : (up[i] = top(up[i])))
for (const w of ways) up[top(w.a)] = top(w.b)
const townsOn = new Map()
for (const n of nodes) if (n.town >= 0) townsOn.set(top(n.id), (townsOn.get(top(n.id)) ?? new Set()).add(n.town))
const reachable = (s) => townsOn.get(top(s.node >= 0 ? s.node : ways.find((w) => w.id === s.way).a))?.size ?? 0
const boardsBad = signs.filter((s) => s.boards.length < Math.min(ROAD.sign.boards[0], reachable(s)) || s.boards.length > ROAD.sign.boards[1] || new Set(s.boards.map((b) => b.town)).size !== s.boards.length || s.boards.some((b, k) => k > 0 && b.dist < s.boards[k - 1].dist))
check(boardsBad.length === 0, `every signpost names ${ROAD.sign.boards.join('-')} distinct towns (or every town its roads reach), nearest first`, boardsBad.slice(0, 3).map((s) => `node ${s.node}: ${s.boards.length}`).join(', '))

if (failures > 0) {
  console.log(`\n${failures} FAILED`)
  process.exit(1)
}
console.log('\nall road checks passed')
