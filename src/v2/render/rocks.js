import THREE from '../../three-instance.js'
import { QUANT, levelFor, poolBound } from './tile-pool.js'

import {
  buildRockBank, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT,
  rockImpostorLayers, TINT_GAIN,
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
// ONE ROCK, SIX BEDS. There is exactly one boulder mesh in the world
// (props/rock-bank.js) and everything below is about WHERE COPIES OF IT GO and
// HOW BIG. Six beds, because a rock's size spans two orders of magnitude and no
// single density-and-radius pair carries both ends. Each is a complete
// independent scatter with its own tile grid, density, radius, LOD bands and
// instance pool:
//
//   UNDERFOOT   0.25 - 2 m    dense, 120 m     stones you step over
//   BOULDERS    0.5 - 10 m    medium, 600 m    the forest and cliffside rocks
//   SCREE       0.3 - 3 m     dense, 280 m     the pile at the foot of a face
//   SUNKEN      0.5 - 5 m     sparse, 320 m    stones standing on the lake floor
//   GIANTS      1.6 - 15 m    sparse, 1250 m   the landmarks
//   EMBEDDED    2 - 20 m      sparse, 1350 m   blocks let INTO a face or a bed
//
// EACH BED EXISTS BECAUSE SOMETHING IT NEEDS IS PER-BED AND CANNOT BE VARIED
// WITHIN ONE -- the only test a new bed has to pass. Scree needs the candidate
// count (`envDensity` is an accept rate capped at 1, so a saturated site cannot be
// made denser by any multiplier); sunken needs `submergedOnly` and a size range of
// its own; embedded needs `sinkRange` -- 70 to 90% under, where every other bed's
// burial roll tops out at 80% of the way there, and a rock cannot be sunk that far
// and also stand on the ground in the same bed. Six beds are six BatchedMeshes and
// six draw calls, which does not break §5's one-material rule -- that rule forbids
// splitting a BATCH by material. They share ONE material object, unlike trees,
// ferns and grass, because every bed here billboards the same single layer and one
// program serves them all.
//
// WHERE A ROCK GOES IS DECIDED BY WHERE IT IS, not by a roll. A candidate is
// classified into one of four ENVIRONMENTS -- river, peak, cliff, forest -- from
// the field sample the placement test already pays for (`_envAt`), and the
// environment then sets how DENSE the bed is there, how BIG the rock is and which
// TINTS it may wear. A pure function of position, exactly as existence is, so a
// rock does not change colour or size as the player walks toward it. `_relief`
// adds a finer test on top: the second difference of the height field along the
// fall line tags a site `foot` or `brow`, the only way to tell the bottom of a
// cliff from the top of one. Only the scree bed asks, and only for `foot`, so
// only the scree bed pays for it.
//
// ROCKS SIT IN THE GROUND AND LEAN WITH IT, and both halves matter: bedded by a
// fraction of their own standing height that GROWS WITH THE SLOPE, and tilted
// toward the ground normal, which trees deliberately are not -- a tree on a slope
// grows up, a rock lies the way it fell. The tilt costs four field samples per
// PLACED rock and is off for the underfoot bed. On top of the ground lean every
// rock takes a free ±15° jitter about a random HORIZONTAL world axis, which is why
// it is applied by premultiply: composed the other way round a rolled rock's lean
// would land on its own tipped axis and read as a second yaw.
//
// AND EVERY ROCK IS PRE-TURNED BY A RANDOM QUARTER TURN ABOUT X AND ABOUT Z, one
// of sixteen, WHICH IS WHERE MOST OF THE SILHOUETTE VARIETY IN A ONE-SHAPE WORLD
// COMES FROM: a different face is down and a different corner is up each time.
// Quarter turns and not free angles on purpose: 45° reads as a boulder leaning on
// the air. It is legal at all because the boulder is CLOSED -- it has a floor to
// land on whichever way it is turned -- and no bed opts out. THE TURN IS WHY THE
// SEATING IS COMPUTED FROM A BOX rather than from `measured.height`: the
// geometry's origin is on its BED FACE, so a rock turned on its side hangs below
// its own origin, and burial has to be a fraction of what it now STANDS
// (`yMax - yMin` of the turned box) measured from where its lowest corner now is.
// `instSink` carries `sink + yMin` for exactly that reason and goes legitimately
// negative.
//
// BURIAL IS A ROLL BETWEEN A SLOPE-DRIVEN FLOOR AND `sinkRange`'s top, BENT BY
// SIZE: SINK_SIZE_TILT raises the roll to a power below 1 for a big rock, so a
// 10 m block is far likelier to be half-sunk than a cobble is. On a steep face
// `sinkNormal` divides the depth by the cosine of the slope, because `instY` moves
// a rock down WORLD Y while "80% buried" on a wall means 80% along the face.
//
// Snow and moss are the material's, not this file's:
// both derive in the vertex shader from the instance's own root height against a
// line, so a boulder is green in a damp wood, bare on a ridge and white on a
// summit at no per-instance data and no per-frame CPU. See syncBands.
//
// ONE LOD LADDER, AND THE THRESHOLDS ARE PER ROCK RATHER THAN PER BED -- the thing
// to understand about this file if you are here about LOD at all. The boulder
// ships T320/T80/T20 and a two-triangle card, and every instance steps between
// them at `ROCK_LOD_AT` metres per metre of its OWN ladder size (`rockLodSize`
// times its scale): 4 to T80, 7.5 to T20, 25 to the card, so a 2 m rock holds real
// geometry out to 50 m, a cobble to 8.5, a 12 m landmark to 300. A table of metres
// per bed was wrong in both directions at once, because a bed is not one size of
// rock -- which is the whole reason one mesh can serve the world.
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
// THERE IS A CARD TIER AND NO BED DECLINES IT. §25 carries the argument and the
// spherical spin that makes one quad legible from above as well as across.
// ---------------------------------------------------------------------------

// The beds. Each is an independent scatter of the same one boulder; what a bed
// declares is where it may stand, how thickly, how big and how deep in.
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
    // DOES NOT DISPLACE PROPS, and this bed is why `blocks` defaults to false.
    // Grass growing up between river stones is the look, not an error, and this is
    // the densest bed of geometry anywhere near the player -- flagging it would put
    // nine tile lookups over hundreds of pebbles on every blade of grass in the
    // world to strip the ground of the grass that belongs there. See
    // Rocks.blockTopAt.
    blocks: false,
    // In METRES, like every bed: a range in metres divided back through the
    // boulder's own measured width (see where the scale is resolved in
    // _growTile). The riverbed gets a taller range than the dry ground because a
    // stream bed is where a stone big enough to step around belongs.
    sizeByEnv: {
      river: [0.3, 2.0],
      forest: [0.25, 1.0],
      cliff: [0.25, 1.0],
      peak: [0.25, 1.0],
    },
  },
  {
    name: 'boulders',
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
    // 600, UP FROM 460, AND SET BY `sizeByEnv` BELOW RATHER THAN BY TASTE. A 10 m
    // boulder holds a mesh tier out to 250 m under ROCK_LOD_AT and then owes its
    // card a full ROCK_CARD_LIFE band, so `minReach` demands 588 m; at 460 the
    // biggest rocks in the wood would have been culled outright while still LOD2
    // meshes. Costs (600/460)^2 = 1.7x the disc and the pool with it, which is the
    // real price of the 10 m top end.
    radius: 600,
    tile: 28,
    minElev: 0,
    maxSlopeDeg: 48,
    allowSubmerged: true,
    tilt: 0.7,
    // See SINK_DEEP. Most beds vary their burial per instance; the underfoot bed
    // does not, because a pebble is too small for the difference to read.
    sinkVary: true,
    // AN ANCHOR BED, and the one a caller is really asking about: half a metre
    // through to ten spans everything from a stone you could pick up to a rock
    // the size of a shed, which is the whole range of stone with a damp shaded
    // base to grow anything against. See Rocks.anchorsInto.
    anchor: true,
    // AND THE BED THE WHOLE DISPLACEMENT RULE IS ABOUT: a tree that lands inside
    // one of these stands on it and a blade of grass that lands inside one is not
    // placed at all. See Rocks.blockTopAt.
    blocks: true,
    // PILED AT THE FOOT OF A FACE, on top of what it strews everywhere else. The
    // scree bed makes the talus; this makes the BOULDERS among it, which is a
    // different sight -- a metre-and-up block leaning against the base of a crag
    // rather than a field of chips. It costs the four relief samples on every
    // candidate over a 600 m disc, which is why no other bed asks: `footDense` is
    // a look, not a default. The rates below are what make it visible -- an
    // accept rate is capped at 1, so 0.4 * (1 + CLUMP_GAIN * clump) has room to
    // move where 1.0 would have every last bit of it truncated away.
    footDense: true,
    // HALF A METRE TO TEN, THE SAME EVERYWHERE. Four identical entries is not a
    // mistake -- `sizeByEnv` is per environment because the underfoot, sunken and
    // embedded beds need it to be, and a bed that wants one range everywhere says
    // so four times rather than growing a second mechanism to say it once.
    sizeByEnv: {
      river: [0.5, 10.0],
      forest: [0.5, 10.0],
      cliff: [0.5, 10.0],
      peak: [0.5, 10.0],
    },
    // AND HEAVILY WEIGHTED TO THE SMALL END, which is what makes the 10 m top
    // affordable as a LOOK rather than as a budget. A flat roll over 0.5-10 m puts
    // the median boulder at 5.25 m, and a wood with a 5 m block every fifteen
    // metres is a boulder field, not a wood. At 4 the median is 1.1 m, the upper
    // quartile 3.5 m and the top decile 6.7 m: one rock over 6.7 m per 2,400 m2 of
    // forest, about one every fifty metres, which is what a landmark erratic
    // should be. The big end is rare, not absent -- that is the whole difference
    // between biasing the roll and narrowing the range.
    //
    // It also feeds the burial: `sizeRoll` is what SINK_SIZE_TILT bends the sink
    // roll by, so a bed weighted this far small leaves most rocks on a near-uniform
    // depth draw and spends the deep-burial bias on the few big ones.
    sizeBias: 4,
    // NO ROCK INSIDE ANOTHER ROCK -- see the scree bed for the mechanism. It was
    // pointless at the old 0.19-7.5 m spread and one rock per 240 m2, which is why
    // this bed had none; at a 10 m top it is not, because two 8 m boulders landing
    // 5 m apart make one 13 m blob and the silhouette is what the size was bought
    // for. Nearly free here: 8 candidates a tile against scree's 196, so ~30
    // distance tests where that bed pays 19,000.
    minGap: 0.6,
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
    // stone from the boulders bed.
    name: 'scree',
    // HALVED, AND THE ROCKS MADE BIGGER TO PAY FOR IT -- see `sizeByEnv` and
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
    // not thin the pile, it deletes whole piles. The other end is a floor rather
    // than a target: the bed's biggest block cards at 75 m and owes a
    // ROCK_CARD_LIFE band past that, so `minReach` refuses anything under 177 m.
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
    // It does displace, though: a talus block is a metre of solid stone and a
    // sapling growing through one at the foot of a cliff is exactly the error
    // Rocks.blockTopAt exists to stop.
    blocks: true,
    // WEIGHTED TOWARDS THE BIG END, which is the half of the density decision
    // that stops a halved talus cone from reading as a thinner gravel path. Ten
    // to one from bottom to top, with `sizeBias` under 1 pushing the roll UP the
    // range: 0.7 puts the median at 1.96 m and the top decile at 2.81 m, against
    // 1.65 and 2.72 for a flat roll -- a pile with blocks in it rather than a bed
    // of chips.
    //
    // NO SMALL END TO SPEAK OF, deliberately. Dropping the bottom to the
    // underfoot bed's 0.25 m would rebuild the speck carpet inside the one place
    // the rocks are supposed to be big, and each of those specks costs a full
    // instance whatever its triangle count.
    //
    // Only `cliff` and `peak` are listed because they are the only environments
    // this bed's `envDensity` can reach; the constructor takes `hi` over the
    // reachable ones and would throw on a missing entry.
    sizeByEnv: {
      cliff: [0.3, 3.0],
      peak: [0.3, 3.0],
    },
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
    // THE ONLY BED THAT EXISTS BELOW THE WATERLINE, and the reason it is its own
    // bed rather than a rate on an existing one is the same reason `scree` is:
    // `submergedOnly` and a size range of its own, neither expressible as a
    // multiplier on a bed that also stands on dry ground.
    //
    // What it is for: the SILHOUETTE in the murk. The rest of a lake floor is
    // texture -- the litter stamps, and the underfoot bed's stones at a third of
    // a metre -- and texture is something the eye reads as one continuous sheet
    // however much of it there is. A stone standing metres PROUD of that sheet is
    // the opposite kind of object: it occludes what is behind it, and at five
    // metres in poor visibility it resolves before the floor does. That shape
    // looming out of the water is the whole effect, and it is why the bed is
    // sparse: something you come across is mysterious, something there is one of
    // every four metres is gravel.
    name: 'sunken',
    // 0.02 x 0.5 is one stone per 100 m2, about one every ten metres, against the
    // underfoot bed's one per 36 m2 of the same floor. Roughly a quarter of the
    // lake bed's stone by count, and all of the part with a silhouette.
    density: 0.02,
    // Three hard zeroes, and not a taste call that could be reopened:
    // `submergedOnly` means a candidate in any of these environments has already
    // failed the water test, so a rate here would be unreachable. See _envAt --
    // submerged ground is always `river`.
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
    // the embedded bed, whose rocks are more ground than object.
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
    // Displaces, on the same terms as the boulders: these are closed stones half
    // a metre to five across, and the litter stamps do reach a shallow lake floor.
    blocks: true,
    // EXACTLY THE BAND THAT WAS ASKED FOR. One environment listed because
    // `submergedOnly` makes the other three unreachable.
    //
    // The top is half of what stands in the same water on the bank: a 5 m stone
    // is something you swim around, and bigger stops being a boulder and starts
    // being terrain the terrain does not know about.
    sizeByEnv: {
      river: [0.5, 5.0],
    },
  },
  {
    name: 'giants',
    density: 0.0006,
    // A house-sized rock in a wood is a landmark and has to stay one: 0.25 of
    // 0.0006 is one per 6,700 m2, one every ~80 m -- rare enough to notice, common
    // enough that a walk passes several. A cliff face runs full rate and is covered.
    envDensity: { river: 0.15, forest: 0.25, cliff: 1, peak: 0.8 },
    fullRadius: 270,
    radius: 1250,
    tile: 70,
    // THIS IS THE BED THE CARD WAS BUILT FOR. A 7 m landmark holds T80 to 53 m and
    // T20 to 175, then cards for the remaining 1075 m -- a ~4.8 km2 annulus where
    // forty triangles become two. Gains least from tightening the ladder: its rocks
    // were always the ones big enough to earn their mesh.
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
    blocks: true,
    // NEARLY TEN TO ONE, and the width of the range is the point. A giant is what
    // you navigate by, so giants within a factor of two of each other read as one
    // prop repeated -- and with one mesh in the bank, SIZE is the only thing left
    // to tell two landmarks apart. 15 m is the biggest rock that stands on the
    // ground anywhere in the world; past that the embedded bed takes over and
    // buries the difference.
    //
    // `sizeBias` 2 weights it small without giving up the top: the median lands
    // near 5 m, which is what the bed placed before, and the top decile near
    // 12.5 m, so the 15 m block stays the thing you walk half a mile to.
    sizeByEnv: {
      river: [1.6, 15.0],
      forest: [1.6, 15.0],
      cliff: [1.6, 15.0],
      peak: [1.6, 15.0],
    },
    sizeBias: 2,
  },
  {
    // THE EMBEDDED LAYER: rock that is mostly UNDERGROUND, and the only bed whose
    // subject is the part you cannot see.
    //
    // Every other bed places an object standing on a surface. This one places the
    // top of something much larger -- seven to nine tenths of it buried, so what
    // shows is a knuckle of a block whose real size you infer from how far apart
    // its exposed corners are. That is what makes a cliff read as ROCK WITH SOIL ON
    // IT rather than as a heightfield with props on it: a 20 m block showing its
    // last three metres is a piece of the mountain the mountain does not know
    // about, which no rock STANDING on the surface can be.
    //
    // IT IS ALSO WHAT COVERS A CLIFF FACE. The other beds refuse ground past 40 to
    // 62 degrees, so their `cliff` rates are spent on the apron below a face and
    // never on the face itself; at 72 degrees this bed is the only one allowed up
    // there, and a block showing its last three metres is a better answer than a
    // rock balanced on a wall would have been.
    //
    // WHY IT IS ITS OWN BED, on the file's only test: `sinkRange` is per-bed and
    // cannot be varied within one, and no rate on an existing bed can reach 0.7-0.9
    // when SINK_DEEP caps every other bed at 0.8 and their floors start at 0.1. The
    // slope limit and the size range are per-bed for the same reason.
    //
    // BURIAL IS WHAT MAKES ONE MESH WORK HERE rather than a problem it has to
    // survive: at 70 to 90% under, what shows is a knuckle and a couple of corners,
    // and the quarter turn decides WHICH corners. The same boulder buried this far
    // is less recognisable as itself than at any other depth in the file.
    name: 'embedded',
    density: 0.01,
    // No forest: an embedded block in flat woodland is a boulder that has been sunk
    // too far, and the boulders bed already owns that ground with a burial band
    // that tops out at 0.8. Peak matches cliff because a summit IS steep bare rock
    // -- `_envAt` only calls it something else because of how high it is.
    envDensity: { river: 0.4, forest: 0, cliff: 0.25, peak: 0.25 },
    fullRadius: 120,
    // 1350, DEMANDED BY THE 20 m TOP AND NOT NEGOTIABLE DOWN. A 20 m block cards
    // at 500 m and owes a ROCK_CARD_LIFE band past that, so `minReach` refuses
    // anything under 1,176 m. Burial does not buy any of it back -- sinking a rock
    // takes away its HEIGHT and the ladder is its longest axis, which here is the
    // width still lying across the face. This is why the density is a fifth of what
    // "litter" sounds like: reach is quadratic and this bed has the longest.
    radius: 1350,
    tile: 60,
    minElev: 0,
    // THE STEEPEST GROUND ANY BED ACCEPTS, and 72 rather than higher because past
    // about seventy the world-Y sink stops reaching into the face at all whatever
    // `sinkNormal` does for it -- the rock slides down the slope instead of into
    // it, and a block that is not really buried on a wall is a block balanced on
    // a wall.
    maxSlopeDeg: 72,
    allowSubmerged: true,
    // NEARLY FLUSH WITH THE SURFACE, and the highest alignment in the file. At
    // this burial the rock is part of the ground: a block 80% buried that is still
    // standing up straight on a 60 degree face reads as having been pushed in
    // rather than exposed by it.
    tilt: 0.9,
    sinkVary: true,
    // THE NUMBER THE BED EXISTS FOR.
    sinkRange: [0.7, 0.9],
    // AND THE ONE THING THAT MAKES IT WORK ON A FACE. `instY` is a world-Y offset,
    // so on steep ground burial slides a rock ALONG the slope far more than it
    // pushes it into it -- at 70 degrees, nine tenths of the sink is wasted. See
    // where this is applied in _growTile.
    sinkNormal: true,
    // Not an anchor: the base of one of these is under the hill.
    anchor: false,
    // Still displaces. Most of one of these is underground, but the tenth to
    // three tenths that is not is a block metres across, and a tree growing out of
    // the middle of it reads no better than one growing out of a boulder.
    blocks: true,
    // Big on a wall, smaller in the water, which is `sizeByEnv`'s whole purpose. A
    // lake floor is looked at from a few metres away in poor visibility, so a 20 m
    // block there is terrain; a cliff is looked at from across a valley, where
    // 20 m is one feature among many. `forest` is absent because the bed's forest
    // rate is 0 and an entry there would be unreachable.
    sizeByEnv: {
      river: [2.0, 10.0],
      cliff: [3.0, 20.0],
      peak: [3.0, 20.0],
    },
    // Weighted small, on the boulders bed's argument and more sharply, because
    // this bed's range is wider and its reach is the longest in the file: at 3 the
    // median cliff block is 5.1 m and the top decile 15.4 m.
    sizeBias: 3,
    // No block inside another block. Worth more here than anywhere: two of these
    // overlapping do not read as two rocks jammed together, they read as one
    // wrongly-shaped rock, because the joint is the only part of either that shows.
    minGap: 0.7,
  },
]

