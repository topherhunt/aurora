import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// A PINE WHOSE CROWN IS OPAQUE GEOMETRY, NOT A CUTOUT. The bench is
// /gen-tree-v3; nothing in the shipped forest imports this yet.
//
// WHY IT EXISTS, in one measurement. src/props/tree.js draws a 9 m pine crown
// as 242 alpha-tested cards: 169.5 m2 of card area over a 25.8 m2 silhouette,
// rasterising 3.4 fragments per silhouette pixel to KEEP 0.85 of one, because
// spray_pine.png is 24.8% opaque. The crown is already only about one leaf
// layer deep, so there is no fat in the card layout -- the 2.4x is the alpha
// test and nothing else. And per props/grass-blades.js, that `discard` also
// costs the draw its low-resolution-Z on a tiled Adreno, so the crowns behind
// it are shaded too. At 0.05 trees/m2 a ray into the 24 m mesh band crosses
// ~2.6 crowns, which is ~8.8 shaded layers against the ~2x a Quest 2 sustains.
//
// So the crown becomes ~1.2 layers of OPAQUE convex blobs. Same silhouette, same
// gaps, no alpha channel, no texture fetch, no `discard` -- and MSAA, which
// does nothing for a cutout's alpha edge, antialiases every one of them.
//
// THE FOUR THINGS THAT MAKE IT A CANOPY AND NOT A PILE OF GRAVEL, because a
// blob cloud is the obvious failure and every one of these is what avoids it:
//
//   THE NORMAL IS THE CROWN'S, not the blob's. Each vertex is shaded by the
//   direction the CROWN faces there (radial off the trunk axis, tilted up by
//   the cone's own slope) blended only `normalBlend` of the way toward the
//   voxel's own outward direction. The canopy then lights as one rounded mass
//   with texture on it. Shading each blob by its own faces gives 800
//   independent gems, which is exactly what broccoli looks like.
//
//   VOXELS SIT ON SHOOTS, not in a cone. whorl -> branch -> shoot -> voxel is
//   four scales of clustering, and clustering is what reads as organic. A
//   Poisson fill of the same hull at the same count reads as a hedge.
//
//   DEPTH IS BAKED. Every voxel knows how far inside the crown hull it sits
//   (against a radius profile measured off the branches this tree actually
//   grew) and darkens with it. That one term carries most of the tree's value
//   structure, and it costs a vertex colour.
//
//   THE RIM IS FRAYED. Voxels past `fringeAt` of the local crown radius shrink
//   and scatter in size, so the silhouette breaks up instead of ending on a
//   hull. The cutout got this from the art for free; opaque geometry has to be
//   given it.
//
// THE LADDER IS A PREFIX OF ONE ARRAY. Voxels are emitted in farthest-point
// order, so ANY prefix is a well-distributed subset of the whole crown, and the
// survivors inflate by sqrt(N / n) to hold the coverage the dropped ones were
// carrying. A rung is therefore `setDrawRange` over one buffer plus one
// uniform: no second bake, no second geometry, no second upload, and a rung
// boundary that can be crossed by RAMPING uGrow instead of by swapping meshes.
// Wood is emitted first in the index buffer so a single range covers it.
//
// AND THE DISSOLVE STOPS BEING A `discard`. `uVoxelCount` collapses a voxel to
// its own centre, which kills the triangles at the primitive stage. A crown
// that thins is both a better-looking rim fade than a stipple and the only kind
// this layer can afford, since one `discard` anywhere in the program is what
// turned low-resolution-Z off in the first place.
// ---------------------------------------------------------------------------

export const VOXEL_PINE_DEFAULTS = {
  seed: 7,
  height: 9,               // metres, root to tip. Everything below is a
                           // fraction of it unless the comment says metres.

  // --- trunk ---------------------------------------------------------------
  trunkRadius: 0.011,      // base radius as a fraction of height
  trunkSides: 5,
  trunkSegs: 3,            // three segments, and each node may kink, so the
                           // trunk leans and corrects instead of being a cone
  trunkTaper: 0.16,        // radius at the tip as a fraction of the base
  trunkKink: 0.011,        // sideways step a node may take, fraction of height

  // --- branches ------------------------------------------------------------
  //
  // No whorls. A whorl is a real thing on a young spruce and a liability here:
  // regular tiers band the crown, and the bands survive to 30 m as stripes.
  // Branches are placed by COUNT, stratified up the trunk and then jittered off
  // their slot, so the spacing is irregular but never gapped.
  firstBranch: 0.17,       // height of the lowest branch
  branchCount: 40,         // TOTAL branches on the tree
  branchJitter: 0.8,       // fraction of a slot a branch may slide off it
  branchLength: 0.33,      // longest branch, as a fraction of height
  branchMin: 0.16,         // shortest, as a fraction of the longest
  crownPeak: 0.06,         // where up the crown the longest branch sits
  crownFullness: 1.34,     // falloff from that peak; >1 pointier
  branchAngle: 0.02,       // radians above horizontal at the launch
  branchRise: 0.75,        // added to that by the apex
  branchDroop: 0.46,       // total bend from launch to tip
  branchSway: 0.30,        // lateral drift, so a branch is not planar
  branchSegs: 2,
  branchSides: 3,
  branchWidth: 0.013,      // limb base radius as a fraction of its own length
  woodShade: 0.13,         // limb bark sits inside the canopy, so it is lit like it

  // --- sub-branches --------------------------------------------------------
  //
  // One or two off each limb, three triangles apiece: a triangular pyramid from
  // a ring on the parent out to a point. They are what turns a limb from a
  // skewer into a fan, and they carry most of the leaves.
  subMin: 1,
  subMax: 2,
  subStart: 0.28,          // earliest point along a limb one leaves
  subLength: 0.46,         // as a fraction of the parent limb
  subAngle: 0.9,           // radians off the parent, out to its side
  subDroop: 0.2,           // and then bent down

  // --- leaves --------------------------------------------------------------
  //
  // PER METRE OF TWIG, not per limb. A pine's lower branches are several times
  // the length of its top ones; give every twig the same leaf count and the
  // crown comes out dense at the leader and moth-eaten at the skirt.
  leaves: 21,
  voxelSize: 0.075,        // METRES, the MINIMUM leaf. Not a fraction: a needle
                           // spray is a real size whether the tree is 6 m or 20.
  voxelLong: 4.7,          // leaf LENGTH = voxelSize * this, so this is a 33 cm
                           // spray off a 7.5 cm attach -- a fan, not a chip.
                           // Width is not a knob: the stem angle sets it.
  voxelVary: 2.0,          // random size, from 1x up to this and no further.
                           // Unbounded variance spends triangles on leaves too
                           // small to read; a factor of two is all the eye
                           // needs to stop seeing a repeated stamp.
  voxelOut: 0.72,          // 0 = the leaf continues the twig, 1 = straight out
                           // its side. A needle leaves a twig SIDEWAYS and
                           // forward, which is the whole reason this is not a
                           // blob centred on the wood.
  voxelRise: 0.24,         // and tilted up off the twig's own plane
  voxelRoll: 2.1,          // radians the roll around the twig may stray
  leafSpin: 1.0,           // how freely a leaf plate turns about its own stem
                           // axis, in half-turns. 1 is any angle at all.
  // HOW HARD EACH LEAF TURNS TOWARD OPEN SPACE. 0 is the golden-angle spiral
  // with a random plate spin; 1 lets every leaf take the roll and the spin that
  // face the most of whatever is not already a leaf. See the openness pass.
  //
  // ON, because it measures as a gain -- but only in a crown dense enough to
  // have neighbours worth turning away from. The win tracks crown NARROWNESS
  // (aspen +6%, birch +4%, pine +3%, oak -3%), so a wide sparse crown turns it
  // off per species. design/26-voxel-foliage.md has the tables and the reason.
  leafOpen: 1.0,
  leafOpenJitter: 0.30,    // radians of slop on the answer, so a shared gap
                           // does not turn a neighbourhood into one flat sheet
  // WHICH OPENNESS. 0 is any direction at all, the whole sphere weighted
  // evenly -- a leaf just turns away from its neighbours. 1 is the
  // cosine-weighted sky instead, real phototropism, which additionally aims
  // every plate face-up and so edge-on to anyone standing under the tree.
  // Same pass, same cost; only the target moves.
  leafOpenUp: 0.0,
  // The floor on leaf length, as a fraction of the LONGEST leaf the crown
  // actually produced. voxelVary bounds the roll, but the leader taper and the
  // fringe shrink both stack on top of it -- so the only floor that means
  // anything is measured against the delivered maximum, after all of that.
  leafFloor: 0.5,
  // THE LEAF TRIANGLE'S SHAPE, stated as the angle at the STEM corner -- the
  // one on the twig. Three angles fix a triangle up to scale, and the other
  // two are the even split of what is left, so this single band is the whole
  // silhouette: narrow is a needle dart, wide is a broadleaf blade. Width
  // follows from it (roughly 2*tan(stem/2) of the length), which is why there
  // is no width knob any more.
  leafStemMin: 25,         // degrees at the attach corner
  leafStemMax: 35,
  // THE LOPSIDEDNESS, as the ratio between the leaf's two flanks -- the edges
  // running out from the attach corner. 1 would be isoceles and would read as
  // one stamp repeated; this band keeps every leaf visibly one-sided without
  // letting the short flank collapse into a sliver.
  leafSideMin: 1.10,
  leafSideMax: 1.40,
  // How far each vertex's own crown normal is pushed away from the leaf's mean
  // one. At 1 the three vertices carry the crown's true curvature across the
  // leaf, which is a small gradient; above that it is exaggerated, and the
  // canopy reads as a rounded mass instead of a heap of flat-lit shards.
  normalRound: 2.2,
  // How much of the seamless needle tile one leaf covers. Every leaf takes its
  // own random offset into it, so no two wear the same patch.
  leafPatch: 0.6,
  barkTile: 1.1,           // metres of bark per tile, the SAME both ways round
  fringeAt: 0.74,          // r/R(y) past which a leaf is on the rim
  fringeShrink: 0.5,       // and how much smaller the rim's leaves get

  // --- self-shadowing ------------------------------------------------------
  //
  // THE TERM THAT MAKES IT A CANOPY. A crown's darks do not come from its hull
  // -- they come from foliage shadowing foliage, and a lit tree is mostly a
  // record of which leaves had neighbours. Counting each leaf's neighbours
  // inside `aoRadius` is that, baked once into a vertex colour, and it is the
  // difference between a lit mass and a flat green cone.
  aoRadius: 0.62,          // metres. Roughly a twig's reach, so "neighbours"
                           // means the leaves that would actually occlude it.
  aoStrength: 0.85,        // how hard a crowded leaf darkens
  aoFloor: 0.16,           // and how dark it is ever allowed to get

  // --- the leader ----------------------------------------------------------
  apexVoxels: 14,          // leaves on the trunk's own tip, which no limb
                           // reaches. Without them a pine ends in a bare spike.
  apexReach: 0.11,         // how far down the trunk they start, as a fraction

  // --- shading (baked into vertex colour) ----------------------------------
  needleDark: [0.086, 0.132, 0.082],   // deep in the crown, in shade
  needleMid: [0.242, 0.340, 0.152],    // the body of the canopy
  needleTip: [0.432, 0.487, 0.184],    // this season's growth at a leaf tip
  depthShade: 1.0,         // how far toward `needleDark` a fully buried leaf
                           // goes. The tree's whole value structure is here.
  heightLift: 0.22,        // extra light on the top of the crown
  tipRun: 0.55,            // how much of a leaf's length the tip colour runs
  hueVary: 0.13,           // per-leaf colour roll
  normalBlend: 0.0,        // 0 = shade by the crown, 1 = shade by the leaf.
                           // At 0 no leaf carries its own facing at all, so a
                           // triangle that happens to be edge-on to the sun
                           // cannot go black in the middle of a lit canopy.
  normalTilt: 1.6,         // how far the crown's normal tips UP off radial
}

