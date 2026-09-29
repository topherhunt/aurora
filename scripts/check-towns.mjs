// Node-side gates for the procedural towns (src/v2/layers/towns.js, src/v2/render/towns.js; DESIGN.md §32).
//
//   node scripts/check-towns.mjs
//
// Plans the towns against the shipped heightmap and layers exactly as main.js does, then checks each rule the layout promises. What this can NOT check: whether a town looks like a village. That needs eyes (tmp/townshot-drive.mjs).

import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { SEED } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { serialize } from '../src/v2/layers/doc.js'
import { TOWN, planTowns, boxesOverlap } from '../src/v2/layers/towns.js'
import { TOWN_BANDS, Towns } from '../src/v2/render/towns.js'
import { buildTextureArray } from '../src/textures.js'
import { buildRockBank } from '../src/props/rock-bank.js'
import { Hearth, hearthKit } from '../src/v2/render/hearth.js'
import { CLIPS, TOWNSFOLK, TownLife, townGraph } from '../src/v2/render/townsfolk.js'
import { Journeys } from '../src/v2/render/journeys.js'
import { planRoads } from '../src/v2/layers/roads.js'
import { SEAT_M } from '../src/v2/render/villagers.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const root = new URL('../public/world/', import.meta.url)
const hm = await Heightmap.read({ path: new URL('height.png', root), metaPath: new URL('height.json', root) })
const loadLayers = () => Layers.deserialize(JSON.parse(readFileSync(new URL('layers.json', root), 'utf8')))
const layers = loadLayers()
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
field.setLayers(layers)
const ground = (x, z) => hm.sample(x, z)
// main.js's overworld SPAWN.
const SPAWN = { x: -320, z: 1367 }
const keepClear = [{ ...SPAWN, r: 0 }]

const t0 = performance.now()
const surface = (x, z) => field.heightAt(x, z)
const { towns, records } = planTowns({ ground, surface, layers, seed: SEED, keepClear })
const ms = performance.now() - t0
check(towns.length >= 48, 'the map holds about a town per square kilometre', `${towns.length} in ${ms.toFixed(0)} ms`)
const snowy = towns.filter((t) => t.y > layers.snow.base).length
check(snowy < towns.length / 4, 'fewer towns stand above the snow than below', `${snowy} of ${towns.length}`)
check(ms < 3000, 'planning costs under 3 s of boot', `${ms.toFixed(0)} ms`)

// --- siting ---
let closest = Infinity
for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) closest = Math.min(closest, Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z))
check(closest >= TOWN.site.spacing, `no two towns closer than ${TOWN.site.spacing} m`, `closest ${closest.toFixed(0)} m`)
const spawnDist = Math.min(...towns.map((t) => Math.hypot(t.x - SPAWN.x, t.z - SPAWN.z)))
check(spawnDist >= TOWN.site.keepClear, 'no town within keepClear of the spawn', `${spawnDist.toFixed(0)} m`)
const inReal = towns.every((t) => Math.abs(t.z) + t.radius < TOWN.realZ)
check(inReal, 'every town lies inside the real map, off the mirror band')
// Siting prefers water and cliffs (TOWN.site.water, TOWN.site.cliff). About 13% of flat sites have water within 220 m, so a fifth of towns by water is already a strong preference.
const around = (t, radii, f) => radii.some((r) => Array.from({ length: 12 }, (_, k) => (k / 12) * Math.PI * 2).some((a) => f(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r)))
const byWater = towns.filter((t) => around(t, TOWN.site.water, (x, z) => { const l = layers.waterLevelAt(x, z); return l !== null && ground(x, z) < l })).length
const slope = (x, z) => Math.hypot(ground(x + 4, z) - ground(x - 4, z), ground(x, z + 4) - ground(x, z - 4)) / 8
const byCliff = towns.filter((t) => around(t, TOWN.site.cliff.r, (x, z) => slope(x, z) > TOWN.site.cliff.slope[0])).length
const byEither = towns.filter((t) => around(t, TOWN.site.water, (x, z) => { const l = layers.waterLevelAt(x, z); return l !== null && ground(x, z) < l }) || around(t, TOWN.site.cliff.r, (x, z) => slope(x, z) > TOWN.site.cliff.slope[0])).length
check(byWater >= towns.length * 0.2 && byEither > towns.length * 0.6, 'towns nestle by water or under a cliff', `${byWater} by water, ${byCliff} by a cliff, ${byEither} either, of ${towns.length}`)
let worstRange = 0
for (const t of towns) {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < 24; k++) {
    for (const r of [0, TOWN.site.flatR / 2, TOWN.site.flatR]) {
      const h = ground(t.x + Math.cos((k / 24) * Math.PI * 2) * r, t.z + Math.sin((k / 24) * Math.PI * 2) * r)
      lo = Math.min(lo, h)
      hi = Math.max(hi, h)
    }
  }
  worstRange = Math.max(worstRange, hi - lo)
}
check(worstRange <= TOWN.site.flatMax + 2, `every centre is flat: rise within ${TOWN.site.flatR} m under ${TOWN.site.flatMax + 2} m`, `worst ${worstRange.toFixed(1)} m`)

