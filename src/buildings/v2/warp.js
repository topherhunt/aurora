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
// are simply recomputed afterwards. Builder.vertex() never dedupes across
// quads, so recomputing averages only the two triangles of each quad -- which
// is right, because a warped quad is genuinely non-planar -- and leaves every
// quad-to-quad crease as sharp as it was.
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
    sag: (0.055 + r(3) * 0.05) * s,
    buckle: (0.035 + r(4) * 0.04) * s,
    // Eaves: how far the eave line swells past its nominal overhang, and how
    // much it rises and falls along its length. `sway` is the swaybacked droop
    // in the middle of a long eave; the corners flick back up.
    reach: (0.1 + r(5) * 0.13) * s,
    sway: (0.05 + r(6) * 0.07) * s,
    // Chimney: how much wider the crown is than the base.
    flare: 1 + (0.32 + r(7) * 0.26) * s,
    // Openings: how far a window corner strays from the rectangle it was
    // planned as, as a fraction of the opening.
    skew: 0.09 * s,
    // Shutters: how far the free edge stands off the wall.
    splay: (0.05 + r(8) * 0.05) * s,
    // Posts and rails bow this far off the straight line between their ends.
    bow: (0.018 + r(9) * 0.022) * s,
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
