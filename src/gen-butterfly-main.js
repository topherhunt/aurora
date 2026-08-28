import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildButterfly, butterflyTriangles, BUTTERFLY_DEFAULTS } from './props/butterfly.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import {
  BUTTERFLY_WING, BUTTERFLY_BODY, wingCell, bodyCell, BUTTERFLY_CELL_PX,
} from './props/butterfly-texture.js'
import { buildTextureArray, LAYER, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import butterflySource from './props/butterfly.js?raw'
import textureSource from './props/butterfly-texture.js?raw'

// ---------------------------------------------------------------------------
// The procedural butterfly previewer (gen-butterfly.html).
//
// Mesh and texture only, same shape as gen-crab.html's bench -- but the brief
// here is the opposite of the crab's: the mesh stays as dumb as possible
// (props/butterfly.js's header explains why) and the interesting knobs are
// SIZE and COLOUR. "wild reroll" leans into that: it does not pick from a
// small fixed species table, it throws wingSpan across its whole slider
// range and every wing/body colour to a fresh random hue, then repaints the
// live texture cells to match -- so two rerolls rarely look like recoloured
// twins.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

const SLIDERS = [
  ['— size', 'wingSpan', 0.015, 0.15, 0.001, 'tip-to-tip wingspan, in metres'],

  ['— wings', 'wingChord', 0.3, 1.1, 0.01, 'fore/aft depth of a wing card, relative to its own half-span'],
  [null, 'wingAngle', 0, 1.5, 0.01, 'dihedral: 0 = flat and wide (gliding), high = folded upright (perched)'],
  [null, 'wingSweep', -0.3, 0.6, 0.01, 'rotation of the wing plane backward about the vertical axis'],
  [null, 'wingMount', 0.3, 0.85, 0.01, '0..1 along the body where the wings hinge'],

  ['— body', 'bodyLength', 0.3, 1.0, 0.01, 'relative to wingSpan'],
  [null, 'bodyRadius', 0.02, 0.12, 0.002, 'relative to bodyLength'],
  [null, 'headBulb', 0.15, 0.9, 0.01, 'head radius, relative to bodyRadius'],

  ['— antennae', 'antennaLength', 0.1, 1.0, 0.01, 'relative to bodyLength'],
  [null, 'antennaRadius', 0.03, 0.3, 0.01, 'relative to bodyRadius'],
  [null, 'antennaSpread', 0, 1.5, 0.02, 'angle between the two antennae at the mount'],
  [null, 'antennaLift', 0, 1.6, 0.02, 'launch angle up from horizontal'],
  [null, 'antennaCurl', -2, 2, 0.02, 'total bend accumulated along its length'],

  ['— tiers', 'bodySegments', 2, 8, 1, 'straight segments along the body tube'],
  [null, 'bodyCols', 3, 8, 1, 'columns around the body tube'],
  [null, 'antennaSegments', 1, 4, 1, 'straight segments per antenna'],
  [null, 'antennaCols', 3, 6, 1, 'columns around each antenna'],
]

const params = { ...BUTTERFLY_DEFAULTS }
params.bodyCell = params.wingCell + 2 // mirrors the pairing buildButterfly derives internally

// --- live palette -------------------------------------------------------
// Working copies of the wing and body cell specs -- edited here, read by
// nothing else. Shipped colours live in butterfly-texture.js.
const palette = {
  wing: BUTTERFLY_WING.map((s) => ({ ...s, base: [...s.base], edge: [...s.edge], accent: [...s.accent] })),
  body: BUTTERFLY_BODY.map((s) => ({ ...s, base: [...s.base], accent: [...s.accent] })),
}

const hex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
const unhex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// --- scene ----------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.002, 200)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / TAU

scene.add(new THREE.DirectionalLight(0xfff3e2, 2.1))
scene.children[0].position.set(3, 5, 2)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------

const GROUND_SIZE = 20
const GROUND_TILE = 2

const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
scene.add(ground)

scene.fog = new THREE.Fog(0x0a1018, 3, 10)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.001
scene.add(grid)

const rule = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
scene.add(rule)

function placeRule() {
  const choices = [0.01, 0.02, 0.05, 0.1, 0.5, 1]
  const ruleMetres = choices.find((c) => c >= params.wingSpan * 0.6) ?? 1
  const w = Math.max(0.0015, ruleMetres * 0.02)
  rule.scale.set(w, ruleMetres, w)
  rule.position.set(-params.wingSpan * 3, ruleMetres / 2, -params.wingSpan * 2.2)
}

// --- material -----------------------------------------------------------

const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
material.customProgramCacheKey = () => 'gen-butterfly-array-wrap-v1'

const LAYER_STRIDE = TEX_SIZE * TEX_SIZE * 4
const CP = BUTTERFLY_CELL_PX
const GRID2 = 2

function layerPixels() {
  return atlas.image.data.subarray(LAYER.BUTTERFLY_WING * LAYER_STRIDE, (LAYER.BUTTERFLY_WING + 1) * LAYER_STRIDE)
}

function paintCell(cell, px) {
  const data = atlas.image.data
  const base = LAYER.BUTTERFLY_WING * LAYER_STRIDE
  const ox = (cell % GRID2) * CP
  const oy = Math.floor(cell / GRID2) * CP
  for (let y = 0; y < CP; y++) {
    data.set(px.subarray(y * CP * 4, (y + 1) * CP * 4), base + ((oy + y) * TEX_SIZE + ox) * 4)
  }
}

let uploadQueued = false
function repaintWing(i) {
  paintCell(i, wingCell(palette.wing[i]))
  uploadQueued = true
}
function repaintBody(i) {
  paintCell(2 + i, bodyCell(palette.body[i]))
  uploadQueued = true
}

// --- the butterfly ---------------------------------------------------------

let mesh = null
let wireframe = false

function rebuild() {
  if (mesh) {
    mesh.geometry.dispose()
    scene.remove(mesh)
  }
  material.wireframe = wireframe
  material.needsUpdate = true

  const geo = buildButterfly(params)
  mesh = new THREE.Mesh(geo, material)
  scene.add(mesh)

  placeRule()
  grid.scale.setScalar(Math.max(0.3, params.wingSpan * 12))
  scene.fog.near = Math.max(0.5, params.wingSpan * 20)
  scene.fog.far = Math.max(2, params.wingSpan * 60)

  return geo.userData.butterfly
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
  const geo = enc.encode(butterflySource)
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
  const predicted = butterflyTriangles(params)
  const agrees = predicted === s.triangles ? 'yes' : `NO (${predicted})`
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${s.triangles}</span>`],
    ['vertices', s.vertices],
    ['wingspan', `${(s.wingSpan * 100).toFixed(1)} cm`],
    ['height', `${(s.height * 100).toFixed(1)} cm`],
    ['geometry in RAM', fmt(geometryBytes(mesh.geometry))],
    ['formula agrees', agrees, agrees === 'yes' ? 'ok' : 'warn'],
  ])

  drawSheet()

  if (!diskBytes) return

  const src = diskBytes.geo + diskBytes.tex
  const srcGz = diskBytes.geoGz + diskBytes.texGz
  table(document.getElementById('mem'), [
    ['image files on disk', '<span class="big">0 B</span>', 'ok'],
    ['butterfly.js (the shape)', fmt(diskBytes.geo)],
    ['butterfly-texture.js (the colour)', fmt(diskBytes.tex)],
    ['total on disk', fmt(src)],
    ['gzipped over the wire', fmt(srcGz), 'ok'],
    ['1 sheet, in RAM', fmt(LAYER_STRIDE)],
    ['extra draw calls', '0', 'ok'],
    ['extra vertex attributes', '0', 'ok'],
  ])
  document.getElementById('memnote').innerHTML =
    `The wing's whole silhouette -- not just its colour -- is an alpha-cutout texture, ` +
    `so the mesh never has to describe a wing outline. Two flat unsubdivided cards and a ` +
    `thin tube cost almost nothing; the variety is bought in the 64px cell instead.`

  table(document.getElementById('source'), [
    ['scanned source photographs', '0', 'ok'],
    ['authored meshes', '0', 'ok'],
    ['build steps (npm run props)', '0', 'ok'],
    ['shapes reachable', `${SLIDERS.length - 4} knobs`],
  ])
  document.getElementById('sourcenote').textContent =
    'Mesh and texture only -- wings are a fixed pose, not animated yet.'
}

// --- the sheet panel ------------------------------------------------------

function drawSheet() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#0e1726'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const size = canvas.height
  const px = layerPixels()
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
  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  tmp.getContext('2d').putImageData(img, 0, 0)

  const ox = (canvas.width - size) / 2
  ctx.drawImage(tmp, ox, 0, size, size)

  ctx.strokeStyle = 'rgba(10,16,26,.55)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(ox + size / 2, 0); ctx.lineTo(ox + size / 2, size)
  ctx.moveTo(ox, size / 2); ctx.lineTo(ox + size, size / 2)
  ctx.stroke()

  // Cell rows 0 (wing, packed at raw rows 0-63 = v 0..0.5) end up drawn at the
  // BOTTOM of the canvas here, because putImageData's row 0 is the top of the
  // canvas while the loop above flips v so v=0 lands at the bottom -- the
  // same v-flip every other bench's swatch canvas uses.
  const cellY = (i) => (1 - Math.floor(i / 2)) * (size / 2)

  const labels = ['wing 0', 'wing 1', 'body 0', 'body 1']
  ctx.fillStyle = '#7f96b8'
  ctx.font = '9px monospace'
  ctx.textAlign = 'left'
  for (let i = 0; i < 4; i++) {
    const cx = ox + (i % 2) * (size / 2)
    ctx.fillText(labels[i], cx + 3, cellY(i) + size / 2 - 3)
  }

  for (const active of [params.wingCell, params.bodyCell]) {
    const cx = ox + (active % 2) * (size / 2)
    ctx.strokeStyle = '#c9a227'
    ctx.lineWidth = 2
    ctx.strokeRect(cx + 1, cellY(active) + 1, size / 2 - 2, size / 2 - 2)
  }
}

