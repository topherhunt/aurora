// One cave system drawn (design/39-caves.md §8): the worker's chunks, the props as instanced meshes, the water and its crabs. Pitch dark: everything is lit only by the torches (lighting.js's uTorch, shared by reference) and the glow the mesher baked from the mushrooms and the mouths' daylight.
//
// The group stands at the cave's world height `oy`; every plan position inside it is cave-local.
import THREE from '../../three-instance.js'
import { TORCH_REACH } from '../../lighting.js'
import { ROCK_TILE_MEAN, LAYER } from '../../textures.js'
import { buildMushroom } from '../../props/mushroom.js'
import { mushroomVariants, mushroomParams } from '../../props/mushroom-bank.js'
import { mulberry32 } from '../../sim/mathx.js'
import { taken } from '../taken.js'
import { KIND as CHALK, RADIUS_M as CHALK_R, SQUASH as CHALK_SQUASH, STONE as CHALK_STONE } from './chalk.js'
import { ribbons } from '../caves/chalk.js'
import { CHUNK, LODS, drawnLod, drawnRegions, chunkGap, lightsIn, rockAt, ROCK_AT } from '../caves/mesh.js'
import { shoreMesh } from '../caves/water.js'
import { WATER, RIPPLE_GLSL } from '../../water.js'
import { stalagmite, stalagmiteCard } from '../caves/stalagmite.js'
import { mouthFlare } from '../caves/field.js'
import { SKY_GLSL } from '../../sky-glsl.js'
import { buildFern } from '../../props/fern.js'
import { shipFernParams, FERN_TIERS } from '../../props/fern-bank.js'
import { buildBladeClump } from '../../props/grass-blades.js'

// Torch and glow gains on the albedo, and the faint floor light so a lit wall's shadowed side is not void.
const TORCH_GAIN = 2.6
const GLOW_GAIN = 3.2
// Fog in the air, and in the water: density per metre, linear colour.
export const CAVE_AIR = { density: 0.022, color: [0, 0, 0] }
export const CAVE_MURK = { density: 0.32, color: [0.004, 0.012, 0.014] }

// Metres the boulders' stone tile covers on the cave rock.
const STONE_M = 2.2

