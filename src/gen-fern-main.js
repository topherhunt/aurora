import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildFern, geometryBytes, FERN_DEFAULTS } from './props/fern.js'
import { bakeImpostor, buildImpostorCard } from './props/impostor.js'
import {
  FERN_CARD_PLANES, FERN_LAYERS, FERN_ASPECTS, FERN_SHIP, FERN_TIERS, fernCardLayer,
} from './props/fern-bank.js'
import { FERN_LOD } from './v2/render/ferns.js'
import { buildTextureArray, loadImageLayers, LAYER, TEX_SIZE } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import fernSource from './props/fern.js?raw'
import impostorSource from './props/impostor.js?raw'

// ---------------------------------------------------------------------------
// The procedural fern previewer (gen-fern.html).
//
// A generator is only as good as the range it covers, and a range is a seeing
// question: one fern proves nothing, twenty seeds side by side show whether the
// parameters produce variety or produce the same plant wearing hats. Hence the
// gallery mode.
//
// The budget panel is the other half. A procedural prop has no mesh file, so
// "how much disk does this cost" has a different shape than it does for every
// other asset in this project: what SHIPS is one 128px RGBA cutout plus the
// source of the generator, and what the generator produces at runtime is a
// few kilobytes of buffers that never touch disk at all. The panel keeps those
// three separate, because conflating them is how a procedural asset gets
// wrongly described as free.
//
// THE LADDER is what the tier slider and the right-hand ladder table are for.
// The world draws this plant at three distances and the previewer has to be
// able to show you all three, so the slider snaps `segments` to the shipping
// rungs and the table reports the metres each one covers. Both read
// render/ferns.js's own FERN_LOD rather than a copy: a bench that disagrees
// with the game about where LOD1 ends is worse than no bench.
//
// THE CARD is the third thing this page does, and it is why the material
// changed. A fern past 14 m is two triangles wearing a photograph of itself
// (props/impostor.js, props/fern-bank.js), and that photograph is a layer of
// the shared DataArrayTexture -- so a bench drawing ferns through a single
// bound `map` could not render one at all. This page now uses the REAL prop
// material, the way gen-tree.html does: one sampler2DArray, per-vertex
// `texLayer`, wrap diffuse chained on top. The cost is that a fern is invisible
// rather than untextured for the few hundred milliseconds before the frond PNG
// lands, which the swatch panel says out loud instead of hiding.
// ---------------------------------------------------------------------------

// Not in props/layers/. That directory holds baked atlas slices, and
// check-props.mjs asserts every PNG in it is referenced by a built GLB -- a
// hand-cut source texture for a code generator would read as an orphan from a
// stale rebuild forever.
const FROND_TEX = 'ferns/fern_frond_0.png'

// The megascan sheet these fronds were cut from. Hardcoded because it lives in
// gitignored tmp/ and is not served in a build -- the point of showing it is
// the ratio, and the ratio does not change.
const SOURCE = {
  name: 'Lady_Fern_wdvlditia_Raw 8K',
  baseColor: 7448124,
  opacity: 12575209,
  fbxVariants: 9,
  fbxBytes: 27034184,
}

