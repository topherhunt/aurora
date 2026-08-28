import * as THREE from 'three'
import { Input } from './input.js'
import { Player } from './player.js'
import { XRControls } from './xr-controls.js'

// /questv2 -- the minimal-complexity sibling of /quest.
//
// /quest's whole prop pipeline runs through ONE sampler2DArray texture atlas
// (buildTextureArray/loadImageLayers) and bakes tree-billboard impostors via
// render-to-texture (bakeTreeImpostors) before it ever shows a frame. When
// /quest deployed and hung forever on the Quest 2's loading screen while
// desktop testing never revealed a problem, the standing hypothesis became:
// something in that GPU-bound load-time work (texture array upload, RTT
// baking) either takes far longer or breaks outright on the Adreno 650.
//
// This page is the control group. It imports NOTHING that loads an image,
// builds a texture array, or renders to a texture at boot: trees are cones
// on cylinders, boulders are icosahedra, everything is a flat-colour
// MeshBasicMaterial/MeshLambertMaterial with no `map`.
//
// RESULT: this page hung too, identically to /quest, on the same Quest 2 --
// which rules out the texture-array/baking hypothesis entirely. Since a page
// with literally no textures reproduces the same symptom, the cause is
// something more basic: either an uncaught error/hang in the top-level JS
// this file shares with /quest (renderer/scene/Input/Player/XRControls
// construction -- none of it was ever wrapped in a try/catch), or something
// upstream of our JS running at all (network/TLS/hosting). The
// instrumentation below catches the former; it can't catch the latter.
//
// UPDATE: rearchitected to render immediately and drop #boot right after
// synchronous setup, matching the "render immediately, load progressively"
// pattern Above Par (a known-working, much more complex WebXR site) uses --
// see /quest's src/quest-main.js for the version of this that actually has
// background asset loading to defer. This page never had any, so here it's
// just removing a pointless async wrapper.
const boot = document.getElementById('boot')
const stats = document.getElementById('stats')
const xrButton = document.getElementById('xr')
const fail = (err) => {
  console.error(err)
  boot.classList.remove('gone')
  boot.innerHTML = `<pre>/questv2 failed to start\n\n${err?.stack ?? err}</pre>`
}
addEventListener('error', (e) => fail(e.error ?? e.message ?? 'unknown error'))
addEventListener('unhandledrejection', (e) => fail(e.reason ?? 'unhandled promise rejection'))
let bootStage = 'module executing'
function stage(name) { bootStage = name; if (!boot.classList.contains('gone')) boot.textContent = `${name} ...` }
setTimeout(() => { if (!boot.classList.contains('gone')) fail(new Error(`stuck at stage "${bootStage}" for 12s with no error thrown -- looks like a hang, not a crash`)) }, 12000)

stage('creating WebGL renderer')
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.xr.enabled = true
renderer.xr.setFoveation(1)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x9db4cf)
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, .05, 2000)
camera.position.set(0, 1.6, 0)
camera.rotation.order = 'YXZ'
const rig = new THREE.Group()
rig.add(camera)
scene.add(rig)
const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x34402b, 1.8)
scene.add(hemi)
const sun = new THREE.DirectionalLight(0xfff0d2, 2.2)
sun.position.set(-25, 25, 35.35)
scene.add(sun)

const state = {
  treeCount: 0, boulderCount: 0,
  lit: false, terrain: false, vertices: 64, treeMode: 'individual',
}
const content = new THREE.Group()
scene.add(content)
const panel = new THREE.Group()
panel.position.set(-1.1, 1.6, -2.6)
scene.add(panel)
const panelMeshes = []
const pointer = new THREE.Vector2()
const raycaster = new THREE.Raycaster()
const temp = new THREE.Vector3()
const tempQuat = new THREE.Quaternion()
let frame = 0
let fps = 0
let fpsFrames = 0
let fpsAt = performance.now()
let dragging = false
let lastFrame = performance.now()
const held = new Set()
const input = new Input(renderer)
const terrainHeight = { heightAt: (x, z) => state.terrain ? elevation(x, z) : 0 }
const player = new Player(rig, camera, terrainHeight)
const xrControls = new XRControls(renderer, scene, camera, player, terrainHeight, () => {})
const moveInput = { move: 0, strafe: 0, lift: 0, turn: 0, unstick: false, instant: true }
const lasers = xrControls.controllers.map((controller) => {
  const laser = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x19c7ff, transparent: true, opacity: .9 }))
  laser.frustumCulled = false
  laser.visible = false
  scene.add(laser)
  laser.userData.controller = controller
  return laser
})

