import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildTrunkV8, buildFoliageV8, resolveTreeV8, treeV8Lod, TREE_V8_SPECIES, treeV8Species,
} from './props/tree-v8.js'
import { buildTreeOak, resolveTreeOak, treeOakLod, TREE_OAK_SPECIES, treeOakSpecies } from './props/tree-oak.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-v8.js AND props/tree-oak.js. Read those files'
// headers for what each tree is, and /gen-tree-v6's bench for the panel
// conventions -- the LOD slider first, the orange label the moment a value
// leaves its default, the copy button, the four-rung ladder. This page is that
// page pointed at boughs, and at scoops.
//
// TWO GENERATORS, ONE PAGE. The conifers and the v8 broadleaf are whorls of
// cloaks; the oak is crooked tubes under a litter of scoops. They share no
// parameter, no triangle law and no mesh primitive, so each is a GENERATOR
// descriptor below -- its sliders, its ladder, its build and the words for its
// budget table -- and the species dropdown picks a generator as well as a
// parameter set. The stage, the card bake, the camera, the crown material and
// the panel plumbing are the same for both, which is the whole reason they
// share a page.
//
// THE MAT IS OPAQUE ON BOTH, AT EVERY RUNG. v6 wears a cut-out at LOD0 and
// swaps to the opaque tile past it; here the silhouette is modelled, the air
// between the boughs and between the scoops being geometry and not alpha. So
// there is no cutout slider and no swap in the ladder. A cloak and a scoop are
// both sheets, seen from both faces, so one double-sided material dresses
// every crown.
//
// THE SPECIES DROPDOWN sits above every slider because it moves every slider
// -- and, crossing generators, replaces them. Picking one replaces the
// parameter set AND the baseline the orange labels are measured against, so an
// orange row always means "away from THIS tree's shape", never "away from the
// pine". It also swaps the foliage mat, each species carrying its own.
// ---------------------------------------------------------------------------

