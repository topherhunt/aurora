// Node-side gates for the strewn ground litter: the pebble scatter in src/v2/render/litter.js, which beds one twenty-triangle stone into the hill tens of thousands of times inside a few strides of the player.
//
//   node scripts/check-litter.mjs
//
// WHAT THIS FILE CAN AND CANNOT SEE. Everything below runs Litter headless on stub worlds -- a flat wood, a peak, a face, a lake bed, a shore, a sine ridge -- and reads back what it decided: where the stones landed, how many, how big, how deep, which way up, what colour. There is no GL context, so nothing here asserts anything about pixels; if the material, the lighting patch or the atlas regress, this gate stays green and only the screen will tell you.
//
// The private tuning constants are read out of the module SOURCE (see srcOf below) rather than re-typed here, so a retune moves the bounds with it and a check that is really "the number in the file is the number in the file" cannot pass by accident.

import { readFileSync } from 'node:fs'

import THREE from '../src/three-instance.js'

import { ROCK_TIERS } from '../src/props/rock.js'
import { setPropClock } from '../src/material.js'
import { buildTextureArray } from '../src/textures.js'
import { Litter, buildPebble, PEBBLE_TIER } from '../src/v2/render/litter.js'
import { shade } from '../src/v2/terrain/chunk-mesh-v2.js'

let failures = 0
const check = (ok, label, detail = '') => {
  const tag = ok ? '  ok ' : 'FAIL '
  console.log(`${tag} ${label}${detail ? `\n       ${detail}` : ''}`)
  if (!ok) failures++
}

// The reader for the private constants. Anchored to `^const NAME = ` so a number that only appears in a COMMENT can never be picked up, and throwing rather than defaulting when the shape of the line changes -- a gate that quietly substitutes a fallback for a constant it can no longer find is worse than no gate.
const SRC = readFileSync(new URL('../src/v2/render/litter.js', import.meta.url), 'utf8')
const srcOf = (name, pattern) => {
  const m = SRC.match(new RegExp(`^(?:export )?const ${name} = ${pattern}$`, 'm'))
  if (!m) throw new Error(`check-litter: could not read ${name} out of src/v2/render/litter.js -- the line has changed shape and the regex in this gate needs updating`)
  return m
}
const srcNum = (name) => Number(srcOf(name, '(-?[0-9.]+)')[1])
const srcPair = (name) => srcOf(name, '\\[(-?[0-9.]+), (-?[0-9.]+)\\]').slice(1, 3).map(Number)
// `const CLIFF_TAN = Math.tan((42 * Math.PI) / 180)` -- the degrees are what this gate wants to compare against MAX_SLOPE_DEG, so read the 42 rather than the tangent.
const srcDeg = (name) => Number(srcOf(name, 'Math\\.tan\\(\\((-?[0-9.]+) \\* Math\\.PI\\) / 180\\)')[1])
const srcRates = (name) => JSON.parse(`{${srcOf(name, '\\{([^}]*)\\}')[1].replace(/([A-Za-z_]\w*):/g, '"$1":')}}`)

const MAX_SLOPE_DEG = srcNum('MAX_SLOPE_DEG')
const CLIFF_DEG = srcDeg('CLIFF_TAN')
const SIZE = srcPair('SIZE')
const SIZE_POW = srcNum('SIZE_POW')
const STRETCH = srcPair('STRETCH')
const FLAT = srcPair('FLAT')
const SINK = srcPair('SINK')
const TONE = srcPair('TONE')
const ENV_DENSITY = srcRates('ENV_DENSITY')
const CLUMP_FLOOR = srcNum('CLUMP_FLOOR')
const CLUMP_GAIN = srcNum('CLUMP_GAIN')
const CLUMP_CELL = srcNum('CLUMP_CELL')
const FINE_CELL = srcNum('FINE_CELL')
const FINE_SWING = srcNum('FINE_SWING')
const SNOW_KEEP = srcNum('SNOW_KEEP')
const GROUND_SHARE = srcNum('GROUND_SHARE')
const DENSITY = srcNum('DENSITY')
const TILE = srcNum('TILE')
const FULL_RADIUS = srcNum('FULL_RADIUS')
const RADIUS = srcNum('RADIUS')

console.log('\n=== litter checks: one T20 pebble, scattered ===\n')

// ---------------------------------------------------------------------------
// 1. The stone itself.
// ---------------------------------------------------------------------------
//
// One geometry for the whole layer, and everything the layer costs is a multiple of what it has. Twenty faces is the coarsest rung of the rock ladder and is the whole argument for the layer being geometry at all; a rung that grew would multiply the tri count of every pebble on the ground without any count in the panel changing.

console.log('pebble')

{
  const geo = buildPebble()
  const tris = geo.index.count / 3
  const want = ROCK_TIERS[PEBBLE_TIER].faces
  check(tris === want && tris <= 20, 'the pebble is the coarsest rung of the rock ladder: twenty triangles, closed, and nothing more',
    `${tris} tris, ${geo.attributes.position.count} verts, rung ${PEBBLE_TIER} of ${ROCK_TIERS.length} is ${want} faces`)

  // Built at unit size so the matrix scale is metres of stone directly. `size` is buildRock's largest horizontal extent, so the measured width is 1 and the height is the fraction the sink is taken of.
  const m = geo.userData.rock.measured
  check(Math.abs(m.width - 1) < 1e-6 && m.height > 0.3 && m.height < 0.8,
    'and it is built at unit width, standing a plausible fraction of that tall, so the matrix scale is metres of pebble',
    `width ${m.width.toFixed(4)} m, depth ${m.depth.toFixed(3)}, height ${m.height.toFixed(3)}`)

  // Closed underneath: the half of the pebble under the ground is culled as back faces and never bedded on a skirt. A `sit` build would leave the underside open and the ground's cut through it would show the inside.
  geo.computeBoundingBox()
  check(geo.boundingBox.min.y <= 1e-6 && geo.boundingBox.min.y > -m.height * 0.5,
    'and its bed plane is y = 0, so a pebble sunk by a fraction of its height is sunk by that much and no more',
    `bounding box y ${geo.boundingBox.min.y.toFixed(4)} to ${geo.boundingBox.max.y.toFixed(4)}`)
  geo.dispose()
}

