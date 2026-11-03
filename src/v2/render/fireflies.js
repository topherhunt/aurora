// ---------------------------------------------------------------------------
// Fireflies: after dark, under the trees below the snow line, dark specks that
// each flash lime-green now and then. A tile rolls candidates from its seed and
// a candidate becomes a firefly only once a trunk stands within TREE_M of it,
// so the trees may land late (leftovers are rescanned every RESCAN_FRAMES).
// One InstancedMesh of billboard cards, each a dark body disc and an additive
// halo in one premultiplied draw, so it lights nothing. The layer exists only
// under NIGHT_DAY and drops its tiles by day. design/27 Stage 4 has the real
// flash timings behind ON_S and OFF_S.
// The vertex shader flies and flashes every firefly from its FIELDS-float record
// and the wrapped clock uClock; the CPU writes records only when a tile admits or
// drops a firefly. Every rate is whole cycles per PERIOD_S, so the wrap has no seam.
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
// The flash and the dark between, seconds; the fraction of a flash spent brightening. Each firefly flashes once per slot of the clock, at a random start and length drawn from these.
export const ON_S = [0.3, 0.7]
export const OFF_S = [6, 18]
export const RISE = 0.3
// Flight height over the walk surface, metres, and how far from home a firefly ranges.
export const FLY_M = [0.3, 3]
export const TETHER = 6
// The wander, per horizontal axis: a drift of DRIFT_M metres at DRIFT_MPS peak speed and a curl of CURL_M at CURL_MPS, each a sine at a random phase. Both axes together reach 2^0.5 * 4.2 m at most, inside TETHER.
export const DRIFT_M = [1.5, 3.4]
export const DRIFT_MPS = [0.25, 0.6]
export const CURL_M = [0.3, 0.8]
export const CURL_MPS = [0.1, 0.3]
// The climb: a bob and a ripple about a mid height chosen to keep both inside FLY_M, at most about 0.4 m/s together. A full flash lifts it FLASH_LIFT.
export const BOB_M = [0.2, 1]
export const BOB_MPS = [0.08, 0.28]
export const RIPPLE_M = [0.1, 0.3]
export const RIPPLE_MPS = [0.04, 0.12]
export const FLASH_LIFT = 0.04
// The body's radius and the card's half-size (the halo's reach), metres; the glow's linear RGB at full flash, and the body's.
export const BODY_M = 0.007
export const HALO_M = 0.35
export const GLOW = [0.55, 1.0, 0.2]
export const BODY_RGB = [0.02, 0.015, 0.01]
// The clock wraps at PERIOD_S. It is cut into SLOTS slots of SLOT_S, a flash starts up to START_MAX into its slot, so the dark between two flashes is exactly OFF_S.
export const PERIOD_S = 1024
export const SLOTS = Math.round(PERIOD_S / ((ON_S[0] + ON_S[1] + OFF_S[0] + OFF_S[1]) / 2))
export const SLOT_S = PERIOD_S / SLOTS
export const START_MAX = SLOT_S - OFF_S[0] - ON_S[1]
// Instance record: [0..3] home x, home z, ground there, seed; [4..7] ground slope x, slope z, clock offset, mid height; then six (amplitude, rate, phase) sines from 8: x drift, x curl, z drift, z curl, bob, ripple.
export const FIELDS = 26
const TAU = Math.PI * 2
// The ground is the plane through three reads this far apart at spawn.
const SLOPE_M = 4
// Frames between one tile's leftover candidates being looked at again for trees.
const RESCAN_FRAMES = 15
// Trunks a tile's scan may hold: the tile box plus TREE_M each side, stride 4.
const TREE_BUF = 96

const between = (rand, [lo, hi]) => lo + (hi - lo) * rand()
const smooth = (t) => t * t * (3 - 2 * t)
const snapRate = (w) => Math.max(1, Math.round((w * PERIOD_S) / TAU)) * (TAU / PERIOD_S)
const num = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x))

