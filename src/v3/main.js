import THREE from '../three-instance.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { SEED, WORLD_SIZE } from '../v2/config.js'
import { Heightmap } from '../v2/height/heightmap.js'
import { V2Height } from '../v2/height/field.js'
import { RELIEF_DEFAULTS } from '../v2/height/relief.js'
// The one knob this page can run with, and it is off until asked for: the
// sheer-face remap, §31 step E. Everything else stays off, because the whole
// point of the page is to judge the GENERATED field rather than what the micro
// stack can add on top of it -- and scarp is not an added term, it is how the
// cliff pass's tabled steps get read, so it does nothing while `cliffs` is off.
const RELIEF_SCARP = Object.freeze({ ...RELIEF_DEFAULTS, scarp: 1 })
import { Layers } from '../v2/layers/layers.js'
import { TerrainV2 } from '../v2/terrain/terrain-v2.js'
import { WaterSurfaces } from '../v2/render/water-surfaces.js'
import { RAISE_SLOPE, RAISE_EYE, RAISE_EYE_LIFT } from '../v2/render/river-raise.js'
import { WorldClock } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { Sky } from '../sky.js'
import { Input } from '../input.js'
import { Player, LOCOMOTION } from '../player.js'
import { buildTextureArray, loadImageLayers } from '../textures.js'
import { setPropClock } from '../material.js'
import { Pines } from './pines.js'
import { load, optionsFromUrl } from './store.js'
import { MACRO, JITTER, TEXELS_PER_NODE } from './island.js'
import { FineJitter } from './fine.js'
import { STEPS, CELL } from './generate.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// /terrain-v3 -- stand on the generated island (§31).
//
// The v2 engine drawing a field that came out of a worker instead of a PNG: the boot is /gen-grass's without the bed, so the only thing being judged is the ground. Anything the 2D map cannot show -- the read of a slope at eye height, how the coast lies against the sea, whether the summit cap is a cap or a whorl -- is what this page is for.
//
// THE LAYER SWITCHES. The sidebar carries one box per rung of the jitter ladder and one per step of the algorithm. Turning one off rebuilds the island without it and stands everything back up on the new field, so what a layer contributes can be read off its absence rather than argued about. Each setting of the BAKED rungs is its own cache slot (store.js), so the second look at a comparison is instant; the read-time rungs are not in the key, because they never reach the image.
//
// THE FIELD IS THE IMAGE PLUS THE LAST RUNGS, and this page is where the two halves are put back together. The island arrives as a 2 m grid carrying the ladder down to 8 m between nodes; `FineJitter` adds the 4, 2 and 1 m rungs per sample. It goes to V2Height as `detail`, where v2's own fitted roughness would otherwise stand, and to the mesh workers as a `{ seed, cell }` descriptor they rebuild it from -- so the ground she is drawn on and the ground she collides with are the same surface. It also puts the coarse read on BILINEAR: a bicubic over a lattice sampled four texels to a node rounds off the very rungs the 2 m image was widened to carry.
//
// THE SUN DOES NOT MOVE. The clock is built at noon and never advanced: a terrain read changes with the light, and a light that is changing under you is a variable nobody asked for. Everything else on the page reads the clock as usual, so the day-night stack is exercised, just held.
// ---------------------------------------------------------------------------

// Hours. Solar noon at CLOCK.latitude, so the ground is lit from as high as this world's sun ever gets and no slope is reading as a shadow.
const HELD_HOUR = 12

const boot = document.getElementById('boot')
const bootLog = document.getElementById('bootlog')
const bootSay = (line) => { bootLog.textContent += `\n${line}` }
const bootFail = (err) => {
  console.error(err)
  boot.classList.remove('gone')
  bootLog.className = 'bad'
  bootLog.textContent += `\n\n/terrain-v3 failed to start\n\n${err && err.stack ? err.stack : err}`
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

// 20000 like the game's: the sky dome is 9000 m out, and from the coast the far shore of the box is 10 km away.
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 20000)
camera.rotation.order = 'YXZ'
const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / Math.max(1, h)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)

const opts = optionsFromUrl(SEED)
const clock = new WorldClock({ seed: opts.seed, hour: HELD_HOUR })
const lighting = new WorldLighting()
const sky = new Sky(scene)

let height = null
let terrain = null
let waterSurfaces = null
let pines = null
let island = null
let from = ''

