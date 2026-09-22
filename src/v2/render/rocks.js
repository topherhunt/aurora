import THREE from '../../three-instance.js'
import { QUANT, boundedRadius, levelFor, poolBound, tileOutOfBounds } from './tile-pool.js'

import { buildRockBank, ENVIRONMENTS, ENV_TINTS, ROCK_BAND_COUNT, TINT_GAIN } from '../../props/rock-bank.js'
import { ROCK_LOD_AT, ROCK_LOD_HYSTERESIS, ROCK_LOD_FAR_MAX, ROCK_LOD_GONE_MAX, rockLodSize } from '../../props/rock.js'
import {
  createPropMaterial, setSnowLine, setMossLine, setSnowVary, setMossVary, setPropSolidAt,
  setPropFadeTimerAt, getPropClock, FADE_BAND, PROP_FADE_SECONDS,
} from '../../material.js'
import { PropArena, PropMeshes } from './prop-arena.js'
import { RimFade, RIM_AT, RIM_PHASES, RIM_SLACK_MIN, tilePhase } from './rim.js'
import { shade } from '../terrain/chunk-mesh-v2.js'
import { smoothstep } from '../../sim/mathx.js'
import { ROCK_TILE_MEAN } from '../../textures.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { BiomeField } from '../layers/biome.js'
import { forestKeepAt } from '../layers/forest.js'

// ---------------------------------------------------------------------------
// The stone on the /v2 route: boulders through the wood and across the
// cliffsides, giants on the crags and the summits. The argument is DESIGN.md
// §25; this is the contract. Stone under half a metre is render/litter.js's.
//
// THE SCATTER IS render/trees.js's, deliberately -- tiled, camera-following,
// thinned by rank over quantised levels. Everything that header argues about
// tiles, ranks, incremental regrow, standing props on the DRAWN ground and
// dissolving at each instance's own cull distance holds here and is not
// repeated. What differs is THE RANK: a tree's is a random draw, so the wood
// thins at FULL_RADIUS / d; a rock's is its SIZE (`_rankOf`), so past
// `fullRadius` a tile holds exactly the rocks big enough to still be drawn at its
// distance and the pool is sized for those alone.
//
// ONE SHAPE, SIX BEDS. Every bed places the bank's one boulder mesh
// (props/rock-bank.js -- its open cap has no bed left to lay it) and everything
// below is about WHERE COPIES OF IT GO and HOW BIG. Six beds, because a rock's
// size spans two orders of magnitude and no
// single density-and-radius pair carries both ends. Each is a complete
// independent scatter with its own tile grid, density, radius, LOD bands and
// instance pool:
//
//   BOULDERS    0.5 - 10 m    medium, 600 m    the forest and cliffside rocks
//   SCREE       0.5 - 4.5 m   dense, 280 m     the pile at the foot of a face
//   SUNKEN      1 - 10 m      sparse, 600 m    stones standing on the lake floor
//   GIANTS      1.6 - 15 m    sparse, 1250 m   the landmarks
//   EMBEDDED    2 - 32 m      sparse, 1250 m   blocks let INTO a face or a bed
//   SHORE       0.5 - 2.5 m   dense, 80 m      the stones along a waterline
//
// EACH BED EXISTS BECAUSE SOMETHING IT NEEDS IS PER-BED AND CANNOT BE VARIED
// WITHIN ONE -- the only test a new bed has to pass. Scree needs the candidate
// count (`envDensity` is an accept rate capped at 1, so a saturated site cannot be
// made denser by any multiplier), and shore needs it for the same reason on a
// strip the boulders bed's `shoreGain` can only double; sunken needs
// `submergedOnly` and a size range of its own; embedded needs `sinkRange` -- 70
// to 90% under, where every other bed's burial roll tops out at 80% of the way
// there, and a rock cannot be sunk that far and also stand on the ground in the
// same bed; giants owe a 1.25 km LOD reach at a density the boulders bed could
// not afford over that disc, and `radius` and `density` are per bed.
//
// SIX BEDS, FOUR DRAW CALLS. A bed is a scatter, not a mesh: every bed places
// the same four tier geometries, so `Rocks` builds ONE PropMeshes -- one
// InstancedMesh per tier, capped at the sum of the beds' own tier bounds -- and
// each bed holds a PropArena VIEW over it with its own pool of ids. Six views
// share the four meshes as six batches would have shared one material, and
// §5's one-material rule holds as it did: one material object, one program,
// one atlas, whatever the bed.
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
// PLACED rock. On top of the ground lean every
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
// ships T320/T80/T20 and the six-triangle T6 hull, and every instance steps
// between them at `ROCK_LOD_AT` metres per metre of its OWN ladder size
// (`instLod`: its footprint or what it shows above ground, the longer): 4 to T80,
// 7.5 to T20, 25 to T6, so a 2 m rock holds sampled geometry out to 50 m, a
// cobble to 8.5, a 12 m landmark to 300, a deep-bedded slab by the slab. A
// table of metres per bed was wrong in both directions at once, because a bed is
// not one size of rock -- which is the whole reason one mesh can serve the world.
// Two ceilings sit over the ladder, in metres rather than sizes (props/rock.js):
// past ROCK_LOD_FAR_MAX every rock is T6, and no bed may reach past
// ROCK_LOD_GONE_MAX. Only the embedded bed's biggest blocks meet the first.
//
// AND NOTHING IS CULLED BEFORE IT HAS REACHED T6 -- AND STAYED WHOLE THERE FOR A
// WHILE. A rock's thinning rank IS its far distance (`_rankOf`), and
// `ROCK_FAR_LIFE` holds T6 whole for a band past it. A ROCK DISAPPEARING IS
// STILL NOT ITS LADDER RUNNING OUT -- the ladder picks the mesh at each rung of
// the size, the rank decides where past the last rung the rock is dropped.
//
// EVERY TIER IS A MESH IN THE ONE PLACEMENT MATRIX, T6 included: it is the
// rock's measured box on five vertices (rock.js), so the far swap moves nothing
// and there is no card frame to keep. §25 carries the argument.
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

// THE SMALLEST ROCK THE WORLD DRAWS AS GEOMETRY, in metres of measured width.
// Every bed's `sizeByEnv` is checked against it in the constructor.
//
// A LOOK FLOOR, though it pays as a budget one too. Under about half a metre the
// boulder stops reading as a rock: there is one shape in the bank (see
// rock-bank.js), so a stone the size of a fist is a two-metre boulder shrunk --
// the same facets, the same grain, the same sixteen quarter turns, at a size
// where the eye takes all of it in at once and catches the repeat. What the
// ground wants down there is COVER, and cover is render/litter.js's job: one
// T20 pebble at twenty triangles, in the thousands, inside a few strides. So
// geometry here starts where a rock becomes an object you walk around, and the
// litter carries everything below it.
const ROCK_MIN_SIZE = 0.5

// `field` SEEDS THE BED'S SCATTER (see `tileSeed`) and is the bed's slot in the
// table this file used to carry, not its position in this one: three beds were
// deleted from between these (pebbles underfoot, cliff slabs, bed caps -- the
// pebbles because render/litter.js lays a stone under half a metre without this
// file's ladder, band or reach, the caps because one of them was 88% of every
// millisecond this file spent, to panel a wall), and seeding by array position
// would have moved every rock in the world when they went. A new bed takes the
// next unused number and the numbers never change.
//
// THE MEASURED COST OF A BED, from scripts/probe-rock-cost.mjs on a real cliff,
// is a reason to keep this table short: the deleted `cliff slabs` walked 547,110
// candidate sites, each one a field sample, for 13,359 rocks.
const BEDS = [
  {
    name: 'boulders',
    field: 1,
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
    //
    // AND THEN HALVED AGAIN TO PAY FOR THE SIZE, from 0.0105. `sizeByEnv` below
    // starts at a metre and a half now and the median boulder is three times what
    // it was, and a rock that size at the old spacing is a boulder field rather
    // than a wood with boulders in it. The two numbers are ONE decision: the bed
    // draws about half as many rocks and each of them is worth looking at. The
    // small stone this stops laying is not lost -- render/litter.js beds it
    // underfoot, and the scree bed still runs from half a metre where the ground
    // is a talus foot.
    density: 0.0055,
    // At the effective 0.0022 a forest boulder is one per 455 m2, roughly every
    // 21 m. The ratios between the four are untouched; only the scale moved.
    envDensity: { river: 0.28, forest: 0.4, cliff: 0.4, peak: 0.32 },
    fullRadius: 95,
    // 600, UP FROM 460, AND SET BY `sizeByEnv` BELOW RATHER THAN BY TASTE. A 10 m
    // boulder holds a sampled tier out to 250 m under ROCK_LOD_AT and then owes
    // T6 a full ROCK_FAR_LIFE band, so `minReach` demands 588 m; at 460 the
    // biggest rocks in the wood would have been culled outright while still LOD2
    // meshes. Costs (600/460)^2 = 1.7x the disc and the pool with it, which is the
    // real price of the 10 m top end.
    radius: 600,
    tile: 28,
    // Peak 271 of 712 over the probe flight.
    siteFrac: 0.6,
    minElev: 0,
    maxSlopeDeg: 48,
    allowSubmerged: true,
    tilt: 0.7,
    // See SINK_DEEP: burial varies per instance.
    sinkVary: true,
    // AN ANCHOR BED, and the one a caller is really asking about: a metre and a
    // half through to ten spans everything from a block you would scramble over to
    // a rock the size of a shed, which is the whole range of stone with a damp
    // shaded base to grow anything against. See Rocks.anchorsInto.
    anchor: true,
    // AND THE BED THE WHOLE DISPLACEMENT RULE IS ABOUT: a tree that lands inside
    // one of these stands on it and a blade of grass that lands inside one is not
    // placed at all. See Rocks.blockTopAt.
    blocks: true,
    // A CRAB'S ROCK, on the shore and under the lake alike -- see Rocks.perchesInto.
    perch: true,
    // PILED AT THE FOOT OF A FACE, on top of what it strews everywhere else. The
    // scree bed makes the talus; this makes the BOULDERS among it, which is a
    // different sight -- a metre-and-up block leaning against the base of a crag
    // rather than a field of chips. It costs the four relief samples on every
    // candidate over a 600 m disc, which is why no other bed asks: `footDense` is
    // a look, not a default. The rates below are what make it visible -- an
    // accept rate is capped at 1, so 0.4 * (1 + CLUMP_GAIN * clump) has room to
    // move where 1.0 would have every last bit of it truncated away.
    footDense: true,
    // TWICE AS THICK ALONG A SHORE, on both sides of the waterline -- the bed
    // allows water, so the same gain lays them in the shallows. Multiplies the
    // accept rate within SHORE_REACH of a lake or river edge, and 2 x 0.4 is
    // still under the cap the note above is about. The sunken bed has no gain:
    // it is already a bed of nothing but shoreline.
    shoreGain: 2,
    // A METRE AND A HALF TO TEN, THE SAME EVERYWHERE. Four identical entries is
    // not a mistake -- `sizeByEnv` is per environment because the sunken and
    // embedded beds need it to be, and a bed that wants one range everywhere says
    // so four times rather than growing a second mechanism to say it once.
    //
    // THE FLOOR IS WHERE A ROCK BECOMES AN OBSTACLE. ROCK_STAND_MIN puts the line a
    // prop can stand on at a metre and this sits half a metre clear of it, because a
    // stone that small is ground clutter -- too small to walk around, too small to
    // read as geometry -- and it was most of what the bed drew: over half of every
    // boulder placed came out under 1.5 m. Those are gone rather than shrunk,
    // and what they were carrying is carried by render/litter.js underfoot.
    //
    // THE TOP IS NOT TASTE AND MUST NOT BE RAISED HERE. `minReach` derives the
    // bed's whole LOD reach from it: at 10 m it demands 588 m of the 600 below,
    // and 11 m throws at construction. The bed above 10 m is `giants`, which buys
    // its 15 m top with a 1250 m radius.
    sizeByEnv: {
      river: [1.5, 10.0],
      forest: [1.5, 10.0],
      cliff: [1.5, 10.0],
      peak: [1.5, 10.0],
    },
    // STILL WEIGHTED SMALL, BUT NOWHERE NEAR AS HARD -- 4 before, and at 4 over a
    // range starting at 1.5 the median would sit at 2.0 m and three rocks in four
    // under 4.2. The point of the range is that it is a RANGE. At 2.5 the median
    // is 3.0 m, the upper quartile 5.6 m and the top decile 8.0 m, against
    // a flat roll's 5.75 m median: the big end stays rare rather than becoming the
    // norm, which is the whole difference between biasing the roll and narrowing
    // the range.
    //
    // It also feeds the burial: `sizeRoll` is what SINK_SIZE_TILT bends the sink
    // roll by, so a bed weighted small leaves most rocks on a near-uniform depth
    // draw and spends the deep-burial bias on the big ones.
    sizeBias: 2.5,
    // NO ROCK INSIDE ANOTHER ROCK -- see the scree bed for the mechanism. It
    // matters more the bigger the bed's rocks get, because two 8 m boulders landing
    // 5 m apart make one 13 m blob and the silhouette is what the size was bought
    // for. Nearly free here: 4 candidates a tile against scree's 196, so a handful
    // of distance tests where that bed pays thousands.
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
    field: 2,
    // HALVED, AND THE ROCKS MADE BIGGER TO PAY FOR IT -- see `sizeByEnv` and
    // `sizeBias`; the two numbers are one decision and moving either alone undoes
    // it. At 2.0 the foot of a cliff was a rock every metre, all about the same
    // modest size: a gravel path rather than a talus cone. Now it is one rock every
    // 1.8 m inside the full radius, median 2.25 m across, and past it only the
    // blocks big enough to still be drawn. Scree does essentially all of that
    // alone -- the other beds contribute a flat ~230 rocks at the foot whatever
    // this number is.
    //
    // WHAT "PILED" MEANS HERE CHANGED WITH THE DART. `minGap` forbids the
    // short-range clustering that used to be the evidence of a pile, so nearest
    // neighbour now runs 0.75 / 1.33 / 2.02 m at p10/median/p90 where Poisson at
    // the same rate gives 0.33 / 0.84 / 1.54. The piling has moved up a scale,
    // where it belongs: the clump floor decides where the drifts are and the
    // density fills them. Coverage is better for it -- only 6% of the foot is clear
    // inside 1.5 m, against 28% before. DENSITY AND `clumpFloor` ARE INDEPENDENT
    // AND ONLY DENSITY FILLS GROUND: spacing inside the drifts is flat at
    // 0.96-0.98 m across floors 0.42 to 0.65, so the floor is a purely spatial
    // mask and raising it to buy "bunching" only trades away coverage.
    //
    // WHAT IT COSTS: 17 ms of one-time `place()`, and the pool `siteFrac` sets
    // below. Most of the placement time is `_relief`, not the terrain sample; see
    // the note at the clump test in _growTile for the memo that would take it
    // down and why it is not free. §25 has the measurements.
    density: 1.0,
    envDensity: { river: 0, forest: 0, cliff: 1, peak: 1 },
    fullRadius: 40,
    // 280 AND NOT LESS, and the short end was tried. `radius` does not change
    // near-field spacing at all -- inside `fullRadius` it measured the same at
    // 140, 110 and 90 -- so pulling it in to 110 looked like a free quarter off
    // both the placement time and the pool. It is not: it sets REACH, and a scree
    // slope is a landscape feature you see across a valley before walking to it.
    // At 110 the check-rocks traverse places zero scree where 140 places 97,
    // because the feet it passes sit in the 110-140 m band -- cutting this does
    // not thin the pile, it deletes whole piles. The other end is a floor rather
    // than a target, and the 4.5 m top sits just inside it: the biggest block
    // reaches T6 at 113 m and owes a ROCK_FAR_LIFE band past that, so `minReach`
    // refuses anything under 265 m and a top size over 4.76 m throws outright.
    radius: 280,
    tile: 14,
    // Peak 643 of 34522 over the probe flight.
    siteFrac: 0.03,
    minElev: 0,
    maxSlopeDeg: 46,
    allowSubmerged: false,
    tilt: 0.7,
    sinkVary: true,
    // Not an anchor. A talus field is not a thing you plant a mushroom ring at
    // the foot of -- it is all foot -- and offering it would swamp any buffer
    // sized for the boulders bed.
    anchor: false,
    // It does displace, though: a talus block is a metre of solid stone and a
    // sapling growing through one at the foot of a cliff is exactly the error
    // Rocks.blockTopAt exists to stop.
    blocks: true,
    // A WIDE RANGE WEIGHTED SMALL, which is how every other bed here varies and
    // is the only thing that keeps a talus cone from reading as ONE SIZE
    // REPEATED. At [0.5, 3.0] with `sizeBias` under 1 pushing the roll UP, the
    // bed placed p10/p50/p90 of 1.00/2.10/2.87 m -- a threefold spread against
    // the boulders bed's sixteenfold -- so every block at the foot of a face was
    // the same block, and a pile of one size reads as rubble tipped out of a
    // truck rather than as stone that fell off a cliff. Nine to one from bottom
    // to top with the bias ABOVE 1 pushing the roll DOWN gives 0.65/2.00/3.95 m
    // at the same median the pile was tuned to: chips, cobbles, and the
    // occasional block big enough to scramble over.
    //
    // THE TOP IS SET BY `radius`, NOT BY TASTE. A 4.5 m block reaches T6 at 113 m
    // and owes a ROCK_FAR_LIFE band past that, so `minReach` demands 265 m of this
    // bed's 280 and anything over 4.76 m throws at construction. That is the
    // right place for the seam anyway: past it the BOULDERS bed is what piles at
    // a foot, which is what its `footDense` is for, and it runs to 10 m.
    //
    // THE FLOOR IS ROCK_MIN_SIZE and the roll now actually reaches it -- the
    // world's rule against a speck carpet, not this bed's own restraint, which
    // is why the small end can be spent on variety here without laying grit back
    // over the ground.
    //
    // Only `cliff` and `peak` are listed because they are the only environments
    // this bed's `envDensity` can reach; the constructor takes `hi` over the
    // reachable ones and would throw on a missing entry.
    sizeByEnv: {
      cliff: [ROCK_MIN_SIZE, 4.5],
      peak: [ROCK_MIN_SIZE, 4.5],
    },
    sizeBias: 1.4,
    // AND NO ROCK INSIDE ANOTHER ROCK. Centres must be `minGap` of the sum of
    // the two radii apart, radius being half the measured world width, so 0.6
    // puts each centre just outside the other's circle and leaves partial
    // overlap -- which is what a pile is -- alone. A dart, not a relaxation: one
    // pass, first come first served, no attempt to move the loser somewhere it
    // would fit.
    //
    // EVERY BED HAS ONE and this is the bed that pays for it: quadratic in the
    // tile's survivors, 196 here, so ~19k distance tests a tile -- nothing beside
    // the field samples the same tile pays for, and a fiftieth of that on the
    // next densest bed. It also does the most work, throwing away 3,419
    // candidates for the 2,871 it keeps.
    //
    // WHAT IT CANNOT SEE IS THE OTHER SEVEN BEDS. A dart is per-bed, so a scree
    // block and a boulder may still interpenetrate at the foot of the same face.
    // Making it cross-bed is not a distance test, it is an ORDERING problem: beds
    // grow their tiles lazily, on different grids and in whatever order the
    // camera walks, so whichever bed reached a patch of ground first would win
    // and the world would stop being a pure function of position.
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
    // texture -- the litter pebbles, and the underfoot bed's stones at a third of
    // a metre -- and texture is something the eye reads as one continuous sheet
    // however much of it there is. A stone standing metres PROUD of that sheet is
    // the opposite kind of object: it occludes what is behind it, and at five
    // metres in poor visibility it resolves before the floor does. That shape
    // looming out of the water is the whole effect, and it is why the bed is
    // sparse: something you come across is mysterious, something there is one of
    // every four metres is gravel.
    name: 'sunken',
    field: 3,
    // 0.02 x 0.5 is one stone per 100 m2, about one every ten metres: the lake
    // bed's litter is render/litter.js's, and this is the part with a silhouette.
    density: 0.02,
    // Three hard zeroes, and not a taste call that could be reopened:
    // `submergedOnly` means a candidate in any of these environments has already
    // failed the water test, so a rate here would be unreachable. See _envAt --
    // submerged ground is always `river`.
    envDensity: { river: 0.5, forest: 0, cliff: 0, peak: 0 },
    fullRadius: 65,
    // Set by the `minReach` check below and not by taste: a 10 m stone holds a
    // sampled tier to 250 m and then owes T6 the full ROCK_FAR_LIFE band, so
    // anything under ~589 m would cull the biggest ones mid-ladder at the bed
    // edge. Far further than you can see through this water, so the reach is
    // paid for entirely by the LOD ladder and never by the eye.
    radius: 600,
    tile: 24,
    // Peak 1838 of 3941 over the probe flight.
    siteFrac: 0.7,
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
    // Displaces, on the same terms as the boulders: these are closed stones one
    // to ten metres across, and the litter pebbles do reach a shallow lake floor.
    blocks: true,
    // The lake-floor half of the crabs' ground -- see Rocks.perchesInto.
    perch: true,
    // EXACTLY THE BAND THAT WAS ASKED FOR. One environment listed because
    // `submergedOnly` makes the other three unreachable.
    //
    // The top matches what stands in the same water on the bank: a 10 m stone is
    // something you swim around rather than over, and at the bottom a metre is
    // still an object with a silhouette rather than part of the floor's texture.
    sizeByEnv: {
      river: [1.0, 10.0],
    },
  },
  {
    name: 'giants',
    field: 4,
    density: 0.0006,
    // A house-sized rock in a wood is a landmark and has to stay one: 0.25 of
    // 0.0006 is one per 6,700 m2, one every ~80 m -- rare enough to notice, common
    // enough that a walk passes several. A cliff face runs full rate and is covered.
    envDensity: { river: 0.15, forest: 0.25, cliff: 1, peak: 0.8 },
    fullRadius: 270,
    radius: 1250,
    tile: 70,
    // Peak 504 of 740 over the probe flight: the bound itself, since 1.5x that peak is past it.
    siteFrac: 1,
    // THIS IS THE BED THE FAR TIER WAS BUILT FOR. A 7 m landmark holds T80 to 53 m
    // and T20 to 175, then is T6 for the remaining 1075 m -- a ~4.8 km2 annulus
    // where twenty triangles become six. Gains least from tightening the ladder:
    // its rocks were always the ones big enough to earn their mesh.
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
    // ground anywhere a tree does; a BARREN face or peak stands 30 m (see
    // `barrenTop`), and past that the embedded bed takes over and buries the
    // difference.
    //
    // `sizeBias` 2 weights it small without giving up the top: the median lands
    // near 5 m, which is what the bed placed before, and the top decile near
    // 12.5 m, so the biggest block stays the thing you walk half a mile to.
    sizeByEnv: {
      river: [1.6, 15.0],
      forest: [1.6, 15.0],
      cliff: [1.6, 15.0],
      peak: [1.6, 15.0],
    },
    barrenTop: { cliff: 30.0, peak: 30.0 },
    sizeBias: 2,
    // NO ROCK INSIDE ANOTHER ROCK -- see the scree bed for the mechanism, and
    // the bed it mattered most on: at a full cliff rate the nearest neighbour ran
    // 11.4 m at p10 against rocks up to 15 m across, so the two landmarks you
    // navigate BY fused into one shape with a seam down it. 0.7 rather than the
    // scree bed's 0.6 for the same reason the other big-rock beds take it -- the
    // bigger the pair the further into each other a given fraction lets them
    // reach. It costs 15 rocks in 1,236 and is free to run at 2.9 candidates a
    // tile.
    minGap: 0.7,
  },
  {
    // THE ENTRANCE BOULDERS (DESIGN.md §30): one boulder per 300 m tile that
    // holds a wood, lying on its long side like every other big rock in the
    // wood and the burial pinned so the mouth entrances.js cuts into its
    // flank is always at the same height. `deep` puts the one candidate at
    // the point of the tile furthest from open ground and refuses the tile
    // unless that point is 50 m into the wood, so a hollow is always
    // something she has to find. The wood is the forest law's, which runs
    // 55 m up into what `_envAt` calls peak, so peak ground is claimed too.
    name: 'hollow',
    hollow: true,
    field: 9,
    density: 1 / (300 * 300),
    deep: 50,
    lie: true,
    envDensity: { river: 0, forest: 1, cliff: 0, peak: 1 },
    fullRadius: 270,
    radius: 1250,
    tile: 300,
    minElev: 0,
    maxSlopeDeg: 20,
    allowSubmerged: false,
    tilt: 0.2,
    tiltJitter: 0,
    sinkVary: false,
    // Pinned just under half its height and under SQUASH_AT: never squashed,
    // so the face the mouth sits in is the hull's own.
    sinkRange: [0.45, 0.46],
    anchor: true,
    blocks: true,
    sizeByEnv: { forest: [8.0, 12.0], peak: [8.0, 12.0] },
    minGap: 0.7,
  },
  {
    // THE EMBEDDED LAYER: rock that reads as mostly UNDERGROUND, and the only bed
    // whose subject is the part you cannot see.
    //
    // Every other bed places an object standing on a surface. This one places the
    // top of something much larger: it rolls seven to nine tenths of burial and,
    // past SQUASH_AT, is placed as the slab that burial would have SHOWN -- a
    // knuckle of a block whose real size you infer from how far apart its exposed
    // corners are. That is what makes a cliff read as ROCK WITH SOIL ON IT rather
    // than as a heightfield with props on it: a 20 m block showing its last three
    // metres is a piece of the mountain the mountain does not know about, which
    // no rock STANDING on the surface can be.
    //
    // AND IT IS THE ONLY BOULDER A FACE CAN HAVE. Every other rounded bed refuses
    // ground past 40 to 62 degrees, and the refusal is geometry rather than taste:
    // `instY` moves a rock along world Y, so a 15 m boulder seated on a 72 degree
    // wall has its uphill side metres inside the hill and its downhill side hanging
    // in the air. The only rock that can be up there is one that is mostly IN
    // there, which is this bed -- so "a few giants scattered into the cliffsides"
    // is a bigger top end here (see sizeByEnv) and not a slope limit raised
    // somewhere else.
    //
    // WHY IT IS ITS OWN BED, on the file's only test: `sinkRange` is per-bed and
    // cannot be varied within one, and no rate on an existing bed can reach 0.7-0.9
    // when SINK_DEEP caps every other bed at 0.8 and their floors start at 0.1. The
    // slope limit and the size range are per-bed for the same reason.
    //
    // BURIAL IS WHAT MAKES ONE MESH WORK HERE rather than a problem it has to
    // survive: at a 70 to 90% roll what shows is a knuckle and a couple of
    // corners, and the quarter turn decides WHICH corners -- and which face the
    // squash flattens. The same boulder this far in is less recognisable as
    // itself than at any other depth in the file.
    name: 'embedded',
    field: 5,
    density: 0.01,
    // No forest: an embedded block in flat woodland is a boulder that has been sunk
    // too far, and the boulders bed already owns that ground with a burial band
    // that tops out at 0.8. Peak matches cliff because a summit IS steep bare rock
    // -- `_envAt` only calls it something else because of how high it is.
    envDensity: { river: 0.4, forest: 0, cliff: 0.15, peak: 0.15 },
    fullRadius: 120,
    // ROCK_LOD_GONE_MAX, THE MOST ANY BED MAY HAVE, and the 64 m top demands
    // nearly all of it: by size a 64 m block would be sampled to 1,600 m, so it
    // is the far ceiling that puts it on T6 at 1,000 m, and it owes the dissolve
    // band past that, so `minReach` refuses anything under 1,177 m. Burial does
    // not buy any of it back -- sinking a rock takes away its HEIGHT and the
    // ladder reads what shows, which here is the width still lying across the
    // face. This is why the density is a fifth of what "litter" sounds like:
    // reach is quadratic and this bed has the longest.
    radius: 1250,
    tile: 60,
    // Peak 6412 of 22432 over the probe flight.
    siteFrac: 0.45,
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
    // lake floor is looked at from a few metres away in poor visibility, so a 10 m
    // block there is terrain; a cliff is looked at from across a valley, where it
    // is one feature among many. `forest` is absent because the bed's forest rate
    // is 0 and an entry there would be unreachable.
    //
    // 32 ON A WALL AND 64 ON A BARREN ONE, AND THIS IS WHAT BREAKS A FACE UP: a
    // block this size, bedded as its burial roll shows it, is a dozen metres of
    // curved mass ACROSS sixty of width, the one thing on a face that is not the
    // face. It stays rare on purpose -- the bed's cliff rate is a quarter, and
    // `sizeBias` puts only the top decile up here.
    sizeByEnv: {
      river: [2.0, 10.0],
      cliff: [3.0, 32.0],
      peak: [3.0, 32.0],
    },
    barrenTop: { cliff: 64.0, peak: 64.0 },
    // Weighted small, on the boulders bed's argument and more sharply, because
    // this bed's range is wider and its reach is the longest in the file: at 3 the
    // median barren cliff block is 11 m and only the top decile reaches 47 m; on
    // a wooded face 7 and 24.
    sizeBias: 3,
    // No block inside another block. Worth more here than anywhere: two of these
    // overlapping do not read as two rocks jammed together, they read as one
    // wrongly-shaped rock, because the joint is the only part of either that shows.
    minGap: 0.7,
  },
  {
    // THE STONES ALONG THE WATER'S EDGE: a frequent scatter of small and medium
    // boulders in a strip `shoreOnly` metres either side of every lake shore and
    // river bank, and nowhere else, thickest ON the line and thinning out to
    // the strip's edge. Its own bed on the scree bed's reasoning -- the boulders
    // bed's `shoreGain` can at most double a rate that lays one rock every 21 m,
    // and a bank wants one every few strides, which is made of candidates and
    // candidates are per-bed. What that buys, as with scree, is a bed that is
    // dense and SHORT-SIGHTED at once: it reaches 80 m, so the stones are
    // populated only as she comes near the water and the disc is a fiftieth of
    // the boulders bed's.
    name: 'shore',
    field: 8,
    // Candidates per m2 over the whole disc, of which only the strip survives
    // `shoreOnly`. 0.2 x 0.75 at the line is one rock per 6.7 m2, and the strip
    // integrates to 5.5 m of full rate across `shoreCore` and the fall-off, so
    // that is a stone every 1.2 m of bank -- the waterline reads as a stony
    // margin rather than as a colour change with the odd rock on it.
    density: 0.2,
    // Ground within SHORE_RISE of the water is `river` (see _envAt), which is
    // most of the strip; a bank rising steeper than that is forest or cliff and
    // takes a little less. Nothing on a summit, where the water is a tarn on
    // bare rock the giants and embedded beds already furnish.
    envDensity: { river: 0.75, forest: 0.5, cliff: 0.5, peak: 0 },
    fullRadius: 25,
    // Set by `minReach`, not taste: a 2.5 m stone reaches T6 at 62.5 m and owes
    // the far band past it, which asks 73.5 m of this.
    radius: 80,
    tile: 12,
    // Peak 213 of 2425 over the probe flight.
    siteFrac: 0.2,
    minElev: 0,
    maxSlopeDeg: 42,
    // Both sides of the line -- the shallows take stones as the bank does, and
    // `shoreOnly` is measured as |d| for exactly that.
    allowSubmerged: true,
    // Metres either side of a shore a candidate may stand. Tighter than the
    // boulders bed's SHORE_REACH: that gain is a fringe, this is the waterline.
    shoreOnly: 4,
    // And within this much of the line the rate is the full one; from here to
    // `shoreOnly` it eases to nothing, so the strip has no hard outer edge and
    // the stones crowd where the water meets the ground.
    shoreCore: 1.5,
    tilt: 0.5,
    sinkVary: true,
    // Not an anchor: a metre stone on a beach has no damp shaded base worth a
    // fern, and this bed lays enough of them to crowd Rocks.anchorsInto.
    anchor: false,
    // Displaces grass, as every closed stone over ROCK_MIN_SIZE does; the grass
    // bed's shore clumps grow AROUND these rather than through them.
    blocks: true,
    // A crab's rock, on the same terms as the boulders -- see Rocks.perchesInto.
    perch: true,
    // Half a metre to two and a half, everywhere it may stand: from something you
    // step over to something you sit on. The top is what sets `radius` above.
    sizeByEnv: {
      river: [ROCK_MIN_SIZE, 2.5],
      forest: [ROCK_MIN_SIZE, 2.5],
      cliff: [ROCK_MIN_SIZE, 2.5],
    },
    // Weighted small: the median comes out at 1.0 m and the top decile past
    // 1.9, so the strip is mostly stones with a boulder now and then.
    sizeBias: 1.6,
    // No rock inside another rock, and cheap: 17 candidates a tile.
    minGap: 0.5,
  },
]

