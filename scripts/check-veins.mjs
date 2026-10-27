// Ore veins, gems and the routes to them (caves/veins.js, render/veins.js) over several planned caves.
//
//   node scripts/check-veins.mjs
//
// What this can NOT check is how they look or that the shader compiles; shoot a screenshot for that.

import THREE from '../src/three-instance.js'
import { planCave } from '../src/v2/caves/build.js'
import { columnAt } from '../src/v2/caves/props.js'
import { buildNet, shortest, nearestVertex } from '../src/v2/caves/route.js'
import { veinsOf, routeFrom, veinList, VEINS, GEMS } from '../src/v2/caves/veins.js'
import { VeinLayer } from '../src/v2/render/veins.js'

let failures = 0
function check(ok, title, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
}

const OY = -2000
const SYSTEMS = [
  { seed: 11, entries: [{ x: 0, z: 0, dx: 1, dz: 0 }] },
  { seed: 12, entries: [{ x: 0, z: 0, dx: 0, dz: 1 }, { x: 90, z: 140, dx: -0.6, dz: -0.8 }] },
  { seed: 13, entries: [{ x: -60, z: 0, dx: 1, dz: 0 }, { x: 60, z: 10, dx: -1, dz: 0 }, { x: 0, z: 120, dx: 0, dz: -1 }] },
  { seed: 16, entries: [{ x: 0, z: 0, dx: 0, dz: -1 }, { x: 100, z: 0, dx: 0, dz: -1 }, { x: 200, z: 0, dx: 0, dz: -1 }, { x: 100, z: -180, dx: 0, dz: 1 }] },
]

