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
//   0  LOD0   the full tree, resolveTree's own numbers
//   1  LOD1   treeLod(p, 1): trunkSides 3, branchSides 1, cardTris 1, half the
//             sprays. Roughly a quarter of LOD0's triangles.
//   2  cross  the impostor as THREE fixed planes. Six triangles.
//   3  card   the same impostor as ONE spun plane. Two triangles. Only built
//             when `billboard` is set; without it tier 2 is the last tier.
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
// The billboard is three times cheaper and that is why it cannot be the middle
// band's answer OR the far band's loss. At a forest -- tens of thousands of
// cards past the mid band -- the far tier IS the triangle budget, and 6 vs 2
// triangles there is the difference between a forest that fits and one that
// does not. In the mid band there are only a thousand or so trees, so the cross
// costs a few thousand triangles and buys back the depth.
//
// A ONE-PLANE CARD IS ONLY LEGAL IF SOMETHING TURNS IT, and material.js's
// billboardVertex is that something -- it spins the quad about its own trunk in
// the VERTEX SHADER, so the turning costs no CPU, no second material and no
// per-frame matrix write, and the batch stays one draw call. It also looks
// better than a fixed cross seen from far away: it always presents the
// silhouette the photograph was actually taken from.
//
// HOW THE SHADER TELLS THE TWO CARD TIERS APART, given they share a layer: by
// the NORMAL. `upNormal` rides with `billboard`, so a quad meant to be spun has
// an EXACTLY vertical normal, and billboardVertex masks on `layer match AND
// normal.y > CARD_UP_MARK`. The cross wears canopy normals, which lean mostly
// up but top out at 0.876, comfortably under the 0.99 marker; buildImpostorCard
// asserts both sides of that rather than leaving it to be discovered when a
// forest starts rotating. It is why the cross tier needed no new vertex
// attribute and no duplicate impostor layer.
//
// KNOWN AND ACCEPTED: LOD0 AND LOD1 ARE NOT THE SAME TREE, so the swap pops.
// tree.js draws every random number from one stream (`mulberry32(p.seed)`), and
// LOD1 halves `sprays`, which changes how many draws the spray loop consumes
// before branch azimuths are drawn. Every limb after the first therefore lands
// somewhere else. Measured crown extents, seed 7:
//
//   pine   LOD0 5.32 x 4.92    LOD1 5.28 x 5.06
//   oak    LOD0 6.96 x 6.45    LOD1 6.75 x 6.64
//   birch  LOD0 4.53 x 4.20    LOD1 5.38 x 5.17
//   aspen  LOD0 3.41 x 4.10    LOD1 4.96 x 4.54   <- 45% wider, the worst case
//
// THE FIX, when it is worth doing: seed each limb independently rather than
// sharing one stream, so a limb's draws cannot depend on what earlier limbs
// consumed. In buildTree, replace the single `rand` with a per-limb generator
// keyed off the limb index -- `mulberry32(p.seed * 0x9e3779b1 + limbIndex)` --
// and give the trunk and the apex sprays their own fixed keys. Then LOD1 is
// LOD0 with sprays removed rather than a different tree, tiers nest, and the
// band swap stops popping. It is contained to tree.js and needs no change here
// beyond re-measuring the table above. See also `crownWidth` below, which is
// read off tier 0 and would then be the same for every tier.
// ---------------------------------------------------------------------------

// Height multipliers on each species' own default. Not a scale: the tree is
// REGENERATED at each height, and tree.js's density law gives a short tree
// fewer branches and sprays rather than shrunken ones. Three is enough because
// yaw and species already carry most of the visible variety.
export const TREE_SIZES = [0.78, 1.0, 1.34]

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
    lod1.push(buildTree(treeLod(p, 1)))

    // The card is framed on tier 0's measured crown, which is the tree the
    // impostor is a photograph OF. See the LOD-nesting note above for why tier
    // 1's crown does not match; the card follows tier 0 because that is what
    // bakeTreeImpostors points its camera at.
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
    if (billboard) {
      cards.push(buildImpostorCard(ext.width, ext.height, v.impostorLayer, 1, { upNormal: true }))
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
