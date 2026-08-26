// Node-side gate for src/v2/terrain/skyline.js -- the third LOD target, for terrain that draws a silhouette edge (design/18-v2-world.md). Three-free, so it runs headless.
//
//   node scripts/check-v2-skyline.mjs
//
// scripts/check-v2.mjs owns the combined run and imports run() from here.
//
// THIS ONE USES THE REAL HEIGHTMAP, and that is the difference from check-v2-quadtree.mjs, which deliberately does not. The quadtree gate can use an analytic stand-in because the split rule reads nothing about the ground -- the field could be a photograph of the Alps or a plane and the descent would be the same shape. This rule is the opposite: it exists ENTIRELY to answer "is there a mountain here and can she see the edge of it", so a stand-in made of three sines would be measuring whether a sine has a skyline. Every number below is therefore a number about public/world/height.png, and it moves when that image is sculpted. That is a feature -- the cost of this policy IS a property of the terrain -- but it means a failure here can mean "the world changed" rather than "the code broke, and the ladder printed alongside each assertion is what tells the two apart.
//
// The sweep construction (6 fixed + N random positions, x4 headings, half airborne) is deliberately identical to check-v2-quadtree.mjs so the two cost tables can be read against each other directly.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readPng } from '../src/v2/height/png.js'
import { Heightmap, gridStep } from '../src/v2/height/heightmap.js'
import { MaxPyramid, HorizonTable, SKYLINE, BINS, BUCKETS, FAR } from '../src/v2/terrain/skyline.js'
import { LOD, MIN_TRI_DEG, selectNodes, nodeKey, unpackKey, inCone, EYE_HALF_ANGLE } from '../src/v2/terrain/quadtree-v2.js'
import { WORLD_SIZE, WORLD_HALF, CHUNK_INDICES, MAX_DEPTH, SLOT_COUNT, PINNED_CHUNKS } from '../src/v2/config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TRIS_PER_CHUNK = CHUNK_INDICES / 3
// Terrain's share of the frame. DESIGN.md §0 splits the 350k budget three ways and this is the third the ground gets; every percentage below is against it.
const TERRAIN_TRIS = 117000

