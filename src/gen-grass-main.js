import THREE from './three-instance.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, SEED } from './v2/config.js'
import { Heightmap } from './v2/height/heightmap.js'
import { V2Height } from './v2/height/field.js'
import { RELIEF_DEFAULTS } from './v2/height/relief.js'
import { Layers } from './v2/layers/layers.js'
import { snowDefaults } from './v2/layers/doc.js'
import { TerrainV2 } from './v2/terrain/terrain-v2.js'
import { shade } from './v2/terrain/chunk-mesh-v2.js'
import { WaterSurfaces } from './v2/render/water-surfaces.js'
import * as persist from './v2/edit/persist.js'
import { buildTextureArray } from './textures.js'
import { terrainDetailTextures } from './terrain/grit-texture.js'
import { BLADE_DEFAULTS, bladeTipMul, buildBladeClump, createBladeMaterial } from './props/grass-blades.js'
import { WorldClock } from './clock.js'
import { WorldLighting } from './lighting.js'
import { Sky } from './sky.js'
import { Input } from './input.js'
import { mulberry32 } from './sim/mathx.js'

// ---------------------------------------------------------------------------
// /gen-grass -- can grass be geometry instead of a cutout?
//
// The card bed in src/v2/render/grass.js is fill-bound and not instance-bound:
// measured on a Quest 2 it draws 20.6 full eyes of alpha-tested fragments per
// eye per frame against a tuft texture that is 18.9% opaque, so about four
// fifths of that work is shaded and then discarded -- and the `discard` itself
// costs the draw its low-resolution-Z on a tiled Adreno. The proposal this page
// exists to look at is to stop paying for the empty 81%: ten opaque triangles
// per clump, no texture, no alpha channel, base colour taken from the terrain.
// The long argument is at the top of src/props/grass-blades.js.
//
// WHY IT IS THE REAL WORLD AND NOT A TEST PLANE. The two questions that decide
// this are "how does the density have to fall off with distance" and "does it
// still read as grass on a hillside, in snow, at a road verge, from above" --
// and neither survives being asked on flat ground. So this boots V2Height, the
// authored layers document and TerrainV2's quadtree exactly as /v2 does, and
// the blades take their base colour from the ground they stand on -- the chunk
// mesher's own `shade`, carried through the terrain shader's colour chain by
// `terrainTint` below.
//
// WHAT IS DELIBERATELY SIMPLER THAN /v2:
//   - the scatter is one disc around the camera, re-thrown when you have walked
//     RESCATTER metres, not a tiled camera-following bed with a regrow queue.
//     The distance LAW is the shipped one; the bookkeeping around it is not,
//     and the panel reports what a re-throw costs so the difference is visible.
//   - no trees, rocks, ferns, mushrooms, deadwood, litter, editor or netplay.
//     This page is about one bed and the ground under it.
// ---------------------------------------------------------------------------

const boot = document.getElementById('boot')
const bootSay = (html) => { if (boot) boot.innerHTML = html }
const bootFail = (err) => {
  console.error(err)
  if (boot) {
    boot.classList.remove('gone')
    boot.innerHTML = `<pre>/gen-grass failed to start\n\n${err && err.stack ? err.stack : err}</pre>`
  }
}

// --- renderer ---------------------------------------------------------------

const stage = document.getElementById('stage')

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(1)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.xr.enabled = true
renderer.xr.setFoveation(1.0)
stage.appendChild(renderer.domElement)
document.body.appendChild(VRButton.createButton(renderer))

const FOG_COLOR = 0x9fb4cc
const scene = new THREE.Scene()
scene.background = new THREE.Color(FOG_COLOR)
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00022)

const sun = new THREE.DirectionalLight(0xfff0d8, 2.1)
sun.position.set(0.4, 0.8, 0.3)
scene.add(sun)
const hemi = new THREE.HemisphereLight(0xbfd4ee, 0x2c3140, 0.85)
scene.add(hemi)

const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000)
camera.rotation.order = 'YXZ'
const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)
const EYE = 1.65

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / Math.max(1, h)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)

const clock = new WorldClock({ seed: SEED })
const lighting = new WorldLighting()
const sky = new Sky(scene)

// --- parameters -------------------------------------------------------------
//
// [key, min, max, step, help]. The blade shape half of this is BLADE_DEFAULTS,
// so the model this page is tuning is literally the exported one -- there is no
// second copy of the numbers to drift.

