import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TriFlames, TRI_FIRE, FLAME_TRIS } from './v2/render/fire-tris.js'
import { LOOKS, LookFlames, lookUniforms } from './fire-looks.js'

// ---------------------------------------------------------------------------
// /test-fire-looks: the shipped triangle flame and the candidates of fire-looks.js in a row, or one of them as a grid of `copies` to weigh its cost. `?view=` picks the start (all, tris, or a LOOKS key), `?scale=` campfire|lamp|candle.
// ---------------------------------------------------------------------------

const CAPACITY = 64
const SCALES = {
  campfire: { height: 0.9, radius: 0.35, y: 0.15, spacing: 1.8, prop: 'logs', sparkSize: 1 },
  lamp: { height: 0.32, radius: 0.1, y: 1.2, spacing: 0.8, prop: 'post', sparkSize: 2 },
  candle: { height: 0.06, radius: 0.012, y: 0.2, spacing: 0.25, prop: 'stick', sparkSize: 2 },
}
const KEYS = ['tris', 'tongues', 'lives', 'tear', 'lathe', 'fans', 'diamonds', 'core', 'cel']
const NAMES = { tris: '0. shipped flame', ...Object.fromEntries(Object.entries(LOOKS).map(([k, l]) => [k, l.name])) }
const BLURBS = { tris: 'the world\'s flame (fire-tris.js): E with its own sparks, pitched toward an eye above', ...Object.fromEntries(Object.entries(LOOKS).map(([k, l]) => [k, l.blurb])) }

const url = new URL(location.href)
const state = {
  view: KEYS.includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'all',
  scale: SCALES[url.searchParams.get('scale')] ? url.searchParams.get('scale') : 'campfire',
  sparks: url.searchParams.get('sparks') !== '0',
  speed: 1, gain: 1.3, copies: 1, bg: 0,
}

// --- renderer ---------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 200)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
scene.add(new THREE.HemisphereLight(0x36466a, 0x0a0c10, 0.35))
const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshLambertMaterial({ color: 0x1c2418 }))
ground.rotation.x = -Math.PI / 2
scene.add(ground)

function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  for (let k = 0; k <= 8; k++) grad.addColorStop(k / 8, `rgba(255,255,255,${(1 - k / 8) ** 2})`)
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}
const poolMaterial = new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: new THREE.Color(1, 0.4, 0.04).multiplyScalar(0.25) })
const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
const props = new THREE.Group()
scene.add(props)
const WOOD = new THREE.MeshLambertMaterial({ color: 0x2a1c10 })
const STONE = new THREE.MeshLambertMaterial({ color: 0x3a3a3c })
const WAX = new THREE.MeshLambertMaterial({ color: 0xf0e4c4, emissive: 0xa89a78 })

// Warm lights stand in for the world's lamp map so the logs read; capped at eight for the copies grid.
let lights = 0
function addProp(kind, x, z, s) {
  if (kind === 'logs') {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.3
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.8, 6), WOOD)
      log.position.set(x + Math.cos(a) * 0.12, 0.2, z + Math.sin(a) * 0.12)
      log.rotation.set(Math.PI / 2 - 0.55, a, 0, 'YXZ')
      props.add(log)
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.11, 0), STONE)
      stone.position.set(x + Math.cos(a) * 0.62, 0.06, z + Math.sin(a) * 0.62)
      props.add(stone)
    }
  } else if (kind === 'post') {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, s.y, 6), WOOD)
    post.position.set(x, s.y / 2, z)
    props.add(post)
  } else {
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, s.y, 5), WAX)
    stick.position.set(x, s.y / 2, z)
    props.add(stick)
  }
  if (lights < 8) {
    const light = new THREE.PointLight(0xff8a30, 1.5, s.height * 6, 1.5)
    light.position.set(x, s.y + s.height * 0.35, z)
    props.add(light)
    lights++
  }
  const pool = new THREE.Mesh(poolGeo, poolMaterial)
  pool.position.set(x, 0.005, z)
  pool.scale.setScalar(s.height * 5)
  props.add(pool)
}

// --- the flames -------------------------------------------------------------

