// Generate tools/props/manifest.json.
//
//   node tools/props/make-manifest.mjs
//
// The manifest is generated rather than hand-written because the Quaternius
// pack is 150 files on a regular naming scheme (`<Species>_<Snow|Autumn|Dead>_<n>`)
// and hand-listing them is 150 chances to typo a path or a height. The dozen
// downloaded assets are irregular and ARE hand-listed, below.
//
// The one number every entry must carry is `height_m`, the real-world height the
// asset should stand at. Nothing in these sources records a usable unit -- they
// arrive in centimetres, in inches, and in at least one case with a 100x FBX
// unit scale baked in -- so the pipeline scales each asset to a declared height
// instead of trying to recover the true unit. It is also the only number that
// can be checked by eye, which is §6's whole scale-reference argument.

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')
const NATURE = 'tmp/placeholder-props/Ultimate Nature Pack - Jun 2019/FBX'
const HIGH = 'tmp/placeholder-props/high-poly-to-decimate/_x'
const NEW = 'tmp/placeholder-props/high-poly-to-decimate/_new'

// ---------------------------------------------------------------------------
// Size classes. The LOD ladder is per class, NOT one chain for everything, and
// the reason is in scripts/probe-prop-lod.mjs: a billboard's only real defect is
// parallax, the error is `atan(depth / distance)`, and the distance at which it
// falls under 2 degrees therefore scales with the prop. A 13.5 m tree wants its
// card at 120 m; a 1 m boulder wants it at 17 m, which is inside the distance
// the boulder gets culled at anyway. So small and medium props do not get a
// billboard at all, and that is a derivation rather than a saving measure.
// ---------------------------------------------------------------------------
const CLASSES = {
  large: {
    lod_tris: [500, 130],
    billboard: true,
    billboard_quads: 3,
    lod0_m: 30,
    // billboard_m is computed per asset from its own depth; this is the fallback
    // for anything whose depth the pipeline could not measure.
    billboard_m: 130,
    cull_m: 260,
    note: 'trees, cabins, towers -- the only class with an impostor',
  },
  medium: {
    lod_tris: [150, 40],
    billboard: false,
    lod0_m: 22,
    cull_m: 95,
    note: 'boulders, stumps, logs, bushes -- culled before a card would pay',
  },
  structure: {
    // ONE mesh tier, not two. Buildings are the only class where the decimator
    // has a hard floor above its target: the collapse decimator will not
    // collapse across an open boundary, and a cabin is hundreds of separate
    // non-watertight parts. Measured floors after a planar pre-pass are 544 /
    // 1514 / 1704 / ~880 tris, so a 130-tri LOD1 would be an identical copy of
    // LOD0 under a different name -- a wasted geometry slot and a pop event
    // that changes nothing. They go straight from mesh to impostor instead,
    // which the parallax rule already puts a long way out: a 6 m deep cabin
    // does not read as a card until ~170 m (see scripts/probe-prop-lod.mjs).
    lod_tris: [1800],
    decimate: 'planar_collapse',
    billboard: true,
    billboard_quads: 3,
    lod0_m: 60,
    billboard_m: 170,
    cull_m: 400,
    note: 'cabins, watchtower, windmill -- one mesh tier, then an impostor',
  },
  small: {
    lod_tris: [16],
    billboard: false,
    lod0_m: 26,
    cull_m: 26,
    note: 'grass, ferns, flowers -- one tier, hard cull, no LOD chain at all',
  },
}

