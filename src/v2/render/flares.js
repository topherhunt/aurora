// ---------------------------------------------------------------------------
// Flares: what the flare gun (flaregun.js) shoots, hers and every peer's. A
// flare flies FLIGHT_S from the muzzle to its target on a bowed, spiralling,
// jittered path rolled from its seed, so every client flies the same one; it
// is FLY_M across on the way and grows to REST_M once there, and hangs there
// for good. Each is a sprite laid in view space -- a white-hot ball in its
// colour, a halo, and within NEAR_M rays of noise sliding outward past a
// wobbling rim -- premultiplied, unlit and unfogged, so it burns as bright at
// midnight as at noon. Past NEAR_M it is the ball and halo alone, never under
// MIN_PX pixels in radius, gone by FAR_M. The layer outlives the rooms; each
// flare names the room it was shot in and only the current room's are drawn.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

export const FLIGHT_S = 1
// Metres across in flight and at rest, the size it leaves the muzzle at, the seconds it takes to reach FLY_M, and to grow to REST_M on arrival.
export const FLY_M = 1
export const REST_M = 3
export const MUZZLE_M = 0.25
export const RAMP_S = 0.12
export const GROW_S = 0.5
// The path: its upward bow and the spiral's radius as fractions of the flight's length, the spiral's turns, and the jitter's reach, likewise.
export const BOW = 0.15
export const SPIRAL = 0.05
export const TURNS = 2.5
export const JITTER = 0.02
// Metres within which the rays and the wobbling rim are drawn, at which the flare is gone, and over which it fades out before that; its least radius on screen, pixels.
export const NEAR_M = 300
export const FAR_M = 2000
export const FADE_M = 200
export const MIN_PX = 2
// Flares kept across every room; past this the oldest is forgotten.
export const CAP = 64
// The card's half-size in ball radii: room for the halo and the rays.
const REACH = 3

const ID_RE = /^[0-9a-z]{1,16}$/
const ROOM_RE = /^[a-z0-9:.-]{1,40}$/

/** A flare off the wire or out of a save: `[id, room, ox, oy, oz, tx, ty, tz, color, seed]`. Throws on anything else. */
export function fromWire(a) {
  if (!Array.isArray(a) || a.length !== 10) throw new Error(`flares: not a flare: ${JSON.stringify(a)}`)
  const [id, room, ox, oy, oz, tx, ty, tz, color, seed] = a
  if (typeof id !== 'string' || !ID_RE.test(id) || typeof room !== 'string' || !ROOM_RE.test(room)) throw new Error(`flares: bad id or room: ${JSON.stringify(a)}`)
  if (![ox, oy, oz, tx, ty, tz, seed].every(Number.isFinite) || !Number.isInteger(color) || color < 0 || color > 0xffffff) throw new Error(`flares: bad numbers: ${JSON.stringify(a)}`)
  return { id, room, ox, oy, oz, tx, ty, tz, color, seed }
}

const r2 = (v) => Math.round(v * 100) / 100
export const toWire = (f) => [f.id, f.room, r2(f.ox), r2(f.oy), r2(f.oz), r2(f.tx), r2(f.ty), r2(f.tz), f.color, Math.round(f.seed * 1e4) / 1e4]

/** Where a flare is a fraction `u` of the way through its flight, into `out`. Ends exactly at the target. */
export function flightAt(f, u, out) {
  const dx = f.tx - f.ox, dy = f.ty - f.oy, dz = f.tz - f.oz
  const len = Math.hypot(dx, dy, dz)
  // Fast off the muzzle, slowing into the target.
  const e = 1 - (1 - u) * (1 - u)
  let sx = -dz, sz = dx
  const sl = Math.hypot(sx, sz)
  if (sl > 1e-6) { sx /= sl; sz /= sl } else { sx = 1; sz = 0 }
  const env = Math.sin(Math.PI * u)
  const a = f.seed * Math.PI * 2 + TURNS * Math.PI * 2 * e
  const r = SPIRAL * len * env
  const j = JITTER * len * env
  const side = r * Math.cos(a) + j * (0.6 * Math.sin(u * 17 + f.seed * 31) + 0.4 * Math.sin(u * 41 + f.seed * 7))
  const up = r * Math.sin(a) + j * (0.6 * Math.sin(u * 23 + f.seed * 13) + 0.4 * Math.sin(u * 37 + f.seed * 19)) + 4 * e * (1 - e) * BOW * len
  out.x = f.ox + dx * e + sx * side
  out.y = f.oy + dy * e + up
  out.z = f.oz + dz * e + sz * side
  return out
}

/** Metres across `age` seconds after the shot. */
export function sizeAt(age) {
  if (age < FLIGHT_S) return MUZZLE_M + (FLY_M - MUZZLE_M) * Math.min(1, age / RAMP_S)
  const g = Math.min(1, (age - FLIGHT_S) / GROW_S)
  return FLY_M + (REST_M - FLY_M) * g * g * (3 - 2 * g)
}

const VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aColor;
  attribute vec2 aSize;
  uniform float uPx;
  varying vec2 vP;
  varying vec3 vColor;
  varying float vSeed;
  varying float vNear;
  varying float vFade;
  void main() {
    // A sprite: the card is laid in view space, so each eye of a stereo pair faces it squarely.
    vec4 mv = viewMatrix * vec4( aPos, 1.0 );
    float dist = length( mv.xyz );
    // The ball's radius, or the metres MIN_PX pixels span at this depth if that is more: projectionMatrix[1][1] maps a depth's metres to half the view's height.
    float r = max( 0.5 * aSize.x, ${MIN_PX.toFixed(1)} * 2.0 * max( -mv.z, 0.01 ) / ( projectionMatrix[1][1] * uPx ) );
    mv.xy += position.xy * r * ${REACH.toFixed(1)};
    gl_Position = projectionMatrix * mv;
    vP = position.xy * ${REACH.toFixed(1)};
    vColor = aColor;
    vSeed = aSize.y;
    vNear = 1.0 - smoothstep( ${(NEAR_M * 0.8).toFixed(1)}, ${NEAR_M.toFixed(1)}, dist );
    vFade = 1.0 - smoothstep( ${(FAR_M - FADE_M).toFixed(1)}, ${FAR_M.toFixed(1)}, dist );
  }
`

const FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vP;
  varying vec3 vColor;
  varying float vSeed;
  varying float vNear;
  varying float vFade;
  float hash( vec3 p ) {
    p = fract( p * 0.3183099 + 0.1 );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }
  float noise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix(
      mix( mix( hash( i ), hash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( hash( i + vec3( 0.0, 1.0, 0.0 ) ), hash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y ),
      mix( mix( hash( i + vec3( 0.0, 0.0, 1.0 ) ), hash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( hash( i + vec3( 0.0, 1.0, 1.0 ) ), hash( i + vec3( 1.0, 1.0, 1.0 ) ), f.x ), f.y ),
      f.z );
  }
  void main() {
    // vP is in ball radii: the ball is d < 1, the card's edge ${REACH}.
    float d = length( vP );
    float t = uTime + vSeed * 50.0;
    float flick = noise( vec3( t * 14.0, vSeed * 9.0, 0.0 ) );
    vec2 dir = vP / max( d, 1e-4 );
    float edge = 1.0 + vNear * 0.3 * ( noise( vec3( dir * 3.0, t * 5.0 ) ) - 0.5 );
    float core = 1.0 - smoothstep( 0.55 * edge, edge, d );
    float halo = 0.6 * exp( -d * d * 1.5 );
    // The rays: noise round the rim whose pattern slides outward with time, from the ball's edge to the card's.
    float rays = 0.0;
    if ( vNear > 0.0 ) {
      float n = noise( vec3( dir * 7.0, d * 2.5 - t * 6.0 ) );
      rays = vNear * 3.0 * n * n * n * n * smoothstep( 0.5, 1.0, d ) * ( 1.0 - smoothstep( 1.0, ${REACH.toFixed(1)}, d ) );
    }
    // Premultiplied: the ball covers what is behind it, white-hot at the heart; the halo and the rays add over the scene.
    vec3 hot = mix( vColor, vec3( 1.0 ), 0.65 * core );
    vec3 rgb = hot * core * ( 0.8 + 0.2 * flick ) + vColor * ( halo + rays ) * ( 0.6 + 0.4 * flick );
    gl_FragColor = vec4( rgb * vFade, core * vFade );
    #include <colorspace_fragment>
  }
`

const _v = new THREE.Vector3()
const _c = new THREE.Color()

export class Flares {
  constructor(scene) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPx: { value: 1000 }, uTime: { value: 0 } },
      premultipliedAlpha: true,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
      fog: false,
    })
    const geo = new THREE.InstancedBufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    const attr = (size) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(CAP * size), size)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.aPos = attr(3)
    this.aColor = attr(3)
    this.aSize = attr(2)
    geo.setAttribute('aPos', this.aPos)
    geo.setAttribute('aColor', this.aColor)
    geo.setAttribute('aSize', this.aSize)
    geo.instanceCount = 0
    this.mesh = new THREE.Mesh(geo, this.material)
    this.mesh.name = 'v2-flares'
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
    // Oldest first; each a fromWire flare and `born`, the layer's seconds at the shot.
    this.list = []
    this.room = null
    this.now = 0
  }

  /** A flare shot `age` seconds ago; one already known by its id is left be. Returns whether it was new. */
  add(f, age) {
    if (!(age >= 0)) throw new Error(`Flares.add: age ${age}`)
    if (this.list.some((g) => g.id === f.id)) return false
    this.list.push({ ...f, born: this.now - age })
    while (this.list.length > CAP) this.list.shift()
    return true
  }

  /** Every flare, as a save writes them. */
  save() {
    return this.list.map(toWire)
  }

  /** A save's flares in place of these, all long arrived. */
  load(wires) {
    this.list = wires.map((a) => ({ ...fromWire(a), born: -Infinity }))
  }

  clear() {
    this.list = []
  }

  /** The room whose flares are drawn: see flaregun.js roomKey. */
  setRoom(key) {
    this.room = key
  }

  /** One frame: `px` is the height in pixels of the view it is drawn to. */
  update(dt, px) {
    this.now += dt
    this.material.uniforms.uTime.value = this.now % 1000
    this.material.uniforms.uPx.value = px
    let n = 0
    for (const f of this.list) {
      if (f.room !== this.room) continue
      const age = this.now - f.born
      if (age < FLIGHT_S) flightAt(f, age / FLIGHT_S, _v)
      else _v.set(f.tx, f.ty, f.tz)
      _v.toArray(this.aPos.array, n * 3)
      _c.setHex(f.color).toArray(this.aColor.array, n * 3)
      this.aSize.array[n * 2] = sizeAt(age)
      this.aSize.array[n * 2 + 1] = f.seed
      n++
    }
    this.aPos.needsUpdate = this.aColor.needsUpdate = this.aSize.needsUpdate = true
    this.mesh.geometry.instanceCount = n
    this.mesh.visible = n > 0
  }
}
