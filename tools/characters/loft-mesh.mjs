// ---------------------------------------------------------------------------
// Builds a low-poly character mesh from a front-view and side-view silhouette
// profile (chromakey.mjs). Torso+head is a real ring loft fit to the two
// silhouettes; arms and legs are proportional tapered tube primitives, not
// silhouette-fit, because a single per-row [min,max] extent can't separate
// "torso plus arm hanging at the side" into two shapes (DESIGN plan, stage 4).
//
// Every ring is built in the XZ plane stacked along Y, angle 0 = front (-Z),
// matching src/v2/render/avatar.js's "local -Z is forward" convention. That
// makes ring angle directly usable as the texture-projection axis in
// bake-texture.mjs: theta near 0 samples the front view, near +-90deg the
// side view, near 180deg the back view.
//
// Proportions (fractions of standing height) follow the standard "8 heads
// tall" figure convention, simplified. They are the single source of truth
// for bone placement too -- rig.mjs consumes `landmarks` rather than
// re-deriving these fractions, so mesh and skeleton can't drift apart.
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

const LOD_PARAMS = [
  { torsoRings: 12, torsoSeg: 10, limbRings: 5, limbSeg: 8 },  // LOD0, ~500 tris
  { torsoRings: 8, torsoSeg: 7, limbRings: 3, limbSeg: 5 },    // LOD1, ~190 tris
  { torsoRings: 5, torsoSeg: 5, limbRings: 2, limbSeg: 4 },    // LOD2, ~70 tris
]

/** Pixel half-width (front) or half-depth (side) at height fraction v in [0,1]. */
function extentAt(profile, v) {
  const y = Math.round(profile.bottom - v * (profile.bottom - profile.top))
  for (let dy = 0; dy <= 30; dy++) {
    for (const yy of dy === 0 ? [y] : [y - dy, y + dy]) {
      const row = profile.rows[Math.max(profile.top, Math.min(profile.bottom, yy))]
      if (row) return (row.max - row.min) / 2
    }
  }
  throw new Error(`silhouette has no data within 30 rows of height fraction ${v.toFixed(3)}`)
}

// One ring in the XZ plane. theta=0 is front (-Z), increasing toward +X (right side).
function ring(cx, cy, cz, rx, rz, segments) {
  const pts = []
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2
    pts.push({ x: cx + rx * Math.sin(theta), y: cy, z: cz - rz * Math.cos(theta) })
  }
  return pts
}

/**
 * Lofts a capped tube through `slices` ([{y,cx,cz,rx,rz}], bottom to top).
 * Appends into the shared pos/uv/idx arrays and returns the vertex range.
 */