// What the switches are set to. `octaveOn` shadows JITTER.amps rather than
// zeroing them, so an octave switched off keeps the amplitude it comes back on
// with; `steps` is what the generator runs (generate.js STEPS).
const octaveOn = JITTER.amps.map(() => true)
const steps = { ...STEPS }
let scarpOn = false
const relief = () => (scarpOn ? RELIEF_SCARP : RELIEF_DEFAULTS)
const tuneNow = () => ({ jitter: JITTER.amps.map((a, k) => (octaveOn[k] ? a : 0)), steps })

// --- boot -------------------------------------------------------------------

// The stub water /gen-grass uses: WaterSurfaces wants a material and a group at the origin, and the sea is the one lake in the document. Unlit, because the lake plane it builds carries no normals and a lit material draws it black. Built once and kept across rebuilds; only the surfaces inside it are thrown away.
const water = {
  material: new THREE.MeshBasicMaterial({ color: 0x2b4a66 }),
  group: new THREE.Group(),
}

async function fetchIsland(regen) {
  const loaded = await load({ seed: opts.seed, regen, tune: tuneNow(), log: bootSay })
  island = loaded.result
  from = loaded.from
}

/** The field and everything standing on it. Everything it makes is thrown away by `dropWorld` before it is called again. */
function buildWorld() {
  const heightmap = Heightmap.fromRaw({ width: island.n, height: island.n, data: island.height, meta: island.meta })
  const layers = Layers.deserialize(island.doc)
  // The rungs the image was too coarse to bake, evaluated per sample. Built from the shadowed amplitudes so a read-time rung's switch reaches it, and from the island's own cell so it picks up exactly what splitOctaves left out.
  const fine = { seed: opts.seed, cell: island.cell, jitter: { ...JITTER, amps: tuneNow().jitter } }
  height = new V2Height({ heightmap, layers, seed: opts.seed, relief: relief(), detail: new FineJitter(fine) })

  bootSay('meshing')
  // `axis` is the shipped ground shader; this page judges the field, not the surface, so it draws what the game draws.
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief: relief(), fine, workers: 2, axis: true,
    ground: { size: island.n, world: WORLD_SIZE, classes: island.ground, palette: Float32Array.from(BIOMES.flatMap((b) => b.colour)) },
  })
  lighting.patch(terrain.material, {
    mode: 'fragment', cacheKey: 'v2-terrain-shadow-axis', worldPosVarying: 'vWorldPos',
  })
  waterSurfaces = new WaterSurfaces({ water, layers, field: height })
  waterSurfaces.rebuild()
}

/** The mesh workers and the water geometry, released. `height` and `island` are replaced rather than freed: nothing holds them but this module. */
function dropWorld() {
  waterSurfaces.dispose()
  terrain.dispose()
}

// The one stage of the shipped water shader this page cannot do without: the per-rung lift (src/water.js, river-raise.js). Without it a river is drawn at the level it was solved against the full-detail ground while the terrain under it is drawn at the rung the eye's distance picks, whose vertices sit on the banks and whose chord fills the valley in -- so from the air the network breaks into dashes as the ground eats it. The waves, the flow and the lakes' lap stay out: this page judges the island, not the water.
// A plain Material carries no defaults table, and the sea's plane has none of these attributes.
water.material.defaultAttributeValues = { aRaise: [0, 0, 0, 0], aRaiseFar: [0, 0, 0], aRung: [0], aLake: [0] }
water.material.onBeforeCompile = (shader) => {
  shader.vertexShader = `
    attribute vec4 aRaise;
    attribute vec3 aRaiseFar;
    attribute float aRung;
    attribute float aLake;
  ` + shader.vertexShader.replace('#include <begin_vertex>', `
    #include <begin_vertex>
    {
      float lift = dot( aRaise, max( vec4( 0.0 ), 1.0 - abs( vec4( aRung ) - vec4( 1.0, 2.0, 3.0, 4.0 ) ) ) )
        + dot( aRaiseFar, max( vec3( 0.0 ), 1.0 - abs( vec3( aRung ) - vec3( 5.0, 6.0, 7.0 ) ) ) );
      vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      float plan = length( cameraPosition.xz - wp.xz );
      lift = max( lift, ${RAISE_EYE_LIFT.toFixed(1)} * ( 1.0 - aLake )
        * smoothstep( ${RAISE_EYE[0].toFixed(1)}, ${RAISE_EYE[1].toFixed(1)}, plan ) );
      float sight = ( cameraPosition.y - wp.y ) / max( 1.0, plan );
      transformed.y += lift * smoothstep( ${RAISE_SLOPE[0].toFixed(3)}, ${RAISE_SLOPE[1].toFixed(3)}, sight );
    }
  `)
}
water.group.name = 'terrain-v3-stub-water'
scene.add(water.group)

