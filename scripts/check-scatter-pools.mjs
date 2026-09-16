// Node-side gate for the scatter beds' instance pools (src/v2/render/*.js).
//
//   node scripts/check-scatter-pools.mjs
//
// Every tiled scatter allocates ONE pool up front from `_poolBound`, sized for
// each tile standing at the level its DISTANCE says, and running dry THROWS.
// That makes the graded thinning load-bearing rather than cosmetic, and this
// file gates the two ways it has been defeated:
//
//   A TILE THE CAMERA LEFT BEHIND IS NEVER RE-LEVELLED. `_reseat` rebuilds the
//   queue with the MISSING tiles only, so a survivor keeps the level it was
//   grown at until the tile loop's thin job is worked on some later frame -- and
//   the next crossing drops that job. One jump is survivable; a STRING of them
//   is not, because each strands another tile that was underfoot at its full
//   near-field complement out in the far field, and the stale counts ratchet
//   until the grow loop cannot find room for the disc ahead. Hence the thin in
//   each `_reseat`, and hence the teleport storm below.
//
//   A CUT THAT REFUSES TO COMPLETE. Grass alone will not cut a clump the rim
//   still has on screen; it dissolves it and leaves the tile's level where it
//   was. The rim's answer comes from the last sweep, and a jump both invalidates
//   it and -- feeding the jump distance into the rim's speed slack -- makes it
//   "everything is visible", so the cut frees nothing at all. Hence the `force`
//   flag on Grass._thin, and hence the storm running `place` on the hop frame:
//   `place` drains the queue unbudgeted and sweeps no rim at all, which is the
//   shape that actually crashed.
//
// Ferns have their own file (check-ferns.mjs) with the walk and the id audit.
// What is here is the storm, for the beds that carry a fix, and the arithmetic
// that says the other three do not need one.
//
// Trees and grass reproduce the throw: back out their _reseat thin and the
// storm below empties both pools within a few hundred frames. Rocks does not,
// and its row is a guard rather than a reproduction -- what puts the thin in
// RockBed._reseat is the second half of this file, where the embedded bed's
// stale-level demand lands ON its pool with nothing spare.
//
// The world is deliberately flat, unrejecting and pathless: every candidate
// stands, which is the WORST case for a pool and the only one the bound is
// written against. A real world only ever places fewer.

import * as THREE from 'three'

import { Trees } from '../src/v2/render/trees.js'
import { Grass } from '../src/v2/render/grass.js'
import { Rocks } from '../src/v2/render/rocks.js'
import { Ferns } from '../src/v2/render/ferns.js'
import { Litter } from '../src/v2/render/litter.js'
import { Deadwood, deadwoodBankFrom } from '../src/v2/render/deadwood.js'
import { Mushrooms } from '../src/v2/render/mushrooms.js'
import { buildTextureArray, LAYER_COUNT } from '../src/textures.js'
import { setPropClock } from '../src/material.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const GROUND = 60
const EYE = GROUND + 1.6
const field = {
  scatterAt: (x, z, cell, out) => { out.h = GROUND; out.tan = 0; return out },
  heightAndSlopeAt: () => ({ h: GROUND, tan: 0, gx: 0, gz: 0 }),
  heightAt: () => GROUND,
  snowLineAt: () => 9999,
  bands: { altLo: 0, altSpan: 900 },
}
const water = { isSubmerged: () => false, levelAt: () => null, shoreDistAt: (x, z, reach) => reach }
const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 }, paths: { nearest: () => null } }
const textures = buildTextureArray()
const noAnchors = { anchorsInto: () => 0 }
const deadwoodBank = deadwoodBankFrom({
  stump: readShippedLadder('stump-rotting'),
  log: readShippedLadder('log-fallen', { longAxisZ: true }),
})
const S = () => new THREE.Scene()

const MAKE = {
  ferns: () => new Ferns(S(), field, water, layers, textures, { seed: 7 }),
  trees: () => new Trees(S(), field, water, textures, { seed: 7 }),
  grass: () => new Grass(S(), field, water, layers.paths, textures, { seed: 7, style: 'tufts' }),
  rocks: () => new Rocks(S(), field, water, layers, textures, { seed: 7 }),
  litter: () => new Litter(S(), field, water, layers, textures, { seed: 7 }),
  deadwood: () => new Deadwood(S(), field, water, layers, { seed: 7, bank: deadwoodBank }),
  mushrooms: () => new Mushrooms(S(), field, water, layers, textures, [noAnchors], { seed: 7 }),
}

