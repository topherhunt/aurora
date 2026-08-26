import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildDeadwood,
  deadwoodCost,
  deadwoodParams,
  BUDGET_TRIS,
  DEADWOOD_DEFAULTS,
  DEADWOOD_TIERS,
  DEADWOOD_VARIANTS,
} from './props/deadwood.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE, IMAGE_LAYERS } from './textures.js'
import { createPropMaterial, setSnow, setMoss, MOSS, SNOW_ROCK, mossCutFor } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import deadwoodSource from './props/deadwood.js?raw'

// ---------------------------------------------------------------------------
// The dead wood previewer (gen-deadwood.html, served at /gen-deadwood).
//
// A snag and a fallen log are the same generator seen from two attitudes, so
// they are one bench with a KIND toggle rather than two pages that would drift
// apart. Everything above the placement is shared; a slider found on a log is
// worth the same on a snag.
//
// The question this page answers is not "is this a nice log". It is:
//
//   1. DOES DEAD WOOD READ AS DEAD? A live trunk is a smooth cone and tree.js is
//      right to build it that way, because a canopy hides it. Dead wood has no
//      canopy and is looked at from two metres. Everything on the ROT panel --
//      bark coverage, the millimetre step where a sheet has come away, the
//      splits, the dished heart -- exists to answer this one, and the honest
//      test is the GALLERY: twenty seeds, and whether any two of them are the
//      same object.
//
//   2. DOES IT SURVIVE THE LADDER? Three tiers of the same swept surface. A
//      trunk is a far better LOD candidate than a rock and the LADDER view is
//      where you confirm that rather than assume it.
//
//   3. DOES THE WEATHER LAND WHERE IT SHOULD? This is the reason the PAIR view
//      exists and the reason SEASONS is on the page at all. Moss carries a
//      height cue measured from the instance's own root, so a snag should come
//      out green at the foot and clean at the break while a log, whose whole
//      length sits at root height, should be green end to end. Standing them
//      side by side under one sweep of the year is the only way to see that the
//      cue is doing what it claims.
//
// WHY THE REAL PROP MATERIAL. Moss and snow are not textures this page ships and
// not something the generator does -- they are the one shared material's global
// uniforms, selected by TEXTURE LAYER, and dead wood weathers because its bark
// and heartwood layers are named in MOSS_LAYERS and SNOW_WOOD_LAYERS. A bench
// stand-in with `map` bound could not show any of that, so this page patches the
// material exactly the way the game does: the array sampler from material.js,
// then wrap (half-Lambert) diffuse chained on top.
//
// WHY THERE IS NO PER-PIECE WEATHER. uSnow and uMoss are shared BY REFERENCE
// into every program createPropMaterial compiles -- that is what lets one
// setSnow call move the whole world in a frame -- so four logs on screen cannot
// wear four different winters, and a "seasons" row of four would be a row of
// four identical logs. SEASONS is therefore a sweep through TIME rather than a
// layout: a year in twelve seconds over whatever is already on screen. It is
// also the better view for the thing it is for, because what moss does at the
// EDGE of its range is the whole argument for blending rather than cutting over,
// and an animation is where an edge is visible.
// ---------------------------------------------------------------------------

// --- the shipping bank ------------------------------------------------------
//
// DEADWOOD_VARIANTS lives in src/props/deadwood.js because THE WORLD READS IT
// TOO. A preset table only this page could see would let the shape signed off
// here and the shape that ships drift apart, which is the one failure a bench
// exists to prevent. Same argument rock-bank.js makes at greater length.

// The three barks the living trees already wear. A species is one line here and
// zero bytes on disk, which is the whole reason the generator takes a layer
// rather than baking a look.
const SPECIES = [
  ['oak', LAYER.BARK, 'trees/bark_oak.png', 'deep-fissured and dark. The most obviously DEAD-looking of the three once the sheets start coming off, because the fissures give the boundary something to follow'],
  ['birch', LAYER.BARK_BIRCH, 'trees/bark_birch.png', 'pale and lenticelled. A birch snag is the one case where bare heartwood is DARKER than the bark it lost, so the step reads inverted'],
  ['pine', LAYER.BARK_PINE, 'trees/bark_pine.png', 'plated and red-brown. Pine bark comes away in whole plates rather than strips, so drop `barkPatch` for this one'],
]

