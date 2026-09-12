// ---------------------------------------------------------------------------
// Builds a swim-ready fish mesh from a single side-view columnProfile
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
// BODY AND FINS ARE SPLIT. The body is a smooth oval loft, nose to peduncle,
// following the TORSO contour: the real dorsal and ventral contours with the
// fins taken off by a morphological opening (erode then dilate, FIN_WINDOW
// wide in t). An opening leaves anything wider than the window -- the torso's
// own hump, the nose and peduncle slopes -- exactly as it was, and flattens
// anything narrower: the fins. Whatever the real contour rises above the torso
// is a fin, and every fin is a flat double-sided strip of quads in the x=0
// plane, from the body's surface out to the real contour, one quad per body
// ring across the fin's span. The caudal fin is the same kind of strip, from
// the peduncle to the tail tip. The strips overshoot the painted fin a little
// (the tip is a max over the ring's own span of t) and the runtime material's
// alpha cutout trims them back to the art. Lofting the fins into the rings
// instead would fatten the body under the dorsal fin and pinch the tail into
// a knife edge at once; the split keeps the torpedo round and the fins thin.
//
// Every vertex also carries `t` (0=nose, 1=tail-tip) and `bend` -- a
// swim-bend weight that grows toward the tail (see bendWeight below) -- so a
// runtime swim shader can offset each vertex sideways by
// `bend * amplitude * sin(freq*time - k*z)` without needing a skeleton: the
// tail whips further than the head on the same sine wave, and the fins (whose
// t comes from their own z position) move with whichever part of the body
// they're attached to. This module only measures and tags the mesh; actually
// driving that offset each frame is a render-time concern, not this file's.
// ---------------------------------------------------------------------------

// Body-loft ring positions as fractions of the nose-to-peduncle span (the
// peduncle itself is found on the silhouette, see buildFishMesh). Denser
// toward the nose, where the contour turns fastest.
const BODY_FRAC = [0, 0.05, 0.11, 0.18, 0.27, 0.37, 0.47, 0.57, 0.67, 0.78, 0.89, 1]
const BODY_FRAC_LOD1 = [0, 0.16, 0.32, 0.5, 0.66, 0.82, 1]

// Body tris for an N-ring capped loft are 2*segments*N; the fin strips add
// two per ring they span, so LOD0 lands near 12*10*2 + ~20 = ~260 tris and
// LOD1 near 7*6*2 + ~14 = ~100. `caudal` is the number of strip steps from
// the peduncle to the tail tip.
const LOD_PARAMS = [
  { bodyFrac: BODY_FRAC, segments: 10, caudal: 4 },     // LOD0, the world's
  { bodyFrac: BODY_FRAC_LOD1, segments: 6, caudal: 2 }, // LOD1, gen-fish.html's ?lod=1 only
]

// The peduncle (the narrowest column before the tail fin) is searched for in this span of t.
const PEDUNCLE_SPAN = [0.68, 0.92]
// Half-width, in t, of the opening that separates fins from torso: a bump narrower than twice this is a fin.
const FIN_WINDOW = 0.14
// A fin strip is only built where the real contour clears the torso by this fraction of the length.
const FIN_MIN = 0.012

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
// through the tail -- but never fully to zero, so the caudal peduncle keeps a
// thin-but-real cross-section instead of collapsing to a blade edge.
// `noseFloor` keeps the very tip of the snout a small rounded lobe rather than
// a degenerate zero-width vertical line collapsing straight into the nose
// cap's point -- that degenerate line was what made the mouth read as a flat,
// sharp-edged wedge instead of a round snout. Tuned by eye against the three
// roster species' side art, not derived from anatomy references.
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
// knife-edge look comes from the separate fin strips, not from this loft.
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

// Sliding min or max over +-w samples, edges clamped.
function slide(arr, w, pick) {
  const out = new Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i]
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) v = pick(v, arr[j])
    out[i] = v
  }
  return out
}
const opening = (arr, w) => slide(slide(arr, w, Math.min), w, Math.max)

/**
 * Builds one LOD of a fish mesh from a side-view columnProfile.
 *
 * sideColumnProfile: from chromakey.columnProfile(alpha, w, h) on the
 * side.png view (closeRadius-keyed so it's one solid silhouette, no holes).
 * lengthM: nose-to-tail length in metres.
 * lod: 0 or 1 -- picks LOD_PARAMS.
 *
 * Returns { pos, nrm, uv, idx, t, bend, spine, lengthM, yShift, pxToM }. `t`/`bend` are per-vertex
 * (one entry per position, not per-component) so a swim shader can read them
 * straight off the same vertex it's displacing. `spine` is the body loft's
 * ring centreline ({z,t,bend} per ring), handy for a preview/debug overlay of
 * the bend curve without re-deriving it from the mesh.
 */
