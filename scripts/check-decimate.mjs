// Gates src/mesh/decimate.js against meshes whose right answer is known by
// construction rather than by running the decimator and blessing what it said.
//
//   node scripts/check-decimate.mjs
//
// The invariant this module exists to hold is NOT "the triangle count went
// down" -- any broken decimator manages that. It is:
//
//   EVERY UV IN THE OUTPUT IS A UV THAT WAS IN THE INPUT, and every vertex on a
//   UV seam is still there. A decimator that interpolates texture coordinates
//   can move a triangle into the wrong atlas island, which on a 128px texture
//   changes what the surface is a picture of. That failure is invisible in a
//   triangle count and invisible at full texture size.
//
// So the checks below are mostly about what must NOT have changed.

import { analyzeMesh, buildTopology, countUvIslands, decimate, decimateLadder, estimateQuadFraction } from '../src/mesh/decimate.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

// --- fixtures ---------------------------------------------------------------

/**
 * An n x n quad grid on the XZ plane, triangulated, with one continuous UV
 * chart. Interior vertices are free, the rim is boundary and locked, so the
 * reduction ceiling is known in advance.
 */
function grid(n, { uvScale = 1 } = {}) {
  const positions = [], uvs = [], indices = []
  for (let z = 0; z <= n; z++) {
    for (let x = 0; x <= n; x++) {
      positions.push(x / n, 0, z / n)
      uvs.push((x / n) * uvScale, (z / n) * uvScale)
    }
  }
  const at = (x, z) => z * (n + 1) + x
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      indices.push(at(x, z), at(x + 1, z), at(x + 1, z + 1))
      indices.push(at(x, z), at(x + 1, z + 1), at(x, z + 1))
    }
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) }
}

/** A bumpy grid, so the quadric has real work to do and coplanar pairing does not. */
function bumpyGrid(n) {
  const g = grid(n)
  for (let i = 0; i < g.positions.length / 3; i++) {
    const x = g.positions[i * 3], z = g.positions[i * 3 + 2]
    g.positions[i * 3 + 1] = 0.15 * Math.sin(x * 7) * Math.cos(z * 5)
  }
  return g
}

/**
 * Two grids sharing a spine of positions but NOT of texture coordinates -- the
 * minimal UV seam. The shared spine is duplicated in the vertex buffer, which is
 * exactly how glTF stores a seam.
 */
function seamedPair(n) {
  const a = grid(n)
  const b = grid(n)
  const vertsA = a.positions.length / 3
  const positions = new Float32Array(a.positions.length * 2)
  const uvs = new Float32Array(a.uvs.length * 2)
  const indices = new Uint32Array(a.indices.length * 2)
  positions.set(a.positions, 0)
  uvs.set(a.uvs, 0)
  indices.set(a.indices, 0)
  for (let i = 0; i < vertsA; i++) {
    // Same X and Z, shifted in Z by exactly 1 so b's z=0 row lands on a's z=1
    // row: coincident positions, and UVs from a different corner of the atlas.
    positions[a.positions.length + i * 3] = b.positions[i * 3]
    positions[a.positions.length + i * 3 + 1] = b.positions[i * 3 + 1]
    positions[a.positions.length + i * 3 + 2] = b.positions[i * 3 + 2] + 1
    uvs[a.uvs.length + i * 2] = b.uvs[i * 2] * 0.5 + 0.5
    uvs[a.uvs.length + i * 2 + 1] = b.uvs[i * 2 + 1] * 0.5 + 0.5
  }
  for (let i = 0; i < a.indices.length; i++) indices[a.indices.length + i] = b.indices[i] + vertsA
  return { positions, uvs, indices }
}

/**
 * n independent planar quads, each tilted differently, each split into two
 * triangles. The unambiguous quad fixture: the only coplanar neighbour any
 * triangle has is its own quad partner.
 *
 * A flat grid cannot serve here. On a plane EVERY adjacent pair is coplanar, so
 * the pairing is genuinely ambiguous and greedy matching leaves a few triangles
 * unclaimed -- which is a property of the plane, not a detection failure.
 */
function detachedQuads(n) {
  const positions = [], uvs = [], indices = []
  for (let q = 0; q < n; q++) {
    const tilt = 0.3 + (q % 7) * 0.11
    const ox = (q % 8) * 10, oz = Math.floor(q / 8) * 10
    for (const [dx, dz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      positions.push(ox + dx, (dx + dz) * tilt, oz + dz)
      uvs.push(dx, dz)
    }
    const b = q * 4
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) }
}