// ---------------------------------------------------------------------------
// 2. Stones on the ground you walk on, counted per square metre.
// ---------------------------------------------------------------------------
//
// The stubs are check-rocks.mjs's, verbatim in shape, because Litter needs exactly what Rocks needs: a field with scatterAt / heightAt / snowLineAt / bands, a water surface with levelAt -- which both the environment test and the wet pass go through, isSubmerged being spelled out inline there rather than called -- and a Layers with flattenAt and a snow band for the ground cue. `bands` is 0..900 m, the world's own altitude span. No `ground` is passed: headless, so _groundFor falls through to the field's own height, which is what makes the sink assertions in section 7 exact.

console.log('\ndensity')

const world = (h, tan, snowLine, level) => ({
  field: {
    scatterAt: (x, z, cell, out) => {
      if (!(cell > 0)) throw new Error('scatterAt needs a positive cell')
      out.h = h
      out.tan = tan
      return out
    },
    heightAt: () => h,
    snowLineAt: () => snowLine,
    bands: { altLo: 0, altSpan: 900 },
  },
  water: {
    levelAt: () => level,
    isSubmerged: (x, z, groundY) => level !== null && level > groundY,
  },
})

// A world with real RELIEF in it, which no flat stub can have, and the only one here where the slope test partly bites instead of refusing everything or nothing. Amplitude and wavelength are check-rocks.mjs's: tan tops out at 1.10 (48 deg), so a stretch of the ridge is past MAX_SLOPE_DEG and the rest is walkable ground. `tan` is the field's own analytic gradient rather than a constant, so the slope the scatter tests and the height the pebbles are bedded on describe one hill rather than two.
const RIDGE_A = 22
const RIDGE_L = 20
const ridge = {
  field: {
    scatterAt: (x, z, cell, out) => {
      if (!(cell > 0)) throw new Error('scatterAt needs a positive cell')
      out.h = 900 + RIDGE_A * Math.sin(x / RIDGE_L)
      out.tan = Math.abs((RIDGE_A / RIDGE_L) * Math.cos(x / RIDGE_L))
      return out
    },
    heightAt: (x) => 900 + RIDGE_A * Math.sin(x / RIDGE_L),
    snowLineAt: () => 1000,
    bands: { altLo: 0, altSpan: 900 },
  },
  water: { levelAt: () => null, isSubmerged: () => false },
}

const scatterLayers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }
const texArray = buildTextureArray()

const SEED = 7
const build = (w, seed = SEED) => {
  const l = new Litter(new THREE.Scene(), w.field, w.water, scatterLayers, texArray, { seed })
  l.place(0, 0)
  return l
}

// `face` is 40.7 deg: past MAX_SLOPE_DEG and, deliberately, still short of the 42 deg _envAt calls a cliff. See section 3. `peak` is high ground 50 m under its snow line, which _envAt calls `peak` (PEAK_BELOW_SNOW is 55) and shade() paints bare (the snow band is 90 m, centred on the line, so cover starts 45 m under it); `snow` is the same ground 70 m above the line, fully white. `lake` puts the water level above the ground so everything is submerged; `shore` puts it 0.5 m BELOW the ground, which _envAt still reads as `river` -- the same environment name, nothing under water.
const worlds = {
  forest: build(world(60, 0, 9999, null)),
  face: build(world(60, 0.86, 9999, null)),
  peak: build(world(850, 0.5, 900, null)),
  snow: build(world(950, 0.5, 880, null)),
  lake: build(world(60, 0, 9999, 60.8)),
  shore: build(world(60, 0, 9999, 59.5)),
  ridge: build(ridge),
}

const liveIds = (l) => {
  const out = []
  for (const t of l.tiles.values()) for (let k = 0; k < t.n; k++) out.push(t.ids[k])
  return out
}
// Stones per square metre inside the full-density radius. Counted inside `fullRadius` and nowhere else, because past it the graded thinning takes over and a disc that straddled the boundary would report the thinning rather than the density.
const nearCount = (l) => liveIds(l).filter((id) => l.instX[id] ** 2 + l.instZ[id] ** 2 < l.fullSq).length
const perM2 = (l) => nearCount(l) / (Math.PI * l.fullRadius * l.fullRadius)
// What the dry pass laid: every candidate that reached the terrain and was refused by nothing. Rock refusals are zero on every stub here (no `rocks` is passed).
const dryLaid = (s) => s.samples - s.rejected.slope - s.rejected.env

{
  // The regexes above, checked against the constants the class re-exposes. If one of them has gone stale every bound in this file is being measured against a number the module no longer holds.
  const l = worlds.forest
  const readBack = Math.atan(l.maxSlopeTan) * (180 / Math.PI)
  check(Math.abs(readBack - MAX_SLOPE_DEG) < 1e-9 && l.fullRadius === FULL_RADIUS && l.radius === RADIUS && l.tile === TILE &&
    l.perTile === Math.max(1, Math.round(l.tile * l.tile * DENSITY)),
    'the constants this gate read out of the module source are the ones the class is actually running on',
    `MAX_SLOPE_DEG ${MAX_SLOPE_DEG} = atan(maxSlopeTan) ${readBack.toFixed(3)}, FULL_RADIUS ${FULL_RADIUS}, RADIUS ${RADIUS}, DENSITY ${DENSITY} -> ${l.perTile} candidates per ${l.tile} m tile`)

  // The drift lattice has to be coarser than the tile, or the drifts line up with the tile grid and the seams show as rows.
  check(CLUMP_CELL > TILE, 'and the drift lattice is coarser than the tile it is sampled in', `CLUMP_CELL ${CLUMP_CELL} m over TILE ${TILE} m`)
}

