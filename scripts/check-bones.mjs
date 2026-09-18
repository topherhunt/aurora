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
  Bones, RUNGS, SKELETON_LENGTH, SKELETON_LENGTH_CAP, SKULL_SIZE, bonesBankFrom,
} from '../src/v2/render/bones.js'
import { GEN_PROP_LODS, PROP_MESH_TIERS, PROP_STEPS, propCull, propReach } from '../src/v2/render/gen-props.js'
import { LOD_DEG, LOD_HYSTERESIS, distAt, ladderTier } from '../src/v2/render/critters.js'
import { readShippedLadder } from './lib/gen-prop-node.mjs'
import { taken } from '../src/v2/taken.js'

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
  check(bank.tiers.length === PROP_MESH_TIERS.length + 1 && RUNGS === bank.tiers.length && PROP_MESH_TIERS[0] === 0,
    'the pick, the drawn decimated tier and the card, one rung each',
    `shipped tiers ${PROP_MESH_TIERS.join('/')} of ${GEN_PROP_LODS + 1} and the card: ${bank.tiers.length} tiers, ${RUNGS} rungs`)
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

  // The card must cover the find it stands in for at the swap. The skull's is
  // one quad in its XY plane, spun to her in the shader, so its width has to
  // cover the skull's widest side; the skeleton's is two quads, its length
  // upright and laid flat, both through its own Z axis.
  const tooSmall = []
  const shape = []
  const cardTier = bank.tiers[bank.tiers.length - 1]
  bank.variants.forEach((v, i) => {
    const card = cardTier.geometries[i]
    card.computeBoundingBox()
    const b = card.boundingBox
    const pb = bank.bounds[i]
    const quads = card.index.count / 6
    const wide = v.kind === 'skeleton' ? b.max.z - b.min.z : b.max.x - b.min.x
    if (wide < Math.max(pb.width, pb.long) - 1e-3 || b.max.y - b.min.y < pb.height - 1e-3) tooSmall.push(v.name)
    const flat = Math.abs(b.max.z - b.min.z) < 1e-6
    const crossed = b.max.x - b.min.x > pb.height - 1e-3 && b.max.z - b.min.z > pb.long - 1e-3
    if (!(v.kind === 'skeleton' ? quads === 2 && crossed : quads === 1 && flat)) shape.push(`${v.name}: ${quads} quads`)
  })
  check(tooSmall.length === 0, 'and the card is at least as big as the find it replaces',
    tooSmall.length === 0 ? 'both cards cover their pick' : tooSmall.join(', '))
  check(shape.length === 0, 'the skull\'s card is one quad to spin and the skeleton\'s is its length crossed about its axis',
    shape.length === 0 ? 'one flat quad; two quads spanning the length upright and flat' : shape.join('; '))
  for (const t of bank.tiers) for (const g of t.geometries) g.dispose()

  // Distance is measured from the instance origin at the middle of the find,
  // so a player touching an end of a find of ladder size L is L/2 out. Per
  // metre that is 0.5 whatever the size, so one comparison settles the bank.
  check(propReach(1, 0) > 0.5, 'and a find is on its finest mesh when the player is touching its end',
    `T0 holds to ${propReach(1, 0).toFixed(2)}x the ladder size against an end at 0.5x`)
  // The mesh gives way to the card at half the first rung's arc, the card holds
  // to the animals' card reach, and past it the find is culled (check-deadwood).
  const cardArc = 2 * Math.atan(1 / (2 * propReach(1, RUNGS - 2))) * 180 / Math.PI
  check(Math.abs(cardArc - LOD_DEG / 2) < 0.05 && PROP_STEPS[RUNGS - 1] === 16 && propCull(1) === propReach(1, RUNGS - 1),
    'the mesh holds to half the first rung\'s arc, the card to the animals\' card reach, and the cull is the card\'s edge',
    `per metre: ${Array.from({ length: RUNGS }, (_, k) => propReach(1, k).toFixed(1)).join(' / ')} m; the card takes over at ${cardArc.toFixed(2)} deg`)
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
  // One program across the mesh variants (gen-props.js keys it on the card
  // flags alone), so the arena's calls switch material, not program.
  const meshKeys = new Set(b.meshMaterials.map((m) => m.customProgramCacheKey()))
  const cardKeys = new Set(b.cardMaterials.map((m) => m.customProgramCacheKey()))
  check(meshKeys.size === 1 && cardKeys.size === 2 && ![...cardKeys].some((k) => meshKeys.has(k)),
    'its mesh variants share one program and its two cards are two', `${[...meshKeys].join(', ')}; ${[...cardKeys].join(', ')}`)
  check(Math.abs(b.radius - propCull(Math.max(SKELETON_LENGTH_CAP, SKULL_SIZE[1]))) < 1e-6 && b.radius > 500,
    'the grid reaches the biggest find the scatter can place at its cull',
    `${b.radius.toFixed(0)} m, ${b.tiles.size} tiles`)
  let culls = 0
  let cullWrong = 0
  for (const tile of b.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      culls++
      if (Math.abs(b.rim.gone[id] - Math.min(b.radius, propCull(b.instSize[id]))) > 1e-3) cullWrong++
    }
  }
  check(culls > 20 && cullWrong === 0, 'every find is culled at its own size\'s range',
    `${culls} finds, a 3 m skull at ${propCull(3).toFixed(0)} m and a 10 m skeleton at ${propCull(10).toFixed(0)}`)
  const wrong = []
  let seen = 0
  let unlit = 0
  // Her eye over the field's ground at 40: a walk at 1.6 there is 38 m under
  // it, and no find is ever within its mesh band of that.
  const EYE = 41.6
  for (const [cx, cz] of [[0, 0], [30, 12], [-45, 60], [70, -20], [-10, -80]]) {
    b.update(cx, EYE, cz)
    b.update(cx, EYE, cz)
    for (const tile of b.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        if (b.rim.isHidden(id)) { unlit++; continue }
        const size = b.instSize[id]
        const tier = b.tierAt[id]
        const d = Math.hypot(b.instX[id] - cx, b.instY[id] - EYE, b.instZ[id] - cz)
        seen++
        // The rung its own size wants at this distance with no rung held,
        // pushed out by the hysteresis a held rung is allowed. One-sided: too
        // coarse for how big the thing looks is the artefact.
        const want = Math.min(b.cardTier, ladderTier(distAt(size, LOD_DEG), PROP_STEPS, RUNGS, d / (1 - LOD_HYSTERESIS), -1))
        if (tier > want) wrong.push(`${b.bank.variants[b.variantAt[id]].name} ${size.toFixed(1)} m at ${d.toFixed(1)} m on T${tier}, wants T${want}`)
      }
    }
  }
  check(seen >= 8, 'walked enough placed finds to measure a ladder', `${seen} instance-frames, ${unlit} more the rim was not drawing`)
  check(wrong.length === 0, 'no find is coarser than its own apparent size allows',
    wrong.length === 0 ? `rungs at ${Array.from({ length: RUNGS - 1 }, (_, k) => propReach(1, k).toFixed(1)).join('/')} m per metre of ladder size`
      : `${wrong.length} too coarse: ${wrong.slice(0, 3).join('; ')}`)
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

  // Walk away and back: far enough that every tile leaves the eviction ring,
  // so what came back was released and regrown, not held.
  const before = keyOf(a)
  a.update(2000, 1.6, 2000)
  check(a.placed <= a.maxInstances && a.stats.used === a.placed, 'walking away returns the evicted finds to the pool', `${a.placed} resident, ${a.stats.used} used of ${a.maxInstances}`)
  a.update(0, 1.6, 0)
  check(keyOf(a) === before, 'and walking back finds them where they were')
  a.dispose(); b.dispose(); c.dispose()
}

