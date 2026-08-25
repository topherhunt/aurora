import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildTree, resolveTree, treeLod, crownProfile, TREE_DEFAULTS, TREE_SPECIES, BUSH_OVERRIDES } from './props/tree.js'
import { bakeImpostor, buildImpostorCard } from './props/impostor.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { buildTextureArray, loadImageLayers, IMAGE_LAYERS, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import treeSource from './props/tree.js?raw'

// ---------------------------------------------------------------------------
// The procedural tree previewer (gen-tree.html).
//
// Same job as gen-fern.html, one level up in complexity: find the parameter
// RANGES that produce a convincing pine, oak, birch and aspen, at every size
// from a bush to a hundred-year tree, and read the triangle cost of each while
// doing it. What gets locked afterwards is a variant bank -- roughly 8 tree
// variants and 8 bush variants per species -- and this page is where the
// numbers in it are chosen.
//
// THREE THINGS THIS PAGE DOES THAT THE FERN BENCH DOES NOT:
//
// 1. It renders the REAL material. A tree is bark and leaves in one mesh, so it
//    needs the shared sampler2DArray path (src/material.js) rather than a
//    single bound map, and using it here means the bench and the game disagree
//    about nothing. The one addition is wrap lighting, which the game's
//    lighting.patch() also chains on.
//
// 2. It reports metres, not fractions. Every shape parameter in tree.js is a
//    fraction of `height`, so the panel prints trunk diameter in centimetres
//    and first-branch height in metres instead, and the `sizes` view puts one
//    parameter set at five heights side by side. That view is also the only
//    place the height-density law is visible: `branches` and `sprays` are
//    stated at `heightRef` and scale from there, so the five trees differ in
//    how much tree there is and not only in how big it is drawn.
//
// 3. It loads the SAME texture layers the game does, through the same
//    loadImageLayers() path -- bark and leaf art cut from EZ-Tree by
//    tools/trees/gen-layers.mjs. Not painted here and not stubbed: a leaf card
//    is almost entirely its alpha silhouette, so tuning spray counts and card
//    sizes against stand-in art tells you nothing about the tree you will
//    actually get.
// ---------------------------------------------------------------------------