function loftInto(geo, slices, segments, { capBottom, capTop, vRange }) {
  const vStart = geo.pos.length / 3
  const [v0, v1] = vRange
  slices.forEach((sl, i) => {
    const pts = ring(sl.cx, sl.y, sl.cz, sl.rx, sl.rz, segments)
    const v = v0 + (v1 - v0) * (i / (slices.length - 1))
    pts.forEach((p, s) => {
      geo.pos.push(p.x, p.y, p.z)
      geo.uv.push(s / segments, v)
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
    geo.pos.push(sl.cx, sl.y, sl.cz); geo.uv.push(0.5, v0)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, vStart + s2, vStart + s)
    }
  }
  if (capTop) {
    const c = geo.pos.length / 3
    const sl = slices[slices.length - 1]
    const base = vStart + (slices.length - 1) * segments
    geo.pos.push(sl.cx, sl.y, sl.cz); geo.uv.push(0.5, v1)
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
 * heightM: target standing height in metres.
 * lod: 0, 1, or 2 -- picks LOD_PARAMS.
 *
 * Returns { pos, nrm, uv, idx, parts, landmarks }. `parts` tags vertex ranges
 * with the bone chain that should skin them (consumed by rig.mjs); `landmarks`
 * is the set of world-space heights/half-widths rig.mjs places bones at, so
 * skeleton and mesh never disagree about proportions.
 */
export function buildCharacterMesh(frontProfile, sideProfile, { heightM = 1.7, lod = 0 } = {}) {
  const p = LOD_PARAMS[lod]
  const geo = { pos: [], uv: [], idx: [] }
  const parts = []

  const halfW = (v) => extentAt(frontProfile, v) / (frontProfile.bottom - frontProfile.top) * heightM
  const halfD = (v) => extentAt(sideProfile, v) / (sideProfile.bottom - sideProfile.top) * heightM

  const L = LANDMARK_FRAC
  const hipHalfW = halfW(L.hip), hipHalfD = halfD(L.hip)
  const shoulderHalfW = halfW(L.shoulder)

  // --- torso + head: real ring loft from the hip up to the head top -------
  const torsoSlices = []
  for (let i = 0; i < p.torsoRings; i++) {
    const v = L.hip + (L.headTop - L.hip) * (i / (p.torsoRings - 1))
    torsoSlices.push({ y: v * heightM, cx: 0, cz: 0, rx: halfW(v), rz: halfD(v) })
  }
  const torso = loftInto(geo, torsoSlices, p.torsoSeg, { capBottom: true, capTop: true, vRange: [L.hip, L.headTop] })
  parts.push({ name: 'torso', chain: ['Hips', 'Spine', 'Chest', 'Neck', 'Head'], ...torso })

  // --- arms: tapered tubes hanging straight down from the shoulder --------
  // Socket sits just inside the torso's own side surface so the two meshes
  // overlap slightly rather than leaving a gap -- invisible at this poly
  // count and texture resolution.
  const armTopY = L.shoulder * heightM
  const armBottomY = L.hip * heightM   // arms-at-sides hang to about hip height
  const armX = shoulderHalfW * 0.9
  const armR0 = shoulderHalfW * 0.32, armR1 = shoulderHalfW * 0.16
  for (const side of [1, -1]) {
    // Slices run bottom (wrist) to top (shoulder), same direction as the
    // torso loft above -- loftInto's fixed winding assumes slice index
    // increases with Y, and building these top-to-bottom (as an earlier
    // version did) turned every side-wall triangle inside out.
    const slices = []
    for (let i = 0; i < p.limbRings; i++) {
      const t = i / (p.limbRings - 1)
      const r = armR1 + (armR0 - armR1) * t
      slices.push({ y: armBottomY + (armTopY - armBottomY) * t, cx: side * armX, cz: 0, rx: r, rz: r })
    }
    const arm = loftInto(geo, slices, p.limbSeg, { capBottom: true, capTop: false, vRange: [L.hip, L.shoulder] })
    const suffix = side === 1 ? 'R' : 'L'
    parts.push({ name: `arm${suffix}`, chain: [`Shoulder${suffix}`, `UpperArm${suffix}`, `LowerArm${suffix}`, `Hand${suffix}`], ...arm })
  }

  // --- legs: tapered tubes hanging straight down from the hip -------------
  const legX = hipHalfW * 0.55
  const legR0 = hipHalfW * 0.42, legR1 = hipHalfW * 0.22
  for (const side of [1, -1]) {
    // Same bottom-to-top ordering as the arms above, for the same reason --
    // and it caps the ankle end now, so a foot isn't a hollow tube either.
    const slices = []
    for (let i = 0; i < p.limbRings; i++) {
      const t = i / (p.limbRings - 1)
      const v = L.ankle + (L.hip - L.ankle) * t
      const r = legR1 + (legR0 - legR1) * t
      slices.push({ y: v * heightM, cx: side * legX, cz: 0, rx: r, rz: r })
    }
    const leg = loftInto(geo, slices, p.limbSeg, { capBottom: true, capTop: false, vRange: [L.ankle, L.hip] })
    const suffix = side === 1 ? 'R' : 'L'
    parts.push({ name: `leg${suffix}`, chain: [`UpperLeg${suffix}`, `LowerLeg${suffix}`, `Foot${suffix}`], ...leg })
  }

  const pos = new Float32Array(geo.pos)
  const idx = geo.idx
  const nrm = computeNormals(pos, idx)

  return {
    pos: Array.from(pos), nrm: Array.from(nrm), uv: geo.uv, idx,
    parts,
    landmarks: { heightM, hipHalfW, hipHalfD, shoulderHalfW, ...L },
  }
}