// --- slider spec ------------------------------------------------------------
// Ranges reach past what is useful on purpose: `bark` at 0 strips a trunk to a
// bare spar and `jag1` at its ceiling shatters the top into splinters half a
// metre long, and seeing both is how you learn where the useful end is.
const SLIDERS = [
  ['tier', 0, 2, 1, 'which mesh tier is drawn: 0 = T0 (8 sides), 1 = T1 (5), 2 = T2 (3). All three are the SAME swept surface at different resolutions -- a tier change loses facets, it does not swap in a different log'],
  ['length', 0.4, 12, 0.05, 'along the spine, in metres: a snag\'s height, a log\'s length. Absolute rather than relative, unlike a rock -- everybody knows how big a log is, and a 0.9 m trunk across a path is a different OBJECT from a 0.3 m one closer up'],
  ['butt', 0.1, 1.2, 0.01, 'DIAMETER at the base, in metres'],
  ['taper', 0, 0.8, 0.01, 'fraction of the butt diameter lost by the far end. Never reaches 1: dead wood is broken off, not sharpened'],

  ['bend', 0, 0.3, 0.005, 'quadratic lean in one azimuth, as a fraction of the length. tree.js\'s trunkBend'],
  ['kink', 0, 0.12, 0.002, 'two harmonics on top of the lean, so the thing is CROOKED rather than merely leaning. This is most of what separates a snag from a fence post at distance'],
  ['kinkFreq', 1, 8, 0.1, 'cycles of the first harmonic over the whole length'],

  ['ovality', 0, 0.4, 0.01, 'the section as a rolled ellipse. Necessary and not sufficient: an ellipse is still a shape a machine could turn'],
  ['lobes', 0, 0.25, 0.005, '3- and 5-lobe on top of the ellipse. The ODD harmonics are what make a section read as a tree rather than as turned stock'],
  ['swell', 0, 0.35, 0.005, 'burls and waists ALONG the length'],
  ['swellFreq', 0.5, 6, 0.1, 'how many of them over the whole piece'],

  ['bark', 0, 1, 0.01, 'fraction of the surface still wearing bark. 0 = stripped to a bare spar, 1 = intact. Approximate, and the ROT panel reports what was actually measured -- value noise spends most of its range near its mean, so 0.5 really is about half and 0.2 is rather less than a fifth'],
  ['barkPatch', 0.6, 8, 0.1, 'how large the sheets are that come away. HIGHER = smaller patches. Pine sheds whole plates, so drop this for pine'],
  ['barkThick', 0, 0.06, 0.002, 'metres the surface drops where the bark has gone. This is the step that reads in SILHOUETTE -- without it a debarked patch is a change of colour and reads as paint'],
  ['checks', 0, 8, 1, 'long radial splits running the length, as a count. 0 = none. Cut as a narrow spike rather than a sine, because a check is a SPLIT: a sine gives you a fluted column'],
  ['checkDepth', 0, 0.3, 0.005, 'how far they bite, as a fraction of the radius'],

  ['jag0', 0, 0.35, 0.005, 'BUTT end: how far the rim wanders along the spine, as a fraction of the length. 0 is a clean cut -- leave it there for a standing snag, whose butt is in the ground'],
  ['jag1', 0, 0.35, 0.005, 'FAR end: the same, and for a snag this is the break. The splinters are cubed, so a few run long and most of the rim stays low -- a raw noise value gives an evenly scalloped edge that reads as decorative'],
  ['jagCount', 3, 10, 1, 'how many splinters go round'],
  ['cup0', 0, 0.8, 0.02, 'BUTT end: how far the end face is pulled INTO the piece, as a fraction of its own radius. A rotten heart is dished; a sound break is flat'],
  ['cup1', 0, 0.8, 0.02, 'FAR end: the same'],

  ['flare', 0, 1.4, 0.02, 'root buttress at the very base, as a fraction of the butt radius. tree.js has none of this and can afford not to -- the bottom half metre of a living trunk is behind ferns. A SNAG IS ITS BOTTOM HALF METRE'],
  ['flareRun', 0.04, 0.6, 0.01, 'over what fraction of the length the flare dies away'],

  ['stubs', 0, 6, 1, 'broken branch stubs. Not branches: a stub is a short cone with a jagged end and no curve at all. They are the first thing a tier drops, at T1'],
  ['stubStart', 0, 0.9, 0.02, 'fraction of the length below which no stub grows'],
  ['stubLength', 0.3, 2.5, 0.05, 'as a multiple of the local DIAMETER'],
  ['stubRadius', 0.1, 0.6, 0.01, 'as a fraction of the local trunk radius'],
  ['stubRise', -0.4, 1.2, 0.02, 'radians above horizontal. Dead stubs DROOP -- a stub angled up like a live branch reads as a tree that is still trying'],

  ['sink', 0, 0.9, 0.02, 'fraction of the butt RADIUS pushed below y = 0 and clamped back up onto it. This is rock.js\'s `sit`: a log pressed into forest duff is FLAT where it presses, and a bowed log that touched at two points would arch over a visible gap'],
  ['roll', 0, 6.283, 0.02, 'LOG ONLY: spin about the log\'s own axis, so the flare and the checks land somewhere'],
  ['pitch', -0.4, 0.4, 0.01, 'LOG ONLY: radians off horizontal -- one end resting on something'],

  ['smooth', 0, 1, 0.01, '0 = every face flat-shaded, 1 = one smooth shell. End faces stay FLAT at any setting: the end grain of a break meets the barrel at a right angle and an all-smooth log has ends that look like melted wax'],
  ['texMetres', 0.15, 2, 0.01, 'world metres one tile covers ALONG the piece. The one texture dial, and it means the same thing in both directions -- the wrap count is derived from it and rounded to an integer so the seam lands on a tile boundary'],
  ['rings', 1, 8, 1, 'ring count along the spine at T0. The only slider that scales the barrel\'s triangle count'],

  ['snow', 0, 1, 0.01, 'snow, in patches, filling in from the top down. Not a triangle and not a texture -- the shared material\'s global uniform, leaning on which way a surface faces about twice as hard as it does on foliage, which is the whole reason a fallen log whitens along its TOP first instead of frosting evenly'],
  ['moss', 0, 1, 0.01, 'moss, creeping up from the shaded flanks. A real second atlas fetch (LAYER.MOSS) because moss is nothing but grain: tint the bark green and you get green bark. It BLENDS rather than cutting over, and it carries a height cue from the instance\'s own root -- see the PAIR view'],
  ['brightness', 0.3, 2, 0.05, 'multiplies the material colour. A bench setting, not geometry'],
]

