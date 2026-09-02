import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  buildSprayPine, createSprayFoliageMaterial, spraySpecies,
  SPRAY_PINE_DEFAULTS, SPRAY_SPECIES,
} from './props/tree-spray.js'
import { buildTextureArray, loadImageLayers } from './textures.js'
import { createPropMaterial } from './material.js'
import { grassTexture, wrapLambert } from './preview-stage.js'

// ---------------------------------------------------------------------------
// THE BENCH FOR props/tree-spray.js -- a crown grown as spine plus offshoots.
// Read that file's header for what the crown IS; this one is only the eyepiece.
//
// ONE TREE, ORBITABLE, and the two questions it exists to answer are:
//
//   SHAPE    does a limb read as a bough -- beaded down its middle, fanning
//            down and out to both sides, thinning to a point? That is the whole
//            claim of this generator over the packed crown at /gen-tree-v5.
//   SWIM     do the leaves visibly counter-rotate when you drag? A billboard
//            has no answer for it except staying near-equilateral, so it can
//            only be judged by moving the camera, never from a still.
//
// AND THE DISTANCES ARE THE HEADSET'S: a Quest 2 eye is 0.00086 rad per pixel,
// so judging a crown up close on a desktop flatters it against the device.
//
// ?shot=1 renders one frame, hides the chrome and stamps document.title so a
// headless capture knows the frame landed. &yaw, &pitch, &seed, &w, &h steer
// it, and every generator knob is steerable by name.
// ---------------------------------------------------------------------------

const qs = new URLSearchParams(location.search)
const SHOT = qs.get('shot')
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d)

const species = 'pine'

function currentParams() {
  const p = { ...spraySpecies(species), seed: num('seed', 7), height: num('height', 9) }
  for (const k of Object.keys(SPRAY_PINE_DEFAULTS)) if (qs.has(k)) p[k] = num(k, p[k])
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
 * page) reframes.
 */
