import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildVoxelPine, createVoxelFoliageMaterial, voxelGrow, voxelSpecies, VOXEL_PINE_DEFAULTS, VOXEL_SPECIES } from './props/tree-voxel.js'
import { buildTree, treeLod, resolveTree, TREE_SPECIES, TREE_DEFAULTS } from './props/tree.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-voxel.js -- an opaque voxel crown, judged against
// the alpha-tested card crown it would replace. Read that file's header for
// why; this one is the eyepiece.
//
// The bench answers three questions and is laid out as three view modes:
//
//   SINGLE     does one tree read as a pine at all, up close, orbitable.
//   LADDER     does it SURVIVE the ladder -- the same tree at six prefixes of
//              one voxel buffer, from every voxel to a thirty-second of them,
//              each inflated by sqrt(N/n). If rung 3 is a different plant from
//              rung 0, the whole prefix idea is dead.
//   COMPARE    voxels beside props/tree.js's cards, same height, same seed,
//              same light. The only comparison that matters.
//
// AND THE DISTANCES ARE THE HEADSET'S. A Quest 2 eye is 0.00086 rad per pixel,
// so a cell C pixels tall showing a tree at D metres is only honest at a
// vertical FOV of C * 0.00086. Judged at a desktop 45 degrees, everything here
// would look better than it will ever look on the device -- which is exactly
// the mistake that puts a crown on the headset and finds it boiling.
//
// ?shot=<mode> renders one frame, hides the chrome and stamps document.title
// so a headless capture knows the frame landed. &dist, &rung, &yaw, &seed,
// &sun, &w, &h steer it.
// ---------------------------------------------------------------------------

const QUEST_RAD_PER_PX = 0.00086

const qs = new URLSearchParams(location.search)
const SHOT = qs.get('shot')
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d)

// --- params ----------------------------------------------------------------

// texMix is the one knob here that is NOT a generator parameter: it drives a
// uniform, so it never rebuilds the tree.
function speciesParams(name) {
  const p = { ...voxelSpecies(name), seed: num('seed', 7), height: num('height', 9), texMix: num('tex', 0.75) }
  // Any generator knob is steerable from the query string too, so a headless
  // capture can compare two settings without editing a default.
  for (const k of Object.keys(VOXEL_PINE_DEFAULTS)) if (qs.has(k)) p[k] = num(k, p[k])
  return p
}

let species = qs.get('species') || 'pine'
let params = speciesParams(species)

// Six rungs, each half the voxels of the one below it. The ladder is a prefix
// of one buffer, so these are draw ranges and a uniform -- nothing rebakes.
const RUNG_FRACTION = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32]

// --- stage -----------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.autoClear = false
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const SKY = new THREE.Color(0x0a1018)
scene.background = SKY
scene.fog = new THREE.Fog(SKY, 40, 260)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000)
camera.position.set(7, 5, 11)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 0.6
const VIEW_FOV = 45

/**
 * Put the whole tree in the middle of the frame, orbiting about its trunk.
 *
 * ONCE THE VIEW IS YOURS IT STAYS YOURS. A rebuild calls this on every slider
 * drag, and re-aiming there would fight the mouse: you centre on a limb, nudge
 * a knob, and the tree jumps back. So after any interaction this returns
 * immediately and only the `recentre` button (or a fresh page) reframes.
 */
function frameTree(recentre = false) {
  if (controls.userHasMoved && !recentre) return
  const st = voxelTree && voxelTree.stats
  const h = st ? st.height : params.height
  const R = st ? st.crownRadius : h * 0.25

  // THE ORIGIN, like every other gen-* bench. The tree is grown about x=z=0 and
  // the trunk only wanders trunkKink off it, so aiming at the axis buys nothing
  // and putting the camera anywhere but ON that vertical line is what tips the
  // trunk off centre. Half way up, so the bare stem below the crown is in frame.
  const mid = h * 0.5
  controls.target.set(0, mid, 0)

  // Back off far enough for the full height AND the full crown width to fit at
  // THIS viewport's shape. A fixed multiple of the height frames the tree
  // correctly at exactly one window size and crops it at every other.
  camera.fov = VIEW_FOV
  const aspect = Math.max(0.2, stage.clientWidth / Math.max(1, stage.clientHeight))
  const tanV = Math.tan(THREE.MathUtils.degToRad(VIEW_FOV) / 2)
  const dist = Math.max((h * 0.60) / tanV, (R * 1.15) / (tanV * aspect))
  camera.position.set(0, mid + h * 0.10, dist)
  camera.updateProjectionMatrix()
  controls.maxDistance = h * 8
  controls.userHasMoved = false
  controls.update()
}
controls.addEventListener('start', () => { controls.userHasMoved = true })

