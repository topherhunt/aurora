import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTree, TREE_DEFAULTS, TREE_SPECIES } from './props/tree.js'
import { buildTextureArray, loadImageLayers, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// The leaf-scheme bench (gen-tree-v2.html).
//
// One question, asked as directly as it can be asked: same species, same seed,
// same wood, one crown built the old way and one the new, standing next to each
// other under the same sun. Everything this page draws that is not a leaf card
// is here to make the comparison fair rather than to be looked at.
//
// WHAT SEPARATES THE TWO TREES, and nothing else does:
//
//   v1  a rectangle of the BOXED cut, `sprays` of them per limb, hung by the
//       stem pixel measured off the art, folded about the diagonal its two
//       triangles already share.
//
//   v2  a quad of the WARPED cut, built on the four corners gen-layers.mjs
//       projected the art from -- so drawing it undoes the projection -- one
//       every `sprayEvery` metres of limb, stem corner seated on the wood, and
//       creased stem-to-tip rather than corner-to-corner.
//
// Both trees walk the SAME rng stream: tree.js draws v2's fold off the stream
// v1's fold used, and v2's seat walk is the only new draw. So a difference you
// can see between these two trees is a difference between the schemes, not two
// different trees that happen to share a seed. The limbs are identical.
//
// The counts panel reads geometry.userData.tree rather than resolveTree,
// because v2's card count falls out of limb length and the triangle law cannot
// predict it. That is stated on the page too, so nobody reads the law's spray
// line as this crown's bill.
// ---------------------------------------------------------------------------

// --- slider spec ------------------------------------------------------------
// The v2 knobs first, because they are what this page is for, then the shape
// knobs BOTH schemes share -- those are here so the comparison can be re-judged
// at a different spray size or droop, not so they can be tuned here. Tune shape
// on /gen-tree; this page only answers which cut and which spacing.
const SLIDERS = [
  ['#', 'v2 only'],
  ['sprayEvery', 0.15, 2, 0.05, 'metres of limb between spray stems. The count falls out of this and the limb length, which is the whole point: a long branch carries more foliage because it is longer'],
  ['sprayEveryVary', 0, 1, 0.05, 'jitter on each gap, as a fraction of it. 0 is a comb; the default 0.5 is an irregular row'],
  ['sprayFoldMax', 0, 1.05, 0.02, 'radians. The crease angle is drawn uniformly from 0 to here -- 0.52 is 30 degrees'],
  ['sprayFoldDown', 0, 1, 0.05, 'how often the crease opens DOWNWARD, the way a spray carrying its own weight does. The rest open up, which is what stops a crown reading as one gesture'],

  ['#', 'both schemes'],
  ['height', 2, 24, 0.5, 'metres, root to tip. Both trees get it'],
  ['sprayMetres', 0.4, 3.5, 0.05, 'how big one spray is in the world, at heightRef'],
  ['sprayVary', 0, 0.8, 0.05, 'per-card size jitter'],
  ['sprayJitter', 0, 2, 0.05, 'radians of random roll about the card\'s own up axis'],
  ['sprayOut', 0, 1.4, 0.05, 'how far the card is pushed out from the limb axis'],
  ['sprayLift', -0.5, 1, 0.05, 'how much the card is stood up toward the sky'],
  ['sprayDown', 0, 1, 0.05, 'how much it is hung below the limb'],
  ['sprays', 1, 14, 1, 'v1 ONLY -- cards per limb. v2 ignores it and spaces by sprayEvery instead'],
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

// The game's noon, same as the other benches: two crowns judged under different
// light are not being compared.
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
// The real prop material, patched the way the game patches it, with wrap
// diffuse chained on rather than assigned over -- assigning would drop the
// sampler2DArray patch and render every prop untextured white. No
// `billboardLayers`: this page draws no impostors, and a spin compiled in for
// layers nothing here wears would only be a difference from the game.
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

// --- the two trees ----------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

let speciesKey = 'pine'
let params = {}
let seed = 1
let showGrid = false
let wireframe = false
let showV1 = true
let showV2 = true

function defaults() {
  return { ...TREE_DEFAULTS, ...TREE_SPECIES[speciesKey].params }
}

// The two option sets, differing only in the leaf scheme. v2's `leafLayer` and
// `sprayQuad` come off the species' own `v2` block rather than being written
// here, so this page and the game cannot disagree about which cut is which.
function optionsFor(scheme) {
  const sp = TREE_SPECIES[speciesKey]
  const base = { ...params, seed, barkLayer: sp.barkLayer, leafLayer: sp.leafLayer }
  if (scheme === 'v1') return base
  if (!sp.v2) throw new Error(`${speciesKey} has no v2 block; gen-layers.mjs prints its sprayQuad`)
  return { ...base, leafLayer: sp.v2.leafLayer, ...sp.v2.params }
}

// Far enough apart that neither crown reaches into the other, and both centred
// on the rule so the eye has one vertical reference between them.
const SPREAD = 0.75 // of the taller crown's width, either side of centre

let stats = { v1: null, v2: null }

function refresh() {
  for (const c of group.children.slice()) {
    group.remove(c)
    c.geometry.dispose()
  }

  material.wireframe = wireframe

  const built = {}
  for (const scheme of ['v1', 'v2']) {
    const geo = buildTree(optionsFor(scheme))
    built[scheme] = geo
    stats[scheme] = geo.userData.tree
  }

  const gap = Math.max(
    2.5,
    SPREAD * Math.max(built.v1.userData.tree.crownWidth, built.v2.userData.tree.crownWidth)
  )
  for (const scheme of ['v1', 'v2']) {
    if (scheme === 'v1' ? !showV1 : !showV2) {
      built[scheme].dispose()
      continue
    }
    const mesh = new THREE.Mesh(built[scheme], material)
    mesh.position.x = scheme === 'v1' ? -gap : gap
    group.add(mesh)
  }

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
  drawCuts()
}

// --- the counts panel -------------------------------------------------------

function drawCounts() {
  const a = stats.v1
  const b = stats.v2
  const rows = [
    ['sprays', a.sprays, b.sprays],
    ['spray tris', a.sprayTris, b.sprayTris],
    ['wood tris', a.trunkTris + a.branchTris + a.rootTris, b.trunkTris + b.branchTris + b.rootTris],
    ['total tris', a.triangles, b.triangles],
    ['vertices', a.vertices, b.vertices],
    ['limbs', a.limbs, b.limbs],
    ['crown width', a.crownWidth.toFixed(2) + ' m', b.crownWidth.toFixed(2) + ' m'],
    ['spray size', a.sprayMetres.toFixed(2) + ' m', b.sprayMetres.toFixed(2) + ' m'],
  ]
  const pct = (b.triangles - a.triangles) / a.triangles
  document.getElementById('geo').innerHTML =
    '<tr><th>&nbsp;</th><th>v1</th><th>v2</th></tr>' +
    rows
      .map(
        (r) =>
          `<tr><td class="k">${r[0]}</td><td class="n">${r[1]}</td><td class="n">${r[2]}</td></tr>`
      )
      .join('') +
    `<tr><td class="k">v2 triangles</td><td class="n" colspan="2">` +
    `<span class="${pct <= 0 ? 'ok' : 'warn'}">${pct >= 0 ? '+' : ''}${(pct * 100).toFixed(0)}%` +
    `</span></td></tr>`
}

// --- the cut swatches -------------------------------------------------------
//
// Both cuts at once, colour over alpha, with the opaque fraction measured at the
// SAME cutoff the cards are drawn at -- the alpha pane is the one that matters,
// because a leaf card is almost entirely its silhouette.
const ALPHA_CUT = 128

function opaqueFraction(px) {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] >= ALPHA_CUT) n++
  return n / (px.length / 4)
}

