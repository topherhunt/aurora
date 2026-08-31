import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import {
  buildRockBank, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT,
  rockImpostorLayers, rockShapeId, SITES, TINT_GAIN,
} from '../../props/rock-bank.js'
import { ROCK_LOD_AT, rockLodSize } from '../../props/rock.js'
import {
  createPropMaterial, setSnowLine, setMossLine, setSnowVary, setMossVary, setPropSolidAt,
  setPropFadeTimerAt, getPropClock, FADE_BAND, PROP_FADE_SECONDS,
} from '../../material.js'
import { RimFade, RIM_AT } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'

// ---------------------------------------------------------------------------
// The stone on the /v2 route: pebbles underfoot, boulders through the wood and
// across the cliffsides, giants on the crags and the summits. The argument is
// DESIGN.md §25; this is the contract.
//
// THE SCATTER IS render/trees.js's, deliberately -- tiled, camera-following,
// graded thinning at FULL_RADIUS / d so the instance count grows linearly in the
// draw radius rather than quadratically. Everything that header argues about
// tiles, ranks, quantised keep-fractions, incremental regrow, standing props on
// the DRAWN ground and dissolving at each instance's own cull distance holds here
// and is not repeated.
//
// SIX BEDS, because a rock's size spans two orders of magnitude and no single
// density-and-radius pair carries both ends. Each is a complete independent
// scatter with its own tile grid, density, radius, LOD bands and instance pool:
//
//   UNDERFOOT   0.11 - 0.75 m  dense, 60 m      river stones, cobbles, caps
//   BOULDERS    0.34 - 3.4 m   medium, 460 m    the forest and cliffside rocks
//   SCREE       0.5 - 3 m      dense, 140 m     the pile at the foot of a face
//   CRUST       0.45 - 4.8 m   medium, 300 m    caps on lake floors and faces
//   SUNKEN      0.5 - 5 m      sparse, 320 m    closed stones on the lake floor
//   GIANTS      3.2 - 7.0 m    sparse, 1250 m   tors, shelves, buttresses, lips
//
// EACH BED EXISTS BECAUSE SOMETHING IT NEEDS IS PER-BED AND CANNOT BE VARIED
// WITHIN ONE -- the only test a new bed has to pass. Scree needs the candidate
// count (`envDensity` is an accept rate capped at 1, so a saturated site cannot be
// made denser by any multiplier); crust needs the slope limit and the submersion
// flag; sunken needs `submergedOnly` and a size range of its own. Six beds are six
// BatchedMeshes and six draw calls, which does not break §5's one-material rule --
// that rule forbids splitting a BATCH by material. They share ONE material object,
// unlike trees, ferns and grass, because every bed here billboards the same single
// layer and one program serves them all.
//
// WHERE A ROCK GOES IS DECIDED BY WHERE IT IS, not by a roll. A candidate is
// classified into one of four ENVIRONMENTS -- river, peak, cliff, forest -- from
// the field sample the placement test already pays for (`_envAt`), then picks its
// shape from the variants tagged for it in props/rock-bank.js. A pure function of
// position, exactly as existence is, so a rock does not change species as the
// player walks toward it. `_relief` adds a finer test on top: the second
// difference of the height field along the fall line tags a site `foot` or `brow`,
// the only way to tell the bottom of a cliff from the top of one, and site-tagged
// variants are held out of the ordinary pools entirely.
//
// ROCKS SIT IN THE GROUND AND LEAN WITH IT, and both halves matter: bedded by a
// fraction of their own height that GROWS WITH THE SLOPE, and tilted toward the
// ground normal, which trees deliberately are not -- a tree on a slope grows up, a
// rock lies the way it fell. The tilt costs four field samples per PLACED rock and
// is off for the underfoot bed. Snow and moss are the material's, not this file's:
// both derive in the vertex shader from the instance's own root height against a
// line, so a boulder is green in a damp wood, bare on a ridge and white on a
// summit at no per-instance data and no per-frame CPU. See syncBands.
//
// ONE LOD LADDER, AND THE THRESHOLDS ARE PER ROCK RATHER THAN PER BED -- the thing
// to understand about this file if you are here about LOD at all. Every shape
// ships T180/T80/T20 and a two-triangle card, and every instance steps between
// them at `ROCK_LOD_AT` metres per metre of its OWN ladder size (`rockLodSize`):
// 4 to T80, 7.5 to T20, 25 to the card, so a 2 m rock holds real geometry out to
// 50 m, a cobble to 8.5, a 12 m spire to 300. A table of metres per bed was wrong
// in both directions at once, because a bed is not one size of rock.
//
// AND NOTHING IS CULLED BEFORE IT HAS BEEN A BILLBOARD -- A WHOLE ONE, FOR A
// WHILE. Thinning is keyed on a rank that knows nothing about how big a rock is,
// so it used to reach up and dissolve rocks that were still meshes: rocks went at
// 37 m. `_rankOf` floors that rank at the rock's own card distance and
// `ROCK_CARD_LIFE` holds the card whole for a doubling past it. A ROCK
// DISAPPEARING IS STILL NOT ITS LADDER RUNNING OUT -- the ladder is a function of
// SIZE and picks the mesh, the graded thinning is a function of the instance's
// random RANK and decides whether the rock is there at all.
//
// THERE IS A CARD TIER AND NO BED DECLINES IT. §25 carries the argument, the
// spherical spin that retired the crust bed's opt-out, and the six pixels of
// buried shell that swap costs.
// ---------------------------------------------------------------------------

