import { buildMushroom, mushroomTriangles, MUSHROOM_DEFAULTS } from './mushroom.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The mushroom variant bank: every mushroom mesh in the world, baked once at
// load, plus the one spun card that stands in for it past a few metres.
//
// Same shape as fern-bank.js and tree-bank.js and for the same reasons -- no
// offline step, no asset file, a cross product small enough that the variety a
// player sees comes from yaw and scale rather than from stored meshes. What is
// different here is the LADDER, and it is different because a mushroom is 8 to
// 28 cm tall:
//
//   LOD0   the mesh at radial 16. 60 to 66 triangles.
//   LOD1   the same mesh at radial 6. 30 to 36 triangles.
//   LOD2   one plane, spun toward the eye, 1 triangle.
//   gone   under 2 px, which for a 13 cm mushroom is 60 m.
//
// TWO MESH TIERS AND ONE CARD IS THE WHOLE ARGUMENT ABOUT SIZE. §5's bush class
// hands out 84 / 56 / 28 and puts the card at 26 m, and every one of those
// numbers is wrong for this prop in the same direction: 26 m is where a 13 cm
// mushroom is 3 px tall. gen-mushroom.html prints both figures live (its
// parallax and LOD panels) and they are what the bands below are set from -- the
// card comes in at a few metres, not at 26, and the whole prop is culled before
// a fern's card would have started.
//
// The second mesh tier is affordable only because of what the cap's texture is:
// it used to be a POLAR chart, which a coarse cap sliced into wedges (see capUV
// in props/mushroom.js), so dropping columns cost silhouette AND texture and
// there was nothing worth dropping to. The cap wears a planar decal now. Column
// count is purely a silhouette question, so the near tier can afford 16 and the
// far one can fall to 6.
//
// AND NOTHING BETWEEN THE COARSE MESH AND THE BILLBOARD. A tree and a fern each
// card to a CROSSED PAIR of planes before they card to one, because a crown is
// metres deep and a single flat plane through it shows its own parallax error
// while the prop is still large on screen. A mushroom never gets that window:
// the coarse mesh already runs to 40 spans, which is past §5's `spread x 28.6`
// and is where the whole prop is 23 px across at 16.2 px/deg. A second plane at
// that size is two more triangles spent on a picture nobody can resolve, so the
// tier after the coarse mesh is the spun billboard, and the billboard runs until
// the scatter's rim dissolve takes it.
//
// THE CARD IS PER SPECIES, NOT PER VARIANT -- five photographs for ninety
// meshes. The long version is on LAYER.IMPOSTOR_MUSHROOM_AGARIC in textures.js;
// the short version is that a card gives up shape and keeps hue, and hue is the
// one thing that still separates a scarlet cap from an ink cap at 8 m.
// ---------------------------------------------------------------------------

