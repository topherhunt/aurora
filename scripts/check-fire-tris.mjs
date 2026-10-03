// Node-side gates for the triangle flames (src/v2/render/fire-tris.js).
//
//   node scripts/check-fire-tris.mjs
//
// What can go wrong without throwing: a LOD level that shares another level's per-instance attribute (flames flicker in each other's phase); a thinner level that is not a subset of the one above (a flame reshuffles when it changes level); a fragment shader that gained a discard or a texture fetch (the whole cost model of opaque triangles); a flame count that outruns the buffers.

import { TriFlames, TRI_FIRE, TRI_WILDFIRE, TRI_TORCH, TRI_LAMP, TRI_CANDLE, TRI_LOD_COUNT, shardsAt, lodFor } from '../src/v2/render/fire-tris.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn() } catch { return true } return false }

console.log('the levels')
{
  const counts = Array.from({ length: TRI_LOD_COUNT }, (_, k) => shardsAt(TRI_FIRE, k))
  check(counts.join() === '512,128,32,8', 'each level keeps lodKeep of the one before', counts.join())
  check(shardsAt({ ...TRI_FIRE, shards: 4 }, 3) === 3, 'a level never drops under 3 shards')
  const p = TRI_FIRE
  check(lodFor(p, 0) === 0 && lodFor(p, p.lodNear - 0.01) === 0 && lodFor(p, p.lodNear) === 1, 'the first boundary is lodNear')
  check(lodFor(p, p.lodNear * p.lodStep) === 2 && lodFor(p, p.lodNear * p.lodStep ** 2) === 3 && lodFor(p, 1e6) === 3, 'later boundaries step by lodStep and the last level is open-ended')
}

console.log('the meshes')
{
  const f = new TriFlames(4)
  const attrs = f.levels.map((l) => l.mesh.geometry.getAttribute('aFlame'))
  check(new Set(attrs).size === TRI_LOD_COUNT, 'every level owns its aFlame attribute')
  const seeds = f.levels.map((l) => l.mesh.geometry.getAttribute('aSeed').array)
  const pos = f.levels.map((l) => l.mesh.geometry.getAttribute('position').array)
  let subset = true
  for (let k = 1; k < TRI_LOD_COUNT; k++) {
    for (let i = 0; i < seeds[k].length; i++) if (seeds[k][i] !== seeds[k - 1][i]) subset = false
    for (let i = 0; i < pos[k].length; i++) if (pos[k][i] !== pos[k - 1][i]) subset = false
  }
  check(subset, 'a thinner level is the first N shards of the one above')
  check(f.levels.every((l) => l.mesh.geometry.getAttribute('position').count === l.shards * 3), 'three vertices per shard, non-indexed')
  const m = f.levels[0].material
  check(!/discard/.test(m.fragmentShader) && !/texture2D|texture\(/.test(m.fragmentShader), 'the fragment shader neither discards nor samples')
  check(m.transparent === false && m.blending === 1, 'the material is opaque and unblended')

  const before = f.levels.map((l) => l.mesh)
  f.set({ ...TRI_FIRE, boost: 0.8 })
  check(f.levels.every((l, k) => l.mesh === before[k]), 'a knob that does not change the counts keeps the meshes')
  f.set({ ...TRI_FIRE, shards: 96 })
  check(f.levels[0].shards === 96 && f.group.children.length === TRI_LOD_COUNT * 2, 'a new shard count rebuilds the levels without leaking the old ones')
  check(throws(() => f.set({ ...TRI_FIRE, size: NaN })), 'a non-finite knob throws')
}

console.log('the looks')
{
  for (const [name, p] of [['campfire', TRI_FIRE], ['wildfire', TRI_WILDFIRE], ['torch', TRI_TORCH], ['lamp', TRI_LAMP], ['candle', TRI_CANDLE]]) {
    const f = new TriFlames(1, p)
    const n = f.levels.map((l) => l.shards)
    check(n.every((c, k) => k === 0 || c === Math.max(3, Math.round(n[0] * 0.25 ** k))), `${name}: each level is a quarter of the one above`, n.join())
  }
  check(TRI_FIRE.shards === 512 && TRI_WILDFIRE.shards < TRI_FIRE.shards && TRI_LAMP.shards < TRI_WILDFIRE.shards && TRI_CANDLE.shards < TRI_LAMP.shards, 'the smaller the flame the fewer the shards')
  check(TRI_TORCH.coreSize > 0 && TRI_TORCH.duty < 1 && TRI_CANDLE.shards < TRI_TORCH.shards && TRI_TORCH.shards < TRI_LAMP.shards, 'the torch is a candle-style core with occasional flecks, between the candle and the lamp')
}

console.log('the buckets')
{
  const f = new TriFlames(4)
  const eye = { x: 0, y: 0, z: 0 }
  const at = [0.5, TRI_FIRE.lodNear + 0.1, TRI_FIRE.lodNear * TRI_FIRE.lodStep + 0.1, 500]
  at.forEach((d, i) => f.place(i, d, 0, 0, { height: 0.3, radius: 0.1 }))
  const lods = f.update(1, [1, 1, 1], eye)
  check(lods.join() === '0,1,2,3', 'flames bucket by distance', lods.join())
  check(f.levels.map((l) => l.mesh.count).join() === '1,1,1,1', 'each mesh draws only its flames')
  check(f.triangles() === 512 + 128 + 32 + 8, 'triangles() sums count x shards over the levels', String(f.triangles()))
  f.forceLod = 2
  check(f.update(1, [1, 1, 1], eye).join() === '2,2,2,2' && f.levels[2].mesh.count === 4, 'forceLod pins every flame to one level')
  check(throws(() => f.place(4, 0, 0, 0, { height: 1, radius: 1 })), 'placing past the capacity throws')
  check(throws(() => f.update(1, [1, 1, 1])), 'update without an eye throws')
  TriFlames.shown = false
  f.update(1, [1, 1, 1], eye)
  check(f.levels.every((l) => l.mesh.count === 0 && l.core.count === 0) && f.triangles() === 0, 'the fire row off draws no flame and no core')
  TriFlames.shown = true
  check(f.update(1, [1, 1, 1], eye).length === 4 && f.levels[2].mesh.count === 4, 'back on, the flames draw again')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
