// One cave system drawn (design/39-caves.md §8): the worker's chunks, the props as instanced meshes, the water. Pitch dark: everything is lit only by the torches (lighting.js's uTorch, shared by reference) and the glow the mesher baked from the mushrooms and the mouths' daylight.
//
// The group stands at the cave's world height `oy`; every plan position inside it is cave-local.
import THREE from '../../three-instance.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ROCK_TILE_MEAN, LAYER } from '../../textures.js'
import { buildMushroom } from '../../props/mushroom.js'
import { mushroomVariants, mushroomParams } from '../../props/mushroom-bank.js'
import { impostorCardExtents } from '../../props/impostor.js'
import { LOD_DEG, distAt, ladderTier } from './critters.js'
import { MUSHROOM_STEPS } from './mushrooms.js'
import { CARD_PUSH, CARD_ROUND } from './rocks.js'
import { WorldProbe, WORLD_PROBE } from '../../world-probe.js'
import { taken } from '../taken.js'
import { KIND as CHALK, RADIUS_M as CHALK_R, SQUASH as CHALK_SQUASH, STONE as CHALK_STONE } from './chalk.js'
import { ribbons } from '../caves/chalk.js'
import { Surface } from '../caves/surface.js'
import { veinList } from '../caves/veins.js'
import { VeinLayer } from './veins.js'
import { CaveSpiders } from './cave-spiders.js'
import { CHUNK, LODS, CULL_M, drawnLod, drawnRegions, chunkGap, lightsIn, rockAt, ROCK_AT } from '../caves/mesh.js'
import { shoreMesh } from '../caves/water.js'
import { WATER, RIPPLE_GLSL } from '../../water.js'
import { stalagmite, stalagmiteCard } from '../caves/stalagmite.js'
import { mouthFlare } from '../caves/field.js'
import { TORCH_LEAN } from '../caves/props.js'
import { SKY_GLSL } from '../../sky-glsl.js'
import { buildFern } from '../../props/fern.js'
import { shipFernParams, FERN_TIERS } from '../../props/fern-bank.js'
import { buildBladeClump } from '../../props/grass-blades.js'
import { buildRock, ROCK_TIERS, ROCK_LOD_AT, ROCK_LOD_HYSTERESIS, rockLodSize } from '../../props/rock.js'
import { rockParams, rockCardGeometry, ROCK_IMPOSTOR_LAYERS } from '../../props/rock-bank.js'
import { buildStickGeometry, LENGTH_M as STICK_M, TINT } from './sticks.js'
import { TriFlames, TRI_TORCH } from './fire-tris.js'
import { TORCH as HELD_FLAME } from './wildfire.js'
import { rgb, IRON, WOOD_M } from './interior.js'
import { buildPebble, STRETCH, FLAT, SINK, FULL_RADIUS, RADIUS as PEBBLE_REACH, REACH_SIZES } from './litter.js'

// Torch and glow gains on the albedo, and the faint floor light so a lit wall's shadowed side is not void.
const TORCH_GAIN = 2.6
// A wall torch's stick: radians off upright, out from the rock, and its scale on the overworld's stick.
const TORCH_STICK = 1.1
const STICK_TIP_DIR = new THREE.Vector3(0, 0, -1)
const STICK_TINT = new THREE.Color(TINT).toArray()
// A cellar door, hung as the house hangs its own (town-interior.js doorLeaf): its size, its foot `sunk` under the flare's floor, and its boards; the wood is doorLeaf's WOOD(0.4, -0.1).
export const DOOR = { w: 1.2, h: 2.2, sunk: 0.35, boards: 5 }
const DOOR_WOOD = rgb(0.079, 0.408, 0.152)
const DOOR_IRON = [...IRON]
const GLOW_GAIN = 3.2
// Fog in the air, and in the water: density per metre, linear colour.
export const CAVE_AIR = { density: 0.022, color: [0, 0, 0] }
// While she flies (update's `flying`), the light every surface gets at least, with no fog and every chunk drawn, so she can see the whole layout she is crossing.
const FLY_LIT = 0.1
export const CAVE_MURK = { density: 0.32, color: [0.004, 0.012, 0.014] }

// Metres the boulders' stone tile covers on the cave rock.
const STONE_M = 2.2

