import THREE from '../three-instance.js'

import { LAYER } from '../textures.js'
import { buildTreeV8, treeV8Lod, treeV8Species, HEM_FRAY } from './tree-v8.js'
import { buildTreeOak, treeOakLod, treeOakSpecies } from './tree-oak.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'

// ---------------------------------------------------------------------------
// The tree variant bank: every tree mesh in the world, baked once at load.
//
// Same policy as fern-bank.js and for the same reasons: THERE IS NO OFFLINE
// BAKE STEP AND THERE SHOULD NOT BE. This runs at construction and hands its
// geometries straight to the InstancedMeshes that draw them. An asset file on
// disk would buy nothing and cost a build step, a cache to invalidate and a
// way for the mesh to disagree with the generator.
//
// TWO GENERATORS, ONE BANK. The pine is tree-v8.js's -- a stack of whorls,
// each broken into boughs -- and the three broadleaves are tree-oak.js's, a
// bole of crooked limbs under a litter of scoops. Each species is built at
// its generator's own tuned parameters and seed, which is the tree that was
// signed off on the /gen-tree-v8 bench; the bank takes no seed of its own,
// since a re-rolled tree would be one nobody has looked at. ONE VARIANT PER
// PLANTED SPECIES (TREE_BANK_SPECIES) at that species' own height, and each
// instance picks a variant, a yaw and a size multiplier on the MATRIX
// (trees.js SCALE), so the trees a player sees outnumber the meshes stored by
// a long way.
//
// EACH GENERATOR HANDS OVER TWO GEOMETRIES -- the wood in createPropMaterial's
// `{position, normal, uvProj, texLayer}` and the crown in a mapped Lambert's
// `{position, normal, uv, color}` over its species' mat -- and the bank welds
// them into ONE in the prop layout with `color` and `hem` on both: the crown's
// `uv` is the tile coordinate the array's RepeatWrapping already understands,
// its mat is a layer of the array (LAYER.MAT_*), and wood that carries no
// baked shade takes white. One geometry a tier, so the arena stays one
// material and one program with every other prop -- textures.js's "adding a
// species means adding a layer, not a material". The baked occlusion in
// `color` is why trees.js asks the material for `vertexColors`, and `hem` is
// why it asks for `hemFray`.
//
// THREE TIERS, FINEST FIRST -- tier 0 is the one you stand under:
//
//   0  LOD0   the generator's full tree. A species with a `nearMat` wears it
//             here and ONLY here -- the pine's is its mat with holes cut in it
//             -- and carries its crown's own `hem` so the material can fray
//             the edge of every bough. No other tier is a cutout: past 8 m a
//             hole in a bough is a hole in the tree, and the alpha-tested
//             rim would shimmer at every step.
//   1  LOD1   the generator's own LOD1: the pine keeps every bough and drops a
//             station from each; a broadleaf keeps every scoop as two
//             triangles on LOD0's own corners and straightens its wood to one
//             five-sided segment a tube. Both are the SAME tree walked from the
//             same seed, so nothing moves at the switch.
//   2  card   the impostor as ONE spun plane, and that plane is ONE triangle:
//             apex up for the pine, apex down for the three broadleaves, which
//             is the shape each species already is. Only built when
//             `billboard` is set; without it tier 1 is the last tier.
//
// Both generators also carry an LOD2 that thins the crown; the world's ladder
// (trees.js LOD_BANDS) has two mesh bands and does not ask for it.
//
// THE CARD. Why one triangle is the right shape for a tree, with the measured
// fraction of each silhouette it keeps and the SINK that keeps an apex-down
// card from standing on its point, is the `tri` note in impostor.js.
// `billboardTri` on each species record is a fact about the species' outline,
// not a taste knob. A one-plane card is only legal because material.js's
// billboardVertex spins it about its own trunk in the VERTEX SHADER, and the
// shader knows to by the NORMAL: `upNormal` rides with `billboard`, so a card
// meant to be spun has an EXACTLY vertical normal and the shader masks on
// `layer match AND normal.y > CARD_UP_MARK`.
//
// `crownWidth`, `height` and `trunkDiameter` ARE READ OFF TIER 0 AND USED FOR
// EVERY TIER: the card is framed on them and the impostor is a photograph OF
// that tree -- the near tier as you stand under it, holed mat and frayed hems
// -- so no tier can disagree with any other about how wide it is.
// ---------------------------------------------------------------------------