const hash32 = (x) => {
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** Glow 0..1 of a firefly with `seed` and clock `offset` at wrapped clock `t`. Twin of fireflyFlash in FIREFLY_GLSL. */
export function fireflyFlash(seed, offset, t) {
  const ti = (t + offset) % PERIOD_S
  const k = Math.floor(ti / SLOT_S)
  const h = hash32((seed + Math.imul(k, 0x9e3779b9)) >>> 0)
  const start = ((h >>> 8) / 16777216) * START_MAX
  const dur = ON_S[0] + ((ON_S[1] - ON_S[0]) * (hash32(h ^ 0x68e31da4) >>> 8)) / 16777216
  const p = (ti - k * SLOT_S - start) / dur
  if (p < 0 || p > 1) return 0
  return smooth(p < RISE ? p / RISE : (1 - p) / (1 - RISE))
}

/** World position and glow of the firefly whose record starts at `o` in `rec`, at wrapped clock `t`. Twin of fireflyPose in FIREFLY_GLSL. */
export function fireflyPose(rec, o, t) {
  const sine = (k) => rec[o + k] * Math.sin(rec[o + k + 1] * t + rec[o + k + 2])
  const dx = sine(8) + sine(11), dz = sine(14) + sine(17)
  const glow = fireflyFlash(rec[o + 3], rec[o + 6], t)
  return {
    x: rec[o] + dx,
    y: rec[o + 2] + rec[o + 4] * dx + rec[o + 5] * dz + rec[o + 7] + sine(20) + sine(23) + FLASH_LIFT * glow,
    z: rec[o + 1] + dz,
    glow,
  }
}

// A backtick in a GLSL comment would end this string.
export const FIREFLY_GLSL = /* glsl */ `
  uint fireflyHash( uint x ) {
    x ^= x >> 16u;
    x *= 0x7feb352du;
    x ^= x >> 15u;
    x *= 0x846ca68bu;
    x ^= x >> 16u;
    return x;
  }
  float fireflyFlash( float seed, float offset, float t ) {
    float ti = mod( t + offset, ${num(PERIOD_S)} );
    float k = floor( ti / ${num(SLOT_S)} );
    uint h = fireflyHash( uint( seed ) + uint( k ) * 0x9e3779b9u );
    float start = float( h >> 8u ) / 16777216.0 * ${num(START_MAX)};
    float dur = ${num(ON_S[0])} + ${num(ON_S[1] - ON_S[0])} * float( fireflyHash( h ^ 0x68e31da4u ) >> 8u ) / 16777216.0;
    float p = ( ti - k * ${num(SLOT_S)} - start ) / dur;
    if ( p < 0.0 || p > 1.0 ) return 0.0;
    p = p < ${num(RISE)} ? p / ${num(RISE)} : ( 1.0 - p ) / ${num(1 - RISE)};
    return p * p * ( 3.0 - 2.0 * p );
  }
  vec4 fireflyPose( vec4 home, vec4 field, vec3 x1, vec3 x2, vec3 z1, vec3 z2, vec3 y1, vec3 y2, float t ) {
    float dx = x1.x * sin( x1.y * t + x1.z ) + x2.x * sin( x2.y * t + x2.z );
    float dz = z1.x * sin( z1.y * t + z1.z ) + z2.x * sin( z2.y * t + z2.z );
    float glow = fireflyFlash( home.w, field.z, t );
    float y = home.z + field.x * dx + field.y * dz + field.w + y1.x * sin( y1.y * t + y1.z ) + y2.x * sin( y2.y * t + y2.z ) + ${num(FLASH_LIFT)} * glow;
    return vec4( home.x + dx, y, home.y + dz, glow );
  }
`

const VERT = /* glsl */ `
  attribute vec4 aHome, aField;
  attribute vec3 aX1, aX2, aZ1, aZ2, aY1, aY2;
  uniform float uHalo, uBody, uClock;
  varying vec2 vP;
  varying float vGlow;
  ${FIREFLY_GLSL}
  void main() {
    vec4 fly = fireflyPose( aHome, aField, aX1, aX2, aZ1, aZ2, aY1, aY2, uClock );
    // A sprite: the card is laid in view space, so each eye of a stereo pair faces it squarely.
    vec4 mv = modelViewMatrix * vec4( fly.xyz, 1.0 );
    // A dark firefly shrinks its card to the body disc, and vP is scaled with it so every fragment computes what the full card would.
    float s = fly.w > 0.0 ? 1.0 : uBody * 1.5;
    mv.xy += position.xy * ( uHalo * s );
    gl_Position = projectionMatrix * mv;
    vP = position.xy * s;
    vGlow = fly.w;
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

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uHalo: { value: HALO_M },
        uBody: { value: BODY_M / HALO_M },
        uGain: { value: 0 },
        uClock: { value: 0 },
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
    this.data = new THREE.InstancedInterleavedBuffer(new Float32Array(MAX * FIELDS), FIELDS, 1)
    this.data.setUsage(THREE.DynamicDrawUsage)
    for (const [name, size, at] of [['aHome', 4, 0], ['aField', 4, 4], ['aX1', 3, 8], ['aX2', 3, 11], ['aZ1', 3, 14], ['aZ2', 3, 17], ['aY1', 3, 20], ['aY2', 3, 23]]) {
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(this.data, size, at))
    }
    this.mesh = new THREE.InstancedMesh(geo, this.material, MAX)
    this.mesh.name = 'v2-fireflies'
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.batch = new THREE.Group()
    this.batch.name = 'v2-fireflies'
    this.batch.add(this.mesh)
    scene.add(this.batch)

    this.slots = []
    for (let i = 0; i < MAX; i++) this.slots.push({ id: i, tile: null, homeX: 0, homeZ: 0, ground: 0, rec: new Float32Array(FIELDS) })
    this.free = this.slots.slice()
    this.tiles = new Map()
    this.rescan = []
    this.frame = 0
    // Wrapped at PERIOD_S; the shader's only moving input.
    this.clock = 0
    // Whether a firefly was admitted or dropped since the instance buffer was last packed.
    this.dirty = false
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
      this._spawn(b, t, c)
      t.swarm.push(b)
      this.dirty = true
    }
  }

  /** Roll slot `b`'s whole flight and flash from the candidate `c`'s seed. */
  _spawn(b, t, c) {
    const rand = mulberry32(c.seed)
    const r = b.rec
    const ground = this.walk.heightAt(c.x, c.z)
    b.tile = t
    b.homeX = c.x
    b.homeZ = c.z
    b.ground = ground
    r[0] = c.x
    r[1] = c.z
    r[2] = ground
    r[3] = Math.floor(rand() * 16777216)
    r[4] = (this.walk.heightAt(c.x + SLOPE_M, c.z) - ground) / SLOPE_M
    r[5] = (this.walk.heightAt(c.x, c.z + SLOPE_M) - ground) / SLOPE_M
    r[6] = rand() * PERIOD_S
    const sine = (k, m, mps) => {
      r[k] = between(rand, m)
      r[k + 1] = snapRate(between(rand, mps) / r[k])
      r[k + 2] = rand() * TAU
    }
    sine(8, DRIFT_M, DRIFT_MPS)
    sine(11, CURL_M, CURL_MPS)
    sine(14, DRIFT_M, DRIFT_MPS)
    sine(17, CURL_M, CURL_MPS)
    sine(20, BOB_M, BOB_MPS)
    sine(23, RIPPLE_M, RIPPLE_MPS)
    r[7] = between(rand, [FLY_M[0] + r[20] + r[23], FLY_M[1] - r[20] - r[23]])
  }

  _leave(t) {
    for (const b of t.swarm) {
      b.tile = null
      this.free.push(b)
    }
    if (t.swarm.length) this.dirty = true
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
    let glowing = 0, pending = 0
    for (const t of this.tiles.values()) {
      pending += t.pending.length
      for (const b of t.swarm) if (fireflyFlash(b.rec[3], b.rec[6], this.clock) > 0) glowing++
    }
    return { alive: MAX - this.free.length, tiles: this.tiles.size, lit: glowing, pending, overflow: this.overflow }
  }

  /** Lay every resident firefly's record into the instance buffer. */
  _pack() {
    const out = this.data.array
    let n = 0
    for (const t of this.tiles.values()) {
      for (const b of t.swarm) out.set(b.rec, n++ * FIELDS)
    }
    this.mesh.count = n
    this.mesh.visible = n > 0
    this.data.needsUpdate = true
    this.dirty = false
  }

  /**
   * One frame: by day the tiles are dropped and nothing is drawn; by night
   * the tiles follow her head and one tile's leftovers are looked at again for
   * trees. The instance buffer is rewritten only when a firefly came or went.
   */
  update(hx, hy, hz, dt, dayness = 1) {
    dt = Math.min(dt, 0.1)
    this.dayness = dayness
    this.frame++
    if (!this.night) {
      if (this.tiles.size) this._clear()
    } else {
      if (walkTiles(this.tiles, hx, hz, TILE, RADIUS, (tx, tz) => this._enter(tx, tz), (t) => this._leave(t)) > 0) this.rescan.length = 0
      if (this.frame % RESCAN_FRAMES === 0) {
        if (!this.rescan.length) this.rescan = Array.from(this.tiles.values())
        const t = this.rescan.pop()
        if (t && this.tiles.has(tileKey(t.tx, t.tz))) this._scan(t)
      }
      this.clock = (this.clock + dt) % PERIOD_S
      this.material.uniforms.uClock.value = this.clock
      this.material.uniforms.uGain.value = this.gain
    }
    if (this.dirty) this._pack()
  }

  dispose() {
    this.batch.parent?.remove(this.batch)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