// What the Player walks on: the field clamped to the sea's surface, and no slope under water so the shore's drowned cliffs cannot refuse her on the sea. `height` is read through the binding, so a rebuild swaps the field under her without touching the Player.
const ground = {
  heightAt: (x, z) => Math.max(0, height.heightAt(x, z)),
  slopeAt: (x, z) => (height.heightAt(x, z) <= 0 ? 0 : height.slopeAt(x, z)),
}

async function bootWorld() {
  bootSay(`island ${opts.seed}${opts.regen ? ', regenerating' : ''}`)
  await fetchIsland(opts.regen)
  buildWorld()

  // The yardstick: a 9 m pine every 50 m. The atlas' images land on their own; the cards are baked, and shown, once they have.
  const propTextures = buildTextureArray()
  pines = new Pines(scene, propTextures, (x, z) => height.heightAt(x, z))
  lighting.patch(pines.material, { mode: 'vertex', cacheKey: 'v3-pine' })
  loadImageLayers(propTextures).then(() => pines.bakeCards(renderer))

  player = new Player(rig, camera, ground)
  const spawn = findSpawn()
  player.spawnAt(spawn.x, spawn.z)
  look.yaw = Math.atan2(spawn.x, spawn.z)
  look.pitch = -0.05
  console.log(`[terrain-v3] spawn ${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)} at ${spawn.y.toFixed(1)} m, island from ${from}`)
  // A handle for the console and the headless probe: `__v3.player.setFlying(true); __v3.rig.position.y = 900; __v3.look.pitch = -0.6`.
  window.__v3 = { rig, camera, look, player, clock, pines, heightOf: () => height }

  boot.classList.add('gone')
  ready = true
}

/**
 * A switch moved: generate the island again without that layer and stand the world back up on it. She keeps where she is (lifted clear if the new ground came up under her) and keeps looking where she was looking, because the whole value of the switch is the before-and-after from one spot. `force` skips the cache, which is what the regen button wants and a switch never does.
 */
let busy = false
async function rebuild(force = false) {
  if (!ready || busy) return
  busy = true
  setSwitches(false)
  bootLog.className = ''
  bootLog.textContent = 'regenerating'
  boot.classList.remove('gone')
  try {
    await fetchIsland(force)
    dropWorld()
    buildWorld()
    // The pines cache a ground height per grid cell; on a new field every one of them is wrong.
    pines.heights.clear()
    pines.last.x = NaN
    const p = rig.position
    p.y = Math.max(p.y, ground.heightAt(p.x, p.z) + LOCOMOTION.eyeHeight)
    boot.classList.add('gone')
    console.log(`[terrain-v3] rebuilt from ${from}, jitter ${island.tune.jitter.join('/')}, steps ${Object.entries(island.tune.steps).filter(([, v]) => v).map(([k]) => k).join(' ') || 'none'}`)
  } catch (err) {
    bootFail(err)
  } finally {
    busy = false
    setSwitches(true)
  }
}

/**
 * A little way inland on the east coast, facing the massif: walk in from the mean coast radius until the ground is dry and gentle.
 */
function findSpawn() {
  for (let r = MACRO.coastRadius + 200; r > 300; r -= 16) {
    const { h, tan } = height.heightAndSlopeAt(r, 0)
    if (h > 6 && tan < 0.35) return { x: r, z: 0, y: h }
  }
  throw new Error('terrain-v3: no dry, gentle ground on the east radius')
}

// --- locomotion --------------------------------------------------------------
//
// The game's own Player (src/player.js): walking with its slope limiter and contour slide, and its survey flight -- space to take off and hold to climb, shift to sink, speed rising with height above the ground, double-tap space to land. The ground it is handed is the island clamped to sea level, so the sea surface is a floor she walks on and cannot fly under.

let ready = false
let player = null
const held = new Set()
const look = { yaw: 0, pitch: -0.15 }
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true, flyDirection: null }

const CODE_ACTIONS = {
  KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right',
  ArrowUp: 'forward', ArrowDown: 'back', ArrowLeft: 'turnLeft', ArrowRight: 'turnRight',
  Space: 'flyUp', ShiftLeft: 'flyDown', ShiftRight: 'flyDown',
  KeyC: 'scarpToggle',
}

