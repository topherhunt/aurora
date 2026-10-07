// Node-side gate for the fern bed's instance pool (src/v2/render/ferns.js).
//
//   node scripts/check-ferns.mjs
//
// The bed allocates ONE card pool up front, from `_poolBound`, and running dry
// THROWS -- so every way the resident tile set can end up holding more than the
// bound allows is a hard crash in the middle of a session rather than a bed that
// quietly thins. Two of them, and this file exists for both:
//
//   A TILE SURVIVING A CAMERA JUMP AT THE WRONG LEVEL. `_reseat` evicts past the
//   eviction radius and grows what is missing; everything in between keeps the
//   level it was grown at until something thins it. A jump -- a quest teleport,
//   or v2/main.js handing the bed back after the panel's `ferns` toggle stopped
//   `update` being called while the player walked -- leaves a tile that was
//   underfoot standing at full near-field density 100 m away, and the tiles
//   ahead are then grown out of what is left. The pool is sized for every tile
//   standing at the level its distance says, so this exhausts it. The gate is a
//   jump sweep across the whole range where the two discs overlap.
//
//   AN ID THAT NEVER COMES BACK. Every fern owns a card id for as long as it
//   stands, handed out by `_growTile` and returned by `_thin` and `_release`. A
//   path that drops a tile without releasing it, or retires an instance without
//   handing the id back, leaks the pool empty over a long walk and throws the
//   same way. So the walk below audits the three counts that must agree --
//   sum(tile.n), `placed`, and the pool's own used count -- every frame.
//
// The world here is deliberately flat, unrejecting, pathless and ALL SHORE:
// every candidate stands, which is the WORST case for the pool and the only one
// the bound is written against. A real world only ever places fewer. Section 4
// then checks the lush rule itself -- a quarter carpet on plain ground, full
// within reach of water or a boulder.

import { LitterCards } from '../src/v2/render/litter-cards.js'
import * as THREE from 'three'

import { Ferns, FERN_TUNING, FERN_PERCH_STRIDE } from '../src/v2/render/ferns.js'
import { buildShipFernTiers } from '../src/props/fern-bank.js'
import { FERN_DEFAULTS } from '../src/props/fern.js'
import { buildTextureArray } from '../src/textures.js'
import { setPropClock } from '../src/material.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// Ground at 60 m, no slope, no snow, no path, and dry ground that is everywhere
// at a water's edge -- so nothing is rejected and every tile grows its full
// graded complement. The camera rides 1.6 m over it, which is what puts the near
// tiles on the mesh rings.
const GROUND = 60
const field = {
  heightAt: () => GROUND,
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0 }),
  snowLineAt: () => 9999,
  bands: { altLo: 0, altSpan: 900 },
}
const water = { isSubmerged: () => false, levelAt: () => null, shoreDistAt: () => 0 }
const layers = { dirtAt: () => 0, snow: { base: 780, band: 90 }, paths: { nearest: () => null }, fields: { occupiesAt: () => false } }
const textures = buildTextureArray()

const build = (w = water, opts = {}) => new Ferns(new THREE.Scene(), field, w, layers, textures, { seed: 7, cards: new LitterCards(8192), ...opts })

/** The three counts that have to agree, or an id has gone missing. */
const audit = (ferns) => {
  let n = 0
  for (const tile of ferns.tiles.values()) n += tile.n
  const used = ferns.maxInstances - ferns.freeCount
  return { ok: n === used && n === ferns.placed, n, used, placed: ferns.placed }
}

// ---------------------------------------------------------------------------
console.log('\n1. the bed boots inside its own bound\n')

const boot = build()
boot.place(0, 0)
const bootUsed = boot.maxInstances - boot.freeCount
check(bootUsed <= boot.maxInstances,
  'a full unrejecting boot fits the pool',
  `${bootUsed} of ${boot.maxInstances} over ${boot.tiles.size} tiles`)
check(audit(boot).ok, 'and every id it handed out is accounted for', JSON.stringify(audit(boot)))

