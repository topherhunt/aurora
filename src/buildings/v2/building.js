import { LAYER } from '../../textures.js'
import {
  Builder, WALL_STYLE, TINT, member2, gableEnd, leanEnd,
  plinth, doorway, steps2, SMOOTH_LAYERS,
  wall2, planGableRoof, planLeanRoof, drawRoof, windowUnit2, chimney2, porch2,
} from './parts.js'
import { makeCharacter, makeWarp, warpBuilder, smoothNormals } from './warp.js'

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
//
// THE ONE ORDERING RULE ON TOP OF THAT: every roof is PLANNED before any wall is
// drawn, and drawn after. A roof is a sheet with no thickness now, so a wall can
// only stop cleanly under it by asking it where it is, and it cannot ask a roof
// that does not exist yet. This is also what retired gableEnd(): the triangle of
// wall above the eave is not a separate part any more, it is the top three
// columns of the gable-end wall, which removes a seam as well as a call.
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
export function buildBuilding2(plan, { detail = 2, strength = 1, character = null, smoothAngle = 78 } = {}) {
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
    // Normals were computed per face as each quad was emitted, off positions the
    // warp has since moved, so they have to be redone. smoothNormals() does that
    // AND does the other half of the job: it averages across the facets of the
    // round timbers, so a five-sided log lights as a cylinder rather than as a
    // pentagon, while leaving every masonry arris and every roof buckle seam as
    // sharp as it was drawn. See warp.js for the rule and why it is free.
    //
    // Unconditional, unlike the old computeVertexNormals() call: the smoothing is
    // wanted at strength 0 too, where it is the only thing between a log wall and
    // a stack of prisms.
    smoothNormals(b, { angle: smoothAngle, layers: SMOOTH_LAYERS })
    const geometry = b.toGeometry()
    return { geometry, triangles: b.triangles, plan, character: k }
  }

  /**
   * Every mass's roof, WORKED OUT BUT NOT DRAWN, by mass id.
   *
   * This exists because a roof is now a sheet: the walls take their top edge
   * from it, so it has to be a solved surface before the first wall is emitted,
   * and it has to be drawn after them anyway so its overhang covers the joint.
   */
  const planRoofs = (lod, overhang, verge, fringe = roofSpec.fringe) => {
    const R = new Map()
    for (const m of plan.masses) {
      const seed = plan.seed * 29 + m.id
      R.set(m.id, m.roof.kind === 'gable'
        ? planGableRoof({
          cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
          ridgeAxis: m.ridgeAxis, overhang, verge, ...wingVerge(m, main, verge),
          layer: roofSpec.layer, tint: roofSpec.tint, seed,
          moss: roofSpec.moss, fringe, detail: lod, k,
        })
        : planLeanRoof({
          cx: m.cx, cz: m.cz, w: m.w, d: m.d,
          highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
          overhang: overhang * 0.7, layer: roofSpec.layer, tint: roofSpec.tint,
          seed, detail: lod, k,
        }))
    }
    return R
  }

  if (detail <= 0) {
    // The far tier: one box per mass and a roof of four triangles over it. No
    // plinth, no timbers, nothing with a section. It still gets warped, because
    // the silhouette is all there is at this range and a straight LOD0 under a
    // leaning LOD1 pops on the swap.
    //
    // TWO DELIBERATE CHANGES TO WHAT THIS TIER SPENDS ITS TRIANGLES ON, and they
    // pay for each other. The overhang and the verge go to ZERO: an eave is one
    // dark pixel at this range, and with the roof landing exactly on the top of
    // the box the whole tier stops needing an eave to have any depth at all --
    // the roof plane and the top of the wall are the same line. What that buys is
    // the openings, four triangles each, which stay. That is the right way round:
    // a box with windows on it reads as a building at 80 m, and a box with a
    // crisp overhang and a blank face reads as a crate.
    const roofs = planRoofs(0, 0, 0, false)
    for (const m of plan.masses) {
      b.box(
        [m.cx - m.w / 2, plan.plinthBottom, m.cz - m.d / 2],
        [m.cx + m.w / 2, m.eaveY, m.cz + m.d / 2],
        { layer: LAYER.TIMBER_BEAM, color: TINT.timber }
      )
      drawRoof(b, roofs.get(m.id))
      // The one place gableEnd()/leanEnd() survive. Above detail 0 the wall
      // itself climbs to the apex, but this tier's mass is a box with a flat top,
      // so the triangle between it and the ridge is still a hole to be closed --
      // and a doubled triangle is two triangles, cheaper than any wall could be.
      if (m.roof.kind === 'gable') gableEnds(b, m, style, 0)
      else leanEnds(b, m, style)
    }
    doorway(b, { ...plan.door, seed: plan.seed * 53 + 3, detail: 0 })
    plan.windows.forEach((wn, i) =>
      windowUnit2(b, { ...wn, seed: plan.seed * 53 + 11 + i, detail: 0 }))
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
  const roofs = planRoofs(detail, plan.overhang ?? 0.4, 0.3)

  plan.walls.forEach((wl, i) => {
    if (wl.buried) return
    const m = plan.masses.find((mm) => mm.id === wl.massId)
    const R = roofs.get(m.id)
    // A wall that runs PERPENDICULAR to the ridge is a gable end, and that is the
    // whole test: its top climbs to the apex and back down, so it needs a column
    // boundary exactly at the ridge -- hence an even count -- and enough on
    // either side to follow the sag down to the eaves. Six at detail 2, which is
    // about what gableEnd()'s triangle plus its king post used to cost between
    // them, and now there is no seam across the middle of the gable either.
    const alongX = Math.abs(wl.p1[0] - wl.p0[0]) > Math.abs(wl.p1[1] - wl.p0[1])
    const isGableEnd = m.roof.kind === 'gable' && alongX !== (m.ridgeAxis === 'x')
    wall2(b, {
      p0: wl.p0, p1: wl.p1, y0: m.floorY, y1: m.eaveY,
      style, seed: wl.massId + (wl.side === 'front' || wl.side === 'back' ? 0 : 1),
      rough: plan.seed * 131 + i * 7 + 1,
      detail, k,
      topAt: R.heightAt,
      topCols: detail >= 2 ? (isGableEnd ? 6 : 4) : (isGableEnd ? 2 : 1),
    })
    if (isGableEnd && detail >= 2) {
      // The king post, which used to live inside gableEnd(). Every timber gable
      // has one and it is what stops the tympanum reading as a blank triangle.
      // It gets `bow` because it is the longest unbroken vertical on the
      // building, and it reaches the sagged apex rather than a nominal one.
      const mx = (wl.p0[0] + wl.p1[0]) / 2
      const mz = (wl.p0[1] + wl.p1[1]) / 2
      member2(b, [mx, m.floorY, mz], [mx, R.heightAt(mx, mz) - 0.16, mz], {
        hu: 0.095, seed: plan.seed * 131 + i * 7 + 2, round: 0.6,
        segments: 2, bow: k.bow,
        layer: LAYER.TIMBER_BEAM, color: TINT.timberDark, vWorldY: true,
      })
    }
  })

  // --- roofs ---------------------------------------------------------------
  //
  // After the walls, on purpose: the covering oversails the joint on all four
  // sides, so drawing it last is what hides the 4 cm the walls stop short by.
  for (const m of plan.masses) drawRoof(b, roofs.get(m.id))

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