const uniforms = lookUniforms({ hot: TRI_FIRE.birthColor, mid: TRI_FIRE.midColor, cool: TRI_FIRE.deathColor, gain: TRI_FIRE.gain })
const looks = Object.fromEntries(Object.keys(LOOKS).map((k) => [k, new LookFlames(k, CAPACITY, uniforms)]))
for (const l of Object.values(looks)) scene.add(l.mesh)
const tris = new TriFlames(CAPACITY, { ...TRI_FIRE })
scene.add(tris.group)

const tags = []
function layout() {
  const s = SCALES[state.scale]
  uniforms.uSparkSize.value = tris.shared.uSparkSize.value = s.sparkSize
  for (const l of Object.values(looks)) l.clear()
  tris.count = 0
  props.clear()
  lights = 0
  for (const t of tags) t.el.remove()
  tags.length = 0

  const spots = []
  if (state.view === 'all') {
    KEYS.forEach((key, i) => spots.push({ key, x: (i - (KEYS.length - 1) / 2) * s.spacing, z: 0 }))
  } else {
    const n = state.copies, side = Math.ceil(Math.sqrt(n))
    for (let i = 0; i < n; i++) spots.push({ key: state.view, x: ((i % side) - (side - 1) / 2) * s.spacing, z: -Math.floor(i / side) * s.spacing })
  }
  const slot = {}
  let sparks = 0
  for (const { key, x, z } of spots) {
    const i = (slot[key] = (slot[key] ?? -1) + 1)
    if (key === 'tris') tris.place(i, x, s.y, z, { height: s.height, radius: s.radius, phase: x * 3.1 + z, group: i % 3 })
    else looks[key].place(i, x, s.y, z, s.height, s.radius)
    if (state.sparks && key !== 'tris') looks.sparks.place(sparks++, x, s.y, z, s.height, s.radius)
    addProp(s.prop, x, z, s)
  }
  if (state.view === 'all') {
    for (const { key, x, z } of spots) {
      const el = document.createElement('div')
      el.className = `tag qa-tag-${key}`
      el.textContent = NAMES[key]
      stage.appendChild(el)
      tags.push({ el, at: new THREE.Vector3(x, 0, z + s.radius * 2) })
    }
  }
  document.getElementById('blurb').textContent = state.view === 'all' ? 'all of them in a row, left to right' : BLURBS[state.view]
  const width = state.view === 'all' ? KEYS.length * s.spacing : Math.ceil(Math.sqrt(state.copies)) * s.spacing
  controls.target.set(0, s.y + s.height * 0.5, state.view === 'all' ? 0 : -(Math.ceil(state.copies / Math.ceil(Math.sqrt(state.copies))) - 1) * s.spacing / 2)
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect)
  const d = Math.max(s.height * 3, (width * 0.55) / Math.tan(hfov / 2))
  camera.position.set(0, controls.target.y + d * 0.2, controls.target.z + d)
  for (const [k, v] of [['view', state.view], ['scale', state.scale], ['sparks', state.sparks ? 1 : 0]]) url.searchParams.set(k, v)
  history.replaceState(null, '', url)
  showButtons()
}

// --- controls ---------------------------------------------------------------

const viewsEl = document.getElementById('views')
const scalesEl = document.getElementById('scales')
function buttons(el, keys, label, pick) {
  for (const k of keys) {
    const b = document.createElement('button')
    b.textContent = label(k)
    b.dataset.key = k
    b.className = `qa-btn-${k}`
    b.addEventListener('click', () => { pick(k); layout() })
    el.appendChild(b)
  }
}
buttons(viewsEl, ['all', ...KEYS], (k) => (k === 'all' ? 'all' : NAMES[k].split(' ')[0] + ' ' + NAMES[k].split(' ').slice(-1)), (k) => { state.view = k })
buttons(scalesEl, Object.keys(SCALES), (k) => k, (k) => { state.scale = k })
function showButtons() {
  for (const b of viewsEl.children) b.classList.toggle('on', b.dataset.key === state.view)
  for (const b of scalesEl.children) b.classList.toggle('on', b.dataset.key === state.scale)
  document.getElementById('sparks').classList.toggle('on', state.sparks)
}

