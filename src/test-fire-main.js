import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Flames, FIRE, CAMPFIRE, CARD_OUTLINE, OVERHANG, flicker } from './v2/render/fire.js'

// ---------------------------------------------------------------------------
// /test-fire: the flame shader (v2/render/fire.js) on a bench, at lamp scale
// by default and at campfire scale by a preset, with every knob the shader
// takes on a slider and the one number the whole design rests on -- how many
// pixels the card actually covers -- read off the camera each frame.
//
// The ground pool of light under a flame is a disc here, standing in for the
// lamp map the world bakes; it flickers on the same glow so the bench shows
// the flame and its light moving together, which is what sells a flame more
// than anything inside the card.
// ---------------------------------------------------------------------------

// --- slider spec ------------------------------------------------------------
// [section | null, key, min, max, step, help]
const SLIDERS = [
  ['scale', 'height', 0.1, 2.0, 0.01, 'metres, the flame from its foot to the tip of the still mask'],
  [null, 'radius', 0.03, 1.0, 0.01, "metres, the card's half-width; the mask fills `width` of it"],
  [null, 'width', 0.3, 0.9, 0.01, "the mask's widest half-width as a fraction of the card's; the rest is room for the outline to wander into"],
  ['motion', 'speed', 0.2, 4.0, 0.05, 'noise scroll, cycles per second'],
  [null, 'stretch', 0.5, 4.0, 0.05, 'vertical noise frequency, cycles per flame height; low is long lazy tongues, high is a nervous flame'],
  [null, 'turb', 0.0, 1.0, 0.01, 'how far the noise pushes the outline at the tip, in card half-widths'],
  [null, 'cut', 0.0, 1.0, 0.01, 'how hard the noise cuts into the mask near the tip; this is what tears a tongue off'],
  [null, 'sway', 0.0, 0.5, 0.01, 'how far the whole flame leans, at the tip'],
  [null, 'flicker', 0.0, 1.0, 0.01, 'how much of the three-group flicker reaches the glow and the height; 0 is a steady flame'],
  ['look', 'edge', 0.02, 0.5, 0.01, 'width of the translucent red rim, on the 0..1 mask value'],
  [null, 'core', 0.3, 1.0, 0.01, 'where the ramp goes white; 1 is never'],
  [null, 'gain', 0.1, 4.0, 0.05, 'brightness, linear, before the flicker'],
  ['cards', 'sheets', 1, 3, 1, '1 is a billboard turned to the eye; 2 or 3 are fixed sheets crossed about the flame, for a fire you look down on'],
  [null, 'count', 1, 16, 1, 'flames in a row, each its own phase and group'],
  [null, 'spacing', 0.2, 4.0, 0.05, 'metres between them'],
  ['scene', 'glowReach', 0.0, 12.0, 0.1, "metres the stand-in ground pool reaches; the world's lamp map does this job"],
  [null, 'glowGain', 0.0, 2.0, 0.05, "the pool's brightness at the foot"],
  [null, 'bg', 0.0, 1.0, 0.01, 'the sky behind, black to noon; additive over a bright sky fades, as a real flame does'],
  [null, 'yaw', 0, 6.28, 0.01, 'the yaw of the sheets (cards 2 or 3), so a crossed fire can be walked round'],
]

const COLORS = [
  ['edgeColor', 'the translucent rim'],
  ['tipColor', 'the tongues, and what the upper half cools toward'],
  ['hotColor', 'the body'],
  ['coreColor', 'the axis, past `core`'],
]

const BENCH = { flicker: 0.0, count: 1, spacing: 1.45, glowReach: 4.9, glowGain: 0.35, bg: 0.0, yaw: 0.0, context: 'post' }

const PRESETS = {
  lamp: { ...FIRE, ...BENCH },
  torch: { ...FIRE, ...BENCH, height: 0.45, radius: 0.2, gain: 1.3, turb: 0.4, cut: 0.5, sway: 0.18, glowReach: 5, glowGain: 0.7, context: 'torch' },
  campfire: { ...CAMPFIRE, ...BENCH, glowReach: 9, glowGain: 1.2, context: 'campfire' },
}

