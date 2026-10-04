// One cave system drawn (design/39-caves.md §8): the worker's chunks, the props as instanced meshes, the water and its fish and crabs. Pitch dark: everything is lit only by the torches (lighting.js's uTorch, shared by reference) and the glow the mesher baked from the mushrooms and the mouths' daylight.
//
// The group stands at the cave's world height `oy`; every plan position inside it is cave-local.
import THREE from '../../three-instance.js'
import { TORCH_REACH } from '../../lighting.js'
import { mulberry32 } from '../../sim/mathx.js'
import { taken } from '../taken.js'
import { KIND as CHALK, RADIUS_M as CHALK_R, SQUASH as CHALK_SQUASH } from './chalk.js'
import { ribbons } from '../caves/chalk.js'

// Torch and glow gains on the albedo, and the faint floor light so a lit wall's shadowed side is not void.
const TORCH_GAIN = 2.6
const GLOW_GAIN = 3.2
// Fog in the air, and in the water: density per metre, linear colour.
export const CAVE_AIR = { density: 0.022, color: [0, 0, 0] }
export const CAVE_MURK = { density: 0.32, color: [0.004, 0.012, 0.014] }
const CULL_M = 85

const COMMON = /* glsl */ `
uniform vec4 uTorch[4];
uniform vec3 uTorchColor;
uniform float uFogDensity;
uniform vec3 uFogColor;
vec3 caveTorch(vec3 p, vec3 n) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - p;
    float d = length(l);
    float k = clamp(1.0 - d / ${TORCH_REACH.toFixed(1)}, 0.0, 1.0);
    sum += uTorchColor * (s * k * k * (0.3 + 0.7 * max(dot(n, l / max(d, 0.001)), 0.0)));
  }
  return sum * ${TORCH_GAIN.toFixed(2)};
}
vec3 caveFog(vec3 c, vec3 p) {
  float f = 1.0 - exp(-uFogDensity * distance(p, cameraPosition));
  return mix(c, uFogColor, f);
}`

const VERT = /* glsl */ `
attribute vec3 glow;
varying vec3 vCol;
varying vec3 vGlow;
varying vec3 vPos;
varying vec3 vNrm;
#ifdef INSTANCED
attribute vec3 iColor;
attribute vec3 iEmit;
varying vec3 vEmit;
#endif
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
#ifdef INSTANCED
  p = instanceMatrix * p;
  n = mat3(instanceMatrix) * n;
  vCol = iColor;
  vGlow = vec3(0.0);
  vEmit = iEmit;
#else
  vCol = color.rgb;
  vGlow = glow;
#endif
  vec4 w = modelMatrix * p;
  vPos = w.xyz;
  vNrm = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const FRAG = /* glsl */ `
${COMMON}
varying vec3 vCol;
varying vec3 vGlow;
varying vec3 vPos;
varying vec3 vNrm;
#ifdef INSTANCED
varying vec3 vEmit;
#endif
void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  vec3 c = vCol * (caveTorch(vPos, n) + vGlow * ${GLOW_GAIN.toFixed(2)});
#ifdef INSTANCED
  c += vEmit;