/** A Rocks is eight beds behind one façade; everything else is its own bed. */
const subBeds = (bed) => (bed.beds ? bed.beds : [bed])
const bedName = (b) => (b.cfg ? b.cfg.name : '')

// ---------------------------------------------------------------------------
console.log('\n1. a teleport storm never empties a pool\n')

// One frame per step. On a hop frame the camera is moved and `place` drains the
// queue unbudgeted, which is what v2/main.js does when the ground under the
// player moves; the frames between are ordinary budgeted updates.
const storm = (make, hop, every, steps = 400) => {
  const bed = make()
  bed.place(0, 0)
  let t = 0
  for (let i = 0; i < 120; i++) { t += 1 / 72; setPropClock(t); bed.update(0, EYE, 0) }

  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  let x = 0
  let z = 0
  let peak = 0
  let leaked = null
  for (let i = 0; i < steps; i++) {
    const hopNow = i % every === 0
    if (hopNow) {
      const a = rnd() * Math.PI * 2
      x += Math.cos(a) * hop
      z += Math.sin(a) * hop
    }
    t += 1 / 72
    setPropClock(t)
    try {
      if (hopNow) bed.place(x, z)
      else bed.update(x, EYE, z)
    } catch (err) {
      return { thrown: `${err.message} (step ${i})`, peak }
    }
    for (const b of subBeds(bed)) {
      peak = Math.max(peak, (b.maxInstances - b.freeCount) / b.maxInstances)
      // Every id handed out is either standing in a tile, held as the
      // duplicate of an LOD cross-dissolve in flight, or (trees) dissolving out
      // of a tile that changed mode. A path that drops a tile without releasing
      // it leaks ids past all three, and empties the pool over a long session
      // to throw exactly the same way a stale level does.
      let n = 0
      for (const tile of b.tiles.values()) n += tile.n
      let dups = 0
      for (const f of b.fades) if (f.dup !== undefined) dups++
      const retiring = b.retiring ? b.retiring.length : 0
      if (!leaked && (n !== b.placed || n + dups + retiring !== b.maxInstances - b.freeCount)) {
        leaked = `${bedName(b)} sum(tile.n)=${n} placed=${b.placed} fade dups=${dups} retiring=${retiring} used=${b.maxInstances - b.freeCount}`
      }
    }
  }
  return { peak, leaked }
}

// Hops from a quarter of the draw radius (most tiles survive, stale) to nine
// tenths of it, at the two cadences that matter: every 4 frames is where a
// backed-out fix empties the trees and the grass, and every 18 is a quarter
// second, long enough for the rim's dissolve to finish between jumps. Faster
// than 4 is safe by accident -- the camera outruns its own build budget, so a
// tile dies before it can go stale -- and is not worth the seconds it costs.
for (const name of ['trees', 'grass', 'rocks']) {
  const make = MAKE[name]
  const radius = Math.sqrt(Math.max(...subBeds(make()).map((b) => b.radiusSq)))
  let worst = 0
  let bad = null
  for (const every of [4, 18]) {
    for (const frac of [0.25, 0.5, 0.9]) {
      const r = storm(make, radius * frac, every)
      worst = Math.max(worst, r.peak)
      if (!bad && (r.thrown || r.leaked)) bad = `${(radius * frac).toFixed(0)} m every ${every} frames: ${r.thrown || r.leaked}`
    }
  }
  check(!bad, `${name}: teleports at every hop and cadence, and the pool holds`,
    bad || `worst bed peaked at ${(worst * 100).toFixed(0)}% of its pool`)
}

// ---------------------------------------------------------------------------
console.log('\n2. and the beds with no re-levelling thin have the margin to go without\n')