// Where the four environments cut. All read off the same field sample the
// placement test already pays for, plus one water lookup.
//
// A rock this far out of the water still belongs to the river: the tint palette
// is chosen off the environment, and a hard edge at the waterline would put a
// lichen boulder half in the stream.
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

// How deep a rock is bedded, as a fraction of its own STANDING height: this much
// at the flat, rising to this plus the span at the bed's slope limit. A rock
// resting exactly on the ground reads as placed; a third buried reads as part of
// the hill. The height burial is a fraction OF is the rock's extent after the
// quarter-turn rolls (see ROLL_STEPS), not `measured.height`, so a boulder laid
// on its side is bedded by a tenth of what it now stands, not of what it used to.
const SINK_MIN = 0.1
const SINK_SLOPE = 0.28

// AND A ROCK STOOD ON END IS BEDDED THREE TIMES DEEPER. The quarter turns put a
// different axis up each time, and one of the boulder's three is half again as
// long as the others: stood on that one it is a 2 m slab on a 1.2 m base, and a
// tenth of that underground reads as balanced. Nothing that shape stays up on
// open ground unheld, and burial is the only thing holding it -- `sit` is 0 on
// the shipping shape, so no instance is standing on a cut face either.
//
// TALL IS A RATIO, NOT A HEIGHT: the rolled box's vertical extent over the mean
// of its two plan extents, so the rule follows the shape rather than a number
// read off one seed. At 1.0 it fires on an orientation that stands taller than
// the ground it covers and on no other, which is half the sixteen turns.
const SINK_TALL = 0.3
const TALL_AT = 1

