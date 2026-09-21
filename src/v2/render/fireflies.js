// ---------------------------------------------------------------------------
// Fireflies: after dark, under the trees below the snow line, dark specks that
// each flash lime-green now and then. A tile rolls candidates from its seed and
// a candidate becomes a firefly only once a trunk stands within TREE_M of it,
// so the trees may land late (leftovers are rescanned every RESCAN_FRAMES).
// One InstancedMesh of billboard cards, each a dark body disc and an additive
// halo in one premultiplied draw, so it lights nothing. The layer exists only
// under NIGHT_DAY and drops its tiles by day. design/27 Stage 4 has the real
// flash timings behind ON_S and OFF_S.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { tileKey, tileSeed, walkTiles } from './critters.js'

export const TILE = 16
export const RADIUS = 30
// Candidates per square metre: one per 40 m2, so a tile in a wood rolls six or seven.
export const DENSITY = 0.025
export const MAX = 128
// Ground within this of the snow line is too cold to roll on.
export const SNOW_MARGIN = 20
// A candidate becomes a firefly when a trunk stands within this of it.
export const TREE_M = 6
// The day scalar (main.js dayness, (sun elevation + 6) / 10) the layer exists under, and the one the glow is full at: the sun a degree under the horizon, and four under it.
export const NIGHT_DAY = 0.5
export const DARK_DAY = 0.2
// The flash and the dark between, seconds, each re-rolled every cycle; the fraction of a flash spent brightening.
export const ON_S = [0.3, 0.7]
export const OFF_S = [3, 9]
export const RISE = 0.3
// Flight height over the walk surface, metres per second, how long a height and a speed are held, and how far from home a firefly ranges before it is turned back.
export const FLY_M = [0.3, 3]
export const SPEED = [0.25, 0.7]
export const ALT_S = [2, 6]
export const TETHER = 6
// The wander: a turn impulse every TURN_S of up to TURN_RAD spent over TURN_TAU, and a weave of WEAVE_RAD at WEAVE_HZ on top.
export const TURN_S = [1, 4]
export const TURN_RAD = 1.5
export const TURN_TAU = 1
export const WEAVE_HZ = 0.3
export const WEAVE_RAD = 0.5
// The climb: vertical speed at most this, easing at EASE per second; a flashing firefly lifts by FLASH_LIFT and slows to FLASH_SLOW of its speed, the way a male's flash is a rising hook.
export const VZ_MAX = 0.4
export const EASE = 2
export const FLASH_LIFT = 0.15
export const FLASH_SLOW = 0.5
// The body's radius and the card's half-size (the halo's reach), metres; the glow's linear RGB at full flash, and the body's.
export const BODY_M = 0.007
export const HALO_M = 0.7
export const GLOW = [0.55, 1.0, 0.2]
export const BODY_RGB = [0.02, 0.015, 0.01]
// Frames between a firefly's ground reads (staggered by slot), and between one tile's leftover candidates being looked at again for trees.
const GROUND_EVERY = 6
const RESCAN_FRAMES = 15
// Trunks a tile's scan may hold: the tile box plus TREE_M each side, stride 4.
const TREE_BUF = 96

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const smooth = (t) => t * t * (3 - 2 * t)

const VERT = /* glsl */ `
  attribute float aGlow;
  uniform float uHalo;
  varying vec2 vP;
  varying float vGlow;
  void main() {
    // A sprite: the card is laid in view space, so each eye of a stereo pair faces it squarely.
    vec4 mv = modelViewMatrix * vec4( instanceMatrix[3].xyz, 1.0 );
    mv.xy += position.xy * uHalo;
    gl_Position = projectionMatrix * mv;
    vP = position.xy;
    vGlow = aGlow;
  }
`

const FRAG = /* glsl */ `
  uniform float uBody, uGain;
  uniform vec3 uGlow, uBodyColor;
  varying vec2 vP;
  varying float vGlow;
  void main() {
    float d = length( vP );
    if ( d > 1.0 ) {
      gl_FragColor = vec4( 0.0 );
      return;
    }
    float lit = vGlow * uGain;
    // The abdomen is the light, so the dark body is what is left of it when it is not flashing.
    float dark = ( 1.0 - smoothstep( uBody * 0.6, uBody * 1.4, d ) ) * ( 1.0 - lit );
    // A pinpoint at the body and a faint skirt out to the card's edge.
    float halo = exp( -d * d * 120.0 ) + 0.08 * ( 1.0 - d ) * ( 1.0 - d );
    // Premultiplied: the halo adds over the scene, the body covers it.
    gl_FragColor = vec4( uGlow * ( lit * halo ) + uBodyColor * dark, dark );
    #include <colorspace_fragment>
  }
`

