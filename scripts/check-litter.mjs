// Node-side gates for the strewn ground litter: the BAKE (src/props/litter.js, sections 1-4) and the SCATTER that stamps it on the hill (src/v2/render/litter.js, sections 5-12).
//
//   node scripts/check-litter.mjs
//
// WHAT THIS FILE CAN AND CANNOT SEE. litter.js is deliberately cut in half, and the cut is the reason this gate is possible: `litterPlacements` and `buildLitterPool` hold every DECISION the patch contains, while `bakeLitter` and `bakeLitterSet` hold a camera, a render target and a readback. There is no GL context in node and no headless browser here, so bakeLitter and bakeLitterSet are NOT called and nothing below asserts anything about the pixels that come out of them. What is asserted is everything upstream of the photograph: where the stones land, how big they are, what colour they are, and what geometry they are made of. If the rig itself regresses -- the ortho frustum, the camera `up`, the key direction, the downsample -- this gate will stay green and only the screen will tell you.
//
// The five failures it exists to catch, all of which are silent:
//
//   A STONE HANGING OFF THE EDGE. The atlas is RepeatWrapping, so a stone touching the patch border is bilinearly blended with whatever sits on the OPPOSITE side of the same patch, and the picture also grows a row of cut-off rocks along its rim. LITTER_MARGIN exists to make both impossible, and section 3 measures it against every stone of every seed the bake actually uses rather than against the one seed somebody happened to look at.
//
//   THE SIZE ROLL COLLAPSING. LITTER_SIZE_POW is what makes the patch read as a spread of loose stone rather than as a hatch pattern of same-sized dots, and it fails in two opposite directions: a power that drifts toward 1 hands back the hatch pattern, and one that runs away leaves 54 specks with nothing large in the patch at all. Section 3 bounds both ends, because a floor alone would be perfectly green on a distribution that had collapsed onto one size.
//
//   COVERAGE DRIFTING OUT OF ITS BAND. The header's target is "a little under half": fuller than that and the transparent gaps close, the layer becomes a solid grey tile, and two patches stamped overlapping show a visible square. Emptier and the stamp is not worth its two triangles. So this is a band and not a floor.
//
//   THE RIG BLOWING THE CROWNS TO WHITE. The target is 8-bit and toneMapped: false, so a crown lit past 1.0 loses its colour and its curvature in the same texel and the patch turns to grey confetti. Section 3b cannot see the pixels, but the exposure is arithmetic on LITTER_KEY, LITTER_SKY and the tint's own albedo, and that it can hold.
//
//   THE LAYER BLOCK COLLIDING WITH SOMETHING ELSE. Four slices of a 48-layer array, hand-numbered in textures.js. A collision is not a crash: it is one feature quietly drawing another feature's photograph.

import { readFileSync } from 'node:fs'

import * as THREE from 'three'

import {
  LITTER_LAYERS, LITTER_PATCH_M, LITTER_MARGIN, LITTER_REACH, LITTER_RIM_KNEE, LITTER_RIM_TAPER,
  LITTER_STONES, LITTER_SIZE, LITTER_SIZE_POW,
  LITTER_VARIANTS, LITTER_SEEDS, LITTER_TIER, LITTER_TINTS, LITTER_KEY, LITTER_SKY,
  buildLitterPool, litterPlacements,
} from '../src/props/litter.js'
import { smoothstep } from '../src/sim/mathx.js'
import { ROCK_TIERS, BOX_MARGIN } from '../src/props/rock.js'
import { rockParams, TINTS, TINT_GAIN } from '../src/props/rock-bank.js'
import { LAYER, LAYER_COUNT, ROCK_TILE_MEAN, buildTextureArray } from '../src/textures.js'
import { Litter } from '../src/v2/render/litter.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// The seeds the bake actually uses. Read off bakeLitterSet, which walks LITTER_LAYERS and passes `seed: i + 1`, so this stays in step if a fifth layer is ever added rather than silently going on testing four.
const BAKE_SEEDS = LITTER_LAYERS.map((_, i) => i + 1)

console.log(`\n=== litter checks, ${LITTER_LAYERS.length} baked patches x ${LITTER_STONES} stones ===\n`)

// ---------------------------------------------------------------------------
// 1. The four slices of the atlas the patches are baked into.
// ---------------------------------------------------------------------------

console.log('atlas layers')

{
  const distinct = new Set(LITTER_LAYERS)
  check(distinct.size === LITTER_LAYERS.length, 'the litter patches are four different slices of the atlas, not four names for one',
    `${LITTER_LAYERS.join(' ')}, ${distinct.size} distinct`)

  const inRange = LITTER_LAYERS.filter((v) => Number.isInteger(v) && v >= 0 && v < LAYER_COUNT)
  check(inRange.length === LITTER_LAYERS.length, 'every litter layer is a real slice of the array the world actually allocates',
    `${LITTER_LAYERS.join(' ')} against ${LAYER_COUNT} layers`)

  // Derived by scanning the enum rather than by listing the neighbours, so a new LAYER entry that lands on 45 fails here instead of quietly stamping somebody else's photograph on the ground. A litter layer is clean when EXACTLY one name in the enum claims it.
  const owners = LITTER_LAYERS.map((v) => Object.entries(LAYER).filter(([, n]) => n === v).map(([k]) => k))
  const clashes = owners.filter((names) => names.length !== 1)
  check(clashes.length === 0, 'no other layer in the atlas is stored on top of a litter patch',
    clashes.length ? clashes.map((n) => n.join(' = ')).join(', ') : `${owners.map((n) => n[0]).join(' ')}, one owner each`)
}

// ---------------------------------------------------------------------------
// 2. The pool of rocks every patch is assembled from.
// ---------------------------------------------------------------------------
//
// Fifteen meshes stand in for the two hundred-odd stones across the four layers, so anything wrong with one of them is wrong in a seventh of the picture. Two separate promises here. The layout one is ordinary: these go through the same prop material as everything else and would be refused by a BatchedMesh over a stray `uv`. The SIZE one is the load-bearing one, and it is easy to miss: buildLitterPool asks for `size: 1` and litterPlacements scales the result by an absolute metre size, so if buildRock ever returned something other than a roughly unit solid, every stone in every patch would be off by that factor and LITTER_SIZE would silently stop meaning metres.

console.log('\npool')

const pool = buildLitterPool()