// --- slider spec ------------------------------------------------------------
// `['#', title]` starts a group. Ranges are chosen so both ends are things you
// would plausibly want, not so both ends are valid: branchDroop past ~2 curls a
// branch back on itself, and seeing that is how you learn where the range stops.
const SLIDERS = [
  ['#', 'size'],
  ['height', 0.3, 32, 0.1, 'metres, root to tip. Geometry is rescaled to hit this exactly -- AND it scales the branch and spray counts, so this is a growth slider, not a zoom'],
  ['heightRef', 0.5, 32, 0.1, 'the height every count below is stated at. Leave it where the species was tuned; move `height` away from it and the counts follow'],
  ['countPower', 0, 1.5, 0.05, 'how much of a height change goes into COUNTS rather than scale. 1 = constant real-world density, 0 = a pure scaled copy (which is what per-instance placement jitter wants)'],
  ['sprayPower', 0, 1, 0.05, 'the same for spray SIZE, and lower on purpose: a spruce fan is about a metre and a half whether the tree is 9 m or 20 m'],

  ['#', 'trunk'],
  ['trunkSides', 3, 12, 1, 'sides around the trunk. 3 is a wedge, 8 reads round at any range you can make a trunk out at'],
  ['trunkRings', 1, 6, 1, 'rings below the apex. The trunk always closes to a point, so 1 is a plain cone; raise it to let trunkBend curve rather than lean'],
  ['trunkRadius', 0, 0.09, 0.001, 'base radius as a FRACTION of height -- the panel prints the metres'],
  ['trunkBend', 0, 0.3, 0.005, 'sideways offset of the top, as a fraction of height'],
  ['barkRepeat', 0.5, 16, 0.5, 'bark tiles UP the trunk this many times. The tiling AROUND it is derived so a tile stays roughly square in world space'],

  ['#', 'crown'],
  ['branches', 0, 40, 1, 'branches off the trunk. Each one also carries `forks` children -- see the budget panel'],
  ['firstBranch', 0, 0.9, 0.01, 'height of the LOWEST branch, as a fraction of the tree'],
  ['branchLength', 0.05, 0.8, 0.01, 'the longest branch, as a fraction of height'],
  ['crownPeak', 0, 1, 0.01, 'where up the crown the longest branch sits. 0 = cone (pine), 0.5 = round (oak)'],
  ['crownFullness', 0.2, 3, 0.05, 'falloff from that peak. <1 fuller and blockier, >1 pointier and sparser'],
  ['branchMin', 0, 1, 0.01, 'shortest branch as a fraction of the longest, so the apex still carries foliage'],
  ['whorlSize', 0, 6, 1, '0 = scattered, every branch its own random height. 1 = spiral. >1 = conifer whorls of this size'],
  ['yawJitter', 0, 1, 0.01, 'how far each branch may wander off even spacing'],

  ['#', 'branch shape'],
  ['branchAngle', -0.8, 1.2, 0.01, 'radians above horizontal where a branch leaves the trunk, at the crown base'],
  ['branchRise', -0.5, 1.5, 0.01, 'added to that by the apex, so the top branches point up and the hem does not'],
  ['branchDroop', 0, 2.5, 0.01, 'total bend from launch to tip. High = weeping birch'],
  ['branchCurve', 0.3, 3, 0.05, 'where the bend concentrates. >1 = stiff at the trunk, floppy at the tip'],
  ['branchSway', 0, 1, 0.01, 'lateral drift, so a branch is not confined to a plane'],
  ['branchSides', 0, 8, 1, 'sides around a solid limb, costing branchSides triangles each. 1 is the LOD1 limb: one vertical fin, 1 triangle. 0 draws no limb at all, only its foliage'],
  ['branchRings', 1, 4, 1, 'rings below the tip. 1 is a straight cone; 2 lets a strongly drooping branch actually curve, at twice the triangles'],
  ['branchWidth', 0, 0.12, 0.002, 'limb base radius, as a fraction of its own length'],

  ['#', 'forks'],
  ['forks', 0, 4, 1, 'child limbs split off each branch. One level only, so limbs = branches x (1 + forks)'],
  ['forkScale', 0.15, 0.9, 0.01, 'child length as a fraction of its parent branch'],
  ['forkAngle', 0, 1.4, 0.01, 'radians the child turns off the parent tangent. 0 = a straight continuation'],
  ['forkStart', 0.05, 0.9, 0.01, 'earliest point along the parent a child may split off'],
  ['forkEnd', 0.1, 1, 0.01, 'latest. Keep it off 1: a fork at the tip is a kink, and the parent has no radius left there to match'],
  ['forkSideways', 0, 1, 0.01, 'how much of the fork\'s turn is confined to the HORIZONTAL. 1 = it only ever swings out to the side; 0 = it dives and climbs as readily'],

  ['#', 'foliage'],
  ['sprays', 0, 14, 1, 'leaf cards per LIMB on AVERAGE, including one terminal card at the tip. This is the whole density knob, and at one triangle a card it is also the whole foliage budget'],
  ['sprayByLength', 0, 1, 0.01, 'how far a limb\'s share of those cards follows its own length. 0 = every limb gets the same count, which gives a conifer a square tufted top; 1 = fully proportional. The total is normalised either way, so this costs nothing'],
  ['apexSprays', 0, 6, 1, 'cards on the TRUNK\'s own tip, which no branch reaches. At 0 every tree ends in a bare spike'],
  ['sprayMetres', 0.05, 2.5, 0.01, 'one spray\'s stem-to-tip reach in WORLD METRES. Depends on the cut: a broadleaf spray is about half a metre, the pine fan is a whole branch at 1.5'],
  ['cardTris', 1, 2, 1, '1 = a triangle with its apex at the stem, halving the cost of every card and clipping the outer corners of the art. 2 = the full quad'],
  ['sprayTaper', 0.1, 1.5, 0.01, 'spray size at the limb TIP as a fraction of its size at the base. Under 1 puts the big sprays near the trunk and fine ones at the ends'],
  ['sprayVary', 0, 0.6, 0.01, 'random +/- size variation per card, on top of the taper'],
  ['sprayStart', 0, 1, 0.01, 'earliest point along a limb a side shoot may attach'],
  ['sprayOut', 0, 1, 0.01, '0 = shoots continue the limb, 1 = they leave straight out its side'],
  ['sprayLift', 0, 1, 0.01, '0 = card lies along the shoot (needled spray), 1 = stands upright (broadleaf)'],
  ['sprayDown', 0, 1, 0.01, 'and then this much of UP taken back off, so the spray hangs outward and down off the twig. Randomised half-to-full per card'],
  ['sprayJitter', 0, 2, 0.01, 'random roll of each card about its own axis'],
  ['sprayAspect', 0.3, 2.5, 0.01, 'card width/height. Set from the art\'s alpha bounds -- move it and the leaves stretch'],
  ['leafSkyward', 0, 1, 0.01, 'how far foliage normals turn toward the sky. This is the black-underside knob: 0 shades each card by its own plane, 1 shades the whole canopy as if lit from above'],

  ['#', 'material'],
  ['alphaTest', 0.05, 0.95, 0.01, 'cutout threshold. Low = lacy and aliased, high = eats the leaf edges'],
  ['brightness', 0.4, 3, 0.05, 'multiplies the albedo. A material property, not geometry'],
]

