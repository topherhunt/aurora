// ---------------------------------------------------------------------------
// gen-fish.html: reroll/preview/pick bench for a fish species's one sideview
// sheet. "generate" fires one real OpenRouter call (vite.config.js's
// /__generate-fish-view, which calls tools/characters/openrouter.mjs via
// tools/fauna/fish-prompt.mjs) -- every other action here is local and free.
// Cut down from gen-sheet-main.js's front/side/back flow: a fish only needs
// one view, so there is no reference-image chaining and no bake step yet.
// ---------------------------------------------------------------------------

import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { SPECIES } from '../tools/fauna/fish-roster.mjs'

let candidates = []
let picked = -1 // index into candidates, or -1
let totalCost = 0
let callCount = 0

const status = document.getElementById('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

function currentId() { return document.getElementById('fishId').value.trim() }

// --- starter roster picker -----------------------------------------------

const rosterSelect = document.getElementById('roster')
for (const s of SPECIES) {
  const opt = document.createElement('option')
  opt.value = s.id
  opt.textContent = s.label
  rosterSelect.appendChild(opt)
}

async function loadSpecies(id) {
  const s = SPECIES.find((sp) => sp.id === id)
  if (!s) return
  rosterSelect.value = id
  document.getElementById('fishId').value = s.id
  document.getElementById('description').value = s.description
  candidates = []
  picked = -1
  await loadCandidatesFromDisk()
  renderGallery()
  applyTint()
  loadMeshPreview()
}

rosterSelect.addEventListener('change', () => { if (rosterSelect.value) loadSpecies(rosterSelect.value) })
document.getElementById('rosterPrev').addEventListener('click', () => stepRoster(-1))
document.getElementById('rosterNext').addEventListener('click', () => stepRoster(1))

function stepRoster(delta) {
  const i = SPECIES.findIndex((s) => s.id === rosterSelect.value)
  const next = SPECIES[(i < 0 ? 0 : i + delta + SPECIES.length) % SPECIES.length]
  loadSpecies(next.id)
}

async function loadCandidatesFromDisk() {
  const id = currentId()
  if (!id) return
  try {
    const res = await fetch(`/__fish-candidates?id=${encodeURIComponent(id)}`)
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    candidates = j.candidates
    picked = j.candidates.findIndex((c) => c.picked)
    setStatus(`loaded ${j.candidates.length} candidate(s) from disk`, 'ok')
  } catch (e) {
    setStatus(`load failed: ${e.message}`, 'warn')
  }
}

function renderGallery() {
  const gallery = document.getElementById('gallery')
  gallery.innerHTML = ''
  candidates.forEach((c, i) => {
    const div = document.createElement('div')
    div.className = 'candidate'
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${c.imageB64}`
    const btn = document.createElement('button')
    const isPicked = picked === i
    btn.textContent = isPicked ? 'picked' : 'pick'
    btn.className = isPicked ? 'picked' : 'pick'
    btn.addEventListener('click', () => pickCandidate(i))
    const cost = document.createElement('div')
    cost.className = 'cost'
    cost.textContent = `$${c.cost.toFixed(4)}`
    div.append(img, btn, cost)
    gallery.appendChild(div)
  })
}

function updateCost() {
  document.getElementById('cost').textContent = `$${totalCost.toFixed(4)} across ${callCount} call${callCount === 1 ? '' : 's'}`
}

async function generate() {
  const id = currentId()
  const description = document.getElementById('description').value.trim()
  if (!/^[a-z0-9-]+$/.test(id)) { setStatus('fish id must be lowercase letters, digits, hyphens', 'warn'); return }
  if (!description) { setStatus('description is empty', 'warn'); return }

  const btn = document.getElementById('generate')
  btn.disabled = true
  setStatus('generating side view...')
  try {
    const res = await fetch('/__generate-fish-view', {
      method: 'POST',
      body: JSON.stringify({ id, description }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    candidates.push({ imageB64: j.imageB64, cost: j.cost })
    totalCost += j.cost
    callCount += 1
    updateCost()
    renderGallery()
    setStatus(`${candidates.length} candidate(s), last cost $${j.cost.toFixed(4)}`, 'ok')
  } catch (e) {
    setStatus(`generate failed: ${e.message}`, 'warn')
  } finally {
    btn.disabled = false
  }
}

async function pickCandidate(i) {
  const id = currentId()
  const c = candidates[i]
  setStatus('saving pick...')
  try {
    const res = await fetch(`/__save-fish-view?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ imageB64: c.imageB64 }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    picked = i
    renderGallery()
    await applyTint()
    loadMeshPreview()
    setStatus(`saved -> ${j.path}`, 'ok')
  } catch (e) {
    setStatus(`save failed: ${e.message}`, 'warn')
  }
}

// --- tint preview: fetches the picked, alpha-keyed cutout at its natural
// stored color and re-hues it live with a CSS hue-rotate/saturate filter, a
// cheap stand-in for "one stored art source, randomized per instance" without
// writing any new asset to disk yet.
async function applyTint() {
  const panel = document.getElementById('tintPreview')
  const img = document.getElementById('tintPreviewImg')
  const id = currentId()
  if (!id || picked < 0) { panel.classList.remove('on'); return }
  try {
    const res = await fetch(`/__fish-reference?id=${encodeURIComponent(id)}`)
    const j = await res.json()
    if (j.exists) {
      img.src = `data:image/png;base64,${j.imageB64}`
      panel.classList.add('on')
      updateTintFilter()
    } else {
      panel.classList.remove('on')
    }
  } catch {
    panel.classList.remove('on')
  }
}

function updateTintFilter() {
  const hue = document.getElementById('tintHue').value
  const strength = document.getElementById('tintStrength').value / 100
  const img = document.getElementById('tintPreviewImg')
  // Re-hue the stored natural-color art directly -- no grayscale flattening.
  // hue-rotate spins the existing palette around the wheel; strength just
  // boosts saturation so the shifted hue still reads clearly. At strength 0
  // this is hue-rotate(Ndeg) saturate(100%), i.e. a pure hue shift with the
  // original color relationships intact.
  img.style.filter = `hue-rotate(${hue}deg) saturate(${100 + 150 * strength}%)`
}

document.getElementById('tintHue').addEventListener('input', updateTintFilter)
document.getElementById('tintStrength').addEventListener('input', updateTintFilter)

document.getElementById('generate').addEventListener('click', generate)

// --- mesh preview: lofts a low-poly 3D body from the picked side view's
// contour (vite.config.js's /__fish-mesh -> tools/fauna/loft-fish-mesh.mjs)
// and, when "swim wiggle" is on, offsets each vertex sideways each frame by
// its own bend weight * amplitude * sin(freq*time - k*z) -- the tail (bend
// close to 1) swings further than the head (bend close to 0) on the same
// sine wave, exactly the per-vertex attribute the mesh was built to carry.
const meshCanvas = document.getElementById('meshCanvas')
const meshRenderer = new THREE.WebGLRenderer({ canvas: meshCanvas, antialias: true, alpha: true })
meshRenderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
const meshScene = new THREE.Scene()
const meshCamera = new THREE.PerspectiveCamera(35, 260 / 200, 0.01, 10)
meshCamera.position.set(0.35, 0.22, 0.35)
meshScene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a1420, 1.1))
const meshSun = new THREE.DirectionalLight(0xfff3e2, 1.6)
meshSun.position.set(1, 1.5, 1)
meshScene.add(meshSun)
const meshControlsOrbit = new OrbitControls(meshCamera, meshRenderer.domElement)
meshControlsOrbit.enableDamping = true
meshControlsOrbit.target.set(0, 0, 0)