const COMMON = /* glsl */ `
uniform vec4 uTorch[4];
uniform vec3 uTorchColor;
uniform float uFogDensity;
uniform vec3 uFogColor;
uniform sampler2D uStone;
// The stone tile triplanar, its own mean divided out, so the albedo it multiplies stays the tint.
vec3 caveStone(vec3 p, vec3 n) {
  vec3 w = pow(abs(n), vec3(4.0));
  w /= w.x + w.y + w.z;
  vec2 s = vec2(${(1 / STONE_M).toFixed(4)});
#ifdef DRIP
  // A dripstone wears the tile turned a quarter from the walls', its grain running along it.
  vec3 t = texture2D(uStone, p.yz * s).rgb * w.x + texture2D(uStone, p.xz * s).rgb * w.y + texture2D(uStone, p.yx * s).rgb * w.z;
#else
  vec3 t = texture2D(uStone, p.zy * s).rgb * w.x + texture2D(uStone, p.xz * s).rgb * w.y + texture2D(uStone, p.xy * s).rgb * w.z;
#endif
  return mix(vec3(1.0), t / vec3(${ROCK_TILE_MEAN.map((v) => v.toFixed(4)).join(', ')}), 0.85);
}
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
attribute float day;
uniform vec3 uDay;
varying vec3 vCol;
varying vec3 vGlow;
varying vec3 vPos;
varying vec3 vNrm;
#ifdef INSTANCED
attribute vec3 iColor;
attribute vec3 iEmit;
attribute vec3 iGlow;
attribute float iDay;
varying vec3 vEmit;
#endif
#ifdef MUSH
attribute float cap;
#endif
#if defined(MUSH) || defined(FOLIAGE)
attribute vec2 uvProj;
attribute float texLayer;
varying vec2 vUv;
varying float vLayer;
#endif
#ifdef CARD
attribute vec2 cardUv;
varying vec2 vUv;
#endif
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  vec4 w;
#ifdef INSTANCED
  vCol = iColor;
  vGlow = iGlow + iDay * uDay;
  vEmit = iEmit;
#ifdef CARD
  // Spun about the instance's own axis (which a stalactite's turns over) to face the eye.
  vec3 o = (modelMatrix * instanceMatrix[3]).xyz;
  vec3 up = mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0);
  vec3 side = normalize(cross(up, cameraPosition - o));
  w = vec4(o + side * (position.x * length(instanceMatrix[0].xyz)) + up * position.y, 1.0);
  n = cross(side, normalize(up));
  vUv = cardUv;
#else
  // The inverse transpose of a rotation times a scale. mat3(instanceMatrix) alone tips a long thin prop's normals toward its axis, and the triplanar stone streaks along it.
  mat3 m = mat3(instanceMatrix);
  n = mat3(modelMatrix) * (m * (n / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]))));
  w = modelMatrix * (instanceMatrix * p);
#endif
#ifdef MUSH
  // A mushroom's glow is on its cap; the stem is lit faintly from above.
  vEmit = iEmit * mix(0.12, 1.0, cap);
#endif
#if defined(MUSH) || defined(FOLIAGE)
  vUv = uvProj;
  vLayer = texLayer;
#endif
#else
  vCol = color.rgb;
  vGlow = glow + day * uDay;
  w = modelMatrix * p;
  n = mat3(modelMatrix) * n;
#endif
  vPos = w.xyz;
  vNrm = normalize(n);
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
#if defined(MUSH) || defined(FOLIAGE)
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
varying vec2 vUv;
varying float vLayer;
#endif
#ifdef CARD
uniform sampler2D uCard;
varying vec2 vUv;
#endif
void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
#ifdef STONE
  vec3 albedo = vCol * caveStone(vPos, n);
#ifdef CARD
  vec4 card = texture2D(uCard, vUv);
  if (card.a < 0.5) discard;
  albedo *= card.r;
#endif
#elif defined(MUSH)
  // The forest's cap and flesh sheets: the glow is scaled by the sheet's own lightness, so fibres, scales and warts read through it instead of one flat tint.
  vec3 tex = texture(uAtlas, vec3(vUv, vLayer)).rgb;
  vec3 albedo = vCol * tex;
#elif defined(FOLIAGE)
  vec4 leaf = texture(uAtlas, vec3(vUv, vLayer));
  if (leaf.a < 0.5) discard;
  vec3 albedo = vCol * leaf.rgb;
#else
  vec3 albedo = vCol;
#endif
  vec3 c = albedo * (caveTorch(vPos, n) + vGlow * ${GLOW_GAIN.toFixed(2)});
#ifdef MUSH
  c += vEmit * (0.2 + 1.6 * dot(tex, vec3(0.2126, 0.7152, 0.0722)));
#elif defined(INSTANCED)
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
// The lake's surface (water.js) with a cave for its sky: the lake's ripple layers without the swell, its body tint lit by the torches, its mirror share and its clarity looking down. The reflection is the cave the mirror cube saw, and the torch's glint off the ripple. Opaque from below, as the lake is.
const WATER_FRAG = /* glsl */ `
${COMMON}
${RIPPLE_GLSL}
uniform samplerCube uMirror;
uniform float uMirrorOn;
uniform vec3 uTint;
uniform vec3 uReflTint;
uniform float uMirrorDown;
uniform vec2 uClarity;
varying vec3 vPos;
void main() {
  vec3 n = rippleNormal(vPos.xz);
  vec3 v = normalize(vPos - cameraPosition);
  bool under = v.y > 0.0;
  if (under) n.y = -n.y;
  vec3 body = uTint * caveTorch(vPos, n);
  if (under) {
    gl_FragColor = vec4(caveFog(body, vPos), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  vec3 r = reflect(v, n);
  if (r.y < 0.0) r.y = -r.y;
  vec3 refl = texture(uMirror, r).rgb * uMirrorOn * uReflTint;
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    refl += uTorchColor * s * pow(max(dot(r, normalize(l)), 0.0), 120.0) * 3.0 / (1.0 + 0.05 * dot(l, l));
  }
  float f = pow(1.0 - clamp(dot(-v, n), 0.0, 1.0), 5.0);
  vec3 c = caveFog(mix(body, refl, mix(uMirrorDown, 1.0, f)), vPos);
  // water.js's clarity, pre-divided so the reflection keeps its strength where the bed shows through.
  float alpha = 1.0 - uClarity.x * smoothstep(uClarity.y, 1.0, -v.y);
  gl_FragColor = vec4(c / alpha, alpha);
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

// The sky seen out of a mouth: the dome's own gradient (sky.js's uniforms, shared by reference) along the ray through the plane, tipped up so a level look out finds sky rather than the horizon band.
const SKY_VERT = /* glsl */ `
varying vec3 vPos;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`
const SKY_FRAG = /* glsl */ `
varying vec3 vPos;
${SKY_GLSL}
void main() {
  vec3 dir = normalize(vPos - cameraPosition);
  dir.y = 0.3 + 0.7 * dir.y;
  gl_FragColor = vec4(skyRadiance(normalize(dir), 0.0), 1.0);
  #include <colorspace_fragment>
}`

/** The shared uniforms: the torches by reference, the fog per room. */
function caveUniforms(lighting, stone) {
  return {
    uStone: { value: stone },
    uTorch: lighting.uniforms.uTorch,
    uTorchColor: lighting.uniforms.uTorchColor,
    uFogDensity: { value: CAVE_AIR.density },
    uFogColor: { value: new THREE.Color(...CAVE_AIR.color) },
    uTime: { value: 0 },
    uDay: { value: new THREE.Color() },
  }
}

// The pillar and column landmarks: a cone of `sides` round a vertical axis from y 0 (radius 1) to y 1, each ring's radius jittered.
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

// The forest's mushroom species at mesh tier `tier` (mushroom-bank.js), capped from the cave sheet, each with a `cap` attribute (1 on the cap) and its built height.
function mushroomGeometries(tier) {
  return mushroomVariants().map((v, i) => {
    const g = buildMushroom({ ...mushroomParams(v, 0xca7e + i * 101, tier), capLayer: LAYER.MUSHROOM_CAP_CAVE })
    const layer = g.getAttribute('texLayer').array
    g.setAttribute('cap', new THREE.BufferAttribute(Float32Array.from(layer, (l) => (l === LAYER.MUSHROOM_CAP_CAVE ? 1 : 0)), 1))
    return { geometry: g, height: g.userData.mushroom.height }
  })
}

// Every dripstone is the one seed /gen-stalagmite picked, varied by its row's yaw, lean and scale.
const DRIP_VARIANTS = 1
const DRIP_SEED = 150552
// Past DRIP_NEAR metres a dripstone is its card; the split is redone each time her eye moves DRIP_STEP.
const DRIP_NEAR = 20
const DRIP_STEP = 2
// Texels of each variant's column in the card atlas.
const CARD_W = 32, CARD_H = 64
function dripstone(seed) {
  const { position, index } = stalagmite(seed)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(position, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  return g
}

// The variants' cards side by side in one texture, and each one's quad onto its column.
function dripCards() {
  const data = new Uint8Array(CARD_W * DRIP_VARIANTS * CARD_H * 4)
  const quads = []
  for (let k = 0; k < DRIP_VARIANTS; k++) {
    const c = stalagmiteCard(DRIP_SEED + k, CARD_W, CARD_H)
    for (let v = 0; v < CARD_H; v++) data.set(c.data.subarray(v * CARD_W * 4, (v + 1) * CARD_W * 4), (v * CARD_W * DRIP_VARIANTS + k * CARD_W) * 4)
    const u0 = k / DRIP_VARIANTS, u1 = (k + 1) / DRIP_VARIANTS
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-c.half, c.y0, 0, c.half, c.y0, 0, c.half, 1, 0, -c.half, 1, 0], 3))
    g.setAttribute('cardUv', new THREE.Float32BufferAttribute([u0, 0, u1, 0, u1, 1, u0, 1], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    quads.push(g)
  }
  const texture = new THREE.DataTexture(data, CARD_W * DRIP_VARIANTS, CARD_H)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return { texture, quads }
}

// The instanced attributes every prop row carries.
const ROW_ATTRS = { iColor: 3, iEmit: 3, iGlow: 3, iDay: 1 }
const NO_LIGHT = new Float32Array(ROCK_AT)

const BOULDER_VARIANTS = 3
// A unit icosphere (80 triangles) with each vertex pushed in or out, so it reads as a rock rather than a ball. The push hashes the vertex's position: the sphere is unindexed, and its copies of one corner must move together or it cracks.
function boulderGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1)
  const pos = g.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i)
    const h = Math.sin(Math.round(x * 97) * 12.9898 + Math.round(y * 97) * 78.233 + Math.round(z * 97) * 37.719 + seed) * 43758.5453
    const k = 0.75 + 0.45 * (h - Math.floor(h))
    pos.setXYZ(i, x * k, Math.max(-0.4, y * k), z * k)
  }
  g.computeVertexNormals()
  return g
}

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const tmpC = new THREE.Color()
const rockOut = new Float32Array(ROCK_AT)
// The water's mirror cube: its face size, and how far from her eye (m) a water vertex may be to be captured over.
const MIRROR_SIZE = 64
const MIRROR_REACH = 30