const SLIDERS = [
  ['density', 0.5, 24, 0.5, 'Clumps per square metre inside the full radius. Multiply by `blades` for the number that decides lushness.'],
  ['full', 2, 30, 1, 'Full radius F, metres. Density is flat inside it and falls as F/d outside, so it halves every doubling of distance.'],
  ['cull', 20, 120, 5, 'Draw radius, metres. Nothing is placed past it.'],
  ['blades', 1, 20, 1, 'Triangles per clump. One triangle is one blade.'],
  ['height', 0.05, 0.8, 0.01, 'Mean blade height in metres.'],
  ['heightVary', 0, 0.6, 0.05, 'Fraction either side of the mean height, per blade.'],
  ['width', 0.005, 0.06, 0.001, 'Blade width at the base, metres. It closes to a point at the tip.'],
  ['clumpRadius', 0.02, 1.2, 0.01, 'How far the feet scatter from the clump centre, metres. Past the clump spacing, neighbouring clumps interleave instead of tiling.'],
  ['lean', 0, 1.2, 0.05, 'Outward splay of the tips, as a fraction of blade height at the rim of the clump.'],
  ['scaleVary', 0, 0.6, 0.05, 'Per-clump size variation, so neighbouring clumps are not clones.'],
  ['sink', 0, 0.15, 0.005, 'Metres of the clump buried, to hide the gap where a coarse chunk chords under the field.'],
  ['normalUp', 0, 1, 0.05, 'How far the blade normal is bent toward straight up. 0 is the true face normal, which makes the bed shade like noise.'],
  ['tipGain', 0.3, 2, 0.05, 'Mean tip brightness as a multiplier over the terrain base colour. Under 1 darkens the tips, over 1 lightens them.'],
  ['tipVary', 0, 0.6, 0.05, 'Spread of tip brightness between clumps. Half go lighter and half darker, and no clump lands on 1, so every clump has a gradient.'],
  ['tipWarm', -0.5, 0.5, 0.05, 'Pushes the tip red up and blue down, for sun-bleached ends.'],
  ['windAmp', 0, 0.3, 0.01, 'Wind sway at the tip, metres.'],
  ['windSpeed', 0, 3, 0.1, 'Wind rate.'],
]

const DEFAULTS = {
  density: 6,
  // 8 m, which is the player's own instinct and also where the card bed's fill
  // measurement puts 65% of its cost.
  full: 8,
  cull: 70,
  scaleVary: 0.5,
  windAmp: 0.06,
  windSpeed: 0.9,
  ...BLADE_DEFAULTS,
}
const params = { ...DEFAULTS }

let showGrass = true
let windOn = true
let showTerrain = true
let wireframe = false
let walking = false

// --- the bed ----------------------------------------------------------------
//
// One InstancedMesh, one draw call, allocated once at POOL and driven by
// `.count`. Sized so the default settings have several times the room they
// need; a setting that would overrun it is CLAMPED AND SAID SO in the panel
// rather than quietly drawing a thinner bed than the sliders claim.

const POOL = 200000
const RESCATTER = 8

let bladeGeo = null
let bladeMat = null
let bed = null
let clamped = false

let height = null
let layers = null
let waterSurfaces = null
let terrain = null
let snowBand = 0
let altLo = 0
let altSpan = 1

const scatterCentre = new THREE.Vector3(0, 0, 0)
let scatterMs = 0
let placed = 0
let sampled = 0
const ringEdges = [0, 2, 5, 8, 15, 25, 40, 70, 120]
let ringCounts = new Array(ringEdges.length - 1).fill(0)

// Per-clump tip brightness. It outlives the geometry, because the geometry is
// thrown away and rebuilt every time a shape slider moves and this is not a
// shape: re-attaching it is what keeps `aTipMul` bound across a rebuild, and
// forgetting to would draw every tip at its own foot's colour.
const tipMul = new THREE.InstancedBufferAttribute(new Float32Array(POOL), 1)
tipMul.setUsage(THREE.DynamicDrawUsage)

function rebuildModel() {
  if (bladeGeo) bladeGeo.dispose()
  bladeGeo = buildBladeClump(params, 1)
  bladeGeo.setAttribute('aTipMul', tipMul)
  if (bed) bed.geometry = bladeGeo
}