// ---------------------------------------------------------------------------
console.log('\n2. a camera JUMP never exhausts the pool\n')

// Out to a little past the eviction radius: the worst distances are the ones
// where the old disc and the new one overlap, which is everything under it.
for (const jump of [12, 24, 40, 60, 80, 100, 107, 120, 200]) {
  const ferns = build()
  ferns.place(0, 0)

  let t = 0
  let peak = 0
  let thrown = null
  let leaked = null
  // Frames enough for the queue to settle, and the camera walks on afterwards so
  // the thinning is measured while the bed is also being asked to grow.
  for (let f = 0; f < 240 && !thrown; f++) {
    t += 1 / 72
    setPropClock(t)
    try {
      ferns.update(jump + (f * 4) / 72, GROUND + 1.6, 0)
    } catch (err) {
      thrown = err.message
      break
    }
    peak = Math.max(peak, ferns.maxInstances - ferns.freeCount)
    const a = audit(ferns)
    if (!leaked && !a.ok) leaked = JSON.stringify(a)
  }

  check(!thrown && !leaked,
    `a ${String(jump).padStart(3)} m jump, then a 13 m walk`,
    thrown || leaked || `peak ${peak} of ${ferns.maxInstances} (${ferns.tiles.size} tiles)`)
}

// ---------------------------------------------------------------------------
console.log('\n3. a long walk neither exhausts the pool nor leaks an id\n')

const walk = build()
walk.place(0, 0)
let t = 0
let peak = 0
let peakTiles = 0
let thrown = null
let leaked = null
let x = 0
let z = 0
const step = (nx, nz) => {
  if (thrown) return
  t += 1 / 72
  setPropClock(t)
  try {
    walk.update(nx, GROUND + 1.6, nz)
  } catch (err) {
    thrown = err.message
    return
  }
  const used = walk.maxInstances - walk.freeCount
  if (used > peak) { peak = used; peakTiles = walk.tiles.size }
  const a = audit(walk)
  if (!leaked && !a.ok) leaked = JSON.stringify(a)
}

// 200 m straight, 200 m diagonal, a 50 m/s fly, then a circle -- the circle
// because it crosses tile lines in every direction, which is what makes tiles
// come back at levels they have held before.
for (let i = 0; i < 3600; i++) { x += 4 / 72; step(x, z) }
for (let i = 0; i < 3600; i++) { x += 2.8 / 72; z += 2.8 / 72; step(x, z) }
for (let i = 0; i < 1800; i++) { z += 50 / 72; step(x, z) }
for (let i = 0; i < 3600; i++) {
  const a = (i / 3600) * Math.PI * 40
  step(x + 40 * Math.cos(a), z + 40 * Math.sin(a))
}

check(!thrown, 'a 700 m walk, a fly and twenty circles never run the pool dry',
  thrown || `peak ${peak} of ${walk.maxInstances} (${peakTiles} tiles)`)
check(!leaked, 'and the ids balance on every frame of it', leaked || audit(walk).used + ' still out')

// ---------------------------------------------------------------------------
console.log('\n4. the carpet is a quarter as thick away from water and stone\n')

