import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildDeadwood,
  deadwoodCost,
  deadwoodParams,
  BUDGET_TRIS,
  DEADWOOD_DEFAULTS,
  DEADWOOD_TIERS,
  DEADWOOD_VARIANTS,
  DEADWOOD_TINT,
  DEADWOOD_LOD_AT,
  DEADWOOD_CULL,
  deadwoodLodSize,
  LOG_DEFAULTS,
  MAX_JAG,
  JAG_FULL,
} from './props/deadwood.js'
import {
  cardAzimuth,
  deadwoodImpostorLayer,
  deadwoodImpostorLayers,
} from './props/deadwood-bank.js'
import { bakeImpostor, buildImpostorCard } from './props/impostor.js'
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
  ['tier', 0, 1, 1, 'which mesh tier is drawn: 0 = T0 (15 sides), 1 = T1 (5 sides and flat stubs). Both are the SAME swept surface at different resolutions -- a tier change loses facets, it does not swap in a different log. Where the world steps between them is RELATIVE to the piece: DEADWOOD_LOD_AT holds T0 to 5x and T1 to 10x the longest axis, so a 2 m stump cards at 20 m and a 20 m log is still a mesh at 200. The ladder panel prints those distances for the piece on screen'],
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

  ['jag0', 0, 4, 0.05, 'BUTT end: how savagely the rim is broken, where 3.5 eats the most a rim is ever allowed to (40% of the length) and half of that really is half as deep, on every seed. 0 is a clean cut -- leave it there for a standing snag, whose butt is in the ground'],
  ['jag1', 0, 4, 0.05, 'FAR end: the same, and for a snag this is the break. Every seed gets the same LADDER of notch depths -- one at the full bite, one shallow, the rest between -- dealt to unevenly spaced splinters of unevenly broad tops. So how chewed the rim is holds still while how it is arranged does not, and the deepest notch always lands exactly on the number set here'],
  ['jagCount', 3, 10, 1, 'how many splinters go round. Wants to divide the tier\'s side count: 5 on T0\'s 15 puts one vertex on each splinter tip and two down in each notch'],
  // Past 1.0 the dish is deeper than the piece is wide, which is a HOLLOW you
  // can see into rather than a dished face -- a rotting stump with its heart
  // gone. That is a different object, not more of the same one, and it is worth
  // a third of the slider because it is the single most convincing dead thing
  // this generator makes.
  ['cup0', 0, 3, 0.02, 'BUTT end: how far the end face is pulled INTO the piece, as a fraction of its own radius. A rotten heart is dished; a sound break is flat. Past 1.0 it is a hollow you can see down'],
  ['cup1', 0, 3, 0.02, 'FAR end: the same'],

  ['flare', 0, 1.4, 0.02, 'root buttress at the very base, as a fraction of the butt radius. tree.js has none of this and can afford not to -- the bottom half metre of a living trunk is behind ferns. A SNAG IS ITS BOTTOM HALF METRE'],
  ['flareRun', 0.04, 0.6, 0.01, 'over what fraction of the length the flare dies away'],
  ['roots', 0, 12, 1, 'how many BUTTRESSES the flare breaks into. 0 or 1 leaves it a smooth collar. Wants to divide the tier\'s side count -- 6 roots on T0\'s 12 sides lands one vertex on each fin and one in each gap'],
  ['rootBite', 0, 2, 0.05, 'how hard the flare is pulled into the fins, as a fraction of itself. 1.0 = fins carry double, gaps carry none. ABOVE 1 the gaps cut INSIDE the taper radius, which is the pinch between two roots'],

  ['stubs', 0, 6, 1, 'broken branch stubs. Not branches: a stub is a short cone with a jagged end and no curve at all. They are the first thing a tier drops, at T1'],
  ['stubStart', 0, 0.9, 0.02, 'fraction of the length below which no stub grows'],
  ['stubEnd', 0.1, 1, 0.02, 'and above which none does. `jag` eats the top of the piece and `stubs` does not know it has: a stub placed at 0.95 on a trunk whose rim has been chewed back to 0.6 grows out of thin air. Keep this under 1 minus the deepest bite jag1 can take'],
  // To 4 rather than to 2.5, because 2.5 is where the default sits and a slider
  // whose default IS its ceiling can only be dragged one way -- you cannot tell
  // whether the value was chosen or whether the control ran out. Four diameters
  // is a long spar of a stub and obviously too much, which is the point: a range
  // has to overshoot to show you where the useful end was.
  ['stubLength', 0.3, 8, 0.05, 'as a multiple of the local DIAMETER'],
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

