// ---------------------------------------------------------------------------
// Builds a low-poly character mesh from a front-view and side-view silhouette
// profile (chromakey.mjs), plus a front-view columnProfile (also
// chromakey.mjs). The character stands in a T-pose, which separates the arm
// from the torso as its own blob in the front silhouette the same way the
// legs already are -- so arms are measured directly via a per-column scan
// (armSlice() below), not approximated by subtracting an assumed torso
// width. Legs are gap-aware too: silhouetteProfile() reports each row's
// internal transparent run (the space between two legs), so legPlacement()
// below can split a row into two real blobs instead of assuming they meet at
// the centreline.
//
// A ring lies either in the XZ plane stacked along Y (torso/head/legs -- see
// ring()) or in the YZ plane stacked along X (arms, since a T-pose arm's
// long axis is horizontal -- see ringYZ()); loftInto() below picks per slice
// via `sl.axis`. Either way, angle 0 = front (-Z), matching
// src/v2/render/avatar.js's "local -Z is forward" convention. That makes
// ring angle directly usable as the texture-projection axis in
// bake-texture.mjs: theta near 0 samples the front view, near +-90deg the
// side view, near 180deg the back view.
//
// Proportions (fractions of standing height) follow the standard "8 heads
// tall" figure convention, simplified. They are the single source of truth
// for bone placement too -- rig.mjs consumes `landmarks` (including the
// armX/armY/legPlacement placement functions below) rather than re-deriving
// these fractions or positions itself, so mesh and skeleton can't drift
// apart.
// ---------------------------------------------------------------------------

const LANDMARK_FRAC = {
  ankle: 0.04,
  knee: 0.28,
  hip: 0.50,     // torso loft's bottom ring; also the leg tubes' top
  spine: 0.63,
  chest: 0.74,
  shoulder: 0.83,
  neck: 0.88,
  headTop: 1.00,
}

// Rings-per-unit-height in the head band (neck->headTop) relative to the
// body band (hip->neck), so the face gets roughly this many times the ring
// density of the rest of the torso -- geometry detail where it matters most,
// since the face's actual visual fidelity mostly comes from the baked
// texture, not raw topology.
const HEAD_RING_DENSITY = 3

const LOD_PARAMS = [
  { torsoRings: 20, torsoSeg: 14, limbRings: 6, limbSeg: 10 },  // LOD0, ~900 tris
  { torsoRings: 10, torsoSeg: 8, limbRings: 4, limbSeg: 6 },    // LOD1, ~330 tris
  { torsoRings: 6, torsoSeg: 6, limbRings: 2, limbSeg: 4 },     // LOD2, ~110 tris
]

/** A row's full {min,max,gapMin,gapMax} at height fraction v in [0,1] (nearest non-empty row within 30px). */
function extentAtRow(profile, v) {
  const y = Math.round(profile.bottom - v * (profile.bottom - profile.top))
  for (let dy = 0; dy <= 30; dy++) {
    for (const yy of dy === 0 ? [y] : [y - dy, y + dy]) {
      const row = profile.rows[Math.max(profile.top, Math.min(profile.bottom, yy))]
      if (row) return row
    }
  }
  throw new Error(`silhouette has no data within 30 rows of height fraction ${v.toFixed(3)}`)
}

/** Pixel half-width (front) or half-depth (side) at height fraction v in [0,1]. */
function extentAt(profile, v) {
  const row = extentAtRow(profile, v)
  return (row.max - row.min) / 2
}

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

// One ring in the XZ plane, stacked along Y (torso/head/legs). theta=0 is front (-Z), increasing toward +X (right side).
function ring(cx, cy, cz, rx, rz, segments) {
  const pts = []
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2
    pts.push({ x: cx + rx * Math.sin(theta), y: cy, z: cz - rz * Math.cos(theta) })
  }
  return pts
}

// One ring in the YZ plane, stacked along X (arms, T-pose). Same theta
// convention as ring() (0 = front/-Z), axes relabeled so a horizontal tube
// still projects the same way in bake-texture.mjs.
function ringYZ(cx, cy, cz, ry, rz, segments) {
  const pts = []
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2
    pts.push({ x: cx, y: cy + ry * Math.sin(theta), z: cz - rz * Math.cos(theta) })
  }
  return pts
}

