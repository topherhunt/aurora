// ---------------------------------------------------------------------------
// Builds a low-poly fish mesh from a single side-view columnProfile
// (chromakey.mjs) -- a fish sheet only ever has one view (see fish-prompt.mjs),
// so unlike loft-mesh.mjs's front+side character loft, there is no second
// view to read lateral (left-right) width from directly. Lateral thickness is
// instead a heuristic "bulge" as a fraction of the dorsal-ventral height
// already measured off the real contour (see bulgeFactor below) -- true to
// the outline in profile, approximate in cross-section, same tradeoff
// loft-mesh.mjs makes modelling limbs as plain tapered tubes rather than
// sculpting fingers.
//
// Fish art is prompted "profile facing left" (fish-prompt.mjs), so image-x
// runs nose (left, small x) -> tail (right, large x). That maps directly onto
// local -Z-forward (the same "local -Z is forward" convention loft-mesh.mjs's
// header documents for characters): nose at -Z, tail at +Z, ring angle
// theta=0 pointing local +Y (dorsal/up).
//
// The body itself is a smooth, rounded oval loft -- three rings (nose, mid,
// peduncle) of a plain hexagonal cross-section, no pinching toward the poles.
// The dorsal, ventral and caudal (tail) fins are NOT part of that loft: each
// is a single flat double-sided triangle (the preview's material is already
// THREE.DoubleSide, so one triangle reads as a two-sided blade, no second
// face needed) poking out from the oval body to the real measured contour.
// That split is what makes the fins read as thin blades while the body stays
// a rounded torpedo: earlier attempts pinched the *whole* ring loft toward
// its poles, which either pinched the body too (losing the oval) or, at high
// segment counts, pinched so little between neighbouring vertices that no
// edge was visible at all. Splitting fin-from-body sidesteps both failure
// modes at once, and costs only 1 extra triangle per fin.
//
// Every vertex also carries `t` (0=nose, 1=tail-tip) and `bend` -- a
// swim-bend weight that grows toward the tail (see bendWeight below) -- so a
// runtime swim shader/animator can offset each vertex sideways by
// `bend * amplitude * sin(freq*time - k*z)` without needing a skeleton: the
// tail whips further than the head on the same sine wave, and the fins (whose
// t comes from their own z position) move with whichever part of the body
// they're attached to. This module only measures and tags the mesh; actually
// driving that offset each frame is a render-time concern, not this file's.
// ---------------------------------------------------------------------------

// Body-loft t-positions (nose / mid-body / peduncle, i.e. the narrow point
// just before the tail fin) and how much of the mid ring's real measured
// half-height becomes the oval body vs. is left over for the dorsal/ventral
// fins to fill in as separate triangles. Nose and peduncle use their full
// measured half-height (already thin, no fin there); only the mid ring is
// deliberately undersized relative to the real contour.
const BODY_T = [0, 0.5, 0.82]
const MID_RING_INDEX = 1
const BODY_CAP_FRACTION = 0.6 // mid ring's oval half-height = 60% of the real measured half-height there

// Tri count for a capped 3-ring loft is 2*segments*3 (two side bands of
// segments*2 each, plus segments*2 for the two single-vertex caps). Adding
// three 1-triangle fins (dorsal, ventral, caudal) on top: LOD0's 36 + 3 = 39,
// LOD1's 30 + 3 = 33.
const LOD_PARAMS = [
  { segments: 6 }, // LOD0, 39 tris (36 body + 3 fins)
  { segments: 5 }, // LOD1, 33 tris (30 body + 3 fins)
]

/** A column's {min,max} nearest to pixel x (within 30px) in a chromakey.columnProfile. */
function nearestColumn(colProfile, x) {
  for (let dx = 0; dx <= 30; dx++) {
    for (const xx of dx === 0 ? [x] : [x - dx, x + dx]) {
      const col = colProfile.cols[Math.max(colProfile.left, Math.min(colProfile.right, xx))]
      if (col) return col
    }
  }
  throw new Error(`silhouette has no column data within 30px of pixel x=${x}`)
}

