// ---------------------------------------------------------------------------
// gen-tree-v9.html: the solid-tree bench. Candidate image (OpenRouter) -> solid
// mesh (Tripo image-to-model) -> decimation (ours) -> painting (ours), each
// stage previewed before the next one is paid for. Design §28.
//
// The page holds no API keys and does no vendor arithmetic: vite.config.js's
// treeGen() endpoints own both, and every response carries the credits it
// actually charged, which is what the ledger sums.
//
// THE PAINT STAGE IS THE POINT and the two before it are how the surface it
// paints gets made. It never solves an unwrap: src/mesh/paint.js projects each
// face's UV from its world position, so texel density is constant, the atlas's
// RepeatWrapping does the tiling, and the exported attributes -- position,
// normal, uvProj, texLayer -- are exactly what createPropMaterial compiles
// against and what every rock in this world already carries.
//
// THE ATLAS HERE IS BENCH-LOCAL. The _solid foliage mats are on disk but are not
// yet registered layers in src/textures.js, so the preview builds its own
// DataArrayTexture out of whichever pool files are in the slot table. The slot's
// `layer` column is the world layer the export writes into texLayer, and
// paint.json names the file behind each slot -- so promoting these textures into
// the world atlas stays a separate edit, and nothing here silently depends on
// having already made it.
// ---------------------------------------------------------------------------

import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { analyzeMesh, decimateLadder } from './mesh/decimate.js'
import {
  buildFaceAdjacency, buildPaintedMesh, faceFrames, facesInSphere, floodFill,
  groundAndScale, unweld,
} from './mesh/paint.js'