/** An icosahedron -- no two adjacent faces are coplanar, so quad pairing must read ~0. */
function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2
  const p = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  return { positions: Float32Array.from(p.flat()), indices: Uint32Array.from(f.flat()), uvs: null }
}

const uvSet = (m) => {
  const s = new Set()
  for (let i = 0; i < m.uvs.length / 2; i++) s.add(`${m.uvs[i * 2].toFixed(6)},${m.uvs[i * 2 + 1].toFixed(6)}`)
  return s
}

const triCount = (m) => m.indices.length / 3

function degenerateCount(m) {
  let n = 0
  for (let f = 0; f < triCount(m); f++) {
    const a = m.indices[f * 3], b = m.indices[f * 3 + 1], c = m.indices[f * 3 + 2]
    if (a === b || b === c || a === c) n++
  }
  return n
}

function boundsOf(m) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.positions.length / 3; i++) {
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], m.positions[i * 3 + k])
      b[k + 3] = Math.max(b[k + 3], m.positions[i * 3 + k])
    }
  }
  return b
}

// --- topology ---------------------------------------------------------------

console.log('\ntopology and locking')
{
  const g = grid(6)
  const topo = buildTopology(g)
  check(topo.pointCount === 49, 'a 6x6 grid welds to 49 distinct points', String(topo.pointCount))
  let lockedCount = 0
  for (let p = 0; p < topo.pointCount; p++) if (topo.locked[p]) lockedCount++
  // The rim of a 7x7 lattice is 24 vertices, and an open boundary is locked.
  check(lockedCount === 24, 'exactly the 24 rim vertices are locked as boundary', String(lockedCount))
  check(countUvIslands(g) === 1, 'a continuous chart is one UV island')
}
{
  const s = seamedPair(4)
  check(countUvIslands(s) === 2, 'two charts sharing a spine read as two UV islands', String(countUvIslands(s)))
  const topo = buildTopology(s)
  // The shared spine is coincident in space but split in the atlas, so those
  // points must lock on the UV test, not just on the boundary test.
  let seamLocked = 0
  for (let p = 0; p < topo.pointCount; p++) {
    const o = p * 3
    if (Math.abs(topo.pointPos[o + 2] - 1) < 1e-9 && topo.locked[p]) seamLocked++
  }
  check(seamLocked === 5, 'every vertex on the shared spine is locked', `${seamLocked} of 5`)
}

// --- the invariant ----------------------------------------------------------

console.log('\nUVs are preserved, never invented')
{
  const g = bumpyGrid(20)
  const before = uvSet(g)
  const out = decimate(g, 200)
  const after = uvSet(out)
  let foreign = 0
  for (const uv of after) if (!before.has(uv)) foreign++
  check(foreign === 0, 'every UV in the output existed in the input', `${foreign} foreign of ${after.size}`)
  check(after.size <= before.size, 'and the decimation removed UVs rather than adding any')
}
{
  // The load-bearing case: a seam must survive intact even when the target is
  // aggressive enough that a seam-blind decimator would eat straight through it.
  const s = seamedPair(8)
  const islandsBefore = countUvIslands(s)
  const out = decimate(s, 40)
  check(countUvIslands(out) === islandsBefore,
    'decimating hard across a UV seam does not merge the islands', `${islandsBefore} -> ${countUvIslands(out)}`)
  const before = uvSet(s), after = uvSet(out)
  let foreign = 0
  for (const uv of after) if (!before.has(uv)) foreign++
  check(foreign === 0, 'and invents no texture coordinate at the seam', `${foreign} foreign`)
}

// --- reduction --------------------------------------------------------------