// The five species, as parameters over MUSHROOM_DEFAULTS.
//
// These are the previewer's presets and this is now where they live --
// gen-mushroom.html imports them from here rather than keeping a second copy,
// because a preset that drifted from the shipped bank would make the bench a
// picture of a mushroom the world does not contain.
//
// `cluster` is 1 on all five and stays 1. Mushrooms grow in bunches, but a bunch
// is the SCATTER's job (src/v2/render/mushrooms.js places 1 to 5 of one species
// around a point, each tilted its own way) and the generator's job is the
// individual. Baking the clump into the geometry would fix the count, the
// spacing and the lean of every bunch in the world to one roll of the dice.
export const MUSHROOM_SPECIES = {
  'fly agaric': {
    impostorLayer: LAYER.IMPOSTOR_MUSHROOM_AGARIC,
    params: {
      // Nearly a circle: `wavy` 0.02 on 2 lobes is a rim that is barely off
      // round, which is what an amanita's is. The undulation knobs are still
      // non-zero because a mathematically circular rim is the other tell.
      height: 0.16, capRadius: 0.46, capRise: 0.30, capCurve: 2.4, margin: 0.02,
      wavy: 0.02, lobes: 2, umbo: 0, inroll: 0.05,
      stemHeight: 0.66, stemRadius: 0.052, stemTaper: 0.30, bulb: 0.55,
      ring: 0.34, ringHeight: 0.74, ringDroop: 0.4,
      cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 0, fleshCell: 0,
    },
  },
  porcini: {
    impostorLayer: LAYER.IMPOSTOR_MUSHROOM_PORCINI,
    params: {
      // The whole identity is the STEM, not the cap: a bolete is a bun on a
      // barrel. stemRadius here is three times the agaric's.
      height: 0.13, capRadius: 0.5, capRise: 0.34, capCurve: 2.9, margin: -0.02,
      wavy: 0.1, lobes: 3, umbo: 0, inroll: 0.18,
      stemHeight: 0.5, stemRadius: 0.17, stemTaper: 0.55, bulb: 0.3,
      ring: 0, cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 1, fleshCell: 2,
    },
  },
  chanterelle: {
    impostorLayer: LAYER.IMPOSTOR_MUSHROOM_CHANTERELLE,
    // The lobe count is rolled per variant rather than fixed, because on the one
    // species whose rim undulation is 0.30 of its radius the lobe count IS the
    // silhouette -- three chanterelles side by side with five lobes each read as
    // three castings of one mould in a way three fly agarics never do.
    lobesVary: [3, 4, 5],
    params: {
      // capRise NEGATIVE. This is the case the profile function was written for:
      // the same formula that domes a cap dishes it when the sign flips, so a
      // funnel costs no extra code and no extra triangles. It is also the only
      // species whose stalk could come up through its own cap, which is what
      // `capLift` in mushroom.js exists to stop. It is only just negative: the
      // dish is carried by `margin` lifting the rim, and a deep bowl on top of
      // that read as a cup rather than a chanterelle.
      height: 0.08, capRadius: 0.44, capRise: -0.02, capCurve: 1.6, margin: 0.10,
      wavy: 0.30, lobes: 4, umbo: 0, inroll: 0,
      stemHeight: 0.55, stemRadius: 0.075, stemTaper: -0.30, bulb: 0,
      ring: 0, cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 3, fleshCell: 1,
    },
  },
  parasol: {
    impostorLayer: LAYER.IMPOSTOR_MUSHROOM_PARASOL,
    params: {
      height: 0.28, capRadius: 0.55, capRise: 0.16, capCurve: 5.2, margin: 0.01,
      wavy: 0.06, lobes: 7, umbo: 0.09, inroll: 0,
      stemHeight: 0.78, stemRadius: 0.032, stemTaper: 0.35, bulb: 0.35,
      ring: 0.3, ringHeight: 0.66, ringDroop: 0.5,
      cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 2, fleshCell: 0,
    },
  },
  'ink cap': {
    impostorLayer: LAYER.IMPOSTOR_MUSHROOM_INKCAP,
    params: {
      // The one that is nearly all stem: capRadius 0.21 against the agaric's
      // 0.46, on a stalk that is four fifths of the height. A cone on a wire is
      // a silhouette no amount of dragging turns any of the other four into.
      height: 0.12, capRadius: 0.21, capRise: 0.55, capCurve: 1.3, margin: -0.03,
      wavy: 0.12, lobes: 8, umbo: 0, inroll: 0.12,
      stemHeight: 0.82, stemRadius: 0.026, stemTaper: 0.2, bulb: 0.1,
      ring: 0, cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 2, fleshCell: 3,
    },
  },
}

export const MUSHROOM_NAMES = Object.keys(MUSHROOM_SPECIES)

// ---------------------------------------------------------------------------
// The six shape variants each species is built at.
//
// The previewer's gallery crosses four axes -- stemHeight, capRadius and capRise
// at three levels each and stemCurve at two -- into 54 cells, and its stated job
// is to answer WHICH OF THOSE CELLS ARE WORTH BAKING. This is that answer: an
// ORTHOGONAL ARRAY of six. Every level of every axis appears exactly twice
// (stemCurve three times), and no two rows share a pair, so six meshes cover the
// four axes about as evenly as six meshes can.
//
// Six rather than fifty-four because of what the extra forty-eight would buy. A
// mushroom is mesh only inside a few metres, where a player sees one clump of
// one to five; the thing that stops five of them looking cloned is that they
// take different rows here AND different yaws AND different scales, and the
// second and third of those are free per instance. Fifty-four rows would be 270
// geometries in the arena to be looked at three at a time.
//
// Row 0 is deliberately all-ones -- the species exactly as MUSHROOM_SPECIES
// declares it. That is the row the card is photographed from, so the species'
// own parameters are what the whole distance ladder shows.
export const MUSHROOM_VARIANTS = [
  { stemHeight: 1, capRadius: 1, capRise: 1, stemCurve: 0.3 },
  { stemHeight: 2 / 3, capRadius: 1.5, capRise: 0.5, stemCurve: 0.7 },
  { stemHeight: 1.5, capRadius: 2 / 3, capRise: 2, stemCurve: 0.3 },
  { stemHeight: 1, capRadius: 2 / 3, capRise: 0.5, stemCurve: 0.7 },
  { stemHeight: 2 / 3, capRadius: 1, capRise: 2, stemCurve: 0.3 },
  { stemHeight: 1.5, capRadius: 1.5, capRise: 1, stemCurve: 0.7 },
]