// Where the four environments cut. All read off the same field sample the
// placement test already pays for, plus one water lookup.
//
// A rock this far out of the water still belongs to the river: the tint palette
// is chosen off the environment, and a hard edge at the waterline would put a
// lichen boulder half in the stream.
const SHORE_RISE = 1.6

// Metres either side of a SHORE (WaterSurfaces.shoreDistAt) inside which a
// bed's `shoreGain` multiplies its accept rate.
const SHORE_REACH = 10

// Metres of daylight every bed keeps between a rock's footprint and a road's edge, so no stone stands on a road or leans over it. The test is centre distance against half-width + half the plan span + this, and PathSet.nearest sees only within a road's feather (8 m by default) of its edge: a rock whose centre is further out than that is never asked, so the widest stone can in the worst case reach to within feather - span / 2 of the edge -- still clear of the surface for anything under 16 m across.
const ROAD_CLEARANCE = 0.5

// Metres BELOW the local snow line at which a site counts as peak country. Well
// below, because the jagged stuff has to start before the white does: bare rock
// up to the snow with spires only above it reads as two mountains stacked.
const PEAK_BELOW_SNOW = 55

// Steeper than this and a site is a cliff, not a wood. 34 degrees is just past
// render/trees.js's 32 degree tree limit, so the ground with no trees on it is
// the ground that gets cliff furniture.
const CLIFF_SLOPE_DEG = 34
const CLIFF_TAN = Math.tan((CLIFF_SLOPE_DEG * Math.PI) / 180)

// Where a bed's `barrenTop` applies: ground the forest has given up. `cliff`
// and `peak` are one field sample each, so a 35-degree pocket in a wood is a
// cliff site and the wooded band under the treeline is peak country, and a rock
// sized for a bare face stands out of the trees there. Barren is EITHER this
// far above the snow line -- trees.js's TREELINE.fade, past which the wood is
// a tenth as dense and stunted by half; check-rocks holds the two equal -- OR
// a face still past CLIFF_SLOPE_DEG at every point of the rock's own footprint
// (`_barrenAt`).
export const BARREN_ABOVE_SNOW = 70

// Metres below the snow line at which moss gives out. See Rocks.syncBands.
const MOSS_DROP = 220

// The per-instance range each of the two seasons is rolled into, as a fraction
// of the world's own ceiling. Both are stone-only in the shader; the argument
// for the numbers is in Rocks.syncBands.
const SNOW_CAP = [0.3, 0.5]
const MOSS_CAP = [0, 0.5]

// How deep a rock is bedded, as a fraction of its own STANDING height: this much
// at the flat, rising to this plus the span at the bed's slope limit. The height
// burial is a fraction OF is the rock's extent after the quarter-turn rolls (see
// ROLL_STEPS), not `measured.height`, so a boulder laid on its side is bedded by
// a fraction of what it NOW stands, not of what it used to.
//
// TWO FIFTHS AT THE FLAT, AND THAT IS A FLOOR ON THE WHOLE WORLD -- every bed
// inherits it through `sinkRange`'s default and `embedded` starts deeper still.
// A rock resting on the ground reads as PLACED, and a tenth of it underground was
// not enough to beat that: the giveaway is the ground line, an unbroken ellipse
// of contact where the rock meets the dirt all the way round, and only burying
// the widest part of the rock breaks it. Past two fifths the hill has closed over
// the belly and what shows is stone coming OUT of the ground.
//
// IT COSTS TRIANGLES AND THE COST IS REAL: the buried part is still built and
// still submitted, so raising the floor from a tenth to two fifths spends
// geometry on rock nobody sees. It buys the one thing the scatter could not
// fake -- see the ground-line argument above -- which is why the answer to the
// cost is ROCK_MIN_SIZE and not a shallower bed. Past SQUASH_AT the rock is
// squashed instead of sunk further, which caps what any one instance can hide.
const SINK_MIN = 0.4
const SINK_SLOPE = 0.28

// AND A ROCK STOOD ON END IS BEDDED HALF AGAIN AS DEEP. The quarter turns put a
// different axis up each time, and one of the boulder's three is half again as
// long as the others: stood on that one it is a 2 m slab on a 1.2 m base, and
// two fifths of that underground still reads as balanced. Nothing that shape
// stays up on open ground unheld, and burial is the only thing holding it --
// `sit` is 0 on the shipping shape, so no instance is standing on a cut face
// either.
//
// THE MARGIN OVER SINK_MIN IS NARROWER THAN IT WAS, and it has to be: the two
// floors used to stand at a tenth and three tenths, and there is no room for
// that ratio once the shallow one is two fifths and SINK_DEEP caps the roll at
// four. What the pair still has to say is the ORDERING -- whatever is standing
// up is in deeper than whatever is lying down -- and three fifths says it with
// a fifth of the range left above for the roll.
//
// TALL IS A RATIO, NOT A HEIGHT: the rolled box's vertical extent over the mean
// of its two plan extents, so the rule follows the shape rather than a number
// read off one seed. At 1.0 it fires on an orientation that stands taller than
// the ground it covers and on no other, which is half the sixteen turns.
const SINK_TALL = 0.6
const TALL_AT = 1

// The deep end of the per-instance burial roll, for beds that set `sinkVary`, and
// the default top of `sinkRange`. Four fifths of a rock underground is a rock the
// hill has grown most of the way up around. Rolling it PER INSTANCE is the point:
// a scatter where every rock is bedded the same fraction reads as props standing
// ON the terrain rather than as stone coming OUT of it, and the giveaway is that
// they all meet the ground at the same relative height.
//
// Past SQUASH_AT the roll no longer buries, it flattens: the top of this range is
// a slab a quarter as tall as the boulder it was rolled from, sunk exactly
// SQUASH_AT of what it now stands.
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

// PAST THIS MUCH BURIAL A ROCK IS SQUASHED, NOT SUNK. A boulder bedded nine
// tenths is an iceberg: nine tenths of its triangles built, skinned and
// submitted under the hill, and the tenth that shows sits inside a LOD ladder
// measuring the whole rock, so a 20 m giant with 2 m of crest held its finest
// mesh at fifty metres. Instead, a roll past this is applied as a flattening
// along the axis the rock stands on -- the one protruding from the ground --
// with the burial pinned here: a 0.9 roll becomes a slab a quarter as tall,
// bedded six tenths, showing exactly the height the 0.9 burial would have and
// none of the depth. The squash is on the ROLLED box, so the sixteen quarter
// turns flatten a different face each and the one mesh reads as slabs, plates
// and wedges rather than as one boulder at sixteen depths.
//
// It is one scale in the instance matrix and costs the renderer nothing; the
// consumers that read the matrix back (`_spanAt`, `_rayAt`) invert it by
// column length rather than by one uniform scale, which is three dot products a
// hit candidate. A rock buried at or under this is placed as it always was.
const SQUASH_AT = 0.6

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

// Floats per rock in a perchesInto buffer: x, y, z, hull radius, size. Anchors stay at 4.
export const PERCH_STRIDE = 5

// Floats per span in a columnAt buffer: bottom, top, in world metres.
export const SPAN_STRIDE = 2
// Where RockBed._spanAt leaves the two ends of the line through one instance:
// [0] the lowest stone, [1] the highest. One buffer for the file, because the
// query that reads it is per prop candidate and per walking frame.
const span = new Float64Array(2)

// --- relief, which is how the scree bed finds the foot of a face -------------
//
// Metres along the fall line for the direction probe and for the relief probe.
// The direction is taken over a LONG step on purpose: at a metre or two the
// gradient is dominated by the ridged noise the terrain is built from, and a fall
// line from that points somewhere different every few metres -- the relief test
// would read noise rather than landform.
const RELIEF_STEP = 6
const RELIEF_PROBE = 16

// AND THE ANSWER IS CACHED ON A GRID THIS FINE, in metres, which is what makes a
// dense `footOnly` bed affordable: candidates arrive in clusters far tighter than
// the signal, so scree paid four field samples over and over within a few metres
// -- 54,000 asks a disc, cut to 12,000 answers.
//
// FOUR METRES IS UNDER EVERY SCALE THE SIGNAL HAS: a fall line over RELIEF_STEP
// (6 m), a break over RELIEF_PROBE (16 m), a clump field with 26 m cells. So this
// is not a pure memo -- it declares the RESOLUTION of the question, moving the
// foot boundary by up to a cell, and cannot move where the piles are.
//
// THE ANSWER IS TAKEN AT THE CELL'S OWN CENTRE, one extra `heightAt` and the only
// safe version. Storing whichever candidate asked FIRST is cheaper and wrong: a
// tile regrown at a finer level walks a different subset, so the first-asker
// changes and a rock appears or vanishes as the camera walks toward it. This has
// to be a pure function of position like everything else here.
const RELIEF_CELL = 4

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
// What the tint row paints an entrance boulder (setHollowTint): a gain like the palette's, so it reads as purple under the ground cue and the lighting.
const HOLLOW_TINT = new THREE.Color(2.4, 0.6, 3.4)

// --- and the one bed that is not a rock standing on the ground --------------
//
// A FACADE BED IS THE CLIFF, so it takes the cliff's own colour and adds nothing.
// The panels are a skin over the heightfield rather than stone lying on it, and
// every mineral in the palette -- the buff of sandstone, the rust of ironstone,
// the green of lichen -- reads as a different rock bolted onto the mountain. What
// is left to vary with is LIGHTNESS, which is what the terrain itself varies with:
// `shade` already carries altitude, slope and the snow line, so a facade that
// takes the ground cue whole is darker in the gullies and paler at the tops
// WITHOUT a second opinion about what it is made of.
//
// THE GAIN IS THE TERRAIN'S OWN. terrain-material.js divides its stone sample by
// ROCK_TILE_MEAN and multiplies by that vertex shade; a prop that wants to BE the
// terrain takes the same reciprocal and the same shade, and there is no tint left
// over. Deliberately NOT a TINTS entry: as a destination colour this is white, and
// every promise the palette makes -- the clip headroom, "nothing darkens the tile"
// -- is about a gain applied with no ground cue behind it. This one is only ever
// applied with a FULL one, and that is what keeps it in range: off snow the
// terrain palette runs a luminance of 0.06 to 0.09, so the product lands well
// under 1 and the panels track the snow line up to white for the same reason the
// ground under them does.
//
// THE CUE IS 1 WHERE NO OTHER BED REACHES IT. GROUND_CUE stops short everywhere
// because the stones still have to be findable; a facade being findable is the
// defect it exists to fix.
const FACADE_CUE = 1
const FACADE_GAIN = ROCK_TILE_MEAN.map((m) => 1 / m)

// Everything below is render/trees.js's, unchanged, and its header is the
// explanation for all of it. The hysteresis is props/rock.js's, so the bench's
// world-LOD view and this walk cannot disagree on it.
const LOD_HYSTERESIS = ROCK_LOD_HYSTERESIS
const BUILD_BUDGET_MS = 1.5
const PLACEMENT_CELL = 4.0

// A `deep` bed's forest scan (see the hollow bed): the tile sampled every
// STEP metres, a cell wood when the forest law keeps at least KEEP of its
// trees, the site the cell furthest from open ground among those INSET
// metres in from the tile's edge, and the one candidate jittered JITTER
// metres about it. Neighbours across a tile edge are then at least
// 2 * (INSET - JITTER) apart.
const DEEP = { step: 15, keep: 0.6, inset: 60, jitter: 7 }

// THE TILE WALK IS BUCKETED BY PHASE AND A BUCKET IS WALKED ONLY WHEN ITS ANSWER
// CAN HAVE CHANGED -- render/trees.js's STILL_M scheme, whose header argues it,
// with one difference: here the NEAR tiles are bucketed too. A tree tile inside
// the mesh band is re-tiered every frame; a rock's per-instance ladder is the
// same pure function of the camera, and with six beds whose near radii run to
// 890 m it is most of the bill (2.4 ms standing still on the headset, over
// ~9,000 resident tiles), so it waits for its bucket's turn like the rest. A
// rock's tier swap can therefore land up to RIM_PHASES frames late and only
// while the camera is moving, which the cross-dissolve already covers.
const STILL_M = RIM_SLACK_MIN

// How hard a `fitSlope` bed cuts a plate that hangs off its face, per attempt.
// See _fitFactor: the probe is a yes/no on a whole footprint, so the only way to
// find the size that fits is to ask again smaller, and this is the step. It sets
// how much face the ladder WASTES, because it stops at the first rung that
// clears and every rung overshoots downwards by up to this factor: at 0.75 a
// site that would hold twelve metres gets nine, and area goes as the square, so
// a quarter off the span is nearly half the wall left bare. 0.87 costs rungs --
// sixteen worst case on `cliff slabs` against eight -- but a rung that fails is
// one or two field samples of twelve (see _fitFactor), so the fine ladder is
// most of a rung cheaper than it looks.
const FIT_SHRINK = 0.87

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
// becoming a pool exhaustion (a rock dropped, in `_growTile`) or a frame spent
// animating a jump cut nobody would see. Past either limit a swap simply pops,
// which is what every swap did before this existed: a loss of polish, never a
// loss of rocks.
const FADE_MAX_INFLIGHT = 1024
const FADE_POOL_RESERVE = 1024
// poolBound's headroom over every mesh tier's population bound, and the only
// part of the tier a cross-dissolve ghost may sit in -- see `_tierCaps`.
const TIER_HEADROOM = 1.35

// ROCK_LOD_AT is in metres of camera distance per metre of ladder size, so what
// `update` wants is the square of it: compare d2 against size-squared times
// these and no square root is ever taken. The OUT copy is the same ladder with
// the hysteresis slack already multiplied in -- a rock only leaves a tier it is
// already on 12% further out than it entered, so a camera parked on a threshold
// does not flicker between two meshes.
const LOD_SQ = Float32Array.from(ROCK_LOD_AT, (k) => k * k)
const LOD_SQ_OUT = Float32Array.from(ROCK_LOD_AT, (k) => (k * (1 + LOD_HYSTERESIS)) ** 2)
// ROCK_LOD_FAR_MAX squared, as the ladder above is: a rock holds a mesh tier out
// to FAR_SQ whatever its size and, once on T6, comes back only inside FAR_IN_SQ
// -- the same slack a rung leaves, applied to the ceiling.
const FAR_SQ = ROCK_LOD_FAR_MAX ** 2
const FAR_IN_SQ = (ROCK_LOD_FAR_MAX / (1 + LOD_HYSTERESIS)) ** 2

// HOW LONG A ROCK IS WHOLE ON T6 FOR, as a multiple of the distance the far
// tier takes over at.
//
// Flooring the gone-distance at exactly the far distance is the least that can
// be called correct, and least is what it delivered: 39% of the river underfoot
// rocks and more besides started dissolving in the same metre they reached T6,
// so the hull showed up already dithering -- from inside the world
// indistinguishable from the finer mesh dithering out.
//
// So the floor is a BAND, and 1.0 is the SHORTEST one that is still a band. The
// dissolve fires at RIM_AT rather than at FADE_BAND, and the gone-distance here
// divides by the smaller of the two, so at 1.0 T6 is drawn solid for the 8.8% of
// its start distance between the two numbers before it begins to dither.
//
// NOT FREE IN THE OTHER DIRECTION EITHER: a bed may not end before its own ladder
// does (`minReach`), so this multiplies every bed's radius and its pool. Lowering
// it shrinks both; raising it grows both. Re-run scripts/check-rocks.mjs after
// either, which bounds them.
const ROCK_FAR_LIFE = 1.0