// DESIGN.md §5's per-class mesh-tier budgets, which is what the panel checks
// against. Two numbers for trees because the class has two mesh tiers.
// DESIGN.md §5's prop ladder, per class and per mesh tier.
const CLASS_BUDGET = { tree: [500, 130, 6], bush: [84, 56, 2] }

let speciesKey = 'pine'
let bushMode = false

const params = { ...TREE_DEFAULTS, alphaTest: 0.5, brightness: 1.0 }

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
// Spin orbits the camera rather than turning the tree, so the ground turns with
// it and you are walking around a plant instead of watching one on a lazy
// susan. A rotating mesh also lies about the lighting -- the sun sweeps across
// the canopy -- which is the one thing this bench exists to judge honestly.
// Off by default. A turntable is useful for judging a silhouette and actively
// in the way when you are dragging a slider and watching one branch -- and
// judging a silhouette is the thing you do second.
controls.autoRotate = false
controls.autoRotateSpeed = (0.25 * 60) / (2 * Math.PI)

// Lighting matched to the game's noon, same as props.html and the fern bench.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------
//
// 600 m of it, because a 30 m tree in `sizes` view wants a horizon and the fog
// has to close before the plane's edge does. See preview-stage.js for why the
// texture is generated and deliberately lo-fi.
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
scene.fog = new THREE.Fog(0x0a1018, 40, 200)

let grid = null

// A 1.7 m human-height rule, not the fern bench's 1 m box: "is this tree the
// right size" is the question this page most often has to answer, and against
// a 20 m pine a one-metre stick tells you nothing. This is roughly her.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.4, 1.7, 0.25),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(-2, 0.85, 0)
scene.add(rule)

// --- material ---------------------------------------------------------------
//
// The REAL prop material, patched exactly the way the game patches it: the
// array sampler from material.js, then wrap diffuse chained on top. Chained,
// not replaced -- assigning over onBeforeCompile would drop the sampler2DArray
// patch and every prop would render untextured white.
const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
// A distinct key because this program is the array patch AND the wrap patch;
// sharing 'prop-array-v1' would let three hand us a cached program with only
// one of them compiled in.
material.customProgramCacheKey = () => 'gen-tree-array-wrap-v1'

// Every image layer, not just this species'. loadImageLayers uploads the whole
// array once (per its own note, `needsUpdate` regenerates every mip chain), so
// loading the seven tree layers together costs one upload rather than one per
// species switch -- and switching species then costs nothing at all.
//
// The procedural fills in buildTextureArray() are on screen until this
// resolves, which is why the trunk is bark-coloured for those frames instead of
// invisible. Deliberately unguarded: a failed layer throws and the page dies
// loudly, because a silently-stubbed texture is exactly the thing this bench
// exists to not show you.
let layersLoaded = false
const layersReady = loadImageLayers(atlas).then((n) => {
  layersLoaded = true
  return n
})

// One 128x128 RGBA slice out of the array, for the swatch panel.
function layerPixels(layer) {
  const stride = TEX_SIZE * TEX_SIZE * 4
  return atlas.image.data.subarray(layer * stride, (layer + 1) * stride)
}

// --- the trees --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const COLS = 5
const ROWS = 4

