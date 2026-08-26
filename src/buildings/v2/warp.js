import { hash } from '../parts.js'

// ---------------------------------------------------------------------------
// The warp field: v2's answer to "everything is too straight".
//
// THE ONE IDEA IN THIS FILE. A warp that is a pure function of POSITION --
// f(x,y,z) -> (x',y',z'), continuous, deterministic, with no knowledge of which
// part it is bending -- preserves every invariant the kit is gated on, for
// free:
//
//   * Airtightness survives exactly. Two vertices that were coincident had the
//     same input, so they get the same output and are still coincident. The
//     directed-edge count is untouched. This is the whole reason the warp is a
//     field over space rather than a per-part jitter: per-part jitter has to be
//     threaded through every seam by hand and gets one of them wrong.
//   * Winding survives. A displacement small against the local feature size
//     cannot turn a face inside out, so signed volume stays positive.
//   * UVs survive, and should NOT be warped. They are computed from unwarped
//     world extents, so texel density stays uniform; warping them too would
//     smear the tile exactly where the geometry is most interesting.
//
// So the warp is a POST-PASS over the finished vertex array, and the normals
// are recomputed afterwards -- by smoothNormals() below rather than by
// three.js's computeVertexNormals(), for the reason set out there.
//
// WHAT THE FIELD CANNOT DO, and why half of parts.js still had to be rewritten:
// a warp can only bend geometry that HAS VERTICES TO BEND. A wall drawn as one
// quad has four corners and no middle, so the field translates and shears it
// and cannot bow it. Every part that is meant to read as buckled, sagging or
// off-kilter in v2 therefore carries interior vertices it did not have in v1 --
// the roof grid, the subdivided wall, the segmented post. The field supplies
// the irregularity; the subdivision is what lets it land.
// ---------------------------------------------------------------------------

/** A hash of three integer lattice coordinates. Mixed pairwise rather than
 *  xor-folded into one index, because a plain xor of small ints collides
 *  visibly along the diagonals -- which shows up as a warp that is stronger on
 *  the corners of a building than on its faces. */
function hash3(seed, ix, iy, iz) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 13), 0x9e3779b1) ^ Math.imul(iz | 0, 0x85ebca6b)
  return hash(seed, h ^ (h >>> 16))
}

/** Value noise on a unit lattice, smoothstep-interpolated, in -1..1. */
function vnoise(seed, x, y, z) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const sz = fz * fz * (3 - 2 * fz)
  let v = 0
  for (let k = 0; k < 8; k++) {
    const dx = k & 1
    const dy = (k >> 1) & 1
    const dz = (k >> 2) & 1
    const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz)
    v += w * hash3(seed, ix + dx, iy + dy, iz + dz)
  }
  return v * 2 - 1
}

/**
 * The per-building personality.
 *
 * Drawn once from the seed and passed to every part, so a building is warped,
 * leaned, sagged and flared as ONE object with one character rather than as a
 * pile of independently wobbly components. That distinction is most of what
 * separates "hand-built" from "noisy": a real crooked house is crooked in a
 * consistent direction, because it settled that way.
 *
 * `strength` scales the whole personality at once and is what the previewer's
 * one master slider drives. At 0 every term below is zero and v2 builds exactly
 * the straight thing v1 does, which is the control case worth being able to see.
 */
