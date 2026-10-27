// Seaweed on the lake and river beds (render/seaweed-scatter.js): clump 42 of render/seaweed.js, one instanced draw, and a tip never nearer the surface than 1 m.
//
//   node scripts/check-seaweed.mjs
//
// Beds here are synthetic basins (a lake with a sloping shore and bumps, a narrow river), so the rule is tested over many seeds and many depths; what this can NOT check is how it looks.

import THREE from '../src/three-instance.js'
import { weedSites, SeaweedScatter, SEAWEED_SCATTER as C } from '../src/v2/render/seaweed-scatter.js'
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
  for (let tx = -9; tx <= 9; tx++) {
    for (let tz = -9; tz <= 14; tz++) {
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
check(hMin >= 1 && hMax <= 4 && hMax - hMin > 2, 'clumps stand 1 to 4 m tall, over most of that range', `${hMin.toFixed(2)}..${hMax.toFixed(2)} m`)
check(dry === 0, 'no clump stands on dry land', `${dry} dry`)
check(rivers > 0, 'a river bed 3 m deep at its middle takes clumps where it is deep enough', `${rivers} in the river`)

const again = weedSites(3, -2, 7, levelAt, bedAt)
check(again.length > 0 && JSON.stringify(again) === JSON.stringify(weedSites(3, -2, 7, levelAt, bedAt)), 'a tile rolls the same clumps every time', `${again.length} clumps`)
check(JSON.stringify(weedSites(3, -2, 8, levelAt, bedAt)) !== JSON.stringify(again), 'another world seed rolls other clumps')

// Density on beds over 5 m deep, where every clump height fits: clumps per hectare.
let deepArea = 0, deepSites = 0
for (let x = -120; x < 120; x += 2) for (let z = -120; z < 120; z += 2) if (levelAt(x, z) !== null && LEVEL - bedAt(x, z) >= 5) deepArea += 4
for (let seed = 1; seed <= 20; seed++) for (let tx = -8; tx <= 7; tx++) for (let tz = -8; tz <= 7; tz++) for (const s of weedSites(tx, tz, seed, levelAt, bedAt)) if (LEVEL - s.y >= 5) deepSites++
const perHa = deepSites / 20 / (deepArea / 1e4)
check(perHa > 100 && perHa < 400, 'a reasonable density on the deep bed', `${perHa.toFixed(0)} clumps per hectare`)

// The instanced layer: one mesh, one draw call, each instance standing on its bed and as tall as its clump.
const scene = new THREE.Scene()
const field = { heightAt: bedAt }
const water = { levelAt }
let patched = 0
const sw = new SeaweedScatter(scene, field, water, { seed: 5, patch: () => patched++ })
sw.place(0, 0)
const meshes = []
scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
check(meshes.length === 1 && meshes[0].isInstancedMesh && patched === 1, 'the layer is one instanced mesh with its material patched once', `${meshes.length} mesh`)
check(sw.mesh.count > 100 && sw.mesh.count <= C.capacity, 'the clumps in reach are uploaded', `${sw.mesh.count} instances`)
const geo = seaweedGeometry(C.seed)
geo.computeBoundingBox()
const gh = geo.boundingBox.max.y
let bad = 0, worst = Infinity
const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3()
for (let i = 0; i < sw.mesh.count; i++) {
  sw.mesh.getMatrixAt(i, m)
  m.decompose(p, q, sc)
  const top = p.y + sc.y * gh
  if (Math.abs(p.y - bedAt(p.x, p.z)) > 1e-4 || LEVEL - top < 1 - 1e-4 || sc.y * gh < 1 - 1e-4 || sc.y * gh > 4 + 1e-4) bad++
  worst = Math.min(worst, LEVEL - top)
}
check(bad === 0, 'every instance roots on the bed, stands 1 to 4 m tall and tops out 1 m under the water', `${bad} bad, nearest tip ${worst.toFixed(3)} m under`)
const before = sw.mesh.count
sw.place(1, 1)
check(sw.mesh.count === before, 'staying in a tile re-rolls nothing')
sw.place(800, 800)
check(sw.mesh.count === 0, 'far from any water the layer is empty', `${sw.mesh.count} instances`)
sw.dispose()

if (failures > 0) { console.log(`\n${failures} failures`); process.exit(1) }
console.log('\nall ok')
