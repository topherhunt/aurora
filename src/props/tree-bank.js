import THREE from '../three-instance.js'

import { buildTree, treeLod, TREE_DEFAULTS, TREE_SPECIES } from './tree.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'

// ---------------------------------------------------------------------------
// The tree variant bank: every tree mesh in the world, baked once at load.
//
// Same policy as fern-bank.js and for the same reasons: THERE IS NO OFFLINE
// BAKE STEP AND THERE SHOULD NOT BE. This runs at construction and hands its
// geometries straight to the InstancedMeshes that draw them.
// An asset file on disk would buy nothing and cost a build step, a cache to
// invalidate and a way for the mesh to disagree with the generator.
//
// ONE VARIANT PER SPECIES, at that species' own default height -- 9 m for pine
// and oak, 6 m for birch and aspen. Each instance then picks a species, a yaw
// and a size multiplier on the MATRIX (trees.js SCALE, 0.5 to 1.5), so the
// trees a player sees outnumber the four meshes stored by a long way.
//
// IT USED TO BE A CROSS PRODUCT, species x size, with a four-rung height ladder
// that REGENERATED each tree rather than scaling it -- so a sapling had a
// sapling's whorl count and life-sized needles. Sixteen variants times four
// tiers is 64 geometries, which is 64 InstancedMeshes' worth of arena under the
// ladder trees.js now draws (see its header): the Quest 2 wants few, fat
// instanced draws, and a bank that fine splinters the forest into thin ones. So
// the size ladder moved onto the instance matrix, and what it costs is that a
// half-size tree now has half-size leaves instead of a young tree's leaves.
// That reads at arm's length on the one tree you are standing under and nowhere
// else; four species times four tiers is the trade.
//
// THREE TIERS, FINEST FIRST -- tier 0 is the one you stand under:
//
//   0  LOD0   the full tree, resolveTree's own numbers, root crown included.
//             480 triangles mean.
//   1  LOD1   the same tree with cheap wood: a 3-sided trunk and one flat fin
//             per limb, and FOLIAGE THAT IS BIT-IDENTICAL TO TIER 0's. 338
//             triangles mean, a 28% cut, all of it out of sticks.
//   2  card   the impostor as ONE spun plane, and that plane is ONE triangle:
//             apex up for the pine, apex down for the three broadleaves, which
//             is the shape each species already is. Only built when `billboard`
//             is set; without it tier 1 is the last tier and the bank is a
//             mesh-only ladder.
//
// THE TWO MESH TIERS ARE THE SAME TREE AND THAT IS LITERAL HERE, not a claim
// about silhouettes. They are built from one seed through one rng stream, and
// tier 1 changes only `trunkSides`, `branchSides` and `roots`, so every card in
// the crown is the same card in the same seat at the same size. The root crown
// tier 1 drops is wood at the foot, drawn from its own rng stream and reaching
// nowhere near the crown, so dropping it moves no other part of the tree.
// Measured over all four variants, the two tiers agree on height and crown
// width to every digit printed. Nothing pops at the boundary except branches
// losing their barrel.
//
// A CHEAPER LOD1 EXISTED AND WAS WITHDRAWN. The same two wood cuts, but with
// the crown thrown as a bundle of twenty big tiled triangles (`bundleTris`),
// which took the tier to ~130 triangles and held 10 to 45 m. It did not look
// like a tree there. Cheap and well-nested is not the same as convincing. The
// bundle is still in tree.js and no tier asks for it.
//
// ONE CARD TIER, AND THERE USED TO BE TWO. A three-plane CROSS held 22.5-100 m
// and the billboard took everything past it, on the argument that a cross
// carries real depth between its planes where a flat card carries none. The
// measurement that retired it: three untrimmed quads is 3.0 rectangles of shaded
// area against the billboard's ~0.52, and on the headset that mid band was HALF
// the forest's fill on four percent of its instances, for eight of its draw
// calls. What it was buying is worth less than it sounds -- stereo acuity of
// half an arcminute over a 65 mm baseline resolves about 1.3 m of depth at 24 m
// and 5.6 m at 50 m, so a crown 3 to 6 m deep reads flat over most of the range
// the cross was covering anyway. It is 6 draws' worth of geometry in
// buildImpostorCard still (`planes: 3, canopy: true`) if a mid rung is ever
// wanted back; ferns and rocks use the same call.
//
// WHAT THE CARD GIVES UP FOR ITS SIXTH OF THE FILL is two corners of its
// photograph, and the argument for why a triangle is the right shape for a tree
// -- with the measured fraction of each species' silhouette it keeps, and the
// SINK that keeps an apex-down card from standing on its point -- is the `tri`
// note in impostor.js. `billboardTri` on each species record is where the
// up-or-down choice is made; it is a fact about the species' outline, not a
// taste knob.
//
// A ONE-PLANE CARD IS ONLY LEGAL IF SOMETHING TURNS IT, and material.js's
// billboardVertex is that something -- it spins the card about its own trunk in
// the VERTEX SHADER, so the turning costs no CPU, no second material and no
// per-frame matrix write, and the tier stays one draw call. It also looks better
// than a fixed cross seen from far away: it always presents the silhouette the
// photograph was actually taken from.
//
// HOW THE SHADER KNOWS TO SPIN IT: by the NORMAL, not by the vertex count --
// billboardVertex never sees how many corners a geometry has. `upNormal` rides
// with `billboard`, so a card meant to be spun has an EXACTLY vertical normal,
// and the shader masks on `layer match AND normal.y > CARD_UP_MARK`. Every other
// normal buildImpostorCard authors stays under that 0.99 marker by construction
// and it asserts both sides of it, which is what let the cross share this tier's
// layer and bake for as long as it existed.
//
// `crownWidth` IS READ OFF TIER 0 AND USED FOR EVERY TIER, and it is exact
// rather than approximate: tier 1 measures the same crown to every digit, and
// the card is framed on it. The impostor is a photograph OF that tree, so no
// tier can disagree with any other about how wide the crown is.
// ---------------------------------------------------------------------------

