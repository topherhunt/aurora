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
// IT FLIES A LOOP. `roost` on the nest, idling and looking about, then
// `patrol`: a cruise CRUISE_AGL above the ground toward one wandering aim after
// another within PATROL_M of home, every LOOK_EVERY frames asking the wildlife
// for the nearest live stag within HUNT_M. Finding one is `hunt` -- a run at a
// point above it -- until STOOP_M out, then `strike`: the dive proper, at
// DIVE_MPS and a pitch no cruise allows, and within STRIKE_M of the stag the
// stag is SEIZED (wildlife.seize): its spawn is dead, its slot is the dragon's
// cargo, and it hangs from the talons, drawn by wildlife.carry on its own
// species' ladder wherever the dragon puts it. `return` is the flight home
// with it, `land` the last LAND_M at LAND_MPS onto the nest floor, and the
// carcass lies beside the dragon on the nest until the next takeoff drops it,
// where it fades. A strike that misses climbs back into the hunt; a stag that
// left the world mid-dive (its tile unloaded) sends the dragon back on patrol.
//
// IT TURNS, PITCHES AND BANKS, none of them faster than a rate: heading closes
// on the bearing at TURN_RATE, pitch on the climb angle at PITCH_RATE, and roll
// leans into the turn by BANK of the swing. The body's frame is the wildlife's
// -- +X forward, yawed about the world up -- with pitch about the body's Z and
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
//
// THE PUPPET'S MATRIX IS WRITTEN EVERY FRAME, where a stag's is written only
// on the frames it re-poses: a body crossing a third of a metre a frame at
// 20 m/s would otherwise step, on a far rung, eight frames at a time. Only the
// bone texture's upload is held; the group moves.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CARD_RUNGS, CRITTER_GLB, LOD_RUNGS, bakeCritterCard, createCritterCardMaterial, critterTier, makeCardFadeAttribute,
  setCritterCard, tileSeed,
} from './critters.js'
import { LOD_FADE_S, Puppet, loadSkinnedAsset, makePuppetMaterials, makeSettledMaterial } from './puppet.js'

export const CLIPS = ['idle', 'alert', 'walk', 'run', 'sit', 'lie', 'fly']
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
// How long a dragon rests between flights, and how long a patrol lasts before it turns for home.
export const REST_S = [25, 70]
export const FLIGHT_S = [45, 120]
export const IDLE_S = [3, 8]
// Frames between prey scans on patrol, and between ground probes in the air.
export const LOOK_EVERY = 15
export const PROBE_EVERY = 6
// Clip cross-fade, and where the cargo hangs under the body as a fraction of the dragon's size.
const FADE_S = 0.35
const CARGO_HANG = 0.1
// Where a dragon stands on its nest, above the floor as a fraction of the rim's radius, and how far to the side of it the kill lies.
const NEST_STAND = 0.04
const NEST_ASIDE = 0.35

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
  p.group.updateMatrixWorld(true)
  THREE.Skeleton.prototype.update.call(p.skeleton)
}

/**
 * The flying body's box in the unit frame, from tier 0 skinned on the CPU at
 * four points of the `fly` clip: `halfX` and `halfZ` its largest reach either
 * side of the origin, `minY` and `maxY` its lowest and highest point, and
 * `spreadAt` the clip time its wings reach widest, for the photograph. The
 * shipper's extents are of the STANDING body, and a stood dragon's wings are
 * folded; the ladder and the card want the body in the air.
 */
export function measureFly(asset) {
  const flat = new THREE.MeshBasicMaterial()
  const p = new Puppet(asset, { plain: flat, in: flat, out: flat, uCut: { value: 1 } }, { clipFade: FADE_S, oneShot: ONE_SHOT })
  const dur = asset.clips.find((c) => c.name === 'fly').duration
  const mesh = p.meshes[0]
  const position = mesh.geometry.getAttribute('position')
  const n = position.count
  let halfX = 0, halfZ = 0, minY = Infinity, maxY = -Infinity, spreadAt = 0, spread = -1
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
    halfZ = Math.max(halfZ, hz)
    if (hz > spread) { spread = hz; spreadAt = f * dur }
  }
  p.release()
  p.skeleton.dispose()
  flat.dispose()
  if (!(halfX > 0) || !(halfZ > 0) || !(maxY > minY)) throw new Error('Dragons: the fly pose has no extent -- re-ship the GLB')
  return { halfX, halfZ, minY, maxY, spreadAt }
}

