import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE, TILE_METRES } from './textures.js'
import { createPropMaterial } from './material.js'
import { planBuilding, KINDS, WALL_STYLES, ROOF_KINDS } from './buildings/plan.js'
import { buildBuilding2 } from './buildings/v2/building.js'
import { makeCharacter } from './buildings/v2/warp.js'
import { openEdges, signedVolume } from './buildings/v2/parts.js'
import { grassTexture } from './preview-stage.js'
import { TRI_BUDGET, CALL_BUDGET } from './budget.js'

// ---------------------------------------------------------------------------
// The v2 building previewer (gen-building-v2.html).
//
// v1's bench answered "does the grammar cover a range" and it answered it well
// enough that the plan layer is shared unchanged. What it could not answer is
// the thing v2 exists for: HOW CROOKED IS TOO CROOKED. That is not a question
// with a computable answer -- a warp large enough to read as hand-built and
// small enough to still read as a building is a matter of looking -- so this
// page is built around making the amount adjustable and the comparison direct.
//
// Three things it has that v1's does not:
//
//   A MASTER STRENGTH, at the top, in a different colour. Every term of the
//   personality scales from it, and at 0 the page builds exactly the straight
//   thing v1 builds. That control case is the whole point: "is this better"
//   needs a "than what", and the answer is one slider away rather than a
//   different URL.
//
//   PER-TERM MULTIPLIERS underneath it. When a building looks wrong the useful
//   question is WHICH term did it -- a roof that sags too far and an eave that
//   reaches too far are both "too warped" from across the room and are fixed by
//   different numbers. These drive buildBuilding2's `character` override, which
//   exists for this page and which the game never uses.
//
//   A SIDE-BY-SIDE. `vs straight` puts the strength-0 twin of the same seed
//   beside the warped one. Judging a warp against a memory of the straight
//   version is judging it against nothing.
//
// Like v1's, it runs THE REAL MATERIAL -- the actual shared DataArrayTexture
// and createPropMaterial() -- because the premise of the kit is one draw call
// for thatch, logs, stone and glass together, and a previewer that faked that
// would be checking the one thing not in question.
// ---------------------------------------------------------------------------

// --- what the panel can drive -----------------------------------------------

// The personality. `strength` is the master; the rest multiply one group of
// terms each, so a term can be isolated without editing warp.js.
const CHARACTER = [
  ['strength', 0, 1.6, 0.02, 'scales the whole personality. 0 builds the straight v1 building; 1 is what ships. Past 1 is for finding where it breaks, not for using'],
  ['noise', 0, 2, 0.05, 'the two octaves of the field itself -- the coarse one bows a whole wall, the fine one takes the machine edge off a member'],
  ['lean', 0, 2, 0.05, 'the settle. Grows as height^1.35, so the eaves lean and the plinth does not'],
  ['roofSag', 0, 2, 0.05, 'how far the covering bows between ridge and eave, and how much the two buckle seams wander along their length'],
  ['eave', 0, 2, 0.05, 'how far the eave line swells past its nominal overhang, and how much it rises and falls along it'],
  ['flare', 0, 2, 0.05, 'how much wider the chimney crown is than its base'],
  ['openings', 0, 2, 0.05, 'how far a window corner strays from the rectangle it was planned as, and how far a shutter stands off the wall'],
  ['bow', 0, 2, 0.05, 'how far a post or a rail bows off the straight line between its ends'],
]

// Scales rather than absolutes, so a slider means the same thing across a hut
// and an inn and the kind tables stay the source of truth for proportion.
const SLIDERS = [
  ['areaScale', 0.5, 2.0, 0.01, 'multiplies the footprint area drawn for this kind'],
  ['ratioScale', 0.5, 1.8, 0.01, 'multiplies the long:short ratio. High = a range, low = a square block'],
  ['wallScale', 0.6, 1.6, 0.01, 'multiplies eave height. Low = a squat croft, high = a hall'],
  ['pitchScale', 0.5, 1.6, 0.01, 'multiplies roof pitch. Thatch needs a steep pitch to shed water -- under ~45 deg it stops reading as thatch'],
  ['overhang', 0, 0.9, 0.01, 'metres the roof projects past the wall BEFORE the eave reaches. This is the shadow line under the eave, and it is most of what makes a roof look built'],
  ['windowScale', 0, 2, 0.05, 'multiplies how many bays get glazed'],
  ['slope', 0, 0.35, 0.005, 'ground fall per metre across the site. Drives the plinth, the steps and the porch -- none of those are style knobs'],
]

const DEFAULTS = {
  areaScale: 1, ratioScale: 1, wallScale: 1, pitchScale: 1,
  overhang: 0.4, windowScale: 1, slope: 0,
}
const CHAR_DEFAULTS = {
  strength: 1, noise: 1, lean: 1, roofSag: 1, eave: 1, flare: 1, openings: 1, bow: 1,
}

const params = { ...DEFAULTS, seed: 1 }
const chars = { ...CHAR_DEFAULTS }
const picks = { kind: 'cottage', shape: 'auto', style: 'auto', roof: 'auto', detail: 2 }

