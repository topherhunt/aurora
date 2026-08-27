// Node-side gates for the procedural dead wood (src/props/deadwood.js).
//
//   node scripts/check-deadwood.mjs
//
// A snag and a fallen log are the first props in this project whose SILHOUETTE
// IS THE ASSET. A rock is a blob and reads as a blob at any tessellation; a
// mushroom is a surface of revolution and reads as one however few sides it has.
// Dead wood is a crooked near-cylinder, and the crookedness is the entire
// difference between a fallen log and a length of dowel. Everything below exists
// because that crookedness can be lost, or never arrive, without anything
// throwing.
//
//   THE ATTRIBUTE LAYOUT DRIFTS. Same boot failure as rocks, ferns and
//   mushrooms: BatchedMesh fixes its attribute set from the first geometry it is
//   handed and `_validateGeometry` throws on any later one that disagrees, so a
//   stray `uv` on a log takes down the whole prop batch rather than the log. The
//   layout is `position / normal / uvProj / texLayer` plus an identity index, and
//   it is not negotiable.
//
//   THE COST FORMULA STOPS BEING TRUE. `deadwoodCost` is what the bench prices a
//   tier with before it builds it, and what the §5 budget is argued against. It
//   is a closed-form transcription of what `buildDeadwood` emits -- a
//   duplication -- so the only thing keeping it honest is building and counting.
//
//   THE PIECE STOPS SITTING ON THE GROUND. Dead wood is bedded by being CUT OFF
//   at y = 0 rather than by being placed, so `sink` and `roll` and `pitch` all
//   move where that cut lands. A piece whose minimum y drifts above zero hovers;
//   one that drifts below buries its own moss line. Neither throws, and on a
//   ground that is itself displaced neither is obvious.
//
//   A COARSE TIER STRAIGHTENS THE SPINE. This is the one that actually bit. The
//   tier table cuts sides and rings, and they are not worth the same: sides buy
//   roundness, which at LOD distance is doing nothing, and rings buy the spine.
//   Measured on a 3 m log, dropping to one ring took its plan width from 1.03 m
//   to 0.63 m -- the bend is what makes a log wander sideways further than it is
//   thick, and one ring cannot hold a bend. The result is a dowel that pops into
//   a log at the switch distance. So the tier table is gated structurally (T1
//   keeps every ring) AND the built result is measured against T0.
//
//   THE WINDING INVERTS. The prop material is DoubleSide, so a back-to-front
//   triangle still draws -- lit by a normal pointing into the solid, which reads
//   as a patch of trunk that is dark when it should be bright and does not move
//   with the sun. Nothing else in the pipeline notices.
//
//   MOSS AND SNOW SILENTLY NEVER ARRIVE. Neither is a property of this geometry.
//   Both are the shared prop material's global uniforms selected by TEXTURE
//   LAYER, so dead wood weathers if and only if its bark and heartwood layers are
//   named in MOSS_LAYERS and SNOW_WOOD_LAYERS in src/textures.js. Rename a layer,
//   or point a variant at a layer nobody listed, and the log is simply never
//   mossy -- with no error, at any distance, in any weather.
//
// What this can NOT check: whether it looks like dead wood. That needs eyes, and
// on a headset (§17). /gen-deadwood is where that happens.

import {
  DEADWOOD_TIERS, DEADWOOD_DEFAULTS, DEADWOOD_VARIANTS, BUDGET_TRIS,
  deadwoodParams, buildDeadwood, buildSnag, buildLog, deadwoodCost,
  deadwoodRim, MAX_JAG, JAG_FULL,
} from '../src/props/deadwood.js'
import { DEADWOOD_BANDS, DEADWOOD_NAMES } from '../src/props/deadwood.js'
import {
  DEADWOOD_SEEDS, buildDeadwoodBank, deadwoodImpostorLayers, cardAzimuth,
} from '../src/props/deadwood-bank.js'
import { impostorCardExtents } from '../src/props/impostor.js'
import { Deadwood, SNAG_HEIGHT, LOG_LENGTH } from '../src/v2/render/deadwood.js'
import { LAYER, LAYER_COUNT, MOSS_LAYERS, SNOW_WOOD_LAYERS, SNOW_CARD_LAYERS } from '../src/textures.js'
import { MOSS, SNOW_ROCK } from '../src/material.js'
import * as THREE from 'three'
import fs from 'node:fs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const VARIANTS = Object.keys(DEADWOOD_VARIANTS)
const TIERS = DEADWOOD_TIERS.map((t, i) => i)
const arr = (geo, name) => geo.getAttribute(name).array

// Build every variant at every tier once, up front: nearly every gate below
// wants the same set, and building 24 of these twice is 24 pieces of noise in
// the output for no extra coverage.
const built = new Map()
for (const name of VARIANTS) {
  for (const tier of TIERS) {
    built.set(`${name}/${tier}`, buildDeadwood({ ...deadwoodParams(name, 7), tier }))
  }
}
const get = (name, tier) => built.get(`${name}/${tier}`)

// --- the tier table itself ---------------------------------------------------

{
  console.log('\nthe LOD tier table')

  check(DEADWOOD_TIERS.length === BUDGET_TRIS.length,
    'a budget for every tier', `${DEADWOOD_TIERS.length} tiers, ${BUDGET_TRIS.length} budgets`)

  const sides = DEADWOOD_TIERS.map((t) => t.sides)
  check(sides.every((s) => s >= 3), 'every tier has at least 3 sides', sides.join(' > '))
  check(sides.every((s, i) => i === 0 || s < sides[i - 1]),
    'and sides fall strictly with the tier', sides.join(' > '))

  // The measured regression, gated at its cause. T1 exists to be used at the
  // distance where the shape still reads, so it may lose facets and nothing
  // else; T2 may halve the rings but not gut them.
  const rm = DEADWOOD_TIERS.map((t) => t.ringMul)
  check(rm[0] === 1.0, 'T0 is the full sampling', `ringMul ${rm[0]}`)
  check(rm[1] === 1.0, 'T1 keeps EVERY ring -- it may lose sides only', `ringMul ${rm[1]}`)
  check(rm.every((m, i) => i === 0 || m <= rm[i - 1]), 'ringMul never rises with the tier', rm.join(' >= '))
  check(rm.every((m) => m >= 0.5), 'and no tier keeps under half the rings', rm.join(', '))

  // STUBS SURVIVE EVERY MESH TIER, and this assertion is the reverse of the one
  // it replaces. Dropping them below T0 was cheap and wrong: a stub is the only
  // feature on the whole prop that breaks the silhouette OUTWARD, so it is worth
  // more per triangle at distance than anything else here, not less. What T1
  // gives up is the stub's thickness, not the stub -- see `stubFlat`.
  const sm = DEADWOOD_TIERS.map((t) => t.stubMul)
  check(sm.every((m) => m === 1.0), 'stubs survive every mesh tier', sm.join(', '))
  const sf = DEADWOOD_TIERS.map((t) => t.stubFlat)
  check(sf[0] === false && sf.slice(1).every((f) => f === true),
    'and below T0 each one is a single card rather than a cone', sf.join(', '))
}

// --- cost formula vs. what gets built ---------------------------------------

{
  console.log('\ndeadwoodCost against the built triangle count')

  let worst = ''
  const bad = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const u = geo.userData.deadwood
      const cost = deadwoodCost(deadwoodParams(name, 7), tier)
      if (cost.triangles !== u.triangles) bad.push(`${name} T${tier}: cost ${cost.triangles} built ${u.triangles}`)
      if (cost.tier !== u.tier) bad.push(`${name} T${tier}: named ${cost.tier} vs ${u.tier}`)
      // The split matters as much as the total: the bench reports where the
      // budget went, and a barrel/cap/stub split that is right only in sum is a
      // lie about which knob to turn.
      if (cost.barrel !== u.barrelTris || cost.caps !== u.capTris || cost.stubTris !== u.stubTris) {
        bad.push(`${name} T${tier}: split ${cost.barrel}/${cost.caps}/${cost.stubTris} vs ${u.barrelTris}/${u.capTris}/${u.stubTris}`)
      }
      if (tier === 0) worst = `${name} ${u.triangles}`
    }
  }
  check(bad.length === 0, 'every variant at every tier costs exactly what it said it would',
    bad.length === 0 ? `${VARIANTS.length * TIERS.length} builds` : bad.join('; '))

  // And the formula has to be pure arithmetic, not a cache of the last build.
  const a = deadwoodCost(deadwoodParams('log-3m-oak-blown', 1), 0)
  const b = deadwoodCost(deadwoodParams('log-3m-oak-blown', 999), 0)
  check(a.triangles === b.triangles, 'and the cost does not depend on the seed', `${a.triangles} == ${b.triangles}`)
  void worst
}

// --- the §5 budget -----------------------------------------------------------

