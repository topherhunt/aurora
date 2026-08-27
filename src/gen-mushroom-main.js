import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildMushroom, mushroomTriangles, MUSHROOM_DEFAULTS } from './props/mushroom.js'
import {
  MUSHROOM_SPECIES, MUSHROOM_NAMES, MUSHROOM_VARIANTS,
  MUSHROOM_LOD_SPANS, MUSHROOM_MESH_RADIAL,
} from './props/mushroom-bank.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { bakeImpostor, buildImpostorCard } from './props/impostor.js'
import {
  CAP_FOREST, CAP_CAVE, FLESH, capCell, fleshCell, MUSHROOM_CELL_PX,
} from './props/mushroom-texture.js'
import { buildTextureArray, LAYER, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import mushroomSource from './props/mushroom.js?raw'
import textureSource from './props/mushroom-texture.js?raw'
import impostorSource from './props/impostor.js?raw'

// ---------------------------------------------------------------------------
// The procedural mushroom previewer (gen-mushroom.html).
//
// Same job as gen-fern.html -- see the range, price the tiers against
// DESIGN.md §5, and judge the card -- with two things that no other bench on
// this project has.
//
// THE FIRST IS THAT THE GALLERY IS A VARIANT MATRIX, NOT A SEED GRID. The fern
// bench walks seeds because a fern's seed rerolls an entire rosette. A mushroom
// built here is ONE mushroom -- `cluster` is 1 on every preset, because putting
// them in bunches is the scatter's job and the generator's job is the
// individual -- so the seed has almost nothing left to roll but a yaw, and
// twenty seeds would be twenty copies of one thing. The gallery instead crosses
// the current sliders against four axes (stemHeight, capRadius, capRise,
// stemCurve) into 54 cells, which turns the page into the question it is
// actually for: WHICH OF THESE CELLS ARE WORTH BAKING AS SHIPPED VARIANTS. The
// answer the bank settled on is drawn on the matrix -- six of the cells wear a
// gold ring -- so the question and its answer are in one picture.
//
// THE SECOND IS THAT THE PALETTE IS LIVE.
//
// That is not a flourish, it is the whole reason mushrooms are drawn this way.
// Every other textured prop wears a photograph, so its colour was decided in a
// scanner months ago and a bench can only show it to you. A mushroom's colour
// is four numbers in an array (props/mushroom-texture.js), so a colour picker
// here can regenerate a 64 px cell and re-upload the layer between two frames.
// And you cannot judge a colour by reading hex codes -- you judge it by putting
// fifty-four of them on a forest floor under the game's own noon light and
// looking. So the palette edits the real generator's real input and the world
// repaints.
//
// SCALE IS THE OTHER THING TO WATCH, and measuring it here settled a question
// I had assumed the other way round. A field mushroom is 9 cm, which sounds
// like §5's `grass` row -- but that row's 6-triangle tier is three crossed
// quads, and no solid of revolution reaches it. The floor for something that
// still reads as a cap on a stem is 12 triangles (radial 4, one cap ring, no
// underside), and a mushroom you would actually look at is 40 to 90. So a
// mushroom is BUSH class at every size, alongside the boulders and the stumps,
// and this page prices it there.
//
// What changes with size is not the ladder, it is the DISTANCES, and they go
// the opposite way to intuition on both ends:
//
//   - A 9 cm mushroom's parallax crossover is 3 m. It is card-legal almost
//     immediately -- but it is also 4 px tall at the class's 26 m card range
//     and under 2 px by 42 m, so the honest tier past the mesh is not a card,
//     it is a CULL. The panel prints that distance.
//   - Drag `height` to 2.6 m -- there is no cave-mushroom preset any more, but
//     the slider still reaches 3.5 -- and the crossover goes to 89 m, three
//     times the class's card range. Carding that at 26 m would be visibly
//     wrong. It has to stay mesh well past where a fern gives out.
//
// One generator, one ladder, two completely different draw distances -- which
// is why the parallax panel exists rather than a hardcoded number.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

// --- slider spec ------------------------------------------------------------
//
// Grouped, because there are thirty of them and an ungrouped list of thirty is
// a list you scroll past rather than one you use. Ranges go a little past what
// is useful in both directions on purpose -- `capCurve` at 8 is a plate and
// `capRise` at -0.4 is a bird bath, and seeing those is how you find where the
// useful range actually stops.
const SLIDERS = [
  ['— size', 'height', 0.02, 3.5, 0.005, 'tip of cap to ground, in metres. Under 0.35 m this is a grass-class prop; above it, bush class'],

  ['— cap', 'capRadius', 0.05, 0.9, 0.005, 'cap half-width, relative to total height'],
  [null, 'capRise', -0.4, 1.0, 0.01, 'height of the apex above the rim. Positive is every cap that sheds water; NEGATIVE is a funnel -- chanterelle, trumpet'],
  [null, 'capCurve', 0.6, 8, 0.05, 'how the rise is distributed. 1 = cone, 2 = dome, 4+ = flat parasol with a cliff at the rim'],
  [null, 'margin', -0.12, 0.14, 0.005, 'lifts (+) or turns down (-) the outer eighth only. A small number that changes the whole read'],
  [null, 'inroll', 0, 0.85, 0.01, 'tucks the rim back under. High = a young button that has not opened'],
  [null, 'wavy', 0, 0.6, 0.01, 'undulation of the rim. The single cheapest way to stop a cap looking turned on a lathe'],
  [null, 'lobes', 2, 9, 1, 'how many waves around. Prime-ish numbers read as organic; 4 reads as a mistake'],
  [null, 'umbo', 0, 0.25, 0.005, 'a nipple at the apex. Tiny, and half of what says "this is a specific mushroom"'],
  [null, 'capTilt', 0, 0.5, 0.01, 'tips the whole cap off the stem axis'],
  [null, 'sweep', 0.6, TAU, 0.02, 'how far round the cap goes. Less than full turn + stemHeight 0 = a BRACKET fungus on a log'],

  ['— underside', 'underside', 0, 1, 1, 'build the gilled underside at all. Off is now the DEFAULT -- it doubles as a puffball and halves the triangles, and a 9 cm cap is never seen from below. Turn it on to look at anything you could stand under'],
  [null, 'gillDrop', 0, 0.2, 0.005, 'how far the gills hang below the rim'],
  [null, 'gillBlades', 0, 24, 1, 'real radial fins hung under the cap, 2 triangles each. Only worth it on a mushroom you stand next to'],
  [null, 'gillDepth', 0, 1, 0.01, 'how far in toward the stem the underside reaches'],

  ['— stem', 'stemHeight', 0, 1.1, 0.01, 'stem length, relative to total height. 0 removes it entirely -- bracket fungus, puffball'],
  [null, 'stemRadius', 0.005, 0.3, 0.002, 'radius at HALF height, so taper stays symmetric about it'],
  [null, 'stemTaper', -0.6, 1.2, 0.01, 'positive = thick at the base. Negative = a club, thick at the top'],
  [null, 'bulb', 0, 1.2, 0.01, 'a swelling confined to the bottom fifth. The volva of an amanita'],
  [null, 'lean', 0, 0.9, 0.01, 'launch angle off vertical'],
  [null, 'stemCurve', 0, 1.4, 0.01, 'bend accumulated along the stem, so it is an S rather than a stick'],
  [null, 'ring', 0, 0.7, 0.01, 'skirt around the stem, as a fraction of cap radius. 0 = none'],
  [null, 'ringHeight', 0.15, 0.95, 0.01, 'where up the stem the skirt sits'],
  [null, 'ringDroop', 0, 1, 0.02, 'how far the skirt hangs'],

  ['— clump', 'cluster', 1, 12, 1, 'members in the troop. They share ONE geometry, so a clump of seven is one instance and one binding'],
  [null, 'clusterSpread', 0, 1.6, 0.02, 'how far members scatter, in units of height'],
  [null, 'clusterVary', 0, 1, 0.02, 'age spread. Younger members are smaller AND more domed AND more inrolled -- one organism at several stages'],
  [null, 'clusterLean', 0, 0.8, 0.01, 'how far outer members lean away from the centre, reaching for light'],

  ['— tiers', 'radial', 3, 16, 1, "the CAP's columns around the axis, and only the cap's -- the stem has its own count below. 5 is the floor at which a cap still reads as round"],
  [null, 'stemRadial', 3, 12, 1, "the STEM's own columns, and the skirt's, independent of the cap's. 3 is the floor, and it is a real floor rather than a nominal one: a stalk is thin enough that a triangular prism reads as round"],
  [null, 'capRings', 1, 4, 1, 'rings apex to rim. 1 is a faceted cone, 2 carries the profile curve'],
  [null, 'underRings', 1, 3, 1, 'rings across the underside'],
  [null, 'stemRings', 1, 5, 1, 'segments up the stem. 1 cannot show stemCurve at all'],

  ['— card', 'planes', 1, 4, 1, 'CARD ONLY: quads crossed about the axis. 1 vanishes edge-on unless something turns it'],
]

// --- presets ----------------------------------------------------------------
//
// The parameters themselves are IMPORTED from props/mushroom-bank.js and are
// not written down here. They used to be, and a second copy is the one failure
// this page cannot survive: the whole claim of a bench is that the thing on
// screen is the thing that ships, and a preset that had drifted by one number
// from the bank would quietly make it a picture of a mushroom the world does
// not contain. The bank also carries the argument for `cluster` being 1 on all
// five, which is a fact about the scatter rather than about this shelf, so it
// is not repeated here.
//
// What stays here is the argument about the SHELF, because that is a question
// about this page rather than about the world.
//
// Five shapes, named for the fungus each is aimed at. There were nine, and the
// four that went (bracket, puffball, cave giant, cave shelf) went because a
// preset is no longer a candidate variant -- it is a STARTING POINT that the
// gallery then takes 54 ways. Once every preset fans out into a matrix, a shelf
// of near-neighbours is buying overlap rather than range, and what earns a slot
// is a silhouette none of the others reaches by dragging: a domed button on a
// bulb, a bun on a barrel, a funnel, a plate on a wire, a cone.
//
// The removed four are all still reachable -- `sweep` below TAU with no stem is
// the bracket, `underside` off is the puffball, `height` at 2.6 is the cave
// giant -- which is the argument for a solid of revolution over a set of
// hand-authored variants: a bracket fungus and a parasol are not two models,
// they are two points.
//
// Every preset is applied OVER MUSHROOM_DEFAULTS, so an omitted key is the
// default. That is why none of them carry tier counts: `radial`, `capRings`,
// `underRings` and `stemRings` are one decision for the whole prop and belong
// in one place.
//
// Flattened to [name, params] pairs rather than handed round as the bank's
// object, because every consumer on this page wants the name and the parameter
// set together and in a fixed order -- the button loop below builds the shelf
// left to right, and the source panel counts the shelf's length.
const PRESETS = MUSHROOM_NAMES.map((name) => [name, MUSHROOM_SPECIES[name].params])

// `underside` is a slider, so it has to be 0/1 here rather than false/true, and
// it is derived from the default rather than assumed on. That assumption used
// to be harmless and is not any more: the shipped default is now OFF, and a
// bench that opened with the underside built would be showing you a mushroom
// with a third more triangles than the game draws.
const UNDERSIDE_0_1 = MUSHROOM_DEFAULTS.underside ? 1 : 0

const params = {
  ...MUSHROOM_DEFAULTS,
  underside: UNDERSIDE_0_1,
  // 1, because that is what the world draws: the shipped ladder's only card is
  // the single spun billboard (see MUSHROOM_LOD_SPANS). The slider still reaches
  // 4 so a crossed pair can be looked at, but the page must open on the card the
  // game has rather than on one it dropped.
  planes: 1,
  brightness: 1.0,
}

// --- live palette -----------------------------------------------------------
//
// Working copies of the three sheets' cell specs. Edited by the palette panel
// and read by nothing else -- the shipped values live in mushroom-texture.js,
// and the way an edit here becomes a shipped colour is that you copy the hex
// out and paste it into that array. Deliberately not persisted: this is a place
// to try things, and a bench that remembered your experiments would slowly stop
// showing you the thing the game actually draws.
const palette = {
  [LAYER.MUSHROOM_CAP]: CAP_FOREST.map((s) => ({ ...s })),
  [LAYER.MUSHROOM_CAP_CAVE]: CAP_CAVE.map((s) => ({ ...s })),
  [LAYER.MUSHROOM_FLESH]: FLESH.map((s) => ({ ...s })),
}

const CAP_PATTERNS = ['plain', 'warts', 'scales', 'wrinkles', 'fibres']
const FLESH_PATTERNS = ['gills', 'pores', 'plain']

const hex = (rgb) => '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
const unhex = (s) => [
  parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16),
]