function drawCuts() {
  const cv = document.getElementById('cuts')
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  const sp = TREE_SPECIES[speciesKey]
  const cells = [
    ['v1', sp.leafLayer, 0],
    ['v2', sp.v2.leafLayer, 1],
  ]
  const S = 128
  for (const [label, layer, col] of cells) {
    const px = layerPixels(layer)
    const colour = ctx.createImageData(S, S)
    const alpha = ctx.createImageData(S, S)
    for (let i = 0; i < S * S; i++) {
      const p = i * 4
      colour.data[p] = px[p]
      colour.data[p + 1] = px[p + 1]
      colour.data[p + 2] = px[p + 2]
      colour.data[p + 3] = 255
      const a = px[p + 3]
      alpha.data[p] = alpha.data[p + 1] = alpha.data[p + 2] = a >= ALPHA_CUT ? 255 : 0
      alpha.data[p + 3] = 255
    }
    ctx.putImageData(colour, col * (S + 8), 0)
    ctx.putImageData(alpha, col * (S + 8), S)
    ctx.fillStyle = '#cfe3ff'
    ctx.font = '11px monospace'
    ctx.fillText(
      `${label} ${(opaqueFraction(px) * 100).toFixed(0)}% opaque`,
      col * (S + 8) + 2,
      S * 2 - 4
    )
  }
  if (!layersLoaded) {
    ctx.fillStyle = '#7f96b8'
    ctx.fillText('procedural stand-ins -- art still loading', 2, 12)
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
toggle('v1', () => showV1, (v) => { showV1 = v })
toggle('v2', () => showV2, (v) => { showV2 = v })
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

camera.position.set(0, 6, 22)
controls.target.set(0, 4, 0)

buildSliders()
loadSpecies()
// Not top-level await: the build target is es2020. The procedural stand-ins are
// on screen until the art lands, and the cut panel says so while they are.
layersReady.then(() => refresh())

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