// The sun the voxel material is lit by is a uniform, not a light -- but the
// card tree next to it is a real Lambert mesh, so both have to agree or the
// comparison is a lighting comparison.
const SUN_DIR = new THREE.Vector3(0.44, 0.74, 0.30).normalize()
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.copy(SUN_DIR).multiplyScalar(20)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const groundTex = grassTexture(renderer)
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping
groundTex.repeat.set(200, 200)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

// The 1.7 m rule box every gen-* bench carries, so a height claim is checkable
// by eye instead of by slider.
const human = new THREE.Mesh(
  new THREE.BoxGeometry(0.45, 1.7, 0.28),
  new THREE.MeshLambertMaterial({ color: 0x4a7fbf, fog: false })
)
human.position.set(-2.6, 0.85, 0)
scene.add(human)

// --- materials -------------------------------------------------------------

const atlas = buildTextureArray()
// Two bark materials on purpose. The voxel tree asks for vertexColors so a limb
// buried in the canopy can be darkened toward the foliage's own light -- without
// it the tubes read as bright sticks laid over a dark crown and the eye finds
// every one. tree.js geometry carries no colour attribute, so the same material
// would render the reference tree black.
const barkMaterial = createPropMaterial(atlas)
const voxelBarkMaterial = createPropMaterial(atlas, { vertexColors: true })
for (const [m, key] of [[barkMaterial, 'gen-tree-v3-wrap-v1'], [voxelBarkMaterial, 'gen-tree-v3-wrap-vc-v1']]) {
  const patch = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => { patch(shader, r); wrapLambert(shader) }
  m.customProgramCacheKey = () => key
}
loadImageLayers(atlas)

const foliageMaterial = createVoxelFoliageMaterial()

// THE LEAF TILE, one per species: a hi-res cut of real leaves stamped over
// itself on a torus until nothing is transparent, then downressed once to
// 128px -- see tools/trees/solidify-leaves.mjs. Solid is the point: a leaf
// triangle can wear leaf ART without an alpha test, and the alpha test is what
// would cost the draw its low-resolution-Z and with it the fill advantage.
//
// It is loaded on its own rather than through the layer atlas because it is
// sampled with REPEAT wrapping at a random offset per leaf, and the atlas is a
// clamped array every other layer relies on.
const texLoader = new THREE.TextureLoader()
let needleTex = null