/**
 * THE OTHER THREE SPECIES, as overrides on the pine.
 *
 * Whether one triangle per leaf survives contact with a BROADLEAF is the open
 * question this table exists to answer, and it is not the same question the
 * pine answered. A conifer is a cone of slivers and the approach was built for
 * it; an oak is a bellied ball of broad blades, which asks the leaf triangle to
 * be short and wide. So each broadleaf opens the stem-angle band well past the
 * pine's dart, which is the one knob that shape hangs off.
 *
 * `tile` is the solid needle/leaf mat from tools/trees/solidify-leaves.mjs: a
 * hand cut of real leaves stamped over itself until it is opaque. Every entry
 * names a `_solid` file, because an alpha-tested cut anywhere in this material
 * costs the draw its low-resolution-Z, which is the whole advantage.
 *
 * The shader divides the tile by its own mean, so the tile supplies GRAIN and
 * the palette below supplies COLOUR -- which means a species whose leaves are
 * not green needs a palette that is not green. See the aspen.
 */
export const VOXEL_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    tile: 'trees/leaf_pine_solid.png',
    params: {},
  },
  // A crown that bellies at mid-height rather than tapering from the hem, over
  // a clear trunk, on limbs that leave nearly horizontal and lift at the ends.
  oak: {
    label: 'oak',
    barkLayer: LAYER.BARK,
    tile: 'trees/leaf_oak_solid.png',
    params: {
      firstBranch: 0.40, branchCount: 30, branchLength: 0.46, branchMin: 0.42,
      crownPeak: 0.45, crownFullness: 0.52,
      branchAngle: 0.34, branchRise: 0.30, branchDroop: 0.20, branchSway: 0.42,
      trunkRadius: 0.017, trunkTaper: 0.34, trunkKink: 0.018,
      subMin: 2, subMax: 3, subLength: 0.52, subAngle: 1.1,
      // EIGHT leaves per metre of twig, against the pine's 21. A conifer's
      // twigs are a sparse skeleton the needles have to fill; a broadleaf crown
      // is a packed ball, so the same rate buries the tree in seven layers of
      // leaf for one layer of silhouette. Tuned so `layers` lands near the
      // pine's.
      leaves: 8, voxelSize: 0.07, voxelLong: 4.1, voxelVary: 1.7,
      // THE ONE CROWN WIDE ENOUGH TO LOSE BY IT. Openness-seeking needs
      // neighbours to turn away from; an oak's 3.9 m crown has open space in
      // every direction, so every leaf points outward TOGETHER and the
      // correlation costs more than the gap-filling buys. Measured -2.6%.
      leafOpen: 0,
      // A BLADE, NOT A NEEDLE: twice the pine's stem angle is twice the width
      // for the same length, which is the difference between the two crowns.
      leafStemMin: 52, leafStemMax: 68,
      voxelOut: 0.55, voxelRise: 0.34, fringeAt: 0.80, apexVoxels: 8, apexReach: 0.16,
      needleDark: [0.052, 0.098, 0.046], needleMid: [0.196, 0.318, 0.118],
      needleTip: [0.386, 0.470, 0.170],
      leafPatch: 0.85, barkTile: 1.35,
    },
  },
  // Slender, high-crowned, and hung: birch twigs fall, which is most of what
  // tells it apart from an aspen at any distance.
  birch: {
    label: 'birch',
    barkLayer: LAYER.BARK_BIRCH,
    tile: 'trees/leaf_ash_solid.png',
    params: {
      firstBranch: 0.46, branchCount: 44, branchLength: 0.32, branchMin: 0.34,
      crownPeak: 0.55, crownFullness: 0.85,
      branchAngle: 0.52, branchRise: 0.34, branchDroop: 0.78, branchSway: 0.36,
      trunkRadius: 0.0085, trunkTaper: 0.28, trunkKink: 0.014,
      subMin: 1, subMax: 3, subLength: 0.58, subAngle: 0.7, subDroop: 0.55,
      leaves: 10, voxelSize: 0.07, voxelLong: 3.8, voxelVary: 1.8,
      leafStemMin: 52, leafStemMax: 68,
      voxelOut: 0.62, voxelRise: 0.18, fringeAt: 0.78, apexVoxels: 10, apexReach: 0.14,
      needleDark: [0.070, 0.112, 0.054], needleMid: [0.246, 0.372, 0.146],
      needleTip: [0.470, 0.540, 0.208],
      leafPatch: 0.7, barkTile: 1.2,
    },
  },
  // Narrow and columnar, with the smallest leaf of the four -- an aspen in
  // turn reads as a vertical stroke of gold.
  aspen: {
    label: 'aspen',
    barkLayer: LAYER.BARK_BIRCH,
    tile: 'trees/leaf_aspen_solid.png',
    params: {
      firstBranch: 0.44, branchCount: 56, branchLength: 0.22, branchMin: 0.46,
      crownPeak: 0.50, crownFullness: 1.05,
      branchAngle: 0.62, branchRise: 0.42, branchDroop: 0.22, branchSway: 0.28,
      trunkRadius: 0.009, trunkTaper: 0.30, trunkKink: 0.009,
      subMin: 1, subMax: 2, subLength: 0.50, subAngle: 0.8,
      leaves: 10, voxelSize: 0.07, voxelLong: 3.6, voxelVary: 1.7,
      leafStemMin: 52, leafStemMax: 68,
      voxelOut: 0.66, voxelRise: 0.26, fringeAt: 0.80, apexVoxels: 12, apexReach: 0.12,
      // THE TILE'S OWN COLOUR, not a green one. needleMid IS the linear mean
      // of leaf_aspen_solid.png, so palette * (tile / mean) averages back to
      // exactly the photograph and the crown wears the gold it was cut from.
      // Any other hue here re-tints the tile, which is what turned a yellow
      // aspen green. Dark and tip are the same chromaticity at 0.36x and 1.30x
      // the value, so the ramp carries value structure and nothing else.
      needleDark: [0.197, 0.111, 0.021], needleMid: [0.548, 0.307, 0.057],
      needleTip: [0.712, 0.399, 0.074],
      leafPatch: 0.65, barkTile: 1.2,
    },
  },
}

