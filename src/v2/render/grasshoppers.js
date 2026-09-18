// ---------------------------------------------------------------------------
// Grasshoppers: a photograph keyed to a cutout (tools/creatures/key-card.mjs,
// public/creatures/grasshopper.png) on the grass and the forest floor below the
// snow line. Each TILE-metre tile around her rolls its own from its seed
// (critters.js tileSeed) at DENSITY, and a grasshopper is a slot in one
// InstancedMesh: TWO TRIANGLES, one 128 x 64 cutout, drawn from both sides.
//
// THE CARD IS TWO TRIANGLES, NOT TWO QUADS. One triangle per view, each twice
// the size of the quad it stands in for -- the quad's corner, and the far
// corners of a quad four times the area -- with UVs running past 1, and the
// fragment stage cuts every texel outside 0..1 before the alpha test does the
// rest. It is the one-triangle-full-screen trick at a centimetre: half the
// vertices and half the index of two quads, and the overhang it rasterises
// for nothing is a grasshopper's worth of pixels at 8 m. The two views are
// the ONE side picture: a vertical card in the body's XY and the same card
// laid flat in XZ at AXIS_FRAC of the height, so the two cross along the
// head-to-tail axis and the cutout reads from above as well as from beside.
// Normals are all straight up and three's double-sided flip undone, as the
// critter cards do, so the four faces take one light and the crossing is not
// a seam in brightness. The head is +X, like every shipped critter, which
// puts the picture's left at u = 0 there.
//
// THE COLOUR IS A TINT. The map is one tan grasshopper; each rolls a mix of
// TINT_GREEN and TINT_BROWN and a SHADE, a per-channel multiplier on the map
// in linear RGB carried in instanceColor, so a meadow holds olive-green ones
// beside rust-brown ones in one draw.
//
// A grasshopper SITS on the ground -- the walk surface, the field or the stone
// on it -- its up along the field's slope, for REST_S, then HOPS: a heading
// bent home past TETHER, a distance and a height each rolled in HOP_M, the
// landing point qualified as the roll was (dry, below the snow) and its
// height read off the walk surface. A landing that finds water or snow is
// rolled again a few times, then the rest is extended.
//
// THE HOP IS NOT A PARABOLA. Gravity's arc is symmetric -- the launch and the
// landing are its two fastest moments, at the same speed -- and at under a
// second a hop that shape reads as a dash. What reads as an insect's hop is
// its ASYMMETRY and its ENDS. It CROUCHES first, the body squashed toward the
// ground over CROUCH_S, the wind-up before the kick. The kick is instant. In
// the air the horizontal speed bleeds away (flightProgress: an exponential
// ease-out at DRAG_K, so the second half of the flight covers less ground
// than the first) and the height over the chord rises to its apex at
// RISE_FRAC of the flight and takes the rest to come down (flightLift), so
// the take-off is steep and quick, the top hangs, and the descent is the
// slow steep drop onto the grass a real one makes. Then it LANDS: the body
// snaps level and squashes and recovers over LAND_S, the legs taking the
// fall. The flight time is gravity's for the apex, so a low hop is a flick
// and a high one hangs. The body pitches with the path's angle by PITCH_K.
//
// SHE ONLY SEES THEM WITHIN SHOW_M. A slot is stepped and written only while
// it is that close to her head; past it a grasshopper holds where it was --
// mid-hop or seated, nobody can see -- and the tiles stay resident out to
// RADIUS so the ground within SHOW_M is always rolled. At 6--10 cm a
// grasshopper at 8 m is a few pixels, so there is no pop to see.
//
// bodies() lists the shown ones for the ambience, which chirps them.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { tileSeed, walkTiles } from './critters.js'

export const TEXTURE_URL = 'creatures/grasshopper.png'
export const TILE = 8
// Within this of her head a grasshopper is stepped and drawn.
export const SHOW_M = 8
// Tiles whose centre lies within this are resident: SHOW_M plus a tile's half diagonal, so every point she can see one at is on a rolled tile.
export const RADIUS = SHOW_M + (TILE * Math.SQRT2) / 2
// Grasshoppers per square metre: one per 8 m2, so a tile rolls seven or eight and she sees two dozen.
export const DENSITY = 0.125
export const MAX = 256
// Ground within this of the snow line is too cold to roll on, and ground steeper than this is neither grass nor forest floor.
export const SNOW_MARGIN = 20
export const MAX_SLOPE_DEG = 38
// The body's length in metres, 8 cm give or take a fifth; the card is CARD_ASPECT times as long as tall (the map is 128 x 64), and the head-to-tail axis sits at AXIS_FRAC of the height.
export const LENGTH_M = [0.064, 0.096]
export const CARD_ASPECT = 2
export const AXIS_FRAC = 0.5
// The tint's two ends, per-channel multipliers on the tan map in linear RGB, mixed by a roll; and the brightness roll on top.
export const TINT_GREEN = [0.65, 1.2, 0.5]
export const TINT_BROWN = [1.15, 0.9, 0.7]
export const SHADE = [0.85, 1.15]
// Seated between hops, seconds; a hop's distance and its height over the chord, metres, each rolled on its own.
export const REST_S = [1, 6]
export const HOP_M = [0.2, 1.5]
// The crouch before the kick and the settle after the landing: each this long, the body squashed to this fraction of its height at the deepest.
export const CROUCH_S = 0.12
export const CROUCH_SQUASH = 0.65
export const LAND_S = 0.18
export const LAND_SQUASH = 0.7
// The flight's shape: the horizontal ease-out's rate (the landing speed is exp(-DRAG_K) of the launch's), and the fraction of the flight spent rising.
export const DRAG_K = 1.2
export const RISE_FRAC = 0.42
// How far from home a grasshopper ranges before its hops are bent back.
export const TETHER = 4
// The body pitches this much of the path's angle in the air.
export const PITCH_K = 0.6
export const GRAVITY = 9.81
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
/** The height over the chord at fraction `s` of the flight, as a fraction of the apex: a half-parabola up over RISE_FRAC of the flight, a half-parabola down over the rest. */
export const flightLift = (s) => {
  const u = s < RISE_FRAC ? (RISE_FRAC - s) / RISE_FRAC : (s - RISE_FRAC) / (1 - RISE_FRAC)
  return 1 - u * u
}
/** d flightLift / ds. */
const flightLiftRate = (s) => (s < RISE_FRAC ? (2 * (RISE_FRAC - s)) / (RISE_FRAC * RISE_FRAC) : (-2 * (s - RISE_FRAC)) / ((1 - RISE_FRAC) * (1 - RISE_FRAC)))

