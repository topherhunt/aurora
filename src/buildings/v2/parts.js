import { LAYER, TILE_METRES } from '../../textures.js'
import { IRON_ISLANDS } from '../tiles.js'
import {
  Builder, hash, roughSection, member, roughSlab,
  groundGrime, roofTint, TINT, WALL_STYLE,
  plinth, doorway, steps, gableEnd, leanEnd, openEdges, signedVolume,
} from '../parts.js'
import { wobble } from './warp.js'

// ---------------------------------------------------------------------------
// The v2 building vocabulary: everything v1 draws straight, drawn crooked.
//
// v1 is intact and untouched next door. This file re-exports the parts of it
// that were already irregular enough (the plinth, the doorway, the broken
// slabs) and REPLACES the ones that read as machined: the roof, the chimney,
// the window, the wall. Nothing here is a wrapper around a v1 part with a
// jitter bolted on -- the whole point is that the v1 versions have no interior
// vertices to bend, so they had to be rebuilt with some.
//
// THE DIVISION OF LABOUR WITH warp.js. The warp field supplies the character:
// the lean, the wander, the fact that no two verticals are parallel. It is a
// pure function of position, so it cannot open a seam. What it CANNOT do is bow
// a surface that is drawn as one quad, because a quad has four corners and no
// middle. So every part in this file that is meant to buckle carries a
// subdivision that v1 did not have, and the subdivision is sized to what the
// eye actually measures on it:
//
//   roof plane   nu x nv grid, nv = 3 -> the two horizontal seams a tiled roof
//                buckles along under its own weight. Plus a sagging middle, an
//                eave that reaches past its nominal overhang, and an eave line
//                that sways along its length instead of ruling straight.
//   chimney      ONE prism of four to six jittered corners, flaring OUT as it
//                rises. v1's battered stack plus corbelled cap was two solids
//                and ~48 triangles for a shape that still read as a post.
//   window       four independently skewed corners rather than a rectangle, a
//                surround mitred around that skewed path, and shutters whose
//                free edge stands off the wall.
//   wall         split along its length so the field can belly it out.
//
// EVERY IRREGULARITY IS SEEDED, never random, and every one of them is scaled
// by the character's `strength`. At strength 0 this file builds, triangle for
// triangle, the same straight thing v1 does -- which is the control the
// previewer's slider needs at one end of its travel.
//
// THE LOD CONTRACT, which is a budget line and not a suggestion. v1's detail 1
// came out at roughly a third of detail 2 and that is far too rich for a tier
// whose whole job is to be cheap; v2 targets an EIGHTH. Everything that costs
// its triangles on rounding, bevelling or sweeping is gone below detail 2, and
// the rule is uniform enough to state in one line: at detail 1 nothing in the
// kit is a solid of revolution and nothing has a broken arris.
//
//   detail 2   the grid, the sweeps, the broken slabs, the wander. ~900 tris on
//              a cottage.
//   detail 1   MASSING ONLY. Roof planes collapse to a single span with a
//              single edge band; the plinth, the steps and the porch deck go
//              back to boxes; every member -- log end, jamb, post, rail, ridge
//              roll, king post -- is dropped outright; a window is a frame rect
//              and a glass rect, and each shutter is one more rect, instead of
//              a swept ring and a pair of splayed leaves. ~110 tris on the same
//              cottage.
//   detail 0   a box and a roof prism.
//
// The saving is nearly all in what ISN'T there rather than in coarser versions
// of what is, because a member is 20 to 32 triangles and a building carries
// thirty of them. See src/buildings/v2/building.js for which parts each tier
// asks for at all.
// ---------------------------------------------------------------------------

export {
  Builder, hash, roughSection, member, roughSlab,
  groundGrime, roofTint, TINT, WALL_STYLE,
  plinth, doorway, steps, gableEnd, leanEnd, openEdges, signedVolume,
}

/** The character every part falls back to when it is handed none: dead
 *  straight. `flare` and `overhang` are 1 rather than 0 because they are
 *  ratios; every other term here is a displacement and zeroes. */
const FLAT = {
  sag: 0, buckle: 0, ridgeSag: 0, reach: 0, sway: 0, overhang: 1, vergeSplay: 0,
  rake: 0, flare: 1, skew: 0, tilt: 0, splay: 0, bow: 0,
}

/** The layers whose facets get averaged normals -- see smoothNormals() in
 *  warp.js. Everything hewn from a tree is in, so a five-sided log reads round
 *  instead of pentagonal; masonry, plaster and roof coverings are out, because
 *  their broken arrises and buckle seams are the point of them. */
export const SMOOTH_LAYERS = [LAYER.TIMBER_BEAM, LAYER.TIMBER_PLANK, LAYER.TIMBER_HEWN]

const dist3 = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])
/** The XZ direction from p to q, unitised. */
const flatDir = (p, q) => {
  const dx = q[0] - p[0]
  const dz = q[2] - p[2]
  const l = Math.hypot(dx, dz) || 1
  return [dx / l, dz / l]
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * A four-cornered section with the corners AT the corners.
 *
 * roughSection(4, ...) does not do this and is a trap worth naming: it places
 * its points at evenly spaced ANGLES, so at n = 4 they land at 0, 90, 180 and
 * 270 degrees, which on a rectangle are the EDGE MIDPOINTS. A four-sided
 * roughSection is a diamond, not a box. The chimney wants a box, so it gets one
 * here, with each corner pushed in or out independently on each axis -- which is
 * what "randomly-jittered corners" means on a stack of field stone: not a
 * rotated square, four corners that do not agree.
 *
 * Wound anticlockwise in (u, v), which is what prism() requires of a section:
 * its side winding and both cap fans are derived from that orientation.
 */
export function boxSection(hu, hv, seed, jitter = 0.22) {
  const C = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
  return C.map(([su, sv], k) => [
    su * hu * (1 + (hash(seed, k * 2 + 1) - 0.5) * 2 * jitter),
    sv * hv * (1 + (hash(seed, k * 2 + 2) - 0.5) * 2 * jitter),
  ])
}

/**
 * The same idea at five or six corners, for the stacks that are not square.
 *
 * boxSection cannot be generalised, because its whole trick is that it NAMES
 * the four corners of a rectangle and then shoves each one about. Past four
 * there are no named corners, so this walks the angles instead -- and it
 * disturbs the ANGLE as well as the radius, because evenly spaced angles with
 * only the radii moved still read as a regular polygon somebody dented, which
 * is the one thing a pile of field stone is not.
 *
 * The half-step offset puts n = 4 back on the diagonals, where boxSection's
 * corners are, so the two belong to one family. Both jitters are then capped
 * tighter than boxSection's, and for a reason boxSection does not have: its
 * corners are pinned one to a quadrant and cannot pass each other however hard
 * they are shoved, while these are only kept apart by staying in angle order
 * and by not denting so deep that a corner turns reflex. Either failure folds
 * prism()'s cap fan back over itself. 0.40 of a step and 0.18 of the radius
 * leave both with margin at n = 6 on the most eccentric stack the planner
 * draws, which is the case that runs out of room first.
 *
 * Wound anticlockwise in (u, v), which is what prism() requires and what
 * boxSection also gives it: here it follows from the angles increasing.
 */
export function polySection(hu, hv, n, seed, jitter = 0.18) {
  const step = (Math.PI * 2) / n
  const out = []
  for (let k = 0; k < n; k++) {
    const a = (k + 0.5) * step + (hash(seed, k * 2 + 1) - 0.5) * step * 0.4
    const r = 1 + (hash(seed, k * 2 + 2) - 0.5) * 2 * jitter
    out.push([Math.cos(a) * hu * r, Math.sin(a) * hv * r])
  }
  return out
}

/** The same loop, scaled. prism()'s `sectionEnd` must be this and never a
 *  re-roll: re-rolling the corners twists the facets between the two ends and a
 *  twisted stack reads as a bug rather than as masonry. */
export function scaleSection(sec, s) {
  return sec.map(([u, v]) => [u * s, v * s])
}

// ---------------------------------------------------------------------------
// Roofs
// ---------------------------------------------------------------------------

/**
 * A ROOF IS A SHEET. It has no thickness, at any level of detail.
 *
 * v1 and the first cut of v2 both built a roof as a SOLID: a top surface, a
 * plumb-cut band around its whole perimeter, and a soffit fan closing the
 * underside. Three surfaces and a perimeter loop, about sixty triangles a plane,
 * to say one thing -- that a thatched roof is half a metre of packed straw --
 * which is only ever visible along a single line, the eave.
 *
 * So a plane is now `nu x nv` cells of DOUBLE-SIDED quad and nothing else. The
 * 3x3 grid costs 36 triangles where the solid version spent about 76; it is
 * still airtight, because a doubled quad seals its own four edges (see
 * Builder.quad); and the half-metre of straw comes back as thatchFringe(), a
 * skirt hung off the eave line, which always read better than a plumb band did.
 *
 * WHAT THIS BUYS BEYOND THE TRIANGLES, and the real reason for it: a sheet has
 * one unambiguous height at every point, so THE WALLS CAN ASK WHERE IT IS. Every
 * slope built here is a surface object carrying a heightAt(x, z), the wall under
 * it takes its top edge from that instead of from the nominal eave height, and
 * the wall now stops just under the covering instead of stabbing through it.
 * That was the loudest defect in v2's first cut, it got worse the moment the sag
 * was scaled up to where it could be seen, and it was not fixable at all while
 * the underside of a roof was a fan over a loop rather than a function.
 */

/** How finely to grid a roof plane. `nv = 3` is not tuned -- it is the request:
 *  two horizontal seams, so three courses of covering, so the plane can kink
 *  twice between eave and ridge. `nu` is what the eave sway needs to have
 *  somewhere to sag BETWEEN, and one interior point is enough to read as
 *  swaybacked; a long inn eave gets two. A porch roof gets neither and stays a
 *  single span, because at 2 m across nothing is measurable. */
function roofGrid(eaveLen, slopeLen) {
  const nu = eaveLen < 3.2 ? 1 : eaveLen < 6.4 ? 2 : 3
  const nv = slopeLen < 1.8 ? 1 : 3
  return { nu, nv }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Where the segment (x0,z0)-(x1,z1) crosses the segment a-b in plan, as the
 *  parameter along the first, or null. Endpoints of the second count, endpoints
 *  of the first do not: the caller already owns those. */
function crossXZ(x0, z0, x1, z1, a, b) {
  const rx = x1 - x0
  const rz = z1 - z0
  const sx = b[0] - a[0]
  const sz = b[2] - a[2]
  const den = rx * sz - rz * sx
  if (Math.abs(den) < 1e-9) return null
  const qx = a[0] - x0
  const qz = a[2] - z0
  const u = (qx * sz - qz * sx) / den
  const v = (qx * rz - qz * rx) / den
  if (u <= 1e-4 || u >= 1 - 1e-4 || v < -1e-9 || v > 1 + 1e-9) return null
  return u
}

/** Where a vertical line through (x, z) crosses the triangle abc, or null if it
 *  misses. Barycentric in the XZ plane, with a hair of tolerance so a point on a
 *  shared edge belongs to one of the two triangles rather than to neither. */
function triY(a, b, c, x, z) {
  const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2])
  if (Math.abs(det) < 1e-12) return null
  const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det
  const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det
  const w = 1 - u - v
  if (u < -1e-6 || v < -1e-6 || w < -1e-6) return null
  return u * a[1] + v * b[1] + w * c[1]
}

/**
 * ONE ROOF SLOPE, as a surface rather than as a pile of triangles.
 *
 * The frame. `alongAxis` is the world axis the top edge runs along and `a` is
 * the distance along it from the centre; `c` is the distance along the other
 * horizontal axis. `cHigh` is where the top edge sits in `c` (the ridge, at 0,
 * for a gable; the back wall for a lean-to) and `dirSign` is the direction the
 * slope falls in. Two parameters run over the sheet:
 *
 *   t   0..1 from one gable end to the other, along the top edge
 *   s   0 at the EAVE TIP, 1 at the top edge
 *
 * WHAT MOVES, and what deliberately does not:
 *
 *   the eave line    reaches OUT past its nominal overhang by a wandering
 *                    amount, continuing the pitch as it goes (so a longer
 *                    overhang hangs lower, as it must), and rises and falls
 *                    along its length. This is the one line of a roof the eye
 *                    rules a straightedge against, so it is where the money
 *                    goes -- and about a third of buildings deliberately get
 *                    almost none of it, because a whole village of sinuous
 *                    eaves stops reading as character. See `sway` in warp.js.
 *   the whole sheet  bows down between eave and top edge by `sag`, and kinks up
 *                    and down at each interior seam by `buckle`.
 *   the verge        the gable-end overhang differs between the top edge and
 *                    the eave -- `splayLo`/`splayHi`, signed, so a gable can
 *                    flare toward the sky or bow out at the bottom.
 *   the top edge     droops (or humps: `ridgeSag` is signed) along its length,
 *                    AND IS COMPUTED FROM `t` ALONE. Two slopes share the ridge
 *                    line and walk it in opposite directions, so anything
 *                    applied there has to agree between them to the last bit or
 *                    the roof opens along its spine. `t`, the verge extents and
 *                    `ridgeSag` are all per-ROOF rather than per-slope, so both
 *                    slopes land on bit-identical ridge points; the per-slope
 *                    seed only ever reaches terms that vanish at s = 1.
 *
 * UVS ARE EXPLICIT AND COME FROM THE UNWARPED PARAMETERISATION. U is the
 * absolute along-coordinate, so the two slopes' tiles line up across the ridge
 * and the verge splay shears nothing; V is arc length up the slope from the eave
 * tip. Letting quad() derive a frame per cell would give every cell a slightly
 * different one once the cell is no longer planar, and the tile would visibly
 * step at each seam.
 */
