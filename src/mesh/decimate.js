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
// in the output is a UV that was in the input, and every output triangle's three
// UVs lie inside one input island. Nothing below ever computes a new texture
// coordinate. Positions are the one exception, and only in the fit pass at the
// end ("the fit" below), which slides each surviving vertex along its normal.
//
// What DOES vary is how the vendor's atlas is kept -- `uvMode`:
//
//   'preserve'  Exactly. A seam vertex is collapsible, but only into a vertex
//     carrying a matching wedge on every face involved; `wedgeMap` decides that
//     per edge. Because the correspondence is read off faces that already
//     contain both endpoints, every rewritten corner moves along an edge of an
//     existing atlas triangle -- island outlines shrink, no triangle jumps to
//     unrelated texture. Floor: about one triangle per UV island.
//
//   'stretch'  Same, but an edge with no consistent wedge map collapses anyway
//     and each surviving corner KEEPS ITS OWN UV while its position moves. The
//     UV triangle is then an input UV triangle verbatim; only the 3D triangle
//     under it changed shape, so the island's texels stretch over the new face.
//     Reduction is bounded only by geometry, the tier stays textured, and the
//     cost is texture sliding by one edge length per collapse.
//
//   'drop'  Give the atlas up. The output has NO `uv`; it carries `sampleUvs`
//     instead -- per vertex, where in the original texture that point sat --
//     which is what the caller bakes into vertex colours. Neighbouring corners
//     can come from unrelated islands, so these are not atlas coordinates.
//
//   'auto'  'preserve' where it reaches the target without reaching much
//     further up the cost order than 'stretch' would, else 'stretch'.
//
// Whatever the mode, a piece of geometry -- faces joined by manifold edges or
// shared unlocked points, `piecesOf` -- is deleted outright when that is cheaper
// than the next collapse (`dropIslands`). A Tripo mesh carries dozens of
// detached four-face tetrahedra and crests of "pillows", two faces back to back
// on three points chained by shared vertices; the fen-dragon has 46 pieces on a
// few percent of its surface, and a coarse tier that keeps every one of them has
// nothing left for the body. A pillow has one vertex opposite its base edge,
// not two, and the link condition allows that so its tip can fold in; the only
// collapse refused on that count is one that would leave no face at all.
//
// `analyzeMesh` reports free, seam and locked points apart, and how many pieces
// the mesh is in, so the bench can say which kind of mesh it is holding.
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

// How much every point resists being dragged regardless of what the surface
// does there, in the same units as the feature term. This is what makes a
// collapse across a big flat triangle cost more than one across a small flat
// triangle: a plane quadric prices both at zero. At 10 it outweighs the feature
// term outright, so the ladder is even everywhere -- the flank of a 25% tier is
// a regular lattice -- and a feature IS small triangles, so the 10% tier pays
// with its ears and its legs. Chosen by eye on the bench over the silhouette
// score; design/27-creature-pipeline.md has the numbers both ways.
const SIZE_WEIGHT = 10

// Exponent on how much worse a collapse leaves the triangles it reshapes
// (quality before / quality after, worst face). 0 ignores shape; at 1 a
// collapse that halves a triangle's quality costs double; at 2 it costs four
// times but the silhouette pays for it, same as the size term.
const SHAPE_WEIGHT = 1

// How much dearer the dearest collapse of a 'preserve' pass may be than that of
// the 'stretch' pass on the same input before 'auto' gives the atlas up.
// 'preserve' can only take the collapses the atlas allows, so on a mesh that is
// mostly seam it reaches its count by grinding down whatever is legal -- the
// leafkin's leaf loincloth went from 21 faces to 1 at the 50% tier while its
// body, 90% seam, lost a third -- and its frontier tells: over the roster a
// sane atlas reaches the target at 1.1 to 2.3 times the stretch frontier, a
// shattered one at 27 to 155. Set in the gap; nothing sits between 3.4 and 4.
const AUTO_SLACK = 3

// Mean-ratio quality of a triangle: 1 equilateral, 0 degenerate; a right
// isosceles half-square is 0.87, a 3:1 sliver about 0.5.
function triQuality(P, a, b, c) {
  const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2]
  const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2]
  const bcx = P[c] - P[b], bcy = P[c + 1] - P[b + 1], bcz = P[c + 2] - P[b + 2]
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
  const area2 = Math.hypot(nx, ny, nz)
  const sum = abx * abx + aby * aby + abz * abz + acx * acx + acy * acy + acz * acz + bcx * bcx + bcy * bcy + bcz * bcz
  return sum < EPS ? 0 : (2 * Math.sqrt(3) * area2) / sum
}

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
 *   LOCKED -- touches an edge used by 3+ faces (non-manifold), or is where
 *     two open rims meet. Never collapsible; there is no defined answer.
 *   RIM -- has exactly two edges used by one face: a simple point on an open
 *     boundary. Collapsible only along the rim, into the next rim point, so
 *     the outline shrinks by one chord and the rim stays a rim.
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

  // Edge use counts -> rim and non-manifold.
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
  const rimEdges = new Int32Array(pointCount)
  for (const [k, n] of edgeUse) {
    if (n === 2) continue
    const [u, v] = k.split('_')
    if (n === 1) { rimEdges[+u]++; rimEdges[+v]++ } else { locked[+u] = 1; locked[+v] = 1 }
  }
  const rim = new Uint8Array(pointCount)
  for (let p = 0; p < pointCount; p++) {
    if (locked[p] || rimEdges[p] === 0) continue
    if (rimEdges[p] === 2) rim[p] = 1; else locked[p] = 1
  }

  return { pointOf, pointPos: Float64Array.from(pointPos), locked, rim, seam, uvId, pointCount, faces, faceCount, eps, diag }
}

