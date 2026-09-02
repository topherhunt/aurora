import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildTrunkV6, buildFoliageV6, resolveTreeV6, treeV6Lod, TREE_V6_DEFAULTS, V6_TILES,
} from './props/tree-v6.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-v6.js. Read that file's header for what a v6 tree
// is; this one is the eyepiece.
//
// It is /gen-tree's panel with two differences, and both are things v1 wanted:
//
//   THE LOD SLIDER IS FIRST, and it is a slider rather than three buttons,
//   because a v6 ladder is four rungs and the question you ask of it is "where
//   does this stop being convincing" -- which is a thing you drag through, not
//   a pair you A/B. It is also the only control on the panel that is not a
//   property of the tree, which is why it sits above the seed and outside the
//   copied JSON.
//
//   A LABEL GOES ORANGE THE MOMENT ITS VALUE LEAVES THE DEFAULT, and `copy`
//   puts every parameter on the clipboard as JSON. Between them the panel can
//   answer "what did I actually change" and "give it to me", which is the whole
//   difference between a previewer and a place a shape gets decided.
//
// TWO MATERIALS AND TWO MESHES PER TREE. The trunk is the shared prop material
// over the texture array, exactly as the game draws bark. The crown is a plain
// mapped Lambert over one of the two needle mats, tiled at `texMetres`, drawn
// two-sided with three's double-sided normal flip undone -- the same fix
// src/material.js makes, and for the same reason: without it the underside of
// a skirt hands the lighting a normal pointing at the ground and goes black.
// ---------------------------------------------------------------------------