{
  // STONES PER SQUARE METRE ON THE GROUND SHE WALKS, TWO-SIDED. Measured at seed 7 inside the 8 m full-density radius: see the printout; §22 carries the table.
  //
  // THE FLOOR IS THE SPARSE END: under about half a stone per square metre the ground reads as bare with the odd pebble on it, which is what the layer exists not to be. THE CEILING IS THE PAVED END: past two a stone every 70 cm in every direction is a gravel yard, and it is also where the instance count stops being a few tens of thousands. Counting noise on ~200 stones is about 7%, so both ends are several times clear of a seed change. The shore is not in the walked set because it saturates (section 5) and would not move with DENSITY.
  const DENSITY_BAND = [0.6, 2.0]
  const walked = ['forest', 'peak']
  const dens = walked.map((n) => perM2(worlds[n]))
  check(dens.every((d) => d > DENSITY_BAND[0] && d < DENSITY_BAND[1]),
    'the ground you walk on has stones on it, enough to notice and few enough to read as strewn',
    walked.map((n, i) => `${n} ${dens[i].toFixed(2)} per m² (${nearCount(worlds[n])} inside ${FULL_RADIUS} m)`).join(', ') +
      `, shore ${perM2(worlds.shore).toFixed(2)}, band ${DENSITY_BAND[0]}-${DENSITY_BAND[1]}`)
}

{
  // AND SNOW COVERS MOST OF IT. The same peak under full snow cover carries about SNOW_KEEP of the bare peak's stone -- somewhat under it, because the bare peak's rate saturates at the top of the drift and the snowed one never does. A band about the constant rather than a ratio check on one draw, since counting noise on ~70 stones is 12%.
  const bare = nearCount(worlds.peak)
  const snowed = nearCount(worlds.snow)
  const ratio = snowed / bare
  check(worlds.snow._envAt(0, 0, 950, 0.5, 880) === 'peak' && worlds.peak._envAt(0, 0, 850, 0.5, 900) === 'peak' &&
    ratio > SNOW_KEEP * 0.5 && ratio < SNOW_KEEP * 1.3 && snowed > 20,
    'a snowfield keeps about a quarter of the stone the same bare ground carries',
    `${snowed} on snow against ${bare} bare inside ${FULL_RADIUS} m, ${ratio.toFixed(2)}x against SNOW_KEEP ${SNOW_KEEP}`)
}

{
  // AND A FACE IS NOT STREWN GROUND. On the sine ridge the steep stretches are past the slope limit, so the litter thins, and that is the answer wanted there rather than a failure. Counted over the WHOLE resident disc rather than inside the full radius, because the ridge's steepest face is at x = 0 and the 8 m disc there is all of it refused -- the walkable ground begins 18 m out, in the thinned tail, and is about a quarter of the resident disc. Both worlds hold the same tiles at the same thinning levels and both are bare `forest`, so the ratio of totals is the slope test's share alone, thinned. Two-sided: it must thin (a ridge as strewn as a wood means the slope test is not biting) and it must not empty (a hill with no litter on any of its walkable ground means the test is biting everything).
  const RIDGE_THIN = [0.06, 0.5]
  const ratio = worlds.ridge.stats.placed / worlds.forest.stats.placed
  const s = worlds.ridge.stats
  check(ratio > RIDGE_THIN[0] && ratio < RIDGE_THIN[1] && s.placed > 0 && s.rejected.slope > 0,
    'and litter thins out where the hill stands up, without abandoning the walkable ground between the faces',
    `${s.placed} pebbles on the ridge against ${worlds.forest.stats.placed} in the wood over the same tiles, ${ratio.toFixed(2)}x (band ${RIDGE_THIN[0]}-${RIDGE_THIN[1]}), ${s.rejected.slope} of ${s.samples} candidates refused for slope`)
}

// ---------------------------------------------------------------------------
// 3. A steep face, and the branch of ENV_DENSITY that cannot be reached.
// ---------------------------------------------------------------------------
//
// "The face world places zero" is a one-sided bound and would stay green for the wrong reason -- an ENV_DENSITY.cliff that had gone to zero for the wrong ground, an environment test misnaming the slope, a scatter that had stopped placing anything anywhere. So what is asserted is the MECHANISM: the slope test refused every candidate that survived the drift field, and nothing else refused anything.

console.log('\nslope')

{
  const s = worlds.face.stats
  // `samples` is incremented after the drift test and before the slope test, so `slope === samples` says exactly "every candidate that reached the terrain was refused for being too steep" without this file having to know how many candidates a tile rolls.
  check(s.placed === 0 && s.rejected.slope === s.samples && s.rejected.env === 0,
    'a steep face gets no litter, and it is the slope test that refuses it rather than anything downstream',
    `${s.placed} placed, ${s.rejected.slope} of ${s.samples} refused for slope, env ${s.rejected.env}`)
}

{
  // THE TRAP DOCUMENTED AT ENV_DENSITY, ASSERTED. MAX_SLOPE_DEG is strictly below the angle _envAt calls a cliff (CLIFF_TAN, 42 deg), so no candidate can ever carry the name `cliff` into the environment test -- the slope test has already said no. ENV_DENSITY.cliff is therefore dead code held at 0 on purpose, so that raising MAX_SLOPE_DEG past 42 cannot quietly start bedding pebbles into vertical rock.
  //
  // Both halves are asserted, and the first is asserted twice over: once as arithmetic on the two constants, and once by asking the live _envAt what it calls the STEEPEST ground the scatter will admit.
  const steepest = worlds.face._envAt(0, 0, 60, worlds.face.maxSlopeTan, 9999)
  check(MAX_SLOPE_DEG < CLIFF_DEG && steepest !== 'cliff' && ENV_DENSITY.cliff === 0,
    'no pebble can ever reach the `cliff` rate, so it is held at zero rather than at a plausible-looking number',
    `MAX_SLOPE_DEG ${MAX_SLOPE_DEG} deg < CLIFF_TAN's ${CLIFF_DEG} deg, the steepest admitted ground is \`${steepest}\`, ENV_DENSITY.cliff ${ENV_DENSITY.cliff}`)
}

// ---------------------------------------------------------------------------
// 4. Under the water, and beside it.
// ---------------------------------------------------------------------------
//
// Two worlds and the same environment name in both, which is the whole point of the pair. `river` above the ground and `river` below it are the same rate to ENV_DENSITY, so the environment test cannot be what makes a bed denser than a bank -- it is saturated on both and has nothing left to give. What separates them is the WET PASS, which offers WET_DENSITY more candidates per square metre out of tileSeed slot 1 and throws away everything not standing under water.

console.log('\nwater')

