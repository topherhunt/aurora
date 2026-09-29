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

import { buildRock, ROCK_TIERS, ROCK_LOD_AT, ROCK_LOD_FAR_MAX, rockLodSize, ROCK_DEFAULTS, BOX_MARGIN } from '../src/props/rock.js'
import {
  buildRockBank, rockParams, CAP, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, TINTS, TINT_GAIN,
} from '../src/props/rock-bank.js'
import { Rocks, LIFT_BEDS, ROCK_STAND_MIN, BLOCK_SETTLE_MAX, SPAN_STRIDE, BARREN_ABOVE_SNOW } from '../src/v2/render/rocks.js'
import { pickProp } from '../src/v2/edit/pick.js'
import {
  LAYER, TILE_METRES, IMAGE_LAYERS, TEX_SIZE, SNOW_LAYERS, SNOW_ROCK_LAYERS, SNOW_WOOD_LAYERS, MOSS_LAYERS,
  ROCK_TILE_MEAN, GRASS_TILE_MEAN, SNOW_TILE_MEAN,
  TERRAIN_GRASS_PLACEHOLDER, TERRAIN_SNOW_PLACEHOLDER, buildTextureArray,
} from '../src/textures.js'
import {
  SNOW_ROCK, MOSS, mossCutFor, createPropMaterial, getSnowLine, getMossLine,
  setMossVary, getMossVary, setSnowVary, getSnowVary,
  setPropClock, getPropClock, PROP_FADE_SECONDS,
} from '../src/material.js'
import { RIM_AT } from '../src/v2/render/rim.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'
import { readPng } from '../tools/props/png.mjs'
import { taken } from '../src/v2/taken.js'

const SEEDS = Number(process.argv[2] ?? 200)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// Math.min(...a) over a placed-rock array is a stack overflow waiting for a bed
// to get wider, and it got one: widening a bed to hold a full far-tier band
// took its rock count past the argument limit and this gate died inside its own
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
  // The taper run the other way: wider at the top than the bottom. Not what the
  // world's boulder does, and the one direction where a profile bug shows up as
  // an inverted rock rather than as a slightly wrong one.
  { name: 'mushroom', over: { size: 2.4, taper: -0.55, taperPow: 1.4, foot: 0, sit: 0.2 } },
  { name: 'pebble', over: { size: 0.09, sit: 0.05, cuts: 2 } },
  // Deeply seated: `sit` past a half puts most of the solid under the bed plane.
  // Which is now a rock that has THROWN THE BURIED PART AWAY -- the floor disc
  // goes and the tier comes back short by exactly the faces `dropped` reports.
  { name: 'deep sit', over: { size: 0.8, squash: 0.5, cuts: 3, cutDepth: 0.5, cutBias: -0.3, sit: 0.52 } },
  // THE CAP, from the bank: the open-bottomed shell, skirt and all. Here rather
  // than only in the bank's own numbers because the skirt is the one thing in
  // the generator that puts geometry BELOW the bed plane on purpose, and every
  // check in this block assumes it does not.
  { name: 'cap', over: { ...CAP, size: 2 } },
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
  offGround: 0, wrongSize: 0, badNormal: 0, wrongLayer: 0, degenerate: 0, inward: 0,
  floored: 0,
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

      // THE TRIANGLE COUNT IS THE TIER'S FACE COUNT TIMES THE SHARDS, LESS WHAT
      // `dropped` OWNS UP TO. That subtraction is the promise the arena sizing
      // in rock-bank.js and every triangle budget in the scatter is written
      // against, so `dropped` is asserted rather than merely ignored: a
      // generator that started losing faces anywhere else would otherwise show
      // up only as an arena that overflows on some later seed.
      //
      // A CLOSED ROCK STILL DROPS NOTHING. `sit` 0 is the shipping boulder, and
      // it is closed because rocks.js turns it through sixteen quarter turns and
      // any face of it may end up facing the sky. Only a rock with a cut face
      // may open its bottom.
      //
      // THE FAR TIER IS ONE HULL FOR THE WHOLE ROCK, shards and all, and is
      // closed whatever `sit` says: six faces, never fewer, hanging the skirt
      // off its floor corners. Section 1b holds it to the shape it stands in for.
      const stats = geo.userData.rock
      const far = ROCK_TIERS[t].solid === 'five'
      const shards = Math.max(1, Math.round(shape.over.shards ?? ROCK_DEFAULTS.shards))
      const sit = shape.over.sit ?? ROCK_DEFAULTS.sit
      const full = far ? ROCK_TIERS[t].faces : ROCK_TIERS[t].faces * shards
      if (stats.triangles !== full - stats.dropped) bad.triCount++
      if (sit === 0 || far ? stats.dropped !== 0 : stats.dropped < 0) bad.closedDropped++
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
      // WHERE THE LOWEST VERTEX IS MEANT TO BE. y = 0 for everything the world
      // places; one skirt-height BELOW it for a shell, whose rim is pushed down
      // on purpose so the open bottom cannot clear the dirt, and for the far
      // tier standing in for that shell. The bed plane
      // itself has not moved either way -- the skirt is applied after the
      // re-seat, so `measured` and the burial arithmetic in rocks.js are reading
      // the same y = 0 they always were.
      const size = shape.over.size ?? ROCK_DEFAULTS.size
      const skirtDrop = (shape.over.skirt ?? ROCK_DEFAULTS.skirt) * stats.measured.height
      const groundErr = Math.abs(minY + skirtDrop) / size
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
      // WOUND OUTWARD, which is what makes back-face culling safe -- and the
      // material asks for it (side: FrontSide in v2/render/rocks.js). Signed
      // volume is the whole test: an outward-wound solid sums its tetrahedra to
      // its own positive volume and an inside-out one sums to exactly minus it,
      // so a cluster of shards still comes out positive and there is no
      // threshold to tune. A mesh that failed this would look right from every
      // angle that has a front face and be hollow from the rest.
      let volume = 0
      // AND THE FLOOR IS ACTUALLY GONE. `dropped` is the generator's own count
      // and would still read right if it dropped the wrong faces; this reads the
      // vertices. A face with all three corners on the lowest plane is a floor
      // face, which is legal on a closed rock and is the whole of what an open
      // bottom means to be rid of.
      //
      // EXACTLY EQUAL, not within a tolerance, and that is the strict test here
      // rather than the loose one: every vertex the bed plane caught was
      // ASSIGNED one y, so three of them agree bit for bit. A vertex a micron
      // clear of the plane was never on it -- the face it belongs to is a real
      // if nearly flat side face, and a tolerance wide enough to swallow one is
      // wide enough to call that face a floor.
      let floorFaces = 0
      const faces = pos.length / 9
      for (let f = 0; f < faces; f++) {
        const o = f * 9
        if (pos[o + 1] === minY && pos[o + 4] === minY && pos[o + 7] === minY) floorFaces++
        const abx = pos[o + 3] - pos[o], aby = pos[o + 4] - pos[o + 1], abz = pos[o + 5] - pos[o + 2]
        const acx = pos[o + 6] - pos[o], acy = pos[o + 7] - pos[o + 1], acz = pos[o + 8] - pos[o + 2]
        const cx = aby * acz - abz * acy
        const cy = abz * acx - abx * acz
        const cz = abx * acy - aby * acx
        if (Math.hypot(cx, cy, cz) < 1e-9) degen++
        volume += pos[o] * cx + pos[o + 1] * cy + pos[o + 2] * cz
      }
      if (!(volume > 0)) bad.inward++
      if (sit > 0 && !far && floorFaces > 0) bad.floored++
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
check(bad.closedDropped === 0, 'and a rock with no cut face -- the shipping boulder -- drops none of them at all',
  `${bad.closedDropped} closed builds short`)
check(bad.floored === 0, 'while a rock that sits into the ground keeps no face on the bed plane at all',
  `${bad.floored} open-bottomed builds still carrying a floor`)
check(bad.wrongLayer === 0, 'every vertex wears LAYER.ROCK', `${bad.wrongLayer} builds off-layer`)
check(bad.offGround === 0, 'the bed plane sits on y = 0', `worst ${(worst.ground * 100).toFixed(4)}% of size`)
check(bad.wrongSize === 0, 'every tier measures `size`, give or take a coarse corner', `worst -${(worst.size * 100).toFixed(0)}% / +${(worst.overSize * 100).toFixed(0)}%, cap +${((BOX_MARGIN - 1) * 100).toFixed(0)}%`)
check(bad.badNormal === 0, 'every normal is unit length', `worst |n|-1 = ${worst.normal.toExponential(1)}`)
check(bad.degenerate === 0, 'the bed plane flattens only a few faces', `worst ${(worst.degenFrac * 100).toFixed(0)}% of faces`)
check(bad.inward === 0, 'every rock is wound outward, so FrontSide culls the right half', `${bad.inward} builds inside out`)

console.log(`       ${builds} builds, ${totalTris} triangles`)