{
  console.log(`\nDESIGN.md §5: dead wood files under bush, at ${BUDGET_TRIS.join(' / ')}`)

  for (const tier of TIERS) {
    const over = []
    let max = 0
    for (const name of VARIANTS) {
      const n = get(name, tier).userData.deadwood.triangles
      max = Math.max(max, n)
      if (n > BUDGET_TRIS[tier]) over.push(`${name} ${n}`)
    }
    check(over.length === 0, `T${tier} fits ${BUDGET_TRIS[tier]} triangles`,
      over.length === 0 ? `worst ${max}` : `over: ${over.join(', ')}`)
  }
}

// --- bedding -----------------------------------------------------------------

{
  console.log('\nsitting on the ground')

  const hover = []
  const buried = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const pos = arr(get(name, tier), 'position')
      let min = Infinity
      for (let i = 1; i < pos.length; i += 3) min = Math.min(min, pos[i])
      if (min > 1e-5) hover.push(`${name} T${tier} +${min.toFixed(4)}`)
      if (min < -1e-5) buried.push(`${name} T${tier} ${min.toFixed(4)}`)
    }
  }
  check(hover.length === 0, 'nothing hovers -- every piece touches y = 0',
    hover.length === 0 ? `${VARIANTS.length * TIERS.length} builds` : hover.join(', '))
  check(buried.length === 0, 'and nothing hangs below it', buried.length === 0 ? 'min y == 0' : buried.join(', '))

  // A log lies down and a snag stands up, and the difference is not cosmetic:
  // material.js's moss height cue measures from the instance root, so a piece
  // that is standing when it should be lying is clean where it should be green.
  const lying = []
  for (const name of VARIANTS) {
    const u = get(name, 0).userData.deadwood
    const flat = u.measured.height < u.measured.span * 0.5
    if (u.kind === 'log' && !flat) lying.push(`${name} stands: h ${u.measured.height.toFixed(2)} of ${u.measured.span.toFixed(2)}`)
    if (u.kind === 'snag' && flat) lying.push(`${name} lies: h ${u.measured.height.toFixed(2)} of ${u.measured.span.toFixed(2)}`)
  }
  check(lying.length === 0, 'logs lie down and snags stand up',
    lying.length === 0 ? 'by measured height against spine length' : lying.join('; '))
}

// --- the attribute layout ----------------------------------------------------

{
  console.log('\nthe attribute layout BatchedMesh will lock to')

  const WANT = ['position', 'normal', 'uvProj', 'texLayer']
  const wrong = []
  const badIndex = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const got = Object.keys(geo.attributes).sort()
      if (got.join(',') !== [...WANT].sort().join(',')) wrong.push(`${name} T${tier}: ${got.join(',')}`)

      const idx = geo.getIndex()
      const n = geo.getAttribute('position').count
      if (!idx) badIndex.push(`${name} T${tier}: no index`)
      else if (idx.count !== n) badIndex.push(`${name} T${tier}: index ${idx.count} vs ${n} vertices`)
      else {
        for (let i = 0; i < idx.count; i++) {
          if (idx.array[i] !== i) { badIndex.push(`${name} T${tier}: index[${i}] = ${idx.array[i]}`); break }
        }
      }
    }
  }
  check(wrong.length === 0, `exactly ${WANT.join(' / ')} and nothing else`,
    wrong.length === 0 ? WANT.join(',') : wrong.join('; '))
  check(badIndex.length === 0, 'and an identity index over a non-indexed mesh',
    badIndex.length === 0 ? 'index[i] == i' : badIndex.join('; '))

  // Vertex counts have to be a whole number of triangles at three vertices each,
  // or the identity index above is walking off the end of somebody's face.
  const ragged = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const u = geo.userData.deadwood
      const n = geo.getAttribute('position').count
      if (n !== u.triangles * 3) ragged.push(`${name} T${tier}: ${n} verts for ${u.triangles} tris`)
    }
  }
  check(ragged.length === 0, 'and three vertices for every triangle', ragged.length === 0 ? 'no shared vertices' : ragged.join('; '))
}

// --- numbers that are actually numbers ---------------------------------------

{
  console.log('\nfinite geometry')

  const nan = []
  const stubby = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      for (const attr of ['position', 'normal', 'uvProj', 'texLayer']) {
        const a = arr(geo, attr)
        for (let i = 0; i < a.length; i++) {
          if (!Number.isFinite(a[i])) { nan.push(`${name} T${tier} ${attr}[${i}] = ${a[i]}`); break }
        }
      }
      const nrm = arr(geo, 'normal')
      for (let i = 0; i < nrm.length; i += 3) {
        const len = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2])
        if (Math.abs(len - 1) > 1e-3) { stubby.push(`${name} T${tier} |n| = ${len.toFixed(4)}`); break }
      }
    }
  }
  check(nan.length === 0, 'no NaN or Infinity anywhere in any attribute',
    nan.length === 0 ? `${VARIANTS.length * TIERS.length} builds x 4 attributes` : nan.join('; '))
  check(stubby.length === 0, 'and every normal is unit length', stubby.length === 0 ? '|n| == 1' : stubby.join('; '))
}

// --- winding ----------------------------------------------------------------

{
  console.log('\nwinding, against the normals it was authored beside')

  const flipped = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const p = arr(geo, 'position')
      const n = arr(geo, 'normal')
      let bad = 0
      for (let f = 0; f < p.length; f += 9) {
        const ax = p[f + 3] - p[f], ay = p[f + 4] - p[f + 1], az = p[f + 5] - p[f + 2]
        const bx = p[f + 6] - p[f], by = p[f + 7] - p[f + 1], bz = p[f + 8] - p[f + 2]
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx
        // Against the average of the three stored normals: on a smoothed face
        // the stored normals lean away from the face, but never past ninety
        // degrees -- past that the face is inside out.
        const mx = (n[f] + n[f + 3] + n[f + 6]) / 3
        const my = (n[f + 1] + n[f + 4] + n[f + 7]) / 3
        const mz = (n[f + 2] + n[f + 5] + n[f + 8]) / 3
        if (cx * mx + cy * my + cz * mz <= 0) bad++
      }
      if (bad > 0) flipped.push(`${name} T${tier}: ${bad} faces`)
    }
  }
  check(flipped.length === 0, 'every face winds the way its normals point',
    flipped.length === 0 ? 'no inside-out triangles' : flipped.join('; '))

  // AND THE SAME QUESTION ASKED SOMEWHERE THE ANSWER CANNOT BE A TAUTOLOGY.
  //
  // The test above is blind on exactly one kind of face. A cap is emitted flat
  // (smooth = 0), which makes each stored vertex normal a COPY of the face
  // normal, so the dot product is 1 whichever way the triangle is wound. Both
  // caps were in fact wound inside out -- the top of every snag was a backface,
  // which is what "the top face is just black" looks like -- and the assertion
  // above stayed green through all of it, comparing the value to itself.
  //
  // So the caps are asked a question with an outside answer: which way do they
  // point in the WORLD. On a snag the spine runs up +Y and no rotation is
  // applied, so the top cap must have a positive Y and the butt cap a negative
  // one, whatever `cup` does to the middle of the fan -- a bored hollow is a
  // funnel whose walls still face up, tilted inward by atan(depth/radius) and
  // never past horizontal. Logs are not sampled here, and do not need to be:
  // they are the same fan under a rigid rotation, which cannot turn a face over.
  const facing = []
  for (const name of VARIANTS) {
    if (get(name, 0).userData.deadwood.kind !== 'snag') continue
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const p = arr(geo, 'position')
      // The cap block's extent comes from the cost model rather than from
      // guessing at the geometry: barrel first, then the two fans, then stubs.
      const cost = deadwoodCost(deadwoodParams(name, 7), tier)
      const half = cost.caps / 2
      for (let i = 0; i < cost.caps; i++) {
        const f = (cost.barrel + i) * 9
        const ax = p[f + 3] - p[f], ay = p[f + 4] - p[f + 1], az = p[f + 5] - p[f + 2]
        const bx = p[f + 6] - p[f], by = p[f + 7] - p[f + 1], bz = p[f + 8] - p[f + 2]
        const ny = az * bx - ax * bz
        // buildCap(1) runs first, so the first half is the top.
        const want = i < half ? 1 : -1
        if (ny * want <= 0) facing.push(`${name} T${tier} ${i < half ? 'top' : 'butt'} cap face ${i}`)
      }
    }
  }
  check(facing.length === 0, 'and a snag\'s end caps face out of the snag, not into it',
    facing.length === 0 ? 'top cap up, butt cap down, at every tier' : `${facing.length} inverted: ${facing.slice(0, 4).join('; ')}`)
}

// --- the LOD ladder is one shape ---------------------------------------------