// --- scene ------------------------------------------------------------------

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
// Orbit the camera rather than turning the mushroom, so the ground turns with
// it and the sun stays where it is. A cap is a surface of revolution, so a
// spinning MESH would be almost perfectly still -- and would hide the one thing
// that is not rotationally symmetric, which is the lighting.
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / TAU

// The game's noon, same as props.html and gen-fern.html, so a colour picked
// here is a colour picked under the light the mushroom will stand in. This is
// load-bearing for THIS page in a way it is not for the others: judging a hue
// under a different light is judging a different hue.
scene.add(new THREE.DirectionalLight(0xfff3e2, 2.1))
scene.children[0].position.set(3, 5, 2)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------

const GROUND_SIZE = 60
const GROUND_TILE = 3

const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
scene.add(ground)

// Fog has to move with the subject here, unlike every other bench on this
// project: this one spans 2 cm to 3.5 m, and a fixed near plane that sits past
// a three-metre cave mushroom would sit inside a field mushroom's gallery.
scene.fog = new THREE.Fog(0x0a1018, 11, 26)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.002
scene.add(grid)

// The rule is 10 cm rather than the fern bench's 1 m, because the default
// mushroom is 9 cm tall and a metre stick next to it is not a reference, it is
// a flagpole. It relabels itself when the subject grows past it.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
scene.add(rule)
let ruleMetres = 0.1

