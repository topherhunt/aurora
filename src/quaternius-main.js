import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// ---------------------------------------------------------------------------
// quaternius.html: a reader for the CC0 animal pack sitting in tmp/. It exists
// to answer two questions before we commit to a quadruped rig of our own --
// what motions the pack actually covers, and how far one animal's skeleton can
// stand in for another's. Nothing here writes anything; the pack stays in the
// gitignored folder the dev server already serves.
// ---------------------------------------------------------------------------

const BASE = '/tmp/Quaternius Animated Animals/glTF'
const ANIMALS = [
  'Alpaca', 'Bull', 'Cow', 'Deer', 'Donkey', 'Fox',
  'Horse', 'Horse_White', 'Husky', 'ShibaInu', 'Stag', 'Wolf',
]

// GLTFLoader strips `.` from node names and keeps the original on userData, so
// the pack's `FrontShoulder.L` arrives as `FrontShoulderL`. Every name shown
// here is the on-disk one, because that is what a rig has to be relabelled to.
const diskName = (bone) => bone.userData.name ?? bone.name

const view = document.getElementById('view')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
view.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)

const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 200)
camera.position.set(3, 2, 4)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))

const grid = new THREE.GridHelper(4, 8, 0x2b4a72, 0x16233a)
scene.add(grid)

const status = document.getElementById('status')
const boneList = document.getElementById('bones')
const labelBox = document.getElementById('boneLabels')
const clipList = document.getElementById('clips')
const animalList = document.getElementById('animals')
const skeletonCheck = document.getElementById('showSkeleton')
const namesCheck = document.getElementById('showBoneNames')
const meshCheck = document.getElementById('showMesh')
const tourCheck = document.getElementById('tour')
const playButton = document.getElementById('play')
const scrubSlider = document.getElementById('scrub')
const timeOut = document.getElementById('time')
const speedSlider = document.getElementById('speed')
const speedOut = document.getElementById('speedV')

function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

// --- what's loaded ------------------------------------------------------

const gltfLoader = new GLTFLoader()
let animal = ANIMALS.indexOf('Fox')
let root = null
let mixer = null
let action = null
let clips = []
let clipIndex = 0
let bones = []
let helper = null
let playing = true
let lastTime = 0

// Bone name sets keep accumulating as animals are visited, so the "common to
// every animal so far" mark sharpens the more of the pack you look at rather
// than being a number baked into this file.
const seen = new Map()

function commonBones() {
  const sets = [...seen.values()]
  if (!sets.length) return new Set()
  return new Set([...sets[0]].filter((n) => sets.every((s) => s.has(n))))
}

function clearModel() {
  if (!root) return
  scene.remove(root)
  if (helper) { scene.remove(helper); helper = null }
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose()
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose())
  })
  root = null
  mixer = null
  action = null
  bones = []
  labelBox.replaceChildren()
}

async function load(index) {
  animal = index
  const name = ANIMALS[index]
  paintAnimals()
  setStatus(`loading ${name}...`)
  let gltf
  try {
    gltf = await gltfLoader.loadAsync(encodeURI(`${BASE}/${name}.gltf`))
  } catch (e) {
    setStatus(`failed to load ${name}.gltf -- ${e.message}. This page needs the dev server (the pack lives in gitignored tmp/).`, 'warn')
    return
  }
  clearModel()

  root = gltf.scene
  scene.add(root)

  // Sit the animal on the grid and frame it, whatever scale it shipped at.
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  root.position.y -= box.min.y
  center.y -= box.min.y
  const span = Math.max(size.x, size.y, size.z)
  controls.target.copy(center)
  camera.position.copy(center).add(new THREE.Vector3(span * 1.5, span * 0.7, span * 1.9))
  camera.near = span / 100
  camera.far = span * 50
  camera.updateProjectionMatrix()
  grid.scale.setScalar(span / 2)

  bones = []
  root.traverse((o) => { if (o.isBone) bones.push(o) })
  seen.set(name, new Set(bones.map(diskName)))

  helper = new THREE.SkeletonHelper(root)
  helper.visible = skeletonCheck.checked
  scene.add(helper)
  applyMeshVisibility()
  buildLabels()
  paintBones(weightedBoneNames())

  clips = gltf.animations
  clipIndex = Math.min(clipIndex, clips.length - 1)
  mixer = new THREE.AnimationMixer(root)
  paintClips()
  playClip(clipIndex)

  let tris = 0
  root.traverse((o) => { if (o.isMesh) tris += o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3 })
  const common = commonBones()
  const extra = bones.filter((b) => !common.has(diskName(b))).length
  setStatus(`${name}: ${tris} triangles, ${bones.length} bones, ${clips.length} clips. ${common.size} bones common to the ${seen.size} animal${seen.size === 1 ? '' : 's'} loaded, ${extra} extra here.`)
}

