// Node-side gates for the procedural rocks (src/props/rock.js, DESIGN.md §5/§9).
//
//   node scripts/check-rocks.mjs [seeds]
//
// A rock fails the way every closed procedural solid fails: not by throwing,
// but by being subtly wrong in a way you only notice standing next to it. The
// six failures this file exists to catch, in the order they cost the most:
//
//   THE LOD TIERS STOP BEING THE SAME ROCK. The entire ladder argument -- and
//   the answer to "can a boulder's LOD1 be a cobble's LOD0" -- rests on the
//   displacement field being a pure function of the original unit direction. If
//   anything ever makes it depend on the vertex ORDER, the vertex COUNT, or a
//   shared random stream, the tiers silently drift apart and the world gets a
//   pop that nobody can trace back to a line of code. So this measures the
//   agreement directly: it ray-marches the same directions through every tier
//   and asserts the radii track.
//
//   THE ROCK STOPS SITTING ON THE GROUND. `sit` cuts the bottom off and stands
//   the cut face on y = 0, and the whole scatter assumes it. A rock whose
//   minimum y is -0.03 floats; one at +0.03 is buried. Neither throws.
//
//   THE ATTRIBUTE LAYOUT DRIFTS. BatchedMesh validates that every geometry in
//   the batch has an identical layout and refuses the whole mesh over one stray
//   `uv`, so this is a boot failure for the entire prop batch, not for rocks.
//
//   THE SHIPPED TILE STOPS BEING TINTABLE. stone.png is graded bright and
//   near-neutral on purpose (tools/props/cut-rock.mjs): a tint is a multiply, so
//   the tile's mean is the ceiling every environment is measured down from, and
//   a saturated tile fights every tint laid over it. Both are one number and
//   both are checked, because a future re-grade that "looks nicer" in isolation
//   is exactly how this gets broken.
//
//   SNOW STOPS READING AS SNOW ON STONE. Snow arrives on a rock in patches, and
//   how patchy it is comes down to one weight in material.js that looks eminently
//   tunable by eye. Tuned toward the surface normal it gives you a clean white
//   cap whose rim is a contour -- and worse, since a cut facet has ONE normal,
//   whole facets flip at once and the snowline turns into a straight seam along
//   the facet edges. Section 6 holds that weight to the promises the comments
//   beside it make.
//
//   THE MOSS TILE GETS RE-GRADED TO MATCH THE STONE. It must not: moss.png is
//   the one shipped tile nothing tints, because MOSS_APPLY lays it over the
//   rock's already-tinted diffuse. So it is graded dark and saturated where
//   stone.png is graded bright and neutral, and the two sitting next to each
//   other in public/rocks/ is exactly how somebody would come to "fix" it.
//   Section 5 states the bounds and why each one is where it is.

import * as THREE from 'three'

import { buildRock, rockClass, ROCK_TIERS, ROCK_LADDERS, ROCK_DEFAULTS, BOX_MARGIN } from '../src/props/rock.js'
import {
  buildRockBank, rockParams, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, ROCK_NAMES, ROCK_VARIANTS,
  TINTS, TINT_GAIN,
} from '../src/props/rock-bank.js'
import { Rocks } from '../src/v2/render/rocks.js'
import {
  LAYER, TILE_METRES, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, SNOW_ROCK_LAYERS, MOSS_LAYERS, ROCK_TILE_MEAN,
  buildTextureArray,
} from '../src/textures.js'
import { SNOW_ROCK, MOSS, getSnowLine, getMossLine, setMossVary, getMossVary } from '../src/material.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { readPng } from '../tools/props/png.mjs'

const SEEDS = Number(process.argv[2] ?? 200)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// A spread of shapes rather than a spread of seeds alone: the interesting bugs
// live in the corners of the parameter space, not in the noise field.
const SHAPES = [
  { name: 'default', over: {} },
  { name: 'boulder', over: { size: 1.8, cuts: 4, cutDepth: 0.6, smooth: 0.5 } },
  { name: 'crag', over: { size: 7, squash: 1.05, cuts: 7, cutDepth: 0.86, cutBias: 0.75, taper: 0.35, shards: 3 } },
  { name: 'slab', over: { size: 1.1, squash: 0.28, elongate: 1.6, cutBias: -0.9, sit: 0.42 } },
  { name: 'spire', over: { size: 2.2, squash: 2.4, cutBias: 0.95, taper: 0.85, taperPow: 2.2, foot: 0.7, strata: 4 } },
  // The taper run the other way: wider at the top than the bottom. Rare in the
  // bank (only `erratic`) and the one direction where a profile bug shows up as
  // an inverted rock rather than as a slightly wrong one.
  { name: 'mushroom', over: { size: 2.4, taper: -0.55, taperPow: 1.4, foot: 0, sit: 0.2 } },
  { name: 'pebble', over: { size: 0.09, sit: 0.05, cuts: 2 } },
  { name: 'no cuts', over: { cuts: 0, smooth: 1 } },
  { name: 'max cuts', over: { cuts: 10, cutDepth: 1, smooth: 0 } },
  { name: '5 shards', over: { shards: 5, shardSpread: 1.1, shardTilt: 1.1 } },
]

console.log(`\n=== rock checks, ${SEEDS} seeds x ${SHAPES.length} shapes x ${ROCK_TIERS.length} tiers ===\n`)

// ---------------------------------------------------------------------------
// 1. Every tier of every shape of every seed is a well-formed batch geometry.
// ---------------------------------------------------------------------------

console.log('geometry')

const LAYOUT = ['position', 'normal', 'uvProj', 'texLayer']
const bad = {
  attrs: 0, unindexed: 0, nonIdentity: 0, nan: 0, triCount: 0,
  offGround: 0, wrongSize: 0, badNormal: 0, wrongLayer: 0, degenerate: 0,
}
const worst = { ground: 0, size: 0, overSize: 0, normal: 0, degenFrac: 0 }
let totalTris = 0
let builds = 0

