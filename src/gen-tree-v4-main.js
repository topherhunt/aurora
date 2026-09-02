import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { buildCloakPine, createCloakFoliageMaterial, cloakSpecies, CLOAK_PINE_DEFAULTS, CLOAK_SPECIES } from './props/tree-cloak.js'
import { buildVoxelPine, createVoxelFoliageMaterial, voxelSpecies, VOXEL_SPECIES } from './props/tree-voxel.js'
import { buildTree, treeLod, TREE_SPECIES, TREE_DEFAULTS } from './props/tree.js'
import { buildTextureArray, loadImageLayers, LAYER } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-cloak.js -- a pine whose foliage is one wide
// rumpled sheet per branch rather than a spray of leaf triangles. Read that
// file's header for what it is; this one is the eyepiece.
//
// THE LIGHT IS /gen-tree's, to the number: the same 2.1 sun off (3, 5, 2), the
// same 0.85 hemisphere, the same fog, and a crown material that undoes three's
// back-face normal flip exactly the way createPropMaterial does for a leaf
// card. The needle palette is measured off the tile /gen-tree's own cards wear,
// so the two crowns average to the same colour. The only thing on trial here is
// the SHAPE.
//
// THREE TREES, ONE FRAME, and the comparison is the whole point: the cloak, the
// voxel crown of /gen-tree-v3, and the alpha-tested cards of props/tree.js,
// same seed, same height, same sun. Modes:
//
//   SINGLE     does one tree read as a pine at all, up close, orbitable.
//   COMPARE    the three side by side, at a stated distance.
//   DIST       the cloak alone at six distances, at the headset's angular scale.
//   FILL       fragments rasterised per silhouette pixel, counted not argued.
//
// AND THE DISTANCES ARE THE HEADSET'S. A Quest 2 eye is 0.00086 rad per pixel,
// so a cell C pixels tall showing a tree at D metres is only honest at a
// vertical FOV of C * 0.00086. Judged at a desktop 45 degrees, everything here
// looks better than it will on the device.
//
// ?shot=<mode> renders one frame, hides the chrome and stamps document.title so
// a headless capture knows the frame landed. &dist, &yaw, &seed, &sun steer it.
// ---------------------------------------------------------------------------

const QUEST_RAD_PER_PX = 0.00086

const qs = new URLSearchParams(location.search)
const SHOT = qs.get('shot')
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d)

// --- params ----------------------------------------------------------------

// texMix is the one knob here that is NOT a generator parameter: it drives a
// uniform, so it never rebuilds the tree.
function speciesParams(name) {
  const p = { ...cloakSpecies(name), seed: num('seed', 7), height: num('height', 9), texMix: num('tex', 0.75) }
  for (const k of Object.keys(CLOAK_PINE_DEFAULTS)) if (qs.has(k)) p[k] = num(k, p[k])
  return p
}

let species = qs.get('species') || 'pine'
let params = speciesParams(species)

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
scene.fog = new THREE.Fog(SKY, 40, 200)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 3000)
camera.position.set(7, 5, 11)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 0.6
const VIEW_FOV = 45

/**
 * Put the whole tree in the middle of the frame, orbiting about its trunk.
 * ONCE THE VIEW IS YOURS IT STAYS YOURS: a rebuild calls this on every slider
 * drag, so after any interaction it returns immediately and only `recentre`
 * reframes.
 */
function frameTree(recentre = false) {
  if (controls.userHasMoved && !recentre) return
  const st = cloakTree && cloakTree.stats
  const h = st ? st.height : params.height
  const R = st ? st.crownRadius : h * 0.25
  const mid = h * 0.5
  controls.target.set(0, mid, 0)
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

// /gen-tree's noon, which is also props.html's and the fern bench's. The v3
// voxel crown is lit by a uniform rather than by a light, so its sun has to be
// handed this same direction -- otherwise the comparison is a lighting one.
const SUN_DIR = new THREE.Vector3(3, 5, 2).normalize()
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.copy(SUN_DIR).multiplyScalar(20)
scene.add(sun)
const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85)
scene.add(hemi)

const groundTex = grassTexture(renderer)
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping
groundTex.repeat.set(200, 200)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshLambertMaterial({ map: groundTex })
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