// --- slider specs -----------------------------------------------------------
// `['#', title]` starts a group. Ranges are chosen so both ends are things you
// would plausibly want to SEE, not so both ends are good: `boughWidth` past ~0.7
// makes neighbouring cloaks pass clean through each other and the whorl closes
// back up into a cone, and watching that happen is how you learn where the
// range stops.
const V8_SLIDERS = [
  ['#', 'tier'],
  ['lod', 0, 3, 1, 'which rung to draw. 0, 1 and 2 are meshes and each is a SUBSET of LOD0 -- fewer spine stations, then whole boughs and whole whorls dropped, over a wedge of a trunk -- so every tip that survives is on the point LOD0 put it and switching rungs moves nothing. 3 is the card, one spun quad carrying a photograph of LOD0 baked off the tree in front of you. Every mesh rung wears the same opaque mat, v8 having no use for a cut-out'],

  ['#', 'size'],
  ['height', 1, 32, 0.25, 'metres, root to tip. Every shape slider below is a fraction of this, so the tree scales rather than growing'],

  ['#', 'trunk'],
  ['trunkSides', 3, 32, 1, 'sides around the trunk, costing `sides` triangles per ring. v1 spends 25 because a player stands against its trunk; a whorl crown hides most of what is above the lowest one, so this only has to hold up over the bare metres under it'],
  ['trunkLobe', 0, 0.5, 0.01, 'how far out of round, as a fraction of the radius. Three harmonics at a phase this tree drew for itself. Needs sides to spend: under 6 it is ignored'],
  ['trunkRings', 1, 6, 1, 'rings below the apex. The trunk always closes to a point, so 1 is a plain cone; raise it to let trunkBend curve rather than lean'],
  ['trunkRadius', 0, 0.09, 0.001, 'base radius as a FRACTION of height -- the panel prints the centimetres'],
  ['trunkBend', 0, 0.3, 0.005, 'sideways offset of the top, as a fraction of height. The whorls follow it: their axis is MEASURED off the built trunk, not recomputed'],
  ['barkRepeat', 0.5, 16, 0.5, 'bark tiles UP the trunk this many times. The tiling AROUND it is derived so a tile stays roughly square in world space'],

  ['#', 'roots'],
  ['roots', 0, 10, 1, 'spurs off the trunk\'s foot, diving into the soil, two triangles each. LOD0 only -- every coarse tier drops them, because the flare is centimetres of silhouette at the bottom of a tree that is by then a few dozen pixels tall'],
  ['rootRise', 0, 0.25, 0.005, 'MEAN height up the trunk of a spur\'s ridge corner, as a fraction of height. Each spur draws its own 40% either way'],
  ['rootLength', 0, 0.4, 0.005, 'spur length as a fraction of height, jittered 30% either way per spur'],
  ['rootAngle', 0, 1.5, 0.01, 'radians BELOW horizontal at the launch. Near 0 the spurs run along the surface; past ~1 they dive and almost nothing shows'],
  ['rootDroop', 0, 1.5, 0.01, 'how much further down the spur bends along its own length. A spur is a straight wedge, so this moves only where the tip lands'],
  ['rootWidth', 0, 2, 0.05, 'half a spur\'s width at the ground, as a fraction of the TRUNK\'s radius at its foot. Over 1 is deliberate: a buttress is wider than the trunk at the soil line. 0 draws no crown at all'],

  ['#', 'the stack'],
  ['skirts', 1, 28, 1, 'whorls up the trunk. The whole density knob, and at `boughs` x (4 x boughSpine - 6) triangles each it is also most of the crown budget'],
  ['skirtBottom', 0, 0.8, 0.01, 'fraction of height the LOWEST whorl sits at. This is the bare-trunk knob'],
  ['skirtTop', 0.3, 1, 0.01, 'and the highest. In the whorled form that one is PINNED -- it takes no stagger and no shift, so at 1 its boughs launch from the trunk\'s own measured tip, and under ~0.95 the tree ends in a bare spike. The ascending form does not pin it, a ring of limbs off a single point at the top of a tree being the pointed peak a broadleaf does not have; there this is where the headroom a limb climbs into runs out'],
  ['skirtStagger', 0, 1.5, 0.05, 'how far a whorl may wander inside its own gap, as a fraction of that gap. 0 leaves the spacing exactly as spacingByLength set it'],
  ['spacingByLength', 0, 1, 0.01, 'how much of the gap above a whorl is set by how long that whorl\'s boughs are. 0 spaces the stack evenly; at 1 a full-width whorl takes the whole gap and the short ones at the tip and the foot crowd together, which is how a conifer actually stacks -- a whorl\'s own needles are what fill the space over it'],
  ['crownRadius', 0.03, 0.5, 0.005, 'the WIDEST whorl\'s reach, as a fraction of height'],
  ['crownPeak', 0, 1, 0.01, 'where up the stack that widest whorl sits. 0 = cone (spruce), 0.5 = round, 1 = inverted'],
  ['crownFullness', 0.2, 3, 0.05, 'falloff from that peak. <1 fuller and blockier, >1 pointier and sparser'],
  ['skirtMin', 0, 1, 0.01, 'smallest whorl as a fraction of the widest, so the top and the hem still carry foliage instead of collapsing to a point'],
  ['topGrow', 0, 1, 0.01, 'how much bigger the TOP whorl is than the crown profile asks for. It is pinned to the trunk tip, so unlike every other whorl it cannot wander down to close the gap to the one below it -- and the profile makes it the shortest whorl on the tree. At 0 the tip shows bare wood'],

  ['#', 'one whorl'],
  ['boughs', 3, 20, 1, 'boughs around a whorl, costing 4 x boughSpine - 6 triangles each. THE knob for this whole scheme: at 3 the whorl is a claw, and by ~14 the cloaks close up and you have paid v6\'s triangles for v6\'s cone with extra seams in it. The air between them is the entire reason v8 exists'],
  ['skirtDrop', 0.1, 2, 0.05, 'how far a bough hangs, as a multiple of its whorl\'s OWN reach. Above ~0.5 the whorls overlap, which is what makes the stack a canopy rather than a set of shelves. In the ascending form it is the sign and the measure both: a limb CLIMBS this fraction of the trunk it has left above it, so one low on the bole sweeps up hard and one at the tip runs out level'],
  ['dropByHeight', 0, 3, 0.05, 'and how much further, in proportion, the whorls near the tip hang. Their boughs are short up there, so on skirtDrop alone the drop shrinks with the reach and the trunk shows between them. The one shape term that reads height rather than being a pure fraction of its own whorl. In the ascending form it is the OVERSHOOT: how far past the trunk\'s tip a limb may climb, in its own reach, which is what rounds the top of the crown over instead of cutting it flat'],
  ['skirtBow', 0, 0.4, 0.01, 'how far a limb turns its ANGLE up over its length -- four radians per unit, so 0.1 is about 23 degrees -- leaving the trunk steeply and flattening out toward the tip. The turn is split evenly over the bough\'s joints, which is what makes it read as a curve: split evenly in SLOPE instead and the outer joint rotates half again as far as the inner one, and the limb reads as a hinge with a straight stick on it. Every bough turns up and this is the MEAN of a per-bough draw, so the slider moves the whole whorl together rather than moving how many limbs turn and how many hang; at 0 every spine is a straight line. Drawn per bough and not per whorl because one curve for a whole whorl gives a surface of revolution again, which is the shape the eye reads as turned on a lathe'],
  ['skirtLean', 0, 0.5, 0.01, 'radians a whorl\'s axis may tip off the trunk\'s, drawn per whorl. Neighbours lean independently, so the stack reads as whorls that grew crooked rather than as a tree bent over'],
  ['skirtShift', 0, 0.6, 0.01, 'and how far its launch point may slide off the axis, as a fraction of its own reach. The top whorl ignores it, its launch being the tip of the tree'],

  ['#', 'the ascending form'],
  ['limbScatter', 0, 1.5, 0.05, 'how far a limb\'s launch wanders up and down the trunk off its whorl\'s own stop, as a fraction of the whole stack\'s span. Inert unless the species is ascending -- pine, aspen and birch never read it -- and on an oak it is THE knob that dissolves the rings. A ring of limbs all leaving the trunk at one height is the tell that reads as a conifer whichever way the limbs then point, so at 0 an ascending crown is still a stack of tidy whorls with its boughs on backwards'],
  ['limbFork', 0, 1, 0.05, 'and the chance a limb leaves off the LIMB BEFORE IT instead of off the trunk, up to two forks deep. A fork costs exactly what a primary limb costs and comes out of the same `boughs`, so this trades spokes for sub-branches and adds no triangles at all. At 0 the crown is six long limbs a whorl however chaotically they are aimed'],
  ['forkSpread', 0, 1.6, 0.05, 'radians a fork swings off its parent\'s azimuth, signed per fork. At 0 it carries straight on and the pair reads as one long limb with a kink; up near 1.5 a fork turns back across the crown'],

  ['#', 'one bough'],
  ['boughSpine', 3, 8, 1, 'stations down a bough\'s spine, and so 3N-2 vertices and 4N-6 triangles for the bough. They are NOT evenly spaced: they crowd toward the tip, because the inner stretch of a bough is under the whorl above and under its own cloaks, and a bend nobody can see is a bend not worth paying for. At 3 a bough is one bow; past 5 it starts to curl'],
  ['boughVary', 0, 0.8, 0.01, 'per-bough shortening, as a fraction of the whorl\'s reach. The whole reason a whorl has an outline: at 0 every limb ends on the same circle and the silhouette is that circle'],
  ['boughLift', 0, 1, 0.01, 'how far a SHORT bough rides back UP, as a fraction of its own shortening -- one draw drives both, because a limb that stops short stops higher on the cone too. At 1 the tips stay roughly on the shell; at 0 they are cut flat and the short ones sink inside, where the silhouette is a plain circle again'],
  ['boughSpread', 0, 1.2, 0.01, 'how far a bough slides AROUND off the even angle its index would give it, as a fraction of the angular step. Evenly spaced limbs are most of what reads as machined. Past 1 neighbours can trade places, which is legal here -- their cloaks already cross'],
  ['boughTilt', 0, 1, 0.01, 'and how far it pitches up or down on top of the lift, as a fraction of its whorl\'s drop. Signed, unlike the lift, so a whorl is ragged rather than merely uneven'],
  ['midBend', 0, 1, 0.01, 'how much of the shortening the spine\'s MIDPOINT inherits. 0 pulls only the tip in and leaves the rest of the bough out at full reach; up near 1 a short bough is short along its whole length'],
  ['boughWidth', 0, 0.9, 0.01, 'half a cloak\'s width at its widest, as a fraction of that bough\'s own length, redrawn at every station on both sides so a limb is lopsided and its rim is jagged. Wide enough and neighbouring cloaks cross, which is wanted -- crossing cloaks are most of what makes a crown look grown. A corner near the butt is held under its own reach whatever this says, or the hem starts as one wide flat triangle instead of running out to the tip'],
  ['boughTaper', 0, 1.2, 0.01, 'and the width AT THE TIP as a fraction of that, so a bough narrows going out. Every corner is scaled by its own out-ness along this ramp, which is what lets the MIDDLE of a hem narrow as hard as its end and so lets a bough come to a real point. Over 1 flares it, which reads as a paddle'],
  ['boughDroop', 0, 2, 0.02, 'how far the cloak sags below the spine, as a fraction of its own half-width. A fraction of the width rather than a length, because a wider cloak has more to hang: this is what gives a bough a ridge and two falling sides instead of a flat fin'],
  ['boughCrook', 0, 0.5, 0.01, 'sideways bend through the spine\'s middle, as a fraction of the whorl\'s reach, going to zero at both ends so the tip stays on its own azimuth. The spine is otherwise straight in plan, and a whorl of straight spokes reads as a wheel however ragged its ends are'],

  ['#', 'shading'],
  ['innerShade', 0, 1, 0.01, 'how dark every bough\'s BUTT is baked, as a multiple of the tip\'s brightness. A crown is a stack of overlapping shells and no light rig the game can afford knows a whorl is under another one, so the occlusion is baked into the vertices -- lit honestly, every layer takes the same sun and the stack reads as one green mass. 1 turns it off'],
  ['shadeToTip', 0, 1, 0.01, 'how much of that darkening the TOP whorl is let off. Only the top one: its boughs are the only boughs on the tree with open sky above them. At 1 the peak is unshaded, which is what makes it read as the top rather than as another layer'],
  ['midShade', 0, 1, 0.01, 'how much of the butt\'s darkening a fully covered INTERIOR station takes. Coverage is measured per station against the reach of the whorl above, so the stations nearer a butt go darker than the ones out past the whorl overhead, and a short limb under a wide whorl goes darker than the long one beside it. This is what gives each layer its own depth instead of a dark spot at the trunk'],

  ['#', 'material'],
  ['texMetres', 0.15, 4, 0.05, 'one needle tile, in metres, on both axes of a cloak. Each bough draws its own offset into the tile AND its own turn of it, so no two carry the same needles in the same place or running the same way'],
  ['leafSkyward', 0, 1, 0.01, 'how far a bough normal turns toward the sky. The black-underside knob: 0 shades each cloak by its own two panels, 1 shades the crown as if lit from above'],
  ['brightness', 0.4, 3, 0.05, 'multiplies the albedo of both materials. A material property, not geometry'],
]