function slopeSurface(o) {
  const {
    cx, cz, alongAxis, dirSign, alongHalf, runNominal, cHigh = 0,
    eaveY, highY, overhang, vergeLo, vergeHi, splayLo = 0, splayHi = 0,
    ridgeSag = 0, seed = 0, k = FLAT, layer, nu, nv,
  } = o
  const tile = TILE_METRES[layer] ?? 1
  const pitch = (highY - eaveY) / Math.max(0.001, runNominal)
  const hyp = Math.hypot(1, pitch)

  // The splay is ANCHORED on whichever end of the rake gets the nominal verge,
  // not centred on it: a positive splay leaves the eave alone and throws the
  // ridge out, a negative one leaves the ridge alone and throws the eave out.
  // Centred, half of any splay big enough to read from the street would be
  // subtracted from a verge only 0.3 m deep and the sheet would end INSIDE the
  // gable wall, which is a slot of daylight rather than a look. Anchored, the
  // verge is the floor and the splay only ever adds.
  const splayAt = (sp, s) => (sp >= 0 ? sp * s : -sp * (1 - s))
  const vLoAt = (s) => alongHalf + vergeLo + splayAt(splayLo, s)
  const vHiAt = (s) => alongHalf + vergeHi + splayAt(splayHi, s)
  const tOf = (a, s) => (a + vLoAt(s)) / Math.max(0.001, vLoAt(s) + vHiAt(s))

  /**
   * Sample a function at the n + 1 grid lines and read it back as the CHORD
   * between them, which is what the triangles are.
   *
   * Every shaping term here is a smooth curve, and the sheet holds nu + 1
   * columns by nv + 1 rows of it and nothing in between. Ask a smooth term for a
   * point mid-cell and the answer is the curve, not the roof: a 0.3 m ridge sag
   * read at the middle of a two-column ridge is 6 cm above the triangles, and a
   * 0.4 m slope sag is another 3 cm on a three-row sheet. That error lands
   * ENTIRELY on the walls, which cut themselves to `heightAt` -- they stop short
   * of the covering by it and leave a slot you can see up through from under the
   * eave, which is exactly where a village street looks at a roof from.
   *
   * So every term is wrapped at the source rather than the callers being asked
   * to allow for it. The values AT the grid lines are untouched, so the mesh is
   * bit-identical; only the answer between them moves, onto the surface. Both
   * slopes of a gable share nu, so the ridge still closes exactly.
   */
  const chord = (n, f) => {
    const node = []
    for (let i = 0; i <= n; i++) node.push(f(i / n))
    return (u) => {
      const x = clamp01(u) * n
      const i = Math.min(n - 1, Math.floor(x))
      return node[i] + (node[i + 1] - node[i]) * (x - i)
    }
  }
  const linT = (f) => chord(nu, f)

  const reachRaw = (t) => k.reach * (0.55 + 0.45 * wobble(seed * 19 + 3, t))
  const reachAt = linT(reachRaw)
  const spanAt = (t) => runNominal + overhang + reachAt(t)
  const eaveAt = linT((t) => (
    eaveY - pitch * (overhang + reachRaw(t)) + k.sway * wobble(seed * 17 + 5, t)
  ))
  const topOf = linT((t) => highY - ridgeSag * Math.sin(Math.PI * t))
  const sagAt = chord(nv, (s) => -k.sag * Math.sin(Math.PI * s))
  // The buckle is a curve along each seam row and a chord between the rows, so
  // it is chorded in both directions too -- t inside each row, s across them.
  const rowBuckle = []
  for (let j = 0; j <= nv; j++) {
    rowBuckle.push(j <= 0 || j >= nv
      ? () => 0
      : linT((t) => k.buckle * wobble(seed * 13 + j, t)))
  }
  const buckleAt = (t, s) => {
    const x = clamp01(s) * nv
    const j = Math.min(nv - 1, Math.floor(x))
    const f = x - j
    return rowBuckle[j](t) * (1 - f) + rowBuckle[j + 1](t) * f
  }
  // Bilinear over every cell by construction: eave and top are chords in t, the
  // rise between them is linear in s, and both remaining terms are chorded on
  // their own grid. What is left between this and the triangles is the twist of
  // each quad against the diagonal it was split on, which is millimetres.
  const yAt = (t, s) => {
    const e = eaveAt(t)
    return e + (topOf(t) - e) * s + sagAt(s) + buckleAt(t, s)
  }
  const world = (a, c, y) => (alongAxis === 'x' ? [cx + a, y, cz + c] : [cx + c, y, cz + a])

  const P = []
  const UV = []
  for (let j = 0; j <= nv; j++) {
    const s = j / nv
    const lo = -vLoAt(s)
    const hi = vHiAt(s)
    const row = []
    const rowUV = []
    for (let i = 0; i <= nu; i++) {
      const t = i / nu
      const a = lo + (hi - lo) * t
      row.push(world(a, cHigh + dirSign * spanAt(t) * (1 - s), yAt(t, s)))
      rowUV.push([a / tile, (s * spanAt(t) * hyp) / tile])
    }
    P.push(row)
    UV.push(rowUV)
  }

  /**
   * How high this slope is above the world point (x, z).
   *
   * ASKED OF THE TRIANGLES, not of the formula they were sampled from: drop a
   * plumb line and read the cell it lands in. Everything on the building that
   * has to stop at the roof -- the top of every wall, the corner posts, the
   * king post, a window that would otherwise poke through the covering -- asks
   * this question, and an answer that is even 2 cm optimistic is a 2 cm slot of
   * daylight under the eave. Each quad is split on the P[j][i] -> P[j+1][i+1]
   * diagonal, and the two triangles of the split do not agree with the smooth
   * surface in the middle of a cell, so the split is followed exactly here.
   *
   * At most nine cells, so the cell is found by scanning rather than by
   * inverting the parameterisation, which is circular (s depends on how far the
   * eave reached at t, t depends on how far the verge splayed at s).
   *
   * OFF THE SHEET the plumb line misses everything, and the fallback is the
   * surface continued analytically: the inversion by two fixed-point sweeps,
   * then the smooth form. That is the right answer for a point that has no
   * covering over it -- a wall of a mass whose own roof does not reach it -- and
   * it is continuous with the exact answer at the edge.
   *
   * `coverAt` is the same question WITHOUT that continuation: the height of the
   * covering over this point, or null where this sheet does not reach. A wall
   * wants the extrapolation, because it has to keep rising to meet a roof that
   * starts further along. Anything asking "is there a roof over my head" wants
   * the null -- a window in one wing must duck under the OTHER wing's eave where
   * it actually overhangs it, and must ignore that roof entirely everywhere else.
   */
  const coverOn = (G, x, z) => {
    for (let j = 0; j < G.length - 1; j++) {
      for (let i = 0; i < G[0].length - 1; i++) {
        const p00 = G[j][i]
        const p11 = G[j + 1][i + 1]
        const y = triY(p00, G[j][i + 1], p11, x, z) ?? triY(p00, p11, G[j + 1][i], x, z)
        if (y !== null) return y
      }
    }
    return null
  }
  const coverAt = (x, z) => coverOn(P, x, z)

  /**
   * The same sheet with the building's warp already applied to it, cached.
   *
   * Everything else in this file works in the space the building is DRAWN in,
   * because the warp is a post-pass and two parts that meet before it still meet
   * after it. A window head is the one thing that has to know better: the band of
   * wall it reserves under the covering is a looking number, and the field slides
   * a steep sheet sideways by half a metre -- which brings a metre of pitch over
   * a window that the unwarped sheet says is nowhere near it. So that one
   * question is asked of the warped grid. One cache line per slope, because the
   * same field object is handed to every window on the building.
   */
  let warpedFor = null
  let warpedGrid = null
  const gridFor = (warp) => {
    if (!warp) return P
    if (warpedFor !== warp) {
      warpedFor = warp
      warpedGrid = P.map((row) => row.map((q) => warp(q[0], q[1], q[2])))
    }
    return warpedGrid
  }

  const heightAt = (x, z) => {
    const on = coverAt(x, z)
    if (on !== null) return on
    const a = alongAxis === 'x' ? x - cx : z - cz
    const c = alongAxis === 'x' ? z - cz : x - cx
    const q = (c - cHigh) * dirSign
    let s = 1 - q / (runNominal + overhang)
    for (let it = 0; it < 2; it++) s = 1 - q / spanAt(clamp01(tOf(a, clamp01(s))))
    s = clamp01(s)
    return yAt(clamp01(tOf(a, s)), s)
  }

  /**
   * The LOWEST this sheet gets anywhere over an axis-aligned patch of ground,
   * or Infinity where it does not reach the patch at all.
   *
   * Asking `coverAt` at a handful of points across a window head is not the same
   * question and gets a different answer, because the thing that comes down over
   * a window is usually a sheet EDGE -- the verge of the next wing, ending in
   * mid-air -- and the lowest covered point is the last millimetre before the
   * edge, which no fixed set of samples lands on. Sample either side of it and
   * the answer is either the sheet 10 cm back up the slope or null, and the
   * window is set 10 cm too high.
   *
   * A piecewise-linear surface takes its minimum over a rectangle at a vertex of
   * the arrangement, so all three kinds of vertex are checked and nothing is
   * approximated: the patch corners that the sheet covers, the sheet's own grid
   * points standing inside the patch, and every crossing of a triangle edge --
   * the split diagonals included -- with a side of the patch.
   *
   * `warp` asks it of the WARPED sheet instead: patch and answer both in the
   * space the player sees, which is the only space in which a clearance under an
   * eave means anything.
   */
  const lowOver = (G, xa, za, xb, zb) => {
    const rows = G.length - 1
    const cols = G[0].length - 1
    let lo = Infinity
    for (const x of [xa, xb]) {
      for (const z of [za, zb]) {
        const y = coverOn(G, x, z)
        if (y !== null && y < lo) lo = y
      }
    }
    const sides = [
      [[xa, 0, za], [xb, 0, za]], [[xb, 0, za], [xb, 0, zb]],
      [[xb, 0, zb], [xa, 0, zb]], [[xa, 0, zb], [xa, 0, za]],
    ]
    const cut = (A, B) => {
      for (const [c, d] of sides) {
        const u = crossXZ(A[0], A[2], B[0], B[2], c, d)
        if (u === null) continue
        const y = A[1] + (B[1] - A[1]) * u
        if (y < lo) lo = y
      }
    }
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const p = G[j][i]
        if (p[0] >= xa && p[0] <= xb && p[2] >= za && p[2] <= zb && p[1] < lo) lo = p[1]
        if (i < cols) cut(p, G[j][i + 1])
        if (j < rows) cut(p, G[j + 1][i])
        if (i < cols && j < rows) cut(p, G[j + 1][i + 1])
      }
    }
    return lo
  }

  /** The fringe as a two-row sheet of its own: the eave line, and the same line
   *  hanging `drop` below it and leaning `lean` out. Built the same way
   *  thatchFringe() draws it, from the same eave and the same rake, because
   *  half a metre of straw over a window is as much in the way as the covering
   *  it hangs off -- and it hangs BELOW the sheet, so it is what a head under an
   *  eave actually has to clear. */
  const skirtOf = (drop, warp) => {
    const out = alongAxis === 'x' ? [0, dirSign] : [dirSign, 0]
    const lean = 0.02 + (k.rake ?? 0) * drop
    const G = [
      P[0].map((q) => [q[0] + out[0] * lean, q[1] - drop, q[2] + out[1] * lean]),
      P[0],
    ]
    return warp ? G.map((row) => row.map((q) => warp(q[0], q[1], q[2]))) : G
  }

  const lowIn = (x0, z0, x1, z1, warp = null, skirt = 0) => {
    const xa = Math.min(x0, x1)
    const xb = Math.max(x0, x1)
    const za = Math.min(z0, z1)
    const zb = Math.max(z0, z1)
    let lo = lowOver(gridFor(warp), xa, za, xb, zb)
    if (skirt > 0) lo = Math.min(lo, lowOver(skirtOf(skirt, warp), xa, za, xb, zb))
    return lo
  }

  /**
   * Every parameter along a plan segment where this sheet's profile KINKS.
   *
   * `heightAt` is now exact, but a wall built from it is still a chord between
   * wherever it happened to sample -- and the roof it is trying to meet is a
   * fold, not a curve. Sample either side of a fold and the wall crosses it: too
   * tall in the middle of the span or too short, by up to 6 cm, which is the slot
   * under the eave. Hand the wall the folds instead and its top edge lands ON the
   * covering for its whole length, because between two consecutive folds the
   * segment stays inside ONE triangle, where the surface is a plane and a chord
   * is the truth. The diagonals count: a quad is drawn as two triangles and the
   * seam between them is as real a fold as the seam between two cells.
   */
  const breaksAlong = (x0, z0, x1, z1, out) => {
    const add = (u) => { if (u !== null) out.push(u) }
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        if (i < nu) add(crossXZ(x0, z0, x1, z1, P[j][i], P[j][i + 1]))
        if (j < nv) add(crossXZ(x0, z0, x1, z1, P[j][i], P[j + 1][i]))
        if (i < nu && j < nv) add(crossXZ(x0, z0, x1, z1, P[j][i], P[j + 1][i + 1]))
      }
    }
  }

  const draw = (b, color) => {
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        b.quad(P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i], {
          layer, color, double: true,
          uvs: [UV[j][i], UV[j][i + 1], UV[j + 1][i + 1], UV[j + 1][i]],
        })
      }
    }
  }

  return {
    P, nu, nv, heightAt, coverAt, lowIn, breaksAlong, draw,
    eave: P[0],
    top: P[nv],
    // The outward horizontal direction the eave hangs over, which the fringe
    // needs and cannot reliably derive: a perpendicular to the eave polyline has
    // two answers and picking the wrong one hangs the straw into the building.
    outXZ: alongAxis === 'x' ? [0, dirSign] : [dirSign, 0],
  }
}

/**
 * The frayed thatch eave, hung off the eave polyline the roof actually built.
 *
 * Now that the covering has no thickness this IS the thickness: a skirt of straw
 * hanging below the sheet, doubled so its back is in view from anywhere under
 * the eave line, which is most of a village street.
 *
 * `rake` is what a roofer means by a raked eave cut. A real eave is trimmed
 * either PLUMB -- a vertical cut, the fringe hanging straight down -- or RAKED,
 * cut square to the pitch instead, so the cut face leans out with the slope. On
 * a covering with two surfaces you can see that as the difference between the
 * top edge and the underside overhanging by different amounts; on a sheet there
 * is only one surface, so it survives here as the lean of the skirt: positive
 * rake throws the fringe outward away from the wall, negative tucks it back
 * under the roof, and zero hangs it plumb. Drawn signed per building.
 */
