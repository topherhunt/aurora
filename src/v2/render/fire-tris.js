import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'
import { HEAD_EYE_DECL, HEAD_EYE_GLSL, bindHeadEye } from '../../head-eye.js'

// ---------------------------------------------------------------------------
// FLAMES, the world's flame renderer (campfire, torches, lamps, candles, tree fires; design/37-fire.md §Flames drawn): three nested flat cel silhouettes, red, orange and yellow, with tongues running up their edges, and two-triangle sparks rising off them. One draw a TriFlames. Both turn about Y toward the head and pitch toward an eye above by `tilt` of its elevation, so a candle seen from above is not a sliver. Opaque, one varying, no texture, no discard: the cost is covered pixels and the vertex shader, and all motion is a pure function of the clock, so the CPU writes a flame's matrix only when it is placed.
// ---------------------------------------------------------------------------

export const TRI_FIRE = {
  // Metres: a bench default; `place` sets each flame's own.
  height: 0.9,
  radius: 0.35,
  // How far a flame pitches toward an eye above it, as a fraction of the eye's elevation; the sparks' size as a multiple of the campfire's.
  tilt: 0.5,
  sparkSize: 1,
  gain: 1.3,
  // Linear RGB along the ramp: the hottest (inner layer, newborn spark), the middle, the coolest (outer layer).
  birthColor: [1, 0.85, 0.3],
  midColor: [1, 0.4, 0.04],
  deathColor: [0.55, 0.06, 0],
}

export const TRI_CAMPFIRE = TRI_FIRE
export const TRI_WILDFIRE = { ...TRI_FIRE, height: 0.45, radius: 0.09, gain: 1.4 }
export const TRI_TORCH = { ...TRI_FIRE, height: 0.24, radius: 0.07, sparkSize: 2, gain: 1.4 }
export const TRI_LAMP = { ...TRI_FIRE, height: 0.32, radius: 0.1, sparkSize: 2, gain: 1.2 }
export const TRI_CANDLE = { ...TRI_FIRE, height: 0.06, radius: 0.012, sparkSize: 2 }

const POINTS = 16
const LAYERS = 3
const SPARKS = 24
export const FLAME_TRIS = POINTS * LAYERS + SPARKS * 2

// One flame's silhouettes and sparks in one geometry, so a TriFlames is one draw: position.z is 0 on a silhouette vertex and 1 on a spark's, and only a spark reads aSeed.
function flameGeometry(seed) {
  const rand = mulberry32(seed)
  const pos = [], seeds = [], index = []
  for (let L = 0; L < LAYERS; L++) {
    const base = pos.length
    pos.push([-1, L, 0])
    for (let i = 0; i < POINTS; i++) pos.push([i, L, 0])
    for (let i = 0; i < POINTS; i++) index.push(base, base + 1 + i, base + 1 + ((i + 1) % POINTS))
  }
  for (let k = 0; k < pos.length; k++) seeds.push([0, 0, 0, 0])
  for (let k = 0; k < SPARKS; k++) {
    const s = [rand(), rand(), rand(), rand()], base = pos.length
    for (let c = 0; c < 4; c++) { pos.push([c, k, 1]); seeds.push(s) }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos.flat()), 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(seeds.flat()), 4))
  g.setIndex(index)
  return g
}

