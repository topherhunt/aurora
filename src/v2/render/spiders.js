// ---------------------------------------------------------------------------
// THE BIRCH SPIDERS. One or two on a trunk or a boulder, crawling
// about between the ground and CLIMB_M up, pausing, on the sides of things and
// hardly ever on top of them, and nowhere above the snow line; and now and
// then a small one alone on the ground, always on the move. Three hosts,
// three surfaces:
//
//   A TREE is its LOD0 trunk's ring profile (tree.js trunkProfile, handed over
//   by Trees.trunksInto with the instance's scale, stretch and yaw), so a spider on one
//   is an angle round the trunk and a height up it, seated by bilinear
//   interpolation between the bark's own corners, and a step is exact.
//   A ROCK is whatever its hull says it is (Rocks.rayAt): a spider on one is a
//   point, a normal and a heading in the tangent plane, and every few frames a
//   step is dropped back onto the stone by a short ray along the normal. A
//   face counts only where it is stone a spider could stand on: above the
//   ground and the water under it, within the climb, not a ceiling. A step
//   that finds none, or finds the top, is a turn back the way it came, and a
//   spider turned back three times sits down; a sitting spider re-reads its
//   stone now and then, because the rocks re-seat when a chunk re-splits, and
//   one whose stone has gone is taken away. A rock seats a group only where a
//   seat has WALL_M of climbable wall above or below it -- an embedded stone at
//   the waterline with nothing to cling to seats nobody.
//   THE GROUND is the height field: one tile in four (HOST_CHANCE.ground)
//   seeds a point and a single spider at GROUND_SCALE of the others' size,
//   heading anywhere, its normal read off the field's slopes, that walks or
//   runs and hardly ever stops (a GROUND_REST_CHANCE at the end of each spell,
//   for GROUND_PAUSE_S), turning back from water and the snow line and,
//   GROUND_ROAM_M from its point, back toward it.
//
// NO SPIDER HAS A SKELETON. Every spider is an instance of the one near
// InstancedMesh or of the shared litter-card pool (litter-cards.js, one draw
// call for every layer's far cards), on the world's arc ladder
// (critters.js critterTier, CARD_RUNGS) by its own size: over the four mesh
// rungs the shipped GLB's tier MESH_TIER as plain instanced geometry -- the
// one mesh tier, the pick (tier 0) being photographed for the card and never
// drawn -- on the card rung one FIXED pool quad, the bind pose photographed from above
// (critters.js, the 'top' view), laid flat against its surface under the same
// matrix the mesh would wear (its slot's id is its pool instance's), and past that neither drawn nor simulated. A
// 0.3 m spider is the mesh to 10.8 m and the card to 21.6; a 0.1 m one to
// 3.6 and 7.2. THE LEGS ARE THE VERTEX SHADER: at setAsset the
// tier's vertices are read against the skeleton's JOINTS_0/WEIGHTS_0 and the
// ones a Leg bone owns are given `aLeg` -- the leg's half of the alternating
// tetrapod (legs 1 and 3 on one side step with 2 and 4 on the other) and how
// far down the leg the vertex sits, 0 at the hip and 1 at the furthest tip --
// and per instance `aGait` carries a phase and an amplitude, so a moving
// spider's legs swing fore and aft about the body by amplitude * depth *
// sin(phase + half) and lift on the forward swing. The phase runs one cycle
// per stride of the gait the seat moves at, so the feet hold the bark; the
// amplitude eases to nothing when it pauses. Her head close by rears a paused
// spider up: the instance pitched nose-up about its seat.
//
// THE COLOUR IS A TINT. Each spider rolls a shade and a warmth with its group
// (TINT_DARK, TINT_BROWN) and carries the multiplier in instanceColor on every
// tier and on the card, so a group is a run from the map's own colour down
// through darker and browner, and a spider keeps its colour across the
// handover to the card.
//
// A spider's world matrix is kept on its slot and rebuilt only when it has
// moved, turned, been re-seated or is rearing; a paused tree spider is not
// re-placed on its bark unless its trunk's origin moved with a re-seated chunk.
//
// Her head within ALERT_M rears a paused spider up. A BODY -- the capsule
// under a head, feet to crown, WALK.radius wide -- coming within FLEE_M of a
// spider makes it FLEE: off at FLEE_HASTE times the run toward the point of
// its host furthest from that body -- the far side of the trunk or the stone
// from where it stands, at whichever end of the climb is further from the
// nearest point of it -- re-aimed every STEER_EVERY frames as the body moves,
// until it is FLEE_TO_M off, within ARRIVE_M of that point, or closing on it
// at under STALL_FRAC of its pace for STALL_S (cornered), when it calms down
// where it is; calm, it does not run again until every body has been out of
// FLEE_M and one has come back. A destination rather than a direction because,
// square to the bark, no direction along it leads away from a body to the
// first order. The bodies are hers and every peer's (main.js peerHeadsNow),
// and a spider runs from whichever is nearest, so a player who watches a
// friend walk up to a trunk watches the spider bolt from the friend. The ear
// (audio/ambience.js) is told once as it sets off, through startled(). A
// spider that is not fleeing pays one squared distance per body a frame; the
// root is taken only while it flees.
//
// A group is a pure function of its host's origin and the world seed, so the
// same trunk carries the same spiders every visit, and so is its LIFE: each
// spider is named for its host and its place in the group, and that name and
// the world clock (sim/score.js) give its every spell, so two clients at the
// same trunk watch the same spider do the same thing at the same second and one
// arriving mid-crawl crosses the rest of it alike. A spell is the crossing from
// the seat it holds at one turn of its grid to the seat it holds at the next,
// broken into short scoots with a sit before each; the seats themselves wander
// the host's band as smooth noise in the spell index (_wave), so a spell only
// ever moves it as far as it can crawl and no seat is read off the one before.
// The one term not shared is the surface it is drawn against -- the bark's
// origin, the stone's face -- which rides each client's own LOD.
//
// A FLIGHT is not planned -- it is a chase, and where it goes depends on where
// the body goes -- but it is still on the world's clock: it steps at TICK_HZ on
// absolute ticks (sim/score.js), re-aims and turns on tick counts rather than
// frame counts, and draws every noise it needs from phraseRand on its own name
// and the tick, never the layer's roll. So two clients that agree on the body
// run the identical flight whatever their frame rates, and a client that joins
// it late catches its ticks up. When it calms the spider takes a name from
// where it stopped and a fresh grid from that second (_rekey), so it is back on
// a shared life the moment the flight ends.
//
// A BOLT is the flight a released spider makes, and it is exactly shared: the
// column it runs from is the hand's, fixed at the release, so it never re-aims
// at a body this client sees differently, and its first tick is the release's
// own second, which came over the wire. Both clients run the same ticks from
// the same pose, calm on the same tick at the same spot, and take up the same
// name from it. A flight a body startles is only as shared as the two clients'
// view of that body: hers is this frame's, a peer's is the last pose relayed.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import {
  CRITTER_GLB, critterCardExtents,
  LOD_RUNGS, CARD_RUNGS, critterTier, cullRange, bakeCritterCard, tierTintSplice, tileKey, walkTiles,
} from './critters.js'
import { loadSkinnedAsset } from './puppet.js'
import { PropArena } from './prop-arena.js'
import { cardPicture } from './litter-cards.js'
import { PERCH_STRIDE } from './rocks.js'
import { TRUNK_STRIDE } from './trees.js'
import { WALK } from '../walk.js'
import { taken, TOLERANCE_M } from '../taken.js'
import { keyHash, phraseRand, stepTo, tickOf, TICK_S } from '../../sim/score.js'
import { DROP, dropWire, snap } from '../creature-net.js'

export const TILE = 16
// The skinned tiers the shipped GLB carries, one per rung of the world ladder; the one drawn as a mesh, tier 1 (tier 0 is the card's photograph, the coarser pair are smears); and how many mesh tiers there are, which is also a slot's `lod` for the card.
export const SHIPPED_TIERS = LOD_RUNGS
export const MESH_TIER = 1
export const LOD_TIERS = 1
// A spider's largest extent, which is what its rungs are measured by.
export const SIZE_M = [0.1, 0.3]
// A ground spider's size over SIZE_M.
export const GROUND_SCALE = 0.5
// The tiles walked: the biggest spider's cull, plus a tile's half-diagonal so every spider inside it has a tile. Inside the trees' full-density band (50 m).
export const RADIUS = cullRange(SIZE_M[1], CARD_RUNGS) + TILE * Math.SQRT1_2
export const CLIMB_M = 3
export const GROUP = { tree: [1, 2], rock: [1, 2], ground: [1, 1] }
// A ground spider's tether to its tile's point, the chance it sits down at the end of a spell, and for how long when it does.
export const GROUND_ROAM_M = 6
export const GROUND_REST_CHANCE = 0.05
export const GROUND_PAUSE_S = [0.3, 1.5]
// How far off her a fleeing ground spider makes for, with nowhere to hide.
export const GROUND_FLEE_M = 1
// The ground's normal is read across this much of it either way.
const GROUND_EPS = 0.25
// A spider's tint, rolled with its group and carried in instanceColor on the mesh tiers and the card alike: a shade from TINT_DARK up to 1 (the map as shipped is the lightest), and a warmth from 0 to 1 that pulls green and blue down by these shares of it at full, so the range runs from the map through darker and browner to dark brown.
export const TINT_DARK = 0.3
export const TINT_BROWN = { g: 0.3, b: 0.6 }
// The chance a host carries a group at all; the ground's is per tile.
export const HOST_CHANCE = { tree: 0.125, rock: 0.3, ground: 0.25 }
// A host's key is its quantised origin plus its kind's share, so a tree, a rock and the ground's point at one origin are three hosts.
const KIND_KEY = { tree: 0, rock: 0.5, ground: 0.25 }
// The host a spider she let go of runs on: the ground where it landed, its own key so it never collides with the tile's rolled point.
const LOOSE_KEY = 0.75
// A rock worth climbing (its longest extent), and a trunk worth clinging to (base radius).
export const ROCK_MIN_SIZE = 2
export const TRUNK_MIN_R = 0.06
// A seat or a step whose surface normal rises past this is flat ground to a spider; a seat is kept there one time in ten, a step never.
export const FLAT_NY = 0.6
export const FLAT_CHANCE = 0.1
// A face whose normal drops past this is a ceiling: no seat, no step.
export const HANG_NY = -0.3
// The wall a rock must offer above or below a seat, at the seat's azimuth, before it carries a group.
export const WALL_M = 0.4
// A face this close to the water is wet.
const WET_M = 0.05
// A ground crossing is read for water at this fraction of it at a time, back from where the spider has got to.
const WET_STEP = 1 / 16
// A rock spider re-reads the stone under it every so many frames.
export const RESEAT_EVERY = 45
export const MAX = 256
// The pool instances claimed for the cards: the pool packs only visible ones, so this is bookkeeping for the worst crowd on the card rung at once, not a reservation.
const CARD_CLAIM = 64
// A card-rung spider is stepped every CARD_EVERY frames (wildlife.js does the same): its pose is closed-form in the world second, so the next step lands exactly where every-frame stepping would, and at its distance a stride four frames long is under two pixels.
const CARD_EVERY = 4
const HOST_BUF = 64