// --- slider spec ------------------------------------------------------------
// `['#', title]` starts a group. Ranges are chosen so both ends are things you
// would plausibly want to SEE, not so both ends are good: `skirtDrop` past ~1.4
// hangs each skirt below the one under it and the stack stops being a canopy,
// and watching that happen is how you learn where the range stops.
const SLIDERS = [
  ['#', 'tier'],
  ['lod', 0, 3, 1, 'which rung to draw. 0, 1 and 2 are meshes -- the same generator asked for fewer spokes, fewer skirts and a wedge of a trunk -- and 3 is the card, one spun quad carrying a photograph of LOD0 baked off the tree in front of you. LOD0 wears the CUT-OUT needle mat and every tier past it wears the SOLID one, which is a material change rather than a geometry one and is most of what the coarse tiers buy'],

  ['#', 'size'],
  ['height', 1, 32, 0.25, 'metres, root to tip. Every shape slider below is a fraction of this, so the tree scales rather than growing'],

  ['#', 'trunk'],
  ['trunkSides', 3, 32, 1, 'sides around the trunk, costing `sides` triangles per ring. v1 spends 25 because a player stands against its trunk; a skirt crown hides everything above the lowest skirt, so this only has to hold up over the bare metre under it'],
  ['trunkLobe', 0, 0.5, 0.01, 'how far out of round, as a fraction of the radius. Three harmonics at a phase this tree drew for itself. Needs sides to spend: under 6 it is ignored'],
  ['trunkRings', 1, 6, 1, 'rings below the apex. The trunk always closes to a point, so 1 is a plain cone; raise it to let trunkBend curve rather than lean'],
  ['trunkRadius', 0, 0.09, 0.001, 'base radius as a FRACTION of height -- the panel prints the centimetres'],
  ['trunkBend', 0, 0.3, 0.005, 'sideways offset of the top, as a fraction of height. The skirts follow it: their axis is MEASURED off the built trunk, not recomputed'],
  ['barkRepeat', 0.5, 16, 0.5, 'bark tiles UP the trunk this many times. The tiling AROUND it is derived so a tile stays roughly square in world space'],

  ['#', 'roots'],
  ['roots', 0, 10, 1, 'spurs off the trunk\'s foot, diving into the soil, two triangles each. LOD0 only -- every coarse tier drops them, because the flare is centimetres of silhouette at the bottom of a tree that is by then a few dozen pixels tall'],
  ['rootRise', 0, 0.25, 0.005, 'MEAN height up the trunk of a spur\'s ridge corner, as a fraction of height. Each spur draws its own 40% either way'],
  ['rootLength', 0, 0.4, 0.005, 'spur length as a fraction of height, jittered 30% either way per spur'],
  ['rootAngle', 0, 1.5, 0.01, 'radians BELOW horizontal at the launch. Near 0 the spurs run along the surface; past ~1 they dive and almost nothing shows'],
  ['rootDroop', 0, 1.5, 0.01, 'how much further down the spur bends along its own length. A spur is a straight wedge, so this moves only where the tip lands'],
  ['rootWidth', 0, 2, 0.05, 'half a spur\'s width at the ground, as a fraction of the TRUNK\'s radius at its foot. Over 1 is deliberate: a buttress is wider than the trunk at the soil line. 0 draws no crown at all'],

  ['#', 'the stack'],
  ['skirts', 1, 28, 1, 'cones up the trunk. The whole density knob, and at `skirtSides` x 3 triangles each it is also the whole crown budget'],
  ['skirtBottom', 0, 0.8, 0.01, 'fraction of height the LOWEST apex sits at. This is the bare-trunk knob'],
  ['skirtTop', 0.3, 1, 0.01, 'and the highest, which is PINNED -- the top skirt takes no stagger and no shift, so at 1 its apex is the trunk\'s own measured tip. Under ~0.95 the tree ends in a bare spike'],
  ['skirtStagger', 0, 1.5, 0.05, 'how far an apex may wander inside its own gap, as a fraction of that gap. 0 leaves the spacing exactly as spacingByLength set it'],
  ['spacingByLength', 0, 1, 0.01, 'how much of the gap above a skirt is set by how long that skirt is. 0 spaces the stack evenly; at 1 a full-width whorl takes the whole gap and the short skirts at the tip and the foot crowd together, which is how a conifer actually stacks -- a whorl\'s own needles are what fill the space over it'],
  ['crownRadius', 0.03, 0.5, 0.005, 'the WIDEST skirt\'s rim, as a fraction of height'],
  ['crownPeak', 0, 1, 0.01, 'where up the stack that widest skirt sits. 0 = cone (spruce), 0.5 = round, 1 = inverted'],
  ['crownFullness', 0.2, 3, 0.05, 'falloff from that peak. <1 fuller and blockier, >1 pointier and sparser'],
  ['skirtMin', 0, 1, 0.01, 'smallest skirt as a fraction of the widest, so the top and the hem still carry foliage instead of collapsing to a point'],
  ['topGrow', 0, 1, 0.01, 'how much bigger the TOP skirt is than the crown profile asks for. Its apex is pinned to the trunk tip, so unlike every other skirt it cannot wander down to close the gap to the one below it -- and the profile makes it the shortest skirt on the tree. At 0 the tip shows bare wood'],

  ['#', 'one skirt'],
  ['skirtSides', 3, 24, 1, 'spokes around a skirt, costing 3 triangles each -- one fan triangle up to the apex on the trunk axis, two for the quad band down to the rim'],
  ['skirtDrop', 0.1, 2, 0.05, 'how far a skirt hangs, as a multiple of its OWN rim radius. Above ~0.5 the stack overlaps, which is what makes it a canopy rather than a set of shelves'],
  ['dropByHeight', 0, 3, 0.05, 'and how much further, in proportion, the skirts near the tip hang. They are short up there, so on skirtDrop alone their drop shrinks with their radius and the trunk shows between them. The one shape term that reads height rather than being a pure fraction of its own skirt'],
  ['skirtBow', 0, 0.4, 0.01, 'the mid ring\'s depth, off halfway by up to this much, drawn PER SPOKE. This is the whole reason a skirt has two sections: negative runs the slope out flat and drops it at the tips, positive drops it away from the trunk and flattens it at the hem, and at 0 every meridian is a straight line. Per spoke rather than per skirt because one sign for a whole cone gives a surface of revolution, which is the shape the eye reads as turned on a lathe'],
  ['bowOutward', 0, 1, 0.01, 'what share of those draws comes back NEGATIVE -- the flat-then-dropping half. Moving it changes how often a meridian bows out, not how far: each half of the draw is rescaled to the full skirtBow swing'],
  ['skirtLean', 0, 0.5, 0.01, 'radians a skirt\'s axis may tip off the trunk\'s, drawn per skirt. Neighbours lean independently, so the stack reads as whorls that grew crooked rather than as a tree bent over'],
  ['skirtShift', 0, 0.6, 0.01, 'and how far its apex may slide off the axis, as a fraction of its own rim radius. The top skirt ignores it, its apex being the tip of the tree'],

  ['#', 'the fray'],
  ['frayDepth', 0, 0.8, 0.01, 'per-spoke pull-in, as a fraction of the rim radius, drawn once per spoke and shared by the mid ring so the gore lines up with the notch it belongs to'],
  ['frayJag', 0, 0.6, 0.01, 'and how deep a LOBE cuts on top of that. A lobe runs across a whole run of neighbouring spokes and tapers to nothing at its own ends, so the rim scallops the way a mushroom cap does instead of sawing'],
  ['lobeWidth', 1, 8, 1, 'the most spokes one lobe may span, widths drawn inside it. At 1 every spoke is its own lobe and you are back to noise; up here the notches come at irregular intervals with several vertices to a scallop, which is the difference between torn and machined'],
  ['frayLift', 0, 1, 0.01, 'how far a pulled-in spoke rises back UP the cone, as a fraction of its own pull-in -- one draw drives both, because a notch cut into a cone travels up it as it travels in. At 1 the frayed rim stays roughly on the shell; at 0 it is cut flat and the notches sink inside, where the silhouette is a plain circle again'],
  ['hemWobble', 0, 0.8, 0.01, 'how far a spoke slides AROUND off the exact angle its index would give it, as a fraction of the angular step. Evenly spaced spokes are most of what reads as machined. Stops at 0.8 because at 1 two neighbours can meet and their triangle folds'],
  ['hemRise', 0, 1, 0.01, 'and how far it rides up or down on top of the lift, as a fraction of its ring\'s own drop. Signed, unlike the lift, so the hem is ragged rather than merely scalloped'],
  ['midFray', 0, 1, 0.01, 'how much of all five the MID ring inherits. 0 makes the fray a bite out of the edge; up near 1 it is a gore running most of the way up the skirt'],

  ['#', 'shading'],
  ['innerShade', 0, 1, 0.01, 'how dark every fan apex is baked, as a multiple of the rim\'s brightness. A crown is a stack of overlapping shells and no light rig the game can afford knows a skirt is under another one, so the occlusion is baked into the vertices -- lit honestly, every layer takes the same sun and the stack reads as one green mass. 1 turns it off'],
  ['shadeToTip', 0, 1, 0.01, 'how much of that darkening the TOP skirt is let off. Only the top one: its fan is the only fan on the tree with open sky above it. At 1 the peak is unshaded, which is what makes it read as the top rather than as another layer'],
  ['midShade', 0, 1, 0.01, 'how much of the apex\'s darkening a fully covered MID RING vertex takes. Coverage is measured per spoke against the rim of the skirt above, so the low skirts -- buried past their own mid ring -- darken all the way out and the tip ones, overhung by nothing, stay lit. This is what gives each layer its own depth instead of a dark spot at the trunk'],

  ['#', 'material'],
  ['texMetres', 0.15, 4, 0.05, 'one needle tile, in metres. The tiling AROUND a skirt is rounded to an integer so the seam lands on a tile boundary; the tiling DOWN it is free, the rim being a cut edge with nothing to meet'],
  ['leafSkyward', 0, 1, 0.01, 'how far a skirt normal turns toward the sky. The black-underside knob: 0 shades each cone by its own shell, 1 shades the crown as if lit from above'],
  ['alphaTest', 0.05, 0.95, 0.01, 'cutout threshold on the LOD0 mat. Low = lacy and aliased, high = eats the needles'],
  ['brightness', 0.4, 3, 0.05, 'multiplies the albedo of both materials. A material property, not geometry'],
]

