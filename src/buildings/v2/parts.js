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
 *  straight. `flare` is 1 rather than 0 because it is a ratio. */
const FLAT = {
  sag: 0, buckle: 0, reach: 0, sway: 0, flare: 1, skew: 0, splay: 0, bow: 0,
}

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

/** As v1: how thick a covering is, and how far its cut edge bulges. `rounds` is
 *  how many bands that cut edge is built from, and v2 spends the extra band
 *  only on thatch -- a half-metre of straw is the one edge whose silhouette is
 *  worth two rings now that the eave line itself is no longer straight. */
const ROOF_EDGE = {
  [LAYER.THATCH]: { thick: 0.46, bulge: 0.075, rounds: 2 },
  [LAYER.SHINGLE]: { thick: 0.14, bulge: 0.025, rounds: 1 },
  [LAYER.ROOF_TILE]: { thick: 0.15, bulge: 0.03, rounds: 1 },
}
const DEFAULT_EDGE = { thick: 0.12, bulge: 0.02, rounds: 1 }

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

/**
 * One roof plane, gridded, sagging, buckled, and with an eave that wanders.
 *
 * `corners` is the same contract v1's roofPlane has: the four corners of the
 * TOP surface as eave-left, eave-right, ridge-right, ridge-left, so U runs
 * along the eave and V up the slope. Everything below is expressed in that
 * frame and none of it needs to know which wall it is over.
 *
 * WHAT MOVES, and what deliberately does not:
 *
 *   the eave row   reaches OUT past its nominal overhang by a wandering amount,
 *                  continuing the pitch as it goes (so a longer overhang hangs
 *                  lower, as it must), and rises and falls along its length.
 *                  This is the one line of a roof the eye actually rules a
 *                  straightedge against, so it is where the money goes.
 *   interior rows  kink up and down by `buckle`, each seam with its own wander,
 *                  on top of a `sag` that bows the whole plane down between
 *                  eave and ridge.
 *   the ridge row  DOES NOT MOVE. Two slopes share the ridge line, they walk it
 *                  in opposite directions, and any wobble applied here would
 *                  have to agree between them to the last bit or the roof opens
 *                  along its spine. The warp field moves the ridge instead --
 *                  it is keyed on position, so both slopes get the same answer
 *                  for free. That is the whole reason the field exists.
 *
 * UVs ARE EXPLICIT AND COME FROM THE UNWARPED PARAMETERISATION -- (u * eave
 * length, v * slope length) / tile. Letting quad() derive a frame per cell
 * would give every cell a slightly different one once the cell is no longer
 * planar, and the tile would visibly step at each seam. Deriving them from the
 * straight plane keeps texel density exactly uniform no matter how far the
 * geometry has wandered off it, which is the same trick that lets the warp field
 * run at all.
 *
 * Returns the eave polyline (top and bottom edges, in u order) so the caller can
 * hang a thatch fringe off the eave it actually built rather than off the eave
 * it asked for.
 */
