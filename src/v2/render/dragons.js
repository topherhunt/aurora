// ---------------------------------------------------------------------------
// THE DRAGONS: one fen dragon to every roost (render/roosts.js), flying out
// from its nest to hunt the stags (render/wildlife.js) and carrying the kill
// home.
//
// A DRAGON IS ITS ROOST'S. roosts.sites() lists the nests resident round her,
// and this layer keeps exactly one dragon per site, born the frame the site
// appears and retired (its body dissolving where it flies) the frame the site
// goes. Nothing here is a tile roll of its own: where a dragon lives is where
// its roost was placed, and the roost is the pure function of position.
//
// IT IS HUNGRY OR IT IS NOT, and that decides what a flight is for. A dragon
// that ate within HUNGER_S leaves the nest to `explore`: a cruise CRUISE_AGL
// above the ground toward one wandering aim after another within PATROL_M of
// home, and at an aim, VISIT_P of the time, it picks the ground under it as a
// spot to `visit` if that ground is under SPOT_SLOPE_DEG, dry and well clear of
// the nest -- flies there, lands and `perch`es on it for PERCH_S, pottering as
// it would at home, then flies on until its flight clock (FLIGHT_S, which does
// not run while it perches) sends it home. A dragon that has not eaten in
// HUNGER_S flies to `patrol` instead -- the same cruise, every LOOK_EVERY
// frames asking the wildlife for the nearest live stag within HUNT_M -- and an
// explorer that goes hungry in the air turns to patrolling where it is.
// Finding a stag is `hunt` -- a run at a point above it -- until STOOP_M out,
// then `strike`: the dive proper, at DIVE_MPS and a pitch no cruise allows, and
// within STRIKE_M of the stag the stag is SEIZED (wildlife.seize): its spawn is
// dead, its slot is the dragon's cargo, and it hangs from the talons, drawn by
// wildlife.carry wherever the dragon puts it -- on its own species' mesh rungs,
// then as its card for as long as the dragon itself is drawn.
// `return` is the flight home with it and `land` the last LAND_M at LAND_MPS
// onto the nest floor. A strike that misses climbs back into the hunt; a stag
// that left the world mid-dive (its tile unloaded) sends the dragon back on
// patrol.
//
// ON THE GROUND IT POTTERS. `roost` (the nest) and `perch` (a visited spot) run
// one rest step after another off a queue: `idle` held IDLE_S, one `alert`
// look about, `sit` or `lie` held SIT_S, or a `walk` at the shipped walk gait
// to the next point round a ring WALK_RING of the floor's radius, so a run of
// walks traces a circle. Landing with a kill fills the queue instead: the kill
// is laid at a FIXED spot on the nest floor (NEST_ASIDE off centre on the side
// it landed facing away from), the dragon walks a circuit, then round to the
// far side of the kill and up to it, and `eat`s -- the eat clip plunging the
// head EAT_REACH ahead of the body, which is where the kill lies -- for EAT_S,
// at the end of which the carcass is dropped to fade (eaten), `fedAt` is now,
// and REST_S of pottering follow before the next flight. A body walking on the
// nest rides the roost's floor plane; on turf it rides the height field.
//
// IT TURNS, PITCHES AND BANKS, none of them faster than a rate: heading closes
// on the bearing at TURN_RATE, pitch on the climb angle at PITCH_RATE, and roll
// leans into the turn by BANK of the swing. A CRUISE MEANDERS: the bearing and
// the climb the body closes on are each swung by a slow sine of the dragon's
// own clock and phase (CAREEN, SWOOP), so a flight between two points swoops up
// and down and yaws side to side, banking into every swing like a boat that is
// hard to steer; only a dive and a landing fly true. The body's frame is the
// wildlife's -- +X forward, yawed about the world up -- with pitch about the body's Z and
// roll about its X composed after, so a dragon on a card and a dragon on a
// mesh are the same matrix.
//
// EVERY RESIDENT DRAGON IS SIMULATED, in or out of sight: a dozen bodies of
// arithmetic and a ground probe every PROBE_EVERY frames, and the alternative
// -- a dragon frozen mid-air when she looked away, hanging there when she came
// round the hill -- is not a saving worth having. What is gated by the ladder
// is the DRAWING, on the creatures' rungs (critters.js critterTier) sized by
// the FLYING body's largest extent: four skinned tiers through a puppet
// (render/puppet.js), then the card rung, then nothing.
//
// THE CARD IS TWO QUADS FIXED IN THE BODY'S FRAME, not one quad spun to her: a
// side view and a top view, crossed, carrying the full instance matrix -- yaw,
// pitch, roll. A spun quad stands in for a body whose every side reads alike;
// a dragon seen from below is a wingspan and from beside it a neck and a tail,
// and which of those she sees is exactly what a spun card cannot say. The two
// pictures are photographed from the FLY pose (bakeCards), and the quads
// bounded by that same pose measured on the CPU, so the card and the mesh it
// dissolves against are the same wingspan.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, bakeCritterCard, createCritterCardMaterial, critterTier, makeCardFadeAttribute,
  setCritterCard, tileSeed,
} from './critters.js'
import { LOD_FADE_S, Puppet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const CLIPS = ['idle', 'alert', 'walk', 'run', 'sit', 'lie', 'fly', 'eat']
const ONE_SHOT = new Set(['sit', 'lie'])
// The two pictures of a far dragon, and the order they sit in the texture.
export const DRAGON_VIEWS = ['side', 'top']

// Dragons at once, and puppets. A roost is one to 160 000 m^2, so the sites
// resident round her number a handful; the puppets are for the ones in MESH
// range, which is a couple.
export const MAX = 16
export const PUPPETS = 6
// How far either side of the shipped size a dragon rolls.
export const SIZE_VARY = 0.15

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
// How far from home a patrol aim may be, how high above the ground under the aim it is set, and the least clearance over the ground under or ahead of the body on a cruise.
export const PATROL_M = 300
export const CRUISE_AGL = [40, 80]
export const MIN_AGL = 15
export const LOOK_AHEAD_M = 40
// How near a stag must be to be hunted, how far out the hunt becomes the dive, how near the talons must pass to take it, and how long a dive may run before it is a miss.
export const HUNT_M = 250
export const STOOP_M = 40
export const STOOP_AGL = 25
export const STRIKE_M = 5
export const STRIKE_S = 10
// The last leg home, how near the stand point the landing hands over to the settle, and how long a landing may run before it is handed over from wherever it is.
export const LAND_M = 30
export const RETURN_AGL = 30
export const LAND_SNAP_M = 3
export const LAND_S = 30
// How long after a meal a dragon flies to explore rather than to hunt; how long it rests on the nest once fed (a hungry dragon's rest, too, since it is a rest and not a wait); how long a flight lasts before it turns for home, not counting time perched; how long a visited spot holds it; how long it eats.
export const HUNGER_S = 300
export const REST_S = [90, 240]
export const FLIGHT_S = [60, 180]
export const PERCH_S = [20, 60]
export const EAT_S = [15, 30]
// The rest steps: how long an idle, a sit or a lie is held, how long a walk may run before it gives up on its point, and how likely a step is each kind, in the order idle, alert, walk, sit, lie.
export const IDLE_S = [3, 8]
export const SIT_S = [8, 20]
export const WALK_S = 20
export const REST_ODDS = [0.3, 0.2, 0.3, 0.1, 0.1]
// Walking: how fast the heading swings, how near a point counts as reached, the ring the walk goes round as a fraction of the floor's radius and the angle each walk step goes round it, and how far behind its eating stance a dragon lines up so it arrives facing the kill.
export const WALK_TURN_RATE = 1.5
export const WAY_M = 0.6
export const WALK_RING = 0.3
export const WALK_STEP = 1.3
export const APPROACH_M = 1.5
// How often an aim reached on an explore becomes a visit, the steepest ground a dragon will alight on, and how many nest radii from home a spot must be to count as away.
export const VISIT_P = 0.5
export const SPOT_SLOPE_DEG = 30
export const SPOT_AWAY = 3
// Frames between prey scans on patrol, and between ground probes in the air.
export const LOOK_EVERY = 15
export const PROBE_EVERY = 6
// Clip cross-fade.
const FADE_S = 0.35
// Where a dragon stands on its nest, above the floor as a fraction of the rim's radius, and how far to the side of it the kill lies.
const NEST_STAND = 0.04
const NEST_ASIDE = 0.35
// How far ahead of the body's origin, in body units, the eat clip's snout plunges: measured on the shipped fen dragon at the bite, the snout's vertices lie 1.84 to 2.45 forward with the ground under them, so a kill this far ahead is what the head goes into.
export const EAT_REACH = 2.1

const swingTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a, b, t) => a + (b - a) * t
const roll = (rand, [lo, hi]) => lerp(lo, hi, rand())