for (let seed = 1; seed <= SEEDS; seed++) {
  for (const shape of SHAPES) {
    for (let t = 0; t < ROCK_TIERS.length; t++) {
      const geo = buildRock({ ...shape.over, seed, tier: t })
      builds++

      const names = Object.keys(geo.attributes).sort()
      if (names.join(',') !== [...LAYOUT].sort().join(',')) bad.attrs++
      if (!geo.index) bad.unindexed++

      const pos = geo.attributes.position.array
      const nrm = geo.attributes.normal.array
      const uv = geo.attributes.uvProj.array
      const lay = geo.attributes.texLayer.array
      const idx = geo.index.array

      // The index is an identity -- every face owns its vertices, because every
      // face has its own normal and its own projection axis. If it ever stops
      // being one, something started welding vertices and the flat facets are gone.
      let identity = idx.length === pos.length / 3
      for (let i = 0; identity && i < idx.length; i++) if (idx[i] !== i) identity = false
      if (!identity) bad.nonIdentity++

      let nan = 0
      for (const v of pos) if (!Number.isFinite(v)) nan++
      for (const v of nrm) if (!Number.isFinite(v)) nan++
      for (const v of uv) if (!Number.isFinite(v)) nan++
      if (nan) bad.nan++

      const stats = geo.userData.rock
      const shards = Math.max(1, Math.round(shape.over.shards ?? ROCK_DEFAULTS.shards))
      if (stats.triangles !== ROCK_TIERS[t].faces * shards) bad.triCount++
      totalTris += stats.triangles

      for (const v of lay) if (v !== LAYER.ROCK) { bad.wrongLayer++; break }

      // Sits on y = 0, within a hair of the rock's own size.
      let minY = Infinity
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i + 1] < minY) minY = pos[i + 1]
        if (pos[i] < minX) minX = pos[i]
        if (pos[i] > maxX) maxX = pos[i]
        if (pos[i + 2] < minZ) minZ = pos[i + 2]
        if (pos[i + 2] > maxZ) maxZ = pos[i + 2]
      }
      const size = shape.over.size ?? ROCK_DEFAULTS.size
      const groundErr = Math.abs(minY) / size
      if (groundErr > 1e-4) bad.offGround++
      worst.ground = Math.max(worst.ground, groundErr)

      // A tier's own box is allowed to wander either side of `size`, and the two
      // directions are bounded by different things. Over is bounded by
      // buildRock's BOX_MARGIN, which is a hard clamp -- if a tier ever measures
      // wider than that, the cap has stopped being applied. Under is bounded by
      // nothing but the solid: a coarse tier's widest vertex can point somewhere
      // narrow, and the support gain corrects the AREA rather than the span, so
      // a third off is real on a tall spire. Past a third and the tiers have
      // stopped being the same rock long before check 2 would catch it.
      const span = Math.max(maxX - minX, maxZ - minZ)
      const shrink = 1 - span / size
      if (shrink < 1 - BOX_MARGIN - 1e-3 || shrink > 0.34) bad.wrongSize++
      worst.overSize = Math.max(worst.overSize, -shrink)
      worst.size = Math.max(worst.size, shrink)

      let normErr = 0
      for (let i = 0; i < nrm.length; i += 3) {
        normErr = Math.max(normErr, Math.abs(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) - 1))
      }
      if (normErr > 1e-3) bad.badNormal++
      worst.normal = Math.max(worst.normal, normErr)

      // Faces the bed plane clamped flat. A handful is the cost of a flat
      // bottom; a large fraction means `sit` is eating the rock.
      let degen = 0
      const faces = pos.length / 9
      for (let f = 0; f < faces; f++) {
        const o = f * 9
        const abx = pos[o + 3] - pos[o], aby = pos[o + 4] - pos[o + 1], abz = pos[o + 5] - pos[o + 2]
        const acx = pos[o + 6] - pos[o], acy = pos[o + 7] - pos[o + 1], acz = pos[o + 8] - pos[o + 2]
        const cx = aby * acz - abz * acy
        const cy = abz * acx - abx * acz
        const cz = abx * acy - aby * acx
        if (Math.hypot(cx, cy, cz) < 1e-9) degen++
      }
      const degenFrac = degen / faces
      if (degenFrac > 0.2) bad.degenerate++
      worst.degenFrac = Math.max(worst.degenFrac, degenFrac)

      geo.dispose()
    }
  }
}

check(bad.attrs === 0, 'every geometry is exactly { position, normal, uvProj, texLayer }', `${bad.attrs} wrong`)
check(bad.unindexed === 0, 'every geometry is indexed (BatchedMesh refuses otherwise)', `${bad.unindexed} not`)
check(bad.nonIdentity === 0, 'the index is an identity -- no welding, so facets stay flat', `${bad.nonIdentity} not`)
check(bad.nan === 0, 'no NaN in position, normal or uvProj', `${bad.nan} builds with NaN`)
check(bad.triCount === 0, 'triangles = tier faces x shards, exactly', `${bad.triCount} off`)
check(bad.wrongLayer === 0, 'every vertex wears LAYER.ROCK', `${bad.wrongLayer} builds off-layer`)
check(bad.offGround === 0, 'the bed plane sits on y = 0', `worst ${(worst.ground * 100).toFixed(4)}% of size`)
check(bad.wrongSize === 0, 'every tier measures `size`, give or take a coarse corner', `worst -${(worst.size * 100).toFixed(0)}% / +${(worst.overSize * 100).toFixed(0)}%, cap +${((BOX_MARGIN - 1) * 100).toFixed(0)}%`)
check(bad.badNormal === 0, 'every normal is unit length', `worst |n|-1 = ${worst.normal.toExponential(1)}`)
check(bad.degenerate === 0, 'the bed plane flattens only a few faces', `worst ${(worst.degenFrac * 100).toFixed(0)}% of faces`)
console.log(`       ${builds} builds, ${totalTris} triangles`)

// ---------------------------------------------------------------------------
// 2. The tiers are the same rock.
// ---------------------------------------------------------------------------
//
// This is the load-bearing check on this page. The claim rock.js makes is that
// displacement is a pure function of the original unit direction, so a coarse
// solid is the fine one sampled at fewer directions -- which is what makes
// ROCK_LADDERS legal and what makes a tier change lose corners instead of
// swapping rocks.
//
// Measured as SUPPORT AGREEMENT rather than by comparing vertices, because the
// tiers have no vertices in common: for a spread of directions, how far does
// the hull reach that way? Two different things are being asked, and they are
// not the same test. The BIAS (mean signed error) is what a player sees as a
// pop -- a tier that is uniformly small makes the rock jump backwards at the
// switch, and that is what buildRock's support-matching gain exists to kill, so
// it is held to a tight bound. The SPREAD is the corners a coarse solid cannot
// represent; it is inherently large for an 8-face LOD2 and only has to stay
// bounded. A tier that has drifted onto a different noise field blows the spread
// wide open while leaving the bias near zero, which is why both are reported.

console.log('\ntiers')

// Support taken about the rock's mid-height, not about its origin. The origin
// is on the BED PLANE, so a support measured from there is a radius in the
// upper hemisphere and nearly zero in the lower one, and every error quoted as
// a fraction of it comes out roughly double.
function support(pos, dx, dy, dz, cy) {
  let m = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    const d = pos[i] * dx + (pos[i + 1] - cy) * dy + pos[i + 2] * dz
    if (d > m) m = d
  }
  return m
}

const PROBES = []
for (let i = 0; i < 64; i++) {
  // Fibonacci sphere, so the probe directions do not line up with any solid's
  // own vertices -- which would flatter exactly the tier they came from.
  const y = 1 - (2 * (i + 0.5)) / 64
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const a = i * Math.PI * (3 - Math.sqrt(5))
  PROBES.push([Math.cos(a) * r, y, Math.sin(a) * r])
}

// Per tier, because the tiers are not one population: T80 should be within a
// whisker of T180 and T8 never will be, so one pooled number would either let a
// broken T80 hide behind T8's honest spread or fail T8 for being 8 faces. Also
// per (shape, tier), so a shape whose bias is large cannot cancel against one
// whose bias is large the other way.
// `worst` is the deepest single-probe disagreement: how much silhouette this
// tier's flat faces cut off (or its gain pushed out) at the one direction where
// the coarse solid samples worst.
const stat = ROCK_TIERS.map(() => ({ sum: 0, abs: 0, n: 0, over: 0, under: 0 }))
let worstShapeBias = 0
let worstShapeBiasName = ''

for (let seed = 1; seed <= Math.min(SEEDS, 60); seed++) {
  for (const shape of SHAPES) {
    const fine = buildRock({ ...shape.over, seed, tier: 0 }).attributes.position.array
    // Errors are quoted against how far this rock's hull actually reaches, not
    // against `size`. `size` is a horizontal measurement, so on a spire two and
    // a half times taller than it is wide it turns an ordinary vertical
    // disagreement into a scary-looking percentage of the wrong number.
    let fineTop = 0
    for (let i = 1; i < fine.length; i += 3) if (fine[i] > fineTop) fineTop = fine[i]
    const cy = fineTop / 2
    const reach = PROBES.reduce((s, [dx, dy, dz]) => s + support(fine, dx, dy, dz, cy), 0) / PROBES.length
    for (let t = 1; t < ROCK_TIERS.length; t++) {
      const coarse = buildRock({ ...shape.over, seed, tier: t }).attributes.position.array
      let shapeSum = 0
      for (const [dx, dy, dz] of PROBES) {
        const a = support(fine, dx, dy, dz, cy)
        const b = support(coarse, dx, dy, dz, cy)
        const err = (b - a) / reach
        const s = stat[t]
        s.over = Math.max(s.over, err)
        s.under = Math.max(s.under, -err)
        s.abs += Math.abs(err)
        s.sum += err
        s.n++
        shapeSum += err
      }
      const shapeBias = Math.abs(shapeSum / PROBES.length)
      if (shapeBias > worstShapeBias) {
        worstShapeBias = shapeBias
        worstShapeBiasName = `${shape.name} ${ROCK_TIERS[t].name} seed ${seed}`
      }
    }
  }
}

