// The labyrinth clock contract (layers/labyrinths.js labyrinthAt, entranceOf, timeLimit; design/41-palisade-labyrinths.md), on the shipped world.
//
//   node scripts/check-labyrinth-clock.mjs
//
// Over every labyrinth: the limit is positive and finite and prices the route at 75% of her walk plus the ladders at climb speed;
// bigger mazes and tower mazes get longer limits; entranceOf stands just outside the gate on the ground, facing in; labyrinthAt knows
// the inside and not the entrance; and the route's ground leg is walked through the real walker up to the first ladder's foot.

import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import { WaterSurfaces } from '../src/v2/render/water-surfaces.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_SHIPPED } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { BiomeField } from '../src/v2/layers/biome.js'
import { CLOCK, entranceOf, labyrinthAt, timeLimit } from '../src/v2/layers/labyrinths.js'
import { SCAFFOLD, ladderSpots } from '../src/v2/layers/scaffold.js'
import { Palisades } from '../src/v2/render/palisades.js'
import { LOCOMOTION } from '../src/player.js'
import { CLIMB } from '../src/v2/climb.js'
import { WalkSurface } from '../src/v2/walk.js'
import { SEED, WORLD_HALF } from '../src/v2/config.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const mean = (a) => a.reduce((t, v) => t + v, 0) / a.length

const hm = await Heightmap.read({ path: new URL('../public/world/height.png', import.meta.url), metaPath: new URL('../public/world/height.json', import.meta.url) })
const field = new V2Height({ heightmap: hm, layers: new Layers(), seed: SEED, relief: RELIEF_SHIPPED })
const layers = Layers.deserialize(JSON.parse(readFileSync(new URL('../public/world/layers.json', import.meta.url), 'utf8')))
field.setLayers(layers)
new WaterSurfaces({ water: { material: new THREE.ShaderMaterial(), group: new THREE.Group() }, layers, field }).rebuild()
const labyrinths = new BiomeField({ seed: SEED, ground: field }).labyrinths
const sites = labyrinths.sitesIn(-WORLD_HALF, -WORLD_HALF, WORLD_HALF, WORLD_HALF).slice()

const palisades = Object.assign(Object.create(Palisades.prototype), { labyrinths, field, _ladders: new WeakMap() })
const walk = new WalkSurface(field, { columnAt: () => 0, blockTopAt: () => -Infinity }, { trunkAt: () => false })
walk.addStone(palisades)

check(CLOCK.walk === LOCOMOTION.maxSpeed * 0.75, 'CLOCK.walk is 75% of her walking speed', `${CLOCK.walk} vs ${LOCOMOTION.maxSpeed}`)
check(CLOCK.climb === CLIMB.speed, 'CLOCK.climb is the climb speed', `${CLOCK.climb} vs ${CLIMB.speed}`)
check(sites.length > 20, 'the world has labyrinths', `${sites.length}`)

