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
  {
    id: 'tree_deciduous_hi',
    src: `${HIGH}/realistic-deciduous-tree/source/nested/TREE.fbx`,
    class: 'large',
    height_m: 11.0,
  },
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
]

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

const missing = assets.filter((a) => !fs.existsSync(path.join(ROOT, a.src)))
if (missing.length) {
  console.warn(`WARNING: ${missing.length} source files not found:`)
  for (const m of missing.slice(0, 12)) console.warn(`  ${m.id}  ${m.src}`)
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
console.log(
  `wrote ${path.relative(ROOT, dest)} -- ${assets.length} assets ` +
    `(${assets.filter((a) => a.class === 'large').length} large, ` +
    `${assets.filter((a) => a.class === 'medium').length} medium, ` +
    `${assets.filter((a) => a.class === 'small').length} small), ` +
    `${missing.length} missing`,
)