// The beds. Each is an independent scatter; `names` are the variants from
// props/rock-bank.js it may place, and the environment tags on those variants
// then decide which of them can stand at any given point.
//
// DENSITIES ARE AT FULL RADIUS and decay past it. Inside it a bed puts down
// `density * envDensity[env]` rocks per square metre, which is the number to read
// when you want to know what the ground LOOKS like: 0.0084 with a forest
// multiplier of 0.5 is one boulder per 240 m2, about one every 15 m.
//
// `envDensity` is the second half of the environment gate and the more important
// half. WITHOUT IT A BED IS EQUALLY DENSE EVERYWHERE and only its shapes change,
// putting a house-sized block every forty metres through a wood.
//
// IT IS AN ACCEPT RATE AND CANNOT EXCEED 1, which is the constraint that shapes
// the boulders bed's numbers below. The only way to make a saturated place denser
// is to offer more CANDIDATES there, and candidates are per-bed rather than
// per-site. The roll it costs is drawn unconditionally alongside the others,
// before the environment is even known -- see _growTile.
const BEDS = [
  {
    name: 'underfoot',
    names: ['pebble', 'grit', 'cobble', 'shingle', 'scree', 'cap'],
    density: 0.35,
    // Leaf litter and turf swallow small stones; bare rock and gravel do not.
    // OUTSIDE A STREAM BED THIS IS A TENTH OF WHAT IT WAS, which is what stops
    // the ground being a speck carpet: at 0.5 a wood took a stone every 2.4 m
    // and a cliff one every 1.7 m against a boulder every 15 m from the bed
    // below -- forty-one small stones per rock big enough to read as a rock,
    // each costing a full instance in `BatchedMesh.onBeforeRender` whatever its
    // triangle count. The look those specks carried is not lost, it stops being
    // geometry: LAYER.LITTER stamps a baked top-down scatter onto the ground.
    //
    // THE RIVERBED RATE IS DELIBERATELY TINY, where it used to be the highest in
    // the bed at 1.0, on the reasoning that a gravel bar IS a carpet of small
    // stones. True about gravel and false about GEOMETRY -- the distinction the
    // litter stamps had already made everywhere else. A stream bed of half-metre
    // stones at one per 2.9 m2 was the densest geometry in the world and read as
    // gravel, which is what LITTER does for two triangles a patch. So the
    // geometry here becomes what gravel cannot be: see `sizeByEnv`, where the
    // river range is 0.3 to 2 m. One rock per 36 m2 of riverbed, something to
    // step around every few strides, with the pebble atlas carrying the rest.
    envDensity: { river: 0.08, forest: 0.05, cliff: 0.1, peak: 0.09 },
    fullRadius: 18,
    // 120 rather than 55, set by the ladder: the bed's biggest rock is a 2 m
    // riverbed stone, which holds a mesh tier out to 50 m and then owes a
    // ROCK_CARD_LIFE band as a whole billboard, needing 118 m of reach (see the
    // `minReach` check in the bed constructor). Not as many pebbles as it sounds
    // -- at 118 m thinning has this bed at 18/118, a seventh of full density.
    radius: 120,
    tile: 11,
    minElev: 0,
    maxSlopeDeg: 42,
    // A pebble in a stream bed is a pebble. The underfoot bed is the only one
    // that may stand under water on purpose.
    allowSubmerged: true,
    tilt: 0,
    // NOT AN ANCHOR, and this bed is why the flag exists. An anchor bed is one
    // another scatter may stand something at the foot of (see Rocks.anchorsInto)
    // and a pebble has no foot -- a mushroom clump ringing an eleven-centimetre
    // pebble reads as a mistake. The arithmetic settles it too: in a wood this
    // bed puts down 0.0175 rocks per square metre against the boulders' 0.0042,
    // so offering it would fill any buffer sized for boulders with grit before
    // the first rock worth anchoring to reached the caller.
    anchor: false,
    // In METRES rather than as a multiplier, because the riverbed has to be a
    // different size from everywhere else and a multiplier cannot say that (see
    // where the scale is resolved in _growTile). The three dry ranges reproduce
    // what `scale: [0.7, 1.6]` gave across these shapes; only the river is new.
    sizeByEnv: {
      river: [0.3, 2.0],
      forest: [0.25, 1.0],
      cliff: [0.25, 1.0],
      peak: [0.25, 1.0],
    },
  },
  {
    name: 'boulders',
    names: [
      'cobble', 'scree', 'talus', 'rubble', 'slab', 'stepping', 'capslab',
      'mosshump', 'roundstone', 'boulder', 'wedge', 'erratic', 'cleft',
    ],
    // RAISED 2.5x, AND EVERY envDensity BELOW DIVIDED BY 2.5 TO PAY FOR IT -- a
    // no-op everywhere except at the foot of a cliff, which is the whole reason
    // for it. `envDensity` is an accept RATE and cannot push a site past 100%: a
    // cliff foot ran `1.0 * (1 + CLUMP_GAIN * clump)`, already >= 1 for every
    // clump value there is, so the only lever left is how many candidates get
    // OFFERED. Halving the rates instead does not work because the cap truncates
    // exactly the gain: measured over the real field, 0.50 -> 1.85x, 0.45 ->
    // 1.96x, 0.40 -> 2.05x, 0.30 -> 2.10x with nothing clipped. 0.40 is the knee.
    // Not free -- 2.5 `heightAndSlopeAt` lookups where it paid one, over a 460 m
    // radius, and the pool scales with it (_poolBound). §25 has the derivation.
    density: 0.0105,
    // Each is the old rate divided by 2.5, so every environment's rocks per square
    // metre is what it was and only the foot ratio moved. At the effective 0.0042 a
    // forest boulder is one per 240 m2, roughly every 15 m, and closer in practice
    // because graded thinning packs the near field.
    envDensity: { river: 0.28, forest: 0.4, cliff: 0.4, peak: 0.32 },
    fullRadius: 95,
    radius: 460,
    tile: 28,
    minElev: 0,
    maxSlopeDeg: 48,
    allowSubmerged: true,
    tilt: 0.7,
    // See SINK_DEEP. The two large beds vary their burial per instance; the
    // underfoot bed does not, because a pebble is too small for the difference
    // to read and its open-shell variants have their own burial rule already.
    sinkVary: true,
    // AN ANCHOR BED, and the one a caller is really asking about: a cobble at
    // 0.55x through to a cleft at 2.2x spans everything from a stone you could
    // pick up to a rock the size of a shed, which is the whole range of stone
    // with a damp shaded base to grow anything against. See Rocks.anchorsInto.
    anchor: true,
    // Wider than the other two beds on purpose. The variants span 0.34 m to
    // 3.4 m; times this, the wood gets everything from a knee-high cobble to a
    // 7 m cleft, which is the spread being asked for, at the cost of a wider
    // roll.
    scale: [0.55, 2.2],
  },
  {
    // A BED THAT EXISTS ONLY AT THE FOOT OF A FACE, separate rather than another
    // multiplier on the one above because the architecture cannot get here from
    // there: an accept rate capped at 1 can at most take every candidate the
    // boulders bed offers, which at 0.0105 per square metre is a rock every 10.6 m
    // -- a doubling, and still not a pile. The ratio was never the problem, the
    // absolute figure was, and a pile is made of candidates, which are per-bed.
    //
    // What that buys is the freedom to be dense and SHORT-SIGHTED at once. Talus is
    // only a pile from close up, so this runs to 140 m instead of 460 and the area
    // falls by 11x, which pays for offering 95x the boulders bed's candidates per
    // square metre inside 13x its pool.
    //
    // It places NOTHING except where `_relief` says foot (see `footOnly`), and
    // nothing on flat river or forest ground: a wood at the base of a crag gets its
    // stone from the boulders bed, which has forest shapes and this one does not.
    name: 'scree',
    // Three shapes, 0.6 to 3.6 m at p10/p90 once scaled, and no small ones:
    // `grit` or `cobble` here would rebuild the speck carpet inside the one
    // place the rocks are supposed to be big.
    names: ['talus', 'rubble', 'scree'],
    // HALVED, AND THE ROCKS MADE BIGGER TO PAY FOR IT -- see `scale` and
    // `sizeBias`; the two numbers are one decision and moving either alone undoes
    // it. At 2.0 the foot of a cliff was a rock every metre, all about the same
    // modest size: a gravel path rather than a talus cone. Now it is one rock every
    // 1.8 m inside the full radius, median 1.7 m across, and the gate reads one
    // every 2.1 m over the whole 140 m reach where thinning has begun grading it
    // away. Scree does essentially all of that alone -- the other beds contribute a
    // flat ~230 rocks at the foot whatever this number is.
    //
    // WHAT "PILED" MEANS HERE CHANGED WITH THE DART. `minGap` forbids the
    // short-range clustering that used to be the evidence of a pile, so nearest
    // neighbour now runs 0.85 / 1.34 / 1.91 m at p10/median/p90 where Poisson at
    // the same rate gives 0.33 / 0.84 / 1.54. The piling has moved up a scale,
    // where it belongs: the clump floor decides where the drifts are and the
    // density fills them. Coverage is better for it -- only 6% of the foot is clear
    // inside 1.5 m, against 28% before. DENSITY AND `clumpFloor` ARE INDEPENDENT
    // AND ONLY DENSITY FILLS GROUND: spacing inside the drifts is flat at
    // 0.96-0.98 m across floors 0.42 to 0.65, so the floor is a purely spatial
    // mask and raising it to buy "bunching" only trades away coverage.
    //
    // WHAT IT COSTS: 17 ms of one-time `place()` and an instance pool of 56,602,
    // both half what density 2.0 asked for. The pool is the uglier number -- a
    // traverse peaks at 785 instances in it -- but `_poolBound` is position blind
    // by necessity and running dry THROWS, so it cannot be tightened by guessing at
    // an average. Most of the placement time is `_relief`, not the terrain sample;
    // see the note at the clump test in _growTile for the memo that would take it
    // down and why it is not free. §25 has the measurements.
    density: 1.0,
    envDensity: { river: 0, forest: 0, cliff: 1, peak: 1 },
    fullRadius: 40,
    // 280 AND NOT LESS, and the short end was tried. `radius` does not change
    // near-field spacing at all -- inside `fullRadius` it measured the same at
    // 140, 110 and 90, because thinning already grades everything past the full
    // radius away -- so pulling it in to 110 looked like a free quarter off both
    // the placement time and the pool. It is not: it sets REACH, and a scree
    // slope is a landscape feature you see across a valley before walking to it.
    // At 110 the check-rocks traverse places zero scree where 140 places 97,
    // because the feet it passes sit in the 110-140 m band -- cutting this does
    // not thin the pile, it deletes whole piles. What took it from 140 to 280 is
    // the other end: the bed's biggest block cards at 117 m and owes a
    // ROCK_CARD_LIFE band past that, so `minReach` enforces a floor of 275 m.
    radius: 280,
    tile: 14,
    minElev: 0,
    maxSlopeDeg: 46,
    allowSubmerged: false,
    tilt: 0.7,
    sinkVary: true,
    // Not an anchor. A talus field is not a thing you plant a mushroom ring at
    // the foot of -- it is all foot -- and offering it would swamp any buffer
    // sized for the boulders bed, exactly as the underfoot bed would.
    anchor: false,
    // BIGGER, AND WEIGHTED TOWARDS THE BIG END. The old 0.45-1.25 was a narrow
    // band around the authored size, so a talus cone came out as one grade of
    // rock repeated and halving the density would only have thinned it. This
    // spans nearly four to one, and `sizeBias` under 1 pushes the roll up it:
    // 0.7 puts the median at 1.30x where a flat roll gives 1.15, and the top
    // decile at 1.71x. Over the placed population that moves scree from
    // 0.47/1.45/2.74 m at p10/p50/p90 to 0.62/1.71/2.79 inside the full radius,
    // and 0.62/1.70/3.57 over the whole reach -- a pile with blocks in it rather
    // than a bed of chips.
    scale: [0.5, 1.8],
    sizeBias: 0.7,
    // AND NO ROCK INSIDE ANOTHER ROCK. Centres must be `minGap` of the sum of
    // the two radii apart, radius being half the measured world width, so 0.6
    // puts each centre just outside the other's circle and leaves partial
    // overlap -- which is what a pile is -- alone. A dart, not a relaxation: one
    // pass, first come first served, no attempt to move the loser somewhere it
    // would fit.
    //
    // ONLY THIS BED HAS ONE, because only this bed is dense enough for it to
    // fire. It is quadratic in the tile's survivors -- 196 here, so ~19k
    // distance tests a tile, nothing beside the field samples the same tile pays
    // for -- but a bed placing a boulder every ten metres has nothing to dart
    // against and skips it.
    minGap: 0.6,
    // The two flags this bed introduces, both of them meaningless without it.
    //
    // `footOnly` throws away every candidate that is not standing at the base
    // of something steep. At the rates above that is nearly all of them, which
    // is the intent: the bed is dense in the small part of the world that is a
    // scree slope and absent everywhere else.
    footOnly: true,
    // `clumpFloor` IS THE PILE, and it is a look knob rather than a cost knob.
    // `_clump` is four hashes and no field query, so rejecting on the pile field
    // first does keep 40% of candidates from touching the terrain -- but over
    // eight seeds the samples PAID PER SURVIVING ROCK go UP as the floor rises
    // (14.3 at 0.42 to 17.5 at 0.65), the floor removing rocks slightly faster
    // than it removes queries. A higher density cannot be paid for by raising
    // it.
    //
    // What it buys is the gaps, and it is kept LOW because gaps were the
    // complaint. It is the ONLY knob that sets them: the share of cliff foot
    // with no rock within 3 m is 8% at floor 0.34, 12% at 0.42 and 16% at 0.50,
    // and it is FLAT IN DENSITY (12% at every density from 2.0 to 3.5 at this
    // floor), each step up costing about 5% more per surviving rock. What it
    // cannot set is how WIDE a gap is: that is CLUMP_CELL's 26 m.
    clumpFloor: 0.42,
  },
  {
    // THE CRUST: caps stuck to surfaces no other bed is allowed to stand on.
    //
    // Two jobs that look unrelated and are one. A lake floor and a cliff face are
    // both SURFACES THAT NEED BUMPS, and what gives a surface bumps for almost
    // nothing is an `openBottom` shell -- a dome with no underside, sat into the
    // surface so the surface closes it. Half the triangles of a closed rock, and it
    // can never be seen from behind because there is no behind.
    //
    // WHY IT IS ITS OWN BED AND ITS OWN DRAW CALL: not density this time, the SLOPE
    // LIMIT, which is per-bed and which nothing else can vary. Every other bed
    // refuses ground past 42 to 62 degrees, so the `cliff` rate in all of them is
    // spent on the 34-to-42-degree apron and never on the face itself -- which is
    // why the faces are smooth. A cap is the one shape with business up there, and
    // its own bed is the only way to say so without inviting grit onto a wall. The
    // submersion flag is per-bed for the same reason.
    //
    // `forest` IS ZERO ON PURPOSE AND IS NOT UNREACHABLE, unlike the litter
    // scatter's `cliff` (§22): ordinary sloping woodland is reachable here and would
    // accept caps if the rate allowed. It is zero because a cap on flat ground is a
    // rock with its bottom cut off -- the shape only reads where the surface it is
    // stuck to closes it -- and flat ground already has the boulders bed and the
    // litter stamps.
    name: 'crust',
    // The bank's three `openBottom` shells carrying more than one of this bed's
    // environments. `shingle` is here for the peaks: `cap` and `capslab` alone
    // left a summit with two shapes against a floor of three, and a peak is the
    // one ground where a repeat shows -- no canopy, no undergrowth, so a bare
    // shelf repeated is a row of identical bumps on a skyline. It is also the
    // smallest at 0.5 m, the size a lake floor wants most of.
    names: ['cap', 'capslab', 'shingle'],
    // DOUBLED, AND EVERY DRY RATE HALVED TO PAY FOR IT, so the riverbed gets
    // twice the caps and the cliff and peak stay where they were. `density` and
    // `envDensity` only appear as a product (the boulders bed does the same
    // trick for the opposite reason), and the river rate was already saturated
    // at 1, so doubling the river could only be done from here.
    density: 0.32,
    // AND THE DRY RATES CUT AGAIN on top of the halving, because the caps got
    // BIGGER at the same time (see `sizeByEnv`). Coverage goes as the SQUARE of
    // the size: a cliff cap averaged about 2.5 m across under the old range and
    // 5.5 m under 1-10 m, so holding the count would have covered a face four
    // and a half times over and buried it rather than textured it.
    // "Coarse-grained" is fewer and larger, and it is the fewer that makes it
    // coarse. 0.13 x 0.32 is one cap per 24 m2 of face against one per 6 m2.
    envDensity: { river: 1, forest: 0, cliff: 0.13, peak: 0.07 },
    fullRadius: 45,
    // 600 AND NOT 170, SET BY THE LADDER RATHER THAN TASTE. A 10 m cliff cap --
    // the top of `sizeByEnv` -- holds a mesh tier out to 250 m under
    // ROCK_LOD_AT, so a 170 m reach culled one cap in six outright while it was
    // still an LOD2 mesh, with no card in between. 300 fixed that and left the
    // cap carding at 250 m in a bed ending at 300, where 60% of the caps began
    // dithering in the same metre their card appeared -- from the ground,
    // indistinguishable from the mesh dithering out. 600 buys a whole
    // ROCK_CARD_LIFE band past 250 m; the `minReach` check refuses the bed if
    // the two disagree.
    //
    // Paid in cards, everything past 250 m out there being two triangles, and
    // this bed pays most for the band because its rocks are biggest relative to
    // its 45 m `fullRadius`. The position-blind pool bound moves far more than
    // real use does, assuming every square metre of the disc is cliff at full
    // density; the check-rocks traverse is the number that matters.
    radius: 600,
    tile: 15,
    minElev: 0,
    // THE NUMBER THE BED EXISTS FOR. 75 degrees admits the faces themselves
    // rather than their apron, and it is safe only because of what this bed
    // places: a shell bedded into the surface and tilted flush with it cannot be
    // seen to be balancing, which is exactly what a closed rock at this angle
    // would look like it was doing.
    maxSlopeDeg: 75,
    // The river half of the bed's purpose. A cap on a lake floor is the same
    // object as a cap on a face, differing only in which way the surface it is
    // stuck to happens to point.
    allowSubmerged: true,
    // FULL alignment, and the only bed at 1. The others lean partway toward the
    // ground normal because a boulder lying exactly along the slope reads as
    // placed rather than fallen. A cap has no such freedom: it is a piece of the
    // surface, and one standing even slightly proud of a vertical face shows the
    // open edge it is built around.
    tilt: 1,
    // The open-shell variants carry their own burial rule via `sit`, so the
    // per-instance sink the two large beds vary would be varying something
    // already decided. Same reasoning as the underfoot bed's.
    sinkVary: false,
    // Not an anchor. A cap has no damp shaded base to grow anything against --
    // its base is the surface it is stuck to -- and on a face there is no
    // "foot" for a caller to reason about at all.
    anchor: false,
    // DARKER THAN THE REST, because a cap is not lit like the rocks the tint
    // palette was written for -- see where `tintDim` is applied. 0.78 lands a
    // cap just under the mean of the face it is stuck to instead of a fifth over
    // it, which reads as "part of the cliff" rather than "stuck onto the cliff".
    // Chosen by eye rather than measured, and the number here most likely to
    // want a nudge.
    tintDim: 0.78,
    // TWO SIZES FOR ONE BED, which is the whole reason `sizeByEnv` exists.
    //
    // On a wall these are COARSE-GRAINED COVER: 1 to 10 m, no small end at all. The
    // job is to break the silhouette of a face and only metres do that; the old
    // range bottomed out near 0.3 m, which is invisible from anywhere you can stand
    // to look at the cliff. On a lake floor the same shell is a stone you would
    // step on, 0.5 to 6 m, with the pebble stamps carrying everything finer. Wide
    // in both cases, because bumpiness all one size is a pattern rather than a
    // surface.
    //
    // THE RIVER TOP DOUBLED AND THE OTHER TWO DID NOT, a budget result rather than
    // a taste one. `hi` in the bed constructor is the max over every reachable
    // environment, so the RIVER band moves freely under the cliff band's 10 m and
    // costs nothing. The cliff and peak are downstream of `radius` and reach is
    // quadratic: taking the top to 20 m makes `minReach` demand 1200 m instead of
    // 600, and a cliff camera goes from 15,243 instances and 61k triangles to
    // 60,680 and 224k, against §5's ~190k for ALL props. A bigger cliff cap is not
    // 10 m -> 20 m, it is the frame -- affordable only if the count pays for it.
    sizeByEnv: {
      river: [0.5, 6.0],
      cliff: [1.0, 10.0],
      peak: [1.0, 10.0],
    },
  },
  {
    // THE ONLY BED THAT EXISTS BELOW THE WATERLINE, and the reason it is its own
    // bed rather than a rate on an existing one is the same reason `scree` is:
    // it wants a different SIZE and a different SHAPE from anything a bed
    // already places, and neither is expressible as a multiplier on one.
    //
    // What it is for: a lake floor with nothing on it but crust caps is a
    // TEXTURE. Caps are open shells bedded flush into the surface -- they ARE
    // the floor, in relief -- so however many there are, the eye reads one
    // continuous rippled sheet and the water reads as a shader over ground. A
    // closed, rounded stone standing PROUD of that sheet is the opposite kind of
    // object: it has a silhouette, it occludes what is behind it, and at five
    // metres in poor visibility it resolves before the floor does. That shape
    // looming out of the murk is the whole effect, and it is why the bed is
    // sparse: something you come across is mysterious, something there is one of
    // every four metres is gravel.
    name: 'sunken',
    // ROUNDED AND CLOSED, all three, and both halves matter. Closed, because
    // `openBottom` is the crust bed's trick and a shell needs a surface to be
    // stuck to -- these stand ON the floor rather than being part of it.
    // Rounded (`smooth` 0.95 and up in the bank) because a stone that has spent
    // its life underwater has no fresh fracture faces; the angular shapes are
    // what a cliff sheds, and there is no cliff down here. One lump, one bigger
    // lump and one long low dome is as much silhouette variety as three shapes
    // can carry.
    names: ['cobble', 'roundstone', 'whaleback'],
    // 0.02 x 0.5 is one stone per 100 m2, about one every ten metres. Set
    // against the crust bed's 0.32 on the same ground -- one cap per 3 m2 --
    // this bed is a thirtieth of the lake floor's stone by count, which is the
    // ratio that keeps it reading as an event rather than as cover.
    density: 0.02,
    // Three hard zeroes, and unlike the crust bed's `forest` not a taste call
    // that could be reopened: `submergedOnly` means a candidate in any of these
    // environments has already failed the water test, so a rate here would be
    // unreachable. See _envAt -- submerged ground is always `river`.
    envDensity: { river: 0.5, forest: 0, cliff: 0, peak: 0 },
    fullRadius: 65,
    // Set by the `minReach` check below and not by taste: a 5 m stone holds a
    // mesh tier to 125 m and then owes its card the full ROCK_CARD_LIFE band, so
    // anything under ~295 m would cull the biggest ones mid-ladder at the bed
    // edge. It is also further than you can see through this water, which is the
    // happy version of that constraint rather than a cost.
    radius: 320,
    tile: 24,
    minElev: 0,
    // A LAKE FLOOR, NOT A DROWNED HILLSIDE. Past about forty degrees the ground
    // under water is the bank going down rather than the bed, and a rounded
    // stone perched that steep reads as placed rather than sunk -- the failure
    // `tilt` fights on the beds above, arriving through the terrain instead of
    // through the rock.
    maxSlopeDeg: 40,
    // The pair that defines the bed. `allowSubmerged` opens the water and
    // `submergedOnly` closes everything else, and the constructor refuses the
    // combination that has the second without the first.
    allowSubmerged: true,
    submergedOnly: true,
    // Halfway, like the boulders bed. A stone that has settled into silt takes
    // some of the floor's lie and keeps some of its own; full alignment is for
    // the caps, which ARE the surface.
    tilt: 0.5,
    // The one bed where varied burial is doing real work rather than adding
    // variety. Silt is deep and uneven, so the same stone half-buried and
    // three-quarters-buried are two different objects, and it costs nothing.
    sinkVary: true,
    // NO ROCK INSIDE ANOTHER ROCK -- see the scree bed. It matters more here
    // than the density suggests, because the point of the bed is the
    // silhouette: two 4 m stones interpenetrating make one 6 m blob, and the
    // shape is what was paid for. Cheap at one stone per 100 m2.
    minGap: 0.7,
    // Not an anchor. `Rocks.anchorsInto` hands callers the damp shaded base of a
    // rock for ferns and mushrooms to grow against, and the base of this one is
    // under a lake.
    anchor: false,
    // EXACTLY THE BAND THAT WAS ASKED FOR, in metres rather than as a `scale`
    // pair for the reason `sizeByEnv` exists: the three shapes are built at
    // 0.34, 1.3 and 4.5 m, so a multiplier giving the whaleback a five-metre top
    // would put the cobble's at 0.4 and the bed would be three size classes
    // wearing one range. Dividing back through each shape's measured width makes
    // the range mean the same thing for all three.
    //
    // The top is a third of what stands in the same water on the bank: a 5 m
    // stone is something you swim around, and bigger stops being a boulder and
    // starts being terrain the terrain does not know about.
    sizeByEnv: {
      river: [0.5, 5.0],
    },
  },
  {
    name: 'giants',
    names: ['blockhouse', 'blockstack', 'shelf', 'buttress', 'spire', 'tor', 'whaleback', 'lip'],
    density: 0.0006,
    // A house-sized rock in a wood is a landmark and has to stay one: 0.25 of
    // 0.0006 is one per 6,700 m2, one every ~80 m -- rare enough to notice, common
    // enough that a walk passes several. A cliff face runs full rate and is covered.
    envDensity: { river: 0.15, forest: 0.25, cliff: 1, peak: 0.8 },
    fullRadius: 270,
    radius: 1250,
    tile: 70,
    // THIS IS THE BED THE CARD WAS BUILT FOR. A 7 m tor holds T80 to 53 m and T20
    // to 175, then cards for the remaining 1075 m -- a ~4.8 km2 annulus where forty
    // triangles become two. Gains least from tightening the ladder: its rocks were
    // always the ones big enough to earn their mesh.
    minElev: 0,
    maxSlopeDeg: 62,
    // A ten-metre buttress in a lake is a landmark nobody asked for, and a lake
    // bed is not where a cliff face is.
    allowSubmerged: false,
    tilt: 0.55,
    sinkVary: true,
    // A cheap anchor bed: one giant per ~80 m is a handful in any box a caller
    // asks about, each a landmark whose base the eye is already on.
    anchor: true,
    // A giant is what you navigate by, so members within a factor of two of each
    // other read as one prop repeated -- worst on the spire, where same-sized
    // pinnacles give the "field of fangs" look. 0.5 - 2.2 opens the bed's own
    // 3.2 - 7.0 m span to 1.6 - 15 m.
    scale: [0.5, 2.2],
  },
]

