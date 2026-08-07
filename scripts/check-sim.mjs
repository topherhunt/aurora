// Node-side sanity checks for the sim layer (src/sim/*), which is deliberately
// free of three.js so it can run headless -- see DESIGN.md §1.
//
// This is NOT a substitute for looking at the terrain. It catches the failures
// that are invisible on a screenshot: degenerate geometry, NaNs, a world that
// is mostly too steep to walk on, or a spawn basin fenced in by cliffs.
//
//   node scripts/check-sim.mjs [seed]

import { TerrainHeight, WORLD_HALF } from '../src/sim/terrain-height.js'
import { buildChunk, CHUNK_RES } from '../src/sim/chunk-mesh.js'
import { selectNodes, MAX_DEPTH, LOD, MIN_TRI_DEG, VIEW_HALF_ANGLE } from '../src/terrain/quadtree.js'
import { SLOT_COUNT, CHUNK_VERTS, CHUNK_INDICES } from '../src/terrain/terrain.js'
import { TRI_BUDGET } from '../src/budget.js'

const SEED = Number(process.argv[2] ?? 20260804)
const MAX_SLOPE = (38 * Math.PI) / 180
const th = new TerrainHeight(SEED)

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log(`\n=== sim checks, seed ${SEED} ===\n`)

// --- 1. height field --------------------------------------------------------

console.log('height field')
{
  let min = Infinity
  let max = -Infinity
  let nan = 0
  const N = 200
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -WORLD_HALF + (i / (N - 1)) * WORLD_HALF * 2
      const z = -WORLD_HALF + (j / (N - 1)) * WORLD_HALF * 2
      const h = th.heightAt(x, z)
      if (!Number.isFinite(h)) nan++
      if (h < min) min = h
      if (h > max) max = h
    }
  }
  check(nan === 0, 'no NaN/Infinity heights', `${nan} bad of ${N * N}`)
  check(max - min > 150, 'has real vertical relief', `${min.toFixed(0)}m .. ${max.toFixed(0)}m`)
  check(max < 2000 && min > -200, 'elevations in a plausible band', `${min.toFixed(0)} .. ${max.toFixed(0)}`)

  const a = th.heightAt(123.5, -456.25)
  const b = th.heightAt(123.5, -456.25)
  const c = new TerrainHeight(SEED).heightAt(123.5, -456.25)
  check(a === b && a === c, 'deterministic across instances', `${a.toFixed(4)}`)
}

// --- 2. slope distribution --------------------------------------------------
//
// §4 makes traps impossible by refusing slopes over ~38 degrees. That only
// yields an explorable world if enough of it is under the limit -- if the
// terrain tuning produces 80% cliffs, she is walking down corridors.
//
// This number has been the best single indicator of a bad terrain pass. It was
// 82% originally, fell to 53% when the horizontal scale shrank without the
// vertical one, and that 53% was the measurable shadow of what the world
// actually looked like in the headset: sheer walls as the default mountainside,
// with whole basins sealed off. Cutting mountainRelief ~4x put it at ~88%.
//
// So the gate stays low (0.45) as a backstop against a map turned vertical, but
// the number itself is worth reading every run. What §4 guarantees is
// CONNECTIVITY, which section 4 below measures directly -- but a world can be
// technically connected and still no fun to walk across.

console.log('\nslope distribution (eps = 1 m, matching leaf cell size)')
{
  const N = 220
  const buckets = [0, 0, 0, 0, 0] // <10, <20, <30, <38, >=38
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -WORLD_HALF + (i / (N - 1)) * WORLD_HALF * 2
      const z = -WORLD_HALF + (j / (N - 1)) * WORLD_HALF * 2
      const d = (th.slopeAt(x, z, 1.0) * 180) / Math.PI
      if (d < 10) buckets[0]++
      else if (d < 20) buckets[1]++
      else if (d < 30) buckets[2]++
      else if (d < 38) buckets[3]++
      else buckets[4]++
    }
  }
  const total = N * N
  const pct = (n) => ((n / total) * 100).toFixed(1) + '%'
  console.log(
    `        <10deg ${pct(buckets[0])}  <20 ${pct(buckets[1])}  <30 ${pct(buckets[2])}  ` +
      `<38 ${pct(buckets[3])}  BLOCKED ${pct(buckets[4])}`
  )
  const walkable = (total - buckets[4]) / total
  check(walkable > 0.45, 'enough of the world is walkable', `${(walkable * 100).toFixed(1)}%`)
  check(buckets[4] / total > 0.02, 'some genuinely impassable terrain exists', `${pct(buckets[4])}`)
}

