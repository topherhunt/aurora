// ---------------------------------------------------------------------------
// Seam-locked quadric edge-collapse decimation, for generating LOD tiers from a
// mesh this project did not author -- a Tripo creature, principally, where the
// mesh arrives at whatever density the vendor felt like and has to be brought
// down to something src/budget.js will tolerate.
//
// Three-free and plain-array in, plain-array out, so it runs in node under a
// gate and in the browser in gen-creature.html from the same source.
//
// Design doc: design/27-creature-pipeline.md, "Stage 3b: the LOD ladder is ours".
//
// WHY NOT three's SimplifyModifier. It carries `uv` through, so it looks like it
// works. But its collapse cost is `edgelength * curvature` -- purely geometric,
// with no attribute term -- and its border protection is commented out in the
// source. Nothing in it knows a UV seam exists, so it will collapse across one
// and then copy one endpoint's UV onto the other, dragging texture coordinates
// across an island boundary. On a 128px texture that is not a subtle artifact:
// it swaps which part of the atlas a triangle samples.
//
// THE ONE RULE: no vertex attribute is ever interpolated or invented. Every UV
// in the output is a UV that was in the input, on a triangle that could already
// reach it. Nothing below ever computes a new texture coordinate.
//
// What DOES vary is whether the vendor's atlas is kept at all -- `uvMode`:
//
//   'preserve'  Keep it. A seam vertex is collapsible, but only into a vertex
//     carrying a matching wedge on every face involved; `wedgeMap` decides that
//     per edge. Because the correspondence is read off faces that already
//     contain both endpoints, every rewritten corner moves along an edge of an
//     existing atlas triangle -- island outlines shrink, no triangle jumps to
//     unrelated texture. Only boundary and non-manifold points are pinned.
//
//   'drop'  Give it up. Topology is built from positions alone, so the whole
//     mesh is free and reduction is bounded only by geometry. The output has NO
//     `uv`; it carries `sampleUvs` instead -- per vertex, where in the original
//     texture that point sat -- which is what the caller bakes into vertex
//     colours. Neighbouring corners can come from unrelated islands, so these
//     are not atlas coordinates and must never be handed to a sampler.
//
//   'auto'  Try 'preserve'; use 'drop' only for a tier it could not reach.
//
// WHY 'drop' HAD TO EXIST. Preserving a shattered atlas puts a hard floor on
// reduction at roughly one triangle per UV island, and no algorithm gets under
// it: a one-triangle island cannot be reduced. A Tripo P1 fox came back as 112
// islands across 487 triangles, 76 of those islands three triangles or fewer,
// and stalled at 291. The same 487 triangles reach 49 on geometry alone. A
// far-LOD creature does not need the vendor's atlas -- at that range it needs a
// silhouette and a handful of colours -- so the coarse tiers stop carrying one.
//
// `analyzeMesh` reports free, seam and locked points apart, so the bench can say
// which kind of mesh it is holding before deciding.
// ---------------------------------------------------------------------------

const EPS = 1e-12

// How hard a point that draws the outline resists being dragged off it, against
// the surface's own average error. Zero is plain Garland-Heckbert. Swept over
// eleven creature meshes in scripts/probe-decimate-profile.mjs: the curve is a
// broad plateau from about 0.5 to 1.5 and this sits in the middle of it, so the
// exact figure is not load-bearing. See the feature term in `decimate`.
const FEATURE_WEIGHT = 1

// Directions sampled to find the points that draw the outline. The same sweep
// shows 32 through 256 all land inside each other's noise, so this is a floor on
// "enough", not a tuned number. Costs one pass over the points per direction.
const PROFILE_DIRECTIONS = 64

// --- quadrics ---------------------------------------------------------------
//
// Garland-Heckbert: the error of a point against a plane is (n.p + d)^2, which
// is a quadratic form v^T K v with K the outer product of (a,b,c,d). Summing K
// over the faces around a vertex gives one 4x4 that answers "how far from all of
// this vertex's original planes is this position", and the sum survives a
// collapse -- which is the whole trick. Stored as 10 floats, the upper triangle.

