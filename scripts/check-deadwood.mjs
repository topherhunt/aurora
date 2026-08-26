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
//   Measured on `log-long`, dropping to one ring took its plan width from 1.03 m
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
} from '../src/props/deadwood.js'
import { LAYER, LAYER_COUNT, MOSS_LAYERS, SNOW_WOOD_LAYERS } from '../src/textures.js'

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

  const sm = DEADWOOD_TIERS.map((t) => t.stubMul)
  check(sm[0] === 1.0 && sm.slice(1).every((m) => m === 0),
    'stubs are an LOD0 luxury and are dropped whole below it', sm.join(', '))
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
  const a = deadwoodCost(deadwoodParams('log-long', 1), 0)
  const b = deadwoodCost(deadwoodParams('log-long', 999), 0)
  check(a.triangles === b.triangles, 'and the cost does not depend on the seed', `${a.triangles} == ${b.triangles}`)
  void worst
}

// --- the §5 budget -----------------------------------------------------------

{
  console.log('\nDESIGN.md §5: dead wood files under bush, at 84 / 56 / 28')

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
  //   jagged break ring (`snag-spike`, jagCount 7) samples fewer teeth on 3 sides
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
  const shrunk = []
  let tightLong = Infinity, tightLongAt = ''
  let tightCross = Infinity, tightCrossAt = ''
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
        if (ratio < floor) shrunk.push(`${name} T${tier} ${axis} ${(ratio * 100).toFixed(0)}% (${isLong ? 'spine' : 'cross'})`)
        if (ratio > 1.02) shrunk.push(`${name} T${tier} ${axis} ${(ratio * 100).toFixed(0)}% -- coarse tier is BIGGER`)
      }
    }
  }
  const pct = (x) => `${(x * 100).toFixed(0)}%`
  check(shrunk.length === 0, 'the spine keeps its reach and the cross-section keeps its wander',
    shrunk.length === 0
      ? `spine >= ${pct(LONG_FLOOR)}, tightest ${pct(tightLong)} at ${tightLongAt}; cross >= ${pct(CROSS_FLOOR)}, tightest ${pct(tightCross)} at ${tightCrossAt}`
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
  const p = deadwoodParams('log-mossy', 42)
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

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all deadwood checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