function placeRule() {
  // Nearest of 5 cm / 10 cm / 50 cm / 1 m / 2 m that is between a third and all
  // of the subject's height, so there is always something in shot to read the
  // scale off no matter which end of the range you are at.
  const choices = [0.05, 0.1, 0.5, 1, 2]
  ruleMetres = choices.find((c) => c >= params.height * 0.45) ?? 2
  const w = Math.max(0.004, ruleMetres * 0.02)
  rule.scale.set(w, ruleMetres, w)
  rule.position.set(-params.height * 0.9, ruleMetres / 2, -params.height * 0.5)
}

// --- material ---------------------------------------------------------------
//
// The REAL prop material, patched exactly as the game patches it and then with
// wrap diffuse chained on top -- chained, because assigning over
// onBeforeCompile would drop the sampler2DArray patch and every mushroom would
// render untextured white.
//
// Using the real material is not optional on this page even though a mushroom
// wears no cutout: the card tier's photograph IS a layer of the array, so a
// bench that bound a single `map` could not draw the card at all.
const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
material.customProgramCacheKey = () => 'gen-mushroom-array-wrap-v1'

// No loadImageLayers() call, and that is the headline of this page rather than
// an omission. Every mushroom layer is generated in buildTextureArray(), so
// there is no PNG in flight, no window where the prop is invisible, and nothing
// that can 404 in a build. Compare the fern bench, which has to say out loud
// that its subject does not exist for the first few hundred milliseconds.

const LAYER_STRIDE = TEX_SIZE * TEX_SIZE * 4
const CP = MUSHROOM_CELL_PX

function layerPixels(layer) {
  return atlas.image.data.subarray(layer * LAYER_STRIDE, (layer + 1) * LAYER_STRIDE)
}

// Repaint one cell of one layer, in place, and re-upload.
//
// The two sheet kinds are laid out differently -- flesh is a 2x2 grid of 64 px
// squares, caps are four stacked full-width 128 x 32 strips -- so this has to
// know which it is holding. See the sheet-assembly section of
// props/mushroom-texture.js, which owns both layouts.
//
// The re-upload is the whole sheet array, because three's DataArrayTexture has
// no partial path and setting needsUpdate regenerates every mip chain -- about
// 2.5 MB for 40 layers. That is far too much to do per pointer-move and exactly
// cheap enough to do once per animation frame, which is why the caller coalesces
// rather than uploading inline.
// Both sheet kinds are the same 2x2 grid now, so one painter covers all three.
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
  paintCell(layer, cell, layer === LAYER.MUSHROOM_FLESH ? fleshCell(spec) : capCell(spec))
  uploadQueued = true
}

// --- the mushrooms ----------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

// --- the variant matrix -----------------------------------------------------
//
// Four axes crossed over whatever the sliders currently say. Not seeds: with
// `cluster` at 1 the seed rolls a yaw and nothing else, so a seed gallery is a
// picture of one mushroom printed twenty times. These four are the axes that
// actually change what a mushroom IS -- how tall the stalk stands relative to
// the cap, how wide the cap is, how domed, and how far the stalk bends off
// vertical -- and 54 of them side by side is a thing you can have an opinion
// about, which a slider you drag one at a time is not.
//
// The first three are MULTIPLIERS of the current value, so the matrix travels
// with the preset instead of overwriting it. `stemCurve` is ABSOLUTE, because
// its interesting range is narrow and the same two numbers read correctly on
// every preset -- and because multiplying a preset's 0 by anything is still 0.
const V_STEM_HEIGHT = [1, 2 / 3, 1.5]
const V_CAP_RADIUS = [1, 2 / 3, 1.5]
const V_CAP_RISE = [1, 0.5, 2]
const V_STEM_CURVE = [0.3, 0.7]

// Laid out as a matrix rather than as a flat run of 54, because the whole value
// of the page is reading a position back to its parameters. Across: capRadius
// in blocks of three, stemHeight within each block. Down: stemCurve in blocks
// of three, capRise within each block. Index 0 is therefore the top-left cell
// and every multiplier there is 1, which is what makes it the baseline.
const GALLERY_COLS = V_CAP_RADIUS.length * V_STEM_HEIGHT.length
const GALLERY_ROWS = V_STEM_CURVE.length * V_CAP_RISE.length
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