const OAK_SLIDERS = [
  ['#', 'tier'],
  ['lod', 0, 3, 1, 'which rung to draw. 0, 1 and 2 are meshes: LOD1 keeps three scoops in five and LOD2 one in four, each in LOD0\'s own seat, and both take sides off the wood. 3 is the card, one spun quad carrying a photograph of LOD0 baked off the tree in front of you'],

  ['#', 'size'],
  ['height', 1, 32, 0.25, 'metres, root to the top of the crown. Every shape slider below is a fraction of this, so the tree scales rather than growing'],

  ['#', 'trunk'],
  ['trunkSides', 3, 24, 1, 'sides around the bole, costing `sides` x 2 triangles per segment'],
  ['trunkSegments', 1, 8, 1, 'crooked segments up the bole. 1 is a straight cone; the warp needs joints to happen at, and 3 is enough to read as a lean that changes its mind'],
  ['trunkCrook', 0, 0.5, 0.01, 'radians a joint may turn, about an azimuth of its own. At 0 the bole is straight whatever the segments say'],
  ['trunkTop', 0.2, 0.9, 0.01, 'the bole\'s length as a fraction of height, before the rescale that puts the highest scoop at the height'],
  ['trunkRadius', 0, 0.09, 0.001, 'base radius as a FRACTION of height -- the panel prints the centimetres'],
  ['trunkTaper', 0, 1, 0.01, 'the last ring\'s radius as a fraction of the base\'s. A bole does not run to a point the way a conifer\'s does: the closing point is the cap, lost among the scoops'],
  ['trunkLobe', 0, 0.5, 0.01, 'how far out of round, as a fraction of the radius. Three harmonics at a phase this tree drew for itself, running straight up the bole. Needs sides to spend: under 6 it is ignored'],
  ['barkRepeat', 0.5, 16, 0.5, 'bark tiles UP the bole this many times. The tiling AROUND it, and along every branch, is derived so a tile stays roughly square in world space'],

  ['#', 'branches'],
  ['branches', 0, 12, 1, 'limbs off the bole, which is where every scoop stems from: the litter is spread over them evenly, so more limbs means fewer scoops each. Costs a tube apiece, and 0 leaves the crown with nothing to seat on'],
  ['branchSegments', 1, 8, 1, 'crooked segments per branch, each (sides x 2) triangles and the last closing to a point for `sides`'],
  ['branchCrook', 0, 0.8, 0.01, 'radians a joint may turn, pitch and yaw drawn separately per joint. 0 is a straight stick'],
  ['branchRise', -0.3, 0.5, 0.01, 'and how far every joint turns UP on top of that, so a limb leaves reaching out and finishes reaching up. Negative droops'],
  ['branchBottom', 0, 1, 0.01, 'fraction of the BOLE the lowest branch leaves at. Each branch takes its own slot between this and branchTopEnd, in order, so five branches are five heights and never a ring'],
  ['branchTopEnd', 0, 1, 0.01, 'and the highest'],
  ['branchLength', 0.05, 0.8, 0.01, 'a branch\'s length as a fraction of height'],
  ['branchVary', 0, 0.8, 0.01, 'per-branch shortening, as a fraction of that. At 0 every tip is on the same sphere'],
  ['branchPitch', -0.5, 1.4, 0.01, 'radians above horizontal at the launch, the mean'],
  ['branchPitchVary', 0, 0.8, 0.01, 'and the half-range of the per-branch draw around it'],
  ['branchSpread', 0, 1.2, 0.01, 'how far a branch slides AROUND off its even azimuth, as a fraction of the angular step. Past 1 neighbours can trade places'],
  ['branchSides', 3, 12, 1, 'sides around a branch'],
  ['branchRadius', 0, 1, 0.01, 'butt radius as a fraction of the bole\'s where it leaves'],
  ['branchTaper', 0, 1, 0.01, 'the last ring\'s radius as a fraction of the butt\'s'],

  ['#', 'the scoops'],
  ['boughs', 0, 160, 1, 'scoops littered over the branches, five triangles each: a pentagon fanned from a centre pushed out of its plane, like a shallow bowl. THE budget knob. The count is how many the tree HAS; the ladder keeps a fraction of them without moving one'],
  ['boughRadius', 0.02, 0.2, 0.005, 'a scoop\'s rim radius as a fraction of height'],
  ['boughVary', 0, 0.8, 0.01, 'per-scoop half-range around that, as a fraction, so the litter is of irregular sizes'],
  ['boughDepth', 0, 1.2, 0.01, 'how far the centre is pushed out of the rim\'s plane, in rim radii. 0 is a flat pentagon; 0.5 is a saucer; 1 is a cup'],
  ['boughJitter', 0, 0.6, 0.01, 'per-vertex radial jitter, half-range as a fraction of the rim radius. Every rim corner draws its own, the stem on top of its reach, so no two scoops are the same shape'],
  ['stemReach', 0.3, 3, 0.05, 'the STEM vertex\'s distance from the centre in rim radii, where every other rim corner is at one. The stem is the corner that touches the wood, so this is how far a scoop hangs off its branch rather than being pinned through the middle'],
  ['boughAims', 1, 64, 1, 'a scoop is AIMED to be as un-parallel to its neighbours as it can: this many openings are tried, spread evenly over a hemisphere about a pole drawn at random for each scoop, and the one least parallel to the scoops already within three rim radii of it, nearest weighted most, wins. 1 is a random facing; more spreads the litter better, at build time'],
  ['boughSpins', 1, 12, 1, 'body directions tried round the stem for each opening, from a drawn start, so a scoop can also reach to where nothing faces its way. Scoops may cross each other; that is not scored'],
  ['boughSkew', 0, 0.9, 0.01, 'the rim stretched by this along an axis of its own and squeezed by the same across it, so a scoop is an oval and not a regular pentagon'],
  ['boughFrom', 0, 1, 0.01, 'the fraction of a branch nothing seats below. The butt end of a limb near the bole stays bare'],
  ['tipBias', 0.2, 5, 0.05, 'how the seats crowd along a branch: the draw is raised to 1/this, so above 1 they bunch toward the tips and below 1 toward the butt'],
  ['tipZone', 0, 1, 0.01, 'scoops seated within this fraction of a branch\'s tip refuse any body that runs back down the limb, so a limb\'s end holds scoops reaching past it at every other angle. 0 and no scoop refuses; 1 and every scoop does'],

  ['#', 'shading'],
  ['innerShade', 0, 1, 0.01, 'how dark the crown\'s LOWEST vertex is baked, as a multiple of the highest. The scoops are lit honestly, but the low ones sit under the high ones and no rig the game can afford knows it. 1 turns the ramp off'],
  ['boughTint', 0, 0.3, 0.01, 'per-scoop brightness jitter, half-range, so neighbouring scoops separate instead of merging into one green'],

  ['#', 'material'],
  ['texMetres', 0.15, 4, 0.05, 'one leaf tile, in metres, laid flat in each scoop\'s own plane at an offset the scoop drew for itself'],
  ['brightness', 0.4, 3, 0.05, 'multiplies the albedo of both materials. A material property, not geometry'],
]