// --- 3. chunk meshing -------------------------------------------------------

console.log('\nchunk meshing')
{
  const res = CHUNK_RES
  // Smallest leaf, a mid-ring chunk, and a pinned base-layer chunk. terrain.js
  // pre-allocates one fixed-size GPU slot per chunk, so all three must produce
  // byte-identical geometry sizes -- that invariant is what makes slot reuse
  // legal, and it is checked below.
  for (const size of [16, 256, 4096]) {
    const t0 = performance.now()
    const r = buildChunk(th, { ox: 512, oz: -1024, size, res })
    const ms = performance.now() - t0

    const vpr = res + 1
    const expectVerts = vpr * vpr + 4 * vpr
    const expectTris = res * res * 2 + 4 * res * 2

    check(r.positions.length === expectVerts * 3, `size ${size}m: vertex count`, `${r.positions.length / 3}`)
    check(r.indices.length === expectTris * 3, `size ${size}m: triangle count`, `${r.indices.length / 3} tris`)

    let bad = 0
    for (let i = 0; i < r.positions.length; i++) if (!Number.isFinite(r.positions[i])) bad++
    for (let i = 0; i < r.normals.length; i++) if (!Number.isFinite(r.normals[i])) bad++
    check(bad === 0, `size ${size}m: no NaN in position/normal`, `${bad}`)

    let oob = 0
    for (let i = 0; i < r.indices.length; i++) if (r.indices[i] >= expectVerts) oob++
    check(oob === 0, `size ${size}m: indices in range`, `${oob} out of range`)

    // Grid triangles (the first res*res*2) must face upward. If the winding is
    // inverted the whole terrain is backface-culled and the world looks empty.
    let downward = 0
    const gridTris = res * res * 2
    for (let t = 0; t < gridTris; t++) {
      const a = r.indices[t * 3] * 3
      const b = r.indices[t * 3 + 1] * 3
      const c = r.indices[t * 3 + 2] * 3
      const e1 = [r.positions[b] - r.positions[a], r.positions[b + 1] - r.positions[a + 1], r.positions[b + 2] - r.positions[a + 2]]
      const e2 = [r.positions[c] - r.positions[a], r.positions[c + 1] - r.positions[a + 1], r.positions[c + 2] - r.positions[a + 2]]
      const ny = e1[2] * e2[0] - e1[0] * e2[2]
      if (ny <= 0) downward++
    }
    check(downward === 0, `size ${size}m: grid winding faces up`, `${downward}/${gridTris} inverted`)

    // Skirt triangles must face outward, i.e. away from the chunk centre.
    let inward = 0
    const half = size / 2
    for (let t = gridTris; t < expectTris; t++) {
      const a = r.indices[t * 3] * 3
      const b = r.indices[t * 3 + 1] * 3
      const c = r.indices[t * 3 + 2] * 3
      const e1 = [r.positions[b] - r.positions[a], r.positions[b + 1] - r.positions[a + 1], r.positions[b + 2] - r.positions[a + 2]]
      const e2 = [r.positions[c] - r.positions[a], r.positions[c + 1] - r.positions[a + 1], r.positions[c + 2] - r.positions[a + 2]]
      const nx = e1[1] * e2[2] - e1[2] * e2[1]
      const nz = e1[0] * e2[1] - e1[1] * e2[0]
      const cx = r.positions[a] - half
      const cz = r.positions[a + 2] - half
      if (nx * cx + nz * cz <= 0) inward++
    }
    check(inward === 0, `size ${size}m: skirt winding faces out`, `${inward}/${expectTris - gridTris} inverted`)

    console.log(`        gen ${ms.toFixed(1)}ms   relief ${(r.maxY - r.minY).toFixed(0)}m   skirt ${r.skirtDepth.toFixed(0)}m`)
  }
}