// Where cell `i` stands, as [x, z]. One function rather than the formula twice,
// because the marks below have to land on the same cells the meshes do and a
// second copy of an index-to-position formula is a copy that can disagree.
function cellPosition(i, sp) {
  return [
    ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * sp,
    (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * sp,
  ]
}

// --- which cells the bank actually bakes ------------------------------------
//
// The 54 cells here and the 6 rows of MUSHROOM_VARIANTS are NOT the same list
// and must not be collapsed into one: this page is the full cross product, the
// exploratory thing you look at to decide, and the bank is the orthogonal
// subset that was decided. Merging them would delete the only place the
// rejected 48 are ever drawn, which is the page's whole reason to exist.
//
// But an answer is only an answer next to the question, so the six that were
// chosen are marked ON the gallery. Without it the only way to check the bank
// against the picture is to hold four multipliers in your head while counting
// cells, which is exactly the friction the legend below already exists to
// remove. Gold, because gold already means "this is the one in use" on this
// page -- it is the colour of the outline on the two texture cells the current
// mushroom wears.
//
// The lookup is EXACT, and a level that is not on an axis throws rather than
// going unmarked. The bank's rows are written in the same multipliers this file
// crosses, so a miss does not mean a rounding error -- it means the two lists
// have drifted apart, which is the one thing that would make a mark a lie.
const MARK_COLOR = 0xc9a227

function axisIndex(levels, value, axis) {
  const i = levels.findIndex((level) => Math.abs(level - value) < 1e-9)
  if (i < 0) throw new Error(`gen-mushroom: bank ${axis} ${value} is not one of the gallery's levels`)
  return i
}

const BAKED_CELLS = MUSHROOM_VARIANTS.map((v) => {
  const col = axisIndex(V_CAP_RADIUS, v.capRadius, 'capRadius') * V_STEM_HEIGHT.length
    + axisIndex(V_STEM_HEIGHT, v.stemHeight, 'stemHeight')
  const row = axisIndex(V_STEM_CURVE, v.stemCurve, 'stemCurve') * V_CAP_RISE.length
    + axisIndex(V_CAP_RISE, v.capRise, 'capRise')
  return row * GALLERY_COLS + col
})

// One material for all six rings, unlit and unfogged, so a mark stays the same
// gold at the near corner of the matrix and the far one -- it is annotation
// rather than something standing on the ground with the mushrooms.
const markMaterial = new THREE.MeshBasicMaterial({
  color: MARK_COLOR, fog: false, side: THREE.DoubleSide,
})

function variantParams(i) {
  const col = i % GALLERY_COLS
  const row = Math.floor(i / GALLERY_COLS)
  return {
    ...buildParams(params.seed),
    capRadius: params.capRadius * V_CAP_RADIUS[Math.floor(col / V_STEM_HEIGHT.length)],
    stemHeight: params.stemHeight * V_STEM_HEIGHT[col % V_STEM_HEIGHT.length],
    capRise: params.capRise * V_CAP_RISE[row % V_CAP_RISE.length],
    stemCurve: V_STEM_CURVE[Math.floor(row / V_CAP_RISE.length)],
  }
}

// One pitch for the whole matrix, keyed off the WIDEST cell in it, because the
// widest is the only one that can reach its neighbour and a pitch that suits
// the average interleaves the big row into a mat. That cell is the last column
// -- capRadius x1.5 crossed with stemHeight x1.5 -- but capRise and stemCurve
// move the footprint too (a flatter cap survives more of the rescale, a bent
// stalk carries its cap off the axis), so all six cells of that column are
// measured and the largest wins.
//
// MEASURED, not derived, and that is the point of doing it this way:
// buildMushroom rescales the finished thing to hit `height`, so how many
// centimetres across a capRadius of 0.63 actually comes out is not a number you
// can read off 0.63.
function gallerySpacing() {
  let widest = 0
  for (let row = 0; row < GALLERY_ROWS; row++) {
    const geo = buildMushroom(variantParams(row * GALLERY_COLS + (GALLERY_COLS - 1)))
    widest = Math.max(widest, geo.userData.mushroom.spread)
    geo.dispose()
  }
  return widest * 1.35
}

let galleryMode = false
let wireframe = false
let showGrid = true
let cardMode = false

// Which species' impostor layer `card` mode photographs into.
//
// There is one card per SPECIES in the shipped bank -- five photographs for
// thirty meshes -- so there is no longer a single scratch layer for a bench to
// borrow, and the honest thing for this page to do is bake into the layer the
// mushroom on screen would actually wear in the world. That means the page has
// to know which species is on screen, and the only moment it can know is when a
// preset button is pressed: past that the sliders are free, so what this tracks
// is the last preset LOADED rather than a claim about the current parameters.
// Drag `capRadius` to 0.9 after pressing `ink cap` and you are photographing a
// mushroom that is no longer an ink cap into the ink cap's layer, which is
// correct for a bench -- the layer is scratch space here, nothing else in this
// page reads it, and the alternative is picking a species by guessing at
// parameters.
//
// It starts on the first name rather than on nothing because the page opens on
// MUSHROOM_DEFAULTS, which is not any of the five, and `card` has to have a
// layer to write to before anyone has touched the shelf.
let cardSpecies = MUSHROOM_NAMES[0]

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

// The parameters buildMushroom actually wants, with the two slider-only knobs
// (`underside` as 0/1, `planes`) translated back.
function buildParams(seed) {
  return { ...params, seed, underside: params.underside >= 0.5 }
}

function rebuild() {
  clearGroup()
  material.wireframe = wireframe
  material.needsUpdate = true

  const specs = galleryMode
    ? Array.from({ length: GALLERY_N }, (_, i) => variantParams(i))
    : [buildParams(params.seed)]

  let tris = 0
  let verts = 0
  let bytes = 0
  // The most expensive cell in the matrix, tracked separately from the total
  // because with 54 unlike mushrooms an average is an average across things
  // that are not the same thing, and the number that has to fit the class's
  // budget is the worst one.
  let worst = 0
  let card = null

  // specs[0] is the baseline cell: every multiplier 1, and in single-mushroom
  // mode it is simply the sliders. That is what the card bakes from and what
  // the parallax panel measures, so it has to be something recognisable rather
  // than whichever corner of the matrix happened to be enumerated first.
  const geos = specs.map((spec) => buildMushroom(spec))
  const measured = geos[0].userData.mushroom

  let drawn = geos
  if (cardMode) {
    // The layer the last-pressed preset's species owns; see cardSpecies. The
    // bake and the card MUST name the same layer or the quads sample whatever
    // the previous species left there.
    const cardLayer = MUSHROOM_SPECIES[cardSpecies].impostorLayer
    const ext = bakeImpostor(renderer, geos[0], atlas, cardLayer, {
      width: measured.spread,
      height: measured.height,
    })
    drawn = geos.map((geo) => {
      const m = geo.userData.mushroom
      const k = m.height / measured.height
      const quad = buildImpostorCard(ext.width * k, ext.height * k, cardLayer, params.planes)
      tris += quad.userData.impostor.triangles
      worst = Math.max(worst, quad.userData.impostor.triangles)
      verts += quad.getAttribute('position').count
      bytes += geometryBytes(quad)
      return quad
    })
    card = { ...drawn[0].userData.impostor, ...ext }
    // clearGroup only disposes what is IN the group, and these never go in.
    for (const geo of geos) geo.dispose()
  } else {
    for (const geo of geos) {
      tris += geo.userData.mushroom.triangles
      worst = Math.max(worst, geo.userData.mushroom.triangles)
      verts += geo.userData.mushroom.vertices
      bytes += geometryBytes(geo)
    }
  }

  // Hoisted: gallerySpacing() builds and measures six mushrooms, which is cheap
  // once and silly fifty-four times.
  const sp = galleryMode ? gallerySpacing() : 0

  drawn.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, material)
    if (galleryMode) {
      const [x, z] = cellPosition(i, sp)
      mesh.position.set(x, 0, z)
    }
    group.add(mesh)
  })

  // The six cells the bank bakes, ringed on the ground. Added AFTER the counts
  // above are totalled and deliberately not folded into them: a ring is a note
  // written on the page, not a triangle the game ever draws, and putting it in
  // the budget line would misprice the class by six annotations.
  //
  // Built per rebuild rather than kept and moved because the pitch is measured
  // from the current sliders, so a ring that survived a slider drag would be
  // sized for a matrix that is no longer there. They go in `group`, so
  // clearGroup disposes them with everything else.
  if (galleryMode) {
    for (const i of BAKED_CELLS) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(sp * 0.40, sp * 0.45, 28).rotateX(-Math.PI / 2),
        markMaterial
      )
      const [x, z] = cellPosition(i, sp)
      // Above the ground plane by the same hair the grid uses, or the two
      // coplanar surfaces z-fight and the mark flickers as the camera orbits.
      ring.position.set(x, 0.002, z)
      group.add(ring)
    }
  }

  placeRule()
  grid.scale.setScalar(Math.max(0.5, params.height * 2.5))
  grid.visible = showGrid && !galleryMode
  rule.visible = showGrid && !galleryMode

  // The fog has to follow the subject; see the note where it is created.
  const reach = galleryMode ? sp * GALLERY_COLS : params.height * 8
  scene.fog.near = reach * 1.2
  scene.fog.far = reach * 3.0

  return { tris, verts, bytes, worst, count: specs.length, card, measured, spec: specs[0] }
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
  const enc = new TextEncoder()
  const geo = enc.encode(mushroomSource)
  const tex = enc.encode(textureSource)
  const imp = enc.encode(impostorSource)
  diskBytes = {
    geo: geo.byteLength, geoGz: await gzipped(geo),
    tex: tex.byteLength, texGz: await gzipped(tex),
    imp: imp.byteLength, impGz: await gzipped(imp),
  }
}

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// DESIGN.md §5, the `bush` row -- ferns, bushes, boulders, stumps, logs, and
// now mushrooms at every size. See the header for why the `grass` row does not
// apply even at 9 cm: its 6-triangle tier is three crossed quads and the floor
// for a solid of revolution is twelve.
const CLS = { name: 'bush', tiers: [84, 56, 28], lod0: 5, cardAt: 26, cardTris: 4 }

