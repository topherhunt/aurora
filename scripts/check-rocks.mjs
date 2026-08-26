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

import { readFileSync } from 'node:fs'

import * as THREE from 'three'

import { buildRock, rockClass, ROCK_TIERS, ROCK_LADDERS, ROCK_DEFAULTS, BOX_MARGIN } from '../src/props/rock.js'
import {
  buildRockBank, rockParams, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, ROCK_NAMES, ROCK_VARIANTS,
  SITES, TINTS, TINT_GAIN,
} from '../src/props/rock-bank.js'
import { Rocks } from '../src/v2/render/rocks.js'
import {
  LAYER, TILE_METRES, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, SNOW_ROCK_LAYERS, SNOW_WOOD_LAYERS, MOSS_LAYERS,
  ROCK_TILE_MEAN, buildTextureArray,
} from '../src/textures.js'
import {
  SNOW_ROCK, MOSS, mossCutFor, createPropMaterial, getSnowLine, getMossLine,
  setMossVary, getMossVary, setSnowVary, getSnowVary,
} from '../src/material.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { readPng } from '../tools/props/png.mjs'

const SEEDS = Number(process.argv[2] ?? 200)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// CLUMP_GAIN is module-private in rocks.js and section 8 needs its VALUE, not
// its effect: the promise there is that the clump multiplier still has room to
// spend under the accept-rate cap, which is arithmetic on the constant itself.
// Lifted out of the source rather than copied into this file, so that a re-tune
// moves the check with it and a rename fails here loudly instead of leaving the
// gate quietly asserting 2.2 against a constant that no longer exists.
const constantFrom = (file, name) => {
  const m = readFileSync(file, 'utf8').match(new RegExp(`^const ${name} = (-?[0-9.]+)$`, 'm'))
  if (!m) throw new Error(`${file} no longer declares ${name} on a line of its own`)
  return Number(m[1])
}
const CLUMP_GAIN = constantFrom('src/v2/render/rocks.js', 'CLUMP_GAIN')

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
  // An open shell, which is the one preset here whose triangle count is NOT the
  // tier's face count: `sit` past a half puts most of the solid under the bed
  // plane and `openBottom` then throws away every face that landed flat on it.
  // It is in this list rather than tested on its own because everything else
  // section 1 asserts -- the layout, the identity index, the unit normals, the
  // bed plane at y = 0 -- has to survive the compaction that does the throwing.
  { name: 'open cap', over: { size: 0.8, squash: 0.5, cuts: 3, cutDepth: 0.5, cutBias: -0.3, sit: 0.52, openBottom: 1 } },
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
  attrs: 0, unindexed: 0, nonIdentity: 0, nan: 0, triCount: 0, closedDropped: 0,
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

      // THE TRIANGLE COUNT IS THE TIER'S, LESS WHATEVER THE OPEN BOTTOM TOOK.
      // For a closed rock the count is exact and `dropped` is 0, which is the
      // promise the arena sizing in rock-bank.js and every triangle budget in
      // the scatter is written against. For an `openBottom` rock the shortfall
      // is real and it has to be EXACTLY what the geometry reports it to be:
      // `dropped` is the only account anybody downstream has of where those
      // faces went, so a count that drifts from it is worse than a wrong count.
      const stats = geo.userData.rock
      const shards = Math.max(1, Math.round(shape.over.shards ?? ROCK_DEFAULTS.shards))
      const full = ROCK_TIERS[t].faces * shards
      if (stats.triangles !== full - stats.dropped) bad.triCount++
      if (!stats.openBottom && stats.dropped !== 0) bad.closedDropped++
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
check(bad.triCount === 0, 'triangles = tier faces x shards, less exactly the faces `dropped` reports', `${bad.triCount} off`)
check(bad.closedDropped === 0, 'and a closed rock drops none of them at all', `${bad.closedDropped} closed builds short`)
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

  check(MOSS_LAYERS.includes(LAYER.ROCK), 'stone is on the list of things moss grows on',
    `MOSS_LAYERS = ${MOSS_LAYERS.join(' ')}`)
  check(!MOSS_LAYERS.includes(LAYER.IMPOSTOR_ROCK),
    'the rock card is out -- a card is photographed from the mesh, moss and all')
  // MOSS is sampled by the shader, never worn as a texLayer, so it must not be
  // in TILE_METRES either -- it is tiled off whatever UV the host surface has.
  check(TILE_METRES[LAYER.MOSS] === undefined, 'LAYER.MOSS is out of TILE_METRES -- it borrows its host UV')

  // WHAT THE FIELD ACTUALLY DOES ON A BOULDER, measured rather than reasoned
  // about, because every promise below is a statement about the DISTRIBUTION of
  // `creep` and there is no closed form for it. See mossCreepOnBoulder: it ports
  // blobField out of material.js, which is a real duplication and the same one
  // section 6 owns up to -- if the GLSL field changes and the port does not,
  // these numbers go on passing while the picture is wrong. What it does catch
  // is every constant AROUND the field drifting away from the field, which is
  // exactly the failure this section shipped once already.
  const field = mossCreepOnBoulder()
  const smoothstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }

  // OFF IS OFF and FULL IS FULL, the same two promises the snow cut makes, and
  // for the same reason: a slider whose ends do not mean anything is a slider
  // nobody can trust.
  //
  // Held against the far side of the BLEND rather than against the cut itself,
  // because what has to clear creep's range is where the ramp starts and ends,
  // and the ramp is deliberately lopsided: MOSS_BLEND below the cut and only
  // MOSS_BLEND * MOSS_BLEND_SKEW above it, so that a patch fades in over a wide
  // soft edge and fills in over a short one. That fixed half-width is also why
  // MOSS_CUT_WIDTH has to be as generous as it is -- unlike snow's fwidth() edge
  // it is a real slice of the mask's range, and it is spent at both ends.
  //
  // Both bounds come off the measured field rather than from creep(1, 1) and
  // creep(0, 0), which is the change that matters here. The old check compared
  // the cut against the ARITHMETIC extremes of the mask, so it went on passing
  // when the noise underneath was rebuilt wider; the ends are only safe if the
  // ends of the SAMPLES clear them.
  const rampStart = mossCutFor(0) - MOSS.blend
  const rampEnd = mossCutFor(1) + MOSS.blend * MOSS.blendSkew
  check(rampStart > field.max, 'moss at 0 leaves the rock bare',
    `ramp starts at ${rampStart.toFixed(2)}, creep tops out at ${field.max.toFixed(2)}`)
  check(rampEnd < field.min, 'moss at 1 reaches every face',
    `ramp ends at ${rampEnd.toFixed(2)}, creep bottoms out at ${field.min.toFixed(2)}`)

  // AND THE LOAD IN BETWEEN MEANS SOMETHING, which is the promise the logit
  // exists to create and the reason MOSS_CUT_MID and MOSS_CUT_WIDTH are a FIT
  // rather than a choice. `creep` is very nearly logistic, so subtracting
  // width * log( v / (1 - v) ) from the midpoint puts the cut where the field's
  // complementary CDF equals v -- and a moss load of 0.3 paints three tenths of
  // the rock instead of some unknowable fraction of it. Every caller reads it
  // that way: Rocks.syncBands drives uMossVary as coverage, and the /gen bench
  // slider is labelled as coverage.
  //
  // Measured through the MASK and not through the cut, which is a distinction
  // the constants themselves depend on: `cover` is the smoothstep, so what a
  // fragment contributes is a weight between 0 and 1 rather than a yes, and the
  // ramp's own midpoint sits MOSS_BLEND * (1 - MOSS_BLEND_SKEW) / 2 BELOW the
  // cut because the ramp is lopsided. Averaging the weight is the only figure
  // that is actually the painted fraction -- counting samples past the cut says
  // a load of 0.3 paints 0.23, and the rock on screen says otherwise.
  //
  // The tolerance is deliberately loose. The point is that coverage TRACKS the
  // load, monotonically and roughly identically, not that it hits three
  // decimals; a tight bound would fail every time somebody legitimately retuned
  // the noise. A refit is a two-constant edit, and this check is what tells them
  // it is needed -- when the field was last rebuilt, the stale width put 0.85 on
  // screen as 0.73 and nothing said a word.
  const LOADS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.85]
  const covers = LOADS.map((v) => {
    const cut = mossCutFor(v)
    let sum = 0
    for (const c of field.creeps) sum += smoothstep(cut - MOSS.blend, cut + MOSS.blend * MOSS.blendSkew, c)
    return sum / field.creeps.length
  })
  const worst = Math.max(...covers.map((c, i) => Math.abs(c - LOADS[i])))
  check(worst < 0.04, 'and a moss load of v paints v of the rock, which is what the logit is for',
    `${LOADS.map((v, i) => `${v}->${covers[i].toFixed(3)}`).join(' ')}, worst off by ${worst.toFixed(3)}`)

  // AND THAT FIGURE IS THE WHOLE STORY FOR A ROCK, which is what makes the
  // sample above a boulder rather than a trunk. MOSS_RISE scales the load by how
  // far up its own instance the fragment sits -- moss lives on damp, and damp is
  // the foot of a trunk and not four metres up a snag -- so the coverages above
  // are only what a boulder wears if a boulder is inside the band from bottom to
  // top. A 2 m one is, with a few percent to spare.
  const rise = (y) => 1 - smoothstep(MOSS.rise, MOSS.rise + MOSS.riseBand, y)
  check(rise(2) > 0.85 && rise(6) < 0.01,
    'and a boulder keeps essentially all of that load over its own height, where a snag would not',
    `${rise(2).toFixed(2)} at 2 m, ${rise(6).toFixed(2)} at 6 m`)

  // AND IT LEANS THE OTHER WAY FROM SNOW. If these ever agree, one of them is
  // wrong: snow settles on the crown, moss creeps up the shaded flanks, and a
  // rock wearing both should show them in different places.
  check(creep(1, 0.5) > creep(0, 0.5), 'moss favours the down-facing half',
    `${creep(1, 0.5).toFixed(2)} under vs ${creep(0, 0.5).toFixed(2)} on top`)

  // FINER THAN SNOW, WHICH IS THE OPPOSITE OF WHAT THIS CHECK USED TO SAY. The
  // old promise was "colonies, not flecks" -- patches 12 to 40 cm, coarser than
  // snow's -- on the reasoning that a colony of moss is a bigger thing than a
  // drift of crystals. What that misses is that the two fields are not doing the
  // same job, and the note above MOSS_FREQ in material.js is the argument:
  // snow's blobs ARE the snow, while moss's blobs are only the shape of the
  // stain and the photograph inside them is what reads as moss. So the blob
  // field competes with the tile for the same band of detail, and at 6.0 it won
  // -- a handful of lobes on a boulder with the grain buried inside them, which
  // is a paint job.
  //
  // The bound that replaces it is the one the new arithmetic actually depends
  // on. The blend is a FIXED width against a mask spanning 0..1 -- MOSS_BLEND
  // below the cut and MOSS_BLEND * MOSS_BLEND_SKEW above it -- so getting on for
  // a fifth of the field's range is transition; a patch only reads as growth
  // thinning out rather than as a blurred blob if the patch is small relative to
  // the rock carrying it. Dozens across a 2 m boulder is what that costs, and it
  // has to stay under snow's or the two fields read as one.
  const patchCm = (1 / MOSS.freq) * 100
  const snowCm = (1 / SNOW_ROCK.freq) * 100
  const across = 2 * MOSS.freq
  const rampWidth = MOSS.blend * (1 + MOSS.blendSkew)
  check(patchCm < snowCm && patchCm > 2 && across > 24 && rampWidth < 0.25,
    'moss patches are finer than snow and small enough for a soft rim to read as growth',
    `${patchCm.toFixed(1)} cm vs snow's ${snowCm.toFixed(1)}, ~${across.toFixed(0)} across a 2 m boulder, ramp ${rampWidth.toFixed(2)} wide`)

  // The fade has to have come with them. Procedural noise has no mip chain, so
  // the range at which it must be blended to its mean is the range at which one
  // patch stops covering a pixel -- which scales with the PATCH and with nothing
  // else. A re-tune of MOSS_FREQ that leaves the fade where it was hands back
  // exactly the crawl the fade exists to prevent, so the two are held together
  // here, and the bound is two-sided so it catches the drift in either
  // direction: the far end has to stay a few hundred patch widths out, and the
  // near end has to be nearer than it.
  const patchesToFade = MOSS.fadeFar * MOSS.freq
  check(MOSS.fadeNear < MOSS.fadeFar && patchesToFade > 400 && patchesToFade < 1200,
    "moss's fade is set in patch widths, so it moved when the patches did",
    `${MOSS.fadeNear}-${MOSS.fadeFar} m, ~${patchesToFade.toFixed(0)} patches out`)
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
// clears the cut by a full edge width in one direction or the other. That range
// is still 0..1 now that the mask is shaped by blobField rather than by a bare
// snowNoise: a domain warp does not change a field's range, and the contrast
// stretch under it is symmetric about 0.5 and clamped. Everything
// below is written against 0..1 and would go quietly wrong if that stopped
// holding, so it is worth saying out loud rather than re-deriving.
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

  // AND THE PATCHES ARE NOT SQUARES. A single octave of value noise on a cubic
  // lattice thresholds into a grid of rounded cubes -- the eye finds the lattice
  // long before it finds the noise -- and the domain warp is the whole of what
  // breaks it. The warp is quoted in LATTICE CELLS, which is why one number
  // serves both the snow at 12.8 and the moss at 24.0.
  //
  // A FULL CELL IS THE FLOOR, and it used to be a third of one. The field under
  // this cut was two octaves and the fine one supplied the ragged rim; it is one
  // octave now, the long drag is what supplies the rim instead, and a bend
  // smaller than the cell it is bending leaves the rows perfectly visible. There
  // is no matching ceiling worth asserting: the warp is sampled at 0.46 of the
  // blob frequency, so dragging further makes rims wander further and does not
  // fold anything, and the real ceiling is the coarse field's own wavelength.
  check(SNOW_ROCK.blobWarp > 1,
    'the domain warp drags the sample well past one cell, so the lattice rows are gone',
    `${SNOW_ROCK.blobWarp} cells, ${(SNOW_ROCK.blobWarp * patchM * 100).toFixed(1)} cm at the snow's size`)

  // AND THE STRETCH STOPS SHORT OF SHOULDERS. Value noise spends most of its
  // range near its mean, so the contrast stretch about 0.5 is what turns a smear
  // into a patch with an interior. It is also the one knob here that can destroy
  // the cut: every sample it pushes outside 0..1 is clamped, and clamped area is
  // area the cut can no longer feather through. Under about 1.2 the patches go
  // back to being gradients; past about 1.8 they acquire hard shoulders and the
  // soft rim the moss blend is paying for has nothing to sit on.
  check(SNOW_ROCK.blobContrast > 1.2 && SNOW_ROCK.blobContrast < 1.8,
    'and the contrast stretch shapes the patches without flattening them against the clamp',
    `${SNOW_ROCK.blobContrast}x about the midpoint`)
}

