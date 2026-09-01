import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTree, TREE_DEFAULTS, TREE_SPECIES } from './props/tree.js'
import { buildTextureArray, loadImageLayers, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// The limb-card bench (gen-tree-v2a.html).
//
// One tree, built the v2a way: v2's warped cut and metre-spaced walk, plus ONE
// card per limb drawn before its small sprays -- stem corner on the trunk, tip
// at the branch tip, so the card's stem-to-tip crease is the branch itself.
//
// WHAT THE PAGE IS FOR. A spray card costs its screen area whatever is in it --
// a transparent texel still runs the fragment shader and then discards -- so the
// question is not how many triangles a crown spends but how much overlapping
// card area it needs to read as foliage. One limb-length card at 60% opaque
// covers a branch that four small ones only half-cover, and the small ones can
// then be thinned until the limb card is doing most of the work. `sprayEvery`,
// `limbTopThin` and the card counts are the whole experiment.
//
// The wood is still drawn. Set `branchSides` to 0 to see the crown without it --
// under 3 sides tree.js draws no limb cone at all, and whether the branches are
// missed is the second thing this page can answer.
// ---------------------------------------------------------------------------

// --- slider spec ------------------------------------------------------------
// The limb card's own knobs first, then the small sprays', then the shape knobs
// both trees share. Shape is tuned on /gen-tree; here it only re-poses the
// question at a different branch length or droop.
const SLIDERS = [
  ['#', 'the limb card'],
  ['limbFoldMin', 0, 1.2, 0.02, 'radians. The fold is drawn between this and limbFoldMax, and never opens upward -- this card is the branch. 0.35 is 20 degrees'],
  ['limbFoldMax', 0, 1.2, 0.02, 'the other end of it. 0.70 is 40 degrees'],
  ['limbTilt', 0, 1.2, 0.05, 'radians of random roll about its own crease, either way. This is the whole of "not quite level" -- the crease itself always runs the branch'],
  ['branchSides', 0, 6, 1, 'sides on the limb cone. Under 3 there is no branch wood at all, which is the question of whether the limb card can BE the branch'],

  ['#', 'the small sprays'],
  ['sprayEvery', 0.15, 3, 0.05, 'metres of limb between them, at the foot of the tree. Push this up until the limb card is carrying the branch on its own'],
  ['limbTopThin', 0, 6, 0.25, 'sprayEvery is multiplied by 1 + this x how high up the tree the limb starts, so at 2 they are three times as far apart at the top as at the foot'],
  ['limbTopDroop', 0, 1.5, 0.05, 'and sprayDown gains this x the same, so they hang steeper up there. The two together are what keeps the top pointy'],
  ['sprayEveryVary', 0, 1, 0.05, 'jitter on each gap, as a fraction of it. 0 is a comb'],
  ['sprayFoldMax', 0, 1.05, 0.02, 'their own crease angle, drawn from 0 to here'],

  ['#', 'both trees'],
  ['height', 2, 24, 0.5, 'metres, root to tip'],
  ['sprayMetres', 0.2, 3.5, 0.05, 'how big a SMALL spray is in the world. The limb card ignores it -- its size is the branch'],
  ['branchLength', 0.1, 0.8, 0.02, 'limb length as a fraction of height, which is now also the limb card length'],
  ['branches', 4, 40, 1, 'limbs, stated at heightRef'],
  ['sprayVary', 0, 0.8, 0.05, 'per-card size jitter on the small sprays'],
  ['sprayLift', -0.5, 1, 0.05, 'how much a small spray is stood up toward the sky'],
  ['sprayDown', 0, 1, 0.05, 'and how much it is hung below the limb, before limbTopDroop adds to it'],
]

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.25 * 60) / (2 * Math.PI)

const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const GROUND_SIZE = 600
const GROUND_TILE = 3
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
scene.add(
  new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: groundTex })
  )
)
scene.fog = new THREE.Fog(0x0a1018, 60, 260)

