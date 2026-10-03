import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TriFlames, TRI_FIRE, TRI_TORCH, TRI_LAMP, TRI_CANDLE, shardsAt, lodFor } from './v2/render/fire-tris.js'
import { flicker } from './v2/render/fire.js'

// ---------------------------------------------------------------------------
// /test-fire-tris: the triangle flame (v2/render/fire-tris.js) on a bench, at lamp, torch and campfire scale, every knob on a slider. `lod` forces one level (-1 follows the distance to the camera, so a row of flames shows every level at once); `lodTint` colours each level so the boundaries can be seen. The pool of light under a flame is a disc standing in for the lamp map.
// ---------------------------------------------------------------------------

// [section | null, key, min, max, step, help]
const SLIDERS = [
  ['scale', 'height', 0.02, 2.0, 0.005, 'metres, the flame from its foot to where a shard dies'],
  [null, 'radius', 0.005, 1.0, 0.005, 'metres, the radius of the foot the shards are born across'],
  ['shards', 'shards', 4, 512, 1, 'shards in the nearest LOD; this is the look'],
  [null, 'size', 0.05, 0.6, 0.005, "a shard's size as a fraction of the flame's height"],
  [null, 'sizeVar', 0.0, 1.0, 0.01, 'how much the size varies shard to shard'],
  [null, 'sliver', 0.5, 4.0, 0.05, 'how much taller than wide a shard is'],
  [null, 'shrink', 0.2, 4.0, 0.05, 'exponent on the shrink over a shard\'s life; high holds its size then drops away'],
  ['motion', 'rate', 0.2, 4.0, 0.05, 'lifetimes per second'],
  [null, 'rise', 0.5, 3.0, 0.05, 'exponent on the climb; above 1 a shard accelerates'],
  [null, 'taper', 0.0, 1.0, 0.01, 'how far shards are drawn in toward the axis by the top: the flame\'s outline'],
  [null, 'spread', 0.2, 2.0, 0.01, "the foot's spread, as a fraction of radius"],
  [null, 'wobble', 0.0, 2.0, 0.01, 'sideways wander growing with height, in radii'],
  [null, 'wobbleHz', 0.5, 12.0, 0.1, 'rate of the wander, radians per second'],
  [null, 'sway', 0.0, 1.0, 0.01, 'the whole flame leaning at the top, in radii'],
  [null, 'spin', 0.0, 6.0, 0.05, 'tumble about the vertical, turns per second'],
  [null, 'flicker', 0.0, 1.0, 0.01, 'how much of the three-group flicker reaches the brightness; 0 is steady'],
  ['look', 'cool', 0.3, 2.0, 0.01, "exponent on a shard's age for its colour; below 1 it cools sooner, so more of the flame is orange and red"],
  [null, 'jitter', 0.0, 1.0, 0.01, "how far each shard's colour is shifted along the ramp from its own age"],
  [null, 'duty', 0.02, 1.0, 0.01, 'the share of its lifetimes a shard exists: below 1 they are occasional flecks'],
  [null, 'lift', 0.0, 1.0, 0.01, 'how far up the flame a shard is born, as a fraction of its height'],
  [null, 'gain', 0.1, 3.0, 0.05, 'brightness, linear, before the flicker'],
  ['core', 'coreSize', 0.0, 0.5, 0.005, 'the solid diamond core: its width as a fraction of the flame height; 0 is no core'],
  [null, 'coreHeight', 0.2, 1.2, 0.01, "the core's height as a fraction of the flame height"],
  [null, 'coreJump', 0.0, 1.0, 0.01, "how far the core's tip jumps about, as a fraction of its height"],
  [null, 'coreHz', 0.5, 20, 0.1, 'core flicker rate, radians per second'],
  ['lod', 'lod', -1, 3, 1, '-1 follows the distance to the camera; 0 to 3 force one level'],
  [null, 'lodKeep', 0.2, 0.9, 0.01, 'the share of shards each further level keeps'],
  [null, 'boost', 0.0, 1.0, 0.01, "exponent on how much larger a thinner level's shards are drawn; 0.5 holds their total area"],
  [null, 'lodNear', 0.5, 20, 0.1, 'metres to the first boundary'],
  [null, 'lodStep', 1.2, 5, 0.05, 'the factor between boundaries'],
  [null, 'lodTint', 0, 1, 1, '1 colours each level: 0 white, 1 green, 2 blue, 3 magenta'],
  ['scene', 'count', 1, 16, 1, 'flames in a row'],
  [null, 'spacing', 0.2, 12.0, 0.05, 'metres between them'],
  [null, 'glowReach', 0.0, 12.0, 0.1, "metres the stand-in ground pool reaches; the world's lamp map does this job"],
  [null, 'glowGain', 0.0, 2.0, 0.05, "the pool's brightness at the foot"],
  [null, 'bg', 0.0, 1.0, 0.01, 'the sky behind, black to noon'],
]