// --- layout ---
const counts = towns.map((t) => t.buildings.length)
check(counts.every((n) => n >= TOWN.count[0] && n <= TOWN.count[1]), `every town has ${TOWN.count[0]}..${TOWN.count[1]} buildings`, counts.join(' '))
check(towns.every((t) => t.clearingR === TOWN.clearing.r), `every clearing is r = ${TOWN.clearing.r} m`)

let overlaps = 0
let inClearing = 0
for (const t of towns) {
  for (let i = 0; i < t.buildings.length; i++) {
    const b = t.buildings[i]
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.box.x + u * b.box.hx * b.box.c + v * b.box.hz * b.box.s, b.box.z - u * b.box.hx * b.box.s + v * b.box.hz * b.box.c])
    if (corners.some(([x, z]) => Math.hypot(x - t.x, z - t.z) < t.clearingR)) inClearing++
    for (let j = i + 1; j < t.buildings.length; j++) if (boxesOverlap(b.box, t.buildings[j].box, 0.5)) overlaps++
  }
}
check(overlaps === 0, 'no two buildings stand within 0.5 m of each other', `${overlaps} pairs`)
check(inClearing === 0, 'no building intrudes on the clearing', `${inClearing}`)

// Prestige: the inns and longhouses sit nearer the centre than the huts, and thatch lies further out than slate and tile.
const meanR = (list) => list.reduce((s, [t, b]) => s + Math.hypot(b.x - t.x, b.z - t.z), 0) / list.length
const all = towns.flatMap((t) => t.buildings.map((b) => [t, b]))
const grand = all.filter(([, b]) => b.kind === 'inn' || b.kind === 'longhouse')
const huts = all.filter(([, b]) => b.kind === 'hut')
check(meanR(grand) < meanR(huts), 'inns and longhouses sit nearer the centre than huts', `${meanR(grand).toFixed(1)} vs ${meanR(huts).toFixed(1)} m`)
const thatch = all.filter(([, b]) => b.plan.roofKind === 'thatch')
const fine = all.filter(([, b]) => b.plan.roofKind === 'slate' || b.plan.roofKind === 'pantile')
check(thatch.length > 0 && fine.length > 0 && meanR(fine) < meanR(thatch), 'slate and tile roofs sit nearer the centre than thatch', `${meanR(fine).toFixed(1)} vs ${meanR(thatch).toFixed(1)} m`)