/** How far the straw hangs below the eave on a roof that has any -- 0 on one
 *  that has not. The condition is drawRoof()'s, kept in one place so that what a
 *  window ducks under and what is actually drawn cannot drift apart. */
function fringeDrop(fringe, layer, detail, drop) {
  return fringe && detail >= 1 && layer === LAYER.THATCH ? drop : 0
}

function thatchFringe(b, slope, tint, k, drop = 0.34) {
  const eave = slope.eave
  const out = slope.outXZ
  const tile = TILE_METRES[LAYER.THATCH_FRINGE] ?? 1
  const n = eave.length
  if (n < 2) return
  // Arc length along the eave, so the fray does not stretch where a span is
  // longer.
  const s = [0]
  for (let i = 1; i < n; i++) s.push(s[i - 1] + dist3(eave[i - 1], eave[i]))
  // 0.02 of stand-off even at zero rake, so the skirt never z-fights the sheet
  // it hangs from.
  const lean = 0.02 + (k.rake ?? 0) * drop
  const lo = (q) => [q[0] + out[0] * lean, q[1] - drop, q[2] + out[1] * lean]
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1
    // v = 0 at the hanging tip, v = 1 at the eave line -- see tileFringe.
    b.quad(lo(eave[i]), lo(eave[j]), eave[j], eave[i], {
      layer: LAYER.THATCH_FRINGE,
      uvs: [[s[i] / tile, 0], [s[j] / tile, 0], [s[j] / tile, 1], [s[i] / tile, 1]],
      color: tint,
      double: true,
    })
  }
}

/**
 * Work out a gable roof's two surfaces WITHOUT drawing them.
 *
 * Split from the drawing because the walls have to be built against the roof
 * they will actually stand under, and they are drawn first. building.js plans
 * every mass's roof, builds the walls to it, and only then draws the covering.
 *
 * The contract is otherwise v1's gableRoof: `ridgeAxis`, `verge`, `vergeLo` and
 * `vergeHi` mean exactly what they meant, because building.js's wingVerge()
 * maths is about where two ROOFS meet and has nothing to do with how crooked
 * either of them is.
 */
export function planGableRoof(o) {
  const {
    cx, cz, w, d, eaveY, rise,
    ridgeAxis = 'x', seed = 0, overhang = 0.4, verge = 0.3,
    vergeLo = null, vergeHi = null,
    layer = LAYER.THATCH, tint = TINT.thatchNew, moss = 0.35, age = 0.5,
    fringe = true, detail = 2, k = FLAT,
  } = o
  // CHARACTER SURVIVES DOWN TO DETAIL 1, and it is free there. It used to stop
  // at detail 2 and the middle tier read as a different, straighter village --
  // the one thing a LOD is not allowed to be. What a 1x1 sheet can carry is
  // whatever moves its CORNERS: the overhang multiplier, the verge splay, the
  // eave's reach and its sway. What it cannot carry cancels itself here with no
  // help -- sag, buckle and ridgeSag are all sin(pi * u) terms sampled only at
  // the ends of their span, where they are zero -- so this passes the whole
  // character and lets the grid decide what of it survives.
  //
  // Detail 0 stays dead straight on purpose: it is drawn with no overhang and no
  // verge at all, and its gable triangle is filled against the flat top of a box
  // rather than against a sheet, so an eave that reached or swayed there would
  // open that joint rather than shape anything.
  const kk = detail >= 1 ? k : FLAT
  const ridgeY = eaveY + rise
  const alongHalf = (ridgeAxis === 'x' ? w : d) / 2
  const runHalf = (ridgeAxis === 'x' ? d : w) / 2
  const oh = overhang * kk.overhang
  // A verge the PLAN set explicitly is functional, not decorative: wingVerge()
  // works out how far a cross-wing's roof has to oversail to reach the roof it
  // dies into, and a character term that shortened it would open the valley. So
  // the per-building multiplier and the splay are spent on the free ends only.
  const vLo = vergeLo ?? verge * kk.overhang
  const vHi = vergeHi ?? verge * kk.overhang
  // AS A FRACTION OF THE SLOPE'S RUN, not as metres, so what the character fixes
  // is the ANGLE the rake makes with the wall below it -- the thing you actually
  // read from the street -- and a hut and an inn get the same amount of it.
  const splay = kk.vergeSplay * (runHalf + oh)
  const splayLo = vergeLo == null ? splay : 0
  const splayHi = vergeHi == null ? splay : 0

  const drop = (rise / Math.max(0.001, runHalf)) * oh
  const eave = eaveY - drop
  // The SPLAY is deliberately not in that width. roofGrid's columns exist to
  // resolve the terms that shape the sheet -- the sag across it, the buckle and
  // the wobble along it -- and all of those live on the part of it that spans
  // the building. What the splay adds is oversail hanging past the gable end
  // over open air, carrying nothing but a straight rake line, and a column
  // spent there costs 2 * nv triangles on each slope and buys nothing.
  const grid = detail >= 2
    ? roofGrid(2 * alongHalf + vLo + vHi, Math.hypot(runHalf + oh, rise + drop))
    : { nu: 1, nv: 1 }
  const color = roofTint({ base: tint, eaveY: eave, ridgeY, moss, ageAtEave: age })

  const slopes = [1, -1].map((sign) => slopeSurface({
    cx, cz, alongAxis: ridgeAxis, dirSign: sign, alongHalf,
    runNominal: runHalf, cHigh: 0, eaveY, highY: ridgeY, overhang: oh,
    vergeLo: vLo, vergeHi: vHi, splayLo, splayHi,
    ridgeSag: kk.ridgeSag, k: kk, layer, nu: grid.nu, nv: grid.nv,
    seed: seed * 3 + (sign > 0 ? 1 : 2),
  }))

  return {
    kind: 'gable', slopes, color, tint, layer, fringe, detail, seed, k: kk,
    ridgeY, eave, run: runHalf + oh,
    alongHalf: alongHalf + Math.max(vLo + Math.abs(splayLo), vHi + Math.abs(splayHi)),
    heightAt: (x, z) =>
      slopes[(ridgeAxis === 'x' ? z - cz : x - cx) >= 0 ? 0 : 1].heightAt(x, z),
    // Both slopes asked, not the one the point falls on: an overhanging eave
    // reaches past the ridge line of the OTHER slope's half of the plan when the
    // verge splays, and a point under it is covered by whichever sheet is over
    // it, not by whichever half of the footprint it stands in.
    coverAt: (x, z) => {
      for (const s of slopes) {
        const y = s.coverAt(x, z)
        if (y !== null) return y
      }
      return null
    },
    // Both slopes again, and for the same reason: the patch a window head takes
    // up can straddle the ridge line in plan when a verge splays out over it.
    lowIn: (x0, z0, x1, z1, warp) =>
      Math.min(...slopes.map((s) => s.lowIn(x0, z0, x1, z1, warp, fringeDrop(fringe, layer, detail, 0.34)))),
    // Both slopes, because a gable-end wall walks up one of them and down the
    // other and the ridge between them is the sharpest fold on the building.
    breaksAlong: (x0, z0, x1, z1) => {
      const out = []
      for (const s of slopes) s.breaksAlong(x0, z0, x1, z1, out)
      return out
    },
  }
}

/**
 * A single-pitch roof: the lean-to on a side outshut, the catslide where a
 * smaller mass abuts a larger one, and the porch canopy.
 *
 * `dir` is the outward direction the slope falls toward: '+x','-x','+z','-z'.
 * It is one slopeSurface with its high edge at the back wall instead of at a
 * ridge, which is the whole difference from a gable.
 */
export function planLeanRoof(o) {
  const {
    cx, cz, w, d, highY, lowY, dir = '+z', seed = 0, overhang = 0.3,
    layer = LAYER.THATCH, tint = TINT.thatchNew, age = 0.5, detail = 2, k = FLAT,
  } = o
  // Detail 1 keeps the character, for the reasons planGableRoof() gives.
  const kk = detail >= 1 ? k : FLAT
  const axis = dir[1]
  const sign = dir[0] === '+' ? 1 : -1
  const alongAxis = axis === 'x' ? 'z' : 'x'
  const runHalf = (axis === 'x' ? w : d) / 2
  const alongHalf = (axis === 'x' ? d : w) / 2
  const oh = overhang * kk.overhang
  const verge = 0.25 * kk.overhang
  // Measured across the WHOLE slope: a lean-to falls from one wall to the other,
  // not from a ridge at the middle.
  const runNominal = 2 * runHalf
  const drop = ((highY - lowY) / Math.max(0.001, runNominal)) * oh
  const eave = lowY - drop
  const grid = detail >= 2
    ? roofGrid(2 * alongHalf + 2 * verge, Math.hypot(runNominal + oh, highY - eave))
    : { nu: 1, nv: 1 }
  const color = roofTint({ base: tint, eaveY: eave, ridgeY: highY, moss: 0.3, ageAtEave: age })

  // HOW FAR THE SHEET RUNS PAST THE WALL IT LEANS ON, up-slope, on the same
  // plane. The plan pins the top edge at the main mass's NOMINAL eave and the
  // two sheets are then planned to meet along an exact line with no overlap --
  // which holds while both are straight and does not once the character terms
  // move them, because the main gable's eave can sag a third of a metre and this
  // free edge cannot follow it. A line that two independent sheets are supposed
  // to arrive at is a line that opens; a quarter of a metre of overlap, buried
  // inside the mass it leans on, is a line that cannot.
  //
  // Extending the run and raising the top by the same pitch keeps the pitch, the
  // eave position and the eave height bit-identical: this adds sheet at the top
  // and changes nothing else.
  const TOP_EXT = 0.25
  const pitchOf = (highY - lowY) / Math.max(0.001, runNominal)
  // ridgeSag is 0 and not a choice: a lean-to's top edge is buried in the wall
  // of the mass it leans against, and drooping it there opens a gap into it.
  const slope = slopeSurface({
    cx, cz, alongAxis, dirSign: sign, alongHalf,
    runNominal: runNominal + TOP_EXT, cHigh: -sign * (runHalf + TOP_EXT),
    eaveY: lowY, highY: highY + pitchOf * TOP_EXT, overhang: oh,
    // Same fraction of the run as the gable's rake, so an outshut's verge
    // diverges from its end wall at the same ANGLE the main roof does and the
    // two read as one hand's work. A porch canopy has a short run and gets
    // correspondingly little of it, which is the point of scaling by the run.
    vergeLo: verge, vergeHi: verge,
    splayLo: kk.vergeSplay * (runNominal + oh), splayHi: kk.vergeSplay * (runNominal + oh),
    ridgeSag: 0, seed: seed * 3 + 1, k: kk, layer, nu: grid.nu, nv: grid.nv,
  })

  return {
    kind: 'lean', slopes: [slope], color, tint, layer, fringe: true, detail, seed, k: kk,
    eave, run: runNominal + oh, highY, runHalf, alongHalf, axis, sign, thick: 0,
    heightAt: (x, z) => slope.heightAt(x, z),
    coverAt: (x, z) => slope.coverAt(x, z),
    lowIn: (x0, z0, x1, z1, warp) => slope.lowIn(x0, z0, x1, z1, warp, fringeDrop(true, layer, detail, 0.3)),
    breaksAlong: (x0, z0, x1, z1) => {
      const out = []
      slope.breaksAlong(x0, z0, x1, z1, out)
      return out
    },
  }
}

/**
 * Draw a planned roof: the sheets, then the skirt hanging off their eaves.
 *
 * There is no ridge capping. There was -- a swept bolster along the top line --
 * and it went because it was never load-bearing: the two sheets share their
 * ridge points bit for bit, so it hid no seam, and 20 triangles on the one line
 * of the building that is already a hard silhouette against the sky is the most
 * expensive place in the kit to buy an edge that is legible without it.
 */
export function drawRoof(b, R) {
  for (const s of R.slopes) s.draw(b, R.color)
  // The fringe is kept at detail 1, unlike every other ornament, precisely
  // BECAUSE it is silhouette: dropping it at the LOD1 boundary would pop the
  // outline of the roof at 60 m.
  if (R.fringe && R.detail >= 1 && R.layer === LAYER.THATCH) {
    for (const s of R.slopes) thatchFringe(b, s, R.tint, R.k, R.kind === 'gable' ? 0.34 : 0.3)
  }
  return R
}

/** Plan and draw in one call, for callers that have no walls to fit. */
export function gableRoof2(b, o) {
  return drawRoof(b, planGableRoof(o))
}

export function leanToRoof2(b, o) {
  return drawRoof(b, planLeanRoof(o))
}

/**
 * What a dormer's vertical faces are walled in, per wall style.
 *
 * The UPPER half of the wall in every case, which is the half a dormer is near:
 * a stone-based wall is timber by the time it reaches the eave, so a dormer
 * standing above that eave is boarded and not rubble, and only a wall that is
 * masonry the whole way up gives its dormer stone cheeks.
 */
// The stub's plan size, and how much of the building's own overhang its
// covering is entitled to oversail by. Up here rather than inside dormer2()
// because dormerHalfWidth() below is what building.js holds a PAIR of dormers
// apart by, and a number copied into two files is a number that drifts.
const DORM_HW = 0.54
const DORM_RISE = 0.42
const DORM_TRIM = 0.34

/**
 * How far a dormer reaches either side of its seat, covering and all, in the
 * plan the building is laid out in. The eave oversail is measured along the
 * pitch, so only its horizontal part counts here.
 */
export function dormerHalfWidth(overhang, k = FLAT) {
  const rafter = Math.hypot(DORM_HW, DORM_RISE)
  return DORM_HW * (1 + (overhang * DORM_TRIM * k.overhang) / rafter)
}