let meshObj = null
let meshRestX = null // per-vertex rest-pose x (pre-wiggle), captured once per mesh load
let meshBaseZ = null // per-vertex z -- the wiggle wave's phase input (z doesn't move, only x does)
let meshBend = null

function setMeshSize() {
  const w = meshCanvas.clientWidth || 260, h = meshCanvas.clientHeight || 200
  meshRenderer.setSize(w, h, false)
  meshCamera.aspect = w / h
  meshCamera.updateProjectionMatrix()
}

async function loadMeshPreview() {
  const panel = document.getElementById('meshPreview')
  const id = currentId()
  if (!id || picked < 0) { panel.classList.remove('on'); return }
  try {
    const res = await fetch(`/__fish-mesh?id=${encodeURIComponent(id)}`)
    const j = await res.json()
    if (!j.exists) { panel.classList.remove('on'); return }
    const m = j.mesh
    if (meshObj) { meshScene.remove(meshObj); meshObj.geometry.dispose(); meshObj.material.dispose() }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.pos), 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(m.nrm), 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(m.uv), 2))
    geo.setIndex(m.idx)
    const mat = new THREE.MeshStandardMaterial({ color: 0x6fa0c9, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide })
    meshObj = new THREE.Mesh(geo, mat)
    meshScene.add(meshObj)
    meshBend = m.bend
    meshRestX = []
    meshBaseZ = []
    for (let i = 0; i < m.pos.length; i += 3) { meshRestX.push(m.pos[i]); meshBaseZ.push(m.pos[i + 2]) }
    const tris = m.idx.length / 3
    document.getElementById('meshTris').textContent = `${tris} tris, ${m.pos.length / 3} verts (LOD0)`
    const cam = m.lengthM * 1.3
    meshCamera.position.set(cam, cam * 0.6, cam)
    meshControlsOrbit.update()
    panel.classList.add('on')
    setMeshSize()
  } catch {
    panel.classList.remove('on')
  }
}

const meshClock = new THREE.Clock()
function animateMesh() {
  requestAnimationFrame(animateMesh)
  if (meshObj && document.getElementById('meshWiggle').checked) {
    const amp = document.getElementById('meshAmplitude').value / 1000 // slider is 0-100 -> 0..0.1 world units
    const t = meshClock.getElapsedTime()
    const pos = meshObj.geometry.attributes.position
    for (let i = 0; i < meshBend.length; i++) {
      pos.array[i * 3] = meshRestX[i] + meshBend[i] * amp * Math.sin(6 * t - 8 * meshBaseZ[i])
    }
    pos.needsUpdate = true
    meshObj.geometry.computeVertexNormals()
  }
  meshControlsOrbit.update()
  meshRenderer.render(meshScene, meshCamera)
}
requestAnimationFrame(animateMesh)

window.addEventListener('resize', setMeshSize)

loadSpecies(SPECIES[0].id)
updateCost()
