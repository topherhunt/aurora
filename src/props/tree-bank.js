import * as THREE from 'three'

import { buildTree, treeLod, TREE_DEFAULTS, TREE_SPECIES } from './tree.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'

// ---------------------------------------------------------------------------
// The tree variant bank: every tree mesh in the world, baked once at load.
//
// Same policy as fern-bank.js and for the same reasons: THERE IS NO OFFLINE
// BAKE STEP AND THERE SHOULD NOT BE. This runs at construction, hands its
// geometries to BatchedMesh.addGeometry(), and then the caller disposes them.
// An asset file on disk would buy nothing and cost a build step, a cache to
// invalidate and a way for the mesh to disagree with the generator.
//
// The bank is a CROSS PRODUCT: species x size x tier. Each instance then picks
// a variant and a yaw, so the trees a player sees outnumber the meshes stored.
//
// FOUR TIERS, FINEST FIRST -- tier 0 is the one you stand under:
//
//   0  LOD0   the full tree, resolveTree's own numbers. 470 triangles mean.
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
// tier 1 changes only `trunkSides` and `branchSides`, so every card in the
// crown is the same card in the same seat at the same size. Measured over all
// 16 variants, the two tiers agree on height and crown width to every digit
// printed. Nothing pops at the boundary except branches losing their barrel.
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
// per-frame matrix write, and the batch stays one draw call. It also looks
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

// Height multipliers on each species' own default. Not a scale: the tree is
// REGENERATED at each height, and tree.js's density law gives a short tree
// fewer branches and sprays rather than shrunken ones. That law is the whole
// reason a multiplier this small is allowed: 0.33 does not build a 12 m pine
// shrunk to 3 m, which would read as a toy, it builds a sapling with a
// sapling's number of whorls on it (pine 792 triangles -> 452, oak 516 -> 252).
//
// THE SAPLING IS A QUARTER OF THE FOREST, because trees.js picks a variant
// uniformly and there are four sizes. That is the one number to turn if it
// reads as too many: a weighted pick in the placement loop, not a change here.
// It costs less than its share of triangles either way, a sapling mesh being
// roughly half the price of the mean tree.
//
// The absolute heights differ by species, since these multiply the species'
// own default: 0.33 is a 3.0 m pine or oak and a 2.0 m birch or aspen.
export const TREE_SIZES = [0.33, 0.78, 1.0, 1.34]

/** Every species x size combination, in a stable order. Index into this is a variant id. */
export function treeVariants() {
  const out = []
  for (const species of Object.keys(TREE_SPECIES)) {
    const sp = TREE_SPECIES[species]
    const base = { ...TREE_DEFAULTS, ...sp.params }
    for (const size of TREE_SIZES) {
      out.push({
        species,
        size,
        height: base.height * size,
        impostorLayer: sp.impostorLayer,
        leafLayer: sp.leafLayer,
        barkLayer: sp.barkLayer,
        billboardTri: sp.billboardTri,
      })
    }
  }
  return out
}

/**
 * The impostor texture layers, one per species, de-duplicated.
 *
 * This is the list `createPropMaterial({ billboardLayers })` keys on to decide
 * which geometries in the batch its vertex shader spins toward the eye. It is
 * layers rather than geometry ids because the shader can only see a vertex
 * attribute, and `texLayer` is the one every prop in the project already
 * carries -- BatchedMesh throws if a geometry entering the arena is missing an
 * attribute the arena has, so a dedicated `isBillboard` attribute would be a
 * change to every generator in the project.
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
 * The caller owns the geometries and MUST dispose them once they are in the
 * batch -- BatchedMesh copies the vertex data into its arena, so holding the
 * originals just doubles the memory.
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
    // One seed per VARIANT, not per species: two sizes of the same species
    // should not be the same tree at two scales.
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
 * ONE LAYER PER SPECIES, not per variant. The card geometry carries its own
 * width and height, so a small pine and a large one wear the same photograph at
 * two sizes. That is a real approximation and not just a saving: because the
 * density law regenerates rather than scales, a 7 m pine's crown-to-height
 * ratio is not quite a 12 m pine's, so the picture is stretched by that
 * difference. At the range a card is used it is well under a pixel.
 */
export function bakeTreeImpostors(renderer, texArray, { seed = 1 } = {}) {
  const variants = treeVariants()
  const done = []
  for (const species of Object.keys(TREE_SPECIES)) {
    // The size-1.0 variant is the one that gets photographed: it sits in the
    // middle of the range the card is stretched across.
    const i = variants.findIndex((v) => v.species === species && v.size === 1.0)
    if (i < 0) throw new Error(`bakeTreeImpostors: no size-1.0 variant for ${species}`)
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
