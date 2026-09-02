import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildBillboardPine, createBillboardFoliageMaterial, billboardSpecies,
  BILLBOARD_PINE_DEFAULTS, BILLBOARD_SPECIES,
} from './props/tree-billboard.js'
import { buildVoxelPine, createVoxelFoliageMaterial, voxelSpecies, VOXEL_SPECIES } from './props/tree-voxel.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-billboard.js -- a crown of camera-facing triangles.
// Read that file's header for what it is and why; this one is the eyepiece.
//
// Two view modes, and the second is the whole point:
//
//   SINGLE   one tree, orbitable. Does a billboard crown read as a pine, and
//            does it SWIM -- do the leaves visibly counter-rotate when the
//            camera moves? That question can only be answered by dragging.
//   COMPARE  the billboard crown beside /gen-tree-v3's oriented voxel crown,
//            same seed, same height, same sun, same leaf tile. The comparison
//            the idea lives or dies by.
//
// AND THE DISTANCES ARE THE HEADSET'S, the same as v3: a Quest 2 eye is
// 0.00086 rad per pixel, so judging a crown at a desktop 45 degrees flatters it
// against what the device will actually show.
//
// ?shot=<mode> renders one frame, hides the chrome and stamps document.title so
// a headless capture knows the frame landed. &dist, &yaw, &seed, &w, &h steer
// it, and every generator knob is steerable by name.
// ---------------------------------------------------------------------------

const qs = new URLSearchParams(location.search)
const SHOT = qs.get('shot')
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d)

const species = 'pine'

function currentParams() {
  const p = { ...billboardSpecies(species), seed: num('seed', 7), height: num('height', 9) }
  for (const k of Object.keys(BILLBOARD_PINE_DEFAULTS)) if (qs.has(k)) p[k] = num(k, p[k])
  return p
}
let params = currentParams()

// --- stage -----------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
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
 * ONCE THE VIEW IS YOURS IT STAYS YOURS -- a rebuild calls this on every slider
 * drag, and re-aiming there would fight the mouse. Only `recentre` (or a fresh
 * page) reframes. This is /gen-tree-v3's framing to the line, deliberately: a
 * bench that frames its subject differently is not a comparison.
 */
function frameTree(recentre = false) {
  if (controls.userHasMoved && !recentre) return
  const st = tree && tree.stats
  const h = st ? st.height : params.height
  const R = st ? st.crownRadius : h * 0.25
  const mid = h * 0.5
  controls.target.set(mode === 'compare' ? GAP / 2 : 0, mid, 0)
  camera.fov = VIEW_FOV
  const aspect = Math.max(0.2, stage.clientWidth / Math.max(1, stage.clientHeight))
  const tanV = Math.tan(THREE.MathUtils.degToRad(VIEW_FOV) / 2)
  const wide = mode === 'compare' ? R * 1.15 + GAP / 2 : R * 1.15
  const dist = Math.max((h * 0.60) / tanV, wide / (tanV * aspect))
  // &yaw orbits the framing about the target, which is how billboard swim is
  // caught: two captures of ONE tree at two yaws, differing only in the roll
  // every leaf picked up on the way round.
  const yaw = THREE.MathUtils.degToRad(num('yaw', 0))
  camera.position.set(
    controls.target.x + Math.sin(yaw) * dist,
    mid + h * 0.10,
    Math.cos(yaw) * dist,
  )
  camera.updateProjectionMatrix()
  controls.maxDistance = h * 8
  controls.userHasMoved = false
  controls.update()
}
controls.addEventListener('start', () => { controls.userHasMoved = true })

const SUN_DIR = new THREE.Vector3(0.44, 0.74, 0.30).normalize()
const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.copy(SUN_DIR).multiplyScalar(20)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const groundTex = grassTexture(renderer)
groundTex.wrapS = groundTex.wrapT = THREE.RepeatWrapping
groundTex.repeat.set(200, 200)
const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshLambertMaterial({ map: groundTex }))
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
const barkMaterial = createPropMaterial(atlas, { vertexColors: true })
{
  const patch = barkMaterial.onBeforeCompile
  barkMaterial.onBeforeCompile = (shader, r) => { patch(shader, r); wrapLambert(shader) }
  barkMaterial.customProgramCacheKey = () => 'gen-tree-v5-wrap-vc-v1'
}
loadImageLayers(atlas)

const foliageMaterial = createBillboardFoliageMaterial()
// The v3 crown standing next to it, so COMPARE is a comparison of primitives
// and not of two different shading models that happen to be nearby.
const voxelFoliageMaterial = createVoxelFoliageMaterial()