// design/05-rendering.md's tree row: two mesh tiers at 550 and 380, and a near
// card of three quads. v6 runs FOUR rungs against that ladder's three, so its
// LOD2 has no class number to be over -- null rather than a made-up one, since
// a budget nobody set is worse than no budget at all.
const CLASS_BUDGET = [550, 380, null, 6]

// `lod` is the tier and `alphaTest`/`brightness` are the bench's dials, and
// none of the three is a property of the tree. They still get a slider, a
// default and an orange label -- they are just not shape, which is what keeps
// them out of the copied JSON.
const BENCH_KEYS = new Set(['lod', 'alphaTest', 'brightness'])
const DEFAULTS = { ...TREE_V6_DEFAULTS, lod: 0, alphaTest: 0.5, brightness: 1.0 }
const params = { ...DEFAULTS }

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const SKY = new THREE.Color(0x0a1018)
scene.background = SKY
scene.fog = new THREE.Fog(SKY, 40, 200)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// Spin orbits the CAMERA rather than turning the tree, so the ground turns with
// it and you are walking around a plant instead of watching one on a lazy
// susan. It also keeps the sun still, which matters twice here: the crown's
// shading and the card's baked-in gradient both have to be judged against a
// light that is not sweeping across them. Off by default.
controls.autoRotate = false
controls.autoRotateSpeed = (0.25 * 60) / (2 * Math.PI)

const SUN_DIR = new THREE.Vector3(3, 5, 2).normalize()
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.copy(SUN_DIR).multiplyScalar(20)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// 600 m of ground, because a 30 m tree in `sizes` wants a horizon and the fog
// has to close before the plane's edge does.
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

let grid = null

// A 1.7 m human-height rule. "Is this tree the right size" is the question this
// page most often has to answer, and against a 20 m conifer a one-metre box
// tells you nothing.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 1.7, 0.25),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(-2, 0.85, 0)
scene.add(rule)

// --- materials --------------------------------------------------------------

// The bark: the REAL prop material, patched the way the game patches it -- the
// array sampler from material.js, then wrap diffuse chained on top. Chained,
// not replaced: assigning over onBeforeCompile would drop the sampler2DArray
// patch and the trunk would render untextured white.
const atlas = buildTextureArray()
const barkMaterial = createPropMaterial(atlas)
{
  const arrayPatch = barkMaterial.onBeforeCompile
  barkMaterial.onBeforeCompile = (shader, r) => {
    arrayPatch(shader, r)
    wrapLambert(shader)
  }
  // A distinct key because this program is the array patch AND the wrap patch;
  // sharing three's default would let it hand us a cached program with only one
  // of them compiled in.
  barkMaterial.customProgramCacheKey = () => 'gen-tree-v6-bark-v1'
}
let layersLoaded = false
const layersReady = loadImageLayers(atlas).then((n) => {
  layersLoaded = true
  return n
})

