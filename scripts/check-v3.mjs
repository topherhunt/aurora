// Gate for the v3 island generator -- §31.
//
//   node scripts/check-v3.mjs
//
// The generator is judged by eye on /terrain-v3-map; this asserts the things an eye cannot, and the things §31 step A promised in numbers: the same seed gives the same field, the field is finite and inside its encoding, the island is an island (a summit near the centre, a sea that falls to the box edge, a coast that is not a circle), the water drains (every river runs downhill to the sea, a lake or another river, every lake is a bowl the ellipse round it does not overrun), the doc validates, the rg16 round trip is exact to a quantum, and v2's V2Height will stand on the result, since that is what /terrain-v3 boots.

import { generate, MIN_Y, MAX_Y, TEXELS, CELL } from '../src/v3/generate.js'
import { WORLD_SIZE } from '../src/v2/config.js'
import { JITTER, TEXELS_PER_NODE, octaveTable, splitOctaves, octaveAt } from '../src/v3/island.js'
import { FineJitter } from '../src/v3/fine.js'
import { BIOMES, deserialise, rasterise } from '../src/v3/biomes.js'
import { LAKES, RIVERS } from '../src/v3/hydrology.js'
import { EROSION } from '../src/v3/erosion.js'
import { CLIFFS, table } from '../src/v3/cliffs.js'
import { NB_DI, NB_DJ } from '../src/sim/world-grid.js'
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
  // The shipped grid is 4097^2 and a generate on it costs 91 s, so the gate runs it ONCE, as `a`, and every check that needs a second island runs at COARSE. That is sound for the two that do. Determinism is a property of the hashes, which are keyed on world coordinates and the seed and know nothing of the grid. And the cliff block's numbers -- a 12 m fall between neighbouring texels is a 56 degree face at 8 m and an 81 degree one at 2 m -- were fitted on the 8 m grid and mean nothing on another.
  const COARSE = 1025
  console.log('\n[v3] determinism')
  const a = generate({ seed: SEED })
  const b = generate({ seed: SEED, n: COARSE })
  const b2 = generate({ seed: SEED, n: COARSE })
  const c = generate({ seed: SEED + 1, n: COARSE })
  let same = b.height.length === b2.height.length
  for (let i = 0; same && i < b.height.length; i++) same = b.height[i] === b2.height[i]
  check(same, `seed ${SEED} twice gives the identical field`)
  let differ = 0
  for (let i = 0; i < b.height.length; i++) if (b.height[i] !== c.height[i]) differ++
  check(differ > b.height.length * 0.9, `seed ${SEED + 1} differs on ${((differ / b.height.length) * 100).toFixed(1)}% of texels`)
  let sameGround = b.ground.length === b2.ground.length
  for (let i = 0; sameGround && i < b.ground.length; i++) sameGround = b.ground[i] === b2.ground[i]
  check(sameGround, 'and the identical class grid')
  check(a.n === TEXELS && a.height.length === TEXELS * TEXELS && a.cell === WORLD_SIZE / (TEXELS - 1), `${a.n}^2 texels at ${a.cell} m`)
  console.log(`       ${a.ms.toFixed(0)} ms per generate at ${a.n}^2, ${b.ms.toFixed(0)} ms at ${b.n}^2`)

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

  // The layer model itself (§31 step B): one ladder of eleven rungs, cut by the grid into what the image can hold and what is read back per sample, and the cut is a storage decision that moves no ground.
  console.log('\n[v3] the ladder')
  const rungs = octaveTable(SEED)
  const finest = JITTER.start / 2 ** (JITTER.amps.length - 1)
  check(rungs.length === 11 && rungs[0].spacing === JITTER.start && rungs[rungs.length - 1].spacing === finest, `${rungs.length} rungs, ${JITTER.start} m down to ${finest} m`)
  check(rungs.every((o) => Math.abs(o.amp - o.spacing / 4) < 1e-9), `every rung moves its lattice by a quarter of its own spacing (${rungs.map((o) => o.amp).join('/')} m)`)
  const cut = splitOctaves(rungs, a.cell)
  const floor = TEXELS_PER_NODE * a.cell
  check(
    cut.coarse.length + cut.fine.length === rungs.length &&
      cut.coarse.every((o) => o.spacing >= floor) &&
      cut.fine.every((o) => o.spacing < floor),
    `the ${a.cell} m image bakes the ${cut.coarse.length} rungs down to ${floor} m (${TEXELS_PER_NODE} texels to a node) and leaves ${cut.fine.map((o) => o.spacing).join('/')} m to read time`,
  )
  {
    const px = 1234.5
    const pz = -678.25
    const smooth = JITTER.interp === 'smooth'
    const whole = rungs.reduce((t, o) => t + octaveAt(o, px, pz, smooth), 0)
    const halves = [...cut.coarse, ...cut.fine].reduce((t, o) => t + octaveAt(o, px, pz, smooth), 0)
    check(Math.abs(whole - halves) < 1e-9, 'the cut is a storage decision: the two halves sum to the whole ladder')
    const fine = new FineJitter({ seed: SEED, cell: a.cell })
    check(fine.octaves.length === cut.fine.length && Math.abs(fine.reach - cut.fine.reduce((t, o) => t + o.amp, 0)) < 1e-9, `FineJitter carries those ${fine.octaves.length} rungs, reach ${fine.reach} m`)
    const all = fine.at(px, pz, 0, 0, 0)
    // The LOD. A rung is at full weight once the sample spacing is a quarter of it -- the same four-samples-to-a-node rule that cut the ladder -- and gone once the spacing reaches half of it. cell 0 is what collision, picking and the editor pass, and means every rung.
    check(all !== 0 && Math.abs(all) <= fine.reach, `cell 0 reads every read-time rung: ${all.toFixed(3)} m of ${fine.reach} m of reach`)
    check(fine.at(px, pz, finest / 4, 0, 0) === all, `a ${finest / 4} m probe reads the same ${all.toFixed(3)} m`)
    check(fine.at(px, pz, 128, 0, 0) === 0 && fine.at(px, pz, cut.fine[0].spacing, 0, 0) === 0, `a 128 m chunk vertex reads none of them, and neither does one at ${cut.fine[0].spacing} m`)
    check(fine.at(px, pz, 0, 0, 1) === 0, 'and flattened ground (a road, a lake shore) reads none of them')
  }

  console.log('\n[v3] the water')
  const hs = s.hydrology
  const er = hs.erosion
  check(er.toSea > er.droplets * 0.8 && er.offEdge === 0 && er.spent < er.droplets * 0.05, `${er.droplets} droplets, ${((er.toSea / er.droplets) * 100).toFixed(0)}% reached the sea, ${er.ponded} ponded, ${er.spent} ran out of steps, none left the box`)
  // `maxCut` is a reference depth per reference step and `deepestStep` is metres on THIS grid, but the two conversions cancel -- perStep is cell/refCell and toHere is refCell/cell -- so the deepest step is maxCut metres on every grid. That cancellation is the point of the length ratio, and asserting the bare constant is what would catch it being put back to an area one.
  const stepCap = EROSION.maxCut
  // The share of land the rain touches falls with the cell, because the brush is `radius` CELLS wide: 12.6 km2 of the 19.4 carved at 12.8 m, 5.3 at 3.2, 3.5 at 2. So this floor is a sixth of the land and not a third -- it is here to catch rain that stopped reaching the ground at all, not to pin the groove's width, which THE GROOVE's own note owns.
  check(er.cutMean > 1 && er.cutMean < 20 && er.deepestStep <= stepCap + 1e-6 && er.cutCells * a.cell * a.cell > s.landKm2 * 1e6 * 0.15, `the rain cut ${er.cutMean.toFixed(1)} m mean over ${((er.cutCells * a.cell * a.cell) / 1e6).toFixed(2)} km2 of ${s.landKm2.toFixed(1)}, ${er.deepest.toFixed(0)} m at the deepest, no step over ${stepCap} m`)
  check(hs.silt.km2 < s.landKm2 * 0.1, `${hs.silt.km2.toFixed(2)} km2 silted up to its spill, ${hs.silt.mean.toFixed(1)} m mean, ${hs.silt.deepest.toFixed(0)} m at the deepest`)

  // The tabling is off by default (generate.js STEPS), so it is judged on an island generated with it switched back on, and the default is asserted to carry none of it. Everything below reads `cliffy` for that reason.
  console.log('\n[v3] the cliffs')
  check(hs.cliffs.cells === 0 && hs.cliffs.km2 === 0, 'the default island tables nothing: the cliff pass is off')
  const cliffy = generate({ seed: SEED, n: COARSE, tune: { steps: { cliffs: true } } })
  const cl = cliffy.stats.hydrology.cliffs
  const cliffyLandKm2 = cliffy.stats.landKm2
  const lift = Math.max(...Object.values(CLIFFS.byBiome).map((k) => (k.snap[1] - k.riser) * k.step))
  check(cl.maxMove <= lift + 1e-3, `the tabling lifted a texel ${cl.maxMove.toFixed(1)} m at the most, inside the ${lift.toFixed(1)} m a shelf can stand above the foot of its own band`)
  check(cl.km2 > 0.5 && cl.km2 < cliffyLandKm2 * 0.25, `${cl.km2.toFixed(2)} km2 tabled of ${cliffyLandKm2.toFixed(1)}, ${cl.meanMove.toFixed(1)} m mean lift`)
  check(cl.byBiome.every((b) => Math.abs(b.share - CLIFFS.byBiome[b.id].share) < 0.02), `every class banded its own share of its steep ground, of which the sparse ladder moves about a third: ${cl.byBiome.map((b) => `${b.id} ${(b.share * 100).toFixed(0)}%`).join(', ')}`)
  check(cl.byBiome.find((b) => b.id === 'swamp').cells === 0, 'the swamp is left alone')
  // The two promises the ramp's shape makes, on a clean 32-degree ramp of canyon with the band gate held open: it only ever lifts, so nothing is dug out under a face, and no face stands in the band above another, so a hillside is not a staircase.
  {
    const m = 96
    const fall = cliffy.cell * Math.tan((32 * Math.PI) / 180)
    const ramp = new Float32Array(m * m)
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) ramp[j * m + i] = 10 + j * fall
    const was = Float32Array.from(ramp)
    const T = { ...CLIFFS, byBiome: { ...CLIFFS.byBiome, canyon: { ...CLIFFS.byBiome.canyon, share: 1 } } }
    table(ramp, new Uint8Array(m * m), new Uint8Array(m * m).fill(BIOMES.findIndex((b) => b.id === 'canyon')), m, cliffy.cell, SEED, T)
    let cut = 0
    for (let c = 0; c < ramp.length; c++) if (ramp[c] < was[c] - 1e-4) cut++
    check(cut === 0, `the tabling only ever lifts: ${cut} of ${m * m} texels on that ramp finished below where they started`)
    const deep = []
    for (let j = 1; j < m; j++) { const c = j * m + (m >> 1); if (ramp[c] - ramp[c - m] >= 12) deep.push(j) }
    // Neighbouring texels are the same face; a gap is the climb from one face to the next.
    const gaps = []
    for (let k = 1; k < deep.length; k++) if (deep[k] - deep[k - 1] > 1) gaps.push(deep[k] - deep[k - 1])
    const bandCells = CLIFFS.byBiome.canyon.step / fall
    check(gaps.length >= 2 && Math.min(...gaps) > bandCells * 1.4, `no face stands in the band above another: ${gaps.length + 1} faces up that ramp, the nearest two ${Math.min(...gaps)} texels apart where a band is ${bandCells.toFixed(1)}`)
  }
  // The face each land texel presents, as the steepest of its four axis neighbours read through the 8 m grid. A cliff biome should not merely be steeper on average: it should be BIMODAL, bench and wall, with the 40-50 degree ground it abhors thinned out under the wall it prefers.
  const faces = BIOMES.map(() => [])
  for (let j = 1; j < cliffy.n - 1; j++) {
    for (let i = 1; i < cliffy.n - 1; i++) {
      const c = j * cliffy.n + i
      if (cliffy.height[c] <= 0) continue
      let d = 0
      for (const k of [c - 1, c + 1, c - cliffy.n, c + cliffy.n]) { const dd = cliffy.height[c] - cliffy.height[k]; if (dd > d) d = dd }
      faces[cliffy.ground[c]].push((Math.atan(d / cliffy.cell) * 180) / Math.PI)
    }
  }
  const band = (k, lo, hi) => faces[k].filter((v) => v >= lo && v < hi).length / faces[k].length
  const CANYON = BIOMES.findIndex((b) => b.id === 'canyon')
  const FOREST = BIOMES.findIndex((b) => b.id === 'forest')
  const wallToRamp = (k) => band(k, 60, 90) / band(k, 40, 50)
  check(wallToRamp(CANYON) > wallToRamp(FOREST) * 3, `the canyon stands its steep ground up where the forest lays it down: ${(wallToRamp(CANYON) * 100).toFixed(0)} texels over 60 deg per 100 at 40-50, against the forest's ${(wallToRamp(FOREST) * 100).toFixed(0)}`)
  check(band(CANYON, 70, 90) > band(FOREST, 70, 90) * 8, `the canyon walls where the forest slopes: ${(band(CANYON, 70, 90) * 100).toFixed(2)}% of canyon against ${(band(FOREST, 70, 90) * 100).toFixed(2)}% of forest over 70 deg`)
  // Only the canyon's shelves snap near flat; every other class keeps a grade on its, so the gap here is narrower than the one over 70 degrees and is meant to be.
  check(band(CANYON, 40, 50) < band(FOREST, 40, 50) * 0.8 && band(CANYON, 0, 10) > band(FOREST, 0, 10) * 1.2, `the canyon abhors the 45-degree slope and keeps its mesa tops: ${(band(CANYON, 40, 50) * 100).toFixed(1)}% at 40-50 deg and ${(band(CANYON, 0, 10) * 100).toFixed(1)}% under 10, against the forest's ${(band(FOREST, 40, 50) * 100).toFixed(1)}% and ${(band(FOREST, 0, 10) * 100).toFixed(1)}%`)
  // A per-texel coin flip would leave every face isolated. Bands leave runs.
  const face = new Uint8Array(cliffy.n * cliffy.n)
  for (let j = 1; j < cliffy.n - 1; j++) for (let i = 1; i < cliffy.n - 1; i++) { const c = j * cliffy.n + i; if (cliffy.height[c] > 0) for (const k of [c - 1, c + 1, c - cliffy.n, c + cliffy.n]) if (cliffy.height[c] - cliffy.height[k] > 12) face[c] = 1 }
  const seen = new Uint8Array(cliffy.n * cliffy.n)
  let longest = 0
  let runs = 0
  let faceCells = 0
  for (let c = 0; c < face.length; c++) {
    if (!face[c] || seen[c]) continue
    let size = 0
    const stack = [c]
    seen[c] = 1
    while (stack.length) {
      const p = stack.pop()
      size++
      const pi = p % cliffy.n
      const pj = (p / cliffy.n) | 0
      for (let k = 0; k < 8; k++) {
        const ni = pi + NB_DI[k]
        const nj = pj + NB_DJ[k]
        if (ni < 0 || nj < 0 || ni >= cliffy.n || nj >= cliffy.n) continue
        const nn = nj * cliffy.n + ni
        if (face[nn] && !seen[nn]) { seen[nn] = 1; stack.push(nn) }
      }
    }
    runs++
    faceCells += size
    if (size > longest) longest = size
  }
  check(faceCells > 2000 && longest > 60 && faceCells / runs > 3, `faces over 12 m run in bands, not specks: ${faceCells} texels in ${runs} runs, ${(faceCells / runs).toFixed(1)} mean and ${longest} at the longest`)
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
