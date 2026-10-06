import { buildMushroom, mushroomTriangles, MUSHROOM_DEFAULTS } from './mushroom.js'
import { bakeImpostor, impostorCardExtents } from './impostor.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// The mushroom variant bank: every mushroom mesh in the world, baked once at
// load, plus the picture of each that the shared far card shows (render/litter-cards.js).
//
// Same shape as fern-bank.js and tree-bank.js and for the same reasons -- no
// offline step, no asset file, a cross product small enough that the variety a
// player sees comes from yaw and scale rather than from stored meshes. What is
// different here is the LADDER, and it is different because a mushroom is 8 to
// 28 cm tall:
//
//   LOD0   the mesh at radial 16. 108 to 122 triangles.
//   LOD1   the same mesh at radial 6. 58 to 72 triangles.
//   LOD2   the shared card quad, spun toward the eye, 2 triangles.
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
// AND NOTHING BETWEEN THE COARSE MESH AND THE CARD. A tree and a fern each
// card to a CROSSED PAIR of planes before they card to one, because a crown is
// metres deep and a single flat plane through it shows its own parallax error
// while the prop is still large on screen. A mushroom has no such window: the
// coarse mesh runs to twice the first rung (mushrooms.js) and the spun card
// follows it.
//
// ONE CARD PER SPECIES, which is also one card per variant -- see
// mushroomVariants. The long version is on LAYER.IMPOSTOR_MUSHROOM_AGARIC in
// textures.js; the short version is that a card gives up shape and keeps hue,
// and hue is the one thing that still separates a scarlet cap from an ink cap
// at 8 m.
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
      // `wavy` 0.06 on 8 lobes: an ink cap's rim splits and curls rather than
      // undulating, and a cap 21 cm across at full scale has no room for a wave
      // wide enough to read as one -- past about 0.08 the eight lobes stop being
      // a rim and start being a flower.
      height: 0.12, capRadius: 0.21, capRise: 0.55, capCurve: 1.3, margin: -0.03,
      wavy: 0.06, lobes: 8, umbo: 0, inroll: 0.12,
      stemHeight: 0.82, stemRadius: 0.026, stemTaper: 0.2, bulb: 0.1,
      ring: 0, cluster: 1, capLayer: LAYER.MUSHROOM_CAP, capCell: 2, fleshCell: 3,
    },
  },
}

export const MUSHROOM_NAMES = Object.keys(MUSHROOM_SPECIES)

// ---------------------------------------------------------------------------
// ONE VARIANT PER SPECIES, AND MUSHROOM_SPECIES IS ALL OF IT.
//
// There is no shape axis and no size axis. A variant IS a species, built at the
// numbers written above and at no multiple of them, so the table a preset is
// read from, the mesh the world draws and the mushroom the impostor is
// photographed from are one set of numbers rather than three that have to agree.
//
// WHAT DECIDES THAT is not the generator but the ARENA. The bank ships on
// render/prop-arena.js, one InstancedMesh per (tier, variant), so the layer
// costs `tiers x variants` draw calls: five species over three tiers is fifteen,
// which is the forest's sixteen. A six-shape by three-size cross product over
// the same five species is ninety variants and two hundred and seventy draw
// calls, for a prop that is 13 cm tall.
//
// WHAT PAYS FOR THE VARIETY INSTEAD is the instance matrix, which is free: the
// scatter rolls a yaw, a lean and a scale of 0.82 to 1.18 on every mushroom it
// places (SIZE_JITTER in render/mushrooms.js), and a clump is 1 to 5 members
// each rolled separately. What that cannot buy is a change of PROPORTION -- a
// shorter stalk under a wider cap -- because a matrix scales the whole prop at
// once. That is the real loss, and it is the one the forest and the fern beds
// already take: trees.js ships exactly one variant per species too.
//
// The bench still crosses fifty-four cells (gen-mushroom.html) and should: it is
// where the question "which proportions are worth baking" is asked, and the
// answer being the middle cell does not make the question go away.

// Columns around the cap, one entry per MESH tier, finest first. Everything else
// about the two meshes is identical -- same species, same variant, same seed --
// so the coarse tier is the same mushroom with a blockier rim rather than a
// different prop.
//
// 16 then 6, and the drop is that steep because of what each tier is looked at
// from. At the near tier the rim is a curve a few metres from the eye and 16
// columns is where it stops reading as a polygon; by the far tier the whole
// mushroom is around 23 px tall and a 6-gon rim is under half a pixel of chord
// error. `stemRadial` is NOT tiered with it, so BOTH tiers carry the 7-column
// stem LOD0 was set for. That is a knowingly unpaid bill on the far tier -- it is
// most of why the coarse mesh is 58 to 72 triangles rather than half of 108 to
// 122 -- and it stands until there is a reason to believe the second mesh tier
// earns its slot at all.
export const MUSHROOM_MESH_RADIAL = [16, 6]

// The distance ladder is the animals' arc rule over each variant's `span`, which
// buildMushroomBank measures as max(height, spread); mushrooms.js owns it.