/**
 * The pieces a mesh falls into once the pins are honoured: faces joined by a
 * manifold edge or by a point that is neither locked nor rim. A detached shell
 * is a piece; so is a crest fin glued to the body along one edge, because that
 * edge carries four faces, its endpoints are pinned, and the fin's tip can
 * never collapse into anything -- the fin is immortal unless it is deleted
 * whole. Pieces only meet across pinned or rim points and non-manifold or
 * boundary edges, so removing one never opens a hole in another. `area` is
 * left at zero for a caller with face areas to hand.
 */
export function piecesOf({ faces, faceCount, pointCount, pointPos, locked, rim }) {
  const parent = Int32Array.from({ length: faceCount }, (_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  const edgeFaces = new Map()
  const firstAt = new Int32Array(pointCount).fill(-1)
  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? u * pointCount + v : v * pointCount + u
      const list = edgeFaces.get(k)
      if (list) list.push(f); else edgeFaces.set(k, [f])
    }
    for (const p of [a, b, c]) {
      if (locked[p] || rim[p]) continue
      if (firstAt[p] === -1) firstAt[p] = f; else union(firstAt[p], f)
    }
  }
  for (const list of edgeFaces.values()) if (list.length === 2) union(list[0], list[1])

  const pieceOf = new Int32Array(faceCount)
  const idOf = new Map()
  const pieces = []
  for (let f = 0; f < faceCount; f++) {
    const r = find(f)
    let id = idOf.get(r)
    if (id === undefined) {
      id = pieces.length
      idOf.set(r, id)
      pieces.push({ faces: 0, area: 0, diag: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
    }
    pieceOf[f] = id
    const c = pieces[id]
    c.faces++
    for (let s = 0; s < 3; s++) {
      const o = faces[f * 3 + s] * 3
      for (let k = 0; k < 3; k++) {
        const x = pointPos[o + k]
        if (x < c.min[k]) c.min[k] = x
        if (x > c.max[k]) c.max[k] = x
      }
    }
  }
  for (const c of pieces) c.diag = Math.hypot(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2])
  return { pieceOf, pieces }
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
  let rimPoints = 0
  let seamPoints = 0
  for (let p = 0; p < topo.pointCount; p++) {
    if (topo.locked[p]) lockedPoints++
    else if (topo.rim[p]) rimPoints++
    else if (topo.seam[p]) seamPoints++
  }
  let lockedFaces = 0
  for (let f = 0; f < topo.faceCount; f++) {
    const a = topo.faces[f * 3], b = topo.faces[f * 3 + 1], c = topo.faces[f * 3 + 2]
    if (topo.locked[a] && topo.locked[b] && topo.locked[c]) lockedFaces++
  }
  const { pieces } = piecesOf(topo)
  const mainFaces = Math.max(...pieces.map((c) => c.faces))
  return {
    // How many pieces, and how many faces sit outside the biggest one: those
    // are the faces a coarse tier spends on crest spines and claws unless it
    // deletes the pieces they belong to.
    pieces: pieces.length,
    minorFaces: topo.faceCount - mainFaces,
    tris: topo.faceCount,
    vertices: mesh.positions.length / 3,
    points: topo.pointCount,
    lockedPoints,
    // A rim point collapses along its rim and nowhere else; an open leaf card
    // is all rim and still thins. Seam points are not free either -- a
    // collapse across one needs a matching wedge on both ends -- but neither
    // kind is pinned. A mesh that is mostly seam decimates worse than one that
    // is mostly interior, and reporting the kinds apart is what tells a
    // shattered atlas from a genuinely dense mesh.
    rimPoints,
    seamPoints,
    freePoints: topo.pointCount - lockedPoints - rimPoints - seamPoints,
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

// --- the fit ----------------------------------------------------------------
//
// Half-edge collapse never moves a vertex, so every coarse face is a chord
// strung between points that were on the surface, and on a convex body every
// chord lies inside it: a coarse tier is the original with its volume shaved
// off, and the coarser the tier the deeper the shave. At 64 triangles the frog
// loses 38% of its volume and 12% of its height, most of it out of its back.
// The fit puts the volume back: each output point slides along its own normal
// to the least-squares fit of the source surface to the coarse one.
//
// Only positions move. Every corner keeps the UV it was born with, so the atlas
// invariant holds exactly as it does under 'stretch' -- the UV triangle is an
// input triangle verbatim, the 3D triangle under it changed shape.

// How far outside the source a fitted point may sit, as a fraction of the
// bounding diagonal. Least squares on a convex body sets its vertices OUTSIDE
// the surface (the face between them cuts a chord inside, the vertex balances
// it out), and left to itself the fit grows the box by a quarter. Swept over
// the roster's coarsest tiers in scripts/probe-decimate-profile.mjs: 0 and
// 0.01 both score under this, and it is the best on 17 of 22 creatures.
const FIT_OUT = 0.005

// Re-pairings of source samples with the coarse surface, and relaxation steps
// per pairing. The step is a bounded mean-residual move, so it cannot fly, and
// past this the numbers stop moving.
const FIT_ROUNDS = 8
const FIT_STEPS = 20

// Barycentric coordinates of the closest point on triangle abc to p (Ericson,
// Real-Time Collision Detection 5.1.5), written into `out`.
function closestOnTriangle(px, py, pz, P, a, b, c, out) {
  const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2]
  const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2]
  const apx = px - P[a], apy = py - P[a + 1], apz = pz - P[a + 2]
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) { out[0] = 1; out[1] = 0; out[2] = 0; return }
  const bpx = px - P[b], bpy = py - P[b + 1], bpz = pz - P[b + 2]
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) { out[0] = 0; out[1] = 1; out[2] = 0; return }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); out[0] = 1 - v; out[1] = v; out[2] = 0; return }
  const cpx = px - P[c], cpy = py - P[c + 1], cpz = pz - P[c + 2]
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) { out[0] = 0; out[1] = 0; out[2] = 1; return }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); out[0] = 1 - w; out[1] = 0; out[2] = w; return }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); out[0] = 0; out[1] = 1 - w; out[2] = w; return }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom
  out[0] = 1 - v - w; out[1] = v; out[2] = w
}

