import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// TRIANGLE FLAMES: a flame is a cloud of opaque flat-coloured triangles that are born at the foot, rise, tilt and tumble about the vertical, shift from yellow through orange to red, and shrink to nothing at the top. Nothing is blended and nothing is sampled: the fragment shader writes one varying, so the cost is the triangles' covered pixels and the vertex shader, and an opaque draw with no discard keeps the GPU's early depth rejection.
//
// Every shard is a pure function of the clock and its own static seed (vertex attribute `aSeed`), so there is no per-frame CPU work beyond the instance matrices. A shard's cycle is `fract(clock + seed)`; the cycle index re-rolls its spawn point, so the flame does not repeat itself.
//
// LOD is a separate InstancedMesh per level, each the first N shards of one master list, so a lower level is a subset of the one above it and a flame changing level does not reshuffle. Fewer shards are each drawn larger (`boost`) to hold the silhouette. `update` buckets the flames by distance to the eye. Real 3D shards have per-eye parallax, so there is no billboard and no head-centre aiming.
// ---------------------------------------------------------------------------

// Lamp-scale defaults. The bench (/test-fire-tris) edits a copy and hands it back through `TriFlames.set`.
export const TRI_FIRE = {
  // Metres, as the card flame: the flame's height and the radius of its foot.
  height: 0.32,
  radius: 0.1,
  // Shards in the nearest LOD, the factor each further LOD keeps of the one before, and the exponent on how much larger the shards of a thinner LOD are drawn (0.5 holds their total area).
  shards: 48,
  lodKeep: 0.5,
  boost: 0.5,
  // Metres to the first LOD boundary and the factor between boundaries.
  lodNear: 2.5,
  lodStep: 2.2,
  // Lifetimes per second; the exponent on the climb (above 1 a shard accelerates); how far it is pulled toward the axis by the top; the foot's spread as a fraction of `radius`.
  rate: 1.1,
  rise: 1.0,
  taper: 0.8,
  spread: 1.0,
  // A shard's size as a fraction of the flame's height; the exponent on how fast it shrinks over its life; how much taller than wide (1 is a plain triangle); how much the size varies shard to shard.
  size: 0.26,
  shrink: 1.2,
  sliver: 2.2,
  sizeVar: 0.8,
  // Sideways wander growing with height, in radii, and its rate; the whole flame's lean at the top, in radii; the tumble about the vertical, turns per second.
  wobble: 0.6,
  wobbleHz: 4.0,
  sway: 0.25,
  spin: 1.5,
  // The exponent on a shard's age for its colour (below 1 it cools sooner, so more of the flame is orange and red); how far each shard's colour is shifted along the ramp, 0 to 1; the brightness. Linear RGB: the newborn shard, the middle of its life, the last of it.
  cool: 0.6,
  jitter: 0.35,
  gain: 1.0,
  birthColor: [1.0, 0.85, 0.3],
  midColor: [1.0, 0.4, 0.04],
  deathColor: [0.55, 0.06, 0.0],
}

export const TRI_LOD_COUNT = 4

/** Shards in LOD `k`: `shards` thinned by `lodKeep` per level, never under 3. */
export const shardsAt = (params, k) => Math.max(3, Math.round(params.shards * Math.pow(params.lodKeep, k)))

/** The LOD for a flame `d` metres from the eye: boundaries at lodNear * lodStep^k. */
export const lodFor = (params, d) => {
  let k = 0
  let edge = params.lodNear
  while (k < TRI_LOD_COUNT - 1 && d >= edge) { k++; edge *= params.lodStep }
  return k
}

// One master list of shards: a random scalene triangle in a random orientation (baked, so the shader only spins it about the vertical), and four static randoms.
function masterShards(count, seed) {
  const rand = mulberry32(seed)
  const q = new THREE.Quaternion(), n = new THREE.Vector3(), v = new THREE.Vector3(), z = new THREE.Vector3(0, 0, 1)
  const shards = []
  for (let i = 0; i < count; i++) {
    const cosT = 1 - 2 * rand(), phi = 2 * Math.PI * rand(), sinT = Math.sqrt(1 - cosT * cosT)
    q.setFromUnitVectors(z, n.set(sinT * Math.cos(phi), sinT * Math.sin(phi), cosT))
    const corners = []
    for (let c = 0; c < 3; c++) {
      const a = ((c + (rand() - 0.5) * 0.4) * 2 * Math.PI) / 3
      const r = 0.35 + 0.25 * rand()
      corners.push(v.set(Math.cos(a) * r, Math.sin(a) * r, 0).applyQuaternion(q).toArray())
    }
    shards.push({ corners, seed: [rand(), rand(), rand(), rand()] })
  }
  return shards
}