// A spider's life is cut into SPELLs this long on its own grid (sim/score.js), each a crossing from the seat it holds at one turn to the seat it holds at the next, broken into SCOOTS short scoots with a sit before each. A ground spider's spell is the long one: it covers more ground and hardly ever stops.
export const SPELL_S = { tree: 24, rock: 24, ground: 48 }
const SCOOTS = { tree: 3, rock: 3, ground: 6 }
// The seat itself wanders the host's band as smooth noise in the spell index: a corner every WANDER_SEGS spells, hashed off the spider's key, eased between. Locality by construction -- one spell moves it a fraction of the band, which is all a spider can crawl in that time -- and still a pure function of the key and the spell.
const WANDER_SEGS = { tree: 16, rock: 16, ground: 24 }
// How far a scoot's waypoint may wander off the straight line between the spell's two seats, in the band's own units: radians round a trunk or a rock, metres up it, metres over the ground.
const JITTER = { tree: [0.5, 0.2], rock: [0.5, 0.2], ground: [0.6, 0.6] }
// Draws for a seat in the band, at the roll and at every spell's turn: a rock's side is undercut and buried in places, and the ground has water and a snow line on it.
const SEAT_TRIES = 8
// No scoot is shorter than this, however near its waypoint, and none is dawdled over at more than STRETCH_MAX times its own pace to fill out a spell.
const MIN_GO_S = 0.4
const STRETCH_MAX = 3
// The sits' wanted lengths, which the spell's spare time is split between in proportion; a ground spider only ever idles, and briefly.
const PAUSE_S = [1.5, 6]
const REST_S = [6, 14]
// A gait's stride in the unit frame and its cycle in seconds, from tools/creatures/anim/clips/spider/{walk,run}.json; the seat moves at stride/cycle and the legs swing one cycle a stride, so the feet hold the bark.
export const STRIDE = { walk: 0.11, run: 0.15 }
const CYCLE_S = { walk: 0.9, run: 0.42 }
const GAIT = { walk: STRIDE.walk / CYCLE_S.walk, run: STRIDE.run / CYCLE_S.run }
const RUN_CHANCE = 0.12
// The legs' swing eases in and out over this long at either end of a scoot; a fleeing spider's eases at GAIT_EASE a second instead, its flight not being planned, and a rear-up eases up and down at REAR_EASE.
export const AMP_EASE_S = 0.12
const GAIT_EASE = 12
const REAR_EASE = 6
// A reared spider's pitch, nose up about its seat.
export const REAR_RAD = 0.6
// Her head this close makes a paused spider rear up...
const ALERT_M = 1.2
// ...and her body this close makes any spider run, at this multiple of the run gait, until it is FLEE_TO_M from her, within ARRIVE_M of where it is making for, or closing on that at under STALL_FRAC of its pace for STALL_S seconds.
export const FLEE_M = 0.5
export const FLEE_TO_M = 3
export const FLEE_HASTE = 4
export const STALL_S = 1
const STALL_FRAC = 0.25
const ARRIVE_M = 0.1
// Ticks between a fleeing spider's re-aims, and how many of its ticks one call may catch up (a flight is seconds long, so a joiner never has far to come).
const STEER_TICKS = 2
const FLEE_CATCH_UP = 200
// Feet into the surface, as a fraction of the body's height, so eight feet meet a round trunk.
export const SINK = 0.15
const RESCAN_FRAMES = 4
// The bones whose vertices swing: the leg's number, its joint and its side. The GLB names them `Leg1Hip.L`; GLTFLoader runs every node name through PropertyBinding.sanitizeNodeName, which drops the dot, so this matches the loaded `Leg1HipL`.
const LEG_BONE = /^Leg(\d)(Hip|Knee|Ankle|Foot)(L|R)$/
const LEGS = 8

const TAU = Math.PI * 2
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
// A value folded back into [0, R] as if the band's two ends were mirrors, so a wander shifted off the band's middle keeps moving rather than piling up against an edge.
const fold = (t, R) => {
  const m = ((t % (2 * R)) + 2 * R) % (2 * R)
  return m > R ? 2 * R - m : m
}
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _z = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _flat = new THREE.Matrix4()
const _lay = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
const _col = new THREE.Color()
const _hit = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, ox: 0, oz: 0, size: 0 }
// A waypoint: a seat in its host's own two coordinates (`u`, `v` -- round and up a trunk or a rock, east and north over the ground) and the world seat, normal and bark radius those resolve to.
const seat = () => ({ u: 0, v: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, tx: 0, ty: 1, tz: 0, r: 1 })
const _seatA = seat()
const _seatB = seat()
const _seatC = seat()
// A rock spider's tangent plane, its upmost direction and its right.
const _up = { x: 0, y: 0, z: 0 }
const _rt = { x: 0, y: 0, z: 0 }
// The band a seat wanders in: the low end and the width of each of the host's two coordinates, and whether the first wraps (an angle round a trunk or a rock) rather than folding.
const _ax = { ulo: 0, urange: 1, vlo: 0, vrange: 1, wrap: false }

// A host's identity and its seed come from its quantised origin: the same trunk, the same spiders.
const hostKey = (x, z) => Math.round(x * 8) * 0x100000 + Math.round(z * 8)
// A spider's name on the score: its host's quantised origin and its place in the group. A loose one is named for where it came to rest instead, which is the same point on every client once the wire carries the release.
const seatKey = (host, member) => `sp:${host.kind}:${Math.round(host.x * 8)},${Math.round(host.z * 8)}:${member}`
const restKey = (x, y, z) => `sp@${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`
// The spiders' prefix in the room's creature keys (creature-net.js): a release is all they send.
export const PREFIX = 'sp'
function hostSeed(x, z, seed) {
  const qx = Math.round(x * 8) | 0
  const qz = Math.round(z * 8) | 0
  let h = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** The shipped spider (tools/creatures/ship-spider.mjs): its tiers, skeleton and map, in render/puppet.js's shape. */
export const loadSpiderGlb = (url) => loadSkinnedAsset(url, { tiers: SHIPPED_TIERS })

/**
 * `aLeg` onto a skinned tier: for each vertex, the swing half of the leg whose
 * bone weighs most on it (0 or PI, the alternating tetrapod) and how far down
 * that leg it sits, 0 at the hip's bind position to 1 at the leg's furthest
 * vertex. A vertex the body owns gets 0 and 0 and never moves. Returns how many
 * vertices swing.
 */
export function bakeLegs(geo, skeleton) {
  const idx = geo.getAttribute('skinIndex')
  const wgt = geo.getAttribute('skinWeight')
  const pos = geo.getAttribute('position')
  const n = pos.count
  const legOf = new Int8Array(skeleton.bones.length).fill(-1)
  const hips = new Float32Array(LEGS * 3)
  skeleton.bones.forEach((b, i) => {
    const m = LEG_BONE.exec(b.name)
    if (!m) return
    const leg = (m[1] - 1) * 2 + (m[3] === 'L' ? 0 : 1)
    if (leg < 0 || leg >= LEGS) throw new Error(`bakeLegs: bone ${b.name} is not a leg 1 to ${LEGS / 2}`)
    legOf[i] = leg
    if (m[2] === 'Hip') {
      _mat.copy(skeleton.boneInverses[i]).invert()
      hips[leg * 3] = _mat.elements[12]; hips[leg * 3 + 1] = _mat.elements[13]; hips[leg * 3 + 2] = _mat.elements[14]
    }
  })
  const leg = new Int8Array(n)
  const dist = new Float32Array(n)
  const reach = new Float32Array(LEGS)
  let swing = 0
  for (let v = 0; v < n; v++) {
    let best = -1
    let bw = 0
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(v, k)
      if (w > bw) { bw = w; best = idx.getComponent(v, k) }
    }
    const l = best < 0 ? -1 : legOf[best]
    leg[v] = l
    if (l < 0) continue
    swing++
    dist[v] = Math.hypot(pos.getX(v) - hips[l * 3], pos.getY(v) - hips[l * 3 + 1], pos.getZ(v) - hips[l * 3 + 2])
    reach[l] = Math.max(reach[l], dist[v])
  }
  const out = new Float32Array(n * 2)
  for (let v = 0; v < n; v++) {
    const l = leg[v]
    if (l < 0) continue
    // Legs 1 and 3 of the left with 2 and 4 of the right; the other four half a cycle behind.
    out[v * 2] = ((l >> 1) + (l & 1)) % 2 === 0 ? 0 : Math.PI
    out[v * 2 + 1] = dist[v] / reach[l]
  }
  geo.setAttribute('aLeg', new THREE.Float32BufferAttribute(out, 2))
  return swing
}