const COMMON = /* glsl */ `
uniform vec4 uTorch[4];
uniform float uTorchInvReach[4];
uniform vec4 uTorchTint[4];
uniform float uFogDensity;
uniform vec3 uFogColor;
uniform float uLitFloor;
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
    float k = clamp(1.0 - d * uTorchInvReach[i], 0.0, 1.0);
    sum += uTorchTint[i].rgb * (s * k * k * (0.3 + 0.7 * max(dot(n, l / max(d, 0.001)), 0.0)));
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
#if defined(MUSH) || defined(FOLIAGE) || defined(PICTURE)
attribute vec2 uvProj;
attribute float texLayer;
varying vec2 vUv;
varying float vLayer;
#endif
#if defined(CARD) && !defined(PICTURE)
attribute vec2 cardUv;
varying vec2 vUv;
#endif
#ifdef ROCKCARD
attribute vec3 cardBox;
#endif
#ifdef WOOD
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
#ifndef PICTURE
  vUv = cardUv;
#endif
#elif defined(ROCKCARD)
  // render/rocks.js rockCardMaterial's card: turned to the eye about the world's up at the rock's mid-height, CARD_PUSH of its depth toward her, its normals leaning out to its rim.
  mat4 cardM = modelMatrix * instanceMatrix;
  vec3 cardC = (cardM * vec4(0.0, cardBox.y, 0.0, 1.0)).xyz;
  vec3 cardD = normalize(cameraPosition - cardC);
  vec3 cardR = cross(vec3(0.0, 1.0, 0.0), cardD);
  cardR = dot(cardR, cardR) > 1e-8 ? normalize(cardR) : vec3(1.0, 0.0, 0.0);
  vec3 cardU = cross(cardD, cardR);
  mat3 cardA = mat3(cardM);
  w = vec4(cardC + cardD * ${CARD_PUSH.toFixed(3)} * length((cardD * cardA) * cardBox) + cardR * position.x * length((cardR * cardA) * cardBox) + cardU * position.y * length((cardU * cardA) * cardBox), 1.0);
  n = (cardR * position.x + cardU * position.y) * ${CARD_ROUND.toFixed(3)} + cardD;
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
#if defined(MUSH) || defined(FOLIAGE) || defined(PICTURE)
  vUv = uvProj;
  vLayer = texLayer;
#endif
#ifdef WOOD
  vUv = uv;
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
#if defined(MUSH) || defined(FOLIAGE) || defined(PICTURE)
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;
varying vec2 vUv;
varying float vLayer;
#endif
#if defined(CARD) && !defined(PICTURE)
uniform sampler2D uCard;
varying vec2 vUv;
#endif
#ifdef WOOD
uniform sampler2D uGrain;
varying vec2 vUv;
#endif
void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
#ifdef STONE
  vec3 albedo = vCol * caveStone(vPos, n);
#ifdef ROCKCARD
  // The boulder's photograph is its silhouette; the stone it wears is the mesh's.
  if (texture(uAtlas, vec3(vUv, vLayer)).a < 0.5) discard;
#elif defined(CARD)
  vec4 card = texture2D(uCard, vUv);
  if (card.a < 0.5) discard;
  albedo *= card.r;
#endif
#elif defined(MUSH)
  // The forest's cap and flesh sheets: the glow is scaled by the sheet's own lightness, so fibres, scales and warts read through it instead of one flat tint.
  vec3 tex = texture(uAtlas, vec3(vUv, vLayer)).rgb;
  vec3 albedo = vCol * tex;
#elif defined(MUSHCARD)
  // The forest mushroom's photograph, its lightness only: the cave's caps wear another sheet.
  vec4 pic = texture(uAtlas, vec3(vUv, vLayer));
  if (pic.a < 0.5) discard;
  vec3 tex = vec3(dot(pic.rgb, vec3(0.2126, 0.7152, 0.0722)));
  vec3 albedo = vCol * tex;
#elif defined(FOLIAGE)
  vec4 leaf = texture(uAtlas, vec3(vUv, vLayer));
  if (leaf.a < 0.5) discard;
  vec3 albedo = vCol * leaf.rgb;
#elif defined(WOOD)
  vec3 albedo = vCol * texture2D(uGrain, vUv).rgb;
#else
  vec3 albedo = vCol;
#endif
  vec3 c = albedo * max(caveTorch(vPos, n) + vGlow * ${GLOW_GAIN.toFixed(2)}, vec3(uLitFloor));
#if defined(MUSH) || defined(MUSHCARD)
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
// The lake's surface (water.js) with a cave for its sky: the lake's ripple layers without the swell, its body tint lit by the torches, its mirror share and its clarity looking down. The reflection is the cave the world probe's two cubes saw, cross-faded, and the torch's glint off the ripple. Opaque from below, as the lake is.
const WATER_FRAG = /* glsl */ `
${COMMON}
${RIPPLE_GLSL}
uniform samplerCube uMirrorA;
uniform samplerCube uMirrorB;
uniform float uMirrorFade;
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
  vec3 body = uTint * max(caveTorch(vPos, n), vec3(uLitFloor));
  if (under) {
    gl_FragColor = vec4(caveFog(body, vPos), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    return;
  }
  vec3 r = reflect(v, n);
  if (r.y < 0.0) r.y = -r.y;
  vec3 refl = mix(texture(uMirrorA, r).rgb, texture(uMirrorB, r).rgb, uMirrorFade) * uReflTint;
  for (int i = 0; i < 4; i++) {
    float s = uTorch[i].w;
    if (s <= 0.0) continue;
    vec3 l = uTorch[i].xyz - vPos;
    refl += uTorchTint[i].rgb * s * pow(max(dot(r, normalize(l)), 0.0), 120.0) * 3.0 / (1.0 + 0.05 * dot(l, l));
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
  vec3 c = vec3(0.78, 0.77, 0.72) * (0.75 + 0.25 * hash(cell + 7.0)) * max(caveTorch(vPos, normalize(vNrm)), vec3(uLitFloor));
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
function caveUniforms(lighting, stone, grain) {
  return {
    uStone: { value: stone },
    uGrain: { value: grain },
    uTorch: lighting.uniforms.uTorch,
    uTorchInvReach: lighting.uniforms.uTorchInvReach,
    uTorchTint: lighting.uniforms.uTorchTint,
    uFogDensity: { value: CAVE_AIR.density },
    uFogColor: { value: new THREE.Color(...CAVE_AIR.color) },
    uLitFloor: { value: 0 },
    uTime: { value: 0 },
    uDay: { value: new THREE.Color() },
  }
}

// A cellar door's geometry, foot at the origin, the cave side +Z: { wood: boards and battens, iron: straps and ring }. Each box's grain runs along its length at WOOD_M a repeat, shifted per box so the boards differ.
function cellarDoor() {
  const { w, h, sunk, boards } = DOOR, wood = [], iron = []
  const box = (a, b, axis, out) => {
    const g = new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]).translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
    const p = g.getAttribute('position'), n = g.getAttribute('normal'), uv = g.getAttribute('uv'), shift = out.length * 0.37
    for (let i = 0; i < p.count; i++) {
      const c = [p.getX(i), p.getY(i), p.getZ(i)], m = [n.getX(i), n.getY(i), n.getZ(i)]
      const across = [0, 1, 2].find((k) => k !== axis && Math.abs(m[k]) < 0.5)
      uv.setXY(i, c[axis] / WOOD_M + shift, c[across] / WOOD_M)
    }
    out.push(g)
  }
  for (let i = 0; i < boards; i++) box([-w / 2 + (w * i) / boards + 0.003, 0.01, -0.05], [-w / 2 + (w * (i + 1)) / boards - 0.003, h - 0.01, 0], 1, wood)
  for (const y of [sunk + 0.35, h - 0.45]) {
    box([-w / 2 + 0.05, y - 0.08, 0], [w / 2 - 0.05, y + 0.08, 0.035], 0, wood)
    box([-w / 2 + 0.02, y - 0.03, 0.035], [w * 0.2, y + 0.03, 0.045], 0, iron)
  }
  iron.push(new THREE.TorusGeometry(0.07, 0.009, 6, 12).translate(w * 0.3, sunk + 0.93, 0.06))
  const merged = { wood: mergeGeometries(wood), iron: mergeGeometries(iron) }
  for (const g of [...wood, ...iron]) g.dispose()
  return merged
}