// Height multipliers on the species' own default, applied by REGENERATING at the
// new height rather than by scaling an instance. Regenerating buys real shape
// variation and not just a bigger copy: buildMushroomBank seeds every slot
// separately, so the three sizes roll different rims and different cap curves.
// Measured on parasol shape 0, spread over height comes out 1.136 / 1.226 /
// 1.204 across the three -- an 8% spread in PROPORTION, which is the part a
// per-instance scale could never have produced.
//
// Three rows and no more, because that shape variation is what costs: each row
// is 30 more meshes in the arena, and the scatter's own per-instance scale
// jitter already covers plain size. Three is enough that a bed is not one
// silhouette shaken.
export const MUSHROOM_SIZES = [0.8, 1.0, 1.25]

// Columns around the cap, one entry per MESH tier, finest first. Everything else
// about the two meshes is identical -- same species, same variant, same seed --
// so the coarse tier is the same mushroom with a blockier rim rather than a
// different prop.
//
// 16 then 6, and the drop is that steep because of what each tier is looked at
// from. At the near tier the rim is a curve a few metres from the eye and 16
// columns is where it stops reading as a polygon; by the far tier the whole
// mushroom is around 23 px tall and a 6-gon rim is under half a pixel of chord
// error. `stemRadial` is NOT tiered with it: a stalk is a triangular prism at 3
// columns already and there is nothing under 3.
export const MUSHROOM_MESH_RADIAL = [16, 6]

// The distance ladder, in MULTIPLES OF THE PROP'S OWN SPAN rather than metres:
// tier 0 inside 20 spans, tier 1 to 40, the spun billboard from there to the
// scatter's draw radius. A variant's `span` is measured by buildMushroomBank
// below, and it is max(height, spread) -- the larger of how tall the thing is
// and how wide.
//
// RELATIVE AND NOT ABSOLUTE, because this generator spans two orders of
// magnitude. The same five presets build a 9 cm forest-floor mushroom and a 3 m
// cave one, and a fixed 10 m band means the small one is a mesh until it is 15
// px tall while the big one has been carded since it was 26 px. Hanging the
// ladder off the prop's own size makes the swap happen at the same APPARENT SIZE
// for every one of them -- at 16.2 px/deg that is 46 px and 23 px -- which is
// the thing the tier is actually chosen by. It costs one multiply per
// instance per frame in the scatter's band test, which is why it is worth doing
// rather than merely correct.
//
// MAX AND NOT HEIGHT, and the max is what makes §5's parallax rule hold by
// construction. §5 wants the first FLAT tier no closer than `depth x 28.6`, and
// a cap is as deep as it is wide, so the depth is `spread`. Because span >=
// spread, the card starting at 40 spans starts at 40 x spread AT WORST -- 1.40
// of what the rule demands, on every variant, whatever a future preset does to
// the proportions. Height alone would not: the chanterelle at capRise -0.02 is a
// pancake 1.86 times wider than it is tall, so 40 of ITS heights is only 21.5 of
// its spreads and its card would come in at half the honest range.
//
// MAX AND NOT SPREAD, for the other end of the same argument. The ink cap is a
// thimble on a stalk -- spread 0.046 m against height 0.12 -- and 40 spreads is
// 1.8 m, where it is still 86 px tall. Carding an 86 px prop is visible. Taking
// the larger of the two lets the thin species be governed by its height and the
// flat species by its width, which is what "apparent size" meant all along.
export const MUSHROOM_LOD_SPANS = [20, 40]

