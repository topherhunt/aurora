import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural dead wood: standing snags, and fallen logs.
//
// These are the forest's LITTER -- the things that hem a path off and break a
// sightline at knee height. Snags and logs are ONE generator: a snag is a log
// stood on end with a broken top. Build a tapered tube swept along a crooked
// spine, cap both ends, hang branch stubs off it, then either leave it standing
// or lay it over. `kind` decides that last step and nothing else.
//
// Four decisions carry the file.
//
// 1. THE SURFACE IS A PURE FUNCTION OF (t, a) -- distance along the spine, angle
//    around it. Every tier evaluates the same `radiusAt` on fewer rings and
//    sides, so a tier change loses FACETS rather than swapping in another log,
//    and the shape can be costed without being built.
// 2. THE CROSS-SECTION IS NOT A CIRCLE AND THE SPINE IS NOT A LINE. A live trunk
//    can be a lathe-turned cone because its canopy hides it; dead wood is looked
//    AT, from two metres. `ovality`, `lobes`, `swell`, `checks` and `kink` are
//    what stop it reading as a fence post. Every angular term has an INTEGER
//    period in `a`, which closes the seam exactly at a = TAU and is what keeps
//    decision 1 true at any side count.
// 3. BARK COMES OFF, AND WHERE IT HAS GONE THE SURFACE DROPS by `barkThick` --
//    a real step in silhouette, not a change of colour. `barkAt` picks the layer
//    per FACE (species bark, or LAYER.TIMBER_BEAM for bare wood), which is the
//    only reason this geometry is non-indexed. NO NEW TEXTURE LAYERS: a snag and
//    a log cost this file and nothing else on disk.
// 4. IT SITS ON THE GROUND BY BEING CUT OFF AT IT. `sink` drops the piece below
//    y = 0 and everything under the plane is clamped UP onto it -- rock.js's
//    `sit`. The cost is a ribbon of degenerate faces along the contact line,
//    which take the shell normal for want of a face normal of their own.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, non-indexed with an
// identity index -- the shared prop material's layout (src/material.js), which
// BatchedMesh validates and refuses the whole batch over.
//
// DESIGN.md §21 has the rest: what each decision cost, the tier ladder and the
// budget it went over on purpose, the broken rim's two failed designs, the
// normal clamp, the winding bug, and how a log beds. Triangle budgets are §5.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

// The most of its own length either broken end may eat. See `endT`.
export const MAX_JAG = 0.4

// The three numbers that turn `jag0`/`jag1` from a ceiling into an amount; all of
// the argument for them is in `jagComb`, which is the only place they are used.
export const JAG_FULL = 3.5 // the slider value that means "eat the whole of MAX_JAG"
const JAG_WIDTH = 0.4 // how unevenly the splinters are spaced: widths run 1 +/- this
const JAG_SHALLOW = 0.3 // the shallowest rung of the notch-depth ladder, the deepest being 1
// How broad the splinters get, as the exponent on each notch flank. It moves the
// SHOULDER, not the floor: a high one holds the rim up further either side of the
// splinter. 2.0 lands two adjacent vertices at the rim on about half of seeds.
const JAG_SLAB_LO = 0.6 // the narrowest a splinter gets: a spike, one vertex wide
const JAG_SLAB_HI = 2.0 // ...and the broadest: a slab with a shoulder either side

// THE STUB TIP, at T0 only. A stub is a branch that BROKE, and the break is the
// only part of it anybody stands close enough to read -- the barrel behind it is
// a smooth taper whatever you spend on it. So the tip gets the detail: the ring
// wanders along the axis (STUB_TIP_JAG, a fraction of the stub's own length) and
// then closes on a point somewhere along it.
//
// THE POINT IS BIMODAL AND LOPSIDED, and the GAP IN THE MIDDLE is the point of
// it. A tip level with its own rim is a flat disc with a few creases in it, and
// that is the one thing a break never looks like, so the point always clears the
// rim's whole range -- deep on the sunk side, modest on the proud side.
//
// SUNK is a branch that rotted from the inside and left a socket, and a socket is
// DEEP or it does not read as one at all. PROUD is a branch that tore, and what
// is left standing is a splinter -- push it out as far as a socket goes in and
// the stub grows a horn and stops reading as wood. Hence the two ranges, and they
// are measured from the rim vertex NEAREST each one rather than from the mean, so
// a deep jag cannot eat the gap and leave the point level with the rim after all.
// Even odds: a wood has both.
//
// The taper is what makes the sides quads rather than a cone: a broken branch
// base is a short barrel, and a cone converging on a single apex is the one
// thing it never looks like.
const STUB_TIP_TAPER = 0.78 // tip radius as a fraction of the base's
const STUB_TIP_JAG = 0.22 // how far a tip vertex wanders along the axis, of `len`
const STUB_TIP_SOCKET = [0.20, 0.45] // sunk, behind the NEAREST rim vertex, of `len`
const STUB_TIP_SPLINTER = [0.08, 0.25] // proud, past the FURTHEST, of `len`

// How far a stub may slide off the regular spacing below, in radians. The bound
// that matters is not the golden angle itself: at six stubs the angle's TIGHTEST
// gap is 32.5 degrees, and two neighbours each free to move J close on each other
// by 2J, so anything at or above 16.25 degrees can let a pair trade places and
// stack up -- the exact failure the spacing is there to prevent. 0.25 rad is 14.3
// degrees, under that with a margin.
const STUB_AZIMUTH_JITTER = 0.25

// The mesh tiers, finest first. Not different SOLIDS the way the rock ladder is:
// the same swept surface at different sampling rates. `sides` is how many facets
// go round, `ringMul` scales the rings along the spine, and `stubMul` is what
// fraction of the branch stubs survive.
//
// A COARSER TIER LOSES SIDES, NOT RINGS. Sides buy roundness, which at the range
// a coarse tier is used at is doing almost nothing; rings buy the SPINE, and
// crookedness is most of what separates dead wood from a fence post. So every
// mesh tier keeps every ring, and five sides is the floor -- the fewest that can
// still express `jag`. There are TWO mesh tiers and then a card, not three.
//
// FIFTEEN SIDES AT T0 is the lcm of the two angular features: `roots` puts 5
// buttresses round the base and `jagCount` 5 splinters round the top, and a
// periodic feature sampled at a count it does not divide ALIASES -- silently,
// with no throw and no change to the triangle count. Fifteen gives each lobe
// three samples. Change one of the two and change the other.
//
// A T0 STUB IS A SOLID with a broken end -- a five-sided prism, 3 x `stubSides`
// triangles -- and STUBS SURVIVE TO T1 as one triangle each. Both follow from
// the same fact: a stub breaks the silhouette OUTWARD, so it reads far past the
// range where its thickness does, and near enough to matter it is the thing the
// eye lands on. A cone was the cheap version and looked like a spike.
//
// DESIGN.md §21 argues all five, with the measurements.
export const DEADWOOD_TIERS = [
  { name: 'T0', sides: 15, ringMul: 1.0, stubMul: 1.0, stubFlat: false },
  { name: 'T1', sides: 5, ringMul: 1.0, stubMul: 1.0, stubFlat: true },
]

// DESIGN.md §5's prop table puts stumps and logs in the `bush` row -- a target
// and not a law, but the number the world was budgeted against, so the bench
// prints it beside what was actually built. T0 WENT OVER ON PURPOSE: fifteen
// sides, a fourth ring and solid stubs take a stump from 76 triangles to 210,
// and what makes that affordable is the BAND rather than the count -- the bank
// is two entries, so T0 exists in a shell a few tens of metres deep and there
// are rarely more than a handful of pieces inside it. 216 is the ceiling with
// the stump, the worse of the two, at 210. §21 has the arithmetic.
export const BUDGET_TRIS = [216, 56]

// WHERE EACH TIER ENDS, in metres of camera distance PER METRE of the piece's
// own size -- `deadwoodLodSize` below says which metre that is. T0 inside the
// first, T1 inside the second, the billboard card beyond it.
//
// PER METRE is the correction the ladder was rewritten for. These used to be
// flat distances tuned on a chest-high stump, which is nonsense for a log: they
// reach 34.8 m and distance is measured from the instance ORIGIN, so a player at
// a 20 m log's END is 10 m from its origin looking at five sides from arm's
// length. What decides whether a triangle is worth drawing is ANGULAR size, so
// the threshold carries the size term. Same system as ROCK_LOD_AT, deliberately
// mirrored rather than a second mechanism. 5 and 10 leave the median snag where
// the user set it; §21 has the resulting metres for both kinds.
export const DEADWOOD_LOD_AT = [5, 10]

// Metres, absolute, where dead wood stops being drawn at all. NOT relative: this
// is a fact about the SCATTER rather than about the piece -- the tile grid ends
// here -- and it is the number worth defending. 100 m on a 2 m log is 1.6 px of
// card, which is under the threshold at which anything can be recognised -- but
// a SCATTER of them is not one log, and a field of dead wood thinning out at the
// same radius the trees do is what stops the deadwood layer reading as a ring
// painted round the player.
export const DEADWOOD_CULL = 100

// THE METRE THE LADDER IS MEASURED IN: the longest axis of the piece's box, and
// the same function for a snag and for a log.
//
// One function for both kinds is the point rather than a convenience: the two are
// the same object lying in different directions, so keying on height would card a
// 30 m log at 20 m and keying on plan width would hold a slim spar's mesh out to
// nothing. The ladder is asking how many pixels the piece subtends, and the
// largest extent a box can present is its longest axis. So does `rockLodSize`.
export function deadwoodLodSize(measured) {
  return Math.max(measured.height, measured.width, measured.depth)
}