// Budgets per tier: mean |error|, then the deepest single probe. Set from what
// the solids can actually deliver, with room for the noise field to move, and
// tight enough that a tier drifting onto a different shape trips them.
//
// RE-CUT when ROCK_DEFAULTS got knobblier (lumps 0.26 -> 0.55, grain 0.09 ->
// 0.25, cuts 5 -> 10), which is an art decision the generator has to serve
// rather than argue with. It costs spread and there is no way around it: a hull
// with twice the relief has twice as much between any two samples for a coarse
// solid to miss, so the same 8 faces track it worse. Measured mean/worst at
// these defaults are 6.0/46, 10.5/82 and 17.3/98 per cent of reach; the budgets
// below sit ~25% above that, so a real drift still trips them.
//
// What is NOT allowed to move with the art is bias, checked separately above at
// 8%, and it did not: -0.0 / -0.1 / +0.1 per cent. That is the split this
// section exists to keep. Every tier is still the same size as the rock it
// replaces; a T8 of a lumpier rock is simply a rougher account of its corners.
const SPREAD = { T80: [0.08, 0.6], T20: [0.13, 0.95], T8: [0.21, 1.25] }

check(worstShapeBias < 0.08, 'no tier reads systematically bigger or smaller', `worst ${(worstShapeBias * 100).toFixed(1)}% of reach, ${worstShapeBiasName}`)
for (let t = 1; t < ROCK_TIERS.length; t++) {
  const s = stat[t]
  const name = ROCK_TIERS[t].name
  const [meanCap, probeCap] = SPREAD[name]
  const mean = s.abs / s.n
  const deepest = Math.max(s.over, s.under)
  check(
    mean < meanCap && deepest < probeCap,
    `${name} is ${ROCK_TIERS[0].name}'s hull, sampled on ${ROCK_TIERS[t].faces} faces`,
    `bias ${((s.sum / s.n) * 100).toFixed(1)}%, mean ${(mean * 100).toFixed(1)}%, worst ${(deepest * 100).toFixed(0)}%`,
  )
}

// A boulder's LOD1 IS a cobble's LOD0. Asserted rather than asserted-in-prose,
// because it is the thing the user asked for and the thing a refactor breaks.
{
  const shared = { seed: 7, lumps: 0.26, cuts: 4, cutDepth: 0.6 }
  const boulderLod1 = buildRock({ ...shared, size: 1.8, tier: ROCK_LADDERS.boulder[1] })
  const cobbleLod0 = buildRock({ ...shared, size: 1.8, tier: ROCK_LADDERS.cobble[0] })
  const a = boulderLod1.attributes.position.array
  const b = cobbleLod0.attributes.position.array
  let same = a.length === b.length
  for (let i = 0; same && i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) same = false
  check(same, "a boulder's LOD1 and a cobble's LOD0 are the same mesh", `${ROCK_TIERS[ROCK_LADDERS.boulder[1]].name}`)
}

// Every ladder is coarsest-last and only names tiers that exist.
{
  let ok = true
  for (const [name, tiers] of Object.entries(ROCK_LADDERS)) {
    for (let i = 0; i < tiers.length; i++) {
      if (!ROCK_TIERS[tiers[i]]) ok = false
      if (i > 0 && tiers[i] <= tiers[i - 1]) ok = false
    }
    if (!name) ok = false
  }
  check(ok, 'every ROCK_LADDERS entry is a real, monotonically coarsening ladder')
}

// rockClass and ROCK_LADDERS have to agree, or a size lands in a class with no
// ladder and the scatter has nothing to draw.
{
  let ok = true
  for (const size of [0.02, 0.1, 0.14, 0.15, 0.5, 0.79, 0.8, 2.9, 3, 14]) {
    if (!ROCK_LADDERS[rockClass(size)]) ok = false
  }
  check(ok, 'rockClass() only ever names a class that has a ladder')
}

// ---------------------------------------------------------------------------
// 3. Texture scale, which is now a property of the rock rather than of the world.
// ---------------------------------------------------------------------------
//
// This section used to assert the OPPOSITE invariant: UVs were world extents
// over a fixed TILE_METRES[ROCK], so a 12 cm cobble and a 14 m crag wore the same
// size of crystal, and the check built one shape at two sizes 100x apart and
// demanded the UV span scale with the metres. That is the textbook answer and it
// looks wrong on a big rock -- a fixed tile on a 14 m outcrop is just one
// photograph repeated fifteen times, which reads as fabric, not as stone.
//
// So the tile scales with the rock, and the invariant inverts: the same seed at
// any size is the SAME PICTURE, which is what makes a preset a shape rather than
// a shape-at-a-size. Two things have to hold for that to be true and useful.

console.log('\ntexture scale')

const uvSpan = (geo) => {
  const uv = geo.attributes.uvProj.array
  let lo = Infinity
  let hi = -Infinity
  for (const v of uv) { if (v < lo) lo = v; if (v > hi) hi = v }
  return hi - lo
}

{
  // (a) Scale-free. Resizing a rock must not change what its texture looks like.
  const small = buildRock({ seed: 4, size: 0.12, tier: 1 })
  const big = buildRock({ seed: 4, size: 12, tier: 1 })
  const ratio = uvSpan(big) / uvSpan(small)
  check(Math.abs(ratio - 1) < 0.02, 'UV span is decided by the rock, not by its metres', `${ratio.toFixed(3)}x over a 100x size change`)

  // (b) Tier-free. The jitter is rolled off `seed` alone, so an LOD switch cannot
  // rescale the texture. This is the one that would be easy to break by folding
  // the tier or the vertex count into the roll, and a texture that jumped scale
  // mid-switch would be a worse pop than the silhouette one the gain exists to kill.
  const metres = ROCK_TIERS.map((_, tier) => buildRock({ seed: 4, size: 2, tier }).userData.rock.texMetres)
  check(metres.every((m) => Math.abs(m - metres[0]) < 1e-9),
    'every tier of one rock wears the same tile scale', `${metres[0].toFixed(3)} m on all ${metres.length}`)
}

{
  // The jitter has to actually spread, and has to stay inside what it promises.
  // A jitter that quietly collapsed to 1 would leave a cobble bed stamped, which
  // is the whole thing it was added to prevent.
  const N = 400
  let lo = Infinity
  let hi = -Infinity
  for (let s = 1; s <= N; s++) {
    const r = buildRock({ seed: s, size: 2 }).userData.rock.texRepeat / ROCK_DEFAULTS.texRepeat
    if (r < lo) lo = r
    if (r > hi) hi = r
  }
  const j = ROCK_DEFAULTS.texJitter
  check(lo >= 1 - j - 1e-9 && hi <= 1 + j + 1e-9,
    'the per-seed jitter stays inside the +/-50% it promises', `${((lo - 1) * 100).toFixed(0)}% .. +${((hi - 1) * 100).toFixed(0)}%`)
  check(hi - lo > j, 'and it actually spreads across seeds', `${((hi - lo) * 100).toFixed(0)}% of range used over ${N} seeds`)
}

{
  // A texel still has to be a plausible crystal at the size the shapes are
  // AUTHORED at. This is the number that replaced TILE_METRES[ROCK]: it is not a
  // constant of the world any more, so it is only checkable at a stated size.
  const mmPerTexel = ((2 / ROCK_DEFAULTS.texRepeat) * 1000) / TEX_SIZE
  check(mmPerTexel > 2 && mmPerTexel < 20, 'one texel is a plausible crystal on a 2 m rock', `${mmPerTexel.toFixed(1)} mm`)
  check(TILE_METRES[LAYER.ROCK] === undefined,
    'LAYER.ROCK is out of TILE_METRES, which no longer describes rocks')
}

