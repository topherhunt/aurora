// ---------------------------------------------------------------------------
// gen-creature.html: the creature bench. Candidate image (OpenRouter) -> mesh
// (Tripo image-to-model) -> LOD ladder (ours) -> rig-check -> rig -> retargeted
// animations, each stage previewed before the next one is paid for.
//
// The page holds no API keys and does no vendor arithmetic: vite.config.js's
// creatureGen() endpoints own both, and every response carries the credits it
// actually charged, which is what the ledger sums. A cost shown here is a cost
// the server billed, never one the page estimated for itself.
//
// The stage buttons gate on what is on disk (/__creature-assets), not on what
// happened this session, so a reload mid-pipeline resumes rather than restarts.
//
// The LOD stage is the odd one out and deliberately so: it runs src/mesh/
// decimate.js right here in the tab, costs nothing, and can be re-run until the
// ladder looks right. Tripo will also sell retopology; buying it would put the
// one step we can iterate on for free behind a per-attempt charge.
// ---------------------------------------------------------------------------

import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { analyzeMesh, decimateLadder } from './mesh/decimate.js'

const $ = (id) => document.getElementById(id)
const status = $('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

let library = [] // every creature the bench knows about: roster seeds + anything on disk
let presets = {}
let credits = {}
let candidates = []
let assets = { source: false, mesh: false, rig: false, anims: [], lods: [], state: {} }
let lodTiers = [] // { level, target, mesh, geometry, stats } for the mesh currently loaded
const ledger = [] // { what, usd }

const currentId = () => $('creatureId').value.trim()

// --- ledger ----------------------------------------------------------------

function bill(what, usd) {
  ledger.push({ what, usd })
  const rows = ledger.map((e) => `<div><span>${e.what}</span><span>$${e.usd.toFixed(3)}</span></div>`).join('')
  const total = ledger.reduce((s, e) => s + e.usd, 0)
  $('ledger').innerHTML = `${rows}<div class="total"><span>total this session</span><span>$${total.toFixed(3)}</span></div>`
}

// --- roster ----------------------------------------------------------------

async function loadRoster() {
  const j = await (await fetch('/__creature-roster')).json()
  presets = j.presets
  credits = j.credits
  if (!j.hasTripoKey) setStatus('TRIPO_API_KEY is not set -- the 3D steps will fail until it is in .env', 'warn')

  const rigSel = $('rigType')
  for (const t of [...Object.keys(presets), 'none']) {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t
    rigSel.appendChild(opt)
  }
  $('genMesh').textContent = `generate mesh ($${(credits.mesh / 100).toFixed(2)})`
  $('genRig').textContent = `rig ($${(credits.rig / 100).toFixed(2)})`
}

// --- the library: every asset, its prompt, and what has been made of it ------

/**
 * The roster file is a seed list, not the truth. Anything with a directory under
 * work/ counts too, which is how a creature invented in this page -- one that was
 * never in creature-roster.mjs -- keeps its prompt across a reload. The server
 * merges the two; this just draws the result.
 */
async function loadLibrary() {
  const j = await (await fetch('/__creature-list')).json()
  if (!j.ok) throw new Error(j.error)
  library = j.creatures

  const sel = $('roster')
  const keep = sel.value
  sel.innerHTML = ''
  for (const c of library) {
    const opt = document.createElement('option')
    opt.value = c.id
    opt.textContent = `${c.label ?? c.id} (${c.rigType ?? 'unrigged'})${c.inRoster ? '' : ' *'}`
    sel.appendChild(opt)
  }
  if (keep) sel.value = keep
  renderLibrary()
}

function renderLibrary() {
  const grid = $('libGrid')
  grid.innerHTML = ''
  const current = currentId()
  for (const c of library) {
    const card = document.createElement('div')
    card.className = `card${c.id === current ? ' is-current' : ''}`

    const top = document.createElement('div')
    top.className = 'top'
    if (c.thumbUrl) {
      const img = document.createElement('img')
      img.src = c.thumbUrl
      img.alt = c.label ?? c.id
      top.appendChild(img)
    } else {
      const none = document.createElement('div')
      none.className = 'noimg'
      none.textContent = 'no image'
      top.appendChild(none)
    }
    const head = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = c.label ?? c.id
    const sub = document.createElement('div')
    sub.className = 'label'
    sub.textContent = `${c.id} · ${c.rigType ?? 'unrigged'}${c.sizeM ? `, ${c.sizeM}m` : ''}${c.inRoster ? '' : ' · not in roster'}`
    head.append(name, sub)
    top.appendChild(head)

    // The prompt is the asset. Showing it in the list is the point of the list:
    // two creatures that came out wrong usually came out wrong the same way, and
    // that is only visible with the prompts side by side.
    const prompt = document.createElement('p')
    prompt.className = 'prompt'
    prompt.textContent = c.description ?? '(no description yet)'

    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const [label, on] of [
      [`${c.candidateCount} img`, c.candidateCount > 0],
      ['source', c.has.source],
      ['mesh', c.has.mesh],
      [`${c.lodCount} lod`, c.lodCount > 0],
      ['rig', c.has.rig],
      [`${c.animCount} anim`, c.animCount > 0],
      ['edited', c.edited],
    ]) {
      const chip = document.createElement('span')
      chip.className = `chip${on ? ' on' : ''}`
      chip.textContent = label
      chips.appendChild(chip)
    }
    const spent = document.createElement('span')
    spent.className = 'chip cost'
    spent.textContent = `$${c.usd.toFixed(3)}`
    chips.appendChild(spent)

    card.append(top, prompt, chips)
    card.addEventListener('click', () => {
      $('library').classList.remove('on')
      loadCreature(c.id).catch((e) => setStatus(e.message, 'warn'))
    })
    grid.appendChild(card)
  }
}