document.getElementById('swatchnote').innerHTML =
  'One 128px layer, four 64px cells: two wing patterns (top) and their paired body tones ' +
  '(bottom) -- wing cell <em>i</em> always wears body cell <em>i</em>. Gold outlines the pair this butterfly wears.'

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
  wrap.innerHTML = `<label title="click to wear this pattern">${label}</label>`
  const chips = document.createElement('span')
  chips.style.cssText = 'display:flex;gap:3px;flex:1'
  for (let i = 0; i < 2; i++) {
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
    (selected ? 'outline:2px solid #c9a227;outline-offset:1px;border-color:#c9a227' : 'outline:none')
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

// Pattern chips set the wing cell -- the body cell is always paired by index
// (see props/butterfly.js), so there is nothing separate to pick there.
const patternChips = chipRow('pattern', (i) => { params.wingCell = i; params.bodyCell = i + 2 })
const wingBase = colorRow('wing colour', () => hex(palette.wing[params.wingCell].base), (v) => {
  palette.wing[params.wingCell].base = unhex(v)
  repaintWing(params.wingCell)
}, 'the wing ground colour')
const wingAccent = colorRow('wing accent', () => hex(palette.wing[params.wingCell].accent), (v) => {
  palette.wing[params.wingCell].accent = unhex(v)
  repaintWing(params.wingCell)
}, 'spots (pattern 0) or the ray highlight (pattern 1)')
const wingEdge = colorRow('wing margin', () => hex(palette.wing[params.wingCell].edge), (v) => {
  palette.wing[params.wingCell].edge = unhex(v)
  repaintWing(params.wingCell)
}, 'the darker rim colour every real wing has')
// palette.body is indexed 0/1, paired by index with the wing pattern -- not
// by params.bodyCell, which is the 2/3 texture-cell offset the mesh reads.
const bodyBase = colorRow('body colour', () => hex(palette.body[params.wingCell].base), (v) => {
  palette.body[params.wingCell].base = unhex(v)
  repaintBody(params.wingCell)
}, 'body and antennae both read this cell')

function syncPalette() {
  ;[...patternChips.children].forEach((b, i) => paintChip(b, palette.wing[i], i === params.wingCell))
  wingBase.value = hex(palette.wing[params.wingCell].base)
  wingAccent.value = hex(palette.wing[params.wingCell].accent)
  wingEdge.value = hex(palette.wing[params.wingCell].edge)
  bodyBase.value = hex(palette.body[params.wingCell].base)
}

// --- seed / wild reroll / reset --------------------------------------------

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

// "wild reroll": the brief's whole point. Size spans the full slider range
// (log-uniform, so small and large butterflies show up about equally often
// rather than the range being dominated by the big end) and every wing/body
// colour gets a fresh random hue -- not a pick from the small shipped table.
document.getElementById('reroll').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 100000)
  seedInput.value = params.seed

  const [lo, hi] = [0.015, 0.15]
  params.wingSpan = Math.exp(Math.log(lo) + Math.random() * (Math.log(hi) - Math.log(lo)))

  for (let i = 0; i < 2; i++) {
    const hue = Math.random() * 360
    const spread = 40 + Math.random() * 60
    const sat = 0.55 + Math.random() * 0.4
    palette.wing[i].base = hslToRgb(hue, sat, 0.35 + Math.random() * 0.25)
    palette.wing[i].accent = hslToRgb((hue + spread) % 360, sat, 0.55 + Math.random() * 0.35)
    palette.wing[i].edge = hslToRgb(hue, sat * 0.6, 0.08 + Math.random() * 0.1)
    palette.body[i].base = hslToRgb(hue, sat * 0.5, 0.1 + Math.random() * 0.08)
    palette.body[i].accent = hslToRgb((hue + spread) % 360, sat * 0.5, 0.18 + Math.random() * 0.1)
    repaintWing(i)
    repaintBody(i)
  }

  syncSliders()
  syncPalette()
  frame()
  refresh()
})

function frame() {
  const s = params.wingSpan
  controls.target.set(0, s * 0.6, 0)
  camera.position.set(s * 4.5, s * 3, s * 5.5)
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
  Object.assign(params, BUTTERFLY_DEFAULTS, { seed: params.seed })
  BUTTERFLY_WING.forEach((s, i) => {
    palette.wing[i] = { ...s, base: [...s.base], edge: [...s.edge], accent: [...s.accent] }
    repaintWing(i)
  })
  BUTTERFLY_BODY.forEach((s, i) => {
    palette.body[i] = { ...s, base: [...s.base], accent: [...s.accent] }
    repaintBody(i)
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