let grid = null

const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 1.7, 0.25),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(0, 0.85, 0)
scene.add(rule)

// --- material ---------------------------------------------------------------
//
// The real prop material with wrap diffuse CHAINED onto the array patch rather
// than assigned over it -- assigning would drop the sampler2DArray patch and
// render every prop untextured white. No billboardLayers: nothing here is an
// impostor, and compiling a spin for layers nothing wears would only be a
// difference from the game.
const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
material.customProgramCacheKey = () => 'gen-tree-array-wrap-v1'

let layersLoaded = false
const layersReady = loadImageLayers(atlas).then((n) => {
  layersLoaded = true
  return n
})

function layerPixels(layer) {
  const stride = TEX_SIZE * TEX_SIZE * 4
  return atlas.image.data.subarray(layer * stride, (layer + 1) * stride)
}

// --- the tree ---------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

let speciesKey = 'pine'
let params = {}
let seed = 1
let showGrid = false
let wireframe = false

function defaults() {
  return { ...TREE_DEFAULTS, ...TREE_SPECIES[speciesKey].params }
}

// The warped cut and its layer come off the species' own v2 block rather than
// being written here, so this page and the game cannot disagree about which cut
// is which. sprayV2a needs sprayV2, which is what that block turns on.
function treeOptions() {
  const sp = TREE_SPECIES[speciesKey]
  if (!sp.v2) throw new Error(`${speciesKey} has no v2 block; gen-layers.mjs prints its sprayQuad`)
  return {
    ...params, seed,
    barkLayer: sp.barkLayer, leafLayer: sp.v2.leafLayer, ...sp.v2.params,
    sprayV2a: true,
  }
}

let stats = null

function refresh() {
  for (const c of group.children.slice()) {
    group.remove(c)
    c.geometry.dispose()
  }
  material.wireframe = wireframe

  const geo = buildTree(treeOptions())
  stats = geo.userData.tree
  group.add(new THREE.Mesh(geo, material))

  // Just clear of the foliage, so the rule reads as a person standing next to
  // the tree rather than one buried in it.
  rule.position.x = -(stats.crownWidth / 2 + 0.8)

  if (grid) {
    scene.remove(grid)
    grid.dispose()
    grid = null
  }
  if (showGrid) {
    grid = new THREE.GridHelper(40, 40, 0x2b4a72, 0x18293f)
    scene.add(grid)
  }

  drawCounts()
  drawCut()
}

// The camera is only re-framed when the tree is REPLACED -- a species, a reset,
// the first build. Doing it on every slider drag would yank the view out from
// under an orbit mid-comparison, which is the one thing this page is for.
function frame() {
  const h = stats.height
  controls.target.set(0, h * 0.45, 0)
  camera.position.set(0, h * 0.55, h * 1.9)
  controls.update(0)
}

// --- the counts panel -------------------------------------------------------

function drawCounts() {
  const t = stats
  // One limb card per limb, drawn before that limb's small sprays, so the limb
  // count IS the limb-card count and the rest of the cards are small ones.
  const rows = [
    ['limb cards', t.limbs],
    ['small sprays', t.sprays - t.limbs],
    ['all cards', t.sprays],
    ['spray tris', t.sprayTris],
    ['wood tris', t.trunkTris + t.branchTris + t.rootTris],
    ['total tris', t.triangles],
    ['vertices', t.vertices],
    ['height', t.height.toFixed(2) + ' m'],
    ['crown width', t.crownWidth.toFixed(2) + ' m'],
    ['small spray size', t.sprayMetres.toFixed(2) + ' m'],
  ]
  document.getElementById('geo').innerHTML = rows
    .map((r) => `<tr><td class="k">${r[0]}</td><td class="n">${r[1]}</td></tr>`)
    .join('')
}

// --- the cut swatch ---------------------------------------------------------