// The LOD2 billboard is a TRIANGLE, apex down.
//
// A mushroom is the lollipop case from impostor.js's species table -- a wide cap
// over a thin stalk -- so the two corners the apex-down triangle throws away are
// the ground either side of the stem, which hold nothing. Measured by
// rasterising the real LOD0 silhouette of all five species and counting which
// covered pixels fall inside each triangle (scripts/check-mushrooms.mjs does it
// and gates the number), apex-down keeps 74 to 94 percent of the prop where
// apex-up keeps 40 to 58: parasol 93.7 against 39.6, fly agaric 89.7 / 45.3,
// chanterelle 88.8 / 57.3, ink cap 82.0 / 45.2, porcini 74.4 / 57.7. Half the
// far band's triangles for a few percent of a picture three pixels tall.
//
// PORCINI IS THE WORST CASE AND IT IS WORTH SAYING WHY, because it is the one
// that would break the choice if it got any worse: a bolete is a bun on a
// BARREL, so the widest part of its silhouette near the ground is real stem and
// not empty air, which is exactly what an apex-down triangle clips. At 74
// percent it still beats apex-up on that species by 17 points, but a future
// preset fatter in the stem than the cap should be re-measured rather than
// assumed to follow the others.
export const MUSHROOM_BILLBOARD_TRI = 'down'

/** Every species x variant x size combination, in a stable order. Index into this is a variant id. */
export function mushroomVariants() {
  const out = []
  for (const species of MUSHROOM_NAMES) {
    const sp = MUSHROOM_SPECIES[species]
    const base = { ...MUSHROOM_DEFAULTS, ...sp.params }
    MUSHROOM_VARIANTS.forEach((shape, shapeIndex) => {
      MUSHROOM_SIZES.forEach((size, sizeIndex) => {
        // Walked across the species' variants rather than rolled from a seed:
        // the eighteen slots then hold every lobe count six times each instead
        // of whatever eighteen throws of a die happened to give, and a variant
        // stays a pure function of its coordinates.
        const ordinal = shapeIndex * MUSHROOM_SIZES.length + sizeIndex
        out.push({
          species,
          shapeIndex,
          size,
          impostorLayer: sp.impostorLayer,
          height: base.height * size,
          lobes: sp.lobesVary ? sp.lobesVary[ordinal % sp.lobesVary.length] : base.lobes,
          // Multipliers resolved here rather than at build time, so a variant is
          // a complete description of a mushroom and the bank, the bench and the
          // gate cannot each apply them slightly differently.
          stemHeight: base.stemHeight * shape.stemHeight,
          capRadius: base.capRadius * shape.capRadius,
          capRise: base.capRise * shape.capRise,
          stemCurve: shape.stemCurve,
        })
      })
    })
  }
  return out
}

/**
 * The impostor texture layers, one per species.
 *
 * This is the list `createPropMaterial({ billboardLayers })` keys on to decide
 * which geometries in the batch its vertex shader spins toward the eye. The LOD2
 * billboard is the ONLY tier that wears these layers -- the two mesh tiers wear
 * MUSHROOM_CAP and MUSHROOM_FLESH -- so unlike treeImpostorLayers, whose crossed
 * tier shares the layer with the tree's billboard and is held fixed by its
 * normals alone, the list is sufficient here. The shader's second condition, a
 * vertex normal at or over CARD_UP_MARK, still has to hold and does:
 * buildImpostorCard's `upNormal` writes literal (0, 1, 0).
 */
export function mushroomImpostorLayers() {
  return MUSHROOM_NAMES.map((s) => MUSHROOM_SPECIES[s].impostorLayer)
}

/**
 * The full parameter set for one variant, ready for buildMushroom.
 *
 * `tier` indexes MUSHROOM_MESH_RADIAL and is the ONLY thing that differs between
 * the two mesh tiers -- same species, same variant, same seed, fewer columns --
 * so the coarse mesh cannot drift into being a different mushroom.
 */