// The 1.7 m rule box every gen-* bench carries.
const human = new THREE.Mesh(
  new THREE.BoxGeometry(0.45, 1.7, 0.28),
  new THREE.MeshLambertMaterial({ color: 0x4a7fbf, fog: false })
)
human.position.set(-2.6, 0.85, 0)
scene.add(human)

// --- materials -------------------------------------------------------------

const atlas = buildTextureArray()
// Two bark materials on purpose: the voxel tree asks for vertexColors so its
// limbs can be darkened toward the canopy's own light, and tree.js geometry
// carries no colour attribute, so the same material would render the reference
// tree black. The cloak tree's wood rides the vertex-colour one.
const barkMaterial = createPropMaterial(atlas)
const vcBarkMaterial = createPropMaterial(atlas, { vertexColors: true })
for (const [m, key] of [[barkMaterial, 'gen-tree-v4-wrap-v1'], [vcBarkMaterial, 'gen-tree-v4-wrap-vc-v1']]) {
  const patch = m.onBeforeCompile
  m.onBeforeCompile = (shader, r) => { patch(shader, r); wrapLambert(shader) }
  m.customProgramCacheKey = () => key
}
loadImageLayers(atlas)

// The crown is a stock Lambert lit by the scene's own sun and sky, with the
// same wrap patch every other bench's foliage wears -- so what is on screen
// here is the shading /gen-rock, /gen-fern and /gen-tree are judged under.
const cloakMaterial = createCloakFoliageMaterial()
{
  const patch = cloakMaterial.onBeforeCompile
  cloakMaterial.onBeforeCompile = (shader, r) => { patch(shader, r); wrapLambert(shader) }
  cloakMaterial.customProgramCacheKey = () => 'gen-tree-v4-foliage-wrap-v2'
}
// White wireframe over the black stage, for reading the topology rather than
// the shading. Swapped onto the meshes wholesale, so it covers the trunk too.
const wireMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, fog: false, side: THREE.DoubleSide })
let wireframe = false

/**
 * Put the wireframe on or take it off, on whichever trees exist. Every rebuild
 * makes a fresh mesh, so this has to run again after each one -- the shaded
 * material set is parked on the mesh rather than reconstructed here.
 */
function applyWireframe() {
  for (const t of [cloakTree, voxelTree, cardTree]) {
    if (!t) continue
    const shaded = t.mesh.userData.shaded
    t.mesh.material = wireframe
      ? (Array.isArray(shaded) ? shaded.map(() => wireMaterial) : wireMaterial)
      : shaded
  }
}
const voxelMaterial = createVoxelFoliageMaterial()

// THE LEAF TILE: a hi-res cut of real needles stamped over itself until nothing
// is transparent, then downressed -- see tools/trees/solidify-leaves.mjs. Solid
// is the point: foliage can wear leaf ART without an alpha test, and the alpha
// test is what would cost the draw its low-resolution-Z. Loaded on its own
// rather than through the layer atlas because it is sampled with REPEAT
// wrapping, and the atlas is a clamped array every other layer relies on.
const texLoader = new THREE.TextureLoader()
let needleTex = null