function roofPlane2(b, corners, t, o) {
  const { layer, color, seed = 0, k = FLAT } = o
  const [a, c1, c2, c3] = corners
  const edge = ROOF_EDGE[layer] ?? DEFAULT_EDGE
  const rounds = o.rounds ?? edge.rounds
  const bulge = o.bulge ?? edge.bulge
  const tile = TILE_METRES[layer] ?? 1

  const eaveLen = dist3(a, c1)
  const slopeLen = dist3(a, c3)
  const { nu, nv } = o.grid ?? roofGrid(eaveLen, slopeLen)

  // Out of the roof, in XZ: from the ridge line toward the eave line.
  const outDirXZ = flatDir(c3, a)
  const eaveDirXZ = flatDir(a, c1)
  // The pitch, so an eave that reaches further also hangs lower instead of
  // flying off level and revealing that the overhang is a separate idea from
  // the slope.
  const runXZ = Math.hypot(c3[0] - a[0], c3[2] - a[2]) || 1
  const pitch = (c3[1] - a[1]) / runXZ

  // How far the eave sticks out past nominal at parameter u. Biased positive:
  // `reach` is an extension, not a wobble about zero, because an eave that
  // sometimes retreats behind its own wall opens the wall head to the sky.
  const reachAt = (u) => k.reach * (0.55 + 0.45 * wobble(seed * 19 + 3, u))

  // The grid. rows j = 0 (eave) .. nv (ridge), cols i = 0 .. nu.
  const P = []
  const UV = []
  for (let j = 0; j <= nv; j++) {
    const v = j / nv
    const row = []
    const rowUV = []
    for (let i = 0; i <= nu; i++) {
      const u = i / nu
      const e = lerp3(a, c1, u)
      const r = lerp3(c3, c2, u)
      const p = lerp3(e, r, v)
      let dy = -k.sag * Math.sin(Math.PI * v)
      let vLen = v * slopeLen
      if (j === 0) {
        const s = reachAt(u)
        p[0] += outDirXZ[0] * s
        p[2] += outDirXZ[1] * s
        dy += -pitch * s + k.sway * wobble(seed * 17 + 5, u)
        vLen = -s
      } else if (j < nv) {
        dy += k.buckle * wobble(seed * 13 + j, u)
      }
      row.push([p[0], p[1] + dy, p[2]])
      rowUV.push([(u * eaveLen) / tile, vLen / tile])
    }
    P.push(row)
    UV.push(rowUV)
  }

  // Top surface.
  const top = { layer, color }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      b.quad(P[j][i], P[j][i + 1], P[j + 1][i + 1], P[j + 1][i], {
        ...top,
        uvs: [UV[j][i], UV[j][i + 1], UV[j + 1][i + 1], UV[j + 1][i]],
      })
    }
  }

  // The perimeter of that grid, anticlockwise seen from above -- the same
  // orientation the top quads are wound in, which is what makes the side bands
  // below face outward. Walked as: eave row left to right, right verge up, ridge
  // row right to left, left verge down.
  const ring = []
  const ringUV = []
  const ringOut = []
  const RIDGE_SHARE = 0.3
  const push = (i, j) => {
    ring.push(P[j][i])
    ringUV.push(UV[j][i])
    const sa = i === 0 ? -1 : i === nu ? 1 : 0
    const sc = j === 0 ? -1 : j === nv ? 1 : 0
    // The ridge end gets a fraction of the eave end's bulge: pushing it out by
    // the full amount drives each slope through the other above the ridge line,
    // where only the capping is there to hide it.
    const w = sc < 0 ? 1 : RIDGE_SHARE
    ringOut.push([
      eaveDirXZ[0] * sa + outDirXZ[0] * -sc * w,
      eaveDirXZ[1] * sa + outDirXZ[1] * -sc * w,
    ])
  }
  for (let i = 0; i <= nu; i++) push(i, 0)
  for (let j = 1; j <= nv; j++) push(nu, j)
  for (let i = nu - 1; i >= 0; i--) push(i, nv)
  for (let j = nv - 1; j >= 1; j--) push(0, j)
  const n = ring.length

  // The cut edge, in `rounds` bands. s = 0 at the top surface, 1 at the soffit;
  // the push is a half sine so both ends meet the faces they join cleanly.
  //
  // THICKNESS IS VERTICAL, not normal to the slope, exactly as in v1: a roof is
  // cut plumb at the eave, and the band you see along an overhanging edge is a
  // plumb cut through the covering.
  const bandRing = (s) => {
    const p = bulge * Math.sin(Math.PI * s)
    return ring.map((q, i) => [q[0] + ringOut[i][0] * p, q[1] - t * s, q[2] + ringOut[i][1] * p])
  }
  const side = { layer, color, vWorldY: true }
  let prev = ring
  let bottom = null
  for (let r = 1; r <= rounds; r++) {
    const cur = bandRing(r / rounds)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      b.quad(cur[i], cur[j], prev[j], prev[i], side)
    }
    prev = cur
    bottom = cur
  }

  // The soffit, as a fan over that bottom loop rather than a second grid.
  //
  // It is dark boarding under an overhang and the only part of it anyone sees is
  // the strip outside the wall, so it does not need the interior vertices the
  // top surface earns -- and a fan over a convex loop of 2(nu+nv) points costs
  // four triangles fewer than the grid would. Reverse-wound against the top.
  const soffit = { layer: LAYER.TIMBER_HEWN, color: TINT.timberDark }
  const sTile = TILE_METRES[LAYER.TIMBER_HEWN] ?? 1
  const suv = (i) => [(ringUV[i][0] * tile) / sTile, (ringUV[i][1] * tile) / sTile]
  for (let i = 1; i < n - 1; i++) {
    b.tri(bottom[0], bottom[i + 1], bottom[i], {
      ...soffit, uvs: [suv(0), suv(i + 1), suv(i)],
    })
  }

  return {
    eaveTop: P[0],
    eaveBottom: P[0].map((q) => [q[0], q[1] - t, q[2]]),
  }
}

