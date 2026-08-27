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

import { buildRock, ROCK_TIERS, ROCK_LOD_AT, rockLodSize, ROCK_DEFAULTS, BOX_MARGIN } from '../src/props/rock.js'
import {
  buildRockBank, rockParams, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, ROCK_MESH_BAND_COUNT,
  ROCK_NAMES, ROCK_VARIANTS, SITES, TINTS, TINT_GAIN, rockImpostorLayer, rockImpostorLayers,
  rockShapeSeed, rockShapeId, parseRockShapeId,
} from '../src/props/rock-bank.js'
import { impostorCardExtents } from '../src/props/impostor.js'
import { Rocks } from '../src/v2/render/rocks.js'
import { pickProp } from '../src/v2/edit/pick.js'
import {
  LAYER, LAYER_COUNT, TILE_METRES, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, SNOW_ROCK_LAYERS, SNOW_WOOD_LAYERS, MOSS_LAYERS,
  ROCK_TILE_MEAN, buildTextureArray,
} from '../src/textures.js'
import {
  SNOW_ROCK, MOSS, mossCutFor, createPropMaterial, getSnowLine, getMossLine,
  setMossVary, getMossVary, setSnowVary, getSnowVary,
  setPropClock, getPropClock, PROP_FADE_SECONDS,
} from '../src/material.js'
import { RIM_AT } from '../src/v2/render/rim.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { readPng } from '../tools/props/png.mjs'

const SEEDS = Number(process.argv[2] ?? 200)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// Math.min(...a) over a placed-rock array is a stack overflow waiting for a bed
// to get wider, and it got one: widening crust to hold a full billboard band
// took its cap count past the argument limit and this gate died inside its own
// helper rather than reporting anything. Anything measuring PLACED rocks uses
// these; a spread is still fine over a fixed-length table.
const amin = (a) => { let m = Infinity; for (const v of a) if (v < m) m = v; return m }
const amax = (a) => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m }

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
// one ladder legal and what makes a tier change lose corners instead of
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
// whisker of T180 and T20 never will be, so one pooled number would either let
// a broken T80 hide behind T20's honest spread or fail T20 for being 20 faces.
// Also
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
// solid to miss, so the same 20 faces track it worse. Measured mean/worst at
// these defaults are 6.0/46 and 10.5/82 per cent of reach; the budgets below
// sit ~25% above that, so a real drift still trips them.
//
// What is NOT allowed to move with the art is bias, checked separately above at
// 8%, and it did not: -0.0 / -0.1 per cent. That is the split this section
// exists to keep. Every tier is still the same size as the rock it replaces; a
// T20 of a lumpier rock is simply a rougher account of its corners.
const SPREAD = { T80: [0.08, 0.6], T20: [0.13, 0.95] }

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

// THERE IS ONE LADDER AND EVERY ROCK IS ON IT. There used to be four, picked
// by size class, so a pebble's coarsest mesh and a crag's coarsest mesh were
// different objects and "what does this rock degrade to" had no single answer.
// Both of those are gone. What is left is a list that has to coarsen, because
// `update` walks it front to back and takes the first tier whose threshold it
// is inside -- a list that went fine, coarse, fine would make the middle band
// unreachable and nothing else would say so.
{
  let ok = ROCK_TIERS.length > 1
  for (let t = 1; t < ROCK_TIERS.length; t++) {
    if (!(ROCK_TIERS[t].faces < ROCK_TIERS[t - 1].faces)) ok = false
  }
  check(ok, 'ROCK_TIERS is one ladder, finest first and strictly coarsening',
    ROCK_TIERS.map((t) => `${t.name}/${t.faces}`).join(' > '))
}

// And the thresholds it is walked with. One per mesh tier, because the tier
// after the last one is the card and the card has no threshold of its own --
// it is where a rock lands when it has fallen off the end. Ascending for the
// same reason the faces descend: a shorter threshold behind a longer one is a
// band no rock can ever be in.
{
  let ok = ROCK_LOD_AT.length === ROCK_TIERS.length && ROCK_LOD_AT[0] > 0
  for (let i = 1; i < ROCK_LOD_AT.length; i++) {
    if (!(ROCK_LOD_AT[i] > ROCK_LOD_AT[i - 1])) ok = false
  }
  check(ok, 'ROCK_LOD_AT gives every mesh tier one ascending threshold, and the card none',
    `${ROCK_LOD_AT.join('/')} m per metre of ladder size, ${ROCK_TIERS.length} mesh tiers`)
}

