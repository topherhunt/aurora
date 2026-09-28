// ---------------------------------------------------------------------------
// Flares: what the flare gun (flaregun.js) shoots, hers and every peer's. A
// flare flies FLIGHT_S from the muzzle to its target on a bowed corkscrew
// whose phase is its seed, so every client flies the same one; it
// is FLY_M across on the way and grows to REST_M once there, and hangs there
// for good. Each is a sprite laid in view space -- a white-hot ball in its
// colour, a halo, and within NEAR_M a fountain of sparks it never stops
// throwing, each flying out and drooping as it cools -- premultiplied, unlit
// and unfogged, so it burns as bright at midnight as at noon. Past NEAR_M it
// is a flickering dot, white at the heart, never under MIN_PX pixels in
// radius, gone by FAR_M. How it looks is FLARE, live through Flares.set (test-flare.html tunes
// it). The layer outlives the rooms; each flare names the room it was shot in
// and only the current room's are drawn.
// ---------------------------------------------------------------------------

import THREE from '../../three-instance.js'

export const FLIGHT_S = 0.8
// Metres across in flight and at rest, the size it leaves the muzzle at, the seconds it takes to reach FLY_M, and to grow to REST_M on arrival.
export const FLY_M = 1
export const REST_M = 3
export const MUZZLE_M = 0.25
export const RAMP_S = 0.12
export const GROW_S = 0.5
// The path: its upward bow and the corkscrew's radius as fractions of the flight's length, and the corkscrew's turns.
export const BOW = 0.15
export const SPIRAL = 0.05
export const TURNS = 2.5
// Metres within which the rays and the wobbling rim are drawn, at which the flare is gone, and over which it fades out before that; its least radius on screen, pixels.
export const NEAR_M = 300
export const FAR_M = 3000
export const FADE_M = 500
export const MIN_PX = 2
// Flares kept across every room; past this the oldest is forgotten.
export const CAP = 64
// Sparks a fragment walks at most; FLARE.sparks is how many it draws.
export const MAX_SPARKS = 64
// The look, lengths in ball radii (half the flare's size):
//   core, halo, haloFall  the ball's radius, the halo's brightness and how fast it falls off
//   flicker               how much the ball and halo flicker, 0..1
//   sparks, rate          sparks in the air at once, and the lives each lives per second
//   speed, drag           how far a spark flies, and how early in its life it slows (0 an even pace)
//   gravity               how far it droops by the end of its life
//   trail, width          its streak, as a fraction of its life, and its half-width
//   white, gain, crackle  how white-hot it is at birth, its brightness, and how hard it twinkles as it dies
export const FLARE = {
  core: 0.1, halo: 0.21, haloFall: 0.75, flicker: 0.5,
  sparks: 40, rate: 1, speed: 3.2, drag: 0, gravity: 0.4,
  trail: 0.14, width: 0.07, white: 0.8, gain: 2.2, crackle: 1,
}
// The card's half-size in ball radii for a look: room for the halo and for the sparks at the end of their flight and fall.
const reachOf = (p) => Math.max(2.5, p.speed + p.gravity + 4 * p.width)
// Each spark flies within its own slice of the circle, so a fragment walks only the slices either side of its own
// that a spark can bend into: this many each way. A spark droops by its length times gravity / speed, so no spark
// bends further than atan(gravity / speed) off its line, plus half a slice of jitter and one of streak width.
// walkOf is the slices walked from -span: never more than there are, so none is walked twice.
export const spanOf = (p) => (p.sparks < 1 ? 0 : 1 + Math.ceil(Math.atan(p.gravity / p.speed) / ((2 * Math.PI) / p.sparks)))
export const walkOf = (p) => Math.min(p.sparks, 2 * spanOf(p) + 1)

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
  // The corkscrew turns in the plane square to the line: a level side (x, 0, z), and the line crossed with it (ux, uy, uz).
  let sx = -dz, sz = dx
  const sl = Math.hypot(sx, sz)
  if (sl > 1e-6) { sx /= sl; sz /= sl } else { sx = 1; sz = 0 }
  const ux = (dy * sz) / len, uy = (dz * sx - dx * sz) / len, uz = (-dy * sx) / len
  // Its radius swells from nothing at the muzzle and closes to nothing at the target; its angle keeps pace with the distance flown.
  const r = SPIRAL * len * Math.sin(Math.PI * u)
  const a = f.seed * Math.PI * 2 + TURNS * Math.PI * 2 * e
  const side = r * Math.cos(a), up = r * Math.sin(a)
  const bow = 4 * e * (1 - e) * BOW * len
  out.x = f.ox + dx * e + sx * side + ux * up
  out.y = f.oy + dy * e + uy * up + bow
  out.z = f.oz + dz * e + sz * side + uz * up
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
  uniform float uReach;
  varying vec2 vP;
  varying vec2 vDown;
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
    mv.xy += position.xy * r * uReach;
    gl_Position = projectionMatrix * mv;
    vP = position.xy * uReach;
    // The world's down on the card, so sparks fall the right way under a tilted head; straight up or down there is none, and they fall down the view.
    vec2 down = ( viewMatrix * vec4( 0.0, -1.0, 0.0, 0.0 ) ).xy;
    vDown = length( down ) > 0.05 ? normalize( down ) : vec2( 0.0, -1.0 );
    vColor = aColor;
    vSeed = aSize.y;
    vNear = 1.0 - smoothstep( ${(NEAR_M * 0.8).toFixed(1)}, ${NEAR_M.toFixed(1)}, dist );
    vFade = 1.0 - smoothstep( ${(FAR_M - FADE_M).toFixed(1)}, ${FAR_M.toFixed(1)}, dist );
  }