function buildGeometry(shards, flame) {
  const pos = new Float32Array(shards.length * 9)
  const seed = new Float32Array(shards.length * 12)
  shards.forEach((s, i) => {
    for (let c = 0; c < 3; c++) {
      pos.set(s.corners[c], i * 9 + c * 3)
      seed.set(s.seed, i * 12 + c * 4)
    }
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4))
  g.setAttribute('aFlame', flame)
  return g
}

const VERT = /* glsl */ `
  attribute vec4 aSeed;
  // Per instance: flicker phase, flicker group.
  attribute vec3 aFlame;
  uniform highp float uTime;
  uniform float uRate, uRise, uTaper, uSpread, uSize, uShrink, uSliver, uSizeVar, uBoost;
  uniform float uWobble, uWobbleHz, uSway, uSpin, uCool, uJitter, uGain;
  uniform vec3 uGlow, uBirth, uMid, uDeath, uTint;
  varying vec3 vColor;

  void main() {
    vec3 origin = instanceMatrix[3].xyz;
    float sx = length( instanceMatrix[0].xyz );
    float sy = length( instanceMatrix[1].xyz );
    float g = aFlame.y;
    float glow = dot( uGlow, vec3( g < 0.5, abs( g - 1.0 ) < 0.5, g > 1.5 ) );

    highp float clock = uTime * uRate + aSeed.x;
    float u = fract( clock );
    float cyc = floor( clock );
    float ang = ( aSeed.z + cyc * 0.61803 ) * 6.2831853 + aFlame.x;
    float rad = sqrt( fract( aSeed.y + cyc * 0.38197 ) ) * uSpread * sx * ( 1.0 - uTaper * u );
    float reach = 0.6 + 0.8 * aSeed.w;
    float h = pow( u, uRise ) * reach;

    float wob = uWobble * sx * u * sin( uTime * uWobbleHz + aSeed.z * 40.0 + aFlame.x );
    float lean = uSway * sx * u * u;
    vec2 lat = vec2( cos( ang ), sin( ang ) ) * rad + vec2( wob + lean * sin( uTime * 1.7 + aFlame.x ), lean * cos( uTime * 1.3 + aFlame.x * 2.0 ) );

    float s = uSize * uBoost * sy * smoothstep( 0.0, 0.1, u ) * pow( max( 1.0 - u, 0.0 ), uShrink ) * ( 1.0 - uSizeVar + 2.0 * uSizeVar * aSeed.w );
    vec3 p = position;
    p.y *= uSliver;
    float sp = aSeed.z * 6.2831853 + uTime * uSpin * ( aSeed.w - 0.5 ) * 2.0;
    float cs = cos( sp ), sn = sin( sp );
    p = vec3( p.x * cs + p.z * sn, p.y, p.z * cs - p.x * sn ) * s;

    gl_Position = projectionMatrix * viewMatrix * vec4( origin + vec3( lat.x, h * sy, lat.y ) + p, 1.0 );

    float cu = clamp( pow( u, uCool ) + ( aSeed.w - 0.5 ) * uJitter, 0.0, 1.0 );
    vec3 col = mix( mix( uBirth, uMid, clamp( cu * 2.0, 0.0, 1.0 ) ), uDeath, clamp( cu * 2.0 - 1.0, 0.0, 1.0 ) );
    vColor = col * ( uGain * glow ) * uTint;
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

const KNOBS = {
  rate: 'uRate', rise: 'uRise', taper: 'uTaper', spread: 'uSpread', size: 'uSize', shrink: 'uShrink', sliver: 'uSliver', sizeVar: 'uSizeVar',
  wobble: 'uWobble', wobbleHz: 'uWobbleHz', sway: 'uSway', spin: 'uSpin', cool: 'uCool', jitter: 'uJitter', gain: 'uGain',
}
const COLORS = { birthColor: 'uBirth', midColor: 'uMid', deathColor: 'uDeath' }

export class TriFlames {
  /**
   * @param capacity  the most flames
   * @param params    a TRI_FIRE-shaped object
   */
  constructor(capacity, params = TRI_FIRE, { seed = 5 } = {}) {
    if (!(capacity >= 1)) throw new Error('TriFlames: capacity must be at least 1')
    this.capacity = capacity
    this.seed = seed
    this.count = 0
    this.forceLod = -1
    this.params = null
    this.group = new THREE.Group()
    this.levels = []
    this.shared = {
      uTime: { value: 0 },
      uGlow: { value: new THREE.Vector3(1, 1, 1) },
      uBirth: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uDeath: { value: new THREE.Color() },
    }
    for (const u of Object.values(KNOBS)) this.shared[u] = { value: 1 }
    // Per-flame placement, kept so `update` can bucket by distance.
    this.at = Array.from({ length: capacity }, () => ({ x: 0, y: 0, z: 0, height: 1, radius: 1, phase: 0, group: 0 }))
    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this.set(params)
  }

  /** Push a TRI_FIRE-shaped object into the uniforms; rebuilds the levels when the shard counts change. */
  set(params) {
    for (const [k, u] of Object.entries(KNOBS)) {
      if (!Number.isFinite(params[k])) throw new Error(`TriFlames: ${k} is ${params[k]}`)
      this.shared[u].value = params[k]
    }
    for (const [k, u] of Object.entries(COLORS)) this.shared[u].value.setRGB(...params[k])
    for (const k of ['shards', 'lodKeep', 'boost', 'lodNear', 'lodStep']) if (!Number.isFinite(params[k])) throw new Error(`TriFlames: ${k} is ${params[k]}`)
    const counts = Array.from({ length: TRI_LOD_COUNT }, (_, k) => shardsAt(params, k))
    this.params = params
    if (this.levels.length === TRI_LOD_COUNT && this.levels.every((l, k) => l.shards === counts[k])) {
      this.levels.forEach((l, k) => { l.material.uniforms.uBoost.value = Math.pow(counts[0] / counts[k], params.boost) })
      return
    }
    for (const l of this.levels) this._drop(l)
    const master = masterShards(counts[0], this.seed)
    this.levels = counts.map((n, k) => {
      const material = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { ...this.shared, uBoost: { value: Math.pow(counts[0] / n, params.boost) }, uTint: { value: new THREE.Color(1, 1, 1) } },
        side: THREE.DoubleSide,
        fog: false,
      })
      // Each level's slots hold different flames, so each level owns its per-instance attribute.
      const flame = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3)
      flame.setUsage(THREE.DynamicDrawUsage)
      const mesh = new THREE.InstancedMesh(buildGeometry(master.slice(0, n), flame), material, this.capacity)
      mesh.count = 0
      mesh.frustumCulled = false
      this.group.add(mesh)
      return { shards: n, mesh, material }
    })
  }

  _drop(l) {
    this.group.remove(l.mesh)
    l.mesh.geometry.dispose()
    l.mesh.dispose()
    l.material.dispose()
  }

  /** Place flame `i`: its foot, its height and foot radius in metres, its phase and flicker group. */
  place(i, x, y, z, { height, radius, phase = 0, group = 0 }) {
    if (i >= this.capacity) throw new Error(`TriFlames: ${i} is past the capacity of ${this.capacity}`)
    Object.assign(this.at[i], { x, y, z, height, radius, phase, group })
    if (i >= this.count) this.count = i + 1
  }

  /** Once a frame: the clock in seconds, each group's glow, and the eye the LODs are measured from. Returns the LOD of flame 0 (for the bench's readout). */
  update(t, glow, eye) {
    this.shared.uTime.value = t
    this.shared.uGlow.value.set(glow[0], glow[1], glow[2])
    for (const l of this.levels) l.mesh.count = 0
    const lods = new Array(this.count)
    for (let i = 0; i < this.count; i++) {
      const f = this.at[i]
      const d = Math.hypot(f.x - eye.x, f.y - eye.y, f.z - eye.z)
      const k = this.forceLod >= 0 ? Math.min(this.forceLod, TRI_LOD_COUNT - 1) : lodFor(this.params, d)
      const mesh = this.levels[k].mesh
      const n = mesh.count++
      mesh.setMatrixAt(n, this._m.compose(this._p.set(f.x, f.y, f.z), this._q.identity(), this._s.set(f.radius, f.height, f.radius)))
      mesh.geometry.getAttribute('aFlame').setXYZ(n, f.phase, f.group, 0)
      lods[i] = k
    }
    for (const l of this.levels) {
      l.mesh.instanceMatrix.needsUpdate = true
      l.mesh.geometry.getAttribute('aFlame').needsUpdate = true
    }
    return lods
  }

  /** Triangles the flames draw this frame. */
  triangles() {
    return this.levels.reduce((n, l) => n + l.mesh.count * l.shards, 0)
  }

  dispose() {
    for (const l of this.levels) this._drop(l)
  }
}