// The crown. Not the array material: the needle mat is a TILED surface running
// several repeats across one skirt, and every layer of the prop atlas is a cut
// meant to be sampled once across a card.
const foliageMaterial = new THREE.MeshLambertMaterial({
  color: 0xffffff,
  alphaTest: 0.5,
  transparent: false,
  side: THREE.DoubleSide,
  // The crown's baked occlusion rides in on the geometry's grey `color`
  // attribute. Without this flag three drops the attribute without a word and
  // every skirt is lit exactly like the one above it.
  vertexColors: true,
})
foliageMaterial.onBeforeCompile = (shader) => {
  wrapLambert(shader)
  // Both sides of a skirt are the same surface, so three's double-sided flip
  // has to be undone or the underside of the crown goes black -- the same fix
  // createPropMaterial makes, argued in full at its normal_fragment_begin
  // patch. tree-v6.js authors the canopy shell's normal for this reason.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <normal_fragment_begin>',
    `#include <normal_fragment_begin>
    normal *= faceDirection;`
  )
}
foliageMaterial.customProgramCacheKey = () => 'gen-tree-v6-foliage-v1'

const texLoader = new THREE.TextureLoader()
const mats = {}
let matsLoaded = 0
for (const [key, url] of Object.entries(V6_TILES)) {
  // refresh() rather than drawSwatch(): a card baked before its mat landed is a
  // photograph of an untextured crown, and nothing else would ever re-take it.
  mats[key] = texLoader.load(url, () => {
    matsLoaded++
    refresh()
  })
  mats[key].wrapS = mats[key].wrapT = THREE.RepeatWrapping
  mats[key].colorSpace = THREE.SRGBColorSpace
  mats[key].anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
}

// --- the card ---------------------------------------------------------------
//
// The far rung, and it is baked HERE rather than shipped: v6 has no impostor
// layer in the atlas, and standing one up would be an asset decision this page
// is not far enough along to make. So the card is a live render target -- one
// orthographic frame of the LOD0 tree on the stage, taken at the moment you
// press the tier -- which is strictly more honest than a stale bake: it cannot
// be a photograph of a tree the sliders no longer describe.
//
// ORTHOGRAPHIC, because a card seen from 30 m and from 130 m has to be the same
// picture. A perspective capture bakes in one distance's worth of convergence
// and is visibly wrong at every other.
const CARD_TEX = 512
const CARD_MARGIN = 0.06
let cardTarget = null
let cardSize = { width: 1, height: 1 }

const cardMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  alphaTest: 0.5,
  transparent: false,
  side: THREE.DoubleSide,
})
cardMaterial.onBeforeCompile = (shader) => {
  // A CYLINDRICAL billboard: the quad turns about world up to face the eye and
  // never tips. Spherical would be wrong for a tree -- look down on a forest
  // from a ridge and every trunk would lie over toward you.
  //
  // Done in view space off the mesh's OWN origin, so a gallery of cards each
  // spins about its own trunk rather than all of them about the middle of the
  // grid.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `vec4 mvOrigin = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
    vec3 bUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    vec3 bRight = cross( bUp, normalize( -mvOrigin.xyz ) );
    float bLen = length( bRight );
    // Straight down the axis there is no unique right. It cannot be seen from
    // there either, so any answer will do -- but it must not be a NaN.
    bRight = bLen > 1e-4 ? bRight / bLen : vec3( 1.0, 0.0, 0.0 );
    vec4 mvPosition = mvOrigin;
    mvPosition.xyz += bRight * transformed.x + bUp * transformed.y;
    gl_Position = projectionMatrix * mvPosition;`
  )
}
cardMaterial.customProgramCacheKey = () => 'gen-tree-v6-card-v1'

const bakeScene = new THREE.Scene()
const bakeSun = new THREE.DirectionalLight(0xfff3e2, 2.1)
bakeScene.add(bakeSun)
bakeScene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))
const bakeTrunk = new THREE.Mesh(new THREE.BufferGeometry(), barkMaterial)
const bakeFoliage = new THREE.Mesh(new THREE.BufferGeometry(), foliageMaterial)
bakeScene.add(bakeTrunk, bakeFoliage)

function bakeCard(trunkGeo, foliageGeo, stats) {
  const width = Math.max(0.2, stats.crownWidth) * (1 + CARD_MARGIN * 2)
  const height = stats.height * (1 + CARD_MARGIN)
  cardSize = { width, height }

  if (!cardTarget) {
    cardTarget = new THREE.WebGLRenderTarget(CARD_TEX, CARD_TEX, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    })
    cardMaterial.map = cardTarget.texture
    cardMaterial.needsUpdate = true
  }

  bakeTrunk.geometry = trunkGeo
  bakeFoliage.geometry = foliageGeo

  const reach = Math.max(width, height)
  const cam = new THREE.OrthographicCamera(-width / 2, width / 2, height, 0, 0.01, reach * 8)
  // Level with the ground and looking horizontally, so camera-y IS world-y and
  // the frustum's [0, height] puts the tree's feet on the texture's bottom edge.
  // Any tilt bakes a worm's- or bird's-eye view into a card that will be seen
  // from neither.
  cam.position.set(0, 0, reach * 2)
  cam.lookAt(0, 0, 0)
  // The key at the camera's own azimuth, so the photograph carries a top-to-
  // bottom gradient and no left-right terminator: a card is seen from every
  // direction on the compass, and half the time a baked bright side would be
  // facing away from the real sun.
  bakeSun.position.set(0, reach * 2.1, reach * 0.9)

  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()
  renderer.setRenderTarget(cardTarget)
  // Alpha 0 rather than the sky: what is not tree has to be a hole, or the card
  // is a rectangle of night sky standing in a daylit forest.
  renderer.setClearColor(0x000000, 0)
  renderer.render(bakeScene, cam)
  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)

  bakeTrunk.geometry = new THREE.BufferGeometry()
  bakeFoliage.geometry = new THREE.BufferGeometry()
}

// A quad standing on the ground, sized to whatever the bake framed. Two
// triangles: a v1 tree's card is one, and it can be, because that card is a
// species-wide bake with a shape chosen for it. This one is the honest default
// until somebody measures which way up a v6 silhouette packs best.
function buildCardGeometry(scale) {
  const geo = new THREE.PlaneGeometry(cardSize.width * scale, cardSize.height * scale)
  geo.translate(0, (cardSize.height * scale) / 2, 0)
  return geo
}

// --- the trees --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const COLS = 5
const ROWS = 4
const SIZE_LADDER = [0.2, 0.45, 1, 1.8, 3]

let view = 'single' // 'single' | 'gallery' | 'sizes'
let wireframe = false
let showGrid = true

// The widest built tree, for gallery spacing and camera framing.
let lastWidth = 1

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

function rebuild() {
  const tier = Math.round(params.lod)
  const isCard = tier === 3
  const meshTier = isCard ? 0 : tier

  barkMaterial.wireframe = wireframe
  foliageMaterial.wireframe = wireframe
  barkMaterial.color.setScalar(params.brightness)
  foliageMaterial.color.setScalar(params.brightness)
  cardMaterial.color.setScalar(params.brightness)
  // The mat swap IS most of what a coarse tier buys, so it follows the tier
  // rather than being a button of its own -- see the ladder note on the page.
  foliageMaterial.map = meshTier === 0 ? mats.alpha : mats.solid
  // The cutout goes with the wireframe: an alpha-tested wireframe throws away
  // most of every line and shows a topology nobody has.
  foliageMaterial.alphaTest = meshTier === 0 && !wireframe ? params.alphaTest : 0
  foliageMaterial.needsUpdate = true

  const p = treeV6Lod(params, meshTier)

  const jobs = []
  if (view === 'gallery') {
    for (let i = 0; i < COLS * ROWS; i++) jobs.push({ seed: Number(params.seed) + i, height: params.height })
  } else if (view === 'sizes') {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        jobs.push({ seed: Number(params.seed) + r, height: params.height * SIZE_LADDER[c] })
      }
    }
  } else {
    jobs.push({ seed: Number(params.seed), height: params.height })
  }

  clearGroup()

  const agg = { tris: 0, verts: 0, bytes: 0, trunk: 0, root: 0, skirt: 0, card: 0, count: jobs.length }
  // The metre readouts describe ONE tree, and in the size ladder it has to be
  // the one at the height on the slider -- otherwise dragging `height` moves
  // every number in the panel except the one it is named after.
  let measured = null
  let measuredErr = Infinity
  let width = 0

  const built = jobs.map((job) => {
    const opts = { ...p, seed: job.seed, height: job.height }
    const { geometry: trunk, frame, tree } = buildTrunkV6(opts)
    const foliage = buildFoliageV6(opts, frame)
    const f = foliage.userData.foliage
    const stats = {
      height: tree.height,
      belowGround: tree.belowGround,
      trunkDiameter: tree.trunkDiameter,
      crownWidth: f.crownRadius * 2,
      crownBase: f.crownBase,
      crownTop: f.crownTop,
      skirts: f.skirts,
      sides: f.sides,
    }
    const err = Math.abs(job.height - params.height)
    if (err < measuredErr) {
      measuredErr = err
      measured = stats
    }
    width = Math.max(width, stats.crownWidth, tree.crownWidth)
    return { trunk, foliage, tree, f, stats }
  })

  lastWidth = Math.max(0.2, width)
  const spacing = lastWidth * 1.25

  if (isCard) {
    // ONE bake feeds every card on screen, which is not a shortcut but the
    // shipping arrangement: an impostor is one picture per species, so a seed
    // gallery at this tier really does show twenty instances of one tree and a
    // size ladder really does show one picture scaled. Seeing that is the point
    // of looking.
    bakeCard(built[0].trunk, built[0].foliage, built[0].stats)
    built.forEach((b, i) => {
      const geo = buildCardGeometry(b.stats.height / built[0].stats.height)
      agg.tris += 2
      agg.card += 2
      agg.verts += geo.getAttribute('position').count
      agg.bytes += geometryBytes(geo)
      place(new THREE.Mesh(geo, cardMaterial), i, spacing)
      b.trunk.dispose()
      b.foliage.dispose()
    })
  } else {
    built.forEach((b, i) => {
      agg.tris += b.tree.triangles + b.f.triangles
      agg.verts += b.tree.vertices + b.f.vertices
      agg.trunk += b.tree.trunkTris
      agg.root += b.tree.rootTris
      agg.skirt += b.f.triangles
      agg.bytes += geometryBytes(b.trunk) + geometryBytes(b.foliage)
      place(new THREE.Mesh(b.trunk, barkMaterial), i, spacing)
      place(new THREE.Mesh(b.foliage, foliageMaterial), i, spacing)
    })
  }

  rule.visible = showGrid
  rule.position.x = view === 'single' ? -Math.max(1.2, lastWidth * 0.75) : -(COLS / 2 + 0.35) * spacing

  // Fog and grid scale with the subject: a 1 m sapling and a 30 m conifer want
  // very different horizons, and a fixed one either hides the tree or does
  // nothing at all.
  const reach = view === 'single' ? params.height : Math.max(params.height, spacing * COLS)
  scene.fog.near = reach * 1.5
  scene.fog.far = reach * 9

  // 1 m cells while that stays under 120 lines, then coarser -- a 300 m ladder
  // drawn at 1 m is a solid blue sheet and costs more than the trees do.
  const gridSpan = Math.max(4, Math.round(reach * 2))
  if (!grid || grid.userData.span !== gridSpan) {
    if (grid) {
      scene.remove(grid)
      grid.geometry.dispose()
      grid.material.dispose()
    }
    grid = new THREE.GridHelper(gridSpan, Math.min(gridSpan, 120), 0x2b4a72, 0x16233a)
    grid.position.y = 0.01
    grid.userData.span = gridSpan
    scene.add(grid)
  }
  grid.visible = showGrid

  return { ...agg, measured }
}

function place(mesh, i, spacing) {
  if (view !== 'single') {
    mesh.position.set(
      ((i % COLS) - (COLS - 1) / 2) * spacing,
      0,
      (Math.floor(i / COLS) - (ROWS - 1) / 2) * spacing
    )
  }
  group.add(mesh)
}

// --- camera framing ---------------------------------------------------------

function frameCamera() {
  const spacing = lastWidth * 1.25
  const half =
    view === 'single'
      ? Math.max(params.height, lastWidth) * 0.6
      : Math.hypot((COLS * spacing) / 2, (ROWS * spacing) / 2)
  const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.5
  controls.target.set(0, view === 'single' ? params.height * 0.45 : params.height * 0.3, 0)
  camera.position.set(0, dist * 0.45, dist * 0.9)
}

// --- panel ------------------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

const TIER_NAMES = ['LOD0', 'LOD1', 'LOD2', 'card']

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// The ladder, priced for the tree on the stage rather than for a class average
// -- a 3 m sapling and a 25 m conifer sit at opposite ends of the same sliders,
// and a class number describes neither. The mesh rungs are resolveTreeV6
// applied to treeV6Lod, which is the same pair the builder grows from, so a
// change to either law moves this table with it. The card is two by
// construction, being a quad.
function ladderRows() {
  const rows = []
  for (let t = 0; t < 3; t++) {
    const p = treeV6Lod(params, t)
    const r = resolveTreeV6(p)
    rows.push({
      name: TIER_NAMES[t],
      what: `${Math.round(p.trunkSides)}-side trunk, ${r.skirts}x${r.skirtSides} skirt`,
      mat: t === 0 ? 'cut-out' : 'solid',
      tris: r.triangles,
    })
  }
  rows.push({ name: 'card', what: 'one spun quad, baked off LOD0', mat: 'baked', tris: 2 })
  return rows
}

function refresh() {
  const s = rebuild()
  const tier = Math.round(params.lod)
  const per = Math.round(s.tris / s.count)
  const budget = CLASS_BUDGET[tier]
  const rows = ladderRows()
  const meshP = treeV6Lod(params, Math.min(tier, 2))
  const r = resolveTreeV6(meshP)

  // The breakdown describes what is ON THE STAGE, so at the card tier it is one
  // row. Printing LOD0's skirt count beside a zero would read as a bug in the
  // builder rather than as a tier that has no skirts.
  const breakdown = s.card
    ? [['&nbsp;&nbsp;card', `2 &mdash; one bake, ${s.count} instance${s.count > 1 ? 's' : ''}`]]
    : [
        [`&nbsp;&nbsp;trunk ${r.trunkTris > 0 ? `${Math.round(meshP.trunkSides)} sides &times; ${Math.round(meshP.trunkRings)}` : '&mdash;'}`, Math.round(s.trunk / s.count)],
        [`&nbsp;&nbsp;roots ${r.roots}&times;2`, Math.round(s.root / s.count)],
        [`&nbsp;&nbsp;skirts ${r.skirts}&times;${r.skirtSides}&times;3`, Math.round(s.skirt / s.count)],
      ]

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} total)` : ''}`],
    ...breakdown,
    ['vertices', Math.round(s.verts / s.count)],
    ['drawn here', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    budget === null
      ? [`tree-class ${TIER_NAMES[tier]}`, 'the shipped ladder has no third mesh tier']
      : [`tree-class ${TIER_NAMES[tier]}`, `${per} / ${budget} tris`, per <= budget ? 'ok' : 'warn'],
  ])

  document.getElementById('geonote').innerHTML = s.card
    ? `One mesh and one draw call: a quad ${cardSize.width.toFixed(2)} &times; ${cardSize.height.toFixed(2)} m ` +
      `carrying a ${CARD_TEX}&sup2; photograph of the LOD0 tree, taken here and spun about world up in the ` +
      `vertex shader. Every card on the stage samples that one bake, which is what an impostor is.`
    : `Two meshes and two draw calls per tree: the trunk is the shared prop material over the texture ` +
      `array, exactly as the game draws bark, and the crown is one mapped Lambert over ` +
      `<em>${tier === 0 ? 'pine-mat-alpha' : 'pine-mat-solid'}.png</em> tiled at ` +
      `<em>${params.texMetres.toFixed(2)} m</em>. There is no third primitive: v6 has no branches, so ` +
      `every triangle above is either wood or a skirt.`

  const lodEl = document.getElementById('lod')
  lodEl.innerHTML = rows
    .map(({ name, what, mat, tris }, i) =>
      `<tr class="${i === tier ? 'here' : ''}">` +
        `<td class="k">${name} <span style="opacity:.7">${what}</span></td>` +
        `<td class="band">${mat}</td><td class="n">${tris}</td></tr>`
    )
    .join('')

  const f = s.measured
  const crownH = Math.max(0, f.crownTop - f.crownBase)
  table(document.getElementById('measure'), [
    ['height', `${f.height.toFixed(2)} m`],
    ['crown width', `${f.crownWidth.toFixed(2)} m`],
    ['crown depth', `${crownH.toFixed(2)} m`],
    ['trunk at the base', `${(f.trunkDiameter * 100).toFixed(0)} cm`],
    ['bare trunk below it', `${f.crownBase.toFixed(2)} m`],
    ['crown / height', (f.crownWidth / Math.max(1e-6, f.height)).toFixed(2)],
    ['skirts on it', `${f.skirts} @ ${f.sides} spokes`],
    [
      'one skirt covers',
      `${(crownH / Math.max(1, f.skirts)).toFixed(2)} m of stack`,
    ],
    [
      'below ground',
      f.belowGround > 0.005 ? `${(f.belowGround * 100).toFixed(0)} cm` : 'none',
      f.belowGround > f.height * 0.2 ? 'warn' : 'ok',
    ],
  ])

  drawSwatch()
}

// --- the mat swatch ---------------------------------------------------------
//
// Both tiles side by side, with the live one named. They are the same needles;
// what differs is the alpha, and reading the two together is how you tell "the
// crown is too sparse" from "the cut has too much air in it".
function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = false

  const w = canvas.width / 2
  const order = ['alpha', 'solid']
  order.forEach((key, i) => {
    const img = mats[key].image
    if (img) ctx.drawImage(img, i * w, 0, w, canvas.height)
  })

  const live = Math.round(params.lod) === 0 ? 0 : 1
  ctx.strokeStyle = '#4a7fbf'
  ctx.lineWidth = 2
  ctx.strokeRect(live * w + 1, 1, w - 2, canvas.height - 2)

  if (matsLoaded < order.length) {
    ctx.fillStyle = 'rgba(8,14,26,.75)'
    ctx.fillRect(0, canvas.height / 2 - 9, canvas.width, 18)
    ctx.fillStyle = '#c9a227'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('the mats are still loading', canvas.width / 2, canvas.height / 2 + 4)
  }

  document.getElementById('swatchnote').innerHTML =
    `Left is <em>pine-mat-alpha.png</em> and right is <em>pine-mat-solid.png</em>; the boxed one is ` +
    `what the tier on screen is wearing. Both are 128&sup2; and both tile, which is the property a ` +
    `skirt needs and a leaf CUT does not have -- v1's art is one spray meant to be sampled once ` +
    `across a card, and stretching it over a cone would read as one enormous leaf. The cut-out is ` +
    `only 9% clear, so the fray in the geometry is doing most of the work of a ragged edge and the ` +
    `alpha is doing the rest. The solid one is not a fallback: it is fully opaque, which is what a ` +
    `distant crown should be made of, because an alpha test at range swims frame to frame as a ` +
    `one-pixel skirt's coverage flickers.`
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}