{
  check(pool.length === LITTER_VARIANTS.length * LITTER_SEEDS, 'the pool is every litter variant at every seed',
    `${pool.length} = ${LITTER_VARIANTS.length} variants x ${LITTER_SEEDS} seeds`)

  const LAYOUT = ['normal', 'position', 'texLayer', 'uvProj']
  const wrongAttrs = pool.filter((g) => Object.keys(g.attributes).sort().join(',') !== LAYOUT.join(','))
  check(wrongAttrs.length === 0, 'every pooled rock is exactly { position, normal, uvProj, texLayer }', `${wrongAttrs.length} of ${pool.length} wrong`)

  const unindexed = pool.filter((g) => !g.index)
  check(unindexed.length === 0, 'and every one of them is indexed', `${unindexed.length} of ${pool.length} not`)

  // The face count LITTER_TIER implies, less whatever the rock's own open bottom threw away. `shingle` is the one variant in the roster with `openBottom`, and it drops 22 of its 80 faces on the bed plane -- a real shortfall, and it has to be EXACTLY the one the geometry reports, or the tier stopped being the tier and nothing else here would notice.
  const tierFaces = ROCK_TIERS[LITTER_TIER].faces
  const wrongFaces = []
  pool.forEach((g, i) => {
    // rockParams spreads ROCK_DEFAULTS, so `shards` is always there and a missing one is a real breakage rather than a case to default around.
    const p = rockParams(LITTER_VARIANTS[(i / LITTER_SEEDS) | 0], i % LITTER_SEEDS)
    if (!Number.isFinite(p.shards)) throw new Error(`rockParams(${LITTER_VARIANTS[(i / LITTER_SEEDS) | 0]}) no longer carries a shards count`)
    const shards = Math.max(1, Math.round(p.shards))
    const expect = tierFaces * shards - g.userData.rock.dropped
    if (g.index.count / 3 !== expect || g.userData.rock.triangles !== expect) wrongFaces.push(i)
  })
  const faceCounts = pool.map((g) => g.index.count / 3)
  check(wrongFaces.length === 0, `every pooled rock carries ${ROCK_TIERS[LITTER_TIER].name}'s ${tierFaces} faces, less exactly the ones its open bottom dropped`,
    `${Math.min(...faceCounts)}..${Math.max(...faceCounts)} faces, ${wrongFaces.length} off`)

  // A REAL SOLID, AND A UNIT-SIZED ONE. Span is measured the way check-rocks.mjs measures it, as the wider of the two horizontal extents, because that is what buildRock's `size` means -- height is a consequence of `squash` and is genuinely small on a flat shingle chip (0.10 against a span of 0.98), so a bound that treated all three axes alike would fail an entirely correct rock. Measured across the fifteen: span 0.98 to 1.05, and the thinnest vertical extent 0.10. The band below is a good deal wider than that on purpose but far narrower than the +/-80% BOX_MARGIN would technically permit, so it catches a build that stopped honouring `size: 1` while leaving the noise field room to move.
  const SPAN_BAND = [0.8, 1.3]
  const MIN_EXTENT = 0.02
  let worstSpan = [Infinity, 0]
  let thinnest = Infinity
  const flat = []
  const wrongSpan = []
  pool.forEach((g, i) => {
    g.computeBoundingBox()
    const b = g.boundingBox
    const ext = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]
    if (!ext.every((v) => Number.isFinite(v) && v > MIN_EXTENT)) flat.push(i)
    thinnest = Math.min(thinnest, ...ext)
    const span = Math.max(ext[0], ext[2])
    worstSpan = [Math.min(worstSpan[0], span), Math.max(worstSpan[1], span)]
    if (span < SPAN_BAND[0] || span > SPAN_BAND[1]) wrongSpan.push(i)
  })
  check(flat.length === 0, 'no pooled rock is a flat sheet or a point -- all three axes have real extent',
    `thinnest axis ${thinnest.toFixed(3)}, floor ${MIN_EXTENT}`)
  check(wrongSpan.length === 0, 'the pool is built at unit size, which is what makes LITTER_SIZE a measurement in metres',
    `span ${worstSpan[0].toFixed(3)}..${worstSpan[1].toFixed(3)}, band ${SPAN_BAND[0]}..${SPAN_BAND[1]} (BOX_MARGIN would allow ${BOX_MARGIN.toFixed(1)})`)

  const nan = pool.filter((g) => {
    for (const name of LAYOUT) for (const v of g.attributes[name].array) if (!Number.isFinite(v)) return true
    return false
  })
  check(nan.length === 0, 'nothing in the pool carries a NaN into the bake', `${nan.length} of ${pool.length}`)
}

// ---------------------------------------------------------------------------
// 3. What one patch contains.
// ---------------------------------------------------------------------------
//
// Everything here is measured on all four of the seeds bakeLitterSet actually bakes, and reported per seed, because a bound that passes on the mean of four patches can be hiding one patch that is wrong.

console.log('\nplacements')

const patches = BAKE_SEEDS.map((seed) => litterPlacements(seed, pool.length))

{
  const wrongCount = patches.filter((p) => p.length !== LITTER_STONES)
  check(wrongCount.length === 0, `every patch drops ${LITTER_STONES} stones`, `${patches.map((p) => p.length).join(' ')}`)
}

{
  // EVERY STONE LANDS WHOLE INSIDE THE PATCH. This is what keeps cut-off rocks off the border and what keeps the RepeatWrapping bilinear blend mixing transparent with transparent instead of dragging the far side of the patch across the near one. Measured as the stone's own outer edge, |centre| + size / 2, against the half-patch.
  const half = LITTER_PATCH_M / 2
  let worst = 0
  let worstAt = ''
  patches.forEach((p, i) => {
    for (const s of p) {
      for (const [axis, v] of [['x', s.x], ['z', s.z]]) {
        const edge = Math.abs(v) + s.size / 2
        if (edge > worst) { worst = edge; worstAt = `seed ${BAKE_SEEDS[i]} ${axis}` }
      }
    }
  })
  // Measured worst across the four seeds is 0.673 m against a half-patch of 0.800, so there is 13 cm of clear rim at the tightest stone in the whole set. Asserted at the half-patch itself rather than at a padded bound because this one is not a tuning question: a stone past 0.800 IS in the wrap border.
  check(worst <= half, 'no stone reaches the patch border, so nothing is cut off and the wrap blend has only transparency to mix',
    `worst outer edge ${worst.toFixed(3)} m at ${worstAt}, half-patch ${half.toFixed(3)} m`)

  // AND IT HOLDS FOR A STONE THAT WAS NEVER ROLLED. The check above samples 296 stones; this one is the arithmetic, and it is the thing LITTER_MARGIN is actually FOR. It fails the moment somebody raises the top of the size range, or the reach, without touching the other, which is the realistic way it breaks.
  //
  // SWEPT RATHER THAN EVALUATED AT ONE POINT, because the drift's two bounds pull against each other along the radius: the centre can go furthest out at the rim, where LITTER_RIM_TAPER has taken most of the size range away, and the stone can be widest in the middle, where it cannot go far. The product is what has to clear the half-patch, so the sweep walks the radius and takes the worst of it instead of assuming the answer is at one end. (It is at the rim, at 0.749 m, but that is a fact about the current numbers and not something to build the check on.)
  let worstPossible = 0
  let worstT = 0
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000
    const rim = 1 - LITTER_RIM_TAPER * smoothstep(LITTER_RIM_KNEE, 1, t)
    const reach = LITTER_REACH * t + (LITTER_SIZE[0] + (LITTER_SIZE[1] - LITTER_SIZE[0]) * rim) / 2
    if (reach > worstPossible) { worstPossible = reach; worstT = t }
  }
  check(worstPossible <= half, 'and the margin is wide enough for the largest stone the drift can roll anywhere along its radius, not just the ones it did',
    `worst possible ${worstPossible.toFixed(3)} m at ${(worstT * 100).toFixed(0)}% of the reach, against ${half.toFixed(3)} m, margin ${(LITTER_MARGIN * 100).toFixed(0)}%`)
}

{
  // THE SIZE ROLL IS SKEWED SMALL, WHICH IS THE WHOLE OF LITTER_SIZE_POW, and both ends are bounded because a one-sided bound would be green on a roll that had collapsed. The median is quoted as a fraction of the size range: a uniform roll medians at 0.500 and u^2 medians at 0.250, so the ceiling below sits between them and catches a power drifting back toward 1. Measured medians across the four seeds are 0.264, 0.194, 0.157 and 0.189 -- around and mostly under u^2's own 0.250 because LITTER_RIM_TAPER takes a further bite out of the range for every stone past the knee.
  const MEDIAN_CEIL = 0.45
  // AND THE OTHER END, MEASURED IN METRES RATHER THAN AS A FRACTION OF THE RANGE, and the change of unit is the point. A fraction of the range was the right reading while every stone rolled against the whole of it; now the taper hands most of the patch a shorter range, so "the top quarter of LITTER_SIZE" is a bar only the stones inside LITTER_RIM_KNEE can clear at all and the count says as much about the knee as about the roll. What the picture actually needs is stones big enough to READ as stones: at LITTER_PATCH_M / 128 the texel is 1.25 cm, so 15 cm is a dozen texels across and has a recognisable outline, where the 5 cm floor of the range is four texels and is grit. Measured 18, 15, 12 and 12 of them; the floor is set well under the thinnest seed because this catches a collapse to grit, it does not police the count.
  const STONE_M = 0.15
  const STONE_FLOOR = 6
  const [minS, maxS] = LITTER_SIZE
  const frac = (s) => (s - minS) / (maxS - minS)

  const medians = patches.map((p) => {
    const sorted = p.map((s) => s.size).sort((a, b) => a - b)
    return frac(sorted[sorted.length >> 1])
  })
  const stones = patches.map((p) => p.filter((s) => s.size >= STONE_M).length)
  const all = patches.flat().map((s) => s.size)

  check(Math.max(...medians) < MEDIAN_CEIL, `the size roll is skewed small, which is what LITTER_SIZE_POW = ${LITTER_SIZE_POW} is for`,
    `median at ${medians.map((v) => v.toFixed(3)).join(' / ')} of the range, uniform would be 0.500, ceiling ${MEDIAN_CEIL}`)
  check(Math.min(...stones) >= STONE_FLOOR, 'and it has not collapsed to grit -- every patch still has stones with an outline in it',
    `${stones.join(' / ')} stones at or over ${STONE_M} m (a dozen texels), floor ${STONE_FLOOR}`)
  check(Math.min(...all) >= minS - 1e-9 && Math.max(...all) <= maxS + 1e-9, 'and no stone escapes LITTER_SIZE at either end',
    `${Math.min(...all).toFixed(4)} .. ${Math.max(...all).toFixed(4)} m against ${minS} .. ${maxS}`)
}