/** Hang a species' solid leaf mat on the crown, and measure its own mean. */
function setNeedleTile(url) {
  const old = needleTex
  needleTex = texLoader.load(url, (t) => {
    // The tile's own mean, so the shader can divide by it and the image reads
    // as grain over the tuned palette rather than as a repaint. Measured off
    // the decoded pixels, not guessed.
    const n = t.image.width
    const cv = document.createElement('canvas')
    cv.width = cv.height = n
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(t.image, 0, 0)
    const d = ctx.getImageData(0, 0, n, n).data
    // Averaged in LINEAR light, because that is what the sampler hands the
    // shader. Mean the sRGB bytes instead and the division is against a number
    // roughly twice too large, which drops the whole crown a stop and a half.
    const toLinear = (b) => {
      const c = b / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const sum = [0, 0, 0]
    for (let i = 0; i < d.length; i += 4) {
      sum[0] += toLinear(d[i]); sum[1] += toLinear(d[i + 1]); sum[2] += toLinear(d[i + 2])
    }
    const px = d.length / 4
    foliageMaterial.uniforms.uMapMean.value.set(
      Math.max(1e-4, sum[0] / px),
      Math.max(1e-4, sum[1] / px),
      Math.max(1e-4, sum[2] / px)
    )
    render()
  })
  needleTex.wrapS = needleTex.wrapT = THREE.RepeatWrapping
  needleTex.colorSpace = THREE.SRGBColorSpace
  needleTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  foliageMaterial.uniforms.uMap.value = needleTex
  if (old) old.dispose()
}
setNeedleTile(VOXEL_SPECIES[species].tile)
foliageMaterial.uniforms.uSun.value.copy(SUN_DIR)
foliageMaterial.uniforms.uFogColor.value.copy(SKY)

// --- the voxel tree --------------------------------------------------------

let voxelTree = null      // { group, geo, stats }
let cardTree = null       // { group, geo, tris }

function buildVoxel() {
  if (voxelTree) {
    scene.remove(voxelTree.group)
    voxelTree.geo.dispose()
  }
  foliageMaterial.uniforms.uMapMix.value = params.texMix
  const { geometry, stats } = buildVoxelPine(params, VOXEL_SPECIES[species].barkLayer)
  const group = new THREE.Group()
  // ONE geometry, TWO materials by group range, because the wood wants the
  // bark texture and the crown wants none. In the forest these merge into the
  // single prop material keyed on texLayer, the way every other prop does; the
  // split here is so the bench can tune the crown's shader without touching
  // the one the rest of the world compiles.
  geometry.clearGroups()
  geometry.addGroup(0, stats.woodIndices, 0)
  geometry.addGroup(stats.woodIndices, geometry.index.count - stats.woodIndices, 1)
  const mesh = new THREE.Mesh(geometry, [voxelBarkMaterial, foliageMaterial])
  mesh.frustumCulled = false
  group.add(mesh)
  scene.add(group)
  voxelTree = { group, geo: geometry, stats, mesh }
  return voxelTree
}

/**
 * Put the tree on a rung. The prefix is a draw range over the wood plus the n
 * highest-ranked voxels; the survivors then inflate by sqrt(N/n) so the crown
 * holds the coverage the dropped ones were carrying.
 *
 * The group ranges have to move with it: three.js draws each group as its own
 * range, so trimming the foliage group's count is the trim.
 */
function setRung(rungIndex) {
  const { geo, stats } = voxelTree
  const n = Math.max(1, Math.round(stats.voxels * RUNG_FRACTION[rungIndex]))
  // The limbs ride the same ladder. They are emitted longest-first behind the
  // trunk, all with the same index count, so a rung is a branch count -- held
  // above the foliage's own fraction because a limb that vanishes under a crown
  // that has itself thinned leaves a hole where the tree's structure was.
  const b = Math.round(stats.branchCount * Math.min(1, RUNG_FRACTION[rungIndex] * 2.2))
  const woodIndices = stats.trunkIndices + b * stats.perBranchIndices
  // Only the wood group's COUNT moves. The foliage group's start stays pinned
  // to the full wood range: the dropped limbs are simply a gap nothing draws.
  geo.groups[0].count = woodIndices
  geo.groups[1].count = n * 3    // ONE triangle per leaf, three indices
  foliageMaterial.uniforms.uGrow.value = voxelGrow(stats.voxels, n)
  foliageMaterial.uniforms.uVoxelCount.value = 1e9
  return { n, tris: woodIndices / 3 + n, grow: foliageMaterial.uniforms.uGrow.value }
}

// --- the card tree it has to beat ------------------------------------------

function buildCard() {
  if (cardTree) { scene.remove(cardTree.group); cardTree.geo.dispose() }
  const sp = TREE_SPECIES[species]
  const base = treeLod({
    ...TREE_DEFAULTS, ...sp.params,
    barkLayer: sp.barkLayer, leafLayer: sp.leafLayer,
    height: params.height, seed: params.seed,
  }, 0)
  const geo = buildTree(base)
  const mesh = new THREE.Mesh(geo, barkMaterial)
  mesh.frustumCulled = false
  const group = new THREE.Group()
  group.add(mesh)
  scene.add(group)
  cardTree = { group, geo, mesh, tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3, res: resolveTree(base) }
  // The whole card ladder, because the voxel ladder has to be judged against
  // what tree.js actually draws at each band, not against its LOD0.
  // Only 0 and 1: past LOD1 tree.js swaps to a spun impostor triangle, which
  // is the real competition in the far bands and no voxel rung can touch it.
  cardTree.ladder = [0, 1].map((l) => {
    const g = buildTree(treeLod({ ...TREE_DEFAULTS, ...sp.params,
      barkLayer: sp.barkLayer, leafLayer: sp.leafLayer,
      height: params.height, seed: params.seed }, l))
    const t = g.index ? g.index.count / 3 : g.attributes.position.count / 3
    g.dispose()
    return t
  })
  return cardTree
}

buildVoxel()
buildCard()

// --- the measurement the whole idea turns on --------------------------------
//
// FILL, COUNTED, not argued about. Every claim in tree-voxel.js's header is a
// claim about how many fragments a crown rasterises per pixel of the crown, so
// the bench counts them instead of asserting them: draw the tree with additive
// blending, depth test off, and a shader that emits exactly 1/255 -- the red
// byte that comes back IS the number of fragments that landed on that pixel.
//
// The card tree is counted the same way and WITHOUT its alpha test, which is
// the honest comparison: on a tiled Adreno an alpha-tested fragment is shaded
// and textured before the `discard` throws it away, so a card's cost is every
// fragment it rasterises, not the 25% it keeps.
const COUNT_RT = new THREE.WebGLRenderTarget(512, 512, {
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
})
const countMaterial = new THREE.ShaderMaterial({
  uniforms: { uGrow: { value: 1 } },
  vertexShader: `
    attribute vec4 aCentre;
    uniform float uGrow;
    void main() {
      // Same inflate the real material applies, so a rung is counted at the
      // size it is actually drawn. The prefix itself comes from the geometry
      // group range, which this render inherits untouched.
      vec3 p = aCentre.xyz + (position - aCentre.xyz) * uGrow;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0 / 255.0, 0.0, 0.0, 1.0); }',
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
  transparent: true,
})
// THE SECOND NUMBER, AND IT IS THE ONE THAT DECIDES THIS. Same count with the
// depth test and depth write left ON: a fragment only lands if nothing nearer
// has already been drawn, which is exactly what early-Z and low-resolution-Z
// do for an OPAQUE draw. The gap between the two numbers is the work the depth
// buffer throws away for free.
//
// An alpha-tested crown gets NONE of that saving -- it cannot write depth
// before it knows the texel, and per props/grass-blades.js its `discard` turns
// LRZ off for the whole draw. So for the cards the honest figure is the
// undepthed one, and for the voxels it is this one. That is the entire trade,
// in two measurements.
const shadedMaterial = new THREE.ShaderMaterial({
  uniforms: countMaterial.uniforms,
  vertexShader: countMaterial.vertexShader,
  fragmentShader: countMaterial.fragmentShader,
  blending: THREE.AdditiveBlending,
  depthTest: true,
  depthWrite: true,
  transparent: true,
})
// The same program without the blend, to get the silhouette the count is
// divided by. A ratio against the whole viewport would just measure framing.
const maskMaterial = new THREE.ShaderMaterial({
  uniforms: countMaterial.uniforms,
  vertexShader: countMaterial.vertexShader,
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }',
})

function measureFill(mesh, dist, yaw, grow) {
  const wasGround = ground.visible, wasHuman = human.visible, wasFog = scene.fog
  const wasVox = voxelTree.group.visible, wasCard = cardTree.group.visible
  const bg = scene.background
  const swapped = mesh.material
  const multi = Array.isArray(swapped)
  ground.visible = human.visible = false
  voxelTree.group.visible = mesh === voxelTree.mesh
  cardTree.group.visible = mesh === cardTree.mesh
  scene.background = new THREE.Color(0x000000)
  scene.fog = null
  countMaterial.uniforms.uGrow.value = grow

  const px = COUNT_RT.width
  camera.aspect = 1
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((params.height * 0.62) / dist))
  camera.position.set(Math.sin(yaw) * dist, params.height * 0.48 + dist * 0.10, Math.cos(yaw) * dist)
  camera.lookAt(0, params.height * 0.48, 0)
  camera.updateProjectionMatrix()

  const buf = new Uint8Array(px * px * 4)
  const read = (mat) => {
    mesh.material = multi ? [mat, mat] : mat
    renderer.setRenderTarget(COUNT_RT)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, px, px)
    renderer.clear(true, true, true)
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(COUNT_RT, 0, 0, px, px, buf)
    renderer.setRenderTarget(null)
    let sum = 0, hit = 0
    for (let i = 0; i < buf.length; i += 4) { sum += buf[i]; if (buf[i] > 0) hit++ }
    return { sum, hit }
  }
  const counted = read(countMaterial)
  const shaded = read(shadedMaterial)
  const mask = read(maskMaterial)

  mesh.material = swapped
  ground.visible = wasGround; human.visible = wasHuman
  voxelTree.group.visible = wasVox; cardTree.group.visible = wasCard
  scene.background = bg
  scene.fog = wasFog
  return {
    // Fragments rasterised per pixel the tree actually covers. The entire
    // proposal is that this number comes down.
    perPixel: counted.sum / Math.max(1, mask.hit),
    shadedPerPixel: shaded.sum / Math.max(1, mask.hit),
    silhouettePx: mask.hit,
    coverPct: 100 * mask.hit / (px * px),
  }
}

// --- view modes ------------------------------------------------------------

let mode = qs.get('shot') || 'single'
let rung = Math.round(num('rung', 0))
let showCard = false

const labels = document.getElementById('labels')
function label(text, x, y, w) {
  const d = document.createElement('div')
  d.className = 'cell-label'
  d.textContent = text
  d.style.left = `${x}px`
  d.style.top = `${y}px`
  d.style.width = `${w}px`
  labels.appendChild(d)
  return d
}

/**
 * Frame a cell on a tree at `dist` metres, at the headset's angular scale.
 *
 * This is the honest bit. A cell `hPx` pixels tall standing in for a Quest 2
 * eye subtends hPx * 0.00086 radians, and a 9 m tree at 24 m fills 0.375 rad
 * of that no matter how many pixels the desktop has. Framing to fit the tree
 * instead would show a 400-pixel-tall crown where the headset draws 44.
 */
function frameCell(wPx, hPx, dist, yaw, quest) {
  const h = params.height
  camera.aspect = wPx / hPx
  if (quest) {
    camera.fov = THREE.MathUtils.radToDeg(hPx * QUEST_RAD_PER_PX)
  } else {
    // Desktop framing: fit the tree with a margin, unless ?fov= pins one --
    // which is the only way to get a genuine close-up out of a mode that
    // otherwise re-frames the whole tree at every distance.
    const pinned = num('fov', null)
    camera.fov = pinned !== null ? pinned : THREE.MathUtils.radToDeg(2 * Math.atan((h * 0.62) / dist))
  }
  const y = h * 0.48
  camera.position.set(Math.sin(yaw) * dist, y + dist * 0.10, Math.cos(yaw) * dist)
  camera.lookAt(0, y, 0)
  camera.updateProjectionMatrix()
}

/**
 * CSS PIXELS, not device pixels. setViewport and setScissor both multiply by
 * the renderer's own pixel ratio before they touch GL, so scaling these by
 * devicePixelRatio squares it: on a retina screen the viewport comes out twice
 * the drawing buffer in each axis and the canvas shows one quarter of the
 * frame, which reads as a tree stuck against the right edge that will not
 * centre. Invisible at dpr 1, so it does not show up in a headless capture.
 */
function drawCell(x, y, w, h) {
  renderer.setViewport(x, y, w, h)
  renderer.setScissor(x, y, w, h)
  renderer.setScissorTest(true)
  renderer.render(scene, camera)
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight
  renderer.setSize(w, h, false)
}

let stats = { text: '' }

function render() {
  const W = stage.clientWidth, H = stage.clientHeight
  renderer.setScissorTest(false)
  renderer.clear()
  labels.innerHTML = ''

  const yaw = num('yaw', 0.6)
  const sunAz = num('sun', null)
  if (sunAz !== null) {
    SUN_DIR.set(Math.cos(sunAz) * 0.62, 0.62, Math.sin(sunAz) * 0.62).normalize()
    foliageMaterial.uniforms.uSun.value.copy(SUN_DIR)
    sun.position.copy(SUN_DIR).multiplyScalar(20)
  }

  // The page's OWN camera, one frame, so the load framing is checkable from a
  // headless capture. Every other shot mode overrides the camera to put a tree
  // at a stated distance, which is exactly what this one must not do.
  if (mode === 'view') {
    voxelTree.group.visible = true
    cardTree.group.visible = false
    human.visible = true
    const r = setRung(rung)
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    frameTree(true)
    drawCell(0, 0, W, H)
    label(`load framing -- rung ${rung}, ${r.tris | 0} tris`, 8, 8, 400)
  }

  if (mode === 'single' || mode === 'hero') {
    voxelTree.group.visible = true
    cardTree.group.visible = showCard
    cardTree.group.position.x = showCard ? 4.5 : 0
    human.visible = true
    const r = setRung(rung)
    if (SHOT) frameCell(W, H, num('dist', 14), yaw, false)
    else { camera.aspect = W / H; camera.fov = VIEW_FOV; camera.updateProjectionMatrix(); controls.update() }
    drawCell(0, 0, W, H)
    stats.text = `rung ${rung} · ${r.n} voxels · ${r.tris | 0} tris · grow ${r.grow.toFixed(2)}`
    if (SHOT) label(`rung ${rung} -- ${r.n} voxels, ${r.tris | 0} tris`, 8, 8, 400)
  }

  if (mode === 'ladder') {
    // Six rungs of ONE buffer, side by side, at one distance. If the shape
    // walks as the count drops, the prefix is not a LOD.
    voxelTree.group.visible = true
    cardTree.group.visible = false
    human.visible = false
    const n = RUNG_FRACTION.length
    const cw = Math.floor(W / n)
    const dist = num('dist', 9)
    const quest = num('quest', 0) > 0
    for (let i = 0; i < n; i++) {
      const r = setRung(i)
      frameCell(cw, H - 26, dist, yaw, quest)
      drawCell(i * cw, 0, cw, H - 26)
      label(`rung ${i} -- ${r.n} vox · ${r.tris | 0} tri · ×${r.grow.toFixed(2)}`, i * cw, H - 22, cw)
    }
    stats.text = `ladder @ ${dist} m${quest ? ' (Quest scale)' : ''}`
  }

  if (mode === 'dist') {
    // The same rung ladder the forest would actually use, each rung shown at
    // the distance it is meant to serve, all at the headset's angular scale.
    // This is the only picture that says whether a rung is CHEAP ENOUGH TO BE
    // INVISIBLE, which is the entire claim.
    voxelTree.group.visible = true
    cardTree.group.visible = false
    human.visible = false
    const bands = [[0, 6], [1, 12], [2, 20], [3, 32], [4, 55], [5, 90]]
    const cw = Math.floor(W / bands.length)
    for (let i = 0; i < bands.length; i++) {
      const [ri, d] = bands[i]
      const r = setRung(ri)
      frameCell(cw, H - 26, d, yaw, true)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${d} m -- rung ${ri} · ${r.n} vox · ${r.tris | 0} tri`, i * cw, H - 22, cw)
    }
    stats.text = 'distance ladder at Quest 2 angular scale'
  }

  if (mode === 'compare') {
    // Cards left, voxels right, same seed, same height, same sun, same frame.
    voxelTree.group.visible = true
    cardTree.group.visible = true
    const dists = [num('dist', 8), num('dist2', 18)]
    human.visible = false
    const cw = Math.floor(W / (dists.length * 2))
    const quest = num('quest', 0) > 0
    for (let i = 0; i < dists.length; i++) {
      const d = dists[i]
      const ri = d < 12 ? 0 : 2
      const r = setRung(ri)
      for (let k = 0; k < 2; k++) {
        // Move whichever tree is being shown onto the origin, so both are
        // framed identically instead of one being off-axis.
        const isVox = k === 1
        voxelTree.group.visible = isVox
        cardTree.group.visible = !isVox
        const x = (i * 2 + k) * cw
        frameCell(cw, H - 26, d, yaw, quest)
        drawCell(x, 0, cw, H - 26)
        label(isVox
          ? `voxel ${d} m -- ${r.n} vox · ${r.tris | 0} tri · opaque`
          : `cards ${d} m -- ${cardTree.tris} tri · alpha-test`, x, H - 22, cw)
      }
    }
    voxelTree.group.visible = true
    cardTree.group.visible = true
    stats.text = `compare · cards ${cardTree.tris} tris`
  }

  if (mode === 'dissolve') {
    // The rung crossing, which in the shipped forest is what a `discard` and
    // an IGN dither pay for. Here it is a uniform ramping voxels onto their
    // own centres, and the crown THINS instead of stippling.
    voxelTree.group.visible = true
    cardTree.group.visible = false
    human.visible = false
    const steps = 6
    const cw = Math.floor(W / steps)
    const r = setRung(0)
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      const keep = Math.round(voxelTree.stats.voxels * (1 - t * 0.94))
      foliageMaterial.uniforms.uVoxelCount.value = keep
      foliageMaterial.uniforms.uGrow.value = 1
      frameCell(cw, H - 26, num('dist', 9), yaw, false)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${keep} voxels`, i * cw, H - 22, cw)
    }
    foliageMaterial.uniforms.uVoxelCount.value = 1e9
    stats.text = 'dissolve by collapse, no discard'
  }

  if (mode === 'fill') {
    // Counts, then draws the count as a heat map so the picture and the number
    // come from the same render. Cards left, every rung of the voxel tree
    // after it.
    const yawF = num('yaw', 0.6)
    const dist = num('dist', 12)
    const rows = [['cards', measureFill(cardTree.mesh, dist, yawF, 1), cardTree.tris]]
    for (let i = 0; i < RUNG_FRACTION.length; i++) {
      const r = setRung(i)
      rows.push([`rung ${i}`, measureFill(voxelTree.mesh, dist, yawF, r.grow), r.tris])
    }
    const cw = Math.floor(W / rows.length)
    voxelTree.group.visible = true
    cardTree.group.visible = false
    human.visible = false
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) setRung(i - 1)
      voxelTree.group.visible = i > 0
      cardTree.group.visible = i === 0
      frameCell(cw, H - 26, dist, yawF, false)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${rows[i][0]} · ${rows[i][2]} tri`, i * cw, H - 22, cw)
    }
    // The table goes IN the picture. A headless capture exits the moment the
    // shot lands and drops whatever is still sitting in the stderr buffer, so
    // a console.log of these numbers is a coin flip.
    const table = label([`fill at ${dist} m, per pixel of the tree's own silhouette`,
      '          rasterised   after early-Z     tris   silhouette',
      ...rows.map(([name, m, tris]) =>
        `  ${name.padEnd(7)}${m.perPixel.toFixed(2).padStart(8)}${m.shadedPerPixel.toFixed(2).padStart(14)}${String(tris).padStart(9)}${String(m.silhouettePx).padStart(9)} px`),
    ].join('\n'), 8, 8, 470)
    table.style.whiteSpace = 'pre'
    table.style.textAlign = 'left'
    table.style.font = '11px ui-monospace, Menlo, monospace'
    voxelTree.group.visible = true
    cardTree.group.visible = true
    stats.text = `fill @ ${dist} m -- see console`
  }

  renderer.setScissorTest(false)
  const el = document.getElementById('stats')
  if (el) el.textContent = stats.text
}