// --- generators -------------------------------------------------------------
//
// One descriptor per crown architecture. `build(opts)` returns two geometries
// and one flat `stats` object, and everything the budget column prints about a
// tree is either a stats field or a function of the resolved law, so adding a
// generator is adding a descriptor and nothing in refresh().
//
//   sliders     the panel, in the spec above
//   notShape    parameter keys the LADDER writes per tier and the copy leaves
//               out -- see NOT_SHAPE
//   defaults    a species' full parameter set; mat its foliage tile
//   lod/resolve the ladder and the triangle law, the same pair the builder
//               grows from, so a change to either moves the table with it
//   parts       the breakdown rows: [label(meshParams, resolved), statsKey]
//   ladderWhat  the words beside a rung
//   measure     the generator's own rows in the metre table
//   geonote     the prose under the budget
const GEN_V8 = {
  sliders: V8_SLIDERS,
  notShape: ['skirtKeep', 'boughKeep'],
  defaults: treeV8Species,
  mat: (key) => TREE_V8_SPECIES[key].mat,
  lod: treeV8Lod,
  resolve: resolveTreeV8,
  build(opts) {
    const { geometry: trunk, frame, tree } = buildTrunkV8(opts)
    const foliage = buildFoliageV8(opts, frame)
    const f = foliage.userData.foliage
    return {
      trunk,
      foliage,
      stats: {
        height: tree.height,
        belowGround: tree.belowGround,
        trunkDiameter: tree.trunkDiameter,
        crownWidth: Math.max(f.crownRadius * 2, tree.crownWidth),
        crownBase: f.crownBase,
        crownTop: f.crownTop,
        skirts: f.skirts,
        boughs: f.boughs,
        spine: f.spine,
        trunkTris: tree.trunkTris,
        rootTris: tree.rootTris,
        boughTris: f.triangles,
        triangles: tree.triangles + f.triangles,
        vertices: tree.vertices + f.vertices,
      },
    }
  },
  parts: [
    [(p, r) => `trunk ${r.trunkTris > 0 ? `${Math.round(p.trunkSides)} sides &times; ${Math.round(p.trunkRings)}` : '&mdash;'}`, 'trunkTris'],
    [(p, r) => `roots ${r.roots}&times;2`, 'rootTris'],
    [(p, r) => `boughs ${r.skirts}&times;${r.boughs}&times;${4 * r.spine - 6}`, 'boughTris'],
  ],
  ladderWhat: (p, r) => `${Math.round(p.trunkSides)}-side trunk, ${r.skirts}x${r.boughs} boughs of ${r.spine}`,
  measure(f, p, crownH) {
    return [
      // Not a measurement, and here anyway: it is the one fact about the tree
      // that changes what half the rows above mean, and there is no slider it
      // could have been a row of instead.
      ['crown form', p.crownForm],
      ['whorls on it', `${f.skirts} @ ${f.boughs} boughs`],
      ['spine stations', `${f.spine} a bough, ${3 * f.spine - 2} vertices`],
      ['boughs in all', f.skirts * f.boughs],
      ['one whorl covers', `${(crownH / Math.max(1, f.skirts)).toFixed(2)} m of stack`],
    ]
  },
  geonote: (mat, p) =>
    `Two meshes and two draw calls per tree: the trunk is the shared prop material over the texture ` +
    `array, exactly as the game draws bark, and the crown is one OPAQUE mapped Lambert over ` +
    `<em>${mat}</em> tiled at <em>${p.texMetres.toFixed(2)} m</em> &mdash; no cut-out at ` +
    `any tier, a bough's outline being geometry. There is no third primitive: v8 has no wood in its ` +
    `crown, so every triangle above is either the trunk or a cloak.`,
  ladderNote:
    `The <em>LOD</em> slider at the top of the panel is this table, live. Three of the four rungs ` +
    `are the same tree with less of it drawn: first a <em>spine station</em> out of every bough, ` +
    `which costs bends nobody reads at range, and then whole <em>boughs</em> and whole ` +
    `<em>whorls</em>. Every rung is a <em>subset</em> of LOD0 -- not one triangle moves, and ` +
    `every tip that survives is on the point LOD0 put it. That is the difference between ` +
    `<em>dropping</em> boughs and <em>asking for fewer</em>: the counts are how many times the ` +
    `stack walks its random stream, so lowering one reseeds the whole crown and the switch becomes ` +
    `a different plant. Switch between the rungs on the stage and you should see limbs straighten ` +
    `and then thin out, with nothing jumping. Both losses are harder than v6's, where dropping ` +
    `spokes off a cone of revolution takes notches and keeps the cone. That is the price of ` +
    `spending the triangles on separate boughs, and what it buys is the air between them: unlike ` +
    `v6 the mat never changes down the ladder, because a v8 silhouette is modelled and there is no ` +
    `cut-out to swap out. The last rung is one spun quad carrying a photograph of LOD0, baked here ` +
    `and now off the tree on the stage.`,
}

const GEN_OAK = {
  sliders: OAK_SLIDERS,
  notShape: ['boughKeep'],
  defaults: treeOakSpecies,
  mat: (key) => TREE_OAK_SPECIES[key].mat,
  lod: treeOakLod,
  resolve: resolveTreeOak,
  build(opts) {
    return buildTreeOak(opts)
  },
  parts: [
    [(p, r) => `trunk ${r.trunkSides} sides &times; ${r.trunkSegments}`, 'trunkTris'],
    [(p, r) => `branches ${r.branches} &times; ${r.branchSides} sides &times; ${r.branchSegments}`, 'branchTris'],
    [(p, r) => `scoops ${r.boughs}&times;5`, 'boughTris'],
  ],
  ladderWhat: (p, r) => `${r.trunkSides}-side bole, ${r.branches} limbs, ${r.boughs} scoops`,
  measure(f) {
    return [
      ['bole', `${f.boleHeight.toFixed(2)} m to its cap`],
      ['limbs', `${f.branches}, ${f.branchTris} triangles of wood`],
      ['scoops', `${f.boughs} of five triangles`],
    ]
  },
  geonote: (mat, p) =>
    `Two meshes and two draw calls per tree: the wood is the shared prop material over the texture ` +
    `array, the bole and every branch in one buffer, and the crown is one OPAQUE mapped Lambert over ` +
    `<em>${mat}</em> tiled at <em>${p.texMetres.toFixed(2)} m</em>, on both faces: a scoop is a ` +
    `sheet, seen from below as much as from above, and its normal is authored on each face's sky ` +
    `side whichever way it opens, so the underside takes the same light as the top.`,
  ladderNote:
    `The <em>LOD</em> slider at the top of the panel is this table, live. Three of the four rungs ` +
    `are the same tree with less of it drawn: LOD1 keeps <em>three scoops in five</em> and LOD2 ` +
    `<em>one in four</em>, and both take sides off the wood, whose rings stay on the same crooked ` +
    `path. Every scoop is drawn from the stream at every tier and only its emit is skipped, so a ` +
    `rung is a subset of LOD0 in LOD0's own seats -- switch between them and scoops vanish without ` +
    `one of the survivors moving. The seats are drawn in random order over the limbs, so the ` +
    `survivors are an even thinning and not one bare branch. The last rung is one spun quad ` +
    `carrying a photograph of LOD0, baked here and now off the tree on the stage.`,
}