// Quest 2's default eye buffer, in pixels per degree. Every distance below is
// derived from it rather than guessed.
const PX_PER_DEG = 16.2
const apparentPx = (h, d) => (Math.atan(h / d) * 180) / Math.PI * PX_PER_DEG
// Where the prop drops under two pixels tall, which is where drawing it stops
// buying anything at all. For a 9 cm mushroom this lands around 42 m and for a
// 2.6 m one around 1200 m, and that spread is the actual output of this page.
const vanishAt = (h) => h / Math.tan((2 / PX_PER_DEG) * Math.PI / 180)

// Built here rather than authored into gen-mushroom.html because it has nothing
// to say outside variant mode, and an empty <p> that appears in the markup is
// an empty <p> somebody eventually fills with a caption.
const variantNote = document.createElement('p')
variantNote.className = 'note'
document.getElementById('geo').after(variantNote)

function refresh() {
  const s = rebuild()
  // The WORST cell, not the average. In variant mode the 54 are 54 different
  // mushrooms, so tris / count is the mean of a set of unlike things and means
  // nothing you can spend; what has to fit the budget is the most expensive one
  // of them. Outside variant mode there is exactly one mushroom and the two
  // numbers are the same.
  const per = s.worst

  // Which rung of the ladder this parameter set is aiming at: the finest tier
  // it still fits under. A set that fits nothing is over budget for the class.
  const rung = CLS.tiers.findIndex((t) => per <= t)
  const budget = s.card ? CLS.cardTris : (rung >= 0 ? CLS.tiers[rung] : CLS.tiers[0])
  const label = s.card ? 'bush card' : rung >= 0 ? `bush LOD${rung}` : 'bush LOD0'

  const predicted = mushroomTriangles(buildParams(params.seed))
  table(document.getElementById('geo'), [
    [galleryMode ? `triangles (worst of ${GALLERY_N})` : 'triangles',
      `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} total)` : ''}`],
    ...(s.card
      ? [
          [`&nbsp;&nbsp;card ${s.card.planes} plane${s.card.planes > 1 ? 's' : ''}&times;2`, s.card.triangles],
          ['&nbsp;&nbsp;baked at', `${s.card.width.toFixed(2)} &times; ${s.card.height.toFixed(2)} m`],
        ]
      : [
          ['&nbsp;&nbsp;cap', Math.round(params.radial) * (2 * Math.round(params.capRings) - 1)],
          ['&nbsp;&nbsp;underside', params.underside >= 0.5
            ? Math.round(params.radial) * 2 * Math.round(params.underRings) + Math.round(params.gillBlades) * 2
            : 0],
          // `stemRadial`, not `radial`: the stalk and the skirt carry their own
          // column count, and pricing them at the cap's would overcharge every
          // mushroom in the world by the difference.
          ['&nbsp;&nbsp;stem + ring', params.stemHeight > 1e-4
            ? Math.round(params.stemRadial) * 2 * Math.round(params.stemRings) + (params.ring > 1e-4 ? Math.round(params.stemRadial) * 2 : 0)
            : 0],
          // A clump of seven is ONE geometry and ONE instance, so it pays the
          // 37 ns of BatchedMesh binding once rather than seven times. That is
          // the argument for building troops into the geometry rather than
          // scattering seven singles: for small props the binding is the cost,
          // not the triangles.
          ['&nbsp;&nbsp;&times; cluster', Math.round(params.cluster)],
          ['&nbsp;&nbsp;per mushroom', Math.round(per / Math.max(1, Math.round(params.cluster)))],
          // The formula scripts/check-mushrooms.mjs gates. Shown because a
          // scatter has to price a tier before it builds one, and a formula
          // that has silently drifted from the builder would misprice a whole
          // forest.
          ['formula agrees', predicted === s.measured.triangles ? 'yes' : `NO (${predicted})`,
            predicted === s.measured.triangles ? 'ok' : 'warn'],
        ]),
    ['vertices', Math.round(s.verts / s.count)],
    ['drawn', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    [label, `${per} / ${budget} tris`, per <= budget ? 'ok' : 'warn'],
  ])

  // The legend for the matrix. Without it you read a cell back to its
  // parameters by counting rows on your fingers, which is enough friction to
  // stop you doing it -- and a matrix you cannot decode is a wallpaper.
  variantNote.innerHTML = galleryMode
    ? `<b>Across, ${GALLERY_COLS} columns:</b> capRadius &times;1, &times;2/3, &times;1.5 in blocks of three, ` +
      `and stemHeight &times;1, &times;2/3, &times;1.5 within each block. ` +
      `<b>Down, ${GALLERY_ROWS} rows:</b> stemCurve 0.3 for the top three rows and 0.7 for the bottom three, ` +
      `and capRise &times;1, &times;0.5, &times;2 within each block. ` +
      `The top-left cell is the sliders as they stand, with stemCurve pinned to 0.3, and it is the one ` +
      `<em>card</em> bakes its impostor from. ` +
      `<b>The ${BAKED_CELLS.length} gold rings</b> are the cells the shipped bank actually builds ` +
      `(<code>MUSHROOM_VARIANTS</code>): an orthogonal subset of these ${GALLERY_N}, every level of ` +
      `every axis appearing twice, chosen so ${BAKED_CELLS.length} meshes cover the four axes about as ` +
      `evenly as ${BAKED_CELLS.length} meshes can. The other ${GALLERY_N - BAKED_CELLS.length} are ` +
      `drawn and not shipped, which is what this page is for.`
    : ''

  // §5's parallax rule. `spread` is the clump's full reach across the axis, not
  // the cap's width, because a troop of seven is what the card has to stand in
  // for and a card that ignored the outliers would be a photograph of the
  // middle one.
  // §5's rule: a billboard's defect is PARALLAX, not detail, and the error is
  // an angle -- atan(depth / distance) -- which no triangle count touches.
  // Under ~2 deg it stops reading as wrong at walking pace, so a card is only
  // honest from `depth x 28.6` outward.
  //
  // `spread` is the CLUMP's full reach across the axis, not the cap's width,
  // because a troop of seven is what the card would have to stand in for and a
  // card framed on the middle one would clip the outliers.
  const m = s.measured
  const crossover = m.spread * 28.6
  const vanish = vanishAt(m.height)
  const dist = (d) => (d < 1 ? `${(d * 100).toFixed(0)} cm` : `${d.toFixed(1)} m`)
  const size = (v) => (v < 0.5 ? `${(v * 100).toFixed(1)} cm` : `${v.toFixed(2)} m`)
  table(document.getElementById('parallax'), [
    ['height', size(m.height)],
    ['spread (= depth)', size(m.spread)],
    ['spread / height', (m.spread / m.height).toFixed(2)],
    ['card legal from', dist(crossover)],
    ['class puts the card at', `${CLS.cardAt} m`, crossover <= CLS.cardAt ? 'ok' : 'warn'],
    // The two numbers that make this page worth having. A 9 cm mushroom is 4 px
    // tall where its class wants to card it and gone by 42 m, so its real last
    // tier is a cull, not a billboard. A 2.6 m one is 55 px at the same range
    // and still legible at 1200 m -- and its crossover says it must stay MESH
    // three times further out than the class assumes. Same generator.
    ['px tall at that range', `${apparentPx(m.height, CLS.cardAt).toFixed(1)} px`,
      apparentPx(m.height, CLS.cardAt) >= 6 ? 'ok' : 'warn'],
    ['under 2 px (cull here)', dist(vanish)],
  ])

  // The ladder render/v2/mushrooms.js actually walks, in metres FOR THIS
  // MUSHROOM. The bands are multiples of the prop's own span, so the metre
  // column moves with the sliders and the pixel column does not -- which is the
  // whole point of making them relative, and is much easier to believe when you
  // can drag `height` and watch one column move while the other sits still.
  //
  // Span is max(height, spread), for the reason MUSHROOM_LOD_SPANS gives: it
  // is what makes the card tier satisfy §5's parallax rule for a pancake
  // chanterelle and still not card a thimble-shaped ink cap at 1.8 m.
  const span = Math.max(m.height, m.spread)
  const meshRows = MUSHROOM_MESH_RADIAL.map((radial, t) => ({
    name: `LOD${t} &middot; mesh, radial ${radial}`,
    tris: mushroomTriangles({ ...s.spec, radial }),
  }))
  const ladder = [
    ...meshRows,
    { name: `LOD${MUSHROOM_MESH_RADIAL.length} &middot; spun triangle`, tris: 1 },
  ]
  table(document.getElementById('lod'), [
    ['span = max(height, spread)', size(span)],
    ...ladder.map((row, t) => {
      // The last tier has no band of its own: it runs from the final entry in
      // the table out to wherever the prop stops being worth drawing, and that
      // is the 2-px rule rather than another multiple of the span.
      const last = t === ladder.length - 1
      const out = last ? vanishAt(span) : span * MUSHROOM_LOD_SPANS[t]
      const px = apparentPx(span, out)
      return [
        row.name,
        `${row.tris} tris &middot; to ${dist(out)} &middot; ${px.toFixed(0)} px`,
        last || px >= 8 ? 'ok' : 'warn',
      ]
    }),
  ])
  document.getElementById('lodnote').innerHTML =
    `The bands are <b>multiples of the span</b>, not metres: ` +
    `${MUSHROOM_LOD_SPANS.join(', ')} of them. Drag <code>height</code> and the middle column ` +
    `moves while the pixel column does not -- every mushroom in the world swaps tier at the same ` +
    `<em>apparent size</em>, which is what makes one table serve a 6 cm forest-floor cap and a ` +
    `giant in a cave. The card comes in at ${MUSHROOM_LOD_SPANS[MUSHROOM_MESH_RADIAL.length - 1]} spans ` +
    `against the 28.6 &sect;5 demands, so it is 1.4&times; later than the parallax rule's floor for ` +
    `every shape this page can build.`

  drawSheets()

  if (!diskBytes) return

  const src = diskBytes.geo + diskBytes.tex + diskBytes.imp
  const srcGz = diskBytes.geoGz + diskBytes.texGz + diskBytes.impGz
  table(document.getElementById('mem'), [
    ['image files on disk', '<span class="big">0 B</span>', 'ok'],
    ['mushroom.js (the shape)', fmt(diskBytes.geo)],
    ['mushroom-texture.js (the colour)', fmt(diskBytes.tex)],
    ['impostor.js (the card)', fmt(diskBytes.imp)],
    ['total on disk', fmt(src)],
    ['gzipped over the wire', fmt(srcGz), 'ok'],
    ['3 sheets, in RAM', fmt(3 * LAYER_STRIDE)],
    ['1 baked card layer, in RAM', fmt(LAYER_STRIDE)],
    ['extra draw calls', '0', 'ok'],
    ['extra vertex attributes', '0', 'ok'],
  ])
  document.getElementById('memnote').innerHTML =
    `Not one byte of image ships. A cap is a flat colour, a rim shade and one pattern, ` +
    `so storing a photograph of it would be storing the output of a function -- and the ` +
    `function is up there in the palette, live. The 8 cap colours and 4 fleshes are ` +
    `<em>cells</em> of 3 shared layers rather than 12 textures, which is what keeps ` +
    `mushrooms inside the one prop material: the most numerous and smallest prop in the ` +
    `world is the worst possible thing to spend a draw call on. A ninth colour costs ` +
    `4 numbers and 0 bytes; a fourth sheet would cost ${fmt(LAYER_STRIDE)} of RAM and ` +
    `still no draw call.`

  table(document.getElementById('source'), [
    ['scanned source photographs', '0', 'ok'],
    ['authored meshes', '0', 'ok'],
    ['build steps (npm run props)', '0', 'ok'],
    ['shapes reachable', `${SLIDERS.length - 5} knobs`],
    ['presets on the shelf', PRESETS.length],
  ])
  document.getElementById('sourcenote').textContent =
    'Every other textured prop here wears a megascan and had its colour decided in a scanner. ' +
    'This one has no upstream asset at all, which is why the palette above can be a colour picker ' +
    'instead of a caption.'
}

// --- the sheets panel -------------------------------------------------------
//
// All three layers side by side, cell grid drawn on, and the two cells THIS
// mushroom is currently wearing outlined. That last part is what makes the
// panel usable rather than decorative: with 2x2 cells on 3 sheets there are 12
// squares up there and no way to tell from the geometry which two you are
// looking at.

function drawSheets() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const sheets = [
    [LAYER.MUSHROOM_CAP, 'forest'],
    [LAYER.MUSHROOM_CAP_CAVE, 'cave'],
    [LAYER.MUSHROOM_FLESH, 'flesh'],
  ]
  const w = canvas.width / sheets.length
  const h = canvas.height - 14

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')

  sheets.forEach(([layer, name], i) => {
    const px = layerPixels(layer)
    const img = new ImageData(TEX_SIZE, TEX_SIZE)
    for (let j = 0; j < TEX_SIZE * TEX_SIZE; j++) {
      const o = j * 4
      // Row 0 of a layer is v = 0 and a canvas draws row 0 at the top, so flip
      // or every cap hangs by its rim.
      const row = TEX_SIZE - 1 - Math.floor(j / TEX_SIZE)
      const d = (row * TEX_SIZE + (j % TEX_SIZE)) * 4
      img.data[d] = px[o]
      img.data[d + 1] = px[o + 1]
      img.data[d + 2] = px[o + 2]
      img.data[d + 3] = 255
    }
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, h)

    // Cell divider.
    ctx.strokeStyle = 'rgba(10,16,26,.55)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(i * w + w / 2, 0); ctx.lineTo(i * w + w / 2, h)
    ctx.moveTo(i * w, h / 2); ctx.lineTo(i * w + w, h / 2)
    ctx.stroke()

    // Which cell is in use. v = 0 is the BOTTOM of the drawn sheet, so cells 0
    // and 1 are the lower row on screen -- flip the row here too or the outline
    // lands on the wrong pair.
    const active = layer === LAYER.MUSHROOM_FLESH
      ? params.fleshCell
      : (layer === params.capLayer ? params.capCell : -1)
    if (active >= 0) {
      const cx = i * w + (active % 2) * (w / 2)
      const cy = (1 - Math.floor(active / 2)) * (h / 2)
      ctx.strokeStyle = '#c9a227'
      ctx.lineWidth = 2
      ctx.strokeRect(cx + 1, cy + 1, w / 2 - 2, h / 2 - 2)
    }

    ctx.fillStyle = layer === params.capLayer || layer === LAYER.MUSHROOM_FLESH ? '#7f96b8' : '#4a5a72'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(name, i * w + w / 2, canvas.height - 3)
  })
}