const COLORS = [
  ['birthColor', 'a shard as it is born'],
  ['midColor', 'the middle of its life'],
  ['deathColor', 'the last of it, as it shrinks away'],
  ['coreLowColor', "the core's foot"],
  ['coreHighColor', "the core's tip"],
]

const BENCH = { flicker: 0.0, lod: 0, lodTint: 0, count: 1, spacing: 1.45, glowReach: 4.9, glowGain: 0.35, bg: 0.0, context: 'post' }

const PRESETS = {
  lamp: { ...TRI_LAMP, ...BENCH },
  torch: { ...TRI_TORCH, ...BENCH, glowReach: 5, glowGain: 0.7, context: 'torch' },
  campfire: { ...TRI_FIRE, ...BENCH, glowReach: 9, glowGain: 1.2, context: 'campfire' },
  candle: { ...TRI_CANDLE, ...BENCH, glowReach: 2, glowGain: 0.3, context: 'candle' },
}

const url = new URL(location.href)
const startPreset = PRESETS[url.searchParams.get('preset')] ? url.searchParams.get('preset') : 'lamp'
const params = { ...PRESETS[startPreset] }
for (const [k, v] of url.searchParams) if (k in params && typeof params[k] === 'number') params[k] = Number(v)

// --- renderer ---------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200)
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
  for (let k = 0; k <= 8; k++) {
    const r = k / 8
    grad.addColorStop(r, `rgba(255,255,255,${(1 - r) * (1 - r)})`)
  }
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}
const poolMap = glowTexture()
const poolMaterial = () => new THREE.MeshBasicMaterial({ map: poolMap, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
const poolGeo = new THREE.PlaneGeometry(2, 2)
const pools = new THREE.Group()
scene.add(pools)

// --- the flames -------------------------------------------------------------

const CAPACITY = 16
const flames = new TriFlames(CAPACITY, params)
scene.add(flames.group)

const rand = (() => { let s = 11; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } })()
const feet = Array.from({ length: CAPACITY }, (_, i) => ({ phase: rand() * Math.PI * 2, group: i % 3 }))

// --- context props: what the flame sits on, per preset ----------------------

const WOOD = new THREE.MeshLambertMaterial({ color: 0x2a1c10 })
const HIDE = new THREE.MeshLambertMaterial({ color: 0x3a2a1a, side: THREE.DoubleSide })
const STONE = new THREE.MeshLambertMaterial({ color: 0x3a3a3c })
const WAX = new THREE.MeshLambertMaterial({ color: 0xf0e4c4, emissive: 0xa89a78 })
const WALL = new THREE.MeshLambertMaterial({ color: 0x2c2a26 })
const context = new THREE.Group()
scene.add(context)

function buildContext(kind, flameY) {
  context.clear()
  if (kind === 'post') {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, flameY - 0.05, 6), WOOD)
    post.position.y = (flameY - 0.05) / 2
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.07, 0.07, 6), WOOD)
    dish.position.y = flameY - 0.02
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.16, 7, 1, true), HIDE)
    hood.position.y = flameY + params.height * 1.35 + 0.08
    context.add(post, dish, hood)
  } else if (kind === 'candle') {
    // A five-sided stick whose top face is the flame's foot.
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, flameY, 5), WAX)
    stick.position.y = flameY / 2
    context.add(stick)
  } else if (kind === 'torch') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.4), WALL)
    wall.position.set(0, 1.5, -0.45)
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), STONE)
    bracket.position.set(0, flameY - 0.2, -0.12)
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.5, 6), WOOD)
    handle.position.set(0, flameY - 0.2, 0)
    handle.rotation.x = -0.35
    context.add(wall, bracket, handle)
  } else if (kind === 'campfire') {
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.14 + (k % 3) * 0.03, 0), STONE)
      stone.position.set(Math.cos(a) * 0.75, 0.08, Math.sin(a) * 0.75)
      stone.rotation.set(k, k * 1.7, 0)
      context.add(stone)
    }
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.3
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.8, 6), WOOD)
      log.position.set(Math.cos(a) * 0.12, 0.2, Math.sin(a) * 0.12)
      log.rotation.set(Math.PI / 2 - 0.55, a, 0, 'YXZ')
      context.add(log)
    }
  }
}

