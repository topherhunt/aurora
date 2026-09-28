import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Flares, FLARE, MAX_SPARKS, REST_M, FLIGHT_S } from './v2/render/flares.js'
import { PALETTE, AIM_M, CLEAR_M } from './v2/flaregun.js'

// ---------------------------------------------------------------------------
// /test-flare: the flare (v2/render/flares.js) on a bench, every FLARE knob on
// a slider. One flare hangs CLEAR_M over a dark ground, where a shot from the
// flare gun comes to rest; the range chips put the camera where she would see
// it from, and "fire" shoots a fresh one in from beside the camera to watch
// its flight and arrival (?range=close|near|shot|far starts there). "copy"
// gives the look back as a FLARE literal.
// ---------------------------------------------------------------------------

// [section | null, key, min, max, step, help] -- the look's keys are FLARE's (see flares.js).
const SLIDERS = [
  ['ball', 'core', 0.1, 1.0, 0.01, "the ball's radius, in ball radii: under 1 leaves the rest of the size to the halo and sparks"],
  [null, 'halo', 0.0, 2.0, 0.01, "the halo's brightness"],
  [null, 'haloFall', 0.1, 6.0, 0.05, 'how fast the halo falls off; high is tight'],
  [null, 'flicker', 0.0, 1.0, 0.01, 'how much the ball and halo flicker'],
  ['sparks', 'sparks', 0, MAX_SPARKS, 1, 'sparks in the air at once'],
  [null, 'rate', 0.2, 5.0, 0.05, 'lives each spark lives per second: high is a short, busy spray'],
  [null, 'speed', 0.5, 8.0, 0.05, 'how far a spark flies, in ball radii'],
  [null, 'drag', 0.0, 2.0, 0.01, 'how early in its life a spark slows: 0 flies at an even pace, high bursts out and hangs'],
  [null, 'gravity', 0.0, 6.0, 0.05, 'how far a spark droops by the end of its life, in ball radii'],
  [null, 'trail', 0.01, 0.6, 0.01, 'its streak, as a fraction of its life'],
  [null, 'width', 0.005, 0.3, 0.005, "its streak's half-width, in ball radii"],
  [null, 'white', 0.0, 1.0, 0.01, 'how white-hot a spark is at birth, before it cools to the colour'],
  [null, 'gain', 0.0, 8.0, 0.05, "the sparks' brightness"],
  [null, 'crackle', 0.0, 1.0, 0.01, 'how hard a spark twinkles as it dies'],
  ['bench', 'size', 0.5, 10, 0.1, `metres across, at rest (the game's REST_M is ${REST_M})`],
  [null, 'bg', 0.0, 1.0, 0.01, 'the sky behind, black to noon'],
]

// Where she would see it from: beside it, a stone's throw off, where the gun puts it (AIM_M down the barrel), and far across the map.
const RANGES = { close: 12, near: 40, shot: AIM_M, far: 600 }
const BENCH = { size: REST_M, bg: 0.0 }
const params = { ...FLARE, ...BENCH }
let hue = 0
const SPOT = new THREE.Vector3(0, CLEAR_M, 0)

// --- renderer ---------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.copy(SPOT)

scene.add(new THREE.HemisphereLight(0x36466a, 0x0a0c10, 0.35))
const ground = new THREE.Mesh(new THREE.CircleGeometry(3000, 64), new THREE.MeshLambertMaterial({ color: 0x1c2418 }))
ground.rotation.x = -Math.PI / 2
scene.add(ground)
// Posts every 10 m out from under the flare, for scale.
const post = new THREE.CylinderGeometry(0.08, 0.1, 2, 6)
const WOOD = new THREE.MeshLambertMaterial({ color: 0x3a2a1a })
for (let k = -5; k <= 5; k++) {
  const m = new THREE.Mesh(post, WOOD)
  m.position.set(k * 10, 1, 0)
  scene.add(m)
}

const flares = new Flares(scene)
flares.setRoom('bench')

// The hanging flare, long arrived; a fired one replaces it and flies in.
let nextId = 0
function hang() {
  flares.clear()
  flares.add(flare(SPOT, SPOT), 1e6)
}
function flare(from, to) {
  return { id: (nextId++).toString(36), room: 'bench', ox: from.x, oy: from.y, oz: from.z, tx: to.x, ty: to.y, tz: to.z, color: PALETTE[hue], seed: Math.random() }
}
function fire() {
  const from = new THREE.Vector3().subVectors(SPOT, camera.position).normalize().multiplyScalar(2).add(camera.position)
  from.y -= 0.5
  flares.clear()
  flares.add(flare(from, SPOT), 0)
}

// --- the look ---------------------------------------------------------------

