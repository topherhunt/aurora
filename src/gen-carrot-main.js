import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildCarrotLeaves, CARROT_DEFAULTS } from './props/carrot.js'
import { loadCritterGlb } from './v2/render/critters.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// The carrot previewer (gen-carrot.html): the shipped Tripo root
// (gen-props/carrot.glb, tools/props/gen/ship.mjs) with props/carrot.js's
// leaves sprouting from its crown, under the game's noon. Two art files and
// one generator make the prop, so the page shows all three: the root map and
// the leaf cut as swatches, the leaves as sliders, and every knob as JSON so a
// look can be described in a message and a suggested set pasted back.
//
// The root is scaled to `rootHeight` here and the leaves are built in metres,
// so the metre rule is honest; the world will carry its own size band.
// ---------------------------------------------------------------------------

const ROOT_GLB = 'gen-props/carrot.glb'
const LEAF_PNG = 'gen-props/carrot-leaf.png'

// Ranges are chosen so both ends are things you might want, not so both are
// valid: `arch` past ~2.5 curls a leaf under itself, and seeing that is how
// you learn where the useful range stops.
const SLIDERS = [
  ['leaves', 1, 16, 1, 'how many leaves in the rosette'],
  ['segments', 2, 8, 1, 'quads along each leaf. Triangles per leaf = 2 x segments - 2'],
  ['rootHeight', 0.05, 0.5, 0.005, 'metres the Tripo root stands, tip to crown'],
  ['crownDrop', 0, 0.3, 0.005, 'fraction of the root height below its top the leaves sprout from'],
  ['leafLength', 0.05, 0.6, 0.005, 'metres, stem to tip along the ribbon'],
  ['lengthVar', 0, 0.8, 0.01, 'per-leaf length jitter'],
  ['widthScale', 0.3, 2.2, 0.01, 'multiplies the cut\'s own width'],
  ['pitch', 0.2, 1.55, 0.01, 'launch angle above horizontal (radians). High = upright'],
  ['arch', 0, 3.2, 0.01, 'total bend from launch to tip (radians). High = drooping'],
  ['curve', 0.3, 3, 0.05, 'where the bend concentrates. >1 = stiff base, floppy tip'],
  ['tipBias', 0.5, 3, 0.05, 'where the seams sit. >1 crowds them toward the tip; 1 is even'],
  ['pitchFalloff', 0, 0.9, 0.01, 'outer leaves launch flatter than inner ones'],
  ['yawJitter', 0, 1, 0.01, 'how far each leaf may wander off even spacing'],
  ['crownRadius', 0, 0.03, 0.001, 'metres the leaf bases sit from the axis'],
  ['crownRise', 0, 0.03, 0.001, 'metres the bases are stacked up the axis'],
  ['sway', 0, 1.2, 0.01, 'lateral drift, so a leaf leaves its plane'],
  ['roll', 0, 1.4, 0.01, 'twist of the leaf about its own axis'],
  ['alphaTest', 0.05, 0.95, 0.01, 'cutout threshold. Low = lacy and aliased, high = eats the leaflet tips'],
  ['brightness', 0.3, 3, 0.05, 'multiplies the leaf albedo; a material setting, not geometry'],
]

const defaults = () => ({
  ...CARROT_DEFAULTS,
  rootHeight: 0.2,
  crownDrop: 0.05,
  alphaTest: 0.5,
  brightness: 1.0,
})
const params = defaults()

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / (2 * Math.PI)

// The game's noon, as gen-fern.html has it.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const GROUND_SIZE = 24
const GROUND_TILE = 3
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
scene.add(new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
))
scene.fog = new THREE.Fog(0x0a1018, 11, 26)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.002
scene.add(grid)
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.02, 1, 0.02),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(-0.75, 0.5, -0.35)
scene.add(rule)

// --- materials --------------------------------------------------------------

const rootMaterial = new THREE.MeshLambertMaterial()
// Wrap diffuse chained on, as the fern bench does, so a leaf facing away from
// the sun reads as backlit rather than black.
const leafMaterial = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 })
leafMaterial.onBeforeCompile = (shader) => wrapLambert(shader)
leafMaterial.customProgramCacheKey = () => 'gen-carrot-wrap-v1'
// Wireframe as its own material, so an edge across a transparent texel is
// still drawn.
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x8fd48f, wireframe: true, fog: false })

// --- the art ----------------------------------------------------------------
//
// Both loads are unguarded on purpose: a missing file throws to #error and the
// page shows nothing, rather than a root without leaves passing for the prop.

const errorEl = document.getElementById('error')
const fail = (e) => { errorEl.textContent = String(e?.stack ?? e); throw e }

let root = null // { geometry (unit: the file's own), height, crown: {x, z}, map, tris }
let leafTex = null

const rootReady = loadCritterGlb(ROOT_GLB).then((a) => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(a.pos), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(a.nrm), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(a.uv), 2))
  geometry.setIndex(a.idx)
  geometry.computeBoundingBox()
  const height = geometry.boundingBox.max.y
  // The crown is the mean of the vertices in the top tenth of the root, which
  // on a 50-face pick is the stalk stub and the shoulder around it: the pick
  // is centred over its whole box, and a bowed root's top is off that axis.
  let sx = 0, sz = 0, n = 0
  for (let i = 0; i < a.pos.length; i += 3) {
    if (a.pos[i + 1] < height * 0.9) continue
    sx += a.pos[i]
    sz += a.pos[i + 2]
    n++
  }
  if (!n) throw new Error(`${ROOT_GLB}: no vertices in the top tenth`)
  root = { geometry, height, crown: { x: sx / n, z: sz / n }, map: a.map, tris: a.idx.length / 3 }
  rootMaterial.map = a.map
  rootMaterial.needsUpdate = true
}).catch(fail)