function rebuildMaterial() {
  const old = bladeMat
  bladeMat = createBladeMaterial({ wind: windOn })
  bladeMat.wireframe = wireframe
  // Per-vertex, like the card bed's: a blade is far smaller than a
  // fragment-rate shadow lookup is worth. Skipping the patch entirely is the
  // visible failure -- the grass would be the one surface the night lift never
  // reaches, and it would glow after sunset.
  lighting.patch(bladeMat, { mode: 'vertex', cacheKey: `gen-grass-blade-${windOn ? 'wind' : 'still'}` })
  if (bed) bed.material = bladeMat
  if (old) old.dispose()
}

function buildBed() {
  bed = new THREE.InstancedMesh(bladeGeo, bladeMat, POOL)
  bed.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  bed.count = 0
  // The bed follows the camera, so its own bounds are meaningless and a frustum
  // test against them would cull the whole thing the moment you walked out of
  // where it was first built.
  bed.frustumCulled = false
  scene.add(bed)
}

// --- what colour the ground actually is ---------------------------------------
//
// `shade` is NOT the answer, and that is the whole reason this block exists. It
// is the terrain's VERTEX TINT -- the colour the chunk mesher writes into the
// attribute -- and the fragment shader in terrain/terrain-material.js then puts
// it through several more stages before anything reaches the eye. Painting a
// blade with `shade` alone gives a clump that is flatly, uniformly the wrong
// colour, most obviously because of the last stage: uGrassTone is (0.45, 0.92,
// 0.45), so every green fragment in the world has its red and its blue halved
// on the way out and a blade that skips it reads grey and waxy beside it.
//
// So this replays the three stages that MOVE THE AVERAGE, on the CPU, per
// clump:
//   1. the region layer, one kilometre per tile, a value swing plus a pull
//      toward dirt at its high end and deep green at its low;
//   2. the mid-range mottle, 137 m per tile and rotated, the same shape with a
//      dry ochre at its high end;
//   3. uGrassTone, the exposure multiply that lands last.
// The amplitudes and the palette are READ LIVE off the terrain's own uniforms,
// so retuning the ground retunes the grass with it. What is duplicated here is
// only the geometry of the thing -- the two tile sizes, the rotation and the
// four thresholds -- which live at MACRO_METRES, MACRO_FINE_METRES and ROT in
// terrain-material.js, and in the two blocks there that read `auroraM.r` and
// `auroraMF.r`. Grep those three names to find what this has to agree with.
//
// WHAT IS DELIBERATELY LEFT OUT, because none of it moves a clump's average:
// the ground photograph is divided by its own mean and so is mean-preserving by
// construction; the grit layers are 11.7 m and 2.3 m per tile, which is finer
// than a clump and averages out under one; and the snow and rock mixes cannot
// fire, because placement already rejects anything within 3 m of the snow line.
//
// It is a handful of array reads and a dozen multiplies per clump, which is
// noise next to the two path queries placement already runs.

const REGION_METRES = 1024
const MOTTLE_METRES = 137

let macroData = null
let macroSize = 0
let tintU = null

/** GLSL smoothstep, including the descending form where e1 < e0. */
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/**
 * The macro field's red channel, bilinear and wrapping -- the same fetch the
 * shader's textureGrad makes, minus the mip selection, which at a metre-scale
 * lookup on a 4 m texel is the full-resolution level anyway.
 */
function macroR(u, v) {
  const s = macroSize
  const px = u * s - 0.5
  const py = v * s - 0.5
  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const fx = px - x0
  const fy = py - y0
  const xa = ((x0 % s) + s) % s
  const ya = ((y0 % s) + s) % s
  const xb = (xa + 1) % s
  const yb = (ya + 1) % s
  const c00 = macroData[(ya * s + xa) * 4]
  const c10 = macroData[(ya * s + xb) * 4]
  const c01 = macroData[(yb * s + xa) * 4]
  const c11 = macroData[(yb * s + xb) * 4]
  const top = c00 + (c10 - c00) * fx
  const bot = c01 + (c11 - c01) * fx
  return (top + (bot - top) * fy) / 255
}

function scaleRGB(rgb, k) {
  rgb[0] *= k; rgb[1] *= k; rgb[2] *= k
}

