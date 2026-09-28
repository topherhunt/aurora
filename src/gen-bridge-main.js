// The stone bridge bench (gen-bridge.html): one bridge from src/bridges/bridge.js over a river cut between two banks at the plan's road levels, in the real prop material, with a person on the deck and a troll in the water for scale.
import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture } from './preview-stage.js'
import { smoothstep } from './sim/mathx.js'
import { BRIDGE_DEFAULTS, DECOR_KINDS, buildBridge, planBridge } from './bridges/bridge.js'

const SLIDERS = [
  ['span', 3, 60, 0.5, 'bank to bank: the width of water the arches clear'],
  ['road', 2, 6, 0.1, 'clear roadway between the parapets'],
  ['clearance', 1, 7, 0.1, 'water to the underside of the main arch at its crown. A troll is ~3 m'],
  ['bankA', 0.5, 8, 0.1, 'road level on the -x bank, above the water'],
  ['bankB', 0.5, 8, 0.1, 'road level on the +x bank, above the water'],
  ['maxArch', 4, 20, 0.5, 'widest single arch before the span takes another pier'],
  ['pier', 1, 4, 0.1, 'pier width between arches'],
  ['maxGrade', 0.06, 0.35, 0.01, 'steepest ramp allowed; a steeper one lengthens the abutment instead'],
  ['abut', 1, 8, 0.1, 'least abutment on each bank, even when no ramp is needed'],
  ['depth', 0.5, 5, 0.1, 'foundations below the water'],
  ['wallH', 0.4, 1.4, 0.05, 'parapet height above the deck'],
  ['wallT', 0.25, 0.8, 0.05, 'parapet thickness'],
  ['ring', 0.25, 1, 0.05, 'arch ring depth'],
  ['cover', 0.2, 1.5, 0.05, 'masonry between the ring crown and the deck'],
  ['jitter', 0, 2.5, 0.05, 'every irregularity at once. 0 is the drafted bridge'],
  ['stone', 0.5, 2.5, 0.05, 'stone size, as a multiple of the tile the buildings wear'],
  ['detail', 0.3, 1.5, 0.05, 'mesh density'],
]

const params = { ...BRIDGE_DEFAULTS }
let decorPick = 'random'
let spin = false

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const DAY_SKY = new THREE.Color(0x8fb4d8)
const NIGHT_SKY = new THREE.Color(0x0a1220)
scene.background = DAY_SKY.clone()
scene.fog = new THREE.Fog(scene.background, 80, 220)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 600)
camera.position.set(14, 9, 22)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 2, 0)
controls.enableDamping = true
controls.autoRotateSpeed = 0.6

// The world's noon rig, as the building bench uses it.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85)
scene.add(sun, hemi)

const textureArray = buildTextureArray()
const material = createPropMaterial(textureArray, { vertexColors: true })
material.side = THREE.FrontSide
loadImageLayers(textureArray).catch((e) => console.error('bridge bench: image layers', e))

// --- ground, water, roads ------------------------------------------------------

const GROUND = 180
const GSEG = 360
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND / 3, GROUND / 3)
const groundGeo = new THREE.PlaneGeometry(GROUND, GROUND, GSEG, GSEG)
groundGeo.rotateX(-Math.PI / 2)
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }))
const water = new THREE.Mesh(new THREE.PlaneGeometry(1, GROUND).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2c5566, transparent: true, opacity: 0.82 }))
const roadMat = new THREE.MeshLambertMaterial({ color: 0x6b5a44 })
const roads = [new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), roadMat), new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), roadMat)]
const terrain = new THREE.Group()
terrain.add(ground, water, ...roads)
scene.add(terrain)