// --- panel -----------------------------------------------------------------

const SLIDERS = [
  ['height', 3, 22, 0.5, 'metres, root to tip'],
  ['branchCount', 8, 80, 1, 'TOTAL branches, irregularly spaced -- not whorls'],
  ['branchJitter', 0, 1.2, 0.02, 'how far off its slot a branch may slide'],
  ['branchLength', 0.14, 0.55, 0.01, 'longest branch as a fraction of height'],
  ['crownFullness', 0.5, 2.5, 0.05, 'how fast branches shorten toward the leader; >1 pointier'],
  ['branchDroop', 0, 1.4, 0.02, 'total bend from launch to tip'],
  ['trunkKink', 0, 0.05, 0.002, 'how crooked the trunk is allowed to walk'],
  ['subMax', 0, 4, 1, 'sub-branches per limb, at 3 triangles each'],
  ['subLength', 0.15, 0.9, 0.02, 'sub-branch length as a fraction of its parent'],
  ['subAngle', 0.2, 1.6, 0.04, 'radians it leaves the parent at, out to the side'],
  ['leaves', 4, 45, 1, 'leaves PER METRE of twig -- limbs and sub-branches alike'],
  ['texMix', 0, 1, 0.05, 'how much of the solid needle tile shows through the vertex palette'],
  ['leafPatch', 0.15, 1.5, 0.05, 'how much of that tile one leaf covers'],
  ['leafStemMin', 15, 90, 1, 'degrees at the leaf\'s STEM corner -- narrow is a needle dart, wide is a broadleaf blade'],
  ['leafStemMax', 15, 90, 1, 'and the top of that band'],
  ['leafSideMin', 1, 2, 0.02, 'the leaf\'s long flank as a multiple of its short one -- 1 is isoceles'],
  ['leafSideMax', 1, 2, 0.02, 'and the top of that band'],
  ['normalRound', 0, 5, 0.1, 'how far each vertex\'s crown normal is pushed off the leaf\'s mean -- 0 is flat-lit, higher sweeps the light across each leaf'],
  ['barkTile', 0.15, 1.6, 0.05, 'metres of bark per tile, the same around as along'],
  ['voxelSize', 0.03, 0.2, 0.005, 'METRES, the MINIMUM leaf'],
  ['voxelLong', 1, 8, 0.1, 'leaf LENGTH = voxelSize x this'],
  ['voxelVary', 1, 3, 0.05, 'random size, 1x up to this and no further'],
  ['leafFloor', 0.2, 1, 0.02, 'shortest leaf as a fraction of the longest one the crown actually grew'],
  ['voxelOut', 0, 1, 0.02, '0 = the leaf continues the twig, 1 = straight out its side'],
  ['voxelRise', -0.4, 0.6, 0.02, 'and tilted up off the twig'],
  ['voxelRoll', 0, 3.2, 0.05, 'radians the roll around the twig may stray'],
  ['leafSpin', 0, 1, 0.02, 'half-turns a leaf plate may face about its own stem axis'],
  ['leafOpen', 0, 1, 0.02, 'how hard each leaf turns toward open space -- 0 is a random spray'],
  ['leafOpenUp', 0, 1, 0.02, '0 seeks openness in any direction, 1 seeks the sky (phototropism)'],
  ['leafOpenJitter', 0, 1.6, 0.02, 'radians of slop on that answer -- high is back to a random spray'],
  ['fringeAt', 0.4, 1, 0.02, 'r/R past which a leaf is on the frayed rim'],
  ['fringeShrink', 0.1, 1, 0.02, 'how much smaller those rim leaves get'],
  ['depthShade', 0, 1, 0.02, 'the crown\'s value structure, in one number'],
  ['normalBlend', 0, 1, 0.02, '0 = shade by the crown, 1 = shade by the plate (chips)'],
  ['normalTilt', 0, 1.6, 0.04, 'how far the crown normal tips up off radial'],
  ['aoRadius', 0.15, 1.4, 0.02, 'metres a neighbour has to be inside to shade a leaf'],
  ['aoStrength', 0, 3, 0.05, 'foliage shadowing foliage -- the canopy\'s real darks'],
  ['aoFloor', 0, 0.6, 0.02, 'how dark a buried leaf is ever allowed to get'],
  ['hueVary', 0, 0.4, 0.01, 'per-leaf colour roll'],
  ['seed', 1, 40, 1, ''],
]