function smoothstep(lo, hi, x) {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

// Lateral half-width as a fraction of the local dorsal-ventral half-height:
// ramps up fast from the nose tip, holds through the body, then eases down
// through the tail -- but never fully to zero, so the caudal peduncle/tail
// fin keeps a thin-but-real cross-section instead of collapsing to a blade
// edge. `noseFloor` keeps the very tip of the snout a small rounded lobe
// rather than a degenerate zero-width vertical line collapsing straight into
// the nose cap's point -- that degenerate line was what made the mouth read
// as a flat, sharp-edged wedge instead of a round snout. Tuned by eye against
// the three roster species' side art, not derived from anatomy references.
function bulgeFactor(t) {
  const bodyPeak = 0.62
  const noseFloor = 0.22
  const front = noseFloor + (1 - noseFloor) * smoothstep(0, 0.12, t)
  const back = 1 - smoothstep(0.55, 1, t)
  return bodyPeak * front * (0.25 + 0.75 * back)
}

// Swim-bend weight: ~0 near the head (a real fish barely bends behind the
// skull), rising through the body, steepest at the tail -- t^2 is a cheap
// stand-in for that curve, not a biomechanical model.
function bendWeight(t) { return t * t }

// One ring in the XY plane (X=lateral, Y=dorsal-ventral), stacked along Z
// (length). theta=0 points +Y (dorsal/up), matching loft-mesh.mjs's ring()
// convention of theta=0 = a fixed "up-ish" reference direction. Plain
// ellipse, no pinching -- the body is meant to read as a rounded oval; any
// knife-edge look now comes from the separate fin triangles, not from this
// loft.
function ring(cx, cy, cz, rx, ry, segments) {
  const pts = []
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2
    pts.push({ x: cx + rx * Math.sin(theta), y: cy + ry * Math.cos(theta), z: cz })
  }
  return pts
}

function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length)
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3]
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2]
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const idx3 of [a, b, c]) { n[idx3] += nx; n[idx3 + 1] += ny; n[idx3 + 2] += nz }
  }
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= len; n[i + 1] /= len; n[i + 2] /= len
  }
  return n
}

/** Real (unshifted) centre/half-height at t, in world units, straight off the silhouette. */
function measureAt(cp, pxToM, lengthM, t) {
  const x = cp.left + t * (cp.right - cp.left)
  const col = nearestColumn(cp, Math.round(x))
  const ry = (col.max - col.min) / 2 * pxToM
  const cy = -((col.min + col.max) / 2) * pxToM // pixel-y grows downward; flip so dorsal (small pixel-y) is +Y (up)
  return { t, z: (t - 0.5) * lengthM, cy, ry }
}

/**
 * Builds one LOD of a fish mesh from a side-view columnProfile.
 *
 * sideColumnProfile: from chromakey.columnProfile(alpha, w, h) on the
 * side.png view (closeRadius-keyed so it's one solid silhouette, no holes).
 * lengthM: nose-to-tail length in metres.
 * lod: 0 or 1 -- picks LOD_PARAMS.
 *
 * Returns { pos, nrm, uv, idx, t, bend, spine }. `t`/`bend` are per-vertex
 * (one entry per position, not per-component) so a swim shader can read them
 * straight off the same vertex it's displacing. `spine` is the body loft's
 * ring centreline ({z,t,bend} per ring), handy for a preview/debug overlay of
 * the bend curve without re-deriving it from the mesh.
 */
