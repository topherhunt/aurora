import * as THREE from 'three'
import { bakeImpostor, impostorCardExtents } from '../../props/impostor.js'
import { LAYER } from '../../textures.js'
import { KINDS, planBuilding } from '../plan.js'
import { buildBuilding2 } from './building.js'

// ---------------------------------------------------------------------------
// The far end of the building ladder: two crossed planes at the building's own
// two widths, wearing a shared photograph, held there to the cull distance.
//
// props/impostor.js does the photography and the argument for having an
// impostor at all is told there, in trees. Two things are different here.
//
// A BUILDING IS NOT RADIALLY SYMMETRIC. A pine seen from the north and from the
// east is the same picture, so one bake serves three planes and the card can be
// spun freely. A longhouse is a long low flank under a run of eave from one
// side and a tall narrow gable from the other. Those are two shapes, they
// differ by up to a factor of four in width, and the difference is the whole
// silhouette. So the cross's two planes stand at their own TRUE widths -- the
// X plane spans the X extent, the Z plane the Z extent -- and that is what
// buildImpostorCard cannot express, which is why the cross is written out here
// rather than borrowed. It gives every plane one width and one layer.
//
// BUT THE PHOTOGRAPH IS NOT OF THIS BUILDING. It is one of twenty, keyed on
// WALL STYLE x ROOF KIND, and every building wearing that pair borrows it. The
// arithmetic is the whole reason: a photograph per variant is 148 slices of
// 64 KB, 9.3 MB of texture to put 4-triangle specks on a hillside; per material
// pair it is 20 slices and 1.25 MB. And it is complete rather than a sample --
// the four kinds' legal style x roof grids union to exactly the 20 a cottage
// can be built for, so a cottage stands in for all of them and no building is
// left without a card.
//
// What that gets wrong is PROPORTION, and it is worth naming because it is the
// one thing the card no longer measures off the building it stands for. A
// distant inn wears a cottage's picture stretched to the inn's own width and
// height, so its eave line lands where a cottage's does: 0.456 of the way up
// against the inn's own 0.527, which at the 28 px the band opens at is about
// three pixels of wall that should have been roof. Everything the eye actually
// sorts buildings by at that range is still right -- the silhouette is the
// building's own, the wall material is its own and the roof material is its own.
//
// BOTH PLANES ALSO WEAR THE SAME PHOTOGRAPH, stretched to each plane's own
// width. What is given up there is the narrow plane's content: a gable end
// wearing a stretched flank shows a long ridge where it should show a pediment.
// What is kept is the silhouette WIDTH, which is what reads at range, and the
// band opens at 200 m where the narrow plane is about ten pixels across. The
// stand-in is photographed on its WIDER elevation, because a wide picture
// squeezed into a narrow quad keeps more than a narrow one stretched wide
// invents.
//
// THERE IS NO BILLBOARD TIER. Trees have one because a forest is thousands of
// instances and a tree is radially symmetric, so a spun quad is both necessary
// and free. A town is thirty buildings, so the two triangles a billboard saves
// are sixty triangles across the whole village -- and a spun quad shows one
// width from every angle, which on a longhouse is a 4x width error at exactly
// the range the silhouette is all there is. The cross costs nothing worth
// counting and is right. So the cross runs the whole way to `cull`.
//
// WHY THE CROSS IS TWO PLANES AND NOT THREE. The tree argument for three is
// that at 60 degrees apart you are never more than 30 degrees off the normal of
// one of them. It assumes the planes are interchangeable. Here they are the
// building's two axes and its two widths, and a third at 60 degrees would be
// standing a flank's width across a corner. Two at 90 degrees is not a
// compromise, it is the building's actual section. Four triangles, and the
// worst case is the 45-degree diagonal, which is the corner view -- where a
// real building shows both of its elevations, and so does the cross.
// ---------------------------------------------------------------------------

