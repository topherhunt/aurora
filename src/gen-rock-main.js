import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildRock, ROCK_DEFAULTS, ROCK_TIERS, ROCK_LOD_AT, rockLodSize } from './props/rock.js'
import {
  ROCK_VARIANTS, TINTS, TINT_GAIN, rockParams, rockImpostorLayer,
  rockShapeSeed, parseRockShapeId,
} from './props/rock-bank.js'
import { SEED as WORLD_SEED } from './v2/config.js'
import { geometryBytes } from './props/fern.js' // generic; it lives there for historical reasons
import { bakeImpostor, buildImpostorCard } from './props/impostor.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE } from './textures.js'
import { createPropMaterial, setSnow, setMoss } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import rockSource from './props/rock.js?raw'
import impostorSource from './props/impostor.js?raw'

// ---------------------------------------------------------------------------
// The procedural rock previewer (gen-rock.html, served at /gen-rock).
//
// This bench exists to ANSWER A QUESTION, not to show off a generator: which
// rock variants is the world actually going to ship? The question has been
// answered -- the twenty-five in src/props/rock-bank.js -- and the PRESET dropdown
// is that bank, so picking an entry previews exactly the rock the scatter will
// place. The sliders are still here because the answer is not final: drag them,
// find a better shape, and write the numbers back into the bank.
//
// Three views do most of the work, and none of them is the default single rock:
//
//   GALLERY -- twenty seeds of one preset. A generator is only as good as its
//   range, and one rock proves nothing about a parameter set.
//
//   LADDER -- the same rock at all three mesh tiers, side by side, at true
//   size. This is the view that settles "do we need a real LOD2", because the
//   T20 sitting next to the T80 either still reads as that rock or does not.
//
//   TINTS -- one rock per environment colour. Every rock in the world wears one
//   128px granite tile, so this is the whole of the variety argument.
//
// WHY THE REAL PROP MATERIAL, and not a bench stand-in with `map` bound: the
// tint is the entire texture story here, and it happens in the shipping path --
// BatchedMesh.setColorAt -> USE_BATCHING_COLOR -> USE_COLOR -> diffuseColor *=
// vColor. A bench that could not tint would be showing you a different asset
// than the one that ships. Loose Meshes cannot call setColorAt, so the tint is
// applied here through a per-tint material clone; the clones share one compiled
// program (same customProgramCacheKey), so what you see is what one draw call
// with six instance colours looks like.
// ---------------------------------------------------------------------------

const STONE_TEX = 'rocks/stone.png'

// --- the shipping bank ------------------------------------------------------
//
// ROCK_VARIANTS and TINTS come from src/props/rock-bank.js, because THE WORLD
// READS THEM TOO. A preset table only this page could see would let the shape
// signed off here and the shape that ships drift apart, which is the one
// failure a bench exists to prevent. Edit the twenty-five over there; this page
// previews them and nothing else.
//
// `tint` is a default, not a property of the shape -- any of these can wear any
// colour, which is exactly why the shape list can stay this short. `size` is
// not really part of the shape either: now that the tile scales with the rock,
// an entry is the same picture at any scale, so the size a variant carries is
// the one it is MEANT for. It no longer picks a ladder -- there is one ladder
// and every rock is on it -- but the size a rock ends up at is what sets the
// DISTANCES on that ladder, so it still decides how much mesh the world spends
// on the variant. See ROCK_LOD_AT.