// `snow`, `moss` and `brightness` are weather and previewer rather than shape,
// so they sit outside DEADWOOD_DEFAULTS and do not clear the preset name when
// dragged -- you have to be able to put snow on `snag-tall` and still be told
// you are looking at `snag-tall`. The rock and tree benches split theirs the
// same way.
//
// The page OPENS ON DEADWOOD_DEFAULTS rather than on a preset, because every
// preset names bark, jag and flare, and opening on one would make the defaults a
// setting nobody ever saw. `custom` is the honest label for that state.
const BENCH_KEYS = new Set(['snow', 'moss', 'brightness'])
const params = { ...DEADWOOD_DEFAULTS, snow: 0, moss: 0, brightness: 1 }
let presetName = ''
let speciesIndex = 0

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

// Far plane at 400 m: `length` reaches 12, and a gallery of twelve 12 m logs is
// sixty metres across before the camera has to back off from it.
const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 400)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// Spin orbits the camera, not the piece: a rotating mesh sweeps the sun across
// the facets, and whether a check catches light is the thing this page is for.
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / (2 * Math.PI)

// Matched to the game's noon, so wood is judged under the light it will lie in.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------
//
// Generated, not loaded, so it costs nothing in the "what ships" panel; see
// preview-stage.js for why it is deliberately lo-fi and nearest-filtered.
// Matters more here than it does on the rock bench: a fallen log is CLAMPED onto
// this plane, so where the wood stops and the ground starts is a thing you have
// to be able to see.

const GROUND_TILE = 3
const groundTex = grassTexture(renderer)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
scene.add(ground)
scene.fog = new THREE.Fog(0x0a1018, 1, 2)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.002
scene.add(grid)

// A one-metre rule. Everything on this page is authored in real metres and the
// numbers only mean something if there is something in shot to hold them
// against.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.02, 1, 0.02),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(0, 0.5, 0)
scene.add(rule)

// --- material ---------------------------------------------------------------
//
// Chained, not replaced -- assigning over onBeforeCompile would drop the
// sampler2DArray patch and every log would render untextured white.
const atlas = buildTextureArray()

function makeMaterial() {
  const m = createPropMaterial(atlas)
  const arrayPatch = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => {
    arrayPatch(shader, r)
    wrapLambert(shader)
  }
  m.customProgramCacheKey = () => 'gen-deadwood-array-wrap-v1'
  return m
}

const material = makeMaterial()

function syncMaterial() {
  // One uniform pair for the whole page, shared by reference into the program.
  // The snow and moss LINES stay at their no-op defaults here, so every piece on
  // the bench reads a load of exactly the slider -- in the game the lines are
  // what make two logs a hundred metres apart in elevation wear different
  // amounts of each.
  setSnow(seasonOn ? seasonSnow : params.snow)
  setMoss(seasonOn ? seasonMoss : params.moss)
  material.color.setScalar(1).multiplyScalar(params.brightness)
  material.wireframe = wireframe
  material.needsUpdate = true
}

// Every layer this page draws has a procedural stand-in in buildTextureArray(),
// so unlike the fern bench a log is never invisible while the PNGs resolve. They
// ARE the wrong wood, though, and the swatch caption says which one you are
// looking at rather than letting the placeholder pass for the photograph.
let layersLoaded = false
const layersReady = loadImageLayers(atlas).then((n) => {
  layersLoaded = true
  return n
})

function layerPixels(layer) {
  const stride = TEX_SIZE * TEX_SIZE * 4
  return atlas.image.data.subarray(layer * stride, (layer + 1) * stride)
}

// --- the pieces --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const GALLERY_COLS = 4
const GALLERY_ROWS = 3
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

// gallery / ladder / pair each lay the group out a different way, so they are
// one exclusive mode rather than three toggles that fight.
let mode = 'one'
let wireframe = false
let showGrid = true

// SEASONS is not a mode -- see the header. It drives the two global uniforms
// through a year over whatever layout is up.
let seasonOn = false
let seasonT = 0
let seasonSnow = 0
let seasonMoss = 0

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

function opts(over = {}) {
  return { ...params, barkLayer: SPECIES[speciesIndex][1], ...over }
}