// What the pool would be asked for if the thinning were defeated again: hop the
// camera, keep every surviving tile at the level it was grown at, never thin.
// It is an upper bound on demand -- the real grow loop is budgeted and the tile
// loop's thin jobs run in between -- so a bed UNDER its pool here cannot reach
// the failure at all, whatever the camera does. Litter and mushrooms are under
// it by a quarter of their pool or more, deadwood -- whose grid reaches the
// longest log's card at 1.4 km -- by its own headroom's margin; this is what
// would catch a density, a falloff or a reach being raised past that.
const ratchet = (bed, perTileAt) => {
  // The tile pitch, recovered exactly: the evict radius is radius + 1.5 tiles.
  const T = (Math.sqrt(bed.evictSq) - Math.sqrt(bed.radiusSq)) / 1.5
  const span = bed.tileSpan
  const R = Math.sqrt(bed.radiusSq)
  const nearSq = (tx, tz, cx, cz) => {
    const nx = Math.max(tx * T, Math.min(cx, (tx + 1) * T))
    const nz = Math.max(tz * T, Math.min(cz, (tz + 1) * T))
    return (nx - cx) ** 2 + (nz - cz) ** 2
  }

  let peak = 0
  for (const stride of [T, T * 4, R * 0.25, R * 0.5, R, R * 1.4]) {
    for (const seed0 of [1, 7, 99]) {
      let seed = seed0
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
      const tiles = new Map()
      let x = T / 2
      let z = T / 2
      for (let h = 0; h < 300; h++) {
        if (h) {
          const a = rnd() * Math.PI * 2
          const d = stride * (0.3 + rnd())
          x += Math.cos(a) * d
          z += Math.sin(a) * d
        }
        const tx = Math.floor(x / T)
        const tz = Math.floor(z / T)
        for (const [key, tile] of tiles) {
          const dcx = (tile.tx + 0.5) * T - x
          const dcz = (tile.tz + 0.5) * T - z
          if (dcx * dcx + dcz * dcz > bed.evictSq) tiles.delete(key)
        }
        let total = 0
        for (let iz = -span; iz <= span; iz++) {
          for (let ix = -span; ix <= span; ix++) {
            const gx = tx + ix
            const gz = tz + iz
            const dcx = (gx + 0.5) * T - x
            const dcz = (gz + 0.5) * T - z
            if (dcx * dcx + dcz * dcz > bed.radiusSq) continue
            const key = gx * 0x10000 + gz
            if (!tiles.has(key)) tiles.set(key, { tx: gx, tz: gz, held: perTileAt(nearSq(gx, gz, x, z)) })
          }
        }
        for (const tile of tiles.values()) total += tile.held
        peak = Math.max(peak, total)
      }
    }
  }
  return peak
}

// Each bed's own _poolBound integrand, which is the thing being bounded.
const INTEGRAND = {
  litter: (b) => (d2) => (b.perTile + b.perTileWet) * b.uAt[b._levelFor(d2)],
  rock: (b) => (d2) => b.perTile * b._keepFrac(b._levelFor(d2)),
  deadwood: (b) => (d2) => b.perTile * b.keepAt[b._levelFor(d2)],
  plain: (b) => (d2) => b.perTile * b.uAt[b._levelFor(d2)],
}
const rows = []
for (const name of Object.keys(MAKE)) {
  const top = MAKE[name]()
  for (const b of subBeds(top)) {
    const integrand = (INTEGRAND[name] || (b.cfg ? INTEGRAND.rock : INTEGRAND.plain))(b)
    const peak = ratchet(b, integrand)
    rows.push({ name: b.cfg ? `${name}/${bedName(b)}` : name, peak, max: b.maxInstances })
  }
}
rows.sort((a, b) => b.peak / b.max - a.peak / a.max)
for (const r of rows) {
  console.log(`       ${r.name.padEnd(18)} ${String(Math.ceil(r.peak)).padStart(6)} of ${String(r.max).padStart(6)}` +
    ` (${((r.peak / r.max) * 100).toFixed(0).padStart(3)}%)`)
}
console.log()

// Only the three that carry no re-levelling thin are asserted. The rest are
// over their pools on this bound, which is WHY they carry one, and a change
// that drops one of them under it is not a failure -- it is one less thing
// depending on the fix. What is a failure is one of these three crossing up
// into the same exposure without the defence.
for (const name of ['litter', 'deadwood', 'mushrooms']) {
  const r = rows.find((row) => row.name === name)
  check(r.peak < r.max,
    `${name}: even with every survivor left at the level it was grown at, the pool holds`,
    `${Math.ceil(r.peak)} of ${r.max} (${((r.peak / r.max) * 100).toFixed(0)}%)`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all scatter pool checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