async function loadCreature(id) {
  const c = library.find((x) => x.id === id)
  if (!c) throw new Error(`no creature "${id}" in the library`)
  $('roster').value = id
  $('creatureId').value = c.id
  $('label').value = c.label ?? c.id
  $('rigType').value = c.rigType ?? 'none'
  $('sizeM').value = c.sizeM ?? ''
  $('description').value = c.description ?? ''
  candidates = []
  clearLods()
  clearModel()
  await refresh()
}

function stepRoster(delta) {
  const i = library.findIndex((c) => c.id === $('roster').value)
  const next = library[(i < 0 ? 0 : i + delta + library.length) % library.length]
  loadCreature(next.id).catch((e) => setStatus(e.message, 'warn'))
}

// --- editing the prompt ------------------------------------------------------

$('saveMeta').addEventListener('click', () => withButton($('saveMeta'), 'saving', async () => {
  const id = currentId()
  const j = await post(`/__creature-save?id=${encodeURIComponent(id)}`, {
    label: $('label').value.trim() || undefined,
    rigType: $('rigType').value,
    sizeM: Number($('sizeM').value) || undefined,
    description: $('description').value.trim(),
  })
  await loadLibrary()
  $('roster').value = id
  $('metaOut').textContent = `saved -- "${j.creature.description}"`
  setStatus(`prompt saved for ${id}`, 'ok')
}))

/**
 * A new creature is just an id with a description saved against it; the roster
 * file never has to be touched. Editing the roster is still the right move once
 * a creature is settled, but it should not be the price of trying one out.
 */
$('newCreature').addEventListener('click', () => withButton($('newCreature'), 'creating', async () => {
  const id = window.prompt('new creature id (lowercase letters, digits, hyphens)')
  if (!id) return
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`"${id}" is not a valid id -- lowercase letters, digits and hyphens only`)
  const description = $('description').value.trim()
  if (!description) throw new Error('write the description first -- it is the prompt, and a creature is not a creature without one')
  await post(`/__creature-save?id=${encodeURIComponent(id)}`, {
    label: id.replace(/-/g, ' '),
    rigType: $('rigType').value,
    sizeM: Number($('sizeM').value) || undefined,
    description,
  })
  await loadLibrary()
  await loadCreature(id)
  setStatus(`created ${id} -- generate a candidate image to start`, 'ok')
}))

// --- disk state -> which buttons are live ----------------------------------