{
  console.log('\nthe tiers are the same swept surface, sampled coarser')

  // `span` and `buttDiameter` come straight off the parameters rather than off
  // the sampling, so if the tiers ever disagree about them the coarse tier is
  // not asking the same shape function -- which is the whole purity claim.
  const drift = []
  for (const name of VARIANTS) {
    const base = get(name, 0).userData.deadwood.measured
    for (const tier of TIERS.slice(1)) {
      const m = get(name, tier).userData.deadwood.measured
      if (Math.abs(m.span - base.span) > 1e-6) drift.push(`${name} T${tier} span ${m.span} vs ${base.span}`)
      if (Math.abs(m.buttDiameter - base.buttDiameter) > 1e-6) drift.push(`${name} T${tier} butt ${m.buttDiameter} vs ${base.buttDiameter}`)
    }
  }
  check(drift.length === 0, 'every tier agrees on spine length and butt diameter',
    drift.length === 0 ? 'exactly, to the float' : drift.join('; '))

  // And the measured extent has to survive. A coarse tier is an inscribed
  // polygon so it is ALWAYS smaller, but the two kinds of dimension lose their
  // size for completely different reasons and are worth holding to completely
  // different standards.
  //
  //   THE LONG AXIS is how far the piece reaches along its own spine -- the
  //   height of a snag, the length of a log. Sides do not touch it; it is carried
  //   by the ring count and by nothing else, so a coarse tier has no honest
  //   reason to lose any of it. Held at 0.90, which is loose only because a
  //   jagged break ring (a stump at jagCount 7) samples fewer teeth on 3 sides
  //   and so genuinely misses its own tallest spike, at 93%.
  //
  //   THE TWO CROSS AXES are the cross-section, and there a coarse tier is a
  //   triangle inscribed in what T0 drew as an octagon. That loses about a
  //   quarter by construction -- the worst orientation of a 3-gon inscribes at
  //   cos(60 deg) = 50% of the circle it is cut from -- and today's spread runs
  //   68% to 94%. So 0.62 is a REGRESSION FLOOR, not a quality bound: it sits
  //   between the measured worst case and the 56% that the straightened-spine
  //   bug produced, and it is deliberately not tightened towards 68%, because a
  //   variant whose lobes happen to phase away from a T2 vertex angle would fail
  //   a tighter one while being perfectly correct. The detail line prints the
  //   tightest margin so this drifting can be watched rather than discovered.
  const LONG_FLOOR = 0.9
  const CROSS_FLOOR = 0.62

  // The ceilings are not one number either, and for the mirror image of the
  // reason the floors are not. Along the SPINE both tiers sample the same two
  // ends, so a coarse tier that reaches FURTHER is a bug and 1.02 is slack for
  // the float; that is the old bound and it stays.
  //
  // ACROSS the spine a coarse tier is legitimately allowed to be wider. Neither
  // tier draws the swept surface -- both inscribe a polygon in it -- and T0's
  // octagon already gives away up to 1 - cos(pi/8) = 7.6% on its worst axis. A
  // triangle whose three angles happen to land on fatter lobes than any of the
  // octagon's eight can therefore out-measure it without either being wrong, up
  // to 1/cos(pi/8) = 1.082. So the cross ceiling is the octagon's own inscription
  // loss plus float slack, NOT a number fitted to today's build: the widest log runs
  // 104% and would have to reach 109% to mean anything had actually grown.
  const LONG_CEIL = 1.02
  const CROSS_CEIL = 1.09
  const shrunk = []
  let tightLong = Infinity, tightLongAt = ''
  let tightCross = Infinity, tightCrossAt = ''
  let wideCross = 0, wideCrossAt = ''
  for (const name of VARIANTS) {
    const base = get(name, 0).userData.deadwood.measured
    // Which axis is the spine's is a property of the KIND, not of which box
    // dimension happens to be biggest: a snag's spine is up however squat it is,
    // and `stump` is a snag that is two and a half times wider than it is tall.
    // A log's spine is along the ground, and `roll` and `pitch` decide which of
    // the two horizontal axes carries it.
    const axes = ['width', 'height', 'depth']
    const kind = get(name, 0).userData.deadwood.kind
    const longAxis = kind === 'snag' ? 'height' : (base.depth >= base.width ? 'depth' : 'width')
    for (const tier of TIERS.slice(1)) {
      const m = get(name, tier).userData.deadwood.measured
      for (const axis of axes) {
        const ratio = m[axis] / base[axis]
        const isLong = axis === longAxis
        const floor = isLong ? LONG_FLOOR : CROSS_FLOOR
        if (isLong && ratio < tightLong) { tightLong = ratio; tightLongAt = `${name} T${tier}` }
        if (!isLong && ratio < tightCross) { tightCross = ratio; tightCrossAt = `${name} T${tier} ${axis}` }
        if (!isLong && ratio > wideCross) { wideCross = ratio; wideCrossAt = `${name} T${tier} ${axis}` }
        if (ratio < floor) shrunk.push(`${name} T${tier} ${axis} ${(ratio * 100).toFixed(0)}% (${isLong ? 'spine' : 'cross'})`)
        const ceil = isLong ? LONG_CEIL : CROSS_CEIL
        if (ratio > ceil) shrunk.push(`${name} T${tier} ${axis} ${(ratio * 100).toFixed(0)}% -- coarse tier is BIGGER (${isLong ? 'spine' : 'cross'})`)
      }
    }
  }
  const pct = (x) => `${(x * 100).toFixed(0)}%`
  check(shrunk.length === 0, 'the spine keeps its reach and the cross-section keeps its wander',
    shrunk.length === 0
      ? `spine >= ${pct(LONG_FLOOR)}, tightest ${pct(tightLong)} at ${tightLongAt}; cross ${pct(CROSS_FLOOR)}..${pct(CROSS_CEIL)}, tightest ${pct(tightCross)} at ${tightCrossAt}, widest ${pct(wideCross)} at ${wideCrossAt}`
      : shrunk.join('; '))
}

// --- determinism -------------------------------------------------------------

{
  console.log('\nthe seed is the whole state')

  const same = (a, b) => {
    const x = arr(a, 'position'), y = arr(b, 'position')
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  const p = deadwoodParams('log-3m-oak-blown', 42)
  check(same(buildDeadwood(p), buildDeadwood(p)), 'the same parameters build the same log, to the float')
  check(!same(buildDeadwood(p), buildDeadwood({ ...p, seed: 43 })),
    'and a different seed builds a different one', 'not a constant wearing a seed')

  // The two named builders are the only thing distinguishing a snag from a log
  // for a caller, so they have to actually override kind rather than pass it on.
  check(buildSnag({ seed: 3 }).userData.deadwood.kind === 'snag', 'buildSnag builds a snag')
  check(buildLog({ seed: 3 }).userData.deadwood.kind === 'log', 'buildLog builds a log')
  check(buildLog({ seed: 3, kind: 'snag' }).userData.deadwood.kind === 'log',
    'and buildLog wins over a kind passed in beside it', 'the builder IS the kind')
}

// --- the layers, and whether the weather can find them -----------------------

{
  console.log('\ntexture layers')

  const used = new Set()
  const outOfRange = []
  const fractional = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const u = geo.userData.deadwood
      const want = new Set([u.barkLayer, u.woodLayer])
      for (const v of arr(geo, 'texLayer')) {
        used.add(v)
        if (!Number.isInteger(v)) fractional.push(`${name} T${tier}: ${v}`)
        if (!want.has(v)) outOfRange.push(`${name} T${tier}: layer ${v} is neither bark ${u.barkLayer} nor wood ${u.woodLayer}`)
      }
    }
  }
  check(fractional.length === 0, 'texLayer is a whole slice index, never an interpolation',
    fractional.length === 0 ? `${used.size} distinct layers used` : fractional.slice(0, 3).join('; '))
  check(outOfRange.length === 0, 'and every face wears its own piece\'s bark or heartwood',
    outOfRange.length === 0 ? [...used].sort((a, b) => a - b).join(', ') : outOfRange.slice(0, 3).join('; '))

  const over = [...used].filter((v) => !(v < LAYER_COUNT))
  check(over.length === 0, `and every layer is inside LAYER_COUNT`,
    over.length === 0 ? `< ${LAYER_COUNT}` : over.join(', '))

  // The gate that catches the silent one. Moss and snow are chosen in
  // src/material.js by layer index, so a layer nobody listed simply never
  // weathers -- no error, ever, at any distance.
  const noMoss = [...used].filter((v) => !MOSS_LAYERS.includes(v))
  const noSnow = [...used].filter((v) => !SNOW_WOOD_LAYERS.includes(v))
  check(noMoss.length === 0, 'every layer dead wood uses can grow moss (MOSS_LAYERS)',
    noMoss.length === 0 ? `${MOSS_LAYERS.length} mossy layers` : `unlisted: ${noMoss.join(', ')}`)
  check(noSnow.length === 0, 'and can catch snow (SNOW_WOOD_LAYERS)',
    noSnow.length === 0 ? `${SNOW_WOOD_LAYERS.length} snowy wood layers` : `unlisted: ${noSnow.join(', ')}`)

  check(DEADWOOD_DEFAULTS.barkLayer === LAYER.BARK && DEADWOOD_DEFAULTS.woodLayer === LAYER.TIMBER_BEAM,
    'and the defaults reuse the living trees\' bark and the buildings\' timber',
    `bark ${DEADWOOD_DEFAULTS.barkLayer}, wood ${DEADWOOD_DEFAULTS.woodLayer} -- zero new texture layers`)
}