const ALPHA_CUT = 128

function opaqueFraction(px) {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] >= ALPHA_CUT) n++
  return n / (px.length / 4)
}

function drawCut() {
  const cv = document.getElementById('cuts')
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  const layer = TREE_SPECIES[speciesKey].v2.leafLayer
  const px = layerPixels(layer)
  const S = TEX_SIZE
  const colour = ctx.createImageData(S, S)
  const alpha = ctx.createImageData(S, S)
  for (let i = 0; i < S * S; i++) {
    const p = i * 4
    colour.data[p] = px[p]
    colour.data[p + 1] = px[p + 1]
    colour.data[p + 2] = px[p + 2]
    colour.data[p + 3] = 255
    const a = px[p + 3] >= ALPHA_CUT ? 255 : 0
    alpha.data[p] = alpha.data[p + 1] = alpha.data[p + 2] = a
    alpha.data[p + 3] = 255
  }
  ctx.putImageData(colour, 0, 0)
  ctx.putImageData(alpha, S + 8, 0)
  ctx.fillStyle = '#cfe3ff'
  ctx.font = '11px monospace'
  ctx.fillText(`${(opaqueFraction(px) * 100).toFixed(0)}% opaque`, 2, S + 14)
  if (!layersLoaded) {
    ctx.fillStyle = '#7f96b8'
    ctx.fillText('procedural stand-in -- art still loading', 2, S + 30)
  }
}

// --- controls ---------------------------------------------------------------

const sliderEls = new Map()

function buildSliders() {
  const host = document.getElementById('sliders')
  host.innerHTML = ''
  sliderEls.clear()
  for (const s of SLIDERS) {
    if (s[0] === '#') {
      const h = document.createElement('h2')
      h.textContent = s[1]
      host.appendChild(h)
      continue
    }
    const [key, min, max, step, help] = s
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML =
      `<label title="${help.replace(/"/g, '&quot;')}">${key}</label>` +
      `<input type="range" min="${min}" max="${max}" step="${step}" />` +
      `<span class="v"></span>`
    const input = row.querySelector('input')
    const out = row.querySelector('.v')
    input.addEventListener('input', () => {
      params[key] = parseFloat(input.value)
      out.textContent = input.value
      refresh()
    })
    host.appendChild(row)
    sliderEls.set(key, { input, out })
  }
}

function syncSliders() {
  for (const [key, el] of sliderEls) {
    const v = params[key]
    if (!Number.isFinite(v)) throw new Error(`slider ${key} has no numeric value in params`)
    el.input.value = v
    el.out.textContent = el.input.value
  }
}

function loadSpecies() {
  params = defaults()
  syncSliders()
  refresh()
  frame()
}

const speciesSel = document.getElementById('species')
for (const k of Object.keys(TREE_SPECIES)) {
  const o = document.createElement('option')
  o.value = k
  o.textContent = TREE_SPECIES[k].label
  speciesSel.appendChild(o)
}
speciesSel.value = speciesKey
speciesSel.addEventListener('change', () => {
  speciesKey = speciesSel.value
  loadSpecies()
})

const seedInput = document.getElementById('seed')
seedInput.addEventListener('input', () => {
  seed = parseInt(seedInput.value, 10) || 0
  refresh()
})
document.getElementById('reroll').addEventListener('click', () => {
  seed = (seed + 1) >>> 0
  seedInput.value = seed
  refresh()
})

function toggle(id, get, set) {
  const b = document.getElementById(id)
  const paint = () => b.classList.toggle('on', !!get())
  b.addEventListener('click', () => {
    set(!get())
    paint()
    refresh()
  })
  paint()
}
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', loadSpecies)

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

buildSliders()
loadSpecies() // which frames the camera on the tree it just built
// Not top-level await: the build target is es2020. The procedural stand-in is on
// screen until the art lands, and the cut panel says so while it is.
layersReady.then(() => refresh())

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