// One parameter set at five heights, human-height to massive. This is the view
// that shows why `height` cannot be the only thing a size ladder moves: these
// five are exact scaled copies of each other, and the biggest one looks wrong.
const SIZE_LADDER = [0.2, 0.45, 1, 1.8, 3]

let view = 'single' // 'single' | 'gallery' | 'sizes'
// Which tier to draw: 0 and 1 are meshes, 2 is the impostor. LOD1 is not a
// separate parameter set to tune -- it is `treeLod` applied to whatever the
// sliders currently say, so a change to LOD0 moves LOD1 with it and the two
// cannot drift apart.
//
// The tier is deliberately NOT a `view`: a view change reframes the camera,
// and the whole question a tier asks is "does this read as the same tree from
// where I am standing", which you cannot answer if the camera jumps when you
// press the button. Switching tiers swaps the geometry and leaves the camera
// exactly where you put it.
let lodTier = 0
let wireframe = false
let showGrid = true

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

// The widest a built tree gets, used for gallery spacing and camera framing. A
// crown is wider than it is tall for an old oak, so spacing keys off the
// measured width rather than off `height`.
let lastWidth = 1

function speciesParams() {
  return { ...TREE_DEFAULTS, ...TREE_SPECIES[speciesKey].params, ...(bushMode ? BUSH_OVERRIDES : {}) }
}

// Returns the aggregate stats, so the panel can report a whole gallery rather
// than pretending the first tree is representative.
function rebuild() {
  clearGroup()
  material.alphaTest = params.alphaTest
  material.wireframe = wireframe
  material.color.setScalar(params.brightness)
  material.needsUpdate = true

  const sp = TREE_SPECIES[speciesKey]
  // LOD2 has no parameter set of its own: it is a photograph of LOD0, so that is
  // what gets built and then baked.
  const meshTier = Math.min(lodTier, 1)
  const base = treeLod({ ...params, leafLayer: sp.leafLayer, barkLayer: sp.barkLayer }, meshTier)

  // What to build: a seed grid, a size ladder, or one tree.
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

  const agg = { tris: 0, verts: 0, bytes: 0, trunk: 0, branch: 0, spray: 0, count: jobs.length }
  // The metre readouts describe ONE tree, and in the size ladder it has to be
  // the one at the height on the slider -- otherwise dragging `height` moves
  // every number in the panel except the one it is named after.
  let measured = null
  let measuredErr = Infinity
  let width = 0

  const geos = jobs.map((job) => {
    const geo = buildTree({ ...base, seed: job.seed, height: job.height })
    const u = geo.userData.tree
    agg.tris += u.triangles
    agg.verts += u.vertices
    agg.trunk += u.trunkTris
    agg.branch += u.branchTris
    agg.spray += u.sprayTris
    agg.bytes += geometryBytes(geo)
    const err = Math.abs(job.height - params.height)
    if (err < measuredErr) {
      measuredErr = err
      measured = u
    }
    width = Math.max(width, u.crownWidth)
    return geo
  })

  lastWidth = Math.max(0.2, width)
  const spacing = lastWidth * 1.25

  // At LOD2 the trees were built only to be photographed. ONE bake feeds every
  // card on screen, which is not a shortcut but the shipping arrangement: there
  // is one impostor layer per species, so a seed gallery at this tier really
  // does show fifteen instances of one picture, and the size ladder really does
  // show one picture scaled. Seeing that is the point of looking.
  let drawn = geos
  if (lodTier === 2) {
    const src = geos[0]
    const u0 = src.userData.tree
    const layer = TREE_SPECIES[speciesKey].impostorLayer
    const card = bakeImpostor(renderer, src, atlas, layer, { width: u0.crownWidth, height: u0.height })
    agg.tris = 0
    agg.verts = 0
    agg.bytes = 0
    agg.trunk = 0
    agg.branch = 0
    agg.spray = 0
    drawn = geos.map((geo) => {
      const k = geo.userData.tree.height / u0.height
      const hex = buildImpostorCard(card.width * k, card.height * k, layer)
      agg.tris += hex.userData.impostor.triangles
      agg.verts += hex.getAttribute('position').count
      agg.bytes += geometryBytes(hex)
      return hex
    })
    agg.card = drawn[0].userData.impostor.triangles
    // clearGroup only disposes what is IN the group, and these never go in.
    for (const geo of geos) geo.dispose()
  }

  drawn.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, material)
    if (view !== 'single') {
      mesh.position.set(
        ((i % COLS) - (COLS - 1) / 2) * spacing,
        0,
        (Math.floor(i / COLS) - (ROWS - 1) / 2) * spacing
      )
    }
    group.add(mesh)
  })

  // The rule stands beside the single tree, and beside the leftmost column of a
  // ladder where it is doing the most work.
  rule.visible = showGrid
  rule.position.x = view === 'gallery' || view === 'sizes' ? -(COLS / 2 + 0.35) * spacing : -Math.max(1.2, lastWidth * 0.75)

  // Fog and grid scale with the subject: a 1 m bush and a 30 m pine want very
  // different horizons, and a fixed one either hides the tree or does nothing.
  const reach = view === 'gallery' || view === 'sizes' ? Math.max(params.height, spacing * COLS) : params.height
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
    const cells = Math.min(gridSpan, 120)
    grid = new THREE.GridHelper(gridSpan, cells, 0x2b4a72, 0x16233a)
    grid.position.y = 0.01
    grid.userData.span = gridSpan
    scene.add(grid)
  }
  grid.visible = showGrid

  return { ...agg, measured }
}