// ---------------------------------------------------------------------------
// Quaternius nature pack. Flat `Kd` materials, no UVs at all, so every one of
// these takes the vertex-colour path and costs ZERO texture array layers --
// which matters directly against §9's `MAX_ARRAY_TEXTURE_LAYERS >= 256` worry.
// ---------------------------------------------------------------------------
const SPECIES = [
  // prefix,          class,    height_m, variants
  ['PineTree', 'large', 11.5, 5],
  ['PineTree_Snow', 'large', 11.5, 5],
  ['PineTree_Autumn', 'large', 11.0, 5],
  ['CommonTree', 'large', 9.5, 5],
  ['CommonTree_Snow', 'large', 9.5, 5],
  ['CommonTree_Autumn', 'large', 9.5, 5],
  ['CommonTree_Dead', 'large', 8.5, 5],
  ['CommonTree_Dead_Snow', 'large', 8.5, 5],
  ['BirchTree', 'large', 12.5, 5],
  ['BirchTree_Snow', 'large', 12.5, 5],
  ['BirchTree_Autumn', 'large', 12.0, 5],
  ['BirchTree_Dead', 'large', 11.0, 5],
  ['BirchTree_Dead_Snow', 'large', 11.0, 5],
  ['Willow', 'large', 8.5, 5],
  ['Willow_Snow', 'large', 8.5, 5],
  ['Willow_Autumn', 'large', 8.5, 5],
  ['Willow_Dead', 'large', 7.5, 5],
  ['Willow_Dead_Snow', 'large', 7.5, 5],
  ['Rock', 'medium', 1.1, 7],
  ['Rock_Moss', 'medium', 1.1, 7],
  ['Rock_Snow', 'medium', 1.1, 7],
  ['Bush', 'medium', 1.25, 2],
  ['Bush_Snow', 'medium', 1.25, 2],
  ['BushBerries', 'medium', 1.0, 2],
  ['Plant', 'small', 0.55, 5],
]

// Species with no numeric suffix.
const SINGLETONS = [
  ['TreeStump', 'medium', 0.85],
  ['TreeStump_Moss', 'medium', 0.85],
  ['TreeStump_Snow', 'medium', 0.85],
  ['WoodLog', 'medium', 0.65],
  ['WoodLog_Moss', 'medium', 0.65],
  ['WoodLog_Snow', 'medium', 0.65],
  ['Grass', 'small', 0.45],
  ['Grass_2', 'small', 0.45],
  ['Grass_Short', 'small', 0.24],
  ['Flowers', 'small', 0.35],
  ['Wheat', 'small', 1.05],
]

// Deliberately excluded: PalmTree, Cactus*, CactusFlower*, Lilypad, Corn. Wrong
// biome for a snowy northern range (§2), and every asset costs build time and a
// geometry slot in the batch whether or not the scatter ever picks it.

