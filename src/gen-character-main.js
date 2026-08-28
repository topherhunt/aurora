import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

// ---------------------------------------------------------------------------
// gen-character.html: the bone-adjustment bench. Loads one character's LOD0
// GLB (every character shares the same bone hierarchy -- tools/characters/
// rig.mjs) and lets a bone be dragged with TransformControls; the skinned
// mesh follows live because three.js recomputes the skeleton from bone
// transforms every frame. "save" writes a rig-override.json with the moved
// bones' new LOCAL translations (parent-relative, same convention as
// gltf-writer.mjs's `skeleton.translations`), which generate-character.mjs
// applies on top of rig.mjs's proportional placement on the next bake.
// ---------------------------------------------------------------------------

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.outputColorSpace = THREE.SRGBColorSpace
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0a1018)
scene.fog = new THREE.Fog(0x0a1018, 10, 60)

const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 300)
camera.position.set(2.4, 1.6, 2.4)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0.9, 0)

const sun = new THREE.DirectionalLight(0xfff3e2, 2.1)
sun.position.set(3, 5, 2)
scene.add(sun)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x2a2418, 0.85))
scene.add(new THREE.GridHelper(8, 16, 0x2b4a72, 0x16233a))

const transform = new TransformControls(camera, renderer.domElement)
transform.setMode('translate')
transform.setSize(0.8)
transform.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value })
transform.addEventListener('objectChange', () => { markDirty(); refreshOverrideTable() })
scene.add(transform.getHelper ? transform.getHelper() : transform)

const status = document.getElementById('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

// --- character loading --------------------------------------------------

const gltfLoader = new GLTFLoader()
let root = null
let skeletonHelper = null
let bones = new Map() // name -> THREE.Bone
let rest = new Map() // name -> Vector3, the position each bone loaded at (proportional placement + any override baked into the GLB is NOT applied -- lod0.glb never bakes overrides in, generate-character.mjs applies them at bake time, so "rest" here is always the un-overridden proportional pose)
let dirty = new Set() // bone names moved this session
let currentId = ''

async function loadCharacter(id) {
  setStatus(`loading ${id}...`)
  currentId = id
  try {
    const gltf = await gltfLoader.loadAsync(`/characters/${id}/lod0.glb`)
    if (root) scene.remove(root)
    if (skeletonHelper) scene.remove(skeletonHelper)
    root = gltf.scene
    scene.add(root)
    skeletonHelper = new THREE.SkeletonHelper(root)
    skeletonHelper.material.linewidth = 2
    scene.add(skeletonHelper)

    bones = new Map()
    rest = new Map()
    root.traverse((o) => { if (o.isBone) { bones.set(o.name, o); rest.set(o.name, o.position.clone()) } })
    dirty = new Set()

    const boneSelect = document.getElementById('bone')
    boneSelect.innerHTML = ''
    for (const name of bones.keys()) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      boneSelect.appendChild(opt)
    }
    selectBone(boneSelect.value)

    // Existing override, if the bench (or a prior session) already saved one --
    // shown as the starting point rather than silently overwritten on save.
    let existing = {}
    try {
      const r = await fetch(`/characters/${id}/rig-override.json`)
      if (r.ok) existing = await r.json()
    } catch { /* no override yet */ }
    for (const [name, xyz] of Object.entries(existing)) {
      const b = bones.get(name)
      if (b) { b.position.set(...xyz); dirty.add(name) }
    }
    refreshOverrideTable()

    setStatus(`${id}: ${bones.size} bones${Object.keys(existing).length ? `, ${Object.keys(existing).length} overridden` : ''}`, 'ok')
  } catch (e) {
    setStatus(`failed to load ${id}: ${e.message}`, 'warn')
  }
}

function selectBone(name) {
  const b = bones.get(name)
  transform.detach()
  if (b) transform.attach(b)
}

function markDirty() {
  const name = document.getElementById('bone').value
  dirty.add(name)
}

function refreshOverrideTable() {
  const table = document.getElementById('overrideTable')
  table.innerHTML = ''
  for (const name of dirty) {
    const b = bones.get(name)
    if (!b) continue
    const row = document.createElement('tr')
    const p = b.position
    row.innerHTML = `<td class="k">${name}</td><td class="n">${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}</td>`
    table.appendChild(row)
  }
}

// --- controls ---------------------------------------------------------------

document.getElementById('bone').addEventListener('change', (e) => selectBone(e.target.value))
document.getElementById('load').addEventListener('click', () => loadCharacter(document.getElementById('charId').value.trim()))

function modeButton(id, mode) {
  document.getElementById(id).addEventListener('click', () => {
    transform.setMode(mode)
    document.getElementById('modeTranslate').classList.toggle('on', mode === 'translate')
    document.getElementById('modeRotate').classList.toggle('on', mode === 'rotate')
  })
}
modeButton('modeTranslate', 'translate')
modeButton('modeRotate', 'rotate')

document.getElementById('resetBone').addEventListener('click', () => {
  const name = document.getElementById('bone').value
  const b = bones.get(name)
  const r = rest.get(name)
  if (b && r) { b.position.copy(r); dirty.delete(name); refreshOverrideTable() }
})

document.getElementById('resetAll').addEventListener('click', () => {
  for (const [name, b] of bones) b.position.copy(rest.get(name))
  dirty.clear()
  refreshOverrideTable()
})

document.getElementById('save').addEventListener('click', async () => {
  const payload = {}
  for (const name of dirty) {
    const b = bones.get(name)
    if (b) payload[name] = [b.position.x, b.position.y, b.position.z]
  }
  try {
    const res = await fetch(`/__character-rig?id=${encodeURIComponent(currentId)}`, { method: 'POST', body: JSON.stringify(payload) })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    setStatus(`saved -> ${j.path} (${Object.keys(payload).length} bones)`, 'ok')
  } catch (e) {
    setStatus(`save failed: ${e.message}`, 'warn')
  }
})

// --- run ---------------------------------------------------------------

function resize() {
  const w = stage.clientWidth
  const h = stage.clientHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

loadCharacter(document.getElementById('charId').value.trim())

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  controls.update(dt)
  renderer.render(scene, camera)
})