// --- precision, twice, because there are two different questions -------------
//
// `atStep` is what gets PRINTED and COPIED. It kills float noise -- dragging a
// 0.005 slider lands on 0.30000000000000004 often enough -- without moving the
// value onto the step grid, so a hand-authored default stays the number it was
// written as.
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

function sameAsDefault(key, v) {
  const step = readouts[key].step
  return onGrid(v, step) === onGrid(DEFAULTS[key], step)
}

function showValue(key) {
  const { out, label, step } = readouts[key]
  const v = params[key]
  // Printed to the step's OWN precision, not a fixed two places: `trunkRadius`
  // steps by 0.001, and two places cannot tell 0.026 from 0.025.
  //
  // The tier's readout is its NAME, not its index: "3" on a four-rung ladder is
  // the one value on this panel that does not mean a quantity.
  out.textContent = key === 'lod' ? TIER_NAMES[Math.round(v)] : Number(v).toFixed(decimals(step))
  // The changed mark is folded in HERE rather than into the input handler,
  // because the handler is not the only way a value moves: `defaults` and every
  // future path go through syncSliders, and syncSliders goes through this. One
  // choke point is the only arrangement in which no path can leave a label
  // lying about its row.
  label.classList.toggle('changed', !sameAsDefault(key, v))
}