const texLoader = new THREE.TextureLoader()
let leafTex = null

/**
 * Hang the leaf mat on both crowns and measure its own mean.
 *
 * The mean is what lets the shader divide by it, so the tile reads as needles
 * MODULATING the tuned palette rather than repainting it. Averaged in LINEAR
 * light because that is what the sampler hands the shader: mean the sRGB bytes
 * instead and the division is against a number roughly twice too large, which
 * drops the whole crown a stop and a half.
 */
function setLeafTile(url) {
  const old = leafTex
  leafTex = texLoader.load(url, (t) => {
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
    const mean = [Math.max(1e-4, sum[0] / px), Math.max(1e-4, sum[1] / px), Math.max(1e-4, sum[2] / px)]
    foliageMaterial.uniforms.uMapMean.value.set(...mean)
    render()
  })
  leafTex.wrapS = leafTex.wrapT = THREE.RepeatWrapping
  leafTex.colorSpace = THREE.SRGBColorSpace
  leafTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  foliageMaterial.uniforms.uMap.value = leafTex
  if (old) old.dispose()
}
setLeafTile(BILLBOARD_SPECIES[species].tile)
foliageMaterial.uniforms.uSun.value.copy(SUN_DIR)
foliageMaterial.uniforms.uFogColor.value.copy(SKY)
voxelFoliageMaterial.uniforms.uSun.value.copy(SUN_DIR)
voxelFoliageMaterial.uniforms.uFogColor.value.copy(SKY)

// The v3 crown wears its own shipped solid tile. Pointing it at this bench's
// mat would make COMPARE a texture test rather than a geometry test.
{
  const t = texLoader.load(VOXEL_SPECIES[species].tile, () => render())
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  voxelFoliageMaterial.uniforms.uMap.value = t
  voxelFoliageMaterial.uniforms.uMapMix.value = 0.75
}

// --- the trees --------------------------------------------------------------

const GAP = 6.5        // metres between the two crowns in COMPARE
let tree = null        // { group, geo, stats }
let voxelTree = null

function buildBillboard() {
  if (tree) { scene.remove(tree.group); tree.geo.dispose() }
  const { geometry, stats } = buildBillboardPine(params, BILLBOARD_SPECIES[species].barkLayer)
  geometry.clearGroups()
  geometry.addGroup(0, stats.woodIndices, 0)
  geometry.addGroup(stats.woodIndices, geometry.index.count - stats.woodIndices, 1)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, [barkMaterial, foliageMaterial]))
  scene.add(group)
  tree = { group, geo: geometry, stats }
  return tree
}

/** /gen-tree-v3's crown, built only when COMPARE actually needs it. */
function buildVoxel() {
  if (voxelTree) { scene.remove(voxelTree.group); voxelTree.geo.dispose() }
  const p = { ...voxelSpecies(species), seed: params.seed, height: params.height, texMix: 0.75 }
  const { geometry, stats } = buildVoxelPine(p, VOXEL_SPECIES[species].barkLayer)
  geometry.clearGroups()
  geometry.addGroup(0, stats.woodIndices, 0)
  geometry.addGroup(stats.woodIndices, geometry.index.count - stats.woodIndices, 1)
  const group = new THREE.Group()
  group.position.x = GAP
  group.add(new THREE.Mesh(geometry, [barkMaterial, voxelFoliageMaterial]))
  scene.add(group)
  voxelTree = { group, geo: geometry, stats }
  return voxelTree
}

// --- view -------------------------------------------------------------------

let mode = SHOT || 'single'

function applyMode() {
  if (mode === 'compare') {
    if (!voxelTree) buildVoxel()
    voxelTree.group.visible = true
  } else if (voxelTree) {
    voxelTree.group.visible = false
  }
}

