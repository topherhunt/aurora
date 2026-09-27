// Node-side gates for the leafkin house interiors (src/v2/rooms/interior.js, design/30-leafkin.md Interiors).
//
//   node scripts/check-interiors.mjs
//
// Many villages' houses on both sides of the loft height: a room rolls the same twice and differently for every house; it has 1-3 windows (one on the floor), a table with 2-4 chairs, a kitchen with its basin, herbs and stores, a bed, candles on the table and in sconces, a corner of garden tools and (nearly always) one of stores, and ten or more smaller things; a third or more of the floor under stuff; a loft exactly when the house outside is tall; no two floor things overlap; she walks straight from inside the door to its mouth; she lands on the floor inside the door; from there the floor reaches every place a resident walks to, and the stairs reach the loft; she climbs onto the table, the chairs and the stools; and she never stands in the wall or in a piece of furniture.

import { LOCOMOTION } from '../src/player.js'
import { FILLET, InteriorStone, SEAT, STOOL_H, flatField, rAt, rollInterior } from '../src/v2/rooms/interior.js'
import { HER_SCALE } from '../src/v2/rooms/village.js'
import { WalkSurface } from '../src/v2/walk.js'

let failures = 0
const check = (ok, what) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}

const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 7919)
const HOUSES = 8
// Outside heights either side of the loft's 6 m, as the glade's houses stand.
const heightOf = (i) => 3.5 + ((i * 1.37) % 6.5)
const STRUCTURE = new Set(['table', 'chair', 'counter', 'candle', 'sconce', 'bed', 'bookcase', 'divider', 'plate', 'cup'])

// Walking the stone as main.js does (her glade-sized WalkSurface) by player.js's step rules: the next foot height is the surface within her reach, the rise is within the slope over one step or over a stride, and her capsule fits there. Flooded over a CELL grid, eight ways.
const CELL = 0.05
const MAX_TAN = Math.tan((LOCOMOTION.maxSlopeDeg * Math.PI) / 180), STRIDE = LOCOMOTION.stride * HER_SCALE
function flood(room) {
  const stone = new InteriorStone(room, 0, 0, 0)
  const walk = new WalkSurface(flatField(0), stone, { trunkAt: () => null }, { scale: HER_SCALE })
  const reach = room.R + 1.2, N = Math.ceil((2 * reach) / CELL)
  const idx = (i, j) => i * N + j
  const xy = (i) => -reach + i * CELL
  const seen = new Map()
  const cellOf = (x, z) => [Math.round((x + reach) / CELL), Math.round((z + reach) / CELL)]
  const [i0, j0] = cellOf(room.doorIn.x, room.doorIn.z)
  const queue = [[i0, j0, walk.heightAt(xy(i0), xy(j0))]]
  seen.set(idx(i0, j0), [queue[0][2]])
  while (queue.length) {
    const [i, j, y] = queue.pop()
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, b = j + dj
      if (a < 0 || b < 0 || a >= N || b >= N) continue
      const dist = CELL * Math.hypot(di, dj), x = xy(a), z = xy(b)
      const h = walk.heightAt(x, z, y)
      if (Math.abs(h - y) / dist > MAX_TAN) {
        const k = STRIDE / dist
        if (Math.abs(walk.heightAt(xy(i) + di * CELL * k, xy(j) + dj * CELL * k, y) - y) / STRIDE > MAX_TAN) continue
      }
      if (!walk.fits(x, z, Math.max(y, h), null)) continue
      const got = seen.get(idx(a, b)) ?? []
      if (got.some((g) => Math.abs(g - h) < 0.01)) continue
      got.push(h)
      seen.set(idx(a, b), got)
      queue.push([a, b, h])
    }
  }
  // Reached within her radius of the point: a place by the wall is judged where her body can stand.
  const near = Math.ceil(walk.radius / CELL)
  const reached = (x, z, y) => {
    const [i, j] = cellOf(x, z)
    for (let di = -near; di <= near; di++) for (let dj = -near; dj <= near; dj++) if ((seen.get(idx(i + di, j + dj)) ?? []).some((g) => Math.abs(g - y) < 0.1)) return true
    return false
  }
  const cells = [...seen].map(([k, hs]) => ({ x: xy(Math.floor(k / N)), z: xy(k % N), hs }))
  const stoodAt = (x, z) => { const [i, j] = cellOf(x, z); return seen.get(idx(i, j)) ?? [] }
  return { stone, reached, cells, stoodAt }
}