// --- camera framing ---------------------------------------------------------

function frame() {
  const spacing = lastWidth * 1.25
  const half =
    view === 'single'
      ? Math.max(params.height, lastWidth) * 0.6
      : Math.hypot((COLS * spacing) / 2, (ROWS * spacing) / 2)
  const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.5
  controls.target.set(0, view === 'gallery' || view === 'sizes' ? params.height * 0.3 : params.height * 0.45, 0)
  camera.position.set(0, dist * 0.45, dist * 0.9)
}

// --- panel ------------------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

async function gzipped(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

let diskBytes = null

// What a tree actually costs to ship, which is now two things rather than one.
//
// The PNGs are fetched and weighed rather than hardcoded, because the numbers
// move every time gen-layers.mjs re-cuts them and a stale constant on a budget
// panel is worse than no panel. They are already in the browser cache by the
// time this runs -- loadImageLayers fetched them at startup -- so this is a
// cache read, not seven more requests.
//
// PNGs are NOT counted toward the gzip figure: they are already deflate-
// compressed inside the container, and a server gzipping them again would add
// bytes, not remove them.
async function measureDisk() {
  const src = new TextEncoder().encode(treeSource)
  const urls = [...new Set(Object.values(IMAGE_LAYERS))].filter((u) => u.startsWith('trees/'))
  const sizes = await Promise.all(
    urls.map(async (u) => {
      const res = await fetch(u)
      if (!res.ok) throw new Error(`${u}: HTTP ${res.status}`)
      return (await res.blob()).size
    })
  )
  diskBytes = {
    src: src.byteLength,
    srcGz: await gzipped(src),
    tex: sizes.reduce((a, b) => a + b, 0),
    texCount: urls.length,
  }
}

function refresh() {
  const s = rebuild()
  const per = Math.round(s.tris / s.count)
  const budget = (bushMode ? CLASS_BUDGET.bush : CLASS_BUDGET.tree)[lodTier]
  // What the tier actually builds, which at LOD1 is not what the sliders say.
  const shown = treeLod(params, Math.min(lodTier, 1))

  // Every solid here is a CONE -- rings of quads closed by a fan of single
  // triangles at the apex -- so it costs sides x ((rings - 1) x 2 + 1) rather
  // than the sides x rings x 2 a capped tube would. One ring plus a point is
  // exactly `sides` triangles, and that is the default for both trunk and limb.
  const cone = (n, r) => (n >= 3 ? `${n}&times;((${r}-1)&times;2+1)` : '&mdash;')
  const sides = Math.round(shown.trunkSides)
  const rings = Math.round(shown.trunkRings)
  const bs = Math.round(shown.branchSides)
  const br = Math.round(shown.branchRings)
  // A limb at one side is the vertical fin, not a cone -- see addFin in tree.js.
  const limb = (n, r) => (n === 1 ? '1 fin' : cone(n, r))
  // Counts come from resolveTree, not from the sliders: `branches` and `sprays`
  // are stated at `heightRef` and scale with `height`, so at any other height
  // the slider value is not what gets built. resolveTree is the same function
  // buildTree grows from, which is what makes this panel a prediction rather
  // than a second implementation that can disagree.
  const res = resolveTree(shown)
  const { branches: nb, sprays: ns, forks: nf, limbs: nl, cardTris: ct, apexSprays: na } = res

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} total)` : ''}`],
    [`&nbsp;&nbsp;trunk ${cone(sides, rings)}`, Math.round(s.trunk / s.count)],
    [`&nbsp;&nbsp;limbs ${nb}&times;(1+${nf})`, nl],
    [`&nbsp;&nbsp;branches ${nl}&times;${limb(bs, br)}`, Math.round(s.branch / s.count)],
    [`&nbsp;&nbsp;sprays (${nl}&times;${ns}+${na})&times;${ct}`, Math.round(s.spray / s.count)],
    [
      '&nbsp;&nbsp;height &times;' + res.heightScale.toFixed(2),
      res.heightScale === 1 ? 'at heightRef' : `${nb} br, ${ns} sprays/limb`,
    ],
    ...(s.card
      ? [['&nbsp;&nbsp;impostor 3 planes&times;2', `${s.card} &mdash; one layer, one bake`]]
      : []),
    ['vertices', Math.round(s.verts / s.count)],
    ['drawn here', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    [
      `${bushMode ? 'bush' : 'tree'}-class LOD${lodTier}`,
      `${per} / ${budget} tris`,
      per <= budget ? 'ok' : 'warn',
    ],
  ])

  // The numbers that say whether a SIZE is believable, in metres. Every shape
  // parameter above is a fraction of height, so these are the only readouts
  // that change meaning when you drag `height`.
  const f = s.measured
  const cardAt = f.crownWidth * 28.6 // DESIGN.md §5: the 2-degree parallax rule
  table(document.getElementById('measure'), [
    ['height', `${f.height.toFixed(2)} m`],
    ['crown width', `${f.crownWidth.toFixed(2)} m`],
    ['trunk at the base', `${(f.trunkDiameter * 100).toFixed(0)} cm`],
    ['first branch at', `${f.firstBranchHeight.toFixed(2)} m`],
    // What a leaf card actually came out as, not what was asked for: the final
    // rescale divides by a bounding box that stands a little above the trunk
    // tip, so this runs a few percent under `sprayMetres`. What counts as too
    // big depends on the cut: a broadleaf card is one spray of leaves and half
    // a metre is already generous, while spray_pine is a whole needled fan and
    // a metre and a half of it is one spruce branch. Past ~1.6 m no cut we have
    // is that big and the card is a billboard pretending to be foliage.
    [
      'leaf spray',
      `${(f.sprayMetres * 100).toFixed(0)} cm`,
      f.sprayMetres > 1.6 ? 'warn' : 'ok',
    ],
    // Whole-tree triangles per spray, wood included. It falls as `sprays` rises
    // -- the trunk and the limbs are a fixed cost that more foliage amortises --
    // and it is the honest way to compare two canopies of different density.
    [
      'sprays on it',
      `${f.sprays} @ ${(f.triangles / Math.max(1, f.sprays)).toFixed(1)} tris each`,
    ],
    ['crown / height', (f.crownWidth / f.height).toFixed(2)],
    [
      'foliage below ground',
      f.belowGround > 0.005 ? `${(f.belowGround * 100).toFixed(0)} cm` : 'none',
      f.belowGround > f.height * 0.1 ? 'warn' : 'ok',
    ],
    ['card allowed past', `${Math.round(cardAt)} m`],
  ])

  drawProfile()
  drawSwatch()

  if (!diskBytes) return
  const total = diskBytes.srcGz + diskBytes.tex
  table(document.getElementById('disk'), [
    ['tree.js', fmt(diskBytes.src)],
    ['&nbsp;&nbsp;gzipped', fmt(diskBytes.srcGz), 'ok'],
    [`${diskBytes.texCount} PNG layers`, fmt(diskBytes.tex)],
    ['&nbsp;&nbsp;in the array', fmt(diskBytes.texCount * TEX_SIZE * TEX_SIZE * 4)],
    ['all four species', fmt(total), 'ok'],
  ])
  document.getElementById('disknote').innerHTML =
    `No mesh file: the shape is <em>code</em>, so every tree in the world -- every species, every ` +
    `size, every seed -- shares one ${fmt(diskBytes.srcGz)} download. What does cost bytes is the ` +
    `art, and ${fmt(diskBytes.tex)} buys all of it. Adding a variant is free; adding a species costs ` +
    `a preset plus, at most, one 128&times;128 leaf layer.`
}