const $ = (id) => document.getElementById(id)
const status = $('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

const TEX_SIZE = 128

let library = []      // every tree the bench knows about: species seeds + anything on disk
let credits = {}      // mesh price, bare and textured, from the server's own table
let pool = []         // every PNG a face could wear
let candidates = []
let assets = { source: false, mesh: false, meshes: [], painted: false, lods: [], state: {} }
let lodTiers = []     // in-memory decimation output for the mesh currently loaded
let pendingImages = 0 // generations in flight, drawn as placeholders in each gallery
let pendingMeshes = 0
let meshCooling = false
const ledger = []

const currentId = () => $('treeId').value.trim()

// --- ledger -----------------------------------------------------------------

function bill(what, usd) {
  ledger.push({ what, usd })
  const rows = ledger.map((e) => `<div><span>${e.what}</span><span>$${e.usd.toFixed(3)}</span></div>`).join('')
  const total = ledger.reduce((s, e) => s + e.usd, 0)
  $('ledger').innerHTML = `${rows}<div class="total"><span>total this session</span><span>$${total.toFixed(3)}</span></div>`
}

// --- species, library, pool --------------------------------------------------

async function loadSpecies() {
  const j = await (await fetch('/__tree9-species')).json()
  if (!j.ok) throw new Error(j.error)
  credits = j.credits
  if (!j.hasTripoKey) setStatus('TRIPO_API_KEY is not set -- the mesh step will fail until it is in .env', 'warn')
  updateMeshPrice()
}

function updateMeshPrice() {
  const c = $('wantTexture').checked ? credits.meshTextured : credits.meshBare
  $('genMesh').textContent = `generate mesh ($${(c / 100).toFixed(2)})`
}

/**
 * Reads the Tripo wallet at startup. Costs nothing, and it is the difference
 * between "the pipeline is broken" and "the wallet is empty" -- two failures
 * that look identical from inside a spend button.
 */
async function loadBalance() {
  const box = $('balance')
  const res = await fetch('/__tree9-balance')
  const j = await res.json()
  if (!res.ok) { box.innerHTML = `<span class="warn">could not read balance: ${j.error}</span>`; return }
  const need = credits.meshBare
  box.innerHTML = `${j.balance} credits ($${(j.balance / 100).toFixed(2)})${j.frozen ? ` &middot; ${j.frozen} frozen` : ''}` +
    (j.balance >= need ? '' : `<br><span class="warn">not enough for a mesh (${need} credits) -- top up at tripo3d.ai</span>`)
}

/**
 * The species list is a SEED, not the truth: anything with a directory under
 * work/ counts too, which is how a tree invented in this page keeps its prompt
 * across a reload. The server merges the two; this draws the result.
 */
async function loadLibrary() {
  const j = await (await fetch('/__tree9-list')).json()
  if (!j.ok) throw new Error(j.error)
  library = j.trees

  const sel = $('roster')
  const keep = sel.value
  sel.innerHTML = ''
  for (const t of library) {
    const opt = document.createElement('option')
    opt.value = t.id
    opt.textContent = `${t.label ?? t.id}${t.seeded ? '' : ' *'}`
    sel.appendChild(opt)
  }
  if (keep) sel.value = keep
  renderLibrary()
}

function renderLibrary() {
  const grid = $('libGrid')
  grid.innerHTML = ''
  const current = currentId()
  for (const t of library) {
    const card = document.createElement('div')
    card.className = `card${t.id === current ? ' is-current' : ''}`
    const chips = [
      t.has.source ? '<span class="chip on">image</span>' : '<span class="chip">no image</span>',
      t.has.mesh ? '<span class="chip on">mesh</span>' : '<span class="chip">no mesh</span>',
      t.lodCount ? `<span class="chip on">${t.lodCount} lod</span>` : '',
      t.has.painted ? '<span class="chip on">painted</span>' : '',
      t.usd > 0 ? `<span class="chip cost">$${t.usd.toFixed(2)}</span>` : '',
    ].filter(Boolean).join('')
    card.innerHTML =
      `<div class="top">${t.thumbUrl ? `<img src="${t.thumbUrl}" alt="" />` : '<div class="noimg">no image</div>'}` +
      `<div><div class="name">${t.label ?? t.id}</div><div class="label">${t.id} &middot; ${t.heightM}m</div></div></div>` +
      `<div class="prompt">${t.description ?? ''}</div><div class="chips">${chips}</div>`
    card.addEventListener('click', () => {
      $('library').classList.remove('on')
      loadTree(t.id).catch((e) => setStatus(e.message, 'warn'))
    })
    grid.appendChild(card)
  }
}

/**
 * Every PNG on disk that a face could wear. Oversized files are listed and
 * refused rather than hidden: this world's atlas is 128px square per layer
 * (src/textures.js TEX_SIZE), and a texture that vanished for a reason you
 * cannot see is worse than one that is present and says why it will not go in.
 */
async function loadPool() {
  const j = await (await fetch('/__tree9-pool')).json()
  if (!j.ok) throw new Error(j.error)
  pool = j.textures
  renderPool()
}

function renderPool() {
  const box = $('pool')
  box.innerHTML = ''
  const used = new Set(paint.slots.map((s) => s.file))
  for (const tex of pool) {
    const el = document.createElement('div')
    el.className = `swatch${tex.usable ? '' : ' bad'}${used.has(tex.file) ? ' used' : ''}`
    el.innerHTML = `<img src="${tex.url}" alt="" /><div class="n">${tex.name}${tex.usable ? '' : `<br>${tex.width}x${tex.height}`}</div>`
    el.addEventListener('click', () => {
      if (!paint.mesh) {
        setStatus('load a mesh for painting first -- a slot is a region of a surface, and there is no surface yet', 'warn')
        return
      }
      if (!tex.usable) {
        setStatus(`${tex.name} is ${tex.width}x${tex.height} -- the atlas is ${TEX_SIZE}px square per layer, so this file has to be resized before it can be worn`, 'warn')
        return
      }
      addSlot(tex).catch((e) => setStatus(e.message, 'warn'))
    })
    box.appendChild(el)
  }
}

// --- the tree being worked on ------------------------------------------------

async function loadTree(id) {
  const t = library.find((x) => x.id === id)
  if (!t) throw new Error(`no tree "${id}" in the library`)
  $('treeId').value = t.id
  $('label').value = t.label ?? t.id
  $('heightM').value = t.heightM ?? 10
  $('crown').value = t.crown ?? ''
  $('trunk').value = t.trunk ?? ''
  $('description').value = t.description ?? ''
  $('roster').value = t.id
  clearPaint()
  clearLods()
  await refresh()
}

function stepRoster(dir) {
  const i = library.findIndex((t) => t.id === currentId())
  const next = library[(i + dir + library.length) % library.length]
  if (next) loadTree(next.id).catch((e) => setStatus(e.message, 'warn'))
}

/** What is on disk right now. The stage buttons gate on this rather than on what
 *  happened this session, so a reload mid-pipeline resumes instead of restarting. */
async function refresh() {
  const id = currentId()
  if (!/^[a-z0-9-]+$/.test(id)) { setStatus('an id is lowercase letters, digits and hyphens', 'warn'); return }
  const [cj, aj] = await Promise.all([
    fetch(`/__tree9-candidates?id=${encodeURIComponent(id)}`).then((r) => r.json()),
    fetch(`/__tree9-assets?id=${encodeURIComponent(id)}`).then((r) => r.json()),
  ])
  if (!cj.ok) throw new Error(cj.error)
  if (!aj.ok) throw new Error(aj.error)
  candidates = cj.candidates
  assets = aj

  renderGallery()
  renderMeshGallery()
  renderPaintSources()
  // Through the cooldown's own rule: a mesh queued a moment ago must not be
  // re-enabled early by a refresh that lands inside its second.
  if (!meshCooling) $('genMesh').disabled = !assets.source
  $('genLod').disabled = !assets.mesh
  $('startPaint').disabled = !assets.mesh
  renderLibrary()
}

function renderGallery() {
  const g = $('gallery')
  g.innerHTML = ''
  for (const c of candidates) {
    const el = document.createElement('div')
    el.className = `candidate${c.picked ? ' is-picked' : ''}`
    el.innerHTML = `<img src="${c.url}" alt="" /><div class="cost">${c.file} &middot; $${(c.cost ?? 0).toFixed(4)}</div>`
    const btn = document.createElement('button')
    btn.textContent = c.picked ? 'picked' : 'pick'
    btn.className = c.picked ? 'on' : ''
    btn.addEventListener('click', () => pickCandidate(c.file).catch((e) => setStatus(e.message, 'warn')))

    const trash = document.createElement('button')
    trash.className = 'trash'
    trash.innerHTML = '&#128465;'
    trash.title = `delete ${c.file}`
    // Confirmed, unlike every other click in this gallery: the image cost money
    // and this exact one cannot be generated again.
    trash.addEventListener('click', () => {
      if (!window.confirm(`Delete candidate ${c.file}? It cost $${(c.cost ?? 0).toFixed(4)} and cannot be regenerated identically.`)) return
      withButton(trash, `deleting ${c.file}`, async () => {
        await post(`/__tree9-delete-candidate?id=${encodeURIComponent(currentId())}`, { file: c.file })
        await refresh()
        setStatus(`deleted ${c.file}`, 'ok')
      })
    })

    el.append(btn, trash)
    g.appendChild(el)
  }
  // One placeholder per generation still in flight, so a second click has
  // somewhere visible to land while the first request is still running.
  for (let i = 0; i < pendingImages; i++) {
    const el = document.createElement('div')
    el.className = 'candidate pending'
    el.innerHTML = '<div class="noshot">generating&hellip;</div>'
    g.appendChild(el)
  }
  if (!candidates.length && !pendingImages) g.innerHTML = '<p class="label">no candidates yet -- generate one</p>'
}

// Every one of these cost 40-50 credits and Tripo has no task-history endpoint
// to re-fetch a lost one from, so they are listed and picked between, never
// replaced. Picking copies one over mesh.glb, which is all the later stages read.
function renderMeshGallery() {
  const g = $('meshGallery')
  g.innerHTML = ''
  for (const m of assets.meshes ?? []) {
    const el = document.createElement('div')
    el.className = `candidate${m.picked ? ' is-picked' : ''}`
    el.innerHTML = m.previewUrl
      ? `<img src="${m.previewUrl}" alt="" />`
      : '<div class="noshot">no preview</div>'
    const cost = document.createElement('div')
    cost.className = 'cost'
    cost.textContent = `${m.file} · ${m.credits} credits${m.params?.texture ? ' · textured' : ''}`
    const btn = document.createElement('button')
    btn.textContent = m.picked ? 'working mesh' : 'use this one'
    btn.className = m.picked ? 'on' : ''
    btn.addEventListener('click', () => withButton(btn, `picking ${m.file}`, async () => {
      const j = await post(`/__tree9-pick-mesh?id=${encodeURIComponent(currentId())}`, { file: m.file })
      // Tiers and paint came off the mesh that was working a moment ago; keeping
      // them would file that mesh's work under this one's name.
      clearLods()
      clearPaint()
      await refresh()
      await showMesh()
      setStatus(`working mesh -> ${j.path}`, 'ok')
    }))
    el.append(cost, btn)
    g.appendChild(el)
  }
  for (let i = 0; i < pendingMeshes; i++) {
    const el = document.createElement('div')
    el.className = 'candidate pending'
    el.innerHTML = '<div class="noshot">generating&hellip;<br />about a minute</div>'
    g.appendChild(el)
  }
  if (!(assets.meshes ?? []).length && !pendingMeshes) {
    g.innerHTML = '<p class="label">no meshes yet -- pick an image above, then generate one</p>'
  }
}

// --- actions -----------------------------------------------------------------

async function withButton(btn, label, fn) {
  const original = btn.textContent
  btn.disabled = true
  setStatus(label)
  try {
    await fn()
  } catch (e) {
    setStatus(`${label} failed: ${e.message}`, 'warn')
  } finally {
    btn.disabled = false
    btn.textContent = original
  }
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error)
  return j
}

