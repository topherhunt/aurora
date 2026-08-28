import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CLIP_NAMES, DEFAULT_PARAMS, evaluateClip } from '../tools/characters/animations.mjs'

// ---------------------------------------------------------------------------
// gen-anim.html: the animation tuning bench. Loads any character's LOD0 GLB
// (they all share one rig, per tools/characters/rig.mjs) and drives its
// bones directly from evaluateClip() every frame -- no bake step, no
// AnimationMixer, because the point of this page is to feel the parameters
// change in real time. `bakeClip` (used by generate-character.mjs to write
// the shipped GLB tracks) samples the exact same function at fixed intervals,
// so what's tuned here is what ships.
// ---------------------------------------------------------------------------

const RANGES = {
  stride: [0, 1.5], kneeBend: [0, 2], armSwing: [0, 1.5], bounce: [0, 0.15],
  cadence: [0.1, 3], breathe: [0, 0.05], sway: [0, 0.1], hipBend: [0, 2], torsoLean: [-0.5, 0.5],
}

// Working copy, seeded from animations.mjs's own defaults; loadParamsFile()
// overwrites it with whatever's checked into animations.json once that
// fetch lands, same "renders first, sharpens up" pattern as the other benches.
const params = JSON.parse(JSON.stringify(DEFAULT_PARAMS))

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

const status = document.getElementById('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

// --- character loading --------------------------------------------------

const gltfLoader = new GLTFLoader()
let root = null // current character's scene root
let bones = new Map() // bone name -> THREE.Bone
let rest = new Map() // bone name -> { pos: Vector3, quat: Quaternion } captured at bind pose

async function loadCharacter(id) {
  setStatus(`loading ${id}...`)
  const url = `/characters/${id}/lod0.glb`
  let gltf
  try {
    gltf = await gltfLoader.loadAsync(url)
  } catch (e) {
    setStatus(`failed to load ${url}: ${e.message}`, 'warn')
    return
  }
  if (root) scene.remove(root)
  root = gltf.scene
  scene.add(root)

  bones = new Map()
  rest = new Map()
  root.traverse((o) => {
    if (o.isBone) {
      bones.set(o.name, o)
      rest.set(o.name, { pos: o.position.clone(), quat: o.quaternion.clone() })
    }
  })
  if (!bones.has('Hips')) {
    setStatus(`${url} loaded but has no "Hips" bone -- not a character rig`, 'warn')
    return
  }
  setStatus(`${id}: ${bones.size} bones, ${CLIP_NAMES.length} clips`, 'ok')
}

// --- pose evaluation -------------------------------------------------------

function applyPose(clipName, phase) {
  if (!bones.size) return
  // Reset every bone to bind pose first: a clip only lists the bones it
  // moves, and switching clips must not leave a previous clip's rotation on
  // a bone the new one never mentions.
  for (const [name, r] of rest) {
    const b = bones.get(name)
    b.position.copy(r.pos)
    b.quaternion.copy(r.quat)
  }
  const { rot, hipsBobY = 0 } = evaluateClip(clipName, phase, params[clipName])
  for (const [boneName, q] of Object.entries(rot)) {
    const b = bones.get(boneName)
    if (!b) continue
    // evaluateClip's quat is a delta off the bone's rest orientation, not an
    // absolute local rotation -- compose with the bind-pose quat captured in
    // `rest` (identity for most bones, but a real rest rotation for T-pose
    // arm bones -- rig.mjs), same composition bakeClip does for the shipped
    // GLB (animations.mjs).
    b.quaternion.copy(rest.get(boneName).quat).multiply(new THREE.Quaternion(q[0], q[1], q[2], q[3]))
  }
  const hips = bones.get('Hips')
  if (hips) hips.position.y = rest.get('Hips').pos.y + hipsBobY
}

// --- controls ---------------------------------------------------------------

const clipSelect = document.getElementById('clip')
for (const name of CLIP_NAMES) {
  const opt = document.createElement('option')
  opt.value = name
  opt.textContent = name
  clipSelect.appendChild(opt)
}

const scrubCheck = document.getElementById('scrub')
const phaseRow = document.getElementById('phaserow')
const phaseSlider = document.getElementById('phase')
const phaseV = document.getElementById('phaseV')
scrubCheck.addEventListener('change', () => {
  phaseRow.style.display = scrubCheck.checked ? '' : 'none'
})
phaseSlider.addEventListener('input', () => { phaseV.textContent = Number(phaseSlider.value).toFixed(2) })
phaseV.textContent = '0.00'

function buildSliders() {
  const clipName = clipSelect.value
  const container = document.getElementById('sliders')
  container.innerHTML = ''
  for (const [key, val] of Object.entries(params[clipName])) {
    const [lo, hi] = RANGES[key] || [0, Math.max(1, val * 2)]
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <label title="${key}">${key}</label>
      <input type="range" min="${lo}" max="${hi}" step="0.001" value="${val}" />
      <span class="v"></span>
    `
    const input = row.querySelector('input')
    const v = row.querySelector('.v')
    const update = () => { v.textContent = Number(input.value).toFixed(3) }
    input.addEventListener('input', () => {
      params[clipName][key] = Number(input.value)
      update()
    })
    update()
    container.appendChild(row)
  }
}
clipSelect.addEventListener('change', buildSliders)

document.getElementById('reset').addEventListener('click', () => {
  params[clipSelect.value] = { ...DEFAULT_PARAMS[clipSelect.value] }
  buildSliders()
})

document.getElementById('save').addEventListener('click', async () => {
  try {
    const res = await fetch('/__animations', { method: 'POST', body: JSON.stringify(params) })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    setStatus(`saved -> ${j.path}`, 'ok')
  } catch (e) {
    setStatus(`save failed: ${e.message}`, 'warn')
  }
})

document.getElementById('load').addEventListener('click', () => loadCharacter(document.getElementById('charId').value.trim()))

// Seed the working params from the checked-in file (not just animations.mjs's
// in-code defaults) so a tuning session starts from the last saved state.
fetch('/tools/characters/animations.json').then((r) => r.ok ? r.json() : null).then((saved) => {
  if (saved) Object.assign(params, saved)
  buildSliders()
}).catch(() => buildSliders())

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
let phaseClock = 0
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta()
  controls.update(dt)

  const clipName = clipSelect.value
  const cadence = params[clipName]?.cadence ?? 1
  let phase
  if (scrubCheck.checked) {
    phase = Number(phaseSlider.value)
  } else {
    phaseClock = (phaseClock + dt * cadence) % 1
    phase = phaseClock
  }
  applyPose(clipName, phase)

  renderer.render(scene, camera)
})