// The forest's mushroom species at mesh tier `tier` (mushroom-bank.js), capped from the cave sheet, each with a `cap` attribute (1 on the cap) and its built height and spread.
function mushroomGeometries(tier) {
  return mushroomVariants().map((v, i) => {
    const g = buildMushroom({ ...mushroomParams(v, 0xca7e + i * 101, tier), capLayer: LAYER.MUSHROOM_CAP_CAVE })
    const layer = g.getAttribute('texLayer').array
    g.setAttribute('cap', new THREE.BufferAttribute(Float32Array.from(layer, (l) => (l === LAYER.MUSHROOM_CAP_CAVE ? 1 : 0)), 1))
    return { geometry: g, height: g.userData.mushroom.height, spread: g.userData.mushroom.spread }
  })
}

// A species' far card: a quad standing on its foot, `ext` (impostor.js impostorCardExtents) across and up, showing atlas `layer` top row first.
function mushroomCard(ext, layer) {
  const hw = ext.width / 2, g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-hw, 0, 0, hw, 0, 0, hw, ext.height, 0, -hw, ext.height, 0], 3))
  g.setAttribute('uvProj', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2))
  g.setAttribute('texLayer', new THREE.Float32BufferAttribute([layer, layer, layer, layer], 1))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}

// Every dripstone is the one seed /gen-stalagmite picked, varied by its row's yaw, lean and scale.
const DRIP_VARIANTS = 1
const DRIP_SEED = 150552
// Past DRIP_NEAR metres a dripstone is its card; every prop ladder is re-picked each time her eye moves DRIP_STEP or her region changes.
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

// Stones this many metres across and up are the world's boulder on its LOD ladder (props/rock.js), and smaller ones litter.js's pebble on its reach. The fraction of a boulder's height bedded under the floor, as render/boulders.js beds a village's.
const BOULDER_FROM = 1
const BOULDER_SINK = 0.4
// Stones share their rock's colour and light sampled once per cell this many metres wide: a rockAt per pebble is most of a second on a big system.
const STONE_LIT_M = 2
// A pebble's shape and keep rolls, off its one seed.
const roll = (seed, k) => (seed * k) % 1

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpQ2 = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpP = new THREE.Vector3()
const tmpS = new THREE.Vector3()
const tmpV = new THREE.Vector3()
const rockOut = new Float32Array(ROCK_AT)
// How far from her eye (m) a water vertex may be for the probe to capture over it; with none that near it captures nothing.
const MIRROR_REACH = 30

