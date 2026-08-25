import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE, TILE_METRES } from './textures.js'
import { createPropMaterial } from './material.js'
import { planBuilding, KINDS, WALL_STYLES, ROOF_KINDS } from './buildings/plan.js'
import { buildBuilding } from './buildings/building.js'
import { openEdges, signedVolume } from './buildings/parts.js'
import { grassTexture } from './preview-stage.js'
import { TRI_BUDGET, CALL_BUDGET } from './budget.js'

// ---------------------------------------------------------------------------
// The procedural building previewer (gen-building.html).
//
// Same argument as gen-fern.html: a generator is only as good as the RANGE it
// covers, and range is a seeing question. But a building is not a fern, and two
// things about it change what this page has to be.
//
// It is a grammar, not a parameter vector. A fern is fifteen sliders and every
// combination is a fern. A building is a set of DECISIONS -- shape, wall style,
// roof material -- that interact, and the failures are combinatorial: a
// half-timbered longhouse, a stone-based hut with no room for a plinth, an L
// whose wing lands on the porch. So the top of the panel is pickers, not
// sliders, each with an "auto" that hands the decision back to the seed, and
// the gallery exists to show twelve seeds arguing with each other at once.
//
// It runs THE REAL MATERIAL. Unlike gen-fern.html, which gives the fern its own
// texture and its own MeshLambertMaterial, this page builds the actual shared
// DataArrayTexture and the actual createPropMaterial(). It has to: the entire
// premise of the kit is that one array plus a per-vertex texLayer puts thatch,
// logs, stone and glass in a single draw call, and a previewer that faked that
// with four materials would be checking the one thing that is not in question
// while missing the one that is.
// ---------------------------------------------------------------------------

// --- what the panel can drive -----------------------------------------------
//
// Scales rather than absolutes, so a slider means the same thing across a hut
// and an inn and the kind tables stay the source of truth for proportion.
const SLIDERS = [
  ['areaScale', 0.5, 2.0, 0.01, 'multiplies the footprint area drawn for this kind'],
  ['ratioScale', 0.5, 1.8, 0.01, 'multiplies the long:short ratio. High = a range, low = a square block'],
  ['wallScale', 0.6, 1.6, 0.01, 'multiplies eave height. Low = a squat croft, high = a hall'],
  ['pitchScale', 0.5, 1.6, 0.01, 'multiplies roof pitch. Thatch needs a steep pitch to shed water -- under ~45 deg it stops reading as thatch'],
  ['overhang', 0, 0.9, 0.01, 'metres the roof projects past the wall. This is the shadow line under the eave, and it is most of what makes a roof look built'],
  ['windowScale', 0, 2, 0.05, 'multiplies how many bays get glazed'],
  ['slope', 0, 0.35, 0.005, 'ground fall per metre across the site. Drives the plinth, the steps and the porch -- none of those are style knobs'],
]

const DEFAULTS = {
  areaScale: 1, ratioScale: 1, wallScale: 1, pitchScale: 1,
  overhang: 0.4, windowScale: 1, slope: 0,
}

const params = { ...DEFAULTS, seed: 1 }
const picks = { kind: 'cottage', shape: 'auto', style: 'auto', roof: 'auto', detail: 2 }

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 400)
camera.position.set(9, 5.5, 12)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 2, 0)
controls.enableDamping = true
controls.autoRotate = false
controls.autoRotateSpeed = (0.3 * 60) / (2 * Math.PI)

// The game's noon, same rig as gen-fern.html and props.html, so a wall is
// judged under the light it will stand in. One directional light is also all
// the Quest gets (DESIGN.md §8), so this is not a simplification of the
// previewer -- it is the actual budget.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

scene.fog = new THREE.Fog(0x0a1018, 55, 130)

// --- ground -----------------------------------------------------------------
//
// A real mesh rather than a flat plane, because `slope` has to be VISIBLE: the
// plinth, the steps and the porch are all generated from the fall across the
// site, and a building sitting on level ground while the plan believes it is on
// a hillside would make all three look like bugs.

const GROUND_SIZE = 160
const GROUND_SEG = 40
const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / 3, GROUND_SIZE / 3)
const groundGeo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, GROUND_SEG, GROUND_SEG)
groundGeo.rotateX(-Math.PI / 2)
const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ map: groundTex }))
scene.add(ground)

/** A single hillside falling toward +X. One slope, not noise: the question the
 *  slider asks is "how much fall", and noise would make the answer unrepeatable
 *  from seed to seed for no gain. */