export class Fireflies {
  /**
   * @param height     V2Height: heightAt, snowLineAt
   * @param water      WaterSurfaces: levelAt
   * @param opts.walk  WalkSurface: heightAt(x, z) -- the field or the stone on it
   * @param opts.trees Trees: anchorsInto
   */
  constructor(scene, height, water, { seed = 1, walk, trees } = {}) {
    if (!height || typeof height.heightAt !== 'function' || typeof height.snowLineAt !== 'function') throw new Error('Fireflies needs a height field with heightAt and snowLineAt')
    if (!water || typeof water.levelAt !== 'function') throw new Error('Fireflies needs WaterSurfaces, for levelAt')
    if (!walk || typeof walk.heightAt !== 'function') throw new Error('Fireflies needs the WalkSurface, for heightAt')
    if (!trees || typeof trees.anchorsInto !== 'function') throw new Error('Fireflies needs Trees, for anchorsInto')
    this.height = height
    this.water = water
    this.walk = walk
    this.trees = trees
    this.seed = seed
    this.rand = mulberry32(seed ^ 0xf1f1)

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHalo: { value: HALO_M },
        uBody: { value: BODY_M / HALO_M },
        uGain: { value: 0 },
        uGlow: { value: new THREE.Vector3(...GLOW) },
        uBodyColor: { value: new THREE.Vector3(...BODY_RGB) },
      },
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1)
    this.glow.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aGlow', this.glow)
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX)
    this.mesh.name = 'v2-fireflies'
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.batch = new THREE.Group()
    this.batch.name = 'v2-fireflies'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) {
      this.slots.push({
        id: i, tile: null,
        homeX: 0, homeZ: 0, x: 0, y: 0, z: 0, ground: 0,
        yaw: 0, turn: 0, weave: 0, jerk: 0, alt: 1, altLeft: 0, speed: 0.5, spd: 0.5, vy: 0,
        // The flash: whether it is on, how long this on or off spell is, how much of it is left, and the glow now.
        on: false, dur: 1, left: 1, lit: 0,
      })
    }
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    this.buf = new Float32Array(TREE_BUF * 4)
    // The world's day scalar, written by update(). Noon until the clock says otherwise, so a gate that never passes one gets no fireflies.
    this.dayness = 1
    this.overflow = 0
  }

  /** Whether the sun is down far enough for the layer to exist. */
  get night() {
    return this.dayness < NIGHT_DAY
  }

  /** The glow's strength, 0 by day to 1 once the sun is DARK_DAY under. */
  get gain() {
    return Math.max(0, Math.min(1, (NIGHT_DAY - this.dayness) / (NIGHT_DAY - DARK_DAY)))
  }

  /** Whether a firefly may be rolled at (x, z): warm, dry land. Returns the ground height or null. */
  qualify(x, z) {
    const h = this.height.heightAt(x, z)
    if (h > this.height.snowLineAt(x, z) - SNOW_MARGIN) return null
    const level = this.water.levelAt(x, z)
    if (level !== null && level > h) return null
    return h
  }

  _enter(tx, tz) {
    const rand = mulberry32(tileSeed(tx, tz, this.seed))
    const t = { tx, tz, pending: [], swarm: [] }
    const want = DENSITY * TILE * TILE
    const n = Math.floor(want) + (rand() < want % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) {
      const x = (tx + rand()) * TILE
      const z = (tz + rand()) * TILE
      const seed = (rand() * 0xffffffff) >>> 0
      if (this.qualify(x, z) === null) continue
      t.pending.push({ x, z, seed })
    }
    this._scan(t)
    return t
  }

  /** Admit every pending candidate of the tile that now has a trunk within TREE_M. */
  _scan(t) {
    if (!t.pending.length) return
    const x0 = t.tx * TILE, z0 = t.tz * TILE
    const buf = this.buf
    const n = this.trees.anchorsInto(x0 - TREE_M, z0 - TREE_M, x0 + TILE + TREE_M, z0 + TILE + TREE_M, buf)
    if (n === 0) return
    const r2 = TREE_M * TREE_M
    for (let i = t.pending.length - 1; i >= 0; i--) {
      const c = t.pending[i]
      let near = false
      for (let k = 0; k < n && !near; k++) {
        const dx = buf[k * 4] - c.x, dz = buf[k * 4 + 2] - c.z
        near = dx * dx + dz * dz < r2
      }
      if (!near) continue
      t.pending.splice(i, 1)
      const b = this.free.pop()
      if (!b) { this.overflow++; continue }
      const rand = mulberry32(c.seed)
      b.tile = t
      b.homeX = b.x = c.x
      b.homeZ = b.z = c.z
      b.ground = this.walk.heightAt(c.x, c.z)
      b.alt = between(rand, FLY_M)
      b.y = b.ground + b.alt
      b.altLeft = between(rand, ALT_S)
      b.yaw = rand() * Math.PI * 2
      b.turn = 0
      b.weave = rand() * Math.PI * 2
      b.jerk = between(rand, TURN_S)
      b.speed = b.spd = between(rand, SPEED)
      b.vy = 0
      // Dark, somewhere in its off spell, so a tile does not arrive flashing in step.
      b.on = false
      b.dur = between(rand, OFF_S)
      b.left = rand() * b.dur
      b.lit = 0
      t.swarm.push(b)
    }
  }

  _leave(t) {
    for (const b of t.swarm) {
      b.tile = null
      this.free.push(b)
    }
    t.swarm.length = 0
    t.pending.length = 0
  }

  _clear() {
    for (const t of this.tiles.values()) this._leave(t)
    this.tiles.clear()
    this.rescan.length = 0
  }

  /** Rebuild every tile around (cx, cz). Boot, and whenever the ground moves under her. Nothing by day. */
  place(cx, cz) {
    this._clear()
    this.overflow = 0
    if (!this.night) return
    walkTiles(this.tiles, cx, cz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t))
  }

  get stats() {
    let lit = 0, pending = 0
    for (const t of this.tiles.values()) {
      pending += t.pending.length
      for (const b of t.swarm) if (b.on) lit++
    }
    return { alive: MAX - this.free.length, tiles: this.tiles.size, lit, pending, overflow: this.overflow }
  }

  _step(b, dt) {
    const rand = this.rand
    b.left -= dt
    if (b.left <= 0) {
      b.on = !b.on
      b.dur = between(rand, b.on ? ON_S : OFF_S)
      b.left = b.dur
    }
    if (b.on) {
      const t = 1 - b.left / b.dur
      b.lit = smooth(t < RISE ? t / RISE : (1 - t) / (1 - RISE))
    } else {
      b.lit = 0
    }

    b.jerk -= dt
    if (b.jerk <= 0) {
      b.turn += (rand() * 2 - 1) * TURN_RAD
      b.jerk = between(rand, TURN_S)
    }
    // Past the tether the impulse is replaced by the way home.
    const hx = b.homeX - b.x, hz = b.homeZ - b.z
    if (hx * hx + hz * hz > TETHER * TETHER) {
      const back = Math.atan2(-hz, hx) - b.yaw
      b.turn = Math.atan2(Math.sin(back), Math.cos(back))
    }
    const k = Math.min(1, dt / TURN_TAU)
    b.yaw += b.turn * k
    b.turn -= b.turn * k
    b.weave += WEAVE_HZ * Math.PI * 2 * dt
    const heading = b.yaw + WEAVE_RAD * Math.sin(b.weave)

    b.altLeft -= dt
    if (b.altLeft <= 0) {
      b.alt = between(rand, FLY_M)
      b.speed = between(rand, SPEED)
      b.altLeft = between(rand, ALT_S)
    }
    if ((this.frame + b.id) % GROUND_EVERY === 0) b.ground = this.walk.heightAt(b.x, b.z)
    const want = b.ground + b.alt
    const vzTo = Math.max(-VZ_MAX, Math.min(VZ_MAX, want - b.y)) + FLASH_LIFT * b.lit
    const ease = Math.min(1, EASE * dt)
    b.vy += (vzTo - b.vy) * ease
    b.spd += (b.speed * (1 - FLASH_SLOW * b.lit) - b.spd) * ease
    b.x += Math.cos(heading) * b.spd * dt
    b.z -= Math.sin(heading) * b.spd * dt
    b.y = Math.max(b.ground + FLY_M[0], b.y + b.vy * dt)
  }

  /**
   * One frame: by day the tiles are dropped and nothing is drawn; by night
   * the tiles follow her head, one tile's leftovers are looked at again for
   * trees, and every firefly is stepped and written.
   */
  update(hx, hy, hz, dt, dayness = 1) {
    dt = Math.min(dt, 0.1)
    this.dayness = dayness
    this.frame++
    if (!this.night) {
      if (this.tiles.size) this._clear()
      this.mesh.count = 0
      return
    }
    if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) this.rescan.length = 0
    if (this.frame % RESCAN_FRAMES === 0) {
      if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
      const t = this.rescan.pop()
      if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
    }
    this.material.uniforms.uGain.value = this.gain
    const mat = this.mesh.instanceMatrix.array
    const glow = this.glow.array
    let n = 0
    for (const t of this.tiles.values()) {
      for (const b of t.swarm) {
        this._step(b, dt)
        const o = n * 16
        mat[o] = 1; mat[o + 5] = 1; mat[o + 10] = 1; mat[o + 15] = 1
        mat[o + 12] = b.x; mat[o + 13] = b.y; mat[o + 14] = b.z
        glow[n] = b.lit
        n++
      }
    }
    this.mesh.count = n
    this.mesh.instanceMatrix.needsUpdate = true
    this.glow.needsUpdate = true
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