// The whole family is drawn through a material tinted by this, and nothing else
// in the world wears it.
//
// AGE IS A TINT, NOT A TEXTURE, and the alternative was four more atlas layers.
// Dead wood does not have DIFFERENT bark from live wood, it has the same bark
// greyed and browned by weather, so one multiply says the true thing and leaves
// the atlas alone. It also lands in the right place in the shader: before
// material.js's MOSS_APPLY / SNOW_APPLY, so the wood ages while the moss stays
// green and the snow stays white.
//
// A GREY-BROWN and not an orange one -- rotting wood goes toward mud and ash --
// and a LIGHT multiply, which is the correction the user asked for: a strong
// brown reads as a different MATERIAL rather than as weathered wood, and a piece
// of it on the forest floor is a dark stain instead of settling in. GROUND_CUE in
// v2/render/deadwood.js is the other half, bending each instance toward the
// terrain it stands on, which a constant cannot. §21 has both measurements and
// why two species cannot be aged differently from here.
export const DEADWOOD_TINT = 0xab9d88

export const DEADWOOD_DEFAULTS = {
  seed: 1,

  // 'snag' stands the piece up on its butt; 'log' lays it down. It is the LAST
  // thing that happens -- everything above the placement is shared -- so the two
  // are the same shape seen from two attitudes, and a slider found on one is
  // worth the same on the other.
  kind: 'snag',
  tier: 0,

  // --- size, in real metres --------------------------------------------------
  // Absolute rather than relative, which is the opposite of rock.js's choice and
  // for the opposite reason. Nobody knows how big a rock is, so a rock is
  // authored in relative units and fitted to the scenery; EVERYBODY knows how
  // big a log is, and a 0.9 m trunk lying across a path is a different object
  // from a 0.3 m one rather than the same object closer up.
  length: 0.95, // along the spine: a snag's height, a log's length
  butt: 0.43, // DIAMETER at the base, in metres
  taper: 0.42, // fraction of the butt diameter lost by the far end. Never 1: dead wood is broken off, not sharpened

  // --- the spine -------------------------------------------------------------
  // OFF FOR A STUMP, on for a log (see LOG_DEFAULTS). A lean is a length feature,
  // and a 1.5 m stump is not long enough to show one -- what it shows instead is a
  // base that no longer sits square on the ground it was seated against, and a
  // root crown whose fins are at different heights on the two sides. A log has
  // four to seventeen metres to lean over and needs the bend to not read as dowel.
  bend: 0, // quadratic lean in one azimuth, as a fraction of length -- tree.js's trunkBend
  kink: 0.07, // two harmonics on top of it, so the thing is crooked rather than merely leaning
  // Cycles of the first harmonic over the whole length. Higher on a stump than on
  // a log for the same reason bend is zero there: over 1.5 m, 3.6 cycles is most of
  // one wobble and reads as a lean, and 5 is three wobbles and reads as gnarled.
  kinkFreq: 5,

  // --- the cross-section -----------------------------------------------------
  // A live trunk can be a circle because its canopy hides it. These are what
  // stop a dead one reading as a fence post; see note 2 in the header.
  ovality: 0.08, // 2-lobe: the section is an ellipse, rolled to a per-seed azimuth
  lobes: 0.07, // 3- and 5-lobe on top of that, so it is an irregular polygon rather than an ellipse
  swell: 0, // burls and waists ALONG the length
  swellFreq: 2.2,

  // --- rot -------------------------------------------------------------------
  bark: 1.0, // fraction of the surface still wearing bark. 0 = stripped to the wood, 1 = intact
  barkPatch: 2.7, // how large the sheets are that come away. Higher = smaller patches
  barkThick: 0.02, // metres the surface drops where the bark has gone -- the step that reads in silhouette
  checks: 0, // long radial splits running the length, as a count. 0 = none
  checkDepth: 0, // how far they bite, as a fraction of the radius

  // --- the broken ends -------------------------------------------------------
  // `0` is the butt, `1` is the far end. A standing snag wants a flat bedded
  // butt and a savage top; a log broken out of the middle of a trunk wants both
  // ends ragged; a log that fell with its root plate wants a huge flared butt
  // and a clean break at the other end.
  // How savagely the rim is broken, on a scale where JAG_FULL (3.5) is the most
  // either end may eat and everything below it is a proportional fraction of that
  // -- NOT a ceiling the seed may or may not reach. Half of it really is half as
  // deep a rim, on every seed. `endT` is where that is built and argued.
  jag0: 0.0,
  jag1: 3.5,
  // How many splinters go round. FIVE, matched to `roots` and to T0's fifteen
  // sides: three samples per splinter, one on the tip and two down in the notch,
  // which is the sampling the rim's guarantees are stated against. See the
  // DEADWOOD_TIERS note.
  jagCount: 5,
  // How far the end face is pulled INTO the piece, as a multiple of its own
  // radius. Below 1 this is a dish -- a rotten heart, where a sound break is
  // flat. ABOVE 1 it becomes a HOLLOW: the fan turns into a funnel bored along
  // the spine, deep enough to see down. Costs nothing either way; see buildCap.
  //
  // A STUMP ONLY CARES ABOUT `cup1`, its broken top. `cup0` is in the ground, and
  // boring it deep puts the base ring's geometry where the root crown wants to
  // be -- so a shallow dish. A log keeps 1.6 at both ends: both are visible
  // breaks.
  cup0: 0.5,
  cup1: 1.6,

  // --- the root flare --------------------------------------------------------
  // tree.js has none of this, and can afford not to: the bottom half metre of a
  // living trunk is behind ferns. A snag IS its bottom half metre.
  flare: 0.38, // extra radius at the very base, as a fraction of the butt
  flareRun: 0.22, // over what fraction of the length it dies away
  // How many BUTTRESSES the flare is broken into. 0 or 1 leaves it the smooth
  // collar it used to be; anything from 3 up turns it into roots.
  //
  // A real stump does not meet the ground along a circle but along a STAR: major
  // roots run out from the butt and dive, and between them the trunk is pinched
  // IN, hollow enough to hold leaf litter. That in-and-out is why this is an
  // angular modulation of the flare rather than a separate mesh -- it costs no
  // triangles, only the sides needed to sample it, which is what took T0 to
  // fifteen. FIVE, matched to those fifteen: change one and change the other, or
  // the crown aliases and wanders round the trunk.
  roots: 5,
  // How hard the flare is pulled into the fins, as a fraction of itself. At 1.0
  // the fins carry twice the collar's radius and the gaps carry none. ABOVE 1 the
  // gaps go NEGATIVE -- they cut inside the taper radius -- which is the pinch
  // between two roots and the reason the default is over one. The product is
  // floored with the rest of the radius at the bottom of radiusAt, so a big value
  // makes a deeper notch rather than an inside-out trunk.
  rootBite: 1.05,

  // --- branch stubs ----------------------------------------------------------
  stubs: 4,
  stubStart: 0, // fraction of the length below which no stub grows
  // ...and above which none does, because `jag` and `stubs` are computed
  // independently and the rim is the one that moves: a stub at 0.95 on a piece
  // whose top was eaten back to 0.6 grows out of thin air. It is a BAND CAP AND
  // NOT THE FIX -- the rim is a function of angle, so no constant is under all of
  // it. The fix is in the stub loop. This stays because it also controls where
  // stubs LOOK right, which is the lower two thirds of a snag.
  stubEnd: 0.64,
  stubLength: 2, // as a multiple of the local DIAMETER
  stubRadius: 0.32, // as a fraction of the local trunk radius
  stubRise: 0.28, // radians above horizontal. Dead stubs droop toward horizontal; live branches rise
  // FIVE, and the odd count is the point: a stub is looked at from one side, and
  // an even prism puts a vertex directly opposite every other vertex so the
  // silhouette is two parallel lines whatever angle you walk round to. Five
  // never presents the same pair twice. It is also the count the tip fan needs
  // to read as broken rather than as a cut -- three facets round a break is a
  // dart. T1 draws the stub as one card and ignores this entirely.
  stubSides: 5,

  // --- how it meets the ground -----------------------------------------------
  sink: 0.22, // fraction of the butt RADIUS pushed below y = 0 and clamped back up
  roll: 0, // LOG ONLY: spin about the log's own axis, so the flare and the checks land somewhere
  // LOG ONLY: radians off horizontal -- one end propped up on something.
  //
  // DEFAULTS TO ZERO because pitch is spine WANDER, and a log beds by sinking its
  // whole wander under the plane and letting the clamp flatten it. So every
  // radian dialled in here is a radian the piece gets buried by, and the visible
  // result of a small pitch is not a propped log but a level one sunk deeper at
  // one end. A log that should genuinely be propped wants a big number -- past
  // DEEPEST_BED it stops being absorbed and starts to lift.
  pitch: 0,

  // --- surface and skin ------------------------------------------------------
  smooth: 1.0, // 0 = every face flat, 1 = one smooth shell. End faces stay flat at any setting
  texMetres: 0.86, // world metres one tile covers ALONG the piece
  barkLayer: LAYER.BARK,
  woodLayer: LAYER.TIMBER_BEAM,

  // Ring count along the spine at T0. FOUR on a stump, three on a log: the extra
  // band goes where the stump needs it, which is the run between the root crown
  // dying away at flareRun and the broken rim starting to bite. A log spends its
  // rings over four to seventeen metres of straight trunk and does not miss one.
  rings: 4,
}