const BED = -1.4
/** Banks at each side's road level, a channel between the abutments, a little roll away from the road. */
function groundAt(x, z, plan) {
  const h = plan.o.span / 2
  const bank = x < 0 ? plan.o.bankA : plan.o.bankB
  const roll = 0.35 * Math.sin(x * 0.11 + 1.3) * Math.sin(z * 0.09) * smoothstep(3, 10, Math.abs(z))
  const edge = h - Math.abs(x)
  if (edge <= 0) return bank - 0.04 + roll * smoothstep(0, 6, -edge)
  return bank - 0.04 + (BED - bank) * smoothstep(0, 2.2, edge)
}

function shapeTerrain(plan) {
  const pos = groundGeo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundAt(pos.getX(i), pos.getZ(i), plan))
  pos.needsUpdate = true
  groundGeo.computeVertexNormals()
  water.scale.x = plan.o.span + 1
  const roadLen = 40
  roads[0].scale.set(roadLen, 1, plan.o.road)
  roads[0].position.set(plan.xa - roadLen / 2 + 0.3, plan.o.bankA + 0.01, 0)
  roads[1].scale.set(roadLen, 1, plan.o.road)
  roads[1].position.set(plan.xb + roadLen / 2 - 0.3, plan.o.bankB + 0.01, 0)
}

// --- figures, sockets, lights -----------------------------------------------------

function figure(height, color) {
  const g = new THREE.Group()
  const mat = new THREE.MeshLambertMaterial({ color })
  const r = height * 0.11
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, height * 0.6, 4, 10), mat)
  body.position.y = r + height * 0.3
  const head = new THREE.Mesh(new THREE.SphereGeometry(height * 0.07, 12, 8), mat)
  head.position.y = height * 0.93
  g.add(body, head)
  return g
}
const person = figure(1.75, 0x4a7fbf)
const troll = figure(3.0, 0x6d7a55)
const figures = new THREE.Group()
figures.add(person, troll)
scene.add(figures)

const socketGroup = new THREE.Group()
socketGroup.visible = false
scene.add(socketGroup)
const socketMat = new THREE.MeshBasicMaterial({ color: 0xff3fd0, depthTest: false })
const socketGeo = new THREE.SphereGeometry(0.07, 10, 6)

const flameGroup = new THREE.Group()
scene.add(flameGroup)
const flameGeo = new THREE.SphereGeometry(0.07, 10, 8)
const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb450 })
const MAX_LIGHTS = 8

// --- build ------------------------------------------------------------------------

let mesh = null
let current = null
let night = false

function rebuild() {
  const plan = planBridge(params)
  const built = buildBridge(plan, { decor: decorPick })
  if (mesh) { mesh.geometry.dispose(); scene.remove(mesh) }
  mesh = new THREE.Mesh(built.geometry, material)
  scene.add(mesh)
  current = { plan, built }
  shapeTerrain(plan)

  person.position.set(0.4, plan.deckAt(0.4, 0.5), 0.5)
  const main = plan.arches.reduce((a, b) => (b.a > a.a ? b : a))
  troll.position.set(main.cx, BED, 0)

  socketGroup.clear()
  for (const s of built.sockets) {
    const dot = new THREE.Mesh(socketGeo, socketMat)
    dot.position.fromArray(s.p)
    dot.renderOrder = 10
    socketGroup.add(dot)
  }
  for (const c of [...flameGroup.children]) { flameGroup.remove(c); if (c.isPointLight) c.dispose() }
  built.lights.forEach((l, i) => {
    const f = new THREE.Mesh(flameGeo, flameMat)
    f.position.fromArray(l.p)
    f.scale.setScalar(l.kind === 'fire' ? 1.8 : 1)
    flameGroup.add(f)
    if (i < MAX_LIGHTS) {
      const pl = new THREE.PointLight(0xffa850, 0, 9, 1.6)
      pl.position.fromArray(l.p)
      flameGroup.add(pl)
    }
  })
  applyNight()
  renderStats()
}