// Where the four environments cut. All read off the same field sample the
// placement test already pays for, plus one water lookup.
//
// A rock this far out of the water still belongs to the river: the wet-shaded
// flat variants are for the bed AND the bank, and a hard edge at the waterline
// would put a lichen boulder half in the stream.
const SHORE_RISE = 1.6

// Metres BELOW the local snow line at which a site counts as peak country. Well
// below, because the jagged stuff has to start before the white does: bare rock
// up to the snow with spires only above it reads as two mountains stacked.
const PEAK_BELOW_SNOW = 55

// Steeper than this and a site is a cliff, not a wood. 34 degrees is just past
// render/trees.js's 32 degree tree limit, so the ground with no trees on it is
// the ground that gets cliff furniture.
const CLIFF_SLOPE_DEG = 34
const CLIFF_TAN = Math.tan((CLIFF_SLOPE_DEG * Math.PI) / 180)

// Metres below the snow line at which moss gives out. See Rocks.syncBands.
const MOSS_DROP = 220

// The per-instance range each of the two seasons is rolled into, as a fraction
// of the world's own ceiling. Both are stone-only in the shader; the argument
// for the numbers is in Rocks.syncBands.
const SNOW_CAP = [0.3, 0.5]
const MOSS_CAP = [0, 0.5]

// How deep a rock is bedded, as a fraction of its own height: this much at the
// flat, rising to this plus the span at the bed's slope limit. A rock resting
// exactly on the ground reads as placed; a third buried reads as part of the
// hill. rock.js's `sit` already cut a flat bed face at the bottom of every one
// of these, so this is burying the bed face, not standing on a point.
const SINK_MIN = 0.06
const SINK_SLOPE = 0.28

// The deep end of the per-instance burial roll, for beds that set `sinkVary`.
// Half a rock underground has been there long enough for the hill to grow up
// around it. Rolling it PER INSTANCE is the point: a scatter where every rock is
// bedded the same fraction reads as props standing ON the terrain rather than as
// stone coming OUT of it, and the giveaway is that they all meet the ground at
// the same relative height.
//
// It wastes triangles -- the buried part is still built, skinned and submitted,
// up to half a rock at 0.5 -- but `sit`'s flat bed face means what is buried is a
// stump rather than a full lower hemisphere.
const SINK_DEEP = 0.5

// EXTRA burial for an open shell, as a fraction of its own WIDTH rather than its
// height. An `openBottom` variant has no underside at all (rock.js), so its rim
// must never stand clear of the ground -- from below you would look straight into
// the inside through backfaces. The ordinary sink is a fraction of HEIGHT, these
// are the flattest things in the bank, and `sinkVary` rolls that fraction over
// 6%..SINK_DEEP, so a 2 m capslab 24 cm tall can sit on a centimetre and a half of
// burial that the first bump in the terrain eats. Width is the right dimension
// because what has to go under is the rim, and the rim is as far from the centre
// as the shape is wide.
const OPEN_BURY = 0.05

// --- relief, which is where the two site-tagged families live ----------------
//
// Metres along the fall line for the direction probe and for the relief probe.
// The direction is taken over a LONG step on purpose: at a metre or two the
// gradient is dominated by the ridged noise the terrain is built from, and a fall
// line from that points somewhere different every few metres -- the relief test
// would read noise rather than landform.
const RELIEF_STEP = 6
const RELIEF_PROBE = 16

// How much the ground has to depart from its own local slope over that probe
// before a site counts. A SECOND difference: the probe's height is compared
// against what the local gradient predicts, so a uniform slope of any steepness
// scores zero and only a CHANGE of steepness scores. Seven metres over sixteen is
// a genuine break -- at the 34 degree cliff threshold the linear prediction
// already climbs eleven, so seven on top means something near vertical.
const FOOT_RISE = 7
const BROW_DROP = 7

// What fraction of the rocks at a qualifying site take the site's own shapes.
// Not 1: the base of a cliff has ordinary cliff rock in it as well as scree, and
// a lip is a feature rather than a fringe. The remainder fall through to the
// environment's ordinary pool.
const SITE_SHARE = 0.75

// Scree lies in PILES, and this is the field that makes them. A smooth value
// noise on this lattice multiplies local density at foot sites only, so the base
// of a face runs from bare to CLUMP_GAIN times its environment over a few tens of
// metres. Without it density is uniform along the base of every cliff in the
// world, which reads as gravel spread with a rake. The 26 m cell is just under the
// boulder bed's 28 m tile -- the only bed rostering a `foot` shape -- so a pile is
// about one tile across, and the lattice has its own origin and seed
// (`tileSeed(cx, cz, seed, -1)`) so it never inherits the tile grid's edges. Raise
// this to make a drift a landform rather than a patch.
const CLUMP_CELL = 26
const CLUMP_GAIN = 2.2

// How far a rock's tint is pulled toward the terrain colour underfoot, on exactly
// render/ferns.js's terms: the terrain's own vertex colour from the chunk mesher's
// `shade`, RENORMALISED TO UNIT LUMINANCE so what survives is hue and not
// magnitude. Magnitude has to go because a rock's tint is a DESTINATION
// (ENV_TINTS, rock-bank.js), so multiplying by the terrain's near-black palette
// would delete the rock rather than darken it.
//
// ABOVE THE FERNS' 0.35, reversing the old argument that a rock is a different
// material from the ground a fern grows out of. True of a boulder at arm's length,
// false of the population that matters: most stone in the world is far enough away
// to be a flat photograph, and hue is all that is left at that range. A cue tuned
// on the near case leaves the far case reading as grey confetti.
//
// PER ENVIRONMENT, AND THE ORDER OF THE FOUR IS THE WHOLE POINT: it runs from the
// ground a rock is made OF to the ground it is merely standing on. River highest
// (a rock on a river bottom IS the river bottom), cliff and peak next (the crust
// bed is literally the cliff), forest lowest -- granite on green loam genuinely is
// a different material, so the cue costs most and buys least there. None reaches
// 1: the stones still have to be findable. Free either way -- three multiplies per
// rock, chosen once at placement and baked into the instance colour. §25.
const GROUND_CUE = { river: 0.75, forest: 0.45, cliff: 0.55, peak: 0.55 }

// Everything below is render/trees.js's, unchanged, and its header is the
// explanation for all of it.
const LOD_HYSTERESIS = 0.12
const BUILD_BUDGET_MS = 1.5
const PLACEMENT_CELL = 4.0
const GROUND_SWEEP = 16

// Ceilings on the cross-dissolve, in instances, PER BED -- render/grass.js's
// pair and its reasoning verbatim, except that six beds share the frame here.
//
// Measured over thirty seconds of walking at 5 m/s across the endless cliff
// apron: 50 dissolves in flight in the mean frame, 1,151 in the worst, 2,366
// ghost triangles at the peak against ~99k the beds were drawing anyway. The
// steady state is nothing, and walking never reaches the ceiling.
//
// TELEPORTING DOES, and that is the case it is for. `check-rocks` steps the
// camera 9 m between updates and the crust bed saturates at exactly 1024, because
// the ladder is measured in ROCK SIZES -- 4, 7.5 and 25 of them -- so a 9 m jump
// carries every pebble on a rung across it at once. The ceilings stop that
// becoming a pool exhaustion (which THROWS, in `_growTile`) or a frame spent
// animating a jump cut nobody would see. Past either limit a swap simply pops,
// which is what every swap did before this existed: a loss of polish, never a
// loss of rocks.
const FADE_MAX_INFLIGHT = 1024
const FADE_POOL_RESERVE = 1024

// ROCK_LOD_AT is in metres of camera distance per metre of ladder size, so what
// `update` wants is the square of it: compare d2 against size-squared times
// these and no square root is ever taken. The OUT copy is the same ladder with
// the hysteresis slack already multiplied in -- a rock only leaves a tier it is
// already on 12% further out than it entered, so a camera parked on a threshold
// does not flicker between two meshes.
const LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => k * k)
const LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * (1 + LOD_HYSTERESIS)) ** 2)

// HOW LONG A ROCK IS A WHOLE BILLBOARD FOR, as a multiple of the distance its
// card takes over at.
//
// Flooring the gone-distance at exactly the card distance is the least that can be
// called correct, and least is what it delivered: 60% of the crust caps and 39% of
// the river underfoot rocks started dissolving in the same metre their card
// appeared, so the card showed up already dithering -- from inside the world
// indistinguishable from the mesh dithering out, which is what it was reported as.
//
// So the floor is a BAND. 2.0 is one full doubling, the span the ladder gives the
// other tiers (ROCK_LOD_AT steps 4 -> 7.5 -> 25, so 1.9x then 3.3x) and the span
// the thinning law is written in. NOT FREE: a bed may not end before its own
// ladder does (`minReach`), so this multiplies every bed's radius and its pool.
// Do not raise it without re-running scripts/check-rocks.mjs, which bounds both.
const ROCK_CARD_LIFE = 2.0

/**
 * The gone-distance a rock of ladder size `size` metres must be given, in metres,
 * for its card to live a full `ROCK_CARD_LIFE` band before dithering.
 *
 * The one place `_fadeFloor`, `_exemptFrac` and the constructor's reach check
 * agree on what "past the end of the ladder" means, so they cannot drift.
 *
 * The divisor stays FADE_BAND even though the rim now fires at the larger
 * `RIM_AT`: dividing by the smaller number pushes the gone-distance FURTHER out,
 * so the band this buys is a superset of the one it promises. RIM_AT would shave
 * 8% off every rock's reach for no gain but tightness.
 */
function cardGoneAt(size) {
  return (size * ROCK_LOD_AT[ROCK_LOD_AT.length - 1] * ROCK_CARD_LIFE) / FADE_BAND
}

/** Deterministic 32-bit PRNG. Same one the rest of the project uses. */
function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A tile's seed, from its own coordinates, the world seed and the BED. The bed
 * index is mixed in so the scatters are independent fields rather than the same
 * one at three scales -- without it every giant would have a pebble on its
 * exact centre.
 */