/** Hang the species' solid needle mat on both crowns, and measure its mean. */
function setNeedleTile(url) {
  const old = needleTex
  needleTex = texLoader.load(url, (t) => {
    // The tile's own mean, so the shader can divide by it and the image reads
    // as grain over the tuned palette rather than as a repaint. Averaged in
    // LINEAR light, because that is what the sampler hands the shader.
    const n = t.image.width
    const cv = document.createElement('canvas')
    cv.width = cv.height = n
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(t.image, 0, 0)
    const d = ctx.getImageData(0, 0, n, n).data
    const toLinear = (b) => {
      const c = b / 255
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const sum = [0, 0, 0]
    for (let i = 0; i < d.length; i += 4) {
      sum[0] += toLinear(d[i]); sum[1] += toLinear(d[i + 1]); sum[2] += toLinear(d[i + 2])
    }
    const px = d.length / 4
    for (const m of [cloakMaterial, voxelMaterial]) {
      m.uniforms.uMapMean.value.set(
        Math.max(1e-4, sum[0] / px),
        Math.max(1e-4, sum[1] / px),
        Math.max(1e-4, sum[2] / px)
      )
    }
    render()
  })
  needleTex.wrapS = needleTex.wrapT = THREE.RepeatWrapping
  needleTex.colorSpace = THREE.SRGBColorSpace
  needleTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  for (const m of [cloakMaterial, voxelMaterial]) m.uniforms.uMap.value = needleTex
  if (old) old.dispose()
}
setNeedleTile(CLOAK_SPECIES[species].tile)
// The voxel crown is lit by uniforms rather than by lights, so it has to be
// told where the sun and the fog are. The cloak crown reads both from the scene.
voxelMaterial.uniforms.uSun.value.copy(SUN_DIR)
voxelMaterial.uniforms.uFogColor.value.copy(SKY)

// --- the three trees --------------------------------------------------------

let cloakTree = null      // { group, geo, mesh, stats }
let voxelTree = null      // /gen-tree-v3's crown, for the shape comparison
let cardTree = null       // props/tree.js's cards, for the cost comparison

/**
 * One geometry, TWO materials by group range: the wood wants the bark texture
 * and the crown wants none. In the forest these would merge into the single
 * prop material keyed on texLayer, the way every other prop does; the split is
 * so the bench can tune the crown's shader alone.
 */
function twoGroupMesh(geometry, woodIndices, foliage) {
  geometry.clearGroups()
  geometry.addGroup(0, woodIndices, 0)
  geometry.addGroup(woodIndices, geometry.index.count - woodIndices, 1)
  const mesh = new THREE.Mesh(geometry, [vcBarkMaterial, foliage])
  mesh.userData.shaded = mesh.material
  mesh.frustumCulled = false
  const group = new THREE.Group()
  group.add(mesh)
  scene.add(group)
  return { group, geo: geometry, mesh }
}

function buildCloak() {
  if (cloakTree) { scene.remove(cloakTree.group); cloakTree.geo.dispose() }
  cloakMaterial.uniforms.uMapMix.value = params.texMix
  const { geometry, stats } = buildCloakPine(params, LAYER.BARK_PINE)
  cloakTree = { ...twoGroupMesh(geometry, stats.woodIndices, cloakMaterial), stats }
  applyWireframe()
  return cloakTree
}

// The voxel tree is the SHAPE this one has to beat, so it is built at its own
// tuned defaults and only the two bench controls -- seed and height -- ride
// across. Matching its generator knobs to the cloak's would compare two
// detunings of one tree rather than the two approaches.
function buildVoxel() {
  if (voxelTree) { scene.remove(voxelTree.group); voxelTree.geo.dispose() }
  voxelMaterial.uniforms.uMapMix.value = params.texMix
  const vp = { ...voxelSpecies(species), seed: params.seed, height: params.height }
  const { geometry, stats } = buildVoxelPine(vp, VOXEL_SPECIES[species].barkLayer)
  voxelTree = { ...twoGroupMesh(geometry, stats.woodIndices, voxelMaterial), stats }
  applyWireframe()
  return voxelTree
}

function buildCard() {
  if (cardTree) { scene.remove(cardTree.group); cardTree.geo.dispose() }
  const sp = TREE_SPECIES[species]
  const geo = buildTree(treeLod({
    ...TREE_DEFAULTS, ...sp.params,
    barkLayer: sp.barkLayer, leafLayer: sp.leafLayer,
    height: params.height, seed: params.seed,
  }, 0))
  const mesh = new THREE.Mesh(geo, barkMaterial)
  mesh.userData.shaded = mesh.material
  mesh.frustumCulled = false
  const group = new THREE.Group()
  group.add(mesh)
  scene.add(group)
  cardTree = { group, geo, mesh, tris: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3 }
  applyWireframe()
  return cardTree
}

buildCloak()
buildVoxel()
buildCard()

const TREES = () => [
  ['cloak v4', cloakTree, cloakTree.stats.tris, 'opaque, 2-sided'],
  ['voxel v3', voxelTree, voxelTree.stats.tris, 'opaque, 2-sided'],
  ['cards', cardTree, cardTree.tris, 'alpha-test'],
]
function showOnly(t) {
  cloakTree.group.visible = t === cloakTree
  voxelTree.group.visible = t === voxelTree
  cardTree.group.visible = t === cardTree
}

// --- the measurement the whole idea turns on --------------------------------
//
// FILL, COUNTED. Every claim about an opaque crown is a claim about how many
// fragments it rasterises per pixel of its own silhouette, so the bench counts
// them: draw with additive blending, depth test off, and a shader that emits
// exactly 1/255 -- the red byte that comes back IS the number of fragments that
// landed on that pixel.
//
// The cards are counted WITHOUT their alpha test, which is the honest
// comparison: on a tiled Adreno an alpha-tested fragment is shaded and textured
// before the `discard` throws it away.
const COUNT_RT = new THREE.WebGLRenderTarget(512, 512, {
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
})
const COUNT_VS = `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`
const countMaterial = new THREE.ShaderMaterial({
  vertexShader: COUNT_VS,
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0 / 255.0, 0.0, 0.0, 1.0); }',
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
  transparent: true,
  side: THREE.DoubleSide,
})
// THE SECOND NUMBER, AND IT IS THE ONE THAT DECIDES THIS. The same count with
// the depth test and depth write ON: a fragment only lands if nothing nearer
// has been drawn, which is what early-Z and low-resolution-Z do for an OPAQUE
// draw. The gap between the two is the work the depth buffer throws away for
// free -- and an alpha-tested crown gets NONE of it, since its `discard` turns
// LRZ off for the whole draw. So for the cards the honest figure is the
// undepthed one and for the other two it is this one.
const shadedMaterial = new THREE.ShaderMaterial({
  vertexShader: COUNT_VS,
  fragmentShader: countMaterial.fragmentShader,
  blending: THREE.AdditiveBlending,
  depthTest: true,
  depthWrite: true,
  transparent: true,
  side: THREE.DoubleSide,
})
// The same program without the blend, for the silhouette the count is divided
// by. A ratio against the whole viewport would just measure framing.
const maskMaterial = new THREE.ShaderMaterial({
  vertexShader: COUNT_VS,
  fragmentShader: 'void main() { gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0); }',
  side: THREE.DoubleSide,
})

