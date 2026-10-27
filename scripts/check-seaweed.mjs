// Seaweed on the lake and river beds (render/seaweed-scatter.js): clump 42 of render/seaweed.js, one instanced draw, a tip never nearer the surface than 1 m, and beds that run from bare to patchy.
//
//   node scripts/check-seaweed.mjs
//
// Beds here are synthetic basins (a lake with a sloping shore and bumps, a narrow river), so the rule is tested over many seeds and many depths; what this can NOT check is how it looks.

import THREE from '../src/three-instance.js'
import { weedSites, densityAt, SeaweedScatter, SEAWEED_SCATTER as C } from '../src/v2/render/seaweed-scatter.js'
import { seaweedGeometry } from '../src/v2/render/seaweed.js'

let failures = 0
function check(ok, title, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
}

// Water at 0 inside a lake (radius 120 about the origin) and a river (|z - 200| < 8 for x > 0); the bed falls to -9 m in the lake's middle and -3 m mid-river, with ripples.
const LEVEL = 0
const wet = (x, z) => Math.hypot(x, z) < 120 || (x > 0 && Math.abs(z - 200) < 8)
const levelAt = (x, z) => (wet(x, z) ? LEVEL : null)
const bedAt = (x, z) => {
  const lake = -9 * Math.max(0, 1 - Math.hypot(x, z) / 120) ** 0.6
  const river = -3 * Math.max(0, 1 - Math.abs(z - 200) / 8)
  return Math.min(lake, river) - 0.4 * Math.sin(x * 0.7) * Math.cos(z * 0.5) + (wet(x, z) ? 0 : 5)
}

const SEEDS = 120
let sites = 0, shallowest = Infinity, nearest = Infinity, hMin = Infinity, hMax = -Infinity, dry = 0, rivers = 0
for (let seed = 1; seed <= SEEDS; seed++) {
  for (let tx = -10; tx <= 10; tx++) {
    for (let tz = -10; tz <= 18; tz++) {
      for (const s of weedSites(tx, tz, seed, levelAt, bedAt)) {
        sites++
        const depth = LEVEL - s.y
        shallowest = Math.min(shallowest, depth)
        nearest = Math.min(nearest, LEVEL - (s.y + s.h))
        hMin = Math.min(hMin, s.h); hMax = Math.max(hMax, s.h)
        if (levelAt(s.x, s.z) === null) dry++
        if (s.x > 0 && Math.abs(s.z - 200) < 8) rivers++
      }
    }
  }
}
console.log(`\nseaweed   ${SEEDS} world seeds over a synthetic lake and river`)
check(sites > SEEDS * 100, 'beds grow clumps', `${sites} clumps`)
check(nearest >= C.topGapM - 1e-9, 'no clump tip is nearer the surface than 1 m', `nearest ${nearest.toFixed(3)} m`)
check(shallowest >= 2 - 1e-9, 'no clump roots in less than 2 m of water', `shallowest ${shallowest.toFixed(3)} m`)
check(hMin >= 1 && hMax <= 6 && hMax - hMin > 4.5, 'clumps stand 1 to 6 m tall, over most of that range', `${hMin.toFixed(2)}..${hMax.toFixed(2)} m`)
check(dry === 0, 'no clump stands on dry land', `${dry} dry`)
check(rivers > 0, 'a river bed 3 m deep at its middle takes clumps where it is deep enough', `${rivers} in the river`)

const again = weedSites(3, -2, 7, levelAt, bedAt)
check(again.length > 0 && JSON.stringify(again) === JSON.stringify(weedSites(3, -2, 7, levelAt, bedAt)), 'a tile rolls the same clumps every time', `${again.length} clumps`)
check(JSON.stringify(weedSites(3, -2, 8, levelAt, bedAt)) !== JSON.stringify(again), 'another world seed rolls other clumps')

// Density on beds over 5 m deep, where every clump height fits: clumps per hectare overall, and how unevenly they fall over 8 m cells.
let deepArea = 0, deepSites = 0
for (let x = -120; x < 120; x += 2) for (let z = -120; z < 120; z += 2) if (levelAt(x, z) !== null && LEVEL - bedAt(x, z) >= 5) deepArea += 4
const deep = []
const bands = [0, 0, 0, 0, 0]
for (let seed = 1; seed <= 20; seed++) for (let tx = -10; tx <= 9; tx++) for (let tz = -10; tz <= 9; tz++) for (const s of weedSites(tx, tz, seed, levelAt, bedAt)) if (LEVEL - s.y >= 5) { deepSites++; if (seed === 1) deep.push(s); if (LEVEL - s.y >= 7) bands[Math.min(4, Math.floor(s.h - 1))]++ }
const perHa = deepSites / 20 / (deepArea / 1e4)
check(perHa > 100 && perHa < 1500, 'a reasonable density on the deep bed', `${perHa.toFixed(0)} clumps per hectare`)

const cells = new Map()
for (const s of deep) { const k = `${Math.floor(s.x / 8)},${Math.floor(s.z / 8)}`; cells.set(k, (cells.get(k) ?? 0) + 1) }
let deepCells = 0
for (let x = -120; x < 120; x += 8) for (let z = -120; z < 120; z += 8) if (levelAt(x + 4, z + 4) !== null && LEVEL - bedAt(x + 4, z + 4) >= 5) deepCells++
const counts = [...cells.values()]
const mean = deep.length / deepCells
const variance = counts.reduce((a, c) => a + c * c, 0) / deepCells - mean * mean
check(variance / mean > 4, 'clumps bunch rather than spreading evenly (an even scatter has a dispersion near 1)', `dispersion ${(variance / mean).toFixed(1)}, ${deepCells - counts.length} of ${deepCells} cells bare`)