// The three bench sliders' own defaults, written once. They are needed in three
// places -- the opening state, the `defaults` button, and the table the changed
// labels compare against -- and a literal `snow: 0` in each of those is three
// chances for a bench slider to open orange, or to open at a value the
// `defaults` button then moves it off.
const BENCH_DEFAULTS = { snow: 0, moss: 0, brightness: 1 }

// One lookup for "what was this before anybody touched it", across both halves
// of the panel. Shape comes from the generator's own defaults so the bench
// cannot disagree with deadwood.js about what a default is.
const DEFAULT_OF = { ...DEADWOOD_DEFAULTS, ...BENCH_DEFAULTS }

const params = { ...DEADWOOD_DEFAULTS, ...BENCH_DEFAULTS }
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
  // WITH THE BILLBOARD LAYERS, which is what makes the CARD button show a card
  // rather than a quad nailed to the ground. A snag's quad is built with
  // `upNormal`, and the shader spins exactly those -- layer in this list AND a
  // vertical vertex normal (see CARD_UP_MARK in material.js). A log's quad is not
  // marked, so it stays in the plane it was photographed in even though its layer
  // is listed. The bench therefore gets the world's own behaviour for free, and
  // if the two ever diverge it is visible here first.
  const m = createPropMaterial(atlas, { billboardLayers: deadwoodImpostorLayers() })
  // The whole family is aged by a multiply on the material rather than by a
  // darkened set of atlas layers -- see DEADWOOD_TINT. The bench has to wear it
  // too or the bench is showing live bark. syncMaterial reapplies it every frame
  // the brightness slider moves.
  m.color.setHex(DEADWOOD_TINT)
  const arrayPatch = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => {
    arrayPatch(shader, r)
    wrapLambert(shader)
  }
  m.customProgramCacheKey = () => 'gen-deadwood-array-wrap-billboard-v1'
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
  // FROM THE TINT, not from white. This used to be `setScalar(1)`, which threw
  // DEADWOOD_TINT away on the first refresh and left the bench drawing live bark
  // through a material the world browns -- invisible until you put a baked card
  // (which carries the tint in its texels) next to the mesh, which is exactly
  // what the CARD button does.
  material.color.setHex(DEADWOOD_TINT).multiplyScalar(params.brightness)
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