/**
 * Every species, once, at its own default height, in a stable order. An index
 * into this is a variant id.
 *
 * The height is the species' OWN `params.height` and never a multiplier on it:
 * pine and oak state 9 m, birch and aspen 6 m, and a placed tree's size comes
 * off the instance matrix instead.
 */
export function treeVariants() {
  return Object.keys(TREE_SPECIES).map((species) => {
    const sp = TREE_SPECIES[species]
    const base = { ...TREE_DEFAULTS, ...sp.params }
    return {
      species,
      height: base.height,
      impostorLayer: sp.impostorLayer,
      leafLayer: sp.leafLayer,
      barkLayer: sp.barkLayer,
      billboardTri: sp.billboardTri,
    }
  })
}

/**
 * What to CALL one variant, which is now just its species.
 *
 * A variant id is an index into `treeVariants()`, and "tree 3" tells you
 * nothing about which tree it is -- the readout in /v2 exists so that "that
 * tree is wrong" can be said about a tree somebody can then go and look at.
 * With one variant per species the species IS the whole name; the size a given
 * tree happens to be drawn at is on its matrix and is not a bank member.
 */
export function treeVariantId(v) {
  if (!TREE_SPECIES[v.species]) throw new Error(`treeVariantId: ${v.species} is not a species`)
  return v.species
}

