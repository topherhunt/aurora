// Node-side gates for the carrot scatter (src/v2/render/carrots.js): the
// shipped Tripo root under a code-built rosette, bunched on open ground.
//
//   node scripts/check-carrots.mjs
//
// What can go wrong without throwing: a root merged with its shoulder in the
// air or its crown off the atlas half it should sample; a bunch wider than the
// brief, or a member standing plumb or leaning INTO the bunch; a shoulder
// buried or poking a hand out; a carrot grown out of a rock;
// and a placement that moves between two visits.

import * as THREE from 'three'
import path from 'node:path'
import { CARROT_TUNING, Carrots, carrotsBankFrom } from '../src/v2/render/carrots.js'
import { propCull } from '../src/v2/render/gen-props.js'
import { taken } from '../src/v2/taken.js'
import { GEN_PROPS_DIR, readShippedAsset } from './lib/gen-prop-node.mjs'

const T = CARROT_TUNING
let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

const bank = () => {
  const b = carrotsBankFrom(readShippedAsset(path.join(GEN_PROPS_DIR, 'carrot.glb')))
  b.map = new THREE.Texture()
  return b
}
const DRY = { isSubmerged: () => false }
const LAYERS = { paths: { nearest: () => null }, snow: { base: 900, band: 40 }, flattenAt: () => 0 }
const flatField = (h) => ({
  heightAndSlopeAt: () => ({ h, tan: 0 }),
  snowLineAt: () => 900,
  bands: { altLo: 0, altSpan: 100 },
})
const NO_ROCKS = { blockTopAt: () => -Infinity }
const place = (rocks = NO_ROCKS, seed = 5) => {
  const c = new Carrots(new THREE.Scene(), flatField(100), DRY, LAYERS, rocks, { seed, bank: bank() })
  c.place(0, 0)
  return c
}
/** Every planted carrot: position, scale, its up vector in the world, and the clump it belongs to. */
const plantsOf = (c) => {
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const out = []
  for (const tile of c.tiles.values()) {
    const clump = []
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      c.batch.getMatrixAt(id, m)
      m.decompose(p, q, s)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
      clump.push({ id, x: p.x, y: p.y, z: p.z, scale: s.x, up, tile })
    }
    for (const pl of clump) pl.clump = clump
    out.push(...clump)
  }
  return out
}

console.log('carrots: the bank')
{
  const b = bank()
  const geo = b.tiers[0].geometries[0]
  const pos = geo.getAttribute('position')
  const uv = geo.getAttribute('uv')
  // The root is the first `rootTris` triangles' vertices: the merge keeps the order.
  const rootVerts = new Set()
  for (let i = 0; i < b.rootTris * 3; i++) rootVerts.add(geo.index.getX(i))
  let rootTop = -Infinity, rootBottom = Infinity, rootUvOk = true, leafUvOk = true, leafBottom = Infinity
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), u = uv.getX(i)
    if (rootVerts.has(i)) {
      if (y > rootTop) rootTop = y
      if (y < rootBottom) rootBottom = y
      if (u < 0 || u > 0.5) rootUvOk = false
    } else {
      if (y < leafBottom) leafBottom = y
      if (u < 0.5 || u > 1) leafUvOk = false
    }
  }
  const shoulder = T.ROOT_HEIGHT * T.CROWN_DROP
  check(Math.abs(rootTop - shoulder) < 1e-3, 'the shoulder is CROWN_DROP of the root above the crown', `${rootTop.toFixed(4)} vs ${shoulder}`)
  check(Math.abs(rootBottom + T.ROOT_HEIGHT * (1 - T.CROWN_DROP)) < 1e-3, 'the root tip is ROOT_HEIGHT below the shoulder', rootBottom.toFixed(4))
  check(leafBottom > -0.01, 'the leaves sprout at the crown', leafBottom.toFixed(4))
  check(rootUvOk && leafUvOk, 'the root samples the left half of the atlas and the leaves the right')
  check(b.tiers[0].geometries.length === 3 && b.size > 0.3 && b.size < 0.7, 'three variants, each ~half a metre of leaves', `${b.tiers[0].geometries.length} at ${b.size.toFixed(3)} m`)
}