// Density: the inner half of the buildings stand closer to their nearest neighbour than the outer half.
let innerGap = 0
let outerGap = 0
for (const t of towns) {
  const sorted = [...t.buildings].sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z))
  const nn = sorted.map((b) => Math.min(...t.buildings.filter((o) => o !== b).map((o) => Math.hypot(o.x - b.x, o.z - b.z))))
  const half = Math.floor(nn.length / 2)
  innerGap += nn.slice(0, half).reduce((s, d) => s + d, 0) / half
  outerGap += nn.slice(half).reduce((s, d) => s + d, 0) / (nn.length - half)
}
check(innerGap < outerGap, 'buildings crowd the centre and spread outward', `nearest neighbour ${(innerGap / towns.length).toFixed(1)} vs ${(outerGap / towns.length).toFixed(1)} m`)

// Paths: one per building, starting at its door, ending on the network within path.max.
let pathBad = 0
for (const t of towns) {
  if (t.paths.length !== t.buildings.length) pathBad++
  t.buildings.forEach((b, i) => {
    const p = t.paths[i].pts
    if (Math.hypot(p[0][0] - b.door[0], p[0][2] - b.door[1]) > 0.01) pathBad++
    if (Math.hypot(p.at(-1)[0] - p[0][0], p.at(-1)[2] - p[0][2]) > TOWN.path.max + 0.01) pathBad++
    const [lx, lz] = [(b.door[0] - b.box.x) * b.box.c - (b.door[1] - b.box.z) * b.box.s, (b.door[0] - b.box.x) * b.box.s + (b.door[1] - b.box.z) * b.box.c]
    if (Math.abs(lz - b.box.hz - 0.3) > 0.01 || Math.abs(lx) > b.box.hx) pathBad++
  })
}
check(pathBad === 0, 'every door stands just off the front of its box, with a path from it ending on the network', `${pathBad} bad`)

// Roads: one or two per town, each leaving the clearing and stopping near the outskirts.
let roadBad = []
for (const t of towns) {
  if (t.roads.length < 1 || t.roads.length > 2) roadBad.push(`${t.id} has ${t.roads.length}`)
  for (const pts of t.roads) {
    const end = Math.hypot(pts.at(-1)[0] - t.x, pts.at(-1)[2] - t.z)
    if (end > t.radius + TOWN.road.past + TOWN.road.step + 2) roadBad.push(`${t.id} road ends ${end.toFixed(0)} m out`)
    if (Math.hypot(pts[0][0] - t.x, pts[0][2] - t.z) > t.clearingR) roadBad.push(`${t.id} road starts outside the clearing`)
  }
}
check(roadBad.length === 0, 'every town has 1..2 roads from the clearing to the outskirts', roadBad.slice(0, 3).join(', '))

// --- determinism and persistence ---
const again = (() => {
  const l = loadLayers()
  const f = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
  f.setLayers(l)
  return planTowns({ ground, surface: (x, z) => f.heightAt(x, z), layers: l, seed: SEED, keepClear })
})()
check(JSON.stringify(again.records) === JSON.stringify(records), 'a second plan is identical to the bit')

check(records.every((r) => /^town\d/.test(r.id)), 'every generated record carries a town id')
layers.addGenerated(records)
const roadsLive = serialize(layers).roads
const roadsSaved = layers.serialize({ authored: true }).roads
check(roadsLive.filter((r) => /^town\d/.test(r.id)).length === records.length, 'the live document carries every generated road')
check(roadsSaved.every((r) => !/^town\d/.test(r.id)) && roadsSaved.length === roadsLive.length - records.length, 'a save drops exactly the generated roads')
let threw = false
try { layers.addGenerated([{ id: 'd99', pts: [[0, 0, 0, 1]] }]) } catch { threw = true }
check(threw, 'addGenerated refuses a non-generated id')