const pct = (a, p) => {
  const s = Float64Array.from(a).sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

export async function run() {
  let failures = 0
  const check = (cond, label, detail = '') => {
    if (cond) console.log(`   ok   ${label}${detail ? `   ${detail}` : ''}`)
    else {
      failures++
      console.log(`   FAIL ${label}${detail ? `   ${detail}` : ''}`)
    }
  }

  console.log('\n--- skyline: the profile LOD target ---')

  const meta = JSON.parse(readFileSync(join(ROOT, 'public/world/height.json'), 'utf8'))
  const hm = Heightmap.fromDecoded(await readPng(join(ROOT, 'public/world/height.png')), meta)
  const N = hm.width
  const raw = { width: N, height: N, data: hm.field }
  const pyr = new MaxPyramid(raw)
  const groundAt = (x, z) => hm.sample(Math.max(-WORLD_HALF, Math.min(WORLD_HALF, x)), Math.max(-WORLD_HALF, Math.min(WORLD_HALF, z)))

  console.log(`\nthe pyramid over ${N}x${N} at ${pyr.step.toFixed(4)} m/texel, ${pyr.levels.length} levels`)
  {
    // The registration has to be heightmap.js's, exactly. skyline.js re-derives WORLD_SIZE/(width-1) rather than importing Heightmap, to keep png.js out of the selection path, and a re-derivation that drifts would put every silhouette test half a texel from the ground it is describing -- a bias too small to see and exactly big enough to make a ridge classify as its own occluder.
    check(pyr.step === gridStep(N), 'pyramid registration is heightmap.js gridStep', `${pyr.step} vs ${gridStep(N)}`)

    // CONSERVATIVE UPWARD is the whole contract: maxIn may over-report, never under-report. Under-reporting a node's top drops a silhouette on the floor, which is the artifact this module exists to remove, and it would do it silently.
    let under = 0
    let overBy = []
    let rs = 4242
    const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let t = 0; t < 3000; t++) {
      const i0 = Math.floor(rnd() * (N - 2))
      const j0 = Math.floor(rnd() * (N - 2))
      const w = 1 + Math.floor(rnd() * 60)
      const i1 = Math.min(N - 1, i0 + w)
      const j1 = Math.min(N - 1, j0 + w)
      let truth = -Infinity
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) truth = Math.max(truth, hm.field[j * N + i])
      const got = pyr.maxIn(-WORLD_HALF + i0 * pyr.step, -WORLD_HALF + j0 * pyr.step, -WORLD_HALF + i1 * pyr.step, -WORLD_HALF + j1 * pyr.step)
      if (got < truth - 1e-3) under++
      overBy.push(got - truth)
    }
    check(under === 0, 'maxIn never under-reports the true max over its box', `${under}/3000 boxes short`)
    console.log(`        over-report on arbitrary boxes at the default 4 cells: p50 ${pct(overBy, 0.5).toFixed(1)} m  p90 ${pct(overBy, 0.9).toFixed(1)} m  max ${Math.max(...overBy).toFixed(1)} m`)

    // THE SLACK THAT MATTERS is not the one above. A mip query reads whole cells, so it reaches past the box it was asked about, and that reach is ground OUTSIDE a node reported as the node's own top -- one peak's height smeared onto its neighbours, which widens the privileged band into the field the rule exists not to be. But the query whose slack becomes that smear is a specific one: gain()'s, over a NODE FOOTPRINT, at 8 cells. Random boxes at the default measure the march's query instead, where slack only nudges a horizon angle. So the assertion is about the classification path and the boxes here are real quadtree footprints, depths 4 to 10.
    const nodeOver = []
    const nodeOver4 = []
    for (let t = 0; t < 4000; t++) {
      const depth = 4 + Math.floor(rnd() * 7)
      const size = WORLD_SIZE / (1 << depth)
      const x = -WORLD_HALF + Math.floor(rnd() * (1 << depth)) * size
      const z = -WORLD_HALF + Math.floor(rnd() * (1 << depth)) * size
      const i0 = Math.max(0, Math.floor((x + WORLD_HALF) / pyr.step))
      const j0 = Math.max(0, Math.floor((z + WORLD_HALF) / pyr.step))
      const i1 = Math.min(N - 1, Math.ceil((x + size + WORLD_HALF) / pyr.step))
      const j1 = Math.min(N - 1, Math.ceil((z + size + WORLD_HALF) / pyr.step))
      let truth = -Infinity
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) truth = Math.max(truth, hm.field[j * N + i])
      nodeOver.push(pyr.maxIn(x, z, x + size, z + size, 8) - truth)
      nodeOver4.push(pyr.maxIn(x, z, x + size, z + size) - truth)
    }
    console.log(`        over-report on node footprints: at 8 cells p50 ${pct(nodeOver, 0.5).toFixed(1)} m  p90 ${pct(nodeOver, 0.9).toFixed(1)} m  p99 ${pct(nodeOver, 0.99).toFixed(1)} m   (at the default 4: p90 ${pct(nodeOver4, 0.9).toFixed(1)} m)`)
    // 20 m against relief of ~900 m, i.e. the smear is inside the margin the ramp already tolerates. Measured 11.5 m at p90; the headroom is for sculpting, and a failure here means either the level maths regressed or the map grew relief that much sharper.
    check(pct(nodeOver, 0.9) < 20, 'a node footprint over-reports its own top by under 20 m at p90', `${pct(nodeOver, 0.9).toFixed(1)} m`)
    // Precision has to BUY something, or the extra reads are just reads. Same boxes, both settings, so this is the trade itself and not two populations compared by accident.
    check(pct(nodeOver, 0.9) < pct(nodeOver4, 0.9) * 0.6, 'paying for 8 cells buys most of that slack back', `${pct(nodeOver, 0.9).toFixed(1)} m vs ${pct(nodeOver4, 0.9).toFixed(1)} m at the default`)

    // A single-texel box must be that texel exactly: level 0 aliases the source and the degenerate query is the one every node-footprint lookup degrades to at depth 13.
    let exact = true
    for (let t = 0; t < 200 && exact; t++) {
      const i = Math.floor(rnd() * N)
      const j = Math.floor(rnd() * N)
      const x = -WORLD_HALF + i * pyr.step
      const z = -WORLD_HALF + j * pyr.step
      if (Math.abs(pyr.maxIn(x, z, x, z) - hm.field[j * N + i]) > 1e-3) exact = false
    }
    check(exact, 'a zero-width box reads the texel it lands on, exactly')
  }

  // --- the sweep --------------------------------------------------------------
  const NPOS = 30
  let rs = 777
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const spots = [[0, 0], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5], [-0.5, -0.5], [0.9, 0.0]]
  for (let i = 0; i < NPOS; i++) spots.push([(rnd() * 2 - 1) * 0.9, (rnd() * 2 - 1) * 0.9])
  const CAMS = []
  for (let i = 0; i < spots.length; i++) {
    const x = spots[i][0] * WORLD_HALF
    const z = spots[i][1] * WORLD_HALF
    // Half the sweep airborne, because the rule's expensive case is the one where she can see a hundred ridges at once and every one of them is a relative skyline.
    const agl = i % 2 === 0 ? 1.65 : 150 + (i % 7) * 64
    for (let q = 0; q < 4; q++) CAMS.push({ x, y: groundAt(x, z) + agl, z, yaw: (q * Math.PI) / 2 })
  }

  // Per-node bounds the way check-v2-quadtree.mjs fakes them, so `range` is the 3D one selection actually uses rather than degrading to horizontal and over-refining everything.
  const boundsCache = new Map()
  const info = {
    get(key) {
      let b = boundsCache.get(key)
      if (b !== undefined) return b
      const { depth, ix, iz } = unpackKey(key)
      const size = WORLD_SIZE / (1 << depth)
      const x = -WORLD_HALF + ix * size
      const z = -WORLD_HALF + iz * size
      let lo = Infinity
      let hi = -Infinity
      for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
        const h = groundAt(x + (i / 4) * size, z + (j / 4) * size)
        if (h < lo) lo = h
        if (h > hi) hi = h
      }
      b = { minY: lo, maxY: hi }
      boundsCache.set(key, b)
      return b
    },
  }

  const saved = { ...SKYLINE }
  const restore = () => Object.assign(SKYLINE, saved)
  const hzFor = (cam) => {
    const t = new HorizonTable(pyr)
    t.build(cam, 0)
    return t
  }
  // One table per camera POSITION, reused across the four headings -- the table is a function of the eye point alone, which is the property that makes rebuilding it at 12 Hz affordable at all.
  const tables = new Map()
  const tableFor = (cam) => {
    const k = `${cam.x}|${cam.y}|${cam.z}`
    let t = tables.get(k)
    if (!t) {
      t = hzFor(cam)
      tables.set(k, t)
    }
    return t
  }

  console.log('\noff is off')
  {
    // Two ways of being off, and they are different failures. Passing no table is the path every caller written before this module took, and it must not have changed. A table that classifies NOTHING -- minRange past the world diagonal, so rangeGain is 0 everywhere -- proves the plumbing itself adds nothing: if these differed, the profile term would be leaking into the split test through some path other than its own gain.
    let diffNull = 0
    let diffDead = 0
    for (const cam of CAMS.slice(0, 40)) {
      const plain = selectNodes(cam, { info }).map((n) => n.key).sort((a, b) => a - b)
      const withNull = selectNodes(cam, { info, skyline: null }).map((n) => n.key).sort((a, b) => a - b)
      if (plain.length !== withNull.length || plain.some((k, i) => k !== withNull[i])) diffNull++
      SKYLINE.minRange = FAR * 2
      const dead = selectNodes(cam, { info, skyline: tableFor(cam) }).map((n) => n.key).sort((a, b) => a - b)
      restore()
      if (plain.length !== dead.length || plain.some((k, i) => k !== dead[i])) diffDead++
    }
    check(diffNull === 0, 'skyline: null selects exactly what the two-target rule selects', `${diffNull}/40 cameras differ`)
    check(diffDead === 0, 'a table whose gain is 0 everywhere changes nothing', `${diffDead}/40 cameras differ`)
  }

  console.log('\nit only ever REFINES -- the invariant v1\'s elevation bias broke')
  {
    // v1's elevation bias was removed because it was a HIERARCHICAL GATE: a quadrant below its pivot never descended, so summits inside it stayed pinned at 64 m cells while the bias was nominally sharpening summits. src/terrain/quadtree.js:53. This asserts that cannot happen here, structurally rather than by inspection: every leaf the plain rule chose must still be a leaf or an ANCESTOR of leaves under the profile rule, i.e. the profile selection is a strict refinement of the plain one. Any coarsening anywhere is a fail, not a warning.
    let coarsened = 0
    let refinedNodes = 0
    let totalPlain = 0
    for (const cam of CAMS) {
      const plain = new Set(selectNodes(cam, { info }).map((n) => n.key))
      const sky = selectNodes(cam, { info, skyline: tableFor(cam) })
      totalPlain += plain.size
      const covered = new Set()
      for (const n of sky) {
        // Walk up from each profile leaf until a plain leaf is found. If none is, the profile rule put a leaf somewhere no plain leaf covers, which can only mean it went COARSER on that branch.
        let d = n.depth
        let ix = n.ix
        let iz = n.iz
        let hit = null
        for (;;) {
          const k = nodeKey(d, ix, iz)
          if (plain.has(k)) { hit = k; break }
          if (d === 0) break
          d--
          ix >>= 1
          iz >>= 1
        }
        if (hit === null) coarsened++
        else {
          covered.add(hit)
          if (n.key !== hit) refinedNodes++
        }
      }
    }
    check(coarsened === 0, 'no profile leaf is coarser than the plain leaf covering it', `${coarsened} coarsened`)
    console.log(`        ${refinedNodes} leaves across the sweep sit below a plain leaf, out of ${totalPlain} plain leaves -- the privilege, counted`)
    check(refinedNodes > 0, 'the term actually fires on the real heightmap', `${refinedNodes} refined`)
  }

  console.log('\nit privileges HIGH ground, which is the claim the whole module rests on')
  {
    // A detector that fired uniformly would be an expensive no-op wearing a silhouette's name. This is the test that its output correlates with what it says it finds. Compare the elevation of ground under privileged leaves against ground under everything selected, at matched range -- unmatched, high ground is nearer to an airborne eye and the comparison would be measuring altitude rather than silhouette.
    let privH = []
    let allH = []
    for (const cam of CAMS) {
      const t = tableFor(cam)
      for (const n of selectNodes(cam, { info, skyline: t })) {
        const r = Math.max(Math.hypot(Math.max(n.x - cam.x, 0, cam.x - (n.x + n.size)), Math.max(n.z - cam.z, 0, cam.z - (n.z + n.size))), n.size * 0.5)
        if (r < SKYLINE.minRange) continue
        const top = pyr.maxIn(n.x, n.z, n.x + n.size, n.z + n.size)
        allH.push(top)
        if (t.gain(cam, n.x, n.z, n.size, r) > 0.5) privH.push(top)
      }
    }
    const mp = privH.reduce((a, b) => a + b, 0) / Math.max(privH.length, 1)
    const ma = allH.reduce((a, b) => a + b, 0) / Math.max(allH.length, 1)
    console.log(`        privileged ground averages ${mp.toFixed(0)} m against ${ma.toFixed(0)} m for everything past minRange   (${privH.length} of ${allH.length} leaves)`)
    check(privH.length > 0, 'something past minRange is classified as profile')
    check(mp > ma, 'privileged ground is higher than the average of what it is drawn from', `${mp.toFixed(0)} m vs ${ma.toFixed(0)} m`)
    // A selective detector, not a blanket one. If most of the far field is "profile" the rule has degenerated into triDeg = profileDeg with extra arithmetic, which is exactly what happens without minRange -- see SKYLINE.minRange.
    const share = privH.length / Math.max(allH.length, 1)
    check(share < 0.5, 'fewer than half the far leaves are profile -- it is a line, not a field', `${(share * 100).toFixed(0)}%`)
  }

  console.log('\ngrading, not switching -- how much the selection churns as she walks')
  {
    // The reason SKYLINE.marginDeg is a RAMP and not a threshold. A binary classifier puts its discontinuity on the silhouette, which is the one place in the frame guaranteed to be looked at, and the symptom is a ridge that pops as she walks.
    //
    // MEASURED AGAINST THE PLAIN RULE, not on its own, and the first version of this check did it on its own and was worthless. Total selection churn over an 8 m step is ~35% at p50 with the profile term, ~35% without it, and ~35% with a hard switch: ordinary LOD churn swamps this term completely, so a comparison of totals passes no matter what the ramp does. What is actually asked here is the EXTRA nodes that turn over because of the profile term -- symmetric difference with the term minus symmetric difference without it, at the same two eye points -- which isolates it from the noise it was hiding in.
    const hardFor = (cam) => {
      // The version this module deliberately did not ship: the same detector with a zero-width band.
      const t = hzFor(cam)
      const g = t.gain.bind(t)
      t.gain = (c, x, z, s, r) => (g(c, x, z, s, r) > 0 ? 1 : 0)
      return t
    }
    const keys = (cam, sky) => new Set(selectNodes(cam, { info, skyline: sky }).map((n) => n.key))
    const sym = (a, b) => {
      let d = 0
      for (const k of a) if (!b.has(k)) d++
      for (const k of b) if (!a.has(k)) d++
      return d
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)
    let gradedMean = 0
    let hardMean = 0
    for (const step of [2, 8]) {
      const graded = []
      const hard = []
      for (let i = 0; i < 40; i++) {
        const b = CAMS[(i * 3) % CAMS.length]
        const c0 = { x: b.x, y: b.y, z: b.z, yaw: b.yaw }
        const c1 = { x: b.x + step, y: b.y, z: b.z, yaw: b.yaw }
        const plain = sym(keys(c0, null), keys(c1, null))
        graded.push(sym(keys(c0, hzFor(c0)), keys(c1, hzFor(c1))) - plain)
        hard.push(sym(keys(c0, hardFor(c0)), keys(c1, hardFor(c1))) - plain)
      }
      console.log(`        ${step} m step, EXTRA nodes turning over because of the profile term, out of a ~190 node selection:`)
      console.log(`            graded band  mean ${mean(graded).toFixed(1)}  p90 ${pct(graded, 0.9)}  max ${Math.max(...graded)}`)
      console.log(`            hard switch  mean ${mean(hard).toFixed(1)}  p90 ${pct(hard, 0.9)}  max ${Math.max(...hard)}`)
      if (step === 8) {
        gradedMean = mean(graded)
        hardMean = mean(hard)
      }
    }
    // Measured 1.6 against 3.0 at an 8 m step, i.e. the ramp roughly halves it. 0.75 is where the assertion sits so that a partial regression -- a band that narrows, a gain that saturates early -- still trips it while ordinary sculpting of the map does not.
    check(gradedMean < hardMean * 0.75, 'the ramp turns over meaningfully fewer nodes per step than the threshold it replaced', `${gradedMean.toFixed(1)} vs ${hardMean.toFixed(1)} per 8 m step`)
  }

  console.log('\nthe cost, worst case over the sweep, at ' + TRIS_PER_CHUNK + ' tris/chunk against terrain\'s ' + (TERRAIN_TRIS / 1000) + 'k share')
  console.log('        rule                                   sel  +21   fits?   drawn    tris    % share')
  const ladder = []
  const measure = (label, triDeg, opts) => {
    Object.assign(SKYLINE, saved, opts)
    let worst = 0
    let worstDrawn = 0
    const times = []
    for (const cam of CAMS) {
      const t = opts.on === false ? null : tableFor(cam)
      const t0 = performance.now()
      const sel = selectNodes(cam, { info, triDeg, skyline: t })
      times.push(performance.now() - t0)
      let drawn = 0
      for (const n of sel) if (inCone(cam, n.x, n.z, n.size, EYE_HALF_ANGLE)) drawn++
      if (sel.length > worst) worst = sel.length
      if (drawn > worstDrawn) worstDrawn = drawn
    }
    restore()
    const tris = worstDrawn * TRIS_PER_CHUNK
    const row = { label, worst, worstDrawn, tris, times }
    ladder.push(row)
    console.log(
      '        ' + label.padEnd(38) + String(worst).padStart(5) + String(worst + PINNED_CHUNKS).padStart(5) +
      (worst + PINNED_CHUNKS <= SLOT_COUNT ? '   yes ' : '    NO ') +
      String(worstDrawn).padStart(7) + (Math.round(tris / 1000) + 'k').padStart(8) +
      (Math.round((tris / TERRAIN_TRIS) * 100) + '%').padStart(10)
    )
    return row
  }

  const base = measure(`triDeg ${LOD.triDeg}, no profile`, LOD.triDeg, { on: false })
  const shipped = measure(`triDeg ${LOD.triDeg} + profile (shipped)`, LOD.triDeg, {})
  measure(`triDeg ${LOD.triDeg} + profile, ungated`, LOD.triDeg, { minRange: 0 })
  measure(`triDeg ${LOD.triDeg} + profile, sky only`, LOD.triDeg, { backdropX: Infinity })
  const flat = measure(`triDeg ${MIN_TRI_DEG} everywhere`, MIN_TRI_DEG, { on: false })
  const coarse = measure('triDeg 5.72, no profile', 5.72, { on: false })
  const coarsePlus = measure('triDeg 5.72 + profile (the XR pair)', 5.72, {})

  // The three claims the ladder is here to support, asserted rather than left to be read off.
  check(shipped.worst + PINNED_CHUNKS <= SLOT_COUNT, 'the shipped pair fits the slot pool', `${shipped.worst + PINNED_CHUNKS} of ${SLOT_COUNT}`)
  check(shipped.tris < flat.tris * 0.6, 'it costs well under half of refining everything to profileDeg', `${Math.round(shipped.tris / 1000)}k vs ${Math.round(flat.tris / 1000)}k`)
  // The point of the whole module, and the row worth reading twice: a COARSER default paired with a fine profile draws fewer triangles than today's flat default while putting detail where it shows. If this ever stops holding, the pairing in SKYLINE.profileDeg's comment is wrong and should be rewritten rather than the assertion relaxed.
  check(coarsePlus.tris < base.tris, 'triDeg 5.72 + profile draws fewer triangles than a flat ' + LOD.triDeg, `${Math.round(coarsePlus.tris / 1000)}k vs ${Math.round(base.tris / 1000)}k`)
  console.log(`        the coarse pair holds ${Math.round((coarsePlus.tris / coarse.tris - 1) * 100)}% more than 5.72 alone and ${Math.round((1 - coarsePlus.tris / base.tris) * 100)}% less than a flat ${LOD.triDeg}`)

  console.log('\ntime')
  {
    // Selection runs at 12 Hz (terrain-v2.js SELECT_EVERY_FRAMES), so the ceiling is the same 1 ms check-v2-quadtree.mjs holds the plain selector to. The profile term adds a gain call per in-cone node and a Math.tan on the ones that fire, and the table rebuild is a separate, larger cost paid only when the eye moves.
    const CEIL_MS = 1.0
    const t = shipped.times
    const b = base.times
    console.log(`        selection, no profile: p50 ${pct(b, 0.5).toFixed(3)}ms  p99 ${pct(b, 0.99).toFixed(3)}ms`)
    console.log(`        selection, profile:    p50 ${pct(t, 0.5).toFixed(3)}ms  p99 ${pct(t, 0.99).toFixed(3)}ms  max ${Math.max(...t).toFixed(3)}ms`)
    check(pct(t, 0.99) < CEIL_MS, `p99 selection with the profile term is under ${CEIL_MS}ms`, `${pct(t, 0.99).toFixed(3)}ms`)

    const builds = []
    for (const cam of CAMS.slice(0, 24)) {
      const tbl = new HorizonTable(pyr)
      tbl.build(cam, 0)
      builds.push(tbl.lastMs)
    }
    console.log(`        horizon rebuild (${BINS} bins x ${BUCKETS} buckets): p50 ${pct(builds, 0.5).toFixed(3)}ms  p99 ${pct(builds, 0.99).toFixed(3)}ms  max ${Math.max(...builds).toFixed(3)}ms`)
    // Rebuilt at most once per selection and only when the eye has moved 4 m, so the budget is a whole selection tick rather than a frame. 2 ms of an 83 ms tick is 2.4%.
    check(pct(builds, 0.99) < 4.0, 'a horizon rebuild is under 4ms at p99', `${pct(builds, 0.99).toFixed(3)}ms`)

    // Standing still must be free. The table caches on eye position, and if that cache ever stops working the cost above moves from once-per-4-metres to once-per-83-milliseconds without anything failing.
    const tbl = new HorizonTable(pyr)
    tbl.build(CAMS[0], 4)
    const first = tbl.builds
    tbl.build({ ...CAMS[0], yaw: 2 }, 4)
    tbl.build({ x: CAMS[0].x + 1, y: CAMS[0].y, z: CAMS[0].z, yaw: 0 }, 4)
    check(tbl.builds === first, 'turning on the spot and stepping 1 m reuse the table', `${tbl.builds - first} needless rebuilds`)
    tbl.build({ x: CAMS[0].x + 50, y: CAMS[0].y, z: CAMS[0].z, yaw: 0 }, 4)
    check(tbl.builds === first + 1, 'stepping 50 m rebuilds it', `${tbl.builds - first} rebuilds`)
  }

  restore()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-skyline: ${failures} check(s) failed`)
  return failures
}

// Self-run when invoked directly; scripts/check-v2.mjs imports run() instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
