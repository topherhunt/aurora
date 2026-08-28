import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildCrab, crabTriangles, CRAB_DEFAULTS } from './props/crab.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { CRAB_SHELL, shellCell, CRAB_CELL_PX } from './props/crab-texture.js'
import { buildTextureArray, LAYER, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import crabSource from './props/crab.js?raw'
import textureSource from './props/crab-texture.js?raw'

// ---------------------------------------------------------------------------
// The procedural crab previewer (gen-crab.html).
//
// Mesh and texture only, matching the scope of props/crab.js -- no LOD ladder,
// no card, no scatter bank, because none of that exists yet for this prop.
// Same live-palette idea as gen-mushroom.html: the sheet is four numbers in
// an array, so a colour picker here regenerates a 64 px cell and re-uploads
// the layer between frames instead of just captioning a PNG.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

// --- slider spec ------------------------------------------------------------
const SLIDERS = [
  ['— size', 'height', 0.02, 0.4, 0.002, 'ground to the top of the carapace, in metres'],

  ['— carapace', 'shellWidth', 0.3, 0.9, 0.005, 'half-width side to side, relative to height'],
  [null, 'shellLength', 0.25, 0.8, 0.005, 'half-width front to back, relative to height'],
  [null, 'shellRise', 0.05, 0.7, 0.005, 'dome height above the rim'],
  [null, 'shellCurve', 0.8, 5, 0.05, '1 = conical, 2 = domed, 4+ = flat with a shoulder'],
  [null, 'bellyDepth', 0, 0.35, 0.005, 'how far the underside dishes down from the rim'],
  [null, 'bellyCurve', 0.6, 4, 0.05, 'where the belly dish happens across its own radius'],
  [null, 'shellPentagon', 0, 1, 0.02, '0 = plain ellipse, higher = wider front / tapered rear'],

  ['— eyestalks', 'eyeLength', 0.05, 0.7, 0.01, 'relative to shellLength'],
  [null, 'eyeRadius', 0.005, 0.06, 0.002, 'stalk radius'],
  [null, 'eyeBulb', 0, 0.12, 0.002, 'the eye bulb at the tip'],
  [null, 'eyeSpread', 0, 1.4, 0.02, 'angle between the two stalks at the mount'],
  [null, 'eyeLift', 0, 1.5, 0.02, 'launch angle up from horizontal'],

  ['— pincers', 'armLength', 0.1, 1.2, 0.01, 'relative to shellLength'],
  [null, 'armRadius', 0.01, 0.12, 0.002, 'arm radius at the mount'],
  [null, 'armTaper', 0, 0.9, 0.01, 'how much the arm thins toward the claw'],
  [null, 'armLift', -0.6, 1.2, 0.02, 'launch angle up from horizontal'],
  [null, 'armSplay', 0, 1.4, 0.02, 'angle outward from straight-forward'],
  [null, 'clawLength', 0.05, 0.7, 0.01, 'relative to shellLength'],
  [null, 'clawRadius', 0.005, 0.1, 0.002, 'claw prong radius at the base'],
  [null, 'clawGape', 0, 0.9, 0.02, 'half-angle between the two claw prongs'],
  [null, 'clawAsymmetry', 0, 0.7, 0.02, '0 = matched pincers, higher = one much bigger'],

  ['— legs', 'legPairs', 1, 5, 1, 'pairs of walking legs'],
  [null, 'legLength', 0.2, 1.4, 0.01, 'relative to shellWidth'],
  [null, 'legRadius', 0.005, 0.08, 0.002, 'leg radius at the mount'],
  [null, 'legTaper', 0.3, 0.98, 0.01, 'fraction the radius shrinks by, tip vs base'],
  [null, 'legSpan', 0.4, TAU * 0.6, 0.02, 'arc along each flank the legs fan across'],
  [null, 'legLift0', -0.4, 1.0, 0.02, 'initial angle above horizontal at the mount'],
  [null, 'legDroop', 0, 2.6, 0.02, 'additional downward bend accumulated to the tip'],

  ['— tiers', 'shellRadial', 8, 32, 1, 'columns around the carapace disc'],
  [null, 'shellCapRings', 1, 4, 1, 'rings apex to rim on the shell top'],
  [null, 'shellUnderRings', 1, 3, 1, 'rings axis to rim on the belly'],
  [null, 'limbCols', 3, 8, 1, 'columns around every tube -- leg, arm, claw, eyestalk'],
  [null, 'legSegments', 1, 4, 1, 'straight segments per leg'],
  [null, 'armSegments', 1, 3, 1, 'straight segments per pincer arm'],
]

const params = { ...CRAB_DEFAULTS }

// --- live palette -------------------------------------------------------
// Working copy of the sheet's cell specs, exactly the mushroom bench's
// pattern: edited here, read by nothing else. Shipped colours live in
// crab-texture.js; copy a hex out of the picker and paste it there to ship it.
const palette = {
  [LAYER.CRAB_SHELL]: CRAB_SHELL.map((s) => ({ ...s })),
}

const hex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
const unhex = (s) => [
  parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16),
]