function measureFill(tree, dist, yaw) {
  const mesh = tree.mesh
  const wasGround = ground.visible, wasHuman = human.visible, wasFog = scene.fog
  const was = [cloakTree.group.visible, voxelTree.group.visible, cardTree.group.visible]
  const bg = scene.background
  // The SHADED set, not whatever is on the mesh: with the wireframe on, the
  // count would otherwise cull the way a MeshBasicMaterial does.
  const swapped = mesh.userData.shaded
  const multi = Array.isArray(swapped)
  ground.visible = human.visible = false
  showOnly(tree)
  scene.background = new THREE.Color(0x000000)
  scene.fog = null

  const px = COUNT_RT.width
  camera.aspect = 1
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((params.height * 0.62) / dist))
  camera.position.set(Math.sin(yaw) * dist, params.height * 0.48 + dist * 0.10, Math.cos(yaw) * dist)
  camera.lookAt(0, params.height * 0.48, 0)
  camera.updateProjectionMatrix()

  // The count has to cull exactly what the real draw culls, or a two-sided
  // crown is charged for faces the GPU would have kept anyway.
  const countSide = (multi ? swapped[1] : swapped).side

  const buf = new Uint8Array(px * px * 4)
  const read = (mat) => {
    mat.side = countSide
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

  applyWireframe()
  ground.visible = wasGround; human.visible = wasHuman
  cloakTree.group.visible = was[0]; voxelTree.group.visible = was[1]; cardTree.group.visible = was[2]
  scene.background = bg
  scene.fog = wasFog
  return {
    perPixel: counted.sum / Math.max(1, mask.hit),
    shadedPerPixel: shaded.sum / Math.max(1, mask.hit),
    silhouettePx: mask.hit,
  }
}

// --- view modes ------------------------------------------------------------

let mode = qs.get('shot') || 'single'
let sideBySide = false

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
 * Frame a cell on a tree at `dist` metres, at the headset's angular scale when
 * `quest` is set: a cell hPx pixels tall standing in for a Quest 2 eye subtends
 * hPx * 0.00086 radians, and a 9 m tree at 24 m fills 0.375 rad of it no matter
 * how many pixels the desktop has.
 */