`

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSpan;
  uniform float uWalk;
  uniform float uCore;
  uniform float uHalo;
  uniform float uHaloFall;
  uniform float uFlicker;
  uniform float uSparks;
  uniform float uRate;
  uniform float uSpeed;
  uniform float uDrag;
  uniform float uGravity;
  uniform float uTrail;
  uniform float uWidth;
  uniform float uWhite;
  uniform float uGain;
  uniform float uCrackle;
  varying vec2 vP;
  varying vec2 vDown;
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
  // A spark's place a fraction u through its life, flying out along dir (its length the reach) and drooping down,
  // by as much of gravity as its length is of the full reach.
  vec2 sparkAt( vec2 dir, float u ) {
    float k = 1.0 + 3.0 * uDrag;
    return dir * ( 1.0 - pow( 1.0 - u, k ) ) + vDown * uGravity * length( dir ) / uSpeed * u * u;
  }
  void main() {
    // vP is in ball radii: the ball is d < core, the card's edge uReach. Far off the ball swells to fill its
    // MIN_PX floor, so what is left there is a flickering dot, white at the heart.
    float d = length( vP );
    float t = uTime + vSeed * 50.0;
    float flick = mix( 1.0, 0.6 + 0.8 * noise( vec3( t * 14.0, vSeed * 9.0, 0.0 ) ), uFlicker );
    float coreR = mix( 1.0, uCore, vNear );
    float core = 1.0 - smoothstep( 0.6 * coreR, coreR, d );
    float halo = uHalo * exp( -d * d * uHaloFall );
    // The sparks: spark i flies in slice i of the circle, a new way within it every life, each on its own clock.
    // A sphere's worth of lengths seen side on, so most fly near the full reach and a few come nearly at the eye.
    vec3 sparks = vec3( 0.0 );
    if ( vNear > 0.0 && uSparks > 0.0 ) {
      float slice = 6.2831853 / uSparks;
      float mine = floor( atan( vP.y, vP.x ) / slice + 0.5 );
      for ( int j = 0; j < ${MAX_SPARKS}; j++ ) {
        if ( float( j ) >= uWalk ) break;
        float fi = mod( mine + float( j ) - uSpan, uSparks );
        float life = t * uRate + hash( vec3( fi, vSeed * 97.0, 1.0 ) );
        float cyc = floor( life );
        float u = life - cyc;
        float a = slice * ( fi + hash( vec3( fi, cyc, vSeed * 31.0 + 2.0 ) ) - 0.5 );
        float c = 2.0 * hash( vec3( cyc, fi, vSeed * 17.0 + 3.0 ) ) - 1.0;
        vec2 dir = vec2( cos( a ), sin( a ) ) * mix( 0.25, 1.0, sqrt( 1.0 - c * c ) ) * uSpeed;
        vec2 born = dir * uCore / uSpeed * 0.8;
        vec2 head = born + sparkAt( dir, u );
        vec2 tail = born + sparkAt( dir, max( u - uTrail, 0.0 ) );
        // Distance to the streak, and h, how far along it from tail (0) to head (1).
        vec2 ab = head - tail;
        float h = clamp( dot( vP - tail, ab ) / max( dot( ab, ab ), 1e-6 ), 0.0, 1.0 );
        vec2 off = vP - tail - ab * h;
        float w = uWidth * ( 1.0 - 0.5 * u );
        float line = exp( -dot( off, off ) / ( w * w ) ) * ( 0.25 + 0.75 * h );
        if ( line < 0.002 ) continue;
        // Cooling from white through its colour toward a dim ember, twinkling harder as it dies.
        float tw = hash( vec3( fi, floor( t * 24.0 ), cyc ) );
        float crack = mix( 1.0, step( 0.45, tw ) * 1.8, uCrackle * smoothstep( 0.3, 0.9, u ) );
        vec3 col = mix( vec3( 1.0 ), vColor, mix( 1.0 - uWhite, 1.0, smoothstep( 0.0, 0.45, u ) ) );
        sparks += col * line * pow( 1.0 - u, 1.5 ) * crack;
      }
      sparks *= vNear * uGain;
    }
    // Premultiplied: the ball covers what is behind it, white-hot at the heart; the halo and the sparks add over the scene.
    vec3 hot = mix( vColor, vec3( 1.0 ), 0.65 * core );
    vec3 rgb = ( hot * core + vColor * halo ) * flick + sparks;
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
      uniforms: {
        uPx: { value: 1000 }, uTime: { value: 0 }, uReach: { value: 1 }, uSpan: { value: 0 }, uWalk: { value: 0 },
        uCore: { value: 0 }, uHalo: { value: 0 }, uHaloFall: { value: 0 }, uFlicker: { value: 0 },
        uSparks: { value: 0 }, uRate: { value: 0 }, uSpeed: { value: 0 }, uDrag: { value: 0 }, uGravity: { value: 0 },
        uTrail: { value: 0 }, uWidth: { value: 0 }, uWhite: { value: 0 }, uGain: { value: 0 }, uCrackle: { value: 0 },
      },
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
    this.set(FLARE)
  }

  /** A look, every key of FLARE (see it), into the shader. */
  set(p) {
    const u = this.material.uniforms
    for (const key of Object.keys(FLARE)) {
      if (!Number.isFinite(p[key])) throw new Error(`Flares.set: ${key} is ${p[key]}`)
      u[`u${key[0].toUpperCase()}${key.slice(1)}`].value = p[key]
    }
    if (p.sparks > MAX_SPARKS) throw new Error(`Flares.set: ${p.sparks} sparks, past MAX_SPARKS ${MAX_SPARKS}`)
    u.uReach.value = reachOf(p)
    u.uSpan.value = spanOf(p)
    u.uWalk.value = walkOf(p)
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
