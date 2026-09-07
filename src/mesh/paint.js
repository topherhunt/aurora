// ---------------------------------------------------------------------------
// Face painting: turn one reconstructed surface into a prop that wears THIS
// world's tiling textures, by assigning a layer per face and solving a UV for
// it by projection rather than by unwrap.
//
// No dependency on three -- the same code runs in gen-tree-v9.html and under
// scripts/check-tree-v9.mjs in node, exactly as decimate.js does.
//
// WHY PROJECTION AND NOT AN UNWRAP. §27's load-bearing worry is that a solved
// unwrap scatters into small islands and a 128px texture over small islands is
// mush. Nothing here solves an unwrap. A face's UV is a function of where it
// sits in space divided by how big one tile of its texture is, so:
//
//   Texel density is constant by construction. Two trunks of different girth
//   wear the same size of bark because both divide by the same metres-per-tile.
//
//   There are no islands, so there is no gutter to lose and no neighbour to
//   bleed in from. The atlas is a DataArrayTexture with RepeatWrapping and each
//   layer owns its whole [0,1] (src/textures.js), so a u of 3.7 is three tiles
//   and a bit, not an overflow.
//
//   Tripo's own unwrap is discarded entirely. That is what lets the decimator
//   run in 'drop' mode with no seams to pin, which is where §27's reduction
//   ceiling came from in the first place.
//
// EVERY MESH HERE IS UNWELDED -- three positions per face, no shared vertices.
// `texLayer` and `uvProj` are per-VERTEX attributes and painting is per-FACE, so
// two faces wearing different layers cannot share a vertex. Unwelding once up
// front makes that true everywhere and makes the cylindrical branch cut below
// legal as a side effect. It triples the vertex buffer of a 1000-triangle mesh,
// which is 3000 vertices; props/rock.js has always done the same thing.
//
// OUTPUT IS { position, normal, uvProj, texLayer }, which is the attribute set
// createPropMaterial (src/material.js) compiles against and the one every rock
// in the world already carries.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

/** Faces per mesh, from an index buffer or an implicit one. */
export const faceCount = (mesh) => (mesh.indices ? mesh.indices.length : mesh.positions.length / 3) / 3

/**
 * Explodes an indexed mesh into one triangle per three vertices.
 *
 * Normals are carried through when the input has them and computed flat when it
 * does not. Flat is the honest default for a reconstructed surface at this
 * budget: a 1000-triangle canopy has facets, and smoothing them is what makes a
 * low-poly crown read as a balloon.
 */
export function unweld({ positions, normals, indices }) {
  if (!positions) throw new Error('unweld requires positions')
  const idx = indices ?? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
  const tris = idx.length / 3
  if (!Number.isInteger(tris)) throw new Error(`index count ${idx.length} is not a whole number of triangles`)

  const outPos = new Float32Array(tris * 9)
  const outNrm = new Float32Array(tris * 9)
  for (let f = 0; f < tris; f++) {
    for (let j = 0; j < 3; j++) {
      const src = idx[f * 3 + j]
      const dst = f * 3 + j
      outPos[dst * 3] = positions[src * 3]
      outPos[dst * 3 + 1] = positions[src * 3 + 1]
      outPos[dst * 3 + 2] = positions[src * 3 + 2]
      if (normals) {
        outNrm[dst * 3] = normals[src * 3]
        outNrm[dst * 3 + 1] = normals[src * 3 + 1]
        outNrm[dst * 3 + 2] = normals[src * 3 + 2]
      }
    }
    if (!normals) {
      const n = triangleNormal(outPos, f)
      for (let j = 0; j < 3; j++) {
        const dst = (f * 3 + j) * 3
        outNrm[dst] = n[0]
        outNrm[dst + 1] = n[1]
        outNrm[dst + 2] = n[2]
      }
    }
  }
  return {
    positions: outPos,
    normals: outNrm,
    indices: Uint32Array.from({ length: tris * 3 }, (_, i) => i),
  }
}

/** Unit normal of face `f` in an unwelded position array. Zero-area gives +Y. */
export function triangleNormal(positions, f) {
  const a = f * 9
  const ax = positions[a], ay = positions[a + 1], az = positions[a + 2]
  const bx = positions[a + 3], by = positions[a + 4], bz = positions[a + 5]
  const cx = positions[a + 6], cy = positions[a + 7], cz = positions[a + 8]
  const ux = bx - ax, uy = by - ay, uz = bz - az
  const vx = cx - ax, vy = cy - ay, vz = cz - az
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  return len > 1e-12 ? [nx / len, ny / len, nz / len] : [0, 1, 0]
}

