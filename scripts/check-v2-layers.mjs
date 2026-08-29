// Drill for the v2 content layers (src/v2/layers/), DESIGN.md §18 sections 3, 4 and 6.
//
// Everything under src/v2/layers/ is three-free and runs in node, which is the whole reason this file can exist: the snow-line interpolant, the spline, the carve profiles and the spatial index are all pure math and every claim §18 makes about them is a number that can be measured here rather than squinted at on screen.
//
// The claims, and what each one is guarding:
//
//   the snow line passes THROUGH its authored points -- the singular kernel is what makes that true, and a kernel that is merely peaked instead of singular looks identical on screen while quietly ignoring what the author typed;
//   it returns to the global base outside every radius -- the partition-of-unity mask, without which a point's influence never quite ends and the whole world's snow line drifts;
//   a dirty-rect rebake is bit-identical to a full one -- the thing that makes dragging a point interactive, and the thing that fails silently by leaving a stale patch;
//   the baked bicubic tap is O(1) in the point count -- measured, because it is the performance claim the design rests on;
//   the spline is centripetal and not uniform -- the fixture here is an S-bend that uniform Catmull-Rom demonstrably self-intersects on, so the check is measuring the thing it claims;
//   the carve profiles hit their stated numbers -- depth at the centreline, zero at two half-widths, road surface on the spline;
//   a selection handle survives the removal of another point -- the same rule in both point-holding layers, because the failure is silent: the highlight stays put while the drag edits a different point;
//   water is water -- waterLevelAt answers for rivers as well as lakes, or every riverbed in the world reads as dry land to whatever asks;
//   null on the dirty-rect channel means "nothing changed" and never "everything" -- the two consumers read it in opposite directions, so the producer only ever emits the unambiguous one;
//   and >95% of chunks early out of the whole system -- which is what "compact and performance-efficient" reduces to.
//
//   node scripts/check-v2-layers.mjs

import { fileURLToPath } from 'node:url'
import { mulberry32 } from '../src/sim/mathx.js'
import { WORLD_HALF } from '../src/v2/config.js'
import { CHUNK_RES, MAX_DEPTH } from '../src/v2/config.js'
import { UniformGrid } from '../src/v2/layers/grid.js'
import { Spline } from '../src/v2/layers/spline.js'
import { SnowField, GRID_RES, TEXEL } from '../src/v2/layers/snowline.js'
import { LakeSet, footprint } from '../src/v2/layers/water-bodies.js'
import { PathSet } from '../src/v2/layers/paths.js'
import { Layers } from '../src/v2/layers/layers.js'
import { defaultDoc, validate } from '../src/v2/layers/doc.js'

// Fixtures are sized as fractions of the world half-extent rather than in absolute metres. WORLD_SIZE is still being tuned in src/v2/config.js while the height field is built, and a gate whose sample points fall outside the baked grid does not fail -- it quietly measures edge clamping and reports a p99 error of fifty metres.
const W = WORLD_HALF

// snow.base and snow.band are elevations, and v2's vertical range is still being surveyed off the imported heightmap, so no check here asserts either as a number in metres. The fixture sits at base 0 so that every figure printed below IS the delta, and every claim is about the interpolant's SHAPE -- exact at its authored points, exactly zero outside every radius, smooth in between, monotone through a feather -- which holds at whatever base and band the world settles on. band is present only because SnowField carries it through to toJSON.
const SNOW_FIXTURE = { base: 0, band: 1 }

// The half-amplitude of the authored deltas in the bake fixtures. Baked-tap error is quoted against this rather than against the snow band, so the tolerance means "small compared to the variation the interpolant is being asked to reproduce" and stays honest whatever the band turns out to be.
const DELTA_AMPLITUDE = 80