export function makeCharacter(seed, strength = 1) {
  const r = (i) => hash(seed * 977 + 13, i)
  const sym = (i) => (r(i) - 0.5) * 2
  const s = strength
  return {
    seed,
    strength: s,
    // Field displacement. Two octaves: the coarse one bows a whole wall, the
    // fine one takes the machine edge off a member without moving it anywhere.
    amp: 0.055 * s,
    scale: 3.4,
    amp2: 0.019 * s,
    scale2: 1.15,
    // Settle: the whole building leans, growing with height. Superlinear, so
    // the eaves lean noticeably while the plinth stays put -- which is what an
    // old timber frame actually does, and what a linear shear does not look
    // like.
    leanX: sym(1) * 0.021 * s,
    leanZ: sym(2) * 0.021 * s,
    leanPow: 1.35,
    // Roof: how far the covering bows between ridge and eave under its own
    // weight, and how much the two buckle seams wander along their length.
    //
    // `sag` is four times what it was. The first version was sized by arithmetic
    // -- a few centimetres over a three-metre slope is what a real rafter
    // deflects -- and arithmetic was the wrong judge: at 0.06 m the bow is a
    // rounding error against the pitch and the roof read as flat. This is a
    // fantasy Nordic village, and the number that matters is the one you can see
    // from the street.
    sag: (0.22 + r(3) * 0.2) * s,
    buckle: (0.035 + r(4) * 0.04) * s,
    // The RIDGE line's own droop, separate from the sag of the slopes under it
    // and SIGNED: positive is a swaybacked ridge that dips in the middle,
    // negative is a hogged one that humps up. Both are real and they read
    // completely differently -- a dip says "this roof is tired", a hump says
    // "this frame was cut from a crooked tree" -- so the sign is drawn per
    // building rather than assumed.
    //
    // It is applied from a parameter along the ridge that both slopes compute
    // identically, never from each slope's own grid: see slopeSurface().
    ridgeSag: sym(10) * (0.06 + r(11) * 0.13) * s,
    // Eaves: how far the eave line swells past its nominal overhang, and how
    // much it rises and falls along its length. `sway` is the swaybacked droop
    // in the middle of a long eave; the corners flick back up.
    //
    // ABOUT TWO IN THREE BUILDINGS GET A SINUOUS EAVE and the rest get a nearly
    // ruled one. That gate is the point of the term: an eave that dips and lifts
    // along its length is the single most characterful line on the building, and
    // it stops being characterful the moment every building in the village has
    // one. The ones that do get it get much more of it than before.
    reach: (0.1 + r(5) * 0.13) * s,
    sway: (r(6) > 0.32 ? 0.08 + r(12) * 0.14 : 0.012) * s,
    // How far the roof oversails, as a MULTIPLIER on whatever the plan asked
    // for: some buildings wear a deep sheltering overhang and some are cut back
    // close to the wall, and the plan has no opinion about which.
    overhang: 1 + sym(13) * 0.38 * s,
    // THE RAKE LINE'S DIVERGENCE FROM THE WALL BELOW IT, as a fraction of the
    // slope's run: how much further the roof oversails the gable end at the
    // RIDGE than it does at the EAVE. Positive flares toward the sky, negative
    // bows out at the bottom, and either reads as deliberate -- what reads as
    // nothing is a rake cut parallel to the wall, which is what the whole
    // village had.
    //
    // SIGN AND SIZE ARE DRAWN SEPARATELY, and that is the fix. It used to be one
    // symmetric draw, `sym(14) * (0.1 + r(15) * 0.26)`, which puts HALF the
    // village within 0.13 m of parallel by construction -- the sign coming out
    // near zero takes the size down with it. Now a quarter of buildings are
    // ruled flush on purpose and the rest get 11--30% of their run, which on a
    // cottage is a third of a metre to over three quarters, off a verge only
    // 0.3 m deep. It is anchored rather than centred in slopeSurface(), so this
    // can be large without any part of the sheet retreating inside the wall.
    vergeSplay: (r(18) < 0.24 ? 0.02 : (r(14) < 0.5 ? -1 : 1) * (0.11 + r(15) * 0.19)) * s,
    // The RAKE of the eave skirt: how far off plumb the thatch fringe hangs.
    // Positive throws the tip outward, away from the wall; negative tucks it
    // back under the roof. See thatchFringe().
    rake: sym(16) * 0.6 * s,
    // Chimney: how much wider the crown is than the base.
    flare: 1 + (0.32 + r(7) * 0.26) * s,
    // Openings: how far a window strays from the rectangle it was planned as.
    // `skew` drives a SYMMETRIC distortion -- a trapezoid flare plus a shear --
    // and `tilt` rotates the whole opening rigidly. Neither moves one corner
    // without moving its partner: a window whose four corners each wandered on
    // their own read as melted rather than as settled, which is the one way a
    // crooked building can look worse than a straight one.
    skew: 0.09 * s,
    tilt: sym(17) * 0.05 * s,
    // Shutters: how far the free edge stands off the wall.
    splay: (0.05 + r(8) * 0.05) * s,
    // Posts and rails bow this far off the straight line between their ends.
    // Was 0.018--0.04 m, which on a 2 m post is a millimetre of screen space at
    // arm's length and nothing at all beyond it -- the term was in the character
    // and had no visible effect anywhere. It also only ever does anything on a
    // member with interior rings, which member2() now guarantees.
    bow: (0.05 + r(9) * 0.06) * s,
  }
}