/**
 * WHERE EACH TIER HANDS OVER, in metres from the eye. Each entry is the far
 * edge of its own band; `cull` is where a building stops being drawn at all.
 *
 * These are defaults for the previewer's sliders rather than settled numbers,
 * and the two that are derived are the last two. The rest are the ladder as it
 * stood before there was a card to hand over to.
 *
 * THE CARD EDGE IS THE PARALLAX LIMIT. Section 5's rule is that a flat card's
 * failure to turn stays under 2 degrees beyond `depth x 28.6`. Measured over
 * 160 buildings the narrow axis runs 5.8 m median and 6.1 m mean, which puts
 * the rule at 166 to 175 m, and 200 m is the round number just past it. That
 * is where `detail0` ends: not because 67 triangles are expensive but because
 * 200 m is the first range at which nothing is lost by going flat. The deepest
 * plan in the kit is 12.9 m and wants 370 m by the same rule -- a square inn
 * rather than a longhouse -- so the swap is early for a handful of buildings
 * and honest for the rest.
 *
 * AT `cull` A BUILDING IS 3.7 PIXELS TALL and is still worth drawing, which is
 * the whole point of carrying the band out this far: a lit hamlet on a far
 * hillside is three specks and a plume of smoke, and three specks in the right
 * place is the difference between a landscape that is inhabited and one that is
 * empty. Section 5 costs card reach at 16.2 px per degree, which is Quest 2's
 * default eye buffer, so a 6 m ridge at distance d subtends RIDGE_PX / d. Four
 * triangles each, so a village of twenty out there is 80 triangles.
 */
export const BUILDING_BANDS = { detail2: 60, detail1: 140, detail0: 200, cull: 1500 }

/** Screen pixels a 6 m ridge covers at one metre, so `RIDGE_PX / d` is what it
 *  covers at d. 6 m x 57.296 deg/rad x 16.2 px/deg -- the last of those is
 *  §5's, measured off Quest 2's default eye buffer, and is shared with the fern
 *  card table so the two ladders are quoted in the same unit. */
export const RIDGE_PX = 5569

/**
 * THE CARD BANK: every wall style x roof kind a building can be built with,
 * once each, in a fixed order. The index into this is the offset from
 * `LAYER.IMPOSTOR_BUILDING`, so the order is a stored format and appending is
 * the only safe edit -- reordering renumbers every layer under it.
 *
 * It is generated from the cottage's own whitelists rather than from
 * WALL_STYLES x ROOF_KINDS, and the difference is the point: the cottage is the
 * one kind allowed all five styles and all four roofs, and the four kinds'
 * legal grids union to exactly this set (checked below). So a cottage can be
 * built for every entry, and every building in the world finds its entry here.
 */
export const CARD_COMBOS = []
for (const style of KINDS.cottage.styles) {
  for (const roof of new Set(KINDS.cottage.roofs)) CARD_COMBOS.push({ style, roof })
}

// The union check the paragraph above claims, run at module load rather than
// written down, because it is the assumption the whole bank rests on and a
// kind gaining a style is exactly the edit that would break it silently.
for (const [kind, K] of Object.entries(KINDS)) {
  for (const style of K.styles) {
    for (const roof of K.roofs) {
      if (!CARD_COMBOS.some((c) => c.style === style && c.roof === roof)) {
        throw new Error(`card bank has no ${style}/${roof} for ${kind}: a cottage cannot stand in for it`)
      }
    }
  }
}

/** Which layer a plan's card is photographed into, and read back from. Throws
 *  rather than falling back, because a building silently wearing the wrong
 *  material at 200 m is the failure this whole file exists to avoid. */
export function cardLayerFor(plan) {
  const i = CARD_COMBOS.findIndex((c) => c.style === plan.style && c.roof === plan.roofKind)
  if (i < 0) throw new Error(`no card combo for ${plan.style}/${plan.roofKind}`)
  return LAYER.IMPOSTOR_BUILDING + i
}