// The dropdown. A row is a generator and the key that generator knows the
// species by. The three broadleaves are scoop trees; v8's own readings of
// them stay on the list beside each, since the two are the argument for the
// second generator, and the argument should be visible.
const SPECIES = {
  pine: { gen: GEN_V8, key: 'pine', label: TREE_V8_SPECIES.pine.label },
  oak: { gen: GEN_OAK, key: 'oak', label: 'oak' },
  'oak-v8': { gen: GEN_V8, key: 'oak', label: 'oak (v8 boughs)' },
  aspen: { gen: GEN_OAK, key: 'aspen', label: 'aspen' },
  'aspen-v8': { gen: GEN_V8, key: 'aspen', label: 'aspen (v8 boughs)' },
  birch: { gen: GEN_OAK, key: 'birch', label: 'birch' },
  'birch-v8': { gen: GEN_V8, key: 'birch', label: 'birch (v8 boughs)' },
}

// design/05-rendering.md's tree row: two mesh tiers at 550 and 380, and a near
// card of three quads. v8 runs FOUR rungs against that ladder's three, so the
// 190 is this page's own number rather than the doc's, and it is half of LOD1
// on purpose: a third mesh rung's entire justification is being much cheaper
// than the one above it, so a LOD2 that cannot halve LOD1 is a rung that should
// not be built at all.
const CLASS_BUDGET = [550, 380, 190, 6]

// `lod` is the tier and `brightness` is the bench's exposure, and neither is a
// property of the tree. They still get a slider, a default and an orange label
// -- they are just not shape, which is what keeps them out of the copied JSON
// and what carries them across a species change unmoved.
const BENCH_KEYS = new Set(['lod', 'brightness'])
// Those two plus the LADDER's own keys, which the generator's lod() writes per
// tier: a species that carried its own keep fractions would be arguing with
// the rung it is drawn at. None of them is shape, so none is copied out.
const NOT_SHAPE = () => new Set([...BENCH_KEYS, ...current().gen.notShape])

const current = () => SPECIES[species]
const gen = () => current().gen
const benchDefaults = () => ({ ...gen().defaults(current().key), lod: 0, brightness: 1.0 })

// DEFAULTS is TWO things -- what `defaults` restores and what the orange labels
// are measured against -- so it has to be rebuilt when the species changes. A
// const here would leave every row on the panel orange the moment you left the
// pine, which is the one thing the mark must never say.
let species = 'pine'
let DEFAULTS = benchDefaults()
const params = { ...DEFAULTS }

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const SKY = new THREE.Color(0x0a1018)
scene.background = SKY
scene.fog = new THREE.Fog(SKY, 40, 200)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// Spin orbits the CAMERA rather than turning the tree, so the ground turns with
// it and you are walking around a plant instead of watching one on a lazy
// susan. It also keeps the sun still, which matters twice here: the crown's
// shading and the card's baked-in gradient both have to be judged against a
// light that is not sweeping across them. Off by default.
controls.autoRotate = false
controls.autoRotateSpeed = (0.25 * 60) / (2 * Math.PI)

const SUN_DIR = new THREE.Vector3(3, 5, 2).normalize()
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.copy(SUN_DIR).multiplyScalar(20)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// 600 m of ground, because a 30 m tree in `sizes` wants a horizon and the fog
// has to close before the plane's edge does.
const GROUND_SIZE = 600
const GROUND_TILE = 3
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
scene.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: groundTex })
  )
)

let grid = null

// A 1.7 m human-height rule. "Is this tree the right size" is the question this
// page most often has to answer, and against a 20 m conifer a one-metre box
// tells you nothing.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 1.7, 0.25),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(-2, 0.85, 0)
scene.add(rule)

// --- materials --------------------------------------------------------------

// The bark: the REAL prop material, patched the way the game patches it -- the
// array sampler from material.js, then wrap diffuse chained on top. Chained,
// not replaced: assigning over onBeforeCompile would drop the sampler2DArray
// patch and the trunk would render untextured white.
const atlas = buildTextureArray()
const barkMaterial = createPropMaterial(atlas)
{
  const arrayPatch = barkMaterial.onBeforeCompile
  barkMaterial.onBeforeCompile = (shader, r) => {
    arrayPatch(shader, r)
    wrapLambert(shader)
  }
  // A distinct key because this program is the array patch AND the wrap patch;
  // sharing three's default would let it hand us a cached program with only one
  // of them compiled in.
  barkMaterial.customProgramCacheKey = () => 'gen-tree-v8-bark-v1'
}
const layersReady = loadImageLayers(atlas)