function centerOf(sl) {
  return sl.axis === 'x' ? [sl.x, sl.cy, sl.cz] : [sl.cx, sl.y, sl.cz]
}

/**
 * Lofts a capped tube through `slices`, first to last. Each slice is either
 * `{y,cx,cz,rx,rz,v}` (vertical, the default) or `{axis:'x',x,cy,cz,ry,rz,v}`
 * (horizontal, for arms). `v` is each slice's own texture-height fraction
 * (NOT derived from its index) so slices can be spaced non-uniformly --
 * denser near the head, or an exact ring at a joint -- without desyncing the
 * UV projection. Appends into the shared pos/uv/idx arrays and returns the
 * vertex range.
 */
function loftInto(geo, slices, segments, { capBottom, capTop }) {
  const vStart = geo.pos.length / 3
  slices.forEach((sl) => {
    const pts = sl.axis === 'x'
      ? ringYZ(sl.x, sl.cy, sl.cz, sl.ry, sl.rz, segments)
      : ring(sl.cx, sl.y, sl.cz, sl.rx, sl.rz, segments)
    pts.forEach((p, s) => {
      geo.pos.push(p.x, p.y, p.z)
      geo.uv.push(s / segments, sl.v)
    })
  })
  for (let i = 0; i < slices.length - 1; i++) {
    const a = vStart + i * segments, b = vStart + (i + 1) * segments
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(a + s, b + s, b + s2, a + s, b + s2, a + s2)
    }
  }
  if (capBottom) {
    const c = geo.pos.length / 3
    const sl = slices[0]
    const [cx, cy, cz] = centerOf(sl)
    geo.pos.push(cx, cy, cz); geo.uv.push(0.5, sl.v)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, vStart + s2, vStart + s)
    }
  }
  if (capTop) {
    const c = geo.pos.length / 3
    const sl = slices[slices.length - 1]
    const [cx, cy, cz] = centerOf(sl)
    const base = vStart + (slices.length - 1) * segments
    geo.pos.push(cx, cy, cz); geo.uv.push(0.5, sl.v)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, base + s, base + s2)
    }
  }
  return { vStart, vCount: geo.pos.length / 3 - vStart }
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

/**
 * Builds one LOD of the character mesh.
 *
 * frontProfile/sideProfile: from chromakey.silhouetteProfile, front and side views.
 * frontColumnProfile: from chromakey.columnProfile, front view -- the
 * per-column scan a T-pose arm's horizontal loft measures against.
 * heightM: target standing height in metres.
 * lod: 0, 1, or 2 -- picks LOD_PARAMS.
 *
 * Returns { pos, nrm, uv, idx, parts, landmarks }. `parts` tags vertex ranges
 * with the bone chain that should skin them (consumed by rig.mjs); `landmarks`
 * is the set of world-space heights/half-widths rig.mjs places bones at, so
 * skeleton and mesh never disagree about proportions.
 */