// --- scene ----------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.005, 200)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / TAU

// The game's noon, same as every other bench, so a colour picked here is a
// colour picked under the light the crab will stand in.
scene.add(new THREE.DirectionalLight(0xfff3e2, 2.1))
scene.children[0].position.set(3, 5, 2)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------

const GROUND_SIZE = 30
const GROUND_TILE = 3

const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
scene.add(ground)

scene.fog = new THREE.Fog(0x0a1018, 6, 16)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.002
scene.add(grid)

const rule = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
scene.add(rule)

function placeRule() {
  const choices = [0.05, 0.1, 0.5, 1, 2]
  const ruleMetres = choices.find((c) => c >= params.height * 0.45) ?? 2
  const w = Math.max(0.004, ruleMetres * 0.02)
  rule.scale.set(w, ruleMetres, w)
  rule.position.set(-params.height * 3, ruleMetres / 2, -params.height * 2)
}

// --- material -----------------------------------------------------------

const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
material.customProgramCacheKey = () => 'gen-crab-array-wrap-v1'

const LAYER_STRIDE = TEX_SIZE * TEX_SIZE * 4
const CP = CRAB_CELL_PX

function layerPixels(layer) {
  return atlas.image.data.subarray(layer * LAYER_STRIDE, (layer + 1) * LAYER_STRIDE)
}

function paintCell(layer, cell, px) {
  const data = atlas.image.data
  const base = layer * LAYER_STRIDE
  const ox = (cell % 2) * CP
  const oy = Math.floor(cell / 2) * CP
  for (let y = 0; y < CP; y++) {
    data.set(px.subarray(y * CP * 4, (y + 1) * CP * 4), base + ((oy + y) * TEX_SIZE + ox) * 4)
  }
}

let uploadQueued = false
function repaint(layer, cell) {
  const spec = palette[layer][cell]
  paintCell(layer, cell, shellCell(spec))
  uploadQueued = true
}

// --- the crab ---------------------------------------------------------------

let mesh = null
let wireframe = false

function rebuild() {
  if (mesh) {
    mesh.geometry.dispose()
    scene.remove(mesh)
  }
  material.wireframe = wireframe
  material.needsUpdate = true

  const geo = buildCrab(params)
  mesh = new THREE.Mesh(geo, material)
  scene.add(mesh)

  placeRule()
  grid.scale.setScalar(Math.max(0.5, params.height * 8))
  scene.fog.near = params.height * 12
  scene.fog.far = params.height * 32

  return geo.userData.crab
}

// --- byte accounting ----------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