{
  // THE BED IS LITTERED AND IT IS THE SECOND PASS THAT DOES IT. Asserted as the mechanism rather than as the count, because "the lake world places a lot" would stay green on a dry pass that had simply stopped testing water while the wet pass did nothing. `samplesWet` is incremented only by candidates that cleared the drift floor AND found a water level; `rejectedWet.dry` is every wet candidate thrown out for standing on land, and on a world that is water everywhere there is no land for one to stand on.
  //
  // The last clause is what makes it a gate on the EXTRA stone rather than on any stone: the dry pass places at most one pebble per candidate that reached the terrain, which is exactly `samples`, so `placed > samples` can only be the second stream's doing.
  const s = worlds.lake.stats
  const wetLaid = s.samplesWet - s.rejectedWet.dry - s.rejectedWet.slope - s.rejectedWet.env
  check(s.samplesWet > 0 && s.rejectedWet.dry === 0 && s.placed > s.samples && s.placed === dryLaid(s) + wetLaid && wetLaid > 0,
    'a lake bed is littered, and it is the wet pass that lays the extra stone rather than the dry one being turned up',
    `${s.placed} placed = ${dryLaid(s)} of ${s.samples} dry samples + ${wetLaid} of ${s.samplesWet} wet, ${s.rejectedWet.dry} wet candidates refused for being on dry land, ` +
      `wet slope ${s.rejectedWet.slope}, wet env ${s.rejectedWet.env} against the dry pass's ${s.rejected.env}, ${perM2(worlds.lake).toFixed(2)} per m²`)
}

{
  // The same _envAt name on both worlds, asked of the live method rather than assumed. Shingle is the densest ground in the world wet or dry, and the BED is denser than the BANK -- which is the shape the two passes make and the one a single pass cannot.
  //
  // The bank is the dry pass alone, and that is asserted rather than described: on the shore every wet candidate that cleared the drift floor is refused for standing on dry ground, so `placed === dryLaid` says the bank's density is the dry pass's rate and nothing else.
  const lakeEnv = worlds.lake._envAt(0, 0, 60, 0, 9999)
  const shoreEnv = worlds.shore._envAt(0, 0, 60, 0, 9999)
  const s = worlds.shore.stats
  const others = ['forest', 'peak'].map((n) => nearCount(worlds[n]))
  check(lakeEnv === 'river' && shoreEnv === 'river' &&
    s.rejectedWet.dry === s.samplesWet && s.placed === dryLaid(s) &&
    nearCount(worlds.shore) > Math.max(...others) && nearCount(worlds.lake) > nearCount(worlds.shore),
    'river shingle is the densest ground in the world wet or dry, and the bed carries more of it than the bank',
    `both worlds are \`${shoreEnv}\`; the bank places ${s.placed} from ${s.samples} dry samples with all ${s.samplesWet} of its wet candidates refused for dry land, ` +
      `${nearCount(worlds.lake)} pebbles on the bed against ${nearCount(worlds.shore)} on the bank inside ${FULL_RADIUS} m, and ${others.join(' and ')} on the grounds a player walks`)
}

// ---------------------------------------------------------------------------
// 5. The drift field.
// ---------------------------------------------------------------------------
//
// Loose stone lies in drifts with swept ground between them, and a scatter without that reads as an even sprinkle, which is the tell that says "generated" faster than any amount of per-instance variety can undo. _clump is four hashes of position taken BEFORE the terrain sample, so the candidates it throws away are very nearly free.

console.log('\ndrift')

{
  // A BAND, because both ends are a real failure: reject nothing and there are no drifts at all, reject nearly everything and there is no litter left to arrange into them. The field is bilinear value noise and piles up around 0.5, so the true share at a floor of 0.34 is about a quarter.
  const SHARE_BAND = [0.12, 0.45]
  const s = worlds.forest.stats
  const share = s.rejected.clump / (s.rejected.clump + s.samples)
  check(share > SHARE_BAND[0] && share < SHARE_BAND[1],
    'the litter lies in drifts with swept ground between them, not in an even sprinkle',
    `${s.rejected.clump} of ${s.rejected.clump + s.samples} candidates swept away, ${(share * 100).toFixed(1)}%, band ${(SHARE_BAND[0] * 100).toFixed(0)}-${(SHARE_BAND[1] * 100).toFixed(0)}%`)
}

{
  // AND IT IS POSITION-ONLY, which is what makes it free. The drift draws no randoms, so the SAME candidates are swept on every world -- an identical count across six completely different hills is the observable proof, and it is what would break the moment somebody moved the test below the terrain sample or gave it a random of its own (which would also reshuffle every pebble in the world, see _draw).
  const counts = Object.entries(worlds).map(([n, l]) => [n, l.stats.rejected.clump])
  const distinct = new Set(counts.map(([, c]) => c))
  check(distinct.size === 1, 'and the drift is a function of position alone, taken before the ground is ever sampled',
    counts.map(([n, c]) => `${n} ${c}`).join(' '))
}

