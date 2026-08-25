import { LAYER } from '../../textures.js'
import {
  Builder, WALL_STYLE, TINT,
  plinth, gableEnd, leanEnd, doorway, steps2,
  wall2, gableRoof2, leanToRoof2, windowUnit2, chimney2, porch2,
} from './parts.js'
import { makeCharacter, makeWarp, warpBuilder } from './warp.js'

// ---------------------------------------------------------------------------
// plan -> geometry, v2. DESIGN.md §19.
//
// The plan is v1's, unchanged and shared: plan.js is pure data with no opinion
// about how straight anything is, so a building that leans is the same building
// planned. That is the whole reason v2 is a second geometry layer and not a
// second generator -- the shapes, the styles, the window bays, the wing rules
// and the terrain response are already right, and nothing in this file is
// allowed to relitigate them.
//
// WHAT IS NEW HERE IS THE LAST THREE LINES: draw the building straight, then run
// the whole vertex array through the warp field, then recompute normals. Every
// part in v2/parts.js is written to be *drawable* straight and to carry enough
// interior vertices that the field has something to bend. The field is what
// makes them agree: two parts that met before the warp still meet after it,
// because a warp keyed on position gives coincident vertices the same answer.
//
// So the order matters and it is the opposite of the obvious one. The temptation
// is to jitter each part as it is drawn -- and that is what opens seams, because
// every junction then has to be threaded with the same jitter by hand and one of
// them is always missed. Draw straight, warp once.
// ---------------------------------------------------------------------------

const STYLE_OF = {
  log: WALL_STYLE.LOG,
  stave: WALL_STYLE.STAVE,
  halfTimber: WALL_STYLE.HALF_TIMBER,
  stoneBase: WALL_STYLE.STONE_BASE,
}

/** Roof kind -> the layer and tint that render it, as v1. `slate` is SHINGLE at
 *  a cold tint; `pantile` is its own layer because a scallop is a shape and no
 *  tint makes a rectangle round. Pantile takes the least moss of the four --
 *  fired clay sheds water and gives nothing to root in. */
const ROOF_OF = {
  thatch: { layer: LAYER.THATCH, tint: TINT.thatchNew, fringe: true, moss: 0.4 },
  shake: { layer: LAYER.SHINGLE, tint: TINT.shake, fringe: false, moss: 0.22 },
  slate: { layer: LAYER.SHINGLE, tint: TINT.slate, fringe: false, moss: 0.12 },
  pantile: { layer: LAYER.ROOF_TILE, tint: TINT.pantile, fringe: false, moss: 0.08 },
}

/**
 * Build a planned building, crooked.
 *
 * `strength` scales the whole personality: 0 builds the straight thing, 1 is the
 * shipping default, and the previewer's slider runs past it so a value can be
 * chosen by looking rather than by arguing.
 *
 * Returns { geometry, triangles, plan, character }.
 */