async function refresh() {
  const id = currentId()
  if (!/^[a-z0-9-]+$/.test(id)) return
  const [cRes, aRes] = await Promise.all([
    fetch(`/__creature-candidates?id=${encodeURIComponent(id)}`),
    fetch(`/__creature-assets?id=${encodeURIComponent(id)}`),
  ])
  const cj = await cRes.json()
  const aj = await aRes.json()
  if (!cRes.ok) throw new Error(cj.error)
  if (!aRes.ok) throw new Error(aj.error)
  candidates = cj.candidates
  assets = aj
  renderGallery()
  renderAnimList()
  $('genMesh').disabled = !assets.source
  $('genLod').disabled = !assets.mesh
  $('saveLod').disabled = lodTiers.length === 0
  $('rigCheck').disabled = !assets.mesh
  $('genRig').disabled = !assets.mesh
  $('genAnim').disabled = !assets.rig
  renderClipSelect()
}

function renderGallery() {
  const g = $('gallery')
  g.innerHTML = ''
  if (!candidates.length) {
    g.innerHTML = '<p class="label">no candidates yet -- generate one</p>'
    return
  }
  for (const c of candidates) {
    const div = document.createElement('div')
    div.className = `candidate${c.picked ? ' is-picked' : ''}`
    const img = document.createElement('img')
    img.src = c.url
    const btn = document.createElement('button')
    btn.textContent = c.picked ? 'picked' : 'pick'
    btn.className = c.picked ? 'picked' : 'pick'
    btn.addEventListener('click', () => pick(c.file))
    const cost = document.createElement('div')
    cost.className = 'cost'
    cost.textContent = `$${(c.cost ?? 0).toFixed(4)}`
    div.append(img, btn, cost)
    g.appendChild(div)
  }
}

function renderAnimList() {
  const box = $('animList')
  box.innerHTML = ''
  const list = presets[assets.state?.rigType ?? $('rigType').value] ?? []
  if (!list.length) {
    box.innerHTML = '<div class="label">no presets for this rig type -- author clips locally against the mixamo-named skeleton instead</div>'
    return
  }
  for (const p of list) {
    const label = document.createElement('label')
    label.style.cssText = 'display:flex;gap:6px;align-items:center;color:var(--dim);font-size:11px'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = p
    cb.addEventListener('change', updateAnimPrice)
    label.append(cb, document.createTextNode(p.replace(/^preset:/, '')))
    box.appendChild(label)
  }
  updateAnimPrice()
}

const selectedAnims = () => [...$('animList').querySelectorAll('input:checked')].map((i) => i.value)

function updateAnimPrice() {
  const n = selectedAnims().length
  $('genAnim').textContent = n
    ? `retarget ${n} clip${n === 1 ? '' : 's'} ($${((credits.perAnimation * n) / 100).toFixed(2)})`
    : 'retarget selected'
  $('genAnim').disabled = !assets.rig || n === 0
}

// --- the five actions -------------------------------------------------------

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
    updateAnimPrice()
  }
}

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  const j = await res.json()
  if (!res.ok) throw new Error(j.error)
  return j
}

$('genImage').addEventListener('click', () => withButton($('genImage'), 'generating candidate image', async () => {
  const j = await post('/__creature-image', {
    id: currentId(),
    description: $('description').value.trim(),
    rigType: $('rigType').value,
  })
  bill('image', j.cost)
  await refresh()
  setStatus(`candidate saved (${j.file}), $${j.cost.toFixed(4)}`, 'ok')
}))

async function pick(file) {
  const j = await post(`/__creature-pick?id=${encodeURIComponent(currentId())}`, { file })
  await refresh()
  setStatus(`picked -> ${j.path}`, 'ok')
}

$('genMesh').addEventListener('click', () => withButton($('genMesh'), 'generating mesh (Tripo, this takes a minute)', async () => {
  const j = await post(`/__creature-mesh?id=${encodeURIComponent(currentId())}`, {
    model: $('meshModel').value === 'p1' ? 'P1-20260311' : 'v3.1-20260211',
    faceLimit: Number($('faceLimit').value),
  })
  bill('mesh', j.credits / 100)
  // Tiers built from the mesh this one just replaced would still be sitting in
  // lodTiers, and "save tiers" would write them under the new mesh's name.
  clearLods()
  await refresh()
  await showModel('mesh')
  setStatus(`mesh -> ${j.path} (${j.credits} credits)`, 'ok')
}))