// --- slider spec ------------------------------------------------------------
// Ranges reach past what is useful on purpose: `cutDepth` at 1 shaves a rock
// down to a crystal, and seeing that is how you learn where the useful end is.
const SLIDERS = [
  ['size', 0.06, 14, 0.02, 'largest HORIZONTAL extent in metres, measured on the dense reference. The shape is built in relative units and rescaled, and the texture scales with it, so a shape found at 2 m is the same rock at 14 m'],
  ['squash', 0.15, 2.6, 0.01, 'height / width. Under 0.4 is a slab, over 1.5 is a standing stone'],
  ['elongate', 1, 2.6, 0.01, 'x extent against z extent. 1 is round in plan'],
  ['tier', 0, 2, 1, 'which mesh tier is drawn: 0 = T180, 1 = T80, 2 = T20. All three are the SAME rock at different resolutions, and beyond T20 the world draws the billboard'],
  ['lumps', 0, 0.9, 0.01, 'large-scale radial displacement -- the mass of the rock. Ceiling raised past the default because the default WAS the ceiling, which is never evidence that the ceiling is right'],
  ['lumpFreq', 0.6, 4, 0.05, 'how many lumps around the rock'],
  ['grain', 0, 0.5, 0.005, 'small-scale bumps that catch light along an edge. The 128px tile does the finer work'],
  ['grainFreq', 2, 12, 0.1, 'scale of those bumps'],
  ['smooth', 0, 1, 0.01, '0 = every face flat-shaded, 1 = one smooth shell. Genuine CUT faces stay flat at any setting'],
  ['cuts', 0, 16, 1, 'fracture planes. This is what separates stone from a potato, and with smooth at 1 it is the ONLY thing doing it -- cut faces stay flat at any smoothing'],
  ['cutDepth', 0, 1, 0.01, 'how far in the planes bite. 0 = tangent, no cut at all'],
  ['cutBias', -1, 1, 0.05, '-1 = bedding: horizontal faces, stacked-slab look. +1 = columnar: vertical faces, sheer sides'],
  ['taper', -0.94, 0.94, 0.01, '>0 narrows the top (a spire). <0 narrows the base (a glacial erratic, or a mushroom). HORIZONTAL ONLY -- the vertical axis is untouched, so the crown stays the highest point however hard you pull this and the rock sharpens to a tooth instead of folding into a dome'],
  ['taperPow', 0.4, 3.5, 0.05, 'how the taper is distributed up the height. 1 = a straight cone. Above 2 the rock keeps its shoulders most of the way up and then bites in fast, which is what makes a spire read as a TOOTH rather than a traffic cone'],
  ['foot', 0, 1.4, 0.02, 'a batter flared onto the bottom, quadratic in the distance below the crown. This is what stops a heavily tapered rock looking balanced on a point. Reaches well above the bed plane on purpose -- `sit` flattens the very bottom away, so a flare that only peaked down there would look like a broken dial'],
  ['strata', 0, 8, 1, 'bedding bands up the height, as a count. 0 = none'],
  ['strataAmp', 0, 0.2, 0.005, 'how proud those bands stand'],
  ['sit', 0, 0.6, 0.01, 'fraction of the height cut away at the bottom, so the rock is BEDDED IN rather than resting on a point'],
  ['openBottom', 0, 1, 1, '0/1. `sit` flattens the buried belly ONTO the bed plane, which leaves a real horizontal disc down there; this throws those faces away and ships an open shell. A cap protruding from a riverbed for a fraction of a closed rock\'s triangles -- and, the moment the ground moves out from under it, a view of its inside through backfaces. Only ever on something bedded'],
  ['shards', 1, 5, 1, 'masses in the cluster. Costs its multiple in triangles -- the most expensive slider on this page'],
  ['shardSpread', 0.1, 1.1, 0.01, 'how far satellites sit from the main mass. Past ~0.9 they stop overlapping and read as separate rocks'],
  ['shardDrop', 0, 0.8, 0.01, 'how much smaller satellites get'],
  ['shardTilt', 0, 1.1, 0.01, 'how far they lean outward (radians)'],
  ['shardSink', 0, 1.2, 0.02, 'how far the small ones drop, as a fraction of the size they lost'],
  ['texRepeat', 0.5, 8, 0.1, 'how many times the tile covers the rock\'s widest plan axis. Relative to the ROCK, not to the world, so a shape is the same picture at 0.2 m and at 14 m'],
  ['texJitter', 0, 1, 0.05, 'how far that repeat count is rolled per seed. This is what stops a bed of same-size cobbles looking stamped'],
  ['brightness', 0.3, 2, 0.05, 'multiplies the tint. A material setting, not geometry'],
  ['snow', 0, 1, 0.01, 'snow, in patches, filling in from the top down. The same global uniform the tree bench drives, leaning twice as hard on which way the surface faces: the top whitens first, a sheer side is about half covered by the time the top is solid, an underside goes last, and a full winter reaches everything. The patches are world-space noise, so they wander across the cut facets instead of tracing their edges. Costs no triangles and nothing at all at 0'],
  ['moss', 0, 1, 0.01, 'moss, creeping up from the shaded flanks. Unlike snow this is a real second texture (LAYER.MOSS) laid over the stone, because moss is nothing but grain -- and it deliberately does NOT take the tint, so a basalt rock and a sandstone rock grow the same green. Sits under the snow: snow falls on moss, not the other way round'],
  ['planes', 1, 3, 1, 'CARD ONLY: quads crossed about the axis. On an opaque lump their intersection is visible as an X, which is the case against a rock card'],
]

// `brightness`, `snow`, `moss` and `planes` are bench/material settings and
// deliberately sit outside ROCK_DEFAULTS -- snow and moss are weather and
// growth, the other two are the previewer. The tree bench keeps `snow` outside
// TREE_DEFAULTS for the same reason.
//
// The page OPENS ON ROCK_DEFAULTS, not on a preset. Every preset names lumps,
// grain, smooth, cuts and tier, so opening on one would silently overwrite all
// five of the values ROCK_DEFAULTS was tuned to -- the defaults would be a
// setting nobody ever saw. `custom` is the honest label for that state.
const BENCH_KEYS = new Set(['brightness', 'snow', 'moss', 'planes'])
const params = { ...ROCK_DEFAULTS, brightness: 1, snow: 0, moss: 0, planes: 2 }
let tintIndex = 0
let presetName = ''

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

