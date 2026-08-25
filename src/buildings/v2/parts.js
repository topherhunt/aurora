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
//   chimney      ONE four-sided prism with jittered corners, flaring OUT as it
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

const lerp3 = (p, q, t) => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
  p[2] + (q[2] - p[2]) * t,
]
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

/** A point at parameter u along a polyline whose points are evenly spaced in
 *  parameter (which every row of a roof grid is). */
function polyAt(pts, u) {
  const n = pts.length - 1
  const x = Math.max(0, Math.min(n, u * n))
  const i = Math.min(n - 1, Math.floor(x))
  return lerp3(pts[i], pts[i + 1], x - i)
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

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

  const vLoAt = (s) => alongHalf + vergeLo + splayLo * (s - 0.5)
  const vHiAt = (s) => alongHalf + vergeHi + splayHi * (s - 0.5)
  const tOf = (a, s) => (a + vLoAt(s)) / Math.max(0.001, vLoAt(s) + vHiAt(s))
  const reachAt = (t) => k.reach * (0.55 + 0.45 * wobble(seed * 19 + 3, t))
  const spanAt = (t) => runNominal + overhang + reachAt(t)
  const eaveAt = (t) => eaveY - pitch * (overhang + reachAt(t)) + k.sway * wobble(seed * 17 + 5, t)
  const topOf = (t) => highY - ridgeSag * Math.sin(Math.PI * t)
  const rowBuckle = (j, t) => (j <= 0 || j >= nv ? 0 : k.buckle * wobble(seed * 13 + j, t))
  // Piecewise linear between the seam rows, so this agrees EXACTLY with the mesh
  // at every row and interpolates the way the mesh does between them. That is
  // what makes heightAt() an answer about the triangles rather than about the
  // formula the triangles were sampled from.
  const buckleAt = (t, s) => {
    const x = s * nv
    const j = Math.max(0, Math.min(nv - 1, Math.floor(x)))
    const f = x - j
    return rowBuckle(j, t) * (1 - f) + rowBuckle(j + 1, t) * f
  }
  const yAt = (t, s) => {
    const e = eaveAt(t)
    return e + (topOf(t) - e) * s - k.sag * Math.sin(Math.PI * s) + buckleAt(t, s)
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
   * Inverting (a, c) back to (t, s) is very slightly circular -- s depends on
   * how far the eave reached at t, and t depends on how far the verge splayed at
   * s -- so it is solved by two fixed-point sweeps from the nominal. Both
   * couplings are a few centimetres against spans of metres, so two is not a
   * compromise; the residual is below the tuck the walls sit under anyway.
   */
  const heightAt = (x, z) => {
    const a = alongAxis === 'x' ? x - cx : z - cz
    const c = alongAxis === 'x' ? z - cz : x - cx
    const q = (c - cHigh) * dirSign
    let s = 1 - q / (runNominal + overhang)
    for (let it = 0; it < 2; it++) s = 1 - q / spanAt(clamp01(tOf(a, clamp01(s))))
    s = clamp01(s)
    return yAt(clamp01(tOf(a, s)), s)
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
    P, nu, nv, heightAt, draw,
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

/** The rolled bolster along the top of a gable, following the ridge it actually
 *  has rather than the straight line it was planned as. It no longer hides a
 *  seam -- the two sheets share their ridge points exactly -- so it is pure
 *  silhouette, which is worth paying for on the topmost line of the building
 *  against the sky, and nothing at all below detail 2. */
function ridgeRoll(b, R) {
  const line = R.slopes[0].top
  const t = 0.14
  const path = (u) => {
    const p = polyAt(line, u)
    return [p[0], p[1] - t * 0.2, p[2]]
  }
  member2(b, path(0), path(1), {
    hu: t, hv: t * 0.85, seed: R.seed * 7 + 3, sides: 5, round: 0.85, jitter: 0.1,
    layer: R.layer, color: R.tint, uAlongAxis: false, path, segments: 2,
  })
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
    layer = LAYER.THATCH, tint = TINT.thatchNew, moss = 0.35, fringe = true,
    detail = 2, k = FLAT,
  } = o
  const kk = detail >= 2 ? k : FLAT
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
  const splayLo = vergeLo == null ? kk.vergeSplay : 0
  const splayHi = vergeHi == null ? kk.vergeSplay : 0

  const drop = (rise / Math.max(0.001, runHalf)) * oh
  const eave = eaveY - drop
  const grid = detail >= 2
    ? roofGrid(2 * alongHalf + vLo + vHi, Math.hypot(runHalf + oh, rise + drop))
    : { nu: 1, nv: 1 }
  const color = roofTint({ base: tint, eaveY: eave, ridgeY, moss })

  const slopes = [1, -1].map((sign) => slopeSurface({
    cx, cz, alongAxis: ridgeAxis, dirSign: sign, alongHalf,
    runNominal: runHalf, cHigh: 0, eaveY, highY: ridgeY, overhang: oh,
    vergeLo: vLo, vergeHi: vHi, splayLo, splayHi,
    ridgeSag: kk.ridgeSag, k: kk, layer, nu: grid.nu, nv: grid.nv,
    seed: seed * 3 + (sign > 0 ? 1 : 2),
  }))

  return {
    kind: 'gable', slopes, color, tint, layer, fringe, detail, seed, k: kk,
    ridgeY, eave, run: runHalf + oh, alongHalf: alongHalf + Math.max(vLo, vHi),
    heightAt: (x, z) =>
      slopes[(ridgeAxis === 'x' ? z - cz : x - cx) >= 0 ? 0 : 1].heightAt(x, z),
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
    layer = LAYER.THATCH, tint = TINT.thatchNew, detail = 2, k = FLAT,
  } = o
  const kk = detail >= 2 ? k : FLAT
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
  const color = roofTint({ base: tint, eaveY: eave, ridgeY: highY, moss: 0.3 })

  // ridgeSag is 0 and not a choice: a lean-to's top edge is buried in the wall
  // of the mass it leans against, and drooping it there opens a gap into it.
  const slope = slopeSurface({
    cx, cz, alongAxis, dirSign: sign, alongHalf,
    runNominal, cHigh: -sign * runHalf, eaveY: lowY, highY, overhang: oh,
    vergeLo: verge, vergeHi: verge, splayLo: kk.vergeSplay, splayHi: kk.vergeSplay,
    ridgeSag: 0, seed: seed * 3 + 1, k: kk, layer, nu: grid.nu, nv: grid.nv,
  })

  return {
    kind: 'lean', slopes: [slope], color, tint, layer, fringe: true, detail, seed, k: kk,
    eave, run: runNominal + oh, highY, runHalf, alongHalf, axis, sign, thick: 0,
    heightAt: (x, z) => slope.heightAt(x, z),
  }
}

/** Draw a planned roof. Sheets first, then the ridge roll, then the skirt. */
export function drawRoof(b, R) {
  for (const s of R.slopes) s.draw(b, R.color)
  if (R.kind === 'gable' && R.detail >= 2) ridgeRoll(b, R)
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

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

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
  tint = TINT.timber, topAt = null, topCols = 0, k = FLAT,
}) {
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len = Math.hypot(dx, dz)
  if (len < 0.01 || y1 <= y0) return
  const ux = dx / len
  const uz = dz / len
  const nx = -uz
  const nz = ux

  const A = (t, y) => [p0[0] + ux * len * t, y, p0[1] + uz * len * t]
  const cols = Math.max(
    detail >= 2 ? Math.max(1, Math.min(4, Math.round(len / 2.6))) : 1,
    topAt ? topCols : 0,
  )

  // How far under the covering the wall stops. It is not zero because heightAt()
  // is solved by two fixed-point sweeps rather than exactly (see slopeSurface),
  // and because the warp field is then applied to both and moves them by slightly
  // different amounts -- the roof's vertices and the wall's are at different
  // places, and the field is smooth but not constant. 4 cm is comfortably more
  // than either residual. It costs nothing to be generous here: the covering now
  // oversails on all four sides AND is double-sided, so even a wall that did poke
  // through would show wall against roof rather than a hole into the building.
  const TUCK = 0.04
  const TOP = []
  for (let i = 0; i <= cols; i++) {
    if (!topAt) { TOP.push(y1); continue }
    const q = A(i / cols, 0)
    TOP.push(Math.max(y0 + 0.05, topAt(q[0], q[2]) - TUCK))
  }
  const topMin = Math.min(...TOP)
  const level = (y) => new Array(cols + 1).fill(y)

  // Double-sided, and NOT because anyone is meant to see the inside face: a wall
  // is one surface because openings are never cut out of it, and the back face is
  // what closes it. A lone quad leaves four open edges; a back-to-back pair
  // leaves none, and that holds per column.
  const face = (lo, hi, layer, color) => {
    for (let i = 0; i < cols; i++) {
      b.quad(A(i / cols, lo[i]), A((i + 1) / cols, lo[i + 1]),
        A((i + 1) / cols, hi[i + 1]), A(i / cols, hi[i]), {
        layer, vWorldY: true, color, double: true, origin: A(0, y0),
      })
    }
  }

  const base = level(y0)
  // Kept below the lowest point of the top edge, so a wall that dies away to
  // nothing under a valley does not invert its own courses.
  const split = Math.max(y0 + 0.1, Math.min(sillY ?? y0 + (y1 - y0) * 0.38, topMin - 0.1))

  if (style === WALL_STYLE.STONE_BASE) {
    face(base, level(split), LAYER.STONE, groundGrime(y0, 1.0, 0.28))
    face(level(split), TOP, LAYER.TIMBER_PLANK, tint)
    if (detail >= 2) {
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
    return
  }

  if (style === WALL_STYLE.HALF_TIMBER) {
    face(base, TOP, LAYER.PLASTER, groundGrime(y0, topMin - y0, 0.34))
    if (detail < 2) return
    const t = 0.075 // how far the timber stands out
    const wd = 0.16 // member width
    const beam = { layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true }
    const rail = (ya, yb, kk) =>
      member(b, [p0[0], (ya + yb) / 2, p0[1]], [p1[0], (ya + yb) / 2, p1[1]],
        { hu: t, hv: (yb - ya) / 2, seed: rough * 17 + kk, round: 0.35, ...beam })
    rail(y0, y0 + wd, 1)
    // The wall plate follows the LOWEST point of the covering, not the tallest:
    // it is one straight timber and it has to stay under the roof for its whole
    // length, so on a gable end it sits at the eaves and the plaster carries on
    // up past it into the tympanum, which is what a real one does.
    rail(topMin - wd, topMin, 2)
    // `i < bays`, not `i <= bays`: a wall owns the post at its START corner and
    // leaves the one at its end to the wall that starts there.
    const bays = Math.max(1, Math.round(len / 1.5))
    for (let i = 0; i < bays; i++) {
      const s = i / bays
      const px = p0[0] + dx * s
      const pz = p0[1] + dz * s
      // The section frame for a vertical sweep is (+z, +x), so which half-extent
      // is which depends on the wall's direction.
      member(b, [px, y0 + wd, pz], [px, topMin - wd, pz], {
        hu: ux ? t : wd / 2, hv: ux ? wd / 2 : t,
        seed: rough * 17 + 10 + i, round: 0.35, ...beam,
      })
    }
    return
  }

  if (style === WALL_STYLE.STAVE) {
    face(base, TOP, LAYER.TIMBER_PLANK, tint)
    if (detail < 2) return
    // Corner posts, which is what a stave wall is actually framed by. Segmented,
    // so the field can bow them: these are the tallest single verticals on the
    // building and a dead-straight one beside a bellied wall is the thing that
    // gives the whole trick away. `bow` is passed explicitly -- member2 defaults
    // it to nothing, and these posts are exactly what the parameter was for.
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      member2(b, [px, y0, pz], [px, (t ? TOP[cols] : TOP[0]) + 0.04, pz], {
        hu: 0.115, seed: rough * 17 + 30 + t, round: 0.5, segments: 2,
        bow: k.bow,
        layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
      })
    }
    return
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
  if (detail < 2) return

  const course = TILE_METRES[LAYER.TIMBER_BEAM] / 2
  // 0.54 rather than 0.5 so consecutive logs OVERLAP by a couple of centimetres
  // instead of meeting on a tangent line that the warp field would then pull open.
  const r = course * 0.54
  // The log is swept along the wall line, so if it were centred there it would
  // stand r = 23 cm proud of the plane -- far enough out to swallow every window
  // in the wall, which sit at 1 to 4 cm. Set back so it protrudes 5 cm.
  const inset = r - 0.05
  const phase = seed & 1
  for (let kk = 0; ; kk++) {
    const y = y0 + course * (kk + 0.5)
    if (y + r > topMin) break
    // Alternate courses run long past the corners: that is the interlock, and it
    // is the reason the phase is taken from the seed rather than being fixed --
    // two walls meeting at a corner must not both stick out on the same course.
    const stick = (kk & 1) === phase ? 0.2 : 0.02
    member(b,
      [p0[0] - ux * stick - nx * inset, y, p0[1] - uz * stick - nz * inset],
      [p1[0] + ux * stick - nx * inset, y, p1[1] + uz * stick - nz * inset],
      {
        hu: r, sides: 5, seed: rough * 17 + 40 + kk, round: 0.95, jitter: 0.1,
        layer: LAYER.TIMBER_BEAM, color: tint, vWorldY: true,
      })
  }
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
 * member is swept along whatever curve that describes. The ridge roll uses it to
 * follow a ridge that now droops.
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
 * points outward only when S turns CLOCKWISE in (r, o). roughSection() winds
 * anticlockwise, hence the reverse().
 */
function frameRing2(b, { p, path, signs, width, back, front, seed = 0, sides = 5, layer, color }) {
  const oc = (back + front) / 2
  const sec = roughSection(sides, width / 2, (front - back) / 2, seed, {
    jitter: 0.15, round: 0.3,
  }).reverse()
  const P = path.map(([pa, pv], c) =>
    sec.map(([r, o]) => p(pa + signs[c][0] * r, pv + signs[c][1] * r, oc + o)))
  const o = { layer, color }
  for (let c = 0; c < 4; c++) {
    const cn = (c + 1) % 4
    for (let s = 0; s < sides; s++) {
      const sn = (s + 1) % sides
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
  { x, z, y0, nx, nz, width = 0.7, height = 0.85, shutters = false, seed = 0, detail = 2, k = FLAT }
) {
  const tx = -nz
  const tz = nx
  const hw = width / 2
  const depth = 0.14
  const frame = 0.07
  const p = (a, v, out) => [x + tx * a + nx * out, y0 + v, z + tz * a + nz * out]

  const sk = detail >= 2 ? k.skew : 0
  // 1.6 because the whole allowance now goes into one term instead of being spent
  // four ways, and a trapezoid needs a visible difference between its parallel
  // sides before it stops looking like a rectangle drawn slightly wrong.
  const taper = (hash(seed * 41 + 3, 1) - 0.5) * 2 * sk * 1.6
  const rot = detail >= 2 ? k.tilt * (hash(seed * 41 + 3, 2) - 0.5) * 2 : 0
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

  if (detail <= 0) {
    // LOD2 KEEPS ITS WINDOWS. At the range this tier is drawn at, a cottage is a
    // hundred pixels tall and the single thing that separates a building from a
    // crate is the pattern of openings on its face -- an unfenestrated box reads
    // as scenery. So this is the one ornament that survives all the way down.
    //
    // One doubled rect, four triangles, and it is GLASS across the whole opening
    // including where the frame would be: a dark border drawn half a pixel wide
    // does not read as a frame, it just reads as a smaller window. The shutters
    // are gone at this tier and so is every trace of the transform, which is
    // sub-pixel here.
    const q = [[-ow, -frame], [ow, -frame], [ow, height + frame], [-ow, height + frame]]
      .map(([a, v]) => p(a, v, 0.02))
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

  const sides = 4 + Math.floor(hash(seed, 21) * 2)
  frameRing2(b, {
    p,
    path: C.map(([pa, pv], i) => [pa + SIGNS[i][0] * (frame / 2), pv + SIGNS[i][1] * (frame / 2)]),
    signs: SIGNS,
    width: frame, back: 0, front: depth + 0.02,
    seed: seed * 31 + 7, sides,
    layer: LAYER.TIMBER_PLANK, color: TINT.timberDark,
  })

  if (shutters) {
    const sd = depth + 0.03
    for (const s of [-1, 1]) {
      // The hinged edge stays against the frame; the free edge stands off the
      // wall. A shutter flat on the wall is a painted rectangle -- the whole
      // reason a shutter reads as a shutter is that you can see behind it.
      const splay = k.splay * (0.6 + hash(seed * 61, s + 2))
      const aIn = s * ow
      const aOut = s * (ow + leafW)
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
        L(aIn, 0, sd), L(aOut, 0, sd + splay),
        L(aOut, height, sd + splay), L(aIn, height, sd),
      ]
      const lo = { layer: LAYER.TIMBER_PLANK, color: TINT.timberDark, double: true }
      const luv = fitUV(LAYER.TIMBER_PLANK, leafW, height)
      // Wound outboard-first for s = -1 so the front face points out of the wall
      // on both sides; the quad is doubled anyway, so this only decides which
      // side gets the lit normal.
      if (s < 0) b.quad(q[1], q[0], q[3], q[2], { ...lo, uvs: luv })
      else b.quad(q[0], q[1], q[2], q[3], { ...lo, uvs: luv })

      // The strap, laid on the splayed leaf rather than on the wall behind it.
      const mix = (t, v) => {
        const [wa, wv] = W(aIn + (aOut - aIn) * t, v)
        return p(wa, wv, sd + splay * t + 0.006)
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
 * collar. This is four sides, one solid, twelve triangles, and it goes the other
 * way: WIDER at the crown than at the base, with each of its four corners
 * jittered independently on both axes so no two faces are the same width and no
 * corner is square.
 *
 * Flaring outward is not masonry practice and is not meant to be. It is the one
 * shape a real chimney never has, which is exactly why it reads as somewhere
 * else -- and it is the tallest thing on the building, so it is the silhouette
 * the whole village is identified by from across the valley. The 36 triangles it
 * gives back are most of what pays for the roof grid.
 */
export function chimney2(b, { x, z, baseY, topY, w = 0.62, d = 0.62, seed = 0, detail = 2, k = FLAT }) {
  const grime = groundGrime(baseY, 1.4, 0.22)
  const foot = baseY - 0.35
  if (detail < 2) {
    b.box([x - w / 2, foot, z - d / 2], [x + w / 2, topY, z + d / 2],
      { layer: LAYER.STONE, color: grime })
    return
  }
  // For a VERTICAL sweep prism()'s section frame is (+z, +x), so the section's u
  // is the world z half-extent and its v is the world x one.
  const sec = boxSection(d / 2, w / 2, seed * 7 + 1, 0.24)
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