/** Centroid of face `f`. */
export function triangleCentroid(positions, f) {
  const a = f * 9
  return [
    (positions[a] + positions[a + 3] + positions[a + 6]) / 3,
    (positions[a + 1] + positions[a + 4] + positions[a + 7]) / 3,
    (positions[a + 2] + positions[a + 5] + positions[a + 8]) / 3,
  ]
}

/** Per-face normals and centroids, computed once and reused by every tool below. */
export function faceFrames(positions) {
  const n = positions.length / 9
  const normals = new Float32Array(n * 3)
  const centroids = new Float32Array(n * 3)
  for (let f = 0; f < n; f++) {
    const nn = triangleNormal(positions, f)
    const cc = triangleCentroid(positions, f)
    normals.set(nn, f * 3)
    centroids.set(cc, f * 3)
  }
  return { normals, centroids, count: n }
}

/**
 * Face adjacency across shared EDGES, which an unwelded mesh no longer has
 * explicitly -- so edges are keyed by their two endpoints quantised to `eps`.
 *
 * `eps` defaults to a millionth of the bounding diagonal, matching decimate.js's
 * weld default and for the same reason: it fuses the duplicated corners an
 * exploded or glTF-seamed mesh is made of and nothing genuinely distinct. Too
 * coarse and two branches that merely touch become one region, which is a
 * flood-fill that swallows the whole tree.
 *
 * Returns `neighbours` as three slots per face, -1 where an edge is open or
 * shared by more than two faces (non-manifold, and not a place to walk through).
 */
export function buildFaceAdjacency(positions, { eps } = {}) {
  const n = positions.length / 9
  const tol = eps ?? boundsDiagonal(positions) * 1e-6
  const q = (v) => Math.round(v / Math.max(tol, 1e-12))
  const key = (i) => `${q(positions[i * 3])},${q(positions[i * 3 + 1])},${q(positions[i * 3 + 2])}`

  const pointOf = new Array(n * 3)
  const ids = new Map()
  for (let i = 0; i < n * 3; i++) {
    const k = key(i)
    let id = ids.get(k)
    if (id === undefined) { id = ids.size; ids.set(k, id) }
    pointOf[i] = id
  }

  // One pass to bucket faces by edge, a second to pair them. A third face on an
  // edge poisons that edge for both of the first two rather than picking a
  // winner: an arbitrary pick makes the flood fill's answer depend on face order.
  const edges = new Map()
  for (let f = 0; f < n; f++) {
    for (let j = 0; j < 3; j++) {
      const a = pointOf[f * 3 + j]
      const b = pointOf[f * 3 + ((j + 1) % 3)]
      const k = a < b ? `${a}_${b}` : `${b}_${a}`
      const slot = edges.get(k)
      if (slot === undefined) edges.set(k, [f * 3 + j])
      else slot.push(f * 3 + j)
    }
  }

  const neighbours = new Int32Array(n * 3).fill(-1)
  for (const slot of edges.values()) {
    if (slot.length !== 2) continue
    neighbours[slot[0]] = Math.floor(slot[1] / 3)
    neighbours[slot[1]] = Math.floor(slot[0] / 3)
  }
  return { neighbours, pointOf, count: n }
}

/**
 * Flood fill from `seed` across faces whose normals stay within `angleDeg` of
 * THE NEIGHBOUR THEY CAME FROM, not of the seed.
 *
 * Relative is what makes one click select a trunk. Against the seed, a 30 deg
 * cone stops a quarter of the way around a cylinder; against the neighbour, the
 * fill walks all the way round because each step is a small turn, and still
 * stops dead at the crown, where the surface genuinely creases. The cost is
 * that a gradual enough bend leaks -- which is what `maxFaces` is for.
 */
export function floodFill({ neighbours, faceNormals }, seed, { angleDeg = 40, maxFaces = Infinity } = {}) {
  const n = faceNormals.length / 3
  if (!Number.isInteger(seed) || seed < 0 || seed >= n) throw new Error(`floodFill seed ${seed} is not a face of this mesh`)
  const cosTol = Math.cos((angleDeg * Math.PI) / 180)
  const out = new Uint8Array(n)
  const stack = [seed]
  out[seed] = 1
  let taken = 1
  while (stack.length && taken < maxFaces) {
    const f = stack.pop()
    for (let j = 0; j < 3; j++) {
      const g = neighbours[f * 3 + j]
      if (g < 0 || out[g]) continue
      const dot =
        faceNormals[f * 3] * faceNormals[g * 3] +
        faceNormals[f * 3 + 1] * faceNormals[g * 3 + 1] +
        faceNormals[f * 3 + 2] * faceNormals[g * 3 + 2]
      if (dot < cosTol) continue
      out[g] = 1
      taken++
      stack.push(g)
      if (taken >= maxFaces) break
    }
  }
  return out
}