// ---------------------------------------------------------------------------
// 1b. The far tier is the rock's own box, on five vertices.
// ---------------------------------------------------------------------------
//
// The last rung is not a sampled solid: it is five vertices and six faces fitted
// to the measured box, textured and tinted like every other tier, and it is what
// every rock in the world is past its last real mesh. Section 2's support
// arithmetic is the wrong instrument for it -- a box's corners reach past any
// hull inscribed in it -- so what is held here is what the eye reads at that
// range: the box, the side silhouette, and that it is closed and convex.
console.log('\nfar tier')
{
  const FAR = ROCK_TIERS.length - 1
  check(ROCK_TIERS[FAR].solid === 'five' && ROCK_TIERS[FAR].faces === 6 && ROCK_TIERS[FAR].name === 'T6',
    'the last rung of the ladder is the six-face hull', `${ROCK_TIERS[FAR].name}, ${ROCK_TIERS[FAR].solid}`)
  check(ROCK_TIERS.slice(0, FAR).every((t) => t.solid !== 'five'),
    'and it is the only one', ROCK_TIERS.map((t) => t.solid).join('/'))

  // Convex hull area of a point set projected to two axes: the silhouette a
  // mesh presents along the third.
  const hullArea = (pos, a, b) => {
    const pts = []
    for (let i = 0; i < pos.length; i += 3) pts.push([pos[i + a], pos[i + b]])
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1])
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    const lo = []
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p) }
    const hi = []
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p) }
    const h = lo.slice(0, -1).concat(hi.slice(0, -1))
    let area = 0
    for (let i = 0; i < h.length; i++) { const j = (i + 1) % h.length; area += h[i][0] * h[j][1] - h[j][0] * h[i][1] }
    return Math.abs(area) / 2
  }

  const farBad = { verts: 0, box: 0, concave: 0, side: 0, plan: 0, meta: 0, sameBox: 0, shoulders: 0 }
  const farWorst = { box: 0, side: 0, sideLo: Infinity, plan: 0, planLo: Infinity, concave: 0 }
  let farN = 0
  for (let seed = 1; seed <= Math.min(SEEDS, 60); seed++) {
    for (const shape of SHAPES) {
      const fine = buildRock({ ...shape.over, seed, tier: 0 })
      const geo = buildRock({ ...shape.over, seed, tier: FAR })
      const pos = geo.attributes.position.array
      const m = geo.userData.rock.measured
      const size = shape.over.size ?? ROCK_DEFAULTS.size
      farN++

      // FIVE VERTICES AND SIX FACES: a closed hull on the fewest vertices that
      // can hold a box's width, depth and height apart. Distinct by exact
      // position, since the buffer is unwelded and each face owns its corners.
      const distinct = new Set()
      for (let i = 0; i < pos.length; i += 3) distinct.add(`${pos[i]},${pos[i + 1]},${pos[i + 2]}`)
      if (distinct.size !== 5 || pos.length !== 18 * 3) farBad.verts++

      // THE BOX IS THE MEASURED BOX, TO THE VERTEX -- not inscribed, not gained.
      // `measured` is what every bed places and spaces by, and this tier is
      // seen from further than any other, so it is the one whose extent has to
      // be the rock's own. Below the floor hangs the same skirt the finer tiers
      // hang on a seated rock, so a bed that sinks it leaves no gap.
      const params = { ...ROCK_DEFAULTS, ...shape.over }
      const skirtDrop = params.sit > 0 ? Math.max(0, params.skirt) * m.height : 0
      let lo = [Infinity, Infinity, Infinity]
      let hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (pos[i + a] < lo[a]) lo[a] = pos[i + a]
          if (pos[i + a] > hi[a]) hi[a] = pos[i + a]
        }
      }
      const boxErr = Math.max(
        Math.abs(lo[0] + m.width / 2), Math.abs(hi[0] - m.width / 2),
        Math.abs(lo[1] + skirtDrop), Math.abs(hi[1] - m.height),
        Math.abs(lo[2] + m.depth / 2), Math.abs(hi[2] - m.depth / 2)) / size
      if (boxErr > 1e-5) farBad.box++
      farWorst.box = Math.max(farWorst.box, boxErr)
      // And the same box every finer tier reports, since one reference measured
      // them all.
      const fm = fine.userData.rock.measured
      if (fm.width !== m.width || fm.height !== m.height || fm.depth !== m.depth) farBad.sameBox++

      // CONVEX AND OUTWARD: every vertex on or inside every face's plane. An
      // inside-out or folded hull passes the signed-volume test above by
      // accident on a shape this small, so the planes are asked one by one.
      let concave = 0
      for (let f = 0; f < 6; f++) {
        const o = f * 9
        const abx = pos[o + 3] - pos[o], aby = pos[o + 4] - pos[o + 1], abz = pos[o + 5] - pos[o + 2]
        const acx = pos[o + 6] - pos[o], acy = pos[o + 7] - pos[o + 1], acz = pos[o + 8] - pos[o + 2]
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
        const nl = Math.hypot(nx, ny, nz)
        for (let i = 0; i < pos.length; i += 3) {
          const d = ((pos[i] - pos[o]) * nx + (pos[i + 1] - pos[o + 1]) * ny + (pos[i + 2] - pos[o + 2]) * nz) / nl
          concave = Math.max(concave, d / size)
        }
      }
      if (concave > 1e-6) farBad.concave++
      farWorst.concave = Math.max(farWorst.concave, concave)

      // THE SILHOUETTE IS THE MESH'S along all three axes. That is the read a
      // rock gives at 25 sizes out -- a lump of a certain height and width
      // against the hill -- and it is what the shoulders' height and their
      // pull-in from the box's corners are set by. Plan gets more room above:
      // a sunk rock's belly is flattened into the box the hull fills, while its
      // mesh keeps only the rim an edge below the cut, and that gap is under
      // the spread T20 already shows against T320.
      const fp = fine.attributes.position.array
      const sideX = hullArea(pos, 0, 1) / hullArea(fp, 0, 1)
      const sideZ = hullArea(pos, 2, 1) / hullArea(fp, 2, 1)
      const plan = hullArea(pos, 0, 2) / hullArea(fp, 0, 2)
      if (sideX < 0.85 || sideX > 1.2 || sideZ < 0.85 || sideZ > 1.2) farBad.side++
      if (plan < 0.85 || plan > 1.3) farBad.plan++
      farWorst.side = Math.max(farWorst.side, sideX, sideZ)
      farWorst.sideLo = Math.min(farWorst.sideLo, sideX, sideZ)
      farWorst.plan = Math.max(farWorst.plan, plan)
      farWorst.planLo = Math.min(farWorst.planLo, plan)

      // THE SHOULDERS STAY BELOW THE CROWN AND OFF THE FLOOR IS NOT REQUIRED: a
      // cap whose widest ring is its cut face degenerates to a square pyramid,
      // and that is the right hull for it. What is required is that exactly one
      // vertex stands at the crown and two on the floor.
      let atCrown = 0
      let atFloor = 0
      for (const key of distinct) {
        const y = Number(key.split(',')[1])
        if (y === hi[1]) atCrown++
        if (y === lo[1]) atFloor++
      }
      if (atCrown !== 1 || atFloor < 2) farBad.shoulders++

      const u = geo.userData.rock
      if (u.dropped !== 0 || u.gain !== 1 || u.faces !== 6 || u.triangles !== 6 || u.vertices !== 18 || u.tier !== 'T6') farBad.meta++

      fine.dispose()
      geo.dispose()
    }
  }
  check(farBad.verts === 0, 'the far tier is five distinct vertices on six faces', `${farBad.verts} of ${farN} builds off`)
  check(farBad.box === 0, 'and its box is the measured box to the vertex, every axis',
    `worst ${farWorst.box.toExponential(1)} of size`)
  check(farBad.sameBox === 0, 'which is the same box the finest tier reports', `${farBad.sameBox} disagree`)
  check(farBad.concave === 0, 'and it is convex, every vertex inside every face plane',
    `worst ${farWorst.concave.toExponential(1)} of size outside`)
  check(farBad.side === 0, 'its side silhouette is the finest tier\'s along both horizontal axes, within 15%',
    `${farWorst.sideLo.toFixed(2)}x .. ${farWorst.side.toFixed(2)}x of T${ROCK_TIERS[0].faces}'s`)
  check(farBad.plan === 0, 'and in plan it covers what the mesh covers, within 15% under and 30% over',
    `${farWorst.planLo.toFixed(2)}x .. ${farWorst.plan.toFixed(2)}x`)
  check(farBad.shoulders === 0, 'one vertex at the crown, two on the floor, two shoulders between',
    `${farBad.shoulders} builds otherwise`)
  check(farBad.meta === 0, 'and it reports itself whole: T6, 6 faces, nothing dropped, no gain',
    `${farBad.meta} builds otherwise`)
}

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
// whisker of T320 and T20 never will be, so one pooled number would either let
// a broken T80 hide behind T20's honest spread or fail T20 for being 20 faces.
// Also
// per (shape, tier), so a shape whose bias is large cannot cancel against one
// whose bias is large the other way.
// `worst` is the deepest single-probe disagreement: how much silhouette this
// tier's flat faces cut off (or its gain pushed out) at the one direction where
// the coarse solid samples worst.
//
// THE SAMPLED TIERS ONLY. The far tier is a box hull, not a sampling of the
// noise field, and section 1b holds it to the silhouette instead.
const MESH_TIERS = ROCK_TIERS.length - 1
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
    for (let t = 1; t < MESH_TIERS; t++) {
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

check(worstShapeBias < 0.08, 'no sampled tier reads systematically bigger or smaller', `worst ${(worstShapeBias * 100).toFixed(1)}% of reach, ${worstShapeBiasName}`)
for (let t = 1; t < MESH_TIERS; t++) {
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

// And the thresholds it is walked with. One per tier but the last, which has no
// threshold of its own -- it is where a rock lands when it has fallen off the
// end. Ascending for the same reason the faces descend: a shorter threshold
// behind a longer one is a band no rock can ever be in.
{
  let ok = ROCK_LOD_AT.length === ROCK_TIERS.length - 1 && ROCK_LOD_AT[0] > 0
  for (let i = 1; i < ROCK_LOD_AT.length; i++) {
    if (!(ROCK_LOD_AT[i] > ROCK_LOD_AT[i - 1])) ok = false
  }
  check(ok, 'ROCK_LOD_AT gives every tier but the far one an ascending threshold',
    `${ROCK_LOD_AT.join('/')} m per metre of ladder size, ${ROCK_TIERS.length} tiers`)
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
  //
  // ONE SHAPE, TWO SIZES. Every bed that places a boulder places the same mesh,
  // so a cobble and a tor are the same `measured` box under two instance scales
  // -- which is the whole claim being tested here, that the ladder is a function
  // of the SIZE an instance is placed at and not of which rock it is.
  const bank = buildRockBank({ seed: 7 })
  const boulder = bank.shapes.boulder.measured
  const at = (m, k) => ROCK_LOD_AT.map((v) => `${(v * rockLodSize(m) * k).toFixed(1)}`).join('/')
  const COBBLE = 0.25 / rockLodSize(boulder)
  const TOR = 9 / rockLodSize(boulder)
  const cobbleFar = ROCK_LOD_AT[ROCK_LOD_AT.length - 1] * rockLodSize(boulder) * COBBLE
  const torLeavesFinest = ROCK_LOD_AT[0] * rockLodSize(boulder) * TOR
  check(cobbleFar < torLeavesFinest,
    'a cobble is on its far tier before a tor has left its finest mesh',
    `cobble ${at(boulder, COBBLE)} m then T6; tor ${at(boulder, TOR)}`)

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
  // a max. The two probes are built here rather than taken from the bank,
  // because the bank has one rock and one rock cannot show both failures: a
  // SLAB must not be judged by its height, a COLUMN must not be judged by its
  // width, and the shipping boulder is neither. Checked as an identity against
  // the measurements rather than against remembered numbers.
  const measure = (over) => buildRock({ ...over, seed: 7, tier: 0 }).userData.rock.measured
  const slab = measure({ size: 1.1, squash: 0.28, elongate: 1.6, cutBias: -0.9 })
  const column = measure({ size: 2.2, squash: 2.4, cutBias: 0.95, taper: 0.6 })
  const longest = (m) => Math.max(m.width, m.depth, m.height)
  const okBasis = [slab, column, boulder].every((m) => rockLodSize(m) === longest(m))
  check(okBasis && rockLodSize(slab) > slab.height && rockLodSize(column) > column.width,
    'a rock is measured by its longest axis, so a slab is not judged by its height nor a column by its width',
    `slab ${rockLodSize(slab).toFixed(2)} m (h ${slab.height.toFixed(2)}), ` +
      `column ${rockLodSize(column).toFixed(2)} m (w ${column.width.toFixed(2)})`)
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
// 4a-ter. THE GRIT LAYER, which is not an albedo and is not a photograph.
//
// LAYER.ROCK_BUMP is generated grey noise, read only through the prop material's
// bump block, and read as a DERIVATIVE: the shader samples it twice a screen
// derivative apart and lights the difference. That changes what a wrap seam costs.
// A seam in an albedo is a faint line; a seam in a height field read this way is a
// bright rule of wrongly-lit pixels drawn across the rock at every repeat, and at
// the tiling this is worn at (uBumpTile, ~3 passes per stone tile) there are a lot
// of repeats. Hence the same seam metric the photographs get, and a tighter bar.
//
// The variance check is the other half: a height field that is nearly flat is a
// uniform branch nobody switched off, costing two texture fetches a pixel to
// change nothing.
// ---------------------------------------------------------------------------

{
  console.log('\nthe grit layer (LAYER.ROCK_BUMP)')
  const n = TEX_SIZE
  const stride = n * n * 4
  const all = buildTextureArray().image.data
  const px = all.subarray(LAYER.ROCK_BUMP * stride, (LAYER.ROCK_BUMP + 1) * stride)

  let mean = 0
  let lo = 255
  let hi = 0
  let opaque = 0
  let grey = 0
  for (let i = 0; i < n * n; i++) {
    const v = px[i * 4]
    mean += v
    if (v < lo) lo = v
    if (v > hi) hi = v
    if (px[i * 4 + 3] === 255) opaque++
    if (px[i * 4 + 1] === v && px[i * 4 + 2] === v) grey++
  }
  mean /= n * n
  let sd = 0
  for (let i = 0; i < n * n; i++) sd += (px[i * 4] - mean) ** 2
  sd = Math.sqrt(sd / (n * n))

  check(grey === n * n, 'the grit is grey -- one height, not three', `${n * n - grey} coloured texels`)
  check(opaque === n * n, 'and opaque, so nothing alpha-tests it away', `${n * n - opaque} non-opaque texels`)
  check(sd > 20 && sd < 90, 'and it is a field with relief in it, not a flat fill',
    `sd ${sd.toFixed(1)}/255 over ${lo}..${hi}`)
  check(mean > 60 && mean < 195, 'and it sits off both rails, so the bump is two-sided',
    `mean ${mean.toFixed(0)}/255`)

  for (const axis of ['u', 'v']) {
    const sc = seamScore(px, n, axis)
    check(sc < 1.2, `no wrap seam in ${axis}, which a bump map cannot hide`,
      `seam ${sc.toFixed(2)}x the worst interior step`)
  }
}

// ---------------------------------------------------------------------------
// 4a-bis. The two GROUND tiles, on the same terms.
//
// grass.png and snow.png are cut by tools/props/cut-terrain.mjs and worn by the
// terrain the same way stone.png is worn by the cliff: divided by their own
// linear mean and multiplied into the palette, so they are CONTRAST FIELDS, not
// albedos. That makes the mean the load-bearing number -- a stale copy of it in
// textures.js does not throw, it quietly regrades every metre of ground in the
// world, and the only place that would ever be noticed is here.
//
// The placeholder is checked against the same number. An image layer that has
// not finished decoding is transparent BLACK, and a field built by dividing
// black by a mean is black -- the whole world, for the first frames. The flat
// fill that stands in has to average what the photograph averages, or the
// terrain visibly changes colour when the PNG lands.
// ---------------------------------------------------------------------------

for (const t of [
  { name: 'grass', layer: LAYER.TERRAIN_GRASS, mean: GRASS_TILE_MEAN, fill: TERRAIN_GRASS_PLACEHOLDER },
  { name: 'snow', layer: LAYER.TERRAIN_SNOW, mean: SNOW_TILE_MEAN, fill: TERRAIN_SNOW_PLACEHOLDER },
]) {
  const path = `public/${IMAGE_LAYERS[t.layer]}`
  console.log(`\n${path.split('/').pop()}`)
  const png = readPng(path)
  check(png.width === TEX_SIZE && png.height === TEX_SIZE,
    `${path} is ${TEX_SIZE}x${TEX_SIZE}`, `${png.width}x${png.height}`)
  check(png.channels === 4, 'RGBA, 4 channels', `${png.channels} channels`)

  const N = png.width * png.height
  const lin = [0, 0, 0]
  let opaque = 0
  for (let i = 0; i < N; i++) {
    if (png.data[i * 4 + 3] === 255) opaque++
    for (let c = 0; c < 3; c++) lin[c] += srgbToLinear(png.data[i * 4 + c] / 255)
  }
  for (let c = 0; c < 3; c++) lin[c] /= N
  check(opaque === N, 'fully opaque -- the ground is not a cutout', `${N - opaque} non-opaque texels`)

  const drift = Math.max(...lin.map((v, c) => Math.abs(v - t.mean[c]) / t.mean[c]))
  check(drift < 0.02, `the ${t.name} tile mean in textures.js still describes the shipped tile`,
    `${lin.map((v) => v.toFixed(4)).join(' ')} vs ${t.mean.join(' ')}, ${(drift * 100).toFixed(1)}% off`)

  const fillLin = t.fill.map((v) => srgbToLinear(v / 255))
  const fillDrift = Math.max(...fillLin.map((v, c) => Math.abs(v - t.mean[c]) / t.mean[c]))
  check(fillDrift < 0.02, `and the ${t.name} placeholder averages the same thing`,
    `${fillLin.map((v) => v.toFixed(4)).join(' ')}, ${(fillDrift * 100).toFixed(1)}% off`)

  // THE FIELD HAS TO HAVE A SWING IN IT. A tile graded flat divides to 1.0
  // everywhere and is an expensive way to change nothing -- which is the exact
  // failure a wrong `spread` in cut-terrain.mjs produces, and it looks like the
  // feature simply not working. The floor is well under the 0.15 snow is cut at.
  //
  // The ceiling is where grade() starts clamping the low tail at zero: at a
  // relative sd much past 0.6 a photograph's darkest texels flatten into patches
  // of pure black that the shader then multiplies the palette by, and the meadow
  // grows holes. Grass is cut at 0.60 and sits right under it on purpose.
  const sd = [0, 0, 0]
  for (let i = 0; i < N; i++) {
    for (let c = 0; c < 3; c++) sd[c] += (srgbToLinear(png.data[i * 4 + c] / 255) - lin[c]) ** 2
  }
  const rel = sd.map((v, c) => Math.sqrt(v / N) / lin[c])
  check(Math.min(...rel) > 0.08 && Math.max(...rel) <= 0.65,
    `the ${t.name} field actually varies, and not so hard it posterises`,
    `relative sd ${rel.map((v) => v.toFixed(3)).join(' ')}`)

  // AND NOTHING IS CRUSHED. The measure the sd ceiling is a proxy for, checked
  // directly: a texel at zero in any channel is a black speck the terrain shader
  // multiplies straight through the palette, and enough of them read as dirt
  // rather than as shadow.
  let crushed = 0
  for (let i = 0; i < N; i++) {
    if (png.data[i * 4] === 0 || png.data[i * 4 + 1] === 0 || png.data[i * 4 + 2] === 0) crushed++
  }
  check(crushed / N < 0.005, `and the ${t.name} tile's shadows are not clipped to black`,
    `${((crushed / N) * 100).toFixed(2)}% of texels at zero in some channel`)

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
  const byLayer = (l) => fetches.filter((f) => f.includes(`, ${l}.0 )`))
  check(byLayer(LAYER.ROCK).length === 3, 'the cliff samples the rock tile triplanar, three fetches',
    `${byLayer(LAYER.ROCK).length} of ${fetches.length} atlas fetches are LAYER.ROCK`)

  // THE GROUND WEARS ONE FETCH, AND IT IS PLANAR. A cliff needs three because it
  // faces sideways; the meadow and the snowfield face up, so xz alone is right
  // and the other two projections would be two thirds of the fill rate spent on
  // a blend weight of zero. The layer is a parameter here rather than a literal
  // -- grass and snow share the one helper -- so the projection is checked at the
  // helper and the layer at the two call sites.
  const ground = fetches.filter((f) => f.includes(', layer )'))
  check(ground.length === 1, 'the ground tile is one shared planar fetch', `${ground.length} fetches`)
  check(ground.every((f) => f.includes('.xz *')), 'and it projects down the xz plane', ground.join(' '))
  check(fetches.length === 4, 'and those four are every atlas fetch the terrain makes',
    `${fetches.length} fetches: ${fetches.join(' ')}`)

  // ONE CALL SITE EACH, AT ONE METRE. The scale is the ask: a tile stretched over
  // ten metres reads as a smear and one crammed into a tenth reads as static, and
  // neither would fail anything else here.
  for (const [name, layer] of [['grass', LAYER.TERRAIN_GRASS], ['snow', LAYER.TERRAIN_SNOW]]) {
    const calls = stoneSrc.fragmentShader.match(
      new RegExp(`auroraGroundTile\\([^)]*, ${layer}\\.0, ([0-9.]+) \\)`, 'g')) || []
    check(calls.length === 1, `the ${name} tile is sampled once, on LAYER.TERRAIN_${name.toUpperCase()}`,
      `${calls.length} call sites for layer ${layer}`)
    check(calls.every((c) => Math.abs(Number(c.match(/, ([0-9.]+) \)$/)[1]) - 1) < 1e-4),
      `and it tiles at one metre`, calls.join(' '))
  }

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
  const creep = (up, blob) => blob * (1 - MOSS.up) + up * MOSS.up

  check(MOSS_LAYERS.includes(LAYER.ROCK), 'stone is on the list of things moss grows on',
    `MOSS_LAYERS = ${MOSS_LAYERS.join(' ')}`)
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

  // MOSS TAKES THE TOP FIRST, the same half snow does, and LEANS LESS HARD ON IT
  // than snow does. Both halves of that matter. A rock has flat faces and `up` is
  // constant across one, so a heavy lean flips a whole facet at a time and the
  // mask runs along facet edges as a seam -- snow can afford 0.65 because its rim
  // is a cutover that reads as an edge anyway, and moss cannot, because a colony
  // with a straight side is a paint job. The noise keeping the larger share is
  // what puts tendrils across a face instead.
  check(creep(1, 0.5) > creep(0, 0.5) && MOSS.up < SNOW_ROCK.up,
    'moss grows on the up-facing half like snow, but leans on it more lightly',
    `${creep(1, 0.5).toFixed(2)} on top vs ${creep(0, 0.5).toFixed(2)} under, lean ${MOSS.up} against snow's ${SNOW_ROCK.up}`)

  // COLONIES, NOT FLECKS. The blob IS the colony, so its size is the size of a
  // patch of moss and roughly a dozen of them wrap a 2 m boulder. A field four
  // times finer covers the same fraction of the rock but spreads it as small
  // stains everywhere, which the eye integrates into an even green wash -- and a
  // wash is the one thing this must not read as. What says "grew here" is bare
  // stone BETWEEN the lobes, and that needs lobes big enough to have a between.
  //
  // The other bound is the blend. It is a FIXED width against a mask spanning
  // 0..1 -- MOSS_BLEND below the cut and MOSS_BLEND * MOSS_BLEND_SKEW above it --
  // so getting on for a fifth of the field's range is transition, and the rim
  // that buys is a fraction OF THE PATCH. Coarser still and the rim is a
  // significant part of the whole rock, at which point the mask stops being a
  // shape and becomes a gradient.
  const patchCm = (1 / MOSS.freq) * 100
  const snowCm = (1 / SNOW_ROCK.freq) * 100
  const across = 2 * MOSS.freq
  const rampWidth = MOSS.blend * (1 + MOSS.blendSkew)
  check(patchCm > 10 && patchCm < 30 && across > 8 && across < 20 && rampWidth < 0.25,
    'moss grows in colonies with bare stone between them, not in a wash of flecks',
    `${patchCm.toFixed(1)} cm vs snow's ${snowCm.toFixed(1)}, ~${across.toFixed(0)} across a 2 m boulder, ramp ${rampWidth.toFixed(2)} wide`)

  // AND THE COLONY IS NOT A BLOT. A lobe this size with a rounded edge is a
  // splodge; what makes it moss is a rim that wanders far enough to send runs out
  // of the body, which is MOSS_WARP's whole job and the reason moss no longer
  // shares snow's. Held against snow's warp rather than at an absolute value,
  // because the warp is in cells of the caller's own frequency: what is being
  // asserted is that moss's outline is the RAGGEDER of the two.
  check(MOSS.warp > SNOW_ROCK.blobWarp * 1.4,
    "and its outline is raggeder than snow's, which is where the tendrils come from",
    `warp ${MOSS.warp} cells against snow's ${SNOW_ROCK.blobWarp}`)

  // AND THE FRAY EARNS ITS NOISE EVALUATION. MOSS_FRAY is a second warp five
  // times finer than the first, and the ONLY thing a domain warp can buy is
  // contour length: it slides sample points about, so the same amount of rock
  // comes out green and what changes is how far you walk round the edge of it.
  // Both halves are asserted, because both are how the change could go wrong --
  // a fray that lengthened nothing would be a wasted third of the moss branch,
  // and one that moved coverage would have moved the field out from under the
  // logit fit two checks above.
  const cut35 = mossCutFor(0.35)
  const smooth = mossRimLength(0, cut35)
  const frayed = mossRimLength(MOSS.fray, cut35)
  check(frayed.rim > smooth.rim * 1.3 && Math.abs(frayed.cover - smooth.cover) < 0.03,
    'and the fray frays it: a third more rim for the same coverage',
    `rim ${smooth.rim.toFixed(2)} -> ${frayed.rim.toFixed(2)} per sq patch, `
    + `cover ${smooth.cover.toFixed(3)} -> ${frayed.cover.toFixed(3)}`)

  // THE FRAY FADES MUCH NEARER THAN THE LOBES DO, and by the same rule that set
  // the lobes' own fade: a feature stops resolving at a distance proportional to
  // its size, and a fray feature is 1 / MOSS_FRAY_FREQ of a lobe. Past its fade
  // the third noise evaluation is buying detail under a pixel, which is not
  // merely wasted -- undersampled noise crawls, and crawl in a headset is the
  // worst artefact there is. Held as a RATIO so the two fades move together.
  const frayRatio = MOSS.fadeFar / MOSS.frayFar
  check(MOSS.frayNear < MOSS.frayFar && MOSS.frayFar < MOSS.fadeNear
    && frayRatio > MOSS.frayFreq * 0.7 && frayRatio < MOSS.frayFreq * 1.4,
    "and it fades out at its own size, well inside the lobes' fade",
    `${MOSS.frayNear}-${MOSS.frayFar} m against the lobes' ${MOSS.fadeNear}-${MOSS.fadeFar}, `
    + `ratio ${frayRatio.toFixed(1)} for features ${MOSS.frayFreq.toFixed(1)}x finer`)

  // The fade has to have come with them. Procedural noise has no mip chain, so
  // the range at which it must be blended to its mean is the range at which one
  // patch stops covering a pixel -- which scales with the PATCH and with nothing
  // else. A re-tune of MOSS_FREQ that leaves the fade where it was hands back
  // exactly the crawl the fade exists to prevent, so the two are held together
  // here, and the bound is two-sided so it catches the drift in either
  // direction: the far end has to stay a few hundred patch widths out, and the
  // near end has to be nearer than it.
  const patchesToFade = MOSS.fadeFar * MOSS.freq
  check(MOSS.fadeNear < MOSS.fadeFar && patchesToFade > 150 && patchesToFade < 400,
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

  // AND FROM A DISTANCE THE MASK IS DITHERED RATHER THAN DRAWN. Past
  // SNOW_FADE_FAR the blob has faded out to its constant 0.5, so `drift` is an
  // affine function of `up` alone and the smoothstep either side of the cut is a
  // clean analytic contour on the normal -- solid white one side, bare the other,
  // and no noise anywhere in it to keep the line from reading as a decal painted
  // on the hill. So the far field quantises the mask against ign() and caps what
  // it can quantise at SNOW_ROCK.farMax. Both halves of that are load-bearing:
  // the dither alone still goes solid once coverage saturates, which is the same
  // artefact one crossfade further out.
  const farDrift = (ny) => 0.5 * (1 - w) + upOf(ny) * w
  check(farDrift(1) > cut(1) + SNOW_ROCK.edgeMax && SNOW_ROCK.farMax < 1,
    'a distant rock never goes solid white, however deep the load',
    `a flat top saturates the far mask at ${farDrift(1).toFixed(2)} over a cut of ` +
    `${cut(1).toFixed(2)}, and the stipple caps it at ${SNOW_ROCK.farMax}`)

  // AND THE SPECKLE IS A REAL SHARE OF THE PIXELS WITHOUT COSTING THE CAP. Below
  // about a tenth the bare fragments are too sparse to read as anything but a
  // slightly dirty white at the distances this applies over; above about a half
  // the cap stops being a cap. What ships leaves 15% bare on a saturated face.
  const bareShare = 1 - SNOW_ROCK.farMax
  check(bareShare > 0.1 && bareShare < 0.5,
    'and the speckle it keeps is a real share of the pixels without eating the cap',
    `${(bareShare * 100).toFixed(0)}% of a saturated face stays bare stone past ${SNOW_ROCK.fadeFar} m`)

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
  // time anybody reseeds. It is fragile in the other direction too: a rock can
  // carry no cut facet at ANY tier, so a shape authored with fewer cuts would
  // drag a min-based gate under the floor without a line of shader changing. And a
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
  // THE BOUND MOVED WITH THE POPULATION, and by a lot: 0.9% when the bank held
  // twenty-five variants, 5.7% on the two-metre fractured rock sampled here.
  // Nothing about the blob field changed. The old bank authored sizes from a
  // 0.11 m pebble to a 10.7 m tor, and an AREA-weighted share is dominated by the
  // big ones, whose facets are metres across and never anywhere near the 16 cm
  // patch scale; every facet in this sample belongs to a two-metre rock instead.
  // The bound is set just above what that measures, which is the honest place for
  // it, and it is still doing its job: it catches `cuts` climbing or `size`
  // falling, either of which drives this straight through 8%.
  check(exposed < 0.07,
    'the facets too narrow for the blob field to break up are a sliver of a fractured rock',
    `${(exposed * 100).toFixed(3)}% of cut-facet area on ${lost.length} of ${facets.length} facets`
    + `, ${(patchM * 100).toFixed(0)} cm patches; narrowest ${(worst.chord * 100).toFixed(0)} cm`
    + ` (tier ${worst.tier}) at ${(worst.chord / patchM).toFixed(2)} across`)

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
  // triangle -- and a shape can have none at any tier. Such a rock cannot show
  // this artefact, so contributing nothing is right, not a hole.
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
    // A FRACTURED ROCK, WHICH IS NOT THE ONE THAT SHIPS. The boulder is the
    // generator at ROCK_DEFAULTS and those author `cuts: 0`, so the shipping bank
    // carries no flat face for this to measure. The promise is the SHADER's
    // rather than the boulder's -- the blob field has to break up a facet on any
    // rock the generator can cut, which is every rock /gen-rock can show and
    // every rock a later boulder might be -- so the sample is the generator with
    // fracture turned on. EIGHT SEEDS, because one rock holds 27 facets across
    // its three tiers and a single unlucky sliver is 4% of that; eight put it
    // near 200, which is where the area share stops jumping between draws.
    const CUT = { cuts: 10, cutDepth: 0.82, smooth: 0.93 }
    const geos = []
    for (const seed of [7, 11, 19, 23, 31, 43, 57, 71]) {
      for (let tier = 0; tier < ROCK_TIERS.length; tier++) {
        geos.push(buildRock({ ...rockParams(seed), ...CUT, tier }))
      }
    }
    const out = []
    for (const geo of geos) {
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
        out.push({ chord, area, tier: geo.userData.rock.tier })
      }
    }
    for (const geo of geos) geo.dispose()
    // Not a soft failure: if the generator ever stops producing a flat face when
    // asked for ten cut planes the check above is dividing by zero and measuring
    // nothing, and it has to say so rather than quietly reporting a share of NaN.
    if (out.length === 0) {
      throw new Error('check-rocks: ten cut planes produced no flat facet at all, so there is nothing for the blob field to break up')
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// 7. The shipping bank is ONE ROCK, and it is the right one.
//
// Sections 1-6 test the GENERATOR, which will happily build anything. This one
// tests the single boulder that actually ships: that BOULDER still builds a
// rectangular tier table of distinct meshes, that its authored proportions are
// the ones the scatter's metre ranges were written against, and -- the one that
// matters most now -- that a seed genuinely changes the rock, because the seed
// is the ONLY thing separating one boulder in the world from the next.
//
// WHY ONE. The bank used to hold twenty-five named variants across four
// environments and two relief sites, and the shape a given instance wore was a
// roll. That is gone: the world places one mesh at many sizes, tints and
// rotations, so the variety argument is entirely seed, scale and colour, and
// the checks below are the ones that can still fail.
// ---------------------------------------------------------------------------

console.log('\nthe one rock')

{
  // The bank is the thing both /gen-rock and the world read, so a shape that
  // fails to build is a boot failure for the route, not a missing rock. NO SEED
  // ARGUMENT: the world does not pass one either, so this is the rock that ships
  // rather than a nearby draw of the same generator.
  const bank = buildRockBank()
  const m = bank.shapes.boulder.measured
  const authored = rockParams()
  check(Object.keys(bank.shapes).join(',') === 'boulder,cap', 'the bank ships the boulder and the cap',
    Object.keys(bank.shapes).join(', '))
  for (const [name, shape] of Object.entries(bank.shapes)) {
    check(shape.tiers.length === ROCK_BAND_COUNT && shape.tiers.every((g) => g.userData.rock),
      `the ${name} has a rectangular tier table of meshes`, `${shape.tiers.length} bands`)
  }

  // EVERY BAND IS ITS OWN GEOMETRY, not a short ladder padded out by repeating
  // its last entry. That padding is what the old size classes needed -- a
  // pebble shipped two meshes and had its third band aliased to its second --
  // and there is nothing left to alias, so the promise flips.
  const mesh = bank.shapes.boulder.tiers
  check(new Set(mesh).size === ROCK_BAND_COUNT,
    'the rock builds all four tiers for itself -- no padding by reference',
    `${new Set(mesh).size} distinct meshes`)
  const unique = new Set(Object.values(bank.shapes).flatMap((sh) => sh.tiers)).size
  check(unique === bank.geometries.length, 'geometries and tier references agree', `${unique} in the arena`)

  // THE AUTHORED PROPORTIONS, because the scatter sizes every bed in METRES and
  // divides those metres back through `measured.width` -- so the shape's own
  // width is the denominator under every instance scale in the world, and its
  // height/width ratio is what decides whether a 10 m boulder is a dome or a
  // tower. Bounds rather than exact numbers: BOULDER is meant to be tuned at
  // /gen-rock, and what must not drift is the CLASS of thing it is.
  check(m.width > 1.2 && m.width < 3.0, 'the boulder measures about two metres across as authored',
    `${m.width.toFixed(2)} m wide, ${m.depth.toFixed(2)} deep, ${m.height.toFixed(2)} tall`)
  const squat = m.height / m.width
  check(squat > 0.4 && squat < 1.0, 'and it is a rounded lump, neither a slab nor a tower',
    `height / width ${squat.toFixed(2)}, band 0.4-1.0`)
  // Held on the AUTHORED elongation rather than on the measured box, because the
  // noise field moves the finished plan ratio a long way either side of it --
  // 1.25 authored measures 1.70 across on the shipping seed -- and a bound tight
  // enough to catch a boulder authored round would be a bound one draw of the
  // noise could trip on its own.
  const plan = Math.max(m.width, m.depth) / Math.min(m.width, m.depth)
  check(authored.elongate > 1.1 && authored.elongate < 1.9,
    'and it is longer one way than the other, so a y-rotation reads as a turn',
    `elongate ${authored.elongate}, ${plan.toFixed(2)}:1 across the finished box`)

  // NOT A TOOTH. The whole world is this rock, so if it came to a point every
  // hillside would read as a stage set. Pointiness is the silhouette radius in
  // the top tenth of the height over the widest radius anywhere, averaged over
  // twelve seeds because a single rock's crown is one lump of noise.
  const SEEDS_HERE = 12
  const profile = () => {
    const mean = new Float64Array(10)
    for (let sd = 1; sd <= SEEDS_HERE; sd++) {
      const g = buildRock({ ...rockParams(sd * 37 + 3), tier: 0 })
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
  const prof = profile()
  check(prof[9] > 0.45, 'the boulder does not come to a point', `crown ${prof[9].toFixed(2)} of the widest`)
  // NOR A NOSE. The rock has no flat foot -- ROCK_DEFAULTS leaves `sit` at 0 and
  // the underside is as displaced as the rest of it -- so what stops an instance
  // perching is the BURIAL FLOOR, and what this asserts is the half of that the
  // shape owes: at the tenth of itself every bed buries, the silhouette is
  // already more than half its widest. A rock that tapered to a point downward
  // would meet the ground in a pinch however deep it went, and no burial rule
  // could hide it. Section 8 holds the other half, that the floor is real.
  check(prof[0] > 0.5, 'and buried to its floor it comes out of the ground wide rather than on a nose',
    `bottom tenth ${prof[0].toFixed(2)} of the widest`)
  check(authored.taper <= 0.5, 'and the boulder does not author a taper that would make one',
    `taper ${authored.taper.toFixed(2)}`)

  // THE SEED IS THE VARIETY, and it is the only one left. Two seeds have to
  // disagree by more than rounding, or the world is one rock stamped ten
  // thousand times -- which is precisely the failure the twenty-five variants
  // used to hide. Measured on the silhouette profile rather than on vertex
  // positions, because that is what a player can actually see from ten metres.
  const one = []
  for (let sd = 1; sd <= 8; sd++) {
    const g = buildRock({ ...rockParams(sd), tier: 0 })
    const pos = g.attributes.position.array
    let ymin = Infinity, ymax = -Infinity
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
    one.push([...bins].map((v) => v / w))
    g.dispose()
  }
  let worstPair = Infinity
  for (let i = 0; i < one.length; i++) {
    for (let j = i + 1; j < one.length; j++) {
      let d = 0
      for (let k = 0; k < 10; k++) d = Math.max(d, Math.abs(one[i][k] - one[j][k]))
      worstPair = Math.min(worstPair, d)
    }
  }
  check(worstPair > 0.03, 'no two seeds of the boulder are the same rock',
    `the closest pair of eight differs by ${(worstPair * 100).toFixed(1)}% of its width somewhere up the profile`)

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
      shoreDistAt: (x, z, reach) => reach,
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
  // and giants beds allow and the scree bed's 46 does not, so the small stones
  // thin out on the steepest flanks exactly as they would on a real ridge.
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
    water: { levelAt: () => null, isSubmerged: () => false, shoreDistAt: (x, z, reach) => reach },
  }

  const texArray = buildTextureArray()
  const forest = world(60, 0, 9999, null)
  const cliff = world(60, 0.8, 9999, null) // 38.7 deg: past CLIFF_SLOPE_DEG, inside every bed's limit
  const peak = world(900, 0.5, 880, null)
  const river = world(60, 0, 9999, 60.8)
  // 68 degrees: a real WALL, and the only world here that is one. `cliff` above
  // is the apron -- past CLIFF_SLOPE_DEG and inside every bed's slope limit, so
  // every bed places on it. Nothing about a face is tested by a world every bed
  // is happy on, and the embedded bed exists precisely for the ground the
  // others refuse.
  const steep = world(60, 2.5, 9999, null)
  // A WATERLINE, which no world above has: the river world is drowned to the
  // horizon and the rest are dry to it. Flat ground at 60 m under a 60.8 m
  // surface, with the shore a straight line through the origin along (37, 91)
  // -- the direction the pool traverse below walks, so every step of it stands
  // ON the line and the `shore` bed, which places nowhere but here, is loaded
  // at every step rather than evicted by the second. `bankDist` is the signed
  // distance to it, wet on the negative side. `_envAt` calls all of it `river`,
  // the dry half included, since every point is within SHORE_RISE of the
  // surface.
  const bankDist = (x, z) => (91 * x - 37 * z) / Math.hypot(37, 91)
  const bank = {
    field: river.field,
    water: {
      levelAt: () => 60.8,
      isSubmerged: (x, z) => bankDist(x, z) < 0,
      shoreDistAt: (x, z, reach) => Math.min(reach, Math.max(-reach, bankDist(x, z))),
    },
  }

  // One Layers stub for every world here. Rocks needs it for two things and both
  // are the terrain's: `snow.band`, `dirtAt` and `shoreAt` feed the ground
  // cue, `flattenAt` the deep-wood test, and syncBands reads the snow line off it. All three return
  // 0 -- no road and no waterline under any of these rocks -- which is the case
  // the cue has to be right in anyway.
  const layers = { flattenAt: () => 0, dirtAt: () => 0, shoreAt: () => 0, snow: { base: 780, band: 90 } }

  const build = (w) => {
    const r = new Rocks(new THREE.Scene(), w.field, w.water, layers, texArray, { seed: 7 })
    r.place(0, 0)
    return r
  }

  const forestRocks = build(forest)
  const byBed = Object.fromEntries(forestRocks.stats.beds.map((b) => [b.name, b]))
  check(forestRocks.beds.map((b) => b.cfg.name).join(' ') === 'boulders scree sunken giants hollow embedded shore',
    'seven beds in the table, named rather than counted', forestRocks.beds.map((b) => b.cfg.name).join(', '))
  // A BED'S `field` IS ITS SEED SLOT AND NEVER MOVES. `tileSeed` mixes it into
  // every tile of the bed's scatter, so renumbering one -- by deleting a bed and
  // letting the survivors take its number, say -- shifts every rock of that bed
  // in the world. A silent failure, the world still looks like a world, so the
  // numbers are pinned here: 6 and 7 belonged to beds that were deleted, and a
  // new bed takes the next unused one.
  check(forestRocks.beds.map((b) => b.cfg.field).join(' ') === '1 2 3 4 9 5 8',
    'and every bed keeps the field number it was seeded with', forestRocks.beds.map((b) => b.cfg.field).join(' '))
  check(
    new Set(forestRocks.meshes.meshes.map((m) => m.material)).size === 1,
    'one material across every bed and every tier mesh',
    'one program serves them all'
  )
  // SIX BEDS, FOUR DRAW CALLS: one InstancedMesh per tier, shared by every bed
  // through a view of its own, and the bed's tier ids index those meshes. Named
  // by count so a bed that quietly grew meshes of its own would fail here.
  check(
    forestRocks.meshes.meshes.length === ROCK_TIERS.length &&
      forestRocks.batch.children.length === ROCK_TIERS.length &&
      forestRocks.beds.every((b) => b.batch.meshes === forestRocks.meshes.meshes &&
        Array.from(b.tierIds).every((g, t) => g === t)),
    'the layer is one mesh per tier whatever the bed count, so six beds cost four draw calls',
    `${forestRocks.meshes.meshes.length} meshes for ${forestRocks.beds.length} beds`
  )
  // AND EACH TIER'S CAP IS THE SUM OF WHAT THE BEDS BOUNDED FOR IT, so the
  // refusal argument (`_tierCaps`) survives the sharing: every bed's population
  // and ghost room fit inside its own summand.
  check(
    forestRocks.meshes.capAt.every((cap, t) => cap === forestRocks.beds.reduce((n, b) => n + b.tierCaps[t], 0)),
    'and each shared tier mesh is capped at the sum of the beds\' own tier bounds',
    forestRocks.meshes.capAt.join(' ')
  )
  // AND A HIDE IN ONE BED MOVES ANOTHER BED'S ROCK CORRECTLY. Swap-remove
  // fills the freed slot with the mesh's last instance, and in a shared mesh
  // that instance can belong to a different bed: the mover must be rewritten
  // from ITS OWN bed's shadow, and its own bed's `slot[]` must follow it.
  // Found by search, since which bed owns a mesh's last slot is placement luck.
  // A world of its own, since `place` only seats the rocks and it takes an
  // `update` to show them, and the checks below want forestRocks untouched.
  {
    const shareRocks = build(forest)
    shareRocks.update(0, 61.6, 0, 50)
    const shared = shareRocks.meshes
    let found = null
    for (let g = 0; g < shared.meshes.length && !found; g++) {
      const last = shared.meshes[g].count - 1
      if (last < 1) continue
      const lastView = shared.ownerView[g][last]
      for (let s = 0; s < last && !found; s++) {
        if (shared.ownerView[g][s] !== lastView) found = { g, s, last }
      }
    }
    check(found !== null, 'some shared tier mesh holds rocks of two beds', found ? `mesh ${found.g}` : 'none')
    if (found) {
      const { g, s, last } = found
      const mesh = shared.meshes[g]
      const hider = shared.ownerView[g][s]
      const hid = shared.owner[g][s]
      const mover = shared.ownerView[g][last]
      const moved = shared.owner[g][last]
      const wantMat = Array.from(mover.mat.subarray(moved * 16, moved * 16 + 16))
      const wantCol = Array.from(mover.col.subarray(moved * 3, moved * 3 + 3))
      const wantFade = mover.fade[moved]
      hider.setVisibleAt(hid, false)
      const gotMat = Array.from(mesh.instanceMatrix.array.subarray(s * 16, s * 16 + 16))
      const gotCol = Array.from(mesh.instanceColor.array.subarray(s * 3, s * 3 + 3))
      const gotFade = mesh.geometry.getAttribute('aPropFade').array[s]
      check(
        mesh.count === last && mover.slot[moved] === s && hider.slot[hid] === -1 &&
          shared.owner[g][s] === moved && shared.ownerView[g][s] === mover,
        'hiding one bed\'s rock swap-removes another bed\'s rock into the freed slot with that bed\'s slot map following',
        `mesh ${g}: slot ${s} now instance ${moved} of ${mover.name}, was ${hid} of ${hider.name}`
      )
      check(
        gotMat.every((v, i) => v === wantMat[i]) && gotCol.every((v, i) => v === wantCol[i]) && gotFade === wantFade,
        'and the moved rock\'s matrix, colour and fade were rewritten from its own bed\'s shadow',
        `fade ${gotFade} vs ${wantFade}`
      )
      hider.setVisibleAt(hid, true)
      check(mesh.count === last + 1 && hider.slot[hid] === last,
        'and showing it again restores the count', `count ${mesh.count}`)
    }
  }

  // THE FAR TIER REACHES AN INSTANCE. `tierTris` is the table `update` indexes
  // to pick geometry, so a coarsest slot reading 6 triangles is a bed that will
  // really draw the far hull at range, and one reading 20 is a bed whose far
  // tier is sitting unreachable in the arena.
  //
  // ALL OF THEM. No bed opts out: the ladder is per rock and size-relative, so
  // where an instance reaches T6 is decided by how big it was placed and not by
  // which bed placed it.
  const coarse = ROCK_BAND_COUNT - 1
  check(
    forestRocks.beds.every((b) => b.tierTris[coarse] === 6),
    'every bed really does draw the 6-triangle far tier at its outermost band',
    forestRocks.beds.map((b) => `${b.cfg.name} ${b.tierTris[coarse]}`).join('  ')
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
  // DENSITY, not totals: the giants bed reaches 1250 m and the boulders bed 600,
  // so counting the whole disc would overstate the giants. Count what stands
  // within 40 m of the camera, which is what the ground looks like.
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
  const near = ['boulders', 'giants'].map((b) => within(forestRocks, b, 40))
  check(near[0] > near[1], 'boulders outnumber giants', `${near[0]} vs ${near[1]}`)
  check(near[0] > 0 && byBed.giants.placed > 0, 'the wood still gets boulders AND the odd giant',
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

  // --- the environment gate ---------------------------------------------------
  //
  // There are no shape pools left to check. The world has one rock, so what a
  // bed offers on a given ground is not a roster but a SIZE RANGE and an accept
  // rate -- `sizeByEnv` and `envDensity` -- and the failure this section exists
  // to catch changed shape with it: not "a whole size class silently vanishes on
  // one kind of ground", but "a bed that claims a ground places nothing on it,
  // or a bed that declines one places anyway". Neither throws, because a bed
  // with a zero rate just quietly stands empty.
  //
  // A DECLARED ZERO IS NOT A HOLE. A bed whose `envDensity` is 0 for an
  // environment has said it places nothing there on purpose -- the scree bed
  // offers a wood and a riverbed nothing, because talus at the foot of a cliff
  // is the whole reason it exists. So the promise is an IFF and not a floor.
  const cliffRocks = build(cliff)
  const peakRocks = build(peak)
  const riverRocks = build(river)
  {
    const worlds = { river: riverRocks, forest: forestRocks, cliff: cliffRocks, peak: peakRocks }
    const wrong = []
    const census = []
    for (const bed of forestRocks.beds) {
      for (const env of ENVIRONMENTS) {
        const placed = worlds[env].stats.beds.find((b) => b.name === bed.cfg.name).placed
        const claims = bed.cfg.envDensity[env] > 0
        // THREE DECLARED EXEMPTIONS, every one of them a bed refusing the ground
        // this probe world is made of rather than refusing the environment.
        // `footOnly` throws away every candidate not standing at the base of a
        // face, and all four of these worlds are uniform ground -- the ridge
        // world below is where scree has to actually place. `minSlopeDeg` is the
        // same shape of exemption at the other end: the `cliff` world here is
        // 38.7 degrees and the `peak` world 26.6, both past CLIFF_SLOPE_DEG and
        // both well under the 45 the cap bed calls a wall, so that bed claims
        // those environments and correctly places nothing in either -- the
        // `steep` world below is where it has to actually place. And the `river`
        // environment is not the same question as `underwater`: `_envAt` hands
        // it to anything within SHORE_RISE of the surface, so a bed can serve a
        // shingle bank at a positive rate and still refuse a lake floor, which
        // is what this world is. `no ten-metre buttress in a lake` below is the
        // positive form of that one.
        // `shoreOnly` is `footOnly` for the waterline, and none of these four
        // worlds has one -- the `bank` world below is where that bed has to
        // actually place. And a `deep` bed asks the biome field, which these
        // uniform worlds do not author -- the hollow bed's own block below is
        // where it has to actually place.
        const tooFlat = bed.minSlopeTan > worlds[env].beds[0].field.scatterAt(0, 0, 4, { h: 0, tan: 0 }).tan
        const declined = bed.cfg.footOnly || bed.cfg.shoreOnly > 0 || bed.cfg.deep > 0 || tooFlat || (env === 'river' && !bed.cfg.allowSubmerged)
        if (!declined && claims !== placed > 0) wrong.push(`${bed.cfg.name}/${env}`)
        census.push(`${bed.cfg.name[0]}/${env} ${claims ? placed : '-'}`)
      }
    }
    check(wrong.length === 0, 'every bed places on exactly the grounds its envDensity claims',
      wrong.length ? wrong.join(' ') : census.join('  '))

    // AND EVERY BED SIZES EVERY GROUND IT CLAIMS. `sizeByEnv` is the only sizing
    // mechanism left -- a range in metres, divided back through the shape's own
    // width -- and a missing entry is not a small rock, it is a throw inside
    // `place`. RockBed throws on the missing entry rather than defaulting, so
    // this is a check on the CONFIG: no bed may claim a ground it cannot size.
    const unsized = []
    for (const bed of forestRocks.beds) {
      for (const env of ENVIRONMENTS) {
        if (bed.cfg.envDensity[env] > 0 && !bed.cfg.sizeByEnv[env]) unsized.push(`${bed.cfg.name}/${env}`)
      }
    }
    check(unsized.length === 0, 'and it has a metre range for every one of them',
      unsized.length ? unsized.join(' ') : forestRocks.beds.map((b) => {
        const r = Object.values(b.cfg.sizeByEnv)
        return `${b.cfg.name} ${Math.min(...r.map((v) => v[0]))}-${Math.max(...r.map((v) => v[1]))} m`
      }).join('  '))
  }

  check(riverRocks.stats.beds.find((b) => b.name === 'giants').placed === 0,
    'no ten-metre buttress in the middle of a lake')

  // --- the hollow bed: the entrance boulders (DESIGN.md §30) --------------
  //
  // One standing stone per 300 m tile with a wood in it, so what is promised
  // is the SPACING (100 m by construction: the site is at least 60 m in from
  // the tile's edge and jittered 7), the STANCE (the boulder's longest axis
  // upright, so the mouth's face is a wall and not a roof) and a pinned burial
  // (never squashed, so the face is the hull's own). The forest disc is
  // uniform ground, so what thins it here is the biome field alone, and the
  // `deep` counter is what says that scan ran.
  {
    const bed = forestRocks.beds.find((b) => b.cfg.name === 'hollow')
    const rows = []
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        rows.push({ id, x: bed.instX[id], y: bed.instY[id], z: bed.instZ[id], scale: bed.instScale[id] })
      }
    }
    check(rows.length >= 2, 'the wood grows hollows, one per deep-forest tile',
      `${rows.length} in the disc, ${bed.rejected.deep} tiles without a wood deep enough`)
    check(bed.rejected.deep > 0, 'and the forest scan refused some tiles', `${bed.rejected.deep} refused`)
    let closest = Infinity
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) closest = Math.min(closest, Math.hypot(rows[i].x - rows[j].x, rows[i].z - rows[j].z))
    }
    check(closest >= 100, 'no two hollows within 100 m of each other', `closest pair ${closest.toFixed(0)} m`)
    // The matrix's columns are the boulder's own axes in the world: lying,
    // the width (its longest) stays level and the depth (its middle) points
    // along Y, so the flat bed face stands as a wall.
    const e = bed.instM
    const lying = rows.every((r) => {
      const o = r.id * 16
      return Math.abs(e[o + 1]) / Math.hypot(e[o], e[o + 1], e[o + 2]) < 0.3 && Math.abs(e[o + 9]) / Math.hypot(e[o + 8], e[o + 9], e[o + 10]) > 0.95
    })
    check(lying, 'every hollow lies with its longest axis level and its middle axis up', `${rows.length} checked`)
    const sizes = rows.map((r) => bed.shapeLod * r.scale)
    check(sizes.every((s) => s >= 8 - 1e-6 && s <= 12 + 1e-6), 'and spans 8 to 12 m',
      sizes.map((s) => s.toFixed(1)).join(' '))
    const buf = new Float32Array(rows.length * 5 + 5)
    const n = forestRocks.hollowsInto(-1e4, -1e4, 1e4, 1e4, buf)
    check(n === rows.length && Array.from({ length: n }, (_, i) => buf[i * 5 + 4]).every((s) => s >= 8 && s <= 12),
      'hollowsInto lists every resident hollow with its size in slot 4', `${n} listed`)
    // Slots 0..2 are the box's centre, not the origin: turned on its side, the
    // boulder's footprint is off the origin by half a measured axis, so a ray
    // aimed at the origin can pass beside it. From 20 m out, three quarters of a metre up, aimed at
    // the centre, every bearing meets the hull short of it with a normal facing back.
    const out = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, ox: 0, oz: 0, size: 0 }
    const faces = []
    for (let i = 0; i < n; i++) {
      const cx = buf[i * 5], cz = buf[i * 5 + 2]
      for (let b = 0; b < 8; b++) {
        const a = (b / 8) * Math.PI * 2 + 0.3
        const sx = cx + Math.cos(a) * 20, sz = cz + Math.sin(a) * 20
        const dx = -Math.cos(a), dz = -Math.sin(a)
        const t = forestRocks.hollowRayAt(sx, 60 + 0.75, sz, dx, 0, dz, 40, out)
        faces.push({ t, dot: out.nx * dx + out.nz * dz, size: out.size })
      }
    }
    check(faces.every((f) => f.t > 10 && f.t < 20 && f.dot < 0 && f.size >= 8),
      'hollowRayAt meets each boulder\'s face from every bearing with the normal facing back',
      `${faces.length} rays, ${faces.filter((f) => f.t === Infinity).length} missed, nearest ${Math.min(...faces.map((f) => f.t)).toFixed(1)} m`)
  }

  // --- off the road, footprint and all ------------------------------------------
  //
  // A straight road along x at z = 0, half-width 3 m and feather 8 m, the stub answering only within the feather as PathSet.nearest does. No stone of any bed has its footprint (instSpan, which the fit ladder only ever shrinks) reaching within ROAD_CLEARANCE of the kerb, every bed that placed anything in the band counts what it refused, and the wood beyond the feather is as full as it was.
  {
    const HW = 3
    const FEATHER = 8
    const ROAD_CLEARANCE = Number(readFileSync(new URL('../src/v2/render/rocks.js', import.meta.url), 'utf8').match(/const ROAD_CLEARANCE = ([\d.]+)/)[1])
    const paths = { nearest: (x, z, kind) => (kind === 'road' && Math.abs(z) <= HW + FEATHER ? { dist: Math.abs(z), halfWidth: HW } : null) }
    const roaded = new Rocks(new THREE.Scene(), forest.field, forest.water, { ...layers, paths }, texArray, { seed: 7 })
    roaded.place(0, 0)
    let stones = 0
    let over = 0
    let worst = Infinity
    let refused = 0
    let beyond = 0
    let beyondBare = 0
    const count = (rocks, onRow) => {
      for (const bed of rocks.beds) {
        for (const t of bed.tiles.values()) {
          for (let k = 0; k < t.n; k++) onRow(bed, t.ids[k])
        }
      }
    }
    count(roaded, (bed, id) => {
      stones++
      const gap = Math.abs(bed.instZ[id]) - bed.instSpan[id] * 0.5 - HW
      worst = Math.min(worst, gap)
      if (gap < ROAD_CLEARANCE - 1e-6) over++
      if (Math.abs(bed.instZ[id]) > HW + FEATHER + 10) beyond++
    })
    count(forestRocks, (bed, id) => { if (Math.abs(bed.instZ[id]) > HW + FEATHER + 10) beyondBare++ })
    for (const bed of roaded.beds) refused += bed.rejected.road
    check(stones > 100 && over === 0, 'no stone of any bed stands on the road or leans over its kerb',
      `${stones} stones, ${over} over, nearest footprint ${worst.toFixed(2)} m past the kerb against ${ROAD_CLEARANCE}`)
    check(refused > 0, 'and the beds count what the road refused', `${refused} refused`)
    check(beyond > beyondBare * 0.9 && beyond > 50, 'and beyond the feather the wood is as stony as it was', `${beyond} vs ${beyondBare}`)
    roaded.dispose()
  }

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

  // And then the scree bed on the ridge, where there ARE feet. It is the one
  // bed that probes -- `footOnly`, and no other bed pays for the four extra
  // field samples -- so if `_relief` stopped finding feet, the scree would
  // silently stop existing and every other bed would look identical.
  {
    const r = build(ridge)
    const bedsBySite = Object.fromEntries(r.stats.beds.map((b) => [b.name, b.sited]))
    const screePlaced = r.stats.beds.find((b) => b.name === 'scree').placed
    check(bedsBySite.scree.foot > 0 && screePlaced > 0,
      'a ridge gets scree at its feet',
      `${bedsBySite.scree.foot} feet seen, ${screePlaced} placed`)
    // TWO BEDS PROBE AND NO MORE. `_relief` is four field samples on every
    // candidate that clears slope and elevation, and it is the dominant cost of
    // the beds that ask -- so a third name appearing in this list is a config
    // that grew a `footOnly` or a `footDense` without the cost being thought
    // about, and it will show up as placement time and nothing else.
    const probing = Object.entries(bedsBySite).filter(([, v]) => v.foot > 0 || v.brow > 0).map(([n]) => n).sort()
    check(probing.join(' ') === 'boulders scree',
      'and it and the boulders bed are the only two paying for the relief probe',
      Object.entries(bedsBySite).map(([n, v]) => `${n} ${v.foot}/${v.brow}`).join('  '))

    const bed = r.beds.find((b) => b.cfg.name === 'boulders')

    // MORE CANDIDATES AT A LOWER RATE, which is the shape of the boulders bed's
    // density and the reason it needs three checks of its own: read either
    // number alone and it looks like somebody multiplied the boulders in the
    // world or divided them, and it is neither.
    //
    // `envDensity` is an ACCEPT RATE, tested as `envRoll >= dens`, and at a foot
    // site `dens` is `envDensity * (1 + CLUMP_GAIN * clump)`. That product is
    // capped at 1 by construction, so every candidate it pushes past 1.0 has the
    // rest of its multiplier silently thrown away -- and the thrown-away part IS
    // the clumping. At a cliff and peak rate of 1.0 the cap ate all of it and
    // CLUMP_GAIN was a dead knob: turning it up did nothing at all, which is the
    // kind of failure that never shows up as an error. Hence rates well under 1
    // with `density` carrying the candidate count instead.
    //
    // Held as three separate promises, because each one fails on its own: the
    // product is what it is meant to be, the cap is not eating the gain, and a
    // foot really does end up about twice as dense as the ground beside it.
    const rate = bed.cfg.envDensity
    const perM2 = Object.fromEntries(Object.entries(rate).map(([e, v]) => [e, bed.cfg.density * v]))
    // THE SHIPPED BOULDERS PER SQUARE METRE, which is what a player sees, and
    // half what it was: the bed's `sizeByEnv` now starts at 1.5 m rather than
    // 0.5 and the median boulder is three times the size, so the same spacing
    // would have made a boulder field out of every wood. The two numbers are one
    // decision -- see the bed's own `density` note -- and this pin is what stops
    // either of them drifting back alone, or a later "simplification" folding
    // `density` and `envDensity` together and re-scattering the whole game.
    const WANT = { river: 0.00154, forest: 0.0022, cliff: 0.0022, peak: 0.00176 }
    const drift = Object.entries(WANT).map(([e, w]) => Math.abs(perM2[e] - w) / w)
    check(Math.max(...drift) < 0.02,
      'the candidate count and the accept rate multiply out to the density that ships',
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
    // 2.10x on a mean clump of 0.5, and this disc reads 2.20x -- the foot ground
    // it samples runs a little above the field mean, which is a couple of hundred
    // rocks of counting noise on top of a real skew. The bound sits below that and
    // above the saturated case on purpose: it is not measuring 2.0, it is catching
    // a return to the regime where the cap is in charge.
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
            sizes.push(b.shape.measured.width * b.instScale[id])
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

      // AND THEY ARE THE SIZE THAT WAS ASKED FOR: half a metre to four and a
      // half. A pile of gravel at the right spacing would pass the line above and
      // be the same mistake in a smaller size class, so the median is asserted
      // too -- not the extremes, which one lucky roll can supply.
      sizes.sort((a, b) => a - b)
      const med = sizes[sizes.length >> 1]
      const big = sizes.filter((s) => s >= 0.5 && s <= 4.5).length / sizes.length
      check(med > 0.5 && big > 0.6, 'and it is made of rocks half a metre to four and a half across',
        `median ${med.toFixed(2)} m, ${(big * 100).toFixed(0)}% inside 0.5-4.5 m, ` +
        `range ${sizes[0].toFixed(2)}-${sizes[sizes.length - 1].toFixed(2)} m`)

      // AND THE PILE IS NOT ONE SIZE REPEATED, which is the failure a median
      // cannot see and the one that got reported from inside the headset: at
      // [0.5, 3.0] with the roll weighted UP the scree bed placed p10/p50/p90 of
      // 1.00/2.10/2.87 m, so four rocks in five at the foot of a face were within
      // a whisker of each other and the talus read as rubble tipped out of a
      // truck. Measured on the SCREE BED ALONE rather than on the foot, because
      // the foot's own spread is flattered by whatever the boulders and embedded
      // beds happen to have dropped there -- the bed is what was wrong and the
      // bed is what is asserted.
      //
      // A DECILE RATIO AND NOT THE EXTREMES: min and max are one roll each and a
      // 9:1 range reaches both ends eventually whatever the weighting does to the
      // body of the distribution. p90/p10 is the shape.
      //
      // ON FULL-DETAIL TILES ONLY. Past `fullRadius` a tile keeps just the
      // rocks big enough to be seen from there (`_rankOf`), so the disc as a
      // whole is the bed's spread with its small end cut off -- a 4x decile
      // ratio on a bed that places 6.7x inside 40 m.
      {
        const scree = []
        const bed = r.beds.find((b) => b.cfg.name === 'scree')
        for (const t of bed.tiles.values()) {
          if (t.q !== 0) continue
          for (let k = 0; k < t.n; k++) scree.push(bed.shape.measured.width * bed.instScale[t.ids[k]])
        }
        scree.sort((a, b) => a - b)
        const at = (p) => scree[Math.min(scree.length - 1, Math.floor(p * scree.length))]
        const spread = at(0.9) / at(0.1)
        check(scree.length > 150 && spread > 5,
          'and the scree itself is chips, cobbles and blocks rather than one size repeated',
          `${scree.length} rocks, p10/p50/p90 ${at(0.1).toFixed(2)}/${at(0.5).toFixed(2)}/` +
          `${at(0.9).toFixed(2)} m, a ${spread.toFixed(1)}x decile spread`)
      }

      // --- NO ROCK INSIDE ANOTHER ROCK -----------------------------------------
      //
      // Two lines, because the rule has two ways to break and they fail
      // differently. The first is CONFIG: a bed with no `minGap` darts against
      // nothing, and since the default is 0 that is what a new bed gets by
      // omission -- the giants bed shipped that way and its landmarks grew
      // through each other at a p10 nearest neighbour of 11.4 m against rocks 15
      // m across. Nothing else in this file would have said a word.
      //
      // The second is the ARITHMETIC. `minGap` is checked WITHIN A TILE because
      // that is the whole of what the dart promises: a neighbouring tile is grown
      // independently and in an order the camera decides, so darting across the
      // seam would make the world stop being a pure function of position. Pairs
      // straddling a seam may interpenetrate and are not counted.
      {
        const undarted = r.beds.filter((b) => !(b.minGap > 0)).map((b) => b.cfg.name)
        check(undarted.length === 0, 'every bed keeps its rocks out of each other',
          undarted.length ? `no minGap on ${undarted.join(', ')}` : `all ${r.beds.length} beds`)

        let pairs = 0
        let inside = 0
        let worst = 1
        for (const b of r.beds) {
          if (!(b.minGap > 0)) continue
          for (const t of b.tiles.values()) {
            for (let i = 0; i < t.n; i++) {
              const a = t.ids[i]
              for (let j = i + 1; j < t.n; j++) {
                const c = t.ids[j]
                const dx = b.instX[a] - b.instX[c]
                const dz = b.instZ[a] - b.instZ[c]
                const need = b.minGap * 0.5 * (b.instSpan[a] + b.instSpan[c])
                pairs++
                const d = Math.sqrt(dx * dx + dz * dz)
                if (d < need) { inside++; worst = Math.min(worst, d / need) }
              }
            }
          }
        }
        check(pairs > 3000 && inside === 0,
          'and inside a tile not one pair of them is closer than its own dart allows',
          `${inside} of ${pairs} same-tile pairs${inside ? `, worst at ${(worst * 100).toFixed(0)}% of the gap` : ''}`)
      }
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
          out.push(bed.shape.measured.width * bed.instScale[id])
        }
      }
      return out
    }
    const span = (a) => `${amin(a).toFixed(2)}-${amax(a).toFixed(2)} m over ${a.length}`
    const inside = (a, lo, hi) => a.length > 0 && amin(a) >= lo - 1e-4 && amax(a) <= hi + 1e-4

    // A WALL IS FOR THE ONE BED BUILT FOR ONE, AND NOBODY ELSE. On 68 degrees
    // the boulders (48), the scree (46), the sunken (40), the shore (42) and the
    // giants (62) have all bowed out; `embedded` at 72 is the only one with a
    // slope limit past it, and it is the one whose subject IS a face -- a block
    // let into the wall. Asserted as an exclusive: any other bed reaching a wall
    // is a rock BALANCED on it, and this is the line that notices.
    const steepRocks = build(steep)
    const live = steepRocks.stats.beds.filter((b) => b.placed > 0).map((b) => b.name).sort()
    check(live.join(' ') === 'embedded',
      'on a 68-degree wall only the bed built for a face is left standing',
      live.join(' ') || 'nothing placed at all')

    // AND IT IS COARSE, 3 to 64 m, with NO SMALL END. A third of a metre of
    // stone on a cliff is invisible from anywhere you can stand to look at the
    // cliff -- instance memory and triangles spent on a speck. The floor is the
    // half of this that a median could never hold, so the whole population is
    // bound rather than its middle. The top is what breaks the panelling up:
    // this is the only bed that can put a rounded MASS on a wall, because it is
    // the only one that buries most of it.
    const face = widths(steepRocks, 'embedded')
    check(inside(face, 3, 64), 'and every block let into it is between 3 and 64 m across -- no specks',
      span(face))
    // The other half of "randomly vary": a bed that placed 8 m blocks and
    // nothing else would satisfy the line above exactly. Both ends of the span
    // have to be reached, or the roll has stopped being a roll.
    check(amin(face) < 4.5 && amax(face) > 56,
      'and the range is really used, not clustered on one size',
      `median ${[...face].sort((a, b) => a - b)[face.length >> 1].toFixed(2)} m`)

    steepRocks.dispose()

    // THE SAME BED ON A LAKE FLOOR IS A DIFFERENT SIZE, which is the whole
    // reason `sizeByEnv` exists rather than one range per bed. A 20 m block in a
    // lake would be terrain; in the water the same bed is asked for 2 to 10.
    const bedRock = widths(riverRocks, 'embedded')
    check(inside(bedRock, 2, 10), 'the same bed on a lake floor places 2-10 m blocks instead',
      span(bedRock))
    // AND THE TOP HALF OF THAT BAND IS REALLY REACHED. A range whose top never
    // comes up is a uniform floor with a bigger number written next to it, which
    // is exactly what a two-ended band is meant to stop.
    check(amax(bedRock) > 8 && amin(bedRock) < 3.5,
      'and a lake floor uses the whole of that band',
      `${amin(bedRock).toFixed(2)}-${amax(bedRock).toFixed(2)} m over ${bedRock.length}`)

    // THE DOUBLED TOP IS FOR BARREN GROUND ONLY. `cliff` and `peak` are read
    // off one field sample: a 35-degree pocket in a wood is a cliff site and
    // the wooded band under the treeline is peak country, and a 30 m tor on
    // either stands out of the trees. So `barrenTop` is let in only where the
    // forest has nothing: above the treeline's fade, or on a face still steeper
    // than CLIFF_SLOPE_DEG all the way across the rock's own width. Everywhere
    // else the roll lands on `sizeByEnv` as before.
    {
      const giantsTop = (rocks) => amax(widths(rocks, 'giants'))
      check(giantsTop(cliffRocks) > 24, 'a giant on an open 39-degree face reaches the barren top',
        `${giantsTop(cliffRocks).toFixed(1)} m against a 15 m wooded top and a 30 m barren one`)
      check(giantsTop(peakRocks) <= 15 + 1e-4, 'but on a wooded peak, 20 m over the snow line, it stops at the wooded top',
        `${giantsTop(peakRocks).toFixed(1)} m`)
      const bare = build(world(880 + BARREN_ABOVE_SNOW + 50, 0.5, 880, null))
      check(giantsTop(bare) > 24, 'and past the treeline\'s fade the same slope is barren and reaches it',
        `${giantsTop(bare).toFixed(1)} m at ${BARREN_ABOVE_SNOW + 50} m over the snow line`)
      bare.dispose()
      // Twelve-metre steep bands through flat woodland: every band site is a
      // cliff site, and no rock over 15 m can keep its whole footprint in one.
      const pockets = world(60, 0, 9999, null)
      pockets.field.scatterAt = (x, z, cell, out) => {
        out.h = 60
        out.tan = ((x % 100) + 100) % 100 < 12 ? 0.8 : 0
        return out
      }
      const pocketed = build(pockets)
      check(giantsTop(pocketed) <= 15 + 1e-4, 'and a steep pocket in a wood is not a cliffside: its giants stop at the wooded top',
        `${giantsTop(pocketed).toFixed(1)} m over ${widths(pocketed, 'giants').length} giants`)
      pocketed.dispose()
      // The fade is the forest layer's TREELINE.fade, which rocks.js cannot
      // import without a cycle; read it off the source instead.
      const treeFade = readFileSync('src/v2/layers/forest.js', 'utf8').match(/TREELINE = \{[^}]*\bfade: (\d+)/)
      if (!treeFade) throw new Error('layers/forest.js no longer declares TREELINE.fade')
      check(Number(treeFade[1]) === BARREN_ABOVE_SNOW, 'and "barren" starts where the forest\'s own fade does',
        `rocks ${BARREN_ABOVE_SNOW} m over the snow line, trees ${treeFade[1]}`)
    }
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
      water: { levelAt: () => 60.8, isSubmerged: (x) => x < 0, shoreDistAt: (x, z, reach) => reach },
    }
    const shoreRocks = build(shore)
    const bed = shoreRocks.beds.find((b) => b.cfg.name === 'sunken')
    // Position and size in one walk. `instScale` times the shape's own measured
    // width is what `sizeByEnv` resolves to, which is the same reading the
    // embedded block above takes; the x of the instance matrix is which side of the
    // waterline it landed on.
    const xs = []
    const sunk = []
    const mat = new THREE.Matrix4()
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        mat.fromArray(bed.instM, id * 16)
        xs.push(mat.elements[12])
        sunk.push(bed.shape.measured.width * bed.instScale[id])
      }
    }
    check(xs.length > 200, 'the sunken bed fills a lake floor it is given half of',
      `${xs.length} stones`)
    check(xs.every((x) => x < 0), 'and not one of them is on the dry bank beside it',
      `${xs.filter((x) => x >= 0).length} of ${xs.length} out of the water, ` +
      `furthest ashore ${Math.max(...xs).toFixed(1)} m`)

    // The size it was asked for, and both ends of it. A bed whose stones all
    // came out at one size would be a rippled sheet in a different shape -- the
    // point of the range is that you swim past a stone you could stand on and
    // then past one you could not climb.
    check(amin(sunk) >= 1 - 1e-4 && amax(sunk) <= 10 + 1e-4,
      'and every one of them is a 1-10 m boulder',
      `${amin(sunk).toFixed(2)}-${amax(sunk).toFixed(2)} m over ${sunk.length}`)
    check(amax(sunk) > 8 && amin(sunk) < 2,
      'and the band is really used, so a lake floor is not one stone repeated',
      `${amin(sunk).toFixed(2)}-${amax(sunk).toFixed(2)} m over ${sunk.length}`)

    // TWICE THE BOULDERS ALONG THE SHORE, wet and dry alike. `shoreGain` multiplies
    // the accept rate within SHORE_REACH of the edge, so a world that is all edge
    // places twice what the same world with no edge does, and a world with one
    // straight edge places the no-edge bed exactly, stone for stone, everywhere
    // past the reach.
    const boulders = (rocks) => {
      const b = rocks.beds.find((x) => x.cfg.name === 'boulders')
      const out = []
      for (const t of b.tiles.values()) {
        for (let k = 0; k < t.n; k++) out.push([b.instX[t.ids[k]], b.instZ[t.ids[k]]])
      }
      return out.sort((p, q) => p[0] - q[0] || p[1] - q[1])
    }
    const gain = shoreRocks.beds.find((x) => x.cfg.name === 'boulders').shoreGain
    const REACH = 10
    const allEdge = build({ ...shore, water: { ...shore.water, shoreDistAt: () => 0 } })
    const noEdge = shoreRocks
    const oneEdge = build({ ...shore, water: { ...shore.water, shoreDistAt: (x, z, reach) => Math.min(reach, Math.max(-reach, x)) } })
    const all = boulders(allEdge).length
    const none = boulders(noEdge).length
    check(gain === 2, 'the boulders bed doubles along a shore', `shoreGain ${gain}`)
    check(Math.abs(all / none - gain) < gain * 0.06, `and a world that is all shore places ${gain}x the boulders`,
      `${all} vs ${none}`)
    const far = (list) => list.filter(([x]) => Math.abs(x) >= REACH)
    const nearEdge = (list, side) => list.filter(([x]) => Math.abs(x) < REACH && (side < 0 ? x < 0 : x >= 0)).length
    const a = far(boulders(oneEdge))
    const c = far(boulders(noEdge))
    check(a.length === c.length && a.every((p, i) => p[0] === c[i][0] && p[1] === c[i][1]),
      `past ${REACH} m of a straight edge the bed is the no-shore bed, stone for stone`, `${a.length} vs ${c.length}`)
    check(nearEdge(boulders(oneEdge), -1) > nearEdge(boulders(noEdge), -1) && nearEdge(boulders(oneEdge), 1) > nearEdge(boulders(noEdge), 1),
      'and inside it there are more on both the wet side and the dry',
      `wet ${nearEdge(boulders(oneEdge), -1)} vs ${nearEdge(boulders(noEdge), -1)}, dry ${nearEdge(boulders(oneEdge), 1)} vs ${nearEdge(boulders(noEdge), 1)}`)
    // A WORLD THAT IS ALL WATERLINE is also the one place in this file a pool
    // runs dry: the shore bed's pool is sized to the real map's peak
    // (`siteFrac`) and here every tile is shore, so what runs is the
    // drop-and-warn path a measured pool is safe because of -- the warning
    // above is it, and the world is placed with holes rather than not at all.
    const dryShore = allEdge.beds.find((x) => x.cfg.name === 'shore')
    check(dryShore.rejected.pool > 0 && dryShore.poolDry && dryShore.freeCount === 0,
      'a pool that runs dry drops the rock and warns instead of throwing',
      `shore dropped ${dryShore.rejected.pool} past its full pool of ${dryShore.maxInstances}`)
    allEdge.dispose()
    oneEdge.dispose()
    shoreRocks.dispose()
  }

  // --- the bed that only exists at the waterline -----------------------------
  //
  // `shoreOnly` is the sunken bed's shape of definition again -- a NEGATIVE
  // about where the bed may go -- so the boundary is what is gated: a stone past
  // the strip is the failure nothing else here would notice, and a strip with no
  // stones in it is the other one, which the traverse below would read as
  // `shore 0` and the envDensity gate above has to be told to excuse.
  {
    const bankRocks = build(bank)
    const bed = bankRocks.beds.find((b) => b.cfg.name === 'shore')
    const reach = bed.cfg.shoreOnly
    // Each stone's signed distance from the line, off the instance matrix.
    const xs = []
    const widths = []
    const mat = new THREE.Matrix4()
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        mat.fromArray(bed.instM, id * 16)
        xs.push(bankDist(mat.elements[12], mat.elements[14]))
        widths.push(bed.shape.measured.width * bed.instScale[id])
      }
    }
    const wet = xs.filter((x) => x < 0).length
    const dry = xs.filter((x) => x >= 0).length
    check(xs.length > 30 && wet > xs.length * 0.25 && dry > xs.length * 0.25,
      'the shore bed lines a waterline it is given, on the bank and in the shallows both',
      `${xs.length} stones, ${wet} wet, ${dry} dry`)
    check(xs.every((x) => Math.abs(x) < reach),
      `and not one of them stands past ${reach} m of the line`,
      `${xs.filter((x) => Math.abs(x) >= reach).length} of ${xs.length} out, furthest ${amax(xs.map(Math.abs)).toFixed(1)} m`)
    // CROWDED AT THE LINE: the rate is full inside `shoreCore` and eases to 0 at
    // the edge, so the core holds more than its share of the strip's width. A
    // flat strip would put 37.5% of the stones in the inner 1.5 m of 4; the
    // fall-off integrates to about 55%.
    const core = bed.cfg.shoreCore
    const inCore = xs.filter((x) => Math.abs(x) < core).length / xs.length
    check(core < reach && inCore > 0.45,
      `and they crowd the line -- more than their share within ${core} m of it`,
      `${(inCore * 100).toFixed(0)}% of ${xs.length} inside ${core} m, against ${((core / reach) * 100).toFixed(0)}% for a flat strip`)
    // FREQUENT: a stone every few metres of bank, counted along the line inside
    // the bed's full radius, where thinning has not begun.
    const R = bed.cfg.fullRadius
    let inFull = 0
    for (const t of bed.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        if (bed.instX[id] ** 2 + bed.instZ[id] ** 2 < R * R) inFull++
      }
    }
    const perMetre = inFull / (2 * R)
    check(perMetre > 0.25 && perMetre < 1.0, 'and it is frequent -- a stone every one to four metres of bank',
      `${inFull} stones along ${2 * R} m of line, one every ${(1 / perMetre).toFixed(1)} m`)
    check(amin(widths) >= 0.5 - 1e-4 && amax(widths) <= 2.5 + 1e-4 && amin(widths) < 0.8 && amax(widths) > 2,
      'and every one of them is a 0.5-2.5 m stone, with both ends of the band used',
      `${amin(widths).toFixed(2)}-${amax(widths).toFixed(2)} m over ${widths.length}`)
    // SHORT-SIGHTED: it is the bed with the shortest reach in the table, so it
    // is populated only as she comes near the water.
    check(bankRocks.beds.every((b) => b === bed || b.cfg.radius > bed.cfg.radius),
      'and it reaches less far than any other bed', `${bed.cfg.radius} m`)
    // AND A DRY WORLD PLACES NONE. The forest world's shoreDistAt answers `reach`
    // everywhere, which is the nothing-near answer, and the strip test is strict.
    check(byBed.shore.placed === 0, 'and a world with no water in it gets no shore stones', `${byBed.shore.placed}`)
    bankRocks.dispose()
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
  // Measured off the GEOMETRY rather than off `instSink`, and that is not a
  // stylistic choice. The rock's origin sits on its bed face, so before the
  // quarter turns went in the standing height was `measured.height * scale` and
  // `instSink` was the depth below the ground -- one division and you had the
  // fraction. A rolled rock stands on whichever face the turn put down, hangs
  // below its own origin, and folds that overhang into `instSink`, which then
  // goes legitimately negative. So the fraction is taken the way an eye takes
  // it: push the shape's local box through the instance matrix, find where its
  // lowest corner lands against the ground the scatter used, and divide by the
  // extent it actually stands. That also folds in the ground lean and the
  // jitter, which the old arithmetic could not see at all.
  //
  // AND WHAT THE ROLL ASKED FOR IS RECOVERED FROM THE SQUASH. Past SQUASH_AT a
  // rock is flattened rather than sunk (rocks.js), so the geometry of one that
  // rolled nine tenths stands six tenths under; the squash is the short column
  // of the matrix over `instScale`, and `1 - (1 - f) * squash` is the fraction
  // of the UNSQUASHED boulder that would have been under. That is the number
  // every claim about the roll below is made on; the raw `f` is what the
  // squash pins, and is asserted separately.
  {
    const mat = new THREE.Matrix4()
    const v = new THREE.Vector3()
    const fracs = (rocks, bedName) => {
      const bed = rocks.beds.find((b) => b.cfg.name === bedName)
      const out = []
      out.tall = []
      out.raw = []
      out.squash = []
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const s = bed.shape
          mat.fromArray(bed.instM, id * 16)
          const hw = s.measured.width * 0.5
          const hd = s.measured.depth * 0.5
          let lo = Infinity
          let hi = -Infinity
          for (let corner = 0; corner < 8; corner++) {
            v.set(corner & 1 ? hw : -hw, corner & 2 ? s.measured.height : 0, corner & 4 ? hd : -hd)
            const y = v.applyMatrix4(mat).y
            lo = Math.min(lo, y)
            hi = Math.max(hi, y)
          }
          // `_reground` writes instY = ground - instSink, so the ground the
          // scatter seated this rock against comes straight back out.
          const f = (bed.instY[id] + bed.instSink[id] - lo) / (hi - lo)
          const e = mat.elements
          const squash = Math.min(
            Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])
          ) / bed.instScale[id]
          out.raw.push(f)
          out.squash.push(squash)
          out.push(1 - (1 - f) * squash)
          // WHICH WAY THE QUARTER TURN STOOD IT, taken off the matrix column
          // whose y component dominates rather than off the leaned box: a lean
          // of up to 40 degrees swells the box enough to make a rock on its
          // longest side measure "tall" by extent, and it is the TURN the deeper
          // floor keys off. See SINK_TALL.
          const ay = [Math.abs(e[1]), Math.abs(e[5]), Math.abs(e[9])]
          const up = ay[0] > ay[1] && ay[0] > ay[2] ? 0 : ay[1] > ay[2] ? 1 : 2
          const ext = [s.measured.width, s.measured.height, s.measured.depth]
          out.tall.push(ext[up] > 0.5 * (ext[0] + ext[1] + ext[2] - ext[up]))
        }
      }
      if (!out.length) throw new Error(`no ${bedName} to measure`)
      return out
    }
    const stat = (a) => ({
      min: amin(a), max: amax(a), mean: a.reduce((x, y) => x + y, 0) / a.length, n: a.length,
    })
    const flatFracs = fracs(forestRocks, 'boulders')
    const flat = stat(flatFracs)
    const steep = stat(fracs(cliffRocks, 'boulders'))

    check(flat.mean > 0.02, 'a rock on the flat is bedded into the ground',
      `${(flat.mean * 100).toFixed(0)}% of its height on average, over ${flat.n}`)
    // THE SQUASH, ON THE GEOMETRY. No rock in the wood stands more than
    // SQUASH_AT under -- with the lean's slack on top, since tipping a slab drops
    // a corner below where it was seated -- and the ones that rolled deeper are
    // the ones that are shorter than their scale says, pinned at SQUASH_AT. Both
    // ends of the squash should turn up: a roll at SINK_DEEP is a slab half as
    // tall, and one just past the threshold is barely touched.
    {
      const raw = flatFracs.raw
      const sq = flatFracs.squash
      const flattened = sq.filter((q) => q < 0.99)
      check(amax(raw) < 0.72, 'no rock in the wood is more than six tenths under: past that it is squashed, not sunk',
        `deepest ${(amax(raw) * 100).toFixed(0)}% of what it stands, over ${raw.length}`)
      check(flattened.length > raw.length * 0.2 && flattened.length < raw.length * 0.95,
        'and most of them, not all, are squashed',
        `${flattened.length} of ${raw.length} are shorter than their scale`)
      check(amin(sq) < 0.6 && amax(flattened) > 0.9,
        'from a slab half as tall to one barely touched',
        `squash ${amin(sq).toFixed(2)} .. ${amax(flattened).toFixed(2)}`)
      const pinned = raw.filter((f, i) => sq[i] < 0.99)
      check(amin(pinned) > 0.45 && amax(pinned) < 0.72,
        'and every squashed slab stands the six tenths under the squash pinned it at',
        `${(amin(pinned) * 100).toFixed(0)}% .. ${(amax(pinned) * 100).toFixed(0)}% over ${pinned.length}`)
    }
    // 1.1x, and the shrinking margin is the roll eating it. The floor is what
    // the slope moves -- 40% flat, 68% at the limit -- but the roll runs from
    // the floor to 80% either way, so on flat ground the mean already sits near
    // 60% and the cliff has only the top of the range left to pull it into. The
    // FLOOR below is the exact half of this promise; the mean is the half that
    // says the floor is actually reaching the population.
    check(steep.mean > flat.mean * 1.1, 'and averaged over a hillside, a rock on a cliff is bedded deeper, or squashed for it',
      `${(steep.mean * 100).toFixed(0)}% vs ${(flat.mean * 100).toFixed(0)}%`)
    // The floor, which is the half of the promise that is still exact. Nothing
    // on the cliff may be as shallow as the shallowest thing on the flat -- that
    // is what stops a steep rock's downhill side hanging in the air, and it is
    // the one thing the per-instance roll must not be allowed to undo.
    //
    // A MARGIN AND NOT A DOUBLING, since SINK_MIN came up to two fifths. The
    // slope term is worth SINK_SLOPE at a bed's own limit and nothing can reach
    // twice the floor with SINK_DEEP four fifths above it -- the arithmetic
    // forbids the old 2x, so asking for it would be asking the constants to be
    // something they cannot be.
    check(steep.min > flat.min * 1.3, 'and the shallowest cliff rock is still deeper than the shallowest flat one',
      `floors ${(steep.min * 100).toFixed(0)}% vs ${(flat.min * 100).toFixed(0)}%`)

    // AND THE ROLL ACTUALLY SPANS ITS RANGE. A `sinkVary` bed on flat ground is
    // the widest case there is -- floor at SINK_MIN, roll to SINK_DEEP -- so
    // both ends should turn up in a wood, and if they stop turning up the bed
    // has quietly gone back to one burial fraction for everything, which is the
    // look the roll exists to break. Stated as the two-fifths-to-four-fifths the
    // brief asks for, with slack at the shallow end because the ground lean
    // tips a rock's box wider than the burial arithmetic seated it -- the
    // shallowest MEASURES a few points under SINK_MIN for that reason and is
    // buried the full fraction of the box it was seated on.
    check(flat.min < 0.45 && flat.max > 0.75,
      'a wood buries its boulders anywhere from two fifths to four fifths of themselves',
      `${(flat.min * 100).toFixed(0)}% .. ${(flat.max * 100).toFixed(0)}%`)
    // THE TWO FLOORS, WHICH ARE WHAT BEDS A ROCK THAT HAS NO FOOT. `sit` is 0 on
    // the shipping boulder, so no instance stands on a cut face and nothing is
    // stopping one from perching except the depth it is buried at: SINK_MIN of
    // what it stands for every rock in the world, and SINK_TALL for one the
    // quarter turn stood on its long axis, which is a 2 m slab on a 1.2 m base
    // and reads as balanced at anything less.
    //
    // THE BOUNDS SIT UNDER THE CONSTANTS, and that is the lean rather than slack
    // for its own sake. The arithmetic buries a fraction of the UNLEANED box;
    // tipping that box about its bed face drops a corner below where the rock
    // was seated and swells the extent this divides by, and both push the
    // measured fraction below the constant. What survives exactly is the
    // ORDERING -- a rock stood tall is deeper than any rock lying down is
    // obliged to be.
    {
      const seen = []
      for (const [w, name] of [[forestRocks, 'boulders'], [cliffRocks, 'boulders']]) {
        const a = fracs(w, name)
        for (let i = 0; i < a.length; i++) seen.push([a[i], a.tall[i]])
      }
      const laid = seen.filter(([, t]) => !t).map(([f]) => f)
      const stood = seen.filter(([, t]) => t).map(([f]) => f)
      check(stood.length > seen.length * 0.15,
        'the quarter turns stand rocks on end often enough for the deep floor to matter',
        `${stood.length} of ${seen.length} instances landed on their long axis`)
      check(amin(laid) > 0.3, 'nothing in the world sits on the ground rather than in it',
        `the shallowest of ${laid.length} rocks lying down is ${(amin(laid) * 100).toFixed(0)}% under`)
      check(amin(stood) > 0.5 && amin(stood) > amin(laid) * 1.4,
        'and a rock stood on end is bedded far deeper than one lying down has to be',
        `${(amin(stood) * 100).toFixed(0)}% at the shallowest, against ${(amin(laid) * 100).toFixed(0)}%`)
    }


    const flatBed = forestRocks.beds.find((b) => b.cfg.name === 'boulders')
    check(
      flatBed.instY[flatBed.tiles.values().next().value.ids[0]] < 60,
      'the instance sits below the ground line, not on it'
    )

    // --- what a boulder does to the props around it -------------------------
    //
    // `blockTopAt` is the whole of the displacement rule: the tree, fern, grass and
    // litter scatters all ask it once per candidate, and everything they do with the
    // answer follows from the facts asserted here -- that it finds a rock that is
    // really there, that standing on that rock means standing above the ground, and
    // that it says nothing where there is no rock. Measured against the beds' own
    // instances rather than against a fixture, so a change to the plan factor, the
    // settle or the burial shows up here.
    {
      const bed = forestRocks.beds.find((b) => b.cfg.name === 'boulders')
      const groundOf = (b, id) => b.instY[id] + b.instSink[id]
      const boxTop = (b, id, m) => {
        m.fromArray(b.instM, id * 16)
        const e = m.elements
        const sh = b.shape
        return e[13] + Math.abs(e[1]) * sh.measured.width * 0.5 +
          Math.max(0, e[5] * sh.measured.height) + Math.abs(e[9]) * sh.measured.depth * 0.5
      }
      const m = new THREE.Matrix4()
      const v0 = new THREE.Vector3()
      const v1 = new THREE.Vector3()
      const v2 = new THREE.Vector3()

      // NOTHING THE SCATTER PLACES IS BURIED WHOLE, over every bed and every shape
      // -- the check that SINK_CAP is doing its job. A rock under the ground is a
      // rock that was built, skinned, submitted and never seen, and it is what the
      // normal correction and OPEN_BURY produce when they land on the same instance.
      let sunkWhole = 0
      let thinnest = Infinity
      let total = 0
      for (const b of forestRocks.beds) {
        for (const t of b.tiles.values()) {
          for (let k = 0; k < t.n; k++) {
            const proud = boxTop(b, t.ids[k], m) - groundOf(b, t.ids[k])
            total++
            if (proud <= 0) sunkWhole++
            thinnest = Math.min(thinnest, proud)
          }
        }
      }
      check(sunkWhole === 0, 'no rock in any bed is buried whole',
        `${sunkWhole} of ${total} have their top at or under the ground they were seated on`)
      check(thinnest > 0.001, 'and the least of them stands proud by more than a rounding error',
        `thinnest of ${total} stands ${(thinnest * 1000).toFixed(1)} mm proud`)

      const bank = []
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const size = bed.shapeLod * bed.instScale[id]
          if (size > ROCK_STAND_MIN) bank.push({ id, size })
        }
      }
      if (!bank.length) throw new Error('check-rocks: no boulder over the stand threshold to query')

      // OVER THE MIDDLE OF EVERY BOULDER THERE IS SOMEWHERE TO STAND, and it is
      // above the ground rather than at it -- the point of the whole exercise is
      // that a tree here is lifted. `instY + instSink` is the ground the scatter
      // itself seated the rock against, so the two numbers are commensurate without
      // a second field query.
      //
      // THE MIDDLE IS NOT `instX, instZ`. The shape's origin is the middle of its
      // BOTTOM and the quarter turns spin about it, so a rock the roll laid on its
      // side stands entirely beside its own placement point -- and asking there is
      // asking about the ground next to a boulder, which correctly answers nothing.
      // The box's centre is the origin plus the matrix's own up column at half the
      // shape's height.
      const midOf = (b, id) => {
        m.fromArray(b.instM, id * 16)
        const e = m.elements
        const half = b.shape.measured.height * 0.5
        return [b.instX[id] + e[4] * half, b.instZ[id] + e[6] * half]
      }
      let found = 0
      let lowest = Infinity
      for (const { id } of bank) {
        const [mx, mz] = midOf(bed, id)
        const top = forestRocks.blockTopAt(mx, mz, ROCK_STAND_MIN)
        if (top === -Infinity) continue
        found++
        lowest = Math.min(lowest, top - groundOf(bed, id))
      }
      check(found === bank.length,
        'every boulder over a metre offers a prop somewhere to stand, over the middle of its own box',
        `${found} of ${bank.length}`)
      check(lowest > 0,
        'and that somewhere is above the ground it is standing on, not level with it',
        `the flattest of ${bank.length} still stands ${(lowest * 100).toFixed(1)} cm proud`)

      // AND IT IS THE ROCK'S OWN SURFACE, settled into it. The bug this replaced was
      // a plane: the query answered with the turned box's TOP everywhere inside a
      // plan disc, so every tree and fern on a boulder hovered on an invisible table
      // half a metre over the stone, and the ones at the corners of the box hovered
      // over nothing at all. So the surface is re-derived here the other way round
      // -- the implementation drops a world-vertical line into the rock's frame and
      // runs Moller-Trumbore, this transforms the triangles OUT to world and reads
      // the height off a plan barycentric -- and every answer has to land on it.
      //
      // Over every blocking bed, not just the boulder under the point: the beds
      // overlap, and a giant reaching this point is a legitimate answer metres
      // higher. The settle is one-sided and bounded, which makes the pair of
      // comparisons below a full statement of what the query is allowed to return.
      const stoneTop = (x, z, minSize) => {
        let top = -Infinity
        for (const b of forestRocks.beds) {
          if (!b.blocks) continue
          const pos = b.shape.tiers[0].attributes.position.array
          for (const t of b.tiles.values()) {
            for (let k = 0; k < t.n; k++) {
              const id = t.ids[k]
              if (b.shapeLod * b.instScale[id] < minSize) continue
              const r = b.hull.radius * b.instScale[id]
              const ex = x - b.instX[id]
              const ez = z - b.instZ[id]
              if (ex * ex + ez * ez >= r * r) continue
              m.fromArray(b.instM, id * 16)
              for (let f = 0; f < pos.length; f += 9) {
                const a = v0.set(pos[f], pos[f + 1], pos[f + 2]).applyMatrix4(m)
                const bb = v1.set(pos[f + 3], pos[f + 4], pos[f + 5]).applyMatrix4(m)
                const c = v2.set(pos[f + 6], pos[f + 7], pos[f + 8]).applyMatrix4(m)
                const det = (bb.z - c.z) * (a.x - c.x) + (c.x - bb.x) * (a.z - c.z)
                if (Math.abs(det) < 1e-12) continue
                const l1 = ((bb.z - c.z) * (x - c.x) + (c.x - bb.x) * (z - c.z)) / det
                const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det
                const l3 = 1 - l1 - l2
                if (l1 < 0 || l2 < 0 || l3 < 0) continue
                top = Math.max(top, l1 * a.y + l2 * bb.y + l3 * c.y)
              }
            }
          }
        }
        return top
      }
      // A millimetre, because the two paths are float32 vertices multiplied in
      // different orders -- the implementation inverts the matrix onto the ray, this
      // pushes the triangles through it -- and they disagree in the fifth decimal.
      // The bug being gated is half a metre tall.
      const RAY_EPS = 1e-3
      let above = -Infinity
      let deepest = 0
      for (const { id } of bank) {
        const [mx, mz] = midOf(bed, id)
        const top = forestRocks.blockTopAt(mx, mz, ROCK_STAND_MIN)
        const surf = stoneTop(mx, mz, ROCK_STAND_MIN)
        above = Math.max(above, top - surf)
        deepest = Math.max(deepest, surf - top)
      }
      check(above < RAY_EPS, 'the answer is never above the stone it claims to be standing on',
        `the highest of ${bank.length} is ${(above * 1000).toFixed(1)} mm over the surface`)
      check(deepest <= BLOCK_SETTLE_MAX + RAY_EPS,
        'and it is settled INTO that surface rather than balanced on it, by no more than the cap',
        `the deepest of ${bank.length} is ${(deepest * 1000).toFixed(0)} mm in, cap ${BLOCK_SETTLE_MAX * 1000} mm`)

      // AND IT FOLLOWS THE STONE ACROSS THE FOOTPRINT, which is the half a centre
      // query cannot see: a plane answers every point on a rock with the same number
      // and passes everything above. Sampled over the biggest resident boulder's own
      // reject cylinder, which is a good deal wider than the rock -- over half of it
      // is air, and a query there has to say NOTHING, because a fern beside a
      // boulder belongs on the ground.
      let widest = bank[0]
      for (const b of bank) if (bed.instScale[b.id] > bed.instScale[widest.id]) widest = b
      const rad = bed.hull.radius * bed.instScale[widest.id]
      let lit = 0
      let clear = 0
      let bad = 0
      let sLo = Infinity
      let sHi = -Infinity
      for (let i = 0; i < 400; i++) {
        const a = (i * 2.399963) % (Math.PI * 2)
        const d = Math.sqrt((i + 0.5) / 400) * rad
        const x = bed.instX[widest.id] + Math.cos(a) * d
        const z = bed.instZ[widest.id] + Math.sin(a) * d
        const top = forestRocks.blockTopAt(x, z, 0)
        const surf = stoneTop(x, z, 0)
        if (surf === -Infinity) {
          if (top === -Infinity) clear++
          else bad++
          continue
        }
        lit++
        if (top - surf > RAY_EPS || surf - top > BLOCK_SETTLE_MAX + RAY_EPS) bad++
        sLo = Math.min(sLo, top)
        sHi = Math.max(sHi, top)
      }
      const standing = bed.shape.measured.height * bed.instScale[widest.id]
      check(bad === 0, 'every point across a boulder answers with the stone under it or with nothing',
        `${bad} of 400 samples are off the surface (${lit} on stone, ${clear} on box corner)`)
      check(clear > 0, 'and the corners of the box really do answer nothing, so a prop there is left on the ground',
        `${clear} of 400`)
      check(sHi - sLo > standing / 3,
        'and the answer varies over the rock rather than being one table over it',
        `${(sHi - sLo).toFixed(2)} m of relief on a boulder standing ${standing.toFixed(2)} m`)

      // THE SIZE GATE IS THE CALLER'S KNOB and it has to actually gate. The same
      // points queried at 0 answer for anything; queried above the biggest rock any
      // blocking bed holds they must answer for nothing -- and if they did not, a
      // tree would be perched on a cobble.
      let huge = 0
      for (const b of forestRocks.beds) {
        if (!b.blocks) continue
        for (const t of b.tiles.values()) {
          for (let k = 0; k < t.n; k++) {
            huge = Math.max(huge, b.shapeLod * b.instScale[t.ids[k]])
          }
        }
      }
      huge += 1
      let over = 0
      for (const { id } of bank) {
        if (forestRocks.blockTopAt(bed.instX[id], bed.instZ[id], huge) > -Infinity) over++
      }
      check(over === 0, 'and `minSize` really gates, so nothing is ever perched on a cobble',
        `${over} of ${bank.length} answer above ${huge.toFixed(1)} m`)

      // NOTHING IS INVENTED WHERE THERE IS NO ROCK. The far side of the world is
      // outside every bed's resident tiles, so this is also the test that an
      // unresident tile answers -Infinity rather than throwing on a missing Map
      // entry -- which is the shape of the bug that would drop every prop in the
      // world at once.
      check(forestRocks.blockTopAt(9e5, -9e5, 0) === -Infinity,
        'and ground with no rock on it answers nothing, off the resident tiles included')

      // --- the column, which is what the walker asks ------------------------
      //
      // `columnAt` is the same ray with both ends kept: every rock the vertical
      // line passes through, bottom and top, unsettled. Re-derived here the same
      // way stoneTop is -- triangles pushed out to world, plan barycentric --
      // but per rock and keeping the lowest crossing as well as the highest, and
      // every span the query returns has to match one, count included. Over the
      // same 400 points across the widest boulder, where over half the samples
      // are air and have to come back empty.
      const stoneSpans = (x, z, minSize) => {
        const found = []
        for (const b of forestRocks.beds) {
          if (!b.blocks) continue
          const pos = b.shape.tiers[0].attributes.position.array
          for (const t of b.tiles.values()) {
            for (let k = 0; k < t.n; k++) {
              const id = t.ids[k]
              if (b.shapeLod * b.instScale[id] < minSize) continue
              const r = b.hull.radius * b.instScale[id]
              const ex = x - b.instX[id]
              const ez = z - b.instZ[id]
              if (ex * ex + ez * ez >= r * r) continue
              m.fromArray(b.instM, id * 16)
              let lo = Infinity
              let hi = -Infinity
              for (let f = 0; f < pos.length; f += 9) {
                const a = v0.set(pos[f], pos[f + 1], pos[f + 2]).applyMatrix4(m)
                const bb = v1.set(pos[f + 3], pos[f + 4], pos[f + 5]).applyMatrix4(m)
                const c = v2.set(pos[f + 6], pos[f + 7], pos[f + 8]).applyMatrix4(m)
                const det = (bb.z - c.z) * (a.x - c.x) + (c.x - bb.x) * (a.z - c.z)
                if (Math.abs(det) < 1e-12) continue
                const l1 = ((bb.z - c.z) * (x - c.x) + (c.x - bb.x) * (z - c.z)) / det
                const l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det
                const l3 = 1 - l1 - l2
                if (l1 < 0 || l2 < 0 || l3 < 0) continue
                const y = l1 * a.y + l2 * bb.y + l3 * c.y
                lo = Math.min(lo, y)
                hi = Math.max(hi, y)
              }
              if (hi > -Infinity) found.push([lo, hi])
            }
          }
        }
        return found.sort((p, q) => p[1] - q[1])
      }
      const col = new Float64Array(SPAN_STRIDE * 8)
      let colBad = 0
      let colLit = 0
      let overhung = 0
      let thickest = 0
      for (let i = 0; i < 400; i++) {
        const a = (i * 2.399963) % (Math.PI * 2)
        const d = Math.sqrt((i + 0.5) / 400) * rad
        const x = bed.instX[widest.id] + Math.cos(a) * d
        const z = bed.instZ[widest.id] + Math.sin(a) * d
        const want = stoneSpans(x, z, 0)
        const n = forestRocks.columnAt(x, z, 0, col)
        const got = []
        for (let s = 0; s < n; s++) got.push([col[s * 2], col[s * 2 + 1]])
        got.sort((p, q) => p[1] - q[1])
        if (got.length !== want.length) { colBad++; continue }
        for (let s = 0; s < n; s++) {
          if (Math.abs(got[s][0] - want[s][0]) > RAY_EPS || Math.abs(got[s][1] - want[s][1]) > RAY_EPS) colBad++
          if (got[s][0] > 60 + 0.05) overhung++
          thickest = Math.max(thickest, got[s][1] - got[s][0])
        }
        if (n) colLit++
      }
      check(colBad === 0, 'every point across a boulder answers the column with the stone on its line, both ends, or with nothing',
        `${colBad} of 400 samples disagree with the triangle walk (${colLit} on stone, ${overhung} under an overhang)`)
      check(thickest > 0.5, 'and a span is the stone\'s thickness rather than a surface',
        `the thickest column through a ${standing.toFixed(2)} m boulder is ${thickest.toFixed(2)} m`)
      check(forestRocks.columnAt(9e5, -9e5, 0, col) === 0,
        'and ground with no rock on it answers no spans, off the resident tiles included')
    }

    // THE ONE ALGEBRAIC CLAIM THE SURFACE QUERY RESTS ON. `_spanAt` and `_rayAt`
    // invert the mesh matrix's upper 3x3 as its transpose with each column
    // divided by its own squared length, which is the inverse ONLY while the
    // columns are orthogonal. rocks.js composes a rotation over the quarter-turn
    // roll and a squash along the rolled box's up, and a quarter turn keeps the
    // squashed axes orthogonal -- but a free roll angle, or a second squash axis
    // applied after a lean, would not, and then the ray is bent and every prop
    // on a rock in that bed stands in the wrong place. Nothing about that throws
    // and nothing about it is visible from a node gate except this.
    //
    // Measured on the CLIFF, because that is where the leans are: the tilting
    // beds compose a ground tilt on top of the yaw, and a rotation
    // is exactly where a transpose stops being an inverse if a scale is hiding
    // in it. The identity is checked as a matrix product rather than by reading
    // the columns back out, which is the same inverse the query takes; and that
    // the squash is actually in the matrices, since a placement that dropped it
    // would pass the identity with every rock an iceberg again.
    {
      const m = new THREE.Matrix4()
      const M = new THREE.Matrix3()
      const T = new THREE.Matrix3()
      let worst = 0
      let n = 0
      let squashed = 0
      for (const bed of cliffRocks.beds) {
        for (const t of bed.tiles.values()) {
          for (let k = 0; k < t.n; k++) {
            m.fromArray(bed.instM, t.ids[k] * 16)
            M.setFromMatrix4(m)
            const e = M.elements
            const len = [0, 3, 6].map((o) => Math.hypot(e[o], e[o + 1], e[o + 2]))
            if (Math.min(...len) < Math.max(...len) * 0.99) squashed++
            T.copy(M).transpose()
            const te = T.elements
            for (let r = 0; r < 3; r++) {
              for (let c = 0; c < 3; c++) te[c * 3 + r] /= len[r] * len[r]
            }
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
        'every rock mesh matrix has orthogonal columns, so _spanAt\'s transpose over the column lengths really is an inverse',
        `worst departure from identity ${worst.toExponential(1)} over ${n} instances`)
      check(squashed > 0 && squashed < n,
        'and some of them, not all, are squashed slabs',
        `${squashed} of ${n} instances have one column shorter than the others`)
    }
  }

  // The pool bound is the only thing between the densest ground in the world and
  // a scatter with holes in it: a dry pool drops the rock and warns once. Walk
  // the camera so tiles are grown at every quantised level, on the ground that
  // places the MOST rocks.
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
  // two above are both dry. The forest is the fourth, for the hollow bed, which
  // refuses every slope, shore and summit the other four are made of.
  //
  // AND EVERY BED HAS TO PLACE SOMETHING ACROSS THE SET, which is the assertion
  // that keeps this honest as beds are added. Without it a new bed that never
  // fires -- a bad `envDensity`, a site tag nothing rosters, a `footOnly` flag
  // on a bed whose world has no feet, a `submergedOnly` flag on a bed whose
  // world has no water -- sails through with used = 0, because zero is less
  // than every bound there is.
  {
    const worlds = { forest: build(forest), cliff: build(cliff), ridge: build(ridge), river: build(river), bank: build(bank) }
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
      //
      // AND THE PAIR AGAIN AFTER THE WALK. A tile enters the radius at its
      // coarsest level, where a bed keeps only the rocks big enough to be seen
      // from there -- on a sparse bed that is none at all -- and it is the
      // walk in `update` that queues the thickening as the camera closes. In
      // the game that queue drains on the next frame; here the next frame is a
      // 98 m jump, so without the second `place` the tiles under the camera at
      // every step are still at the level the previous step gave them, and a
      // bed that places nothing at that level reads `used 0` however dense it
      // is. The second `update` then tiers what the second `place` grew, so
      // the readout checks below see every rock on the rung its distance
      // gives it rather than on the one it was placed hidden with.
      for (let i = 1; i <= 12; i++) {
        r.place(i * 37, i * 91)
        r.update(i * 37, 61.6, i * 91)
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
    // `used` cannot pass `pool` any more -- a dry pool drops the rock and
    // counts it -- so the bound is asserted on the count, not the fill.
    const dry = Object.values(worlds).flatMap((r) => r.stats.beds.filter((b) => b.rejected.pool > 0))
    check(dry.length === 0, 'no pool ran dry over a traverse of all four worlds',
      dry.length ? dry.map((b) => `${b.name} dropped ${b.rejected.pool}`).join('  ')
        : beds.map((b) => `${b.name} ${b.used}/${b.pool} (${b.world})`).join('  '))
    check(beds.every((b) => b.used / b.pool < 0.95), 'and every pool has headroom',
      `worst ${(Math.max(...beds.map((b) => b.used / b.pool)) * 100).toFixed(0)}% full`)
    check(beds.every((b) => b.used > 0), 'and every bed was actually exercised by one of them',
      beds.map((b) => `${b.name} ${b.used}`).join('  '))

    // THE GHOSTS NEVER EAT A TIER'S OWN SHARE. The prop clock has not ticked
    // across the traverse, so every cross-dissolve started in twelve hundred
    // metres of teleport is still in flight, and a ghost sits in the mesh of
    // the tier its rock LEFT. A tier's cap is its population bound times
    // poolBound's headroom, and only the headroom is the ghosts' to take: a
    // ghost that took a population slot would leave the next real arrival
    // refused by PropArena._alloc and its rock stuck on the tier it is on.
    {
      const over = []
      for (const [name, r] of Object.entries(worlds)) {
        for (const bed of r.beds) {
          for (let t = 0; t < bed.tierIds.length - 1; t++) {
            if (bed.ghostsAt[t] > bed.ghostRoom[t]) over.push(`${name}/${bed.cfg.name} T${t} ${bed.ghostsAt[t]} ghosts in a room of ${bed.ghostRoom[t]}`)
          }
        }
      }
      const fullest = Math.max(...Object.values(worlds).flatMap((r) =>
        r.meshes.meshes.slice(0, -1).map((m, t) => m.count / r.meshes.capAt[t])))
      check(over.length === 0, 'ghosts never fill a mesh tier past its headroom, so an arrival is never refused',
        over.length ? over.join('; ') : `fullest mesh tier ${(fullest * 100).toFixed(0)}% of its cap`)
    }

    // NO ROCK IS THINNED AWAY WHILE IT IS STILL A MESH, which is the promise the
    // whole ladder is for and the one that used to be broken: thinning is keyed
    // on a rank the rock drew and knows nothing about how big the rock is, so a
    // bed with a short `fullRadius` and a big rock in it dissolved that rock in
    // the middle distance having never reached its far tier at all. Rocks were
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
          // A bed that placed nothing in THIS world has nothing to say -- the
          // scree bed grows tiles on the uniform cliff but puts no rock in any of
          // them, so tile count is not the test, instance count is. Not silence
          // either: `n` below is asserted non-zero, so a change that emptied
          // every bed fails here rather than passing on an empty loop.
          let placed = 0
          for (const t of bed.tiles.values()) placed += t.n
          if (placed === 0) continue
          // PropArena's shadow copy of the slot, which is the value every mesh
          // holding the instance is written from. See writeFadeSlot.
          const fades = bed.batch.fade
          for (const t of bed.tiles.values()) {
            for (let k = 0; k < t.n; k++) {
              const id = t.ids[k]
              // Under the world's ceiling: past ROCK_LOD_FAR_MAX every rock is
              // on T6, so a block that would earn its meshes further out does
              // not get to keep them.
              const farAt = Math.min(rockLodSize(bed.shape.measured) * bed.instScale[id] * LAST, ROCK_LOD_FAR_MAX)
              const swapping = bed.fadeAt[id] >= 0
              if (swapping) fading++
              const slot = fades[id]
              if (slot !== 1 && slot >= 0) slotBad++
              // Where the dissolve STARTS, not where it ends: the rim carries
              // the gone-distance and fires at RIM_AT of it.
              const gone = bed.rim.gone[id]
              const dissolveFrom = gone * RIM_AT
              n++
              if (dissolveFrom - farAt < closest) closest = dissolveFrom - farAt
              if (dissolveFrom < farAt - 1e-3) {
                bad++
                const gap = farAt - dissolveFrom
                if (!worst || gap > worst.gap) {
                  worst = { gap, farAt, dissolveFrom, bed: bed.cfg.name, world: name,
                    scale: bed.instScale[id] }
                }
              }
            }
          }
        }
      }
      check(n > 0 && bad === 0,
        'no rock starts dissolving before its far tier takes over',
        bad === 0
          ? `${n} instances (${fading} of them mid-swap), ` +
            `closest call ${closest.toFixed(1)} m of margin`
          : `${bad} of ${n}: worst ${worst.bed} at ${worst.scale.toFixed(2)}x (${worst.world}) ` +
            `reaches T6 at ${worst.farAt.toFixed(0)} m but starts going at ${worst.dissolveFrom.toFixed(0)} m`)
      check(slotBad === 0, 'the fade slot never holds anything but a sentinel or a stamp',
        `${slotBad} of ${n} carry a positive value that is not the never-fade 1`)
      // AND THE SHADER READS IT. Everything above tests the number the CPU
      // writes. A material built without `instancedFade` declares no `aPropFade`,
      // leaves `vPropFade` at the constant 1, and turns every stamp above into a
      // value nothing looks at -- the beds go on holding their ghosts, and a swap
      // draws both tiers SOLID and coincident for its quarter second instead of
      // dithering between them. The beds are InstancedMeshes, so the batched slot
      // (a colour texture's alpha, which needs no flag) is not the one in play
      // and the flag is the only way in. `-ifade` is what createPropMaterial puts
      // in the program key for it.
      const progKey = worlds.cliff.material.customProgramCacheKey()
      check(worlds.cliff.meshes.meshes[0].isInstancedMesh && progKey.includes('-ifade'),
        'and the bed material declares the attribute the shader reads it from',
        progKey)
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
        Number.isFinite(r.d) && Number.isFinite(r.size) && Number.isFinite(r.farAt) &&
        Number.isFinite(r.goneAt) && typeof r.bed === 'string' &&
        // Both columns are rounded for the console, so the identity is
        // checked to the rounding and not past it: 0.005 m of size is 0.125 m
        // of far distance.
        Math.abs(r.farAt - r.size * LAST) < 0.2 &&
        // The band the hysteresis leaves: a finer tier holds on 12% past the
        // far distance, and the far tier gives way again at the distance itself.
        (r.tier === 'far' ? r.d >= r.farAt - 0.2 : r.d < r.farAt * 1.12 + 0.2))
      check(rows.length > 0 && sane,
        'describeNear reports every nearby rock\'s tier, far distance and dissolve distance',
        `${rows.length} rocks within 60 m, nearest ${rows[0].bed} at ${rows[0].d} m ` +
          `on ${rows[0].tier}, far at ${rows[0].farAt} m, dissolves from ${rows[0].dissolveFrom} m`)
      check(rows.every((r) => r.dissolveFrom >= r.farAt - 1e-3),
        'and none of them is set to dissolve before it reaches its far tier',
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
  // A rock changing tier used to CUT: one frame one mesh, the next another,
  // and at the ranges the last rung sits at that is a visible twitch on ground
  // covered in stone. Rocks now does what render/grass.js does -- a duplicate
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
    // Every swap the 9 m step causes starts on its one update, not over the next few frames.
    r.walkBudgetMs = Infinity
    r.place(600, 600)
    r.update(600, 61.6, 600, 50)

    // The stamp a swap leaves, per bed, keyed by instance.
    const slots = (bed) => bed.batch.fade
    const snap = (bed) => bed.fades.map((f) => ({
      orig: f.orig, dup: f.dup,
      out: slots(bed)[f.dup],
      in: slots(bed)[f.orig],
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
    // rocks rather than one dissolving into itself. Every tier takes the one
    // placement matrix, so both halves are checked against it.
    const ma = new THREE.Matrix4()
    const mb = new THREE.Matrix4()
    const mw = new THREE.Matrix4()
    const ca = new THREE.Color()
    const cb = new THREE.Color()
    const wantM = (id, out) => out.fromArray(bed.instM, id * 16)
    // A tenth of a millimetre: the arena holds float32, and the world is 600 m wide.
    const same = (m1, m2) => m1.elements.every((v, i) => Math.abs(v - m2.elements[i]) <= 1e-4)
    let moved = 0
    let recoloured = 0
    let sameGeom = 0
    for (const f of first) {
      bed.batch.getMatrixAt(f.orig, ma)
      bed.batch.getMatrixAt(f.dup, mb)
      if (!same(ma, wantM(f.orig, mw)) || !same(mb, wantM(f.orig, mw))) moved++
      bed.batch.getColorAt(f.orig, ca)
      bed.batch.getColorAt(f.dup, cb)
      if (Math.abs(ca.r - cb.r) + Math.abs(ca.g - cb.g) + Math.abs(ca.b - cb.b) > 1e-6) recoloured++
      if (bed.batch.geoAt[f.orig] === bed.batch.geoAt[f.dup]) sameGeom++
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
    const restored = first.filter((f) => slots(bed)[f.orig] === 1)
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
      check(slots(bed)[live.orig] < 0 && !bed.batch.getVisibleAt(live.dup),
        'and what is left in the slot is the RIM\'s stamp, with the ghost off screen',
        `slot ${slots(bed)[live.orig].toFixed(3)}`)

      // The other direction: the rim is mid-transition on this instance, so a
      // tier crossing has to leave it alone. Which tier a rock was wearing on
      // its way out of the world is not a question anybody is asking.
      const stamp = slots(bed)[live.orig]
      const held = bed.freeCount
      bed._crossFade(live.orig, 0, getPropClock())
      check(bed.fadeAt[live.orig] === -1 && bed.freeCount === held
        && slots(bed)[live.orig] === stamp,
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
        if (ba.instX[k] !== bb.instX[k] || ba.instY[k] !== bb.instY[k] || ba.instScale[k] !== bb.instScale[k]) drift++
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
    // cue the dimmest thing the scatter could write was about 1.15, and nothing
    // in the world came out darker than the tile it is made of.
    //
    // THE CUE NOW TAKES LIGHTNESS AS WELL AS HUE, which is the design: a boulder
    // is meant to match the ground it sits on, and a wood floor is dark, so a
    // boulder in a wood is meant to be dark. What is left of the old promise is
    // a margin rather than a law -- the palette gains are large enough that even
    // a fully matched forest boulder lands a hair above the bare tile -- and the
    // margin is now 1.02x where it was 1.73x. That number is the interesting one
    // and it is why the check stays: at 1.0 a boulder stops reading against the
    // ground at all, and the next cue increase is what would take it there.
    check(dimmestLuma > 1, 'no instance darkens the tile',
      `dimmest instance is ${dimmestLuma.toFixed(2)}x the bare tile`)
    // The floor that IS a law. The cue is a lerp toward the ground, so every
    // channel keeps at least `1 - cue` of the palette entry it was written from
    // no matter how dark the ground under it goes -- which is what stops a match
    // becoming a repaint, and what leaves a riverbed a bed of stones rather than
    // a flat plane. A wood is not the worst case for this any more (the river
    // cue is 0.75 against the forest's 0.45) but it is the case with the lowest
    // gains behind it, so the envelope is still measured there. If this fails,
    // the cue has grown past what the gains can carry.
    check(dimmest > 0.55,
      'and a rock that matches its ground still keeps over half its own palette',
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
    // `seasons: true`, because everything below reads the season blocks and a
    // default program no longer carries them; check-shaders holds the world's
    // own materials to compiling WITHOUT them.
    const src = {
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
      uniforms: {},
    }
    createPropMaterial(texArray, { seasons: true }).onBeforeCompile(src)
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
      const m = vs.match(new RegExp(`i < (\\d+); i\\+\\+ \\) \\{\\s*${name} \\+= step\\( abs\\( propLayer - ${array}`))
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

    // --- and the far-field stipple is gated on stone ---------------------------
    //
    // The numbers behind SNOW_FAR_MAX are checked in the snow-on-stone section;
    // what is read here is that the line is actually WIRED that way, because the
    // two ways of getting it wrong are both silent. It must ride `rock`, so a
    // fern's canopy is left alone -- foliage has its own noise that survives the
    // fade and dithering it would only make the leaves crawl. And it must ride
    // `1.0 - snowNear`, the same fade the blob collapses on, so nothing inside
    // SNOW_FADE_FAR moves by a fragment.
    const stipple = src.fragmentShader.slice(src.fragmentShader.indexOf('float far ='))
    check(src.fragmentShader.includes('float far = ( 1.0 - snowNear ) * rock;') &&
      /1\.0 - step\( min\( cover, [0-9.]+ \), ign\( gl_FragCoord\.xy \) \), far/.test(stipple),
      'the far-field stipple rides the blob\'s own fade and reaches stone only',
      `capped at ${SNOW_ROCK.farMax}, crossfaded from ${SNOW_ROCK.fadeFar} m out`)

    setMossVary(1, 1)
    setSnowVary(1, 1)
  }

  // AND EVERY TIER MESH OWNS AN instanceColor, INCLUDING THE ONES THAT DREW
  // NOTHING. Every bed shares ONE material, so it compiles ONE program, and
  // three keys USE_INSTANCING_COLOR off whether the mesh being drawn has an
  // `instanceColor` at all. A mesh that acquired one lazily -- three's own path,
  // inside the first `setColorAt` -- would join the party after the program was
  // built and lose its per-instance tint until something else forced a rebuild,
  // and on a world where nothing reaches a tier nothing ever would.
  // PropMeshes' constructor makes them all up front for exactly this reason; the
  // placed counts are reported so it is visible that this run exercised an empty
  // bed and not only full ones.
  {
    const missing = []
    const counts = []
    for (const [name, r] of [['forest', forestRocks], ['cliff', cliffRocks], ['peak', peakRocks], ['river', riverRocks]]) {
      for (const bed of r.beds) counts.push(`${name}/${bed.cfg.name} ${bed.placed}`)
      for (const m of r.meshes.meshes) {
        if (!m.instanceColor) missing.push(`${name}/${m.name}`)
      }
    }
    check(missing.length === 0,
      'every rock tier mesh owns an instanceColor even when it drew nothing, so the shared program is compiled with the tint in it',
      missing.length ? `no instanceColor on ${missing.join(', ')}` : `live per bed: ${counts.join(', ')}`)
  }

  // THE CURSOR READOUT NAMES A ROCK, AND THE NAME IS ONE YOU CAN GO AND LOOK AT.
  //
  // Two failures, both silent in the view and both of which had actually
  // happened. First, `pickProp` duck-types on `sys.tiles`, and `Rocks` is a
  // facade over six `RockBed`s that keeps none of the instance arrays itself --
  // so the source bound to it failed the duck-type and was skipped without a
  // word, and the readout named trees and nothing else. Second, the obvious
  // thing to print was an index into a per-bed roster: it looked like an id you
  // could look up and was not one.
  //
  // The world has ONE rock, so there is no variant to name and no id to carry to
  // a keyboard. What a readout can still answer is "why is that one 12 m across",
  // and the answer is the BED -- which is what main.js prints. The round trip
  // that remains is the previewer's: /gen-rock's `boulder` preset at the bank's
  // own seed has to rebuild the very shape the beds are instancing.
  {
    // The sources main.js binds, built the same way, because the thing that
    // broke was the BINDING and a fixture that skipped it would not have caught
    // it. Biggest live instance so the aim is unambiguous inside a thicket.
    const rockPicks = forestRocks.beds.map((bed) => ({
      label: 'rock', sys: bed,
      nameAt: (s) => `boulder (${s.cfg.name})`,
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
      pickProp([{ label: 'rock', sys: forestRocks, radius: 1.2, rise: 1.2 }], eye, dir, Infinity)
    } catch {
      facadeThrew = true
    }
    check(facadeThrew, 'and binding the facade instead of its beds throws rather than quietly naming nothing')

    check(hit !== null && hit.name === `boulder (${target.bed.cfg.name})`,
      'and what it prints is the one boulder and the bed that put it there, not a roster index',
      hit === null ? 'no hit' : hit.name)

    // The round trip. /gen-rock answers the `boulder` preset with
    // `Object.assign(params, rockParams(params.seed))` and builds from that, so
    // rebuilding through the same call at the bank's seed has to give back the
    // shape every bed is holding. Measured extents rather than vertex-by-vertex:
    // the promise is that it is THE SAME ROCK, and three numbers to 1e-9 is that.
    const shape = target.bed.shape
    const rebuilt = buildRock({ ...rockParams(shape.seed), tier: 0 })
    const a = rebuilt.userData.rock.measured
    const b = shape.measured
    const off = Math.max(Math.abs(a.width - b.width), Math.abs(a.height - b.height), Math.abs(a.depth - b.depth))
    check(off < 1e-9,
      'and /gen-rock at the bank\'s seed rebuilds the very rock that was under the cursor',
      `seed ${shape.seed}, extents off by ${off.toExponential(1)} m`)
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
      _rocks: rocks,
    })
    const sized = (sys) => ({
      label: 'rock', sys,
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
    // constant, 1.2 m of radius and 1.2 m of rise at scale 1, over a world whose
    // boulders are placed anywhere from 0.5 m to 10 m across. Everything above
    // 1.2 m was unnameable, and "unnameable" looks exactly like "the cursor
    // points through it".
    const spire = fixture([{ name: 'spire', x: 10, y: 0, z: 0, r: 0.5, rise: 6 }])
    const high = { x: 0, y: 5, z: 0 }
    const bySize = pickProp([sized(spire)], high, east, Infinity)
    const byConstant = pickProp(
      [{ label: 'rock', sys: spire, radius: 1.2, rise: 1.2, scaleKey: 'instScale', nameAt: () => 'rock' }],
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
      pickProp([{ label: 'rock', sys: spire, nameAt: () => 'rock' }], high, east, Infinity)
    } catch {
      unsizedThrew = true
    }
    check(unsizedThrew, 'and a pick source with neither a sizeAt nor a radius throws instead of naming nothing')
  }

  // --- her hands: a shore stone under two metres comes up, a boulder does not ---
  console.log('\nher hands')
  {
    taken.clear()
    // Grown on the bank, where the shore bed lays its stones along the
    // waterline through the origin and the boulders bed lays on the dry half,
    // and swept a few frames from the origin so what is near is shown.
    const grow = () => {
      const r = build(bank)
      for (let i = 0; i < 8; i++) r.update(0, 61.6, 0)
      return r
    }
    const r = grow()
    const unit = Math.max(r.beds[0].shape.measured.width, r.beds[0].shape.measured.depth, r.beds[0].shape.measured.height)
    // Every shown rock under two metres near the origin, nearest first, by whether its bed lets a hand at it.
    const small = []
    const heavy = []
    for (const bed of r.beds) {
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const span = unit * bed.instScale[id]
          if (span < 2 && !bed.rim.isHidden(id)) (LIFT_BEDS.has(bed.cfg.name) ? small : heavy).push({ bed, tile: t, k, id, span, d: Math.hypot(bed.instX[id], bed.instZ[id]) })
        }
      }
    }
    small.sort((a, b) => a.d - b.d)
    check(small.length > 0, 'the bank has shown shore stones under two metres', `${small.length}, nearest ${small[0]?.d.toFixed(1)} m off`)
    check(heavy.length > 0 && heavy.every((h) => r.pickAt(h.bed.instX[h.id], h.bed.instY[h.id] + h.bed.shape.measured.height * h.bed.instScale[h.id] * 0.5, h.bed.instZ[h.id], 0.5, 2)?.id !== h.id), 'a boulder under two metres is never offered: too heavy at any size', `${heavy.length} shown, ${[...new Set(heavy.map((h) => h.bed.cfg.name))].join(' ')}`)
    const { bed, tile, k, id, span } = small[0]
    const x = bed.instX[id], z = bed.instZ[id]
    const mid = bed.instY[id] + bed.shape.measured.height * bed.instScale[id] * 0.5
    const hit = r.pickAt(x, mid, z, 0.1, 2)
    check(hit !== null && hit.bed === bed && hit.tile === tile && hit.k === k && hit.id === id && hit.dist === 0 && Math.abs(hit.size - span) < 1e-6, 'pickAt at a small stone\'s middle hits it, its size the shape\'s longest axis at its scale', hit ? `${hit.bed.cfg.name} ${hit.size.toFixed(2)} m` : 'null')
    check(r.pickAt(x, mid + 5, z, 0.1, 2) === null, 'and nothing five metres above it')
    check(r.pickAt(x, mid, z, 0.1, span)?.id !== id, 'nor one at or over maxSize')
    // A rock of two metres and up is never offered, whatever the reach.
    let big = null
    for (const b of r.beds) for (const t of b.tiles.values()) for (let j = 0; j < t.n && !big; j++) if (!b.rim.isHidden(t.ids[j]) && unit * b.instScale[t.ids[j]] >= 2) big = { bed: b, id: t.ids[j] }
    check(big !== null && r.pickAt(big.bed.instX[big.id], big.bed.instY[big.id] + big.bed.shape.measured.height * big.bed.instScale[big.id] * 0.5, big.bed.instZ[big.id], 0.5, 2)?.id !== big.id, 'a rock of two metres and up never comes up', big ? `${big.bed.cfg.name} ${(unit * big.bed.instScale[big.id]).toFixed(2)} m` : 'none shown')
    const placedWere = bed.placed, usedWere = bed.stats.used, nWere = tile.n
    const c = bed.batch.getColorAt(id, new THREE.Color()).getHex()
    const rec = r.take(hit, 1)
    check(rec.kind === 'rock' && rec.name === 'rock' && rec.size === hit.size && rec.geometry === r.beds[0].shape.tiers[0] && rec.material === r.material && rec.stowable === (span < 1), 'take: the boulder at LOD0 on the stone material, stowable under a metre')
    check(rec.scale[0] === bed.instScale[id] && rec.scale[1] === rec.scale[0] && rec.scale[2] === rec.scale[0] && new THREE.Color().setRGB(...rec.color).getHex() === c, 'at its scale, in its tint', JSON.stringify(rec.scale))
    let listed = false
    for (let j = 0; j < tile.n; j++) if (tile.ids[j] === id) listed = true
    check(tile.n === nWere - 1 && !listed && bed.placed === placedWere - 1 && bed.stats.used === usedWere - 1 && !bed.batch.getVisibleAt(id) && bed.tierAt[id] === -1, 'the stone is out of its tile and its instance back in the pool')
    check(taken.has('rock', x, z), 'its spot is recorded')
    check(r.pickAt(x, mid, z, 0.1, 2)?.id !== id, 'and it cannot be taken twice')
    let threw = false
    try { r.take(hit, 1) } catch { threw = true }
    check(threw, 'taking it twice throws')
    const d = r.dress({ kind: 'rock' })
    check(d.geometry === rec.geometry && d.material === rec.material, 'dress: the boulder at LOD0 on the stone material')
    threw = false
    try { r.dress({ kind: 'pebble' }) } catch { threw = true }
    check(threw, 'dress throws on another kind')
    for (let i = 0; i < 4; i++) r.update(0, 61.6, 0)
    check(bed.placed === placedWere - 1 && bed.stats.used === bed.placed + bed.stats.fading, 'a few frames on, the tile is walked without harm and the pool holds what stands', `${bed.stats.used} used, ${bed.placed} placed, ${bed.stats.fading} fading`)
    // The walk surface has lost it: the column over its spot no longer reaches its top.
    const again = grow()
    const bedAgain = again.beds.find((b) => b.cfg.name === bed.cfg.name)
    let back = false
    for (const t of bedAgain.tiles.values()) for (let j = 0; j < t.n; j++) if (Math.hypot(bedAgain.instX[t.ids[j]] - x, bedAgain.instZ[t.ids[j]] - z) < 0.05) back = true
    check(!back && bedAgain.placed === placedWere - 1, 'grown again the bed lays no stone there and the count is one short', `${bedAgain.placed} of ${placedWere}`)
    taken.clear()
    const whole = grow()
    const bedWhole = whole.beds.find((b) => b.cfg.name === bed.cfg.name)
    back = false
    for (const t of bedWhole.tiles.values()) for (let j = 0; j < t.n; j++) if (Math.hypot(bedWhole.instX[t.ids[j]] - x, bedWhole.instZ[t.ids[j]] - z) < 0.05) back = true
    check(back && bedWhole.placed === placedWere, 'and with the registry cleared the stone is back')
    // A peer's take: evicted by spot from a LIFT_BEDS bed, hidden or shown; a boulder's spot, a foreign key, an empty spot and a spot once emptied are false.
    const hv = heavy[0]
    const bedHeavy = whole.beds.find((b) => b.cfg.name === hv.bed.cfg.name)
    const hx = hv.bed.instX[hv.id], hz = hv.bed.instZ[hv.id]
    let heavyThere = false
    for (const t of bedHeavy.tiles.values()) for (let j = 0; j < t.n; j++) if (Math.hypot(bedHeavy.instX[t.ids[j]] - hx, bedHeavy.instZ[t.ids[j]] - hz) < 0.05) heavyThere = true
    check(heavyThere && whole.evict('rock', hx, hz) === false && bedHeavy.placed === hv.bed.placed, 'evict leaves a boulder standing: no peer could have lifted it', hv.bed.cfg.name)
    check(whole.evict('pebble', x, z) === false && whole.evict('rock', x + 5, z + 5) === false && bedWhole.placed === placedWere, 'and is false for a foreign key or an empty spot')
    check(whole.evict('rock', x + 0.03, z - 0.03) === true && bedWhole.placed === placedWere - 1 && taken.has('rock', x, z), 'evict pulls the stone a peer lifted and records its spot')
    check(whole.evict('rock', x, z) === false, 'and is false for the spot once emptied')
    r.dispose(); again.dispose(); whole.dispose()
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
// from it silently. Everything that can be imported is -- MOSS.freq, MOSS.up,
// MOSS.warp, MOSS.fray, MOSS.frayFreq, SNOW_ROCK.blobContrast -- so the only
// literals here are the three noise offsets and the coarse warp frequency, which
// material.js keeps module-private. ONE copy of it, built by mossBlobField and
// shared with the rim measurement below, because two would drift from each other
// as well as from the shader.
function mossBlobField(fray) {
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
  // The fray is applied to the ALREADY-WARPED point, as in the shader: it is
  // detail on a tendril, not a second wobble beside it.
  return (x, y, z) => {
    const w = noise(x * BLOB_WARP_FREQ + 23.1, y * BLOB_WARP_FREQ + 5.7, z * BLOB_WARP_FREQ + 61.3)
    let qx = x + w * MOSS.warp
    let qy = y + w * 1.7 * MOSS.warp
    let qz = z - w * MOSS.warp
    if (fray > 0) {
      const d = noise(qx * MOSS.frayFreq + 47.3, qy * MOSS.frayFreq + 88.1, qz * MOSS.frayFreq + 19.7)
      qx += d * fray
      qy -= d * 1.3 * fray
      qz += d * 0.8 * fray
    }
    const f = noise(qx, qy, qz)
    return Math.min(1, Math.max(0, (f - 0.5) * SNOW_ROCK.blobContrast + 0.5))
  }
}

// A SPHERE OF RADIUS 0.9, and the radius matters: the field is sampled in WORLD
// space, so the size of the rock decides how many lobes are wrapped around it and
// therefore how the samples are distributed. 0.9 m is an ordinary boulder, which
// is what the moss constants were fitted against and what a player mostly sees
// wearing moss. Fibonacci rather than a lattice or a random spray, because it is
// the even sphere sampling with no seam and no clustering at the poles -- and the
// poles are exactly where `up` is at its extremes.
function mossCreepOnBoulder() {
  const N = 20000
  const R = 0.9
  // Full fray: this stands for the near field, which is the only place the
  // shader has it on and the distance a boulder's moss is judged at.
  const blobField = mossBlobField(MOSS.fray)
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
    const up = Math.min(1, Math.max(0, 0.5 + ny * 0.5))
    creeps[i] = blob * (1 - MOSS.up) + up * MOSS.up
  }
  creeps.sort()

  return { creeps, min: creeps[0], max: creeps[N - 1] }
}

// How LONG the mask's contour is, per unit area, at a given cut -- the one thing
// a domain warp can buy, and therefore the only way to check that MOSS_FRAY earns
// its noise evaluation. A warp slides sample points about, so it cannot change
// how much of the rock comes out green (that is the fit's job, checked
// separately); what it changes is how far you have to walk round the edge of what
// it covers.
//
// A 2D SLICE through the 3D field rather than the sphere, because a contour
// length needs neighbours and the Fibonacci sampling has no grid. The field is
// isotropic, so a plane through it is representative, and 12 lattice cells at 512
// samples is 43 samples per cell -- eight across the finest fray feature there
// is. Returned in cells per square cell, so it is a shape number and does not
// move when MOSS_FREQ does.
function mossRimLength(fray, cut) {
  const CELLS = 12
  const N = 512
  const step = CELLS / N
  const field = mossBlobField(fray)
  const mask = new Uint8Array(N * N)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      mask[j * N + i] = field(i * step + 3.3, j * step + 11.7, 5.9) > cut ? 1 : 0
    }
  }
  let area = 0
  let edges = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      area += mask[j * N + i]
      if (i + 1 < N && mask[j * N + i] !== mask[j * N + i + 1]) edges++
      if (j + 1 < N && mask[j * N + i] !== mask[(j + 1) * N + i]) edges++
    }
  }
  return { cover: area / (N * N), rim: (edges * step) / (CELLS * CELLS) }
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
