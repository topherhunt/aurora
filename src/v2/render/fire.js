import THREE from '../../three-instance.js'
import { mulberry32 } from '../../sim/mathx.js'

// ---------------------------------------------------------------------------
// FLAMES: one additive ShaderMaterial on one InstancedMesh of upright cards,
// each card a teardrop mask whose OUTLINE is displaced by noise scrolling
// upward, so the silhouette breaks into tongues that tear off at the tip
// rather than the flame merely being noisy inside. The world's flame sources
// (lamps, torches, campfires) are meant to share this one draw call.
//
// THE COST MODEL. The card hugs the flame -- an octagon, not a quad -- because
// on the Quest's tile-based GPU the price is per COVERED fragment, and a lamp
// flame covers a few thousand of them where the lake covers millions. That is
// what buys the fragment its two noise fetches and three-stop ramp.
//
// WHY ADDITIVE. §7 reserves alpha blending for the aurora, mist, water and
// snow because a blend cannot be sorted inside an instanced draw. Additive
// blending is commutative, so it needs no sort at all, the same argument the
// aurora and the stars make. Depth is tested and never written. The known
// consequence is the one design/10-weather.md records: additive over a bright
// sky vanishes, which for a flame is what a daytime flame actually does.
//
// NOISE FROM A TEXTURE, NOT A HASH. Adreno fetches a texel more cheaply than
// it evaluates a hash-based gradient noise, so the two octaves are two fetches
// of one tileable 64 px tile that carries two independent fbm fields in R and
// G, generated once at construction (buildNoiseTexture).
//
// The billboard turns about Y only, toward the eye, so the flame stays upright
// and each eye of a stereo pair turns it a little differently. A campfire that
// is looked down on wants `sheets` 2 or 3: fixed cards at k * pi / sheets about
// the instance's own yaw, not billboarded, each with its own phase.
// ---------------------------------------------------------------------------

// Every knob the shader takes, with the lamp-scale defaults (locked on /test-fire, 2026-09-21). The bench's sliders edit a copy of this and hand it back through `Flames.set`.
export const FIRE = {
  // Metres: the still mask's height and the card's half-width. The mask's widest point is `width` times the half-width, and the card runs OVERHANG past the mask's top so a tongue the noise lifts dies out inside it.
  height: 0.32,
  radius: 0.1,
  // The mask's half-width at its widest, as a fraction of the card's; the rest is room for the displaced outline.
  width: 0.9,
  // The noise scroll rate, cycles per second, and its vertical frequency, cycles per flame height.
  speed: 2.95,
  stretch: 1.95,
  // How far the noise displaces the outline at the tip, in card half-widths; the base moves a sixth as much.
  turb: 0.59,
  // How hard the noise cuts INTO the mask near the tip, tearing tongues off it.
  cut: 0.0,
  // How far the whole flame leans, at the tip, in card half-widths.
  sway: 0.0,
  // The ramp's stops on the mask value (0 the outline, 1 the axis): the edge band's width and where the core goes white.
  edge: 0.25,
  core: 0.88,
  // Brightness. Linear, before the flicker.
  gain: 2.35,
  // Cards per flame: 1 is a billboard, 2 or 3 are fixed sheets.
  sheets: 1,
  // Linear RGB, outline to axis: the translucent red rim, the orange tongue, the hot yellow body, the near-white core.
  edgeColor: [0.4, 0.02, 0.0],
  tipColor: [0.9, 0.18, 0.02],
  hotColor: [1.0, 0.45, 0.08],
  coreColor: [1.0, 0.85, 0.45],
}

// The three flicker groups: each a slow and a fast sine about a mean, on the seconds clock. lamps.js carries its own copy of these numbers for the lamp map; the two merge when the shader lands there.
export const FLICKER = { mean: 0.84, slow: 0.16, slowHz: 11.3, fast: 0.09, fastHz: 24.7 }

export const flicker = (t, phase) => FLICKER.mean + FLICKER.slow * Math.sin(t * FLICKER.slowHz + phase) + FLICKER.fast * Math.sin(t * FLICKER.fastHz + phase * 2.3)