// --- the UV ------------------------------------------------------------------

{
  console.log('\nthe projected UV')

  const bad = []
  for (const name of VARIANTS) {
    for (const tier of TIERS) {
      const geo = get(name, tier)
      const u = geo.userData.deadwood
      if (!(u.uRepeat > 0)) bad.push(`${name} T${tier}: uRepeat ${u.uRepeat}`)
      if (!(u.texMetres > 0)) bad.push(`${name} T${tier}: texMetres ${u.texMetres}`)
      // Bark is a tiling texture, so the UV is free to leave [0,1] -- what it
      // cannot do is run away. A hundred repeats over a 8 m log is a moire.
      const uv = arr(geo, 'uvProj')
      let max = 0
      for (let i = 0; i < uv.length; i++) max = Math.max(max, Math.abs(uv[i]))
      if (max > 64) bad.push(`${name} T${tier}: |uv| reaches ${max.toFixed(1)}`)
    }
  }
  check(bad.length === 0, 'tiles at a sane rate and repeats a sane number of times',
    bad.length === 0 ? 'uRepeat > 0, |uv| <= 64' : bad.join('; '))

  const fractionBad = []
  for (const name of VARIANTS) {
    const f = get(name, 0).userData.deadwood.barkFraction
    if (!(f >= 0 && f <= 1)) fractionBad.push(`${name}: ${f}`)
  }
  check(fractionBad.length === 0, 'and the reported bark fraction is a fraction',
    fractionBad.length === 0 ? 'in [0,1]' : fractionBad.join('; '))
}

// --- the bench's reads against the shader's frozen constants -----------------
//
// This one is here because it already happened. src/material.js's MOSS object
// lost `edge` when moss went from a hard cut to a blend, and /gen-deadwood went
// on reading `MOSS.edge` -- which is not an error in JS, it is `undefined`, and
// it did not become an error until `.toFixed(2)` was called on it in the browser.
// Nothing caught it: check-shaders validates the GLSL, the gates above validate
// the geometry, and the bench's read of a frozen JS object sits between the two.
//
// It is the session's own finding turned on itself. Every gate that failed today
// stayed green while the thing underneath it changed, because it re-implemented
// its subject instead of interrogating it -- and then I froze two objects, said
// so, and shipped a page that read a property one of them no longer had. So this
// interrogates: it scrapes the property names the bench actually reads out of the
// bench's own source and asks the real objects whether they have them.
{
  console.log('\nthe bench reads properties that exist')

  const bench = fs.readFileSync(new URL('../src/gen-deadwood-main.js', import.meta.url), 'utf8')
  const OBJECTS = { MOSS, SNOW_ROCK }
  const missing = []
  let read = 0
  for (const [name, obj] of Object.entries(OBJECTS)) {
    // `\b` before the name so MOSS_LAYERS and friends are not mistaken for it.
    for (const m of bench.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'g'))) {
      read++
      if (!(m[1] in obj)) missing.push(`${name}.${m[1]}`)
    }
  }
  check(read > 0, 'found the reads to check at all', `${read} property reads in gen-deadwood-main.js`)
  check(missing.length === 0, 'every shader constant the bench prints is still exported',
    missing.length === 0 ? `${Object.keys(OBJECTS).join(' + ')}, all defined`
      : `undefined: ${[...new Set(missing)].join(', ')}`)
}

// --- the shipping bank ------------------------------------------------------
//
// What buildDeadwoodBank hands the scatter, and the three things about it that
// the scatter cannot survive being wrong.
//
//   THE TIERS GO OUT OF STEP. The scatter indexes `tierIds[tier][variant]`, so a
//   tier that came back a different length than its neighbours reads off the end
//   of one array and hands BatchedMesh an undefined geometry id -- or worse,
//   silently draws variant 12 where variant 30 was asked for.
//
//   THE MEASUREMENTS GO MISSING. `long`, `height` and `radius` are hung on the
//   variant records by buildDeadwoodBank from the geometry it just built, and
//   render/deadwood.js seats every piece with them. An undefined there is a NaN
//   in a matrix, which does not throw: the instance simply never appears, and it
//   is one instance out of a hundred and thirty.
//
//   THE CARD IS SMALLER THAN THE MESH IT REPLACES. The bands are fixed at 10 and
//   20 m, so the swap happens at a distance the player is looking at. A card
//   framed tighter than the piece it stands in for makes the log visibly shrink
//   as they back away from it.
{
  console.log('\nthe bank is built for the scatter that indexes it')

  const bank = buildDeadwoodBank({ billboard: true })
  const want = DEADWOOD_NAMES.length * DEADWOOD_SEEDS
  const lens = bank.tiers.map((t) => t.geometries.length)
  check(bank.tiers.length === 3, 'three tiers: mesh, coarse mesh, billboard', `${bank.tiers.length} tiers`)
  check(lens.every((n) => n === want) && bank.variants.length === want,
    'every tier carries one geometry per variant slot',
    `${want} slots (${DEADWOOD_NAMES.length} names x ${DEADWOOD_SEEDS} seeds), tiers ${lens.join('/')}`)

  const cardTris = bank.tiers[2].triangles
  check(cardTris.every((n) => n === 2), 'and the billboard tier is one quad each',
    `${cardTris[0]} tris`)

  const unmeasured = bank.variants
    .filter((v) => !(v.long > 0) || !(v.height > 0) || !(v.radius > 0))
    .map((v) => v.name)
  check(unmeasured.length === 0, 'every variant carries the extents the scatter seats it by',
    unmeasured.length === 0 ? 'long, height and radius all positive and finite'
      : `missing on: ${[...new Set(unmeasured)].join(', ')}`)

  // The quad against the piece, through the same impostorCardExtents the bake
  // frames with -- so this is the SWAP being checked, not the arithmetic.
  const tight = []
  bank.tiers[2].geometries.forEach((g, i) => {
    const v = bank.variants[i]
    const ext = impostorCardExtents({ width: v.long, height: v.height })
    const pos = g.attributes.position.array
    let w = 0
    let h = 0
    // HORIZONTAL DISTANCE FROM THE AXIS, not the X extent: a log's card is fixed
    // and turned to the azimuth it was photographed at, so its width lies along
    // Z and reading X alone would measure it as nothing at all.
    for (let k = 0; k < pos.length; k += 3) {
      w = Math.max(w, Math.hypot(pos[k], pos[k + 2]) * 2)
      h = Math.max(h, pos[k + 1])
    }
    // A hair of tolerance for the float round-trip through the attribute array.
    if (w < v.long - 1e-3 || h < v.height - 1e-3) {
      tight.push(`${v.name}: card ${w.toFixed(2)}x${h.toFixed(2)} < mesh ${v.long.toFixed(2)}x${v.height.toFixed(2)}`)
    }
    if (w > ext.width + 1e-3 || h > ext.height + 1e-3) {
      tight.push(`${v.name}: card ${w.toFixed(2)}x${h.toFixed(2)} overshoots the frame`)
    }
  })
  check(tight.length === 0, 'and each billboard covers the piece it stands in for',
    tight.length === 0 ? 'card >= mesh extents, and within the baked frame' : tight.join('; '))

  // A LOG'S CARD DOES NOT SPIN AND A SNAG'S DOES, which is the fix for the log
  // that changed heading every time the LOD swapped. Three things have to agree
  // or the tier is wrong in a way nothing else here would catch:
  //
  //   THE MARKER. material.js spins a card iff `normal.y > CARD_UP_MARK`, so the
  //   log's normal has to be horizontal and the snag's vertical. This is the
  //   whole of the behaviour and it is one number.
  //
  //   THE AIM. A fixed card is only right if it lies in the plane the camera was
  //   at when the picture was taken -- bakeImpostor stands at (sin a, 0, cos a),
  //   so the normal must point THERE. Checked against cardAzimuth, which is also
  //   what the bake reads, so the two cannot be set apart by hand.
  //
  //   THE SPAN. The log is built lying down its own +Z, so a card carrying its
  //   length has to span Z and not X. Measured as the quad's actual extent.
  const spin = []
  bank.tiers[2].geometries.forEach((g, i) => {
    const v = bank.variants[i]
    const log = v.kind === 'log'
    const n = g.attributes.normal.array
    const pos = g.attributes.position.array
    const az = log ? cardAzimuth(v.kind) : 0
    const wantN = log ? [Math.sin(az), 0, Math.cos(az)] : [0, 1, 0]
    for (let k = 0; k < n.length; k += 3) {
      if (Math.hypot(n[k] - wantN[0], n[k + 1] - wantN[1], n[k + 2] - wantN[2]) > 1e-6) {
        spin.push(`${v.name}: normal ${[n[k], n[k + 1], n[k + 2]].map((q) => q.toFixed(2))} not ${wantN}`)
        break
      }
    }
    if (g.userData.impostor.upNormal !== !log) spin.push(`${v.name}: upNormal ${g.userData.impostor.upNormal}`)
    if (g.userData.impostor.azimuth !== az) spin.push(`${v.name}: baked at ${az}, quad at ${g.userData.impostor.azimuth}`)
    let ax = 0
    let azx = 0
    for (let k = 0; k < pos.length; k += 3) {
      ax = Math.max(ax, Math.abs(pos[k]))
      azx = Math.max(azx, Math.abs(pos[k + 2]))
    }
    // The long axis is Z for a log and X for a snag, and the other one is flat.
    if (log ? !(azx > 0.1 && ax < 1e-6) : !(ax > 0.1 && azx < 1e-6)) {
      spin.push(`${v.name}: spans x=${ax.toFixed(2)} z=${azx.toFixed(2)}`)
    }
  })
  check(spin.length === 0, 'the log\'s card is fixed and aimed at its own bake angle, the snag\'s spins',
    spin.length === 0 ? `logs face ${(cardAzimuth('log') * 180 / Math.PI).toFixed(0)} degrees and span Z; snags carry the up marker`
      : spin.slice(0, 4).join('; '))

  // The bake and the quad read the SAME function for the angle. Source, because
  // the failure this rules out is somebody re-typing the quarter turn at one of
  // the two sites: the two would still each be self-consistent and every number
  // above would still pass, with the card showing a log end-on.
  const bankSrc = fs.readFileSync(new URL('../src/props/deadwood-bank.js', import.meta.url), 'utf8')
  check(
    /azimuth: cardAzimuth\(kind\)/.test(bankSrc) && /azimuth: spun \? 0 : cardAzimuth\(v\.kind\)/.test(bankSrc),
    'and the photograph and the quad take their angle from one place',
    'cardAzimuth is read by both cardSubject and the card build')

  const imp = deadwoodImpostorLayers()
  check(new Set(imp).size === imp.length && imp.every((l) => l >= 0 && l < LAYER_COUNT),
    'the impostor layers are distinct and inside the atlas', `${imp.join(', ')} of ${LAYER_COUNT}`)
  // A billboard's vertex normal says nothing about the surface it is a picture
  // of -- vertical on the snag, horizontal on the log -- so it must take its
  // snow as a coverage fraction off the card list rather than off the
  // normal-dependent hard-surface recipe, which reads that normal and would
  // paint the snag's whole card white and the log's not at all. Same reason
  // the tree impostors are on this list. Not on MOSS_LAYERS, also like the
  // trees: a 20 m card is not the place to resolve a moss patch.
  const offCard = imp.filter((l) => !SNOW_CARD_LAYERS.includes(l))
  check(offCard.length === 0, 'and both take their snow as a flat card',
    offCard.length === 0 ? 'in SNOW_CARD_LAYERS' : `missing: ${offCard.join(', ')}`)

  for (const t of bank.tiers) for (const g of t.geometries) g.dispose()

  check(DEADWOOD_BANDS.length === 3 && DEADWOOD_BANDS.every((b, i) => i === 0 || b > DEADWOOD_BANDS[i - 1]),
    'the LOD bands ascend and end at the cull distance', `${DEADWOOD_BANDS.join(' / ')} m`)
}