// --- slider spec ------------------------------------------------------------
// Ranges are chosen so that both ends are things you would plausibly want, not
// so that both ends are valid: `arch` past ~2.5 curls a frond into a tube, and
// seeing that is how you learn where the useful range stops.
const SLIDERS = [
  ['fronds', 1, 20, 1, 'how many fronds in the rosette'],
  ['height', 0.1, 1.6, 0.01, 'final height in metres -- geometry is rescaled to hit this exactly'],
  ['segments', 1, 8, 1, 'quads along each frond. Triangles = fronds x segments x 2'],
  ['pitch', 0.2, 1.55, 0.01, 'launch angle above horizontal (radians). High = upright shuttlecock'],
  ['arch', 0, 3.2, 0.01, 'total bend from launch to tip (radians). High = weeping'],
  ['curve', 0.3, 3, 0.05, 'where the bend concentrates. >1 = stiff base, floppy tip'],
  ['tipBias', 0.5, 3, 0.05, 'where the segment SEAMS sit. >1 crowds them toward the tip, where the bend is. Equal to curve = equal turn per segment; 1 = evenly spaced'],
  ['pitchFalloff', 0, 0.9, 0.01, 'spread of launch angles between fronds -- what makes a rosette read as a rosette'],
  ['lengthVar', 0, 0.8, 0.01, 'per-frond length jitter'],
  ['widthScale', 0.3, 2.2, 0.01, 'multiplies the frond cutout width'],
  ['taper', 0, 0.9, 0.01, 'geometric narrowing toward the tip. The texture already tapers -- doubling it pinches the tip off'],
  ['sway', 0, 1.2, 0.01, 'lateral drift, so a frond is not confined to a plane'],
  ['roll', 0, 1.4, 0.01, 'twist of the blade about its own axis'],
  ['yawJitter', 0, 1, 0.01, 'how far each frond may wander off even spacing'],
  ['crownRadius', 0, 0.2, 0.005, 'how far frond bases sit from the axis'],
  ['crozier', 0, 1, 0.05, 'fraction of fronds built as curled fiddleheads'],
  ['alphaTest', 0.05, 0.95, 0.01, 'cutout threshold. Low = lacy and aliased, high = eats the pinna tips'],
  ['brightness', 0.5, 4, 0.05, 'multiplies the frond albedo. The scan is forest-floor dark (mean RGB 28,41,4) -- this is a material property, not geometry'],
  ['planes', 1, 4, 1, 'CARD ONLY: quads crossed about the axis. 1 is a single billboard and vanishes edge-on unless something turns it; 2 never vanishes and is what ships'],
]

// WHAT THE PAGE OPENS ON IS WHAT THE GAME DRAWS, not FERN_DEFAULTS. Those are
// the generator's own fallbacks and the bank overrides most of them (FERN_BASE
// alone moves curve, pitchFalloff, lengthVar, widthScale, sway, roll, yawJitter
// and crownRadius), so a bench starting from them was previewing a fern that
// stands nowhere in the world. Seeded from FERN_SHIP at the finest tier's
// segment count instead, so the first thing on screen is the LOD0 fern.
//
// brightness 2.0, not 1.0. The cutout is a forest-floor scan (mean RGB 28,41,4
// over its own coverage) and at 1.0 it renders near-black against the ground.
// This is a material setting, not geometry -- see the note in fern.js.
// FINEST FIRST, which is the order the ladder is walked in and the reverse of
// how FERN_TIERS is authored -- it reads as a cost curve there. LOD2 is in this
// list even though the world stopped drawing it: the bank still builds it, and
// "what did we give up" is a question the previewer should be able to answer.
const MESH_TIERS = FERN_TIERS.slice().reverse()

const shipParams = () => ({
  ...FERN_DEFAULTS,
  ...FERN_SHIP,
  segments: MESH_TIERS[0].segments,
  alphaTest: 0.5,
  brightness: 2.0,
  planes: FERN_CARD_PLANES,
})

const params = shipParams()

// --- scene ------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100)
camera.position.set(0.9, 0.65, 1.15)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.25, 0)
controls.enableDamping = true

// Spin orbits the camera rather than turning the fern, so the ground turns with
// it and you are walking around a plant instead of watching one on a lazy susan.
// A rotating mesh also lies about the lighting -- the sun sweeps across the
// fronds -- which is the one thing this previewer exists to judge honestly.
// autoRotateSpeed is three's unit: a full orbit takes 60/speed seconds when
// update() is handed a delta, so this is the 0.35 rad/s the group used to spin at.
// Off by default. A turntable is useful for judging a silhouette and actively
// in the way when you are dragging a slider and watching one branch -- and
// judging a silhouette is the thing you do second.
controls.autoRotate = false
controls.autoRotateSpeed = (0.35 * 60) / (2 * Math.PI)