const url = new URL(location.href)
const startPreset = PRESETS[url.searchParams.get('preset')] ? url.searchParams.get('preset') : 'lamp'
const params = { ...PRESETS[startPreset] }

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

// A dim night: enough hemisphere to see the ground and the props, none of it warm, so every warm pixel in the frame is the flame's.
scene.add(new THREE.HemisphereLight(0x36466a, 0x0a0c10, 0.35))
const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 48), new THREE.MeshLambertMaterial({ color: 0x1c2418 }))
ground.rotation.x = -Math.PI / 2
scene.add(ground)

// The stand-in pool of light: a radial gradient card, additive, tinted the body colour.
function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  // (1 - r)^2, sampled: the lamp map's pool is a smooth falloff too, and a linear one reads as a spotlight.
  for (let k = 0; k <= 8; k++) {
    const r = k / 8
    const a = Math.round((1 - r) * (1 - r) * 255)
    grad.addColorStop(r, `rgba(255,255,255,${a / 255})`)
  }
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  return t
}
const poolMap = glowTexture()
// One material per pool, so each can follow its own flicker group.
const poolMaterial = () => new THREE.MeshBasicMaterial({ map: poolMap, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
const poolGeo = new THREE.PlaneGeometry(2, 2)
const pools = new THREE.Group()
scene.add(pools)

// --- the flames -------------------------------------------------------------

const CAPACITY = 16
const flames = new Flames(CAPACITY, params)
scene.add(flames.group)

// Per flame: phase, group, and the foot it stands on, laid out by `count` and `spacing`.
const rand = (() => { let s = 11; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 } })()
const feet = Array.from({ length: CAPACITY }, (_, i) => ({ phase: rand() * Math.PI * 2, group: i % 3 }))

// --- context props ----------------------------------------------------------
// What the flame sits on, per preset: a post, a bracket on a wall, or a ring of stones and logs. Rough shapes at the right size, so the flame is judged against something it will actually stand on.

const WOOD = new THREE.MeshLambertMaterial({ color: 0x2a1c10 })
const HIDE = new THREE.MeshLambertMaterial({ color: 0x3a2a1a, side: THREE.DoubleSide })
const STONE = new THREE.MeshLambertMaterial({ color: 0x3a3a3c })
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
    hood.position.y = flameY + params.height * (1 + OVERHANG) + 0.08
    context.add(post, dish, hood)
  } else if (kind === 'torch') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 0.4), WALL)
    wall.position.set(0, 1.5, 0.45)
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), STONE)
    bracket.position.set(0, flameY - 0.2, 0.12)
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.5, 6), WOOD)
    handle.position.set(0, flameY - 0.2, 0)
    handle.rotation.x = 0.35
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

function layout() {
  const kind = params.context
  const flameY = kind === 'post' ? 1.62 : kind === 'torch' ? 1.7 : 0.18
  const count = Math.round(params.count)
  const x0 = -((count - 1) * params.spacing) / 2
  flames.set(params)
  for (let i = 0; i < count; i++) {
    const x = x0 + i * params.spacing
    flames.place(i, x, flameY, 0, { height: params.height, radius: params.radius, phase: feet[i].phase, group: feet[i].group, yaw: params.yaw })
  }
  flames.mesh.count = count
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
    const d = Math.max(2.4, params.height * 3.5)
    camera.position.set(d * 0.5, flameY + params.height * 0.5 + d * 0.15, d)
  }
  const bg = params.bg
  renderer.setClearColor(new THREE.Color(0.02 + bg * 0.4, 0.03 + bg * 0.55, 0.06 + bg * 0.9))
  drawNoise()
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
    out.textContent = step >= 1 ? Math.round(params[key]) : Number(params[key]).toFixed(2)
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
  const show = () => {
    // The picker speaks sRGB; the shader wants linear. THREE.Color converts both ways.
    input.value = '#' + tmpColor.setRGB(...params[key]).getHexString()
  }
  readouts[key] = show
  input.addEventListener('input', () => {
    tmpColor.setStyle(input.value)
    params[key] = [tmpColor.r, tmpColor.g, tmpColor.b]
    show()
    layout()
  })
  colorsEl.appendChild(row)
}