// --- the scatter seats a long thing on a hill -------------------------------
//
// THE ONE THING THIS FAMILY DOES THAT NO OTHER SCATTER IN /v2 DOES. Every other
// prop is small enough to drop on a single height sample; a 3 m log is not, and
// render/deadwood.js._seat answers that by sampling the ground under each end
// and pitching to the line between them.
//
// That pitch is a rotation about a world axis derived from the yaw, and its SIGN
// is a coin flip that nothing else in the pipeline can catch. Get it backwards
// and the correction runs the wrong way: instead of levelling the log into the
// hill it doubles the tilt, so the uphill end lifts about half a metre into the
// air on a 20% slope. It still draws, it still lights correctly, and it looks
// like a physics bug rather than like a sign error.
//
// So this places the real scatter on a synthetic hill of known gradient and asks
// the only question the user actually asked: is there daylight under anything.
// A log is checked at its two ends and a stump around its base rim, because a
// stump does not pitch -- it stands vertical and sinks, which is what a tree
// that grew toward the light and then broke would do.
// What the scatter needs from the rest of the world, stubbed. Shared by the two
// blocks below because they differ only in the FOREST they are placed against.
const MOCK_WATER = { isSubmerged: () => false }
const MOCK_LAYERS = {
  paths: { nearest: () => null },
  snow: { base: 900, band: 40 },
  flattenAt: () => 0,
}
// A stub texture array: the scatter only reads image.depth off it, and building
// the real atlas here would be a megabyte of canvas work for a number this gate
// already knows.
const MOCK_TEX = { image: { depth: LAYER_COUNT } }
/** A forest of `trunks` [x, z, radius], answering the anchorsInto contract. */
function mockForest(trunks) {
  return {
    anchorsInto(x0, z0, x1, z1, out) {
      const cap = (out.length / 4) | 0
      let n = 0
      for (const [x, z, r] of trunks) {
        if (x < x0 || x >= x1 || z < z0 || z >= z1) continue
        if (n >= cap) return cap
        out[n * 4] = x
        out[n * 4 + 1] = 0
        out[n * 4 + 2] = z
        out[n * 4 + 3] = r
        n++
      }
      return n
    },
  }
}
const EMPTY_FOREST = mockForest([])

{
  console.log('\nnothing lies with a gap under it')

  const m = new THREE.Matrix4()
  const v = new THREE.Vector3()
  const floating = []
  let sampled = 0

  // How much daylight is none. NOT zero, and the reason is geometry rather than
  // slack: a rigid body on a curved surface touches it at a finite number of
  // points and lifts between them, so the only question is by how much. Three
  // centimetres is under the terrain mesh's own faceting at these distances and
  // is a fortieth of the radius of the log it would be showing under -- and the
  // failures this gate is for are 10 to 50 cm, an end lifted by a sign error or
  // a belly arched over a rise. There is no band between the two to argue about.
  const GAP_TOL = 0.03

  // Flat, then a fifth, then the steepest the placement rule will accept, then a
  // rolling ridge. Flat is not a throwaway: it is the case where the pitch must
  // be exactly zero, and a sign error hides there. The ridge is not either -- see
  // the midpoint probe below.
  const MAX_TAN = Math.tan((25 * Math.PI) / 180)
  const GROUNDS = [
    { name: 'flat', h: () => 60, tan: () => 0 },
    { name: '1 in 5', h: (x) => 60 + x * 0.2, tan: () => 0.2 },
    { name: '25 degrees', h: (x) => 60 + x * MAX_TAN, tan: () => MAX_TAN },
    // CONVEX GROUND, which is the one shape a two-end seat gets wrong by
    // construction: seated on the mean of its ends, a log lying across a rise is
    // a chord under an arc and the ground pushes up between them, leaving the
    // belly in the air with both ends buried. A sine rather than a single crest
    // so that a real share of the placements land on convex arcs rather than the
    // handful that happen to straddle one ridge line.
    { name: 'ridge', h: (x) => 60 + 3 * Math.sin(x * 0.15), tan: (x) => Math.abs(0.45 * Math.cos(x * 0.15)) },
  ]
  for (const g of GROUNDS) {
    const groundAt = g.h
    const field = {
      heightAt: (x) => groundAt(x),
      heightAndSlopeAt: (x) => ({ h: groundAt(x), tan: g.tan(x) }),
      snowLineAt: () => 900,
      bands: { altLo: 0, altSpan: 100 },
    }
    // No trees at all, so the keep-out cannot quietly thin the sample this block
    // is trying to take. The forest is the next block's subject.
    const dw = new Deadwood(new THREE.Scene(), field, MOCK_WATER, MOCK_LAYERS, MOCK_TEX,
      EMPTY_FOREST, { seed: 7 })
    dw.place(0, 0)
    if (dw.placed === 0) floating.push(`${g.name}: nothing placed at all`)

    for (const tile of dw.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const vi = dw.variantAt[id]
        dw.batch.getMatrixAt(id, m)
        // A log at its two ENDS along its own long axis AND at its MIDPOINT; a
        // stump at four points around its BUTT RIM. All of them local y = 0,
        // which is where buildDeadwood cuts the piece flat.
        //
        // The midpoint is what tests the crest term in `_seat`: the ends alone
        // are satisfied by a chord seat, and a chord seat on convex ground is
        // exactly the arch this gate exists to catch.
        const probes = []
        if (dw.isLog[vi]) {
          // Nine points down the belly, so five of them are NOT the ones `_seat`
          // sampled. A seat checked only where it looked is not a check.
          for (let s = -1; s <= 1.0001; s += 0.25) probes.push([0, s * dw.vLong[vi] * 0.5])
        } else {
          // Eight points round the rim: the four `_seat` samples and the four
          // diagonals it did not, for the same reason.
          const r = dw.vRadius[vi]
          const d = r * Math.SQRT1_2
          probes.push([r, 0], [-r, 0], [0, r], [0, -r], [d, d], [d, -d], [-d, d], [-d, -d])
        }
        for (const [ox, oz] of probes) {
          v.set(ox, 0, oz).applyMatrix4(m)
          sampled++
          const gap = v.y - groundAt(v.x)
          if (gap > GAP_TOL) {
            floating.push(
              `${g.name} ${dw.isLog[vi] ? 'log' : 'stump'} ` +
              `${dw.bank.variants[vi].name}: ${(gap * 100).toFixed(1)} cm of daylight`
            )
          }
        }
      }
    }
    dw.dispose()
  }

  check(sampled > 0, 'found pieces to probe at all', `${sampled} contact points over four grounds`)
  check(floating.length === 0, 'every log and stump meets the ground it was seated on',
    floating.length === 0 ? 'flush or embedded at every contact point, flat to 25 degrees and over a ridge'
      : `${floating.length} floating: ${floating.slice(0, 4).join('; ')}`)
}

