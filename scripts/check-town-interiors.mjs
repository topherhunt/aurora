// Node-side gates for the town house interiors (src/v2/rooms/town-interior.js, design/38-town-interiors.md).
//
//   node scripts/check-town-interiors.mjs
//
// Every building kind over many seeds: a house rolls the same twice; its floor plan is the outside's at S times the size; the hall and the kitchen are on the ground floor and an upper floor has the most of the beds; every room has a light; there is a bed, a table with seats and a hearth to cook at; a shop has its counter, an inn a taproom of tables and its bedrooms upstairs; she lands on the floor inside the door, walks to every resident's place and up the stair, and never out through a wall; the residents' ways join the door to every place they go.

import { planBuilding, KINDS } from '../src/buildings/plan.js'
import { CELLAR, S, TownInteriorStone, navRoute, rollTownInterior, townFloorAt, within } from '../src/v2/rooms/town-interior.js'
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
// The potion master's house is a cottage (layers/towns.js).
for (let s = 1; s <= SEEDS; s++) {
  const plan = planBuilding({ seed: s * 7919 + 1, kind: 'cottage' })
  try { houses.push(rollTownInterior({ seed: 4242, index: 1000 + s, plan, shop: 'potions' })) } catch (e) { threw++; console.log(`  potions ${s}: ${e.message}`) }
}
// The inn is an inn-kind building, or the town's grandest when it has none (layers/towns.js).
for (let s = 1; s <= SEEDS; s++) {
  const plan = planBuilding({ seed: s * 7919 + 2, kind: s % 3 === 0 ? 'longhouse' : 'inn' })
  try { houses.push(rollTownInterior({ seed: 4242, index: 2000 + s, plan, shop: 'inn' })) } catch (e) { threw++; console.log(`  inn ${s}: ${e.message}`) }
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
{
  const shops = houses.filter((r) => r.shop === 'potions')
  const far = shops.map((r) => { const c = r.items.find((it) => it.kind === 'counter'); return c ? Math.hypot(c.x - r.doorIn.x, c.z - r.doorIn.z) : Infinity })
  check(shops.length === SEEDS && shops.every((r) => r.spots.some((s) => s.kind === 'shop') && r.items.filter((it) => it.kind === 'potion').length >= 4), `a potion master's house has a counter of potions to keep (${shops.length} shops)`)
  const near = far.filter((d) => d < 4.5).length
  check(near >= shops.length * 0.9, `the counter mostly stands near the front door (${near} of ${shops.length} within 4.5 m)`)
  check(houses.every((r) => (r.shop !== null) === r.items.some((it) => it.kind === 'counter')), 'only a shop has a counter')
}
{
  const inns = houses.filter((r) => r.shop === 'inn')
  const hall = (r) => r.rooms.find((rm) => rm.kind === 'hall').id
  const tables = inns.map((r) => r.items.filter((it) => it.kind === 'table' && it.room === hall(r)).length)
  const rooms = inns.filter((r) => r.upper).map((r) => r.rooms.filter((rm) => rm.level === 1 && rm.kind === 'bedroom').length)
  const flat = inns.filter((r) => !r.upper)
  check(flat.every((r) => r.rooms.filter((rm) => rm.kind !== 'store').every((rm) => rm === r.rooms.find((q) => q.kind === 'hall') || rm.kind === 'kitchen' || rm.kind === 'bedroom')), `an inn with no upper floor lets its side rooms (${flat.length} inns)`)
  check(inns.length === SEEDS && inns.every((r) => r.spots.some((s) => s.kind === 'shop') && r.items.some((it) => it.kind === 'counter' && it.room === hall(r))), `an inn has a bar in its taproom for its keeper (${inns.length} inns)`)
  const most = tables.slice().sort((a, b) => a - b)[tables.length >> 1]
  check(Math.min(...tables) >= 3 && most >= 6, `an inn's taproom holds many tables (fewest ${Math.min(...tables)}, median ${most})`)
  check(Math.min(...rooms) >= 2, `an inn lets several bedrooms upstairs (fewest ${Math.min(...rooms)})`)
}
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
  const walk = new WalkSurface({ heightAt: (x, z) => townFloorAt(room, x, z) }, new TownInteriorStone(room, 0, 0, 0), { trunkAt: () => null }, { scale: 1 })
  const b = room.bounds, X0 = b.x0 - 1, Z0 = b.z0 - 1, NX = Math.ceil((b.x1 - b.x0 + 2) / CELL), NZ = Math.ceil((b.z1 - b.z0 + 2) / CELL)
  const xOf = (i) => X0 + i * CELL, zOf = (k) => Z0 + k * CELL
  const seen = new Map(), queue = []
  const land = walk.heightAt(room.doorIn.x, room.doorIn.z, 0)
  const i0 = Math.round((room.doorIn.x - X0) / CELL), k0 = Math.round((room.doorIn.z - Z0) / CELL)
  seen.set(k0 * NX + i0, [land]); queue.push([i0, k0, land])
  let out = 0, deep = 0
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
      deep = Math.min(deep, h)
      if (!room.inside.some((r) => within(r, x, z))) out++
    }
  }
  const near = Math.ceil(walk.radius / CELL) + 1
  const reached = (x, z, y) => {
    const i = Math.round((x - X0) / CELL), k = Math.round((z - Z0) / CELL)
    for (let dk = -near; dk <= near; dk++) for (let di = -near; di <= near; di++) if ((seen.get((k + dk) * NX + i + di) || []).some((g) => Math.abs(g - y) < 0.15)) return true
    return false
  }
  return { land, out, reached, deep }
}