// far plane at 600 m, because `size` reaches 14 and the gallery of a 14 m crag
// is 80 m across before the camera has to back off from it.
const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 600)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// Spin orbits the camera, not the rock: a rotating mesh sweeps the sun across
// the facets, and whether the facets catch light is the thing this page is for.
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / (2 * Math.PI)

// Matched to the game's noon, so a rock is judged under the light it will stand in.
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------
//
// Generated, not loaded, so it costs nothing in the "what ships" panel; see
// preview-stage.js for why it is deliberately lo-fi and nearest-filtered. Sized
// and fogged from `size` in frame(), because this page spans 6 cm to 14 m and
// no single ground plane serves both ends.

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

// A one-metre rule. "Is this rock the right size" is the question this page most
// often has to answer, and at these scales nothing else in shot answers it.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.02, 1, 0.02),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(0, 0.5, 0)
scene.add(rule)

// --- material ---------------------------------------------------------------
//
// The REAL prop material, patched exactly the way the game patches it: the array
// sampler from material.js, then wrap (half-Lambert) diffuse chained on top.
// Chained, not replaced -- assigning over onBeforeCompile would drop the
// sampler2DArray patch and every rock would render untextured white.
const atlas = buildTextureArray()

function makeMaterial() {
  const m = createPropMaterial(atlas)
  const arrayPatch = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => {
    arrayPatch(shader, r)
    wrapLambert(shader)
  }
  // A distinct key because this program is the array patch AND the wrap patch.
  // Shared across the clones on purpose: six tints are six sets of uniforms over
  // ONE compiled program, which is what one BatchedMesh draw call would be.
  m.customProgramCacheKey = () => 'gen-rock-array-wrap-v1'
  return m
}

const materials = TINTS.map(() => makeMaterial())

function syncMaterials() {
  // One uniform for the whole page, shared by reference into all six programs.
  // The snow LINE stays at its no-op default here, so every rock on the bench
  // reads a load of exactly the slider -- in the game the line is what makes two
  // boulders a hundred metres apart in elevation wear different amounts.
  setSnow(params.snow)
  setMoss(params.moss)
  // TINT_GAIN, not the hex. A tint is a DESTINATION now (see rock-bank.js) and
  // the gain that reaches it is a linear-space multiplier that mostly runs ABOVE
  // 1.0, because stone.png is a dark warm photograph rather than the pale
  // near-neutral tile the old palette was cut against. setRGB with no colour
  // space argument writes into the working space, which is linear, which is
  // where the shader's multiply happens.
  TINT_GAIN.forEach((gain, i) => {
    const m = materials[i]
    m.color.setRGB(gain[0], gain[1], gain[2]).multiplyScalar(params.brightness)
    m.wireframe = wireframe
    m.needsUpdate = true
  })
}

// LAYER.ROCK has a procedural stand-in in buildTextureArray() -- a mottled grey
// deliberately matched to the PNG's mean -- so unlike the fern bench a rock is
// never invisible while this resolves. It IS the wrong stone, though, and the
// swatch caption says which one you are looking at rather than letting the
// placeholder pass for the photograph.
let layersLoaded = false
const layersReady = loadImageLayers(atlas).then((n) => {
  layersLoaded = true
  return n
})

function layerPixels(layer) {
  const stride = TEX_SIZE * TEX_SIZE * 4
  return atlas.image.data.subarray(layer * stride, (layer + 1) * stride)
}

// --- the rocks --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const GALLERY_COLS = 5
const GALLERY_ROWS = 4
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

// gallery / ladder / tints are mutually exclusive -- each lays the group out a
// different way -- so they are one mode rather than three toggles that fight.
let mode = 'one'
let wireframe = false
let showGrid = true
// Draw the impostor instead of the mesh. Deliberately not a camera move: the
// question a card asks is "does this still read as a rock from where I am
// standing", which you cannot answer if the view jumps when you press it.
let cardMode = false

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

function rockOptions(over = {}) {
  return { ...params, ...over }
}