let dense = 0, sparse = 0
for (let x = -1000; x < 1000; x += 10) for (let z = -1000; z < 1000; z += 10) { const d = densityAt(x, z, 3); if (d > 0.9) dense++; if (d < 0.1) sparse++ }
check(dense > 2000 && sparse > 2000, 'the density field has both thick and bare ground', `${dense} dense, ${sparse} sparse of 40000 samples`)

// Patches crowd many clumps together, and over beds deep enough for any height (7 m), heights fall evenly: each metre of the 1..6 m range holds about a fifth.
const crowded = deep.filter((s) => deep.filter((o) => Math.hypot(o.x - s.x, o.z - s.z) < 5).length >= 10).length
check(crowded > 100, 'patches crowd ten or more clumps within 5 m', `${crowded} clumps in a crowd`)
const total = bands.reduce((a, b) => a + b, 0)
check(total > 3000 && bands.every((b) => b / total > 0.17 && b / total < 0.23), 'heights spread evenly over 1 to 6 m, with no peak of short or tall', `${total} clumps, ${bands.map((b) => ((100 * b) / total).toFixed(0) + '%').join(' ')} per metre`)

// The instanced layers: the clump's mesh within NEAR_M of her and its card past that, each instance standing on its bed and as tall as its clump. No renderer here to bake the card's picture, so the gate flips `cardReady` itself.
const scene = new THREE.Scene()
const field = { heightAt: bedAt }
const water = { levelAt }
const keys = []
const sw = new SeaweedScatter(scene, field, water, { seed: 5, patch: (_, key) => keys.push(key) })
sw.place(0, 0, 0)
const meshes = []
scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
check(meshes.length === 2 && meshes.every((o) => o.isInstancedMesh) && new Set(keys).size === 2 && keys.length === 2, 'the layer is two instanced meshes, each material patched once under its own key', `${meshes.length} meshes, keys ${keys.join(' ')}`)
check(sw.mesh.count > 0 && sw.cards.count === 0 && !sw.cards.visible, 'before the card is baked only the near clumps are drawn', `${sw.mesh.count} near, ${sw.cards.count} cards`)
sw.cardReady = true
sw.splitAt = null

const m0 = new THREE.Matrix4()
const drawn = (mesh) => {
  const out = []
  for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m0); out.push(m0.clone()) }
  return out
}
let reach = 0, missed = 0, wrongRung = 0
for (let tx = -8; tx <= 8; tx++) for (let tz = -8; tz <= 8; tz++) for (const s of weedSites(tx, tz, 5, levelAt, bedAt)) if (Math.hypot(s.x - 1, s.z - 1) <= C.cullM) reach++
for (const [px, pz] of [[1, 1], [11.9, 11.9], [0.1, 11.9]]) {
  sw.place(px, pz, 0)
  const have = new Set()
  for (const [mesh, near] of [[sw.mesh, true], [sw.cards, false]]) {
    for (const mm of drawn(mesh)) {
      const d = Math.hypot(mm.elements[12] - px, mm.elements[14] - pz)
      if ((d <= C.nearM) !== near) wrongRung++
      have.add(`${mm.elements[12].toFixed(3)},${mm.elements[14].toFixed(3)}`)
    }
  }
  for (let tx = -8; tx <= 8; tx++) for (let tz = -8; tz <= 8; tz++) for (const s of weedSites(tx, tz, 5, levelAt, bedAt)) if (Math.hypot(s.x - px, s.z - pz) <= C.cullM && !have.has(`${s.x.toFixed(3)},${s.z.toFixed(3)}`)) missed++
}
check(reach > 0 && missed === 0, `every clump within ${C.cullM} m is uploaded, wherever she stands in her tile`, `${missed} missing of ~${reach}`)
check(wrongRung === 0, `clumps within ${C.nearM} m are meshes and the rest cards`, `${wrongRung} on the wrong rung`)
sw.place(0, 0, 0)
check(sw.mesh.count > 20 && sw.cards.count > 3 * sw.mesh.count, 'most clumps in reach are cards', `${sw.mesh.count} meshes, ${sw.cards.count} cards`)

const geo = seaweedGeometry(C.seed)
geo.computeBoundingBox()
const gh = geo.boundingBox.max.y
let bad = 0, worst = Infinity
const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
for (const mm of [...drawn(sw.mesh), ...drawn(sw.cards)]) {
  mm.decompose(p, q, sc)
  const top = p.y + sc.y * gh
  if (Math.abs(p.y - bedAt(p.x, p.z)) > 1e-4 || LEVEL - top < 1 - 1e-4 || sc.y * gh < 1 - 1e-4 || sc.y * gh > 6 + 1e-4) bad++
  worst = Math.min(worst, LEVEL - top)
}
check(bad === 0, 'every instance roots on the bed, stands 1 to 6 m tall and tops out 1 m under the water', `${bad} bad, nearest tip ${worst.toFixed(3)} m under`)
const version = sw.mesh.instanceMatrix.version
sw.place(0.6, 0.6, 0)
check(sw.mesh.instanceMatrix.version === version, `moving less than ${C.splitM} m re-sorts nothing`)
sw.place(1.6, 0.6, 0)
check(sw.mesh.instanceMatrix.version > version, `moving ${C.splitM} m re-sorts the rungs`)
sw.place(800, 800, 0)
check(sw.mesh.count === 0 && sw.cards.count === 0 && !sw.mesh.visible && !sw.cards.visible, 'far from any water both layers are empty and hidden', `${sw.mesh.count} + ${sw.cards.count} instances`)
sw.dispose()

if (failures > 0) { console.log(`\n${failures} failures`); process.exit(1) }
console.log('\nall ok')
