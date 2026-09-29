// Gate for the v3 island generator -- §31.
//
//   node scripts/check-v3.mjs
//
// The generator is judged by eye on /terrain-v3-map; this asserts the things an eye cannot, and the things §31 step A promised in numbers: the same seed gives the same field, the field is finite and inside its encoding, the island is an island (a summit near the centre, a sea that falls to the box edge, a coast that is not a circle), the water drains (every river runs downhill to the sea, a lake or another river, every lake is a bowl the ellipse round it does not overrun), the doc validates, the rg16 round trip is exact to a quantum, and v2's V2Height will stand on the result, since that is what /terrain-v3 boots.

import { generate, MIN_Y, MAX_Y, TEXELS, CELL } from '../src/v3/generate.js'
import { WORLD_SIZE, WORLD_HALF, CHUNK_RES } from '../src/v2/config.js'
import { APRON, DECIMATE, TILE_M, TileStore, baseTexelsFor, cutTile, decimate, pageRadius, storedTexels, subsampleClasses, tileKey, tileTexels, tilesForRadius, tilesWithin } from '../src/v3/tiles.js'
import { MIN_TRI_DEG, selectNodes } from '../src/v2/terrain/quadtree-v2.js'
import { JITTER, TEXELS_PER_NODE, octaveTable, splitOctaves, octaveAt } from '../src/v3/island.js'
import { FineJitter } from '../src/v3/fine.js'
import { BIOMES, deserialise, rasterise } from '../src/v3/biomes.js'
import { LAKES, RIVERS } from '../src/v3/hydrology.js'
import { BASINS } from '../src/v3/basins.js'
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
  // The shipped grid is 4097^2 and a generate on it costs 37 s, so the gate runs it ONCE, as `a`, and every check that needs a second island runs at COARSE. That is sound for the two that do. Determinism is a property of the hashes, which are keyed on world coordinates and the seed and know nothing of the grid. And the cliff block's numbers -- a 12 m fall between neighbouring texels is a 56 degree face at 8 m and an 81 degree one at 2 m -- were fitted on the 8 m grid and mean nothing on another.
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
  // A quarter of the spacing above 16 m and an eighth from 16 m down to 2 m, with the 1 m rung back at a quarter because an eighth of a metre is under the field's own quantum. The macro rungs are what the island's shape is; the fine ones at a quarter read as grit.
  const eighth = (o) => o.spacing <= 16 && o.spacing >= 2
  check(rungs.every((o) => Math.abs(o.amp - o.spacing / (eighth(o) ? 8 : 4)) < 1e-9), `every rung moves its lattice by a quarter of its own spacing down to 32 m and an eighth from 16 m to 2 m (${rungs.map((o) => o.amp).join('/')} m)`)
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
  const ba = hs.basins
  // THE DRAIN IS JUDGED ON DEPTH AND NOTHING ELSE. The jitter leaves hundreds of closed dips a flood would pond, so every basin over `pond` metres has its lowest rim cut with a broad dish until its water is under a metre -- all but the `keep` deepest, which are held to `keepDepth` instead. Like the carve it only ever lowers a texel, so `raised` is a count and not a tolerance. `stuck` is a basin the round cap gave up on, and it must be none of them: a basin left with water in it is water the doc does not draw.
  check(ba.raised === 0, `the drain never raised a texel (${ba.raised} did)`)
  check(ba.stuck === 0 && ba.drainedDeepest <= BASINS.pond + 1e-3, `${ba.drained} of ${ba.basins} basins drained to ${ba.drainedDeepest.toFixed(2)} m of the ${BASINS.pond} m asked, none stuck at the ${BASINS.rounds}-round cap`)
  // A kept basin can still be emptied by a dish cut for one of its neighbours -- erosion has collateral effects and the drain does not protect a lake from them -- so `lost` is allowed, and it is the count of kept basins that no longer hold water. `perched` is the other way a deep basin leaves the set: the land within `keepRim` of its water falls `keepDrop` below that water, so it is a pit on a hillside rather than a lake, and it is drained with nothing promoted in its place. What is asserted is that every basin not in one of those two classes came back as a body: a lake the sweeps stopped tracking would be water the doc draws at a level the ground no longer holds.
  check(ba.kept === Math.min(BASINS.keep, ba.basins) && ba.bodies === ba.kept - ba.lost - ba.perched && ba.lost <= 2 && ba.keptDeepest <= BASINS.keepDepth + 1e-3, `the ${ba.kept} deepest kept as ${ba.bodies} bodies over ${ba.keptKm2.toFixed(2)} km2 (${ba.lost} emptied by a neighbour's dish, ${ba.perched} drained as perched), ${ba.keptDeepest.toFixed(1)} m deep of the ${BASINS.keepDepth} m they are held to`)
  // The dish is half the pond's width and never under `minBrush`, because a narrow one cuts a slot down the rim where a broad one takes a saddle out of it. So the drain's footprint is wide and shallow -- a couple of km2 at a few metres mean -- and the one deep figure is the rim of the deepest basin it emptied, which is that basin's own depth and cannot be less.
  check(ba.cutMean > 1 && ba.cutMean < 15 && ba.cutKm2 > 0.5 && ba.cutKm2 < s.landKm2 * 0.3 && ba.brushMean > BASINS.minBrush * 0.5, `the drain cut ${ba.cutMean.toFixed(1)} m mean over ${ba.cutKm2.toFixed(2)} km2 with a ${ba.brushMean.toFixed(0)} m mean dish (widest ${ba.brushMax.toFixed(0)} m), ${ba.deepest.toFixed(0)} m at the deepest`)
  // WHAT THE DRAIN LEAVES IS LEFT LYING WHERE IT IS. No step of the hydrology raises a texel, so water the drain stopped short of still stands in its hollow with nothing drawn in it. On ordinary ground that is the drain's own threshold and the sweeps are what hold it there: a dish digs dips outside the pond it was cutting for, so the field is re-flooded and swept until an enumeration comes up empty, and anything deeper than `pond` left standing means a sweep ran out.
  check(ba.left <= BASINS.pond + 1e-3 && ba.sweeps < BASINS.sweeps, `the drain swept ${ba.sweeps} times of the ${BASINS.sweeps} allowed, re-draining ${ba.late} dips its own dishes dug, and left ${ba.left.toFixed(2)} m standing`)
  check(hs.puddles.deepest <= BASINS.pond + 1e-3 && hs.puddles.km2 < s.landKm2 * 0.05, `${hs.puddles.km2.toFixed(3)} km2 ponds on ordinary ground, ${hs.puddles.mean.toFixed(2)} m mean and ${hs.puddles.deepest.toFixed(2)} m deepest of the ${BASINS.pond} m the drain allows`)
  // The other kind must be none of it, and is structural rather than tuned: ground the drain marked as a kept lake's water that the finished field ponds at some OTHER level, a lobe a later dish cut off from the lake. The doc draws nothing in such a cell. It cannot survive a sweep, because every sweep re-reads each lake off the flood of the field as it then stands -- a cut arm stops being part of the body and is drained as ordinary ground -- and the last sweep always follows the last cut. A count here means that stopped being true.
  check(hs.stranded.cells === 0, `no cell the drain marked as a kept lake's water ponds at another level (${hs.stranded.cells} do)`)

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
  // The lakes are the basins the drain kept and there is no other source of one, so `keep` is the whole ceiling. Some of the kept can still lose their water afterwards, to the outlet notch or to a chain cutting their rim, and those are dropped from the doc rather than drawn dry.
  check(hs.lakes.count >= 3 && hs.lakes.count <= BASINS.keep && hs.lakes.count === hs.lakes.spared - hs.lakes.drained, `${hs.lakes.count} lakes of the ${hs.lakes.spared} basins the drain kept (${hs.lakes.drained} drained out from under their water afterwards)`)
  check(hs.lakes.bodies.every((l) => l.level > 0 && l.deepest >= LAKES.minDepth && l.rx < 1000 && l.rz < 1000), `every lake stands above the sea, ${LAKES.minDepth} m or deeper, inside a kilometre: levels ${hs.lakes.bodies.map((l) => l.level.toFixed(0)).join(', ')} m`)
  // A FIT IS JUDGED ON DEPTH AND NOT ON AREA, IN BOTH DIRECTIONS. v2 draws water wherever the ground inside a record lies under the record's level, so an ellipse overhanging the valley beside its lake draws a sheet standing on the hillside -- a 100 m2 sliver 70 m deep is a wall of water and almost nothing by area, which is how an area bound let it through -- and an ellipse pulled in off its own bed leaves a hollow of the lake drawn as ground. Splitting a forked pool along the ellipse's major axis buys both at once, up to `splitMax` at the one level; past that the two wrongs are traded off against each other by depth, so what is asserted is that neither is more than a few metres anywhere on the island.
  check(hs.lakes.leakDeepest <= 2 && hs.lakes.records >= hs.lakes.count && hs.lakes.records <= hs.lakes.count * LAKES.splitMax, `${hs.lakes.km2.toFixed(3)} km2 of lake in ${hs.lakes.records} ellipses, spilling ${hs.lakes.leakDeepest.toFixed(2)} m at the worst of them (${LAKES.spill} m is what the fit shrinks to reach) over ${hs.lakes.leakKm2.toFixed(4)} km2`)
  check(hs.lakes.dryKm2 < hs.lakes.km2 * 0.02 && hs.lakes.dryDeepest <= 5, `${hs.lakes.dryKm2.toFixed(4)} km2 of lake the ellipses leave dry, ${hs.lakes.dryDeepest.toFixed(1)} m at the deepest`)
  check(hs.rivers.count >= 20 && hs.rivers.km > 10 && hs.rivers.km / s.landKm2 > 1 && hs.rivers.km / s.landKm2 < 6, `${hs.rivers.count} rivers, ${hs.rivers.km.toFixed(1)} km on ${s.landKm2.toFixed(1)} km2 of land, longest ${hs.rivers.longestKm.toFixed(1)} km`)
  check(hs.rivers.intoSea + hs.rivers.intoLake + hs.rivers.fromLake > 0 && hs.rivers.intoSea >= 5 && hs.rivers.fromLake <= hs.lakes.count, `${hs.rivers.intoSea} reach the sea, ${hs.rivers.intoLake} a lake, ${hs.rivers.fromLake} leave one`)
  // TWO CHANNELS A FEW TEXELS APART ARE ONE RIVER. D8 gives every cell one receiver, so without the join a tributary runs a hundred metres beside its own trunk over a divide no higher than the water, and v2 cuts a bed under each polyline: two trenches with a wall between them. The gap is what says the pass is doing that and not reaching across country -- it is a mean over the edges it drew and cannot exceed `joinReach`.
  check(hs.joins.joined > 0 && hs.joins.gapMean <= RIVERS.joinReach, `${hs.joins.joined} river cells drain into a bigger channel within ${RIVERS.joinReach} m instead of running beside it, over a ${hs.joins.gapMean.toFixed(1)} m mean gap`)
  // A RIVER GROWS DOWNSTREAM, which is `tip` and not the catchment exponent: a chain is walked up its largest donor and so keeps a median 0.84 of its mouth's catchment nearly to its head, and no width law honest enough to keep its exponent near a half can flare on that alone. So the taper carries it, and `flare` -- a mouth over that river's own mean width, averaged over the trunks that reach the sea -- is the number that says whether it did.
  check(hs.rivers.flare >= 1.5 && hs.rivers.flare <= 2 && hs.rivers.widthMean > 4 && hs.rivers.widthMax <= RIVERS.maxHalf * 2 + 1e-6, `water ${hs.rivers.widthMean.toFixed(1)} m wide mean (widest ${hs.rivers.widthMax.toFixed(0)} m), mouths x${hs.rivers.flare.toFixed(2)} their own river's mean`)
  // A RIVER FALLS FROM SOURCE TO MOUTH ON THE FIELD ITSELF, EXCEPT ACROSS WATER THAT IS STANDING IN IT. The route is D8 on the FLOODED surface, so over a hollow the drain left the surface is level while the ground under it rises, and the path climbs by at most what is standing there -- `BASINS.pond`, which is the drain's whole contract. Nothing carves that hollow out afterwards (v2 cuts the bed at render time from the polyline), so the bound is the assertion: a climb past it is a river running uphill on dry ground. A source in a lake sits under its own outlet, so that first step is free.
  const half = ((a.n - 1) * a.cell) / 2
  const groundAt = (x, z) => a.height[Math.round((z + half) / a.cell) * a.n + Math.round((x + half) / a.cell)]
  let climbs = 0
  let worstClimb = 0
  let widths = 0
  let mouths = 0
  const lakes = a.doc.lakes.filter((l) => l.y > 0)
  for (const r of a.doc.rivers) {
    for (let k = 2; k < r.pts.length; k++) {
      const rise = groundAt(r.pts[k][0], r.pts[k][1]) - groundAt(r.pts[k - 1][0], r.pts[k - 1][1])
      if (rise > 0.01) {
        climbs++
        if (rise > worstClimb) worstClimb = rise
      }
    }
    for (const p of r.pts) if (!(p[2] >= RIVERS.minHalf && p[2] <= RIVERS.maxHalf)) widths++
    const [mx, mz] = r.pts[r.pts.length - 1]
    const inSea = groundAt(mx, mz) <= 0
    // IN A LAKE MEANS IN ITS WATER, WHICH IS A TEXEL WIDER THAN ITS ELLIPSE. fitLake sizes the ellipse to LAKES.cover of the pool and leaves the shallowest rim outside on purpose, and LAKES.holdDepth is its statement of how deep that rim may be before being drawn as land is a bug. So a mouth standing under a lake's level, no deeper than holdDepth, on that lake's own rim is in the lake: measured, one of these 97 mouths sits at 1.07 of its ellipse's radius under 0.49 m of water, and which mouth lands in the 0.0001 km2 the ellipses leave dry is a coin toss the ladder's amplitudes flip. Asserting the ellipse alone here is asserting the same tolerance twice, once with a hair trigger. A mouth on dry ground stands ABOVE every lake's level and still fails.
    const inLake = lakes.some((l) => {
      const under = l.y - groundAt(mx, mz)
      return footprint(l, mx, mz) > 0 || (under > 0 && under <= LAKES.holdDepth && footprint({ ...l, rx: l.rx * 1.2, rz: l.rz * 1.2 }, mx, mz) > 0)
    })
    const onRiver = a.doc.rivers.some((o) => o !== r && o.pts.some(([x, z]) => Math.hypot(x - mx, z - mz) < a.cell))
    if (!(inSea || inLake || onRiver)) mouths++
  }
  check(worstClimb <= BASINS.pond + 1e-3, `no river climbs past the ${BASINS.pond} m the drain leaves standing: ${climbs} of its nodes climb at all, the worst by ${worstClimb.toFixed(2)} m`)
  check(widths === 0, `every river node carries a half-width in ${RIVERS.minHalf}..${RIVERS.maxHalf} m (${widths} outside)`)
  check(mouths === 0, `every mouth is in the sea, in a lake or on another river (${mouths} are not)`)
  // AND A SOURCE OUT OF A LAKE IS ON THE WATER THE DOC DRAWS. Wet is not drawn: a cell at exactly the lake's level is one the flood wets and the renderer leaves dry, so a river beginning there begins a few metres short of the sheet with a strip of ground between the two. The sources are counted the way the renderer reads them -- inside an ellipse with the ground strictly under that record's level -- and there has to be one for every river the trace called lake-fed. No tolerance here, unlike the mouths above: the walk in chooses the cell and can always choose a drawn one where the lake draws anything at all.
  let onWater = 0
  for (const r of a.doc.rivers) {
    const [sx, sz] = r.pts[0]
    if (lakes.some((l) => groundAt(sx, sz) < l.y && footprint(l, sx, sz) > 0)) onWater++
  }
  check(onWater === hs.rivers.fromLake, `all ${hs.rivers.fromLake} rivers leaving a lake start on the water the doc draws (${onWater} do)`)

  console.log('\n[v3] the document')
  const layers = Layers.deserialize(a.doc)
  check(layers.lakes.lakes.size === 1 + hs.lakes.records && layers.paths.paths.size === hs.rivers.count, `${layers.lakes.lakes.size} lake records (${hs.lakes.count} bodies) and ${layers.paths.paths.size} rivers deserialise`)
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
  // WITH THE FINE RUNGS SUPPLIED, which is how /terrain-v3 boots it: main.js hands the worker `{ seed, cell, jitter }` and the worker makes this same FineJitter from it. Constructing it bare would be testing a configuration the route does not use, and the line below says what the bare one now does instead.
  const height = new V2Height({ heightmap: hm, layers, seed: SEED, relief: RELIEF_DEFAULTS, detail: new FineJitter({ seed: SEED, cell: a.cell }) })
  check(height.detail instanceof FineJitter && height.calibration === null, 'V2Height stands on the supplied rungs and fits no amplitude of its own')
  // WHAT THE BARE FIELD IS FOR: calibrateRough extrapolates the curvature at lags of 4 and 8 m down to a quarter metre and throws if the image already carries more than that, because an import that does is carrying resampling noise and not terrain. It is a NOISE DETECTOR, and it is the one instrument that reads the drain's dishes for smoothness from outside the drain. The field is a terrain by this test: the raw cone and its octaves come to 38% of the extrapolation, and a dish that stood a step at its edge instead of easing into the ground would push the drained field's share up toward it.
  const bare = new V2Height({ heightmap: hm, layers, seed: SEED, relief: RELIEF_DEFAULTS })
  check(bare.calibration !== null && bare.calibration.imageShare > 0.2 && bare.calibration.imageShare < 1, `and the bare 2 m import is a terrain, not resampling noise: it carries ${(bare.calibration.imageShare * 100).toFixed(0)}% of the sub-texel roughness the power law extrapolates`)
  const at = height.heightAt(s.summit.x, s.summit.z)
  check(Math.abs(at - s.summit.h) < 5, `V2Height at the summit reads ${at.toFixed(1)} m`)
  const bands = height.bands
  check(bands.max === s.max, `bands ${bands.min.toFixed(0)}..${bands.max.toFixed(0)} m`)

  // --- the elevation pyramid, §31 ----------------------------------------------
  //
  // What these assert is the one invariant the paging rests on: THE BASE AND THE
  // TILES ARE THE SAME SURFACE AT TWO PITCHES. Registration first, because a
  // half-texel shift between them reads as the island sliding as a tile pages in
  // and is invisible in any single screenshot; then the disc, against the LOD's
  // real selection rather than against the derivation of it.
  console.log('\n[v3] the pyramid: registration')
  // A PLANE, because a symmetric normalised filter reproduces one exactly and an
  // asymmetric one cannot. This is the whole difference between the binomial 5-tap
  // and the box average that was nearly written instead: the box shifts the coarse
  // grid by (factor - 1) / 2 = 1.5 fine texels, which on this ramp is a 4.5 m error
  // at every texel and on the island is the ground sliding under her.
  const RN = 65
  const ramp = new Float32Array(RN * RN)
  for (let j = 0; j < RN; j++) for (let i = 0; i < RN; i++) ramp[j * RN + i] = i * 3 - j * 2
  const dr = decimate(ramp, RN, DECIMATE)
  check(dr.n === baseTexelsFor(RN) && dr.n === 17, `decimate takes ${RN}^2 to ${dr.n}^2, both edges kept`)
  let shift = 0
  // Interior only: the 5-tap clamps at the edges, which bends a plane there on purpose.
  for (let r = 1; r < dr.n - 1; r++) {
    for (let c = 1; c < dr.n - 1; c++) shift = Math.max(shift, Math.abs(dr.data[r * dr.n + c] - ramp[r * DECIMATE * RN + c * DECIMATE]))
  }
  check(shift < 1e-3, `coarse texel c lands exactly on fine texel ${DECIMATE}c: worst ${shift.toExponential(1)} against the 4.5 m a box average would cost`)

  const base = decimate(a.height, a.n, DECIMATE)
  const baseCell = WORLD_SIZE / (base.n - 1)
  check(base.n === baseTexelsFor(a.n) && Math.abs(baseCell - a.cell * DECIMATE) < 1e-9, `the island's base is ${base.n}^2 at ${baseCell.toFixed(1)} m, ${(base.data.byteLength / 1048576).toFixed(2)} MB against ${(a.height.byteLength / 1048576).toFixed(1)} MB`)
  let sq = 0
  let worstBase = 0
  for (let r = 0; r < base.n; r++) {
    for (let c = 0; c < base.n; c++) {
      const d = base.data[r * base.n + c] - a.height[r * DECIMATE * a.n + c * DECIMATE]
      sq += d * d
      worstBase = Math.max(worstBase, Math.abs(d))
    }
  }
  const rms = Math.sqrt(sq / (base.n * base.n))
  // What the filter removed is the 8 m and 16 m jitter rungs and the terrain's own
  // curvature at those lags -- metres, not tens of metres. A failure here means the
  // decimation is describing different ground, not merely smoother ground.
  check(rms < 3 && worstBase < 40, `base against fine at shared texels: ${rms.toFixed(2)} m rms, ${worstBase.toFixed(1)} m worst`)

  console.log('\n[v3] the pyramid: a tile is a window on the same texels')
  const [TX, TZ] = [19, 11]
  const T = tileTexels(a.cell)
  const S = storedTexels(a.cell)
  const tile = cutTile(a.height, a.n, a.cell, TX, TZ)
  check(tile.length === S * S && S === T + 2 * APRON + 1, `a ${TILE_M} m tile at ${a.cell} m is ${S}^2 = ${(tile.byteLength / 1024).toFixed(1)} kB`)
  let exact = true
  for (let j = 0; j <= T && exact; j++) {
    for (let i = 0; i <= T; i++) {
      if (tile[(APRON + j) * S + APRON + i] !== a.height[(TZ * T + j) * a.n + TX * T + i]) {
        exact = false
        break
      }
    }
  }
  check(exact, 'every texel of the tile is the generator\'s own metre, apron included')

  const store = new TileStore({ cell: a.cell })
  store.put(tileKey(TX, TZ), tile)
  // On a texel, where bilinear has to return that texel and nothing else.
  const px = -WORLD_HALF + (TX * T + 7) * a.cell
  const pz = -WORLD_HALF + (TZ * T + 5) * a.cell
  const want = a.height[(TZ * T + 5) * a.n + TX * T + 7]
  check(Math.abs(store.sample(px, pz) - want) < 1e-3, `TileStore.sample on a texel reads it exactly: ${store.sample(px, pz).toFixed(2)} m`)
  check(Number.isNaN(store.sample(px + TILE_M * 2, pz)), 'and NaN where no tile is resident, which is what the Heightmap falls through on')
  check(store.bytes === S * S * 4 && store.size === 1, `store.bytes reports ${(store.bytes / 1024).toFixed(1)} kB for the one tile`)

  const hmBase = Heightmap.fromRaw({ width: base.n, height: base.n, data: base.data, meta: { ...a.meta, size: base.n } })
  const coarseRead = hmBase.sample(px, pz)
  hmBase.attachTiles(store)
  check(Math.abs(hmBase.sample(px, pz) - want) < 1e-3, `attachTiles puts sample() on the fine texel (${want.toFixed(2)} m) where the base read ${coarseRead.toFixed(2)} m`)
  check(hmBase.tiled && hmBase.view().tiled, 'and a view carries the tiles, which is what the reconstruction is built on')
  const away = { x: px + TILE_M * 3, z: pz }
  const awayBase = Heightmap.fromRaw({ width: base.n, height: base.n, data: base.data, meta: { ...a.meta, size: base.n } })
  check(hmBase.sample(away.x, away.z) === awayBase.sample(away.x, away.z), 'and outside the resident set it is the base, unchanged')

  console.log('\n[v3] the pyramid: the disc covers every sub-base vertex')
  // THE LOAD-BEARING CHECK. pageRadius is derived from selectNodes' refine test, so
  // this runs the real selectNodes and asserts the derivation: no node drawn at a
  // cell finer than a base texel has a vertex outside the disc. Bounds are left NULL
  // on purpose -- nodeRange without them ignores the camera's height, which is the
  // MOST refinement any camera can provoke, so it is the case to be covered.
  const cams = [
    { x: 0, z: 0 },
    { x: 137, z: -2041 },
    { x: -WORLD_HALF + 3, z: -WORLD_HALF + 3 },
    { x: 1024, z: 1024 },
    { x: 1023.5, z: -128.5 },
  ]
  for (const triDeg of [MIN_TRI_DEG, 3.0, 4.0, 7.0]) {
    const radius = pageRadius(triDeg, baseCell)
    let worst = 0
    let fine = 0
    for (const cam of cams) {
      for (const nd of selectNodes(cam, { triDeg, info: null })) {
        if (nd.size / CHUNK_RES >= baseCell) continue
        fine++
        for (const cx of [nd.x, nd.x + nd.size]) {
          for (const cz of [nd.z, nd.z + nd.size]) worst = Math.max(worst, Math.hypot(cx - cam.x, cz - cam.z))
        }
      }
    }
    check(worst <= radius, `triDeg ${triDeg}: ${fine} sub-base nodes, farthest vertex ${worst.toFixed(0)} m, disc ${radius.toFixed(0)} m`)
  }
  // The margin is the prefetch: a tile is admitted this far before anything over it
  // can refine past the base, which is what keeps a chunk from meshing coarse and
  // then re-meshing as the tile lands.
  check(pageRadius(4, baseCell) - baseCell / Math.tan((4 * Math.PI) / 180) > TILE_M / 2, `the disc leads the reach by ${(pageRadius(4, baseCell) - baseCell / Math.tan((4 * Math.PI) / 180)).toFixed(0)} m at triDeg 4, over half a tile of prefetch`)

  console.log('\n[v3] the pyramid: what stays resident')
  const perTile = storedTexels(a.cell) ** 2 * 4
  const classes = subsampleClasses(a.ground, a.n, DECIMATE)
  check(classes.length === base.n * base.n, `the class grid coarsens to ${base.n}^2, ${(classes.byteLength / 1048576).toFixed(2)} MB against ${(a.ground.byteLength / 1048576).toFixed(1)} MB`)
  let nearest = true
  for (let r = 0; r < base.n && nearest; r++) {
    for (let c = 0; c < base.n; c++) {
      if (classes[r * base.n + c] !== a.ground[r * DECIMATE * a.n + c * DECIMATE]) {
        nearest = false
        break
      }
    }
  }
  check(nearest, 'by taking the label at the kept texel and never a mean of two biomes')
  for (const triDeg of [3.0, 4.0, MIN_TRI_DEG]) {
    const tiles = tilesForRadius(pageRadius(triDeg, baseCell))
    const resident = base.data.byteLength + classes.byteLength + tiles * perTile
    // Three holders: this page for collision and two mesh workers, which do not share
    // memory (see the transfer-list note in terrain-v2.js). The number to beat is the
    // 252 MB the un-paged 2 m island cost across the same three.
    check(resident * 3 < 24 * 1048576, `triDeg ${triDeg}: ${tiles} tiles bounded, ${(resident / 1048576).toFixed(2)} MB a holder, ${((resident * 3) / 1048576).toFixed(1)} MB over three`)
  }
  // `tilesForRadius` is the square bound the memory claim above is made against; the
  // disc clips the corners off that square, so the count actually asked for is lower.
  // Swept over a tile's worth of eye offsets, because the count turns on where in a
  // tile the eye stands, not on which tile it is in.
  const radius3 = pageRadius(3.0, baseCell)
  let peak = 0
  for (let i = 0; i <= 32; i++) {
    for (let j = 0; j <= 32; j++) peak = Math.max(peak, tilesWithin((i * TILE_M) / 32, (j * TILE_M) / 32, radius3).length)
  }
  check(peak <= tilesForRadius(radius3), `the disc never asks for more than the ${tilesForRadius(radius3)}-tile bound: worst of 1089 eye offsets is ${peak}, ${((peak * perTile) / 1024).toFixed(0)} kB`)
  const mid = tilesWithin(-WORLD_HALF + TILE_M * 6.5, -WORLD_HALF + TILE_M * 6.5, radius3)
  check(mid.length < peak, `and standing mid-tile wants ${mid.length}, ${((mid.length * perTile) / 1024).toFixed(0)} kB`)

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