// The crown. Not the array material: the needle mat is a TILED surface running
// several repeats across one cloak, and every layer of the prop atlas is a cut
// meant to be sampled once across a card.
//
// FULLY OPAQUE, at every tier. A v8 bough's outline is its own geometry, so
// there is nothing for an alpha test to cut and no threshold to tune -- which
// is the one real saving this scheme has over v6's cones.
const foliageMaterial = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  // The crown's baked occlusion rides in on the geometry's grey `color`
  // attribute. Without this flag three drops the attribute without a word and
  // every whorl is lit exactly like the one above it.
  vertexColors: true,
})
foliageMaterial.onBeforeCompile = (shader) => {
  wrapLambert(shader)
  // Both sides of a cloak are the same surface, so three's double-sided flip
  // has to be undone or the underside of the crown goes black -- the same fix
  // createPropMaterial makes, argued in full at its normal_fragment_begin
  // patch. tree-v8.js authors the panel normals for this reason.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
    normal *= faceDirection;`
  )
}
foliageMaterial.customProgramCacheKey = () => 'gen-tree-v8-foliage-v1'

const texLoader = new THREE.TextureLoader()
let matLoaded = false
let needleTex = null

// refresh() rather than drawSwatch(): a card baked before its mat landed is a
// photograph of an untextured crown, and nothing else would ever re-take it.
function loadMat(url) {
  const prev = needleTex
  matLoaded = false
  needleTex = texLoader.load(url, () => {
    matLoaded = true
    refresh()
  })
  needleTex.wrapS = needleTex.wrapT = THREE.RepeatWrapping
  needleTex.colorSpace = THREE.SRGBColorSpace
  needleTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  foliageMaterial.map = needleTex
  foliageMaterial.needsUpdate = true
  // Nothing else holds the old one once it is off the material, and a bench
  // you sit on for an hour flipping species would otherwise keep every mat it
  // ever showed on the GPU.
  if (prev) prev.dispose()
}
const matUrl = () => gen().mat(current().key)
loadMat(matUrl())

// --- the card ---------------------------------------------------------------
//
// The far rung, and it is baked HERE rather than shipped: v8 has no impostor
// layer in the atlas, and standing one up would be an asset decision this page
// is not far enough along to make. So the card is a live render target -- one
// orthographic frame of the LOD0 tree on the stage, taken at the moment you
// press the tier -- which is strictly more honest than a stale bake: it cannot
// be a photograph of a tree the sliders no longer describe.
//
// ORTHOGRAPHIC, because a card seen from 30 m and from 130 m has to be the same
// picture. A perspective capture bakes in one distance's worth of convergence
// and is visibly wrong at every other.
const CARD_TEX = 512
const CARD_MARGIN = 0.06
let cardTarget = null
let cardSize = { width: 1, height: 1 }

const cardMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  // The one alpha test left on the page, and it is on the PHOTOGRAPH rather
  // than on the needles: what the bake did not paint has to stay a hole.
  alphaTest: 0.5,
  transparent: false,
  side: THREE.DoubleSide,
})
cardMaterial.onBeforeCompile = (shader) => {
  // A CYLINDRICAL billboard: the quad turns about world up to face the eye and
  // never tips. Spherical would be wrong for a tree -- look down on a forest
  // from a ridge and every trunk would lie over toward you.
  //
  // Done in view space off the mesh's OWN origin, so a gallery of cards each
  // spins about its own trunk rather than all of them about the middle of the
  // grid.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `vec4 mvOrigin = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
    vec3 bUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 bRight = cross( bUp, normalize( -mvOrigin.xyz ) );
    float bLen = length( bRight );
    // Straight down the axis there is no unique right. It cannot be seen from
    // there either, so any answer will do -- but it must not be a NaN.
    bRight = bLen > 1e-4 ? bRight / bLen : vec3( 1.0, 0.0, 0.0 );
    vec4 mvPosition = mvOrigin;
    mvPosition.xyz += bRight * transformed.x + bUp * transformed.y;
    gl_Position = projectionMatrix * mvPosition;`
  )
}
cardMaterial.customProgramCacheKey = () => 'gen-tree-v8-card-v1'

const bakeScene = new THREE.Scene()
const bakeSun = new THREE.DirectionalLight(0xfff3e2, 2.1)
bakeScene.add(bakeSun)
bakeScene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))
const bakeTrunk = new THREE.Mesh(new THREE.BufferGeometry(), barkMaterial)
const bakeFoliage = new THREE.Mesh(new THREE.BufferGeometry(), foliageMaterial)
bakeScene.add(bakeTrunk, bakeFoliage)

function bakeCard(trunkGeo, foliageGeo, stats) {
  const width = Math.max(0.2, stats.crownWidth) * (1 + CARD_MARGIN * 2)
  const height = stats.height * (1 + CARD_MARGIN)
  cardSize = { width, height }

  if (!cardTarget) {
    cardTarget = new THREE.WebGLRenderTarget(CARD_TEX, CARD_TEX, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    })
    cardMaterial.map = cardTarget.texture
    cardMaterial.needsUpdate = true
  }

  bakeTrunk.geometry = trunkGeo
  bakeFoliage.geometry = foliageGeo

  const reach = Math.max(width, height)
  const cam = new THREE.OrthographicCamera(-width / 2, width / 2, height, 0, 0.01, reach * 8)
  // Level with the ground and looking horizontally, so camera-y IS world-y and
  // the frustum's [0, height] puts the tree's feet on the texture's bottom edge.
  // Any tilt bakes a worm's- or bird's-eye view into a card that will be seen
  // from neither.
  cam.position.set(0, 0, reach * 2)
  cam.lookAt(0, 0, 0)
  // The key at the camera's own azimuth, so the photograph carries a top-to-
  // bottom gradient and no left-right terminator: a card is seen from every
  // direction on the compass, and half the time a baked bright side would be
  // facing away from the real sun.
  bakeSun.position.set(0, reach * 2.1, reach * 0.9)

  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  renderer.setRenderTarget(cardTarget)
  // Alpha 0 rather than the sky: what is not tree has to be a hole, or the card
  // is a rectangle of night sky standing in a daylit forest.
  renderer.setClearColor(0x000000, 0)
  renderer.render(bakeScene, cam)
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)

  bakeTrunk.geometry = new THREE.BufferGeometry()
  bakeFoliage.geometry = new THREE.BufferGeometry()
}

// A quad standing on the ground, sized to whatever the bake framed. Two
// triangles: a v1 tree's card is one, and it can be, because that card is a
// species-wide bake with a shape chosen for it. This one is the honest default
// until somebody measures which way up a v8 silhouette packs best.
function buildCardGeometry(scale) {
  const geo = new THREE.PlaneGeometry(cardSize.width * scale, cardSize.height * scale)
  geo.translate(0, (cardSize.height * scale) / 2, 0)
  return geo
}

// --- the trees --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const COLS = 5
const ROWS = 4
const SIZE_LADDER = [0.2, 0.45, 1, 1.8, 3]

let view = 'single' // 'single' | 'gallery' | 'sizes'
let wireframe = false
let showGrid = true

// The widest built tree, for gallery spacing and camera framing.
let lastWidth = 1

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

function rebuild() {
  const tier = Math.round(params.lod)
  const isCard = tier === 3
  const meshTier = isCard ? 0 : tier

  const g = gen()
  barkMaterial.wireframe = wireframe
  foliageMaterial.wireframe = wireframe
  barkMaterial.color.setScalar(params.brightness)
  foliageMaterial.color.setScalar(params.brightness)
  cardMaterial.color.setScalar(params.brightness)

  const p = g.lod(params, meshTier)

  const jobs = []
  if (view === 'gallery') {
    for (let i = 0; i < COLS * ROWS; i++) jobs.push({ seed: Number(params.seed) + i, height: params.height })
  } else if (view === 'sizes') {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        jobs.push({ seed: Number(params.seed) + r, height: params.height * SIZE_LADDER[c] })
      }
    }
  } else {
    jobs.push({ seed: Number(params.seed), height: params.height })
  }

  clearGroup()

  const agg = { tris: 0, verts: 0, bytes: 0, parts: {}, card: 0, count: jobs.length }
  for (const [, key] of g.parts) agg.parts[key] = 0
  // The metre readouts describe ONE tree, and in the size ladder it has to be
  // the one at the height on the slider -- otherwise dragging `height` moves
  // every number in the panel except the one it is named after.
  let measured = null
  let measuredErr = Infinity
  let width = 0

  const built = jobs.map((job) => {
    const b = g.build({ ...p, seed: job.seed, height: job.height })
    const err = Math.abs(job.height - params.height)
    if (err < measuredErr) {
      measuredErr = err
      measured = b.stats
    }
    width = Math.max(width, b.stats.crownWidth)
    return b
  })

  lastWidth = Math.max(0.2, width)
  const spacing = lastWidth * 1.25

  if (isCard) {
    // ONE bake feeds every card on screen, which is not a shortcut but the
    // shipping arrangement: an impostor is one picture per species, so a seed
    // gallery at this tier really does show twenty instances of one tree and a
    // size ladder really does show one picture scaled. Seeing that is the point
    // of looking.
    bakeCard(built[0].trunk, built[0].foliage, built[0].stats)
    built.forEach((b, i) => {
      const geo = buildCardGeometry(b.stats.height / built[0].stats.height)
      agg.tris += 2
      agg.card += 2
      agg.verts += geo.getAttribute('position').count
      agg.bytes += geometryBytes(geo)
      place(new THREE.Mesh(geo, cardMaterial), i, spacing)
      b.trunk.dispose()
      b.foliage.dispose()
    })
  } else {
    built.forEach((b, i) => {
      agg.tris += b.stats.triangles
      agg.verts += b.stats.vertices
      for (const [, key] of g.parts) agg.parts[key] += b.stats[key]
      agg.bytes += geometryBytes(b.trunk) + geometryBytes(b.foliage)
      place(new THREE.Mesh(b.trunk, barkMaterial), i, spacing)
      place(new THREE.Mesh(b.foliage, foliageMaterial), i, spacing)
    })
  }

  rule.visible = showGrid
  rule.position.x = view === 'single' ? -Math.max(1.2, lastWidth * 0.75) : -(COLS / 2 + 0.35) * spacing

  // Fog and grid scale with the subject: a 1 m sapling and a 30 m conifer want
  // very different horizons, and a fixed one either hides the tree or does
  // nothing at all.
  const reach = view === 'single' ? params.height : Math.max(params.height, spacing * COLS)
  scene.fog.near = reach * 1.5
  scene.fog.far = reach * 9

  // 1 m cells while that stays under 120 lines, then coarser -- a 300 m ladder
  // drawn at 1 m is a solid blue sheet and costs more than the trees do.
  const gridSpan = Math.max(4, Math.round(reach * 2))
  if (!grid || grid.userData.span !== gridSpan) {
    if (grid) {
      scene.remove(grid)
      grid.geometry.dispose()
      grid.material.dispose()
    }
    grid = new THREE.GridHelper(gridSpan, Math.min(gridSpan, 120), 0x2b4a72, 0x16233a)
    grid.position.y = 0.01
    grid.userData.span = gridSpan
    scene.add(grid)
  }
  grid.visible = showGrid

  return { ...agg, measured }
}

function place(mesh, i, spacing) {
  if (view !== 'single') {
    mesh.position.set(
      ((i % COLS) - (COLS - 1) / 2) * spacing,
      0,
      (Math.floor(i / COLS) - (ROWS - 1) / 2) * spacing
    )
  }
  group.add(mesh)
}

// --- camera framing ---------------------------------------------------------

function frameCamera() {
  const spacing = lastWidth * 1.25
  const half =
    view === 'single'
      ? Math.max(params.height, lastWidth) * 0.6
      : Math.hypot((COLS * spacing) / 2, (ROWS * spacing) / 2)
  const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.5
  controls.target.set(0, view === 'single' ? params.height * 0.45 : params.height * 0.3, 0)
  camera.position.set(0, dist * 0.45, dist * 0.9)
}

// --- panel ------------------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

const matName = () => matUrl().split('/').pop()

const TIER_NAMES = ['LOD0', 'LOD1', 'LOD2', 'card']

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// The ladder, priced for the tree on the stage rather than for a class average
// -- a 3 m sapling and a 25 m conifer sit at opposite ends of the same sliders,
// and a class number describes neither. The mesh rungs are the generator's
// resolve applied to its lod, which is the same pair the builder grows from,
// so a change to either law moves this table with it. The card is two by
// construction, being a quad.
//
// The mat column reads `solid` on every mesh rung, and that sameness is the
// point: it is where v6's ladder swaps a cut-out out and these have nothing to
// swap.
function ladderRows() {
  const g = gen()
  const rows = []
  for (let t = 0; t < 3; t++) {
    const p = g.lod(params, t)
    const r = g.resolve(p)
    rows.push({ name: TIER_NAMES[t], what: g.ladderWhat(p, r), mat: 'solid', tris: r.triangles })
  }
  rows.push({ name: 'card', what: 'one spun quad, baked off LOD0', mat: 'baked', tris: 2 })
  return rows
}

function refresh() {
  const s = rebuild()
  const g = gen()
  const tier = Math.round(params.lod)
  const per = Math.round(s.tris / s.count)
  const budget = CLASS_BUDGET[tier]
  const rows = ladderRows()
  const meshP = g.lod(params, Math.min(tier, 2))
  const r = g.resolve(meshP)

  // The breakdown describes what is ON THE STAGE, so at the card tier it is one
  // row. Printing LOD0's bough count beside a zero would read as a bug in the
  // builder rather than as a tier that has no boughs.
  const breakdown = s.card
    ? [['&nbsp;&nbsp;card', `2 &mdash; one bake, ${s.count} instance${s.count > 1 ? 's' : ''}`]]
    : g.parts.map(([label, key]) => [`&nbsp;&nbsp;${label(meshP, r)}`, Math.round(s.parts[key] / s.count)])

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} total)` : ''}`],
    ...breakdown,
    ['vertices', Math.round(s.verts / s.count)],
    ['drawn here', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    [`tree-class ${TIER_NAMES[tier]}`, `${per} / ${budget} tris`, per <= budget ? 'ok' : 'warn'],
  ])

  document.getElementById('geonote').innerHTML = s.card
    ? `One mesh and one draw call: a quad ${cardSize.width.toFixed(2)} &times; ${cardSize.height.toFixed(2)} m ` +
      `carrying a ${CARD_TEX}&sup2; photograph of the LOD0 tree, taken here and spun about world up in the ` +
      `vertex shader. Every card on the stage samples that one bake, which is what an impostor is.`
    : g.geonote(matName(), params)

  document.getElementById('laddernote').innerHTML = g.ladderNote

  const lodEl = document.getElementById('lod')
  lodEl.innerHTML = rows
    .map(({ name, what, mat, tris }, i) =>
      `<tr class="${i === tier ? 'here' : ''}">` +
        `<td class="k">${name} <span style="opacity:.7">${what}</span></td>` +
        `<td class="band">${mat}</td><td class="n">${tris}</td></tr>`
    )
    .join('')

  const f = s.measured
  const crownH = Math.max(0, f.crownTop - f.crownBase)
  table(document.getElementById('measure'), [
    ['height', `${f.height.toFixed(2)} m`],
    ['crown width', `${f.crownWidth.toFixed(2)} m`],
    ['crown depth', `${crownH.toFixed(2)} m`],
    ['trunk at the base', `${(f.trunkDiameter * 100).toFixed(0)} cm`],
    ['bare trunk below it', `${f.crownBase.toFixed(2)} m`],
    ['crown / height', (f.crownWidth / Math.max(1e-6, f.height)).toFixed(2)],
    ...g.measure(f, params, crownH),
    [
      'below ground',
      f.belowGround > 0.005 ? `${(f.belowGround * 100).toFixed(0)} cm` : 'none',
      f.belowGround > f.height * 0.2 ? 'warn' : 'ok',
    ],
  ])

  drawSwatch()
}

// --- the mat swatch ---------------------------------------------------------
//
// The one tile, drawn REPEATED so what you are reading is the tiling and not
// the picture. A cloak runs several repeats along its own spine, so whether the
// seam shows is a property of four corners meeting, which one copy cannot tell
// you. Square cells, so the swatch is not judging a stretch the mesh never
// applies.
const SWATCH_CELL = 64

function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false

  const img = needleTex.image
  if (img) {
    for (let y = 0; y < canvas.height; y += SWATCH_CELL) {
      for (let x = 0; x < canvas.width; x += SWATCH_CELL) {
        ctx.drawImage(img, x, y, SWATCH_CELL, SWATCH_CELL)
      }
    }
  }

  if (!matLoaded) {
    ctx.fillStyle = 'rgba(8,14,26,.75)'
    ctx.fillRect(0, canvas.height / 2 - 9, canvas.width, 18)
    ctx.fillStyle = '#c9a227'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('the mat is still loading', canvas.width / 2, canvas.height / 2 + 4)
  }

  const dims = img ? `${img.width}&times;${img.height}` : 'still loading'
  document.getElementById('swatchnote').innerHTML =
    `<em>${matName()}</em>, ${dims}, drawn here repeated so you are looking at the seam ` +
    `rather than at the picture. One mat per species, and every rung wears it: v6 needs a cut-out at LOD0 because its ` +
    `whorl is a closed cone whose only ragged edge is painted, and a v8 whorl is separate limbs with ` +
    `real air between them, so the alpha would be paying a per-pixel test to erase what the silhouette ` +
    `already does not have. Fully opaque is also what a DISTANT crown should be made of, an alpha test ` +
    `at range swimming frame to frame as a one-pixel bough's coverage flickers. It tiles, which is the ` +
    `property a cloak needs and a leaf CUT does not have -- v1's art is one spray meant to be sampled ` +
    `once across a card, and stretching it over a bough would read as one enormous leaf.`
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
// Rebuilt whole when the species crosses a generator: the two panels share
// `lod`, `height`, `brightness` and a few trunk names, and nothing else.
let readouts = {}