// --- the bank ---------------------------------------------------------------
//
// What the world actually ships, and it lives here rather than in the bench
// because a preset table only the previewer could see would let the shape signed
// off and the shape placed drift apart. rock-bank.js argues that at length.
//
// TWO SHAPES, ONE PER ATTITUDE, and the count is set by the ARENA rather than by
// the generator. The bank ships on render/prop-arena.js, one InstancedMesh per
// (tier, variant), so the layer costs `tiers x variants x seeds` draw calls:
// two shapes at one seed over three tiers is six. The length x species cross
// this table used to be was twelve names at two seeds -- seventy-two draw calls
// for the rarest prop in the wood.
//
// The two families stay because a stump and a log share nothing: a stump is what
// is left in the ground after something took the tree, a log is the tree, and no
// yaw or scale turns one into the other. Everything else that used to be an axis
// is either rolled per seed (how chewed the ends are, where the stubs sit, the
// kink in the spine -- see LOG_ROLLS) or bought per instance by the scatter,
// which rescales a stump between SNAG_HEIGHT and a log between LOG_LENGTH and
// gives each its own yaw.
//
// WHAT IS ACTUALLY LOST IS THE BARK. Birch and pine were a `barkLayer` swap on
// an identical mesh, so they cost nothing to author and four more meshes a tier
// to draw; a dead piece is oak now. If they are wanted back, the cheap route is
// `texLayer` as a per-instance attribute -- it is a plain attribute in
// material.js, and InstancedArena.addInstancedAttribute would carry three barks
// on one geometry -- and not three more variants.

// What changes when the piece is lying down rather than standing up.
//
// A SECOND DEFAULTS BLOCK and not a variant, because these are not shape choices
// -- they are the handful of dials whose right value genuinely depends on the
// attitude. DEADWOOD_DEFAULTS is authored for a standing stump (what the bench
// opens on), and these are the numbers that are wrong for a log: almost no root
// flare and no buttress crown, since a log broken out of the middle of a trunk
// never had one; two ends BORED RIGHT OUT rather than one buried butt and one
// rotted top, both breaks at the eye level of somebody walking past; stubs
// running the whole length, the far end being a snap through live wood; the
// crooked spine the stump gives up, without which a 3 m log is a dowel; and one
// ring fewer, because those metres are straight trunk. §21 takes each in turn.
//
// `length`, `jag0`, `jag1` and `stubs` are NOT here. The first is the variant
// axis below and the other three are rolled per seed -- see LOG_ROLLS.
export const LOG_DEFAULTS = {
  kind: 'log',
  flare: 0.1,
  roots: 0,
  cup0: 2,
  cup1: 2,
  stubEnd: 0.95,
  bend: 0.06,
  kinkFreq: 3.6,
  rings: 3,
}

// WHAT A LOG ROLLS PER SEED instead of being authored, and why these three.
//
// `jag0` used to be a variant AXIS. An axis is for a difference you want to be
// able to PLACE -- the scatter picks a variant, so an axis is a knob the world
// can point at a spot. How chewed one particular log's ends are is not that: it
// is the natural spread within one kind of object, and the whole reason two logs
// side by side do not look stamped. Rolling gets that on every piece for free,
// where the axis got exactly two of it and doubled the bank to do so. Both ends
// roll the same range now -- a log with one savage end and one demure one is a
// shape, not a rule. §21 has the ranges read against JAG_FULL, and why stubs run
// 4 to 6 rather than the old flat 2.
const LOG_ROLLS = {
  jag0: [1, 2],
  jag1: [1, 2],
  stubs: [4, 6],
}

// THE LOG, at 4 m. The length is the PROPORTION the shape is authored at rather
// than the length it is drawn at -- the scatter rescales every piece and
// LOG_LENGTH runs to 34.8 m -- and 4 m is the slimmer end of what this generator
// makes at its authored butt diameter, which is what a fallen trunk is. A 2.5 m
// piece is the same swept surface a quarter fatter, which the per-instance scale
// covers.
const LOG_LENGTH_M = 4

// THE STUMP, at 3 m. Tall enough to be a spar a storm snapped rather than
// something somebody cut, which is the silhouette worth having at range, and
// well clear of the floor this generator has: `jag1` eats up to MAX_JAG of the
// LENGTH getting to the broken rim, so a 1 m stump gives 40 cm of itself away to
// its own top and has 60 cm left to be a trunk in.
const STUMP_LENGTH_M = 3

function buildVariantTable() {
  return {
    [`log-${LOG_LENGTH_M}m-oak`]: {
      envs: ['wood', 'old growth', 'path side'],
      p: { ...LOG_DEFAULTS, length: LOG_LENGTH_M, barkLayer: LAYER.BARK },
    },
    [`stump-${STUMP_LENGTH_M}m-oak`]: {
      envs: ['wood', 'clearing', 'burn'],
      p: { kind: 'snag', length: STUMP_LENGTH_M, barkLayer: LAYER.BARK },
    },
  }
}

/**
 * Every shipping deadwood shape, by name.
 *
 * One log and one stump; see the bank header for why it is two and not twelve.
 * The bench reads this as its preset list and the world's scatter reads the same
 * object, so a shape signed off on /gen-deadwood is bit-identical to the one
 * that ships.
 */
export const DEADWOOD_VARIANTS = buildVariantTable()

/** The names, in the order the table declares them. A variant id indexes this. */
export const DEADWOOD_NAMES = Object.keys(DEADWOOD_VARIANTS)

/**
 * A full parameter set for a named variant, on a given seed.
 *
 * Everything the variant does not name goes back to DEADWOOD_DEFAULTS rather
 * than surviving from whatever was on screen before -- a preset that inherited
 * half of the last one is not a shape anybody can sign off. Same contract as
 * rockParams.
 *
 * A LOG ALSO ROLLS THREE OF ITS OWN DIALS HERE rather than inside buildDeadwood:
 * what comes out of this function IS the shape, so the bench's sliders show the
 * rolled values and the seed spinner walks them, where a roll hidden in the
 * builder would leave the bench lying about what it drew. The stream is hashed
 * from the NAME as well as the seed, or the bank's shared seed list would put
 * identically-broken ends on one of every three logs in the world.
 */
export function deadwoodParams(name, seed = 1) {
  const v = DEADWOOD_VARIANTS[name]
  if (!v) throw new Error(`deadwoodParams: no variant named ${name}`)
  const p = { ...DEADWOOD_DEFAULTS, ...v.p, seed }
  if (p.kind !== 'log') return p

  let h = seed | 0
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193)
  const rand = mulberry32((h ^ 0x7f4a7c15) >>> 0)
  p.jag0 = LOG_ROLLS.jag0[0] + rand() * (LOG_ROLLS.jag0[1] - LOG_ROLLS.jag0[0])
  p.jag1 = LOG_ROLLS.jag1[0] + rand() * (LOG_ROLLS.jag1[1] - LOG_ROLLS.jag1[0])
  // Rounded, because `stubs` is a COUNT: the builder walks it as an integer and
  // a fractional value would silently truncate, turning a flat 4-6 into a
  // distribution that never reaches 6.
  p.stubs = Math.round(LOG_ROLLS.stubs[0] + rand() * (LOG_ROLLS.stubs[1] - LOG_ROLLS.stubs[0]))
  return p
}

// --- noise on a cylinder -----------------------------------------------------
//
// Value noise on an (angle, height) lattice that WRAPS in angle and clamps in
// height. The wrap is the whole trick and is not optional here the way it is on
// the bench ground: without it every bark patch is cut in half by a seam running
// the length of the log, at the one angle the UV seam is also at, and the two
// together read as a stripe painted down the trunk. Same shape as
// preview-stage.js's `lattice`, one dimension wrapped instead of two.
function cylLattice(rand, na, nt) {
  const v = new Float32Array(na * (nt + 1))
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (x) => x * x * (3 - 2 * x)
  return (t, a) => {
    const fa = (a / TAU) * na
    const ft = Math.min(1, Math.max(0, t)) * nt
    const ia = Math.floor(fa)
    const it = Math.min(nt - 1, Math.floor(ft))
    const a0 = ((ia % na) + na) % na
    const a1 = (a0 + 1) % na
    const ta = smooth(fa - ia)
    const tt = smooth(ft - it)
    const p = v[it * na + a0]
    const q = v[it * na + a1]
    const r = v[(it + 1) * na + a0]
    const s = v[(it + 1) * na + a1]
    return (p + (q - p) * ta) * (1 - tt) + (r + (s - r) * ta) * tt
  }
}

// --- the broken rim ----------------------------------------------------------
//
// How deep the rim is bitten at each angle, as a fraction of the deepest bite the
// slider allows. `n` splinters go round; between each pair of them the wood is
// eaten away and comes back.
//
// This is NOT a noise field, and the two attempts before it were: one made the
// slider a CEILING that one seed saturated into a shattered top and the next
// never reached, coming out a smooth cone; the other gave evenly spaced teeth of
// near-equal depth, which read as a machined crown because nothing in a rotting
// trunk has a period. Both ask one field to carry HOW MUCH and HOW UNEVEN at
// once, so they are separated here. How much is a fixed ladder of notch depths --
// `dealt` shuffles the SAME multiset on every seed, so the total bite barely
// moves and the deepest notch is exactly what the slider asked for. How uneven is
// the DEAL: which tooth gets which rung, how wide each is, where the ring starts.
// See DESIGN.md §21.
//
// Splinter tips sit at the cell boundaries and notch floors at the centres, with
// a smoothstep between, so the rim is C1 all the way round INCLUDING the seam at
// TAU -- which is what lets it be sampled at any number of sides.
function dealt(rand, n, lo, hi) {
  const v = new Float64Array(n)
  for (let k = 0; k < n; k++) v[k] = n < 2 ? hi : lo + (hi - lo) * (k / (n - 1))
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1))
    const t = v[k]
    v[k] = v[j]
    v[j] = t
  }
  return v
}

