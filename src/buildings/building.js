import { LAYER } from '../textures.js'
import {
  Builder, WALL_STYLE, TINT,
  plinth, wall, gableEnd, leanEnd, gableRoof, leanToRoof,
  doorway, windowUnit, chimney, porch, steps,
} from './parts.js'

// ---------------------------------------------------------------------------
// plan -> geometry. DESIGN.md §19.
//
// This file is deliberately thin: plan.js decided everything, parts.js knows how
// to draw everything, and all that is left is the translation. Keeping it thin
// is what makes the previewer's "regenerate at detail 1" button honest -- the
// LOD tiers below are the SAME plan drawn with less of it, not a second,
// divergent model of the building.
//
// LOD BY RE-GENERATION, NOT BY DECIMATION. The collapse decimator we use on
// props will not collapse an edge that borders a hole, and a building is full
// of holes by construction (a window reveal is a ring, a porch roof is a
// floating plane). Props already stall at 896 -> 544 triangles for exactly this
// reason. So instead of one mesh decimated three ways, this is one plan built
// three ways:
//
//   detail 2  everything: log ends, frames, ironwork, fringe, corbelled cap
//   detail 1  massing, roof, flat door and window panels -- roughly a third
//   detail 0  a box and a roof prism, for the far tier before the card
// ---------------------------------------------------------------------------

const STYLE_OF = {
  log: WALL_STYLE.LOG,
  stave: WALL_STYLE.STAVE,
  halfTimber: WALL_STYLE.HALF_TIMBER,
  stoneBase: WALL_STYLE.STONE_BASE,
}

/** Roof kind -> the layer and tint that render it. `slate` is not a texture:
 *  it is SHINGLE at a cold tint, which is the whole argument in textures.js for
 *  why there is no slate layer. `pantile` IS one, for the argument made in the
 *  same place: a scallop is a shape, and no tint makes a rectangle round.
 *
 *  Pantile takes the least moss of the four. A fired clay tile sheds water and
 *  gives nothing to root in, which is most of the reason anyone who could
 *  afford them bought them. */
const ROOF_OF = {
  thatch: { layer: LAYER.THATCH, tint: TINT.thatchNew, fringe: true, moss: 0.4 },
  shake: { layer: LAYER.SHINGLE, tint: TINT.shake, fringe: false, moss: 0.22 },
  slate: { layer: LAYER.SHINGLE, tint: TINT.slate, fringe: false, moss: 0.12 },
  pantile: { layer: LAYER.ROOF_TILE, tint: TINT.pantile, fringe: false, moss: 0.08 },
}

/**
 * Build a planned building.
 *
 * Returns { geometry, triangles, plan }. The caller owns the geometry and must
 * dispose it; nothing here caches, because §6 says a village is generated once
 * and merged, so a cache would only ever hold garbage.
 */
export function buildBuilding(plan, { detail = 2 } = {}) {
  const b = new Builder()
  const style = STYLE_OF[plan.style]
  const roofSpec = ROOF_OF[plan.roofKind]
  const main = plan.masses[0]

  if (detail <= 0) {
    // The far tier: one box, one roof prism. No plinth, no openings, nothing
    // that survives being three pixels tall.
    for (const m of plan.masses) {
      b.box(
        [m.cx - m.w / 2, plan.plinthBottom, m.cz - m.d / 2],
        [m.cx + m.w / 2, m.eaveY, m.cz + m.d / 2],
        { layer: LAYER.TIMBER_BEAM, color: TINT.timber }
      )
      if (m.roof.kind === 'gable') {
        gableRoof(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
          ridgeAxis: m.ridgeAxis, overhang: 0.15, verge: 0.1,
          ...wingVerge(m, main, 0.1),
          layer: roofSpec.layer, tint: roofSpec.tint, fringe: false, detail: 0,
        })
        gableEnds(b, m, style, 0)
      } else {
        leanToRoof(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d,
          highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
          overhang: 0.12, layer: roofSpec.layer, tint: roofSpec.tint, detail: 0,
        })
        leanEnds(b, m, style)
      }
    }
    const geometry = b.toGeometry()
    return { geometry, triangles: b.triangles, plan }
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
    wall(b, {
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
      gableRoof(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
        ridgeAxis: m.ridgeAxis, overhang: plan.overhang ?? 0.4, verge: 0.3,
        ...wingVerge(m, main, 0.3),
        layer: roofSpec.layer, tint: roofSpec.tint, seed,
        moss: roofSpec.moss, fringe: roofSpec.fringe, detail,
      })
    } else {
      leanToRoof(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d,
        highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
        overhang: 0.28, layer: roofSpec.layer, tint: roofSpec.tint, seed, detail,
      })
      leanEnds(b, m, style)
    }
  }

  // --- openings ------------------------------------------------------------
  doorway(b, { ...plan.door, seed: plan.seed * 53 + 3, detail })
  plan.windows.forEach((wn, i) =>
    windowUnit(b, { ...wn, seed: plan.seed * 53 + 11 + i, detail }))

  // --- attachments ---------------------------------------------------------
  chimney(b, { ...plan.chimney, seed: plan.seed * 53 + 5, detail })
  // The porch keeps its roof at detail 1 (it changes the outline against the
  // sky) and loses its posts and rails, which do not.
  if (plan.porch) {
    porch(b, {
      ...plan.porch, groundY: plan.plinthBottom, seed: plan.seed * 53 + 7, detail,
    })
  }
  if (plan.steps) steps(b, { ...plan.steps, seed: plan.seed * 53 + 9, detail })

  const geometry = b.toGeometry()
  return { geometry, triangles: b.triangles, plan }
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
 * wall: the main roof only rises above the wing's ridge within
 * `(mainRidge - wingRidge)/rise * runHalf` of the main ridge line. Stop the wing
 * roof at its wall plus a normal verge and it ends in mid-air short of that,
 * leaving a notch at the junction that shows the far slope through it -- which
 * is what "roof faces don't extend far enough to fully join the T-shaped roof
 * peaks together" is. No amount of adding faces closes it; the two roofs simply
 * have to overlap, so this works out by how much and gableRoof() extends that
 * one end of the ridge.
 *
 * Returns {} unless the wing genuinely crosses the main mass: a wing whose ridge
 * is parallel to the main one is a range, and a wing displaced sideways rather
 * than along its own ridge (an L-plan) meets the main roof across its slope,
 * where the overhang already carries it inside.
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