{
  // AND IT IS STILL DECIDING SOMETHING WHEN IT GETS THERE. The accept test is `envRoll >= ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump) * swing * snow`, taken here with the fine swing at its mean of 1 and no snow, and every candidate that reaches it has already cleared CLUMP_FLOOR -- so an environment whose rate at the FLOOR is already 1 refuses nothing the coarse drift can move, and the gain above it is inert. `river` is the one that IS saturated, on purpose, and only the fine swing's low half thins it -- so the shore still refuses some candidates, and far fewer than the wood; `cliff` is zero and unreachable and is skipped by name. What is left is the two grounds a player walks: `forest` is live across the whole field, and `peak` is live from the floor up to its cap and saturated above.
  const rateAt = (env, clump) => ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump)
  // The clump at which an environment's rate reaches 1 and the drift stops mattering. At or below CLUMP_FLOOR means saturated everywhere; above 1 means live over the whole field.
  const capAt = (env) => (1 / ENV_DENSITY[env] - 1) / CLUMP_GAIN
  const live = Object.keys(ENV_DENSITY).filter((e) => ENV_DENSITY[e] > 0)
  const skipped = Object.keys(ENV_DENSITY).filter((e) => !(ENV_DENSITY[e] > 0))
  const others = live.filter((e) => e !== 'river')
  const envRejects = { river: worlds.shore.stats.rejected.env, forest: worlds.forest.stats.rejected.env, peak: worlds.peak.stats.rejected.env }

  const table = live.map((e) => {
    const cap = capAt(e)
    const where = cap <= CLUMP_FLOOR ? `from ${cap.toFixed(2)}, under the floor, so always` : cap > 1 ? 'nowhere in the range' : `from clump ${cap.toFixed(2)}`
    return `${e} ${rateAt(e, CLUMP_FLOOR).toFixed(3)} at the floor and ${rateAt(e, 1).toFixed(3)} at the ceiling, saturated ${where}`
  }).join('; ')

  check(skipped.join(' ') === 'cliff' && ENV_DENSITY.cliff === 0 &&
    capAt('river') <= CLUMP_FLOOR && others.every((e) => capAt(e) > CLUMP_FLOOR) && capAt('forest') > 1 &&
    envRejects.river > 0 && envRejects.river < envRejects.forest / 2 && envRejects.forest > 0 && envRejects.peak > 0,
    'the drift field still decides something on every ground except river shingle, where saturation is the point',
    `${table} (clump floor ${CLUMP_FLOOR}, gain ${CLUMP_GAIN}, \`cliff\` skipped by name at rate ${ENV_DENSITY.cliff}); ` +
      `live, the shore refuses ${envRejects.river} candidates for env -- the fine swing's low half alone -- against the wood's ${envRejects.forest} and the peak's ${envRejects.peak}`)
}

{
  // THE FINE FIELD IS LIVE AT THE STRIDE SCALE. The coarse lattice is 12 m; what varies the density from one stride to the next is the fine one, and the proof is in the counts: the wood inside the full radius, binned into FINE_CELL squares, has a spread of stones per square well past counting noise -- a Poisson field at the same mean would put its standard deviation at sqrt(mean). Two-sided on the ratio: under 1.3x is a sprinkle with a lattice nobody can see, over 3x is a field that is mostly empty cells and a few heaps.
  const l = worlds.forest
  const bins = new Map()
  for (const id of liveIds(l)) {
    if (l.instX[id] ** 2 + l.instZ[id] ** 2 >= l.fullSq) continue
    const k = `${Math.floor(l.instX[id] / FINE_CELL)}|${Math.floor(l.instZ[id] / FINE_CELL)}`
    bins.set(k, (bins.get(k) || 0) + 1)
  }
  // Every fine cell whose centre is inside the disc, empty ones included.
  const r = Math.ceil(l.fullRadius / FINE_CELL)
  for (let iz = -r; iz <= r; iz++) {
    for (let ix = -r; ix <= r; ix++) {
      if (((ix + 0.5) * FINE_CELL) ** 2 + ((iz + 0.5) * FINE_CELL) ** 2 >= l.fullSq) continue
      const k = `${ix}|${iz}`
      if (!bins.has(k)) bins.set(k, 0)
    }
  }
  const counts = [...bins.values()]
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length)
  const over = sd / Math.sqrt(mean)
  check(FINE_CELL < TILE && FINE_SWING > 0 && over > 1.3 && over < 3,
    'and the density varies from one stride to the next, well past what a random sprinkle at the same mean would',
    `${counts.length} cells of ${FINE_CELL} m inside ${FULL_RADIUS} m, ${mean.toFixed(1)} stones each, sd ${sd.toFixed(2)} = ${over.toFixed(2)}x Poisson's ${Math.sqrt(mean).toFixed(2)} (band 1.3-3), swing ±${FINE_SWING}`)
}

// ---------------------------------------------------------------------------
// 6. The instance pool.
// ---------------------------------------------------------------------------
//
// _poolBound running short does not degrade, it THROWS: `Litter: instance pool exhausted`. So the bound has to cover the densest ground in the world and a walk across the most broken one, and the check has to be two-sided, because a pool that is never more than a tenth full is an arena allocation nobody is using.

console.log('\npool')

{
  const FULL_BAND = [0.15, 0.95]
  const used = (l) => l.maxInstances - l.freeCount
  const densest = worlds.lake

  // The traverse: 400 steps across the ridge, draining the queue at each one so every tile is grown at every quantised level rather than at the handful the budget would allow in a frame. This is the case a single `place` cannot reach, because it never evicts and regrows anything.
  const walk = build(ridge)
  let peak = 0
  for (let i = 0; i < 400; i++) {
    walk.update(i * 3.1, 900, i * 1.7)
    while (walk.queue.length) walk._growTile(walk.queue.pop())
    peak = Math.max(peak, used(walk))
  }

  // Measured: the lake bed, the densest ground there is, uses 4480 of 14882 (30%), and the traverse peaks well under that. The bound assumes every tile in range is lake bed AND that both passes survive in full, which is why a real world sits at a third of it; the floor catches a bound that has run away from that.
  const worst = Math.max(used(densest), peak) / densest.maxInstances
  check(used(densest) < densest.maxInstances && worst < FULL_BAND[1] && worst > FULL_BAND[0],
    'the pool covers the densest ground in the world and a walk across the roughest, without being sized for a world that does not exist',
    `lake ${used(densest)}/${densest.maxInstances} (${((used(densest) / densest.maxInstances) * 100).toFixed(0)}%), ridge traverse peak ${peak} (${((peak / walk.maxInstances) * 100).toFixed(0)}%), band ${(FULL_BAND[0] * 100).toFixed(0)}-${(FULL_BAND[1] * 100).toFixed(0)}%`)

  check(densest.placed > 0 && densest.freeCount > 0, 'and the densest ground in the world never ran it dry',
    `${densest.freeCount} instances still free after ${densest.placed} pebbles`)
  walk.dispose()
}

// ---------------------------------------------------------------------------
// 7. Every pebble is bedded into the ground, lying flat on it, and shaped.
// ---------------------------------------------------------------------------
//
// Read back off the instance matrices the scatter actually wrote, decomposed, rather than off the arrays it kept. The ridge is what the sink and the tilt are measured on, because a flat world has a normal of exactly up and would keep the tilt promise by doing nothing at all; the flat shore is what the yaw and the shape are measured on, because there the rotation IS the yaw and the scale falls straight out of the columns.

console.log('\nbedding')

const columns = (m) => {
  const e = m.elements
  return [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])]
}