// Returns aggregate stats, so the panel can report what is actually on screen
// rather than pretending the first rock is representative.
function rebuild() {
  clearGroup()
  syncMaterials()

  // What to build, where to put it, and which tint it wears. One list keeps the
  // four modes from each needing their own copy of the build-and-place loop.
  const spacing = params.size * 1.7
  let items
  if (mode === 'gallery') {
    items = Array.from({ length: GALLERY_N }, (_, i) => ({
      opts: rockOptions({ seed: Number(params.seed) + i }),
      x: ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * spacing,
      z: (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * spacing,
      tint: tintIndex,
    }))
  } else if (mode === 'ladder') {
    items = ROCK_TIERS.map((_, i) => ({
      opts: rockOptions({ tier: i }),
      x: (i - (ROCK_TIERS.length - 1) / 2) * spacing,
      z: 0,
      tint: tintIndex,
    }))
  } else if (mode === 'tints') {
    items = TINTS.map((_, i) => ({
      opts: rockOptions({ seed: Number(params.seed) + i }),
      x: (i - (TINTS.length - 1) / 2) * spacing,
      z: 0,
      tint: i,
    }))
  } else {
    items = [{ opts: rockOptions(), x: 0, z: 0, tint: tintIndex }]
  }

  const geos = items.map((it) => buildRock(it.opts))
  const measured = geos[0].userData.rock.measured

  let tris = 0
  let verts = 0
  let bytes = 0
  let card = null

  let drawn = geos
  if (cardMode) {
    // ONE bake feeds every card on screen, and here that IS a shortcut -- the
    // world photographs each of the twenty-five variants into its own slice of
    // the IMPOSTOR_ROCK run (see THE CARD in rock-bank.js). The gallery is
    // twenty seeds of ONE preset, so one bake is the right thing for this page:
    // what you are looking at is the one slice the world would give this
    // variant, worn by twenty different seeds of it -- which is exactly the
    // question the card button is here to answer.
    //
    // Into that variant's real slice when a preset is selected, so the bench
    // and the world are looking at the same texel budget. Sliders dragged off a
    // preset clear `presetName`, and then there is no variant to own a slice:
    // the run's base doubles as the scratch slot, as it did when it was the
    // only rock impostor layer there was.
    const bakeLayer = presetName ? rockImpostorLayer(presetName) : LAYER.IMPOSTOR_ROCK
    const ext = bakeImpostor(renderer, geos[0], atlas, bakeLayer, {
      width: Math.max(measured.width, measured.depth),
      height: measured.height,
    })
    drawn = geos.map((geo) => {
      const quad = buildImpostorCard(ext.width, ext.height, bakeLayer, params.planes)
      tris += quad.userData.impostor.triangles
      verts += quad.getAttribute('position').count
      bytes += geometryBytes(quad)
      return quad
    })
    card = { ...drawn[0].userData.impostor, ...ext }
    for (const geo of geos) geo.dispose() // clearGroup only disposes what is IN the group
  } else {
    for (const geo of geos) {
      tris += geo.userData.rock.triangles
      verts += geo.userData.rock.vertices
      bytes += geometryBytes(geo)
    }
  }

  drawn.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, materials[items[i].tint])
    mesh.position.set(items[i].x, 0, items[i].z)
    group.add(mesh)
  })

  const single = mode === 'one'
  grid.visible = showGrid && single
  rule.visible = showGrid && single

  return { tris, verts, bytes, count: items.length, card, measured, stats: geos[0].userData.rock }
}

// --- framing ----------------------------------------------------------------
//
// Every scale on this page changes what "back off far enough" means by two
// orders of magnitude, so the ground, the fog, the grid and the metre rule are
// all derived rather than fixed. Called on a mode change and on a size change,
// never on every slider -- moving the camera under someone dragging `lumps` is
// the fastest way to make a bench unusable.

function extent() {
  const spacing = params.size * 1.7
  if (mode === 'gallery') return Math.hypot((GALLERY_COLS * spacing) / 2, (GALLERY_ROWS * spacing) / 2)
  if (mode === 'ladder') return (ROCK_TIERS.length * spacing) / 2
  if (mode === 'tints') return (TINTS.length * spacing) / 2
  return params.size * 0.9
}

function frame() {
  const r = extent()
  const groundSize = Math.max(24, r * 6)
  ground.scale.set(groundSize, 1, groundSize)
  groundTex.repeat.set(groundSize / GROUND_TILE, groundSize / GROUND_TILE)
  // Fog closes past the far edge of the layout, never across it: measuring a
  // rock through haze is measuring the haze.
  scene.fog.near = r * 2.4
  scene.fog.far = groundSize * 0.55

  grid.scale.setScalar(params.size)
  rule.position.set(-params.size * 0.8, 0.5, -params.size * 0.5)
  // Below ~0.6 m a one-metre rule is taller than everything on screen and reads
  // as a wall. It is still the honest scale, so it stays -- just moved out of
  // the way rather than resized into a lie.
  rule.visible = showGrid && mode === 'one'

  const dist = (r / Math.tan((camera.fov * Math.PI) / 360)) * 1.5
  controls.target.set(0, params.size * 0.28, 0)
  camera.position.set(dist * 0.42, dist * 0.42 + params.size * 0.3, dist * 0.78)
}