{
  // THE DRIFT TAPERS TO GRIT AT ITS RIM, which is the promise that actually dissolves the patch's edge and the one thing the lobed outline cannot do on its own: a 25 cm stone sitting at the rim IS the rim, however wavy the line it sits on. So the last thing before bare ground has to be small enough that the eye cannot find a boundary in it.
  //
  // Measured out past 80% of the reach, and read against the ceiling LITTER_RIM_TAPER itself imposes there rather than against a number typed in here -- the assertion is that no stone in the outer fifth is bigger than the taper's own arithmetic allows, so it stays true if the knee or the taper is retuned and fails if the taper is quietly disconnected from the roll. Note the test radius is measured against LITTER_REACH while the taper is a function of the radius against the LOBED edge, which is never longer: every stone past 0.8 of the reach is therefore past 0.8 of its own edge too, and the ceiling below is the loosest one that can apply to it.
  const RIM_FROM = 0.8
  const ceiling = LITTER_SIZE[0] + (LITTER_SIZE[1] - LITTER_SIZE[0]) * (1 - LITTER_RIM_TAPER * smoothstep(LITTER_RIM_KNEE, 1, RIM_FROM))
  const rims = patches.map((p) => {
    const out = p.filter((s) => Math.hypot(s.x, s.z) > RIM_FROM * LITTER_REACH)
    return { n: out.length, max: out.length ? Math.max(...out.map((s) => s.size)) : 0 }
  })
  check(rims.every((r) => r.n > 0 && r.max <= ceiling + 1e-9),
    'and the drift thins into bare ground rather than stopping on a line -- nothing at its rim is bigger than grit',
    `biggest past ${(RIM_FROM * 100).toFixed(0)}% of the reach is ${rims.map((r) => r.max.toFixed(3)).join(' / ')} m against the taper's own ${ceiling.toFixed(3)} m ceiling there, on ${rims.map((r) => r.n).join(' / ')} stones, range top ${LITTER_SIZE[1]} m`)
}

{
  // AND THE COVERED GROUND IS A DRIFT AND NOT A SQUARE, which is the complaint this shape exists to answer: stones dropped uniformly on an inset square put as much gravel in the four corners as in the middle, so the layer read as a square of gravel and two of them overlapping drew the join. Rasterised at the layer's own 128 texels, because the question is about the PICTURE and a summed footprint cannot see where the ground it covers is.
  //
  // A corner wedge is where both |x| and |z| are past 0.55 of the half-patch -- the region a square fills and a disc of any radius under 0.78 of the half-patch can barely graze. Against it, the middle, inside 0.35 of the half-patch on both axes. The retired square covered 9%, 7%, 8% and 8% of its corners at these same wedges; the drift covers 0%, 0%, 0.03% and 0.27%, those last two being a stone's shoulder leaning in at seeds 3 and 4. So the ceiling is a whisker rather than zero -- it is the difference between a corner that has gravel in it and a corner that has a stone's shoulder leaning into it, and the second is not what makes a patch read as square.
  const CORNER_CEIL = 0.01
  const MIDDLE_FLOOR = 0.15
  const N = 128
  const cell = LITTER_PATCH_M / N
  const half = LITTER_PATCH_M / 2
  const rows = patches.map((p) => {
    const g = new Uint8Array(N * N)
    for (const s of p) {
      const rr = (s.size / 2) ** 2
      const i0 = Math.max(0, Math.floor((s.x - s.size / 2 + half) / cell))
      const i1 = Math.min(N - 1, Math.ceil((s.x + s.size / 2 + half) / cell))
      const j0 = Math.max(0, Math.floor((s.z - s.size / 2 + half) / cell))
      const j1 = Math.min(N - 1, Math.ceil((s.z + s.size / 2 + half) / cell))
      for (let j = j0; j <= j1; j++) {
        const dz = (j + 0.5) * cell - half - s.z
        for (let i = i0; i <= i1; i++) {
          const dx = (i + 0.5) * cell - half - s.x
          if (dx * dx + dz * dz <= rr) g[j * N + i] = 1
        }
      }
    }
    let ch = 0, ct = 0, mh = 0, mt = 0
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const ax = Math.abs((i + 0.5) * cell - half) / half
        const az = Math.abs((j + 0.5) * cell - half) / half
        if (ax > 0.55 && az > 0.55) { ct++; ch += g[j * N + i] }
        else if (ax < 0.35 && az < 0.35) { mt++; mh += g[j * N + i] }
      }
    }
    return { corner: ch / ct, middle: mh / mt }
  })
  check(rows.every((r) => r.corner <= CORNER_CEIL && r.middle > MIDDLE_FLOOR),
    'and the ground it covers has no corners in it -- the patch reads as a drift rather than as a square of gravel',
    `corners ${rows.map((r) => `${(r.corner * 100).toFixed(2)}%`).join(' / ')} against middles ${rows.map((r) => `${(r.middle * 100).toFixed(0)}%`).join(' / ')}, ceiling ${(CORNER_CEIL * 100).toFixed(0)}% and floor ${(MIDDLE_FLOOR * 100).toFixed(0)}% (the retired square covered 7-9% of its corners)`)
}

{
  // COVERAGE IS A BAND, NOT A FLOOR. The header's target is "a little under half": above that the transparent gaps close up and the layer becomes a solid grey tile that shows a visible square wherever two patches overlap, below it the stamp stops being worth its two triangles. Summed circular footprint over patch area, which reads a little high against what the bake reports because it ignores overlap, and that is fine as long as the bound is set from the same measurement. Measured 40.6%, 25.7%, 25.0% and 29.8% across the four seeds; the band sits about 4 points below the emptiest and 3 above the fullest, with the upper end still under the "under half" the header promises. The spread is wider than the square's was, twice over: a seed that rolls small also loses the taper's bite, and widening LITTER_SIZE's top to 0.34 means one big stone moves the summed footprint further than it used to. Seed 1 is the reason the ceiling is not tighter.
  const COVER_BAND = [0.20, 0.44]
  const area = LITTER_PATCH_M * LITTER_PATCH_M
  const covers = patches.map((p) => p.reduce((sum, s) => sum + Math.PI * (s.size / 2) ** 2, 0) / area)
  check(covers.every((c) => c > COVER_BAND[0] && c < COVER_BAND[1]),
    'the ground is strewn, not paved -- enough stone to read as litter and enough gap to read through',
    `${covers.map((c) => `${(c * 100).toFixed(1)}%`).join(' / ')} of the patch, band ${(COVER_BAND[0] * 100).toFixed(0)}-${(COVER_BAND[1] * 100).toFixed(0)}%`)
}

{
  // ENOUGH COLOURS THAT IT DOES NOT READ AS TWO. LITTER_TINTS is the whole palette bar one, so seven is the ceiling and all four patches hit it; the floor of 5 is what stops a rework that narrowed the roll turning a patch into stripes of two greys.
  const TINT_FLOOR = 5
  const distinct = patches.map((p) => new Set(p.map((s) => s.tint)).size)
  check(Math.min(...distinct) >= TINT_FLOOR, 'a patch carries a spread of stone colours rather than two',
    `${distinct.join(' / ')} distinct tints out of ${LITTER_TINTS.length} available, floor ${TINT_FLOOR}`)

  const bad = patches.flat().filter((s) => !Number.isInteger(s.tint) || s.tint < 0 || s.tint >= TINTS.length)
  check(bad.length === 0, 'and every tint rolled is a real entry in the rock palette', `${bad.length} of ${patches.flat().length} out of range, ${TINTS.length} tints`)

  // Found by name rather than by index, because `lichen`'s position in TINTS is not a thing litter.js knows or should know -- LITTER_TINTS filters on the name too, and hardcoding 6 here would leave this check quietly asserting nothing the day somebody reorders the palette.
  const lichen = TINTS.findIndex(([name]) => name === 'lichen')
  check(lichen >= 0, 'the palette still has a `lichen` entry for the litter roll to exclude', `TINTS[${lichen}]`)
  const green = patches.flat().filter((s) => s.tint === lichen).length
  check(green === 0, 'no chip of litter wears lichen -- loose stone has moved too recently to have grown any',
    `${green} of ${patches.flat().length} stones`)
}