/**
 * The frayed thatch eave, hung off an eave polyline rather than off a straight
 * line between two corners.
 *
 * v1 drew this as one quad from corner to corner, which was right when the eave
 * WAS a straight line between those corners. It is not any more -- it reaches
 * out by a wandering amount and rises and falls along its length -- so a
 * straight fringe would tear away from it in the middle of every span. It costs
 * one quad per grid column instead of one per eave, which on a two-column
 * cottage is four extra triangles for the single most recognisable line on a
 * thatched building.
 */
function thatchFringe(b, eave, tint, drop = 0.34) {
  const tile = TILE_METRES[LAYER.THATCH_FRINGE] ?? 1
  const n = eave.length
  if (n < 2) return
  // Arc length along the eave, so the fray does not stretch where a span is
  // longer.
  const s = [0]
  for (let i = 1; i < n; i++) s.push(s[i - 1] + dist3(eave[i - 1], eave[i]))
  // The tip hangs a little further out than the eave line it hangs from, which
  // is what stops it z-fighting the cut edge it is pinned to.
  const outXZ = []
  for (let i = 0; i < n; i++) {
    const p = eave[Math.max(0, i - 1)]
    const q = eave[Math.min(n - 1, i + 1)]
    const d = flatDir(p, q)
    outXZ.push([d[1], -d[0]])
  }
  for (let i = 0; i < n - 1; i++) {
    const j = i + 1
    const lo = (q, o) => [q[0] + o[0] * 0.02, q[1] - drop, q[2] + o[1] * 0.02]
    // v = 0 at the hanging tip, v = 1 at the eave line -- see tileFringe.
    // Doubled, because a fringe hangs clear of the roof and its back is in view
    // from anywhere below the eave line, which is most of a village street.
    b.quad(lo(eave[i], outXZ[i]), lo(eave[j], outXZ[j]), eave[j], eave[i], {
      layer: LAYER.THATCH_FRINGE,
      uvs: [[s[i] / tile, 0], [s[j] / tile, 0], [s[j] / tile, 1], [s[i] / tile, 1]],
      color: tint,
      double: true,
    })
  }
}

/**
 * A gable roof over an axis-aligned mass. Same contract as v1's gableRoof --
 * `ridgeAxis`, `verge`, `vergeLo`/`vergeHi` and the return value are unchanged,
 * because building.js's wingVerge() maths is about where two ROOFS meet and has
 * nothing to do with how crooked either of them is.
 */
