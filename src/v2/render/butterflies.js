// ---------------------------------------------------------------------------
// Butterflies: the meadow butterfly's two wing cards (tools/creatures/wing-cards.mjs)
// over the fields and through the forests below the snow line. Each 16 m tile
// around her rolls its own few from its seed (critters.js tileSeed) at DENSITY,
// and a butterfly is a slot in one InstancedMesh: four triangles, one 128 px
// cutout, drawn from both sides.
//
// THE LIFE IS ON THE SCORE (src/sim/score.js, _notes/creature-sync.md), so two
// clients in a room see the same butterfly on the same flower at the same
// second. Its chain -- rest, flight, rest, flight -- is planned BOUT_S at a
// time as a pure function of (key, chapter): every chapter opens and closes
// with the butterfly at rest on its roost, a perch that is a pure function of
// its key alone, so a client meeting the meadow in the middle of a chapter
// plans that chapter alone and still finds it where the chapter before left
// off. Each phrase carries the perch it ends on, its altitude and its speed.
// The flight between the perches cannot be written closed-form -- it is
// erratic on purpose -- so it is INTEGRATED at score.js's TICK_HZ on absolute
// tick indexes, from a PRNG keyed by (key, segment): every GRID_S seconds the
// butterfly is put back at the pose the chain says it holds then, and over the
// segment's last EASE_S its flight is eased onto the pose the segment ends at,
// so the snap is nothing the eye reads. Nothing about a butterfly goes on the
// wire.
//
// A butterfly lives in three states. FLYING it wanders tethered to the point it
// was rolled at, holding the height its flight rolled in FLY_M over the ground
// it is crossing -- the field, or the stone on it (WalkSurface.heightAt), read
// every HEIGHT_EVERY ticks. THE FLIGHT IS ERRATIC ON PURPOSE, as a real one's
// is (a predator cannot lead an unpredictable target): the heading is a weave
// broken every JERK_S by a sharp turn impulse that decays over TURN_TAU, the
// wings beat in bursts of FLAP_S and glide for GLIDE_S between, so the speed
// surges and sags and the body bounds -- lifted while flapping, sinking on a
// glide -- and the height is chased by a vertical velocity that may never
// exceed the forward speed's CLIMB_TAN on the way up, so a butterfly climbs
// along its path at a pitch and never rises straight. Each stroke's lift shows
// as a STROKE_M bounce on the wing phase.
// Over a flight's last LAND_S it flies at the PERCH the chain gave it: a tree
// trunk (Trees.anchorsInto, landing on the bark at a height in FLY_M), a
// boulder (Rocks.anchorsInto, then blockTopAt for the stone's top), a fern's
// frond (Ferns.perchesInto, then landOn for a point of the drawn rosette's own
// triangles, held FERN_LIFT_M off it for the wind's sway), a stump's or log's
// top (Deadwood.perchesInto), or failing those the ground itself; LANDED it
// holds the surface with its wings raised and pulsing slowly until the chain
// sends it up again. Over water it never lands: where nothing within SEARCH_M
// is dry the chain's station is a point in the air and the butterfly hovers
// about it.
//
// AFTER SUNSET IT ROOSTS. The plan reads the room's own clock (clock.js
// WorldClock.daynessAt) at the second each phrase begins, so every client plans
// the same night: a rest that ends below NIGHT_DAY -- the sun on the horizon --
// is followed by one flight home to the roost and then rest after rest there
// until dawn, each rolled its own REST_S long, so the meadow settles within
// half a minute of sundown and leaves again a few at a time rather than all on
// the frame the sun clears the horizon.
//
// THE WINGS ARE THE VERTEX SHADER. The cards lie flat in the mesh's XZ with the
// body along X and the seam at z = 0, and `aWing` per instance is the flap's
// phase, its amplitude and the angle the wings rest about; each wing is turned
// about the seam by base + amp * sin(phase), and its normal with it. In flight
// the phase runs at FLUTTER_HZ over a wide amplitude about the flat; at rest at
// REST_HZ over a narrow one about REST_BASE, wings up. Both faces take the
// authored normal's light, as the critter card does. The wings run on the
// frame's own clock, not the tick's: they are the one thing about a butterfly
// nobody has to agree on.
//
// THE COLOUR IS A TINT. Each butterfly rolls one of MORPHS from its tile's seed
// and carries the morph's per-channel multiplier in instanceColor, so a blue,
// an orange and a meadow butterfly are three instances of the one draw.
//
// The frame draws between the last two ticks at the record's alpha, and a
// sitter's matrix is kept on its slot and copied rather than recomposed.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { GRID_S, TICK_S, CATCH_UP_TICKS, hash32, keyHash, phraseRand, tickAfter, stepTo, easeWeight, Score } from '../../sim/score.js'
import { DROP, dropWire, snap } from '../creature-net.js'
import { CRITTER_GLB, loadCritterGlb, setCritterAsset, tileKey, tileSeed, walkTiles } from './critters.js'
import { FERN_PERCH_STRIDE } from './ferns.js'
import { taken, TOLERANCE_M } from '../taken.js'

