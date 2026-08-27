import { LAYER } from '../../textures.js'
import {
  Builder, WALL_STYLE, TINT, member2, gableEnd, leanEnd,
  plinth, doorway, steps2, SMOOTH_LAYERS,
  wall2, planGableRoof, planLeanRoof, drawRoof, windowUnit2, chimney2, porch2,
  clearUnder, doorHeight, wallOpenings, dormer2, dormerHalfWidth, hash,
} from './parts.js'
import { makeCharacter, makeWarp, warpBuilder, smoothNormals } from './warp.js'
import { windowHalfWidth } from '../plan.js'

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
  masonry: WALL_STYLE.MASONRY,
}

/** Roof kind -> the layer and tint that render it, as v1. `slate` is SHINGLE
 *  under a tint that cancels the tile's own chroma; `pantile` is its own layer
 *  because a scallop is a shape and no tint makes a rectangle round. Pantile
 *  takes the least moss of the four -- fired clay sheds water and gives nothing
 *  to root in.
 *
 *  `age` IS PER MATERIAL and not one number for all four, because the aging term
 *  mixes toward `thatchOld`, which is a straw grey. That is the right direction
 *  for straw and for weathered wood and the wrong one for stone: on slate it is
 *  the one thing that would put the warmth back in after the tint took it out,
 *  and it would do it right along the eave, where the roof is nearest the eye. */
const ROOF_OF = {
  thatch: { layer: LAYER.THATCH, tint: TINT.thatchNew, fringe: true, moss: 0.4, age: 0.5 },
  shake: { layer: LAYER.SHINGLE, tint: TINT.shake, fringe: false, moss: 0.22, age: 0.5 },
  slate: { layer: LAYER.SHINGLE, tint: TINT.slate, fringe: false, moss: 0.12, age: 0.1 },
  pantile: { layer: LAYER.ROOF_TILE, tint: TINT.pantile, fringe: false, moss: 0.08, age: 0.5 },
}