// The deep end of the per-instance burial roll, for beds that set `sinkVary`, and
// the default top of `sinkRange`. Four fifths of a rock underground is a rock the
// hill has grown most of the way up around. Rolling it PER INSTANCE is the point:
// a scatter where every rock is bedded the same fraction reads as props standing
// ON the terrain rather than as stone coming OUT of it, and the giveaway is that
// they all meet the ground at the same relative height.
//
// It wastes triangles -- the buried part is still built, skinned and submitted --
// which is why `embedded` is the only bed that goes near the top of the range and
// why it is sparse.
const SINK_DEEP = 0.8

// HOW MUCH BIGGER MEANS DEEPER. The burial roll is bent by the rock's own size
// roll before it is read: `sinkRoll ** (1 - SINK_SIZE_TILT * sizeRoll)`, so the
// smallest rock in a bed draws its depth uniformly and the largest draws with an
// exponent of 0.45, whose mean sits at 0.69 of the range against 0.5. A big rock
// is not always deeper -- it is likelier to be, which is what settling looks like:
// mass sinks, but a block dropped on bedrock last winter is still sitting on it.
const SINK_SIZE_TILT = 0.55

// The ceiling on `sinkNormal`'s correction. Burial moves a rock along world -Y,
// but what "70% buried" means on a cliff is 70% along the surface NORMAL, and the
// two differ by 1/cos(slope): at 72 degrees a rock lowered by its own height goes
// less than a third of that into the face and the rest of the move just slides it
// downhill. `sinkNormal` beds multiply by hypot(tan, 1) to undo it, capped here
// because the correction diverges at vertical and a rock dropped four times its
// own height is gone rather than embedded.
const SINK_NORMAL_MAX = 3

// The hard ceiling on burial, as a fraction of what a rock stands, applied after
// the slope floor, the roll and the normal correction have all had their say. It
// sits just above `embedded`'s 0.9, so it changes nothing a bed asked for and
// only catches the sum running away.
const SINK_CAP = 0.92

// --- how a rock is turned ----------------------------------------------------
//
// QUARTER TURNS, AND ONLY QUARTER TURNS. Every bed pre-rotates each instance by a
// whole number of right angles about x and then about z, 16 combinations off one
// roll. THE POINT IS VARIETY FROM ONE MESH, and with one closed boulder in the
// bank this is the largest single source of it: a shape that only ever spins
// about its own vertical axis reads as the same object repeated however good it
// is, and turning it puts a different face down and a different corner up.
//
// THE INCREMENT IS 90 AND NOT A FREE ANGLE, which is the whole content of the
// rule. A rock rolled 45 degrees rests on an edge, and an edge is not a thing a
// rock rests on -- it reads as leaning on the air. At a quarter turn the face
// that was the bed face is now a side face and some other flat is down, which is
// a rock that fell over: exactly as stable, and a different silhouette.
//
// NO BED OPTS OUT, and none can: the boulder is closed, so every one of its
// sixteen orientations stands on solid geometry.
const ROLL_STEPS = 4

// The random lean laid on TOP of the ground alignment, in radians, about a
// uniformly random horizontal axis. `tilt` follows the hill and is the same
// answer for every rock standing on one patch of it, so a slope came out as a
// parade of rocks all leaning the same way; this is the part that says each of
// them fell separately. Kept small deliberately -- past about fifteen degrees the
// quarter-turn argument above starts to come apart again, because a rock leaning
// that far off any of its flats is back to resting on an edge.
const TILT_JITTER = (15 * Math.PI) / 180

// --- what a boulder does to the props around it (Rocks.blockTopAt) -----------
//
// How far into the rock a prop standing on top of it is pushed, as a fraction of
// the rock's ladder size and then capped. Nothing here is trying to model a
// tree's roots -- it is paying for the LOD ladder, and that is now the only
// thing it pays for. A prop is seated against the T320's surface (blockHull) and
// the mesh drawn at fifty metres is a T20 whose surface wanders either side of
// it: on the shipping boulder the two agree to 2 mm at the median, and the T20
// runs up to 52 cm inside the T320 at the worst corner of a 1.16 m rock.
// Proportional because that gap scales with the rock, capped because on a
// twenty-metre block the proportion alone would bury a sapling.
const BLOCK_SETTLE = 0.04
// Exported for the gate that measures how far into the stone an answer landed,
// which needs the ceiling rather than a literal that could drift away from it.
export const BLOCK_SETTLE_MAX = 0.35

// How big a rock has to be before a prop stands ON it rather than beside it, in
// metres of ladder size. Exported because two scatters have to agree on it and a
// literal in each would drift; it is the callers' number rather than this file's
// (see Rocks.blockTopAt) and lives here only so there is one of it.
//
// A metre, and the reason is what the two answers look like when they are wrong.
// A tree lifted onto a half-metre cobble is a tree standing on a pedestal, which
// nothing in a wood does. A tree left growing through a two-metre boulder is a
// tree growing through a boulder. The first is the worse error, so the threshold
// sits at the size where stone stops being ground clutter and starts being
// something you would walk around.
export const ROCK_STAND_MIN = 1

// --- relief, which is how the scree bed finds the foot of a face -------------
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
// `brow` is measured and never consumed: the two beds that probe both want feet
// -- scree refuses anything else, boulders merely run denser there. The drop test
// costs nothing extra -- both come out of the same four probes -- and it is kept
// because `_relief` returning one tag would be a test for a cliff foot rather than
// a reading of the landform, and the readout in `stats` is the only view of the
// terrain's shape this file has.
const FOOT_RISE = 7
const BROW_DROP = 7

// Scree lies in PILES, and this is the field that makes them. A smooth value
// noise on this lattice multiplies local density at foot sites only, so the base
// of a face runs from bare to CLUMP_GAIN times its environment over a few tens of
// metres. Without it density is uniform along the base of every cliff in the
// world, which reads as gravel spread with a rake. The 26 m cell is just under two
// of the scree bed's 14 m tiles, and the lattice has its own origin and seed
// (`tileSeed(cx, cz, seed, -1)`) so it never inherits the tile grid's edges. Raise
// this to make a drift a landform rather than a patch.
const CLUMP_CELL = 26
const CLUMP_GAIN = 2.2

// How far a rock's tint is pulled toward the terrain colour underfoot: a plain
// lerp from 1 toward the terrain's own vertex colour from the chunk mesher's
// `shade`, so the rock takes the ground's LIGHTNESS as well as its hue.
//
// IT USED TO BE HUE ONLY, the terrain colour renormalised to unit luminance on
// the argument that a rock's tint is a DESTINATION (ENV_TINTS, rock-bank.js) and
// the terrain palette is near black, so its magnitude would delete the rock. The
// arithmetic behind that fear does not survive the cue being a LERP rather than a
// multiply: the terrain runs 0.059 to 0.088 in luminance everywhere except snow,
// which is 0.879, so at the forest's 0.45 a boulder keeps 0.58 of its brightness
// and on a snowfield it keeps 0.93. Roughly a halving in a wood, not a deletion --
// and the halving is the point, because a rock two and a half times the lightness
// of the ground it is lying on reads as lit by a different sun.
//
// ABOVE THE FERNS' 0.35, reversing the old argument that a rock is a different
// material from the ground a fern grows out of. True of a boulder at arm's length,
// false of the population that matters: most stone in the world is far enough away
// to be a flat photograph, and tone is most of what is left at that range.
//
// PER ENVIRONMENT, AND THE ORDER OF THE FOUR IS THE WHOLE POINT: it runs from the
// ground a rock is made OF to the ground it is merely standing on. River highest
// (a rock on a river bottom IS the river bottom), cliff and peak next (the
// embedded blocks ARE the cliff), forest lowest -- granite on green loam genuinely is
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
// camera 9 m between updates and the underfoot bed saturates at 1024, because the
// ladder is measured in ROCK SIZES -- 4, 7.5 and 25 of them -- so a 9 m jump
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

// HOW FAR OUTSIDE ITS OWN BOX A ROCK STILL COUNTS AS CONTAINING THE EYE. See
// RockShell for what containment turns on; this is the slack on the test.
//
// The test is the rock's bounding CYLINDER -- vertical span and widest radius,
// both at the instance's scale -- and not a sphere about the origin, even though
// a sphere would be one compare cheaper on a distance the LOD loop already has.
// A sphere has to hold the whole rock from a point on its BED FACE, which for a
// 15 m giant is a 19 m ball, and a ball that size is over the camera whenever the
// player walks anywhere near one. A shell that never switches off is exactly the
// standing cost this is not allowed to have.
//
// THE SLACK IS 15% AND IT IS DELIBERATE, because the errors here are not
// symmetric. The cylinder is upright and the instance is LEANED, so a real rock
// pokes a little outside it; missing that is a hole out into the world at the one
// viewpoint that has no front faces left to close it. Over-reaching costs
// nothing -- the shell is a back-side draw depth-tested against the rock's own
// front faces, so a shell you are outside of is hidden behind the rock. 15% of a
// rock's own size is also comfortably past the 0.1 m near plane, so the interior
// is already up by the time the eye can see through the surface.
const INSIDE_PAD = 0.15

// HOW LONG A ROCK IS A WHOLE BILLBOARD FOR, as a multiple of the distance its
// card takes over at.
//
// Flooring the gone-distance at exactly the card distance is the least that can be
// called correct, and least is what it delivered: 39% of the river underfoot
// rocks and more besides started dissolving in the same metre their card
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
 * The horizontal reach of the built boulder at height `y` above its own bed plane,
 * in the geometry's own metres (instance scale 1). Called once per anchor bed at
 * boot to fill its `footRadius`; see Rocks.anchorsInto for what a caller does with
 * it. The argument is DESIGN.md §25.
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
 * `what` NAMES THE SUBJECT FOR THE THROW BELOW and nothing else: the geometry
 * knows only which LOD tier it is, and "T320" alone is no help to somebody
 * looking for what stopped the world from booting.
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
  // what this measurement assumes -- a solid whose bottom is a real floor -- and a
  // footprint radius of zero would be a silent lie.
  if (!hits) {
    throw new Error(
      `sectionRadius: nothing crosses y = ${y} in ${what} at tier ${geo.userData.rock.tier}`
    )
  }
  return Math.sqrt(r2)
}