$('saveMeta').addEventListener('click', () => withButton($('saveMeta'), 'saving', async () => {
  const j = await post(`/__tree9-save?id=${encodeURIComponent(currentId())}`, {
    label: $('label').value.trim(),
    heightM: Number($('heightM').value),
    crown: $('crown').value.trim(),
    trunk: $('trunk').value.trim(),
    description: $('description').value.trim(),
  })
  $('metaOut').textContent = `saved ${j.tree.id}`
  await loadLibrary()
  $('roster').value = j.tree.id
  await refresh()
  setStatus(`saved ${j.tree.id}`, 'ok')
}))

$('newTree').addEventListener('click', () => {
  $('treeId').value = ''
  $('label').value = ''
  $('metaOut').textContent = 'give it an id, a crown clause, a trunk clause and a description, then save'
  clearPaint()
  clearLods()
})

// Both generators QUEUE rather than block. An image is a few seconds and a Tripo
// mesh about a minute, and four of either in flight take the same wall clock as
// one, so holding the button until the answer lands was costing four minutes to
// look at four candidates. The button still goes dead for a second, which is
// what keeps a double-click from buying two.
const QUEUE_COOLDOWN_MS = 1000

$('genImage').addEventListener('click', () => {
  const btn = $('genImage')
  btn.disabled = true
  window.setTimeout(() => { btn.disabled = false }, QUEUE_COOLDOWN_MS)
  queueImage()
})

async function queueImage() {
  // Read now, not when the response lands: the clauses are editable and a queued
  // generation belongs to the words that were on screen when it was asked for.
  const body = {
    id: currentId(),
    description: $('description').value.trim(),
    crown: $('crown').value.trim(),
    trunk: $('trunk').value.trim(),
  }
  pendingImages++
  renderGallery()
  setStatus(`generating ${pendingImages} candidate image${pendingImages === 1 ? '' : 's'}`)
  try {
    const j = await post('/__tree9-image', body)
    bill('image', j.cost)
    pendingImages--
    await refresh()
    setStatus(`candidate saved (${j.file}), $${j.cost.toFixed(4)}${pendingImages ? ` -- ${pendingImages} still generating` : ''}`, 'ok')
  } catch (e) {
    pendingImages--
    renderGallery()
    setStatus(`generating candidate image failed: ${e.message}`, 'warn')
  }
}

async function pickCandidate(file) {
  const j = await post(`/__tree9-pick?id=${encodeURIComponent(currentId())}`, { file })
  await refresh()
  setStatus(`picked -> ${j.path}`, 'ok')
}

$('genMesh').addEventListener('click', () => {
  meshCooling = true
  $('genMesh').disabled = true
  window.setTimeout(() => {
    meshCooling = false
    // Through refresh's own rule rather than straight to enabled: source.png may
    // have gone away while this was cooling.
    $('genMesh').disabled = !assets.source
  }, QUEUE_COOLDOWN_MS)
  queueMesh()
})

async function queueMesh() {
  // Read now, for the reason queueImage gives: the face limit and the texture
  // box stay live, and a queued mesh belongs to the settings it was asked for
  // with. The tree id too -- a mesh takes a minute, and switching trees meanwhile
  // must not file the result under whichever one is on screen when it lands.
  const id = currentId()
  const body = { faceLimit: Number($('faceLimit').value), texture: $('wantTexture').checked }
  pendingMeshes++
  renderMeshGallery()
  setStatus(`generating ${pendingMeshes} mesh${pendingMeshes === 1 ? '' : 'es'} (Tripo, about a minute each)`)
  try {
    const j = await post(`/__tree9-mesh?id=${encodeURIComponent(id)}`, body)
    bill('mesh', j.credits / 100)
    pendingMeshes--
    // Only when this mesh became the working one. A candidate that landed beside
    // an already-picked mesh changes nothing, and throwing away tiers or a paint
    // job for it would be destroying work the click never touched.
    if (j.autoPicked) { clearLods(); clearPaint() }
    await refresh()
    if (j.autoPicked) await showMesh()
    setStatus(`mesh ${j.file} -> ${j.path} (${j.credits} credits)${pendingMeshes ? ` -- ${pendingMeshes} still generating` : ''}`, 'ok')
  } catch (e) {
    pendingMeshes--
    renderMeshGallery()
    setStatus(`generating mesh failed: ${e.message}`, 'warn')
  }
}

