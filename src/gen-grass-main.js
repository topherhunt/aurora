import THREE from './three-instance.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { HEIGHTMAP_URL, HEIGHTMAP_META_URL, SEED } from './v2/config.js'
import { Heightmap } from './v2/height/heightmap.js'
import { V2Height } from './v2/height/field.js'
import { RELIEF_DEFAULTS } from './v2/height/relief.js'
import { Layers } from './v2/layers/layers.js'
import { snowDefaults } from './v2/layers/doc.js'
import { TerrainV2 } from './v2/terrain/terrain-v2.js'
import { WaterSurfaces } from './v2/render/water-surfaces.js'
import * as persist from './v2/edit/persist.js'
import { buildTextureArray } from './textures.js'
import { TerrainTint } from './terrain/terrain-tint.js'
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
// `TerrainTint` in src/terrain/terrain-tint.js.
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
  ['full', 2, 30, 1, 'Full radius F, metres. Density is flat inside it and falls off outside it.'],
  ['cull', 20, 120, 5, 'Draw radius, metres. Nothing is placed past it.'],
  ['falloff', 0.5, 3, 0.1, 'Exponent p in the outside-F law `(F/d)^p`. 1 halves the density every doubling of distance; higher thins the far field faster without ever emptying it.'],
  ['blades', 1, 20, 1, 'Triangles per clump. One triangle is one blade.'],
  ['height', 0.05, 0.8, 0.01, 'Mean blade height in metres.'],
  ['heightVary', 0, 0.6, 0.05, 'Fraction either side of the mean height, per blade.'],
  ['width', 0.005, 0.06, 0.001, 'Blade width at the base, metres. It closes to a point at the tip.'],
  ['clumpRadius', 0.02, 1.2, 0.01, 'How far the feet scatter from the clump centre, metres. Past the clump spacing, neighbouring clumps interleave instead of tiling.'],
  ['lean', 0, 1.2, 0.05, 'Outward splay of the tips, as a fraction of blade height at the rim of the clump.'],
  ['scaleVary', 0, 0.6, 0.05, 'Per-clump size variation, so neighbouring clumps are not clones.'],
  ['sink', 0, 0.15, 0.005, 'Metres of the clump buried, to hide the gap where a coarse chunk chords under the field.'],
  ['normalUp', 0, 1, 0.05, 'How far the blade normal is bent toward straight up. 1 shades every blade in a clump alike, which is what keeps the base matching the ground. Below it the residual tilt splits neighbouring blades between lit and black whenever the sun is low, so turn it down only in daylight.'],
  ['tipGain', 1.05, 3, 0.05, 'Minimum separation between a tip and its own base, as a multiplier. Half the clumps go at least this much lighter and half at least this much darker; nothing is drawn in between, so no tip can match its base.'],
  ['tipVary', 0, 1.5, 0.05, 'How much further than tipGain a clump may go, so the lighter and darker halves are ranges rather than two flat tones.'],
  ['tipWarm', -0.5, 0.5, 0.05, 'Pushes the tip red up and blue down, for sun-bleached ends.'],
  ['windAmp', 0, 0.3, 0.01, 'Wind sway at the tip, metres.'],
  ['windSpeed', 0, 3, 0.1, 'Wind rate.'],
]

