// Node-side gates for the town house interiors (src/v2/rooms/town-interior.js, design/38-town-interiors.md).
//
//   node scripts/check-town-interiors.mjs
//
// Every building kind over many seeds: a house rolls the same twice; its floor plan is the outside's at S times the size; the hall and the kitchen are on the ground floor and an upper floor has the most of the beds; every room has a light; there is a bed, a table with seats and a hearth to cook at; she lands on the floor inside the door, walks to every resident's place and up the stair, and never out through a wall; the residents' ways join the door to every place they go.

import { planBuilding, KINDS } from '../src/buildings/plan.js'
import { flatField } from '../src/v2/rooms/interior.js'
import { S, TownInteriorStone, navRoute, rollTownInterior, within } from '../src/v2/rooms/town-interior.js'
import { WalkSurface } from '../src/v2/walk.js'
import { LOCOMOTION } from '../src/player.js'

let failures = 0
const check = (ok, what) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

const SEEDS = 24
const houses = []
let threw = 0
for (const kind of Object.keys(KINDS)) {
  for (let s = 1; s <= SEEDS; s++) {
    const plan = planBuilding({ seed: s * 7919, kind })
    try { houses.push(rollTownInterior({ seed: 4242, index: s, plan })) } catch (e) { threw++; console.log(`  ${kind} ${s}: ${e.message}`) }
  }
}
console.log(`Town interiors: ${houses.length} houses over ${Object.keys(KINDS).length} kinds`)
check(threw === 0, `every building rolls (${threw} threw)`)
const every = (what, pred) => {
  const bad = houses.filter((r) => !pred(r))
  check(bad.length === 0, `${what}${bad.length ? ` -- not in ${bad.slice(0, 4).map((r) => `${r.kind}/${r.index}`).join(', ')}` : ''}`)
}

{
  const r = houses[5], again = rollTownInterior({ seed: 4242, index: r.index, plan: r.plan })
  check(JSON.stringify(again.items) === JSON.stringify(r.items), 'a house rolls the same room twice')
}
every(`the main room is the outside's main mass at ${S} times the size`, (r) => {
  const m = r.plan.masses.find((q) => q.role === 'main')
  return Math.abs(r.M.x1 - r.M.x0 - (S * m.w - 0.3)) < 0.01 && Math.abs(r.M.z1 - r.M.z0 - (S * m.d - 0.3)) < 0.01
})
every('the hall and any kitchen downstairs', (r) => r.rooms.filter((rm) => rm.kind === 'hall' || rm.kind === 'kitchen').every((rm) => rm.level === 0) && r.rooms.some((rm) => rm.kind === 'hall'))
every('a light in every room', (r) => r.rooms.every((rm) => r.candles.some((c) => c.room === rm.id)))
every('a bed to sleep in', (r) => r.spots.some((s) => s.kind === 'bed'))
every('a table with seats, and a hearth to cook at', (r) => r.items.some((it) => it.kind === 'table') && r.spots.some((s) => s.kind === 'seat') && r.spots.some((s) => s.kind === 'cook'))
{
  const two = houses.filter((r) => r.upper), beds = (r, l) => r.items.filter((it) => it.kind === 'bed' && r.rooms[it.room].level === l).length
  const up = two.reduce((n, r) => n + beds(r, 1), 0), down = two.reduce((n, r) => n + beds(r, 0), 0)
  check(two.length >= houses.length * 0.25, `a good share of houses have an upper floor (${two.length} of ${houses.length})`)
  check(up > 2 * down, `in a two-floor house the beds are mostly upstairs (${up} up, ${down} down)`)
}
{
  const work = houses.filter((r) => r.rooms.some((rm) => rm.kind === 'workroom'))
  check(work.length > 0 && work.every((r) => r.items.some((it) => ['parchment', 'scroll', 'bookcase', 'books', 'desk'].includes(it.kind))), `a workroom has its parchment, scrolls or books (${work.length} houses have one)`)
}
every('every upstairs gable room has a window', (r) => r.rooms.every((rm) => rm.level === 0 || (Math.abs(rm.rect.x0 - r.M.x0) > 0.01 && Math.abs(rm.rect.x1 - r.M.x1) > 0.01) || r.windows.some((w) => w.room === rm.id)))
{
  const rooms = houses.flatMap((r) => r.rooms.map((rm) => ({ r, rm })))
  const dark = rooms.filter(({ r, rm }) => !r.windows.some((w) => w.room === rm.id)).length
  const seatless = rooms.filter(({ r, rm }) => !r.items.some((it) => it.room === rm.id && ['chair', 'armchair', 'rocker', 'bench'].includes(it.kind))).length
  const area = rooms.reduce((n, { rm }) => n + (rm.rect.x1 - rm.rect.x0) * (rm.rect.z1 - rm.rect.z0), 0) / rooms.length
  check(dark <= rooms.length * 0.02, `hardly a room is windowless (${dark} of ${rooms.length})`)
  check(seatless <= rooms.length * 0.05, `nearly every room has a seat (${seatless} of ${rooms.length} have none)`)
  check(area < 35, `rooms are partitioned small (mean ${area.toFixed(1)} m²)`)
}