function rebuild() {
  clearGroup()
  syncMaterial()

  const spacing = params.length * 0.55 + params.butt * 3
  let items
  if (mode === 'gallery') {
    items = Array.from({ length: GALLERY_N }, (_, i) => ({
      opts: opts({ seed: Number(params.seed) + i }),
      x: ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * spacing * 1.6,
      z: (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * spacing * 1.6,
    }))
  } else if (mode === 'ladder') {
    items = DEADWOOD_TIERS.map((_, i) => ({
      opts: opts({ tier: i }),
      x: (i - (DEADWOOD_TIERS.length - 1) / 2) * spacing * 1.4,
      z: 0,
    }))
  } else if (mode === 'pair') {
    // The one view that tests the moss height cue, and the reason it is a fixed
    // pair rather than a row of seeds: a snag and a log OF THE SAME PIECE, so
    // the only thing that differs between them is which way up it is.
    items = [
      { opts: opts({ kind: 'snag' }), x: -spacing * 0.8, z: 0 },
      { opts: opts({ kind: 'log' }), x: spacing * 0.8, z: 0 },
    ]
  } else {
    items = [{ opts: opts(), x: 0, z: 0 }]
  }

  const geos = items.map((it) => buildDeadwood(it.opts))

  let tris = 0
  let verts = 0
  let bytes = 0
  for (const geo of geos) {
    tris += geo.userData.deadwood.triangles
    verts += geo.userData.deadwood.vertices
    bytes += geometryBytes(geo)
  }

  geos.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, material)
    mesh.position.set(items[i].x, 0, items[i].z)
    group.add(mesh)
  })

  // How the faces actually split between bark and bare wood, counted off the
  // shipped attribute rather than predicted from the slider. `bark` is a
  // fraction-covered dial whose number and whose result are only approximately
  // the same thing, and the panel should show the result.
  const lay = geos[0].getAttribute('texLayer')
  const barkLayer = SPECIES[speciesIndex][1]
  let barkFaces = 0
  for (let i = 0; i < lay.count; i += 3) if (lay.getX(i) === barkLayer) barkFaces++

  const single = mode === 'one'
  grid.visible = showGrid && single
  rule.visible = showGrid && single

  return { tris, verts, bytes, count: items.length, stats: geos[0].userData.deadwood, barkFaces }
}

// --- framing ----------------------------------------------------------------
//
// A 0.7 m stump and a 12 m fallen trunk are two orders of magnitude apart in
// what "back off far enough" means, so ground, fog, grid and rule are all
// derived. Called on a mode change and on a SIZE change, never on every slider:
// moving the camera under someone dragging `bark` is the fastest way to make a
// bench unusable.

function extent() {
  const spacing = params.length * 0.55 + params.butt * 3
  if (mode === 'gallery') return Math.hypot((GALLERY_COLS * spacing * 1.6) / 2, (GALLERY_ROWS * spacing * 1.6) / 2)
  if (mode === 'ladder') return (DEADWOOD_TIERS.length * spacing * 1.4) / 2
  if (mode === 'pair') return spacing * 1.6
  return params.length * 0.7
}

function frame() {
  const r = extent()
  const groundSize = Math.max(16, r * 6)
  ground.scale.set(groundSize, 1, groundSize)
  groundTex.repeat.set(groundSize / GROUND_TILE, groundSize / GROUND_TILE)
  // Fog closes past the far edge of the layout, never across it: judging bark
  // through haze is judging the haze.
  scene.fog.near = r * 2.4
  scene.fog.far = groundSize * 0.55

  grid.scale.setScalar(params.length)
  rule.position.set(-params.length * 0.55, 0.5, -params.length * 0.4)

  const dist = (r / Math.tan((camera.fov * Math.PI) / 360)) * 1.5
  // A log's interest is at knee height and a snag's is halfway up it, so the
  // target follows the kind rather than sitting at a fixed fraction of `length`.
  const eye = params.kind === 'log' ? params.butt * 0.8 : params.length * 0.35
  controls.target.set(0, eye, 0)
  camera.position.set(dist * 0.4, dist * 0.34 + eye, dist * 0.8)
}

// --- byte accounting --------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

