// ---------------------------------------------------------------------------
// Butterflies: the meadow butterfly's two wing cards (tools/creatures/wing-cards.mjs)
// over the fields and through the forests below the snow line. Each 16 m tile
// around her rolls its own few from its seed (critters.js tileSeed) at DENSITY,
// and a butterfly is a slot in one InstancedMesh: four triangles, one 128 px
// cutout, drawn from both sides.
//
// A butterfly lives in three states. FLYING it wanders tethered to the point it
// was rolled at, holding a height it re-rolls now and then in FLY_M over the
// ground it is crossing -- the field, or the stone on it (WalkSurface.heightAt),
// read every HEIGHT_EVERY frames. THE FLIGHT IS ERRATIC ON PURPOSE, as a real
// one's is (a predator cannot lead an unpredictable target): the heading is a
// weave broken every JERK_S by a sharp turn impulse that decays over TURN_TAU,
// the wings beat in bursts of FLAP_S and glide for GLIDE_S between, so the
// speed surges and sags and the body bounds -- lifted while flapping, sinking
// on a glide -- and the height is chased by a vertical velocity that may never
// exceed the forward speed's CLIMB_TAN on the way up, so a butterfly climbs
// along its path at a pitch and never rises straight. Each stroke's lift shows
// as a STROKE_M bounce on the wing phase.
// When a flight bout is up it looks for a PERCH within SEARCH_M: a tree trunk
// (Trees.anchorsInto, landing on the bark at a height in FLY_M), a boulder
// (Rocks.anchorsInto, then blockTopAt for the stone's top), a fern's crown or a
// stump's or log's top (their perchesInto), or failing those the ground itself,
// and flies to it; LANDED it holds the surface for REST_S with its wings raised
// and pulsing slowly, then takes off. Over water it never lands.
//
// AFTER SUNSET NOTHING FLIES. `dayness` is the world's one day scalar (main.js,
// the sun's own elevation) and below NIGHT_DAY -- the sun on the horizon -- a
// flight ends at the next perch it can find and no landed butterfly takes off
// again; a tile that grows in the dark arrives already seated on one. The rest
// is re-rolled rather than left expired, so dawn does not launch the whole
// meadow on a single frame.
//
// THE WINGS ARE THE VERTEX SHADER. The cards lie flat in the mesh's XZ with the
// body along X and the seam at z = 0, and `aWing` per instance is the flap's
// phase, its amplitude and the angle the wings rest about; each wing is turned
// about the seam by base + amp * sin(phase), and its normal with it. In flight
// the phase runs at FLUTTER_HZ over a wide amplitude about the flat; at rest at
// REST_HZ over a narrow one about REST_BASE, wings up. Both faces take the
// authored normal's light, as the critter card does.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CRITTER_GLB, loadCritterGlb, setCritterAsset, tileSeed, walkTiles } from './critters.js'

export const TILE = 16
export const RADIUS = 40
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
// The day scalar below which a butterfly is grounded. dayness is (sun elevation + 6) / 10 clamped, so 0.6 is the sun exactly on the horizon.
export const NIGHT_DAY = 0.6
// At most this long between a nightfall flier looking for somewhere to land and looking again. A perch search is four spatial queries, so it is not run every frame over a lake.
const NIGHT_LAND_S = 1.5
// The wings: flap rate in Hz and half-angle in radians in flight; pulse rate, half-angle and the angle the wings rest raised at, landed; held at GLIDE_BASE in a glide.
export const FLUTTER_HZ = 11
export const FLUTTER_AMP = 1.0
export const REST_HZ = 0.6
export const REST_AMP = 0.2
export const REST_BASE = 1.15
export const GLIDE_BASE = 0.35
// Drawn within this many wingspans of her head: past it a butterfly is under a pixel and is not written.
export const DRAW_SPANS = 500
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
// Frames between a flying butterfly's ground reads.
const HEIGHT_EVERY = 4
// How fast the height chase, speed, pitch and roll ease per second, and the wings.
const EASE = 3
const WING_EASE = 8
// Held this far inside FLY_M when a height is rolled, so the bounding stays in the band.
const ALT_PAD = 0.2
// A landing's approach: held this far off the perch along its normal on the way in, and seated within SEAT_M of it.
const HOVER_M = 0.15
const SEAT_M = 0.03
// Perch buffers: how many of a kind a 2 * SEARCH_M box may hold.
const PERCH_BUF = 32

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const ALT_M = [FLY_M[0] + ALT_PAD, FLY_M[1] - ALT_PAD]
// A heading `yaw` is the body's +X turned about +Y: (cos yaw, 0, -sin yaw); the angle toward (dx, dz) is atan2(-dz, dx).
const headingTo = (dx, dz) => Math.atan2(-dz, dx)
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _basis = new THREE.Matrix4()