async function gzipped(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

let diskBytes = null

async function measureDisk() {
  const enc = new TextEncoder()
  const geo = enc.encode(crabSource)
  const tex = enc.encode(textureSource)
  diskBytes = {
    geo: geo.byteLength, geoGz: await gzipped(geo),
    tex: tex.byteLength, texGz: await gzipped(tex),
  }
}

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

function refresh() {
  const s = rebuild()
  const predicted = crabTriangles(params)
  const agrees = predicted === s.triangles ? 'yes' : `NO (${predicted})`
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${s.triangles}</span>`],
    ['vertices', s.vertices],
    ['height', `${(s.height * 100).toFixed(1)} cm`],
    ['spread', `${(s.spread * 100).toFixed(1)} cm`],
    ['geometry in RAM', fmt(geometryBytes(mesh.geometry))],
    ['formula agrees', agrees, agrees === 'yes' ? 'ok' : 'warn'],
  ])

  drawSheets()

  if (!diskBytes) return

  const src = diskBytes.geo + diskBytes.tex
  const srcGz = diskBytes.geoGz + diskBytes.texGz
  table(document.getElementById('mem'), [
    ['image files on disk', '<span class="big">0 B</span>', 'ok'],
    ['crab.js (the shape)', fmt(diskBytes.geo)],
    ['crab-texture.js (the colour)', fmt(diskBytes.tex)],
    ['total on disk', fmt(src)],
    ['gzipped over the wire', fmt(srcGz), 'ok'],
    ['1 sheet, in RAM', fmt(LAYER_STRIDE)],
    ['extra draw calls', '0', 'ok'],
    ['extra vertex attributes', '0', 'ok'],
  ])
  document.getElementById('memnote').innerHTML =
    `Not one byte of image ships. A carapace -- and every limb hanging off it -- is a mottled ` +
    `colour, cheap arithmetic, so storing a photograph of it would be storing the output of a ` +
    `function -- and the function is up there in the palette, live.`

  table(document.getElementById('source'), [
    ['scanned source photographs', '0', 'ok'],
    ['authored meshes', '0', 'ok'],
    ['build steps (npm run props)', '0', 'ok'],
    ['shapes reachable', `${SLIDERS.length - 6} knobs`],
  ])
  document.getElementById('sourcenote').textContent =
    'Mesh and texture only -- animation is a later phase, so the legs stand in a fixed pose.'
}

// --- the sheets panel -----------------------------------------------------

function drawSheets() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const w = canvas.width
  const h = canvas.height - 14

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')

  const px = layerPixels(LAYER.CRAB_SHELL)
  const img = new ImageData(TEX_SIZE, TEX_SIZE)
  for (let j = 0; j < TEX_SIZE * TEX_SIZE; j++) {
    const o = j * 4
    const row = TEX_SIZE - 1 - Math.floor(j / TEX_SIZE)
    const d = (row * TEX_SIZE + (j % TEX_SIZE)) * 4
    img.data[d] = px[o]
    img.data[d + 1] = px[o + 1]
    img.data[d + 2] = px[o + 2]
    img.data[d + 3] = 255
  }
  tctx.putImageData(img, 0, 0)
  ctx.drawImage(tmp, 0, 0, w, h)

  ctx.strokeStyle = 'rgba(10,16,26,.55)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h)
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2)
  ctx.stroke()

  const cx = (params.shellCell % 2) * (w / 2)
  const cy = (1 - Math.floor(params.shellCell / 2)) * (h / 2)
  ctx.strokeStyle = '#c9a227'
  ctx.lineWidth = 2
  ctx.strokeRect(cx + 1, cy + 1, w / 2 - 2, h / 2 - 2)

  ctx.fillStyle = '#7f96b8'
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('shell + limbs', w / 2, canvas.height - 3)
}

document.getElementById('swatchnote').innerHTML =
  'One sheet, 2&times;2 cells. Carapace and every limb read the same cell -- gold outlines the ' +
  'one this crab wears.'

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}

for (const [section, key, min, max, step, help] of SLIDERS) {
  if (section) {
    const h = document.createElement('h2')
    h.textContent = section.replace('— ', '')
    slidersEl.appendChild(h)
  }
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  readouts[key] = { input, out, step }
  const show = () => {
    out.textContent = step >= 1 ? Math.round(params[key]) : Number(params[key]).toFixed(3)
  }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show()
    refresh()
  })
  show()
  slidersEl.appendChild(row)
}

// --- palette panel ------------------------------------------------------

const paletteEl = document.getElementById('palette')

function chipRow(label, setCell) {
  const wrap = document.createElement('div')
  wrap.className = 'row'
  wrap.innerHTML = `<label title="click to wear this species">${label}</label>`
  const chips = document.createElement('span')
  chips.style.cssText = 'display:flex;gap:3px;flex:1'
  for (let i = 0; i < 4; i++) {
    const b = document.createElement('button')
    b.addEventListener('click', () => {
      setCell(i)
      syncPalette()
      refresh()
    })
    chips.appendChild(b)
  }
  wrap.appendChild(chips)
  paletteEl.appendChild(wrap)
  return chips
}

function paintChip(btn, spec, selected) {
  btn.style.cssText =
    'width:22px;height:22px;padding:0;border-radius:3px;cursor:pointer;' +
    `background:${hex(spec.base)};` +
    (selected ? 'outline:2px solid #c9a227;outline-offset:1px;border-color:#c9a227'
              : 'outline:none')
  btn.title = spec.name
}

function colorRow(label, get, set, help) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label title="${help}">${label}</label>`
  const c = document.createElement('input')
  c.type = 'color'
  c.style.cssText = 'flex:1;min-width:0;height:22px;padding:0;cursor:pointer'
  c.value = get()
  c.addEventListener('input', () => { set(c.value); refresh() })
  row.appendChild(c)
  paletteEl.appendChild(row)
  return c
}

// One species chip sets the one cell the whole crab wears -- carapace, legs,
// arms and eyestalks all read it through their own chart.
const speciesChips = chipRow('species', (i) => { params.shellCell = i })
const shellColor = colorRow('colour', () => hex(palette[LAYER.CRAB_SHELL][params.shellCell].base), (v) => {
  palette[LAYER.CRAB_SHELL][params.shellCell].base = unhex(v)
  repaint(LAYER.CRAB_SHELL, params.shellCell)
}, 'repaints the 64 px cell and re-uploads the layer, live')
const shellAccent = colorRow('mottle', () => hex(palette[LAYER.CRAB_SHELL][params.shellCell].accent), (v) => {
  palette[LAYER.CRAB_SHELL][params.shellCell].accent = unhex(v)
  repaint(LAYER.CRAB_SHELL, params.shellCell)
}, 'the blotches over the base colour')

function syncPalette() {
  ;[...speciesChips.children].forEach((b, i) => {
    paintChip(b, palette[LAYER.CRAB_SHELL][i], i === params.shellCell)
  })
  shellColor.value = hex(palette[LAYER.CRAB_SHELL][params.shellCell].base)
  shellAccent.value = hex(palette[LAYER.CRAB_SHELL][params.shellCell].accent)
}

// --- seed / reset ---------------------------------------------------------

function syncSliders() {
  for (const [, key] of SLIDERS) {
    const r = readouts[key]
    r.input.value = params[key]
    r.out.textContent = r.step >= 1 ? Math.round(params[key]) : Number(params[key]).toFixed(3)
  }
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

function frame() {
  const h = params.height
  controls.target.set(0, h * 0.45, 0)
  camera.position.set(h * 3.2, h * 2.4, h * 4.2)
}

function toggle(id, get, set) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    refresh()
  })
}
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, CRAB_DEFAULTS, { seed: params.seed })
  CRAB_SHELL.forEach((s, i) => {
    palette[LAYER.CRAB_SHELL][i] = { ...s }
    repaint(LAYER.CRAB_SHELL, i)
  })
  syncSliders()
  syncPalette()
  frame()
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

syncPalette()
frame()
refresh()
measureDisk().then(refresh)

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  if (uploadQueued) {
    atlas.needsUpdate = true
    uploadQueued = false
  }
  controls.update(dt)
  renderer.render(scene, camera)
})
