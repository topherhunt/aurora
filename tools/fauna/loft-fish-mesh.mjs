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
// Every ring also carries `t` (0=nose, 1=tail-tip) and `bend` -- a swim-bend
// weight that grows toward the tail (see bendWeight below) -- as a per-vertex
// attribute, so a runtime swim shader/animator can offset each vertex
// sideways by `bend * amplitude * sin(freq*time - k*z)` without needing a
// skeleton: the tail whips further than the head on the same sine wave. This
// module only measures and tags the mesh; actually driving that offset each
// frame is a render-time concern, not this file's.
// ---------------------------------------------------------------------------

const LOD_PARAMS = [
  { rings: 20, segments: 14 }, // LOD0, ~510 tris
  { rings: 10, segments: 8 },  // LOD1, ~140 tris
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

// How sharply the ring's lateral (X) extent pinches in toward the dorsal and
// ventral poles (theta=0 and theta=pi). 1 = plain ellipse (sin/cos); above 1
// pinches faster, so the dorsal/ventral silhouette -- where the real fin
// actually lives -- reads as a thin knife-edge blade instead of a rounded
// torpedo cross-section, while the belly/flank (near theta=+-90deg, where
// sin(theta) is near +-1 either way) keeps its full rounded body width.
const RING_PINCH = 1.7

// One ring in the XY plane (X=lateral, Y=dorsal-ventral), stacked along Z
// (length). theta=0 points +Y (dorsal/up), matching loft-mesh.mjs's ring()
// convention of theta=0 = a fixed "up-ish" reference direction.
function ring(cx, cy, cz, rx, ry, segments) {
  const pts = []
  for (let s = 0; s < segments; s++) {
    const theta = (s / segments) * Math.PI * 2
    const sinT = Math.sin(theta)
    const xShape = Math.sign(sinT) * Math.abs(sinT) ** RING_PINCH
    pts.push({ x: cx + rx * xShape, y: cy + ry * Math.cos(theta), z: cz })
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
 * straight off the same vertex it's displacing. `spine` is the ring
 * centreline itself ({z,t,bend} per ring), handy for a preview/debug overlay
 * of the bend curve without re-deriving it from the mesh.
 */
export function buildFishMesh(sideColumnProfile, { lengthM = 0.3, lod = 0 } = {}) {
  const p = LOD_PARAMS[lod]
  const cp = sideColumnProfile
  const pxToM = lengthM / (cp.right - cp.left)

  // First pass: per-ring centre/half-height in world units, unshifted.
  const rawRings = []
  for (let i = 0; i < p.rings; i++) {
    const t = i / (p.rings - 1)
    const x = cp.left + t * (cp.right - cp.left)
    const col = nearestColumn(cp, Math.round(x))
    const ry = (col.max - col.min) / 2 * pxToM
    const cy = -((col.min + col.max) / 2) * pxToM // pixel-y grows downward; flip so dorsal (small pixel-y) is +Y (up)
    rawRings.push({ t, z: (t - 0.5) * lengthM, cy, ry })
  }

  // Centre the whole silhouette vertically at y=0 (nose-to-tail centroid of
  // its own bounding box), so the mesh doesn't need the caller to know its
  // source image's incidental vertical framing.
  let yMin = Infinity, yMax = -Infinity
  for (const r of rawRings) { yMin = Math.min(yMin, r.cy - r.ry); yMax = Math.max(yMax, r.cy + r.ry) }
  const yShift = -(yMin + yMax) / 2

  const geo = { pos: [], uv: [], idx: [] }
  const t = [], bend = []
  const spine = []

  const vStart0 = 0
  rawRings.forEach((r, i) => {
    const cy = r.cy + yShift
    const rx = r.ry * bulgeFactor(r.t)
    const b = bendWeight(r.t)
    const pts = ring(0, cy, r.z, rx, r.ry, p.segments)
    pts.forEach((pt, s) => {
      geo.pos.push(pt.x, pt.y, pt.z)
      geo.uv.push(s / p.segments, r.t)
      t.push(r.t)
      bend.push(b)
    })
    spine.push({ z: r.z, t: r.t, bend: b })
    if (i < rawRings.length - 1) {
      const a = vStart0 + i * p.segments, bb = vStart0 + (i + 1) * p.segments
      for (let s = 0; s < p.segments; s++) {
        const s2 = (s + 1) % p.segments
        geo.idx.push(a + s, bb + s, bb + s2, a + s, bb + s2, a + s2)
      }
    }
  })

  // Cap nose and tail so the mesh is closed (a fish is not a hollow tube).
  // Same bottom/top cap winding as loft-mesh.mjs's loftInto() -- the nose
  // (first ring, most -Z) plays "bottom", the tail (last ring, most +Z)
  // plays "top", and the two caps face opposite directions so their winding
  // is deliberately reversed relative to each other.
  {
    const r = rawRings[0]
    const c = geo.pos.length / 3
    geo.pos.push(0, r.cy + yShift, r.z); geo.uv.push(0.5, r.t)
    t.push(r.t); bend.push(bendWeight(r.t))
    for (let s = 0; s < p.segments; s++) {
      const s2 = (s + 1) % p.segments
      geo.idx.push(c, vStart0 + s2, vStart0 + s)
    }
  }
  {
    const r = rawRings[rawRings.length - 1]
    const c = geo.pos.length / 3
    geo.pos.push(0, r.cy + yShift, r.z); geo.uv.push(0.5, r.t)
    t.push(r.t); bend.push(bendWeight(r.t))
    const base = vStart0 + (rawRings.length - 1) * p.segments
    for (let s = 0; s < p.segments; s++) {
      const s2 = (s + 1) % p.segments
      geo.idx.push(c, base + s, base + s2)
    }
  }

  const pos = new Float32Array(geo.pos)
  const idx = geo.idx
  const nrm = computeNormals(pos, idx)

  return { pos: Array.from(pos), nrm: Array.from(nrm), uv: geo.uv, idx, t, bend, spine, lengthM }
}