const DORMER_WALL_LAYER = {
  [WALL_STYLE.LOG]: LAYER.TIMBER_BEAM,
  [WALL_STYLE.STAVE]: LAYER.TIMBER_PLANK,
  [WALL_STYLE.HALF_TIMBER]: LAYER.PLASTER,
  [WALL_STYLE.STONE_BASE]: LAYER.TIMBER_PLANK,
  [WALL_STYLE.MASONRY]: LAYER.STONE,
}

/**
 * A DORMER: a stub of roof driven out through the main slope, with a window in
 * the gablet it presents.
 *
 * IT IS ONE SOLID PUSHED THROUGH A SHEET, exactly as the chimney is, and for the
 * same reason: a building here is a union of interpenetrating closed solids and
 * nothing is ever cut, so the way to make a roof grow something is to drive a
 * closed thing through it and let the sheet pass in one side and out the other.
 * A five-sided section swept horizontally into the slope IS the dormer -- two
 * roof planes, two cheeks and a floor from the sides of the sweep, the gablet
 * and its buried twin from the two caps -- and it costs sixteen triangles, which
 * is four more than the chimney. Eight more go on the covering, which is a
 * separate oversailing sheet and not a face of the solid at all; the reason is
 * down at the end of the body, and it is that a roof with no thickness cannot
 * overhang and stay closed at the same time.
 *
 * IT IS SWEPT BY HAND RATHER THAN BY prism(), and the reason is entirely about
 * texture. prism() gives every face of a solid one layer and one frame, which is
 * right for a timber and wrong for a building: a dormer is a scrap of ROOF over a
 * scrap of WALL, and it has to be both. Drawn face by face it is the same sixteen
 * triangles, and each one gets the layer and the frame it should have had:
 *
 *  - The two pitches, and the sheet that oversails them, take the COVERING, with
 *    U along the little ridge and V the arc length up from the little eave --
 *    the same frame slopeSurface() gives the roof this grew out of, so the straw
 *    runs the same way on both and laps downhill on the stub as well.
 *  - The gablet and the two cheeks take the WALL, in whatever layer the house is
 *    walled in, and they measure V as ABSOLUTE WORLD HEIGHT. That is the one
 *    thing that matters about the frame here: it is what makes the log courses of
 *    a dormer cheek line up with the log courses of the wall three metres below
 *    it, exactly as it does between one wall of the building and the next.
 *
 * The old version swept a prism with `vWorldY` set, and the stub is swept
 * HORIZONTALLY: world height is the same number at both ends of a horizontal
 * sweep, so V never moved and the covering was smeared the entire depth of the
 * dormer. A horizontal sweep and `vWorldY` cannot both be right, and this file
 * has the same trap noted at the porch rail.
 *
 * WHAT KEEPS IT WATERTIGHT is the same pair of tricks:
 *
 *  - The section drops `SINK` BELOW the sheet at the face. Everything under that
 *    line is behind the covering from every angle outside, because the sheet
 *    falls away from the face on the only side you can see it from.
 *  - The sweep runs in until the sheet has climbed clear over the ridge of the
 *    stub, which is asked of `sheetAt` step by step rather than worked out from
 *    the pitch. The pitch is not the whole story: the sag can be 40 cm and the
 *    buckle wanders, and a depth computed from the nominal plane puts the back
 *    gablet out through the covering on exactly the seeds where the roof is most
 *    interesting. Where the sheet never gets clear before the ridge, there is no
 *    dormer -- which is what happens on a shallow-pitched hut, and correctly so.
 *
 * Returns the SEAT it drew -- where the stub met the sheet and how far back it
 * had to run to get under it -- or null if it drew nothing. The caller keeps
 * those so the gate can walk up to each one and measure it, rather than having
 * to find dormers in a finished vertex array by looking for shapes.
 */