export function gableRoof2(
  b,
  {
    cx, cz, w, d, eaveY, rise,
    ridgeAxis = 'x',
    seed = 0,
    overhang = 0.4,
    verge = 0.3,
    vergeLo = null,
    vergeHi = null,
    layer = LAYER.THATCH,
    tint = TINT.thatchNew,
    moss = 0.35,
    fringe = true,
    detail = 2,
    k = FLAT,
  }
) {
  const ridgeY = eaveY + rise
  const half = (ridgeAxis === 'x' ? w : d) / 2
  const aLo = -(half + (vergeLo ?? verge))
  const aHi = half + (vergeHi ?? verge)
  const alongHalf = Math.max(-aLo, aHi)
  const runHalf = (ridgeAxis === 'x' ? d : w) / 2
  const drop = (rise / Math.max(0.001, runHalf)) * overhang
  const eave = eaveY - drop
  const run = runHalf + overhang

  const color = roofTint({ base: tint, eaveY: eave, ridgeY, moss })
  const edge = ROOF_EDGE[layer] ?? DEFAULT_EDGE
  const thick = edge.thick
  // At detail 1 and below the grid collapses to a single span, the cut edge to a
  // single plumb band, and every wander with them -- 12 triangles a plane
  // against detail 2's 40 to 64. That is not a compromise: the reason to bend a
  // roof is the seam and the silhouette, and at the range LOD1 is drawn at
  // neither survives the rasteriser, while the triangle count survives just
  // fine.
  const grid = detail >= 2 ? null : { nu: 1, nv: 1 }
  const kk = detail >= 2 ? k : FLAT
  const bulge = detail >= 2 ? edge.bulge : 0
  const rounds = detail >= 2 ? edge.rounds : 1

  const slope = (sign, sk) => {
    const P = (alongT, up) => {
      const av = aLo + (aHi - aLo) * alongT
      const acr = sign * (up ? 0 : run)
      const y = up ? ridgeY : eave
      return ridgeAxis === 'x' ? [cx + av, y, cz + acr] : [cx + acr, y, cz + av]
    }
    // The handedness of (along, across) flips with the ridge axis and the
    // winding has to flip back, or both slopes of every z-ridged roof point
    // downwards and inwards -- invisible to the edge-pairing gate, which is why
    // signedVolume() sits beside it.
    return roofPlane2(b, (ridgeAxis === 'x') === (sign > 0)
      ? [P(0, false), P(1, false), P(1, true), P(0, true)]
      : [P(1, false), P(0, false), P(0, true), P(1, true)],
    thick, { layer, color, seed: sk, k: kk, grid, bulge, rounds })
  }
  const lo = slope(1, seed * 3 + 1)
  const hi = slope(-1, seed * 3 + 2)

  if (detail >= 2) {
    // The ridge capping: a rolled bolster along the top, hiding the seam where
    // the two slopes meet. Round rather than square for the same reason the eave
    // is -- it is the topmost line of the building against the sky.
    const t = 0.14
    const y = ridgeY - t * 0.2
    const p0 = ridgeAxis === 'x' ? [cx + aLo, y, cz] : [cx, y, cz + aLo]
    const p1 = ridgeAxis === 'x' ? [cx + aHi, y, cz] : [cx, y, cz + aHi]
    member(b, p0, p1, {
      hu: t, hv: t * 0.85, seed: seed * 7 + 3, sides: 6, round: 0.85, jitter: 0.1,
      layer, color: tint, uAlongAxis: false,
    })
  }

  // Kept at detail 1, unlike every other ornament, precisely BECAUSE it is
  // silhouette: dropping it at the LOD0 boundary would pop the outline of the
  // roof at 60 m.
  if (fringe && detail >= 1 && layer === LAYER.THATCH) {
    thatchFringe(b, lo.eaveBottom, tint)
    thatchFringe(b, hi.eaveBottom, tint)
  }

  return { ridgeY, eave, alongHalf, run }
}

/**
 * A single-pitch roof: the lean-to on a side outshut, the catslide where a
 * smaller mass abuts a larger one, and the porch canopy.
 *
 * `dir` is the outward direction the slope falls toward: '+x','-x','+z','-z'.
 */