// --- 3D preview ---------------------------------------------------------------

const canvas = $('viewCanvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, 560 / 420, 0.01, 500)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a1420, 1.1))
const sun = new THREE.DirectionalLight(0xfff3e2, 1.6)
sun.position.set(1, 1.5, 1)
scene.add(sun)

const orbit = new OrbitControls(camera, renderer.domElement)
orbit.enableDamping = true
// The left button paints, so orbiting moves to the right one. Both stay bound
// the whole session rather than swapping with the mode: a control that means
// two things depending on a state you cannot see is one misplaced stroke away
// from repainting a trunk you had finished.
orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }

const loader = new GLTFLoader()
let model = null

function clearModel() {
  if (model) {
    scene.remove(model)
    if (!model.userData.borrowed) {
      model.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()) })
    }
    model = null
  }
  $('viewer').classList.remove('on')
}

/** Frames the camera on the model's own bounds. Tripo's output scale is its own
 *  business until groundAndScale has run, so the declared height is a claim
 *  about the tree and not about the file that came back. */
function frameModel() {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const span = Math.max(size.x, size.y, size.z) || 1
  camera.position.set(centre.x + span * 1.5, centre.y + span * 0.5, centre.z + span * 1.5)
  camera.near = span / 100
  camera.far = span * 50
  camera.updateProjectionMatrix()
  orbit.target.copy(centre)
  orbit.update()
  return span
}

/** Cache-busted: every re-run rewrites the same path, and without this the
 *  loader serves the previous generation's bytes and the mesh appears not to
 *  have changed at all. */
const workUrl = (id, file) => `/tools/trees/v9/work/${encodeURIComponent(id)}/${file}?t=${Date.now()}`

async function loadGeometry(file) {
  const gltf = await loader.loadAsync(workUrl(currentId(), file))
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
  // Loud rather than clever: silently taking the first of several would look
  // like it worked and would paint a third of a tree.
  if (meshes.length !== 1) throw new Error(`expected one mesh in ${file}, found ${meshes.length}`)
  meshes[0].updateWorldMatrix(true, false)
  const g = meshes[0].geometry.clone()
  g.applyMatrix4(meshes[0].matrixWorld)
  return { geometry: g, material: meshes[0].material }
}

async function showMesh() {
  const { geometry, material } = await loadGeometry('mesh.glb')
  clearModel()
  model = new THREE.Mesh(geometry, material)
  model.material.wireframe = $('showWire').checked
  scene.add(model)
  const span = frameModel()
  const tris = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3
  $('meshStats').innerHTML = `mesh.glb: ${Math.round(tris)} tris &middot; ${span.toFixed(2)}m longest side (Tripo's own scale, not the world's)`
  $('viewer').classList.add('on')
  setSize()
}

// --- decimation ---------------------------------------------------------------

/** glTF geometry to the plain arrays decimate.js and paint.js both speak. UVs
 *  are optional here, unlike on the creature bench: with `texture` off there is
 *  no atlas to preserve and the ladder runs in drop mode regardless. */
function toPlainMesh(geometry) {
  const pos = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  const normal = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  return {
    positions: Float32Array.from(pos.array),
    uvs: uv ? Float32Array.from(uv.array) : null,
    normals: normal ? Float32Array.from(normal.array) : null,
    indices: index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i),
  }
}

/** "60%, 30%" or "600, 300" or a mix. Percentages are of the input. */
function parseTargets(text, inputTris) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('no targets given')
  return parts.map((p) => {
    const pct = p.endsWith('%')
    const n = Number(p.replace('%', ''))
    if (!Number.isFinite(n) || n <= 0) throw new Error(`"${p}" is not a target -- want a triangle count or a percentage`)
    const tris = Math.round(pct ? (inputTris * n) / 100 : n)
    if (tris < 4) throw new Error(`"${p}" works out to ${tris} triangles, which is not a mesh`)
    return tris
  })
}

function clearLods() {
  lodTiers = []
  $('lodWrap').classList.remove('on')
  $('lodTable').innerHTML = ''
  $('meshAnalysis').textContent = ''
  $('saveLod').disabled = true
}

$('genLod').addEventListener('click', () => withButton($('genLod'), 'decimating', async () => {
  const { geometry } = await loadGeometry('mesh.glb')
  const plain = toPlainMesh(geometry)
  const analysis = analyzeMesh(plain)
  $('meshAnalysis').innerHTML =
    `${analysis.tris} tris, ${analysis.points} welded points &middot; ` +
    `${analysis.lockedPoints} pinned &middot; ${analysis.lockedFaces} unremovable faces &middot; ` +
    `quads ${Math.round(analysis.quadFraction * 100)}%`

  const targets = parseTargets($('lodTargets').value, analysis.tris)
  // 'drop', not 'auto'. The paint stage replaces every UV in the file, so an
  // atlas preserved here is an atlas discarded ten minutes later at the cost of
  // every seam vertex it pinned on the way.
  const tiers = decimateLadder(plain, targets, { uvMode: 'drop' })
  lodTiers = tiers.map((t, i) => ({ level: i + 1, mesh: t, stats: t.stats }))

  renderLodTable()
  renderPaintSources()
  $('saveLod').disabled = false
  await showTier(lodTiers[0])
  setStatus(`${lodTiers.length} tier(s) built locally, $0.000`, 'ok')
}))

function renderLodTable() {
  const t = $('lodTable')
  t.innerHTML = '<tr><th>tier</th><th>target</th><th>got</th><th>reduction</th><th>why it stopped</th></tr>'
  for (const tier of lodTiers) {
    const s = tier.stats
    const tr = document.createElement('tr')
    tr.innerHTML =
      `<td>lod${tier.level}</td><td>${s.targetTris}</td><td>${s.outputTris}</td>` +
      `<td>${Math.round(s.reduction * 100)}%</td><td class="label">${s.reason}</td>`
    tr.style.cursor = 'pointer'
    tr.addEventListener('click', () => showTier(tier).catch((e) => setStatus(e.message, 'warn')))
    t.appendChild(tr)
  }
  $('lodWrap').classList.add('on')
}