// Ferns standing inside a box, off the tile ledgers.
const countIn = (ferns, x0, x1, z0, z1) => {
  let n = 0
  for (const tile of ferns.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const x = ferns.instX[id]
      const z = ferns.instZ[id]
      if (x >= x0 && x < x1 && z >= z0 && z < z1) n++
    }
  }
  return n
}
const { LUSH, FULL_RADIUS } = FERN_TUNING
// A box well inside the full-density radius, so no graded thinning is in it.
const R = FULL_RADIUS * 0.6
const lush = boot
const plain = build({ ...water, shoreDistAt: (x, z, reach) => reach })
plain.place(0, 0)
{
  const a = countIn(lush, -R, R, -R, R)
  const b = countIn(plain, -R, R, -R, R)
  check(Math.abs(b / a - 1 / LUSH.gain) < 0.02,
    `plain ground carries 1/${LUSH.gain} of the shore's carpet`, `${b} of ${a}`)
  check(plain.rejected.sparse > 0 && lush.rejected.sparse === 0,
    'and the difference is counted as `sparse`', `${plain.rejected.sparse} vs ${lush.rejected.sparse}`)
}
{
  // A straight shore: water at x < 0, so the dry side's distance is x itself.
  const shore = build({ ...water, shoreDistAt: (x, z, reach) => Math.min(reach, Math.max(-reach, x)) })
  shore.place(0, 0)
  const bank = countIn(shore, 0, LUSH.shoreReach, -R, R)
  const bankLush = countIn(lush, 0, LUSH.shoreReach, -R, R)
  const beyond = countIn(shore, LUSH.shoreReach, R, -R, R)
  const beyondPlain = countIn(plain, LUSH.shoreReach, R, -R, R)
  check(bank === bankLush, `the ${LUSH.shoreReach} m bank is the full carpet`, `${bank} vs ${bankLush}`)
  check(beyond === beyondPlain, 'and past it is the plain one', `${beyond} vs ${beyondPlain}`)
}
{
  // One boulder at the origin with a 2 m foot and nothing standing on it, so the
  // lush disc is its foot plus rockReach and every fern in it is on the ground.
  const foot = 2
  const rocks = {
    blockTopAt: () => -Infinity,
    anchorsInto: (x0, z0, x1, z1, out) => {
      if (x0 > 0 || x1 <= 0 || z0 > 0 || z1 <= 0) return 0
      out[0] = 0; out[1] = GROUND; out[2] = 0; out[3] = foot
      return 1
    },
  }
  const stony = build({ ...water, shoreDistAt: (x, z, reach) => reach }, { rocks })
  stony.place(0, 0)
  const ring = (ferns, r) => {
    let n = 0
    for (const tile of ferns.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (Math.hypot(ferns.instX[id], ferns.instZ[id]) - foot <= r) n++
      }
    }
    return n
  }
  const near = ring(stony, LUSH.rockReach)
  const nearLush = ring(lush, LUSH.rockReach)
  check(near === nearLush && near > 0, `the carpet is full within ${LUSH.rockReach} m of a boulder's foot`, `${near} vs ${nearLush}`)
  check(countIn(stony, -R, R, -R, R) - near === countIn(plain, -R, R, -R, R) - ring(plain, LUSH.rockReach),
    'and plain beyond it')
}
{
  // A road along z at x = 0, half-width 3 m and feather 8 m; the stub answers only within the feather, as PathSet.nearest does. Its verge is lush from the kerb (past pathClearance) to roadReach.
  const HW = 3
  const FEATHER = 8
  const { pathClearance } = FERN_TUNING.PLACEMENT
  const roaded = { ...layers, paths: { nearest: (x, z, kind) => (kind === 'road' && Math.abs(x) <= HW + FEATHER ? { dist: Math.abs(x), halfWidth: HW } : null) } }
  const verge = new Ferns(new THREE.Scene(), field, { ...water, shoreDistAt: (x, z, reach) => reach }, roaded, textures, { seed: 7, cards: new LitterCards(8192) })
  verge.place(0, 0)
  const on = countIn(verge, -HW - pathClearance, HW + pathClearance, -R, R)
  const band = countIn(verge, HW + pathClearance, HW + LUSH.roadReach, -R, R)
  const bandLush = countIn(lush, HW + pathClearance, HW + LUSH.roadReach, -R, R)
  const beyond = countIn(verge, HW + FEATHER, R, -R, R)
  const beyondPlain = countIn(plain, HW + FEATHER, R, -R, R)
  check(on === 0 && countIn(lush, -HW, HW, -R, R) > 0, 'no fern stands on a road', `${on} on it`)
  check(band === bandLush && band > 0, `the verge is the full carpet out to ${LUSH.roadReach} m past the kerb`, `${band} vs ${bandLush}`)
  check(beyond === beyondPlain, 'and past the feather it is the plain one', `${beyond} vs ${beyondPlain}`)
}

