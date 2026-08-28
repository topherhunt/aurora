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
let currentHeightM = 1.7

// --- reference cards: the alpha-keyed sheet views as world-scaled planes,
// so a moved bone can be checked against the actual art, not just the loft
// mesh's approximation of it. Front/back sit back-to-back through x=0/z~0
// (theta=0 in loft-mesh.mjs's ring convention is front, facing -Z); side is
// rotated 90 deg through the same centreline (theta=90deg, facing +X). See
// tools/characters/loft-mesh.mjs's header for that convention.
const referenceGroup = new THREE.Group()
scene.add(referenceGroup)
const textureLoader = new THREE.TextureLoader()

async function loadReferenceCards(id, heightM) {
  for (const child of [...referenceGroup.children]) {
    referenceGroup.remove(child)
    child.geometry.dispose()
    child.material.map?.dispose()
    child.material.dispose()
  }

  // Front and back are coplanar (both span X/Y, normal along Z) -- true
  // z-fighting risk, so they get a small separation ALONG THEIR OWN NORMAL
  // (world Z). Side is rotated 90deg so its normal is along world X instead;
  // it never shares a plane with front/back, so it needs no offset at all --
  // giving it one (as a previous version of this code did, along the wrong
  // axis) just made it slide off the shared centreline.
  const specs = [
    { view: 'front', rotationY: 0, offsetZ: 0.004, mirrorU: false },
    { view: 'back', rotationY: Math.PI, offsetZ: -0.004, mirrorU: true },
    { view: 'side', rotationY: Math.PI / 2, offsetZ: 0, mirrorU: true },
  ]

  await Promise.all(specs.map(async (spec) => {
    try {
      const res = await fetch(`/__sheet-reference?id=${encodeURIComponent(id)}&view=${spec.view}`)
      const j = await res.json()
      if (!res.ok || !j.exists) return
      const tex = await textureLoader.loadAsync(`data:image/png;base64,${j.imageB64}`)
      tex.colorSpace = THREE.SRGBColorSpace
      // The back sheet is a straight photo of the character's back, not a
      // mirror of the front -- so the character's own left shows up on the
      // viewer's left in the back image, same screen-side as the front image
      // shows the character's right. Flipping U here is what makes the two
      // cards' edges (shoulders, hips) actually land on the same world-X
      // line instead of swapping sides.
      if (spec.mirrorU) { tex.wrapS = THREE.RepeatWrapping; tex.repeat.x = -1; tex.offset.x = 1 }
      const geo = new THREE.PlaneGeometry(j.worldWidthM, j.worldHeightM)
      // alphaTest cutout, not alpha blending -- same convention as the tree/
      // rock crossed-plane impostors (src/props/impostor.js). A blended
      // transparent plane writes no depth (depthWrite:false is required to
      // avoid it self-occluding its own soft edges) which means THREE
      // crossed cards have no depth information to sort by at all -- three.js
      // falls back to draw order, so whichever card is added last paints over
      // the other two regardless of which is actually nearer the camera. An
      // alphaTest cutout is opaque everywhere it draws, writes real depth,
      // and lets the three planes occlude each other correctly like the
      // solid geometry they're standing in for.
      const mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.rotation.y = spec.rotationY
      mesh.position.y = j.worldHeightM / 2
      mesh.position.z = spec.offsetZ
      mesh.userData.refView = spec.view
      referenceGroup.add(mesh)
    } catch { /* reference cards are a visual aid -- a fetch failure just leaves that card off */ }
  }))
  applyReferenceUI()
}

function applyReferenceUI() {
  const visible = document.getElementById('refToggle').checked
  const opacity = Number(document.getElementById('refOpacity').value)
  for (const child of referenceGroup.children) {
    child.visible = visible
    child.material.opacity = opacity
    // Full opacity stays an alphaTest cutout (opaque, depth-correct -- see the
    // comment where this material is built) so the three cards intersect
    // properly. Dialing opacity down is an explicit request to see through
    // them, which brings back blending's draw-order ambiguity -- an accepted
    // trade for that view, not the default state.
    child.material.transparent = opacity < 1
    child.material.needsUpdate = true
  }
}
document.getElementById('refToggle').addEventListener('change', applyReferenceUI)
document.getElementById('refOpacity').addEventListener('input', applyReferenceUI)