{
  const bad = patches.flat().filter((s) => !Number.isInteger(s.shape) || s.shape < 0 || s.shape >= pool.length)
  check(bad.length === 0, 'every stone points at a rock that is actually in the pool',
    `${bad.length} of ${patches.flat().length} out of range, pool of ${pool.length}`)
}

// ---------------------------------------------------------------------------
// 3b. What the rig does to those tints.
// ---------------------------------------------------------------------------
//
// bakeLitter is never called here -- there is no GL context, see the header -- but its EXPOSURE is arithmetic, and arithmetic is exactly what node can hold. A stone's crown faces straight up, so it takes the key head on and the whole hemisphere besides: LITTER_KEY * 1 + LITTER_SKY of the tint's own linear albedo. The render target is 8-bit and `toneMapped: false`, so a crown over 1.0 does not come out bright, it comes out WHITE -- the stone loses its colour and its form in the same texel, and every other check in this file stays green while it happens. That is what the old 1.35 / 0.95 rig did to the palest tints in the list.
//
// The albedo is reconstructed the long way, TINT_GAIN[t][c] * ROCK_TILE_MEAN[c], rather than read back off the hex, because that product is precisely what the bake material puts on the screen: `color` is the gain and the photograph it multiplies averages the mean. So this fails too if TINT_GAIN ever stops dividing the tile's mean out and the gains stop meaning "land on the authored colour".
//
// Two-sided, because the cheap way to satisfy a ceiling is to turn the rig off. A crown at 0.2 is not a stone in daylight, it is a stone in a cupboard, and the world's own lighting on the quad only trims from what the bake landed.

console.log('\nexposure')

{
  const CROWN_BAND = [0.25, 0.98]
  const OLD_RIG = 1.35 + 0.95
  const lit = LITTER_KEY + LITTER_SKY

  let worst = [-Infinity, '', 0]
  for (const t of LITTER_TINTS) {
    for (let c = 0; c < 3; c++) {
      const albedo = TINT_GAIN[t][c] * ROCK_TILE_MEAN[c]
      if (albedo > worst[0]) worst = [albedo, TINTS[t][0], c]
    }
  }
  const crown = worst[0] * lit
  check(crown >= CROWN_BAND[0] && crown <= CROWN_BAND[1],
    'the bake rig cannot blow a stone\'s crown to white whatever tint it draws, and has not bought that by turning itself down to nothing',
    `brightest of the ${LITTER_TINTS.length} litter tints is ${worst[1]}'s ${'rgb'[worst[2]]} at ${worst[0].toFixed(3)} linear albedo, ` +
      `${crown.toFixed(3)} under KEY ${LITTER_KEY} + SKY ${LITTER_SKY} = ${lit.toFixed(2)}, band ${CROWN_BAND[0]}-${CROWN_BAND[1]} ` +
      `(the old 1.35 + 0.95 rig gave that same texel ${(worst[0] * OLD_RIG).toFixed(3)} and clipped it flat)`)
}

// ---------------------------------------------------------------------------
// 4. The same seed is the same patch, and four seeds are four patches.
// ---------------------------------------------------------------------------
//
// Both halves matter and they fail in opposite directions. Without determinism the bake stops being reproducible and a patch cannot be reasoned about at all. Without variation the four layers are one layer baked four times, the scatter's roll buys nothing, and the hillside is stamped with the same photograph everywhere -- which is the failure that would look like a texturing bug rather than like a seeding bug.

console.log('\nseeds')

{
  const key = (p) => p.map((s) => `${s.shape}|${s.tint}|${s.size}|${s.x}|${s.z}|${s.yaw}`).join(' ')
  const repeat = BAKE_SEEDS.map((seed) => key(litterPlacements(seed, pool.length)) === key(patches[BAKE_SEEDS.indexOf(seed)]))
  check(repeat.every(Boolean), 'the same seed is the same patch, every time', `${repeat.filter(Boolean).length} of ${repeat.length} seeds reproduce`)
}

{
  // A REAL DIFFERENCE, not merely a different object. Two things measured, because either one alone has a cheap way of passing: the multiset of shapes says the patches are not drawing the same rocks in the same proportions, and the centre of mass says they are not laid out the same way. Measured centre separations are 2.1 cm at the closest pair and 15.6 cm at the furthest, against patches 1.6 m across; the floor of 1 cm is set below the closest pair and is there to catch two seeds that have collapsed onto one stream, not to police how far apart they wander.
  const CENTRE_FLOOR = 0.01
  const hist = (p) => {
    const h = new Array(pool.length).fill(0)
    for (const s of p) h[s.shape]++
    return h.join(',')
  }
  const centre = (p) => [p.reduce((a, s) => a + s.x, 0) / p.length, p.reduce((a, s) => a + s.z, 0) / p.length]
  const hists = patches.map(hist)
  const centres = patches.map(centre)

  const sameShapes = []
  let closest = Infinity
  let closestAt = ''
  for (let i = 0; i < patches.length; i++) {
    for (let j = i + 1; j < patches.length; j++) {
      if (hists[i] === hists[j]) sameShapes.push(`${BAKE_SEEDS[i]}/${BAKE_SEEDS[j]}`)
      const d = Math.hypot(centres[i][0] - centres[j][0], centres[i][1] - centres[j][1])
      if (d < closest) { closest = d; closestAt = `${BAKE_SEEDS[i]}/${BAKE_SEEDS[j]}` }
    }
  }
  check(sameShapes.length === 0, 'no two of the four baked patches draw the same rocks in the same proportions',
    sameShapes.length ? `seeds ${sameShapes.join(' ')} identical` : `${patches.length} distinct shape histograms`)
  check(closest > CENTRE_FLOOR, 'and no two of them are laid out on top of each other',
    `closest pair ${(closest * 100).toFixed(1)} cm apart at seeds ${closestAt}, floor ${(CENTRE_FLOOR * 100).toFixed(0)} cm, patch is ${(LITTER_PATCH_M * 100).toFixed(0)} cm across`)
}

for (const g of pool) g.dispose()

// ###########################################################################
// THE OTHER HALF: the scatter that stamps the bake on the hill.
//
// Everything above is a photograph nobody has looked at yet. Everything below is where those four pictures LAND: src/v2/render/litter.js, class Litter, a tiled camera-following scatter that lays one 2-triangle quad flat on the terrain per stamp. It is RockBed's machine minus the variant bank and minus the LOD ladder, and the parts it shares with the other four scatters -- tiles, ranks, graded thinning, the build budget, the rim dissolve -- are gated on the trees and the rocks and are not re-argued here.
//
// What is new, and what sections 5 to 12 hold, is the part that is LITTER: that the ground a player walks on has stones on it at a spacing measured in METRES, that a face gets none and gets none for the RIGHT REASON, that a lake bed gets the most stone in the world and gets it from the pass that exists to put it there, that the drift field is doing what it costs nothing to do, and that every stamp is on the ground, flat, square and pointing somewhere.
//
// THE ONE THAT MATTERS IS THE FIRST. This whole subsystem exists because a previous "more stone" change doubled a ratio inside one rock bed, moved the real sight from a rock every 15 m to a rock every 10.6 m, and left every gate green -- because the gate asserted the ratio. Section 5 asserts metres.
//
// A NOTE ON HOW THE CONSTANTS GET HERE. render/litter.js exports only the class, so MAX_SLOPE_DEG, CLIFF_TAN, LITTER_LIFT, LITTER_LIFT_VARY, SCALE, ENV_DENSITY, DENSITY and FULL_RADIUS are module-private and cannot be imported. They are READ OUT OF THE SOURCE TEXT below with a regex rather than copied into this file as literals, because a copied literal is not a gate: it goes on passing after somebody edits the module, which is the exact failure this file is meant to prevent. The three of them the class re-exposes as instance state (maxSlopeTan, fullRadius, perTile) are cross-checked against what the regex read, so a regex that has silently stopped matching the live line fails instead of quietly reading a stale number.
// ###########################################################################