const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _cargoPos = new THREE.Vector3()
const _cargoQuat = new THREE.Quaternion()
const _cargoMat = new THREE.Matrix4()
const _tilt = new THREE.Quaternion()
const _v = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

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
   * @param roosts    Roosts: sites()
   * @param wildlife  Wildlife: prey, seize, carry, drop
   */
  constructor(scene, field, { seed = 1, roosts, wildlife, water, asset = null } = {}) {
    if (!field || typeof field.heightAt !== 'function' || typeof field.heightAndSlopeAt !== 'function') throw new Error('Dragons needs a height field with heightAt and heightAndSlopeAt')
    if (!roosts || typeof roosts.sites !== 'function') throw new Error('Dragons needs the Roosts, for sites')
    if (!wildlife || ['prey', 'seize', 'carry', 'drop'].some((f) => typeof wildlife[f] !== 'function')) {
      throw new Error('Dragons needs the Wildlife, for prey, seize, carry and drop')
    }
    if (!water || typeof water.isSubmerged !== 'function') throw new Error('Dragons needs the WaterSurfaces, for isSubmerged, so no dragon alights in a lake')
    this.field = field
    this.roosts = roosts
    this.wildlife = wildlife
    this.water = water
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x7a3d)

    this.batch = new THREE.Group()
    this.batch.name = 'v2-dragons'
    scene.add(this.batch)
    // Every material the world's lighting patches: one settled, a fade pair a puppet, and the card's.
    this.plain = makeSettledMaterial('dragons')
    this.materials = [this.plain]
    this.puppetMats = []
    for (let i = 0; i < PUPPETS; i++) {
      const mats = makePuppetMaterials('dragons', this.plain)
      this.puppetMats.push(mats)
      this.materials.push(mats.in, mats.out)
    }
    // Fixed in the body's frame, not spun: the instance matrix is the whole orientation.
    this.cardMaterial = createCritterCardMaterial('dragons', { billboard: false, fade: true, hue: false })
    this.materials.push(this.cardMaterial)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, site: null, seen: 0,
        x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0,
        // The meander's clock and this dragon's phase in it, so no two swing together.
        age: 0, phase: 0,
        // The ground under the body and under the point LOOK_AHEAD_M ahead of it, as last probed.
        ground: 0, ahead: 0,
        // The state's clock, the flight clock (runs only in the air), the age it last ate, and the aim of the cruise.
        state: 'roost', timer: 0, flight: 0, fedAt: 0, aimX: 0, aimY: 0, aimZ: 0,
        // The ground it is on or flying to land on -- its nest site, or a visited spot -- the rest steps queued on it, the step under way and where that step walks to and faces; the kill's fixed place on the nest floor, off its centre.
        dest: null, queue: [], rest: 'idle', wayU: 0, wayV: 0, face: null, cargoU: 0, cargoV: 0, cargoYaw: 0,
        prey: null, cargo: null,
        // The clip playing, how long the rest step holds it, and the clip's own length, for the ear's wingbeat clock; `cue` counts steps, as the wildlife's does.
        clip: 'idle', cue: 0, left: 0, cycle: 0,
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
    this.cardMesh = null
    this.cardFade = null
    this.cardN = 0
    this.frame = 0
    this.loaded = false
    // Sites with no free slot; dragon-frames in mesh range with no free puppet; landings the clock finished for the dragon.
    this.overflow = 0
    this.starved = 0
    this.forced = 0

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
      this.puppets.push(new Puppet(asset, mats, { clipFade: FADE_S, oneShot: ONE_SHOT }))
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

  /** A dragon born on its nest, sized by the roost's own seed so the same nest holds the same dragon every visit. */
  _spawn(site) {
    const d = this.free.pop()
    if (!d) { this.overflow++; return null }
    const rand = mulberry32(tileSeed(site.key, 0x5d, this.seed))
    if (!Number.isFinite(site.gx + site.gz)) throw new Error(`Dragons: roost ${site.key} carries no floor plane (gx, gz)`)
    d.site = site
    d.size = this.asset.sizeM * (1 + SIZE_VARY * (2 * rand() - 1))
    d.k = d.size / this.asset.span
    d.lodSize = d.size * this.bulk
    d.heading = rand() * Math.PI * 2
    d.pitch = d.roll = d.speed = 0
    d.age = 0
    d.phase = rand() * Math.PI * 2
    // Some way into its hunger, so a valley of roosts does not all hunt at once, nor all explore.
    d.fedAt = -rand() * HUNGER_S
    d.flight = 0
    d.prey = d.cargo = null
    d.queue.length = 0
    d.lod = CARD_RUNGS
    d.puppet = null
    d.cardWant = false
    d.cardP = 1
    d.ground = d.ahead = site.y
    d.dest = site
    d.x = site.x
    d.y = this._standY(site)
    d.z = site.z
    this._perch(d)
    // Part way through its rest, so a valley of roosts does not lift off together.
    d.timer *= rand()
    this.byKey.set(site.key, d)
    return d
  }

  /** How far over its floor a dragon stands: a hand over a nest's branches, nothing over turf. */
  _standOver(dest) {
    return dest.turf ? 0 : NEST_STAND * dest.r
  }

  /** Where a dragon stands on `dest`: over the floor at its centre. */
  _standY(dest) {
    return dest.y + this._standOver(dest)
  }

  /** The floor's height at (dest.x + u, dest.z + v): a nest's is the plane the roost is laid on (roosts.js sites), a spot's is the ground itself. */
  _floorAt(dest, u, v) {
    return dest.turf ? this.field.heightAt(dest.x + u, dest.z + v) : dest.y + dest.gx * u + dest.gz * v
  }

  /** Not eaten within HUNGER_S. */
  _hungry(d) {
    return d.age - d.fedAt > HUNGER_S
  }

  /**
   * The dragon down on `dest`, resting. On its nest with a kill, the kill is
   * laid at a fixed spot and the queue is the meal: a circuit of the floor,
   * round behind the kill and up to it, then the eating; the rest clock starts
   * when the meal ends. Otherwise the rest clock starts now and the first step
   * is an idle, the body walking onto the centre first if the landing left it
   * short. Where the body is, `_stand` takes it, at its rates.
   */
  _perch(d) {
    const dest = d.dest
    const home = dest === d.site
    d.state = home ? 'roost' : 'perch'
    d.queue.length = 0
    if (d.cargo) {
      if (!home) throw new Error('Dragons: a kill carried to a spot that is not the nest')
      d.cargoU = -Math.sin(d.heading) * NEST_ASIDE * dest.r
      d.cargoV = -Math.cos(d.heading) * NEST_ASIDE * dest.r
      d.cargoYaw = d.heading + 0.6
      const ring = WALK_RING * dest.r
      let a = Math.atan2(d.z - dest.z, d.x - dest.x)
      for (let i = 0; i < 3; i++) { a += WALK_STEP; d.queue.push({ kind: 'walk', u: Math.cos(a) * ring, v: Math.sin(a) * ring }) }
      // The stance: EAT_REACH short of the kill along the line from the nest's centre out through it, reached from APPROACH_M further back so the body arrives facing the kill.
      const len = Math.hypot(d.cargoU, d.cargoV)
      const ux = d.cargoU / len, uz = d.cargoV / len
      const stance = EAT_REACH * d.k
      d.queue.push({ kind: 'walk', u: d.cargoU - (stance + APPROACH_M) * ux, v: d.cargoV - (stance + APPROACH_M) * uz })
      d.queue.push({ kind: 'walk', u: d.cargoU - stance * ux, v: d.cargoV - stance * uz })
      d.queue.push({ kind: 'eat' })
      d.timer = Infinity
    } else {
      d.timer = roll(this.rand, home ? REST_S : PERCH_S)
      if (Math.hypot(d.x - dest.x, d.z - dest.z) > WAY_M) d.queue.push({ kind: 'walk', u: 0, v: 0 })
      d.queue.push({ kind: 'idle' })
    }
    this._restStep(d)
  }

  /**
   * One frame on the ground: the body levelling, and coming down onto the floor
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
      const swing = swingTo(d.heading, Math.atan2(-dz, dx))
      d.heading += clamp(swing, -WALK_TURN_RATE * dt, WALK_TURN_RATE * dt)
      want = this.asset.gait.walk * d.k * (Math.abs(swing) > 1 ? 0.3 : 1)
    } else if (d.face !== null) {
      d.heading += clamp(swingTo(d.heading, d.face), -WALK_TURN_RATE * dt, WALK_TURN_RATE * dt)
    }
    d.speed += clamp(want - d.speed, -ACCEL * dt, ACCEL * dt)
    d.x += Math.cos(d.heading) * d.speed * dt
    d.z -= Math.sin(d.heading) * d.speed * dt
    const floor = this._floorAt(dest, d.x - dest.x, d.z - dest.z) + this._standOver(dest)
    d.y += clamp(floor - d.y, -LAND_MPS * dt, LAND_MPS * dt)
    d.pitch -= clamp(d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    d.roll -= clamp(d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
    return dist
  }

  /** A dragon whose roost is gone: its cargo let go and its body left to dissolve where it is. */
  _retire(d) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    if (d.puppet) {
      d.puppet.show(-1)
      this.fading.push(d.puppet)
      d.puppet = null
    }
    this.byKey.delete(d.site.key)
    d.site = null
    d.prey = null
    this.free.push(d)
  }

  /** Every dragon gone at once, nothing fading: the ground has been rebuilt under them. Boot, and a relief edit. */
  place() {
    for (const d of this.byKey.values()) {
      if (d.cargo) { this.wildlife.drop(d.cargo, false); d.cargo = null }
      this._releasePuppet(d)
      d.site = null
      d.prey = null
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
  // Behaviour.
  // -------------------------------------------------------------------------

  /** A new clip on the dragon, from its start. */
  _play(d, clip, hold) {
    d.clip = clip
    d.cue++
    d.left = hold
    d.cycle = this.durations[clip]
  }

  /** A rest step rolled by REST_ODDS. A walk is two or three points round the ring from the body's own bearing about the centre, the first returned and the rest queued, so it goes some way round rather than shuffling one step. */
  _rollStep(d) {
    let pick = this.rand()
    let i = 0
    while (i < REST_ODDS.length - 1 && pick >= REST_ODDS[i]) pick -= REST_ODDS[i++]
    const kind = ['idle', 'alert', 'walk', 'sit', 'lie'][i]
    if (kind !== 'walk') return { kind }
    const ring = WALK_RING * d.dest.r
    let a = Math.atan2(d.z - d.dest.z, d.x - d.dest.x)
    const points = 2 + Math.floor(this.rand() * 2)
    for (let n = 0; n < points; n++) { a += WALK_STEP; d.queue.push({ kind, u: Math.cos(a) * ring, v: Math.sin(a) * ring }) }
    return d.queue.shift()
  }

  /** The next thing a grounded dragon does: the queue's head, or a step rolled by the odds. A walk holds its clip until the point is reached (or WALK_S runs out); eating faces the kill. */
  _restStep(d) {
    const step = d.queue.length ? d.queue.shift() : this._rollStep(d)
    d.rest = step.kind
    d.face = null
    switch (step.kind) {
      case 'idle': this._play(d, 'idle', roll(this.rand, IDLE_S)); break
      case 'alert': this._play(d, 'alert', this.durations.alert); break
      case 'sit': case 'lie': this._play(d, step.kind, roll(this.rand, SIT_S)); break
      case 'walk': d.wayU = step.u; d.wayV = step.v; this._play(d, 'walk', WALK_S); break
      case 'eat': {
        if (!d.cargo) throw new Error('Dragons: eating with no kill on the nest')
        d.face = Math.atan2(-(d.site.z + d.cargoV - d.z), d.site.x + d.cargoU - d.x)
        this._play(d, 'eat', roll(this.rand, EAT_S))
        break
      }
      default: throw new Error(`Dragons: no rest step named ${step.kind}`)
    }
  }

  /** A rest step over: a meal eaten drops the carcass to fade and starts the rest clock; anything else, the next step. */
  _restDone(d) {
    if (d.rest === 'eat') {
      this.wildlife.drop(d.cargo)
      d.cargo = null
      d.fedAt = d.age
      d.timer = roll(this.rand, REST_S)
    }
    this._restStep(d)
  }

  /** A fresh cruise aim: a point within PATROL_M of the nest, CRUISE_AGL above the ground there. */
  _aim(d) {
    const a = this.rand() * Math.PI * 2
    const r = Math.sqrt(this.rand()) * PATROL_M
    d.aimX = d.site.x + Math.cos(a) * r
    d.aimZ = d.site.z + Math.sin(a) * r
    d.aimY = this.field.heightAt(d.aimX, d.aimZ) + roll(this.rand, CRUISE_AGL)
  }

  /** The ground at (x, z) as a spot to alight on, or null: under SPOT_SLOPE_DEG, dry, and SPOT_AWAY nest radii from home. */
  _spotAt(d, x, z) {
    const { h, tan } = this.field.heightAndSlopeAt(x, z)
    if (tan > Math.tan((SPOT_SLOPE_DEG * Math.PI) / 180)) return null
    if (this.water.isSubmerged(x, z, h)) return null
    if (Math.hypot(x - d.site.x, z - d.site.z) < SPOT_AWAY * d.site.r) return null
    return { x, y: h, z, r: d.site.r, gx: 0, gz: 0, turf: true }
  }

  /** Into the air: from the nest, the flight clock started and the flight chosen by hunger; from a spot, the flight goes on, or home if its clock ran out while perched. */
  _takeoff(d) {
    if (d.cargo) throw new Error('Dragons: taking off with the kill uneaten')
    if (d.state === 'roost') {
      d.flight = roll(this.rand, FLIGHT_S)
      d.state = this._hungry(d) ? 'patrol' : 'explore'
    } else {
      d.state = d.flight > 0 ? (this._hungry(d) ? 'patrol' : 'explore') : 'return'
    }
    d.dest = d.site
    this._aim(d)
    this._play(d, 'fly', Infinity)
  }

  /**
   * One frame of flight toward (tx, ty, tz) at `mps`: heading, pitch and roll
   * closing on the bearing at their rates, speed on `mps` at ACCEL, and the
   * body moved along where it actually points. Given a cruise `floor`, the
   * bearing and the climb angle it closes on are swung by the meander's sines,
   * so the body careens and swoops about the line instead of flying it and the
   * bank follows the swung bearing; the swoop's downward half fades out over
   * the last SWOOP_ROOM metres above the floor so no swoop carries the body
   * under it. Returns the distance to the target BEFORE the move.
   */
  _fly(d, dt, tx, ty, tz, mps, pitchMax, turnRate, floor = null) {
    const dx = tx - d.x
    const dy = ty - d.y
    const dz = tz - d.z
    const horiz = Math.hypot(dx, dz)
    let swing = swingTo(d.heading, Math.atan2(-dz, dx))
    let wantPitch = Math.atan2(dy, Math.max(horiz, 1))
    if (floor !== null) {
      const w = 2 * Math.PI * d.age
      swing += CAREEN * Math.sin(w / CAREEN_S + d.phase)
      let swoop = SWOOP * Math.sin(w / SWOOP_S + 1.7 * d.phase)
      if (swoop < 0) swoop *= clamp((d.y - floor) / SWOOP_ROOM, 0, 1)
      wantPitch += swoop
    }
    d.heading += clamp(swing, -turnRate * dt, turnRate * dt)
    wantPitch = clamp(wantPitch, -pitchMax, pitchMax)
    d.pitch += clamp(wantPitch - d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    // Banked into the turn: a left turn (heading increasing, toward -Z) dips the left wing, which is a negative roll about +X.
    const wantRoll = -clamp(swing, -1, 1) * BANK
    d.roll += clamp(wantRoll - d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
    d.speed += clamp(mps - d.speed, -ACCEL * dt, ACCEL * dt)
    const step = d.speed * dt
    const level = Math.cos(d.pitch) * step
    d.x += Math.cos(d.heading) * level
    d.z -= Math.sin(d.heading) * level
    d.y += Math.sin(d.pitch) * step
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  /** The ground under the body and ahead of it, on a probe frame, and the body kept a metre out of it whatever the flight asked -- lifted no faster than it could climb, since a body teleported out of a slope is a pop. */
  _probe(d, dt) {
    if ((this.frame + d.id) % PROBE_EVERY === 0) {
      d.ground = this.field.heightAt(d.x, d.z)
      d.ahead = this.field.heightAt(d.x + Math.cos(d.heading) * LOOK_AHEAD_M, d.z - Math.sin(d.heading) * LOOK_AHEAD_M)
    }
    if (d.y < d.ground + 1) d.y = Math.min(d.ground + 1, d.y + DIVE_MPS * dt)
  }

  /** The least height a cruise may fly at here: MIN_AGL over the ground under or ahead. */
  _floor(d) {
    return Math.max(d.ground, d.ahead) + MIN_AGL
  }

  /** The stag this dragon is after, still in the world; or null, and the hunt is off. */
  _preyStanding(d) {
    return d.prey && d.prey.spawn !== null ? d.prey : null
  }

  /** One frame of what a dragon is doing. */
  _behave(d, dt) {
    d.timer -= dt
    d.age += dt
    switch (d.state) {
      case 'roost':
      case 'perch': {
        const dist = this._stand(d, dt)
        d.left -= dt
        if (d.rest === 'walk' && dist < WAY_M) d.left = 0
        if (d.left <= 0) this._restDone(d)
        if (d.timer <= 0) this._takeoff(d)
        return
      }
      case 'patrol': {
        this._probe(d, dt)
        d.flight -= dt
        if ((this.frame + d.id) % LOOK_EVERY === 0) {
          const prey = this.wildlife.prey(d.x, d.z, HUNT_M)
          if (prey) { d.prey = prey; d.state = 'hunt'; return }
        }
        if (d.flight <= 0) { d.state = 'return'; return }
        const floor = this._floor(d)
        const reach = this._fly(d, dt, d.aimX, Math.max(d.aimY, floor), d.aimZ, PATROL_MPS, PITCH_MAX, TURN_RATE, floor)
        if (reach < 20) this._aim(d)
        return
      }
      case 'explore': {
        this._probe(d, dt)
        d.flight -= dt
        if (this._hungry(d)) { d.state = 'patrol'; return }
        if (d.flight <= 0) { d.state = 'return'; return }
        const floor = this._floor(d)
        const reach = this._fly(d, dt, d.aimX, Math.max(d.aimY, floor), d.aimZ, PATROL_MPS, PITCH_MAX, TURN_RATE, floor)
        if (reach < 20) {
          const spot = this.rand() < VISIT_P ? this._spotAt(d, d.aimX, d.aimZ) : null
          if (spot) { d.dest = spot; d.state = 'visit'; return }
          this._aim(d)
        }
        return
      }
      case 'visit': {
        this._probe(d, dt)
        const spot = d.dest
        const floor = this._floor(d)
        this._fly(d, dt, spot.x, Math.max(spot.y + RETURN_AGL, floor), spot.z, PATROL_MPS, PITCH_MAX, TURN_RATE, floor)
        if (Math.hypot(spot.x - d.x, spot.z - d.z) < LAND_M) { d.state = 'land'; d.timer = LAND_S }
        return
      }
      case 'hunt': {
        const prey = this._preyStanding(d)
        if (!prey) { d.prey = null; d.state = 'patrol'; return }
        this._probe(d, dt)
        const floor = this._floor(d)
        this._fly(d, dt, prey.x, Math.max(prey.y + STOOP_AGL, floor), prey.z, HUNT_MPS, PITCH_MAX, TURN_RATE, floor)
        if (Math.hypot(prey.x - d.x, prey.z - d.z) < STOOP_M) { d.state = 'strike'; d.timer = STRIKE_S }
        return
      }
      case 'strike': {
        const prey = this._preyStanding(d)
        if (!prey) { d.prey = null; d.state = 'patrol'; return }
        this._probe(d, dt)
        const reach = this._fly(d, dt, prey.x, prey.y + 1, prey.z, DIVE_MPS, DIVE_PITCH, LAND_TURN_RATE)
        if (reach < STRIKE_M) {
          d.cargo = this.wildlife.seize(prey)
          d.prey = null
          d.state = 'return'
        } else if (d.timer <= 0) {
          // A miss: back up into the hunt, whose aim is above the stag, and come round again.
          d.state = 'hunt'
        }
        return
      }
      case 'return': {
        this._probe(d, dt)
        const site = d.site
        d.dest = site
        const floor = this._floor(d)
        this._fly(d, dt, site.x, Math.max(site.y + RETURN_AGL, floor), site.z, PATROL_MPS, PITCH_MAX, TURN_RATE, floor)
        if (Math.hypot(site.x - d.x, site.z - d.z) < LAND_M) { d.state = 'land'; d.timer = LAND_S }
        return
      }
      case 'land': {
        const dest = d.dest
        const reach = this._fly(d, dt, dest.x, this._standY(dest), dest.z, LAND_MPS, DIVE_PITCH, LAND_TURN_RATE)
        if (reach < LAND_SNAP_M || d.timer <= 0) {
          if (d.timer <= 0) this.forced++
          this._perch(d)
        }
        return
      }
      default:
        throw new Error(`Dragons: no state named ${d.state}`)
    }
  }

  // -------------------------------------------------------------------------
  // Drawing.
  // -------------------------------------------------------------------------

  /** The body's matrix into _mat (and _pos, _quat): +X forward yawed to the heading, pitched about its Z and rolled about its X, scaled by k. */
  _pose(d) {
    _pos.set(d.x, d.y, d.z)
    _quat.setFromEuler(_euler.set(d.roll, d.heading, d.pitch, 'YZX'))
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

  /** One dragon: behaved, then drawn on whichever rung its flying body's size puts it at. */
  _tick(d, hx, hy, hz, dt) {
    this._behave(d, dt)
    const dist = Math.sqrt((d.x - hx) ** 2 + (d.y - hy) ** 2 + (d.z - hz) ** 2)
    const tier = critterTier(d.lodSize, dist, d.lod, CARD_RUNGS)
    d.lod = tier
    this._pose(d)
    if (d.cargo) this._carry(d, hx, hy, hz, dt, tier < CARD_RUNGS)

    this._wantCard(d, tier === LOD_RUNGS)
    if (d.cardP < 1) d.cardP = Math.min(1, d.cardP + dt / LOD_FADE_S)
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
    puppet.step(dt)
    puppet.group.matrix.copy(_mat)
    puppet.group.matrixWorldNeedsUpdate = true
  }

  /** One frame: a dragon for every resident roost, stepped and drawn; the dragons of roosts that went, retired. Runs AFTER wildlife.update, which places the stags it hunts. */
  update(hx, hy, hz, dt) {
    if (!this.loaded) return
    this.frame++
    this.cardN = 0

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
      const d = this.byKey.get(site.key) ?? this._spawn(site)
      if (!d) continue
      d.seen = this.frame
      this._tick(d, hx, hy, hz, dt)
    }
    for (const d of this.byKey.values()) if (d.seen !== this.frame) this._retire(d)

    this.cardMesh.count = this.cardN
    if (this.cardN) {
      this.cardMesh.instanceMatrix.needsUpdate = true
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
      overflow: this.overflow, starved: this.starved, forced: this.forced,
    }
  }

  /** Every dragon in the air or on its nest, for the ear: x, y, z, size, state, clip, cycle and speed on each. A hidden layer lists nothing. */
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
