// ---------------------------------------------------------------------------
// THE WILDLIFE: the moor stag, the red fox and the snow hare, wandering the
// open ground. One of each per 3000 square metres, out to a RADIUS set by the
// furthest any of them is drawn from.
//
// PLACEMENT IS A PURE FUNCTION OF POSITION, the same contract the frogs keep:
// each TILE-metre tile rolls its animals from its own seed (critters.js
// tileSeed), so the same hollow holds the same stag every visit and nothing is
// stored between visits. A candidate stands only on ground that is gentle, dry
// and below the cold -- the seat test reads the HEIGHT FIELD and the water,
// both pure functions of position, and never walk.js: the walk surface is
// lifted onto the stones and holed by the trunks only where those are
// resident, which is a different set on every client, and a plan sampled
// against it would put the same stag on two paths in one room. So a planned
// walk can clip a trunk or climb a boulder's side; the frame's ground probe
// (walk.js again) at least seats its feet on what is really there. It wanders
// on a TETHER_M leash, because an animal that truly roamed would walk out of
// its tile and be deleted as scenery the moment the tile unloaded.
//
// WHAT IT DOES IS A SCORE (sim/score.js, _notes/creature-sync.md). Every
// animal is keyed by its tile's seed and its index in the roll, and its life
// is chapters of phrases planned from hash(key, chapter): a stand, a graze, a
// rest, a dig, or a roam, each with a closed-form length and end pose, the
// roam's walk sampled against the seat test at plan time so it never walks
// into the water, up a crag or through a trunk, and the chapter's last phrase
// ending at home. Inside a phrase the body is stepped at TICK_HZ on absolute
// ticks of the room's world clock and the frame interpolates the last two
// ticks, so every client in a room plays the same stag the same way at the
// same moment, a client arriving mid-chapter places it at the phrase's start
// pose and replays the ticks since, and an animal asleep past its card range
// is simply not stepped: waking it is the same placement.
//
// A DRAGON'S STRIKE IS IN THE SCORE. The dragons (render/dragons.js) plan
// their hunts against the stags' FREE plans -- the chapter as the paragraph
// above has it, read through roster(), spawnAt() and poseAt(), for a stag
// woken or not, resident or not (the tile rolled on demand, _tileOf) -- and
// answer `hunter(key, t0, t1)`: the world time a stoop on that stag ends
// within the window, or null. A stag's chapter is its free plan cut at that
// moment, the phrase it is in shortened to end where the body is, and a `dead`
// phrase from there to the chapter's end. Entering it the animal is put to
// sleep with `deadUntil` on its spawn, so nothing wakes it and no lure moves
// it, and the dragon's kill(key) takes it as cargo: the live slot if there is
// one, otherwise a slot dressed from the spawn. The chapter's turn is a new
// stag at home. The dragons' plan never asks the cut plan, so nothing recurses.
//
// BEHAVIOUR IS THE CLIP LIBRARY, SPELT OUT. A phrase is a queue of (clip,
// seconds) steps rather than a state machine, because that is what the
// library actually is: a graze is eat-down, then a run of eat-loop chews, then
// eat-up, three clips authored to chain key-for-key. A rest plays `sit` or
// `lie` ONCE -- each is a whole round trip, down, hold and up, so looping one
// would be an animal bobbing up and down on the spot. A roam plays a gait, and
// the ground under it then moves at exactly the speed the clip's stride was
// built for (the shipper's `gait` extras), so the feet do not skate: that is
// why each species has its own gait weights, a fox's walk being a slow enough
// clip that a fox which mostly walked would look becalmed. A hare never walks
// or trots: its two gaits are the half-bound -- both hinds pushing off
// together, both fores catching -- at a saunter (`hop`) and flat out (`bound`),
// which are two clips and not one played at two rates because a hop is
// ballistic and a slowed clip floats.
//
// SHE IS FURNITURE, UNLESS SHE HOLDS A LURE. An animal takes no notice of her
// at any distance -- it grazes with her standing over it -- until a thing in
// a hand (hands.js lures, hers or a peer's) is one its species wants (LURES: a
// carrot for a stag or a hare, a fish or a crab for a fox) and within LURE_M
// of it. Then it is LIVE, off its score: it looks up (`notice`) and courts the
// lure -- `follow`s it, re-aimed every tick and its gait picked by how far
// behind it is, off its tether and detouring round blocked ground, stops
// STANDOFF_M short and there does what its species does (`court`: a stag looks
// at her or begs, a fox looks, a hare frolics about her feet), sets off again
// once she is RESUME_M further, and with the lure held to its face `beg`s --
// the graze clips at the thing, over and over, and nothing is ever eaten. The
// lurer's client is the authority and publishes an anchor every ANCHOR_S; a
// peer's client runs the same rule on the relayed hand and is nudged onto each
// anchor over CORRECT_S. It forgets the lure past LURE_FORGET_M or the moment
// the hand is empty, and then REJOINS the score: a walk to the start pose of
// the next planned phrase it can reach, and a stand until that phrase begins,
// a closed-form chain every client derives from the one rejoin anchor.
//
// IT TURNS, IT DOES NOT SNAP. `heading` is where a body faces and `aim` is
// where it wants to face; the gap closes at TURN_RATE and never faster, so
// every turn is one you can watch -- a quick one, an about-face in under half a
// second, since a hare wheels where it stands. A planned walk pivots to its aim and then
// goes, which is what makes its length closed-form in ticks; a live follower
// makes ground only in the direction it is actually facing, so a beast
// mid-turn slows and one turning back on itself pivots on the spot.
//
// NIGHT PUTS THEM DOWN. The plan reads the world's day scalar at each phrase's
// own moment (clock.js daynessAt, a pure function of the room's time) and it
// weights the roll: at full dark a rest is twice as likely to be the next
// thing an animal does as it is at noon.
//
// A SPAWN IS NOT AN ANIMAL. A tile's roll gives SPAWNS -- where a body stands
// when nothing has moved it, and what size it is -- and a spawn is woken into
// a live animal (a slot, placed on its score) only inside its card range, the
// outermost rung of the ladder. Past that it is not drawn AND NOT SIMULATED:
// nothing walks, turns, probes the ground or picks anything, and the slot goes
// back to the pool once she is past its forget range. The score knows where it
// is, so the work is proportional to the animals she can actually see and not
// to the tiles that happen to be loaded, and an animal she turns her back on
// is exactly where the plan says when she looks again.
//
// DRAWN AS A PUPPET, THEN AS A CARD. A woken animal near enough for a mesh is
// its own skeleton (a clone of the shipped one) with a mixer on it, drawn as
// whichever of the file's four skinned tiers the ladder's rungs call for
// (critters.js critterTier). Under those four is one more rung, twice as far,
// where it is one spun quad in its species' InstancedMesh instead: at 100 m a
// stag is a dozen pixels tall and a photograph of it is the mesh, and what the
// rung buys is that she sees the herd she is walking toward rather than watching
// it appear. The card still walks, turns, grazes and goes home -- it is the same
// animal, drawn cheaper -- it simply has no skeleton and no mixer, so a distant
// herd costs a slot and four vertices each and nothing else.
//
// NOTHING POPS, at any of those edges. Every step of the ladder is a dissolve
// (render/puppet.js), and so is the handover between the last mesh rung and the
// card: the two read the same pixel hash and keep opposite halves of it, the
// mesh through the puppet's uCut and the card through its `aCardFade`
// attribute, driven from the same ramp on the same frame. A TILE UNLOAD is a
// dissolve too, so an animal whose tile goes while it is still in sight leaves
// its puppet behind to fade where it stood (`fading`); a card's tile cannot go
// while it is drawn, because RADIUS is set past the furthest card range. The
// exception is `place()`, the terrain rebuild, where the ground an animal was
// standing on no longer exists and there is nothing to fade on.
//
// THE PRICE is a draw call and a skeleton for each animal in MESH range -- a
// dozen in the live world, twenty at the pool's cap, doubled per eye in XR while
// the skeletons are not -- plus one instanced draw call a species for every card
// behind them. Each of those draws is a bone texture re-uploaded, so the mesh
// range and not the herd is what the layer costs; the settled ones at least
// share one material a species, which is why no animal wears a colour of its
// own (puppet.js makePuppetMaterials). design/27-creature-pipeline.md has the
// numbers.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { clamp, lerp, mulberry32 } from '../../sim/mathx.js'
import {
  CATCH_UP_TICKS, TICK_HZ, TICK_S, Score, chapterOf, hash32, keyHash, phraseRand, stepTo, swing, tickAfter, tickOf,
} from '../../sim/score.js'
import {
  CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, SPUN_VIEWS, bakeCritterCard, createCritterCardMaterial, critterTier,
  cullRange, forgetRange, makeCardFadeAttribute, setCritterCard, spunBounds, tileKey, tileSeed, walkTiles,
} from './critters.js'
import { LOD_FADE_S, Puppet, groundFeet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const TILE = 32
// The tallest body the placement is sized to hold, in metres. Nothing here is
// near it -- a stag's largest extent is under three -- but a spawn that is not
// placed is an animal that pops in when the tile arrives rather than when the
// ladder says so, and the headroom is what lets a bigger creature join this
// layer without the radius being the thing that quietly clips it.
export const CARD_BODY_M = 4
// Tiles whose centre is within this of her are grown, so the furthest a spawn
// can be is this plus half a tile's diagonal. Set past the card range of the
// tallest body the layer holds, so a card is never waiting on its tile.
export const RADIUS = Math.ceil(cullRange(CARD_BODY_M, CARD_RUNGS) + (TILE * Math.SQRT2) / 2)
// Animals per square metre of the commonest species, the hare; each species scales it by its `rate`.
export const DENSITY = 1 / 3000
// Slots a species gets, and puppets. A stag's card range covers 200 m, which at
// its rate is some dozen live stags before the seat test thins them, so the
// slot pool is sized for that crowd clustering hard. Puppets are the scarcer
// thing and are sized for the MESH range alone: a starved animal is not drawn.
export const MAX = 64
export const PUPPETS = 20

// Ground an animal will not stand on: steeper than this, or this close under the snow line.
export const MAX_SLOPE = (35 * Math.PI) / 180
export const SNOW_MARGIN = 10
// How far from where it was placed an animal may wander. A roam is planned to end inside it, and from anywhere inside it the walk home is short.
export const TETHER_M = 24
// Past this much of the tether a roam aims home, within a quarter turn either way.
const HOMING = 0.6

const STAND_S = [3, 12]
const ROAM_S = [4, 14]
const ALERT_S = [2, 6]
const DIG_S = [3, 9]
// Chews of `eat-loop` between the head going down and coming back up.
const GRAZE_LOOPS = [2, 7]
// A roam aims by up to this from where the body faces, so a wander reads as a wander and not as a new random direction every bout.
const TURN = 1.4
// What a rest's weight is multiplied by at full dark. Half the ramp is spent before the sun is down, which is when a real herd starts settling.
export const NIGHT_REST = 2
// Radians a second a body may swing: an about-face in 0.4 s, fast enough that a hare's dodging reads as wheeling on the spot, slow enough that the pose interpolation between ticks still draws the turn.
export const TURN_RATE = 8
// Body lengths ahead a live follower tests the next seat at.
const AHEAD = 1.5
// A planned walk is sampled against the seat test every this many metres along it, and clipped this short of the first sample that fails; the straight line home from where it ends is sampled the same way, so the chapter's way home is on ground it can walk. A metre, because a trunk is under two across and the samples must not straddle one.
export const SAMPLE_M = 1
// A roam whose walk would be shorter than this many ticks is a stand instead.
const MIN_WALK_TICKS = 20
// Seconds the chapter's way home is planned with to spare, and a rejoin's walk: the stand that follows either is at least this less a tick, which is more than an about-face takes.
const HOME_PAD_S = 3
const REJOIN_PAD_S = 3
// Frames between an animal's GROUND WORK -- the height under its feet and the
// normal it stands on -- by the rung it is drawn at, staggered across the
// animals by slot id so a herd never probes on one frame. Every one of those
// is a walk over every stone layer in the world (walk.js heightAt), which is
// the dominant per-animal cost and the only one worth bucketing: the mixer is
// 3 microseconds and the walk is what is left.
//
// BETWEEN PROBES IT WALKS THE TANGENT PLANE the last probe measured, rather than
// holding the height it had -- exact on a flat face, a centimetre out on a
// rolling one, and it is what makes a longer stride cost nothing visible. A
// creature on the card rung probes once every thirty-two frames and is a dozen
// pixels tall while it does.
export const PROBE_EVERY = [6, 8, 12, 16, 32]
// On the card rung an animal is stepped only every CARD_EVERY frames, the
// ticks between run then, and its card is pushed as it last was on the others:
// at a dozen pixels a stride four frames long is under a pixel. The card rung's
// probe cadence is a multiple, so the probe lands on a stepped frame.
export const CARD_EVERY = 4
// Ticks between a live follower's look-ahead seat tests.
const LIVE_PROBE_TICKS = 4
// Her head must move this far before the tiles are walked again: a tile enters or leaves only when she does, and the walk is a few hundred keys.
const WALK_M = 4
// Seconds one clip takes to give way to the next. Nothing to do with the LOD dissolve, which is render/puppet.js's LOD_FADE_S.
const FADE_S = 0.25

// LURES. An animal notices a thing in a hand its species wants within LURE_M of it and forgets it past LURE_FORGET_M.
export const LURE_M = 3
export const LURE_FORGET_M = 30
// Following, it stops STANDOFF_M (SPECIES.standoff) from the lure and sets off again past that plus RESUME_M; a follow step is re-picked every FOLLOW_STEP_S and re-aimed every tick, except for DETOUR_S after the ground ahead blocked it.
export const RESUME_M = 0.8
export const FOLLOW_STEP_S = 1
const DETOUR_S = 1
// A lure within FACE_M body lengths of the nose, and no more than FACE_DY body lengths above or below the feet, is begged at: a stag reaches a carrot held at her waist, a hare one held at her shins.
export const FACE_M = 0.7
export const FACE_DY = 0.8
// At its standoff an animal holds a look at her for GAZE_S, or a hare bounds FROLIC_S across the lure, a quarter turn off its bearing.
const GAZE_S = [1.5, 4]
const FROLIC_S = [0.4, 0.8]
const FROLIC_SWING = 1.2
// The authority publishes a live animal's anchor every ANCHOR_S; a peer's anchor older than ANCHOR_STALE_S with no hand in sight ends the lure here; a peer's animal is nudged onto each anchor over CORRECT_S.
export const ANCHOR_S = 1
// Tiles rolled for the dragons past the resident set, and the stags' free plans kept for them.
const ROLLED_TILES = 1024
const FREE_PLANS = 256
export const ANCHOR_STALE_S = 3
export const CORRECT_S = 1
const NO_LURES = []

// Every clip the shipped file must carry. One-shots play once and hold their last frame; the rest cycle.
export const CLIPS = ['idle', 'alert', 'walk', 'trot', 'run', 'hop', 'bound', 'sit', 'lie', 'dig', 'eat-down', 'eat-loop', 'eat-up', 'dead']
export const ONE_SHOT = new Set(['eat-down', 'eat-up', 'sit', 'lie', 'dead'])
// A seized body is drawn about the point the talons hold -- the top of its
// back, this fraction of its STANDING height up, which is where the `dead`
// pose's sagging spine tops out (the stag's back, hips tilted down and neck
// hanging, measures 0.50 of the idle height) -- and a body laid on the nest is
// rolled onto its flank and lifted this fraction of its width so the flank and
// not the spine rests on the floor.
export const GRIP = 0.5
export const LAIN = 0.35
// The clips whose four feet stay put, so a standing body's feet are put on the
// ground under each (puppet.js FootIK). Measured off the shipped clips: a dig
// lifts a forefoot, a sit and a lie fold the legs, and no gait is planted.
export const PLANTED = new Set(['idle', 'alert', 'eat-down', 'eat-loop', 'eat-up'])

/**
 * The three of them. `acts` and `gaits` are (name, weight) pairs rolled when an
 * animal needs something new to do, the first gait its pace home; `rate` is
 * the species' share of DENSITY; the size of a body is its length, the shipped
 * figure times `scale` times a roll of `vary` either way, and no two animals
 * are the same size. None of them wears a colour of its own: a skinned body
 * can only take one through a uniform and a uniform costs a material an animal
 * (puppet.js makePuppetMaterials). `lures` are the kinds of thing in a hand it
 * courts, `standoff` how near it follows one to, `follow` the gait it follows
 * at by how many metres behind it is (the first whose figure it is under), and
 * `court` what it does once it is there and the lure is not at its face.
 * `prefix` is the first word of its creatures' keys.
 */
export const SPECIES = [
  {
    key: 'stag', prefix: 'st', glb: CRITTER_GLB.stag, vary: 0.25, scale: 1, rate: 0.5,
    acts: [['graze', 5], ['stand', 3], ['roam', 4], ['rest', 1]],
    gaits: [['walk', 7], ['trot', 3]],
    lures: ['carrot'], standoff: 2, follow: [['walk', 4], ['trot', 10], ['run', Infinity]], court: 'gaze',
  },
  {
    key: 'fox', prefix: 'fx', glb: CRITTER_GLB.fox, vary: 0.25, scale: 1.5, rate: 0.5,
    acts: [['roam', 5], ['stand', 3], ['dig', 2], ['rest', 2], ['graze', 1]],
    gaits: [['walk', 2], ['trot', 8]],
    lures: ['fish', 'crab'], standoff: 1.2, follow: [['trot', 8], ['run', Infinity]], court: 'gaze',
  },
  {
    key: 'hare', prefix: 'hr', glb: CRITTER_GLB.hare, vary: 0.25, scale: 1, rate: 1,
    acts: [['graze', 5], ['stand', 4], ['roam', 4], ['dig', 1], ['rest', 1]],
    gaits: [['hop', 6], ['bound', 4]],
    lures: ['carrot'], standoff: 0.6, follow: [['bound', Infinity]], court: 'frolic',
  },
]

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
/** Seconds on the tick grid: every phrase and step is a whole number of ticks, so a walk's length in ticks is a count and not a rounding. */
const ticksOf = (s) => Math.round(s * TICK_HZ)
const onGrid = (s) => ticksOf(s) * TICK_S
/** The heading that carries a body from a to b: +X forward, a positive heading toward -Z. */
const bearing = (a, b) => Math.atan2(-(b.z - a.z), b.x - a.x)
/** The ticks a planned walk spends pivoting through `sw` radians before its first step: one less than the turn's tick count, since the tick that lands on the aim also steps. */
const turnTicks = (sw) => Math.max(0, Math.ceil(Math.abs(sw) / (TURN_RATE * TICK_S) - 1e-9) - 1)
/** One name out of (name, weight) pairs. */
function weighted(rand, pairs) {
  let roll = rand() * pairs.reduce((sum, p) => sum + p[1], 0)
  for (const [name, w] of pairs) if ((roll -= w) < 0) return name
  return pairs[pairs.length - 1][0]
}

const UP = new THREE.Vector3(0, 1, 0)
const _quat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
// A quarter roll about the body's own forward axis: a standing body laid on its flank.
const _lay = new THREE.Matrix4().makeRotationX(Math.PI / 2)
const _hang = new THREE.Matrix4()
const _norm = { x: 0, y: 1, z: 0 }
const _tickPose = { x: 0, z: 0, heading: 0 }

/** Where the phrase `ph` has the body after its tick `n` (0 the first; below 0, its start pose): the pivot at TURN_RATE toward the aim, then the straight walk at its pace, closed form. */
function poseIn(ph, n, out) {
  const from = ph.from
  const sw = swing(from.heading, ph.aim)
  out.heading = from.heading + Math.sign(sw) * Math.min(Math.abs(sw), (n + 1) * TURN_RATE * TICK_S)
  if (ph.mps === undefined) { out.x = from.x; out.z = from.z; return out }
  const len = Math.hypot(ph.to.x - from.x, ph.to.z - from.z)
  const along = clamp((n + 1 - ph.turn) * ph.mps * TICK_S, 0, len)
  out.x = from.x + Math.cos(ph.aim) * along
  out.z = from.z - Math.sin(ph.aim) * along
  return out
}

/**
 * A shipped quadruped (tools/creatures/ship-quadruped.mjs): the ladder, the
 * skeleton, the clips and the colour map as render/puppet.js wants them, plus
 * the shipper's extras spread on top -- the body's length and turned span, and
 * the ground speed of each gait in the file's own units.
 *
 * The vertices themselves are still on the rig's diagonal; the frame that
 * squares them up rides on the ROOT JOINT, so anything drawn through the
 * skeleton is already straight and nothing here has to know about it.
 */
export async function loadQuadrupedGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: CLIPS, extras: 'quadruped' })
  if (!(asset.extras.span > 0)) throw new Error(`${url}: no turned span in its extras -- re-ship it`)
  if (asset.extras.legs?.length !== 4) throw new Error(`${url}: no four legs in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

export class Wildlife {
  /**
   * @param height  V2Height: heightAt, normalAt, snowLineAt -- the ground the plan is made on
   * @param water   WaterSurfaces: isSubmerged -- an animal does not wade
   * @param opts.walk  WalkSurface: heightAt, normalAt. The ground she walks is the ground their feet are probed against.
   * @param opts.dayness  the world's day scalar at a world time (clock.js WorldClock.daynessAt), read by the plan; noon when absent
   * @param opts.assets a loaded asset per species, keyed by SPECIES.key, for a gate; the world fetches the GLBs
   * @param opts.species the SPECIES keys this room holds; every one when absent
   */
  constructor(scene, height, water, { seed = 1, walk, dayness = null, assets = null, species = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.normalAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Wildlife needs a height field with heightAt, normalAt and snowLineAt')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Wildlife needs WaterSurfaces, for isSubmerged')
    if (!walk || typeof walk.heightAt !== 'function' || typeof walk.normalAt !== 'function') throw new Error('Wildlife needs the WalkSurface, for heightAt and normalAt')
    if (dayness !== null && typeof dayness !== 'function') throw new Error('Wildlife: dayness must be a function of world time')
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed
    this.dayness = dayness ?? (() => 1)
    this.score = new Score((key, chapter, rand) => this._plan(key, chapter, rand))
    // The plans before the dragons' cut, for the dragons: a chapter or two a stag, for as many stags as they consider.
    this.freeScore = new Score((key, chapter, rand) => this._planFree(key, chapter, rand), { keep: 2, cap: FREE_PLANS })
    // (key, t0, t1) -> the world time a dragon's stoop on that animal ends within [t0, t1), or null. Set by the dragons; none, and nothing is ever struck.
    this.hunter = null

    this.batch = new THREE.Group()
    this.batch.name = 'v2-wildlife'
    scene.add(this.batch)
    // Every material the world's lighting patches; two programs a species, the dissolve's cut being a uniform and not a variant.
    this.materials = []

    if (species !== null) for (const key of species) if (!SPECIES.some((sp) => sp.key === key)) throw new Error(`Wildlife: no species named ${key}`)
    this.species = SPECIES.filter((sp) => species === null || species.includes(sp.key)).map((sp) => {
      // ONE settled material for the whole species, and a fade pair per puppet.
      // A settled animal is the usual case and a fading one lasts FADE_S, so a
      // frame of a dozen drawn stags is one material change and not a dozen.
      const plain = makeSettledMaterial(`wildlife-${sp.key}`)
      this.materials.push(plain)
      const materials = []
      for (let i = 0; i < PUPPETS; i++) {
        const mats = makePuppetMaterials(`wildlife-${sp.key}`, plain)
        materials.push(mats)
        this.materials.push(mats.in, mats.out)
      }
      // Built here and not with the asset, because the world patches every
      // material with its lighting the moment the layer exists and the GLBs
      // land long after. The quad and the picture arrive in setAssets and
      // bakeCards; until the picture does, the mesh draws nothing.
      const cardMaterial = createCritterCardMaterial(`wildlife-${sp.key}`, { billboard: true, fade: true, hue: false })
      this.materials.push(cardMaterial)
      const slots = []
      for (let i = 0; i < MAX; i++) {
        slots.push({
          id: i, sp: null, spawn: null, key: null,
          // The pose the frame draws, between the last two ticks; `y` and the normal are the ground under it, read on the probe cadence.
          x: 0, y: 0, z: 0, heading: 0, size: 1, k: 1,
          nx: 0, ny: 1, nz: 0,
          // The tick pose and the tick before it, and the tick record (sim/score.js stepTo).
          sx: 0, sz: 0, sh: 0, lx: 0, lz: 0, lh: 0, rec: { tick: 0, alpha: 1 },
          home: null, aim: 0,
          // The phrase playing: the score's or the rejoin's, its bounds, the tick it was entered on, its dice.
          phrase: null, phraseStart: 0, phraseEnd: 0, phraseTick0: 0, phraseEndTick: 0, phraseIndex: 0, chapter: 0, rand: null, rejoin: null,
          // The activity, the steps it has left, the clip playing, when that step began and the tick it ends on; `dur` is that step's whole length, so a puppet taken mid-step joins the clip where it already is, and `cycle` the clip's own length, for the ear's footfall clock. `cue` counts steps, and is how a puppet tells a fresh step from the one it is playing.
          act: 'stand', queue: [], clip: 'idle', stepStart: 0, stepEndTick: 0, dur: 0, cycle: 0, cue: 0, speed: 0,
          // Live: `{ mode, by, anchor, sendTick, rand }` while after a lure (hands.js lures: kind, x, y, z, by), the lure itself, and the ticks of detour left before it is re-aimed at it.
          live: null, lure: null, detour: 0,
          // The ladder rung it is on, CARD_RUNGS being past the last rung and so neither drawn nor simulated.
          lod: CARD_RUNGS, puppet: null,
          // Whether the card is the thing this animal should be drawing, and how
          // far through the dissolve into or out of that it is (1 is settled).
          cardWant: false, cardP: 1,
          // Where its card was last drawn: pushed again on the frames a card animal is not stepped, and the dissolve on a seized one's drop.
          cardMat: new THREE.Matrix4(),
          // Where the ground under it was last read: a probe frame re-reads it only once the body has moved off that spot.
          px: NaN, pz: NaN,
        })
      }
      return { ...sp, plain, materials, cardMaterial, cardMesh: null, cardFade: null, cardN: 0, slots, free: slots.slice(), puppets: [], freePuppets: [], asset: null }
    })

    this.tiles = new Map()
    // tileKey -> the roll of a tile that is not resident, for the dragons' questions; the longest unasked forgotten past ROLLED_TILES.
    this.rolled = new Map()
    // Every woken animal by its key, and the room's latest anchor by key (apply), kept through sleep so a waking animal is born where the room has it.
    this.byKey = new Map()
    this.anchored = new Map()
    // The anchors this client owes the room (pending).
    this.outbox = []
    // Where her head was when the tiles were last walked.
    this.walkedX = Infinity
    this.walkedZ = Infinity
    this.frame = 0
    this.last = null
    this.loaded = false
    // Candidates whose seat held but that found no free slot; animal-frames in sight with no free puppet, and so not drawn; ticks replayed this frame, and animals still behind the clock after them.
    this.overflow = 0
    this.starved = 0
    this.replayed = 0
    this.behind = 0
    // Puppets outliving the animal they were: whatever unloaded with its tile, dissolving on the spot.
    this.fading = []
    this.fadingCards = []
    this.lures = NO_LURES

    if (assets) {
      this.setAssets(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    const loaded = await Promise.all(this.species.map((sp) => loadQuadrupedGlb(sp.glb)))
    this.setAssets(Object.fromEntries(this.species.map((sp, i) => [sp.key, loaded[i]])))
    return true
  }

  /** One loaded asset per species, keyed by SPECIES.key. */
  setAssets(assets) {
    for (const sp of this.species) {
      const asset = assets[sp.key]
      if (!asset) throw new Error(`Wildlife.setAssets: nothing for ${sp.key}`)
      if (!(asset.span > 0) || !(asset.width > 0) || !(asset.height > 0)) throw new Error(`Wildlife.setAssets: ${sp.key} has no body extents -- re-ship it`)
      for (const [gait] of sp.gaits) if (!(asset.gait[gait] > 0)) throw new Error(`Wildlife.setAssets: ${sp.key} has no ground speed for its ${gait}`)
      sp.asset = asset
      // The ladder's rungs are a ratio of the body's LARGEST extent (critters.js), and `size` is its length: for a four-legged animal those are the same thing, and `bulk` says so rather than assuming it.
      sp.bulk = Math.max(asset.span, asset.width, asset.height) / asset.span
      sp.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
      sp.plain.map = asset.map
      sp.plain.needsUpdate = true
      for (const mats of sp.materials) {
        for (const m of [mats.in, mats.out]) {
          m.map = asset.map
          m.needsUpdate = true
        }
        sp.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT }))
      }
      sp.freePuppets = sp.puppets.slice()

      // The card rung's quad, in the same unit frame the puppet's meshes are in
      // and sized by the shipper's own measurements of the turned body, so one
      // `k` scales both and the handover is the same animal at the same size.
      // As wide as the body's longest side (spunBounds), since the one picture
      // stands in for every side of it.
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), sp.cardMaterial, MAX)
      mesh.name = `v2-wildlife-${sp.key}-cards`
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      // The instances move every frame and a bounding sphere over them would have to be rebuilt every frame to say anything true.
      mesh.frustumCulled = false
      mesh.count = 0
      // Nothing to draw until bakeCards has photographed the body: an unbaked card is a white quad, which is worse than no card.
      mesh.visible = false
      setCritterCard(mesh, spunBounds({ halfX: asset.span / 2, halfZ: asset.width / 2, height: asset.height }), SPUN_VIEWS)
      sp.cardFade = makeCardFadeAttribute(mesh, MAX)
      sp.cardMesh = mesh
      this.batch.add(mesh)
    }
    this.loaded = true
  }

  /**
   * Photograph each species for its card rung: the body posed in `idle` through
   * a throwaway puppet, because a quadruped's vertices sit on the rig's diagonal
   * and mean nothing until the bones have moved them. Needs the renderer, so the
   * world calls it once the GLBs have landed.
   */
  bakeCards(renderer) {
    if (!this.loaded) throw new Error('Wildlife.bakeCards: the GLBs have not landed')
    for (const sp of this.species) {
      const asset = sp.asset
      const flat = new THREE.MeshBasicMaterial({ map: asset.map, toneMapped: false })
      // Puppet wants the three-material shape; unlit for the photograph, the same one for every state it might pick.
      const p = new Puppet(asset, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, { clipFade: FADE_S, oneShot: ONE_SHOT })
      p.show(0)
      p.play('idle')
      p.step(0)
      p.group.updateMatrixWorld(true)
      const bounds = spunBounds({ halfX: asset.span / 2, halfZ: asset.width / 2, height: asset.height })
      sp.cardMaterial.map = bakeCritterCard(renderer, p.group, asset.map, bounds, SPUN_VIEWS)
      sp.cardMaterial.needsUpdate = true
      sp.cardMesh.visible = true
      p.release()
      p.skeleton.dispose()
      flat.dispose()
    }
  }

  /**
   * The ground at (x, z) an animal may stand on, or null: the height field,
   * gentle, dry and below the cold. Pure in position -- see the header -- so
   * every client plans the same walk. The normal there goes into `_norm`.
   */
  seat(x, z) {
    const y = this.height.heightAt(x, z)
    if (this.water.isSubmerged(x, z, y)) return null
    if (y > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    this.height.normalAt(x, z, undefined, _norm)
    if (Math.acos(Math.min(1, _norm.y)) > MAX_SLOPE) return null
    return y
  }

  /**
   * A tile's spawns: where each animal stands before anything has moved it, and
   * what it is. Rolling one costs a seat test and nothing else -- no slot, no
   * puppet, no plan -- because most of a tile's spawns are asleep most of the
   * time, and a spawn asleep costs a distance. Its key is the tile and its
   * index in the roll, which every client rolls alike. (Not the tile's seed:
   * tileSeed gives mirror tiles at odd coordinates the same one.)
   */
  _roll(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, spawns: [] }
    let i = 0
    for (const sp of this.species) {
      const want = DENSITY * sp.rate * TILE * TILE
      const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
      for (let j = 0; j < n; j++, i++) {
        const x = (tx + rand()) * TILE
        const z = (tz + rand()) * TILE
        const size = sp.asset.sizeM * sp.scale * (1 + (rand() * 2 - 1) * sp.vary)
        const heading = rand() * Math.PI * 2
        const y = this.seat(x, z)
        if (y === null) continue
        const lodSize = size * sp.bulk
        t.spawns.push({
          sp, key: `${sp.prefix}:${tx},${tz}:${i}`, x, y, z, nx: _norm.x, ny: _norm.y, nz: _norm.z, size, heading,
          // The one home object its plans are from, whether the plan came before or after it woke: a chapter's first phrase is from it by identity.
          home: { x, z, heading },
          // Where the mesh gives way to the card, where the card gives way to nothing, and where the placement stops being worth remembering.
          cull: cullRange(lodSize), card: cullRange(lodSize, CARD_RUNGS), forget: forgetRange(lodSize, CARD_RUNGS),
          // Struck by a dragon: not woken until the world time its chapter turns.
          lodSize, slot: null, deadUntil: 0,
        })
      }
    }
    return t
  }

  /** The tile becoming resident: the roll the dragons may already have asked for, else a fresh one. */
  _grow(tx, tz) {
    const key = tileKey(tx, tz)
    const had = this.rolled.get(key)
    if (had) { this.rolled.delete(key); return had }
    return this._roll(tx, tz)
  }

  /** The tile (tx, tz) resident or not: the resident one, or the same roll from a bounded cache. */
  _tileOf(tx, tz) {
    const key = tileKey(tx, tz)
    const t = this.tiles.get(key) ?? this.rolled.get(key)
    if (t) return t
    const rolled = this._roll(tx, tz)
    if (this.rolled.size >= ROLLED_TILES) this.rolled.delete(this.rolled.keys().next().value)
    this.rolled.set(key, rolled)
    return rolled
  }

  /** The spawn keyed `key`, woken or not, resident or not; a key no tile rolled throws. */
  _spawnOf(key) {
    const m = /^[a-z]+:(-?\d+),(-?\d+):\d+$/.exec(key)
    const s = m && this._tileOf(Number(m[1]), Number(m[2])).spawns.find((c) => c.key === key)
    if (!s) throw new Error(`Wildlife: no animal keyed ${key}`)
    return s
  }

  /** What a plan needs of the animal `key` -- its home, its species, its scale -- from the live animal or from its spawn. */
  _whoOf(key) {
    const c = this.byKey.get(key)
    if (c) return c
    const s = this._spawnOf(key)
    return { home: s.home, sp: s.sp, k: s.size / s.sp.asset.span }
  }

  /** A spawn woken into a live animal at world time `now`, placed where the room's anchor or its score has it, or null when the pool is out of slots. */
  _wake(s, now) {
    const c = s.sp.free.pop()
    if (!c) { this.overflow++; return null }
    c.sp = s.sp
    c.spawn = s
    c.key = s.key
    c.home = s.home
    c.y = s.y
    c.nx = s.nx; c.ny = s.ny; c.nz = s.nz
    c.size = s.size
    c.k = s.size / s.sp.asset.span
    c.lod = CARD_RUNGS
    c.puppet = null
    c.cardWant = false
    c.cardP = 1
    s.slot = c
    this.byKey.set(c.key, c)
    this._replace(c, now)
    c.rec.alpha = 1
    this._pose(c)
    return c
  }

  /**
   * A live animal back to a spawn: the slot returns to the pool and the score
   * keeps its place. `fade` leaves its puppet behind to dissolve on the spot --
   * the animal is gone, its body is not -- and is false only where there is
   * nothing left to fade on.
   */
  _sleep(s, fade = true) {
    const c = s.slot
    if (!c) return
    if (fade && c.puppet) {
      c.puppet.show(-1)
      this.fading.push({ sp: c.sp, puppet: c.puppet })
      c.puppet = null
    } else {
      this._releasePuppet(c)
    }
    this.byKey.delete(c.key)
    this.score.forget(c.key)
    c.spawn = null
    c.live = c.rejoin = c.lure = null
    s.slot = null
    s.sp.free.push(c)
  }

  _leave(t, fade = true) {
    for (const s of t.spawns) this._sleep(s, fade)
    t.spawns.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. Nothing fades: the ground a body was standing on is not there to fade on. The room's anchors are kept. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t, false)
    for (const f of this.fading) this._park(f.puppet, f.sp)
    this.fading.length = 0
    this.fadingCards.length = 0
    this.tiles.clear()
    this.rolled.clear()
    this.overflow = 0
    if (!this.loaded) return
    // The cards go with them: the buffers hold last frame's animals, and the next frame refills them from the tiles this line is about to grow.
    for (const sp of this.species) { sp.cardN = 0; sp.cardMesh.count = 0 }
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._grow(tx, tz), (t) => this._leave(t))
    this.walkedX = cx
    this.walkedZ = cz
  }

  get stats() {
    const alive = {}
    const puppets = {}
    // Drawn animals and the triangles they cost, split by MESH rung, so which rung a creature is on is a number to read and not a thing to squint at. The card rung has no tier and is counted on its own.
    const lod = Array.from({ length: LOD_RUNGS }, () => ({ n: 0, tris: 0 }))
    let cards = 0
    for (const sp of this.species) {
      alive[sp.key] = MAX - sp.free.length
      puppets[sp.key] = sp.puppets.length - sp.freePuppets.length
      cards += sp.cardN
      for (const c of sp.slots) {
        if (c.spawn === null || c.lod >= LOD_RUNGS) continue
        lod[c.lod].n++
        lod[c.lod].tris += sp.asset.tiers[c.lod].index.count / 3
      }
    }
    return { alive, puppets, lod, cards, tiles: this.tiles.size, overflow: this.overflow, starved: this.starved, replayed: this.replayed, behind: this.behind }
  }

  /**
   * Every animal living this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size, clip, cycle and speed on them, `speed > 0`
   * meaning it is walking a gait. A hidden layer is frozen and lists nothing;
   * nor does an animal past its last rung, which stands still whatever clip it
   * was on.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const sp of this.species) {
      for (const c of sp.slots) if (c.spawn !== null && c.lod < CARD_RUNGS) into.push(c)
    }
    return into
  }

  // -------------------------------------------------------------------------
  // PREY. The dragons (render/dragons.js) hunt the stags, and what they need
  // of this layer is a few verbs: the stags to roll a hunt over and where the
  // free plan has one at a moment (roster, spawnAt, poseAt), take it (kill),
  // draw it hanging from the talons (carry) and let it go (drop). A taken stag
  // is a slot with no spawn: it is off every tile and off its score, so
  // nothing here walks it, tiers it or lists it for the ear, and its spawn
  // sleeps to its chapter's turn so the tile does not wake a second stag where
  // the first stood. The slot and its puppet stay this layer's -- the pool
  // logic does not leak -- and come back to the pools on `drop`.
  // -------------------------------------------------------------------------

  /** The stags whose spawns lie within `range` of (x, z), resident or not, `{ key, x, z }` each in key order: what a dragon's hunt is rolled over. */
  roster(x, z, range, into = []) {
    const r2 = range * range
    for (let tx = Math.floor((x - range) / TILE); tx <= Math.floor((x + range) / TILE); tx++) {
      for (let tz = Math.floor((z - range) / TILE); tz <= Math.floor((z + range) / TILE); tz++) {
        for (const s of this._tileOf(tx, tz).spawns) {
          if (s.sp.key === 'stag' && (s.x - x) ** 2 + (s.z - z) ** 2 <= r2) into.push({ key: s.key, x: s.x, z: s.z })
        }
      }
    }
    into.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return into
  }

  /** Where the animal `key` stands when nothing has moved it. */
  spawnAt(key) {
    const s = this._spawnOf(key)
    return { x: s.x, z: s.z }
  }

  /** Where the free plan has the animal `key` at world time `T`, `{ x, y, z, heading }` on the height field: the pose a stepped body would hold at that tick. */
  poseAt(key, T, into = { x: 0, y: 0, z: 0, heading: 0 }) {
    const at = this.freeScore.at(key, T)
    poseIn(at.phrase, tickOf(T) - tickAfter(at.start), into)
    into.y = this.height.heightAt(into.x, into.z)
    return into
  }

  /**
   * The stag `key` taken by a dragon at world time `now`, as cargo: a slot off
   * its spawn, gone limp (`dead`, which holds its last frame) -- the live slot
   * where the stag is awake, else one dressed from the spawn -- or null when the
   * pool is out. The spawn is not woken again until its chapter turns: the
   * moment its cut plan says, or, struck off its plan, the chapter's end.
   */
  kill(key, now) {
    const s = this._spawnOf(key)
    const at = this.score.at(key, now)
    s.deadUntil = at.phrase.kind === 'dead' ? at.start + at.phrase.dur : chapterOf(now, key, this.score.chapterS).start + this.score.chapterS
    if (s.slot) return this._seize(s.slot)
    this.score.forget(key)
    const c = s.sp.free.pop()
    if (!c) { this.overflow++; return null }
    c.sp = s.sp
    c.spawn = null
    c.key = s.key
    c.size = s.size
    c.k = s.size / s.sp.asset.span
    c.lod = CARD_RUNGS
    c.puppet = null
    c.cardWant = false
    c.cardP = 1
    return this._limp(c, s)
  }

  /** A live stag out of the world: off its spawn, off every list, its slot the caller's. */
  _seize(c) {
    if (c.spawn === null) throw new Error('Wildlife.seize: that animal is not in the world')
    const s = c.spawn
    s.slot = null
    c.spawn = null
    this.byKey.delete(c.key)
    this.score.forget(c.key)
    return this._limp(c, s)
  }

  /** The slot on the dead clip from its start, held its whole length, so a puppet taking it over mid-carry plays the slump and clamps. */
  _limp(c, s) {
    c.lodSize = s.lodSize
    c.act = 'dead'
    c.live = c.rejoin = c.lure = null
    c.queue.length = 0
    c.clip = 'dead'
    c.cue++
    c.dur = c.sp.durations.dead
    c.stepStart = NaN
    c.cycle = c.dur
    c.speed = 0
    return c
  }

  /**
   * One frame of a seized stag drawn from `matrix` -- the carrier's talons, or
   * a point on the nest floor -- `dist` metres from her head: its own species'
   * mesh rungs while the ladder says mesh, and past them its card, standing
   * upright under the talons (or on the nest spot) for as long as the carrier
   * is drawn (`shown`) -- the kill's own card reach does not apply, because a
   * dragon she can see carrying nothing is the wrong picture at any range.
   * Hanging, the body's back is at the matrix and the rest of it sags below;
   * `lain`, the mesh is rolled onto its flank with the flank on the matrix.
   * Called after update() has filled the card buffers, so it appends to them.
   */
  carry(c, matrix, dist, dt, lain = false, shown = true) {
    if (c.spawn !== null || c.act !== 'dead') throw new Error('Wildlife.carry: that animal was not seized')
    const tier = critterTier(c.lodSize, dist, c.lod, LOD_RUNGS)
    c.lod = tier
    matrix.decompose(_pos, _quat, _scl)
    c.x = _pos.x; c.y = _pos.y; c.z = _pos.z
    const { width, height } = c.sp.asset
    // Only while the layer is stepped: with it hidden update() has not emptied the buffer this frame, and a card appended every frame would fill it.
    if (this.batch.visible) {
      this._wantCard(c, tier === LOD_RUNGS && shown)
      if (c.cardP < 1) c.cardP = Math.min(1, c.cardP + dt / LOD_FADE_S)
      if (c.cardWant || c.cardP < 1) {
        // Upright on the nest spot, or its feet GRIP of its height under the talons, where the mesh's would be.
        this._cardAt(c, lain ? c.cardMat.copy(matrix) : c.cardMat.multiplyMatrices(matrix, _hang.makeTranslation(0, -GRIP * height, 0)))
        this._commitCards(c.sp)
      }
    }
    if (tier >= LOD_RUNGS) {
      if (!c.puppet) return
      c.puppet.show(-1)
      c.puppet.step(dt)
      if (c.puppet.done) this._releasePuppet(c)
      return
    }
    const puppet = this._takePuppet(c, 0)
    if (!puppet) return
    puppet.show(tier)
    puppet.play(c.clip, c.cue)
    // Carried, there is no ground under its feet.
    puppet.unplant()
    puppet.step(dt)
    // Body-local offsets, so the matrix's own scale and yaw carry them.
    const body = lain
      ? _mat.makeTranslation(0, LAIN * width, 0).multiply(_lay)
      : _mat.makeTranslation(0, -GRIP * height, 0)
    puppet.group.matrix.multiplyMatrices(matrix, body)
    puppet.group.matrixWorldNeedsUpdate = true
  }

  /** A seized stag let go: its body -- puppet or card -- dissolves where it is (or vanishes, with `fade` off, when the ground has gone) and the slot goes back to the pool. */
  drop(c, fade = true) {
    if (c.spawn !== null || c.act !== 'dead') throw new Error('Wildlife.drop: that animal was not seized')
    if (fade && c.puppet) {
      c.puppet.show(-1)
      this.fading.push({ sp: c.sp, puppet: c.puppet })
      c.puppet = null
    } else {
      this._releasePuppet(c)
    }
    if (fade && (c.cardWant || c.cardP < 1)) {
      // Where carry() last drew it; a card still arriving is sent out from as far as it got.
      this._wantCard(c, false)
      this.fadingCards.push({ sp: c.sp, mat: c.cardMat.clone(), p: c.cardP })
    }
    c.cardWant = false
    c.cardP = 1
    c.act = 'stand'
    c.lod = CARD_RUNGS
    c.sp.free.push(c)
  }

  // -------------------------------------------------------------------------
  // The plan: a chapter of phrases, closed-form, the same on every client.
  // -------------------------------------------------------------------------

  /** `act` as a queue of (clip, seconds) steps, every step a whole number of ticks. */
  _steps(sp, act, rand) {
    const d = sp.durations
    switch (act) {
      case 'stand': return [['idle', onGrid(between(rand, STAND_S))]]
      case 'graze': case 'beg': {
        const chews = Math.round(between(rand, GRAZE_LOOPS))
        return [['eat-down', onGrid(d['eat-down'])], ['eat-loop', onGrid(chews * d['eat-loop'])], ['eat-up', onGrid(d['eat-up'])]]
      }
      case 'rest': {
        // Each is a whole round trip -- down, hold, up -- so it is played once and timed by its own length.
        const clip = rand() < 0.5 ? 'sit' : 'lie'
        return [[clip, onGrid(d[clip])]]
      }
      case 'dig': return [['dig', onGrid(between(rand, DIG_S))], ['alert', onGrid(between(rand, ALERT_S))]]
      case 'notice': return [['alert', onGrid(d.alert)]]
      case 'gaze': return [['idle', onGrid(between(rand, GAZE_S))]]
      case 'frolic': return [['bound', onGrid(between(rand, FROLIC_S))]]
      default: throw new Error(`Wildlife: no activity named ${act}`)
    }
  }

  /** A phrase standing at `from` through `steps`, turned to `heading` (its own by default) while it stands. */
  _still(kind, from, steps, heading = from.heading) {
    const dur = steps.reduce((s, st) => s + st[1], 0)
    return { kind, dur, from, to: { x: from.x, z: from.z, heading }, aim: heading, steps }
  }

  /**
   * A walk from `from` toward `aim` at `mps` on `gait`: the pivot to the aim,
   * then `walkTicks` straight ticks, ending exactly where those ticks put it.
   */
  _walkPhrase(kind, from, aim, gait, mps, walkTicks) {
    const turn = turnTicks(swing(from.heading, aim))
    const dist = walkTicks * mps * TICK_S
    const dur = (turn + walkTicks) * TICK_S
    return { kind, dur, from, to: { x: from.x + Math.cos(aim) * dist, z: from.z - Math.sin(aim) * dist, heading: aim }, aim, steps: [[gait, dur]], gait, mps, turn }
  }

  /** Whether (x, z) is ground an animal from `home` may walk: a seat, inside the tether. */
  _walkable(x, z, home) {
    return Math.hypot(x - home.x, z - home.z) <= TETHER_M && this.seat(x, z) !== null
  }

  /** How many of `walkTicks` straight ticks from `from` along `aim` at `mps` stay on walkable ground that has a walkable straight line home: sampled every SAMPLE_M, clipped SAMPLE_M short of the first failure. */
  _clipWalk(from, aim, mps, walkTicks, home) {
    const cx = Math.cos(aim), sz = Math.sin(aim)
    const perTick = mps * TICK_S
    for (;;) {
      const dist = walkTicks * perTick
      let ok = 0
      for (let s = SAMPLE_M; ; s += SAMPLE_M) {
        const at = Math.min(s, dist)
        if (!this._walkable(from.x + cx * at, from.z - sz * at, home)) break
        ok = at
        if (at >= dist) break
      }
      let n = Math.min(walkTicks, Math.floor(ok / perTick))
      if (n <= 0) return 0
      // The way home from the end, so the chapter's last walk is on ground it can take.
      const ex = from.x + cx * n * perTick, ez = from.z - sz * n * perTick
      const back = Math.hypot(home.x - ex, home.z - ez)
      let clear = true
      for (let s = SAMPLE_M; s < back && clear; s += SAMPLE_M) {
        const u = s / back
        clear = this._walkable(ex + (home.x - ex) * u, ez + (home.z - ez) * u, home)
      }
      if (clear) return n
      walkTicks = n - Math.ceil(SAMPLE_M / perTick)
      if (walkTicks <= 0) return 0
    }
  }

  /** A roam from `from`: a gait by the species' weights for ROAM_S, aimed within TURN of the heading, or home within a quarter turn either way once past HOMING of the tether; a stand of the same length where the ground leaves too little walk. */
  _roam(c, from, rand) {
    const home = c.home
    const far = Math.hypot(from.x - home.x, from.z - home.z) > HOMING * TETHER_M
    const aim = far ? bearing(from, home) + (rand() - 0.5) * (Math.PI / 2) : from.heading + (rand() - 0.5) * TURN
    const gait = weighted(rand, c.sp.gaits)
    const mps = c.sp.asset.gait[gait] * c.k
    const dur = onGrid(between(rand, ROAM_S))
    const turn = turnTicks(swing(from.heading, aim))
    const want = ticksOf(dur) - turn
    const walkTicks = want >= MIN_WALK_TICKS ? this._clipWalk(from, aim, mps, want, home) : 0
    if (walkTicks < MIN_WALK_TICKS) return this._still('stand', from, [['idle', dur]])
    return this._walkPhrase('roam', from, aim, gait, mps, walkTicks)
  }

  /** The walk from `from` to `to` at the species' pace, or null when it is already there: as many ticks as reach it, and the ease and the snap take up the last centimetres. */
  _walkTo(c, from, to) {
    const dist = Math.hypot(to.x - from.x, to.z - from.z)
    if (dist < 1e-3) return null
    const gait = c.sp.gaits[0][0]
    const mps = c.sp.asset.gait[gait] * c.k
    const ph = this._walkPhrase('roam', from, bearing(from, to), gait, mps, Math.ceil(dist / (mps * TICK_S) - 1e-9))
    ph.to.x = to.x
    ph.to.z = to.z
    return ph
  }

  /** Seconds from `from` to `to` at the species' pace: the pivot and the straight. */
  _travel(c, from, to) {
    const dist = Math.hypot(to.x - from.x, to.z - from.z)
    if (dist < 1e-3) return 0
    const mps = c.sp.asset.gait[c.sp.gaits[0][0]] * c.k
    return turnTicks(swing(from.heading, bearing(from, to))) * TICK_S + dist / mps
  }

  /** The chapter `chapter` of animal `key`: its free plan, cut at the dragons' strike if one falls in it. */
  _plan(key, chapter, rand) {
    const phrases = this._planFree(key, chapter, rand)
    if (!this.hunter) return phrases
    const chapterS = this.score.chapterS
    const start = chapter * chapterS + (keyHash(key) % chapterS)
    const strike = this.hunter(key, start, start + chapterS)
    if (strike === null) return phrases
    if (!(strike >= start && strike < start + chapterS)) throw new Error(`Wildlife: a strike on ${key} at ${strike} is outside its chapter from ${start}`)
    return this._cut(phrases, start, strike)
  }

  /** `phrases` from the chapter starting at world time `start`, cut at world time `strike`: whole up to it, the phrase it falls in ended where the body is at the tick before, and `dead` from there to the chapter's end. */
  _cut(phrases, start, strike) {
    const out = []
    let t = 0
    let pose = phrases[0].from
    for (const ph of phrases) {
      if (t + ph.dur <= strike - start + 1e-9) {
        out.push(ph)
        t += ph.dur
        pose = ph.to
        continue
      }
      const dur = strike - start - t
      const to = poseIn(ph, tickAfter(strike) - 1 - tickAfter(start + t), { x: 0, z: 0, heading: 0 })
      const steps = []
      for (let left = dur, i = 0; left > 1e-9 && i < ph.steps.length; i++) {
        steps.push([ph.steps[i][0], Math.min(ph.steps[i][1], left)])
        left -= ph.steps[i][1]
      }
      out.push({ ...ph, dur, to, steps })
      pose = to
      break
    }
    const dur = this.score.chapterS - (strike - start)
    out.push({ kind: 'dead', dur, from: pose, to: pose, aim: pose.heading, steps: [['dead', dur]] })
    return out
  }

  /** The chapter `chapter` of animal `key` with no dragon in it: phrases by the species' weights, the night's thumb on the resting one, from home and while the way home still fits, then the walk home and a stand at the home pose to the chapter's end. */
  _planFree(key, chapter, rand) {
    const c = this._whoOf(key)
    const chapterS = this.score.chapterS
    const start = chapter * chapterS + (keyHash(key) % chapterS)
    const home = c.home
    const phrases = []
    let t = 0
    let pose = home
    for (;;) {
      const rest = 1 + (NIGHT_REST - 1) * (1 - this.dayness(start + t))
      const act = weighted(rand, c.sp.acts.map(([n, w]) => [n, n === 'rest' ? w * rest : w]))
      const ph = act === 'roam' ? this._roam(c, pose, rand) : this._still(act, pose, this._steps(c.sp, act, rand))
      if (t + ph.dur + this._travel(c, ph.to, home) + HOME_PAD_S > chapterS) break
      phrases.push(ph)
      t += ph.dur
      pose = ph.to
    }
    const back = this._walkTo(c, pose, home)
    if (back) {
      phrases.push(back)
      t += back.dur
      pose = back.to
    }
    phrases.push(this._still('stand', pose, [['idle', chapterS - t]], home.heading))
    return phrases
  }

  /** The phrase playing at world time `t`: the rejoin's while one runs, else the score's. `{ phrase, start, end, index, chapter, rejoin }`. */
  _phraseAt(c, t) {
    const rj = c.rejoin
    if (rj) {
      if (t < rj.end - 1e-9) {
        let i = rj.phrases.length - 1
        while (i > 0 && rj.start + rj.starts[i] > t + 1e-9) i--
        const end = i + 1 < rj.phrases.length ? rj.start + rj.starts[i + 1] : rj.end
        return { phrase: rj.phrases[i], start: rj.start + rj.starts[i], end, index: i, chapter: tickOf(rj.start), rejoin: true }
      }
      c.rejoin = null
    }
    // A phrase's end is the next phrase's start by the same sum, so the two agree to the bit and the boundary tick is one tick.
    const at = this.score.at(c.key, t)
    const ch = this.score.chapter(c.key, t)
    const end = at.index + 1 < ch.phrases.length ? ch.start + ch.starts[at.index + 1] : ch.start + this.score.chapterS
    return { phrase: at.phrase, start: at.start, end, index: at.index, chapter: at.chapter, rejoin: false }
  }

  /** The animal into phrase `at` at its start pose (the body is already there): its bounds, its dice, its aim, its first step. */
  _enter(c, at) {
    const ph = at.phrase
    c.phrase = ph
    c.phraseStart = at.start
    c.phraseEnd = at.end
    c.phraseTick0 = tickAfter(at.start)
    c.phraseEndTick = tickAfter(at.end)
    c.phraseIndex = at.index
    c.chapter = at.chapter
    c.rand = at.rejoin ? mulberry32(hash32(keyHash(c.key), at.chapter, at.index)) : phraseRand(c.key, at.chapter, at.index)
    c.act = ph.kind
    c.aim = ph.aim
    c.queue.length = 0
    for (const st of ph.steps) c.queue.push(st)
    this._next(c, at.start)
  }

  /** The body's tick pose exactly at a phrase's end pose. */
  _snap(c, to) {
    c.sx = to.x
    c.sz = to.z
    c.sh = to.heading
  }

  /** The body's tick pose, and the tick before it, put at `pose`: a jump, so the next frame probes the ground there whatever its probe cadence says, and plants its feet on it. */
  _place(c, pose) {
    c.sx = c.lx = pose.x
    c.sz = c.lz = pose.z
    c.sh = c.lh = pose.heading
    c.px = c.pz = NaN
    // Put somewhere else, its feet read the ground there afresh: a plant is heights off where it last stood.
    if (c.puppet) c.puppet.unplant()
  }

  /**
   * The animal into the phrase playing at `now` -- the rejoin's while one runs
   * -- exactly as an animal that stepped the phrase from its start would be:
   * a planned phrase is closed-form, its pose by tick (_posed) and its steps
   * by their lengths, so nothing is replayed and a join costs a frame.
   */
  _fromPlan(c, now) {
    const at = this._phraseAt(c, now)
    this._place(c, at.phrase.from)
    this._enter(c, at)
    const k = tickOf(now)
    if (k < c.phraseTick0) { c.rec.tick = c.phraseTick0 - 1; return }
    while (k >= c.stepEndTick) this._next(c, c.stepEndTick * TICK_S)
    if (k > c.phraseTick0) {
      this._posed(c, k - 1 - c.phraseTick0)
      c.lx = c.sx; c.lz = c.sz; c.lh = c.sh
    }
    this._posed(c, k - c.phraseTick0)
    c.rec.tick = k
  }

  /** The animal placed afresh at `now`: where the room's anchor has it when there is one from this chapter, else on its score (a rejoin it was on included). Waking, and a body too long unstepped to replay. */
  _replace(c, now) {
    c.live = c.lure = null
    c.detour = 0
    const anchor = this.anchored.get(c.key)
    if (anchor && anchor[1] >= chapterOf(now, c.key).start) {
      c.rejoin = null
      this._fromAnchor(c, anchor, now)
    } else this._fromPlan(c, now)
  }

  // -------------------------------------------------------------------------
  // Behaviour: one tick at a time, from the phrase and its own dice.
  // -------------------------------------------------------------------------

  /** The queue's next step from world time `now`, or, live, the lure's next activity; a phrase whose steps have run out holds `idle` to its end. */
  _next(c, now) {
    const step = c.queue.shift()
    if (!step) {
      if (c.live) { this._court(c, now); return }
      c.queue.push(['idle', Infinity])
      this._next(c, now)
      return
    }
    c.clip = step[0]
    c.dur = step[1]
    c.stepStart = now
    c.stepEndTick = tickAfter(now + step[1])
    c.cycle = c.sp.durations[c.clip]
    c.cue++
    const speed = c.sp.asset.gait[c.clip]
    c.speed = speed === undefined ? 0 : speed * c.k
  }

  /** A lure's activity begun at `now`: its steps, and the aim it needs. Every one of them but the frolic is aimed at the lure by _heed each tick. */
  _begin(c, act, now) {
    const rand = c.live.rand
    const q = c.queue
    q.length = 0
    switch (act) {
      case 'follow': {
        const behind = Math.hypot(c.lure.x - c.sx, c.lure.z - c.sz)
        q.push([c.sp.follow.find(([, m]) => behind < m)[0], FOLLOW_STEP_S])
        break
      }
      case 'frolic': {
        // Across the lure, a quarter turn off its bearing on whichever side is the lesser turn, and no more than FROLIC_SWING of a turn at that, so the bound is a bound and not a pivot, and the bounds ring her feet.
        const at = bearing({ x: c.sx, z: c.sz }, c.lure)
        const off = Math.PI / 2 + (rand() - 0.5)
        const sw = Math.abs(swing(c.sh, at + off)) < Math.abs(swing(c.sh, at - off)) ? swing(c.sh, at + off) : swing(c.sh, at - off)
        c.aim = c.sh + clamp(sw, -FROLIC_SWING, FROLIC_SWING)
        q.push(...this._steps(c.sp, act, rand))
        break
      }
      default:
        q.push(...this._steps(c.sp, act, rand))
    }
    c.act = act
    this._next(c, now)
  }

  /** Aim a quarter to three-quarters of a turn off where the body faces, either way. */
  _turnAway(c) {
    const rand = c.live.rand
    c.aim = c.sh + (rand() < 0.5 ? 1 : -1) * (Math.PI / 4 + rand() * Math.PI / 2)
  }

  /**
   * One tick of a live body's turn: the heading toward the aim, TURN_RATE at
   * the most, and how much of a step that leaves: the cosine of the swing it
   * still owes, so a body three-quarters turned round makes no ground at all
   * and pivots instead.
   */
  _turn(c) {
    const sw = swing(c.sh, c.aim)
    c.sh += Math.sign(sw) * Math.min(Math.abs(sw), TURN_RATE * TICK_S)
    return Math.max(0, Math.cos(sw))
  }

  /**
   * One tick of a live follower: every LIVE_PROBE_TICKS a look a body length
   * and a half ahead, then the turn, then a step along the heading. No seat
   * there, and it aims away -- so an animal after her never walks into the
   * water, up a crag or through a trunk. It is slowest exactly while it is
   * turning hardest, which is what keeps it inside the ground the probe cleared.
   */
  _walkLive(c, k) {
    if (k % LIVE_PROBE_TICKS === 0) {
      const ahead = c.size * AHEAD
      if (this.seat(c.sx + Math.cos(c.sh) * ahead, c.sz - Math.sin(c.sh) * ahead) === null) {
        this._turnAway(c)
        c.detour = ticksOf(DETOUR_S)
      }
    }
    const d = c.speed * TICK_S * this._turn(c)
    c.sx += Math.cos(c.sh) * d
    c.sz -= Math.sin(c.sh) * d
  }

  // -------------------------------------------------------------------------
  // LURES: a thing in a hand its species wants.
  // -------------------------------------------------------------------------

  /** The lure this animal is on this tick: the nearest of the frame's lures of a kind its species wants, noticed within LURE_M and kept to LURE_FORGET_M; null for none. */
  _lure(c) {
    let lure = null
    let best = Infinity
    for (const l of this.lures) {
      if (!c.sp.lures.includes(l.kind)) continue
      const d = Math.hypot(l.x - c.sx, l.z - c.sz)
      if (d < best) { best = d; lure = l }
    }
    return lure !== null && best <= (c.live ? LURE_FORGET_M : LURE_M) ? lure : null
  }

  /** Off the score and after the lure, live from `now`. `by` is the lurer's client id, null for this client, which then owes the room the anchors. Its dice are the moment it went live. */
  _golive(c, lure, by, now) {
    c.live = { mode: 'lure', by, anchor: null, sendTick: tickOf(now), rand: mulberry32(hash32(keyHash(c.key), tickOf(now))) }
    c.rejoin = null
    c.lure = lure
    c.detour = 0
    this._begin(c, 'notice', now)
  }

  /**
   * One tick courting the lure. A follower that has closed to its standoff
   * stops there and then; a gazer whose lure has gone further than the
   * standoff and RESUME_M sets off after it, and a beggar whose lure has left
   * its face lifts its head. Whatever it is doing but a frolic, it faces the
   * lure -- a follower once its detour is over.
   */
  _heed(c, k) {
    const l = c.lure
    const dist = Math.hypot(l.x - c.sx, l.z - c.sz)
    if (c.act === 'follow' && dist <= c.sp.standoff) {
      c.queue.length = 0
      c.stepEndTick = k
    } else if ((c.act === 'gaze' && dist > c.sp.standoff + RESUME_M) || (c.act === 'beg' && !this._atFace(c))) {
      c.queue.length = 0
      if (c.clip === 'eat-down' || c.clip === 'eat-loop') c.queue.push(['eat-up', onGrid(c.sp.durations['eat-up'])])
      c.stepEndTick = k
    }
    if (c.act === 'frolic' || c.act === 'notice') return
    if (c.detour > 0) { c.detour--; return }
    c.aim = bearing({ x: c.sx, z: c.sz }, l)
  }

  /** The lure is at its face: within FACE_M body lengths of its nose, half a length ahead, and no more than FACE_DY lengths above or below its feet. */
  _atFace(c) {
    const l = c.lure
    const nose = c.size * 0.5
    const nx = c.sx + Math.cos(c.sh) * nose
    const nz = c.sz - Math.sin(c.sh) * nose
    return Math.hypot(l.x - nx, l.z - nz) <= FACE_M * c.size && Math.abs(l.y - c.y) <= FACE_DY * c.size
  }

  /**
   * The lure's next activity, when the last has run out: begging with the
   * lure at its face, following past its standoff (or, once following, until
   * it is at it), and otherwise its species' court.
   */
  _court(c, now) {
    const l = c.lure
    if (this._atFace(c)) { this._begin(c, 'beg', now); return }
    const dist = Math.hypot(l.x - c.sx, l.z - c.sz)
    if (dist > c.sp.standoff + (c.act === 'follow' ? 0 : RESUME_M)) { this._begin(c, 'follow', now); return }
    this._begin(c, c.sp.court, now)
  }

  /** One tick live: after the hand while there is one, standing alert at a peer's fresh anchor while there is not, nudged onto that anchor; the authority's anchor owed every ANCHOR_S. No hand and no fresh anchor ends the lure. */
  _stepLive(c, k, now) {
    const live = c.live
    const lure = this._lure(c)
    const fresh = live.anchor !== null && now - live.anchor[1] < ANCHOR_STALE_S
    if (lure === null && !fresh) { this._unlive(c, now); return }
    if (lure !== null) {
      c.lure = lure
      live.by = lure.by ?? null
      this._heed(c, k)
      if (k >= c.stepEndTick) this._next(c, now)
      if (c.speed > 0) this._walkLive(c, k)
      else this._turn(c)
    } else {
      if (c.clip !== 'alert') { c.queue.length = 0; c.act = 'notice'; c.queue.push(['alert', Infinity]); this._next(c, now) }
      c.aim = live.anchor[5]
      this._turn(c)
    }
    if (live.anchor !== null && live.by !== null) {
      const [, , ax, , az, ah] = live.anchor
      const f = Math.min(1, TICK_S / CORRECT_S)
      c.sx += (ax - c.sx) * f
      c.sz += (az - c.sz) * f
      c.sh += swing(c.sh, ah) * f
    }
    if (live.by === null && k >= live.sendTick) {
      this._owe(c, now, 'lure')
      live.sendTick = k + ticksOf(ANCHOR_S)
    }
  }

  /** This animal's anchor at `now`, owed to the room, and kept as the room's latest for it, so that put to sleep and woken again it resumes as its peers have it. */
  _owe(c, now, mode) {
    const anchor = [c.key, now, c.sx, c.y, c.sz, c.sh, -1, mode, null]
    this.outbox.push(anchor)
    this.anchored.set(c.key, anchor)
  }

  /** The lure over at `now`: the rejoin built from here, owed to the room if this client was the authority, and entered. */
  _unlive(c, now) {
    const mine = c.live.by === null
    c.live = null
    c.lure = null
    c.detour = 0
    if (mine) this._owe(c, now, 'rejoin')
    this._startRejoin(c, now)
    this._enter(c, this._phraseAt(c, now))
  }

  /**
   * The rejoin from the body's tick pose at world time `t`: the walk to the
   * start pose of the first planned phrase that begins after the walk with
   * REJOIN_PAD_S to spare -- the chapter turn is one, so within two chapters
   * there is always one -- and a stand there, turned to its heading, until it
   * begins; then the score again.
   */
  _startRejoin(c, t) {
    const from = { x: c.sx, z: c.sz, heading: c.sh }
    let ch = this.score.chapter(c.key, t)
    for (let n = 0; n < 2; n++) {
      for (let i = 0; i < ch.phrases.length; i++) {
        const p = ch.phrases[i]
        const start = ch.start + ch.starts[i]
        if (start < t + this._travel(c, from, p.from) + REJOIN_PAD_S) continue
        const walk = this._walkTo(c, from, p.from)
        const phrases = walk ? [walk] : []
        const walked = walk ? walk.dur : 0
        const at = walk ? walk.to : from
        phrases.push(this._still('stand', at, [['idle', start - (t + walked)]], p.from.heading))
        c.rejoin = { start: t, phrases, starts: walk ? [0, walk.dur] : [0], end: start }
        return
      }
      ch = this.score.chapter(c.key, ch.start + this.score.chapterS)
    }
    throw new Error(`Wildlife: no phrase to rejoin within two chapters of ${t}`)
  }

  /** The animal put where the room's anchor has it: live at a peer's hand while the anchor is fresh; else on the rejoin from the anchor's time (a live anchor gone stale, from ANCHOR_STALE_S after it, when every client gave the lure up), placed at the phrase now playing. */
  _fromAnchor(c, anchor, now) {
    const [, T, x, , z, heading, , mode, by] = anchor
    if (mode === 'lure' && now - T < ANCHOR_STALE_S) {
      this._place(c, { x, z, heading })
      c.rec.tick = tickOf(now)
      this._golive(c, null, by, now)
      c.live.anchor = anchor
      return
    }
    if (mode !== 'lure' && mode !== 'rejoin') throw new Error(`Wildlife: no anchor mode ${mode}`)
    this._place(c, { x, z, heading })
    this._startRejoin(c, mode === 'lure' ? T + ANCHOR_STALE_S : T)
    this._fromPlan(c, now)
  }

  /**
   * An anchor heard from the room, `[key, T, x, y, z, heading, phraseIndex,
   * mode, by]`, `by` the client it came from (null for this client's own,
   * which is ignored). Kept for an animal not yet woken; on one that is, a
   * live anchor puts it live or nudges it, a rejoin anchor puts it on that
   * rejoin from the anchor's time.
   */
  apply(anchor, now) {
    const [key, T, , , , , , mode, by] = anchor
    if (!Number.isFinite(T)) throw new Error(`Wildlife: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (by === null) return
    if (mode !== 'lure' && mode !== 'rejoin') throw new Error(`Wildlife: no anchor mode ${mode}`)
    this.anchored.set(key, anchor)
    const c = this.byKey.get(key)
    if (!c) return
    if (mode === 'lure') {
      if (!c.live) this._golive(c, null, by, now)
      c.live.anchor = anchor
      c.live.by = by
    } else {
      c.live = c.lure = null
      this._fromAnchor(c, anchor, now)
    }
  }

  /** The anchors this client owes the room since the last call, moved into `into`. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** One tick of an animal at absolute tick `k`: the tick before kept for the frame to draw from, a phrase boundary snapped and crossed, a lure noticed, the step's clip, and the phrase's pose for the tick. */
  _step(c, k) {
    const now = k * TICK_S
    c.lx = c.sx; c.lz = c.sz; c.lh = c.sh
    if (c.live) {
      this._stepLive(c, k, now)
      // The lure over this tick, the rejoin's first tick is posed like any phrase's, as a joiner placed on it would be.
      if (c.live) return
    }
    if (k >= c.phraseEndTick) {
      this._snap(c, c.phrase.to)
      // The boundary tick may fall an ulp short of the end: the next phrase is looked up at the end itself.
      this._enter(c, this._phraseAt(c, Math.max(now, c.phraseEnd)))
    }
    if (c.act === 'dead') { this._posed(c, k - c.phraseTick0); return }
    const lure = this._lure(c)
    if (lure !== null) { this._golive(c, lure, lure.by ?? null, now); return }
    if (k >= c.stepEndTick) this._next(c, now)
    this._posed(c, k - c.phraseTick0)
  }

  /**
   * The tick pose at the `n`th tick of the phrase, closed-form from the
   * phrase alone: the pivot to its aim at TURN_RATE, then, for a walk, the
   * straight along it at its pace, no further than its end. Nothing is
   * integrated, so nothing drifts and there is nothing to ease: the last tick
   * is a rounding from the end pose and the boundary snaps it there.
   */
  _posed(c, n) {
    const p = poseIn(c.phrase, n, _tickPose)
    c.sx = p.x; c.sz = p.z; c.sh = p.heading
  }

  /** The pose the frame draws: between the last two ticks by rec.alpha, the heading round the shorter way. */
  _pose(c) {
    const a = c.rec.alpha
    c.x = lerp(c.lx, c.sx, a)
    c.z = lerp(c.lz, c.sz, a)
    c.heading = c.lh + swing(c.lh, c.sh) * a
  }

  _takePuppet(c, offset) {
    const sp = c.sp
    if (!c.puppet) {
      const p = sp.freePuppets.pop()
      if (!p) { this.starved++; return null }
      c.puppet = p
      this.batch.add(p.group)
      // Joined where the step already is, so an animal that walks into range is not caught halfway through bowing into a graze it began a minute ago; a one-shot holds its last frame rather than wrapping.
      p.play(c.clip, c.cue, ONE_SHOT.has(c.clip) ? Math.min(offset, c.cycle - 1e-3) : offset)
    }
    return c.puppet
  }

  /** A puppet drawing nothing and back in its species' pool. */
  _park(p, sp) {
    p.release()
    this.batch.remove(p.group)
    sp.freePuppets.push(p)
  }

  /** Hand this animal's puppet back at once, without a fade. */
  _releasePuppet(c) {
    if (!c.puppet) return
    this._park(c.puppet, c.sp)
    c.puppet = null
  }

  /**
   * Ask for the card, or ask for it to go. A reversal mid-dissolve rewinds the
   * one already running rather than starting a third -- Puppet.show's rule, and
   * it has to be the same rule, because the two are halves of one dissolve.
   */
  _wantCard(c, on) {
    if (on === c.cardWant) return
    c.cardWant = on
    c.cardP = 1 - c.cardP
  }

  /**
   * This animal into its species' card buffer for this frame: where it stands,
   * which way it faces (the spin keeps the yaw, and reads the picture mirrored
   * for a body facing away), how big it is and its turn round the colour wheel.
   * On the world vertical, as the mesh it stands in for is.
   *
   * `aCardFade` is the dissolve, in material.js's FADE_FRAGMENT terms: positive
   * keeps the low side of the pixel hash and negative the high side. The card
   * arrives on the LOW side because the mesh it is replacing leaves through the
   * puppet's `out`, which keeps the high one, and it leaves on the high side
   * because the mesh arriving through `in` keeps the low one -- so between them
   * they cover every pixel exactly once and the silhouette never thins.
   */
  _drawCard(c) {
    _pos.set(c.x, c.y, c.z)
    _quat.setFromAxisAngle(UP, c.heading)
    _scl.setScalar(c.k)
    this._cardAt(c, c.cardMat.compose(_pos, _quat, _scl))
  }

  /** The card on `mat` -- a carried kill's is the carrier's matrix, not the slot's place and heading -- with the slot's dissolve. */
  _cardAt(c, mat) {
    this._pushCard(c.sp, mat, c.cardWant ? c.cardP : -(1 - c.cardP))
  }

  _pushCard(sp, mat, fade) {
    const i = sp.cardN++
    if (i >= MAX) throw new Error(`Wildlife: ${sp.key} has more cards this frame than the ${MAX} its buffer holds`)
    sp.cardMesh.setMatrixAt(i, mat)
    sp.cardFade.array[i] = fade
  }

  /** The card buffer's count and upload flags set to what has been pushed this frame. */
  _commitCards(sp) {
    sp.cardMesh.count = sp.cardN
    if (!sp.cardN) return
    sp.cardMesh.instanceMatrix.needsUpdate = true
    sp.cardFade.needsUpdate = true
  }

  /**
   * One frame at world time `now` (clock.js WorldClock.seconds): every animal
   * in reach stepped to now, and the ones big enough in her view given a
   * puppet. `lures` is what the hands hold (hands.js lures, hers and her
   * peers'), the kinds the species want being what they take an interest in.
   */
  update(hx, hy, hz, now, lures = NO_LURES) {
    if (!this.loaded) return
    if (!Number.isFinite(now)) throw new Error(`Wildlife.update: world time ${now}`)
    const dt = this.last === null ? 0 : clamp(now - this.last, 0, 0.1)
    this.last = now
    this.lures = lures
    if (Math.hypot(hx - this.walkedX, hz - this.walkedZ) > WALK_M) {
      walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._grow(tx, tz), (t) => this._leave(t))
      this.walkedX = hx
      this.walkedZ = hz
    }
    this.frame++
    this.replayed = 0
    this.behind = 0
    // The card buffers are refilled from nothing every frame: an instance in one is an animal on the card rung THIS frame, and the count is the whole of what is drawn.
    for (const sp of this.species) sp.cardN = 0

    // The bodies of animals that unloaded, finishing their dissolve where they stood. They do not walk, turn or pick anything: they are a fade.
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i]
      f.puppet.step(dt)
      if (!f.puppet.done) continue
      this._park(f.puppet, f.sp)
      this.fading[i] = this.fading[this.fading.length - 1]
      this.fading.pop()
    }

    const want = tickOf(now)
    for (const t of this.tiles.values()) {
      for (const s of t.spawns) {
        if (now < s.deadUntil) continue
        // Asleep, it is measured from home; awake, from wherever the score has walked it.
        const live = s.slot
        const dx = (live ? live.x : s.x) - hx
        const dy = (live ? live.y : s.y) - hy
        const dz = (live ? live.z : s.z) - hz
        const d2 = dx * dx + dy * dy + dz * dz
        // Asleep and past its card range, it stays asleep: the ladder is not asked.
        if (!live && d2 > s.card * s.card) continue
        const dist = Math.sqrt(d2)
        // One rule decides all three: the rung it is drawn at, whether that rung is the card, and whether it is alive at all.
        const tier = critterTier(s.lodSize, dist, live ? live.lod : CARD_RUNGS, CARD_RUNGS)

        if (tier === CARD_RUNGS) {
          if (!live) continue
          // Past the last rung an animal is not stepped: what is left is its body finishing the dissolve out, and then the wait to see whether she comes back before its slot is worth pooling. The score knows where it is meanwhile.
          live.lod = CARD_RUNGS
          this._wantCard(live, false)
          if (live.cardP < 1) {
            live.cardP = Math.min(1, live.cardP + dt / LOD_FADE_S)
            this._drawCard(live)
          }
          if (live.puppet) {
            live.puppet.show(-1)
            live.puppet.step(dt)
            if (live.puppet.done) this._releasePuppet(live)
          } else if (live.cardP >= 1 && dist > s.forget) {
            this._sleep(s)
          }
          continue
        }

        if (!live) {
          // Struck this chapter: not woken, and not measured again until its chapter turns.
          const at = this.score.at(s.key, now)
          if (at.phrase.kind === 'dead') { s.deadUntil = at.start + at.phrase.dur; this.score.forget(s.key); continue }
        }
        const c = live ?? this._wake(s, now)
        if (!c) continue
        c.lod = tier
        // A card animal with no puppet left dissolving against it is stepped every CARD_EVERY frames (see the constant); with one, every frame, for the fade; and on its first frame after a placement, for the ground.
        if (tier === LOD_RUNGS && !c.puppet && !Number.isNaN(c.px) && (this.frame + c.id) % CARD_EVERY !== 0) {
          if (c.cardWant || c.cardP < 1) this._cardAt(c, c.cardMat)
          continue
        }
        // Too far behind to replay in a frame -- back from past the card rung, or a tab that slept -- it is placed afresh where the score (or the room) has it now, which a planned phrase gives closed-form; a live one is integrated, so it is dropped and noticed again.
        if (want - c.rec.tick > CATCH_UP_TICKS) this._replace(c, now)
        this.replayed += stepTo(c.rec, now, (k) => this._step(c, k))
        if (c.rec.tick < want) this.behind++
        // Struck: the body is the dragon's from here (kill), and its spawn sleeps until its chapter turns.
        if (c.act === 'dead') { s.deadUntil = c.phraseEnd; this._sleep(s); continue }
        const wasX = c.x
        const wasZ = c.z
        this._pose(c)

        // On a probe frame (or the first after a placement) the real ground,
        // where the body has moved since it was last read; otherwise the plane
        // the last probe measured, which is what makes a long stride cost
        // nothing visible and a standing animal cost no ground at all.
        const probing = (this.frame + c.id) % PROBE_EVERY[tier] === 0 || Number.isNaN(c.px)
        if (probing && (c.x !== c.px || c.z !== c.pz)) {
          c.y = this.walk.heightAt(c.x, c.z)
          this.walk.normalAt(c.x, c.z, undefined, _norm)
          c.nx = _norm.x; c.ny = _norm.y; c.nz = _norm.z
          c.px = c.x; c.pz = c.z
        } else {
          c.y -= (c.nx * (c.x - wasX) + c.nz * (c.z - wasZ)) / c.ny
        }

        // The card rung: one quad in the species' instanced buffer, and whatever
        // puppet it still has finishing its dissolve out against it.
        this._wantCard(c, tier === LOD_RUNGS)
        if (c.cardP < 1) c.cardP = Math.min(1, c.cardP + dt / LOD_FADE_S)
        if (c.cardWant || c.cardP < 1) this._drawCard(c)
        if (tier === LOD_RUNGS) {
          if (!c.puppet) continue
          c.puppet.show(-1)
          c.puppet.step(dt)
          if (c.puppet.done) this._releasePuppet(c)
          continue
        }

        const puppet = this._takePuppet(c, Math.max(0, now - c.stepStart))
        if (!puppet) continue
        puppet.show(tier)
        _pos.set(c.x, c.y, c.z)
        // The body faces +X, yawed about the world up to its heading. It stands
        // on that up, never on the ground's normal, which is only the plane its
        // feet walk between probes: an animal on a hillside is vertical.
        _quat.setFromAxisAngle(UP, c.heading)
        _scl.setScalar(c.k)
        _mat.compose(_pos, _quat, _scl)

        puppet.play(c.clip, c.cue)
        groundFeet(puppet, c, this.walk, PLANTED, probing)
        puppet.step(dt)
        // Every frame, whether or not it re-posed: a held puppet slides on in the pose its bone texture holds (puppet.js POSE_EVERY).
        puppet.group.matrix.copy(_mat)
        puppet.group.matrixWorldNeedsUpdate = true
      }
    }

    // The cards of dropped kills finishing their dissolve where they were let go.
    for (let i = this.fadingCards.length - 1; i >= 0; i--) {
      const f = this.fadingCards[i]
      f.p = Math.min(1, f.p + dt / LOD_FADE_S)
      if (f.p < 1) { this._pushCard(f.sp, f.mat, -(1 - f.p)); continue }
      this.fadingCards[i] = this.fadingCards[this.fadingCards.length - 1]
      this.fadingCards.pop()
    }

    for (const sp of this.species) this._commitCards(sp)
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    for (const sp of this.species) {
      sp.plain.dispose()
      for (const mats of sp.materials) for (const m of [mats.in, mats.out]) m.dispose()
      sp.cardMaterial.map?.dispose()
      sp.cardMaterial.dispose()
      sp.cardMesh?.geometry.dispose()
      sp.asset?.map?.dispose()
      for (const geo of sp.asset?.tiers ?? []) geo.dispose()
    }
  }
}