const rooms = []
for (const seed of SEEDS) for (let index = 0; index < HOUSES; index++) rooms.push(rollInterior({ seed, index, height: heightOf(index) }))
const kinds = (room, kind) => room.items.filter((it) => it.kind === kind)
const every = (what, pred) => {
  const bad = rooms.filter((r) => !pred(r))
  check(bad.length === 0, `${what}${bad.length ? ` -- not in ${bad.slice(0, 4).map((r) => `${r.seed}/${r.index}`).join(', ')}` : ''}`)
}

console.log(`Interiors: ${rooms.length} rooms over ${SEEDS.length} villages`)
{
  const again = rollInterior({ seed: SEEDS[3], index: 5, height: heightOf(5) })
  check(JSON.stringify(again) === JSON.stringify(rooms[3 * HOUSES + 5]), 'a house rolls the same room twice')
  const sig = (r) => `${r.R.toFixed(4)}:${r.items.length}:${r.ring.x.toFixed(3)}`
  check(new Set(rooms.map(sig)).size === rooms.length, 'no two houses roll the same room')
}
every('1-3 windows, one on the floor', (r) => r.windows.length >= 1 && r.windows.length <= 3 && r.windows.some((w) => w.level === 0))
every('a table with 2-4 chairs and a place at each', (r) => kinds(r, 'table').length === 1 && kinds(r, 'chair').length >= 2 && kinds(r, 'chair').length <= 4 && kinds(r, 'plate').length === kinds(r, 'chair').length)
every('a kitchen: counter, basin, herbs and something on the shelf', (r) => kinds(r, 'counter').length === 1 && kinds(r, 'basin').length === 1 && kinds(r, 'herbs').length === 1 && r.items.some((it) => ['jar', 'loaf', 'cheese', 'crock'].includes(it.kind)))
every('a bed with a plushie on it, and its spot', (r) => kinds(r, 'bed').length === 1 && kinds(r, 'plush').length >= 1 && r.spots.some((s) => s.kind === 'bed'))
every('a candle on the table and one in a sconce', (r) => r.items.some((it) => it.kind === 'candle' && it.y === 0.42) && kinds(r, 'sconce').length >= 1 && r.candles.length >= 2)
{
  const small = rooms.map((r) => r.items.filter((it) => !STRUCTURE.has(it.kind)).length)
  check(Math.min(...small) >= 10, `ten or more smaller things in every room (fewest ${Math.min(...small)}, most ${Math.max(...small)})`)
}
every('a corner of garden tools', (r) => kinds(r, 'tool').length >= 3 && kinds(r, 'wcan').length === 1)
{
  const stores = rooms.filter((r) => kinds(r, 'barrel').length + kinds(r, 'crate').length > 0).length
  check(stores >= rooms.length * 0.95, `a corner of stores in nearly every room (${stores} of ${rooms.length})`)
}
{
  const cover = rooms.map((r) => r.cover), mean = cover.reduce((a, b) => a + b) / cover.length
  check(mean >= 0.33 && Math.min(...cover) >= 0.22, `a third or more of the floor under stuff (mean ${mean.toFixed(2)}, least ${Math.min(...cover).toFixed(2)})`)
}
every('a loft exactly when the house outside stands 6 m or more', (r) => (r.loft !== undefined) === (heightOf(r.index) >= 6))
check(rooms.some((r) => r.loft) && rooms.some((r) => !r.loft), 'some houses have a loft and some do not')
every('a lofted bed is up in the loft', (r) => !r.loft || r.spots.find((s) => s.kind === 'bed').level === 1)
{
  const styles = new Set(rooms.flatMap((r) => kinds(r, 'divider').map((d) => d.style)))
  check(['lattice', 'sticks', 'curtain'].every((s) => styles.has(s)), `dividers of every style (${[...styles].join(', ')})`)
}
every('no two floor things overlap', (r) => {
  const cyl = r.solids.filter((s) => s.kind === 'cyl')
  for (let i = 0; i < cyl.length; i++) for (let j = i + 1; j < cyl.length; j++) if (Math.hypot(cyl[i].x - cyl[j].x, cyl[i].z - cyl[j].z) < cyl[i].r + cyl[j].r - 1e-6) return false
  return true
})