export function leanToRoof2(
  b,
  {
    cx, cz, w, d, highY, lowY, dir = '+z', seed = 0, overhang = 0.3,
    layer = LAYER.THATCH, tint = TINT.thatchNew, detail = 2, k = FLAT,
  }
) {
  const axis = dir[1]
  const sign = dir[0] === '+' ? 1 : -1
  const runHalf = (axis === 'x' ? w : d) / 2
  const alongHalf = (axis === 'x' ? d : w) / 2 + 0.25
  const drop = ((highY - lowY) / Math.max(0.001, 2 * runHalf)) * overhang
  const eave = lowY - drop
  const run = runHalf + overhang

  const P = (alongT, down) => {
    const av = -alongHalf + 2 * alongHalf * alongT
    const acr = sign * (down ? run : -runHalf)
    const y = down ? eave : highY
    return axis === 'x' ? [cx + acr, y, cz + av] : [cx + av, y, cz + acr]
  }
  const color = roofTint({ base: tint, eaveY: eave, ridgeY: highY, moss: 0.3 })
  const edge = ROOF_EDGE[layer] ?? DEFAULT_EDGE
  const thick = edge.thick
  const grid = detail >= 2 ? null : { nu: 1, nv: 1 }
  const kk = detail >= 2 ? k : FLAT
  const bulge = detail >= 2 ? edge.bulge : 0
  const rounds = detail >= 2 ? edge.rounds : 1
  // Eave corners first so V runs up the slope, as on a gable.
  const flip = (axis === 'x') === (sign > 0)
  const plane = roofPlane2(b, flip
    ? [P(1, true), P(0, true), P(0, false), P(1, false)]
    : [P(0, true), P(1, true), P(1, false), P(0, false)],
  thick, { layer, color, seed: seed * 3 + 1, k: kk, grid, bulge, rounds })

  if (detail >= 1 && layer === LAYER.THATCH) thatchFringe(b, plane.eaveBottom, tint, 0.3)
  return { eave, run, highY, runHalf, alongHalf, axis, sign, thick }
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/**
 * A wall, split along its length so the warp field has something to belly out.
 *
 * The only structural change from v1 is `face()`: one quad became `cols` of
 * them. A wall drawn as a single quad is the clearest case of the limit stated
 * at the top of warp.js -- the field moves its four corners and cannot touch
 * what is between them, so a ten-metre inn front stays a perfect plane no matter
 * how crooked everything standing on it has become. One seam every ~2.6 m is
 * enough for it to read as settled, and the wall face is the cheapest surface in
 * the kit to subdivide: it is doubled, so a column costs four triangles.
 *
 * Everything else -- the four styles, the log-end phasing, the half-timber bay
 * rule, the stone course -- is v1's, and deliberately unchanged.
 */
export function wall2(b, { p0, p1, y0, y1, style, seed = 0, rough = 0, sillY, detail = 2, tint = TINT.timber }) {
  const dx = p1[0] - p0[0]
  const dz = p1[1] - p0[1]
  const len = Math.hypot(dx, dz)
  if (len < 0.01 || y1 <= y0) return
  const ux = dx / len
  const uz = dz / len
  const nx = -uz
  const nz = ux

  const A = (t, y) => [p0[0] + ux * len * t, y, p0[1] + uz * len * t]
  const cols = detail >= 2 ? Math.max(1, Math.min(4, Math.round(len / 2.6))) : 1
  // Double-sided, and NOT because anyone is meant to see the inside face: a wall
  // is one surface because openings are never cut out of it, and the back face is
  // what closes it. A lone quad leaves four open edges; a back-to-back pair
  // leaves none, and that holds per column.
  const face = (ya, yb, layer, color) => {
    for (let i = 0; i < cols; i++) {
      const t0 = i / cols
      const t1 = (i + 1) / cols
      b.quad(A(t0, ya), A(t1, ya), A(t1, yb), A(t0, yb), {
        layer, vWorldY: true, color, double: true, origin: A(0, ya),
      })
    }
  }

  const split = sillY ?? y0 + (y1 - y0) * 0.38

  if (style === WALL_STYLE.STONE_BASE) {
    face(y0, split, LAYER.STONE, groundGrime(y0, 1.0, 0.28))
    face(split, y1, LAYER.TIMBER_PLANK, tint)
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
    face(y0, y1, LAYER.PLASTER, groundGrime(y0, y1 - y0, 0.34))
    if (detail < 2) return
    const t = 0.075 // how far the timber stands out
    const wd = 0.16 // member width
    const beam = { layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true }
    const rail = (ya, yb, kk) =>
      member(b, [p0[0], (ya + yb) / 2, p0[1]], [p1[0], (ya + yb) / 2, p1[1]],
        { hu: t, hv: (yb - ya) / 2, seed: rough * 17 + kk, round: 0.35, ...beam })
    rail(y0, y0 + wd, 1)
    rail(y1 - wd, y1, 2)
    // `i < bays`, not `i <= bays`: a wall owns the post at its START corner and
    // leaves the one at its end to the wall that starts there.
    const bays = Math.max(1, Math.round(len / 1.5))
    for (let i = 0; i < bays; i++) {
      const s = i / bays
      const px = p0[0] + dx * s
      const pz = p0[1] + dz * s
      // The section frame for a vertical sweep is (+z, +x), so which half-extent
      // is which depends on the wall's direction.
      member(b, [px, y0 + wd, pz], [px, y1 - wd, pz], {
        hu: ux ? t : wd / 2, hv: ux ? wd / 2 : t,
        seed: rough * 17 + 10 + i, round: 0.35, ...beam,
      })
    }
    return
  }

  if (style === WALL_STYLE.STAVE) {
    face(y0, y1, LAYER.TIMBER_PLANK, tint)
    if (detail < 2) return
    // Corner posts, which is what a stave wall is actually framed by. Segmented,
    // so the field can bow them: these are the tallest single verticals on the
    // building and a dead-straight one beside a bellied wall is the thing that
    // gives the whole trick away.
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      member2(b, [px, y0, pz], [px, y1 + 0.04, pz], {
        hu: 0.115, seed: rough * 17 + 30 + t, round: 0.5, segments: 2,
        layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
      })
    }
    return
  }

  // WALL_STYLE.LOG
  face(y0, y1, LAYER.TIMBER_BEAM, tint)
  if (detail < 2) return

  // Notched log ends poking past the corner -- the silhouette of a log cabin,
  // which the flat texture alone reads as painted-on stripes without. Only every
  // other course sticks out on a given wall, because the courses interlock.
  const course = TILE_METRES[LAYER.TIMBER_BEAM] / 2
  const r = course * 0.46
  const stick = 0.22
  const phase = seed & 1
  for (let kk = 0; ; kk++) {
    const y = y0 + course * (kk + 0.5)
    if (y + r > y1) break
    if ((kk & 1) !== phase) continue
    for (const t of [0, 1]) {
      const px = p0[0] + dx * t
      const pz = p0[1] + dz * t
      const out = t === 0 ? -1 : 1
      member(b,
        [px - ux * out * 0.02, y, pz - uz * out * 0.02],
        [px + ux * out * stick, y, pz + uz * out * stick],
        { hu: r, seed: rough * 17 + 40 + kk * 2 + t, round: 0.95, jitter: 0.14, color: tint }
      )
    }
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
 */
export function member2(b, a, bEnd, o) {
  const seed = o.seed ?? 0
  const segments = Math.max(1, o.segments ?? 1)
  if (segments === 1 && !(o.bow > 0)) return member(b, a, bEnd, o)

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

  const at = (t) => {
    // sin, so both ends stay exactly where the caller put them -- a member whose
    // ends have drifted is a member that has come out of its mortice.
    const s = bow * Math.sin(Math.PI * t)
    return [
      a[0] + ax[0] * t + (e1[0] * bx + e2[0] * bz) * s,
      a[1] + ax[1] * t + (e1[1] * bx + e2[1] * bz) * s,
      a[2] + ax[2] * t + (e1[2] * bx + e2[2] * bz) * s,
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
 * A window that was never a rectangle.
 *
 * The four corners of the opening are skewed independently, the surround is
 * mitred around whatever quadrilateral that produced, and the shutters swing off
 * the wall instead of lying flat on it. A window is the one part of a building
 * seen head-on from two metres away, so it is where a right angle costs the most
 * -- and where breaking one costs nothing, because the surround was already a
 * swept ring and a ring does not care what path it follows.
 *
 * The ring is drawn with FOUR OR FIVE sides in v2 where v1 used five or six.
 * That is a deliberate trade and it pays for the roof: an inn carries fifteen
 * windows, the ring costs 8 triangles a side, and the corners the sixth side was
 * rounding off are now corners that are not square to begin with.
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

  // The opening, corner by corner: bottom-left, bottom-right, top-right,
  // top-left. Each one strays by up to `skew` of the opening's own size, on both
  // axes, so no two edges are parallel and no corner is square.
  const SIGNS = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  const sk = detail >= 2 ? k.skew : 0
  const C = SIGNS.map(([sa, sv], i) => [
    sa * hw + (hash(seed * 41 + 3, i * 2) - 0.5) * 2 * sk * width,
    (sv > 0 ? height : 0) + (hash(seed * 41 + 3, i * 2 + 1) - 0.5) * 2 * sk * height,
  ])

  const ow = hw + frame
  const leafW = width * 0.52

  if (detail < 2) {
    // LOD1: three flat rects and nothing else. The frame is a panel behind the
    // glass rather than a ring around it, which is a triangle cheaper than a
    // ring of four quads and reads identically once the reveal is a pixel deep;
    // the glass sits on top of it; each shutter is one more panel lying flat on
    // the wall. Sixteen triangles for what detail 2 spends about sixty on, and
    // the silhouette -- a lit pane inside a dark border with a leaf to each side
    // -- is unchanged, which is the only thing left to get right at this range.
    const rect = (a0, a1, v0, v1, out, layer, color) => b.quad(
      p(a0, v0, out), p(a1, v0, out), p(a1, v1, out), p(a0, v1, out),
      { layer, vWorldY: true, color, double: true })
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
  // with something in it.
  const glassAt = depth * 0.33
  b.quad(
    p(C[0][0], C[0][1], glassAt), p(C[1][0], C[1][1], glassAt),
    p(C[2][0], C[2][1], glassAt), p(C[3][0], C[3][1], glassAt),
    { layer: LAYER.GLASS, vWorldY: true, color: TINT.glass, double: true }
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
      // The leaf's own corners wander too, on the same terms as the opening's.
      const vy = (i) => (hash(seed * 71 + s, i) - 0.5) * 2 * sk * height
      const b0 = vy(1)
      const b1 = vy(2)
      const t0 = height + vy(3)
      const t1 = height + vy(4)
      const q = [
        p(aIn, b0, sd), p(aOut, b1, sd + splay),
        p(aOut, t1, sd + splay), p(aIn, t0, sd),
      ]
      // Wound outboard-first for s = -1 so the front face points out of the wall
      // on both sides; the quad is doubled anyway, so this only decides which
      // side gets the lit normal.
      if (s < 0) b.quad(q[1], q[0], q[3], q[2], { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark, double: true })
      else b.quad(q[0], q[1], q[2], q[3], { layer: LAYER.TIMBER_PLANK, vWorldY: true, color: TINT.timberDark, double: true })

      // The strap, laid on the splayed leaf rather than on the wall behind it.
      const mix = (t, v) => p(aIn + (aOut - aIn) * t, v, sd + splay * t + 0.006)
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