// --- layout -----------------------------------------------------------------

const TINTS = [[1, 1, 1], [0.35, 1, 0.35], [0.35, 0.55, 1], [1, 0.35, 1]]

function layout() {
  const kind = params.context
  const flameY = kind === 'post' ? 1.62 : kind === 'torch' ? 1.7 : kind === 'candle' ? 0.2 : 0.18
  const count = Math.round(params.count)
  const x0 = -((count - 1) * params.spacing) / 2
  flames.set(params)
  flames.forceLod = Math.round(params.lod)
  flames.levels.forEach((l, k) => l.material.uniforms.uTint.value.setRGB(...(params.lodTint ? TINTS[k] : TINTS[0])))
  flames.count = 0
  for (let i = 0; i < count; i++) {
    const x = x0 + i * params.spacing
    flames.place(i, x, flameY, 0, { height: params.height, radius: params.radius, phase: feet[i].phase, group: feet[i].group })
  }
  for (const pool of pools.children) pool.material.dispose()
  pools.clear()
  for (let i = 0; i < count; i++) {
    const pool = new THREE.Mesh(poolGeo, poolMaterial())
    pool.rotation.x = -Math.PI / 2
    pool.position.set(x0 + i * params.spacing, 0.005, 0)
    pool.scale.setScalar(Math.max(0.01, params.glowReach))
    pool.userData.group = feet[i].group
    pools.add(pool)
  }
  if (context.userData.kind !== kind) {
    buildContext(kind, flameY)
    context.userData.kind = kind
    controls.target.set(0, flameY + params.height * 0.5, 0)
    const d = Math.max(0.25, params.height * 3)
    camera.position.set(d * 0.5, flameY + params.height * 0.5 + d * 0.15, d)
  }
  const bg = params.bg
  renderer.setClearColor(new THREE.Color(0.02 + bg * 0.4, 0.03 + bg * 0.55, 0.06 + bg * 0.9))
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
  row.className = 'row'
  row.innerHTML = `<label title="${help}">${key}</label><input type="range" min="${min}" max="${max}" step="${step}" /><span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  const show = () => {
    input.value = params[key]
    out.textContent = key === 'lod' && params[key] < 0 ? 'auto' : step >= 1 ? Math.round(params[key]) : Number(params[key]).toFixed(step < 0.01 ? 3 : 2)
  }
  readouts[key] = show
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show()
    layout()
  })
  slidersEl.appendChild(row)
}

const colorsEl = document.getElementById('colors')
const tmpColor = new THREE.Color()
for (const [key, help] of COLORS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label title="${help}">${key.replace('Color', '')}</label><input type="color" /><span class="v"></span>`
  const input = row.querySelector('input')
  const show = () => { input.value = '#' + tmpColor.setRGB(...params[key]).getHexString() }
  readouts[key] = show
  input.addEventListener('input', () => {
    tmpColor.setStyle(input.value)
    params[key] = [tmpColor.r, tmpColor.g, tmpColor.b]
    show()
    layout()
  })
  colorsEl.appendChild(row)
}