function mixRGB(rgb, c, k) {
  if (k <= 0) return
  rgb[0] += (c.r - rgb[0]) * k
  rgb[1] += (c.g - rgb[1]) * k
  rgb[2] += (c.b - rgb[2]) * k
}

/**
 * Take a `shade` result to the colour the ground at (x, z) is drawn in. Mutates
 * `rgb` in place; values stay LINEAR throughout, as `shade`'s are.
 */
function terrainTint(rgb, x, z) {
  // How green the vertex tint is, which is the mask every colour stage below is
  // weighted by -- terrain-material.js computes exactly this from vColor.
  const green = smoothstep(0.004, 0.030, rgb[1] - Math.max(rgb[0], rgb[2]))

  const region = macroR(x / REGION_METRES, z / REGION_METRES)
  scaleRGB(rgb, 1 + (region - 0.5) * tintU.uRegionValue.value)
  mixRGB(rgb, tintU.uDirt.value, smoothstep(0.752, 1.0, region) * green * tintU.uRegionTint.value)
  mixRGB(rgb, tintU.uDeep.value, smoothstep(0.285, 0.0, region) * green * tintU.uRegionTint.value)

  // ROT, column-major as GLSL reads mat2( 0.80, 0.60, -0.60, 0.80 ): the two
  // macro fetches share one texture, and turning the fine one keeps its pattern
  // from lining up with the coarse one's.
  const fu = x / MOTTLE_METRES
  const fv = z / MOTTLE_METRES
  const mottle = macroR(0.8 * fu - 0.6 * fv, 0.6 * fu + 0.8 * fv)
  scaleRGB(rgb, 1 + (mottle - 0.5) * tintU.uMacroValue.value)
  mixRGB(rgb, tintU.uDry.value, smoothstep(0.856, 1.0, mottle) * green * tintU.uMacroTint.value)
  mixRGB(rgb, tintU.uDeep.value, smoothstep(0.218, 0.0, mottle) * green * tintU.uMacroTint.value)

  const tone = tintU.uGrassTone.value
  rgb[0] *= 1 + (tone.r - 1) * green
  rgb[1] *= 1 + (tone.g - 1) * green
  rgb[2] *= 1 + (tone.b - 1) * green
}

const _obj = new THREE.Object3D()
const _col = new THREE.Color()
const _rgb = new Float32Array(3)

/**
 * Throw the whole disc. The radius is IMPORTANCE-SAMPLED against the density
 * law rather than sampled uniformly and rejected: the law wants
 * `density * min(1, F/d)` clumps per square metre, which is `2*pi*density*d`
 * per metre of radius inside F and a CONSTANT `2*pi*density*F` outside it. So
 * the outer field is uniform in d, the inner disc is uniform in area, and the
 * split between them is by their totals. At the defaults that is 20k candidates
 * where uniform-then-reject would have needed 92k for the same bed.
 */