/** One variant per species -- five. Index into this is a variant id. */
export function mushroomVariants() {
  return MUSHROOM_NAMES.map((species) => {
    const sp = MUSHROOM_SPECIES[species]
    const base = { ...MUSHROOM_DEFAULTS, ...sp.params }
    // Flattened rather than left as a species name for mushroomParams to look
    // up, because the scatter, the gate and the bench all read a variant record
    // directly and a record that only half-describes its mushroom is the thing
    // that lets the three of them disagree. `span` is measured onto it by
    // buildMushroomBank; everything else is here.
    return {
      species,
      impostorLayer: sp.impostorLayer,
      height: base.height,
      lobes: base.lobes,
      stemHeight: base.stemHeight,
      capRadius: base.capRadius,
      capRise: base.capRise,
      stemCurve: base.stemCurve,
    }
  })
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
 * What one species' card has to be framed to: that species' own extents.
 *
 * Measured off a real build rather than derived from `capRadius`, because
 * `buildMushroom` rescales to hit `height` at the end -- so the world width of a
 * cap is not readable off any parameter without building it. The geometry comes
 * back with the frame so the bake can photograph the very thing that was
 * measured instead of a second build of it.
 */
function cardFrame(species, seed) {
  const v = mushroomVariants().find((x) => x.species === species)
  if (!v) throw new Error(`mushroom-bank: no variant for ${species}`)
  const geo = buildMushroom(mushroomParams(v, seed))
  const u = geo.userData.mushroom
  return { geo, frame: { width: u.spread, height: u.height } }
}

/**
 * Bake the whole bank in the shared batch's attribute layout.
 *
 * Returns `{ tiers, cards, variants, bytes, triangles }`, where `tiers[t].geometries[v]`
 * is the mesh for tier `t` and variant `v`, and each entry of `variants` has
 * picked up a measured `span` -- max(height, spread) -- that mushroomVariants()
 * on its own cannot supply. Every tier is the same length, so a band index and a
 * variant id are independent lookups. `cards[v]` is the extents of the shared
 * far card (litter-cards.js addPicture) for variant `v`, sized to that variant's
 * measured height, so a mesh and the card that replaces it are the same size at
 * the instant they swap.
 *
 * The arena TAKES the geometries -- render/prop-arena.js hands each one to an
 * InstancedMesh, which draws the very object it was given -- so the caller must
 * NOT dispose them.
 *
 * The cards have no pixels behind them: the bake needs a live renderer and this
 * runs in a constructor and in node -- see bakeMushroomImpostors. Until it runs
 * a card's picture is empty and alphaTest discards it, so distant mushrooms fade
 * in rather than flashing.
 */
export function buildMushroomBank({ seed = 1 } = {}) {
  const variants = mushroomVariants()
  const meshes = MUSHROOM_MESH_RADIAL.map(() => [])
  const cards = []

  // ONE PHOTOGRAPH AND ONE QUAD PER SPECIES. They are still built apart because
  // they are different economies -- the photograph is an atlas layer, which is
  // the budget capped at five, and the quad is four triangles -- but with one
  // variant per species there is one of each and they describe one mushroom.
  //
  // Framed on the shape-0, size-1.0 build -- the only build there is, and the
  // same subject bakeMushroomImpostors photographs. The two MUST
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
    // A seed of its own per species, so five mushrooms built from five presets
    // do not all roll the same rim. Both mesh tiers off the SAME seed, so the
    // coarse one is the fine one with fewer columns rather than a second roll.
    const mesh = buildMushroom(mushroomParams(v, seed + i * 101, 0))
    meshes[0].push(mesh)
    for (let t = 1; t < MUSHROOM_MESH_RADIAL.length; t++) {
      meshes[t].push(buildMushroom(mushroomParams(v, seed + i * 101, t)))
    }
    const s = perSpecies.get(v.species)

    // The variant's own size, MEASURED off the built mesh (`spread` has no closed form), written back onto the record for the scatter's LOD arc.
    v.span = Math.max(mesh.userData.mushroom.height, mesh.userData.mushroom.spread)

    // The quad is the species' frame scaled to THIS variant's real height. The
    // ratio is applied to both extents, so the picture keeps the aspect it was
    // photographed at and only the size changes -- squashing the quad to each
    // variant's own aspect would stretch a shared photograph across it, and a
    // stretched cap is a worse artefact than a slightly wrong outline.
    //
    // It is 1.0 on every variant, because `buildMushroom` rescales to hit
    // `height` exactly and both builds asked for the same one. It stays because
    // the failure it prevents is silent: a mesh built shorter than the card cut
    // for it grows at the instant it crosses the band, and update() swaps
    // geometry ids with nothing to cross-dissolve it.
    const k = mesh.userData.mushroom.height / s.frameHeight

    // The card: the species' frame scaled to this variant, standing on y = 0 (litter-cards.js's cardPicture, spun).
    cards.push({ kind: 'spun', cx: 0, cy: (s.ext.height * k) / 2, hw: (s.ext.width * k) / 2, hh: (s.ext.height * k) / 2 })
  })

  const tiers = meshes.map((g) => ({ geometries: g }))

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
  return { tiers, cards, variants, bytes, triangles }
}

/**
 * Photograph one mushroom per SPECIES as flat albedo (the shared card's Lambert
 * lights it) into the atlas impostor layer, in place; the caller copies each
 * layer into its card picture. Call ONCE, with the same `seed` buildMushroomBank was
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
    const ext = bakeImpostor(renderer, geo, texArray, MUSHROOM_SPECIES[species].impostorLayer, { ...frame, unlit: true })
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
  return {
    // Per MESH TIER, finest first, because the two are separate bands in the
    // arena and a caller pricing "the mesh" has to say which one it means.
    mesh,
    meshTotal: mesh.reduce((a, b) => a + b, 0),
    variants: variants.length,
  }
}