// No pad: each building stands on the live ground, its floor above every point under its walls and its plinth below.
let buried = 0
let floating = 0
for (const t of towns) for (const b of t.buildings) {
  const c = Math.cos(b.yaw)
  const sn = Math.sin(b.yaw)
  for (const m of b.plan.masses) for (let u = -0.5; u <= 0.5; u += 0.25) for (let v = -0.5; v <= 0.5; v += 0.25) {
    const lx = m.cx + u * m.w
    const lz = m.cz + v * m.d
    const h = field.heightAt(b.x + lx * c + lz * sn, b.z - lx * sn + lz * c)
    if (h > b.y + b.plan.floorY + 0.05) buried++
    if (h < b.y + b.plan.plinthBottom) floating++
  }
}
check(buried === 0, 'no building\'s floor sinks under the ground', `${buried} points`)
check(floating === 0, 'no building\'s plinth floats over the ground', `${floating} points`)

// No dirt behind a building away from the paths.
const paintedReach = (x, z) => {
  let d = Infinity
  for (const r of records) for (let i = 1; i < r.pts.length; i++) {
    const [ax, , az, aw] = r.pts[i - 1]
    const [bx, , bz] = r.pts[i]
    const ex = bx - ax
    const ez = bz - az
    const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)))
    d = Math.min(d, Math.hypot(x - ax - ex * u, z - az - ez * u) - aw / 2)
  }
  return d
}
let backs = 0
let dirtyBacks = 0
for (const t of towns) for (const b of t.buildings) {
  const x = b.box.x - b.box.s * (b.box.hz + 0.4)
  const z = b.box.z - b.box.c * (b.box.hz + 0.4)
  if (paintedReach(x, z) < 2) continue
  backs++
  if (layers.dirtAt(x, z) > 0) dirtyBacks++
}
check(backs > 50 && dirtyBacks === 0, 'no dirt behind a building away from the paths', `${dirtyBacks} of ${backs} painted`)

// Door paths wind: the longer ones stray from their chord.
let longPaths = 0
let straight = 0
for (const t of towns) for (const { pts } of t.paths) {
  const [ax, , az] = pts[0]
  const [bx, , bz] = pts.at(-1)
  const len = Math.hypot(bx - ax, bz - az)
  if (len < 10) continue
  longPaths++
  const stray = Math.max(...pts.map(([x, , z]) => Math.abs((x - ax) * (bz - az) - (z - az) * (bx - ax)) / len))
  if (stray < 0.15) straight++
}
check(longPaths > 50 && straight < longPaths * 0.1, 'door paths over 10 m wind off their chord', `${straight} of ${longPaths} straight`)

// --- rendering ---
const scene = new THREE.Scene()
const layer = new Towns(scene, { towns, textures: buildTextureArray(), patch: (m) => m })
const massCount = towns.reduce((s, t) => s + t.buildings.reduce((u, b) => u + b.plan.masses.length, 0), 0)
check(layer.stats.instances === massCount, 'a far instance for every building mass', `${layer.stats.instances}`)
const farTris = layer.far.geometry.index ? layer.far.geometry.index.count / 3 : layer.far.geometry.attributes.position.count / 3
check(farTris === 14, 'the far box is 14 triangles', `${farTris}`)

const t = towns[0]
layer.update(t.x, t.z)
for (let i = 0; i < 400; i++) layer.update(t.x, t.z)
const near = scene.children.filter((o) => o.isMesh && !o.isInstancedMesh)
check(near.length === 1, 'standing in a town draws it as one merged mesh', `${near.length} meshes`)
const site = layer.sites.find((s) => s.town === t)
check(site.tier === 2 && !site.farShown, 'a town drawn near hides its far boxes', `tier ${site.tier}`)
const built = layer.sites.reduce((n, s) => n + (s.geo[1] !== null) + (s.geo[2] !== null), 0)
check(layer.stats.merges === built && near[0].geometry.userData.tris === site.geo[2].userData.tris, 'each town tier is merged once and drawn whole', `${layer.stats.merges} merges for ${built} tiers`)
const farMasses = layer.sites.filter((s) => s.farShown).reduce((n, s) => n + s.masses.length, 0)
const farOut = layer.sites.filter((s) => s.farShown && Math.hypot(s.town.x - t.x, s.town.z - t.z) - s.town.radius > TOWN_BANDS.far + TOWN_BANDS.hysteresis).length
check(layer.far.count === farMasses && farOut === 0 && farMasses < massCount / 2, `the far boxes are packed and stop at ${TOWN_BANDS.far} m`, `${layer.far.count} of ${massCount} drawn`)