// Tileable value noise on a g x g lattice, the same wrap preview-stage.js uses for its ground.
function lattice(rand, g) {
  const v = new Float32Array(g * g)
  for (let i = 0; i < v.length; i++) v[i] = rand()
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y) => {
    const fx = x * g, fy = y * g
    const ix = Math.floor(fx), iy = Math.floor(fy)
    const x0 = ((ix % g) + g) % g, y0 = ((iy % g) + g) % g
    const x1 = (x0 + 1) % g, y1 = (y0 + 1) % g
    const tx = smooth(fx - ix), ty = smooth(fy - iy)
    const a = v[y0 * g + x0], b = v[y0 * g + x1], c = v[y1 * g + x0], d = v[y1 * g + x1]
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
  }
}

/** Two independent three-octave fbm fields in R and G of one tileable tile, each normalised to fill 0..1. */
export function buildNoiseTexture(size = 64, seed = 3) {
  const rand = mulberry32(seed)
  const fields = [0, 1].map(() => [lattice(rand, 4), lattice(rand, 8), lattice(rand, 16)])
  const data = new Uint8Array(size * size * 4)
  for (let c = 0; c < 2; c++) {
    const [l0, l1, l2] = fields[c]
    const vals = new Float32Array(size * size)
    let lo = Infinity, hi = -Infinity
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size
        const n = l0(u, v) * 0.5 + l1(u, v) * 0.3 + l2(u, v) * 0.2
        vals[y * size + x] = n
        if (n < lo) lo = n
        if (n > hi) hi = n
      }
    }
    for (let i = 0; i < vals.length; i++) data[i * 4 + c] = Math.round(((vals[i] - lo) / (hi - lo)) * 255)
  }
  for (let i = 0; i < size * size; i++) data[i * 4 + 3] = 255
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

// How far past the still mask's top (y = 1) the card runs, in mask heights: the room a tongue the noise lifts has to die out before the card's edge would cut it.
export const OVERHANG = 0.35