// --- and none of it is lying on a tree --------------------------------------
//
// THE BUG THIS BLOCK EXISTS FOR was not subtle: trees.js, ferns.js, grass.js and
// render/deadwood.js all hash a tile with the same `tileSeed`, all run it off the
// same world seed, all use 25 m tiles, and all spend their first two draws on the
// candidate's x and z. The streams were therefore IDENTICAL, and since a deadwood
// tile draws four candidates against the forest's thirty-one, candidate 0 of
// every tile was seated on the trunk of tree 0 of that tile -- every piece of
// dead wood in the world standing in a tree.
//
// So there are two things to hold, and they fail in different directions:
//
//   THE SALT, which is what stops the collision being systematic. Tested against
//   a forest planted at exactly the positions the UNSALTED stream produces --
//   candidate 0 of each tile, which is the one collision that does not depend on
//   how many randoms either module draws per candidate. Unsalted, the keep-out
//   would reject that candidate in every tile and the yield would fall by about a
//   quarter; salted, a lone 0.35 m trunk in a 625 m^2 tile is nearly never in the
//   way.
//
//   THE KEEP-OUT, which catches the incidental collision the salt cannot. Tested
//   against a dense grid of trunks, by measuring every placed piece against every
//   trunk near it -- a log as the segment it actually is, not as its midpoint.
{
  console.log('\nand none of it is lying on a tree')

  const field = {
    heightAt: () => 60,
    heightAndSlopeAt: () => ({ h: 60, tan: 0 }),
    snowLineAt: () => 900,
    bands: { altLo: 0, altSpan: 100 },
  }

  // trees.js's own hash and PRNG, copied rather than imported because neither is
  // exported. If the forest ever changes either one this block stops testing what
  // it says it tests -- so it also asserts, below, that the collision it is
  // simulating is one the salt actually has to defeat.
  const mulberry32 = (a) => () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const tileSeed = (tx, tz, seed) => {
    let h =
      Math.imul(tx | 0, 0x27d4eb2d) ^ Math.imul(tz | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
    return (h ^ (h >>> 15)) >>> 0
  }

  const SEED = 7
  const TILE = 25
  const REACH = 6 // tiles each way, comfortably past the 100 m draw radius

  const naive = []
  for (let tz = -REACH; tz <= REACH; tz++) {
    for (let tx = -REACH; tx <= REACH; tx++) {
      const rand = mulberry32(tileSeed(tx, tz, SEED))
      naive.push([(tx + rand()) * TILE, (tz + rand()) * TILE, 0.35])
    }
  }

  const grid = []
  for (let gz = -100; gz <= 100; gz += 8) for (let gx = -100; gx <= 100; gx += 8) grid.push([gx, gz, 0.4])

  const run = (forest) => {
    const dw = new Deadwood(new THREE.Scene(), field, MOCK_WATER, MOCK_LAYERS, MOCK_TEX, forest,
      { seed: SEED })
    dw.place(0, 0)
    return dw
  }

  const bare = run(EMPTY_FOREST)
  const onNaive = run(mockForest(naive))
  const kept = onNaive.placed / bare.placed

  // The CONTROL, and it is what makes the naive number mean anything: the same
  // trunk count at positions with no relationship to any stream. If the naive
  // forest ever costs materially more than this one, the two streams have found
  // their way back into step. Run FIRST because the absolute floor below is only
  // legible next to it.
  const control = run(mockForest(naive.map(([x, z, r]) => [x + TILE * 0.5, z + TILE * 0.37, r])))
  const incidental = control.placed / bare.placed

  check(bare.placed > 50, 'placed enough pieces to measure a yield', `${bare.placed} with no forest`)
  // THE FLOOR IS BELOW THE INCIDENTAL COST, NOT AT IT, and the gap between the
  // two is the thing that moved when LOG_LENGTH doubled: a 35 m log is a long
  // segment and crosses a sparse trunk by chance far more often than a 17 m one,
  // so even a perfectly decorrelated stream now loses most of the old headroom
  // to collisions that have nothing to do with the salt. What the floor still
  // has to separate is SALTED from UNSALTED, and unsalted lands near 75% -- so
  // it sits between the two rather than tracking either.
  check(kept > 0.85, 'the scatter does not draw the forest\'s own positions',
    `${onNaive.placed}/${bare.placed} survive a trunk on every tile's first candidate ` +
    `(${(kept * 100).toFixed(1)}%; incidental collisions alone cost ` +
    `${((1 - incidental) * 100).toFixed(1)}%, unsalted would be about 75%)`)
  check(kept > incidental - 0.05,
    'and pays no more for a forest on its own grid than for one beside it',
    `${onNaive.placed} against the control's ${control.placed}`)
  control.dispose()

  const dense = run(mockForest(grid))
  const m = new THREE.Matrix4()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const hits = []
  let measured = 0
  for (const tile of dense.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const vi = dense.variantAt[id]
      dense.batch.getMatrixAt(id, m)
      const half = dense.isLog[vi] ? dense.vLong[vi] * 0.5 : 0
      a.set(0, 0, -half).applyMatrix4(m)
      b.set(0, 0, half).applyMatrix4(m)
      const ex = b.x - a.x
      const ez = b.z - a.z
      const len2 = ex * ex + ez * ez
      for (const [gx, gz, gr] of grid) {
        const px = gx - a.x
        const pz = gz - a.z
        let t = len2 > 0 ? (px * ex + pz * ez) / len2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ox = px - t * ex
        const oz = pz - t * ez
        const d = Math.hypot(ox, oz)
        // The scale the instance was placed at, recovered off its own matrix --
        // the keep-out is stated surface to surface and the piece's half
        // thickness is part of it.
        const scale = Math.hypot(m.elements[0], m.elements[1], m.elements[2])
        const keep = gr + dense.vRadius[vi] * scale
        measured++
        if (d < keep) hits.push(`${dense.bank.variants[vi].name} ${(keep - d).toFixed(2)} m into a trunk`)
      }
    }
  }

  check(dense.placed > 0 && measured > 0, 'placed pieces in a dense wood to measure',
    `${dense.placed} pieces against ${grid.length} trunks (${dense.rejected.tree} rejected for it)`)
  check(hits.length === 0, 'nothing is seated on a trunk',
    hits.length === 0 ? 'every piece clears every trunk, surface to surface'
      : `${hits.length} through a trunk: ${hits.slice(0, 3).join('; ')}`)

  bare.dispose()
  onNaive.dispose()
  dense.dispose()
}