export function buildFishMesh(sideColumnProfile, { lengthM = 0.3, lod = 0 } = {}) {
  const p = LOD_PARAMS[lod]
  const cp = sideColumnProfile
  const cols = cp.right - cp.left
  const pxToM = lengthM / cols
  const segments = p.segments

  // The real contour, one sample per source column, as dorsal and ventral extents in metres (both positive: up, and down, from image y=0).
  const top = [], bot = []
  for (let i = 0; i <= cols; i++) {
    const col = nearestColumn(cp, cp.left + i)
    top.push(-col.min * pxToM) // pixel-y grows downward; flip so dorsal (small pixel-y) is up
    bot.push(col.max * pxToM)
  }
  const tOf = (i) => i / cols
  const iOf = (t) => Math.round(t * cols)
  const zOf = (t) => (t - 0.5) * lengthM

  // The peduncle: the thinnest column in PEDUNCLE_SPAN. Body rings stop here; the caudal strip starts here.
  let ped = iOf(PEDUNCLE_SPAN[0])
  for (let i = ped; i <= iOf(PEDUNCLE_SPAN[1]); i++) {
    if (top[i] + bot[i] < top[ped] + bot[ped]) ped = i
  }

  // The torso: the body span's contours with the fins opened off.
  const w = Math.round(FIN_WINDOW * cols)
  const torsoTop = opening(top.slice(0, ped + 1), w)
  const torsoBot = opening(bot.slice(0, ped + 1), w)

  // Centre the whole silhouette (body + fins) vertically at y=0, so the mesh
  // doesn't need the caller to know its source image's incidental framing.
  const yShift = -(Math.max(...top) - Math.max(...bot)) / 2

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

  // --- body loft: plain oval rings on the torso contour ---
  const rings = p.bodyFrac.map((frac) => {
    const i = Math.round(frac * ped)
    const tt = tOf(i)
    const cy = (torsoTop[i] - torsoBot[i]) / 2
    const ry = (torsoTop[i] + torsoBot[i]) / 2
    return { i, t: tt, z: zOf(tt), cy, ry, rx: ry * bulgeFactor(tt) }
  })
  const ringStart = rings.map((r) => {
    const start = geo.pos.length / 3
    ring(0, r.cy, r.z, r.rx, r.ry, segments).forEach((pt, s) => pushVertex(pt.x, pt.y, pt.z, s / segments, r.t, r.t))
    spine.push({ z: r.z, t: r.t, bend: bendWeight(r.t) })
    return start
  })
  for (let i = 0; i < rings.length - 1; i++) {
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
    const r = rings[0]
    const c = pushVertex(0, r.cy, r.z, 0.5, r.t, r.t)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, ringStart[0] + s2, ringStart[0] + s)
    }
  }
  {
    const last = rings.length - 1
    const r = rings[last]
    const c = pushVertex(0, r.cy, r.z, 0.5, r.t, r.t)
    for (let s = 0; s < segments; s++) {
      const s2 = (s + 1) % segments
      geo.idx.push(c, ringStart[last] + s, ringStart[last] + s2)
    }
  }

  // --- fin strips: quads in the x=0 plane between successive (base, tip)
  // pairs. A step whose two pairs coincide at the base is skipped, so a strip
  // tapers to a triangle at each end instead of carrying a zero-area quad. ---
  const strip = (pairs) => {
    const verts = pairs.map(([base, tip, tt]) => [pushVertex(0, base.y, base.z, 0.5, tt, tt), pushVertex(0, tip.y, tip.z, 0.5, tt, tt)])
    for (let i = 0; i < verts.length - 1; i++) {
      const [a0, a1] = verts[i], [b0, b1] = verts[i + 1]
      if (pairs[i][0].y !== pairs[i][1].y) geo.idx.push(a0, a1, b1)
      if (pairs[i + 1][0].y !== pairs[i + 1][1].y) geo.idx.push(a0, b1, b0)
    }
  }
  // The tip at a ring is the real contour's extreme over that ring's own half-spans, so the strip covers the painted fin between rings too.
  const extreme = (arr, lo, hi) => { let v = arr[lo]; for (let i = lo; i <= hi; i++) v = Math.max(v, arr[i]); return v }
  const finMin = FIN_MIN * lengthM
  for (const side of [1, -1]) {
    const real = side > 0 ? top : bot
    const torso = side > 0 ? torsoTop : torsoBot
    const tips = rings.map((ring, r) => {
      const lo = r === 0 ? ring.i : Math.round((rings[r - 1].i + ring.i) / 2)
      const hi = r === rings.length - 1 ? ring.i : Math.round((ring.i + rings[r + 1].i) / 2)
      return extreme(real, lo, hi)
    })
    // Rings the fin spans, padded by one ring each side so the strip tapers back onto the body.
    const has = rings.map((r, k) => tips[k] - torso[r.i] > finMin)
    let k = 0
    while (k < rings.length) {
      if (!has[k]) { k++; continue }
      let end = k
      while (end + 1 < rings.length && has[end + 1]) end++
      const pairs = []
      for (let r = Math.max(0, k - 1); r <= Math.min(rings.length - 1, end + 1); r++) {
        const ring = rings[r]
        pairs.push([{ y: side * torso[ring.i], z: ring.z }, { y: side * (has[r] ? tips[r] : torso[ring.i]), z: ring.z }, ring.t])
      }
      strip(pairs)
      k = end + 1
    }
  }
  // Caudal fin: from the peduncle's own surface to the tail tip, both edges on the real contour.
  {
    const pairs = []
    for (let s = 0; s <= p.caudal; s++) {
      const i = Math.round(ped + (cols - ped) * s / p.caudal)
      const lo = s === 0 ? i : Math.round(ped + (cols - ped) * (s - 0.5) / p.caudal)
      const hi = s === p.caudal ? i : Math.round(ped + (cols - ped) * (s + 0.5) / p.caudal)
      const tt = tOf(i)
      const up = s === 0 ? torsoTop[ped] : extreme(top, lo, hi)
      const down = s === 0 ? torsoBot[ped] : extreme(bot, lo, hi)
      pairs.push([{ y: -down, z: zOf(tt) }, { y: up, z: zOf(tt) }, tt])
    }
    strip(pairs)
  }

  const pos = new Float32Array(geo.pos)
  const idx = geo.idx
  const nrm = computeNormals(pos, idx)

  // yShift and pxToM let a caller map a vertex back onto the source image (ship.mjs's side-projected UVs).
  return { pos: Array.from(pos), nrm: Array.from(nrm), uv: geo.uv, idx, t, bend, spine, lengthM, yShift, pxToM }
}