const groundAt = (x) => -x * params.slope

function reshapeGround() {
  const pos = groundGeo.getAttribute('position')
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundAt(pos.getX(i)))
  pos.needsUpdate = true
  groundGeo.computeVertexNormals()
}

const grid = new THREE.GridHelper(20, 20, 0x2b4a72, 0x16233a)
scene.add(grid)

// A 1.75 m figure by the door. Every proportion decision on this page -- how big
// a log is, how tall an eave is, whether a window reads as a window -- is
// really a question about a person standing next to it, and nothing else in
// shot answers it.
const figure = new THREE.Group()
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 1.0, 4, 8), mat)
  body.position.y = 0.88
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), mat)
  head.position.y = 1.62
  figure.add(body, head)
}
scene.add(figure)

// --- the real material ------------------------------------------------------

const textureArray = buildTextureArray()
const material = createPropMaterial(textureArray, { vertexColors: true })
material.side = THREE.FrontSide // buildings are closed solids; foliage is not
// The tree/fern layers arrive from PNGs a few frames later. Buildings do not
// use any of them, but the array is shared and patching it late is how the
// runtime behaves, so the previewer does it too.
loadImageLayers(textureArray).catch(() => {})

const group = new THREE.Group()
scene.add(group)

// --- build ------------------------------------------------------------------

const GALLERY_COLS = 4
const GALLERY_ROWS = 3
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

let galleryMode = false
let wireframe = false
let showGrid = true

const auto = (v) => (v === 'auto' ? null : v)

function planFor(seed) {
  return planBuilding({
    seed,
    kind: picks.kind,
    shape: auto(picks.shape),
    style: auto(picks.style),
    roof: auto(picks.roof),
    groundAt: params.slope > 0 ? groundAt : null,
    tweak: params,
  })
}

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