const DEFAULTS = {
  // The shipped bed (BLADE_DENSITY and friends in v2/render/grass.js): a mat
  // close in, held to the full radius, then thinned hard so the far field is
  // cheap but not bare. Slide `density` up to see what coverage the frame time
  // would buy -- the bed cost ~1.13 ms at 12/m2 on the headset and 24 cost 10 fps
  // of an 85.
  density: 8,
  full: 6.5,
  cull: 30,
  falloff: 3,
  scaleVary: 0.5,
  // Mirrors createBladeMaterial's own uniform default, so the bench opens on the
  // shipped look. It is tied to BLADE_DEFAULTS.height -- see the note there.
  windAmp: 0.03375,
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
let tint = null

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

// --- the density law ----------------------------------------------------------
//
// `keep = min(1, (F/d)^falloff)`: flat inside the full radius F, then falling
// off with distance at whatever rate the exponent asks for. 1 is the shipped
// law -- density halves every doubling of distance -- and above it the far field
// thins faster without ever emptying, which is the point of the knob: at 2 the
// bed at 4F is a quarter of what the shipped law leaves there, and at 8F a
// sixteenth, but it is never nothing.
//
// The count and the sampler below are the integral of that law over the disc,
// so a `falloff` move re-throws a bed that is right by construction rather than
// one that is thrown too dense and then rejected down.

/** Clumps the law asks for inside F, and outside it, over the whole disc. */
function discCounts(density, F, R, p) {
  const inner = density * Math.PI * F * F
  // The outer integral of density*(F/d)^p over the annulus. p = 2 is the pole
  // where the antiderivative of d^(1-p) turns into a logarithm; every other
  // exponent takes the power form, and the two agree in the limit.
  const outer = Math.abs(p - 2) < 1e-6
    ? density * 2 * Math.PI * F * F * Math.log(R / F)
    : density * 2 * Math.PI * Math.pow(F, p) * (Math.pow(R, 2 - p) - Math.pow(F, 2 - p)) / (2 - p)
  return { inner, outer }
}

/** Inverse CDF of the outer field's radius, so `u` uniform in [0,1) lands on the law. */
function outerRadius(u, F, R, p) {
  if (Math.abs(p - 2) < 1e-6) return F * Math.pow(R / F, u)
  const e = 2 - p
  return Math.pow(Math.pow(F, e) + u * (Math.pow(R, e) - Math.pow(F, e)), 1 / e)
}

const _obj = new THREE.Object3D()
const _col = new THREE.Color()
const _rgb = new Float32Array(3)

/**
 * Throw the whole disc. The radius is IMPORTANCE-SAMPLED against the density
 * law rather than sampled uniformly and rejected: the inner disc is uniform in
 * area, the outer field is drawn from the law's own inverse CDF, and the split
 * between them is by their two integrals. At the defaults that is 1.4k
 * candidates where uniform-then-reject would have needed 30k for the same bed,
 * and the gap widens with every step of `falloff`.
 */
function scatter(cx, cz) {
  if (!bed || !height) return
  const t0 = performance.now()
  const R = params.cull
  const F = Math.min(params.full, R)
  const p = params.falloff
  const rand = mulberry32(Math.floor(cx * 31 + cz * 17) + SEED)

  const counts = discCounts(params.density, F, R, p)
  const want = Math.ceil(counts.inner + counts.outer)
  clamped = want > POOL
  const n = Math.min(want, POOL)
  // Share of the total that lives inside F.
  const inner = counts.inner / (counts.inner + counts.outer)

  const maxSlopeTan = Math.tan((38 * Math.PI) / 180)
  let k = 0
  ringCounts = new Array(ringEdges.length - 1).fill(0)

  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2
    const d = rand() < inner ? F * Math.sqrt(rand()) : outerRadius(rand(), F, R, p)
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

    // THE BASE COLOUR IS THE GROUND'S AS DRAWN -- the chunk mesher's vertex tint
    // carried through the terrain shader's whole colour chain. See the header of
    // src/terrain/terrain-tint.js for what that chain is and why `shade` alone
    // is not it.
    tint.groundAt(_rgb, x, z, h, 1 / Math.hypot(tan, 1), snowLine)
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
  console.log(`[gen-grass] world from ${from}, relief ${bands.min.toFixed(1)}..${bands.max.toFixed(1)} m, snow ${snow.base.toFixed(0)} m`)

  bootSay('meshing &hellip;')
  const atlas = buildTextureArray()
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief: RELIEF_DEFAULTS, workers: 2, atlas,
  })
  lighting.patch(terrain.material, {
    mode: 'fragment', cacheKey: 'v2-terrain-shadow-stone', worldPosVarying: 'vWorldPos',
  })

  // Holds the terrain's live uniform objects BY REFERENCE, so the blades follow
  // the ground when its palette is retuned. 'shader' AND NOT THE DEFAULT: this
  // bench draws the full fragment shader above, where /?quest ships the plain
  // rung, and a bed replaying the wrong one is visibly the wrong green.
  tint = new TerrainTint(terrain.material, layers, bands, 'shader')

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
const SCATTER_KEYS = new Set(['density', 'full', 'cull', 'falloff', 'scaleVary', 'tipGain', 'tipVary'])

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