// The exit fires within 0.6 m of the door's middle (main.js HOUSE_DOOR.walk): walking straight at it from inside the door must get there.
every('she walks straight from inside the door to within 0.5 m of it', (r) => {
  const walk = new WalkSurface(flatField(0), new InteriorStone(r, 0, 0, 0), { trunkAt: () => null }, { scale: HER_SCALE })
  let x = r.doorIn.x
  while (walk.fits(x - 0.01, 0, 0, null)) x -= 0.01
  return x + rAt(r.rs, Math.PI) < 0.5
})

// The walk: the flood is the slow part, so it runs on every house of three villages.
const walked = rooms.filter((r) => SEEDS.slice(0, 3).includes(r.seed))
const reachFails = []
let climbable = 0, climbed = 0, chairs = 0, sat = 0
for (const r of walked) {
  const { stone, reached, cells, stoodAt } = flood(r)
  const fail = (what) => reachFails.push(`${r.seed}/${r.index} ${what}`)
  if (Math.abs(stone.blockTopAt(r.doorIn.x, r.doorIn.z)) > 1e-9) fail('lands off the floor')
  r.ringPts.forEach((p, k) => { if (!reached(p.x, p.z, 0)) fail(`ring ${k}`) })
  for (const s of r.spots) if (['cook', 'gaze', 'talk'].includes(s.kind) && !reached(s.x, s.z, 0)) fail(s.kind)
  if (r.loft) {
    const land = r.climb[r.climb.length - 1]
    if (!reached(r.climb[0].x, r.climb[0].z, 0)) fail('the stairs\' foot')
    if (!reached(land.x, land.z, r.loft.y)) fail('the loft')
  }
  if (cells.some((c) => Math.hypot(c.x, c.z) >= rAt(r.rs, Math.atan2(c.z, c.x)) - FILLET)) fail('stands in the wall')
  // Over a thing's middle she stands on its top or clear above it, never in it.
  for (const s of r.solids) if ((s.kind === 'cyl' || s.kind === 'box') && stoodAt(s.x, s.z).some((h) => h > s.y0 - 0.05 && h < s.y1 - 0.01)) fail(`stands in a ${s.kind} at (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`)
  const table = r.solids.find((s) => s.kind === 'cyl' && s.x === r.ring.x && s.z === r.ring.z)
  if (!stoodAt(table.x, table.z).some((h) => Math.abs(h - table.y1) < 0.01)) fail('never climbs onto the table')
  for (const it of kinds(r, 'stools')) { climbable++; if (stoodAt(it.x, it.z).some((h) => Math.abs(h - STOOL_H) < 0.01)) climbed++ }
  for (const it of kinds(r, 'chair')) { chairs++; if (stoodAt(it.x, it.z).some((h) => Math.abs(h - SEAT) < 0.01)) sat++ }
}
check(reachFails.length === 0, `inside the door she stands on the floor, and walks to the table's ring, the kitchen, the window, the talkers and up to the loft, climbs onto the table, never in the wall or in furniture (${walked.length} rooms)${reachFails.length ? ` -- ${reachFails.slice(0, 6).join('; ')}` : ''}`)
check(climbable > 0 && climbed >= climbable * 0.9, `she steps up onto the stools on the floor (${climbed} of ${climbable})`)
check(chairs > 0 && sat >= chairs * 0.9, `she steps up onto the table's chairs (${sat} of ${chairs})`)

console.log(failures ? `\n${failures} FAILED` : '\nall ok')
process.exit(failures ? 1 : 0)