const showAll = () => { for (const k in readouts) readouts[k]() }

const presetsEl = document.getElementById('presets')
for (const name of Object.keys(PRESETS)) {
  const b = document.createElement('button')
  b.textContent = name
  b.addEventListener('click', () => {
    Object.assign(params, PRESETS[name])
    context.userData.kind = null
    showAll()
    layout()
    url.searchParams.set('preset', name)
    history.replaceState(null, '', url)
  })
  presetsEl.appendChild(b)
}

let paused = false
let spinning = false
document.getElementById('pause').addEventListener('click', (e) => { paused = !paused; e.target.classList.toggle('on', paused) })
document.getElementById('spin').addEventListener('click', (e) => { spinning = !spinning; e.target.classList.toggle('on', spinning) })
// Every knob as one object literal, so a tuned look can be pasted straight into TRI_FIRE or a preset.
document.getElementById('copy').addEventListener('click', async (e) => {
  const keys = [...Object.keys(TRI_FIRE)]
  const text = '{ ' + keys.map((k) => `${k}: ${Array.isArray(params[k]) ? '[' + params[k].map((c) => +c.toFixed(3)).join(', ') + ']' : +params[k].toFixed(3)}`).join(', ') + ' }'
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
document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, PRESETS[startPreset])
  context.userData.kind = null
  showAll()
  layout()
})

// --- the cost panel ---------------------------------------------------------

const frameEl = document.getElementById('frame')
const lodsEl = document.getElementById('lods')
const rows = (el, pairs) => { el.innerHTML = pairs.map(([k, v]) => `<tr><td class="k">${k}</td><td class="n">${v}</td></tr>`).join('') }

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
const _tint = new THREE.Color()
let t = 0, last = performance.now(), frames = 0, msAcc = 0, lastPanel = 0
function frame() {
  const now = performance.now()
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000))
  last = now
  if (!paused) t += dt
  if (spinning) {
    const r = Math.hypot(camera.position.x - controls.target.x, camera.position.z - controls.target.z)
    const a = Math.atan2(camera.position.z - controls.target.z, camera.position.x - controls.target.x) + dt * 0.4
    camera.position.x = controls.target.x + Math.cos(a) * r
    camera.position.z = controls.target.z + Math.sin(a) * r
  }
  controls.update()
  for (let g = 0; g < 3; g++) glow[g] = 1 - params.flicker * (1 - flicker(t, g * 2.1))
  flames.update(t, glow, camera.position)
  _tint.setRGB(...params.midColor)
  for (const pool of pools.children) pool.material.color.copy(_tint).multiplyScalar(params.glowGain * glow[pool.userData.group])
  renderer.render(scene, camera)

  frames++
  msAcc += dt * 1000
  if (now - lastPanel > 500) {
    const info = renderer.info.render
    rows(frameEl, [['ms', (msAcc / frames).toFixed(2)], ['fps', (1000 / (msAcc / frames)).toFixed(0)], ['draw calls', info.calls], ['triangles (all)', info.triangles]])
    const per = flames.levels.map((l, k) => [`lod ${k}: ${shardsAt(params, k)} tris`, `${l.mesh.count} flames`])
    const d = Math.hypot(...['x', 'y', 'z'].map((a) => camera.position[a] - flames.at[0][a]))
    rows(lodsEl, [...per, ['flame triangles', flames.triangles()], ['distance to flame 0', d.toFixed(1) + ' m'], ['flame 0 follows lod', lodFor(params, d)]])
    frames = 0
    msAcc = 0
    lastPanel = now
  }
  requestAnimationFrame(frame)
}

try {
  resize()
  showAll()
  layout()
  requestAnimationFrame(frame)
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__shot = true }))
} catch (e) {
  document.getElementById('err').textContent = String(e.stack || e)
  window.PROBE_ERR = String(e)
  throw e
}