/**
 * The impostor texture layers, one per species, de-duplicated.
 *
 * This is the list `createPropMaterial({ billboardLayers })` keys on to decide
 * which geometries in the batch its vertex shader spins toward the eye. It is
 * layers rather than geometry ids because the shader can only see a vertex
 * attribute, and `texLayer` is the one every prop in the project already
 * carries -- one prop material serves ferns, rocks and trees, so a dedicated
 * `isBillboard` attribute would be a change to every generator in the project.
 *
 * The layer list is NOT sufficient on its own, and deliberately so: a fixed card
 * spun about its own axis is visibly wrong, and this array is also where the
 * bake rig's own subjects live. The shader takes a second condition -- the
 * vertex normal, vertical only on a card that wants spinning -- so a fixed card
 * and a spun one can share a layer and a bake. See material.js's
 * billboardVertex.
 */
export function treeImpostorLayers() {
  return [...new Set(Object.keys(TREE_SPECIES).map((s) => TREE_SPECIES[s].impostorLayer))]
}

/** The full parameter set for one variant, ready for buildTree or treeLod. */
function paramsFor(v, seed) {
  const sp = TREE_SPECIES[v.species]
  return {
    ...TREE_DEFAULTS,
    ...sp.params,
    leafLayer: v.leafLayer,
    barkLayer: v.barkLayer,
    height: v.height,
    seed,
  }
}

// How much fatter the bark gets than the mean. `trunkDiameter` on a built tree
// is the MEAN diameter at the foot and `trunkLobe` takes the skin to roughly
// this much of it, so a card framed against the mean would leave the fat side of
// the trunk hanging outside its own silhouette.
const TRUNK_LOBE = 1.11

/**
 * The width a species' card has to keep where the tree stands, which is its
 * trunk for an apex-down triangle and nothing at all for anything else -- an
 * apex-up card is already full width on the ground and a quad always is.
 *
 * Every caller MUST agree on this to the last texel: one builds the geometry and
 * one takes the photograph, and impostorCardExtents turns it into the same sink
 * for both. Disagree and the picture slides up or down the card. Exported for
 * gen-tree.html, which frames its own card off the tree on its stage and would
 * otherwise be a second copy of this line.
 */