// --- and it comes out the size it was asked for, in metres ------------------
//
// THE BUG THIS BLOCK EXISTS FOR was a stump half a metre tall. The scatter used
// to roll a shared MULTIPLIER over the bank's own sizes, and the bank's stumps
// are built at 0.82 m and at 1.95 m -- so the same 0.7x floor that made the tall
// one a respectable 1.4 m turned the short one into a doorstop. The fix was to
// state the band in METRES and let the scale be whatever each variant needs, and
// the only way to check a fix like that is to measure the placed instances.
//
// Measured off the batch's own matrices rather than off the constants, because
// the constants are what the bug agreed with: SIZE_RANGE said [0.7, 5.8] and was
// perfectly self-consistent while shipping half-metre stumps.
{
  console.log('\nand it comes out the size it was asked for')

  const field = {
    heightAt: () => 40,
    heightAndSlopeAt: () => ({ h: 40, tan: 0 }),
    snowLineAt: () => 900,
    bands: { altLo: 0, altSpan: 100 },
  }
  const dw = new Deadwood(new THREE.Scene(), field, MOCK_WATER, MOCK_LAYERS, MOCK_TEX,
    EMPTY_FOREST, { seed: 11 })
  dw.place(0, 0)

  const m = new THREE.Matrix4()
  const outside = []
  let snags = 0
  let logs = 0
  let snagLo = Infinity
  let snagHi = 0
  for (const tile of dw.tiles.values()) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const vi = dw.variantAt[id]
      dw.batch.getMatrixAt(id, m)
      const scale = Math.hypot(m.elements[0], m.elements[1], m.elements[2])
      const log = dw.isLog[vi] === 1
      // The dimension each kind is BANDED by: a standing thing is judged by how
      // tall it is and a fallen one by how long. Both come off the built mesh.
      const size = (log ? dw.vLong[vi] : dw.vHeight[vi]) * scale
      const band = log ? LOG_LENGTH : SNAG_HEIGHT
      if (log) logs++
      else {
        snags++
        snagLo = Math.min(snagLo, size)
        snagHi = Math.max(snagHi, size)
      }
      // A hair of tolerance at each end for the float32 round trip through the
      // instance matrix, and nothing more -- a piece outside the band by a
      // centimetre is a rounding artefact, one outside it by half a metre is the
      // bug back again.
      if (size < band[0] - 0.01 || size > band[1] + 0.01) {
        outside.push(`${dw.bank.variants[vi].name} at ${size.toFixed(2)} m, band ${band[0]}-${band[1]}`)
      }
    }
  }

  check(snags > 0 && logs > 0, 'placed both kinds to measure',
    `${snags} standing, ${logs} fallen`)
  check(outside.length === 0, 'every piece lands inside its own kind\'s metre band',
    outside.length === 0 ? `snags ${SNAG_HEIGHT.join('-')} m by height, logs ${LOG_LENGTH.join('-')} m by length`
      : `${outside.length} outside: ${outside.slice(0, 3).join('; ')}`)
  // The half-metre stump, named. This is the check that would have caught it.
  check(snagLo >= SNAG_HEIGHT[0] - 0.01, 'and no stump is a doorstop',
    `shortest standing piece ${snagLo.toFixed(2)} m against a floor of ${SNAG_HEIGHT[0]} m`)
  // ...and that the band is a RANGE and not a constant. A scale that collapsed
  // to one value would satisfy every check above.
  check(snagHi - snagLo > (SNAG_HEIGHT[1] - SNAG_HEIGHT[0]) * 0.4,
    'and the size actually varies rather than sitting at one value',
    `standing pieces span ${snagLo.toFixed(2)}-${snagHi.toFixed(2)} m`)
  dw.dispose()
}

// ---------------------------------------------------------------------------
// DRIFTWOOD. Submerged ground used to be an unconditional rejection and is now a
// rate that only LOGS may draw against, which is three separate claims:
//
//   A LAKE BED GETS LOGS, and about half of what the dry rule would have put
//   there. Measured against a control with the same seed and no water at all, so
//   the denominator is the number of sites the rest of placement actually
//   offered rather than one this gate worked out for itself.
//
//   IT GETS NO STUMPS. The asymmetry is the design and it is easy to lose in a
//   refactor -- a stump standing on a lake bed is the failure mode.
//
//   A RIVER BED COUNTS AS A LAKE BED. The river-path clearance is what used to
//   keep dead wood out of a watercourse, so a log admitted to the water has to
//   be exempt from it or the riverbed stays swept clean while the lake fills up.
//   Dry ground keeps the clearance, and that is checked in the same run.
// ---------------------------------------------------------------------------
{
  console.log('\nand the drowned ground gets driftwood, not stumps')

  const field = {
    heightAt: () => 40,
    heightAndSlopeAt: () => ({ h: 40, tan: 0 }),
    snowLineAt: () => 900,
    bands: { altLo: 0, altSpan: 100 },
  }
  // A 60 m disc of lake on the origin, and a 12 m river ribbon lying straight
  // across it down the x axis. Every other placement test passes on this ground,
  // which is the point: the only thing that can reject a piece here is water.
  const LAKE = 60
  const RIBBON = 6
  const inLake = (x, z) => Math.hypot(x, z) < LAKE
  const inRibbon = (z) => Math.abs(z) < RIBBON
  const LAKE_WATER = { isSubmerged: (x, z) => inLake(x, z) }
  const RIVER_LAYERS = {
    ...MOCK_LAYERS,
    paths: { nearest: (x, z, kind) => (kind === 'river' ? { dist: Math.abs(z), halfWidth: RIBBON } : null) },
  }

  const run = (water, layers) => {
    const d = new Deadwood(new THREE.Scene(), field, water, layers, MOCK_TEX, EMPTY_FOREST, { seed: 21 })
    d.place(0, 0)
    return d
  }
  const tally = (d) => {
    const t = { wetLogs: 0, wetSnags: 0, dryLogs: 0, ribbonLogs: 0, dryRibbonLogs: 0 }
    for (const tile of d.tiles.values()) {
      for (let k = 0; k < tile.n; k++) {
        const id = tile.ids[k]
        const log = d.isLog[d.variantAt[id]] === 1
        const x = d.instX[id]
        const z = d.instZ[id]
        if (inLake(x, z)) {
          if (log) t.wetLogs++
          else t.wetSnags++
          if (log && inRibbon(z)) t.ribbonLogs++
        } else {
          if (log) t.dryLogs++
          if (log && inRibbon(z)) t.dryRibbonLogs++
        }
      }
    }
    return t
  }

  const dry = run(MOCK_WATER, MOCK_LAYERS)
  const wet = run(LAKE_WATER, MOCK_LAYERS)
  const dryT = tally(dry)
  const wetT = tally(wet)

  check(dryT.wetLogs > 20, 'the lake bed holds enough sites to measure',
    `${dryT.wetLogs} logs land inside the ${LAKE} m disc with the water taken away`)
  check(wetT.wetLogs > 0, 'a lake bed gets driftwood',
    `${wetT.wetLogs} logs lying under water`)
  check(wetT.wetSnags === 0, 'and not one stump stands in it',
    wetT.wetSnags === 0 ? 'no standing piece is submerged' : `${wetT.wetSnags} snags underwater`)
  const share = wetT.wetLogs / dryT.wetLogs
  check(share > 0.35 && share < 0.65, 'and it keeps about half of what the dry rule would have put there',
    `${(share * 100).toFixed(0)}% of ${dryT.wetLogs}, against the half PLACEMENT.submerged asks for`)
  // EXACTLY equal, not approximately: the roll that admits a drowned log is drawn
  // last in the candidate's stream precisely so that adding it moved nothing on
  // dry land. A difference of one here means the stream shifted.
  check(wetT.dryLogs === dryT.dryLogs, 'and dry ground is placed exactly as it was',
    `${wetT.dryLogs} logs outside the lake either way`)

  const riverDry = run(MOCK_WATER, RIVER_LAYERS)
  const riverWet = run(LAKE_WATER, RIVER_LAYERS)
  const rdT = tally(riverDry)
  const rwT = tally(riverWet)

  check(rdT.ribbonLogs === 0 && rdT.dryRibbonLogs === 0,
    'the river clearance keeps dead wood out of a watercourse on dry ground',
    `${rdT.ribbonLogs + rdT.dryRibbonLogs} logs inside the ${RIBBON} m ribbon with no water under it`)
  check(rwT.ribbonLogs > 0, 'and a river BED is water, so a log may lie in it',
    `${rwT.ribbonLogs} logs in the drowned stretch of the ribbon`)
  check(rwT.dryRibbonLogs === 0, 'while the dry stretch of the same river stays clear',
    `${rwT.dryRibbonLogs} logs in the ribbon beyond the lake`)

  for (const d of [dry, wet, riverDry, riverWet]) d.dispose()
}