export function buildFishMesh(sideColumnProfile, { lengthM = 0.3, lod = 0 } = {}) {
  const p = LOD_PARAMS[lod]
  const cp = sideColumnProfile
  const pxToM = lengthM / (cp.right - cp.left)
  const segments = p.segments

  // Body rings: nose, mid, peduncle. Mid ring's oval half-height is capped
  // to BODY_CAP_FRACTION of its real measured half-height -- the leftover
  // (real - capped) becomes the dorsal/ventral fin height below. Nose and
  // peduncle keep their full measured half-height; they're already thin and
  // have no fin of their own.
  const rawRings = BODY_T.map((t) => measureAt(cp, pxToM, lengthM, t))
  const midFull = rawRings[MID_RING_INDEX]
  const midCapped = midFull.ry * BODY_CAP_FRACTION
  const finHeight = midFull.ry - midCapped

  // Caudal (tail) fin tip: the tallest column in the tail-fin span beyond the
  // peduncle (t > last body ring), not just the very last pixel column,
  // since the silhouette edge right at the tip can be a sliver too thin to
  // read as a fin.
  const tailSamples = [0.88, 0.92, 0.96, 1].map((t) => measureAt(cp, pxToM, lengthM, t))
  const tail = tailSamples.reduce((a, b) => (b.ry > a.ry ? b : a))

  // Centre the whole silhouette (body + fins) vertically at y=0, so the mesh
  // doesn't need the caller to know its source image's incidental framing.
  const yExtents = [
    ...rawRings.map((r) => [r.cy - r.ry, r.cy + r.ry]),
    [midFull.cy - midFull.ry, midFull.cy + midFull.ry], // dorsal/ventral fin tips reach the real extent
    [tail.cy - tail.ry, tail.cy + tail.ry],
  ].flat()
  const yShift = -(Math.min(...yExtents) + Math.max(...yExtents)) / 2

  const geo = { pos: [], uv: [], idx: [] }
  const t = [], bend = []
  const spine = []

  const pushVertex = (x, y, z, uvU, uvV, tVal) => {
    geo.pos.push(x, y + yShift, z)
    geo.uv.push(uvU, uvV)
    t.push(tVal)
    bend.push(bendWeight(tVal))
    return geo.pos.length / 3 - 1
  }

  // --- body loft: 3 rings, plain oval cross-section ---
  const ringStart = rawRings.map((r, i) => {
    const isMid = i === MID_RING_INDEX
    const ry = isMid ? midCapped : r.ry
    const rx = r.ry * bulgeFactor(r.t) // lateral bulge stays tied to the real (uncapped) contour scale
    const pts = ring(0, r.cy, r.z, rx, ry, segments)
    const start = geo.pos.length / 3
    pts.forEach((pt, s) => pushVertex(pt.x, pt.y, pt.z, s / segments, r.t, r.t))
    spine.push({ z: r.z, t: r.t, bend: bendWeight(r.t) })
    return start
  })
  for (let i = 0; i < rawRings.length - 1; i++) {
    const a = ringStart[i], bb = ringStart[i + 1]
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(a + s, bb + s, bb + s2, a + s, bb + s2, a + s2)
    }
  }

  // Nose and peduncle caps, closing the body loft. Same bottom/top cap
  // winding as loft-mesh.mjs's loftInto() -- the nose (first ring, most -Z)
  // plays "bottom", the peduncle (last ring, most +Z) plays "top", and the
  // two caps face opposite directions so their winding is deliberately
  // reversed relative to each other.
  {
    const r = rawRings[0]
    const c = pushVertex(0, r.cy, r.z, 0.5, r.t, r.t)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, ringStart[0] + s2, ringStart[0] + s)
    }
  }
  {
    const last = rawRings.length - 1
    const r = rawRings[last]
    const c = pushVertex(0, r.cy, r.z, 0.5, r.t, r.t)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, ringStart[last] + s, ringStart[last] + s2)
    }
  }

  // --- fins: each a single flat double-sided triangle (the preview material
  // is THREE.DoubleSide) poking out from the body loft's surface to the real
  // measured contour. Base = two points straddling the fin's z along the
  // body's oval surface; tip = the real silhouette extent at that point. ---
  const finBaseHalfZ = 0.08 * lengthM
  const addSpikeFin = (baseY, tipY, z) => {
    const tt = Math.min(1, Math.max(0, z / lengthM + 0.5))
    const a = pushVertex(0, baseY, z - finBaseHalfZ, 0.5, tt, tt)
    const b = pushVertex(0, baseY, z + finBaseHalfZ, 0.5, tt, tt)
    const c = pushVertex(0, tipY, z, 0.5, tt, tt)
    geo.idx.push(a, b, c)
  }
  // dorsal (up) and ventral (down), both at the mid ring where the body was capped
  addSpikeFin(midFull.cy + midCapped, midFull.cy + midCapped + finHeight, midFull.z)
  addSpikeFin(midFull.cy - midCapped, midFull.cy - midCapped - finHeight, midFull.z)
  // caudal (tail): base at the peduncle centre, tip spans the tail's full real height
  {
    const peduncle = rawRings[rawRings.length - 1]
    const tt = 1
    const base = pushVertex(0, peduncle.cy, peduncle.z, 0.5, peduncle.t, peduncle.t)
    const top = pushVertex(0, tail.cy + tail.ry, tail.z, 0.5, tt, tt)
    const bot = pushVertex(0, tail.cy - tail.ry, tail.z, 0.5, tt, tt)
    geo.idx.push(base, top, bot)
  }

  const pos = new Float32Array(geo.pos)
  const idx = geo.idx
  const nrm = computeNormals(pos, idx)

  return { pos: Array.from(pos), nrm: Array.from(nrm), uv: geo.uv, idx, t, bend, spine, lengthM }
}