export const TILE = 16
export const RADIUS = 30
// Butterflies per square metre: one per 100 m2, so a tile rolls two or three.
export const DENSITY = 0.01
export const MAX = 96
// Ground within this of the snow line is too cold to roll on.
export const SNOW_MARGIN = 20
// Flight height over the ground, metres, and the wingspan the card is drawn at (the GLB is 6 cm wide).
export const FLY_M = [0.5, 3]
export const SIZE_M = [0.05, 0.2]
// Metres per second in flight; a bout of flight, then a rest, in seconds.
export const SPEED = [0.8, 1.8]
export const FLY_S = [5, 14]
export const REST_S = [3, 10]
// How far from its home a butterfly ranges before its heading is turned back, and how far around it a perch is looked for.
export const TETHER = 8
export const SEARCH_M = 4
// The day scalar below which a butterfly roosts. dayness is (sun elevation + 6) / 10 clamped, so 0.6 is the sun exactly on the horizon.
export const NIGHT_DAY = 0.6
// The chapter a butterfly's chain of rests and flights is planned over: it opens and closes on the roost, so a join, and the plan's whole memory, are bounded by one of these.
export const BOUT_S = 180
// Seconds of the chapter kept back for the flight home to the roost and the settle there. Twice the longest flight the chain can roll: Score.chapter refuses a plan that overruns its chapter by more than its last phrase, and this is what keeps the last two flights inside it.
const CLOSE_S = 40
// A flight's last seconds, flown at the perch it ends on; and the first, over which its station leaves the perch it left.
const LAND_S = 2.5
const RISE_S = 1.5
// How hard the ease pulls a flier onto the pose its segment ends at, per second at full weight.
const EASE_PULL = 2.5
// The wings: flap rate in Hz and half-angle in radians in flight; pulse rate, half-angle and the angle the wings rest raised at, landed; held at GLIDE_BASE in a glide.
export const FLUTTER_HZ = 11
export const FLUTTER_AMP = 1.0
export const REST_HZ = 0.6
export const REST_AMP = 0.2
export const REST_BASE = 1.15
export const GLIDE_BASE = 0.35
// Drawn within this many wingspans of her head: past it a butterfly is under a pixel and is not written.
export const DRAW_SPANS = 500
// A butterfly's colour morph, rolled by weight `w` from its tile's seed: a per-channel multiplier on the map in linear RGB, carried in instanceColor, so every morph is the same material and draw. The map is white with orange and dark-brown markings, so the tint is what the white becomes and the pattern stays -- the orange goes dark under a tint that has no red, the brown is dark already. 'meadow' is the map as shipped, 'blue' an electric blue with the markings near black, 'orange' a flame orange with the patches deep red, 'violet' a purple with them wine-dark.
export const MORPHS = [
  { name: 'meadow', w: 4, r: [0.9, 1], g: [0.9, 1], b: [0.8, 1] },
  { name: 'blue', w: 3, r: [0, 0.04], g: [0.12, 0.3], b: [0.9, 1] },
  { name: 'orange', w: 3, r: [0.95, 1], g: [0.15, 0.3], b: [0, 0.02] },
  { name: 'violet', w: 2, r: [0.25, 0.4], g: [0, 0.04], b: [0.8, 1] },
]
const MORPH_W = MORPHS.reduce((sum, m) => sum + m.w, 0)
// The erratic flight: a sharp turn every JERK_S of TURN_RAD, spent over TURN_TAU; the weave between at WEAVE_HZ; a burst of flapping for FLAP_S, then a glide for GLIDE_S with chance GLIDE_P.
export const JERK_S = [0.3, 1.1]
export const TURN_RAD = [0.5, 2.0]
export const TURN_TAU = 0.25
export const WEAVE_HZ = 1.4
export const FLAP_S = [0.4, 1.2]
export const GLIDE_S = [0.15, 0.45]
export const GLIDE_P = 0.5
// The climb: vertical speed is at most the forward speed times CLIMB_TAN (a 40 degree pitch) upward and SINK_TAN downward; flapping lifts by LIFT_MPS and a glide sinks by SINK_MPS on top of the height chase; the body pitches PITCH_K of the path's angle.
export const CLIMB_TAN = 0.84
export const SINK_TAN = 2.1
export const LIFT_MPS = 0.2
export const SINK_MPS = 0.5
export const PITCH_K = 0.7
// Each downstroke's lift: the drawn bounce's half-height, metres, on the wing phase.
export const STROKE_M = 0.012
// Ticks between a flying butterfly's ground reads, staggered by its key.
const HEIGHT_EVERY = 4
// How fast the height chase, speed, pitch and roll ease per second, and the wings.
const EASE = 3
const WING_EASE = 8
// Held this far inside FLY_M when a height is rolled, so the bounding stays in the band.
const ALT_PAD = 0.2
// A landing's approach: held this far off the perch along its normal on the way in, and seated within SEAT_M of it.
const HOVER_M = 0.15
const SEAT_M = 0.03
// A fern landing sits this far off the frond along its normal: the shader sways the blade and the perch does not follow it.
export const FERN_LIFT_M = 0.025
// Perch buffers: how many of a kind a 2 * SEARCH_M box may hold.
const PERCH_BUF = 32

const TAU = Math.PI * 2
const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const ALT_M = [FLY_M[0] + ALT_PAD, FLY_M[1] - ALT_PAD]
// A heading `yaw` is the body's +X turned about +Y: (cos yaw, 0, -sin yaw); the angle toward (dx, dz) is atan2(-dz, dx).
const headingTo = (dx, dz) => Math.atan2(-dz, dx)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/** The key of the flock of the tile (tx, tz), and of its `i`th roll. */
export const bedKey = (tx, tz) => `bf:${tx},${tz}`
export const keyOf = (tx, tz, i) => `${bedKey(tx, tz)}:${i}`
/** The key of one let go at (x, z) headed `yaw`: the drop to the centimetre and the heading to the milliradian, so a peer told the same drop plans the same life. */
export const dropKey = (x, z, yaw) => `bf@${x.toFixed(2)},${z.toFixed(2)},${Math.round(yaw * 1000)}`
/** The butterflies' prefix in the room's creature keys (creature-net.js): a release is all they send. */
export const PREFIX = 'bf'

const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _basis = new THREE.Matrix4()
const _hit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 }
const _s0 = { kind: null, seat: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 }
const _s1 = { kind: null, seat: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 }