function tierGeometry(tier) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(tier.mesh.positions, 3))
  if (tier.mesh.normals) g.setAttribute('normal', new THREE.BufferAttribute(tier.mesh.normals, 3))
  g.setIndex(new THREE.BufferAttribute(tier.mesh.indices, 1))
  if (!tier.mesh.normals) g.computeVertexNormals()
  return g
}

async function showTier(tier) {
  clearModel()
  model = new THREE.Mesh(tierGeometry(tier), new THREE.MeshStandardMaterial({ color: 0x8fa8c0, flatShading: true }))
  model.material.wireframe = $('showWire').checked
  scene.add(model)
  frameModel()
  $('meshStats').textContent =
    `lod${tier.level}: ${tier.stats.outputTris} tris (asked ${tier.stats.targetTris}, from ${tier.stats.inputTris}) -- ` +
    `${tier.stats.collapses} collapses`
  $('viewer').classList.add('on')
  setSize()
}

$('saveLod').addEventListener('click', () => withButton($('saveLod'), 'writing tiers', async () => {
  const id = currentId()
  const exporter = new GLTFExporter()
  for (const tier of lodTiers) {
    const mesh = new THREE.Mesh(tierGeometry(tier), new THREE.MeshStandardMaterial())
    const glb = await exporter.parseAsync(mesh, { binary: true })
    const res = await fetch(`/__tree9-lod?id=${encodeURIComponent(id)}&level=${tier.level}`, {
      method: 'POST', headers: { 'content-type': 'model/gltf-binary' }, body: glb,
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
  }
  await refresh()
  await loadLibrary()
  $('roster').value = id
  setStatus(`${lodTiers.length} tier(s) written to work/${id}/, $0.000`, 'ok')
}))

// --- painting -----------------------------------------------------------------

const paint = {
  mesh: null,        // unwelded, grounded and scaled: what every index below refers to
  frames: null,      // per-face normals and centroids
  adjacency: null,
  faceSlot: null,    // Int16Array, one slot id per face, -1 for unpainted
  slots: [],         // { file, name, url, projection, tileMetres, layer, image }
  active: 0,
  report: [],        // what projectUvs actually achieved, per slot
  geometry: null,
  atlas: null,
  undo: [],
  source: null,
}

function clearPaint() {
  paint.mesh = null
  paint.frames = null
  paint.adjacency = null
  paint.faceSlot = null
  paint.slots = []
  paint.report = []
  paint.undo = []
  paint.source = null
  paint.geometry = null
  if (paint.atlas) { paint.atlas.dispose(); paint.atlas = null }
  $('slotWrap').classList.remove('on')
  $('slotTable').innerHTML = ''
  $('savePaint').disabled = true
  $('autoSeed').disabled = true
  $('undoPaint').disabled = true
  renderPool()
}

/**
 * The preview material. Deliberately NOT createPropMaterial: that one is wired
 * to the world's snow, moss, wind and lighting uniforms and would need all of
 * them fed per frame to show anything at all. What matters here is the one line
 * it shares -- sampling the array texture at (uvProj, texLayer) -- so the paint
 * job is judged on the same lookup that will ship.
 *
 * The atlas goes in as NoColorSpace and comes out unconverted, which puts the
 * PNG's own bytes on screen: a preview whose job is "does this texture look
 * right at this size" should not be showing it through a colour transform.
 *
 * Written in GLSL1 spelling on purpose. A non-raw ShaderMaterial is compiled to
 * #version 300 es either way, and leaving `glslVersion` unset is what keeps
 * three's own `gl_FragColor` output declaration -- setting GLSL3 drops it and
 * the shader stops linking for a reason that reads as nothing.
 */
function paintMaterial(atlas) {
  return new THREE.ShaderMaterial({
    uniforms: { uAtlas: { value: atlas }, uFlagUnpainted: { value: 1 } },
    vertexShader: `
      attribute vec2 uvProj;
      attribute float texLayer;
      attribute float unpainted;
      varying vec2 vUvProj;
      varying float vLayer;
      varying float vUnpainted;
      varying vec3 vNormal;
      void main() {
        vUvProj = uvProj;
        vLayer = texLayer;
        vUnpainted = unpainted;
        vNormal = normalize( normalMatrix * normal );
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
      }`,
    fragmentShader: `
      precision highp sampler2DArray;
      uniform sampler2DArray uAtlas;
      uniform float uFlagUnpainted;
      varying vec2 vUvProj;
      varying float vLayer;
      varying float vUnpainted;
      varying vec3 vNormal;
      void main() {
        vec3 c = texture( uAtlas, vec3( vUvProj, vLayer ) ).rgb;
        // Flat key light plus a floor, so facets read as facets. Any softer and
        // a low-poly crown reads as a balloon and the paint job gets blamed.
        float k = 0.45 + 0.55 * max( dot( normalize( vNormal ), normalize( vec3( 0.4, 0.8, 0.5 ) ) ), 0.0 );
        c *= k;
        if ( uFlagUnpainted > 0.5 && vUnpainted > 0.5 ) c = mix( c, vec3( 0.9, 0.1, 0.5 ), 0.75 );
        gl_FragColor = vec4( c, 1.0 );
      }`,
  })
}

/** One 128px layer per slot, in slot order. Rebuilt whenever the slot list
 *  changes -- a DataArrayTexture's depth is fixed at construction. */
async function rebuildAtlas() {
  const n = Math.max(1, paint.slots.length)
  const data = new Uint8Array(TEX_SIZE * TEX_SIZE * 4 * n)
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  ctx.canvas.width = TEX_SIZE
  ctx.canvas.height = TEX_SIZE
  for (let i = 0; i < paint.slots.length; i++) {
    ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE)
    ctx.drawImage(paint.slots[i].image, 0, 0, TEX_SIZE, TEX_SIZE)
    data.set(ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data, i * TEX_SIZE * TEX_SIZE * 4)
  }
  const tex = new THREE.DataArrayTexture(data, TEX_SIZE, TEX_SIZE, n)
  tex.format = THREE.RGBAFormat
  tex.type = THREE.UnsignedByteType
  // The world atlas tags itself sRGB and lets the shipping material convert on
  // the way out. This shader has no output conversion, so tagging it would show
  // every texture through half a transform; untagged, the PNG's bytes land on
  // screen unchanged, which is what a "does this read at this size" preview owes.
  tex.colorSpace = THREE.NoColorSpace
  // The whole projection scheme rests on this: each layer owns its own full
  // [0,1], so a uvProj of 3.7 is three tiles and a bit rather than a clamp.
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  if (paint.atlas) paint.atlas.dispose()
  paint.atlas = tex
  if (model?.material?.uniforms) model.material.uniforms.uAtlas.value = tex
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`could not load ${url}`))
    img.src = url
  })
}