function tileSeed(tx, tz, seed, bed) {
  let h =
    Math.imul(tx | 0, 0x27d4eb2d) ^
    Math.imul(tz | 0, 0x165667b1) ^
    Math.imul(seed | 0, 0x9e3779b1) ^
    Math.imul(bed + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/**
 * The horizontal reach of a built rock at height `y` above its own bed plane, in
 * the geometry's own metres (instance scale 1). Called once per shape at boot to
 * fill a bed's `footRadius`; see Rocks.anchorsInto for what a caller does with it.
 * The argument is DESIGN.md §25.
 *
 * A CROSS-SECTION AND NOT `measured`: rock.js publishes the whole seated shape's
 * extents, and a rock's widest part is its equator, which on a bedded rock sits
 * well ABOVE the dirt. The outline where stone meets ground is measured off the
 * geometry that actually ships -- every triangle edge straddling the plane gives
 * one boundary point, since the cross-section polygon's vertices are exactly those
 * crossings. The geometry is non-indexed by construction (rock.js writes an
 * identity index for BatchedMesh's sake only), so consecutive triples are
 * triangles.
 *
 * IT RETURNS THE FURTHEST BOUNDARY POINT FROM THE LOCAL ORIGIN: the smallest
 * circle about the anchor that CONTAINS the stone at the ground line, not any
 * average of it, because a caller asking where the rocks are is asking so it can
 * stand something clear of them. Containment costs a stand-off on the narrow axis
 * of a long rock -- the bank's sections run to about 3:1 -- and that is the cheap
 * error: a mushroom a foot from a boulder still reads as a mushroom by a boulder,
 * and one growing through it reads as nothing.
 *
 * `what` NAMES THE SHAPE FOR THE THROW BELOW and nothing else: the geometry knows
 * only which LOD tier it is, and "T180" is no help to somebody looking for which
 * of thirty-nine boulders stopped the world from booting.
 */
function sectionRadius(geo, y, what) {
  const pos = geo.attributes.position.array
  let hits = 0
  let r2 = 0
  for (let f = 0; f < pos.length; f += 9) {
    for (let e = 0; e < 3; e++) {
      const a = f + e * 3
      const b = f + ((e + 1) % 3) * 3
      const ya = pos[a + 1]
      const yb = pos[b + 1]
      if ((ya < y && yb < y) || (ya > y && yb > y) || ya === yb) continue
      // No clamp on `t`: the test above has already thrown out every edge with
      // both ends on one side of the plane and every horizontal one, so what
      // is left straddles it and `t` is in [0, 1] by construction.
      const t = (y - ya) / (yb - ya)
      const x = pos[a] + (pos[b] - pos[a]) * t
      const z = pos[a + 2] + (pos[b + 2] - pos[a + 2]) * t
      const d2 = x * x + z * z
      if (d2 > r2) r2 = d2
      hits++
    }
  }
  // A plane inside the rock's own height that cuts nothing means the shape is not
  // what this measurement assumes -- an open shell whose rim starts above the
  // ground line, say -- and a footprint radius of zero would be a silent lie.
  if (!hits) {
    throw new Error(
      `sectionRadius: nothing crosses y = ${y} in ${what} at tier ${geo.userData.rock.tier}`
    )
  }
  return Math.sqrt(r2)
}

/**
 * One size band's scatter: its own tile grid, its own pool, its own BatchedMesh.
 *
 * Not exported. `Rocks` owns one per BEDS entry, plus the bank and material they
 * share; nothing outside this file has any reason to hold one.
 */
class RockBed {
  constructor(scene, field, water, layers, material, bank, cfg, index, { seed, ground }) {
    this.field = field
    this.water = water
    this.layers = layers
    this.cfg = cfg
    this.index = index
    this.seed = seed
    this.ground = ground

    const tile = cfg.tile
    this.tile = tile
    this.density = cfg.density
    this.radius = cfg.radius
    this.fullRadius = cfg.fullRadius
    this.fullSq = cfg.fullRadius * cfg.fullRadius

    this.perTile = Math.max(1, Math.round(tile * tile * cfg.density))
    this.tileSpan = Math.ceil(cfg.radius / tile) + 1
    this.radiusSq = cfg.radius * cfg.radius
    this.evictSq = (cfg.radius + tile * 1.5) ** 2
    this.maxSlopeTan = Math.tan((cfg.maxSlopeDeg * Math.PI) / 180)
    // Under 1 weights the size roll towards the top of its range -- see the
    // scree bed, which is the only one that asks.
    this.sizeBias = cfg.sizeBias ?? 1
    // Zero on every bed but scree. See the dart in _growTile.
    this.minGap = cfg.minGap ?? 0

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / cfg.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (cfg.fullRadius * Math.pow(2, q / QUANT)) ** 2

    // The bed's own slice of the bank, and the per-environment index into it.
    // Shapes are (variant x seed) pairs, so `shapes` is longer than `names`.
    this.shapes = bank.shapes.filter((s) => cfg.names.includes(s.name))
    if (!this.shapes.length) throw new Error(`RockBed ${cfg.name}: no bank shape matches ${cfg.names.join(', ')}`)

    // BANDS ARE BOUNDARIES BETWEEN TIERS, so there is always exactly one fewer of
    // them than there are tiers. ROCK_LOD_AT is one ladder in metres PER METRE of
    // rock that every bed reads, so this checks props/rock.js rather than the
    // config, and lives here because this is the file that indexes both.
    if (ROCK_LOD_AT.length !== ROCK_BAND_COUNT - 1) {
      throw new Error(
        `RockBed ${cfg.name}: ${ROCK_LOD_AT.length} LOD thresholds for ${ROCK_BAND_COUNT} tiers, want ${ROCK_BAND_COUNT - 1}`
      )
    }
    for (const env of ENVIRONMENTS) {
      if (!(cfg.envDensity[env] >= 0)) {
        throw new Error(`RockBed ${cfg.name}: envDensity has no entry for ${env}`)
      }
    }
    // EXACTLY ONE of the two ways of saying how big -- see where `scale` is
    // resolved in _growTile. Both would mean one of them is silently ignored,
    // which is the failure that takes an afternoon to find.
    if (!cfg.scale === !cfg.sizeByEnv) {
      throw new Error(`RockBed ${cfg.name}: wants exactly one of \`scale\` and \`sizeByEnv\``)
    }
    // A bed that requires water and is not allowed water places nothing, and that
    // presents as an empty lake with no error anywhere. Say it here instead.
    if (cfg.submergedOnly && !cfg.allowSubmerged) {
      throw new Error(`RockBed ${cfg.name}: \`submergedOnly\` without \`allowSubmerged\` can never place a rock`)
    }
    if (cfg.sizeByEnv) {
      for (const env of ENVIRONMENTS) {
        // Only the environments this bed can actually reach: a zero rate means
        // no candidate ever resolves a size there, and demanding a range for
        // ground the bed refuses would be asking for a number with no meaning.
        if (cfg.envDensity[env] === 0) continue
        const span = cfg.sizeByEnv[env]
        if (!span || !(span[0] > 0) || !(span[1] > span[0])) {
          throw new Error(`RockBed ${cfg.name}: sizeByEnv.${env} must be an ascending range in metres`)
        }
      }
    }

    // EACH SHAPE'S LADDER SIZE AT SCALE 1, indexed the same way `shapes` is. A
    // rock's live size is this times its own uniform scale, which is one
    // multiply in the per-frame loop and saves carrying a second per-instance
    // array beside `instScale`. See rockLodSize for why it is neither the width
    // nor the height.
    this.shapeLod = Float32Array.from(this.shapes, (s) => rockLodSize(s.measured))

    // THE BIGGEST ROCK THIS BED CAN PLACE, and through it the distance past which
    // no instance of it can still be on a mesh tier. `update` uses that to skip
    // whole tiles instead of walking them rock by rock -- everything out there is
    // on the card, so one `_demote` says it for the tile.
    //
    // A bound and not an average on purpose: a tile with one 10 m cap in it must
    // not be demoted because the bed's typical rock is 2 m. The two branches are
    // the two ways a bed says how big -- `sizeByEnv` names a target WIDTH, so the
    // bound goes through the worst ladder-size-per-width in the bed's own roster,
    // while `scale` multiplies the shape as built.
    //
    // `_fadeFloor` needs the same bound as a FUNCTION of the size roll and not
    // just at its top, so it is built here as the line `lodP + roll * lodQ` and
    // `maxLod` is its value at roll 1.
    const lodPerWidth = cfg.sizeByEnv
      ? Math.max(...this.shapes.map((s, i) => this.shapeLod[i] / s.measured.width))
      : Math.max(...this.shapeLod)
    const envs = cfg.sizeByEnv ? ENVIRONMENTS.filter((e) => cfg.envDensity[e] > 0) : null
    const lo = cfg.sizeByEnv ? Math.max(...envs.map((e) => cfg.sizeByEnv[e][0])) : cfg.scale[0]
    const hi = cfg.sizeByEnv ? Math.max(...envs.map((e) => cfg.sizeByEnv[e][1])) : cfg.scale[1]
    // Taking the max of the ends separately is an UPPER bound on the max of the
    // per-environment lines, which is what a bound has to be: each line is
    // (1-r)*lo_e + r*hi_e <= (1-r)*max(lo) + r*max(hi).
    this.lodP = lo * lodPerWidth
    this.lodQ = (hi - lo) * lodPerWidth
    const maxLod = hi * lodPerWidth
    const maxCardAt = maxLod * ROCK_LOD_AT[ROCK_LOD_AT.length - 1]
    this.nearSq = (maxCardAt + tile * 1.5) ** 2

    // A BED MAY NOT END BEFORE ITS OWN LADDER DOES. `_rankOf` guarantees no rock
    // is thinned away while it is still a mesh, but it cannot help one that runs
    // out of BED first: past `radius` the tiles are not resident at all, so a bed
    // whose reach is shorter than its biggest rock's card distance culls that rock
    // outright, mid-ladder. The two numbers are authored independently -- `radius`
    // by how far the feature reads across a valley, the card distance by
    // `sizeByEnv` times ROCK_LOD_AT -- so nothing but this stops them drifting
    // apart. Crust was the bed that had: 10 m caps wanting 250 m against a 170 m
    // reach, so one cap in six died as an LOD2 mesh at the bed edge.
    //
    // `cardGoneAt` is the figure `_fadeFloor` works to, for the same reason: the
    // card is meant to be whole for a `ROCK_CARD_LIFE` band past the distance it
    // takes over at, and the dissolve at `radius` STARTS at 0.85 of it. A reach of
    // exactly the card distance has the biggest rocks dithering while they are
    // still meshes; a reach of the card distance times the band has them dithering
    // the instant they card, which measured as 60% of the crust caps.
    const minReach = cardGoneAt(maxLod)
    if (cfg.radius < minReach) {
      throw new Error(
        `RockBed ${cfg.name}: radius ${cfg.radius} m is inside its own card distance ` +
          `(${maxCardAt.toFixed(1)} m, needing ${minReach.toFixed(1)} m once the ${ROCK_CARD_LIFE}x ` +
          `billboard band and the dissolve band are allowed for) -- its biggest rocks would ` +
          `dissolve as meshes, or the instant they carded, at the bed edge. ` +
          `Widen \`radius\`, or shrink the bed's top size.`
      )
    }
    // Required rather than defaulted, because the default that reads as safe --
    // "not an anchor" -- is the one that silently drops a whole bed out of
    // Rocks.anchorsInto and leaves the caller wondering where its rocks went.
    if (typeof cfg.anchor !== 'boolean') {
      throw new Error(`RockBed ${cfg.name}: BEDS entry has no \`anchor\` flag -- see Rocks.anchorsInto`)
    }
    // Two indices, and the split is the point. `byEnv` is the ordinary pool and
    // holds ONLY the untagged shapes, so a talus chip can never be drawn for a
    // site that did not ask for one; `bySite` holds the tagged ones keyed by env
    // and site. `siteEnvs` is the cheap gate that keeps _relief off the fast path:
    // a bed with no tagged shapes in this environment never probes relief at all.
    this.byEnv = new Map()
    this.bySite = new Map()
    this.siteEnvs = new Set()
    for (const env of ENVIRONMENTS) {
      const pick = (test) => this.shapes.map((s, i) => (test(s) ? i : -1)).filter((i) => i >= 0)
      this.byEnv.set(env, pick((s) => s.envs.includes(env) && s.site === null))
      for (const site of SITES) {
        const pool = pick((s) => s.envs.includes(env) && s.site === site)
        this.bySite.set(`${env}|${site}`, pool)
        if (pool.length) this.siteEnvs.add(env)
      }
    }

    // WHAT EACH SHAPE COVERS OF THE GROUND, at instance scale 1, for
    // Rocks.anchorsInto, which multiplies by the instance's own scale and hands the
    // result out. Measured here rather than at query time because it is a scan of
    // the shape's triangles (sectionRadius) and the shapes are fixed for the life
    // of the bed: 39 shapes at boot against a per-frame loop over thousands of
    // instances. It must be the constructor for a second reason -- Rocks disposes
    // the bank's geometries the moment the beds are built.
    //
    // ONLY AN ANCHOR BED IS MEASURED, since sectionRadius throws rather than
    // reporting a footprint of zero, so scanning a bed nobody can query is a
    // boot-time abort of the world on its behalf. `footRadius` stays null on those
    // beds rather than zero-filled: a bed asked anyway should fail where it is
    // asked instead of answering that its rocks cover no ground.
    //
    // THREE THINGS ARE APPROXIMATED IN THIS NUMBER, not one, and §25 has the
    // measurements. BURIAL caches one representative `frac` per bed (0.28 varying,
    // 0.20 not) where the real value is per instance and runs [0.34, 0.5] on steep
    // ground -- mean shape within 9%, worst `cobble` 1.62x inward. TILT is the one
    // that opens a real gap: the section is cut in the geometry's own frame and
    // _growTile then leans the rock downhill about the same origin, carrying the
    // footprint some 23 cm off the reported anchor on 40 degree ground. TIER scans
    // `tiers[0]` while a coarser solid is drawn past the outer band edge, 0.56x to
    // 1.29x of it, and bites only past 130 m / 300 m.
    //
    // IF ANY OF IT EVER SHOWS AS MUSHROOMS STANDING IN STONE, the fix is a
    // per-instance section rather than a bigger constant: instSink and instScale
    // are already here and the lean is one _groundTilt away, so what is missing is
    // only the shape's own height profile.
    this.footRadius = null
    if (cfg.anchor) {
      const midSink = cfg.sinkVary ? (SINK_MIN + SINK_DEEP) / 2 : SINK_MIN + SINK_SLOPE / 2
      this.footRadius = new Float32Array(this.shapes.length)
      for (let i = 0; i < this.shapes.length; i++) {
        const s = this.shapes[i]
        let y = s.measured.height * midSink
        if (s.openBottom) y += s.measured.width * OPEN_BURY
        this.footRadius[i] = sectionRadius(s.tiers[0], y, `${s.name}#${s.seed}`)
      }
    }

    this.maxInstances = this._poolBound()

    // Arena entries are de-duplicated BY GEOMETRY IDENTITY. Nothing is shared
    // any more -- every shape builds all four of its slots for itself, so this
    // Set only removes the duplicates a bed creates by rostering a shape twice
    // -- but the de-duplication stays because the arena is sized off `unique`
    // and a double entry would silently double the vertex budget.
    const unique = [...new Set(this.shapes.flatMap((s) => s.tiers))]
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      unique.reduce((n, g) => n + g.attributes.position.count, 0),
      unique.reduce((n, g) => n + g.index.count, 0),
      material
    )
    this.batch.name = `v2-rocks-${cfg.name}`
    this.batch.frustumCulled = false
    this.batch.sortObjects = false

    const idOf = new Map()
    for (const g of unique) idOf.set(g, this.batch.addGeometry(g))

    // THE TIER TABLE. The last slot of every shape's `tiers` is the 2-triangle
    // card, and the last slot of every bed's table too. NO BED DECLINES IT, and the
    // opt-out that let the crust bed decline is gone with the per-bed bands that
    // justified it -- see §25 for both reasons that expired.
    //
    // WHAT IS STILL TRUE is that a card is a flat photograph and a rock bedded deep
    // into a face has most of itself underground, so the quad stands taller than
    // the visible part of the mesh it replaces. That is a poke-out of a fraction of
    // a metre at a range where the rock is a few pixels tall, and it is the price
    // of one ladder rather than five.
    this.tierIds = []
    this.tierTris = []
    for (let t = 0; t < ROCK_BAND_COUNT; t++) {
      const slot = t
      this.tierIds.push(this.shapes.map((s) => idOf.get(s.tiers[slot])))
      // A mesh tier carries userData.rock, a card carries userData.impostor, and
      // both carry `triangles`. Read whichever is there and throw on neither: a
      // tier that is a third kind of thing is a bug, and a silent 0 here would
      // show up as a triangle budget that quietly stops counting.
      this.tierTris.push(
        this.shapes.map((s) => {
          const u = s.tiers[slot].userData
          const meta = u.rock || u.impostor
          if (!meta) throw new Error(`RockBed ${cfg.name}: ${s.name}#${s.seed} tier ${slot} is neither mesh nor card`)
          return meta.triangles
        })
      )
    }

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0][0])
      this.batch.setVisibleAt(id, false)
      this.free[this.maxInstances - 1 - i] = id
    }

    // FORCE THE COLOURS TEXTURE INTO EXISTENCE NOW, EVEN FOR A BED THAT NEVER
    // PLACES A ROCK. Not tidiness: this is the fix for rocks blinking furiously at
    // particular camera angles, and nothing about the symptom points at this line.
    // §25 traces it end to end; the short form:
    //
    // `setColorAt` is otherwise the FIRST thing to allocate `_colorsTexture`, so a
    // bed that places nothing near the camera (`scree` on most terrain) had none
    // while its siblings did. Every bed shares ONE material, hence one program and
    // one set of sampler assignments, and three assigns `batchingColorTexture` only
    // `if (object._colorsTexture !== null)` -- so that bed took units 0 and 1 where
    // its siblings took 0, 1 and 2. When the depth sort put it FIRST (hence the
    // dependence on camera angle), `refreshMaterial` was still true, the material's
    // samplers were handed 2, 3, 4, and `uAtlas` (sampler2DArray) landed on unit 2
    // still bound as `batchingColorTexture` (sampler2D) by a program compiled WITH
    // USE_BATCHING_COLOR for a sibling. Two texture types on one sampler location
    // is a hard GL error: ANGLE rejects the draw with `GL_INVALID_OPERATION:
    // glMultiDrawElementsANGLE` while the CPU still counts it as submitted, so
    // every rock on that program vanished for the frame and the draw counts looked
    // healthy throughout.
    //
    // THREE'S GUARD FOR THIS CASE IS DEAD and cannot be relied on: it tests
    // `object.colorTexture`, BatchedMesh only ever defines `_colorsTexture`, and
    // `undefined === null` is false, so the mismatched program is reused.
    //
    // Giving every bed the texture makes them all consume the same three batching
    // units, so the shared material's samplers always start at 3 and the collision
    // cannot arise whatever order the depth sort picks. The white this writes is
    // the same white `_initColorsTexture` fills the whole texture with, and
    // instance 0 is invisible until placement overwrites it anyway.
    this.batch.setColorAt(0, new THREE.Color(1, 1, 1))

    this.shapeAt = new Uint16Array(this.maxInstances)
    this.tierAt = new Int8Array(this.maxInstances).fill(-1)
    this.instX = new Float32Array(this.maxInstances)
    this.instY = new Float32Array(this.maxInstances)
    this.instZ = new Float32Array(this.maxInstances)
    this.instSink = new Float32Array(this.maxInstances)
    // The scale is otherwise spent into the instance matrix and gone, and two
    // things want it back: Rocks.anchorsInto, whose footprint radius is this
    // times the shape's unit radius, and `update`, which multiplies it by
    // `shapeLod` to get the size the LOD ladder is measured in.
    this.instScale = new Float32Array(this.maxInstances)
    // The rock's FOOTPRINT WIDTH in metres once scaled. Only the anti-overlap
    // dart in _growTile reads it, and width is the right metre there for the
    // same reason it is the wrong one for the ladder: what must not collide is
    // the ground each rock covers, not how big it looks.
    this.instSpan = new Float32Array(this.maxInstances)
    // The rim dissolve: which rocks are drawn, which are hidden, and the quarter
    // second between. It holds each rock's gone-distance as `rim.gone`, and it
    // shares ONE float per instance with the cross-dissolve below -- so it is
    // handed the callback that retires a swap it is about to write over, and
    // `_crossFade` asks `isBusy` before starting one the rim would clobber.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })

    // Cross-dissolves in flight: { orig, dup, start, tris }. `fadeAt` maps an
    // instance to its entry so a second band crossing can finish the first, and
    // so an instance being thinned or evicted can take its ghost with it.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    this.fadeTris = 0

    // One tile's worth of candidates, drawn in stream order and then replayed in
    // rank order. See _growTile for why the two passes are needed.
    const per = this.perTile
    this._cand = {
      x: new Float32Array(per), z: new Float32Array(per), rank: new Float32Array(per),
      shapeRoll: new Float32Array(per), envRoll: new Float32Array(per),
      yaw: new Float32Array(per), scaleRoll: new Float32Array(per),
      tone: new Float32Array(per), warm: new Float32Array(per),
      tintRoll: new Float32Array(per), siteRoll: new Float32Array(per),
      sinkRoll: new Float32Array(per),
    }
    this._order = []

    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._yawQ = new THREE.Quaternion()
    this._tiltQ = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._n = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._sweep = 0
    // The chunk mesher writes three floats here per placed rock; see GROUND_CUE.
    this._gc = new Float32Array(3)

    this.tris = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.regrounds = 0
    this.sited = { foot: 0, brow: 0 }
    this.rejected = { elev: 0, slope: 0, water: 0, env: 0, clump: 0, site: 0, gap: 0 }
    this.placeMs = 0
    this.lastBuildMs = 0

    scene.add(this.batch)
  }

  /** See Trees._poolBound: summed over the real tile grid, because the law is not exact. */
  _poolBound() {
    return poolBound(this.tile, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this._keepFrac(this._levelFor(d2)))
  }

  /**
   * The fraction of a tile's candidates that survive at ladder level `level`.
   *
   * NOT `uAt[level]`, and the pool would be undersized if it were: `_rankOf`
   * floors the rank, so the survivors are the UNION of the rocks that drew a low
   * enough `u` and the rocks whose card is further out than this level's distance.
   * The two events are independent -- `u` and the size roll are separate draws --
   * so the union is `u + (1 - u) * P(fadeFloor > d)`. Pool exhaustion is a hard
   * throw, so getting this wrong in the low direction crashes the bed; `_fadeFloor`
   * over-states, which makes this an upper bound and over-allocates instead.
   */
  _keepFrac(level) {
    const u = this.uAt[level]
    return u + (1 - u) * this._exemptFrac(this.fullRadius / u)
  }

  /**
   * The fraction of size rolls whose `_fadeFloor` lands beyond `d` metres.
   *
   * `_fadeFloor` is a line in the size roll, so inverting it gives the roll at
   * which the floor lands exactly on `d`, and the roll is `scaleRoll **
   * sizeBias` on a uniform `scaleRoll` -- hence the `1 / sizeBias` power. A bed
   * whose size range is a single point has `lodQ` zero and no line to invert,
   * so it is answered directly.
   */
  _exemptFrac(d) {
    const perRoll = cardGoneAt(1)
    if (this.lodQ === 0) return d < this.lodP * perRoll ? 1 : 0
    const t = (d / perRoll - this.lodP) / this.lodQ
    if (t <= 0) return 1
    if (t >= 1) return 0
    return 1 - Math.pow(t, 1 / this.sizeBias)
  }

  _levelFor(d2) {
    return levelFor(d2, this.fullSq, this.fullRadius, this.maxQ)
  }

  /**
   * The nearest gone-distance a rock drawn at this size roll may be given, in
   * metres: far enough out that the rock is still WHOLE at the distance its
   * billboard takes over at.
   *
   * Three terms, all in `cardGoneAt`. `size * ROCK_LOD_AT.at(-1)` is how far the
   * rock can still be a mesh; `ROCK_CARD_LIFE` is the span the card is then whole
   * for; the `/ FADE_BAND` is not a fudge -- the rim starts its dissolve SHORT of
   * the gone-distance it is handed, so handing it the card distance would have the
   * rock dithering before it ever cards. See `cardGoneAt` for why the divisor is
   * the old band rather than the rim's actual `RIM_AT` trigger.
   *
   * An upper bound rather than the exact figure, because the exact one needs the
   * shape, the shape needs a field sample to pick an environment, and this is
   * wanted in pass one where neither exists yet. It uses the bed's worst
   * ladder-size-per-width, so it over-states a candidate that lands on a small
   * shape and never under-states one: over-stating keeps a few rocks slightly too
   * long, under-stating would cull one before it ever cards.
   */
  _fadeFloor(sizeRoll) {
    return cardGoneAt(this.lodP + sizeRoll * this.lodQ)
  }

  /**
   * THE RANK A ROCK IS ACTUALLY THINNED BY, and it is not the one it drew.
   *
   * `u` is the thinning rank, uniform on 0..1: a tile at level q keeps exactly
   * `{u < uAt[q]}`, and since `uAt[q] = fullRadius / d_q` the surviving fraction at
   * distance d is exactly `fullRadius / d` -- the halving law this bed is built on,
   * unchanged here.
   *
   * What changes is the FLOOR. The rank alone knows nothing about how big a rock
   * is, so a bed whose `fullRadius` is shorter than its own ladder would dissolve
   * rocks still carrying a mesh: underfoot's is 18 m and its biggest rock does not
   * card until 50, so a high-ranked one used to vanish at 20-odd metres having
   * never been a billboard. Capping the rank at `fullRadius / reach` -- the rank
   * whose tile drops it exactly at its own card distance -- means every rock lives
   * until it is a card, after which the drawn rank takes over and the halving
   * resumes. Rocks small enough to card inside `fullRadius`, most of them, are
   * untouched: there the cap is above 1 and `u` is already smaller.
   *
   * ONE NUMBER FOR ALL THREE CONSUMERS: the tile ladder (`_thin`), the pool bound
   * and the shader's dissolve distance all read this and nothing else, so the
   * CPU's decision to drop a rock and the shader's decision to have finished
   * fading it cannot drift apart -- which is what keeps the thinning a dither
   * rather than a pop.
   */
  _rankOf(u, sizeRoll) {
    return Math.min(u, this.fullRadius / this._fadeFloor(sizeRoll))
  }

  /**
   * Which of the four environments a site is, from the field sample the
   * placement test already took plus one water lookup.
   *
   * Order is not arbitrary. Water wins outright, because a lake bed is a lake
   * bed however steep the ground under it. Then altitude, then slope: a sheer
   * face above the snow line is peak country, not a cliff with spires missing.
   */
  _envAt(x, z, h, tan, snowLine) {
    const level = this.water.levelAt(x, z)
    if (level !== null && h < level + SHORE_RISE) return 'river'
    if (h > snowLine - PEAK_BELOW_SNOW) return 'peak'
    if (tan > CLIFF_TAN) return 'cliff'
    return 'forest'
  }

  /**
   * Whether this point is at the FOOT of a steep face, on its BROW, or neither.
   * Returns 'foot', 'brow' or null.
   *
   * A SECOND DIFFERENCE ALONG THE FALL LINE, and it has to be: the ground at the
   * base of a cliff and the ground on its top are both flat, so neither slope nor
   * height can tell them apart. Take the local gradient, walk RELIEF_PROBE metres
   * up it and the same distance down, and compare each against what the local slope
   * alone predicted. Ground above you that outclimbs the prediction means something
   * steep is standing over you; ground below you that outfalls it means you are on
   * the edge of something. A uniform slope of any steepness scores zero at both
   * ends, which is exactly right -- a 40 degree hillside is not the foot of
   * anything.
   *
   * FOUR FIELD SAMPLES, and they are the reason siteEnvs exists: two on the fall
   * line (forward differences against the `h` the caller already has, not central
   * ones -- half the cost, and the direction is all that is wanted) and two on the
   * probe. Paid only on candidates that have already survived elevation and slope,
   * and only in environments this bed has tagged shapes for.
   *
   * Off the FIELD rather than the drawn mesh, for _groundTilt's reason: the drawn
   * surface re-splits as the player moves, and a rock that changed species when the
   * terrain LOD moved would be far worse than one misjudging a bench.
   */
  _relief(x, z, h) {
    const e = RELIEF_STEP
    const gx = (this.field.heightAt(x + e, z) - h) / e
    const gz = (this.field.heightAt(x, z + e) - h) / e
    const g = Math.hypot(gx, gz)
    // Dead flat: there is no fall line, so there is no up or down to probe and
    // nothing here is the foot or the brow of anything.
    if (g < 1e-3) return null

    const ux = -gx / g
    const uz = -gz / g
    const p = RELIEF_PROBE
    // Uphill is against the fall line; `g * p` is what a straight continuation
    // of the local slope would have climbed over the same distance.
    const rise = this.field.heightAt(x - ux * p, z - uz * p) - (h + g * p)
    const drop = h - g * p - this.field.heightAt(x + ux * p, z + uz * p)
    if (rise < FOOT_RISE && drop < BROW_DROP) return null
    // A bench between two steps can be both. Whichever break is bigger is the
    // one the eye reads, so that is the one the rock answers to.
    return rise >= drop ? 'foot' : 'brow'
  }

  /**
   * A smooth 0..1 field on a CLUMP_CELL lattice, for piling scree. Value noise
   * with the same smoothstep the shaders use, off the same mulberry32 the
   * scatter runs on, so it is a pure function of position and costs four hashes.
   *
   * NOT the tile grid and deliberately coarser than it: a pile that lined up
   * with tile boundaries would put a seam down the middle of every drift.
   */
  _clump(x, z) {
    const cx = Math.floor(x / CLUMP_CELL)
    const cz = Math.floor(z / CLUMP_CELL)
    let fx = x / CLUMP_CELL - cx
    let fz = z / CLUMP_CELL - cz
    fx = fx * fx * (3 - 2 * fx)
    fz = fz * fz * (3 - 2 * fz)
    // Reusing tileSeed with a bed index of -1 keeps this field independent of
    // every bed's scatter -- see its own note on why the bed is mixed in.
    const at = (ix, iz) => mulberry32(tileSeed(cx + ix, cz + iz, this.seed, -1))()
    const a = at(0, 0) + (at(1, 0) - at(0, 0)) * fx
    const b = at(0, 1) + (at(1, 1) - at(0, 1)) * fx
    return a + (b - a) * fz
  }

  place(cx, cz) {
    const t0 = performance.now()
    this._reseat(cx, cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  update(camX, camY, camZ, budgetMs) {
    this._reseat(camX, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < budgetMs) this._growTile(this.queue.pop())
    this.lastBuildMs = performance.now() - t0

    // Retire finished cross-dissolves BEFORE the tile loop starts new ones, so a
    // rock that swaps a band on the same frame its previous fade expires gets
    // its duplicate back rather than being refused for want of one.
    const now = getPropClock()
    this._sweepFades(now)
    this.rim.beginFrame(camX, camY, camZ)

    const tile = this.tile
    const coarse = ROCK_BAND_COUNT - 1
    let tris = 0
    const phase = this._sweep
    this._sweep = (this._sweep + 1) % GROUND_SWEEP
    const ground = this.ground
    let ti = 0
    for (const t of this.tiles.values()) {
      if (ground && ti++ % GROUND_SWEEP === phase) {
        const gkey = ground.groundKeyAt((t.tx + 0.5) * tile, (t.tz + 0.5) * tile)
        if (gkey !== t.gkey) {
          t.gkey = gkey
          this._reground(t)
          this.regrounds++
        }
      }

      const nx = Math.max(t.tx * tile, Math.min(camX, (t.tx + 1) * tile))
      const nz = Math.max(t.tz * tile, Math.min(camZ, (t.tz + 1) * tile))
      const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

      this.rim.sweepTile(t, this.instX, this.instY, this.instZ, camX, camY, camZ)

      const q = t.q
      const thicken = near2 < this.loSq[q]
      const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
      if (!t.queued && (thicken || thin)) {
        t.queued = true
        this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2 })
      }

      const dx = (t.tx + 0.5) * tile - camX
      const dz = (t.tz + 0.5) * tile - camZ
      const near = dx * dx + dz * dz < this.nearSq
      if (!near) {
        if (t.near) this._demote(t, coarse)
        t.near = false
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          if (this.rim.isHidden(id)) continue
          tris += this.tierTris[coarse][this.shapeAt[id]]
        }
        continue
      }
      t.near = true
      for (let k = 0; k < t.n; k++) {
        const i = t.ids[k]
        if (this.rim.isHidden(i)) continue
        const ex = this.instX[i] - camX
        const ey = this.instY[i] - camY
        const ez = this.instZ[i] - camZ
        const d2 = ex * ex + ey * ey + ez * ez
        const cur = this.tierAt[i]
        const shape = this.shapeAt[i]

        // The thresholds are per rock, not per bed: a 12 m tor and a 0.4 m
        // cobble read the same ladder, and the tor holds its finest mesh out to
        // 48 m where the cobble is already on the card at 5. All that separates
        // them is the size they are measured in -- `shapeLod` at scale 1, times
        // the scale this instance was placed at.
        const size = this.shapeLod[shape] * this.instScale[i]
        const sizeSq = size * size
        let tier = coarse
        for (let b = 0; b < LOD_SQ.length; b++) {
          const sticky = cur >= 0 && cur <= b
          if (d2 < sizeSq * (sticky ? LOD_SQ_OUT[b] : LOD_SQ[b])) {
            tier = b
            break
          }
        }

        if (tier !== cur) {
          this.tierAt[i] = tier
          this.batch.setGeometryIdAt(i, this.tierIds[tier][shape])
          // `cur < 0` is an instance that has never been tiered -- there is no
          // departing mesh to hold, so there is nothing to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, shape, now)
        }
        tris += this.tierTris[tier][shape]
      }
    }
    // The duplicates are drawn too, and are counted after the loop rather than
    // inside it so this frame's own swaps are in this frame's number.
    this.tris = tris + this.fadeTris
  }

  _reseat(cx, cz) {
    const tile = this.tile
    const tx = Math.floor(cx / tile)
    const tz = Math.floor(cz / tile)
    if (tx === this.camTileX && tz === this.camTileZ) return
    this.camTileX = tx
    this.camTileZ = tz

    for (const [key, t] of this.tiles) {
      const dx = (t.tx + 0.5) * tile - cx
      const dz = (t.tz + 0.5) * tile - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._release(t)
        this.tiles.delete(key)
      }
    }

    for (const t of this.tiles.values()) t.queued = false
    const span = this.tileSpan
    this.queue.length = 0
    for (let iz = -span; iz <= span; iz++) {
      for (let ix = -span; ix <= span; ix++) {
        const gx = tx + ix
        const gz = tz + iz
        const dcx = (gx + 0.5) * tile - cx
        const dcz = (gz + 0.5) * tile - cz
        const d2 = dcx * dcx + dcz * dcz
        if (d2 > this.radiusSq) continue
        const key = gx * 0x10000 + gz
        if (this.tiles.has(key)) continue
        const nx = Math.max(gx * tile, Math.min(cx, (gx + 1) * tile))
        const nz = Math.max(gz * tile, Math.min(cz, (gz + 1) * tile))
        this.queue.push({ key, tx: gx, tz: gz, d2, q: this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2) })
      }
    }
    this.queue.sort((a, b) => b.d2 - a.d2)
  }

  _growTile(job) {
    const { key, tx, tz, q } = job
    const tile = this.tile
    const existing = this.tiles.get(key)
    const uNew = this.uAt[q]

    if (existing) {
      existing.queued = false
      if (existing.q === q) return
      this.regrows++
      if (uNew < existing.u) {
        this._thin(existing, uNew)
        existing.q = q
        existing.u = uNew
        return
      }
    }
    const uOld = existing ? existing.u : 0

    const rand = mulberry32(tileSeed(tx, tz, this.seed, this.index))
    const cfg = this.cfg
    const ids = existing ? existing.ids : new Int32Array(this.perTile)
    const rank = existing ? existing.rank : new Float32Array(this.perTile)
    let n = existing ? existing.n : 0

    // The three numbers the terrain shades itself with. Hoisted because they are
    // constant for the whole tile and `shade` wants them per rock -- see
    // GROUND_CUE.
    const { altLo, altSpan } = this.field.bands
    const snowBand = this.layers.snow.band
    const gc = this._gc

    // --- pass one: draw the tile's whole candidate stream --------------------
    //
    // EVERY candidate draws the same randoms whether or not it survives -- see
    // Trees._growTile. What is new is that the draws are separated from the work,
    // and the reason is RANK ORDER.
    //
    // A tile is grown incrementally and the survivor set is always exactly
    // `{u < uAt[q]}`, so growing in only ever ADDS candidates, each with a higher
    // `u` than everything already standing. That is what makes the scatter stable
    // under walking -- but only for tests that look at one candidate at a time. The
    // moment a candidate is tested against its NEIGHBOURS (`minGap` below) the
    // answer depends on which of them were placed first, and in stream order that
    // is an arbitrary interleaving of ranks: walk away and back, and the pile
    // rearranges itself.
    //
    // So pass two runs in ASCENDING `u`. Every candidate is then darted only
    // against lower-ranked ones -- exactly those already there at every coarser
    // level -- and a tile settles into the same layout whether it was grown in one
    // step or in six. The sort is over the survivors of the rank test alone (196 on
    // the densest bed, single digits on the sparsest) and runs unconditionally, so
    // there is one placement order in this file rather than two.
    const c = this._cand
    const order = this._order
    let m = 0
    for (let k = 0; k < this.perTile; k++) {
      const x = (tx + rand()) * tile
      const z = (tz + rand()) * tile
      // Drawn here and RESOLVED against the environment in pass two, which keeps
      // the stream fixed while still letting the shape depend on where the rock
      // turned out to be.
      const shapeRoll = rand()
      const envRoll = rand()
      const yaw = rand() * Math.PI * 2
      // Same discipline, and a bed with `sizeByEnv` needs the environment as
      // well as this roll before it can turn it into a scale.
      const scaleRoll = rand()
      const tone = rand()
      const warm = rand()
      // Which palette it indexes depends on where the rock lands; the draw
      // itself must not.
      const tintRoll = rand()
      // Whether this one takes the site's own shapes if it turns out to be
      // standing at one, resolved against the relief in pass two.
      const siteRoll = rand()
      // How deep this one is bedded, within the range its bed allows. See
      // SINK_DEEP: meaningless on a bed that has no `sinkVary`.
      const sinkRoll = rand()
      const u = rand()

      // The rank the tile ladder actually keys on -- `u`, floored so no rock is
      // thinned away while it is still a mesh. See `_rankOf`. Computed HERE, before
      // the survivor test and before the sort, because all three have to agree on
      // one order: the stability argument above only holds if a candidate is darted
      // against exactly the set already standing at every coarser level, and with
      // the floor in play that set is ordered by this, not by the raw draw.
      const sizeRoll = this.sizeBias === 1 ? scaleRoll : Math.pow(scaleRoll, this.sizeBias)
      const rankU = this._rankOf(u, sizeRoll)

      if (rankU >= uNew || rankU < uOld) continue

      c.x[m] = x
      c.z[m] = z
      c.shapeRoll[m] = shapeRoll
      c.envRoll[m] = envRoll
      c.yaw[m] = yaw
      c.scaleRoll[m] = scaleRoll
      c.tone[m] = tone
      c.warm[m] = warm
      c.tintRoll[m] = tintRoll
      c.siteRoll[m] = siteRoll
      c.sinkRoll[m] = sinkRoll
      c.rank[m] = rankU
      order[m] = m
      m++
    }
    order.length = m
    order.sort((a, b) => c.rank[a] - c.rank[b])

    // --- pass two: place them, lowest rank first -----------------------------
    for (let oi = 0; oi < m; oi++) {
      const k = order[oi]
      const x = c.x[k]
      const z = c.z[k]
      const shapeRoll = c.shapeRoll[k]
      const envRoll = c.envRoll[k]
      const yaw = c.yaw[k]
      const scaleRoll = c.scaleRoll[k]
      const tone = c.tone[k]
      const warm = c.warm[k]
      const tintRoll = c.tintRoll[k]
      const siteRoll = c.siteRoll[k]
      const sinkRoll = c.sinkRoll[k]
      const rankU = c.rank[k]

      // THE PILE FIELD, TAKEN BEFORE ANY FIELD QUERY. `_clump` is four hashes of
      // position against a `scatterAt` at ~960 ns, so what it rejects here it
      // rejects for free, and what it rejects is exactly the ground between one
      // drift and the next. Position-only, so it consumes no randoms and the
      // deterministic stream is untouched -- see the draw block above.
      //
      // IT IS NOT WHAT MAKES A DENSE BED AFFORDABLE. On a `footOnly` bed the
      // dominant cost is `_relief`: four more field samples at ~4.3 us the set,
      // paid on every candidate that clears both this floor and the slope test,
      // then thrown away for 91% of them. On the scree bed that is 81% of placement
      // against `scatterAt`'s 18%. The cheap fix would be to memoize `_relief` on
      // the PLACEMENT_CELL grid -- distinct cells plateau near 2100 whatever the
      // density, so that bed goes from ~200 ms to ~80 ms. NOT FREE: candidate
      // positions are not quantised (PLACEMENT_CELL is only the `cell` hint handed
      // to scatterAt), so it would reclassify candidates near a foot/brow edge.
      // Well inside the signal's own resolution (RELIEF_STEP 6 m, RELIEF_PROBE
      // 16 m), but a real change to where rocks stand rather than an optimisation
      // you can land without re-reading the gate.
      const clump = cfg.clumpFloor > 0 || this.siteEnvs.size > 0 ? this._clump(x, z) : 0
      if (cfg.clumpFloor > 0 && clump < cfg.clumpFloor) {
        this.rejected.clump++
        continue
      }

      this.samples++
      const { h, tan } = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      if (h < cfg.minElev) {
        this.rejected.elev++
        continue
      }
      if (tan > this.maxSlopeTan) {
        this.rejected.slope++
        continue
      }
      // Wanted twice -- by the environment test and by the ground cue further
      // down -- so it is taken once here rather than inside _envAt.
      const snowLine = this.field.snowLineAt(x, z)
      const env = this._envAt(x, z, h, tan, snowLine)

      // THE RELIEF, and it is asked BEFORE the density test because it moves it.
      // Probed only where this bed has something tagged for this environment;
      // everywhere else `siteEnvs` costs one Set lookup and the four field
      // samples are never taken. See _relief.
      const site = this.siteEnvs.has(env) ? this._relief(x, z, h) : null
      const sitePool = site === null ? null : this.bySite.get(`${env}|${site}`)
      const atSite = sitePool !== null && sitePool.length > 0

      // A `footOnly` bed is not a bed that PREFERS feet, it is one that has no
      // business anywhere else -- see the scree bed. Held after the relief probe
      // because that is the only thing that knows, and after the clump floor
      // above because that one is free and this one is not.
      if (cfg.footOnly && site !== 'foot') {
        this.rejected.site++
        continue
      }

      // How MUCH stone this environment has lying about, as opposed to which
      // kind. See BEDS: without this a bed is equally dense everywhere.
      //
      // A FOOT SITE RUNS DENSER, and unevenly. Scree does not lie in a band of
      // constant density along the base of a cliff, it lies in piles with bare
      // ground between them, and the clump field is the difference -- see
      // _clump. Only 'foot': a brow is a lip you stand on and there is one of
      // it, not a drift.
      const dens = atSite && site === 'foot'
        ? cfg.envDensity[env] * (1 + CLUMP_GAIN * clump)
        : cfg.envDensity[env]
      if (envRoll >= dens) {
        this.rejected.env++
        continue
      }
      // THE WATER TEST RUNS IN BOTH DIRECTIONS, because `river` is not the same
      // question as `underwater`. `_envAt` gives the river environment to anything
      // within SHORE_RISE of the surface, which is the right rule for the SHAPES a
      // bank wants and the wrong one for a bed that only makes sense on a floor --
      // a sunken boulder on dry shingle is just a boulder. So `submergedOnly` is
      // `footOnly` for water: not a bed that prefers a lake, one with no business
      // out of it. The branch is written so that a bed which neither refuses water
      // nor demands it -- most of them -- never pays for the lookup.
      if (!cfg.allowSubmerged || cfg.submergedOnly) {
        if (this.water.isSubmerged(x, z, h) !== Boolean(cfg.submergedOnly)) {
          this.rejected.water++
          continue
        }
      }
      // Most of the rocks at a qualifying site take the site's own shapes, not
      // all of them -- see SITE_SHARE. The rest fall through to the ordinary
      // pool, which holds only the UNTAGGED shapes, so the reverse can never
      // happen and a talus chip stays out of the meadow.
      const useSite = atSite && siteRoll < SITE_SHARE
      const pool = useSite ? sitePool : this.byEnv.get(env)
      // Not an error: a bed whose variants are all tagged `peak` simply places
      // nothing in a wood, which is how the giants stay off the flat.
      if (!pool.length) {
        this.rejected.env++
        continue
      }
      const shape = pool[Math.min(pool.length - 1, (shapeRoll * pool.length) | 0)]
      const s = this.shapes[shape]

      // THE SCALE, RESOLVED. Two ways of saying how big a rock is, not
      // interchangeable; §25 has the crust bed's worked case.
      //
      // `scale` is a MULTIPLIER on whatever the variant was authored at, so a bed
      // using it spans as many absolute sizes as it has shapes -- fine when the
      // shapes are all of a kind and the bank's own proportions should survive.
      //
      // `sizeByEnv` is a range in METRES, per environment, divided back through the
      // shape's own measured WIDTH -- not the authored `size`, which is a parameter
      // to the generator rather than a promise about the result. Use it when the ask
      // is about the world rather than the bank, and especially when ONE bed has to
      // be two sizes in two places.
      //
      // `sizeBias` bends the roll before either branch reads it. Under 1 it weights
      // the range towards its top, the only way to ask for "more big ones" without
      // also throwing the small ones away as widening the range would. Applied to
      // the ROLL, not the result, so both ways of saying how big get it for free.
      const sizeRoll = this.sizeBias === 1 ? scaleRoll : Math.pow(scaleRoll, this.sizeBias)
      let scale
      if (cfg.sizeByEnv) {
        const span = cfg.sizeByEnv[env]
        if (!span) throw new Error(`RockBed ${cfg.name}: sizeByEnv has no entry for ${env}`)
        scale = (span[0] + sizeRoll * (span[1] - span[0])) / s.measured.width
      } else {
        scale = cfg.scale[0] + sizeRoll * (cfg.scale[1] - cfg.scale[0])
      }
      // What this rock is in METRES across, which is the number two other things
      // want: the LOD thresholds in `update` scale with it (see ROCK_LOD_AT),
      // and the dart just below measures against it.
      const width = s.measured.width * scale

      // NO ROCK INSIDE ANOTHER ROCK -- see `minGap` on the scree bed. Darted
      // against the rocks already standing in THIS tile, which in pass two's rank
      // order are exactly the ones already standing at every coarser level of it,
      // so the answer does not change as the tile fills in.
      //
      // WHAT IT DOES NOT COVER is the tile boundary: a neighbouring tile is grown
      // independently and in an order the camera decides, so darting across the
      // seam would make the result depend on which way the player walked in. At a
      // 14 m tile and a metre or two of rock that leaves a thin margin where two
      // rocks may interpenetrate -- the same trade every tiled scatter here makes.
      if (this.minGap > 0) {
        let blocked = false
        for (let j = 0; j < n; j++) {
          const o = ids[j]
          const dx = this.instX[o] - x
          const dz = this.instZ[o] - z
          const need = this.minGap * 0.5 * (width + this.instSpan[o])
          if (dx * dx + dz * dz < need * need) {
            blocked = true
            break
          }
        }
        if (blocked) {
          this.rejected.gap++
          continue
        }
      }

      if (this.freeCount === 0) {
        throw new Error(
          `RockBed ${cfg.name}: instance pool exhausted at ${this.maxInstances} (${this.tiles.size} tiles resident)`
        )
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = rankU
      n++
      if (useSite) this.sited[site]++

      // Bedded by a fraction of its OWN height, which is why `measured` is on the
      // shape at all: a 7 m lip and an 11 cm pebble both want to be a tenth of
      // themselves into the ground, not a tenth of a metre. The slope term is a
      // FLOOR, not the answer -- steeper ground needs a rock bedded deeper or its
      // downhill side hangs in the air -- and `sinkVary` beds reroll upward from it
      // towards SINK_DEEP, so a flat-ground rock spans nearly the whole 5 - 50%
      // while one at the bed's slope limit cannot come out shallower than the floor.
      const floor = SINK_MIN + SINK_SLOPE * Math.min(1, tan / this.maxSlopeTan)
      const frac = cfg.sinkVary ? floor + sinkRoll * (SINK_DEEP - floor) : floor
      let sink = s.measured.height * scale * frac
      // And an open shell deeper still, because the fraction above is of HEIGHT
      // and these are the flattest things in the bank -- see OPEN_BURY.
      if (s.openBottom) sink += s.measured.width * scale * OPEN_BURY
      this.shapeAt[id] = shape
      this.instX[id] = x
      this.instZ[id] = z
      this.instSink[id] = sink
      this.instScale[id] = scale
      this.instSpan[id] = width
      this.instY[id] = this._groundFor(x, z) - sink

      this._yawQ.setFromAxisAngle(this._up, yaw)
      // Yaw first in the rock's own frame, then the lean on top of it, so a
      // tilted rock spins about the ground's normal rather than about world Y.
      if (cfg.tilt > 0) this._q.copy(this._groundTilt(x, z, cfg.tilt)).multiply(this._yawQ)
      else this._q.copy(this._yawQ)
      this._p.set(x, this.instY[id], z)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // A TINT PER INSTANCE, ROLLED FROM THE ENVIRONMENT'S PALETTE -- not the
      // variant's own colour, which is only its portrait in /gen-rock. One colour
      // per variant meant a scree slope was one grey and a wood one green, and the
      // eye finds that repeat faster than a repeated silhouette. ENV_TINTS carries
      // a list per environment and weights by repetition, so common stone stays
      // common.
      //
      // THE VALUES GO ABOVE 1.0 ON PURPOSE. stone.png is a real photograph of
      // granite -- warm, and dark at a mean luma of 88/255 -- so every palette
      // entry is a gain that brightens and white-balances it rather than a multiply
      // that darkens it further (see TINT_GAIN). BatchedMesh's colour texture is
      // FLOAT, so > 1 is storable and does what it says.
      const pal = ENV_TINTS[env]
      const gain = TINT_GAIN[pal[Math.min(pal.length - 1, (tintRoll * pal.length) | 0)]]

      // A PER-BED DAMPER ON THAT GAIN, and the crust bed is why it exists -- see
      // `tintDim` there. Everything above is written for a rock STANDING ON ground,
      // lit like an object: its faces catch the sun at their own angles and a gain
      // over 1 is what stops it reading as a dark blob. A cap is not standing on
      // the cliff, it IS the cliff a few centimetres proud of it, and the gain that
      // seats a boulder makes a cap a bright patch on a face otherwise in its own
      // shade. This is the one thing here that can break the brightness promise the
      // jitter comment below makes, which is why it is per bed and defaults off.
      const dim = cfg.tintDim ?? 1

      // AND THEN PULLED PART OF THE WAY TOWARD THE GROUND IT IS STANDING ON.
      // The terrain's own vertex colour here, from the chunk mesher's own
      // `shade`, so the cue cannot drift away from what the ground is actually
      // painted -- render/ferns.js takes a fern's the same way and for the same
      // reason. `flattenAt` unconditionally rather than ferns' road-gated call:
      // this file has no path index to gate on, and one lookup sits next to the
      // four _groundTilt is about to take anyway.
      shade(h, 1 / Math.hypot(tan, 1), snowLine, snowBand, this.layers.flattenAt(x, z),
        altLo, altSpan, gc, 0)
      // Renormalised to unit luminance, so what survives is HUE. See GROUND_CUE:
      // a rock's tint is already an absolute destination and the terrain palette
      // is near black, so taking its magnitude would delete the rock rather than
      // seat it.
      const cue = GROUND_CUE[env]
      const gl = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2]
      const k1 = gl > 1e-5 ? cue / gl : 0
      const k0 = gl > 1e-5 ? 1 - cue : 1

      // Jitter on top, so two rocks of the same tint standing together still
      // differ. Centred slightly under 1 and running slightly over: the floor of
      // 0.86 against the palette's smallest gain of 1.39 leaves every instance
      // brighter than the bare tile, which is this block's promise. The promise is
      // about BRIGHTNESS and not each channel separately, and it has to be -- the
      // cue above is exactly luminance-preserving, so it can only rotate hue, and a
      // rotation towards forest green must pull some channel down to pay for it. In
      // a wood a handful of instances land just under 1 in blue (lowest measured
      // 0.965) while their luminance is still 1.7x the tile. Gate on luminance: a
      // per-channel floor of 1 and a hue cue cannot both hold.
      const v = (0.86 + tone * 0.3) * dim
      this._c.setRGB(
        gain[0] * v * (0.96 + warm * 0.08) * (k0 + gc[0] * k1),
        gain[1] * v * (k0 + gc[1] * k1),
        gain[2] * v * (1.04 - warm * 0.08) * (k0 + gc[2] * k1)
      )
      this.batch.setColorAt(id, this._c)

      // WHERE THIS ROCK DISSOLVES, AND WHY IT CANNOT BE BEFORE ITS LADDER ENDS.
      //
      // `rankU` is the effective rank from `_rankOf`. The tile ladder keeps exactly
      // `{rankU < uAt[q]}` and `uAt[q] = fullRadius / d_q`, so handing the same
      // number to the material makes the CPU's decision and the shader's agree -- a
      // rock the tile is about to drop has already faded out.
      //
      // Because `rankU = min(u, fullRadius / fadeFloor)`, the dissolve distance
      // `fullRadius / rankU` is exactly `max(fullRadius / u, fadeFloor)`. The floor
      // is therefore not an approximation of the guarantee, it IS the guarantee: no
      // rock starts dissolving before it has become a card, so thinning takes the
      // tail of rocks that are already two triangles apiece rather than reaching up
      // and taking meshes -- which is what read as rocks culling without degrading.
      //
      // The `radius` clamp is the bed's outer reach, past which its tiles are not
      // resident at all, so the dissolve finishes before the tile evicts. It cannot
      // undercut the guarantee: the constructor refuses a `radius` shorter than the
      // bed's own card distance. Born at the coarsest tier; `update` promotes the
      // near ones next frame.
      this.tierAt[id] = ROCK_BAND_COUNT - 1
      this.batch.setGeometryIdAt(id, this.tierIds[ROCK_BAND_COUNT - 1][shape])

      // Hidden until the rim's sweep has looked at it, which the tile below is
      // marked due for -- see rim.js.
      this.rim.place(id, Math.min(this.fullRadius / rankU, this.radius))
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
      this.rim.markDue(existing)
    } else {
      this.tiles.set(key, {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        near: false,
        queued: false,
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
      })
    }
  }

  /**
   * A rotation that lays the rock's up axis `amount` of the way toward the
   * ground normal.
   *
   * Four extra field samples, paid once per PLACED rock and never again -- hence
   * off for the underfoot bed, where it would be four samples for a four-centimetre
   * pebble nobody can see the lean of. Off the FIELD rather than the drawn mesh on
   * purpose: the mesh's normal changes every time the chunk under the rock
   * re-splits, and a boulder that rocked back and forth as the terrain LOD moved
   * would be far worse than one leaning a degree off the triangle it stands on.
   */
  _groundTilt(x, z, amount) {
    const e = 1.5
    const hx = this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)
    const hz = this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)
    this._n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize()
    this._n.lerp(this._up, 1 - amount).normalize()
    return this._tiltQ.setFromUnitVectors(this._up, this._n)
  }

  /** See Trees._groundFor: the surface that is DRAWN, with the field as a fallback. */
  _groundFor(x, z) {
    if (this.ground) {
      const g = this.ground.groundAt(x, z)
      if (g !== null) return g
    }
    return this.field.heightAt(x, z)
  }

  _reground(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      const y = this._groundFor(this.instX[id], this.instZ[id]) - this.instSink[id]
      if (y === this.instY[id]) continue
      this.instY[id] = y
      this.batch.getMatrixAt(id, this._m)
      this._m.elements[13] = y
      this.batch.setMatrixAt(id, this._m)
    }
  }

  /**
   * Start a cross-dissolve: instance `i` has just taken a new tier, so a
   * duplicate takes the tier it left and the two dither past each other. This is
   * render/grass.js's `_crossFade`, shape for shape -- see the dissolve header in
   * material.js for why the two halves take complementary thresholds.
   *
   * Called with the ORIGINAL already switched, so everything here is about the
   * ghost. Both halves are stamped with the same start; their thresholds only
   * sum to full coverage if their clocks agree.
   */
  _crossFade(i, oldTier, shape, now) {
    // A second band crossing while the first is still running. Finish the first:
    // its duplicate would otherwise leak, and its start time is about to be
    // written over by this one's.
    const running = this.fadeAt[i]
    if (running >= 0) this._endFade(running)

    // A rim transition owns the slot while it runs, and it outranks this one:
    // which tier a rock was wearing on its way out of the world is not a
    // question anybody is asking. See RimFade's constructor for the other half.
    if (this.rim.isBusy(i)) return

    // Both ceilings degrade to a pop, which is what a swap did before this
    // existed. See FADE_POOL_RESERVE for why growth outranks polish.
    if (this.fades.length >= FADE_MAX_INFLIGHT) return
    if (this.freeCount <= FADE_POOL_RESERVE) return

    const dup = this.free[--this.freeCount]
    this.batch.getMatrixAt(i, this._m)
    this.batch.setMatrixAt(dup, this._m)
    // The tint too, or the ghost is a different stone from the one it is
    // standing inside and the pair reads as two rocks rather than one. setColorAt
    // writes .rgb only, so the timer below is safe to stamp after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier][shape])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier][shape]
    this.fadeTris += tris
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris })
  }

  /**
   * Finish the fade at index `k`: hand the ghost back and put the original's
   * slot back to the never-fade default, since the timer was written into it.
   */
  _endFade(k) {
    const f = this.fades[k]
    this.batch.setVisibleAt(f.dup, false)
    this.free[this.freeCount++] = f.dup
    this.fadeTris -= f.tris
    setPropSolidAt(this.batch, f.orig)
    this.fadeAt[f.orig] = -1
    // Swap-remove, so the list stays dense and the sweep stays a linear scan.
    const last = this.fades.pop()
    if (k < this.fades.length) {
      this.fades[k] = last
      this.fadeAt[last.orig] = k
    }
  }

  /** Retire every cross-dissolve whose window is up. Once per frame. */
  _sweepFades(now) {
    let k = 0
    while (k < this.fades.length) {
      const age = now - this.fades[k].start
      // Outside the window in EITHER direction. Negative means the prop clock
      // wrapped underneath this fade, which cannot be resumed -- and must not be
      // allowed to restart from zero, or a wrap would freeze every fade in
      // flight at its opening frame until the clock came back round.
      if (age >= PROP_FADE_SECONDS || age < 0) this._endFade(k)
      else k++
    }
  }

  _thin(tile, uNew) {
    let w = 0
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      if (tile.rank[k] < uNew) {
        tile.ids[w] = id
        tile.rank[w] = tile.rank[k]
        w++
        continue
      }
      // A rock thinned out mid-fade would strand its ghost visible forever.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n - w
    tile.n = w
    this.rim.markDue(tile)
  }

  _demote(tile, coarse) {
    for (let k = 0; k < tile.n; k++) {
      const i = tile.ids[k]
      if (this.tierAt[i] === coarse) continue
      this.tierAt[i] = coarse
      this.batch.setGeometryIdAt(i, this.tierIds[coarse][this.shapeAt[i]])
    }
  }

  _release(tile) {
    for (let k = 0; k < tile.n; k++) {
      const id = tile.ids[k]
      // Same as _thin: an evicted rock has to take its ghost with it.
      if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
      this.batch.setVisibleAt(id, false)
      this.rim.drop(id)
      this.tierAt[id] = -1
      this.free[this.freeCount++] = id
    }
    this.placed -= tile.n
    this.rim.releaseTile(tile)
  }

  /**
   * One bed's share of Rocks.anchorsInto: appends at anchor `w`, stops at `cap`
   * anchors and returns the new cursor, so the beds can fill one buffer in bed
   * order without any of them knowing how many the others wrote. `cap` comes in
   * rather than being derived here because it is a property of `out` and not of the
   * bed. The public half carries the argument for the box, for the radius and for
   * which beds are asked at all.
   *
   * OVER THE RESIDENT TILES AND THEIR OWN `ids`, exactly the way update() walks
   * them, and NEVER over the instance pool: a freed id keeps the coordinates of
   * whatever rock last held it -- nothing clears instX/instZ on release -- so a
   * sweep of the pool would hand a caller anchors for rocks evicted a kilometre
   * back, at positions now inside a hill.
   *
   * THE TILE REJECT IS THE WHOLE COST STORY. A bed's resident set is its entire
   * draw radius, 1250 m of tiles for the giants, while a caller's box is a few tens
   * of metres; four compares throw out all but a handful. Both extents are
   * half-open in the same sense as the box, which is the literal truth about a tile
   * since _growTile draws a rock's x from [tx * tile, (tx + 1) * tile) and never
   * the far edge.
   */
  _anchorsInto(x0, z0, x1, z1, out, w, cap) {
    const tile = this.tile
    for (const t of this.tiles.values()) {
      if (w >= cap) return w
      const tx0 = t.tx * tile
      const tz0 = t.tz * tile
      if (tx0 >= x1 || tx0 + tile <= x0 || tz0 >= z1 || tz0 + tile <= z0) continue
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        const x = this.instX[id]
        const z = this.instZ[id]
        // HALF-OPEN, `>= x0 && < x1`, and the caller's tiling depends on it --
        // see Rocks.anchorsInto.
        if (x < x0 || x >= x1 || z < z0 || z >= z1) continue
        if (w >= cap) return w
        const o = w * 4
        out[o] = x
        out[o + 1] = this.instY[id]
        out[o + 2] = z
        out[o + 3] = this.footRadius[this.shapeAt[id]] * this.instScale[id]
        w++
      }
    }
    return w
  }

  /**
   * The id to QUOTE for one instance: `variant-index`, e.g. `shingle-1`.
   *
   * The raw `shapeAt[id]` is deliberately NOT this. It indexes this bed's own
   * roster -- the subset of the bank whose `envs` name this bed's environment --
   * so shape 3 is a different rock in each bed and is an index into
   * nothing the previewer displays. What survives the trip is the bank identity,
   * `name` plus `index`, which /gen-rock's shape box takes directly. See NAMING
   * ONE SHAPE in rock-bank.js for why it is not the raw seed any more.
   */
  shapeIdAt(id) {
    const shape = this.shapes[this.shapeAt[id]]
    if (!shape) throw new Error(`RockBed ${this.cfg.name}: no shape ${this.shapeAt[id]} for instance ${id}`)
    return rockShapeId(shape.name, shape.index)
  }

  /**
   * The cursor's pick volume for one instance, in world metres: this rock's own
   * footprint and its own height, both at this instance's own scale.
   *
   * A species constant cannot do this job. `measured` runs from a `capslab` seven
   * times wider than tall to a `spire` three times taller than wide, and
   * `instScale` spreads that another fifty-fold across the beds, so one
   * radius/rise pair is simultaneously metres of empty air over the slab and a
   * volume stopping well below the top of the spire -- and a cursor that stops
   * below the top of a rock reads as pointing straight through it. The numbers are
   * already here; there is no reason to guess them.
   *
   * `max(width, depth)` and not the mean: the cylinder has one radius and it has
   * to hold the rock at every bearing, so it takes the widest. Half of it,
   * because `measured` is a full span and this is a radius.
   */
  pickSizeAt(id, out) {
    const shape = this.shapes[this.shapeAt[id]]
    if (!shape) throw new Error(`RockBed ${this.cfg.name}: no shape ${this.shapeAt[id]} for instance ${id}`)
    const scale = this.instScale[id]
    const m = shape.measured
    out.radius = Math.max(m.width, m.depth) * 0.5 * scale
    out.rise = m.height * scale
    return out
  }

  get stats() {
    return {
      name: this.cfg.name,
      placed: this.placed,
      samples: this.samples,
      tris: this.tris,
      tiles: this.tiles.size,
      queued: this.queue.length,
      fading: this.fades.length,
      rimHidden: this.rim.hiddenCount,
      rimFading: this.rim.flightN,
      pool: this.maxInstances,
      used: this.maxInstances - this.freeCount,
      density: this.density,
      fullRadius: this.fullRadius,
      radius: this.radius,
      shapes: this.shapes.length,
      sited: this.sited,
      rejected: this.rejected,
      placeMs: this.placeMs,
      lastBuildMs: this.lastBuildMs,
      regrows: this.regrows,
      regrounds: this.regrounds,
    }
  }

  dispose() {
    this.batch.dispose()
  }
}