// Lighting matched to the game's noon, same as props.html, so the fern is
// judged under the light it will actually stand in.
scene.add(new THREE.DirectionalLight(0xfff3e2, 2.1).translateY(0))
scene.children[0].position.set(3, 5, 2)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

// --- ground -----------------------------------------------------------------
//
// Generated, not loaded, so it costs nothing in the "what ships" panel; see
// preview-stage.js for why it is deliberately lo-fi and nearest-filtered.

// 24 m of ground, one texture tile every 2 m. The size is set by the fog rather
// than by the ferns: the plane has to reach past where the fog closes, or the
// illusion ends at a visible straight edge in mid-air.
const GROUND_SIZE = 24
const GROUND_TILE = 3 // 3 m, so ~4.7 cm texels and a repeat you have to hunt for

const groundTex = grassTexture(renderer)
groundTex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
scene.add(ground)

// Fog to the background colour, starting past the gallery grid so measuring a
// fern is never done through haze.
scene.fog = new THREE.Fog(0x0a1018, 11, 26)

const grid = new THREE.GridHelper(2, 20, 0x2b4a72, 0x16233a)
grid.position.y = 0.002
scene.add(grid)

// A one-metre rule, because "is this fern the right size" is the question a
// previewer most often has to answer and nothing else in shot answers it.
const rule = new THREE.Mesh(
  new THREE.BoxGeometry(0.02, 1, 0.02),
  new THREE.MeshBasicMaterial({ color: 0x4a7fbf, fog: false })
)
rule.position.set(-0.75, 0.5, -0.35)
scene.add(rule)

// --- material ---------------------------------------------------------------
//
// The REAL prop material, patched exactly the way the game patches it: the
// array sampler from material.js, then wrap (half-Lambert) diffuse chained on
// top so fronds facing away from the sun read as backlit rather than black.
// Chained, not replaced -- assigning over onBeforeCompile would drop the
// sampler2DArray patch and every fern would render untextured white.
const atlas = buildTextureArray()
const material = createPropMaterial(atlas)
const arrayPatch = material.onBeforeCompile
material.onBeforeCompile = (shader, r) => {
  arrayPatch(shader, r)
  wrapLambert(shader)
}
// A distinct key because this program is the array patch AND the wrap patch;
// sharing 'prop-snow-v1' would let three hand us a cached program with only one
// of them compiled in.
material.customProgramCacheKey = () => 'gen-fern-array-wrap-v1'

// A SEPARATE MATERIAL FOR WIREFRAME, not `material.wireframe = true`. Setting
// the flag on the prop material keeps its map and its alphaTest, so every edge
// crossing a transparent part of the frond cutout gets discarded and you see
// perhaps half the mesh -- which is the opposite of what the view is for. This
// samples nothing and discards nothing, so an edge is an edge.
const wireMaterial = new THREE.MeshBasicMaterial({
  color: 0x8fd48f,
  wireframe: true,
  fog: false,
})

// FROND_0 has no procedural stand-in in buildTextureArray(), so the layer is
// transparent -- and therefore the fern is invisible -- until this resolves.
// Deliberately unguarded: a failed layer throws and the page dies loudly,
// because a silently-stubbed texture is exactly what this bench exists to not
// show you.
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

// --- the ferns --------------------------------------------------------------

const group = new THREE.Group()
scene.add(group)

const GALLERY_COLS = 5
const GALLERY_ROWS = 4
const GALLERY_N = GALLERY_COLS * GALLERY_ROWS

// Ferns spread wider than they are tall, so spacing keys off the built width
// rather than off `height` -- at high `arch` a height-keyed grid overlaps.
const gallerySpacing = () => params.height * 1.9

let galleryMode = false
let wireframe = false
let showGrid = true // the lattice and the metre rule; off is the "stand in it" view

// Draw the impostor instead of the mesh. Deliberately NOT a view: the whole
// question a card asks is "does this still read as a fern from where I am
// standing", which you cannot answer if the camera jumps when you press the
// button. Toggling swaps the geometry and leaves the camera exactly where you
// put it, so you can flip back and forth and watch for the moment it breaks.
let cardMode = false

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