/**
 * How the camera has to be framed, from the geometry it will photograph.
 *
 * The bottom of the frame is the GROUND PLANE and not the bounding box, which
 * is the one measurement here that is a decision. A building's plinth is buried
 * -- `plinthBottom` is below zero on purpose, so a foundation still meets the
 * ground on the downhill side of a fall -- and framing from the box would put
 * that buried course in the photograph and then stand the card on top of it,
 * lifting the whole building off the hill by however much of it was underground.
 * Framing from zero drops the buried part below the frustum, which is exactly
 * what the ground does to it.
 *
 * `x` is what a camera on +Z sees and `z` is what a camera on +X sees, and both
 * are kept even though only one is photographed: the cross needs both widths to
 * stand its planes at, and `wide` says which one the picture is of.
 */
export function buildingCardFrames(geometry) {
  geometry.computeBoundingBox()
  const b = geometry.boundingBox
  const height = b.max.y
  if (!(height > 0)) {
    throw new Error(`buildingCardFrames: building has no height above ground (max.y ${b.max.y})`)
  }
  const x = { width: b.max.x - b.min.x, height }
  const z = { width: b.max.z - b.min.z, height }
  return {
    height,
    x,
    z,
    // Which elevation gets photographed. Usually the flank, but not always --
    // a squat hut can be deeper than it is long, and the picture should follow
    // the shape rather than the axis name.
    wide: x.width >= z.width ? 'x' : 'z',
    // What the bake has to be told to move the building by. The camera looks at
    // the origin, so a building whose masses put its centre elsewhere -- which
    // is every ell, tee and wing -- has to be slid under it first.
    centre: new THREE.Vector3((b.min.x + b.max.x) / 2, 0, (b.min.z + b.max.z) / 2),
  }
}

/**
 * The stand-in cottage for one combo. Exported because the previewer draws it
 * beside the card, and a card is unjudgeable without the thing it is a picture
 * of.
 *
 * `shape: 'single'` is a decision, not a default. The plainest mass is the
 * right stand-in precisely because it is the least specific: an ell or a wing
 * photographed broadside has a stepped roofline that belongs to that one
 * building, and stretching it across every simple cottage in the village would
 * put a jog in a roof that has none.
 *
 * ALL THREE OF `shape`, `style` and `roof` ARE PASSED. planBuilding takes them
 * as `override ?? pick(r, ...)`, and `??` short-circuits, so an override that
 * is supplied does NOT consume its draw from the stream. Passing two of the
 * three would leave the third reading a die the other two no longer rolled,
 * and the bank would quietly change shape the next time this list did.
 */
export function cardStandIn(combo, index) {
  return planBuilding({
    // The seed only has to be stable and to differ between combos, so that the
    // twenty are twenty cottages rather than one cottage in twenty materials.
    seed: 9001 + index * 37,
    kind: 'cottage',
    shape: 'single',
    style: combo.style,
    roof: combo.roof,
    groundAt: () => 0,
  })
}

/**
 * Photograph the whole bank: one stand-in cottage per combo, its wider
 * elevation, into its own layer.
 *
 * `renderer` is the live one, borrowed for twenty frames, the way trees borrow
 * it at load. Returns one report per combo, which is worth looking at: a
 * coverage near zero means the framing missed, and a card that is empty draws
 * nothing rather than drawing wrong, so it is the failure that hides.
 *
 * The azimuth follows `frames.wide`: a camera at 0 is on +Z and sees the X
 * extent, one at 90 degrees is on +X and sees the Z extent.
 */
export function bakeBuildingCardBank(renderer, texArray, { characterFor = null, smoothAngle } = {}) {
  return CARD_COMBOS.map((combo, i) => {
    const plan = cardStandIn(combo, i)
    const character = characterFor ? characterFor(plan.seed) : null
    const built = buildBuilding2(plan, { detail: 0, character, smoothAngle })
    const frames = buildingCardFrames(built.geometry)
    // Slid rather than mutated is moot here -- this geometry is ours -- but the
    // camera looks at the origin and a cottage's masses do not centre on it.
    built.geometry.translate(-frames.centre.x, 0, -frames.centre.z)
    const frame = frames[frames.wide]
    const shot = bakeImpostor(renderer, built.geometry, texArray, LAYER.IMPOSTOR_BUILDING + i, {
      width: frame.width,
      height: frame.height,
      azimuth: frames.wide === 'x' ? 0 : Math.PI / 2,
      // The kit keeps a slate roof's grey, a thatch roof's weathering and every
      // wall tint in the `color` attribute. See createImpostorBakeMaterial.
      vertexColors: true,
    })
    built.geometry.dispose()
    return { ...combo, index: i, layer: LAYER.IMPOSTOR_BUILDING + i, plan, frames, shot }
  })
}

