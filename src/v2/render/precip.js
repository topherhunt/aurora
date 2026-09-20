// Precipitation: rain and snow in a fixed box about her head (§10,
// "Precipitation").
//
// One draw of COUNT quads in a BOX-metre cube that wraps modulo the box as she
// moves, so the cost is the same in a valley and on a summit. Each quad decides
// per frame whether it is a raindrop or a snowflake against uSnow, so the band
// at the snow line is sleet and the two never need a second material: both
// blend normally with no depth write, and at a pixel or two wide the sort
// errors that additive snow was to sidestep are invisible. A quad the intensity
// does not want is pushed behind the far plane in the vertex stage.

import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'

export const BOX_M = 12
// The head sits this far below the box's centre: the falling comes from above.
const LIFT = 0.2
export const COUNT = 2000
// The speed a teleport is told apart from a walk at, so a jump does not smear
// every streak across the view for a frame.
const TELEPORT_MPS = 30
// Above the snow line's centre by this much is all snow, below it all rain.
export const SLEET_BAND_M = 60
// How much stormier a summit is than the valley floor (§10, elevationFactor).
export const ELEVATION_GAIN = 0.4
export const ELEVATION_TOP_M = 800

// One function, in both languages: the shader wants the velocity for the streak
// direction and the CPU sums it into the fall offset, and they must agree.
const VELOCITY_GLSL = /* glsl */ `
  vec3 velocity( float snow, vec2 wind, float intensity ) {
    float fall = mix( 9.0, 1.3, snow );
    float shear = mix( 2.0 + 4.0 * intensity, 1.2, snow );
    return vec3( wind.x * shear, -fall, wind.y * shear );
  }
`
const velocity = (snow, wind, intensity, out) => {
  const fall = 9 + (1.3 - 9) * snow
  const shear = (2 + 4 * intensity) + (1.2 - (2 + 4 * intensity)) * snow
  return out.set(wind[0] * shear, -fall, wind[1] * shear)
}
// The sway is periodic in this, so the clock wraps there and never grows.
const SWAY_PERIOD_S = 20 * Math.PI

const VERTEX = /* glsl */ `
  attribute vec3 aSeed;
  attribute vec2 aCorner;
  attribute vec2 aPick;
  uniform vec3 uHead;
  uniform vec3 uCamVel;
  uniform vec2 uWind;
  uniform vec3 uFallRain;
  uniform vec3 uFallSnow;
  uniform float uTime;
  uniform float uIntensity;
  uniform float uSnow;
  varying vec2 vCorner;
  varying float vSnow;
  varying float vFade;

  ${VELOCITY_GLSL}

  void main() {
    float snow = step( aPick.x, uSnow );
    vSnow = snow;
    vCorner = aCorner;
    // A flake drifts down at a metre and a bit a second, swaying; a drop falls
    // at nine, sheared by the wind. The fall so far is summed on the CPU and
    // kept inside the box, so it never outgrows a float.
    vec3 vel = velocity( snow, uWind, uIntensity );
    vec3 sway = snow * vec3( sin( uTime * 1.7 + aSeed.x * 40.0 ), 0.0, cos( uTime * 1.3 + aSeed.z * 40.0 ) ) * 0.8;
    float box = ${BOX_M.toFixed(1)};
    vec3 centre = uHead + vec3( 0.0, box * ${LIFT.toFixed(2)}, 0.0 );
    vec3 world = mod( aSeed * box + mix( uFallRain, uFallSnow, snow ) + sway - centre, box ) - box * 0.5 + centre;
    vec4 view = modelViewMatrix * vec4( world, 1.0 );
    float dist = length( view.xyz );

    // The streak runs along the drop's motion as the eye sees it.
    vec3 relVel = vel - uCamVel;
    vec3 axis = normalize( ( viewMatrix * vec4( relVel, 0.0 ) ).xyz );
    // Looking straight down a falling drop, the cross is zero; any side will do.
    vec3 side = cross( axis, vec3( 0.0, 0.0, 1.0 ) );
    side = length( side ) < 1e-3 ? vec3( 1.0, 0.0, 0.0 ) : normalize( side );
    float px = dist * 0.0022;
    // A flake never falls under a few pixels, or the far half of the box is empty.
    float flakeSize = max( 0.05, px * 5.0 );
    float len = mix( clamp( length( relVel ) * 0.03, 0.05, 0.8 ), flakeSize, snow );
    float wid = mix( px * 2.0 + 0.004, flakeSize, snow );
    if ( snow > 0.5 ) { axis = vec3( 0.0, 1.0, 0.0 ); side = vec3( 1.0, 0.0, 0.0 ); }
    view.xyz += axis * aCorner.y * len * 0.5 + side * aCorner.x * wid * 0.5;

    // Popping at the wrap plane and a streak across the eye are both faded out.
    vFade = smoothstep( 0.25, 0.7, dist ) * ( 1.0 - smoothstep( box * 0.36, box * 0.5, dist ) );
    gl_Position = projectionMatrix * view;
    if ( aPick.y > uIntensity ) gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
  }
`