export class CaveRoom {
  /** `plan` from planCave, `oy` the cave's world height, `lighting` the WorldLighting whose torches light it, `stone` the boulders' tile (rocks/stone.png, repeating, sRGB), `grain` the interiors' wood grain (repeating, sRGB) the torches' sticks and the cellar doors wear, `atlas` the props' texture array (textures.js) the mushrooms and ferns wear, `sky` the Sky's uniforms the mouths show. */
  constructor(plan, oy, lighting, stone, grain, atlas, sky) {
    if (!(stone instanceof THREE.Texture)) throw new Error('CaveRoom: needs the stone tile')
    if (!(grain instanceof THREE.Texture)) throw new Error('CaveRoom: needs the wood grain')
    if (!(atlas instanceof THREE.DataArrayTexture)) throw new Error('CaveRoom: needs the props\' texture array')
    if (!sky || !sky.uZenith) throw new Error('CaveRoom: needs the sky\'s uniforms')
    this.plan = plan
    this.everyRegion = new Set(plan.graph.regions.map((_, i) => i))
    this.sky = sky
    // CHUNK cell key -> the lights reaching it, for rockAt at the props.
    this.lightBins = new Map()
    this.oy = oy
    this.group = new THREE.Group()
    this.group.name = 'cave-room'
    this.group.position.y = oy
    this.uniforms = caveUniforms(lighting, stone, grain)
    this.mushUniforms = { ...this.uniforms, uAtlas: { value: atlas } }
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { STONE: '' }, vertexColors: true })
    this.propMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '' }, side: THREE.DoubleSide })
    this.rockMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '' }, side: THREE.DoubleSide })
    this.woodMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', WOOD: '' }, side: THREE.DoubleSide })
    this.mushMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', MUSH: '' }, side: THREE.DoubleSide })
    this.foliageMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', FOLIAGE: '' }, side: THREE.DoubleSide })
    this.cards = dripCards()
    this.dripMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '', DRIP: '' }, side: THREE.DoubleSide })
    this.cardMaterial = new THREE.ShaderMaterial({ uniforms: { ...this.uniforms, uCard: { value: this.cards.texture } }, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '', DRIP: '', CARD: '' }, side: THREE.DoubleSide })
    this.rockCardMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', STONE: '', ROCKCARD: '', PICTURE: '' }, side: THREE.DoubleSide })
    this.mushCardMaterial = new THREE.ShaderMaterial({ uniforms: this.mushUniforms, vertexShader: VERT, fragmentShader: FRAG, defines: { INSTANCED: '', CARD: '', MUSHCARD: '', PICTURE: '' }, side: THREE.DoubleSide })
    // The water's reflection: the lake's cube (world-probe.js), its own per room so the first capture snaps in rather than fading from the last room's. main.js adds what its world probe hides.
    this.probe = new WorldProbe()
    this.probe.setVantage((head, out) => this._vantage(head, out))
    this.waterUniforms = {
      ...this.uniforms, uMirrorA: { value: this.probe.textureA }, uMirrorB: { value: this.probe.textureB }, uMirrorFade: { value: 0 },
      uChop: { value: WATER.chop }, uFlow: { value: WATER.flow }, uTint: { value: new THREE.Color(WATER.tint) }, uMirrorDown: { value: WATER.mirrorDown },
      uReflTint: { value: new THREE.Color(WATER.reflTint).multiplyScalar(WATER.reflDim) },
      uClarity: { value: new THREE.Vector2(WATER.clarity, Math.sin((WATER.clarityAngle * Math.PI) / 180)) },
    }
    this.waterMeshes = []
    // water.js's lake material: sorted with the other see-through things, seen from above until she is under it.
    this.waterMaterial = new THREE.ShaderMaterial({ uniforms: this.waterUniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: WATER.clarity > 0, depthWrite: true })
    this.markMaterial = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: MARK_VERT, fragmentShader: MARK_FRAG, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    // The marks laid (drawChalk), and the strokes being drawn (drawLive).
    this.marks = null
    this.live = null
    // The strokes in `marks`, and how many of them wait on a chunk that has not meshed (redrawn once a second while chunks keep arriving).
    this.marksSrc = []
    this.marksWaiting = 0
    this.marksFresh = false
    this.marksAt = 0
    // key -> { x, y, z (the chunk's centre), surface: tier 0's { pos, index } or null, lods: [per LODS tier, null until it arrives or if empty there, else { id, region } per region: an instance in `rock`] }.
    this.chunks = new Map()
    // Chalk lies on the tier-0 triangles drawn here, not on the field they were cut from.
    this.surface = new Surface((key) => {
      const c = this.chunks.get(key)
      return c === undefined ? null : c.surface
    })
    // Every chunk's rock in one multi-draw. Its instance matrices stay identity: VERT reads modelMatrix only, so a transform set here would cull but not move.
    this.rockUsed = { v: 0, i: 0, mv: 1 << 18, mi: 1 << 19 }
    this.rock = new THREE.BatchedMesh(1024, this.rockUsed.mv, this.rockUsed.mi, this.material)
    this.rock.frustumCulled = false
    this.rock.matrixAutoUpdate = false
    this.group.add(this.rock)
    this.region = plan.graph.nodes[plan.doors[0].node].region
    this.disposables = [this.material, this.propMaterial, this.rockMaterial, this.woodMaterial,this.mushMaterial, this.foliageMaterial, this.dripMaterial, this.cardMaterial, this.rockCardMaterial, this.mushCardMaterial, this.cards.texture, this.waterMaterial, this.markMaterial, this.probe, this.rock]
    this._props(plan.props)
    this._water(plan.waters)
    this.probe.exclude(...this.waterMeshes)
    this.mined = new Set()
    this.veins = new VeinLayer(this.group, this.uniforms, COMMON, veinList(plan))
    this.spiders = new CaveSpiders(this.group, this.uniforms, COMMON, plan, oy)
    this.spiderT = null
    this._mouths(plan.graph)
  }

  // Across the far end of each mouth's flare, the opening: a plane of the hour's sky, or for a cellar its door, lit by the torches like the rock. update() hides a sky plane with the chunk it stands in, or it shows through the culled rock.
  _mouths(graph) {
    const mouths = graph.nodes.filter((n) => n.kind === 'mouth')
    this.skyMaterial = new THREE.ShaderMaterial({ uniforms: { ...this.sky }, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.DoubleSide })
    this.disposables.push(this.skyMaterial)
    this.skies = []
    for (const n of mouths.filter((m) => !m.cellar)) {
      const { end, w, h } = mouthFlare(n)
      const lx = -n.dz * (w + 1.4), lz = n.dx * (w + 1.4), y0 = end.y - 1, y1 = end.y + h + 1.4
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([end.x - lx, y0, end.z - lz, end.x + lx, y0, end.z + lz, end.x + lx, y1, end.z + lz, end.x - lx, y1, end.z - lz], 3))
      g.setIndex([0, 1, 2, 0, 2, 3])
      const mesh = new THREE.Mesh(g, this.skyMaterial)
      this.group.add(mesh)
      this.disposables.push(g)
      const at = (v) => (Math.floor(v / CHUNK) + 0.5) * CHUNK
      this.skies.push({ mesh, region: n.region, x: at(end.x), y: at((y0 + y1) / 2), z: at(end.z) })
    }
    const cellars = mouths.filter((m) => m.cellar), door = cellarDoor()
    // A door wears the light of the rock it is set against: the passage's cap, marched to behind its middle.
    const place = (color) => (n) => {
      const { end } = mouthFlare(n), y = end.y + DOOR.h / 2 - DOOR.sunk
      let s = 0
      while (this.plan.field.at(end.x - n.dx * s, y, end.z - n.dz * s) <= 0) if ((s += 0.05) > 3) throw new Error(`CaveRoom: cellar ${n.i}'s door has no rock behind it`)
      tmpQ.setFromEuler(tmpE.set(0, Math.atan2(n.dx, n.dz), 0))
      tmpM.compose(tmpP.set(end.x, end.y - DOOR.sunk, end.z), tmpQ, tmpS.set(1, 1, 1))
      return { color, lit: this._rock(end.x - n.dx * s, y, end.z - n.dz * s) }
    }
    this._instanced(door.wood, cellars, place(DOOR_WOOD), this.woodMaterial)
    this._instanced(door.iron, cellars, place(DOOR_IRON), this.propMaterial)
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

  /** A chunk from the worker at one LOD: { key, lod, position, normal, color, glow, day, index, parts }, each region's triangles and the vertices they use an instance in `rock`. */
  addChunk(m) {
    const remap = new Int32Array(m.position.length / 3)
    const parts = []
    for (let p = 0; p < m.parts.length; p += 3) {
      const start = m.parts[p + 1], count = m.parts[p + 2]
      remap.fill(-1)
      const index = new Uint32Array(count), from = []
      for (let t = 0; t < count; t++) {
        const s = m.index[start + t]
        if (remap[s] < 0) { remap[s] = from.length; from.push(s) }
        index[t] = remap[s]
      }
      const g = new THREE.BufferGeometry()
      for (const [k, size] of [['position', 3], ['normal', 3], ['color', 3], ['glow', 3], ['day', 1]]) {
        const src = m[k], out = new Float32Array(from.length * size)
        for (let v = 0; v < from.length; v++) for (let c = 0; c < size; c++) out[v * size + c] = src[from[v] * size + c]
        g.setAttribute(k, new THREE.BufferAttribute(out, size))
      }
      g.setIndex(new THREE.BufferAttribute(index, 1))
      parts.push({ id: this._addRock(g, from.length, count), region: m.parts[p] })
    }
    const [i, j, k] = m.key.split(',').map(Number)
    if (!this.chunks.has(m.key)) this.chunks.set(m.key, { x: (i + 0.5) * CHUNK, y: (j + 0.5) * CHUNK, z: (k + 0.5) * CHUNK, surface: null, lods: LODS.map(() => null) })
    const chunk = this.chunks.get(m.key)
    chunk.lods[m.lod] = parts
    if (m.lod === 0) {
      chunk.surface = { pos: m.position, index: m.index }
      this.surface.drop(m.key)
      this.marksFresh = true
    }
  }

  // Geometry `g` (`v` vertices, `n` indices) as a hidden instance in `rock`, its buffers doubled when full.
  _addRock(g, v, n) {
    const b = this.rock, u = this.rockUsed
    let mv = u.mv, mi = u.mi
    while (u.v + v > mv) mv *= 2
    while (u.i + n > mi) mi *= 2
    if (mv !== u.mv || mi !== u.mi) { b.setGeometrySize(mv, mi); u.mv = mv; u.mi = mi }
    if (b.instanceCount >= b.maxInstanceCount) b.setInstanceCount(b.maxInstanceCount * 2)
    u.v += v
    u.i += n
    const id = b.addInstance(b.addGeometry(g))
    b.setVisibleAt(id, false)
    return id
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

  // Rows (place as _rows) each drawn by one of `rungs`, [geometry, material] pairs, or none, as _repick says: { src, n, meshes }, or null for no rows.
  _picked(rungs, rows, place) {
    if (rows.length === 0) { for (const [g] of rungs) g.dispose(); return null }
    const meshes = rungs.map(([g, material]) => {
      const mesh = new THREE.InstancedMesh(g, material, rows.length)
      for (const k in ROW_ATTRS) g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(rows.length * ROW_ATTRS[k]), ROW_ATTRS[k]))
      mesh.count = 0
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.disposables.push(g)
      return mesh
    })
    return { src: this._rows(rows, place), n: rows.length, meshes }
  }

  // Each row of a _picked set packed into mesh `pick(i, x, y, z)` (an index, or -1 for none), its translation (x, y, z) relative to the cave-local eye.
  _repick(set, ex, ey, ez, pick) {
    if (set === null) return
    const fill = set.meshes.map(() => 0), m = set.src.matrix
    for (let i = 0; i < set.n; i++) {
      const f = pick(i, m[i * 16 + 12] - ex, m[i * 16 + 13] - ey, m[i * 16 + 14] - ez)
      if (f < 0) continue
      const mesh = set.meshes[f], j = fill[f]++
      mesh.instanceMatrix.array.set(m.subarray(i * 16, i * 16 + 16), j * 16)
      for (const k in ROW_ATTRS) {
        const s = ROW_ATTRS[k]
        mesh.geometry.getAttribute(k).array.set(set.src[k].subarray(i * s, i * s + s), j * s)
      }
    }
    set.meshes.forEach((mesh, f) => {
      mesh.count = fill[f]
      mesh.visible = fill[f] > 0
      mesh.instanceMatrix.needsUpdate = true
      for (const k in ROW_ATTRS) mesh.geometry.getAttribute(k).needsUpdate = true
    })
  }

  // The props at cave-local eye (x, y, z) in `shown` regions, re-picked: a dripstone its model within DRIP_NEAR and its card beyond; a boulder on the rock ladder (props/rock.js), leaving a rung one ROCK_LOD_HYSTERESIS further out than it came in, and gone past CULL_M as the rock round it is; a mushroom on the forest's ladder (render/mushrooms.js); a pebble kept at full density inside FULL_RADIUS and thinned by rank as FULL_RADIUS / d past it, out to its own reach, as litter.js keeps the overworld's.
  _pick(x, y, z, shown) {
    for (const set of this.dripSets) this._repick(set, x, y, z, (i, dx, dy, dz) => (dx * dx + dy * dy + dz * dz < DRIP_NEAR * DRIP_NEAR ? 0 : 1))
    this._repick(this.boulderSet, x, y, z, (i, dx, dy, dz) => {
      const m = Math.hypot(dx, dy, dz)
      if (m > CULL_M || !shown.has(this.boulderRegion[i])) return -1
      const d = m / this.boulderSize[i], cur = this.boulderRung[i]
      let r = 0
      while (r < ROCK_LOD_AT.length && d >= ROCK_LOD_AT[r] * (cur <= r ? 1 + ROCK_LOD_HYSTERESIS : 1)) r++
      return (this.boulderRung[i] = r)
    })
    for (const set of this.mushSets) {
      this._repick(set, x, y, z, (i, dx, dy, dz) => {
        if (!shown.has(set.region[i])) return -1
        const r = (set.rung[i] = ladderTier(set.base[i], MUSHROOM_STEPS, MUSHROOM_STEPS.length, Math.hypot(dx, dy, dz), set.rung[i]))
        return r < MUSHROOM_STEPS.length ? r : -1
      })
    }
    this._repick(this.pebbleSet, x, y, z, (i, dx, dy, dz) => {
      const d = Math.hypot(dx, dy, dz)
      return d < this.pebbleReach[i] && this.pebbleRank[i] * d < FULL_RADIUS ? 0 : -1
    })
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
    // The dripstone model in its DRIP_VARIANTS seeds, pointed down for a stalactite and up for a stalagmite, its card the far rung.
    this.dripSets = []
    const drips = (model, card, rows, place) => {
      const s = this._picked([[model, this.dripMaterial], [card, this.cardMaterial]], rows, place)
      if (s !== null) this.dripSets.push(s)
    }
    for (let k = 0; k < DRIP_VARIANTS; k++) {
      const mine = (t) => Math.floor(t.seed * DRIP_VARIANTS) === k
      const model = dripstone(DRIP_SEED + k)
      drips(model, this.cards.quads[k], props.tites.filter(mine), (t) => {
        set(t.x, t.y + 0.1, t.z, t.seed * 40, Math.PI + lean(t.seed), lean(1 - t.seed), t.r, t.len + 0.1, t.r * (0.8 + 0.4 * t.seed))
        return wall(t)
      })
      drips(model.clone(), this.cards.quads[k].clone(), props.mites.filter(mine), (t) => {
        set(t.x, t.y - 0.05, t.z, t.seed * 40, lean(t.seed), lean(1 - t.seed), t.r * 1.4, t.len + 0.05, t.r * (1.2 + 0.4 * t.seed))
        return wall(t)
      })
    }
    this.pickEye = null
    this.pickRegion = null

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

    // Mushrooms: the forest's species grown large, a glowing cap lit from within. Each species is one set on the forest's ladder, its two mesh tiers and then its card, each row's rung measured from its span as mushrooms.js measures one.
    const tiers = [mushroomGeometries(0), mushroomGeometries(1)], variants = mushroomVariants()
    this.mushSets = []
    tiers[0].forEach(({ geometry, height, spread }, species) => {
      const rows = props.mush.filter((m) => Math.floor(m.seed * variants.length) === species)
      const card = mushroomCard(impostorCardExtents({ width: spread, height }), variants[species].impostorLayer)
      const s = this._picked([[geometry, this.mushMaterial], [tiers[1][species].geometry, this.mushMaterial], [card, this.mushCardMaterial]], rows, (m) => {
        tmpS.set(...m.up).normalize()
        tmpQ.setFromUnitVectors(tmpP.set(0, 1, 0), tmpS).multiply(tmpQ2.setFromEuler(tmpE.set(m.lean, m.yaw, 0, 'YXZ')))
        tmpP.set(m.x, m.y, m.z).addScaledVector(tmpS, -0.04)
        const k = m.h / height
        tmpM.compose(tmpP, tmpQ, tmpS.set(k, k, k))
        const lit = this._rock(m.x, m.y, m.z)
        return m.glow ? { color: [0.35, 0.35, 0.35], emit: m.glow.map((c) => c * (m.giant ? 0.9 : 0.7)), lit } : { color: [0.7, 0.7, 0.7], lit }
      })
      if (s === null) return
      const span = Math.max(height, spread)
      s.region = Int32Array.from(rows, (m) => m.region)
      s.base = Float32Array.from(rows, (m) => distAt((span * m.h) / height, LOD_DEG))
      s.rung = new Int8Array(rows.length).fill(MUSHROOM_STEPS.length)
      this.mushSets.push(s)
    })

    // Ruins: blocks, a lintel spanning its gap.
    this._instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), props.ruins, (b) => {
      set(b.x, b.y, b.z, b.yaw, b.tilt, 0, b.span ?? b.w, b.h, b.w)
      return { color: [0.13, 0.12, 0.105], lit: this._rock(b.x, b.y, b.z) }
    })

    // Stones: a boulder row's `y` is 0.3 r under the floor it lies on, a pebble row's the floor. Both wear the rock surface under them, a shade either way, and update() re-picks which are drawn and at what rung. The sample climbs out of rock first: rockAt from inside the wall finds every light shadowed and its AO floored, so the stone goes dark beside a glowing floor.
    const cells = new Map(), field = this.plan.field
    const stoneLit = (x, y0, z, seed) => {
      let y = y0
      while (field.at(x, y, z) > 0 && y < y0 + 3) y += 0.1
      const key = `${Math.floor(x / STONE_LIT_M)},${Math.floor(y / STONE_LIT_M)},${Math.floor(z / STONE_LIT_M)}`
      if (!cells.has(key)) cells.set(key, this._rock(x, y, z).slice())
      const lit = cells.get(key), k = 0.92 + 0.16 * seed
      return { color: [lit[3] * k, lit[4] * k, lit[5] * k], lit }
    }
    const rungs = ROCK_TIERS.map((_, tier) => buildRock({ ...rockParams(), tier }))
    const mm = rungs[0].userData.rock.measured
    const big = props.boulders.filter((b) => 2 * b.r >= BOULDER_FROM)
    this.boulderSet = this._picked([...rungs.map((g) => [g, this.rockMaterial]), [rockCardGeometry(mm, ROCK_IMPOSTOR_LAYERS.boulder, 'spun'), this.rockCardMaterial]], big, (b) => {
      const k = (2 * b.r) / mm.width
      set(b.x, b.y + 0.3 * b.r - BOULDER_SINK * mm.height * k, b.z, b.yaw, 0, 0, k, k, k)
      return stoneLit(b.x, b.y + 0.3 * b.r, b.z, b.seed)
    })
    this.boulderSize = Float32Array.from(big, (b) => (rockLodSize(mm) * 2 * b.r) / mm.width)
    this.boulderRung = new Int8Array(big.length).fill(ROCK_LOD_AT.length)
    this.boulderRegion = Int32Array.from(big, (b) => {
      field.at(b.x, b.y + 0.3 * b.r + 0.5, b.z)
      if (field.owner < 0) throw new Error(`CaveRoom: the boulder at (${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}) is in no prim's reach`)
      return field.prims[field.owner].region
    })
    const pebble = buildPebble(), ph = pebble.userData.rock.measured.height
    const small = [...props.pebbles, ...props.boulders.filter((b) => 2 * b.r < BOULDER_FROM).map((b) => ({ ...b, y: b.y + 0.3 * b.r, s: 2 * b.r }))]
    this.pebbleSet = this._picked([[pebble, this.rockMaterial]], small, (p) => {
      const stretch = STRETCH[0] + roll(p.seed, 7.13) * (STRETCH[1] - STRETCH[0]), flat = FLAT[0] + roll(p.seed, 13.7) * (FLAT[1] - FLAT[0])
      const sink = (SINK[0] + roll(p.seed, 29.3) * (SINK[1] - SINK[0])) * ph * p.s * flat
      set(p.x, p.y - sink, p.z, p.yaw, 0, 0, p.s * stretch, p.s * flat, p.s / stretch)
      return stoneLit(p.x, p.y, p.z, p.seed)
    })
    this.pebbleReach = Float32Array.from(small, (p) => Math.min(PEBBLE_REACH, REACH_SIZES * p.s))
    this.pebbleRank = Float32Array.from(small, (p) => roll(p.seed, 53.1))

    // Wall torches: the overworld's stick (sticks.js) set in the rock from its foot (props.js), lengthened by its buried `out` and wearing the light of the wall where it leaves it, the held torch's flame (wildfire.js) on its tip.
    const tilt = (t) => tmpV.set(t.nx * Math.sin(TORCH_LEAN), Math.cos(TORCH_LEAN), t.nz * Math.sin(TORCH_LEAN))
    const along = (t, s) => tilt(t).multiplyScalar(s).add(tmpP.set(t.x, t.y, t.z))
    const len = (t) => t.out + STICK_M * TORCH_STICK
    this._instanced(buildStickGeometry(), props.torches, (t) => {
      tmpQ.setFromUnitVectors(STICK_TIP_DIR, tilt(t))
      tmpM.compose(along(t, len(t) / 2), tmpQ, tmpS.set(TORCH_STICK, TORCH_STICK, len(t) / STICK_M))
      const wall = along(t, t.out)
      return { color: STICK_TINT, lit: this._rock(wall.x, wall.y, wall.z) }
    }, this.woodMaterial)
    this.flames = null
    if (props.torches.length > 0) {
      this.flames = new TriFlames(props.torches.length, TRI_TORCH)
      // The flame shader skips the model matrix: its feet are in world space, so they take the group's `oy`.
      props.torches.forEach((t, i) => { const p = along(t, len(t)); this.flames.place(i, p.x, p.y + this.oy, p.z, { height: HELD_FLAME.height, radius: HELD_FLAME.radius }) })
      this.group.add(this.flames.group)
      this.disposables.push(this.flames)
    }

    // Chalk: lumps of the same stone, paler and bluer, to be learnt by eye; one picked up anywhere this session (taken.js) lies nowhere.
    this.chalkRows = props.chalk
    this.chalkGone = props.chalk.map((c) => taken.has(CHALK, c.x, c.z))
    this.chalkMesh = this._instanced(new THREE.DodecahedronGeometry(CHALK_R, 0), props.chalk, (c, m, i) => {
      set(c.x, c.y + 0.04, c.z, c.yaw, 0.3, 0.2, ...CHALK_SQUASH)
      if (this.chalkGone[i]) m.makeScale(0, 0, 0)
      return { color: CHALK_STONE }
    })
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
      // Drawn as the rock around it is: with its region, and within CULL_M of her.
      const nodes = this.plan.graph.nodes, e = b.edge === undefined ? null : this.plan.graph.edges[b.edge]
      g.computeBoundingBox()
      mesh.userData = { regions: e === null ? [nodes[b.node].region] : [nodes[e.a].region, nodes[e.b].region], box: g.boundingBox }
      this.group.add(mesh)
      this.waterMeshes.push(mesh)
      this.disposables.push(g)
    }
  }

  /** Veins and gems whose ids are in `mined` are gone from the walls (caves/veins.js); `this.mined` is the set routeFrom reads. */
  setMined(mined) {
    this.mined = mined
    this.veins.setMined(mined)
  }

  /** Chalk lump `i` picked up: gone from the floor. */
  hideChalk(i) {
    this.chalkGone[i] = true
    this.chalkMesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0))
    this.chalkMesh.instanceMatrix.needsUpdate = true
  }

  /** Every stroke on this system's walls, cave-local point lists (caves/chalk.js), in place of the last. */
  drawChalk(strokes) {
    this.marksSrc = strokes
    this.marks = this._ribbon(this.marks, strokes)
    this.marksWaiting = this._skipped
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
    this._skipped = 0
    if (strokes.length === 0) return null
    const r = ribbons(strokes, this.surface)
    this._skipped = r.skipped
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

  /** Each frame: her eye in world metres, whether it is under water, the clock, and whether she is flying (FLY_LIT). */
  update(eye, submerged, t, flying) {
    const fog = submerged ? CAVE_MURK : CAVE_AIR
    this.uniforms.uFogDensity.value = flying && !submerged ? 0 : fog.density
    this.uniforms.uFogColor.value.setRGB(...fog.color)
    this.uniforms.uLitFloor.value = flying ? FLY_LIT : 0
    this.uniforms.uTime.value = t % 1024
    this.spiders.update(this.spiderT === null ? 0 : Math.max(0, Math.min(t - this.spiderT, 0.1)), eye, this.uniforms.uTorch.value)
    this.spiderT = t
    const ly = eye.y - this.oy
    if (this.marksWaiting > 0 && this.marksFresh && t - this.marksAt >= 1) {
      this.marksAt = t
      this.marksFresh = false
      this.drawChalk(this.marksSrc)
    }
    const region = flying ? -1 : this._regionAt(eye.x, ly, eye.z)
    const shown = flying ? this.everyRegion : drawnRegions(this.plan.graph, region)
    for (const c of this.chunks.values()) {
      const d = chunkGap(c, eye.x, ly, eye.z)
      const lod = drawnLod(c.lods, flying ? Math.min(d, CULL_M - 1) : d)
      for (let l = 0; l < LODS.length; l++) {
        if (c.lods[l] === null) continue
        for (const { id, region } of c.lods[l]) this.rock.setVisibleAt(id, l === lod && shown.has(region))
      }
    }
    this.waterMaterial.side = submerged ? THREE.BackSide : THREE.FrontSide
    for (const m of this.waterMeshes) {
      const { regions, box } = m.userData
      m.visible = regions.some((r) => shown.has(r)) && (flying || box.distanceToPoint(tmpP.set(eye.x, ly, eye.z)) < CULL_M)
    }
    for (const s of this.skies) s.mesh.visible = shown.has(s.region) && (flying || chunkGap(s, eye.x, ly, eye.z) < CULL_M)
    if (this.flames !== null) this.flames.update(t, [1, 1, 1])
    const e = this.pickEye
    if (e === null || region !== this.pickRegion || (e.x - eye.x) ** 2 + (e.y - ly) ** 2 + (e.z - eye.z) ** 2 > DRIP_STEP * DRIP_STEP) {
      this.pickEye = { x: eye.x, y: ly, z: eye.z }
      this.pickRegion = region
      this._pick(eye.x, ly, eye.z, shown)
    }
  }

  // The nearest drawn water vertex to world `eye` within MIRROR_REACH, as cave-local { x, y, z }, or null.
  _nearestWater(eye) {
    const ly = eye.y - this.oy
    let best = MIRROR_REACH * MIRROR_REACH, at = null, p = null
    for (const m of this.waterMeshes) {
      if (!m.visible) continue
      const q = m.geometry.getAttribute('position').array
      for (let i = 0; i < q.length; i += 3) {
        const d = (q[i] - eye.x) ** 2 + (q[i + 1] - ly) ** 2 + (q[i + 2] - eye.z) ** 2
        if (d < best) { best = d; at = i; p = q }
      }
    }
    return at === null ? null : { x: p[at], y: p[at + 1], z: p[at + 2] }
  }

  // The probe's capture point at a re-anchor (WorldProbe.setVantage): WORLD_PROBE.height over the nearest water, refused where that is inside rock.
  _vantage(head, out) {
    const w = this._nearestWater(head)
    if (w === null || this.plan.field.at(w.x, w.y + WORLD_PROBE.height, w.z) > 0) return false
    out.set(w.x, w.y + WORLD_PROBE.height + this.oy, w.z)
    return true
  }

  /** Each frame she is above water, after update() and before the frame is drawn: the lake's world probe stepped (a cube a second, cross-faded), while any water is drawn within MIRROR_REACH. `dt` real seconds, `look` her unit view direction. The water is hidden from it; the torches are not, so the wall she lights shows in the ripple. */
  reflect(renderer, scene, eye, dt, look) {
    tmpP.set(eye.x, eye.y - this.oy, eye.z)
    if (!this.waterMeshes.some((m) => m.visible && m.userData.box.distanceToPoint(tmpP) < MIRROR_REACH)) return
    this.probe.update(renderer, scene, eye, null, dt, null, look)
    this.waterUniforms.uMirrorFade.value = this.probe.blend
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.drawChalk([])
    this.drawLive([])
    this.veins.dispose()
    this.spiders.dispose()
    this.group.removeFromParent()
  }
}