// Quaternius puts IK controls and pole targets in the skin's joint list even
// though no vertex is weighted to them. Reading the weights is the only way to
// tell those apart from the bones that actually deform the mesh.
function weightedBoneNames() {
  const used = new Set()
  root.traverse((o) => {
    if (!o.isSkinnedMesh) return
    const idx = o.geometry.attributes.skinIndex
    const wgt = o.geometry.attributes.skinWeight
    for (let i = 0; i < idx.count; i++) {
      for (let c = 0; c < idx.itemSize; c++) {
        if (wgt.getComponent(i, c) > 0) used.add(diskName(o.skeleton.bones[idx.getComponent(i, c)]))
      }
    }
  })
  return used
}

// --- panels -------------------------------------------------------------

function paintAnimals() {
  animalList.replaceChildren(...ANIMALS.map((name, i) => {
    const b = document.createElement('button')
    b.textContent = name.replace(/_/g, ' ')
    b.className = i === animal ? 'on' : ''
    b.onclick = () => load(i)
    return b
  }))
}

function paintClips() {
  clipList.replaceChildren(...clips.map((clip, i) => {
    const b = document.createElement('button')
    b.className = i === clipIndex ? 'on' : ''
    const n = document.createElement('span')
    n.textContent = clip.name
    const d = document.createElement('span')
    d.className = 'd'
    d.textContent = `${clip.duration.toFixed(2)}s`
    b.append(n, d)
    b.onclick = () => playClip(i)
    return b
  }))
}

function paintBones(weighted) {
  const common = commonBones()
  const depth = (b) => { let d = 0; for (let p = b.parent; p && p.isBone; p = p.parent) d++; return d }
  boneList.replaceChildren(...bones.map((b) => {
    const row = document.createElement('div')
    row.textContent = `${'  '.repeat(depth(b))}${diskName(b)}`
    if (!weighted.has(diskName(b))) row.className = 'unweighted'
    else if (!common.has(diskName(b))) row.className = 'extra'
    return row
  }))
}

function buildLabels() {
  labelBox.replaceChildren(...bones.map((b) => {
    const s = document.createElement('span')
    s.textContent = diskName(b)
    return s
  }))
}

const labelAt = new THREE.Vector3()
function drawLabels() {
  if (!namesCheck.checked || !root) return
  const w = renderer.domElement.clientWidth
  const h = renderer.domElement.clientHeight
  for (let i = 0; i < bones.length; i++) {
    const el = labelBox.children[i]
    bones[i].getWorldPosition(labelAt).project(camera)
    if (labelAt.z > 1) { el.style.display = 'none'; continue }
    el.style.display = ''
    el.style.left = `${(labelAt.x * 0.5 + 0.5) * w}px`
    el.style.top = `${(-labelAt.y * 0.5 + 0.5) * h}px`
  }
}

function applyMeshVisibility() {
  root.traverse((o) => { if (o.isMesh) o.visible = meshCheck.checked })
}

// --- playback -----------------------------------------------------------

function playClip(i) {
  clipIndex = i
  if (action) action.stop()
  action = mixer.clipAction(clips[i])
  action.reset().play()
  action.paused = !playing
  lastTime = 0
  paintClips()
}

playButton.onclick = () => {
  playing = !playing
  playButton.textContent = playing ? 'pause' : 'play'
  if (action) action.paused = !playing
}

scrubSlider.oninput = () => {
  if (!action) return
  action.paused = true
  action.time = Number(scrubSlider.value) * clips[clipIndex].duration
  mixer.update(0)
  if (playing) action.paused = false
}

speedSlider.oninput = () => { speedOut.textContent = `${Number(speedSlider.value).toFixed(2)}x` }

skeletonCheck.onchange = () => { if (helper) helper.visible = skeletonCheck.checked }
namesCheck.onchange = () => { labelBox.classList.toggle('on', namesCheck.checked) }
meshCheck.onchange = () => { if (root) applyMeshVisibility() }

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || !clips.length) return
  if (e.key === 'ArrowRight') playClip((clipIndex + 1) % clips.length)
  else if (e.key === 'ArrowLeft') playClip((clipIndex - 1 + clips.length) % clips.length)
  else if (e.key === 'ArrowDown') load((animal + 1) % ANIMALS.length)
  else if (e.key === 'ArrowUp') load((animal - 1 + ANIMALS.length) % ANIMALS.length)
  else return
  e.preventDefault()
})

// --- run ----------------------------------------------------------------

function resize() {
  const w = view.clientWidth
  const h = view.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

paintAnimals()
load(animal)

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  controls.update(dt)
  if (mixer && playing) mixer.update(dt * Number(speedSlider.value))

  if (action) {
    const t = action.time
    // A clip that wrapped has a smaller time than last frame -- the only cue
    // the mixer gives that a loop finished, and what `tour` advances on.
    if (t < lastTime && tourCheck.checked) playClip((clipIndex + 1) % clips.length)
    lastTime = action.time
    scrubSlider.value = String(action.time / clips[clipIndex].duration)
    timeOut.textContent = `${action.time.toFixed(2)}s`
  }

  renderer.render(scene, camera)
  drawLabels()
})