const SHADER_SLIDERS = [
  ['uWrap', 0, 1, 0.02, 'diffuse wrap -- keeps a crown normal past the horizon off black'],
  ['uTransmit', 0, 2, 0.05, 'backlit rim glow, the thing a cutout is usually reached for'],
  ['uTransmitPower', 1, 12, 0.5, 'how tight that lobe is'],
  ['uAmbient', 0, 1.4, 0.02, 'hemisphere fill'],
  ['uSunStrength', 0, 3.5, 0.05, ''],
]

/**
 * Everything the mouse can touch, in one column: species at the top, the
 * generator's knobs in the middle, the view buttons at the bottom.
 *
 * Rebuilt wholesale on a species change, because every slider's POSITION is a
 * species parameter -- an oak's stem angle is not a pine's, and leaving the
 * handles where the last species put them makes the panel lie.
 */
function buildPanel() {
  const panel = document.getElementById('panel')
  if (!panel) return
  panel.innerHTML = ''

  const h0 = document.createElement('div'); h0.className = 'head'; h0.textContent = 'species'
  panel.appendChild(h0)
  const sel = document.createElement('select')
  sel.className = 'species'
  for (const [k, sp] of Object.entries(VOXEL_SPECIES)) {
    const o = document.createElement('option')
    o.value = k; o.textContent = sp.label
    sel.appendChild(o)
  }
  sel.value = species
  sel.onchange = () => setSpecies(sel.value)
  panel.appendChild(sel)

  const addRow = (name, min, max, step, hint, get, set) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.title = hint
    const lab = document.createElement('label'); lab.textContent = name
    const inp = document.createElement('input')
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = get()
    const val = document.createElement('span'); val.className = 'val'; val.textContent = get()
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value)
      val.textContent = step >= 1 ? v : v.toFixed(3)
      set(v)
      render()
    })
    row.append(lab, inp, val)
    panel.appendChild(row)
  }
  const h1 = document.createElement('div'); h1.className = 'head'; h1.textContent = 'crown'
  panel.appendChild(h1)
  for (const [k, min, max, step, hint] of SLIDERS) {
    addRow(k, min, max, step, hint, () => params[k], (v) => { params[k] = v; buildVoxel(); buildCard(); frameTree() })
  }
  const h2 = document.createElement('div'); h2.className = 'head'; h2.textContent = 'shading'
  panel.appendChild(h2)
  for (const [k, min, max, step, hint] of SHADER_SLIDERS) {
    addRow(k, min, max, step, hint, () => foliageMaterial.uniforms[k].value,
      (v) => { foliageMaterial.uniforms[k].value = v })
  }

  const h3 = document.createElement('div'); h3.className = 'head'; h3.textContent = 'view'
  panel.appendChild(h3)
  const bar = document.createElement('div'); bar.className = 'buttons'
  panel.appendChild(bar)
  const addButton = (text, fn) => {
    const b = document.createElement('button')
    b.textContent = text
    b.onclick = fn
    bar.appendChild(b)
  }
  for (const m of ['single', 'ladder', 'dist', 'compare', 'dissolve', 'fill']) {
    // Every other mode drives the camera itself, per cell. Coming back to a
    // single tree without re-aiming leaves the pivot wherever the last grid
    // put it, which is the other way this view ends up orbiting nothing.
    addButton(m, () => { mode = m; frameTree(); render() })
  }
  addButton('recentre', () => { frameTree(true); render() })
  addButton('cards side-by-side', () => { showCard = !showCard; render() })
  for (let i = 0; i < RUNG_FRACTION.length; i++) addButton(`r${i}`, () => { rung = i; render() })
}