/**
 * Adds a texture to the slot table. `tileMetres` is how many metres one tile of
 * the texture covers, and it is the only size control there is -- there is no
 * per-face scale, by design, because a per-face scale is how texel density stops
 * being constant.
 */
async function addSlot(tex, opts = {}) {
  if (paint.slots.some((s) => s.file === tex.file)) { setStatus(`${tex.name} is already a slot`, 'warn'); return }
  const image = await loadImage(tex.url)
  paint.slots.push({
    file: tex.file,
    name: tex.name,
    url: tex.url,
    image,
    projection: opts.projection ?? 'planar',
    tileMetres: opts.tileMetres ?? 2,
    // Defaults to the slot's own index, which is the bench atlas's layer. It is
    // editable because the export writes it into texLayer, and the world atlas
    // (src/textures.js) numbers its layers on its own terms.
    layer: opts.layer ?? paint.slots.length,
  })
  await rebuildAtlas()
  renderSlots()
  renderPool()
  if (paint.mesh) refreshPaintGeometry()
  return paint.slots.length - 1
}

function removeSlot(i) {
  if (paint.slots.length <= 1) { setStatus('a painted mesh needs at least one slot', 'warn'); return }
  paint.slots.splice(i, 1)
  // Faces pointing at the removed slot go unpainted rather than silently
  // sliding onto its neighbour, and everything above it shifts down.
  for (let f = 0; f < paint.faceSlot.length; f++) {
    if (paint.faceSlot[f] === i) paint.faceSlot[f] = -1
    else if (paint.faceSlot[f] > i) paint.faceSlot[f]--
  }
  if (paint.active >= paint.slots.length) paint.active = paint.slots.length - 1
  rebuildAtlas().then(() => { renderSlots(); renderPool(); refreshPaintGeometry() }).catch((e) => setStatus(e.message, 'warn'))
}

function renderSlots() {
  const t = $('slotTable')
  t.innerHTML = '<tr><th></th><th>texture</th><th>projection</th><th>metres/tile</th><th>world layer</th><th>faces</th><th>achieved</th><th></th></tr>'
  paint.slots.forEach((s, i) => {
    const r = paint.report[i]
    const tr = document.createElement('tr')
    if (i === paint.active) tr.className = 'active'
    tr.innerHTML =
      `<td><img class="sw" src="${s.url}" alt="" /></td>` +
      `<td>${s.name}</td>` +
      `<td><select data-k="projection"><option value="planar"${s.projection === 'planar' ? ' selected' : ''}>planar</option>` +
      `<option value="cylindrical"${s.projection === 'cylindrical' ? ' selected' : ''}>cylindrical</option></select></td>` +
      `<td><input data-k="tileMetres" type="number" step="0.1" min="0.05" value="${s.tileMetres}" /></td>` +
      `<td><input data-k="layer" type="number" step="1" min="0" value="${s.layer}" /></td>` +
      `<td>${r?.faces ?? 0}</td>` +
      `<td class="label">${r && r.projection === 'cylindrical' && r.faces
        ? `${r.metresPerTile.toFixed(2)}m &middot; ${r.repeatsAround} around`
        : r?.faces ? `${(r.metresPerTile ?? s.tileMetres).toFixed(2)}m` : ''}</td>` +
      '<td><button data-k="remove">x</button></td>'
    tr.addEventListener('click', (e) => {
      if (e.target.dataset.k === 'remove') { removeSlot(i); return }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
      paint.active = i
      renderSlots()
    })
    for (const el of tr.querySelectorAll('[data-k]')) {
      if (el.dataset.k === 'remove') continue
      el.addEventListener('change', () => {
        const v = el.dataset.k === 'projection' ? el.value : Number(el.value)
        if (el.dataset.k !== 'projection' && !(v >= 0)) { setStatus(`${el.dataset.k} must be a positive number`, 'warn'); return }
        paint.slots[i][el.dataset.k] = v
        refreshPaintGeometry()
        renderSlots()
      })
    }
    t.appendChild(tr)
  })
  $('slotWrap').classList.add('on')
}

function renderPaintSources() {
  const sel = $('paintSource')
  const keep = sel.value
  sel.innerHTML = ''
  const add = (value, text) => {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    sel.appendChild(o)
  }
  if (assets.mesh) add('mesh.glb', 'mesh.glb (full)')
  for (const tier of lodTiers) add(`tier:${tier.level}`, `lod${tier.level} in memory (${tier.stats.outputTris} tris)`)
  for (const f of assets.lods) add(f, `${f} (on disk)`)
  if (keep) sel.value = keep
}