export function buildBuilding2(plan, { detail = 2, strength = 1, character = null } = {}) {
  const b = new Builder()
  const style = STYLE_OF[plan.style]
  const roofSpec = ROOF_OF[plan.roofKind]
  const main = plan.masses[0]
  // `character` exists for the previewer, which drives the individual terms --
  // lean, sag, reach, flare -- on their own sliders so a bad-looking building can
  // be traced to the term responsible. The game never passes it: a building's
  // personality is a function of its seed, and a caller that could override that
  // per building is a caller that can make two copies of the same seed differ.
  const k = character ?? makeCharacter(plan.seed, strength)

  const finish = () => {
    // The lean is measured from the bottom of the plinth, so a building on a
    // deep footing leans from its footing rather than from the world origin --
    // otherwise a mass sitting 0.8 m down the hill starts its lean 0.8 m into
    // the ground and arrives at the eave with a different amount of it.
    warpBuilder(b, makeWarp(k, plan.plinthBottom))
    const geometry = b.toGeometry()
    // Normals were computed per face as each quad was emitted, off positions
    // that have since moved. Recomputing is exactly right rather than merely
    // adequate: Builder.vertex() never dedupes across quads, so this averages
    // only the two triangles of each quad -- correct, because a warped quad is
    // genuinely non-planar -- and leaves every quad-to-quad crease as sharp as
    // it was drawn.
    if (k.strength > 0) geometry.computeVertexNormals()
    return { geometry, triangles: b.triangles, plan, character: k }
  }

  if (detail <= 0) {
    // The far tier: one box, one roof prism. No plinth, no openings, nothing
    // that survives being three pixels tall. It still gets warped, because the
    // silhouette is all there is at this range and a straight LOD0 under a
    // leaning LOD1 pops on the swap.
    for (const m of plan.masses) {
      b.box(
        [m.cx - m.w / 2, plan.plinthBottom, m.cz - m.d / 2],
        [m.cx + m.w / 2, m.eaveY, m.cz + m.d / 2],
        { layer: LAYER.TIMBER_BEAM, color: TINT.timber }
      )
      if (m.roof.kind === 'gable') {
        gableRoof2(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
          ridgeAxis: m.ridgeAxis, overhang: 0.15, verge: 0.1,
          ...wingVerge(m, main, 0.1),
          layer: roofSpec.layer, tint: roofSpec.tint, fringe: false, detail: 0,
        })
        gableEnds(b, m, style, 0)
      } else {
        leanToRoof2(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d,
          highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
          overhang: 0.12, layer: roofSpec.layer, tint: roofSpec.tint, detail: 0,
        })
        leanEnds(b, m, style)
      }
    }
    return finish()
  }

  // --- plinth --------------------------------------------------------------
  //
  // The `m.id` nudge is not cosmetic. Masses interpenetrate by construction (an
  // ell butts its wing INTO the main range), so on a flat site two plinths get
  // top ledges at exactly the same height over the strip where they overlap --
  // coincident coplanar faces, which z-fight and crawl as the head moves. 3 mm
  // is invisible in a rubble plinth and decides the depth test once and for all.
  // Upward, never downward: down would open a hairline between the ledge and the
  // wall standing on it.
  //
  // `bevel: 0` at detail 1 is what collapses roughSlab() back to a box -- the
  // LOD1 contract in parts.js, applied at the one part that reads the strongest.
  for (const m of plan.masses) {
    plinth(b, {
      cx: m.cx, cz: m.cz, w: m.w + 0.16, d: m.d + 0.16,
      top: m.floorY + m.id * 0.003, bottom: plan.plinthBottom - m.id * 0.004,
      batter: detail >= 2 ? 0.06 : 0,
      bevel: detail >= 2 ? 0.05 : 0,
      seed: plan.seed * 97 + m.id,
    })
  }

  // --- walls ---------------------------------------------------------------
  //
  // `seed` picks the log-course phase and must AGREE between the two walls that
  // meet at a corner, or their log ends collide; `rough` drives the hewn jitter
  // and must DIFFER everywhere, or every timber on the building is the same
  // timber. Hence two numbers rather than one.
  plan.walls.forEach((wl, i) => {
    if (wl.buried) return
    const m = plan.masses.find((mm) => mm.id === wl.massId)
    wall2(b, {
      p0: wl.p0, p1: wl.p1, y0: m.floorY, y1: m.eaveY,
      style, seed: wl.massId + (wl.side === 'front' || wl.side === 'back' ? 0 : 1),
      rough: plan.seed * 131 + i * 7 + 1,
      detail,
    })
  })

  // --- gables and roofs ----------------------------------------------------
  for (const m of plan.masses) {
    const seed = plan.seed * 29 + m.id
    if (m.roof.kind === 'gable') {
      gableEnds(b, m, style, detail, seed)
      gableRoof2(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
        ridgeAxis: m.ridgeAxis, overhang: plan.overhang ?? 0.4, verge: 0.3,
        ...wingVerge(m, main, 0.3),
        layer: roofSpec.layer, tint: roofSpec.tint, seed,
        moss: roofSpec.moss, fringe: roofSpec.fringe, detail, k,
      })
    } else {
      leanToRoof2(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d,
        highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
        overhang: 0.28, layer: roofSpec.layer, tint: roofSpec.tint, seed, detail, k,
      })
      leanEnds(b, m, style)
    }
  }

  // --- openings ------------------------------------------------------------
  doorway(b, { ...plan.door, seed: plan.seed * 53 + 3, detail })
  plan.windows.forEach((wn, i) =>
    windowUnit2(b, { ...wn, seed: plan.seed * 53 + 11 + i, detail, k }))

  // --- attachments ---------------------------------------------------------
  chimney2(b, { ...plan.chimney, seed: plan.seed * 53 + 5, detail, k })
  // The porch keeps its roof at detail 1 (it changes the outline against the
  // sky) and loses its posts and rails, which do not.
  if (plan.porch) {
    porch2(b, {
      ...plan.porch, groundY: plan.plinthBottom, seed: plan.seed * 53 + 7, detail, k,
    })
  }
  if (plan.steps) steps2(b, { ...plan.steps, seed: plan.seed * 53 + 9, detail })

  return finish()
}

