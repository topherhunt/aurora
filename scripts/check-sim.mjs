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
import { selectNodes, MAX_DEPTH, DEFAULT_SPLIT_K, MAX_SPLIT_K } from '../src/terrain/quadtree.js'
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
  check(max - min > 300, 'has real vertical relief', `${min.toFixed(0)}m .. ${max.toFixed(0)}m`)
  check(max < 2000 && min > -200, 'elevations in a plausible band', `${min.toFixed(0)} .. ${max.toFixed(0)}`)

  const a = th.heightAt(123.5, -456.25)
  const b = th.heightAt(123.5, -456.25)
  const c = new TerrainHeight(SEED).heightAt(123.5, -456.25)
  check(a === b && a === c, 'deterministic across instances', `${a.toFixed(4)}`)
}

// --- 2. slope distribution --------------------------------------------------
//
// §4 makes traps impossible by refusing slopes over ~38 degrees. That only
// yields an explorable world if most of it is under the limit -- if the terrain
// tuning produces 60% cliffs, she is walking down corridors, not exploring.

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
  check(walkable > 0.55, 'majority of the world is walkable', `${(walkable * 100).toFixed(1)}%`)
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
      if (h < 60 || h > 260) continue
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

  const t0 = performance.now()
  let walkableCount = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const ok = th.slopeAt(x0 + i * cell, z0 + j * cell, 1.0) <= MAX_SLOPE
      walk[j * N + i] = ok ? 1 : 0
      if (ok) walkableCount++
    }
  }

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
      if (seen[q] || !walk[q]) return
      seen[q] = 1
      stack.push(q)
    }
    push(i + 1, j)
    push(i - 1, j)
    push(i, j + 1)
    push(i, j - 1)
  }

  const frac = reached / walkableCount
  console.log(
    `        ${(EXTENT / 1000).toFixed(0)}km box at ${cell.toFixed(0)}m: ` +
      `${walkableCount} walkable cells, ${reached} reachable (${(frac * 100).toFixed(1)}%), ` +
      `${(performance.now() - t0).toFixed(0)}ms`
  )
  check(frac > 0.5, 'spawn is not fenced into a pocket', `${(frac * 100).toFixed(1)}% of local walkable area reachable`)
}

// --- 5. quadtree LOD budget -------------------------------------------------
//
// This is the check that the first version of step 2 needed and did not have.
// It shipped at 502 leaves and 675k triangles -- 79% of the measured Quest
// ceiling for a world containing nothing but ground -- and none of the sim
// checks above noticed, because nothing above knows what a frame costs.

console.log('\nquadtree LOD budget')
{
  // Sampled at several camera positions: leaf count depends on where the camera
  // sits relative to the grid, and the worst case is what has to fit.
  const CAMS = [
    [0, 0],
    [137, -4211],
    [-2048.5, 900.25],
    [4096, 4096],
    [-7000, 120],
    [spawn ? spawn.x : 0, spawn ? spawn.z : 0],
  ]

  const worstAt = (K) => {
    let worst = 0
    for (const [cx, cz] of CAMS) {
      const n = selectNodes(cx, cz, MAX_DEPTH, K).length
      if (n > worst) worst = n
    }
    return worst
  }

  const tpc = CHUNK_INDICES / 3
  const leafSize = WORLD_HALF * 2 / 2 ** MAX_DEPTH

  const dflt = worstAt(DEFAULT_SPLIT_K)
  const dfltTris = dflt * tpc
  console.log(
    `        res ${CHUNK_RES}  splitK ${DEFAULT_SPLIT_K}  depth ${MAX_DEPTH}: ` +
      `${dflt} leaves x ${tpc} tris = ${(dfltTris / 1000).toFixed(0)}k  ` +
      `(${((dfltTris / TRI_BUDGET) * 100).toFixed(0)}% of the ${TRI_BUDGET / 1000}k budget)  ` +
      `leaf ${leafSize}m at ${(leafSize / CHUNK_RES).toFixed(2)}m/cell  ` +
      `~${(57.2958 / (CHUNK_RES * DEFAULT_SPLIT_K)).toFixed(2)}deg angular error`
  )

  // Ground is the backdrop, not the subject. §0's corrected ceiling only works
  // if props get the majority of it, so terrain is held to a third.
  check(dfltTris < TRI_BUDGET / 3, 'empty world leaves the budget to props', `${(dfltTris / 1000).toFixed(0)}k of ${TRI_BUDGET / 1000}k`)

  // Slots are pre-allocated and never grow, so the pool must cover the worst
  // selection the player can actually reach with the [ ] keys, plus the 21
  // pinned base-layer chunks.
  const maxK = worstAt(MAX_SPLIT_K)
  console.log(`        worst case at splitK ${MAX_SPLIT_K}: ${maxK} leaves + 21 pinned, pool holds ${SLOT_COUNT}`)
  check(maxK + 21 <= SLOT_COUNT, 'slot pool covers the worst reachable splitK', `${maxK + 21} vs ${SLOT_COUNT}`)

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