export class Spiders {
  /**
   * @param height  V2Height: heightAt and snowLineAt (a host above the snow line carries none)
   * @param water   WaterSurfaces: isSubmerged (a host under water carries none) and levelAt (a wet face seats nobody)
   * @param opts.trees  Trees: trunksInto and trunkProfile
   * @param opts.rocks  Rocks: perchesInto and rayAt
   * @param opts.cards  the shared LitterCards: the far spiders are its instances, one per slot
   * @param opts.assets a loaded asset (loadSpiderGlb's shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, trees, rocks, assets = null, cards = null } = {}) {
    if (!cards || typeof cards.claim !== 'function') throw new Error('Spiders needs the LitterCards its far card is drawn by')
    if (!height || typeof height.heightAt !== 'function' || typeof height.snowLineAt !== 'function') throw new Error('Spiders needs a height field with heightAt and snowLineAt')
    if (!water || typeof water.levelAt !== 'function' || typeof water.isSubmerged !== 'function') throw new Error('Spiders needs WaterSurfaces, for levelAt and isSubmerged')
    if (!trees || typeof trees.trunksInto !== 'function' || !Array.isArray(trees.trunkProfile)) throw new Error('Spiders needs Trees, for trunksInto and trunkProfile')
    if (!rocks || typeof rocks.perchesInto !== 'function' || typeof rocks.rayAt !== 'function') throw new Error('Spiders needs Rocks, for perchesInto and rayAt')
    this.height = height
    this.water = water
    this.trees = trees
    this.rocks = rocks
    this.seed = seed

    // ONE material for every mesh spider, its legs in the vertex shader (the
    // header). The world's lighting patches it; its own splice runs first.
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aLeg;\nattribute vec2 aGait;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            // Forward is -Z: a positive swing carries the leg ahead of the body, and it lifts while it is swinging forward.
            'float legAt = aGait.x + aLeg.x;\n' +
            'float legSwing = aLeg.y * aGait.y;\n' +
            'transformed.z -= legSwing * sin( legAt );\n' +
            'transformed.y += 0.5 * legSwing * max( 0.0, cos( legAt ) );'
        )
      tierTintSplice(shader, MESH_TIER)
    }
    this.material.customProgramCacheKey = () => 'spiders-legs'
    // The tint (TINT_DARK, TINT_BROWN) through three's own vColor; made here so each program is keyed with it from the first draw.
    const makeTint = () => {
      const tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
      tint.setUsage(THREE.DynamicDrawUsage)
      return tint
    }
    // The near spiders: one InstancedMesh a drawn tier (there is one), each carrying every instance's gait and tint.
    this.meshes = []
    this.gaits = []
    for (let k = 0; k < LOD_TIERS; k++) {
      const mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
      mesh.name = `v2-spiders-lod${MESH_TIER + k}`
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.instanceColor = makeTint()
      this.meshes.push(mesh)
      const gait = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 2), 2)
      gait.setUsage(THREE.DynamicDrawUsage)
      this.gaits.push(gait)
    }
    this.counts = new Uint16Array(LOD_TIERS)
    // The far spiders, as instances of the shared litter quad, one per slot (a slot's id is its card's); drawn once the picture is baked, and until then every spider in range is a mesh and the rest are not drawn.
    cards.claim('spiders', CARD_CLAIM)
    this.litterCards = cards
    this.cardPicture = -1
    this.cardReady = false
    this.cardCount = 0
    this.cards = PropArena.over(cards.meshes, MAX, 'v2-spiders-card')
    for (let i = 0; i < MAX; i++) {
      this.cards.addInstance(0)
      this.cards.setVisibleAt(i, false)
    }
    // The layer toggle flips the group.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-spiders'
    for (const mesh of this.meshes) this.batch.add(mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, host: null,
        // Which of its host's rolled group it is, for the taken registry.
        member: 0,
        x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, tx: 0, ty: 1, tz: 0,
        // On a tree: the angle round the trunk, the height over the tree's origin, the heading in the (up, round) plane, the bark's local radius there.
        ang: 0, h: 0, phi: 0, r: 1,
        size: 0.2,
        // The tint, linear RGB (`r` is the bark radius above).
        tr: 1, tg: 1, tb: 1,
        // Its name on the score, the grid offset that name hashes to, and the shift that opens its first spell at the second it last calmed down (0 for one that has never fled). (u0, v0) is the seat it took its life up on -- the one it was dealt, or where it calmed -- which its wander is anchored through (su, sv) to pass through, and which every seat falls back on.
        key: '', offset: 0, epoch: 0, u0: 0, v0: 0, su: 0, sv: 0,
        // The spell it is playing, the phrase within it and the seconds into that phrase; null before its first frame.
        spell: null, phrase: null, elapsed: 0,
        // 'go' crosses to the phrase's waypoint at `speed` metres a second playing `clip`; 'pause' holds at speed 0, playing `clip`; 'flee' is a 'go' at the run, away from a body, on the world's ticks rather than the score's phrases and ended by distance or by stalling.
        state: 'pause', clip: 'idle', speed: 0,
        // Fleeing: where it is making for, how far off it was last tick, and the seconds it has gone without closing on it. `near` is whether a body was within FLEE_M last frame. The flight steps at TICK_HZ on absolute world ticks: `tick` is the last one taken and `alpha` how far the frame is past it, for the draw to lead by. `bolt` is the column a released spider runs from -- fixed at the release, so every client runs the one flight -- and null for a flight a body startled, which re-aims at that body as it moves.
        ex: 0, ey: 0, ez: 0, togo: 0, stall: 0, near: false, tick: 0, alpha: 0, bolt: null,
        // Its rung on the arc ladder (-1 before its first frame) and the mesh tier it is drawn at, LOD_TIERS for the card; the legs' phase, the phase it rolled to start from and their swing amplitude; how far it has reared, 0 to 1; its world matrix, and whether that trails its seat.
        cardOn: false, cardStamp: -1, rung: -1, lod: LOD_TIERS, gait: 0, gait0: 0, amp: 0, rear: 0, m: new Float32Array(16), dirty: true,
      })
    }
    this.free = this.slots.slice()
    // The releases owed to the room (pending), and the drop key of every release made here, hers or a peer's, so one heard twice lets one spider go.
    this.outbox = []
    this.drops = new Set()
    // Set while a peer's release is being made here: it is theirs, and is not owed back to the room.
    this.applying = false
    // The spiders that set off fleeing this frame, for startled().
    this.startles = []
    // The bodies a spider flees this frame -- hers, then every peer's -- each `{ x, z, lo, hi }`, the axis of its capsule. A pool, so a frame allocates nothing.
    this.players = []
    this.playerPool = []
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    // The world second the last frame was drawn at, which is all a flight's step needs of the clock, and how many spells have been planned.
    this.now = 0
    this.spells = 0
    this.trunkBuf = new Float32Array(HOST_BUF * TRUNK_STRIDE)
    this.perchBuf = new Float32Array(HOST_BUF * PERCH_STRIDE)
    this.asset = null
    this.bounds = null
    this.span = 1
    this.bodyH = 0
    this.loaded = false
    // Spiders that found no free slot; hosts past a tile buffer's end; rock spiders whose stone went from under them.
    this.overflow = 0
    this.saturated = 0
    this.dropped = 0

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadSpiderGlb(CRITTER_GLB.spider))
    return true
  }

  /** The drawn tier with its legs baked (bakeLegs) onto the mesh, the map onto the material, the pick's bounds onto the card. A skeleton naming no legs is a shipping bug. */
  setAsset(asset) {
    if (asset.tiers.length <= MESH_TIER) throw new Error(`Spiders.setAsset: at least ${MESH_TIER + 1} tiers, got ${asset.tiers.length}`)
    this.asset = asset
    const geo = asset.tiers[0]
    geo.computeBoundingBox()
    const b = geo.boundingBox
    this.bounds = { span: Math.max(b.max.x - b.min.x, b.max.z - b.min.z), height: b.max.y - b.min.y, halfX: (b.max.x - b.min.x) / 2, halfZ: (b.max.z - b.min.z) / 2 }
    this.span = this.bounds.span
    this.bodyH = this.bounds.height
    this.material.map = asset.map
    this.material.needsUpdate = true
    for (let k = 0; k < LOD_TIERS; k++) {
      const tier = asset.tiers[MESH_TIER + k]
      if (bakeLegs(tier, asset.skeleton) === 0) throw new Error(`Spiders.setAsset: tier ${MESH_TIER + k} has no vertex on a Leg bone -- the skeleton must name its legs Leg{1..4}{Hip,Knee,Ankle,Foot}.{L,R} (loaded as Leg1HipL: GLTFLoader strips the dot)`)
      tier.setAttribute('aGait', this.gaits[k])
      this.meshes[k].geometry = tier
    }
    // Every kept matrix was scaled by the old span.
    for (const c of this.slots) c.dirty = true
    // The card lies flat: the top view is the shared quad turned down about X, so the picture's up is -Z, centred at the body's middle height.
    const ext = critterCardExtents(this.bounds)
    this.cardLift = (ext.y0 + ext.y1) / 2
    if (this.cardPicture < 0) {
      this.cardPicture = this.litterCards.addPicture({ kind: 'fixed', cx: 0, cy: 0, hw: ext.hx, hh: ext.hz })
      for (let i = 0; i < MAX; i++) this.cards.setLayerShiftAt(i, this.cardPicture)
    }
    this.loaded = true
  }

  /** Photograph the bind pose from above onto the card and start drawing the far spiders. Once, after `ready`. */
  bakeCard(renderer) {
    if (!this.loaded) throw new Error('Spiders.bakeCard: the asset has not landed')
    const texture = bakeCritterCard(renderer, this.asset.tiers[0], this.asset.map, this.bounds, ['top'])
    this.litterCards.setCritterPixels(this.cardPicture, texture.image.data)
    texture.dispose()
    this.setCard()
  }

  /** Start drawing the far spiders (the picture is in the pool). */
  setCard() {
    this.cardReady = true
  }

  /** Draw the whole layer or none of it; the far cards are shared instances, so the batch's `visible` alone would leave them. */
  setShown(shown) {
    this.batch.visible = shown
    this.cards.setShown(shown)
  }

  _enter(tx, tz) {
    const t = { tx, tz, hosts: new Map() }
    this._scan(t)
    return t
  }

  /** Add every host in the tile this tile has not seen. Idempotent, so a rescan costs nothing new. */
  _scan(t) {
    const x0 = t.tx * TILE
    const z0 = t.tz * TILE
    const trunks = this.trees.trunksInto(x0, z0, x0 + TILE, z0 + TILE, this.trunkBuf)
    if (trunks === HOST_BUF) this.saturated++
    for (let i = 0; i < trunks; i++) {
      const o = i * TRUNK_STRIDE
      const r0 = this.trunkBuf[o + 3]
      if (r0 < TRUNK_MIN_R) continue
      const yaw = this.trunkBuf[o + 5]
      const prof = this.trees.trunkProfile[this.trunkBuf[o + 6]]
      if (!prof) throw new Error(`Spiders: trunk variant ${this.trunkBuf[o + 6]} has no trunkProfile`)
      this._host(t, 'tree', this.trunkBuf[o], this.trunkBuf[o + 2], { y: this.trunkBuf[o + 1], r0, scale: this.trunkBuf[o + 4], stretch: this.trunkBuf[o + 7], cy: Math.cos(yaw), sy: Math.sin(yaw), prof, hLo: 0, hHi: 0 })
    }
    const perches = this.rocks.perchesInto(x0, z0, x0 + TILE, z0 + TILE, this.perchBuf)
    if (perches === HOST_BUF) this.saturated++
    for (let i = 0; i < perches; i++) {
      const o = i * PERCH_STRIDE
      const size = this.perchBuf[o + 4]
      if (size < ROCK_MIN_SIZE) continue
      this._host(t, 'rock', this.perchBuf[o], this.perchBuf[o + 2], { r: this.perchBuf[o + 3], size })
    }
    // The ground's one point a tile, seeded off the tile's corner.
    const g = mulberry32(hostSeed(x0, z0, this.seed ^ 0x6a1))
    this._host(t, 'ground', x0 + g() * TILE, z0 + g() * TILE, {})
  }