// ---------------------------------------------------------------------------
// The downloaded high-poly assets. These DO have UVs and textures, so they take
// the texture path and each costs one 128x128 Class-B layer (§9).
// ---------------------------------------------------------------------------
const DOWNLOADS = [
  {
    id: 'cabin_chalet_snowy',
    src: `${HIGH}/snowy-north-american-chalet-cabin-low-poly/source/SNOWY HOUSE LOW POLY .fbx`,
    class: 'structure',
    height_m: 5.6,
  },
  {
    id: 'cabin_timberbound',
    src: `${HIGH}/timberbound-cabin/source/model.glb`,
    class: 'structure',
    height_m: 4.8,
  },
  {
    id: 'cabin_small_wooden',
    src: `${HIGH}/wooden-structure-that-resembles-a-small-cabin/source/model.glb`,
    class: 'structure',
    height_m: 3.6,
  },
  {
    id: 'watchtower',
    src: `${HIGH}/stylized-watchtower-tier-i/source/25d67378a96429991e1eedd1f0213a6a.glb`,
    class: 'structure',
    height_m: 9.5,
  },
  {
    id: 'windmill',
    src: `${HIGH}/1st-windmill-of-x/source/mesh_h6p8qJp.glb`,
    class: 'structure',
    height_m: 12.0,
  },
  {
    id: 'boulder_mossy',
    src: `${HIGH}/boulder-rock-3d-model-free/source/Meshy_AI_Layered_Mossy_Boulder_0616172204_texture.glb`,
    class: 'medium',
    height_m: 1.9,
  },
  {
    // 447k tris, no UVs and no materials at all -- a raw photogrammetry PLY.
    // Forced onto the vertex-colour path with a declared granite tint, because
    // there is nothing to unwrap and a 128x128 bake of an unwrapped 447k-tri
    // scan would be mud.
    id: 'boulder_scan',
    src: `${HIGH}/boulder/source/nested/boulder.ply`,
    class: 'medium',
    height_m: 2.4,
    force_vertex_color: true,
    base_color: [0.34, 0.32, 0.3, 1.0],
  },
  {
    id: 'tree_autumn_broadleaf',
    src: `${HIGH}/autumn-tree/TR_01_autumn.fbx`,
    class: 'large',
    height_m: 7.5,
  },
  {
    id: 'tree_pine_stylised',
    src: `${HIGH}/pine-tree/source/Tree.fbx`,
    class: 'large',
    height_m: 9.0,
  },
  // `realistic-deciduous-tree` was here and is excluded -- see the note at the
  // bottom about assets whose canopy bakes flat.
  {
    id: 'bush_pine_cluster',
    src: `${HIGH}/3-pine-bushes/source/bushes done.fbx`,
    class: 'medium',
    height_m: 1.45,
  },
  {
    id: 'bush_simple',
    src: `${HIGH}/bush-test/source/Bush test.obj`,
    class: 'medium',
    height_m: 1.1,
    base_color: [0.19, 0.28, 0.13, 1.0],
  },
  {
    id: 'fern_polypody',
    src: `${HIGH}/realistic-hd-common-polypody-fern-855/source/nested/Polypodium vulgare HD_Wall growth 2 mat 50_LOD0.fbx`,
    class: 'small',
    height_m: 0.45,
  },
  {
    id: 'horsetail',
    src: `${HIGH}/small-calamite/source/nested/New Project 51.obj`,
    class: 'medium',
    height_m: 1.5,
  },

  // -------------------------------------------------------------------------
  // Second shopping run (_new/). Mostly Megascans "Raw" photoscans, and they
  // are the best-behaved sources in the library by a wide margin: measured at
  // 0.0-0.1% boundary edges, so a 2M-triangle log collapses to exactly 500 in
  // ONE round. Compare the photoreal card foliage excluded above at ~50-100%
  // boundary, which does not decimate at all. `tools/props/probe-source.py`
  // reports that fraction, and it is the number to check before adding
  // anything here -- it predicted every accept and reject in this batch.
  //
  // They all need `base_color_map`: Megascans ships the FBX with no material
  // and the maps as loose files beside it, so without it the pipeline correctly
  // sees "no images" and sends a photoscan down the flat-colour path.
  // -------------------------------------------------------------------------
  {
    id: 'log_birch_scan',
    src: `${NEW}/birch_log_ti2fbajfa_raw/Birch_Log_ti2fbajfa_Raw.fbx`,
    base_color_map: `${NEW}/birch_log_ti2fbajfa_raw/Birch_Log_ti2fbajfa_Raw_8K_BaseColor.jpg`,
    class: 'medium',
    height_m: 0.34, // lies down: 1.7 m long in the source, 0.28 m thick
  },
  {
    id: 'log_mossy_scan',
    src: `${NEW}/mossy_tree_log_rdkeg_raw/Mossy_Tree_Log_rdkeg_Raw.fbx`,
    base_color_map: `${NEW}/mossy_tree_log_rdkeg_raw/Mossy_Tree_Log_rdkeg_Raw_8K_BaseColor.jpg`,
    class: 'medium',
    height_m: 0.75, // 5 m long in the source
  },
  {
    id: 'tree_dead_standing',
    src: `${NEW}/dead_tree_qletl_raw/Dead_Tree_qlEtl_Raw.fbx`,
    base_color_map: `${NEW}/dead_tree_qletl_raw/Dead_Tree_qlEtl_Raw_8K_BaseColor.jpg`,
    class: 'large',
    height_m: 6.5,
  },
  {
    // A scanned patch of forest floor -- moss, litter and small stones. Only
    // 2.15 m across, so unlike the excluded `3d Grass.obj` fields this is a
    // prop the scatter can place, not a pre-scattered field that fights it.
    id: 'forest_floor_cluster',
    src: `${NEW}/nordic_forest_cluster_medium_xisgcic_raw/Nordic_Forest_Cluster_Medium_xisgcic_Raw.fbx`,
    base_color_map: `${NEW}/nordic_forest_cluster_medium_xisgcic_raw/Nordic_Forest_Cluster_Medium_xisgcic_Raw_8K_BaseColor.jpg`,
    class: 'medium',
    height_m: 1.15,
  },
  {
    // Not a scan and not Megascans -- a game-ready prop, 3,309 triangles and
    // 1.4% boundary. Cheapest asset here to convert.
    id: 'tree_cracked_dead',
    src: `${NEW}/realistic-cracked-tree-game-ready-prop/source/rackedTree.fbx`,
    base_color_map: `${NEW}/realistic-cracked-tree-game-ready-prop/textures/rackedTree_DefaultMaterial_BaseColor.png`,
    class: 'large',
    height_m: 4.2,
  },
  // `high-quality-tree-66` was here as `tree_oak_hero` and is excluded -- see
  // the note at the bottom. `structure` remains a class defined by DECIMATION
  // BEHAVIOUR rather than by subject (one honest mesh tier then an impostor,
  // for anything whose floor sits near 1800); the cabins still use it.

  // Megascans grass, cut down to `small` (16 triangles) with its cutout intact.
  // These are the assets that make §5's "open fields of low heather scrub" real
  // rather than procedural, and each variant costs one 128x128 layer.
  //
  // Only the variants that SURVIVE the cut are here. All three `tall_grass`
  // variants and `wild_grass` Var A are excluded below: they stall above target
  // AND arrive as slivers, which is one failure, not two. A stalled tier is not
  // automatically bad (see `decimate_to`), but a stalled tier that has lost its
  // surface area is, and only `check-props.mjs`'s degeneracy check tells them
  // apart. Anything added here should be measured the same way before it stays.
  ...['B', 'C', 'D'].map((v) => ({
    id: `grass_wild_scan_${v.toLowerCase()}`,
    src: `${NEW}/wild_grass_vlkhcbxia_raw/Wild_Grass_vlkhcbxia_Raw_vlkhcbxia_Var${v}_LOD0.fbx`,
    base_color_map: `${NEW}/wild_grass_vlkhcbxia_raw/Wild_Grass_vlkhcbxia_Raw_8K_BaseColor.jpg`,
    opacity_map: `${NEW}/wild_grass_vlkhcbxia_raw/Wild_Grass_vlkhcbxia_Raw_8K_Opacity.jpg`,
    class: 'small',
    height_m: 0.4,
  })),
]