// The sheer-face remap, live: it is a read-time relief and not a term in the
// generated field, so it costs a re-mesh and not a regenerate. Both halves of
// the transport are called and neither is optional: `height` is what she
// collides with and the two mesh workers hold their own V2Height, so a relief
// that reaches one and not the others is ground she is not drawn standing on.
// See relief.js. The pines are NOT re-scattered -- scarp is gated to ground far
// too steep for one, so a tree left hanging is a thing to notice rather than a
// bug to hide.
function setScarp(on) {
  if (!ready) return
  scarpOn = on
  height.setRelief(relief())
  terrain.setRelief(relief())
  waterSurfaces.rebuild()
  const p = player.rig.position
  p.y = Math.max(p.y, Math.max(0, height.heightAt(p.x, p.z)))
  swScarp.checked = on
  console.log(`[terrain-v3] scarp ${on ? 'on' : 'off'}`)
}

const DOUBLE_TAP_MS = 320
let lastSpaceTap = -Infinity
function onSpacePress(now) {
  if (now - lastSpaceTap < DOUBLE_TAP_MS) {
    lastSpaceTap = -Infinity
    player.setFlying(false)
    return
  }
  lastSpaceTap = now
  player.setFlying(true)
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return
  const action = CODE_ACTIONS[e.code]
  if (!action) return
  if (action === 'flyUp') e.preventDefault()
  const fresh = !held.has(action)
  held.add(action)
  if (fresh && action === 'flyUp' && player) onSpacePress(e.timeStamp)
  if (fresh && action === 'scarpToggle') setScarp(!scarpOn)
})
addEventListener('keyup', (e) => held.delete(CODE_ACTIONS[e.code]))
addEventListener('blur', () => held.clear())

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

function readInput() {
  const on = (a) => held.has(a)
  if (renderer.xr.isPresenting) {
    const state = input.update()
    const [rx, ry] = state.connected ? state.right.axes : [0, 0]
    moveInput.move = -ry
    moveInput.strafe = 0
    moveInput.lift = 0
    moveInput.turn = rx
    moveInput.instant = false
    return
  }
  moveInput.move = (on('forward') ? 1 : 0) - (on('back') ? 1 : 0)
  moveInput.strafe = (on('right') ? 1 : 0) - (on('left') ? 1 : 0)
  moveInput.lift = (on('flyUp') ? 1 : 0) - (on('flyDown') ? 1 : 0)
  moveInput.turn = (on('turnRight') ? 1 : 0) - (on('turnLeft') ? 1 : 0)
  moveInput.instant = true
  camera.rotation.set(look.pitch, look.yaw, 0)
  camera.position.set(0, LOCOMOTION.eyeHeight, 0)
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

  readInput()
  player.update(dt, moveInput)

  // The clock is never advanced (see THE SUN DOES NOT MOVE): the state is the same one every frame, read rather than stepped so the lighting, sky and fog stacks run exactly as they do in the game.
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
  // The near plane climbs with height above the ground: depth precision at range goes as d² / near, and at 0.1 m the sea plane and the shelf fight each other a kilometre out. Stepped in quarter metres so XR is not handed a new render state every frame.
  const agl = _head.y - Math.max(0, height.heightAt(_head.x, _head.z))
  const near = Math.max(0.1, Math.min(8, Math.round(agl / 25) / 4))
  if (near !== camera.near) {
    camera.near = near
    camera.updateProjectionMatrix()
  }
  sky.update(_head, state)
  terrain.update({ x: _head.x, y: _head.y, z: _head.z, yaw: look.yaw })
  // After the terrain has chosen its render set, never before: this reads the rung of the chunk drawn under each river sample, which is what lifts the ribbon clear of the coarse ground it would otherwise sink into, and switches the ribbon to its coarse index. It returns at once unless the eye has moved or the terrain re-split.
  waterSurfaces.updateLod(_head.x, _head.z, terrain)
  setPropClock(now / 1000)
  pines.update(_head)

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

const islandEl = document.getElementById('island')
const frameEl = document.getElementById('frame')
const rows = (el, list) => {
  el.innerHTML = list.map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls || ''}">${v}</td></tr>`).join('')
}