async function gzipped(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

let diskBytes = null

async function measureDisk() {
  // Every PNG this page draws is one the world ALREADY ships -- three barks for
  // the living trees, the buildings' baulk, the rocks' moss. That is the whole
  // point of the accounting below and the reason `new` is a separate row.
  const paths = [
    ...SPECIES.map((s) => s[2]),
    IMAGE_LAYERS[LAYER.TIMBER_BEAM],
    IMAGE_LAYERS[LAYER.MOSS],
  ]
  const pngs = await Promise.all(paths.map((p) => fetch(p).then((r) => r.arrayBuffer())))
  const src = new TextEncoder().encode(deadwoodSource)
  diskBytes = {
    png: pngs.reduce((a, b) => a + b.byteLength, 0),
    pngGz: (await Promise.all(pngs.map((p) => gzipped(p)))).reduce((a, b) => a + b, 0),
    src: src.byteLength,
    srcGz: await gzipped(src),
  }
}

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls, tr]) => `<tr class="${tr ?? ''}"><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// --- the switch-distance model ----------------------------------------------
//
// Quest 2's default eye buffer is ~16.2 px per degree, so a thing `h` metres
// tall at `d` metres subtends about h/d * 57.3 * 16.2 px. A tier is worth
// drawing while its average triangle is still bigger than a few pixels; a piece
// of F faces has roughly sqrt(F) triangles across its silhouette, so:
//
//     switch distance = h * 928 / (TRI_PX * sqrt(F))
//
// Identical to the model the rock bench uses, and on the page as a MODEL: it
// puts the tiers in the right order and to the right rough scale, which is what
// a ladder decision needs. The real number comes from standing in the world.
//
// One caveat this page has that the rock bench does not: `h` for a fallen log is
// its DIAMETER, not its length, because height is what subtends. A 9 m log is a
// 0.5 m tall object, and its tiers switch accordingly -- which is exactly why a
// log gets away with T2 far closer in than a snag of the same triangle count.
const PX_PER_METRE_AT_1M = 928
const TRI_PX = 3

function switchDistance(faces, height) {
  return (height * PX_PER_METRE_AT_1M) / (TRI_PX * Math.sqrt(faces))
}

function pixelsTall(height, distance) {
  return ((Math.atan(height / distance) * 180) / Math.PI) * 16.2
}

function refresh() {
  const s = rebuild()
  const d = s.stats
  const m = d.measured
  const per = Math.round(s.tris / s.count)
  const tierIndex = Math.round(params.tier)

  // --- this piece ---
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} on screen)` : ''}`],
    [`&nbsp;&nbsp;barrel, ${d.sides}&times;${d.rings}`, d.barrelTris],
    ['&nbsp;&nbsp;two end faces', d.capTris],
    [`&nbsp;&nbsp;${d.stubs} stub${d.stubs === 1 ? '' : 's'}`, d.stubTris],
    ['vertices', Math.round(s.verts / s.count)],
    ['pieces drawn', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    ['measured w/h/d', `${m.width.toFixed(2)} / ${m.height.toFixed(2)} / ${m.depth.toFixed(2)} m`],
    // What the spine asked for against what the box came out at. Worth a row
    // because bend, flare and the lie-down all move it, and on a log the two are
    // barely related -- an 8.5 m spine is an 8.4 m box only if it is straight.
    ['spine / butt', `${m.span.toFixed(2)} m &nbsp; &oslash;${m.buttDiameter.toFixed(2)} m`],
    ['tile', `${d.uRepeat}&times; round &nbsp; = ${d.texMetres.toFixed(2)} m`],
    ['texel', `${((d.texMetres * 1000) / TEX_SIZE).toFixed(0)} mm`],
  ])
  document.getElementById('geonote').innerHTML =
    `<em>rings</em> is the only slider that moves the barrel: ${d.sides} sides &times; ${d.rings} rings &times; 2. ` +
    `The two end faces are fixed at 2 &times; ${d.sides} however ragged they are -- a fan has the same count whether its ` +
    `centre is proud, flat or dished, so the whole of <em>cup</em> is free. Stubs cost ${d.stubs ? `${d.stubTris} here` : 'nothing at this tier'} ` +
    `and are the first thing the ladder drops.`

  // --- the ladder ---
  // Height is what subtends, and for a log that is its diameter rather than its
  // length; `measured.height` is already the right number for both kinds
  // because it is read off the built mesh after the lie-down.
  table(
    document.getElementById('ladderTable'),
    DEADWOOD_TIERS.map((t, i) => {
      const c = deadwoodCost(params, i)
      return [
        `${t.name} &nbsp;<span class="k">${c.sides}&times;${c.rings}${c.stubs ? ` +${c.stubs}` : ''}</span>`,
        `${c.triangles} tris &nbsp; to ${switchDistance(c.triangles, m.height).toFixed(0)} m`,
        '',
        i === tierIndex ? 'here' : '',
      ]
    }).concat([
      ['this piece is this tall at 20 m', `${pixelsTall(m.height, 20).toFixed(0)} px`],
      ['&hellip; and at 60 m', `${pixelsTall(m.height, 60).toFixed(0)} px`],
    ])
  )

  // --- the budget ---
  table(
    document.getElementById('budgetTable'),
    DEADWOOD_TIERS.map((t, i) => {
      const c = deadwoodCost(params, i)
      const over = c.triangles > BUDGET_TRIS[i]
      return [
        `${t.name} against &sect;5's ${BUDGET_TRIS[i]}`,
        over ? `${c.triangles} &nbsp; +${c.triangles - BUDGET_TRIS[i]}` : `${c.triangles} &nbsp; &minus;${BUDGET_TRIS[i] - c.triangles}`,
        over ? 'warn' : 'ok',
        i === tierIndex ? 'here' : '',
      ]
    })
  )

  // --- bark, and what is left when it goes ---
  const faces = d.triangles
  const barkPct = (s.barkFaces / faces) * 100
  const measuredPct = d.barkFraction * 100
  table(document.getElementById('rotTable'), [
    ['bark asked for', `${(params.bark * 100).toFixed(0)}%`],
    ['bark on the surface', `${measuredPct.toFixed(0)}%`],
    ['&hellip; and on the FACES drawn', `${barkPct.toFixed(0)}% &nbsp; (${s.barkFaces}/${faces})`],
    ['the step where it has gone', `${(params.barkThick * 1000).toFixed(0)} mm`],
    ['&hellip; against the butt radius', `${((params.barkThick / (m.buttDiameter * 0.5)) * 100).toFixed(1)}%`],
    ['checks', params.checks > 0 ? `${Math.round(params.checks)} &times; ${(params.checkDepth * 100).toFixed(0)}% deep` : 'none'],
    ['break, butt / far', `${(params.jag0 * params.length * 100).toFixed(0)} / ${(params.jag1 * params.length * 100).toFixed(0)} cm ragged`],
    ['heart dished, butt / far', `${(params.cup0 * 100).toFixed(0)}% / ${(params.cup1 * 100).toFixed(0)}% of radius`],
    ['bark layer', SPECIES[speciesIndex][0]],
    ['under it', 'TIMBER_BEAM'],
  ])
  document.getElementById('rotnote').innerHTML =
    `Three numbers for bark because they are three different things. <em>Asked for</em> is the slider. ` +
    `<em>On the surface</em> is the field sampled on a 24&times;24 grid that no tier's vertices sit on -- the shape's own answer, ` +
    `independent of resolution. <em>On the faces drawn</em> is what this tier actually got, counted off the shipped ` +
    `<em>texLayer</em> attribute; at T2 there are ${deadwoodCost(params, 2).triangles} faces in total, so bark coverage quantises hard and ` +
    `a coarse tier can be all bark or all wood by accident. That is the honest reason the boundary is ALSO a radius step: ` +
    `a silhouette survives quantisation, a texture assignment does not. ` +
    `Neither bark nor heartwood is a new layer -- oak, birch and pine bark are the living trees', and the exposed wood is ` +
    `<em>LAYER.TIMBER_BEAM</em>, the weathered baulk the buildings are made of, checks and splits already in it.`

  // --- moss and snow ---
  const mossLoad = seasonOn ? seasonMoss : params.moss
  const snowLoad = seasonOn ? seasonSnow : params.snow
  table(document.getElementById('weatherTable'), [
    ...(seasonOn
      ? [['the year', `${(seasonT * 12).toFixed(1)} / 12 months`, '', 'here']]
      : []),
    ['moss load', mossLoad.toFixed(2)],
    ['&nbsp;&nbsp;cut it asks the field for', mossCutFor(Math.min(1 - MOSS.cutGuard, Math.max(MOSS.cutGuard, mossLoad))).toFixed(3)],
    ['&nbsp;&nbsp;blend either side', `&plusmn;${MOSS.edge.toFixed(2)}`],
    ['&nbsp;&nbsp;how far it leans on DOWN', MOSS.down.toFixed(2)],
    ['snow load', snowLoad.toFixed(2)],
    ['&nbsp;&nbsp;cut it asks the field for', (SNOW_ROCK.cutBias - snowLoad * SNOW_ROCK.cutSpan).toFixed(3)],
    ['&nbsp;&nbsp;rim, at most', `&plusmn;${SNOW_ROCK.edgeMax.toFixed(3)}`],
    ['&nbsp;&nbsp;how far it leans on UP', `${SNOW_ROCK.up.toFixed(2)} &nbsp;<span class="k">(foliage: ${SNOW_ROCK.foliageUp.toFixed(2)})</span>`],
    ['the blob field', `warp &times;${SNOW_ROCK.blobWarp.toFixed(2)}, contrast &times;${SNOW_ROCK.blobContrast.toFixed(2)}`],
    ['moss noise / snow noise', `${MOSS.freq.toFixed(1)} / ${SNOW_ROCK.freq.toFixed(1)} per m`],
  ])

  // --- the wood layers ---
  drawSwatch()

  if (!diskBytes) return

  const shipped = diskBytes.png + diskBytes.src
  const shippedGz = diskBytes.pngGz + diskBytes.srcGz
  table(document.getElementById('disk'), [
    ['3 bark tiles (the trees\')', fmt(diskBytes.png)],
    ['&nbsp;&nbsp;+ timber_beam, + moss', ''],
    ['deadwood.js (the generator)', fmt(diskBytes.src)],
    ['NEW bytes on disk', `<span class="big">${fmt(diskBytes.src)}</span>`, 'ok'],
    ['&hellip; gzipped', fmt(diskBytes.srcGz), 'ok'],
    ['everything it draws, total', fmt(shipped)],
    ['&hellip; gzipped', fmt(shippedGz)],
  ])
  document.getElementById('disknote').innerHTML =
    `<em>No new texture layers.</em> Bark is whichever of the three the living trees already wear, exposed heartwood is the ` +
    `buildings' <em>TIMBER_BEAM</em>, and moss is the rocks'. So the entire cost of putting snags and fallen logs in the ` +
    `world is ${fmt(diskBytes.srcGz)} of source over the wire -- and adding a variant to the bank in <em>deadwood.js</em> costs ` +
    `<em>0 bytes</em> on top of that. A fourth species would cost ~${fmt(Math.round(diskBytes.png / 3))} and would have to earn it by ` +
    `differing in GRAIN, since the fissure scale is the only thing a bark tile carries that this generator cannot.`
}