// Panel state is shown with COLOUR, not text -- a canvas-to-texture label
// (as /quest uses for its panel) is cheap in practice, but this page's whole
// point is zero texture uploads of any kind, so buttons stay untextured
// flat-colour planes and the two counts + mode are read off the live #stats
// DOM overlay instead.
function panelButton(key, x, y, width, color) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, .18), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }))
  mesh.position.set(x, y, .01); mesh.userData.key = key; panel.add(mesh); panelMeshes.push(mesh); return mesh
}
const panelBg = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.1), new THREE.MeshBasicMaterial({ color: 0x091321, side: THREE.DoubleSide }))
panel.add(panelBg)
panelButton('tree+', -.4, .82, .5, 0x2a7d3a)
panelButton('tree-', .4, .82, .5, 0x7d2a2a)
panelButton('boulder+', -.4, .54, .5, 0x2a7d3a)
panelButton('boulder-', .4, .54, .5, 0x7d2a2a)
const treeModeButton = panelButton('treeMode', 0, .26, 1.1, 0x173154)
const terrainButton = panelButton('terrain', -.4, -.02, .5, 0x173154)
const litButton = panelButton('lighting', .4, -.02, .5, 0x173154)
const treeModeColors = { individual: 0x173154, instanced: 0x5a3a17 }

function hash(x, z) { const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return n - Math.floor(n) }
function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(hash(ix, iz), hash(ix + 1, iz), u), THREE.MathUtils.lerp(hash(ix, iz + 1), hash(ix + 1, iz + 1), u), v)
}
function elevation(x, z) { return (noise(x * .035, z * .035) - .5) * 8 + (noise(x * .14, z * .14) - .5) * 2 }

// One "tree" is a cone crown + cylinder trunk, two meshes in a Group --
// pure procedural geometry built once per placement, never touching an
// image or a render target. One "boulder" is a shared IcosahedronGeometry.
const treeGroup = () => {
  const crown = new THREE.ConeGeometry(.5, 1.4, 7)
  const trunk = new THREE.CylinderGeometry(.08, .12, .8, 6)
  const crownMesh = new THREE.Mesh(crown, treeMaterial())
  crownMesh.material.color.set(0x2f7d3a)
  crownMesh.position.y = 1.1
  const trunkMesh = new THREE.Mesh(trunk, treeMaterial())
  trunkMesh.material.color.set(0x6b4a2f)
  trunkMesh.position.y = .4
  const g = new THREE.Group()
  g.add(crownMesh, trunkMesh)
  g.userData.triangleCount = (crown.attributes.position.count + trunk.attributes.position.count) / 3 * 2 // rough two-sided estimate is fine for a stats readout
  return g
}
function treeMaterial() { return state.lit ? new THREE.MeshLambertMaterial() : new THREE.MeshBasicMaterial() }
function boulderMaterial() { return state.lit ? new THREE.MeshLambertMaterial({ color: 0x8a8a86 }) : new THREE.MeshBasicMaterial({ color: 0x8a8a86 }) }
const boulderGeo = new THREE.IcosahedronGeometry(.6, 0)

