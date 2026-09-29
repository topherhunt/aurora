// The leafkin house bench (gen-leafkin-house.html): one house from src/v2/render/house-exterior.js on a grass plane in the real prop material, a 1 m leafkin and her at glade scale beside it, or a lineup of eight seeds at village heights.
import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture } from './preview-stage.js'
import { HOUSE_KINDS, buildHouse, rollHouse } from './v2/render/house-exterior.js'

const SLIDERS = [
  ['height', 3.5, 9.5, 0.05, 'ground to the tallest roof tip; rise sets the actual apex. The village rolls 3.75-9.4; reroll keeps it'],
  ['girth', 0.2, 0.4, 0.005, 'trunk radius at the floor, as a fraction of height'],
  ['trunk', 0.4, 0.7, 0.005, 'trunk top, where the roof sits, as a fraction of height'],
  ['taper', -0.1, 0.3, 0.005, 'how much narrower the trunk is at the top'],
  ['belly', -0.1, 0.2, 0.005, 'bulge at mid height'],
  ['flare', 0, 0.3, 0.01, 'how far the trunk swells out at the ground between the lobes'],
  ['lean', 0, 0.1, 0.002, 'the whole house leans, curving up the trunk'],
  ['lobes', 2, 10, 1, 'buttress lobes at the trunk foot; the first two flank the door'],
  ['lobeReach', 0, 1.4, 0.01, 'how far a lobe juts at the ground, as a fraction of the trunk radius'],
  ['spires', 0, 4, 1, 'splintered shards of the stump through the roof; with crown tower, the first is a hollow tower'],
  ['spireH', 0, 0.3, 0.005, 'how far the spires rise above the roof, as a fraction of height'],
  ['windows', 0, 5, 1, 'round and arched windows on the trunk'],
  ['winSize', 0.15, 0.45, 0.005, 'window radius, metres'],
  ['door', 0.9, 1.5, 0.01, 'door height, metres. A leafkin is 1 m'],
  ['doorWidth', 0.5, 0.95, 0.01, 'door width, metres'],
  ['sill', 0.1, 0.45, 0.01, 'door sill above the ground; the steps make it up'],
  ['overhang', 0, 0.8, 0.01, 'eave overhang past the trunk'],
  ['droop', 0, 0.5, 0.01, 'eave drop below the trunk top'],
  ['rise', 0.3, 1, 0.01, 'roof apex above the trunk top, as a fraction of the way to the full height'],
  ['swell', 0.8, 2.8, 0.01, 'roof profile: near 1 a cone, past 2 a dome'],
  ['lump', 0, 0.35, 0.005, 'lumpiness of the roof mound'],
  ['tilt', 0, 0.4, 0.005, 'how lopsided the eave line runs'],
  ['bend', 0, 0.15, 0.002, 'roof tip bent over, as a fraction of height'],
  ['decor', 0, 1, 0.01, 'how much clutter: fungi, mushrooms, woodpiles, garlands, vines, lanterns'],
  ['jitter', 0, 2.5, 0.05, 'the smooth warp over everything. 0 is the drafted house'],
]

const params = { seed: 1, height: 6 }
let spec = rollHouse(params.seed, params.height)
let spin = false
let lineup = false
let night = false

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
scene.fog = new THREE.Fog(scene.background, 60, 160)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400)
camera.position.set(9, 4.5, 6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 2.4, 0)
controls.enableDamping = true
controls.autoRotateSpeed = 0.6

const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85)
scene.add(sun, hemi)

const textureArray = buildTextureArray()
const material = createPropMaterial(textureArray, { vertexColors: true })
loadImageLayers(textureArray).then(() => { window.__shot = true }).catch((e) => console.error('leafkin house bench: image layers', e))

const glowMap = new THREE.TextureLoader().load('/interiors/window.webp')
glowMap.colorSpace = THREE.SRGBColorSpace
const glowMat = new THREE.MeshBasicMaterial({ map: glowMap, color: 0x6a5a44 })

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: grassTexture(renderer) }))
ground.material.map.repeat.set(60, 60)
scene.add(ground)