// --- crown profile plot -----------------------------------------------------
//
// The macro-shape control, drawn. This is the single most useful thing on the
// page: crownPeak and crownFullness are hard to hold in your head and trivial
// to recognise as a silhouette.
function drawProfile() {
  const canvas = document.getElementById('profile')
  const ctx = canvas.getContext('2d')
  const W = canvas.width
  const H = canvas.height
  ctx.clearRect(0, 0, W, H)

  const firstY = params.firstBranch
  const toY = (h) => H - 6 - (H - 12) * h // h in 0..1 of tree height

  // Trunk line, and the height the crown starts at.
  ctx.strokeStyle = '#2b4a72'
  ctx.beginPath()
  ctx.moveTo(W / 2, toY(0))
  ctx.lineTo(W / 2, toY(1))
  ctx.stroke()

  ctx.strokeStyle = '#1b2c44'
  ctx.beginPath()
  ctx.moveTo(0, toY(firstY))
  ctx.lineTo(W, toY(firstY))
  ctx.stroke()

  // The silhouette itself: half-width at each height, mirrored.
  const scale = (W / 2 - 8) * Math.min(1, (params.branchLength * 2.2) / 0.8)
  // Sampled over the t values the BRANCHES actually take -- (i+0.5)/n, never 0
  // and never 1 -- rather than over the full [0,1]. crownProfile is zero at both
  // ends by construction and drawing those would put a pinch on the silhouette
  // that no branch is ever built at.
  const n = Math.max(1, Math.round(params.branches))
  const halfW = (t) => {
    const prof = crownProfile(t, params.crownPeak, params.crownFullness)
    return (params.branchMin + (1 - params.branchMin) * prof) * scale
  }
  ctx.strokeStyle = '#6fbf73'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  const ts = []
  for (let i = 0; i <= 60; i++) ts.push(0.5 / n + (i / 60) * (1 - 1 / n))
  ts.forEach((t, i) => {
    const y = toY(firstY + t * (1 - firstY))
    if (i === 0) ctx.moveTo(W / 2 + halfW(t), y)
    else ctx.lineTo(W / 2 + halfW(t), y)
  })
  for (let i = ts.length - 1; i >= 0; i--) {
    ctx.lineTo(W / 2 - halfW(ts[i]), toY(firstY + ts[i] * (1 - firstY)))
  }
  ctx.closePath()
  ctx.stroke()
  ctx.lineWidth = 1

  // A tick per branch on the trunk, so `branches` and `whorlSize` are legible
  // here too: a conifer's whorls collapse into a handful of stacked ticks.
  // At whorlSize 0 the real heights are stratified-random -- one branch somewhere
  // inside each 1/n band -- so the tick is drawn at the CENTRE of its band. That
  // is the honest summary of where it may land; the exact draw is per-seed and
  // this canvas has no seed.
  ctx.fillStyle = '#4a7fbf'
  const whorl = Math.max(0, Math.round(params.whorlSize))
  const whorls = Math.max(1, Math.ceil(n / Math.max(1, whorl)))
  for (let i = 0; i < n; i++) {
    const t = whorl > 1 ? (Math.floor(i / whorl) + 0.5) / whorls : (i + 0.5) / n
    ctx.fillRect(W / 2 - 3, toY(firstY + t * (1 - firstY)), 6, 1)
  }
}