console.log(`\n=== litter scatter, ${LITTER_PATCH_M} m stamps on the hill ===\n`)

// The reader for those private constants. Anchored to `^const NAME = ` so a number that only appears in a COMMENT can never be picked up, and throwing rather than defaulting when the shape of the line changes -- a gate that quietly substitutes a fallback for a constant it can no longer find is worse than no gate.
const SRC = readFileSync(new URL('../src/v2/render/litter.js', import.meta.url), 'utf8')
const srcOf = (name, pattern) => {
  const m = SRC.match(new RegExp(`^const ${name} = ${pattern}$`, 'm'))
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
const LITTER_LIFT = srcNum('LITTER_LIFT')
const LITTER_LIFT_VARY = srcNum('LITTER_LIFT_VARY')
const SCALE = srcPair('SCALE')
const ENV_DENSITY = srcRates('ENV_DENSITY')
const CLUMP_FLOOR = srcNum('CLUMP_FLOOR')
const CLUMP_GAIN = srcNum('CLUMP_GAIN')
const DENSITY = srcNum('DENSITY')
const FULL_RADIUS = srcNum('FULL_RADIUS')

// ---------------------------------------------------------------------------
// 5. Stones on the ground you walk on, counted in metres.
// ---------------------------------------------------------------------------
//
// The stubs are check-rocks.mjs's, verbatim in shape, because Litter needs exactly what Rocks needs: a field with scatterAt / heightAt / snowLineAt / bands, a water surface with levelAt -- which both the environment test and the wet pass go through, isSubmerged being spelled out inline there rather than called -- and a Layers with flattenAt and a snow band for the ground cue. `bands` is 0..900 m, the world's own altitude span, so the flat worlds sit low on the shading ramp and the peak world sits at the top of it. No `ground` is passed: headless, so _groundFor falls through to the field's own height, which is what makes the lift assertions in section 10 exact.

console.log('spacing')

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

// A world with real RELIEF in it, which no flat stub can have, and the only one here where the slope test partly bites instead of refusing everything or nothing. Amplitude and wavelength are check-rocks.mjs's: tan tops out at 1.10 (48 deg), so a little over half the ridge is past MAX_SLOPE_DEG and the rest is walkable ground. `tan` is the field's own analytic gradient rather than a constant, so the slope the scatter tests and the height the stamps are laid on describe one hill rather than two.
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
    snowLineAt: () => 880,
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

// `cliff` is 38.7 deg: past MAX_SLOPE_DEG and, deliberately, still short of the 42 deg _envAt calls a cliff. See section 6. `lake` puts the water level above the ground so everything is submerged; `shore` puts it 0.5 m BELOW the ground, which _envAt still reads as `river` -- the same environment name, nothing under water.
const worlds = {
  forest: build(world(60, 0, 9999, null)),
  cliff: build(world(60, 0.8, 9999, null)),
  peak: build(world(900, 0.5, 880, null)),
  lake: build(world(60, 0, 9999, 60.8)),
  shore: build(world(60, 0, 9999, 59.5)),
  ridge: build(ridge),
}

const liveIds = (l) => {
  const out = []
  for (const t of l.tiles.values()) for (let k = 0; k < t.n; k++) out.push(t.ids[k])
  return out
}
// Mean spacing inside the full-density radius, in metres: the side of the square each stamp has to itself. Counted inside `fullRadius` and nowhere else, because past it the graded thinning takes over and a disc that straddled the boundary would report the thinning rather than the density.
const nearCount = (l) => liveIds(l).filter((id) => l.instX[id] ** 2 + l.instZ[id] ** 2 < l.fullSq).length
const spacing = (l) => {
  const n = nearCount(l)
  return n ? Math.sqrt((Math.PI * l.fullRadius * l.fullRadius) / n) : Infinity
}

{
  // The regexes above, checked against the three constants the class re-exposes. If one of them has gone stale every bound in this half is being measured against a number the module no longer holds.
  const l = worlds.forest
  const readBack = Math.atan(l.maxSlopeTan) * (180 / Math.PI)
  check(Math.abs(readBack - MAX_SLOPE_DEG) < 1e-9 && l.fullRadius === FULL_RADIUS && l.perTile === Math.max(1, Math.round(l.tile * l.tile * DENSITY)),
    'the constants this gate read out of the module source are the ones the class is actually running on',
    `MAX_SLOPE_DEG ${MAX_SLOPE_DEG} = atan(maxSlopeTan) ${readBack.toFixed(3)}, FULL_RADIUS ${FULL_RADIUS} = fullRadius ${l.fullRadius}, DENSITY ${DENSITY} -> ${l.perTile} candidates per ${l.tile} m tile`)
}

{
  // METRES BETWEEN STAMPS, TWO-SIDED, AND IT IS THE REASON THIS SECTION EXISTS. A ratio is not a sight: doubling one moved a rock every 15 m to a rock every 10.6 m and looked identical. This is the sight.
  //
  // Measured at seed 7 inside the 26 m full-density radius: 3.7 m in a wood, 3.4 m on a peak, 3.3 m on a shore.
  //
  // THE CEILING IS THE SPARSE END and is the bug that was just fixed: at the old DENSITY of 0.08 these read 6.1 / 4.6 / 3.3 m, so 4.4 sits under the peak's old 4.6 and a revert fails here on two worlds out of three. The shore does not move between the two densities at all -- it saturates, see section 7 -- which is precisely why the check runs on three grounds and not on the densest one.
  //
  // THE FLOOR IS THE PAVED END. A stamp is LITTER_PATCH_M x SCALE across, so 1.8 m a side at the middle of the range: at a spacing near that the squares meet edge to edge, two overlapping rectangles of gravel show their corners, and the trick stops working. 2.5 m is where a straight doubling of DENSITY would land (3.3 / sqrt(2) = 2.33), so this end catches the opposite mistake to the one that was just made.
  //
  // Counting noise on 150-200 stamps is about 4% of the spacing, so both ends are several times clear of a seed change.
  const SPACING_BAND = [2.5, 4.4]
  const side = LITTER_PATCH_M * ((SCALE[0] + SCALE[1]) / 2)
  const walked = ['forest', 'peak', 'shore']
  const spacings = walked.map((n) => spacing(worlds[n]))
  check(spacings.every((s) => s > SPACING_BAND[0] && s < SPACING_BAND[1]),
    'the ground you walk on has stones on it, close enough together to notice and far enough apart to read as strewn',
    walked.map((n, i) => `${n} one per ${spacings[i].toFixed(1)} m (${nearCount(worlds[n])} stamps, ${((side * side) / (spacings[i] * spacings[i]) * 100).toFixed(0)}% of the ground covered)`).join(', ') +
      `, band ${SPACING_BAND[0]}-${SPACING_BAND[1]} m`)
}

{
  // AND A FACE IS NOT STREWN GROUND. On the sine ridge a little over half the candidates are past the slope limit, so the litter thins to one stamp per 6.7 m, and that is the answer wanted there rather than a failure. Two-sided again, and both ends are real: it must thin (a ridge uniformly as strewn as a wood means the slope test is not biting) and it must not empty (a hill with no litter on any of its walkable ground means the test is biting everything).
  const RIDGE_THIN = [1.25, 3.0]
  const ratio = spacing(worlds.ridge) / spacing(worlds.forest)
  const s = worlds.ridge.stats
  check(ratio > RIDGE_THIN[0] && ratio < RIDGE_THIN[1] && s.placed > 0,
    'and litter thins out where the hill stands up, without abandoning the walkable ground between the faces',
    `one per ${spacing(worlds.ridge).toFixed(1)} m on the ridge against ${spacing(worlds.forest).toFixed(1)} m in the wood, ${ratio.toFixed(2)}x (band ${RIDGE_THIN[0]}-${RIDGE_THIN[1]}), ${s.rejected.slope} of ${s.samples} candidates refused for slope`)
}

// ---------------------------------------------------------------------------
// 6. A cliff face, and the branch of ENV_DENSITY that cannot be reached.
// ---------------------------------------------------------------------------
//
// "The cliff world places zero" is a one-sided bound and would stay green for the wrong reason -- an ENV_DENSITY.cliff that had gone to zero for the wrong ground, an environment test misnaming the slope, a scatter that had stopped placing anything anywhere. So what is asserted is the MECHANISM: the slope test refused every candidate that survived the drift field, and nothing else refused anything.

console.log('\nslope')

{
  const s = worlds.cliff.stats
  // `samples` is incremented after the drift test and before the slope test, so `slope === samples` says exactly "every candidate that reached the terrain was refused for being too steep" without this file having to know how many candidates a tile rolls.
  check(s.placed === 0 && s.rejected.slope === s.samples && s.rejected.env === 0,
    'a cliff face gets no litter, and it is the slope test that refuses it rather than anything downstream',
    `${s.placed} placed, ${s.rejected.slope} of ${s.samples} refused for slope, env ${s.rejected.env}`)
}

{
  // THE TRAP DOCUMENTED AT ENV_DENSITY, ASSERTED. MAX_SLOPE_DEG (34) is strictly below the angle _envAt calls a cliff (CLIFF_TAN, 42 deg), so no candidate can ever carry the name `cliff` into the environment test -- the slope test has already said no. ENV_DENSITY.cliff is therefore dead code held at 0 on purpose, so that raising MAX_SLOPE_DEG past 42 cannot quietly start stamping flat pictures of gravel onto vertical rock.
  //
  // Both halves are asserted, and the first is asserted twice over: once as arithmetic on the two constants, and once by asking the live _envAt what it calls the STEEPEST ground the scatter will admit. If somebody raises MAX_SLOPE_DEG past 42 this goes red, which is the point: the branch comes alive and a person has to decide about it on purpose.
  const steepest = worlds.cliff._envAt(0, 0, 60, worlds.cliff.maxSlopeTan, 9999)
  check(MAX_SLOPE_DEG < CLIFF_DEG && steepest !== 'cliff' && ENV_DENSITY.cliff === 0,
    'no stamp can ever reach the `cliff` rate, so it is held at zero rather than at a plausible-looking number',
    `MAX_SLOPE_DEG ${MAX_SLOPE_DEG} deg < CLIFF_TAN's ${CLIFF_DEG} deg, the steepest admitted ground is \`${steepest}\`, ENV_DENSITY.cliff ${ENV_DENSITY.cliff}`)
}

// ---------------------------------------------------------------------------
// 7. Under the water, and beside it.
// ---------------------------------------------------------------------------
//
// Two worlds and the same environment name in both, which is the whole point of the pair. `river` above the ground and `river` below it are the same rate to ENV_DENSITY, so the environment test cannot be what makes a bed denser than a bank -- it is saturated on both and has nothing left to give. What separates them is the WET PASS, which offers WET_DENSITY more candidates per square metre out of tileSeed slot 1 and throws away everything not standing under water. A gate with only the bank in it would be perfectly green on a scatter that had lost the second pass entirely, and a gate that only counted the bed's stamps would be green on one that had bought them by raising a rate -- which is the mistake this whole subsystem exists to catch, and which cannot even work here because river is already at its cap.

console.log('\nwater')

{
  // THE BED IS LITTERED AND IT IS THE SECOND PASS THAT DOES IT. This file used to assert the opposite -- that a lake bed got nothing and the submersion test was what stopped it -- and the claim was backwards: a riverbed and a lake floor are exactly where loose stone is washed, sorted and left, so the one ground with no litter at all should have had the most of it.
  //
  // Asserted as the mechanism rather than as the count, because "the lake world places a lot" would stay green on a dry pass that had simply stopped testing water while the wet pass did nothing. `samplesWet` is incremented only by candidates that cleared the drift floor AND found a water level, so a positive one says the second pass ran and reached the water; `rejectedWet.dry` is every wet candidate thrown out for standing on land, and on a world that is water everywhere there is no land for one to stand on, so a zero there is the pass agreeing with the world.
  //
  // The last clause is what makes it a gate on the EXTRA stone rather than on any stone. The dry pass places at most one stamp per candidate that reached the terrain, which is exactly `samples`, so `placed > samples` cannot be satisfied by the dry pass however saturated it is -- the surplus can only have come from the second stream. Measured on the lake: 1701 placed against 1000 dry samples and 701 wet ones, and the two sum to the total because nothing downstream of the water test refuses anything on flat saturated shingle.
  const s = worlds.lake.stats
  check(s.samplesWet > 0 && s.rejectedWet.dry === 0 && s.placed > s.samples && s.placed === s.samples + s.samplesWet,
    'a lake bed is littered, and it is the wet pass that lays the extra stone rather than the dry one being turned up',
    `${s.placed} placed = ${s.samples} dry samples + ${s.samplesWet} wet, ${s.rejectedWet.dry} wet candidates refused for being on dry land, ` +
      `wet slope ${s.rejectedWet.slope}, wet env ${s.rejectedWet.env}, one stamp per ${spacing(worlds.lake).toFixed(1)} m`)
}

{
  // The same _envAt name on both worlds, asked of the live method rather than assumed: `river` at a level above the ground and `river` at a level below it. Shingle is the densest ground in the world wet or dry, and the BED is denser than the BANK -- which is the shape the two passes make and the one a single pass cannot.
  //
  // The bank is the dry pass alone, and that is asserted rather than described: on the shore every wet candidate that cleared the drift floor is refused for standing on dry ground (`rejectedWet.dry === samplesWet`), so `placed === samples` says the bank's density is ENV_DENSITY.river's doing and nothing else. Raise WET_DENSITY and the bank does not move by one stamp; that is the whole reason the extra density is a second pass and not a bigger number.
  //
  // Measured inside the 26 m full-density radius: 321 stamps on the bed against 198 on the bank, 189 on a peak and 152 in a wood. Both comparisons are floors on a real gap, not on a hair: the bed is 1.6x the bank and the bank is 1.05x the peak, so the second is the tighter one and is the one that would go red first if the walked grounds were pushed up toward shingle.
  const lakeEnv = worlds.lake._envAt(0, 0, 60, 0, 9999)
  const shoreEnv = worlds.shore._envAt(0, 0, 60, 0, 9999)
  const s = worlds.shore.stats
  const others = ['forest', 'peak'].map((n) => nearCount(worlds[n]))
  check(lakeEnv === 'river' && shoreEnv === 'river' &&
    s.rejectedWet.dry === s.samplesWet && s.placed === s.samples &&
    nearCount(worlds.shore) > Math.max(...others) && nearCount(worlds.lake) > nearCount(worlds.shore),
    'river shingle is the densest ground in the world wet or dry, and the bed carries more of it than the bank',
    `both worlds are \`${shoreEnv}\`; the bank places ${s.placed} from ${s.samples} dry samples with all ${s.samplesWet} of its wet candidates refused for dry land, ` +
      `${nearCount(worlds.lake)} stamps on the bed against ${nearCount(worlds.shore)} on the bank inside ${FULL_RADIUS} m, and ${others.join(' and ')} on the grounds a player walks`)
}

// ---------------------------------------------------------------------------
// 8. The drift field.
// ---------------------------------------------------------------------------
//
// Loose stone lies in drifts with swept ground between them, and a scatter without that reads as an even sprinkle, which is the tell that says "generated" faster than any amount of per-instance variety can undo. _clump is four hashes of position taken BEFORE the terrain sample -- 34 ns against the sample's 4.9 us -- so the candidates it throws away are very nearly free, and it is that freeness which pays for the density everywhere else.

console.log('\ndrift')

{
  // A BAND, because both ends are a real failure: reject nothing and there are no drifts at all, reject nearly everything and there is no litter left to arrange into them. Measured 342 of 1342 candidates, 25.5%, on every world here. (The comment at CLUMP_FLOOR says "two candidates in five"; the field is bilinear value noise and piles up around 0.5, so the true share at a floor of 0.34 is a quarter. The band is set from the measurement.)
  const SHARE_BAND = [0.12, 0.45]
  const s = worlds.forest.stats
  const share = s.rejected.clump / (s.rejected.clump + s.samples)
  check(share > SHARE_BAND[0] && share < SHARE_BAND[1],
    'the litter lies in drifts with swept ground between them, not in an even sprinkle',
    `${s.rejected.clump} of ${s.rejected.clump + s.samples} candidates swept away, ${(share * 100).toFixed(1)}%, band ${(SHARE_BAND[0] * 100).toFixed(0)}-${(SHARE_BAND[1] * 100).toFixed(0)}%`)
}

{
  // AND IT IS POSITION-ONLY, which is what makes it free. The drift is taken before any terrain is touched and draws no randoms, so the SAME candidates are swept on every world -- an identical count across six completely different hills is the observable proof of that, and it is what would break the moment somebody moved the test below the terrain sample or gave it a random of its own (which would also reshuffle every patch in the world, see _growTile).
  const counts = Object.entries(worlds).map(([n, l]) => [n, l.stats.rejected.clump])
  const distinct = new Set(counts.map(([, c]) => c))
  check(distinct.size === 1, 'and the drift is a function of position alone, taken before the ground is ever sampled',
    counts.map(([n, c]) => `${n} ${c}`).join(' '))
}

{
  // AND IT IS STILL DECIDING SOMETHING WHEN IT GETS THERE. The accept test is `envRoll >= ENV_DENSITY[env] * (1 + CLUMP_GAIN * clump)`, and every candidate that reaches it has already cleared CLUMP_FLOOR -- so an environment whose rate at the FLOOR is already 1 refuses nothing, ever, and the gain above it is inert. The failure is silent in the worst way: raising a rate makes the ground denser right up to the point where it stops doing anything at all, and past that the extra number reads as tuning while the drift quietly flattens into an even sprinkle inside every patch it kept.
  //
  // `river` is the one that IS saturated, on purpose and at 0.9 -- see the RIVER IS SATURATED block above ENV_DENSITY, which gives up the gradation inside a drift because buying it back means dropping shingle under 0.842, below the peak, which is the opposite of what the entry exists to say. `cliff` is zero and unreachable and is skipped by name here rather than sliding through as a rate that happens not to saturate; section 6 is where its zero is argued.
  //
  // What is left is the two grounds a player actually walks: `forest` is live across the whole field (it does not reach 1 even at clump 1.0), and `peak` is live from the floor up to clump 0.61 and capped above that. Note that this is WEAKER than "peak is under saturation everywhere" -- 0.75 * 1.55 = 1.163 -- so what is bounded for peak is that the cap sits above the floor, which is what keeps the gain deciding something over most of the range. Raising forest at all, or raising peak into saturation at the floor, fails here, which is the point: it makes somebody come to this line and say so on purpose.
  //
  // Cross-checked against the live scatters, not just asserted as arithmetic: the shore is `river` and must refuse nothing for env, and the two walked worlds must refuse something.
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
    envRejects.river === 0 && envRejects.forest > 0 && envRejects.peak > 0,
    'the drift field still decides something on every ground except river shingle, where saturation is the point',
    `${table} (clump floor ${CLUMP_FLOOR}, gain ${CLUMP_GAIN}, \`cliff\` skipped by name at rate ${ENV_DENSITY.cliff}); ` +
      `live, the shore refuses ${envRejects.river} candidates for env against the wood's ${envRejects.forest} and the peak's ${envRejects.peak}`)
}