export function buildCharacterMesh(frontProfile, sideProfile, frontColumnProfile, { heightM = 1.7, lod = 0 } = {}) {
  const p = LOD_PARAMS[lod]
  const geo = { pos: [], uv: [], idx: [] }
  const parts = []

  const halfW = (v) => extentAt(frontProfile, v) / (frontProfile.bottom - frontProfile.top) * heightM
  const halfD = (v) => extentAt(sideProfile, v) / (sideProfile.bottom - sideProfile.top) * heightM

  const L = LANDMARK_FRAC
  const hipHalfW = halfW(L.hip), hipHalfD = halfD(L.hip)
  const shoulderHalfW = halfW(L.shoulder)
  const neckHalfW = halfW(L.neck)

  // --- torso + head: real ring loft, denser near the head ------------------
  // Two contiguous bands (hip->neck, neck->headTop) sharing a ring at the
  // neck, with the head band getting HEAD_RING_DENSITY-times the ring
  // density per unit height of the body band -- roughly doubles (here, ~3x)
  // the face's geometric resolution without a variable-segment seam.
  const bodyLen = L.neck - L.hip, headLen = L.headTop - L.neck
  const bodyWeight = bodyLen, headWeight = headLen * HEAD_RING_DENSITY
  let headRings = Math.max(3, Math.round(p.torsoRings * headWeight / (bodyWeight + headWeight)))
  let bodyRings = Math.max(3, p.torsoRings - headRings + 1)
  headRings = p.torsoRings - bodyRings + 1

  const torsoSlices = []
  for (let i = 0; i < bodyRings; i++) {
    const v = L.hip + bodyLen * (i / (bodyRings - 1))
    torsoSlices.push({ y: v * heightM, cx: 0, cz: 0, rx: halfW(v), rz: halfD(v), v })
  }
  for (let i = 1; i < headRings; i++) {
    const v = L.neck + headLen * (i / (headRings - 1))
    torsoSlices.push({ y: v * heightM, cx: 0, cz: 0, rx: halfW(v), rz: halfD(v), v })
  }
  const torso = loftInto(geo, torsoSlices, p.torsoSeg, { capBottom: true, capTop: true })
  parts.push({ name: 'torso', chain: ['Hips', 'Spine', 'Chest', 'Neck', 'Head'], ...torso })

  // --- arms: horizontal T-pose loft, measured directly from a column scan -
  // In a T-pose the arm's long axis runs along X, so its shape comes from
  // frontColumnProfile (chromakey.mjs's per-column [minY,maxY] scan), not
  // the per-row [minX,maxX] scan halfW/halfD use for everything else here.
  // armAttachX (where the shoulder ball-joint sits) needs a heuristic --
  // torso-only rows (chest, neck) bracket shoulder height, interpolated the
  // same style of estimate round 1 used for the whole arm, but now only
  // load-bearing for one endpoint.
  //
  // armTipX does NOT assume a strict horizontal arm (the generated art
  // reliably comes back closer to a relaxed reference pose -- arms angled
  // down 30-40deg from horizontal -- than a literal T, verified against
  // actual chroma-keyed candidates): it's the column profile's own outermost
  // non-empty column on the given side, i.e. the true widest point of the
  // whole figure, which is the fingertip for any arms-out pose regardless
  // of the exact angle (a shoulder-height row's own width, tried first,
  // badly undershoots once the hand droops below shoulder height).
  const frontScale = heightM / (frontProfile.bottom - frontProfile.top)
  // A single pixel column represents world X=0 across the whole image (the
  // figure's own vertical symmetry axis) -- estimated from the hip row's own
  // centre, a reliably torso-only (arm-free) row.
  const hipRow = extentAtRow(frontProfile, L.hip)
  const centerPx = (hipRow.min + hipRow.max) / 2
  const pxOfWorldX = (x) => centerPx + x / frontScale

  const armAttachX = (halfW(L.chest) + halfW(L.neck)) / 2
  const armTipX = ((frontColumnProfile.right - centerPx) + (centerPx - frontColumnProfile.left)) / 2 * frontScale
  const elbowArmX = (armAttachX + armTipX) / 2

  // Unsigned world-X at arm length-fraction t (0 = shoulder attach, 0.5 =
  // elbow, 1 = fingertip) -- shared by the mesh loft below and rig.mjs's
  // bone placement (landmarks.armX), so they can't drift apart.
  const armPointX = (t) => t <= 0.5
    ? armAttachX + (elbowArmX - armAttachX) * (t / 0.5)
    : elbowArmX + (armTipX - elbowArmX) * ((t - 0.5) / 0.5)
  // World-Y of the arm's own centreline at length-fraction t, read from the
  // real column scan (nearly constant across a T-pose arm, but real).
  const armPointY = (t) => {
    const col = nearestColumn(frontColumnProfile, Math.round(pxOfWorldX(armPointX(t))))
    return (frontProfile.bottom - (col.min + col.max) / 2) * frontScale
  }
  const armX = (t, side) => side * armPointX(t)
  const armY = armPointY

  function armSlice(side, t) {
    const x = armPointX(t)
    const col = nearestColumn(frontColumnProfile, Math.round(pxOfWorldX(x)))
    const cy = (frontProfile.bottom - (col.min + col.max) / 2) * frontScale
    const ry = (col.max - col.min) / 2 * frontScale
    // Depth: a side-view row at arm height is the (foreshortened) end-on
    // view of the arm, not useful -- keep a circular cross-section, same as
    // round 1's arms did.
    return { axis: 'x', x: side * x, cy, cz: 0, ry, rz: ry, v: cy / heightM }
  }

  const armRingsPerSpan = Math.max(2, Math.ceil(p.limbRings / 2))
  for (const side of [1, -1]) {
    // Slices run shoulder attach (hidden inside the torso, open) to
    // fingertip (a visible capped end) -- loftInto's fixed winding just
    // connects consecutive slices by index, direction doesn't matter here.
    const slices = []
    for (let i = 0; i < armRingsPerSpan; i++) slices.push(armSlice(side, 0.5 * (i / (armRingsPerSpan - 1))))
    for (let i = 1; i < armRingsPerSpan; i++) slices.push(armSlice(side, 0.5 + 0.5 * (i / (armRingsPerSpan - 1))))
    const arm = loftInto(geo, slices, p.limbSeg, { capBottom: false, capTop: true })
    const suffix = side === 1 ? 'R' : 'L'
    parts.push({ name: `arm${suffix}`, chain: [`Shoulder${suffix}`, `UpperArm${suffix}`, `LowerArm${suffix}`, `Hand${suffix}`], ...arm })
  }

  // --- legs: gap-aware, side-informed placement through an explicit knee --
  // A row's internal transparent run (silhouetteProfile's gapMin/gapMax) is
  // a real gap between the two legs where one exists (ankle up through
  // roughly mid-thigh); above that it closes and legs are assumed symmetric
  // about the centreline, same as round 1. Depth (rz) is read straight from
  // the side profile instead of forced equal to the front-derived radius --
  // this is what turns the ankle cap into a foot-shaped oval (toe to heel)
  // instead of a round stump.
  function legPlacement(v) {
    const row = extentAtRow(frontProfile, v)
    const rowCenterPx = (row.min + row.max) / 2
    const rz = halfD(v)
    const symX = halfW(v) / 2, symR = halfW(v) / 2
    if (row.gapMin == null) return { L: { x: -symX, r: symR, rz }, R: { x: symX, r: symR, rz } }

    // Blend between the two real blobs and the symmetric fallback by gap
    // width, so the mesh doesn't visibly kink where the gap closes.
    const blend = Math.min(1, Math.max(0, (row.gapMax - row.gapMin - 10) / (40 - 10)))
    const toWorld = (min, max) => ({ x: ((min + max) / 2 - rowCenterPx) * frontScale, r: (max - min) / 2 * frontScale })
    const a = toWorld(row.min, row.gapMin), b = toWorld(row.gapMax, row.max)
    const [left, right] = a.x <= b.x ? [a, b] : [b, a]
    const lerpV = (x, y, t) => x + (y - x) * t
    return {
      L: { x: lerpV(-symX, left.x, blend), r: lerpV(symR, left.r, blend), rz },
      R: { x: lerpV(symX, right.x, blend), r: lerpV(symR, right.r, blend), rz },
    }
  }

  const legRingsPerSpan = Math.max(2, Math.ceil(p.limbRings / 2))
  for (const side of [1, -1]) {
    const suffix = side === 1 ? 'R' : 'L'
    // Same bottom-to-top ordering as before -- and it caps the ankle end, so
    // a foot isn't a hollow tube either.
    const slices = []
    for (let i = 0; i < legRingsPerSpan; i++) {
      const v = L.ankle + (L.knee - L.ankle) * (i / (legRingsPerSpan - 1))
      const leg = legPlacement(v)[suffix]
      slices.push({ y: v * heightM, cx: leg.x, cz: 0, rx: leg.r, rz: leg.rz, v })
    }
    for (let i = 1; i < legRingsPerSpan; i++) {
      const v = L.knee + (L.hip - L.knee) * (i / (legRingsPerSpan - 1))
      const leg = legPlacement(v)[suffix]
      slices.push({ y: v * heightM, cx: leg.x, cz: 0, rx: leg.r, rz: leg.rz, v })
    }
    const leg = loftInto(geo, slices, p.limbSeg, { capBottom: true, capTop: false })
    parts.push({ name: `leg${suffix}`, chain: [`UpperLeg${suffix}`, `LowerLeg${suffix}`, `Foot${suffix}`], ...leg })
  }

  const pos = new Float32Array(geo.pos)
  const idx = geo.idx
  const nrm = computeNormals(pos, idx)

  return {
    pos: Array.from(pos), nrm: Array.from(nrm), uv: geo.uv, idx,
    parts,
    landmarks: { heightM, hipHalfW, hipHalfD, shoulderHalfW, neckHalfW, armX, armY, legPlacement, ...L },
  }
}