// --- precision, twice, because there are two different questions -------------
//
// `atStep` is what gets PRINTED and COPIED. It kills float noise -- dragging a
// 0.005 slider lands on 0.30000000000000004 often enough -- without moving the
// value onto the step grid, so a hand-authored default stays the number it was
// written as.
//
// `onGrid` is what gets COMPARED. It snaps to the nearest value the slider can
// actually land on, which `atStep` deliberately does not, and that difference
// matters in exactly one case: a default that does not sit on the step grid.
// Drag such a slider away and back and the best you can reach is a neighbouring
// step, and a label left orange there would be pointing at a discrepancy the
// control cannot fix.
function decimals(step) {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

function atStep(v, step) {
  return Number(Number(v).toFixed(decimals(step)))
}

function onGrid(v, step) {
  return Math.round(Number(v) / step)
}

function sameAsDefault(key, v) {
  const step = readouts[key].step
  return onGrid(v, step) === onGrid(DEFAULTS[key], step)
}

function showValue(key) {
  const { out, label, step } = readouts[key]
  const v = params[key]
  // Printed to the step's OWN precision, not a fixed two places: `trunkRadius`
  // steps by 0.001, and two places cannot tell 0.026 from 0.025.
  //
  // The tier's readout is its NAME, not its index: "3" on a four-rung ladder is
  // the one value on this panel that does not mean a quantity.
  out.textContent = key === 'lod' ? TIER_NAMES[Math.round(v)] : Number(v).toFixed(decimals(step))
  // The changed mark is folded in HERE rather than into the input handler,
  // because the handler is not the only way a value moves: `defaults` and every
  // future path go through syncSliders, and syncSliders goes through this. One
  // choke point is the only arrangement in which no path can leave a label
  // lying about its row.
  label.classList.toggle('changed', !sameAsDefault(key, v))
}

function buildSliders(spec) {
  slidersEl.innerHTML = ''
  readouts = {}
  for (const [key, min, max, step, help] of spec) {
    if (key === '#') {
      const h = document.createElement('h2')
      h.textContent = min
      slidersEl.appendChild(h)
      continue
    }
    if (!(key in DEFAULTS)) throw new Error(`gen-tree-v8: slider "${key}" names no parameter of ${species}`)
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML =
      `<label title="${help.replace(/"/g, '&quot;')}">${key}</label>` +
      `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
      `<span class="v"></span>`
    const input = row.querySelector('input')
    readouts[key] = { input, out: row.querySelector('.v'), label: row.querySelector('label'), step }
    input.addEventListener('input', () => {
      params[key] = Number(input.value)
      showValue(key)
      refresh()
    })
    showValue(key)
    slidersEl.appendChild(row)
  }
}
buildSliders(gen().sliders)

function syncSliders() {
  for (const key of Object.keys(readouts)) {
    readouts[key].input.value = params[key]
    showValue(key)
  }
}

const seedInput = document.getElementById('seed')
seedInput.addEventListener('input', () => {
  params.seed = Number(seedInput.value) || 0
  refresh()
})
document.getElementById('reroll').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 100000)
  seedInput.value = params.seed
  refresh()
})

// A species is a WHOLE parameter set, seed included, not a preset layered over
// whatever is on the panel: these are hand-tuned trees, and a birch built on
// an oak's seed and an oak's crownPeak is neither of them. So the swap is
// total -- the other generator's keys are cleared, not left underneath -- and
// the only things that survive it are the bench's own two knobs.
const speciesEl = document.getElementById('species')
speciesEl.innerHTML = Object.entries(SPECIES).map(
  ([n, s]) => `<option value="${n}">${s.label}</option>`
).join('')
speciesEl.value = species
speciesEl.addEventListener('change', () => {
  const prevGen = gen()
  species = speciesEl.value
  DEFAULTS = benchDefaults()
  const bench = {}
  for (const key of BENCH_KEYS) bench[key] = params[key]
  for (const key of Object.keys(params)) delete params[key]
  Object.assign(params, DEFAULTS, bench)
  seedInput.value = params.seed
  loadMat(matUrl())
  if (gen() !== prevGen) buildSliders(gen().sliders)
  else syncSliders()
  refresh()
  frameCamera() // after, so it frames the tree that was just built
})

// `rebuilds` because most of these change the mesh and one does not: spinning
// the camera would otherwise regrow twenty trees and re-bake the card to move a
// boolean the render loop reads every frame anyway.
function toggle(id, get, set, rebuilds = true) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    if (rebuilds) refresh()
  })
}

// The two grid views are mutually exclusive -- clicking one turns the other off
// -- so they are wired together rather than as two independent toggles.
function viewButton(id) {
  const btn = document.getElementById(id)
  btn.addEventListener('click', () => {
    view = view === id ? 'single' : id
    for (const other of ['gallery', 'sizes']) {
      document.getElementById(other).classList.toggle('on', view === other)
    }
    refresh()
    frameCamera()
  })
}
viewButton('gallery')
viewButton('sizes')

toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v }, false)

document.getElementById('reset').addEventListener('click', () => {
  const seed = params.seed
  Object.assign(params, DEFAULTS, { seed })
  syncSliders()
  refresh()
  frameCamera() // after, so it frames the tree that was just built
})

// --- copying the shape out --------------------------------------------------
//
// The bench is where a shape gets DECIDED and tree-v8.js is where it has to end
// up, and without this there is no crossing between them: you tune something
// worth keeping and then read forty numbers off the panel by eye to type them
// back in, which nobody does twice.
//
// JSON, and it is a WHOLE parameter set rather than a diff, so it pastes into
// the generator's species bank as the picked species' `params` -- which is
// where a shape tuned here is meant to end up.
//
// `lod` is left out because it is the TIER, which is a fact about what you are
// looking at and not about the tree; `brightness` is left out on the harder
// argument -- it is the bench's dial, and a shape that named it would be
// pasting the previewer's exposure into the world.
function copyText() {
  const shape = {}
  const skip = NOT_SHAPE()
  for (const key of Object.keys(DEFAULTS)) {
    if (skip.has(key)) continue
    const step = key in readouts ? readouts[key].step : null
    shape[key] = step === null ? params[key] : atStep(params[key], step)
  }
  return JSON.stringify(shape, null, 2)
}

const copyBtn = document.getElementById('copy')
let copyTimer = 0

function flashCopy(label, hold) {
  copyBtn.textContent = label
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyBtn.textContent = 'copy' }, hold)
}

copyBtn.addEventListener('click', () => {
  // navigator.clipboard is absent outright on a non-secure origin and the write
  // is permission-gated even on a secure one, so BOTH failures have to reach
  // the label. A button that silently did nothing would look exactly like one
  // that worked, and the whole reason this exists is that there was no way to
  // get the numbers out. No textarea fallback: a copy that half works is a copy
  // nobody trusts.
  if (!navigator.clipboard) {
    flashCopy('no clipboard API', 4000)
    console.error('gen-tree-v8: navigator.clipboard is undefined -- this page is not on a secure origin')
    return
  }
  navigator.clipboard.writeText(copyText()).then(
    () => flashCopy('copied', 1000),
    (e) => {
      flashCopy(`clipboard blocked (${e.name})`, 4000)
      console.error('gen-tree-v8: clipboard write refused', e)
    }
  )
})

// --- run --------------------------------------------------------------------

function resize() {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

seedInput.value = params.seed
refresh()
frameCamera()
// The procedural fills in buildTextureArray() are on screen until the PNGs
// land, which is why the trunk is bark-coloured for those frames rather than
// invisible. Deliberately unguarded: a failed layer throws and the page dies
// loudly, because a silently-stubbed texture is exactly the thing this bench
// exists to not show you.
layersReady.then(() => refresh())

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