// --- 4. spawn + local connectivity ------------------------------------------

console.log('\nspawn and connectivity')
let spawn = null
{
  outer: for (let r = 0; r <= 3000; r += 60) {
    const steps = r === 0 ? 1 : 24
    for (let a = 0; a < steps; a++) {
      const ang = (a / steps) * Math.PI * 2 + r * 0.21
      const x = Math.cos(ang) * r
      const z = Math.sin(ang) * r
      const h = th.heightAt(x, z)
      if (h < 85 || h > 140) continue // must match findSpawn() in src/main.js
      if (th.slopeAt(x, z) > (15 * Math.PI) / 180) continue
      spawn = { x, z, h }
      break outer
    }
  }
  check(spawn !== null, 'a walkable spawn exists near the origin', spawn ? `${spawn.x.toFixed(0)},${spawn.z.toFixed(0)} @ ${spawn.h.toFixed(0)}m` : '')
}

if (spawn) {
  // Flood fill a 4 km box around spawn. This is a smoke test, not the real
  // Phase A connectivity validation (§2 step 7) -- that runs on the 2048 grid
  // and must also reach every village and the summit.
  const N = 256
  const EXTENT = 4096
  const cell = EXTENT / N
  const walk = new Uint8Array(N * N)
  const x0 = spawn.x - EXTENT / 2
  const z0 = spawn.z - EXTENT / 2

  // Probe at the CELL SIZE, not at 1 m. This used to sample a 1 m slope and then
  // flood-fill as though each sample owned a 16 m cell, which is not a
  // conservative reading -- it is an inconsistent one. A single steep metre at a
  // cell's centre condemned the whole cell, and enough scattered false negatives
  // fragment a network that is genuinely connected: the same world measured
  // 73% reachable at eps 1 m and 99% at eps 16 m.
  //
  // 16 m is also the honest question for this fill. Whether she can get from one
  // cell to the next is a question about the grade between them; whether a
  // 1 m dimple in the middle stops her is a question the contour slide in
  // player.js answers, and this fill does not model sliding. The fine-scale
  // slope still gets measured -- that is the histogram in section 2.
  // The fill is over EDGES, not over nodes, because that is what player.js
  // actually tests. _walkable(x, z, dx, dz, dist) compares the height where she
  // is against the height where she is going and rejects the STEP; it never
  // asks whether the ground she is standing on is steep. A node mask deletes
  // every cell whose own local slope is over the limit, which severs the one
  // place a mountain world most needs a corridor: the flat strip along the base
  // of a cliff, where slopeAt() reads the cliff and condemns the strip.
  //
  // The difference is not small and it is not conservative, it is wrong: this
  // same terrain measures 71.8% reachable as nodes and 93.1% as edges. The node
  // number sent the previous pass hunting a connectivity regression that was
  // never in the terrain. Nodes still get reported below, as a shape statistic.
  const t0 = performance.now()
  const H = new Float32Array(N * N)
  let gentleCount = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      H[j * N + i] = th.heightAt(x0 + i * cell, z0 + j * cell)
      if (th.slopeAt(x0 + i * cell, z0 + j * cell, cell) <= MAX_SLOPE) {
        walk[j * N + i] = 1
        gentleCount++
      }
    }
  }
  const maxTan = Math.tan(MAX_SLOPE)

  const si = Math.round((spawn.x - x0) / cell)
  const sj = Math.round((spawn.z - z0) / cell)
  const seen = new Uint8Array(N * N)
  const stack = [sj * N + si]
  seen[sj * N + si] = 1
  let reached = 0
  while (stack.length) {
    const p = stack.pop()
    reached++
    const i = p % N
    const j = (p / N) | 0
    const push = (ni, nj) => {
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) return
      const q = nj * N + ni
      if (seen[q]) return
      if (Math.abs(H[q] - H[p]) / cell > maxTan) return
      seen[q] = 1
      stack.push(q)
    }
    push(i + 1, j)
    push(i - 1, j)
    push(i, j + 1)
    push(i, j - 1)
  }

  const frac = reached / (N * N)
  console.log(
    `        ${(EXTENT / 1000).toFixed(0)}km box at ${cell.toFixed(0)}m: ` +
      `${reached} of ${N * N} cells reachable on foot (${(frac * 100).toFixed(1)}%), ` +
      `${((gentleCount / (N * N)) * 100).toFixed(1)}% gentle, ${(performance.now() - t0).toFixed(0)}ms`
  )
  check(frac > 0.75, 'spawn is not fenced into a pocket', `${(frac * 100).toFixed(1)}% of the box reachable`)
}