// The instance's foot, radius (sx), height (sy), phase and group glow; the frame toward the head: right, U the card's up pitched toward an eye above, N its normal toward the head.
const HEAD = /* glsl */ `
  // Per instance: flicker phase, flicker group.
  attribute vec2 aFlame;
  uniform highp float uTime;
  uniform vec3 uGlow, uHot, uMid, uCool;
  uniform float uGain, uTilt, uSparkSize;
  ${HEAD_EYE_DECL}
  varying vec3 vColor;
  vec3 ramp( float h ) {
    return mix( mix( uCool, uMid, clamp( h * 2.0, 0.0, 1.0 ) ), uHot, clamp( h * 2.0 - 1.0, 0.0, 1.0 ) );
  }
`
const FRAME = /* glsl */ `
    vec3 origin = instanceMatrix[3].xyz;
    float sx = length( instanceMatrix[0].xyz );
    float sy = length( instanceMatrix[1].xyz );
    float ph = aFlame.x;
    float g = aFlame.y;
    float glow = dot( uGlow, vec3( g < 0.5, abs( g - 1.0 ) < 0.5, g > 1.5 ) );
    vec3 toHead = ${HEAD_EYE_GLSL} - origin;
    float flat_ = length( toHead.xz );
    vec3 fwd = flat_ > 1e-5 ? vec3( toHead.x, 0.0, toHead.z ) / flat_ : vec3( 0.0, 0.0, 1.0 );
    vec3 right = vec3( fwd.z, 0.0, -fwd.x );
    // Negative with the eye above: the top leans away from her, so the face tips up toward her.
    float pitch = atan( -toHead.y, flat_ ) * uTilt;
    float cp = cos( pitch ), sp = sin( pitch );
    vec3 U = vec3( 0.0, cp, 0.0 ) + fwd * sp;
    vec3 N = fwd * cp - vec3( 0.0, sp, 0.0 );
`

// A layer is a fan of sixteen outline points on a teardrop, the inner ones stepped toward the head. Bumps run up both sides to the tip, so tongues lick upward; the tip jumps and the top sways.
const CEL = /* glsl */ `
    float i = position.x;
    float L = position.y;
    float scl = 1.0 - 0.3 * L;
    highp float t = uTime + L * 2.1 + ph;
    float D = 0.3 * sy * scl;
    float Up = sy * scl - D;
    float W = 0.85 * sx * scl;
    vec2 q = vec2( 0.0 );
    if ( i >= 0.0 ) {
      float th = i / M * 6.2831853;
      float tip = 1.0 + 0.15 * sin( t * 6.0 ) + 0.1 * sin( t * 10.7 + 1.0 );
      float cy = cos( th );
      q = vec2( W * sin( th ) * sin( th * 0.5 ), cy > 0.0 ? cy * Up * tip : cy * D );
      float a = th < 3.14159 ? th : 6.2831853 - th;
      float side = th < 3.14159 ? 0.0 : 1.7;
      float bump = pow( 0.5 + 0.5 * sin( a * 6.0 + t * 7.0 + side ), 3.0 ) * smoothstep( 2.6, 0.5, a ) * 0.6 * W;
      q += normalize( vec2( sin( th ), 1.6 ) ) * bump;
    }
    q.x += 0.25 * sx * pow( max( q.y, 0.0 ) / sy, 2.0 ) * sin( t * 1.7 );
    p = origin + right * q.x + U * ( D + q.y ) + N * ( ( L * 0.04 + 0.01 ) * sx );
    vColor = ramp( 0.18 + 0.41 * L ) * ( uGain * glow ) * ( i < 0.0 ? 1.1 : 1.0 );
`

// Two-triangle diamonds, stretched upright, a third of them alive in any one life, rising on a curling path and shrinking out.
const SPARK = /* glsl */ `
    highp float clock = uTime * ( 0.5 + 0.5 * aSeed.x ) + aSeed.y * 7.0 + ph;
    float u = fract( clock );
    float cyc = floor( clock );
    float on = step( fract( aSeed.z * 13.1 + cyc * 0.618034 ), 0.3 );
    float ang = ( aSeed.w + cyc * 0.381966 ) * 6.2831853;
    vec2 foot = vec2( cos( ang ), sin( ang ) ) * 0.4 * sx * sqrt( fract( aSeed.z + cyc * 0.7548777 ) );
    float h = sy * ( 0.35 + 1.5 * u * ( 0.6 + 0.4 * aSeed.x ) );
    vec2 drift = vec2( sin( u * 7.0 + aSeed.y * 30.0 ), cos( u * 5.0 + aSeed.w * 30.0 ) ) * 0.5 * sx * u;
    vec3 c = origin + vec3( foot.x + drift.x, h, foot.y + drift.y );
    float s = sy * 0.03 * uSparkSize * ( 1.0 - u ) * on;
    float k = position.x;
    vec2 o = k < 0.5 ? vec2( 0.0, 1.6 ) : k < 1.5 ? vec2( 0.5, 0.0 ) : k < 2.5 ? vec2( 0.0, -1.0 ) : vec2( -0.5, 0.0 );
    p = c + ( right * o.x + U * o.y ) * s;
    vColor = ramp( 1.0 - 0.7 * u ) * ( uGain * glow ) * 1.3;
`

