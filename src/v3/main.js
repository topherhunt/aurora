import THREE from '../three-instance.js'
import { VRButton } from 'three/addons/webxr/VRButton.js'

import { SEED, WORLD_SIZE } from '../v2/config.js'
import { Heightmap } from '../v2/height/heightmap.js'
import { V2Height } from '../v2/height/field.js'
import { RELIEF_DEFAULTS } from '../v2/height/relief.js'
import { Layers } from '../v2/layers/layers.js'
import { TerrainV2 } from '../v2/terrain/terrain-v2.js'
import { WaterSurfaces } from '../v2/render/water-surfaces.js'
import { WorldClock } from '../clock.js'
import { WorldLighting } from '../lighting.js'
import { Sky } from '../sky.js'
import { Input } from '../input.js'
import { Player, LOCOMOTION } from '../player.js'
import { load, optionsFromUrl } from './store.js'
import { MACRO } from './island.js'
import { BIOMES } from './biomes.js'

// ---------------------------------------------------------------------------
// /terrain-v3 -- stand on the generated island (§31).
//
// The v2 engine drawing a field that came out of a worker instead of a PNG: the boot is /gen-grass's without the bed, so the only thing being judged is the ground. Anything the 2D map cannot show -- the read of a slope at eye height, how the coast lies against the sea, whether the summit cap is a cap or a whorl -- is what this page is for.
// ---------------------------------------------------------------------------

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
const clock = new WorldClock({ seed: opts.seed })
const lighting = new WorldLighting()
const sky = new Sky(scene)

let height = null
let terrain = null
let island = null
let from = ''

// --- boot -------------------------------------------------------------------

async function bootWorld() {
  bootSay(`island ${opts.seed}${opts.regen ? ', regenerating' : ''}`)
  const loaded = await load({ seed: opts.seed, regen: opts.regen, log: bootSay })
  island = loaded.result
  from = loaded.from

  const heightmap = Heightmap.fromRaw({ width: island.n, height: island.n, data: island.height, meta: island.meta })
  const layers = Layers.deserialize(island.doc)
  height = new V2Height({ heightmap, layers, seed: opts.seed, relief: RELIEF_DEFAULTS })

  bootSay('meshing')
  // `axis` is the shipped ground shader; this page judges the field, not the surface, so it draws what the game draws.
  terrain = new TerrainV2(scene, {
    heightmapRaw: heightmap.toRaw(), doc: layers.serialize(), relief: RELIEF_DEFAULTS, workers: 2, axis: true,
    ground: { size: island.n, world: WORLD_SIZE, classes: island.ground, palette: Float32Array.from(BIOMES.flatMap((b) => b.colour)) },
  })
  lighting.patch(terrain.material, {
    mode: 'fragment', cacheKey: 'v2-terrain-shadow-axis', worldPosVarying: 'vWorldPos',
  })

  // The stub water /gen-grass uses: WaterSurfaces wants a material and a group at the origin, and the sea is the one lake in the document. Unlit, because the lake plane it builds carries no normals and a lit material draws it black.
  const water = {
    material: new THREE.MeshBasicMaterial({ color: 0x2b4a66 }),
    group: new THREE.Group(),
  }
  water.group.name = 'terrain-v3-stub-water'
  scene.add(water.group)
  new WaterSurfaces({ water, layers }).rebuild()

  // What the Player walks on: the field clamped to the sea's surface, and no slope under water so the shore's drowned cliffs cannot refuse her on the sea.
  const ground = {
    heightAt: (x, z) => Math.max(0, height.heightAt(x, z)),
    slopeAt: (x, z) => (height.heightAt(x, z) <= 0 ? 0 : height.slopeAt(x, z)),
  }
  player = new Player(rig, camera, ground)
  const spawn = findSpawn()
  player.spawnAt(spawn.x, spawn.z)
  look.yaw = Math.atan2(spawn.x, spawn.z)
  look.pitch = -0.05
  console.log(`[terrain-v3] spawn ${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)} at ${spawn.y.toFixed(1)} m, island from ${from}`)
  // A handle for the console and the headless probe: `__v3.player.setFlying(true); __v3.rig.position.y = 900; __v3.look.pitch = -0.6`.
  window.__v3 = { rig, camera, look, player, height, clock }

  boot.classList.add('gone')
  ready = true
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
  // The near plane climbs with height above the ground: depth precision at range goes as d² / near, and at 0.1 m the sea plane and the shelf fight each other a kilometre out. Stepped in quarter metres so XR is not handed a new render state every frame.
  const agl = _head.y - Math.max(0, height.heightAt(_head.x, _head.z))
  const near = Math.max(0.1, Math.min(8, Math.round(agl / 25) / 4))
  if (near !== camera.near) {
    camera.near = near
    camera.updateProjectionMatrix()
  }
  sky.update(_head, state)
  terrain.update({ x: _head.x, y: _head.y, z: _head.z, yaw: look.yaw })

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
    ['world clock', clock.clockText],
  ])
}

// --- controls ---------------------------------------------------------------

document.getElementById('skip').addEventListener('click', () => clock.skip(5))
document.getElementById('regen').addEventListener('click', () => {
  location.search = `?seed=${opts.seed}&regen`
})

resize()
bootWorld().catch(bootFail)