export class CaveRoom {
  /** `plan` from planCave, `oy` the cave's world height, `lighting` the WorldLighting whose torches light it, `stone` the boulders' tile (rocks/stone.png, repeating, sRGB), `atlas` the props' texture array (textures.js) the mushrooms and ferns wear, `sky` the Sky's uniforms the mouths show. */
  constructor(plan, oy, lighting, stone, atlas, sky) {
    if (!(stone instanceof THREE.Texture)) throw new Error('CaveRoom: needs the stone tile')
    if (!(atlas instanceof THREE.DataArrayTexture)) throw new Error('CaveRoom: needs the props\' texture array')
    if (!sky || !sky.uZenith) throw new Error('CaveRoom: needs the sky\'s uniforms')
    this.plan = plan
    this.sky = sky
    // CHUNK cell key -> the lights reaching it, for rockAt at the props.
    this.lightBins = new Map()
    this.oy = oy
    this.group = new THREE.Group()
    this.group.name = 'cave-room'
    this.group.position.y = oy
    this.uniforms = caveUniforms(lighting, stone)
    this.mushUniforms = { ...this.uniforms, uAtlas: { value: atlas } }
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { STONE: '' }, vertexColors: true })
    this.propMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '' }, side: THREE.DoubleSide })
    this.rockMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '' }, side: THREE.DoubleSide })
    this.mushMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', MUSH: '' }, side: THREE.DoubleSide })
    this.foliageMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', FOLIAGE: '' }, side: THREE.DoubleSide })
    this.cards = dripCards()
    this.dripMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '', DRIP: '' }, side: THREE.DoubleSide })
    this.cardMaterial = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, uCard: { value: this.cards.texture } }, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '', DRIP: '', CARD: '' }, side: THREE.DoubleSide })
    this.mirror = new THREE.WebGLCubeRenderTarget(MIRROR_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false, depthBuffer: true })
    this.mirrorRig = new THREE.CubeCamera(0.1, 80, this.mirror)
    this.mirrorFace = 0
    this.waterUniforms = {
      ...this.uniforms, uMirror: { value: this.mirror.texture }, uMirrorOn: { value: 0 },
      uChop: { value: WATER.chop }, uFlow: { value: WATER.flow }, uTint: { value: new THREE.Color(WATER.tint) }, uMirrorDown: { value: WATER.mirrorDown },
      uReflTint: { value: new THREE.Color(WATER.reflTint).multiplyScalar(WATER.reflDim) },
      uClarity: { value: new THREE.Vector2(WATER.clarity, Math.sin((WATER.clarityAngle * Math.PI) / 180)) },
    }
    this.waterMeshes = []
    this.waterMaterial = new THREE.ShaderMaterial({ uniforms: this.waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true, side: THREE.DoubleSide })
    this.markMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    // The marks laid (drawChalk), and the strokes being drawn (drawLive).
    this.marks = null
    this.live = null
    // key -> { x, y, z (the chunk's centre), lods: [meshes per LODS tier, null until it arrives or if empty there] }, a mesh per region.
    this.chunks = new Map()
    this.region = plan.graph.nodes[plan.doors[0].node].region
    this.disposables = [this.material, this.propMaterial, this.rockMaterial, this.mushMaterial, this.foliageMaterial, this.dripMaterial, this.cardMaterial, this.cards.texture, this.waterMaterial, this.markMaterial, this.mirror]
    this._props(plan.props)
    this._water(plan.waters)
    this._mouths(plan.graph)
  }

  // Across the far end of each mouth's flare, the opening: a plane of the hour's sky, or for a cellar its door, lit by the torches like the rock.
  _mouths(graph) {
    const mouths = graph.nodes.filter((n) => n.kind === 'mouth')
    const pos = [], idx = []
    for (const n of mouths.filter((m) => !m.cellar)) {
      const { end, w, h } = mouthFlare(n)
      const lx = -n.dz * (w + 1.4), lz = n.dx * (w + 1.4), y0 = end.y - 1, y1 = end.y + h + 1.4
      const v = pos.length / 3
      pos.push(end.x - lx, y0, end.z - lz, end.x + lx, y0, end.z + lz, end.x + lx, y1, end.z + lz, end.x - lx, y1, end.z - lz)
      idx.push(v, v + 1, v + 2, v, v + 2, v + 3)
    }
    this.skyMaterial = new THREE.ShaderMaterial({ uniforms: { ...this.sky }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.DoubleSide })
    this.disposables.push(this.skyMaterial)
    if (pos.length > 0) {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setIndex(idx)
      this.group.add(new THREE.Mesh(g, this.skyMaterial))
      this.disposables.push(g)
    }
    this._instanced(new THREE.PlaneGeometry(1.2, 2.2).translate(0, 1.1, 0), mouths.filter((m) => m.cellar), (n) => {
      const { end } = mouthFlare(n)
      tmpQ.setFromEuler(tmpE.set(0, Math.atan2(n.dx, n.dz), 0))
      tmpM.compose(tmpP.set(end.x, end.y - 0.35, end.z), tmpQ, tmpS.set(1, 1, 1))
      return { color: [0.16, 0.09, 0.045] }
    }, this.propMaterial)
  }

  /** The hour on the mouths: `dayness` 0 (night) to 1 (day) tints the daylight baked round them from night blue to white. */
  setDay(dayness) {
    const k = Math.min(1, Math.max(0, dayness))
    this.uniforms.uDay.value.setRGB(0.02 + 0.53 * k, 0.03 + 0.57 * k, 0.08 + 0.62 * k)
  }

  /** The rock as baked at cave-local (x, y, z) (mesh.js rockAt), into a shared scratch the caller copies from. */
  _rock(x, y, z) {
    const i = Math.floor(x / CHUNK), j = Math.floor(y / CHUNK), k = Math.floor(z / CHUNK)
    const key = `${i},${j},${k}`
    let near = this.lightBins.get(key)
    if (near === undefined) {
      near = lightsIn(this.plan.lights, i * CHUNK, j * CHUNK, k * CHUNK)
      this.lightBins.set(key, near)
    }
    rockAt(this.plan.field, x, y, z, near, rockOut)
    return rockOut
  }

  /** A chunk from the worker at one LOD: { key, lod, position, normal, color, glow, index, parts }, one mesh per region sharing the buffers. */
  addChunk(m) {
    const attrs = {
      position: new THREE.BufferAttribute(m.position, 3), normal: new THREE.BufferAttribute(m.normal, 3),
      color: new THREE.BufferAttribute(m.color, 3), glow: new THREE.BufferAttribute(m.glow, 3), day: new THREE.BufferAttribute(m.day, 1),
    }
    const index = new THREE.BufferAttribute(m.index, 1)
    let sphere = null
    const meshes = []
    for (let p = 0; p < m.parts.length; p += 3) {
      const g = new THREE.BufferGeometry()
      for (const k in attrs) g.setAttribute(k, attrs[k])
      g.setIndex(index)
      g.setDrawRange(m.parts[p + 1], m.parts[p + 2])
      if (sphere === null) { g.computeBoundingSphere(); sphere = g.boundingSphere } else g.boundingSphere = sphere
      const mesh = new THREE.Mesh(g, this.material)
      mesh.matrixAutoUpdate = false
      mesh.visible = false
      mesh.updateMatrix()
      mesh.userData.region = m.parts[p]
      this.group.add(mesh)
      this.disposables.push(g)
      meshes.push(mesh)
    }
    const [i, j, k] = m.key.split(',').map(Number)
    if (!this.chunks.has(m.key)) this.chunks.set(m.key, { x: (i + 0.5) * CHUNK, y: (j + 0.5) * CHUNK, z: (k + 0.5) * CHUNK, lods: LODS.map(() => null) })
    this.chunks.get(m.key).lods[m.lod] = meshes
  }

  /** Her region, from the prim nearest her eye; kept while the eye is out of every prim's reach. */
  _regionAt(x, y, z) {
    const f = this.plan.field
    f.at(x, y, z)
    if (f.owner >= 0) this.region = f.prims[f.owner].region
    return this.region
  }

  // Rows of { x, y, z, ... } through `place`, which sets tmpM and returns { color, emit?, lit? }, `lit` a rockAt sample whose glow and daylight the prop wears: the matrices and ROW_ATTRS arrays.
  _rows(rows, place) {
    const n = rows.length
    const out = { matrix: new Float32Array(n * 16), iColor: new Float32Array(n * 3), iEmit: new Float32Array(n * 3), iGlow: new Float32Array(n * 3), iDay: new Float32Array(n) }
    rows.forEach((r, i) => {
      const c = place(r, tmpM, i)
      tmpM.toArray(out.matrix, i * 16)
      out.iColor.set(c.color, i * 3)
      if (c.emit) out.iEmit.set(c.emit, i * 3)
      const lit = c.lit === undefined ? NO_LIGHT : c.lit
      out.iGlow.set(lit.subarray(6, 9), i * 3)
      out.iDay[i] = lit[9]
    })
    return out
  }

  // Instanced props: rows of { x, y, z, ... } turned into one InstancedMesh per kind (place as _rows), in stone unless given another material.
  _instanced(geometry, rows, place, material = this.rockMaterial) {
    if (rows.length === 0) { geometry.dispose(); return null }
    const mesh = new THREE.InstancedMesh(geometry, material, rows.length)
    const src = this._rows(rows, place)
    mesh.instanceMatrix.array.set(src.matrix)
    for (const k in ROW_ATTRS) geometry.setAttribute(k, new THREE.InstancedBufferAttribute(src[k], ROW_ATTRS[k]))
    mesh.computeBoundingSphere()
    mesh.frustumCulled = false
    this.group.add(mesh)
    this.disposables.push(geometry)
    return mesh
  }

  // A dripstone kind of one variant: its model within DRIP_NEAR of her eye and its card beyond, the rows split between them by update().
  _drips(geometry, card, rows, place) {
    if (rows.length === 0) { geometry.dispose(); card.dispose(); return }
    const src = this._rows(rows, place)
    const [near, far] = [[geometry, this.dripMaterial], [card, this.cardMaterial]].map(([g, material]) => {
      const mesh = new THREE.InstancedMesh(g, material, rows.length)
      for (const k in ROW_ATTRS) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(rows.length * ROW_ATTRS[k]), ROW_ATTRS[k]))
      mesh.count = 0
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.disposables.push(g)
      return mesh
    })
    this.dripSets.push({ src, n: rows.length, near, far })
  }

  // Each dripstone row into the model or the card by its distance from cave-local (x, y, z).
  _splitDrips(x, y, z) {
    for (const d of this.dripSets) {
      const fill = [0, 0]
      for (let i = 0; i < d.n; i++) {
        const m = d.src.matrix
        const f = (m[i * 16 + 12] - x) ** 2 + (m[i * 16 + 13] - y) ** 2 + (m[i * 16 + 14] - z) ** 2 < DRIP_NEAR * DRIP_NEAR ? 0 : 1
        const mesh = f === 0 ? d.near : d.far, j = fill[f]++
        mesh.instanceMatrix.array.set(m.subarray(i * 16, i * 16 + 16), j * 16)
        for (const k in ROW_ATTRS) {
          const s = ROW_ATTRS[k]
          mesh.geometry.getAttribute(k).array.set(d.src[k].subarray(i * s, i * s + s), j * s)
        }
      }
      for (const [f, mesh] of [d.near, d.far].entries()) {
        mesh.count = fill[f]
        mesh.instanceMatrix.needsUpdate = true
        for (const k in ROW_ATTRS) mesh.geometry.getAttribute(k).needsUpdate = true
      }
    }
  }

  _props(props) {
    const set = (x, y, z, yaw, tiltX, tiltZ, sx, sy, sz) => {
      tmpQ.setFromEuler(tmpE.set(tiltX, yaw, tiltZ, 'YXZ'))
      tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(sx, sy, sz))
    }
    const lean = (seed) => (seed - 0.5) * 0.12
    // Dripstone wears the rock it grows from: the wall's baked colour and light at its root, a shade either way.
    const wall = (t) => {
      const lit = this._rock(t.x, t.y, t.z)
      const k = 0.92 + 0.16 * t.seed
      return { color: [lit[3] * k, lit[4] * k, lit[5] * k], lit }
    }
    // The dripstone model in its DRIP_VARIANTS seeds, pointed down for a stalactite and up for a stalagmite.
    this.dripSets = []
    for (let k = 0; k < DRIP_VARIANTS; k++) {
      const mine = (t) => Math.floor(t.seed * DRIP_VARIANTS) === k
      const model = dripstone(DRIP_SEED + k)
      this._drips(model, this.cards.quads[k], props.tites.filter(mine), (t) => {
        set(t.x, t.y + 0.1, t.z, t.seed * 40, Math.PI + lean(t.seed), lean(1 - t.seed), t.r, t.len + 0.1, t.r * (0.8 + 0.4 * t.seed))
        return wall(t)
      })
      this._drips(model.clone(), this.cards.quads[k].clone(), props.mites.filter((t) => !t.pillar && mine(t)), (t) => {
        set(t.x, t.y - 0.05, t.z, t.seed * 40, lean(t.seed), lean(1 - t.seed), t.r * 1.4, t.len + 0.05, t.r * (1.2 + 0.4 * t.seed))
        return wall(t)
      })
    }
    this.dripEye = null
    this._instanced(dripGeometry(0xc01, 12, 6, true), props.mites.filter((t) => t.pillar), (t) => {
      set(t.x, t.y - 0.2, t.z, t.seed * 40, 0, 0, t.r, t.len + 0.4, t.r)
      return wall(t)
    })

    // Ferns and grass: by the mouths, and ferns in the glow of a well-lit chamber.
    const fern = buildFern({ ...shipFernParams(FERN_TIERS[1].segments), seed: 0xfe2 })
    this._instanced(fern, props.ferns, (f) => {
      set(f.x, f.y, f.z, f.yaw, 0, 0, f.s, f.s, f.s)
      return { color: [0.6, 0.62, 0.55], lit: this._rock(f.x, f.y, f.z) }
    }, this.foliageMaterial)
    this._instanced(buildBladeClump({}, 0x6a5), props.grass, (g) => {
      set(g.x, g.y, g.z, g.yaw, 0, 0, g.s, g.s, g.s)
      return { color: [0.05, 0.09, 0.025], lit: this._rock(g.x, g.y, g.z) }
    }, this.propMaterial)

    // Mushrooms: the forest's species grown large, a glowing cap lit from within. One mesh per tier, species and region, so update() shows only her regions' (mushGroups).
    const tiers = [mushroomGeometries(0), mushroomGeometries(1)]
    const groups = new Map()
    for (const m of props.mush) {
      const tier = m.h < 1 ? 1 : 0
      const key = `${tier},${Math.floor(m.seed * tiers[tier].length)},${m.region}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(m)
    }
    this.mushGroups = []
    for (const [key, rows] of groups) {
      const [tier, species, region] = key.split(',').map(Number)
      const { geometry, height } = tiers[tier][species]
      const mesh = this._instanced(geometry.clone(), rows, (m) => {
        tmpS.set(...m.up).normalize()
        tmpQ.setFromUnitVectors(tmpP.set(0, 1, 0), tmpS).multiply(tmpQ2.setFromEuler(tmpE.set(m.lean, m.yaw, 0, 'YXZ')))
        tmpP.set(m.x, m.y, m.z).addScaledVector(tmpS, -0.04)
        const k = m.h / height
        tmpM.compose(tmpP, tmpQ, tmpS.set(k, k, k))
        const lit = this._rock(m.x, m.y, m.z)
        return m.glow ? { color: [0.35, 0.35, 0.35], emit: m.glow.map((c) => c * (m.giant ? 0.9 : 0.7)), lit } : { color: [0.7, 0.7, 0.7], lit }
      }, this.mushMaterial)
      mesh.userData.region = region
      mesh.visible = false
      this.mushGroups.push(mesh)
    }
    for (const t of tiers) for (const s of t) s.geometry.dispose()

    // Ruins: blocks, a lintel spanning its gap.
    this._instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), props.ruins, (b) => {
      set(b.x, b.y, b.z, b.yaw, b.tilt, 0, b.span ?? b.w, b.h, b.w)
      return { color: [0.13, 0.12, 0.105], lit: this._rock(b.x, b.y, b.z) }
    })

    // Boulders: a few lumpy rocks in BOULDER_VARIANTS shapes, squat and half sunk, of the floor they lie on.
    for (let k = 0; k < BOULDER_VARIANTS; k++) {
      this._instanced(boulderGeometry(0xb01 + k), props.boulders.filter((b) => Math.floor(b.seed * BOULDER_VARIANTS) === k), (b) => {
        set(b.x, b.y, b.z, b.yaw, 0, 0, b.r, b.r * (0.6 + 0.3 * b.seed), b.r * (0.8 + 0.3 * b.seed))
        return wall(b)
      })
    }

    // Wall torches: a stick leaning out of the rock, its flame lit from within.
    const tip = (t) => [t.x + t.nx * 0.31, t.y + 0.45, t.z + t.nz * 0.31]
    this._instanced(new THREE.BoxGeometry(0.06, 0.55, 0.06).translate(0, 0.275, 0), props.torches, (t) => {
      set(t.x - t.nx * 0.05, t.y, t.z - t.nz * 0.05, Math.atan2(t.nx, t.nz), 0.6, 0, 1, 1, 1)
      return { color: [0.12, 0.07, 0.03] }
    }, this.propMaterial)
    this._instanced(new THREE.OctahedronGeometry(0.09, 0).scale(1, 1.7, 1), props.torches, (t) => {
      set(...tip(t), 0, 0, 0, 1, 1, 1)
      return { color: [0, 0, 0], emit: [1.6, 0.8, 0.3] }
    }, this.propMaterial)

    // Chalk: lumps of the same stone, paler and bluer, to be learnt by eye; one picked up anywhere this session (taken.js) lies nowhere.
    this.chalkRows = props.chalk
    this.chalkGone = props.chalk.map((c) => taken.has(CHALK, c.x, c.z))
    this.chalkMesh = this._instanced(new THREE.DodecahedronGeometry(CHALK_R, 0), props.chalk, (c, m, i) => {
      set(c.x, c.y + 0.04, c.z, c.yaw, 0.3, 0.2, ...CHALK_SQUASH)
      if (this.chalkGone[i]) m.makeScale(0, 0, 0)
      return { color: CHALK_STONE }
    })

    // Crabs, moved in update(). The pools' fish are the rivers' (render/fish.js), which main.js points at the cave.
    this.crabRows = props.crabs
    this.crabOff = new Float32Array(props.crabs.length)
    this.crabs = this._instanced(new THREE.BoxGeometry(0.16, 0.06, 0.12).translate(0, 0.04, 0), props.crabs, (c) => {
      set(c.x, c.y, c.z, c.yaw, 0, 0, 1, 1, 1)
      return { color: [0.3, 0.1, 0.05] }
    }, this.propMaterial)
  }

  _water(waters) {
    for (const b of waters) {
      let g
      if (b.kind !== 'river') {
        const m = shoreMesh(b.shore, b.level)
        if (m.index.length === 0) continue
        g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
        g.setIndex(m.index)
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
      this.waterMeshes.push(mesh)
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
    const shown = drawnRegions(this.plan.graph, this._regionAt(eye.x, ly, eye.z))
    for (const c of this.chunks.values()) {
      const d = chunkGap(c, eye.x, ly, eye.z)
      const lod = drawnLod(c.lods, d)
      for (let l = 0; l < LODS.length; l++) {
        if (c.lods[l] === null) continue
        for (const mesh of c.lods[l]) mesh.visible = l === lod && shown.has(mesh.userData.region)
      }
    }
    for (const mesh of this.mushGroups) mesh.visible = shown.has(mesh.userData.region)
    const e = this.dripEye
    if (e === null || (e.x - eye.x) ** 2 + (e.y - ly) ** 2 + (e.z - eye.z) ** 2 > DRIP_STEP * DRIP_STEP) {
      this.dripEye = { x: eye.x, y: ly, z: eye.z }
      this._splitDrips(eye.x, ly, eye.z)
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

  /**
   * Each frame she is above water, after update(): one face of the cube the water reflects, taken a hand over the water vertex nearest her eye within MIRROR_REACH, re-picked at each full turn so the six faces share a point. The water itself is hidden from it; the torches are not, so the wall she lights shows in the ripple.
   */
  reflect(renderer, scene, eye) {
    const rig = this.mirrorRig
    if (this.mirrorFace === 0) {
      const ly = eye.y - this.oy
      let best = MIRROR_REACH * MIRROR_REACH, at = null, p = null
      for (const m of this.waterMeshes) {
        const q = m.geometry.getAttribute('position').array
        for (let i = 0; i < q.length; i += 3) {
          const d = (q[i] - eye.x) ** 2 + (q[i + 1] - ly) ** 2 + (q[i + 2] - eye.z) ** 2
          if (d < best) { best = d; at = i; p = q }
        }
      }
      if (at === null) return
      const y = p[at + 1] + 0.3
      if (this.plan.field.at(p[at], y, p[at + 2]) > 0) return
      rig.position.set(p[at], y + this.oy, p[at + 2])
      rig.updateMatrixWorld(true)
    }
    // CubeCamera's six cameras face nowhere until updateCoordinateSystem, which only its own update() calls.
    if (rig.coordinateSystem !== renderer.coordinateSystem) {
      rig.coordinateSystem = renderer.coordinateSystem
      rig.updateCoordinateSystem()
    }
    const wasXR = renderer.xr.enabled, prevTarget = renderer.getRenderTarget(), prevBackground = scene.background
    renderer.getClearColor(tmpC)
    const prevAlpha = renderer.getClearAlpha()
    renderer.xr.enabled = false
    renderer.setClearColor(0x000000, 1)
    scene.background = null
    for (const m of this.waterMeshes) m.visible = false
    renderer.setRenderTarget(this.mirror, this.mirrorFace)
    renderer.clear(true, true, false)
    renderer.render(scene, rig.children[this.mirrorFace])
    for (const m of this.waterMeshes) m.visible = true
    scene.background = prevBackground
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(tmpC, prevAlpha)
    renderer.xr.enabled = wasXR
    this.mirrorFace = (this.mirrorFace + 1) % 6
    if (this.mirrorFace === 0) this.waterUniforms.uMirrorOn.value = 1
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
