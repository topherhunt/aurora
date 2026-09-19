// ---------------------------------------------------------------------------
// Grasshoppers: the shipped Tripo pick (public/creatures/meadow-grasshopper.glb,
// tools/creatures/ship.mjs; 281 triangles on a 128 px map) on the grass and
// the forest floor below the snow line. Each TILE-metre tile around her rolls
// its own from its seed (critters.js tileSeed) at DENSITY, and a grasshopper
// is a slot in ONE InstancedMesh: every shown one is one draw call, whatever
// their number. No LOD ladder: past SHOW_M nothing is drawn, and within it a
// 300-triangle body at a few dozen instances is cheaper than a second program.
// The head is +X, like every shipped critter (the roster's faceTurnDeg), and
// the loader puts the feet on y = 0 (critters.js loadCritterGlb).
//
// THE COLOUR IS A TINT. The map is one olive-and-tan grasshopper; each rolls a
// mix of TINT_GREEN and TINT_BROWN and a SHADE, a per-channel multiplier on
// the map in linear RGB carried in instanceColor, so a meadow holds greener
// ones beside browner ones in one draw.
//
// A grasshopper SITS on the ground -- the walk surface, the field or the stone
// on it -- its up along the field's slope, for REST_S, then HOPS: a heading
// bent home past TETHER, a distance and a height each rolled in HOP_M, the
// landing point qualified as the roll was (dry, below the snow) and its
// height read off the walk surface. A landing that finds water or snow is
// rolled again a few times, then the rest is extended. AFTER SUNSET NONE
// HOPS: a rest that runs out under NIGHT_DAY is rolled again, so dawn does not
// launch the meadow on one frame, and one caught in the air finishes its hop.
//
// THE HOP IS A KICK, GRAVITY'S RISE AND A HARD DROP. What reads as weight is
// the arc's ENDS and its FALL. It CROUCHES first, the body squashed toward
// the ground over CROUCH_S, the wind-up before the kick. The kick is instant,
// at a launch angle rolled in LAUNCH_DEG, and the apex is what that angle
// gives the rolled distance (dist * tan / 4), so a short hop is a low flick
// and a long one is lofted -- never a short hop under a tall arc, which hangs
// in the air like a balloon. In the air the horizontal speed bleeds away
// (flightProgress: an exponential ease-out at DRAG_K, so the second half of
// the flight covers less ground than the first) and the height over the
// chord is a parabola up under GRAVITY to its apex and a parabola down under
// FALL_G gravities (flightLift), which puts the apex at RISE_FRAC of the
// flight: the take-off is steep, the top does not hang, and the drop onto the
// grass comes down harder and steeper than it went up. A true parabola's fall
// is as slow as its rise, and at this size that reads as floating; the extra
// pull on the way down is the snap of a body with weight. Then it LANDS: the
// body snaps level and squashes and recovers over LAND_S, the legs taking the
// fall. The body pitches with the path's angle by PITCH_K.
//
// SHE ONLY SEES THEM WITHIN SHOW_M. A slot is stepped and written only while
// it is that close to her head; past it a grasshopper holds where it was --
// mid-hop or seated, nobody can see -- and the tiles stay resident out to
// RADIUS so the ground within SHOW_M is always rolled. At 6--10 cm a
// grasshopper at 8 m is a few pixels, so there is no pop to see.
//
// bodies() lists the shown ones for the ambience, which chirps them: by day
// now and then, and at night these ARE the near crickets, over the far bed.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { CRITTER_GLB, loadCritterGlb, setCritterAsset, tierTintSplice, tileKey, tileSeed, walkTiles } from './critters.js'
import { taken, TOLERANCE_M } from '../taken.js'