// Returns the aggregate stats so the budget panel can report a whole gallery
// rather than pretending the first fern is representative.
function rebuild() {
  clearGroup()
  material.alphaTest = params.alphaTest
  material.color.setScalar(params.brightness)
  material.needsUpdate = true
  const drawMaterial = wireframe ? wireMaterial : material

  const seeds = galleryMode
    ? Array.from({ length: GALLERY_N }, (_, i) => Number(params.seed) + i)
    : [Number(params.seed)]

  let tris = 0
  let verts = 0
  let bytes = 0
  let card = null
  let measured = null

  const geos = seeds.map((seed) =>
    buildFern({ ...params, seed, frondLayers: FERN_LAYERS, frondAspect: FERN_ASPECTS })
  )

  // The first fern's real extents, which the panel reports and the bake frames
  // to. `spread` is the diameter of the enclosing cylinder about the axis, not
  // the bounding box's span: the bake centres its frustum on x = 0 and the card
  // crosses its planes there, so a rosette that throws more frond one way than
  // the other has to be framed by its furthest reach in either.
  //
  // A rosette is as deep as it is wide, so `spread` is also the DEPTH that
  // DESIGN.md §5's parallax rule takes -- `depth x 28.6` is the range past
  // which a flat thing's refusal to turn stops reading as wrong, and it is the
  // number that says whether a card is legal at 26 m at all.
  {
    const g = geos[0]
    g.computeBoundingBox()
    const bb = g.boundingBox
    measured = {
      height: bb.max.y - bb.min.y,
      spread:
        2 *
        Math.max(
          Math.abs(bb.min.x), Math.abs(bb.max.x),
          Math.abs(bb.min.z), Math.abs(bb.max.z)
        ),
    }
  }

  // ONE bake feeds every card on screen, which is not a shortcut but the
  // shipping arrangement: fern-bank.js keeps two impostor layers for the whole
  // 16-variant bank, so a seed gallery at this tier really does show twenty
  // instances of one picture. Seeing that is the point of looking.
  //
  // Which of the two layers gets written is whichever one THIS fern's `arch`
  // would land in, so the bench is always photographing into the slot the
  // shipping bank would use rather than into a scratch one.
  let drawn = geos
  if (cardMode) {
    const layer = fernCardLayer(params.arch)
    const ext = bakeImpostor(renderer, geos[0], atlas, layer, {
      width: measured.spread,
      height: measured.height,
    })
    drawn = geos.map((geo) => {
      geo.computeBoundingBox()
      const k = (geo.boundingBox.max.y - geo.boundingBox.min.y) / measured.height
      const quad = buildImpostorCard(ext.width * k, ext.height * k, layer, params.planes)
      tris += quad.userData.impostor.triangles
      verts += quad.getAttribute('position').count
      bytes += geometryBytes(quad)
      return quad
    })
    card = { ...drawn[0].userData.impostor, layer, ...ext }
    // clearGroup only disposes what is IN the group, and these never go in.
    for (const geo of geos) geo.dispose()
  } else {
    for (const geo of geos) {
      tris += geo.userData.fern.triangles
      verts += geo.userData.fern.vertices
      bytes += geometryBytes(geo)
    }
  }

  drawn.forEach((geo, i) => {
    const mesh = new THREE.Mesh(geo, drawMaterial)
    if (galleryMode) {
      mesh.position.set(
        ((i % GALLERY_COLS) - (GALLERY_COLS - 1) / 2) * gallerySpacing(),
        0,
        (Math.floor(i / GALLERY_COLS) - (GALLERY_ROWS - 1) / 2) * gallerySpacing()
      )
    }
    group.add(mesh)
  })

  // The ground stays in gallery mode now that it is a place rather than a
  // 2.4 m disc -- twenty ferns floating in a void read as a spritesheet.
  grid.visible = showGrid && !galleryMode
  rule.visible = showGrid && !galleryMode

  return { tris, verts, bytes, count: seeds.length, card, measured }
}