function applyNight() {
  sun.intensity = night ? 0.12 : 2.1
  hemi.intensity = night ? 0.12 : 0.85
  scene.background.copy(night ? NIGHT_SKY : DAY_SKY)
  scene.fog.color.copy(scene.background)
  flameMat.color.set(night ? 0xffc060 : 0xb88040)
  for (const c of flameGroup.children) if (c.isPointLight) c.intensity = night ? 6 : 0
}

function renderStats() {
  const { plan, built } = current
  const rows = [
    ['arches', plan.arches.map((a) => (2 * a.a).toFixed(1)).join(' / ') + ' m'],
    ['crowns', plan.arches.map((a) => a.crown.toFixed(2)).join(' / ') + ' m'],
    ['length', `${(plan.xb - plan.xa).toFixed(1)} m`],
    ['deck top', `${plan.top.toFixed(2)} m`],
    ['ramps', `${plan.rampA.toFixed(1)} / ${plan.rampB.toFixed(1)} m`],
    ['max grade', `${(plan.grade * 100).toFixed(1)} %`],
    ['posts', built.sockets.map((s) => s.decor).join(', ')],
    ['triangles', built.stats.triangles.toLocaleString()],
    ['vertices', built.stats.vertices.toLocaleString()],
    ['draw calls', '1'],
  ]
  document.getElementById('statsTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td class="n">${v}</td></tr>`).join('')
}

// --- panel --------------------------------------------------------------------

const sliderBox = document.getElementById('sliders')
const inputs = {}
for (const [key, min, max, step, tip] of SLIDERS) {
  const row = document.createElement('div')
  row.className = `row qa-slider-${key}`
  row.innerHTML = `<label title="${tip}">${key}</label><input type="range" min="${min}" max="${max}" step="${step}"><span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  input.value = params[key]
  out.textContent = params[key]
  input.addEventListener('input', () => { params[key] = Number(input.value); out.textContent = input.value; rebuild() })
  inputs[key] = { input, out }
  sliderBox.appendChild(row)
}
const pierRow = document.createElement('label')
pierRow.className = 'pick qa-pierposts'
pierRow.innerHTML = '<input type="checkbox" checked> posts over the piers'
pierRow.querySelector('input').addEventListener('change', (e) => { params.pierPosts = e.target.checked; rebuild() })
sliderBox.appendChild(pierRow)

const decorSel = document.getElementById('decor')
decorSel.innerHTML = ['random', ...DECOR_KINDS].map((k) => `<option value="${k}">${k === 'random' ? 'post tops: random' : `post tops: ${k}`}</option>`).join('')
decorSel.addEventListener('change', () => { decorPick = decorSel.value; rebuild() })

const seedInput = document.getElementById('seed')
seedInput.addEventListener('change', () => { params.seed = Number(seedInput.value) | 0; rebuild() })
document.getElementById('reroll').addEventListener('click', () => { params.seed += 1; seedInput.value = params.seed; rebuild() })

const toggle = (id, fn) => {
  const b = document.getElementById(id)
  b.addEventListener('click', () => { b.classList.toggle('on'); fn(b.classList.contains('on')) })
}
toggle('night', (on) => { night = on; applyNight() })
toggle('figures', (on) => { figures.visible = on })
toggle('sockets', (on) => { socketGroup.visible = on })
toggle('terrain', (on) => { terrain.visible = on })
toggle('wire', (on) => { material.wireframe = on })
toggle('spin', (on) => { spin = on })
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, BRIDGE_DEFAULTS)
  for (const [key, { input, out }] of Object.entries(inputs)) { input.value = params[key]; out.textContent = params[key] }
  pierRow.querySelector('input').checked = params.pierPosts
  seedInput.value = params.seed
  rebuild()
})

// --- loop -----------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
rebuild()

renderer.setAnimationLoop(() => {
  controls.autoRotate = spin
  controls.update()
  renderer.render(scene, camera)
})
window.bridgeBench = { params, rebuild, camera, controls, get current() { return current } }