function frameCell(wPx, hPx, dist, yaw, quest) {
  const h = params.height
  camera.aspect = wPx / hPx
  if (quest) {
    camera.fov = THREE.MathUtils.radToDeg(hPx * QUEST_RAD_PER_PX)
  } else {
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
 * devicePixelRatio squares it and the canvas shows one quarter of the frame.
 */
function drawCell(x, y, w, h) {
  renderer.setViewport(x, y, w, h)
  renderer.setScissor(x, y, w, h)
  renderer.setScissorTest(true)
  renderer.render(scene, camera)
}

function resize() {
  renderer.setSize(stage.clientWidth, stage.clientHeight, false)
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
    voxelMaterial.uniforms.uSun.value.copy(SUN_DIR)
    sun.position.copy(SUN_DIR).multiplyScalar(20)
  }

  if (mode === 'single') {
    showOnly(cloakTree)
    // Side by side means BESIDE, not on top of: the other two step out along x
    // so one orbit reads all three.
    voxelTree.group.visible = cardTree.group.visible = sideBySide
    voxelTree.group.position.x = sideBySide ? 4.5 : 0
    cardTree.group.position.x = sideBySide ? 9.0 : 0
    human.visible = true
    if (SHOT) frameCell(W, H, num('dist', 14), yaw, false)
    else { camera.aspect = W / H; camera.fov = VIEW_FOV; camera.updateProjectionMatrix(); controls.update() }
    drawCell(0, 0, W, H)
    const st = cloakTree.stats
    stats.text = `cloak ${st.tris} tris (${st.woodTris} wood + ${st.foliageTris} foliage) · ${st.fronds} fronds @ ${st.perFrondTris} tri`
      + ` · ${st.spineVerts} spine verts · layers ${st.layers.toFixed(2)}`
      + `  |  voxel v3 ${voxelTree.stats.tris} · cards ${cardTree.tris}`
    if (SHOT) label(stats.text, 8, 8, 600)
  }

  if (mode === 'compare') {
    // The three approaches, same seed, same height, same sun, same frame. Each
    // is moved onto the origin in turn so none of them is judged off-axis.
    human.visible = false
    const rows = TREES()
    const cw = Math.floor(W / rows.length)
    const dist = num('dist', 10)
    const quest = num('quest', 0) > 0
    for (let i = 0; i < rows.length; i++) {
      const [name, tree, tris, how] = rows[i]
      showOnly(tree)
      frameCell(cw, H - 26, dist, yaw, quest)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${name} ${dist} m -- ${tris} tri · ${how}`, i * cw, H - 22, cw)
    }
    cloakTree.group.visible = voxelTree.group.visible = cardTree.group.visible = true
    stats.text = `compare @ ${dist} m${quest ? ' (Quest scale)' : ''}`
  }

  if (mode === 'dist') {
    // The cloak alone, at the distances the forest would actually draw it,
    // every cell at the headset's angular scale. This is the picture that says
    // whether a 700-triangle tree still reads as a pine at 30 m.
    showOnly(cloakTree)
    human.visible = false
    const bands = [6, 12, 20, 32, 55, 90]
    const cw = Math.floor(W / bands.length)
    for (let i = 0; i < bands.length; i++) {
      frameCell(cw, H - 26, bands[i], yaw, true)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${bands[i]} m`, i * cw, H - 22, cw)
    }
    stats.text = `distance ladder at Quest 2 angular scale · ${cloakTree.stats.tris} tris throughout`
  }

  if (mode === 'fill') {
    // Counts, then draws what was counted, so the picture and the number come
    // from the same render.
    const dist = num('dist', 12)
    const rows = TREES().map(([name, tree, tris]) => [name, tree, tris, measureFill(tree, dist, yaw)])
    const cw = Math.floor(W / rows.length)
    human.visible = false
    for (let i = 0; i < rows.length; i++) {
      showOnly(rows[i][1])
      frameCell(cw, H - 26, dist, yaw, false)
      drawCell(i * cw, 0, cw, H - 26)
      label(`${rows[i][0]} · ${rows[i][2]} tri`, i * cw, H - 22, cw)
    }
    // The table goes IN the picture: a headless capture exits the moment the
    // shot lands and drops whatever is still in the stderr buffer, so a
    // console.log of these numbers is a coin flip.
    const table = label([`fill at ${dist} m, per pixel of the tree's own silhouette`,
      '             rasterised   after early-Z     tris   silhouette',
      ...rows.map(([name, , tris, m]) =>
        `  ${name.padEnd(10)}${m.perPixel.toFixed(2).padStart(8)}${m.shadedPerPixel.toFixed(2).padStart(14)}${String(tris).padStart(9)}${String(m.silhouettePx).padStart(9)} px`),
      '  cards keep no early-Z saving: read their first column',
    ].join('\n'), 8, 8, 500)
    table.style.whiteSpace = 'pre'
    table.style.textAlign = 'left'
    table.style.font = '11px ui-monospace, Menlo, monospace'
    cloakTree.group.visible = voxelTree.group.visible = cardTree.group.visible = true
    stats.text = `fill @ ${dist} m`
  }

  renderer.setScissorTest(false)
  const el = document.getElementById('stats')
  if (el) el.textContent = stats.text
}