// Draw the billboard instead of the mesh. NOT a mode and not a camera move: the
// question a card asks is "does this still read as a log from where I am
// standing", and you cannot answer it if pressing the button moves the view or
// changes the layout. So it composes with all four -- the gallery becomes twelve
// cards, the ladder becomes three copies of the one card, and PAIR is the view it
// was really built for, because the snag's card and the log's card are two
// different KINDS of billboard and that is only visible side by side.
let cardMode = false

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
  let card = null
  let drawn = geos
  if (cardMode) {
    // ONE PHOTOGRAPH PER KIND, which is not a shortcut for the bench -- it is
    // what the world does. There are two impostor layers for the whole family
    // (deadwood-bank.js), so every stump in the world wears one picture of a
    // stump and every log wears one picture of a log, stretched to its own
    // extents. A gallery of twelve seeds drawn from one bake is therefore the
    // honest view of the card, and the uncomfortable one: it is the question the
    // button exists to ask.
    //
    // The SUBJECT is what is on screen rather than the bank's chosen subject, so
    // a shape being tuned can be photographed before it is written down. Baked
    // into the kind's real layer either way, so the texel budget is the world's.
    const baked = new Map()
    items.forEach((it, i) => {
      const kind = it.opts.kind
      if (baked.has(kind)) return
      const m = geos[i].userData.deadwood.measured
      const layer = deadwoodImpostorLayer(kind)
      baked.set(kind, {
        layer,
        ext: bakeImpostor(renderer, geos[i], atlas, layer, {
          // The LONG horizontal axis, exactly as cardExtentsOf reads it: a log
          // photographed down its own length is a picture of a disc.
          width: Math.max(m.width, m.depth),
          height: m.height,
          azimuth: cardAzimuth(kind),
          // The family's own multiply, because the bank bakes with it. Whether
          // that is right is a question this button can now be pointed at.
          tint: DEADWOOD_TINT,
        }),
      })
    })
    drawn = items.map((it) => {
      const { layer, ext } = baked.get(it.opts.kind)
      const spun = it.opts.kind !== 'log'
      const quad = buildImpostorCard(ext.width, ext.height, layer, 1, {
        upNormal: spun,
        azimuth: spun ? 0 : cardAzimuth(it.opts.kind),
      })
      tris += quad.userData.impostor.triangles
      verts += quad.getAttribute('position').count
      bytes += geometryBytes(quad)
      return quad
    })
    card = { ...drawn[0].userData.impostor, ...baked.get(items[0].opts.kind).ext, kinds: baked.size }
    // clearGroup only disposes what is IN the group, and the meshes are not.
    for (const geo of geos) geo.dispose()
  } else {
    for (const geo of geos) {
      tris += geo.userData.deadwood.triangles
      verts += geo.userData.deadwood.vertices
      bytes += geometryBytes(geo)
    }
  }

  drawn.forEach((geo, i) => {
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

  return { tris, verts, bytes, count: items.length, card, stats: geos[0].userData.deadwood, barkFaces }
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

// The deepest a rim of the given `jag` can be bitten, as a fraction of the piece's
// length. Mirrors `endT`'s `bite` term: MAX_JAG at JAG_FULL, proportional below it.
const deepest = (jag) => MAX_JAG * Math.min(1, Math.max(0, jag) / JAG_FULL)

function refresh() {
  const s = rebuild()
  const d = s.stats
  const m = d.measured
  const per = Math.round(s.tris / s.count)
  const tierIndex = Math.round(params.tier)

  // --- this piece ---
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} on screen)` : ''}`],
    // In CARD mode the breakdown below is the mesh that was photographed, not
    // what is on screen, so the card says what it is instead and the mesh rows
    // step aside. Its size is the one number worth reading here: a card is
    // stretched to the piece's own extents plus the bake margin, so it should
    // come out a few per cent larger than the mesh in both axes and never
    // smaller.
    ...(s.card
      ? [
          [`&nbsp;&nbsp;card, ${s.card.planes} plane&times;2`, s.card.triangles],
          ['&nbsp;&nbsp;baked at', `${s.card.width.toFixed(2)} &times; ${s.card.height.toFixed(2)} m`],
          ['&nbsp;&nbsp;photographs', `${s.card.kinds === 2 ? 'a snag and a log' : params.kind === 'log' ? 'one log' : 'one snag'}, at tier ${Math.round(params.tier)}`],
        ]
      : [
          [`&nbsp;&nbsp;barrel, ${d.sides}&times;${d.rings}`, d.barrelTris],
          ['&nbsp;&nbsp;two end faces', d.capTris],
          [`&nbsp;&nbsp;${d.stubs} stub${d.stubs === 1 ? '' : 's'}`, d.stubTris],
        ]),
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
  document.getElementById('geonote').innerHTML = s.card
    ? `The card is a photograph of the mesh, taken into this kind's own layer -- one for every stump in the world and one for ` +
      `every log -- so it costs no disk and cannot disagree with the shape. The world always shoots T0; this bench shoots ` +
      `whatever <em>tier</em> is set, which is how you find out what the coarse silhouette would have cost the picture. ` +
      `<em>A SNAG'S CARD SPINS AND A LOG'S DOES NOT.</em> ` +
      `A stump is near enough a solid of revolution that turning its card to the eye shows the same silhouette from every side; a ` +
      `log has a HEADING, and a spun card would hold still against the eye while the mesh under it points along a yaw, so the log ` +
      `would appear to snap to a new direction at the swap and snap back when you walked in again. The log's card is therefore ` +
      `fixed in the plane it was photographed in and carried by the instance's own yaw. Orbit the ${mode === 'pair' ? 'pair' : 'piece'} ` +
      `and watch which one follows you.`
    : `<em>rings</em> is the only slider that moves the barrel: ${d.sides} sides &times; ${d.rings} rings &times; 2. ` +
    `The two end faces are fixed at 2 &times; ${d.sides} however ragged they are -- a fan has the same count whether its ` +
    `centre is proud, flat or dished, so the whole of <em>cup</em> is free. Stubs cost ${d.stubs ? `${d.stubTris} here` : 'nothing at this tier'} ` +
    `and are the first thing the ladder drops.`

  // --- the ladder ---
  // Two different distances per tier and they answer two different questions.
  //
  // `to N m` is WHERE THE WORLD ACTUALLY STEPS: DEADWOOD_LOD_AT times this
  // piece's own ladder size, which is the longest of its three measured axes.
  // That is the number to judge a tier by, and it is why the same slider setting
  // prints a different distance on a stump and on a 10 m log -- the ladder is
  // relative, so a big piece holds its mesh proportionally further out.
  //
  // `px` is the pixel model's opinion of where it COULD step -- switchDistance
  // sizes the step so a triangle never falls under about three pixels -- kept
  // beside it because the gap between the two is the budget being spent. Height
  // is what subtends there, and for a log that is its diameter rather than its
  // length; `measured.height` is already the right number for both kinds because
  // it is read off the built mesh after the lie-down.
  const lodSize = deadwoodLodSize(m)
  table(
    document.getElementById('ladderTable'),
    DEADWOOD_TIERS.map((t, i) => {
      const c = deadwoodCost(params, i)
      return [
        `${t.name} &nbsp;<span class="k">${c.sides}&times;${c.rings}${c.stubs ? ` +${c.stubs}` : ''}</span>`,
        `${c.triangles} tris &nbsp; to ${(lodSize * DEADWOOD_LOD_AT[i]).toFixed(0)} m ` +
          `&nbsp;<span class="k">px ${switchDistance(c.triangles, m.height).toFixed(0)} m</span>`,
        '',
        i === tierIndex && !s.card ? 'here' : '',
      ]
    }).concat([
      ['card &nbsp;<span class="k">1&times;1</span>', `2 tris &nbsp; to the ${DEADWOOD_CULL} m cull`, '', s.card ? 'here' : ''],
      ['ladder size, longest axis', `${lodSize.toFixed(2)} m`],
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
    // The DEEPEST bite either end can take. `jag` is read against JAG_FULL rather
    // than used raw: the slider is a fraction of what a rim may eat, and past
    // JAG_FULL it stops buying rim, so the number printed has to stop rising with
    // it or the readout says a stump is chewed 3.5 lengths down.
    ['break, butt / far', `${(deepest(params.jag0) * params.length * 100).toFixed(0)} / ${(deepest(params.jag1) * params.length * 100).toFixed(0)} cm at the deepest`],
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
    // NOT symmetric, and the asymmetry is the point: the mask opens a long way
    // below the cut and closes a short way above it, so a colony fades OUT into
    // the wood over three times the distance it fades IN. That is what makes it
    // read as growth rather than as a stencil.
    ['&nbsp;&nbsp;blend, below / above cut', `&minus;${MOSS.blend.toFixed(2)} / +${(MOSS.blend * MOSS.blendSkew).toFixed(2)}`],
    ['&nbsp;&nbsp;the fringe darkens to', `&times;${MOSS.fringe.toFixed(2)}`],
    ['&nbsp;&nbsp;how far it leans on DOWN', MOSS.down.toFixed(2)],
    // The one moss behaviour that is about dead wood specifically.
    ['&nbsp;&nbsp;climbs to, above own root', `${MOSS.rise.toFixed(1)} m, gone by ${(MOSS.rise + MOSS.riseBand).toFixed(1)} m`],
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
// In CARD mode the third pane becomes the photograph instead of the moss, which
// is the only place the baked texels can be READ: whether the silhouette
// survived the alpha cut, whether the dilate pass left a sooty rim, whether the
// piece is centred in its slice. Moss steps aside rather than bark or heartwood
// because moss is a uniform, not a decision the bake can get wrong.
const SWATCH_PANES = [
  ['bark', () => SPECIES[speciesIndex][1]],
  ['heartwood', () => LAYER.TIMBER_BEAM],
  ['moss', () => LAYER.MOSS],
]

function swatchPanes() {
  if (!cardMode) return SWATCH_PANES
  return [
    SWATCH_PANES[0],
    SWATCH_PANES[1],
    [`card, ${params.kind}`, () => deadwoodImpostorLayer(params.kind)],
  ]
}

function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')
  const panes = swatchPanes()
  const w = canvas.width / panes.length

  panes.forEach(([label, layerOf], i) => {
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
  document.getElementById('swatchnote').innerHTML = cardMode
    ? `The third pane is the baked card itself, and it is the only place the photograph can be read as pixels. The picture does ` +
      `not fill its slice: <em>bakeImpostor</em> leaves a transparent margin all round so a stub or a splinter leaning out cannot ` +
      `be sliced off at the edge, and the quad is built at the FRUSTUM rather than at the piece, which is what cancels the ` +
      `stretch. It is baked through <em>DEADWOOD_TINT</em> because the family's material carries that multiply -- a card baked ` +
      `untinted would be live bark standing in front of a player next to dead bark.`
    : layersLoaded
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

// --- precision, twice, because there are two different questions -------------
//
// `decimals` is a slider's step read as a number of places: 0.005 is three.
//
// `atStep` is what gets PRINTED. It kills float noise -- dragging `bark` lands
// on 0.30000000000000004 often enough -- without moving the value: a preset's
// authored 0.85 stays 0.85 rather than being nudged onto the nearest step, so
// what the copy says and what deadwood.js says are the same number.
//
// `onGrid` is what gets COMPARED. It snaps to the nearest value the slider can
// actually land on, which `atStep` deliberately does not, and that difference
// matters in exactly one case: a default that does not sit on the step grid.
// Drag such a slider away and back and the best you can reach is a neighbouring
// step, and a label left orange there would be pointing at a discrepancy the
// control cannot fix.
function decimals(step) {
  const s = String(step)
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

function atStep(v, step) {
  return Number(Number(v).toFixed(decimals(step)))
}

function onGrid(v, step) {
  return Math.round(Number(v) / step)
}

// Shape keys the bench does not put on a slider -- `kind`, `barkLayer`,
// `woodLayer`, `stubSides` -- have no step and are compared exactly. They are
// all discrete, so there is no noise to forgive.
function sameAsDefault(key, v) {
  const d = DEFAULT_OF[key]
  if (!(key in readouts)) return v === d
  const { step } = readouts[key]
  return onGrid(v, step) === onGrid(d, step)
}

function showValue(key, step) {
  const v = params[key]
  readouts[key].out.textContent = step >= 1 ? String(Math.round(v)) : Number(v).toFixed(2)
  // The changed mark is folded in HERE rather than into the input handler
  // because the handler is not the only way a value moves: a preset, the
  // `defaults` button and every future path all go through syncSliders, and
  // syncSliders goes through showValue. One choke point is the only arrangement
  // in which no path can leave a label lying about its row.
  readouts[key].label.classList.toggle('changed', !sameAsDefault(key, v))
}

for (const [key, min, max, step, help] of SLIDERS) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    `<label title="${help.replace(/"/g, '&quot;')}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  readouts[key] = { input, out: row.querySelector('.v'), label: row.querySelector('label'), step }
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
  const was = params.kind
  params.kind = kind
  // A KIND CHANGE IS A DEFAULTS CHANGE, and it did not used to be. Standing a
  // stump on its side does not make it a log: four of DEADWOOD_DEFAULTS' numbers
  // are authored for a rooted, rotted-out stump and are simply wrong lying down
  // (see LOG_DEFAULTS for which and why). Leaving them alone meant the log
  // button showed a 0.95 m stump on its side with a 3.5 jag eating half of it,
  // which is not the shape the world ships and so is not a shape anybody can
  // sign off here.
  //
  // Only on an ACTUAL change of kind, and only the LOG_DEFAULTS keys, so a
  // deliberate edit survives everything except pressing the other button.
  if (was !== kind) {
    const from = kind === 'log' ? LOG_DEFAULTS : DEADWOOD_DEFAULTS
    for (const key of Object.keys(LOG_DEFAULTS)) {
      if (key === 'kind') continue
      params[key] = from[key]
    }
    presetName = ''
    syncSliders()
  }
  for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === kind)
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
  // The bark layer IS one of the bank's axes -- every preset names one. Reflect
  // it in the dropdown rather than letting the select and the mesh disagree.
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
// Deliberately not a camera move and deliberately not exclusive with the four
// views -- see cardMode. Each press re-bakes, which is a stall of two ortho
// renders and two readbacks; that is what the world pays once at load, and here
// it buys a card that follows the sliders.
toggle('card', () => cardMode, (v) => { cardMode = v })
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
  Object.assign(params, DEADWOOD_DEFAULTS, BENCH_DEFAULTS, { seed: params.seed })
  presetName = ''
  presetSel.value = ''
  speciesIndex = 0
  speciesSel.value = '0'
  for (const [k, btn] of Object.entries(kindBtns)) btn.classList.toggle('on', k === params.kind)
  syncSliders()
  frame()
  refresh()
})

// --- copying the shape out ----------------------------------------------------
//
// The bench is where a shape gets DECIDED and deadwood.js is where it has to end
// up, and until this button there was no crossing between them: you tuned
// something worth keeping and then read thirty-four numbers off the panel by eye
// to type them back in, which nobody does twice.
//
// So what this emits is not a report, it is SOURCE, and it is one block rather
// than a choice of two. Live lines for every shape key that differs from
// DEADWOOD_DEFAULTS, commented lines for every key that does not, in
// deadwood.js's own key order. The live lines on their own are exactly a
// DEADWOOD_VARIANTS `p` value -- a variant names its difference and inherits the
// rest -- and uncommenting the whole block gives the full shape to paste over
// DEADWOOD_DEFAULTS. Nobody has to pick a mode before pressing the button, which
// matters because you do not know which of the two you wanted until you are
// looking at the numbers.
//
// `seed` is named in the header and kept OUT of the literal: it is not shape, it
// is which draw of the shape, and deadwoodParams overrides whatever a variant
// tries to say about it anyway. `snow`, `moss` and `brightness` are kept out for
// the harder reason -- they are not the generator's at all, they are two global
// uniforms and a bench dial, and a `p` block that named them would be pasting
// the previewer's weather into the world's bank.
const SHAPE_KEYS = Object.keys(DEADWOOD_DEFAULTS).filter((k) => k !== 'seed')

// `barkLayer: 2` would build and would be unreadable sitting in the bank beside
// eight entries that say LAYER.BARK_PINE. Reverse-looked-up out of LAYER rather
// than carried as a fifth column on SPECIES, so a renamed layer cannot leave
// this printing a constant that no longer exists -- it throws instead.
function layerName(value) {
  const name = Object.keys(LAYER).find((k) => LAYER[k] === value)
  if (name === undefined) throw new Error(`gen-deadwood: no LAYER constant equals ${value}`)
  return `LAYER.${name}`
}

function sourceValue(key, v) {
  if (key === 'kind') return `'${v}'`
  if (key === 'barkLayer' || key === 'woodLayer') return layerName(v)
  // Every numeric shape key except `stubSides` has a slider and so has a step.
  // stubSides is a count the bench does not expose, and 1 is its precision.
  return String(atStep(v, key in readouts ? readouts[key].step : 1))
}

function shapeSource() {
  const lines = []
  let changed = 0
  for (const key of SHAPE_KEYS) {
    // The species dropdown is the truth for `barkLayer`, not params: opts()
    // overrides it on the way into buildDeadwood, so params.barkLayer still
    // holds whatever the last preset said while the mesh on screen wears
    // whatever the dropdown says. Copying params here would hand back a bark the
    // page never drew.
    const v = key === 'barkLayer' ? SPECIES[speciesIndex][1] : params[key]
    const same = sameAsDefault(key, v)
    if (!same) changed++
    // Unchanged lines print the DEFAULT's own literal rather than the live
    // value: they claim to be the default, and a default that does not sit on
    // the step grid would otherwise print as the step beside it.
    //
    // `// ` and three spaces are the same width on purpose: the keys line up in
    // one column whether a line is live or not, so the block reads as a single
    // list of the shape with some of it switched off, which is what it is.
    lines.push(same ? `// ${key}: ${sourceValue(key, DEFAULT_OF[key])},` : `   ${key}: ${sourceValue(key, v)},`)
  }
  return { lines, changed }
}

function copyText() {
  const { lines, changed } = shapeSource()
  return [
    `// /gen-deadwood -- ${params.kind}, ${SPECIES[speciesIndex][0]} bark, seed ${params.seed}, ${presetName || 'custom'}.`,
    `// ${changed} of ${SHAPE_KEYS.length} shape keys differ from DEADWOOD_DEFAULTS. The LIVE lines are that`,
    '// difference and nothing else, which is what a DEADWOOD_VARIANTS `p` block wants; the',
    '// commented lines are already at their default -- uncomment the lot for the full shape,',
    '// to paste over DEADWOOD_DEFAULTS instead.',
    '{',
    ...lines,
    '}',
    `// bench only, not shape: snow ${atStep(params.snow, readouts.snow.step)}, ` +
      `moss ${atStep(params.moss, readouts.moss.step)}, brightness ${atStep(params.brightness, readouts.brightness.step)}`,
  ].join('\n')
}

const copyBtn = document.getElementById('copy')
let copyTimer = 0

function flashCopy(label, hold) {
  copyBtn.textContent = label
  clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyBtn.textContent = 'copy' }, hold)
}

copyBtn.addEventListener('click', () => {
  // navigator.clipboard is absent outright on a non-secure origin and the write
  // is permission-gated even on a secure one, so BOTH failures have to reach the
  // label. A button that silently did nothing would look exactly like a button
  // that worked, and the whole reason this exists is that there was no way to
  // get the numbers out -- "there was no way, and I could not tell" is worse
  // than the state it replaces. No textarea fallback: a copy that half works is
  // a copy nobody trusts. The failure holds four times as long because it is a
  // sentence to read rather than a word to notice, and it also goes to the
  // console, because `NotAllowedError` is a thing you look up.
  if (!navigator.clipboard) {
    flashCopy('no clipboard API', 4000)
    console.error('gen-deadwood: navigator.clipboard is undefined -- this page is not on a secure origin')
    return
  }
  navigator.clipboard.writeText(copyText()).then(
    () => flashCopy('copied', 1000),
    (e) => {
      flashCopy(`clipboard blocked (${e.name})`, 4000)
      console.error('gen-deadwood: clipboard write refused', e)
    }
  )
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