/**
 * The gone-distance a rock of ladder size `size` metres must be given, in metres,
 * for it to live a full `ROCK_FAR_LIFE` band on T6 before dithering.
 *
 * The one place `_fadeFloor`, `_exemptFrac` and the constructor's reach check
 * agree on what "past the end of the ladder" means, so they cannot drift.
 *
 * The divisor stays FADE_BAND even though the rim now fires at the larger
 * `RIM_AT`: dividing by the smaller number pushes the gone-distance FURTHER out,
 * so the band this buys is a superset of the one it promises. RIM_AT would shave
 * 8% off every rock's reach for no gain but tightness.
 */
function farGoneAt(size) {
  return (farAt(size) * ROCK_FAR_LIFE) / FADE_BAND
}

/** Where a rock of ladder size `size` metres is T6 from: its own rung, or the ceiling if that is sooner. */
function farAt(size) {
  return Math.min(size * ROCK_LOD_AT[ROCK_LOD_AT.length - 1], ROCK_LOD_FAR_MAX)
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
 * A tile's seed, from its own coordinates, the world seed and the BED (its
 * `field` number, -1 for the clump field). The bed is mixed in so the scatters
 * are independent fields rather than the same one at three scales -- without it
 * every giant would have a smaller rock on its exact centre.
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
 * a vertical cylinder, it is a reject that cannot drop stone; RockBed._spanAt's
 * box slab is what tightens it back up before the triangles are walked.
 *
 * CACHED ON THE SHAPE, because five beds block and they displace props with the
 * same stone -- and built from a CONSTRUCTOR, as `footRadius` is measured there,
 * so a bed's queries have their tables before its first tile grows.
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
 * One size band's scatter: its own tile grid, its own pool, its own PropArena.
 *
 * Not exported. `Rocks` owns one per BEDS entry, plus the bank, the material and
 * the mesh set they share; nothing outside this file has any reason to hold one.
 * Built in two steps: the constructor sizes the pool and bounds each tier, and
 * `attach` gives the bed its view once `Rocks` has summed those bounds into the
 * shared meshes.
 */
class RockBed {
  constructor(field, water, layers, bank, cfg, { seed, ground, biome = null, bounds = null }) {
    this.field = field
    this.water = water
    this.layers = layers
    this.cfg = cfg
    this.seed = seed
    this.ground = ground

    const tile = cfg.tile
    // A `deep` bed seats its one candidate at the tile's point furthest from
    // open ground, and only if that is `deep` metres in; see `_deepSite` and
    // the hollow bed. A bed without one never asks the biome field.
    this.deep = cfg.deep ?? 0
    if (this.deep > 0 && (!biome || typeof biome.coverAt !== 'function')) {
      throw new Error(`RockBed ${cfg.name}: \`deep\` needs a BiomeField with coverAt`)
    }
    if (this.deep > 0 && (Math.round(tile * tile * cfg.density) !== 1 || cfg.lattice || this.deep >= tile / 2)) {
      throw new Error(`RockBed ${cfg.name}: \`deep\` ${this.deep} m needs one candidate per tile and under half of ${tile} m`)
    }
    this.biome = biome
    this._deepN = this.deep > 0 ? Math.round(tile / DEEP.step) + 1 : 0
    this._deepDist = this.deep > 0 ? new Float32Array(this._deepN * this._deepN) : null
    // A `stand` bed takes the quarter turn that puts the shape's longest
    // measured axis upright, a `lie` bed the one that puts its middle axis
    // up -- the longest level, the shape on its narrowest side, so the flat
    // bed face stands as a wall -- each mirrored by the roll draw, instead of
    // a rolled one.
    this.stand = cfg.stand ?? false
    this.lie = cfg.lie ?? false
    if (this.stand && this.lie) throw new Error(`RockBed ${cfg.name}: \`stand\` and \`lie\` are two turns, take one`)
    this.tile = tile
    this.density = cfg.density
    // The room's disc, if it has one (tile-pool.js): no tile outside it, and a
    // reach cut to what fits inside it. `_reseat` squeezes this further by
    // altitude, so the bed's OWN radius is the one clamped here.
    this.bounds = bounds
    this.radius = boundedRadius(cfg.radius, bounds, tile)
    this.fullRadius = cfg.fullRadius
    this.fullSq = cfg.fullRadius * cfg.fullRadius

    this.perTile = Math.max(1, Math.round(tile * tile * cfg.density))
    // `radius` is the bed's reach along the ground and never moves. The three
    // below are the LIVE reach, squeezed by altitude in `_reseat` -- see there.
    // Read `radius` for anything that describes the bed, these for anything that
    // decides which tiles exist right now.
    this.tileSpan = Math.ceil(this.radius / tile) + 1
    this.radiusSq = this.radius * this.radius
    this.evictSq = (this.radius + tile * 1.5) ** 2
    this.maxSlopeTan = Math.tan((cfg.maxSlopeDeg * Math.PI) / 180)
    // THE OTHER END OF THE SLOPE WINDOW, and only the cliff cap bed asks for one.
    // `envDensity.cliff` is not the same question: `_envAt` calls anything past
    // CLIFF_SLOPE_DEG a cliff, which takes in the whole apron below a face, and a
    // cap lying flat on a 20 degree apron is a boulder that has been stepped on.
    // Zero degrees on every other bed, so the test costs a compare nobody notices.
    this.minSlopeTan = Math.tan((Math.max(0, cfg.minSlopeDeg ?? 0) * Math.PI) / 180)
    if (this.minSlopeTan >= this.maxSlopeTan) {
      throw new Error(
        `RockBed ${cfg.name}: slope window ${cfg.minSlopeDeg ?? 0}..${cfg.maxSlopeDeg} deg is empty`
      )
    }
    // AND WHETHER THE WHOLE FOOTPRINT HAS TO STAND ON THE FACE, not just the
    // centre. See `_fitFactor`: this is what stops a 40 m plate laid on a 10 m
    // crag hanging most of itself over the edge into the air with its open
    // underside showing.
    this.fitSlope = cfg.fitSlope ?? false
    // Over 1 weights the size roll towards the BOTTOM of its range, under 1
    // towards the top. Every bed that wants a spread rather than a size sets it.
    this.sizeBias = cfg.sizeBias ?? 1
    // Set by every bed in the file; the default is here for a bed added later,
    // which will want one too. See the dart in _growTile.
    this.minGap = cfg.minGap ?? 0
    // AND WHETHER SMALL STONE IS ALLOWED TO DENY BIG STONE. Off, the dart is
    // symmetric and whichever candidate drew the lower rank wins, so on a bed
    // spanning nine metres to seventy a pebble that landed first can veto the
    // panel that was going to cover the face. On, an instance darts only against
    // stone at least its own size, which is the "place the largest first" rule
    // expressed without touching the rank order the tile growth depends on.
    this.gapBySize = cfg.gapBySize ?? false
    // THE OTHER DART, AND IT IS NOT A SPACING RULE AT ALL. `minGap` asks how far
    // apart two rocks STAND and refuses whatever is closer. This asks a plate what
    // it is FOR: the fraction of its own footprint that is wall no plate already
    // covers, and it refuses whatever earns less than this. Overlap is not
    // rationed, it is ignored -- two plates may lie almost on top of each other so
    // long as each is still masking this much wall on its own account. See
    // `_earnedFrac`.
    //
    // WHY EARNINGS AND NOT A SPACING BOUND. A bound on how close two centres may
    // come is a bound on how BIG the second plate may be, because it is the summed
    // radii that the distance is measured against -- so the rule that keeps plates
    // from burying each other is the same rule that stops a face being clothed in
    // one plate instead of nine. Measured, a tenth of the summed radii held the
    // median panel to 13.8 m on faces the ground would have given 35, left a fifth
    // of every wall bare with a plate available for it, and threw away twelve
    // candidates for crowding for every one the ground refused. An earnings test
    // has no opinion about size: a big plate laid across a smaller one still earns
    // its keep on the ring outside it, so the ground's answer is the one that
    // survives, and it is a plate's WORTH rather than its neighbours that decides.
    //
    // WHAT IT STILL FORBIDS is the thing that made a pack rule necessary -- stone
    // drawn inside stone. A plate that would be mostly swallowed earns nothing and
    // is thrown away whole, which is the right disposal for 158 triangles that
    // mask nothing. That is also why this is a REJECT and no longer a shrink:
    // shrinking a plate to fit the gap beside its neighbour is what built the
    // carpet of small panels, and the gap it was fitting into is worth less than
    // the triangles it costs.
    this.packEarn = cfg.packEarn ?? 0
    this.packCaps = this.packEarn > 0
    if (this.packCaps && this.minGap > 0) {
      throw new Error(`RockBed ${cfg.name}: packEarn and minGap are two answers to the same question`)
    }
    if (this.packCaps && !(this.packEarn > 0 && this.packEarn <= 1)) {
      throw new Error(`RockBed ${cfg.name}: packEarn ${this.packEarn} is a fraction of a plate's own area`)
    }
    // The pack orders itself by the size the GROUND hands each candidate, so a bed
    // with nothing to ask the ground has no order to place in and every plate earns
    // whatever the arbitrary order it arrived in leaves it.
    if (this.packCaps && !this.fitSlope) {
      throw new Error(`RockBed ${cfg.name}: packEarn needs fitSlope to have a size to order by`)
    }
    // THIS BED IS CLIFF SKIN, NOT STONE ON THE CLIFF -- see FACADE_GAIN. It gives
    // up the mineral palette and the hue skew and keeps only lightness, so the
    // panels read as the mountain rather than as something fixed to it.
    this.facade = cfg.facade ?? false
    if (this.facade && !this.fitSlope) {
      throw new Error(`RockBed ${cfg.name}: facade is for plates laid on a face, which needs fitSlope`)
    }
    // HOW FAR A RIM MAY BE UNDER THE HILL, per metre of span, and it is what makes
    // "as large as the FACE allows" mean a face. `_fitFactor`'s plane test only
    // refuses a rim standing PROUD of the ground; a rim the ground has risen over
    // is buried, which is what a panel of a wall should be, so it was not tested at
    // all. Unbounded, that lets a plate grow straight off the face: at the foot of
    // a cliff the plate's plane keeps descending while the ground levels out, so
    // the valley floor sits above the plane, the rim reads as buried, and a 70 m
    // plate passes on a 20 m band with fifty metres of itself underground. This is
    // the bound that stops a plate at the edges of the contiguous face it is
    // panelling, and it is what makes the ladder's answer a measurement OF that
    // face rather than of the whole hillside.
    this.fitBury = cfg.fitBury ?? Infinity
    // WHERE THE CANDIDATES ARE, and on a packing bed it is not a scatter. Every
    // other bed draws its positions uniformly in the tile, which is right when the
    // subject is "some rocks, about this dense" and wrong when it is "every face of
    // the hill gets one": a Poisson stream of mean spacing s leaves holes of two
    // and three s all through it, and a face that lands in one gets no plate
    // however big the pool is. A jittered grid of the same COUNT bounds that
    // instead -- no point of the tile is further than one cell from a candidate --
    // so the smallest face that can be missed is a number rather than a tail. The
    // pitch is `density`'s own, so this moves the candidates without adding any.
    this.lattice = cfg.lattice ?? false
    this.latticeN = Math.max(1, Math.round(Math.sqrt(this.perTile)))
    if (this.lattice) this.perTile = this.latticeN * this.latticeN
    // The pitch itself, in metres, which is the promise the bed makes about the
    // smallest face it can miss. Read by check-rocks and by probe-mask.
    this.latticePitch = tile / this.latticeN
    // HOW MUCH OF TILT_JITTER'S FIFTEEN DEGREES THIS BED TAKES. A lean is variety
    // on a rock and a defect on a panel: it is 0.27 of the scale of lift under the
    // rim on the far side, and on a bed whose whole job is to lie IN the wall that
    // is most of the tolerance `_fitFactor` has to spend on the ground actually
    // being uneven. The fit budget subtracts whatever is taken here, so turning it
    // down does not merely calm the look, it hands the ladder back the room and
    // buys bigger plates with it.
    this.tiltJitter = cfg.tiltJitter ?? 1
    // AND WHETHER THE SIZE IS THE SITE'S OR THE DIE'S. Off, a candidate rolls a
    // size and the fit probe may only cut it down, so a 9 m roll on a sixty metre
    // wall places nine metres and the wall stays bare -- the roll can ask for less
    // than the ground would have carried but never for more. On, every candidate
    // asks for the top of its range and the fit ladder answers with what the
    // ground there actually holds, which is the whole of "cover as much face with
    // as few plates as possible": the spread of sizes then comes from the relief
    // rather than from a distribution laid over it. Only a `fitSlope` bed may set
    // it, since only that bed has something to ask the ground with.
    this.fitFromTop = cfg.fitFromTop ?? false
    if (this.fitFromTop && !this.fitSlope) {
      throw new Error(`RockBed ${cfg.name}: fitFromTop needs fitSlope to have anything to size against`)
    }
    // WHAT FRACTION OF A TILE'S CANDIDATES CAN EVER BE PLACED. Both instance
    // bounds in this file -- `_poolBound` and `_tierCaps` -- count RANK survivors
    // and know nothing about slope, water or the environment gate, so a bed that
    // only ever stands on a wall is bounded as if the whole map were one.
    //
    // A MEASUREMENT, NOT A DECLARATION: each bed's value is its peak live count
    // over scripts/probe-rock-pools.mjs's flight of the real map, with room over
    // it, as a fraction of the bound -- the bound is what the constants say and
    // the fraction is what the map does, so a change to either re-runs the probe.
    // A pool that runs dry DROPS the rock and warns (see `_growTile`), which is
    // what makes a measured size safe to ship. Leave it out and the pool is the
    // whole bound.
    this.siteFrac = cfg.siteFrac ?? 1
    if (!(this.siteFrac > 0 && this.siteFrac <= 1)) {
      throw new Error(`RockBed ${cfg.name}: siteFrac ${this.siteFrac} is a fraction of the candidates`)
    }

    // The two beds that pay for the relief probe, and what each buys with it.
    // `footOnly` REFUSES every candidate that is not standing at the base of a
    // face -- the scree bed, which has no business anywhere else. `footDense`
    // accepts everywhere and merely runs denser at a foot -- the boulders bed,
    // where the brief asks for stone piled at the base of a cliff on top of the
    // stone strewn through the wood. Either one makes `_relief` fire; a bed that
    // asks for neither never takes the four extra field samples. See `_relief`.
    this.footOnly = cfg.footOnly ?? false
    this.footDense = cfg.footDense ?? false
    this.shoreGain = cfg.shoreGain ?? 1
    // Metres either side of a shore outside which the bed REFUSES a candidate --
    // `footOnly` for the waterline. 0 is "anywhere". See the shore bed.
    this.shoreOnly = cfg.shoreOnly ?? 0
    if (!(this.shoreOnly >= 0)) throw new Error(`RockBed ${cfg.name}: shoreOnly must be metres >= 0, got ${cfg.shoreOnly}`)
    // Inside this the strip runs at the full rate; out to `shoreOnly` it eases
    // to 0. Equal to shoreOnly is a flat strip with a hard edge.
    this.shoreCore = cfg.shoreCore ?? this.shoreOnly
    if (!(this.shoreCore >= 0 && this.shoreCore <= this.shoreOnly)) {
      throw new Error(`RockBed ${cfg.name}: shoreCore must be metres within shoreOnly ${this.shoreOnly}, got ${cfg.shoreCore}`)
    }
    this.probesRelief = this.footOnly || this.footDense
    // One cell per RELIEF_CELL of tile, plus one so the last partial cell has a
    // slot. 0 is "not asked yet"; see `_reliefAt`.
    if (this.probesRelief) {
      this.reliefN = Math.ceil(tile / RELIEF_CELL) + 1
      this.reliefMemo = new Uint8Array(this.reliefN * this.reliefN)
    }
    /** How many times `_relief` actually ran, against how often it was asked. */
    this.reliefs = 0
    this.reliefAsks = 0

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

    // THE SHAPE THIS BED PLACES, out of the bank's two. Every bed in the table
    // takes the boulder and differs only in where, how thickly, how big and how
    // deep; the open-bottomed cap is placeable but unplaced. Named rather than
    // defaulted-by-index so a typo is a boot-time throw and not a silent boulder.
    this.shape = bank.shapes[cfg.shape ?? 'boulder']
    if (!this.shape) {
      throw new Error(
        `RockBed ${cfg.name}: no shape \`${cfg.shape}\` in the bank -- it has ` +
          `${Object.keys(bank.shapes).join(', ')}`
      )
    }
    // THE QUARTER TURNS, AND WHICH BEDS MAY HAVE THEM. See ROLL_STEPS for what
    // they buy. A bed placing an OPEN shape must decline: a cap's whole underside
    // is a hole, and fifteen of the sixteen turns point that hole somewhere other
    // than straight down. Defaulted on, because a closed rock has nothing to lose
    // by it and every bed that existed before the cap wants it.
    this.roll = cfg.roll ?? true
    if (this.roll && this.shape.name === 'cap') {
      throw new Error(
        `RockBed ${cfg.name}: an open-bottomed shape may not take the quarter turns -- ` +
          `set \`roll: false\` or the bed will show the inside of its own rocks`
      )
    }
    // The two mirrored turns of ROLL_STEPS that put a measured axis up: a Z
    // quarter turn (ri 4, 12) lifts the width, an X one (ri 1, 3) the depth,
    // and the height stays up through the identity or a half turn (ri 0, 2).
    this.turnRi = null
    if (this.stand || this.lie) {
      if (!this.roll) throw new Error(`RockBed ${cfg.name}: \`stand\` and \`lie\` are quarter turns, which \`roll: false\` declines`)
      const mm = this.shape.measured
      const byLength = ['width', 'depth', 'height'].sort((a, b) => mm[b] - mm[a])
      const up = byLength[this.stand ? 0 : 1]
      this.turnRi = up === 'width' ? [4, 12] : up === 'depth' ? [1, 3] : [0, 2]
    }

    // HOW FAR THE SHELL'S CURTAIN HANGS below its own bed plane, per metre of the
    // shape as built -- the bank measures it, this file only ever multiplies it
    // by an instance scale. It is the entire tolerance `_fitFactor` has for
    // ground that falls away under a plate, so a bed that runs that probe on a
    // shape with no skirt is asking for a footprint that fits nowhere. Explicit
    // throw rather than a silent bed that places nothing.
    this.shapeSkirt = this.shape.skirt ?? 0
    // The footprint's short axis over its long one, rooted once so `_faceRadius`
    // is a multiply. Only the pack reads it.
    this.shapeAspectSqrt = Math.sqrt(this.shape.measured.depth / this.shape.measured.width)
    if (this.fitSlope && !(this.shapeSkirt > 0)) {
      throw new Error(
        `RockBed ${cfg.name}: fitSlope needs a shape with a skirt to hide its rim, and ` +
          `\`${this.shape.name}\` has none`
      )
    }
    // AND HOW SMALL THAT PROBE MAY CUT A PLATE before it gives up and rejects.
    // Deliberately NOT the bottom of `sizeByEnv`, which is where the ROLL starts:
    // on `cliff slabs` the roll starts at nine metres because a panel is a panel,
    // but a candidate whose site can only hold four should place four metres of
    // stone rather than nothing. Every rejection here is a patch of bare wall, so
    // the floor is about the smallest plate worth an instance and not about the
    // bed's subject. Defaults to the roll floor, which is the no-op.
    this.fitFloor = cfg.fitFloor ?? Math.min(
      ...Object.values(cfg.sizeByEnv).map((r) => r[0])
    )

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
    // An accept rate is capped at 1, so a shore gain that pushes one past it is
    // truncated and the shore comes out less than `shoreGain` x thicker with no
    // sign of it. Refuse the config instead.
    if (cfg.shoreGain !== undefined) {
      if (!(cfg.shoreGain >= 1)) throw new Error(`RockBed ${cfg.name}: shoreGain must be >= 1, got ${cfg.shoreGain}`)
      for (const env of ENVIRONMENTS) {
        if (cfg.envDensity[env] * cfg.shoreGain > 1) {
          throw new Error(`RockBed ${cfg.name}: shoreGain ${cfg.shoreGain} x envDensity.${env} ${cfg.envDensity[env]} is over the accept-rate cap of 1`)
        }
      }
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
      // AND NOTHING IN THE WORLD IS SMALLER THAN ROCK_MIN_SIZE. Enforced here
      // rather than trusted to five hand-written ranges, because that is the
      // form the rule keeps: a bed added later gets the floor for free and a
      // range edited down to 0.25 fails at construction instead of quietly
      // laying grit back over the ground.
      if (span[0] < ROCK_MIN_SIZE) {
        throw new Error(
          `RockBed ${cfg.name}: sizeByEnv.${env} starts at ${span[0]} m, under the ` +
            `${ROCK_MIN_SIZE} m floor -- anything smaller is the litter stamps' job, not geometry`
        )
      }
    }

    // THE TOP THE RANGE OPENS TO ON BARREN GROUND, per environment, 0 where the
    // bed has none. Only past the wooded top: a barren top under it would be a
    // range the roll never reaches and a `maxLod` that lies.
    this.barrenTop = { river: 0, forest: 0, cliff: 0, peak: 0 }
    for (const [env, top] of Object.entries(cfg.barrenTop ?? {})) {
      const span = cfg.sizeByEnv[env]
      if (!ENVIRONMENTS.includes(env) || !span || !(top > span[1])) {
        throw new Error(`RockBed ${cfg.name}: barrenTop.${env} must be over sizeByEnv.${env}'s top`)
      }
      this.barrenTop[env] = top
    }

    // THE BOULDER'S LONGEST AXIS AT SCALE 1. Times an instance's scale it is the
    // size a consumer's `minSize` gate reads and the ceiling the size roll is
    // clamped to; the LOD ladder itself reads `instLod`, which is what the
    // instance SHOWS once bedded and squashed. See rockLodSize for why it is
    // neither the width nor the height.
    this.shapeLod = rockLodSize(this.shape.measured)

    // THE BIGGEST ROCK THIS BED CAN PLACE, and through it the distance past which
    // no instance of it can still be on a sampled tier. `update` uses that to
    // skip whole tiles instead of walking them rock by rock -- everything out
    // there is on T6, so one `_demote` says it for the tile.
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
    const hi = Math.max(...envs.map((e) => Math.max(cfg.sizeByEnv[e][1], this.barrenTop[e])))
    // Taking the max of the ends separately is an UPPER bound on the max of the
    // per-environment lines, which is what a bound has to be: each line is
    // (1-r)*lo_e + r*hi_e <= (1-r)*max(lo) + r*max(hi).
    this.lodP = lo * lodPerWidth
    this.lodQ = (hi - lo) * lodPerWidth
    const maxLod = hi
    // Kept, because `_tierCaps` needs the same ceiling to bound how far out each
    // mesh tier can still be worn.
    this.maxLod = maxLod
    const maxFarAt = farAt(maxLod)
    // The margin is the guarantee the bucketed walk leans on: a tile joins the
    // near set before any rock inside can need a mesh tier, so a bucket is
    // pulled forward off its turn once the camera has covered it. See STILL_M.
    this.nearMargin = tile * 1.5
    this.nearSq = (maxFarAt + this.nearMargin) ** 2

    // A BED MAY NOT OUTREACH THE CULL CEILING: every rock's gone-distance is
    // its bed's `radius` (see `_rankOf`), so this is the whole of what holds
    // ROCK_LOD_GONE_MAX. Refused rather than clamped, so the table says the
    // reach the bed really has.
    if (cfg.radius > ROCK_LOD_GONE_MAX) {
      throw new Error(
        `RockBed ${cfg.name}: radius ${cfg.radius} m is past ROCK_LOD_GONE_MAX (${ROCK_LOD_GONE_MAX} m), ` +
          `beyond which no rock may be drawn. Shrink \`radius\`.`
      )
    }

    // A BED MAY NOT END BEFORE ITS OWN LADDER DOES. `_rankOf` guarantees no rock
    // is thinned away while it is still sampled, but it cannot help one that runs
    // out of BED first: past `radius` the tiles are not resident at all, so a bed
    // whose reach is shorter than its biggest rock's far distance culls that rock
    // outright, mid-ladder. The two numbers are authored independently -- `radius`
    // by how far the feature reads across a valley, the far distance by
    // `sizeByEnv` times ROCK_LOD_AT, or ROCK_LOD_FAR_MAX if that is sooner -- so
    // nothing but this stops them drifting
    // apart, and it has caught a real one: a bed with 10 m rocks wanting 250 m of
    // reach against a 170 m radius killed one rock in six as an LOD2 mesh at the
    // bed edge.
    //
    // `farGoneAt` is the figure `_fadeFloor` works to, for the same reason: T6 is
    // meant to be whole for a `ROCK_FAR_LIFE` band past the distance it takes
    // over at, and the dissolve at `radius` STARTS at 0.85 of it. A reach of
    // exactly the far distance has the biggest rocks dithering while they are
    // still sampled; a reach of the far distance times the band has them
    // dithering the instant they reach T6, which measured at 60% of that same bed.
    const minReach = farGoneAt(maxLod)
    if (cfg.radius < minReach) {
      throw new Error(
        `RockBed ${cfg.name}: radius ${cfg.radius} m is inside its own far distance ` +
          `(${maxFarAt.toFixed(1)} m, needing ${minReach.toFixed(1)} m once the ${ROCK_FAR_LIFE}x ` +
          `far band and the dissolve band are allowed for) -- its biggest rocks would ` +
          `dissolve as sampled meshes, or the instant they reached T6, at the bed edge. ` +
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
    // A perch bed hands out its hull radius and is walked over by blockTopAt, so
    // it has to be a blocking bed too -- see Rocks.perchesInto.
    this.perch = cfg.perch ?? false
    if (this.perch && !this.blocks) {
      throw new Error(`RockBed ${cfg.name}: \`perch\` without \`blocks\` -- a crab can only walk a rock blockTopAt can see`)
    }
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
      this.footRadius = sectionRadius(this.shape.tiers[0], this.shape.measured.height * midSink, this.shape.name)
    }

    this.maxInstances = this._poolBound()
    // What this bed asks of each tier's shared mesh; `Rocks` sums them.
    this.tierCaps = this._tierCaps()

    // THE TIER TABLE, one triangle count per band; the arena ids come with
    // `attach`. The last slot is the 6-triangle T6 hull and NO BED DECLINES IT.
    const geos = this.shape.tiers
    this.tierTris = new Int32Array(ROCK_BAND_COUNT)
    for (let t = 0; t < ROCK_BAND_COUNT; t++) {
      // Throw rather than count 0: a silent 0 here would show up as a triangle
      // budget that quietly stops counting.
      const meta = geos[t].userData.rock
      if (!meta) throw new Error(`RockBed ${cfg.name}: tier ${t} is not a rock mesh`)
      this.tierTris[t] = meta.triangles
    }
    this.batch = null
    this.tierIds = null
    this.free = null
    this.freeCount = 0
    this.rim = null

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
    this.instLod = new Float32Array(this.maxInstances)
    // THE PLACEMENT MATRIX, per instance, which every tier takes. Kept here so a
    // cross-dissolve ghost and a re-ground can be written from it (`_placeTier`)
    // and `_spanAt` can read it without going through the arena.
    this.instM = new Float32Array(this.maxInstances * 16)
    // Cross-dissolves in flight: { orig, dup, start, tris, tier }. `fadeAt` maps
    // an instance to its entry so a second band crossing can finish the first,
    // and so an instance being thinned or evicted can take its ghost with it;
    // `ghostsAt` counts them per departing tier against `ghostRoom`.
    this.fades = []
    this.fadeAt = new Int32Array(this.maxInstances).fill(-1)
    // A hollow bed keeps each boulder's own colour, so the debug tint (setTint) can be put on and taken off a standing rock.
    this.natural = cfg.hollow ? new Float32Array(this.maxInstances * 3) : null
    this.tint = null
    this.fadeTris = 0
    this.ghostsAt = new Int32Array(ROCK_BAND_COUNT)

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
      // WHAT THE GROUND ANSWERED, on a packing bed only. Its placement pass runs
      // twice -- once to ask every candidate what size its own site holds, then
      // again in the order those answers put them in -- and the second run must not
      // pay for the field samples the first one already took. `fit` doubles as the
      // liveness flag: zero is a candidate some test rejected.
      fit: this.packCaps ? new Float32Array(per) : null,
      h: this.packCaps ? new Float32Array(per) : null,
      tan: this.packCaps ? new Float32Array(per) : null,
      snow: this.packCaps ? new Float32Array(per) : null,
      env: this.packCaps ? new Array(per) : null,
    }
    this._order = []

    this.tiles = new Map()
    this.queue = []
    this.camTileX = null
    this.camTileZ = null
    // Height above ground the live reach was last computed for, quantised to
    // whole tiles. Null so the first `_reseat` cannot be skipped.
    this.camAglQ = null

    this._m = new THREE.Matrix4()
    // The rolled, squashed, scaled box `_m` is composed over; see `_growTile`.
    this._rm = new THREE.Matrix4()
    this._scatter = { h: 0, tan: 0 }
    this._q = new THREE.Quaternion()
    this._yawQ = new THREE.Quaternion()
    this._tiltQ = new THREE.Quaternion()
    this._rollQ = new THREE.Quaternion()
    this._rollXQ = new THREE.Quaternion()
    this._leanQ = new THREE.Quaternion()
    this._leanAxis = new THREE.Vector3()
    this._xAxis = new THREE.Vector3(1, 0, 0)
    this._zAxis = new THREE.Vector3(0, 0, 1)
    this._c = new THREE.Color()
    this._n = new THREE.Vector3()
    this._up = new THREE.Vector3(0, 1, 0)
    // The chunk mesher writes three floats here per placed rock; see GROUND_CUE.
    this._gc = new Float32Array(3)

    // The resident tiles again, as dense arrays the walk can run without the
    // Map: one bucket per rim phase, and what must be walked next frame whatever
    // its bucket says. Each tile carries its bucket index (`bi`) for O(1)
    // swap-removal. See STILL_M.
    this.buckets = Array.from({ length: RIM_PHASES }, () => [])
    this.due = []
    // Per bucket: where the camera stood, the rim's `need` and the ground
    // version at its last walk -- what decides whether the next can be skipped.
    this.bucketX = new Float64Array(RIM_PHASES)
    this.bucketY = new Float64Array(RIM_PHASES)
    this.bucketZ = new Float64Array(RIM_PHASES)
    this.bucketNeed = new Float32Array(RIM_PHASES)
    this.bucketGver = new Int32Array(RIM_PHASES).fill(-1)
    // The first update walks every tile; nothing after construction moves every
    // tile's answer at once (a reseat evicts and grows, and what survives it is
    // walked on its turn).
    this.walkAll = true

    // Instances drawn on each rung, as running totals because the tiles are not
    // walked every frame; `tile.tierN` is each one's share as of its last walk,
    // and `_walkN` is the scratch a walk counts into. Readouts only: nothing
    // branches on them. `tris` is the triangles those draw plus the ghosts'.
    this.tileTierN = new Int32Array(ROCK_BAND_COUNT)
    this._walkN = new Int32Array(ROCK_BAND_COUNT)
    this.tris = 0
    this.walked = 0
    this.placed = 0
    this.samples = 0
    this.regrows = 0
    this.regrounds = 0
    this.sited = { foot: 0, brow: 0 }
    this.rejected = { elev: 0, slope: 0, flat: 0, water: 0, env: 0, clump: 0, foot: 0, shore: 0, deep: 0, gap: 0, road: 0, fit: 0, pool: 0 }
    this.poolDry = false
    this.placeMs = 0
    this.lastBuildMs = 0
  }