export function mushroomParams(v, seed, tier = 0) {
  const radial = MUSHROOM_MESH_RADIAL[tier]
  if (radial === undefined) throw new Error(`mushroom-bank: no mesh tier ${tier}`)
  return {
    ...MUSHROOM_DEFAULTS,
    ...MUSHROOM_SPECIES[v.species].params,
    height: v.height,
    stemHeight: v.stemHeight,
    capRadius: v.capRadius,
    capRise: v.capRise,
    stemCurve: v.stemCurve,
    lobes: v.lobes,
    radial,
    seed,
  }
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

/**
 * What one species' card has to be framed to: the size-1.0, shape-0 mushroom's
 * own extents.
 *
 * Measured off a real build rather than derived from `capRadius`, because
 * `buildMushroom` rescales to hit `height` at the end -- so the world width of a
 * cap is not readable off any parameter without building it. The geometry comes
 * back with the frame so the bake can photograph the very thing that was
 * measured instead of a second build of it.
 */
function cardFrame(species, seed) {
  const v = mushroomVariants().find((x) => x.species === species && x.shapeIndex === 0 && x.size === 1.0)
  if (!v) throw new Error(`mushroom-bank: no size-1.0 shape-0 variant for ${species}`)
  const geo = buildMushroom(mushroomParams(v, seed))
  const u = geo.userData.mushroom
  return { geo, frame: { width: u.spread, height: u.height } }
}

/**
 * Bake the whole bank in the shared batch's attribute layout.
 *
 * Returns `{ tiers, variants, bytes, triangles }`, where `tiers[t].geometries[v]`
 * is the geometry for tier `t` and variant `v`, and each entry of `variants` has
 * picked up a measured `span` -- max(height, spread) -- that mushroomVariants()
 * on its own cannot supply. Every tier is the same length, so a band index and a
 * variant id are independent lookups. What is SHARED five ways is the
 * photograph, not the geometry: the card tier still holds a triangle of its own
 * per variant, sized to that variant's measured height, because a card cut for
 * the middle size makes a size-0.8 instance grow 25% at the swap.
 *
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch -- BatchedMesh copies the vertex data into its arena, so holding the
 * originals just doubles the memory.
 *
 * The CARD tier arrives with no pixels behind it. Its layers cannot be
 * photographed here because the bake needs a live renderer and this runs in a
 * constructor and in node -- see bakeMushroomImpostors. Until that runs the
 * cards sample an empty layer and alphaTest discards them, so distant mushrooms
 * fade in rather than flashing.
 */
export function buildMushroomBank({ seed = 1 } = {}) {
  const variants = mushroomVariants()
  const meshes = MUSHROOM_MESH_RADIAL.map(() => [])
  const cards = []

  // ONE PHOTOGRAPH PER SPECIES, but one QUAD PER VARIANT, and those are two
  // different economies. The photograph is an atlas layer and layers are the
  // budget the user capped: five, shared by ninety variants. The quad is four
  // triangles of arena and is nearly free, so there is no reason to make it
  // stand in for a size it is not.
  //
  // Framed on the shape-0, size-1.0 build -- the middle of what the card stands
  // in for, and the same subject bakeMushroomImpostors photographs. The two MUST
  // agree to the texel or the picture is stretched across the quad, which is why
  // both go through cardFrame rather than each applying the margin itself.
  const perSpecies = new Map()
  for (const species of MUSHROOM_NAMES) {
    const { geo, frame } = cardFrame(species, seed)
    geo.dispose()
    perSpecies.set(species, {
      ext: impostorCardExtents(frame),
      frameHeight: frame.height,
      layer: MUSHROOM_SPECIES[species].impostorLayer,
    })
  }

  variants.forEach((v, i) => {
    // One seed per VARIANT, not per species: two sizes of one species should not
    // be the same mushroom at two scales, and the shape rows would otherwise all
    // roll the same wavy rim.
    // Both mesh tiers off the SAME seed, so the coarse one is the fine one with
    // fewer columns rather than a second roll of the rim.
    const mesh = buildMushroom(mushroomParams(v, seed + i * 101, 0))
    meshes[0].push(mesh)
    for (let t = 1; t < MUSHROOM_MESH_RADIAL.length; t++) {
      meshes[t].push(buildMushroom(mushroomParams(v, seed + i * 101, t)))
    }
    const s = perSpecies.get(v.species)

    // The variant's own size, MEASURED off the built mesh rather than taken from
    // `v.height`, because `spread` falls out of the cluster layout and the wavy
    // rim and there is no closed form for it. This is the scale the scatter's
    // distance bands are multiples of -- see MUSHROOM_LOD_SPANS -- so it is
    // written back onto the variant record where the scatter can reach it.
    v.span = Math.max(mesh.userData.mushroom.height, mesh.userData.mushroom.spread)

    // The quad is the species' frame scaled to THIS variant's real height. The
    // ratio is applied to both extents, so the picture keeps the aspect it was
    // photographed at and only the size changes -- squashing the quad to each
    // variant's own aspect would stretch a shared photograph across it, and a
    // stretched cap is a worse artefact than a slightly wrong outline.
    //
    // Without this a size-0.8 instance wore a size-1.0 card and grew 25% at the
    // instant it crossed the 10 m band, with no cross-dissolve to hide it --
    // update() swaps geometry ids and nothing else. That is the pop this line
    // exists to remove, and it costs no atlas layers to remove it.
    const k = mesh.userData.mushroom.height / s.frameHeight

    // The billboard: one triangle with a vertical normal, spun toward the eye by
    // the shader. `upNormal` rides with the spin deliberately -- a card that
    // turns toward the player must not turn its normal too, or N.L becomes a
    // function of where they are standing and the whole bed twinkles as they
    // turn on the spot. It is also what selects this tier and no other for the
    // spin; see mushroomImpostorLayers.
    cards.push(buildImpostorCard(
      s.ext.width * k, s.ext.height * k, s.layer, 1,
      { upNormal: true, tri: MUSHROOM_BILLBOARD_TRI }))
  })

  const tiers = [...meshes.map((g) => ({ geometries: g })), { geometries: cards }]

  // `t.triangles` is per SLOT, because that is what the scatter indexes when it
  // prices one instance. The TOTALS are per DISTINCT geometry, which is what the
  // arena actually holds: the scatter dedupes by object identity before it calls
  // addGeometry, so a slot table that pointed two variants at one buffer would
  // otherwise be billed twice for it. Nothing shares a buffer today, but the
  // identity set is what keeps these two numbers honest if anything starts to.
  const counted = new Set()
  let bytes = 0
  let triangles = 0
  for (const t of tiers) {
    t.triangles = t.geometries.map((g) => g.index.count / 3)
    for (const g of t.geometries) {
      if (counted.has(g)) continue
      counted.add(g)
      bytes += geometryBytes(g)
      triangles += g.index.count / 3
    }
  }
  return { tiers, variants, bytes, triangles }
}

/**
 * Photograph one mushroom per SPECIES into the impostor layer its cards already
 * point at, in place. Call ONCE, with the same `seed` buildMushroomBank was
 * given.
 *
 * Unlike the tree and fern bakes this does NOT have to wait for
 * `loadImageLayers()`: a mushroom wears MUSHROOM_CAP and MUSHROOM_FLESH, which
 * are generated in JS and are in the array from the first frame (see
 * textures.js). It is still done off the same hook as the others because the
 * renderer is what it needs and that is where the renderer is, and because a
 * bake that ran before the array was uploaded would photograph black.
 *
 * Five ortho renders at 512^2 and five 1 MB readbacks, each of which stalls the
 * pipeline -- a deliberate one-off hitch at load, not anything the frame loop
 * does.
 */
export function bakeMushroomImpostors(renderer, texArray, { seed = 1 } = {}) {
  return MUSHROOM_NAMES.map((species) => {
    const { geo, frame } = cardFrame(species, seed)
    const ext = bakeImpostor(renderer, geo, texArray, MUSHROOM_SPECIES[species].impostorLayer, frame)
    geo.dispose()
    return { species, layer: MUSHROOM_SPECIES[species].impostorLayer, ...ext }
  })
}

/**
 * What the bank costs, without building it. Used by the bench and the gate to
 * price the arena before anything is allocated.
 */
export function mushroomBankTriangles({ seed = 1 } = {}) {
  const variants = mushroomVariants()
  const mesh = MUSHROOM_MESH_RADIAL.map((_, t) =>
    variants.reduce((n, v, i) => n + mushroomTriangles(mushroomParams(v, seed + i * 101, t)), 0))
  // The card tier is priced per VARIANT, not per species: the photograph is
  // shared five ways but the triangle is built at each variant's own size, so
  // the arena holds ninety of them. See buildMushroomBank on why those two
  // counts differ.
  return {
    // Per MESH TIER, finest first, because the two are separate bands in the
    // arena and a caller pricing "the mesh" has to say which one it means.
    mesh,
    meshTotal: mesh.reduce((a, b) => a + b, 0),
    card: variants.length,
    variants: variants.length,
  }
}