function frameTree(recentre = false) {
  if (controls.userHasMoved && !recentre) return
  const st = tree && tree.stats
  const h = st ? st.height : params.height
  const R = st ? st.crownRadius : h * 0.25
  const mid = h * 0.5
  controls.target.set(0, mid, 0)
  camera.fov = VIEW_FOV
  const aspect = Math.max(0.2, stage.clientWidth / Math.max(1, stage.clientHeight))
  const tanV = Math.tan(THREE.MathUtils.degToRad(VIEW_FOV) / 2)
  const dist = Math.max((h * 0.60) / tanV, (R * 1.15) / (tanV * aspect))
  // &yaw orbits the framing about the target, which is how billboard swim is
  // caught: two captures of ONE tree at two yaws, differing only in the roll
  // every leaf picked up on the way round. &pitch rides up and over it, which
  // is how the shading is checked for camera dependence -- the crown's colour
  // must not move when only the viewer does.
  const rad = Math.hypot(dist, h * 0.10)
  const yaw = THREE.MathUtils.degToRad(num('yaw', 0))
  const pitch = THREE.MathUtils.degToRad(num('pitch', THREE.MathUtils.radToDeg(Math.atan2(h * 0.10, dist))))
  camera.position.set(
    Math.sin(yaw) * Math.cos(pitch) * rad,
    mid + Math.sin(pitch) * rad,
    Math.cos(yaw) * Math.cos(pitch) * rad,
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
  barkMaterial.customProgramCacheKey = () => 'gen-tree-v7-wrap-vc-v1'
}
loadImageLayers(atlas)

const foliageMaterial = createSprayFoliageMaterial()
const texLoader = new THREE.TextureLoader()
let leafTex = null

/**
 * Hang the leaf mat on the crown and measure its own mean.
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
  // Repeated, not clamped: each leaf cuts a small patch out of the tile at its
  // own random place and angle, so a patch that runs off an edge wraps round
  // instead of smearing the edge pixel across the leaf.
  leafTex.wrapS = leafTex.wrapT = THREE.RepeatWrapping
  leafTex.colorSpace = THREE.SRGBColorSpace
  leafTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  foliageMaterial.uniforms.uMap.value = leafTex
  if (old) old.dispose()
}
setLeafTile(SPRAY_SPECIES[species].tile)
foliageMaterial.uniforms.uSun.value.copy(SUN_DIR)
foliageMaterial.uniforms.uFogColor.value.copy(SKY)

// --- the tree ---------------------------------------------------------------

let tree = null        // { group, geo, stats }

function buildTree() {
  if (tree) { scene.remove(tree.group); tree.geo.dispose() }
  const { geometry, stats } = buildSprayPine(params, SPRAY_SPECIES[species].barkLayer)
  geometry.clearGroups()
  geometry.addGroup(0, stats.woodIndices, 0)
  geometry.addGroup(stats.woodIndices, geometry.index.count - stats.woodIndices, 1)
  const group = new THREE.Group()
  group.add(new THREE.Mesh(geometry, [barkMaterial, foliageMaterial]))
  scene.add(group)
  tree = { group, geo: geometry, stats }
  return tree
}

// --- view -------------------------------------------------------------------

function resize() {
  const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight)
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function render() {
  renderer.render(scene, camera)
  const s = tree.stats
  const el = document.getElementById('stats')
  if (!el) return
  el.textContent = [
    `${s.leaves} leaves (${s.spineLeaves} spine + ${s.offshootLeaves} offshoot)`,
    `${s.branches + s.subs} limbs`,
    `${s.tris} tris (${s.woodTris} wood)`,
    `crown R ${s.crownRadius.toFixed(2)} m`,
    `leaf area ${s.coverage.toFixed(1)} m2`,
    `mean leaf ${(s.meanSize * 100).toFixed(0)} cm`,
    `min gap ${(s.minGap * 100).toFixed(0)} cm`,
    `${s.blocked} blocked`,
  ].join('  ·  ')
}

// --- panel ------------------------------------------------------------------

// Grouped the way the crown is BUILT -- skeleton, then spine, then offshoots,
// then the leader, then the leaf itself. Reading the panel top to bottom is
// reading the generator in order.
const SLIDERS = [
  ['skeleton', [
    ['height', 3, 22, 0.5, 'metres, root to tip'],
    ['branchCount', 8, 140, 1, 'TOTAL branches, irregularly spaced -- not whorls. THE density knob: leaf count is an output of the skeleton'],
    ['branchLength', 0.14, 0.55, 0.01, 'longest branch as a fraction of height'],
    ['crownFullness', 0.5, 2.5, 0.05, 'how fast branches shorten toward the leader; >1 pointier'],
    ['crownCone', 0.1, 0.9, 0.02, 'the cone the wood may not leave, as a fraction of height'],
    ['subsPerMetre', 0, 6, 0.5, 'sub-branches per metre of branch'],
    ['subLength', 0.15, 0.9, 0.02, 'sub-branch length as a fraction of its parent'],
    ['branchMinLength', 0.1, 1.5, 0.05, 'metres; a branch or sub shorter than this is not built at all'],
    ['branchDroopMin', 0, 60, 1, 'shallowest a branch may hang, degrees below horizontal'],
    ['branchDroopMax', 0, 70, 1, 'and the steepest'],
    ['droopBlend', 0, 1, 0.05, 'how far each branch is pulled toward its neighbours\' angle -- 0 is a bottle brush, 1 irons the tree flat'],
  ]],
  ['spine', [
    ['spineGap', 0.4, 2.5, 0.05, 'leaf widths between beads along a limb\'s centre line'],
    ['spineJitter', 0, 0.7, 0.02, 'random fraction of a step, so the beads are not a ruler'],
    ['minGap', 0.25, 1.6, 0.05, 'THE rejection radius: closest two leaves may sit, in leaf widths. 1.0 is barely-touching and starves the crown'],
  ]],
  ['offshoots', [
    ['offshootMin', 0, 6, 1, 'fewest leaves in one fan'],
    ['offshootMax', 1, 10, 1, 'and the most, before anything blocks it'],
    ['outMin', 0, 80, 1, 'degrees off the limb, swept toward this side'],
    ['outMax', 5, 90, 1, ''],
    ['downMin', 0, 80, 1, 'degrees below horizontal a fan drops'],
    ['downMax', 5, 90, 1, ''],
    ['chainStep', 0.5, 2.5, 0.05, 'leaf widths between links. BELOW spineGap and every chain dies on the next bead'],
    ['chainWander', 0, 45, 1, 'degrees a link may turn off the one before it'],
    ['angleTries', 1, 10, 1, 'candidate directions scored against the previous fan on this side'],
    ['offshootCap', 0, 1.5, 0.05, 'a bead\'s fan budget is its distance from the tip, capped at this fraction of the limb\'s bead count'],
  ]],
  ['leader', [
    ['topFraction', 0, 0.6, 0.02, 'the top of the tree treated as one more limb'],
    ['topOffshoots', 0, 6, 1, 'leaves thrown outward and UPWARD off each bead of it'],
    ['topUpMin', 0, 80, 1, 'degrees ABOVE horizontal they rise'],
    ['topUpMax', 5, 89, 1, ''],
  ]],
  ['leaf', [
    ['leafWidth', 0.08, 0.7, 0.01, 'METRES, the side of one leaf triangle at the hull'],
    ['leafVary', 0, 0.6, 0.02, 'random size, plus or minus this fraction'],
    ['leafJitter', 0, 0.5, 0.01, 'how far off equilateral a corner may stray -- high is visible SWIM when you turn'],
    ['leafPatch', 0.15, 1.5, 0.02, 'how much of the tile one leaf covers'],
    ['interiorGrow', 0, 1.5, 0.05, 'how much larger a leaf at the core is than one at the hull -- its spacing grows with it'],
    ['interiorDepth', 0.3, 3, 0.1, 'metres in from the hull over which that swell ramps up'],
  ]],
  ['tint', [
    ['depthShade', 0, 1.5, 0.02, 'darkening by depth inside the crown hull'],
    ['aoRadius', 0.1, 1.2, 0.02, 'metres a neighbour has to be inside to shade a leaf'],
    ['aoStrength', 0, 3, 0.05, 'how hard the LOCAL DENSITY darkens -- the clump\'s dark heart'],
    ['aoFloor', 0, 0.6, 0.02, 'how dark a buried leaf is ever allowed to get'],
    ['hueVary', 0, 0.4, 0.01, 'per-leaf colour roll'],
    ['valueVary', 0, 0.5, 0.01, 'per-leaf brightness roll'],
    ['normalTilt', 0, 3, 0.05, 'how far the crown normal tips up off radial'],
    ['seed', 1, 40, 1, ''],
  ]],
]

const SHADER_SLIDERS = [
  ['uMapMix', 0, 1, 0.02, 'how much of the needle tile shows through the palette'],
  ['uWrap', 0, 1, 0.02, 'diffuse wrap -- keeps a crown normal past the horizon off black'],
  ['uAmbient', 0, 1.4, 0.02, 'hemisphere fill'],
  ['uSunStrength', 0, 3.5, 0.05, ''],
  ['uGrow', 0.3, 2, 0.02, 'scales every leaf about its own centre, without rebuilding'],
]

// Every scalar shader slider is steerable from the query string too, so a
// headless capture can isolate one lighting term without editing the file.
for (const [name] of SHADER_SLIDERS) {
  if (qs.has(name)) foliageMaterial.uniforms[name].value = num(name, 0)
}

// What every knob read at page load. A row whose value has moved off this goes
// orange, so a session's worth of dragging is legible at a glance instead of
// having to be remembered.
const loaded = {}

function buildPanel() {
  const box = document.getElementById('params')
  const bar = document.getElementById('buttons')
  if (!box || !bar) return
  box.innerHTML = ''
  bar.innerHTML = ''

  const addHead = (text) => {
    const h = document.createElement('div'); h.className = 'head'; h.textContent = text
    box.appendChild(h)
  }
  const addRow = (name, min, max, step, hint, get, set) => {
    loaded[name] = get()
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
      // Compared at a step's resolution: a slider hands back the float nearest
      // its step, so 0.4 comes off a 0.05 step as 0.4000000000000001 and a
      // straight !== would light every row you so much as touched.
      row.classList.toggle('dirty', Math.abs(v - loaded[name]) > step / 2)
      set(v)
      render()
    })
    row.append(lab, inp, val)
    box.appendChild(row)
  }

  for (const [group, rows] of SLIDERS) {
    addHead(group)
    for (const [k, min, max, step, hint] of rows) {
      addRow(k, min, max, step, hint, () => params[k], (v) => { params[k] = v; buildTree(); frameTree() })
    }
  }
  addHead('shading')
  for (const [k, min, max, step, hint] of SHADER_SLIDERS) {
    addRow(k, min, max, step, hint, () => foliageMaterial.uniforms[k].value,
      (v) => { foliageMaterial.uniforms[k].value = v })
  }

  const addButton = (text, fn) => {
    const b = document.createElement('button')
    b.textContent = text
    b.onclick = fn
    bar.appendChild(b)
    return b
  }
  addButton('recentre', () => { frameTree(true); render() })
  const note = document.createElement('span'); note.className = 'note'
  // Every generator knob, not just the moved ones: the point is a block that
  // can be pasted straight over SPRAY_PINE_DEFAULTS.
  const copy = addButton('copy params', async () => {
    const out = {}
    for (const k of Object.keys(SPRAY_PINE_DEFAULTS)) out[k] = params[k]
    for (const [k] of SHADER_SLIDERS) out[k] = foliageMaterial.uniforms[k].value
    try {
      await navigator.clipboard.writeText(JSON.stringify(out, null, 2))
      note.textContent = 'copied'
    } catch (e) {
      // Clipboard writes need a secure context and a user gesture, and this page
      // is served over a self-signed cert -- say so instead of looking like the
      // button did nothing.
      note.textContent = `clipboard refused: ${e.message}`
      console.log('[gen-tree-v7] params', JSON.stringify(out, null, 2))
    }
    setTimeout(() => { note.textContent = '' }, 2500)
  })
  copy.title = 'the full param block as JSON, ready to paste over SPRAY_PINE_DEFAULTS'
  bar.appendChild(note)
}

// --- run --------------------------------------------------------------------

if (SHOT && !qs.has('chrome')) document.body.classList.add('shot')
buildTree()
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

console.log('[gen-tree-v7]', JSON.stringify({
  leaves: tree.stats.leaves,
  spine: tree.stats.spineLeaves,
  offshoot: tree.stats.offshootLeaves,
  limbs: tree.stats.branches + tree.stats.subs,
  crownR: +tree.stats.crownRadius.toFixed(2),
  leafArea: +tree.stats.coverage.toFixed(1),
  meanLeafCm: +(tree.stats.meanSize * 100).toFixed(1),
  minGapCm: +(tree.stats.minGap * 100).toFixed(1),
  blocked: tree.stats.blocked,
  woodTris: tree.stats.woodTris,
  tris: tree.stats.tris,
}))