// THE THRESHOLDS ARE PER METRE AND THAT IS THE POINT, so it is worth writing
// down what they mean in metres for the sizes this world actually contains --
// measured through the same rockLodSize the world measures instances through,
// so this is a check on the shipped function and not on a restatement of it.
// If this ever prints the same distances for two rocks, the size term has been
// lost.
{
  // Measured off the shipped bank rather than off literals, because the whole
  // question is what `measured` holds and a literal is free to be missing an
  // axis -- which is exactly how an earlier version of this gate went quietly
  // NaN when rockLodSize started reading `depth`.
  const bank = buildRockBank({ seed: 7, seeds: 1 })
  const of = (name) => {
    const s = bank.shapes.find((s) => s.name === name)
    if (!s) throw new Error(`check-rocks: no \`${name}\` in the bank`)
    return s.measured
  }
  const at = (m) => ROCK_LOD_AT.map((k) => `${(k * rockLodSize(m)).toFixed(1)}`).join('/')
  const cobble = of('cobble')
  const tor = of('tor')
  const cobbleCards = ROCK_LOD_AT[ROCK_LOD_AT.length - 1] * rockLodSize(cobble)
  const torLeavesFinest = ROCK_LOD_AT[0] * rockLodSize(tor)
  check(cobbleCards < torLeavesFinest,
    'a cobble is a billboard before a tor has left its finest mesh',
    `cobble ${at(cobble)} m then card; tor ${at(tor)}`)

  // THE SPEC THE LADDER WAS SET FROM, pinned so a later edit to ROCK_LOD_AT has
  // to notice it: a two-metre rock steps at 8, 15 and 50 m. Two metres of WHAT
  // is the content of rockLodSize -- of its longest axis -- so the probe is a
  // 2 m cube, whose longest axis is 2 m whichever axis you pick. Exact rather
  // than toleranced: with the longest axis as the basis there is no proportion
  // left for the answer to depend on, so a 2 m rock steps at exactly 8/15/50 or
  // the ladder has been retuned and this line is the one that should say so.
  const want = [8, 15, 50]
  const got = ROCK_LOD_AT.map((k) => k * rockLodSize({ width: 2, depth: 2, height: 2 }))
  check(got.every((d, i) => d === want[i]),
    'a two-metre rock steps at 8, 15 and 50 m',
    `${got.map((d) => d.toFixed(1)).join('/')} m, want ${want.join('/')}`)

  // THE LONGEST AXIS AND NOTHING ELSE, which is the whole content of
  // rockLodSize, and each of the three axes has to be able to win or it is not
  // a max. A shingle is a slab, so its height must NOT be the answer; a spire
  // is a column, so its width must not be. Checked as an identity against the
  // measurements rather than against remembered numbers, so the gate survives
  // the bank being regenerated.
  const shingle = of('shingle')
  const spire = of('spire')
  const longest = (m) => Math.max(m.width, m.depth, m.height)
  const okBasis = [shingle, spire, cobble, tor].every((m) => rockLodSize(m) === longest(m))
  check(okBasis && rockLodSize(shingle) > shingle.height && rockLodSize(spire) > spire.width,
    'a rock is measured by its longest axis, so a slab is not judged by its height nor a column by its width',
    `shingle ${rockLodSize(shingle).toFixed(2)} m (h ${shingle.height.toFixed(2)}), ` +
      `spire ${rockLodSize(spire).toFixed(2)} m (w ${spire.width.toFixed(2)})`)
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
  // The card is out of both lists, and that is a DELIBERATE omission rather than
  // a consequence of its geometry. It is built with `upNormal: true`, so its
  // normals are exactly (0, 1, 0) -- put it on either list and every distant
  // rock takes the full SNOW_ROCK_UP weight over its whole face, flat top and
  // all. Whether it should is open; what this pins is that nobody adds it by
  // accident and discovers the answer on a hillside.
  check(!SNOW_LAYERS.includes(LAYER.IMPOSTOR_ROCK) && !SNOW_ROCK_LAYERS.includes(LAYER.IMPOSTOR_ROCK),
    'the rock card is deliberately in neither list')

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
  // fixed patch size in the world and the question is how many of them fit
  // across a cut facet.
  //
  // WHAT perFacet MEANS ON ONE FACET. The artefact is a facet turning white as a
  // UNIT -- `up` is constant across a cut face, so if the noise cannot vary
  // WITHIN that face there is nothing left to break the snowline off the facet
  // edges, and the rim becomes a straight seam that gives away the cut. The
  // noise stops varying within a face when the face is no wider than one feature
  // of the field, which is perFacet = 1. A feature is not one lattice cell
  // though: BLOB_WARP drags the lookup 1.9 cells, so a warped blob's footprint
  // reaches getting on for two, and two cells across the facet is the honest
  // floor. That is where a facet is counted as lost, and it is unchanged.
  //
  // BUT THE ASSERTION IS AREA-WEIGHTED, AND MIN-OVER-BANK WAS TRIED FIRST AND
  // REJECTED. Taking the floor over the single narrowest facet in the bank reads
  // 1.07 and fails -- and it fails on SEED LUCK rather than on the field. The
  // narrowest facet swings from 7.46 cm to 16.74 cm across the bank seedings
  // measured, a factor of 2.2, and the seed that ships happens to hold the
  // friendliest minimum of the lot, so a min-based gate reports the kindest
  // worst case the table could have handed it and gets worse for free the next
  // time anybody reseeds. It is fragile in the other direction too: five of the
  // twenty-five variants (pebble, cobble, shingle, grit, cap) carry no cut facet
  // at ANY tier, so adding one more small angular rock to the table would drag a
  // min-based gate under the floor without a line of shader changing. And a
  // 17 cm chip flipping as a unit is not the artefact anyway -- that is what
  // snow does to a small ledge. A 1 m face flipping as a unit is. So what is
  // asserted is the SHARE OF CUT-FACET AREA on lost facets, which is the exposure
  // the eye actually gets, and the area-weighted number holds between 0.164% and
  // 0.329% across every seeding tried where the minimum swings by 2.2x.
  //
  // THE BOUND IS THE LEVEL A FURTHER DOUBLING BREACHES, and that is the whole of
  // its derivation. The failure worth catching here is not the blob size that
  // ships -- that was measured, costed and signed off -- it is somebody widening
  // the blobs AGAIN. Area share below the floor, over eight seedings of the bank
  // at three frequencies:
  //
  //     SNOW_FREQ 12.8 (7.8 cm patches)    0.000% .. 0.009%
  //     SNOW_FREQ  6.4 (15.6 cm, shipping) 0.164% .. 0.329%
  //     SNOW_FREQ  3.2 (31.3 cm patches)   2.394% .. 3.407%
  //
  // The bands do not overlap and the gap is not close: 7.3x separates the worst
  // seeding at 6.4 from the best one at 3.2. The bound is the GEOMETRIC MEAN of
  // those two edges: the level standing the same factor -- 2.70x -- above
  // everything the shipping frequency can produce as below everything the next
  // halving can. So it cannot fire on the widening that ships however the bank
  // is reseeded, and cannot survive the one after it. Nothing was rounded to get
  // there; if the bank changes shape enough to move those bands, re-measure them
  // and re-derive rather than nudging the literal.
  //
  // WHERE THE LOST AREA ACTUALLY IS, because 0.164% sounds like nothing and the
  // reason it is worth gating at all is that it is not spread thin: 96% of it
  // sits on LOD0, the tier you stand next to, and `shelf` and `lip` own 57% of
  // it between them -- both flat bedded plates whose strata ripples chop their cut
  // planes into narrow strips. The coarsest tier contributes next to none: a
  // T20 has so few facets left that hardly any of them land flat.
  //
  // THIS NUMBER IS A SPATIAL FREQUENCY AND IT DOES NOT COVER SNOW_ROCK_UP.
  // perFacet is blobs per facet; the up-weight is how much of the mask the noise
  // still gets to say once `up` has had its share, so raising it cannot move
  // perFacet by a thousandth. It is not an uncovered gap either -- do not add a
  // second amplitude gate here. The patchy-band check above ('is patchy over a
  // real stretch of the slider') is the ceiling on the up-weight: its band is
  // (1 - up + 2 * edgeMax) / cutSpan, which is exactly the noise's share of the
  // drift, and it turns red at up = 0.819. The rim-wander check follows it at
  // up = 0.859. At the 0.65 shipping now they read 41% of the travel against a
  // floor of 25, and 1.08 against a floor of 0.33.
  const patchM = 1 / SNOW_ROCK.freq
  const facets = cutFacets()
  const facetArea = facets.reduce((sum, f) => sum + f.area, 0)
  const lost = facets.filter((f) => f.chord / patchM < 2)
  const exposed = lost.reduce((sum, f) => sum + f.area, 0) / facetArea
  // Not the assertion any more, but still the first thing the next person will
  // want, so it stays in the line rather than being re-derived from scratch.
  const worst = facets.reduce((a, b) => (b.chord < a.chord ? b : a))
  check(exposed < 0.00887,
    'the facets too narrow for the blob field to break up are a sliver of the stone',
    `${(exposed * 100).toFixed(3)}% of cut-facet area on ${lost.length} of ${facets.length} facets`
    + `, ${(patchM * 100).toFixed(0)} cm patches; narrowest ${(worst.chord * 100).toFixed(0)} cm`
    + ` (${worst.name} ${worst.tier}) at ${(worst.chord / patchM).toFixed(2)} across`)

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

  // Every cut facet the bank ships, as `{ chord, area, name, tier }`. Hoisted
  // rather than inlined because the definition of "a facet" is three judgements
  // and all three belong next to each other rather than scattered through a
  // check.
  //
  // WHICH FACES COUNT. A cut facet is a flat-shaded one: rock.js hands all three
  // vertices of a fracture face the same face normal and blends every other face
  // toward its shell normals, and no variant in the bank runs `smooth` below
  // 0.86, so "the three vertex normals are identical" picks out the fracture
  // faces and nothing else. That also means a variant can have none -- a coarse
  // tier is often cut by planes that never pin all three corners of one
  // triangle -- and five of the twenty-five have none at any tier. Those rocks
  // cannot show this artefact, so contributing nothing is right, not a hole.
  //
  // WHAT A FACET IS. One cut plane makes one polygon and the polygon is what
  // flips as a unit, so faces are grouped by their PLANE rather than counted as
  // triangles. Two shards cut by the same plane at the same offset merge into
  // one group here where rock.js's own facet ids keep them apart; grouping by
  // connected component instead was measured and moves the area share by one
  // part in a thousand (0.164% to 0.165%), so the simpler grouping stands.
  //
  // AND HOW WIDE IT IS: the polygon's longest chord, against the polygon's real
  // triangulated area. The chord is the most generous of the widths on offer --
  // wider than the mean chord, wider than the root of the area -- and it is the
  // right one anyway, because a facet is inside one blob only if even its
  // longest span is. Area is summed per triangle rather than as chord squared,
  // because these polygons are mostly long thin strips and squaring the chord
  // would weight them by an area they do not have.
  function cutFacets() {
    // The same seeds section 7 builds, so both sections talk about the same rocks.
    const bank = buildRockBank({ seed: 7, seeds: 3 })
    const out = []
    const seen = new Set()
    for (const shape of bank.shapes) {
      for (const geo of shape.tiers) {
        // `tiers` is padded by repeating the coarsest -- see buildRockBank.
        if (seen.has(geo)) continue
        seen.add(geo)
        // ...and the last band is the CARD, which is two triangles of photograph
        // with no cut faces on it at all, so it is not a subject of this check.
        // Tested for positively rather than reached past with `?.`: a tier that
        // is neither a mesh nor a card is a broken bank, and the deref at the
        // bottom of this loop has to keep throwing on it.
        if (geo.userData.impostor) continue
        const pos = geo.attributes.position.array
        const nrm = geo.attributes.normal.array
        const planes = new Map()
        for (let f = 0; f < pos.length / 3; f += 3) {
          const nx = nrm[f * 3]
          const ny = nrm[f * 3 + 1]
          const nz = nrm[f * 3 + 2]
          let flat = true
          for (let j = 1; j < 3; j++) {
            if (Math.abs(nrm[(f + j) * 3] - nx) > 1e-6) flat = false
            if (Math.abs(nrm[(f + j) * 3 + 1] - ny) > 1e-6) flat = false
            if (Math.abs(nrm[(f + j) * 3 + 2] - nz) > 1e-6) flat = false
          }
          if (!flat) continue
          const d = nx * pos[f * 3] + ny * pos[f * 3 + 1] + nz * pos[f * 3 + 2]
          const key = `${nx.toFixed(3)},${ny.toFixed(3)},${nz.toFixed(3)},${d.toFixed(3)}`
          if (!planes.has(key)) planes.set(key, [])
          const verts = planes.get(key)
          for (let j = 0; j < 3; j++) {
            verts.push(pos[(f + j) * 3], pos[(f + j) * 3 + 1], pos[(f + j) * 3 + 2])
          }
        }
        for (const v of planes.values()) {
          let chord = 0
          for (let i = 0; i < v.length; i += 3) {
            for (let j = i + 3; j < v.length; j += 3) {
              const c = Math.hypot(v[i] - v[j], v[i + 1] - v[j + 1], v[i + 2] - v[j + 2])
              if (c > chord) chord = c
            }
          }
          let area = 0
          for (let t = 0; t < v.length; t += 9) {
            const ux = v[t + 3] - v[t], uy = v[t + 4] - v[t + 1], uz = v[t + 5] - v[t + 2]
            const wx = v[t + 6] - v[t], wy = v[t + 7] - v[t + 1], wz = v[t + 8] - v[t + 2]
            area += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)
          }
          out.push({ chord, area, name: shape.name, tier: geo.userData.rock.tier })
        }
      }
    }
    for (const geo of bank.geometries) geo.dispose()
    // Not a soft failure: if the bank ever ships without a single flat face the
    // check above is dividing by zero and measuring nothing, and it has to say so
    // rather than quietly reporting a share of NaN.
    if (out.length === 0) {
      throw new Error('check-rocks: the bank ships no cut facet at all, so there is nothing for the blob field to break up')
    }
    return out
  }
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
  // AND IT IS RECTANGULAR BECAUSE EVERY SHAPE REALLY BUILDS EVERY TIER, not
  // because a short ladder was padded out by repeating its last entry. That
  // padding is what the size classes used to need -- a pebble shipped two
  // meshes and had its third mesh band aliased to its second -- and the check
  // that lived here asserted the aliasing. There is nothing left to alias, so
  // the promise flips: every mesh band of every shape is a DISTINCT geometry,
  // which is also what makes the triangle counts in the table below mean
  // anything. Held on the mesh bands alone; the card is a distinct object per
  // shape by construction and would flatter the count.
  {
    let aliased = null
    for (const s of bank.shapes) {
      const mesh = s.tiers.slice(0, ROCK_MESH_BAND_COUNT)
      if (new Set(mesh).size !== ROCK_MESH_BAND_COUNT) aliased = s.name
    }
    check(aliased === null, 'every shape builds all three mesh tiers for itself -- no padding by reference',
      aliased ? `${aliased} repeats a tier` : `${bank.shapes.length} shapes x ${ROCK_MESH_BAND_COUNT} distinct meshes`)
  }
  const unique = new Set(bank.shapes.flatMap((s) => s.tiers)).size
  check(unique === bank.geometries.length, 'geometries and tier references agree', `${unique} in the arena`)

  // The authored sizes have to stay separated or the beds below overlap: an
  // underfoot rock that is secretly 2 m across would be scattered at pebble
  // density.
  const span = (n) => bank.shapes.find((s) => s.name === n).measured
  // A PEBBLE IS A RIVER STONE AND NOT A SPECK. It is authored at 0.55 m -- five
  // times what it was -- because at 0.11 m a riverbed read as dust. The bound is
  // two-sided: under the floor the bed is gravel you cannot resolve, and since
  // the LOD thresholds now scale with measured width, a rock that small is on
  // its billboard from 9 m away and the mesh tiers are wasted on it. The ceiling
  // keeps it out of `roundstone` territory, where it would be scattered at
  // underfoot density.
  check(span('pebble').height > 0.12 && span('pebble').height < 0.4,
    'a pebble is river-stone-sized -- a stone you step around', `${span('pebble').height.toFixed(2)} m tall`)
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
  // open variant is measured at the FINEST tier, because that is where the
  // faces are: a T20 shell has so few faces left that hardly any of them can
  // land flat, and holding the coarse end to a fraction would be asking the
  // compaction for something the tier cannot give.
  const drops = open.map((n) => {
    const p = rockParams(n, 31)
    const g = buildRock({ ...p, tier: 0 })
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
  // 68 degrees: a real WALL, and the only world here that is one. `cliff` above
  // is the apron -- past CLIFF_SLOPE_DEG and inside every bed's slope limit, so
  // every bed places on it. Nothing about a face is tested by a world all five
  // beds are happy on, and the crust bed exists precisely for the ground the
  // others refuse.
  const steep = world(60, 2.5, 9999, null)

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
  check(forestRocks.beds.length === 6, 'six beds', forestRocks.beds.map((b) => b.cfg.name).join(', '))
  check(
    new Set(forestRocks.beds.map((b) => b.batch.material)).size === 1,
    'one material across all six batches',
    'every bed billboards the same 25-layer card run, so one program still serves them'
  )

  // THE CARD'S BOUNDS HAVE TO HOLD THE SPIN, and this is the gate on the bug
  // that made rocks blink in and out as you turned your head. BatchedMesh culls
  // each instance against the bounding sphere of the geometry it is drawing,
  // and material.js's spherical billboard moves the card's vertices AFTER that
  // test, rebuilding each one as `x * screenRight + y * screenUp` about the
  // FOOT. So a vertex can end up anywhere on a sphere of radius hypot(x, y)
  // centred on the foot, and any sphere smaller than that culls a card that is
  // still on screen.
  //
  // Checked against the spin itself rather than against a formula: take the
  // card's real vertices, spin them through a basis the shader could actually
  // be handed, and demand the authored sphere still contains them. A tight
  // sphere around the unspun quad fails this by roughly its own radius again.
  {
    const worst = []
    for (const shape of forestRocks.bank.shapes) {
      const card = shape.tiers[shape.tiers.length - 1]
      const pos = card.attributes.position.array
      const sph = card.boundingSphere
      let over = 0
      // Eight bases spread over the sphere, standing in for every camera the
      // player could have. Orthonormal by construction, as the view matrix rows
      // the shader reads are.
      for (let a = 0; a < 8; a++) {
        const th = (a / 8) * Math.PI * 2
        const ph = (a % 3) * 0.7
        const right = new THREE.Vector3(Math.cos(th), 0, Math.sin(th))
        const up = new THREE.Vector3(-Math.sin(th) * Math.sin(ph), Math.cos(ph), Math.cos(th) * Math.sin(ph))
        for (let k = 0; k < pos.length; k += 3) {
          const v = right.clone().multiplyScalar(pos[k]).addScaledVector(up, pos[k + 1])
          over = Math.max(over, v.distanceTo(sph.center) - sph.radius)
        }
      }
      worst.push({ name: shape.name, over })
    }
    worst.sort((a, b) => b.over - a.over)
    check(worst[0].over <= 1e-4,
      "every rock card's bounding sphere contains the card at every angle the spin can reach",
      `worst overhang ${worst[0].over.toFixed(4)} m on ${worst[0].name}, over ${worst.length} shapes`)
  }

  // EVERY VARIANT WEARS ITS OWN PHOTOGRAPH, which is the promise the 25-layer
  // IMPOSTOR_ROCK run was spent on. This used to be one layer holding one
  // `boulder`, stretched onto all twenty-five quads: measured over the bank the
  // stretch ran 0.29x on a `capslab` to 4.00x on a `spire`, so every distant
  // rock that was not boulder-shaped was drawn as a boulder crushed or pulled
  // into its outline. The three ways that can silently come back are a card
  // built against the run's BASE (the old constant, which still resolves and
  // still draws -- as a `pebble` now), two variants colliding on one slice, and
  // the material's spin list drifting out of step with the layers the cards
  // actually carry. All three are checked here rather than left to the eye,
  // because all three look like "the far rocks are a bit off" and nothing else.
  {
    const cards = forestRocks.bank.shapes.map((sh) => ({
      name: sh.name,
      seed: sh.seed,
      want: rockImpostorLayer(sh.name),
      got: [...new Set(sh.tiers[ROCK_BAND_COUNT - 1].attributes.texLayer.array)],
    }))
    const wrong = cards.filter((c) => c.got.length !== 1 || c.got[0] !== c.want)
    check(wrong.length === 0,
      "every shape's card is drawn from its OWN variant's atlas layer",
      wrong.length === 0
        ? `${cards.length} shapes over ${ROCK_NAMES.length} variants, layers ${LAYER.IMPOSTOR_ROCK}..${LAYER.IMPOSTOR_ROCK + ROCK_NAMES.length - 1}`
        : `${wrong[0].name}#${wrong[0].seed} wants ${wrong[0].want}, carries ${wrong[0].got.join('/')}`)

    const perVariant = ROCK_NAMES.map(rockImpostorLayer)
    check(new Set(perVariant).size === ROCK_NAMES.length && Math.max(...perVariant) < LAYER_COUNT,
      'and no two variants share a slice, and the run fits the atlas',
      `${ROCK_NAMES.length} distinct layers, top ${Math.max(...perVariant)} of ${LAYER_COUNT}`)

    // The bake writes through `rockImpostorLayer` and the card geometry reads
    // through it, so those two agree by construction. The material does NOT --
    // it is handed `rockImpostorLayers()` separately, and material.js spins a
    // quad only if its layer is in that list. Miss one and that variant's card
    // is a fixed single vertical-normal plane, which is the one arrangement
    // that vanishes edge-on instead of merely flattening.
    const spun = new Set(rockImpostorLayers())
    const unspun = cards.filter((c) => !spun.has(c.want))
    check(unspun.length === 0,
      'and every one of those layers is in the list the material is told to spin',
      unspun.length === 0 ? `${spun.size} layers spun` : `${unspun[0].name} on layer ${unspun[0].want} would never turn`)
  }

  // THE CARD REACHES AN INSTANCE, which is the one thing a bake and a geometry
  // contract cannot tell you between them. rock-bank.js builds a 2-triangle
  // up-normal quad for every shape and check-props confirms it; what nobody
  // confirms is that a BED ever hands one out. `tierTris` is the table `update`
  // indexes to pick geometry, so a coarsest slot reading 2 triangles is a bed
  // that will really draw a card at range, and one reading 8 or 20 is a bed
  // whose card is sitting unreachable in the arena.
  //
  // ALL OF THEM, now. The crust bed used to decline it -- first because the
  // cylindrical billboard spin laid a photograph flat against a cliff face, and
  // after the spherical spin fixed that, because its own per-bed bands put its
  // whole outer annulus on the coarsest mesh and a card would have bought
  // nothing there. Both reasons are gone with the per-bed bands themselves: a
  // 6 m cap is on its card past 480 m, which is inside the bed's reach for the
  // biggest caps and outside it for the rest, and the bed no longer gets to
  // decide that -- the rock's size does.
  const coarse = ROCK_BAND_COUNT - 1
  check(
    forestRocks.beds.every((b) => b.tierTris[coarse].every((t) => t === 2)),
    'every bed really does draw a 2-triangle card at their outermost band',
    forestRocks.beds.map((b) => `${b.cfg.name} ${new Set(b.tierTris[coarse]).size === 1 ? b.tierTris[coarse][0] : '?'}`).join('  ')
  )

  // AND EVERY BED READS THE SAME LADDER. There is no per-bed band list any
  // more: `bands` is gone from the configs and ROCK_LOD_AT is the only ladder
  // in the file, so a bed cannot be one band short and cannot quietly hold a
  // different one from its neighbour. What CAN still differ is where each bed's
  // rocks fall on it, which is the point -- so the promise checked is that the
  // tier tables are all the same shape and all four slots wide.
  check(
    forestRocks.beds.every((b) => b.tierIds.length === ROCK_BAND_COUNT && b.tierTris.length === ROCK_BAND_COUNT),
    'every bed carries the full four-slot tier table and reads one shared ladder',
    `ROCK_LOD_AT ${ROCK_LOD_AT.join('/')} m per metre of ladder size`
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
  // A BAND AND NOT A FLOOR, and the ceiling is the half that was missing. The
  // ladder wants small stones to be commoner than boulders, which the floor
  // says. But this check read `> 4x` and passed just as quietly at FORTY-ONE to
  // one, which is what a wood actually held until the underfoot bed's non-river
  // rates were cut: a stone every 2.4 m against a boulder every 15 m, every one
  // of those specks costing a full instance, and the whole thing reading as
  // gravel sprinkled over the ground rather than as stones lying in a wood. A
  // one-sided bound cannot see that -- it is green at the ratio that is right
  // and green at the ratio that ruined it. So both ends are named, and the
  // floor comes down to 2 because the ratio the config now asks for is about 3
  // inside 40 m (0.0175/m2 against 0.0042, times the two beds' different
  // thinning) and a floor of 4 sitting a hair under the real value is a gate
  // that fails on a seed change rather than on a mistake.
  check(near[0] > near[1] * 2 && near[0] < near[1] * 12,
    'small stones outnumber boulders underfoot, without carpeting the wood in gravel',
    `${near[0]} vs ${near[1]} inside 40 m, ${(near[0] / Math.max(1, near[1])).toFixed(1)}x`)
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

  // --- the pools -------------------------------------------------------------
  //
  // Every bed crossed with every environment it claims to serve has to be
  // furnished. Without this a whole size class silently vanishes on one kind of
  // ground -- the failure mode where a cliff has pebbles and spires on it and
  // nothing in between -- and nothing throws, because a bed with an empty pool
  // just places nothing.
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
  //
  // WHICH POOL IS MEASURED DEPENDS ON WHERE THE BED PLACES. `byEnv` holds the
  // untagged shapes and `bySite` the ones tagged `foot` or `brow`, and an
  // ordinary bed stands on featureless ground almost everywhere -- so `byEnv`
  // alone is what a walk through that environment actually shows you, and a
  // site pool cannot make up for a thin one. A `footOnly` bed is the exact
  // opposite: it rejects every candidate that is not at the foot of a face, so
  // the only ground it ever stands on is ground where BOTH pools are live, and
  // measuring it on `byEnv` alone would be measuring a place it never goes. The
  // scree bed is the case -- one untagged chip against two tagged blocks, which
  // is a three-shape pile and not a single rock repeated.
  //
  // AND A DECLARED ZERO IS NOT A HOLE. A bed whose `envDensity` is 0 for an
  // environment has said it places nothing there on purpose, so an empty pool
  // is the intent rather than the bug -- the scree bed offers a wood and a
  // riverbed nothing, because talus at the foot of a cliff is the whole reason
  // it exists. The exemption is tied to that declaration and not to emptiness,
  // so a pool that empties out while the density stays positive still fails.
  const POOL_FLOOR = { river: 2, forest: 2, cliff: 2, peak: 3 }
  let thin = 0
  const census = []
  for (const bed of forestRocks.beds) {
    for (const env of ENVIRONMENTS) {
      const plain = new Set(bed.byEnv.get(env).map((i) => bed.shapes[i].name)).size
      const site = new Set(SITES.flatMap((s) => bed.bySite.get(`${env}|${s}`).map((i) => bed.shapes[i].name))).size
      const offered = bed.cfg.footOnly ? plain + site : plain
      const serves = bed.cfg.envDensity[env] > 0
      if (serves && offered < POOL_FLOOR[env]) thin++
      census.push(`${bed.cfg.name[0]}/${env} ${serves ? `${plain}${site ? `+${site}` : ''}` : '-'}`)
    }
  }
  check(thin === 0, 'every bed offers a real choice on every ground it claims, and the peak the widest',
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

    // --- and the pile itself, in metres --------------------------------------
    //
    // THE CHECK ABOVE IS A RATIO AND A RATIO IS NOT WHAT ANYONE LOOKS AT. It
    // says the foot of a cliff carries twice what the ground beside it does,
    // measured inside the boulders bed, and it was green while the actual sight
    // was a rock every 10.6 m -- which is not a pile, it is an empty hillside
    // with the occasional stone on it. Doubling that to one every 10.6 m from
    // one every 15 m is arithmetically a doubling and visually nothing. The
    // absolute figure was always the thing being asked for and nothing here was
    // measuring it, so the bed could be retuned to a number that reads as bare
    // ground and every line in this file would stay green.
    //
    // So: spacing in metres, across EVERY bed rather than inside one, because
    // what stands at the foot of a cliff is whatever any bed put there and the
    // scree bed now puts down most of it. Six metres is the bound -- at that
    // spacing a 2 m block has a little over its own width of clear ground
    // around it, which is a talus field seen from a distance rather than a
    // scatter, and the bed currently sits comfortably inside it.
    {
      const R = 140
      const isFoot = (x, z) => r.beds[1]._relief(x, z, ridge.field.heightAt(x)) === 'foot'
      let footN = 0
      const sizes = []
      for (const b of r.beds) {
        for (const t of b.tiles.values()) {
          for (let k = 0; k < t.n; k++) {
            const id = t.ids[k]
            const x = b.instX[id]
            const z = b.instZ[id]
            if (x * x + z * z > R * R || !isFoot(x, z)) continue
            footN++
            sizes.push(b.shapes[b.shapeAt[id]].measured.width * b.instScale[id])
          }
        }
      }
      let footA = 0
      for (let x = -R; x <= R; x += 2) {
        for (let z = -R; z <= R; z += 2) {
          if (x * x + z * z <= R * R && isFoot(x, z)) footA += 4
        }
      }
      const spacing = Math.sqrt(footA / Math.max(1, footN))
      check(spacing < 6, 'and the foot of a cliff is a pile you could not walk through, not a hillside with rocks on it',
        `${footN} rocks over ${Math.round(footA)} m2 of foot, one every ${spacing.toFixed(1)} m`)

      // AND THEY ARE THE SIZE THAT WAS ASKED FOR: half a metre to three. A pile
      // of gravel at the right spacing would pass the line above and be the same
      // mistake in a smaller size class, so the median is asserted too -- not the
      // extremes, which one lucky roll can supply.
      sizes.sort((a, b) => a - b)
      const med = sizes[sizes.length >> 1]
      const big = sizes.filter((s) => s >= 0.5 && s <= 3).length / sizes.length
      check(med > 0.5 && big > 0.6, 'and it is made of rocks half a metre to three across',
        `median ${med.toFixed(2)} m, ${(big * 100).toFixed(0)}% inside 0.5-3 m, ` +
        `range ${sizes[0].toFixed(2)}-${sizes[sizes.length - 1].toFixed(2)} m`)
    }
    r.dispose()
  }

  // --- the size a bed actually places, in metres ----------------------------
  //
  // NOTHING HERE MEASURED A SIZE UNTIL THE FOOT-SPACING BLOCK ABOVE, and that
  // one measures a pile rather than a bed. `sizeByEnv` is the reason it matters
  // now: a bed carrying it is authored in METRES per environment and divides
  // back through the shape's measured width, so `scale` no longer exists on it
  // and the authored `size` in rock-bank.js has stopped controlling world size
  // altogether -- it only picks the LOD ladder. That is a real hazard: a bank
  // edit can change how big a rock LOOKS to the ladder while the ground keeps
  // placing exactly the same metres, and a bank edit can also leave the metres
  // untouched while quietly changing which ladder pays for them. Neither shows
  // up anywhere else in this file.
  //
  // The spans are the ask, verbatim, so they are asserted as the ask: the whole
  // population inside the range, not a median with tails hanging out of it.
  // Because instScale IS the resolved scale and world width is measured.width
  // times it, the arithmetic is exact and the bound can be too -- a hair of
  // slack only for the float round trip.
  {
    const widths = (rocks, bedName) => {
      const bed = rocks.beds.find((b) => b.cfg.name === bedName)
      if (!bed) throw new Error(`check-rocks: no ${bedName} bed`)
      const out = []
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          out.push(bed.shapes[bed.shapeAt[id]].measured.width * bed.instScale[id])
        }
      }
      return out
    }
    const span = (a) => `${amin(a).toFixed(2)}-${amax(a).toFixed(2)} m over ${a.length}`
    const inside = (a, lo, hi) => a.length > 0 && amin(a) >= lo - 1e-4 && amax(a) <= hi + 1e-4

    // A WALL IS THE CRUST BED'S GROUND ALONE. On 68 degrees the underfoot bed
    // (42), the boulders and the giants have all bowed out, so whatever covers
    // a real face is whatever the crust bed puts there -- which is the reason
    // the bed was given a slope limit nothing else has. Asserted as an
    // exclusive: if another bed ever starts reaching a wall, the coarse cover
    // stops being coarse and this is the line that notices.
    const steepRocks = build(steep)
    const live = steepRocks.stats.beds.filter((b) => b.placed > 0).map((b) => b.name)
    check(live.length === 1 && live[0] === 'crust',
      'on a 68-degree wall the crust bed is the only thing left standing',
      live.join(' ') || 'nothing placed at all')

    // AND IT IS COARSE COVER, 1 to 10 m, with NO SMALL END. The old range
    // bottomed out near a third of a metre and a third of a metre of stone on a
    // cliff is invisible from anywhere you can stand to look at the cliff -- it
    // was instance memory and triangles spent on a speck. The floor is the half
    // of this that a median could never hold, so the whole population is bound.
    const face = widths(steepRocks, 'crust')
    check(inside(face, 1, 10), 'and every cap on it is between 1 and 10 m across -- no specks',
      span(face))
    // The other half of "randomly vary": a bed that placed 5 m caps and nothing
    // else would satisfy the line above exactly. Both ends of the span have to
    // be reached, or the roll has stopped being a roll.
    check(amin(face) < 1.5 && amax(face) > 9,
      'and the range is really used, not clustered on one size',
      `median ${[...face].sort((a, b) => a - b)[face.length >> 1].toFixed(2)} m`)
    steepRocks.dispose()

    // THE SAME BED ON A LAKE FLOOR IS A DIFFERENT SIZE, which is the whole
    // reason `sizeByEnv` exists rather than one `scale` pair. A stone you would
    // step on is 0.5 m and one you have to step OVER is 6; the pebble stamps in
    // litter.js carry everything finer than the bottom of that.
    const bedRock = widths(riverRocks, 'crust')
    check(inside(bedRock, 0.5, 6), 'the same bed on a lake floor places 0.5-6 m stones instead',
      span(bedRock))
    // AND THE TOP HALF OF THAT BAND IS REALLY REACHED. The band was doubled to
    // 6 m to make a lake floor varied rather than uniform, and a range whose top
    // never comes up is the same uniform floor with a bigger number written next
    // to it -- which is exactly what widening it was meant to stop.
    check(amax(bedRock) > 4.5 && amin(bedRock) < 1.2,
      'and a lake floor uses the whole of that band, so the widening did something',
      `${amin(bedRock).toFixed(2)}-${amax(bedRock).toFixed(2)} m over ${bedRock.length}`)

    // AND THE RIVERBED HAS NO GRAVEL LEFT IN GEOMETRY. The underfoot bed used
    // to run at full rate underwater, which put a half-metre stone every 2.9 m
    // across every lake floor in the world -- the densest geometry anywhere and
    // the least worth drawing, since it is seen through moving water. Its river
    // rate is now a twelfth of that and its river SIZE is boulders, 0.3-2 m. If
    // this range ever slides back down, the gravel is back.
    const wet = widths(riverRocks, 'underfoot')
    check(inside(wet, 0.3, 2), 'and the underfoot bed puts 0.3-2 m boulders in a riverbed, not gravel',
      span(wet))
    // On dry ground the same bed is what it always was, which is what says the
    // riverbed change was a river change and not a global one.
    const dry = widths(forestRocks, 'underfoot')
    check(inside(dry, 0.25, 1), 'while on dry ground it is still 0.25-1 m stones', span(dry))
  }

  // --- the bed that only exists underwater ---------------------------------
  //
  // `sunken` is the first bed whose whole definition is a NEGATIVE about where
  // it may go, so what has to be gated is the boundary rather than the contents:
  // the interesting failure is not "it placed no boulders", which the traverse
  // above would catch, but "it placed them on the beach as well", which nothing
  // else here would notice. `_envAt` is why that is a live risk -- it hands the
  // river environment to any ground within SHORE_RISE of the surface, so the dry
  // shingle beside a lake is `river` too and an ordinary `envDensity` entry
  // would furnish it.
  {
    // A SHORELINE, which no fixture above is: every world in this file is either
    // wholly dry or wholly drowned, and a bed that only exists on one side of a
    // line cannot be tested on a world with no line in it. Flat ground at 60 m
    // with the water reaching exactly half of it, so a straight count says which
    // side each rock landed on.
    const shore = {
      field: {
        scatterAt: (x, z, cell, out) => {
          if (!(cell > 0)) throw new Error('scatterAt needs a positive cell')
          out.h = 60
          out.tan = 0
          return out
        },
        heightAt: () => 60,
        snowLineAt: () => 9999,
        bands: { altLo: 0, altSpan: 900 },
      },
      // The BANK is dry and inside SHORE_RISE of the water, which is the case
      // that matters: `levelAt` answers everywhere, so `_envAt` calls the whole
      // world `river` and only `isSubmerged` separates the two halves.
      water: { levelAt: () => 60.8, isSubmerged: (x) => x < 0 },
    }
    const shoreRocks = build(shore)
    const bed = shoreRocks.beds.find((b) => b.cfg.name === 'sunken')
    // Position and size in one walk. `instScale` times the shape's own measured
    // width is what `sizeByEnv` resolves to, which is the same reading the crust
    // block above takes; the x of the instance matrix is which side of the
    // waterline it landed on.
    const xs = []
    const sunk = []
    const mat = new THREE.Matrix4()
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        bed.batch.getMatrixAt(id, mat)
        xs.push(mat.elements[12])
        sunk.push(bed.shapes[bed.shapeAt[id]].measured.width * bed.instScale[id])
      }
    }
    check(xs.length > 200, 'the sunken bed fills a lake floor it is given half of',
      `${xs.length} stones`)
    check(xs.every((x) => x < 0), 'and not one of them is on the dry bank beside it',
      `${xs.filter((x) => x >= 0).length} of ${xs.length} out of the water, ` +
      `furthest ashore ${Math.max(...xs).toFixed(1)} m`)

    // The size it was asked for, and both ends of it. A bed whose stones all
    // came out at one size would be the crust bed's rippled sheet again in a
    // different shape -- the point of the range is that you swim past a stone
    // you could stand on and then past one you could not climb.
    check(amin(sunk) >= 0.5 - 1e-4 && amax(sunk) <= 5 + 1e-4,
      'and every one of them is a 0.5-5 m boulder',
      `${amin(sunk).toFixed(2)}-${amax(sunk).toFixed(2)} m over ${sunk.length}`)
    check(amax(sunk) > 4 && amin(sunk) < 1,
      'and the band is really used, so a lake floor is not one stone repeated',
      `${amin(sunk).toFixed(2)}-${amax(sunk).toFixed(2)} m over ${sunk.length}`)

    // SPARSE AGAINST THE FLOOR IT STANDS ON, which is the difference between
    // something you come across and something you wade through. The crust caps
    // are the lake floor's cover and are meant to be everywhere; these are meant
    // to be events, and an order of magnitude between the two counts is what
    // says so in a number rather than in a comment.
    const caps = shoreRocks.beds.find((b) => b.cfg.name === 'crust')
    let capN = 0
    for (const t of caps.tiles.values()) capN += t.n
    check(capN > xs.length * 10, 'and it is an order of magnitude sparser than the caps under it',
      `${xs.length} boulders against ${capN} caps on the same floor`)
    shoreRocks.dispose()
  }

  // AND THE FLAG THAT CANNOT MEAN ANYTHING IS REFUSED. `submergedOnly` without
  // `allowSubmerged` is a bed that requires water and is not allowed water, and
  // the way that fails without this is an empty lake and no error anywhere.
  // `RockBed` and `BEDS` are both private to rocks.js and are meant to stay
  // that way, so this reads the source rather than widening the module's API to
  // hold a test -- the same trick check-deadwood uses on `cardAzimuth`. What is
  // being asserted is that the guard exists AND is written the right way round;
  // the pair reversed would throw on every bed in the file, which the traverse
  // above would catch instantly, so between the two the invariant is covered.
  {
    const src = readFileSync(new URL('../src/v2/render/rocks.js', import.meta.url), 'utf8')
    check(/if \(cfg\.submergedOnly && !cfg\.allowSubmerged\) \{\s*\n\s*throw new Error/.test(src),
      'a bed that demands water and is refused it throws at build instead of placing nothing')
    // AND THE PLACEMENT GATE READS BOTH DIRECTIONS off one water lookup. The
    // failure this catches is the cheap rewrite -- dropping back to
    // `!cfg.allowSubmerged && isSubmerged(...)` -- which leaves `submergedOnly`
    // as a field nothing reads and puts boulders on the beach with every gate
    // above still green, because the bed would then place MORE rather than less.
    check(/isSubmerged\(x, z, h\) !== Boolean\(cfg\.submergedOnly\)/.test(src),
      'and the water test in _growTile is the one that can reject a DRY site too')
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
      min: amin(a), max: amax(a), mean: a.reduce((x, y) => x + y, 0) / a.length, n: a.length,
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

    // THE ONE ALGEBRAIC CLAIM THE SPHERICAL CARD RESTS ON. billboardVertex's
    // spherical branch composes the card in WORLD space and hands the result
    // back through `bbM-transpose / s2`, which is the inverse of the instance's
    // upper 3x3 ONLY while the scale is uniform. rocks.js writes `_s.set(scale,
    // scale, scale)` today, so it is -- and if a bed ever starts stretching one
    // axis (an `elongate` applied at placement rather than in the mesh, say)
    // the identity fails, the inverse is wrong, and every distant rock in that
    // bed is a sheared photograph. Nothing about that throws and nothing about
    // it is visible from a node gate except this.
    //
    // Measured on the CLIFF, because that is where the leans are: the crust and
    // the tilting beds compose a ground tilt on top of the yaw, and a rotation
    // is exactly where a transpose stops being an inverse if a scale is hiding
    // in it. The identity is checked as a matrix product rather than by reading
    // the scale back out, which is the same check the shader is doing.
    {
      const m = new THREE.Matrix4()
      const M = new THREE.Matrix3()
      const T = new THREE.Matrix3()
      let worst = 0
      let n = 0
      for (const bed of cliffRocks.beds) {
        for (const t of bed.tiles.values()) {
          for (let k = 0; k < t.n; k++) {
            bed.batch.getMatrixAt(t.ids[k], m)
            M.setFromMatrix4(m)
            const e = M.elements
            const s2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2]
            T.copy(M).transpose().multiplyScalar(1 / s2)
            T.multiply(M)
            const I = T.elements
            for (let r = 0; r < 3; r++) {
              for (let c = 0; c < 3; c++) {
                worst = Math.max(worst, Math.abs(I[c * 3 + r] - (r === c ? 1 : 0)))
              }
            }
            n++
          }
        }
      }
      check(n > 0 && worst < 1e-4,
        'every rock instance has a uniform scale, so the card shader\'s transpose really is an inverse',
        `worst departure from identity ${worst.toExponential(1)} over ${n} instances`)
    }
  }

  // The pool bound is the only thing between the densest ground in the world and
  // a thrown scatter, and it throws rather than degrading. Walk the camera so
  // tiles are grown at every quantised level, on the ground that places the MOST
  // rocks.
  //
  // THREE WORLDS, BECAUSE NO SINGLE ONE LOADS EVERY BED. The endless cliff is
  // where the ordinary beds run flat out at envDensity 1.0 -- but it is a
  // UNIFORM slope, and a uniform slope is not the foot of anything, so the
  // `footOnly` scree bed places exactly nothing on it. This check ran on the
  // cliff alone and reported `scree 0/17039`: a green line, against a bound that
  // had never once been approached, for the bed with by far the largest pool in
  // the world. A bound asserted where it cannot fail is not a bound. The ridge
  // is the second -- it is the only world here with a break of slope in it, so
  // it is the only one that loads the scree bed at all. The river is the third,
  // and it is here for the same reason one step further: `sunken` is
  // `submergedOnly`, so it is dead ground on every world with dry feet, and the
  // two above are both dry.
  //
  // AND EVERY BED HAS TO PLACE SOMETHING ACROSS THE SET, which is the assertion
  // that keeps this honest as beds are added. Without it a new bed that never
  // fires -- a bad `envDensity`, a site tag nothing rosters, a `footOnly` flag
  // on a bed whose world has no feet, a `submergedOnly` flag on a bed whose
  // world has no water -- sails through with used = 0, because zero is less
  // than every bound there is.
  {
    const worlds = { cliff: build(cliff), ridge: build(ridge), river: build(river) }
    for (const r of Object.values(worlds)) {
      // `place` AND THEN `update`, and the `place` is not belt-and-braces.
      // `update` drains the build queue against a WALL-CLOCK budget split
      // across the beds -- about 0.3 ms each -- so what it manages to grow in
      // twelve steps is a measure of this machine's load, not of the scatter.
      // The scree bed is the one that exposed it: at its density a single tile
      // costs on the order of a millisecond to grow, so under a parallel build
      // this assertion read `scree 0` on one run in two and passed on the rest.
      // A flaky gate is worse than no gate, and the flake was in the harness
      // rather than the subject. `place` drains the queue outright, so the
      // counts below describe what the beds PLACE; `update` still runs after it
      // for the LOD and eviction work the assertion sits downstream of.
      for (let i = 1; i <= 12; i++) {
        r.place(i * 37, i * 91)
        r.update(i * 37, 61.6, i * 91)
      }
    }
    const peak = new Map()
    for (const [name, r] of Object.entries(worlds)) {
      for (const b of r.stats.beds) {
        const best = peak.get(b.name)
        if (!best || b.used > best.used) peak.set(b.name, { ...b, world: name })
      }
    }
    const beds = [...peak.values()]
    check(beds.every((b) => b.used <= b.pool), 'the pool bound holds after a traverse of all three worlds',
      beds.map((b) => `${b.name} ${b.used}/${b.pool} (${b.world})`).join('  '))
    check(beds.every((b) => b.used / b.pool < 0.95), 'and holds with headroom',
      `worst ${(Math.max(...beds.map((b) => b.used / b.pool)) * 100).toFixed(0)}% full`)
    check(beds.every((b) => b.used > 0), 'and every bed was actually exercised by one of them',
      beds.map((b) => `${b.name} ${b.used}`).join('  '))

    // NO ROCK IS THINNED AWAY WHILE IT IS STILL A MESH, which is the promise the
    // whole ladder is for and the one that used to be broken: thinning is keyed
    // on a rank the rock drew and knows nothing about how big the rock is, so a
    // bed with a short `fullRadius` and a big rock in it dissolved that rock in
    // the middle distance having never shown a billboard at all. Rocks were
    // going at 37 m.
    //
    // Asserted per INSTANCE over both traverses rather than per bed, because the
    // floor `_rankOf` applies is a function of the size roll and a per-bed
    // statement could hold on the average while failing on the big end -- which
    // is exactly the population that shows.
    //
    // READ OFF THE RIM, which is now the only place a gone-distance lives. The
    // colour texture used to carry it and this used to read it there, which was
    // the stronger test -- it checked the number the SHADER sees rather than a
    // restatement of the arithmetic that produced it. That slot holds nothing
    // but a clock now (see the DISSOLVE header in material.js), so the texture
    // is checked separately, for holding ONLY the never-fade sentinel or a stamp
    // and never a distance that a stale writer left behind.
    {
      const LAST = ROCK_LOD_AT[ROCK_LOD_AT.length - 1]
      let n = 0
      let bad = 0
      let fading = 0
      let worst = null
      let closest = Infinity
      // A slot that is neither the never-fade sentinel nor a negative stamp is a
      // distance somebody wrote and the shader will read as a clock.
      let slotBad = 0
      for (const [name, r] of Object.entries(worlds)) {
        for (const bed of r.beds) {
          // A bed that placed nothing in THIS world never allocated the colour
          // texture the fade slot lives in -- the scree bed grows tiles on the
          // uniform cliff but puts no rock in any of them, so tile count is not
          // the test, instance count is. Not silence either: `n` below is
          // asserted non-zero, so a change that emptied every bed fails here
          // rather than passing on an empty loop.
          let placed = 0
          for (const t of bed.tiles.values()) placed += t.n
          if (placed === 0) continue
          const tex = bed.batch._colorsTexture
          if (!tex) throw new Error(`check-rocks: ${bed.cfg.name} placed ${placed} but has no fade texture`)
          const fades = tex.image.data
          for (const t of bed.tiles.values()) {
            for (let k = 0; k < t.n; k++) {
              const id = t.ids[k]
              const cardAt = rockLodSize(bed.shapes[bed.shapeAt[id]].measured) * bed.instScale[id] * LAST
              const swapping = bed.fadeAt[id] >= 0
              if (swapping) fading++
              const slot = fades[id * 4 + 3]
              if (slot !== 1 && slot >= 0) slotBad++
              // Where the dissolve STARTS, not where it ends: the rim carries
              // the gone-distance and fires at RIM_AT of it.
              const gone = bed.rim.gone[id]
              const dissolveFrom = gone * RIM_AT
              n++
              if (dissolveFrom - cardAt < closest) closest = dissolveFrom - cardAt
              if (dissolveFrom < cardAt - 1e-3) {
                bad++
                const gap = cardAt - dissolveFrom
                if (!worst || gap > worst.gap) {
                  worst = { gap, cardAt, dissolveFrom, bed: bed.cfg.name, world: name,
                    shape: bed.shapes[bed.shapeAt[id]].name, scale: bed.instScale[id] }
                }
              }
            }
          }
        }
      }
      check(n > 0 && bad === 0,
        'no rock starts dissolving before its billboard takes over',
        bad === 0
          ? `${n} instances (${fading} of them mid-swap), ` +
            `closest call ${closest.toFixed(1)} m of margin`
          : `${bad} of ${n}: worst ${worst.bed}/${worst.shape} at ${worst.scale.toFixed(2)}x (${worst.world}) ` +
            `cards at ${worst.cardAt.toFixed(0)} m but starts going at ${worst.dissolveFrom.toFixed(0)} m`)
      check(slotBad === 0, 'the fade slot never holds anything but a sentinel or a stamp',
        `${slotBad} of ${n} carry a positive value that is not the never-fade 1`)
    }
    // THE CONSOLE READOUT IS THE ONLY INSTRUMENT THE BLINK HAS, so it is gated
    // like anything else: it reaches across five typed arrays, a private texture
    // and the tile map by hand, and a renamed field would leave it returning
    // `undefined` in every column at exactly the moment it is being relied on.
    // Asserted against the same numbers the gate above computes independently.
    {
      const cam = { x: 12 * 37, y: 61.6, z: 12 * 91 }
      const rows = worlds.cliff.describeNear(cam.x, cam.y, cam.z, 60)
      const LAST = ROCK_LOD_AT[ROCK_LOD_AT.length - 1]
      const sane = rows.every((r) =>
        Number.isFinite(r.d) && Number.isFinite(r.size) && Number.isFinite(r.cardsAt) &&
        Number.isFinite(r.goneAt) && typeof r.bed === 'string' && typeof r.shape === 'string' &&
        // Both columns are rounded for the console, so the identity is
        // checked to the rounding and not past it: 0.005 m of size is 0.125 m
        // of card distance.
        Math.abs(r.cardsAt - r.size * LAST) < 0.2 &&
        // The band the hysteresis leaves: a mesh holds on 12% past its card
        // distance, and a card gives way again at the distance itself.
        (r.tier === 'card' ? r.d >= r.cardsAt - 0.2 : r.d < r.cardsAt * 1.12 + 0.2))
      check(rows.length > 0 && sane,
        'describeNear reports every nearby rock\'s tier, card distance and dissolve distance',
        `${rows.length} rocks within 60 m, nearest ${rows[0].bed}/${rows[0].shape} at ${rows[0].d} m ` +
          `on ${rows[0].tier}, cards at ${rows[0].cardsAt} m, dissolves from ${rows[0].dissolveFrom} m`)
      check(rows.every((r) => r.dissolveFrom >= r.cardsAt - 1e-3),
        'and none of them is set to dissolve before it cards',
        'the same promise as above, read through the readout the browser will use')
    }

    // BOTH WORLDS, because the two carry different beds and design/05-rendering
    // quotes the ridge figure: the cliff is the three ordinary beds flat out and
    // the ridge is the only one that loads scree at all.
    for (const [name, r] of Object.entries(worlds)) {
      const s = r.stats
      console.log(`       ${name}: ${s.placed} rocks, ${s.tris} tris drawn, bank ${s.bankTris} tris / ${s.bankKB} KB, build ${s.buildMs.toFixed(0)} ms`)
    }
    for (const r of Object.values(worlds)) r.dispose()
  }

  // --- the LOD cross-dissolve ----------------------------------------------
  //
  // A rock changing tier used to CUT: one frame a mesh, the next a billboard,
  // and at the ranges the last rung sits at that is a visible twitch on ground
  // covered in stone. Rocks now does what render/trees.js does -- a duplicate
  // takes the tier being left, both halves get the same clock stamp, and they
  // dither past each other on complementary thresholds so coverage is conserved
  // and the silhouette never thins.
  //
  // ASSERTED THROUGH THE SLOT THE SHADER READS, because the whole mechanism is
  // one float per instance in the alpha of the batch's colour texture and there
  // is no other observable. A negative value is a biased clock reading and 1 is
  // the never-fade sentinel; nothing else may appear there. This block never
  // names the biases -- they are material.js's -- it names the two things a
  // caller can actually depend on: both halves go negative together, and the
  // value tracks the clock.
  //
  // THAT ONE FLOAT IS ALSO THE RIM'S, which is the only place these two
  // mechanisms can collide: the rim stamps the same slot when a rock crosses
  // its cull trigger, and a cross-dissolve half-way through would have its stamp
  // silently overwritten and its ghost stranded visible forever -- a rock frozen
  // at partial coverage, which is exactly the artefact the clock exists to
  // remove. Two guards, and both are gated below: `RockBed` refuses to start a
  // cross-dissolve on an instance the rim is already transitioning
  // (`rim.isBusy`), and `RimFade` ends any running cross-dissolve before it
  // stamps (the `onPreempt` callback the bed hands it).
  {
    setPropClock(0)
    const r = build(cliff)
    r.place(600, 600)
    r.update(600, 61.6, 600, 50)

    // The stamp a swap leaves, per bed, keyed by instance.
    const slots = (bed) => bed.batch._colorsTexture.image.data
    const snap = (bed) => bed.fades.map((f) => ({
      orig: f.orig, dup: f.dup,
      out: slots(bed)[f.dup * 4 + 3],
      in: slots(bed)[f.orig * 4 + 3],
    }))

    // A step of 9 m re-tiers whatever is sitting on a rung; the ladder is in
    // rock-sizes, so on a cliff apron that is thousands of stones at once.
    r.update(609, 61.6, 600, 50)
    const bed = r.beds.reduce((best, b) => (b.fades.length > best.fades.length ? b : best), r.beds[0])
    const first = snap(bed)
    check(first.length > 0, 'a rock crossing an LOD rung starts a cross-dissolve instead of cutting',
      `${r.beds.reduce((n, b) => n + b.fades.length, 0)} in flight over six beds, ` +
      `worst bed ${bed.cfg.name} with ${first.length}`)

    check(first.every((f) => f.out < 0 && f.in < 0),
      'and BOTH halves are stamped -- a departing duplicate and an arriving original',
      `${first.length} pairs, all with a clock in the fade slot`)

    // The ghost is a real second draw of the same rock: same place, same tint,
    // the tier that was just left. If any of that drifts the pair reads as two
    // rocks rather than one dissolving into itself.
    const ma = new THREE.Matrix4()
    const mb = new THREE.Matrix4()
    const ca = new THREE.Color()
    const cb = new THREE.Color()
    let moved = 0
    let recoloured = 0
    let sameGeom = 0
    for (const f of first) {
      bed.batch.getMatrixAt(f.orig, ma)
      bed.batch.getMatrixAt(f.dup, mb)
      if (ma.elements.some((v, i) => Math.abs(v - mb.elements[i]) > 1e-6)) moved++
      bed.batch.getColorAt(f.orig, ca)
      bed.batch.getColorAt(f.dup, cb)
      if (Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b) > 1e-6) recoloured++
      if (bed.batch.getGeometryIdAt(f.orig) === bed.batch.getGeometryIdAt(f.dup)) sameGeom++
      if (!bed.batch.getVisibleAt(f.dup)) sameGeom++
    }
    check(moved === 0 && recoloured === 0,
      'the duplicate stands exactly where the rock stands and wears exactly its tint',
      `${first.length} pairs, ${moved} adrift, ${recoloured} off-colour`)
    check(sameGeom === 0, 'and is drawn, holding the tier the rock just left rather than the one it took',
      `${first.length} pairs, all two different geometries`)

    // The ghosts are drawn, so they are in the triangle count. A cross-dissolve
    // that did not show up in `tris` would be a bill nobody could see.
    check(bed.fadeTris > 0 && bed.tris > bed.fadeTris,
      'and its triangles are counted, because the frame really does draw them',
      `${bed.fadeTris} of ${bed.tris} on ${bed.cfg.name}`)

    // THE CLOCK IS REALLY THE CLOCK. Retire this round, advance 7.5 s, force
    // another round, and compare stamps: the departing half's value has to move
    // by exactly the time that passed. That is bias-free -- it never says what
    // the bias IS -- and it is the one thing that would break silently if the
    // stamp were ever taken from something other than getPropClock().
    const freeBefore = bed.freeCount
    setPropClock(PROP_FADE_SECONDS + 0.001)
    r.update(609, 61.6, 600, 50)
    const stranded = first.filter((f) => bed.fadeAt[f.orig] >= 0 && bed.fades[bed.fadeAt[f.orig]].dup === f.dup)
    check(stranded.length === 0, 'and the pair resolves: once the window is up every duplicate is handed back',
      `${first.length} retired, pool at ${bed.freeCount} against ${freeBefore} before`)
    // And the slot goes back to the never-fade sentinel rather than being left
    // holding a spent stamp. It cannot go back to a gone-distance -- there is no
    // distance in that slot any more -- so what "restored" means now is that the
    // rock is SOLID: the rim owns the same float and would read a leftover stamp
    // as a transition it never started.
    const restored = first.filter((f) => slots(bed)[f.orig * 4 + 3] === 1)
    check(restored.length === first.length,
      'and the original is left solid rather than holding the spent timer',
      `${restored.length} of ${first.length} back to the never-fade sentinel`)

    setPropClock(20)
    r.update(600, 61.6, 609, 50)
    const second = snap(bed)
    check(second.length > 0, 'a second crossing stamps again rather than reusing the first stamp',
      `${second.length} in flight on ${bed.cfg.name}`)
    const t0 = -first[0].out
    const t1 = -second[0].out
    check(Math.abs((t1 - t0) - 20) < 1e-3,
      'and the value it stamps moves with the prop clock, second for second',
      `clock advanced 20.000 s, stamp advanced ${(t1 - t0).toFixed(3)} s`)
    check(second.every((f) => Math.abs(-f.out - t1) < 1e-3 && Math.abs((-f.in) - (-second[0].in)) < 1e-3),
      'and both halves of every pair read the SAME instant, which is what conserves coverage',
      `${second.length} pairs stamped at one clock reading`)

    // THE COLLISION, both ways. Neither guard can be reached by walking -- the
    // LOD rungs are metres out and the rim trigger is hundreds -- so both are
    // driven straight at the two methods that own the slot. A silent failure
    // here is a stranded ghost: a rock drawn twice at partial coverage with no
    // clock left to retire it, which no other check in this file would notice.
    {
      const live = bed.fades[0]
      const before = bed.freeCount
      bed.rim._startFade(live.orig, getPropClock(), false)
      check(bed.fadeAt[live.orig] === -1 && bed.freeCount === before + 1,
        'a rim dissolve preempts a cross-dissolve rather than overwriting its stamp',
        `ghost handed back, pool ${bed.freeCount} against ${before}`)
      check(slots(bed)[live.orig * 4 + 3] < 0 && !bed.batch.getVisibleAt(live.dup),
        'and what is left in the slot is the RIM\'s stamp, with the ghost off screen',
        `slot ${slots(bed)[live.orig * 4 + 3].toFixed(3)}`)

      // The other direction: the rim is mid-transition on this instance, so a
      // tier crossing has to leave it alone. Which tier a rock was wearing on
      // its way out of the world is not a question anybody is asking.
      const stamp = slots(bed)[live.orig * 4 + 3]
      const held = bed.freeCount
      bed._crossFade(live.orig, 0, bed.shapeAt[live.orig], getPropClock())
      check(bed.fadeAt[live.orig] === -1 && bed.freeCount === held
        && slots(bed)[live.orig * 4 + 3] === stamp,
        'and a cross-dissolve refuses to start while the rim owns the slot',
        `slot unchanged at ${stamp.toFixed(3)}, pool unchanged at ${held}`)
    }

    setPropClock(0)
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
    // And the hue swing that buys is bounded, which is the other half of what
    // "seated, not repainted" has to mean. A wood is the worst case in the world
    // for it -- the greenest ground and the lowest gains -- so the envelope is
    // measured there and nowhere else.
    //
    // THE ENVELOPE MOVED WHEN THE CUE DID, and it is worth saying which way round
    // that is. This bound is not the invariant; `dimmestLuma > 1` above is, and
    // it has not shifted a decimal (1.73x). This is a tightness statement, and
    // its number is a consequence of GROUND_CUE.forest -- at 0.3 a wood took 4
    // boulders in 1,832 a few percent under on blue, at 0.45 it takes 70 and the
    // worst is a sixth under. Both are the same hue rotation at constant
    // brightness, just further round it. If this fails after a cue change, the
    // question is whether the LUMINANCE promise still holds; if it does, this
    // number follows the cue rather than the cue answering to it.
    check(dimmest > 0.8 && underOne / n < 0.05,
      'and the hue the cue borrows off the ground never amounts to a repaint',
      `${underOne} of ${n} dip a channel below the tile, lowest ${dimmest.toFixed(2)}`)
    // THE CUE ITSELF IS PER ENVIRONMENT and is not exported, so it is read out of
    // the source. Two things are worth holding. A MISSING environment is the
    // dangerous one: `GROUND_CUE[env]` would be undefined, `k1` would be NaN, and
    // every instance in that environment would be written a NaN colour -- which
    // three uploads without complaint and the GPU draws as black. And the ORDER
    // is the design: it runs from ground a rock is made of to ground it is merely
    // standing on, so a riverbed matches hardest, a crag next, and a wood least.
    {
      const src = readFileSync(new URL('../src/v2/render/rocks.js', import.meta.url), 'utf8')
      const line = src.match(/^const GROUND_CUE = \{([^}]*)\}/m)
      const cue = {}
      if (line) for (const m of line[1].matchAll(/(\w+):\s*([0-9.]+)/g)) cue[m[1]] = +m[2]
      check(ENVIRONMENTS.every((e) => Number.isFinite(cue[e])),
        'every environment a rock can be placed in has a ground cue, so none is written a NaN tint',
        ENVIRONMENTS.map((e) => `${e} ${cue[e]}`).join('  '))
      check(cue.river >= cue.cliff && cue.cliff === cue.peak && cue.peak > cue.forest,
        'and the cue is strongest where the rock is made of the ground and weakest where it only stands on it',
        `river ${cue.river} >= cliff/peak ${cue.cliff} > forest ${cue.forest}`)
      check(ENVIRONMENTS.every((e) => cue[e] < 1),
        'and none of them repaints a rock outright, which would make a riverbed a flat plane')
    }

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
    // Moss's question is MOSS_LAYERS -- the same list the fragment stage masks
    // with. A patch of moss does not care whether it settled on a boulder, a
    // living trunk, a village beam or a fallen log, and the user asked for
    // exactly that: moss works the same way on wood and stone. This block used to
    // hold the opposite rule, gating the roll on stone alone so that a range
    // chosen in Rocks.syncBands could not reach a trunk; that is now the wrong
    // shape, and the third check below is the one that says so.
    //
    // What the gate still buys is LEAVES. uMossVary must not reach foliage --
    // moss does not grow on a canopy -- and because MOSS_LAYERS is a bark-and-
    // stone list with no leaf on it, that falls out of the same test.
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
    // Both accumulators are read out of the emitted source by the ARRAY they
    // walk and their LOOP BOUND, rather than by matching a block of it verbatim,
    // because those two are the part that carries the meaning: together they say
    // which list a gate consults and how much of it it is willing to look at.
    const loopLen = (name, array) => {
      const m = vs.match(new RegExp(`i < (\\d+); i\\+\\+ \\) \\{\\s*${name} \\+= step\\( abs\\( texLayer - ${array}`))
      if (!m) throw new Error(`the prop vertex shader no longer builds ${name} from ${array}`)
      return Number(m[1])
    }
    const hardLayers = [...SNOW_ROCK_LAYERS, ...SNOW_WOOD_LAYERS]
    check(snowSlice.includes('uSnowVary.x') && snowSlice.includes('min( rockV, 1.0 )') &&
      loopLen('rockV', 'uSnowRockLayers') === hardLayers.length,
      'the snow roll reaches an instance only through the hard-surface layer list',
      `gated on ${hardLayers.length} layers: ${SNOW_ROCK_LAYERS.length} stone, ${SNOW_WOOD_LAYERS.length} wood`)
    // The loop itself is written above the `vMoss =` line, so it is read out of
    // the whole vertex source and only the mix is read out of the slice.
    check(mossSlice.includes('uMossVary.x') && mossSlice.includes('min( mossV, 1.0 )') &&
      loopLen('mossV', 'uMossLayers') === MOSS_LAYERS.length,
      'and the moss roll reaches one through every surface moss grows on, wood and stone alike',
      `gated on ${MOSS_LAYERS.length} layers: [${MOSS_LAYERS.join(' ')}]`)
    // THE TWO WRONG GATES, named so that writing either cannot pass. Narrowing
    // the roll back to the stone list would freeze every trunk, beam and fallen
    // log at one moss load, which is the flat look this change was made to fix;
    // widening it to the foliage list would put a varying moss load on leaves,
    // which moss does not grow on. The fragment mask is asserted alongside
    // because the two stages must consult the SAME list or an instance can roll
    // a moss load it is then masked out of.
    const leafless = MOSS_LAYERS.filter((l) => SNOW_LAYERS.includes(l))
    check(loopLen('mossV', 'uMossLayers') > SNOW_ROCK_LAYERS.length && leafless.length === 0 &&
      src.fragmentShader.includes('mossMask += step( abs( vTexLayer - uMossLayers[ i ] ), 0.5 )'),
      'and it is neither stone alone nor anything with a leaf on it',
      `${MOSS_LAYERS.length} layers against ${SNOW_ROCK_LAYERS.length} stone, sharing ${leafless.length} with the foliage list`)

    // --- and the card spins spherically, which nothing else in the world does -
    //
    // A ROCK HAS NO UP. Every other card here grows out of the ground and keeps
    // its height vertical however the camera is pitched, which for a trunk is
    // not an approximation but the truth. The beds that reach card range are the
    // scree and the giants, both of them live on slopes, and a slope is looked
    // at from above -- so a cylindrical rock card presents a side elevation to a
    // camera that should be seeing a top, and a hillside of them tips together
    // like signboards.
    //
    // TWO PROMISES, because either alone is kept by a mistake. The rock material
    // must take the spherical branch, and the DEFAULT prop material -- trees,
    // ferns, mushrooms, grass -- must still take the cylindrical one. A flag
    // that turned out to be global would pass a check that only looked at rocks,
    // and would lay every trunk in the world down on the hillside.
    const emit = (opts) => {
      const s = {
        vertexShader: THREE.ShaderLib.lambert.vertexShader,
        fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
        uniforms: {},
      }
      createPropMaterial(texArray, opts).onBeforeCompile(s)
      return s.vertexShader
    }
    // Read off the two branches' load-bearing lines rather than off a comment:
    // the spherical one builds a world basis out of the view matrix and inverts
    // through the instance's own 3x3, the cylindrical one rotates transformed.xz
    // in place and never mentions viewMatrix at all. Both materials are handed
    // the SAME layer list, so the spin is the only thing that differs.
    const SPHERE = 'transformed = ( bbW * bbM ) * inversesqrt( bbS2 );'
    const YAW = 'transformed.xz = vec2('
    const rockVs = emit({ billboardLayers: rockImpostorLayers(), sphericalBillboard: true })
    const treeVs = emit({ billboardLayers: rockImpostorLayers() })
    check(rockVs.includes(SPHERE) && !rockVs.includes(YAW),
      'the rock card is spun spherically -- it lies back as the view tips over the hillside',
      rockVs.includes(SPHERE) ? 'world basis, inverted through the instance' : 'still yawing about Y')
    check(treeVs.includes(YAW) && !treeVs.includes(SPHERE) && !treeVs.includes('viewMatrix[ 0 ][ 1 ]'),
      'and every other prop card still yaws about world Y, because a trunk IS vertical')

    // AND THE TWO CANNOT SHARE A COMPILED PROGRAM. The branch is compiled in,
    // not switched by a uniform, so the cache key has to separate them -- and
    // this is the failure that would never be traced back here: two materials
    // agreeing on the layer list and differing only in the flag would silently
    // both get whichever was built first, and the symptom is rocks spinning
    // like trees or a forest lying down, depending on load order.
    const keyOf = (opts) => createPropMaterial(texArray, opts).customProgramCacheKey()
    check(
      keyOf({ billboardLayers: rockImpostorLayers(), sphericalBillboard: true }) !==
        keyOf({ billboardLayers: rockImpostorLayers() }),
      'and the two spins are two programs, not one program and a coin toss')

    // The flag is meaningless without something to spin, and a caller who set it
    // and no layers would be looking at unchanged pixels wondering why.
    let refused = false
    try {
      createPropMaterial(texArray, { sphericalBillboard: true })
    } catch {
      refused = true
    }
    check(refused, 'a spherical spin with no billboard layers to spin is refused rather than ignored')

    // And the world's own rock material is the one that asked for it, which is
    // what joins everything above to what actually ships.
    check(forestRocks.material.customProgramCacheKey().includes('-sph'),
      'and the material every bed shares is that one',
      forestRocks.material.customProgramCacheKey())

    setMossVary(1, 1)
    setSnowVary(1, 1)
  }

  // AND EVERY BED OWNS A COLOURS TEXTURE, INCLUDING THE ONES THAT PLACED
  // NOTHING. This is the assertion behind rocks blinking furiously at some
  // camera angles and not others, and the whole chain is in the comment at the
  // `setColorAt` in RockBed's constructor. The short version: three assigns
  // `batchingColorTexture` a texture unit only when `_colorsTexture` is
  // non-null, so a bed without one consumes one unit fewer than its siblings --
  // and because all five share ONE material, whose samplers are only reassigned
  // for the first bed drawn in a frame, that shortfall puts `uAtlas`
  // (sampler2DArray) on the unit the program still holds `batchingColorTexture`
  // (sampler2D) on. ANGLE rejects the multi-draw and silently drops it, so every
  // rock on screen vanishes for that frame while the draw counts look perfect.
  //
  // The texture is created lazily by the first `setColorAt`, which only happens
  // on placement, so this is a property of an EMPTY bed and nothing else. It
  // cannot be asserted by looking at a bed full of rocks, and the live counts
  // are reported so it is visible whether this run exercised an empty one.
  {
    const missing = []
    const counts = []
    for (const [name, r] of [['forest', forestRocks], ['cliff', cliffRocks], ['peak', peakRocks], ['river', riverRocks]]) {
      for (const bed of r.beds) {
        let live = 0
        for (const info of bed.batch._instanceInfo) if (info.visible && info.active) live++
        counts.push(`${name}/${bed.cfg.name} ${live}`)
        if (bed.batch._colorsTexture === null) missing.push(`${name}/${bed.cfg.name} (${live} live)`)
      }
    }
    check(missing.length === 0,
      'every rock bed owns a colours texture even when it placed nothing, so all of them take the same texture units',
      missing.length ? `no texture on ${missing.join(', ')}` : `live per bed: ${counts.join(', ')}`)
  }

  // THE CURSOR READOUT NAMES A ROCK, AND THE NAME IS ONE YOU CAN GO AND LOOK AT.
  //
  // Two failures, both silent in the view and both of which had actually
  // happened. First, `pickProp` duck-types on `sys.tiles`, and `Rocks` is a
  // facade over five `RockBed`s that keeps none of the instance arrays itself --
  // so the source bound to it failed the duck-type and was skipped without a
  // word, and the readout named trees and nothing else. Second, the obvious
  // thing to print is `shapeAt[id]`, which is an index into ONE BED'S roster:
  // it looks like an id you could look up and is not one.
  //
  // So this asserts the whole path a person actually walks: aim at a rock, read
  // `variant-index` off the HUD, paste it into /gen-rock's shape box -- and be
  // looking at the same rock. The last step is the one worth proving, because
  // the previewer reaches the shape by its own call, `rockShapeSeed` then
  // `rockParams(presetName, seed)`, and nothing but this check holds that to
  // the call the bank builds from.
  //
  // A THIRD failure, which is what the id format changed for: `variant#seed`
  // printed the raw bank seed, eleven digits nobody can carry to a keyboard.
  // It round-tripped and it was still useless, so "the id round-trips" is not
  // the whole promise -- `parseRockShapeId` below is asserting it is legible as
  // well as correct.
  {
    // The five sources main.js binds, built the same way, because the thing that
    // broke was the BINDING and a fixture that skipped it would not have caught
    // it. Biggest live instance so the aim is unambiguous inside a thicket.
    const rockPicks = forestRocks.beds.map((bed) => ({
      label: 'rock', sys: bed, idKey: 'shapeAt',
      nameAt: (s, id) => s.shapeIdAt(id),
      sizeAt: (s, id, out) => s.pickSizeAt(id, out),
    }))
    let target = null
    for (const bed of forestRocks.beds) {
      for (const tile of bed.tiles.values()) {
        for (let k = 0; k < tile.n; k++) {
          const id = tile.ids[k]
          if (target === null || bed.instScale[id] > target.scale) {
            target = { bed, id, scale: bed.instScale[id], x: bed.instX[id], y: bed.instY[id], z: bed.instZ[id] }
          }
        }
      }
    }
    check(target !== null, 'the pick fixture has a rock to aim at', target ? `${target.bed.cfg.name}#${target.id}` : 'no live instance')

    // Eye 3 m out and 1 m up, aimed at the instance's own axis a little above
    // its foot -- the pose someone naming a rock is in.
    const eye = { x: target.x + 3, y: target.y + 1, z: target.z }
    const to = { x: target.x - eye.x, y: target.y + 0.3 - eye.y, z: target.z - eye.z }
    const len = Math.hypot(to.x, to.y, to.z)
    const dir = { x: to.x / len, y: to.y / len, z: to.z / len }

    const hit = pickProp(rockPicks, eye, dir, Infinity)
    check(hit !== null && hit.label === 'rock', 'a rock under the cursor is named at all, which it was not while `Rocks` itself was bound',
      hit === null ? 'named nothing' : `named ${hit.label} ${hit.name}`)

    // And binding the facade -- the actual bug -- has to be an error now, not a
    // shrug. This is the assertion that keeps the failure loud.
    let facadeThrew = false
    try {
      pickProp([{ label: 'rock', sys: forestRocks, idKey: 'shapeAt', radius: 1.2, rise: 1.2 }], eye, dir, Infinity)
    } catch {
      facadeThrew = true
    }
    check(facadeThrew, 'and binding the facade instead of its beds throws rather than quietly naming nothing')

    const parsed = hit === null ? null : parseRockShapeId(hit.name)
    check(parsed !== null, 'the id it prints is `variant-index`, not a bare roster index and not eleven digits of seed',
      hit === null ? 'no hit' : hit.name)
    const { name: variantName, index: shapeIndex } = parsed ?? { name: '', index: 0 }
    check(ROCK_NAMES.includes(variantName),
      'and the variant half is an entry in /gen-rock\'s preset dropdown, which lists exactly ROCK_VARIANTS',
      `${variantName} against ${ROCK_NAMES.length} presets`)
    check(shapeIndex >= 0 && shapeIndex < 2,
      'and the index half is inside the bank\'s own seed count, so it names a shape that exists',
      `index ${shapeIndex} of 2 seeds`)

    // The round trip. /gen-rock answers a preset choice with
    // `Object.assign(params, rockParams(presetName, params.seed))` and builds
    // from that, so rebuilding through the same call has to give back the shape
    // the bed is holding. Measured extents rather than vertex-by-vertex: the
    // promise is that it is THE SAME ROCK, and three numbers to 1e-9 is that.
    const shape = target.bed.shapes[target.bed.shapeAt[target.id]]
    const rebuilt = buildRock({ ...rockParams(variantName, rockShapeSeed(7, variantName, shapeIndex)), tier: 0 })
    const a = rebuilt.userData.rock.measured
    const b = shape.measured
    const off = Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height), Math.abs(a.depth - b.depth))
    check(hit.name === target.bed.shapeIdAt(target.id) && off < 1e-9,
      'and pasting that id into /gen-rock rebuilds the very rock that was under the cursor',
      `${hit.name}, extents off by ${off.toExponential(1)} m`)
  }

  // THE CURSOR STOPS AT THE FIRST FACE, rather than at the nearest AXIS.
  //
  // These are two different questions and the readout used to answer the wrong
  // one. Ranking by closest approach to an instance's vertical axis makes a
  // rock's pick strength depend on where its middle is, so a boulder whose near
  // face fills the crosshair loses to a pebble standing a metre nearer its own
  // centre -- and what the player sees is a cursor reading straight THROUGH the
  // thing they are pointing at. The fixture below is that exact geometry, in
  // the one arrangement where the two rankings disagree, so it fails the moment
  // anyone puts the axis test back.
  //
  // Synthetic instances rather than placed ones, because the property is about
  // the ORDER two volumes are returned in and a real bed cannot be asked to put
  // two particular rocks in two particular places.
  {
    const fixture = (rocks) => ({
      tiles: new Map([[0, { n: rocks.length, ids: rocks.map((_, i) => i) }]]),
      instX: Float32Array.from(rocks, (r) => r.x),
      instY: Float32Array.from(rocks, (r) => r.y),
      instZ: Float32Array.from(rocks, (r) => r.z),
      instScale: Float32Array.from(rocks, () => 1),
      shapeAt: Uint16Array.from(rocks, (_, i) => i),
      _rocks: rocks,
    })
    const sized = (sys) => ({
      label: 'rock', sys, idKey: 'shapeAt',
      sizeAt: (s, id, out) => {
        out.radius = s._rocks[id].r
        out.rise = s._rocks[id].rise
        return out
      },
      nameAt: (s, id) => s._rocks[id].name,
    })

    // A: a wide rock 3 m off the sight line, whose near face the ray crosses at
    // 17.35 m and whose AXIS it is closest to at 20 m.
    // B: a pebble on the sight line whose face is at 18.5 m and whose axis is
    // closest at 19 m. B is behind A's surface and in front of A's middle.
    const through = fixture([
      { name: 'A-wide', x: 20, y: 0, z: 3, r: 4, rise: 4 },
      { name: 'B-pebble', x: 19, y: 0, z: 0, r: 0.5, rise: 1 },
    ])
    const eye = { x: 0, y: 1, z: 0 }
    const east = { x: 1, y: 0, z: 0 }
    const hitThrough = pickProp([sized(through)], eye, east, Infinity)
    check(hitThrough !== null && hitThrough.name === 'A-wide',
      'the cursor names the rock whose FACE it crosses first, not the one whose middle is nearest',
      hitThrough === null ? 'named nothing' : `named ${hitThrough.name} at ${hitThrough.dist.toFixed(2)} m`)
    check(hitThrough !== null && Math.abs(hitThrough.dist - (20 - Math.sqrt(7))) < 1e-3,
      'and the range it reports is that face, not that middle',
      hitThrough === null ? 'no hit' : `${hitThrough.dist.toFixed(3)} m against ${(20 - Math.sqrt(7)).toFixed(3)} m`)

    // AND IT REACHES THE TOP OF A TALL ROCK. The volume used to be one species
    // constant, 1.2 m of radius and 1.2 m of rise at scale 1, over a bank whose
    // shapes run from a slab seven times wider than it is tall to a spire three
    // times taller than it is wide. Everything above 1.2 m was unnameable, and
    // "unnameable" looks exactly like "the cursor points through it".
    const spire = fixture([{ name: 'spire', x: 10, y: 0, z: 0, r: 0.5, rise: 6 }])
    const high = { x: 0, y: 5, z: 0 }
    const bySize = pickProp([sized(spire)], high, east, Infinity)
    const byConstant = pickProp(
      [{ label: 'rock', sys: spire, idKey: 'shapeAt', radius: 1.2, rise: 1.2, scaleKey: 'instScale' }],
      high, east, Infinity
    )
    check(bySize !== null, 'a rock is nameable at the top of its own height, five metres up a six-metre spire',
      bySize === null ? 'named nothing' : `named ${bySize.name} at ${bySize.dist.toFixed(2)} m`)
    check(byConstant === null,
      'and the species constant it replaced provably could not do that, which is why it went',
      byConstant === null ? 'the old 1.2 m volume names nothing up there' : `unexpectedly named ${byConstant.name}`)

    // A source that declares neither has to say so. Silent zero-radius volumes
    // name nothing, and a readout that names nothing is indistinguishable from
    // a ray that hit nothing -- the same failure mode that hid the facade bug.
    let unsizedThrew = false
    try {
      pickProp([{ label: 'rock', sys: spire, idKey: 'shapeAt' }], high, east, Infinity)
    } catch {
      unsizedThrew = true
    }
    check(unsizedThrew, 'and a pick source with neither a sizeAt nor a radius throws instead of naming nothing')
  }

  // THE BILLBOARD IS THE SIZE OF THE ROCK IT REPLACED.
  //
  // Two halves, and both of them were broken in ways that looked like the
  // other. The card has to be the size of the mesh IN THE BANK, and the spin
  // has to draw it at the instance's scale ON THE HILLSIDE. It was doing the
  // second one exactly backwards: the spherical branch of billboardVertex built
  // its answer in world space and mapped it back through the plain inverse, so
  // the matrix reapplied the instance scale on the way out, the two cancelled,
  // and every spun card drew at its raw bank size however big the rock was. A
  // crust cap at scale 4.10 drew a quarter-size billboard; one at 8.33 drew an
  // eighth. That is the "it swaps in a billboard vastly smaller than the shape
  // it replaced" report, and it is arithmetic rather than opinion.
  {
    // Half one: the quad against the mesh it takes over from, in the bank.
    // Silhouette width over 64 bearings, because a card that spins has to stand
    // in for the rock seen from anywhere, not from the one azimuth it was
    // measured at.
    const BEARINGS = 64
    const wr = []
    const hr = []
    for (const shape of forestRocks.bank.shapes) {
      const frame = impostorCardExtents({ width: shape.measured.planMean, height: shape.measured.height })
      const last = shape.tiers[ROCK_MESH_BAND_COUNT - 1]
      const mp = last.attributes.position.array
      let mLo = Infinity
      let mHi = -Infinity
      let meanW = 0
      for (let b = 0; b < BEARINGS; b++) {
        const ang = (b / BEARINGS) * Math.PI * 2
        const dx = Math.cos(ang)
        const dz = Math.sin(ang)
        let lo = Infinity
        let hi = -Infinity
        for (let i = 0; i < mp.length; i += 3) {
          const t = mp[i] * -dz + mp[i + 2] * dx
          if (t < lo) lo = t
          if (t > hi) hi = t
          if (b === 0) {
            if (mp[i + 1] < mLo) mLo = mp[i + 1]
            if (mp[i + 1] > mHi) mHi = mp[i + 1]
          }
        }
        meanW += hi - lo
      }
      meanW /= BEARINGS
      wr.push(shape.measured.planMean / meanW)
      hr.push(shape.measured.height / (mHi - mLo))
    }
    const band = (a) => `${amin(a).toFixed(2)} .. ${amax(a).toFixed(2)}`
    check(amin(wr) > 0.7 && amax(wr) < 1.4 && amin(hr) > 0.7 && amax(hr) < 1.4,
      'the card the bank builds is the size of the last mesh tier it takes over from',
      `${wr.length} shapes, width ${band(wr)}, height ${band(hr)}`)

    // Half two: the spin, modelled in JS exactly as the shader writes it, and
    // asked the only question that matters -- does a card on an instance of
    // scale s come out s times as big? A model and not the GPU, so the shader
    // text is checked against it below; the two together are what stop this
    // silently going back to a divide.
    const spun = (scale, local) => {
      const batching = new THREE.Matrix4().compose(
        new THREE.Vector3(10, 2, 30),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.64, 0)),
        new THREE.Vector3(scale, scale, scale)
      )
      const bbM = new THREE.Matrix3().setFromMatrix4(batching)
      const cam = new THREE.Object3D()
      cam.rotation.set(-0.26, 0.44, 0, 'YXZ')
      cam.updateMatrixWorld()
      const v = cam.matrixWorld.clone().invert().elements
      const bbRw = new THREE.Vector3(v[0], v[4], v[8])
      const bbUw = new THREE.Vector3(v[1], v[5], v[9])
      const e = bbM.elements
      const bbS2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2]
      const bbW = bbRw.clone().multiplyScalar(local.x).add(bbUw.clone().multiplyScalar(local.y))
      // v * M in GLSL is M-transpose * v.
      const transformed = new THREE.Vector3(
        e[0] * bbW.x + e[1] * bbW.y + e[2] * bbW.z,
        e[3] * bbW.x + e[4] * bbW.y + e[5] * bbW.z,
        e[6] * bbW.x + e[7] * bbW.y + e[8] * bbW.z
      ).multiplyScalar(1 / Math.sqrt(bbS2))
      return transformed.applyMatrix3(new THREE.Matrix3().setFromMatrix4(batching)).length()
    }
    // 0.16 and 8.33 are the real extremes of instScale over the placed beds.
    const SCALES = [0.16, 0.5, 1, 2, 4.1, 8.33]
    const err = SCALES.map((s) => Math.abs(spun(s, { x: 1, y: 0 }) / s - 1))
    check(amax(err) < 1e-6,
      'and the spherical spin draws it at the instance scale instead of dividing that scale out',
      `scale ${SCALES[0]} .. ${SCALES[SCALES.length - 1]}, worst error ${amax(err).toExponential(1)}`)
    const stillSquare = Math.abs(spun(3, { x: 0, y: 1 }) / 3 - 1) < 1e-6
    check(stillSquare, 'and the card height rides the same scale as its width, so it is not sheared',
      `height at scale 3 is ${spun(3, { x: 0, y: 1 }).toFixed(4)} m per local metre`)

    // The model above is only worth anything while the shader still says what
    // it says. `/ bbS2` is the plain inverse and is the bug; `inversesqrt` is
    // the inverse with the instance scale rolled back in.
    const shaderText = readFileSync(new URL('../src/material.js', import.meta.url), 'utf8')
    check(shaderText.includes('inversesqrt( bbS2 )') && !shaderText.includes('/ bbS2'),
      'and the shipped shader divides by the scale once, not twice, so the model is not describing dead code')
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