// --- texture swatch ---------------------------------------------------------
//
// Three panes, because the boundary between them is the whole subject of this
// generator: the species' bark, the heartwood under it, and the moss that goes
// over both. Seeing them adjacent is the only way to judge whether a debarked
// patch will read at all -- on birch it is the DARK side of the boundary, which
// is the opposite of every intuition the oak tile gives you.
const SWATCH_PANES = [
  ['bark', () => SPECIES[speciesIndex][1]],
  ['heartwood', () => LAYER.TIMBER_BEAM],
  ['moss', () => LAYER.MOSS],
]

function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')
  const w = canvas.width / SWATCH_PANES.length

  SWATCH_PANES.forEach(([label, layerOf], i) => {
    const px = layerPixels(layerOf())
    const img = new ImageData(TEX_SIZE, TEX_SIZE)
    for (let k = 0; k < TEX_SIZE * TEX_SIZE; k++) {
      const o = k * 4
      // Row 0 of a layer is v = 0 and a canvas draws row 0 at the top, so flip.
      const row = TEX_SIZE - 1 - Math.floor(k / TEX_SIZE)
      const dst = (row * TEX_SIZE + (k % TEX_SIZE)) * 4
      const a = px[o + 3] / 255
      for (let c = 0; c < 3; c++) img.data[dst + c] = px[o + c] * a + 0x3a * (1 - a)
      img.data[dst + 3] = 255
    }
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, canvas.height)
    ctx.fillStyle = 'rgba(8,14,26,.78)'
    ctx.fillRect(i * w, canvas.height - 15, w, 15)
    ctx.fillStyle = layersLoaded ? '#7f96b8' : '#c9a227'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(label, i * w + w / 2, canvas.height - 4)
  })

  const [name, , , why] = SPECIES[speciesIndex]
  document.getElementById('swatchnote').innerHTML = layersLoaded
    ? `<em>${name}</em>: ${why}. The middle pane is what is exposed where a sheet has come away, and it is the buildings' own ` +
      `baulk rather than a new tile -- a weathered log with the checks and the splits already in it, which is exactly what a ` +
      `debarked trunk is. The tile runs at <em>${params.texMetres.toFixed(2)} m</em> along the piece and ` +
      `<em>${Math.round((params.butt * Math.PI) / params.texMetres) || 1}&times;</em> round it, rounded to an integer so the seam ` +
      `lands on a tile boundary rather than halfway across a fissure.`
    : `The PNGs are still loading -- these are the procedural stand-ins from buildTextureArray(). They are matched to each ` +
      `tile's mean so nothing is ever invisible, but they are the wrong wood and no colour decision should be made off them.`
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}