function showAll() {
  for (const k in readouts) readouts[k]()
}

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
// Every knob as one object literal, shader keys first, so a tuned look can be pasted straight into FIRE / a preset.
document.getElementById('copy').addEventListener('click', async (e) => {
  const keys = [...SLIDERS.map((r) => r[1]), ...COLORS.map((r) => r[0])]
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
const fillEl = document.getElementById('fill')
const rows = (el, pairs) => { el.innerHTML = pairs.map(([k, v]) => `<tr><td class="k">${k}</td><td class="n">${v}</td></tr>`).join('') }

function drawNoise() {
  const c = document.getElementById('noise')
  const g = c.getContext('2d')
  const img = g.createImageData(64, 64)
  const src = flames.noise.image.data
  for (let i = 0; i < 64 * 64; i++) {
    img.data[i * 4] = src[i * 4]
    img.data[i * 4 + 1] = src[i * 4 + 1]
    img.data[i * 4 + 2] = 0
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
}

// The first flame's cards projected to framebuffer pixels: the octagon's area by the shoelace formula, summed over its sheets. This is the number every other cost is scaled by.
const _w = new THREE.Vector3(), _o = new THREE.Vector3(), _to = new THREE.Vector3()
function cardPixels(glow) {
  const m = new THREE.Matrix4()
  flames.mesh.getMatrixAt(0, m)
  _o.setFromMatrixPosition(m)
  const sx = params.radius, sy = params.height * (0.8 + 0.2 * glow)
  const W = renderer.domElement.width, H = renderer.domElement.height
  let total = 0, behind = false
  const sheets = Math.round(params.sheets)
  for (let s = 0; s < sheets; s++) {
    let right
    if (sheets === 1) {
      _to.copy(camera.position).sub(_o)
      _to.y = 0
      _to.normalize()
      right = [_to.z, 0, -_to.x]
    } else {
      const a = params.yaw + (s * Math.PI) / sheets
      right = [Math.cos(a), 0, Math.sin(a)]
    }
    const pts = CARD_OUTLINE.map(([x, y]) => {
      _w.set(_o.x + right[0] * x * sx, _o.y + y * sy, _o.z + right[2] * x * sx).project(camera)
      if (_w.z > 1) behind = true
      return [(_w.x * 0.5 + 0.5) * W, (_w.y * 0.5 + 0.5) * H]
    })
    let area = 0
    for (let k = 0; k < pts.length; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % pts.length]
      area += x0 * y1 - x1 * y0
    }
    total += Math.abs(area) / 2
  }
  return { px: behind ? 0 : total, W, H }
}

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
  flames.update(t, glow)
  _tint.setRGB(...params.hotColor)
  for (const pool of pools.children) pool.material.color.copy(_tint).multiplyScalar(params.glowGain * glow[pool.userData.group])
  renderer.render(scene, camera)

  frames++
  msAcc += dt * 1000
  if (now - lastPanel > 500) {
    const info = renderer.info.render
    rows(frameEl, [['ms', (msAcc / frames).toFixed(2)], ['fps', (1000 / (msAcc / frames)).toFixed(0)], ['draw calls', info.calls], ['triangles', info.triangles]])
    const { px, W, H } = cardPixels(glow[feet[0].group])
    rows(fillEl, [['card px', Math.round(px).toLocaleString()], ['of canvas', ((100 * px) / (W * H)).toFixed(2) + ' %'], ['canvas', `${W} x ${H}`], ['x ' + Math.round(params.count), Math.round(px * Math.round(params.count)).toLocaleString()]])
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
  // For the headless probe: the picture is on screen after two frames.
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__shot = true }))
} catch (e) {
  document.getElementById('err').textContent = String(e.stack || e)
  window.PROBE_ERR = String(e)
  throw e
}