// ---------------------------------------------------------------------------
// 9. The instance pool.
// ---------------------------------------------------------------------------
//
// _poolBound running short does not degrade, it THROWS: `Litter: instance pool exhausted`. So the bound has to cover the densest ground in the world and a walk across the most broken one, and the check has to be two-sided, because a pool that is never more than a seventh full is an arena allocation nobody is using.

console.log('\npool')

{
  const FULL_BAND = [0.15, 0.95]
  const used = (l) => l.maxInstances - l.freeCount
  const densest = worlds.shore

  // The traverse: 400 steps across the ridge, draining the queue at each one so every tile is grown at every quantised level rather than at the handful the budget would allow in a frame. This is the case a single `place` cannot reach, because it never evicts and regrows anything.
  const walk = build(ridge)
  let peak = 0
  for (let i = 0; i < 400; i++) {
    walk.update(i * 3.1, 900, i * 1.7)
    while (walk.queue.length) walk._growTile(walk.queue.pop())
    peak = Math.max(peak, used(walk))
  }

  // Measured: the shore, the densest ground there is, uses 1000 of 2309 (43%), and the traverse peaks at 623 (27%). Both ends of the band are a real failure -- 100% throws, and a pool that never passes 15% is paying for instances nothing will ever fill.
  const worst = Math.max(used(densest), peak) / densest.maxInstances
  check(used(densest) < densest.maxInstances && worst < FULL_BAND[1] && worst > FULL_BAND[0],
    'the pool covers the densest ground in the world and a walk across the roughest, without being sized for a world that does not exist',
    `shore ${used(densest)}/${densest.maxInstances} (${((used(densest) / densest.maxInstances) * 100).toFixed(0)}%), ridge traverse peak ${peak} (${((peak / walk.maxInstances) * 100).toFixed(0)}%), band ${(FULL_BAND[0] * 100).toFixed(0)}-${(FULL_BAND[1] * 100).toFixed(0)}%`)

  // And running dry throws rather than quietly placing less, so the fact that the densest world got here at all is half the promise. Stated as its own line because it is the failure mode a player would see as a crash on a riverbank.
  check(densest.placed > 0 && densest.freeCount > 0, 'and the densest ground in the world never ran it dry',
    `${densest.freeCount} instances still free after ${densest.placed} stamps`)
  walk.dispose()
}