$('rigCheck').addEventListener('click', () => withButton($('rigCheck'), 'rig-check (free)', async () => {
  const j = await post(`/__creature-rig-check?id=${encodeURIComponent(currentId())}`)
  $('rigCheckOut').textContent = j.riggable
    ? `riggable -- Tripo suggests "${j.rigType}"`
    : 'NOT riggable -- this mesh will not take a skeleton'
  $('rigCheckOut').className = `step ${j.riggable ? 'ok' : 'warn'}`
  if (j.riggable && j.rigType) $('rigType').value = j.rigType
  renderAnimList()
  setStatus(`rig-check: riggable=${j.riggable}, type=${j.rigType ?? 'none'}`, j.riggable ? 'ok' : 'warn')
}))

$('genRig').addEventListener('click', () => withButton($('genRig'), 'rigging (Tripo)', async () => {
  const j = await post(`/__creature-rig?id=${encodeURIComponent(currentId())}`, { rigType: $('rigType').value })
  bill('rig', j.credits / 100)
  await refresh()
  $('showSkeleton').checked = true
  await showModel('rig')
  setStatus(`rig -> ${j.path} (${j.credits} credits)`, 'ok')
}))

$('genAnim').addEventListener('click', () => withButton($('genAnim'), 'retargeting animations (Tripo)', async () => {
  const j = await post(`/__creature-animate?id=${encodeURIComponent(currentId())}`, { animations: selectedAnims() })
  bill(`animations x${j.files.length}`, j.credits / 100)
  await refresh()
  setStatus(`${j.files.length} clip(s) written (${j.credits} credits)`, 'ok')
}))

// --- 3D preview -------------------------------------------------------------

const canvas = $('viewCanvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(35, 420 / 320, 0.01, 100)
scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x1a1420, 1.1))
const sun = new THREE.DirectionalLight(0xfff3e2, 1.6)
sun.position.set(1, 1.5, 1)
scene.add(sun)
const orbit = new OrbitControls(camera, renderer.domElement)
orbit.enableDamping = true

const loader = new GLTFLoader()
let model = null
let skeletonHelper = null
let mixer = null
const clock = new THREE.Clock()

function clearModel() {
  if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null }
  if (model) {
    scene.remove(model)
    // A LOD tier's geometry and material are held by lodTiers/lodMaterial and
    // get shown again when another tier is clicked, so they are borrowed, not
    // owned. Disposing them here is what turns a second click into a blank view.
    if (!model.userData.borrowed) {
      model.traverse((o) => { o.geometry?.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()) })
    }
    model = null
  }
  mixer = null
  $('viewer').classList.remove('on')
  $('texRow').classList.remove('on')
}

/**
 * `which` is a filename stem under the creature's work dir. The cache-buster
 * matters: every re-run rewrites the same path, and without it the loader
 * serves the previous generation's bytes from the HTTP cache and the mesh
 * appears not to have changed at all.
 */
/**
 * Frames the camera on the model's own bounds rather than the roster's sizeM:
 * Tripo's output scale depends on auto_size, so the declared size is a claim
 * about the creature, not about the file that just came back. Returns the span
 * because the caller reports it.
 */
function frameModel() {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const span = Math.max(size.x, size.y, size.z) || 1
  camera.position.set(centre.x + span * 1.6, centre.y + span * 0.9, centre.z + span * 1.6)
  camera.near = span / 100
  camera.far = span * 50
  camera.updateProjectionMatrix()
  orbit.target.copy(centre)
  orbit.update()
  return span
}

async function showModel(which) {
  const id = currentId()
  const file = which === 'mesh' ? 'mesh.glb' : which === 'rig' ? 'rig.glb' : which
  const url = `/tools/creatures/work/${encodeURIComponent(id)}/${file}?t=${Date.now()}`
  const gltf = await loader.loadAsync(url)

  clearModel()
  model = gltf.scene
  scene.add(model)

  let tris = 0
  let texture = null
  model.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3
    if (!texture && o.material?.map?.image) texture = o.material.map.image
    o.material.wireframe = $('showWire').checked
  })

  const span = frameModel()

  const requested = Number($('faceLimit').value)
  const over = tris > requested * 1.25
  $('meshStats').innerHTML =
    `${Math.round(tris)} tris (asked for ${requested}) &middot; ${span.toFixed(2)}m longest side` +
    (over ? ' <span class="warn">-- over the requested limit; face_limit is a target, not a contract</span>' : '')

  if (skeletonHelper) scene.remove(skeletonHelper)
  skeletonHelper = new THREE.SkeletonHelper(model)
  skeletonHelper.visible = $('showSkeleton').checked
  scene.add(skeletonHelper)

  if (gltf.animations?.length) {
    mixer = new THREE.AnimationMixer(model)
    mixer.clipAction(gltf.animations[0]).play()
  }

  drawTexture(texture)
  $('viewer').classList.add('on')
  setSize()
}