  /**
   * Take a view over the shared mesh set, in which this bed's shape is variant
   * `variant` of every tier.
   */
  attach(shared, variant) {
    this.batch = PropArena.over(shared, this.maxInstances, `v2-rocks-${this.cfg.name}`)
    this.tierIds = new Int32Array(ROCK_BAND_COUNT)
    for (let t = 0; t < ROCK_BAND_COUNT; t++) this.tierIds[t] = t * shared.variantCount + variant

    // BORN ON T6, matching what `_growTile` writes: a pool id that somehow
    // reached the arena visible before it was placed would otherwise land in the
    // tier-0 mesh, whose cap is sized for the handful of rocks inside four ladder
    // sizes rather than for the pool.
    this.free = new Int32Array(this.maxInstances)
    this.freeCount = this.maxInstances
    for (let i = 0; i < this.maxInstances; i++) {
      const id = this.batch.addInstance(this.tierIds[ROCK_BAND_COUNT - 1])
      this.free[this.maxInstances - 1 - i] = id
    }

    // The rim dissolve: which rocks are drawn, which are hidden, and the quarter
    // second between. It holds each rock's gone-distance as `rim.gone`, and it
    // shares ONE float per instance with the cross-dissolve in `_crossFade` --
    // so it is handed the callback that retires a swap it is about to write
    // over, and `_crossFade` asks `isBusy` before starting one the rim would
    // clobber.
    this.rim = new RimFade(this.batch, this.maxInstances, (id) => {
      const running = this.fadeAt[id]
      if (running >= 0) this._endFade(running)
    })
  }

  /** See Trees._poolBound: summed over the real tile grid, because the law is not exact. */
  _poolBound() {
    return poolBound(this.tile, this.tileSpan, this.evictSq, 1.35,
      (d2) => this.perTile * this.siteFrac * this._keepFrac(this._levelFor(d2)))
  }

  /**
   * How many instances ONE tier's mesh has to hold. PropArena gives every tier
   * an InstancedMesh of its own and a mesh that fills REFUSES the next arrival
   * (a rock held one rung too coarse), so these are bounds and not estimates --
   * and they are also what the layer costs in memory, since a cap is allocated
   * whether it ever fills or not.
   *
   * THE FAR TIER IS THE POOL, exactly. Every rock is born on T6 (_growTile)
   * and `_demote` puts every tile outside `nearSq` wholly back on it, so a bad
   * frame is the whole pool on T6. It can be no MORE than the pool either: a
   * cross-dissolve's ghost comes off `free` and is a pool id like any other.
   *
   * A MESH TIER IS BOUNDED BY THE LADDER AND NOT BY THE POOL, and that is the
   * whole saving -- 52k mesh slots across the eight beds against the 323k a pool
   * apiece would have cost. Tier `b` holds an instance only while its camera
   * distance is under `size * ROCK_LOD_AT[b]`, times the hysteresis slack it
   * leaves on. So the bound is the pool law summed over THAT radius rather than
   * the bed's, with each tile's contribution scaled by the fraction of size rolls
   * big enough to be on the tier at that distance. `_exemptFrac` already inverts
   * that line -- it answers "what fraction of rolls put `farGoneAt` past d
   * metres", and `farGoneAt` is linear in the size, so dividing the distance by
   * one ladder rung and multiplying by another re-aims it at any rung wanted.
   *
   * DROPPING THE KEEP-FRACTION IS DELIBERATE and is what makes this sound without
   * an argument about correlation: thinning removes small rocks first, so kept and
   * on-tier are not independent, but P(kept AND on tier b) <= P(on tier b) however
   * they lean.
   *
   * The tile is added to the reach because poolBound counts whole tiles by their
   * centres, and TIER_HEADROOM is poolBound's headroom, which is the ghosts'
   * share: a cross-dissolve ghost sits in the mesh of the tier its rock LEFT,
   * and `_crossFade` starts one only while that tier's ghosts are under
   * `ghostRoom`, the cap less the population's share. A ghost that took a
   * population slot would have the next real arrival refused its tier, so
   * overrunning the room costs a pop rather than a coarse rock. The far tier's
   * cap is the pool, and every ghost is a pool id, so it has no room to keep.
   */
  _tierCaps() {
    const perRoll = farGoneAt(1)
    const caps = []
    this.ghostRoom = new Int32Array(ROCK_BAND_COUNT).fill(this.maxInstances)
    for (let b = 0; b < ROCK_BAND_COUNT - 1; b++) {
      const rung = ROCK_LOD_AT[b] * (1 + LOD_HYSTERESIS)
      // No mesh tier is worn past the far ceiling whatever the size roll.
      const reach = Math.min(this.maxLod * rung, ROCK_LOD_FAR_MAX) + this.tile
      const bound = poolBound(this.tile, Math.ceil(reach / this.tile) + 1, reach * reach, TIER_HEADROOM,
        (d2) => this.perTile * this.siteFrac * this._exemptFrac((Math.sqrt(d2) / rung) * perRoll))
      const cap = Math.min(this.maxInstances, Math.max(64, bound))
      caps.push(cap)
      this.ghostRoom[b] = cap - Math.ceil(cap / TIER_HEADROOM)
    }
    caps.push(this.maxInstances)
    return caps
  }