export class Butterflies {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt
   * @param opts.walk      WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.rocks     Rocks: anchorsInto, blockTopAt
   * @param opts.trees     Trees: anchorsInto
   * @param opts.ferns     Ferns: perchesInto, or null
   * @param opts.deadwood  Deadwood: perchesInto, or null
   * @param opts.assets    a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, rocks, trees, ferns = null, deadwood = null, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Butterflies needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.levelAt !== 'function') throw new Error('Butterflies needs WaterSurfaces, for levelAt')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Butterflies needs the WalkSurface, for heightAt')
    if (!rocks || typeof rocks.anchorsInto !== 'function' || typeof rocks.blockTopAt !== 'function') throw new Error('Butterflies needs Rocks, for anchorsInto and blockTopAt')
    if (!trees || typeof trees.anchorsInto !== 'function') throw new Error('Butterflies needs Trees, for anchorsInto')
    if (ferns && typeof ferns.perchesInto !== 'function') throw new Error('Butterflies: `ferns` was given but has no perchesInto')
    if (deadwood && typeof deadwood.perchesInto !== 'function') throw new Error('Butterflies: `deadwood` was given but has no perchesInto')
    this.height = height
    this.water = water
    this.walk = walk
    this.rocks = rocks
    this.trees = trees
    this.ferns = ferns
    this.deadwood = deadwood
    this.seed = seed
    this.rand = mulberry32(seed ^ 0xb77f)

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
    // The layer toggle flips the group, so it cannot unhide the mesh before its geometry lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-butterflies'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        homeX: 0, homeZ: 0, x: 0, y: 0, z: 0, size: 0.06,
        // 'fly' wanders, 'land' flies at the perch, 'rest' sits on it. `left` counts the state down.
        state: 'fly', left: 0, yaw: 0, turn: 0, weave: 0, jerk: 0, alt: 1, ground: 0, roll: 0, pitch: 0,
        // The speed the bout is flown at, the speed now, the vertical velocity; the flap/glide cycle's timer and which half it is in.
        speed: 1, spd: 1, vy: 0, beat: 0, glide: false,
        // The perch: its kind, its point and the surface normal there.
        perch: null, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0,
        // The wings: phase, and the amplitude / base angle with the figures they ease toward.
        phase: 0, amp: FLUTTER_AMP, base: 0, ampTo: FLUTTER_AMP, baseTo: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.frame = 0
    // The world's day scalar, written by update(). Full day until the clock says otherwise, so a gate that never passes one gets noon.
    this.dayness = 1
    this.head = { x: 0, z: 0 }
    this.buf = new Float32Array(PERCH_BUF * 4)
    this.span = 1
    this.loaded = false
    this.overflow = 0
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

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, flock: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const size = between(rand, SIZE_M)
      const yaw = rand() * Math.PI * 2
      const alt = between(rand, ALT_M)
      const h = this.qualify(x, z)
      if (h === null) continue
      const b = this.free.pop()
      if (!b) { this.overflow++; continue }
      b.tile = t
      b.homeX = b.x = x
      b.homeZ = b.z = z
      b.ground = h
      b.y = h + alt
      b.size = size
      b.yaw = yaw
      b.turn = 0
      b.roll = 0
      b.pitch = 0
      b.vy = 0
      b.alt = alt
      b.weave = rand() * Math.PI * 2
      b.jerk = between(rand, JERK_S)
      b.beat = between(rand, FLAP_S)
      b.glide = false
      b.phase = rand() * Math.PI * 2
      b.amp = b.ampTo = FLUTTER_AMP
      b.base = b.baseTo = 0
      b.speed = b.spd = between(rand, SPEED)
      b.state = 'fly'
      b.left = between(rand, FLY_S)
      // Grown after dark: already seated, rather than flying to a perch across a tile that has only just appeared. The tile's own generator, so the whole of _enter stays a pure function of its seed.
      if (this.night) {
        const kind = this._perch(b, rand)
        if (kind !== null) {
          this.landings[kind]++
          this._rest(b, kind, rand)
          b.amp = b.ampTo
          b.base = b.baseTo
        }
      }
      t.flock.push(b)
    }
    return t
  }

  _leave(t) {
    for (const b of t.flock) {
      b.tile = null
      this.free.push(b)
    }
    t.flock.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. */
  place(cx, cz) {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.overflow = 0
    this.head.x = cx
    this.head.z = cz
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  /** Whether the sun is down far enough that nothing flies. */
  get night() {
    return this.dayness < NIGHT_DAY
  }

  get stats() {
    let resting = 0
    for (const t of this.tiles.values()) for (const b of t.flock) if (b.state === 'rest') resting++
    return { alive: MAX - this.free.length, tiles: this.tiles.size, resting, overflow: this.overflow, landings: { ...this.landings } }
  }

  /**
   * Pick a perch within SEARCH_M of the butterfly into its p/n fields and
   * return its kind, or null when even the ground there is water. The kinds
   * present are drawn from evenly, so a butterfly beside one tree in a field
   * lands on the tree as often as on the grass. `rand` is the layer's own
   * generator in flight, and the tile's when a tile is grown after dark.
   */
  _perch(b, rand = this.rand) {
    const x0 = b.x - SEARCH_M, z0 = b.z - SEARCH_M, x1 = b.x + SEARCH_M, z1 = b.z + SEARCH_M
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
      const a = rand() * Math.PI * 2
      const r = buf[o + 3] + 0.005
      b.px = buf[o] + Math.sin(a) * r
      b.pz = buf[o + 2] + Math.cos(a) * r
      b.py = this.height.heightAt(buf[o], buf[o + 2]) + between(rand, FLY_M)
      b.nx = Math.sin(a); b.ny = 0; b.nz = Math.cos(a)
      return kind
    }
    if (kind === 'rock') {
      n = this.rocks.anchorsInto(x0, z0, x1, z1, buf)
      const o = Math.floor(rand() * n) * 4
      // A random point of the footprint's inner half; the stone's own top there, else the rock is not where its footprint says and the ground serves.
      const a = rand() * Math.PI * 2
      const r = buf[o + 3] * 0.5 * Math.sqrt(rand())
      b.px = buf[o] + Math.sin(a) * r
      b.pz = buf[o + 2] + Math.cos(a) * r
      const top = this.rocks.blockTopAt(b.px, b.pz, 0, false)
      const h = this.height.heightAt(b.px, b.pz)
      if (top > h) {
        b.py = top
        // The stone's slope from its top a hand either side.
        const e = 0.1
        const sx = (this._stoneOr(b.px + e, b.pz, top) - this._stoneOr(b.px - e, b.pz, top)) / (2 * e)
        const sz = (this._stoneOr(b.px, b.pz + e, top) - this._stoneOr(b.px, b.pz - e, top)) / (2 * e)
        _n.set(-sx, 1, -sz).normalize()
        b.nx = _n.x; b.ny = _n.y; b.nz = _n.z
        return kind
      }
      return this._groundPerch(b, b.px, b.pz)
    }
    if (kind === 'fern' || kind === 'deadwood') {
      n = (kind === 'fern' ? this.ferns : this.deadwood).perchesInto(x0, z0, x1, z1, buf)
      const o = Math.floor(rand() * n) * 4
      const a = rand() * Math.PI * 2
      const r = buf[o + 3] * 0.5 * Math.sqrt(rand())
      b.px = buf[o] + Math.sin(a) * r
      b.pz = buf[o + 2] + Math.cos(a) * r
      b.py = buf[o + 1]
      b.nx = 0; b.ny = 1; b.nz = 0
      return kind
    }
    const a = rand() * Math.PI * 2
    const r = SEARCH_M * Math.sqrt(rand())
    return this._groundPerch(b, b.x + Math.sin(a) * r, b.z + Math.cos(a) * r)
  }

  /** Seated on the perch its p/n fields hold: on the surface, wings raised and pulsing, the rest timed. */
  _rest(b, kind, rand = this.rand) {
    b.perch = kind
    b.x = b.px; b.y = b.py; b.z = b.pz
    b.state = 'rest'
    b.left = between(rand, REST_S)
    b.ampTo = REST_AMP
    b.baseTo = REST_BASE
    b.turn = 0
    b.vy = 0
  }

  _stoneOr(x, z, fallback) {
    const top = this.rocks.blockTopAt(x, z, 0, false)
    return top === -Infinity ? fallback : top
  }

  /** The ground at (x, z) as the perch, across its slope; null over water. */
  _groundPerch(b, x, z) {
    const { h, gx, gz } = this.height.heightAndSlopeAt(x, z)
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) return null
    b.px = x; b.pz = z; b.py = h
    _n.set(-gx, 1, -gz).normalize()
    b.nx = _n.x; b.ny = _n.y; b.nz = _n.z
    return 'ground'
  }

  /** One frame of one butterfly. */
  _step(b, dt) {
    const k = Math.min(1, EASE * dt)
    b.left -= dt
    // After sunset a flight ends at the next perch rather than when its bout runs out. Clamped rather than zeroed, so a butterfly out over a lake looks again every NIGHT_LAND_S instead of every frame.
    if (this.night && b.state === 'fly' && b.left > NIGHT_LAND_S) b.left = NIGHT_LAND_S
    if (b.state === 'rest') {
      if (b.left <= 0 && this.night) {
        // Rolled again rather than left expired: at dawn they leave over a whole REST_S and not all on the frame the sun clears the horizon.
        b.left = between(this.rand, REST_S)
      } else if (b.left <= 0) {
        b.state = 'fly'
        b.left = between(this.rand, FLY_S)
        b.alt = between(this.rand, ALT_M)
        b.speed = between(this.rand, SPEED)
        // Off the bark away from the trunk; anywhere from a top.
        b.yaw = b.perch === 'trunk' ? headingTo(b.nx, b.nz) + (this.rand() - 0.5) * 2 : this.rand() * Math.PI * 2
        b.spd = b.speed * 0.3
        b.vy = 0
        b.glide = false
        b.beat = between(this.rand, FLAP_S)
        b.ampTo = FLUTTER_AMP
        b.baseTo = 0
      }
    } else if (b.state === 'fly' && b.left <= 0) {
      const kind = this._perch(b)
      if (kind === null) {
        b.left = between(this.rand, FLY_S) * 0.3
      } else {
        b.state = 'land'
        b.perch = kind
        this.landings[kind]++
      }
    }
    if (b.state !== 'rest') this._beat(b, dt)
    if (b.state === 'fly') {
      // A weave, and every JERK_S a sharp turn: an impulse of TURN_RAD spent over TURN_TAU. Past the tether the turns are bent toward home.
      b.weave += Math.PI * 2 * WEAVE_HZ * dt
      b.jerk -= dt
      if (b.jerk <= 0) {
        b.jerk = between(this.rand, JERK_S)
        b.turn += (this.rand() < 0.5 ? -1 : 1) * between(this.rand, TURN_RAD) / TURN_TAU
      }
      b.turn *= Math.max(0, 1 - dt / TURN_TAU)
      const hx = b.homeX - b.x, hz = b.homeZ - b.z
      let rate = b.turn + Math.sin(b.weave) * 1.2
      if (hx * hx + hz * hz > TETHER * TETHER) rate += wrap(headingTo(hx, hz) - b.yaw) * 2
      b.yaw += rate * dt
      if ((this.frame + b.id) % HEIGHT_EVERY === 0) b.ground = this.walk.heightAt(b.x, b.z)
      if (this.rand() < 0.3 * dt) b.alt = between(this.rand, ALT_M)
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
    } else if (b.state === 'land') {
      // At a point held off the perch along its normal by as much as the butterfly is still away across the surface, so it comes in over the stone and settles onto it rather than through it.
      const hover = Math.min(HOVER_M, Math.hypot(b.px - b.x, b.pz - b.z))
      const dx = b.px + b.nx * hover - b.x, dy = b.py + b.ny * hover - b.y, dz = b.pz + b.nz * hover - b.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist < SEAT_M) {
        this._rest(b, b.perch)
      } else {
        // Flown, not slid: the heading eases onto the perch with the weave still in it, and the rise is capped to the climb, so a high perch is circled up to.
        // The run slackens with the distance over the last metre, and it must: an eased heading chasing a point at full speed has a stable orbit of spd / 2pi around it (a butterfly that misses the seat by a hand swings round into that circle and rides it for the tile's life), and a run that shrinks with the distance shrinks the orbit to nothing.
        const near = Math.min(1, dist)
        b.weave += Math.PI * 2 * WEAVE_HZ * dt
        if (dx * dx + dz * dz > 1e-4) b.yaw += wrap(headingTo(dx, dz) - b.yaw) * Math.min(1, 4 * dt) + Math.sin(b.weave) * 0.8 * near * dt
        const h = Math.min(dist, b.spd * near * dt)
        const rise = Math.max(-h * SINK_TAN, Math.min(h * CLIMB_TAN, dy))
        b.x += Math.cos(b.yaw) * h
        b.z -= Math.sin(b.yaw) * h
        b.y += rise
        b.pitch += (Math.atan2(rise, h) * PITCH_K - b.pitch) * k
        b.roll += (-b.roll) * k
      }
    }
    const w = Math.min(1, WING_EASE * dt)
    b.amp += (b.ampTo - b.amp) * w
    b.base += (b.baseTo - b.base) * w
    b.phase += Math.PI * 2 * (b.state === 'rest' ? REST_HZ : FLUTTER_HZ) * dt
    // Kept to a turn: the attribute is float32, and a phase run up for an hour would flap in coarse steps.
    if (b.phase > Math.PI * 2) b.phase -= Math.PI * 2
  }

  /** The flap/glide cycle of a butterfly in the air: the wings' targets and the speed's surge and sag. */
  _beat(b, dt) {
    b.beat -= dt
    if (b.beat <= 0) {
      if (!b.glide && this.rand() < GLIDE_P) {
        b.glide = true
        b.beat = between(this.rand, GLIDE_S)
        b.ampTo = 0.08
        b.baseTo = GLIDE_BASE
      } else {
        b.glide = false
        b.beat = between(this.rand, FLAP_S)
        b.ampTo = FLUTTER_AMP
        b.baseTo = 0
      }
    }
    b.spd += ((b.glide ? 0.65 : 1.1) * b.speed - b.spd) * Math.min(1, EASE * dt)
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
   * One frame: the tiles follow her head, every butterfly in reach is stepped,
   * and the ones within DRAW_SPANS of their size are written. `dayness` is the
   * world's day scalar, and under NIGHT_DAY it is what grounds them.
   */
  update(hx, hy, hz, dt, dayness = 1) {
    dt = Math.min(dt, 0.1)
    this.dayness = dayness
    this.head.x = hx
    this.head.z = hz
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    this.frame++
    const mat = this.mesh.instanceMatrix.array
    const wing = this.wing.array
    let n = 0
    for (const t of this.tiles.values()) {
      for (const b of t.flock) {
        this._step(b, dt)
        const dx = b.x - hx, dy = b.y - hy, dz = b.z - hz
        const draw = b.size * DRAW_SPANS
        if (dx * dx + dy * dy + dz * dz > draw * draw) continue
        const s = b.size / this.span
        if (b.state === 'rest') {
          _pos.set(b.x, b.y, b.z)
          this._seat(b)
        } else {
          // Each downstroke's lift, as a bounce on the wing phase, scaled by how hard the wings are beating.
          _pos.set(b.x, b.y + STROKE_M * Math.sin(b.phase) * (b.amp / FLUTTER_AMP), b.z)
          // Roll about the body, then pitch, then the heading: 'YZX' applies X first.
          _quat.setFromEuler(_euler.set(b.roll, b.yaw, b.pitch, 'YZX'))
        }
        _scl.set(s, s, s)
        _mat.compose(_pos, _quat, _scl).toArray(mat, n * 16)
        wing[n * 3] = b.phase
        wing[n * 3 + 1] = b.amp
        wing[n * 3 + 2] = b.base
        n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.wing.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