const b0 = t.buildings[0]
const top = layer.blockTopAt(b0.x, b0.z)
check(top > b0.y + 2, 'a building blocks her walk up to its roof', `top ${top.toFixed(1)} over its base ${b0.y.toFixed(1)}`)
check(layer.blockTopAt(t.x, t.z) === -Infinity, 'the clearing does not block')
check(layer.occupiesAt(b0.x, b0.z, 0), 'trees keep off the buildings')
const behind = t.buildings.map((b) => [b.box.x - b.box.s * (b.box.hz + 2), b.box.z - b.box.c * (b.box.hz + 2)])
const openBehind = behind.filter(([x, z]) => !layer.occupiesAt(x, z, 0)).length
check(!layer.occupiesAt(t.x, t.z, 0) && openBehind > 0, 'trees may stand 2 m behind a building and in town, leaving the clearing to the roads', `${openBehind} of ${behind.length} backs open`)
check(layer.nearBuildingAt(b0.x + 15, b0.z, 20) && !layer.nearBuildingAt(t.x + t.radius + 60, t.z, 20), 'wildlife keeps 20 m off the buildings and no further out')

// --- the hearth, grown to a human seat ---
const texArray = buildTextureArray()
const S = 1.3
const hearth = new Hearth(scene, field, { bank: buildRockBank(), at: t, textures: texArray, seed: 5, patch: (m) => m, scale: S })
const st = hearth.stools[0]
const sx = hearth.x + st.x * S, sz = hearth.z + st.z * S
check(Math.abs(hearth.blockTopAt(sx, sz) - field.heightAt(sx, sz) - SEAT_M * S) < 0.1, 'a grown stool\'s top stands SEAT_M times the scale over its ground', `${(hearth.blockTopAt(sx, sz) - field.heightAt(sx, sz)).toFixed(2)} m`)
check(hearth.occupiesAt(hearth.x + 1.7 * S, hearth.z, 0) && !hearth.occupiesAt(hearth.x + TOWN.clearing.r, hearth.z, 0), 'the grown hearth fills the clearing\'s middle, not its edge')
hearth.dispose()
const kit = hearthKit(buildRockBank(), 7, () => 0, texArray, (m) => m, { decimate: false })
const [k0, k1] = [t, towns[1]].map((at) => new Hearth(scene, field, { at, textures: texArray, patch: (m) => m, scale: S, kit }))
const kx = k0.x + k0.stools[0].x * S, kz = k0.z + k0.stools[0].z * S
const kSeat = k0.blockTopAt(kx, kz) - field.heightAt(kx, kz)
check(k0.meshes[0].geometry === k1.meshes[0].geometry && Math.abs(kSeat - SEAT_M * S) < 0.1, 'every town\'s hearth draws one kit built level, its stools a seat high over the clearing', `${kSeat.toFixed(2)} m`)
k0.update(k0.x, k0.y + 1.6, k0.z + 100, 0)
const shownNear = k0.group.visible && k0.flames.group.visible
k0.update(k0.x, k0.y + 1.6, k0.z + 400, 0)
check(shownNear && !k0.group.visible && !k0.flames.group.visible, 'a hearth and its flame are drawn at 100 m and not at 400 m')
let kitFreed = 0
for (const r of [...kit.tiers, kit.material]) r.addEventListener('dispose', () => kitFreed++)
k0.dispose()
k1.dispose()
check(kitFreed === 0, 'a hearth leaves the shared kit to its owner', `${kitFreed} freed`)
kit.dispose()