/**
 * The species the bank knows, in a stable order. `generator` names which
 * builder grows it, `matLayer` the array layer its crown is tiled from, and
 * `nearMat` the holed one the near tier wears instead, if it has one -- the
 * hem fray rides with it, so a species without a `nearMat` is solid to the
 * edge at every tier.
 *
 * ONLY THE `planted` ONES ARE BUILT: the world is a pine forest until the
 * broadleaf crowns look right, so the three scoop species stay here, ready,
 * and cost no geometry, no mesh and no bake. An index into `treeVariants()`,
 * the planted subset, is a variant id.
 */
export const TREE_BANK_SPECIES = {
  pine: { generator: 'v8', matLayer: LAYER.MAT_PINE, nearMat: LAYER.MAT_PINE_ALPHA, impostorLayer: LAYER.IMPOSTOR_PINE, billboardTri: 'up', planted: true },
  oak: { generator: 'oak', matLayer: LAYER.MAT_OAK, nearMat: null, impostorLayer: LAYER.IMPOSTOR_OAK, billboardTri: 'down', planted: false },
  birch: { generator: 'oak', matLayer: LAYER.MAT_BIRCH, nearMat: null, impostorLayer: LAYER.IMPOSTOR_BIRCH, billboardTri: 'down', planted: false },
  aspen: { generator: 'oak', matLayer: LAYER.MAT_ASPEN, nearMat: null, impostorLayer: LAYER.IMPOSTOR_ASPEN, billboardTri: 'down', planted: false },
}

/** The species the world plants, in table order. */
export const plantedSpecies = () => Object.keys(TREE_BANK_SPECIES).filter((s) => TREE_BANK_SPECIES[s].planted)

const GENERATORS = {
  v8: { species: treeV8Species, lod: treeV8Lod, build: buildTreeV8 },
  oak: { species: treeOakSpecies, lod: treeOakLod, build: buildTreeOak },
}

/**
 * Every planted species, once, at its own default height, in table order. An
 * index into this is a variant id.
 *
 * The height is the species' OWN and never a multiplier on it: a placed tree's
 * size comes off the instance matrix instead.
 */
export function treeVariants() {
  return plantedSpecies().map((species) => {
    const sp = TREE_BANK_SPECIES[species]
    const gen = GENERATORS[sp.generator]
    if (!gen) throw new Error(`treeVariants: ${species} names no generator "${sp.generator}"`)
    return {
      species,
      height: gen.species(species).height,
      impostorLayer: sp.impostorLayer,
      matLayer: sp.matLayer,
      billboardTri: sp.billboardTri,
    }
  })
}

/**
 * What to CALL one variant, which is its species. A variant id is an index
 * into `treeVariants()`, and "tree 3" tells you nothing about which tree it
 * is -- the readout in /v2 exists so that "that tree is wrong" can be said
 * about a tree somebody can then go and look at.
 */
export function treeVariantId(v) {
  if (!TREE_BANK_SPECIES[v.species]) throw new Error(`treeVariantId: ${v.species} is not a species`)
  return v.species
}

/**
 * The impostor texture layers, one per planted species, de-duplicated.
 *
 * This is the list `createPropMaterial({ billboardLayers })` keys on to decide
 * which geometries in the batch its vertex shader spins toward the eye. It is
 * layers rather than geometry ids because the shader can only see a vertex
 * attribute, and `texLayer` is the one every prop in the project already
 * carries. The layer list is NOT sufficient on its own: the shader takes a
 * second condition, the vertex normal, vertical only on a card that wants
 * spinning. See material.js's billboardVertex.
 */
export function treeImpostorLayers() {
  return [...new Set(plantedSpecies().map((s) => TREE_BANK_SPECIES[s].impostorLayer))]
}