// ---------------------------------------------------------------------------
console.log('\n5. what a butterfly lands on\n')
{
  // The keyed box query against a brute sweep of every resident fern, on boxes
  // that cross tile edges and one that starts exactly on one.
  const ferns = build()
  ferns.place(0, 0)
  const brute = (x0, z0, x1, z1) => {
    const ids = []
    for (const tile of ferns.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const x = ferns.instX[id], z = ferns.instZ[id]
        if (x >= x0 && x < x1 && z >= z0 && z < z1) ids.push(id)
      }
    }
    return ids.sort((a, b) => a - b)
  }
  const buf = new Float32Array(4096 * FERN_PERCH_STRIDE)
  let agree = true
  for (const [x0, z0, x1, z1] of [[-3, -3, 3, 3], [12, -7, 19, 5], [-30.5, 2.2, -14, 40], [0, 0, 12, 12], [-12, -24, 0, -12]]) {
    const n = ferns.perchesInto(x0, z0, x1, z1, buf)
    const got = []
    for (let i = 0; i < n; i++) got.push(buf[i * FERN_PERCH_STRIDE + 4])
    got.sort((a, b) => a - b)
    const want = brute(x0, z0, x1, z1)
    if (want.length === 0 || got.length !== want.length || got.some((id, i) => id !== want[i])) { agree = false; console.log(`    box ${x0},${z0}..${x1},${z1}: keyed ${got.length} vs swept ${want.length}`) }
  }
  check(agree, 'perchesInto keyed by tile reports exactly the ferns a sweep does')

  // Every landing is a point of one of the LOD0 rosette's own triangles, carried
  // by the fern's drawn matrix, with the blade's upper normal.
  // Rebuilt at the bed's seed, so the reference is the rosette the bed drew rather than its own copy.
  const lod0 = buildShipFernTiers({ seed: 7 }).tiers.find((t) => t.name === 'LOD0').geometry
  const tri = new THREE.Triangle(), P = new THREE.Vector3(), Q = new THREE.Vector3(), N = new THREE.Vector3(), M = new THREE.Matrix4(), inv = new THREE.Matrix4()
  const pos = lod0.attributes.position.array, idx = lod0.index.array
  const n = ferns.perchesInto(-6, -6, 6, 6, buf)
  const rand = (() => { let s = 5; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } })()
  const hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 }
  let onMesh = 0, upper = 0, unit = 0, aboveSeat = 0, spread = 0, worst = 0
  const SAMPLES = 200
  for (let s = 0; s < SAMPLES; s++) {
    const o = Math.floor(rand() * n) * FERN_PERCH_STRIDE
    const id = buf[o + 4]
    ferns.landOn(id, rand, hit)
    ferns.cards.getMatrixAt(id, M)
    inv.copy(M).invert()
    P.set(hit.x, hit.y, hit.z).applyMatrix4(inv)
    let best = Infinity, bestNy = 0
    for (let t = 0; t < idx.length; t += 3) {
      tri.a.fromArray(pos, idx[t] * 3); tri.b.fromArray(pos, idx[t + 1] * 3); tri.c.fromArray(pos, idx[t + 2] * 3)
      const d = tri.closestPointToPoint(P, Q).distanceTo(P)
      if (d < best) { best = d; tri.getNormal(N); N.transformDirection(M); bestNy = N.y }
    }
    worst = Math.max(worst, best)
    if (best < 1e-5) onMesh++
    if (hit.ny >= 0 && Math.abs(Math.abs(hit.nx * N.x + hit.ny * N.y + hit.nz * N.z) - 1) < 1e-4) upper++
    if (Math.abs(Math.hypot(hit.nx, hit.ny, hit.nz) - 1) < 1e-6) unit++
    if (hit.y >= buf[o + 1] - 1e-6 && hit.y <= buf[o + 1] + FERN_DEFAULTS.height * 2.4) aboveSeat++
    if (Math.hypot(hit.x - buf[o], hit.z - buf[o + 2]) > 0.05) spread++
  }
  check(n > 0 && onMesh === SAMPLES, 'every landing lies on a triangle of the LOD0 rosette under the fern\'s drawn matrix', `${onMesh}/${SAMPLES}, worst ${worst.toExponential(2)} m off`)
  check(upper === SAMPLES, 'with that triangle\'s upper normal', `${upper}/${SAMPLES}`)
  check(unit === SAMPLES, 'of unit length', `${unit}/${SAMPLES}`)
  check(aboveSeat === SAMPLES, 'between the seat and the rosette\'s height', `${aboveSeat}/${SAMPLES}`)
  check(spread > SAMPLES * 0.8, 'and out on the fronds, not stacked over the crown', `${spread}/${SAMPLES} past 5 cm of the axis`)
}

