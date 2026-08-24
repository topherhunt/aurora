import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildFern, geometryBytes, FERN_DEFAULTS } from './props/fern.js'
import { grassTexture, wrapLambert } from './preview-stage.js'
import fernSource from './props/fern.js?raw'

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
// Deliberately NOT the runtime path -- same caveat as props.html. This gives
// the fern its own material and its own texture; the game will pack fronds
// into the shared DataArrayTexture and one BatchedMesh (DESIGN.md §5).
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
]

// brightness 2.0, not 1.0. The cutout is a forest-floor scan (mean RGB 28,41,4
// over its own coverage) and at 1.0 it renders near-black against the ground.
// This is a material setting, not geometry -- see the note in fern.js.
const params = { ...FERN_DEFAULTS, alphaTest: 0.5, brightness: 2.0 }

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

const texLoader = new THREE.TextureLoader()
const frondTex = texLoader.load(FROND_TEX, () => {
  drawSwatch()
  refresh()
})
frondTex.colorSpace = THREE.SRGBColorSpace
frondTex.anisotropy = renderer.capabilities.getMaxAnisotropy()

const material = new THREE.MeshLambertMaterial({
  map: frondTex,
  alphaTest: params.alphaTest,
  transparent: false,
  side: THREE.DoubleSide,
})

// Wrap (half-Lambert) diffuse, so the fronds facing away from the sun read as
// backlit rather than black. See preview-stage.js for the whole argument.
material.onBeforeCompile = wrapLambert

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

function clearGroup() {
  for (const child of group.children) child.geometry.dispose()
  group.clear()
}

// Returns the aggregate stats so the budget panel can report a whole gallery
// rather than pretending the first fern is representative.
function rebuild() {
  clearGroup()
  material.alphaTest = params.alphaTest
  material.wireframe = wireframe
  material.color.setScalar(params.brightness)
  material.needsUpdate = true

  const seeds = galleryMode
    ? Array.from({ length: GALLERY_N }, (_, i) => Number(params.seed) + i)
    : [Number(params.seed)]

  let tris = 0
  let verts = 0
  let bytes = 0

  seeds.forEach((seed, i) => {
    const geo = buildFern({ ...params, seed })
    tris += geo.userData.fern.triangles
    verts += geo.userData.fern.vertices
    bytes += geometryBytes(geo)

    const mesh = new THREE.Mesh(geo, material)
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

  return { tris, verts, bytes, count: seeds.length }
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

let diskBytes = null // resolved once: { png, src, srcGz, pngGz }

async function measureDisk() {
  const png = await fetch(FROND_TEX).then((r) => r.arrayBuffer())
  const src = new TextEncoder().encode(fernSource)
  diskBytes = {
    png: png.byteLength,
    pngGz: await gzipped(png),
    src: src.byteLength,
    srcGz: await gzipped(src),
  }
}

function table(el, rows) {
  el.innerHTML = rows
    .map(([k, v, cls]) => `<tr><td class="k">${k}</td><td class="n ${cls ?? ''}">${v}</td></tr>`)
    .join('')
}

function refresh() {
  const s = rebuild()

  const per = s.count > 1 ? ` (${Math.round(s.tris / s.count)} ea)` : ''
  table(document.getElementById('geo'), [
    ['triangles', `<span class="big">${s.tris}</span>${per}`],
    ['vertices', s.verts],
    ['ferns drawn', s.count],
    ['geometry in RAM', fmt(s.bytes)],
    [
      'small-class budget',
      `${Math.round(s.tris / s.count)} / 16 tris`,
      s.tris / s.count <= 16 ? 'ok' : 'warn',
    ],
  ])

  if (!diskBytes) return

  const shipped = diskBytes.png + diskBytes.src
  const shippedGz = diskBytes.pngGz + diskBytes.srcGz
  table(document.getElementById('disk'), [
    ['frond_0.png (128&sup2; RGBA)', fmt(diskBytes.png)],
    ['fern.js (the generator)', fmt(diskBytes.src)],
    ['total on disk', `<span class="big">${fmt(shipped)}</span>`],
    ['gzipped over the wire', fmt(shippedGz), 'ok'],
  ])
  document.getElementById('disknote').innerHTML =
    `No mesh file. The shape is <em>code</em>, so every fern in the world -- every seed, ` +
    `every size -- costs the same ${fmt(shipped)}. Adding a variant costs 0 bytes; ` +
    `adding a second frond cutout costs ~${fmt(diskBytes.png)}.`

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

function drawSwatch() {
  const canvas = document.getElementById('swatch')
  const ctx = canvas.getContext('2d')
  const img = frondTex.image
  if (!img) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, 256, 128)

  // RGB on the left, over a mid grey so dark foliage stays visible.
  ctx.fillStyle = '#3a4550'
  ctx.fillRect(0, 0, 128, 128)
  ctx.drawImage(img, 0, 0, 128, 128)

  // Alpha on the right, read back and expanded to greyscale.
  const tmp = document.createElement('canvas')
  tmp.width = tmp.height = 128
  const tctx = tmp.getContext('2d', { willReadFrequently: true })
  tctx.drawImage(img, 0, 0, 128, 128)
  const data = tctx.getImageData(0, 0, 128, 128)
  for (let i = 0; i < data.data.length; i += 4) {
    const a = data.data[i + 3]
    data.data[i] = data.data[i + 1] = data.data[i + 2] = a
    data.data[i + 3] = 255
  }
  tctx.putImageData(data, 0, 0)
  ctx.drawImage(tmp, 128, 0)
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
toggle('wire', () => wireframe, (v) => { wireframe = v })
toggle('spin', () => controls.autoRotate, (v) => { controls.autoRotate = v })

document.getElementById('reset').addEventListener('click', () => {
  Object.assign(params, FERN_DEFAULTS, { alphaTest: 0.5, brightness: 2.0, seed: params.seed })
  for (const [key] of SLIDERS) {
    readouts[key].input.value = params[key]
    readouts[key].out.textContent =
      Number.isInteger(params[key]) ? params[key] : Number(params[key]).toFixed(2)
  }
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

let last = performance.now()
renderer.setAnimationLoop(() => {
  const now = performance.now()
  const dt = (now - last) / 1000
  last = now
  controls.update(dt)
  renderer.render(scene, camera)
})