const rows = []
const bad = { limit: [], price: [], entrance: [], inside: [], walk: [], ladders: [] }
for (const s of sites) {
  const t = timeLimit(s)
  const r = labyrinths.routeOf(s)
  const m = labyrinths.mazeOf(s)
  rows.push({ s, t, reach: s.reach, rings: s.rings, tower: s.tower, up: r.up })
  if (!(Number.isFinite(t) && t > 0)) bad.limit.push(`${s.cx},${s.cz}: ${t}`)
  if (Math.abs(t - (r.walk / (0.75 * LOCOMOTION.maxSpeed) + r.up / CLIMB.speed)) > 1e-9) bad.price.push(`${s.cx},${s.cz}`)

  // entranceOf: on the ground, ~1 m outside the gate, forward (cos h, -sin h) pointing at the mouth, outside the footprint; a step in is inside.
  const e = entranceOf(s)
  const fx = Math.cos(e.heading), fz = -Math.sin(e.heading)
  const [[ax, az], [bx, bz]] = m.torches
  const toGate = [(ax + bx) / 2 - e.x, (az + bz) / 2 - e.z]
  const d = Math.hypot(toGate[0], toGate[1])
  const along = (fx * toGate[0] + fz * toGate[1]) / d
  const toMid = Math.hypot(s.cx - e.x, s.cz - e.z)
  const inward = (fx * (s.cx - e.x) + fz * (s.cz - e.z)) / toMid
  if (Math.abs(e.y - field.heightAt(e.x, e.z)) > 1e-9) bad.entrance.push(`${s.cx},${s.cz}: y ${e.y}`)
  if (along < 0.999 || Math.abs(d - 1) > 0.01 || inward < 0.5) bad.entrance.push(`${s.cx},${s.cz}: facing the gate ${along.toFixed(3)}, ${d.toFixed(2)} m from the torch line, toward the middle ${inward.toFixed(2)}`)
  if (labyrinthAt(e.x, e.z) !== null) bad.entrance.push(`${s.cx},${s.cz}: the entrance is inside the footprint`)
  const inX = e.x + fx * (d + 1.5), inZ = e.z + fz * (d + 1.5)
  if (labyrinthAt(inX, inZ) !== s) bad.inside.push(`${s.cx},${s.cz}`)

  // The route's ground leg through the walker, to the first ladder's foot (a plain maze: to the last point before the plinth).
  let end = r.points.length - 1
  if (m.scaffold !== null) {
    if (r.ladders.length < 1) { bad.ladders.push(`${s.cx},${s.cz}: a tower with no ladder`); continue }
    const { foot } = ladderSpots(m.scaffold, r.ladders[0])
    end = r.points.findIndex((p) => p[0] === foot[0] && p[1] === foot[1]) + 1
    if (end === 0) bad.ladders.push(`${s.cx},${s.cz}: the first ladder's foot is not on the route`)
  }
  let f = field.heightAt(r.points[0][0], r.points[0][1])
  let stuck = null
  for (let q = 1; q < end && stuck === null; q++) {
    const [ax, az] = r.points[q - 1], [bx, bz] = r.points[q]
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / 0.1))
    for (let k = 1; k <= n; k++) {
      const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n
      const h = walk.heightAt(x, z, f)
      if (!walk.fits(x, z, h, null)) { stuck = `(${x.toFixed(2)}, ${z.toFixed(2)}) on leg ${q}`; break }
      f = h
    }
  }
  if (stuck !== null) bad.walk.push(`${s.cx},${s.cz}: stopped at ${stuck}`)
}

for (const [k, v] of Object.entries(bad)) check(v.length === 0, `no site fails: ${k}`, `${v.length} of ${sites.length}${v.length ? ` -- ${v.slice(0, 5).join('; ')}` : ''}`)

const plain = rows.filter((r) => !r.tower), tower = rows.filter((r) => r.tower)
check(plain.length > 5 && tower.length > 5, 'both plain and tower labyrinths exist', `${plain.length} plain, ${tower.length} tower`)
const minClimb = (5 * SCAFFOLD.rise) / CLIMB.speed
check(tower.every((r) => r.t >= minClimb && r.up > 0), 'a tower limit carries its ladders', `min ${Math.min(...tower.map((r) => r.t)).toFixed(0)} s vs ${minClimb.toFixed(0)} s`)
check(plain.every((r) => r.up === 0), 'a plain maze climbs nothing')

// Bigger means longer: within each kind the largest-rings third beats the smallest-rings third.
for (const [name, set] of [['plain', plain], ['tower', tower]]) {
  const sorted = set.slice().sort((a, b) => a.rings - b.rings), k = Math.floor(sorted.length / 3)
  const small = mean(sorted.slice(0, k).map((r) => r.t)), big = mean(sorted.slice(-k).map((r) => r.t))
  check(big > small, `${name}: bigger mazes get longer limits`, `small third ${small.toFixed(0)} s, big third ${big.toFixed(0)} s`)
}
// Same rings, with and without a tower.
const ringsBoth = [...new Set(tower.map((r) => r.rings))].filter((n) => plain.some((r) => r.rings === n))
const gaps = ringsBoth.map((n) => mean(tower.filter((r) => r.rings === n).map((r) => r.t)) - mean(plain.filter((r) => r.rings === n).map((r) => r.t)))
check(gaps.length > 0 && mean(gaps) > 0, 'at equal rings a tower gets longer limits', `${gaps.length} sizes, mean gap ${mean(gaps).toFixed(0)} s`)
console.log(`  limits: ${Math.min(...rows.map((r) => r.t)).toFixed(0)}-${Math.max(...rows.map((r) => r.t)).toFixed(0)} s over ${rows.length} labyrinths`)

console.log(failures === 0 ? 'all labyrinth clock checks passed' : `${failures} labyrinth clock check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