// --- byte accounting --------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

async function gzipped(bytes) {
  // The real transfer size rather than a guess, which matters here because the
  // generator source is the unusual half of this budget and source code
  // compresses far better than a PNG (already deflate) does.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

let diskBytes = null

async function measureDisk() {
  const png = await fetch(STONE_TEX).then((r) => r.arrayBuffer())
  const src = new TextEncoder().encode(rockSource)
  const imp = new TextEncoder().encode(impostorSource)
  diskBytes = {
    png: png.byteLength,
    pngGz: await gzipped(png),
    src: src.byteLength,
    srcGz: await gzipped(src),
    imp: imp.byteLength,
    impGz: await gzipped(imp),
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
// drawing while its average triangle is still bigger than a few pixels; a rock
// of F faces has roughly sqrt(F) triangles across its silhouette, so:
//
//     switch distance = h * 928 / (TRI_PX * sqrt(F))
//
// This is a model, not a measurement, and it is on the page as a model: it puts
// the four tiers in the right ORDER and to the right rough SCALE, which is what
// a ladder decision needs. The real number comes from standing in the world.
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
  const per = Math.round(s.tris / s.count)
  const m = s.measured
  const shards = Math.max(1, Math.round(params.shards))

  // THE SHIPPED THRESHOLDS, in metres, for THIS rock. ROCK_LOD_AT is metres of
  // camera distance per metre of the rock's LADDER SIZE, so that one number is
  // the whole of what separates this rock's ladder from any other rock's. It is
  // the height with a floor at half the width -- see rockLodSize, which is the
  // same function v2/render/rocks.js measures instances through, so the metres
  // shown here are the metres the world uses.
  const lod = rockLodSize(m)
  const shipAt = ROCK_LOD_AT.map((k) => k * lod)
  const cardAt = shipAt[shipAt.length - 1]

  // --- this rock ---
  const tier = ROCK_TIERS[Math.round(params.tier)]
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} on screen)` : ''}`],
    ...(s.card
      ? [
          [`&nbsp;&nbsp;card, ${s.card.planes} plane${s.card.planes > 1 ? 's' : ''}&times;2`, s.card.triangles],
          ['&nbsp;&nbsp;baked at', `${s.card.width.toFixed(2)} &times; ${s.card.height.toFixed(2)} m`],
        ]
      : [[`&nbsp;&nbsp;${tier.name} &times; ${shards} shard${shards > 1 ? 's' : ''}`, `${tier.faces} &times; ${shards}`]]),
    ['vertices', Math.round(s.verts / s.count)],
    ['rocks drawn', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    ['measured w/h/d', `${m.width.toFixed(2)} / ${m.height.toFixed(2)} / ${m.depth.toFixed(2)} m`],
    // How hard this tier had to be inflated to read the same size as the dense
    // reference. Worth a row: it is the number that says whether a tier is still
    // describing the rock or has been reduced to a lump wearing its dimensions.
    ['sampling gain', `${s.stats.gain.toFixed(3)}&times;`, s.stats.gain < 1.2 ? 'ok' : 'warn'],
    // The tile is sized off the rock now, so this is a per-seed number rather
    // than a constant anyone can look up. Both halves are worth showing: the
    // repeat count is the art direction, the metres are what the shader sees.
    ['tile repeat', `${s.stats.texRepeat.toFixed(2)}&times; &nbsp; = ${s.stats.texMetres.toFixed(2)} m`],
    // WHERE THIS ROCK GOES TO BILLBOARD, which is the one number the ladder
    // table below cannot put in a row of its own because it is the row that has
    // no tier. Shown here too because it is the headline: it is how far the
    // world will draw any mesh at all for a rock this size.
    // The size the ladder is read in, and which of the three box axes is in
    // charge, because that is the first question anyone asks of a number like
    // this. It is a plain max, so naming the winner is naming the whole rule.
    ['ladder size', `${lod.toFixed(2)} m &nbsp; <span class="k">its ${
      lod === m.height ? 'height' : lod === m.width ? 'width' : 'depth'
    }</span>`],
    ['billboards past', `${cardAt.toFixed(0)} m`],
  ])
  document.getElementById('geonote').innerHTML = s.card
    ? `The card is a photograph of the mesh taken at load into this variant's own slice of the <em>LAYER.IMPOSTOR_ROCK</em> run -- one of twenty-five, one per variant -- so it costs no disk and cannot disagree with the mesh. It is the weakest tier here by a distance -- see the parallax note.`
    : `<em>shards</em> multiplies triangles directly: ${tier.faces} faces per shard, ${shards} shard${shards > 1 ? 's' : ''}. ` +
      `&sect;5's boulder row budgets <em>20 tris &times; 440 instances</em>, which predates this ladder -- that row is T20 with one shard, and it is the tier the vast majority of instances are at.`

  // --- the ladder ---
  //
  // EVERY ROW CARRIES THE DISTANCE IT SHIPS AT, the billboard included, because
  // a ladder without its thresholds does not say what the world does -- it only
  // says what the meshes cost. The tiers are the same for every rock; the
  // metres are this rock's alone.
  //
  // The model distance is kept beside it as the second number, because it is
  // the argument the shipped one has to answer: it says where the tier stops
  // earning its triangles at 3 px each, and a shipped threshold well inside it
  // is a deliberate choice to spend fewer triangles than the eye could use.
  table(
    document.getElementById('ladderTable'),
    ROCK_TIERS.map((t, i) => {
      const from = i === 0 ? 0 : shipAt[i - 1]
      const d = switchDistance(t.faces * shards, m.height)
      return [
        t.name,
        `${t.faces * shards} tris &nbsp; ${from.toFixed(0)}&ndash;${shipAt[i].toFixed(0)} m ` +
          `&nbsp; <span class="k">model ${d.toFixed(0)}</span>`,
        '',
        i === Math.round(params.tier) && !s.card ? 'here' : '',
      ]
    }).concat([[
      'billboard',
      `${2 * params.planes} tris &nbsp; beyond ${cardAt.toFixed(0)} m`,
      '',
      s.card ? 'here' : '',
    ]])
  )

  // --- can it be a card ---
  const depth = Math.max(m.width, m.depth)
  const crossover = depth * 28.6
  const coarsest = ROCK_TIERS[ROCK_TIERS.length - 1]
  table(document.getElementById('parallax'), [
    ['depth (widest plan axis)', `${depth.toFixed(2)} m`],
    ['parallax crossover', `${crossover.toFixed(0)} m`],
    // Against the SHIPPED handover and not the model's, because the shipped one
    // is where the billboard actually takes over. A rock whose parallax error
    // is still visible at that range is a rock the world cards too early.
    [`${coarsest.name} hands over at`, `${cardAt.toFixed(0)} m`],
    ['card is honest first?', crossover <= cardAt ? 'yes' : 'no -- mesh is still cheaper', crossover <= cardAt ? 'ok' : 'warn'],
    ['rock is this tall at 60 m', `${pixelsTall(m.height, 60).toFixed(0)} px`],
    ['&hellip; and at 150 m', `${pixelsTall(m.height, 150).toFixed(0)} px`],
  ])

  drawSwatch(s.stats)
  drawPalette()

  if (!diskBytes) return

  const shipped = diskBytes.png + diskBytes.src + diskBytes.imp
  const shippedGz = diskBytes.pngGz + diskBytes.srcGz + diskBytes.impGz
  table(document.getElementById('disk'), [
    ['stone.png (128&sup2; RGBA)', fmt(diskBytes.png)],
    ['rock.js (the generator)', fmt(diskBytes.src)],
    ['impostor.js (the card)', fmt(diskBytes.imp)],
    ['total on disk', `<span class="big">${fmt(shipped)}</span>`],
    ['gzipped over the wire', fmt(shippedGz), 'ok'],
    ['1 baked card layer, in RAM', fmt(TEX_SIZE * TEX_SIZE * 4)],
  ])
  document.getElementById('disknote').innerHTML =
    `No mesh file, and -- unlike the ferns -- no second texture either. Every rock in the ` +
    `world, every seed, every size, every environment, costs the same ${fmt(shipped)}. ` +
    `Adding a variant to the bank above costs <em>0 bytes</em>; adding a tint costs 0 bytes; ` +
    `adding a second stone tile would cost ~${fmt(diskBytes.png)} and would have to earn it ` +
    `by differing in GRAIN, since hue and value are already free.`
}