// Excluded after building them once and LOOKING at them -- TREES WHOSE CANOPY
// DOES NOT SURVIVE. Both passed every gate and both are wrong in a render:
//   realistic-deciduous-tree (`tree_deciduous_hi`) -- a white-leaved tree. Its
//     `normal leaves` material has no Base Color image at all, so it bakes
//     Principled's 0.8 grey default; `trunks` has none either and bakes the
//     near-black colour the importer read out of the FBX. The green
//     `leaves color.png` is right there in the source folder and nothing in the
//     FBX references it. Fixable only by a per-slot map override, which is the
//     custom-pipeline-per-asset this batch exists to avoid. `check-props.mjs`
//     now warns on any textured asset with a slot like this.
//   high-quality-tree-66 (`tree_oak_hero`) -- at its 1,703-triangle floor the
//     mesh is 1,794 twig cards, 5 trunk polygons and ZERO leaves. The three
//     source objects compete for one budget and the twig object wins, because
//     twig cards are boundary edges the collapse decimator cannot touch while
//     the solid trunk collapses freely. So the hero oak is a bundle of bare
//     sticks. Its `LiveOakBranch.png` canopy atlas is also wired to Alpha only
//     and tagged Non-Color, which would have baked it black even if the leaves
//     had survived; `wire_orphan_color` in build.py handles that half.
//
// Excluded after building them once and LOOKING at them -- PHOTOSCAN GRASS
// TUFTS. Four variants passed every gate, reported plausible triangle counts,
// and rendered as a dozen specks. The collapse decimator does not fail on a
// tuft of blades, it succeeds in the only way it can: it flattens the blades.
// The triangles are still there and their UVs still address healthy green
// texels, so both the triangle count and the UV-footprint probe say the asset
// is fine. Its world surface area says otherwise:
//   tall_grass  Var A  83 of 13,605 tris survive, 0.4% of its own silhouette,
//     70 of those 83 under 1 cm^2. Var B 107 tris / 0.1%. Var C 183 / 0.2%.
//   wild_grass  Var A  101 tris, 3.9%, 89 of 101 degenerate.
// Raising the target does not rescue them, it just buys the area back at a
// price no scatter can pay -- measured on tall_grass Var A: 16 and 64 both land
// on 83 triangles and 0.1% of the source area; 200 buys 35%; 600 buys 79%; it
// takes 2,000 to be intact. A 600-triangle grass tuft at §5's densities is not
// a grass tuft, it is a tree. Same wall as the card foliage below, reached from
// the other side: those would not decimate at all, these decimate to nothing.
// Replacements want to be authored cross-cards, not scans.