export const TILE = 8
// Within this of her head a grasshopper is stepped and drawn.
export const SHOW_M = 8
// Tiles whose centre lies within this are resident: SHOW_M plus a tile's half diagonal, so every point she can see one at is on a rolled tile.
export const RADIUS = SHOW_M + (TILE * Math.SQRT2) / 2
// Grasshoppers per square metre: one per 16 m2, so a tile rolls four and she sees a dozen.
export const DENSITY = 0.0625
// Below this dayness -- the sun on the horizon, the butterflies' line -- none hops; one in the air lands and sits.
export const NIGHT_DAY = 0.6
export const MAX = 256
// Ground within this of the snow line is too cold to roll on, and ground steeper than this is neither grass nor forest floor.
export const SNOW_MARGIN = 20
export const MAX_SLOPE_DEG = 38
// The length in metres, antennae tips to tail, 8 cm give or take a fifth: the mesh's X extent is scaled to it.
export const LENGTH_M = [0.064, 0.096]
// The tint's two ends, per-channel multipliers on the map in linear RGB, mixed by a roll; and the brightness roll on top.
export const TINT_GREEN = [0.65, 1.2, 0.5]
export const TINT_BROWN = [1.15, 0.9, 0.7]
export const SHADE = [0.85, 1.15]
// Seated between hops, seconds; a hop's distance, metres; and the kick's angle off the ground, degrees, which with the distance sets the apex.
export const REST_S = [1, 6]
export const HOP_M = [0.2, 1.5]
export const LAUNCH_DEG = [45, 65]
// The crouch before the kick and the settle after the landing: each this long, the body squashed to this fraction of its height at the deepest.
export const CROUCH_S = 0.12
export const CROUCH_SQUASH = 0.65
export const LAND_S = 0.18
export const LAND_SQUASH = 0.7
// The flight's shape: the horizontal ease-out's rate (the landing speed is exp(-DRAG_K) of the launch's), and the gravities the body falls under past its apex -- 1 is a true parabola, and the extra is the snap.
export const DRAG_K = 1.2
export const FALL_G = 1.5
export const GRAVITY = 9.81
// The fraction of the flight spent rising: the rise takes gravity's time for the apex and the fall takes that over sqrt(FALL_G).
export const RISE_FRAC = 1 / (1 + 1 / Math.sqrt(FALL_G))
// How far from home a grasshopper ranges before its hops are bent back.
export const TETHER = 4
// The body pitches this much of the path's angle in the air.
export const PITCH_K = 0.6
// How many landing points a hop tries before the rest is extended by REST_S instead.
const HOP_TRIES = 4

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const MAX_SLOPE_TAN = Math.tan((MAX_SLOPE_DEG * Math.PI) / 180)
// A heading `yaw` is the body's +X turned about +Y: (cos yaw, 0, -sin yaw); the angle toward (dx, dz) is atan2(-dz, dx).
const headingTo = (dx, dz) => Math.atan2(-dz, dx)
const _n = new THREE.Vector3()
const _x = new THREE.Vector3()
const _z = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _pos = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _basis = new THREE.Matrix4()

const DRAG_NORM = 1 - Math.exp(-DRAG_K)
/** The fraction of the hop's ground covered at fraction `s` of its flight: an ease-out, the launch speed bleeding away. */
export const flightProgress = (s) => (1 - Math.exp(-DRAG_K * s)) / DRAG_NORM
/** d flightProgress / ds. */
const flightProgressRate = (s) => (DRAG_K * Math.exp(-DRAG_K * s)) / DRAG_NORM
/** The height over the chord at fraction `s` of the flight, as a fraction of the apex: a half-parabola up over RISE_FRAC of the flight, a steeper half-parabola down over the rest. */
export const flightLift = (s) => {
  const u = s < RISE_FRAC ? (RISE_FRAC - s) / RISE_FRAC : (s - RISE_FRAC) / (1 - RISE_FRAC)
  return 1 - u * u
}
/** d flightLift / ds. */
const flightLiftRate = (s) => (s < RISE_FRAC ? (2 * (RISE_FRAC - s)) / (RISE_FRAC * RISE_FRAC) : (-2 * (s - RISE_FRAC)) / ((1 - RISE_FRAC) * (1 - RISE_FRAC)))

export class Grasshoppers {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt
   * @param opts.walk    WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.assets  a parsed asset (critters.js shape) for a gate; the world fetches the GLB
   */
  constructor(scene, height, water, { seed = 1, walk, assets = null } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.heightAndSlopeAt !== 'function' || typeof height.snowLineAt !== 'function') {
      throw new Error('Grasshoppers needs a height field with heightAt, heightAndSlopeAt and snowLineAt')
    }
    if (!water || typeof water.levelAt !== 'function') throw new Error('Grasshoppers needs WaterSurfaces, for levelAt')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Grasshoppers needs the WalkSurface, for heightAt')
    this.height = height
    this.water = water
    this.walk = walk
    this.seed = seed
    this.rand = mulberry32(seed ^ 0x6a55)