function jagComb(rand, n) {
  // Uneven cells, normalised back to a full turn. This is most of what stops the
  // rim reading as machined: a splinter every 72 degrees is a cog.
  const w = new Float64Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) { w[i] = 1 - JAG_WIDTH + rand() * 2 * JAG_WIDTH; sum += w[i] }
  const edge = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) edge[i + 1] = edge[i] + (w[i] / sum) * TAU
  edge[n] = TAU

  // How deep each notch goes, as a fraction of the deepest the slider allows.
  const amp = dealt(rand, n, JAG_SHALLOW, 1)

  // How BROAD each splinter is. One exponent per splinter rather than per tooth,
  // because a splinter is shared by the two notches either side of it and has one
  // width, not two.
  //
  // It is the term that decides whether two neighbouring vertices can both stay
  // up at the rim, which is the readable form of "does this look broken or does
  // it look cut". A spike narrower than the angle between two sides puts exactly
  // one vertex on each and the top is a machined crown however uneven the notches
  // are; a slab is wider and catches two, on about half of seeds.
  const slab = dealt(rand, n, JAG_SLAB_LO, JAG_SLAB_HI)

  const roll = rand() * TAU
  const smooth = (x) => x * x * (3 - 2 * x)

  return (a) => {
    const x = (((a - roll) % TAU) + TAU) % TAU
    let i = 0
    while (i < n - 1 && x >= edge[i + 1]) i++
    const u = (x - edge[i]) / (edge[i + 1] - edge[i])
    // Each half of the notch runs from its own splinter down to the floor at the
    // centre, so a wide splinter and a narrow one can share a notch. Both halves
    // meet the floor with zero slope and leave their splinter with zero slope,
    // which is what keeps the whole rim C1 across every boundary and the seam.
    const gl = Math.pow(smooth(Math.min(1, 2 * u)), slab[i])
    const gr = Math.pow(smooth(Math.min(1, 2 * (1 - u))), slab[(i + 1) % n])
    return amp[i] * gl * gr
  }
}

// ---------------------------------------------------------------------------
// The shape, as pure functions.
//
// `shapeOf` closes over the parameters and the seeded fields and returns the
// three functions every tier evaluates. Nothing in here touches a buffer, knows
// how many sides it will be sampled on, or draws from a random stream -- which
// is what makes the tiers the same piece of wood and what lets the bench predict
// a triangle count without building anything.
// ---------------------------------------------------------------------------
function shapeOf(p) {
  // Four independent streams, tree.js's lesson: a shared stream means adding any
  // new cosmetic knob shifts every draw downstream of it, so tuning `stubs`
  // silently reshuffles the bark. `shape` draws the per-seed phases, `bark` the
  // sheet field, `jag` the splinters, `stub` the branch placement.
  const rand = mulberry32(p.seed >>> 0)
  const barkRand = mulberry32((p.seed ^ 0x9e3779b9) >>> 0)
  const jagRand = mulberry32((p.seed ^ 0x85ebca6b) >>> 0)

  const L = Math.max(0.05, p.length)
  const r0 = Math.max(0.01, p.butt) * 0.5

  const bendAz = rand() * TAU
  const kinkAz = rand() * TAU
  const kp0 = rand() * TAU
  const kp1 = rand() * TAU
  const ovalPhase = rand() * TAU
  const lp0 = rand() * TAU
  const lp1 = rand() * TAU
  const sp0 = rand() * TAU
  const sp1 = rand() * TAU
  const checkPhase = rand() * TAU
  // LAST IN THE STREAM ON PURPOSE. Every draw above feeds a knob that already
  // existed, and this file's own rule is that adding a cosmetic knob must not
  // reshuffle them -- so the root crown's roll goes on the END, where nothing is
  // downstream of it to shift. Without it every stump in a species would put its
  // roots at the same six compass points.
  const rootPhase = rand() * TAU

  // Bark sheets. The lattice is sized so the patches are roughly square on the
  // surface: `barkPatch` cells per metre of circumference, and the same density
  // along the length. Rounded up to at least 3 around, because a two-cell wrap
  // has only one independent value and gives a barber pole.
  const na = Math.max(3, Math.round(TAU * r0 * p.barkPatch * 2.2))
  const nt = Math.max(2, Math.round(L * p.barkPatch))
  const barkField = cylLattice(barkRand, na, nt)

  const jagComb0 = jagComb(jagRand, Math.max(3, Math.round(p.jagCount)))
  const jagComb1 = jagComb(jagRand, Math.max(3, Math.round(p.jagCount)))

  // The spine, in the LOCAL frame: +Y along the piece, t running 0 -> 1. The
  // kink harmonics are anchored at t = 0 by subtracting their own value there,
  // so the butt stays where the placement put it however hard the slider is
  // pulled -- otherwise `kink` also translates the whole piece sideways and
  // reads as a broken dial.
  const kinkAt = (t) =>
    p.kink *
    (0.62 * (Math.sin(t * p.kinkFreq + kp0) - Math.sin(kp0)) +
      0.38 * (Math.sin(t * p.kinkFreq * 2.16 + kp1) - Math.sin(kp1)))

  const spineAt = (t, out) => {
    const b = p.bend * t * t
    const k = kinkAt(t)
    out.set(
      (b * Math.cos(bendAz) + k * Math.cos(kinkAz)) * L,
      t * L,
      (b * Math.sin(bendAz) + k * Math.sin(kinkAz)) * L
    )
    return out
  }

  // The radius, and the whole of note 2 in the header. Every angular term has an
  // INTEGER period in `a`, which is what closes the seam exactly at a = TAU and
  // is what makes the field safe to sample at any number of sides.
  const radiusAt = (t, a) => {
    let r = r0 * (1 - p.taper * t)

    // Root buttress. Quadratic in how far below the flare's reach we are, so it
    // arrives fast at the very bottom rather than swelling the whole butt.
    if (p.flare > 0 && p.flareRun > 1e-4) {
      const f = Math.max(0, 1 - t / p.flareRun)
      let flare = p.flare * f * f
      // ...and broken into ROOTS rather than left as a collar. `fin` runs 1 at a
      // root's centre to 0 in the gap between two, and the remap takes the flare
      // from (1 + bite) of itself down to (1 - bite) -- so past a bite of 1 the
      // gaps subtract and the trunk is pinched in between its own roots.
      //
      // An INTEGER period in `a`, like every other angular term here, which is
      // what closes the seam exactly at a = TAU. See note 2 in the header: the
      // whole radius field has to be samplable at any number of sides.
      const nR = Math.round(p.roots)
      if (nR >= 2 && p.rootBite > 0) {
        const fin = 0.5 + 0.5 * Math.cos(nR * (a + rootPhase))
        flare *= 1 + p.rootBite * (2 * fin - 1)
      }
      r += r0 * flare
    }

    // Not a circle: a rolled ellipse, plus 3- and 5-lobe on top of it. The
    // odd harmonics matter more than the even one -- an ellipse is still a
    // shape a machine could turn, and 3 and 5 are what make it a tree.
    let lobe =
      1 +
      p.ovality * Math.cos(2 * (a + ovalPhase)) +
      p.lobes * (0.6 * Math.cos(3 * a + lp0) + 0.4 * Math.cos(5 * a + lp1))

    // ...and not a cone: burls and waists along the length.
    lobe *=
      1 +
      p.swell *
        (0.6 * Math.sin(t * p.swellFreq * TAU + sp0) + 0.4 * Math.sin(t * p.swellFreq * 1.87 * TAU + sp1))
    r *= lobe

    // Drying checks. A narrow spike rather than a sine, because a check is a
    // SPLIT: it is nearly all flat surface with a few deep grooves in it, and a
    // sine gives you a fluted column instead.
    const n = Math.round(p.checks)
    if (n > 0 && p.checkDepth > 0) {
      const c = Math.cos(n * (a + checkPhase))
      if (c > 0) r *= 1 - p.checkDepth * Math.pow(c, 10)
    }

    // Where the bark has gone, the surface is a bark's thickness further in.
    // This is the step that reads in silhouette; see note 3.
    r -= p.barkThick * (1 - barkAt(t, a))

    return Math.max(r, r0 * 0.06)
  }

  // 1 = bark, 0 = bare wood, with a soft boundary so the radius step is a slope
  // a couple of centimetres wide rather than a cliff the shading cannot survive.
  //
  // The slider is a FRACTION COVERED and only approximately: value noise spends
  // most of its range near its mean, so 0.5 really is about half the surface but
  // 0.2 is rather less than a fifth. It is judged by eye on the bench, which is
  // the only way a number like this is ever judged.
  const barkAt = (t, a) => {
    if (p.bark >= 1) return 1
    if (p.bark <= 0) return 0
    const f = barkField(t, a)
    const s = 0.09
    const lo = p.bark - s
    const hi = p.bark + s
    if (f <= lo) return 1
    if (f >= hi) return 0
    const x = (f - lo) / (hi - lo)
    return 1 - x * x * (3 - 2 * x)
  }

  // Where the tube actually ends, per angle. The rim of a break is ragged, so
  // the LAST RING itself wanders along the spine rather than the cap being stuck
  // on to a clean edge -- which is the only construction that leaves no gap and
  // no doubled rim.
  //
  // The rim's SHAPE is `jagComb`, which is where that is argued. All this adds is
  // the slider: `bite` reads `jag` against JAG_FULL, so half the slider really is
  // half the rim on every seed. MAX_JAG stays as belt and braces; the comb cannot
  // exceed 1 by construction.
  const endT = (a, which) => {
    const jag = which ? p.jag1 : p.jag0
    if (jag <= 0) return which ? 1 : 0
    const bite = Math.min(1, jag / JAG_FULL)
    const d = Math.min(MAX_JAG, MAX_JAG * bite * (which ? jagComb1(a) : jagComb0(a)))
    return which ? 1 - d : d
  }

  return { L, r0, spineAt, radiusAt, barkAt, endT, rand: mulberry32((p.seed ^ 0xc2b2ae35) >>> 0) }
}