/**
 * The personality this seed and this panel ask for.
 *
 * `flare` multiplies the EXCESS over 1, not the value: a flare of 1 is a
 * chimney whose crown matches its base, so scaling the whole number would make
 * the "off" position invert the taper rather than remove it.
 */
function characterFor(seed) {
  const k = makeCharacter(seed, chars.strength)
  k.amp *= chars.noise
  k.amp2 *= chars.noise
  k.leanX *= chars.lean
  k.leanZ *= chars.lean
  k.sag *= chars.roofSag
  k.buckle *= chars.roofSag
  k.reach *= chars.eave
  k.sway *= chars.eave
  k.flare = 1 + (k.flare - 1) * chars.flare
  k.skew *= chars.openings
  k.splay *= chars.openings
  k.bow *= chars.bow
  return k
}

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

// The game's noon, same rig as v1's bench, so a wall is judged under the light
// it will stand in. One directional light is also all the Quest gets
// (DESIGN.md §8), so this is not a simplification -- it is the actual budget.
// It matters more here than it did in v1: the warp's whole payoff is that a
// bowed surface catches the sun unevenly, and that is invisible under flat or
// generous lighting.
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
let ghostMode = false
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
    const { geometry, triangles } = buildBuilding2(plan, {
      detail: picks.detail, character: characterFor(plan.seed),
    })
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

  // The control case, stood next to the thing rather than remembered. Placed on
  // -X, which is UPHILL when `slope` is on, so the twin sits on the same ground
  // the plan was written against rather than floating over the fall.
  if (ghostMode && !galleryMode) {
    const twin = buildBuilding2(hero, { detail: picks.detail, strength: 0 })
    const mesh = new THREE.Mesh(twin.geometry, material)
    mesh.position.set(-(hero.stats.width + 3), 0, 0)
    group.add(mesh)
  }

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

// §5's `structure` prop class mesh tier, re-priced for v2 and kept in step with
// scripts/check-buildings-v2.mjs, which is the one that actually fails the
// build. v2 spends triangles on the roof grid and buys most of them back on the
// chimney and the window surrounds; 2600 is where that nets out with margin.
const STRUCTURE_BUDGET = 2600
// The detail-1 cap, absolute rather than a ratio -- see the gate for why.
const LOD1_BUDGET = 460
// §5's budget table allots 20 visible buildings to a village.
const VISIBLE_BUILDINGS = 20

function refresh() {
  const s = rebuild()
  const plan = s.hero
  const per = Math.round(s.tris / s.plans.length)

  // The airtightness probe, run on the geometry that is ON SCREEN rather than
  // on a rebuild, so this panel cannot disagree with what you are looking at.
  // It matters more in v2 than it did in v1, because the warp is exactly the
  // kind of change that would open a seam if the field were not keyed on
  // position -- this readout is the claim in warp.js being checked live, on the
  // building you are currently looking at, at whatever strength you have set.
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
    `One mesh, one material, one call -- walls, thatch, stone and glass together, warped and ` +
    `still closed. That is what the per-vertex <code>texLayer</code> buys, and it is the reason a ` +
    `village can be ~450 static pieces merged into a single draw (&sect;6).`

  // What the field is actually doing to THIS building, in metres, measured
  // against its own straight twin rather than quoted from the sliders. A number
  // read off the parameters would still be right if the warp had silently
  // stopped being applied.
  const k = characterFor(plan.seed)
  const straight = buildBuilding2(plan, { detail: picks.detail, strength: 0 })
  const moved = maxDisplacement(straight.geometry, heroGeo)
  straight.geometry.dispose()

  table(document.getElementById('charTable'), [
    ['strength', k.strength.toFixed(2), k.strength > 0 ? 'hot' : ''],
    ['worst vertex moved', `${moved === null ? '--' : `${moved.toFixed(3)} m`}`, 'hot'],
    ['lean at the eave', `${(Math.hypot(k.leanX, k.leanZ) * Math.pow(Math.max(0, plan.stats.ridgeY - plan.plinthBottom), k.leanPow)).toFixed(3)} m`],
    ['roof sag', `${k.sag.toFixed(3)} m`],
    ['buckle seams', `${k.buckle.toFixed(3)} m`],
    ['eave reach', `${k.reach.toFixed(3)} m`],
    ['eave sway', `${k.sway.toFixed(3)} m`],
    ['chimney flare', `&times; ${k.flare.toFixed(2)}`],
    ['window skew', `${(k.skew * 100).toFixed(1)} % of the opening`],
    ['shutter splay', `${k.splay.toFixed(3)} m`],
    ['post bow', `${k.bow.toFixed(3)} m`],
  ])

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

  // The three tiers, always all three, always from the same plan and the same
  // character -- so the ratio on screen is the ratio the gate measures.
  const tiers = [2, 1, 0].map((d) => buildBuilding2(plan, { detail: d, character: k }))
  table(document.getElementById('lod'), [
    ['detail 2 &mdash; to 60 m', `${tiers[0].triangles} tris`],
    ['detail 1 &mdash; to 170 m', `${tiers[1].triangles} / ${LOD1_BUDGET} tris`, tiers[1].triangles <= LOD1_BUDGET ? 'ok' : 'warn'],
    ['detail 0 &mdash; to the card', `${tiers[2].triangles} tris`, 'ok'],
    ['ratio', `1 : ${(tiers[0].triangles / Math.max(1, tiers[1].triangles)).toFixed(1)} : ${(tiers[0].triangles / Math.max(1, tiers[2].triangles)).toFixed(1)}`],
  ])
  const d2 = tiers[0].triangles
  for (const t of tiers) t.geometry.dispose()

  const nearAll = d2 * VISIBLE_BUILDINGS
  table(document.getElementById('village'), [
    [`${VISIBLE_BUILDINGS} visible at detail 2`, `${nearAll.toLocaleString()} tris`, nearAll <= 55000 ? 'ok' : 'warn'],
    ['of the frame budget', `${((nearAll / TRI_BUDGET) * 100).toFixed(1)} %`, nearAll / TRI_BUDGET < 0.2 ? 'ok' : 'warn'],
    ['draw calls it costs', `1 of ${CALL_BUDGET}`, 'ok'],
  ])
  document.getElementById('villagenote').innerHTML =
    `&sect;5 allots villages 55k triangles for 20 buildings. Anything much over that is not a ` +
    `budget overrun so much as a signal that a detail-2 tier is carrying ornament the eye cannot ` +
    `resolve at the distance it is drawn from.`
}

