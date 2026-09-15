// Node-side gates for the bones scatter (src/v2/render/bones.js): the deer
// skeleton and the elk skull shipped in public/gen-props/, placed rare on any
// ground.
//
//   node scripts/check-bones.mjs
//
// What can go wrong without throwing: a size band that reads its own constant
// and so agrees with itself whatever it does; a skeleton that stays deer-sized
// on a lakebed or above the snowline, where the band was meant to open; a
// skeleton seated on its midpoint with an end in the air; a tier chosen against
// the wrong size; a scatter that is common rather than rare, or that lays the
// bones on a lattice; and a placement that moves between two visits.

import * as THREE from 'three'
import {
  Bones, LOD_AT, SKELETON_LENGTH, SKELETON_LENGTH_CAP, SKULL_SIZE, bonesBankFrom,
} from '../src/v2/render/bones.js'
import { GEN_PROP_LODS } from '../src/v2/render/gen-props.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

/** The shipped bank, fresh: the scatter takes its geometries by reference and disposes them. */
const shippedBank = () => bonesBankFrom({
  skeleton: readShippedLadder('skeleton-deer', { longAxisZ: true }),
  skull: readShippedLadder('skull-elk'),
})

const DRY = { isSubmerged: () => false }
const WET = { isSubmerged: () => true }
const LAYERS = { paths: { nearest: () => null }, snow: { base: 900, band: 40 }, flattenAt: () => 0 }
const flatField = (h, snowLine = 900) => ({
  heightAt: () => h,
  heightAndSlopeAt: () => ({ h, tan: 0 }),
  snowLineAt: () => snowLine,
  bands: { altLo: 0, altSpan: 100 },
})
const place = (field, water, seed = 5) => {
  const b = new Bones(new THREE.Scene(), field, water, LAYERS, { seed, bank: shippedBank() })
  b.place(0, 0)
  return b
}
/** Every placed instance's world size along the axis its band measures, by kind. */
const sizesOf = (b) => {
  const m = new THREE.Matrix4()
  const s = new THREE.Vector3()
  const out = { skeleton: [], skull: [] }
  for (const tile of b.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const v = b.variantAt[id]
      b.batch.getMatrixAt(id, m)
      m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s)
      if (b.isSkeleton[v]) out.skeleton.push(b.vLong[v] * s.x)
      else out.skull.push(b.vLod[v] * s.x)
    }
  }
  return out
}
const range = (a) => `${Math.min(...a).toFixed(2)}-${Math.max(...a).toFixed(2)} m`

// --- the bank ---------------------------------------------------------------
{
  console.log('\nthe shipped bank is built for the scatter that indexes it')
  const bank = shippedBank()
  const lens = bank.tiers.map((t) => t.geometries.length)
  check(bank.tiers.length === GEN_PROP_LODS + 2, 'the pick, its decimated tiers and the cross card', `${bank.tiers.length} tiers`)
  check(lens.every((n) => n === 2) && bank.variants.length === 2,
    'every tier carries one geometry per variant slot', `skeleton + skull, tiers ${lens.join('/')}`)
  const tris = bank.tiers.map((t) => t.geometries.map((g) => g.index.count / 3))
  check(bank.variants.every((_v, i) => tris.slice(0, -1).every((t, k) => k === 0 || t[i] < tris[k - 1][i])),
    'and each mesh tier is coarser than the one before it',
    bank.variants.map((v, i) => `${v.name} ${tris.slice(0, -1).map((t) => t[i]).join('/')}`).join(', '))
  const unmeasured = bank.variants.filter((v) => !(v.long > 0 && v.width > 0 && v.height > 0 && v.lodSize > 0))
  check(unmeasured.length === 0, 'every variant carries the metres the scatter seats it by',
    unmeasured.length === 0
      ? bank.variants.map((v) => `${v.name} ${v.long.toFixed(2)} long, ${v.width.toFixed(2)} wide, ${v.height.toFixed(2)} high`).join('; ')
      : unmeasured.map((v) => v.name).join(', '))
  const skeleton = bank.variants.find((v) => v.kind === 'skeleton')
  check(skeleton && skeleton.long >= skeleton.width && skeleton.long > skeleton.height,
    'the skeleton lies along its own Z', skeleton ? `${skeleton.long.toFixed(2)} long, ${skeleton.width.toFixed(2)} wide, ${skeleton.height.toFixed(2)} high` : 'no skeleton')

  const tooSmall = []
  const cardTier = bank.tiers[bank.tiers.length - 1]
  bank.variants.forEach((v, i) => {
    const card = cardTier.geometries[i]
    card.computeBoundingBox()
    const b = card.boundingBox
    const pb = bank.bounds[i]
    const wide = Math.max(b.max.x - b.min.x, b.max.z - b.min.z)
    if (wide < Math.max(pb.width, pb.long) - 1e-3 || b.max.y - b.min.y < pb.height - 1e-3) tooSmall.push(v.name)
  })
  check(tooSmall.length === 0, 'and the cross card is at least as big as the piece it replaces',
    tooSmall.length === 0 ? 'both cards cover their pick' : tooSmall.join(', '))
  for (const t of bank.tiers) for (const g of t.geometries) g.dispose()

  check(LOD_AT.length === GEN_PROP_LODS + 1 && LOD_AT.every((k, i) => k > 0 && (i === 0 || k > LOD_AT[i - 1])),
    'the LOD thresholds ascend and there is one per mesh tier', `${LOD_AT.join(' / ')} m per metre`)
  check(LOD_AT[0] > 0.5, 'and a find is on its finest mesh when the player is touching its end',
    `T0 holds to ${LOD_AT[0]}x the ladder size against an end at 0.5x`)
}