export class Dragons {
  /**
   * @param field     V2Height: heightAt, the ground the flight keeps clear of
   * @param roosts    Roosts: sites()
   * @param wildlife  Wildlife: prey, seize, carry, drop
   */
  constructor(scene, field, { seed = 1, roosts, wildlife, asset = null } = {}) {
    if (!field || typeof field.heightAt !== 'function') throw new Error('Dragons needs a height field with heightAt')
    if (!roosts || typeof roosts.sites !== 'function') throw new Error('Dragons needs the Roosts, for sites')
    if (!wildlife || ['prey', 'seize', 'carry', 'drop'].some((f) => typeof wildlife[f] !== 'function')) {
      throw new Error('Dragons needs the Wildlife, for prey, seize, carry and drop')
    }
    this.field = field
    this.roosts = roosts
    this.wildlife = wildlife
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
        // The ground under the body and under the point LOOK_AHEAD_M ahead of it, as last probed.
        ground: 0, ahead: 0,
        state: 'roost', timer: 0, aimX: 0, aimY: 0, aimZ: 0,
        prey: null, cargo: null,
        // The clip playing and how long the rest step holds it; `cue` counts steps, as the wildlife's does.
        clip: 'idle', cue: 0, left: 0,
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
    d.site = site
    d.size = this.asset.sizeM * (1 + SIZE_VARY * (2 * rand() - 1))
    d.k = d.size / this.asset.span
    d.lodSize = d.size * this.bulk
    d.heading = rand() * Math.PI * 2
    d.pitch = d.roll = d.speed = 0
    d.prey = d.cargo = null
    d.lod = CARD_RUNGS
    d.puppet = null
    d.cardWant = false
    d.cardP = 1
    d.ground = d.ahead = site.y
    d.x = site.x
    d.y = this._standY(site)
    d.z = site.z
    this._perch(d)
    // Part way through its rest, so a valley of roosts does not lift off together.
    d.timer *= rand()
    this.byKey.set(site.key, d)
    return d
  }

  /** Where a dragon stands on its nest: a hand over the floor. */
  _standY(site) {
    return site.y + NEST_STAND * site.r
  }

  /** The dragon down on its nest, resting: the clock and the first idle. Where it stands, `_settle` takes it, at its rates, from wherever the landing left off. */
  _perch(d) {
    d.state = 'roost'
    d.timer = roll(this.rand, REST_S)
    this._restStep(d, 'idle')
  }

  /** The last metres onto the stand point at landing speed, the body levelling and stopping at its rates: nothing snaps, on a nest she may be standing beside. */
  _settle(d, dt) {
    const site = d.site
    const dx = site.x - d.x
    const dy = this._standY(site) - d.y
    const dz = site.z - d.z
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (dist > 0) {
      const step = Math.min(dist, LAND_MPS * dt) / dist
      d.x += dx * step
      d.y += dy * step
      d.z += dz * step
    }
    d.pitch -= clamp(d.pitch, -PITCH_RATE * dt, PITCH_RATE * dt)
    d.roll -= clamp(d.roll, -ROLL_RATE * dt, ROLL_RATE * dt)
    d.speed = Math.max(0, d.speed - ACCEL * dt)
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
  }

  /** The next thing a resting dragon does: an idle held a few seconds, or one look about. */
  _restStep(d, force = null) {
    const clip = force ?? (this.rand() < 0.3 ? 'alert' : 'idle')
    this._play(d, clip, clip === 'alert' ? this.durations.alert : roll(this.rand, IDLE_S))
  }

  /** A fresh patrol aim: a point within PATROL_M of the nest, CRUISE_AGL above the ground there. */
  _aim(d) {
    const a = this.rand() * Math.PI * 2
    const r = Math.sqrt(this.rand()) * PATROL_M
    d.aimX = d.site.x + Math.cos(a) * r
    d.aimZ = d.site.z + Math.sin(a) * r
    d.aimY = this.field.heightAt(d.aimX, d.aimZ) + roll(this.rand, CRUISE_AGL)
  }

  /** Off the nest: the kill left behind, the first aim picked, the flight clock started. */
  _takeoff(d) {
    if (d.cargo) { this.wildlife.drop(d.cargo); d.cargo = null }
    d.state = 'patrol'
    d.timer = roll(this.rand, FLIGHT_S)
    this._aim(d)
    this._play(d, 'fly', Infinity)
  }