function clearContent() {
  while (content.children.length) {
    const o = content.children.pop()
    o.traverse((n) => { if (n.isInstancedMesh) n.dispose(); n.geometry?.dispose(); n.material?.dispose() })
  }
}
function makeTerrain() {
  const material = state.lit ? new THREE.MeshLambertMaterial({ color: 0x5c7a4a, side: THREE.DoubleSide }) : new THREE.MeshBasicMaterial({ color: 0x5c7a4a, side: THREE.DoubleSide })
  if (!state.terrain) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(128, 128), material)
    m.rotation.x = -Math.PI / 2
    return m
  }
  const n = state.vertices, size = 128, positions = [], indices = []
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const px = (x / (n - 1) - .5) * size
      const pz = (z / (n - 1) - .5) * size
      positions.push(px, elevation(px, pz), pz)
    }
  }
  for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) { const a = z * n + x, b = a + 1, c = a + n, d = c + 1; indices.push(a, c, b, b, c, d) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return new THREE.Mesh(g, material)
}
const ARENA_HALF = 30
const PANEL_CLEARANCE = 3
function scatterXZ(i, salt, footprintRadius = 0) {
  const clearance = PANEL_CLEARANCE + footprintRadius
  let x = (hash(i, salt) * 2 - 1) * ARENA_HALF
  let z = (hash(i, salt + 1) * 2 - 1) * ARENA_HALF
  const dx = x - panel.position.x, dz = z - panel.position.z
  const d = Math.hypot(dx, dz)
  if (d < clearance) {
    const a = d > 1e-4 ? Math.atan2(dz, dx) : hash(i, salt + 2) * Math.PI * 2
    x = panel.position.x + Math.cos(a) * clearance
    z = panel.position.z + Math.sin(a) * clearance
  }
  return [x, z]
}
function placeTrees() {
  const placements = []
  for (let i = 0; i < state.treeCount; i++) {
    const [x, z] = scatterXZ(i, 20, .5)
    placements.push({ x, y: terrainHeight.heightAt(x, z), z, rotY: hash(i, 24) * Math.PI * 2 })
  }
  if (!placements.length) return
  if (state.treeMode === 'individual') {
    for (const p of placements) {
      const g = treeGroup()
      g.position.set(p.x, p.y, p.z)
      g.rotation.y = p.rotY
      content.add(g)
    }
    return
  }
  // batched/instanced: crown and trunk each get their own InstancedMesh
  // (two draw calls total, however many trees) -- BatchedMesh isn't needed
  // here since there's only one geometry per part; the comparison this page
  // exists to make is "many draw calls" vs "few", and InstancedMesh already
  // gives that with less code than BatchedMesh would for a single variant.
  const crown = new THREE.ConeGeometry(.5, 1.4, 7)
  const trunk = new THREE.CylinderGeometry(.08, .12, .8, 6)
  const crownMesh = new THREE.InstancedMesh(crown, treeMaterial(), placements.length)
  crownMesh.material.color.set(0x2f7d3a)
  const trunkMesh = new THREE.InstancedMesh(trunk, treeMaterial(), placements.length)
  trunkMesh.material.color.set(0x6b4a2f)
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), pos = new THREE.Vector3(), scale = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4()
  placements.forEach((p, idx) => {
    q.setFromAxisAngle(up, p.rotY)
    pos.set(p.x, p.y + 1.1, p.z)
    crownMesh.setMatrixAt(idx, m4.compose(pos, q, scale))
    pos.set(p.x, p.y + .4, p.z)
    trunkMesh.setMatrixAt(idx, m4.compose(pos, q, scale))
  })
  crownMesh.instanceMatrix.needsUpdate = true
  trunkMesh.instanceMatrix.needsUpdate = true
  crownMesh.userData.triangleCount = (crown.attributes.position.count / 3) * placements.length
  trunkMesh.userData.triangleCount = (trunk.attributes.position.count / 3) * placements.length
  content.add(crownMesh, trunkMesh)
}
function placeBoulders() {
  for (let i = 0; i < state.boulderCount; i++) {
    const [x, z] = scatterXZ(i, 30, .7)
    const m = new THREE.Mesh(boulderGeo, boulderMaterial())
    m.position.set(x, terrainHeight.heightAt(x, z) + .5, z)
    content.add(m)
  }
}
function rebuild() {
  clearContent()
  const terrain = makeTerrain()
  content.add(terrain)
  placeTrees()
  placeBoulders()
  panel.position.y = terrainHeight.heightAt(panel.position.x, panel.position.z) + 1.6
  updatePanel()
  player.smoothY = null
}
function triangles() { let n = 0; content.traverse((o) => { if (o.userData.triangleCount !== undefined) n += o.userData.triangleCount; else if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 }); return n }
function updatePanel() {
  treeModeButton.material.color.set(treeModeColors[state.treeMode])
  terrainButton.material.color.set(state.terrain ? 0x2a7d3a : 0x173154)
  litButton.material.color.set(state.lit ? 0x2a7d3a : 0x173154)
}