const inEllipse = (n, v) => { const dx = v.x - n.x, dz = v.z - n.z, c = Math.cos(n.rot), s = Math.sin(n.rot); return Math.hypot((dx * c + dz * s) / n.rx, (dz * c - dx * s) / n.rz) }
let all = 0, great = 0
const byKind = {}
let sparse = 0, dense = 0, sparseNodes = 0, denseNodes = 0
for (const sys of SYSTEMS) {
  const plan = planCave(sys)
  const tag = `system ${sys.seed}`
  const list = veinList(plan)
  const system = { plan, oy: OY, mined: new Set() }
  const world = veinsOf(system)
  all += list.length
  list.forEach((v) => { byKind[v.kind] = (byKind[v.kind] ?? 0) + 1 })
  check(list.length >= 40, `${tag}: the walls carry veins and gems`, `${list.length}`)
  check(new Set(world.map((v) => v.id)).size === world.length && world.every((v) => /^\d+:\d+$/.test(v.id)), `${tag}: every id is unique`)
  const keys = ['id', 'kind', 'x', 'y', 'z', 'nx', 'ny', 'nz']
  check(world.every((v) => keys.every((k) => k in v && (k === 'id' || k === 'kind' || Number.isFinite(v[k])))) && world.every((v, i) => v.y === list[i].y + OY), `${tag}: veinsOf gives {id, kind, x, y, z, nx, ny, nz} in world metres`)

  const f = plan.field
  const lift = list.map((v) => v.y - v.floor)
  check(lift.every((h) => h >= VEINS.height[0] && h <= VEINS.height[1]), `${tag}: each sits 0.5 to 2 m above the floor`, `${Math.min(...lift).toFixed(2)}..${Math.max(...lift).toFixed(2)} m`)
  check(list.every((v) => Math.abs(f.at(v.x, v.y, v.z)) < 0.35 && f.at(v.x + v.nx * 0.5, v.y + v.ny * 0.5, v.z + v.nz * 0.5) < 0), `${tag}: each is on the wall face with its normal into the air`)

  const net = buildNet(plan.graph)
  const mouths = plan.graph.nodes.filter((n) => n.kind === 'mouth')
  const costs = mouths.map((m) => shortest(net, net.nodeV[m.i]).cost)
  // The net's nearest vertex can sit a few metres off a vein, so the gate allows 15 m.
  const walked = (v) => Math.min(...costs.map((c) => c[nearestVertex(net, v.x, v.floor, v.z)]))
  const near = list.filter((v) => walked(v) < VEINS.minPath - 15)
  check(near.length === 0, `${tag}: none within 100 m of a mouth by path`, `${near.length} nearer; shortest ${Math.min(...list.map(walked)).toFixed(0)} m`)
  check(list.every((v) => v.path >= VEINS.minPath), `${tag}: the placer's own distance bound is 100 m or more`)

  const lode = list.filter((v) => v.kind === 'lodestone')
  check(lode.every((v) => v.path >= VEINS.lodePath), `${tag}: lodestone lies only in the deeper regions`, `${lode.length} lodestone, nearest ${lode.length ? Math.min(...lode.map((v) => v.path)).toFixed(0) : '-'} m`)
  const rime = list.filter((v) => v.kind === 'rimesilver')
  const gn = plan.graph.nodes.find((n) => n.great)
  if (gn === undefined) check(rime.length === 0, `${tag}: no great cavern, no rimesilver`)
  else {
    great++
    check(rime.length >= VEINS.rime[0] && rime.length <= VEINS.rime[1], `${tag}: 5 to 10 rimesilver veins`, `${rime.length}`)
    check(rime.every((v) => inEllipse(gn, v) < 1.35), `${tag}: rimesilver only in the great cavern`)
  }
  const gems = list.filter((v) => GEMS.includes(v.kind))
  const nooks = plan.graph.nooks
  check(gems.length > 0 && gems.every((v) => nooks.some((k) => k.pts.some((p) => Math.hypot(p.x - v.x, p.z - v.z) < 4))), `${tag}: every gem sits in a nook`, `${gems.length} gems`)

  // Commoner with depth: veins per node, nodes by their walking distance from the nearest mouth.
  for (const n of plan.graph.nodes) {
    if (n.kind === 'mouth') continue
    const d = Math.min(...costs.map((c) => c[net.nodeV[n.i]]))
    if (d >= 100 && d < 250) sparseNodes++
    if (d >= 400) denseNodes++
  }
  for (const v of list) { const w = walked(v); if (w >= 100 && w < 250) sparse++; if (w >= 400) dense++ }

  // Routes.
  const door = plan.doors[0]
  const from = { x: door.x, y: door.y + OY, z: door.z }
  const checkRoute = (r, start, title) => {
    const floorOk = r.every((p) => { const c = columnAt(f, p.x, p.z, p.y - OY + 0.6); return c !== null && Math.abs(c.floor - (p.y - OY)) < 0.12 })
    let gap = 0
    for (let i = 1; i < r.length; i++) gap = Math.max(gap, Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z))
    check(floorOk && gap <= 2.6 && r[0].x === start.x && r[0].z === start.z, title, `${r.length} points, longest horizontal step ${gap.toFixed(2)} m`)
  }
  const t1 = routeFrom(system, from, 'treasure')
  check(t1 !== null, `${tag}: a route to treasure exists from the door`)
  if (t1) {
    checkRoute(t1, from, `${tag}: the treasure route is walkable floor in horizontal steps of 2.5 m or less`)
    const end = t1[t1.length - 1]
    const nearest = world.filter((v) => Math.hypot(v.x - end.x, v.z - end.z) < 1.2)
    check(nearest.length > 0, `${tag}: the treasure route ends at a vein or gem`)
    // Hiding mined ones moves the destination to another.
    const gone = new Set(nearest.map((v) => v.id))
    const t2 = routeFrom({ ...system, mined: gone }, from, 'treasure')
    const e2 = t2 && t2[t2.length - 1]
    check(t2 !== null && Math.hypot(e2.x - end.x, e2.z - end.z) > 0.5, `${tag}: a mined vein is no longer led to`)
    check(routeFrom({ ...system, mined: new Set(list.map((v) => v.id)) }, from, 'treasure') === null, `${tag}: with everything mined there is no treasure route`)
  }
  const x1 = routeFrom(system, t1 ? t1[t1.length - 1] : from, 'exit')
  check(x1 !== null, `${tag}: a way out exists from the deepest vein reached`)
  if (x1) {
    checkRoute(x1, t1 ? t1[t1.length - 1] : from, `${tag}: the exit route is walkable floor in horizontal steps of 2.5 m or less`)
    const end = x1[x1.length - 1]
    check(mouths.some((m) => Math.hypot(m.x - end.x, m.z - end.z) < 3), `${tag}: the exit route ends at a mouth`)
  }
  let threw = false
  try { routeFrom({ plan, oy: OY }, from, 'exit') } catch { threw = true }
  check(threw, `${tag}: a system with no mined set throws`)

  // The draw.
  const group = new THREE.Group()
  const layer = new VeinLayer(group, {}, '', list)
  const full = layer.tris
  const hide = new Set(list.slice(0, 20).map((v) => v.id))
  layer.setMined(hide)
  check(full > 0 && layer.tris < full && group.children.length === 1 && group.children[0].geometry.getAttribute('position').count === layer.tris * 3, `${tag}: setMined redraws without the taken veins`, `${full} -> ${layer.tris} triangles`)
  const sh = layer.mesh.geometry.getAttribute('shine')
  let gemTris = 0
  for (let i = 0; i < sh.count; i++) if (sh.getX(i) === 1) gemTris++
  layer.setMined(new Set())
  const sh2 = layer.mesh.geometry.getAttribute('shine')
  let g2 = 0
  for (let i = 0; i < sh2.count; i++) if (sh2.getX(i) === 1) g2++
  check(g2 / 3 > 0 && g2 < sh2.count, `${tag}: gems carry the glint flag and ore does not`, `${g2 / 3} gem triangles of ${layer.tris}`)
  console.log(`       ${tag}: ${list.length} veins, ${full} triangles, 1 draw call`)
  layer.dispose()
}

console.log(`\nall systems ${all} veins; kinds ${JSON.stringify(byKind)}`)
const sp = sparse / sparseNodes, dn = dense / denseNodes
check(sparseNodes > 0 && denseNodes > 0 && dn > sp * 1.3, 'veins grow commoner with depth (per node, 400 m and deeper vs 100 to 250 m)', `${sp.toFixed(2)} vs ${dn.toFixed(2)} per node`)
check(great > 0, 'a cave with a great cavern was tested', `${great}`)

// The same seed places the same veins.
const again = SYSTEMS[0]
const a = veinsOf({ plan: planCave(again), oy: OY, mined: new Set() })
const b = veinsOf({ plan: planCave(again), oy: OY, mined: new Set() })
check(a.length > 0 && JSON.stringify(a) === JSON.stringify(b), 'the same seed places the same veins on every client', `${a.length}`)

if (failures > 0) { console.log(`\n${failures} failures`); process.exit(1) }
console.log('\nall ok')