/**
 * Uniform grid over `count` items, each spanning the box `boundsOf(i, box)`
 * fills in, answering "which item is nearest this point" by scanning cells in
 * expanding shells until the nearest found is closer than the next shell can
 * be. `dist2Of(i)` prices an item against the query. Without this the fit is
 * every source sample against every coarse face, every round.
 */
class CellGrid {
  constructor(count, boundsOf, cell) {
    this.cell = cell
    this.cells = new Map()
    this.stamp = new Int32Array(count)
    this.query = 0
    const box = new Float64Array(6)
    for (let i = 0; i < count; i++) {
      boundsOf(i, box)
      const x0 = Math.floor(box[0] / cell), y0 = Math.floor(box[1] / cell), z0 = Math.floor(box[2] / cell)
      const x1 = Math.floor(box[3] / cell), y1 = Math.floor(box[4] / cell), z1 = Math.floor(box[5] / cell)
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const k = `${x},${y},${z}`
        let list = this.cells.get(k)
        if (!list) { list = []; this.cells.set(k, list) }
        list.push(i)
      }
    }
  }
  nearest(px, py, pz, dist2Of) {
    const cell = this.cell, stamp = this.stamp, q = ++this.query
    const cx = Math.floor(px / cell), cy = Math.floor(py / cell), cz = Math.floor(pz / cell)
    let best = Infinity, index = -1
    // Cells at index distance r + 1 are at least r cells from the point, so
    // once shell r is scanned anything closer than r cells has been seen.
    for (let r = 0; ; r++) {
      if (r > 1e4) throw new Error('CellGrid.nearest ran off the grid -- no items at all')
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue
        const list = this.cells.get(`${x},${y},${z}`)
        if (!list) continue
        for (const i of list) {
          if (stamp[i] === q) continue
          stamp[i] = q
          const d2 = dist2Of(i)
          if (d2 < best) { best = d2; index = i }
        }
      }
      if (best <= (r * cell) ** 2) return { index, d2: best }
    }
  }
}

/**
 * Moves the welded points of a coarse mesh (`V` positions, `I` indices,
 * `pointOf` vertex -> point, `pointCount`) onto the least-squares fit of
 * `source`'s surface, in place. Samples are the source's welded points and face
 * centroids, area weighted; each round pairs every sample with the closest
 * point on the coarse surface, then relaxes every coarse point by the weighted
 * mean of its samples' residuals, projected onto the point's normal so a point
 * never slides along the surface. After each step a point outside the source
 * (by ray parity) and further from it than `outFraction` of its diagonal is
 * pulled back to that distance.
 */