export function cardFoot(u, billboardTri) {
  return billboardTri === 'down' ? u.trunkDiameter * TRUNK_LOBE : 0
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

/**
 * Bake the whole bank.
 *
 * Returns `{ tiers, variants, bytes, triangles }`, where `tiers[t].geometries[v]`
 * is the geometry for tier `t` and variant `v`. Every tier is the same length,
 * so a band index and a variant id are independent lookups.
 *
 * The caller owns the geometries and must dispose them when it tears down.
 * Each one becomes the geometry of an InstancedMesh and is NOT copied, so
 * disposing one that is still in the scene deletes the buffers out from under
 * a live draw.
 *
 * The CARD tier arrives with no pixels behind it. Its layers are not
 * photographed here because the bake needs a renderer and a loaded atlas, and
 * neither exists at construction -- see bakeTreeImpostors. Until that runs the
 * cards sample an empty layer and alphaTest discards them, so distant trees fade
 * in rather than flashing.
 */
export function buildTreeBank({ seed = 1, billboard = true } = {}) {
  const variants = treeVariants()
  const lod0 = []
  const lod1 = []
  const cards = []

  variants.forEach((v, i) => {
    // One seed per variant, spread rather than consecutive so two species do
    // not walk neighbouring rng streams and grow correlated crowns.
    const p = paramsFor(v, seed + i * 101)
    const g0 = buildTree(p)
    lod0.push(g0)

    // The SAME tree with cheap wood -- see treeLod. Same seed, so buildTree
    // walks the identical rng stream and the crown that comes out is not merely
    // the same size, it is the same cards in the same seats.
    lod1.push(buildTree(treeLod(p, 1)))

    // The card is framed on tier 0's measured crown AND on its measured trunk,
    // which is the tree the impostor is a photograph OF and what
    // bakeTreeImpostors points its camera at.
    const u = g0.userData.tree

    // `upNormal` rides with `billboard` deliberately: a quad that turns toward
    // the eye must NOT also turn its normal, or N.L becomes a function of where
    // the player stands and the whole forest brightens and dims as they turn on
    // the spot. A vertical normal is stable and, for a canopy seen from 30 m
    // out, closer to true anyway. Same call and same reasoning as
    // fernCardGeometries. The roundness the cross gets from `canopy` this tier
    // gets from the photograph instead -- the bake is lit, so the crown's own
    // interior shading is in the texture. See impostor.js on why the billboard
    // does not simply take the fan as well.
    //
    // `tri` is what makes this tier one triangle rather than two, and the
    // species picks which way up. It is asked for by name rather than defaulted
    // on, because the same function builds the fern billboard, which is a
    // ROSETTE and has no corner it can spare.
    //
    // `sink` is the other half of `tri`, and comes out of the same call that
    // sized the card: an apex-down triangle hangs below the ground so that it
    // still has the trunk's width where the trunk is. bakeTreeImpostors asks
    // `cardFoot` the same question so the photograph is framed on the same
    // strip.
    if (billboard) {
      // A missing `billboardTri` would quietly fall back to a quad and double
      // the far band's bill, which is the one number nobody would notice going
      // wrong. A new species has to say which way up its outline is.
      if (!v.billboardTri) {
        throw new Error(`buildTreeBank: ${v.species} has no billboardTri`)
      }
      const ext = impostorCardExtents({
        width: u.crownWidth, height: u.height, foot: cardFoot(u, v.billboardTri),
      })
      cards.push(buildImpostorCard(ext.width, ext.height, v.impostorLayer, 1,
        { upNormal: true, tri: v.billboardTri, sink: ext.sink }))
    }
  })

  // Three tiers when the far one is a billboard, two when it is not -- without a
  // vertex shader to turn it, a one-plane card is not a tier anyone can ship, so
  // LOD1 IS the last tier and the ladder is mesh all the way out.
  const tiers = [{ geometries: lod0 }, { geometries: lod1 }]
  if (billboard) tiers.push({ geometries: cards })
  let bytes = 0
  let triangles = 0
  for (const t of tiers) {
    t.triangles = t.geometries.map((g) => g.index.count / 3)
    for (const g of t.geometries) {
      bytes += geometryBytes(g)
      triangles += g.index.count / 3
    }
  }
  return { tiers, variants, bytes, triangles }
}

/**
 * Photograph one tree per SPECIES into the impostor layer its cards already
 * point at. Call ONCE, after `loadImageLayers()` has resolved -- before that
 * the tree has no bark or leaf texture and the picture would be of nothing.
 *
 * Four ortho renders at 512^2, four 1 MB readbacks and the downsample, and
 * `readRenderTargetPixels` stalls the pipeline for each -- so this is a
 * deliberate one-off hitch at load rather than anything the frame loop does.
 *
 * ONE LAYER PER SPECIES, which is now also one layer per variant. A placed
 * tree's size is a uniform scale on its matrix, so the photograph is stretched
 * evenly with the card and stays exact at every size in the range.
 */
export function bakeTreeImpostors(renderer, texArray, { seed = 1 } = {}) {
  const variants = treeVariants()
  const done = []
  for (const species of Object.keys(TREE_SPECIES)) {
    const i = variants.findIndex((v) => v.species === species)
    if (i < 0) throw new Error(`bakeTreeImpostors: no variant for ${species}`)
    const v = variants[i]
    const geo = buildTree(paramsFor(v, seed + i * 101))
    const u = geo.userData.tree
    const ext = bakeImpostor(renderer, geo, texArray, v.impostorLayer, {
      width: u.crownWidth,
      height: u.height,
      // The same strip of empty ground the card's apex hangs into. Framed here
      // and not just in the geometry, or the picture sits `sink` too high on it.
      foot: cardFoot(u, v.billboardTri),
    })
    geo.dispose()
    done.push({ species, layer: v.impostorLayer, ...ext })
  }
  return done
}