// ---------------------------------------------------------------------------
// 4. The shipped tile, and the palette that is derived from it.
//
// This section used to assert that stone.png was graded PALE and NEUTRAL, on the
// grounds that a tint was a multiply and a multiply can only take a tile down.
// The tile is now a real photograph of granite -- warm, and dark at a mean of
// 85/255 -- and TINTS was inverted to match: a tint names the colour the rock is
// supposed to end up, and the multiplier that gets there is TINT_GAIN, derived
// by dividing out the tile's own linear mean.
//
// So what is worth asserting has moved. Not "the tile is bright" -- it is not,
// and it does not need to be -- but "the derivation still matches the file it
// was derived from", "no entry darkens", and "the brightening does not blow the
// highlights out". Those three are what would actually break if someone dropped
// in a new photograph and forgot the palette existed.
// ---------------------------------------------------------------------------

console.log('\nstone.png')

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

{
  const path = `public/${IMAGE_LAYERS[LAYER.ROCK]}`
  const png = readPng(path)
  check(png.width === TEX_SIZE && png.height === TEX_SIZE,
    `${path} is ${TEX_SIZE}x${TEX_SIZE}`, `${png.width}x${png.height}`)
  // Everything below indexes at 4 bytes per texel, and the array upload path in
  // textures.js does too -- a 3-channel PNG would decode to garbage in both.
  check(png.channels === 4, 'RGBA, 4 channels', `${png.channels} channels`)

  let mean = 0
  let opaque = 0
  const lin = [0, 0, 0]
  const N = png.width * png.height
  for (let i = 0; i < N; i++) {
    if (png.data[i * 4 + 3] === 255) opaque++
    mean += (png.data[i * 4] + png.data[i * 4 + 1] + png.data[i * 4 + 2]) / 3
    for (let c = 0; c < 3; c++) lin[c] += srgbToLinear(png.data[i * 4 + c] / 255)
  }
  mean /= N
  for (let c = 0; c < 3; c++) lin[c] /= N

  // THE ONE NUMBER THE PALETTE IS BUILT ON. Every gain in TINT_GAIN is an
  // authored colour divided by these three, so a new tile dropped in without a
  // matching edit to ROCK_TILE_MEAN silently moves the whole world's stone.
  // 2% is tight enough to catch a swapped file and loose enough to survive
  // somebody rounding the constants to four places, which is what they are.
  const drift = Math.max(...lin.map((v, c) => Math.abs(v - ROCK_TILE_MEAN[c]) / ROCK_TILE_MEAN[c]))
  check(drift < 0.02, 'ROCK_TILE_MEAN still describes the shipped tile',
    `${lin.map((v) => v.toFixed(4)).join(' ')} vs ${ROCK_TILE_MEAN.join(' ')}, ${(drift * 100).toFixed(1)}% off`)

  // NOTHING DARKENS. The whole complaint that produced this rework was that
  // multiplying an already-dark tile down made mud, so the floor is the promise:
  // every channel of every tint is a gain of at least 1.
  const minGain = Math.min(...TINT_GAIN.flat())
  check(minGain >= 1, 'no tint darkens the tile in any channel', `smallest gain ${minGain.toFixed(2)}`)

  // And the ceiling is highlight clipping, which is the real cost of a gain and
  // the reason there is no white marble in the palette. Measured, not guessed:
  // how many of the tile's own texels are pushed past 1.0 in linear by each tint.
  let worst = { name: '', frac: 0 }
  TINT_GAIN.forEach((gain, i) => {
    let clipped = 0
    for (let p = 0; p < N; p++) {
      for (let c = 0; c < 3; c++) {
        if (srgbToLinear(png.data[p * 4 + c] / 255) * gain[c] > 1) { clipped++; break }
      }
    }
    if (clipped / N > worst.frac) worst = { name: TINTS[i][0], frac: clipped / N }
  })
  check(worst.frac < 0.02, 'the brightest tint still holds its highlights',
    `${TINTS.length} tints, worst is ${worst.name} at ${(worst.frac * 100).toFixed(2)}% clipped`)

  // A palette of eight greys is not a palette. Measured as the spread of the
  // authored destinations in hue terms: the largest gap between any tint's
  // red/blue ratio and any other's, which is what separates sandstone from slate.
  const warmth = TINTS.map(([, hex]) => srgbToLinear(((hex >> 16) & 255) / 255) / srgbToLinear((hex & 255) / 255))
  const spread = Math.max(...warmth) / Math.min(...warmth)
  check(spread > 2.5, 'the palette spans warm to cold, not eight greys',
    `warmest / coldest red-to-blue ratio is ${spread.toFixed(1)}x`)

  // A rock is opaque. An alpha channel with holes in it means the cut picked up
  // a transparent border somewhere.
  check(opaque === N, 'fully opaque -- a rock is not a cutout', `${N - opaque} non-opaque texels`)
  check(mean > 40 && mean < 200, 'the tile is a photograph, not a flat fill', `mean ${mean.toFixed(0)}/255`)

  // The wrap seam, on the same metric check-buildings.mjs uses: how the step
  // across the wrap edge compares with the largest step anywhere inside.
  for (const axis of ['u', 'v']) {
    const s = seamScore(png.data, png.width, axis)
    check(s < 1.35, `no visible wrap seam in ${axis}`, `seam ${s.toFixed(2)}x the worst interior step`)
  }
}

// ---------------------------------------------------------------------------
// 4b. The cliff wears the same tile.
//
// A boulder resting against the crag it fell off has to be the same MATERIAL as
// the crag, and until now it was not: the rock was a photograph and the cliff
// behind it was procedural noise. terrain-material.js now samples LAYER.ROCK
// too, so the tile measured above has a second consumer -- and the same rule
// applies to it, for the same reason. It may add grain to the rock surface. It
// may not darken it.
//
// Compiled here rather than in check-terrain.mjs because everything this section
// asserts is about the TILE, and the tile is measured thirty lines up.
// ---------------------------------------------------------------------------

console.log('\nstone on the cliff')