// --- texture swatch ---------------------------------------------------------

function drawSwatch(stats) {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const layer = cardMode ? (presetName ? rockImpostorLayer(presetName) : LAYER.IMPOSTOR_ROCK) : LAYER.ROCK
  const px = layerPixels(layer)
  const rgb = new ImageData(TEX_SIZE, TEX_SIZE)
  const tinted = new ImageData(TEX_SIZE, TEX_SIZE)
  // Multiply in sRGB for the swatch. The shader does it in linear and this is a
  // preview of a colour decision, not of a pixel -- but say so rather than let
  // someone match a number off it. The gain runs above 1, so the right-hand
  // patch can and should clip in its highlights: that is the real cost of
  // brightening a dark tile and it should be visible here rather than only in
  // the world.
  const gain = TINT_GAIN[tintIndex]
  const tr = Math.sqrt(gain[0])
  const tg = Math.sqrt(gain[1])
  const tb = Math.sqrt(gain[2])

  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const o = i * 4
    // Row 0 of a layer is v = 0 and a canvas draws row 0 at the top, so flip.
    const row = TEX_SIZE - 1 - Math.floor(i / TEX_SIZE)
    const d = (row * TEX_SIZE + (i % TEX_SIZE)) * 4
    const a = px[o + 3] / 255
    for (let c = 0; c < 3; c++) rgb.data[d + c] = px[o + c] * a + 0x3a * (1 - a)
    rgb.data[d + 3] = 255
    tinted.data[d] = px[o] * tr * a + 0x3a * (1 - a)
    tinted.data[d + 1] = px[o + 1] * tg * a + 0x3a * (1 - a)
    tinted.data[d + 2] = px[o + 2] * tb * a + 0x3a * (1 - a)
    tinted.data[d + 3] = 255
  }

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')
  const w = canvas.width / 2
  ;[rgb, tinted].forEach((img, i) => {
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, canvas.height)
  })

  const banner = cardMode
    ? `baked -- IMPOSTOR_ROCK${presetName ? ` + ${presetName}` : ' (scratch)'}`
    : layersLoaded
      ? `ROCK -- stone.png, untinted | &times; ${TINTS[tintIndex][0]}`
      : 'stone.png still loading -- this is the procedural stand-in'
  ctx.fillStyle = 'rgba(8,14,26,.78)'
  ctx.fillRect(0, canvas.height - 18, canvas.width, 18)
  ctx.fillStyle = layersLoaded || cardMode ? '#7f96b8' : '#c9a227'
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText(banner.replace('&times;', 'x'), canvas.width / 2, canvas.height - 5)

  document.getElementById('swatchnote').innerHTML = cardMode
    ? `The baked card. This is the only place you can read what was actually photographed -- whether the silhouette survived, whether the dilate pass left a sooty rim.`
    : `Left: the tile as shipped -- a photograph of granite, warm and dark at a mean luma of 88/255. Right: the same tile taken to <em>${TINTS[tintIndex][0]}</em>. ` +
      `A tint is a destination, not a multiply: the gain divides the tile's own mean out of the way, so it brightens and white-balances rather than darkens. ` +
      `This rock covers its widest plan axis with <em>${stats.texRepeat.toFixed(2)}</em> repeats, which is ${stats.texMetres.toFixed(2)} m per tile and a ` +
      `${((stats.texMetres * 1000) / TEX_SIZE).toFixed(0)} mm texel -- but only at THIS size. The tile scales with the rock, so the mm figure moves with <em>size</em> ` +
      `and the repeat count does not. That is the trade: a shape is one picture at every scale, and two rocks of different sizes no longer agree on how big a crystal is.`
}