// Her walk over the stone, by player.js's step rules at world scale, flooded over a CELL grid from inside the door.
const CELL = 0.1
const MAX_TAN = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180), STRIDE = LOCOMOTION.stride
function flood(room) {
  const walk = new WalkSurface(flatField(0), new TownInteriorStone(room, 0, 0, 0), { trunkAt: () => null }, { scale: 1 })
  const b = room.bounds, X0 = b.x0 - 1, Z0 = b.z0 - 1, NX = Math.ceil((b.x1 - b.x0 + 2) / CELL), NZ = Math.ceil((b.z1 - b.z0 + 2) / CELL)
  const xOf = (i) => X0 + i * CELL, zOf = (k) => Z0 + k * CELL
  const seen = new Map(), queue = []
  const land = walk.heightAt(room.doorIn.x, room.doorIn.z, 0)
  const i0 = Math.round((room.doorIn.x - X0) / CELL), k0 = Math.round((room.doorIn.z - Z0) / CELL)
  seen.set(k0 * NX + i0, [land]); queue.push([i0, k0, land])
  let out = 0
  while (queue.length) {
    const [i, k, y] = queue.pop()
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, c = k + dk
      if (a < 0 || c < 0 || a >= NX || c >= NZ) continue
      const dist = CELL * Math.hypot(di, dk), x = xOf(a), z = zOf(c)
      const h = walk.heightAt(x, z, y)
      // player.js _walkable: only a climb is refused, and only when the stride baseline says wall too.
      if ((h - y) / dist > MAX_TAN) {
        const f = STRIDE / dist
        if ((walk.heightAt(xOf(i) + di * CELL * f, zOf(k) + dk * CELL * f, y) - y) / STRIDE > MAX_TAN) continue
      }
      if (!walk.fits(x, z, Math.max(y, h), null)) continue
      const got = seen.get(c * NX + a) || []
      if (got.some((g) => Math.abs(g - h) < 0.01)) continue
      got.push(h)
      seen.set(c * NX + a, got)
      queue.push([a, c, h])
      if (!room.inside.some((r) => within(r, x, z))) out++
    }
  }
  const near = Math.ceil(walk.radius / CELL) + 1
  const reached = (x, z, y) => {
    const i = Math.round((x - X0) / CELL), k = Math.round((z - Z0) / CELL)
    for (let dk = -near; dk <= near; dk++) for (let di = -near; di <= near; di++) if ((seen.get((k + dk) * NX + i + di) || []).some((g) => Math.abs(g - y) < 0.15)) return true
    return false
  }
  return { land, out, reached }
}

{
  const lost = [], walls = [], landed = [], upstairs = [], ways = []
  for (const r of houses) {
    const f = flood(r), tag = `${r.kind}/${r.index}`
    if (Math.abs(f.land) > 0.05) landed.push(`${tag} at ${f.land.toFixed(2)}`)
    if (f.out > 0) walls.push(`${tag} (${f.out} cells)`)
    for (const s of r.spots) if (!f.reached(s.standX, s.standZ, r.nav.floors[s.level])) lost.push(`${tag} ${s.kind} on ${s.level}`)
    if (r.upper && !f.reached(r.stair.top.x, r.stair.top.z, r.nav.floors[1])) upstairs.push(tag)
    for (const s of r.spots) if (!navRoute(r, { x: r.doorIn.x, z: r.doorIn.z, level: 0 }, { x: s.standX, z: s.standZ, level: s.level })) ways.push(`${tag} ${s.kind}`)
  }
  const show = (list) => (list.length ? ` -- ${list.slice(0, 4).join(', ')}` : '')
  check(landed.length === 0, `she lands on the floor inside the door${show(landed)}`)
  check(walls.length === 0, `she never walks out through a wall${show(walls)}`)
  check(lost.length === 0, `she walks to every resident's place${show(lost)}`)
  check(upstairs.length === 0, `she climbs the stair to the upper floor${show(upstairs)}`)
  check(ways.length === 0, `the residents' ways join the door to every place${show(ways)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