/**
 * The triangles Rocks.blockTopAt drops a ray through, in the shape's own frame:
 * `tri` is one corner and two edges per face, nine doubles at a time, which is
 * the layout Moller-Trumbore wants and saves it six subtractions per triangle per
 * query. `radius` is how far the shape reaches from its own origin, which is what
 * the query rejects on.
 *
 * THE ORIGIN IS NOT THE MIDDLE OF THE ROCK -- it is the middle of the BOTTOM, and
 * the quarter turns rotate about it, so a rock laid on its side has its whole body
 * beside `instX, instZ` rather than over it. Measured: every boulder in a wood
 * reaches past the circle `instSpan` describes, by up to 1.67x its radius. Hence a
 * radius taken over the vertices themselves, which no roll and no lean can defeat
 * because it is the distance to the furthest one. Scaled per instance and used as
 * a vertical cylinder, it is a reject that cannot drop stone; RockBed._surfaceAt's
 * box slab is what tightens it back up before the triangles are walked.
 *
 * CACHED ON THE SHAPE, because five beds block and they displace props with the
 * same stone -- and built from a CONSTRUCTOR, because Rocks disposes the bank's
 * geometries the moment the beds are built and this is the last point the
 * attribute is readable. Same reason `footRadius` is measured where it is.
 *
 * THE FINEST TIER IS THE SUBJECT even though a distant rock is drawn coarser. It
 * is the mesh a player close enough to read a prop's foot is looking at, and its
 * plan silhouette is the widest of the three -- 15% of the footprint is stone in
 * the T320 and nothing in the T20, so seating against the coarse mesh would drop
 * props to the ground beside stone that plainly covers them. BLOCK_SETTLE pays
 * for the rest of the ladder.
 */