function scatter(cx, cz) {
  if (!bed || !height) return
  const t0 = performance.now()
  const R = params.cull
  const F = Math.min(params.full, R)
  const rand = mulberry32(Math.floor(cx * 31 + cz * 17) + SEED)

  // density * pi * F * (2R - F), the integral of the law over the disc.
  const want = Math.ceil(params.density * Math.PI * F * (2 * R - F))
  clamped = want > POOL
  const n = Math.min(want, POOL)
  // Share of the total that lives inside F.
  const inner = F / (2 * R - F)

  const maxSlopeTan = Math.tan((38 * Math.PI) / 180)
  let k = 0
  ringCounts = new Array(ringEdges.length - 1).fill(0)

  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const d = rand() < inner ? F * Math.sqrt(rand()) : F + rand() * (R - F)
    const x = cx + Math.cos(a) * d
    const z = cz + Math.sin(a) * d

    // The card bed's placement rules, in its order: elevation and slope come
    // out of one height query, water is a grid lookup, and the two path queries
    // are the expensive pair and go last. See PLACEMENT in v2/render/grass.js.
    const { h, tan } = height.heightAndSlopeAt(x, z)
    if (h < 20) continue
    if (tan > maxSlopeTan) continue
    if (waterSurfaces.isSubmerged(x, z, h - 0.15)) continue
    const snowLine = height.snowLineAt(x, z)
    if (h > snowLine - 3) continue
    const road = layers.paths.nearest(x, z, 'road')
    if (road && road.dist < road.halfWidth + 0.4) continue
    const river = layers.paths.nearest(x, z, 'river')
    if (river && river.dist < river.halfWidth + 0.4) continue

    _obj.position.set(x, h, z)
    _obj.rotation.set(0, rand() * Math.PI * 2, 0)
    const s = 1 + params.scaleVary * (rand() * 2 - 1)
    _obj.scale.set(s, s, s)
    _obj.updateMatrix()
    bed.setMatrixAt(k, _obj.matrix)

    // THE BASE COLOUR IS THE GROUND'S AS DRAWN. `shade` is the chunk mesher's
    // own vertex tint -- `ny` is the classification normal's Y, which is what it
    // wants and which heightAndSlopeAt's gradient magnitude gives directly --
    // and `terrainTint` then carries it the rest of the way through the terrain
    // shader's colour chain. See the block above it for what that chain is.
    const ny = 1 / Math.hypot(tan, 1)
    shade(h, ny, snowLine, snowBand, layers.flattenAt(x, z), altLo, altSpan, _rgb, 0)
    terrainTint(_rgb, x, z)
    _col.setRGB(_rgb[0], _rgb[1], _rgb[2], THREE.LinearSRGBColorSpace)
    bed.setColorAt(k, _col)
    tipMul.array[k] = bladeTipMul(params, rand)

    for (let r = 0; r < ringCounts.length; r++) {
      if (d >= ringEdges[r] && d < ringEdges[r + 1]) { ringCounts[r]++; break }
    }
    k++
  }

  bed.count = k
  bed.instanceMatrix.needsUpdate = true
  tipMul.needsUpdate = true
  if (bed.instanceColor) bed.instanceColor.needsUpdate = true
  scatterCentre.set(cx, 0, cz)
  placed = k
  sampled = n
  scatterMs = performance.now() - t0
  refreshPanel()
}

function rescatterIfMoved() {
  if (!bed) return
  const dx = rig.position.x - scatterCentre.x
  const dz = rig.position.z - scatterCentre.z
  if (dx * dx + dz * dz > RESCATTER * RESCATTER) scatter(rig.position.x, rig.position.z)
}

// --- boot -------------------------------------------------------------------

async function bootWorld() {
  bootSay(`loading <b>${HEIGHTMAP_URL}</b> &hellip;`)
  const heightmap = await Heightmap.load({ url: HEIGHTMAP_URL, metaUrl: HEIGHTMAP_META_URL })

  height = new V2Height({ heightmap, layers: new Layers(), seed: SEED, relief: RELIEF_DEFAULTS })
  const bands = height.bands

  bootSay('loading <b>world/layers.json</b> &hellip;')
  const snow = snowDefaults(bands)
  const { doc, from } = await persist.loadInitial(snow)
  layers = Layers.deserialize(doc)
  height.setLayers(layers)
  snowBand = layers.snow.band
  altLo = bands.altLo
  altSpan = bands.altSpan
  console.log(`[gen-grass] world from ${from}, relief ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, snow ${snow.base.toFixed(0)} m`)

  bootSay('meshing &hellip;')
  const atlas = buildTextureArray()
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief: RELIEF_DEFAULTS, workers: 2, atlas,
  })
  lighting.patch(terrain.material, {
    mode: 'fragment', cacheKey: 'v2-terrain-shadow-stone', worldPosVarying: 'vWorldPos',
  })

  // The live uniform objects and the field they read, borrowed BY REFERENCE so
  // the blades follow the ground when the terrain palette is retuned. Both
  // sides of the reference are the terrain's; nothing here writes to either.
  tintU = terrain.material.userData.uniforms
  for (const key of ['uRegionValue', 'uRegionTint', 'uMacroValue', 'uMacroTint', 'uDirt', 'uDeep', 'uDry', 'uGrassTone']) {
    if (!tintU[key]) throw new Error(`gen-grass: the terrain material has no ${key}; terrainTint is out of date with terrain-material.js`)
  }
  const macro = terrainDetailTextures().macro
  macroData = macro.image.data
  macroSize = macro.image.width

  // A STUB WATER, NOT src/water.js. WaterSurfaces reads exactly two things off
  // the object it is handed -- `water.material` for the lake and river meshes
  // it builds, and `water.group` to parent them under -- and the real Water
  // additionally wants a SkyProbe and a WorldProbe so it can reflect the aurora
  // and the treeline. None of that is being judged here, and booting it would
  // put two probe render targets in front of the only measurement this page
  // exists to take. What IS needed is honest geometry, because `isSubmerged` is
  // one of the placement rejects. The group must stay at the origin: the real
  // water shader reads `modelMatrix * position` as a world position, so a moved
  // group is a lake in the wrong place the day this is swapped for the real one.
  const water = {
    material: new THREE.MeshLambertMaterial({ color: 0x2b4a66 }),
    group: new THREE.Group(),
  }
  water.group.name = 'gen-grass-stub-water'
  scene.add(water.group)
  waterSurfaces = new WaterSurfaces({ water, layers })
  waterSurfaces.rebuild()

  const spawn = findSpawn(bands)
  rig.position.set(spawn.x, spawn.y + EYE, spawn.z)
  console.log(`[gen-grass] spawn ${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)} at ${spawn.y.toFixed(1)} m`)

  rebuildModel()
  rebuildMaterial()
  buildBed()
  scatter(spawn.x, spawn.z)

  if (boot) boot.classList.add('gone')
  ready = true
}