// ---------------------------------------------------------------------------
// 10. Every stamp is on the ground, flat, square, and pointing somewhere.
// ---------------------------------------------------------------------------
//
// Read back off the instance matrices the scatter actually wrote, decomposed, rather than off the arrays it kept. The ridge is what the lift and the tilt are measured on, because a flat world has a normal of exactly up and would keep the tilt promise by doing nothing at all; the flat shore is what the yaw and the scale are measured on, because there the rotation IS the yaw and can be read straight out of the matrix without this file re-deriving the tilt it is supposed to be checking.

console.log('\nstamps')

{
  const m = new THREE.Matrix4()
  const p = new THREE.Vector3()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const up = new THREE.Vector3(0, 1, 0)
  const axis = new THREE.Vector3()
  const n = new THREE.Vector3()

  const lifts = []
  let worstTilt = 0
  for (const id of liveIds(worlds.ridge)) {
    worlds.ridge.batch.getMatrixAt(id, m)
    m.decompose(p, q, s)
    lifts.push(p.y - ridge.field.heightAt(p.x))
    // The ridge's ANALYTIC normal, which is deliberately not the central difference _groundTilt takes: an independent derivation of the same thing, so this check cannot pass by re-implementing the code under it. Over a 1.2 m half-width the two differ by under a fiftieth of a degree at the steepest point on the hill.
    n.set(-(RIDGE_A / RIDGE_L) * Math.cos(p.x / RIDGE_L), 1, 0).normalize()
    axis.copy(up).applyQuaternion(q)
    worstTilt = Math.max(worstTilt, Math.acos(Math.min(1, axis.dot(n))) * (180 / Math.PI))
  }
  if (!lifts.length) throw new Error('no stamps on the ridge to measure')

  // Headless, so _groundFor falls through to the field's own height and the lift is exact: LITTER_LIFT to LITTER_LIFT + LITTER_LIFT_VARY, no drawn-mesh disagreement in it. Measured 0.0502 to 0.0749 against 0.050 to 0.075. The tolerance is float32: instY and the matrix are both single precision and the ridge stands at 900 m, which puts about 1e-4 of slop on the difference.
  const EPS = 2e-3
  const lo = Math.min(...lifts)
  const hi = Math.max(...lifts)
  check(lo > LITTER_LIFT - EPS && hi < LITTER_LIFT + LITTER_LIFT_VARY + EPS,
    'every stamp lies on the hill it was placed on, a few centimetres proud of it and no more',
    `${(lo * 100).toFixed(2)}-${(hi * 100).toFixed(2)} cm above the ground over ${lifts.length} stamps, against ${(LITTER_LIFT * 100).toFixed(1)}-${((LITTER_LIFT + LITTER_LIFT_VARY) * 100).toFixed(1)} cm`)

  // AND THE JITTER IS ALIVE. Litter is scattered with no overlap test, so stamps DO land on each other, and two coplanar quads at one height z-fight over their whole intersection -- the one artefact on this ground that reads instantly as broken. LITTER_LIFT_VARY is the whole defence and it fails silently: set it to zero and every check above is still green. Measured spread is 2.48 cm of the 2.5 available.
  check(hi - lo > LITTER_LIFT_VARY * 0.5,
    'and two stamps lying on each other are at different heights, so they cannot z-fight',
    `${((hi - lo) * 100).toFixed(2)} cm of spread out of the ${(LITTER_LIFT_VARY * 100).toFixed(1)} cm available`)

  // FULL alignment with the field normal, which is where this file's geometry argument differs from every rock bed's: a boulder tipped all the way into the ground normal looks placed, so the beds lerp part of the way, but a picture of gravel that is not flat on the ground is a picture of gravel hovering. Measured worst 0.016 deg over the whole ridge, so a degree is a bound on the ARITHMETIC rather than on the intent -- anything that lerped the tilt at all would show up in whole degrees.
  const TILT_TOL_DEG = 1
  check(worstTilt < TILT_TOL_DEG, 'and it lies FLAT on it -- the quad\'s own up is the ground\'s own normal, not a lean toward it',
    `worst ${worstTilt.toFixed(3)} deg off the field normal over ${lifts.length} stamps, tolerance ${TILT_TOL_DEG} deg`)
}