function rebuild() {
  clearGroup()
  material.wireframe = wireframe

  const seeds = galleryMode
    ? Array.from({ length: GALLERY_N }, (_, i) => Number(params.seed) + i)
    : [Number(params.seed)]

  // Gallery spacing keys off the widest building actually built, not off a
  // constant: `areaScale` at 2.0 makes an inn 16 m across and a fixed grid
  // would drive them into each other.
  const plans = seeds.map(planFor)
  const spacing = Math.max(...plans.map((p) => Math.max(p.stats.width, p.stats.depth))) + 5

  let tris = 0
  const hero = plans[0]
  plans.forEach((plan, i) => {
    const { geometry, triangles } = buildBuilding(plan, { detail: picks.detail })
    tris += triangles
    const mesh = new THREE.Mesh(geometry, material)
    if (galleryMode) {
      mesh.position.set(
        ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * spacing,
        0,
        (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * spacing
      )
    }
    group.add(mesh)
  })

  // The figure stands where the plan put the door, one pace out from it, so it
  // is measuring the thing it is next to.
  figure.visible = !galleryMode && showGrid
  const doorZ = hero.door.z + (hero.porch ? hero.porch.depth : 0) + 0.9
  figure.position.set(hero.door.x + 0.95, groundAt(hero.door.x + 0.95), doorZ)

  grid.visible = showGrid && !galleryMode
  grid.position.y = 0.01

  return { tris, plans, hero, spacing }
}

// --- panels -----------------------------------------------------------------

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// DESIGN.md §5 gives the `structure` prop class a top mesh tier at 2500
// triangles. Keep this in step with scripts/check-buildings.mjs, which is the
// one that actually fails the build.
const STRUCTURE_BUDGET = 2500
// §5's budget table allots 20 visible buildings to a village.
const VISIBLE_BUILDINGS = 20

function refresh() {
  const s = rebuild()
  const plan = s.hero
  const per = Math.round(s.tris / s.plans.length)

  // The airtightness probe, run on the geometry that is ON SCREEN rather than
  // on a rebuild, so this panel cannot disagree with what you are looking at.
  // Both halves matter and they catch different things: an unpaired edge is a
  // missing face, and a shell wound inside out pairs every edge and still
  // renders as a hole. scripts/check-buildings.mjs gates the same two.
  const heroGeo = group.children[0].geometry
  const open = openEdges(heroGeo).length
  const vol = signedVolume(heroGeo)

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${s.tris.toLocaleString()}</span>${s.plans.length > 1 ? ` (${per} ea)` : ''}`],
    ['draw calls', '1', 'ok'],
    ['texture layers used', usedLayers(heroGeo).length],
    ['structure budget', `${per} / ${STRUCTURE_BUDGET}`, per <= STRUCTURE_BUDGET ? 'ok' : 'warn'],
    ['airtight', open === 0 ? 'yes' : `${open} open edges`, open === 0 ? 'ok' : 'warn'],
    ['enclosed volume', `${vol.toFixed(1)} m&sup3;`, vol > 0 ? 'ok' : 'warn'],
  ])
  document.getElementById('geonote').innerHTML =
    `One mesh, one material, one call -- walls, thatch, stone and glass together. That is what the ` +
    `per-vertex <code>texLayer</code> buys, and it is the reason a village can be ~450 static pieces ` +
    `merged into a single draw (&sect;6).`

  table(document.getElementById('planTable'), [
    ['kind', plan.kind],
    ['shape', plan.shape],
    ['wall style', plan.style],
    ['roof', plan.roofKind],
    ['rooms', plan.stats.rooms],
    ['floor area', `${plan.stats.area} m&sup2;`],
    ['footprint', `${plan.stats.width.toFixed(1)} &times; ${plan.stats.depth.toFixed(1)} m`],
    ['ridge height', `${plan.stats.ridgeY.toFixed(2)} m`],
    ['windows', plan.stats.windows],
    ['ground fall', `${(plan.groundMax - plan.groundMin).toFixed(2)} m`],
    ['plinth', `${(plan.floorY - plan.plinthBottom).toFixed(2)} m`],
    ['porch / steps', `${plan.porch ? 'porch' : '--'} / ${plan.steps ? `${Math.round((plan.floorY - plan.steps.groundY) / 0.19)} steps` : '--'}`],
  ])

  // The three tiers, always all three, always from the same plan.
  const tiers = [2, 1, 0].map((d) => buildBuilding(plan, { detail: d }))
  table(document.getElementById('lod'), [
    ['detail 2 &mdash; to 60 m', `${tiers[0].triangles} tris`],
    ['detail 1 &mdash; to 170 m', `${tiers[1].triangles} tris`, 'ok'],
    ['detail 0 &mdash; to the card', `${tiers[2].triangles} tris`, 'ok'],
    ['ratio', `1 : ${(tiers[0].triangles / Math.max(1, tiers[1].triangles)).toFixed(1)} : ${(tiers[0].triangles / Math.max(1, tiers[2].triangles)).toFixed(1)}`],
  ])
  for (const t of tiers) t.geometry.dispose()

  const nearAll = tiers[0].triangles * VISIBLE_BUILDINGS
  table(document.getElementById('village'), [
    [`${VISIBLE_BUILDINGS} visible at detail 2`, `${nearAll.toLocaleString()} tris`, nearAll <= 40000 ? 'ok' : 'warn'],
    ['of the frame budget', `${((nearAll / TRI_BUDGET) * 100).toFixed(1)} %`, nearAll / TRI_BUDGET < 0.15 ? 'ok' : 'warn'],
    ['draw calls it costs', `1 of ${CALL_BUDGET}`, 'ok'],
  ])
  document.getElementById('villagenote').innerHTML =
    `&sect;5 allots villages 16k triangles for 20 buildings. Anything much over that is not a ` +
    `budget overrun so much as a signal that a detail-2 tier is carrying ornament the eye cannot ` +
    `resolve at the distance it is drawn from.`
}

/** Which array layers this building's vertices actually reference. Read off the
 *  geometry that is on screen, not rebuilt, so it cannot disagree with it. */
function usedLayers(geometry) {
  const attr = geometry.getAttribute('texLayer')
  const set = new Set()
  for (let i = 0; i < attr.count; i++) set.add(attr.getX(i))
  return [...set].sort((a, b) => a - b)
}

// --- tile strip -------------------------------------------------------------
//
// Read back out of the DataArrayTexture rather than re-run from tiles.js, so
// what the strip shows is literally the bytes the shader samples. If a tile is
// wrong on the wall it is wrong here too, which is the only way this panel is
// worth the space it takes.

function drawTiles() {
  const names = {
    [LAYER.TIMBER_BEAM]: 'beam', [LAYER.TIMBER_HEWN]: 'board', [LAYER.TIMBER_PLANK]: 'plank',
    [LAYER.THATCH]: 'thatch', [LAYER.SHINGLE]: 'shake', [LAYER.ROOF_TILE]: 'pantile',
    [LAYER.STONE]: 'stone', [LAYER.PLASTER]: 'plaster',
    [LAYER.THATCH_FRINGE]: 'fringe', [LAYER.GLASS]: 'glass', [LAYER.IRON]: 'iron',
    [LAYER.RUNE]: 'rune', [LAYER.DOOR]: 'door',
  }
  const host = document.getElementById('tiles')
  const stride = TEX_SIZE * TEX_SIZE * 4
  for (const [layerStr, name] of Object.entries(names)) {
    const layer = Number(layerStr)
    const fig = document.createElement('figure')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = TEX_SIZE
    const ctx = canvas.getContext('2d')
    const img = ctx.createImageData(TEX_SIZE, TEX_SIZE)
    const src = textureArray.image.data.subarray(layer * stride, (layer + 1) * stride)
    // Composite over mid grey: the alpha-cut sheets are otherwise invisible.
    for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
      const a = src[i * 4 + 3] / 255
      for (let c = 0; c < 3; c++) img.data[i * 4 + c] = src[i * 4 + c] * a + 90 * (1 - a)
      img.data[i * 4 + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    const cap = document.createElement('figcaption')
    const m = TILE_METRES[layer]
    cap.textContent = m ? `${name} ${m}m` : name
    cap.title = m
      ? `one UV tile covers ${m} m of wall`
      : 'decal sheet -- addressed by island, never scaled'
    fig.append(canvas, cap)
    host.appendChild(fig)
  }
}

// --- controls ---------------------------------------------------------------

const picksEl = document.getElementById('picks')
const pickDefs = [
  ['kind', Object.keys(KINDS), 'what the building is for. Sets area, height, and which styles are legal'],
  ['shape', ['auto', 'single', 'outshut', 'ell', 'tee', 'wing'], 'how the masses combine. Not every kind allows every shape -- auto picks a legal one'],
  ['style', ['auto', ...WALL_STYLES], 'wall treatment. ONE per building: mixing them makes it read as several buildings shoved together'],
  ['roof', ['auto', ...ROOF_KINDS], 'slate is not a texture -- it is the shake tile at a cold tint. pantile is, because a scallop is a shape'],
  ['detail', ['2', '1', '0'], 'which LOD tier to build. 2 is what you see inside 60 m'],
]
for (const [key, options, help] of pickDefs) {
  const row = document.createElement('div')
  row.className = 'prow'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<select>${options.map((o) => `<option value="${o}">${o}</option>`).join('')}</select>`
  const sel = row.querySelector('select')
  sel.value = String(picks[key])
  sel.addEventListener('change', () => {
    picks[key] = key === 'detail' ? Number(sel.value) : sel.value
    // A kind whitelists its shapes and styles, so switching kind can strand an
    // explicit pick on something illegal. Fall back to auto rather than
    // silently building something the grammar forbids.
    if (key === 'kind') {
      const K = KINDS[picks.kind]
      if (picks.shape !== 'auto' && !K.shapes.includes(picks.shape)) setPick('shape', 'auto')
      if (picks.style !== 'auto' && !K.styles.includes(picks.style)) setPick('style', 'auto')
    }
    refresh()
  })
  picksEl.appendChild(row)
}
function setPick(key, value) {
  picks[key] = value
  picksEl.querySelectorAll('select')[pickDefs.findIndex((d) => d[0] === key)].value = value
}

const slidersEl = document.getElementById('sliders')
const readouts = {}
for (const [key, min, max, step, help] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  readouts[key] = { input, out }
  const show = () => { out.textContent = Number(params[key]).toFixed(2) }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show()
    if (key === 'slope') reshapeGround()
    refresh()
  })
  show()
  slidersEl.appendChild(row)
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
toggle('gallery', () => galleryMode, (v) => {
  galleryMode = v
  const s = rebuild()
  if (v) {
    const half = Math.hypot((GALLERY_COLS * s.spacing) / 2, (GALLERY_ROWS * s.spacing) / 2)
    const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.1
    controls.target.set(0, 2, 0)
    camera.position.set(0, dist * 0.7, dist * 0.8)
  } else {
    controls.target.set(0, s.hero.stats.ridgeY * 0.45, 0)
    camera.position.set(9, 5.5, 12)
  }
})
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, DEFAULTS)
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    readouts[key].out.textContent = Number(params[key]).toFixed(2)
  }
  reshapeGround()
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

drawTiles()
reshapeGround()
refresh()

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