/**
 * Somewhere green, dry and not steep, near the origin. A cut-down of
 * findSpawnV2 in v2/main.js: this page has no player capsule to fit and no
 * village to avoid, so it only has to land the camera on grass.
 */
function findSpawn(bands) {
  const rand = mulberry32(SEED)
  const R = 700
  let best = null
  for (let i = 0; i < 4000; i++) {
    const a = rand() * Math.PI * 2
    const r = R * Math.sqrt(rand())
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const { h, tan } = height.heightAndSlopeAt(x, z)
    if (h < 25) continue
    if (tan > 0.35) continue
    if (waterSurfaces.isSubmerged(x, z, h - 1)) continue
    if (h > height.snowLineAt(x, z) - 12) continue
    const score = Math.abs(h - bands.p50) / Math.max(1, bands.max - bands.min) + (r / R) * 0.4
    if (best === null || score < best.score) best = { x, z, y: h, score }
  }
  if (best) return best
  throw new Error('gen-grass: no dry, green, walkable spawn within 700 m of the origin')
}

// --- locomotion --------------------------------------------------------------

let ready = false
const keys = new Set()
const look = { yaw: 0, pitch: -0.15 }

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  keys.add(e.code)
})
addEventListener('keyup', (e) => keys.delete(e.code))

renderer.domElement.addEventListener('click', () => {
  const p = renderer.domElement.requestPointerLock()
  if (p && p.catch) p.catch(() => {})
})
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== renderer.domElement) return
  look.yaw -= e.movementX * 0.0022
  look.pitch = Math.max(-1.5, Math.min(1.5, look.pitch - e.movementY * 0.0022))
})

const input = new Input(renderer)
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()

function move(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 34 : 7) * dt
  _fwd.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw))
  _right.set(-_fwd.z, 0, _fwd.x)
  if (keys.has('KeyW')) rig.position.addScaledVector(_fwd, speed)
  if (keys.has('KeyS')) rig.position.addScaledVector(_fwd, -speed)
  if (keys.has('KeyD')) rig.position.addScaledVector(_right, speed)
  if (keys.has('KeyA')) rig.position.addScaledVector(_right, -speed)
  if (!walking) {
    if (keys.has('KeyE') || keys.has('Space')) rig.position.y += speed
    if (keys.has('KeyQ')) rig.position.y -= speed
  }
  if (walking) {
    const { h } = height.heightAndSlopeAt(rig.position.x, rig.position.z)
    rig.position.y = h + EYE
  }
  if (!renderer.xr.isPresenting) {
    camera.rotation.set(look.pitch, look.yaw, 0)
    camera.position.set(0, 0, 0)
  }
}

function moveXR(dt) {
  const state = input.update()
  if (!state.connected) return
  const speed = 5 * dt
  const [rx, ry] = state.right.axes
  if (Math.abs(rx) > 0.15 || Math.abs(ry) > 0.15) {
    camera.getWorldDirection(_fwd)
    _fwd.y = 0
    _fwd.normalize()
    _right.set(-_fwd.z, 0, _fwd.x)
    rig.position.addScaledVector(_fwd, -ry * speed)
    rig.position.addScaledVector(_right, rx * speed)
  }
  if (walking) {
    const { h } = height.heightAndSlopeAt(rig.position.x, rig.position.z)
    rig.position.y = h
  }
}