  /**
   * One host, and its group if it carries one. A tree, a rock and the ground's
   * point at the same quantised origin are three hosts. A host seen before only
   * has its origin refreshed: a tree re-seats with its chunk, and its spiders
   * follow it.
   */
  _host(t, kind, x, z, shape) {
    const key = hostKey(x, z) + KIND_KEY[kind]
    const had = t.hosts.get(key)
    if (had) {
      // A trunk re-seated with its chunk: its band is re-read and its sitting spiders are re-placed on it this frame.
      if (kind === 'tree' && had.y !== shape.y) { had.y = shape.y; this._treeBand(had); had.moved = true }
      return
    }
    const groundY = this.height.heightAt(x, z)
    const host = { kind, x, z, groundY, ...shape, spiders: [], moved: false }
    t.hosts.set(key, host)
    if (this.water.isSubmerged(x, z, groundY)) return
    if (groundY > this.height.snowLineAt(x, z)) return
    if (kind === 'tree' && !this._treeBand(host)) return
    const rand = mulberry32(hostSeed(x, z, this.seed ^ (kind === 'tree' ? 0x7e3 : kind === 'rock' ? 0x0c4 : 0x3b9)))
    if (rand() >= HOST_CHANCE[kind]) return
    const [lo, hi] = GROUP[kind]
    const count = lo + Math.floor(rand() * (hi - lo + 1))
    for (let k = 0; k < count; k++) {
      const size = between(rand, SIZE_M) * (kind === 'ground' ? GROUND_SCALE : 1)
      const shade = 1 - (1 - TINT_DARK) * rand()
      const warm = rand()
      const c = this.free.pop()
      if (!c) { this.overflow++; return }
      c.host = host
      const seated = kind === 'tree' ? this._seatTree(c, host, rand) : kind === 'rock' ? this._seatRock(c, host, rand) : this._seatGround(c, host, rand)
      if (!seated) { c.host = null; this.free.push(c); continue }
      c.size = size
      c.tr = shade; c.tg = shade * (1 - TINT_BROWN.g * warm); c.tb = shade * (1 - TINT_BROWN.b * warm)
      c.rung = -1
      c.lod = LOD_TIERS
      c.gait = c.gait0 = rand() * TAU
      c.amp = 0
      c.rear = 0
      c.near = false
      c.state = 'pause'
      c.clip = 'idle'
      c.speed = 0
      c.dirty = true
      // Its name on the score: every spell of its life follows from that and the world clock, so it is doing the same thing on every client that has this trunk.
      c.key = seatKey(host, k)
      c.offset = keyHash(c.key) % SPELL_S[kind]
      c.epoch = 0
      c.spell = null
      this._anchor(c)
      c.member = k
      // After every roll, so one she picked off leaves the rest of its group as it grew.
      if (taken.has(`spider:${kind}${k}`, host.x, host.z)) { c.host = null; this.free.push(c); continue }
      host.spiders.push(c)
    }
  }