// --- the townsfolk's ways and day ---
const unreached = []
for (const town of towns) {
  const g = townGraph(town)
  const seen = new Uint8Array(g.nodes.length)
  const stack = [g.ring[0]]
  seen[g.ring[0]] = 1
  while (stack.length) for (const j of g.adj[stack.pop()]) if (!seen[j]) { seen[j] = 1; stack.push(j) }
  if (!g.doors.every((d) => seen[d]) || g.doors.length !== town.buildings.length) unreached.push(town.id)
}
check(unreached.length === 0, 'every door is reachable from the clearing', unreached.join(', '))
// Stand-in bodies with the farmer's numbers: gait per asset unit, a 1-unit body.
const durations = Object.fromEntries(CLIPS.map((c) => [c, c === 'sit' ? 4 : 2]))
const bodies = TOWNSFOLK.bodies.map(() => ({ heightM: 1.7, height: 1, gait: { walk: 0.632 }, wheelbase: 0.474, sitY: SEAT_M * S / 1.7, durations }))
const seats = Array.from({ length: 6 }, (_, k) => {
  const x = t.x + Math.cos(k) * 1.7 * S, z = t.z + Math.sin(k) * 1.7 * S
  return { x, z, top: field.heightAt(x, z) + SEAT_M * S, r: 0.4, lookX: t.x, lookZ: t.z }
})
const heightAt = (x, z) => field.heightAt(x, z)
const life = (i = 0) => new TownLife(t, { index: i, seed: SEED, bodies, seats, heightAt })
const a = life()
const T0 = 10000 * 600 + 5
const seen = { walk: 0, sit: 0, talk: 0, stand: 0 }
let offWay = 0
const g0 = a.graph
const wayDist = (x, z) => {
  let best = Infinity
  for (let i = 0; i < g0.nodes.length; i++) for (const j of g0.adj[i]) {
    const p = g0.nodes[i], q = g0.nodes[j], ux = q.x - p.x, uz = q.z - p.z, L = ux * ux + uz * uz
    const u = L > 0 ? Math.max(0, Math.min(1, ((x - p.x) * ux + (z - p.z) * uz) / L)) : 0
    best = Math.min(best, Math.hypot(x - p.x - u * ux, z - p.z - u * uz))
  }
  return best
}
for (let s = 0; s < 400; s += 2) {
  a.advance(T0 + s)
  for (const c of a.all) {
    if (c.state in seen) seen[c.state]++
    if (c.state === 'walk' && c.then !== 'sit' && c.job === null && c.then !== 'errand' && !(c.wp === 0 && c.route[0].node === c.at) && wayDist(c.x, c.z) > TOWNSFOLK.lane + 0.3) offWay++
  }
}
check(seen.walk > 0 && seen.sit > 0 && seen.talk > 0 && seen.stand > 0, 'townsfolk walk, stand, sit at the fire and stop to talk', JSON.stringify(seen))
check(offWay === 0, 'a walker keeps to its lane on the town\'s ways', `${offWay} samples off`)
const b = life()
b.advance(T0 + 398)
check(a.all.every((c, i) => c.x === b.all[i].x && c.z === b.all[i].z && c.state === b.all[i].state), 'a town woken late replays to the same day as one watched throughout')
const late = life()
let frames = 0
while (!late.caught) { late.advance(T0 + 398, TOWNSFOLK.replay); frames++ }
check(frames > 1 && a.all.every((c, i) => c.x === late.all[i].x && c.z === late.all[i].z && c.state === late.all[i].state), 'a town woken late catches up over several frames to the same day', `${frames} frames`)
check(new Set(a.all.map((c) => c.seat).filter(Boolean)).size === a.all.filter((c) => c.seat).length, 'no two townsfolk hold one stool')