console.log('carrots: the bunch')
{
  const c = place()
  const plants = plantsOf(c)
  const sizes = [...c.tiles.values()].map((t) => t.n).filter((n) => n > 0)
  check(plants.length > 40, 'a flat world grows bunches', `${plants.length} carrots in ${c.clumps} clumps over ${c.tiles.size} tiles`)
  check(sizes.every((n) => n >= T.CLUMP_MIN && n <= T.CLUMP_MAX) && sizes.some((n) => n === 1) && sizes.some((n) => n >= 4),
    'clumps run one to five, singles and big bunches both seen', sizes.join(' '))
  const kept = c.tiles.size ? c.clumps / c.tiles.size : 0
  check(kept > T.KEEP * 0.7 && kept < T.KEEP * 1.3, 'about KEEP of the tiles hold a bunch', kept.toFixed(2))

  let spreadOk = true, leanOk = true, outwardOk = true, plumb = 0, pokeOk = true, scaleOk = true
  const maxLean = T.CLUMP_LEAN + T.TILT_JITTER + 1e-6
  for (const p of plants) {
    const cl = p.clump
    const cx = cl.reduce((s, q) => s + q.x, 0) / cl.length
    const cz = cl.reduce((s, q) => s + q.z, 0) / cl.length
    const out = Math.hypot(p.x - cx, p.z - cz)
    if (out > T.CLUMP_RADIUS[1] + 1e-6) spreadOk = false
    const lean = Math.acos(Math.min(1, p.up.y))
    if (lean > maxLean) leanOk = false
    if (lean < 1e-4) plumb++
    // The outermost member of a bunch leans away from its centre: its horizontal
    // tilt has a positive component along the outward vector.
    if (cl.length > 1 && out > T.CLUMP_RADIUS[0] * 0.9) {
      const dot = (p.up.x * (p.x - cx) + p.up.z * (p.z - cz)) / out
      if (dot < 0) outwardOk = false
    }
    const poke = p.y + T.ROOT_HEIGHT * T.CROWN_DROP * p.scale - 100
    if (poke < T.POKE[0] - 1e-6 || poke > T.POKE[1] + 1e-6) pokeOk = false
    if (p.scale < T.SIZE_JITTER[0] || p.scale > T.SIZE_JITTER[1]) scaleOk = false
  }
  check(spreadOk, 'every member stands within CLUMP_RADIUS of its bunch')
  check(leanOk && plumb === 0, 'every carrot leans, none past CLUMP_LEAN + TILT_JITTER', `${plumb} plumb`)
  check(outwardOk, 'the outer members of a bunch lean away from its centre')
  check(pokeOk, 'the shoulder shows POKE metres of orange above the ground')
  check(scaleOk, 'scales inside SIZE_JITTER')
  check(plants.every((p) => Math.abs(c.rim.gone[p.id] - propCull(c.size * p.scale)) < 1e-4), 'each carrot is culled at its own size on the props\' ladder')

  const again = plantsOf(place())
  const same = again.length === plants.length && again.every((p, i) => Math.abs(p.x - plants[i].x) < 1e-6 && Math.abs(p.z - plants[i].z) < 1e-6 && Math.abs(p.up.y - plants[i].up.y) < 1e-6)
  check(same, 'a second visit grows the same bunches')
  check(c.tris === 0, 'nothing is drawn before the first update', `${c.tris}`)
  c.update(0, 101.6, 0)
  const drawn = plants.length - c.rim.hiddenCount
  check(c.tris === plantsOf(c).filter((p) => !c.rim.isHidden(p.id)).reduce((s, p) => s + c.variantTris[c.variantAt[p.id]], 0), 'the triangle count is the drawn carrots\' own', `${drawn} drawn, ${c.tris} tris`)
}