// --- mesh opacity: dial the loaded character mesh down to see the
// reference cards (or the skeleton) through it, for comparing the loft
// mesh's silhouette against the source art. Blended like the reference
// cards below full opacity, for the same draw-order-ambiguity trade-off --
// this mesh is convex-ish per limb so the artifact is minor.
function applyMeshOpacityUI() {
  const opacity = Number(document.getElementById('meshOpacity').value)
  if (!root) return
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
      mat.opacity = opacity
      mat.transparent = opacity < 1
      mat.depthWrite = opacity >= 1
      mat.needsUpdate = true
    }
  })
}
document.getElementById('meshOpacity').addEventListener('input', applyMeshOpacityUI)

function setCameraPreset(preset) {
  const eyeY = currentHeightM * 0.55
  const d = Math.max(2, currentHeightM * 1.8)
  controls.target.set(0, eyeY, 0)
  if (preset === 'front') camera.position.set(0, eyeY, d)
  else if (preset === 'back') camera.position.set(0, eyeY, -d)
  else if (preset === 'side') camera.position.set(d, eyeY, 0)
  else camera.position.set(d * 0.75, eyeY + currentHeightM * 0.3, d * 0.75)
}
document.getElementById('camFront').addEventListener('click', () => setCameraPreset('front'))
document.getElementById('camSide').addEventListener('click', () => setCameraPreset('side'))
document.getElementById('camBack').addEventListener('click', () => setCameraPreset('back'))
document.getElementById('camIso').addEventListener('click', () => setCameraPreset('iso'))

async function loadCharacter(id) {
  setStatus(`loading ${id}...`)
  currentId = id
  document.getElementById('charId').value = id
  if (rosterSelect && roster.some((c) => c.id === id)) rosterSelect.value = id
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

    try {
      const metaRes = await fetch(`/characters/${id}/meta.json`)
      currentHeightM = metaRes.ok ? (await metaRes.json()).heightM : 1.7
    } catch { currentHeightM = 1.7 }
    controls.target.set(0, currentHeightM * 0.55, 0)
    applyMeshOpacityUI()
    await loadReferenceCards(id, currentHeightM)

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

// --- roster picker: same pattern as gen-sheet.html's -- load any baked
// character straight from tools/characters/characters.json instead of typing
// its id by hand.
const rosterSelect = document.getElementById('roster')
let roster = []

fetch('/tools/characters/characters.json')
  .then((r) => r.json())
  .then((j) => {
    roster = j.characters
    for (const c of roster) {
      const opt = document.createElement('option')
      opt.value = c.id
      opt.textContent = c.id
      rosterSelect.appendChild(opt)
    }
    if (roster.some((c) => c.id === document.getElementById('charId').value.trim())) {
      rosterSelect.value = document.getElementById('charId').value.trim()
    }
  })
  .catch(() => {}) // roster is optional -- the bench still works with a typed id without it

rosterSelect.addEventListener('change', () => {
  if (!rosterSelect.value) return
  document.getElementById('charId').value = rosterSelect.value
  loadCharacter(rosterSelect.value)
})
document.getElementById('rosterPrev').addEventListener('click', () => stepRoster(-1))
document.getElementById('rosterNext').addEventListener('click', () => stepRoster(1))

function stepRoster(delta) {
  if (!roster.length) return
  const i = roster.findIndex((r) => r.id === rosterSelect.value)
  const next = roster[(i < 0 ? 0 : i + delta + roster.length) % roster.length]
  rosterSelect.value = next.id
  document.getElementById('charId').value = next.id
  loadCharacter(next.id)
}

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