// --- texture swatch ---------------------------------------------------------
//
// Three panes: the leaf layer's colour, the same layer's ALPHA on its own, and
// the bark layer. The alpha gets its own pane because it is the load-bearing
// half -- a leaf card is a rectangle, and every bit of its shape is in that
// channel. Reading it beside the colour is how you tell "the canopy is too
// sparse" from "the art has too much air in it".

function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const sp = TREE_SPECIES[speciesKey]
  const leaf = layerPixels(sp.leafLayer)
  const bark = layerPixels(sp.barkLayer)

  const rgb = new ImageData(TEX_SIZE, TEX_SIZE)
  const alpha = new ImageData(TEX_SIZE, TEX_SIZE)
  const trunk = new ImageData(TEX_SIZE, TEX_SIZE)
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const o = i * 4
    // Row 0 of a layer is v = 0, and a canvas draws row 0 at the TOP, so flip
    // here or every spray hangs by its tip.
    const row = TEX_SIZE - 1 - Math.floor(i / TEX_SIZE)
    const d = (row * TEX_SIZE + (i % TEX_SIZE)) * 4
    for (let c = 0; c < 3; c++) {
      rgb.data[d + c] = leaf[o + c]
      trunk.data[d + c] = bark[o + c]
    }
    rgb.data[d + 3] = 255
    trunk.data[d + 3] = 255
    const a = leaf[o + 3]
    alpha.data[d] = alpha.data[d + 1] = alpha.data[d + 2] = a
    alpha.data[d + 3] = 255
  }

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')
  const w = canvas.width / 3
  ;[rgb, alpha, trunk].forEach((img, i) => {
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, canvas.height)
  })

  // Say so rather than showing the placeholder and letting it pass for the art.
  if (!layersLoaded) {
    ctx.fillStyle = 'rgba(8,14,26,.75)'
    ctx.fillRect(0, canvas.height / 2 - 9, canvas.width, 18)
    ctx.fillStyle = '#c9a227'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('placeholder -- PNG layers still loading', canvas.width / 2, canvas.height / 2 + 4)
  }
}