function blockHull(shape) {
  if (shape.hull) return shape.hull
  const geo = shape.tiers[0]
  const pos = geo.attributes.position.array
  // The walk reads corners straight out of `position` in threes, as sectionRadius
  // does. An indexed tier would make that read someone else's triangles.
  if (geo.index.count * 3 !== pos.length) {
    throw new Error(
      `blockHull: the T${geo.index.count / 3} tier shares vertices between faces, ` +
        `so a ray walk over \`position\` would not be walking its triangles`
    )
  }
  const tri = new Float64Array(pos.length)
  let r2 = 0
  for (let f = 0; f < pos.length; f += 9) {
    for (let c = 0; c < 3; c++) {
      tri[f + c] = pos[f + c]
      tri[f + 3 + c] = pos[f + 3 + c] - pos[f + c]
      tri[f + 6 + c] = pos[f + 6 + c] - pos[f + c]
    }
  }
  for (let i = 0; i < pos.length; i += 3) {
    r2 = Math.max(r2, pos[i] * pos[i] + pos[i + 1] * pos[i + 1] + pos[i + 2] * pos[i + 2])
  }
  shape.hull = { tri, radius: Math.sqrt(r2) }
  return shape.hull
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

    // The two beds that pay for the relief probe, and what each buys with it.
    // `footOnly` REFUSES every candidate that is not standing at the base of a
    // face -- the scree bed, which has no business anywhere else. `footDense`
    // accepts everywhere and merely runs denser at a foot -- the boulders bed,
    // where the brief asks for stone piled at the base of a cliff on top of the
    // stone strewn through the wood. Either one makes `_relief` fire; a bed that
    // asks for neither never takes the four extra field samples. See `_relief`.
    this.footOnly = cfg.footOnly ?? false
    this.footDense = cfg.footDense ?? false
    this.probesRelief = this.footOnly || this.footDense

    // The burial band, as a fraction of what the rock stands. The default is the
    // whole world's; `embedded` is the one bed that overrides it, and overrides it
    // to a band that starts above where every other bed ends.
    const sinkRange = cfg.sinkRange ?? [SINK_MIN, SINK_DEEP]
    if (!(sinkRange[0] >= 0) || !(sinkRange[1] > sinkRange[0]) || !(sinkRange[1] < 1)) {
      throw new Error(`RockBed ${cfg.name}: sinkRange must ascend within [0, 1), got ${sinkRange.join('..')}`)
    }
    this.sinkLo = sinkRange[0]
    this.sinkHi = sinkRange[1]
    // See SINK_NORMAL_MAX. On `embedded` alone, and meaningless on a bed whose
    // burial is a few percent of a rock that is standing on flat ground anyway.
    this.sinkNormal = cfg.sinkNormal ?? false

    this.maxQ = Math.max(1, Math.ceil(Math.log2(Math.sqrt(this.evictSq) / cfg.fullRadius) * QUANT))
    this.uAt = new Float32Array(this.maxQ + 1)
    this.loSq = new Float32Array(this.maxQ + 2)
    for (let q = 0; q <= this.maxQ; q++) this.uAt[q] = Math.pow(2, -q / QUANT)
    for (let q = 0; q <= this.maxQ + 1; q++) this.loSq[q] = (cfg.fullRadius * Math.pow(2, q / QUANT)) ** 2

    // THE BANK, WHICH IS ONE BOULDER. Every bed places the same shape and differs
    // only in where, how thickly, how big and how deep.
    this.shape = bank.shape

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
    // A bed that requires water and is not allowed water places nothing, and that
    // presents as an empty lake with no error anywhere. Say it here instead.
    if (cfg.submergedOnly && !cfg.allowSubmerged) {
      throw new Error(`RockBed ${cfg.name}: \`submergedOnly\` without \`allowSubmerged\` can never place a rock`)
    }
    // EVERY BED SAYS HOW BIG IN METRES. One shape in the bank means a multiplier
    // on it and a target width differ only by the constant `measured.width`, so
    // there is one mechanism and it is the one that reads literally: a bed asks
    // for 0.5 to 10 m and gets rocks 0.5 to 10 m across.
    for (const env of ENVIRONMENTS) {
      // Only the environments this bed can actually reach: a zero rate means
      // no candidate ever resolves a size there, and demanding a range for
      // ground the bed refuses would be asking for a number with no meaning.
      if (cfg.envDensity[env] === 0) continue
      const span = cfg.sizeByEnv?.[env]
      if (!span || !(span[0] > 0) || !(span[1] > span[0])) {
        throw new Error(`RockBed ${cfg.name}: sizeByEnv.${env} must be an ascending range in metres`)
      }
    }

    // THE BOULDER'S LADDER SIZE AT SCALE 1. A rock's live size is this times its
    // own uniform scale, which is one multiply in the per-frame loop and saves
    // carrying a second per-instance array beside `instScale`. See rockLodSize for
    // why it is neither the width nor the height.
    this.shapeLod = rockLodSize(this.shape.measured)

    // The same trick again for the interior test: the bounding cylinder as
    // FRACTIONS of the ladder size, so `update` gets both back for one multiply
    // by the size it already has. `insideLow` is the slack, and it hangs below
    // the bed face as well as above the crown -- a rock is sunk into the ground
    // and the eye can be under its lowest drawn vertex and still inside it.
    const m = this.shape.measured
    this.insideRise = m.height / this.shapeLod
    this.insideLow = this.insideRise * INSIDE_PAD
    this.insideRadius = ((Math.max(m.width, m.depth) * 0.5) / this.shapeLod) * (1 + INSIDE_PAD)

    // THE BIGGEST ROCK THIS BED CAN PLACE, and through it the distance past which
    // no instance of it can still be on a mesh tier. `update` uses that to skip
    // whole tiles instead of walking them rock by rock -- everything out there is
    // on the card, so one `_demote` says it for the tile.
    //
    // A bound and not an average on purpose: a tile with one 10 m block in it must
    // not be demoted because the bed's typical rock is 2 m.
    //
    // `_fadeFloor` needs the same bound as a FUNCTION of the size roll and not
    // just at its top, so it is built here as the line `lodP + roll * lodQ`.
    //
    // `maxLod` is NOT that line's value at roll 1: a bed's range top is a hard
    // ceiling on the placed rock's LONGEST AXIS (see where the scale is resolved),
    // so the biggest rock the bed can place is `hi` itself whatever the boulder's
    // proportions are. The line stays the width-derived one and so stays an
    // over-estimate, which is the direction `_fadeFloor` requires.
    const lodPerWidth = this.shapeLod / this.shape.measured.width
    const envs = ENVIRONMENTS.filter((e) => cfg.envDensity[e] > 0)
    const lo = Math.max(...envs.map((e) => cfg.sizeByEnv[e][0]))
    const hi = Math.max(...envs.map((e) => cfg.sizeByEnv[e][1]))
    // Taking the max of the ends separately is an UPPER bound on the max of the
    // per-environment lines, which is what a bound has to be: each line is
    // (1-r)*lo_e + r*hi_e <= (1-r)*max(lo) + r*max(hi).
    this.lodP = lo * lodPerWidth
    this.lodQ = (hi - lo) * lodPerWidth
    const maxLod = hi
    const maxCardAt = maxLod * ROCK_LOD_AT[ROCK_LOD_AT.length - 1]
    this.nearSq = (maxCardAt + tile * 1.5) ** 2

    // A BED MAY NOT END BEFORE ITS OWN LADDER DOES. `_rankOf` guarantees no rock
    // is thinned away while it is still a mesh, but it cannot help one that runs
    // out of BED first: past `radius` the tiles are not resident at all, so a bed
    // whose reach is shorter than its biggest rock's card distance culls that rock
    // outright, mid-ladder. The two numbers are authored independently -- `radius`
    // by how far the feature reads across a valley, the card distance by
    // `sizeByEnv` times ROCK_LOD_AT -- so nothing but this stops them drifting
    // apart, and it has caught a real one: a bed with 10 m rocks wanting 250 m of
    // reach against a 170 m radius killed one rock in six as an LOD2 mesh at the
    // bed edge.
    //
    // `cardGoneAt` is the figure `_fadeFloor` works to, for the same reason: the
    // card is meant to be whole for a `ROCK_CARD_LIFE` band past the distance it
    // takes over at, and the dissolve at `radius` STARTS at 0.85 of it. A reach of
    // exactly the card distance has the biggest rocks dithering while they are
    // still meshes; a reach of the card distance times the band has them dithering
    // the instant they card, which measured at 60% of that same bed.
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
    // Whether this bed's rocks DISPLACE other props -- see Rocks.blockTopAt.
    // Defaulted rather than required, because "does not displace" is the honest
    // default here in a way "not an anchor" was not: a bed left out of the query
    // costs a few props standing in stone, where a bed left out of `anchorsInto`
    // silently empties a whole caller.
    this.blocks = cfg.blocks ?? false
    // The stone the query casts against, null on a bed nobody asks. See blockHull.
    this.hull = this.blocks ? blockHull(this.shape) : null
    // THE 3x3 TILE BLOCK IS ONLY ENOUGH WHILE A ROCK FITS IN ONE TILE. blockTopAt
    // looks at the queried tile and its eight neighbours, which catches every rock
    // whose ORIGIN is within one tile of the point -- so a rock reaching further
    // than `tile` from its own origin could cover a prop from two tiles away and
    // never be asked about. The reach is the hull radius at the bed's top scale,
    // and the origin it is measured from is the bottom of the shape rather than
    // its middle, so this is a good deal more than half a box: 0.62 m per metre of
    // ladder size on the shipping boulder against the 0.5 a box would suggest.
    const reach = maxLod * (this.hull ? this.hull.radius / this.shapeLod : 0)
    if (this.blocks && tile < reach) {
      throw new Error(
        `RockBed ${cfg.name}: tile ${tile} m is under the ${reach.toFixed(1)} m its biggest ` +
          `rock reaches from its own origin, so blockTopAt's 3x3 tile block would miss ` +
          `rocks that cover a prop. Widen \`tile\`, shrink the top size, or drop \`blocks\`.`
      )
    }
    // WHAT THE BOULDER COVERS OF THE GROUND, at instance scale 1, for
    // Rocks.anchorsInto, which multiplies by the instance's own scale and hands the
    // result out. Measured here rather than at query time because it is a scan of
    // the shape's triangles (sectionRadius), and it must be the constructor for a
    // second reason -- Rocks disposes the bank's geometries the moment the beds are
    // built.
    //
    // ONLY AN ANCHOR BED IS MEASURED, since sectionRadius throws rather than
    // reporting a footprint of zero, so scanning a bed nobody can query is a
    // boot-time abort of the world on its behalf. `footRadius` stays null on those
    // beds rather than zeroed: a bed asked anyway should fail where it is asked
    // instead of answering that its rocks cover no ground.
    //
    // THREE THINGS ARE APPROXIMATED IN THIS NUMBER, not one, and §25 has the
    // measurements. BURIAL uses one representative `frac` per bed (0.45 varying,
    // 0.24 not) where the real value is per instance and runs deeper on steep
    // ground. TILT is the one that opens a real gap: the section is cut in the
    // geometry's own frame and _growTile then leans the rock downhill about the
    // same origin, carrying the footprint some 23 cm off the reported anchor on
    // 40 degree ground. TIER scans `tiers[0]` while a coarser solid is drawn past
    // the outer band edge, and bites only past 130 m / 300 m.
    //
    // IF ANY OF IT EVER SHOWS AS MUSHROOMS STANDING IN STONE, the fix is a
    // per-instance section rather than a bigger constant: instSink and instScale
    // are already here and the lean is one _groundTilt away, so what is missing is
    // only the quarter turn's effect on the shape's height profile.
    this.footRadius = null
    if (cfg.anchor) {
      const midSink = cfg.sinkVary ? (SINK_MIN + SINK_DEEP) / 2 : SINK_MIN + SINK_SLOPE / 2
      this.footRadius = sectionRadius(this.shape.tiers[0], this.shape.measured.height * midSink, 'boulder')
    }

    this.maxInstances = this._poolBound()

    // FOUR GEOMETRIES IN THE ARENA, whatever the bed: three mesh tiers and a
    // card, copied out of the one bank. Every bed pays for its own copy because
    // every bed is its own BatchedMesh.
    const geos = this.shape.tiers
    this.batch = new THREE.BatchedMesh(
      this.maxInstances,
      geos.reduce((n, g) => n + g.attributes.position.count, 0),
      geos.reduce((n, g) => n + g.index.count, 0),
      material
    )
    this.batch.name = `v2-rocks-${cfg.name}`
    this.batch.frustumCulled = false
    this.batch.sortObjects = false

    // THE TIER TABLE, one arena id and one triangle count per band. The last slot
    // is the 2-triangle card and NO BED DECLINES IT.
    //
    // WHAT THAT COSTS is that a card is a flat photograph and a rock bedded deep
    // into a face has most of itself underground, so the quad stands taller than
    // the visible part of the mesh it replaces. That is a poke-out of a fraction of
    // a metre at a range where the rock is a few pixels tall, and it is the price
    // of one ladder rather than six.
    this.tierIds = new Int32Array(ROCK_BAND_COUNT)
    this.tierTris = new Int32Array(ROCK_BAND_COUNT)
    for (let t = 0; t < ROCK_BAND_COUNT; t++) {
      this.tierIds[t] = this.batch.addGeometry(geos[t])
      // A mesh tier carries userData.rock, a card carries userData.impostor, and
      // both carry `triangles`. Read whichever is there and throw on neither: a
      // tier that is a third kind of thing is a bug, and a silent 0 here would
      // show up as a triangle budget that quietly stops counting.
      const u = geos[t].userData
      const meta = u.rock || u.impostor
      if (!meta) throw new Error(`RockBed ${cfg.name}: tier ${t} is neither mesh nor card`)
      this.tierTris[t] = meta.triangles
    }

    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[0])
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
      envRoll: new Float32Array(per),
      yaw: new Float32Array(per), scaleRoll: new Float32Array(per),
      tone: new Float32Array(per), warm: new Float32Array(per),
      tintRoll: new Float32Array(per),
      sinkRoll: new Float32Array(per), rollRoll: new Float32Array(per),
      leanDir: new Float32Array(per), leanMag: new Float32Array(per),
    }
    this._order = []

    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null

    this._m = new THREE.Matrix4()
    // Its own scratch and not `_m`: blockTopAt is called from the middle of
    // ANOTHER scatter's placement loop, and sharing would have a tree query
    // scribble over the matrix a rock was half-composed into.
    this._blockM = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._yawQ = new THREE.Quaternion()
    this._tiltQ = new THREE.Quaternion()
    this._rollQ = new THREE.Quaternion()
    this._rollXQ = new THREE.Quaternion()
    this._leanQ = new THREE.Quaternion()
    this._leanAxis = new THREE.Vector3()
    this._xAxis = new THREE.Vector3(1, 0, 0)
    this._zAxis = new THREE.Vector3(0, 0, 1)
    this._s = new THREE.Vector3()
    this._c = new THREE.Color()
    this._n = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    this._sweep = 0
    // The chunk mesher writes three floats here per placed rock; see GROUND_CUE.
    this._gc = new Float32Array(3)

    this.tris = 0
    // The one instance in this bed the eye is closest to being inside of, in
    // ladder sizes, or -1. Rewritten every `update`; read by RockShell.sync.
    this.insideId = -1
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.regrounds = 0
    this.sited = { foot: 0, brow: 0 }
    this.rejected = { elev: 0, slope: 0, water: 0, env: 0, clump: 0, foot: 0, gap: 0 }
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
   * environment and this is wanted in pass one, before the field sample that
   * decides it. It takes the widest size range over every environment the bed can
   * reach, so it over-states a candidate that lands in a small-rock environment
   * and never under-states one: over-stating keeps a few rocks slightly too long,
   * under-stating would cull one before it ever cards.
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
   * FOUR FIELD SAMPLES, and they are the reason a bed has to ASK for this: two on
   * the fall line (forward differences against the `h` the caller already has, not
   * central ones -- half the cost, and the direction is all that is wanted) and two
   * on the probe. Paid only by the scree and boulders beds, and only on candidates
   * that have already survived elevation and slope.
   *
   * Off the FIELD rather than the drawn mesh, for _groundTilt's reason: the drawn
   * surface re-splits as the player moves, and a pile that appeared and vanished as
   * the terrain LOD moved would be far worse than one misjudging a bench.
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
    this.insideId = -1
    let insideBest = Infinity
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
          tris += this.tierTris[coarse]
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

        // The thresholds are per rock, not per bed: a 12 m tor and a 0.4 m
        // cobble read the same ladder, and the tor holds its finest mesh out to
        // 48 m where the cobble is already on the card at 5. All that separates
        // them is the size they are measured in -- `shapeLod` at scale 1, times
        // the scale this instance was placed at.
        const size = this.shapeLod * this.instScale[i]
        const sizeSq = size * size

        // IS THE EYE INSIDE THIS ONE? The same three offsets, read against the
        // instance's own bounding cylinder. The height test is first because it
        // is the cheapest and it rejects nearly everything: the whole bed is at
        // the player's feet or over their head.
        //
        // The CLOSEST candidate wins rather than the first, because rocks
        // interpenetrate -- there is one shell per bed, and the rock you are
        // least far into is the one whose interior you are looking at.
        if (ey <= size * this.insideLow && ey >= -size * (this.insideRise + this.insideLow) && d2 < insideBest) {
          const rh = size * this.insideRadius
          if (ex * ex + ez * ez < rh * rh) {
            insideBest = d2
            this.insideId = i
          }
        }

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
          this.batch.setGeometryIdAt(i, this.tierIds[tier])
          // `cur < 0` is an instance that has never been tiered -- there is no
          // departing mesh to hold, so there is nothing to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, now)
        }
        tris += this.tierTris[tier]
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
        continue
      }

      // A SURVIVING TILE IS THINNED HERE AND NOT THROUGH THE QUEUE. See
      // Ferns._reseat for the whole of it; the short form is that the queue is
      // rebuilt below with the MISSING tiles only, so a tile that survives a
      // jump keeps the level it was grown at until the tile loop pushes a thin
      // job on a LATER frame -- and a camera that keeps jumping strands another
      // near-field tile in the far field each time. `embedded` is the bed it
      // reaches first: its stale worst case is its whole pool.
      //
      // On the tile loop's own two-level dead band, so a tile sitting on a level
      // boundary is not cut and regrown by one step across a tile line.
      const nx = Math.max(t.tx * tile, Math.min(cx, (t.tx + 1) * tile))
      const nz = Math.max(t.tz * tile, Math.min(cz, (t.tz + 1) * tile))
      const q = this._levelFor((nx - cx) ** 2 + (nz - cz) ** 2)
      if (q >= t.q + 2) this._growTile({ key, tx: t.tx, tz: t.tz, q })
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
      const envRoll = rand()
      const yaw = rand() * Math.PI * 2
      // Drawn here and RESOLVED against the environment in pass two, which keeps
      // the stream fixed while still letting the size depend on where the rock
      // turned out to be.
      const scaleRoll = rand()
      const tone = rand()
      const warm = rand()
      // Which palette it indexes depends on where the rock lands; the draw
      // itself must not.
      const tintRoll = rand()
      // How deep this one is bedded, within the range its bed allows. See
      // SINK_DEEP: meaningless on a bed that has no `sinkVary`. Bent by the size
      // roll in pass two, which is where the two are both known.
      const sinkRoll = rand()
      // Which of the 16 quarter-turn orientations it is lying in, and the random
      // lean on top of the ground alignment: a bearing and a magnitude. See
      // ROLL_STEPS and TILT_JITTER. Drawn here with everything else so the field
      // stays a pure function of position -- a bed that turns none of this on
      // still burns the draws, exactly as it does for `sinkRoll`.
      const rollRoll = rand()
      const leanDir = rand()
      const leanMag = rand()
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
      c.envRoll[m] = envRoll
      c.yaw[m] = yaw
      c.scaleRoll[m] = scaleRoll
      c.tone[m] = tone
      c.warm[m] = warm
      c.tintRoll[m] = tintRoll
      c.sinkRoll[m] = sinkRoll
      c.rollRoll[m] = rollRoll
      c.leanDir[m] = leanDir
      c.leanMag[m] = leanMag
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
      const envRoll = c.envRoll[k]
      const yaw = c.yaw[k]
      const scaleRoll = c.scaleRoll[k]
      const tone = c.tone[k]
      const warm = c.warm[k]
      const tintRoll = c.tintRoll[k]
      const sinkRoll = c.sinkRoll[k]
      const rollRoll = c.rollRoll[k]
      const leanDir = c.leanDir[k]
      const leanMag = c.leanMag[k]
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
      // Wanted by two different beds for two different things: scree rejects on
      // it (`clumpFloor`, the drifts) and the boulders bed only multiplies its
      // foot density by it (`footDense`). A bed that wants neither never hashes.
      const clump = cfg.clumpFloor > 0 || this.footDense ? this._clump(x, z) : 0
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
      // Probed only on a bed that asked -- scree and boulders -- so everywhere
      // else the four field samples are never taken. See _relief.
      //
      // A `footOnly` bed is not a bed that PREFERS feet, it is one that has no
      // business anywhere else. Held after the clump floor above because that one
      // is free and this one is not.
      // `sited` counts what the probe SAW, not what was placed, which is why it is
      // incremented before the reject: it is the only readout of the landform this
      // file has, and a brow the bed then throws away is still a brow.
      const site = this.probesRelief ? this._relief(x, z, h) : null
      if (site !== null) this.sited[site]++
      if (this.footOnly && site !== 'foot') {
        this.rejected.foot++
        continue
      }

      // How MUCH stone this environment has lying about, as opposed to which
      // kind. See BEDS: without this a bed is equally dense everywhere.
      //
      // A FOOT SITE RUNS DENSER, and unevenly. Scree does not lie in a band of
      // constant density along the base of a cliff, it lies in piles with bare
      // ground between them, and the clump field is the difference -- see _clump.
      const dens = site === 'foot'
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
      const s = this.shape

      // THE SCALE, RESOLVED: a range in METRES for this environment, divided back
      // through the boulder's measured WIDTH -- not its authored `size`, which is a
      // parameter to the generator rather than a promise about the result.
      //
      // `sizeBias` bends the roll before the range reads it. Under 1 it weights the
      // range towards its top, the only way to ask for "more big ones" without also
      // throwing the small ones away as widening the range would; over 1 it weights
      // it small, which is how a bed affords a rare 15 m landmark.
      const sizeRoll = this.sizeBias === 1 ? scaleRoll : Math.pow(scaleRoll, this.sizeBias)
      const metres = cfg.sizeByEnv[env]
      if (!metres) throw new Error(`RockBed ${cfg.name}: sizeByEnv has no entry for ${env}`)
      // AND THE TOP OF THE RANGE IS A CEILING ON EVERY AXIS, not just on the one it
      // divides through. The boulder is deeper than it is wide, so the width
      // division alone comes out over the range's top -- and that number is not
      // cosmetic: `maxLod` and through it the bed's whole LOD reach are derived from
      // the range's top, so a rock over it is a rock whose card distance the bed's
      // own `radius` was never sized for. Clamping here rather than widening the
      // reach keeps "half a metre to ten" true of the ROCK rather than of one of its
      // three extents, and makes the bound seed-independent.
      const scale = Math.min(
        (metres[0] + sizeRoll * (metres[1] - metres[0])) / s.measured.width,
        metres[1] / this.shapeLod
      )

      // THE QUARTER TURNS, WHICH DECIDE WHICH WAY IS UP BEFORE ANYTHING ELSE DOES.
      // One roll picks a whole number of right angles about x and then about z --
      // see ROLL_STEPS for why the increment is 90 and not a free angle. The x turn
      // is applied first in the rock's own frame, so `rollQ = qz * qx`. Held here,
      // ahead of the dart, because what the dart measures is the FOOTPRINT and
      // turning the rock changes it.
      const ri = Math.min(ROLL_STEPS * ROLL_STEPS - 1, (rollRoll * ROLL_STEPS * ROLL_STEPS) | 0)
      const q = this._rollQ.setFromAxisAngle(this._zAxis, ((ri / ROLL_STEPS) | 0) * (Math.PI / 2))
      q.multiply(this._rollXQ.setFromAxisAngle(this._xAxis, (ri % ROLL_STEPS) * (Math.PI / 2)))
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w
      const m00 = 1 - 2 * (qy * qy + qz * qz)
      const m01 = 2 * (qx * qy - qw * qz)
      const m02 = 2 * (qx * qz + qw * qy)
      const m10 = 2 * (qx * qy + qw * qz)
      const m11 = 1 - 2 * (qx * qx + qz * qz)
      const m12 = 2 * (qy * qz - qw * qx)
      const m20 = 2 * (qx * qz - qw * qy)
      const m21 = 2 * (qy * qz + qw * qx)
      const m22 = 1 - 2 * (qx * qx + qy * qy)

      // THE ROLLED BOX, EXACTLY. rock.js puts the origin ON the bed face, so the
      // unturned rock spans y in [0, height] and x and z about zero -- and a
      // quarter turn maps each local axis onto a world one, so the box stays a box
      // and one term per row survives. `stand` is what the rock now presents
      // vertically (its DEPTH once it is on its side, not its height) and `yMin` is
      // how far it now hangs below its own origin; both are needed to seat it.
      const bw = s.measured.width * scale
      const bh = s.measured.height * scale
      const bd = s.measured.depth * scale
      const yMax = Math.abs(m10) * bw * 0.5 + Math.max(0, m11) * bh + Math.abs(m12) * bd * 0.5
      const yMin = -Math.abs(m10) * bw * 0.5 + Math.min(0, m11) * bh - Math.abs(m12) * bd * 0.5
      const stand = yMax - yMin
      // How much GROUND this rock covers, which is what the dart and every caller
      // of `anchorsInto` are asking about. The LOD thresholds in `update` want a
      // different number and take it from `rockLodSize`, which is the longest axis
      // and so does not care how the rock was turned.
      const planX = Math.abs(m00) * bw + Math.abs(m01) * bh + Math.abs(m02) * bd
      const planZ = Math.abs(m20) * bw + Math.abs(m21) * bh + Math.abs(m22) * bd
      const span = Math.max(planX, planZ)

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
          const need = this.minGap * 0.5 * (span + this.instSpan[o])
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

      // Bedded by a fraction of what it stands, which is why `measured` is on the
      // shape at all: a 7 m lip and an 11 cm pebble both want to be a tenth of
      // themselves into the ground, not a tenth of a metre. The slope term is a
      // FLOOR, not the answer -- steeper ground needs a rock bedded deeper or its
      // downhill side hangs in the air -- and `sinkVary` beds reroll upward from it
      // to the top of `sinkRange`, so a flat-ground rock spans nearly the whole
      // band while one at the bed's slope limit cannot come out shallower than the
      // floor.
      //
      // AND THE BIG ONES SINK DEEPER, by bending the roll rather than the range:
      // see SINK_SIZE_TILT. Bending the roll is what keeps the ends honest -- a
      // small rock can still be buried to the top of the band and a big one can
      // still be sitting on the surface, only the odds move.
      // See SINK_TALL: which floor the slope term is added to depends on what the
      // quarter turn stood this instance on.
      const base = stand > TALL_AT * 0.5 * (planX + planZ) ? SINK_TALL : SINK_MIN
      const floor = Math.max(this.sinkLo, base + SINK_SLOPE * Math.min(1, tan / this.maxSlopeTan))
      const deepRoll = Math.pow(sinkRoll, 1 - SINK_SIZE_TILT * sizeRoll)
      const frac = cfg.sinkVary
        ? floor + deepRoll * Math.max(0, this.sinkHi - floor)
        : Math.min(floor, this.sinkHi)
      let sink = stand * frac
      // INTO THE FACE, NOT DOWN THE FACE. See SINK_NORMAL_MAX: `frac` is a
      // fraction along the surface normal and `instY` can only move a rock along
      // world Y, so a bed that means to bury something in a cliff has to pay the
      // 1/cos(slope) between them.
      if (this.sinkNormal) sink *= Math.min(SINK_NORMAL_MAX, Math.hypot(tan, 1))
      // AND WHATEVER THOSE TERMS ADD UP TO, THE ROCK STAYS VISIBLE. The normal
      // correction is a multiply of up to three on a fraction that was already near
      // the embedded bed's ceiling, so on a face it can bury a rock whole. A rock
      // nobody can see is one that was built, skinned and submitted for nothing.
      // See SINK_CAP.
      sink = Math.min(sink, stand * SINK_CAP)
      this.instX[id] = x
      this.instZ[id] = z
      // `yMin` folded in, so `instSink` stays the ONE number `_reground` needs: how
      // far the origin sits under the drawn ground. It goes negative for a rolled
      // rock that hangs below its own origin by more than it is buried, which is
      // correct rather than a guard to add -- the origin belongs above ground there.
      this.instSink[id] = sink + yMin
      this.instScale[id] = scale
      this.instSpan[id] = span
      this.instY[id] = this._groundFor(x, z) - this.instSink[id]

      this._yawQ.setFromAxisAngle(this._up, yaw)
      // Roll first in the rock's own frame, then yaw about the vertical, then the
      // ground lean, then the random lean on top of it -- so a tilted rock spins
      // about the ground's normal rather than about world Y and the jitter is a
      // departure from the hill rather than a second alignment to it.
      this._yawQ.multiply(this._rollQ)
      if (cfg.tilt > 0) this._q.copy(this._groundTilt(x, z, cfg.tilt)).multiply(this._yawQ)
      else this._q.copy(this._yawQ)
      // PRE-multiplied, so the axis is horizontal IN THE WORLD. Composed the other
      // way the axis would be horizontal in the ROCK's frame, and a rock the roll
      // has laid on its side would take its "lean" about a near-vertical axis --
      // which is a second yaw, not a lean, on exactly the instances that most need
      // one.
      const a = leanDir * Math.PI * 2
      this._leanAxis.set(Math.cos(a), 0, Math.sin(a))
      this._q.premultiply(this._leanQ.setFromAxisAngle(this._leanAxis, leanMag * TILT_JITTER))
      this._p.set(x, this.instY[id], z)
      this._s.set(scale, scale, scale)
      this.batch.setMatrixAt(id, this._m.compose(this._p, this._q, this._s))

      // A TINT PER INSTANCE, ROLLED FROM THE ENVIRONMENT'S PALETTE. With one mesh
      // in the world this is most of what keeps a scree slope from being one grey
      // and a wood one green -- the eye finds a repeated colour faster than a
      // repeated silhouette. ENV_TINTS carries a list per environment and weights by
      // repetition, so common stone stays common.
      //
      // THE VALUES GO ABOVE 1.0 ON PURPOSE. stone.png is a real photograph of
      // granite -- warm, and dark at a mean luma of 88/255 -- so every palette
      // entry is a gain that brightens and white-balances it rather than a multiply
      // that darkens it further (see TINT_GAIN). BatchedMesh's colour texture is
      // FLOAT, so > 1 is storable and does what it says.
      const pal = ENV_TINTS[env]
      const gain = TINT_GAIN[pal[Math.min(pal.length - 1, (tintRoll * pal.length) | 0)]]

      // AND THEN PULLED PART OF THE WAY TOWARD THE GROUND IT IS STANDING ON.
      // The terrain's own vertex colour here, from the chunk mesher's own
      // `shade`, so the cue cannot drift away from what the ground is actually
      // painted -- render/ferns.js takes a fern's the same way and for the same
      // reason. `flattenAt` unconditionally rather than ferns' road-gated call:
      // this file has no path index to gate on, and one lookup sits next to the
      // four _groundTilt is about to take anyway.
      shade(h, 1 / Math.hypot(tan, 1), snowLine, snowBand, this.layers.flattenAt(x, z),
        altLo, altSpan, x, z, gc, 0)
      // Taken at FULL MAGNITUDE, so the cue carries lightness and not just hue --
      // see GROUND_CUE for why the old renormalisation went and what the change
      // costs in brightness.
      const cue = GROUND_CUE[env]
      const k1 = cue
      const k0 = 1 - cue

      // Jitter on top, so two rocks of the same tint standing together still
      // differ. Centred slightly under 1 and running slightly over. It no longer
      // leaves every instance brighter than the bare tile and is not meant to: a
      // rock on dark forest loam now lands NEAR the loam, which is the whole of
      // what the lightness match buys. What the floor of 0.86 still guarantees is
      // separation from the ground rather than dominance of it -- the cue tops out
      // at 0.75, so a rock keeps at least a quarter of its own palette everywhere.
      const v = 0.86 + tone * 0.3
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
      this.batch.setGeometryIdAt(id, this.tierIds[ROCK_BAND_COUNT - 1])

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
  _crossFade(i, oldTier, now) {
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
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier])
    this.batch.setVisibleAt(dup, true)
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier]
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
      this.batch.setGeometryIdAt(i, this.tierIds[coarse])
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
        out[o + 3] = this.footRadius * this.instScale[id]
        w++
      }
    }
    return w
  }

  /**
   * One bed's share of Rocks.blockTopAt: the highest rock top over (x, z), or
   * `best` unchanged if this bed has nothing there. The public half carries the
   * argument for what a caller does with it.
   *
   * KEYED, NOT SWEPT, and that is the difference between this and _anchorsInto.
   * An anchor query runs once per tile of some other scatter and can afford to
   * reject a bed's whole resident set four compares at a time; this one runs once
   * per PROP CANDIDATE, and the giants bed is 1250 m of resident tiles. So it goes
   * straight at the 3x3 block around the point, using _plan's key arithmetic
   * verbatim -- the constructor's `blocks` check is what guarantees nine tiles are
   * enough.
   */
  _blockAt(x, z, minSize, best) {
    const tile = this.tile
    const gx = Math.floor(x / tile)
    const gz = Math.floor(z / tile)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const t = this.tiles.get((gx + dx) * 0x10000 + (gz + dz))
        if (!t) continue
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const size = this.shapeLod * this.instScale[id]
          if (size < minSize) continue
          // The cylinder the shape cannot reach out of, and it is a REJECT and
          // nothing else: it exists to keep the ray walk off the thirty-odd
          // instances a query steps over, so it is deliberately generous and
          // everything it lets through is settled behind it. NOT `instSpan`, which
          // is a box width about an origin the box is not centred on -- see
          // blockHull.
          const r = this.hull.radius * this.instScale[id]
          const ex = x - this.instX[id]
          const ez = z - this.instZ[id]
          if (ex * ex + ez * ez >= r * r) continue
          const top = this._surfaceAt(id, ex, ez)
          // Inside the circle and over no stone -- a corner of the box, or the
          // gap beside a rock the query is standing next to rather than on. The
          // prop belongs on the ground there, which is what saying nothing gets
          // it.
          if (top === -Infinity) continue
          // Settled here rather than in the public half because this is where the
          // rock's own size and its own ground are: the caller gets a Y to STAND
          // at, not a surface to sit on, and comparing after the settle is
          // deliberate too -- the answer wanted is the highest place to stand, not
          // the highest stone. It never goes past the ground, because a rock bedded
          // to SINK_CAP stands centimetres proud and a flat 35 cm would put the prop
          // under the terrain it was lifted off; and never below zero, because a
          // point over a rock's buried flank comes back under the ground already.
          const ground = this.instY[id] + this.instSink[id]
          const settle = Math.min(BLOCK_SETTLE_MAX, BLOCK_SETTLE * size,
            Math.max(0, (top - ground) * 0.5))
          const stand = top - settle
          if (stand > best) best = stand
        }
      }
    }
    return best
  }

  /**
   * The world height of the highest stone directly over an instance-relative
   * (ex, ez), or -Infinity if the vertical line through that point misses the
   * rock entirely. The one place the shape's actual surface is consulted.
   *
   * WHY A RAY AND NOT A BOX. The rolled box's top is a plane, and a plane over a
   * two-metre footprint is a table: props seated on it stand half a metre above a
   * boulder's shoulder in mid air, and props at the corners of the box stand on
   * nothing at all. The turned box top runs 25 cm above the real surface on
   * average and 78 cm at worst on a 1.16 m rock, and a quarter of the disc it
   * claims is not stone. So the query asks the triangles.
   *
   * IT IS AFFORDABLE BECAUSE OF WHAT IS IN FRONT OF IT. A blockTopAt call steps
   * over 36 instances in the wood and 154 on a ridge; the size gate and the
   * circumscribed circle leave 0.04 of them per call, 0.24 in the worst world, so
   * a 1.5 us walk over 320 triangles costs 60 ns on a 550 ns call there and 360 ns
   * on a 2 us one here. The tile walk is the query's cost and always was.
   *
   * THE RAY IS A LINE, NOT A HALF-LINE. It starts at the instance origin, which
   * sits at the BOTTOM of the shape's box, so the hits that matter are behind it
   * and the nearest signed `t` is the topmost surface. The basis columns are
   * orthogonal and `s` long, so the transpose over s^2 inverts the matrix and the
   * local direction that falls out is unit -- which puts `t` in the rock's own
   * metres and the world drop at `t * s`. The quarter turn, the ground lean and
   * the jitter all ride in those columns, so none of them needs recovering from
   * the placement arrays.
   */
  _surfaceAt(id, ex, ez) {
    this.batch.getMatrixAt(id, this._blockM)
    const e = this._blockM.elements
    const s = this.instScale[id]
    const inv = 1 / (s * s)
    const ox = (e[0] * ex + e[2] * ez) * inv
    const oy = (e[4] * ex + e[6] * ez) * inv
    const oz = (e[8] * ex + e[10] * ez) * inv
    const dx = -e[1] / s
    const dy = -e[5] / s
    const dz = -e[9] / s
    // The shape's own box, first, because the cylinder in front of this is a loose
    // reject and walking 320 triangles is an expensive way to answer a question six
    // planes settle. Slabs in the rock's frame, where the box is axis-aligned:
    // [-w/2, w/2] x [0, h] x [-d/2, d/2], the origin on the bottom face.
    const mm = this.shape.measured
    let tLo = -Infinity
    let tHi = Infinity
    if (dx > -1e-12 && dx < 1e-12) {
      if (ox < -mm.width * 0.5 || ox > mm.width * 0.5) return -Infinity
    } else {
      const a = (-mm.width * 0.5 - ox) / dx
      const b = (mm.width * 0.5 - ox) / dx
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (dy > -1e-12 && dy < 1e-12) {
      if (oy < 0 || oy > mm.height) return -Infinity
    } else {
      const a = (0 - oy) / dy
      const b = (mm.height - oy) / dy
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (dz > -1e-12 && dz < 1e-12) {
      if (oz < -mm.depth * 0.5 || oz > mm.depth * 0.5) return -Infinity
    } else {
      const a = (-mm.depth * 0.5 - oz) / dz
      const b = (mm.depth * 0.5 - oz) / dz
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (tLo > tHi) return -Infinity
    const hull = this.hull.tri
    let near = Infinity
    // Moller-Trumbore, two-sided: on a closed shape the nearest hit is a front
    // face anyway, and the cull test would only buy a branch.
    for (let f = 0; f < hull.length; f += 9) {
      const e1x = hull[f + 3], e1y = hull[f + 4], e1z = hull[f + 5]
      const e2x = hull[f + 6], e2y = hull[f + 7], e2z = hull[f + 8]
      const hx = dy * e2z - dz * e2y
      const hy = dz * e2x - dx * e2z
      const hz = dx * e2y - dy * e2x
      const det = e1x * hx + e1y * hy + e1z * hz
      if (det > -1e-12 && det < 1e-12) continue
      const invDet = 1 / det
      const sx = ox - hull[f]
      const sy = oy - hull[f + 1]
      const sz = oz - hull[f + 2]
      const u = (sx * hx + sy * hy + sz * hz) * invDet
      if (u < 0 || u > 1) continue
      const qx = sy * e1z - sz * e1y
      const qy = sz * e1x - sx * e1z
      const qz = sx * e1y - sy * e1x
      const v = (dx * qx + dy * qy + dz * qz) * invDet
      if (v < 0 || u + v > 1) continue
      const t = (e2x * qx + e2y * qy + e2z * qz) * invDet
      if (t < near) near = t
    }
    return near === Infinity ? -Infinity : e[13] - near * s
  }

  /**
   * The cursor's pick volume for one instance, in world metres: the boulder's
   * footprint and its height, both at this instance's own scale.
   *
   * A constant pair cannot do this job even with one shape, because `instScale`
   * spreads it fifty-fold across the beds: the same radius/rise is metres of empty
   * air around an underfoot pebble and a volume stopping well below the top of a
   * 15 m giant -- and a cursor that stops below the top of a rock reads as pointing
   * straight through it.
   *
   * `max(width, depth)` and not the mean: the cylinder has one radius and it has
   * to hold the rock at every bearing, so it takes the widest. Half of it,
   * because `measured` is a full span and this is a radius.
   */
  pickSizeAt(id, out) {
    const scale = this.instScale[id]
    const m = this.shape.measured
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
 * The inside of the one rock the camera is in, drawn back faces only.
 *
 * WHAT IT IS FOR: the beds cull back faces (see Rocks' material), which is right
 * for a closed solid seen from outside and wrong the moment the eye is inside
 * one -- nothing collides with a boulder, so the player walks into them, and a
 * culled interior is a hole straight out into the world. This puts the missing
 * half back for that one rock, on a material of its own.
 *
 * BackSide AND NOT DoubleSide. The bed is already drawing the front faces; this
 * adds only what is missing, so the pair comes out to a double-sided rock with no
 * coincident geometry to z-fight. It is also why a false positive is free -- a
 * shell on a rock you are merely NEAR is behind that rock's own front faces and
 * fails the depth test.
 *
 * A MATERIAL OF ITS OWN, not `side` flipped on the shared one around the draw.
 * `side` is not in three's `needsProgramChange` list, so a flip is normally just
 * a cull-state toggle -- but any program change that DID fire while the flag was
 * flipped (a lights-version bump, say) would compile FLIP_SIDED as the cached
 * program for the shared material and turn every bed inside out. Two materials
 * cost one extra program and cannot do that.
 *
 * ONE INSTANCE PER BED, tier 0 only. Every bed keeps its own nearest candidate
 * because a giant and a pebble can overlap. Tier 0 needs no choosing: the finest
 * mesh reaches out to 4 ladder sizes and a rock you are inside of is within one,
 * so anything with an interior is already wearing it.
 */
class RockShell {
  constructor(scene, material, geo, capacity) {
    this.batch = new THREE.BatchedMesh(
      capacity,
      geo.attributes.position.count,
      geo.index.count,
      material
    )
    this.batch.name = 'v2-rocks-shell'
    this.batch.frustumCulled = false
    this.batch.sortObjects = false
    this.batch.visible = false

    this.geoId = this.batch.addGeometry(geo)
    const meta = geo.userData.rock
    if (!meta) throw new Error('RockShell: tier 0 is not a mesh tier')
    this.geoTris = meta.triangles

    this.capacity = capacity
    for (let i = 0; i < capacity; i++) {
      const id = this.batch.addInstance(this.geoId)
      this.batch.setVisibleAt(id, false)
    }
    // Same reason the beds do it, one material later: give the colours texture a
    // definite existence before the first draw rather than the first placement.
    this.batch.setColorAt(0, new THREE.Color(1, 1, 1))

    this.n = 0
    this.tris = 0
    this._m = new THREE.Matrix4()
    this._c = new THREE.Color()
    scene.add(this.batch)
  }

  /**
   * Point the shell at whatever each bed decided it was inside of this frame.
   *
   * The transform and the colour are COPIED FROM THE BED INSTANCE rather than
   * recomputed, which is what keeps the shell registered with its rock for free:
   * the matrix carries the same lean and quarter turn, and the RGB carries the
   * ground cue, so the interior is tinted by the same dirt the outside is. Snow
   * and moss need no copying at all -- both are hashed from the instance root's
   * world XZ in the vertex shader, so identical transforms roll identical.
   *
   * THE FADE SLOT IS NOT COPIED and must not be: `getColorAt` reads a THREE.Color
   * and drops alpha, and a shell dithering along with a rock mid-dissolve would
   * open holes out into the world from the one viewpoint that has no front faces
   * left to close them. Solid is both the reachable answer and the right one.
   */
  sync(beds) {
    let n = 0
    for (const bed of beds) {
      const id = bed.insideId
      // A bed switched off by the quest toggle takes its interior with it,
      // rather than leaving a hollow rock hanging where the rock was.
      if (id < 0 || !bed.batch.visible) continue
      bed.batch.getMatrixAt(id, this._m)
      bed.batch.getColorAt(id, this._c)
      this.batch.setMatrixAt(n, this._m)
      this.batch.setColorAt(n, this._c)
      setPropSolidAt(this.batch, n)
      this.batch.setVisibleAt(n, true)
      n++
    }
    for (let i = n; i < this.n; i++) this.batch.setVisibleAt(i, false)
    this.n = n
    this.tris = n * this.geoTris
    // An empty shell leaves the traversal at projectObject rather than being
    // walked and rejected, so standing in open ground costs nothing at all.
    this.batch.visible = n > 0
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
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Rocks: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Rocks: needs WaterSurfaces with levelAt')
    if (!layers || typeof layers.flattenAt !== 'function' || !layers.snow) {
      throw new Error('Rocks: needs Layers with flattenAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Rocks: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    // NO SEED. `seed` is the world's and every bed below takes it, because where
    // the rocks land is world-seeded; the boulder ITSELF is art direction and is
    // pinned to the seed it was signed off at. See BOULDER.
    const bank = buildRockBank()
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
    //
    // FRONT FACES ONLY, alone among the prop materials. Every other one draws
    // cutout foliage, where both sides of a leaf are the same leaf; a rock is a
    // CLOSED SOLID whose back faces are behind its own front ones, so culling
    // them halves the raster work for nothing given up. The spun card is safe
    // for a separate reason: billboardVertex maps its object +z onto the
    // direction of the eye, so the side that is wound front is the side you are
    // on. check-rocks.mjs holds both facts -- outward winding on every tier, and
    // the card's -- because the failure is invisible from any angle that has a
    // front face to look at.
    this.material = createPropMaterial(textureArray, {
      billboardLayers: rockImpostorLayers(),
      sphericalBillboard: true,
      side: THREE.FrontSide,
      bump: true,
    })

    this.beds = BEDS.map(
      (cfg, i) => new RockBed(scene, field, water, layers, this.material, bank, cfg, i, { seed, ground })
    )

    // The same material read from the other side, for the one rock the camera is
    // standing in. See RockShell for why this is a second material and not a
    // `side` flip on the one above.
    this.shellMaterial = createPropMaterial(textureArray, {
      billboardLayers: rockImpostorLayers(),
      sphericalBillboard: true,
      side: THREE.BackSide,
      bump: true,
    })
    this.shell = new RockShell(scene, this.shellMaterial, bank.shape.tiers[0], this.beds.length)

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
    // After every bed, because each one picked its own candidate above.
    this.shell.sync(this.beds)
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
   * The height a prop landing at (x, z) should stand at if a rock is already
   * there, or `-Infinity` if the ground is clear.
   *
   * WHAT THIS IS FOR: a boulder is the only prop in the world that displaces other
   * props. A tree whose trunk lands inside one has to be raised to stand ON it, and
   * grass and litter inside one have to go entirely -- a blade of grass growing out
   * of the middle of a rock is the single most legible placement error there is,
   * because the eye reads the rock as solid and the grass as impossible. So the
   * scatters that come after the rocks ask this once per candidate:
   *
   *   grass, litter    `blockTopAt(x, z, 0) > -Infinity`  ->  drop the candidate
   *   trees, ferns     `blockTopAt(x, z, BLOCK_MIN)`      ->  stand here instead
   *
   * `minSize` IS THE WHOLE DIFFERENCE BETWEEN THE TWO RULES and it is a caller's
   * choice, not this file's. A blade of grass is displaced by any stone big enough
   * to be geometry; a tree is not raised onto a cobble, because a sapling standing
   * on a half-metre stone reads as a mistake where a sapling growing beside one
   * reads as a wood. The brief's line is a metre and the callers pass it.
   *
   * THE ANSWER IS ALREADY SETTLED INTO THE ROCK by BLOCK_SETTLE -- the caller gets
   * a Y to stand at, not a silhouette to sit on. That correction belongs here
   * because what it is paying for is the LOD ladder, which is this file's.
   *
   * IT IS THE STONE'S OWN SURFACE, not a plane over its footprint. A vertical line
   * is dropped through the finest tier's triangles (RockBed._surfaceAt), so a prop
   * over a boulder's shoulder stands on the shoulder and a prop over the corner of
   * its box -- where the circumscribed circle reaches and the rock does not -- gets
   * -Infinity and stays on the ground. What it is NOT is a containment test: the
   * answer is the highest surface over the point at any height, so a prop under an
   * overhang is raised onto the overhang rather than left beneath it. That is the
   * right answer for the case this exists for (a boulder is wider than it is tall)
   * and the wrong one for a spire, which is why the spire's bed is not flagged.
   *
   * ONLY THE BEDS FLAGGED `blocks` ANSWER; the argument is on the flags in BEDS.
   * The query is keyed rather than swept -- see RockBed._blockAt -- so it is nine
   * Map lookups per bed and it can be afforded per candidate.
   *
   * WHATEVER THE QUEST TOGGLE SAYS. The rock toggle sets `batch.visible` and the
   * beds are placed and stepped either way, so a world with the rocks switched off
   * has its trees in the same places as one with them on. See v2/main.js.
   */
  blockTopAt(x, z, minSize) {
    let top = -Infinity
    for (const bed of this.beds) {
      if (bed.blocks) top = bed._blockAt(x, z, minSize, top)
    }
    return top
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
          const size = bed.shapeLod * bed.instScale[id]
          const tier = bed.tierAt[id]
          const gone = bed.rim.gone[id]
          rows.push({
            bed: bed.cfg.name,
            d: +d.toFixed(1),
            size: +size.toFixed(2),
            tier: tier === ROCK_BAND_COUNT - 1 ? 'card' : `mesh${tier}`,
            tris: bed.tierTris[tier],
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
      // Summed for the same reason a bed exposes it: `tris` already skips the
      // rim-hidden instances, so `placed` on its own is the one number here that
      // counts stone the GPU never sees.
      rimHidden: beds.reduce((n, b) => n + b.rimHidden, 0),
      tris: beds.reduce((n, b) => n + b.tris, 0) + this.shell.tris,
      inside: this.shell.n,
      pool: beds.reduce((n, b) => n + b.pool, 0),
      used: beds.reduce((n, b) => n + b.used, 0),
      bankKB: Math.round(this.bank.bytes / 1024),
      bankTris: this.bank.triangles,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
    }
  }

  dispose() {
    for (const bed of this.beds) bed.dispose()
    this.shell.dispose()
    this.material.dispose()
    this.shellMaterial.dispose()
  }
}