/**
 * A quad standing on the ground, spanning `width` along `dir` and `height` up,
 * wearing `layer`. `v = 0` at the top, to agree with the flip in bakeImpostor.
 *
 * The white `color` attribute is not decoration. The kit's material runs with
 * `vertexColors: true` so that a slate roof can be a tinted shake, and three
 * requires the attribute on every geometry that material draws once it is on --
 * a card without one samples zero and comes out black. Eight floats to stay in
 * the same material as the building it stands in for, which is the trade this
 * whole kit is built on.
 */
function cardQuad(width, height, layer, dirX, dirZ, nx, nz) {
  const hw = width / 2
  const corners = [
    [-hw, 0, 0, 1], [hw, 0, 1, 1], [hw, height, 1, 0], [-hw, height, 0, 0],
  ]
  const pos = []
  const nrm = []
  const uv = []
  const lay = []
  const col = []
  for (const [s, y, u, v] of corners) {
    pos.push(dirX * s, y, dirZ * s)
    nrm.push(nx, 0, nz)
    uv.push(u, v)
    lay.push(layer)
    col.push(1, 1, 1)
  }
  return { pos, nrm, uv, lay, col }
}

/**
 * The card tier, and the only one: two planes crossing at the middle, each at
 * its own true width, both wearing the one photograph `layer` names. Four
 * triangles, out to `cull`.
 *
 * `layer` has no default, deliberately. It comes from `cardLayerFor(plan)`, and
 * a default would be a card that draws SOMETHING for a building whose material
 * pair has no picture -- the wrong roof at 200 m, which looks like a working
 * feature. Missing is meant to throw.
 *
 * THE TWO WIDTHS ARE THE POINT. Both planes take `frames.x` and `frames.z`
 * respectively rather than the photographed frame, so a longhouse is 21 m
 * broadside and 5 m end-on exactly as it should be, and the UVs still run 0..1
 * on both -- the picture is squashed into the narrow plane. That is the trade
 * named at the top of this file: content for width. Skipping it and giving both
 * planes the photographed width would put a longhouse's broadside silhouette on
 * its gable end, which at 200 m is 55 px of building that is not there.
 *
 * Normals are PLANE normals, which is the default in props/impostor.js and the
 * case that note calls right for "a SOLID whose planes really are facing
 * different ways -- a rock". A building is that solid. The canopy fan exists
 * because a tree is a blob whose planes are a fiction; here the two planes ARE
 * the two walls, and a flank lit differently from a gable is not a seam
 * artefact, it is how buildings look.
 *
 * The normals are also horizontal on purpose, and that is a contract rather
 * than a consequence: material.js spins a quad iff its layer is in
 * `billboardLayers` AND `normal.y > CARD_UP_MARK`. Nothing here is ever meant
 * to spin, so the bank's twenty layers must stay OUT of any billboard list -- a
 * building cross whose planes turned to face the eye would swing its two widths
 * into each other as the player walked.
 */
export function buildBuildingCross(frames, layer) {
  const ex = impostorCardExtents(frames.x)
  const ez = impostorCardExtents(frames.z)
  const planes = [
    cardQuad(ex.width, ex.height, layer, 1, 0, 0, 1),
    cardQuad(ez.width, ez.height, layer, 0, 1, 1, 0),
  ]
  const pos = []
  const nrm = []
  const uv = []
  const lay = []
  const col = []
  const idx = []
  for (const p of planes) {
    const base = pos.length / 3
    pos.push(...p.pos)
    nrm.push(...p.nrm)
    uv.push(...p.uv)
    lay.push(...p.lay)
    col.push(...p.col)
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(lay, 1))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.impostor = { tier: 'cross', planes: 2, triangles: 4, layers: [layer] }
  return geo
}