/**
 * The displacement field for one building.
 *
 * Returns `(x, y, z) -> [x', y', z']`. Three independent noise fields, one per
 * output axis, at offset seeds -- one field used for all three would displace
 * everything along the diagonal and read as a shear rather than as a warp.
 *
 * `y0` is the height the lean is measured from, so a building on a plinth leans
 * from its plinth rather than from the origin.
 */
export function makeWarp(k, y0 = 0) {
  if (!(k.strength > 0)) return null
  const s = k.seed * 31 + 7
  const inv = 1 / k.scale
  const inv2 = 1 / k.scale2
  return (x, y, z) => {
    const ax = x * inv
    const ay = y * inv
    const az = z * inv
    const bx = x * inv2
    const by = y * inv2
    const bz = z * inv2
    const h = Math.max(0, y - y0)
    const lean = Math.pow(h, k.leanPow)
    return [
      x + k.amp * vnoise(s, ax, ay, az) + k.amp2 * vnoise(s + 101, bx, by, bz) + k.leanX * lean,
      // Half amplitude vertically. A building that heaves up and down as much
      // as it wanders sideways stops reading as settled and starts reading as
      // melted, and the eave line -- the one horizontal the eye actually
      // measures -- is the first thing to go.
      y + 0.5 * (k.amp * vnoise(s + 211, ax, ay, az) + k.amp2 * vnoise(s + 307, bx, by, bz)),
      z + k.amp * vnoise(s + 401, ax, ay, az) + k.amp2 * vnoise(s + 509, bx, by, bz) + k.leanZ * lean,
    ]
  }
}

/**
 * Apply a warp to a Builder's vertex array, in place, before toGeometry().
 *
 * In place and pre-geometry rather than on the BufferGeometry, so the caller
 * can still count triangles, and so nothing downstream ever sees the unwarped
 * positions and caches them.
 */
export function warpBuilder(b, warp) {
  if (!warp) return b
  const p = b.pos
  for (let i = 0; i < p.length; i += 3) {
    const q = warp(p[i], p[i + 1], p[i + 2])
    p[i] = q[0]
    p[i + 1] = q[1]
    p[i + 2] = q[2]
  }
  return b
}

/**
 * Recompute normals, rounding off the creases that should be round and leaving
 * the ones that should be sharp.
 *
 * WHAT KIND OF DECISION THIS IS. Smooth versus faceted shading is not a material
 * setting and not an object setting -- `material.flatShading` is the only knob at
 * that level and it is all-or-nothing for everything the material draws. It is a
 * PER-VERTEX decision, made in the geometry: a vertex carries one normal, so a
 * corner looks sharp when the faces meeting there each have their own copy of
 * that corner with their own normal, and looks round when they share one
 * averaged normal. Nothing about the triangles changes either way.
 *
 * WHICH MEANS IT IS FREE. Builder.vertex() never dedupes -- every quad emits four
 * fresh vertices -- so all the duplicates a hard edge needs are already there and
 * always were. This pass only overwrites the values in the normal array. No
 * triangle is added, no vertex is added or removed, the index buffer is
 * untouched, and the geometry is exactly the same size afterwards. The cost is
 * one build-time pass over the vertices; at runtime there is none at all.
 *
 * THE RULE, in two parts, because "smooth everything" makes a hewn plinth look
 * like a bar of soap:
 *
 *   1. Only layers in `layers` are smoothed at all. The timber layers are in it,
 *      so a five-sided log rounds off into something cylindrical. Stone, plaster
 *      and the roof coverings are not, so a broken plinth arris stays broken and
 *      a buckle seam in a roof stays a seam you can see.
 *   2. Within those, two faces share a normal only if they meet at less than
 *      `angle`. So the sides of a log round into each other (a five-sided prism
 *      turns 72 degrees at each arris) while its sawn end stays square to them
 *      (90 degrees), and a post rounds without its foot melting into the deck.
 *
 * Vertices are grouped by quantised POSITION, which is the same key openEdges()
 * pairs on, so parts that were built to meet really do share their normals and
 * a wall does not shade differently from the beam let into it.
 */
