// Gate for the v3 island generator -- §31.
//
//   node scripts/check-v3.mjs
//
// The generator is judged by eye on /terrain-v3-map; this asserts the things an eye cannot, and the things §31 step A promised in numbers: the same seed gives the same field, the field is finite and inside its encoding, the island is an island (a summit near the centre, a sea that falls to the box edge, a coast that is not a circle), the water drains (every river runs downhill to the sea, a lake or another river, every lake is a bowl the ellipse round it does not overrun), the doc validates, the rg16 round trip is exact to a quantum, and v2's V2Height will stand on the result, since that is what /terrain-v3 boots.

import { generate, MIN_Y, MAX_Y, TEXELS } from '../src/v3/generate.js'
import { BIOMES, deserialise, rasterise } from '../src/v3/biomes.js'
import { LAKES, RIVERS } from '../src/v3/hydrology.js'
import { EROSION } from '../src/v3/erosion.js'
import { footprint } from '../src/v2/layers/water-bodies.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { V2Height } from '../src/v2/height/field.js'
import { RELIEF_DEFAULTS } from '../src/v2/height/relief.js'
import { Layers } from '../src/v2/layers/layers.js'
import { decodePng } from '../src/v2/height/png.js'

let failures = 0
function check(ok, what) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${what}`)
  if (!ok) failures++
}

export async function run() {
  const SEED = 20260824
  console.log('\n[v3] determinism')
  const a = generate({ seed: SEED })
  const b = generate({ seed: SEED })
  const c = generate({ seed: SEED + 1 })
  let same = a.height.length === b.height.length
  for (let i = 0; same && i < a.height.length; i++) same = a.height[i] === b.height[i]
  check(same, `seed ${SEED} twice gives the identical field`)
  let differ = 0
  for (let i = 0; i < a.height.length; i++) if (a.height[i] !== c.height[i]) differ++
  check(differ > a.height.length * 0.9, `seed ${SEED + 1} differs on ${((differ / a.height.length) * 100).toFixed(1)}% of texels`)
  let sameGround = a.ground.length === b.ground.length
  for (let i = 0; sameGround && i < a.ground.length; i++) sameGround = a.ground[i] === b.ground[i]
  check(sameGround, 'and the identical class grid')
  check(a.n === TEXELS && a.height.length === TEXELS * TEXELS, `${a.n}^2 texels`)
  console.log(`       ${a.ms.toFixed(0)} ms per generate`)

  console.log('\n[v3] the field')
  const s = a.stats
  check(s.min > MIN_Y && s.max < MAX_Y, `extremes ${s.min.toFixed(0)}..${s.max.toFixed(0)} m inside the rg16 range ${MIN_Y}..${MAX_Y}`)
  check(s.landFraction > 0.22 && s.landFraction < 0.5, `land ${(s.landFraction * 100).toFixed(1)}% of the box (${s.landKm2.toFixed(1)} km2)`)
  check(s.summit.h > 350 && s.summit.offset < 700, `summit ${s.summit.h.toFixed(0)} m, ${s.summit.offset.toFixed(0)} m off centre`)
  check(s.seaFloor.offshore1km < -30 && s.seaFloor.boxEdge < s.seaFloor.offshore1km - 50, `sea floor ${s.seaFloor.offshore1km.toFixed(0)} m a kilometre out, ${s.seaFloor.boxEdge.toFixed(0)} m at the box edge`)
  check(s.coast.irregularity > 1.6, `coast ${s.coast.lengthKm.toFixed(1)} km long, x${s.coast.irregularity.toFixed(2)} the circle of the same area`)
  check(s.bowls.count >= 6 && s.bowls.km2 > 0.2, `${s.bowls.count} closed bowls over 2 ha, ${s.bowls.km2.toFixed(2)} km2 ponded, largest ${s.bowls.largest ? s.bowls.largest.km2.toFixed(3) : 0} km2`)
  const relief = s.relief.map((r) => `${r.radius} m: ${r.rms.toFixed(1)}`).join(', ')
  let rising = true
  for (let i = 1; i < s.relief.length; i++) if (!(s.relief[i].rms > s.relief[i - 1].rms)) rising = false
  check(rising, `relief by blur radius rises with the radius (${relief})`)

  console.log('\n[v3] the water')
  const hs = s.hydrology
  const er = hs.erosion
  check(er.toSea > er.droplets * 0.8 && er.offEdge === 0 && er.spent < er.droplets * 0.05, `${er.droplets} droplets, ${((er.toSea / er.droplets) * 100).toFixed(0)}% reached the sea, ${er.ponded} ponded, ${er.spent} ran out of steps, none left the box`)
  check(er.cutMean > 1 && er.cutMean < 20 && er.deepestStep <= EROSION.maxCut && er.cutCells * a.cell * a.cell > s.landKm2 * 1e6 * 0.2, `the rain cut ${er.cutMean.toFixed(1)} m mean over ${((er.cutCells * a.cell * a.cell) / 1e6).toFixed(2)} km2 of ${s.landKm2.toFixed(1)}, ${er.deepest.toFixed(0)} m at the deepest, no step over ${EROSION.maxCut} m`)
  check(hs.silt.km2 < s.landKm2 * 0.1, `${hs.silt.km2.toFixed(2)} km2 silted up to its spill, ${hs.silt.mean.toFixed(1)} m mean, ${hs.silt.deepest.toFixed(0)} m at the deepest`)
  check(hs.lakes.count >= 3 && hs.lakes.count <= LAKES.keep, `${hs.lakes.count} lakes kept of ${hs.lakes.candidates} bowls the rain left`)
  check(hs.lakes.bodies.every((l) => l.level > 0 && l.deepest >= LAKES.minDepth && l.rx < 1000 && l.rz < 1000), `every lake stands above the sea, ${LAKES.minDepth} m or deeper, inside a kilometre: levels ${hs.lakes.bodies.map((l) => l.level.toFixed(0)).join(', ')} m`)
  check(hs.lakes.leakKm2 < hs.lakes.km2 * 0.05, `${hs.lakes.km2.toFixed(3)} km2 of lake, ${hs.lakes.leakKm2.toFixed(4)} km2 of water the ellipses would draw beside it`)
  check(hs.lakes.dryKm2 < hs.lakes.km2 * 0.02 && hs.lakes.dryDeepest < 4, `${hs.lakes.dryKm2.toFixed(4)} km2 of lake the ellipses leave dry, ${hs.lakes.dryDeepest.toFixed(1)} m at the deepest`)
  check(hs.rivers.count >= 20 && hs.rivers.km > 10 && hs.rivers.km / s.landKm2 > 1 && hs.rivers.km / s.landKm2 < 6, `${hs.rivers.count} rivers, ${hs.rivers.km.toFixed(1)} km on ${s.landKm2.toFixed(1)} km2 of land, longest ${hs.rivers.longestKm.toFixed(1)} km`)
  check(hs.rivers.intoSea + hs.rivers.intoLake + hs.rivers.fromLake > 0 && hs.rivers.intoSea >= 5 && hs.rivers.fromLake <= hs.lakes.count, `${hs.rivers.intoSea} reach the sea, ${hs.rivers.intoLake} a lake, ${hs.rivers.fromLake} leave one`)
  // Every river's ground never climbs from source to mouth on the field itself (a source in a lake sits under its own outlet, so that first step is free), its widths are inside the ladder, and its mouth is in the sea, in a lake or on another river.
  const half = ((a.n - 1) * a.cell) / 2
  const groundAt = (x, z) => a.height[Math.round((z + half) / a.cell) * a.n + Math.round((x + half) / a.cell)]
  let climbs = 0
  let widths = 0
  let mouths = 0
  const lakes = a.doc.lakes.filter((l) => l.y > 0)
  for (const r of a.doc.rivers) {
    for (let k = 2; k < r.pts.length; k++) if (groundAt(r.pts[k][0], r.pts[k][1]) > groundAt(r.pts[k - 1][0], r.pts[k - 1][1]) + 0.01) climbs++
    for (const p of r.pts) if (!(p[2] >= RIVERS.widthAtMin && p[2] <= RIVERS.maxWidth)) widths++
    const [mx, mz] = r.pts[r.pts.length - 1]
    const inSea = groundAt(mx, mz) <= 0
    const inLake = lakes.some((l) => footprint(l, mx, mz) > 0)
    const onRiver = a.doc.rivers.some((o) => o !== r && o.pts.some(([x, z]) => Math.hypot(x - mx, z - mz) < a.cell))
    if (!(inSea || inLake || onRiver)) mouths++
  }
  check(climbs === 0, `no river climbs between its nodes (${climbs} climbs)`)
  check(widths === 0, `every river node carries a width in ${RIVERS.widthAtMin}..${RIVERS.maxWidth} m (${widths} outside)`)
  check(mouths === 0, `every mouth is in the sea, in a lake or on another river (${mouths} are not)`)

  console.log('\n[v3] the document')
  const layers = Layers.deserialize(a.doc)
  check(layers.lakes.lakes.size === 1 + hs.lakes.count && layers.paths.paths.size === hs.rivers.count, `${layers.lakes.lakes.size} lakes and ${layers.paths.paths.size} rivers deserialise`)
  const sea = layers.lakes.lakes.get('l1')
  check(sea.y === 0 && sea.carve === false && sea.rx >= 8192, `the sea is an uncarved rectangle at y 0, ${sea.rx * 2} m across`)
  let above = 0
  let land = 0
  for (let i = 0; i < a.height.length; i++) if (a.height[i] > 0) { land++; if (a.height[i] > a.doc.snow.base) above++ }
  check(Math.abs(above / land - 1 / 7) < 0.01, `snow line ${a.doc.snow.base.toFixed(0)} m, ${((above / land) * 100).toFixed(1)}% of the land above it`)

  console.log('\n[v3] the biomes')
  const polygons = deserialise(a.biomes)
  check(polygons.length === s.biomes.polygons && polygons.length > 5 && polygons.length < 400, `${polygons.length} polygons, ${s.biomes.vertices} vertices, deserialise validates them`)
  check(a.ground instanceof Uint8Array && a.ground.length === a.n * a.n, 'the class grid is a Uint8Array over the field')
  const rebuilt = rasterise(polygons, a.n, a.cell)
  let agree = 0
  for (let i = 0; i < rebuilt.length; i++) if (rebuilt[i] === a.ground[i]) agree++
  check(agree === rebuilt.length, 'the grid rasterised from the cached polygons is the cached grid')
  check(s.biomes.agree > 0.98, `the polygons carry the traced classes on ${(s.biomes.agree * 100).toFixed(2)}% of texels`)
  const shares = s.biomes.landShare.map((f, k) => `${BIOMES[k].id} ${(f * 100).toFixed(1)}%`).join(', ')
  check(s.biomes.landShare.every((f) => f > 0.1 && f < 0.19), `every class holds about a seventh of the land: ${shares}`)
  const si = Math.round((s.summit.x + half) / a.cell)
  const sj = Math.round((s.summit.z + half) / a.cell)
  check(a.ground[sj * a.n + si] === 0, `the summit texel is ${BIOMES[a.ground[sj * a.n + si]].id}`)

  console.log('\n[v3] into v2')
  const hm = Heightmap.fromRaw({ width: a.n, height: a.n, data: a.height, meta: a.meta })
  check(hm.min === s.min && hm.max === s.max, 'Heightmap.fromRaw carries the extremes')
  const png = await hm.toPng()
  const back = Heightmap.fromDecoded(await decodePng(png), a.meta)
  let worst = 0
  for (let i = 0; i < a.height.length; i++) worst = Math.max(worst, Math.abs(back.field[i] - a.height[i]))
  const quantum = (MAX_Y - MIN_Y) / 65535
  check(worst <= quantum * 0.5 + 1e-4, `rg16 round trip: worst ${(worst * 100).toFixed(2)} cm against a ${(quantum * 100).toFixed(2)} cm quantum (${(png.length / 1024).toFixed(0)} kB)`)
  const height = new V2Height({ heightmap: hm, layers, seed: SEED, relief: RELIEF_DEFAULTS })
  const cal = height.calibration
  check(cal && cal.rough > 0 && Number.isFinite(cal.rough), `calibrateRough stands on the field: rough ${cal ? cal.rough.toFixed(4) : '--'}, exponent ${cal ? cal.exponent.toFixed(2) : '--'}`)
  const at = height.heightAt(s.summit.x, s.summit.z)
  check(Math.abs(at - s.summit.h) < 5, `V2Height at the summit reads ${at.toFixed(1)} m`)
  const bands = height.bands
  check(bands.max === s.max, `bands ${bands.min.toFixed(0)}..${bands.max.toFixed(0)} m`)

  if (failures) throw new Error(`check-v3: ${failures} failure${failures === 1 ? '' : 's'}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(
    () => console.log('\ncheck-v3: all green'),
    (err) => {
      console.error(err.stack || err)
      process.exit(1)
    },
  )
}