// --- byte accounting --------------------------------------------------------

const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`

async function gzipped(bytes) {
  // CompressionStream gives the real transfer size rather than a guess, which
  // matters here: the generator source is the unusual half of this budget and
  // source code compresses far better than a texture does.
  //
  // Takes bytes, never a string. Decoding a PNG to text and re-encoding it
  // inflated it enough that the "gzipped" total came out LARGER than the raw
  // one -- which is also the honest headline: a PNG is already deflate, so the
  // wire saving here comes almost entirely from the JavaScript.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return (await new Response(stream).arrayBuffer()).byteLength
}

let diskBytes = null // resolved once: { png, pngGz, src, srcGz, imp, impGz }

async function measureDisk() {
  const png = await fetch(FROND_TEX).then((r) => r.arrayBuffer())
  const src = new TextEncoder().encode(fernSource)
  // impostor.js is counted because the card is code too -- it is the whole of
  // what the fourth tier ships, since its texture is baked rather than stored.
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
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

// DESIGN.md §5's bush-class ladder, keyed by what the tier actually builds.
// Triangles are exactly fronds x segments x 2, so `segments` IS the tier.
const TIER_BUDGET = { 6: 84, 4: 56, 2: 28 }

// --- the LOD ladder ---------------------------------------------------------

// Quest 2's default eye buffer, in pixels per degree. The one number that turns
// "this ring ends at 14 m" into something you can judge: how big the plant
// actually is on screen where the next rung takes over.
const PX_PER_DEG = 16.2

const apparentPx = (metres, distance) =>
  ((Math.atan(metres / distance) * 180) / Math.PI) * PX_PER_DEG

/**
 * One row per rung of the ladder the world actually draws, plus any tier the
 * bank still builds and the world has dropped -- greyed rather than omitted,
 * because a rung that was deleted from the world is a decision the bench should
 * show rather than hide.
 *
 * The triangle column is what THIS fern would cost at that rung, not what the
 * shipping fern costs, so pushing `fronds` up prices every ring at once.
 */
function ladderRows(measured) {
  const shipped = new Map(FERN_LOD.rings.filter((r) => r.tier).map((r) => [r.tier, r]))
  const card = FERN_LOD.rings.find((r) => r.tier === null)
  const seg = Math.round(params.segments)
  const rows = MESH_TIERS.map(({ name, segments }) => {
    const ring = shipped.get(name)
    return {
      name,
      range: ring ? `${ring.from}-${ring.to} m` : 'not drawn',
      tris: Math.round(params.fronds) * segments * 2,
      px: ring ? apparentPx(measured.height, ring.to) : null,
      here: !cardMode && segments === seg,
      off: !ring,
    }
  })
  rows.push({
    name: 'card',
    range: `${card.from}-${card.to} m`,
    tris: Math.round(params.planes) * 2,
    px: apparentPx(measured.height, card.to),
    here: cardMode,
    off: false,
  })
  return rows
}

function drawLadder(s) {
  const m = s.measured
  const card = FERN_LOD.rings.find((r) => r.tier === null)

  document.getElementById('ladder').innerHTML =
    '<tr><th>ring</th><th>covers</th><th>tris</th><th>px at far edge</th></tr>' +
    ladderRows(m)
      .map(
        (r) =>
          `<tr class="${r.here ? 'here' : r.off ? 'off' : ''}">` +
          `<td>${r.name}</td><td>${r.range}</td><td>${r.tris}</td>` +
          `<td>${r.px === null ? '--' : r.px.toFixed(0)}</td></tr>`
      )
      .join('')

  // §5's rule is that a billboard's defect is PARALLAX, not detail -- the error
  // is an angle, atan(depth / distance), and under ~2 deg it stops reading as
  // wrong at walking pace. That gives `crossover = depth x 28.6`, and the card
  // only has to be honest from where the mesh rings give out.
  const crossover = m.spread * 28.6
  table(document.getElementById('ladderfoot'), [
    ['height', `${m.height.toFixed(2)} m`],
    ['spread (= depth)', `${m.spread.toFixed(2)} m`],
    ['card honest past', `${crossover.toFixed(0)} m`, crossover <= card.from ? 'ok' : 'warn'],
    ['boundary hysteresis', `+${(FERN_LOD.hysteresis * 100).toFixed(0)}%`],
    [
      'bed',
      `${FERN_LOD.density}/m&sup2; to ${FERN_LOD.fullRadius} m, thinning to ${FERN_LOD.drawRadius} m`,
    ],
  ])

  const verdict =
    crossover <= card.from
      ? `Its ${m.spread.toFixed(2)} m spread puts that at ${crossover.toFixed(0)} m, inside where the mesh gives out, so the card is legal the moment it takes over.`
      : `Its ${m.spread.toFixed(2)} m spread puts that at ${crossover.toFixed(0)} m, so the card is taken ${(crossover - card.from).toFixed(0)} m early and a fern between ${card.from} and ${crossover.toFixed(0)} m fails to turn by more than 2&deg;. The bed takes it anyway on density: that annulus alone is ~${Math.round(Math.PI * (crossover * crossover - card.from * card.from) * FERN_LOD.density)} plants. It survives because a rosette is near enough radially symmetric that there is no feature to watch stay put -- the same property that lets the card cancel the instance's yaw.`

  document.getElementById('laddernote').innerHTML =
    `Distances are from render/ferns.js, not copied here. Each ring is its own InstancedMesh -- ` +
    `a fern changes rung by moving between them -- so a rung costs a draw call, which is why ` +
    `LOD2 was dropped rather than kept for its ~5k triangles. <em>Hysteresis</em> is the dead band ` +
    `on every boundary: a fern already at a ring holds it out to ${(1 + FERN_LOD.hysteresis).toFixed(2)}&times; ` +
    `the distance, so a few hundred plants sitting on a boundary cannot oscillate. ` +
    `<em>Card honest past</em> is &sect;5's parallax rule, <code>depth &times; 28.6</code>. ${verdict}`
}