export class Butterflies {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt
   * @param opts.walk      WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.clock     the room's clock: daynessAt(seconds), read by the plan so every client plans the same night
   * @param opts.rocks     Rocks: anchorsInto, blockTopAt
   * @param opts.trees     Trees: anchorsInto
   * @param opts.ferns     Ferns: perchesInto and landOn, or null
   * @param opts.deadwood  Deadwood: perchesInto, or null
   * @param opts.assets    a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, clock, rocks, trees, ferns = null, deadwood = null, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Butterflies needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.levelAt !== 'function') throw new Error('Butterflies needs WaterSurfaces, for levelAt')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Butterflies needs the WalkSurface, for heightAt')
    if (!clock || typeof clock.daynessAt !== 'function') throw new Error('Butterflies needs the room\'s clock, for daynessAt')
    if (!rocks || typeof rocks.anchorsInto !== 'function' || typeof rocks.blockTopAt !== 'function') throw new Error('Butterflies needs Rocks, for anchorsInto and blockTopAt')
    if (!trees || typeof trees.anchorsInto !== 'function') throw new Error('Butterflies needs Trees, for anchorsInto')
    if (ferns && (typeof ferns.perchesInto !== 'function' || typeof ferns.landOn !== 'function')) throw new Error('Butterflies: `ferns` was given but has no perchesInto and landOn')
    if (deadwood && typeof deadwood.perchesInto !== 'function') throw new Error('Butterflies: `deadwood` was given but has no perchesInto')
    this.height = height
    this.water = water
    this.walk = walk
    this.clock = clock
    this.rocks = rocks
    this.trees = trees
    this.ferns = ferns
    this.deadwood = deadwood
    this.seed = seed

    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaTest: 0.5, side: THREE.DoubleSide })
    this.material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aWing;\nfloat wingAng;\nfloat wingSide;')
        // The normal stage runs before the position stage, so the angle is worked out here and reused below.
        .replace(
          '#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n' +
            'wingSide = sign( position.z );\n' +
            'wingAng = aWing.z + aWing.y * sin( aWing.x );\n' +
            'objectNormal = vec3( 0.0, cos( wingAng ), -wingSide * sin( wingAng ) );'
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n' +
            'transformed.y += abs( position.z ) * sin( wingAng );\n' +
            'transformed.z = position.z * cos( wingAng );'
        )
      // three flips a double-sided normal toward the viewer; twice is the identity, so both faces of a wing take the same light.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;')
    }
    this.material.customProgramCacheKey = () => 'butterflies'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-butterflies'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.wing = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3)
    this.wing.setUsage(THREE.DynamicDrawUsage)
    this.mesh.geometry.setAttribute('aWing', this.wing)
    // The morph's tint, through three's own vColor; made here so the program is keyed with it from the first draw.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // The layer toggle flips the group, so it cannot unhide the mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-butterflies'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        // Its key on the score, the grid offset and the ground-read stagger that key gives it, and the world second its score time is measured from (a drop's, so its chain opens at the hand; 0 for one a tile rolled).
        key: null, offset: 0, probe: 0, epoch: 0,
        // The segment its state was last put at the chain's pose for, the tick record (score.js stepTo) and the PRNG that segment integrates on.
        seg: null, rec: { tick: 0, alpha: 0 }, rand: null,
        // The phrase of the chain it is playing, and the score second that phrase ends at.
        ph: null, phEnd: 0,
        homeX: 0, homeZ: 0, x: 0, y: 0, z: 0, size: 0.06,
        // Where it stood at the tick before, for the frame to draw between.
        ox: 0, oy: 0, oz: 0, oyaw: 0, opitch: 0, oroll: 0,
        // The pose the segment ends at, which the flight is eased onto over its last EASE_S, and whether that pose is sat on a perch.
        ex: 0, ey: 0, ez: 0, eSeat: false,
        // The morph's tint (MORPHS), linear RGB.
        r: 1, g: 1, b: 1,
        // 'fly' wanders, 'land' flies at the perch, 'rest' sits on it.
        state: 'fly', yaw: 0, turn: 0, weave: 0, jerk: 0, alt: 1, ground: 0, roll: 0, pitch: 0,
        // The speed the flight is flown at, the speed now, the vertical velocity; the flap/glide cycle's timer and which half it is in.
        speed: 1, spd: 1, vy: 0, beat: 0, glide: false,
        // The perch: its kind, its point and the surface normal there.
        perch: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0,
        // The wings: phase, and the amplitude / base angle with the figures they ease toward.
        phase: 0, amp: FLUTTER_AMP, base: 0, ampTo: FLUTTER_AMP, baseTo: 0,
        // Its instance this frame, or -1 when it was culled; its matrix, and whether the matrix trails the step.
        row: -1, m: new Float32Array(16), stale: true,
      })
    }
    this.free = this.slots.slice()
    // The releases owed to the room (pending), and the drop key of every release made here, hers or a peer's, so one heard twice lets one butterfly go.
    this.outbox = []
    this.drops = new Set()
    // Set while a peer's release is being made here: it is theirs, and is not owed back to the room.
    this.applying = false
    this.tiles = new Map()
    // key -> { x, y, z, yaw, epoch, drop }: what a chapter is planned from, for every butterfly on the meadow.
    this.homes = new Map()
    // key -> the station its chapters open and close on, a pure function of the key.
    this.roosts = new Map()
    this.score = new Score((key, chapter, rand) => this._plan(key, chapter, rand), { chapterS: BOUT_S, keep: 2, cap: 4 * MAX })
    this.frame = 0
    // The room's clock as the last update read it, and the frame's own seconds for the wings.
    this.now = 0
    this.last = null
    this.head = { x: 0, z: 0 }
    this.buf = new Float32Array(PERCH_BUF * Math.max(4, FERN_PERCH_STRIDE))
    this.span = 1
    this.loaded = false
    this.overflow = 0
    // How many segments were planned and how many ticks run, for the panel and the gate.
    this.segments = 0
    this.ticks = 0
    // How many landings went to each kind of perch, for the panel and the gate.
    this.landings = { trunk: 0, rock: 0, fern: 0, deadwood: 0, ground: 0 }

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    // The cards are authored about the seam, so the origin stays where the file put it.
    this.setAsset(await loadCritterGlb(CRITTER_GLB.butterfly, { origin: [0, 0, 0] }))
    return true
  }

  setAsset(asset) {
    this.span = setCritterAsset(this.mesh, this.material, asset, 'butterflies').span
    // Every kept matrix was scaled by the old span.
    for (const b of this.slots) b.stale = true
    this.loaded = true
  }

  /** Whether a butterfly may be rolled at (x, z): warm, dry land. Returns the ground height or null. */
  qualify(x, z) {
    const h = this.height.heightAt(x, z)
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) return null
    return h
  }

  /** Whether the sun is down far enough at world second `t` that nothing flies. */
  _nightAt(t) {
    return this.clock.daynessAt(t) < NIGHT_DAY
  }

  /** Whether the sun is down now. */
  get night() {
    return this._nightAt(this.now)
  }

  // --- the chain ----------------------------------------------------------------

  /**
   * Pick a perch within SEARCH_M of (cx, cz) into `into` and return its kind,
   * or null when even the ground there is water. The kinds present are drawn
   * from evenly, so a butterfly beside one tree in a field lands on the tree as
   * often as on the grass.
   */
  _perchAt(cx, cz, rand, into) {
    const x0 = cx - SEARCH_M, z0 = cz - SEARCH_M, x1 = cx + SEARCH_M, z1 = cz + SEARCH_M
    const buf = this.buf
    const kinds = []
    let n = this.trees.anchorsInto(x0, z0, x1, z1, buf)
    if (n > 0) kinds.push('trunk')
    n = this.rocks.anchorsInto(x0, z0, x1, z1, buf)
    if (n > 0) kinds.push('rock')
    if (this.ferns && this.ferns.perchesInto(x0, z0, x1, z1, buf) > 0) kinds.push('fern')
    if (this.deadwood && this.deadwood.perchesInto(x0, z0, x1, z1, buf) > 0) kinds.push('deadwood')
    kinds.push('ground')
    const kind = kinds[Math.floor(rand() * kinds.length)]
    if (kind === 'trunk') {
      n = this.trees.anchorsInto(x0, z0, x1, z1, buf)
      const o = Math.floor(rand() * n) * 4
      // On the bark at a random height, facing out along the radius, head up.
      const a = rand() * TAU
      const r = buf[o + 3] + 0.005
      into.x = buf[o] + Math.sin(a) * r
      into.z = buf[o + 2] + Math.cos(a) * r
      into.y = this.height.heightAt(buf[o], buf[o + 2]) + between(rand, FLY_M)
      into.nx = Math.sin(a); into.ny = 0; into.nz = Math.cos(a)
      into.kind = kind
      return kind
    }
    if (kind === 'rock') {
      n = this.rocks.anchorsInto(x0, z0, x1, z1, buf)
      const o = Math.floor(rand() * n) * 4
      // A random point of the footprint's inner half; the stone's own top there, else the rock is not where its footprint says and the ground serves.
      const a = rand() * TAU
      const r = buf[o + 3] * 0.5 * Math.sqrt(rand())
      const px = buf[o] + Math.sin(a) * r
      const pz = buf[o + 2] + Math.cos(a) * r
      const top = this.rocks.blockTopAt(px, pz, 0, false)
      const h = this.height.heightAt(px, pz)
      if (top > h) {
        into.x = px; into.z = pz; into.y = top
        // The stone's slope from its top a hand either side.
        const e = 0.1
        const sx = (this._stoneOr(px + e, pz, top) - this._stoneOr(px - e, pz, top)) / (2 * e)
        const sz = (this._stoneOr(px, pz + e, top) - this._stoneOr(px, pz - e, top)) / (2 * e)
        _n.set(-sx, 1, -sz).normalize()
        into.nx = _n.x; into.ny = _n.y; into.nz = _n.z
        into.kind = kind
        return kind
      }
      return this._groundPerch(into, px, pz)
    }
    if (kind === 'fern') {
      n = this.ferns.perchesInto(x0, z0, x1, z1, buf)
      this.ferns.landOn(buf[Math.floor(rand() * n) * FERN_PERCH_STRIDE + 4], rand, _hit)
      into.x = _hit.x + _hit.nx * FERN_LIFT_M
      into.y = _hit.y + _hit.ny * FERN_LIFT_M
      into.z = _hit.z + _hit.nz * FERN_LIFT_M
      into.nx = _hit.nx; into.ny = _hit.ny; into.nz = _hit.nz
      into.kind = kind
      return kind
    }
    if (kind === 'deadwood') {
      n = this.deadwood.perchesInto(x0, z0, x1, z1, buf)
      const o = Math.floor(rand() * n) * 4
      const a = rand() * TAU
      const r = buf[o + 3] * 0.5 * Math.sqrt(rand())
      into.x = buf[o] + Math.sin(a) * r
      into.z = buf[o + 2] + Math.cos(a) * r
      into.y = buf[o + 1]
      into.nx = 0; into.ny = 1; into.nz = 0
      into.kind = kind
      return kind
    }
    const a = rand() * TAU
    const r = SEARCH_M * Math.sqrt(rand())
    return this._groundPerch(into, cx + Math.sin(a) * r, cz + Math.cos(a) * r)
  }

  _stoneOr(x, z, fallback) {
    const top = this.rocks.blockTopAt(x, z, 0, false)
    return top === -Infinity ? fallback : top
  }

  /** The ground at (x, z) as the perch, across its slope; null over water. */
  _groundPerch(into, x, z) {
    const { h, gx, gz } = this.height.heightAndSlopeAt(x, z)
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) { into.kind = null; return null }
    into.x = x; into.z = z; into.y = h
    _n.set(-gx, 1, -gz).normalize()
    into.nx = _n.x; into.ny = _n.y; into.nz = _n.z
    into.kind = 'ground'
    return 'ground'
  }

  /**
   * A station of the chain: a perch within SEARCH_M of (x, z) -- pulled back to
   * the tether ring about home first, so a chain of flights never walks a
   * butterfly off its meadow -- or, where there is nothing dry to sit on, a
   * point in the air over the ground there. Never null: the chain has to reach
   * the chapter's end whatever the ground under it is.
   */
  _perchNear(x, z, home, rand) {
    const dx = x - home.x, dz = z - home.z
    const d = Math.hypot(dx, dz)
    const cx = d > TETHER ? home.x + (dx / d) * TETHER : x
    const cz = d > TETHER ? home.z + (dz / d) * TETHER : z
    const st = { kind: null, x: cx, y: 0, z: cz, nx: 0, ny: 1, nz: 0 }
    if (this._perchAt(cx, cz, rand, st) !== null) return st
    st.kind = null
    st.x = cx
    st.z = cz
    st.y = this.walk.heightAt(cx, cz) + between(rand, ALT_M)
    st.nx = 0; st.ny = 1; st.nz = 0
    return st
  }

  /** The station `key`'s chapters open and close on, and where it spends the night: a pure function of its key. */
  _roost(key, home) {
    let r = this.roosts.get(key)
    if (r) return r
    r = this._perchNear(home.x, home.z, home, mulberry32(hash32(keyHash(key), 0x0057)))
    this.roosts.set(key, r)
    return r
  }

  /**
   * A flight from station `from` to `to`: never shorter than a bout, and never
   * shorter than the fastest butterfly needs to cross the ground between them
   * with the wander's slack -- so its duration is bounded by the tether however
   * far apart the two perches fell, which is what keeps a chapter inside itself.
   * The speed is the roll, or what the crossing asks, whichever is more.
   */
  _flight(rand, from, to) {
    const reach = Math.hypot(to.x - from.x, to.z - from.z) * 1.2
    const dur = Math.max(between(rand, FLY_S), reach / SPEED[1])
    const speed = Math.max(between(rand, SPEED), Math.min(SPEED[1], reach / dur))
    return { kind: 'fly', from, at: to, alt: between(rand, ALT_M), speed, dur, land: false, rise: false }
  }

  /**
   * One chapter of one butterfly's life, closed-form in (key, chapter): rest,
   * flight, rest, flight, opening on the roost and closing on it, with the
   * night spent there. Score.chapter trims the closing rest to the chapter.
   */
  _plan(key, chapter, rand) {
    const home = this.homes.get(key)
    if (!home) throw new Error(`Butterflies: no home for ${key}`)
    const roost = this._roost(key, home)
    // World seconds, for the night: the score's time is the butterfly's own, measured from its epoch.
    let t = chapter * BOUT_S + (keyHash(key) % BOUT_S) + home.epoch
    const phrases = []
    let total = 0
    let at = roost
    // One let go of a hand opens its first chapter on the wing at the hand, headed the way it was let go, and makes straight out to the tether's edge: the drop and that heading are the whole of what a peer is told, and this is what it plans from.
    if (home.drop && chapter === 0) {
      const from = { kind: null, x: home.x, y: home.y, z: home.z, nx: 0, ny: 1, nz: 0 }
      const ex = home.x + Math.cos(home.yaw) * TETHER
      const ez = home.z - Math.sin(home.yaw) * TETHER
      at = { kind: null, x: ex, y: this.walk.heightAt(ex, ez) + between(rand, ALT_M), z: ez, nx: 0, ny: 1, nz: 0 }
      const ph = this._flight(rand, from, at)
      phrases.push(ph); total += ph.dur; t += ph.dur
    }
    while (total + CLOSE_S < BOUT_S) {
      // After sunset: home to the roost, then rest after rest there until dawn, each its own REST_S long, so the meadow leaves again a few at a time rather than all on the frame the sun clears the horizon.
      while (this._nightAt(t) && total + CLOSE_S < BOUT_S) {
        if (at !== roost) {
          const ph = this._flight(rand, at, roost)
          phrases.push(ph); total += ph.dur; t += ph.dur
          at = roost
        } else {
          const more = { kind: 'rest', at, alt: between(rand, ALT_M), dur: between(rand, REST_S) }
          phrases.push(more); total += more.dur; t += more.dur
        }
      }
      if (total + CLOSE_S >= BOUT_S) break
      const rest = { kind: 'rest', at, alt: between(rand, ALT_M), dur: between(rand, REST_S) }
      phrases.push(rest); total += rest.dur; t += rest.dur
      if (total + CLOSE_S >= BOUT_S) break
      let to = this._perchNear(at.x, at.z, home, rand)
      let ph = this._flight(rand, at, to)
      // A flight that would still be up after sunset goes home instead, so the dark catches nobody halfway across a field.
      if (this._nightAt(t + ph.dur)) { to = roost; ph = this._flight(rand, at, roost) }
      phrases.push(ph); total += ph.dur; t += ph.dur
      at = to
    }
    if (at !== roost) {
      const ph = this._flight(rand, at, roost)
      phrases.push(ph); total += ph.dur
    }
    phrases.push({ kind: 'rest', at: roost, alt: between(rand, ALT_M), dur: BOUT_S })
    // A flight is flown at its perch only when it ends on one and a rest follows it: the flight home at dusk lands nowhere on the way. It climbs off one only when the rest before it sat there -- a perch a flight merely turned at is passed over at altitude, not dropped to and taken off from again.
    for (let i = 0; i < phrases.length; i++) {
      const ph = phrases[i]
      if (ph.kind !== 'fly') continue
      ph.land = ph.at.kind !== null && phrases[i + 1] !== undefined && phrases[i + 1].kind === 'rest'
      ph.rise = ph.from.kind !== null && i > 0 && phrases[i - 1].kind === 'rest'
    }
    return phrases
  }

  /**
   * The pose the chain holds at score second `t`, into `into`: the perch of a
   * rest, or a point along the flight at its altitude over the ground, leaving
   * the perch it left over RISE_S and meeting the one it ends on over LAND_S.
   */
  _station(b, t, into) {
    const cur = this.score.at(b.key, t)
    const ph = cur.phrase
    if (ph.kind === 'rest') {
      const a = ph.at
      into.kind = a.kind
      into.seat = a.kind !== null
      into.x = a.x
      into.z = a.z
      into.y = a.kind !== null ? a.y : this.walk.heightAt(a.x, a.z) + ph.alt
      into.nx = a.nx; into.ny = a.ny; into.nz = a.nz
      return into
    }
    const e = cur.elapsed
    const u = ph.dur > 0 ? Math.min(1, e / ph.dur) : 1
    const from = ph.from, to = ph.at
    into.x = from.x + (to.x - from.x) * u
    into.z = from.z + (to.z - from.z) * u
    const air = this.walk.heightAt(into.x, into.z) + ph.alt
    let y = air
    if (ph.rise && e < RISE_S) y = from.y + (air - from.y) * (e / RISE_S)
    if (ph.land && ph.dur - e < LAND_S) y = to.y + (air - to.y) * ((ph.dur - e) / LAND_S)
    into.y = y
    into.kind = null
    into.seat = false
    into.nx = 0; into.ny = 1; into.nz = 0
    return into
  }

  /** The phrase of the chain playing at score second `t`, onto the slot: its perch, its altitude and its speed. */
  _aim(b, t) {
    const cur = this.score.at(b.key, t)
    const ph = cur.phrase
    b.ph = ph
    b.phEnd = cur.start + ph.dur
    b.alt = ph.alt
    if (ph.kind === 'rest') {
      if (ph.at.kind !== null) this._target(b, ph.at)
      return
    }
    b.speed = ph.speed
    if (ph.land) this._target(b, ph.at)
  }

  _target(b, st) {
    b.perch = st.kind
    b.px = st.x; b.py = st.y; b.pz = st.z
    b.nx = st.nx; b.ny = st.ny; b.nz = st.nz
  }

  // --- the segments -------------------------------------------------------------

  /**
   * Segment `g` of `b` begins: it is put at the pose the chain holds at the
   * segment's start, told the pose the segment ends at, and given the PRNG the
   * segment is integrated on. Everything the flight carries forward is set
   * here, so two clients that meet the butterfly in different segments still
   * run this one identically.
   */
  _reset(b, g) {
    const start = g * GRID_S + b.offset
    b.seg = g
    b.rec.tick = tickAfter(start) - 1
    b.rec.alpha = 0
    b.rand = phraseRand(b.key, g, 1)
    this.segments++
    this._aim(b, start)
    this._station(b, start, _s0)
    this._station(b, start + GRID_S, _s1)
    b.ex = _s1.x; b.ey = _s1.y; b.ez = _s1.z; b.eSeat = _s1.seat
    b.x = b.ox = _s0.x
    b.y = b.oy = _s0.y
    b.z = b.oz = _s0.z
    b.ground = this.walk.heightAt(b.x, b.z)
    b.turn = 0
    b.vy = 0
    b.pitch = b.opitch = 0
    b.roll = b.oroll = 0
    b.stale = true
    // Every field the flight carries is rolled here in one order whichever state the segment opens in: a segment that opens at rest and takes off inside itself has to weave and beat the same as one that opened on the wing, or the two clients whose frames fell either side of the take-off fly it differently.
    b.weave = b.rand() * TAU
    b.jerk = between(b.rand, JERK_S)
    b.beat = between(b.rand, FLAP_S)
    const spin = b.rand() * TAU
    b.glide = false
    if (_s0.seat) {
      b.perch = _s0.kind
      b.px = _s0.x; b.py = _s0.y; b.pz = _s0.z
      b.nx = _s0.nx; b.ny = _s0.ny; b.nz = _s0.nz
      b.state = 'rest'
      b.yaw = b.oyaw = spin
      b.spd = 0
      b.amp = b.ampTo = REST_AMP
      b.base = b.baseTo = REST_BASE
      return
    }
    b.state = 'fly'
    // Headed where the segment ends, which is about where the ease was taking it; a station that stays put gets a fresh heading.
    const ex = _s1.x - _s0.x, ez = _s1.z - _s0.z
    b.yaw = b.oyaw = Math.hypot(ex, ez) > 0.05 ? headingTo(ex, ez) : spin
    b.spd = b.speed
    b.amp = b.ampTo = FLUTTER_AMP
    b.base = b.baseTo = 0
  }

  /** One tick of `b` at tick index `tick`. */
  _tick(b, tick) {
    this.ticks++
    const tNow = tick * TICK_S
    const dt = TICK_S
    const k = Math.min(1, EASE * dt)
    b.ox = b.x; b.oy = b.y; b.oz = b.z
    b.oyaw = b.yaw; b.opitch = b.pitch; b.oroll = b.roll
    if (tNow >= b.phEnd) this._aim(b, tNow)
    const ph = b.ph
    const w = easeWeight(tNow - (b.seg * GRID_S + b.offset), GRID_S)
    // It flies at its perch over a flight's last LAND_S, and from the moment the ease starts pulling it onto a seat the segment ends on -- the pull down onto a flower is the landing, whatever the phrase still says.
    const sit = ph.kind === 'rest' ? ph.at.kind !== null : ph.land && (tNow >= b.phEnd - LAND_S || (w > 0 && b.eSeat))
    if (sit) {
      if (b.state !== 'rest') {
        b.state = 'land'
        this._approach(b, dt, k)
      }
    } else {
      b.state = 'fly'
      this._wander(b, dt, k, tick)
    }
    if (b.state === 'rest') return
    this._beat(b, dt)
    // The ease closes the gap to the pose the segment ends at, so the turn's snap onto it is nothing the eye reads.
    if (w > 0) {
      const ke = Math.min(1, w * EASE_PULL * dt)
      b.x += (b.ex - b.x) * ke
      b.y += (b.ey - b.y) * ke
      b.z += (b.ez - b.z) * ke
    }
    // Whatever the flight and the ease came to between them, the tick obeys the climb: a butterfly never rises faster than CLIMB_TAN of the ground it covered, nor sinks faster than SINK_TAN of it. A butterfly flying at a perch is exempt -- it is coming down on it.
    if (b.state === 'fly') {
      const run = Math.hypot(b.x - b.ox, b.z - b.oz)
      b.y = Math.max(b.oy - run * SINK_TAN, Math.min(b.oy + run * CLIMB_TAN, b.y))
    }
  }

  /** A tick of erratic flight: the weave, the jerk, the tether, the height chase. */
  _wander(b, dt, k, tick) {
    const rand = b.rand
    // A weave, and every JERK_S a sharp turn: an impulse of TURN_RAD spent over TURN_TAU. Past the tether the turns are bent toward home.
    b.weave += TAU * WEAVE_HZ * dt
    b.jerk -= dt
    if (b.jerk <= 0) {
      b.jerk = between(rand, JERK_S)
      b.turn += (rand() < 0.5 ? -1 : 1) * between(rand, TURN_RAD) / TURN_TAU
    }
    b.turn *= Math.max(0, 1 - dt / TURN_TAU)
    const hx = b.homeX - b.x, hz = b.homeZ - b.z
    let rate = b.turn + Math.sin(b.weave) * 1.2
    if (hx * hx + hz * hz > TETHER * TETHER) rate += wrap(headingTo(hx, hz) - b.yaw) * 2
    b.yaw += rate * dt
    if ((tick + b.probe) % HEIGHT_EVERY === 0) b.ground = this.walk.heightAt(b.x, b.z)
    // The height is chased by a vertical velocity, lifted while flapping and sinking on a glide, and capped by the climb the forward speed allows.
    const want = (b.ground + b.alt - b.y) * EASE + (b.glide ? -SINK_MPS : LIFT_MPS)
    b.vy += (want - b.vy) * Math.min(1, 6 * dt)
    b.vy = Math.max(-b.spd * SINK_TAN, Math.min(b.spd * CLIMB_TAN, b.vy))
    const d = b.spd * dt
    b.x += Math.cos(b.yaw) * d
    b.z -= Math.sin(b.yaw) * d
    b.y += b.vy * dt
    b.pitch += (Math.atan2(b.vy, b.spd) * PITCH_K - b.pitch) * k
    b.roll += (-rate * 0.25 - b.roll) * k
  }

  /** A tick of the run in at the perch the slot's p/n fields hold; seated when it arrives. */
  _approach(b, dt, k) {
    // At a point held off the perch along its normal by as much as the butterfly is still away across the surface, so it comes in over the stone and settles onto it rather than through it.
    const hover = Math.min(HOVER_M, Math.hypot(b.px - b.x, b.pz - b.z))
    const dx = b.px + b.nx * hover - b.x, dy = b.py + b.ny * hover - b.y, dz = b.pz + b.nz * hover - b.z
    const dist = Math.hypot(dx, dy, dz)
    if (dist < SEAT_M) {
      this._seatOn(b)
      return
    }
    // Flown, not slid: the heading eases onto the perch with the weave still in it, and the rise is capped to the climb, so a high perch is circled up to.
    // The run slackens with the distance over the last metre, and it must: an eased heading chasing a point at full speed has a stable orbit of spd / 2pi around it (a butterfly that misses the seat by a hand swings round into that circle and rides it for the tile's life), and a run that shrinks with the distance shrinks the orbit to nothing.
    const near = Math.min(1, dist)
    b.weave += TAU * WEAVE_HZ * dt
    if (dx * dx + dz * dz > 1e-4) b.yaw += wrap(headingTo(dx, dz) - b.yaw) * Math.min(1, 4 * dt) + Math.sin(b.weave) * 0.8 * near * dt
    const h = Math.min(dist, b.spd * near * dt)
    const rise = Math.max(-h * SINK_TAN, Math.min(h * CLIMB_TAN, dy))
    b.x += Math.cos(b.yaw) * h
    b.z -= Math.sin(b.yaw) * h
    b.y += rise
    b.pitch += (Math.atan2(rise, h) * PITCH_K - b.pitch) * k
    b.roll += (-b.roll) * k
  }

  /** Seated on the perch its p/n fields hold: on the surface, wings raised and pulsing. */
  _seatOn(b) {
    if (b.state !== 'rest' && b.perch !== null) this.landings[b.perch]++
    b.x = b.ox = b.px
    b.y = b.oy = b.py
    b.z = b.oz = b.pz
    b.state = 'rest'
    b.ampTo = REST_AMP
    b.baseTo = REST_BASE
    b.turn = 0
    b.vy = 0
    b.spd = 0
    b.stale = true
  }

  /** The flap/glide cycle of a butterfly in the air: the wings' targets and the speed's surge and sag. */
  _beat(b, dt) {
    const rand = b.rand
    b.beat -= dt
    if (b.beat <= 0) {
      if (!b.glide && rand() < GLIDE_P) {
        b.glide = true
        b.beat = between(rand, GLIDE_S)
        b.ampTo = 0.08
        b.baseTo = GLIDE_BASE
      } else {
        b.glide = false
        b.beat = between(rand, FLAP_S)
        b.ampTo = FLUTTER_AMP
        b.baseTo = 0
      }
    }
    b.spd += ((b.glide ? 0.65 : 1.1) * b.speed - b.spd) * Math.min(1, EASE * dt)
  }

  // --- the meadow ---------------------------------------------------------------

  /** Put `b` on the meadow under `key`, with its home, and place it at the pose its chain holds now. */
  _wake(b, tile, key, x, y, z, yaw, drop, epoch) {
    b.tile = tile
    b.key = key
    // The chapter's own offset, cut to the grid, so a butterfly let go of a hand starts a segment as well as a chapter at the drop.
    b.offset = (keyHash(key) % BOUT_S) % GRID_S
    b.probe = keyHash(key) % HEIGHT_EVERY
    b.epoch = epoch
    b.homeX = x
    b.homeZ = z
    b.row = -1
    this.homes.set(key, { x, y, z, yaw, epoch, drop })
    const s = this.now - epoch
    this._reset(b, Math.floor((s - b.offset) / GRID_S))
  }

  /** Take `b` off the meadow: its slot back to the pool, and its chain forgotten. */
  _sleep(b) {
    if (b.key !== null) {
      this.homes.delete(b.key)
      this.roosts.delete(b.key)
      this.score.forget(b.key)
    }
    b.tile = null
    b.key = null
    b.seg = null
    b.row = -1
    this.free.push(b)
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, flock: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      let roll = rand() * MORPH_W
      const morph = MORPHS.find((m) => (roll -= m.w) < 0) ?? MORPHS[MORPHS.length - 1]
      const r = between(rand, morph.r)
      const g = between(rand, morph.g)
      const bl = between(rand, morph.b)
      const h = this.qualify(x, z)
      // After every roll, so one she caught leaves the rest of the tile as it grew.
      if (h === null || taken.has('butterfly', x, z)) continue
      const b = this.free.pop()
      if (!b) { this.overflow++; continue }
      b.size = size
      b.r = r; b.g = g; b.b = bl
      b.phase = rand() * TAU
      this._wake(b, t, keyOf(tx, tz, i), x, h, z, 0, false, 0)
      t.flock.push(b)
    }
    return t
  }

  /**
   * The drawn butterfly nearest a hand at (x, y, z) whose body -- a ball of
   * its own size -- is within `reach` metres: `{ dist, b, size }` for take(),
   * or null. For hands.js.
   */
  pickAt(x, y, z, reach) {
    let best = null
    let bestD = reach
    for (const t of this.tiles.values()) {
      for (const b of t.flock) {
        const d = Math.hypot(b.x - x, b.y - y, b.z - z) - b.size * 0.5
        if (d < bestD) {
          bestD = d
          best = { dist: Math.max(0, d), b, size: b.size }
        }
      }
    }
    return best
  }

  /**
   * Catch the butterfly of a pickAt() hit: its slot goes back to the pool, its
   * home is recorded so the tile never regrows it, and what the hand holds is
   * returned as a record for hands.js -- the card geometry, the shared
   * material, the wings at rest, the morph's tint and the size's scale.
   */
  take(hit) {
    const b = hit.b
    const t = b.tile
    if (!t) throw new Error(`Butterflies.take: slot ${b.id} is not in a tile`)
    const k = t.flock.indexOf(b)
    if (k < 0) throw new Error(`Butterflies.take: slot ${b.id} is not in its tile's flock`)
    taken.add('butterfly', b.homeX, b.homeZ)
    t.flock.splice(k, 1)
    const s = b.size / this.span
    const rec = {
      kind: 'butterfly',
      name: 'butterfly',
      size: b.size,
      geometry: this.mesh.geometry,
      material: this.material,
      attrs: { aWing: [b.phase, REST_AMP, REST_BASE] },
      color: [b.r, b.g, b.b],
      scale: [s, s, s],
      stowable: true,
    }
    this._sleep(b)
    return rec
  }

  /**
   * A peer caught the butterfly whose home is (x, z): take it out of its
   * flock here too and record the home. True when a resident tile has it.
   * For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'butterfly') return false
    for (const t of this.tiles.values()) {
      for (const b of t.flock) {
        if (Math.abs(b.homeX - x) >= TOLERANCE_M || Math.abs(b.homeZ - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, b, size: b.size })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed butterfly record is drawn with, or null until the wings land. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'butterfly') throw new Error(`Butterflies.dress: not a butterfly, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.mesh.geometry, material: this.material }
  }

  /**
   * Let a taken butterfly go at (x, y, z): it joins the flock of the tile
   * under it, on the wing at the hand, headed away from her head, and flies to
   * a perch that way. Its key is the drop point and that heading (dropKey), so
   * a peer told the same drop plans the same flight from the same instant.
   * False when no tile is resident there, when the point is at or under a water
   * surface -- a butterfly does not fly out of a lake, and hands.js floats it
   * up to the surface to bob there -- or when the pool is empty, and hands.js
   * drops it as a thing. The drop is owed to the room (pending), which is the
   * only way the other client is told of it at all.
   */
  release(rec, x, y, z, head, now = this.now) {
    if (rec.kind !== 'butterfly') throw new Error(`Butterflies.release: not a butterfly, ${rec.kind}`)
    x = snap(x); y = snap(y); z = snap(z)
    const hx = snap(head.x), hz = snap(head.z)
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t) return false
    const level = this.water.levelAt(x, z)
    if (level !== null && y <= level) return false
    const b = this.free.pop()
    if (!b) { this.overflow++; return false }
    const yaw = headingTo(x - hx, z - hz)
    const key = dropKey(x, z, yaw)
    b.size = rec.size
    b.r = rec.color[0]; b.g = rec.color[1]; b.b = rec.color[2]
    b.phase = rec.attrs.aWing[0]
    // Its epoch is the drop, so the chain's first chapter -- and its first segment -- open at the hand.
    this._wake(b, t, key, x, y, z, yaw, true, now - (keyHash(key) % BOUT_S))
    // The wings open from the rest they were held at.
    b.amp = REST_AMP
    b.base = REST_BASE
    b.ampTo = FLUTTER_AMP
    b.baseTo = 0
    t.flock.push(b)
    this._owe(key, now, x, y, z, yaw, hx, hz, b.size, b.r, b.g, b.b, b.phase)
    return true
  }

  /** A butterfly let go here goes to the room as one anchor in mode DROP; one heard from the room is only remembered, so it is not sent back. */
  _owe(key, T, x, y, z, yaw, hx, hz, size, r, g, bl, phase) {
    this.drops.add(key)
    if (this.applying) return
    this.outbox.push([dropWire(PREFIX, key), T, x, y, z, yaw, 0, DROP, null, hx, hz, size, r, g, bl, phase])
  }

  /** The releases this client owes the room since the last call, moved into `into`. For creature-net.js. */
  pending(into = []) {
    for (const a of this.outbox) into.push(a)
    this.outbox.length = 0
    return into
  }

  /**
   * A butterfly a peer let go: released here at the spot and the second their
   * hand did, in their butterfly's own colours, so both watch the one flight.
   * A drop already made here -- this client's own, come back on a fresh
   * welcome -- is nothing. Where no tile is resident it is refused, and this
   * client never sees that butterfly. For creature-net.js.
   */
  apply(anchor, now) {
    const [, T, x, y, z, yaw, , mode, by, hx, hz, size, r, g, bl, phase] = anchor
    if (by === null) return
    if (mode !== DROP) throw new Error(`Butterflies: no anchor mode ${mode}`)
    if (![T, x, y, z, yaw, hx, hz, size, r, g, bl, phase].every(Number.isFinite)) throw new Error(`Butterflies: a drop short of its numbers: ${JSON.stringify(anchor)}`)
    if (this.drops.has(dropKey(x, z, yaw))) return
    this.applying = true
    try {
      this.release({ kind: 'butterfly', size, color: [r, g, bl], attrs: { aWing: [phase] } }, x, y, z, { x: hx, y, z: hz }, T)
    } finally {
      this.applying = false
    }
  }

  _leave(t) {
    for (const b of t.flock) this._sleep(b)
    t.flock.length = 0
  }

  /** Rebuild every tile around (cx, cz) at world second `now`. Boot, and whenever the ground moves under her. */
  place(cx, cz, now = this.now) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.now = now
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let resting = 0
    for (const t of this.tiles.values()) for (const b of t.flock) if (b.state === 'rest') resting++
    return { alive: MAX - this.free.length, tiles: this.tiles.size, resting, overflow: this.overflow, segments: this.segments, ticks: this.ticks, landings: { ...this.landings } }
  }

  /** Into _quat: the card's up along the perch's normal, its body along its heading laid onto the surface -- or up the bark on a trunk. */
  _seat(b) {
    _n.set(b.nx, b.ny, b.nz)
    if (b.perch === 'trunk') _x.set(0, 1, 0)
    else _x.set(Math.cos(b.yaw), 0, -Math.sin(b.yaw))
    _x.addScaledVector(_n, -_x.dot(_n)).normalize()
    _z.crossVectors(_x, _n)
    _quat.setFromRotationMatrix(_basis.makeBasis(_x, _n, _z))
  }

  /**
   * One frame at the room's clock `now`: the tiles follow her head, every
   * butterfly on the meadow is run up to now on the score, and the ones within
   * DRAW_SPANS of their size are written between their last two ticks.
   */
  update(hx, hy, hz, now) {
    if (!Number.isFinite(now)) throw new Error(`Butterflies.update: bad world time ${now}`)
    // The frame's own seconds, for the wings; the flight runs on `now` itself.
    const dt = this.last === null ? 0 : Math.min(0.1, Math.max(0, now - this.last))
    this.last = now
    this.now = now
    this.head.x = hx
    this.head.z = hz
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.frame++
    const mat = this.mesh.instanceMatrix.array
    const wing = this.wing.array
    const tint = this.mesh.instanceColor.array
    const wk = Math.min(1, WING_EASE * dt)
    let n = 0
    for (const t of this.tiles.values()) {
      for (const b of t.flock) {
        const s = now - b.epoch
        const g = Math.floor((s - b.offset) / GRID_S)
        if (b.seg !== g) this._reset(b, g)
        stepTo(b.rec, s, (tick) => this._tick(b, tick), CATCH_UP_TICKS)
        if (b.state !== 'rest') b.stale = true

        b.amp += (b.ampTo - b.amp) * wk
        b.base += (b.baseTo - b.base) * wk
        b.phase += TAU * (b.state === 'rest' ? REST_HZ : FLUTTER_HZ) * dt
        // Kept to a turn: the attribute is float32, and a phase run up for an hour would flap in coarse steps.
        if (b.phase > TAU) b.phase -= TAU

        const a = b.rec.alpha
        const x = b.ox + (b.x - b.ox) * a
        const y = b.oy + (b.y - b.oy) * a
        const z = b.oz + (b.z - b.oz) * a
        b.row = -1
        const dx = x - hx, dy = y - hy, dz = z - hz
        const draw = b.size * DRAW_SPANS
        if (dx * dx + dy * dy + dz * dz > draw * draw) continue
        if (b.stale) {
          const sc = b.size / this.span
          if (b.state === 'rest') {
            _pos.set(x, y, z)
            this._seat(b)
          } else {
            // Each downstroke's lift, as a bounce on the wing phase, scaled by how hard the wings are beating.
            _pos.set(x, y + STROKE_M * Math.sin(b.phase) * (b.amp / FLUTTER_AMP), z)
            // Roll about the body, then pitch, then the heading: 'YZX' applies X first.
            _quat.setFromEuler(_euler.set(
              b.oroll + (b.roll - b.oroll) * a,
              b.oyaw + wrap(b.yaw - b.oyaw) * a,
              b.opitch + (b.pitch - b.opitch) * a,
              'YZX'
            ))
          }
          _scl.set(sc, sc, sc)
          _mat.compose(_pos, _quat, _scl).toArray(b.m)
          b.stale = false
        }
        mat.set(b.m, n * 16)
        wing[n * 3] = b.phase
        wing[n * 3 + 1] = b.amp
        wing[n * 3 + 2] = b.base
        tint[n * 3] = b.r; tint[n * 3 + 1] = b.g; tint[n * 3 + 2] = b.b
        b.row = n
        n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.wing.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