// --- the vertex ---------------------------------------------------------------
//
// One point on the swept surface, with its analytic normal.
//
// The ring frame is the fixed LOCAL X/Z pair rather than a frame carried along
// the spine, which is tree.js's choice and right for the same reason: the rings
// stay in horizontal planes and the spine's lean slides them, so a bend never
// twists the texture.
//
// The normal is the real one -- dS/dt x dS/da, both radius derivatives by central
// difference. Cheap at build time, and it is what makes a check and a burl catch
// light instead of being a silhouette-only feature. Pure radial (all tree.js
// computes) lights a flared butt as though it were a cylinder.
const _p = new THREE.Vector3()
const _pa = new THREE.Vector3()
const _pb = new THREE.Vector3()
const _dt = new THREE.Vector3()
const _da = new THREE.Vector3()
const _n = new THREE.Vector3()

function surfacePoint(s, t, a, out) {
  const r = s.radiusAt(t, a)
  const c = Math.cos(a)
  const sn = Math.sin(a)
  s.spineAt(t, _p)
  out.pos.set(_p.x + r * c, _p.y, _p.z + r * sn)

  // dS/da = r_a * radial + r * tangential
  const h = 0.01
  const ra = (s.radiusAt(t, a + h) - s.radiusAt(t, a - h)) / (2 * h)
  _da.set(ra * c - r * sn, 0, ra * sn + r * c)

  // dS/dt = spine'(t) + r_t * radial
  const ht = 0.004
  const t0 = Math.max(0, t - ht)
  const t1 = Math.min(1, t + ht)
  const rt = (s.radiusAt(t1, a) - s.radiusAt(t0, a)) / (t1 - t0)
  s.spineAt(t1, _pa)
  s.spineAt(t0, _pb)
  _dt.subVectors(_pa, _pb).divideScalar(t1 - t0)
  _dt.set(_dt.x + rt * c, _dt.y, _dt.z + rt * sn)

  // dS/dt x dS/da points OUTWARD -- check it on a plain cylinder and the cross
  // product comes back as the radial direction, which is the orientation the
  // winding below is built for.
  _n.crossVectors(_dt, _da)
  const len = _n.length()
  if (len > 1e-9) _n.divideScalar(len)
  else _n.set(c, 0, sn)
  out.nor.copy(_n)
  out.r = r
  return out
}

function vert() {
  return { pos: new THREE.Vector3(), nor: new THREE.Vector3(), u: 0, v: 0, r: 0 }
}

// --- the accumulator ---------------------------------------------------------
//
// Non-indexed triples, because the LAYER is chosen per face -- a face is either
// bark or bare wood and there is no such thing as a vertex that is 40% of each.
// That is the same reason rock.js is non-indexed (per-face projection axis), and
// it carries the same bonus: per-face flat shading is free, so the end cuts can
// stay hard while the barrel stays round.
// cos(80 deg). Ten degrees of margin before a vertex normal reaches its own
// face's horizon, which is enough that interpolation across the face cannot
// reach the horizon either.
const MAX_LEAN = 0.1736

function emitTri(out, a, b, c, layer, smooth) {
  const tri = [a, b, c]

  // The face normal, and whether there is one. `sink` clamps a ribbon of the
  // underside flat onto y = 0 and those faces come out degenerate; they have no
  // face normal to blend toward, so they keep the shell's, exactly as a rock's
  // bedded belly does.
  const ax = b.pos.x - a.pos.x
  const ay = b.pos.y - a.pos.y
  const az = b.pos.z - a.pos.z
  const bx = c.pos.x - a.pos.x
  const by = c.pos.y - a.pos.y
  const bz = c.pos.z - a.pos.z
  let fx = ay * bz - az * by
  let fy = az * bx - ax * bz
  let fz = ax * by - ay * bx
  const area = Math.hypot(fx, fy, fz)
  const usable = area > 1e-9
  if (usable) {
    fx /= area
    fy /= area
    fz /= area
  }

  for (const p of tri) {
    out.pos.push(p.pos.x, p.pos.y, p.pos.z)
    let nx = p.nor.x
    let ny = p.nor.y
    let nz = p.nor.z
    if (usable) {
      nx = fx + (nx - fx) * smooth
      ny = fy + (ny - fy) * smooth
      nz = fz + (nz - fz) * smooth

      // AND NEVER PAST THE HORIZON OF ITS OWN FACE. The analytic normal is the
      // ideal surface's, and the ideal surface has features the tessellation
      // cannot hold: a drying check is a groove eight degrees wide whose walls
      // turn the true normal sixty degrees off radial, and the vertex that lands
      // on a wall sits on a facet spanning forty-five. Where that gap opens past
      // ninety the vertex normal points away from its own face and Lambert lights
      // the whole triangle as facing away -- one black facet in a lit trunk.
      //
      // Below the cap nothing moves, which is every face except the few that
      // straddle a deep check. It is a clamp on the TESSELLATION's honesty, not
      // on the shape's -- raise the side count and it stops biting on its own.
      // ONE PLACE IT DOES NOT REACH: the ground clamp at the end of buildDeadwood
      // moves positions after every face has been emitted, so the buried belly
      // ribbon can lean past the cap again. §21 says why it is left alone.
      const dot = nx * fx + ny * fy + nz * fz
      const nlen = Math.hypot(nx, ny, nz)
      if (nlen > 1e-9 && dot < MAX_LEAN * nlen) {
        // Re-aim: keep the sideways part, rebuild the along-face part so the
        // angle is exactly MAX_LEAN. Rotating rather than blending toward the
        // face normal keeps the direction the check was leaning in.
        const d = dot / nlen
        let sx = nx / nlen - fx * d
        let sy = ny / nlen - fy * d
        let sz = nz / nlen - fz * d
        const sl = Math.hypot(sx, sy, sz)
        if (sl > 1e-9) {
          const k = Math.sqrt(1 - MAX_LEAN * MAX_LEAN) / sl
          nx = fx * MAX_LEAN + sx * k
          ny = fy * MAX_LEAN + sy * k
          nz = fz * MAX_LEAN + sz * k
        } else {
          nx = fx
          ny = fy
          nz = fz
        }
      }
    }
    const nl = Math.hypot(nx, ny, nz) || 1
    out.nor.push(nx / nl, ny / nl, nz / nl)
    out.uv.push(p.u, p.v)
    out.lay.push(layer)
  }
  out.tris++
}

// ---------------------------------------------------------------------------
// buildDeadwood
// ---------------------------------------------------------------------------
// One broken end's rim, sampled at `n` angles, as fractions of the piece's length
// measured from the butt. Same `endT` the build's own end rings ride, so this is
// the rim rather than a model of it.
//
// It exists because the rim CANNOT BE RECOVERED FROM THE MESH: a stub tip and the
// funnel bored down the middle both put vertices at heights that have nothing to
// do with where the wood ends, so anything measuring the break off the geometry
// is really measuring whichever of the three happened to reach highest. The gate
// needs the curve to assert that `jag` means the same thing on every seed.
export function deadwoodRim(options = {}, which = 1, n = 64) {
  const s = shapeOf({ ...DEADWOOD_DEFAULTS, ...options })
  return Array.from({ length: n }, (_, k) => s.endT((k / n) * TAU, which))
}