function figure(height, color) {
  const g = new THREE.Group()
  const mat = new THREE.MeshLambertMaterial({ color })
  const r = height * 0.13
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(r, height * 0.55, 4, 10), mat)
  body.position.y = r + height * 0.28
  const head = new THREE.Mesh(new THREE.SphereGeometry(height * 0.1, 12, 8), mat)
  head.position.y = height * 0.9
  g.add(body, head)
  return g
}
const leafkin = figure(1.0, 0x8a9a3a)
const her = figure(0.85, 0x4a7fbf)
const figures = new THREE.Group()
figures.add(leafkin, her)
scene.add(figures)

const houseGroup = new THREE.Group()
scene.add(houseGroup)
const flameMat = new THREE.MeshBasicMaterial({ color: 0xffb450 })
const flameGeo = new THREE.SphereGeometry(0.05, 8, 6)
const MAX_LIGHTS = 10

// --- build ------------------------------------------------------------------------

let current = null

function clearHouses() {
  for (const c of [...houseGroup.children]) {
    houseGroup.remove(c)
    c.traverse((n) => { if (n.isMesh && n.geometry !== flameGeo) n.geometry.dispose(); if (n.isPointLight) n.dispose() })
  }
}

function place(built, x, z, yaw) {
  const g = new THREE.Group()
  g.add(new THREE.Mesh(built.geometry, material), new THREE.Mesh(built.glow, glowMat))
  built.lights.forEach((l, i) => {
    if (l.kind === 'lantern') { const f = new THREE.Mesh(flameGeo, flameMat); f.position.fromArray(l.p); g.add(f) }
    if (i < MAX_LIGHTS) {
      const pl = new THREE.PointLight(0xffa850, 0, l.kind === 'window' ? 4 : 6, 1.6)
      pl.position.fromArray(l.p)
      g.add(pl)
    }
  })
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  houseGroup.add(g)
}

function rebuild() {
  clearHouses()
  if (lineup) {
    const houses = []
    let ms = 0
    for (let k = 0; k < 8; k++) {
      const h = 3.75 + ((k * 0.618 + params.seed * 0.31) % 1) * (9.4 - 3.75)
      const b = buildHouse(rollHouse(params.seed + k, h))
      ms += b.stats.ms
      houses.push(b)
    }
    const xs = [0, 0]
    houses.forEach((b, k) => {
      const row = k % 2, prev = houses[k - 2]
      xs[row] += prev ? prev.reach + b.reach + 0.8 : 0
      place(b, xs[row] + row * 3, row ? -9 : 0, -Math.PI / 2 + 0.35)
    })
    houseGroup.position.x = -Math.max(...xs) / 2
    current = { lineup: houses, ms }
    figures.visible = false
  } else {
    houseGroup.position.x = 0
    const built = buildHouse(spec)
    place(built, 0, 0, 0)
    current = { built }
    const d = built.door
    leafkin.position.set(d.p[0] + 1.1, 0, d.p[2] - 0.5)
    her.position.set(d.p[0] + 1.3, 0, d.p[2] + 0.55)
    figures.visible = document.getElementById('figures').classList.contains('on')
  }
  applyNight()
  renderStats()
}

function applyNight() {
  sun.intensity = night ? 0.12 : 2.1
  hemi.intensity = night ? 0.12 : 0.85
  scene.background.copy(night ? NIGHT_SKY : DAY_SKY)
  scene.fog.color.copy(scene.background)
  flameMat.color.set(night ? 0xffc060 : 0xb88040)
  glowMat.color.set(night ? 0xffffff : 0x6a5a44)
  houseGroup.traverse((c) => { if (c.isPointLight) c.intensity = night ? 3 : 0 })
}