// [key, min, max, step, help, relayout]
const SLIDERS = [
  ['speed', 0, 3, 0.05, 'the clock rate every look runs at'],
  ['gain', 0.2, 3, 0.05, 'brightness'],
  ['copies', 1, CAPACITY, 1, 'flames of the shown look, in a grid (not in "all")', true],
  ['bg', 0, 1, 0.01, 'the sky behind, black to noon'],
]
const slidersEl = document.getElementById('sliders')
for (const [key, min, max, step, help, relayout] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label title="${help}">${key}</label><input type="range" class="qa-${key}" min="${min}" max="${max}" step="${step}" value="${state[key]}" /><span class="v">${state[key]}</span>`
  const input = row.querySelector('input'), out = row.querySelector('.v')
  input.addEventListener('input', () => {
    state[key] = Number(input.value)
    out.textContent = step >= 1 ? state[key] : state[key].toFixed(2)
    if (relayout) layout()
  })
  slidersEl.appendChild(row)
}

let paused = false, spinning = false
document.getElementById('sparks').addEventListener('click', () => { state.sparks = !state.sparks; layout() })
document.getElementById('pause').addEventListener('click', (e) => { paused = !paused; e.target.classList.toggle('on', paused) })
document.getElementById('spin').addEventListener('click', (e) => { spinning = !spinning; e.target.classList.toggle('on', spinning) })

// --- the cost panel ---------------------------------------------------------

const frameEl = document.getElementById('frame')
const looksEl = document.getElementById('looks')
const rows = (el, pairs) => { el.innerHTML = pairs.map(([k, v]) => `<tr><td class="k">${k}</td><td class="n">${v}</td></tr>`).join('') }
rows(looksEl, [
  [NAMES.tris, `${FLAME_TRIS} tris`],
  ...Object.values(looks).map((l) => [NAMES[l.key], `${l.trianglesPer} tris${LOOKS[l.key].additive ? ', additive' : ''}`]),
])

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

const glow = [1, 1, 1]
const _v = new THREE.Vector3()
let t = 0, last = performance.now(), frames = 0, msAcc = 0, lastPanel = 0
function frame() {
  const now = performance.now()
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
  last = now
  if (!paused) t += dt * state.speed
  if (spinning) {
    const r = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z)
    const a = Math.atan2(camera.position.z - controls.target.z, camera.position.x - controls.target.x) + dt * 0.4
    camera.position.x = controls.target.x + Math.cos(a) * r
    camera.position.z = controls.target.z + Math.sin(a) * r
  }
  controls.update()
  uniforms.uTime.value = t
  uniforms.uHead.value.copy(camera.position)
  uniforms.uGain.value = state.gain
  tris.shared.uGain.value = state.gain
  tris.update(t, glow, camera.position)
  const bg = state.bg
  renderer.setClearColor(new THREE.Color(0.02 + bg * 0.4, 0.03 + bg * 0.55, 0.06 + bg * 0.9))
  renderer.render(scene, camera)

  const w = stage.clientWidth, h = stage.clientHeight
  for (const tag of tags) {
    _v.copy(tag.at).project(camera)
    tag.el.style.display = _v.z < 1 ? '' : 'none'
    tag.el.style.left = ((_v.x + 1) / 2) * w + 'px'
    tag.el.style.top = ((1 - _v.y) / 2) * h + 6 + 'px'
  }

  frames++
  msAcc += dt * 1000
  if (now - lastPanel > 500) {
    const info = renderer.info.render
    rows(frameEl, [['ms', (msAcc / frames).toFixed(2)], ['fps', (1000 / Math.max(1e-3, msAcc / frames)).toFixed(0)], ['draw calls', info.calls], ['triangles (all)', info.triangles]])
    frames = 0
    msAcc = 0
    lastPanel = now
  }
  requestAnimationFrame(frame)
}

try {
  resize()
  layout()
  requestAnimationFrame(frame)
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__shot = true }))
} catch (e) {
  document.getElementById('err').textContent = String(e.stack || e)
  window.PROBE_ERR = String(e)
  throw e
}