function showValue(key, step) {
  const v = params[key]
  readouts[key].out.textContent = step >= 1 ? String(Math.round(v)) : Number(v).toFixed(2)
}

for (const [key, min, max, step, help] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help.replace(/"/g, '&quot;')}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  readouts[key] = { input, out: row.querySelector('.v'), step }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    showValue(key, step)
    // Dragging a SHAPE slider means you are no longer looking at the preset, so
    // the dropdown stops claiming you are. The three bench sliders are not the
    // shape and do not clear it.
    if (!BENCH_KEYS.has(key)) {
      presetName = ''
      presetSel.value = ''
    }
    // `length` and `butt` change what the whole stage means, so they reframe.
    // Nothing else does: moving the camera under someone dragging `bark` makes
    // the change impossible to judge.
    if (key === 'length' || key === 'butt') frame()
    refresh()
  })
  showValue(key, step)
  slidersEl.appendChild(row)
}

function syncSliders() {
  for (const [key, , , step] of SLIDERS) {
    readouts[key].input.value = params[key]
    showValue(key, step)
  }
}

// --- kind, preset, species, seed ---------------------------------------------

const kindBtns = { snag: document.getElementById('kindSnag'), log: document.getElementById('kindLog') }

function setKind(kind) {
  params.kind = kind
  for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === kind)
  // A kind change is not a shape change -- the presets are named for their kind
  // and a snag preset stood on its side is still that preset's shape -- but it
  // does change what the camera should be looking at.
  frame()
  refresh()
}
for (const [kind, btn] of Object.entries(kindBtns)) btn.addEventListener('click', () => setKind(kind))

const presetSel = document.getElementById('preset')
// `custom` is a destination, not a source: `defaults` and any hand-dragged
// slider land there, so the dropdown never claims you are looking at a preset
// you have since edited.
presetSel.innerHTML =
  Object.keys(DEADWOOD_VARIANTS)
    .map((k) => {
      const envs = DEADWOOD_VARIANTS[k].envs.join('/')
      return `<option value="${k}" title="${envs}">${k} -- ${envs}</option>`
    })
    .join('') + '<option value="">custom</option>'