/** The two triangles of wall above the eave, at whichever pair of walls the
 *  ridge runs into. */
function gableEnds(b, m, style, detail, seed = 0) {
  const hw = m.w / 2
  const hd = m.d / 2
  const apex = m.eaveY + m.roof.rise
  // Wound the same way rectWalls() winds, so the normals face out.
  const ends = m.ridgeAxis === 'x'
    ? [
        { p0: [m.cx + hw, m.cz + hd], p1: [m.cx + hw, m.cz - hd] }, // +X
        { p0: [m.cx - hw, m.cz - hd], p1: [m.cx - hw, m.cz + hd] }, // -X
      ]
    : [
        { p0: [m.cx - hw, m.cz + hd], p1: [m.cx + hw, m.cz + hd] }, // +Z
        { p0: [m.cx + hw, m.cz - hd], p1: [m.cx - hw, m.cz - hd] }, // -Z
      ]
  ends.forEach((e, i) => {
    gableEnd(b, { p0: e.p0, p1: e.p1, y0: m.eaveY, apexY: apex, style, seed: seed * 3 + i, detail })
  })
}

/** The two triangles of wall between a lean-to's own eave and the slope that
 *  climbs away above it. Without these an outshut is open to the sky at both
 *  ends -- see leanEnd() in parts.js. */
function leanEnds(b, m, style) {
  const axis = m.roof.dir[1]
  const sign = m.roof.dir[0] === '+' ? 1 : -1
  const runHalf = (axis === 'x' ? m.w : m.d) / 2
  const alongHalf = (axis === 'x' ? m.d : m.w) / 2
  for (const s of [-1, 1]) {
    const a = s * alongHalf
    // Low end first: leanEnd() raises the second corner to the high side.
    const p0 = axis === 'z' ? [m.cx + a, m.cz + sign * runHalf] : [m.cx + sign * runHalf, m.cz + a]
    const p1 = axis === 'z' ? [m.cx + a, m.cz - sign * runHalf] : [m.cx - sign * runHalf, m.cz + a]
    leanEnd(b, { p0, p1, y0: m.eaveY, y1: m.roof.highY, style })
  }
}

/**
 * How far a cross-wing's roof has to oversail its own gable wall to actually
 * REACH the roof it abuts.
 *
 * On a T-plan the wing's ridge runs into the main roof's slope, and the point
 * where it disappears under it is a long way inboard of the wing's own gable
 * wall. Stop the wing roof at its wall plus a normal verge and it ends in
 * mid-air short of that, leaving a notch at the junction that shows the far
 * slope through it. No amount of adding faces closes it; the two roofs simply
 * have to overlap, so this works out by how much and gableRoof2() extends that
 * one end of the ridge.
 *
 * Unchanged from v1, and it has to be: this is about where two ROOFS meet, which
 * the warp field then moves as one. Adding slack for the wander would be wrong
 * twice over -- the field displaces both roofs identically at the junction, and
 * the eave reach only ever grows an overhang.
 */
function wingVerge(m, main, verge) {
  if (m === main || m.roof.kind !== 'gable' || main.roof.kind !== 'gable') return {}
  if (m.ridgeAxis === main.ridgeAxis) return {}
  const axis = m.ridgeAxis
  const c = axis === 'x' ? m.cx : m.cz
  const mc = axis === 'x' ? main.cx : main.cz
  const half = (axis === 'x' ? m.w : m.d) / 2
  const mainHalf = (axis === 'x' ? main.w : main.d) / 2
  const gap = mc - c
  if (Math.abs(gap) <= mainHalf) return {} // sideways, not end-on
  const toward = Math.sign(gap)

  // The main mass's across-the-ridge axis IS the wing's ridge axis, so its
  // runHalf and rise are measured in the direction we are extending.
  const R = main.roof
  const limit = Math.max(0, ((R.ridgeY - m.roof.ridgeY) / R.rise) * R.runHalf)
  // Reach 0.4 m past the first point where the main roof is overhead, and never
  // past the main ridge itself.
  const reach = mc - toward * Math.max(0, limit - 0.4)
  const v = Math.max(verge, toward * (reach - c) - half)
  return toward > 0 ? { vergeHi: v } : { vergeLo: v }
}