// Excluded from the _new/ batch, all measured with probe-source.py rather than
// guessed. The first three are the same photoreal-card-foliage wall documented
// above -- boundary fraction near half, and a floor an order of magnitude over
// budget that more decimation rounds do not move:
//   dead_shrubs   51.7% boundary, floors at 1,127 tris -- for a 0.3 m shrub
//   lady_fern     45.8% boundary, floors at 1,884 tris
//   butterfly_bush 12.9% boundary, floors at 1,908 tris for a 1.2 m bush.
//     Low boundary and it still stalls, which is the useful counter-example:
//     the fraction predicts, it does not decide. The floor is the answer.
// And two for reasons that are not about triangles:
//   green-purple-codiaeum-variegatum -- decimates fine (500 tris, no trouble),
//     but it is a tropical croton. Same call as PalmTree and Cactus above: a
//     snowy northern range (§2) has no place to put it.
//   quick-treeit-tree -- decimates fine too, but its bark and leaf atlases are
//     separate materials that the FBX does not reference, so `base_color_map`
//     (which is deliberately one map for the whole asset) would paint leaves on
//     the trunk. Wiring per-slot textures for one generic sapling is the custom
//     pipeline this batch exists to avoid, and there are 25 other trees.

// Deliberately excluded from DOWNLOADS, with reasons, so nobody re-adds them
// without reading why:
//   3d Grass.obj / grass lods 1.obj -- 480 and 487 separate objects. These are
//     whole grass FIELDS, not tufts. Joined they scatter as one 5 m mat; split
//     they are a placement problem, not an asset problem. §6's scatter already
//     places individual tufts, so a pre-scattered field fights it.
//   pine-tree (1)/Pine.fbx -- ASCII FBX, which Blender does not read. Would need
//     converting through the FBX SDK or another DCC first.
//   pine-tree (2)/PineTree.fbx -- its FBX texture records carry empty file paths
//     and the importer raises. Salvageable by hand, not worth it while 25 other
//     conifers import cleanly.
//   simple-stone-pillar -- ships as .rar; no extractor on this machine.
//
// Excluded after building them once and measuring -- PHOTOREAL CARD FOLIAGE.
// These are not a format problem, they are a different kind of asset. Every
// leaf is its own quad, so the mesh is ~100% boundary edges, and the collapse
// decimator cannot collapse across a boundary. Decimation does not slow down on
// them, it does nothing at all:
//   tree_island_broadleaf  1,432,638 tris -> 273,971 for a 500 target (54 MB
//     in one GLB, 88% of the whole library's on-disk size)
//   grass_tall               537,210 tris -> 14,847 for a 16 target
//   bush_leafy_hi            135,433 tris ->  4,529 for a 150 target
//   fern_male                 66,490 tris ->    291 for a 16 target
// Getting these to budget means REBUILDING them as a handful of cross-cards
// with a baked canopy texture, which is authoring an asset rather than
// converting one. Replacing them with game-ready low-poly sources is cheaper
// and is what the Quaternius ferns/bushes already are. `fern_polypody` and
// `horsetail` survive from the same family because they are an order of
// magnitude smaller to start with.