presetSel.value = presetName
presetSel.addEventListener('change', () => {
  presetName = presetSel.value
  if (!presetName) return
  // A variant is a full shape, so anything it does not name goes back to the
  // default rather than surviving from the last one -- exactly what
  // deadwoodParams does. A preset that inherited half of whatever you were just
  // looking at is not a variant anybody can sign off.
  const p = deadwoodParams(presetName, params.seed)
  Object.assign(params, p)
  // The bark layer is a property of the variant when it names one, and every
  // preset that does is a conifer. Reflect it in the dropdown rather than
  // letting the select and the mesh disagree.
  const si = SPECIES.findIndex(([, layer]) => layer === p.barkLayer)
  speciesIndex = si < 0 ? 0 : si
  speciesSel.value = String(speciesIndex)
  for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === params.kind)
  syncSliders()
  frame()
  refresh()
})

const speciesSel = document.getElementById('species')
speciesSel.innerHTML = SPECIES.map(([name, , , why], i) => `<option value="${i}" title="${why.replace(/"/g, '&quot;')}">${name} bark</option>`).join('')
speciesSel.value = String(speciesIndex)
speciesSel.addEventListener('change', () => {
  speciesIndex = Number(speciesSel.value)
  refresh()
})

const seedInput = document.getElementById('seed')
seedInput.value = params.seed
seedInput.addEventListener('input', () => {
  params.seed = Number(seedInput.value) || 0
  refresh()
})
document.getElementById('reroll').addEventListener('click', () => {
  params.seed = Math.floor(Math.random() * 100000)
  seedInput.value = params.seed
  refresh()
})

// --- views -------------------------------------------------------------------

const MODE_BUTTONS = { gallery: 'gallery', ladder: 'ladder', pair: 'pair' }
for (const [id, name] of Object.entries(MODE_BUTTONS)) {
  document.getElementById(id).addEventListener('click', () => {
    mode = mode === name ? 'one' : name
    for (const other of Object.keys(MODE_BUTTONS)) {
      document.getElementById(other).classList.toggle('on', mode === MODE_BUTTONS[other])
    }
    frame()
    refresh()
  })
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
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })
toggle('seasons', () => seasonOn, (v) => {
  seasonOn = v
  // Hand the two sliders back exactly as they were when the sweep ends, rather
  // than leaving them parked wherever December stopped -- otherwise the button
  // is destructive and nobody presses it twice.
  if (!v) syncMaterial()
})

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, DEADWOOD_DEFAULTS, { snow: 0, moss: 0, brightness: 1, seed: params.seed })
  presetName = ''
  presetSel.value = ''
  speciesIndex = 0
  speciesSel.value = '0'
  for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === params.kind)
  syncSliders()
  frame()
  refresh()
})

// --- the year ----------------------------------------------------------------
//
// Twelve seconds, and the shape of it is the argument rather than decoration.
// Moss is damp: it comes up through spring, holds all summer, and thins rather
// than stops -- so it never reaches 0, because a wood that has been standing
// long enough to have dead trees in it does not go bare in February. Snow is
// cold: it arrives late, fills fast and leaves faster, and it sits ON TOP of the
// moss because snow falls on moss and not the other way round.
//
// The pair of them at the same time in November is the frame worth pausing on:
// it is the only one where the moss's soft boundary and the snow's hard rim are
// both visible on the same log, which is the whole of why they are drawn
// differently.
const YEAR_SECONDS = 12

function seasonAt(t) {
  const month = t * 12
  const moss = 0.28 + 0.52 * Math.max(0, Math.sin(((month - 2.5) / 12) * Math.PI * 2) * 0.5 + 0.5)
  // Zero from April to October, then a fast fill and a faster melt.
  const winter = month < 3 ? 1 - month / 3 : month > 10 ? (month - 10) / 2 : 0
  return { moss: Math.min(1, moss), snow: Math.min(1, winter) }
}

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

for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === params.kind)
frame()
refresh()
// Not top-level await: the build target is es2020, and refresh() already
// tolerates the disk numbers being absent.
measureDisk().then(refresh)
layersReady.then(refresh)

let last = performance.now()
let sinceSeasonRefresh = 0
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)

  if (seasonOn) {
    seasonT = (seasonT + dt / YEAR_SECONDS) % 1
    const s = seasonAt(seasonT)
    seasonMoss = s.moss
    seasonSnow = s.snow
    setMoss(seasonMoss)
    setSnow(seasonSnow)
    // The uniforms move every frame; the PANEL does not need to, and rebuilding
    // twelve logs sixty times a second to update two numbers would make the
    // sweep judder on exactly the view it exists for.
    sinceSeasonRefresh += dt
    if (sinceSeasonRefresh > 0.25) {
      sinceSeasonRefresh = 0
      refresh()
    }
  }

  renderer.render(scene, camera)
})