// --- `jag` means the same thing on every seed --------------------------------
//
// The old rim was `min(MAX_JAG, jag * lattice^3)`, which made the slider a
// CEILING: the lattice is redrawn per seed, so one stump's peaks saturated the
// clamp into a shattered top and the next stump's never got near it and came out
// a smooth cone. Nothing threw. The only symptom was that asking for "quite
// broken" got you broken on some seeds and conical on others.
//
// The second version fixed that and overshot: a cosine comb of evenly spaced,
// near-equally deep teeth is consistent and reads as a machined crown. So the
// claims below are a PAIR, and each is only meaningful with the other beside it --
// how much rim is eaten has to be steady, and how it is arranged has to not be.
//
// All of it is measured off `deadwoodRim`, which is `endT` itself rather than the
// rim recovered from a mesh: a stub tip and the bored funnel put vertices at
// heights that have nothing to do with where the wood ends.
{
  console.log('\nand a broken top is as broken as it was asked to be')

  const ANGLES = 720
  const SEEDS = 200
  const stumpP = { ...deadwoodParams('stump-2m-oak', 1), tier: 0 }
  const depthOf = (rim) => rim.reduce((a, t) => a + (1 - t), 0) / rim.length
  const rims = []
  for (let seed = 1; seed <= SEEDS; seed++) rims.push(deadwoodRim({ ...stumpP, seed }, 1, ANGLES))

  // 1. THE DEEPEST NOTCH IS EXACTLY WHAT THE SLIDER ASKED FOR, on every seed. This
  //    is the promise that replaces the old ceiling: the notch depths are a fixed
  //    ladder that always has a top rung, so `jag1` names a depth that is actually
  //    cut rather than one the seed might not reach.
  const want = MAX_JAG * Math.min(1, stumpP.jag1 / JAG_FULL)
  const deep = rims.map((rim) => Math.max(...rim.map((t) => 1 - t)))
  check(Math.min(...deep) > want - 0.002 && Math.max(...deep) < want + 0.002,
    'the deepest notch is exactly the bite jag1 names, on every seed',
    `${SEEDS} seeds all cut ${(Math.min(...deep) * 100).toFixed(1)}-${(Math.max(...deep) * 100).toFixed(1)}% of the length, against ${(want * 100).toFixed(1)}% asked for`)

  // 2. AND HOW MUCH RIM GOES ALTOGETHER stays in a band. Not near-exact, and it
  //    should not be: the splinters are unevenly spaced and unevenly broad, so
  //    which rung lands on a wide tooth moves the total. A quarter is the width of
  //    that in practice, and it is the price of not looking cut.
  const lo = Math.min(...rims.map(depthOf))
  const hi = Math.max(...rims.map(depthOf))
  const mean = rims.reduce((a, r) => a + depthOf(r), 0) / rims.length
  check(hi - lo < mean * 0.35,
    'and the rim as a whole is eaten about equally hard on every seed',
    `${SEEDS} seeds bite ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}% of the length, mean ${(mean * 100).toFixed(1)}%, spread ${((hi - lo) / mean * 100).toFixed(0)}% of it`)

  // 3. AND IT SCALES. Half the slider is half the rim, which is what makes the
  //    number on the bench mean anything. Exact, because both readings share a
  //    seed and so share the whole comb -- only `bite` differs.
  const full = depthOf(deadwoodRim({ ...stumpP, jag1: JAG_FULL }, 1, ANGLES))
  const half = depthOf(deadwoodRim({ ...stumpP, jag1: JAG_FULL / 2 }, 1, ANGLES))
  check(Math.abs(half / full - 0.5) < 0.01 && full < MAX_JAG,
    'and half the slider takes half the rim',
    `${(full * 100).toFixed(1)}% at ${JAG_FULL}, ${(half * 100).toFixed(1)}% at ${JAG_FULL / 2}, under the ${(MAX_JAG * 100).toFixed(0)}% ceiling`)

  // 4. NOT A CROWN OF EVEN SPIKES, which is the whole reason for the ladder and
  //    the uneven cells. The readable test is how often a splinter is broad enough
  //    to hold TWO neighbouring vertices up at the rim: never, and every stump has
  //    a single vertex on each spike and reads as machined; always, and the notches
  //    stop registering. About half is what was asked for, and it is a property of
  //    JAG_SLAB_HI against the tier's side count, so it belongs in a gate.
  //
  //    "Up" is within a tenth of the deepest bite the slider allows -- a fixed
  //    depth rather than a per-seed one, so a savage seed cannot move the bar.
  const sides = DEADWOOD_TIERS[0].sides
  const runs = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rim = deadwoodRim({ ...stumpP, seed }, 1, sides)
    const up = rim.map((t) => (1 - t) < want * 0.1)
    // Circular, so start the walk at a vertex that is already down -- otherwise a
    // run wrapping the seam gets counted as two short ones.
    const start = up.indexOf(false)
    if (start < 0) { runs.push(sides); continue }
    let run = 0
    let worst = 0
    for (let k = 0; k < sides; k++) {
      run = up[(start + k) % sides] ? run + 1 : 0
      if (run > worst) worst = run
    }
    runs.push(worst)
  }
  const paired = runs.filter((r) => r >= 2).length / SEEDS
  check(paired > 0.35 && paired < 0.65,
    'and about half of stumps keep two adjacent vertices up at the rim',
    `${(paired * 100).toFixed(0)}% of ${SEEDS} seeds, over ${sides} sides`)
  // ...and no more than two, which was the standing rule before "about half" was
  // added to it. Three in a row is a fifth of the ring holding station, which is
  // the conical top the whole rewrite exists to prevent.
  const worstRun = Math.max(...runs)
  check(worstRun <= 2,
    'and no more than two, ever',
    `longest run ${worstRun} of ${sides} sides over ${SEEDS} seeds`)
}

// --- a stump meets the ground as a crown of roots ---------------------------
//
// `roots` breaks the flare collar into N buttresses that alternate OUT at each
// fin and IN at each gap. It is an angular modulation of the radius field and
// costs no triangles, so the only thing that can go wrong with it is silent: get
// the period wrong against the tier's side count and the ring ALIASES, which
// does not throw, does not change the triangle count, and shows up as a base
// that wanders lopsidedly round the trunk instead of a crown.
//
// So this measures the alternation itself: build each stump twice, once with the
// crown off, pair the two vertex for vertex -- same seed, same topology, same
// order -- and read the signed radius difference round the base.
//
// ON A STRAIGHT SPINE, which is the one liberty this block takes. `bend` and
// `kink` slide each ring's CENTRE sideways, so a vertex's angle about the origin
// is not its angle about its own ring and the bins collide. The crown is an
// angular claim and a straight spine is the frame the claim is stated in.
{
  console.log('\nand a stump meets the ground as a crown of roots')

  const sides = DEADWOOD_TIERS[0].sides
  const STRAIGHT = { tier: 0, bend: 0, kink: 0 }
  const stumps = VARIANTS.filter((n) => DEADWOOD_VARIANTS[n].p.kind !== 'log')
  const bad = []
  let reach = 0
  let pinch = 0
  for (const name of stumps) {
    const p = { ...deadwoodParams(name, 7), ...STRAIGHT }
    const plain = buildDeadwood({ ...p, roots: 0 }).getAttribute('position')
    const crown = buildDeadwood(p).getAttribute('position')
    if (plain.count !== crown.count) { bad.push(`${name}: the crown changed the vertex count`); continue }

    const bins = new Array(sides).fill(0)
    for (let i = 0; i < plain.count; i++) {
      const d = Math.hypot(crown.getX(i), crown.getZ(i)) - Math.hypot(plain.getX(i), plain.getZ(i))
      if (Math.abs(d) < 1e-5) continue
      const ang = (Math.atan2(plain.getZ(i), plain.getX(i)) + Math.PI * 2) % (Math.PI * 2)
      const k = Math.round((ang / (Math.PI * 2)) * sides) % sides
      if (Math.abs(d) > Math.abs(bins[k])) bins[k] = d
      reach = Math.max(reach, d)
      pinch = Math.min(pinch, d)
    }

    // Every side has to have moved -- a zero bin is an aliased ring, which is the
    // exact failure this block is here for.
    const dead = bins.filter((d) => d === 0).length
    if (dead > 0) { bad.push(`${name}: ${dead} of ${sides} sides did not move at all`); continue }
    // ...and the sign has to flip TWICE PER ROOT, once on the way out of each fin
    // and once on the way back in. That is what "alternates in and out" means, and
    // it is the number that goes wrong under aliasing: sample five roots on a side
    // count they do not divide and the fins land at a different phase in every
    // lobe, so some lobes lose one of their two crossings entirely.
    //
    // Not `flips === sides`, which was the same claim back when there were exactly
    // two samples per root. Fifteen sides over five roots gives three, so a lobe
    // reads (out, in, in) and one of its three steps is flat.
    const wanted = 2 * Math.round(DEADWOOD_DEFAULTS.roots)
    let flips = 0
    for (let k = 0; k < sides; k++) if (Math.sign(bins[k]) !== Math.sign(bins[(k + 1) % sides])) flips++
    if (flips !== wanted) bad.push(`${name}: ${flips} sign changes round the base, wanted ${wanted}`)
  }

  check(stumps.length > 0, 'found stumps to measure', `${stumps.length} standing variants`)
  check(bad.length === 0, 'the base alternates out and in, once per root, on every stump',
    bad.length === 0 ? `${sides} sides, ${DEADWOOD_DEFAULTS.roots} roots, ${2 * DEADWOOD_DEFAULTS.roots} sign changes round the base`
      : bad.slice(0, 3).join('; '))
  // And it is a real displacement rather than a millimetre nobody would see.
  check(reach > 0.05 && pinch < -0.005,
    'and the fins reach out while the gaps pinch in',
    `out ${(reach * 100).toFixed(1)} cm, in ${(pinch * 100).toFixed(1)} cm, on stumps built at 1.5-2 m`)

  // A LOG HAS NO CROWN. Buttresses are what a trunk does where it dives into
  // soil; a piece broken out of the middle of one never had them, and a ring of
  // fins on the end of something lying on its side reads as a cog.
  const logs = VARIANTS.filter((n) => DEADWOOD_VARIANTS[n].p.kind === 'log')
  let moved = 0
  for (const name of logs) {
    const p = { ...deadwoodParams(name, 7), tier: 0 }
    const a = buildDeadwood({ ...p, roots: 0 }).getAttribute('position').array
    const b = buildDeadwood(p).getAttribute('position').array
    for (let i = 0; i < a.length; i++) moved = Math.max(moved, Math.abs(a[i] - b[i]))
  }
  check(logs.length > 0 && moved === 0, 'and a fallen log grows none',
    `${logs.length} log variants, all identical with the crown forced off`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all deadwood checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