for (const [key, min, max, step, help] of SLIDERS) {
  if (key === '#') {
    const h = document.createElement('h2')
    h.textContent = min
    slidersEl.appendChild(h)
    continue
  }
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
    showValue(key)
    refresh()
  })
  showValue(key)
  slidersEl.appendChild(row)
}

function syncSliders() {
  for (const key of Object.keys(readouts)) {
    readouts[key].input.value = params[key]
    showValue(key)
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

// `rebuilds` because most of these change the mesh and one does not: spinning
// the camera would otherwise regrow twenty trees and re-bake the card to move a
// boolean the render loop reads every frame anyway.
function toggle(id, get, set, rebuilds = true) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    if (rebuilds) refresh()
  })
}

// The two grid views are mutually exclusive -- clicking one turns the other off
// -- so they are wired together rather than as two independent toggles.
function viewButton(id) {
  const btn = document.getElementById(id)
  btn.addEventListener('click', () => {
    view = view === id ? 'single' : id
    for (const other of ['gallery', 'sizes']) {
      document.getElementById(other).classList.toggle('on', view === other)
    }
    refresh()
    frameCamera()
  })
}
viewButton('gallery')
viewButton('sizes')

toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v }, false)

document.getElementById('reset').addEventListener('click', () => {
  const seed = params.seed
  Object.assign(params, DEFAULTS, { seed })
  syncSliders()
  refresh()
  frameCamera() // after, so it frames the tree that was just built
})