const VERT = HEAD + /* glsl */ `
  #define M ${POINTS}.0
  attribute vec4 aSeed;
  void main() {
    ${FRAME}
    vec3 p;
    if ( position.z < 0.5 ) {
      ${CEL}
    } else {
      ${SPARK}
    }
    gl_Position = projectionMatrix * viewMatrix * vec4( p, 1.0 );
  }
`

const FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4( vColor, 1.0 );
    #include <colorspace_fragment>
  }
`

const KNOBS = { tilt: 'uTilt', sparkSize: 'uSparkSize', gain: 'uGain' }
const COLORS = { birthColor: 'uHot', midColor: 'uMid', deathColor: 'uCool' }

const footPhase = (x, z) => ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1 + 1) % 1 * 2 * Math.PI

export class TriFlames {
  /** The debug panel's `fire` row: false draws no flame anywhere. */
  static shown = true

  /**
   * @param capacity  the most flames
   * @param params    a TRI_FIRE-shaped object
   */
  constructor(capacity, params = TRI_FIRE, { seed = 5 } = {}) {
    if (!(capacity >= 1)) throw new Error('TriFlames: capacity must be at least 1')
    this.capacity = capacity
    this.count = 0
    this.group = new THREE.Group()
    this.shared = { uTime: { value: 0 }, uGlow: { value: new THREE.Vector3(1, 1, 1) } }
    for (const u of Object.values(COLORS)) this.shared[u] = { value: new THREE.Color() }
    for (const u of Object.values(KNOBS)) this.shared[u] = { value: 1 }
    bindHeadEye(this.shared)
    this.at = Array.from({ length: capacity }, () => ({ x: 0, y: 0, z: 0, height: 1, radius: 1, phase: 0, group: 0 }))
    this.set(params)

    const geometry = flameGeometry(seed)
    geometry.setAttribute('aFlame', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2))
    const material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.shared, side: THREE.DoubleSide, fog: false })
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity)
    this.mesh.count = 0
    this.mesh.visible = false
    this.mesh.frustumCulled = false
    this.group.add(this.mesh)
    this._m = new THREE.Matrix4()
  }

  /** Push a TRI_FIRE-shaped object into the uniforms. */
  set(params) {
    for (const [k, u] of Object.entries(KNOBS)) {
      if (!Number.isFinite(params[k])) throw new Error(`TriFlames: ${k} is ${params[k]}`)
      this.shared[u].value = params[k]
    }
    for (const [k, u] of Object.entries(COLORS)) this.shared[u].value.setRGB(...params[k])
    this.params = params
  }

  /** Place flame `i`: its foot, its height and foot radius in metres, its phase and flicker group. With no phase it is hashed from the foot, so a moving flame must be given one or it races through its flicker. */
  place(i, x, y, z, { height, radius, phase = footPhase(x, z), group = 0 }) {
    if (i >= this.capacity) throw new Error(`TriFlames: ${i} is past the capacity of ${this.capacity}`)
    Object.assign(this.at[i], { x, y, z, height, radius, phase, group })
    if (i >= this.count) this.count = i + 1
    this.mesh.setMatrixAt(i, this._m.makeScale(radius, height, radius).setPosition(x, y, z))
    this.mesh.instanceMatrix.needsUpdate = true
    const flame = this.mesh.geometry.getAttribute('aFlame')
    flame.setXY(i, phase, group)
    flame.needsUpdate = true
  }

  /** Once a frame: the clock in seconds and each group's glow. */
  update(t, glow) {
    this.shared.uTime.value = t
    this.shared.uGlow.value.set(glow[0], glow[1], glow[2])
    this.mesh.count = TriFlames.shown ? this.count : 0
    this.mesh.visible = this.mesh.count > 0
  }

  /** Triangles the flames draw this frame. */
  triangles() {
    return this.mesh.count * FLAME_TRIS
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}