console.log('\nreduction')
{
  const g = bumpyGrid(20)
  check(triCount(g) === 800, 'the fixture starts at 800 triangles', String(triCount(g)))
  for (const target of [600, 400, 200, 100]) {
    const out = decimate(g, target)
    check(triCount(out) <= target, `hits the ${target}-triangle target`, `got ${triCount(out)}`)
    check(degenerateCount(out) === 0, `and emits no degenerate triangle at ${target}`)
  }
}
{
  // Monotonic: a smaller ask never returns a bigger mesh.
  const g = bumpyGrid(16)
  let last = Infinity
  let monotonic = true
  for (const t of [400, 300, 200, 150, 100, 60]) {
    const n = triCount(decimate(g, t))
    if (n > last) monotonic = false
    last = n
  }
  check(monotonic, 'asking for fewer triangles never returns more')
}
{
  const g = bumpyGrid(20)
  const before = boundsOf(g)
  const after = boundsOf(decimate(g, 150))
  // Half-edge collapse only ever removes vertices, so the result cannot reach
  // outside the original bounds. Growth means a vertex was moved somewhere new.
  const grew = after.slice(0, 3).some((v, i) => v < before[i] - 1e-6) ||
    after.slice(3).some((v, i) => v > before[i + 3] + 1e-6)
  check(!grew, 'the decimated mesh never grows outside the original bounds')
}
{
  // A mesh that is all seam cannot reduce, and must say so rather than
  // corrupting itself to hit the number. This is the shattered-atlas case, and
  // the refusal is the useful signal.
  const cube = {
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
    ]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
  }
  const out = decimate(cube, 1)
  check(triCount(out) === 4, 'an all-boundary mesh refuses to reduce', `${triCount(out)} triangles`)
  check(/ran out of legal collapses/.test(out.stats.reason), 'and reports why', out.stats.reason)
  // lockedFaces predicts that refusal ahead of time, which is what makes it
  // worth showing in the bench rather than discovering by running a decimation.
  check(analyzeMesh(cube).lockedFaces === 4, 'and analyzeMesh predicts the floor without decimating', String(analyzeMesh(cube).lockedFaces))
}
{
  const g = bumpyGrid(20)
  const out = decimate(g, 200)
  check(out.stats.inputTris === 800 && out.stats.outputTris === triCount(out), 'stats report the real counts')
  check(out.stats.reduction > 0.7, 'and a reduction fraction that matches', out.stats.reduction.toFixed(3))
  check(out.indices instanceof Uint16Array, 'a small mesh gets a 16-bit index buffer')
}

console.log('\nladder')
{
  const g = bumpyGrid(20)
  const tiers = decimateLadder(g, [100, 400, 200])
  check(tiers.length === 3, 'a ladder returns one tier per target')
  check(triCount(tiers[0]) >= triCount(tiers[1]) && triCount(tiers[1]) >= triCount(tiers[2]),
    'tiers come back ordered coarsest-last', tiers.map(triCount).join(' -> '))
  const sets = tiers.map(uvSet)
  // Nested: each tier is decimated from the one above, so its UVs are a subset.
  check([...sets[2]].every((uv) => sets[1].has(uv)), 'each tier\'s vertices are a subset of the tier above it')
}

// --- quad detection ---------------------------------------------------------

console.log('\nquad pairing estimate')
{
  const q = detachedQuads(24)
  check(estimateQuadFraction(q) === 1, 'a mesh of tilted planar quads reads as exactly 1.0', estimateQuadFraction(q).toFixed(3))
  const ico = icosahedron()
  check(estimateQuadFraction(ico) === 0, 'an icosahedron, which has no coplanar neighbours, reads as 0', estimateQuadFraction(ico).toFixed(3))
  const b = bumpyGrid(20)
  check(estimateQuadFraction(b) < 0.6, 'and a curved surface is not mistaken for quads', estimateQuadFraction(b).toFixed(3))
  // A flat grid is the ambiguous case, and lands high but not at 1.0 because
  // every pairing is equally coplanar. Pinned so the ambiguity stays documented.
  check(estimateQuadFraction(grid(10)) > 0.85, 'a flat grid reads high, though its pairing is ambiguous', estimateQuadFraction(grid(10)).toFixed(3))
}

// --- analyze ----------------------------------------------------------------

console.log('\nanalyzeMesh')
{
  const a = analyzeMesh(bumpyGrid(10))
  check(a.tris === 200, 'reports triangle count', String(a.tris))
  check(a.points === 121 && a.lockedPoints === 40, 'reports welded points and how many are pinned', `${a.points} pts, ${a.lockedPoints} locked`)
  check(a.freePoints === a.points - a.lockedPoints, 'free and locked account for every point')
  check(a.uvIslands === 1, 'reports the island count')
  // A grid's four corner triangles have all three vertices on the rim, so a
  // small non-zero floor is correct. It should stay small.
  check(a.lockedFaces > 0 && a.lockedFaces < a.tris * 0.1,
    'a grid has a small floor of fully-pinned faces at its corners', `${a.lockedFaces} of ${a.tris}`)
}

// --- failure modes ----------------------------------------------------------

console.log('\nloud failures')
check(throws(() => decimate({ indices: Uint32Array.from([0, 1, 2]) }, 1)), 'missing positions throws')
check(throws(() => decimate(grid(4), 0)), 'a zero target throws rather than emptying the mesh')
check(throws(() => decimate(grid(4), -5)), 'a negative target throws')
check(throws(() => decimate(grid(4), NaN)), 'a NaN target throws')

console.log(`\n${failures === 0 ? 'all decimate checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