// --- copying the shape out --------------------------------------------------
//
// The bench is where a shape gets DECIDED and tree-v6.js is where it has to end
// up, and without this there is no crossing between them: you tune something
// worth keeping and then read thirty numbers off the panel by eye to type them
// back in, which nobody does twice.
//
// JSON rather than a source block, because a v6 shape has no bank to paste
// into yet -- there is one parameter table, and what this hands back is a whole
// one, ready to be a preset the day there is somewhere to put presets.
//
// `lod` is left out because it is the TIER, which is a fact about what you are
// looking at and not about the tree; `alphaTest` and `brightness` are left out
// on the harder argument -- they are the bench's dials, and a shape that named
// them would be pasting the previewer's exposure into the world.
function copyText() {
  const shape = {}
  for (const key of Object.keys(DEFAULTS)) {
    if (BENCH_KEYS.has(key)) continue
    const step = key in readouts ? readouts[key].step : null
    shape[key] = step === null ? params[key] : atStep(params[key], step)
  }
  return JSON.stringify(shape, null, 2)
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
  // is permission-gated even on a secure one, so BOTH failures have to reach
  // the label. A button that silently did nothing would look exactly like one
  // that worked, and the whole reason this exists is that there was no way to
  // get the numbers out. No textarea fallback: a copy that half works is a copy
  // nobody trusts.
  if (!navigator.clipboard) {
    flashCopy('no clipboard API', 4000)
    console.error('gen-tree-v6: navigator.clipboard is undefined -- this page is not on a secure origin')
    return
  }
  navigator.clipboard.writeText(copyText()).then(
    () => flashCopy('copied', 1000),
    (e) => {
      flashCopy(`clipboard blocked (${e.name})`, 4000)
      console.error('gen-tree-v6: clipboard write refused', e)
    }
  )
})

// --- run --------------------------------------------------------------------

function resize() {
  const w = Math.max(1, stage.clientWidth)
  const h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

seedInput.value = params.seed
refresh()
frameCamera()
// The procedural fills in buildTextureArray() are on screen until the PNGs
// land, which is why the trunk is bark-coloured for those frames rather than
// invisible. Deliberately unguarded: a failed layer throws and the page dies
// loudly, because a silently-stubbed texture is exactly the thing this bench
// exists to not show you.
layersReady.then(() => refresh())

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