// --- panel -----------------------------------------------------------------

const SLIDERS = [
  ['height', 3, 22, 0.5, 'metres, root to tip'],
  ['branchCount', 8, 80, 1, 'TOTAL fronds, irregularly spaced -- not whorls'],
  ['branchJitter', 0, 1.2, 0.02, 'how far off its slot a frond may slide'],
  ['branchLength', 0.14, 0.55, 0.01, 'longest frond as a fraction of height'],
  ['branchMin', 0.05, 0.6, 0.01, 'shortest frond, as a fraction of the longest'],
  ['crownPeak', 0, 0.6, 0.02, 'where up the crown the longest frond sits'],
  ['crownFullness', 0.5, 2.5, 0.05, 'how fast fronds shorten toward the leader; >1 pointier'],
  ['firstBranch', 0.05, 0.6, 0.01, 'where up the trunk the crown starts'],
  ['spineMax', 3, 16, 1, 'branch vertices on the longest frond'],
  ['spineMin', 3, 8, 1, 'and on the shortest; three is a hard floor'],
  ['spineFalloff', 0.5, 3, 0.1, 'exponent on that ramp -- >1 hands the maximum to the long skirt fronds only'],
  ['branchPitch', 0, 40, 1, 'degrees below horizontal a frond leaves the trunk'],
  ['branchPitchTop', 0, 70, 1, 'extra of that at the leader -- fronds near the tip hang'],
  ['spineCurve', 0, 16, 0.5, 'degrees a segment turns from the last; sign is per frond, so some droop and some lift'],
  ['spineKink', 0, 16, 0.5, 'extra random turn per segment -- the crooked in "crooked branch"'],
  ['fringeDropMin', -20, 70, 1, 'degrees below the frond a hem vertex swings, floor -- negative lets some of them rise'],
  ['fringeDropMax', 0, 85, 1, 'and ceiling'],
  ['fringeWide', 0.05, 1.1, 0.01, 'hem reach at the trunk, as a fraction of the frond\'s length'],
  ['fringeTip', 0, 0.5, 0.01, 'and at the tip'],
  ['fringeVary', 0, 0.9, 0.02, 'per-vertex roll on that reach'],
  ['fringeFloor', 0, 1, 0.02, 'a hem is never sized off less than this much of the longest frond -- what fills the leader'],
  ['hemRumple', 0, 1, 0.02, 'shove on every hem vertex along all three local axes -- rumpled leaves rather than a sawtooth'],
  ['trunkRadius', 0.004, 0.05, 0.002, 'base radius as a fraction of height; 0.026 is props/tree.js\'s pine'],
  ['apexCount', 0, 6, 1, 'short fronds at the very top'],
  ['apexPitch', 30, 88, 1, 'degrees below horizontal they hang'],
  ['apexLength', 0.04, 0.4, 0.01, 'their length, as a fraction of height'],
  ['texMix', 0, 1, 0.05, 'how much of the solid needle tile shows through the vertex palette'],
  ['leafPatch', 0.15, 1.5, 0.05, 'metres of needle tile per tile'],
  ['barkTile', 0.15, 1.6, 0.05, 'metres of bark per tile, the same around as along'],
  ['depthShade', 0, 1, 0.02, 'the crown\'s value structure, in one number'],
  ['heightLift', 0, 0.6, 0.02, 'extra light on the top of the crown'],
  ['tipRun', 0, 1, 0.02, 'how far back from a frond\'s end this season\'s colour runs'],
  ['hueVary', 0, 0.4, 0.01, 'per-frond colour roll'],
  ['seed', 1, 40, 1, ''],
]