#endif
  gl_FragColor = vec4(caveFog(c, vPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

const WATER_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`
// Black water: what shows is the torch's glint off a slow ripple, and the glows' colour on its face.
const WATER_FRAG = /* glsl */ `
${COMMON}
uniform float uTime;
varying vec3 vPos;
void main() {
  vec2 p = vPos.xz;
  vec2 g = 0.05 * vec2(cos(p.x * 3.1 + uTime * 1.1) + 0.6 * cos(p.y * 4.3 - uTime * 0.8), sin(p.y * 2.7 + uTime * 0.9) + 0.6 * sin(p.x * 3.9 + uTime * 1.3));
  vec3 n = normalize(vec3(g.x, 1.0, g.y));
  vec3 v = normalize(vPos - cameraPosition);
  if (v.y > 0.0) n.y = -n.y;
  vec3 r = reflect(v, n);
  vec3 c = vec3(0.004, 0.008, 0.009) + 0.25 * caveTorch(vPos, n) * vec3(0.05, 0.08, 0.09);
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    c += uTorchColor * s * pow(max(dot(r, normalize(l)), 0.0), 120.0) * 3.0 / (1.0 + 0.05 * dot(l, l));
  }
  gl_FragColor = vec4(caveFog(c, vPos), 0.82);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

// Chalk on the rock: torchlit off-white, broken where the grain says the stick skipped.
const MARK_VERT = /* glsl */ `
attribute vec3 grain;
varying vec3 vGrain;
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vGrain = grain;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  vNrm = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`
const MARK_FRAG = /* glsl */ `
${COMMON}
varying vec3 vGrain;
varying vec3 vPos;
varying vec3 vNrm;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 cell = floor(vec2(vGrain.x * 260.0, vGrain.y * 6.0) + vGrain.z);
  float edge = abs(vGrain.y);
  if (hash(cell) < 0.25 + 0.6 * edge * edge) discard;
  vec3 c = vec3(0.78, 0.77, 0.72) * (0.75 + 0.25 * hash(cell + 7.0)) * caveTorch(vPos, normalize(vNrm));
  gl_FragColor = vec4(caveFog(c, vPos), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

/** The shared uniforms: the torches by reference, the fog per room. */
function caveUniforms(lighting) {
  return {
    uTorch: lighting.uniforms.uTorch,
    uTorchColor: lighting.uniforms.uTorchColor,
    uFogDensity: { value: CAVE_AIR.density },
    uFogColor: { value: new THREE.Color(...CAVE_AIR.color) },
    uTime: { value: 0 },
  }
}

// A cone of `sides` round a vertical axis from y 0 (radius 1) to y 1 (the tip), each ring's radius jittered so no two dripstones read alike.
function dripGeometry(seed, sides, rings, flute) {
  const rand = mulberry32(seed)
  const pos = [], idx = []
  for (let r = 0; r <= rings; r++) {
    const y = r / rings
    const wob = 1 + (rand() - 0.5) * 0.35
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + (rand() - 0.5) * 0.3
      const fl = flute ? (s % 2 === 0 ? 1 : 0.86) : 1
      const rad = r === rings ? 0.02 : Math.pow(1 - y, flute ? 0.05 : 1.4) * wob * fl
      pos.push(Math.cos(a) * rad + (rand() - 0.5) * 0.08 * (1 - y), y, Math.sin(a) * rad)
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s, b = r * sides + ((s + 1) % sides)
      idx.push(a, a + sides, b, b, a + sides, b + sides)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// A mushroom cap: a squashed dome over y 0, radius 1, with a lip.
function capGeometry() {
  const g = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.6)
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) p.setY(i, (p.getY(i) - Math.cos(Math.PI * 0.6)) * 0.55 - 0.15)
  g.computeVertexNormals()
  return g
}

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()

export class CaveRoom {
  /** `plan` from planCave, `oy` the cave's world height, `lighting` the WorldLighting whose torches light it. */
  constructor(plan, oy, lighting) {
    this.plan = plan
    this.oy = oy
    this.group = new THREE.Group()
    this.group.name = 'cave-room'
    this.group.position.y = oy
    this.uniforms = caveUniforms(lighting)
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, vertexColors: true })
    this.propMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '' }, side: THREE.DoubleSide })
    this.waterMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    this.markMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    // The marks laid (drawChalk), and the strokes being drawn (drawLive).
    this.marks = null
    this.live = null
    this.chunks = new Map()
    this.disposables = [this.material, this.propMaterial, this.waterMaterial, this.markMaterial]
    this._props(plan.props)
    this._water(plan.waters)
  }

  /** A chunk from the worker: { key, position, normal, color, glow, index }. */
  addChunk(m) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3))
    g.setAttribute('color', new THREE.BufferAttribute(m.color, 3))
    g.setAttribute('glow', new THREE.BufferAttribute(m.glow, 3))
    g.setIndex(new THREE.BufferAttribute(m.index, 1))
    g.computeBoundingSphere()
    const mesh = new THREE.Mesh(g, this.material)
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    this.group.add(mesh)
    this.chunks.set(m.key, mesh)
    this.disposables.push(g)
  }

  // Instanced props: rows of { x, y, z, ... } turned into one InstancedMesh per kind.
  _instanced(geometry, rows, place) {
    if (rows.length === 0) { geometry.dispose(); return null }
    const mesh = new THREE.InstancedMesh(geometry, this.propMaterial, rows.length)
    const col = new Float32Array(rows.length * 3), emit = new Float32Array(rows.length * 3)
    rows.forEach((r, i) => {
      const c = place(r, tmpM, i)
      mesh.setMatrixAt(i, tmpM)
      col.set(c.color, i * 3)
      if (c.emit) emit.set(c.emit, i * 3)
    })
    geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(col, 3))
    geometry.setAttribute('iEmit', new THREE.InstancedBufferAttribute(emit, 3))
    mesh.computeBoundingSphere()
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.disposables.push(geometry)
    return mesh
  }

  _props(props) {
    const rock = [0.1, 0.095, 0.088], pale = [0.17, 0.165, 0.15]
    const set = (x, y, z, yaw, tiltX, tiltZ, sx, sy, sz) => {
      tmpQ.setFromEuler(tmpE.set(tiltX, yaw, tiltZ, 'YXZ'))
      tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz))
    }
    const lean = (seed) => (seed - 0.5) * 0.12
    const drips = [0, 1, 2].map((k) => dripGeometry(0xd71 + k, 7, 4, false))
    for (let k = 0; k < 3; k++) {
      this._instanced(drips[k], props.tites.filter((t) => Math.floor(t.seed * 3) === k), (t) => {
        set(t.x, t.y + 0.15, t.z, t.seed * 40, Math.PI + lean(t.seed), lean(1 - t.seed), t.r, t.len + 0.15, t.r * (0.8 + 0.4 * t.seed))
        return { color: t.seed > 0.5 ? pale : rock }
      })
      this._instanced(drips[k].clone(), props.mites.filter((t) => !t.pillar && Math.floor(t.seed * 3) === k), (t) => {
        set(t.x, t.y - 0.1, t.z, t.seed * 40, lean(t.seed), lean(1 - t.seed), t.r * 1.4, t.len + 0.1, t.r * (1.2 + 0.4 * t.seed))
        return { color: t.seed > 0.5 ? pale : rock }
      })
    }
    this._instanced(dripGeometry(0xc01, 12, 6, true), props.mites.filter((t) => t.pillar), (t) => {
      set(t.x, t.y - 0.2, t.z, t.seed * 40, 0, 0, t.r, t.len + 0.4, t.r)
      return { color: pale }
    })

    // Mushrooms: stems and caps, a glowing one lit from within.
    const stemColor = [0.2, 0.19, 0.17]
    this._instanced(new THREE.CylinderGeometry(0.5, 0.7, 1, 7, 1).translate(0, 0.5, 0), props.mush, (m) => {
      const r = Math.max(0.015, m.h * (m.giant ? 0.08 : 0.06))
      set(m.x, m.y - 0.05, m.z, m.yaw, m.lean, 0, r * 2, m.h, r * 2)
      return { color: stemColor, emit: m.glow ? m.glow.map((c) => c * 0.12) : null }
    })
    this._instanced(capGeometry(), props.mush, (m) => {
      const top = new THREE.Vector3(0, m.h, 0).applyEuler(tmpE.set(m.lean, m.yaw, 0, 'YXZ'))
      set(m.x + top.x, m.y - 0.05 + top.y, m.z + top.z, m.yaw, m.lean * 1.5, 0, m.cap, m.cap * 0.8, m.cap)
      return m.glow ? { color: [0.05, 0.05, 0.05], emit: m.glow.map((c) => c * (m.giant ? 1.1 : 0.8)) } : { color: [0.16, 0.11, 0.07] }
    })

    // Ruins: blocks, a lintel spanning its gap.
    this._instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), props.ruins, (b) => {
      set(b.x, b.y, b.z, b.yaw, b.tilt, 0, b.span ?? b.w, b.h, b.w)
      return { color: [0.13, 0.12, 0.105] }
    })

    // Chalk: pale lumps, the brightest thing her torch finds; one picked up anywhere this session (taken.js) lies nowhere.
    this.chalkRows = props.chalk
    this.chalkGone = props.chalk.map((c) => taken.has(CHALK, c.x, c.z))
    this.chalkMesh = this._instanced(new THREE.DodecahedronGeometry(CHALK_R, 0), props.chalk, (c, m, i) => {
      set(c.x, c.y + 0.04, c.z, c.yaw, 0.3, 0.2, ...CHALK_SQUASH)
      if (this.chalkGone[i]) m.makeScale(0, 0, 0)
      return { color: [0.75, 0.74, 0.7] }
    })

    // Fish and crabs, moved in update().
    this.fishRows = props.fish
    this.fish = this._instanced(new THREE.SphereGeometry(1, 6, 4).scale(0.16, 0.06, 0.04), props.fish, (f, m) => {
      m.identity()
      return { color: [0.3, 0.32, 0.3] }
    })
    this.crabRows = props.crabs
    this.crabOff = new Float32Array(props.crabs.length)
    this.crabs = this._instanced(new THREE.BoxGeometry(0.16, 0.06, 0.12).translate(0, 0.04, 0), props.crabs, (c) => {
      set(c.x, c.y, c.z, c.yaw, 0, 0, 1, 1, 1)
      return { color: [0.3, 0.1, 0.05] }
    })
  }

  _water(waters) {
    for (const b of waters) {
      let g
      if (b.kind === 'pool') {
        g = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2).scale(b.rx, 1, b.rz).rotateY(-b.rot).translate(b.x, b.level, b.z)
      } else {
        // A ribbon along the edge's samples where it holds water.
        const pos = [], idx = []
        let prev = -1
        for (let k = 0; k < b.pts.length; k++) {
          const q = b.pts[k]
          const level = b.levelOf(q)
          if (level === null) { prev = -1; continue }
          const a = b.pts[Math.max(0, k - 1)], c = b.pts[Math.min(b.pts.length - 1, k + 1)]
          let dx = c.x - a.x, dz = c.z - a.z
          const l = Math.hypot(dx, dz) || 1
          dx /= l; dz /= l
          const w = b.half(q)
          const i = pos.length / 3
          pos.push(q.x - dz * w, level, q.z + dx * w, q.x + dz * w, level, q.z - dx * w)
          if (prev >= 0) idx.push(prev, i, prev + 1, prev + 1, i, i + 1)
          prev = i
        }
        if (idx.length === 0) continue
        g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
        g.setIndex(idx)
      }
      const mesh = new THREE.Mesh(g, this.waterMaterial)
      mesh.renderOrder = 2
      this.group.add(mesh)
      this.disposables.push(g)
    }
  }

  /** Chalk lump `i` picked up: gone from the floor. */
  hideChalk(i) {
    this.chalkGone[i] = true
    this.chalkMesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0))
    this.chalkMesh.instanceMatrix.needsUpdate = true
  }

  /** Every stroke on this system's walls, cave-local point lists (caves/chalk.js), in place of the last. */
  drawChalk(strokes) {
    this.marks = this._ribbon(this.marks, strokes)
  }

  /** The strokes her hands are drawing now, redrawn each frame they grow. */
  drawLive(strokes) {
    this.live = this._ribbon(this.live, strokes)
  }

  _ribbon(mesh, strokes) {
    if (mesh !== null) {
      mesh.geometry.dispose()
      mesh.removeFromParent()
    }
    if (strokes.length === 0) return null
    const r = ribbons(strokes, this.plan.field)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(r.position, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3))
    g.setAttribute('grain', new THREE.BufferAttribute(r.grain, 3))
    g.setIndex(new THREE.BufferAttribute(r.index, 1))
    const m = new THREE.Mesh(g, this.markMaterial)
    m.frustumCulled = false
    this.group.add(m)
    return m
  }

  /** Each frame: her eye in world metres, whether it is under water, and the clock. */
  update(eye, submerged, t) {
    const fog = submerged ? CAVE_MURK : CAVE_AIR
    this.uniforms.uFogDensity.value = fog.density
    this.uniforms.uFogColor.value.setRGB(...fog.color)
    this.uniforms.uTime.value = t % 1024
    const ly = eye.y - this.oy
    for (const mesh of this.chunks.values()) {
      const s = mesh.geometry.boundingSphere
      mesh.visible = Math.hypot(s.center.x - eye.x, s.center.y - ly, s.center.z - eye.z) < CULL_M + s.radius
    }
    if (this.fish !== null) {
      this.fishRows.forEach((f, i) => {
        const a = f.phase + (t * f.speed) / Math.max(0.5, f.r)
        set4(f.x + Math.cos(a) * f.r, f.y + 0.08 * Math.sin(t * 0.7 + f.phase), f.z + Math.sin(a) * f.r, -a)
        this.fish.setMatrixAt(i, tmpM)
      })
      this.fish.instanceMatrix.needsUpdate = true
    }
    if (this.crabs !== null) {
      this.crabRows.forEach((c, i) => {
        // Crabs freeze in the torchlight and scuttle sideways in the dark.
        const near = Math.hypot(c.x - eye.x, c.y - ly, c.z - eye.z) < 4
        if (!near) this.crabOff[i] += 0.016 * Math.sin(t * 0.4 + c.seed * 20)
        const s = this.crabOff[i]
        set4(c.x + Math.cos(c.yaw) * s, c.y, c.z + Math.sin(c.yaw) * s, c.yaw)
        this.crabs.setMatrixAt(i, tmpM)
      })
      this.crabs.instanceMatrix.needsUpdate = true
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.drawChalk([])
    this.drawLive([])
    this.group.removeFromParent()
  }
}

function set4(x, y, z, yaw) {
  tmpQ.setFromAxisAngle(tmpP.set(0, 1, 0), yaw)
  tmpM.compose(tmpS.set(x, y, z), tmpQ, tmpP.set(1, 1, 1))
}