// --- the striders at the rails, and the travellers leaving and arriving ---
check(towns.every((town) => town.posts.length >= 3 && town.posts.every((p) => p.tethers.length > 0)), 'every town has at least 3 hitching posts, each with a tether')
const roadPlan = planRoads({ towns, ground, surface, layers, seed: SEED })
const journeys = new Journeys(towns, roadPlan, { seed: SEED, bodies: TOWNSFOLK.bodies.length })
const strider = { walk: 1.06, fidget: 2 }
const tally = { departs: 0, late: 0, worstLate: 0, walkouts: 0, arrivals: 0, stuck: [], leads: 0, fidgets: 0, maxTied: 0, errors: [] }
for (let ti = 0; ti < towns.length; ti++) {
  const town = towns[ti]
  const tSeats = Array.from({ length: 6 }, (_, k) => {
    const x = town.x + Math.cos(k) * 1.7 * S, z = town.z + Math.sin(k) * 1.7 * S
    return { x, z, top: field.heightAt(x, z) + SEAT_M * S, r: 0.4, lookX: town.x, lookZ: town.z }
  })
  const L = new TownLife(town, { index: ti, seed: SEED, bodies, seats: tSeats, heightAt, journeys, strider })
  const jobs = new Map()
  try {
    for (let s = T0; s < T0 + 2 * 600; s += 1) {
      const turn = L.turnTick
      L.advance(s)
      if (L.tick === turn - 1) for (const c of L.all) if (c.job !== null) tally.stuck.push(`${town.id} ${c.job.kind}:${c.job.step}`)
      for (const c of L.all) {
        if (c.job !== null) {
          if (!jobs.has(c)) { jobs.set(c, c.job); if (c.job.kind === 'lead') tally.leads++ }
          continue
        }
        const job = jobs.get(c)
        if (!job) continue
        jobs.delete(c)
        if (job.kind === 'depart' || job.kind === 'walkout') {
          const over = L.tick / 20 - job.j.t0
          tally[job.kind === 'depart' ? 'departs' : 'walkouts']++
          // Sampled each second, so up to a second over is on time.
          if (over > 1.5) { tally.late++; tally.worstLate = Math.max(tally.worstLate, over) }
        } else if (job.kind === 'ridein' || job.kind === 'walkin') tally.arrivals++
      }
      tally.maxTied = Math.max(tally.maxTied, L.stats.mounts.tied / L.tethers.length)
      tally.fidgets += L.mounts.filter((m) => m.active && m.clip === 'fidget').length
    }
  } catch (e) { tally.errors.push(`${town.id}: ${e.message}`) }
}
check(tally.errors.length === 0, 'every town runs two chapters of striders and travellers without an invariant breaking', tally.errors.slice(0, 2).join(' | '))
check(tally.departs > 0 && tally.walkouts > 0 && tally.arrivals > 0 && tally.leads > 0, 'townsfolk ride and walk out, arrive, and lead striders between the rails', JSON.stringify({ departs: tally.departs, walkouts: tally.walkouts, arrivals: tally.arrivals, leads: tally.leads }))
check(tally.late === 0, 'every traveller leaving reaches the port end by its journey\'s t0', `${tally.late} late, worst ${tally.worstLate.toFixed(1)} s`)
check(tally.stuck.length === 0, 'every job is done by the chapter\'s turn', tally.stuck.slice(0, 4).join(', '))
const withJ = () => new TownLife(t, { index: 0, seed: SEED, bodies, seats, heightAt, journeys, strider })
const watched = withJ(), jumped = withJ()
for (let s = 0; s <= 590; s += 2) watched.advance(T0 + s)
jumped.advance(T0 + 590)
const same = (p, q) => p.x === q.x && p.z === q.z && p.state === q.state
check(watched.all.every((c, i) => same(c, jumped.all[i])) && watched.mounts.every((m, i) => same(m, jumped.mounts[i])), 'a town with striders woken late replays to the same day as one watched throughout', JSON.stringify(watched.stats.mounts))
check(tally.fidgets > 0 && tally.maxTied <= 1, 'tied striders fidget, never more than a tether each', `max ${(tally.maxTied * 100).toFixed(0)}% of tethers`)

if (failures) {
  console.error(`\n${failures} town check(s) failed`)
  process.exit(1)
}
console.log('\nall town checks passed')