function planeQuadric(ax, ay, az, bx, by, bz, cx, cy, cz, Q, o, n) {
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az)
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const len = Math.hypot(nx, ny, nz)
  if (len < EPS) { for (let i = 0; i < 10; i++) Q[o + i] = 0; return 0 }
  // Area-weighted, so a large flat face argues harder than a sliver. Unweighted
  // quadrics let a fan of degenerate triangles outvote the surface they sit on.
  const w = len * 0.5
  nx /= len; ny /= len; nz /= len
  const d = -(nx * ax + ny * ay + nz * az)
  Q[o] = nx * nx * w; Q[o + 1] = nx * ny * w; Q[o + 2] = nx * nz * w; Q[o + 3] = nx * d * w
  Q[o + 4] = ny * ny * w; Q[o + 5] = ny * nz * w; Q[o + 6] = ny * d * w
  Q[o + 7] = nz * nz * w; Q[o + 8] = nz * d * w
  Q[o + 9] = d * d * w
  // The unit normal, for callers measuring how much the surface turns at a point.
  if (n) { n[0] = nx; n[1] = ny; n[2] = nz }
  return w
}

/**
 * The quadric of a POINT rather than a plane: w * |x - p|^2, the squared
 * distance travelled away from p, weighted by w. Same 10-float form, so it adds
 * straight into a vertex's plane quadric and rides through every collapse the
 * way the rest of the sum does.
 *
 * A plane quadric is blind along its own plane, which is exactly the direction a
 * thin feature runs: around a fox's ear tip every face is nearly parallel to the
 * ear, so sliding the tip down to the ear's base barely leaves any of those
 * planes and barely registers. This is the term that notices.
 */
function pointQuadric(px, py, pz, w, Q, o) {
  Q[o] = w; Q[o + 1] = 0; Q[o + 2] = 0; Q[o + 3] = -w * px
  Q[o + 4] = w; Q[o + 5] = 0; Q[o + 6] = -w * py
  Q[o + 7] = w; Q[o + 8] = -w * pz
  Q[o + 9] = w * (px * px + py * py + pz * pz)
}

function quadricError(Q, o, x, y, z) {
  return (
    Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x +
    Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y +
    Q[o + 7] * z * z + 2 * Q[o + 8] * z +
    Q[o + 9]
  )
}

// --- topology ---------------------------------------------------------------

/**
 * A glTF mesh stores a UV seam as two vertices at the same position carrying
 * different texture coordinates, so the index buffer alone does not describe the
 * surface's connectivity -- it describes the connectivity of the *atlas*. This
 * welds by position to recover the real surface, then works out which of those
 * welded points are pinned.
 *
 * Two separate classifications come out of this, and the difference is the
 * whole reason a shattered atlas can still decimate:
 *
 *   LOCKED -- touches an edge used by 1 face (open boundary) or by 3+
 *     (non-manifold). Never collapsible; there is no defined answer.
 *   SEAM -- its corners disagree about UV. Collapsible, but only into another
 *     point that carries a matching wedge on every face involved. `wedgeMap`
 *     in `decimate` is what decides that, per candidate edge.
 *
 * `uvId` gives each distinct UV value a dense integer, so a corner's wedge is
 * one array lookup rather than a string key rebuilt per collapse.
 */
export function buildTopology({ positions, uvs, indices }, { weldEps } = {}) {
  const vertexCount = positions.length / 3
  const faceCount = indices.length / 3

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const eps = weldEps ?? diag * 1e-6

  const pointOf = new Int32Array(vertexCount).fill(-1)
  const byKey = new Map()
  const pointPos = []
  const rep = []
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2]
    const key = `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`
    let p = byKey.get(key)
    if (p === undefined) {
      p = rep.length
      byKey.set(key, p)
      pointPos.push(x, y, z)
      rep.push(i)
    }
    pointOf[i] = p
  }
  const pointCount = rep.length

  // UV disagreement -> seam. Without UVs every corner is the same wedge, which
  // makes the wedge machinery downstream a no-op rather than a special case.
  const locked = new Uint8Array(pointCount)
  const seam = new Uint8Array(pointCount)
  const uvId = new Int32Array(vertexCount)
  if (uvs) {
    const ids = new Map()
    const firstId = new Int32Array(pointCount).fill(-1)
    for (let i = 0; i < vertexCount; i++) {
      const k = `${Math.round(uvs[i * 2] / 1e-6)},${Math.round(uvs[i * 2 + 1] / 1e-6)}`
      let uid = ids.get(k)
      if (uid === undefined) { uid = ids.size; ids.set(k, uid) }
      uvId[i] = uid
      const p = pointOf[i]
      if (firstId[p] === -1) firstId[p] = uid
      else if (firstId[p] !== uid) seam[p] = 1
    }
  }

  // Edge use counts -> boundary and non-manifold.
  const faces = new Int32Array(faceCount * 3)
  for (let f = 0; f < faceCount * 3; f++) faces[f] = pointOf[indices[f]]
  const edgeUse = new Map()
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1)
    }
  }
  for (const [k, n] of edgeUse) {
    if (n === 2) continue
    const [u, v] = k.split('_')
    locked[+u] = 1
    locked[+v] = 1
  }

  return { pointOf, pointPos: Float64Array.from(pointPos), locked, seam, uvId, pointCount, faces, faceCount, eps, diag }
}