// --- frame ------------------------------------------------------------------

const _head = new THREE.Vector3()
let last = performance.now()
let frameMs = 0
let fps = 0
let fpsAccum = 0
let fpsFrames = 0
let panelDue = 0

renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (!ready) return

  const t0 = performance.now()

  if (renderer.xr.isPresenting) moveXR(dt)
  else move(dt)

  clock.advance(dt)
  const state = clock.state()
  sun.position.set(state.lightDir.x, state.lightDir.y, state.lightDir.z)
  sun.color.setRGB(state.lightColor[0], state.lightColor[1], state.lightColor[2], THREE.SRGBColorSpace)
  sun.intensity = state.lightIntensity
  hemi.color.setRGB(state.hemiSky[0], state.hemiSky[1], state.hemiSky[2], THREE.SRGBColorSpace)
  hemi.groundColor.setRGB(state.hemiGround[0], state.hemiGround[1], state.hemiGround[2], THREE.SRGBColorSpace)
  hemi.intensity = state.hemiIntensity
  lighting.update(state)
  scene.fog.color.setRGB(state.fog[0], state.fog[1], state.fog[2], THREE.SRGBColorSpace)
  scene.fog.density = state.hazeDensity
  scene.background.copy(scene.fog.color)

  camera.getWorldPosition(_head)
  sky.update(_head, state)

  terrain.update({ x: _head.x, y: _head.y, z: _head.z, yaw: look.yaw })
  rescatterIfMoved()

  if (bladeMat.userData.uniforms) {
    bladeMat.userData.uniforms.uTime.value = now / 1000
    bladeMat.userData.uniforms.uWindAmp.value = params.windAmp
    bladeMat.userData.uniforms.uWindSpeed.value = params.windSpeed
  }

  renderer.render(scene, camera)

  frameMs = performance.now() - t0
  fpsAccum += dt
  fpsFrames++
  if (fpsAccum >= 0.5) {
    fps = fpsFrames / fpsAccum
    fpsAccum = 0
    fpsFrames = 0
  }
  if (now > panelDue) {
    panelDue = now + 250
    refreshPanel()
  }
})

// --- the panel ---------------------------------------------------------------

const frameEl = document.getElementById('frame')
const bedEl = document.getElementById('bed')
const bedNoteEl = document.getElementById('bednote')
const ringsEl = document.getElementById('rings')
const versusEl = document.getElementById('versus')

const fmt = (n) => n.toLocaleString('en-US')
const rows = (el, list) => {
  el.innerHTML = list.map(([k, v, cls]) =>
    `<tr><td class="k">${k}</td><td class="n ${cls || ''}">${v}</td></tr>`).join('')
}

// The card bed, measured -- scripts/check-grass.mjs for the counts, the fill
// probe for the overdraw. Not estimates, and not recomputed here.
const CARD_BED = { instances: 10993, tris: 21986, overdraw: 20.56, opaque: 0.189 }