/** How far the warp moved the furthest vertex, measured between two builds of
 *  the same plan at the same detail. Returns null if the two disagree on vertex
 *  count, which would mean the tiers had stopped being the same building. */
function maxDisplacement(a, b) {
  const pa = a.getAttribute('position').array
  const pb = b.getAttribute('position').array
  if (pa.length !== pb.length) return null
  let m = 0
  for (let i = 0; i < pa.length; i += 3) {
    m = Math.max(m, Math.hypot(pb[i] - pa[i], pb[i + 1] - pa[i + 1], pb[i + 2] - pa[i + 2]))
  }
  return m
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

/** A slider row bound to one key of one object. Shared by the character block
 *  and the proportion block, which differ only in what they write to. */
function sliderRow(host, defs, store, extraClass, onChange) {
  const readouts = {}
  for (const [key, min, max, step, help] of defs) {
    const row = document.createElement('div')
    row.className = `row${extraClass ? ` ${extraClass}` : ''}`
    row.innerHTML =
      `<label title="${help}">${key}</label>` +
      `<input type="range" min="${min}" max="${max}" step="${step}" value="${store[key]}" />` +
      `<span class="v"></span>`
    const input = row.querySelector('input')
    const out = row.querySelector('.v')
    readouts[key] = { input, out }
    const show = () => { out.textContent = Number(store[key]).toFixed(2) }
    input.addEventListener('input', () => {
      store[key] = Number(input.value)
      show()
      onChange?.(key)
      refresh()
    })
    show()
    host.appendChild(row)
  }
  return readouts
}

const picksEl = document.getElementById('picks')
const pickDefs = [
  ['kind', Object.keys(KINDS), 'what the building is for. Sets area, height, and which styles are legal'],
  ['shape', ['auto', 'single', 'outshut', 'ell', 'tee', 'wing'], 'how the masses combine. Not every kind allows every shape -- auto picks a legal one'],
  ['style', ['auto', ...WALL_STYLES], 'wall treatment. ONE per building: mixing them makes it read as several buildings shoved together'],
  ['roof', ['auto', ...ROOF_KINDS], 'slate is not a texture -- it is the shake tile at a cold tint. pantile is, because a scallop is a shape'],
  ['detail', ['2', '1', '0'], 'which LOD tier to build. 2 is what you see inside 60 m; 1 keeps the massing and the warp and drops the joinery'],
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

const charReadouts = sliderRow(document.getElementById('character'), CHARACTER, chars, 'master')
const readouts = sliderRow(document.getElementById('sliders'), SLIDERS, params, '', (key) => {
  if (key === 'slope') reshapeGround()
})

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
toggle('ghost', () => ghostMode, (v) => {
  ghostMode = v
  // Pull back and swing the target between the pair, or the twin lands off
  // screen and the button looks like it did nothing.
  if (v) {
    controls.target.set(-2.5, 2, 0)
    camera.position.set(6, 6, 17)
  } else {
    controls.target.set(0, 2, 0)
    camera.position.set(9, 5.5, 12)
  }
})
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, DEFAULTS)
  Object.assign(chars, CHAR_DEFAULTS)
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    readouts[key].out.textContent = Number(params[key]).toFixed(2)
  }
  for (const [key] of CHARACTER) {
    charReadouts[key].input.value = chars[key]
    charReadouts[key].out.textContent = Number(chars[key]).toFixed(2)
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