{
  const atlas = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)

  const compile = (mat) => {
    const src = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {},
    }
    mat.onBeforeCompile(src)
    return src
  }

  const plain = createTerrainMaterial()
  const stone = createTerrainMaterial({ atlas })
  const plainSrc = compile(plain)
  const stoneSrc = compile(stone)

  // OPT-IN, and this is the whole safety argument for touching a material three
  // other worlds share: with no atlas the source must not mention the sampler at
  // all, so v1's terrain and the /gen benches compile what they always did.
  check(!plainSrc.fragmentShader.includes('uAtlas') && !plainSrc.uniforms.uStone,
    'without an atlas the terrain compiles no stone layer at all',
    plainSrc.fragmentShader.includes('uAtlas') ? 'sampler leaked in' : 'clean')
  check(plain.customProgramCacheKey() !== stone.customProgramCacheKey(),
    'the two variants cannot share a compiled program',
    `${plain.customProgramCacheKey()} vs ${stone.customProgramCacheKey()}`)

  // ONE TILE, TWO CONSUMERS. The layer index is the whole point of the section:
  // if this ever stops being LAYER.ROCK the boulders and the cliff are two
  // different rocks again and nothing else here would notice.
  const fetches = stoneSrc.fragmentShader.match(/textureGrad\( uAtlas, vec3\([^)]*\), /g) || []
  check(fetches.length === 3, 'the cliff samples the rock tile triplanar, three fetches',
    `${fetches.length} fetches`)
  check(fetches.every((f) => f.includes(`, ${LAYER.ROCK}.0 )`)),
    'and it is LAYER.ROCK -- the same tile the boulders wear',
    `layer ${LAYER.ROCK}`)

  // IMPLICIT LOD WOULD BE UNDEFINED HERE. Both call sites sit inside a guard
  // that folds in distance and the rock/grass classification, so a quad at the
  // foot of a crag has some lanes in and some out. A bare texture() there is
  // undefined per the ES spec and fails as the sharpest mip on a fragment that
  // wanted the blurriest -- sparkling pixels along every grass border.
  check(!/[^d]texture\( uAtlas/.test(stoneSrc.fragmentShader),
    'every stone fetch passes explicit gradients', 'no implicit-LOD texture( uAtlas ) left')

  // THE TWO OCTAVES THE ASK NAMED: 16 m per tile, and a fainter 2 m one up close.
  // Asserted as the reciprocals the shader actually carries, because that is
  // where a units mistake would land.
  const scales = [...stoneSrc.fragmentShader.matchAll(/auroraTri, ([0-9.]+) \)/g)].map((m) => 1 / Number(m[1]))
  check(scales.length === 2 && Math.abs(scales[0] - 16) < 1e-6 && Math.abs(scales[1] - 2) < 1e-6,
    'one square of cliff stone is 16 m, with a 2 m octave under it',
    scales.map((v) => `${v.toFixed(0)} m`).join(' and '))
  check(stoneSrc.uniforms.uStoneFine.value < stoneSrc.uniforms.uStone.value,
    'and the near octave is the fainter of the two',
    `${stoneSrc.uniforms.uStoneFine.value} vs ${stoneSrc.uniforms.uStone.value}`)

  // NEUTRAL BY CONSTRUCTION, which is the same promise section 4 makes for the
  // boulders and the reason the terrain palette above it did not have to be
  // retuned. The shader multiplies the surface by texel / uStoneMean, so this
  // measures what that multiplier averages to over the real tile: 1.0 per
  // channel means the layer adds contrast and takes away no light. The failure
  // this catches is a plausible one -- an sRGB mean, or a luma, in place of the
  // linear per-channel mean would land near 0.7 and quietly darken every cliff
  // in the world by a third.
  const path = `public/${IMAGE_LAYERS[LAYER.ROCK]}`
  const png = readPng(path)
  const N = png.width * png.height
  const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const mean = stoneSrc.uniforms.uStoneMean.value.toArray()
  const gain = [0, 0, 0]
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) gain[c] += srgbToLin(png.data[i * 4 + c] / 255) / mean[c]
  }
  for (let c = 0; c < 3; c++) gain[c] /= N
  const off = Math.max(...gain.map((v) => Math.abs(v - 1)))
  check(off < 0.02, 'the cliff stone layer neither darkens nor tints the terrain',
    `mean multiplier ${gain.map((v) => v.toFixed(3)).join(' ')}`)
}

// ---------------------------------------------------------------------------
// 5. The moss tile is graded for the screen, not for a tint.
//
// The mirror image of section 4, and the two have to be read together or the
// numbers below look like a mistake. stone.png is bright and near-neutral
// because a per-instance tint multiplies it. Moss is NOT tinted: MOSS_APPLY lays
// it over the rock's already-tinted diffuse, so what is graded is what ships. A
// future re-grade that "matches the stone" would be undoing the point.
// ---------------------------------------------------------------------------

console.log('\nmoss.png')

{
  const path = `public/${IMAGE_LAYERS[LAYER.MOSS]}`
  const png = readPng(path)
  check(png.width === TEX_SIZE && png.height === TEX_SIZE,
    `${path} is ${TEX_SIZE}x${TEX_SIZE}`, `${png.width}x${png.height}`)
  check(png.channels === 4, 'RGBA, 4 channels', `${png.channels} channels`)

  let luma = 0
  let sat = 0
  let greener = 0
  let opaque = 0
  const N = png.width * png.height
  for (let i = 0; i < N; i++) {
    const r = png.data[i * 4]
    const g = png.data[i * 4 + 1]
    const b = png.data[i * 4 + 2]
    if (png.data[i * 4 + 3] === 255) opaque++
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b
    const mx = Math.max(r, g, b)
    sat += mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx
    if (g > r && g > b) greener++
  }
  luma /= N
  sat /= N

  // The source photograph means 46/45/21, which is nearly black -- dark enough
  // to read as a stain rather than a plant, and pure black at night, where
  // check-daynight.mjs has gully rock at 16. The upper bound matters just as
  // much: moss is darker than the granite it grows on, and the bench's neutral
  // tint puts that granite around 111 on screen.
  check(luma > 70 && luma < 105, 'graded up out of the source, but still darker than the stone it grows on',
    `luma ${luma.toFixed(0)}/255`)
  // And graded barely desaturated, where the stone was desaturated hard. The
  // green is the payload -- it is the whole reason the layer earns a slot.
  check(sat > 0.3, 'the hue survived the grade -- nothing tints this tile later', `mean saturation ${sat.toFixed(2)}`)
  // Not all of it: the photograph has dead brown clumps in it, and those are
  // half of why it reads as moss rather than as green paint. The bound is on the
  // grade not having pulled the whole tile toward one of them.
  check(greener / N > 0.85, 'green is the dominant channel over most of the tile',
    `${((greener / N) * 100).toFixed(1)}% of texels`)
  // Moss is laid over an opaque rock through a blend, so a hole in the alpha is
  // not discarded by alphaTest the way a cutout's would be -- it would paint a
  // transparent black patch straight into the mix.
  check(opaque === N, 'fully opaque -- this one is blended, not cut out', `${N - opaque} non-opaque texels`)

  for (const axis of ['u', 'v']) {
    const s = seamScore(png.data, png.width, axis)
    check(s < 1.35, `no visible wrap seam in ${axis}`, `seam ${s.toFixed(2)}x the worst interior step`)
  }
}

{
  // The mask, on the same terms as the snow arithmetic in section 6.
  const creep = (down, blob) => blob * (1 - MOSS.down) + down * MOSS.down
  const cut = (amt) => MOSS.cutBias - amt * MOSS.cutSpan

  check(MOSS_LAYERS.includes(LAYER.ROCK), 'rock is what moss grows on so far')
  check(!MOSS_LAYERS.includes(LAYER.IMPOSTOR_ROCK),
    'the rock card is out -- a card is photographed from the mesh, moss and all')
  // MOSS is sampled by the shader, never worn as a texLayer, so it must not be
  // in TILE_METRES either -- it is tiled off whatever UV the host surface has.
  check(TILE_METRES[LAYER.MOSS] === undefined, 'LAYER.MOSS is out of TILE_METRES -- it borrows its host UV')

  // OFF IS OFF and FULL IS FULL, the same two promises the snow cut makes, and
  // for the same reason: a slider whose ends do not mean anything is a slider
  // nobody can trust.
  check(creep(1, 1) < cut(0) - MOSS.edgeMax, 'moss at 0 leaves the rock bare',
    `ceiling ${creep(1, 1).toFixed(2)} vs cut ${(cut(0) - MOSS.edgeMax).toFixed(2)}`)
  check(creep(0, 0) > cut(1) + MOSS.edgeMax, 'moss at 1 reaches every face',
    `floor ${creep(0, 0).toFixed(2)} vs cut ${(cut(1) + MOSS.edgeMax).toFixed(2)}`)

  // AND IT LEANS THE OTHER WAY FROM SNOW. If these ever agree, one of them is
  // wrong: snow settles on the crown, moss creeps up the shaded flanks, and a
  // rock wearing both should show them in different places.
  check(creep(1, 0.5) > creep(0, 0.5), 'moss favours the down-facing half',
    `${creep(1, 0.5).toFixed(2)} under vs ${creep(0, 0.5).toFixed(2)} on top`)

  // Colonies, not speckle: coarser patches than the snow's, and coarse enough to
  // read as a patch of something growing rather than as green noise.
  const patchCm = (1 / MOSS.freq) * 100
  check(patchCm > 12 && patchCm < 40, 'moss grows in colonies, not in flecks', `${patchCm.toFixed(0)} cm patches`)
}