// ---------------------------------------------------------------------------
console.log('\n6. the ferns a room plants\n')

{
  // A room hands the bed ferns of its own (rooms/village.js DECOR: against a
  // wall, on a roof), and the bed grows them inside its own tiles so the rim,
  // the thinning and the butterflies own them like any other. Ground no wild
  // fern would take -- too steep, over the snow, under water -- is the test:
  // the plant stands on it anyway, because the room has already decided.
  const steep = { heightAt: () => GROUND, heightAndSlopeAt: () => ({ h: GROUND, tan: 4 }), snowLineAt: () => GROUND - 50, bands: field.bands }
  const flood = { isSubmerged: () => true, levelAt: () => GROUND + 5, shoreDistAt: () => 0 }
  const plants = [{ x: 3.5, z: 4.25, scale: 1.1 }, { x: -6.5, z: 2.5, scale: 2, y: GROUND + 7 }, { x: 40.5, z: -18.5, scale: 0.9 }]
  const { sink } = FERN_TUNING.PLACEMENT
  const nothing = new Ferns(new THREE.Scene(), steep, flood, layers, textures, { seed: 7, cards: new LitterCards(8192) })
  nothing.place(0, 0)
  check(nothing.placed === 0, 'no wild fern takes ground this steep, this high and this wet', `${nothing.placed} placed`)
  const bed = new Ferns(new THREE.Scene(), steep, flood, layers, textures, { seed: 7, cards: new LitterCards(8192), plants })
  bed.place(0, 0)
  const standing = plants.map((p) => {
    for (const tile of bed.tiles.values()) for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (bed.instX[id] === p.x && bed.instZ[id] === p.z) return id
    }
    return -1
  })
  check(bed.placed === plants.length && standing.every((id) => id >= 0), 'every fern the room plants stands, on ground the bed would refuse', `${bed.placed} of ${plants.length}`)
  // fround: the instance arrays are Float32Array, so the scale it was given comes back rounded to a float.
  const sized = standing.filter((id, i) => id >= 0 && bed.instScale[id] === Math.fround(plants[i].scale)).length
  // A plant given a y sits on that surface -- a roof -- sunk into it as a fern is into the ground; one without takes the ground under it.
  const seated = standing.filter((id, i) => id >= 0 && Math.abs(bed.instY[id] - ((plants[i].y ?? GROUND) - sink * plants[i].scale)) < 1e-5).length
  check(sized === plants.length && seated === plants.length, 'at the size it was given, seated on its own y where it has one and on the ground where it has not', `${sized} sized, ${seated} seated`)
  // A nest's ferns (roosts.js fernsIn) are the same plants, asked for a tile at a time.
  const nests = { fernsIn: (x0, z0, x1, z1, out) => { out.push(...plants.filter((p) => p.x >= x0 && p.x < x1 && p.z >= z0 && p.z < z1)); return out }, fernsBound: () => 5 }
  const nested = new Ferns(new THREE.Scene(), steep, flood, layers, textures, { seed: 7, cards: new LitterCards(8192), nests })
  nested.place(0, 0)
  const at = (b) => [...b.tiles.values()].flatMap((t) => Array.from(t.ids.subarray(0, t.n), (id) => [b.instX[id], b.instY[id], b.instZ[id], b.instScale[id]].join())).sort().join(' ')
  check(nested.placed === plants.length && at(nested) === at(bed) && nested.maxInstances === nothing.maxInstances + 5, 'a nest\'s ferns stand as the room\'s plants do, the pool grown by the nests\' bound', `${nested.placed} placed, pool ${nested.maxInstances}`)
  nested.dispose()
  // The wild bed does not move: a plant draws its look off its own point, never off the tile's stream.
  const wild = build()
  wild.place(0, 0)
  const both = new Ferns(new THREE.Scene(), field, water, layers, textures, { seed: 7, cards: new LitterCards(8192), plants })
  both.place(0, 0)
  let moved = 0, wildN = 0
  for (const tile of wild.tiles.values()) {
    const other = both.tiles.get(tile.tx * 0x10000 + tile.tz)
    if (!other) { moved += tile.n; continue }
    for (let k = 0; k < tile.n; k++) {
      const a = tile.ids[k]
      wildN++
      let found = false
      for (let q = 0; q < other.n && !found; q++) {
        const b = other.ids[q]
        found = wild.instX[a] === both.instX[b] && wild.instZ[a] === both.instZ[b] && wild.instScale[a] === both.instScale[b] && wild.instY[a] === both.instY[b]
      }
      if (!found) moved++
    }
  }
  check(moved === 0 && both.placed === wildN + plants.length, 'and the wild bed round it stands exactly where it did', `${moved} of ${wildN} moved, ${both.placed - wildN} planted`)
  check(both.maxInstances === wild.maxInstances + plants.length, 'the pool grows by the plants and no more', `${both.maxInstances} over ${wild.maxInstances}`)
  // The thinning cuts the wild bed by distance; a plant's rank is under every band, so it is still standing when the ferns rolled beside it are gone.
  const key = Math.floor(3.5 / 12) * 0x10000 + Math.floor(4.25 / 12)
  const before = both.tiles.get(key).n
  let t6 = 0
  for (let f = 0; f < 240; f++) { t6 += 1 / 72; setPropClock(t6); both.update(74, GROUND + 1.6, 0) }
  const home = both.tiles.get(key)
  let stands = false
  for (let k = 0; k < home.n; k++) if (both.instX[home.ids[k]] === 3.5 && both.instZ[home.ids[k]] === 4.25) stands = true
  check(stands && home.n < before / 4, 'a plant survives the thinning that cuts the ferns rolled beside it', `${home.n} of ${before} left in its tile seventy-four metres off`)
  nothing.dispose(); bed.dispose(); wild.dispose(); both.dispose()
}