/**
 * All the world's stone: one bank, one material, one bed per BEDS entry.
 *
 * The public shape matches Trees/Ferns/Grass -- construct, `place` once at
 * spawn, `update` every frame, `syncBands` after the layers are known -- so
 * v2/main.js wires it exactly like the other three.
 */
export class Rocks {
  /**
   * @param scene         THREE.Scene. Gets one BatchedMesh per bed.
   * @param field         V2Height. Needs scatterAt, heightAt, snowLineAt, bands.
   * @param water         WaterSurfaces. Needs levelAt and isSubmerged.
   * @param layers        Layers. Needs `snow.band` and flattenAt, for the ground
   *                      cue -- see GROUND_CUE. Same argument Ferns takes and in
   *                      the same position.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or null for headless probes. See Trees.
   * @param opts.seeds    Shapes per variant in the bank. 3 x 25 = 75 rocks.
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null, seeds = 3 } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Rocks: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Rocks: needs WaterSurfaces with levelAt')
    if (!layers || typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Rocks: needs Layers with flattenAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Rocks: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    const bank = buildRockBank({ seed, seeds })
    this.bank = bank

    // ONE material for every bed. They all billboard the same single card layer,
    // so unlike the trees and the ferns -- where the layer list differs per species
    // and its length is compiled into the shader -- there is one program here
    // whatever the bed: six draw calls, one program, one atlas.
    //
    // A bed that did NOT billboard would still be free in this material: the mask
    // is `layer match AND normal.y > CARD_UP_MARK`, so a mesh tier fails it on the
    // normal whatever material draws it, and a bed opts out by never handing an
    // instance the card geometry rather than by taking a material of its own.
    //
    // AND IT SPINS SPHERICALLY, the one place rocks part company with every other
    // card in the world. A rock has no up: the beds that reach card range are the
    // scree and the giants, both live on slopes, and a slope is looked at from
    // above. See billboardVertex for the argument and for why a tree must NOT have
    // this. One material for every bed is what makes it a single word here rather
    // than a decision per bed.
    this.material = createPropMaterial(textureArray, {
      billboardLayers: rockImpostorLayers(),
      sphericalBillboard: true,
    })

    this.beds = BEDS.map(
      (cfg, i) => new RockBed(scene, field, water, layers, this.material, bank, cfg, i, { seed, ground })
    )

    // BatchedMesh has copied every vertex into its own arena; the bank's
    // geometries are now a spare copy with no reader.
    for (const g of bank.geometries) g.dispose()

    this.buildMs = performance.now() - t0
    this.placeMs = 0
  }

  /** Grow every bed at once, ignoring the frame budget. Boot only. */
  place(cx, cz) {
    const t0 = performance.now()
    let placed = 0
    for (const bed of this.beds) placed += bed.place(cx, cz)
    this.placeMs = performance.now() - t0
    return placed
  }