// ---------------------------------------------------------------------------
// 6. Snow on stone arrives in patches, top first, and never draws a line.
//
// The shader is GLSL and there is no GL context here, so what is checked is the
// ARITHMETIC the GLSL is compiled from: material.js exports its snow constants
// for exactly this, and the drift formula below is a transcription of the one in
// SNOW_APPLY. That is a real duplication and worth being honest about -- if the
// shader's weighting changes and this does not, the numbers here go on passing
// while the picture is wrong. What it does catch is the constants drifting, and
// they are the only part anybody will ever be tempted to tune by eye.
//
// The failure this section exists to catch is a specific one, and it has been
// walked into twice: WEIGHTING `up` TOO HEAVILY. `up` is constant across a flat
// cut face, so once it dominates the mask, a facet is entirely snowed or
// entirely bare and the snowline runs along the facet edges as a straight seam.
// Every gate below is a different way of saying the noise has to keep enough
// weight to vary WITHIN a face.
//
// `blob` is noise, so a promise about coverage has to hold for the whole range
// of blob rather than for its average, and a fragment is only settled where it
// clears the cut by a full edge width in one direction or the other.
// ---------------------------------------------------------------------------

console.log('\nsnow on stone')

{
  const w = SNOW_ROCK.up
  const drift = (up, blob) => blob * (1 - w) + up * w
  const cut = (load) => SNOW_ROCK.cutBias - load * SNOW_ROCK.cutSpan
  // `up` as the shader derives it, so the thresholds below read in normal.y.
  const upOf = (ny) => Math.min(1, Math.max(0, ny * 0.5 + 0.5))
  const snowed = (ny, blob, load) => drift(upOf(ny), blob) > cut(load) + SNOW_ROCK.edgeMax
  const bare = (ny, blob, load) => drift(upOf(ny), blob) < cut(load) - SNOW_ROCK.edgeMax
  // What fraction of a face this steep is under snow, given that blob is uniform
  // on 0..1. This is the number the eye actually reads.
  const covered = (ny, load) =>
    Math.min(1, Math.max(0, 1 - (cut(load) - upOf(ny) * w) / (1 - w)))

  check(SNOW_ROCK_LAYERS.includes(LAYER.ROCK), 'LAYER.ROCK wears the stone recipe')
  // Load-bearing: a layer in both lists is counted by both masks and then takes
  // the FOLIAGE weight, which is a wrong picture rather than an error.
  const both = SNOW_ROCK_LAYERS.filter((l) => SNOW_LAYERS.includes(l))
  check(both.length === 0, 'the foliage and stone lists are disjoint', `${both.length} in both`)
  check(!SNOW_LAYERS.includes(LAYER.IMPOSTOR_ROCK) && !SNOW_ROCK_LAYERS.includes(LAYER.IMPOSTOR_ROCK),
    'the rock card is in neither -- its normals are horizontal, so it has no top')

  // OFF IS OFF. At a load of 0 no fragment reaches the cut, whatever it faces
  // and however the noise rolls -- so the slider's zero is bare stone and not a
  // faint rime. drift's ceiling is 1.0 (straight up, noise at 1).
  check(bare(1, 1, 0), 'a load of 0 leaves even a flat top bare',
    `ceiling ${drift(1, 1).toFixed(2)} vs cut ${(cut(0) - SNOW_ROCK.edgeMax).toFixed(2)}`)

  // AND A FULL WINTER REACHES EVERY FACE, including the underside of an
  // overhang, whatever the noise rolls. Stone keeps the same promise foliage
  // does: there is no facet the far end of the slider cannot get to. drift's
  // floor is 0.0 (pointing straight down, noise at 0).
  let missed = null
  for (const ny of [1, 0.5, 0, -0.25, -0.6, -1]) if (!snowed(ny, 0, 1)) missed = ny
  check(missed === null, 'a full load whitens every face, overhangs included',
    missed === null ? `floor ${drift(0, 0).toFixed(2)} vs cut ${(cut(1) + SNOW_ROCK.edgeMax).toFixed(2)}`
      : `normal.y ${missed} stays bare`)

  // TOP FIRST, UNDERSIDE LAST. The lean has to be real or the whole thing reads
  // as bleached rather than as snowed, so coverage must climb strictly with how
  // much of the sky a face can see.
  const ramp = [-1, -0.5, 0, 0.5, 1].map((ny) => covered(ny, 0.5))
  check(ramp.every((c, i) => i === 0 || c > ramp[i - 1]),
    'coverage climbs strictly from underside to top', ramp.map((c) => c.toFixed(2)).join(' < '))

  // THE PATCHY BAND, which is the gate that catches the regression. A flat facet
  // has one `up`, so the only thing varying across it is the noise, and the span
  // of slider travel over which that facet is PART covered is exactly the noise's
  // share of the drift divided by the span. Lean `up` harder and this shrinks:
  // the facet spends the slider snapping from bare to white in one step, which is
  // the straight-seam artefact expressed as a number. A quarter of the travel is
  // the floor for it reading as snow arriving in patches.
  for (const [ny, what] of [[1, 'a flat top'], [0, 'a sheer side'], [-1, 'an underside']]) {
    let partial = 0
    for (let i = 0; i <= 100; i++) {
      const load = i / 100
      if (!snowed(ny, 0, load) && !bare(ny, 1, load)) partial++
    }
    check(partial > 25, `${what} is patchy over a real stretch of the slider`,
      `${partial}% of the travel`)
  }

  // THE RIM WANDERS. The noise's share of the drift, converted back into the
  // normal.y it displaces, is how far the snowline can stray from the contour a
  // pure dot product would have drawn. Below about a third of a hemisphere it
  // stops reading as a drift and starts reading as a slightly fuzzy circle.
  const wander = ((1 - w) / w) * 2
  check(wander > 0.33, 'the noise moves the rim across a real span of normal.y',
    `${wander.toFixed(2)} of the -1..1 range`)

  // AND STONE STILL LEANS HARDER THAN FOLIAGE. The two are one mix() apart and
  // that difference is the entire reason the second layer list exists; if they
  // ever converge, delete the list rather than leaving it as decoration.
  check(w > SNOW_ROCK.foliageUp, 'stone leans on `up` harder than a canopy does',
    `${w} vs ${SNOW_ROCK.foliageUp}`)

  // PATCHES SMALLER THAN A FACE. The noise is sized in WORLD metres and does not
  // scale with the rock (unlike its granite tile -- see rock.js), so this is a
  // fixed patch size in the world: at 12.8 cycles/m a blob is about 8 cm. A 2 m
  // rock cut ten times has facets on the order of half a metre, so what matters
  // is that several patches fit across one. Fewer than a handful and the facet
  // is back to flipping as a unit.
  const patchM = 1 / SNOW_ROCK.freq
  const perFacet = 0.5 / patchM
  check(perFacet > 4, 'several snow patches fit across one cut facet',
    `${(patchM * 100).toFixed(0)} cm patches, ~${perFacet.toFixed(0)} across a facet`)
}

// ---------------------------------------------------------------------------
// 7. The shipping bank is a bank and not a list.
//
// Sections 1-6 test the GENERATOR, which will happily build anything. This one
// tests the sixteen shapes that actually ship: that they still build, that each
// one sits and is the size it claims, and that the four environments each have
// a real choice rather than one variant standing in for a whole hillside.
// ---------------------------------------------------------------------------

console.log('\nthe sixteen')