{
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const axis = new THREE.Vector3()
  const n = new THREE.Vector3()
  const l = worlds.ridge

  // The sink as a FRACTION of the scaled height, which is what SINK is a band on: the matrix's Y column is `size * flat`, so (ground - y) / (pebbleHeight * sy) is the roll itself, to float32.
  const fracs = []
  let worstTilt = 0
  let worstAgree = 0
  for (const id of liveIds(l)) {
    l.batch.getMatrixAt(id, m)
    m.decompose(p, q, s)
    const sy = columns(m)[1]
    fracs.push((ridge.field.heightAt(p.x) - p.y) / (l.pebbleHeight * sy))
    worstAgree = Math.max(worstAgree, Math.abs(l.instY[id] - p.y))
    // The ridge's ANALYTIC normal, which is deliberately not the central difference _groundTilt takes: an independent derivation of the same thing, so this check cannot pass by re-implementing the code under it.
    n.set(-(RIDGE_A / RIDGE_L) * Math.cos(p.x / RIDGE_L), 1, 0).normalize()
    axis.copy(up).applyQuaternion(q)
    worstTilt = Math.max(worstTilt, Math.acos(Math.min(1, axis.dot(n))) * (180 / Math.PI))
  }
  if (!fracs.length) throw new Error('no pebbles on the ridge to measure')

  // Headless, so _groundFor falls through to the field's own height and the sink is exact. The tolerance is float32 at 900 m: instY and the matrix are single precision, which puts about 1e-4 m on the difference, and dividing by a centimetre-scale height turns that into a few thousandths of the fraction.
  const EPS = 0.02
  const lo = Math.min(...fracs)
  const hi = Math.max(...fracs)
  check(lo > SINK[0] - EPS && hi < SINK[1] + EPS,
    'every pebble is bedded INTO the hill it lies on, by a third to a half of its own height and never proud of it',
    `sunk ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}% of its height over ${fracs.length} pebbles, against ${(SINK[0] * 100).toFixed(0)}-${(SINK[1] * 100).toFixed(0)}%`)

  // AND THE BURIAL VARIES. A row of stones all proud by the same fraction reads as placed, and the roll fails silently: set SINK to a point and every check above stays green.
  check(hi - lo > (SINK[1] - SINK[0]) * 0.8, 'and no two stones are proud by the same fraction, so nothing reads as laid out',
    `${((hi - lo) * 100).toFixed(1)} points of spread out of the ${((SINK[1] - SINK[0]) * 100).toFixed(0)} available`)

  // THE SINK IS ALONG WORLD Y AND _reground ONLY REWRITES Y. The header's argument: instY and the matrix's translation must agree exactly, or a chunk re-split under a pebble would move it by something other than the ground moved.
  check(worstAgree < 1e-3, 'and the height the scatter remembers is the height the matrix carries, so a re-ground moves a pebble by what the ground moved',
    `worst disagreement ${worstAgree.toExponential(1)} m`)

  // FULL alignment with the field normal, unlike every rock bed's partial lean. Measured worst well under a tenth of a degree over the whole ridge; a degree is a bound on the arithmetic, and anything that lerped the tilt at all would show up in whole degrees.
  const TILT_TOL_DEG = 1
  check(worstTilt < TILT_TOL_DEG, 'and it lies FLAT on it -- the pebble\'s own up is the ground\'s own normal, not a lean toward it',
    `worst ${worstTilt.toFixed(3)} deg off the field normal over ${fracs.length} pebbles, tolerance ${TILT_TOL_DEG} deg`)
}

{
  // The flat shore: no tilt, so the matrix's rotation is the yaw alone and the shape falls out of the column lengths. The stretch goes on x and its complement on z, so sqrt(sx * sz) is the size roll's metres, sqrt(sx / sz) is the stretch, and sy / size is the flatness.
  const m = new THREE.Matrix4()
  const l = worlds.shore
  const ids = liveIds(l)
  const BINS = 12
  const bins = new Array(BINS).fill(0)
  const yaws = new Set()
  const sizes = []
  let minStretch = Infinity
  let maxStretch = -Infinity
  let minFlat = Infinity
  let maxFlat = -Infinity
  for (const id of ids) {
    l.batch.getMatrixAt(id, m)
    const [sx, sy, sz] = columns(m)
    const size = Math.sqrt(sx * sz)
    sizes.push(size)
    const stretch = Math.sqrt(sx / sz)
    minStretch = Math.min(minStretch, stretch)
    maxStretch = Math.max(maxStretch, stretch)
    minFlat = Math.min(minFlat, sy / size)
    maxFlat = Math.max(maxFlat, sy / size)
    const e = m.elements
    const yaw = Math.atan2(-e[2] / sx, e[0] / sx)
    yaws.add(yaw.toFixed(5))
    bins[Math.min(BINS - 1, Math.floor(((yaw + Math.PI) / (2 * Math.PI)) * BINS))]++
  }
  sizes.sort((a, b) => a - b)
  const minSize = sizes[0]
  const maxSize = sizes[sizes.length - 1]
  const median = sizes[sizes.length >> 1]

  // THE SIZE IS IN METRES AND SKEWED SMALL. The pebble is built at unit width so the scale is metres of stone directly: SIZE[0] to SIZE[1], with the median of a u^SIZE_POW roll landing at SIZE[0] + (SIZE[1] - SIZE[0]) * 0.5^SIZE_POW -- loose stone is mostly grit with a few stones in it, and a uniform roll reads as a hatch of same-sized dots.
  const wantMedian = SIZE[0] + (SIZE[1] - SIZE[0]) * Math.pow(0.5, SIZE_POW)
  check(minSize >= SIZE[0] - 1e-4 && maxSize <= SIZE[1] + 1e-4 && Math.abs(median - wantMedian) < (SIZE[1] - SIZE[0]) * 0.08,
    'a pebble is between a fingernail and a fist across, and most of them are near the small end',
    `${(minSize * 100).toFixed(1)}-${(maxSize * 100).toFixed(1)} cm against ${(SIZE[0] * 100).toFixed(0)}-${(SIZE[1] * 100).toFixed(0)}, median ${(median * 100).toFixed(1)} cm against the skew's ${(wantMedian * 100).toFixed(1)}`)

  // AND NO TWO ARE THE SAME SHAPE. One geometry is as many silhouettes as the stretch and the flatness make of it; both have to span their bands, because a collapse of either to a point is a scatter of identical blobs and nothing else here would notice.
  check(minStretch >= STRETCH[0] - 1e-4 && maxStretch <= STRETCH[1] + 1e-4 && maxStretch - minStretch > (STRETCH[1] - STRETCH[0]) * 0.8 &&
    minFlat >= FLAT[0] - 1e-4 && maxFlat <= FLAT[1] + 1e-4 && maxFlat - minFlat > (FLAT[1] - FLAT[0]) * 0.8,
    'and each one is stretched and flattened its own way, so one blob is many silhouettes',
    `stretch ${minStretch.toFixed(3)}-${maxStretch.toFixed(3)} against ${STRETCH[0]}-${STRETCH[1]}, flatness ${minFlat.toFixed(3)}-${maxFlat.toFixed(3)} against ${FLAT[0]}-${FLAT[1]}`)

  // AND THE YAW IS SPREAD OVER THE WHOLE CIRCLE, which is the cheapest of the dials and the one that would be missed first: a stretched pebble with one yaw is a field of stones all pointing the same way. Two-sided by construction: every twelfth of the circle has to carry roughly a twelfth of the stones.
  const YAW_BAND = [0.6, 1.4]
  const expect = ids.length / BINS
  const worstBin = Math.max(...bins.map((b) => Math.abs(b / expect - 1)))
  check(bins.every((b) => b > expect * YAW_BAND[0] && b < expect * YAW_BAND[1]) && yaws.size > ids.length / 2,
    'and every one of them is turned a different way',
    `${bins.join(' ')} over ${BINS} bins, expected ${expect.toFixed(1)} each, worst ${(worstBin * 100).toFixed(0)}% off (band +/-${((YAW_BAND[1] - 1) * 100).toFixed(0)}%), ${yaws.size} distinct angles in ${ids.length} pebbles`)
}