const CONTENT_KEYS = new Set(['tree+', 'tree-', 'boulder+', 'boulder-', 'terrain', 'lighting', 'treeMode'])
function activate(key) {
  if (key === 'tree+') state.treeCount = state.treeCount === 0 ? 2 : state.treeCount * 2
  if (key === 'tree-') state.treeCount = state.treeCount <= 1 ? 0 : Math.floor(state.treeCount / 2)
  if (key === 'boulder+') state.boulderCount = state.boulderCount === 0 ? 2 : state.boulderCount * 2
  if (key === 'boulder-') state.boulderCount = state.boulderCount <= 1 ? 0 : Math.floor(state.boulderCount / 2)
  if (key === 'terrain') state.terrain = !state.terrain
  if (key === 'lighting') state.lit = !state.lit
  if (key === 'treeMode') { const modes = ['individual', 'instanced']; state.treeMode = modes[(modes.indexOf(state.treeMode) + 1) % modes.length] }
  if (CONTENT_KEYS.has(key)) rebuild()
}
function clickAt(x, y) { pointer.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(panelMeshes)[0]; if (hit) activate(hit.object.userData.key) }
addEventListener('pointerup', (e) => { if (!renderer.xr.isPresenting) clickAt(e.clientX, e.clientY) })
for (const controller of xrControls.controllers) { controller.addEventListener('select', () => { controller.getWorldPosition(temp); controller.getWorldQuaternion(tempQuat); const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(tempQuat).normalize(); raycaster.set(temp, direction); const hit = raycaster.intersectObjects(panelMeshes)[0]; if (hit) activate(hit.object.userData.key) }) }

const keyActions = { KeyW: 'forward', KeyA: 'left', KeyS: 'back', KeyD: 'right', Space: 'flyUp', ShiftLeft: 'flyDown', ShiftRight: 'flyDown', ArrowLeft: 'turnLeft', ArrowRight: 'turnRight' }
const DOUBLE_TAP_MS = 320
let lastSpaceTap = -Infinity
function onSpacePress(now) {
  if (now - lastSpaceTap < DOUBLE_TAP_MS) { lastSpaceTap = -Infinity; player.setFlying(false); return }
  lastSpaceTap = now
  player.setFlying(true)
}
addEventListener('keydown', (e) => {
  const action = keyActions[e.code]
  if (!action) return
  e.preventDefault()
  if (action === 'flyUp' && !held.has(action)) onSpacePress(e.timeStamp)
  held.add(action)
})
addEventListener('keyup', (e) => { const action = keyActions[e.code]; if (action) held.delete(action) })
addEventListener('blur', () => { held.clear(); dragging = false })
renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 0) dragging = true })
addEventListener('pointermove', (e) => { if (!dragging || renderer.xr.isPresenting) return; camera.rotation.y -= e.movementX * .0026; camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - e.movementY * .0026, -Math.PI / 2.2, Math.PI / 2.2) })
addEventListener('pointerup', () => { dragging = false })