// ---------------------------------------------------------------------------
console.log('\n7. the far cards are the shared pool\'s\n')
{
  const pool = new LitterCards(8192)
  const ferns = new Ferns(new THREE.Scene(), field, water, layers, textures, { seed: 7, cards: pool })
  ferns.place(0, 0)
  let t = 0
  for (let f = 0; f < 120; f++) { t += 1 / 72; setPropClock(t); ferns.update(0, GROUND + 1.6, 0) }
  const standing = [...ferns.tiles.values()].reduce((n, tile) => n + tile.n, 0)
  const cardsDrawn = pool.stats.used
  check(ferns.meshes.length === ferns.ringCount, 'the bed owns only its mesh rings; the cards are not a mesh of its own', `${ferns.meshes.length} meshes, ${ferns.ringCount} rings`)
  check(cardsDrawn > 0 && cardsDrawn <= standing, 'the far ferns are instances of the shared pool', `${cardsDrawn} of ${standing} standing`)
  ferns.setShown(false)
  check(pool.stats.used === 0 && ferns.meshes.every((m) => !m.visible), 'setShown(false) takes its cards out of the shared pool and hides its rings')
  ferns.setShown(true)
  check(pool.stats.used === cardsDrawn && ferns.meshes.every((m) => m.visible), 'and setShown(true) puts the same cards back', `${pool.stats.used} of ${cardsDrawn}`)
  ferns.dispose()
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all fern checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