    // Dry chitin: Lambert, no glint. The tint rides three's own instanceColor.
    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff })
    this.material.onBeforeCompile = (shader) => tierTintSplice(shader, 0)
    this.material.customProgramCacheKey = () => 'grasshoppers'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    this.mesh.name = 'v2-grasshoppers'
    this.mesh.count = 0
    // Hidden, not merely empty, until the asset lands: the boot's scene census throws on a visible mesh with no geometry.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The tint, through three's own vColor; made here so the program is keyed with it from the first draw.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // The layer toggle flips the group, so it cannot unhide the mesh before its asset lands.
    this.batch = new THREE.Group()
    this.batch.name = 'v2-grasshoppers'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        homeX: 0, homeZ: 0, x: 0, y: 0, z: 0, len: 0.08, yaw: 0, pitch: 0,
        // The tint (TINT_GREEN..TINT_BROWN by SHADE), linear RGB.
        r: 1, g: 1, b: 1,
        // 'sit' on the ground for `left` seconds; 'crouch' for CROUCH_S; 'hop' from (x0, y0, z0) to (x1, y1, z1), `apex` over the chord, over `T` seconds; 'land' for LAND_S. `t` is the seconds into the crouch, the hop or the landing; `squash` the body's height as a fraction of its own.
        state: 'sit', left: 0, x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0, apex: 0, T: 1, t: 0, squash: 1,
        // The ground's normal where it sits.
        nx: 0, ny: 1, nz: 0,
        // Its matrix, and whether the matrix trails the step.
        m: new Float32Array(16), stale: true,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.head = { x: 0, y: 0, z: 0 }
    this.dayness = 1
    this.overflow = 0
    this.hops = 0
    this.loaded = false
    // The asset's X extent (setCritterAsset); the instance scale is len / length.
    this.length = 1
    // The shown ones, for bodies(): rebuilt by update().
    this.shown = []

    if (assets) {
      this.setAsset(assets)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    this.setAsset(await loadCritterGlb(CRITTER_GLB.grasshopper))
    return true
  }

  setAsset(asset) {
    const bounds = setCritterAsset(this.mesh, this.material, asset, 'grasshoppers')
    this.length = bounds.halfX * 2
    this.loaded = true
  }

  /** Whether a grasshopper may sit at (x, z): warm, dry, no steeper than grass grows. Returns the field height or null. */
  qualify(x, z) {
    const { h, tan } = this.height.heightAndSlopeAt(x, z)
    if (tan > MAX_SLOPE_TAN) return null
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) return null
    return h
  }

  /** Seated at (x, z) on the walk surface with its up along the field's slope there. */
  _seatAt(g, x, z) {
    const { gx, gz } = this.height.heightAndSlopeAt(x, z)
    g.x = x
    g.z = z
    g.y = this.walk.heightAt(x, z)
    _n.set(-gx, 1, -gz).normalize()
    g.nx = _n.x; g.ny = _n.y; g.nz = _n.z
    g.pitch = 0
    g.squash = 1
    g.state = 'sit'
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, flock: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const len = between(rand, LENGTH_M)
      const yaw = rand() * Math.PI * 2
      const left = between(rand, REST_S)
      const mix = rand()
      const shade = between(rand, SHADE)
      if (this.qualify(x, z) === null) continue
      // One she caught is not rolled again; its home is the key.
      if (taken.has('grasshopper', x, z)) continue
      const g = this.free.pop()
      if (!g) { this.overflow++; continue }
      g.tile = t
      g.homeX = x
      g.homeZ = z
      g.len = len
      g.yaw = yaw
      g.left = left
      g.r = (TINT_GREEN[0] + (TINT_BROWN[0] - TINT_GREEN[0]) * mix) * shade
      g.g = (TINT_GREEN[1] + (TINT_BROWN[1] - TINT_GREEN[1]) * mix) * shade
      g.b = (TINT_GREEN[2] + (TINT_BROWN[2] - TINT_GREEN[2]) * mix) * shade
      g.t = 0
      g.stale = true
      this._seatAt(g, x, z)
      t.flock.push(g)
    }
    return t
  }

  _leave(t) {
    for (const g of t.flock) {
      g.tile = null
      this.free.push(g)
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

  /**
   * The shown grasshopper nearest a hand at (x, y, z) whose body -- a ball of
   * its own length -- is within `reach` metres: `{ dist, g, size }` for
   * take(), or null. Only the shown ones, since past SHOW_M a body is not
   * stepped and holds wherever it was. For hands.js.
   */
  pickAt(x, y, z, reach) {
    if (!this.loaded) return null
    let best = null
    let bestD = reach
    for (const g of this.shown) {
      const d = Math.hypot(g.x - x, g.y + g.len * 0.5 - y, g.z - z) - g.len * 0.5
      if (d < bestD) {
        bestD = d
        best = { dist: Math.max(0, d), g, size: g.len }
      }
    }
    return best
  }

  /**
   * Catch the grasshopper of a pickAt() hit: its slot goes back to the pool,
   * its home is recorded so the tile never rolls it again, and what the hand
   * holds is returned as a record for hands.js -- the shared geometry and
   * material, its tint and its scale.
   */
  take(hit) {
    const g = hit.g
    const t = g.tile
    if (!t) throw new Error(`Grasshoppers.take: slot ${g.id} is on no tile`)
    const i = t.flock.indexOf(g)
    if (i < 0) throw new Error(`Grasshoppers.take: slot ${g.id} is not in its tile's flock`)
    taken.add('grasshopper', g.homeX, g.homeZ)
    t.flock.splice(i, 1)
    g.tile = null
    const j = this.shown.indexOf(g)
    if (j >= 0) this.shown.splice(j, 1)
    this.free.push(g)
    const k = g.len / this.length
    return {
      kind: 'grasshopper',
      name: 'grasshopper',
      size: g.len,
      geometry: this.mesh.geometry,
      material: this.material,
      color: [g.r, g.g, g.b],
      scale: [k, k, k],
      stowable: true,
    }
  }

  /**
   * A peer caught the grasshopper whose home is (x, z): take it out of its
   * flock here too, shown or not, and record the home. True when a resident
   * tile has it. For hands-net.js.
   */
  evict(key, x, z) {
    if (key !== 'grasshopper') return false
    for (const t of this.tiles.values()) {
      for (const g of t.flock) {
        if (Math.abs(g.homeX - x) >= TOLERANCE_M || Math.abs(g.homeZ - z) >= TOLERANCE_M) continue
        this.take({ dist: 0, g, size: g.len })
        return true
      }
    }
    return false
  }

  /** The geometry and material a packed grasshopper record is drawn with, or null until the asset lands. For hands.js. */
  dress(slot) {
    if (slot.kind !== 'grasshopper') throw new Error(`Grasshoppers.dress: not a grasshopper, ${slot.kind}`)
    if (!this.loaded) return null
    return { geometry: this.mesh.geometry, material: this.material }
  }

  /**
   * Let a caught grasshopper go at (x, _, z): seated on the ground there, at
   * home there, in the resident tile under it, and off in a hop at once.
   * False where no tile is resident or a grasshopper could not sit -- water,
   * a crag, the cold -- and hands.js drops it as a thing.
   */
  release(rec, x, y, z) {
    if (rec.kind !== 'grasshopper') throw new Error(`Grasshoppers.release: not a grasshopper, ${rec.kind}`)
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t || this.qualify(x, z) === null) return false
    const g = this.free.pop()
    if (!g) { this.overflow++; return false }
    g.tile = t
    g.homeX = x
    g.homeZ = z
    g.len = rec.size
    g.yaw = this.rand() * Math.PI * 2
    g.left = 0
    g.r = rec.color[0]; g.g = rec.color[1]; g.b = rec.color[2]
    g.t = 0
    g.stale = true
    this._seatAt(g, x, z)
    t.flock.push(g)
    return true
  }

  /** Whether the sun is down far enough that none hops. */
  get night() {
    return this.dayness < NIGHT_DAY
  }

  get stats() {
    let hopping = 0
    for (const g of this.shown) if (g.state === 'hop') hopping++
    return { alive: MAX - this.free.length, tiles: this.tiles.size, shown: this.shown.length, hopping, hops: this.hops, overflow: this.overflow }
  }

  /** The grasshoppers within SHOW_M of her head this frame, each with x, y, z, pushed onto `into`. */
  bodies(into) {
    for (const g of this.shown) into.push(g)
    return into
  }

  /** Roll a hop from where it sits and begin the crouch: true when a landing was found. */
  _hop(g) {
    for (let i = 0; i < HOP_TRIES; i++) {
      const hx = g.homeX - g.x, hz = g.homeZ - g.z
      const yaw = hx * hx + hz * hz > TETHER * TETHER ? headingTo(hx, hz) + (this.rand() - 0.5) : this.rand() * Math.PI * 2
      const dist = between(this.rand, HOP_M)
      const x1 = g.x + Math.cos(yaw) * dist
      const z1 = g.z - Math.sin(yaw) * dist
      if (this.qualify(x1, z1) === null) continue
      g.x0 = g.x; g.y0 = g.y; g.z0 = g.z
      g.x1 = x1; g.z1 = z1
      g.y1 = this.walk.heightAt(x1, z1)
      // The apex a drag-free kick at the rolled angle reaches over that distance; the rise takes gravity's time for it and the fall RISE_FRAC's share less.
      g.apex = (dist * Math.tan((between(this.rand, LAUNCH_DEG) * Math.PI) / 180)) / 4
      g.T = Math.sqrt((2 * g.apex) / GRAVITY) / RISE_FRAC
      g.t = 0
      g.yaw = yaw
      g.state = 'crouch'
      this.hops++
      return true
    }
    return false
  }

  /** One frame of one grasshopper. */
  _step(g, dt) {
    if (g.state === 'sit') {
      g.left -= dt
      if (g.left > 0) return
      // In the dark the rest is rolled again rather than left expired, so at dawn they go over a whole REST_S and not all at once.
      if (this.night || !this._hop(g)) g.left = between(this.rand, REST_S)
      return
    }
    g.t += dt
    if (g.state === 'crouch') {
      // Down toward the ground, faster toward the end: the wind-up.
      const u = Math.min(1, g.t / CROUCH_S)
      g.squash = 1 - (1 - CROUCH_SQUASH) * u * u
      if (u >= 1) { g.state = 'hop'; g.t = 0; g.squash = 1 }
      return
    }
    if (g.state === 'land') {
      // Squashed by the fall and back up: a half sine over LAND_S.
      const u = Math.min(1, g.t / LAND_S)
      g.squash = 1 - (1 - LAND_SQUASH) * Math.sin(u * Math.PI)
      if (u >= 1) { g.state = 'sit'; g.squash = 1 }
      return
    }
    const s = Math.min(1, g.t / g.T)
    if (s >= 1) {
      this._seatAt(g, g.x1, g.z1)
      g.state = 'land'
      g.t = 0
      g.left = between(this.rand, REST_S)
      return
    }
    const p = flightProgress(s)
    g.x = g.x0 + (g.x1 - g.x0) * p
    g.z = g.z0 + (g.z1 - g.z0) * p
    // The chord from take-off to landing, ridden at the flight's progress, and the lift over it.
    g.y = g.y0 + (g.y1 - g.y0) * p + g.apex * flightLift(s)
    const vy = ((g.y1 - g.y0) * flightProgressRate(s) + g.apex * flightLiftRate(s)) / g.T
    const vh = (Math.hypot(g.x1 - g.x0, g.z1 - g.z0) * flightProgressRate(s)) / g.T
    g.pitch = Math.atan2(vy, vh) * PITCH_K
  }

  /** Into _quat: on the ground, the body's up along the ground's normal with the body along its heading laid onto the surface; in the air, the heading and the pitch. */
  _orient(g) {
    if (g.state === 'hop') {
      // Pitch about the body's Z, then the heading: 'YZX' applies X (none) first.
      _quat.setFromEuler(_euler.set(0, g.yaw, g.pitch, 'YZX'))
      return
    }
    _n.set(g.nx, g.ny, g.nz)
    _x.set(Math.cos(g.yaw), 0, -Math.sin(g.yaw))
    _x.addScaledVector(_n, -_x.dot(_n)).normalize()
    _z.crossVectors(_x, _n)
    _quat.setFromRotationMatrix(_basis.makeBasis(_x, _n, _z))
  }

  /** One frame: the tiles follow her head, and every grasshopper within SHOW_M is stepped and written. `dayness` is the world's day scalar, and under NIGHT_DAY it is what stills them. */
  update(hx, hy, hz, dt, dayness = 1) {
    dt = Math.min(dt, 0.1)
    this.dayness = dayness
    this.head.x = hx
    this.head.y = hy
    this.head.z = hz
    walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
    const mat = this.mesh.instanceMatrix.array
    const tint = this.mesh.instanceColor.array
    const show2 = SHOW_M * SHOW_M
    const shown = this.shown
    shown.length = 0
    let n = 0
    for (const t of this.tiles.values()) {
      for (const g of t.flock) {
        const dx = g.x - hx, dy = g.y - hy, dz = g.z - hz
        if (dx * dx + dy * dy + dz * dz > show2) continue
        this._step(g, dt)
        shown.push(g)
        // A seated body's matrix holds; a crouching, flying or landing one moves every frame.
        if (g.stale || g.state !== 'sit') {
          _pos.set(g.x, g.y, g.z)
          this._orient(g)
          const k = g.len / this.length
          _scl.set(k, k * g.squash, k)
          _mat.compose(_pos, _quat, _scl).toArray(g.m)
          g.stale = g.state !== 'sit'
        }
        mat.set(g.m, n * 16)
        tint[n * 3] = g.r; tint[n * 3 + 1] = g.g; tint[n * 3 + 2] = g.b
        n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.instanceColor.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.map?.dispose()
    this.material.dispose()
  }
}
