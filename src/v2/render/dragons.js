// ---------------------------------------------------------------------------
// THE DRAGONS: a pair of fen dragons to every roost (render/roosts.js), the
// guard (`:g`, more vivid) resting on the nest every chapter, the male flying
// out from it and carrying a kill home. Each wears a strong hue (DRAGON_HUES).
//
// A DRAGON IS ITS ROOST'S. roosts.sites() lists the nests resident round her,
// and this layer keeps exactly two dragons per site, born the frame the site
// appears and retired (its body dissolving where it flies) the frame the site
// goes. Where a dragon lives is where its roost was placed, and the roost is
// the pure function of position; what it is doing is a pure function of the
// room's clock, so every client in a room sees the same dragon at the same
// place doing the same thing (_notes/creature-sync.md).
//
// ITS LIFE IS A SCORE (sim/score.js). Time is the world clock in seconds, cut
// into CHAPTER_S chapters offset by the roost key's hash; each chapter is a
// chain of phrases rolled from hash(key, chapter, index), every one with a
// closed-form duration and end pose, and the chapter's last phrase ends at the
// home pose on the nest. `rest` on the nest (`roost`) or on a visited spot
// (`perch`) potters through rest steps -- idle, alert, walk round a ring
// WALK_RING of the floor, sit, lie -- and walks back to the centre for the
// end; a `fly` leg cruises CRUISE_AGL over the ground from one point to the
// next at PATROL_MPS, meandering (CAREEN, SWOOP), keeping MIN_AGL over the
// ground under or LOOK_AHEAD_M ahead, flown after a ghost that travels the
// end line at LOITER_PACE of the cruise and reaches the point on time,
// wheeling round when early, and eased onto the ghost over the leg's last
// EASE_S; `land`
// glides the last LAND_M at LAND_MPS onto the floor and walks the last step. A flight is legs for FLIGHT_S of air time -- to
// `explore` when the plan rolls the dragon fed, to `patrol` when hungry --
// and, exploring, VISIT_P of the aims that are dry, under SPOT_SLOPE_DEG and
// SPOT_AWAY nest radii from home become a landing and a PERCH_S perch; then
// the leg home and the landing on the nest. Inside a phrase the body is
// integrated at TICK_HZ on absolute ticks of world time, its noise from the
// phrase's own PRNG, and the frame draws between the last two ticks. A dragon
// born mid-phrase is placed at the phrase's start pose and replays, at most
// CATCH_UP_TICKS a frame.
//
// A HUNGRY FLIGHT HUNTS. The plan rolls one stag from the wildlife's roster
// within HUNT_M of the nest (Wildlife.roster, pure), patrols while the hunt
// and the way home still fit the budget, then flies a `hunt` leg at HUNT_MPS
// to STOOP_AGL over where the stag's own free plan has it at the leg's end
// (Wildlife.poseAt, closed form, the leg resized to the moved stag thrice),
// and a `stoop` dives at DIVE_MPS onto the stag's pose at the stoop's end,
// STRIKE_AGL over it; the `return` leg home carries the kill and the rest on
// the nest is the meal. The stoop's end is THE STRIKE: the wildlife plans the
// stag's chapter by asking every dragon within reach (strikeOn) and cuts the
// stag's plan there, dead to its chapter's end, so a stag and the dragon that
// takes it are one closed-form fact on every client, and the kill in the
// talons is that stag's own slot (Wildlife.kill) while its chapter runs.
//
// A KILL ON THE NEST IS A MEAL. Landing with cargo, the kill is laid at a
// FIXED spot EAT_REACH ahead of the dragon's own spot on the nest, the dragon
// walks a circuit, then round behind its spot and up to it, and `eat`s -- the
// eat clip plunging the head EAT_REACH ahead of the body, which is where the
// kill lies -- for EAT_S, at the end of which the carcass is dropped to fade.
//
// A FISH IN HER HAND IS ITS: the one thing that takes a dragon off its score.
// A grounded dragon with a `fish` lure within LURE drops whatever it has and
// goes LIVE to `menace`: off the nest onto the height field after the hand,
// turning at WALK_TURN_RATE, stopped with its head at her -- EAT_REACH ahead
// of the body, plus MENACE -- where it plays the eat clip at her, and after
// her again once she is MENACE further off, at the walk gait, or the run
// once the hand is MENACE_RUN past its head: it stomps after her in rushes.
// It does her no harm; the ear (audio/ambience.js) roars it. Every client runs
// the same rule against the same relayed hands; the lurer's client is the
// authority and publishes an anchor (pending()) every ANCHOR_S, applied
// elsewhere as a nudge over CORRECT_S. The fish put away or LURE_FORGET
// off, the lure ends: the authority publishes a `rejoin` anchor, and from its
// pose and time every client builds the same REJOIN -- a leg home, a landing,
// and a rest until the next planned rest on the nest -- after which the dragon
// is on its score again with nothing more sent. A client that meets a peer's
// live anchor before it sees the hand stands alert at the anchor until one or
// the other arrives; an anchor older than ANCHOR_STALE_S with no hand in sight
// ends the lure here.
//
// IT CHASES HER, AND STRIDERS, live the same way (`aggro`). Resting, it spots
// her near; flying, it may eye her in the open or a strider, swoop a circle
// and land with a thud. Down, it turns on its quarry, charges, chomps, growls
// and goes again, a bite on her hurting her (harm) and one on a strider
// sending it bolting (fright); her body dead, it feeds on it, chomping on
// without a growl or a glance at a strider, until the quarry is too far off and it flies
// home on a rejoin. The quarry's client steers it and anchors every
// AGGRO_ANCHOR_S and each phase; peers trail the anchors. Numbers: SPOT_M on.
//
// IT TURNS, PITCHES AND BANKS, none of them faster than a rate: heading closes
// on the bearing at TURN_RATE, pitch on the climb angle at PITCH_RATE, and roll
// leans into the turn by BANK of the swing. A cruise meanders: the bearing and
// the climb the body closes on are each swung by a slow sine of world time
// and the dragon's phase, so a leg swoops and yaws, banking into every swing;
// only a landing flies true. The body's frame is the wildlife's -- +X forward,
// yawed about the world up -- with pitch about the body's Z and roll about its
// X composed after, so a dragon on a card and a dragon on a mesh are the same
// matrix.
//
// EVERY RESIDENT DRAGON IS STEPPED, in or out of sight. What the ladder gates
// is the DRAWING, on the creatures' rungs (critters.js critterTier) sized by
// the FLYING body's largest extent: four skinned tiers through a puppet
// (render/puppet.js), then the card rung, then nothing.
//
// THE CARD IS TWO QUADS FIXED IN THE BODY'S FRAME, not one quad spun to her: a
// side view and a top view, crossed, carrying the full instance matrix -- yaw,
// pitch, roll. A dragon seen from below is a wingspan and from beside it a
// neck and a tail, and which of those she sees is exactly what a spun card
// cannot say. The two pictures are photographed from the FLY pose (bakeCards),
// and the quads bounded by that same pose measured on the CPU, so the card and
// the mesh it dissolves against are the same wingspan.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { clamp, lerp, mulberry32 } from '../../sim/mathx.js'
import {
  CATCH_UP_TICKS, CHAPTER_S, EASE_S, TICK_S, Score, chapterOf, easeWeight, hash32, keyHash, phraseRand, stepTo, swing, tickAfter, tickOf,
} from '../../sim/score.js'
import {
  CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, bakeCritterCard, createCritterCardMaterial, critterTier, makeCardFadeAttribute,
  setCritterCard, tileSeed,
} from './critters.js'
import { stepLodFade, Puppet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'
import { makePuppet, puppetMode, solverStub, tintRange } from './baked-puppet.js'
import { TailLag } from './tail-lag.js'
import { TILE as ROOST_TILE } from './roosts.js'

/** The room's key for a dragon of a roost: its tile, which is where the roost is a pure function of, and `:g` for the guard (creature-net.js routes the `dr` prefix here). */
export const keyOf = (site, guard = false) => `dr:${site.tx},${site.tz}${guard ? ':g' : ''}`
const KEY_RE = /^dr:(-?\d+),(-?\d+)(:g)?$/

export const CLIPS = ['idle', 'alert', 'walk', 'run', 'sit', 'lie', 'fly', 'eat']
const ONE_SHOT = new Set(['sit', 'lie'])
// The two pictures of a far dragon, and the order they sit in the texture.
export const DRAGON_VIEWS = ['side', 'top']

// Dragons at once, and puppets. A roost is one to a summit's territory, so the
// sites resident round her number a handful, two dragons each; the puppets are
// for the ones in MESH range, which is a pair or two.
export const MAX = 24
export const PUPPETS = 6
// How far either side of the shipped size a dragon rolls.
export const SIZE_VARY = 0.15
// The colours a dragon rolls: linear RGB multipliers on the shipped olive texture, walked end to end (tintRange) -- purple, blue, sky, green, grey, brown, red, orange -- each pushed this far from its grey for the guard and pulled toward it for the male.
export const DRAGON_HUES = [[1.2, 0.45, 1.45], [0.4, 0.65, 1.95], [0.5, 1.05, 1.55], [0.6, 1.6, 0.65], [0.95, 0.95, 1.1], [1.3, 0.95, 0.65], [1.95, 0.55, 0.45], [1.8, 1, 0.3]]
export const GUARD_VIVID = 1.35
export const MALE_VIVID = 0.85
const rollHue = tintRange(DRAGON_HUES)
// The scales' roughness: a rough gleam at half the sun's lobe (puppet.js gloss), broader and duller than the egg's shell.
export const SCALE_ROUGHNESS = 0.5

// Flight, in metres and seconds.
export const PATROL_MPS = 12
export const HUNT_MPS = 16
export const DIVE_MPS = 22
export const LAND_MPS = 5
export const ACCEL = 4
export const TURN_RATE = 0.6
export const LAND_TURN_RATE = 1.5
export const PITCH_MAX = 0.5
export const DIVE_PITCH = 1.1
export const PITCH_RATE = 0.8
export const BANK = 0.7
export const ROLL_RATE = 1.2
// The cruise's meander: how far the bearing swings, and the climb angle, in radians, the seconds each swing takes, and the height over the cruise floor the downward swoop fades out across.
export const CAREEN = 0.4
export const CAREEN_S = 5
export const SWOOP = 0.3
export const SWOOP_S = 8
export const SWOOP_ROOM = 10
// How far from home a leg's aim may be, how high above the ground under the aim it is set, and the least clearance over the ground under or ahead of the body on a cruise.
export const PATROL_M = 300
export const CRUISE_AGL = [40, 80]
export const MIN_AGL = 15
export const LOOK_AHEAD_M = 40
// How far from the nest a stag may be to be hunted; how far short of the stag and how high over it the hunt leg ends and the stoop begins, so the stoop is a dive and not a drop; how high over it the stoop ends (the talons at its back); and the seconds the stoop is given past its dive.
export const HUNT_M = 250
export const STOOP_M = 40
export const STOOP_AGL = 25
export const STRIKE_AGL = 2
export const STOOP_PAD_S = 1
// A landing: the leg before it ends this far short of the floor's centre and this high over it, the glide hands over to the settle this near its touchdown, and the touchdown itself is this fraction of that short of the centre so the rest walks the last of it.
export const LAND_M = 30
export const RETURN_AGL = 30
export const LAND_SNAP_M = 3
export const TOUCHDOWN = 0.8
// A stoop's clock: the dived path over the straight line, plus seconds; a landing's pad likewise.
export const FLIGHT_SLACK = 1.15
export const LAND_PAD_S = 4
// A leg is flown after its ghost (_ghost): the ghost's pace as a fraction of the cruise, which the leg ends at; the slowest the body flies to fall back onto it; how far ahead of it the body wheels round to come at it again; how far past it along the end line the body steers; and how hard the pace closes the gap (per second).
export const LOITER_PACE = 0.9
export const SLOW_PACE = 0.5
export const SPRINT_PACE = 1.3
export const LOITER_M = 10
export const LEAD_M = 30
export const PACE_GAIN = 0.3
// The shortest leg: one nearer its start than this has no room to come round onto its end line.
export const MIN_LEG_M = 80
// How long before a rest's end the body starts walking back to its centre; the fastest the ease may pull the body and its heading onto a phrase's end, over what the flight itself does.
export const HOMING_PAD_S = 4
export const EASE_MPS = 8
export const EASE_TURN = 1
// The least a flight is given, in seconds of air time: a chapter with less left rests it out.
export const FLIGHT_MIN_S = 60
// How likely a chapter's flight is a hungry one (a patrol) rather than a fed one (an explore); how long a dragon rests on the nest between flights; how long a flight lasts in the air, not counting time perched; how long a visited spot holds it; how long it eats. A dragon lives in the air: the flights are long and the rests between them short, so one seen on its nest is soon seen off it.
export const HUNGRY_P = 0.5
export const REST_S = [20, 60]
// The least a rest with a kill on the nest is given: the circuit, the approach and EAT_S of eating fit in it, since a meal is never cut short and a dragon may not take off with the kill uneaten.
export const MEAL_S = 90
export const FLIGHT_S = [120, 300]
export const PERCH_S = [20, 60]
export const EAT_S = [15, 30]
// The rest steps: how long an idle, a sit or a lie is held, how long a walk may run before it gives up on its point, and how likely a step is each kind, in the order idle, alert, walk, sit, lie.
export const IDLE_S = [3, 8]
export const SIT_S = [8, 20]
export const WALK_S = 20
export const REST_ODDS = [0.3, 0.2, 0.3, 0.1, 0.1]
// Walking: how fast the heading swings, how fast the ground gaits gather and shed speed (body units per s², so every size takes the same time to its gait and ACCEL stays the flight's), how near a point counts as reached (body units, past a walk's braking distance), the ring the walk goes round as a fraction of the floor's radius and the angle each walk step goes round it, and how far behind its eating stance a dragon lines up so it arrives facing the kill (body units).
export const WALK_TURN_RATE = 1.5
export const STRIDE_ACCEL = 3.2
export const WAY = 0.5
export const WALK_RING = 0.6
export const WALK_STEP = 1.3
export const APPROACH = 1.2
// How often an aim on an explore becomes a visit, the steepest ground a dragon will alight on, and how many nest radii from home a spot must be to count as away.
export const VISIT_P = 0.5
export const SPOT_SLOPE_DEG = 30
export const SPOT_AWAY = 3
// Ticks between ground probes in the air.
export const PROBE_EVERY = 2
// Clip cross-fade.
const FADE_S = 0.35
// How far either side of the floor's centre the pair stand abreast, as a fraction of the floor's radius: a fen dragon is half as wide as it is long, so two 9 m bodies need about 5 m between their centres.
const NEST_PAIR = 0.75
// How far ahead of the body's origin, in body units, the eat clip's snout plunges: measured on the shipped fen dragon at the bite, the snout's vertices lie 1.84 to 2.45 forward with the ground under them, so a kill this far ahead is what the head goes into.
export const EAT_REACH = 2.1

// The lure's distances, in body units like EAT_REACH: noticed within LURE, forgotten past LURE_FORGET, MENACE the slack either side of the head at the hand, MENACE_RUN past it the run.
export const LURES = ['fish']
export const LURE = 4
export const LURE_FORGET = 9.5
export const MENACE = 0.8
export const MENACE_RUN = 2.4
// Seconds between a live dragon's anchors from its authority; how long a peer's anchor speaks for a dragon whose hand this client cannot see; how long a peer's anchor takes to pull the body here onto it.
export const ANCHOR_S = 1
export const ANCHOR_STALE_S = 3
export const CORRECT_S = 1
const NO_LURES = []
const PAIR = [true, false]

// Aggression, in metres and seconds, every distance across the ground: a grounded dragon spots her within SPOT_M; a flying one eyes her in the open, or a strider, within EYE_M at EYE_P or STRIDER_P an encounter, circles CIRCLE_M round where it saw the quarry CIRCLE_AGL over it (one turn, at most CIRCLE_S), and lands LAND_SHORT short of it (at most AGGRO_LAND_S). Down, it stands SPOT_S facing the quarry, charges at CHARGE_MPS, chomps with its snout (EAT_REACH ahead) within BITE_M, the bite BITE_AT_S into the CHOMP_S chomp hurting BITE_HP within HURT_M, growls GROWL_S, and gives up past GIVE_UP_M, eyeing nobody for SPURN_S. A chase after her turns on any strider within SPOT_M.
export const SPOT_M = 20
export const EYE_M = 50
export const EYE_P = 0.5
export const STRIDER_P = 0.25
export const CIRCLE_M = 30
export const CIRCLE_AGL = 20
export const CIRCLE_S = 25
export const LAND_SHORT = 15
export const AGGRO_LAND_S = 20
export const SPOT_S = 1.2
export const CHARGE_MPS = 4
export const BITE_M = 5
export const HURT_M = 6
export const BITE_HP = 30
export const BITE_AT_S = 0.7
export const CHOMP_S = 1.4
export const GROWL_S = 1
export const GIVE_UP_M = 50
export const SPURN_S = 30
// Seconds between an aggro dragon's anchors: it turns and charges faster than a menace stomps.
export const AGGRO_ANCHOR_S = 0.5
export const HER = 'her'
const AGGRO_CLIP = { swoop: 'fly', land: 'fly', spot: 'alert', charge: 'walk', chomp: 'eat', growl: 'alert' }
const NO_QUARRY = { her: null, striders: [] }

const roll = (rand, [lo, hi]) => lerp(lo, hi, rand())
// The heading that carries the body from a to b: +X forward, a positive heading toward -Z.
const bearing = (a, b) => Math.atan2(-(b.z - a.z), b.x - a.x)
// What a turn of `a` radians flown on an arc costs over flying its chord, in radians of turn.
const turnLag = (a) => Math.abs(a) - 2 * Math.sin(Math.abs(a) / 2)
const gap3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
// `cur` pulled toward `want` by the fraction `w`, no further than `cap` in one go.
const pull = (cur, want, w, cap) => cur + clamp((want - cur) * w, -cap, cap)
// Into (_gx, _gz): where phrase `ph` has the body `elapsed` seconds in. A leg's end is a ghost on the line through it along its heading, at its speed, reaching it on the phrase's end; any other phrase's is its end point. Easing a leg onto a fixed point would hold a flying body still in the air.
let _gx = 0
let _gz = 0
function _ghost(ph, elapsed) {
  const to = ph.to
  const back = ph.kind === 'fly' ? to.speed * Math.max(0, ph.dur - elapsed) : 0
  _gx = to.x - Math.cos(to.heading) * back
  _gz = to.z + Math.sin(to.heading) * back
}

const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
// The drawn heading and pitch _pose last wrote, for the tail's lag.
let _heading = 0
let _pitch = 0
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _cargoPos = new THREE.Vector3()
const _cargoQuat = new THREE.Quaternion()
const _cargoMat = new THREE.Matrix4()
const _tilt = new THREE.Quaternion()
const _v = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const WHITE = new THREE.Color(1, 1, 1)

/** The shipped wyvern GLB (tools/creatures/ship-wyvern.mjs), its `wyvern` extras spread over the asset: sizeM, span, width, height, gait. */
export async function loadWyvernGlb(url) {
  const asset = await loadSkinnedAsset(url, { tiers: LOD_RUNGS, clips: CLIPS, extras: 'wyvern' })
  if (!(asset.extras.span > 0) || !(asset.extras.sizeM > 0)) throw new Error(`${url}: no turned span or sizeM in its extras -- re-ship it`)
  return { ...asset, ...asset.extras }
}

/** A puppet posed at `t` seconds into `fly`, its bones composed and its skeleton's bone matrices current, so its vertices can be read. */
function poseFly(p, t) {
  p.show(0)
  p.play('fly')
  p.step(0)
  p.actions.get('fly').time = t
  p.mixer.update(0)
  for (const b of p.bones) b.updateMatrix()
  p.rig.updateMatrixWorld(true)
  THREE.Skeleton.prototype.update.call(p.skeleton)
}

/**
 * The flying body's box in the unit frame, from tier 0 skinned on the CPU at
 * four points of the `fly` clip: `halfX` and `halfZ` its largest reach either
 * side of the origin, `minY` and `maxY` its lowest and highest point,
 * `spreadAt` the clip time its wings reach widest, for the photograph, and
 * `talons` where the feet hang -- the centroid of the vertices the shipped
 * legs' foot joints carry, which is where a kill is held. The shipper's
 * extents are of the STANDING body, and a stood dragon's wings are folded and
 * its feet on the ground; the ladder, the card and the cargo want the body in
 * the air.
 */
export function measureFly(asset) {
  if (!asset.legs?.length) throw new Error('Dragons: the asset names no legs, so there are no talons to hang a kill from -- re-ship the GLB')
  const flat = new THREE.MeshBasicMaterial()
  const p = new Puppet(asset, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, { clipFade: FADE_S, oneShot: ONE_SHOT })
  const dur = asset.clips.find((c) => c.name === 'fly').duration
  const mesh = p.meshes[0]
  const position = mesh.geometry.getAttribute('position')
  const skinIndex = mesh.geometry.getAttribute('skinIndex')
  const skinWeight = mesh.geometry.getAttribute('skinWeight')
  const n = position.count
  // The vertices a foot joint carries most of: the four skin slots, the heaviest wins.
  const feet = new Set(asset.legs.map((l) => {
    const j = p.skeleton.bones.findIndex((b) => b.name === l.chain[l.chain.length - 1])
    if (j < 0) throw new Error(`Dragons: leg ${l.id} ends on joint ${l.chain[l.chain.length - 1]}, which the skeleton does not carry`)
    return j
  }))
  const footVerts = []
  for (let i = 0; i < n; i++) {
    let best = 0, w = -1
    for (let k = 0; k < 4; k++) if (skinWeight.getComponent(i, k) > w) { w = skinWeight.getComponent(i, k); best = skinIndex.getComponent(i, k) }
    if (feet.has(best)) footVerts.push(i)
  }
  if (footVerts.length === 0) throw new Error('Dragons: no vertex is skinned to a foot joint -- the legs in the extras do not match the skin')
  let halfX = 0, halfZ = 0, minY = Infinity, maxY = -Infinity, spreadAt = 0, spread = -1
  const talons = new THREE.Vector3()
  for (const f of [0, 0.25, 0.5, 0.75]) {
    poseFly(p, f * dur)
    let hz = 0
    for (let i = 0; i < n; i++) {
      mesh.applyBoneTransform(i, _v.fromBufferAttribute(position, i))
      halfX = Math.max(halfX, Math.abs(_v.x))
      hz = Math.max(hz, Math.abs(_v.z))
      minY = Math.min(minY, _v.y)
      maxY = Math.max(maxY, _v.y)
    }
    for (const i of footVerts) talons.add(mesh.applyBoneTransform(i, _v.fromBufferAttribute(position, i)))
    halfZ = Math.max(halfZ, hz)
    if (hz > spread) { spread = hz; spreadAt = f * dur }
  }
  talons.divideScalar(4 * footVerts.length)
  p.release()
  p.skeleton.dispose()
  flat.dispose()
  if (!(halfX > 0) || !(halfZ > 0) || !(maxY > minY)) throw new Error('Dragons: the fly pose has no extent -- re-ship the GLB')
  return { halfX, halfZ, minY, maxY, spreadAt, talons }
}

export class Dragons {
  /**
   * @param field     V2Height: heightAt, the ground the flight keeps clear of
   * @param ground    what they stand and land on, stone included (walk.js's WalkSurface): heightAt; the field when omitted
   * @param roosts    Roosts: sites(), siteAt(tx, tz)
   * @param wildlife  Wildlife: roster, spawnAt, poseAt, kill, carry, drop; its `hunter` is set here (strikeOn)
   */
  constructor(scene, field, { seed = 1, ground = field, roosts, wildlife, water, harm, fright, asset = null } = {}) {
    if (!field || typeof field.heightAt !== 'function' || typeof field.heightAndSlopeAt !== 'function') throw new Error('Dragons needs a height field with heightAt and heightAndSlopeAt')
    if (!ground || typeof ground.heightAt !== 'function') throw new Error('Dragons needs a ground with heightAt')
    if (!roosts || typeof roosts.sites !== 'function' || typeof roosts.siteAt !== 'function') throw new Error('Dragons needs the Roosts, for sites and siteAt')
    if (!wildlife || ['roster', 'spawnAt', 'poseAt', 'kill', 'carry', 'drop'].some((f) => typeof wildlife[f] !== 'function')) {
      throw new Error('Dragons needs the Wildlife, for roster, spawnAt, poseAt, kill, carry and drop')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Dragons needs the WaterSurfaces, for isSubmerged, so no dragon alights in a lake')
    if (typeof harm !== 'function' || typeof fright !== 'function') throw new Error('Dragons needs harm(n, why) for a bite on her and fright(key, x, z) for one on a strider')
    this.harm = harm
    this.fright = fright
    // Whether an encounter is eyed: a field so a gate can load the dice. Rolled on the quarry's own client only, which then owes the room the chase.
    this.random = Math.random
    this.quarry = NO_QUARRY
    this.field = field
    this.ground = ground
    this.roosts = roosts
    this.wildlife = wildlife
    this.water = water
    this.seed = seed
    // The score: `plan` is a field so a gate can put a chapter of its own under a dragon. Three chapters kept a key: a stag's window (strikeOn) can straddle two of a dragon's, and the one playing must not churn.
    this.plan = (key, chapter, rand) => this._plan(key, chapter, rand)
    this.score = new Score((key, chapter, rand) => this.plan(key, chapter, rand), { keep: 3 })
    wildlife.hunter = (key, t0, t1) => this.strikeOn(key, t0, t1)
    // key -> the latest anchor heard for it, live or rejoin (apply); read when its dragon is born.
    this.anchored = new Map()
    // Anchors this client owes the room (pending).
    this.outbox = []

    this.batch = new THREE.Group()
    this.batch.name = 'v2-dragons'
    scene.add(this.batch)
    // Every material the world's lighting patches: one settled, a fade pair a puppet, and the card's. The body gleams (puppet.js gloss); the card, a photograph of it, does not.
    this.plain = makeSettledMaterial('dragons', { gloss: SCALE_ROUGHNESS })
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('dragons', this.plain, { gloss: SCALE_ROUGHNESS })
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    // Fixed in the body's frame, not spun: the instance matrix is the whole orientation.
    this.cardMaterial = createCritterCardMaterial('dragons', { billboard: false, fade: true, hue: false })
    this.materials.push(this.cardMaterial)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        // `site` is this dragon's own half of the roost's floor (_born); `tint` the colour it wears.
        id: i, site: null, key: null, guard: false, tint: new THREE.Color(), seen: 0,
        // The pose at the last tick, and at the tick before it, which the frame draws between.
        x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0,
        px: 0, py: 0, pz: 0, pheading: 0, ppitch: 0, proll: 0,
        // `at` is the tick of the last frame that stepped it: the gauge of a clock skip, where `tick` also lags through a join's replay.
        rec: { tick: 0, alpha: 1, at: 0 },
        // The home pose the chapters turn at, and this dragon's phase in the meander, so no two swing together.
        home: null, phase: 0,
        // The ground under the body and under the point LOOK_AHEAD_M ahead of it, as last probed.
        ground: 0, ahead: 0,
        // The phrase playing, its start in world seconds and the tick the next is entered on, its index and chapter, and its PRNG; the rejoin chain when one is under way; the live record while a lure has it.
        state: 'roost', phrase: null, phraseStart: 0, phraseEnd: 0, phraseEndTick: 0, phraseIndex: 0, chapter: 0, rand: null, rejoin: null, live: null,
        // The ground it is on or landing on -- its nest site, or a visited spot -- the rest steps queued on it, the step under way, where that step walks to and faces, whether the rest is walking back to its centre for the end, whether a landing has handed over to the settle; the kill's fixed place on the nest floor, off its centre.
        dest: null, queue: [], rest: 'idle', wayU: 0, wayV: 0, face: null, homing: false, down: false, cargoU: 0, cargoV: 0, cargoYaw: 0,
        cargo: null,
        // The hands.js lure it is stomping after; the quarry ids eyed this encounter (_eye), each to the tick it was last in sight; the world time it may eye again.
        lure: null, eyed: new Map(), spurned: 0,
        // The clip playing, its playback rate, how long the rest step holds it, and one cycle of it in seconds, for the ear's clocks; `cue` counts steps, as the wildlife's does; the ear's cues for an aggro dragon's roar, its thud down and its growl.
        clip: 'idle', rate: 1, cue: 0, left: 0, cycle: 0, roarCue: 0, thudCue: 0, growlCue: 0,
        size: 1, k: 1, lodSize: 1,
        lod: CARD_RUNGS, puppet: null, cardWant: false, cardP: 1,
      })
    }
    this.free = this.slots.slice()
    this.byKey = new Map()
    this._sites = []
    this.puppets = []
    this.freePuppets = []
    this.fading = []
    this.lures = NO_LURES
    this.cardMesh = null
    this.cardFade = null
    this.cardN = 0
    this.frame = 0
    this.last = null
    this.loaded = false
    // Sites with no free slot; dragon-frames in mesh range with no free puppet; ticks replayed this frame; dragons still catching up after it.
    this.overflow = 0
    this.starved = 0
    this.replayed = 0
    this.behind = 0

    if (asset) {
      this.setAsset(asset)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadWyvernGlb(CRITTER_GLB.dragon))
    return true
  }

  setAsset(asset) {
    if (!(asset.span > 0) || !(asset.sizeM > 0)) throw new Error('Dragons.setAsset: the asset has no span or sizeM -- re-ship it')
    this.asset = asset
    this.fly = measureFly(asset)
    // The ladder's rungs are a ratio of the body's LARGEST extent (critters.js), and `size` is its length: for a dragon in the air that is the wingspan, and `bulk` says by how much.
    this.bulk = Math.max(2 * this.fly.halfX, 2 * this.fly.halfZ, this.fly.maxY - this.fly.minY) / asset.span
    this.durations = Object.fromEntries(asset.clips.map((c) => [c.name, c.duration]))
    this.plain.map = asset.map
    this.plain.needsUpdate = true
    for (const mats of this.puppetMats) {
      for (const m of [mats.in, mats.out]) {
        m.map = asset.map
        m.needsUpdate = true
      }
      const p = makePuppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT })
      p.solver = p.baked ? solverStub() : new TailLag(p.bones, asset.tail)
      this.puppets.push(p)
    }
    this.freePuppets = this.puppets.slice()

    // The card's two quads, in the unit frame the puppet's meshes are in and
    // bounded by the fly pose, dropped to where that pose actually hangs (a
    // flying body's lowest point is not its feet on the ground).
    const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.cardMaterial, MAX)
    mesh.name = 'v2-dragons-cards'
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    mesh.count = 0
    mesh.visible = false
    setCritterCard(mesh, this._cardBounds(), DRAGON_VIEWS)
    mesh.geometry.translate(0, this.fly.minY, 0)
    this.cardFade = makeCardFadeAttribute(mesh, MAX)
    // The card wears the dragon's colour only where the mesh it hands over to does: a skinned puppet is left white (baked-puppet.js tintFor).
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage)
    this.tinted = puppetMode() === 'baked'
    this.cardMesh = mesh
    this.batch.add(mesh)
    this.loaded = true
  }

  _cardBounds() {
    return { halfX: this.fly.halfX, halfZ: this.fly.halfZ, height: this.fly.maxY - this.fly.minY }
  }

  /** Photograph the body at the widest frame of `fly` for the card's two views, lifted so its lowest point sits on the picture's floor as the quads expect. */
  bakeCards(renderer) {
    if (!this.loaded) throw new Error('Dragons.bakeCards: the GLB has not landed')
    const asset = this.asset
    const flat = new THREE.MeshBasicMaterial({ map: asset.map, toneMapped: false })
    const p = new Puppet(asset, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, { clipFade: FADE_S, oneShot: ONE_SHOT })
    p.group.matrix.makeTranslation(0, -this.fly.minY, 0)
    poseFly(p, this.fly.spreadAt)
    this.cardMaterial.map = bakeCritterCard(renderer, p.group, asset.map, this._cardBounds(), DRAGON_VIEWS)
    this.cardMaterial.needsUpdate = true
    this.cardMesh.visible = true
    p.release()
    p.skeleton.dispose()
    flat.dispose()
  }

  // -------------------------------------------------------------------------
  // Slots.
  // -------------------------------------------------------------------------

  /**
   * A dragon of a roost, the guard or the male, from the roost's own seed so the same nest holds the same pair every visit and on every client: its own
   * half of the floor (the site moved NEST_PAIR of its radius square to the heading the pair share, the guard to one side and the male the other), its
   * size as a multiple of the species', the home pose its chapters turn at and its phase in the meander. Needs no GLB: the wildlife plans a stag's chapter through
   * strikeOn before the dragon's body has landed.
   */
  _born(site, guard) {
    if (!Number.isFinite(site.gx + site.gz)) throw new Error(`Dragons: roost ${keyOf(site)} carries no floor plane (gx, gz)`)
    const heading = mulberry32(tileSeed(site.key, 0x5c, this.seed))() * Math.PI * 2
    const o = (guard ? -NEST_PAIR : NEST_PAIR) * site.r, u = Math.sin(heading) * o, v = Math.cos(heading) * o
    const nest = { ...site, x: site.x + u, y: site.y + site.gx * u + site.gz * v, z: site.z + v }
    const rand = mulberry32(tileSeed(site.key, guard ? 0x5e : 0x5d, this.seed))
    const scale = 1 + SIZE_VARY * (2 * rand() - 1)
    const home = { x: nest.x, y: nest.y, z: nest.z, heading, speed: 0 }
    return { site: nest, scale, home, phase: rand() * Math.PI * 2 }
  }

  /** The site, home and side of the dragon keyed `key`, born or not: the live dragon's, else the roost's tile asked of the Roosts, which answers past the resident radius. */
  _whoOf(key) {
    const d = this.byKey.get(key)
    if (d) return { site: d.site, home: d.home, guard: d.guard }
    const m = KEY_RE.exec(key)
    if (!m) throw new Error(`Dragons: no dragon is keyed ${key}`)
    const site = this.roosts.siteAt(Number(m[1]), Number(m[2]))
    if (!site) throw new Error(`Dragons: no roost on tile ${m[1]},${m[2]} for ${key}`)
    const guard = m[3] !== undefined
    const born = this._born(site, guard)
    return { site: born.site, home: born.home, guard }
  }

  /** A dragon born to its roost at world time `now`, placed where its score (or the room's anchor for it) has it. */
  _spawn(site, guard, now) {
    const d = this.free.pop()
    if (!d) { this.overflow++; return null }
    const born = this._born(site, guard)
    d.site = born.site
    d.guard = guard
    d.key = keyOf(site, guard)
    rollHue(mulberry32(hash32(keyHash(d.key), 0x71a7)), d.tint)
    const grey = (d.tint.r + d.tint.g + d.tint.b) / 3, vivid = guard ? GUARD_VIVID : MALE_VIVID
    d.tint.setRGB(...[d.tint.r, d.tint.g, d.tint.b].map((c) => Math.max(0.05, grey + (c - grey) * vivid)))
    d.size = this.asset.sizeM * born.scale
    d.k = d.size / this.asset.span
    d.lodSize = d.size * this.bulk
    d.home = born.home
    d.phase = born.phase
    d.lod = CARD_RUNGS
    d.puppet = null
    d.cardWant = false
    d.cardP = 1
    d.dest = d.site
    this.byKey.set(d.key, d)
    this._replace(d, now)
    return d
  }

  /** The dragon placed afresh at `now`: where the room's anchor has it when there is one from this chapter, else on its score. Birth, and a body too long unstepped to replay (a clock skip): its kill let go where it lies, its lure and rejoin forgotten. */
  _replace(d, now) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    d.lure = d.live = d.rejoin = null
    d.queue.length = 0
    d.rec.at = tickOf(now)
    const anchor = this.anchored.get(d.key)
    if (anchor && anchor[1] >= chapterOf(now, d.key).start) {
      this._fromAnchor(d, anchor, now)
    } else {
      // At the phrase's start pose, stepping from the tick before the one the phrase is entered on, as a dragon that played the phrase before did.
      const at = this._phraseAt(d, now)
      this._place(d, at.phrase.from)
      d.rec.tick = tickAfter(at.start) - 1
      this._enter(d, at, now)
    }
  }

  /** The body put at a pose -- level, at the pose's speed -- the tick before it the same. */
  _place(d, pose) {
    if (!Number.isFinite(pose.speed)) throw new Error('Dragons: a pose with no speed')
    d.x = d.px = pose.x
    d.y = d.py = pose.y
    d.z = d.pz = pose.z
    d.heading = d.pheading = pose.heading
    d.speed = pose.speed
    d.pitch = d.roll = d.ppitch = d.proll = 0
  }

  /** The floor's height at (dest.x + u, dest.z + v): a nest's is the plane the roost is laid on (roosts.js sites), a spot's is the ground itself. */
  _floorAt(dest, u, v) {
    return dest.turf ? this.ground.heightAt(dest.x + u, dest.z + v) : dest.y + dest.gx * u + dest.gz * v
  }

  /** A dragon whose roost is gone: its cargo let go and its body left to dissolve where it is. */
  _retire(d) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    if (d.puppet) {
      d.puppet.show(-1)
      this.fading.push(d.puppet)
      d.puppet = null
    }
    this.byKey.delete(d.key)
    this.score.forget(d.key)
    d.site = null
    d.live = d.rejoin = null
    this.free.push(d)
  }

  /** Every dragon gone at once, nothing fading: the ground has been rebuilt under them. Boot, and a relief edit. The room's anchors are kept: a dragon born again is born where they say. */
  place() {
    for (const d of this.byKey.values()) {
      if (d.cargo) { this.wildlife.drop(d.cargo, false); d.cargo = null }
      this._releasePuppet(d)
      this.score.forget(d.key)
      d.site = null
      d.live = d.rejoin = null
      this.free.push(d)
    }
    this.byKey.clear()
    for (const p of this.fading) this._park(p)
    this.fading.length = 0
    this.overflow = 0
    if (this.cardMesh) { this.cardN = 0; this.cardMesh.count = 0 }
  }

  _takePuppet(d) {
    if (!d.puppet) {
      const p = this.freePuppets.pop()
      if (!p) { this.starved++; return null }
      d.puppet = p
      if (p.baked) p.tint.copy(d.tint)
      this.batch.add(p.group)
      p.play(d.clip, d.cue)
    }
    return d.puppet
  }

  _park(p) {
    p.release()
    this.batch.remove(p.group)
    this.freePuppets.push(p)
  }

  _releasePuppet(d) {
    if (!d.puppet) return
    this._park(d.puppet)
    d.puppet = null
  }

  // -------------------------------------------------------------------------
  // The plan: a chapter of phrases, every duration and end pose closed-form.
  // -------------------------------------------------------------------------

  /** The ground at (x, z) as a spot to alight on, or null: under SPOT_SLOPE_DEG, dry, and SPOT_AWAY nest radii from home. */
  _spotAt(site, x, z) {
    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    if (tan > Math.tan((SPOT_SLOPE_DEG * Math.PI) / 180)) return null
    if (this.water.isSubmerged(x, z, h)) return null
    if (Math.hypot(x - site.x, z - site.z) < SPOT_AWAY * site.r) return null
    return { x, y: h, z, r: site.r, gx: 0, gz: 0, turf: true }
  }

  /** Seconds a leg from pose `a` to pose `b` at `mps` is given: the line at the ghost's pace, the climb or descent at the steepest cruise, and what the turns onto the line and onto the end heading cost over flying straight. */
  _legTime(a, b, mps) {
    const h = bearing(a, b)
    return Math.hypot(b.x - a.x, b.z - a.z) / (mps * LOITER_PACE) + Math.abs(b.y - a.y) / (mps * Math.sin(PITCH_MAX)) + (turnLag(swing(a.heading, h)) + turnLag(swing(h, b.heading))) / TURN_RATE
  }

  /** Where a leg that lands on `dest` ends: LAND_M short of its centre along the approach heading `h`, RETURN_AGL over it, at `mps`. */
  _approach(dest, h, mps) {
    return { x: dest.x - Math.cos(h) * LAND_M, y: dest.y + RETURN_AGL, z: dest.z + Math.sin(h) * LAND_M, heading: h, speed: mps * LOITER_PACE }
  }

  /** The landing on `dest` from the approach pose `from`: the glide to a touchdown short of the centre along the approach, on the floor there, stopped. */
  _landPhrase(dest, from) {
    const s = TOUCHDOWN * LAND_SNAP_M
    const u = -Math.cos(from.heading) * s, v = Math.sin(from.heading) * s
    const to = { x: dest.x + u, y: this._floorAt(dest, u, v), z: dest.z + v, heading: from.heading, speed: 0 }
    return { kind: 'land', dur: gap3(from, to) / (LAND_MPS * Math.sin(DIVE_PITCH)) + LAND_PAD_S, from, to, dest }
  }

  /** A rest on `at` from pose `from` for `dur`, ending at the floor's centre facing a rolled way; with a `kill` (`{ prey, struck }`, the stag and the world time it was taken) it is the meal. */
  _restPhrase(at, from, dur, rand, kill = null) {
    return { kind: 'rest', dur, from, to: { x: at.x, y: this._floorAt(at, 0, 0), z: at.z, heading: rand() * Math.PI * 2, speed: 0 }, at, meal: kill !== null, kill }
  }

  /** A leg from `from` to `to` at `mps` in `mode`, its clock sized by the distance; `dest` is the floor it lands on, if it does. A leg ends at its point at LOITER_PACE of its cruise, the ghost's pace, so the ease has no speed to make up there. */
  _legPhrase(from, to, mps, mode, dest = null) {
    if (to.speed !== mps * LOITER_PACE) throw new Error('Dragons: a leg whose end is not at its loiter pace')
    return { kind: 'fly', dur: this._legTime(from, to, mps), from, to, mps, mode, dest }
  }

  /** The phrases that bring a dragon at `from` down on `dest`: the leg to the approach and the landing -- first, from nearer `dest` than a leg can come round from, a leg straight on along its heading to where one can. */
  _homeward(from, dest, mode) {
    const out = []
    const reach = LAND_M + MIN_LEG_M
    if (Math.hypot(dest.x - from.x, dest.z - from.z) < reach) {
      const ux = Math.cos(from.heading), uz = -Math.sin(from.heading)
      const b = ux * (from.x - dest.x) + uz * (from.z - dest.z)
      const s = Math.max(MIN_LEG_M, -b + Math.sqrt(b * b - ((from.x - dest.x) ** 2 + (from.z - dest.z) ** 2) + reach * reach))
      const x = from.x + ux * s, z = from.z + uz * s
      const aim = { x, y: this.field.heightAt(x, z) + CRUISE_AGL[0], z, heading: from.heading, speed: PATROL_MPS * LOITER_PACE }
      out.push(this._legPhrase(from, aim, PATROL_MPS, mode))
      from = aim
    }
    const leg = this._legPhrase(from, this._approach(dest, bearing(from, dest), PATROL_MPS), PATROL_MPS, mode, dest)
    out.push(leg, this._landPhrase(dest, leg.to))
    return out
  }

  /** Seconds a stoop from `a` onto `b` is given: the dive at the mean of the pace it starts at and DIVE_MPS, at the cruise's slack, and STOOP_PAD_S. */
  _stoopTime(a, b) {
    return (gap3(a, b) / (0.5 * (a.speed + DIVE_MPS))) * FLIGHT_SLACK + STOOP_PAD_S
  }

  /**
   * The hunt of stag `prey` from pose `from` at world time `t`: the leg to
   * STOOP_M short of and STOOP_AGL over where the stag's free plan has it
   * when the leg ends, along the bearing from the leg's start, the leg
   * resized to the moved stag thrice; and the stoop onto its pose at the
   * stoop's end, STRIKE_AGL over it, ending at the hunt's cruise. The stoop
   * carries the stag's key, and its end is the strike.
   */
  _hunt(from, prey, t) {
    const over = { x: from.x, y: from.y, z: from.z, heading: from.heading, speed: HUNT_MPS * LOITER_PACE }
    let T = t
    for (let i = 0; i < 3; i++) {
      T = t + this._legTime(from, over, HUNT_MPS)
      const p = this.wildlife.poseAt(prey, T)
      const b = bearing(from, p)
      over.x = p.x - Math.cos(b) * STOOP_M; over.y = p.y + STOOP_AGL; over.z = p.z + Math.sin(b) * STOOP_M
    }
    const strike = { x: over.x, y: over.y, z: over.z, heading: 0, speed: HUNT_MPS }
    let dur = 0
    for (let i = 0; i < 2; i++) {
      dur = this._stoopTime(over, strike)
      const p = this.wildlife.poseAt(prey, T + dur)
      strike.x = p.x; strike.y = p.y + STRIKE_AGL; strike.z = p.z
    }
    over.heading = strike.heading = bearing(over, strike)
    const leg = this._legPhrase(from, over, HUNT_MPS, 'hunt')
    return [leg, { kind: 'stoop', dur, from: over, to: strike, prey }]
  }

  /**
   * One flight from pose `from` on the nest at world time `t0`: legs to aims
   * within PATROL_M while `budget` seconds (the way home always counted)
   * allow, each aim CRUISE_AGL over its ground -- or, exploring, VISIT_P of
   * the time and where the ground allows, a landing and a perch there -- then
   * the leg home and the landing on the nest. Hungry, with a stag in the
   * roster and the hunt in the budget, the way home is the hunt (_hunt) and
   * the return with the kill, which the leg, the landing and the meal carry.
   */
  _planFlight(site, from, rand, hungry, budget, t0) {
    const mode = hungry ? 'patrol' : 'explore'
    const out = []
    let flown = 0
    let pos = from
    let prey = null
    if (hungry) {
      const herd = this.wildlife.roster(site.x, site.z, HUNT_M)
      if (herd.length) prey = herd[(rand() * herd.length) | 0].key
    }
    // The phrases from `at` at world time `T` that end the flight: the hunt and the return with the kill, or the leg home and the landing.
    const way = (at, T) => {
      if (prey === null) return this._homeward(at, site, 'return')
      const hunt = this._hunt(at, prey, T)
      const kill = { prey, struck: T + hunt[0].dur + hunt[1].dur }
      const home = this._homeward(hunt[1].to, site, 'return')
      for (const ph of home) ph.kill = kill
      return [...hunt, ...home]
    }
    const cost = (phs) => phs.reduce((s, p) => s + p.dur, 0)
    if (prey !== null && cost(way(from, t0)) > budget) prey = null
    for (let n = 0; n < 64; n++) {
      const a = rand() * Math.PI * 2
      const r = Math.sqrt(rand()) * PATROL_M
      const ax = site.x + Math.cos(a) * r, az = site.z + Math.sin(a) * r
      const agl = roll(rand, CRUISE_AGL)
      const spot = !hungry && rand() < VISIT_P ? this._spotAt(site, ax, az) : null
      const tail = []
      let leg
      if (spot) {
        leg = this._legPhrase(pos, this._approach(spot, bearing(pos, spot), PATROL_MPS), PATROL_MPS, mode, spot)
        const land = this._landPhrase(spot, leg.to)
        tail.push(land, this._restPhrase(spot, land.to, roll(rand, PERCH_S), rand))
      } else {
        const aim = { x: ax, y: this.field.heightAt(ax, az) + agl, z: az, heading: 0, speed: PATROL_MPS * LOITER_PACE }
        aim.heading = bearing(pos, aim)
        leg = this._legPhrase(pos, aim, PATROL_MPS, mode)
      }
      if (Math.hypot(leg.to.x - pos.x, leg.to.z - pos.z) < MIN_LEG_M) continue
      const end = tail.length ? tail[tail.length - 1].to : leg.to
      const spent = leg.dur + cost(tail)
      if (flown + spent + cost(way(end, t0 + flown + spent)) > budget) break
      out.push(leg, ...tail)
      flown += spent
      pos = end
    }
    out.push(...way(pos, t0 + flown))
    return out
  }

  /** The chapter `chapter` of dragon `key`: a rest on the nest, then flights and rests while the chapter has FLIGHT_MIN_S and a rest left, the last flight cut to what is left and the last rest ending at the home pose. The guard's chapter is rests alone, each REST_S long so one born mid-chapter catches up in a few frames. A pure function of the key and the chapter: the dragon need not be born. */
  _plan(key, chapter, rand) {
    const { site, home, guard } = this._whoOf(key)
    const chapterS = this.score.chapterS
    const start = chapter * chapterS + (keyHash(key) % chapterS)
    const phrases = [this._restPhrase(site, home, roll(rand, REST_S), rand)]
    let t = phrases[0].dur
    while (guard && t < chapterS) {
      phrases.push(this._restPhrase(site, phrases[phrases.length - 1].to, roll(rand, REST_S), rand))
      t += phrases[phrases.length - 1].dur
    }
    while (!guard) {
      const hungry = rand() < HUNGRY_P
      const restS = Math.max(roll(rand, REST_S), hungry ? MEAL_S : 0)
      const budget = Math.min(roll(rand, FLIGHT_S), chapterS - t - restS)
      if (budget < FLIGHT_MIN_S) break
      const flight = this._planFlight(site, phrases[phrases.length - 1].to, rand, hungry, budget, start + t)
      const rest = this._restPhrase(site, flight[flight.length - 1].to, restS, rand, flight[flight.length - 1].kill ?? null)
      phrases.push(...flight, rest)
      t += flight.reduce((s, p) => s + p.dur, 0) + rest.dur
    }
    phrases[phrases.length - 1].to = home
    return phrases
  }

  /**
   * When the dragons take the stag `key` in the window [t0, t1) of world
   * time, or null: the earliest strike on it in the chapters of every male
   * (the guard never hunts) whose roost is within HUNT_M of the stag's home (the roster's own reach,
   * from the other end). What the wildlife cuts the stag's chapter at, so it
   * is the strike the plan stamped on the kill, never re-summed from the
   * phrases: an ulp off and the kill would land a hair before its own dead
   * phrase.
   */
  strikeOn(key, t0, t1) {
    const home = this.wildlife.spawnAt(key)
    const chapterS = this.score.chapterS
    let strike = null
    for (let tx = Math.floor((home.x - HUNT_M) / ROOST_TILE); tx <= Math.floor((home.x + HUNT_M) / ROOST_TILE); tx++) {
      for (let tz = Math.floor((home.z - HUNT_M) / ROOST_TILE); tz <= Math.floor((home.z + HUNT_M) / ROOST_TILE); tz++) {
        const site = this.roosts.siteAt(tx, tz)
        if (!site || (home.x - site.x) ** 2 + (home.z - site.z) ** 2 > HUNT_M * HUNT_M) continue
        const dkey = keyOf(site)
        for (let t = t0; t < t1;) {
          const ch = this.score.chapter(dkey, t)
          for (let i = 0; i < ch.phrases.length; i++) {
            const ph = ch.phrases[i]
            if (ph.kind !== 'stoop' || ph.prey !== key) continue
            const { struck } = ch.phrases[i + 1].kill
            if (struck >= t0 && struck < t1 && (strike === null || struck < strike)) strike = struck
          }
          t = ch.start + chapterS
        }
      }
    }
    return strike
  }

  /** The phrase playing at world time `t`: the rejoin's while one runs, else the score's. `{ phrase, start, end, index, chapter, rejoin }`. */
  _phraseAt(d, t) {
    const rj = d.rejoin
    if (rj) {
      if (t < rj.end - 1e-9) {
        let i = rj.phrases.length - 1
        while (i > 0 && rj.start + rj.starts[i] > t + 1e-9) i--
        const end = i + 1 < rj.phrases.length ? rj.start + rj.starts[i + 1] : rj.end
        return { phrase: rj.phrases[i], start: rj.start + rj.starts[i], end, index: i, chapter: tickOf(rj.start), rejoin: true }
      }
      d.rejoin = null
    }
    // A phrase's end is the next phrase's start by the same sum, so the two agree to the bit and the boundary tick is one tick.
    const at = this.score.at(d.key, t)
    const ch = this.score.chapter(d.key, t)
    const end = at.index + 1 < ch.phrases.length ? ch.start + ch.starts[at.index + 1] : ch.start + this.score.chapterS
    return { phrase: at.phrase, start: at.start, end, index: at.index, chapter: at.chapter, rejoin: false }
  }

  /** The next planned rest on the nest starting at or after world time `ready`: its start and its start pose. The chapter turn is one, so within two chapters there is always one. */
  _nextHomeRest(d, ready) {
    let ch = this.score.chapter(d.key, ready)
    for (let n = 0; n < 2; n++) {
      for (let i = 0; i < ch.phrases.length; i++) {
        const p = ch.phrases[i]
        const start = ch.start + ch.starts[i]
        if (start >= ready - 1e-9 && p.kind === 'rest' && !p.at.turf) return { start, to: p.from }
      }
      ch = this.score.chapter(d.key, ch.start + this.score.chapterS)
    }
    throw new Error(`Dragons: no rest on the nest within two chapters of ${ready}`)
  }

  // -------------------------------------------------------------------------
  // Behaviour: one tick at a time, from the phrase and its own dice.
  // -------------------------------------------------------------------------

  /** The dragon into phrase `at` at its start pose (the body is already there, snapped by the tick before) at world time `now`: its state, its dice, the ground under it read, its rest or flight set up, and the kill a phrase carries in its talons -- the stag's own slot, while the stag's chapter of the strike still runs; after it the stag is on its feet again and the dragon flies home with nothing. */
  _enter(d, at, now) {
    const ph = at.phrase
    d.phrase = ph
    d.phraseStart = at.start
    d.phraseEnd = at.end
    d.phraseEndTick = tickAfter(at.end)
    d.phraseIndex = at.index
    d.chapter = at.chapter
    d.rand = at.rejoin ? mulberry32(hash32(keyHash(d.key), at.chapter, at.index)) : phraseRand(d.key, at.chapter, at.index)
    d.ground = d.ahead = this.ground.heightAt(d.x, d.z)
    if (ph.kill && !d.cargo && now < chapterOf(ph.kill.struck, ph.kill.prey).start + CHAPTER_S) d.cargo = this.wildlife.kill(ph.kill.prey, ph.kill.struck)
    switch (ph.kind) {
      case 'rest': this._settle(d, ph); break
      case 'fly':
        if (d.cargo && ph.mode !== 'return' && ph.mode !== 'rejoin') throw new Error('Dragons: taking off with the kill uneaten')
        d.state = ph.mode
        d.dest = ph.dest ?? d.site
        this._play(d, 'fly', Infinity)
        break
      case 'stoop':
        if (d.cargo) throw new Error('Dragons: stooping with a kill in the talons')
        d.state = 'stoop'
        d.dest = d.site
        if (d.clip !== 'fly') this._play(d, 'fly', Infinity)
        break
      case 'land':
        d.state = 'land'
        d.dest = ph.dest
        d.down = false
        if (d.clip !== 'fly') this._play(d, 'fly', Infinity)
        break
      default: throw new Error(`Dragons: no phrase kind ${ph.kind}`)
    }
  }

  /** The body exactly at a phrase's end pose: level, at its speed. */
  _snap(d, to) {
    d.x = to.x
    d.y = to.y
    d.z = to.z
    d.heading = to.heading
    d.speed = to.speed
    d.pitch = d.roll = 0
  }

  /**
   * The dragon down on the rest's floor. With a kill on the nest the rest is
   * the meal (_meal); otherwise the first step is an idle, the body walking
   * onto the centre first if the landing left it short.
   */
  _settle(d, ph) {
    const dest = ph.at
    d.dest = dest
    d.state = dest.turf ? 'perch' : 'roost'
    d.homing = false
    d.queue.length = 0
    if (d.cargo && ph.meal) {
      this._meal(d)
    } else {
      if (Math.hypot(d.x - dest.x, d.z - dest.z) > WAY * d.k) d.queue.push({ kind: 'walk', u: 0, v: 0 })
      d.queue.push({ kind: 'idle' })
      this._restStep(d)
    }
  }

  /** The kill laid at its fixed spot on the nest floor, and the meal begun: a circuit of the floor, round behind the kill and up to it, then the eating. */
  _meal(d) {
    const dest = d.site
    if (!d.cargo) throw new Error('Dragons: a meal with no kill')
    if (d.dest.turf) throw new Error('Dragons: a kill carried to a spot that is not the nest')
    const ux = Math.cos(d.home.heading), uz = -Math.sin(d.home.heading)
    d.cargoU = ux * EAT_REACH * d.k
    d.cargoV = uz * EAT_REACH * d.k
    d.cargoYaw = d.heading + 0.6
    d.queue.length = 0
    const ring = WALK_RING * dest.r
    let a = Math.atan2(d.z - dest.z, d.x - dest.x)
    for (let i = 0; i < 3; i++) { a += WALK_STEP; d.queue.push({ kind: 'walk', u: Math.cos(a) * ring, v: Math.sin(a) * ring }) }
    // The stance is its own spot, reached from APPROACH behind it so the body arrives facing the kill.
    d.queue.push({ kind: 'walk', u: -APPROACH * d.k * ux, v: -APPROACH * d.k * uz })
    d.queue.push({ kind: 'walk', u: 0, v: 0 })
    d.queue.push({ kind: 'eat' })
    d.homing = false
    this._restStep(d)
  }

  /**
   * One tick on the ground: the body levelling, and coming down onto the floor
   * under it, at the landing's rates; walking, its heading closes on the
   * bearing to its point at WALK_TURN_RATE and its speed on the walk gait --
   * a third of it while the swing is wide, so it turns tight rather than
   * orbiting a point inside its turning circle -- and it moves along where it
   * points; standing, it eases to a stop. Returns the distance to the point, or
   * 0 standing.
   */
  _stand(d, dt) {
    const dest = d.dest
    let dist = 0
    let want = 0
    if (d.rest === 'walk') {
      const dx = dest.x + d.wayU - d.x
      const dz = dest.z + d.wayV - d.z
      dist = Math.hypot(dx, dz)
      const sw = swing(d.heading, Math.atan2(-dz, dx))
      d.heading += clamp(sw, -WALK_TURN_RATE * dt, WALK_TURN_RATE * dt)
      want = this.asset.gait.walk * d.k * (Math.abs(sw) > 1 ? 0.3 : 1)
    } else if (d.face !== null) {
      d.heading += clamp(swing(d.heading, d.face), -WALK_TURN_RATE * dt, WALK_TURN_RATE * dt)
    }
    d.speed += clamp(want - d.speed, -STRIDE_ACCEL * d.k * dt, STRIDE_ACCEL * d.k * dt)
    d.x += Math.cos(d.heading) * d.speed * dt
    d.z -= Math.sin(d.heading) * d.speed * dt
    const floor = this._floorAt(dest, d.x - dest.x, d.z - dest.z)
    d.y += clamp(floor - d.y, -LAND_MPS * dt, LAND_MPS * dt)
    d.pitch -= clamp(d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    d.roll -= clamp(d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
    return dist
  }

  /** A new clip on the dragon, from its start. */
  _play(d, clip, hold, rate = 1) {
    d.clip = clip
    d.rate = rate
    d.cue++
    d.left = hold
    d.cycle = this.durations[clip] / rate
  }

  /** A rest step rolled by REST_ODDS from the phrase's dice; homing, only idles. A walk is two or three points round the ring from the body's own bearing about the centre, the first returned and the rest queued, so it goes some way round rather than shuffling one step. */
  _rollStep(d) {
    if (d.homing) return { kind: 'idle' }
    let pick = d.rand()
    let i = 0
    while (i < REST_ODDS.length - 1 && pick >= REST_ODDS[i]) pick -= REST_ODDS[i++]
    const kind = ['idle', 'alert', 'walk', 'sit', 'lie'][i]
    if (kind !== 'walk') return { kind }
    const ring = WALK_RING * d.dest.r
    let a = Math.atan2(d.z - d.dest.z, d.x - d.dest.x)
    const points = 2 + Math.floor(d.rand() * 2)
    for (let n = 0; n < points; n++) { a += WALK_STEP; d.queue.push({ kind, u: Math.cos(a) * ring, v: Math.sin(a) * ring }) }
    return d.queue.shift()
  }

  /** The next thing a grounded dragon does: the queue's head, or a step rolled by the odds. A walk holds its clip until the point is reached (or WALK_S runs out); eating faces the kill; homing, a stand faces the rest's end heading. */
  _restStep(d) {
    const step = d.queue.length ? d.queue.shift() : this._rollStep(d)
    d.rest = step.kind
    d.face = d.homing ? d.phrase.to.heading : null
    switch (step.kind) {
      case 'idle': this._play(d, 'idle', roll(d.rand, IDLE_S)); break
      case 'alert': this._play(d, 'alert', this.durations.alert); break
      case 'sit': case 'lie': this._play(d, step.kind, roll(d.rand, SIT_S)); break
      case 'walk': d.wayU = step.u; d.wayV = step.v; this._play(d, 'walk', WALK_S); break
      case 'eat': {
        if (!d.cargo) throw new Error('Dragons: eating with no kill on the nest')
        d.face = Math.atan2(-(d.site.z + d.cargoV - d.z), d.site.x + d.cargoU - d.x)
        this._play(d, 'eat', roll(d.rand, EAT_S))
        break
      }
      default: throw new Error(`Dragons: no rest step named ${step.kind}`)
    }
  }

  /** A rest step over: a meal eaten drops the carcass to fade; anything else, the next step. */
  _restDone(d) {
    if (d.rest === 'eat') {
      this.wildlife.drop(d.cargo)
      d.cargo = null
    }
    this._restStep(d)
  }

  /** One tick of a rest: with time enough left only for the walk to the centre, the queue is dropped for that walk and idles facing the end heading; a step that ends hands over to the next. A meal is never cut short. */
  _stepRest(d, elapsed) {
    const ph = d.phrase
    if (!d.homing && !d.cargo) {
      const dist = Math.hypot(ph.to.x - d.x, ph.to.z - d.z)
      if (ph.dur - elapsed <= dist / (this.asset.gait.walk * d.k) + HOMING_PAD_S) {
        d.homing = true
        d.queue.length = 0
        d.queue.push(dist > WAY * d.k ? { kind: 'walk', u: ph.to.x - d.dest.x, v: ph.to.z - d.dest.z } : { kind: 'idle' })
        this._restStep(d)
      }
    }
    const dist = this._stand(d, TICK_S)
    d.left -= TICK_S
    if (d.rest === 'walk' && dist < WAY * d.k) d.left = 0
    if (d.left <= 0) this._restDone(d)
  }

  /**
   * One tick of flight toward (tx, ty, tz) at `mps`: heading, pitch and roll
   * closing on the bearing at their rates, speed on `mps` at ACCEL, and the
   * body moved along where it actually points. Given a cruise `floor`, the
   * bearing and the climb angle it closes on are swung by the meander's sines
   * of world time `now`, so the body careens and swoops about the line instead
   * of flying it and the bank follows the swung bearing; the swoop's downward
   * half fades out over the last SWOOP_ROOM metres above the floor so no swoop
   * carries the body under it. Returns the distance to the target BEFORE the
   * move.
   */
  _fly(d, dt, tx, ty, tz, mps, pitchMax, turnRate, floor = null, now = 0) {
    const dx = tx - d.x
    const dy = ty - d.y
    const dz = tz - d.z
    const horiz = Math.hypot(dx, dz)
    let sw = swing(d.heading, Math.atan2(-dz, dx))
    let wantPitch = Math.atan2(dy, Math.max(horiz, 1))
    if (floor !== null) {
      const w = 2 * Math.PI * now
      sw += CAREEN * Math.sin(w / CAREEN_S + d.phase)
      let swoop = SWOOP * Math.sin(w / SWOOP_S + 1.7 * d.phase)
      if (swoop < 0) swoop *= clamp((d.y - floor) / SWOOP_ROOM, 0, 1)
      wantPitch += swoop
    }
    d.heading += clamp(sw, -turnRate * dt, turnRate * dt)
    wantPitch = clamp(wantPitch, -pitchMax, pitchMax)
    d.pitch += clamp(wantPitch - d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    // Banked into the turn: a left turn (heading increasing, toward -Z) dips the left wing, which is a negative roll about +X.
    const wantRoll = -clamp(sw, -1, 1) * BANK
    d.roll += clamp(wantRoll - d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
    d.speed += clamp(mps - d.speed, -ACCEL * dt, ACCEL * dt)
    const step = d.speed * dt
    const level = Math.cos(d.pitch) * step
    d.x += Math.cos(d.heading) * level
    d.z -= Math.sin(d.heading) * level
    d.y += Math.sin(d.pitch) * step
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** The ground under the body and ahead of it, on a probe tick, and the body kept a metre out of it whatever the flight asked -- lifted no faster than it could climb, since a body teleported out of a slope is a pop. */
  _probe(d, k) {
    if (k % PROBE_EVERY === 0) {
      d.ground = this.ground.heightAt(d.x, d.z)
      d.ahead = this.ground.heightAt(d.x + Math.cos(d.heading) * LOOK_AHEAD_M, d.z - Math.sin(d.heading) * LOOK_AHEAD_M)
    }
    if (d.y < d.ground + 1) d.y = Math.min(d.ground + 1, d.y + DIVE_MPS * TICK_S)
  }

  /** The least height a cruise may fly at here: MIN_AGL over the ground under or ahead. */
  _floor(d) {
    return Math.max(d.ground, d.ahead) + MIN_AGL
  }

  /**
   * One tick of a leg, flown after its ghost, no lower than the floor: behind
   * it or level, steering LEAD_M past it along the end line and closing at
   * up to SPRINT_PACE; ahead, easing off to SLOW_PACE; more than LOITER_M
   * ahead, wheeling round at it again. The body never slows below
   * SLOW_PACE, and the ease pulls it onto the ghost, which moves as it
   * does, so nothing ever holds it still in the air.
   */
  _stepFly(d, k, now, elapsed) {
    this._probe(d, k)
    const ph = d.phrase
    const to = ph.to
    const floor = this._floor(d)
    _ghost(ph, elapsed)
    const cx = Math.cos(to.heading), cz = -Math.sin(to.heading)
    const along = (d.x - _gx) * cx + (d.z - _gz) * cz
    const lead = along > LOITER_M ? 0 : LEAD_M
    const mps = clamp(to.speed - PACE_GAIN * along, SLOW_PACE * ph.mps, SPRINT_PACE * ph.mps)
    this._fly(d, TICK_S, _gx + cx * lead, Math.max(to.y, floor), _gz + cz * lead, mps, PITCH_MAX, TURN_RATE, floor, now)
  }

  /** One tick of a stoop: the dive onto the strike at DIVE_MPS, flown true, the ease finishing it. */
  _stepStoop(d) {
    const to = d.phrase.to
    this._fly(d, TICK_S, to.x, to.y, to.z, DIVE_MPS, DIVE_PITCH, LAND_TURN_RATE)
  }

  /** One tick of a landing: the glide onto the touchdown at LAND_MPS, flown true, and within LAND_SNAP_M of it the settle -- level, onto the floor, the last step walked and the body stood facing the phrase's end. */
  _stepLand(d) {
    const to = d.phrase.to
    if (!d.down) {
      if (this._fly(d, TICK_S, to.x, to.y, to.z, LAND_MPS, DIVE_PITCH, LAND_TURN_RATE) < LAND_SNAP_M) {
        d.down = true
        d.rest = 'walk'
        d.wayU = to.x - d.dest.x
        d.wayV = to.z - d.dest.z
        d.face = null
        this._play(d, 'walk', Infinity)
      }
    } else if (this._stand(d, TICK_S) < WAY * d.k && d.rest === 'walk') {
      d.rest = 'idle'
      d.face = to.heading
      this._play(d, 'idle', Infinity)
    }
  }

  /** The lure this dragon is after this tick: the nearest of this.lures it wants, noticed within LURE across the ground and kept to LURE_FORGET; null when there is none. */
  _lure(d) {
    let lure = null
    let best = Infinity
    for (const l of this.lures) {
      if (!LURES.includes(l.kind)) continue
      const dist = Math.hypot(l.x - d.x, l.z - d.z)
      if (dist < best) { best = dist; lure = l }
    }
    return lure !== null && best <= (d.lure ? LURE_FORGET : LURE) * d.k ? lure : null
  }

  /** Off the score and after the lure, live: the kill, if any, let go where it lies. `by` is the lurer's client id, null for this client, which then owes the room the anchors. */
  _menace(d, lure, by, now) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    d.state = 'menace'
    d.live = { mode: 'menace', by, anchor: null, sendAt: now }
    d.rejoin = null
    d.lure = lure
    d.queue.length = 0
    d.rest = 'idle'
    d.face = null
    this._play(d, 'alert', Infinity)
  }

  /**
   * One tick after the lure: the heading closing on its bearing at
   * WALK_TURN_RATE and the body along where it points at the walk gait, or the
   * run from the hand MENACE_RUN past its head until it is a run's braking
   * distance at STRIDE_ACCEL off her (a third of either through a wide swing, as
   * _stand), until the head is at the hand, where it stands and eats at her;
   * the floor under it is the ground, or the nest's plane while over the nest.
   */
  _stomp(d, dt) {
    const l = d.lure
    const dx = l.x - d.x
    const dz = l.z - d.z
    const dist = Math.hypot(dx, dz)
    const reach = (EAT_REACH + MENACE) * d.k
    const sw = swing(d.heading, Math.atan2(-dz, dx))
    d.heading += clamp(sw, -WALK_TURN_RATE * dt, WALK_TURN_RATE * dt)
    let want = 0
    if (dist > (d.clip === 'eat' ? reach + MENACE * d.k : reach)) {
      const run = this.asset.gait.run * d.k
      const gait = dist > reach + MENACE_RUN * d.k || (d.clip === 'run' && dist > reach + (run * run) / (2 * STRIDE_ACCEL * d.k)) ? 'run' : 'walk'
      if (d.clip !== gait) this._play(d, gait, Infinity)
      want = this.asset.gait[gait] * d.k * (Math.abs(sw) > 1 ? 0.3 : 1)
    } else if (d.clip !== 'eat') {
      this._play(d, 'eat', Infinity)
    }
    this._tread(d, dt, want)
  }

  /** One tick off the score on the ground: speed closing on `want` at STRIDE_ACCEL, the body along its heading, levelling, onto the ground -- or the nest's plane while over the nest. */
  _tread(d, dt, want) {
    d.speed += clamp(want - d.speed, -STRIDE_ACCEL * d.k * dt, STRIDE_ACCEL * d.k * dt)
    d.x += Math.cos(d.heading) * d.speed * dt
    d.z -= Math.sin(d.heading) * d.speed * dt
    const dest = d.dest
    let floor = this.ground.heightAt(d.x, d.z)
    if (Math.hypot(d.x - dest.x, d.z - dest.z) < dest.r) floor = Math.max(floor, this._floorAt(dest, d.x - dest.x, d.z - dest.z))
    d.y += clamp(floor - d.y, -LAND_MPS * dt, LAND_MPS * dt)
    d.pitch -= clamp(d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    d.roll -= clamp(d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
  }

  /** One tick live: after the hand while there is one, standing alert at a peer's fresh anchor while there is not, nudged onto that anchor; the authority's anchor owed every ANCHOR_S. No hand and no fresh anchor ends the lure. */
  _stepLive(d, now) {
    const live = d.live
    const lure = this._lure(d)
    const fresh = live.anchor !== null && now - live.anchor[1] < ANCHOR_STALE_S
    if (lure === null && !fresh) { this._unlive(d, now); return }
    if (lure !== null) {
      d.lure = lure
      live.by = lure.by ?? null
      this._stomp(d, TICK_S)
    } else {
      d.rest = 'idle'
      d.face = null
      if (d.clip !== 'alert') this._play(d, 'alert', Infinity)
      this._stand(d, TICK_S)
    }
    if (live.anchor !== null && live.by !== null) {
      const [, , ax, ay, az, ah] = live.anchor
      const f = Math.min(1, TICK_S / CORRECT_S)
      d.x += (ax - d.x) * f
      d.y += (ay - d.y) * f
      d.z += (az - d.z) * f
      d.heading += swing(d.heading, ah) * f
    }
    if (live.by === null && now >= live.sendAt) {
      this.outbox.push(this._anchor(d, now, 'menace'))
      live.sendAt = now + ANCHOR_S
    }
  }

  /** The quarry `id` -- HER, or a strider's key -- in this.quarry this tick, `{ x, y, z }`, or null when it is not there. */
  _quarryAt(id) {
    if (id === HER) return this.quarry.her
    for (const s of this.quarry.striders) if (s.key === id) return s
    return null
  }

  /** HER if this grounded dragon spots her, else null. */
  _spot(d, now) {
    const her = this.quarry.her
    return her !== null && !her.dead && now >= d.spurned && Math.hypot(her.x - d.x, her.z - d.z) <= SPOT_M ? HER : null
  }

  /** Whether quarry `s` within EYE_M is eyed at odds `p`: rolled the first tick of an encounter only. */
  _sighted(d, id, s, p, now) {
    if (Math.hypot(s.x - d.x, s.z - d.z) > EYE_M) return false
    const fresh = !d.eyed.has(id)
    d.eyed.set(id, now)
    return fresh && this.random() < p
  }

  /** The quarry this flying dragon eyes this tick, or null: her in the open at EYE_P, a strider at STRIDER_P, each rolled once an encounter. Never with a kill in its talons. */
  _eye(d, now) {
    const eyed = d.eyed
    if (now < d.spurned || d.cargo) { eyed.clear(); return null }
    const her = this.quarry.her
    let prey = her !== null && !her.dead && her.open && this._sighted(d, HER, her, EYE_P, now) ? HER : null
    for (const s of this.quarry.striders) if (this._sighted(d, s.key, s, STRIDER_P, now) && prey === null) prey = s.key
    for (const [id, at] of eyed) if (at !== now) eyed.delete(id)
    return prey
  }

  /** Off the score and after quarry `prey` from `phase`, live: the kill, if any, let go. `by` is the quarry's client, null for this client, which then steers the chase and owes the room its anchors; a peer's chase carries no quarry. */
  _aggro(d, prey, by, now, phase) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    d.state = 'aggro'
    d.live = { mode: 'aggro', by, anchor: null, sendAt: now, prey, phase: null, since: now, cx: 0, cz: 0, last: 0, swept: 0, tx: 0, ty: 0, tz: 0, bit: false }
    d.rejoin = null
    d.lure = null
    d.queue.length = 0
    d.rest = 'idle'
    d.face = null
    this._phase(d, phase, now)
  }

  /** The chase into `phase`: its clip (the charge's walk sped up to CHARGE_MPS), the ear's cue -- a roar on the swoop and on a spot from the ground, the thud on a spot from a landing, a growl -- and an anchor owed now. */
  _phase(d, phase, now) {
    const live = d.live
    const was = live.phase
    const clip = AGGRO_CLIP[phase]
    if (clip === undefined) throw new Error(`Dragons: no aggro phase ${phase}`)
    live.phase = phase
    live.since = now
    live.sendAt = now
    live.bit = false
    if (phase === 'swoop' || (phase === 'spot' && was !== 'land')) d.roarCue++
    if (phase === 'spot' && was === 'land') d.thudCue++
    if (phase === 'growl') d.growlCue++
    const rate = phase === 'charge' ? CHARGE_MPS / (this.asset.gait.walk * d.k) : 1
    if (d.clip !== clip || d.rate !== rate) this._play(d, clip, Infinity, rate)
  }

  /** The bite landing on quarry `id`: her hurt, or the strider sent bolting from the dragon. */
  _bite(d, id) {
    if (id === HER) this.harm(BITE_HP, 'a fen dragon')
    else this.fright(id, d.x, d.z)
  }

  /**
   * One tick of a chase. A peer's follows its anchors (_trail); this client's
   * gives up -- spurned for SPURN_S -- with the quarry gone or GIVE_UP_M off
   * (off the circle's centre while in the air), and otherwise plays its phase:
   * the swoop circling the centre, the landing gliding onto its touchdown, and
   * on the ground turning on the quarry at WALK_TURN_RATE and stepping as
   * _phase's doc says, a chase after her turning on any strider within SPOT_M.
   */
  _stepAggro(d, k, now) {
    const live = d.live
    if (live.by !== null) { this._trail(d, now); return }
    const q = this._quarryAt(live.prey)
    const air = live.phase === 'swoop' || live.phase === 'land'
    if (q === null || Math.hypot(q.x - (air ? live.cx : d.x), q.z - (air ? live.cz : d.z)) > GIVE_UP_M) {
      d.spurned = now + SPURN_S
      d.eyed.clear()
      this._unlive(d, now)
      return
    }
    const held = now - live.since
    if (live.phase === 'swoop') {
      this._probe(d, k)
      const a = Math.atan2(d.z - live.cz, d.x - live.cx)
      live.swept += Math.abs(swing(live.last, a))
      live.last = a
      this._fly(d, TICK_S, live.cx + Math.cos(a + 0.5) * CIRCLE_M, Math.max(q.y + CIRCLE_AGL, this._floor(d)), live.cz + Math.sin(a + 0.5) * CIRCLE_M, PATROL_MPS, PITCH_MAX, LAND_TURN_RATE)
      if (live.swept >= 2 * Math.PI || held >= CIRCLE_S) {
        const r = Math.max(Math.hypot(d.x - q.x, d.z - q.z), 1e-6)
        live.tx = q.x + ((d.x - q.x) / r) * LAND_SHORT
        live.tz = q.z + ((d.z - q.z) / r) * LAND_SHORT
        live.ty = this.ground.heightAt(live.tx, live.tz)
        this._phase(d, 'land', now)
      }
    } else if (live.phase === 'land') {
      this._probe(d, k)
      if (this._fly(d, TICK_S, live.tx, live.ty, live.tz, LAND_MPS, DIVE_PITCH, LAND_TURN_RATE) < LAND_SNAP_M || held >= AGGRO_LAND_S) this._phase(d, 'spot', now)
    } else {
      const feeding = live.prey === HER && q.dead
      if (live.prey === HER && !feeding) {
        for (const s of this.quarry.striders) {
          if (Math.hypot(s.x - d.x, s.z - d.z) > SPOT_M) continue
          live.prey = s.key
          this.fright(s.key, d.x, d.z)
          this._phase(d, 'spot', now)
          return
        }
      }
      const sw = swing(d.heading, bearing(d, q))
      d.heading += clamp(sw, -WALK_TURN_RATE * TICK_S, WALK_TURN_RATE * TICK_S)
      const reach = EAT_REACH * d.k
      const snout = Math.hypot(q.x - d.x - Math.cos(d.heading) * reach, q.z - d.z + Math.sin(d.heading) * reach)
      const facing = Math.abs(sw) < 0.5
      let want = 0
      if (live.phase === 'spot') {
        if (held >= SPOT_S) {
          this._phase(d, 'charge', now)
          if (live.prey !== HER) this.fright(live.prey, d.x, d.z)
        }
      } else if (live.phase === 'charge') {
        if (snout <= BITE_M && facing) this._phase(d, 'chomp', now)
        else want = CHARGE_MPS * (Math.abs(sw) > 1 ? 0.3 : 1)
      } else if (live.phase === 'chomp') {
        if (!live.bit && held >= BITE_AT_S) {
          live.bit = true
          if (snout <= HURT_M && !feeding) this._bite(d, live.prey)
        }
        if (held >= CHOMP_S && !feeding) this._phase(d, 'growl', now)
      } else if (held >= GROWL_S) {
        this._phase(d, snout <= BITE_M && facing ? 'chomp' : 'charge', now)
      }
      this._tread(d, TICK_S, want)
    }
    if (now >= live.sendAt) {
      this.outbox.push(this._anchor(d, now, 'aggro'))
      live.sendAt = now + AGGRO_ANCHOR_S
    }
  }

  /** One tick of a peer's chase: the anchor's phase played, the body carried along the anchor's heading at its speed -- on the ground, eased since the anchor as the authority's stride eases, onto the charge or to a stand -- turned onto its heading at the authority's turn rate, and pulled over CORRECT_S onto the anchor run on to now. A stale anchor ends the chase here. */
  _trail(d, now) {
    const a = d.live.anchor
    if (now - a[1] >= ANCHOR_STALE_S) { this._unlive(d, now); return }
    const [, T, ax, ay, az, ah, , , , v, phase] = a
    if (phase !== d.live.phase) this._phase(d, phase, now)
    const f = Math.min(1, TICK_S / CORRECT_S)
    const t = now - T
    const air = phase === 'swoop' || phase === 'land'
    const want = air ? v : phase === 'charge' ? CHARGE_MPS : 0
    const acc = STRIDE_ACCEL * d.k
    const eased = Math.min(t, Math.abs(want - v) / acc)
    d.speed = v + clamp(want - v, -acc * t, acc * t)
    const run = ((v + d.speed) / 2) * eased + d.speed * (t - eased)
    const turn = (air ? LAND_TURN_RATE : WALK_TURN_RATE) * TICK_S
    d.heading += clamp(swing(d.heading, ah), -turn, turn)
    d.x += Math.cos(d.heading) * d.speed * TICK_S
    d.z -= Math.sin(d.heading) * d.speed * TICK_S
    d.x += (ax + Math.cos(ah) * run - d.x) * f
    d.y += (ay - d.y) * f
    d.z += (az - Math.sin(ah) * run - d.z) * f
    d.pitch -= clamp(d.pitch, -PITCH_RATE * TICK_S, PITCH_RATE * TICK_S)
    d.roll -= clamp(d.roll, -ROLL_RATE * TICK_S, ROLL_RATE * TICK_S)
  }

  /** This dragon's anchor at `now`: what any client needs to resume it, a chase's phase last. */
  _anchor(d, now, mode) {
    const a = [d.key, now, d.x, d.y, d.z, d.heading, -1, mode, null, d.speed]
    if (mode === 'aggro') a.push(d.live.phase)
    return a
  }

  /** The body put at an anchor's pose: level, at the anchor's speed. */
  _placeAnchor(d, anchor) {
    this._place(d, { x: anchor[2], y: anchor[3], z: anchor[4], heading: anchor[5], speed: anchor[9] })
  }

  /** The lure over at `now`: the body levelled (a rejoin starts from a pose an anchor can carry), the rejoin built from here, owed to the room if this client was the authority. */
  _unlive(d, now) {
    const mine = d.live.by === null
    d.live = null
    d.lure = null
    d.pitch = d.roll = 0
    if (mine) this.outbox.push(this._anchor(d, now, 'rejoin'))
    this._startRejoin(d, now)
  }

  /** The rejoin from the body's pose at world time `t`: the leg home, the landing, and a rest until the next planned rest on the nest, whose start pose the rest ends at; then the score again. */
  _startRejoin(d, t) {
    const from = { x: d.x, y: d.y, z: d.z, heading: d.heading, speed: d.speed }
    const phrases = this._homeward(from, d.site, 'rejoin')
    const starts = [0]
    for (const ph of phrases) starts.push(starts[starts.length - 1] + ph.dur)
    const ready = t + starts[phrases.length]
    const next = this._nextHomeRest(d, ready)
    phrases.push({ kind: 'rest', dur: next.start - ready, from: phrases[phrases.length - 1].to, to: next.to, at: d.site, meal: false })
    d.rejoin = { start: t, phrases, starts: starts.slice(0, phrases.length), end: next.start }
    this._enter(d, this._phraseAt(d, t), t)
  }

  /** The dragon put where the room's anchor has it: live at a peer's hand, or on its rejoin from the anchor's time, the ticks since then replayed. */
  _fromAnchor(d, anchor, now) {
    const [, T, , , , , , mode, by] = anchor
    this._placeAnchor(d, anchor)
    if (mode === 'menace') {
      d.rec.tick = tickOf(now)
      this._menace(d, null, by, now)
      d.live.anchor = anchor
    } else if (mode === 'aggro') {
      d.rec.tick = tickOf(now)
      this._aggro(d, null, by, now, anchor[10])
      d.live.anchor = anchor
    } else if (mode === 'rejoin') {
      d.rec.tick = tickOf(T)
      this._startRejoin(d, T)
    } else {
      throw new Error(`Dragons: no anchor mode ${mode}`)
    }
  }

  /**
   * An anchor heard from the room, `[key, T, x, y, z, heading, phraseIndex,
   * mode, by, speed]` and an aggro anchor's phase, `by` the client it came from (null for this client's own, which
   * is ignored). Kept for a dragon not yet born; on one that is, a live anchor
   * puts it live or nudges it, a rejoin anchor puts it on that rejoin from the
   * anchor's time.
   */
  apply(anchor, now) {
    const [key, T, , , , , , mode, by] = anchor
    if (!Number.isFinite(T)) throw new Error(`Dragons: an anchor with no time: ${JSON.stringify(anchor)}`)
    if (by === null) return
    this.anchored.set(key, anchor)
    const d = this.byKey.get(key)
    if (!d) return
    if (mode === 'menace') {
      if (!d.live || d.live.mode !== 'menace') this._menace(d, null, by, now)
      d.live.anchor = anchor
      d.live.by = by
    } else if (mode === 'aggro') {
      // A chase this client steers keeps its own quarry: two clients' chases of one dragon each play out at home.
      if (d.live && d.live.mode === 'aggro' && d.live.by === null) return
      if (!d.live || d.live.mode !== 'aggro') this._aggro(d, null, by, now, anchor[10])
      d.live.anchor = anchor
      d.live.by = by
    } else if (mode === 'rejoin') {
      d.live = null
      d.lure = null
      this._placeAnchor(d, anchor)
      d.rec.tick = tickOf(T)
      this._startRejoin(d, T)
    } else {
      throw new Error(`Dragons: no anchor mode ${mode}`)
    }
  }

  /** The anchors this client owes the room since the last call, moved into `into`. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /** One tick of a dragon at absolute tick `k`: the tick before kept for the frame to draw from, a phrase boundary snapped and crossed, the phrase's own step, and the ease onto its end. */
  _step(d, k) {
    const now = k * TICK_S
    d.px = d.x; d.py = d.y; d.pz = d.z; d.pheading = d.heading; d.ppitch = d.pitch; d.proll = d.roll
    if (d.live) {
      if (d.live.mode === 'aggro') this._stepAggro(d, k, now)
      else this._stepLive(d, now)
      return
    }
    if (k >= d.phraseEndTick) {
      this._snap(d, d.phrase.to)
      // The boundary tick may fall an ulp short of the end: the next phrase is looked up at the end itself.
      this._enter(d, this._phraseAt(d, Math.max(now, d.phraseEnd)), now)
    }
    const ph = d.phrase
    const elapsed = now - d.phraseStart
    switch (ph.kind) {
      case 'rest': {
        const lure = this._lure(d)
        if (lure !== null) { this._menace(d, lure, lure.by ?? null, now); return }
        const prey = this._spot(d, now)
        if (prey !== null) { this._aggro(d, prey, null, now, 'spot'); return }
        this._stepRest(d, elapsed)
        break
      }
      case 'fly': {
        const prey = this._eye(d, now)
        if (prey !== null) {
          const q = this._quarryAt(prey)
          this._aggro(d, prey, null, now, 'swoop')
          d.live.cx = q.x
          d.live.cz = q.z
          d.live.last = Math.atan2(d.z - q.z, d.x - q.x)
          return
        }
        this._stepFly(d, k, now, elapsed)
        break
      }
      case 'stoop': this._stepStoop(d); break
      case 'land': this._stepLand(d); break
      default: throw new Error(`Dragons: no phrase kind ${ph.kind}`)
    }
    // The ease is a rate-capped pull, not a plain lerp: a lerp at half weight would close a 15 m gap in one tick, which the eye reads as a yank; a pull the body could have flown is the snap's job to finish.
    const w = easeWeight(elapsed + TICK_S, ph.dur)
    if (w > 0) {
      const to = ph.to
      _ghost(ph, elapsed + TICK_S)
      d.x = pull(d.x, _gx, w, EASE_MPS * TICK_S)
      d.y = pull(d.y, to.y, w, EASE_MPS * TICK_S)
      d.z = pull(d.z, _gz, w, EASE_MPS * TICK_S)
      d.heading += clamp(swing(d.heading, to.heading) * w, -EASE_TURN * TICK_S, EASE_TURN * TICK_S)
      d.pitch = pull(d.pitch, 0, w, PITCH_RATE * TICK_S)
      d.roll = pull(d.roll, 0, w, ROLL_RATE * TICK_S)
      d.speed = pull(d.speed, to.speed, w, ACCEL * TICK_S)
    }
  }

  // -------------------------------------------------------------------------
  // Drawing.
  // -------------------------------------------------------------------------

  /** The body's matrix into _mat (and _pos, _quat, _heading, _pitch) between its last two ticks by rec.alpha: +X forward yawed to the heading, pitched about its Z and rolled about its X, scaled by k. */
  _pose(d) {
    const a = d.rec.alpha
    _pos.set(lerp(d.px, d.x, a), lerp(d.py, d.y, a), lerp(d.pz, d.z, a))
    _heading = d.pheading + swing(d.pheading, d.heading) * a
    _pitch = lerp(d.ppitch, d.pitch, a)
    _quat.setFromEuler(_euler.set(lerp(d.proll, d.roll, a), _heading, _pitch, 'YZX'))
    _scl.setScalar(d.k)
    _mat.compose(_pos, _quat, _scl)
  }

  /** Reverse the card's dissolve if the want changed: the same rule as Puppet.show, the two being halves of one dissolve. */
  _wantCard(d, on) {
    if (on === d.cardWant) return
    d.cardWant = on
    d.cardP = 1 - d.cardP
  }

  /** This dragon's two quads into the card buffer, on the body's whole matrix, with the dissolve's side as wildlife.js sets it. */
  _drawCard(d) {
    const i = this.cardN++
    this.cardMesh.setMatrixAt(i, _mat)
    this.cardMesh.setColorAt(i, this.tinted ? d.tint : WHITE)
    this.cardFade.array[i] = d.cardWant ? d.cardP : -(1 - d.cardP)
  }

  /** The kill drawn where the dragon has it: hanging by its back from the talons in the air, lying on its flank at its fixed spot on the nest floor, tilted with the floor; `shown` is whether this dragon is on a drawn rung, which is how long the kill's card holds. _pose(d) must have run. */
  _carry(d, hx, hy, hz, dt, shown) {
    const lain = d.state === 'roost'
    if (lain) {
      const site = d.site
      _cargoPos.set(site.x + d.cargoU, this._floorAt(site, d.cargoU, d.cargoV), site.z + d.cargoV)
      _cargoQuat.setFromAxisAngle(UP, d.cargoYaw)
      _cargoQuat.premultiply(_tilt.setFromUnitVectors(UP, _v.set(-site.gx, 1, -site.gz).normalize()))
    } else {
      // The kill's back in the talons: the measured feet of the fly pose, at this body's scale, in its frame.
      _cargoPos.copy(this.fly.talons).multiplyScalar(d.k).applyQuaternion(_quat).add(_pos)
      _cargoQuat.copy(_quat)
    }
    _scl.setScalar(d.cargo.k)
    _cargoMat.compose(_cargoPos, _cargoQuat, _scl)
    const dist = Math.sqrt((_cargoPos.x - hx) ** 2 + (_cargoPos.y - hy) ** 2 + (_cargoPos.z - hz) ** 2)
    this.wildlife.carry(d.cargo, _cargoMat, dist, dt, lain, shown)
  }

  /** One dragon: stepped to `now`, then drawn on whichever rung its flying body's size puts it at. */
  _tick(d, hx, hy, hz, now, dt) {
    // The clock moved further since its last frame than a frame can replay (a skip): the gap is not replayed at all, the dragon is put where the score has it now, as if she had stepped out of the timeline and back in. A join's replay lags `rec.tick` just as far, over many frames, and is not a skip.
    if (tickOf(now) - d.rec.at > CATCH_UP_TICKS) this._replace(d, now)
    d.rec.at = tickOf(now)
    this.replayed += stepTo(d.rec, now, (k) => this._step(d, k))
    if (d.rec.tick < tickOf(now)) this.behind++
    const dist = Math.sqrt((d.x - hx) ** 2 + (d.y - hy) ** 2 + (d.z - hz) ** 2)
    const tier = critterTier(d.lodSize, dist, d.lod, CARD_RUNGS)
    d.lod = tier
    this._pose(d)
    if (d.cargo) this._carry(d, hx, hy, hz, dt, tier < CARD_RUNGS)

    this._wantCard(d, tier === LOD_RUNGS)
    if (d.cardP < 1) d.cardP = stepLodFade(d.cardP, dt)
    if (d.cardWant || d.cardP < 1) this._drawCard(d)
    if (tier >= LOD_RUNGS) {
      if (!d.puppet) return
      d.puppet.show(-1)
      d.puppet.step(dt)
      if (d.puppet.done) this._releasePuppet(d)
      return
    }

    const puppet = this._takePuppet(d)
    if (!puppet) return
    puppet.show(tier)
    puppet.play(d.clip, d.cue)
    // A pooled puppet's actions keep whatever rate they were last given.
    puppet.actions.get(d.clip).timeScale = d.rate
    puppet.solver.steer(_heading, _pitch)
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
  }

  /**
   * One frame at world time `now` (clock.js WorldClock.seconds): a dragon for
   * every resident roost, stepped to now and drawn; the dragons of roosts that
   * went, retired. `lures`: hands.js lures() this frame, each `{ kind, x, y,
   * z, by }`, a fish among them menaced. `quarry`: what this client's dragons
   * may chase -- `her` `{ x, y, z, open, dead }` (open: no tree within 5 m; dead: a body a chase feeds on and none starts on) or null,
   * and `striders`, this client's own `[{ key, x, y, z }]`.
   */
  update(hx, hy, hz, now, lures = NO_LURES, quarry = NO_QUARRY) {
    if (!this.loaded) return
    if (!Number.isFinite(now)) throw new Error(`Dragons.update: world time ${now}`)
    const dt = this.last === null ? 0 : clamp(now - this.last, 0, 0.1)
    this.last = now
    this.frame++
    this.cardN = 0
    this.replayed = 0
    this.behind = 0
    this.lures = lures
    this.quarry = quarry

    for (let i = this.fading.length - 1; i >= 0; i--) {
      const p = this.fading[i]
      p.step(dt)
      if (!p.done) continue
      this._park(p)
      this.fading[i] = this.fading[this.fading.length - 1]
      this.fading.pop()
    }

    const sites = this._sites
    sites.length = 0
    this.roosts.sites(sites)
    for (const site of sites) {
      for (const guard of PAIR) {
        const d = this.byKey.get(keyOf(site, guard)) ?? this._spawn(site, guard, now)
        if (!d) continue
        d.seen = this.frame
        this._tick(d, hx, hy, hz, now, dt)
      }
    }
    for (const d of this.byKey.values()) if (d.seen !== this.frame) this._retire(d)

    this.cardMesh.count = this.cardN
    if (this.cardN) {
      this.cardMesh.instanceMatrix.needsUpdate = true
      this.cardMesh.instanceColor.needsUpdate = true
      this.cardFade.needsUpdate = true
    }
  }

  get stats() {
    const lod = Array.from({ length: LOD_RUNGS }, () => ({ n: 0, tris: 0 }))
    const states = {}
    for (const d of this.byKey.values()) {
      states[d.state] = (states[d.state] ?? 0) + 1
      if (d.lod >= LOD_RUNGS) continue
      lod[d.lod].n++
      lod[d.lod].tris += this.asset.tiers[d.lod].index.count / 3
    }
    return {
      alive: this.byKey.size, puppets: this.puppets.length - this.freePuppets.length, lod, cards: this.cardN, states,
      carrying: Array.from(this.byKey.values()).filter((d) => d.cargo).length,
      live: Array.from(this.byKey.values()).filter((d) => d.live).length,
      overflow: this.overflow, starved: this.starved, replayed: this.replayed, behind: this.behind,
    }
  }

  /** Every dragon in the air, on its nest or after her, for the ear: x, y, z, size, state, clip, cycle and speed on each. A hidden layer lists nothing. */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const d of this.byKey.values()) into.push(d)
    return into
  }

  dispose() {
    this.place()
    this.batch.parent?.remove(this.batch)
    this.plain.dispose()
    for (const mats of this.puppetMats) for (const m of [mats.in, mats.out]) m.dispose()
    this.cardMaterial.map?.dispose()
    this.cardMaterial.dispose()
    this.cardMesh?.geometry.dispose()
    this.asset?.map?.dispose()
    for (const geo of this.asset?.tiers ?? []) geo.dispose()
  }
}