  /**
   * The whole build budget is split evenly across the beds rather than drained
   * bed by bed. Giving it to the first would starve the giants behind a wall of
   * pebbles on a fast traverse, and a missing landmark at 800 m is far more
   * visible than a missing pebble at 30.
   */
  update(camX, camY, camZ) {
    const slice = BUILD_BUDGET_MS / this.beds.length
    for (const bed of this.beds) bed.update(camX, camY, camZ, slice)
  }

  /**
   * Point the props' snow and moss lines at the terrain's own snow band.
   *
   * Snow takes the band verbatim, so a rock and the ground it sits on go white
   * together -- the same call Trees.syncSnowLine makes, and calling both is
   * harmless because the uniforms are global and the value is identical.
   *
   * Moss gets a line of its own, MOSS_DROP metres below the snow's and fading over
   * a band twice as wide: moss is about damp rather than cold, so it gives out well
   * before the snow starts, and gradually -- a hard moss contour halfway up a
   * mountain would read as a paint line.
   *
   * AND THE TWO CEILINGS ARE CAPPED WELL SHORT OF 1, per instance, which is the
   * other half of making stone read as stone. Both are stone-only knobs (see
   * setSnowVary), hence set here rather than next to the world's setSnow/setMoss.
   * SNOW 0.3-0.5: stone leans on the surface normal twice as hard as foliage does,
   * so a full load is not a snowy rock but a white one, and the spread between
   * neighbours stops a snowfield of boulders reading as one poured material. MOSS
   * 0-0.5, where the BOTTOM is the load-bearing end -- a wood wants bare boulders
   * as much as green ones, and the roll is shaped so a real share land exactly on
   * 0. The top at half means the greenest rock in the wood still shows the stone it
   * grew on.
   */
  syncBands(layers) {
    setSnowLine(layers.snow.base, layers.snow.band)
    setMossLine(layers.snow.base - MOSS_DROP, layers.snow.band * 2)
    setSnowVary(SNOW_CAP[0], SNOW_CAP[1])
    setMossVary(MOSS_CAP[0], MOSS_CAP[1])
  }