// ---------------------------------------------------------------------------
// 8. Colour.
// ---------------------------------------------------------------------------
//
// A pebble's tint is one of the rock bank's own for its environment, pulled toward the ground colour and jittered in tone. Nothing here can say the colour is RIGHT -- that is the screen's -- but it can say it is a colour, that it varies, and that two grounds with different palettes come out differently.

console.log('\ncolour')

{
  const c = new THREE.Color()
  const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  const stats = (l) => {
    const ids = liveIds(l)
    const seen = new Set()
    let sum = [0, 0, 0]
    let lo = Infinity
    let hi = -Infinity
    for (const id of ids) {
      l.batch.getColorAt(id, c)
      if (!(c.r > 0 && c.g > 0 && c.b > 0) || !Number.isFinite(c.r + c.g + c.b)) {
        throw new Error(`a pebble carries a colour that is not one: ${c.r} ${c.g} ${c.b}`)
      }
      seen.add(`${c.r.toFixed(4)}|${c.g.toFixed(4)}|${c.b.toFixed(4)}`)
      lo = Math.min(lo, luma(c))
      hi = Math.max(hi, luma(c))
      sum = [sum[0] + c.r, sum[1] + c.g, sum[2] + c.b]
    }
    return { n: ids.length, distinct: seen.size, lo, hi, mean: sum.map((v) => v / ids.length) }
  }
  const forest = stats(worlds.forest)
  const peak = stats(worlds.peak)

  // TONE alone spans TONE[1] / TONE[0] in brightness, and the palette adds to that, so the brightest stone against the darkest has to be at least the tone jitter's own ratio. Distinct colours near the count says the jitter is per instance and not per tile.
  const ratio = forest.hi / forest.lo
  check(ratio > (TONE[1] / TONE[0]) * 0.95 && forest.distinct > forest.n * 0.9,
    'the stones in a wood are not one colour: the brightest is well over the darkest and nearly every one differs',
    `luma ${forest.lo.toFixed(3)}-${forest.hi.toFixed(3)}, ${ratio.toFixed(2)}x against the tone jitter's ${(TONE[1] / TONE[0]).toFixed(2)}x, ${forest.distinct} distinct in ${forest.n}`)

  // A peak wears the peak palette over snowline-shaded ground and a wood the forest one over green; the mean colours must differ by more than tone noise could. Measured as the per-channel difference of the means.
  const diff = Math.max(...forest.mean.map((v, i) => Math.abs(v - peak.mean[i])))
  check(diff > 0.05, 'and a peak\'s stone is not a wood\'s stone: the palette and the ground cue both move the mean colour',
    `wood mean ${forest.mean.map((v) => v.toFixed(3)).join(' ')}, peak mean ${peak.mean.map((v) => v.toFixed(3)).join(' ')}, largest channel gap ${diff.toFixed(3)}`)

  // HALF THE STONES ARE THE GROUND'S HUE, AT A STONE'S BRIGHTNESS. Each pebble's chromaticity (its colour over its own sum, so brightness drops out and only the hue is compared) against the mesher's own `shade` at the same point on the wood's ground: the ground half sits on it and the tint half does not, and the two halves are near equal in count. And the ground half is NOT darker for it: both halves draw the same palette and tone, so their median lumas have to agree within a few percent -- the ground's own colour is a third the brightness of a lit stone, and a pebble that took it whole would read as a black speck.
  const l = worlds.forest
  const gc = new Float32Array(3)
  const dist = { ground: [], tint: [] }
  const lumas = { ground: [], tint: [] }
  for (const id of liveIds(l)) {
    l.batch.getColorAt(id, c)
    shade(60, 1, 9999, scatterLayers.snow.band, 0, 0, 900, l.instX[id], l.instZ[id], gc, 0)
    const cs = c.r + c.g + c.b
    const gs = gc[0] + gc[1] + gc[2]
    const half = l.instGround[id] ? 'ground' : 'tint'
    dist[half].push(Math.hypot(c.r / cs - gc[0] / gs, c.g / cs - gc[1] / gs, c.b / cs - gc[2] / gs))
    lumas[half].push(luma(c))
  }
  const median = (a) => a.sort((x, y) => x - y)[a.length >> 1]
  const share = dist.ground.length / (dist.ground.length + dist.tint.length)
  const mg = median(dist.ground)
  const mt = median(dist.tint)
  const lg = median(lumas.ground)
  const lt = median(lumas.tint)
  check(Math.abs(share - GROUND_SHARE) < 0.05 && mg < 0.01 && mt > 0.05,
    'and half the stones in a wood take the ground\'s own hue, the other half a stone\'s',
    `${dist.ground.length} ground-hued of ${dist.ground.length + dist.tint.length} (${(share * 100).toFixed(0)}% against GROUND_SHARE ${GROUND_SHARE}), median chromaticity off the ground ${mg.toFixed(4)} against the tint half's ${mt.toFixed(4)}`)
  check(Math.abs(lg / lt - 1) < 0.05,
    'and the ground-hued half is as bright as the stone-hued half',
    `median luma ${lg.toFixed(3)} ground-hued against ${lt.toFixed(3)} stone-hued`)
}