$('startPaint').addEventListener('click', () => withButton($('startPaint'), 'preparing the paint surface', async () => {
  const choice = $('paintSource').value
  const tierMatch = /^tier:(\d+)$/.exec(choice)
  const src = tierMatch
    ? lodTiers.find((t) => t.level === Number(tierMatch[1])).mesh
    : toPlainMesh((await loadGeometry(choice)).geometry)

  const heightM = Number($('heightM').value)
  if (!(heightM > 0)) throw new Error('this tree needs a height in metres -- it is what the mesh is scaled to')

  const mesh = unweld(src)
  const grounded = groundAndScale(mesh.positions, heightM)
  paint.mesh = mesh
  paint.frames = faceFrames(mesh.positions)
  paint.adjacency = buildFaceAdjacency(mesh.positions)
  paint.faceSlot = new Int16Array(paint.frames.count).fill(-1)
  paint.undo = []
  paint.source = choice
  paint.slots = []
  paint.report = []
  // A new surface needs a new buffer set; keeping the old one would draw this
  // mesh's positions through the last one's face count.
  paint.geometry = null

  // Seed the slot table from the species' own bark and foliage, because a paint
  // stage that opens with an empty pool has nothing to click WITH.
  const species = library.find((t) => t.id === currentId())
  const find = (name) => pool.find((p) => p.name === name && p.usable)
  const foliage = find(species?.foliage) ?? pool.find((p) => p.usable && p.name.startsWith('leaf'))
  const bark = find(species?.bark) ?? pool.find((p) => p.usable && p.name.startsWith('bark'))
  if (!foliage || !bark) throw new Error('the texture pool has no usable 128px leaf or bark PNG to open with')
  await addSlot(foliage, { projection: 'planar', tileMetres: 2 })
  await addSlot(bark, { projection: 'cylindrical', tileMetres: 1 })
  paint.active = 0

  autoSeed()
  showPaintModel()
  $('savePaint').disabled = false
  $('autoSeed').disabled = false
  setStatus(
    `${paint.frames.count} faces, scaled to ${heightM}m (x${grounded.scale.toFixed(3)}) -- ` +
    'left-drag paints, right-drag orbits', 'ok')
}))

/**
 * A first pass, not an answer: everything is foliage, and the lowest slice is
 * bark. It exists because clicking a thousand faces from nothing is the reason a
 * paint tool goes unused, and it is wrong in exactly the way you then fix by
 * filling the trunk properly -- it cannot tell a low branch from a high root.
 */
function autoSeed() {
  const { centroids, count } = paint.frames
  let hi = 0
  for (let f = 0; f < count; f++) hi = Math.max(hi, centroids[f * 3 + 1])
  const cut = hi * 0.3
  pushUndo()
  for (let f = 0; f < count; f++) paint.faceSlot[f] = centroids[f * 3 + 1] < cut ? 1 : 0
  refreshPaintGeometry()
}

function pushUndo() {
  if (!paint.faceSlot) return
  paint.undo.push(Int16Array.from(paint.faceSlot))
  if (paint.undo.length > 20) paint.undo.shift()
  $('undoPaint').disabled = false
}

/** Rebuilds uvProj and texLayer for the WHOLE mesh, not just the faces touched.
 *  A cylindrical slot's axis, radius and repeat count are properties of its
 *  entire face set, so one more face on the trunk moves every trunk UV a little;
 *  patching locally would drift the seam. At a few thousand faces this is
 *  microseconds and it is always right. */
function refreshPaintGeometry() {
  if (!paint.mesh) return
  const preview = paint.slots.map((s, i) => ({ projection: s.projection, tileMetres: s.tileMetres, layer: i }))
  const built = buildPaintedMesh(paint.mesh, paint.faceSlot, preview)
  paint.report = built.slots

  if (!paint.geometry) {
    paint.geometry = new THREE.BufferGeometry()
    paint.geometry.setAttribute('position', new THREE.BufferAttribute(paint.mesh.positions, 3))
    paint.geometry.setAttribute('normal', new THREE.BufferAttribute(paint.mesh.normals, 3))
    paint.geometry.setIndex(new THREE.BufferAttribute(built.indices, 1))
  }
  const unpainted = new Float32Array(paint.faceSlot.length * 3)
  for (let f = 0; f < paint.faceSlot.length; f++) {
    const v = paint.faceSlot[f] < 0 ? 1 : 0
    unpainted[f * 3] = v
    unpainted[f * 3 + 1] = v
    unpainted[f * 3 + 2] = v
  }
  paint.geometry.setAttribute('uvProj', new THREE.BufferAttribute(built.uvProj, 2))
  paint.geometry.setAttribute('texLayer', new THREE.BufferAttribute(built.texLayer, 1))
  paint.geometry.setAttribute('unpainted', new THREE.BufferAttribute(unpainted, 1))
  renderSlots()
}

function showPaintModel() {
  refreshPaintGeometry()
  clearModel()
  model = new THREE.Mesh(paint.geometry, paintMaterial(paint.atlas))
  model.userData.borrowed = true
  model.material.wireframe = $('showWire').checked
  scene.add(model)
  frameModel()
  $('meshStats').textContent = `painting ${paint.frames.count} faces of ${paint.source}`
  $('viewer').classList.add('on')
  setSize()
}

// --- the brush ----------------------------------------------------------------

let brushMode = 'fill'
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
let painting = false

function setMode(mode) {
  brushMode = mode
  for (const [id, m] of [['modeFace', 'face'], ['modeBrush', 'brush'], ['modeFill', 'fill']]) {
    $(id).classList.toggle('on', m === mode)
  }
}
$('modeFace').addEventListener('click', () => setMode('face'))
$('modeBrush').addEventListener('click', () => setMode('brush'))
$('modeFill').addEventListener('click', () => setMode('fill'))

function hit(event) {
  const rect = canvas.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const hits = raycaster.intersectObject(model, false)
  return hits.length ? hits[0] : null
}