  /**
   * Write every resident rock whose centre falls inside the half-open box
   * [x0, x1) x [z0, z1) into `out`, stride 4, and return how many were written.
   *
   *   out[i * 4 + 0]  x         world x of the rock
   *   out[i * 4 + 1]  y         the instance's own origin, instY
   *   out[i * 4 + 2]  z         world z of the rock
   *   out[i * 4 + 3]  radius    world-space radius of its footprint at the
   *                             ground, in metres
   *
   * WHAT THIS IS FOR: another prop scatter -- mushrooms (§24) -- wants its clumps
   * at the foot of REAL stone rather than at points that merely score like it, and
   * it cannot re-derive that from the field, since which candidates survive depends
   * on the graded thinning and that depends on where the camera stands. A caller
   * tiles the ground into boxes and calls once per box.
   *
   * THE BOX IS HALF-OPEN ON BOTH AXES and a tiling caller depends on it exactly: a
   * rock on a shared boundary must fall into exactly one of the two boxes. Closed
   * at both ends would give it two owners and two clumps of mushrooms; open at both
   * would drop it and leave a gap that moves as the world does.
   *
   * ONLY THE BEDS FLAGGED `anchor` ANSWER -- the boulders and the giants, not the
   * pebbles underfoot; the argument is on the flags in BEDS. They fill `out` in bed
   * order on one cursor, so the buffer is sorted by nothing else.
   *
   * SATURATION IS THE CALLER'S TO NOTICE. Nothing is ever written past `out`: a box
   * with more anchors than room fills it and returns out.length / 4 exactly, and
   * because the beds are walked in order what goes missing is the giants. A caller
   * handed back its own capacity should treat the answer as truncated.
   *
   * NO PER-INSTANCE ALLOCATION, since this runs per tile while the player walks --
   * one iterator per collection loop and none inside them.
   *
   * THE y IS THE ROCK'S OWN ORIGIN AND NOT THE SURFACE: instY is its bed plane,
   * `sink` metres BELOW the drawn ground. Right for comparing two rocks, wrong for
   * standing a mushroom on -- take the ground height at your own x, z.
   *
   * THE RADIUS IS A SOLID CIRCLE AT THE GROUND LINE, so a caller may treat the disc
   * as occupied and add its own clearance. NOT the rock's widest half-extent, which
   * on a bedded rock is its equator and well above the ground. See sectionRadius
   * for how it is measured and RockBed's `footRadius` for the three approximations
   * in it -- burial, tilt, drawn tier -- and how far each can be out.
   *
   * @param out  Float32Array, stride 4. Sized by the caller; see saturation.
   */
  anchorsInto(x0, z0, x1, z1, out) {
    // Floored, so an `out` whose length is not a multiple of the stride gets
    // the whole anchors it has room for rather than a partial one. Once for
    // the call and not once per bed: it is the same buffer every time.
    const cap = (out.length / 4) | 0
    let w = 0
    for (const bed of this.beds) {
      if (!bed.cfg.anchor) continue
      w = bed._anchorsInto(x0, z0, x1, z1, out, w, cap)
    }
    return w
  }