export function dormer2(b, {
  x, z, nx, nz, sheetAt, ridgeLimit, layer, color, style = WALL_STYLE.LOG,
  overhang = 0.4, seed = 0, detail = 2, k = FLAT,
}) {
  if (detail < 1) return null
  const faceY = sheetAt(x, z)
  if (!Number.isFinite(faceY)) return null

  // The stub, measured up from where the main sheet crosses its face. The window
  // is what sets these: sill, glass, head, and then enough gablet above the head
  // that the window sits in the little roof instead of being jammed under it --
  // the same band every other window on the building keeps.
  const SINK = 0.55
  const SILL = 0.18
  const winH = 0.6
  const winW = 0.62
  const eaveH = SILL + winH + 0.07 + 0.26
  const apexH = eaveH + DORM_RISE
  const hw = DORM_HW

  // HOW FAR THE COVERING OVERSAILS, which it does for the reason the roof this
  // grew out of does: the rafters run past the wall and the straw runs past the
  // rafters, and a stub is built by the people who built the roof. So it is the
  // BUILDING'S OWN overhang it is given, cut to TRIM -- the full 0.4 m of the
  // house on a plate a metre wide would be a mushroom, and none at all is the
  // box with a lid this used to be. The verge keeps the roof's own 3:4 against
  // the eave, and `k.overhang` scales both, so the house wearing deep sheltering
  // eaves has the dormer to match rather than one bought off a different roof.
  // dormerHalfWidth() up top is the same sum, and is what holds a pair apart.
  const eaveOut = overhang * DORM_TRIM * k.overhang
  const vergeOut = eaveOut * 0.75
  // And how far the sheet floats over the boarding it is laid on. Vertical, not
  // along the pitch normal: shifted straight up, both pitches still meet at the
  // apex and the ridge closes exactly, where a normal offset would open a slot
  // along the ridge as wide as the lift.
  const LIFT = 0.035

  // HOW FAR IN THE SWEEP HAS TO RUN before the covering is clear over the top of
  // it. Marched, not solved: `sheetAt` is the triangles, and the triangles are
  // where the sag and the buckle are. Measured to the top of the OVERSAILING
  // sheet and not the solid under it, that being the highest thing drawn.
  const CLEAR = 0.22
  let depth = 0
  for (let t = 0.4; t <= ridgeLimit; t += 0.12) {
    if (sheetAt(x - nx * t, z - nz * t) >= faceY + apexH + LIFT + CLEAR) { depth = t; break }
  }
  if (depth <= 0) return null

  // The section, in (a, v): `a` runs across the face and `v` up from where the
  // main sheet crosses it. WOUND ANTICLOCKWISE, which is the whole winding
  // argument for the solid: for a CCW loop the outward normal of the edge from
  // corner i to corner j is (dv, -da), and every face below is wound front edge
  // first, back edge second, which lands on exactly that normal for all five of
  // them at once. Get the loop right and there is nothing left to get wrong.
  const sec = [
    [0, apexH], [-hw, eaveH], [-hw, -SINK], [hw, -SINK], [hw, eaveH],
  ]
  // The face frame. `u` is the horizontal across the face, chosen so that
  // cross(u, +y) is the outward normal, which is what makes a quad wound (u
  // first, y second) face out of the building rather than into it.
  const ux = nz
  const uz = -nx
  const P = (i, d) => [
    x + ux * sec[i][0] - nx * d,
    faceY + sec[i][1],
    z + uz * sec[i][0] - nz * d,
  ]
  const A = sec.map((_, i) => P(i, 0))
  const B = sec.map((_, i) => P(i, depth))

  const wallLayer = DORMER_WALL_LAYER[style]
  const wallTile = TILE_METRES[wallLayer]
  const roofTile = TILE_METRES[layer]
  // The wall frame, evaluated in WORLD space rather than off the quad's own
  // corners: U is the world position projected onto the face's own horizontal,
  // V is absolute height. Same courses as the wall below, and the gablet's fan
  // of three triangles shares one frame instead of getting a new one per
  // triangle -- which is the reason these are explicit and the cheeks below are
  // not, a fan having no single pair of edges to derive a frame from.
  const wallUV = (p) => [(p[0] * ux + p[2] * uz) / wallTile, p[1] / wallTile]
  // ONE TINT FOR ALL FIVE STYLES, including the two that are stone and plaster
  // down at ground level. wall2 tints those with groundGrime, and a grime is a
  // function of height that is spent by the eave, arriving within a few percent
  // of white. So at the height a dormer sits at, every wall on the building is
  // showing its layer very nearly untinted, whatever it is made of.
  const wallO = { layer: wallLayer, color: TINT.timber }

  // The gablet, and its buried twin at the back of the sweep. The window stands
  // in front of the first of them; the second is under the covering and is here
  // because a solid with an open end is not a solid.
  for (let i = 1; i < sec.length - 1; i++) {
    b.tri(A[0], A[i], A[i + 1], { ...wallO, uvs: [wallUV(A[0]), wallUV(A[i]), wallUV(A[i + 1])] })
    b.tri(B[0], B[i + 1], B[i], { ...wallO, uvs: [wallUV(B[0]), wallUV(B[i + 1]), wallUV(B[i])] })
  }

  // The slant of one pitch, which is the V the covering is measured along: the
  // eave corner is 0 and the apex is the full length of the rafter, so the straw
  // laps from the ridge down to the eave at the density it does everywhere else.
  const rafter = Math.hypot(hw, apexH - eaveH)
  const slant = rafter / roofTile
  const dU = depth / roofTile
  const pitchUV = (vLo, vHi) => [[0, vLo], [dU, vLo], [dU, vHi], [0, vHi]]
  const face = (i, j, o) => b.quad(A[i], B[i], B[j], A[j], o)
  face(0, 1, { layer, color, uvs: pitchUV(slant, 0) })
  face(4, 0, { layer, color, uvs: pitchUV(0, slant) })
  // The cheeks take the derived frame, because they are single quads and their
  // own first edge IS the sweep: U comes out running back into the roof and
  // `vWorldY` puts V on absolute height, which is the whole point.
  face(1, 2, { ...wallO, vWorldY: true })
  face(3, 4, { ...wallO, vWorldY: true })
  // The floor, buried below the covering. NOT `vWorldY`: it is horizontal, so
  // world height is one number across the whole face and the tile would smear
  // over it -- the same trap the old prism fell into on all five faces at once.
  face(2, 3, wallO)

  // THE COVERING IS A SHEET LAID OVER THE STUB rather than a face of it, and it
  // has to be, because that is the only way an overhang can exist here. A roof
  // in this kit has no thickness, so a face that oversails the solid it belongs
  // to leaves that solid open along the edge it left behind, and the airtight
  // check is exactly the check that catches it. So the five-sided solid keeps
  // all five of its faces and stays closed -- its two pitches standing in for
  // the boarding, in the covering's own layer so that what shows in the slot at
  // the eave is more roof -- and the sheet floats LIFT above them and runs out
  // past the eave corners and past the gablet.
  //
  // DOUBLED, for the same reason slopeSurface() doubles: a doubled quad seals
  // its own four edges, so an oversailing sheet costs the airtight check
  // nothing, and the underside of an overhang is the one piece of a roof you
  // are guaranteed to see from the ground.
  const tipA = hw + eaveOut * (hw / rafter)
  const tipV = eaveH - eaveOut * ((apexH - eaveH) / rafter)
  const Q = (a, v, d) => [
    x + ux * a - nx * d,
    faceY + v + LIFT,
    z + uz * a - nz * d,
  ]
  const dLo = -vergeOut
  const cU = (depth + vergeOut) / roofTile
  const cV = (rafter + eaveOut) / roofTile
  const coverUV = (vLo, vHi) => [[0, vLo], [cU, vLo], [cU, vHi], [0, vHi]]
  const coverO = { layer, color, double: true }
  const ridge = (d) => Q(0, apexH, d)
  const tip = (s, d) => Q(s * tipA, tipV, d)
  b.quad(ridge(dLo), ridge(depth), tip(-1, depth), tip(-1, dLo),
    { ...coverO, uvs: coverUV(cV, 0) })
  b.quad(tip(1, dLo), tip(1, depth), ridge(depth), ridge(dLo),
    { ...coverO, uvs: coverUV(0, cV) })

  windowUnit2(b, {
    x, z, y0: faceY + SILL, nx, nz, width: winW, height: winH,
    shutters: false, seed: seed * 29 + 7, detail, k,
  })
  return { x, z, nx, nz, faceY, depth, apexH, eaveH, hw, sink: SINK, lift: LIFT }
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/**
 * How high a solid of radius `r` standing at (x, z) may go and still be UNDER
 * the covering, allowing `gap` for the warp.
 *
 * The distinction the naive answer misses is that a post is not a line. Ask the
 * roof how high it is over the post's AXIS and cap the post there and the post
 * is still through the roof, because a roof over a corner is falling away in
 * both directions at once: at 12 cm out along a 40 degree pitch the covering is
 * already 10 cm lower than it was over the middle of the post. So the question
 * is asked at the four extremes of the section and the LOWEST answer wins, which
 * is the near arris -- the one that would come through first.
 *
 * The post may still be cut off well below where it wants to end. That is
 * correct and is the whole instruction: a beam may touch the roof plane, meet
 * it, be swallowed by it, and never cross it.
 */
export function clearUnder(topAt, x, z, r, gap = 0.03) {
  let y = topAt(x, z)
  for (const [ox, oz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    y = Math.min(y, topAt(x + ox, z + oz))
  }
  return y - gap
}

/**
 * The tallest a doorway at `door` may be and still stay under the covering.
 *
 * A door is the one opening that cannot duck. A window is placed at a height
 * somebody chose and can be slid down until it fits; a door stands ON THE FLOOR,
 * so the only thing left to give is its head. On a small hut with a low eave --
 * seed 44043 is the one -- the wall line is under the slope's lowest part and a
 * nominal 1.95 m door puts its lintel straight through the thatch.
 *
 * What is measured is the SURROUND, not the opening: `HEAD` is the jamb width
 * plus the lintel's own thickness above it, the part that actually comes through.
 * And it is measured across the whole of the surround's footprint -- out to both
 * jambs and out to the lintel's front face -- for the reason `clearUnder` gives:
 * a roof over a doorway is falling away as it goes, and the corner nearest the
 * eave is the one that surfaces first.
 *
 * The floor of 1.4 m is deliberate and is a visible squat door, not a failure:
 * under an eave that low there is no honest full-height door to be had, and a
 * head-ducking door in a turf-roofed hut is the right answer anyway.
 */
export function doorHeight({ x, z, nx, nz, y0, width, height }, topAt) {
  if (!topAt) return height
  const HEAD = 0.17
  const hw = width / 2 + 0.14
  let top = Infinity
  for (const a of [-hw, 0, hw]) {
    for (const o of [-0.05, 0.16]) {
      // The wall's own frame: (nz, -nx) runs along it, (nx, nz) out of it.
      top = Math.min(top, topAt(x + nz * a + nx * o, z - nx * a + nz * o))
    }
  }
  return Math.max(1.4, Math.min(height, top - HEAD - y0))
}

/**
 * THE OPENINGS A WALL CARRIES, as boxes in that wall's own frame.
 *
 * The plan states a window or a door in world space and never says which wall it
 * belongs to, so the wall works it out. Not by asking which wall the opening was
 * MEANT for -- by asking what volume it clears and whether this wall's timbers
 * are in it. The two are not the same question, and the difference is the whole
 * reason this is a box and not a span: the wall a door is cut into is not the
 * only wall that can reach into the doorway. A log course runs 20 cm past its
 * corner as an interlock, and a door set a hand's width from that corner has the
 * SIDE wall's log ends standing in the opening -- at right angles to it,
 * invisible to any test that only knows about openings lying on the line.
 * Reduced to a box, both cases are the same arithmetic.
 *
 * Exported because the king post is raised in building.js, outside any wall, and
 * it stands exactly where a gable end's middle bay window wants to be.
 *
 * `blocked(a, pad, half)` asks whether the point `a` along the wall is inside an
 * opening, where `pad` is the clearance wanted either side and `half` is how far
 * the timber in question stands either side of the wall plane -- an opening the
 * timber never reaches into is not in its way. `dodge` answers the follow-up:
 * the nearest point that is NOT blocked, or null if there is no such point on
 * this wall.
 */
export function wallOpenings({ p0, p1, openings }) {
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len = Math.hypot(dx, dz)
  const ux = dx / len
  const uz = dz / len
  const nx = -uz
  const nz = ux
  const boxes = []
  for (const o of openings) {
    // Loudly, because the failure mode is silent: an opening with no facing
    // makes every box coordinate NaN, every NaN comparison false, and the wall
    // then dodges nothing at all while reporting no error.
    if (!Number.isFinite(o.nx) || !Number.isFinite(o.nz)) {
      throw new Error(`wallOpenings: opening at ${o.x},${o.z} has no nx/nz facing`)
    }
    // The opening's own frame: `t` runs along its face, `o.n*` out of it. The
    // depth range is the clear reveal, from a little behind the wall plane out to
    // the front of the surround.
    const tx = o.nz
    const tz = -o.nx
    let a0 = Infinity; let a1 = -Infinity; let n0 = Infinity; let n1 = -Infinity
    for (const u of [-o.hw, o.hw]) {
      for (const dp of [-0.06, 0.16]) {
        const rx = o.x + tx * u + o.nx * dp - p0[0]
        const rz = o.z + tz * u + o.nz * dp - p0[1]
        const a = rx * ux + rz * uz
        const n = rx * nx + rz * nz
        a0 = Math.min(a0, a); a1 = Math.max(a1, a)
        n0 = Math.min(n0, n); n1 = Math.max(n1, n)
      }
    }
    if (a1 < -0.4 || a0 > len + 0.4) continue
    boxes.push({ a0, a1, n0, n1, y0: o.y0, y1: o.y1, solid: !!o.solid })
  }
  const blocked = (a, pad, half) => boxes.some((o) =>
    a > o.a0 - pad && a < o.a1 + pad && o.n1 > -half && o.n0 < half)
  const dodge = (a, pad, half, clear = 0.1) => {
    if (!blocked(a, pad, half)) return a
    // Every opening this point is inside of, merged: two windows a stud-width
    // apart are one obstruction, and stepping clear of the nearer of them would
    // land inside the other.
    let lo = Infinity
    let hi = -Infinity
    for (const o of boxes) {
      if (a > o.a0 - pad && a < o.a1 + pad && o.n1 > -half && o.n0 < half) {
        lo = Math.min(lo, o.a0)
        hi = Math.max(hi, o.a1)
      }
    }
    const left = lo - pad - clear
    const right = hi + pad + clear
    for (const c of Math.abs(left - a) <= Math.abs(right - a) ? [left, right] : [right, left]) {
      if (c < 0.05 || c > len - 0.05) continue
      if (!blocked(c, pad, half)) return c
    }
    return null
  }
  return { boxes, blocked, dodge, len }
}

/**
 * A wall, split along its length so the warp field has something to belly out,
 * and TOPPED BY THE ROOF IT STANDS UNDER rather than by a level line.
 *
 * Two structural changes from v1. First `face()`: one quad became `cols` of
 * them. A wall drawn as a single quad is the clearest case of the limit stated
 * at the top of warp.js -- the field moves its four corners and cannot touch
 * what is between them, so a ten-metre inn front stays a perfect plane no matter
 * how crooked everything standing on it has become. One seam every ~2.6 m is
 * enough for it to read as settled, and the wall face is the cheapest surface in
 * the kit to subdivide: it is doubled, so a column costs four triangles.
 *
 * Second, and the reason the roof became a sheet: `topAt`. Hand this a function
 * from world (x, z) to the height of the covering above it, and the wall's top
 * edge is sampled from that at every column boundary and tucked `TUCK` under it,
 * instead of being ruled flat at `y1` and left to be stabbed through by a roof
 * that sags 30 cm between its supports. THIS IS WHAT REPLACES gableEnd(): a
 * gable-end wall is not a wall plus a triangle, it is a wall whose top happens to
 * peak in the middle, and building it as one surface removes the seam between the
 * two as well as the triangle.
 *
 * `topCols` is how many columns the top profile needs to be sampled at, which is
 * a different question from how many the warp needs -- a 3 m gable end is short
 * enough to want one warp seam and still needs a column boundary exactly at the
 * ridge or the peak gets chopped off flat. The wall takes whichever is more.
 *
 * The four styles, the half-timber bay rule and the stone course are v1's. The
 * log courses are not: see below.
 */
export function wall2(b, {
  p0, p1, y0, y1, style, seed = 0, rough = 0, sillY, detail = 2,
  tint = TINT.timber, topAt = null, topCols = 0, topBreaks = null,
  openings = [], k = FLAT, plain = false,
}) {
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len = Math.hypot(dx, dz)
  // Nothing drawn and nothing to report: there is no top edge to have found and
  // no plate to have laid on it.
  if (len < 0.01 || y1 <= y0) return null
  const ux = dx / len
  const uz = dz / len
  const nx = -uz
  const nz = ux

  const A = (t, y) => [p0[0] + ux * len * t, y, p0[1] + uz * len * t]

  // Two different things are done with the openings, and the difference is what
  // each timber is FOR. A stud is a frame member and can stand a little either
  // side of where the bay grid puts it, so it steps clear of an opening. A log
  // course is not optional -- it IS the wall -- so it is cut at the opening
  // instead. See wallOpenings() above for what a box is and why it is a box.
  const { boxes: OP, blocked, dodge } = wallOpenings({ p0, p1, openings })

  // WHERE THE WALL IS SPLIT ALONG ITS LENGTH. Two independent demands, merged.
  //
  // The warp wants columns at roughly even spacing and does not care where. The
  // covering wants a column boundary at every fold in the roof it crosses, and
  // cares exactly: between two folds the top edge is a chord of a plane, which
  // is the covering itself, and either side of one it is a chord of a crease,
  // which is a slot or a stab. `topBreaks` is what the roof answers with. It
  // costs 4 triangles a column and the whole point of the roof being a sheet was
  // to be able to afford them here.
  //
  // `topCols` remains the FLOOR, not the answer: a lean-to whose wall crosses no
  // fold at all still wants a couple of seams for the field to work with.
  const evenCols = Math.max(
    detail >= 2 ? Math.max(1, Math.min(4, Math.round(len / 2.6))) : 1,
    topAt ? topCols : 0,
  )
  const wanted = []
  for (let i = 1; i < evenCols; i++) wanted.push(i / evenCols)
  if (topAt && topBreaks && detail >= 2) {
    const q0 = A(0, 0)
    const q1 = A(1, 0)
    wanted.push(...topBreaks(q0[0], q0[2], q1[0], q1[2]))
  }
  wanted.sort((a, c) => a - c)

  // How far under the covering the wall stops. Not zero, because the warp field
  // is applied to the roof's vertices and to the wall's separately: they start
  // life at the same place but the roof's are metres away at the corners of the
  // triangle, and a field that is smooth is not a field that is linear, so the
  // covering ends up a few millimetres off the plane its corners promised. That
  // residual, and nothing else, is what this is for now that the top edge is
  // sampled on the folds.
  //
  // 12 mm, not the 25 mm it was. Being generous here is NOT free, which took a
  // ray probe to see: the slot the tuck leaves is under the overhang, where a
  // grazing ray from inside goes out through it once the sagged eave drops to
  // the height of the head that is looking. It is bounded at both ends, which is
  // why it is this number and not zero -- go under about 10 mm and the worst
  // flat wall reaches the covering exactly, with nothing left for the gate that
  // says nothing but masonry stands through it; go back up and the daylight
  // returns, three buildings' worth by 15 mm.
  const TUCK = 0.012
  const heightOf = (u) => {
    if (!topAt) return y1
    const q = A(u, 0)
    return Math.max(y0 + 0.05, topAt(q[0], q[2]) - TUCK)
  }

  // Two boundaries closer than 12 cm are a sliver: four triangles for a column
  // nobody can see the width of. They happen constantly -- at the ridge, where
  // both slopes fold at the same place and each brings a diagonal near it -- so
  // the near ones collapse. WHICH ONE SURVIVES IS THE WHOLE POINT: keep the
  // HIGHEST, because a dropped fold is a chord cut straight across whatever it
  // was the top of, and the fold you cannot afford to lose is always the apex.
  // First-wins loses the ridge to a diagonal 10 cm short of it and slices the
  // peak off the gable.
  const U = [0]
  const TOP = [heightOf(0)]
  const minStep = Math.min(0.12, len * 0.06) / len
  for (const u of wanted) {
    if (u <= minStep || u >= 1 - minStep) continue
    const y = heightOf(u)
    const last = U.length - 1
    if (u - U[last] >= minStep) { U.push(u); TOP.push(y); continue }
    if (last > 0 && y > TOP[last]) { U[last] = u; TOP[last] = y }
  }
  U.push(1)
  TOP.push(heightOf(1))
  const cols = U.length - 1
  const topMin = Math.min(...TOP)
  // WHAT THE WALL HANDS BACK. A window has to duck under the timber lying across
  // the top of this wall as well as under the roof above it, and the only place
  // the wall plate's height is known is here -- it follows `topMin`, which comes
  // out of the column sampling above and out of nothing else. Working it out a
  // second time in building.js would be a second chance to get a different
  // answer and a beam laid across a window head.
  const info = { topMin, plateY: null }

  const level = (y) => new Array(cols + 1).fill(y)
  // Where a post standing at a corner of this wall has to stop. Without a
  // covering to duck under it is the wall's own top edge, which is flat.
  const postTop = (x, z, r) => (topAt
    ? Math.max(y0 + 0.3, clearUnder(topAt, x, z, r * 1.4))
    : y1 + 0.04)

  // Double-sided, and NOT because anyone is meant to see the inside face: a wall
  // is one surface because openings are never cut out of it, and the back face is
  // what closes it. A lone quad leaves four open edges; a back-to-back pair
  // leaves none, and that holds per column.
  const face = (lo, hi, layer, color) => {
    for (let i = 0; i < cols; i++) {
      b.quad(A(U[i], lo[i]), A(U[i + 1], lo[i + 1]),
        A(U[i + 1], hi[i + 1]), A(U[i], hi[i]), {
        layer, vWorldY: true, color, double: true, origin: A(0, y0),
      })
    }
  }

  // `plain` is the surface without the carpentry: the face, following the roof
  // at full resolution, and none of the quoins, studs, corner posts or log ends
  // that stand out of it. It is NOT the same as dropping a tier -- a tier down
  // also coarsens the top edge, and the one place this is used (the strip of
  // gable standing above an abutting wing's roof) is a place where the top edge
  // is the only thing that matters and the carpentry is the only thing nobody
  // can get close enough to see.
  const furniture = detail >= 2 && !plain

  const base = level(y0)
  // Kept below the lowest point of the top edge, so a wall that dies away to
  // nothing under a valley does not invert its own courses.
  const split = Math.max(y0 + 0.1, Math.min(sillY ?? y0 + (y1 - y0) * 0.38, topMin - 0.1))

  if (style === WALL_STYLE.MASONRY) {
    // Rubble the whole way up, grimed a little deeper and a little higher than a
    // stone base is: a wall that is stone to the eaves has no timber above it to
    // explain where the weathering stops, so it has to fade out on its own.
    face(base, TOP, LAYER.STONE, groundGrime(y0, 1.2, 0.3))
    if (!furniture) return info
    // QUOINS. The dressed corner stones, drawn as one square-sectioned post per
    // corner rather than as a chain of alternating blocks -- at 8 triangles a
    // block a real chain is 120 triangles a corner, and this is 16 for a shape
    // the eye reads the same way, because what says "quoin" at any distance is a
    // corner that is proud of the wall and a different stone from it.
    //
    // Barely bowed, unlike a stave post: timber bends and dressed stone does
    // not, and a quoin that curves reads as rubber. It keeps the jitter, though,
    // because the individual stones were never square either.
    const hu = 0.125
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      member2(b, [px, y0, pz], [px, postTop(px, pz, hu), pz], {
        hu, hv: hu, seed: rough * 17 + 50 + t, round: 0.18, jitter: 0.14,
        segments: 2, bow: k.bow * 0.25,
        layer: LAYER.STONE, color: TINT.stone, vWorldY: true,
      })
    }
    return info
  }

  if (style === WALL_STYLE.STONE_BASE) {
    face(base, level(split), LAYER.STONE, groundGrime(y0, 1.0, 0.28))
    face(level(split), TOP, LAYER.TIMBER_PLANK, tint)
    if (furniture) {
      // The offset course where the timber sits back on the masonry: a swept
      // member, so it has a section and a shadow. It runs 0.05 past each corner
      // so the courses of two walls meet instead of leaving a notch.
      const ex = ux * 0.05
      const ez = uz * 0.05
      const out = 0.018
      member(b,
        [p0[0] - ex + nx * out, split, p0[1] - ez + nz * out],
        [p1[0] + ex + nx * out, split, p1[1] + ez + nz * out],
        {
          hu: 0.05, hv: 0.045, sides: 5, seed: rough * 23 + 9,
          round: 0.3, jitter: 0.2, layer: LAYER.STONE, color: TINT.stone,
        })
    }
    return info
  }

  if (style === WALL_STYLE.HALF_TIMBER) {
    face(base, TOP, LAYER.PLASTER, groundGrime(y0, topMin - y0, 0.34))
    if (!furniture) return info
    const t = 0.075 // how far the timber stands out
    const wd = 0.16 // member width
    const beam = { layer: LAYER.TIMBER_BEAM, color: TINT.timberDark }
    // A rail runs HORIZONTALLY, so it does not take `vWorldY`: world height is
    // the same number at both of its ends, and a V that never changes is one
    // column of texels stretched the length of the timber. Only the studs, which
    // stand up, want their V measured in absolute world height.
    const rail = (ya, yb, kk) =>
      member(b, [p0[0], (ya + yb) / 2, p0[1]], [p1[0], (ya + yb) / 2, p1[1]],
        { hu: t, hv: (yb - ya) / 2, seed: rough * 17 + kk, round: 0.35, ...beam })
    rail(y0, y0 + wd, 1)
    // The wall plate follows the LOWEST point of the covering, not the tallest:
    // it is one straight timber and it has to stay under the roof for its whole
    // length, so on a gable end it sits at the eaves and the plaster carries on
    // up past it into the tympanum, which is what a real one does.
    //
    // Which also makes it the lowest thing on the building that a window can end
    // up jammed against, and the reason `info.plateY` exists: on a gable end the
    // covering runs metres above the plate, so a window that has cleared the
    // ROOF by 30 cm can still have this beam lying across its head.
    rail(topMin - wd, topMin, 2)
    info.plateY = topMin - wd
    // `i < bays`, not `i <= bays`: a wall owns the post at its START corner and
    // leaves the one at its end to the wall that starts there.
    const bays = Math.max(1, Math.round(len / 1.5))
    // How much daylight to leave between a stud's edge and an opening's. The
    // bay grid here is 1.5 m and the one plan.js hangs windows on is 2.15 m, so
    // the two are guaranteed to collide sooner or later; the question is only
    // what happens when they do.
    const PAD = wd / 2 + 0.07
    const CLEAR = 0.1
    const placed = []
    for (let i = 0; i < bays; i++) {
      // Not across an opening: a stud framed over a window is the single most
      // obviously-wrong thing a half-timber wall can do. `t + 0.02` is how far
      // the stud stands either side of the plane, which is what keeps a door on
      // the NEXT wall along from deleting this wall's corner stud -- that door's
      // box is beside the plane, not on it, so the stud is not in its way.
      //
      // Deleting the stud used to be the whole answer, and it left the frame
      // visibly gappy while the window still sat hard against whatever stud
      // survived next door. So SHIFT it instead: slide it to whichever side of
      // the obstruction is nearer and stand it a hand's width clear. Only a stud
      // with nowhere to go at all is dropped.
      const bay = len * i / bays
      const a = dodge(bay, PAD, t + 0.02, CLEAR)
      // Nowhere on this wall to stand it, or so close to a stud already up that
      // the pair would read as one clumsy double post.
      if (a === null) continue
      if (a !== bay && placed.some((p) => Math.abs(p - a) < 0.5)) continue
      placed.push(a)
      const s = a / len
      const px = p0[0] + dx * s
      const pz = p0[1] + dz * s
      // From y0, NOT from the top of the bottom rail. A post that starts on a
      // rail is right in a drawing and wrong in the eye: the rail is 16 cm of
      // timber that the plinth, the ground or a step in front of it can hide any
      // part of, and a stud that begins wherever the rail stops being visible
      // reads as hanging rather than as carrying. It costs nothing to run it into
      // the sill -- the kit is a union of interpenetrating solids and this is one
      // more overlap.
      //
      // The section frame for a vertical sweep is (+z, +x), so which half-extent
      // is which depends on the wall's direction.
      member(b, [px, y0, pz], [px, topMin - wd, pz], {
        hu: ux ? t : wd / 2, hv: ux ? wd / 2 : t,
        seed: rough * 17 + 10 + i, round: 0.35, ...beam, vWorldY: true,
      })
    }
    return info
  }

  if (style === WALL_STYLE.STAVE) {
    face(base, TOP, LAYER.TIMBER_PLANK, tint)
    if (!furniture) return info
    // Corner posts, which is what a stave wall is actually framed by. Segmented,
    // so the field can bow them: these are the tallest single verticals on the
    // building and a dead-straight one beside a bellied wall is the thing that
    // gives the whole trick away. `bow` is passed explicitly -- member2 defaults
    // it to nothing, and these posts are exactly what the parameter was for.
    // Six-sided rather than the default five-to-seven: 20 triangles, and on a
    // 23 cm post the seventh facet is not a thing anyone can see.
    const hu = 0.115
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      member2(b, [px, y0, pz], [px, postTop(px, pz, hu), pz], {
        hu, sides: 6, seed: rough * 17 + 30 + t, round: 0.5, segments: 2,
        bow: k.bow,
        layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
      })
    }
    return info
  }

  // WALL_STYLE.LOG
  //
  // v1 and v2's first cut both drew a log wall as a flat plane wearing a log
  // texture, and then apologised for it with two or three stub log-ends poking
  // past each corner so the SILHOUETTE would read as a cabin. That is a strange
  // bargain -- 16 triangles each on six little stubs, about 96, spent on the only
  // three courses anybody could see the end of, while the wall between them stays
  // a painted-on stripe. Run the same log the whole length of the wall instead:
  // five 5-sided sweeps at 16 triangles is 80, it is CHEAPER than the stubs were,
  // and now the wall has real courses that catch light on their top halves, throw
  // a shadow line under each one, and break the corner where two walls meet.
  //
  // The flat backing face stays underneath. It is what makes the wall airtight
  // and what covers the gaps at the very top where the courses run out under a
  // sloping roof, and it costs 4 triangles a column.
  face(base, TOP, LAYER.TIMBER_BEAM, tint)
  if (!furniture) return info

  const course = TILE_METRES[LAYER.TIMBER_BEAM] / 2
  // 0.54 rather than 0.5 so consecutive logs OVERLAP by a couple of centimetres
  // instead of meeting on a tangent line that the warp field would then pull open.
  const r = course * 0.54
  // The log is swept along the wall line, so if it were centred there it would
  // stand r = 23 cm proud of the plane -- far enough out to swallow every window
  // in the wall, which sit at 1 to 4 cm. Set back so it protrudes 5 cm.
  const inset = r - 0.05
  const phase = seed & 1
  // How far past the opening the log is cut. The door's jamb is 14 cm of timber
  // standing 14 cm proud of the wall, so an end left at 10 cm is behind it and
  // is never seen; cutting flush with the opening instead would leave a raw log
  // face in the doorway's own reveal.
  const JAMB = 0.1
  for (let kk = 0; ; kk++) {
    const y = y0 + course * (kk + 0.5)
    if (y + r > topMin) break
    // Alternate courses run long past the corners: that is the interlock, and it
    // is the reason the phase is taken from the seed rather than being fixed --
    // two walls meeting at a corner must not both stick out on the same course.
    const stick = (kk & 1) === phase ? 0.2 : 0.02
    // WHERE THIS COURSE SURVIVES.
    //
    // A log stands 5 cm proud of the wall plane and a door leaf hangs at 3 cm, so
    // a course crossing a doorway comes through the door -- from inside the house
    // you can see five logs lying across the opening. Windows do not have the
    // problem: their surround starts at 16 cm and their glass at 7 cm, both in
    // front of the log, which is why only `solid` openings cut here.
    //
    // Cutting is the only option available. A stud can be moved because the bay
    // beside it will do its job; a course IS the wall, and moving it up leaves a
    // stripe of daylight.
    let spans = [[-stick, len + stick]]
    for (const o of OP) {
      if (!o.solid || y - r >= o.y1 || y + r <= o.y0) continue
      // The course's own slab of plan: set back by `inset` and r thick, so it
      // reaches 5 cm out of the wall and 40 cm back into it.
      if (o.n1 <= -inset - r || o.n0 >= -inset + r) continue
      const c0 = o.a0 - JAMB
      const c1 = o.a1 + JAMB
      spans = spans.flatMap(([a, c]) => {
        if (c <= c0 || a >= c1) return [[a, c]]
        const out = []
        if (c0 - a > 0.18) out.push([a, c0])
        if (c - c1 > 0.18) out.push([c1, c])
        return out
      })
    }
    for (const [a, c] of spans) {
      member(b,
        [p0[0] + ux * a - nx * inset, y, p0[1] + uz * a - nz * inset],
        [p0[0] + ux * c - nx * inset, y, p0[1] + uz * c - nz * inset],
        {
          // No `vWorldY`. A log is horizontal, so world height is the same number
          // at both of its ends: the coordinate the sweep measures its tiles by
          // would be CONSTANT down the whole length, and every log would wear one
          // column of texels stretched five metres. `vWorldY` is for the things
          // that stand up -- the studs and the corner posts, where lining the
          // texture up in absolute height is what makes a corner read as a corner.
          hu: r, sides: 5, seed: rough * 17 + 40 + kk, round: 0.95, jitter: 0.1,
          layer: LAYER.TIMBER_BEAM, color: tint,
        })
    }
  }
  return info
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * A member that bends.
 *
 * `member()` is a two-ring prism, so the warp field can only move its two ends:
 * it tilts, which is most of the way to "no column is quite plumb", but it can
 * never bow. `segments` inserts interior rings so it can, and `bow` gives it a
 * head start by pushing the middle off the straight line before the field ever
 * sees it.
 *
 * Costs 2n more triangles per extra segment against member()'s 4n-4, so it is
 * NOT the default and is spent only on the timbers whose whole job is to be a
 * long straight line the eye can check: porch posts, stave corner posts, the
 * king post up a gable. Everything shorter than about a metre stays a plain
 * member, where a bow would be a rounding error with a price tag.
 *
 * `path` overrides the straight line entirely: hand it t -> [x, y, z] and the
 * member is swept along whatever curve that describes -- a timber following a
 * line the field has already bent, rather than one drawn straight and bent after.
 *
 * WHY `bow` DID NOTHING until now, since it is a good illustration of how a
 * parameter can be live, threaded, documented and still inert. Two independent
 * faults. It was sampled as bow * sin(PI * t) at the ring positions -- and with
 * `segments: 1` the only rings are t = 0 and t = 1, where sin is exactly zero, so
 * the bow was applied twice per member, both times to a value of zero. Hence the
 * clamp below: asking for a bow now buys the segment needed to have one. And
 * separately it was drawn at 1.8 to 4 cm on posts 2 m long, which even once it
 * was reaching the geometry would have been a fraction of a pixel at any distance
 * the LOD keeps this tier for. Both halves had to be wrong for it to be
 * invisible, which is why it survived so long.
 */
export function member2(b, a, bEnd, o) {
  const seed = o.seed ?? 0
  // A bow needs a middle to happen at, so it buys one.
  const segments = Math.max(o.bow > 0 || o.path ? 2 : 1, o.segments ?? 1)
  if (segments === 1 && !o.path) return member(b, a, bEnd, o)

  const sides = o.sides ?? 5 + Math.floor(hash(seed, 77) * 3)
  const hv = o.hv ?? o.hu
  const section = roughSection(sides, o.hu, hv, seed, { jitter: o.jitter, round: o.round })
  const bow = o.bow ?? 0
  // Two perpendiculars to the sweep, so the bow has a plane to happen in. Which
  // pair only rotates the bow direction, and the direction is drawn from the
  // seed anyway.
  const ax = [bEnd[0] - a[0], bEnd[1] - a[1], bEnd[2] - a[2]]
  const len = Math.hypot(ax[0], ax[1], ax[2]) || 1
  const w = [ax[0] / len, ax[1] / len, ax[2] / len]
  const ref = Math.abs(w[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const ex = [ref[1] * w[2] - ref[2] * w[1], ref[2] * w[0] - ref[0] * w[2], ref[0] * w[1] - ref[1] * w[0]]
  const el = Math.hypot(ex[0], ex[1], ex[2]) || 1
  const e1 = [ex[0] / el, ex[1] / el, ex[2] / el]
  const e2 = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]]
  const th = hash(seed, 63) * Math.PI * 2
  const bx = Math.cos(th)
  const bz = Math.sin(th)

  const spine = o.path ?? ((t) => [a[0] + ax[0] * t, a[1] + ax[1] * t, a[2] + ax[2] * t])
  const at = (t) => {
    // sin, so both ends stay exactly where the caller put them -- a member whose
    // ends have drifted is a member that has come out of its mortice.
    const s = bow * Math.sin(Math.PI * t)
    const q = spine(t)
    return [
      q[0] + (e1[0] * bx + e2[0] * bz) * s,
      q[1] + (e1[1] * bx + e2[1] * bz) * s,
      q[2] + (e1[2] * bx + e2[2] * bz) * s,
    ]
  }
  const opts = {
    layer: o.layer ?? LAYER.TIMBER_BEAM,
    color: o.color ?? TINT.timber,
    tile: o.tile,
    uAlongAxis: o.uAlongAxis ?? true,
    vWorldY: o.vWorldY ?? false,
  }
  // Each span is its own closed prism. They share a face at every joint, buried
  // inside the member, which is a union of interpenetrating solids exactly as
  // the rest of the kit is -- and the edge-pairing gate is built for that.
  for (let i = 0; i < segments; i++) {
    b.prism(at(i / segments), at((i + 1) / segments), section, opts)
  }
  return b
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

/**
 * A picture frame: ONE rough section swept around a mitred path of four
 * corners, where v1's frameRing could only sweep a rectangle.
 *
 * `path` is the four corners of the frame's CENTRE LINE in the caller's flat
 * (along, up) frame, and `signs` says which corner of the opening each one is,
 * as a pair of +-1. The mitre falls out of the signs: offsetting a corner by `r`
 * on BOTH axes at once is where a rectangle grown by r puts its corner, and it
 * stays the right answer when the rectangle is no longer a rectangle.
 *
 * A closed tube has no caps and no boundary, so it is airtight by construction,
 * and using the SAME section loop at all four corners is what keeps the mitre a
 * mitre rather than a lap joint.
 *
 * WINDING IS DERIVED, NOT EYEBALLED. (a, v, out) is a LEFT handed frame -- p()'s
 * tangent is (-nz, 0, nx) and t x up = -n -- so for this corner order the sweep
 * tangent T satisfies T = e_r x e_o, a side quad's normal is T x S, and that
 * points outward only when S turns CLOCKWISE in (r, o). boxSection() winds
 * anticlockwise, hence the reverse().
 *
 * A BOX SECTION, not a roughSection. This swept a roughSection(4 or 5) until a
 * shutter hung off it turned out to be hanging off nothing: a surround is a
 * 7 x 28 cm timber, a 1-to-4 rectangle, and roughSection spaces its corners by
 * ANGLE -- so four of them land near the diagonals, where the rectangle's own
 * boundary is only 5 cm out, and the section collapses to a diamond a quarter
 * of the depth it was asked for. The reveal it cut was a different depth on
 * every window for no reason anybody chose, and nothing outside the sliver could
 * be relied on to be inside the timber. boxSection puts the corners AT the
 * corners and jitters each one independently, which is the same variety, an
 * honest 7 x 28 section, and (at a flat 4 sides) never more triangles than
 * before.
 */
function frameRing2(b, { p, path, signs, width, back, front, seed = 0, layer, color }) {
  const oc = (back + front) / 2
  const sec = boxSection(width / 2, (front - back) / 2, seed, 0.18).reverse()
  const P = path.map(([pa, pv], c) =>
    sec.map(([r, o]) => p(pa + signs[c][0] * r, pv + signs[c][1] * r, oc + o)))
  const o = { layer, color }
  for (let c = 0; c < 4; c++) {
    const cn = (c + 1) % 4
    for (let s = 0; s < sec.length; s++) {
      const sn = (s + 1) % sec.length
      b.quad(P[c][s], P[cn][s], P[cn][sn], P[c][sn], o)
    }
  }
}

/**
 * Whole numbers of tiles fitted ACROSS a rectangle, rather than sliced out of a
 * world-space grid wherever the rectangle happens to sit.
 *
 * World UVs are right for a wall and are not negotiable there -- absolute world
 * height is what makes a log course run level round a corner instead of stepping
 * at it. They are wrong for everything that is a discrete OBJECT rather than a
 * piece of surface: a pane, a shutter leaf, a door. A window whose glazing bars
 * are cut off mid-pane, and cut off at a different place on the next window along
 * because the building landed on a different half-metre, reads as broken in a way
 * no amount of texture quality fixes. These get the tile squared up on them.
 *
 * Rounded to WHOLE repeats, and never below one, so the tile still meets itself
 * where two of these sit edge to edge and a small rectangle gets one tile rather
 * than a fragment of one.
 */
function fitUV(layer, w, h) {
  const t = TILE_METRES[layer] ?? 1
  const nu = Math.max(1, Math.round(w / t))
  const nv = Math.max(1, Math.round(h / t))
  return [[0, 0], [nu, 0], [nu, nv], [0, nv]]
}

/**
 * A window that was never a rectangle, but IS still symmetrical.
 *
 * v2's first cut strayed each of the four corners independently, which is the
 * obvious way to break a right angle and the wrong one. A quadrilateral with four
 * unrelated corners does not read as a window that has settled -- it reads as a
 * window that has MELTED, because a real opening deforms as a rigid frame does:
 * it racks, it leans, the head spreads wider than the sill as the wall bellies
 * out. What it never does is have one corner wander north-east while its
 * neighbour wanders south-west.
 *
 * So the whole opening now goes through ONE transform, and every part of the
 * window goes through the same one:
 *
 *   taper   signed. The head ends up wider than the sill, or narrower. This is
 *           the flare, and it is the thing that was actually being asked for.
 *   tilt    a rigid rotation about the middle of the opening. Rotation cannot
 *           make a shape melt: it preserves every angle in it.
 *
 * Both are drawn once per window and applied to the opening, the surround path
 * and both shutter leaves, so the leaves stay parallel to the jambs they hang
 * off. Left and right corners get the same treatment by construction, which is
 * what makes it symmetric -- there is no per-corner hash left to be asymmetric
 * with.
 *
 * The surround ring is drawn with FOUR OR FIVE sides in v2 where v1 used five or
 * six. That is a deliberate trade and it pays for the roof: an inn carries
 * fifteen windows, the ring costs 8 triangles a side, and the corners the sixth
 * side was rounding off are now corners that are not square to begin with.
 */
export function windowUnit2(
  b,
  {
    x, z, y0, nx, nz, width = 0.7, height = 0.85, shutters = false,
    seed = 0, detail = 2, k = FLAT, topAt = null, lowAt = null, capY = Infinity,
    warp = null,
  }
) {
  const tx = -nz
  const tz = nx
  const hw = width / 2
  const depth = 0.14
  const frame = 0.07
  // Mutable, because the covering may yet push this window down the wall. Every
  // point of the unit is placed through here, so moving it moves all of them
  // together and the window arrives as the rigid figure it was drawn as.
  let baseY = y0
  const p = (a, v, out) => [x + tx * a + nx * out, baseY + v, z + tz * a + nz * out]

  // THE TRANSFORM SURVIVES EVERY TIER. It moves the four corners the opening is
  // drawn from and adds not one triangle, at any detail -- the frame is still a
  // rect and the glass is still a rect, they are just no longer axis-aligned
  // rects. A village whose windows go square at the LOD line is a village that
  // visibly changes shape as you walk toward it, which is the one thing the
  // tiers exist to avoid, and it was being paid for with nothing.
  const sk = k.skew
  // 1.6 because the whole allowance now goes into one term instead of being spent
  // four ways, and a trapezoid needs a visible difference between its parallel
  // sides before it stops looking like a rectangle drawn slightly wrong.
  const taper = (hash(seed * 41 + 3, 1) - 0.5) * 2 * sk * 1.6
  const rot = k.tilt * (hash(seed * 41 + 3, 2) - 0.5) * 2
  const cs = Math.cos(rot)
  const sn = Math.sin(rot)
  const cv = height / 2
  /** A point of the window in its own (along, up) frame, through the transform. */
  const W = (a, v) => {
    const da = a * (1 + taper * (v / height - 0.5))
    const dv = v - cv
    return [da * cs - dv * sn, cv + da * sn + dv * cs]
  }

  // The opening, corner by corner: bottom-left, bottom-right, top-right, top-left.
  const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  const C = SIGNS.map(([sa, sv]) => W(sa * hw, sv > 0 ? height : 0))

  const ow = hw + frame
  const leafW = width * 0.52

  // WHERE A LEAF IS HUNG, which used to be nowhere. The leaf stood at
  // `depth + 0.03` with its inboard edge on the plane of the surround's outer
  // face -- 1 cm in FRONT of that face, so the two never met: the shutter was a
  // rectangle floating clear of the building with daylight all round it. A
  // shutter is the one piece of a window that is visibly hung on something, and
  // it has to touch the thing it is hung on.
  //
  // So the hinged edge is BURIED IN THE SURROUND: it laps `LAP` onto the ring in
  // plan and hangs at `HANG` out, which is inside the ring's section -- the ring
  // reaches from 12 cm behind the wall plane out to `depth + 0.02` -- and stays
  // inside it however the rough section jitters and however the field moves the
  // two of them. `HANG` also clears a log course, which stands 5 cm proud.
  const LAP = 0.02
  const HANG = 0.1
  // HOW FAR OPEN, per leaf rather than per window, so a window can stand with
  // one leaf back against the wall and the other swung out -- which is what
  // shutters look like on a building somebody lives in. About a third are ajar.
  //
  // A ROTATION about the hinge, not a shear: the free edge swings out and comes
  // back in along the wall by the cosine, so the leaf keeps its width. That
  // matters beyond looks -- plan.js reserves `width * 0.52` of frontage for this
  // leaf, and a leaf that rotates can only ever need less of it than a leaf
  // lying flat.
  //
  // The warp's own `splay` rides on top as a further angle rather than as the
  // sideways push it used to be, so a crooked building's shutters hang crooked
  // and a straight one's still sometimes stand open. Drawn HERE, above the duck
  // below, because how far a leaf reaches off the wall decides where the
  // covering has to be sampled.
  const swing = [-1, 1].map((s) => (hash(seed * 61, s + 6) < 0.34 ? 0.22 + hash(seed * 61, s + 8) * 0.4 : 0)
    + Math.atan2(k.splay * (0.6 + hash(seed * 61, s + 2)), leafW))
  const outReach = shutters
    ? Math.max(...swing.map((th) => HANG + leafW * Math.sin(th)))
    : 0

  // DUCKING UNDER WHATEVER IS ABOVE IT. A window is placed against a wall by the
  // plan, which knows the wall's nominal height and nothing about a roof that
  // sags 30 cm between its supports, flares its eave out past the wall and tips
  // its ridge sideways. High on a gable end that is the difference between a
  // window and a window with a roof through it -- and a frame standing 16 cm
  // proud of the wall crosses the covering well before its own head does, so the
  // height is asked for at the OUTER face of the unit, not at the wall plane.
  //
  // `capY` is the other thing above a window, and it is not the roof: on a
  // half-timber wall a plate 16 cm deep lies under the eaves for the whole
  // length of the wall, and on a gable end the covering is metres above it. A
  // window that has cleared the ROOF by a comfortable margin can still have that
  // beam across its head, which is the same defect as a stud through its jamb
  // seen from the other axis. wall2() hands the height back; Infinity means
  // there is no such beam on this wall.
  //
  // HEAD_CLEAR is a looking number, not a structural one. A window whose frame
  // stops a centimetre under the eaves reads as jammed up into the roof however
  // correct the geometry is, and 30 cm is about the band of wall that has to
  // show above a window for it to sit on the elevation rather than be squeezed
  // into it. plan.js reserves enough for it nominally; this is what enforces it
  // once the field has moved the roof.
  //
  // Move the whole unit down rather than trimming it: a window is a rigid figure
  // (that is the rule the transform above exists to keep) and a trimmed one is a
  // window with a bite out of it. If it cannot be got under by less than three
  // quarters of its own height, it is not a window on that wall at all and it is
  // dropped -- better a blank gable than a sill at knee height.
  const HEAD_CLEAR = 0.3
  const W3 = warp ?? ((px, py, pz) => [px, py, pz])
  if (topAt) {
    // TWO FIGURES DUCK, and they are different shapes. The frame is tall and
    // shallow: it reaches `height + frame` up and 16 cm out. An open leaf is
    // short and deep: it stops at the head of the glass and can stand 40 cm off
    // the wall, out under an overhang where the covering has come down to meet
    // it. Sampling one box around both would drop every shuttered window by the
    // difference, so each asks its own question and the deeper drop wins.
    //
    // MEASURED WARPED, both sides of the comparison. Everything here is drawn
    // straight and bent afterwards, and the field is noise at a scale of a few
    // metres: it slides the covering sideways over the window and moves the two
    // vertically by different amounts. A 30 cm band reserved before the bend can
    // be 3 cm of band after it, and the bent one is the only one anybody sees.
    // So every point is put through the field -- the head of the frame, the
    // covering, the beam -- and the patch the covering is asked about is the
    // WARPED footprint of the warped head. `warp` is null at strength 0, where
    // all of this collapses back to the identity.
    const clearance = (aMax, outMax, vTop) => {
      let vMax = vTop
      for (const sg of [-1, 1]) vMax = Math.max(vMax, W(sg * aMax, vTop)[1])
      const headY = baseY + vMax
      let head = -Infinity
      let over = Infinity
      let xa = Infinity
      let xb = -Infinity
      let za = Infinity
      let zb = -Infinity
      for (const sg of [-1, 0, 1]) {
        for (const out of [0, outMax]) {
          const px = x + tx * sg * aMax + nx * out
          const pz = z + tz * sg * aMax + nz * out
          const q = W3(px, headY, pz)
          if (q[1] > head) head = q[1]
          if (q[0] < xa) xa = q[0]
          if (q[0] > xb) xb = q[0]
          if (q[2] < za) za = q[2]
          if (q[2] > zb) zb = q[2]
          over = Math.min(over, W3(px, Math.min(topAt(px, pz), capY), pz)[1])
        }
      }
      // Point samples cannot see a sheet that ENDS over the window: the lowest
      // covered point of a verge dying in mid-air is the last millimetre of it,
      // between any two samples. `lowAt` reads the whole patch at once and is
      // exact, but only over sheet that is really there -- so it is a floor on
      // the answer above rather than a replacement for it, which still has to
      // supply the continued surface where no sheet reaches at all.
      if (lowAt) over = Math.min(over, lowAt(xa, za, xb, zb, warp))
      return head - (over - HEAD_CLEAR)
    }
    // Twice, because the field is a function of height as well as of plan: drop
    // the window 20 cm and it is standing in a slightly different piece of noise
    // than the one the drop was worked out in. The second pass is centimetres
    // and the third would be tenths of a millimetre.
    let total = 0
    for (let it = 0; it < 2; it++) {
      let drop = clearance(ow, depth + 0.02, height + frame)
      if (shutters) drop = Math.max(drop, clearance(ow + leafW, outReach, height))
      if (drop <= 0.002) break
      total += drop
      if (total > height * 0.75) return
      baseY -= drop
    }
  } else if (capY < Infinity) {
    // No covering to sample, but the beam is still there.
    const drop = W3(x, baseY + height + frame, z)[1] - (W3(x, capY, z)[1] - HEAD_CLEAR)
    if (drop > 0) {
      if (drop > height * 0.75) return
      baseY -= drop
    }
  }

  if (detail <= 0) {
    // LOD2 KEEPS ITS WINDOWS. At the range this tier is drawn at, a cottage is a
    // hundred pixels tall and the single thing that separates a building from a
    // crate is the pattern of openings on its face -- an unfenestrated box reads
    // as scenery. So this is the one ornament that survives all the way down.
    //
    // One doubled rect, four triangles, and it is GLASS across the whole opening
    // including where the frame would be: a dark border drawn half a pixel wide
    // does not read as a frame, it just reads as a smaller window. The shutters
    // are gone at this tier. The transform is NOT -- it moves the four corners
    // this rect is drawn from and costs nothing, and a lit pane leaning a couple
    // of degrees out of square is most of what says "hand-built" at the range
    // where it is the only ornament left.
    const q = [[-ow, -frame], [ow, -frame], [ow, height + frame], [-ow, height + frame]]
      .map(([a, v]) => { const [wa, wv] = W(a, v); return p(wa, wv, 0.02) })
    b.quad(q[0], q[1], q[2], q[3], {
      layer: LAYER.GLASS, color: TINT.glass, double: true,
      uvs: fitUV(LAYER.GLASS, 2 * ow, height + 2 * frame),
    })
    return
  }

  if (detail < 2) {
    // LOD1: three flat rects and nothing else. The frame is a panel behind the
    // glass rather than a ring around it, which is a triangle cheaper than a
    // ring of four quads and reads identically once the reveal is a pixel deep;
    // the glass sits on top of it; each shutter is one more panel lying flat on
    // the wall. Sixteen triangles for what detail 2 spends about sixty on, and
    // the silhouette -- a lit pane inside a dark border with a leaf to each side
    // -- is unchanged, which is the only thing left to get right at this range.
    const rect = (a0, a1, v0, v1, out, layer, color) => {
      const q = [[a0, v0], [a1, v0], [a1, v1], [a0, v1]].map(([a, v]) => {
        const [wa, wv] = W(a, v)
        return p(wa, wv, out)
      })
      b.quad(q[0], q[1], q[2], q[3],
        { layer, color, double: true, uvs: fitUV(layer, a1 - a0, v1 - v0) })
    }
    rect(-ow, ow, -frame, height + frame, 0.012, LAYER.TIMBER_PLANK, TINT.timberDark)
    rect(-hw, hw, 0, height, 0.026, LAYER.GLASS, TINT.glass)
    if (shutters) {
      for (const s of [-1, 1]) {
        const a = s < 0 ? -ow - leafW : ow
        rect(a, a + leafW, 0, height, 0.04, LAYER.TIMBER_PLANK, TINT.timberDark)
      }
    }
    return
  }

  // Glass, set BACK in the reveal rather than flush with the front of the frame,
  // so the surround throws a shadow across it and the window reads as a hole
  // with something in it. Half the reveal rather than a third: a log wall's
  // courses now stand 5 cm proud of the wall plane, and glass any shallower than
  // this would be swallowed by the log that runs across the middle of it.
  const glassAt = depth * 0.5
  b.quad(
    p(C[0][0], C[0][1], glassAt), p(C[1][0], C[1][1], glassAt),
    p(C[2][0], C[2][1], glassAt), p(C[3][0], C[3][1], glassAt),
    { layer: LAYER.GLASS, color: TINT.glass, double: true, uvs: fitUV(LAYER.GLASS, width, height) }
  )

  frameRing2(b, {
    p,
    path: C.map(([pa, pv], i) => [pa + SIGNS[i][0] * (frame / 2), pv + SIGNS[i][1] * (frame / 2)]),
    signs: SIGNS,
    // BACK is behind the wall plane, not on it. A wall is one zero-thickness
    // surface, so a surround that stops at it is a picture frame stuck to a
    // sheet of paper: step to one side and you see the ring end in mid-air and
    // the whole opening stops being an opening. Reaching 12 cm in gives the
    // reveal a depth to be seen edge-on, and it costs nothing at all -- the ring
    // is the same eight quads a side with a taller section.
    width: frame, back: -0.12, front: depth + 0.02,
    seed: seed * 31 + 7,
    layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
  })

  if (shutters) {
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1
      // The hinged edge is inside the surround (see LAP/HANG above); the free
      // edge swings out on `swing`. A shutter flat on the wall is a painted
      // rectangle -- the whole reason a shutter reads as a shutter is that you
      // can see behind it.
      const th = swing[i]
      const aIn = s * (ow - LAP)
      const aOut = s * (ow - LAP + leafW * Math.cos(th))
      const oOut = HANG + leafW * Math.sin(th)
      // The leaf goes through the SAME transform the opening did, so it stays
      // parallel to the jamb it hangs off and square in itself. This is the
      // difference between a shutter that has been hung on a settled building and
      // a shutter that has melted: it is still a rigid rectangle, it is just no
      // longer a plumb one.
      const L = (a, v, out) => {
        const [wa, wv] = W(a, v)
        return p(wa, wv, out)
      }
      const q = [
        L(aIn, 0, HANG), L(aOut, 0, oOut),
        L(aOut, height, oOut), L(aIn, height, HANG),
      ]
      const lo = { layer: LAYER.TIMBER_PLANK, color: TINT.timberDark, double: true }
      const luv = fitUV(LAYER.TIMBER_PLANK, leafW, height)
      // Wound outboard-first for s = -1 so the front face points out of the wall
      // on both sides; the quad is doubled anyway, so this only decides which
      // side gets the lit normal.
      if (s < 0) b.quad(q[1], q[0], q[3], q[2], { ...lo, uvs: luv })
      else b.quad(q[0], q[1], q[2], q[3], { ...lo, uvs: luv })

      // The strap, laid ON the swung leaf rather than on a plane of its own, or
      // an open shutter leaves its ironwork hanging in the air behind it.
      const mix = (t, v) => {
        const [wa, wv] = W(aIn + (aOut - aIn) * t, v)
        return p(wa, wv, HANG + (oOut - HANG) * t + 0.006)
      }
      const sv = height * 0.62
      b.quad(
        mix(0.04, sv), mix(0.96, sv), mix(0.96, sv + 0.1), mix(0.04, sv + 0.1),
        { layer: LAYER.IRON, island: IRON_ISLANDS.shutterStrap, color: TINT.iron, double: true }
      )
    }
  }
}

/**
 * A chimney as ONE flared stack.
 *
 * v1 built two battered prisms of six to eight sides -- a stack and a corbelled
 * cap -- for about 48 triangles, and the result still read as a post with a
 * collar. This is ONE solid of four, five or six sides -- twelve, sixteen or
 * twenty triangles, two stacks in three of them square -- and it goes the other
 * way: WIDER at the crown than at the base, with every corner jittered
 * independently so no two faces are the same width and no corner is regular.
 *
 * The odd five- and six-sided ones are a minority on purpose. A village where
 * every stack has the same corner count reads as a kit even when no two stacks
 * are the same shape, because the eye counts silhouettes before it measures
 * them; a village where none of them agree reads as a different kit. A third of
 * them breaking the pattern is what makes the pattern look unplanned.
 *
 * Flaring outward is not masonry practice and is not meant to be. It is the one
 * shape a real chimney never has, which is exactly why it reads as somewhere
 * else -- and it is the tallest thing on the building, so it is the silhouette
 * the whole village is identified by from across the valley. The 28 to 36
 * triangles it gives back are most of what pays for the roof grid.
 */
export function chimney2(b, { x, z, baseY, topY, w = 0.62, d = 0.62, seed = 0, k = FLAT }) {
  const grime = groundGrime(baseY, 1.4, 0.22)
  // How far the stack is buried below the point the plan seats it at. 0.35 was
  // not enough: `baseY` is where the chimney meets the roof's NOMINAL plane, and
  // the covering under it sags, buckles and tips by more than that between its
  // own supports, so on an unlucky seed the stack ended above the sheet with
  // daylight under it. 0.7 is longer than any of those terms can be, and it is
  // free -- the extra length is inside the building, and a prism's cost is in
  // its section, not its length.
  const foot = baseY - 0.7
  // THE FLARE IS KEPT AT EVERY TIER, and it costs nothing to keep. The lower
  // tiers used to fall back to b.box() here, which is TWELVE triangles for six
  // square faces -- exactly what this prism costs for a four-sided section, so
  // the flare and the corner jitter were being given up for no saving at all.
  // The chimney is the tallest thing on the building and the flare is the whole
  // reason its silhouette reads as somewhere else; the tiers that most need to
  // read from a distance are precisely the far ones.
  //
  // For a VERTICAL sweep prism()'s section frame is (+z, +x), so the section's u
  // is the world z half-extent and its v is the world x one.
  //
  // THE CORNER COUNT IS DRAWN FROM `seed` AND FROM NOTHING ELSE -- not from the
  // detail tier, not from a counter, not once per end of the sweep. The stack
  // has to come out identical every time the same plan is built and identical at
  // every tier it is built at, and both ends of the prism have to be the SAME
  // loop scaled, or the facets twist between base and crown.
  //
  // Four sides keeps its own generator rather than falling out of polySection at
  // n = 4: boxSection puts its corners at the corners of the rectangle, where a
  // polygon walked by angle puts them a factor of root two inside them, and the
  // square majority is the shape the whole look was tuned on.
  const roll = hash(seed, 11)
  const sides = roll < 0.66 ? 4 : roll < 0.84 ? 5 : 6
  const sec = sides === 4
    ? boxSection(d / 2, w / 2, seed * 7 + 1, 0.24)
    : polySection(d / 2, w / 2, sides, seed * 7 + 1, 0.18)
  b.prism([x, foot, z], [x, topY, z], sec, {
    sectionEnd: scaleSection(sec, k.flare),
    layer: LAYER.STONE, color: grime, vWorldY: true,
  })
}

/**
 * Steps down from a doorway to the ground, coarsened below detail 2.
 *
 * v1's flight is one broken slab per riser, and the riser count comes from the
 * RISE -- so a doorway 1.5 m above a sloping site grows an eight-tread flight
 * and spends 96 triangles on it. At detail 2 that is right and it is where the
 * player's feet are. At detail 1 it is by a distance the most expensive thing
 * left on the building, on a part that is a couple of pixels tall, so the flight
 * collapses to two chunky risers spanning the SAME rise and the SAME footprint.
 * The massing and the diagonal survive; the treads do not.
 */
export function steps2(b, { x, z, topY, groundY, width = 1.4, tread = 0.3, seed = 0, detail = 2 }) {
  if (detail >= 2) return steps(b, { x, z, topY, groundY, width, tread, seed, detail })
  const rise = topY - groundY
  if (rise < 0.12) return
  const full = Math.max(1, Math.round(rise / 0.19))
  const n = Math.min(2, full)
  const hw = width / 2
  const step = rise / n
  const run = (tread * full) / n
  const grime = groundGrime(groundY, 0.8, 0.3)
  for (let i = 0; i < n; i++) {
    const y = topY - step * (i + 1)
    const z0 = z + run * i
    b.box([x - hw, y, z0], [x + hw, y + step + 0.02, z0 + run * 1.05],
      { layer: LAYER.STONE, color: grime })
  }
}

/**
 * A porch: deck, footing, canopy, posts and rails.
 *
 * The same part v1 builds, on v2's roof and v2's posts. It is duplicated rather
 * than re-exported for exactly one reason: the porch canopy is the roof a player
 * stands closest to and looks up into, so it is the last one that can afford to
 * be the straight one.
 */
export function porch2(b, { x, z, floorY, groundY = null, width = 2.0, depth = 1.3, headY, seed = 0, detail = 2, k = FLAT }) {
  const hw = width / 2
  const z1 = z + depth
  // Boarding on a rubble footing rather than a floating rectangle. Both arrises
  // get broken, not just the top one: a porch is walked onto from ground level,
  // so the underside is in view the whole way up to it.
  const deckT = 0.14
  const deck = [[x - hw, floorY - deckT, z], [x + hw, floorY, z1]]
  const deckO = { layer: LAYER.TIMBER_HEWN, color: TINT.timber }
  if (detail >= 2) roughSlab(b, deck[0], deck[1], { ...deckO, seed: seed * 7 + 31, bevel: 0.03 })
  else b.box(deck[0], deck[1], deckO)

  const base = groundY ?? floorY - deckT - 0.4
  if (base < floorY - deckT - 0.02) {
    const lo = [x - hw + 0.07, base, z + 0.07]
    const hi = [x + hw - 0.07, floorY - deckT, z1 - 0.07]
    const o = { layer: LAYER.STONE, color: groundGrime(base, 0.9, 0.32) }
    if (detail >= 2) roughSlab(b, lo, hi, { ...o, seed: seed * 7 + 37, bevel: 0.045, bevelBottom: false })
    else b.box(lo, hi, o)
  }

  const roof = leanToRoof2(b, {
    cx: x, cz: z + depth / 2, w: width + 0.3, d: depth,
    highY: headY, lowY: headY - 0.34, dir: '+z', overhang: 0.18,
    layer: LAYER.SHINGLE, tint: TINT.shake, seed: seed * 11 + 5, detail, k,
  })
  if (detail < 2) return roof

  for (const s of [-1, 1]) {
    const px = x + s * (hw - 0.1)
    const pz = z1 - 0.08
    // Segmented and bowed: a porch post is the nearest full-height vertical to
    // anyone at the door, and it is the one the eye rules against the doorframe.
    member2(b, [px, floorY - deckT, pz], [px, headY - 0.3, pz], {
      hu: 0.085, seed: seed * 7 + s + 1, round: 0.4, jitter: 0.2,
      segments: 2, bow: k.bow, color: TINT.timberDark, vWorldY: true,
    })
    // Rail along the open side. It sweeps horizontally, so vWorldY would hold V
    // constant down its whole length and collapse the texture to a line.
    const rx = x + s * (hw - 0.05)
    member(b, [rx, floorY + 0.87, z + 0.05], [rx, floorY + 0.87, z1 - 0.05], {
      hu: 0.055, hv: 0.048, seed: seed * 7 + s + 5, round: 0.55, jitter: 0.16,
      layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
    })
  }
  return roof
}