// --- the sizes --------------------------------------------------------------
//
// Measured off the placed matrices against the exported bands, not against the
// scatter's own arithmetic. Then the same seed on a drowned world and on one
// whose snowline is below the ground: the skeletons alone grow, to the cap.
{
  console.log('\nit comes out the size it was asked for, and bigger where it drowned or froze')
  const dry = place(flatField(40), DRY)
  const sz = sizesOf(dry)
  check(sz.skeleton.length >= 3 && sz.skull.length >= 3, 'placed both kinds to measure',
    `${sz.skeleton.length} skeletons, ${sz.skull.length} skulls over ${dry.tiles.size} tiles`)
  const inBand = (a, lo, hi) => a.every((s) => s >= lo - 1e-3 && s <= hi + 1e-3)
  check(inBand(sz.skeleton, SKELETON_LENGTH[0], SKELETON_LENGTH[1]),
    'every skeleton on dry ground lands inside its band by length', `${range(sz.skeleton)} against ${SKELETON_LENGTH.join('-')} m`)
  check(inBand(sz.skull, SKULL_SIZE[0], SKULL_SIZE[1]),
    'every skull lands inside its band by longest axis', `${range(sz.skull)} against ${SKULL_SIZE.join('-')} m`)
  check(new Set(sz.skeleton.map((s) => s.toFixed(2))).size > 1 && new Set(sz.skull.map((s) => s.toFixed(2))).size > 1,
    'and the sizes vary rather than sitting at one value')

  const wet = place(flatField(40), WET)
  const wsz = sizesOf(wet)
  const high = place(flatField(40, 30), DRY)
  const hsz = sizesOf(high)
  for (const [name, w] of [['under water', wsz], ['above the snowline', hsz]]) {
    check(w.skeleton.length === sz.skeleton.length && w.skull.length === sz.skull.length,
      `${name} the same finds are placed`, `${w.skeleton.length} skeletons, ${w.skull.length} skulls`)
    check(inBand(w.skeleton, SKELETON_LENGTH[0], SKELETON_LENGTH_CAP) && Math.max(...w.skeleton) > SKELETON_LENGTH[1],
      `and the skeletons run past ${SKELETON_LENGTH[1]} m to the cap`, `${range(w.skeleton)} against ${SKELETON_LENGTH[0]}-${SKELETON_LENGTH_CAP} m`)
    check(w.skeleton.every((s, i) => s >= sz.skeleton[i] - 1e-3), 'every one of them at least its dry size')
    check(w.skull.every((s, i) => Math.abs(s - sz.skull[i]) < 1e-3), 'and the skulls are exactly their dry size')
  }
  dry.dispose(); wet.dispose(); high.dispose()
}

// --- the seat ---------------------------------------------------------------
//
// A skeleton probed at nine points along its spine at local y = 0, a skull at
// eight round its rim, on flat ground, two slopes and a ridge: no daylight.
{
  console.log('\nnothing lies with a gap under it')
  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  const floating = []
  let sampled = 0
  const GAP_TOL = 0.03
  const MAX_TAN = Math.tan((30 * Math.PI) / 180)
  const GROUNDS = [
    { name: 'flat', h: () => 60, tan: () => 0 },
    { name: '1 in 5', h: (x) => 60 + x * 0.2, tan: () => 0.2 },
    { name: '30 degrees', h: (x) => 60 + x * MAX_TAN, tan: () => MAX_TAN },
    { name: 'ridge', h: (x) => 60 + 3 * Math.sin(x * 0.15), tan: (x) => Math.abs(0.45 * Math.cos(x * 0.15)) },
  ]
  for (const g of GROUNDS) {
    const field = {
      heightAt: (x) => g.h(x),
      heightAndSlopeAt: (x) => ({ h: g.h(x), tan: g.tan(x) }),
      snowLineAt: () => 900,
      bands: { altLo: 0, altSpan: 100 },
    }
    const b = place(field, DRY, 7)
    if (b.placed === 0) floating.push(`${g.name}: nothing placed at all`)
    for (const tile of b.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const vi = b.variantAt[id]
        b.batch.getMatrixAt(id, m)
        const probes = []
        if (b.isSkeleton[vi]) {
          for (let s = -1; s <= 1.0001; s += 0.25) probes.push([0, s * b.vLong[vi] * 0.5])
        } else {
          const r = Math.max(b.vWidth[vi], b.vLong[vi]) * 0.5
          const d = r * Math.SQRT1_2
          probes.push([r, 0], [-r, 0], [0, r], [0, -r], [d, d], [d, -d], [-d, d], [-d, -d])
        }
        for (const [ox, oz] of probes) {
          v.set(ox, 0, oz).applyMatrix4(m)
          sampled++
          const gap = v.y - g.h(v.x)
          if (gap > GAP_TOL) floating.push(`${g.name} ${b.bank.variants[vi].name}: ${(gap * 100).toFixed(1)} cm of daylight`)
        }
      }
    }
    b.dispose()
  }
  check(sampled > 0, 'found finds to probe at all', `${sampled} contact points over four grounds`)
  check(floating.length === 0, 'every skeleton and skull meets the ground it was seated on',
    floating.length === 0 ? 'flush or embedded at every contact point, flat to 30 degrees and over a ridge'
      : `${floating.length} floating: ${floating.slice(0, 4).join('; ')}`)
}