// --- controls ---------------------------------------------------------------

const slidersEl = document.getElementById('sliders')
const readouts = {}

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
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  const out = row.querySelector('.v')
  readouts[key] = { input, out, step }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    out.textContent = step >= 1 ? params[key] : Number(params[key]).toFixed(2)
    refresh()
  })
  out.textContent = step >= 1 ? params[key] : Number(params[key]).toFixed(2)
  slidersEl.appendChild(row)
}

function syncSliders() {
  for (const [key] of SLIDERS) {
    if (key === '#') continue
    const r = readouts[key]
    r.input.value = params[key]
    r.out.textContent = r.step >= 1 ? params[key] : Number(params[key]).toFixed(2)
  }
}

// Loading a species replaces the whole parameter set, not just the shape ones:
// a preset that only moved crownPeak would inherit whatever branchDroop the
// last species left behind, and you would be tuning a chimera.
function loadSpecies() {
  const seed = params.seed
  Object.assign(params, speciesParams(), { seed })
  syncSliders()
  refresh()
  frame() // after, so it frames the tree that was just built
}

const speciesEl = document.getElementById('species')
speciesEl.innerHTML = Object.entries(TREE_SPECIES)
  .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
  .join('')
speciesEl.value = speciesKey
speciesEl.addEventListener('change', () => {
  speciesKey = speciesEl.value
  loadSpecies()
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

// A plain on/off button.
function toggle(id, get, set) {
  const btn = document.getElementById(id)
  btn.classList.toggle('on', get())
  btn.addEventListener('click', () => {
    set(!get())
    btn.classList.toggle('on', get())
    refresh()
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
    frame()
  })
}
viewButton('gallery')
viewButton('sizes')

// The three tiers are one radio group: pressing the tier you are on returns you
// to LOD0, which makes A/B against the real tree a single key away. No frame()
// here -- see the note by `lodTier`.
function tierButton(id, tier) {
  document.getElementById(id).addEventListener('click', () => {
    lodTier = lodTier === tier ? 0 : tier
    for (const [other, t] of [['lod1', 1], ['lod2', 2]]) {
      document.getElementById(other).classList.toggle('on', lodTier === t)
    }
    refresh()
  })
}
tierButton('lod1', 1)
tierButton('lod2', 2)

toggle('bush', () => bushMode, (v) => {
  bushMode = v
  loadSpecies()
})
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

loadSpecies()
// Not top-level await: the build target is es2020. refresh() tolerates both the
// disk numbers and the PNG layers being absent, so the tree renders on the
// first frame and sharpens up rather than waiting on the network.
//
// measureDisk runs AFTER the layers land so its fetches are cache hits on the
// requests loadImageLayers already made, rather than seven more off the wire.
layersReady.then(() => refresh()).then(measureDisk).then(refresh)

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