/**
 * Build a planned building, crooked.
 *
 * `strength` scales the whole personality: 0 builds the straight thing, 1 is the
 * shipping default, and the previewer's slider runs past it so a value can be
 * chosen by looking rather than by arguing.
 *
 * Returns { geometry, triangles, plan, character, dormers }.
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

  // The field, built once here rather than in finish(): a window has to know
  // where the covering will END UP before it can reserve a band of wall under
  // it, and that is the same field the whole vertex array goes through below.
  // The identity of this object matters as well as its values -- the roof sheets
  // cache their warped selves against it.
  const warp = makeWarp(k, plan.plinthBottom, plan.footprint)

  // Where each dormer ended up seated, filled in below and handed back unwarped:
  // the gate needs to walk up to a dormer and measure it, and finding one in a
  // finished vertex array means looking for a shape rather than for a thing.
  const dormerSeats = []

  const finish = () => {
    // The lean is measured from the bottom of the plinth, so a building on a
    // deep footing leans from its footing rather than from the world origin --
    // otherwise a mass sitting 0.8 m down the hill starts its lean 0.8 m into
    // the ground and arrives at the eave with a different amount of it.
    warpBuilder(b, warp)
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
    return { geometry, triangles: b.triangles, plan, character: k, dormers: dormerSeats }
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
          moss: roofSpec.moss, age: roofSpec.age, fringe, detail: lod, k,
        })
        : planLeanRoof({
          cx: m.cx, cz: m.cz, w: m.w, d: m.d,
          highY: m.roof.highY, lowY: m.roof.lowY, dir: m.roof.dir,
          overhang: overhang * 0.7, layer: roofSpec.layer, tint: roofSpec.tint,
          age: roofSpec.age,
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
    doorway(b, {
      ...plan.door, height: doorHeight(plan.door, roofs.get(plan.masses[0].id).heightAt),
      seed: plan.seed * 53 + 3, detail: 0,
    })
    plan.windows.forEach((wn, i) => windowUnit2(b, {
      ...wn, seed: plan.seed * 53 + 11 + i, detail: 0, topAt: roofs.get(wn.massId).heightAt,
    }))
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

  // --- what the walls have to make room for --------------------------------
  //
  // Computed here, before a single wall is drawn, because the door's height is
  // an INPUT to the wall and not just to the doorway: a log course is cut around
  // the surround, so the wall has to be told the same number the surround will
  // eventually be built at. Working it out twice would be two chances to get a
  // different answer and a log lying across the top of the door.
  //
  // The door is always on mass 0's front wall (see plan.js), which is why it can
  // take that mass's roof without carrying a `massId` of its own.
  const doorH = doorHeight(plan.door, roofs.get(plan.masses[0].id).heightAt)
  // `nx`/`nz` are not decoration: `wall2` resolves each opening into a box in
  // the wall's own frame, and without the opening's facing it has no frame to
  // resolve it in. Leaving them off does not throw, it quietly makes every
  // comparison a NaN one -- which is false -- so the wall dodges nothing at all.
  const openings = [
    {
      x: plan.door.x, z: plan.door.z, nx: plan.door.nx, nz: plan.door.nz,
      hw: plan.door.width / 2,
      // The band the SURROUND fills, not the leaf: `y1` is the top of the lintel,
      // and a course level with the lintel is as wrong as one across the opening.
      y0: plan.door.y0, y1: plan.door.y0 + doorH + 0.2, solid: true,
    },
    // A window is much wider than its glass. The surround adds 7 cm a side, and
    // an open shutter swings another leaf-width clear of that, so a shuttered
    // 0.72 m window occupies 1.6 m of wall. Declaring only the glass is what put
    // studs through shutters: `wall2` dodged an opening 0.48 m wide while the
    // thing standing there was 0.80 m wide. These two numbers are read off
    // `windowUnit2`'s `ow` and `leafW` and have to move with them.
    ...plan.windows.map((wn) => ({
      x: wn.x, z: wn.z, nx: wn.nx, nz: wn.nz,
      hw: windowHalfWidth(wn),
      y0: wn.y0, y1: wn.y0 + wn.height + 0.12, solid: false,
    })),
  ]

  // What each wall reported about its own top edge, indexed the way plan.walls
  // is -- which is the index every window carries. A window ducks under the
  // timber lying across its wall as well as under the roof above it, and this is
  // the only place that height is known.
  const wallInfo = new Map()
  plan.walls.forEach((wl, i) => {
    if (wl.buried) return
    const m = plan.masses.find((mm) => mm.id === wl.massId)
    const R = roofs.get(m.id)
    // A wall that runs PERPENDICULAR to the ridge is a gable end, and that is the
    // whole test: its top climbs to the apex and back down, so it needs a column
    // boundary exactly at the ridge, and enough on either side to follow the sag
    // down to the eaves. At detail 2 it no longer has to be TOLD that: it is
    // handed the roof's fold lines and the ridge is one of them, along with every
    // cell boundary and every split diagonal it crosses on the way up. The count
    // below is the fallback for detail 1, whose roof is a single quad per slope
    // and has no folds to be handed except the ridge itself.
    const alongX = Math.abs(wl.p1[0] - wl.p0[0]) > Math.abs(wl.p1[1] - wl.p0[1])
    const isGableEnd = m.roof.kind === 'gable' && alongX !== (m.ridgeAxis === 'x')
    // A SLIVER is the scrap of gable standing above an abutting wing's roof: the
    // rest of the wall really is buried, and `wl.y0` is where the neighbour's
    // covering stops hiding it. Two things follow. It starts there rather than at
    // the floor, or it would be metres of wall built inside next door's attic.
    // And it is `plain`: it is the one wall on the building nobody can stand
    // close to, so it keeps the roof-following top edge -- which is the whole
    // reason it exists -- and gives up the quoins, studs and log ends, which at
    // full carpentry pushed the worst inn a hundred triangles past the §5 budget.
    wallInfo.set(i, wall2(b, {
      // 6 cm BELOW the plinth top, not at it. The plinth's top is one slab face
      // spanning the whole footprint -- a single triangle 9 x 6 m on an inn --
      // and the wall base is a chord subdivided at its own columns, so the field
      // lifts one off the other by a few millimetres and the joint the two were
      // planned to share opens along the ground. Overlapping it costs nothing:
      // the wall foot is inside the plinth, which is solid.
      p0: wl.p0, p1: wl.p1, y0: (wl.y0 ?? m.floorY) - 0.06, y1: m.eaveY,
      style, seed: wl.massId + (wl.side === 'front' || wl.side === 'back' ? 0 : 1),
      rough: plan.seed * 131 + i * 7 + 1,
      detail, k, plain: !!wl.sliver,
      topAt: R.heightAt,
      topBreaks: R.breaksAlong,
      topCols: detail >= 2 ? 0 : (isGableEnd ? 2 : 1),
      openings,
    }))
    if (isGableEnd && detail >= 2 && !wl.sliver) {
      // The king post, which used to live inside gableEnd(). Every timber gable
      // has one and it is what stops the tympanum reading as a blank triangle.
      // It gets `bow` because it is the longest unbroken vertical on the
      // building, and it reaches the sagged apex rather than a nominal one.
      //
      // It stands at the middle of the wall, and so does a window: an odd number
      // of bays puts one dead centre, and this post was going through it. Same
      // rule as a stud, and for the same reason -- the post can stand a little
      // off centre and the window cannot move at all by the time we are here.
      // 0.095 is its own half-section, 0.14 the clearance a timber this heavy
      // needs to read as beside the window rather than crowding it.
      const half = wl.len / 2
      const a = wallOpenings({ p0: wl.p0, p1: wl.p1, openings })
        .dodge(half, 0.095 + 0.07, 0.12, 0.14)
      if (a === null) return
      const t = a / wl.len
      const mx = wl.p0[0] + (wl.p1[0] - wl.p0[0]) * t
      const mz = wl.p0[1] + (wl.p1[1] - wl.p0[1]) * t
      member2(b, [mx, m.floorY, mz], [mx, clearUnder(R.heightAt, mx, mz, 0.13), mz], {
        hu: 0.095, sides: 6, seed: plan.seed * 131 + i * 7 + 2, round: 0.6,
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

  // --- dormers -------------------------------------------------------------
  //
  // MOST ROOFS HAVE NONE, and that is the whole design of the term. A dormer is
  // a strong, specific thing to say about a building -- there is a room up
  // there, and somebody wanted to see out of it -- and a village where every
  // roof says it has said nothing. Five sides in six draw a blank, so about a
  // third of buildings end up with at least one and a few carry two on one
  // pitch.
  //
  // Everything that could already be standing in that piece of roof gets a
  // veto, and each veto is asked of the geometry rather than of the plan:
  // the chimney by distance, and any OTHER mass's covering by asking it how low
  // it hangs over the seat. That second one is what keeps a dormer from growing
  // straight into the valley where a wing dies into the main range.
  //
  // TWO PER BUILDING, whatever the dice say. An inn has three masses and six
  // pitches to roll on, and its worst case without a cap is twelve of these --
  // which is 600 triangles on the largest kind in the kit, and stops reading as
  // a house with a room in the roof long before that.
  for (const m of plan.masses) {
    if (m.roof.kind !== 'gable') continue
    const alongX = m.ridgeAxis === 'x'
    const alongHalf = (alongX ? m.w : m.d) / 2
    const runHalf = (alongX ? m.d : m.w) / 2
    // A stub 1.1 m wide needs a wall to stand on either side of it, and it has
    // to get far enough up the slope for the covering to close over its back.
    if (alongHalf < 1.6 || runHalf < 1.7) continue
    const R = roofs.get(m.id)
    const dSeed = plan.seed * 71 + m.id * 13
    for (const side of [-1, 1]) {
      const u = hash(dSeed, side > 0 ? 1 : 2)
      const rolled = u < 0.833 ? 0 : (u < 0.945 ? 1 : 2)
      // TWO ON ONE PITCH HAVE TO FIT SIDE BY SIDE, and the thing that has to
      // fit is the covering rather than the stub: it oversails the cheeks, so a
      // pair the dice put a metre apart ends up with one eave laid ON the other
      // -- two doubled sheets in the same plane, which is the one overlap in
      // this kit that shows, because everything else that interpenetrates does
      // it at an angle. So the pair is held apart by the width of what is
      // actually drawn, and a pitch too short to hold them that far apart gets
      // one dormer instead of two rather than a narrower pair.
      const room = alongHalf - 0.95
      const apart = dormerHalfWidth(plan.overhang, k) + 0.05
      const n = rolled === 2 && room < apart ? 1 : rolled
      for (let i = 0; i < n && dormerSeats.length < 2; i++) {
        // Two of them stand either side of the middle; one stands where the
        // seed puts it. Never within a stub's width of a gable end, where the
        // verge is and where the roof is busiest.
        const jit = (hash(dSeed, side * 7 + i * 3 + 20) - 0.5) * 2
        const a = n === 2
          ? (i === 0 ? -1 : 1) * Math.max(apart, room * (0.5 + jit * 0.18))
          : jit * room * 0.75
        // Set back from the wall plane so the eave of the main roof, its fringe
        // and its verge all stay clear in front of the stub.
        const c = side * (runHalf - 0.3)
        const x = alongX ? m.cx + a : m.cx + c
        const z = alongX ? m.cz + c : m.cz + a
        const nx = alongX ? 0 : side
        const nz = alongX ? side : 0
        if (Math.hypot(x - plan.chimney.x, z - plan.chimney.z) < 1.15) continue
        let blocked = false
        for (const [id, other] of roofs) {
          if (id === m.id) continue
          const over = other.coverAt(x, z)
          if (over !== null && over < R.heightAt(x, z) + 2) blocked = true
        }
        if (blocked) continue
        const seat = dormer2(b, {
          x, z, nx, nz, sheetAt: R.heightAt, ridgeLimit: runHalf - 0.6,
          layer: roofSpec.layer, color: R.color, detail, k, style,
          overhang: plan.overhang,
          seed: plan.seed * 31 + m.id * 5 + (side > 0 ? 1 : 2) * 3 + i,
        })
        if (seat) dormerSeats.push({ ...seat, massId: m.id, sheetAt: R.heightAt })
      }
    }
  }

  // --- attachments ---------------------------------------------------------
  chimney2(b, { ...plan.chimney, seed: plan.seed * 53 + 5, detail, k })
  // The porch keeps its roof at detail 1 (it changes the outline against the
  // sky) and loses its posts and rails, which do not.
  //
  // Before the windows, not after, only so its canopy can be one of the things
  // they duck under: it is a shingle sheet at head height a metre from the door,
  // and the window beside the door is the one it lands on.
  const porchRoof = plan.porch
    ? porch2(b, { ...plan.porch, groundY: plan.plinthBottom, seed: plan.seed * 53 + 7, detail, k })
    : null
  if (plan.steps) steps2(b, { ...plan.steps, seed: plan.seed * 53 + 9, detail })

  // --- openings ------------------------------------------------------------
  doorway(b, { ...plan.door, height: doorH, seed: plan.seed * 53 + 3, detail })
  // Each window ducks under the roof of the mass it is a window OF -- never the
  // building's, which on an ell is a different roof at a different height.
  plan.windows.forEach((wn, i) => windowUnit2(b, {
    ...wn, seed: plan.seed * 53 + 11 + i, detail, k,
    // EVERY roof over this window, not just its own mass's. A window near the
    // inner corner of an ell has its own wing's covering metres above it and the
    // other wing's eave coming down to head height a metre away, and asking only
    // its own mass is how a window ends up with the neighbouring roof resting on
    // it. `coverAt` returns null off the sheet, so a roof that does not actually
    // overhang this point does not get a vote -- which is also what lets the
    // porch canopy, a sheet a couple of metres wide, be asked at all.
    topAt: (x, z) => {
      let y = roofs.get(wn.massId).heightAt(x, z)
      for (const [id, r] of roofs) {
        if (id === wn.massId) continue
        const over = r.coverAt(x, z)
        if (over !== null && over < y) y = over
      }
      if (porchRoof) {
        const over = porchRoof.coverAt(x, z)
        if (over !== null && over < y) y = over
      }
      return y
    },
    // The same question asked of a PATCH instead of a point, which is the only
    // way to see a sheet that ends over the window: the answer at the last
    // covered millimetre before a verge is lower than the answer anywhere the
    // window thought to sample, and that sliver is what a wing's roof presents
    // to the window round the corner from it. Infinity means no sheet reaches
    // the patch at all.
    lowAt: (x0, z0, x1, z1, w) => {
      let y = Infinity
      for (const [, r] of roofs) y = Math.min(y, r.lowIn(x0, z0, x1, z1, w))
      if (porchRoof) y = Math.min(y, porchRoof.lowIn(x0, z0, x1, z1, w))
      return y
    },
    warp,
    // The underside of its own wall's plate, where that wall has one. Null on
    // every style but half-timber, and null at detail 1, where the carpentry is
    // not drawn and there is nothing up there to duck under.
    capY: wallInfo.get(wn.wallIndex)?.plateY ?? Infinity,
  }))

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