  /**
   * Every rock near a point and what it is currently doing, for the console.
   *
   * A BLINK IS NOT REPRODUCIBLE HEADLESSLY, and every mechanism that could make one
   * has been eliminated on paper or by measurement (§25). This is the readout from
   * the browser standing where it happens:
   * `window.v2rocks.describeNear(camX, camY, camZ)`, `console.table` the result.
   *
   * `dissolving` is the flag to watch, and it is a QUARTER-SECOND state rather than
   * a band: the rim stamps a clock when the camera crosses `dissolveFrom` and the
   * row is at partial coverage only until that stamp runs out, after which it is
   * `hidden` (resident, invisible, drawing nothing) or whole. Partial coverage is
   * the one state here that can look like a blink on a small enough sprite, so a
   * row STILL `dissolving` on a second readout is a stuck transition, not a slow
   * one. A row whose `d` is past `cardsAt` while `tier` is still a mesh is the
   * ladder itself being wrong.
   */
  describeNear(camX, camY, camZ, radius = 40) {
    const rows = []
    const last = ROCK_LOD_AT[ROCK_LOD_AT.length - 1]
    for (const bed of this.beds) {
      // The gone-distance comes off the rim's own array and NOT off the colour
      // texture the shader reads, because that slot holds a CLOCK now and never
      // a distance: a readout that printed the raw texel would report a dissolve
      // starting at minus three kilometres for every rock mid-transition.
      for (const t of bed.tiles.values()) {
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const dx = bed.instX[id] - camX
          const dy = bed.instY[id] - camY
          const dz = bed.instZ[id] - camZ
          const d = Math.hypot(dx, dy, dz)
          if (d > radius) continue
          const shape = bed.shapeAt[id]
          const size = bed.shapeLod[shape] * bed.instScale[id]
          const tier = bed.tierAt[id]
          const gone = bed.rim.gone[id]
          rows.push({
            bed: bed.cfg.name,
            shape: bed.shapes[shape].name,
            d: +d.toFixed(1),
            size: +size.toFixed(2),
            tier: tier === ROCK_BAND_COUNT - 1 ? 'card' : `mesh${tier}`,
            tris: bed.tierTris[tier][shape],
            cardsAt: +(size * last).toFixed(1),
            dissolveFrom: +(gone * RIM_AT).toFixed(1),
            goneAt: +gone.toFixed(1),
            dissolving: bed.rim.isBusy(id),
            hidden: bed.rim.isHidden(id),
            // Mid-swap, so this row is currently drawn as TWO stippled halves
            // and `tris` is the arriving one only -- see RockBed._crossFade.
            fading: bed.fadeAt[id] >= 0,
            tileNear: t.near,
          })
        }
      }
    }
    rows.sort((a, b) => a.d - b.d)
    return rows
  }

  /**
   * WHAT THE BATCHES ACTUALLY SUBMIT, FRAME BY FRAME, and what the ground under
   * one rock is doing while they do it. `window.v2rocks.watch()` from the console,
   * then click back into the game and turn until they blink: it waits five seconds
   * before sampling, because the console takes pointer lock and a watch starting
   * the instant it is called can only record a player standing still.
   *
   * Two branches worth telling apart, and §25 argues both:
   *
   *   THE DRAW LIST COLLAPSES. `n` for a bed halves or goes to zero on alternate
   *   frames, so the cause is the per-instance frustum cull in
   *   BatchedMesh.onBeforeRender -- the only thing in the rock pipeline that reads
   *   the camera's ORIENTATION. RockBed.update takes x, y, z and no gaze, which is
   *   what makes a steady `n` informative.
   *
   *   THE DRAW LIST IS STEADY AND THE ROCK MOVES. `y` and `ground` say which. Rocks
   *   are BEDDED, so a drawn surface stepping up by a fraction of a metre buries
   *   one and a surface stepping back down returns it -- the one way a half-buried
   *   prop can blink while a tree beside it does not, and the terrain's own
   *   selection is gaze-dependent (quadtree-v2.js inCone) where this file is not.
   *
   * `passes` is how many times each bed was culled that frame: three when both
   * probes fire, one when neither does. The MAIN render is always last -- main.js
   * runs both probes first -- so `n` is the last pass's count, the one the screen
   * got.
   */
  watch(seconds = 6, delay = 5) {
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error('Rocks.watch is a browser instrument: there is no frame loop here to sample')
    }
    if (this._watching) throw new Error('Rocks.watch is already running')
    this._watching = true

    const beds = this.beds
    const saved = beds.map((b) => b.batch.onBeforeRender)
    const passes = []
    let lastCam = null
    let lastRenderer = null
    const install = () => {
      beds.forEach((bed, i) => {
        bed.batch.onBeforeRender = function watched(renderer, scene, camera, geometry, material) {
          saved[i].call(this, renderer, scene, camera, geometry, material)
          passes.push({ bed: i, n: this._multiDrawCount })
          lastCam = camera
          lastRenderer = renderer
        }
      })
    }

    // The nearest rock when the watch starts, followed by ID rather than by
    // position, so that a tier swap, a thinning or a re-grounding under it all
    // show up on the same row instead of silently changing which rock is being
    // reported.
    let tracked = null
    const rows = []
    let t0 = 0
    const camPos = new THREE.Vector3()
    const ndc = new THREE.Vector3()
    const block = new Uint8Array(3 * 3 * 4)

    // A 3x3 average of the real framebuffer, as one luminance digit 0-9. Reading
    // the screen is the only measurement that does not depend on believing the
    // draw list: if the pixels alternate while the counts hold still, the rocks
    // are being submitted every frame and something downstream is eating them.
    // readPixels stalls the pipeline, which is why this is an instrument and not
    // something that ships.
    const lumAt = (px, py) => {
      const gl = lastRenderer.getContext()
      const w = gl.drawingBufferWidth
      const h = gl.drawingBufferHeight
      if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) return -1
      gl.readPixels(px - 1, py - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, block)
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < 9; i++) {
        r += block[i * 4]
        g += block[i * 4 + 1]
        b += block[i * 4 + 2]
      }
      return (0.299 * r + 0.587 * g + 0.114 * b) / 9
    }

    const sample = () => {
      const row = { ms: +(performance.now() - t0).toFixed(0) }
      for (let i = 0; i < beds.length; i++) {
        let n = -1
        let count = 0
        for (const p of passes) {
          if (p.bed !== i) continue
          n = p.n
          count++
        }
        row[beds[i].cfg.name] = n
        if (i === 0) row.passes = count
      }
      passes.length = 0

      if (lastCam) {
        // The camera's OWN position goes on every row: the previous run reported a
        // nearest rock 457 m away, and without this there is no way to tell a bug
        // in the search from a player who was simply standing somewhere else.
        const p = lastCam.getWorldPosition(camPos)
        row.cx = +p.x.toFixed(1)
        row.cz = +p.z.toFixed(1)
        row.yaw = +((Math.atan2(-lastCam.matrixWorld.elements[8], -lastCam.matrixWorld.elements[10]) * 180) / Math.PI).toFixed(0)
        if (!tracked) {
          let best = Infinity
          let near = 0
          for (const bed of beds) {
            for (const t of bed.tiles.values()) {
              for (let k = 0; k < t.n; k++) {
                const id = t.ids[k]
                const d = Math.hypot(bed.instX[id] - p.x, bed.instY[id] - p.y, bed.instZ[id] - p.z)
                if (d < 12) near++
                if (d < best) {
                  best = d
                  tracked = { bed, id }
                }
              }
            }
          }
          if (!tracked) throw new Error('Rocks.watch: no resident rock instance anywhere to track')
          const { bed, id } = tracked
          console.log(`[rocks.watch] camera at (${row.cx}, ${row.cz}); ${near} rock instances within 12 m; ` +
            `tracking ${bed.cfg.name}#${id} at (${bed.instX[id].toFixed(1)}, ${bed.instZ[id].toFixed(1)}), ${best.toFixed(1)} m away`)
        }
        if (tracked) {
          const { bed, id } = tracked
          row.d = +Math.hypot(bed.instX[id] - p.x, bed.instY[id] - p.y, bed.instZ[id] - p.z).toFixed(2)
          row.y = +bed.instY[id].toFixed(3)
          row.tier = bed.tierAt[id]
          row.vis = bed.batch.getVisibleAt(id)
          row.ground = bed.ground ? bed.ground.groundAt(bed.instX[id], bed.instZ[id]) : null
          if (row.ground !== null) row.ground = +row.ground.toFixed(3)

          if (lastRenderer) {
            const gl = lastRenderer.getContext()
            // The crosshair, because the report is "turn to look straight at them
            // and they blink" -- whatever is blinking is what she is aiming at.
            row.mid = +lumAt(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1).toFixed(1)
            ndc.set(bed.instX[id], bed.instY[id], bed.instZ[id]).project(lastCam)
            row.rock = Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 && ndc.z < 1
              ? +lumAt(Math.round((ndc.x * 0.5 + 0.5) * gl.drawingBufferWidth), Math.round((ndc.y * 0.5 + 0.5) * gl.drawingBufferHeight)).toFixed(1)
              : -1
          }
        }
      }
      rows.push(row)

      if (performance.now() - t0 < seconds * 1000) {
        requestAnimationFrame(sample)
        return
      }

      beds.forEach((bed, i) => { bed.batch.onBeforeRender = saved[i] })
      this._watching = false

      // The verdict, so that reading it does not depend on reading the table.
      // A "steps" count is how often a number changed between adjacent frames,
      // which is what separates a blink from a slow drift.
      const steps = (key, tol) => rows.filter((r, i) => i > 0 && Math.abs(r[key] - rows[i - 1][key]) > tol).length
      const span = (key) => {
        const v = rows.map((r) => r[key]).filter((x) => typeof x === 'number')
        return `${Math.min(...v)}..${Math.max(...v)}`
      }
      if (!tracked) throw new Error('Rocks.watch: no frame ever reached a rock batch, so there is nothing to report')
      const names = beds.map((b) => b.cfg.name)
      const out = [`[rocks.watch] ${rows.length} frames over ${seconds}s, camera ${span('cx')} x ${span('cz')}, yaw ${span('yaw')} deg`]
      if (steps('yaw', 1) === 0) {
        out.push('  THE CAMERA NEVER TURNED. Nothing here can say anything about the blink -- re-run and turn during the sample.')
      }
      for (const bed of beds) out.push(`  ${bed.cfg.name} drawn ${span(bed.cfg.name)}, changed on ${steps(bed.cfg.name, 2)}/${rows.length} frames`)
      out.push(`  tracked ${tracked.bed.cfg.name}#${tracked.id} at ${span('d')} m: y ${span('y')} (moved on ${steps('y', 1e-3)}), ` +
        `ground ${span('ground')} (moved on ${steps('ground', 1e-3)}), tier ${span('tier')}, visible on ${rows.filter((r) => r.vis).length}/${rows.length}`)

      // Only the frames where something MOVED, as text rather than 180 JSON
      // objects: a furious blink prints every frame and a steady scene prints
      // almost none, so the shape of the paste is itself the answer.
      const keys = ['yaw', 'passes', ...names, 'd', 'y', 'ground', 'tier', 'vis']
      const changed = rows.filter((r, i) => i === 0 || keys.some((k) => r[k] !== rows[i - 1][k]))
      out.push(`  ${changed.length} of ${rows.length} frames differ from the one before them`)
      out.push(`  ms  yaw pass ${names.map((n) => n.slice(0, 5).padStart(6)).join('')}      d       y  ground tier vis`)
      for (const r of changed.slice(0, 80)) {
        out.push(`  ${String(r.ms).padStart(4)} ${String(r.yaw).padStart(4)} ${String(r.passes).padStart(4)} ` +
          `${names.map((n) => String(r[n]).padStart(6)).join('')} ${String(r.d).padStart(7)} ${String(r.y).padStart(8)} ` +
          `${String(r.ground).padStart(7)} ${String(r.tier).padStart(4)} ${r.vis ? '  y' : '  n'}`)
      }
      if (changed.length > 80) out.push(`  ...${changed.length - 80} more changed frames not printed`)

      // The screen itself, one digit of brightness per frame. A blink is an
      // A-B-A-B stripe and nothing else in this world produces one: turning
      // sweeps the digits smoothly, and standing still holds them flat.
      const strip = (key) => {
        const s = rows.map((r) => {
          const l = r[key]
          if (typeof l !== 'number') return '?'
          if (l < 0) return '.'
          return String(Math.min(9, Math.max(0, Math.round(l / 28))))
        }).join('')
        const lines = []
        for (let i = 0; i < s.length; i += 90) lines.push(`    ${s.slice(i, i + 90)}`)
        return lines
      }
      const flickers = (key) => rows.filter((r, i) => {
        if (i < 2) return false
        const a = rows[i - 2][key]
        const b = rows[i - 1][key]
        const c = r[key]
        if (!(a >= 0 && b >= 0 && c >= 0)) return false
        return Math.abs(c - b) > 12 && Math.abs(c - a) < 6
      }).length
      // A readback that never moved at all is a broken readback, not a still
      // scene -- say so rather than letting a flat strip read as evidence.
      out.push(`  crosshair pixel: ${flickers('mid')}/${rows.length} frames are an A-B-A-B flicker, brightness ${span('mid')}` +
        (steps('mid', 0.5) === 0 ? '  <-- NEVER CHANGED AT ALL: the pixel readback is not seeing the canvas, ignore both strips' : ''))
      out.push(...strip('mid'))
      out.push(`  tracked rock pixel: ${flickers('rock')}/${rows.length} frames are an A-B-A-B flicker ('.' = off screen)`)
      out.push(...strip('rock'))
      console.log(out.join('\n'))
      this._lastWatch = rows
    }

    // Start late, so the sampling window belongs to the game rather than to the
    // console's pointer lock. See the header.
    console.log(`[rocks.watch] click back into the game and turn until they blink -- sampling starts in ${delay}s and runs for ${seconds}s`)
    setTimeout(() => {
      install()
      t0 = performance.now()
      requestAnimationFrame(sample)
    }, delay * 1000)
    return `watching in ${delay}s`
  }

  get stats() {
    const beds = this.beds.map((b) => b.stats)
    return {
      beds,
      placed: beds.reduce((n, b) => n + b.placed, 0),
      tris: beds.reduce((n, b) => n + b.tris, 0),
      pool: beds.reduce((n, b) => n + b.pool, 0),
      used: beds.reduce((n, b) => n + b.used, 0),
      shapes: this.bank.shapes.length,
      bankKB: Math.round(this.bank.bytes / 1024),
      bankTris: this.bank.triangles,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
    }
  }

  dispose() {
    for (const bed of this.beds) bed.dispose()
    this.material.dispose()
  }
}