// The card: an octagon in x -1..1, y 0..1 + OVERHANG that trims the corners a teardrop never reaches, one fan of six triangles. `aSheet` is the card's index within its flame.
export const CARD_OUTLINE = [[-0.5, 0], [0.5, 0], [1, 0.2], [1, 0.8], [0.6, 1 + OVERHANG], [-0.6, 1 + OVERHANG], [-1, 0.8], [-1, 0.2]]
function buildCard(sheets) {
  const outline = CARD_OUTLINE
  const pos = [], sheet = [], idx = []
  for (let s = 0; s < sheets; s++) {
    const base = s * outline.length
    for (const [x, y] of outline) { pos.push(x, y, 0); sheet.push(s) }
    for (let k = 1; k < outline.length - 1; k++) idx.push(base, base + k, base + k + 1)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('aSheet', new THREE.Float32BufferAttribute(sheet, 1))
  g.setIndex(idx)
  return g
}

const VERT = /* glsl */ `
  attribute float aSheet;
  // Per instance: flicker phase, flicker group, yaw.
  attribute vec3 aFlame;
  uniform float uSheets;
  // Each group's flicker this frame.
  uniform vec3 uGlow;
  varying vec2 vP;
  varying float vPhase;
  varying float vGlow;

  void main() {
    vec3 origin = instanceMatrix[3].xyz;
    float sx = length( instanceMatrix[0].xyz );
    float sy = length( instanceMatrix[1].xyz );
    vec3 right;
    if ( uSheets < 1.5 ) {
      vec3 to = cameraPosition - origin;
      to.y = 0.0;
      vec3 fwd = normalize( to + vec3( 0.0, 0.0, 1e-4 ) );
      right = vec3( fwd.z, 0.0, -fwd.x );
    } else {
      float a = aFlame.z + aSheet * 3.14159265 / uSheets;
      right = vec3( cos( a ), 0.0, sin( a ) );
    }
    float g = aFlame.y;
    vGlow = dot( uGlow, vec3( g < 0.5, abs( g - 1.0 ) < 0.5, g > 1.5 ) );
    // The flame breathes with its glow: a fifth of its height rides the flicker.
    vec3 w = origin + right * ( position.x * sx ) + vec3( 0.0, position.y * sy * ( 0.8 + 0.2 * vGlow ), 0.0 );
    gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
    vP = position.xy;
    vPhase = aFlame.x + aSheet * 2.1;
  }
`

const FRAG = /* glsl */ `
  uniform sampler2D uNoise;
  uniform float uTime, uSpeed, uStretch, uTurb, uCut, uSway, uWidth, uEdge, uCore, uGain;
  uniform vec3 uEdgeColor, uTipColor, uHotColor, uCoreColor;
  varying vec2 vP;
  varying float vPhase;
  varying float vGlow;

  // The still flame's half-width: a teardrop, widest (uWidth) a third of the way up, a point at the top. 2.1 is the reciprocal of the curve's peak.
  float halfWidth( float y ) {
    y = clamp( y, 0.0, 1.0 );
    return uWidth * 2.1 * pow( y, 0.35 ) * pow( 1.0 - y, 0.9 );
  }

  void main() {
    float t = uTime * uSpeed;
    vec2 p = vP;
    float rise = clamp( p.y, 0.0, 1.0 );
    // The whole flame leans, most at the tip.
    p.x -= uSway * rise * rise * sin( t * 0.9 + vPhase );
    // Two octaves scrolling upward, the finer one faster; each fetch is two independent fields. The x frequency is what gives the two sides of the outline different noise -- lower and they wobble together as a strip.
    vec2 n1 = texture2D( uNoise, vec2( p.x * 0.6 + vPhase * 0.13, p.y * uStretch - t * 0.5 ) ).rg - 0.5;
    vec2 n2 = texture2D( uNoise, vec2( p.x * 1.3 + 0.41 + vPhase * 0.07, p.y * uStretch * 2.3 - t * 0.9 ) ).rg - 0.5;
    vec2 n = n1 + 0.5 * n2;
    // The base barely moves; the tip is where the outline goes, and it keeps growing into the overhang.
    float amp = 0.15 + 0.85 * p.y;
    vec2 q = p + n * uTurb * amp;
    // Parabolic across the width, so the bright core is half the flame rather than a line down its axis.
    float x = abs( q.x ) / max( halfWidth( q.y ), 1e-3 );
    float v = 1.0 - x * x;
    // The tongues: the same noise cutting into the mask, so a lobe near the tip separates.
    v -= ( n.x + n.y ) * uCut * rise;
    // The foot is pinched shut whatever the noise says, and a lifted tongue fades out across the overhang, so neither edge of the card ever shows.
    v *= smoothstep( 0.0, 0.1, p.y ) * ( 1.0 - smoothstep( 1.0, ${(1 + OVERHANG).toFixed(2)}, p.y ) );
    if ( v <= 0.0 ) {
      gl_FragColor = vec4( 0.0 );
      return;
    }
    // Outline to axis: rim, tongue, body, then the core only in the lower half.
    vec3 c = mix( uEdgeColor, uTipColor, smoothstep( 0.0, 0.35, v ) );
    c = mix( c, uHotColor, smoothstep( 0.3, uCore, v ) );
    c = mix( c, uCoreColor, smoothstep( uCore, 1.0, v ) * ( 1.0 - 0.8 * rise ) );
    // The upper half cools toward the tongue colour whatever the mask says.
    c = mix( c, uTipColor, 0.6 * smoothstep( 0.55, 1.0, rise ) );
    // A feathered rim, and the light thickening toward the axis.
    float a = smoothstep( 0.0, uEdge, v ) * ( 0.55 + 0.45 * v );
    gl_FragColor = vec4( c * ( a * uGain * vGlow ), 1.0 );
    #include <colorspace_fragment>
  }
`

export class Flames {
  /**
   * @param capacity  the most flames the mesh holds
   * @param params    a FIRE-shaped object; the shader's knobs are read from it by `set`
   */
  constructor(capacity, params = FIRE, { seed = 3 } = {}) {
    if (!(capacity >= 1)) throw new Error('Flames: capacity must be at least 1')
    this.capacity = capacity
    this.noise = buildNoiseTexture(64, seed)
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uNoise: { value: this.noise },
        uTime: { value: 0 },
        uSpeed: { value: 1 },
        uStretch: { value: 1 },
        uTurb: { value: 0 },
        uCut: { value: 0 },
        uSway: { value: 0 },
        uWidth: { value: 0.5 },
        uEdge: { value: 0.2 },
        uCore: { value: 0.8 },
        uGain: { value: 1 },
        uSheets: { value: 1 },
        uGlow: { value: new THREE.Vector3(1, 1, 1) },
        uEdgeColor: { value: new THREE.Color() },
        uTipColor: { value: new THREE.Color() },
        uHotColor: { value: new THREE.Color() },
        uCoreColor: { value: new THREE.Color() },
      },
      blending: THREE.AdditiveBlending,
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
    this.sheets = 0
    this.mesh = null
    this.flame = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.flame.setUsage(THREE.DynamicDrawUsage)
    this.group = new THREE.Group()
    this._m = new THREE.Matrix4()
    this._p = new THREE.Vector3()
    this._q = new THREE.Quaternion()
    this._s = new THREE.Vector3()
    this.set(params)
  }

  /** Push a FIRE-shaped object into the uniforms; rebuilds the card when `sheets` changes. */
  set(params) {
    const u = this.material.uniforms
    for (const k of ['speed', 'stretch', 'turb', 'cut', 'sway', 'width', 'edge', 'core', 'gain']) {
      if (!Number.isFinite(params[k])) throw new Error(`Flames: ${k} is ${params[k]}`)
      u['u' + k[0].toUpperCase() + k.slice(1)].value = params[k]
    }
    for (const k of ['edgeColor', 'tipColor', 'hotColor', 'coreColor']) u['u' + k[0].toUpperCase() + k.slice(1)].value.setRGB(...params[k])
    const sheets = Math.max(1, Math.round(params.sheets))
    if (sheets !== this.sheets) {
      this.sheets = sheets
      u.uSheets.value = sheets
      const count = this.mesh ? this.mesh.count : 0
      if (this.mesh) {
        this.group.remove(this.mesh)
        this.mesh.geometry.dispose()
      }
      const geo = buildCard(sheets)
      geo.setAttribute('aFlame', this.flame)
      const old = this.mesh
      this.mesh = new THREE.InstancedMesh(geo, this.material, this.capacity)
      if (old) this.mesh.instanceMatrix.copyArray(old.instanceMatrix.array)
      this.mesh.count = count
      this.mesh.frustumCulled = false
      this.group.add(this.mesh)
    }
  }

  /** Place flame `i`: its foot, its height and half-width in metres, its flicker phase and group, and its yaw (sheets only). */
  place(i, x, y, z, { height, radius, phase = 0, group = 0, yaw = 0 }) {
    if (i >= this.capacity) throw new Error(`Flames: ${i} is past the capacity of ${this.capacity}`)
    this.mesh.setMatrixAt(i, this._m.compose(this._p.set(x, y, z), this._q.identity(), this._s.set(radius, height, radius)))
    this.flame.setXYZ(i, phase, group, yaw)
    this.mesh.instanceMatrix.needsUpdate = true
    this.flame.needsUpdate = true
    if (i >= this.mesh.count) this.mesh.count = i + 1
  }

  /** Once a frame: the clock in seconds and each group's glow, 0 (out) to about 1. */
  update(t, glow) {
    this.material.uniforms.uTime.value = t
    this.material.uniforms.uGlow.value.set(glow[0], glow[1], glow[2])
  }

  dispose() {
    this.group.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.dispose()
    this.material.dispose()
    this.noise.dispose()
  }
}