export function buildDeadwood(options = {}) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(p.tier)))]
  const s = shapeOf(p)

  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const out = { pos: [], nor: [], uv: [], lay: [], tris: 0 }

  // --- the skin ------------------------------------------------------------
  //
  // `uRepeat` is derived rather than dialled: it is how many tiles fit round the
  // butt at the density `texMetres` sets going up, ROUNDED TO AN INTEGER so the
  // seam at a = TAU lands on a tile boundary. tree.js derives its `uRepeat` the
  // same way and for the same reason. `texMetres` is therefore the one texture
  // dial, and it means the same thing in both directions.
  const circumference = TAU * s.r0
  const uRepeat = Math.max(1, Math.round(circumference / p.texMetres))
  const vSpan = s.L / p.texMetres

  const smooth = Math.min(1, Math.max(0, p.smooth))

  // Two rows of vertices at a time, so the strip only ever holds what it needs.
  const rowA = Array.from({ length: sides + 1 }, vert)
  const rowB = Array.from({ length: sides + 1 }, vert)

  const fillRow = (row, ti, ringIndex) => {
    for (let k = 0; k <= sides; k++) {
      // k runs one past `sides` so the seam vertex is DUPLICATED: the same point
      // in space, but at u = uRepeat rather than u = 0. Sharing it would run the
      // whole tile backwards across the last face.
      const a = (k / sides) * TAU
      // The end rings ride `endT`, so the rim of a break wanders along the spine
      // per angle and the cap fans off a genuinely ragged edge.
      const t = ringIndex === 0 ? s.endT(a, 0) : ringIndex === rings ? s.endT(a, 1) : ti
      const v = row[k]
      surfacePoint(s, t, a, v)
      v.u = (k / sides) * uRepeat
      v.v = t * vSpan
      v.t = t
      v.a = a
    }
  }

  // Which layer a face wears: the bark field at the face's own centre. Per face
  // rather than per vertex because `texLayer` is an INDEX -- interpolating
  // between LAYER.BARK and LAYER.TIMBER_BEAM would walk the shader through
  // twenty-four unrelated layers on its way across the triangle.
  const faceLayer = (t, a) => (s.barkAt(t, a) >= 0.5 ? p.barkLayer : p.woodLayer)

  fillRow(rowA, 0, 0)
  for (let r = 1; r <= rings; r++) {
    fillRow(rowB, r / rings, r)
    for (let k = 0; k < sides; k++) {
      const a0 = rowA[k]
      const a1 = rowA[k + 1]
      const b0 = rowB[k]
      const b1 = rowB[k + 1]
      const layer = faceLayer((a0.t + b1.t) * 0.5, ((k + 0.5) / sides) * TAU)
      // Wound so the outward normal computed in surfacePoint agrees with the
      // face winding. Getting this backwards is invisible on a double-sided
      // material until snow lands on the inside of the log.
      emitTri(out, a0, b0, b1, layer, smooth)
      emitTri(out, a0, b1, a1, layer, smooth)
    }
    for (let k = 0; k <= sides; k++) {
      const a = rowA[k]
      const b = rowB[k]
      a.pos.copy(b.pos)
      a.nor.copy(b.nor)
      a.u = b.u
      a.v = b.v
      a.t = b.t
      a.r = b.r
    }
  }

  // --- the two end faces ---------------------------------------------------
  //
  // A fan from the ragged rim to a centre pulled `cup` radii INTO the piece. That
  // dish is what a rotten heart looks like and it costs nothing -- a fan has the
  // same triangle count whether its centre is proud, flat, dished or bored a
  // metre down, which is why `cup` is allowed past 1 and a hollow stump you can
  // see down into is the same sixteen triangles.
  //
  // ALWAYS FLAT SHADED, whatever `smooth` says. §19 records the same rule for the
  // buildings' log ends: an all-smooth log has ends that look like melted wax.
  // The end grain of a break meets the barrel at a right angle and has to keep
  // that arris, and it matters more once the fan is a funnel -- a smoothed funnel
  // wall has no rim, and the rim is the whole reason you read an opening rather
  // than a dark smudge. UVs are a planar projection across the axis: end grain,
  // not bark running round a corner.
  //
  // THE LAYER IS THE SAME QUESTION THE BARREL ASKS, so one dial covers both a
  // snapped trunk (end grain, where the bark is not) and a rotted top (crumbling
  // on out of the bark on the sides). A hollow's WALL is the one place that is
  // arguably wrong; §21 says why it stays as it is.
  const endRing = Array.from({ length: sides + 1 }, vert)
  const capCentre = vert()

  const buildCap = (which) => {
    const cup = which ? p.cup1 : p.cup0
    let tRim = 0
    let cr = 0
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      const t = s.endT(a, which)
      const v = endRing[k]
      surfacePoint(s, t, a, v)
      v.u = (v.pos.x - 0) / p.texMetres
      v.v = (v.pos.z - 0) / p.texMetres
      if (k < sides) {
        tRim += t
        cr += v.r
      }
    }
    tRim /= sides
    cr /= sides

    // A hollow cannot bore further than there is piece to bore. Past that the
    // centre comes out of the far end and the fan turns inside out -- and on a
    // snag it would take the top face below y = 0, where the bedding contract
    // (min y is exactly 0, gated in check-deadwood.mjs) stops being true. 0.8
    // leaves a floor in the hollow at any setting, which is also what stops it
    // reading as a hole punched clean through.
    const depth = Math.min(cup * cr, s.L * 0.8)

    // THE APEX IS A POINT ON THE SPINE, at the depth the bore reaches. Not a
    // point offset from the end along the end's TANGENT, which is what this used
    // to be and is only the same thing on a straight piece. It is a bug and not
    // a subtlety: a 2 m log's spine wanders 10-15 cm over its length, so a funnel
    // bored along the tangent ends up that far OFF the pith and its wall cuts out
    // through the barrel -- a triangle of the inside of the log poking through
    // the outside of it, lit from the wrong side, moving as you walk round.
    // Aiming at the ring section's centre cannot do that, every point of the wall
    // being a chord of a section the barrel also passes through.
    //
    // Measured from the MEAN RIM rather than from t = 0 or 1, or `jag` and `cup`
    // fight and a rim eaten 40% down the piece gets a bore measured from where
    // the piece would have ended if it had not broken. `t` is arc length to
    // within a percent, so depth / L is the parameter step.
    const tStar = Math.min(1, Math.max(0, which ? tRim - depth / s.L : tRim + depth / s.L))
    s.spineAt(tStar, capCentre.pos)
    capCentre.nor.set(0, which ? 1 : -1, 0)
    capCentre.u = capCentre.pos.x / p.texMetres
    capCentre.v = capCentre.pos.z / p.texMetres

    for (let k = 0; k < sides; k++) {
      const v0 = endRing[k]
      const v1 = endRing[k + 1]
      // The layer is asked at the face's own mid-angle, on the rim, so a cap
      // whose piece is half stripped is half stripped the same way round.
      const am = ((k + 0.5) / sides) * TAU
      const layer = faceLayer(s.endT(am, which), am)
      // Winding flips between the two ends: the far cap faces +Y, the butt -Y.
      //
      // IT USED TO BE THE OTHER WAY ROUND and both caps were inside out -- every
      // snag's top reported as "the top face is just black". NOT by being culled
      // and not by being backlit: the prop material is DoubleSide and applies
      // `normal *= faceDirection` a second time over three's own, and twice is
      // the identity, so lighting there is winding-independent. What it is not
      // independent of is a FLAT-emitted face's authored normal, which emitTri
      // derives from the vertex ORDER. The stored normal measured (0, -1, 0) on
      // the top of every snag: a face lit by a normal aimed at the ground.
      //
      // The lesson generalises the other way round from how it looks: a winding
      // error is invisible ANYWHERE the normals are authored independently -- a
      // smooth barrel, a radial limb cone, a leaf card given the canopy shell's
      // normal -- and visible ONLY where a face's normal comes from its own
      // winding. Flat shading is what couples them. It survived the winding gate
      // because that gate was a tautology on exactly these faces; §21 has it, and
      // check-deadwood.mjs now also asks a snag's caps which way they point in
      // the WORLD. A funnel needs no second case -- the face normal swings
      // continuously as the bore deepens and its Y never reaches zero.
      if (which) emitTri(out, v1, v0, capCentre, layer, 0)
      else emitTri(out, v0, v1, capCentre, layer, 0)
    }
  }

  buildCap(1)
  buildCap(0)

  // WHERE THE TRUNK ENDS AND THE STUBS BEGIN, in floats of `out.pos`. Everything
  // emitted from here on is a branch stub, and the bedding at the bottom of this
  // function needs to tell the two apart -- see `drop` for why. It is a plain
  // watermark rather than a flag on each vertex because the stub loop is the last
  // thing that emits: one number says it.
  const trunkFloats = out.pos.length

  // --- branch stubs ---------------------------------------------------------
  //
  // Not growLimb and not a branch: a stub is a broken-off base, so it is a short
  // straight prism with a torn end and no curve at all. The one thing worth
  // copying from tree.js is where it STARTS -- 0.6 of the local radius INSIDE the
  // drawn surface, so the stub is seated in the wood rather than balanced on its
  // skin. A stub that starts on the surface hovers beside the trunk the moment
  // anything bends.
  const nStubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const stubRand = s.rand
  const stubAxis = new THREE.Vector3()
  const stubE1 = new THREE.Vector3()
  const stubE2 = new THREE.Vector3()
  const stubRing = Array.from({ length: stubSides + 1 }, vert)
  // Named for the break rather than for the end, because `p.stubEnd` is a
  // different thing entirely -- the top of the band a stub may grow from.
  const stubCrown = Array.from({ length: stubSides + 1 }, vert)
  const stubTip = vert()

  // The band a stub may emit from. `stubEnd` is a ceiling and not just a scale,
  // so the jitter is clamped back inside it rather than allowed to overshoot --
  // the whole point of the ceiling is that nothing sits above the deepest notch
  // `jag1` can cut, and one jittered outlier is exactly the stub that hangs in
  // the air. Ordered defensively because a bench can be left with end below
  // start, and a negative span would mirror the stubs below the butt.
  const stubLo = Math.min(p.stubStart, p.stubEnd)
  const stubHi = Math.max(p.stubStart, p.stubEnd)

  // WHERE THE RING STARTS, drawn ONCE for the whole piece. The spacing below is
  // regular and this is the only thing that turns it, so no two trunks put their
  // stubs at the same compass points and every trunk still spreads its own.
  const stubPhase = stubRand() * TAU

  for (let i = 0; i < nStubs; i++) {
    const t = stubLo + (stubHi - stubLo) * ((i + 0.5) / Math.max(1, nStubs) + (stubRand() - 0.5) * 0.2)
    let tc = Math.min(Math.min(0.97, stubHi), Math.max(Math.max(0.03, stubLo), t))
    // SPREAD ROUND THE TRUNK BY THE GOLDEN ANGLE, jittered. The angle has to be
    // the whole of the spacing: a per-stub uniform draw added to it, which is
    // what this used to be, swamps it completely and leaves the azimuths
    // independent -- and four independent draws put every stub in one quadrant
    // about one time in sixteen, which is often enough to be the thing you
    // notice. A tree does not do that. So the phase is drawn once per piece
    // (above), 137.5 degrees separates each stub from the last, and the jitter is
    // bounded well inside that gap so it loosens the ring without reordering it.
    const a = stubPhase + i * 2.399963 + (stubRand() - 0.5) * 2 * STUB_AZIMUTH_JITTER

    // AND THEN PULLED UNDER THE RIM AT ITS OWN AZIMUTH, which is the actual fix
    // for stubs hanging in the air. `stubEnd` caps the whole band against the
    // deepest notch `jag1` might cut, but the rim is a function of ANGLE: a stub
    // at 0.64 standing under a notch that bit to 0.60 is still growing out of
    // nothing. `endT` is the same function the end rings ride, so this asks the
    // wood itself where it stops. The margin is the stub's own radius in `t`
    // units, because clearing the rim by a hair still leaves the upper half of
    // the cone outside the trunk.
    const margin = Math.max(0.012, s.radiusAt(tc, a) * p.stubRadius) / s.L
    tc = Math.max(s.endT(a, 0) + margin, tc)
    tc = Math.min(s.endT(a, 1) - margin, tc)

    const r = s.radiusAt(tc, a)
    const c = Math.cos(a)
    const sn = Math.sin(a)
    s.spineAt(tc, _p)
    const base = new THREE.Vector3(_p.x + r * c * 0.6, _p.y, _p.z + r * sn * 0.6)

    // Dead stubs droop. `stubRise` is measured from horizontal and defaults low
    // for that reason -- a stub angled up like a live branch reads as a tree
    // that is still trying.
    const rise = p.stubRise * (0.5 + stubRand())
    stubAxis.set(c * Math.cos(rise), Math.sin(rise), sn * Math.cos(rise)).normalize()
    stubE1.set(-sn, 0, c).normalize()
    stubE2.crossVectors(stubAxis, stubE1).normalize()

    const rad = Math.max(0.012, r * p.stubRadius)
    const len = rad * 2 * p.stubLength * (0.7 + stubRand() * 0.6)
    const layer = s.barkAt(tc, a) >= 0.5 ? p.barkLayer : p.woodLayer

    // The torn end gets a stream of its own, seeded here and SPENT ONLY AT T0.
    // The seed is drawn at every tier regardless, because `stubRand` is one
    // stream walked across all the stubs in order: a tier that took a different
    // number of draws would shift every stub after this one, and the tiers would
    // stop being the same solid at different sampling rates. check-deadwood
    // measures exactly that, tier against tier, on all three axes.
    const tipRand = mulberry32((stubRand() * 0xffffffff) >>> 0)

    // T1 DRAWS THE STUB AS ONE VERTICAL TRIANGLE. Not a thinner cone and not a
    // cross: a single card standing in the plane that holds both the stub's own
    // axis and world up, which is the plane a drooping stub is already leaning in
    // and the one whose silhouette IS the stub -- rotate the card 90 degrees
    // about the axis and the same three vertices project to a line. Its normal is
    // the plane's own (horizontal, across the stub) rather than a radial fan: a
    // card has one normal by construction, and this is the only choice that is
    // not a lie about some part of it.
    if (tier.stubFlat) {
      // The in-plane perpendicular: up, with the axial part taken out. A stub
      // pointing straight up has no such direction, so fall back to the ring
      // frame -- which is the correct answer there, since any plane through a
      // vertical axis is as vertical as any other.
      let wx = -stubAxis.x * stubAxis.y
      let wy = 1 - stubAxis.y * stubAxis.y
      let wz = -stubAxis.z * stubAxis.y
      let wl = Math.hypot(wx, wy, wz)
      if (wl < 1e-6) {
        wx = stubE1.x
        wy = stubE1.y
        wz = stubE1.z
        wl = 1
      }
      wx /= wl
      wy /= wl
      wz /= wl
      const nxs = stubAxis.y * wz - stubAxis.z * wy
      const nys = stubAxis.z * wx - stubAxis.x * wz
      const nzs = stubAxis.x * wy - stubAxis.y * wx
      const uRep = Math.max(1, Math.round((TAU * rad) / p.texMetres))
      for (let k = 0; k < 2; k++) {
        const sgn = k === 0 ? 1 : -1
        const v = stubRing[k]
        v.pos.set(base.x + wx * rad * sgn, base.y + wy * rad * sgn, base.z + wz * rad * sgn)
        v.nor.set(nxs, nys, nzs)
        v.u = k * uRep
        v.v = 0
      }
      stubTip.pos.copy(base).addScaledVector(stubAxis, len)
      stubTip.nor.set(nxs, nys, nzs)
      stubTip.u = uRep * 0.5
      stubTip.v = len / p.texMetres
      // Flat, whatever `smooth` says: a one-triangle card has nothing to blend
      // toward and the authored normal above is already the answer.
      emitTri(out, stubRing[0], stubRing[1], stubTip, layer, 0)
      continue
    }

    // T0: A SHORT PRISM WITH A BROKEN END. `stubSides` quads up the barrel and a
    // fan of the same count closing the tip -- 3 x stubSides triangles, which
    // deadwoodCost repeats and check-deadwood holds it to.
    //
    // The tip ring is rolled BEFORE the sides are emitted, because a jagged rim
    // is a property of the whole stub: the quads have to reach the wandering
    // ring, not a flat one with a jag stuck on afterwards.
    const stubURep = Math.max(1, Math.round((TAU * rad) / p.texMetres))
    const tipRad = rad * STUB_TIP_TAPER
    // The surface normal of the TAPER, not of a cylinder. The barrel leans in by
    // (rad - tipRad) over `len`, and shading it as though it did not is what
    // leaves a five-sided stub looking like five flat cards: the vertex normals
    // have to be the ones the real surface has before smoothing them is worth
    // anything. Same normal top and bottom, because the taper is linear.
    const tipSlope = (rad - tipRad) / Math.max(1e-6, len)
    const tipNorm = 1 / Math.hypot(1, tipSlope)
    let tipLo = Infinity
    let tipHi = -Infinity
    for (let k = 0; k <= stubSides; k++) {
      const ang = (k / stubSides) * TAU
      const ox = stubE1.x * Math.cos(ang) + stubE2.x * Math.sin(ang)
      const oy = stubE1.y * Math.cos(ang) + stubE2.y * Math.sin(ang)
      const oz = stubE1.z * Math.cos(ang) + stubE2.z * Math.sin(ang)
      const uk = (k / stubSides) * stubURep

      const nx = (ox + stubAxis.x * tipSlope) * tipNorm
      const ny = (oy + stubAxis.y * tipSlope) * tipNorm
      const nz = (oz + stubAxis.z * tipSlope) * tipNorm

      const ring = stubRing[k]
      ring.pos.set(base.x + ox * rad, base.y + oy * rad, base.z + oz * rad)
      ring.nor.set(nx, ny, nz)
      ring.u = uk
      ring.v = 0

      // The wrap vertex is the seam and must be the SAME point as k = 0, so it
      // takes that vertex's roll rather than its own. Rolling it again opens a
      // gap along one facet of every stub in the world -- silent, because the
      // geometry is non-indexed and nothing checks that the seam closes.
      const jag = k === stubSides
        ? stubCrown[0].v * p.texMetres - len
        : (tipRand() - 0.5) * 2 * STUB_TIP_JAG * len
      const crown = stubCrown[k]
      const reach = len + jag
      crown.pos.set(
        base.x + stubAxis.x * reach + ox * tipRad,
        base.y + stubAxis.y * reach + oy * tipRad,
        base.z + stubAxis.z * reach + oz * tipRad,
      )
      crown.nor.set(nx, ny, nz)
      crown.u = uk
      crown.v = reach / p.texMetres
      if (k < stubSides) {
        if (reach < tipLo) tipLo = reach
        if (reach > tipHi) tipHi = reach
      }
    }

    // The barrel: one quad per side, split on the diagonal that runs from the
    // base to the FURTHER of the two tip vertices, so neither triangle of a quad
    // spanning a deep notch collapses.
    // SMOOTH, at `smooth`'s full strength, and the taper normals above are what
    // make that legal. Five sides is few enough that flat shading draws every
    // arris as a hard line, and a stub is a twig, not a barn -- the eye reads
    // five hard lines round a 6 cm cylinder as faceting rather than as form. The
    // trunk it grows out of is shaded the same way for the same reason.
    for (let k = 0; k < stubSides; k++) {
      emitTri(out, stubRing[k], stubRing[k + 1], stubCrown[k + 1], layer, smooth)
      emitTri(out, stubRing[k], stubCrown[k + 1], stubCrown[k], layer, smooth)
    }

    // The break. A deep socket or a modest splinter, never level with the rim --
    // see STUB_TIP_SOCKET for the argument, and note that the two are measured
    // from opposite ends of the rim's own range.
    const outie = tipRand() < 0.5
    const span = outie ? STUB_TIP_SPLINTER : STUB_TIP_SOCKET
    const clear = (span[0] + tipRand() * (span[1] - span[0])) * len
    const point = outie ? tipHi + clear : tipLo - clear
    stubTip.pos.copy(base).addScaledVector(stubAxis, point)
    stubTip.nor.copy(stubAxis)
    stubTip.v = point / p.texMetres
    for (let k = 0; k < stubSides; k++) {
      stubTip.u = ((k + 0.5) / stubSides) * stubURep
      // Wound out, and ONE winding does the whole fan because the point clears
      // the rim's entire range: a sunk point turns the cap inside out, and a
      // socket that faces the wrong way is culled into a black hole in the side
      // of the branch. Smoothed with the rest of it -- the crown vertices carry
      // the barrel's normals, so the break shades continuously out of the wood
      // behind it rather than ringing the tip with a crease.
      if (outie) emitTri(out, stubCrown[k], stubCrown[k + 1], stubTip, layer, smooth)
      else emitTri(out, stubCrown[k + 1], stubCrown[k], stubTip, layer, smooth)
    }
  }

  // --- placement, and the ground -------------------------------------------
  //
  // Everything above is in the local frame with the spine running up +Y. A snag
  // stays there; a log is rolled about its own axis, then tipped over onto +Z
  // with `pitch` left as the angle one end is propped up by.
  //
  // Then the piece is dropped by `sink` and everything below y = 0 is clamped UP
  // onto the plane. See note 4 in the header for why clamping rather than
  // trimming, and what it costs.
  const positions = new Float32Array(out.pos)
  const normals = new Float32Array(out.nor)

  const m = new THREE.Matrix4()
  if (p.kind === 'log') {
    m.makeRotationX(Math.PI / 2 - p.pitch)
    m.multiply(new THREE.Matrix4().makeRotationY(p.roll))
  }
  const nm = new THREE.Matrix3().setFromMatrix4(m)
  const v3 = new THREE.Vector3()
  if (p.kind === 'log') {
    for (let i = 0; i < positions.length; i += 3) {
      v3.fromArray(positions, i).applyMatrix4(m).toArray(positions, i)
      v3.fromArray(normals, i).applyMatrix3(nm).normalize().toArray(normals, i)
    }
  }

  // THE TRUNK IS WHAT RESTS ON THE GROUND, AND THE STUBS ARE ALLOWED THROUGH IT.
  //
  // This min used to run over every vertex, which made a drooping stub the lowest
  // point on the mesh and so the thing that decided where the whole piece sat:
  // the log was lifted until the STUB touched the ground, and rested on two
  // spikes with daylight along its whole belly. On a log with four to six stubs
  // round a 3 m barrel that is the usual outcome rather than an edge case, and it
  // is the one artefact that says "placed" rather than "fell".
  //
  // So the min and the clamp are over the TRUNK only, and a stub that ends up
  // under y = 0 simply passes into the soil, which is what a branch under a
  // fallen trunk does. It costs the triangles of the buried part, and that is the
  // right trade: trimming stubs against the plane would make a stub's length
  // depend on how the piece was bedded, and a tier's stub card would no longer
  // match its cone. The origin itself does not move here -- what changed is WHICH
  // vertices get a vote on the Y translation.
  let minY = Infinity
  for (let i = 1; i < trunkFloats; i += 3) if (positions[i] < minY) minY = positions[i]

  // A LOG LIES IN THE GROUND, NOT ON A TANGENT TO IT.
  //
  // `sink` alone drops the piece until its single lowest vertex is a fraction of
  // a radius under the plane, and on a snag that is the whole answer, because a
  // snag's underside is one flat butt. A log's is a 2-8 m line following a spine
  // that bends and kinks, so sinking the lowest point buries that point and
  // leaves everything either side of it in the air: a 3 m log at the default bend
  // and kink floats its ends by about 10 cm, and a gap under a fallen log is the
  // artefact that says "placed" rather than "fell".
  //
  // So a log ALSO sinks by the full vertical wander of its own spine, which is
  // exactly what puts every point of the underside at or below the plane and lets
  // the clamp flatten the lot into one continuous belly ribbon. Measured on the
  // SPINE rather than the vertices, which carry the barrel's radius -- that is
  // not wander and would bury the log by its own thickness. A BUTT DIAMETER caps
  // it, and the cap is what keeps `pitch` usable.
  //
  // The spine is walked once for both of the numbers below, in the piece's FINAL
  // attitude, at a fixed 32 steps rather than the ring count: every tier has to
  // bed at the same depth and stand at the same place, or the LOD switch nudges
  // the log.
  let spineLoY = Infinity
  let spineHiY = -Infinity
  let spineLoX = Infinity
  let spineHiX = -Infinity
  let spineLoZ = Infinity
  let spineHiZ = -Infinity
  for (let i = 0; i <= 32; i++) {
    s.spineAt(i / 32, v3)
    v3.applyMatrix4(m)
    if (v3.y < spineLoY) spineLoY = v3.y
    if (v3.y > spineHiY) spineHiY = v3.y
    if (v3.x < spineLoX) spineLoX = v3.x
    if (v3.x > spineHiX) spineHiX = v3.x
    if (v3.z < spineLoZ) spineLoZ = v3.z
    if (v3.z > spineHiZ) spineHiZ = v3.z
  }

  const bed = p.kind === 'log' ? Math.min(spineHiY - spineLoY, s.r0 * 2) : 0
  const drop = minY + p.sink * s.r0 + bed

  // THE ORIGIN IS THE MIDDLE OF THE FOOTPRINT, not the butt.
  //
  // Everything above builds from the butt outward because that is where the spine
  // starts -- fine for a snag, whose butt IS the middle, and useless for a log: a
  // 3 m log built that way hangs three metres off its own origin, so a scatter
  // that places it at a point puts it anywhere but there, its bounding sphere is
  // twice the radius it needs, and -- the one that shows -- the billboard card,
  // centred on the origin by construction, stands a metre and a half from the
  // mesh it replaces. That is a prop that jumps sideways at the LOD switch.
  //
  // Centred on the SPINE's own range rather than the vertex bounding box, because
  // the box is a property of the tier -- an 8-gon and a 5-gon catch different
  // lobes -- and a centre that moved between tiers would put the nudge back in a
  // smaller form. The spine is the same curve at every tier.
  const midX = (spineLoX + spineHiX) * 0.5
  const midZ = (spineLoZ + spineHiZ) * 0.5

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= midX
    const y = positions[i + 1] - drop
    // Clamped on the trunk, free on the stubs. Both are dropped by the same
    // `drop`, so the piece is one rigid object; only the flattening of what went
    // under the plane is the trunk's alone. See minY above.
    positions[i + 1] = i < trunkFloats && y < 0 ? 0 : y
    positions[i + 2] -= midZ
  }

  // --- measure what was actually built --------------------------------------
  let minX = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 1] > maxY) maxY = positions[i + 1]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }

  // How much of the surface still has bark on it, sampled on a grid that has
  // nothing to do with the tier's own vertices -- the same reasoning as rock.js
  // measuring its box on a reference set no tier uses. It is reported because
  // `bark` is a slider whose number and whose result are only approximately the
  // same thing, and the bench should show the result.
  let covered = 0
  const SAMPLES = 24
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      if (s.barkAt((i + 0.5) / SAMPLES, ((j + 0.5) / SAMPLES) * TAU) >= 0.5) covered++
    }
  }

  const count = out.tris * 3
  const index = new Uint16Array(count)
  for (let i = 0; i < count; i++) index[i] = i

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uv, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.lay, 1))
  // Identity index, exactly as rock.js: the geometry is non-indexed by
  // construction because every face picks its own layer, but BatchedMesh only
  // accepts indexed geometry.
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()

  geo.userData.deadwood = {
    kind: p.kind,
    tier: tier.name,
    triangles: out.tris,
    vertices: count,
    sides,
    rings,
    stubs: nStubs,
    // Vertices 0..trunkVertices are the barrel and its two end faces; everything
    // after them is a branch stub. Published because the bedding rule is stated
    // in terms of that split -- the trunk rests on y = 0 and a stub may pass
    // below it -- and a check of that rule has to be able to see the same line.
    trunkVertices: trunkFloats / 3,
    // Split out so the bench can say where the budget went. The barrel is the
    // only part that scales with `rings`; the caps are fixed at 2 x sides and a
    // T0 stub costs 3 x stubSides -- two triangles a side up the prism and a fan
    // of one more per side closing the broken tip.
    barrelTris: sides * rings * 2,
    capTris: sides * 2,
    stubTris: nStubs * (tier.stubFlat ? 1 : stubSides * 3),
    barkFraction: covered / (SAMPLES * SAMPLES),
    uRepeat,
    texMetres: p.texMetres,
    barkLayer: p.barkLayer,
    woodLayer: p.woodLayer,
    measured: {
      width: maxX - minX,
      height: maxY,
      depth: maxZ - minZ,
      // The spine's own length, which is what `length` asked for -- the box
      // above is what the bend, the flare and the lie-down made of it.
      span: s.L,
      // THE WIDEST THE BASE ACTUALLY GETS, not the nominal `butt` -- the
      // difference is the flare, which since `roots` is a crown of buttresses
      // reaching nearly twice the trunk's own radius rather than a collar a third
      // wider than it.
      //
      // It matters because of who reads it. render/deadwood.js seats a piece by
      // this number, sampling the ground at this radius round the butt and
      // sinking by `tan * radius` on a slope, so a value that understates the
      // footprint leaves the downhill fin hanging in the air. Sampled rather than
      // solved because radiusAt carries ovality, lobes, checks and the bark step
      // as well as the flare and there is no closed form for the maximum of the
      // sum: 48 calls once per built geometry.
      buttDiameter: (() => {
        let r = 0
        const n = DEADWOOD_TIERS[0].sides * 4
        for (let k = 0; k < n; k++) r = Math.max(r, s.radiusAt(0, (k / n) * TAU))
        return r * 2
      })(),
    },
  }
  return geo
}