// ---------------------------------------------------------------------------
// 7. The shipping bank is a bank and not a list.
//
// Sections 1-6 test the GENERATOR, which will happily build anything. This one
// tests the twenty-five shapes that actually ship: that they still build, that
// each one sits and is the size it claims, that the four environments each have
// a real choice rather than one variant standing in for a whole hillside, and
// that the bank is not a bag of spikes.
//
// THAT LAST ONE IS WHY THE TABLE WAS REBUILT. It used to hold sixteen variants
// and the `peak` tag had been handed to three tapered towers -- buttress, spire
// and a 10.7 m `fang` -- plus a chip of scree, so above the treeline the whole
// world was teeth. The fang is gone, the towers were blunted, and the count went
// to twenty-five; the checks below are what stop it drifting back.
// ---------------------------------------------------------------------------

console.log('\nthe twenty-five')

{
  check(ROCK_NAMES.length === 25, 'twenty-five variants ship', ROCK_NAMES.join(' '))

  // The census counts UNTAGGED variants only. A variant carrying a `site` is
  // held out of the ordinary pool entirely (variantsFor), so counting talus
  // toward what a cliff has to offer would say the cliff is furnished by shapes
  // that only ever appear at the foot of one.
  const counts = Object.fromEntries(ENVIRONMENTS.map((e) => [e, 0]))
  const sited = Object.fromEntries(SITES.map((s) => [s, 0]))
  let untagged = 0
  let badTint = 0
  for (const name of ROCK_NAMES) {
    const v = ROCK_VARIANTS[name]
    if (!v.envs.length) untagged++
    if (!(v.tint >= 0 && v.tint < TINTS.length)) badTint++
    if (v.site !== undefined) sited[v.site]++
    for (const e of v.envs) {
      if (counts[e] === undefined) throw new Error(`${name} claims unknown environment ${e}`)
      if (v.site === undefined) counts[e]++
    }
  }
  check(untagged === 0, 'every variant belongs somewhere')
  check(badTint === 0, 'every variant points at a real tint')
  check(
    ENVIRONMENTS.every((e) => counts[e] >= 3),
    'no environment is furnished by one or two untagged shapes',
    ENVIRONMENTS.map((e) => `${e} ${counts[e]}`).join('  ')
  )
  // A site nobody claims is a relief probe paid for and never used, and the
  // scatter would throw the moment something asked for it -- variantsFor has no
  // empty answer, only an exception.
  check(SITES.every((s) => sited[s] > 0), 'every site in SITES is claimed by at least one variant',
    SITES.map((s) => `${s} ${sited[s]}`).join('  '))

  // NOT A BAG OF SPIKES, which is the defect the whole rebuild exists to fix.
  // Pointiness is `taper` -- how much of its own width a shape has lost by the
  // time it reaches its crown -- and the bank's own note draws the pinnacle line
  // at 0.65 with a taperPow past 1.5. The bound is on the FRACTION rather than
  // on a count, so it keeps meaning the same thing as the table grows: past
  // about one in eight, a hillside reads as a stage set rather than as rock.
  const pointy = ROCK_NAMES.filter((n) => (ROCK_VARIANTS[n].taper ?? 0) > 0.5)
  check(pointy.length / ROCK_NAMES.length < 0.125,
    'at most one variant in eight comes to a point',
    `${pointy.length} of ${ROCK_NAMES.length}: ${pointy.join(' ') || 'none'}`)

  // The bank is the thing both /gen-rock and the world read, so a variant that
  // fails to build is a boot failure for the route, not a missing rock.
  const bank = buildRockBank({ seed: 7, seeds: 3 })
  check(bank.shapes.length === 25 * 3, 'three shapes per variant', `${bank.shapes.length} rocks`)
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
  check(span('buttress').height > 6, 'a buttress is a landmark', `${span('buttress').height.toFixed(1)} m tall`)

  // FLAT IS THE POINT OF AN OPEN BOTTOM. A variant only sets `openBottom` when
  // it is meant to lie on the ground like a slab or sit on it like a cap, and
  // the faces the compaction throws away are the ones that landed flat on the
  // bed plane -- which only happens if the shape is mostly bed. Set it on a
  // boulder and you get a hollow shell you can walk into and see the sky
  // through, so the promise here is that nobody has done that: every open
  // variant is measurably a flat thing, well under half as tall as it is wide.
  const open = ROCK_NAMES.filter((n) => ROCK_VARIANTS[n].openBottom === 1)
  const flat = open.map((n) => span(n).height / span(n).width)
  check(open.length >= 4 && Math.max(...flat) < 0.35,
    'the open-bottomed variants are the flat ones',
    open.map((n, i) => `${n} ${flat[i].toFixed(2)}`).join('  '))

  // And it saves real triangles, which is the other half of why it exists. Each
  // open variant is measured at the FINEST tier it ships, because that is where
  // the faces are: a T8 shell has so few faces left that hardly any of them can
  // land flat, and holding the coarse end to a fraction would be asking the
  // compaction for something the tier cannot give.
  const drops = open.map((n) => {
    const p = rockParams(n, 31)
    const g = buildRock({ ...p, tier: ROCK_LADDERS[rockClass(ROCK_VARIANTS[n].size)][0] })
    const u = g.userData.rock
    g.dispose()
    return u.dropped / (u.triangles + u.dropped)
  })
  const meanDrop = drops.reduce((a, b) => a + b, 0) / drops.length
  check(Math.min(...drops) > 0.08 && meanDrop > 0.2,
    'and an open bottom pays for itself, dropping a fifth of the faces on average',
    open.map((n, i) => `${n} ${(drops[i] * 100).toFixed(0)}%`).join('  '))

  // THE SPIRE, WHICH IS THE ONE SHAPE ALLOWED TO BE A TOOTH. It was blunted
  // when the bank was rebuilt (taper 0.85 -> 0.68, taperPow 2.2 -> 1.7) and
  // penned into `peak`, and the promise that survives that is comparative: it
  // is still the pointiest thing in the bank, and nothing else has crept up
  // behind it. Pointiness is the silhouette radius in the top tenth of the
  // height over the widest radius anywhere -- "comes to a point" with a number
  // on it -- and it is averaged over twelve seeds because a single rock's crown
  // is one lump of noise and the default `lumps` went 0.55 -> 0.7 with the
  // rebuild. Per-seed, the profile now genuinely wanders; the mean does not.
  {
    const SEEDS_HERE = 12
    const profile = (name) => {
      const mean = new Float64Array(10)
      for (let s = 1; s <= SEEDS_HERE; s++) {
        const g = buildRock({ ...rockParams(name, s * 37 + 3), tier: 0 })
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
        for (let i = 0; i < 10; i++) mean[i] += bins[i] / w / SEEDS_HERE
        g.dispose()
      }
      return mean
    }
    const crowns = ROCK_NAMES.map((n) => ({ name: n, crown: profile(n)[9] })).sort((a, b) => a.crown - b.crown)
    check(crowns[0].name === 'spire' && crowns[0].crown < 0.4,
      'the spire is the pointiest thing in the bank and still a tooth, not a dome',
      `crown ${crowns[0].crown.toFixed(2)} of the widest, next is ${crowns[1].name} at ${crowns[1].crown.toFixed(2)}`)
    const sp = profile('spire')
    check(sp[0] > 0.9, 'the spire stands on a foot, not on a point', `bottom tenth is ${sp[0].toFixed(2)}`)
    // Monotone, near enough: a mid-height bulge is what the old isotropic taper
    // produced, and it is what made the thing read as a rounded lump.
    let rises = 0
    for (let i = 1; i < 10; i++) if (sp[i] > sp[i - 1] + 0.02) rises++
    check(rises <= 1, 'the spire narrows all the way up', `${rises} widening steps in ${[...sp].map((v) => v.toFixed(2)).join(' ')}`)
  }

  for (const g of bank.geometries) g.dispose()
}