// The crown wears stock Lambert now, so there is nothing of its own to tune --
// what is left is the SCENE's light, which is shared with the two trees beside
// it and with every other gen-* bench.
const LIGHT_SLIDERS = [
  ['sun', 0, 4, 0.05, 'directional intensity', () => sun.intensity, (v) => { sun.intensity = v }],
  ['sky', 0, 2, 0.05, 'hemisphere fill', () => hemi.intensity, (v) => { hemi.intensity = v }],
]

function buildPanel() {
  const panel = document.getElementById('panel')
  if (!panel) return
  panel.innerHTML = ''

  // Two children: the knobs scroll, the buttons do not. Without this the view
  // buttons sit under thirty sliders and cost a scroll to reach.
  const knobs = document.createElement('div'); knobs.id = 'knobs'
  const footer = document.createElement('div'); footer.id = 'footer'
  panel.append(knobs, footer)

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
    knobs.appendChild(row)
  }
  const addHead = (text) => {
    const h = document.createElement('div'); h.className = 'head'; h.textContent = text
    knobs.appendChild(h)
  }

  addHead('crown')
  for (const [k, min, max, step, hint] of SLIDERS) {
    addRow(k, min, max, step, hint, () => params[k], (v) => {
      params[k] = v
      buildCloak()
      // The other two only care about the bench's own two controls, so they
      // rebuild for those and hold still for everything else.
      if (k === 'seed' || k === 'height') { buildVoxel(); buildCard() }
      if (k === 'texMix') voxelMaterial.uniforms.uMapMix.value = v
      frameTree()
    })
  }
  addHead('light')
  for (const [k, min, max, step, hint, get, set] of LIGHT_SLIDERS) {
    addRow(k, min, max, step, hint, get, (v) => { set(v); render() })
  }

  const bar = document.createElement('div'); bar.className = 'buttons'
  footer.appendChild(bar)
  const addButton = (text, fn) => {
    const b = document.createElement('button')
    b.textContent = text
    b.onclick = fn
    bar.appendChild(b)
    return b
  }
  // Every other mode drives the camera itself, per cell, so coming back to a
  // single tree has to re-aim or the pivot stays where the grid left it.
  for (const m of ['single', 'compare', 'dist', 'fill']) {
    addButton(m, () => { mode = m; frameTree(); render() })
  }
  addButton('recentre', () => { frameTree(true); render() })
  addButton('v3 + cards beside it', () => { sideBySide = !sideBySide; render() })
  const wire = addButton('wireframe', () => {
    wireframe = !wireframe
    wire.classList.toggle('on', wireframe)
    applyWireframe()
    render()
  })
}

// --- run -------------------------------------------------------------------

// In shot mode the window IS the frame -- the capture's --window-size sets the
// pixel count. &chrome=1 keeps the panel, which is the only way a capture can
// check the framing against the stage the live page has.
if (SHOT && !qs.has('chrome')) document.body.classList.add('shot')
buildPanel()
resize()
// AFTER resize, because the framing is solved against the viewport's real
// aspect and stage.clientWidth is not that until the layout has run.
frameTree()
addEventListener('resize', () => { resize(); frameTree(); render() })

if (SHOT) {
  loadImageLayers(atlas).then(() => {
    resize()
    render()
    requestAnimationFrame(() => { render(); document.title = 'READY' })
  })
} else {
  const loop = () => { controls.update(); render(); requestAnimationFrame(loop) }
  loop()
}

// The panel narrates itself; the console carries what a screenshot cannot --
// what one tree costs, against the two trees it is proposing to replace.
console.log('[gen-tree-v4]', JSON.stringify({
  tris: cloakTree.stats.tris,
  woodTris: cloakTree.stats.woodTris,
  foliageTris: cloakTree.stats.foliageTris,
  fronds: cloakTree.stats.fronds,
  perFrondTris: cloakTree.stats.perFrondTris,
  spineVerts: cloakTree.stats.spineVerts,
  crownR: +cloakTree.stats.crownRadius.toFixed(2),
  coverage: +cloakTree.stats.coverage.toFixed(1),
  layers: +cloakTree.stats.layers.toFixed(2),
  voxelV3Tris: voxelTree.stats.tris,
  cardTris: cardTree.tris,
}))