  /**
   * The drawn spider nearest a hand at (x, y, z) whose body -- a ball of its
   * own size -- is within `reach` metres: `{ dist, c, size }` for take(), or
   * null. For hands.js.
   */
  pickAt(x, y, z, reach) {
    let best = null
    let bestD = reach
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) {
        for (const c of host.spiders) {
          if (c.rung < 0 || c.rung >= CARD_RUNGS) continue
          const d = Math.hypot(c.x - x, c.y - y, c.z - z) - c.size * 0.5
          if (d < bestD) {
            bestD = d
            best = { dist: Math.max(0, d), c, size: c.size }
          }
        }
      }
    }
    return best
  }

  /**
   * Pick the spider of a pickAt() hit off its host: its slot goes back to the
   * pool, its place in its host's group is recorded so the host never regrows
   * it, and what the hand holds is returned as a record for hands.js -- the
   * drawn tier's geometry, the shared material, the legs at rest, its tint
   * and its size's scale.
   */
  take(hit) {
    const c = hit.c
    const host = c.host
    if (!host) throw new Error(`Spiders.take: slot ${c.id} has no host`)
    const k = host.spiders.indexOf(c)
    if (k < 0) throw new Error(`Spiders.take: slot ${c.id} is not in its host's group`)
    taken.add(`spider:${host.kind}${c.member}`, host.x, host.z)
    host.spiders.splice(k, 1)
    c.host = null
    this.free.push(c)
    const s = c.size / this.span
    return {
      kind: 'spider',
      name: 'spider',
      size: c.size,
      geometry: this.asset.tiers[MESH_TIER],
      material: this.material,
      attrs: { aGait: [c.gait, 0] },
      color: [c.tr, c.tg, c.tb],
      scale: [s, s, s],
      stowable: true,
    }
  }

  /**
   * A peer picked the spider named by `spider:<host kind><member>` off the
   * host at (x, z): pick it off here too, drawn or not, and record the place.
   * True when a resident tile has that host with that member. For hands-net.js.
   */
  evict(key, x, z) {
    if (!key.startsWith('spider:')) return false
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) {
        if (Math.abs(host.x - x) >= TOLERANCE_M || Math.abs(host.z - z) >= TOLERANCE_M) continue
        for (const c of host.spiders) {
          if (`spider:${host.kind}${c.member}` !== key) continue
          this.take({ dist: 0, c, size: c.size })
          return true
        }
      }
    }
    return false
  }

  /** The geometry and material a packed spider record is drawn with, or null until the asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'spider') throw new Error(`Spiders.dress: not a spider, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.asset.tiers[MESH_TIER], material: this.material }
  }

  /**
   * Let a taken spider go at (x, _, z): it lands on the ground there, on a
   * host of its own in the tile under it, and runs from her the way a ground
   * spider does. False when no tile is resident there, the ground is under
   * water or snow, or the pool is empty, and hands.js drops it as a thing.
   * The drop is owed to the room (pending), which is the only way the other
   * client is told of it at all.
   */
  release(rec, x, y, z, head, now = this.now) {
    if (rec.kind !== 'spider') throw new Error(`Spiders.release: not a spider, ${rec.kind}`)
    x = snap(x); y = snap(y); z = snap(z)
    const hx = snap(head.x), hz = snap(head.z)
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t) return false
    const groundY = this.height.heightAt(x, z)
    if (this.water.isSubmerged(x, z, groundY) || groundY > this.height.snowLineAt(x, z)) return false
    const key = hostKey(x, z) + LOOSE_KEY
    let host = t.hosts.get(key)
    if (!host) {
      host = { kind: 'ground', x, z, groundY, spiders: [], moved: false }
      t.hosts.set(key, host)
    }
    const c = this.free.pop()
    if (!c) { this.overflow++; return false }
    c.host = host
    c.member = -1
    c.size = rec.size
    c.tr = rec.color[0]; c.tg = rec.color[1]; c.tb = rec.color[2]
    c.rung = -1
    c.lod = LOD_TIERS
    c.gait = c.gait0 = rec.attrs.aGait[0]
    c.amp = 0
    c.rear = 0
    c.near = false
    c.phi = 0
    c.key = restKey(x, groundY, z)
    c.offset = keyHash(c.key) % SPELL_S.ground
    c.epoch = 0
    c.u0 = x
    c.v0 = z
    c.spell = null
    this._anchor(c)
    this._placeGround(c, x, z)
    this._flee(c, hx, head.y, head.y, hz, now, true)
    host.spiders.push(c)
    this._owe(c.key, now, x, y, z, Math.atan2(x - hx, z - hz), hx, hz, c.size, c.tr, c.tg, c.tb, c.gait0)
    return true
  }

  /** A spider let go here goes to the room as one anchor in mode DROP; one heard from the room is only remembered, so it is not sent back. */
  _owe(key, T, x, y, z, yaw, hx, hz, size, r, g, b, gait) {
    this.drops.add(key)
    if (this.applying) return
    this.outbox.push([dropWire(PREFIX, key), T, x, y, z, yaw, 0, DROP, null, hx, hz, size, r, g, b, gait])
  }

  /** The releases this client owes the room since the last call, moved into `into`. For creature-net.js. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /**
   * A spider a peer let go: put on the ground here where their hand let it go
   * and bolting from where their head was, so both clients see it land and
   * run. A drop already made here -- this client's own, come back on a fresh
   * welcome -- is nothing. Where no tile is resident, or the ground there is
   * under water or snow, it is refused and this client never sees that spider.
   * The bolt runs from the second on the wire, on the world's ticks, so a
   * client told of it late catches those ticks up and the two run it stride
   * for stride to the same stopping place. For creature-net.js.
   */
  apply(anchor, now) {
    const [, T, x, y, z, , , mode, by, hx, hz, size, r, g, b, gait] = anchor
    if (by === null) return
    if (mode !== DROP) throw new Error(`Spiders: no anchor mode ${mode}`)
    if (![T, x, y, z, hx, hz, size, r, g, b, gait].every(Number.isFinite)) throw new Error(`Spiders: a drop short of its numbers: ${JSON.stringify(anchor)}`)
    if (this.drops.has(restKey(x, this.height.heightAt(x, z), z))) return
    this.applying = true
    try {
      this.release({ kind: 'spider', size, color: [r, g, b], attrs: { aGait: [gait] } }, x, y, z, { x: hx, y, z: hz }, T)
    } finally {
      this.applying = false
    }
  }

  /**
   * The climb on a tree as heights over the tree's origin: from just above the
   * ground (or the origin, where the tree stands on a rock) to CLIMB_M up, and
   * never past where the bark thins under TRUNK_MIN_R -- the same floor the
   * base is held to, found between the two rings it thins across. False where
   * the band is empty: a trunk buried to its rings, or too thin above the ground.
   */
  _treeBand(host) {
    const { y, radius } = host.prof
    const foot = Math.max(host.groundY, host.y)
    host.hLo = foot - host.y + 0.02
    const rMin = TRUNK_MIN_R / host.scale
    let r = y.length - 1
    while (r > 0 && radius[r] < rMin) r--
    let top = y[r]
    if (r < y.length - 1) top += ((y[r + 1] - y[r]) * (radius[r] - rMin)) / (radius[r] - radius[r + 1])
    host.hHi = Math.min(foot - host.y + CLIMB_M, top * host.scale * host.stretch)
    return host.hHi > host.hLo
  }

  /** The seat a tree spider is dealt, kept as `u0`, `v0`: the one its spells fall back on where the wander finds nowhere to stand. */
  _seatTree(c, host, rand) {
    c.ang = c.u0 = rand() * TAU
    c.h = c.v0 = between(rand, [host.hLo, host.hHi])
    c.phi = rand() * TAU
    this._placeTree(c)
    return true
  }

  /** Spider `c` onto its own bark coordinates. */
  _placeTree(c) {
    this._barkAt(c.host, c.ang, c.h, c.phi, c)
    c.dirty = true
  }

  /**
   * A point on a trunk's bark from an angle round it and a height up it, into
   * `out`: the world seat, normal and heading, and `r`, the bark's radius
   * there -- how far a metre round the trunk turns the angle. The point lies
   * between the four profile corners round it, in the instance's frame
   * (scaled, its Y stretched on top, yawed, at its origin), and the heading is
   * `phi` from the bark's up direction toward its round direction. Nothing is
   * read off `out`, so it answers for any point on any trunk, not only for
   * where a spider sits.
   */
  _barkAt(host, ang, h, phi, out) {
    const { sides, y, centre, corners } = host.prof
    // The profile's rings are at unit height; the stretch is applied to every
    // corner Y below, so the seat, its tangents and its normal are the drawn bark's.
    const st = host.stretch
    const fh = h / (host.scale * st)
    let r = 0
    while (r < y.length - 2 && y[r + 1] <= fh) r++
    const fr = Math.min(1, Math.max(0, (fh - y[r]) / (y[r + 1] - y[r])))
    const ka = ((((ang / TAU) % 1) + 1) % 1) * sides
    const k0 = Math.floor(ka) % sides
    const k1 = (k0 + 1) % sides
    const fk = ka - Math.floor(ka)
    const a0 = (r * sides + k0) * 3
    const a1 = (r * sides + k1) * 3
    const b0 = ((r + 1) * sides + k0) * 3
    const b1 = ((r + 1) * sides + k1) * 3
    // Round the ring at either level, then between the levels. `u` is the step between the levels (up the bark) and `v` the step round the ring there, the surface's two tangents.
    const rax = corners[a1] - corners[a0], ray = (corners[a1 + 1] - corners[a0 + 1]) * st, raz = corners[a1 + 2] - corners[a0 + 2]
    const rbx = corners[b1] - corners[b0], rby = (corners[b1 + 1] - corners[b0 + 1]) * st, rbz = corners[b1 + 2] - corners[b0 + 2]
    const lx = corners[a0] + rax * fk, ly = corners[a0 + 1] * st + ray * fk, lz = corners[a0 + 2] + raz * fk
    let ux = corners[b0] + rbx * fk - lx, uy = corners[b0 + 1] * st + rby * fk - ly, uz = corners[b0 + 2] + rbz * fk - lz
    const px = lx + ux * fr, py = ly + uy * fr, pz = lz + uz * fr
    let vx = rax + (rbx - rax) * fr, vy = ray + (rby - ray) * fr, vz = raz + (rbz - raz) * fr
    // The normal, pointed away from the ring's centre whichever way the generator wound its corners.
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const cx = centre[r * 3] + (centre[(r + 1) * 3] - centre[r * 3]) * fr
    const cz = centre[r * 3 + 2] + (centre[(r + 1) * 3 + 2] - centre[r * 3 + 2]) * fr
    if (nx * (px - cx) + nz * (pz - cz) < 0) { nx = -nx; ny = -ny; nz = -nz }
    let len = Math.hypot(nx, ny, nz)
    if (!(len > 1e-9)) throw new Error('Spiders: a trunk profile ring is degenerate')
    nx /= len; ny /= len; nz /= len
    // The bark's up and round directions, orthogonal to the normal and each other.
    len = Math.hypot(ux, uy, uz)
    ux /= len; uy /= len; uz /= len
    const dv = vx * ux + vy * uy + vz * uz
    vx -= ux * dv; vy -= uy * dv; vz -= uz * dv
    len = Math.hypot(vx, vy, vz)
    out.r = ((len * sides) / TAU) * host.scale
    vx /= len; vy /= len; vz /= len
    const cp = Math.cos(phi)
    const sp = Math.sin(phi)
    const tx = ux * cp + vx * sp, ty = uy * cp + vy * sp, tz = uz * cp + vz * sp
    // Into the world: scaled, turned by the yaw about +Y, from the origin.
    const s = host.scale, cy = host.cy, sy = host.sy
    out.x = host.x + s * (px * cy + pz * sy)
    out.y = host.y + s * py
    out.z = host.z + s * (pz * cy - px * sy)
    out.nx = nx * cy + nz * sy; out.ny = ny; out.nz = nz * cy - nx * sy
    out.tx = tx * cy + tz * sy; out.ty = ty; out.tz = tz * cy - tx * sy
    return out
  }

  /**
   * Rocks.rayAt, answering true only for a face a spider could stand on, in
   * `_hit`: not a ceiling, clear of the ground and the water under it, within
   * the climb. The ray may land on any rock ROCK_MIN_SIZE and up, the host's
   * or its neighbour's; the ground and the water are read under the hit.
   */
  _rockRay(x, y, z, dx, dy, dz, reach) {
    if (this.rocks.rayAt(x, y, z, dx, dy, dz, reach, ROCK_MIN_SIZE, _hit) === Infinity) return false
    if (_hit.ny < HANG_NY) return false
    const h = _hit.y - this.height.heightAt(_hit.x, _hit.z)
    if (h < 0.02 || h > CLIMB_M) return false
    const level = this.water.levelAt(_hit.x, _hit.z)
    return level === null || _hit.y >= level + WET_M
  }

  /**
   * A seat on a rock's side: a horizontal ray from outside the hull's disc in
   * toward the axis at the wanted height, the hit and its outward normal the
   * seat. A hit whose normal rises past FLAT_NY -- the top, or a shelf -- is
   * kept one time in ten; a ray that finds no standable stone (the height is
   * above the rock, the face is undercut, buried or wet there) tries again
   * lower, up to eight times. The seat holds only where the same ray WALL_M
   * higher, or failing that WALL_M lower, finds a side face too: a stone with
   * no wall to climb is no host.
   */
  _seatRock(c, host, rand) {
    let hMax = Math.min(CLIMB_M, host.size)
    for (let a = 0; a < 8; a++) {
      const ang = rand() * TAU
      const h = between(rand, [0.05, hMax])
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      const reach = host.r * 1.3
      const ox = host.x + ca * reach
      const oz = host.z + sa * reach
      if (!this._rockRay(ox, host.groundY + h, oz, -ca, 0, -sa, reach)) { hMax = Math.max(0.1, h); continue }
      if (_hit.ny > FLAT_NY && rand() >= FLAT_CHANCE) continue
      c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
      c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
      const wall = (this._rockRay(ox, c.y + WALL_M, oz, -ca, 0, -sa, reach) && _hit.ny <= FLAT_NY)
        || (this._rockRay(ox, c.y - WALL_M, oz, -ca, 0, -sa, reach) && _hit.ny <= FLAT_NY)
      if (!wall) continue
      c.u0 = ang
      c.v0 = c.y - host.groundY
      this._heading(c, rand() * TAU)
      c.dirty = true
      return true
    }
    return false
  }

  /** Onto `_hit`, the heading kept in the new tangent plane. */
  _snapRock(c) {
    c.x = _hit.x; c.y = _hit.y; c.z = _hit.z
    c.nx = _hit.nx; c.ny = _hit.ny; c.nz = _hit.nz
    c.dirty = true
    const dot = c.tx * c.nx + c.ty * c.ny + c.tz * c.nz
    c.tx -= c.nx * dot; c.ty -= c.ny * dot; c.tz -= c.nz * dot
    const len = Math.hypot(c.tx, c.ty, c.tz)
    if (len < 1e-3) { this._heading(c, c.phi); return }
    c.tx /= len; c.ty /= len; c.tz /= len
  }

  /** A rock face's tangent plane at `c`'s normal, into `_up` and `_rt`: world up with the normal's share removed (or world X on a flat face), and n x u. */
  _tangents(c) {
    let ux = -c.ny * c.nx, uy = 1 - c.ny * c.ny, uz = -c.ny * c.nz
    let len = Math.hypot(ux, uy, uz)
    if (len < 1e-3) { ux = 1 - c.nx * c.nx; uy = -c.nx * c.ny; uz = -c.nx * c.nz; len = Math.hypot(ux, uy, uz) }
    _up.x = ux / len; _up.y = uy / len; _up.z = uz / len
    _rt.x = c.ny * _up.z - c.nz * _up.y
    _rt.y = c.nz * _up.x - c.nx * _up.z
    _rt.z = c.nx * _up.y - c.ny * _up.x
  }

  /** A rock spider's heading: the angle `phi` in its tangent plane, measured from the plane's upmost direction (or from world X on a flat face). */
  _heading(c, phi) {
    this._tangents(c)
    const cp = Math.cos(phi)
    const sp = Math.sin(phi)
    c.tx = _up.x * cp + _rt.x * sp
    c.ty = _up.y * cp + _rt.y * sp
    c.tz = _up.z * cp + _rt.z * sp
    c.phi = phi
    c.dirty = true
  }

  /** A rock spider turned to the world direction (wx, wy, wz), laid into its tangent plane; `phi` follows it, so a flee picks up from the heading it was crawling on. */
  _headTo(c, wx, wy, wz) {
    this._tangents(c)
    this._heading(c, Math.atan2(wx * _rt.x + wy * _rt.y + wz * _rt.z, wx * _up.x + wy * _up.y + wz * _up.z))
  }

  /** A seat on the ground at the tile's point, heading anywhere. */
  _seatGround(c, host, rand) {
    c.u0 = host.x
    c.v0 = host.z
    this._placeGround(c, host.x, host.z)
    this._headGround(c, rand() * TAU)
    return true
  }

  /** A ground spider's seat at (x, z): the height there, and the field's normal from its slopes GROUND_EPS either way. The heading is re-laid on the new plane. */
  /** Whether the ground at (x, z) is barred to a spider: under water, or over the snow line. */
  _barred(x, z) {
    const y = this.height.heightAt(x, z)
    return this.water.isSubmerged(x, z, y) || y > this.height.snowLineAt(x, z)
  }

  _placeGround(c, x, z) {
    c.x = x; c.z = z
    c.y = this._groundNormal(x, z, c)
    this._headGround(c, c.phi)
  }

  /** The ground's normal at (x, z) into `out`, from its slopes GROUND_EPS either way; returns the height there. */
  _groundNormal(x, z, out) {
    const h = this.height
    const nx = h.heightAt(x - GROUND_EPS, z) - h.heightAt(x + GROUND_EPS, z)
    const nz = h.heightAt(x, z - GROUND_EPS) - h.heightAt(x, z + GROUND_EPS)
    const ny = 2 * GROUND_EPS
    const len = Math.hypot(nx, ny, nz)
    out.nx = nx / len; out.ny = ny / len; out.nz = nz / len
    return h.heightAt(x, z)
  }

  /** A ground spider's heading: the azimuth `phi` -- +Z at 0, +X at a quarter turn -- laid into the ground's plane. */
  _headGround(c, phi) {
    let tx = Math.sin(phi), ty = 0, tz = Math.cos(phi)
    const dot = tx * c.nx + tz * c.nz
    tx -= c.nx * dot; ty -= c.ny * dot; tz -= c.nz * dot
    const len = Math.hypot(tx, ty, tz)
    if (len < 1e-3) throw new Error('Spiders: the ground is a wall under a spider')
    c.tx = tx / len; c.ty = ty / len; c.tz = tz / len
    c.phi = phi
    c.dirty = true
  }

  _leave(t) {
    for (const host of t.hosts.values()) {
      for (const c of host.spiders) {
        c.host = null
        this.free.push(c)
      }
      host.spiders.length = 0
    }
    t.hosts.clear()
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.rescan = []
    this.overflow = 0
    this.saturated = 0
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let hosts = 0
    let groups = 0
    for (const t of this.tiles.values()) {
      hosts += t.hosts.size
      for (const h of t.hosts.values()) if (h.spiders.length) groups++
    }
    return {
      alive: MAX - this.free.length, tiles: this.tiles.size, hosts, groups,
      meshes: this.meshes.map((m) => m.count), cards: this.cardCount, overflow: this.overflow, saturated: this.saturated, dropped: this.dropped, spells: this.spells,
    }
  }

  /**
   * Every spider living this frame, for the ear (audio/ambience.js): the slots
   * themselves, with x, y, z, size and speed on them, `speed > 0` meaning it is
   * crawling. A hidden layer is frozen and lists nothing.
   */
  bodies(into) {
    if (!this.batch.visible) return into
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) for (const c of host.spiders) into.push(c)
    }
    return into
  }

  /** The spiders that took fright this frame, for the ear: the same slots as bodies(), each once, as it sets off. A hidden layer lists nobody. */
  startled(into) {
    if (!this.batch.visible) return into
    for (const c of this.startles) into.push(c)
    return into
  }

  /**
   * A smooth wander in the spell index, 0 to 1: a corner hashed off the
   * spider's key every `segs` spells, eased between with a smoothstep. `axis`
   * picks the stream, so a seat's two coordinates wander apart. Pure in (key,
   * seg), and one spell moves it about 1.5/segs of the range -- a fraction of
   * the band, which is all a spider can crawl in that time.
   */
  _wave(key, axis, seg, segs) {
    const t = seg / segs
    const i = Math.floor(t)
    const f = t - i
    const a = phraseRand(key, i, axis)()
    const b = phraseRand(key, i + 1, axis)()
    return a + (b - a) * f * f * (3 - 2 * f)
  }

  /**
   * The two host coordinates on `out` to a world seat and normal, and on a
   * trunk the bark's radius there. False where there is nowhere a spider could
   * stand: a rock's undercut, buried or wet side, water or snow over the
   * ground. `flat` false also turns down a rock's upward faces, the top and
   * its shelves, which a seat only takes FLAT_CHANCE of the time.
   */
  _resolve(c, out, flat = true) {
    const host = c.host
    if (host.kind === 'tree') { this._barkAt(host, out.u, out.v, 0, out); return true }
    if (host.kind === 'rock') {
      const ca = Math.cos(out.u), sa = Math.sin(out.u)
      const reach = host.r * 1.3
      if (!this._rockRay(host.x + ca * reach, host.groundY + out.v, host.z + sa * reach, -ca, 0, -sa, reach)) return false
      if (!flat && _hit.ny > FLAT_NY) return false
      out.x = _hit.x; out.y = _hit.y; out.z = _hit.z
      out.nx = _hit.nx; out.ny = _hit.ny; out.nz = _hit.nz
      return true
    }
    if (this._barred(out.u, out.v)) return false
    out.x = out.u; out.z = out.v
    out.y = this._groundNormal(out.u, out.v, out)
    return true
  }

  /**
   * The band spider `c`'s seat wanders in, into `_ax`: round and up a trunk or
   * a rock, east and north within GROUND_ROAM_M of the point it took its life
   * up on. A trunk's climb and a rock's side are walls; the ground's is a
   * tether, and both are folded rather than clamped (see `fold`).
   */
  _axes(c) {
    const host = c.host
    if (host.kind === 'ground') {
      // The square of east and north the seat wanders is the one inscribed in the roam, so its corners are GROUND_ROAM_M from the point and no seat is further.
      const roam = GROUND_ROAM_M * Math.SQRT1_2
      _ax.ulo = c.u0 - roam; _ax.urange = 2 * roam
      _ax.vlo = c.v0 - roam; _ax.vrange = 2 * roam
      _ax.wrap = false
      return _ax
    }
    // Two turns of the wander over one of the trunk, so the seam at zero is no wall.
    _ax.ulo = 0; _ax.urange = TAU * 2; _ax.wrap = true
    if (host.kind === 'tree') { _ax.vlo = host.hLo; _ax.vrange = host.hHi - host.hLo }
    else { _ax.vlo = 0.05; _ax.vrange = Math.max(0.05, Math.min(CLIMB_M, host.size) - 0.05) }
    return _ax
  }

  /**
   * The shift that carries spider `c`'s wander through (u0, v0) at the turn of
   * its first spell. Every seat of its life is the wander plus this, so its
   * first spell opens exactly where it is standing -- on the seat it was dealt,
   * or where it calmed down from a flight -- and steps off from there, rather
   * than starting with a crossing of the whole band it has no time to make.
   */
  _anchor(c) {
    const a = this._axes(c)
    const segs = WANDER_SEGS[c.host.kind]
    c.su = c.u0 - a.ulo - this._wave(c.key, 0, 0, segs) * a.urange
    c.sv = c.v0 - a.vlo - this._wave(c.key, 1, 0, segs) * a.vrange
  }

  /**
   * Spider `c`'s seat at the turn of spell `seg`, into `out`: its anchored
   * wander, folded into the band. Where there is nothing to stand on there --
   * a rock's undercut side, water or snow over the ground -- the point is
   * drawn in toward the seat it was dealt, which always held, up to SEAT_TRIES
   * times, and that seat is the last resort. Null only where even that has
   * gone, the rock having re-split out from under it, and the spider is taken
   * away.
   */
  _seatAt(c, seg, out) {
    const a = this._axes(c)
    const segs = WANDER_SEGS[c.host.kind]
    const wu = this._wave(c.key, 0, seg, segs) * a.urange + c.su
    const wv = this._wave(c.key, 1, seg, segs) * a.vrange + c.sv
    const u = a.ulo + (a.wrap ? wu : fold(wu, a.urange))
    const v = a.vlo + fold(wv, a.vrange)
    const flat = phraseRand(c.key, seg, 7)() < FLAT_CHANCE
    for (let k = 0; k < SEAT_TRIES; k++) {
      const f = k / SEAT_TRIES
      out.u = u + (c.u0 - u) * f
      out.v = v + (c.v0 - v) * f
      if (this._resolve(c, out, flat)) return out
    }
    out.u = c.u0; out.v = c.v0
    return this._resolve(c, out) ? out : null
  }

  /**
   * Spell `seg` of spider `c`, planned outright from its key: the crossing from
   * the seat it holds at this turn to the one it holds at the next, broken into
   * SCOOTS scoots through waypoints jittered off the straight line, each a sit
   * and then a crawl. The scoots take what they take at their clip's pace and
   * the sits share out what is left, so the spell ends on its seat whatever the
   * distances; a crossing too long for the spell is crawled faster and its sits
   * go to nothing. Nothing here reads where the spider is or was, so a client
   * meeting it mid-crawl plans the same spell and crosses the rest of it alike.
   */
  _spell(c, seg) {
    const host = c.host
    const kind = host.kind
    const span = SPELL_S[kind]
    const a = this._seatAt(c, seg, _seatA)
    if (a === null) return null
    const pts = [{ ...a }]
    const b = this._seatAt(c, seg + 1, _seatB)
    if (b === null) return null
    let du = b.u - a.u
    if (kind !== 'ground') du -= TAU * Math.round(du / TAU)
    const dv = b.v - a.v
    const [ju, jv] = JITTER[kind]
    const n = SCOOTS[kind]
    for (let i = 1; i < n; i++) {
      const rand = phraseRand(c.key, seg, i)
      const f = i / n
      const mu = a.u + du * f
      const mv = a.v + dv * f
      const w = this._waypoint(c, mu + (rand() - 0.5) * ju, mv + (rand() - 0.5) * jv) ?? this._waypoint(c, mu, mv)
      if (w) pts.push(w)
    }
    pts.push({ ...b })

    // Each scoot at its own clip's pace, and a sit before it of the length that clip wants; nothing is written until both are known, because the sits are only as long as the crossing leaves room for.
    const legs = []
    let go = 0
    let sit = 0
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], q = pts[i]
      const rand = phraseRand(c.key, seg, 32 + i)
      const clip = rand() < RUN_CHANCE ? 'run' : 'walk'
      // On a trunk the crossing is measured round and up the bark, not through the air, so a re-seated chunk under it changes nothing about the pace.
      let dist
      if (kind === 'tree') {
        let dd = q.u - p.u
        dd -= TAU * Math.round(dd / TAU)
        dist = Math.hypot(dd * p.r, q.v - p.v)
      } else dist = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z)
      const dur = Math.max(MIN_GO_S, (dist * this.span) / (GAIT[clip] * c.size))
      // The sit before it: a ground spider only idles, and only GROUND_REST_CHANCE of the time, so it is nearly always on the move.
      const r = rand()
      const sits = kind !== 'ground' || r < GROUND_REST_CHANCE
      const clip2 = kind === 'ground' ? 'idle' : r < 0.65 ? 'idle' : r < 0.85 ? 'eat' : 'rest'
      const want = sits ? between(rand, kind === 'ground' ? GROUND_PAUSE_S : clip2 === 'rest' ? REST_S : PAUSE_S) : 0
      legs.push({ p, q, dist, clip, dur, want, clip2 })
      go += dur
      sit += want
    }
    // The spell is exactly as long as its grid, so the sits come first -- what each wanted, or their share of the time the crossing leaves, whichever is less -- and the scoots take the rest, crawled faster or slower than their own pace to fit it. A crossing short enough that even dawdling over it at STRETCH_MAX cannot fill the spell is followed by a long rest at the last seat.
    const sitTime = Math.min(sit, Math.max(0, span - go))
    const share = sit > 0 ? sitTime / sit : 0
    let squeeze = (span - sitTime) / go
    let tail = 0
    if (squeeze > STRETCH_MAX) { squeeze = STRETCH_MAX; tail = span - sitTime - go * squeeze }

    const phrases = []
    let at = 0
    let travelled = 0
    for (let i = 0; i < legs.length; i++) {
      const g = legs[i]
      const hold = g.want * share
      if (hold > 0) { phrases.push({ go: false, start: at, dur: hold, clip: g.clip2, at: g.p, s0: travelled }); at += hold }
      const dur = g.dur * squeeze
      // The legs' swing eases up out of a sit and back down into the next one; where the crossing has squeezed the sits away, the scoots run into each other and the swing holds across them.
      phrases.push({ go: true, start: at, dur, clip: g.clip, from: g.p, to: g.q, len: g.dist, speed: dur > 0 ? g.dist / dur : 0, s0: travelled, easeIn: hold > 0, easeOut: i === legs.length - 1 || legs[i + 1].want * share > 0 })
      at += dur
      travelled += g.dist
    }
    if (tail > 0) phrases.push({ go: false, start: at, dur: tail, clip: kind === 'ground' ? 'idle' : 'rest', at: pts[pts.length - 1], s0: travelled })
    this.spells++
    return { seg, start: seg * span + c.offset + c.epoch, phrases }
  }

  /** The waypoint at the host coordinates (u, v), clamped into the band, or null where there is nowhere to stand there. */
  _waypoint(c, u, v) {
    const host = c.host
    _seatC.u = u
    if (host.kind === 'tree') _seatC.v = Math.min(host.hHi, Math.max(host.hLo, v))
    else if (host.kind === 'rock') _seatC.v = Math.min(Math.min(CLIMB_M, host.size), Math.max(0.05, v))
    else _seatC.v = v
    return this._resolve(c, _seatC) ? { ..._seatC } : null
  }

  /** The phrase of `phrases` that second `e` into the spell falls in; the last one where rounding has carried `e` past its end. */
  static _phraseAt(phrases, e) {
    for (let i = phrases.length - 1; i > 0; i--) if (e >= phrases[i].start) return phrases[i]
    return phrases[0]
  }

  /** Spider `c` posed `e` seconds into phrase `ph`: sitting on its waypoint, or `e`'s share of the way across to the next. */
  _pose(c, ph, e) {
    c.clip = ph.clip
    if (!ph.go) {
      c.state = 'pause'
      c.speed = 0
      c.amp = 0
      this._sit(c, ph.at)
      return
    }
    c.state = 'go'
    c.speed = ph.speed
    const u = ph.dur > 0 ? Math.min(1, e / ph.dur) : 1
    // The legs cycle once per stride of the seat, whatever the pace, so the feet hold the bark; the phase runs on the distance crossed since the spell opened, and the roll spreads a group out of step.
    c.gait = (c.gait0 + (TAU * (ph.s0 + ph.len * u) * this.span) / (c.size * STRIDE[ph.clip])) % TAU
    c.amp = (STRIDE[ph.clip] / 2) * Math.min(1, ph.easeIn ? e / AMP_EASE_S : 1, ph.easeOut ? (ph.dur - e) / AMP_EASE_S : 1)
    this._between(c, ph.from, ph.to, u)
  }

  /** A sitting spider on the waypoint `w`, its heading kept; a trunk that re-seated under it is followed. */
  _sit(c, w) {
    const host = c.host
    if (host.kind === 'tree') {
      if (c.ang === w.u && c.h === w.v && !host.moved) return
      c.ang = w.u; c.h = w.v
      this._placeTree(c)
      return
    }
    if (c.x === w.x && c.y === w.y && c.z === w.z) return
    c.x = w.x; c.y = w.y; c.z = w.z
    c.nx = w.nx; c.ny = w.ny; c.nz = w.nz
    if (host.kind === 'rock') this._heading(c, c.phi)
    else this._headGround(c, c.phi)
  }

  /** Spider `c` the fraction `u` of the way from waypoint `p` to waypoint `q`, headed along the crossing. The seat comes from the coordinates, not the two ends, so it rides the bark or the stone rather than cutting the corner. */
  _between(c, p, q, u) {
    const host = c.host
    if (host.kind === 'ground') {
      c.phi = Math.atan2(q.u - p.u, q.v - p.v)
      // Both ends are dry, but the line between them can dip into water or over the snow line: the spider waits out the wet stretch at the last dry step of the crossing rather than walking under the surface.
      let f = u
      while (f > 0 && this._barred(p.u + (q.u - p.u) * f, p.v + (q.v - p.v) * f)) f -= WET_STEP
      this._placeGround(c, p.u + (q.u - p.u) * Math.max(0, f), p.v + (q.v - p.v) * Math.max(0, f))
      return
    }
    let du = q.u - p.u
    du -= TAU * Math.round(du / TAU)
    const dv = q.v - p.v
    if (host.kind === 'tree') {
      c.ang = p.u + du * u
      c.h = p.v + dv * u
      c.phi = Math.atan2(du * p.r, dv)
      this._placeTree(c)
      return
    }
    _seatC.u = p.u + du * u
    _seatC.v = p.v + dv * u
    if (this._resolve(c, _seatC)) {
      c.x = _seatC.x; c.y = _seatC.y; c.z = _seatC.z
      c.nx = _seatC.nx; c.ny = _seatC.ny; c.nz = _seatC.nz
    } else {
      // The ray found no stone at this angle and height -- a notch in the side -- so the seat runs straight between the two ends across it.
      c.x = p.x + (q.x - p.x) * u; c.y = p.y + (q.y - p.y) * u; c.z = p.z + (q.z - p.z) * u
      const nx = p.nx + (q.nx - p.nx) * u, ny = p.ny + (q.ny - p.ny) * u, nz = p.nz + (q.nz - p.nz) * u
      const len = Math.hypot(nx, ny, nz) || 1
      c.nx = nx / len; c.ny = ny / len; c.nz = nz / len
    }
    this._headTo(c, q.x - p.x, q.y - p.y, q.z - p.z)
    c.dirty = true
  }

  /** Spider `c` posed at world second `now`, planning the spell it has crossed into. False where its host offers it nowhere to stand any more. */
  _play(c, now) {
    const span = SPELL_S[c.host.kind]
    if (c.spell === null || now < c.spell.start || now >= c.spell.start + span) {
      const spell = this._spell(c, Math.floor((now - c.epoch - c.offset) / span))
      if (spell === null) return false
      c.spell = spell
    }
    const e = now - c.spell.start
    const ph = Spiders._phraseAt(c.spell.phrases, e)
    c.phrase = ph
    c.elapsed = e - ph.start
    this._pose(c, ph, c.elapsed)
    return true
  }

  /** Spider `c` onto a name and a grid of its own from `now`, its next spell opening on the seat it is standing on. A flight and a release both end here, because neither is on the score. */
  _rekey(c, now) {
    c.key = restKey(c.x, c.y, c.z)
    const span = SPELL_S[c.host.kind]
    c.offset = keyHash(c.key) % span
    c.epoch = now - c.offset
    if (c.host.kind === 'tree') { c.u0 = c.ang; c.v0 = c.h }
    else if (c.host.kind === 'ground') { c.u0 = c.x; c.v0 = c.z }
    else { c.u0 = Math.atan2(c.z - c.host.z, c.x - c.host.x); c.v0 = c.y - c.host.groundY }
    this._anchor(c)
    c.spell = null
  }

  /** A flight over: calm down where it stands, and take up a life from there. */
  _calm(c, now) {
    c.state = 'pause'
    c.speed = 0
    this._rekey(c, now)
  }

  /**
   * A rock re-split under a spider: back onto the seat it was dealt, and a life
   * from there. False where that seat has gone too, and the spider is taken away.
   */
  _reseat(c, now) {
    _seatC.u = c.u0; _seatC.v = c.v0
    if (!this._resolve(c, _seatC)) {
      c.host = null
      this.free.push(c)
      this.dropped++
      return false
    }
    c.x = _seatC.x; c.y = _seatC.y; c.z = _seatC.z
    c.nx = _seatC.nx; c.ny = _seatC.ny; c.nz = _seatC.nz
    this._heading(c, c.phi)
    this._rekey(c, now)
    return true
  }

  /**
   * The bodies a spider may flee this frame: hers first, from her feet `fy` to
   * her head, then one per peer from main.js's peerHeadsNow(). A peer that
   * sends no foot is known by its head alone, so its body is that one point
   * rather than a guessed-at column.
   */
  _players(hx, fy, hy, hz, peers) {
    const out = this.players
    out.length = 0
    const body = (x, z, lo, hi) => {
      const b = this.playerPool[out.length] ?? (this.playerPool[out.length] = { x: 0, z: 0, lo: 0, hi: 0 })
      b.x = x; b.z = z; b.lo = lo; b.hi = hi
      out.push(b)
    }
    body(hx, hz, fy, hy)
    if (peers) {
      for (const p of peers) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
        body(p.x, p.z, Number.isFinite(p.foot) ? Math.min(p.foot, p.y) : p.y, p.y)
      }
    }
    return out
  }

  /**
   * Off at the run, hastened, away from a body: the column at (x, z) from y0 up
   * to y1, at world second `now`. `fixed` is a released spider's bolt -- it runs
   * from that column wherever the bodies go afterwards, so the flight is the
   * same on every client that heard the release.
   */
  _flee(c, x, y0, y1, z, now, fixed = false) {
    c.state = 'flee'
    c.clip = 'run'
    c.speed = (FLEE_HASTE * GAIT.run * c.size) / this.span
    c.stall = 0
    c.tick = tickOf(now)
    c.alpha = 0
    c.bolt = fixed ? { x, z, lo: y0, hi: y1 } : null
    this._aim(c, x, y0, y1, z, c.tick)
    this.startles.push(c)
  }

  /** How far spider `c` is from the body `b`, squared: to the nearest point of its capsule's axis. */
  _bodyD2(c, b) {
    const dx = c.x - b.x
    const dz = c.z - b.z
    const dy = c.y - (c.y < b.lo ? b.lo : c.y > b.hi ? b.hi : c.y)
    return dx * dx + dy * dy + dz * dz
  }

  /**
   * One tick of a flight, at absolute tick `tick`, running from the body `b` --
   * the column a release fixed, or this frame's nearest. The flight may end
   * here, FLEE_TO_M from that body, within ARRIVE_M of the point it is making
   * for, or cornered; the ticks left in a catch-up then do nothing.
   */
  _fleeTick(c, tick, b) {
    if (c.state !== 'flee') return
    const togo = Math.hypot(c.ex - c.x, c.ey - c.y, c.ez - c.z)
    if (c.togo - togo > STALL_FRAC * c.speed * TICK_S) c.stall = 0; else c.stall += TICK_S
    c.togo = togo
    if (Math.sqrt(this._bodyD2(c, b)) - WALK.radius >= FLEE_TO_M || togo < ARRIVE_M || c.stall >= STALL_S) {
      this._calm(c, tick * TICK_S)
      return
    }
    if (tick % STEER_TICKS === 0) this._aim(c, b.x, b.lo, b.hi, b.z, tick)
    const d = c.speed * TICK_S
    // The legs cycle once per stride of the seat, whatever the pace: a fleeing spider's legs go at FLEE_HASTE times the run.
    c.gait = (c.gait + (TAU * d * this.span) / (c.size * STRIDE.run)) % TAU
    const host = c.host
    if (host.kind === 'tree') this._stepTree(c, d)
    else if (host.kind === 'rock') this._stepRock(c, d, tick)
    else this._stepGround(c, d, tick)
    // Its flight is not planned, so the swing eases on the tick's own length rather than into a waypoint.
    c.amp += (STRIDE.run / 2 - c.amp) * Math.min(1, GAIT_EASE * TICK_S)
  }

  /** Make for the point of its host furthest from her body, the column at (x, z) from y0 up to y1: the far side of it from there, at the end of the climb further from the column. On the ground, the point GROUND_FLEE_M off her surface straight away from the column -- a fixed point while she stands, so it arrives; a 10 cm spider at the hastened run would take twenty seconds over FLEE_TO_M. */
  _aim(c, x, y0, y1, z, tick) {
    const host = c.host
    // The heading is set a little off the straight line away, so a group does not run as one body; the roll is off the spider's own name and the tick, not the layer's, so every client turns it the same way.
    const jitter = (phraseRand(c.key, tick, 12)() - 0.5) * 0.6
    if (host.kind === 'ground') {
      const ax = c.x - x, az = c.z - z
      const len = Math.hypot(ax, az) || 1
      const off = Math.max(len, WALK.radius + GROUND_FLEE_M)
      c.ex = x + (ax / len) * off
      c.ez = z + (az / len) * off
      c.ey = this.height.heightAt(c.ex, c.ez)
      c.togo = Math.hypot(c.ex - c.x, c.ey - c.y, c.ez - c.z)
      this._headGround(c, Math.atan2(ax, az) + jitter)
      return
    }
    let ex = host.x - x, ez = host.z - z
    const len = Math.hypot(ex, ez) || 1
    const r = host.kind === 'tree' ? c.r : host.r
    c.ex = host.x + (ex / len) * r
    c.ez = host.z + (ez / len) * r
    const top = host.kind === 'tree' ? host.y + host.hHi : host.groundY + Math.min(CLIMB_M, host.size)
    const bot = host.kind === 'tree' ? host.y + host.hLo : host.groundY
    c.ey = top - y1 > y0 - bot ? top : bot
    // The pull toward it is a cos(phi) + b sin(phi) over the surface's two tangents, so the heading straightest at it is where that is largest.
    const wx = c.ex - c.x, wy = c.ey - c.y, wz = c.ez - c.z
    c.togo = Math.sqrt(wx * wx + wy * wy + wz * wz)
    this._face(c, 0)
    const a = c.tx * wx + c.ty * wy + c.tz * wz
    this._face(c, TAU / 4)
    const b = c.tx * wx + c.ty * wy + c.tz * wz
    this._face(c, Math.atan2(b, a) + jitter)
  }

  /** Turn to the heading `phi` in the host's surface frame: up the bark toward round it, or a rock face's upmost toward its right. */
  _face(c, phi) {
    if (c.host.kind === 'tree') { c.phi = phi; this._placeTree(c) } else this._heading(c, phi)
  }

  /** One step of `d` metres up or round the trunk; at either end of the climb the heading reflects. */
  _stepTree(c, d) {
    const host = c.host
    c.h += Math.cos(c.phi) * d
    if (c.h < host.hLo || c.h > host.hHi) {
      c.h = Math.min(host.hHi, Math.max(host.hLo, c.h))
      c.phi = Math.PI - c.phi
    }
    c.ang += (Math.sin(c.phi) * d) / c.r
    this._placeTree(c)
  }

  /**
   * One tick's step of `d` metres along the heading, then back onto the stone
   * along the normal. No standable stone under the step, or the top of the
   * rock: the step is not taken and the spider turns back, roughly the way it
   * came, and keeps turning until its flight ends.
   */
  _stepRock(c, d, tick) {
    const x = c.x + c.tx * d
    const y = c.y + c.ty * d
    const z = c.z + c.tz * d
    const probe = c.size * 0.5
    if (!this._rockRay(x + c.nx * probe, y + c.ny * probe, z + c.nz * probe, -c.nx, -c.ny, -c.nz, 2 * probe) || _hit.ny > FLAT_NY) {
      // The turn is drawn off the spider's own name and the tick, not the layer's roll, so two clients watching the one flight turn it the same way.
      this._heading(c, c.phi + Math.PI + (phraseRand(c.key, tick, 13)() - 0.5) * 0.8)
      return
    }
    this._snapRock(c)
  }

  /**
   * One step of `d` metres along the heading over the ground. Water or the
   * snow line ahead: the step is not taken and the spider turns back, roughly
   * the way it came. A flight is not tethered to the host's point, so nothing
   * here turns it for home.
   */
  _stepGround(c, d, tick) {
    const x = c.x + c.tx * d
    const z = c.z + c.tz * d
    if (this._barred(x, z)) {
      // The turn is drawn off the spider's own name and the tick, not the layer's roll, so two clients watching the one flight turn it the same way.
      this._headGround(c, c.phi + Math.PI + (phraseRand(c.key, tick, 11)() - 0.5) * 0.8)
      return
    }
    this._placeGround(c, x, z)
  }

  /**
   * One frame: every spider posed at world second `now` and written to a mesh
   * tier or the card by its distance from her head. `fy` is where her feet are:
   * her body, for the flee, is the capsule from there up to her head.
   */
  update(hx, hy, hz, now, fy, peers = null) {
    if (!Number.isFinite(now)) throw new Error(`Spiders.update: bad world time ${now}`)
    if (!(fy <= hy)) throw new Error(`Spiders.update: her feet must be under her head, got feet ${fy} and head ${hy}`)
    const players = this._players(hx, fy, hy, hz, peers)
    // A flight is not on the score, so it steps on the frame's own length; a long stall (a tab asleep, a room swap) is clamped rather than teleporting anybody.
    const dt = Math.min(0.1, Math.max(0, now - this.now))
    this.now = now
    if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) {
      this.rescan = []
    }
    // The trees and rocks land over frames; one tile per RESCAN_FRAMES picks up the hosts that were not there at the last look.
    if (this.frame % RESCAN_FRAMES === 0) {
      if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
      const t = this.rescan.pop()
      if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
    }
    this.frame++
    this.startles.length = 0

    const cards = this.cardReady
    const meshes = this.loaded
    const flee2 = (FLEE_M + WALK.radius) * (FLEE_M + WALK.radius)
    const counts = this.counts
    counts.fill(0)
    for (const t of this.tiles.values()) {
      for (const host of t.hosts.values()) {
        let dropped = 0
        for (const c of host.spiders) {
          const dx = c.x - hx
          const dy = c.y - hy
          const dz = c.z - hz
          const d2 = dx * dx + dy * dy + dz * dz
          // Its rung on the arc ladder by its own size, the card rung included; past the last it is neither drawn nor simulated, only kept where it is (a sitting tree spider still following its trunk).
          c.rung = critterTier(c.size, Math.sqrt(d2), c.rung, CARD_RUNGS)
          if (c.rung >= CARD_RUNGS) {
            if (host.kind === 'tree' && host.moved) this._placeTree(c)
            continue
          }
          // The nearest body, hers or a peer's: the nearest point of its capsule's axis to the spider, and whether the spider is within FLEE_M of its surface. Squared, so the root is only taken by a spider already fleeing.
          let bd2 = Infinity
          let near = players[0]
          for (const b of players) {
            const d2b = this._bodyD2(c, b)
            if (d2b < bd2) { bd2 = d2b; near = b }
          }
          const close = bd2 < flee2
          if (close && !c.near && c.state !== 'flee') this._flee(c, near.x, near.lo, near.hi, near.z, now)
          c.near = close
          if (c.state === 'flee') {
            // A flight steps on the world's own ticks, so two clients take the same steps in the same order whatever their frame rates, and one that heard of it late catches its ticks up. A released spider runs from the column the release fixed rather than a body this client may see elsewhere.
            const from = c.bolt ?? near
            stepTo(c, now, (tick) => this._fleeTick(c, tick, from), FLEE_CATCH_UP)
            // The part-tick lead dies with the flight: stepTo leaves it standing at whatever this frame fell on, which is the one thing about a calmed spider that would differ from client to client.
            if (c.state !== 'flee') c.alpha = 0
          }
          if (c.state === 'flee') {
            // The draw leads the last tick along the heading by however much of a tick the frame is past it, so the flight reads as smoothly as the frame rate allows.
            c.dirty = true
          } else {
            // A trunk that re-seated with its chunk is followed by re-planning off its new origin, and a rock that re-split is read for the stone still being there.
            if (c.rung === LOD_RUNGS && c.cardOn && !(host.kind === 'tree' && host.moved) && (this.frame + c.id) % CARD_EVERY !== 0) {
              c.cardStamp = this.frame
              continue
            }
            if (host.kind === 'tree' && host.moved) c.spell = null
            else if (host.kind === 'rock' && (this.frame + c.id) % RESEAT_EVERY === 0) {
              _seatC.u = Math.atan2(c.z - host.z, c.x - host.x)
              _seatC.v = c.y - host.groundY
              if (!this._resolve(c, _seatC) && !this._reseat(c, now)) { dropped++; continue }
            }
            if (!this._play(c, now)) { dropped++; continue }
            // Reared up while she is close, back to what it was doing when she leaves.
            if (c.state === 'pause' && d2 < ALERT_M * ALERT_M) c.clip = 'alert'
          }
          const rearTo = c.clip === 'alert' ? 1 : 0
          if (c.rear !== rearTo) {
            c.rear += (rearTo - c.rear) * Math.min(1, REAR_EASE * dt)
            if (Math.abs(c.rear - rearTo) < 1e-3) c.rear = rearTo
            c.dirty = true
          }
          // On the four mesh rungs a spider is the one mesh; on the card rung, the card.
          const lod = meshes && c.rung < LOD_RUNGS ? 0 : LOD_TIERS
          c.lod = lod
          // Mid-tick of a flight, the drawn pose runs on along the heading: the tick's own step is that line, so the lead meets the next tick where it lands.
          const lead = c.state === 'flee' ? c.speed * TICK_S * c.alpha : 0
          const gait = lead > 0 ? (c.gait + (TAU * lead * this.span) / (c.size * STRIDE.run)) % TAU : c.gait
          const rebuilt = c.dirty
          if (rebuilt) {
            const k = c.size / this.span
            const sink = SINK * this.bodyH * k
            _pos.set(c.x + c.tx * lead - c.nx * sink, c.y + c.ty * lead - c.ny * sink, c.z + c.tz * lead - c.nz * sink)
            // Local +Y along the normal, local -Z along the heading; a reared spider pitches both back about its local X by REAR_RAD.
            _y.set(c.nx, c.ny, c.nz)
            _z.set(-c.tx, -c.ty, -c.tz)
            _x.crossVectors(_y, _z)
            if (c.rear > 0) {
              const a = REAR_RAD * c.rear
              const ca = Math.cos(a), sa = Math.sin(a)
              const zx = _z.x * ca - _y.x * sa, zy = _z.y * ca - _y.y * sa, zz = _z.z * ca - _y.z * sa
              _y.set(_y.x * ca + _z.x * sa, _y.y * ca + _z.y * sa, _y.z * ca + _z.z * sa)
              _z.set(zx, zy, zz)
            }
            _quat.setFromRotationMatrix(_mat.makeBasis(_x, _y, _z))
            _scl.set(k, k, k)
            _mat.compose(_pos, _quat, _scl).toArray(c.m)
            c.dirty = false
          }
          if (lod < LOD_TIERS) {
            const n = counts[lod]
            if (n < MAX) {
              this.meshes[lod].instanceMatrix.array.set(c.m, n * 16)
              const g = this.gaits[lod].array
              g[n * 2] = gait
              g[n * 2 + 1] = c.amp
              const t = this.meshes[lod].instanceColor.array
              t[n * 3] = c.tr; t[n * 3 + 1] = c.tg; t[n * 3 + 2] = c.tb
              counts[lod] = n + 1
            }
          } else if (cards) {
            if (rebuilt || !c.cardOn) this._writeCard(c)
            c.cardStamp = this.frame
          }
        }
        if (host.kind === 'tree') host.moved = false
        if (dropped) {
          let n = 0
          for (const c of host.spiders) if (c.host !== null) host.spiders[n++] = c
          host.spiders.length = n
        }
      }
    }
    for (let k = 0; k < LOD_TIERS; k++) {
      const mesh = this.meshes[k]
      mesh.count = counts[k]
      mesh.instanceMatrix.needsUpdate = true
      mesh.instanceColor.needsUpdate = true
      this.gaits[k].needsUpdate = true
    }
    // A card not stamped this frame is a spider that went to a mesh, out of range or away.
    let n = 0
    for (const c of this.slots) {
      if (c.cardOn && c.cardStamp !== this.frame) {
        this.cards.setVisibleAt(c.id, false)
        c.cardOn = false
      }
      if (c.cardOn) n++
    }
    this.cardCount = n
  }

  _writeCard(c) {
    _mat.fromArray(c.m).multiply(_flat.makeTranslation(0, this.cardLift, 0).multiply(_lay))
    this.cards.setMatrixAt(c.id, _mat)
    _col.setRGB(c.tr, c.tg, c.tb)
    this.cards.setColorAt(c.id, _col)
    if (!c.cardOn) {
      this.cards.setVisibleAt(c.id, true)
      c.cardOn = true
    }
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.material.dispose()
    this.asset?.map?.dispose()
    for (const g of this.asset?.tiers ?? []) g.dispose()
    for (const c of this.slots) if (c.cardOn) this.cards.setVisibleAt(c.id, false)
  }
}