document.getElementById('swatchnote').innerHTML =
  'Two cap sheets and one flesh sheet, 2&times;2 cells each. The cap chart is <em>polar</em> ' +
  '-- across is the angle round the cap, up is apex to rim -- which is why the warts look ' +
  'stretched here and round on the mushroom. Gold outlines the two cells in use.'

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

// --- palette panel ----------------------------------------------------------

const paletteEl = document.getElementById('palette')

// A chip row is the cell selector AND the swatch AND the colour picker, which
// is three jobs in 22 pixels. Worth it: the alternative is a dropdown naming
// colours, and a name is exactly the thing you cannot judge a colour by.
function chipRow(label, setCell) {
  const wrap = document.createElement('div')
  wrap.className = 'row'
  wrap.innerHTML = `<label title="click to wear this cell">${label}</label>`
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

// Styled here rather than through a class because the chip IS its colour, and
// the selected-state outline has to sit over an arbitrary background -- a CSS
// rule cannot know whether to draw it light or dark.
function paintChip(btn, spec, selected) {
  btn.style.cssText =
    'width:22px;height:22px;padding:0;border-radius:3px;cursor:pointer;' +
    `background:${hex(spec.base)};` +
    (selected ? 'outline:2px solid #c9a227;outline-offset:1px;border-color:#c9a227'
              : 'outline:none')
  btn.title = spec.name
}

function sel(label, options, get, set, help) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<label title="${help}">${label}</label>`
  const s = document.createElement('select')
  s.style.cssText = 'flex:1;min-width:0'
  s.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join('')
  s.value = get()
  s.addEventListener('change', () => { set(s.value); refresh() })
  row.appendChild(s)
  paletteEl.appendChild(row)
  return s
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

const sheetRow = document.createElement('div')
sheetRow.className = 'row'
sheetRow.innerHTML = '<label title="which cap sheet this mushroom reads from">cap sheet</label>'
const sheetSel = document.createElement('select')
sheetSel.style.cssText = 'flex:1;min-width:0'
sheetSel.innerHTML = '<option value="forest">forest</option><option value="cave">cave</option>'
sheetSel.addEventListener('change', () => {
  params.capLayer = sheetSel.value === 'cave' ? LAYER.MUSHROOM_CAP_CAVE : LAYER.MUSHROOM_CAP
  syncPalette()
  refresh()
})
sheetRow.appendChild(sheetSel)
paletteEl.appendChild(sheetRow)

const capChips = chipRow('cap cell', (i) => { params.capCell = i })
const capColor = colorRow('cap colour', () => hex(palette[params.capLayer][params.capCell].base), (v) => {
  palette[params.capLayer][params.capCell].base = unhex(v)
  repaint(params.capLayer, params.capCell)
}, 'repaints the 64 px cell and re-uploads the layer, live')
const capPattern = sel('cap pattern', CAP_PATTERNS,
  () => palette[params.capLayer][params.capCell].pattern,
  (v) => {
    palette[params.capLayer][params.capCell].pattern = v
    repaint(params.capLayer, params.capCell)
  }, 'warts = fly agaric, scales = a split cuticle, wrinkles = chanterelle ridges, fibres = radial streaks')
const capAccent = colorRow('cap accent', () => hex(palette[params.capLayer][params.capCell].accent), (v) => {
  palette[params.capLayer][params.capCell].accent = unhex(v)
  repaint(params.capLayer, params.capCell)
}, 'the warts, the scales or the streaks -- whichever the pattern above draws')

const fleshChips = chipRow('flesh cell', (i) => { params.fleshCell = i })
const fleshColor = colorRow('flesh colour', () => hex(palette[LAYER.MUSHROOM_FLESH][params.fleshCell].base), (v) => {
  palette[LAYER.MUSHROOM_FLESH][params.fleshCell].base = unhex(v)
  repaint(LAYER.MUSHROOM_FLESH, params.fleshCell)
}, 'gills, stem and ring all read this one cell -- see the note on the sheets panel')
const fleshPattern = sel('flesh pattern', FLESH_PATTERNS,
  () => palette[LAYER.MUSHROOM_FLESH][params.fleshCell].pattern,
  (v) => {
    palette[LAYER.MUSHROOM_FLESH][params.fleshCell].pattern = v
    repaint(LAYER.MUSHROOM_FLESH, params.fleshCell)
  }, 'gills = a fan, pores = a sponge. Both leave lengthwise fibre where the stem samples')

// Pull every palette control back into agreement with `params` and `palette`.
// Called after anything that changes WHICH cell is selected, since all six
// controls above are views onto whichever cell that is.
function syncPalette() {
  sheetSel.value = params.capLayer === LAYER.MUSHROOM_CAP_CAVE ? 'cave' : 'forest'
  ;[...capChips.children].forEach((b, i) => {
    paintChip(b, palette[params.capLayer][i], i === params.capCell)
  })
  ;[...fleshChips.children].forEach((b, i) => {
    paintChip(b, palette[LAYER.MUSHROOM_FLESH][i], i === params.fleshCell)
  })
  capColor.value = hex(palette[params.capLayer][params.capCell].base)
  capAccent.value = hex(palette[params.capLayer][params.capCell].accent)
  capPattern.value = palette[params.capLayer][params.capCell].pattern
  fleshColor.value = hex(palette[LAYER.MUSHROOM_FLESH][params.fleshCell].base)
  fleshPattern.value = palette[LAYER.MUSHROOM_FLESH][params.fleshCell].pattern
}

// --- presets ----------------------------------------------------------------

const presetsEl = document.getElementById('presets')
for (const [name, spec] of PRESETS) {
  const b = document.createElement('button')
  b.textContent = name
  b.addEventListener('click', () => {
    // Over DEFAULTS, not over the current params: a preset that inherited
    // whatever you last dragged would be a different mushroom every time you
    // pressed it, which defeats the point of having somewhere to return to.
    Object.assign(params, MUSHROOM_DEFAULTS, { underside: UNDERSIDE_0_1, planes: params.planes }, spec, {
      seed: params.seed,
    })
    if (typeof params.underside === 'boolean') params.underside = params.underside ? 1 : 0
    // The one moment the page can know which of the five is on screen, which is
    // why `card` bakes into the layer this records rather than into a scratch
    // one. See cardSpecies.
    cardSpecies = name
    syncSliders()
    syncPalette()
    refresh()
  })
  presetsEl.appendChild(b)
}

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
  if (galleryMode) {
    const sp = gallerySpacing()
    const half = Math.hypot((GALLERY_COLS * sp) / 2, (GALLERY_ROWS * sp) / 2)
    const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.15
    controls.target.set(0, params.height * 0.35, 0)
    camera.position.set(0, dist * 0.62, dist * 0.78)
  } else {
    const h = params.height
    controls.target.set(0, h * 0.45, 0)
    camera.position.set(h * 1.5, h * 1.1, h * 2.0)
  }
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
toggle('gallery', () => galleryMode, (v) => { galleryMode = v; frame() })
toggle('grid', () => showGrid, (v) => { showGrid = v })
// Deliberately NOT a camera move: the question a card asks is "does this still
// read as a mushroom from where I am standing", which you cannot answer if the
// view jumps when you press the button.
toggle('card', () => cardMode, (v) => { cardMode = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, MUSHROOM_DEFAULTS, {
    underside: UNDERSIDE_0_1,
    planes: 1,
    seed: params.seed,
  })
  // Reset puts the page back where it opened, and it opened on no species at
  // all, so the card's scratch layer goes back to the one the page opened with
  // too. Leaving it on the last preset pressed would mean a reset mushroom kept
  // photographing itself into some other species' slot.
  cardSpecies = MUSHROOM_NAMES[0]
  // The palette too. A reset that restored the shape and left your experimental
  // magenta on the cap would be a reset you could not trust.
  for (const [layer, source] of [
    [LAYER.MUSHROOM_CAP, CAP_FOREST],
    [LAYER.MUSHROOM_CAP_CAVE, CAP_CAVE],
    [LAYER.MUSHROOM_FLESH, FLESH],
  ]) {
    source.forEach((s, i) => {
      palette[layer][i] = { ...s }
      repaint(layer, i)
    })
  }
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
// Not top-level await: the build target is es2020, and refresh() already
// tolerates the disk numbers being absent.
measureDisk().then(refresh)

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  // Coalesced here rather than in repaint(): dragging a colour picker fires
  // dozens of input events per second and each upload is the whole 2.5 MB
  // array plus its mip chains, so paying once per frame is the difference
  // between a live palette and a slideshow.
  if (uploadQueued) {
    atlas.needsUpdate = true
    uploadQueued = false
  }
  controls.update(dt)
  renderer.render(scene, camera)
})