/**
 * Swap the whole plant: parameters, bark layer, leaf mat, and the tree.js card
 * tree it is measured against. Seed, height and texMix ride across, because
 * they are the BENCH's controls rather than the species', and two species are
 * only comparable if those hold still.
 */
function setSpecies(name) {
  const keep = { seed: params.seed, height: params.height, texMix: params.texMix }
  species = name
  params = { ...speciesParams(name), ...keep }
  setNeedleTile(VOXEL_SPECIES[name].tile)
  buildVoxel()
  buildCard()
  buildPanel()
  frameTree(true)
  render()
}

// --- run -------------------------------------------------------------------

// In shot mode the window IS the frame -- the capture's --window-size sets the
// pixel count, so nothing here second-guesses it. &chrome=1 keeps the panel,
// which is the only way a capture can check the framing against the stage the
// live page actually has rather than against the whole window.
if (SHOT && !qs.has('chrome')) document.body.classList.add('shot')
buildPanel()
resize()
// AFTER resize, because the framing is solved against the viewport's real
// aspect and stage.clientWidth is not that until the layout has run.
frameTree()
addEventListener('resize', () => { resize(); frameTree(); render() })

if (SHOT) {
  // One frame after the atlas has had a chance to land, then a title stamp so
  // a headless capture is looking at a finished picture rather than a race.
  loadImageLayers(atlas).then(() => {
    resize()
    render()
    requestAnimationFrame(() => { render(); document.title = 'READY' })
  })
} else {
  const loop = () => { controls.update(); render(); requestAnimationFrame(loop) }
  loop()
}