{
  check(ROCK_NAMES.length === 16, 'sixteen variants ship', ROCK_NAMES.join(' '))

  const counts = Object.fromEntries(ENVIRONMENTS.map((e) => [e, 0]))
  let untagged = 0
  let badTint = 0
  for (const name of ROCK_NAMES) {
    const v = ROCK_VARIANTS[name]
    if (!v.envs.length) untagged++
    if (!(v.tint >= 0 && v.tint < TINTS.length)) badTint++
    for (const e of v.envs) {
      if (counts[e] === undefined) throw new Error(`${name} claims unknown environment ${e}`)
      counts[e]++
    }
  }
  check(untagged === 0, 'every variant belongs somewhere')
  check(badTint === 0, 'every variant points at a real tint')
  check(
    ENVIRONMENTS.every((e) => counts[e] >= 3),
    'no environment is furnished by one or two shapes',
    ENVIRONMENTS.map((e) => `${e} ${counts[e]}`).join('  ')
  )

  // The bank is the thing both /gen-rock and the world read, so a variant that
  // fails to build is a boot failure for the route, not a missing rock.
  const bank = buildRockBank({ seed: 7, seeds: 3 })
  check(bank.shapes.length === 16 * 3, 'three shapes per variant', `${bank.shapes.length} rocks`)
  check(
    bank.shapes.every((s) => s.tiers.length === ROCK_BAND_COUNT),
    'every shape has a rectangular tier table'
  )
  // A pebble's ladder is one entry; padding it by REFERENCE is what keeps the
  // arena from holding three copies of the same eight triangles.
  const pebble = bank.shapes.find((s) => s.name === 'pebble')
  check(new Set(pebble.tiers).size === 1, 'a pebble pads its ladder by reference, not by rebuilding')
  const unique = new Set(bank.shapes.flatMap((s) => s.tiers)).size
  check(unique === bank.geometries.length, 'geometries and tier references agree', `${unique} in the arena`)

  // Size classes have to stay separated or the beds below overlap: an underfoot
  // rock that is secretly 2 m across would be scattered at pebble density.
  const span = (n) => bank.shapes.find((s) => s.name === n).measured
  check(span('pebble').height < 0.1, 'a pebble is pebble-sized', `${span('pebble').height.toFixed(2)} m tall`)
  check(span('boulder').height > 0.6 && span('boulder').height < 1.5, 'a boulder is about waist to chest', `${span('boulder').height.toFixed(2)} m`)
  check(span('blockhouse').width > 4, 'a blockhouse is house-sized', `${span('blockhouse').width.toFixed(1)} m across`)
  check(span('fang').height > 8, 'a fang is a landmark', `${span('fang').height.toFixed(1)} m tall`)

  // The spire the user sent back: tapered hard, toothy at the top, sturdy at the
  // bottom. Measured as the silhouette radius in the top and bottom tenth of the
  // height, normalised to the widest -- which is exactly what "too rounded" and
  // "too pointy at the base" mean when you put a number on them.
  {
    const g = buildRock({ ...rockParams('spire', 31), tier: 0 })
    const pos = g.attributes.position.array
    let ymin = Infinity
    let ymax = -Infinity
    for (let i = 1; i < pos.length; i += 3) {
      if (pos[i] < ymin) ymin = pos[i]
      if (pos[i] > ymax) ymax = pos[i]
    }
    const bins = new Float64Array(10)
    for (let i = 0; i < pos.length; i += 3) {
      const b = Math.min(9, Math.floor(((pos[i + 1] - ymin) / (ymax - ymin)) * 10))
      const r = Math.hypot(pos[i], pos[i + 2])
      if (r > bins[b]) bins[b] = r
    }
    const w = Math.max(...bins)
    check(bins[9] / w < 0.45, 'the spire comes to a tooth, not a dome', `top tenth is ${(bins[9] / w).toFixed(2)} of the widest`)
    check(bins[0] / w > 0.9, 'the spire stands on a foot, not on a point', `bottom tenth is ${(bins[0] / w).toFixed(2)}`)
    // Monotone, near enough: a mid-height bulge is what the old isotropic taper
    // produced, and it is what made the thing read as a rounded lump.
    let rises = 0
    for (let i = 1; i < 10; i++) if (bins[i] > bins[i - 1] + 0.02 * w) rises++
    check(rises <= 1, 'the spire narrows all the way up', `${rises} widening steps`)
    g.dispose()
  }

  for (const g of bank.geometries) g.dispose()
}

// ---------------------------------------------------------------------------
// 8. The world scatter: three beds, one material, and stone where stone belongs.
//
// The scatter's own machinery -- tiles, ranks, graded thinning, the build budget
// -- is render/trees.js's and is gated by check-v2.mjs there. What is new here
// and what this section holds is the part that is ROCK: that a size class is
// scattered at its own density over its own radius, that the environment gate
// actually gates, that a rock is bedded rather than balanced, and that the pool
// bound survives the densest ground in the world.
// ---------------------------------------------------------------------------

console.log('\nscatter')