  /**
   * The fraction of a tile's candidates that survive at ladder level `level`:
   * everything inside `fullRadius`, and past it the size rolls whose own far
   * band reaches the level's distance (`_rankOf`). `_fadeFloor` over-states, so
   * this is an upper bound and the pool over-allocates rather than runs dry.
   */
  _keepFrac(level) {
    if (level === 0) return 1
    return this._exemptFrac(this.fullRadius / this.uAt[level])
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
    const perRoll = farGoneAt(1)
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
   * far tier takes over at.
   *
   * Three terms, all in `farGoneAt`. `size * ROCK_LOD_AT.at(-1)` is how far the
   * rock can still be sampled; `ROCK_FAR_LIFE` is the span T6 is then whole for;
   * the `/ FADE_BAND` is not a fudge -- the rim starts its dissolve SHORT of the
   * gone-distance it is handed, so handing it the far distance would have the
   * rock dithering before it ever reaches T6. See `farGoneAt` for why the divisor
   * is the old band rather than the rim's actual `RIM_AT` trigger.
   *
   * An upper bound rather than the exact figure, because the exact one needs the
   * environment and this is wanted in pass one, before the field sample that
   * decides it. It takes the widest size range over every environment the bed can
   * reach, so it over-states a candidate that lands in a small-rock environment
   * and never under-states one: over-stating keeps a few rocks slightly too long,
   * under-stating would cull one before it ever reaches T6.
   */
  _fadeFloor(sizeRoll) {
    return farGoneAt(this.lodP + sizeRoll * this.lodQ)
  }

  /**
   * THE RANK A ROCK IS THINNED BY, AND IT IS ITS SIZE. A tile at level q keeps
   * exactly `{rank <= uAt[q]}` and `uAt[q] = fullRadius / d_q`, so a rock is
   * placed only inside the greater of `fullRadius` and its own gone-distance --
   * the distance the rim would have finished dissolving it at anyway. Inside
   * `fullRadius` every size stands; past it the pile thins from the small end
   * up, the 4.5 m block outliving the cobbles by a hundred metres, and a tile
   * beyond the bed's biggest gone-distance holds nothing at all.
   *
   * That is what sizes the pool: a tile's survivors at a distance are the size
   * rolls whose far band reaches it (`_keepFrac`), not a random slice of the
   * lot, so a scree bed reserves for its blocks over 130 m and its cobbles over
   * 40 rather than for 196 rocks a tile over 280.
   *
   * A rock lives until it is on T6 by construction: the gone-distance is
   * `_fadeFloor`, which is past the far rung, and nothing dissolves earlier.
   *
   * ONE NUMBER FOR ALL THREE CONSUMERS: the tile ladder (`_thin`), the pool bound
   * and the shader's dissolve distance all read this and nothing else, so the
   * CPU's decision to drop a rock and the shader's decision to have finished
   * fading it cannot drift apart -- which is what keeps the thinning a dither
   * rather than a pop. The `<=` matters: a rock the ladder cannot reach past
   * `fullRadius` ranks exactly 1, which is level zero's own `uAt`.
   */
  _rankOf(sizeRoll) {
    return this.fullRadius / Math.max(this.fullRadius, this._fadeFloor(sizeRoll))
  }

  /**
   * The size roll, bent by `sizeBias` -- or thrown away entirely by `fitFromTop`,
   * both argued where they are set.
   *
   * ONE FUNCTION BECAUSE TWO PASSES READ IT. Pass one ranks a candidate by the
   * size it is about to be, pass two sizes it; if those disagree a bed places
   * panels the ladder culls at a distance their own mesh is still drawn at, and
   * they pop in. Neither caller may compute this itself.
   */
  _sizeRoll(scaleRoll) {
    if (this.fitFromTop) return 1
    return this.sizeBias === 1 ? scaleRoll : Math.pow(scaleRoll, this.sizeBias)
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
   * Where a `deep` bed's one candidate goes in tile (tx, tz), or null when no
   * point INSET metres in from its edge is `deep` metres from open ground.
   *
   * The tile is sampled on a DEEP.step grid; a cell is wood when the forest
   * law (layers/forest.js, the definition trees.js and the terrain tint share)
   * keeps at least DEEP.keep of its trees there, and it is not under water, on
   * a road or on flattened ground. A two-pass chamfer over the grid gives
   * every cell its distance to the nearest open cell; ground past the tile's
   * edge is unscanned and counts as wood, so a wood that runs out of the tile
   * is measured only to the open ground inside it. The site is the deepest
   * inset cell, ties to the one nearest the tile's middle.
   */
  _deepSite(tx, tz) {
    const n = this._deepN
    const dist = this._deepDist
    const tile = this.tile
    const step = DEEP.step
    const x0 = tx * tile, z0 = tz * tile
    const g = this._scatter
    let open = 0
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * step, z = z0 + j * step
        this.field.scatterAt(x, z, PLACEMENT_CELL, g)
        const level = this.water.levelAt(x, z)
        const wet = level !== null && g.h < level + SHORE_RISE
        const wood = !wet && this.layers.flattenAt(x, z) === 0 &&
          forestKeepAt(g.h, g.tan, g.h - this.field.snowLineAt(x, z), this.biome, x, z) >= DEEP.keep
        dist[j * n + i] = wood ? Infinity : 0
        if (!wood) open++
      }
    }
    const diag = step * Math.SQRT2
    if (open > 0) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i
          if (i > 0) dist[k] = Math.min(dist[k], dist[k - 1] + step)
          if (j > 0) {
            dist[k] = Math.min(dist[k], dist[k - n] + step)
            if (i > 0) dist[k] = Math.min(dist[k], dist[k - n - 1] + diag)
            if (i < n - 1) dist[k] = Math.min(dist[k], dist[k - n + 1] + diag)
          }
        }
      }
      for (let j = n - 1; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
          const k = j * n + i
          if (i < n - 1) dist[k] = Math.min(dist[k], dist[k + 1] + step)
          if (j < n - 1) {
            dist[k] = Math.min(dist[k], dist[k + n] + step)
            if (i < n - 1) dist[k] = Math.min(dist[k], dist[k + n + 1] + diag)
            if (i > 0) dist[k] = Math.min(dist[k], dist[k + n - 1] + diag)
          }
        }
      }
    }
    const lo = Math.ceil(DEEP.inset / step), hi = n - 1 - lo
    const mid = (n - 1) / 2
    let best = -1, bestD = 0, bestC = Infinity
    for (let j = lo; j <= hi; j++) {
      for (let i = lo; i <= hi; i++) {
        const d = dist[j * n + i]
        if (d < this.deep) continue
        const c = Math.hypot(i - mid, j - mid)
        if (d > bestD || (d === bestD && c < bestC)) { best = j * n + i; bestD = d; bestC = c }
      }
    }
    if (best < 0) return null
    return { x: x0 + (best % n) * step, z: z0 + ((best / n) | 0) * step }
  }

  /**
   * Whether a rock `width` metres across at a site has nothing but bare ground
   * under it -- see BARREN_ABOVE_SNOW. The site's own sample is already in, so
   * the face test is the four points half a width out along the axes.
   */
  _barrenAt(x, z, h, snowLine, width) {
    if (h - snowLine > BARREN_ABOVE_SNOW) return true
    const r = width / 2
    const g = this._scatter
    return this.field.scatterAt(x + r, z, PLACEMENT_CELL, g).tan > CLIFF_TAN &&
      this.field.scatterAt(x - r, z, PLACEMENT_CELL, g).tan > CLIFF_TAN &&
      this.field.scatterAt(x, z + r, PLACEMENT_CELL, g).tan > CLIFF_TAN &&
      this.field.scatterAt(x, z - r, PLACEMENT_CELL, g).tan > CLIFF_TAN
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
   * `_relief` for the RELIEF_CELL cell a candidate stands in, evaluated at that
   * cell's centre and remembered for the rest of the tile. See RELIEF_CELL.
   *
   * The caller passes the tile it is filling, because the memo is indexed by the
   * cell's position WITHIN that tile -- `_growTile` clears it on entry, so an
   * answer cannot outlive the tile it was taken in. `h` is not passed: the point
   * this answers about is the cell centre and not the candidate, so the height has
   * to be the centre's too.
   */
  _reliefAt(x, z, tx, tz) {
    this.reliefAsks++
    const n = this.reliefN
    const cx = ((x - tx * this.tile) / RELIEF_CELL) | 0
    const cz = ((z - tz * this.tile) / RELIEF_CELL) | 0
    const i = cz * n + cx
    const seen = this.reliefMemo[i]
    if (seen !== 0) return seen === 1 ? null : seen === 2 ? 'foot' : 'brow'
    this.reliefs++
    const px = tx * this.tile + (cx + 0.5) * RELIEF_CELL
    const pz = tz * this.tile + (cz + 0.5) * RELIEF_CELL
    const site = this._relief(px, pz, this.field.heightAt(px, pz))
    this.reliefMemo[i] = site === null ? 1 : site === 'foot' ? 2 : 3
    return site
  }

  /**
   * How much of a plate this spot can actually hold: 1 if the whole footprint
   * stands on the face, a smaller factor if it only does once cut down, and 0 if
   * it does not even at `fitFloor`. Only `fitSlope` beds call it.
   *
   * ONE TEST AT EVERY RIM POINT, AND IT IS ABOUT THE PLANE AND NOT THE SLOPE.
   *
   *   WHY NOT THE SLOPE WINDOW. Asking every rim point to be inside the bed's own
   *   45-85 degrees sounds like the same question and is a far harsher one: a
   *   thirty-metre circle on real ground almost always touches one softer cell,
   *   so the ladder kept shrinking until the footprint fitted between the
   *   heightmap's wrinkles and the bed laid eleven-metre plates on faces that
   *   hold seventy. Measured on three real faces it was worth 0.05, 0.07 and 0.20
   *   of cover against 0.26, 0.75 and 1.02 without it -- the bare walls. It also
   *   asks nothing the test below does not: ground softer than the face FALLS
   *   AWAY from the plate's plane, which is exactly what the plane test rejects,
   *   and ground that merely rises into the plate is a rim let into the hill.
   *
   *   THE PLANE, THEN. A cap is a flat shell laid in the tangent plane
   *   under its CENTRE, and the slope window says nothing about what the ground
   *   does between there and the rim: a face that is 60 degrees at the middle and
   *   60 again eight metres out can still fall away by metres in between, or
   *   round over a brow, and the plate then stands off the hill with its open
   *   underside pointing at the player. That is the one way this shape reads as a
   *   decal and it is what this test forbids. `gx`/`gz` is the same central
   *   difference `_groundTilt` aligns the instance with, so `h0 + gx*dx + gz*dz`
   *   is literally the plate's own plane. The rim may stand above the real ground
   *   only by as far as the shell reaches under that plane, which the caller
   *   measures for it as `dropPerSpan`: the burial plus the skirt, the curtain the
   *   shape hangs below its own bed plane (see CAP in props/rock-bank.js).
   *
   *   PERPENDICULAR METRES ON BOTH SIDES OF THAT COMPARISON, which is the one
   *   thing here that is easy to get wrong and expensive when you do. The shell
   *   has depth along its OWN NORMAL, not along world Y, so the gap it can seal at
   *   a rim point is the height difference divided by `nrm` -- and on an 85 degree
   *   face `nrm` is eleven. Comparing the raw vertical difference against a budget
   *   the caller had already tilted the other way made the test roughly a hundred
   *   times too strict there, and the ladder answered by refusing a plate outright
   *   on half the steepest wall. Both terms are linear in the size, so the budget
   *   is quoted per metre of span and the
   *   ladder re-reads it at every rung -- a plate is never rescued by a burial it
   *   no longer has.
   *
   *   AND THE OTHER SIDE OF THE PLANE IS THE EDGE OF THE FACE. Ground ABOVE the
   *   plane buries the rim, which is what a panel of a wall should be, and used to
   *   go untested for that reason. Untested it has no edges: at the foot of a cliff
   *   the plate's plane keeps falling while the ground levels off, so the valley
   *   floor is above the plane, every rim down there reads as buried, and a plate
   *   grows across the whole hillside with most of itself underground. `fitBury`
   *   bounds it, in the same perpendicular metres per metre of span, and that bound
   *   is what turns the ladder's answer into a measurement of the CONTIGUOUS FACE
   *   this candidate is standing on -- which is the size the bed is really asking
   *   for. A bed that leaves it Infinity gets the old behaviour and pays nothing.
   *
   * WHY IT SHRINKS RATHER THAN REJECTS, which is the difference between a bed
   * that can be authored at seventy metres and one that cannot. The test asks
   * about a whole footprint at once, so a big draw on a face that is merely large
   * fails it. Rejecting means the only plates that ever land big are the ones
   * that drew big AND landed on the rare face that holds them, so the bed has to
   * run dense enough to hit that coincidence and pays for the density everywhere
   * -- and every rejection is a patch of bare wall. Shrinking turns the roll into
   * a REQUEST and lets the ground answer it: every candidate becomes the biggest
   * plate its own site can carry, so the sizes vary because the FACES vary.
   *
   * AND IT IS WALKED FROM THE TOP RATHER THAN BISECTED, which looks backwards --
   * the sizes this bed settles on are near the bottom of a sixteen-rung ladder, a
   * 13 m median against a 70 m top, so a walk pays twelve probes where bisection
   * pays five. The probes are not the same price. A FAILING rung breaks out of the
   * rim loop at the first bad sample, one or two of twelve; a PASSING one always
   * pays all twelve. The walk's dozen failures are nearly free and it buys exactly
   * one success, where bisection buys two or three. Measured on the steepest real
   * face it is 4.6 s against 5.2 s, so the obvious optimisation is a 13% loss.
   *
   * TWELVE RIM POINTS. Four caught a plate hanging off a straight edge and missed
   * one bridging a gully between two ribs, which is the failure that was actually
   * visible; eight still left 22.5 degrees of azimuth between samples, and a
   * hollow that falls exactly there is worth about 4% of the plate's span in
   * overhang -- measured, on the folded fixture check-rocks.mjs builds for it.
   * Twelve halves that to 15 degrees and 2%, which is inside the skirt. It is a
   * SAMPLED test either way and no count makes it exact, which is why the check
   * bounds the overhang rather than asserting zero. They are on the radius rather
   * than inside it because a footprint that clears at its own rim clears
   * everywhere inside it on ground that is one face.
   */
  _fitFactor(x, z, yaw, span, dropPerSpan, ids, n) {
    const e = 1.5
    const h0 = this.field.heightAt(x, z)
    const gx = (this.field.heightAt(x + e, z) - this.field.heightAt(x - e, z)) / (2 * e)
    const gz = (this.field.heightAt(x, z + e) - this.field.heightAt(x, z - e)) / (2 * e)
    // The plate's own plane, tilted off horizontal by this much: 1/cos, so it is
    // what turns a VERTICAL height difference into the PERPENDICULAR one the shell
    // has to seal. See the doc -- everything below is measured off the plane.
    const nrm = Math.hypot(gx, gz, 1)
    let r = span * 0.5
    const floor = this.fitFloor * 0.5
    const bury = this.fitBury
    for (;;) {
      const budget = dropPerSpan * (r * 2)
      const buried = bury * (r * 2)
      let fits = true
      for (let j = 0; j < 12; j++) {
        const fa = yaw + j * (Math.PI / 6)
        const px = x + Math.cos(fa) * r
        const pz = z + Math.sin(fa) * r
        const stand = (h0 + gx * (px - x) + gz * (pz - z) - this.field.heightAt(px, pz)) / nrm
        if (stand > budget || -stand > buried) {
          fits = false
          break
        }
      }
      // THE DART IS THE THIRD TEST AND IT IS ON THE SAME LADDER, which is the
      // whole reason it is in here rather than in its own block: "as large as the
      // site allows" and "not through the neighbours" are one question, and asked
      // separately they fight. Fit first then dart leaves a plate the dart shrank
      // standing on ground the fit was never asked about; dart first then fit
      // shrinks a plate back through a gap it had already cleared. One rung, both
      // answers, first size that satisfies every test wins.
      if (fits) fits = !this._dartBlocked(x, z, r * 2, ids, n)
      else this._fitFail = 'fit'
      if (fits) return (r * 2) / span
      if (r <= floor) return 0
      r = Math.max(floor, r * FIT_SHRINK)
    }
  }

  /**
   * What fraction of a plate of face radius `r`, centred on the ground at
   * (x, y, z), would be wall that no plate already standing here covers. 1 on
   * open face, 0 inside a bigger plate. The caller compares it against
   * `packEarn`.
   *
   * DISC AREAS, WHICH IS THE WHOLE TEST. Every plate is already modelled as the
   * disc of equal footprint area in the face it lies in (`_faceRadius`), so what
   * a neighbour takes from this candidate is the circle-circle lens: closed form,
   * two acos and a root, and only for the neighbours that actually reach. The
   * cheap squared-distance guard in front of it means a typical candidate pays
   * the trig for a handful of plates out of the few hundred resident.
   *
   * THE OVERLAPS ARE SUMMED AND NOT UNIONED, which over-counts wherever two
   * neighbours cover the same piece of this candidate, so the earnings come back
   * LOW. Deliberately the cheap direction: a union needs the pairwise geometry of
   * the neighbours with each other, and being wrong this way refuses a plate that
   * was marginal rather than admitting one that was not. Exact in the case that
   * decides most of them, which is a plate against the one big panel beside it.
   *
   * THE DISTANCE IS THE THREE-DIMENSIONAL ONE AND THIS IS NOT A DETAIL. Measured
   * on the MAP instead, two plates a hundred metres apart up an eighty-five degree
   * wall sit within a couple of metres of each other, so a plan-frame test reads a
   * column of plates clothing a face as one plate swallowing eight. A wall is a
   * surface, the plates lie IN it, and the area they are earning is its area.
   * Across a ridge the straight line is shorter than the walk, so two plates on
   * opposite faces read as taking slightly more from each other than they do; that
   * is the cheap direction to be wrong in and it costs a seam nobody can see from
   * either side.
   *
   * IT LOOKS AT EVERY NEIGHBOUR AND NOT ONLY THE BIGGER ONES. The pass runs in the
   * size order the ground handed out, so everything already standing is by
   * construction at least as big as the candidate asking -- but a plate the ground
   * cut small still masks real wall, and wall it masks is wall this candidate
   * cannot be paid for twice.
   *
   * AND IT CROSSES THE TILE SEAM, alone in this file. `_dartBlocked` deliberately
   * does not: a dart across a seam makes a tile's layout depend on which of its
   * neighbours happened to be grown first, which is to say on the route the player
   * walked. The panels cannot afford that principle, because their footprints are
   * TENS OF METRES against a 220 m tile -- a plate a metre inside the seam has most
   * of its earnings on the far side of it. What the crossing costs is exactly that
   * route dependence, and it costs nothing else: no field sample, only a walk of
   * instances already placed. It is also INVISIBLE. A tile is grown when its centre
   * first comes inside `radius` -- 4.2 km, twice the 2.1 km where even a top-size
   * plate has already dissolved -- and evicted 330 m further out still, so no plate
   * is ever judged while anything is drawing it.
   */
  _earnedFrac(x, y, z, r, ids, n, tx, tz) {
    const mine = r * r
    let taken = 0
    const one = (o) => {
      if (taken >= mine) return
      const dx = this.instX[o] - x
      // The GROUND the neighbour is standing on, which is what `instY` is minus
      // the burial that was taken off it. Comparing origins instead would make a
      // deeply sunk plate read as further away than it is.
      const dy = this.instY[o] + this.instSink[o] - y
      const dz = this.instZ[o] - z
      const d2 = dx * dx + dy * dy + dz * dz
      const ro = this._faceRadius(this.instSpan[o])
      const sum = r + ro
      if (d2 >= sum * sum) return
      const gap = r - ro
      if (d2 <= gap * gap) {
        // One disc inside the other. Whichever is smaller is wholly covered, and
        // when that is the candidate it has earned nothing at all.
        taken += Math.min(r, ro) ** 2
        return
      }
      const d = Math.sqrt(d2)
      // The two half-angles of the lens. The guards above put both cosines
      // strictly inside (-1, 1); the clamp is for the ulp at the boundary, where
      // acos would hand back NaN and a NaN in `taken` would silently refuse every
      // plate on the face.
      const ca = Math.min(1, Math.max(-1, (d2 + r * r - ro * ro) / (2 * d * r)))
      const cb = Math.min(1, Math.max(-1, (d2 + ro * ro - r * r) / (2 * d * ro)))
      taken +=
        (r * r * Math.acos(ca) +
          ro * ro * Math.acos(cb) -
          0.5 * Math.sqrt((sum - d) * (d + gap) * (d - gap) * (sum + d))) /
        Math.PI
    }
    for (let j = 0; j < n; j++) one(ids[j])
    // ONE RING IS THE WHOLE REACH: the biggest plate this bed can author is 70 m
    // across, so a neighbour can only take area inside 2 * _faceRadius(70) -- 55 m
    // against a 220 m tile -- and no second ring can reach.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue
        const t = this.tiles.get((tx + di) * 0x10000 + (tz + dj))
        if (!t) continue
        for (let j = 0; j < t.n; j++) one(t.ids[j])
      }
    }
    return Math.max(0, 1 - taken / mine)
  }

  /**
   * The radius of the circle covering as much of the FACE as a plate of this span
   * does. The footprint is a `span` by `span * aspect` ellipse in the plate's own
   * plane; equal AREA rather than equal shape is what lets one number stand for it
   * whichever way the yaw turned it.
   */
  _faceRadius(span) {
    return 0.5 * span * this.shapeAspectSqrt
  }

  /**
   * Is a footprint of `span` at (x, z) inside the dart of anything already
   * standing in this tile? Shared by the plain reject path and by `_fitFactor`'s
   * ladder, so the two can never drift apart on what "too close" means.
   *
   * `gapBySize` is argued where it is set in the constructor; what the dart does
   * and does not promise across a tile seam is at the call site in _growTile.
   */
  _dartBlocked(x, z, span, ids, n) {
    if (!(this.minGap > 0)) return false
    // ROUNDED TO THE PRECISION IT WILL BE STORED AT before anything is compared
    // against it. `instSpan` is a Float32Array and `span` here is a double off the
    // fit ladder, so two plates the ladder cut to the very same rung compare
    // UNEQUAL -- the stored one rounds down -- and `gapBySize` reads that as "the
    // neighbour is smaller" and waves the dart. It is not a rare tie either: with
    // `fitFromTop` every candidate walks the same ladder from the same top, so
    // equal spans are the common case and this was letting seventeen-metre panels
    // land half a metre apart.
    const mine = Math.fround(span)
    for (let j = 0; j < n; j++) {
      const o = ids[j]
      if (this.gapBySize && this.instSpan[o] < mine) continue
      const dx = this.instX[o] - x
      const dz = this.instZ[o] - z
      const need = this.minGap * 0.5 * (span + this.instSpan[o])
      if (dx * dx + dz * dz < need * need) {
        this._fitFail = 'gap'
        return true
      }
    }
    return false
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
    // Standing on the ground, so the full reach: a synchronous place is asked for
    // when something wants the bed complete, not when something is flying over it.
    this._reseat(cx, this.field.heightAt(cx, cz), cz)
    while (this.queue.length) this._growTile(this.queue.pop())
    this.placeMs = performance.now() - t0
    return this.placed
  }

  update(camX, camY, camZ, budgetMs) {
    this._reseat(camX, camY, camZ)

    const t0 = performance.now()
    while (this.queue.length && performance.now() - t0 < budgetMs) this._growTile(this.queue.pop())
    this.lastBuildMs = performance.now() - t0

    // Retire finished cross-dissolves BEFORE the tile walk starts new ones, so a
    // rock that swaps a band on the same frame its previous fade expires gets
    // its duplicate back rather than being refused for want of one.
    const now = getPropClock()
    this._sweepFades(now)
    this.rim.beginFrame(camX, camY, camZ)

    const gver = this.ground ? this.ground.groundVersion : 0
    const need = this.rim.need
    const turn = this.rim.phase
    // Instances the per-rock ladder walks THIS frame -- the O(instances) part of
    // the bill, which the resident-tile count alone does not show.
    this.walked = 0
    for (let p = 0; p < RIM_PHASES; p++) {
      const mx = camX - this.bucketX[p]
      const my = camY - this.bucketY[p]
      const mz = camZ - this.bucketZ[p]
      const moved2 = mx * mx + my * my + mz * mz
      const walk = this.walkAll
        || (p === turn && (moved2 >= STILL_M * STILL_M || this.bucketGver[p] !== gver))
        || need > this.bucketNeed[p]
        || moved2 >= this.nearMargin * this.nearMargin
      if (!walk) continue
      this.bucketX[p] = camX
      this.bucketY[p] = camY
      this.bucketZ[p] = camZ
      this.bucketNeed[p] = need
      this.bucketGver[p] = gver
      const bucket = this.buckets[p]
      for (let k = 0; k < bucket.length; k++) this._walkTile(bucket[k], camX, camY, camZ, gver, now)
    }
    // Grown, thickened or thinned since the last update: placed hidden until a
    // sweep looks at them. Already covered when every bucket was walked;
    // otherwise a tile can still be in a bucket walked above, and the second
    // walk finds nothing to do.
    const due = this.due
    for (let k = 0; k < due.length; k++) {
      due[k].due = false
      if (!this.walkAll) this._walkTile(due[k], camX, camY, camZ, gver, now)
    }
    due.length = 0
    this.walkAll = false

    // The duplicates are drawn too; `tileTierN` is exact as of each tile's last
    // walk, so up to RIM_PHASES frames stale.
    let tris = this.fadeTris
    for (let b = 0; b < ROCK_BAND_COUNT; b++) tris += this.tileTierN[b] * this.tierTris[b]
    this.tris = tris
  }

  /**
   * One tile's share of an update: follow the terrain if it has changed, queue
   * a level change, give the rim its sweep, and tier its rocks -- the
   * per-instance ladder if the tile is near, all onto the coarsest mesh if not.
   * Runs on the tile's bucket turn, or off the due list -- see STILL_M.
   */
  _walkTile(t, camX, camY, camZ, gver, now) {
    const tile = this.tile
    // The chunk under the tile's centre, re-asked only when the terrain's
    // render set has changed since this tile last asked. A rock follows the
    // chunk it stands on when that re-splits.
    if (this.ground && t.gver !== gver) {
      t.gver = gver
      const gkey = this.ground.groundKeyAt((t.tx + 0.5) * tile, (t.tz + 0.5) * tile)
      if (gkey !== t.gkey) {
        t.gkey = gkey
        this._reground(t)
        this.regrounds++
      }
    }

    const nx = Math.max(t.tx * tile, Math.min(camX, (t.tx + 1) * tile))
    const nz = Math.max(t.tz * tile, Math.min(camZ, (t.tz + 1) * tile))
    const near2 = (nx - camX) ** 2 + (nz - camZ) ** 2

    const tileHidden = this.rim.sweepTile(t, this.instX, this.instY, this.instZ, camX, camY, camZ)

    const q = t.q
    const thicken = near2 < this.loSq[q]
    const thin = q + 2 <= this.maxQ && near2 >= this.loSq[q + 2]
    if (!t.queued && (thicken || thin)) {
      t.queued = true
      this.queue.push({ key: t.tx * 0x10000 + t.tz, tx: t.tx, tz: t.tz, q: this._levelFor(near2), d2: near2 })
    }

    const coarse = ROCK_BAND_COUNT - 1
    const dx = (t.tx + 0.5) * tile - camX
    const dz = (t.tz + 0.5) * tile - camZ
    const near = dx * dx + dz * dz < this.nearSq
    const cnt = this._walkN
    cnt.fill(0)
    if (!near) {
      // O(1): a far tile is entirely on `coarse`, so there is no per-rock
      // decision left to make out here. `tileHidden` is the rim's own count for
      // this tile -- a fade that retired since its last sweep is still counted
      // as drawn, the same staleness the visibility it describes already has.
      if (t.near) this._demote(t, coarse)
      t.near = false
      cnt[coarse] = t.n - tileHidden
    } else {
      t.near = true
      this.walked += t.n
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
        // 48 m where the cobble is already on T6 at 5. All that separates
        // them is the size they are measured in -- `instLod`, what this instance
        // shows above the ground, so a rock stood on end and bedded deep is
        // judged by its crest and its footprint and not by the length under
        // the hill.
        const size = this.instLod[i]
        const sizeSq = size * size

        // The far ceiling first: a rock past it is T6 whatever its size, and
        // the ladder is only read inside it. Sticky like a rung -- on a mesh
        // tier it holds to FAR_SQ, on T6 it comes back inside FAR_IN_SQ.
        let tier = coarse
        if (d2 < (cur >= 0 && cur < coarse ? FAR_SQ : FAR_IN_SQ)) {
          for (let b = 0; b < LOD_SQ.length; b++) {
            const sticky = cur >= 0 && cur <= b
            if (d2 < sizeSq * (sticky ? LOD_SQ_OUT[b] : LOD_SQ[b])) {
              tier = b
              break
            }
          }
        }

        // A tier whose mesh is full refuses the move (PropArena) and the rock
        // keeps the rung it has: one mesh coarser than it should be, not gone.
        if (tier !== cur && this.batch.setGeometryIdAt(i, this.tierIds[tier])) {
          this.tierAt[i] = tier
          // `cur < 0` is an instance that has never been tiered -- there is no
          // departing mesh to hold, so there is nothing to dissolve past.
          if (cur >= 0) this._crossFade(i, cur, now)
        } else {
          tier = cur
        }
        cnt[tier]++
      }
    }
    const tierN = t.tierN
    for (let b = 0; b < ROCK_BAND_COUNT; b++) {
      this.tileTierN[b] += cnt[b] - tierN[b]
      tierN[b] = cnt[b]
    }
  }

  /** Walk the tile on the next update whatever its bucket says. */
  _markDue(tile) {
    this.rim.markDue(tile)
    if (tile.due) return
    tile.due = true
    this.due.push(tile)
  }

  /** A tile leaves the resident set: out of every list, and its ids back to the pool. */
  _evict(key, tile) {
    this._release(tile)
    this.tiles.delete(key)
    const bucket = this.buckets[tile.phase]
    const last = bucket.pop()
    if (last !== tile) {
      bucket[tile.bi] = last
      last.bi = tile.bi
    }
    if (tile.due) {
      const due = this.due
      due.splice(due.indexOf(tile), 1)
    }
  }

  /**
   * THE BED'S REACH IS A SPHERE, NOT A COLUMN. `radius` is how far the bed
   * carries along the ground; at height `agl` above it, the ground still inside
   * that sphere is a disc of `sqrt(radius^2 - agl^2)`, and past `radius` there is
   * none. So flying up switches the small beds off in the order a rock stops
   * being worth drawing: at 500 m `scree` and `shore` are gone outright and the
   * survivors are cut to a third or a half of their footprint.
   *
   * The y term is one multiply-subtract on a test that was already squared, so it
   * is free; the one sqrt is per bed per frame, to size the admission grid.
   *
   * `agl` is quantised DOWN to whole tiles, which is what makes this cheap enough
   * to sit in front of the early-out: under one tile of altitude the reach is the
   * configured one exactly, so standing on the ground is untouched, and the
   * reseat only re-runs when the camera crosses a tile line horizontally OR
   * changes altitude band. Between those, nothing recomputes.
   *
   * The reach is measured from the ground UNDER THE CAMERA, not per tile, so
   * admission and eviction always agree and a tile cannot be admitted and evicted
   * on alternate frames. The cost of that is the honest one: flying level past a
   * canyon rim, the floor below sets the reach even though the rim is at eye
   * level, and rock on it can drop out early.
   */
  _reseat(cx, cy, cz) {
    const tile = this.tile
    const tx = Math.floor(cx / tile)
    const tz = Math.floor(cz / tile)
    const agl = Math.max(0, cy - this.field.heightAt(cx, cz))
    const aglQ = Math.floor(agl / tile) * tile
    if (tx === this.camTileX && tz === this.camTileZ && aglQ === this.camAglQ) return
    this.camTileX = tx
    this.camTileZ = tz
    this.camAglQ = aglQ

    const reach = Math.sqrt(Math.max(0, this.radius * this.radius - aglQ * aglQ))
    this.radiusSq = reach * reach
    // The eviction slack exists to stop a tile on the line being cut and regrown
    // across it. A bed with no reach left has no line, and wants to be EMPTY --
    // slack there would strand a tile of pebbles under a camera 500 m up.
    this.evictSq = reach > 0 ? (reach + tile * 1.5) ** 2 : 0
    this.tileSpan = Math.ceil(reach / tile) + 1

    for (const [key, t] of this.tiles) {
      const dx = (t.tx + 0.5) * tile - cx
      const dz = (t.tz + 0.5) * tile - cz
      if (dx * dx + dz * dz > this.evictSq) {
        this._evict(key, t)
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
        if (tileOutOfBounds(this.bounds, gx, gz, tile)) continue
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

    const rand = mulberry32(tileSeed(tx, tz, this.seed, this.cfg.field))
    // The landform answers are per tile and indexed within it -- see RELIEF_CELL.
    if (this.probesRelief) this.reliefMemo.fill(0)
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
    const gN = this.latticeN
    const cell = this.latticePitch
    for (let k = 0; k < this.perTile; k++) {
      // TWO DRAWS EITHER WAY, so the stream is the same length whichever bed this
      // is. On a `lattice` bed they jitter a CELL rather than choose a point: the
      // candidate sits anywhere inside its own square of the tile's grid, which
      // keeps the positions irregular while bounding the gap between them at one
      // cell. See `lattice` for why a wall wants that and a hillside does not.
      // A `deep` bed's one candidate is jittered about the point its forest
      // scan picks instead, below.
      const ux = rand()
      const uz = rand()
      let x = this.lattice ? tx * tile + ((k % gN) + ux) * cell : (tx + ux) * tile
      let z = this.lattice ? tz * tile + (((k / gN) | 0) + uz) * cell : (tz + uz) * tile
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
      // The rank draw the halving law keyed on. Burned, not read: dropping it
      // would move every rock in the world one draw along.
      rand()

      // The rank the tile ladder keys on -- the rock's own size, see `_rankOf`.
      // Computed HERE, before the survivor test and before the sort, because all
      // three have to agree on one order: the stability argument above only holds
      // if a candidate is darted against exactly the set already standing at
      // every coarser level.
      const rankU = this._rankOf(this._sizeRoll(scaleRoll))

      if (rankU > uNew || rankU <= uOld) continue

      // The scan is paid once per tile: a `deep` bed has one candidate and a
      // rank window admits it exactly once.
      if (this.deep > 0) {
        const site = this._deepSite(tx, tz)
        if (site === null) {
          this.rejected.deep++
          continue
        }
        x = site.x + (ux * 2 - 1) * DEEP.jitter
        z = site.z + (uz * 2 - 1) * DEEP.jitter
      }

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
    //
    // AND ON A PACKING BED IT RUNS TWICE, BECAUSE THE ORDER IS THE ALGORITHM.
    // `packEarn` is a greedy pack: each plate is judged against the wall its
    // neighbours have already claimed, so whichever plate is laid first is the one
    // that keeps its place. Laid in rank order that is arbitrary, and a plate the
    // ground cut to nine metres routinely lands before the forty-metre panel that
    // was going to clothe the same face -- the panel then finds its own face
    // already spoken for and is refused, and a face that wanted one plate gets a
    // dozen. Largest first is the only order a greedy pack is worth running in.
    //
    // WHICH MEANS ASKING BEFORE PLACING. The size is not rolled, it is what the
    // ground answers (`fitFromTop`), so nothing knows it until the fit ladder has
    // been walked -- and the ladder is behind the slope, environment and water
    // tests and a field sample. So phase zero runs every candidate up to and
    // including the ladder, with NO neighbours in it, and leaves the answer in
    // `c.fit`; the sort below is on that; phase one lays them down in the new order
    // and reads back the field samples phase zero already paid for.
    //
    // IT IS STILL STABLE UNDER TILE GROWTH, for a reason that is worth stating
    // rather than assuming: `_rankOf` ranks every candidate of a `fitFromTop` bed
    // at `fullRadius / farGoneAt(top)`, one value for all of them, so this bed's
    // rank ladder is flat and a tile is grown once at full detail. There is no
    // coarser level for the pack to disagree with.
    for (let phase = this.packCaps ? 0 : 1; phase <= 1; phase++) {
    if (phase === 1 && this.packCaps) {
      order.sort((a, b) => c.fit[b] - c.fit[a] || c.rank[a] - c.rank[b])
    }
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

      // WHAT PHASE ZERO ALREADY SETTLED. `fit` is the fraction of the range's top
      // the ground under this candidate holds, and zero means some test refused it
      // -- so phase one skips the dead without re-counting the rejection, and reads
      // the field sample, the snow line and the environment back out rather than
      // paying `scatterAt` a second time for every candidate in the tile.
      const cached = phase === 1 && this.packCaps
      if (cached && c.fit[k] === 0) continue
      if (phase === 0) c.fit[k] = 0
      // A rock she carried off (hands.js) is not laid here again. Position-only, so it consumes no randoms.
      if (taken.has('rock', x, z)) continue
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
      let h, tan, snowLine, env
      if (cached) {
        h = c.h[k]
        tan = c.tan[k]
        snowLine = c.snow[k]
        env = c.env[k]
      } else {
      const clump = cfg.clumpFloor > 0 || this.footDense ? this._clump(x, z) : 0
      if (cfg.clumpFloor > 0 && clump < cfg.clumpFloor) {
        this.rejected.clump++
        continue
      }

      // THE LANDFORM FIRST ON A BED THAT HAS NO BUSINESS OFF A FOOT. `_relief`
      // used to sit below the terrain sample because it was four field samples
      // against one; cached per cell (see RELIEF_CELL) it is a fifth of one, and
      // it throws away nine candidates in ten where the slope test throws away
      // almost none. So the scree bed pays `scatterAt` on the tenth that is
      // standing somewhere it could belong, instead of on all of them.
      //
      // ORDER-FREE, WHICH IS WHY THIS IS A REORDER AND NOT A RULE CHANGE. Both
      // tests are pure functions of position and neither reads the other's
      // output, so the set that survives both is the same set whichever runs
      // first; only which counter in `rejected` records a refusal moves.
      let site = null
      if (this.footOnly) {
        site = this._reliefAt(x, z, tx, tz)
        if (site !== null) this.sited[site]++
        if (site !== 'foot') {
          this.rejected.foot++
          continue
        }
      }

      this.samples++
      const g = this.field.scatterAt(x, z, PLACEMENT_CELL, this._scatter)
      h = g.h
      tan = g.tan
      if (h < cfg.minElev) {
        this.rejected.elev++
        continue
      }
      if (tan > this.maxSlopeTan) {
        this.rejected.slope++
        continue
      }
      // AND THE FLOOR OF THE WINDOW, which only a cap bed sets. See minSlopeTan.
      if (tan < this.minSlopeTan) {
        this.rejected.flat++
        continue
      }
      // Wanted twice -- by the environment test and by the ground cue further
      // down -- so it is taken once here rather than inside _envAt.
      snowLine = this.field.snowLineAt(x, z)
      env = this._envAt(x, z, h, tan, snowLine)

      // THE RELIEF FOR A BED THAT MERELY LEANS ON IT, asked here rather than above
      // because a `footDense` bed places everywhere and only runs denser at a foot,
      // so nothing is thrown away by asking and the answer is wanted one line down.
      // A bed that asked for neither flag never probes at all. See _relief.
      //
      // `sited` counts what the probe SAW, not what was placed: it is the only
      // readout of the landform this file has, and a brow the bed then ignores is
      // still a brow.
      if (this.footDense) {
        site = this._reliefAt(x, z, tx, tz)
        if (site !== null) this.sited[site]++
      }

      // How MUCH stone this environment has lying about, as opposed to which
      // kind. See BEDS: without this a bed is equally dense everywhere.
      //
      // A FOOT SITE RUNS DENSER, and unevenly. Scree does not lie in a band of
      // constant density along the base of a cliff, it lies in piles with bare
      // ground between them, and the clump field is the difference -- see _clump.
      let dens = site === 'foot'
        ? cfg.envDensity[env] * (1 + CLUMP_GAIN * clump)
        : cfg.envDensity[env]
      // THICKER ALONG A SHORE, wet or dry -- |d|, because this candidate may be
      // standing in the shallows and the gain is meant for both sides. Only a
      // bed with a gain pays for the lookup.
      if (this.shoreGain !== 1 && Math.abs(this.water.shoreDistAt(x, z, SHORE_REACH, h, tan)) < SHORE_REACH) {
        dens *= this.shoreGain
      }
      // AND A BED THAT ONLY EXISTS AT THE WATERLINE refuses everything past it,
      // wet or dry alike, and thins from `shoreCore` out to the edge. After the
      // field sample because the lake half of the distance needs the ground
      // height and slope; before the rate so a refused candidate costs one
      // lookup and nothing else.
      if (this.shoreOnly > 0) {
        const d = Math.abs(this.water.shoreDistAt(x, z, this.shoreOnly, h, tan))
        if (d >= this.shoreOnly) {
          this.rejected.shore++
          continue
        }
        if (d > this.shoreCore) dens *= smoothstep(this.shoreOnly, this.shoreCore, d)
      }
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
      const sizeRoll = this._sizeRoll(scaleRoll)
      const metres = cfg.sizeByEnv[env]
      if (!metres) throw new Error(`RockBed ${cfg.name}: sizeByEnv has no entry for ${env}`)
      // THE BARREN TOP, where the bed has one and the roll would use it: the
      // footprint probe is four field samples, paid only by the rock that
      // would overtop the wooded range. Refused, the roll lands on that range
      // as it would in a wood.
      let top = metres[1]
      if (this.barrenTop[env] > 0) {
        const want = metres[0] + sizeRoll * (this.barrenTop[env] - metres[0])
        if (want > top && this._barrenAt(x, z, h, snowLine, want)) top = this.barrenTop[env]
      }
      // AND THE TOP OF THE RANGE IS A CEILING ON EVERY AXIS, not just on the one it
      // divides through. The boulder is deeper than it is wide, so the width
      // division alone comes out over the range's top -- and that number is not
      // cosmetic: `maxLod` and through it the bed's whole LOD reach are derived from
      // the range's top, so a rock over it is a rock whose far distance the bed's
      // own `radius` was never sized for. Clamping here rather than widening the
      // reach keeps "half a metre to ten" true of the ROCK rather than of one of its
      // three extents, and makes the bound seed-independent.
      // NOT FINAL ON A `fitSlope` BED: the fit probe below may cut it down to
      // what the ground under this candidate can actually hold. Everything
      // derived from it is scaled by the same factor there.
      let scale = Math.min(
        (metres[0] + sizeRoll * (top - metres[0])) / s.measured.width,
        top / this.shapeLod
      )

      // THE QUARTER TURNS, WHICH DECIDE WHICH WAY IS UP BEFORE ANYTHING ELSE DOES.
      // One roll picks a whole number of right angles about x and then about z --
      // see ROLL_STEPS for why the increment is 90 and not a free angle. The x turn
      // is applied first in the rock's own frame, so `rollQ = qz * qx`. Held here,
      // ahead of the dart, because what the dart measures is the FOOTPRINT and
      // turning the rock changes it.
      // A BED PLACING AN OPEN SHAPE TAKES NONE OF THEM and gets the identity, so
      // everything below reads the unturned box: `m11` is 1, so `yMax` is the
      // height, `yMin` is zero, and the plan extents are the shape's own. The roll
      // was still DRAWN either way, up in the draw block, so turning it off does
      // not shift the random stream and every other bed places where it did.
      const q = this._rollQ.identity()
      if (this.roll) {
        const ri = this.turnRi ? this.turnRi[rollRoll < 0.5 ? 0 : 1]
          : Math.min(ROLL_STEPS * ROLL_STEPS - 1, (rollRoll * ROLL_STEPS * ROLL_STEPS) | 0)
        q.setFromAxisAngle(this._zAxis, ((ri / ROLL_STEPS) | 0) * (Math.PI / 2))
        q.multiply(this._rollXQ.setFromAxisAngle(this._xAxis, (ri % ROLL_STEPS) * (Math.PI / 2)))
      }
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
      let yMax = Math.abs(m10) * bw * 0.5 + Math.max(0, m11) * bh + Math.abs(m12) * bd * 0.5
      let yMin = -Math.abs(m10) * bw * 0.5 + Math.min(0, m11) * bh - Math.abs(m12) * bd * 0.5
      let stand = yMax - yMin
      // How much GROUND this rock covers, which is what the dart and every caller
      // of `anchorsInto` are asking about. The LOD thresholds in `update` want a
      // different number and take it from `rockLodSize`, which is the longest axis
      // and so does not care how the rock was turned.
      let planX = Math.abs(m00) * bw + Math.abs(m01) * bh + Math.abs(m02) * bd
      let planZ = Math.abs(m20) * bw + Math.abs(m21) * bh + Math.abs(m22) * bd
      let span = Math.max(planX, planZ)

      // OFF THE ROAD, footprint and all -- see ROAD_CLEARANCE. Here, once the span is known, and before the fit ladder, which only ever shrinks it.
      if (this.layers.paths !== undefined) {
        const road = this.layers.paths.nearest(x, z, 'road')
        if (road !== null && road.dist < road.halfWidth + span * 0.5 + ROAD_CLEARANCE) {
          this.rejected.road++
          continue
        }
      }

      // HOW DEEP THIS ONE IS BEDDED, as a fraction of what it stands. Held here,
      // ahead of the fit ladder, because the burial is most of the tolerance that
      // ladder spends: a plate sunk four metres into a face can carry ground that
      // falls four metres away from its plane before its open underside shows.
      // Every term below is scale-free, so the ladder may shrink `stand` afterwards
      // and the fraction still holds.
      //
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
      const sinkBase = stand > TALL_AT * 0.5 * (planX + planZ) ? SINK_TALL : SINK_MIN
      const sinkFloor = Math.max(
        this.sinkLo,
        sinkBase + SINK_SLOPE * Math.min(1, tan / this.maxSlopeTan)
      )
      const deepRoll = Math.pow(sinkRoll, 1 - SINK_SIZE_TILT * sizeRoll)
      let sinkFrac = cfg.sinkVary
        ? sinkFloor + deepRoll * Math.max(0, this.sinkHi - sinkFloor)
        : Math.min(sinkFloor, this.sinkHi)
      // PAST SQUASH_AT THE ROLL FLATTENS THE ROCK INSTEAD, along the rolled box's
      // own up, and the burial stops there: what shows above ground is the same
      // height the deeper burial would have shown. Decided on the fraction the
      // bed ASKED for, ahead of the normal correction below, which is a
      // steep-face multiplier on how far down the rock must go to be bedded that
      // fraction into the face and not a deeper burial in its own right.
      let squash = 1
      if (sinkFrac > SQUASH_AT) {
        squash = (1 - sinkFrac) / (1 - SQUASH_AT)
        sinkFrac = SQUASH_AT
        yMax *= squash
        yMin *= squash
        stand *= squash
      }
      // INTO THE FACE, NOT DOWN THE FACE. See SINK_NORMAL_MAX: the fraction is
      // along the surface normal and `instY` can only move a rock along world Y, so
      // a bed that means to bury something in a cliff has to pay the 1/cos(slope)
      // between them.
      if (this.sinkNormal) sinkFrac *= Math.min(SINK_NORMAL_MAX, Math.hypot(tan, 1))
      // AND WHATEVER THOSE TERMS ADD UP TO, THE ROCK STAYS VISIBLE. The normal
      // correction is a multiply of up to three on a fraction that was already near
      // the embedded bed's ceiling, so on a face it can bury a rock whole. A rock
      // nobody can see is one that was built, skinned and submitted for nothing.
      // See SINK_CAP.
      sinkFrac = Math.min(sinkFrac, SINK_CAP)

      // HOW BIG A PLATE THIS SITE CAN ACTUALLY HOLD -- its own plane and its
      // neighbours, on one shrinking ladder. See `_fitFactor`. Behind the density,
      // water and environment tests, so the ladder is walked on the few thousand
      // candidates that survive those rather than the hundred thousand drawn.
      //
      // WHAT IT DOES NOT COVER is the tile boundary: a neighbouring tile is grown
      // independently and in an order the camera decides, so darting across the
      // seam would make the result depend on which way the player walked in. At a
      // 14 m tile and a metre or two of rock that leaves a thin margin where two
      // rocks may interpenetrate -- the same trade every tiled scatter here makes.
      if (this.fitSlope) {
        this._fitFail = 'fit'
        // HOW FAR UNDER ITS OWN PLANE THIS PLATE'S RIM REACHES, per metre of span,
        // which is the whole tolerance the ladder has to spend. MEASURED ALONG THE
        // PLATE'S NORMAL, because that is the direction the shell has depth in and
        // it is the frame `_fitFactor` compares against. Two terms buy room and a
        // third spends it: the burial, which is applied straight down in world Y
        // and so buys only its cosine perpendicular; the shell's curtain, which
        // already hangs along the normal and buys all of itself; and THE LEAN THIS
        // INSTANCE IS ABOUT TO BE GIVEN, which lifts the far rim off the plane by
        // half a span times its sine. That lean is applied after the fit and used
        // to be invisible to it, so a plate could pass the ladder having spent
        // every millimetre on the ground being uneven and then be tipped off the
        // hill anyway -- the exposed underside the whole test exists to prevent.
        // Drawn from this candidate's own roll and not from the worst case, so a
        // plate that happens to lie flat keeps the room a leaning one does not.
        const lean = leanMag * TILT_JITTER * this.tiltJitter
        const dropPerSpan = Math.max(
          0,
          ((stand * sinkFrac) / Math.hypot(tan, 1) + this.shapeSkirt * scale) / span -
            0.5 * Math.sin(lean)
        )
        // ON A PACKING BED THE LADDER IS WALKED ONCE, in phase zero, and with NO
        // neighbours in it. What it measures there is the SITE's own answer -- the
        // biggest plate this ground holds -- which is both the size the plate wants
        // and the key the pack has to be ordered by; the neighbours are applied
        // afterwards, as a shrink, in the order those answers decide. Asking the
        // ground twice would double the field samples for a number that cannot have
        // changed: nothing in `_fitFactor` reads anything but position and yaw.
        const f = cached ? c.fit[k] : this._fitFactor(x, z, yaw, span, dropPerSpan, ids, n)
        if (f === 0) {
          this.rejected[this._fitFail]++
          continue
        }
        if (phase === 0) {
          c.fit[k] = f
          c.h[k] = h
          c.tan[k] = tan
          c.snow[k] = snowLine
          c.env[k] = env
          continue
        }
        if (f < 1) {
          scale *= f
          yMin *= f
          stand *= f
          planX *= f
          planZ *= f
          span *= f
        }
      } else if (this._dartBlocked(x, z, span, ids, n)) {
        // NO ROCK INSIDE ANOTHER ROCK -- see `minGap` on the scree bed. A closed
        // boulder has no size the site is asking for, so this bed rejects where a
        // cap bed would have shrunk: darted against the rocks already standing in
        // THIS tile, which in pass two's rank order are exactly the ones already
        // standing at every coarser level of it, so the answer does not change as
        // the tile fills in.
        this.rejected.gap++
        continue
      }

      // AND WHETHER IT IS WORTH DRAWING AT ALL. See `_earnedFrac`: what comes back
      // is the fraction of this plate's own footprint that is wall no plate already
      // standing has covered, and a plate that earns less than `packEarn` of itself
      // is thrown away whole. Behind the ladder, because the size the ground gave it
      // is the size it is being judged at.
      //
      // IT KEEPS THE SIZE IT WAS GRANTED. Nothing here shrinks a plate to fit the
      // room beside a neighbour: that is what dressed a face in a ring of ever
      // smaller panels around its one big one, each cut to the gap it happened to
      // land in. A plate is the size of the face under it or it is not placed.
      //
      // The DRAWN ground and not the field's, because that is the height every plate
      // already standing was written at (`instY` below) and this compares the two.
      // Hoisted out of that line rather than sampled twice.
      const groundY = this._groundFor(x, z)
      if (this.packCaps &&
        this._earnedFrac(x, groundY, z, this._faceRadius(span), ids, n, tx, tz) < this.packEarn) {
        this.rejected.gap++
        continue
      }

      // A DRY POOL DROPS THE ROCK, IT DOES NOT THROW. The pool is sized to a
      // measured peak (`siteFrac`), not to the position-blind bound, so a talus
      // richer than any the measurement flew is a rock or two missing at the far
      // edge -- pass two runs largest first, so what goes is the small end of the
      // tile that overran -- and a warning, once, on the console the log endpoint
      // ships to the dev server.
      if (this.freeCount === 0) {
        this.rejected.pool++
        if (!this.poolDry) {
          this.poolDry = true
          console.warn(
            `RockBed ${cfg.name}: instance pool of ${this.maxInstances} ran dry with ${this.tiles.size} tiles resident; raise siteFrac`
          )
        }
        continue
      }

      const id = this.free[--this.freeCount]
      ids[n] = id
      rank[n] = rankU
      n++

      const sink = stand * sinkFrac
      this.instX[id] = x
      this.instZ[id] = z
      // `yMin` folded in, so `instSink` stays the ONE number `_reground` needs: how
      // far the origin sits under the drawn ground. It goes negative for a rolled
      // rock that hangs below its own origin by more than it is buried, which is
      // correct rather than a guard to add -- the origin belongs above ground there.
      this.instSink[id] = sink + yMin
      this.instScale[id] = scale
      this.instSpan[id] = span
      this.instY[id] = groundY - this.instSink[id]
      // What the eye can measure this rock by: its footprint or the height it
      // shows above the ground, whichever is longer. `stand` is already squashed,
      // so a flattened slab is judged as the slab.
      this.instLod[id] = Math.max(span, stand * (1 - sinkFrac))

      this._yawQ.setFromAxisAngle(this._up, yaw)
      // Roll first in the rock's own frame, then the squash along the rolled
      // box's up, then yaw about the vertical, then the ground lean, then the
      // random lean on top of it -- so a tilted rock spins about the ground's
      // normal rather than about world Y and the jitter is a departure from the
      // hill rather than a second alignment to it. The roll and the squash are a
      // matrix rather than part of the quaternion because a squash is a scale and
      // a quaternion cannot carry one; see the compose below.
      if (cfg.tilt > 0) this._q.copy(this._groundTilt(x, z, cfg.tilt)).multiply(this._yawQ)
      else this._q.copy(this._yawQ)
      // PRE-multiplied, so the axis is horizontal IN THE WORLD. Composed the other
      // way the axis would be horizontal in the ROCK's frame, and a rock the roll
      // has laid on its side would take its "lean" about a near-vertical axis --
      // which is a second yaw, not a lean, on exactly the instances that most need
      // one.
      const a = leanDir * Math.PI * 2
      this._leanAxis.set(Math.cos(a), 0, Math.sin(a))
      this._q.premultiply(
        this._leanQ.setFromAxisAngle(this._leanAxis, leanMag * TILT_JITTER * this.tiltJitter)
      )
      // `q * diag(1, squash, 1) * roll * scale`, the quaternion's rotation over
      // the rolled and squashed box. The roll is quarter turns, so the columns of
      // the product stay orthogonal, each `scale` or `scale * squash` long, which
      // is what lets `_spanAt` and `_rayAt` invert it by the transpose over the
      // column lengths.
      this._rm.set(
        m00 * scale, m01 * scale, m02 * scale, 0,
        m10 * scale * squash, m11 * scale * squash, m12 * scale * squash, 0,
        m20 * scale, m21 * scale, m22 * scale, 0,
        0, 0, 0, 1
      )
      this._m.makeRotationFromQuaternion(this._q).multiply(this._rm)
      this._m.setPosition(x, this.instY[id], z)
      const e = this._m.elements
      this.instM.set(e, id * 16)

      // A TINT PER INSTANCE, ROLLED FROM THE ENVIRONMENT'S PALETTE. With one mesh
      // in the world this is most of what keeps a scree slope from being one grey
      // and a wood one green -- the eye finds a repeated colour faster than a
      // repeated silhouette. ENV_TINTS carries a list per environment and weights by
      // repetition, so common stone stays common.
      //
      // THE VALUES GO ABOVE 1.0 ON PURPOSE. stone.png is a real photograph of
      // granite -- warm, and dark at a mean luma of 88/255 -- so every palette
      // entry is a gain that brightens and white-balances it rather than a multiply
      // that darkens it further (see TINT_GAIN). The per-instance colour is FLOAT,
      // so > 1 is storable and does what it says.
      // A FACADE BED SKIPS THE ROLL ENTIRELY and takes the terrain's own gain, so
      // there is no mineral to read off a cliff panel -- see FACADE_GAIN.
      const pal = ENV_TINTS[env]
      const gain = this.facade
        ? FACADE_GAIN
        : TINT_GAIN[pal[Math.min(pal.length - 1, (tintRoll * pal.length) | 0)]]

      // AND THEN PULLED PART OF THE WAY TOWARD THE GROUND IT IS STANDING ON.
      // The terrain's own vertex colour here, from the chunk mesher's own
      // `shade`, so the cue cannot drift away from what the ground is actually
      // painted -- render/ferns.js takes a fern's the same way and for the same
      // reason. `dirtAt` unconditionally rather than ferns' road-gated call:
      // this file has no path index to gate on, and one lookup sits next to the
      // four _groundTilt is about to take anyway.
      shade(h, 1 / Math.hypot(tan, 1), snowLine, snowBand, this.layers.dirtAt(x, z),
        this.layers.shoreAt(x, z, h), altLo, altSpan, x, z, gc, 0)
      // Taken at FULL MAGNITUDE, so the cue carries lightness and not just hue --
      // see GROUND_CUE for why the old renormalisation went and what the change
      // costs in brightness.
      const cue = this.facade ? FACADE_CUE : GROUND_CUE[env]
      const k1 = cue
      const k0 = 1 - cue

      // Jitter on top, so two rocks of the same tint standing together still
      // differ. Centred slightly under 1 and running slightly over. It no longer
      // leaves every instance brighter than the bare tile and is not meant to: a
      // rock on dark forest loam now lands NEAR the loam, which is the whole of
      // what the lightness match buys. What the floor of 0.86 still guarantees is
      // separation from the ground rather than dominance of it -- outside a facade
      // bed the cue tops out at 0.75, so a rock keeps a quarter of its own palette.
      //
      // A FACADE TAKES A TENTH OF THAT SPREAD and no hue skew at all. The jitter is
      // per-instance rather than positional, so on panels tens of metres wide it is
      // patchwork rather than weathering; what is left is just enough that abutting
      // plates do not read as one flat sheet. Everything that should say WHERE on
      // the mountain a panel sits already came in through the cue.
      const skew = this.facade ? 0 : 0.08
      const v = this.facade ? 0.96 + tone * 0.08 : 0.86 + tone * 0.3
      this._c.setRGB(
        gain[0] * v * (1 - skew * 0.5 + warm * skew) * (k0 + gc[0] * k1),
        gain[1] * v * (k0 + gc[1] * k1),
        gain[2] * v * (1 + skew * 0.5 - warm * skew) * (k0 + gc[2] * k1)
      )
      this.batch.setColorAt(id, this._c)
      if (this.natural) {
        this.natural[id * 3] = this._c.r; this.natural[id * 3 + 1] = this._c.g; this.natural[id * 3 + 2] = this._c.b
        if (this.tint) this.batch.setColorAt(id, this.tint)
      }

      // WHERE THIS ROCK DISSOLVES, AND WHY IT CANNOT BE BEFORE ITS LADDER ENDS.
      //
      // `rankU` is the size rank from `_rankOf`. The tile ladder keeps exactly
      // `{rankU <= uAt[q]}` and `uAt[q] = fullRadius / d_q`, so handing the same
      // number to the material makes the CPU's decision and the shader's agree -- a
      // rock the tile is about to drop has already faded out.
      //
      // The dissolve distance `fullRadius / rankU` is exactly `max(fullRadius,
      // fadeFloor)`, and the floor is past the far rung, so no rock starts
      // dissolving before it has reached T6: thinning takes rocks that are already
      // six triangles apiece rather than reaching up and taking finer meshes --
      // which read as rocks culling without degrading.
      //
      // The `radius` clamp is the bed's outer reach, past which its tiles are not
      // resident at all, so the dissolve finishes before the tile evicts. It cannot
      // undercut the guarantee: the constructor refuses a `radius` shorter than the
      // bed's own far distance. Born at the coarsest tier; `update` promotes the
      // near ones next frame.
      this.tierAt[id] = ROCK_BAND_COUNT - 1
      this.batch.setGeometryIdAt(id, this.tierIds[ROCK_BAND_COUNT - 1])
      this._placeTier(id)

      // Hidden until the rim's sweep has looked at it, which the tile below is
      // marked due for -- see rim.js.
      this.rim.place(id, Math.min(this.fullRadius / rankU, this.radius))
    }
    }

    this.placed += n - (existing ? existing.n : 0)
    if (existing) {
      existing.n = n
      existing.q = q
      existing.u = uNew
      // Everything this tile just placed is hidden until the rim looks at it,
      // so a thickened tile that waited for its phase would be a hole.
      this._markDue(existing)
    } else {
      const phase = tilePhase(tx, tz)
      const bucket = this.buckets[phase]
      const fresh = {
        tx,
        tz,
        ids,
        rank,
        n,
        q,
        u: uNew,
        near: false,
        queued: false,
        due: false,
        phase,
        bi: bucket.length,
        tierN: new Int32Array(ROCK_BAND_COUNT),
        // The terrain chunk covering this tile's CENTRE when its rocks were last
        // grounded, or null if none was resident, and the ground version it was
        // read at. The walk re-asks only once the version has moved on.
        gkey: this.ground ? this.ground.groundKeyAt((tx + 0.5) * tile, (tz + 0.5) * tile) : null,
        gver: this.ground ? this.ground.groundVersion : 0,
      }
      this.tiles.set(key, fresh)
      bucket.push(fresh)
      this._markDue(fresh)
    }
  }

  /**
   * A rotation that lays the rock's up axis `amount` of the way toward the
   * ground normal.
   *
   * Four extra field samples, paid once per PLACED rock and never again. Off the
   * FIELD rather than the drawn mesh on
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
      this.instM[id * 16 + 13] = y
      this._placeTier(id)
    }
  }

  /**
   * Write arena slot `target`'s matrix for instance `id`: the placement matrix
   * from `instM`, which every tier takes. `target` is the ghost in `_crossFade`
   * and `id` itself everywhere else.
   */
  _placeTier(id, target = id) {
    const e = this._m.elements
    for (let k = 0; k < 16; k++) e[k] = this.instM[id * 16 + k]
    this.batch.setMatrixAt(target, this._m)
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
    // And a third, which is PropArena's rather than the pool's: the ghost goes in
    // the DEPARTING tier's mesh, and only that tier's headroom is the ghosts' to
    // fill; a ghost in the population's share would have the next REAL arrival
    // refused instead -- see `_tierCaps`.
    if (this.ghostsAt[oldTier] >= this.ghostRoom[oldTier]) return

    const dup = this.free[--this.freeCount]
    this._placeTier(i, dup)
    // The tint too, or the ghost is a different stone from the one it is
    // standing inside and the pair reads as two rocks rather than one. setColorAt
    // writes .rgb only, so the timer below is safe to stamp after it.
    this.batch.getColorAt(i, this._c)
    this.batch.setColorAt(dup, this._c)
    this.batch.setGeometryIdAt(dup, this.tierIds[oldTier])
    // The mesh is full past even its headroom: no ghost, the swap pops.
    if (!this.batch.setVisibleAt(dup, true)) {
      this.free[this.freeCount++] = dup
      return
    }
    setPropFadeTimerAt(this.batch, dup, now, false)
    setPropFadeTimerAt(this.batch, i, now, true)

    const tris = this.tierTris[oldTier]
    this.fadeTris += tris
    this.ghostsAt[oldTier]++
    this.fadeAt[i] = this.fades.length
    this.fades.push({ orig: i, dup, start: now, tris, tier: oldTier })
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
    this.ghostsAt[f.tier]--
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
      if (tile.rank[k] <= uNew) {
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
    // The tile's hidden count is now stale against a shorter id list.
    this._markDue(tile)
  }

  /**
   * The drawn rock in this bed nearest a hand at (x, y, z) -- a ball of the
   * shape's longest axis at the rock's scale, about the rock's middle -- within
   * `reach` metres and under `maxSize` across: `{ dist, bed, tile, k, id, size }`
   * for take(), or null. Over the resident tiles' own ids, never the pool, for
   * the reason at _anchorsInto. For Rocks.pickAt.
   */
  pickAt(x, y, z, reach, maxSize) {
    const tile = this.cfg.tile
    const far = reach + tile
    const m = this.shape.measured
    const unit = Math.max(m.width, m.depth, m.height)
    let best = null
    let bestD = reach
    for (const t of this.tiles.values()) {
      if (Math.abs((t.tx + 0.5) * tile - x) > far || Math.abs((t.tz + 0.5) * tile - z) > far) continue
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        if (this.rim.isHidden(id)) continue
        const scale = this.instScale[id]
        const span = unit * scale
        if (span >= maxSize) continue
        const d = Math.hypot(this.instX[id] - x, this.instY[id] + m.height * scale * 0.5 - y, this.instZ[id] - z) - span * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), bed: this, tile: t, k, id, size: span }
        }
      }
    }
    return best
  }

  /**
   * The rock this bed has standing at (x, z), hidden by the rim or not, as a
   * take() hit, or null. For Rocks.evict.
   */
  standingAt(x, z) {
    const tile = this.cfg.tile
    for (const t of this.tiles.values()) {
      if (Math.abs((t.tx + 0.5) * tile - x) > tile || Math.abs((t.tz + 0.5) * tile - z) > tile) continue
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        if (Math.abs(this.instX[id] - x) >= TOLERANCE_M || Math.abs(this.instZ[id] - z) >= TOLERANCE_M) continue
        const m = this.shape.measured
        return { dist: 0, bed: this, tile: t, k, id, size: Math.max(m.width, m.depth, m.height) * this.instScale[id] }
      }
    }
    return null
  }

  /**
   * Lift the rock of a pickAt() hit out of the bed: _thin's retirement for the
   * one id, its spot on the registry so the tile never lays it again, and its
   * tint and scale back for the hand's record. The walk surface loses it with
   * the tile's ids; what perched on it (a fern, a pebble, a crab) stays where it was.
   */
  take(hit) {
    const { tile, k, id } = hit
    if (k >= tile.n || tile.ids[k] !== id) throw new Error(`RockBed ${this.cfg.name}.take: instance ${id} is not standing in its tile`)
    taken.add('rock', this.instX[id], this.instZ[id])
    this.batch.getColorAt(id, this._c)
    const color = [this._c.r, this._c.g, this._c.b]
    if (this.fadeAt[id] >= 0) this._endFade(this.fadeAt[id])
    this.batch.setVisibleAt(id, false)
    this.rim.drop(id)
    this.tierAt[id] = -1
    this.free[this.freeCount++] = id
    for (let j = k; j < tile.n - 1; j++) {
      tile.ids[j] = tile.ids[j + 1]
      tile.rank[j] = tile.rank[j + 1]
    }
    tile.n--
    this.placed--
    this._markDue(tile)
    return { color, scale: this.instScale[id] }
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
    for (let b = 0; b < ROCK_BAND_COUNT; b++) this.tileTierN[b] -= tile.tierN[b]
    tile.tierN.fill(0)
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
   * KEYED, NOT SWEPT, like _blockAt: a bed's resident set is its entire draw
   * radius, 1250 m of tiles for the giants, while a caller's box is a few tens of
   * metres, so the tiles the box overlaps are looked up by key and the rest are
   * never touched. Tile extents are half-open in the same sense as the box, which
   * is the literal truth about a tile since _growTile draws a rock's x from
   * [tx * tile, (tx + 1) * tile) and never the far edge.
   */
  _anchorsInto(x0, z0, x1, z1, out, w, cap) {
    return this._rocksInto(x0, z0, x1, z1, out, w, cap, this.footRadius, 4)
  }

  /** One bed's share of Rocks.perchesInto: same walk, the hull's radius in slot 3 and the rock's size in slot 4. */
  _perchesInto(x0, z0, x1, z1, out, w, cap) {
    return this._rocksInto(x0, z0, x1, z1, out, w, cap, this.hull.radius, PERCH_STRIDE)
  }

  /**
   * One bed's share of Rocks.hollowsInto: the same half-open walk on the origin,
   * but slots 0..2 are the BOX'S CENTRE -- the origin sits on the bed face, so a
   * stood-up boulder's footprint is half its height off it -- with the boulder
   * at its field seating (see _rayAt's `seated`), slot 3 the hull's radius
   * about that centre and slot 4 the size.
   */
  _hollowsInto(x0, z0, x1, z1, out, w, cap) {
    const tile = this.tile
    const e = this.instM
    const half = this.shape.measured.height * 0.5
    const gx1 = Math.ceil(x1 / tile) - 1, gz1 = Math.ceil(z1 / tile) - 1
    for (let gx = Math.floor(x0 / tile); gx <= gx1; gx++) {
      for (let gz = Math.floor(z0 / tile); gz <= gz1; gz++) {
        const t = this.tiles.get(gx * 0x10000 + gz)
        if (!t) continue
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const x = this.instX[id]
          const z = this.instZ[id]
          if (x < x0 || x >= x1 || z < z0 || z >= z1) continue
          if (w >= cap) return w
          const o = w * PERCH_STRIDE
          const m = id * 16
          out[o] = e[m + 12] + e[m + 4] * half
          out[o + 1] = this.field.heightAt(x, z) - this.instSink[id] + e[m + 5] * half
          out[o + 2] = e[m + 14] + e[m + 6] * half
          out[o + 3] = this.hull.radius * this.instScale[id]
          out[o + 4] = this.shapeLod * this.instScale[id]
          w++
        }
      }
    }
    return w
  }

  /** Flat-colour every standing boulder of a hollow bed `color` (a THREE.Color), or null for its own stone again; a rock grown later takes the same. */
  setTint(color) {
    if (!this.natural) throw new Error(`Rocks: setTint is for a hollow bed, not ${this.cfg.name}`)
    this.tint = color
    for (const t of this.tiles.values()) {
      for (let k = 0; k < t.n; k++) {
        const id = t.ids[k]
        this.batch.setColorAt(id, color ?? this._c.setRGB(this.natural[id * 3], this.natural[id * 3 + 1], this.natural[id * 3 + 2]))
      }
    }
  }

  /** The walk both of the above share; `radius` is per unit of instance scale, and a stride past 4 gets the size. */
  _rocksInto(x0, z0, x1, z1, out, w, cap, radius, stride) {
    const tile = this.tile
    const gx1 = Math.ceil(x1 / tile) - 1, gz1 = Math.ceil(z1 / tile) - 1
    for (let gx = Math.floor(x0 / tile); gx <= gx1; gx++) {
      for (let gz = Math.floor(z0 / tile); gz <= gz1; gz++) {
        const t = this.tiles.get(gx * 0x10000 + gz)
        if (!t) continue
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const x = this.instX[id]
          const z = this.instZ[id]
          // HALF-OPEN, `>= x0 && < x1`, and the caller's tiling depends on it --
          // see Rocks.anchorsInto.
          if (x < x0 || x >= x1 || z < z0 || z >= z1) continue
          if (w >= cap) return w
          const o = w * stride
          out[o] = x
          out[o + 1] = this.instY[id]
          out[o + 2] = z
          out[o + 3] = radius * this.instScale[id]
          if (stride > 4) out[o + 4] = this.shapeLod * this.instScale[id]
          w++
        }
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
  _blockAt(x, z, minSize, best, settle) {
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
          // Inside the circle and over no stone -- a corner of the box, or the
          // gap beside a rock the query is standing next to rather than on. The
          // prop belongs on the ground there, which is what saying nothing gets
          // it.
          if (!this._spanAt(id, ex, ez)) continue
          const top = span[1]
          // Settled here rather than in the public half because this is where the
          // rock's own size and its own ground are: the caller gets a Y to STAND
          // at, not a surface to sit on, and comparing after the settle is
          // deliberate too -- the answer wanted is the highest place to stand, not
          // the highest stone. It never goes past the ground, because a rock bedded
          // to SINK_CAP stands centimetres proud and a flat 35 cm would put the prop
          // under the terrain it was lifted off; and never below zero, because a
          // point over a rock's buried flank comes back under the ground already.
          // Skipped for a caller that wants the stone's actual surface (the crabs).
          let stand = top
          if (settle) {
            const ground = this.instY[id] + this.instSink[id]
            stand -= Math.min(BLOCK_SETTLE_MAX, BLOCK_SETTLE * size,
              Math.max(0, (top - ground) * 0.5))
          }
          if (stand > best) best = stand
        }
      }
    }
    return best
  }

  /**
   * One bed's share of Rocks.columnAt: every rock of this bed the vertical line
   * through (x, z) passes through, written into `out` as [bottom, top] from
   * cursor `w`, unsettled. Returns the new cursor. The same walk as _blockAt --
   * the 3x3 tile block, the size gate, the circle reject -- and the same ray; the
   * only difference is that both ends of it are kept.
   */
  _columnAt(x, z, minSize, out, w, cap) {
    const tile = this.tile
    const gx = Math.floor(x / tile)
    const gz = Math.floor(z / tile)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const t = this.tiles.get((gx + dx) * 0x10000 + (gz + dz))
        if (!t) continue
        for (let k = 0; k < t.n; k++) {
          if (w >= cap) return w
          const id = t.ids[k]
          if (this.shapeLod * this.instScale[id] < minSize) continue
          const r = this.hull.radius * this.instScale[id]
          const ex = x - this.instX[id]
          const ez = z - this.instZ[id]
          if (ex * ex + ez * ez >= r * r) continue
          if (!this._spanAt(id, ex, ez)) continue
          out[w * SPAN_STRIDE] = span[0]
          out[w * SPAN_STRIDE + 1] = span[1]
          w++
        }
      }
    }
    return w
  }

  /**
   * Where the vertical line through an instance-relative (ex, ez) enters and
   * leaves the rock: `span[0]` the lowest stone on it, `span[1]` the highest, in
   * world metres. False, and `span` untouched, if the line misses the rock. The
   * one place the shape's actual surface is consulted.
   *
   * ONE SPAN PER ROCK, the lowest hit to the highest, which is a convexity
   * assumption: a vertical line crosses a rock in this bank twice, so pairing
   * hits would only buy exposure to the odd count a ray grazing a shared edge
   * produces. A shape with a tunnel through it (an arch) needs the pairing, and
   * this is the place to add it.
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
   * and the smallest signed `t` is the topmost surface, the largest the bottom.
   * The basis columns are orthogonal -- `scale` long, or `scale * squash` on
   * the one the rock stands on -- so the transpose over each column's squared
   * length inverts the matrix. The local direction is left at the length that
   * gives it, which puts `t` in WORLD metres whatever the squash did to the
   * rock's own. The quarter turn, the squash, the ground lean and the jitter all
   * ride in those columns, so none of them needs recovering from the placement
   * arrays.
   */
  _spanAt(id, ex, ez) {
    const e = this.instM
    const o = id * 16
    const c0 = 1 / (e[o] * e[o] + e[o + 1] * e[o + 1] + e[o + 2] * e[o + 2])
    const c1 = 1 / (e[o + 4] * e[o + 4] + e[o + 5] * e[o + 5] + e[o + 6] * e[o + 6])
    const c2 = 1 / (e[o + 8] * e[o + 8] + e[o + 9] * e[o + 9] + e[o + 10] * e[o + 10])
    const ox = (e[o] * ex + e[o + 2] * ez) * c0
    const oy = (e[o + 4] * ex + e[o + 6] * ez) * c1
    const oz = (e[o + 8] * ex + e[o + 10] * ez) * c2
    const dx = -e[o + 1] * c0
    const dy = -e[o + 5] * c1
    const dz = -e[o + 9] * c2
    // The shape's own box, first, because the cylinder in front of this is a loose
    // reject and walking 320 triangles is an expensive way to answer a question six
    // planes settle. Slabs in the rock's frame, where the box is axis-aligned:
    // [-w/2, w/2] x [0, h] x [-d/2, d/2], the origin on the bottom face.
    const mm = this.shape.measured
    let tLo = -Infinity
    let tHi = Infinity
    if (dx > -1e-12 && dx < 1e-12) {
      if (ox < -mm.width * 0.5 || ox > mm.width * 0.5) return false
    } else {
      const a = (-mm.width * 0.5 - ox) / dx
      const b = (mm.width * 0.5 - ox) / dx
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (dy > -1e-12 && dy < 1e-12) {
      if (oy < 0 || oy > mm.height) return false
    } else {
      const a = (0 - oy) / dy
      const b = (mm.height - oy) / dy
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (dz > -1e-12 && dz < 1e-12) {
      if (oz < -mm.depth * 0.5 || oz > mm.depth * 0.5) return false
    } else {
      const a = (-mm.depth * 0.5 - oz) / dz
      const b = (mm.depth * 0.5 - oz) / dz
      tLo = Math.max(tLo, Math.min(a, b))
      tHi = Math.min(tHi, Math.max(a, b))
    }
    if (tLo > tHi) return false
    const hull = this.hull.tri
    let near = Infinity
    let far = -Infinity
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
      if (t > far) far = t
    }
    if (near === Infinity) return false
    span[0] = e[o + 13] - far
    span[1] = e[o + 13] - near
    return true
  }

  /**
   * One bed's share of Rocks.rayAt: the nearest stone of this bed on the ray
   * from (x, y, z) along the unit direction (dx, dy, dz), within `reach`
   * metres, on a rock of at least `minSize`; the hit written into `out` and its
   * distance returned, or `best` unchanged when nothing of this bed is nearer.
   *
   * The same 3x3 tile walk and size gate as _blockAt; the circle reject is
   * against the ray's own footprint (the nearest point of its XZ segment to
   * the rock's origin) rather than a point, and the same slab-then-triangles
   * walk as _spanAt, in the rock's frame, keeping the nearest forward hit and
   * its face. The normal comes out facing the ray, so a hit on a closed shape
   * from outside is the outward normal. `seated` tests each rock at its FIELD
   * height rather than where it is drawn: a rock follows the chunk under it
   * (_reground), which is metres off the field under a coarse chunk, and a
   * probe that must agree across clients and boots cannot see that.
   */
  _rayAt(x, y, z, dx, dy, dz, reach, minSize, best, out, seated = false) {
    const tile = this.tile
    const gx = Math.floor(x / tile)
    const gz = Math.floor(z / tile)
    const mm = this.shape.measured
    const hull = this.hull.tri
    const e = this.instM
    for (let tx = -1; tx <= 1; tx++) {
      for (let tz = -1; tz <= 1; tz++) {
        const t = this.tiles.get((gx + tx) * 0x10000 + (gz + tz))
        if (!t) continue
        for (let k = 0; k < t.n; k++) {
          const id = t.ids[k]
          const size = this.shapeLod * this.instScale[id]
          if (size < minSize) continue
          const s = this.instScale[id]
          const r = this.hull.radius * s
          const ex = x - this.instX[id]
          const ez = z - this.instZ[id]
          // The ray's XZ segment, clamped at its ends, nearest the origin.
          const l2 = dx * dx + dz * dz
          const u = l2 > 1e-12 ? Math.max(0, Math.min(reach, -(ex * dx + ez * dz) / l2)) : 0
          const cx = ex + dx * u
          const cz = ez + dz * u
          if (cx * cx + cz * cz >= r * r) continue
          const o = id * 16
          // Per column, not one `1 / (s * s)`: the column the rock stands on is
          // `scale * squash` long. Unnormalised local direction, so `t` is in
          // world metres -- see _spanAt.
          const c0 = 1 / (e[o] * e[o] + e[o + 1] * e[o + 1] + e[o + 2] * e[o + 2])
          const c1 = 1 / (e[o + 4] * e[o + 4] + e[o + 5] * e[o + 5] + e[o + 6] * e[o + 6])
          const c2 = 1 / (e[o + 8] * e[o + 8] + e[o + 9] * e[o + 9] + e[o + 10] * e[o + 10])
          const ey = y - (seated ? this.field.heightAt(this.instX[id], this.instZ[id]) - this.instSink[id] : e[o + 13])
          const ox = (e[o] * ex + e[o + 1] * ey + e[o + 2] * ez) * c0
          const oy = (e[o + 4] * ex + e[o + 5] * ey + e[o + 6] * ez) * c1
          const oz = (e[o + 8] * ex + e[o + 9] * ey + e[o + 10] * ez) * c2
          const ldx = (e[o] * dx + e[o + 1] * dy + e[o + 2] * dz) * c0
          const ldy = (e[o + 4] * dx + e[o + 5] * dy + e[o + 6] * dz) * c1
          const ldz = (e[o + 8] * dx + e[o + 9] * dy + e[o + 10] * dz) * c2
          const tMax = Math.min(reach, best)
          let tLo = 0
          let tHi = tMax
          let miss = false
          for (let a = 0; a < 3 && !miss; a++) {
            const oc = a === 0 ? ox : a === 1 ? oy : oz
            const dc = a === 0 ? ldx : a === 1 ? ldy : ldz
            const lo = a === 0 ? -mm.width * 0.5 : a === 1 ? 0 : -mm.depth * 0.5
            const hi = a === 0 ? mm.width * 0.5 : a === 1 ? mm.height : mm.depth * 0.5
            if (dc > -1e-12 && dc < 1e-12) {
              if (oc < lo || oc > hi) miss = true
            } else {
              const p = (lo - oc) / dc
              const q = (hi - oc) / dc
              tLo = Math.max(tLo, Math.min(p, q))
              tHi = Math.min(tHi, Math.max(p, q))
            }
          }
          if (miss || tLo > tHi) continue
          let near = tMax
          let face = -1
          for (let f = 0; f < hull.length; f += 9) {
            const e1x = hull[f + 3], e1y = hull[f + 4], e1z = hull[f + 5]
            const e2x = hull[f + 6], e2y = hull[f + 7], e2z = hull[f + 8]
            const hx = ldy * e2z - ldz * e2y
            const hy = ldz * e2x - ldx * e2z
            const hz = ldx * e2y - ldy * e2x
            const det = e1x * hx + e1y * hy + e1z * hz
            if (det > -1e-12 && det < 1e-12) continue
            const invDet = 1 / det
            const sx = ox - hull[f]
            const sy = oy - hull[f + 1]
            const sz = oz - hull[f + 2]
            const uu = (sx * hx + sy * hy + sz * hz) * invDet
            if (uu < 0 || uu > 1) continue
            const qx = sy * e1z - sz * e1y
            const qy = sz * e1x - sx * e1z
            const qz = sx * e1y - sy * e1x
            const vv = (ldx * qx + ldy * qy + ldz * qz) * invDet
            if (vv < 0 || uu + vv > 1) continue
            const tt = (e2x * qx + e2y * qy + e2z * qz) * invDet
            if (tt >= 0 && tt < near) { near = tt; face = f }
          }
          if (face < 0) continue
          best = near
          // The face's normal, the rock's frame to the world's, by the INVERSE
          // TRANSPOSE: with orthogonal columns that is each column over its own
          // squared length, so a squashed slab's top normal still stands off its
          // top and not off the boulder's.
          const nx = hull[face + 4] * hull[face + 8] - hull[face + 5] * hull[face + 7]
          const ny = hull[face + 5] * hull[face + 6] - hull[face + 3] * hull[face + 8]
          const nz = hull[face + 3] * hull[face + 7] - hull[face + 4] * hull[face + 6]
          let wx = e[o] * nx * c0 + e[o + 4] * ny * c1 + e[o + 8] * nz * c2
          let wy = e[o + 1] * nx * c0 + e[o + 5] * ny * c1 + e[o + 9] * nz * c2
          let wz = e[o + 2] * nx * c0 + e[o + 6] * ny * c1 + e[o + 10] * nz * c2
          const len = Math.hypot(wx, wy, wz)
          if (wx * dx + wy * dy + wz * dz > 0) { wx = -wx; wy = -wy; wz = -wz }
          out.x = x + dx * best; out.y = y + dy * best; out.z = z + dz * best
          out.nx = wx / len; out.ny = wy / len; out.nz = wz / len
          out.ox = this.instX[id]; out.oz = this.instZ[id]
          out.size = size
        }
      }
    }
    return best
  }

  /**
   * The cursor's pick volume for one instance, in world metres: the boulder's
   * footprint and its height, both at this instance's own scale.
   *
   * A constant pair cannot do this job even with one shape, because `instScale`
   * spreads it fifty-fold across the beds: the same radius/rise is metres of empty
   * air around a shore stone and a volume stopping well below the top of a
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
      // Per rung: the instances drawn on it and the triangles that costs, the
      // ghosts of a cross-dissolve counted in the tier they are leaving. The
      // counts sum to `placed - rimHidden` and the triangles to `tris`, each as
      // of its tile's last walk.
      lod: Array.from(this.tileTierN, (n, b) => ({ n, tris: (n + this.ghostsAt[b]) * this.tierTris[b] })),
      walked: this.walked,
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

}

// The beds looseCountIn counts, and its saturation; the scratch is written and never read.
const LOOSE_BEDS = new Set(['boulders', 'scree', 'giants'])
// The beds a hand can lift from: the scree and the shore stones, whose small end is a stone. A boulder is a boulder at any size it comes in, and the sunken, the embedded and the giants are the hill's.
export const LIFT_BEDS = new Set(['scree', 'shore'])
const LOOSE_COUNT_CAP = 256
const looseScratch = new Float32Array(LOOSE_COUNT_CAP * 4)

/**
 * All the world's stone: one bank, one material, one bed per BEDS entry.
 *
 * The public shape matches Trees/Ferns/Grass -- construct, `place` once at
 * spawn, `update` every frame, `syncBands` after the layers are known -- so
 * v2/main.js wires it exactly like the other three.
 */
export class Rocks {
  /**
   * @param scene         THREE.Scene. Gets `batch`, the one group of tier meshes.
   * @param field         V2Height. Needs scatterAt, heightAt, snowLineAt, bands.
   * @param water         WaterSurfaces. Needs levelAt, isSubmerged and shoreDistAt.
   * @param layers        Layers. Needs `snow.band` and dirtAt, for the ground
   *                      cue -- see GROUND_CUE. Same argument Ferns takes and in
   *                      the same position.
   * @param textureArray  The shared prop atlas from buildTextureArray().
   * @param opts.ground   TerrainV2, or null for headless probes. See Trees.
   * @param opts.bank     buildRockBank()'s answer when the caller built it already (a room's shell shares it); built here otherwise.
   */
  constructor(scene, field, water, layers, textureArray, { seed = 1, ground = null, hollows = true, bank = null, bounds = null } = {}) {
    if (!field || typeof field.scatterAt !== 'function') throw new Error('Rocks: needs a V2Height with scatterAt')
    if (!water || typeof water.levelAt !== 'function' || typeof water.shoreDistAt !== 'function') {
      throw new Error('Rocks: needs WaterSurfaces with levelAt and shoreDistAt')
    }
    if (!layers || typeof layers.dirtAt !== 'function' || typeof layers.shoreAt !== 'function' || !layers.snow) {
      throw new Error('Rocks: needs Layers with dirtAt, shoreAt and a snow field')
    }
    if (ground && typeof ground.groundAt !== 'function') {
      throw new Error('Rocks: `ground` was given but has no groundAt -- pass the TerrainV2 or nothing')
    }

    const t0 = performance.now()
    // NO SEED. `seed` is the world's and every bed below takes it, because where
    // the rocks land is world-seeded; the boulder ITSELF is art direction and is
    // pinned to the seed it was signed off at. See BOULDER.
    if (bank === null) bank = buildRockBank()
    this.bank = bank

    // ONE material for every bed: every tier of every bed is a rock mesh on the
    // one stone layer, so there is one program here whatever the bed -- four
    // draw calls for the layer, one program, one atlas.
    //
    // FRONT FACES ONLY, alone among the prop materials. Every other one draws
    // cutout foliage, where both sides of a leaf are the same leaf; a rock is a
    // CLOSED SOLID whose back faces are behind its own front ones, so culling
    // them halves the raster work for nothing given up. check-rocks.mjs holds
    // the outward winding on every tier, because the failure is invisible from
    // any angle that has a front face to look at.
    //
    // `instancedFade` IS WHAT MAKES THE TWO DISSOLVES DRAW. The beds are
    // InstancedMeshes, so the fade slot is the `aPropFade` attribute PropArena
    // hangs on every geometry, and the attribute has to be DECLARED for the
    // vertex stage to read it -- without this line RimFade and _crossFade still
    // stamp their timers, still hold their ghosts and still reclaim them, over a
    // shader in which `vPropFade` is the constant 1. The batched path needs no
    // flag (the slot is the colour texture's alpha), which is why this went
    // unnoticed across the move off BatchedMesh.
    this.material = createPropMaterial(textureArray, {
      side: THREE.FrontSide,
      bump: true,
      instancedFade: true,
    })

    // A room (DESIGN.md §30) has no hollow bed: no village inside a village.
    const beds = hollows ? BEDS : BEDS.filter((cfg) => !cfg.hollow)
    // The world's own biome field, for the beds that gate on cover (the hollow bed).
    const biome = beds.some((cfg) => cfg.deep > 0) ? new BiomeField({ seed }) : null
    this.beds = beds.map(cfg => new RockBed(field, water, layers, bank, cfg, { seed, ground, biome, bounds }))

    // ONE MESH PER TIER FOR THE WHOLE LAYER, capped at the sum of what every bed
    // bounded for that tier (`_tierCaps`): each bed's cap already holds its own
    // population and its ghosts' room, so the sum holds the union. A bed's shape
    // is a variant column of the set, and today every bed takes the boulder, so
    // the set is four meshes and the cap's geometries go undrawn and disposed.
    const shapes = []
    for (const bed of this.beds) if (!shapes.includes(bed.shape)) shapes.push(bed.shape)
    const caps = new Array(ROCK_BAND_COUNT).fill(0)
    for (const bed of this.beds) for (let t = 0; t < ROCK_BAND_COUNT; t++) caps[t] += bed.tierCaps[t]
    this.meshes = new PropMeshes(
      Array.from({ length: ROCK_BAND_COUNT }, (_, t) => ({ geometries: shapes.map((sh) => sh.tiers[t]) })),
      caps,
      this.material,
      'v2-rocks'
    )
    this.batch = new THREE.Group()
    this.batch.name = 'v2-rocks'
    this.batch.frustumCulled = false
    for (const mesh of this.meshes.meshes) this.batch.add(mesh)
    for (const bed of this.beds) bed.attach(this.meshes, shapes.indexOf(bed.shape))
    scene.add(this.batch)
    const drawn = new Set(shapes.flatMap((sh) => sh.tiers))
    for (const g of bank.geometries) if (!drawn.has(g)) g.dispose()

    this.buildMs = performance.now() - t0
    this.placeMs = 0
    this.updateMs = 0
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
    const tStart = performance.now()
    const slice = BUILD_BUDGET_MS / this.beds.length
    for (const bed of this.beds) bed.update(camX, camY, camZ, slice)
    // The whole of this call, smoothed over ~20 frames: the layer's main-thread
    // bill, which the headset cannot otherwise separate from its draw cost.
    this.updateMs += (performance.now() - tStart - this.updateMs) * 0.05
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
   * scree or the shore; the argument is on the flags in BEDS. They fill `out` in bed
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
   * Every rock a crab may walk on with its origin in the half-open box, on the same
   * terms as anchorsInto (saturation, half-open, bed order) but STRIDE 5: slot 3 is
   * THE HULL'S CIRCUMSCRIBED RADIUS at instance scale, not the footprint, and slot 4
   * the rock's size -- its longest measured extent, the same size `blockTopAt`
   * screens on. A crab wants the disc the stone's surface can be found in, and it
   * is `blockTopAt(x, z, size, false)` inside that disc that tells it where the
   * stone actually is. Only the beds flagged `perch` answer -- the boulders and the
   * sunken stones, both of which stand in and beside lakes. See v2/render/crabs.js.
   */
  perchesInto(x0, z0, x1, z1, out) {
    const cap = (out.length / PERCH_STRIDE) | 0
    let w = 0
    for (const bed of this.beds) {
      if (!bed.perch) continue
      w = bed._perchesInto(x0, z0, x1, z1, out, w, cap)
    }
    return w
  }

  /**
   * How many LOOSE rocks -- boulders, scree, giants -- have their origin in the
   * half-open box, saturating at LOOSE_COUNT_CAP. The talus she is standing in,
   * for the rockslide sounds (v2/audio); the embedded and cliff beds are the hill
   * itself and do not count.
   */
  looseCountIn(x0, z0, x1, z1) {
    let w = 0
    for (const bed of this.beds) {
      if (!LOOSE_BEDS.has(bed.cfg.name)) continue
      w = bed._rocksInto(x0, z0, x1, z1, looseScratch, w, LOOSE_COUNT_CAP, 0, 4)
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
   * is dropped through the finest tier's triangles (RockBed._spanAt), so a prop
   * over a boulder's shoulder stands on the shoulder and a prop over the corner of
   * its box -- where the circumscribed circle reaches and the rock does not -- gets
   * -Infinity and stays on the ground. What it is NOT is a containment test: the
   * answer is the highest surface over the point at any height, so a prop under an
   * overhang is raised onto the overhang rather than left beneath it. That is the
   * right answer for the case this exists for (a boulder is wider than it is tall)
   * and the wrong one for a spire, which is why the spire's bed is not flagged --
   * and the wrong one for a walker, who asks columnAt instead.
   *
   * ONLY THE BEDS FLAGGED `blocks` ANSWER; the argument is on the flags in BEDS.
   * The query is keyed rather than swept -- see RockBed._blockAt -- so it is nine
   * Map lookups per bed and it can be afforded per candidate.
   *
   * WHATEVER THE QUEST TOGGLE SAYS. The rock toggle sets `batch.visible` and the
   * beds are placed and stepped either way, so a world with the rocks switched off
   * has its trees in the same places as one with them on. See v2/main.js.
   *
   * `settle = false` RETURNS THE STONE'S SURFACE ITSELF, unsettled, for a caller
   * that sits on the rock rather than stands in it -- a crab is a tenth of a metre
   * tall and a 35 cm settle puts it inside the boulder.
   */
  blockTopAt(x, z, minSize, settle = true) {
    let top = -Infinity
    for (const bed of this.beds) {
      if (bed.blocks) top = bed._blockAt(x, z, minSize, top, settle)
    }
    return top
  }

  /**
   * Every span of blocking stone on the vertical line through (x, z), written
   * into `out` at SPAN_STRIDE as [bottom, top] in world metres, unsettled, one
   * per rock the line passes through. Returns how many were written; zero over
   * clear ground.
   *
   * WHAT THIS IS FOR: blockTopAt answers "what is the highest stone over this
   * point", which is the right question for a prop being seated and the wrong
   * one for a walker, who cares whether the stone is under her feet or over her
   * head. v2/walk.js takes the spans and decides which of them is ground from
   * where she is standing, and whether the rest leave her room to stand -- so
   * the same query that seats a fern on a boulder's shoulder lets her walk
   * under the boulder's overhang, where blockTopAt would have lifted her onto
   * it. The cost is _blockAt's: the same walk, the same ray, both ends kept.
   *
   * SATURATES like anchorsInto -- nothing is written past `out`, and a caller
   * handed back its own capacity should treat the answer as truncated. Same
   * `minSize` gate and the same `blocks` flag as blockTopAt.
   */
  columnAt(x, z, minSize, out) {
    const cap = (out.length / SPAN_STRIDE) | 0
    let w = 0
    for (const bed of this.beds) {
      if (bed.blocks) w = bed._columnAt(x, z, minSize, out, w, cap)
    }
    return w
  }

  /**
   * The nearest blocking stone on the ray from (x, y, z) along the unit
   * direction (dx, dy, dz), within `reach` metres, on a rock of at least
   * `minSize`: the hit point, its outward unit normal, the rock's origin (`ox`,
   * `oz`, the same figures perchesInto reports) and its size written into
   * `out`, and the distance returned; Infinity, `out` untouched, when the ray
   * finds no stone. The one query that answers for a rock's SIDES: blockTopAt
   * and columnAt drop a vertical line and can only say where its top and
   * bottom are, and a creature that clings to a face (the spiders) needs the
   * face itself, wherever it looks. The same finest-tier triangles as
   * _spanAt, so the answer is the drawn stone up close, and the same 3x3 tile
   * walk, so it costs what blockTopAt does plus the triangles of the rocks the
   * ray's footprint crosses.
   */
  /**
   * The drawn stone of a LIFT_BEDS bed nearest a hand at (x, y, z) within
   * `reach` metres and under `maxSize` across, which is what she can lift: the
   * small end of the scree and the shore stones, never a boulder however small.
   * `{ dist, bed, tile, k, id, size }` for take(), or null. For hands.js.
   */
  pickAt(x, y, z, reach, maxSize) {
    let best = null
    for (const bed of this.beds) {
      if (!LIFT_BEDS.has(bed.cfg.name)) continue
      const hit = bed.pickAt(x, y, z, best ? best.dist : reach, maxSize)
      if (hit && (!best || hit.dist < best.dist)) best = hit
    }
    return best
  }

  /**
   * Lift the rock of a pickAt() hit out of its bed and return what the hand
   * holds as a record for hands.js: the boulder at LOD0 on the one stone
   * material -- the shape every bed takes, and the one `dress` puts back --
   * the rock's tint and scale; one under `stowMax` metres may go in the backpack.
   */
  take(hit, stowMax) {
    const { color, scale } = hit.bed.take(hit)
    return {
      kind: 'rock',
      name: 'rock',
      size: hit.size,
      geometry: this.beds[0].shape.tiers[0],
      material: this.material,
      color,
      scale: [scale, scale, scale],
      stowable: hit.size < stowMax,
    }
  }

  /**
   * A peer lifted the stone at (x, z): lift it out of its bed here too and
   * record its spot. True when a LIFT_BEDS bed has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'rock') return false
    for (const bed of this.beds) {
      if (!LIFT_BEDS.has(bed.cfg.name)) continue
      const hit = bed.standingAt(x, z)
      if (!hit) continue
      bed.take(hit)
      return true
    }
    return false
  }

  /** The boulder every bed takes, its tiers and measured extents, and the one stone material: for a layer drawing a few rocks of its own (entrances.js's flanking stones). */
  boulder() {
    const shape = this.beds[0].shape
    return { tiers: shape.tiers, measured: shape.measured, material: this.material }
  }

  /** The geometry and material a packed rock record is drawn with: the boulder at LOD0 on the stone material. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'rock') throw new Error(`Rocks.dress: not a rock, ${slot.kind}`)
    return { geometry: this.beds[0].shape.tiers[0], material: this.material }
  }

  rayAt(x, y, z, dx, dy, dz, reach, minSize, out) {
    let best = Infinity
    for (const bed of this.beds) {
      if (bed.blocks) best = bed._rayAt(x, y, z, dx, dy, dz, reach, minSize, best, out)
    }
    return best
  }

  /**
   * Every resident entrance boulder (the `hollow` bed, DESIGN.md §30) with its
   * origin in the half-open box, on perchesInto's terms (saturation, half-open,
   * stride 5) except that slots 0..2 are the boulder's centre rather than its
   * origin; slot 3 is the hull's radius about it and slot 4 the size. For
   * entrances.js.
   */
  hollowsInto(x0, z0, x1, z1, out) {
    const cap = (out.length / PERCH_STRIDE) | 0
    let w = 0
    for (const bed of this.beds) {
      if (!bed.cfg.hollow) continue
      w = bed._hollowsInto(x0, z0, x1, z1, out, w, cap)
    }
    return w
  }

  /**
   * The tint a boulder of `env`'s commonest stone wears standing at (x, z): the
   * palette gain at the middle of the per-instance jitter, pulled toward the
   * ground there by GROUND_CUE, as the placement rolls it. A room's shell takes
   * this so the inside of the boulder is the stone of the boulder she walked into.
   */
  tintAt(x, z, env, out = new THREE.Color()) {
    if (!(env in ENV_TINTS)) throw new Error(`Rocks.tintAt: no environment ${env}`)
    const bed = this.beds[0]
    const g = bed.field.scatterAt(x, z, PLACEMENT_CELL, bed._scatter)
    const snowLine = bed.field.snowLineAt(x, z)
    const { altLo, altSpan } = bed.field.bands
    const gc = bed._gc
    const layers = bed.layers
    shade(g.h, 1 / Math.hypot(g.tan, 1), snowLine, layers.snow.band, layers.dirtAt(x, z), layers.shoreAt(x, z, g.h), altLo, altSpan, x, z, gc, 0)
    const gain = TINT_GAIN[ENV_TINTS[env][0]]
    const cue = GROUND_CUE[env]
    const v = 0.86 + 0.5 * 0.3
    return out.setRGB(gain[0] * v * (1 - cue + gc[0] * cue), gain[1] * v * (1 - cue + gc[1] * cue), gain[2] * v * (1 - cue + gc[2] * cue))
  }

  /** The critter LOD tint row's rock: every entrance boulder purple, so a village can be found from across a wood. */
  setHollowTint(on) {
    for (const bed of this.beds) if (bed.cfg.hollow) bed.setTint(on ? HOLLOW_TINT : null)
  }

  /** The colour the entrance boulder nearest (x, z) was placed with, its own roll rather than tintAt's middle, so a stone tucked against it matches it; none within 20 m throws. */
  hollowTintAt(x, z, out = new THREE.Color()) {
    let best = 400, bx = -1, bid = -1
    for (let b = 0; b < this.beds.length; b++) {
      const bed = this.beds[b]
      if (!bed.cfg.hollow) continue
      const tile = bed.tile
      for (let gx = Math.floor((x - 20) / tile); gx <= Math.floor((x + 20) / tile); gx++) {
        for (let gz = Math.floor((z - 20) / tile); gz <= Math.floor((z + 20) / tile); gz++) {
          const t = bed.tiles.get(gx * 0x10000 + gz)
          if (!t) continue
          for (let k = 0; k < t.n; k++) {
            const id = t.ids[k]
            const d = (bed.instX[id] - x) ** 2 + (bed.instZ[id] - z) ** 2
            if (d < best) { best = d; bx = b; bid = id }
          }
        }
      }
    }
    if (bid < 0) throw new Error(`Rocks.hollowTintAt: no entrance boulder within 20 m of ${x.toFixed(1)}, ${z.toFixed(1)}`)
    const n = this.beds[bx].natural
    return out.setRGB(n[bid * 3], n[bid * 3 + 1], n[bid * 3 + 2])
  }

  /** rayAt against the hollow beds alone, any size, each boulder at its field seating: where a ray meets an entrance boulder's own hull, the same on every client. */
  hollowRayAt(x, y, z, dx, dy, dz, reach, out) {
    let best = Infinity
    for (const bed of this.beds) {
      if (bed.cfg.hollow) best = bed._rayAt(x, y, z, dx, dy, dz, reach, 0, best, out, true)
    }
    return best
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
   * one. A row whose `d` is past `farAt` while `tier` is still a sampled mesh is
   * the ladder itself being wrong.
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
          const size = bed.instLod[id]
          const tier = bed.tierAt[id]
          const gone = bed.rim.gone[id]
          rows.push({
            bed: bed.cfg.name,
            d: +d.toFixed(1),
            size: +size.toFixed(2),
            tier: tier === ROCK_BAND_COUNT - 1 ? 'far' : `mesh${tier}`,
            tris: bed.tierTris[tier],
            farAt: +(size * last).toFixed(1),
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
   *   frames. Nothing in the rock pipeline reads the camera's ORIENTATION any
   *   more -- the beds are on PropArena, which has no per-instance cull, and
   *   RockBed.update takes x, y, z and no gaze -- so a bed whose `n` moves with
   *   the head is a bug rather than a setting.
   *
   *   THE DRAW LIST IS STEADY AND THE ROCK MOVES. `y` and `ground` say which. Rocks
   *   are BEDDED, so a drawn surface stepping up by a fraction of a metre buries
   *   one and a surface stepping back down returns it -- the one way a half-buried
   *   prop can blink while a tree beside it does not, and the terrain's own
   *   selection is gaze-dependent (quadtree-v2.js inCone) where this file is not.
   *
   * `n` is a tier mesh's live instance count over every bed, read at submission
   * rather than off the arena, so that a tier dropped from the render list
   * entirely reads as -1 instead of as its population. `passes` is how many times
   * the layer was submitted that frame: three when both probes fire, one when
   * neither does. The MAIN render is always last -- main.js runs both probes first
   * -- so `n` is the last pass's count, the one the screen got.
   */
  watch(seconds = 6, delay = 5) {
    if (typeof requestAnimationFrame !== 'function') {
      throw new Error('Rocks.watch is a browser instrument: there is no frame loop here to sample')
    }
    if (this._watching) throw new Error('Rocks.watch is already running')
    this._watching = true

    // Hooked on the MESHES and not on the group: a Group is walked by
    // projectObject rather than rendered, so it never gets an onBeforeRender of
    // its own.
    const beds = this.beds
    const meshes = this.meshes.meshes
    const tierNames = meshes.map((_, t) => (t === meshes.length - 1 ? 'far' : `mesh${t}`))
    const saved = meshes.map((m) => m.onBeforeRender)
    const passes = []
    let lastCam = null
    let lastRenderer = null
    const install = () => {
      meshes.forEach((mesh, j) => {
        mesh.onBeforeRender = function watched(renderer, scene, camera, geometry, material) {
          saved[j].call(this, renderer, scene, camera, geometry, material)
          passes.push({ tier: j, n: this.count })
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
      for (let j = 0; j < meshes.length; j++) {
        // One entry per mesh per pass, so the last of them is the last pass,
        // which is what that pass submitted.
        const mine = passes.filter((p) => p.tier === j)
        row[tierNames[j]] = mine.length ? mine[mine.length - 1].n : -1
        if (j === 0) row.passes = mine.length
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

      meshes.forEach((mesh, j) => { mesh.onBeforeRender = saved[j] })
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
      const names = tierNames
      const out = [`[rocks.watch] ${rows.length} frames over ${seconds}s, camera ${span('cx')} x ${span('cz')}, yaw ${span('yaw')} deg`]
      if (steps('yaw', 1) === 0) {
        out.push('  THE CAMERA NEVER TURNED. Nothing here can say anything about the blink -- re-run and turn during the sample.')
      }
      for (const name of names) out.push(`  ${name} drawn ${span(name)}, changed on ${steps(name, 2)}/${rows.length} frames`)
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
      tris: beds.reduce((n, b) => n + b.tris, 0),
      lod: Array.from({ length: ROCK_BAND_COUNT }, (_, t) => ({
        n: beds.reduce((n, b) => n + b.lod[t].n, 0),
        tris: beds.reduce((n, b) => n + b.lod[t].tris, 0),
      })),
      walked: beds.reduce((n, b) => n + b.walked, 0),
      tiles: beds.reduce((n, b) => n + b.tiles, 0),
      updateMs: this.updateMs,
      pool: beds.reduce((n, b) => n + b.pool, 0),
      used: beds.reduce((n, b) => n + b.used, 0),
      bankKB: Math.round(this.bank.bytes / 1024),
      bankTris: this.bank.triangles,
      buildMs: this.buildMs,
      placeMs: this.placeMs,
    }
  }

  dispose() {
    this.meshes.dispose()
    this.material.dispose()
  }
}
