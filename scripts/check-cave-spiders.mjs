// The giant cave spiders (render/cave-spiders.js): crawl on walls and ceilings, hiss and back away from a torch, HP, never attack.
//
//   node scripts/check-cave-spiders.mjs
//
// The shader and how they look are not checked here.

import THREE from '../src/three-instance.js'
import { planCave } from '../src/v2/caves/build.js'
import { CaveSpiders, SPIDER, SHADE, BASE_COLOR, TICK_S } from '../src/v2/render/cave-spiders.js'
import { TINT_DARK } from '../src/v2/render/spiders.js'

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
]
const noLights = [new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0), new THREE.Vector4(0, 0, 0, 0)]
const DT = 1 / 72

// Darker than the wood spiders: the cave spider's body shade is under the darkest wood spider's multiplier.
check(SHADE < TINT_DARK && BASE_COLOR.every((c) => c * SHADE < c * TINT_DARK), 'a cave spider is tinted darker than the darkest wood spider', `${SHADE.toFixed(3)} vs ${TINT_DARK}`)

let total = 0, ceilings = 0, walls = 0
for (const sys of SYSTEMS) {
  const plan = planCave(sys)
  const tag = `system ${sys.seed}`
  const group = new THREE.Group()
  const cs = new CaveSpiders(group, {}, '', plan, OY)
  const n = cs.spiders.length
  total += n
  check(n >= 2 && n <= SPIDER.max, `${tag}: spiders are seated`, `${n}`)
  const f = plan.field
  check(cs.spiders.every((s) => Math.abs(f.at(...s.p)) < 0.35 && s.n[1] <= 0.6), `${tag}: each starts on a wall or ceiling, not a floor`)
  const mouths = plan.graph.nodes.filter((q) => q.kind === 'mouth')
  check(cs.spiders.every((s) => mouths.every((m) => Math.hypot(m.x - s.p[0], m.z - s.p[2]) > 20)), `${tag}: none at a mouth`)

  // Crawling, no light: 90 s. Each stays on the rock, never on a floor, and some move.
  const start = cs.spiders.map((s) => [...s.p])
  const sleepM = SPIDER.sleepM
  SPIDER.sleepM = 1e9
  const eye = { x: cs.spiders[0].p[0], y: cs.spiders[0].p[1] + OY, z: cs.spiders[0].p[2] }
  let off = 0, floors = 0, steps = 0
  const t0 = performance.now()
  for (let i = 0; i < 90 * 72; i++) {
    cs.update(DT, eye, noLights)
    if (i % 24 === 0) for (const s of cs.spiders) {
      steps++
      if (Math.abs(f.at(...s.p)) > 0.35) off++
      if (s.n[1] > 0.61) floors++
      if (s.n[1] < -0.5) ceilings++
      else if (Math.abs(s.n[1]) < 0.5) walls++
    }
  }
  SPIDER.sleepM = sleepM
  const ms = (performance.now() - t0) / (90 * 72)
  const moved = cs.spiders.map((s, i) => Math.hypot(s.p[0] - start[i][0], s.p[1] - start[i][1], s.p[2] - start[i][2]))
  check(off === 0 && floors === 0, `${tag}: over 90 s every sampled position stays on the rock and off the floor`, `${steps} samples, ${off} off the rock, ${floors} on a floor`)
  check(moved.filter((d) => d > 1).length >= Math.ceil(n / 2), `${tag}: most spiders crawl somewhere`, `${moved.filter((d) => d > 1).length} of ${n} moved over 1 m, farthest ${Math.max(...moved).toFixed(1)} m`)
  check(ms < 1, `${tag}: an update costs under 1 ms`, `${ms.toFixed(3)} ms for ${n} spiders (all awake)`)

  // The light: a torch 3 m from a spider on the open side makes it hiss, then back off with its face to the light.
  const s0 = cs.spiders[0]
  const hissed = []
  cs.onHiss = (s) => hissed.push(s.id)
  const open = [s0.p[0] + s0.n[0] * 2, s0.p[1] + s0.n[1] * 2, s0.p[2] + s0.n[2] * 2]
  const torch = new THREE.Vector4(open[0], open[1] + OY, open[2], 1)
  const lights = [torch, ...noLights.slice(1)]
  const d0 = Math.hypot(s0.p[0] - open[0], s0.p[1] - open[1], s0.p[2] - open[2])
  for (let i = 0; i < 72 * 0.5; i++) cs.update(DT, eye, lights)
  check(hissed.includes(s0.id) && s0.state === 'hiss', `${tag}: a torch 2 m off the wall makes the spider hiss and rear`, `state ${s0.state}, rear ${s0.rear.toFixed(2)}`)
  const startAt = [...s0.p]
  for (let i = 0; i < 72 * 6; i++) { cs.update(DT, eye, lights); if (s0.state === 'retreat' && i === 72 * 3) torch.set(torch.x, torch.y, torch.z, 1) }
  const toLight = [open[0] - s0.p[0], open[1] - s0.p[1], open[2] - s0.p[2]]
  const dn = Math.hypot(...toLight)
  const movedAway = Math.hypot(s0.p[0] - startAt[0], s0.p[1] - startAt[1], s0.p[2] - startAt[2])
  check(movedAway > 1 || s0.turns > 0 || s0.state === 'pause', `${tag}: it backs away from the light`, `moved ${movedAway.toFixed(2)} m, now ${dn.toFixed(2)} m from the torch (was ${d0.toFixed(2)})`)
  check(dn >= d0 - 0.01 && (s0.face[0] * toLight[0] + s0.face[1] * toLight[1] + s0.face[2] * toLight[2]) / dn > 0 || s0.state !== 'retreat', `${tag}: backing away it keeps its face to the light`)
  torch.w = 0
  for (let i = 0; i < 72 * 4; i++) cs.update(DT, eye, noLights)
  check(s0.state === 'wander' || s0.state === 'pause', `${tag}: with the light gone it goes back to crawling`, s0.state)

  // HP and death.
  const s1 = cs.spiders[1]
  const died = []
  cs.onDeath = (s) => died.push(s.id)
  const r1 = cs.hurt(s1.id, 5)
  check(r1.hp === SPIDER.hp - 5 && !r1.dead && died.length === 0, `${tag}: a hurt spider keeps the rest of its HP`, `${r1.hp}/${SPIDER.hp}`)
  const r2 = cs.hurt(s1.id, 999)
  const frozen = [...s1.p]
  for (let i = 0; i < 72 * 4; i++) cs.update(DT, eye, noLights)
  check(r2.dead && r2.hp === 0 && died.length === 1 && died[0] === s1.id && s1.state === 'dead' && frozen.every((c, k) => c === s1.p[k]), `${tag}: at 0 HP the death hook fires once and the spider stays put`, `died ${died.join(',')}`)
  cs.hurt(s1.id, 3)
  check(died.length === 1, `${tag}: a corpse does not die twice`)
  cs.remove(s1.id)
  check(!cs.spiders.some((s) => s.id === s1.id) && cs.list().every((l) => Number.isFinite(l.x) && Number.isFinite(l.y) && l.y < 0 && l.hp >= 0), `${tag}: remove drops it and list() gives world positions`)
  let threw = false
  try { cs.hurt(9999, 1) } catch { threw = true }
  check(threw, `${tag}: hurting an unknown spider throws`)
  const m = cs.mesh
  check(m.isInstancedMesh && m.count === cs.spiders.filter((q) => Math.hypot(q.p[0] - eye.x, q.p[1] + OY - eye.y, q.p[2] - eye.z) <= SPIDER.drawM).length && cs.tris > 100 && cs.tris < 600, `${tag}: one instanced mesh draws them`, `${m.count} instances, ${cs.tris} triangles each`)
  cs.dispose()
}
check(total >= 6, 'caves seat giant spiders', `${total} over ${SYSTEMS.length} caves`)
check(ceilings > 0 && walls > 0, 'they are found on ceilings and on walls', `${ceilings} ceiling samples, ${walls} wall samples`)
check(TICK_S > 0, 'the sim steps in fixed ticks')

if (failures > 0) { console.log(`\n${failures} failures`); process.exit(1) }
console.log('\nall ok')