const FRAGMENT = /* glsl */ `
  uniform vec3 uRain;
  uniform vec3 uFlake;
  uniform float uAlpha;
  varying vec2 vCorner;
  varying float vSnow;
  varying float vFade;

  void main() {
    float streak = ( 1.0 - abs( vCorner.x ) ) * ( 1.0 - vCorner.y * vCorner.y );
    float flake = 1.0 - smoothstep( 0.5, 0.9, length( vCorner ) );
    float a = mix( streak * 0.65, flake * 0.95, vSnow ) * uAlpha * vFade;
    gl_FragColor = vec4( mix( uRain, uFlake, vSnow ), a );
    #include <colorspace_fragment>
  }
`

export class Precip {
  constructor(scene) {
    const geometry = new THREE.BufferGeometry()
    const seed = new Float32Array(COUNT * 4 * 3)
    const corner = new Float32Array(COUNT * 4 * 2)
    const pick = new Float32Array(COUNT * 4 * 2)
    const index = new Uint16Array(COUNT * 6)
    // A fixed seed: the layout is a spread, not a world fact, and nothing keeps it in step with a peer.
    const rnd = mulberry32(0x9e3779b9)
    for (let i = 0; i < COUNT; i++) {
      const sx = rnd(), sy = rnd(), sz = rnd(), px = rnd(), py = rnd()
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c
        seed[v * 3] = sx; seed[v * 3 + 1] = sy; seed[v * 3 + 2] = sz
        corner[v * 2] = c & 1 ? 1 : -1; corner[v * 2 + 1] = c & 2 ? 1 : -1
        pick[v * 2] = px; pick[v * 2 + 1] = py
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6)
    }
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3))
    geometry.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2))
    geometry.setAttribute('aPick', new THREE.BufferAttribute(pick, 2))
    geometry.setIndex(new THREE.BufferAttribute(index, 1))
    // No position attribute: the vertex stage places every quad about uHead.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)

    this.uniforms = {
      uHead: { value: new THREE.Vector3() },
      uCamVel: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2(1, 0) },
      uFallRain: { value: new THREE.Vector3() },
      uFallSnow: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uSnow: { value: 0 },
      uRain: { value: new THREE.Color(0.6, 0.62, 0.66) },
      uFlake: { value: new THREE.Color(1, 1, 1) },
      uAlpha: { value: 1 },
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    })
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = 'precip'
    // After the dome (950): the dome tests depth and writes none, and a streak
    // drawn before it would be painted over by sky.
    this.mesh.renderOrder = 960
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    scene.add(this.mesh)

    this.enabled = true
    this._prev = new THREE.Vector3()
    this._havePrev = false
    this._vel = new THREE.Vector3()
    this._tmp = new THREE.Vector3()
  }

  /**
   * Per frame. `state` is the clock's; `snowLine` the snow line's height at
   * her xz; `submerged` whether her eye is under a water surface, where no
   * drop falls. Off entirely (no draw) when nothing falls.
   */
  update(dt, head, state, snowLine, submerged = false) {
    if (!(dt >= 0)) throw new Error(`Precip.update: dt must be non-negative, got ${dt}`)
    const u = this.uniforms
    const elev = Math.max(0, Math.min(1, head.y / ELEVATION_TOP_M))
    const intensity = state.precip * (1 - ELEVATION_GAIN + ELEVATION_GAIN * elev)
    this.intensity = intensity
    this.mesh.visible = this.enabled && !submerged && intensity > 0.001
    // Her own motion, smoothed, for the streak direction; a teleport is not motion.
    if (this._havePrev && dt > 0) {
      const vx = (head.x - this._prev.x) / dt, vy = (head.y - this._prev.y) / dt, vz = (head.z - this._prev.z) / dt
      if (Math.hypot(vx, vy, vz) < TELEPORT_MPS) {
        const k = Math.min(1, dt * 6)
        this._vel.x += (vx - this._vel.x) * k; this._vel.y += (vy - this._vel.y) * k; this._vel.z += (vz - this._vel.z) * k
      } else this._vel.set(0, 0, 0)
    }
    this._prev.copy(head)
    this._havePrev = true
    if (!this.mesh.visible) return

    u.uTime.value = (u.uTime.value + dt) % SWAY_PERIOD_S
    u.uHead.value.copy(head)
    u.uCamVel.value.copy(this._vel)
    u.uWind.value.set(state.wind[0], state.wind[1])
    u.uIntensity.value = intensity
    for (const [snow, fall] of [[0, u.uFallRain.value], [1, u.uFallSnow.value]]) {
      fall.addScaledVector(velocity(snow, state.wind, intensity, this._tmp), dt)
      fall.x = ((fall.x % BOX_M) + BOX_M) % BOX_M; fall.y = ((fall.y % BOX_M) + BOX_M) % BOX_M; fall.z = ((fall.z % BOX_M) + BOX_M) % BOX_M
    }
    u.uSnow.value = smoothstep(-SLEET_BAND_M, SLEET_BAND_M, head.y - snowLine)
    this.snow = u.uSnow.value
    // A drop is the colour of the air it falls through. A flake is backlit by
    // day, a shade under the sky so it shows against it, and floored at night
    // so it is a speck against the dark and not a hole in it.
    const f = state.fog
    u.uRain.value.setRGB(f[0], f[1], f[2], THREE.SRGBColorSpace)
    u.uFlake.value.setRGB(Math.max(0.3, f[0] * 0.82), Math.max(0.3, f[1] * 0.82), Math.max(0.3, f[2] * 0.82), THREE.SRGBColorSpace)
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