/**
 * The 128px gate. Both canvases draw the same source; only the destination size
 * differs, so what the small one loses is exactly what the shipped texture will
 * lose. Judge UV island survival here -- it is the failure this whole pipeline
 * is arranged around, and it is invisible at full size.
 */
function drawTexture(image) {
  const row = $('texRow')
  if (!image) { row.classList.remove('on'); return }
  for (const [id, size] of [['texFull', 256], ['tex128', 128]]) {
    const ctx = $(id).getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(image, 0, 0, size, size)
  }
  row.classList.add('on')
}

// --- LOD: our decimator, run in this tab ------------------------------------

let lodMaterial = null // the source mesh's material, reused so tiers preview textured

/**
 * Plain arrays in. decimate.js knows nothing about three -- it has to run under
 * node in scripts/check-decimate.mjs, where THREE does not exist -- so the
 * bridge lives on this side.
 */
function toPlainMesh(geometry) {
  const pos = geometry.getAttribute('position')
  const uv = geometry.getAttribute('uv')
  if (!uv) throw new Error('this mesh has no UVs -- seam locking is the decimator\'s whole safety story, and without UVs there are no seams to find')
  const normal = geometry.getAttribute('normal')
  const index = geometry.getIndex()
  return {
    positions: Float32Array.from(pos.array),
    uvs: Float32Array.from(uv.array),
    normals: normal ? Float32Array.from(normal.array) : null,
    // A non-indexed geometry is an implicit index of 0,1,2,...; making it
    // explicit lets buildTopology weld it the same way it welds everything else.
    indices: index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i),
  }
}

function toGeometry(mesh) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
  if (mesh.normals) g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  if (!mesh.normals) g.computeVertexNormals()
  return g
}

/** "50%, 25%, 10%" or "4000, 1500" or a mix. Percentages are of the input. */
function parseTargets(text, inputTris) {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) throw new Error('no LOD targets given')
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
  lodMaterial = null
  $('lodWrap').classList.remove('on')
  $('lodTable').innerHTML = ''
  $('meshAnalysis').textContent = ''
  $('saveLod').disabled = true
}

$('genLod').addEventListener('click', () => withButton($('genLod'), 'decimating', async () => {
  const id = currentId()
  const gltf = await loader.loadAsync(`/tools/creatures/work/${encodeURIComponent(id)}/mesh.glb?t=${Date.now()}`)

  const meshes = []
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
  // Loud rather than clever: a multi-mesh GLB would need per-mesh ladders and a
  // merge rule, and silently decimating only the first would look like it worked.
  if (meshes.length !== 1) throw new Error(`expected one mesh in mesh.glb, found ${meshes.length} -- the ladder is per-mesh and this file needs splitting first`)
  lodMaterial = meshes[0].material

  const plain = toPlainMesh(meshes[0].geometry)
  const analysis = analyzeMesh(plain)
  $('meshAnalysis').innerHTML =
    `${analysis.tris} tris, ${analysis.points} welded points &middot; ` +
    `${analysis.uvIslands} UV island${analysis.uvIslands === 1 ? '' : 's'} &middot; ` +
    `${analysis.lockedPoints} pinned (${Math.round((analysis.lockedPoints / analysis.points) * 100)}%) &middot; ` +
    `${analysis.lockedFaces} unremovable faces &middot; ` +
    `quads ${Math.round(analysis.quadFraction * 100)}%`

  const targets = parseTargets($('lodTargets').value, analysis.tris)
  const tiers = decimateLadder(plain, targets, {})
  lodTiers = tiers.map((t, i) => ({
    level: i + 1,
    mesh: t,
    geometry: toGeometry(t),
    stats: t.stats,
  }))

  renderLodTable()
  $('saveLod').disabled = false
  await showTier(lodTiers[0])
  setStatus(`${lodTiers.length} tier(s) built locally, $0.000`, 'ok')
}))