/** Faces whose centroid is within `radius` of `centre` -- the brush. */
export function facesInSphere(centroids, centre, radius) {
  const n = centroids.length / 3
  const out = new Uint8Array(n)
  const r2 = radius * radius
  for (let f = 0; f < n; f++) {
    const dx = centroids[f * 3] - centre[0]
    const dy = centroids[f * 3 + 1] - centre[1]
    const dz = centroids[f * 3 + 2] - centre[2]
    if (dx * dx + dy * dy + dz * dz <= r2) out[f] = 1
  }
  return out
}

// --- UV projection ----------------------------------------------------------

export const PROJECTIONS = ['planar', 'cylindrical']

/**
 * Per-face planar projection off the dominant world axis, which is what every
 * rock in this world already wears (props/rock.js) and what the axis mapping
 * below matches exactly.
 *
 * Adjacent faces that pick different axes get a UV discontinuity at their shared
 * edge. That is visible on a texture with strong directional structure and
 * invisible on the isotropic ones this is for -- a leaf mat, moss, stone. Bark
 * is the counterexample and bark is what `cylindrical` exists for.
 */
function planarUv(px, py, pz, axisId, metres) {
  if (axisId === 0) return [pz / metres, py / metres]
  if (axisId === 1) return [px / metres, pz / metres]
  return [px / metres, py / metres]
}

function dominantAxis(nx, ny, nz) {
  const ex = Math.abs(nx), ey = Math.abs(ny), ez = Math.abs(nz)
  return ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
}

/**
 * Solves `uvProj` for every face, one slot at a time.
 *
 * `slots` is the texture pool as painted: `{ projection, tileMetres }` each,
 * indexed by the value in `faceSlot`. A face whose slot has no entry keeps a UV
 * of zero, which samples one texel rather than rendering as a hole -- loud
 * enough to see in the preview, quiet enough not to throw mid-paint.
 *
 * Returns the UVs plus, per slot, what it actually achieved. Read `metresPerTile`
 * back: for a cylinder it is NOT what was asked for, and the gap is the whole
 * argument of `cylindricalSlot`.
 */
export function projectUvs(positions, faceSlot, slots) {
  const n = positions.length / 9
  if (faceSlot.length !== n) throw new Error(`faceSlot has ${faceSlot.length} entries for ${n} faces`)
  const uv = new Float32Array(n * 3 * 2)
  const report = slots.map((s, i) => ({ slot: i, faces: 0, projection: s?.projection ?? null, metresPerTile: s?.tileMetres ?? null }))

  const bySlot = new Map()
  for (let f = 0; f < n; f++) {
    const s = faceSlot[f]
    if (s < 0) continue
    if (!bySlot.has(s)) bySlot.set(s, [])
    bySlot.get(s).push(f)
  }

  for (const [slotId, faces] of bySlot) {
    const slot = slots[slotId]
    if (!slot) throw new Error(`face painted with slot ${slotId}, which the pool does not have`)
    const { projection = 'planar', tileMetres } = slot
    if (!PROJECTIONS.includes(projection)) throw new Error(`unknown projection "${projection}" -- want ${PROJECTIONS.join(' or ')}`)
    if (!(tileMetres > 0)) throw new Error(`slot ${slotId} needs a positive tileMetres, got ${tileMetres}`)

    report[slotId].faces = faces.length
    if (projection === 'cylindrical') {
      Object.assign(report[slotId], cylindricalSlot(positions, faces, tileMetres, uv))
    } else {
      for (const f of faces) {
        const nn = triangleNormal(positions, f)
        const axisId = dominantAxis(nn[0], nn[1], nn[2])
        for (let j = 0; j < 3; j++) {
          const i = f * 3 + j
          const [u, v] = planarUv(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], axisId, tileMetres)
          uv[i * 2] = u
          uv[i * 2 + 1] = v
        }
      }
      report[slotId].metresPerTile = tileMetres
    }
  }
  return { uvProj: uv, slots: report }
}

/**
 * Cylindrical projection about the vertical axis through the slot's own centre,
 * for the one texture that has a direction: bark runs UP.
 *
 * TILEABILITY BEATS EXACT SIZE, and that is the trade this function makes. The
 * texture has to close on itself going round the trunk or there is a visible
 * stripe down one side, and it closes only if the number of repeats around is a
 * WHOLE NUMBER. So the asked-for tileMetres picks the nearest integer count at
 * the trunk's mean radius and the achieved size is reported back, usually a few
 * percent off.
 *
 * u IS AN ANGLE FRACTION TIMES THAT COUNT, not an arc length. Arc length keeps
 * density honest on a taper but makes the repeat count vary with radius, so the
 * texture no longer closes at any height but one -- which is the failure this
 * whole function is avoiding. A trunk that tapers 2:1 wears bark 2:1 wider at
 * the foot; that reads as a big tree, and a seam does not.
 *
 * THE BRANCH CUT IS PER FACE. atan2 jumps by 2*pi across the -X meridian, and a
 * face straddling it would otherwise stretch the entire texture backwards across
 * itself in one triangle. Every vertex angle is wrapped into the half-turn
 * either side of its own face's centroid instead, which is exact for any face
 * spanning under half the trunk and is why the mesh had to be unwelded first.
 */