function refreshPanel() {
  const s = island.stats
  const { h, tan } = height.heightAndSlopeAt(rig.position.x, rig.position.z)
  rows(islandEl, [
    ['seed', `${island.seed} (${island.v})`],
    ['from', from, from === 'cache' ? 'ok' : 'warn'],
    ['generated in', `${island.ms.toFixed(0)} ms`],
    ['land', `${(s.landFraction * 100).toFixed(1)}%`],
    ['summit', `${s.summit.h.toFixed(0)} m`],
    ['sea at the edge', `${s.seaFloor.boxEdge.toFixed(0)} m`],
    ['here', `${rig.position.x.toFixed(0)}, ${rig.position.z.toFixed(0)}`],
    ['ground', `${h.toFixed(1)} m, ${((Math.atan(tan) * 180) / Math.PI).toFixed(0)}&deg;`],
    ['mode', player.flying ? `fly, ${(rig.position.y - Math.max(0, h)).toFixed(0)} m up` : player.blocked ? 'walk, blocked' : 'walk'],
    ['speed', `${player.speed.toFixed(1)} m/s`],
  ])
  rows(frameEl, [
    ['fps', fps ? fps.toFixed(0) : '--', fps >= 58 ? 'ok' : fps >= 40 ? 'warn' : 'bad'],
    ['main thread', `${frameMs.toFixed(2)} ms`],
    ['sun held at', clock.clockText],
    ['pines lod0/1/card', `${pines.drawn[0]} / ${pines.drawn[1]} / ${pines.drawn[2]}`],
  ])
}

// --- the switches -------------------------------------------------------------
//
// One box per layer. An octave's box drops that octave's amplitude to zero and regenerates; a step's box takes the step out of the pipeline. The cache key carries all of it (store.js), so the second visit to any combination comes back from IndexedDB in a frame.

const elSwitches = document.getElementById('switches')
const allSwitches = []

function addSwitch(key, label, title, on, onChange) {
  const l = document.createElement('label')
  l.className = 'sw'
  l.title = title
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.id = `qa-sw-${key}`
  box.checked = on
  box.addEventListener('change', () => onChange(box.checked))
  const text = document.createElement('span')
  text.textContent = label
  l.append(box, text)
  elSwitches.appendChild(l)
  allSwitches.push(box)
  return box
}

const setSwitches = (enabled) => { for (const b of allSwitches) b.disabled = !enabled }

JITTER.amps.forEach((amp, k) => {
  const spacing = JITTER.start / 2 ** k
  // Which half of the ladder this rung is on, which is the grid's decision and not the rung's (island.js splitOctaves). A baked rung means a new image; a read-time one is re-evaluated as the world is stood back up.
  const baked = spacing >= TEXELS_PER_NODE * CELL
  addSwitch(`jitter${spacing}`, `jitter ${spacing} m, +-${amp} m${baked ? '' : ' (read-time)'}`,
    `Rung ${k + 1} of the ladder: a lattice of nodes ${spacing} m apart, each moved up or down by up to ${amp} m. ` +
    (baked ? `Baked into the ${CELL} m image, which holds ${TEXELS_PER_NODE} samples to a node here.` : `Under the image's floor of ${TEXELS_PER_NODE * CELL} m, so it is evaluated per sample at read time (fine.js) and costs no regenerate.`),
    true, (on) => {
      octaveOn[k] = on
      rebuild()
    })
})
addSwitch('hydrology', 'hydrology', 'The whole of step D: the rain and its cuts, the lakes, the silt, the route and the rivers. Off, the field is the cone and its octaves as rasterised, and the document holds nothing but the sea.', steps.hydrology, (on) => {
  steps.hydrology = on
  rebuild()
})
addSwitch('cliffs', 'cliffs (tabled ladder)', 'The tabling inside step D (cliffs.js): bands of steep ground snapped onto a ladder of benches. Off by default -- a ladder of constant rise reads as striation, and its benches come back as rounded domes.', steps.cliffs, (on) => {
  steps.cliffs = on
  rebuild()
})
// Read-time, so no regenerate: it re-reads the field the mesher already has.
const swScarp = addSwitch('scarp', 'scarp (read-time faces)', 'The sheer-face remap, §31 step E (v2 scarp.js). It stands up the tabled steps the cliff pass wrote, so it does nothing while cliffs are off. Also on C.', scarpOn, setScarp)

// Throw this combination's cached island away and make it again: the button for "I changed the algorithm", not "I changed a switch".
document.getElementById('regen').addEventListener('click', () => rebuild(true))

resize()
bootWorld().catch(bootFail)