function renderLodTable() {
  const t = $('lodTable')
  t.innerHTML =
    '<tr><th>tier</th><th>target</th><th>got</th><th>reduction</th><th>why it stopped</th></tr>'
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

async function showTier(tier) {
  clearModel()
  model = new THREE.Mesh(tier.geometry, lodMaterial)
  model.userData.borrowed = true
  scene.add(model)
  model.material.wireframe = $('showWire').checked
  frameModel()
  $('meshStats').innerHTML =
    `lod${tier.level}: ${tier.stats.outputTris} tris (asked ${tier.stats.targetTris}, from ${tier.stats.inputTris}) &middot; ` +
    `${tier.stats.collapses} collapses &middot; ${tier.stats.lockedPoints}/${tier.stats.totalPoints} points pinned`
  drawTexture(lodMaterial.map ? lodMaterial.map.image : null)
  $('viewer').classList.add('on')
  setSize()
}

$('saveLod').addEventListener('click', () => withButton($('saveLod'), 'writing tiers', async () => {
  const id = currentId()
  const exporter = new GLTFExporter()
  for (const tier of lodTiers) {
    const mesh = new THREE.Mesh(tier.geometry, lodMaterial)
    const glb = await exporter.parseAsync(mesh, { binary: true })
    const res = await fetch(`/__creature-lod?id=${encodeURIComponent(id)}&level=${tier.level}`, {
      method: 'POST',
      headers: { 'content-type': 'model/gltf-binary' },
      body: glb,
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
  }
  await refresh()
  await loadLibrary()
  $('roster').value = id
  setStatus(`${lodTiers.length} tier(s) written to work/${id}/, $0.000`, 'ok')
}))

function renderClipSelect() {
  const sel = $('clipSelect')
  sel.innerHTML = ''
  const options = []
  if (assets.mesh) options.push(['mesh.glb', 'mesh (no rig)'])
  for (const l of assets.lods) options.push([l, l.replace(/^mesh-|\.glb$/g, '')])
  if (assets.rig) options.push(['rig.glb', 'rig (bind pose)'])
  for (const a of assets.anims) options.push([a, a.replace(/^anim-|\.glb$/g, '')])
  for (const [value, text] of options) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    sel.appendChild(o)
  }
  sel.disabled = !options.length
}

$('clipSelect').addEventListener('change', (e) => {
  showModel(e.target.value).catch((err) => setStatus(`preview failed: ${err.message}`, 'warn'))
})
$('showSkeleton').addEventListener('change', () => { if (skeletonHelper) skeletonHelper.visible = $('showSkeleton').checked })
$('showWire').addEventListener('change', () => {
  model?.traverse((o) => { if (o.isMesh) o.material.wireframe = $('showWire').checked })
})
$('faceLimit').addEventListener('input', () => { $('faceLimitVal').textContent = $('faceLimit').value })

function setSize() {
  const w = canvas.clientWidth || 420, h = canvas.clientHeight || 320
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function tick() {
  requestAnimationFrame(tick)
  const dt = clock.getDelta()
  mixer?.update(dt)
  orbit.update()
  renderer.render(scene, camera)
}
requestAnimationFrame(tick)
window.addEventListener('resize', setSize)

$('roster').addEventListener('change', (e) => loadCreature(e.target.value).catch((err) => setStatus(err.message, 'warn')))
$('rosterPrev').addEventListener('click', () => stepRoster(-1))
$('rosterNext').addEventListener('click', () => stepRoster(1))
$('rigType').addEventListener('change', renderAnimList)
$('creatureId').addEventListener('change', () => {
  clearLods()
  refresh().catch((e) => setStatus(e.message, 'warn'))
})
$('libToggle').addEventListener('click', () => {
  const on = $('library').classList.toggle('on')
  if (on) loadLibrary().catch((e) => setStatus(e.message, 'warn'))
})

$('faceLimitVal').textContent = $('faceLimit').value
bill('session start', 0)
loadRoster()
  .then(loadLibrary)
  .then(() => loadCreature(library[0].id))
  .catch((e) => setStatus(`startup failed: ${e.message}`, 'warn'))