/** One species' mesh tier, as its generator hands it over: `{ trunk, foliage, stats }`. */
function grow(species, tier) {
  const sp = TREE_BANK_SPECIES[species]
  const gen = GENERATORS[sp.generator]
  return gen.build(gen.lod(gen.species(species), tier))
}

/** A `count`-long run of `value` for a one-float attribute. */
const runOf = (count, value) => new Float32Array(count).fill(value)

/**
 * Weld a generator's two geometries into one in the prop layout, `color` and
 * `hem` included -- see the header. `near` is the tier you stand under: a
 * species with a `nearMat` tiles its crown from that and keeps the crown's own
 * `hem`; every other weld is solid to the edge, with hem 0 throughout. Returns
 * a fresh geometry and disposes neither input; the caller owns all three.
 */
function weldTree(species, { trunk, foliage, stats }, { near }) {
  const need = (geo, name, ...attrs) => {
    if (!geo.index) throw new Error(`weldTree: ${species} ${name} is not indexed`)
    for (const a of attrs) {
      if (!geo.attributes[a]) throw new Error(`weldTree: ${species} ${name} carries no ${a}`)
    }
  }
  need(trunk, 'wood', 'position', 'normal', 'uvProj', 'texLayer')
  need(foliage, 'crown', 'position', 'normal', 'uv', 'color')
  const sp = TREE_BANK_SPECIES[species]
  const frayed = near && sp.nearMat !== null
  if (frayed) need(foliage, 'crown', 'hem')
  const nw = trunk.attributes.position.count
  const nc = foliage.attributes.position.count

  const cat = (a, b, size) => {
    const out = new Float32Array((nw + nc) * size)
    out.set(a, 0)
    out.set(b, nw * size)
    return new THREE.BufferAttribute(out, size)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', cat(trunk.attributes.position.array, foliage.attributes.position.array, 3))
  geo.setAttribute('normal', cat(trunk.attributes.normal.array, foliage.attributes.normal.array, 3))
  geo.setAttribute('uvProj', cat(trunk.attributes.uvProj.array, foliage.attributes.uv.array, 2))
  geo.setAttribute('texLayer', cat(trunk.attributes.texLayer.array, runOf(nc, frayed ? sp.nearMat : sp.matLayer), 1))
  const woodShade = trunk.attributes.color ? trunk.attributes.color.array : runOf(nw * 3, 1)
  geo.setAttribute('color', cat(woodShade, foliage.attributes.color.array, 3))
  geo.setAttribute('hem', cat(runOf(nw, 0), frayed ? foliage.attributes.hem.array : runOf(nc, 0), 1))

  const index = new Uint32Array(trunk.index.count + foliage.index.count)
  index.set(trunk.index.array, 0)
  for (let i = 0; i < foliage.index.count; i++) index[trunk.index.count + i] = foliage.index.array[i] + nw
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  // The four numbers trees.js reads for the pick silhouette and the card's
  // frame, and the trunk's ring profile the spiders cling to. `firstBranchHeight`
  // is where the crown starts: the lowest scoop or bough, since that is what the
  // cursor can hit.
  for (const k of ['height', 'crownWidth', 'trunkDiameter', 'crownBase']) {
    if (!(stats[k] > 0)) throw new Error(`weldTree: ${species} publishes no usable ${k} (${stats[k]})`)
  }
  if (!stats.trunkProfile || !(stats.trunkProfile.sides >= 3)) throw new Error(`weldTree: ${species} publishes no trunkProfile`)
  geo.userData.tree = {
    height: stats.height,
    crownWidth: stats.crownWidth,
    trunkDiameter: stats.trunkDiameter,
    firstBranchHeight: stats.crownBase,
    belowGround: stats.belowGround,
    triangles: stats.triangles,
    trunkProfile: stats.trunkProfile,
  }
  return geo
}

/**
 * One mesh tier of one species, welded; the generator's own buffers are let
 * go. `near` defaults to tier 0 being the tier you stand under, which is the
 * tree the bake photographs too.
 */
function buildTier(species, tier, { near = tier === 0 } = {}) {
  const built = grow(species, tier)
  const geo = weldTree(species, built, { near })
  built.trunk.dispose()
  built.foliage.dispose()
  return geo
}

// How much fatter the bark gets than the mean. `trunkDiameter` on a built tree
// is the MEAN diameter at the foot and the trunk's lobing takes the skin to
// roughly this much of it, so a card framed against the mean would leave the
// fat side of the trunk hanging outside its own silhouette.
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
export function buildTreeBank({ billboard = true } = {}) {
  const variants = treeVariants()
  const lod0 = []
  const lod1 = []
  const cards = []

  for (const v of variants) {
    const g0 = buildTier(v.species, 0)
    lod0.push(g0)
    lod1.push(buildTier(v.species, 1))

    // The card is framed on tier 0's measured crown AND on its measured trunk,
    // which is the tree the impostor is a photograph OF and what
    // bakeTreeImpostors points its camera at.
    const u = g0.userData.tree

    // `upNormal` rides with `billboard` deliberately: a quad that turns toward
    // the eye must NOT also turn its normal, or N.L becomes a function of where
    // the player stands and the whole forest brightens and dims as they turn on
    // the spot. A vertical normal is stable and, for a canopy seen from 30 m
    // out, closer to true anyway. `tri` is what makes this tier one triangle
    // rather than two, and the species picks which way up; `sink` is the other
    // half of `tri`, out of the same call that sized the card, so an apex-down
    // triangle hangs below the ground and still has the trunk's width where the
    // trunk is. bakeTreeImpostors asks `cardFoot` the same question so the
    // photograph is framed on the same strip.
    if (billboard) {
      if (!v.billboardTri) throw new Error(`buildTreeBank: ${v.species} has no billboardTri`)
      const ext = impostorCardExtents({
        width: u.crownWidth, height: u.height, foot: cardFoot(u, v.billboardTri),
      })
      const card = buildImpostorCard(ext.width, ext.height, v.impostorLayer, 1,
        { upNormal: true, tri: v.billboardTri, sink: ext.sink })
      // The mesh tiers carry their baked shade in `color`; the card's shade is
      // in its photograph, so it wears white to share their layout and program,
      // and hem 0 because a card has no edge to fray.
      const nCard = card.attributes.position.count
      card.setAttribute('color', new THREE.BufferAttribute(runOf(nCard * 3, 1), 3))
      card.setAttribute('hem', new THREE.BufferAttribute(runOf(nCard, 0), 1))
      cards.push(card)
    }
  }

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
 * Photograph one tree per PLANTED SPECIES into the impostor layer its cards
 * already point at. Call ONCE, after `loadImageLayers()` has resolved -- before that
 * the tree has no bark or mat and the picture would be of nothing.
 *
 * One ortho render at 512^2 per species, a 1 MB readback and the downsample, and
 * `readRenderTargetPixels` stalls the pipeline for each -- so this is a
 * deliberate one-off hitch at load rather than anything the frame loop does.
 *
 * ONE LAYER PER SPECIES, which is also one layer per variant. A placed tree's
 * size is a uniform scale on its matrix, so the photograph is stretched evenly
 * with the card and stays exact at every size in the range.
 */
export function bakeTreeImpostors(renderer, texArray) {
  const done = []
  for (const v of treeVariants()) {
    // The near tier, frayed hems and holed mat: the card is the picture of the
    // tree at its best, not of the solid tier it happens to take over from.
    // A species without a near mat welds solid and the fray finds hem 0.
    const geo = buildTier(v.species, 0)
    const u = geo.userData.tree
    const ext = bakeImpostor(renderer, geo, texArray, v.impostorLayer, {
      width: u.crownWidth,
      height: u.height,
      hemFray: HEM_FRAY,
      // The same strip of empty ground the card's apex hangs into. Framed here
      // and not just in the geometry, or the picture sits `sink` too high on it.
      foot: cardFoot(u, v.billboardTri),
      // The baked occlusion is in the mesh's `color`, and the photograph has to
      // show the same shaded crown the mesh does or the swap is a colour step.
      vertexColors: true,
    })
    geo.dispose()
    done.push({ species: v.species, layer: v.impostorLayer, ...ext })
  }
  return done
}