/**
 * OPENNESS, as a fixed set of directions with two weights: [x, y, z, wSky, wAll].
 *
 * The WHOLE SPHERE, not a hemisphere: what a leaf is looking for is any
 * direction that is not already another leaf, and down and sideways count.
 * Fibonacci-spiralled so every sample owns equal solid angle and no azimuth is
 * favoured, which is what stops a crown lining up on a sample direction.
 *
 * `wAll` is uniform -- pure outward-seeking. `wSky` is the cosine-weighted
 * upper hemisphere, the diffuse sky a flat plate actually collects, zero
 * below the horizon. leafOpenUp mixes them; see openFormAt.
 *
 * Nineteen is the working number over a sphere: below about twelve the leaves
 * visibly quantise onto the samples, and past about twenty-four the answer
 * stops moving while the pass keeps getting more expensive.
 */
const OPEN_DIRS = (() => {
  const n = 19
  const out = []
  for (let i = 0; i < n; i++) {
    const cosT = 1 - (2 * (i + 0.5)) / n
    const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
    const phi = i * 2.399963
    out.push([Math.cos(phi) * sinT, cosT, Math.sin(phi) * sinT, Math.max(0, cosT), 1])
  }
  return out
})()
// How far a ray is marched through the crown, in grid cells, and how many rolls
// around its twig a leaf is offered. Both are the cost knobs: the pass is
// sites * (OPEN_PHI + 1) * OPEN_DIRS * OPEN_STEPS grid reads.
const OPEN_STEPS = 6
const OPEN_PHI = 8

/** The full parameter set for a species, pine defaults underneath. */
export function voxelSpecies(name) {
  const sp = VOXEL_SPECIES[name]
  if (!sp) throw new Error(`no voxel species "${name}" -- have ${Object.keys(VOXEL_SPECIES).join(', ')}`)
  return { ...VOXEL_PINE_DEFAULTS, ...sp.params }
}

// A pine's whorls thin toward the leader; everything else about a branch is a
// smooth function of where up the crown it sits.
const lerp = (a, b, t) => a + (b - a) * t
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

// A LEAF IS ONE TRIANGLE. Long, scalene, and attached by a corner: vertex 0
// sits on the twig and the other two run out from it, splayed unequally and
// at unequal reach, so no two leaves in the crown are the same shape.
//
// One triangle, not a solid. A closed solid's mean projected area is a QUARTER
// of its surface; a flat plate drawn double-sided projects HALF of its own
// area. So per triangle a plate covers twice what an octahedron's face does,
// and it does it with three vertices instead of six -- which is the whole
// reason a 3,000-triangle crown is reachable at all. What it costs is backface
// culling, since a plate seen from behind has to still be there.
//
// It is also the shape being modelled. A needle spray IS a flat fan held out
// sideways from its twig. Centring a solid ON the twig, which is what a blob
// does, reads as a bead threaded on a wire -- correct nowhere in botany, and
// unmistakable once seen.

/**
 * Build one voxel-crowned pine.
 *
 * @param {object} params  VOXEL_PINE_DEFAULTS, overridden
 * @returns {{geometry: THREE.BufferGeometry, stats: object}} geometry carries
 *   position / normal / color / uvProj / texLayer for the wood and, for the
 *   foliage, `aCentre` (the voxel's own centre, for the inflate) and `aVoxel`
 *   (its rank in the farthest-point order, for the prefix and the dissolve).
 *   Wood is indexed FIRST and answers aVoxel -1, so `setDrawRange(0,
 *   stats.woodIndices + 24 * n)` draws the wood plus the n most important
 *   voxels and nothing else.
 */