function refresh() {
  const s = rebuild()
  const per = Math.round(s.tris / s.count)

  // The card has no segment count -- it is a photograph -- so its budget is the
  // ladder's own card row rather than a mesh tier's.
  const budget = s.card ? 4 : (TIER_BUDGET[Math.round(params.segments)] ?? 84)
  const label = s.card
    ? `bush-class card`
    : `bush-class ${Math.round(params.segments)}-segment tier`

  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${per}</span>${s.count > 1 ? ` (${s.tris} total)` : ''}`],
    ...(s.card
      ? [
          [`&nbsp;&nbsp;card ${s.card.planes} plane${s.card.planes > 1 ? 's' : ''}&times;2`, s.card.triangles],
          [
            '&nbsp;&nbsp;wearing layer',
            s.card.layer === LAYER.IMPOSTOR_FERN_UPRIGHT ? 'FERN_UPRIGHT' : 'FERN_ARCHED',
          ],
          ['&nbsp;&nbsp;baked at', `${s.card.width.toFixed(2)} &times; ${s.card.height.toFixed(2)} m`],
        ]
      : [[`&nbsp;&nbsp;fronds &times; ${Math.round(params.segments)} seg &times; 2`, per]]),
    ['vertices', Math.round(s.verts / s.count)],
    ['ferns drawn', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    [label, `${per} / ${budget} tris`, per <= budget ? 'ok' : 'warn'],
  ])

  drawLadder(s)

  drawSwatch(
    s.card ? s.card.layer : LAYER.FROND_0,
    s.card
      ? s.card.layer === LAYER.IMPOSTOR_FERN_UPRIGHT
        ? 'baked -- IMPOSTOR_FERN_UPRIGHT'
        : 'baked -- IMPOSTOR_FERN_ARCHED'
      : 'FROND_0 -- the scanned cutout'
  )

  if (!diskBytes) return

  const shipped = diskBytes.png + diskBytes.src + diskBytes.imp
  const shippedGz = diskBytes.pngGz + diskBytes.srcGz + diskBytes.impGz
  table(document.getElementById('disk'), [
    ['frond_0.png (128&sup2; RGBA)', fmt(diskBytes.png)],
    ['fern.js (the generator)', fmt(diskBytes.src)],
    ['impostor.js (the card)', fmt(diskBytes.imp)],
    ['total on disk', `<span class="big">${fmt(shipped)}</span>`],
    ['gzipped over the wire', fmt(shippedGz), 'ok'],
    // Not a disk cost and not a download: the two impostor layers are written
    // at load by rendering the mesh, so they are resident bytes only.
    ['2 baked card layers, in RAM', fmt(2 * TEX_SIZE * TEX_SIZE * 4)],
  ])
  document.getElementById('disknote').innerHTML =
    `No mesh file. The shape is <em>code</em>, so every fern in the world -- every seed, ` +
    `every size -- costs the same ${fmt(shipped)}. Adding a variant costs 0 bytes; ` +
    `adding a second frond cutout costs ~${fmt(diskBytes.png)}. The card costs 0 bytes ` +
    `too: it is a photograph of the mesh taken at load, so it cannot disagree with the ` +
    `mesh and there is nothing to rebuild when the generator changes.`

  const srcTotal = SOURCE.baseColor + SOURCE.opacity
  table(document.getElementById('source'), [
    ['8K BaseColor', fmt(SOURCE.baseColor)],
    ['8K Opacity', fmt(SOURCE.opacity)],
    [`${SOURCE.fbxVariants} LOD0 FBX meshes`, fmt(SOURCE.fbxBytes)],
    ['reduction', `${Math.round(srcTotal / diskBytes.png)}&times;`, 'ok'],
  ])
  document.getElementById('sourcenote').textContent =
    `${SOURCE.name}. Only the two maps above were used, and only one frond out of the ~20 on the sheet. ` +
    `The FBX meshes were not used at all -- that is what "procedural" buys.`
}

// --- texture swatch ---------------------------------------------------------
//
// Two panes of one layer: its colour and its ALPHA on its own. The alpha gets
// its own pane because it is the load-bearing half -- a frond card is a
// rectangle, and every bit of its shape is in that channel.
//
// In `card` mode the layer shown is the BAKED IMPOSTOR rather than the frond
// cutout, which is the most useful thing on the page at that tier: the card is
// six-hundredths of a screen at its own draw distance, and this is the only
// place you can actually read what got photographed -- whether the silhouette
// survived, whether the dilate pass left a sooty rim, whether the margin held.

function drawSwatch(layer, caption) {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  const px = layerPixels(layer)
  const rgb = new ImageData(TEX_SIZE, TEX_SIZE)
  const alpha = new ImageData(TEX_SIZE, TEX_SIZE)
  for (let i = 0; i < TEX_SIZE * TEX_SIZE; i++) {
    const o = i * 4
    // Row 0 of a layer is v = 0, and a canvas draws row 0 at the TOP, so flip
    // here or every frond hangs by its tip.
    const row = TEX_SIZE - 1 - Math.floor(i / TEX_SIZE)
    const d = (row * TEX_SIZE + (i % TEX_SIZE)) * 4
    // Over a mid grey, so a forest-floor-dark scan stays visible.
    const a = px[o + 3] / 255
    for (let c = 0; c < 3; c++) rgb.data[d + c] = px[o + c] * a + 0x3a * (1 - a)
    rgb.data[d + 3] = 255
    alpha.data[d] = alpha.data[d + 1] = alpha.data[d + 2] = px[o + 3]
    alpha.data[d + 3] = 255
  }

  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = TEX_SIZE
  const tctx = tmp.getContext('2d')
  const w = canvas.width / 2
  ;[rgb, alpha].forEach((img, i) => {
    tctx.putImageData(img, 0, 0)
    ctx.drawImage(tmp, i * w, 0, w, canvas.height)
  })

  // Say so rather than showing an empty layer and letting it pass for the art.
  const banner = layersLoaded ? caption : 'frond PNG still loading -- this layer is empty'
  if (banner) {
    ctx.fillStyle = 'rgba(8,14,26,.78)'
    ctx.fillRect(0, canvas.height - 18, canvas.width, 18)
    ctx.fillStyle = layersLoaded ? '#7f96b8' : '#c9a227'
    ctx.font = '11px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(banner, canvas.width / 2, canvas.height - 5)
  }
}

// --- controls ---------------------------------------------------------------

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
  const show = () => {
    out.textContent = step >= 1 ? params[key] : Number(params[key]).toFixed(2)
  }
  input.addEventListener('input', () => {
    params[key] = Number(input.value)
    show()
    if (key === 'segments') showTier()
    refresh()
  })
  show()
  slidersEl.appendChild(row)
}

// THE TIER SLIDER IS NOT A PARAMETER. It writes `segments`, because that is the
// whole of what a mesh tier is -- the three rungs are re-generations of one
// plant at 6, 4 and 2 quads a frond. Keeping it as a view over `segments`
// rather than as state of its own is what stops the two disagreeing: drag
// `segments` to a value no rung uses and this says `custom` instead of naming a
// tier the fern on screen is not.
const tierRow = document.getElementById('tierrow')
tierRow.className = 'row'
tierRow.innerHTML =
  `<label title="the shipping ladder's rungs, finest first -- sets segments">tier</label>` +
  `<input type="range" min="0" max="${MESH_TIERS.length - 1}" step="1" value="0" />` +
  `<span class="v"></span>`
const tierInput = tierRow.querySelector('input')
const tierOut = tierRow.querySelector('.v')

function showTier() {
  const i = MESH_TIERS.findIndex((t) => t.segments === Math.round(params.segments))
  if (i >= 0) tierInput.value = i
  tierOut.textContent = i >= 0 ? MESH_TIERS[i].name : 'custom'
}

tierInput.addEventListener('input', () => {
  params.segments = MESH_TIERS[Number(tierInput.value)].segments
  readouts.segments.input.value = params.segments
  readouts.segments.out.textContent = params.segments
  showTier()
  refresh()
})
showTier()

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
  if (v) {
    // Frame the whole grid: half its diagonal, backed off by the FOV, plus
    // margin. Hardcoding a camera position only ever suited one `height`.
    const sp = gallerySpacing()
    const half = Math.hypot((GALLERY_COLS * sp) / 2, (GALLERY_ROWS * sp) / 2)
    const dist = (half / Math.tan((camera.fov * Math.PI) / 360)) * 1.15
    controls.target.set(0, params.height * 0.35, 0)
    camera.position.set(0, dist * 0.62, dist * 0.78)
  } else {
    controls.target.set(0, params.height * 0.45, 0)
    camera.position.set(params.height * 1.6, params.height * 1.2, params.height * 2.1)
  }
})
toggle('grid', () => showGrid, (v) => { showGrid = v })
toggle('card', () => cardMode, (v) => { cardMode = v })
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  // Back to the shipping fern, not to FERN_DEFAULTS -- same argument as the note
  // on shipParams. The seed is deliberately kept: reset is for undoing a slider
  // hunt, and rerolling the plant underneath you at the same time makes it
  // impossible to see what the reset actually changed.
  Object.assign(params, shipParams(), { seed: params.seed })
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    readouts[key].out.textContent =
      Number.isInteger(params[key]) ? params[key] : Number(params[key]).toFixed(2)
  }
  showTier()
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

// Not top-level await: the build target is es2020. `refresh()` already tolerates
// the disk numbers being absent, so the fern renders immediately and the budget
// panel fills in when the measurement lands.
refresh()
measureDisk().then(refresh)
// And again when the frond cutout lands in the array. Not just to repaint the
// swatch: a card baked before the layer arrived would be a photograph of an
// invisible fern, so this is what makes `card` correct on a cold load.
layersReady.then(refresh)

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