// --- the ladder -------------------------------------------------------------
{
  console.log('\nit steps down its ladder at the same apparent size')
  const b = place(flatField(40), DRY, 23)
  const wrong = []
  let seen = 0
  let unlit = 0
  for (const [cx, cz] of [[0, 0], [30, 12], [-45, 60], [70, -20], [-10, -80]]) {
    b.update(cx, 1.6, cz)
    b.update(cx, 1.6, cz)
    for (const tile of b.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (b.rim.isHidden(id)) { unlit++; continue }
        const size = b.instSize[id]
        const tier = b.tierAt[id]
        const d = Math.hypot(b.instX[id] - cx, b.instY[id] - 1.6, b.instZ[id] - cz)
        seen++
        let want = LOD_AT.length
        for (let t = 0; t < LOD_AT.length; t++) if (d < size * LOD_AT[t]) { want = t; break }
        if (tier > want) wrong.push(`${b.bank.variants[b.variantAt[id]].name} ${size.toFixed(1)} m at ${d.toFixed(1)} m on T${tier}, wants T${want}`)
      }
    }
  }
  check(seen >= 8, 'walked enough placed finds to measure a ladder', `${seen} instance-frames, ${unlit} more the rim was not drawing`)
  check(wrong.length === 0, 'no find is coarser than its own apparent size allows',
    wrong.length === 0 ? `thresholds ${LOD_AT.join('/')} m per metre of ladder size` : `${wrong.length} too coarse: ${wrong.slice(0, 3).join('; ')}`)
  check(b.tris > 0, 'and the frame counts the triangles it draws', `${b.tris} on the last vantage`)
  b.dispose()
}

// --- rarity and determinism -------------------------------------------------
{
  console.log('\nit is rare, off the lattice, and the same world every time')
  const a = place(flatField(40), DRY, 3)
  const perTile = a.placed / a.tiles.size
  check(a.placed >= 4 && perTile < 0.5, 'a find in well under half the tiles',
    `${a.placed} over ${a.tiles.size} tiles (${(perTile * 100).toFixed(0)}%)`)
  const inDisc = [...a.tiles.values()].reduce((n, t) => {
    for (let k = 0; k < t.n; k++) if (Math.hypot(a.instX[t.ids[k]], a.instZ[t.ids[k]]) <= 100) n++
    return n
  }, 0)
  check(inDisc >= 3 && inDisc <= 25, 'and a dozen or so inside a hundred metres', `${inDisc}`)
  // Off the lattice: the fractional tile position varies from find to find.
  const fracs = new Set()
  for (const t of a.tiles.values()) for (let k = 0; k < t.n; k++) fracs.add((a.instX[t.ids[k]] / 40 % 1).toFixed(2))
  check(fracs.size > Math.min(3, a.placed - 1), 'not one position inside its tile', `${fracs.size} distinct offsets`)

  const b = place(flatField(40), DRY, 3)
  const keyOf = (s) => [...s.tiles.values()].flatMap((t) => Array.from(t.ids.subarray(0, t.n), (id) =>
    `${s.variantAt[id]}@${s.instX[id].toFixed(3)},${s.instY[id].toFixed(3)},${s.instZ[id].toFixed(3)}:${s.instSize[id].toFixed(3)}`)).sort().join('|')
  check(keyOf(a) === keyOf(b), 'the same seed places the same finds', `${b.placed} finds`)
  const c = place(flatField(40), DRY, 4)
  check(keyOf(a) !== keyOf(c), 'and another seed places others')

  // Walk away and back: what left the disc is released, what came back is the same.
  const before = keyOf(a)
  a.update(500, 1.6, 500)
  check(a.placed <= a.maxInstances && a.stats.used === a.placed, 'walking away returns the evicted finds to the pool', `${a.placed} resident, ${a.stats.used} used of ${a.maxInstances}`)
  a.update(0, 1.6, 0)
  check(keyOf(a) === before, 'and walking back finds them where they were')
  a.dispose(); b.dispose(); c.dispose()
}

console.log(failures ? `\n${failures} bones check(s) FAILED` : '\nall bones checks passed')
process.exit(failures ? 1 : 0)