const leafReady = new THREE.TextureLoader().loadAsync(LEAF_PNG).then((tex) => {
  // File row 0 at v = 0, which is how carrot.js hands out its uvs.
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  leafTex = tex
  leafMaterial.map = tex
  leafMaterial.needsUpdate = true
}).catch(fail)

// --- the carrot -------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)
let wireframe = false
let showGrid = true
let leaves = null

function rebuild() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
  if (!root || !leafTex) return

  leafMaterial.alphaTest = params.alphaTest
  leafMaterial.color.setScalar(params.brightness)
  leafMaterial.needsUpdate = true

  const k = params.rootHeight / root.height
  const rootMesh = new THREE.Mesh(root.geometry.clone().scale(k, k, k), wireframe ? wireMaterial : rootMaterial)
  group.add(rootMesh)

  leaves = buildCarrotLeaves(params)
  const leafMesh = new THREE.Mesh(leaves, wireframe ? wireMaterial : leafMaterial)
  leafMesh.position.set(root.crown.x * k, params.rootHeight * (1 - params.crownDrop), root.crown.z * k)
  group.add(leafMesh)
}

function frame() {
  const h = params.rootHeight + params.leafLength
  controls.target.set(0, h * 0.5, 0)
  camera.position.set(h * 1.6, h * 1.1, h * 2.1)
}

// --- the panel --------------------------------------------------------------

function table(el, rows) {
  el.innerHTML = rows.map(([k, v, cls]) =>
    `<tr><td class="k">${k}</td><td class="n${cls ? ` ${cls}` : ''}">${v}</td></tr>`
  ).join('')
}

function report() {
  const geo = document.getElementById('geo')
  if (!root || !leafTex) {
    table(geo, [['loading', root ? 'leaf png' : 'root glb', 'warn']])
    return
  }
  const stats = leaves.userData.carrot
  const box = new THREE.Box3().setFromObject(group)
  const spread = 2 * Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z))
  table(geo, [
    ['height', `${(box.max.y - box.min.y).toFixed(3)} m`],
    ['spread', `${spread.toFixed(3)} m`],
    ['leaves', stats.leaves],
    ['leaf triangles', stats.triangles],
    ['root triangles', root.tris],
    ['total', stats.triangles + root.tris, 'ok'],
    ['root map', `${root.map.image.width} px`],
    ['leaf texture', `${leafTex.image.width} px`],
  ])
}

// Two panes of one image: its colour over mid grey, and its alpha alone.
function drawSwatch(id, image) {
  const canvas = document.getElementById(id)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const w = image.width, h = image.height
  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  const tctx = tmp.getContext('2d')
  tctx.drawImage(image, 0, 0)
  const px = tctx.getImageData(0, 0, w, h)
  const rgb = new ImageData(w, h)
  const alpha = new ImageData(w, h)
  for (let i = 0; i < w * h * 4; i += 4) {
    const a = px.data[i + 3] / 255
    for (let c = 0; c < 3; c++) rgb.data[i + c] = px.data[i + c] * a + 0x3a * (1 - a)
    rgb.data[i + 3] = 255
    alpha.data[i] = alpha.data[i + 1] = alpha.data[i + 2] = px.data[i + 3]
    alpha.data[i + 3] = 255
  }
  const half = canvas.width / 2
  ;[rgb, alpha].forEach((img, i) => {
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * half, 0, half, canvas.height)
  })
}

const paramsEl = document.getElementById('params')
const showParams = () => { paramsEl.value = JSON.stringify(params, null, 1).replace(/\n\s*/g, '\n ') }

function refresh() {
  rebuild()
  report()
  showParams()
  grid.visible = showGrid
  rule.visible = showGrid
}

const slidersEl = document.getElementById('sliders')
const readouts = {}
const showValue = (key) => {
  const { out, step } = readouts[key]
  out.textContent = step >= 1 ? params[key] : Number(params[key]).toFixed(step < 0.01 ? 3 : 2)
}
for (const [key, min, max, step, help] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  readouts[key] = { input, out: row.querySelector('.v'), step }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    showValue(key)
    refresh()
  })
  showValue(key)
  slidersEl.appendChild(row)
}
function syncSliders() {
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    showValue(key)
  }
  seedInput.value = params.seed
}

const seedInput = document.getElementById('seed')
seedInput.addEventListener('input', () => {
  params.seed = Number(seedInput.value) || 0
  refresh()
})
document.getElementById('reroll').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 100000)
  seedInput.value = params.seed
  refresh()
})

function toggle(id, get, set) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    refresh()
  })
}
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  // The seed is kept: reset undoes a slider hunt, and rerolling the plant at
  // the same time hides what the reset changed.
  Object.assign(params, defaults(), { seed: params.seed })
  syncSliders()
  frame()
  refresh()
})

document.getElementById('copy').addEventListener('click', () => {
  navigator.clipboard.writeText(paramsEl.value).catch(fail)
})
document.getElementById('apply').addEventListener('click', () => {
  // Unknown keys are refused rather than ignored: a typo'd knob that changes
  // nothing is the one that gets argued about.
  const patch = JSON.parse(paramsEl.value)
  const known = new Set([...SLIDERS.map((s) => s[0]), 'seed'])
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) fail(new Error(`apply: no knob "${key}"`))
    if (typeof patch[key] !== 'number') fail(new Error(`apply: ${key} is not a number`))
  }
  Object.assign(params, patch)
  syncSliders()
  refresh()
})

// --- run --------------------------------------------------------------------

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
frame()
refresh()
Promise.all([rootReady, leafReady]).then(() => {
  drawSwatch('leafSwatch', leafTex.image)
  drawSwatch('rootSwatch', root.map.image)
  refresh()
})

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