export function smoothNormals(b, { angle = 78, layers = null, eps = 1e-4 } = {}) {
  const { pos, nrm, idx, lay } = b
  const n = pos.length / 3
  if (!n) return b
  const cosMin = Math.cos((angle * Math.PI) / 180)
  const only = layers ? new Set(layers) : null

  // Face normals, area-weighted, accumulated onto the vertices that reference
  // them. Unnormalised on purpose: the magnitude IS twice the triangle area, so
  // a big face pulls the average toward itself, which is what stops a sliver
  // triangle at the end of a sweep from dominating the corner it sits in.
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)
  const az = new Float64Array(n)
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3
    const i1 = idx[t + 1] * 3
    const i2 = idx[t + 2] * 3
    const e1x = pos[i1] - pos[i0]
    const e1y = pos[i1 + 1] - pos[i0 + 1]
    const e1z = pos[i1 + 2] - pos[i0 + 2]
    const e2x = pos[i2] - pos[i0]
    const e2y = pos[i2 + 1] - pos[i0 + 1]
    const e2z = pos[i2 + 2] - pos[i0 + 2]
    const cx = e1y * e2z - e1z * e2y
    const cy = e1z * e2x - e1x * e2z
    const cz = e1x * e2y - e1y * e2x
    for (let e = 0; e < 3; e++) {
      const v = idx[t + e]
      ax[v] += cx
      ay[v] += cy
      az[v] += cz
    }
  }

  // The unit normal each vertex would have with no smoothing at all: its own
  // quad's. That is both the fallback and the reference direction the angle test
  // below is measured against.
  const ux = new Float64Array(n)
  const uy = new Float64Array(n)
  const uz = new Float64Array(n)
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(ax[v], ay[v], az[v])
    if (l > 1e-12) {
      ux[v] = ax[v] / l
      uy[v] = ay[v] / l
      uz[v] = az[v] / l
    } else {
      // A fully degenerate vertex keeps whatever the builder wrote, which is the
      // face normal computed before the warp moved it. Better than a zero.
      ux[v] = nrm[v * 3]
      uy[v] = nrm[v * 3 + 1]
      uz[v] = nrm[v * 3 + 2]
    }
  }

  // Group by position AND layer: two different materials meeting along a line
  // are two different surfaces, and averaging across them shades the join as if
  // the wall were made of the beam.
  const groups = new Map()
  for (let v = 0; v < n; v++) {
    if (only && !only.has(lay[v])) continue
    const k = v * 3
    const key = `${lay[v]}|${Math.round(pos[k] / eps)},${Math.round(pos[k + 1] / eps)},${Math.round(pos[k + 2] / eps)}`
    const g = groups.get(key)
    if (g) g.push(v)
    else groups.set(key, [v])
  }

  for (let v = 0; v < n; v++) {
    nrm[v * 3] = ux[v]
    nrm[v * 3 + 1] = uy[v]
    nrm[v * 3 + 2] = uz[v]
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    for (const v of g) {
      let sx = 0
      let sy = 0
      let sz = 0
      for (const w of g) {
        if (ux[v] * ux[w] + uy[v] * uy[w] + uz[v] * uz[w] < cosMin) continue
        sx += ax[w]
        sy += ay[w]
        sz += az[w]
      }
      const l = Math.hypot(sx, sy, sz)
      if (l < 1e-12) continue
      nrm[v * 3] = sx / l
      nrm[v * 3 + 1] = sy / l
      nrm[v * 3 + 2] = sz / l
    }
  }
  return b
}

/** A signed wobble in -1..1 that varies smoothly along a normalised span, for
 *  eave sway, buckle seams and anything else that has to undulate ALONG a line
 *  rather than wander in space. Two waves at incommensurable frequencies, so it
 *  never reads as a sine. */
export function wobble(seed, t) {
  const a = hash(seed, 1) * Math.PI * 2
  const b = hash(seed, 2) * Math.PI * 2
  const f = 1.6 + hash(seed, 3) * 1.4
  return 0.62 * Math.sin(t * Math.PI * 2 * f + a) + 0.38 * Math.sin(t * Math.PI * 2 * (f * 1.87) + b)
}
