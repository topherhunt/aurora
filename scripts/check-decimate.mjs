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
 * One continuous curved surface whose atlas has been shattered: positions are a
 * welded n x n grid, but every quad owns a separate, gapped cell in UV space. The
 * Tripo failure in miniature -- nothing is wrong with the geometry, and an
 * atlas-preserving decimator still cannot get below one triangle per island.
 */
function shatteredAtlas(n) {
  const positions = [], uvs = [], indices = []
  const h = (x, z) => 0.15 * Math.sin(x * 7) * Math.cos(z * 5)
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const b = positions.length / 3
      for (const [dx, dz] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const px = (x + dx) / n, pz = (z + dz) / n
        positions.push(px, h(px, pz), pz)
        // Inset by 5% so neighbouring cells never touch, which would weld two
        // islands into one and make the island count a smaller number than the
        // fixture is trying to be.
        uvs.push((x + 0.05 + dx * 0.9) / n, (z + 0.05 + dz * 0.9) / n)
      }
      indices.push(b, b + 1, b + 2, b, b + 2, b + 3)
    }
  }
  return { positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) }
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

/**
 * A coarse ball with two finely-tessellated cone ears grafted into it, replacing
 * the triangle fan around one of the ball's own vertices. The fox in miniature,
 * and the fine tessellation is the whole point: an ear built from many small
 * triangles carries a tiny share of the surface area, so an area-weighted quadric
 * prices every collapse inside it at almost nothing and the ears go first.
 *
 * Returns the mesh plus the two tip positions, so a check can ask how far the
 * output still reaches in each ear's direction.
 */
function earedBall({ rings = 8, segs = 12, earRings = 7, earHeight = 0.5, earBase = 0.16 } = {}) {
  const P = [], tri = []
  P.push([0, 1, 0])
  for (let r = 1; r <= rings; r++) {
    const phi = (r * Math.PI) / (rings + 1)
    for (let s = 0; s < segs; s++) {
      const th = (s * 2 * Math.PI) / segs
      P.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)])
    }
  }
  P.push([0, -1, 0])
  const south = P.length - 1
  const at = (r, s) => 1 + (r - 1) * segs + ((s % segs) + segs) % segs
  for (let s = 0; s < segs; s++) tri.push([0, at(1, s + 1), at(1, s)])
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      tri.push([at(r, s), at(r, s + 1), at(r + 1, s + 1)])
      tri.push([at(r, s), at(r + 1, s + 1), at(r + 1, s)])
    }
  }
  for (let s = 0; s < segs; s++) tri.push([south, at(rings, s), at(rings, s + 1)])

  const tips = []
  for (const v of [at(2, 2), at(2, 5)]) {
    // Walk the fan around v into a ring in order, then cut the fan out. The ring
    // is the hole's boundary and becomes the ear's base, so the graft is manifold.
    const fan = tri.filter((t) => t.includes(v))
    const next = new Map()
    for (const t of fan) { const i = t.indexOf(v); next.set(t[(i + 1) % 3], t[(i + 2) % 3]) }
    const ring = [fan[0][(fan[0].indexOf(v) + 1) % 3]]
    while (ring.length < fan.length) ring.push(next.get(ring[ring.length - 1]))
    for (const t of fan) tri.splice(tri.indexOf(t), 1)

    const c = P[v], axis = c.map((x) => x / Math.hypot(...c))
    const n = ring.length
    let prev = ring
    for (let k = 1; k <= earRings; k++) {
      const u = k / (earRings + 1)
      const rad = 1 - u * (1 - earBase)
      const cur = ring.map((b) => P.push(P[b].map((x, j) => c[j] + (x - c[j]) * rad + axis[j] * earHeight * u)) - 1)
      for (let i = 0; i < n; i++) {
        const a0 = prev[i], a1 = prev[(i + 1) % n], b0 = cur[i], b1 = cur[(i + 1) % n]
        tri.push([a0, a1, b1]); tri.push([a0, b1, b0])
      }
      prev = cur
    }
    const tip = P.push(c.map((x, j) => x + axis[j] * earHeight)) - 1
    for (let i = 0; i < n; i++) tri.push([prev[i], prev[(i + 1) % n], tip])
    tips.push(P[tip].slice())
  }
  return { mesh: { positions: Float32Array.from(P.flat()), indices: Uint32Array.from(tri.flat()) }, tips }
}