function fitToSurface(V, I, pointOf, pointCount, source, outFraction) {
  const n = V.length / 3
  const faceCount = I.length / 3
  const src = buildTopology({ positions: source.positions, indices: source.indices })
  const SP = src.pointPos, SF = src.faces
  const outMax = outFraction * src.diag

  // Source samples, area weighted.
  const sampleCount = src.pointCount + src.faceCount
  const sp = new Float64Array(sampleCount * 3), sw = new Float64Array(sampleCount)
  sp.set(SP)
  for (let f = 0; f < src.faceCount; f++) {
    const a = SF[f * 3], b = SF[f * 3 + 1], c = SF[f * 3 + 2]
    const ux = SP[b * 3] - SP[a * 3], uy = SP[b * 3 + 1] - SP[a * 3 + 1], uz = SP[b * 3 + 2] - SP[a * 3 + 2]
    const vx = SP[c * 3] - SP[a * 3], vy = SP[c * 3 + 1] - SP[a * 3 + 1], vz = SP[c * 3 + 2] - SP[a * 3 + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const area = Math.hypot(nx, ny, nz) / 2
    for (const p of [a, b, c]) sw[p] += area / 3
    const s = src.pointCount + f
    sw[s] = area
    sp[s * 3] = (SP[a * 3] + SP[b * 3] + SP[c * 3]) / 3
    sp[s * 3 + 1] = (SP[a * 3 + 1] + SP[b * 3 + 1] + SP[c * 3 + 1]) / 3
    sp[s * 3 + 2] = (SP[a * 3 + 2] + SP[b * 3 + 2] + SP[c * 3 + 2]) / 3
  }

  // Residuals further than twice the median coarse edge are some other part of
  // the body -- a leg's samples must not pull on the belly above it.
  const edges = new Float64Array(I.length)
  for (let f = 0; f < faceCount; f++) for (let k = 0; k < 3; k++) {
    const a = I[f * 3 + k] * 3, b = I[f * 3 + ((k + 1) % 3)] * 3
    edges[f * 3 + k] = Math.hypot(V[a] - V[b], V[a + 1] - V[b + 1], V[a + 2] - V[b + 2])
  }
  edges.sort()
  const medianEdge = edges[edges.length >> 1] || src.diag * 0.01
  const reach2 = (2 * medianEdge) ** 2

  const sourceGrid = new CellGrid(src.pointCount, (p, box) => {
    box[0] = box[3] = SP[p * 3]; box[1] = box[4] = SP[p * 3 + 1]; box[2] = box[5] = SP[p * 3 + 2]
  }, medianEdge)
  const nearestSourcePoint = (x, y, z) => sourceGrid.nearest(x, y, z, (p) => (SP[p * 3] - x) ** 2 + (SP[p * 3 + 1] - y) ** 2 + (SP[p * 3 + 2] - z) ** 2).index
  const srcFacesAt = Array.from({ length: src.pointCount }, () => [])
  for (let f = 0; f < src.faceCount; f++) for (let k = 0; k < 3; k++) srcFacesAt[SF[f * 3 + k]].push(f)

  // Inside or outside the source, by ray parity along +x: a coarse point
  // strung between two antler tines is a centimetre from the nearest tine, so
  // no normal test can tell it from a point on the tine. Faces are bucketed by
  // the (y, z) column they cover.
  const column = 4 * (src.diag / Math.sqrt(src.faceCount))
  const columns = new Map()
  for (let f = 0; f < src.faceCount; f++) {
    const a = SF[f * 3] * 3, b = SF[f * 3 + 1] * 3, c = SF[f * 3 + 2] * 3
    const y0 = Math.floor(Math.min(SP[a + 1], SP[b + 1], SP[c + 1]) / column), y1 = Math.floor(Math.max(SP[a + 1], SP[b + 1], SP[c + 1]) / column)
    const z0 = Math.floor(Math.min(SP[a + 2], SP[b + 2], SP[c + 2]) / column), z1 = Math.floor(Math.max(SP[a + 2], SP[b + 2], SP[c + 2]) / column)
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = `${y},${z}`
      let list = columns.get(k)
      if (!list) { list = []; columns.set(k, list) }
      list.push(f)
    }
  }
  const insideSource = (x, y, z) => {
    const list = columns.get(`${Math.floor(y / column)},${Math.floor(z / column)}`)
    if (!list) return false
    let crossings = 0
    for (const f of list) {
      const a = SF[f * 3] * 3, b = SF[f * 3 + 1] * 3, c = SF[f * 3 + 2] * 3
      const ay = SP[a + 1] - y, az = SP[a + 2] - z, by = SP[b + 1] - y, bz = SP[b + 2] - z, cy = SP[c + 1] - y, cz = SP[c + 2] - z
      const d = (by - ay) * (cz - az) - (bz - az) * (cy - ay)
      if (Math.abs(d) < EPS) continue
      const wc = ((by - ay) * -az - (bz - az) * -ay) / d, wb = (-ay * (cz - az) - -az * (cy - ay)) / d
      if (wb < 0 || wc < 0 || wb + wc > 1) continue
      const hx = SP[a] + wb * (SP[b] - SP[a]) + wc * (SP[c] - SP[a])
      if (hx > x) crossings++
    }
    return (crossings & 1) === 1
  }

  const sf = new Int32Array(sampleCount), sb = new Float64Array(sampleCount * 3), sq = new Float64Array(sampleCount * 3)
  const bary = new Float64Array(3)
  const PN = new Float64Array(pointCount * 3), num = new Float64Array(pointCount * 3), den = new Float64Array(pointCount)
  const project = (s) => {
    const f = sf[s] * 3, a = I[f] * 3, b = I[f + 1] * 3, c = I[f + 2] * 3
    const wa = sb[s * 3], wb = sb[s * 3 + 1], wc = sb[s * 3 + 2]
    sq[s * 3] = wa * V[a] + wb * V[b] + wc * V[c]
    sq[s * 3 + 1] = wa * V[a + 1] + wb * V[b + 1] + wc * V[c + 1]
    sq[s * 3 + 2] = wa * V[a + 2] + wb * V[b + 2] + wc * V[c + 2]
  }
  // A point outside the source and further from it than outMax comes back to
  // outMax from the closest point on the faces around its nearest source point.
  const clamp = () => {
    num.fill(0)
    for (let v = 0; v < n; v++) {
      const p = pointOf[v], x = V[v * 3], y = V[v * 3 + 1], z = V[v * 3 + 2]
      if (insideSource(x, y, z)) continue
      const s = nearestSourcePoint(x, y, z)
      let best = (SP[s * 3] - x) ** 2 + (SP[s * 3 + 1] - y) ** 2 + (SP[s * 3 + 2] - z) ** 2
      let qx = SP[s * 3], qy = SP[s * 3 + 1], qz = SP[s * 3 + 2]
      for (const f of srcFacesAt[s]) {
        const a = SF[f * 3] * 3, b = SF[f * 3 + 1] * 3, c = SF[f * 3 + 2] * 3
        closestOnTriangle(x, y, z, SP, a, b, c, bary)
        const cx = bary[0] * SP[a] + bary[1] * SP[b] + bary[2] * SP[c]
        const cy = bary[0] * SP[a + 1] + bary[1] * SP[b + 1] + bary[2] * SP[c + 1]
        const cz = bary[0] * SP[a + 2] + bary[1] * SP[b + 2] + bary[2] * SP[c + 2]
        const d2 = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2
        if (d2 < best) { best = d2; qx = cx; qy = cy; qz = cz }
      }
      const d = Math.sqrt(best)
      if (d <= outMax) continue
      const k = (d - outMax) / d
      num[p * 3] = (qx - x) * k; num[p * 3 + 1] = (qy - y) * k; num[p * 3 + 2] = (qz - z) * k
    }
    for (let v = 0; v < n; v++) { const p = pointOf[v] * 3; V[v * 3] += num[p]; V[v * 3 + 1] += num[p + 1]; V[v * 3 + 2] += num[p + 2] }
  }

  for (let round = 0; round < FIT_ROUNDS; round++) {
    const faceGrid = new CellGrid(faceCount, (f, box) => {
      const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3
      for (let k = 0; k < 3; k++) { box[k] = Math.min(V[a + k], V[b + k], V[c + k]); box[k + 3] = Math.max(V[a + k], V[b + k], V[c + k]) }
    }, medianEdge)
    for (let s = 0; s < sampleCount; s++) {
      const x = sp[s * 3], y = sp[s * 3 + 1], z = sp[s * 3 + 2]
      sf[s] = faceGrid.nearest(x, y, z, (f) => {
        closestOnTriangle(x, y, z, V, I[f * 3] * 3, I[f * 3 + 1] * 3, I[f * 3 + 2] * 3, bary)
        const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3
        const qx = bary[0] * V[a] + bary[1] * V[b] + bary[2] * V[c]
        const qy = bary[0] * V[a + 1] + bary[1] * V[b + 1] + bary[2] * V[c + 1]
        const qz = bary[0] * V[a + 2] + bary[1] * V[b + 2] + bary[2] * V[c + 2]
        return (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2
      }).index
      closestOnTriangle(x, y, z, V, I[sf[s] * 3] * 3, I[sf[s] * 3 + 1] * 3, I[sf[s] * 3 + 2] * 3, bary)
      sb.set(bary, s * 3)
      project(s)
    }
    for (let step = 0; step < FIT_STEPS; step++) {
      PN.fill(0); num.fill(0); den.fill(0)
      for (let f = 0; f < faceCount; f++) {
        const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2]
        const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2]
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        for (let k = 0; k < 3; k++) { const p = pointOf[I[f * 3 + k]] * 3; PN[p] += nx; PN[p + 1] += ny; PN[p + 2] += nz }
      }
      for (let s = 0; s < sampleCount; s++) {
        const rx = sp[s * 3] - sq[s * 3], ry = sp[s * 3 + 1] - sq[s * 3 + 1], rz = sp[s * 3 + 2] - sq[s * 3 + 2]
        if (rx * rx + ry * ry + rz * rz > reach2) continue
        for (let k = 0; k < 3; k++) {
          const p = pointOf[I[sf[s] * 3 + k]], w = sw[s] * sb[s * 3 + k]
          num[p * 3] += w * rx; num[p * 3 + 1] += w * ry; num[p * 3 + 2] += w * rz
          den[p] += w
        }
      }
      for (let p = 0; p < pointCount; p++) {
        if (den[p] < EPS) { num[p * 3] = num[p * 3 + 1] = num[p * 3 + 2] = 0; continue }
        const l = Math.hypot(PN[p * 3], PN[p * 3 + 1], PN[p * 3 + 2]) || 1
        const nx = PN[p * 3] / l, ny = PN[p * 3 + 1] / l, nz = PN[p * 3 + 2] / l
        const t = (num[p * 3] * nx + num[p * 3 + 1] * ny + num[p * 3 + 2] * nz) / den[p]
        num[p * 3] = t * nx; num[p * 3 + 1] = t * ny; num[p * 3 + 2] = t * nz
      }
      for (let v = 0; v < n; v++) { const p = pointOf[v] * 3; V[v * 3] += num[p]; V[v * 3 + 1] += num[p + 1]; V[v * 3 + 2] += num[p + 2] }
      clamp()
      for (let s = 0; s < sampleCount; s++) project(s)
    }
  }
  // The clamp is one nearest-point step; a point that came in from far out
  // lands beside a different source point, so it takes a few to settle.
  for (let i = 0; i < 6; i++) clamp()
}

