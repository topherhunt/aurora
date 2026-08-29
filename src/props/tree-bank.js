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
// FOUR TIERS, FINEST FIRST -- tier 0 is the one you stand under:
//
//   0  LOD0   the full tree, resolveTree's own numbers, root crown included.
//             480 triangles mean.
//   1  LOD1   the same tree with cheap wood: a 3-sided trunk and one flat fin
//             per limb, and FOLIAGE THAT IS BIT-IDENTICAL TO TIER 0's. 338
//             triangles mean, a 28% cut, all of it out of sticks.
//   2  cross  the impostor as THREE fixed planes. Six triangles.
//   3  card   the same impostor as ONE spun plane, and that plane is ONE
//             triangle: apex up for the pine, apex down for the three
//             broadleaves, which is the shape each species already is. Only
//             built when `billboard` is set; without it tier 2 is the last
//             tier.
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
// BOTH CARD TIERS ARE THE SAME PHOTOGRAPH, one baked texture layer per SPECIES,
// so the second tier costs geometry and nothing else -- no second bake, no
// duplicate layer, no extra texture memory.
//
// THE CROSS EARNS THE MIDDLE BAND AND THE BILLBOARD EARNS THE FAR ONE, and the
// split is about parallax against density. A cross is rotation-invariant
// because it carries three silhouettes and real depth between them; a billboard
// is one flat picture with no depth at all, which in a headset means no
// binocular disparity across its own surface -- it reads as a cutout at a fixed
// distance. So the cross goes where a tree is still big enough for that to
// matter, and the billboard takes the far field where it is not.
//
// The billboard is SIX times cheaper and that is why it cannot be the middle
// band's answer OR the far band's loss. At a forest -- tens of thousands of
// cards past the mid band -- the far tier IS the triangle budget, and 6 vs 1
// triangles there is the difference between a forest that fits and one that
// does not. In the mid band there are only a thousand or so trees, so the cross
// costs a few thousand triangles and buys back the depth.
//
// WHAT THE FAR CARD GIVES UP FOR THAT SIXTH is two corners of its photograph,
// and the argument for why a triangle is the right shape for a tree -- with the
// measured fraction of each species' silhouette it keeps -- is the `tri` note in
// impostor.js. `billboardTri` on each species record is where the up-or-down
// choice is made; it is a fact about the species' outline, not a taste knob.
//
// A ONE-PLANE CARD IS ONLY LEGAL IF SOMETHING TURNS IT, and material.js's
// billboardVertex is that something -- it spins the card about its own trunk in
// the VERTEX SHADER, so the turning costs no CPU, no second material and no
// per-frame matrix write, and the tier stays one draw call. It also looks
// better than a fixed cross seen from far away: it always presents the
// silhouette the photograph was actually taken from.
//
// HOW THE SHADER TELLS THE TWO CARD TIERS APART, given they share a layer: by
// the NORMAL, not by the vertex count -- billboardVertex never sees how many
// corners a geometry has. `upNormal` rides with `billboard`, so a card meant to
// be spun has an EXACTLY vertical normal, and it masks on `layer match AND
// normal.y > CARD_UP_MARK`. The cross wears canopy normals, which lean mostly
// up but top out at 0.876, comfortably under the 0.99 marker; buildImpostorCard
// asserts both sides of that rather than leaving it to be discovered when a
// forest starts rotating. It is why the cross tier needed no new vertex
// attribute and no duplicate impostor layer.
//
// `crownWidth` IS READ OFF TIER 0 AND USED FOR EVERY TIER, and it is exact
// rather than approximate: tier 1 measures the same crown to every digit, and
// both card tiers are framed on it. The impostor is a photograph OF that tree,
// so no tier can disagree with any other about how wide the crown is.
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
 * The layer list is NOT sufficient on its own, and deliberately so: both card
 * tiers wear the same impostor layer, and a three-plane cross spun about its
 * own axis is visibly wrong. The shader takes a second condition -- the vertex
 * normal, vertical only on the tier that wants spinning -- so the two tiers can
 * share a layer and a bake. See material.js's billboardVertex.
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
 * The CARD tiers arrive as quads with no pixels behind them. Their layers are
 * not photographed here because the bake needs a renderer and a loaded atlas,
 * and neither exists at construction -- see bakeTreeImpostors. Until that runs
 * the cards sample an empty layer and alphaTest discards them, so distant trees
 * fade in rather than flashing.
 */
export function buildTreeBank({ seed = 1, billboard = true } = {}) {
  const variants = treeVariants()
  const lod0 = []
  const lod1 = []
  const crosses = []
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

    // The card is framed on tier 0's measured crown, which is the tree the
    // impostor is a photograph OF and what bakeTreeImpostors points its camera
    // at.
    const u = g0.userData.tree
    const ext = impostorCardExtents({ width: u.crownWidth, height: u.height })
    // The CROSS tier: three fixed planes wearing CANOPY normals, which fan out
    // and up from the trunk axis so that a crown reads as a blob rather than as
    // three slabs meeting at a line. `canopy` is what makes a crossed tree look
    // like a tree instead of like three quads -- the long version is the normal
    // note in impostor.js. It also keeps this quad below CARD_UP_MARK, which is
    // what tells material.js's billboardVertex to leave it ALONE even though it
    // wears the same impostor layer the billboard does.
    crosses.push(buildImpostorCard(ext.width, ext.height, v.impostorLayer, 3, { canopy: true }))

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
    if (billboard) {
      // A missing `billboardTri` would quietly fall back to a quad and double
      // the far band's bill, which is the one number nobody would notice going
      // wrong. A new species has to say which way up its outline is.
      if (!v.billboardTri) {
        throw new Error(`buildTreeBank: ${v.species} has no billboardTri`)
      }
      cards.push(buildImpostorCard(ext.width, ext.height, v.impostorLayer, 1,
        { upNormal: true, tri: v.billboardTri }))
    }
  })

  // Four tiers when the far one is a billboard, three when it is not -- without
  // a vertex shader to turn it, a one-plane card is not a tier anyone can ship,
  // so the cross IS the last tier. Same photograph either way: both card tiers
  // hang on the species' one impostor layer and neither costs a second bake.
  const tiers = [{ geometries: lod0 }, { geometries: lod1 }, { geometries: crosses }]
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
    })
    geo.dispose()
    done.push({ species, layer: v.impostorLayer, ...ext })
  }
  return done
}