console.log('carrots: the neighbours')
{
  // Stone over the whole east half: no carrot grows out of it.
  const slab = { blockTopAt: (x) => (x > 0 ? 100.5 : -Infinity) }
  const d = place(slab)
  const onStone = plantsOf(d).filter((p) => p.x > 0)
  check(onStone.length === 0 && d.rejected.rock > 0, 'no carrot grows out of a rock', `${d.rejected.rock} rejected`)
}

console.log('carrots: her hand')
{
  // A carrot pulled: out of the bed, on the registry, the record for the hand, the bed grown again without it.
  taken.clear()
  const c = place()
  c.update(0, 101.6, 0)
  const plants = plantsOf(c)
  const pl = plants.find((p) => !c.rim.isHidden(p.id))
  const size = c.size * pl.scale
  const hit = c.pickAt(pl.x, pl.y + size * 0.5, pl.z, 0.1)
  check(hit !== null && hit.id === pl.id && hit.tile === pl.tile && hit.size === size && hit.dist === 0, 'pickAt finds the carrot about the hand', hit ? `id ${hit.id} ${hit.dist.toFixed(3)} m` : 'null')
  check(c.pickAt(pl.x, pl.y + size + 5, pl.z, 0.1) === null, 'and nothing five metres above it')
  const before = c.placed
  const rec = c.take(hit)
  check(rec.kind === 'carrot' && rec.name === 'carrot' && Number.isInteger(rec.variant) && rec.size === size && rec.geometry === c.bank.tiers[0].geometries[rec.variant] && rec.material === c.materials[rec.variant] && rec.color.length === 3 && rec.scale[0] === pl.scale && rec.scale[1] === pl.scale && rec.stowable === true,
    'take hands back the record: the finest tier, the variant\'s material, its tint and scale', JSON.stringify({ variant: rec.variant, size: rec.size.toFixed(3) }))
  check(c.placed === before - 1 && !pl.tile.ids.subarray(0, pl.tile.n).includes(pl.id) && taken.has('carrot', pl.x, pl.z), 'and the carrot is out of the ground and on the registry', `${c.placed} of ${before}`)
  const again = plantsOf(place())
  check(again.length === plants.length - 1 && !again.some((p) => Math.abs(p.x - pl.x) < 1e-6 && Math.abs(p.z - pl.z) < 1e-6), 'a bed grown again from the seed comes up without it', `${again.length} of ${plants.length}`)
  let twice = false
  try { c.take(hit) } catch { twice = true }
  check(twice, 'taking it twice throws')
  const dress = c.dress({ kind: 'carrot', variant: rec.variant })
  check(dress.geometry === rec.geometry && dress.material === rec.material, 'dress puts a packed record back on its variant\'s geometry and material')
  let wrong = 0
  try { c.dress({ kind: 'mushroom', variant: rec.variant }) } catch { wrong++ }
  try { c.dress({ kind: 'carrot', variant: 999 }) } catch { wrong++ }
  check(wrong === 2, 'and throws for another kind or an unknown variant', `${wrong} of 2`)
  taken.clear()
  check(plantsOf(place()).length === plants.length, 'the registry cleared, it grows back')
  {
    // A peer's take: evicted by key and spot within the registry's tolerance; a foreign key, an empty spot and a spot already emptied are false.
    const pe = plantsOf(c).find((p) => p.id !== pl.id)
    const n0 = c.placed
    check(c.evict('mushroom', pe.x, pe.z) === false && c.evict('carrot', pe.x + 5, pe.z) === false && c.placed === n0, 'evict is false for a foreign key or an empty spot')
    check(c.evict('carrot', pe.x + 0.03, pe.z - 0.03) === true && c.placed === n0 - 1 && !pe.tile.ids.subarray(0, pe.tile.n).includes(pe.id) && taken.has('carrot', pe.x, pe.z), 'evict pulls the carrot a peer took and records its spot')
    check(c.evict('carrot', pe.x, pe.z) === false, 'and is false for the spot once emptied')
  }
}

if (failures) {
  console.error(`\ncheck-carrots: ${failures} failure${failures === 1 ? '' : 's'}`)
  process.exit(1)
}
console.log('\ncheck-carrots: all passed')