function applyStroke(event) {
  const h = hit(event)
  if (!h) return
  const slot = paint.active
  if (brushMode === 'face') {
    paint.faceSlot[h.faceIndex] = slot
  } else if (brushMode === 'brush') {
    // The model sits at the origin untransformed, so the world hit point is
    // already in the space the centroids are measured in.
    const mask = facesInSphere(paint.frames.centroids, [h.point.x, h.point.y, h.point.z], Number($('brushRadius').value))
    for (let f = 0; f < mask.length; f++) if (mask[f]) paint.faceSlot[f] = slot
  } else {
    const mask = floodFill(
      { neighbours: paint.adjacency.neighbours, faceNormals: paint.frames.normals },
      h.faceIndex,
      { angleDeg: Number($('fillAngle').value) },
    )
    for (let f = 0; f < mask.length; f++) if (mask[f]) paint.faceSlot[f] = slot
  }
  refreshPaintGeometry()
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !paint.mesh) return
  painting = true
  canvas.setPointerCapture(e.pointerId)
  // One undo entry per stroke, not per face: a drag that crossed forty faces is
  // one thing you did and one thing you want back.
  pushUndo()
  applyStroke(e)
})
canvas.addEventListener('pointermove', (e) => {
  // A fill re-runs from every face the pointer crosses, which is both slow and
  // never what was meant -- it is a click tool. Face and brush drag.
  if (painting && brushMode !== 'fill') applyStroke(e)
})
const endStroke = (e) => {
  if (!painting) return
  painting = false
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
}
canvas.addEventListener('pointerup', endStroke)
canvas.addEventListener('pointercancel', endStroke)

$('undoPaint').addEventListener('click', () => {
  const prev = paint.undo.pop()
  if (!prev) return
  paint.faceSlot = prev
  $('undoPaint').disabled = !paint.undo.length
  refreshPaintGeometry()
})
$('autoSeed').addEventListener('click', () => autoSeed())

// --- export -------------------------------------------------------------------

/** Chunked, because String.fromCharCode.apply over a whole multi-megabyte GLB
 *  blows the argument limit and throws a RangeError that reads like nothing. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

$('savePaint').addEventListener('click', () => withButton($('savePaint'), 'exporting painted mesh', async () => {
  const unpaintedFaces = Array.from(paint.faceSlot).filter((s) => s < 0).length
  if (unpaintedFaces) throw new Error(`${unpaintedFaces} face(s) are still unpainted (shown in magenta) -- they would export wearing layer 0 without having been chosen`)

  // The exported texLayer is the WORLD layer, not the bench's slot index. The
  // two are different numbers and confusing them is a tree wearing the terrain.
  const built = buildPaintedMesh(paint.mesh, paint.faceSlot, paint.slots.map((s) => ({
    projection: s.projection, tileMetres: s.tileMetres, layer: s.layer,
  })))

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3))
  g.setAttribute('uvProj', new THREE.BufferAttribute(built.uvProj, 2))
  g.setAttribute('texLayer', new THREE.BufferAttribute(built.texLayer, 1))
  g.setIndex(new THREE.BufferAttribute(built.indices, 1))
  const glb = await new GLTFExporter().parseAsync(new THREE.Mesh(g, new THREE.MeshStandardMaterial()), { binary: true })

  const j = await post(`/__tree9-paint?id=${encodeURIComponent(currentId())}`, {
    glb: toBase64(glb),
    paint: {
      source: paint.source,
      heightM: Number($('heightM').value),
      faces: paint.faceSlot.length,
      slots: paint.slots.map((s, i) => ({
        file: s.file,
        projection: s.projection,
        tileMetres: s.tileMetres,
        layer: s.layer,
        ...(paint.report[i] ?? {}),
      })),
      // The per-face assignment is the authored artefact: the mesh can be bought
      // again for 50 credits, and this cannot.
      faceSlot: Array.from(paint.faceSlot),
    },
  })
  await refresh()
  await loadLibrary()
  $('roster').value = currentId()
  setStatus(`painted -> ${j.path} (${(j.bytes / 1024).toFixed(0)} kB, ${j.slots} slots), $0.000`, 'ok')
}))

// --- chrome -------------------------------------------------------------------

function setSize() {
  const w = canvas.clientWidth || 560, h = canvas.clientHeight || 420
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function tick() {
  requestAnimationFrame(tick)
  orbit.update()
  if (model) renderer.render(scene, camera)
}
requestAnimationFrame(tick)
window.addEventListener('resize', setSize)

$('roster').addEventListener('change', (e) => loadTree(e.target.value).catch((err) => setStatus(err.message, 'warn')))
$('rosterPrev').addEventListener('click', () => stepRoster(-1))
$('rosterNext').addEventListener('click', () => stepRoster(1))
$('treeId').addEventListener('change', () => { clearLods(); clearPaint(); refresh().catch((e) => setStatus(e.message, 'warn')) })
$('wantTexture').addEventListener('change', updateMeshPrice)
$('faceLimit').addEventListener('input', () => { $('faceLimitVal').textContent = $('faceLimit').value })
$('brushRadius').addEventListener('input', () => { $('brushVal').textContent = `${$('brushRadius').value} m` })
$('fillAngle').addEventListener('input', () => { $('fillVal').textContent = `${$('fillAngle').value}°` })
$('showWire').addEventListener('change', () => { if (model) model.material.wireframe = $('showWire').checked })
$('showUnpainted').addEventListener('change', () => {
  if (model?.material?.uniforms) model.material.uniforms.uFlagUnpainted.value = $('showUnpainted').checked ? 1 : 0
})
$('libToggle').addEventListener('click', () => {
  const on = $('library').classList.toggle('on')
  if (on) loadLibrary().catch((e) => setStatus(e.message, 'warn'))
})

$('faceLimitVal').textContent = $('faceLimit').value
$('brushVal').textContent = `${$('brushRadius').value} m`
$('fillVal').textContent = `${$('fillAngle').value}°`
bill('session start', 0)
loadSpecies()
  // Balance after the species list (it prices itself against credits.meshBare)
  // but before anything else, so an empty wallet is on screen before the first
  // click rather than inside the first failure.
  .then(loadBalance)
  .then(loadPool)
  .then(loadLibrary)
  .then(() => loadTree(library[0].id))
  .catch((e) => setStatus(e.message, 'warn'))