function resize() {
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function render() {
  applyMode()
  renderer.render(scene, camera)
  const s = tree.stats
  const el = document.getElementById('stats')
  if (!el) return
  const parts = [
    `${s.leaves} leaves`,
    `${s.tris} tris (${s.woodTris} wood)`,
    `crown R ${s.crownRadius.toFixed(2)} m`,
    `leaf area ${s.coverage.toFixed(1)} m2`,
    `min gap ${(s.minGap * 100).toFixed(0)} cm`,
    `darts kept ${(s.accepted * 100).toFixed(0)}%`,
  ]
  if (mode === 'compare' && voxelTree) {
    parts.push(`| v3 voxel: ${voxelTree.stats.tris} tris, silhouette ${voxelTree.stats.silhouette.toFixed(1)} m2`)
  }
  el.textContent = parts.join('  ·  ')
}

// --- panel ------------------------------------------------------------------

const SLIDERS = [
  ['height', 3, 22, 0.5, 'metres, root to tip'],
  ['branchCount', 8, 80, 1, 'TOTAL branches, irregularly spaced -- not whorls'],
  ['branchLength', 0.14, 0.55, 0.01, 'longest branch as a fraction of height'],
  ['crownFullness', 0.5, 2.5, 0.05, 'how fast branches shorten toward the leader; >1 pointier'],
  ['branchDroop', 0, 1.4, 0.02, 'total bend from launch to tip'],
  ['subMax', 0, 4, 1, 'sub-branches per limb'],
  ['subLength', 0.15, 0.9, 0.02, 'sub-branch length as a fraction of its parent'],
  ['leafWidth', 0.04, 0.4, 0.005, 'METRES, the side of one leaf triangle'],
  ['leafVary', 0, 0.6, 0.02, 'random size, plus or minus this fraction'],
  ['leafJitter', 0, 0.5, 0.01, 'how far off equilateral a corner may stray -- high is visible SWIM when you turn'],
  ['clumpRate', 1, 14, 0.5, 'cluster centres per metre of twig'],
  ['clumpLeaves', 1, 20, 1, 'darts thrown per cluster'],
  ['clumpRadius', 0.04, 0.6, 0.01, 'metres a cluster scatters over -- small is tight knots, large is a hedge'],
  ['clumpOut', 0, 1.5, 0.05, 'how much of that scatter is pushed away from the twig'],
  ['minGap', 0.3, 2.5, 0.05, 'closest two leaves may sit, as a multiple of the average leaf width'],
  ['darts', 1, 8, 1, 'tries a rejected dart gets before it is given up on'],
  ['leafPatch', 0.15, 1.5, 0.02, 'how much of the tile one leaf covers'],
  ['depthShade', 0, 1.5, 0.02, 'darkening by depth inside the crown hull'],
  ['aoRadius', 0.1, 1.2, 0.02, 'metres a neighbour has to be inside to shade a leaf'],
  ['aoStrength', 0, 3, 0.05, 'how hard the LOCAL DENSITY darkens -- the clump\'s dark heart'],
  ['aoFloor', 0, 0.6, 0.02, 'how dark a buried leaf is ever allowed to get'],
  ['hueVary', 0, 0.4, 0.01, 'per-leaf colour roll'],
  ['valueVary', 0, 0.5, 0.01, 'per-leaf brightness roll'],
  ['normalTilt', 0, 3, 0.05, 'how far the crown normal tips up off radial'],
  ['seed', 1, 40, 1, ''],
]

const SHADER_SLIDERS = [
  ['uMapMix', 0, 1, 0.02, 'how much of the needle tile shows through the palette'],
  ['uWrap', 0, 1, 0.02, 'diffuse wrap -- keeps a crown normal past the horizon off black'],
  ['uTransmit', 0, 2, 0.05, 'backlit rim glow'],
  ['uTransmitPower', 1, 12, 0.5, 'how tight that lobe is'],
  ['uAmbient', 0, 1.4, 0.02, 'hemisphere fill'],
  ['uSunStrength', 0, 3.5, 0.05, ''],
  ['uGrow', 0.3, 2, 0.02, 'scales every leaf about its own centre, without rebuilding'],
]

// Every scalar shader slider is steerable from the query string too, so a
// headless capture can isolate one lighting term without editing the file.
for (const [name] of SHADER_SLIDERS) {
  if (qs.has(name)) foliageMaterial.uniforms[name].value = num(name, 0)
}

function buildPanel() {
  const panel = document.getElementById('panel')
  if (!panel) return
  panel.innerHTML = ''

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
    addRow(k, min, max, step, hint, () => params[k], (v) => { params[k] = v; buildBillboard(); frameTree() })
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
  for (const m of ['single', 'compare']) {
    addButton(m, () => { mode = m; frameTree(true); render() })
  }
  addButton('recentre', () => { frameTree(true); render() })
}

// --- run --------------------------------------------------------------------

if (SHOT && !qs.has('chrome')) document.body.classList.add('shot')
buildBillboard()
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

console.log('[gen-tree-v5]', JSON.stringify({
  leaves: tree.stats.leaves,
  branches: tree.stats.branches,
  crownR: +tree.stats.crownRadius.toFixed(2),
  leafArea: +tree.stats.coverage.toFixed(1),
  minGapCm: +(tree.stats.minGap * 100).toFixed(1),
  dartsThrown: tree.stats.thrown,
  dartsKept: +(tree.stats.accepted * 100).toFixed(1),
  woodTris: tree.stats.woodTris,
  tris: tree.stats.tris,
}))