// --- 5. quadtree LOD budget -------------------------------------------------
//
// This is the check that the first version of step 2 needed and did not have.
// It shipped at 502 leaves and 675k triangles -- 79% of the measured Quest
// ceiling for a world containing nothing but ground -- and none of the sim
// checks above noticed, because nothing above knows what a frame costs.

console.log('\nquadtree LOD budget')
{
  // Sampled at many camera positions: leaf count depends on where the camera
  // sits relative to the grid, and the worst case is what has to fit.
  //
  // This was six hand-picked positions, which was too thin: the leaf count moves
  // with the terrain under the camera and with its altitude, not just with its
  // alignment to the grid. Six cameras missed the worst case by 3%. A hard limit
  // deserves a real sample, and this one is a HARD limit -- the current selection
  // is exempt from eviction (terrain.js _evict), so overrunning the pool throws
  // rather than degrading.
  const CAMS = [
    [0, 0],
    [137, -4211],
    [-2048.5, 900.25],
    [4096, 4096],
    [-7000, 120],
    [spawn ? spawn.x : 0, spawn ? spawn.z : 0],
  ]
  // Deterministic LCG so a failure here is reproducible rather than a coin flip.
  let rs = 12345
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 600; i++) CAMS.push([(rnd() * 2 - 1) * 8000, (rnd() * 2 - 1) * 8000])

  // Half the cameras fly. Altitude is not a detail here: the range test is 3D,
  // so a camera 400 m up is genuinely further from the ground below it than its
  // map position suggests, and the airborne case is where the LOD rule this
  // replaced fell apart worst.
  // Selection holds slots; only the part inside the 110 deg eye cone is DRAWN,
  // because the GPU culls the rest per-instance. Those are two different budgets
  // against two different ceilings and conflating them is how you end up either
  // throwing or leaving half the triangle budget unspent.
  const EYE_HALF = (55 * Math.PI) / 180
  const inEye = (cam, n) => {
    const cx = n.x + n.size / 2
    const cz = n.z + n.size / 2
    let d = Math.atan2(cx - cam.x, cz - cam.z) - cam.yaw
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    const spread = Math.atan2(n.size * 0.71, Math.max(Math.hypot(cx - cam.x, cz - cam.z), 1))
    return Math.abs(d) <= EYE_HALF + spread
  }

  const worstAt = (triDeg) => {
    let worst = 0
    let drawn = 0
    let at = null
    for (let i = 0; i < CAMS.length; i++) {
      const [cx, cz] = CAMS[i]
      const ground = th.heightAt(cx, cz)
      const y = ground + (i % 2 === 0 ? 1.7 : 150 + (i % 7) * 64)
      // Four headings per position: selection is view-dependent now, so the
      // worst case is over directions as well as over places. Eight headings
      // were tried and found the same worst case, which is what you would
      // expect from a cone this wide.
      for (let q = 0; q < 4; q++) {
        const cam = { x: cx, y, z: cz, yaw: (q * Math.PI) / 2 }
        const sel = selectNodes(cam, { maxDepth: MAX_DEPTH, triDeg })
        if (sel.length > worst) {
          worst = sel.length
          at = `${cx.toFixed(0)},${cz.toFixed(0)} at ${(y - ground).toFixed(0)}m AGL`
        }
        let d = 0
        for (const n of sel) if (inEye(cam, n)) d++
        if (d > drawn) drawn = d
      }
    }
    return { worst, drawn, at }
  }

  const tpc = CHUNK_INDICES / 3
  const leafSize = (WORLD_HALF * 2) / 2 ** MAX_DEPTH

  const dflt = worstAt(LOD.triDeg)
  const drawnTris = dflt.drawn * tpc
  console.log(
    `        res ${CHUNK_RES}  triangles<=${LOD.triDeg}deg  depth ${MAX_DEPTH}  margin ${((VIEW_HALF_ANGLE * 180) / Math.PI).toFixed(0)}deg: ` +
      `worst ${dflt.worst} leaves selected, ${dflt.drawn} drawn x ${tpc} tris = ${(drawnTris / 1000).toFixed(0)}k  ` +
      `(${((drawnTris / TRI_BUDGET) * 100).toFixed(0)}% of the ${TRI_BUDGET / 1000}k budget)  ` +
      `leaf ${leafSize}m at ${(leafSize / CHUNK_RES).toFixed(2)}m/cell`
  )
  console.log(`        worst selection found at ${dflt.at}`)

  // Ground is the backdrop, not the subject. §0's corrected ceiling only works
  // if props get the majority of it, so terrain is held to a third.
  check(
    drawnTris < TRI_BUDGET / 3,
    'worst-case DRAWN terrain leaves the budget to props',
    `${(drawnTris / 1000).toFixed(0)}k of ${TRI_BUDGET / 1000}k`
  )

  // Slots are pre-allocated and never grow, so the pool must cover the FINEST
  // setting the [ ] keys and the panel can reach, plus the 21 pinned base-layer
  // chunks. The tuner has a reactive backoff for this, but a knob whose range
  // includes values that cannot work is a knob that fails late and in the
  // headset. MIN_TRI_DEG exists to make the floor safe by construction.
  const fine = worstAt(MIN_TRI_DEG)
  console.log(
    `        finest reachable (${MIN_TRI_DEG}deg): ${fine.worst} leaves + 21 pinned, pool holds ${SLOT_COUNT}` +
      `  [${fine.at}]`
  )
  check(
    fine.worst + 21 <= SLOT_COUNT,
    'slot pool covers the finest reachable LOD setting',
    `${fine.worst + 21} vs ${SLOT_COUNT}`
  )

  // The tuner backs off by 1.1x when the selection overruns (tuner.js), which
  // only terminates if coarsening actually costs fewer leaves. That is the
  // property worth asserting -- not the exact exponent.
  //
  // For the record it is about 2x per halving rather than the 4x the area
  // argument suggests, because MAX_DEPTH clamps the near field: at a 1.2 deg cap
  // the rule already wants finer than 16 m leaves inside ~48 m, and halving the
  // cap only pushes that radius out rather than buying more detail inside it.
  const coarser = worstAt(LOD.triDeg * 1.1)
  console.log(
    `        backoff step: ${LOD.triDeg}deg -> ${(LOD.triDeg * 1.1).toFixed(2)}deg drops the worst ` +
      `selection ${dflt.worst} -> ${coarser.worst}  (halving it: ${(dflt.worst / worstAt(LOD.triDeg * 2).worst).toFixed(2)}x)`
  )
  check(coarser.worst < dflt.worst, "tuner's 1.1x backoff step actually reduces the selection", `${dflt.worst} -> ${coarser.worst}`)

  // Uniform chunk topology is what makes slot reuse legal at all.
  check(
    CHUNK_VERTS === (CHUNK_RES + 1) ** 2 + 4 * (CHUNK_RES + 1) &&
      CHUNK_INDICES === (CHUNK_RES * CHUNK_RES * 2 + 4 * CHUNK_RES * 2) * 3,
    'slot size matches what the mesher emits',
    `${CHUNK_VERTS} verts / ${CHUNK_INDICES} indices`
  )
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