/**
 * A body with detached tetrahedra scattered around it: the fen-dragon in
 * miniature, whose crest is 42 loose four-face spines that no edge collapse can
 * shrink. Each entry of `pieces` is `{ size, at }`; the body is an icosahedron
 * of the given radius. No UVs, so the geometry is all that is under test.
 */
function bodyWithTets(radius, pieces) {
  const positions = [], indices = []
  const add = (pts, tris) => {
    const base = positions.length / 3
    positions.push(...pts.flat())
    indices.push(...tris.flat().map((i) => i + base))
  }
  const ico = icosahedron()
  add(Array.from({ length: 12 }, (_, i) => [0, 1, 2].map((k) => ico.positions[i * 3 + k] * radius)), [Array.from(ico.indices)])
  for (const { size, at } of pieces) {
    add([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => p.map((x, k) => at[k] + x * size)), [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]])
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), uvs: null }
}

/** How far the mesh reaches in direction d -- the silhouette's extent that way. */
function support(m, d) {
  const len = Math.hypot(d[0], d[1], d[2])
  let best = -Infinity
  for (let i = 0; i < m.positions.length / 3; i++) {
    best = Math.max(best, m.positions[i * 3] * d[0] + m.positions[i * 3 + 1] * d[1] + m.positions[i * 3 + 2] * d[2])
  }
  return best / len
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

/** Mean-ratio quality per triangle: 1 equilateral, about 0.5 at 3:1, 0 degenerate. */
function triQualities(m) {
  const P = m.positions, out = []
  for (let f = 0; f < triCount(m); f++) {
    const [a, b, c] = [m.indices[f * 3] * 3, m.indices[f * 3 + 1] * 3, m.indices[f * 3 + 2] * 3]
    const e = (i, j) => [P[j] - P[i], P[j + 1] - P[i + 1], P[j + 2] - P[i + 2]]
    const ab = e(a, b), ac = e(a, c), bc = e(b, c)
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
    const sum = [ab, ac, bc].reduce((t, v) => t + v[0] * v[0] + v[1] * v[1] + v[2] * v[2], 0)
    out.push(sum > 0 ? (2 * Math.sqrt(3) * Math.hypot(n[0], n[1], n[2])) / sum : 0)
  }
  return out
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
  // points must classify on the UV test. The two spine ends sit on the open
  // boundary as well, and boundary outranks seam: it is the stricter answer.
  let spineSeam = 0, spineLocked = 0
  for (let p = 0; p < topo.pointCount; p++) {
    const o = p * 3
    if (Math.abs(topo.pointPos[o + 2] - 1) > 1e-9) continue
    if (topo.locked[p]) spineLocked++
    else if (topo.seam[p]) spineSeam++
  }
  check(spineSeam + spineLocked === 5, 'every vertex on the shared spine is seam or boundary', `${spineSeam} seam + ${spineLocked} boundary`)
  check(spineSeam === 3, 'the three interior spine vertices read as seam, not as pinned', String(spineSeam))
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
{
  // Seams are collapsible, not pinned. This is what separates the current
  // decimator from the one that returned a Tripo fox at 99.6% of its input
  // size: pinning every seam vertex stops a shattered atlas dead.
  const s = seamedPair(8)
  const pinned = decimate(s, 40, { seamCollapse: false })
  const aware = decimate(s, 40)
  check(triCount(aware) < triCount(pinned),
    'a seamed mesh reduces further with seam collapses than without', `${triCount(aware)} vs ${triCount(pinned)}`)
  check(countUvIslands(aware) === countUvIslands(s),
    'and still does not merge the two islands', `${countUvIslands(s)} -> ${countUvIslands(aware)}`)

  // The one thing a wedge collapse must never do: give a face a UV from an
  // island it was not in. Checked per FACE, not per vertex -- a foreign-UV
  // scan passes even when a triangle is handed the wrong island's corner,
  // because that corner is still a UV the input contained.
  // The two charts are the first and second half of the vertex list. A UV that
  // occurs in both halves cannot testify either way and is skipped.
  const half = s.positions.length / 6
  const chartOf = new Map()
  for (let i = 0; i < s.positions.length / 3; i++) {
    const k = `${s.uvs[i * 2]},${s.uvs[i * 2 + 1]}`
    const chart = i < half ? 'a' : 'b'
    chartOf.set(k, chartOf.has(k) && chartOf.get(k) !== chart ? 'both' : chart)
  }
  let mixed = 0
  const seen = new Set()
  for (let f = 0; f < aware.indices.length / 3; f++) {
    const tags = new Set()
    for (let e = 0; e < 3; e++) {
      const i = aware.indices[f * 3 + e]
      tags.add(chartOf.get(`${aware.uvs[i * 2]},${aware.uvs[i * 2 + 1]}`))
    }
    for (const t of tags) seen.add(t)
    if (tags.has('a') && tags.has('b')) mixed++
  }
  // Without this the mixed count is meaningless: if the discriminator went blind
  // and tagged everything the same way, zero mixed faces proves nothing.
  check(seen.has('a') && seen.has('b'),
    'the output still carries UVs unique to each chart', [...seen].sort().join(','))
  check(mixed === 0, 'no output face mixes UVs from both charts', `${mixed} mixed faces`)
}

// --- uvMode -----------------------------------------------------------------

console.log('\nuvMode: the atlas floor and the way past it')
{
  const s = shatteredAtlas(10)
  check(countUvIslands(s) === 100, 'the fixture is one connected surface shattered into 100 UV islands', String(countUvIslands(s)))

  // 60 sits between the two floors this fixture has: 200 with the atlas kept
  // (one triangle per island) and 40 without it (the open rim is locked, and 40
  // rim vertices cannot triangulate into fewer than 38 faces). Asking below 40
  // would fail for a reason that has nothing to do with UVs.
  const kept = decimate(s, 60, { uvMode: 'preserve' })
  const dropped = decimate(s, 60, { uvMode: 'drop' })
  // The point of the mode. One island cannot go below one triangle, so an atlas
  // this fragmented is a floor no tuning moves -- and the fox stalled on exactly
  // this, at 291 of 487 triangles, whatever the weld tolerance.
  check(triCount(kept) > 60, 'preserving a shattered atlas cannot reach the target', `${triCount(kept)} triangles`)
  check(triCount(dropped) <= 60, 'dropping it reaches the target on geometry alone', `${triCount(dropped)} triangles`)

  check(dropped.uvs === null, 'a dropped tier emits no uv attribute, because its corners no longer share an atlas')
  check(dropped.sampleUvs instanceof Float32Array && dropped.sampleUvs.length === (dropped.positions.length / 3) * 2,
    'and carries one sampleUv per output vertex instead', String(dropped.sampleUvs?.length))
  check(kept.sampleUvs === null && kept.uvs instanceof Float32Array, 'a preserved tier is the other way round')
  check(kept.stats.uvMode === 'preserve' && dropped.stats.uvMode === 'drop', 'stats name the mode that ran')

  // Every sampleUv must still be a coordinate the input contained: the whole
  // value of the bake is that it reads the ORIGINAL texture at a real location.
  const before = uvSet(s)
  let foreign = 0
  for (let i = 0; i < dropped.sampleUvs.length / 2; i++) {
    const k = `${dropped.sampleUvs[i * 2].toFixed(6)},${dropped.sampleUvs[i * 2 + 1].toFixed(6)}`
    if (!before.has(k)) foreign++
  }
  check(foreign === 0, 'and every sampleUv is a texture coordinate the input had', `${foreign} foreign`)
}
{
  // Stretch: the same geometry drop reaches, but every corner keeps a UV it
  // already had, so the tier still wears the original texture. In this fixture
  // an island is one grid cell, so which island a UV belongs to is arithmetic.
  const s = shatteredAtlas(10)
  const island = (u, v) => `${Math.floor(u * 10)},${Math.floor(v * 10)}`
  const stretched = decimate(s, 60, { uvMode: 'stretch' })
  check(triCount(stretched) <= 60, 'stretching reaches the target a preserved atlas cannot', `${triCount(stretched)} triangles`)
  check(stretched.uvs instanceof Float32Array && stretched.sampleUvs === null, 'and still emits a uv attribute')
  check(stretched.stats.stretched > 0, 'having stretched at least one collapse', String(stretched.stats.stretched))
  const before = uvSet(s)
  const foreign = [...uvSet(stretched)].filter((k) => !before.has(k)).length
  check(foreign === 0, 'every output UV is a texture coordinate the input had', `${foreign} foreign`)
  let split = 0
  for (let f = 0; f < triCount(stretched); f++) {
    const ids = [0, 1, 2].map((k) => { const c = stretched.indices[f * 3 + k]; return island(stretched.uvs[c * 2], stretched.uvs[c * 2 + 1]) })
    if (ids[0] !== ids[1] || ids[1] !== ids[2]) split++
  }
  check(split === 0, 'and every output triangle\'s three UVs lie inside one input island', `${split} straddle`)
  check(degenerateCount(stretched) === 0, 'with no degenerate triangles', String(degenerateCount(stretched)))
}
{
  const s = shatteredAtlas(10)
  const easy = decimate(s, 60, { uvMode: 'auto' })
  check(easy.stats.uvMode === 'stretch', 'auto stretches the atlas when preserving cannot hit the target', easy.stats.uvMode)
  check(triCount(easy) <= 60, 'and hits it', `${triCount(easy)} triangles`)

  const g = bumpyGrid(20)
  const cheap = decimate(g, 200, { uvMode: 'auto' })
  check(cheap.stats.uvMode === 'preserve', 'and preserves it exactly when that is enough', cheap.stats.uvMode)
  check(cheap.uvs instanceof Float32Array, 'so a continuous chart still comes back textured')
}
{
  const src = shatteredAtlas(10)
  const before = uvSet(src)
  const tiers = decimateLadder(src, [140, 60], { uvMode: 'auto' })
  check(tiers.every((t) => t.stats.uvMode === 'stretch' && t.uvs instanceof Float32Array), 'every tier of a shattered ladder stays textured',
    tiers.map((t) => t.stats.uvMode).join(' -> '))
  check([...uvSet(tiers[1])].every((k) => before.has(k)), 'and the coarsest tier\'s UVs all come from the source')
  check(triCount(tiers[1]) <= 60, 'the coarsest tier reaches its target', `${triCount(tiers[1])} triangles`)

  // Chaining is where sample coordinates are easiest to mistake for an atlas:
  // tier 2 sees a mesh with no uvs and must not promote sampleUvs into the slot.
  const dropped = decimateLadder(src, [140, 60], { uvMode: 'drop' })
  check(dropped.every((t) => t.uvs === null && t.sampleUvs), 'a drop ladder never re-emits sample coordinates as an atlas')
}
check(throws(() => decimate(grid(4), 4, { uvMode: 'sometimes' })), 'an unknown uvMode throws rather than guessing')

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
  const out = decimate(cube, 1, { dropIslands: false })
  check(triCount(out) === 4, 'an all-boundary mesh refuses to reduce', `${triCount(out)} triangles`)
  const culled = decimate(cube, 1)
  check(triCount(culled) === 2 && culled.stats.piecesDropped === 1, 'unless a whole detached piece can go', `${triCount(culled)} triangles`)
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
  check(a.freePoints + a.seamPoints + a.lockedPoints === a.points, 'free, seam and locked account for every point')
  check(a.seamPoints === 0, 'a single-chart grid has no seam points', String(a.seamPoints))
  check(a.uvIslands === 1, 'reports the island count')
  // A grid's four corner triangles have all three vertices on the rim, so a
  // small non-zero floor is correct. It should stay small.
  check(a.lockedFaces > 0 && a.lockedFaces < a.tris * 0.1,
    'a grid has a small floor of fully-pinned faces at its corners', `${a.lockedFaces} of ${a.tris}`)
}

// --- silhouette -------------------------------------------------------------

console.log('\nsmall features survive a hard decimation')
{
  const { mesh, tips } = earedBall()
  const full = tips.map((t) => support(mesh, t))
  // 40 triangles out of 360 -- past the point where a plain quadric has eaten the
  // ears, and about where a creature's coarsest LOD tier lands.
  const kept = decimate(mesh, 40, { uvMode: 'drop' })
  const reach = tips.map((t, i) => support(kept, t) / full[i])
  check(reach.every((r) => r > 0.9), 'at 40 triangles a ball still reaches the tip of both its ears', reach.map((r) => r.toFixed(2)).join(' '))

  // The same run with every point term switched off, so the check names the
  // mechanism it is guarding rather than just asserting a good number.
  const flat = decimate(mesh, 40, { uvMode: 'drop', featureWeight: 0, sizeWeight: 0, shapeWeight: 0 })
  const flatReach = tips.map((t, i) => support(flat, t) / full[i])
  check(flatReach.some((r) => r < 0.75), 'and a plain area-weighted quadric lops them off', flatReach.map((r) => r.toFixed(2)).join(' '))

  check(triCount(kept) === triCount(flat), 'the ears are kept at the same triangle count, not by stopping early',
    `${triCount(kept)} vs ${triCount(flat)}`)
}

console.log('\ncoarse triangles keep their proportions')
{
  // A bumpy grid to 15%: a plane quadric alone spends the budget on the bumps
  // and leaves the flat between them as long slivers. The size and shape terms
  // are what make the collapses spread out and stay well-shaped.
  const g = bumpyGrid(20)
  const shaped = triQualities(decimate(g, 120, { uvMode: 'drop' }))
  const plain = triQualities(decimate(g, 120, { uvMode: 'drop', sizeWeight: 0, shapeWeight: 0 }))
  const mean = (qs) => qs.reduce((a, b) => a + b, 0) / qs.length
  const slivers = (qs) => qs.filter((q) => q < 0.5).length
  check(mean(shaped) > mean(plain) + 0.05, 'at 120 triangles the mean triangle quality is higher with the size and shape terms',
    `${mean(shaped).toFixed(3)} vs ${mean(plain).toFixed(3)}`)
  check(slivers(shaped) < slivers(plain) * 0.75, 'and there are fewer triangles worse than 3:1', `${slivers(shaped)} vs ${slivers(plain)}`)
}

// --- detached pieces --------------------------------------------------------

console.log('\ndetached pieces go before the body does')
{
  // A big body, one medium piece and six specks, all far enough apart that no
  // weld joins them.
  const specks = Array.from({ length: 6 }, (_, i) => ({ size: 0.05, at: [8 + i * 0.5, 0, 0] }))
  const medium = { size: 1.5, at: [-9, 0, 0] }
  const mesh = bodyWithTets(5.7, [medium, ...specks])
  const a = analyzeMesh(mesh)
  check(a.pieces === 8 && a.minorFaces === 28, 'analyzeMesh counts the pieces and the faces off the main one', `${a.pieces} pieces, ${a.minorFaces} faces`)

  // 24 = the body plus the medium piece: the specks must go and nothing else.
  // Whether a speck is deleted whole or folds away edge by edge is a tie
  // between two near-zero costs, so these check what is left, not which path
  // took it.
  const some = decimate(mesh, 24)
  check(analyzeMesh(some).pieces === 2 && triCount(some) === 24, 'the smallest pieces go first', `${analyzeMesh(some).pieces} pieces, ${triCount(some)} triangles`)
  check(support(some, [-1, 0, 0]) >= 9, 'and the medium piece is still standing', support(some, [-1, 0, 0]).toFixed(2))

  const body = boundsOf(icosahedron()).map((v) => v * 5.7)
  const all = decimate(mesh, 20)
  check(analyzeMesh(all).pieces === 1 && triCount(all) === 20, 'at the body\'s own count every other piece is gone', `${analyzeMesh(all).pieces} pieces, ${triCount(all)} triangles`)
  check(boundsOf(all).every((v, k) => Math.abs(v - body[k]) < 1e-5), 'and the body itself is untouched')

  const floor = decimate(mesh, 1)
  check(triCount(floor) > 0 && analyzeMesh(floor).pieces === 1, 'the largest piece is never deleted, however low the target', `${triCount(floor)} triangles`)

  const kept = decimate(mesh, 20, { dropIslands: false })
  check(kept.stats.piecesDropped === 0 && analyzeMesh(kept).pieces === 1 && boundsOf(kept).every((v, k) => Math.abs(v - body[k]) < 1e-5),
    'dropIslands:false deletes nothing whole; the tetrahedra still fold away before the body pays', `${triCount(kept)} triangles`)
}

console.log('\na ridge of pillows folds away')
{
  // Eight pillows -- two faces back to back on three points -- chained along a
  // line by shared base points, floating over a body. Each has one vertex
  // opposite its base edge, not two, and the link condition must allow that
  // or the ridge can never lose a triangle.
  const positions = [], indices = []
  const ico = icosahedron()
  positions.push(...Array.from(ico.positions, (x) => x * 5))
  indices.push(...ico.indices)
  const N = 8, base = 12
  for (let i = 0; i <= N; i++) positions.push(i * 0.4, 10, 0)
  for (let i = 0; i < N; i++) {
    positions.push(i * 0.4 + 0.2, 10.5, 0)
    const q = base + N + 1 + i
    indices.push(base + i, base + i + 1, q, base + i + 1, base + i, q)
  }
  const mesh = { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), uvs: null }
  check(analyzeMesh(mesh).pieces === 2 && triCount(mesh) === 20 + 2 * N, 'the ridge is one piece of 16 triangles')
  const out = decimate(mesh, 20, { dropIslands: false })
  check(triCount(out) === 20 && analyzeMesh(out).pieces === 1 && support(out, [0, 1, 0]) < 9,
    'and is gone at the body\'s own count with deletion off', `${triCount(out)} triangles, reaches y=${support(out, [0, 1, 0]).toFixed(2)}`)
  const one = decimate({ positions: mesh.positions.slice(base * 3), indices: Uint32Array.from(indices.slice(60).map((i) => i - base)) }, 1)
  check(triCount(one) === 2, 'a lone pillow ridge stops at one pillow rather than emptying the mesh', `${triCount(one)} triangles`)
}

// --- failure modes ----------------------------------------------------------

console.log('\nloud failures')
check(throws(() => decimate({ indices: Uint32Array.from([0, 1, 2]) }, 1)), 'missing positions throws')
check(throws(() => decimate(grid(4), 0)), 'a zero target throws rather than emptying the mesh')
check(throws(() => decimate(grid(4), -5)), 'a negative target throws')
check(throws(() => decimate(grid(4), NaN)), 'a NaN target throws')

console.log(`\n${failures === 0 ? 'all decimate checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