/**
 * Connected components of the UV atlas. This is the number the 128px downrez
 * actually cares about: an atlas of 8 large islands keeps its gutters at 128px,
 * one of 300 small islands does not, and no triangle count distinguishes them.
 * Two faces are in the same island when they share an edge AND agree on that
 * edge's texture coordinates.
 */
export function countUvIslands({ positions, uvs, indices }) {
  if (!uvs) return 0
  const faceCount = indices.length / 3
  const parent = new Int32Array(faceCount)
  for (let i = 0; i < faceCount; i++) parent[i] = i
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }

  // Key an edge by its two vertices' UVs rather than by vertex index: that is
  // what makes a seam register as two separate edges instead of one shared one.
  const uvAt = (i) => `${Math.round(uvs[i * 2] / 1e-6)},${Math.round(uvs[i * 2 + 1] / 1e-6)}`
  const byEdge = new Map()
  for (let f = 0; f < faceCount; f++) {
    const c = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]]
    for (let e = 0; e < 3; e++) {
      const k1 = uvAt(c[e]), k2 = uvAt(c[(e + 1) % 3])
      const k = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`
      const prev = byEdge.get(k)
      if (prev === undefined) byEdge.set(k, f)
      else union(prev, f)
    }
  }
  const roots = new Set()
  for (let f = 0; f < faceCount; f++) roots.add(find(f))
  return roots.size
}

/**
 * Estimates what fraction of triangles came from quads, by finding interior
 * edges whose two faces are close enough to coplanar to be a quad's diagonal and
 * greedily pairing them.
 *
 * HEURISTIC, and reported as one. glTF has no quad primitive -- mode 4 is
 * TRIANGLES and there is no quad mode -- so a GLB is always triangulated on
 * arrival and the only trace quad generation leaves is this pairing. A dense
 * smooth mesh will also show coplanar neighbours, so the number means something
 * on a low-poly mesh and very little on a high-poly one.
 */
export function estimateQuadFraction({ positions, indices }, cosTol = 0.9995) {
  const faceCount = indices.length / 3
  if (faceCount === 0) return 0
  const nx = new Float64Array(faceCount), ny = new Float64Array(faceCount), nz = new Float64Array(faceCount)
  for (let f = 0; f < faceCount; f++) {
    const a = indices[f * 3] * 3, b = indices[f * 3 + 1] * 3, c = indices[f * 3 + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const len = Math.hypot(x, y, z) || 1
    nx[f] = x / len; ny[f] = y / len; nz[f] = z / len
  }

  const byEdge = new Map()
  for (let f = 0; f < faceCount; f++) {
    const c = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]]
    for (let e = 0; e < 3; e++) {
      const u = c[e], v = c[(e + 1) % 3]
      const k = u < v ? `${u}_${v}` : `${v}_${u}`
      const prev = byEdge.get(k)
      if (prev === undefined) byEdge.set(k, f)
      else byEdge.set(k, [prev, f])
    }
  }

  const pairs = []
  for (const val of byEdge.values()) {
    if (!Array.isArray(val)) continue
    const [f, g] = val
    const dot = nx[f] * nx[g] + ny[f] * ny[g] + nz[f] * nz[g]
    if (dot >= cosTol) pairs.push([dot, f, g])
  }
  pairs.sort((a, b) => b[0] - a[0])
  const taken = new Uint8Array(faceCount)
  let paired = 0
  for (const [, f, g] of pairs) {
    if (taken[f] || taken[g]) continue
    taken[f] = 1; taken[g] = 1
    paired += 2
  }
  return paired / faceCount
}

/** Everything the bench wants to say about a mesh before touching it. */
export function analyzeMesh(mesh, { weldEps } = {}) {
  const topo = buildTopology(mesh, { weldEps })
  let lockedPoints = 0
  let seamPoints = 0
  for (let p = 0; p < topo.pointCount; p++) {
    if (topo.locked[p]) lockedPoints++
    else if (topo.seam[p]) seamPoints++
  }
  let lockedFaces = 0
  for (let f = 0; f < topo.faceCount; f++) {
    const a = topo.faces[f * 3], b = topo.faces[f * 3 + 1], c = topo.faces[f * 3 + 2]
    if (topo.locked[a] && topo.locked[b] && topo.locked[c]) lockedFaces++
  }
  return {
    tris: topo.faceCount,
    vertices: mesh.positions.length / 3,
    points: topo.pointCount,
    lockedPoints,
    // Seam points are not free -- a collapse across one needs a matching wedge
    // on both ends -- but they are not pinned either. A mesh that is mostly
    // seam decimates worse than one that is mostly interior, and reporting the
    // two apart is what tells a shattered atlas from a genuinely dense mesh.
    seamPoints,
    freePoints: topo.pointCount - lockedPoints - seamPoints,
    // Faces pinned at all three corners can never be removed, whatever target is
    // asked for. This is the honest floor on what decimation can achieve here.
    lockedFaces,
    uvIslands: countUvIslands(mesh),
    quadFraction: estimateQuadFraction(mesh),
  }
}

// --- the heap ---------------------------------------------------------------

class MinHeap {
  constructor() { this.a = [] }
  get size() { return this.a.length }
  push(item) {
    const a = this.a
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].cost <= a[i].cost) break
      const t = a[p]; a[p] = a[i]; a[i] = t
      i = p
    }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].cost < a[m].cost) m = l
        if (r < a.length && a[r].cost < a[m].cost) m = r
        if (m === i) break
        const t = a[m]; a[m] = a[i]; a[i] = t
        i = m
      }
    }
    return top
  }
}

// --- decimation -------------------------------------------------------------

/**
 * Reduces `mesh` toward `targetTris` by half-edge collapse.
 *
 * HALF-EDGE, not the general form: the surviving vertex stays exactly where it
 * was rather than moving to an optimal position. That costs a little geometric
 * accuracy and buys the thing that matters here -- no vertex attribute is ever
 * interpolated or invented, so every UV in the output is a UV that was in the
 * input. A decimator that computes new texture coordinates is a decimator that
 * can put them in the wrong island.
 *
 * `mesh` is `{ positions, uvs?, sampleUvs?, normals?, indices }` of plain arrays.
 * Returns the same shape plus `stats`. `uvMode` decides whether the atlas is
 * kept -- see the module header; a tier built with 'drop' comes back with `uvs`
 * null and `sampleUvs` filled, and feeding it straight back in works, which is
 * what lets `decimateLadder` chain coarse tiers.
 *
 * `weldEps` is the distance under which two vertices are the same point,
 * defaulting to a millionth of the bounding diagonal -- enough to fuse the
 * duplicated vertices a glTF seam is made of and nothing else. Raising it fuses
 * genuinely distinct geometry, which on a thin-featured mesh makes edges
 * non-manifold and PINS them: on the fox, 2% of the diagonal locked 42 points
 * and cost more reduction than it bought.
 */
export function decimate(mesh, targetTris, opts = {}) {
  const { flipTolerance = 0.2, weldEps, seamCollapse = true, uvMode = 'preserve', featureWeight = FEATURE_WEIGHT } = opts
  const { positions, uvs, normals, indices } = mesh
  if (!positions || !indices) throw new Error('decimate requires positions and indices')
  if (!Number.isFinite(targetTris) || targetTris < 1) throw new Error(`decimate requires a positive targetTris, got ${targetTris}`)
  if (!['preserve', 'drop', 'auto'].includes(uvMode)) throw new Error(`unknown uvMode "${uvMode}" -- want preserve, drop or auto`)

  // Cheapest tier that works: keep the atlas if it can reach the target, and
  // only give it up when it demonstrably cannot. Which one ran is in the stats,
  // because the two answers are not interchangeable downstream.
  if (uvMode === 'auto') {
    const kept = decimate(mesh, targetTris, { ...opts, uvMode: 'preserve' })
    return kept.stats.outputTris <= targetTris ? kept : decimate(mesh, targetTris, { ...opts, uvMode: 'drop' })
  }

  // An input carrying `sampleUvs` instead of `uvs` has already had its atlas
  // dropped by an earlier tier. Preserving is then not a choice on offer, and
  // saying it happened would put a `uv` attribute back on a mesh whose corners
  // come from unrelated islands.
  const keepAtlas = uvMode === 'preserve' && Boolean(uvs)
  const topo = buildTopology(keepAtlas ? mesh : { positions, indices }, { weldEps })
  const { pointPos, locked, seam, uvId, pointCount, faceCount } = topo

  // Working copies -- faces in point space, and the original corner each face
  // slot still refers to. An untouched slot keeps its original corner, so its
  // attributes come through exactly.
  const facePoints = Int32Array.from(topo.faces)
  const faceCorners = Int32Array.from(indices)
  const faceAlive = new Uint8Array(faceCount).fill(1)
  const removed = new Uint8Array(pointCount)
  const version = new Int32Array(pointCount)

  const facesAt = Array.from({ length: pointCount }, () => new Set())
  const neighbours = Array.from({ length: pointCount }, () => new Set())
  for (let f = 0; f < faceCount; f++) {
    const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
    facesAt[a].add(f); facesAt[b].add(f); facesAt[c].add(f)
    neighbours[a].add(b); neighbours[a].add(c)
    neighbours[b].add(a); neighbours[b].add(c)
    neighbours[c].add(a); neighbours[c].add(b)
  }

  const Q = new Float64Array(pointCount * 10)
  const fq = new Float64Array(10)
  const fn = new Float64Array(3)
  // Per point: the area around it, and the area-weighted sum of its face normals
  // kept UNNORMALISED, because the length that sum loses is the measurement.
  const mass = new Float64Array(pointCount)
  const normalSum = new Float64Array(pointCount * 3)
  let totalArea = 0
  for (let f = 0; f < faceCount; f++) {
    const a = facePoints[f * 3] * 3, b = facePoints[f * 3 + 1] * 3, c = facePoints[f * 3 + 2] * 3
    const area = planeQuadric(
      pointPos[a], pointPos[a + 1], pointPos[a + 2],
      pointPos[b], pointPos[b + 1], pointPos[b + 2],
      pointPos[c], pointPos[c + 1], pointPos[c + 2],
      fq, 0, fn,
    )
    totalArea += area
    for (const p of [facePoints[f * 3], facePoints[f * 3 + 1], facePoints[f * 3 + 2]]) {
      for (let i = 0; i < 10; i++) Q[p * 10 + i] += fq[i]
      mass[p] += area
      normalSum[p * 3] += fn[0] * area
      normalSum[p * 3 + 1] += fn[1] * area
      normalSum[p * 3 + 2] += fn[2] * area
    }
  }

  // --- the feature term -----------------------------------------------------
  //
  // What kills a fox's ears is not the quadric being wrong, it is the quadric
  // being AREA-WEIGHTED. An ear carries about one percent of the fox's surface,
  // so every collapse inside it is priced at about one percent of a collapse
  // across the flank, and the ears are gone long before the torso has given up
  // anything. Small features are cheap in proportion to how small they are,
  // which is the opposite of what a silhouette wants.
  //
  // So each point gets a second quadric that does NOT scale with its own area: a
  // point quadric of weight `featureWeight * importance * meanMass`, where
  // meanMass is one point's share of the whole surface. Every point then resists
  // being dragged by the same absolute amount, and `importance` -- how hard the
  // surface turns there, plus one if the point draws the outline -- decides how
  // much it cares.
  //
  //   turn = 1 - |sum of area-weighted face normals| / (area at the point)
  //
  // Zero where the surface is flat, whatever its area -- the normals add up to
  // their own total length and cancel nothing. Near one at an ear tip, where they
  // fan out around the cone, and near one in the notch BETWEEN the ears, where
  // they oppose each other. Both of those matter: lopping the ears off and
  // welding the gap between them shut are the same failure seen twice, and a
  // measure of how hard the surface turns catches them both without needing to
  // know which way it turned.
  //
  // Flat regions are left almost alone, so this costs the smooth majority of the
  // mesh nothing -- it only makes the few places that draw the outline expensive.
  //
  // `turn` says where the surface bends, which is where an outline can be. The
  // second half says where one IS. A point that is the furthest thing in some
  // direction is on the silhouette from every view square to that direction --
  // that is what a silhouette is -- so sampling directions over the sphere and
  // marking the extreme point in each one picks out the nose, the ear tips, the
  // toes, the tail, the ridge of the back, and nothing in the middle of a flank.
  // A point can be extreme in many directions at once and it counts once: this is
  // a question with a yes or no answer, not a vote.
  const meanMass = pointCount ? (3 * totalArea) / pointCount : 0
  if (featureWeight > 0 && meanMass > 0) {
    const extreme = new Uint8Array(pointCount)
    for (let d = 0; d < PROFILE_DIRECTIONS; d++) {
      // Fibonacci sphere -- an even spread with no clustering at the poles, which
      // a lat/long grid would give and which would over-sample up and down.
      const z = 1 - (2 * d + 1) / PROFILE_DIRECTIONS
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const theta = d * Math.PI * (3 - Math.sqrt(5))
      const dx = Math.cos(theta) * r, dy = Math.sin(theta) * r, dz = z
      let best = -Infinity, at = -1
      for (let p = 0; p < pointCount; p++) {
        const s = dx * pointPos[p * 3] + dy * pointPos[p * 3 + 1] + dz * pointPos[p * 3 + 2]
        if (s > best) { best = s; at = p }
      }
      if (at >= 0) extreme[at] = 1
    }
    for (let p = 0; p < pointCount; p++) {
      if (mass[p] < EPS) continue
      const turn = 1 - Math.hypot(normalSum[p * 3], normalSum[p * 3 + 1], normalSum[p * 3 + 2]) / mass[p]
      const importance = Math.max(0, turn) + extreme[p]
      if (importance <= 0) continue
      pointQuadric(pointPos[p * 3], pointPos[p * 3 + 1], pointPos[p * 3 + 2], featureWeight * importance * meanMass, fq, 0)
      for (let i = 0; i < 10; i++) Q[p * 10 + i] += fq[i]
    }
  }

  // Cost of removing u by merging it into v, evaluated at v's own position.
  const sumQ = new Float64Array(10)
  const costOf = (u, v) => {
    const o = v * 3
    const a = u * 10, b = v * 10
    for (let i = 0; i < 10; i++) sumQ[i] = Q[a + i] + Q[b + i]
    const e = quadricError(sumQ, 0, pointPos[o], pointPos[o + 1], pointPos[o + 2])
    // Clamped at zero: the form is a sum of squared distances and can only go
    // negative through float cancellation, which would sort as the best edge.
    return e < 0 ? 0 : e
  }

  const heap = new MinHeap()
  const pushEdge = (u, v) => {
    // Geometric boundary and non-manifold points are pinned outright. Seam
    // points are not -- whether a particular seam collapse is legal depends on
    // the edge, and `wedgeMap` decides it when the edge comes off the heap.
    if (locked[u] || locked[v]) return
    if (!seamCollapse && (seam[u] || seam[v])) return
    heap.push({ cost: costOf(u, v), u, v, stamp: version[u] + version[v] })
  }
  for (let u = 0; u < pointCount; u++) {
    if (locked[u]) continue
    for (const v of neighbours[u]) pushEdge(u, v)
  }

  /**
   * Which corner of v each wedge of u becomes, or null if the collapse has no
   * consistent answer.
   *
   * A point on a UV seam carries several corners -- one per island meeting
   * there -- and merging u into v has to send each of u's corners to the corner
   * of v in the SAME island. The correspondence is read off the faces that
   * contain both u and v: such a face names one corner of each, and they are by
   * construction in the same island.
   *
   * That sourcing is also what bounds the damage. Every rewritten corner moves
   * along one edge of a triangle that already existed in the atlas, so a
   * collapse can shorten an island outline but can never stretch a triangle
   * across the atlas into unrelated texture.
   *
   * Two ways to have no answer, both rejected:
   *   - the shared faces disagree about where one wedge of u should go (the
   *     edge is itself a seam and v's islands do not line up with u's)
   *   - some face at u carries a wedge the shared faces never mentioned, so
   *     there is no corner of v to give it
   */
  const wedgeMap = (u, v) => {
    const map = new Map()
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      let su = -1, sv = -1
      for (let s = 0; s < 3; s++) {
        const p = facePoints[f * 3 + s]
        if (p === u) su = s
        else if (p === v) sv = s
      }
      if (su < 0 || sv < 0) continue
      const wu = uvId[faceCorners[f * 3 + su]]
      const cv = faceCorners[f * 3 + sv]
      const prev = map.get(wu)
      if (prev !== undefined && uvId[prev] !== uvId[cv]) return null
      if (prev === undefined) map.set(wu, cv)
    }
    if (map.size === 0) return null
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      let su = -1, hasV = false
      for (let s = 0; s < 3; s++) {
        const p = facePoints[f * 3 + s]
        if (p === u) su = s
        else if (p === v) hasV = true
      }
      if (hasV || su < 0) continue
      if (!map.has(uvId[faceCorners[f * 3 + su]])) return null
    }
    return map
  }

  /**
   * A collapse is legal only if u and v share exactly the two vertices opposite
   * their shared edge. More than two means the collapse would weld together
   * parts of the surface that only meet in the index buffer, and the result is a
   * non-manifold pinch that no later step can undo.
   */
  const linkConditionOk = (u, v) => {
    let shared = 0
    for (const n of neighbours[u]) if (neighbours[v].has(n)) shared++
    return shared === 2
  }

  const wouldFlip = (u, v) => {
    const vo = v * 3
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
      if (a === v || b === v || c === v) continue // dies in the collapse
      const p = [a, b, c].map((q) => (q === u ? vo : q * 3))
      const [o0, o1, o2] = p
      const ux = pointPos[o1] - pointPos[o0], uy = pointPos[o1 + 1] - pointPos[o0 + 1], uz = pointPos[o1 + 2] - pointPos[o0 + 2]
      const vx = pointPos[o2] - pointPos[o0], vy = pointPos[o2 + 1] - pointPos[o0 + 1], vz = pointPos[o2 + 2] - pointPos[o0 + 2]
      let nx2 = uy * vz - uz * vy, ny2 = uz * vx - ux * vz, nz2 = ux * vy - uy * vx
      const len2 = Math.hypot(nx2, ny2, nz2)
      if (len2 < EPS) return true // collapsed to a sliver
      const ao = a * 3, bo = b * 3, co = c * 3
      const ux0 = pointPos[bo] - pointPos[ao], uy0 = pointPos[bo + 1] - pointPos[ao + 1], uz0 = pointPos[bo + 2] - pointPos[ao + 2]
      const vx0 = pointPos[co] - pointPos[ao], vy0 = pointPos[co + 1] - pointPos[ao + 1], vz0 = pointPos[co + 2] - pointPos[ao + 2]
      let nx1 = uy0 * vz0 - uz0 * vy0, ny1 = uz0 * vx0 - ux0 * vz0, nz1 = ux0 * vy0 - uy0 * vx0
      const len1 = Math.hypot(nx1, ny1, nz1) || 1
      const dot = (nx1 * nx2 + ny1 * ny2 + nz1 * nz2) / (len1 * len2)
      if (dot < flipTolerance) return true
    }
    return false
  }

  let liveFaces = faceCount
  let collapses = 0
  let reason = 'reached target'

  while (liveFaces > targetTris) {
    if (heap.size === 0) { reason = 'ran out of legal collapses -- the rest of the mesh is seam or boundary'; break }
    const e = heap.pop()
    const { u, v } = e
    if (removed[u] || removed[v]) continue
    if (locked[u] || locked[v]) continue
    if (!neighbours[u].has(v)) continue
    if (e.stamp !== version[u] + version[v]) { pushEdge(u, v); continue } // stale cost
    if (!linkConditionOk(u, v)) continue
    if (wouldFlip(u, v)) continue
    // Read the correspondence before anything is retired -- it is sourced from
    // exactly the faces the collapse is about to kill.
    const wedges = wedgeMap(u, v)
    if (!wedges) continue

    // Retire the faces on the collapsed edge.
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
      if (a === v || b === v || c === v) { faceAlive[f] = 0; liveFaces-- }
    }
    // Rewrite the rest onto v, each corner taking the corner of v that sits in
    // its own island.
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      for (let s = 0; s < 3; s++) {
        if (facePoints[f * 3 + s] === u) {
          facePoints[f * 3 + s] = v
          faceCorners[f * 3 + s] = wedges.get(uvId[faceCorners[f * 3 + s]])
        }
      }
      facesAt[v].add(f)
    }

    for (const n of neighbours[u]) {
      if (n === v) continue
      neighbours[n].delete(u)
      neighbours[n].add(v)
      neighbours[v].add(n)
      version[n]++
    }
    neighbours[v].delete(u)
    removed[u] = 1
    version[u]++
    version[v]++
    for (let i = 0; i < 10; i++) Q[v * 10 + i] += Q[u * 10 + i]
    collapses++

    for (const n of neighbours[v]) { pushEdge(v, n); pushEdge(n, v) }
  }

  // --- rebuild --------------------------------------------------------------

  const usedCorner = new Map()
  const outIndices = []
  for (let f = 0; f < faceCount; f++) {
    if (!faceAlive[f]) continue
    const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
    if (a === b || b === c || a === c) continue // defensive: never emit a degenerate
    for (let s = 0; s < 3; s++) {
      const corner = faceCorners[f * 3 + s]
      let out = usedCorner.get(corner)
      if (out === undefined) { out = usedCorner.size; usedCorner.set(corner, out) }
      outIndices.push(out)
    }
  }

  const outVerts = usedCorner.size
  const outPositions = new Float32Array(outVerts * 3)
  // Where to sample the ORIGINAL texture for this vertex. In drop mode it is not
  // a usable atlas coordinate for the output mesh -- two corners of one triangle
  // can come from unrelated islands -- so it goes out under its own name and the
  // `uv` slot is left empty rather than filled with something that looks usable.
  const srcUv = uvs ?? mesh.sampleUvs
  const outUvs = keepAtlas && srcUv ? new Float32Array(outVerts * 2) : null
  const outSampleUvs = !keepAtlas && srcUv ? new Float32Array(outVerts * 2) : null
  const outNormals = normals ? new Float32Array(outVerts * 3) : null
  for (const [corner, out] of usedCorner) {
    // Position comes from the welded point so a rewritten face lands on the
    // surviving vertex, not on wherever its original corner used to be.
    const p = topo.pointOf[corner] * 3
    outPositions[out * 3] = pointPos[p]
    outPositions[out * 3 + 1] = pointPos[p + 1]
    outPositions[out * 3 + 2] = pointPos[p + 2]
    const uvOut = outUvs ?? outSampleUvs
    if (uvOut) { uvOut[out * 2] = srcUv[corner * 2]; uvOut[out * 2 + 1] = srcUv[corner * 2 + 1] }
    if (outNormals) {
      outNormals[out * 3] = normals[corner * 3]
      outNormals[out * 3 + 1] = normals[corner * 3 + 1]
      outNormals[out * 3 + 2] = normals[corner * 3 + 2]
    }
  }

  const outTris = outIndices.length / 3
  return {
    positions: outPositions,
    uvs: outUvs,
    sampleUvs: outSampleUvs,
    normals: outNormals,
    indices: outVerts > 65535 ? Uint32Array.from(outIndices) : Uint16Array.from(outIndices),
    stats: {
      inputTris: faceCount,
      outputTris: outTris,
      targetTris,
      collapses,
      // What actually happened, not what was asked for -- 'auto' resolves here,
      // and so does 'preserve' on a mesh that had no atlas left to preserve.
      uvMode: keepAtlas ? 'preserve' : 'drop',
      reduction: faceCount ? 1 - outTris / faceCount : 0,
      lockedPoints: locked.reduce((s, x) => s + x, 0),
      seamPoints: seam.reduce((s, x) => s + x, 0),
      totalPoints: pointCount,
      weldedFrom: positions.length / 3,
      reason,
    },
  }
}

/**
 * Builds a whole LOD ladder in one pass, each tier decimated from the tier above
 * rather than from the original. Successive decimation is what keeps the tiers
 * nested -- a vertex present at tier 2 is present at tier 1 -- which is what
 * stops a visible pop when the renderer swaps between them.
 */
export function decimateLadder(mesh, targets, opts) {
  const sorted = [...targets].sort((a, b) => b - a)
  const tiers = []
  let current = mesh
  for (const t of sorted) {
    const out = decimate(current, t, opts)
    tiers.push(out)
    current = out
  }
  return tiers
}