export function buildVoxelPine(params = {}, barkLayer = 0) {
  const p = { ...VOXEL_PINE_DEFAULTS, ...params }
  const rng = mulberry32((p.seed | 0) * 2654435761 % 2147483647 || 12345)
  const rand = (a, b) => a + (b - a) * rng()
  const h = p.height

  // --- the skeleton --------------------------------------------------------
  //
  // Built before any vertex is emitted, because the crown's RADIUS PROFILE has
  // to exist before a voxel can be told how deep inside it it sits, and the
  // profile is measured off the branches this seed actually grew rather than
  // assumed from crownPeak.
  const crownBase = p.firstBranch * h
  const crownTop = h

  // The trunk is a polyline, not a curve. Each node steps sideways by up to
  // `trunkKink` and the next one is free to step back, so the trunk leans and
  // corrects the way a wind-grown conifer does. A smooth lean bends all one
  // way, which reads as a modelling mistake rather than as weather.
  const trunkPts = []
  {
    let x = 0, z = 0
    for (let i = 0; i <= p.trunkSegs; i++) {
      const t = i / p.trunkSegs
      trunkPts.push([x, t * h, z])
      const step = p.trunkKink * h * (0.4 + t)
      x += rand(-1, 1) * step
      z += rand(-1, 1) * step
    }
  }
  const trunkAt = (y) => {
    const f = Math.min(p.trunkSegs - 1e-6, Math.max(0, (y / h) * p.trunkSegs))
    const i = Math.min(p.trunkSegs - 1, Math.floor(f)), k = f - i
    return [lerp(trunkPts[i][0], trunkPts[i + 1][0], k), y,
            lerp(trunkPts[i][2], trunkPts[i + 1][2], k)]
  }
  const trunkRadiusAt = (y) => {
    const t = Math.min(1, Math.max(0, y / h))
    return p.trunkRadius * h * lerp(1, p.trunkTaper, t)
  }

  // Branches by COUNT. Stratified into `branchCount` slots up the crown, each
  // then jittered off its own slot, so no two are evenly spaced and none of the
  // trunk is ever left bare. Yaw walks the golden angle, which is the cheapest
  // way to stop any two limbs from stacking.
  const branches = []
  const slot = (crownTop - crownBase) / p.branchCount
  for (let b = 0; b < p.branchCount; b++) {
    const y = crownBase + (b + 0.5 + rand(-1, 1) * p.branchJitter) * slot
    const t = Math.min(1, Math.max(0, (y - crownBase) / (crownTop - crownBase)))
    const yaw = b * 2.399963 + rand(-0.4, 0.4)
    // Branch length off the crown profile: longest at crownPeak, falling to
    // branchMin at the leader.
    const d = Math.abs(t - p.crownPeak) / Math.max(1e-3, 1 - p.crownPeak)
    const shape = Math.pow(Math.max(0, 1 - d), p.crownFullness)
    const len = p.branchLength * h * lerp(p.branchMin, 1, shape) * rand(0.84, 1.12)
    const rise = p.branchAngle + p.branchRise * t * t
    branches.push({ y: Math.min(crownTop - 0.02, Math.max(crownBase, y)), t, yaw, len, rise })
  }

  // Walk each branch into a polyline and record the crown's radius as we go.
  const PROFILE = 32
  const profile = new Float32Array(PROFILE)
  for (const br of branches) {
    const pts = []
    const base = trunkAt(br.y)
    const r0 = trunkRadiusAt(br.y)
    let dir = [Math.cos(br.yaw) * Math.cos(br.rise), Math.sin(br.rise), Math.sin(br.yaw) * Math.cos(br.rise)]
    let cur = [base[0] + dir[0] * r0, base[1] + dir[1] * r0, base[2] + dir[2] * r0]
    pts.push(cur.slice())
    const side = [-Math.sin(br.yaw), 0, Math.cos(br.yaw)]
    const sway = rand(-1, 1) * p.branchSway
    for (let s = 1; s <= p.branchSegs; s++) {
      const step = br.len / p.branchSegs
      cur = [cur[0] + dir[0] * step, cur[1] + dir[1] * step, cur[2] + dir[2] * step]
      pts.push(cur.slice())
      // The droop concentrates toward the tip, which is what makes a pine limb
      // sag rather than hinge at the trunk.
      const bend = (p.branchDroop / p.branchSegs) * (s / p.branchSegs) * 1.6
      dir = norm([dir[0] + side[0] * sway / p.branchSegs, dir[1] - bend, dir[2] + side[2] * sway / p.branchSegs])
    }
    br.pts = pts
    br.side = side
    for (const q of pts) {
      const ax = trunkAt(q[1])
      const r = Math.hypot(q[0] - ax[0], q[2] - ax[2])
      const bin = Math.min(PROFILE - 1, Math.max(0, Math.floor(q[1] / h * PROFILE)))
      if (r > profile[bin]) profile[bin] = r
    }
  }
  // Smooth the profile, so a limb that happened to grow short does not punch a
  // false hole in the depth term.
  for (let i = 0; i < PROFILE; i++) {
    const a = profile[Math.max(0, i - 1)], b = profile[i], c = profile[Math.min(PROFILE - 1, i + 1)]
    profile[i] = (a + b * 2 + c) / 4
  }
  const crownRadiusAt = (y) => {
    const f = Math.min(PROFILE - 1.001, Math.max(0, y / h * PROFILE - 0.5))
    const i = Math.floor(f)
    return Math.max(0.05, lerp(profile[i], profile[Math.min(PROFILE - 1, i + 1)], f - i))
  }

  // --- sub-branches --------------------------------------------------------
  //
  // One or two per limb, out to the SIDE and slightly down. Collected as twigs
  // alongside the limbs' own segments, because from a leaf's point of view a
  // limb and a sub-branch are the same thing: a line with a radius to hang off.
  const subs = []
  const twigs = []
  const pushTwig = (a, b, r0, r1) => {
    const d = sub(b, a)
    const L = len(d)
    if (L > 1e-4) twigs.push({ a, b, dir: [d[0] / L, d[1] / L, d[2] / L], len: L, r0, r1 })
  }
  for (const br of branches) {
    // The limb's own segments are twigs too. Leaves along them are what buries
    // the wood; without them a limb is a bare stick with tufts at the far end.
    const rBase = br.len * p.branchWidth
    for (let i = 0; i < br.pts.length - 1; i++) {
      const t0 = i / (br.pts.length - 1), t1 = (i + 1) / (br.pts.length - 1)
      pushTwig(br.pts[i], br.pts[i + 1], rBase * (1 - t0) + 0.004, rBase * (1 - t1) + 0.004)
    }
    const n = p.subMin + Math.floor(rng() * (p.subMax - p.subMin + 1))
    for (let k = 0; k < n; k++) {
      const u = p.subStart + (1 - p.subStart) * ((k + rand(0.1, 0.9)) / n)
      const at = alongPolyline(br.pts, u)
      const tan = at.tan
      // Sideways off the parent, alternating sides, then bent down. A frame
      // about the limb, not about the world, so a drooping limb's subs droop
      // with it instead of standing up out of the spray.
      const uAx = norm(cross(tan, Math.abs(tan[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
      const phi = (k % 2 ? 1 : -1) * (1 + rand(-0.25, 0.25))
      const outAx = [uAx[0] * phi, uAx[1] * phi, uAx[2] * phi]
      const ang = p.subAngle * rand(0.7, 1.25)
      const dir = norm([
        tan[0] * Math.cos(ang) + outAx[0] * Math.sin(ang),
        tan[1] * Math.cos(ang) + outAx[1] * Math.sin(ang) - p.subDroop,
        tan[2] * Math.cos(ang) + outAx[2] * Math.sin(ang),
      ])
      const L = br.len * p.subLength * rand(0.7, 1.2) * (1 - u * 0.4)
      const r = (br.len * p.branchWidth * (1 - u) + 0.004) * 0.65
      const tip = [at.p[0] + dir[0] * L, at.p[1] + dir[1] * L, at.p[2] + dir[2] * L]
      subs.push({ from: at.p, dir, len: L, r })
      pushTwig(at.p, tip, r, 0.002)
    }
  }

  // --- the leaves ----------------------------------------------------------
  //
  // Collected as plain records first. Nothing is emitted until they have been
  // ordered, because the ORDER is the ladder.
  const voxels = []
  const pushVoxel = (base, dir, size, spin) => {
    // The leaf's own centre, a bit out from its attach point -- the pivot the
    // inflate grows about and the point the dissolve collapses onto.
    const c = [base[0] + dir[0] * size * 0.45,
               base[1] + dir[1] * size * 0.45,
               base[2] + dir[2] * size * 0.45]
    const axis = trunkAt(c[1])
    const rx = c[0] - axis[0], rz = c[2] - axis[2]
    const r = Math.hypot(rx, rz) || 1e-4
    const R = crownRadiusAt(c[1])
    const rel = Math.min(1.4, r / R)
    // Fringe: the outermost shell shrinks and scatters, so the silhouette
    // frays instead of ending on the hull.
    let sz = size
    if (rel > p.fringeAt) {
      const f = Math.min(1, (rel - p.fringeAt) / (1 - p.fringeAt))
      sz *= lerp(1, p.fringeShrink, f) * rand(0.7, 1.2)
    }
    // depth 0 at the rim, 1 buried in the middle of the crown.
    const depth = Math.pow(Math.min(1, Math.max(0, 1 - rel)), 0.75)
    const lift = Math.min(1, Math.max(0, (c[1] - crownBase) / Math.max(1e-3, crownTop - crownBase)))
    voxels.push({
      base, c,
      along: norm(dir),
      // The crown's own normal here: radial off the trunk axis, tipped up by
      // the cone's slope. This is what the canopy is shaded by.
      out: norm([rx / r, p.normalTilt, rz / r]),
      size: sz,
      spin,
      depth,
      lift,
      hue: rand(-1, 1) * p.hueVary,
    })
  }

  // Leaves hang off TWIGS -- limb segments and sub-branches alike -- at a
  // density per metre, so a two-metre skirt limb gets four times the leaves of
  // a half-metre one at the leader and neither comes out threadbare. Sites
  // first, orientations second: which way a leaf faces depends on the leaves
  // already grown, so nothing can be oriented until they all exist as places.
  const sites = []
  for (const tw of twigs) {
    const n = Math.max(1, Math.round(tw.len * p.leaves))
    const uAx = norm(cross(tw.dir, Math.abs(tw.dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const vAx = norm(cross(uAx, tw.dir))
    for (let i = 0; i < n; i++) {
      sites.push({
        tw, uAx, vAx,
        u: (i + rand(0.15, 0.85)) / n,
        // The fallback roll around the twig, walked by the golden angle so
        // consecutive leaves never stack on one side, then frayed by
        // voxelRoll. At leafOpen 0 this is the answer; above it, the start.
        phi0: i * 2.399963 + rand(-p.voxelRoll, p.voxelRoll),
        size: p.voxelSize * p.voxelLong * rand(1, p.voxelVary),
        spin0: rand(-1, 1) * p.leafSpin * Math.PI,
      })
    }
  }

  // The leader. Its leaves are smaller and tighter than a limb's -- a season
  // of growth, not a tier. It grows off the trunk's own tip rather than a twig,
  // so its direction is fixed and only the plate's spin is up for grabs.
  for (let i = 0; i < p.apexVoxels; i++) {
    const t = i / Math.max(1, p.apexVoxels - 1)
    const y = h - p.apexReach * h * t
    const axis = trunkAt(y)
    const yaw = i * 2.399963
    const r = trunkRadiusAt(y) + rand(0.2, 1.0) * p.voxelSize * 1.6 * (0.35 + t)
    sites.push({
      from: [axis[0] + Math.cos(yaw) * r, y - rand(0, 0.3) * p.voxelSize, axis[2] + Math.sin(yaw) * r],
      dir: norm([Math.cos(yaw), rand(0.5, 1.4), Math.sin(yaw)]),
      size: p.voxelSize * p.voxelLong * lerp(0.55, 0.95, t) * rand(1, p.voxelVary),
      spin0: rand(-1, 1) * p.leafSpin * Math.PI,
    })
  }

  growTowardOpen(sites)

  // --- leaf shapes, resolved before anything else sees a size --------------
  //
  // The silhouette of every leaf is drawn HERE rather than in the emit loop,
  // because the floor is relative: no leaf may be shorter than `leafFloor` of
  // the longest one, and the longest is not known until all of them are shaped.
  // Exposure and the ladder order both read `size`, so this has to run first.
  for (const v of voxels) v.leaf = shapeLeaf(v.size)
  const longest = voxels.reduce((m, v) => Math.max(m, v.leaf.L), 0)
  const floorL = longest * p.leafFloor
  for (const v of voxels) {
    if (v.leaf.L >= floorL) continue
    // Length AND width together, which is a SIMILAR triangle: all three angles
    // survive untouched. Stretching the length alone would narrow the stem
    // angle and put the leaf outside the band it was drawn from.
    const k = floorL / v.leaf.L
    v.leaf.L *= k
    v.leaf.W *= k
    v.size *= k
  }

  // --- self-shadowing, measured not assumed --------------------------------
  //
  // A uniform grid over the crown, then each voxel's exposure from the volume
  // its neighbours occupy inside aoRadius. O(n) with a 1-cell halo, so it is
  // cheap enough to run on every slider drag.
  bakeExposure(voxels, p)

  // --- the order IS the ladder ---------------------------------------------
  //
  // Farthest-point sampling, biased by size so the tufts that carry the most
  // silhouette are picked first. Any prefix is then a spread subset of the
  // whole crown rather than a bald half of it, which is what lets a rung be a
  // draw range instead of a second bake.
  const order = farthestPointOrder(voxels)

  // --- emit ----------------------------------------------------------------
  const pos = [], nor = [], col = [], uv = [], layer = [], centre = [], vid = []
  const idx = []
  // Accumulated from the triangles actually emitted, not estimated from the
  // size parameter -- the fringe and the per-leaf splay both move it.
  let leafArea = 0
  const leafAngles = []

  /**
   * The crown's own outward normal AT A POINT rather than per leaf: radial off
   * the trunk axis at that height, tipped up by the cone's slope.
   */
  const crownOutAt = (P) => {
    const ax = trunkAt(P[1])
    const dx = P[0] - ax[0], dz = P[2] - ax[2]
    const r = Math.hypot(dx, dz) || 1e-4
    return norm([dx / r, p.normalTilt, dz / r])
  }

  // WOOD FIRST, so one contiguous draw range covers wood + a voxel prefix.
  // Trunk, then limbs LONGEST FIRST: every limb emits the same index count, so
  // the wood is a ladder of its own and a far rung can stop after the limbs
  // that still read. Left whole, 91 tubes are 1134 triangles that never shrink,
  // and by the last rung that is nearly half the tree.
  emitTrunk()
  for (const sb of subs) emitSub(sb)
  const trunkIndices = idx.length
  const byLength = branches.slice().sort((a, b) => b.len - a.len)
  for (const br of byLength) emitBranch(br)
  const woodIndices = idx.length
  const woodVerts = pos.length / 3
  const perBranchIndices = (woodIndices - trunkIndices) / Math.max(1, byLength.length)

  for (let k = 0; k < order.length; k++) emitVoxel(voxels[order[k]], k)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(layer, 1))
  // vec4: xyz is the voxel's centre (the inflate pivot), w is its baked
  // exposure, which the transmission lobe reads. Packed rather than given its
  // own attribute because a fifth stream costs a fetch on every vertex.
  geo.setAttribute('aCentre', new THREE.Float32BufferAttribute(centre, 4))
  geo.setAttribute('aVoxel', new THREE.Float32BufferAttribute(vid, 1))
  geo.setIndex(idx)
  geo.computeBoundingSphere()

  const stats = {
    height: h,
    crownBase,
    crownRadius: Math.max(...profile),
    branches: branches.length,
    voxels: voxels.length,
    twigs: twigs.length,
    woodTris: woodIndices / 3,
    trunkIndices,
    perBranchIndices,
    branchCount: branches.length,
    foliageTris: (idx.length - woodIndices) / 3,
    tris: idx.length / 3,
    verts: pos.length / 3,
    woodIndices,
    woodVerts,
    subs: subs.length,
    // Half the leaf area, because a flat plate drawn double-sided projects half
    // of its own area averaged over directions. (A closed convex solid projects
    // a quarter of its surface -- which is the whole reason a plate is the
    // better spend of a triangle.)
    coverage: leafArea / 2,
    // The trunk AT THE MIDDLE OF THE CROWN, not the origin. The trunk is
    // kinked, so those are not the same point, and a camera that orbits the
    // origin orbits a spot beside the tree.
    axis: trunkAt((crownBase + h) / 2),
    // The stem angles actually delivered, in degrees, so a bad shape is a
    // number and not a squint at a render. It must sit inside leafStemMin/Max.
    leafAngle: leafAngles.length
      ? [Math.min(...leafAngles), Math.max(...leafAngles)].map((a) => +(a * 180 / Math.PI).toFixed(1))
      : [0, 0],
    // Shortest leaf as a fraction of the longest. leafFloor is a promise, so
    // this is the receipt: it must never come back under it.
    leafShortest: voxels.length
      ? +(voxels.reduce((m, v) => Math.min(m, v.leaf.L), Infinity) / longest).toFixed(3)
      : 0,
  }
  // THE NUMBER THIS WHOLE FILE IS ARGUING ABOUT. The cards rasterise 3.4
  // fragments per silhouette pixel to keep 0.85; opaque leaves rasterise
  // roughly `layers` and keep all of it, so anything much past ~2 is paying for
  // geometry hidden behind its own crown.
  stats.silhouette = stats.crownRadius * (crownTop - crownBase)
  stats.layers = stats.coverage / Math.max(1e-3, stats.silhouette)
  geo.userData.voxelPine = stats
  return { geometry: geo, stats }

  // --- emitters ------------------------------------------------------------

  function emitTrunk() {
    const sides = Math.max(3, p.trunkSides | 0)
    const rings = Math.max(1, p.trunkSegs | 0)
    const base = pos.length / 3
    // sides + 1 vertices per ring: the last one sits on top of the first but
    // carries u = the full circumference instead of 0. Without it the closing
    // quad runs the whole tile BACKWARDS across one face of the trunk, which
    // is a seam you can see from across the clearing. One extra vertex a ring
    // and not one extra triangle.
    const ring = sides + 1
    for (let r = 0; r <= rings; r++) {
      const t = r / rings
      const y = t * h
      const c = trunkPts[r]
      const rad = trunkRadiusAt(y)
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2
        const x = c[0] + Math.cos(a) * rad, z = c[2] + Math.sin(a) * rad
        pos.push(x, c[1], z)
        nor.push(Math.cos(a), 0.12, Math.sin(a))
        col.push(1, 1, 1)
        // Both axes are metres over barkTile, so a texel is square on the
        // trunk and stays square on a limb a tenth its girth.
        uv.push(((s / sides) * 2 * Math.PI * rad) / p.barkTile, y / p.barkTile)
        layer.push(barkLayer)
        centre.push(x, y, z, 1)
        vid.push(-1)
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < sides; s++) {
        const a = base + r * ring + s, b = a + 1
        const c = a + ring, d = b + ring
        idx.push(a, c, b, b, c, d)
      }
    }
  }

  function emitBranch(br) {
    const sides = Math.max(3, p.branchSides | 0)
    const base = pos.length / 3
    const r0 = br.len * p.branchWidth
    const ring = sides + 1     // the duplicated seam vertex, as on the trunk
    let run = 0                // metres walked down the limb, for v
    for (let s = 0; s < br.pts.length; s++) {
      const t = s / (br.pts.length - 1)
      const q = br.pts[s]
      const rad = r0 * (1 - t) + 0.004
      const tan = s === 0
        ? norm(sub(br.pts[1], br.pts[0]))
        : norm(sub(br.pts[s], br.pts[s - 1]))
      if (s > 0) run += len(sub(br.pts[s], br.pts[s - 1]))
      const u = norm(cross(tan, [0, 1, 0]))
      const v = norm(cross(u, tan))
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2
        const dx = u[0] * Math.cos(a) + v[0] * Math.sin(a)
        const dy = u[1] * Math.cos(a) + v[1] * Math.sin(a)
        const dz = u[2] * Math.cos(a) + v[2] * Math.sin(a)
        pos.push(q[0] + dx * rad, q[1] + dy * rad, q[2] + dz * rad)
        nor.push(dx, dy, dz)
        col.push(p.woodShade, p.woodShade, p.woodShade)
        uv.push(((k / sides) * 2 * Math.PI * rad) / p.barkTile, run / p.barkTile)
        layer.push(barkLayer)
        centre.push(q[0] + dx * rad, q[1] + dy * rad, q[2] + dz * rad, 1)
        vid.push(-1)
      }
    }
    for (let s = 0; s < br.pts.length - 1; s++) {
      for (let k = 0; k < sides; k++) {
        const a = base + s * ring + k, b = a + 1
        const c = a + ring, d = b + ring
        idx.push(a, c, b, b, c, d)
      }
    }
  }

  /**
   * A sub-branch in THREE TRIANGLES: a triangular ring on the parent, closed to
   * a single point at the tip. No end cap -- the ring is buried in the limb it
   * grows from and nothing ever sees inside it.
   */
  function emitSub(sb) {
    const base = pos.length / 3
    const u = norm(cross(sb.dir, Math.abs(sb.dir[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const v = norm(cross(u, sb.dir))
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2
      const dx = u[0] * Math.cos(a) + v[0] * Math.sin(a)
      const dy = u[1] * Math.cos(a) + v[1] * Math.sin(a)
      const dz = u[2] * Math.cos(a) + v[2] * Math.sin(a)
      pos.push(sb.from[0] + dx * sb.r, sb.from[1] + dy * sb.r, sb.from[2] + dz * sb.r)
      nor.push(dx, dy, dz)
      col.push(p.woodShade, p.woodShade, p.woodShade)
      uv.push(((k / 3) * 2 * Math.PI * sb.r) / p.barkTile, 0)
      layer.push(barkLayer)
      centre.push(sb.from[0], sb.from[1], sb.from[2], 1)
      vid.push(-1)
    }
    pos.push(sb.from[0] + sb.dir[0] * sb.len, sb.from[1] + sb.dir[1] * sb.len, sb.from[2] + sb.dir[2] * sb.len)
    nor.push(sb.dir[0], sb.dir[1], sb.dir[2])
    col.push(p.woodShade, p.woodShade, p.woodShade)
    uv.push((Math.PI * sb.r) / p.barkTile, sb.len / p.barkTile)
    layer.push(barkLayer)
    centre.push(sb.from[0], sb.from[1], sb.from[2], 1)
    vid.push(-1)
    for (let k = 0; k < 3; k++) idx.push(base + k, base + 3, base + (k + 1) % 3)
  }

  /**
   * TURN EVERY LEAF TOWARD WHATEVER IS NOT ALREADY A LEAF.
   *
   * A leaf here has exactly two freedoms: WHERE around its twig it leaves
   * (`phi`, which the size of voxelOut confines to a cone about the wood), and
   * which way the plate then FACES about its own stem (`spin`). Both are
   * chosen against the leaves already grown, in a shuffled order, so the first
   * leaf into an empty crown has no preference at all and the last one into a
   * packed crown takes the one gap still left to it.
   *
   * leafOpenUp aims it. At 0 the target is openness in ANY direction, the
   * whole sphere weighted evenly -- the leaf simply turns away from its
   * neighbours. At 1 it is the cosine-weighted sky, which is real phototropism.
   *
   * THE SOLVE IS CLOSED FORM, and it is 2x2 because the plate's normal is
   * already confined to the circle perpendicular to its own stem. Score a plate
   * by the openness its face collects, sum(w * T * (n . d)^2), which is the
   * double-sided objective -- a plate and its flip are the same plate, so the
   * SIGN of n . d must not matter and squaring is how you say that over a whole
   * sphere. Written in the stem's own (s0, u0) basis that sum is the quadratic
   * form [[a, b], [b, c]], and its largest eigenvalue is the best openness this
   * roll can reach while its eigenvector is the spin that reaches it. One march
   * per candidate answers both, with no search.
   *
   * COST: sites * (OPEN_PHI + 1) * OPEN_DIRS.length * OPEN_STEPS grid reads --
   * the +1 is the chosen roll marching again for its spin -- so ~2.1M for a
   * 2,000-leaf pine. See design/26-voxel-foliage.md for what
   * that measures at, and for why the shipped forest wants these baked.
   */
  function growTowardOpen(sites) {
    // Leaf area per cell of a coarse grid over the crown. The crown is the only
    // occluder that matters -- a leaf is never shaded by the trunk it is
    // standing off by 10 cm, and the sky it wants is above the whole tree.
    const cell = Math.max(0.15, p.aoRadius * 0.6)
    const R = Math.max(...profile) * 1.25 + cell
    const nx = Math.max(1, Math.ceil((2 * R) / cell))
    const ny = Math.max(1, Math.ceil((h + cell) / cell))
    const dens = new Float32Array(nx * nx * ny)
    const cellAt = (x, y, z) => {
      const i = Math.floor((x + R) / cell), j = Math.floor(y / cell), k = Math.floor((z + R) / cell)
      if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nx) return -1
      return (j * nx + i) * nx + k
    }
    // Beer-Lambert through one cell of randomly oriented flat plates: the mean
    // projected area of a plate over directions is half its own area, so the
    // optical depth a cell adds is 0.5 * (leaf area in it) / (cell area).
    const EXT = 0.5 / (cell * cell)

    /**
     * The openness quadratic form at a point, in the basis perpendicular to a
     * stem: out = [a, b, c] for sum(w * T * (n . d)^2) written over (s0, u0).
     * Everything the caller needs -- how much openness this spot offers and
     * which way to turn for it -- is an eigen-decomposition of those three
     * numbers, and both callers do it inline.
     */
    const wgt = OPEN_DIRS.map((d) => lerp(d[4], d[3], p.leafOpenUp))
    const openFormAt = (c, s0, u0, out) => {
      out[0] = out[1] = out[2] = 0
      for (let q = 0; q < OPEN_DIRS.length; q++) {
        const d = OPEN_DIRS[q]
        if (wgt[q] <= 0) continue
        let tau = 0
        for (let s = 1; s <= OPEN_STEPS; s++) {
          const t = (s - 0.5) * cell
          const i = cellAt(c[0] + d[0] * t, c[1] + d[1] * t, c[2] + d[2] * t)
          // Out of the box is open, and everything past it is too.
          if (i < 0) break
          tau += dens[i]
        }
        const w = wgt[q] * Math.exp(-tau * EXT)
        const ds = d[0] * s0[0] + d[1] * s0[1] + d[2] * s0[2]
        const du = d[0] * u0[0] + d[1] * u0[1] + d[2] * u0[2]
        out[0] += w * ds * ds; out[1] += w * ds * du; out[2] += w * du * du
      }
    }

    /**
     * The spin that maximises that form, and how lopsided the form is. A
     * symmetric 2x2's principal axis is at half the atan2 of its off-diagonal,
     * and the plate's normal runs sin(spin)*s0 - cos(spin)*u0, so reading the
     * eigenvector back as a spin is one more atan2. `aniso` is the gap between
     * the two eigenvalues: at zero the spot is equally open every way round and
     * there is no answer to give.
     */
    const solveSpin = (M) => {
      const aniso = Math.hypot((M[0] - M[2]) / 2, M[1])
      const th = 0.5 * Math.atan2(2 * M[1], M[0] - M[2])
      return { want: Math.atan2(Math.cos(th), -Math.sin(th)), aniso, best: (M[0] + M[2]) / 2 + aniso }
    }
    // Below this much anisotropy the principal axis is numerical noise, and
    // taking it anyway would align every leaf of an empty crown on one arbitrary
    // direction. An indifferent spot keeps the roll it was dealt.
    const ANISO_MIN = 1e-6

    const perpBasis = (along) => {
      const s0 = norm(cross(along, Math.abs(along[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
      return [s0, norm(cross(s0, along))]
    }

    // SHUFFLED, because the order is a priority queue. Walk the twigs in the
    // order they were built and the first branch gets every leaf it wants
    // while the last one grows in its shadow -- a systematic bias by branch
    // index, visible as one lush limb and one bald one.
    for (let i = sites.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const t = sites[i]; sites[i] = sites[j]; sites[j] = t
    }

    // A triangle of length L tapering at A is about L^2 * tan(A/2) across, so
    // the mid of the stem band is all the density field needs to turn a leaf's
    // length into the area it occludes with.
    const areaK = Math.tan(((p.leafStemMin + p.leafStemMax) / 2) * Math.PI / 360)
    const M = [0, 0, 0]
    for (const st of sites) {
      let from = st.from, dir = st.dir, phi = 0
      if (st.tw) {
        // Where on the twig, and how far out. Both depend on the roll, so a
        // candidate has to be built before it can be scored.
        const rad = lerp(st.tw.r0, st.tw.r1, st.u)
        const base = [
          st.tw.a[0] + st.tw.dir[0] * st.tw.len * st.u,
          st.tw.a[1] + st.tw.dir[1] * st.tw.len * st.u,
          st.tw.a[2] + st.tw.dir[2] * st.tw.len * st.u,
        ]
        const build = (ph) => {
          const cs = Math.cos(ph), sn = Math.sin(ph)
          const out = [
            st.uAx[0] * cs + st.vAx[0] * sn,
            st.uAx[1] * cs + st.vAx[1] * sn,
            st.uAx[2] * cs + st.vAx[2] * sn,
          ]
          // OUT AND FORWARD. A needle spray leaves its twig sideways and
          // angled toward the tip; it is not centred on the wood and it is not
          // radial. ON the twig's surface, too -- starting at the centreline is
          // what makes a leaf look skewered by its own branch.
          return {
            out,
            dir: norm([
              lerp(st.tw.dir[0], out[0], p.voxelOut),
              lerp(st.tw.dir[1], out[1], p.voxelOut) + p.voxelRise,
              lerp(st.tw.dir[2], out[2], p.voxelOut),
            ]),
          }
        }
        phi = st.phi0
        if (p.leafOpen > 0) {
          // Which roll can reach the most openness. Scored by the BEST the roll
          // could do if its plate then span optimally, which is the top
          // eigenvalue -- so the roll and the spin are chosen against the same
          // number instead of the roll guessing at a proxy for it.
          let bestScore = -1, bestOff = 0
          for (let k = 0; k < OPEN_PHI; k++) {
            const off = (k / OPEN_PHI) * Math.PI * 2
            const cand = build(st.phi0 + off)
            const c = [
              base[0] + cand.out[0] * rad + cand.dir[0] * st.size * 0.45,
              base[1] + cand.out[1] * rad + cand.dir[1] * st.size * 0.45,
              base[2] + cand.out[2] * rad + cand.dir[2] * st.size * 0.45,
            ]
            const [s0, u0] = perpBasis(cand.dir)
            openFormAt(c, s0, u0, M)
            const score = solveSpin(M).best
            if (score > bestScore) { bestScore = score; bestOff = off }
          }
          // Wrapped to the short way round, so leafOpen interpolates between the
          // spiral and the answer instead of sweeping the long arc between them.
          if (bestOff > Math.PI) bestOff -= Math.PI * 2
          phi += bestOff * p.leafOpen
        }
        const chosen = build(phi)
        dir = chosen.dir
        from = [base[0] + chosen.out[0] * rad, base[1] + chosen.out[1] * rad, base[2] + chosen.out[2] * rad]
      }

      // THE SPIN, from the same closed form the roll was scored with.
      const c = [from[0] + dir[0] * st.size * 0.45, from[1] + dir[1] * st.size * 0.45, from[2] + dir[2] * st.size * 0.45]
      let spin = st.spin0
      if (p.leafOpen > 0) {
        const [s0, u0] = perpBasis(dir)
        openFormAt(c, s0, u0, M)
        const { want, aniso } = solveSpin(M)
        if (aniso > ANISO_MIN) {
          // Half a turn either way is the same plate, so the short way round is
          // measured modulo PI and never modulo 2 PI.
          let off = (want - st.spin0) % Math.PI
          if (off > Math.PI / 2) off -= Math.PI
          if (off < -Math.PI / 2) off += Math.PI
          spin = st.spin0 + off * p.leafOpen
        }
        spin += rand(-1, 1) * p.leafOpenJitter
      }

      pushVoxel(from, dir, st.size, spin)
      // And now this leaf is an occluder for everything grown after it.
      const i = cellAt(c[0], c[1], c[2])
      if (i >= 0) dens[i] += st.size * st.size * areaK
    }
  }

  /**
   * THE LEAF'S SHAPE, drawn from its ANGLES. Vertex 0 is the attach corner, ON
   * the twig, and the angle there is leafStemMin..Max: it is the leaf's taper,
   * and because three angles fix a triangle up to scale it is the whole
   * silhouette. What splits the remaining 180 degrees is the LOPSIDEDNESS: the
   * leaf's two flanks, the edges running out from the attach corner, differ in
   * length by leafSideMin..Max, so no leaf is ever the symmetric arrowhead an
   * even split would give. `size` then supplies the one thing angles cannot:
   * the LENGTH, measured along the leaf's own stem axis.
   *
   * Returned rather than emitted, because leafFloor has to compare every leaf
   * against the longest before any of them is turned into triangles.
   */
  function shapeLeaf(size) {
    const A = rand(p.leafStemMin, p.leafStemMax) * Math.PI / 180
    // The flank ratio IS the other two angles. By the law of sines the flanks
    // are proportional to sin(C) and sin(B), so asking for sin(C) = r sin(B)
    // with B + C = 180 - A solves to cot(B) = (r - cos A) / sin A. r >= 1 and
    // cos A <= 1 keep that denominator positive, so B always lands in (0, 90).
    const r = rand(p.leafSideMin, p.leafSideMax)
    const B = Math.atan2(Math.sin(A), r - Math.cos(A))
    const C = Math.PI - A - B
    // The stem axis does not BISECT the taper: one edge leaves the twig much
    // closer to the axis than the other, so the leaf hangs to one side the way
    // a real one does instead of reading as a symmetric arrowhead.
    const t = rand(0.55, 0.85)
    // Law of sines: an edge off vertex 0 is proportional to the sine of the
    // angle opposite it. Scale is fixed afterwards, so unit k is fine here.
    const V = [
      [0, 0],
      [Math.sin(C) * Math.cos(A * t), Math.sin(C) * Math.sin(A * t)],
      [Math.sin(B) * Math.cos(A * (1 - t)), -Math.sin(B) * Math.sin(A * (1 - t))],
    ]
    // Vertex 2 has to be the FAR one: emitVoxel runs the tip colour and the
    // tile's v coordinate off `reach`, so the corner it calls furthest out
    // must be the one that is.
    if (V[2][0] < V[1][0]) { const q = V[1]; V[1] = V[2]; V[2] = q }
    const L = V[2][0]
    if (!(L > 1e-6)) throw new Error(`leaf stem angle ${(A * 180 / Math.PI).toFixed(1)} deg folds the leaf back on itself`)
    const W = Math.max(Math.abs(V[1][1]), Math.abs(V[2][1]))
    return {
      L: size,
      W: (W / L) * size,
      angle: A,
      reach: V.map((q) => q[0] / L),
      across: V.map((q) => q[1] / W),
    }
  }

  function emitVoxel(v, rank) {
    const base = pos.length / 3
    const { L: Lf, W, reach, across } = v.leaf
    const spin = v.spin
    const along = v.along
    const s0 = norm(cross(along, Math.abs(along[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]))
    const u0 = norm(cross(s0, along))
    // The plate's across axis, spun about the stem. The triangle is planar by
    // construction, so this one angle places it completely.
    const cs = Math.cos(spin), sn = Math.sin(spin)
    const side = [s0[0] * cs + u0[0] * sn, s0[1] * cs + u0[1] * sn, s0[2] * cs + u0[2] * sn]
    leafAngles.push(v.leaf.angle)
    // Colour: the crown's depth carries the value structure, the leaf tip
    // carries this season's growth, and hueVary keeps two neighbours apart.
    // Two darkenings, and they are not the same thing: `depth` is where the
    // leaf sits in the crown's HULL, `expo` is how many neighbours it actually
    // has. A leaf on the underside of a dense lower limb is shallow by hull and
    // pitch dark by neighbours, and only the second term knows that.
    const shade = Math.min(1, v.depth * p.depthShade + (1 - v.expo) * 0.55)
    const body = mix3(p.needleMid, p.needleDark, shade)
    const litBody = [
      body[0] * (1 + v.lift * p.heightLift + v.hue),
      body[1] * (1 + v.lift * p.heightLift + v.hue * 0.6),
      body[2] * (1 + v.lift * p.heightLift * 0.5 + v.hue * 0.3),
    ]
    // New growth only shows where light reaches it.
    const tip = mix3(litBody, p.needleTip, v.expo * (1 - v.depth) * 0.9)

    const P = []
    for (let i = 0; i < 3; i++) {
      const ax = Lf * reach[i]
      const sx = W * across[i]
      P.push([
        v.base[0] + along[0] * ax + side[0] * sx,
        v.base[1] + along[1] * ax + side[1] * sx,
        v.base[2] + along[2] * ax + side[2] * sx,
      ])
    }
    // The plate's own normal, turned to face OUT of the crown. It is drawn
    // double-sided, so which way it was wound is not what decides this -- the
    // normal is, and a leaf lit from inside the canopy is a leaf that reads as
    // a hole.
    let faceN = norm(cross(sub(P[1], P[0]), sub(P[2], P[0])))
    if (faceN[0] * v.out[0] + faceN[1] * v.out[1] + faceN[2] * v.out[2] < 0) {
      faceN = [-faceN[0], -faceN[1], -faceN[2]]
    }
    leafArea += len(cross(sub(P[1], P[0]), sub(P[2], P[0]))) / 2
    // Where this leaf reads the needle tile. Every leaf takes its own offset
    // into a SEAMLESS image, so one 128px texture dresses a whole crown with no
    // two leaves wearing the same patch and no wrap to hide.
    const ou = rand(0, 1), ov = rand(0, 1)
    const uScale = p.leafPatch / Lf     // metres -> tile, the same both ways

    for (let i = 0; i < 3; i++) {
      pos.push(P[i][0], P[i][1], P[i][2])
      // THE ONE THAT MATTERS, and it is per VERTEX. The crown's own normal
      // sampled where this corner actually sits, pushed away from the leaf's
      // mean by normalRound, then blended part of the way toward the plate's
      // own. Three different normals across one triangle is what makes the
      // lighting sweep over a leaf instead of landing flat on it -- which is
      // the whole difference between a rounded canopy and a heap of shards.
      const o = crownOutAt(P[i])
      const rx = v.out[0] + (o[0] - v.out[0]) * p.normalRound
      const ry = v.out[1] + (o[1] - v.out[1]) * p.normalRound
      const rz = v.out[2] + (o[2] - v.out[2]) * p.normalRound
      const n = norm([
        lerp(rx, faceN[0], p.normalBlend),
        lerp(ry, faceN[1], p.normalBlend),
        lerp(rz, faceN[2], p.normalBlend),
      ])
      nor.push(n[0], n[1], n[2])
      const f = reach[i] * p.tipRun
      col.push(lerp(litBody[0], tip[0], f), lerp(litBody[1], tip[1], f), lerp(litBody[2], tip[2], f))
      uv.push(ou + across[i] * W * uScale, ov + reach[i] * p.leafPatch)
      layer.push(-1)
      centre.push(v.c[0], v.c[1], v.c[2], v.expo)
      vid.push(rank)
    }
    idx.push(base, base + 1, base + 2)
  }
}

/**
 * The n-th rung's inflate factor. Dropping to a prefix of `n` of `total`
 * voxels leaves each survivor covering the area of `total / n` of them, and
 * projected area goes as the square of a linear scale.
 */
export function voxelGrow(total, n) {
  // sqrt holds total surface area, so the crown keeps its coverage as voxels
  // drop out. It is capped because past about 2.4 the survivors grow wider than
  // the gaps they are filling: the crown stops getting sparser and starts
  // getting BIGGER, +80% of silhouette by the last rung, and the shape goes
  // with it. Beyond the cap the far tree is simply allowed to thin out, which
  // is what a real one does into fog anyway.
  return Math.min(GROW_CAP, Math.pow(total / Math.max(1, n), GROW_POWER))
}

// 0.5 would hold total surface area exactly. It is deliberately under that:
// inflating a tuft in place buys new coverage only where it reaches a gap, and
// it always buys overlap with the neighbours it already touched, so an
// area-preserving grow measurably RAISES fill relative to the full crown. Under-
// growing trades a little coverage for a crown that actually gets cheaper as it
// coarsens, which is the whole point of a rung.
const GROW_POWER = 0.40
const GROW_CAP = 2.4

/**
 * Bake each voxel's exposure: 1 where nothing is near it, falling toward
 * `aoFloor` where it is buried in its neighbours. Writes `v.expo`.
 *
 * The occluder weight is a neighbour's PROJECTED AREA over its distance
 * squared, which is the solid angle it steals -- so one big tuft close in
 * darkens as much as four small ones twice as far, the way it should.
 */
function bakeExposure(voxels, p) {
  const R = Math.max(1e-3, p.aoRadius), R2 = R * R
  const cell = R
  const grid = new Map()
  const key = (i, j, k) => `${i},${j},${k}`
  const at = (c) => [Math.floor(c[0] / cell), Math.floor(c[1] / cell), Math.floor(c[2] / cell)]
  for (let i = 0; i < voxels.length; i++) {
    const [a, b, c] = at(voxels[i].c)
    const k = key(a, b, c)
    let bucket = grid.get(k)
    if (!bucket) grid.set(k, (bucket = []))
    bucket.push(i)
  }
  for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i]
    const [a, b, c] = at(v.c)
    let occ = 0
    for (let da = -1; da <= 1; da++) {
      for (let db = -1; db <= 1; db++) {
        for (let dc = -1; dc <= 1; dc++) {
          const bucket = grid.get(key(a + da, b + db, c + dc))
          if (!bucket) continue
          for (const j of bucket) {
            if (j === i) continue
            const q = voxels[j]
            const dx = q.c[0] - v.c[0], dy = q.c[1] - v.c[1], dz = q.c[2] - v.c[2]
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 >= R2) continue
            // Above counts more than below: light arrives from the sky, so a
            // neighbour overhead is the one that actually shades this tuft.
            const above = 0.55 + 0.45 * (dy / Math.sqrt(d2 + 1e-6))
            occ += (q.size * q.size) * above / (d2 + 0.02)
          }
        }
      }
    }
    v.expo = Math.max(p.aoFloor, 1 / (1 + p.aoStrength * occ))
  }
}

/**
 * Greedy farthest-point order, biased by voxel size. Returns an index array
 * into `voxels`; a prefix of it is a spread, size-weighted subset.
 *
 * O(n^2) at ~2,000 voxels, which is ~30 ms and paid once per bake. A blue-noise
 * hash would be cheaper and would not honour the size bias, which is what stops
 * a coarse rung from being made of the tree's smallest tufts.
 */
function farthestPointOrder(voxels) {
  const n = voxels.length
  if (n === 0) return []
  const order = new Int32Array(n)
  const best = new Float64Array(n).fill(Infinity)
  const taken = new Uint8Array(n)
  // Seed with the largest voxel rather than an arbitrary one, so rung 5 is a
  // handful of big tufts instead of a handful of whichever came first.
  let cur = 0
  for (let i = 1; i < n; i++) if (voxels[i].size > voxels[cur].size) cur = i
  for (let k = 0; k < n; k++) {
    order[k] = cur
    taken[cur] = 1
    const c = voxels[cur].c
    let pick = -1, pickScore = -1
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue
      const q = voxels[i].c
      const dx = q[0] - c[0], dy = q[1] - c[1], dz = q[2] - c[2]
      const d = dx * dx + dy * dy + dz * dz
      if (d < best[i]) best[i] = d
      const score = best[i] * voxels[i].size
      if (score > pickScore) { pickScore = score; pick = i }
    }
    if (pick < 0) break
    cur = pick
  }
  return Array.from(order)
}

// Mean projected area of one blob, which for any convex body is a quarter of
// its surface area. The blob is scaled anisotropically, so this is measured off
// the actual scaled faces rather than from a regular-solid constant.
function alongPolyline(pts, u) {
  const f = Math.min(pts.length - 1.001, Math.max(0, u * (pts.length - 1)))
  const i = Math.floor(f), t = f - i
  const a = pts[i], b = pts[Math.min(pts.length - 1, i + 1)]
  return { p: [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)], tan: norm(sub(b, a)) }
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
function norm(a) {
  const l = len(a) || 1e-6
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ---------------------------------------------------------------------------
// THE MATERIAL. No texture, no alpha channel, NO `discard` -- the three
// properties the whole idea rests on. Fragment work is a wrap-diffuse term, a
// hemisphere ambient and a transmission lobe over three varyings, which is the
// same shape props/grass-blades.js ships.
//
// TRANSMISSION IS WHY THIS DOES NOT NEED ALPHA. What reads as light coming
// through a canopy is not translucency at the leaf, it is backlit foliage
// glowing when you look toward the sun. `pow(dot(V, -L), k)` scaled by how
// close a voxel sits to the crown's rim is that, and it costs four ALU ops. A
// cutout cannot do it at all.
// ---------------------------------------------------------------------------

export function createVoxelFoliageMaterial(opts = {}) {
  const uniforms = {
    uSun: { value: new THREE.Vector3(0.44, 0.74, 0.30).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.955, 0.885) },
    uSkyColor: { value: new THREE.Color(0.42, 0.55, 0.72) },
    uGroundColor: { value: new THREE.Color(0.17, 0.15, 0.11) },
    uSunStrength: { value: 2.05 },
    uAmbient: { value: 0.46 },
    uWrap: { value: 0.24 },
    uTransmit: { value: 0.85 },
    uTransmitPower: { value: 3.5 },
    uGrow: { value: 1 },
    uVoxelCount: { value: 1e9 },
    // The needle tile, and the mean it is divided by. Dividing by the mean is
    // what makes the texture a MODULATION rather than a repaint: unit average,
    // so the crown keeps the colour the vertex palette was tuned to and the
    // image only supplies the grain and the hue break-up on top of it. Nothing
    // ever reads its alpha -- the tile is solid, and asking the alpha test a
    // question is what would cost this draw its low-resolution-Z.
    uMap: { value: null },
    uMapMean: { value: new THREE.Vector3(1, 1, 1) },
    uMapMix: { value: 0 },
    uFogColor: { value: new THREE.Color(0x0a1018) },
    uFogNear: { value: 40 },
    uFogFar: { value: 200 },
    ...opts.uniforms,
  }

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute vec4 aCentre;
      attribute float aVoxel;
      // uvProj, not uv: the whole prop library names its texture coordinate
      // that, and ShaderMaterial's built-in uv is simply not on this geometry.
      // Sample the built-in one and every leaf in the crown reads texel (0,0).
      attribute vec2 uvProj;
      uniform float uGrow;
      uniform float uVoxelCount;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vView;
      varying float vOpen;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        // THE LADDER AND THE DISSOLVE, both here, both free. A voxel past the
        // rung's count collapses onto its own centre, which makes all four of
        // its triangles degenerate -- killed at the primitive stage, with no
        // fragment shader run and no \`discard\` to cost the draw its
        // low-resolution-Z. Survivors inflate to hold the coverage.
        vec3 p = aCentre.xyz + (position - aCentre.xyz) * uGrow;
        if (aVoxel >= uVoxelCount) p = aCentre.xyz;

        vColor = color;
        vUv = uvProj;
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = -mv.xyz;
        vDepth = -mv.z;
        // The baked exposure, so the transmission lobe lights the rim of the
        // crown and leaves the buried tufts dark -- which is what backlit
        // foliage actually does.
        vOpen = aCentre.w;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uSunColor, uSkyColor, uGroundColor, uFogColor;
      uniform float uSunStrength, uAmbient, uWrap, uTransmit, uTransmitPower;
      uniform float uFogNear, uFogFar;
      uniform sampler2D uMap;
      uniform vec3 uMapMean;
      uniform float uMapMix;
      varying vec3 vNormal;
      varying vec3 vColor;
      varying vec3 vView;
      varying float vOpen;
      varying float vDepth;
      varying vec2 vUv;

      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(vView);
        // The needle grain. One fetch, colour only, and the result is divided
        // by the tile's own mean so it averages to white and multiplies the
        // palette instead of replacing it.
        vec3 albedo = vColor;
        if (uMapMix > 0.0) {
          vec3 t = texture2D(uMap, vUv).rgb / uMapMean;
          albedo *= mix(vec3(1.0), t, uMapMix);
        }
        // A leaf is drawn double-sided, so the crown normal it carries can tip
        // past the horizon and face away from the sun. A wrap term is what
        // keeps that from going black.
        float ndl = dot(n, uSun);
        float diff = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
        // Hemisphere ambient off the crown normal: the top of the canopy sees
        // sky, the underside sees ground.
        vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5) * uAmbient;
        // Backlit foliage. Looking toward the sun through the rim of a crown is
        // the thing a cutout is usually reached for, and it is four ALU ops.
        float back = pow(clamp(dot(v, -uSun), 0.0, 1.0), uTransmitPower);
        vec3 lit = albedo * (amb + uSunColor * uSunStrength * diff)
                 + albedo * uSunColor * back * uTransmit * vOpen;
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
      }
    `,
    vertexColors: true,
    // A leaf is a flat plate, so it has to be there from behind. Culling it
    // would delete half the crown from inside, and there is no cheaper closed
    // shape: the next one up is four triangles for the same coverage.
    side: THREE.DoubleSide,
    transparent: false,
  })
}