// ---------------------------------------------------------------------------
// 8. The world scatter: three beds, one material, and stone where stone belongs.
//
// The scatter's own machinery -- tiles, ranks, graded thinning, the build budget
// -- is render/trees.js's and is gated by check-trees.mjs there. What is new here
// and what this section holds is the part that is ROCK: that a size class is
// scattered at its own density over its own radius, that the environment gate
// actually gates, that a rock is bedded rather than balanced, and that the pool
// bound survives the densest ground in the world.
// ---------------------------------------------------------------------------

console.log('\nscatter')

{
  // `bands` is the altitude ramp the chunk mesher shades against, and the scatter
  // reads it because every rock's tint is pulled toward the colour the ground
  // under it is painted -- see GROUND_CUE. 0..900 m is the world's own span, so
  // the flat worlds below sit low on the ramp and the peak world sits at the top
  // of it, which is what makes the tints they produce comparable to the real ones.
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

  // A world with actual RELIEF in it, which the flat stubs above cannot have.
  // `_relief` is a SECOND difference along the fall line, so constant ground
  // scores zero at both ends by construction and no rock in any flat world is
  // ever at the foot or on the brow of anything -- which is correct, and which
  // also means the site machinery would go entirely untested on flat stubs.
  //
  // A sine ridge in x, and the numbers are chosen against _relief's own: the
  // amplitude and wavelength put the peak second difference over RELIEF_PROBE at
  // 8.9 m, clear of the 7 m FOOT_RISE and BROW_DROP, and about 7% of the ground
  // ends up a foot and another 7% a brow -- benches, not a world of them. `tan`
  // is the field's real gradient rather than a constant, because a stub that
  // told the slope test one thing and the relief probe another would be testing
  // a world that cannot exist. It tops out at 1.10 (48 deg), which the boulders
  // and giants beds allow and the underfoot bed's 42 deg does not, so the small
  // stones thin out on the steep flanks exactly as they would on a real ridge.
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

  const texArray = buildTextureArray()
  const forest = world(60, 0, 9999, null)
  const cliff = world(60, 0.8, 9999, null) // 38.7 deg: past CLIFF_SLOPE_DEG, inside every bed's limit
  const peak = world(900, 0.5, 880, null)
  const river = world(60, 0, 9999, 60.8)

  // One Layers stub for every world here. Rocks needs it for two things and both
  // are the terrain's: `snow.band` and `flattenAt` feed the ground cue, and
  // syncBands reads the snow line off it. flattenAt returns 0 -- no road under
  // any of these rocks -- which is the case the cue has to be right in anyway.
  const layers = { flattenAt: () => 0, snow: { base: 780, band: 90 } }

  const build = (w) => {
    const r = new Rocks(new THREE.Scene(), w.field, w.water, layers, texArray, { seed: 7, seeds: 2 })
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
  // The same bed on the two grounds, at the ratio BEDS asks for: giants run at
  // 0.25 through a wood and 1.0 on a cliff, so the cliff should carry four times
  // as many. Counted over 600 m rather than the 200 the check above uses, and
  // that is not a wider bound but a quieter measurement -- a wood only holds
  // about twenty giants inside 200 m and a count of twenty is +/- 20% on the
  // seed alone, which is most of the margin between 3x and 4x. Over 600 m both
  // counts are in the hundreds and the ratio sits on 4 across seeds. The graded
  // thinning past fullRadius applies to both worlds identically, so it cancels.
  const cliffTest = build(cliff)
  check(within(cliffTest, 'giants', 600) > within(forestRocks, 'giants', 600) * 3,
    'the cliff is littered where the wood is not',
    `${within(cliffTest, 'giants', 600)} vs ${within(forestRocks, 'giants', 600)} inside 600 m`)
  cliffTest.dispose()

  // --- the twelve pools ------------------------------------------------------
  //
  // Three beds crossed with four environments, and every one of the twelve has
  // to be furnished. Without this a whole size class silently vanishes on one
  // kind of ground -- the failure mode where a cliff has pebbles and spires on
  // it and nothing in between -- and nothing throws, because a bed with an empty
  // pool just places nothing.
  //
  // A FLOOR, NOT "NON-EMPTY", and the floor is two everywhere and three at the
  // peak. One shape per pool is not a pool: it is the same rock rotated, and at
  // the density the giants bed runs on a cliff you would be looking at a hundred
  // copies of it at once. The peak gets the higher floor because it is the
  // ground the rebuild was FOR: above the treeline the old table had three
  // tapered towers and a chip of scree, and "furnished" there has to mean a
  // choice rather than a family resemblance.
  //
  // COUNTED IN VARIANTS, not in pool entries. A pool holds one entry per seed, so
  // at three seeds a bed furnished by a single variant would score three, and a
  // floor measured on entries would call that a choice.
  const POOL_FLOOR = { river: 2, forest: 2, cliff: 2, peak: 3 }
  let thin = 0
  const census = []
  for (const bed of forestRocks.beds) {
    for (const env of ENVIRONMENTS) {
      const plain = new Set(bed.byEnv.get(env).map((i) => bed.shapes[i].name)).size
      const site = new Set(SITES.flatMap((s) => bed.bySite.get(`${env}|${s}`).map((i) => bed.shapes[i].name))).size
      if (plain < POOL_FLOOR[env]) thin++
      census.push(`${bed.cfg.name[0]}/${env} ${plain}${site ? `+${site}` : ''}`)
    }
  }
  check(thin === 0, 'every bed offers every environment a real choice, and the peak the widest',
    census.join('  '))

  // And every variant in the bank is placed by SOMEBODY. A shape nobody's `names`
  // list mentions is a rock that builds, ships in the arena, costs its share of
  // the bank's triangles and is never once seen -- the quietest way for the table
  // to rot, since nothing about it fails.
  const rostered = new Set(forestRocks.beds.flatMap((b) => b.cfg.names))
  const orphans = ROCK_NAMES.filter((n) => !rostered.has(n))
  check(orphans.length === 0, 'every variant in the bank is on some bed roster',
    orphans.length ? `never placed: ${orphans.join(' ')}` : `${rostered.size} rostered`)

  // THE SITE POOLS ARE HELD OUT OF THE ORDINARY ONES. `site` is the whole reason
  // talus and lip exist: a talus cone is what lies at the FOOT of a face and a
  // lip is what juts off its BROW, and either one strewn at random across open
  // hillside is worse than not having it, because the eye reads scree as a sign
  // that something steep is above it. RockBed keeps two indexes so the ordinary
  // draw can never reach a tagged shape; this is that split, asserted.
  let leaked = 0
  for (const bed of forestRocks.beds) {
    for (const env of ENVIRONMENTS) for (const i of bed.byEnv.get(env)) if (bed.shapes[i].site !== null) leaked++
  }
  check(leaked === 0, 'a sited shape is never in the pool the ordinary draw reads',
    `${leaked} tagged shapes loose in byEnv`)
  // The other half: the tagged pools are actually reachable, and the `siteEnvs`
  // fast-path gate agrees with them. A bed whose siteEnvs missed an environment
  // it has shapes for would never take the relief probe there, so the shapes
  // would be indexed and never drawn.
  let gate = 0
  for (const bed of forestRocks.beds) {
    for (const env of ENVIRONMENTS) {
      const any = SITES.some((s) => bed.bySite.get(`${env}|${s}`).length > 0)
      if (any !== bed.siteEnvs.has(env)) gate++
    }
  }
  check(gate === 0, 'siteEnvs names exactly the environments a bed has tagged shapes for')
  const boulderBed = forestRocks.beds.find((b) => b.cfg.name === 'boulders')
  const giantBed = forestRocks.beds.find((b) => b.cfg.name === 'giants')
  const poolNames = (bed, key) => [...new Set(bed.bySite.get(key).map((i) => bed.shapes[i].name))].join(' ')
  check(boulderBed.bySite.get('cliff|foot').length > 0 && boulderBed.bySite.get('peak|foot').length > 0 &&
    giantBed.bySite.get('cliff|brow').length > 0 && giantBed.bySite.get('peak|brow').length > 0,
    'scree lies at the foot of both a cliff and a peak, and a lip juts off the brow of each',
    `foot ${poolNames(boulderBed, 'cliff|foot')}  brow ${poolNames(giantBed, 'cliff|brow')}`)

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
  // The spire is the one variant tagged `peak` and nothing else, which is half of
  // what the rebuild did about the teeth: the other half was blunting it. A
  // summit needle sprouting out of the side of a valley wall is the shape of the
  // original complaint, so this is the check that says it cannot come back.
  check(!cliffGiants.has('spire'), 'a summit spire does not grow out of a cliff face')

  // A SPIRE IS A DROP, NOT AN ELEVATION, and this pair is what says so. Height
  // alone was the wrong test for a pinnacle: an elevation gate spreads spires
  // evenly over every high slope, which is a field of fangs however few of them
  // there are. The spire is now tagged `site: 'brow'`, so it is out of the
  // ordinary peak pool entirely and only stands where the ground falls away
  // below it -- which means the peak's OPEN slopes have to come out blunt and
  // the peak's BROW pool has to be where the tooth went. Both halves are the
  // promise, because either one on its own is satisfied by deleting the spire.
  //
  // `peakRocks` is a uniform slope and so is nobody's brow (see the sites block
  // below), which is exactly why it is the right world to read the ordinary
  // pool off: nothing tagged can reach the ground here at all.
  const peakGiants = named(peakRocks, 'giants')
  const peakPointy = [...peakGiants].filter((n) => (ROCK_VARIANTS[n].taper ?? 0) > 0.5)
  check(peakGiants.size > 0 && peakPointy.length === 0,
    'an open peak slope is furnished, and not one of its giants comes to a point',
    `${[...peakGiants].join(' ')}${peakPointy.length ? ` -- pointed: ${peakPointy.join(' ')}` : ''}`)
  const peakBrow = new Set(giantBed.bySite.get('peak|brow').map((i) => giantBed.shapes[i].name))
  check(peakBrow.has('spire'), 'and the spire is what stands on the peak\'s brow, where the ground drops away',
    [...peakBrow].join(' '))
  check(!peakGiants.has('blockhouse'), 'no forest blockhouse above the treeline')

  const riverBoulders = named(riverRocks, 'boulders')
  check(riverBoulders.size > 0, 'the riverbed is not bare', [...riverBoulders].join(' '))
  check(![...riverBoulders].some((n) => ['mosshump', 'erratic', 'cleft'].includes(n)),
    'no forest-only shape standing in the water')
  check(riverRocks.stats.beds.find((b) => b.name === 'giants').placed === 0,
    'no ten-metre buttress in the middle of a lake')
  check(riverRocks.stats.beds.find((b) => b.name === 'underfoot').placed > 0,
    'pebbles are allowed to be underwater')

  // --- the sites, on ground that has any ------------------------------------
  //
  // Everything above stands on a plane, and a plane is nobody's foot and nobody's
  // brow: _relief is a second difference, so uniform ground scores zero at both
  // ends however steep it is. That is the first promise here, and it is the one
  // that costs nothing to keep and everything to lose -- if flat ground started
  // reading as a cliff base, scree would appear in the middle of open hillside
  // and the cue would stop meaning anything.
  const sitedIn = (rocks) => rocks.stats.beds.reduce(
    (n, b) => n + b.sited.foot + b.sited.brow, 0)
  check(sitedIn(cliffRocks) === 0 && sitedIn(peakRocks) === 0,
    'a uniform slope is not the foot of anything, however steep',
    `${sitedIn(cliffRocks)} on the cliff, ${sitedIn(peakRocks)} on the peak`)

  // And then the same beds on the ridge, where there ARE feet and brows. What is
  // being held is that the tagged shapes reach the ground at all: they are
  // reachable only through _relief, so a bed indexing them correctly and never
  // probing would look identical from every angle except this one.
  {
    const r = build(ridge)
    const bedsBySite = Object.fromEntries(r.stats.beds.map((b) => [b.name, b.sited]))
    check(bedsBySite.boulders.foot > 0 && bedsBySite.giants.brow > 0,
      'a ridge gets scree at its feet and lips off its brows',
      `${bedsBySite.boulders.foot} foot in the boulders, ${bedsBySite.giants.brow} brow in the giants`)
    // Each bed only carries tags for one site, so the other stays zero -- and
    // the underfoot bed carries none at all, which is why its roster has no
    // tagged shape on it. A count appearing here means a roster changed without
    // the pools being thought about.
    check(bedsBySite.underfoot.foot === 0 && bedsBySite.underfoot.brow === 0 &&
      bedsBySite.boulders.brow === 0 && bedsBySite.giants.foot === 0,
      'and a bed only places the sites it actually rosters shapes for',
      Object.entries(bedsBySite).map(([n, s]) => `${n} ${s.foot}/${s.brow}`).join('  '))
    // SITE_SHARE is 0.75, so even standing at the foot of something a quarter of
    // the rocks are ordinary ones. A talus cone made entirely of talus chips is
    // a texture, not a pile; the ordinary boulders mixed through it are what give
    // it a size range.
    const bed = r.beds.find((b) => b.cfg.name === 'boulders')
    const tally = new Map()
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const n = bed.shapes[bed.shapeAt[t.ids[k]]].name
        tally.set(n, (tally.get(n) ?? 0) + 1)
      }
    }
    const tagged = ['talus', 'rubble'].reduce((n, k) => n + (tally.get(k) ?? 0), 0)
    const total = [...tally.values()].reduce((a, b) => a + b, 0)
    check(tagged > 0 && tagged / total < 0.25, 'scree is a minority even on a ridge full of feet',
      `${tagged} of ${total} boulders are talus or rubble`)

    // MORE CANDIDATES AT A LOWER RATE, which is the shape of the boulders bed's
    // density change and the reason it needs three checks of its own: read
    // either number alone and it looks like somebody multiplied the boulders in
    // the world or divided them, and it is neither.
    //
    // `envDensity` is an ACCEPT RATE, tested as `envRoll >= dens`, and at a foot
    // site `dens` is `envDensity * (1 + CLUMP_GAIN * clump)`. That product is
    // capped at 1 by construction, so every candidate it pushes past 1.0 has the
    // rest of its multiplier silently thrown away -- and the thrown-away part IS
    // the clumping. At the old cliff and peak rate of 1.0 the cap ate all of it
    // and CLUMP_GAIN was a dead knob: turning it up did nothing at all, which is
    // the kind of failure that never shows up as an error. So the rates came
    // down by 2.5x and `density` went up by the same factor to pay for them.
    //
    // Held as three separate promises, because each one fails on its own:
    // nothing moved in absolute terms, the cap is no longer eating the gain, and
    // a foot really does end up about twice as dense as the ground beside it.
    const rate = bed.cfg.envDensity
    const perM2 = Object.fromEntries(Object.entries(rate).map(([e, v]) => [e, bed.cfg.density * v]))
    // The shipped rocks per square metre of open ground, which is what a player
    // sees and the only figure the retune was not allowed to move. Pinned here
    // so that a later "simplification" folding `density` and `envDensity` back
    // together cannot quietly re-scatter every environment in the game.
    const WANT = { river: 0.00294, forest: 0.0042, cliff: 0.0042, peak: 0.00336 }
    const drift = Object.entries(WANT).map(([e, w]) => Math.abs(perM2[e] - w) / w)
    check(Math.max(...drift) < 0.02,
      'raising the candidate count and lowering the accept rate left every environment exactly as dense as it was',
      Object.entries(perM2).map(([e, v]) => `${e} ${v.toFixed(5)}`).join('  '))

    // AND THE CAP IS NOT EATING THE CLUMPING. This is the invariant the two
    // numbers above exist to satisfy, and the one that failed silently before:
    // if `envDensity * (1 + CLUMP_GAIN * clump)` is at or past 1.0 for most of
    // the field, most feet are saturated, CLUMP_GAIN is inert, and no future
    // attempt to tune the piles will do anything. Sampled against the bed's own
    // `_clump` -- the real field, not a uniform stand-in, because it is bilinear
    // value noise and piles up around 0.5 -- and against the highest rate any
    // environment asks for, since that is the one that saturates first.
    const clumps = []
    for (let i = 0; i < 20000; i++) clumps.push(bed._clump(i * 19.03, i * 7.71 + (i % 89) * 1.61))
    const worstRate = Math.max(...Object.values(rate))
    const saturated = clumps.filter((c) => worstRate * (1 + CLUMP_GAIN * c) >= 1).length / clumps.length
    check(saturated < 0.35, 'and a cliff foot is not so densely offered that the clump field stops mattering',
      `${(saturated * 100).toFixed(0)}% of the field saturates at the top rate ${worstRate}`)

    // Then the thing itself, measured on the ridge so it does not depend on
    // which environment the ridge lands in. The ceiling is 1 + CLUMP_GAIN / 2 =
    // 2.10x, reached only when nothing is truncated; at the rates above the
    // untruncated prediction is 2.05x and this disc measures a little under it,
    // which is where a couple of hundred rocks of counting noise puts it. At the
    // old rates it was 1.85x and falling. The bound sits below the noise and
    // above the saturated case on purpose: it is not measuring 2.0, it is
    // catching a return to the regime where the cap is in charge.
    //
    // Counted over the WHOLE bed rather than the near disc: the graded thinning
    // outside `fullRadius` is a function of distance alone and applies to foot
    // and open candidates alike, so it leaves the ratio untouched while giving
    // it ten times the sample.
    {
      const R = bed.cfg.radius
      const isFoot = (x, z) => bed._relief(x, z, ridge.field.heightAt(x)) === 'foot'
      let footN = 0
      let openN = 0
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const x = bed.instX[id]
          const z = bed.instZ[id]
          if (x * x + z * z > R * R) continue
          if (isFoot(x, z)) footN++
          else openN++
        }
      }
      // How much of the disc is foot, by sampling the same predicate the scatter
      // asked. A count without an area is not a density.
      let footA = 0
      let openA = 0
      for (let x = -R; x <= R; x += 2) {
        for (let z = -R; z <= R; z += 2) {
          if (x * x + z * z > R * R) continue
          if (isFoot(x, z)) footA++
          else openA++
        }
      }
      const ratio = (footN / footA) / (openN / openA)
      check(ratio > 1.85, 'a cliff foot carries close to twice the scree of the open ground beside it',
        `${footN} foot and ${openN} open rocks, ${ratio.toFixed(2)}x the density`)
    }
    r.dispose()
  }

  // Bedded, not balanced -- and deeper on a slope, which is what makes a cliff
  // rock read as protruding from the face.
  //
  // THE SLOPE TERM IS A FLOOR AND NOT THE ANSWER, which is what this block used
  // to get wrong. The two large beds now set `sinkVary` and roll each instance's
  // burial between that floor and SINK_DEEP, because a scatter where every rock
  // is bedded the same fraction reads as props standing ON the hill rather than
  // as stone coming OUT of it. So "a cliff rock is bedded deeper" stopped being
  // true instance for instance -- one steep rock can absolutely be shallower
  // than one flat rock -- and what survives is the FLOOR and the MEAN. Both are
  // asserted, because the mean alone would be kept by a roll that reached down
  // past the floor on a cliff and the floor alone says nothing about what the
  // ground actually looks like.
  //
  // Measured as a fraction of the instance's OWN height, which means dividing
  // out its scale: `instSink` is metres and the roll is a fraction, so a bed
  // whose scale spans 0.55 to 2.2 would otherwise report the scale roll rather
  // than the burial roll. The scale comes back off the instance matrix, and the
  // open-bottomed variants are skipped because OPEN_BURY adds a term measured in
  // WIDTH on top of theirs (rocks.js) and it is not part of this promise.
  {
    const mat = new THREE.Matrix4()
    const fracs = (rocks, bedName) => {
      const bed = rocks.beds.find((b) => b.cfg.name === bedName)
      const out = []
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const s = bed.shapes[bed.shapeAt[id]]
          if (s.openBottom) continue
          bed.batch.getMatrixAt(id, mat)
          const e = mat.elements
          out.push(bed.instSink[id] / (s.measured.height * Math.hypot(e[0], e[1], e[2])))
        }
      }
      if (!out.length) throw new Error(`no closed-bottomed ${bedName} to measure`)
      return out
    }
    const stat = (a) => ({
      min: Math.min(...a), max: Math.max(...a), mean: a.reduce((x, y) => x + y, 0) / a.length, n: a.length,
    })
    const flat = stat(fracs(forestRocks, 'boulders'))
    const steep = stat(fracs(cliffRocks, 'boulders'))

    check(flat.mean > 0.02, 'a rock on the flat is bedded into the ground',
      `${(flat.mean * 100).toFixed(0)}% of its height on average, over ${flat.n}`)
    // 1.25x rather than the 1.5 this held before the roll went in, and the
    // slack is where the roll went: on flat ground the floor is 6% and the roll
    // runs to 50%, so the mean is already most of the way up the range and a
    // cliff cannot move it as far as it used to move a fixed fraction.
    check(steep.mean > flat.mean * 1.25, 'and averaged over a hillside, a rock on a cliff is bedded deeper',
      `${(steep.mean * 100).toFixed(0)}% vs ${(flat.mean * 100).toFixed(0)}%`)
    // The floor, which is the half of the promise that is still exact. Nothing
    // on the cliff may be as shallow as the shallowest thing on the flat -- that
    // is what stops a steep rock's downhill side hanging in the air, and it is
    // the one thing the per-instance roll must not be allowed to undo.
    check(steep.min > flat.min * 2, 'and the shallowest cliff rock is still deeper than the shallowest flat one',
      `floors ${(steep.min * 100).toFixed(0)}% vs ${(flat.min * 100).toFixed(0)}%`)

    // AND THE ROLL ACTUALLY SPANS ITS RANGE. A `sinkVary` bed on flat ground is
    // the widest case there is -- floor at SINK_MIN, roll to SINK_DEEP -- so
    // both ends should turn up in a wood, and if they stop turning up the bed
    // has quietly gone back to one burial fraction for everything, which is the
    // look the roll exists to break. Stated as the 5-50% that SINK_MIN and
    // SINK_DEEP promise, with a hair of slack at each end for the sample.
    check(flat.min < 0.08 && flat.max > 0.46,
      'a wood buries its boulders anywhere from a twentieth to half of themselves',
      `${(flat.min * 100).toFixed(0)}% .. ${(flat.max * 100).toFixed(0)}%`)
    // And the bed WITHOUT `sinkVary` stays a pure function of slope, because a
    // pebble is too small for the difference to read and its open-shell variants
    // have a burial rule of their own already. One slope, one fraction, exactly.
    const under = stat(fracs(forestRocks, 'underfoot'))
    const underSteep = stat(fracs(cliffRocks, 'underfoot'))
    check(under.max - under.min < 1e-6 && underSteep.max - underSteep.min < 1e-6 &&
      underSteep.min > under.max,
      'the underfoot bed takes no roll at all -- one slope, one burial fraction',
      `${(under.min * 100).toFixed(1)}% flat, ${(underSteep.min * 100).toFixed(1)}% on the cliff`)

    const flatBed = forestRocks.beds.find((b) => b.cfg.name === 'boulders')
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
    forestRocks.syncBands(layers)
    const snow = getSnowLine()
    const moss = getMossLine()
    check(snow.base === 780 && snow.band === 90, 'props take the terrain snow line verbatim')
    check(moss.base < snow.base - snow.band, 'moss has given out well before the snow starts',
      `moss ${moss.base} m, snow ${snow.base} m`)
    check(moss.band > layers.snow.band, 'the moss line is a gradient, not a contour', `${moss.band} m band`)
    // syncBands ALSO narrows both ceilings, and that is the half of it that is
    // easy to lose, because nothing about the lines depends on it. A rock at a
    // full snow load is not a snowy rock, it is a white one -- stone leans on the
    // surface normal twice as hard as foliage does -- so the world caps it at a
    // third to a half and the granite keeps showing through. Moss's cap starts at
    // ZERO on purpose: a wood wants bare boulders in it as much as green ones.
    const sv = getSnowVary()
    const mv = getMossVary()
    check(sv.lo > 0 && sv.hi <= 0.5 && sv.hi > sv.lo, 'the world caps a rock at a dusted crown, not a white one',
      `snow load ${sv.lo}-${sv.hi} of full`)
    check(mv.lo === 0 && mv.hi <= 0.5, 'and lets a share of the wood stay bare stone',
      `moss ${mv.lo}-${mv.hi} of full`)
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
    let dimmestLuma = Infinity
    let underOne = 0
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        bed.batch.getColorAt(t.ids[k], c)
        buckets.add(`${Math.round(c.r * 6)},${Math.round(c.g * 6)},${Math.round(c.b * 6)}`)
        dimmest = Math.min(dimmest, c.r, c.g, c.b)
        dimmestLuma = Math.min(dimmestLuma, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b)
        if (Math.min(c.r, c.g, c.b) < 1) underOne++
        n++
      }
    }
    check(buckets.size >= 8, 'a wood of boulders is not one colour',
      `${buckets.size} distinct tints across ${n} instances`)
    // The whole point of the rework: a per-instance colour is a GAIN. The jitter
    // floor is 0.86 and the palette's smallest gain is 1.39, so before the ground
    // cue the dimmest thing the scatter could write was about 1.15, and the
    // promise was stated per channel: nothing below 1, so no rock in the world
    // comes out darker than the tile it is made of.
    //
    // THE GROUND CUE MADE THAT THE WRONG WAY TO SAY IT, and the promise itself is
    // unchanged. The cue is renormalised to unit LUMINANCE on purpose -- a rock's
    // tint is an absolute destination and the terrain palette is near black, so
    // taking its magnitude would delete the rock rather than seat it -- which
    // means what it applies is a hue rotation at constant brightness. A rotation
    // toward forest green necessarily pulls some channel down; stone.png is warm
    // granite whose weakest channel is already blue, and blue is the one it pulls.
    // So brightness is the promise and it is asserted on brightness, at the
    // luminance the cue is normalised against and nothing else.
    check(dimmestLuma > 1, 'no instance darkens the tile',
      `dimmest instance is ${dimmestLuma.toFixed(2)}x the bare tile`)
    // And the hue swing that buys is small and rare, which is the other half of
    // what "seated, not repainted" has to mean. A wood is the worst case in the
    // world for it -- the greenest ground and the lowest gains -- and there it
    // takes a handful of instances a few percent under on blue alone.
    check(dimmest > 0.9 && underOne / n < 0.02,
      'and the hue the cue borrows off the ground never amounts to a repaint',
      `${underOne} of ${n} dip a channel below the tile, lowest ${dimmest.toFixed(2)}`)
    // ENV_TINTS is what makes that true per environment, so it has to name all
    // four and index nothing that does not exist.
    for (const env of ENVIRONMENTS) {
      const pal = ENV_TINTS[env]
      check(Array.isArray(pal) && pal.length >= 4 && pal.every((i) => i >= 0 && i < TINTS.length),
        `${env} cycles a real palette`, `${pal.length} entries`)
    }
  }

  // --- the per-instance moss and snow ---------------------------------------
  //
  // Both ceilings are RANGES now, not amounts: each instance rolls its own
  // number in [lo, hi] off a hash of its root's world XZ and wears the scene
  // ceiling times that. What was one scalar "how much variation" is two numbers
  // saying what the least and the most mossed rock in the wood look like, which
  // is the thing that was actually wanted -- a wood is not one colour and it is
  // not one greenness either.
  //
  // (1, 1) IS THE DEFAULT AND IT IS THE NO-OP, and that default is load bearing
  // rather than incidental: /gen-rock shows exactly one rock, at the origin, and
  // if the variation were always on, that one rock would wear whatever the hash
  // of (0,0) happened to be and the bench's slider would stop meaning what it
  // says. The world narrows it in syncBands; the bench never does.
  {
    // syncBands ran above, so put both back where a fresh module leaves them
    // before asserting what a fresh module leaves them at.
    setMossVary(1, 1)
    setSnowVary(1, 1)
    const m0 = getMossVary()
    const s0 = getSnowVary()
    check(m0.lo === 1 && m0.hi === 1 && s0.lo === 1 && s0.hi === 1,
      'the full ceiling for everything is the no-op both ranges default to',
      `moss ${m0.lo}-${m0.hi}, snow ${s0.lo}-${s0.hi}`)
    setMossVary(0.2, 0.6)
    setSnowVary(0.3, 0.5)
    const m1 = getMossVary()
    const s1 = getSnowVary()
    check(m1.lo === 0.2 && m1.hi === 0.6 && s1.lo === 0.3 && s1.hi === 0.5,
      'and they are real knobs, both ends of both',
      `moss ${m1.lo}-${m1.hi}, snow ${s1.lo}-${s1.hi}`)
    // Each end clamps to a fraction like every other ceiling here, because both
    // are multipliers on setMoss/setSnow and a gain above 1 would put a rock
    // past the season the scene asked for.
    setMossVary(-3, 4)
    setSnowVary(-3, 4)
    const m2 = getMossVary()
    const s2 = getSnowVary()
    check(m2.lo === 0 && m2.hi === 1 && s2.lo === 0 && s2.hi === 1,
      'each end clamps to a fraction, like every other ceiling here',
      `moss ${m2.lo}-${m2.hi}, snow ${s2.lo}-${s2.hi}`)
    // AN INVERTED RANGE THROWS rather than quietly sorting itself, because there
    // is no sane reading of it: mix( hi, lo, roll ) is a range that runs
    // backwards and looks identical from the outside, so the caller who wrote
    // the arguments in the wrong order would never find out.
    const throws = (f) => { try { f(); return false } catch { return true } }
    check(throws(() => setMossVary(0.6, 0.2)) && throws(() => setSnowVary(0.6, 0.2)),
      'a range whose top is below its bottom throws instead of silently inverting')
    check(throws(() => setMossVary(0, NaN)) && throws(() => setSnowVary(Infinity, 1)),
      'and so does a range that is not two numbers')

    // BOTH ROLLS ARE GATED, and each on a DIFFERENT list -- which is the whole
    // content of this block, and which used to be one sentence saying moss
    // needed no gate at all. That was true only while MOSS_LAYERS was the stone
    // layer alone; moss now grows on three barks and on TIMBER_BEAM as well, so
    // an ungated roll would reach every trunk in the world.
    //
    // Asserted in the SHADER because that is where both gates live: the JS
    // setters are two global uniforms and know nothing about layers.
    //
    // Snow's question is about the RECIPE. Any surface leaning on 'up' as hard
    // as stone does -- which since wood joined SNOW_HARD_LAYERS means bark and
    // timber too -- takes its own undersides at a full load and stops reading as
    // itself, while a canopy at a full load is a loaded tree and correct. So the
    // snow roll runs on the wide list and foliage keeps the ceiling.
    //
    // Moss's question is narrower: uMossVary is driven from Rocks.syncBands with
    // a range chosen for BOULDERS, so it may only reach STONE. Gating it on the
    // list of things moss grows on would halve the moss on every trunk and beam
    // in the world to suit a decision about rocks -- so the third check below is
    // the one that matters, and it says the gate is NOT MOSS_LAYERS.
    const src = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {},
    }
    createPropMaterial(texArray).onBeforeCompile(src)
    const vs = src.vertexShader
    const snowAt = vs.indexOf('vSnowPos = vec4(')
    const mossAt = vs.indexOf('vMoss =')
    // Loudly, rather than slicing from -1 and quietly asserting against the
    // wrong half of the shader: if either write has been renamed, this section
    // is reading something it does not understand and should say so.
    if (snowAt < 0 || mossAt <= snowAt) throw new Error('the prop vertex shader no longer writes vSnowPos then vMoss')
    const snowSlice = vs.slice(snowAt, mossAt)
    const mossSlice = vs.slice(mossAt)
    // Both accumulators are read out of the emitted source by their LOOP BOUND
    // rather than by matching a block of it verbatim, because the bound is the
    // part that carries the meaning: each says how many of uSnowRockLayers --
    // one array, built stone-first -- that gate is willing to look at.
    const loopLen = (name) => {
      const m = vs.match(new RegExp(`i < (\\d+); i\\+\\+ \\) \\{\\s*${name} \\+= step\\( abs\\( texLayer - uSnowRockLayers`))
      if (!m) throw new Error(`the prop vertex shader no longer builds ${name} from uSnowRockLayers`)
      return Number(m[1])
    }
    const hardLayers = [...SNOW_ROCK_LAYERS, ...SNOW_WOOD_LAYERS]
    check(snowSlice.includes('uSnowVary.x') && snowSlice.includes('min( rockV, 1.0 )') &&
      loopLen('rockV') === hardLayers.length,
      'the snow roll reaches an instance only through the hard-surface layer list',
      `gated on ${hardLayers.length} layers: ${SNOW_ROCK_LAYERS.length} stone, ${SNOW_WOOD_LAYERS.length} wood`)
    check(mossSlice.includes('uMossVary.x') && mossSlice.includes('min( stoneV, 1.0 )') &&
      loopLen('stoneV') === SNOW_ROCK_LAYERS.length &&
      SNOW_ROCK_LAYERS.length === 1 && SNOW_ROCK_LAYERS[0] === LAYER.ROCK,
      'and the moss roll reaches one only through the narrower stone list, which is still stone alone',
      `SNOW_ROCK_LAYERS = [${SNOW_ROCK_LAYERS.join(' ')}], LAYER.ROCK = ${LAYER.ROCK}`)
    // THE OBVIOUS WRONG GATE, named so that writing it cannot pass. MOSS_LAYERS
    // is a fragment-stage question -- may this surface show moss at all -- and
    // it is longer than the stone list by every bark on it. Re-keying the roll
    // to it would look like a tidy-up and would be a silent halving of the moss
    // on every trunk in the world.
    check(!mossSlice.includes('uMossLayers') && MOSS_LAYERS.length > SNOW_ROCK_LAYERS.length &&
      src.fragmentShader.includes('mossMask += step( abs( vTexLayer - uMossLayers[ i ] ), 0.5 )'),
      'and MOSS_LAYERS stays out of it -- that list says where moss may grow, not whose range this is',
      `MOSS_LAYERS = [${MOSS_LAYERS.join(' ')}] against a gate of [${SNOW_ROCK_LAYERS.join(' ')}]`)

    setMossVary(1, 1)
    setSnowVary(1, 1)
  }

  for (const r of [forestRocks, cliffRocks, peakRocks, riverRocks]) r.dispose()
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all rock checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