// --- her hands --------------------------------------------------------------
{
  console.log('\nher hands')
  taken.clear()
  const keyOf = (s) => [...s.tiles.values()].flatMap((t) => Array.from(t.ids.subarray(0, t.n), (id) =>
    `${s.variantAt[id]}@${s.instX[id].toFixed(3)},${s.instZ[id].toFixed(3)}`)).sort().join('|')
  // Placed and swept from over the first skull, or from (x, z), so it is shown.
  const skullOf = (b) => [...b.tiles.values()].find((t) => t.n && !b.isSkeleton[b.variantAt[t.ids[0]]])
  const grow = (x = null, z = null) => {
    const b = place(flatField(40), DRY, 3)
    const t = skullOf(b)
    b.update(x ?? b.instX[t.ids[0]], 41.6, z ?? b.instZ[t.ids[0]])
    return b
  }
  const b = grow()
  check(b.kinds.length === 2 && b.kinds.includes('skull') && b.kinds.includes('skeleton'), 'the kinds a hand takes are the variants', b.kinds.join(' '))
  const tile = skullOf(b)
  const id = tile.ids[0]
  const v = b.variantAt[id]
  const span = b.instSize[id]
  const x = b.instX[id], z = b.instZ[id]
  const mid = b.instY[id] + (b.vHeight[v] * span / b.vLod[v]) * 0.5
  check(!b.rim.isHidden(id) && span < 2, 'a skull under two metres is shown', `${span.toFixed(2)} m`)
  const hit = b.pickAt(x, mid, z, 0.1, 2)
  check(hit !== null && hit.tile === tile && hit.id === id && hit.dist === 0 && hit.size === span, 'pickAt at its middle hits it, its size its longest axis')
  check(b.pickAt(x, mid + 5, z, 0.1, 2) === null, 'and nothing five metres above it')
  check(b.pickAt(x, mid, z, 0.1, span) === null, 'nor one at or over maxSize')
  const skel = [...b.tiles.values()].find((t) => t.n && b.isSkeleton[b.variantAt[t.ids[0]]])
  const sid = skel.ids[0]
  check(b.instSize[sid] >= 2 && b.pickAt(b.instX[sid], b.instY[sid], b.instZ[sid], 100, 2) === null, 'a skeleton is metres long and never offered under the two-metre cap', `${b.instSize[sid].toFixed(2)} m`)
  const placedWere = b.placed, usedWere = b.stats.used
  const c = b.batch.getColorAt(id, new THREE.Color()).getHex()
  const rec = b.take(hit, 1)
  check(rec.kind === 'skull' && rec.name === 'elk skull' && rec.size === span && rec.geometry === b.bank.tiers[0].geometries[v] && rec.material === b.meshMaterials[v] && rec.stowable === (span < 1), 'take: the skull on its pick and its material, stowable under a metre')
  check(Math.abs(rec.scale[0] - span / b.vLod[v]) < 1e-6 && rec.scale[1] === rec.scale[0] && rec.scale[2] === rec.scale[0] && new THREE.Color().setRGB(...rec.color).getHex() === c, 'scaled by its size over the pick, in the ground\'s tint', JSON.stringify(rec.scale))
  check(tile.n === 0 && b.placed === placedWere - 1 && b.stats.used === usedWere - 1 && !b.batch.getVisibleAt(id) && b.tierAt[id] === -1, 'the tile is empty and the instance back in the pool')
  check(taken.has('skull', x, z), 'its spot is recorded')
  check(b.pickAt(x, mid, z, 0.1, 2)?.id !== id, 'and it cannot be taken twice')
  let threw = false
  try { b.take(hit, 1) } catch { threw = true }
  check(threw, 'taking it twice throws')
  const d = b.dress({ kind: 'skull' })
  check(d.geometry === rec.geometry && d.material === rec.material, 'dress: the skull\'s pick and material')
  const ds = b.dress({ kind: 'skeleton' })
  check(ds.geometry === b.bank.tiers[0].geometries[1 - v] && ds.material === b.meshMaterials[1 - v], 'and the skeleton\'s for a skeleton')
  threw = false
  try { b.dress({ kind: 'fern' }) } catch { threw = true }
  check(threw, 'dress throws on another kind')
  b.update(x, 41.6, z)
  check(b.placed === placedWere - 1 && b.stats.used === placedWere - 1, 'a frame later the empty tile is swept without harm')
  const again = grow(x, z)
  check(again.placed === placedWere - 1 && keyOf(again) === keyOf(b), 'placed again the tile lies empty and nothing else moved', `${again.placed} finds`)
  taken.clear()
  const whole = grow(x, z)
  check(whole.placed === placedWere && keyOf(whole) !== keyOf(b), 'and with the registry cleared the skull is back')
  b.dispose(); again.dispose(); whole.dispose()
}

console.log(failures ? `\n${failures} bones check(s) FAILED` : '\nall bones checks passed')
process.exit(failures ? 1 : 0)
