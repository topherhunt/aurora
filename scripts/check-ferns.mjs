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

import * as THREE from 'three'

import { Ferns, FERN_TUNING } from '../src/v2/render/ferns.js'
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
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0 }),
  snowLineAt: () => 9999,
  bands: { altLo: 0, altSpan: 900 },
}
const water = { isSubmerged: () => false, levelAt: () => null, shoreDistAt: () => 0 }
const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 }, paths: { nearest: () => null } }
const textures = buildTextureArray()

const build = (w = water, opts = {}) => new Ferns(new THREE.Scene(), field, w, layers, textures, { seed: 7, ...opts })

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

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all fern checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