function cylindricalSlot(positions, faces, tileMetres, uv) {
  let cx = 0
  let cz = 0
  for (const f of faces) {
    const c = triangleCentroid(positions, f)
    cx += c[0]
    cz += c[2]
  }
  cx /= faces.length
  cz /= faces.length

  let rSum = 0
  for (const f of faces) {
    for (let j = 0; j < 3; j++) {
      const i = f * 3 + j
      rSum += Math.hypot(positions[i * 3] - cx, positions[i * 3 + 2] - cz)
    }
  }
  const rMean = rSum / (faces.length * 3)
  const repeatsAround = Math.max(1, Math.round((TAU * rMean) / tileMetres))

  for (const f of faces) {
    const c = triangleCentroid(positions, f)
    const centre = Math.atan2(c[2] - cz, c[0] - cx)
    for (let j = 0; j < 3; j++) {
      const i = f * 3 + j
      const theta = Math.atan2(positions[i * 3 + 2] - cz, positions[i * 3] - cx)
      // Into (centre - pi, centre + pi]: one wrap is enough because atan2's own
      // range is 2*pi wide, so the difference is never more than 2*pi out.
      let d = theta - centre
      if (d > Math.PI) d -= TAU
      else if (d < -Math.PI) d += TAU
      uv[i * 2] = ((centre + d) / TAU) * repeatsAround
      uv[i * 2 + 1] = positions[i * 3 + 1] / tileMetres
    }
  }
  return { axis: [cx, cz], radiusMean: rMean, repeatsAround, metresPerTile: (TAU * rMean) / repeatsAround }
}

// --- assembly ---------------------------------------------------------------

/**
 * The painted prop, in the attribute set createPropMaterial compiles against.
 *
 * `slots[i].layer` is the atlas layer that slot paints with, so the exported
 * `texLayer` is a world layer index and not a bench-local slot -- the two must
 * not be confused, because a slot is a row in this page's texture pool and a
 * layer is a row in src/textures.js's DataArrayTexture.
 */
export function buildPaintedMesh({ positions, normals }, faceSlot, slots) {
  const n = positions.length / 9
  const { uvProj, slots: report } = projectUvs(positions, faceSlot, slots)
  const texLayer = new Float32Array(n * 3)
  for (let f = 0; f < n; f++) {
    const slot = slots[faceSlot[f]]
    const layer = slot ? slot.layer : 0
    texLayer[f * 3] = layer
    texLayer[f * 3 + 1] = layer
    texLayer[f * 3 + 2] = layer
  }
  return {
    positions,
    normals,
    uvProj,
    texLayer,
    indices: Uint32Array.from({ length: n * 3 }, (_, i) => i),
    slots: report,
  }
}

/** Diagonal of the bounding box -- the unit tolerances here are expressed in. */
export function boundsDiagonal(positions) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]
      if (v < lo[k]) lo[k] = v
      if (v > hi[k]) hi[k] = v
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
}

/**
 * Scales and grounds a mesh IN PLACE to stand `heightM` tall with its foot at
 * y=0 and its trunk centred on the origin.
 *
 * Tripo normalises to its own box and the world places props by their root, so
 * without this every tree arrives a different size and buried to a different
 * depth. Centring uses the FOOT's x/z rather than the whole mesh's, because a
 * crown that leans would otherwise drag the trunk off the origin and the tree
 * would pivot around thin air when the scatter yaws it.
 */
export function groundAndScale(positions, heightM, { footFraction = 0.15 } = {}) {
  let loY = Infinity
  let hiY = -Infinity
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < loY) loY = positions[i]
    if (positions[i] > hiY) hiY = positions[i]
  }
  const span = hiY - loY
  if (!(span > 0)) throw new Error('mesh has no height to scale')
  const s = heightM / span

  const footTop = loY + span * footFraction
  let fx = 0
  let fz = 0
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] <= footTop) { fx += positions[i]; fz += positions[i + 2]; count++ }
  }
  if (count > 0) { fx /= count; fz /= count }

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - fx) * s
    positions[i + 1] = (positions[i + 1] - loY) * s
    positions[i + 2] = (positions[i + 2] - fz) * s
  }
  return { scale: s, heightM, footCentre: [fx, fz] }
}