function renderStats() {
  let rows
  if (current.lineup) {
    const t = current.lineup.reduce((s, b) => s + b.stats.triangles, 0)
    rows = [['houses', '8'], ['triangles', t.toLocaleString()], ['build, all 8', `${current.ms.toFixed(1)} ms`], ['per house', `${(current.ms / 8).toFixed(1)} ms`]]
  } else {
    const b = current.built
    rows = [
      ['roof', `${spec.skin}, ${spec.crown}`],
      ['door', `${spec.doorShape} ${b.door.w.toFixed(2)} x ${b.door.h.toFixed(2)} m`],
      ['chimney', spec.chimney],
      ['awning', spec.awning],
      ['windows', `${b.windows.length}`],
      ['decor', b.decor.join(', ') || '-'],
      ['trunk', `r ${b.trunk.r.toFixed(2)}, top ${b.trunk.top.toFixed(2)} m`],
      ['reach', `${b.reach.toFixed(2)} m`],
      ['top', `${b.top.toFixed(2)} m`],
      ['triangles', b.stats.triangles.toLocaleString()],
      ['roof tris', b.stats.roofTriangles.toLocaleString()],
      ['glass tris', b.stats.glowTriangles.toLocaleString()],
      ['vertices', b.stats.vertices.toLocaleString()],
      ['build', `${b.stats.ms.toFixed(1)} ms`],
    ]
  }
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
  input.addEventListener('input', () => {
    spec[key] = Number(input.value)
    if (key === 'height') params.height = spec.height
    out.textContent = input.value
    rebuild()
  })
  inputs[key] = { input, out }
  sliderBox.appendChild(row)
}
const kindBox = document.getElementById('kinds')
const selects = {}
for (const [key, kinds] of Object.entries(HOUSE_KINDS)) {
  const row = document.createElement('div')
  row.className = `row qa-kind-${key}`
  row.innerHTML = `<label>${key}</label><select>${kinds.map((k) => `<option>${k}</option>`).join('')}</select><span></span>`
  const sel = row.querySelector('select')
  sel.addEventListener('change', () => { spec[key] = sel.value; rebuild() })
  selects[key] = sel
  kindBox.appendChild(row)
}

function syncPanel() {
  for (const [key, { input, out }] of Object.entries(inputs)) {
    input.value = spec[key]
    out.textContent = Number(spec[key]).toFixed(input.step < 1 ? 2 : 0)
  }
  for (const [key, sel] of Object.entries(selects)) sel.value = spec[key]
  seedInput.value = params.seed
}

const reroll = (seed) => { params.seed = seed; spec = rollHouse(seed, params.height); syncPanel(); rebuild() }
const seedInput = document.getElementById('seed')
seedInput.addEventListener('change', () => reroll(Number(seedInput.value) | 0))
document.getElementById('reroll').addEventListener('click', () => reroll(params.seed + 1))
document.getElementById('reset').addEventListener('click', () => reroll(params.seed))

const toggle = (id, fn) => {
  const b = document.getElementById(id)
  b.addEventListener('click', () => { b.classList.toggle('on'); fn(b.classList.contains('on')) })
}
toggle('night', (on) => { night = on; applyNight() })
toggle('figures', (on) => { figures.visible = on && !lineup })
toggle('lineup', (on) => {
  lineup = on
  controls.target.set(0, 3, 0)
  camera.position.set(on ? 0 : 9, on ? 11 : 4.5, on ? 26 : 6)
  rebuild()
})
toggle('wire', (on) => { material.wireframe = on })
toggle('spin', (on) => { spin = on })
document.getElementById('copy').addEventListener('click', () => {
  const text = JSON.stringify(spec, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v))
  navigator.clipboard.writeText(text).catch((e) => console.error('copy spec', e))
  console.log('leafkin house spec', text)
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
syncPanel()
rebuild()

renderer.setAnimationLoop(() => {
  controls.autoRotate = spin
  controls.update()
  renderer.render(scene, camera)
})
window.houseBench = { params, get spec() { return spec }, reroll, rebuild, camera, controls, get current() { return current } }