// ---------------------------------------------------------------------------

const assets = []

for (const [prefix, cls, height, n] of SPECIES) {
  for (let i = 1; i <= n; i++) {
    assets.push({
      id: `${prefix}_${i}`.toLowerCase(),
      src: `${NATURE}/${prefix}_${i}.fbx`,
      class: cls,
      // Vary height across the variants so a stand is not five clones at one
      // altitude. +/-8% here, on top of scatter.js's per-instance 0.75-1.3x.
      height_m: +(height * (0.92 + 0.16 * ((i - 1) / Math.max(n - 1, 1)))).toFixed(2),
    })
  }
}
for (const [name, cls, height] of SINGLETONS) {
  assets.push({
    id: name.toLowerCase(),
    src: `${NATURE}/${name}.fbx`,
    class: cls,
    height_m: height,
  })
}
assets.push(...DOWNLOADS)

// Fold the class defaults into each asset so build.py never has to look one up,
// and so a per-asset override is a plain field rather than a merge rule.
for (const a of assets) {
  const c = CLASSES[a.class]
  if (!c) throw new Error(`unknown class ${a.class} on ${a.id}`)
  a.lod_tris = a.lod_tris ?? c.lod_tris
  if (c.decimate) a.decimate = a.decimate ?? c.decimate
  a.billboard = a.billboard ?? c.billboard
  if (a.billboard) a.billboard_quads = a.billboard_quads ?? c.billboard_quads
}

// Texture paths are checked here alongside the mesh, because a typo in one is
// otherwise found by Blender, three hundred assets into a build, as a load
// error with no asset id attached to it.
const missing = []
for (const a of assets) {
  for (const key of ['src', 'base_color_map', 'opacity_map']) {
    if (a[key] && !fs.existsSync(path.join(ROOT, a[key]))) missing.push({ id: a.id, key, p: a[key] })
  }
}
if (missing.length) {
  console.warn(`WARNING: ${missing.length} source files not found:`)
  for (const m of missing.slice(0, 12)) console.warn(`  ${m.id}  (${m.key})  ${m.p}`)
  if (missing.length > 12) console.warn(`  ... and ${missing.length - 12} more`)
}

const out = {
  _comment:
    'GENERATED by tools/props/make-manifest.mjs -- edit that, not this. ' +
    'LOD tier counts and crossovers are derived in scripts/probe-prop-lod.mjs.',
  lod_ranges: {
    // Where each tier hands over, in metres. LOD0 and cull are per class;
    // the billboard crossover is per ASSET, computed by the runtime as
    // `depth_m / tan(2 deg)` and clamped into [lod0_m, cull_m].
    parallax_limit_deg: 2.0,
    classes: Object.fromEntries(
      Object.entries(CLASSES).map(([k, v]) => [
        k,
        { lod0_m: v.lod0_m, billboard_m: v.billboard_m ?? null, cull_m: v.cull_m },
      ]),
    ),
  },
  classes: CLASSES,
  assets,
}

const dest = path.join(ROOT, 'tools/props/manifest.json')
fs.writeFileSync(dest, JSON.stringify(out, null, 2))
// Counted off CLASSES rather than off a hand-written list of class names: the
// hand-written one silently stopped mentioning `structure` the day that class
// was added, and a summary that under-reports by five is worse than no summary.
const byClass = Object.keys(CLASSES)
  .map((k) => `${assets.filter((a) => a.class === k).length} ${k}`)
  .join(', ')
console.log(
  `wrote ${path.relative(ROOT, dest)} -- ${assets.length} assets (${byClass}), ${missing.length} missing`,
)
