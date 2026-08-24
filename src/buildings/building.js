import { LAYER } from '../textures.js'
import {
  Builder, WALL_STYLE, TINT,
  plinth, wall, gableEnd, gableRoof, leanToRoof,
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
 *  why there is no slate layer. */
const ROOF_OF = {
  thatch: { layer: LAYER.THATCH, tint: TINT.thatchNew, fringe: true, moss: 0.4 },
  shake: { layer: LAYER.SHINGLE, tint: TINT.shake, fringe: false, moss: 0.22 },
  slate: { layer: LAYER.SHINGLE, tint: TINT.slate, fringe: false, moss: 0.12 },
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
        { layer: LAYER.TIMBER_HEWN, color: TINT.timber, skip: ['-y'] }
      )
      if (m.roof.kind === 'gable') {
        gableRoof(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
          ridgeAxis: m.ridgeAxis, overhang: 0.15, verge: 0.1,
          layer: roofSpec.layer, tint: roofSpec.tint, fringe: false, detail: 0,
        })
        gableEnds(b, m, style, 0)
      } else {
        leanToRoof(b, {
          cx: m.cx, cz: m.cz, w: m.w, d: m.d,
          highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
          overhang: 0.12, layer: roofSpec.layer, tint: roofSpec.tint, detail: 0,
        })
      }
    }
    const geometry = b.toGeometry()
    return { geometry, triangles: b.triangles, plan }
  }

  // --- plinth --------------------------------------------------------------
  for (const m of plan.masses) {
    plinth(b, {
      cx: m.cx, cz: m.cz, w: m.w + 0.16, d: m.d + 0.16,
      top: m.floorY, bottom: plan.plinthBottom,
      batter: detail >= 2 ? 0.06 : 0,
    })
  }

  // --- walls ---------------------------------------------------------------
  for (const wl of plan.walls) {
    if (wl.buried) continue
    const m = plan.masses.find((mm) => mm.id === wl.massId)
    wall(b, {
      p0: wl.p0, p1: wl.p1, y0: m.floorY, y1: m.eaveY,
      style, seed: wl.massId + (wl.side === 'front' || wl.side === 'back' ? 0 : 1),
      detail,
    })
  }

  // --- gables and roofs ----------------------------------------------------
  for (const m of plan.masses) {
    if (m.roof.kind === 'gable') {
      gableEnds(b, m, style, detail)
      gableRoof(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d, eaveY: m.eaveY, rise: m.roof.rise,
        ridgeAxis: m.ridgeAxis, overhang: plan.overhang ?? 0.4, verge: 0.3,
        layer: roofSpec.layer, tint: roofSpec.tint,
        moss: roofSpec.moss, fringe: roofSpec.fringe, detail,
      })
    } else {
      leanToRoof(b, {
        cx: m.cx, cz: m.cz, w: m.w, d: m.d,
        highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
        overhang: 0.28, layer: roofSpec.layer, tint: roofSpec.tint, detail,
      })
    }
  }

  // --- openings ------------------------------------------------------------
  doorway(b, { ...plan.door, detail })
  for (const wn of plan.windows) windowUnit(b, { ...wn, detail })

  // --- attachments ---------------------------------------------------------
  chimney(b, { ...plan.chimney, detail })
  // The porch keeps its roof at detail 1 (it changes the outline against the
  // sky) and loses its posts and rails, which do not.
  if (plan.porch) porch(b, { ...plan.porch, detail })
  if (plan.steps) steps(b, plan.steps)

  const geometry = b.toGeometry()
  return { geometry, triangles: b.triangles, plan }
}

/** The two triangles of wall above the eave, at whichever pair of walls the
 *  ridge runs into. */
function gableEnds(b, m, style, detail) {
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
  for (const e of ends) {
    gableEnd(b, { p0: e.p0, p1: e.p1, y0: m.eaveY, apexY: apex, style, detail })
  }
}