{
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
    },
    water: {
      levelAt: () => level,
      isSubmerged: (x, z, groundY) => level !== null && level > groundY,
    },
  })

  const texArray = buildTextureArray()
  const forest = world(60, 0, 9999, null)
  const cliff = world(60, 0.8, 9999, null) // 38.7 deg: past CLIFF_SLOPE_DEG, inside every bed's limit
  const peak = world(900, 0.5, 880, null)
  const river = world(60, 0, 9999, 60.8)

  const build = (w) => {
    const r = new Rocks(new THREE.Scene(), w.field, w.water, texArray, { seed: 7, seeds: 2 })
    r.place(0, 0)
    return r
  }

  const forestRocks = build(forest)
  const byBed = Object.fromEntries(forestRocks.stats.beds.map((b) => [b.name, b]))
  check(forestRocks.beds.length === 3, 'three size beds')
  check(
    new Set(forestRocks.beds.map((b) => b.batch.material)).size === 1,
    'one material across all three batches',
    'nothing here billboards, so one program serves them'
  )
  // DENSITY, not totals: the giants bed reaches 1250 m and the underfoot bed 55,
  // so counting the whole disc would say there are more house-sized rocks in the
  // world than pebbles, which is true and completely beside the point. Count what
  // stands within 40 m of the camera, which is what the ground looks like.
  const within = (rocks, bedName, r) => {
    const bed = rocks.beds.find((b) => b.cfg.name === bedName)
    let n = 0
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        if (bed.instX[id] ** 2 + bed.instZ[id] ** 2 < r * r) n++
      }
    }
    return n
  }
  const near = ['underfoot', 'boulders', 'giants'].map((b) => within(forestRocks, b, 40))
  check(near[0] > near[1] * 4, 'pebbles outnumber boulders underfoot', `${near[0]} vs ${near[1]} inside 40 m`)
  check(near[1] > near[2], 'and boulders outnumber giants', `${near[1]} vs ${near[2]}`)
  check(near[1] > 0 && byBed.giants.placed > 0, 'the wood still gets boulders AND the odd giant',
    `${byBed.boulders.placed} boulders, ${byBed.giants.placed} giants across the whole disc`)
  // A house-sized block every forty metres is a boulder field, not a wood. The
  // forest multiplier in BEDS is what holds this, and it is easy to lose. The
  // bound sits at one per 4,000 m2 of the disc -- about one every 65 m, which is
  // rare enough that you still stop and look at one.
  check(within(forestRocks, 'giants', 200) < 32, 'a giant in a wood is a landmark',
    `${within(forestRocks, 'giants', 200)} inside 200 m, one every ` +
    `${Math.round(Math.sqrt((Math.PI * 200 * 200) / Math.max(1, within(forestRocks, 'giants', 200))))} m`)
  const cliffTest = build(cliff)
  check(within(cliffTest, 'giants', 200) > within(forestRocks, 'giants', 200) * 3,
    'the cliff is littered where the wood is not',
    `${within(cliffTest, 'giants', 200)} vs ${within(forestRocks, 'giants', 200)} inside 200 m`)
  cliffTest.dispose()

  // Every bed can furnish every environment. Without this a whole size class
  // silently vanishes on one kind of ground -- the failure mode where a cliff
  // has pebbles and spires on it and nothing in between.
  let holes = 0
  for (const bed of forestRocks.beds) {
    for (const env of ENVIRONMENTS) if (!bed.byEnv.get(env).length) holes++
  }
  check(holes === 0, 'every bed has shapes for every environment')

  // The gate, tested where it matters: the four grounds get four different sets
  // of shapes, and the ones that must not appear do not.
  const named = (rocks, bedName) => {
    const bed = rocks.beds.find((b) => b.cfg.name === bedName)
    const out = new Set()
    for (const t of bed.tiles.values()) for (let k = 0; k < t.n; k++) out.add(bed.shapes[bed.shapeAt[t.ids[k]]].name)
    return out
  }
  const cliffRocks = build(cliff)
  const peakRocks = build(peak)
  const riverRocks = build(river)

  const cliffGiants = named(cliffRocks, 'giants')
  check(cliffGiants.size > 0, 'the cliff is littered with giants', [...cliffGiants].join(' '))
  check(!cliffGiants.has('fang'), 'a summit fang does not grow out of a cliff face')

  const peakGiants = named(peakRocks, 'giants')
  check(peakGiants.has('spire') || peakGiants.has('fang'), 'the peak gets spires', [...peakGiants].join(' '))
  check(!peakGiants.has('blockhouse'), 'no forest blockhouse above the treeline')

  const riverBoulders = named(riverRocks, 'boulders')
  check(riverBoulders.size > 0, 'the riverbed is not bare', [...riverBoulders].join(' '))
  check(![...riverBoulders].some((n) => ['mosshump', 'erratic', 'cleft'].includes(n)),
    'no forest-only shape standing in the water')
  check(riverRocks.stats.beds.find((b) => b.name === 'giants').placed === 0,
    'no ten-metre buttress in the middle of a lake')
  check(riverRocks.stats.beds.find((b) => b.name === 'underfoot').placed > 0,
    'pebbles are allowed to be underwater')

  // Bedded, not balanced -- and deeper on a slope, which is what makes a cliff
  // rock read as protruding from the face.
  {
    const flatBed = forestRocks.beds[1]
    const steepBed = cliffRocks.beds[1]
    const mean = (bed) => {
      let s = 0
      let n = 0
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          s += bed.instSink[id] / (bed.shapes[bed.shapeAt[id]].measured.height || 1)
          n++
        }
      }
      return s / n
    }
    const flatSink = mean(flatBed)
    const steepSink = mean(steepBed)
    check(flatSink > 0.02, 'a rock on the flat is bedded into the ground', `${(flatSink * 100).toFixed(0)}% of its height`)
    check(steepSink > flatSink * 1.5, 'a rock on a cliff is bedded deeper', `${(steepSink * 100).toFixed(0)}% vs ${(flatSink * 100).toFixed(0)}%`)
    check(
      flatBed.instY[flatBed.tiles.values().next().value.ids[0]] < 60,
      'the instance sits below the ground line, not on it'
    )
  }

  // The pool bound is the only thing between the densest ground in the world and
  // a thrown scatter, and it throws rather than degrading. Walk the camera so
  // tiles are grown at every quantised level, on the ground that places the MOST
  // rocks: an endless cliff, where all three beds run at envDensity 1.0.
  {
    const r = build(cliff)
    for (let i = 1; i <= 12; i++) r.update(i * 37, 61.6, i * 91)
    const s = r.stats
    check(
      s.beds.every((b) => b.used <= b.pool),
      'the pool bound holds after a traverse',
      s.beds.map((b) => `${b.name} ${b.used}/${b.pool}`).join('  ')
    )
    check(s.beds.every((b) => b.used / b.pool < 0.95), 'and holds with headroom')
    console.log(`       ${s.placed} rocks, ${s.tris} tris drawn, bank ${s.bankTris} tris / ${s.bankKB} KB, build ${s.buildMs.toFixed(0)} ms`)
    r.dispose()
  }

  // Determinism. The scatter is a pure function of position, so two worlds built
  // from one seed must be the same world -- including which SHAPE each rock is,
  // which is decided after the environment test and is the easiest thing here to
  // accidentally make order-dependent.
  {
    const a = build(forest)
    const b = build(forest)
    let drift = 0
    for (let i = 0; i < a.beds.length; i++) {
      const ba = a.beds[i]
      const bb = b.beds[i]
      if (ba.placed !== bb.placed) drift++
      for (let k = 0; k < ba.maxInstances; k++) {
        if (ba.shapeAt[k] !== bb.shapeAt[k] || ba.instX[k] !== bb.instX[k] || ba.instY[k] !== bb.instY[k]) drift++
      }
    }
    check(drift === 0, 'one seed, one world')
    a.dispose()
    b.dispose()
  }

  // Snow and moss come off the terrain's own band and run in opposite
  // directions: white above, green below, with clear air between the two lines
  // so no rock is both at once.
  {
    const layers = { snow: { base: 780, band: 90 } }
    forestRocks.syncBands(layers)
    const snow = getSnowLine()
    const moss = getMossLine()
    check(snow.base === 780 && snow.band === 90, 'props take the terrain snow line verbatim')
    check(moss.base < snow.base - snow.band, 'moss has given out well before the snow starts',
      `moss ${moss.base} m, snow ${snow.base} m`)
    check(moss.band > layers.snow.band, 'the moss line is a gradient, not a contour', `${moss.band} m band`)
  }

  // --- the per-instance tint ------------------------------------------------
  //
  // The promise is that a wood is not one colour. Read the colours the scatter
  // actually wrote rather than trusting the roll: quantise each instance's
  // linear RGB coarsely and count how many distinct buckets a single bed puts
  // down, and separately check that nothing was written below the bare tile.
  {
    const bed = forestRocks.beds.find((b) => b.cfg.name === 'boulders')
    const c = new THREE.Color()
    const buckets = new Set()
    let n = 0
    let dimmest = Infinity
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        bed.batch.getColorAt(t.ids[k], c)
        buckets.add(`${Math.round(c.r * 6)},${Math.round(c.g * 6)},${Math.round(c.b * 6)}`)
        dimmest = Math.min(dimmest, c.r, c.g, c.b)
        n++
      }
    }
    check(buckets.size >= 8, 'a wood of boulders is not one colour',
      `${buckets.size} distinct tints across ${n} instances`)
    // The whole point of the rework: a per-instance colour is a GAIN. The jitter
    // floor is 0.86 and the palette's smallest gain is 1.39, so the dimmest thing
    // the scatter may legally write is about 1.15 -- comfortably over 1, which
    // means no rock in the world comes out darker than the tile it is made of.
    check(dimmest > 1, 'no instance darkens the tile', `dimmest channel written is ${dimmest.toFixed(2)}`)
    // ENV_TINTS is what makes that true per environment, so it has to name all
    // four and index nothing that does not exist.
    for (const env of ENVIRONMENTS) {
      const pal = ENV_TINTS[env]
      check(Array.isArray(pal) && pal.length >= 4 && pal.every((i) => i >= 0 && i < TINTS.length),
        `${env} cycles a real palette`, `${pal.length} entries`)
    }
  }

  // --- the per-instance moss ------------------------------------------------
  //
  // setMossVary defaults OFF, and that default is load bearing rather than
  // incidental: /gen-rock shows exactly one rock, at the origin, and if the
  // variation were always on that one rock would wear whatever the hash of (0,0)
  // happened to be and the bench's moss slider would stop meaning what it says.
  {
    check(getMossVary() === 0, 'moss variation is off until something turns it on',
      `default ${getMossVary()}`)
    setMossVary(0.5)
    check(getMossVary() === 0.5, 'and it is a real knob', `${getMossVary()}`)
    setMossVary(4)
    check(getMossVary() === 1, 'clamped to a fraction like every other ceiling here', `${getMossVary()}`)
    setMossVary(0)
  }

  for (const r of [forestRocks, cliffRocks, peakRocks, riverRocks]) r.dispose()
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all rock checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

// --- helpers ----------------------------------------------------------------

// Lifted from check-buildings.mjs, and the reasoning there is worth repeating:
// the absolute step across the wrap edge says nothing on its own, because a
// tile full of hard edges has large steps everywhere. What matters is whether
// the wrap edge is WORSE than the edges the tile already contains.
function seamScore(px, n, axis) {
  const at = (x, y, c) => px[((y % n) * n + (x % n)) * 4 + c]
  const step = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        step[k] += axis === 'u'
          ? Math.abs(at(k, i, c) - at(k + 1, i, c))
          : Math.abs(at(i, k, c) - at(i, k + 1, c))
      }
    }
  }
  let max = 0
  for (let k = 0; k < n - 1; k++) max = Math.max(max, step[k])
  return step[n - 1] / Math.max(1e-6, max)
}