// The palette as one patch of the tile per tint, which is the only
// honest way to look at them: a tint swatch on its own says nothing about what
// the multiply does to a mid-grey speckle.
function drawPalette() {
  const canvas = document.getElementById('palette')
  const ctx = canvas.getContext('2d')
  const px = layerPixels(LAYER.ROCK)
  const w = canvas.width / TINTS.length
  const N = 48

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = N
  const tctx = tmp.getContext('2d')

  TINTS.forEach(([name], i) => {
    const g = TINT_GAIN[i]
    const tr = Math.sqrt(g[0])
    const tg = Math.sqrt(g[1])
    const tb = Math.sqrt(g[2])
    const img = new ImageData(N, N)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const o = ((y % TEX_SIZE) * TEX_SIZE + (x % TEX_SIZE)) * 4
        const d = (y * N + x) * 4
        img.data[d] = px[o] * tr
        img.data[d + 1] = px[o + 1] * tg
        img.data[d + 2] = px[o + 2] * tb
        img.data[d + 3] = 255
      }
    }
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, canvas.height)
    ctx.fillStyle = i === tintIndex ? '#eaf3ff' : 'rgba(8,14,26,.7)'
    ctx.fillRect(i * w, canvas.height - 3, w, 3)
    ctx.fillStyle = '#0a1018'
    ctx.fillRect(i * w, 0, w, 13)
    ctx.fillStyle = i === tintIndex ? '#eaf3ff' : '#7f96b8'
    ctx.font = '9px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(name, i * w + w / 2, 10)
  })
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
    `<label title="${help}">${key}</label>` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${params[key]}" />` +
    `<span class="v"></span>`
  const input = row.querySelector('input')
  readouts[key] = { input, out: row.querySelector('.v'), step }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    showValue(key, step)
    // Dragging a SHAPE slider means you are no longer looking at the preset, so
    // the dropdown stops claiming you are. The three bench/material sliders are
    // not the shape and do not clear it -- you have to be able to drag snow over
    // `crag` and still be told it is `crag`.
    if (!BENCH_KEYS.has(key)) {
      presetName = ''
      presetSel.value = ''
    }
    // `size` changes what the whole stage means -- ground, fog, grid, camera --
    // so it reframes. Nothing else does, because moving the camera under someone
    // dragging a shape slider makes the change impossible to judge.
    if (key === 'size') frame()
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