/**
 * The two triangles onto an (empty) geometry, for a body one unit long: the
 * side view standing in XY on y = 0 and the top view lying in XZ at the axis,
 * each a triangle twice its quad with UVs to match, the head at +X and u = 0.
 */
export function setGrasshopperCard(geo) {
  const h = 1 / CARD_ASPECT
  const y = h * AXIS_FRAC
  const pos = [
    // Side: the quad's (-0.5, 0) corner, then twice its width along x and twice its height along y.
    -0.5, 0, 0, 1.5, 0, 0, -0.5, 2 * h, 0,
    // Top: the quad's (-0.5, +h/2) corner, twice its width along x and twice its depth toward -z.
    -0.5, y, h / 2, 1.5, y, h / 2, -0.5, y, -1.5 * h,
  ]
  // u = 0.5 - x runs the picture's left to the head; v runs the picture's bottom up the side card and toward -z across the top one.
  const uv = [1, 0, -1, 0, 1, 2, 1, 0, -1, 0, 1, 2]
  const nrm = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  geo.setIndex([0, 1, 2, 3, 4, 5])
  geo.computeBoundingBox()
}

export class Grasshoppers {
  /**
   * @param height  V2Height: heightAt, heightAndSlopeAt, snowLineAt
   * @param water   WaterSurfaces: levelAt
   * @param opts.walk  WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.map   a THREE.Texture for a gate; the world fetches TEXTURE_URL
   */
  constructor(scene, height, water, { seed = 1, walk, map = null } = {}) {
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

    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, alphaTest: 0.5, side: THREE.DoubleSide })
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        // The triangle overhangs its quad: everything past the picture's edge is cut before the map is read.
        .replace('#include <map_fragment>', 'if ( vMapUv.x < 0.0 || vMapUv.x > 1.0 || vMapUv.y < 0.0 || vMapUv.y > 1.0 ) discard;\n#include <map_fragment>')
        // three flips a double-sided normal toward the viewer; twice is the identity, so every face takes the authored up-normal's light.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal *= faceDirection;')
    }
    this.material.customProgramCacheKey = () => 'grasshoppers'
    this.mesh = new THREE.InstancedMesh(new THREE.BufferGeometry(), this.material, MAX)
    setGrasshopperCard(this.mesh.geometry)
    this.mesh.name = 'v2-grasshoppers'
    this.mesh.count = 0
    // Hidden until the map lands: a cutout material with no map draws its triangles white.
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The tint, through three's own vColor; made here so the program is keyed with it from the first draw.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3).fill(1), 3)
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // The layer toggle flips the group, so it cannot unhide the mesh before its map lands.
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
    this.overflow = 0
    this.hops = 0
    this.loaded = false
    // The shown ones, for bodies(): rebuilt by update().
    this.shown = []

    if (map) {
      this.setMap(map)
      this.ready = Promise.resolve(true)
    } else {
      this.ready = this.load()
    }
  }

  async load() {
    const tex = await new THREE.TextureLoader().loadAsync(TEXTURE_URL)
    this.setMap(tex)
    return true
  }

  setMap(tex) {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    this.material.map = tex
    this.material.needsUpdate = true
    this.mesh.visible = true
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
      g.apex = between(this.rand, HOP_M)
      // Up to the apex and down again under gravity: the time a fall from that height takes, twice.
      g.T = 2 * Math.sqrt((2 * g.apex) / GRAVITY)
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
      if (!this._hop(g)) g.left = between(this.rand, REST_S)
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

  /** Into _quat: on the ground, the card's up along the ground's normal with the body along its heading laid onto the surface; in the air, the heading and the pitch. */
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

  /** One frame: the tiles follow her head, and every grasshopper within SHOW_M is stepped and written. */
  update(hx, hy, hz, dt) {
    dt = Math.min(dt, 0.1)
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
          _scl.set(g.len, g.len * g.squash, g.len)
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