// --- decimation -------------------------------------------------------------

/**
 * Reduces `mesh` toward `targetTris` by half-edge collapse.
 *
 * HALF-EDGE, not the general form: the surviving vertex stays exactly where it
 * was rather than moving to an optimal position. That costs geometric accuracy
 * (the fit pass buys it back afterwards, moving positions and nothing else) and
 * buys the thing that matters here -- no vertex attribute is ever interpolated
 * or invented, so every UV in the output is a UV that was in the input. A
 * decimator that computes new texture coordinates is a decimator that can put
 * them in the wrong island. `fit` turns the pass off; `fitTo` is the surface it
 * fits to (this mesh unless a ladder passes the original); `fitOut` is how far
 * outside that surface a point may sit, as a fraction of the diagonal.
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
  const {
    flipTolerance = 0.2, weldEps, seamCollapse = true, uvMode = 'preserve', dropIslands = true,
    featureWeight = FEATURE_WEIGHT, sizeWeight = SIZE_WEIGHT, shapeWeight = SHAPE_WEIGHT,
    fit = true, fitTo = mesh, fitOut = FIT_OUT,
  } = opts
  const { positions, uvs, normals, indices } = mesh
  if (!positions || !indices) throw new Error('decimate requires positions and indices')
  if (!Number.isFinite(targetTris) || targetTris < 1) throw new Error(`decimate requires a positive targetTris, got ${targetTris}`)
  if (!['preserve', 'stretch', 'drop', 'auto'].includes(uvMode)) throw new Error(`unknown uvMode "${uvMode}" -- want preserve, stretch, drop or auto`)

  // The exact atlas where it reaches the target at close to the price the
  // stretched one pays, the stretched one otherwise. Which one ran is in the
  // stats.
  if (uvMode === 'auto') {
    const kept = decimate(mesh, targetTris, { ...opts, uvMode: 'preserve' })
    if (kept.stats.outputTris > targetTris) return decimate(mesh, targetTris, { ...opts, uvMode: 'stretch' })
    const slid = decimate(mesh, targetTris, { ...opts, uvMode: 'stretch' })
    return kept.stats.maxCost <= AUTO_SLACK * slid.stats.maxCost ? kept : slid
  }

  // An input carrying `sampleUvs` instead of `uvs` has already had its atlas
  // dropped by an earlier tier. Keeping it is then not a choice on offer, and
  // saying it happened would put a `uv` attribute back on a mesh whose corners
  // come from unrelated islands.
  const keepAtlas = uvMode !== 'drop' && Boolean(uvs)
  const stretch = keepAtlas && uvMode === 'stretch'
  const topo = buildTopology(keepAtlas ? mesh : { positions, indices }, { weldEps })
  const { pointPos, locked, rim, seam, uvId, pointCount, faceCount } = topo

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

  const { pieceOf, pieces } = piecesOf(topo)

  const Q = new Float64Array(pointCount * 10)
  // The feature term rides in its own quadric so the shape factor below
  // scales the surface error and leaves silhouette protection absolute.
  const F = new Float64Array(pointCount * 10)
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
    pieces[pieceOf[f]].area += area
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
  // --- the size term --------------------------------------------------------
  //
  // Which is a problem of its own on the flat majority: a plane quadric prices
  // every collapse across a flat patch at zero whatever its size, so a big
  // triangle on the back goes as readily as a tiny one on the snout, and the
  // back is a tangle of stretched triangles while the snout is still dense.
  // `sizeWeight` is a floor under `importance`: every point resists being
  // dragged by `sizeWeight * meanMass` per unit distance squared, flat or not.
  // The point quadric is a sum over every point a vertex has absorbed, so the
  // price of moving a vertex grows with how much surface has already been
  // folded into it, and the cheapest collapse is always the one in the region
  // that has been coarsened least: small triangles go first.
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
  // Kept per point because deleting a whole piece is priced against the same
  // term below: a crest spine's tip is an extreme point and should cost as much
  // to delete as it would to collapse.
  const featureW = new Float64Array(pointCount)
  if ((featureWeight > 0 || sizeWeight > 0) && meanMass > 0) {
    const extreme = new Uint8Array(pointCount)
    for (let d = 0; d < PROFILE_DIRECTIONS && featureWeight > 0; d++) {
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
      if (sizeWeight > 0) {
        pointQuadric(pointPos[p * 3], pointPos[p * 3 + 1], pointPos[p * 3 + 2], sizeWeight * meanMass, fq, 0)
        for (let i = 0; i < 10; i++) Q[p * 10 + i] += fq[i]
      }
      const turn = 1 - Math.hypot(normalSum[p * 3], normalSum[p * 3 + 1], normalSum[p * 3 + 2]) / mass[p]
      const importance = Math.max(0, turn) + extreme[p]
      if (featureWeight <= 0 || importance <= 0) continue
      featureW[p] = featureWeight * importance * meanMass
      pointQuadric(pointPos[p * 3], pointPos[p * 3 + 1], pointPos[p * 3 + 2], featureW[p], fq, 0)
      for (let i = 0; i < 10; i++) F[p * 10 + i] += fq[i]
    }
  }

  // --- the shape term -------------------------------------------------------
  //
  // The quadric says how far a collapse takes the surface from where it was
  // and nothing about what it leaves behind. Two collapses of the same error
  // can leave an equilateral fan or a fan of 4:1 slivers, and on a flat back the
  // quadric cannot tell them apart. So the cost is scaled by how much worse the
  // collapse leaves the faces it reshapes -- the faces at u that survive it,
  // with u's corner moved to v -- as (quality before / quality after) of the
  // worst one, to the power `shapeWeight`. Relative, not absolute: a collapse
  // that leaves a sliver where there was a sliver is not punished, or an ear
  // that is slivers by construction would be the cheapest thing on the mesh.
  // Multiplicative so that within a region the quadric's own order is kept;
  // and the size term keeps the quadric off zero, so it always has purchase.
  const shapePenalty = (u, v) => {
    let worst = 1
    const vo = v * 3
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
      if (a === v || b === v || c === v) continue
      const before = triQuality(pointPos, a * 3, b * 3, c * 3)
      // Floored, so a near-degenerate result is very expensive rather than
      // infinite; `wouldFlip` refuses the actual slivers when they come up.
      const after = Math.max(0.02, triQuality(pointPos, a === u ? vo : a * 3, b === u ? vo : b * 3, c === u ? vo : c * 3))
      if (before / after > worst) worst = before / after
    }
    return Math.pow(worst, shapeWeight)
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
    let cost = e < 0 ? 0 : e
    if (shapeWeight > 0) cost *= shapePenalty(u, v)
    for (let i = 0; i < 10; i++) sumQ[i] = F[a + i] + F[b + i]
    const f = quadricError(sumQ, 0, pointPos[o], pointPos[o + 1], pointPos[o + 2])
    return cost + (f < 0 ? 0 : f)
  }

  const heap = new MinHeap()
  const pushEdge = (u, v) => {
    // Non-manifold points are pinned outright. Rim and seam points are not --
    // whether a particular collapse of theirs is legal depends on the edge, and
    // `alongRim` and `wedgeMap` decide it when the edge comes off the heap.
    if (locked[u] || locked[v]) return
    if (!seamCollapse && (seam[u] || seam[v])) return
    heap.push({ cost: costOf(u, v), u, v, stamp: version[u] + version[v] })
  }
  for (let u = 0; u < pointCount; u++) {
    if (locked[u]) continue
    for (const v of neighbours[u]) pushEdge(u, v)
  }

  // --- deleting a piece outright --------------------------------------------
  //
  // A piece is priced as if every point it owns were collapsed to its centre:
  // plane term `area * r^2` plus the feature term at the same radius, with r
  // half its bounding diagonal -- the same units as an edge collapse, and it
  // goes the moment a LEGAL collapse that costs more is about to happen. That
  // is exactly the order wanted: a crest fin is 0.03% of the surface and a few
  // millimetres across, so it costs nothing beside a flank collapse late in
  // the ladder, while a wing modelled as its own shell costs more than any
  // collapse ever will. The largest piece is never offered: a mesh that is all
  // pinned specks still keeps one.
  //
  // The comparison is against a collapse that is really going to happen, not
  // against the heap: an all-seam mesh under 'preserve' runs out of legal
  // collapses with the target still far off, and pieces left in the heap as the
  // only entries would then be taken in cost order with nothing bounding them.
  // The leafkin's legs are a 523-face piece, 38% of its surface, and went that
  // way at five hundred times the price of the dearest collapse ever made. A
  // tier that cannot reach its target by collapsing says so instead, and `auto`
  // falls through to 'stretch', where the pricing holds all the way down.
  //
  // A point belongs to the piece that holds every face at it; pinned points
  // where two pieces meet belong to neither and survive the deletion.
  const ownerOf = new Int32Array(pointCount).fill(-1)
  for (let p = 0; p < pointCount; p++) {
    let owner = -1
    for (const f of facesAt[p]) {
      if (owner === -1) owner = pieceOf[f]
      else if (pieceOf[f] !== owner) { owner = -1; break }
    }
    ownerOf[p] = owner
  }
  let liveFaces = faceCount
  let piecesDropped = 0
  // Offered pieces, cheapest first; `nextOffer` walks them as collapses get dearer.
  const offers = []
  if (dropIslands && pieces.length > 1) {
    const featureAt = new Float64Array(pieces.length)
    for (let p = 0; p < pointCount; p++) if (ownerOf[p] !== -1) featureAt[ownerOf[p]] += featureW[p] + sizeWeight * meanMass
    const largest = pieces.reduce((best, c, i) => (c.area > pieces[best].area ? i : best), 0)
    pieces.forEach((c, i) => {
      if (i === largest) return
      const r2 = c.diag * c.diag * 0.25
      offers.push({ cost: (c.area + featureAt[i]) * r2, piece: i })
    })
    offers.sort((a, b) => a.cost - b.cost)
  }
  let nextOffer = 0
  /** Deletes every offered piece priced at or under `cost`, stopping at the target. */
  const dropPiecesUpTo = (cost) => {
    while (nextOffer < offers.length && offers[nextOffer].cost <= cost && liveFaces > targetTris) {
      const piece = offers[nextOffer++].piece
      piecesDropped++
      for (let f = 0; f < faceCount; f++) {
        if (faceAlive[f] && pieceOf[f] === piece) { faceAlive[f] = 0; liveFaces-- }
      }
      for (let p = 0; p < pointCount; p++) if (ownerOf[p] === piece) removed[p] = 1
    }
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
   * A collapse is legal only if the neighbours u and v share are exactly the
   * vertices opposite their edge in the faces that contain it. Any other shared
   * neighbour means the collapse would weld together parts of the surface that
   * only meet in the index buffer, a non-manifold pinch no later step can undo.
   * That is two vertices on a manifold edge, and ONE on a pillow -- two faces
   * back to back on the same three points, a crest scale or what a spine
   * collapses down to -- so a pillow's tip can fold in and take both faces with
   * it.
   */
  const linkConditionOk = (u, v) => {
    const opposite = new Set()
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
      if (a !== v && b !== v && c !== v) continue
      opposite.add(a === u || a === v ? (b === u || b === v ? c : b) : a)
    }
    let shared = 0
    for (const n of neighbours[u]) {
      if (!neighbours[v].has(n)) continue
      if (!opposite.has(n)) return false
      shared++
    }
    return shared === opposite.size
  }

  /**
   * A rim point leaves only along its rim: the edge to v must be a boundary
   * edge -- one live face -- so the outline loses one chord and v, already on
   * the rim, keeps exactly the two boundary edges it had. Across any other edge
   * the collapse would pull the rim into the sheet or weld two rims into a
   * pinch, so it is refused. An interior point folding onto a rim point is fine
   * and needs no test. Rim status never changes under these rules, so the flag
   * `buildTopology` set stands for the whole run.
   */
  const alongRim = (u, v) => {
    if (!rim[u]) return true
    let shared = 0
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      if (facePoints[f * 3] === v || facePoints[f * 3 + 1] === v || facePoints[f * 3 + 2] === v) shared++
    }
    return shared === 1
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

  let collapses = 0
  let stretched = 0
  let maxCost = 0
  let reason = 'reached target'

  while (liveFaces > targetTris) {
    if (heap.size === 0) { reason = 'ran out of legal collapses -- the rest of the mesh is seam or boundary'; break }
    const e = heap.pop()
    const { u, v } = e
    if (removed[u] || removed[v]) continue
    if (locked[u] || locked[v]) continue
    if (!neighbours[u].has(v)) continue
    if (e.stamp !== version[u] + version[v]) { pushEdge(u, v); continue } // stale cost
    if (!alongRim(u, v)) continue
    if (!linkConditionOk(u, v)) continue
    if (wouldFlip(u, v)) continue
    // Read the correspondence before anything is retired -- it is sourced from
    // exactly the faces the collapse is about to kill. No answer means the
    // collapse is refused, unless stretching: then every moved corner keeps its
    // own UV and the island's texels stretch over the new triangle.
    const wedges = wedgeMap(u, v)
    if (!wedges && !stretch) continue
    // This collapse is going to happen, so every piece cheaper than it goes
    // first -- possibly the very piece the edge is in, and possibly enough of
    // them to reach the target without it.
    dropPiecesUpTo(e.cost)
    if (liveFaces <= targetTris) break
    if (removed[u] || removed[v]) continue
    if (!wedges) stretched++

    // Retire the faces on the collapsed edge -- unless they are the last ones:
    // a lone pillow folding in would empty the mesh, and the caller asked for
    // a mesh.
    const retiring = []
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
      if (a === v || b === v || c === v) retiring.push(f)
    }
    if (retiring.length >= liveFaces) continue
    for (const f of retiring) { faceAlive[f] = 0; liveFaces-- }
    // Rewrite the rest onto v, each corner taking the corner of v that sits in
    // its own island.
    for (const f of facesAt[u]) {
      if (!faceAlive[f]) continue
      for (let s = 0; s < 3; s++) {
        if (facePoints[f * 3 + s] === u) {
          facePoints[f * 3 + s] = v
          if (wedges) faceCorners[f * 3 + s] = wedges.get(uvId[faceCorners[f * 3 + s]])
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
    // A pillow's base edge has no face left once its tip folds in; an edge with
    // no face is not one to collapse along, or the next collapse would drag
    // surface across a gap.
    for (const n of neighbours[v]) {
      let joined = false
      for (const f of facesAt[v]) {
        if (!faceAlive[f]) continue
        if (facePoints[f * 3] === n || facePoints[f * 3 + 1] === n || facePoints[f * 3 + 2] === n) { joined = true; break }
      }
      if (!joined) { neighbours[v].delete(n); neighbours[n].delete(v) }
    }
    removed[u] = 1
    version[u]++
    version[v]++
    for (let i = 0; i < 10; i++) { Q[v * 10 + i] += Q[u * 10 + i]; F[v * 10 + i] += F[u * 10 + i] }
    collapses++
    if (e.cost > maxCost) maxCost = e.cost

    for (const n of neighbours[v]) { pushEdge(v, n); pushEdge(n, v) }
  }

  // --- rebuild --------------------------------------------------------------

  // An output vertex is an input corner (its attributes) at the point it now
  // sits on -- which under stretching is not the point it was born at. A corner
  // only ever moves with every face that holds it, so it resolves to one point.
  const usedCorner = new Map()
  const cornerPoint = []
  const outIndices = []
  for (let f = 0; f < faceCount; f++) {
    if (!faceAlive[f]) continue
    const a = facePoints[f * 3], b = facePoints[f * 3 + 1], c = facePoints[f * 3 + 2]
    if (a === b || b === c || a === c) continue // defensive: never emit a degenerate
    for (let s = 0; s < 3; s++) {
      const corner = faceCorners[f * 3 + s]
      const p = facePoints[f * 3 + s]
      let out = usedCorner.get(corner)
      if (out === undefined) { out = usedCorner.size; usedCorner.set(corner, out); cornerPoint.push(p) }
      else if (cornerPoint[out] !== p) throw new Error(`corner ${corner} is used at two points (${cornerPoint[out]}, ${p}) -- a collapse rewrote a corner inconsistently`)
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
  // The input vertex each output vertex IS. Everything this function knows how to
  // interpolate it has already written; a caller carrying an attribute this file
  // has never heard of -- skin joints and weights, a vertex colour -- copies it
  // through here instead. See tools/creatures/skin-ladder.mjs.
  const sourceVertex = new Int32Array(outVerts)
  for (const [corner, out] of usedCorner) {
    sourceVertex[out] = corner
    const p = cornerPoint[out] * 3
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
  // Fitted against `fitTo`, the ORIGINAL when this is a ladder tier: fitting
  // to the tier above would chase its shave rather than undo it.
  if (fit && outIndices.length) fitToSurface(outPositions, outIndices, cornerPoint, pointCount, fitTo, fitOut)

  const outTris = outIndices.length / 3
  return {
    positions: outPositions,
    uvs: outUvs,
    sampleUvs: outSampleUvs,
    normals: outNormals,
    sourceVertex,
    indices: outVerts > 65535 ? Uint32Array.from(outIndices) : Uint16Array.from(outIndices),
    stats: {
      inputTris: faceCount,
      outputTris: outTris,
      targetTris,
      collapses,
      // The dearest collapse made: how far up the cost order the pass had to
      // reach for its target.
      maxCost,
      // Collapses that had no consistent wedge map and went ahead anyway; zero
      // outside 'stretch', and the count of triangles wearing slid texture.
      stretched,
      // Pieces in, pieces with a face left, and how many went by deletion --
      // the rest folded away collapse by collapse.
      pieces: pieces.length,
      piecesLeft: new Set(Array.from({ length: faceCount }, (_, f) => f).filter((f) => faceAlive[f]).map((f) => pieceOf[f])).size,
      piecesDropped,
      // What actually happened, not what was asked for -- 'auto' resolves here,
      // and so does 'preserve' on a mesh that had no atlas left to preserve.
      uvMode: !keepAtlas ? 'drop' : stretch ? 'stretch' : 'preserve',
      reduction: faceCount ? 1 - outTris / faceCount : 0,
      lockedPoints: locked.reduce((s, x) => s + x, 0),
      rimPoints: rim.reduce((s, x) => s + x, 0),
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
 * stops a visible pop when the renderer swaps between them. Every tier is
 * fitted to the original, not to the tier above, so the fit undoes the shave
 * instead of chasing it.
 *
 * `sourceVertex` is composed back to the ORIGINAL on the way down, not left
 * pointing at the tier above: a caller carrying its own attributes wants one
 * lookup into the mesh it handed in, whatever rung it is reading.
 */
export function decimateLadder(mesh, targets, opts) {
  const sorted = [...targets].sort((a, b) => b - a)
  const tiers = []
  let current = mesh
  for (const t of sorted) {
    const out = decimate(current, t, { fitTo: mesh, ...opts })
    if (current !== mesh) {
      const via = current.sourceVertex
      for (let i = 0; i < out.sourceVertex.length; i++) out.sourceVertex[i] = via[out.sourceVertex[i]]
    }
    tiers.push(out)
    current = out
  }
  return tiers
}