{
  // The flat shore: no tilt, so the matrix's rotation is the yaw alone and the scale falls out of the column lengths.
  const m = new THREE.Matrix4()
  const ids = liveIds(worlds.shore)
  const BINS = 12
  const bins = new Array(BINS).fill(0)
  const yaws = new Set()
  let minSide = Infinity
  let maxSide = -Infinity
  let worstAniso = 0
  let worstFlat = 0
  for (const id of ids) {
    worlds.shore.batch.getMatrixAt(id, m)
    const e = m.elements
    const sx = Math.hypot(e[0], e[1], e[2])
    const sy = Math.hypot(e[4], e[5], e[6])
    const sz = Math.hypot(e[8], e[9], e[10])
    minSide = Math.min(minSide, sx, sz)
    maxSide = Math.max(maxSide, sx, sz)
    worstAniso = Math.max(worstAniso, Math.abs(sx - sz))
    worstFlat = Math.max(worstFlat, Math.abs(sy - 1))
    const yaw = Math.atan2(-e[2] / sx, e[0] / sx)
    yaws.add(yaw.toFixed(5))
    bins[Math.min(BINS - 1, Math.floor(((yaw + Math.PI) / (2 * Math.PI)) * BINS))]++
  }

  // A stamp is SQUARE and it is the size the bake was drawn at. The quad is built at side 1 so the matrix scale is metres of patch directly: LITTER_PATCH_M x SCALE, which is 1.36 to 2.24 m, and measured 1.3613 to 2.2395. An anisotropic stamp would stretch the photographed stones out of round, which is the one distortion gravel cannot survive; the Y column stays exactly 1 because a flat quad has no thickness to scale.
  const want = [LITTER_PATCH_M * SCALE[0], LITTER_PATCH_M * SCALE[1]]
  check(minSide >= want[0] - 1e-4 && maxSide <= want[1] + 1e-4 && worstAniso < 1e-5 && worstFlat < 1e-5,
    'a stamp is square, unstretched, and the size a 20 cm stone was photographed at',
    `${minSide.toFixed(3)}-${maxSide.toFixed(3)} m a side against ${want[0].toFixed(3)}-${want[1].toFixed(3)}, worst x/z difference ${worstAniso.toExponential(1)} m`)

  // AND THE YAW IS SPREAD OVER THE WHOLE CIRCLE. Four pictures is only more than four patches because each one is stamped at a continuous rotation, so the repeat the eye can catch is a picture next to the same picture turned some other way -- which is exactly the trick that works on litter, a thing with no up, no grain and no silhouette, and would not work on a tree. Two-sided by construction: every twelfth of the circle has to carry roughly a twelfth of the stamps. Measured 71 to 98 against an expected 83.3 over 1000, and one standard deviation is 8.7, so the band sits well past three of them.
  const YAW_BAND = [0.6, 1.4]
  const expect = ids.length / BINS
  const worstBin = Math.max(...bins.map((b) => Math.abs(b / expect - 1)))
  check(bins.every((b) => b > expect * YAW_BAND[0] && b < expect * YAW_BAND[1]) && yaws.size > ids.length / 2,
    'and every one of them is turned a different way, which is what makes four pictures more than four patches',
    `${bins.join(' ')} over ${BINS} bins, expected ${expect.toFixed(1)} each, worst ${(worstBin * 100).toFixed(0)}% off (band +/-${((YAW_BAND[1] - 1) * 100).toFixed(0)}%), ${yaws.size} distinct angles in ${ids.length} stamps`)
}

// ---------------------------------------------------------------------------
// 11. All four baked pictures reach the hill.
// ---------------------------------------------------------------------------
//
// "Which of the four pictures" is one per-instance float, `texLayer`, picked with `Math.min(3, (layerRoll * 4) | 0)` over the arena's single quad. Nothing else in the system would notice if that roll collapsed -- three of the four bakes would simply never be seen, the hill would be stamped with one photograph, and every count, spacing and matrix check above would stay green.

console.log('\nlayers')

{
  const SHARE_BAND = [0.2, 0.3]
  const l = worlds.shore
  const counts = new Array(LITTER_LAYERS.length).fill(0)
  for (const id of liveIds(l)) {
    const slot = LITTER_LAYERS.indexOf(l.batch.getAttrAt(l.texLayerAttr, id))
    if (slot < 0) throw new Error('a litter instance is wearing a texLayer that is not one of the four baked pictures')
    counts[slot]++
  }
  const total = counts.reduce((a, b) => a + b, 0)
  const shares = counts.map((c) => c / total)
  // Measured 0.250 / 0.263 / 0.232 / 0.255 over 1000 stamps; one standard deviation on a quarter share of 1000 is 0.014, so a 20-30% band is about three and a half of them either way. The top of the band matters as much as the floor: one picture at 40% and another at 10% is the roll drifting, not just a picture going missing.
  check(shares.every((s) => s > SHARE_BAND[0] && s < SHARE_BAND[1]) && counts.length === LITTER_LAYERS.length,
    'all four baked pictures are on the hill, and no one of them is doing most of the work',
    `${counts.join(' / ')} of ${total} stamps, ${shares.map((s) => `${(s * 100).toFixed(1)}%`).join(' / ')}, band ${(SHARE_BAND[0] * 100).toFixed(0)}-${(SHARE_BAND[1] * 100).toFixed(0)}%`)
}

// ---------------------------------------------------------------------------
// 12. One seed, one scatter.
// ---------------------------------------------------------------------------
//
// Both halves, and they fail in opposite directions. Without determinism the litter moves under the player's feet as tiles are evicted and regrown, and nothing about the ground can be reasoned about at all. Without the seed doing anything, every world in the game gets the same drifts in the same places.

console.log('\nseeds')

{
  const stamps = (l) => liveIds(l).map((id) => `${l.instX[id]}|${l.instY[id]}|${l.instZ[id]}`).sort()
  const flat = world(60, 0, 9999, null)
  const a = build(flat)
  const b = build(flat)
  const c = build(flat, SEED + 1)
  const sa = stamps(a)
  const sb = stamps(b)
  const sc = stamps(c)

  check(sa.length === sb.length && sa.every((v, i) => v === sb[i]), 'the same seed is the same scatter, stone for stone',
    `${sa.length} stamps, ${sa.filter((v, i) => v !== sb[i]).length} in a different place the second time`)

  // A REAL DIFFERENCE, not merely a different count: tileSeed mixes the seed into every tile, so essentially no stamp should land where a stamp of the other seed landed. The floor is on the OVERLAP rather than on the totals, because two seeds that place the same number of stamps in the same places would pass any count-based check there is.
  const shared = new Set(sa)
  const overlap = sc.filter((v) => shared.has(v)).length
  check(overlap === 0 && sc.length !== 0, 'and a different seed is a different scatter, not the same one relabelled',
    `seed ${SEED} placed ${sa.length}, seed ${SEED + 1} placed ${sc.length}, ${overlap} stamps in common`)

  a.dispose()
  b.dispose()
  c.dispose()
}

{
  const s = worlds.shore.stats
  console.log(`       ${s.placed} stamps, ${s.tris} tris, ${s.tiles} tiles resident, build ${s.buildMs.toFixed(1)} ms, place ${s.placeMs.toFixed(0)} ms`)
}

for (const l of Object.values(worlds)) l.dispose()

console.log(`\n${failures === 0 ? 'all litter checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