// The panel narrates itself; the console carries the numbers a screenshot
// cannot: what one tree costs at each rung.
console.log('[gen-tree-v3]', JSON.stringify({
  voxels: voxelTree.stats.voxels,
  branches: voxelTree.stats.branches,
  crownR: +voxelTree.stats.crownRadius.toFixed(2),
  silhouette: +voxelTree.stats.silhouette.toFixed(1),
  coverage: +voxelTree.stats.coverage.toFixed(1),
  layers: +voxelTree.stats.layers.toFixed(2),
  leafAngle: voxelTree.stats.leafAngle,
  leafShortest: voxelTree.stats.leafShortest,
  woodTris: voxelTree.stats.woodTris,
  tris: voxelTree.stats.tris,
}))
// Through setRung, so the count here is the one that would actually be drawn:
// the wood rides the ladder too and a hand-rolled formula would miss it.
const ladderLog = RUNG_FRACTION.map((_, i) => {
  const r = setRung(i)
  return `  rung ${i}: ${r.n} voxels, ${r.tris} tris, grow ${r.grow.toFixed(2)}`
})
setRung(0)
console.log([...ladderLog,
  `  cards (tree.js pine) LOD0/LOD1: ${cardTree.ladder.join(' / ')} tris, ${cardTree.res.sprays} sprays at LOD0`,
  '  past LOD1 tree.js draws a spun impostor triangle, not a mesh',
].join(' | '))