const presetSel = document.getElementById('preset')
// `custom` is a destination, not a source: `defaults` and any hand-dragged
// slider land there, so the dropdown never claims you are looking at a preset
// you have since edited.
presetSel.innerHTML =
  Object.keys(ROCK_VARIANTS)
    .map((k) => `<option value="${k}" title="${ROCK_VARIANTS[k].envs.join(', ')}">${k} -- ${ROCK_VARIANTS[k].envs.join('/')}</option>`)
    .join('') + '<option value="">custom</option>'
presetSel.value = presetName
presetSel.addEventListener('change', () => {
  presetName = presetSel.value
  if (!presetName) return
  // A variant is a full shape, so anything it does not name goes back to the
  // default rather than surviving from the last one -- which is exactly what
  // rockParams does. A preset that inherited half of whatever you were just
  // looking at is not a variant you can sign off.
  Object.assign(params, rockParams(presetName, params.seed))
  tintIndex = ROCK_VARIANTS[presetName].tint
  tintSel.value = String(tintIndex)
  syncSliders()
  frame()
  refresh()
})

const tintSel = document.getElementById('tint')
tintSel.innerHTML = TINTS.map(([name, , help], i) => `<option value="${i}" title="${help}">${name}</option>`).join('')
tintSel.value = String(tintIndex)
tintSel.addEventListener('change', () => {
  tintIndex = Number(tintSel.value)
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

// ---------------------------------------------------------------------------
// LOADING A SHAPE THE RUNNING WORLD NAMED.
//
// /v2's cursor readout prints `variant-index` -- the shape's identity inside the
// world's rock bank -- and this is the box that takes it back. `rockShapeSeed`
// is the same function `buildRockBank` derives every shape's seed with, so
// setting the preset and that seed puts this previewer on EXACTLY the rock that
// was under the cursor, not a cousin of it.
//
// It reads WORLD_SEED from v2/config.js rather than taking a bank seed of its
// own, because a shape id only means anything against the bank it was printed
// from. If someone ever gives /v2 a per-session seed, this box has to learn it
// too or it starts lying, so: one constant, imported, not copied.
// ---------------------------------------------------------------------------
const shapeInput = document.getElementById('shapeid')
const shapeNote = document.getElementById('shapenote')
const loadShapeId = () => {
  const parsed = parseRockShapeId(shapeInput.value.trim())
  if (!parsed) {
    shapeNote.textContent = `not a shape id: expected something like shingle-1`
    return
  }
  presetName = parsed.name
  presetSel.value = presetName
  params.seed = rockShapeSeed(WORLD_SEED, parsed.name, parsed.index)
  seedInput.value = params.seed
  Object.assign(params, rockParams(presetName, params.seed))
  tintIndex = ROCK_VARIANTS[presetName].tint
  tintSel.value = String(tintIndex)
  shapeNote.textContent = `${parsed.name}-${parsed.index} -- seed ${params.seed}`
  syncSliders()
  frame()
  refresh()
}
document.getElementById('shapego').addEventListener('click', loadShapeId)
shapeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loadShapeId()
})

// gallery / ladder / tints are one exclusive mode; card / grid / wire / spin are
// independent of it and of each other.
const MODE_BUTTONS = { gallery: 'gallery', ladder: 'ladder', tints: 'tints' }
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
toggle('card', () => cardMode, (v) => { cardMode = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  // Straight back to ROCK_DEFAULTS. The texture scale used to be excepted here,
  // because it lived in TILE_METRES and reset had to put back the SHIPPING value
  // rather than whatever ROCK_DEFAULTS held; now `texRepeat` is a property of the
  // rock and there is only one number, so there is nothing left to except.
  Object.assign(params, ROCK_DEFAULTS, { brightness: 1, snow: 0, moss: 0, planes: 2, seed: params.seed })
  presetName = ''
  presetSel.value = ''
  syncSliders()
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

// Not top-level await: the build target is es2020, and refresh() already
// tolerates the disk numbers being absent.
frame()
refresh()
measureDisk().then(refresh)
// And again when stone.png lands in the array -- not just to repaint the swatch:
// a card baked before the layer arrived would be a photograph of the procedural
// stand-in, so this is what makes `card` correct on a cold load.
layersReady.then(refresh)

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