{
  const lost = [], walls = [], landed = [], upstairs = [], ways = [], block = []
  for (const r of houses) {
    const f = flood(r), tag = `${r.kind}/${r.index}`
    if (Math.abs(f.land) > 0.05) landed.push(`${tag} at ${f.land.toFixed(2)}`)
    if (f.out > 0) walls.push(`${tag} (${f.out} cells)`)
    for (const s of r.spots) if (!f.reached(s.standX, s.standZ, r.nav.floors[s.level])) lost.push(`${tag} ${s.kind} on ${s.level}`)
    if (r.upper && !f.reached(r.stair.top.x, r.stair.top.z, r.nav.floors[1])) upstairs.push(tag)
    // A teleport lob meets the stair as one block (main.js aimTeleport): the notch over each tread is in it, the air a rise over that is not.
    if (r.upper) {
      const stone = new TownInteriorStone(r, 0, 0, 0)
      for (const t of r.stair.treads) {
        const x = (t.x0 + t.x1) / 2, z = (t.z0 + t.z1) / 2
        if (stone.stairAt(x, t.top + r.stair.rise / 2, z) !== t.top || stone.stairAt(x, t.top + r.stair.rise * 1.5, z) !== null) { block.push(tag); break }
      }
    }
    for (const s of r.spots) if (!navRoute(r, { x: r.doorIn.x, z: r.doorIn.z, level: 0 }, { x: s.standX, z: s.standZ, level: s.level })) ways.push(`${tag} ${s.kind}`)
  }
  const show = (list) => (list.length ? ` -- ${list.slice(0, 4).join(', ')}` : '')
  check(landed.length === 0, `she lands on the floor inside the door${show(landed)}`)
  check(walls.length === 0, `she never walks out through a wall${show(walls)}`)
  check(lost.length === 0, `she walks to every resident's place${show(lost)}`)
  check(upstairs.length === 0, `she climbs the stair to the upper floor${show(upstairs)}`)
  check(block.length === 0, `a teleport lob meets each stair as one block, landing on the tread${show(block)}`)
  check(ways.length === 0, `the residents' ways join the door to every place${show(ways)}`)
}

{
  // design/38 Cellar: a house with a cellar (never a hut) has its stair in a ground-floor corner well away from the front door, screened by a board wall, walked to and down from the door, its other rooms still all reached; check-towns rolls every house the map actually sites one in.
  const threwC = [], lostC = [], wallsC = [], spotsC = [], nearC = [], screenC = []
  for (const kind of Object.keys(KINDS).filter((k) => k !== 'hut')) for (let s = 1; s <= SEEDS; s++) {
    const plan = planBuilding({ seed: s * 7919, kind }), tag = `${kind}/${s}`
    let r
    try { r = rollTownInterior({ seed: 4242, index: s, plan, cellar: true }) } catch (e) { threwC.push(`${tag}: ${e.message}`); continue }
    const f = flood(r)
    if (f.deep > -CELLAR.fade) lostC.push(`${tag} down to ${f.deep.toFixed(2)} m`)
    const h = r.cellar.hole, d = Math.hypot((h.x0 + h.x1) / 2 - r.doorIn.x, (h.z0 + h.z1) / 2 - r.doorIn.z)
    if (d < 4) nearC.push(`${tag} ${d.toFixed(1)} m`)
    const sc = r.cellar.screen
    if (!r.solids.some((b) => b.kind === 'wall' && b.y0 === 0 && b.y1 >= 2.2 && (sc.axis === 'x' ? b.z0 < sc.at && b.z1 > sc.at && b.x0 <= Math.min(h.x0, h.x1) + 0.01 && b.x1 >= h.x1 - 0.01 : b.x0 < sc.at && b.x1 > sc.at && b.z0 <= h.z0 + 0.01 && b.z1 >= h.z1 - 0.01))) screenC.push(tag)
    if (f.out > 0) wallsC.push(tag)
    for (const sp of r.spots) if (!f.reached(sp.standX, sp.standZ, r.nav.floors[sp.level])) { spotsC.push(`${tag} ${sp.kind}`); break }
  }
  const show = (list) => (list.length ? ` -- ${list.slice(0, 4).join(', ')}` : '')
  check(threwC.length === 0, `every building but a hut rolls with a cellar stair${show(threwC)}`)
  check(lostC.length === 0, `she walks from the front door down the cellar stair into the cave${show(lostC)}`)
  check(nearC.length === 0, `the cellar stair is tucked away from the front door${show(nearC)}`)
  check(screenC.length === 0, `a board wall screens the cellar stair along its length${show(screenC)}`)
  check(wallsC.length === 0, `a cellar house never lets her out through a wall${show(wallsC)}`)
  check(spotsC.length === 0, `a cellar house still reaches every resident's place${show(spotsC)}`)
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