/** A standing broken-off snag. */
export function buildSnag(options = {}) {
  return buildDeadwood({ ...options, kind: 'snag' })
}

/** A fallen log, lying on and pressed into the ground. */
export function buildLog(options = {}) {
  return buildDeadwood({ ...options, kind: 'log' })
}

/**
 * What a given parameter set will cost, without building it.
 *
 * Pure arithmetic over the tier table, the way resolveTree is for trees. The
 * bench uses it to fill the ladder rows for tiers it is not currently drawing,
 * which is the whole point -- a ladder you have to build three extra meshes to
 * read is a ladder nobody reads.
 */
export function deadwoodCost(options = {}, tierIndex = 0) {
  const p = { ...DEADWOOD_DEFAULTS, ...options }
  const tier = DEADWOOD_TIERS[Math.min(DEADWOOD_TIERS.length - 1, Math.max(0, Math.round(tierIndex)))]
  const sides = tier.sides
  const rings = Math.max(1, Math.round(Math.max(1, p.rings) * tier.ringMul))
  const stubs = Math.round(p.stubs * tier.stubMul)
  const stubSides = Math.max(3, Math.round(p.stubSides))
  const barrel = sides * rings * 2
  const caps = sides * 2
  const stubTris = stubs * (tier.stubFlat ? 1 : stubSides * 3)
  return { tier: tier.name, sides, rings, stubs, barrel, caps, stubTris, triangles: barrel + caps + stubTris }
}