// --- helpers ----------------------------------------------------------------

// The moss mask's `creep`, sampled all round a boulder and sorted, plus the one
// query section 5 asks of it: what fraction of the rock sits above a given cut.
// Coverage is the field's complementary CDF, and there is no closed form for it
// -- MOSS_CUT_MID and MOSS_CUT_WIDTH are a FIT to this distribution, so the only
// way to check the fit is to have the distribution.
//
// A PORT, and the honest cost of it is stated where it is used: snowNoise and
// blobField are transliterated from the GLSL in material.js and could drift
// from it silently. Everything that can be imported is -- MOSS.freq, MOSS.down,
// SNOW_ROCK.blobWarp, SNOW_ROCK.blobContrast -- so the only literals here are
// the two noise offsets and the warp frequency, which material.js keeps
// module-private.
//
// A SPHERE OF RADIUS 0.9, and the radius matters: the field is sampled in WORLD
// space, so the size of the rock decides how many patches are wrapped around it
// and therefore how the samples are distributed. 0.9 m is an ordinary boulder,
// which is what the moss constants were fitted against and what a player mostly
// sees wearing moss. Fibonacci rather than a lattice or a random spray, because
// it is the even sphere sampling with no seam and no clustering at the poles --
// and the poles are exactly where `down` is at its extremes.
function mossCreepOnBoulder() {
  const N = 20000
  const R = 0.9
  const BLOB_WARP_FREQ = 0.46 // material.js, not exported: the coarse copy that drags the rims about
  const fract = (v) => v - Math.floor(v)
  const hash = (x, y, z) => {
    const px = fract(x * 0.3183099 + 0.71) * 17
    const py = fract(y * 0.3183099 + 0.113) * 17
    const pz = fract(z * 0.3183099 + 0.419) * 17
    return fract(px * py * pz * (px + py + pz))
  }
  const mix = (a, b, t) => a + (b - a) * t
  const noise = (x, y, z) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const iz = Math.floor(z)
    let fx = x - ix
    let fy = y - iy
    let fz = z - iz
    fx = fx * fx * (3 - 2 * fx)
    fy = fy * fy * (3 - 2 * fy)
    fz = fz * fz * (3 - 2 * fz)
    return mix(
      mix(mix(hash(ix, iy, iz), hash(ix + 1, iy, iz), fx),
        mix(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), fx), fy),
      mix(mix(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), fx),
        mix(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), fx), fy),
      fz)
  }
  const blobField = (x, y, z) => {
    const w = noise(x * BLOB_WARP_FREQ + 23.1, y * BLOB_WARP_FREQ + 5.7, z * BLOB_WARP_FREQ + 61.3)
    const warp = SNOW_ROCK.blobWarp
    const f = noise(x + w * warp, y + w * 1.7 * warp, z - w * warp)
    return Math.min(1, Math.max(0, (f - 0.5) * SNOW_ROCK.blobContrast + 0.5))
  }

  const creeps = new Float64Array(N)
  const GOLDEN = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < N; i++) {
    const ny = 1 - (2 * (i + 0.5)) / N
    const ring = Math.sqrt(Math.max(0, 1 - ny * ny))
    const a = i * GOLDEN
    const nx = Math.cos(a) * ring
    const nz = Math.sin(a) * ring
    // Position and normal are the same vector on a sphere, which is why this is
    // a sphere: the shader's `down` comes off the normal and its blob off the
    // world position, and a boulder is round enough that the two agree.
    const blob = blobField(
      nx * R * MOSS.freq + 31.7, ny * R * MOSS.freq + 12.3, nz * R * MOSS.freq + 47.1)
    const down = Math.min(1, Math.max(0, 0.5 - ny * 0.5))
    creeps[i] = blob * (1 - MOSS.down) + down * MOSS.down
  }
  creeps.sort()

  return { creeps, min: creeps[0], max: creeps[N - 1] }
}

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