function apply() {
  flares.set(params)
  const bg = params.bg
  renderer.setClearColor(new THREE.Color(0.02 + bg * 0.4, 0.03 + bg * 0.55, 0.06 + bg * 0.9))
}

// The bench draws a flare at `size` by scaling what the layer writes: sizeAt() is the game's, and REST_M its rest.
const update = flares.update.bind(flares)
flares.update = (dt, px) => {
  update(dt, px)
  const k = params.size / REST_M
  for (let n = 0; n < flares.mesh.geometry.instanceCount; n++) flares.aSize.array[n * 2] *= k
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}
for (const [section, key, min, max, step, help] of SLIDERS) {
  if (section) {
    const h = document.createElement('h2')
    h.textContent = section
    slidersEl.appendChild(h)
  }
  const row = document.createElement('div')
  row.className = `row qa-flare-${key}`
  row.innerHTML = `<label title="${help}">${key}</label><input type="range" min="${min}" max="${max}" step="${step}" /><span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  const show = () => {
    input.value = params[key]
    out.textContent = step >= 1 ? Math.round(params[key]) : Number(params[key]).toFixed(step < 0.01 ? 3 : 2)
  }
  readouts[key] = show
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show()
    apply()
  })
  slidersEl.appendChild(row)
}
const showAll = () => { for (const k in readouts) readouts[k]() }

const swatchesEl = document.getElementById('swatches')
PALETTE.forEach((hex, i) => {
  const b = document.createElement('button')
  b.className = `swatch qa-flare-swatch-${i}`
  b.style.background = '#' + hex.toString(16).padStart(6, '0')
  b.classList.toggle('on', i === hue)
  b.addEventListener('click', () => {
    hue = i
    for (const c of swatchesEl.children) c.classList.toggle('on', c === b)
    for (const f of flares.list) f.color = PALETTE[hue]
  })
  swatchesEl.appendChild(b)
})

const rangesEl = document.getElementById('ranges')
function viewFrom(m) {
  // Standing on the ground, m metres off along the row of posts' normal, looking up at it.
  camera.position.set(0, 1.7, m)
  controls.target.copy(SPOT)
}
for (const [name, m] of Object.entries(RANGES)) {
  const b = document.createElement('button')
  b.className = `qa-flare-range-${name}`
  b.textContent = `${name} ${m} m`
  b.addEventListener('click', () => viewFrom(m))
  rangesEl.appendChild(b)
}

let paused = false
document.getElementById('fire').addEventListener('click', fire)
addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); fire() } })
document.getElementById('pause').addEventListener('click', (e) => { paused = !paused; e.target.classList.toggle('on', paused) })
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, FLARE, BENCH)
  showAll()
  apply()
})
// The look's keys only, in FLARE's order, ready to paste over FLARE.
document.getElementById('copy').addEventListener('click', async (e) => {
  const text = '{ ' + Object.keys(FLARE).map((k) => `${k}: ${+params[k].toFixed(3)}`).join(', ') + ' }'
  try {
    await navigator.clipboard.writeText(text)
    e.target.textContent = 'copied'
  } catch (err) {
    e.target.textContent = 'clipboard refused'
    console.log(text)
    throw err
  }
  setTimeout(() => { e.target.textContent = 'copy' }, 1200)
})

// --- the loop ---------------------------------------------------------------

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight
  renderer.setSize(w, h, false)
  renderer.domElement.style.width = w + 'px'
  renderer.domElement.style.height = h + 'px'
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)

const readoutEl = document.getElementById('readout')
let last = performance.now(), lastPanel = 0
function frame() {
  const now = performance.now()
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
  last = now
  controls.update()
  flares.update(paused ? 0 : dt, renderer.domElement.height)
  renderer.render(scene, camera)
  if (now - lastPanel > 250) {
    const d = camera.position.distanceTo(SPOT)
    // The ball's radius on screen, as the vertex shader works it out (before its MIN_PX floor).
    const px = (0.5 * params.size * camera.projectionMatrix.elements[5] * renderer.domElement.height) / (2 * d)
    const age = flares.list.length ? flares.now - flares.list[0].born : Infinity
    readoutEl.textContent = `${d.toFixed(0)} m off\nball ${px.toFixed(1)} px\n${age < FLIGHT_S ? 'in flight' : 'at rest'}`
    lastPanel = now
  }
  requestAnimationFrame(frame)
}

try {
  resize()
  showAll()
  apply()
  hang()
  viewFrom(RANGES[new URL(location.href).searchParams.get('range')] ?? RANGES.near)
  requestAnimationFrame(frame)
  // For the headless probe: the picture is on screen after two frames.
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__shot = true }))
} catch (e) {
  document.getElementById('err').textContent = String(e.stack || e)
  window.PROBE_ERR = String(e)
  throw e
}