function setStatus(text) {
  const info = renderer.info
  stats.innerHTML = `triangles: ${triangles().toLocaleString()}\nFPS: ${fps}\ndraw calls: ${info.render.calls}\ngeometries: ${info.memory.geometries}  textures: ${info.memory.textures}\ntrees: ${state.treeCount} (${state.treeMode})  boulders: ${state.boulderCount}\nterrain: ${state.terrain ? `${state.vertices}x${state.vertices} Perlin` : '128x128m flat'}  lighting: ${state.lit ? 'on' : 'off'}\n${text}`
}
// See the matching comment in quest-main.js: requestSession must declare
// 'local-floor' (three.js's default XR reference space) or the session can
// be refused and die immediately, tripping a three.js bug that masks the
// real cause as "Cannot read properties of null (reading
// 'cancelAnimationFrame')" -- this was the actual /quest + /questv2 hang.
function createXRButton() { if (!navigator.xr) { xrButton.textContent = 'WebXR unavailable'; setStatus('XR: navigator.xr missing'); return } navigator.xr.isSessionSupported('immersive-vr').then((yes) => { if (!yes) { xrButton.textContent = 'VR unsupported'; setStatus('XR: immersive-vr unsupported'); return } xrButton.disabled = false; xrButton.textContent = 'ENTER VR'; xrButton.onclick = async () => { const started = performance.now(); setStatus('XR: requestSession pending ...'); try { const session = await Promise.race([navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] }), new Promise((_, reject) => setTimeout(() => reject(new Error('requestSession timed out after 10s')), 10000))]); setStatus(`XR: session received in ${Math.round(performance.now() - started)}ms; setSession pending ...`); await renderer.xr.setSession(session); xrButton.textContent = 'EXIT VR'; setStatus('XR: sessionstart'); session.addEventListener('end', () => { xrButton.textContent = 'ENTER VR'; setStatus('XR: session ended') }) } catch (err) { console.error('Quest XR startup', err); setStatus(`XR FAILED: ${err.name ?? 'Error'}: ${err.message ?? err}`); xrButton.textContent = 'RETRY VR' } } }).catch((err) => { xrButton.textContent = 'VR check failed'; setStatus(`XR FAILED: ${err.name}: ${err.message}`) }) }
function resize() { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix() }
addEventListener('resize', resize)

// This page has no async work at all (no images, no texture arrays, no
// render-to-texture baking) -- there's nothing to stream in after first
// paint, so unlike /quest there's no separate background-load step. This is
// just the synchronous setup finishing and #boot coming down immediately.
stage('placing world')
rebuild()
createXRButton()
boot.classList.add('gone')

renderer.setAnimationLoop(() => {
  frame++
  fpsFrames++
  const now = performance.now()
  if (now - fpsAt >= 500) { fps = Math.round((fpsFrames * 1000) / (now - fpsAt)); fpsFrames = 0; fpsAt = now }

  const st = input.update()
  if (renderer.xr.isPresenting) {
    xrControls.update(st)
    moveInput.move = 0; moveInput.strafe = 0; moveInput.lift = 0; moveInput.turn = 0
    moveInput.instant = false
  } else {
    moveInput.move = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0)
    moveInput.strafe = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)
    moveInput.lift = (held.has('flyUp') ? 1 : 0) - (held.has('flyDown') ? 1 : 0)
    moveInput.turn = (held.has('turnRight') ? 1 : 0) - (held.has('turnLeft') ? 1 : 0)
    moveInput.instant = true
  }
  const dt = Math.min(.1, Math.max(0, (now - lastFrame) / 1000))
  player.update(dt, moveInput)
  lastFrame = now

  for (let i = 0; i < lasers.length; i++) {
    const controller = lasers[i].userData.controller
    lasers[i].visible = renderer.xr.isPresenting
    if (renderer.xr.isPresenting) {
      controller.getWorldPosition(temp)
      controller.getWorldQuaternion(tempQuat)
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(tempQuat).normalize()
      lasers[i].geometry.dispose()
      lasers[i].geometry = new THREE.BufferGeometry().setFromPoints([temp.clone(), temp.clone().addScaledVector(direction, 5)])
    }
  }
  setStatus(renderer.xr.isPresenting ? 'XR: presenting' : 'XR: inline')
  renderer.render(scene, camera)
})