// ---------------------------------------------------------------------------
// 9. What the panel reads.
// ---------------------------------------------------------------------------
//
// The panel's `litter` row is the only instrument that says what the layer costs on a real frame, and it is `tris`, which update() computes from what the rim has not hidden. It has to be the pebble's own count times the drawn instances and nothing else.

console.log('\ncost')

{
  // Driven on the prop clock the rim dissolves run on, for a second of frames at 72 Hz standing still: long enough for every tile's sweep phase to come round and every reveal to finish, so what is hidden afterwards is the rim's own margin past RADIUS and not a fade still in flight.
  const l = build(world(60, 0, 9999, null))
  for (let f = 0; f < 72; f++) {
    setPropClock(f / 72)
    l.update(0, 61.6, 0)
  }
  const s = l.stats
  check(s.tris === (s.placed - s.rimHidden) * l.pebbleTris && l.pebbleTris === ROCK_TIERS[PEBBLE_TIER].faces && s.tris > 0 && s.rimFading === 0,
    'the triangle count the panel shows is drawn pebbles times twenty, so the row is the layer\'s real cost',
    `${s.tris} tris = (${s.placed} placed - ${s.rimHidden} hidden) x ${l.pebbleTris}, ${s.rimFading} still fading`)
  l.dispose()
}

// ---------------------------------------------------------------------------
// 10. One seed, one scatter.
// ---------------------------------------------------------------------------
//
// Both halves, and they fail in opposite directions. Without determinism the litter moves under the player's feet as tiles are evicted and regrown, and nothing about the ground can be reasoned about at all. Without the seed doing anything, every world in the game gets the same drifts in the same places.

console.log('\nseeds')

{
  const stones = (l) => liveIds(l).map((id) => `${l.instX[id]}|${l.instY[id]}|${l.instZ[id]}`).sort()
  const flat = world(60, 0, 9999, null)
  const a = build(flat)
  const b = build(flat)
  const c = build(flat, SEED + 1)
  const sa = stones(a)
  const sb = stones(b)
  const sc = stones(c)

  check(sa.length === sb.length && sa.every((v, i) => v === sb[i]), 'the same seed is the same scatter, stone for stone',
    `${sa.length} pebbles, ${sa.filter((v, i) => v !== sb[i]).length} in a different place the second time`)

  // A REAL DIFFERENCE, not merely a different count: tileSeed mixes the seed into every tile, so essentially no pebble should land where a pebble of the other seed landed.
  const shared = new Set(sa)
  const overlap = sc.filter((v) => shared.has(v)).length
  check(overlap === 0 && sc.length !== 0, 'and a different seed is a different scatter, not the same one relabelled',
    `seed ${SEED} placed ${sa.length}, seed ${SEED + 1} placed ${sc.length}, ${overlap} pebbles in common`)

  a.dispose()
  b.dispose()
  c.dispose()
}

// ---------------------------------------------------------------------------
// 11. Litter around rocks.
// ---------------------------------------------------------------------------
//
// A pebble inside a boulder is skipped outright, at any rock size, because there is nothing to lift it onto that would not read as a stone floating on a curved face. A stub answers over a disc, so what is under test is the litter's half of the contract.

console.log('\nrocks')

{
  const STONE = { x: 24, z: -18, r: 14 }
  let minSizeSeen = Infinity
  const stone = {
    blockTopAt(x, z, minSize) {
      minSizeSeen = Math.min(minSizeSeen, minSize)
      const dx = x - STONE.x
      const dz = z - STONE.z
      return dx * dx + dz * dz < STONE.r * STONE.r ? 61 : -Infinity
    },
  }
  const w = world(60, 0, 9999, null)
  const l = new Litter(new THREE.Scene(), w.field, w.water, scatterLayers, texArray, { seed: SEED, rocks: stone })
  l.place(0, 0)
  const s = l.stats

  let inside = 0
  for (const tile of l.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const dx = l.instX[id] - STONE.x
      const dz = l.instZ[id] - STONE.z
      if (dx * dx + dz * dz < STONE.r * STONE.r) inside++
    }
  }
  check(inside === 0, 'not one pebble lands inside a rock', `${inside} of ${s.placed}`)
  check(s.rejectedRock > 0 && s.placed + s.rejectedRock === worlds.forest.stats.placed,
    'and every pebble the rock took is accounted for as a rock rejection, not lost',
    `${s.rejectedRock} rejected, ${s.placed} + that against ${worlds.forest.stats.placed} without`)
  check(minSizeSeen === 0,
    'and the litter asks about ANY stone, cobbles included -- it is skipped, not lifted',
    `asked at ${minSizeSeen} m`)

  let threw = false
  try {
    new Litter(new THREE.Scene(), w.field, w.water, scatterLayers, texArray, { seed: SEED, rocks: {} })
  } catch { threw = true }
  check(threw, 'and something passed as `rocks` that cannot answer throws at construction')

  l.dispose()
}

{
  const s = worlds.forest.stats
  console.log(`\n       wood: ${s.placed} pebbles, ${s.tiles} tiles resident, pool ${s.pool}, build ${s.buildMs.toFixed(1)} ms, place ${s.placeMs.toFixed(0)} ms`)
}

for (const l of Object.values(worlds)) l.dispose()

console.log(`\n${failures === 0 ? 'all litter checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