  /**
   * One frame of flight toward (tx, ty, tz) at `mps`: heading, pitch and roll
   * closing on the bearing at their rates, speed on `mps` at ACCEL, and the
   * body moved along where it actually points. Returns the distance to the
   * target BEFORE the move.
   */
  _fly(d, dt, tx, ty, tz, mps, pitchMax, turnRate) {
    const dx = tx - d.x
    const dy = ty - d.y
    const dz = tz - d.z
    const horiz = Math.hypot(dx, dz)
    const swing = swingTo(d.heading, Math.atan2(-dz, dx))
    d.heading += clamp(swing, -turnRate * dt, turnRate * dt)
    const wantPitch = clamp(Math.atan2(dy, Math.max(horiz, 1)), -pitchMax, pitchMax)
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
    switch (d.state) {
      case 'roost': {
        this._settle(d, dt)
        d.left -= dt
        if (d.left <= 0) this._restStep(d)
        if (d.timer <= 0) this._takeoff(d)
        return
      }
      case 'patrol': {
        this._probe(d, dt)
        if ((this.frame + d.id) % LOOK_EVERY === 0) {
          const prey = this.wildlife.prey(d.x, d.z, HUNT_M)
          if (prey) { d.prey = prey; d.state = 'hunt'; return }
        }
        if (d.timer <= 0) { d.state = 'return'; return }
        const reach = this._fly(d, dt, d.aimX, Math.max(d.aimY, this._floor(d)), d.aimZ, PATROL_MPS, PITCH_MAX, TURN_RATE)
        if (reach < 20) this._aim(d)
        return
      }
      case 'hunt': {
        const prey = this._preyStanding(d)
        if (!prey) { d.prey = null; d.state = 'patrol'; return }
        this._probe(d, dt)
        this._fly(d, dt, prey.x, Math.max(prey.y + STOOP_AGL, this._floor(d)), prey.z, HUNT_MPS, PITCH_MAX, TURN_RATE)
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
        this._fly(d, dt, site.x, Math.max(site.y + RETURN_AGL, this._floor(d)), site.z, PATROL_MPS, PITCH_MAX, TURN_RATE)
        if (Math.hypot(site.x - d.x, site.z - d.z) < LAND_M) { d.state = 'land'; d.timer = LAND_S }
        return
      }
      case 'land': {
        const site = d.site
        const reach = this._fly(d, dt, site.x, this._standY(site), site.z, LAND_MPS, DIVE_PITCH, LAND_TURN_RATE)
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

  /** The kill drawn where the dragon has it: hanging under the body in the air, lying beside it on the nest. _pose(d) must have run. */
  _carry(d, hx, hy, hz, dt) {
    if (d.state === 'roost') {
      const site = d.site
      _cargoPos.set(site.x - Math.sin(d.heading) * NEST_ASIDE * site.r, d.y, site.z - Math.cos(d.heading) * NEST_ASIDE * site.r)
      _cargoQuat.setFromAxisAngle(UP, d.heading + 0.6)
    } else {
      _cargoPos.set(0, -CARGO_HANG * d.size, 0).applyQuaternion(_quat).add(_pos)
      _cargoQuat.copy(_quat)
    }
    _scl.setScalar(d.cargo.k)
    _cargoMat.compose(_cargoPos, _cargoQuat, _scl)
    const dist = Math.sqrt((_cargoPos.x - hx) ** 2 + (_cargoPos.y - hy) ** 2 + (_cargoPos.z - hz) ** 2)
    this.wildlife.carry(d.cargo, _cargoMat, dist, dt)
  }

  /** One dragon: behaved, then drawn on whichever rung its flying body's size puts it at. */
  _tick(d, hx, hy, hz, dt) {
    this._behave(d, dt)
    const dist = Math.sqrt((d.x - hx) ** 2 + (d.y - hy) ** 2 + (d.z - hz) ** 2)
    const tier = critterTier(d.lodSize, dist, d.lod, CARD_RUNGS)
    d.lod = tier
    this._pose(d)
    if (d.cargo) this._carry(d, hx, hy, hz, dt)

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

  /** Every dragon in the air or on its nest, for the ear: x, y, z, size, clip and speed on each. A hidden layer lists nothing. */
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