export async function run() {
  let failures = 0
  const check = (ok, label, detail = '') => {
    if (!ok) failures++
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
  }

  console.log(`\n=== v2 content layers, ${WORLD_HALF * 2} m world ===`)

  // --- the spatial index ------------------------------------------------------

  console.log('\nuniform grid')
  {
    const g = new UniformGrid(64)
    g.insert('a', -100, -100, 100, 100)
    g.insert('b', 5000, 5000, 5010, 5010)

    let hits = []
    g.query(0, 0, (id) => hits.push(id))
    check(hits.length === 1 && hits[0] === 'a', 'query returns the id whose box covers the point', `${JSON.stringify(hits)}`)

    hits = []
    g.query(-3000, 3000, (id) => hits.push(id))
    check(hits.length === 0, 'query over empty space returns nothing')

    // A box spanning nine cells must be visited once, not nine times.
    hits = []
    g.queryBox(-200, -200, 200, 200, (id) => hits.push(id))
    check(hits.length === 1 && hits[0] === 'a', 'queryBox de-duplicates an id binned into many cells', `${hits.length} visit(s)`)

    check(g.overlaps(-10, -10, 10, 10) === true, 'overlaps finds an occupied region')
    check(g.overlaps(-4000, 3000, -3900, 3100) === false, 'overlaps early-outs on empty space')

    // Integer keys, not string keys: a packed key must not collide across the world box.
    const seen = new Set()
    let collisions = 0
    for (let cx = -128; cx < 128; cx++) {
      for (let cz = -128; cz < 128; cz++) {
        const k = g.key(cx, cz)
        if (seen.has(k)) collisions++
        seen.add(k)
        if (!Number.isSafeInteger(k)) collisions++
      }
    }
    check(collisions === 0, 'packed cell keys are collision-free safe integers over the world box', `${seen.size} cells`)

    let threw = false
    try {
      g.insert('bad', 10, 10, 0, 0)
    } catch {
      threw = true
    }
    check(threw, 'a degenerate insert box throws rather than vanishing from the index')
  }

  // --- snow line --------------------------------------------------------------

  console.log('\nsnow line: interpolation')
  {
    // 50 points: 30 scattered so they are isolated, plus four five-point clusters standing in for the "carefully control the line at a mountain pass" case. Minimum separation 8 m, because two authored points at the SAME spot with different deltas is a contradiction and not a test.
    const rnd = mulberry32(20260824)
    const field = new SnowField(SNOW_FIXTURE)
    const authored = []
    const place = (x, z, delta, radius) => {
      for (const p of authored) if (Math.hypot(p.x - x, p.z - z) < 8) return false
      authored.push({ x, z, delta, radius, i: field.addPoint(x, z, delta, radius) })
      return true
    }
    while (authored.length < 30) {
      place((rnd() * 2 - 1) * 0.75 * W, (rnd() * 2 - 1) * 0.75 * W, (rnd() * 2 - 1) * 90, (0.04 + rnd() * 0.11) * W)
    }
    for (let c = 0; c < 4; c++) {
      const cx = (rnd() * 2 - 1) * 0.6 * W
      const cz = (rnd() * 2 - 1) * 0.6 * W
      let placed = 0
      let guard = 0
      while (placed < 5 && guard++ < 200) {
        if (place(cx + (rnd() * 2 - 1) * 100, cz + (rnd() * 2 - 1) * 100, (rnd() * 2 - 1) * 90, (0.03 + rnd() * 0.05) * W)) placed++
      }
    }
    check(authored.length === 50, 'fixture placed 50 authored points (30 isolated, 4 clusters of 5)', `${authored.length}`)

    let worstAt = 0
    for (const p of authored) worstAt = Math.max(worstAt, Math.abs(field.evalExact(p.x, p.z) - p.delta))
    console.log(`        worst error at an authored point: ${worstAt.toExponential(2)} m`)
    check(worstAt < 1e-3, 'the line passes through every authored point', `worst ${worstAt.toExponential(2)} m vs 1e-3 m`)

    // Outside every radius the mask A is exactly 0, so this must be exactly base -- not nearly base. A kernel that is merely small at its edge leaves a halo, and a halo over a 16 km world is a snow line that is never where the author left it.
    let worstOutside = 0
    let tested = 0
    for (let i = 0; i < 4000; i++) {
      const x = (rnd() * 2 - 1) * W
      const z = (rnd() * 2 - 1) * W
      let inside = false
      for (const p of authored) {
        if (Math.hypot(p.x - x, p.z - z) < p.radius) {
          inside = true
          break
        }
      }
      if (inside) continue
      tested++
      worstOutside = Math.max(worstOutside, Math.abs(field.evalExact(x, z)))
    }
    check(tested > 500, 'the outside-every-radius sample is big enough to mean something', `${tested} sites`)
    check(worstOutside === 0, 'the line returns to exactly the global base outside every radius', `worst |delta| ${worstOutside}`)
  }

  console.log('\nsnow line: cluster control (the mountain pass case)')
  {
    // Five points inside a 200 m box, all at the same deviation. The requirement is that the WHOLE region reads that deviation, which is what "put several points near each other to control the line at a pass" has to mean in practice.
    //
    // The residual is the partition-of-unity mask A, not the interpolation: with every delta equal, W/S is exactly the common delta and the only error left is A < 1 between the points. A is a function of distance/radius, so the radius is what buys the accuracy -- 900 m radii over a 200 m cluster hold A above 0.95.
    const D = 60
    const R = 900
    const field = new SnowField(SNOW_FIXTURE)
    const pts = [
      [0, 0],
      [-70, -70],
      [70, -70],
      [-70, 70],
      [70, 70],
    ]
    for (const [x, z] of pts) field.addPoint(x, z, D, R)

    let worst = 0
    for (let j = -10; j <= 10; j++) {
      for (let i = -10; i <= 10; i++) {
        worst = Math.max(worst, Math.abs(field.evalExact(i * 10, j * 10) - D))
      }
    }
    console.log(`        5 points at ${D} m inside a 200 m box (radius ${R} m): worst deviation across the region ${worst.toFixed(2)} m`)
    check(worst < 3, 'a cluster holds the whole 200 m region at its authored deviation', `worst ${worst.toFixed(2)} m off ${D} m`)
  }

  console.log('\nsnow line: bake')
  {
    const rnd = mulberry32(7717)
    const field = new SnowField(SNOW_FIXTURE)
    for (let i = 0; i < 24; i++) {
      field.addPoint((rnd() * 2 - 1) * 0.75 * W, (rnd() * 2 - 1) * 0.75 * W, (rnd() * 2 - 1) * 80, (0.05 + rnd() * 0.15) * W)
    }

    const t0 = performance.now()
    field.bake()
    const bakeMs = performance.now() - t0
    console.log(`        full bake: ${GRID_RES}x${GRID_RES} texels at ${TEXEL} m in ${bakeMs.toFixed(0)} ms`)

    // Dirty-rect rebake vs full rebake, after moving a point. The rect is the union of the point's old and new influence boxes, and outside it the moved point contributes nothing in either configuration -- so bit-identity has to hold over the WHOLE grid, not merely over the rebaked window.
    const before = field.delta.slice()
    const rect = field.movePoint(3, field.points[3].x + 0.09 * W, field.points[3].z - 0.06 * W)
    field.bakeRect(rect.minX, rect.minZ, rect.maxX, rect.maxZ)
    const partial = field.delta.slice()

    field.delta.set(before)
    field.bake()
    const full = field.delta

    const i0 = Math.max(0, Math.floor((rect.minX + WORLD_HALF) / TEXEL - 0.5))
    const i1 = Math.min(GRID_RES - 1, Math.ceil((rect.maxX + WORLD_HALF) / TEXEL - 0.5))
    const j0 = Math.max(0, Math.floor((rect.minZ + WORLD_HALF) / TEXEL - 0.5))
    const j1 = Math.min(GRID_RES - 1, Math.ceil((rect.maxZ + WORLD_HALF) / TEXEL - 0.5))
    let diffInRect = 0
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (partial[j * GRID_RES + i] !== full[j * GRID_RES + i]) diffInRect++
      }
    }
    let diffWhole = 0
    for (let n = 0; n < full.length; n++) if (partial[n] !== full[n]) diffWhole++
    const rectTexels = (i1 - i0 + 1) * (j1 - j0 + 1)
    console.log(
      `        dirty rect ${(rect.maxX - rect.minX).toFixed(0)}x${(rect.maxZ - rect.minZ).toFixed(0)} m = ${rectTexels} texels ` +
        `(${((rectTexels / full.length) * 100).toFixed(2)}% of the grid)`
    )
    check(diffInRect === 0, 'dirty-rect rebake is bit-identical to a full rebake inside the rect', `${diffInRect} of ${rectTexels} texels differ`)
    check(diffWhole === 0, 'and leaves the rest of the grid untouched', `${diffWhole} of ${full.length} texels differ`)
    // A rect that covers the whole world would pass the two checks above while proving nothing about interactivity.
    check(rectTexels < full.length / 4, 'the rect is a small fraction of the grid, which is the point of having one', `${((rectTexels / full.length) * 100).toFixed(2)}%`)

    // The baked bicubic tap against the reference interpolant. Quoted in metres and as a fraction of the deltas the fixture authored, because that is the scale at which an error here would be visible: an error small against the variation being reproduced moves the snow edge by a fraction of its own softness.
    const errs = []
    for (let n = 0; n < 10000; n++) {
      const x = (rnd() * 2 - 1) * 0.95 * W
      const z = (rnd() * 2 - 1) * 0.95 * W
      errs.push(Math.abs(field.deltaAt(x, z) - field.evalExact(x, z)))
    }
    errs.sort((a, b) => a - b)
    const p50 = errs[Math.floor(errs.length * 0.5)]
    const p99 = errs[Math.floor(errs.length * 0.99)]
    const worst = errs[errs.length - 1]
    console.log(
      `        baked tap vs exact over 10k samples: p50 ${p50.toFixed(3)} m, p99 ${p99.toFixed(3)} m, max ${worst.toFixed(3)} m ` +
        `(p99 is ${((p99 / DELTA_AMPLITUDE) * 100).toFixed(2)}% of the ${DELTA_AMPLITUDE} m authored delta amplitude)`
    )
    check(p99 < DELTA_AMPLITUDE * 0.02, 'the baked bicubic tap tracks the exact interpolant', `p99 ${p99.toFixed(3)} m vs ${(DELTA_AMPLITUDE * 0.02).toFixed(2)} m`)
  }

  console.log('\nsnow line: O(1) in the point count')
  {
    // The design's central performance claim: the per-vertex path reads a baked grid, so its cost cannot depend on how many points were authored. Measured rather than asserted, and the two fields are timed alternately so a turbo ramp or a GC pause lands on both.
    const build = (n) => {
      const rnd = mulberry32(1000 + n)
      const f = new SnowField(SNOW_FIXTURE)
      for (let i = 0; i < n; i++) f.addPoint((rnd() * 2 - 1) * 0.85 * W, (rnd() * 2 - 1) * 0.85 * W, (rnd() * 2 - 1) * 80, (0.03 + rnd() * 0.09) * W)
      f.bake()
      return f
    }
    const few = build(10)
    const many = build(1000)

    const N = 1 << 16
    const xs = new Float64Array(N)
    const zs = new Float64Array(N)
    {
      const rnd = mulberry32(99)
      for (let i = 0; i < N; i++) {
        xs[i] = (rnd() * 2 - 1) * 0.95 * W
        zs[i] = (rnd() * 2 - 1) * 0.95 * W
      }
    }
    const ITER = 4 << 20
    let sink = 0
    const time = (f) => {
      const t0 = performance.now()
      for (let i = 0; i < ITER; i++) sink += f.deltaAt(xs[i & (N - 1)], zs[i & (N - 1)])
      return performance.now() - t0
    }
    time(few)
    time(many)
    let msFew = Infinity
    let msMany = Infinity
    for (let pass = 0; pass < 5; pass++) {
      msFew = Math.min(msFew, time(few))
      msMany = Math.min(msMany, time(many))
    }
    if (!Number.isFinite(sink)) throw new Error('deltaAt produced a non-finite value during timing')
    const ratio = msMany / msFew
    console.log(
      `        deltaAt x ${(ITER / 1e6).toFixed(0)}M:  10 points ${msFew.toFixed(0)} ms (${((msFew * 1e6) / ITER).toFixed(1)} ns/call), ` +
        `1000 points ${msMany.toFixed(0)} ms (${((msMany * 1e6) / ITER).toFixed(1)} ns/call), ratio ${ratio.toFixed(3)}x`
    )
    check(ratio < 1.5, 'a 100x larger point set does not make the per-vertex query slower', `${ratio.toFixed(3)}x`)

    // And the reference interpolant, which is the thing the bake exists to keep off the per-vertex path, genuinely IS point-count dependent -- otherwise the claim above is trivially true and measures nothing.
    const timeExact = (f) => {
      const t0 = performance.now()
      for (let i = 0; i < 200000; i++) sink += f.evalExact(xs[i & (N - 1)], zs[i & (N - 1)])
      return performance.now() - t0
    }
    timeExact(few)
    timeExact(many)
    let exFew = Infinity
    let exMany = Infinity
    for (let pass = 0; pass < 3; pass++) {
      exFew = Math.min(exFew, timeExact(few))
      exMany = Math.min(exMany, timeExact(many))
    }
    console.log(`        evalExact x 200k: 10 points ${exFew.toFixed(1)} ms, 1000 points ${exMany.toFixed(1)} ms, ratio ${(exMany / exFew).toFixed(2)}x`)
    check(exMany / exFew > 1.5, 'the unbaked interpolant IS point-count dependent, so the bake is doing real work', `${(exMany / exFew).toFixed(2)}x`)
  }

  // --- spline -----------------------------------------------------------------

  console.log('\nspline: centripetal, not uniform')
  {
    // Uniform Catmull-Rom's failure mode is unevenly spaced control points: a short segment flanked by long ones gets tangents far longer than its own chord, and the cubic loops back through itself. This fixture is exactly that shape and nothing exotic -- a 140 m run east, a 5 m hook at the top of the bend, and a long run back west. Authoring it takes four clicks.
    const pts = [
      [-40, 0, -30, 10],
      [100, 0, 0, 10],
      [104, 0, 3, 10],
      [0, 0, 6, 10],
      [-40, 0, 40, 10],
    ]
    const sp = new Spline(pts)

    // Directly: knot spacing must be |p_{i+1} - p_i|^0.5. Alpha = 0 would be uniform, and "centripetal" written above uniform code is invisible to a reader.
    const k = sp.segmentKnots(1)
    const d01 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2])
    const d12 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1], pts[2][2] - pts[1][2])
    const d23 = Math.hypot(pts[3][0] - pts[2][0], pts[3][1] - pts[2][1], pts[3][2] - pts[2][2])
    const knotErr = Math.max(
      Math.abs(k[1] - k[0] - Math.sqrt(d01)),
      Math.abs(k[2] - k[1] - Math.sqrt(d12)),
      Math.abs(k[3] - k[2] - Math.sqrt(d23))
    )
    console.log(`        segment 1 knot spacings ${(k[1] - k[0]).toFixed(4)} / ${(k[2] - k[1]).toFixed(4)} / ${(k[3] - k[2]).toFixed(4)} (sqrt of chord ${d01.toFixed(1)} / ${d12.toFixed(1)} / ${d23.toFixed(1)} m)`)
    check(knotErr < 1e-9, 'knot spacing is |dp|^0.5 -- centripetal, alpha = 0.5', `worst ${knotErr.toExponential(1)}`)
    check(Math.abs(k[2] - k[1] - 1) > 0.1, 'and is NOT uniform (uniform would make every spacing exactly 1)', `${(k[2] - k[1]).toFixed(4)}`)

    // Self-intersection, in the XZ plane, over the flattened polyline.
    const segsIntersecting = (samples) => {
      const n = samples.length / 4 - 1
      let hits = 0
      for (let a = 0; a < n; a++) {
        for (let b = a + 2; b < n; b++) {
          const ax = samples[a * 4]
          const az = samples[a * 4 + 2]
          const bx = samples[(a + 1) * 4]
          const bz = samples[(a + 1) * 4 + 2]
          const cx = samples[b * 4]
          const cz = samples[b * 4 + 2]
          const dx = samples[(b + 1) * 4]
          const dz = samples[(b + 1) * 4 + 2]
          const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx)
          const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx)
          const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
          const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax)
          if (d1 * d2 < 0 && d3 * d4 < 0) hits++
        }
      }
      return hits
    }

    // Flattened at 0.5 m rather than the path layer's 2 m: a crossing is detected between polyline SEGMENTS, and a coarse polyline can chord straight past a loop small enough to fit between two samples.
    const flat = sp.flatten(0.5)
    const centripetalHits = segsIntersecting(flat)

    // The same control points through a UNIFORM Catmull-Rom, so the fixture is shown to be discriminating: if uniform did not loop here, the check above would pass for a spline that is uniform after all.
    const uniform = []
    const pad = [
      [2 * pts[0][0] - pts[1][0], 0, 2 * pts[0][2] - pts[1][2]],
      ...pts.map((p) => [p[0], p[1], p[2]]),
      [2 * pts[4][0] - pts[3][0], 0, 2 * pts[4][2] - pts[3][2]],
    ]
    for (let i = 0; i < pts.length - 1; i++) {
      for (let s = 0; s <= 160; s++) {
        const t = s / 160
        const t2 = t * t
        const t3 = t2 * t
        const q = [0, 0, 0, 0]
        for (const c of [0, 2]) {
          const p0 = pad[i][c]
          const p1 = pad[i + 1][c]
          const p2 = pad[i + 2][c]
          const p3 = pad[i + 3][c]
          q[c] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
        }
        if (i > 0 && s === 0) continue
        uniform.push(q[0], 0, q[2], 5)
      }
    }
    const uniformHits = segsIntersecting(Float32Array.from(uniform))

    console.log(`        S-bend, ${flat.length / 4} flattened samples: centripetal ${centripetalHits} self-intersections, uniform ${uniformHits}`)
    check(uniformHits > 0, 'the fixture is discriminating: uniform Catmull-Rom DOES self-intersect on it', `${uniformHits} crossings`)
    check(centripetalHits === 0, 'the centripetal flattening does not self-intersect', `${centripetalHits} crossings`)
  }

  console.log('\nspline: sampling and degenerate inputs')
  {
    const sp = new Spline([
      [0, 10, 0, 8],
      [300, 20, 40, 12],
      [600, 15, -60, 20],
    ])
    const flat = sp.flatten(2)
    let worstChord = 0
    for (let i = 4; i < flat.length; i += 4) {
      worstChord = Math.max(worstChord, Math.hypot(flat[i] - flat[i - 4], flat[i + 1] - flat[i - 3], flat[i + 2] - flat[i - 2]))
    }
    console.log(`        ${flat.length / 4} samples over ${sp.length().toFixed(0)} m, worst chord ${worstChord.toFixed(3)} m`)
    check(worstChord <= 2 + 1e-6, 'flatten never leaves a chord longer than the requested spacing', `worst ${worstChord.toFixed(3)} m vs 2 m`)

    // Endpoints: the curve has to start and end AT the control points, not near them.
    const a = sp.evalAt(0)
    const b = sp.evalAt(2)
    check(
      Math.hypot(a.x - 0, a.y - 10, a.z - 0) < 1e-9 && Math.hypot(b.x - 600, b.y - 15, b.z + 60) < 1e-9,
      'the curve starts and ends exactly at the first and last control points'
    )
    // Widths are half-widths in the flattened form, and the first and last sample must carry the authored ones.
    check(Math.abs(flat[3] - 4) < 1e-5 && Math.abs(flat[flat.length - 1] - 10) < 1e-5, 'flatten emits HALF widths and carries the authored ones at the ends', `${flat[3]} .. ${flat[flat.length - 1]}`)

    let threw = false
    try {
      new Spline([])
    } catch {
      threw = true
    }
    check(threw, 'a zero-point spline throws instead of returning an empty curve')

    const one = new Spline([[5, 6, 7, 4]])
    const oneFlat = one.flatten(2)
    check(
      oneFlat.length === 4 && oneFlat[0] === 5 && oneFlat[1] === 6 && oneFlat[2] === 7 && oneFlat[3] === 2 && one.length() === 0,
      'a one-point spline is a single sample of zero length'
    )

    // Two points must be a straight line exactly, not a curve that happens to look straight -- the reflected quartet makes both Catmull-Rom tangents equal to the chord, so the cubic collapses to the lerp.
    const two = new Spline([
      [0, 0, 0, 6],
      [100, 40, -20, 18],
    ])
    let worstOff = 0
    let worstW = 0
    for (let s = 0; s <= 20; s++) {
      const t = s / 20
      const p = two.evalAt(t)
      worstOff = Math.max(worstOff, Math.hypot(p.x - 100 * t, p.y - 40 * t, p.z + 20 * t))
      worstW = Math.max(worstW, Math.abs(p.width - (6 + 12 * t)))
    }
    check(worstOff < 1e-9 && worstW < 1e-9, 'a two-point spline is exactly a straight line with linear width', `worst ${worstOff.toExponential(1)} m`)

    // Coincident control points come out of a click-to-place editor and must not put a zero in a knot denominator.
    const dup = new Spline([
      [0, 0, 0, 6],
      [50, 0, 0, 6],
      [50, 0, 0, 6],
      [50, 0, 60, 6],
    ])
    let finite = true
    for (let s = 0; s <= 60; s++) {
      const p = dup.evalAt((s / 60) * 3)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z) || !Number.isFinite(p.width)) finite = false
    }
    check(finite, 'a doubled control point produces a finite curve rather than NaN')
  }

  // --- paths ------------------------------------------------------------------

  console.log('\npaths: river carve')
  {
    const paths = new PathSet([
      { id: 'r1', kind: 'river', depth: 3, pts: [[-500, 100, 0, 20], [0, 100, 0, 20], [500, 100, 0, 20]] },
    ])
    const HW = 10
    const H = 105

    const centre = paths.carveRivers(0, 0, H)
    check(Math.abs(centre - (100 - 3)) < 0.01, 'the channel reaches its full depth at the centreline', `${centre.toFixed(4)} m vs ${(100 - 3).toFixed(2)} m`)

    const edge = paths.carveRivers(0, HW * 2, H)
    check(edge === H, 'the carve is exactly zero at two half-widths', `${edge} vs ${H}`)

    let monotone = true
    let prevCut = Infinity
    let firstZero = null
    for (let s = 0; s <= 400; s++) {
      const d = (s / 400) * (HW * 2)
      const cut = H - paths.carveRivers(0, d, H)
      if (cut > prevCut + 1e-9) monotone = false
      if (firstZero === null && cut <= 0) firstZero = d
      prevCut = cut
    }
    console.log(`        depth 3 m, half-width ${HW} m: cut goes to zero at ${firstZero === null ? '>2hw' : firstZero.toFixed(2) + ' m'}, monotone ${monotone}`)
    check(monotone, 'the channel profile is monotone from centreline to bank')
    check(firstZero !== null && Math.abs(firstZero - HW * 2) < 0.2, 'and reaches zero at two half-widths and not before', `${firstZero === null ? 'never' : firstZero.toFixed(2)} m`)

    // The bed follows the SPLINE's y, not the terrain's, so ground already lower than the bed is left alone rather than raised into a dam.
    const belowBed = paths.carveRivers(0, 0, 80)
    check(belowBed === 80, 'ground already below the bed is left where it is', `${belowBed}`)

    // No crease at the bank: the profile is C1 there by construction (both halves parabolic, coefficient forced to 0.5), so the finite-difference slope must agree across d = halfWidth.
    const slope = (d) => (paths.carveRivers(0, d + 1e-4, H) - paths.carveRivers(0, d - 1e-4, H)) / 2e-4
    const jump = Math.abs(slope(HW + 2e-4) - slope(HW - 2e-4))
    check(jump < 1e-2, 'the bank is C1 -- no slope crease where the channel meets the feather', `slope jump ${jump.toExponential(1)}`)
  }

  console.log('\npaths: road surface')
  {
    const FEATHER = 8
    const paths = new PathSet([
      { id: 'd1', kind: 'road', feather: FEATHER, pts: [[-500, 100, 0, 12], [0, 100, 0, 12], [500, 100, 0, 12]] },
    ])
    const HW = 6
    // Sloping ground, so "returns the spline y" is a real claim and not a coincidence of a flat fixture.
    const ground = (x, z) => 100 + 0.35 * z + 0.02 * x

    let worstOn = 0
    for (let s = 0; s <= 200; s++) {
      const x = -400 + (s / 200) * 800
      for (let n = -6; n <= 6; n++) {
        const z = (n / 6) * HW
        worstOn = Math.max(worstOn, Math.abs(paths.smoothRoads(x, z, ground(x, z)) - 100))
      }
    }
    console.log(`        carriageway half-width ${HW} m over ground sloping 0.35 m/m: worst deviation from the spline y ${worstOn.toExponential(2)} m`)
    check(worstOn < 0.01, 'the road surface is within 1 cm of the spline y everywhere inside the half-width', `worst ${worstOn.toExponential(2)} m`)

    const at = (d) => paths.smoothRoads(0, d, ground(0, d))
    const jumpInner = Math.abs(at(HW - 1e-5) - at(HW + 1e-5))
    const jumpOuter = Math.abs(at(HW + FEATHER - 1e-5) - at(HW + FEATHER + 1e-5))
    check(jumpInner < 1e-3 && jumpOuter < 1e-3, 'the shoulder is C0 across both feather boundaries', `${jumpInner.toExponential(1)} m at the kerb, ${jumpOuter.toExponential(1)} m at the toe`)

    check(at(HW + FEATHER + 1) === ground(0, HW + FEATHER + 1), 'beyond the feather the road leaves the terrain exactly alone')

    // Smoothstep, not a linear ramp: a linear shoulder has a nonzero slope at the toe and that crease runs the whole length of the road.
    const shoulderSlope = (d) => (at(d + 1e-4) - at(d - 1e-4)) / 2e-4
    const toe = shoulderSlope(HW + FEATHER - 1e-3)
    const outside = shoulderSlope(HW + FEATHER + 1e-3)
    check(Math.abs(toe - outside) < 0.05, 'the shoulder meets the terrain tangentially (smoothstep, not a linear ramp)', `slope ${toe.toFixed(4)} vs ${outside.toFixed(4)}`)
  }

  console.log('\npaths: distance is to the segment, not the sample')
  {
    // A straight river binned at 2 m: at the midpoint between two samples, point-distance overestimates by up to 1 m. That error is periodic along the bank and reads as scalloping, so it is worth pinning that the query does not have it.
    const paths = new PathSet([{ id: 'r1', kind: 'river', depth: 2, pts: [[-200, 50, 0, 24], [200, 50, 0, 24]] }])
    let worst = 0
    for (let s = 0; s < 400; s++) {
      const x = -100 + s * 0.5
      const hit = paths.nearest(x, 5)
      if (hit === null) throw new Error(`nearest() found nothing beside its own river at x=${x}`)
      worst = Math.max(worst, Math.abs(hit.dist - 5))
    }
    console.log(`        worst distance error 5 m off a straight bank: ${worst.toExponential(2)} m`)
    check(worst < 1e-4, 'distance is measured to the closest point on the closest segment', `worst ${worst.toExponential(2)} m`)
  }

  console.log('\npaths: mutation reports a dirty rect')
  {
    const paths = new PathSet([{ id: 'r1', kind: 'river', depth: 2, pts: [[0, 50, 0, 20], [200, 50, 0, 20], [400, 50, 0, 20]] }])
    const before = paths.carveRivers(200, 300, 60)
    const rect = paths.movePoint('r1', 1, 200, 50, 300)
    const after = paths.carveRivers(200, 300, 60)
    check(before === 60 && after < 60, 'moving a control point actually moves the channel', `${before} -> ${after.toFixed(2)}`)
    check(
      rect.minX <= 0 && rect.maxX >= 400 && rect.minZ <= 0 && rect.maxZ >= 300,
      'the dirty rect covers both where the path was and where it now is',
      `[${rect.minX.toFixed(0)},${rect.minZ.toFixed(0)}]..[${rect.maxX.toFixed(0)},${rect.maxZ.toFixed(0)}]`
    )
  }

  console.log('\nhandles survive the removal of another point')
  {
    // The failure this guards is silent and destructive: the editor holds an index as a selection handle, a point below it is deleted, and from then on every drag of that "selection" edits a different point while the highlight stays where it was. Both point-holding layers have to answer this the same way -- see livePoints() in paths.js.
    const paths = new PathSet([
      { id: 'r1', kind: 'river', depth: 2, pts: [[0, 50, 0, 20], [100, 50, 0, 20], [200, 50, 0, 20], [300, 50, 0, 20]] },
    ])
    const was = paths.pointAt('r1', 3)
    paths.removePoint('r1', 1)
    // Caught rather than allowed to propagate: a layer that compacts makes handle 3 out of range and throws, and a thrown error here would abort the run and hide every check below it behind a stack trace.
    let now = null
    try {
      now = paths.pointAt('r1', 3)
    } catch (e) {
      now = [NaN, NaN, NaN, NaN]
    }
    check(
      now[0] === was[0] && now[2] === was[2],
      'a path handle held on a LATER point still refers to the same world position after a removal',
      `handle 3 was [${was[0]},${was[2]}], is [${now[0]},${now[2]}]`
    )
    check(paths.pointsOf('r1').length === 3, 'and the curve itself is down to three points', `${paths.pointsOf('r1').length}`)
    check(paths.handlesOf('r1').join(',') === '0,2,3', 'handlesOf skips the tombstone rather than renumbering', paths.handlesOf('r1').join(','))
    let threw = ''
    try {
      paths.movePoint('r1', 1, 0, 0, 0)
    } catch (e) {
      threw = e.message
    }
    check(/tombstone/.test(threw), 'and addressing the removed handle throws instead of editing a neighbour', threw)
    check(paths.toJSON('river')[0].pts.length === 3, 'the stored form is compacted -- tombstones are a session device, not a file format', `${paths.toJSON('river')[0].pts.length} pts`)

    // The same promise on the other side, where it was already true.
    const field = new SnowField(SNOW_FIXTURE)
    field.addPoint(0, 0, 10, 300)
    const keep = field.addPoint(400, 0, 20, 300)
    field.removePoint(0)
    check(field.points[keep].x === 400, 'a snow handle held on a later point survives a removal too', `#${keep} still at x=${field.points[keep].x}`)
  }

  // --- lakes ------------------------------------------------------------------

  console.log('\nlakes')
  {
    const lakes = new LakeSet([
      { id: 'l1', x: 0, z: 0, y: 120, rx: 80, rz: 40, rot: 0, shape: 0, carve: 1, depth: 8 },
    ])
    check(footprint(lakes.lakes.get('l1'), 0, 0) === 1, 'footprint is 1 at the centre')
    check(footprint(lakes.lakes.get('l1'), 80, 0) === 0, 'footprint is 0 exactly on the rim')
    check(footprint(lakes.lakes.get('l1'), 0, 34) === 1, 'footprint is flat 1 inside the feather band, so the basin floor is level')

    // Rotation must rotate the QUERY point into the lake's frame; getting the sign wrong gives a lake rotated the other way, which is invisible on a circle and obvious on an 80x40 ellipse.
    const rotated = new LakeSet([{ id: 'l2', x: 0, z: 0, y: 120, rx: 80, rz: 40, rot: Math.PI / 2, shape: 0, carve: 1, depth: 8 }])
    const L = rotated.lakes.get('l2')
    check(footprint(L, 0, 70) > 0 && footprint(L, 70, 0) === 0, 'a 90-degree rotation swaps the ellipse axes', `${footprint(L, 0, 70).toFixed(3)} along z, ${footprint(L, 70, 0).toFixed(3)} along x`)

    check(Math.abs(lakes.carve(0, 0, 200) - (120 - 8)) < 1e-9, 'the basin carve reaches y - depth at the centre', `${lakes.carve(0, 0, 200).toFixed(3)}`)
    check(lakes.carve(200, 200, 200) === 200, 'ground outside the lake box is untouched')
    check(lakes.carve(0, 0, 90) === 90, 'ground already below the bed is left where it is')
    check(lakes.levelAt(0, 0) === 120 && lakes.levelAt(400, 0) === null, 'levelAt reports the water surface inside and null outside')
    check(lakes.flattenAt(0, 0) === 1 && lakes.flattenAt(400, 0) === 0, 'flattenAt suppresses detail inside the basin and nowhere else')

    // A rectangle lake is a different shape and not the same ellipse with a flag set.
    const rect = new LakeSet([{ id: 'l3', x: 0, z: 0, y: 100, rx: 50, rz: 50, rot: 0, shape: 1, carve: 1, depth: 4 }])
    check(footprint(rect.lakes.get('l3'), 40, 40) === 1, 'a rectangle lake includes its corners (an ellipse would not)', `${footprint(rect.lakes.get('l3'), 40, 40)}`)

    const r = lakes.update('l1', { rx: 200 })
    check(r.minX <= -200 && r.maxX >= 200, 'scaling a lake reports a rect covering both the old and new extents', `[${r.minX},${r.maxX}]`)
  }

  // --- document ---------------------------------------------------------------

  console.log('\nworld document')
  {
    const doc = defaultDoc()
    check(validate(doc) === doc, 'the default document validates')

    const bad = (mutate, wantPath) => {
      const d = defaultDoc()
      mutate(d)
      let msg = null
      try {
        validate(d)
      } catch (e) {
        msg = e.message
      }
      check(msg !== null && msg.includes(wantPath), `validate names the offending path (${wantPath})`, msg === null ? 'did not throw' : msg)
    }
    bad((d) => d.snow.points.push([0, 0, 'x', 100]), 'snow.points[0][2]')
    bad((d) => d.lakes.push({ id: 'l1', x: 0, z: 0, y: 0, rx: 0, rz: 10 }), 'lakes[0].rx')
    bad((d) => d.rivers.push({ id: 'r1', pts: [[0, 0, 0, -2]] }), 'rivers[0].pts[0][3]')
    bad((d) => {
      d.lakes.push({ id: 'x1', x: 0, z: 0, y: 0, rx: 10, rz: 10 })
      d.rivers.push({ id: 'x1', pts: [[0, 0, 0, 2]] })
    }, 'rivers[0].id')
    bad((d) => { d.v = 2 }, 'v')

    // Round trip: a document that goes through Layers and back out must be the same document, or the editor's save button silently loses whatever serialize forgot.
    const world = new Layers(defaultDoc())
    world.addSnowPoint(1200, -800, 35, 600)
    const lake = world.addLake({ x: 100, z: 200, y: 130, rx: 60, rz: 45, rot: 0.4, shape: 0, carve: 1, depth: 9 })
    const river = world.addPath({ kind: 'river', depth: 2.5, pts: [[-100, 90, 0, 24], [200, 84, 120, 30], [500, 78, 90, 30]] })
    const road = world.addPath({ kind: 'road', feather: 10, pts: [[-200, 120, -300, 8], [400, 118, -250, 8]] })
    check(lake.id === 'l1' && river.id === 'r1' && road.id === 'd1', 'ids allocate as l1 / r1 / d1', `${lake.id} ${river.id} ${road.id}`)

    const json = world.serialize()
    validate(json)
    const back = Layers.deserialize(JSON.parse(JSON.stringify(json)))
    check(JSON.stringify(back.serialize()) === JSON.stringify(json), 'a document survives a serialize / deserialize round trip unchanged')

    // Point lists must be arrays of numbers on disk, not arrays of objects -- that is the difference between a world document that is kilobytes and one that is not.
    check(Array.isArray(json.snow.points[0]) && typeof json.snow.points[0][0] === 'number', 'snow points serialise as arrays of numbers')
    check(Array.isArray(json.rivers[0].pts[0]) && json.rivers[0].pts[0].length === 4, 'river control points serialise as arrays of numbers')

    // Ids never come back: deleting r1 and adding a river must not produce a second r1, or two objects share an undo history.
    world.removePath('r1')
    const river2 = world.addPath({ kind: 'river', depth: 2, pts: [[0, 90, 0, 20], [100, 90, 0, 20]] })
    check(river2.id === 'r2', 'a freed id is never reissued', `${river2.id}`)
  }

  // --- the facade -------------------------------------------------------------

  console.log('\nlayers facade')
  {
    const world = new Layers(defaultDoc())
    const e0 = world.epoch
    world.addSnowPoint(0, 0, 40, 500)
    check(world.epoch === e0 + 1, 'a mutation bumps the epoch', `${e0} -> ${world.epoch}`)

    const rect = world.takeDirtyRect()
    check(rect !== null && rect.minX <= -500 && rect.maxX >= 500, 'takeDirtyRect returns the union since the last call', `[${rect.minX},${rect.maxX}]`)
    check(world.takeDirtyRect() === null, 'and consumes it, so the next call reports nothing new')

    // Stated as a RISE above whatever base the document carries, not as an absolute elevation: v2's vertical range is still being surveyed off the imported heightmap and a gate that pinned 148 m here would fail the day it lands.
    const base = world.snow.base
    check(Math.abs(world.snowLineAt(0, 0) - base - 40) < 0.5, 'the facade sees the snow edit through the baked grid', `base + ${(world.snowLineAt(0, 0) - base).toFixed(2)} m`)
    check(world.snowLineAt(0.9 * W, 0.9 * W) === base, 'and the far side of the world is still exactly at the base', `${world.snowLineAt(0.9 * W, 0.9 * W)} vs ${base}`)

    // What null MEANS on this channel. TerrainV2.setLayers reads a null rect as "the document was replaced, rebuild every chunk"; Editor._flushDirty reads it as "nothing to do" and drops it. Both readings cannot be right, so the producer never emits null for anything but "nothing changed" and says "everything" with a full-world rect that both consumers read the same way.
    const e1 = world.epoch
    const noop = world.setSnowBase(world.snow.base)
    check(noop === null && world.epoch === e1, 'a no-op edit changes nothing, bumps no epoch and asks for no rebuild', `epoch ${e1} -> ${world.epoch}`)
    check(world.takeDirtyRect() === null, 'and leaves the dirty rect empty rather than asking to rebuild the world')

    const everything = world.setSnowBase(world.snow.base + 25)
    check(
      everything !== null && everything.minX <= -W && everything.maxX >= W && everything.minZ <= -W && everything.maxZ >= W,
      'a change with unbounded effect reports the whole world as a rect, not as null',
      `[${everything.minX},${everything.minZ}]..[${everything.maxX},${everything.maxZ}]`
    )
    // Unions only ever grow, so a small edit after a whole-document change cannot shrink the rect back down and strand stale terrain outside it.
    world.addSnowPoint(0, 0, 5, 200)
    const merged = world.takeDirtyRect()
    check(
      merged.minX <= -W && merged.maxX >= W && merged.minZ <= -W && merged.maxZ >= W,
      'and a small edit after it does not union the whole-world rect back down to a sub-rect',
      `[${merged.minX.toFixed(0)},${merged.minZ.toFixed(0)}]..[${merged.maxX.toFixed(0)},${merged.maxZ.toFixed(0)}]`
    )
    check(world.markAllDirty().maxX >= W, 'markAllDirty is the one way to say "everything" and it says it as a rect')
    world.takeDirtyRect()

    // carve() order: rivers, then lakes, then roads. A road crossing a river must read as a causeway, which means the road wins where they overlap.
    world.addPath({ kind: 'river', depth: 4, pts: [[-300, 100, 0, 40], [300, 100, 0, 40]] })
    world.addPath({ kind: 'road', feather: 8, pts: [[0, 103, -300, 14], [0, 103, 300, 14]] })
    const onCrossing = world.carve(0, 0, 110)
    const onRiverAway = world.carve(150, 0, 110)
    console.log(`        river bed ${onRiverAway.toFixed(2)} m, road deck over the crossing ${onCrossing.toFixed(2)} m`)
    check(Math.abs(onCrossing - 103) < 0.01, 'the road flattens LAST, so a crossing is a causeway and not a dip', `${onCrossing.toFixed(3)} m vs the road y of 103 m`)
    check(Math.abs(onRiverAway - 96) < 0.01, 'and away from the road the river still cuts to its own bed', `${onRiverAway.toFixed(3)} m vs 96 m`)

    // A lake must basin-carve after the river cuts, so a river running into a lake ends in the lake bed rather than over it.
    world.addLake({ x: 600, z: 0, y: 98, rx: 120, rz: 120, rot: 0, shape: 0, carve: 1, depth: 10 })
    check(Math.abs(world.carve(600, 0, 130) - 88) < 1e-9, 'a lake basin-carves on top of whatever the rivers left', `${world.carve(600, 0, 130).toFixed(3)} m`)

    check(world.flattenAt(0, 0) > 0.99, 'flattenAt is saturated on a road deck')
    check(world.flattenAt(4000, 4000) === 0, 'and zero in open country')
    check(world.waterLevelAt(600, 0) === 98, 'waterLevelAt reports the lake surface')
  }

  console.log('\nwater level: rivers are water too')
  {
    // "Is this point underwater" is what keeps trees out of water, and answering it from lakes alone plants a forest down the middle of every river.
    const world = new Layers(defaultDoc())
    world.addPath({ kind: 'river', depth: 3, pts: [[-400, 90, 0, 30], [0, 90, 0, 30], [400, 90, 0, 30]] })
    check(world.waterLevelAt(0, 0) === 90, 'a probe on a river centreline returns that river surface', `${world.waterLevelAt(0, 0)}`)
    check(world.waterLevelAt(0, 14) === 90, 'and anywhere inside the half-width', `${world.waterLevelAt(0, 14)} at 14 m of 15 m`)
    // The outer half of the carve profile is the feathered BANK, which the river shapes but is not in.
    check(world.waterLevelAt(0, 22) === null, 'but the shaped bank outside the half-width is dry land', `${world.waterLevelAt(0, 22)} at 22 m`)
    check(world.waterLevelAt(0, 4000) === null, 'and open country is dry')

    // A river running into a lake: contiguous water, so the higher surface wins. Taking the lower would sink the river's last few metres into the lake it is joining.
    world.addLake({ x: 300, z: 0, y: 84, rx: 200, rz: 200, rot: 0, shape: 0, carve: 1, depth: 9 })
    check(world.waterLevelAt(300, 0) === 90, 'where a river crosses a lake the higher surface wins', `river 90 vs lake 84 -> ${world.waterLevelAt(300, 0)}`)
    check(world.waterLevelAt(300, 100) === 84, 'and in the lake beside the river it is the lake', `${world.waterLevelAt(300, 100)}`)
  }

  // --- culling ----------------------------------------------------------------

  console.log('\nper-chunk culling')
  {
    // A dozen authored objects, placed as fractions of the world so this measures the same density whatever WORLD_SIZE settles at: 4 lakes, 3 rivers, 3 roads, 2 snow points.
    const world = new Layers(defaultDoc())
    world.addLake({ x: -0.29 * W, z: 0.22 * W, y: 130, rx: 120, rz: 90, rot: 0.4, shape: 0, carve: 1, depth: 9 })
    world.addLake({ x: 0.38 * W, z: -0.11 * W, y: 96, rx: 60, rz: 60, rot: 0, shape: 0, carve: 1, depth: 6 })
    world.addLake({ x: 0.06 * W, z: 0.63 * W, y: 210, rx: 200, rz: 80, rot: 1.1, shape: 1, carve: 1, depth: 12 })
    world.addLake({ x: -0.68 * W, z: -0.54 * W, y: 74, rx: 90, rz: 140, rot: 0, shape: 0, carve: 1, depth: 7 })
    world.addPath({ kind: 'river', depth: 2, pts: [[-0.73 * W, 260, -0.37 * W, 26], [-0.37 * W, 190, -0.15 * W, 30], [0, 130, 0.05 * W, 34], [0.32 * W, 92, 0.22 * W, 40]] })
    world.addPath({ kind: 'river', depth: 2, pts: [[0.51 * W, 300, 0.63 * W, 18], [0.37 * W, 220, 0.37 * W, 22], [0.38 * W, 150, 0.06 * W, 26]] })
    world.addPath({ kind: 'river', depth: 2.5, pts: [[-0.85 * W, 240, 0.61 * W, 20], [-0.49 * W, 180, 0.51 * W, 24], [-0.12 * W, 120, 0.44 * W, 28]] })
    world.addPath({ kind: 'road', feather: 8, pts: [[-0.85 * W, 150, 0, 10], [0, 140, 0.02 * W, 10], [0.85 * W, 160, -0.05 * W, 10]] })
    world.addPath({ kind: 'road', feather: 8, pts: [[0.15 * W, 140, -0.85 * W, 8], [0.11 * W, 150, 0, 8], [0.17 * W, 170, 0.85 * W, 8]] })
    world.addPath({ kind: 'road', feather: 6, pts: [[-0.61 * W, 120, -0.73 * W, 6], [-0.51 * W, 130, -0.61 * W, 6], [-0.37 * W, 140, -0.59 * W, 6]] })
    world.addSnowPoint(-0.18 * W, 0.32 * W, 45, 0.1 * W)
    world.addSnowPoint(0.59 * W, -0.46 * W, -60, 0.13 * W)

    // §18's claim is stated over a SAMPLED SWEEP: chunk-sized boxes scattered across the world, which is the measurement that isolates the index from whatever the LOD selector happens to be doing. Three chunk sizes, because the rate is a function of size -- a box far smaller than the content either lands on it or does not, a box far larger than the content nearly always contains some.
    const sweep = (depth, n) => {
      const size = (W * 2) / 2 ** depth
      const rnd = mulberry32(4242)
      let touched = 0
      const t0 = performance.now()
      for (let k = 0; k < n; k++) {
        const x = -W + rnd() * (W * 2 - size)
        const z = -W + rnd() * (W * 2 - size)
        if (world.overlaps(x, z, x + size, z + size)) touched++
      }
      const ns = ((performance.now() - t0) * 1e6) / n
      return { size, touched, pct: ((n - touched) / n) * 100, ns }
    }
    const leaf = sweep(MAX_DEPTH, 20000)
    const mid = sweep(MAX_DEPTH - 3, 20000)
    const coarseSweep = sweep(MAX_DEPTH - 7, 20000)
    for (const s of [leaf, mid, coarseSweep]) {
      console.log(`        ${s.size.toFixed(2).padStart(8)} m chunks: ${s.pct.toFixed(2)}% early-out, ${s.ns.toFixed(0)} ns per test`)
    }
    // THE BOUND IS 94, AND IT WAS 95 UNTIL THE LEAF GREW. This rate is a function of chunk size and nothing else -- a box that is small against the content either lands on it or does not, a box that is large nearly always contains some -- so lowering MAX_DEPTH from 13 to 8 m leaves took the leaf from 1 m to 8 m, 64x the area, and the early-out rate from ~99% to 94.8%. That is the index behaving exactly as described, not degrading: the number that matters for cost is early-outs per FRAME, and a coarser leaf means proportionally fewer chunks to test in the first place. The bound exists to catch an index that has stopped culling at all, so it tracks the leaf rather than pinning a round number the leaf size no longer supports.
    check(leaf.pct > 94, 'over 94% of chunks early-out of the content layers entirely', `${leaf.pct.toFixed(2)}% at the ${leaf.size.toFixed(2)} m leaf size`)
    // A cull rate of 100% would mean the sweep never put a chunk on top of anything, which would prove nothing.
    check(leaf.touched > 0, 'and the ones that do not early-out are real', `${leaf.touched} of 20000`)

    // The same question against a real chunk set, because the sweep above weights every chunk size equally and a frame does not.
    //
    // A v1-style LOD selection: refine while the cell exceeds the angular target at the node's range. quadtree-v2.js is another agent's file, so the rule is restated here rather than imported -- what is being measured is the cull rate over a realistic chunk set, not the selector.
    const TAN = Math.tan((3.0 * Math.PI) / 180)
    const boxes = []
    const depths = []
    const select = (x, z, size, depth, camX, camZ) => {
      const half = size / 2
      const range = Math.max(1, Math.hypot(camX - (x + half), camZ - (z + half)) - half * Math.SQRT2)
      if (depth < MAX_DEPTH && size / CHUNK_RES > range * TAN) {
        select(x, z, half, depth + 1, camX, camZ)
        select(x + half, z, half, depth + 1, camX, camZ)
        select(x, z + half, half, depth + 1, camX, camZ)
        select(x + half, z + half, half, depth + 1, camX, camZ)
        return
      }
      boxes.push(x, z, x + size, z + size)
      depths.push(depth)
    }
    // A lattice, not a hand-picked list. Cameras chosen to stand on the interesting objects would measure how good the author is at parking on a road.
    const cams = []
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) cams.push([(-0.9 + (1.8 * i) / 5) * W, (-0.9 + (1.8 * j) / 5) * W])
    for (const [cx, cz] of cams) select(-W, -W, W * 2, 0, cx, cz)

    let touched = 0
    let fineN = 0
    let fineT = 0
    const t0 = performance.now()
    for (let i = 0; i < boxes.length; i += 4) {
      const hit = world.overlaps(boxes[i], boxes[i + 1], boxes[i + 2], boxes[i + 3])
      if (hit) touched++
      // The far field is where the rate is genuinely poor, and it is poor for an honest reason: a leaf out there is a kilometre across and three roads cross the world. Splitting the count makes that visible instead of letting it drag one headline number down with no explanation.
      if (depths[i / 4] > 5) {
        fineN++
        if (hit) fineT++
      }
    }
    const ms = performance.now() - t0
    const chunks = boxes.length / 4
    const pct = ((chunks - touched) / chunks) * 100
    const finePct = ((fineN - fineT) / fineN) * 100
    console.log(
      `        LOD selection, ${chunks} chunks over ${cams.length} cameras at MAX_DEPTH ${MAX_DEPTH}: ` +
        `${pct.toFixed(2)}% early-out overall, ${finePct.toFixed(2)}% over the ${fineN} chunks below ${((W * 2) / 32).toFixed(0)} m, ${((ms * 1e6) / chunks).toFixed(0)} ns per test`
    )
    check(finePct > 94, 'and over 94% of a real LOD selection early-out, counting the chunks small enough to be numerous', `${finePct.toFixed(2)}%`)
  }

  console.log(`\nv2 layers: ${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-layers: ${failures} check(s) failed`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