function refreshPanel() {
  if (!bed) return
  const triPer = Math.round(params.blades)
  const tris = placed * triPer
  const bladesPerM2 = params.density * triPer

  rows(frameEl, [
    ['fps', fps ? fps.toFixed(0) : '--', fps >= 58 ? 'ok' : fps >= 40 ? 'warn' : 'bad'],
    ['main thread', `${frameMs.toFixed(2)} ms`],
    ['last re-scatter', `${scatterMs.toFixed(1)} ms`, scatterMs > 60 ? 'warn' : ''],
    ['re-scatter every', `${RESCATTER} m walked`],
    ['world clock', clock.clockText],
  ])

  rows(bedEl, [
    ['clumps drawn', fmt(placed)],
    ['triangles', fmt(tris), tris > 1000000 ? 'warn' : ''],
    ['triangles per clump', String(triPer)],
    ['blades/m&sup2; inside F', bladesPerM2.toFixed(0)],
    ['candidates thrown', fmt(sampled)],
    ['rejected by placement', `${sampled ? (100 * (1 - placed / sampled)).toFixed(0) : '0'}%`],
    ['draw calls', '1'],
    ['pool', `${fmt(POOL)}${clamped ? ' -- CLAMPED' : ''}`, clamped ? 'bad' : ''],
  ])

  bedNoteEl.innerHTML = clamped
    ? '<em class="bad">The density and radius you have asked for need more instances than the pool holds, so the bed being drawn is thinner than the sliders claim.</em> Lower <em>density</em> or <em>cull</em> to get an honest reading.'
    : 'Placement rejects are the card bed\'s own rules, in its order: under 20 m elevation, over 38&deg; of slope, submerged with 0.15 m of freeboard, within 3 m of the snow line, or within 0.4 m of a road or river verge. A high reject rate means you are standing somewhere the grass genuinely should not be.'

  const rn = []
  for (let r = 0; r < ringCounts.length; r++) {
    const lo = ringEdges[r]
    const hi = ringEdges[r + 1]
    if (lo >= params.cull) break
    const area = Math.PI * (Math.min(hi, params.cull) ** 2 - lo ** 2)
    const perM2 = ringCounts[r] / area
    rn.push(`<tr><td class="k">${lo}-${Math.min(hi, params.cull)} m</td>` +
      `<td class="n">${fmt(ringCounts[r])}</td>` +
      `<td class="n">${(perM2 * triPer).toFixed(1)}</td>` +
      `<td class="n">${fmt(ringCounts[r] * triPer)}</td></tr>`)
  }
  ringsEl.innerHTML =
    '<tr><th>ring</th><th>clumps</th><th>blades/m&sup2;</th><th>tris</th></tr>' + rn.join('')

  rows(versusEl, [
    ['cards, instances', fmt(CARD_BED.instances)],
    ['blades, clumps', fmt(placed)],
    ['cards, triangles', fmt(CARD_BED.tris)],
    ['blades, triangles', fmt(tris), tris > 350000 ? 'warn' : 'ok'],
    ['cards, eyes of fill', `${CARD_BED.overdraw.toFixed(1)}x`, 'bad'],
    ['of which kept', `${(CARD_BED.overdraw * CARD_BED.opaque).toFixed(1)}x`],
    ['blades, alpha tested', 'none', 'ok'],
    ['blades, texture fetches', 'none', 'ok'],
  ])
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}

// Which sliders change the CLUMP and therefore need the geometry rebuilt, and
// which need the disc re-thrown. tipGain and tipVary are in the second set
// rather than the first because tip BRIGHTNESS is per instance now -- it is
// written by the scatter, not baked into the model. Only the wind pair needs
// neither: those ride in uniforms and are picked up on the next frame.
const SHAPE_KEYS = new Set(['blades', 'height', 'heightVary', 'width', 'clumpRadius', 'lean', 'sink', 'normalUp', 'tipWarm'])
const SCATTER_KEYS = new Set(['density', 'full', 'cull', 'scaleVary', 'tipGain', 'tipVary'])

function show(key) {
  const step = SLIDERS.find(([k]) => k === key)[3]
  readouts[key].out.textContent = step >= 1 ? String(params[key]) : Number(params[key]).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

for (const [key, min, max, step, help] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  readouts[key] = { input, out: row.querySelector('.v') }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show(key)
    if (SHAPE_KEYS.has(key)) rebuildModel()
    if (SCATTER_KEYS.has(key)) scatter(rig.position.x, rig.position.z)
    else refreshPanel()
  })
  show(key)
  slidersEl.appendChild(row)
}

function toggle(id, get, set) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
  })
}
toggle('grass', () => showGrass, (v) => { showGrass = v; if (bed) bed.visible = v })
toggle('wind', () => windOn, (v) => { windOn = v; rebuildMaterial() })
toggle('terrain', () => showTerrain, (v) => { showTerrain = v; if (terrain) terrain.batch.visible = v })
toggle('wire', () => wireframe, (v) => { wireframe = v; if (bladeMat) bladeMat.wireframe = v })
toggle('walk', () => walking, (v) => { walking = v })

// A momentary button, not a toggle: one real minute is one in-world hour, so
// the sun sets on you every few minutes whether or not you were looking at the
// grass. Five hours is enough to walk out of a night and back into daylight in
// one press. The whole clock moves, not the wrapped hour, so the aurora's slow
// noise advances with the sun -- see WorldClock.skip.
document.getElementById('skip').addEventListener('click', () => {
  clock.skip(5)
  refreshPanel()
})

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, DEFAULTS)
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    show(key)
  }
  rebuildModel()
  scatter(rig.position.x, rig.position.z)
})

resize()
bootWorld().catch(bootFail)
