// ---------------------------------------------------------------------------
// gen-prop.html: the prop bench. Candidate image (OpenRouter) -> mesh (Tripo
// image-to-model) -> LOD ladder and card cross (ours, in this tab), each stage
// previewed before the next one is paid for. The creature bench with the rig
// and animation stages cut off; the viewer, texture twins, decimator bridge and
// card bake are the same code, because a stump and a fox are judged the same
// way -- on the panel they ship at and on the card they are seen from sixty
// metres as.
//
// The page holds no API keys and does no vendor arithmetic: vite.config.js's
// propGen() endpoints own both, and every response carries the credits it
// actually charged, which is what the ledger sums. The stage buttons gate on
// what is on disk (/__prop-assets), not on what happened this session, so a
// reload mid-pipeline resumes rather than restarts.
// ---------------------------------------------------------------------------

import THREE from './three-instance.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { analyzeMesh, decimate, decimateLadder } from './mesh/decimate.js'
import { cullTripoBackfaces } from './tripo-culling.js'
import { TEX_SIZE } from './textures.js'
import { SUPERSAMPLE, BAKE_ROCK_BOUNCE, impostorCardExtents, downsample, dilate } from './props/impostor.js'

const $ = (id) => document.getElementById(id)
const status = $('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

const WORK_URL = '/tools/props/gen/work'

let library = [] // every prop the bench knows about: roster seeds + anything on disk
let categories = []
let credits = {}
let imageModels = [] // the image models the server will bill for, cheapest first
let texPx = null // { max, small }: the shipping cap and the small designation, from the roster
let defaultFrame = '4:3'
let candidates = []
let meshCandidates = []
let assets = { source: false, mesh: null, lods: [], meshCount: 0, state: {} }
// The mesh candidate section 4 operates on. Not the same thing as the PICKED
// candidate: picking is what ships, selecting is what you are currently
// comparing ladders for.
let selectedMesh = null
let lodTiers = [] // { level, object, stats } decimated from `selectedMesh` this session
// Generations in flight, and the one-second guards on the buttons that start
// them. Declared up here because `refresh` reads them.
let pendingImages = 0
let pendingMeshes = 0
let meshCooling = false
const ledger = [] // { what, usd }

const currentId = () => $('propId').value.trim()

// --- ledger ----------------------------------------------------------------

function bill(what, usd) {
  ledger.push({ what, usd })
  const rows = ledger.map((e) => `<div><span>${e.what}</span><span>$${e.usd.toFixed(3)}</span></div>`).join('')
  const total = ledger.reduce((s, e) => s + e.usd, 0)
  $('ledger').innerHTML = `${rows}<div class="total"><span>total this session</span><span>$${total.toFixed(3)}</span></div>`
}

// --- roster ----------------------------------------------------------------

async function loadRoster() {
  const j = await (await fetch('/__prop-roster')).json()
  if (!j.ok) throw new Error(j.error ?? 'GET /__prop-roster failed')
  // Checked here rather than trusted: vite.config.js's middleware does not
  // hot-reload, so a dev server older than this page answers without a key and
  // the failure would otherwise surface much later, somewhere else.
  for (const k of ['categories', 'aspectRatios', 'defaultFrame', 'credits', 'imageModels', 'texPx']) {
    if (!j[k]) throw new Error(`/__prop-roster answered without "${k}" -- restart the dev server, its middleware is older than this page`)
  }
  categories = j.categories
  credits = j.credits
  imageModels = j.imageModels
  texPx = j.texPx
  defaultFrame = j.defaultFrame
  // The list comes from the server because the server is what enforces it: an
  // id the select does not offer is refused rather than billed.
  $('imageModel').innerHTML = imageModels
    .map((m) => `<option value="${m.id}">${m.label} (~$${m.usd.toFixed(3)})</option>`).join('')
  updateImagePrice()
  if (!j.hasTripoKey) setStatus('TRIPO_API_KEY is not set -- the mesh step will fail until it is in .env', 'warn')

  $('category').innerHTML = categories.map((c) => `<option value="${c}">${c}</option>`).join('')
  $('texPx').innerHTML = [
    [texPx.max, `${texPx.max}px (the cap)`],
    [texPx.small, `${texPx.small}px (small props)`],
  ].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')
  $('genMesh').textContent = `generate mesh ($${(credits.meshTextured / 100).toFixed(2)})`
}

function updateImagePrice() {
  const m = imageModels.find((x) => x.id === $('imageModel').value)
  if (!m) throw new Error(`image model "${$('imageModel').value}" is not one the server offers`)
  $('genImage').textContent = `generate candidate (~$${m.usd.toFixed(3)})`
}
$('imageModel').addEventListener('change', updateImagePrice)

/**
 * Reads the Tripo wallet at startup. Costs nothing, and it is the difference
 * between "the pipeline is broken" and "the wallet is empty".
 */
async function loadBalance() {
  const box = $('balance')
  const res = await fetch('/__prop-balance')
  const j = await res.json()
  if (!res.ok) { box.innerHTML = `<span class="warn">could not read balance: ${j.error}</span>`; return }
  const usd = (j.balance / 100).toFixed(2)
  const enough = j.balance >= credits.meshTextured
  box.innerHTML = `${j.balance} credits ($${usd})${j.frozen ? ` &middot; ${j.frozen} frozen` : ''}` +
    (enough ? '' : `<br><span class="warn">not enough for a mesh (${credits.meshTextured} credits) -- top up at tripo3d.ai before the orange buttons will work</span>`)
}

// --- the library: every prop, its prompt, and what has been made of it -------

async function loadLibrary() {
  const j = await (await fetch('/__prop-list')).json()
  if (!j.ok) throw new Error(j.error)
  library = j.props

  const sel = $('roster')
  const keep = sel.value
  sel.innerHTML = ''
  for (const p of library) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = `${p.label ?? p.id} (${p.category ?? 'other'})${p.inRoster ? '' : ' *'}`
    sel.appendChild(opt)
  }
  if (keep) sel.value = keep
  renderLibrary()
}

function renderLibrary() {
  const grid = $('libGrid')
  grid.innerHTML = ''
  const current = currentId()
  for (const p of library) {
    const card = document.createElement('div')
    card.className = `card${p.id === current ? ' is-current' : ''}`

    const top = document.createElement('div')
    top.className = 'top'
    if (p.thumbUrl) {
      const img = document.createElement('img')
      img.src = p.thumbUrl
      img.alt = p.label ?? p.id
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
    name.textContent = p.label ?? p.id
    const sub = document.createElement('div')
    sub.className = 'label'
    sub.textContent = `${p.id} · ${p.category ?? 'other'}${p.sizeM ? `, ${p.sizeM}m` : ''}${p.texPx ? `, ${p.texPx}px` : ''}${p.inRoster ? '' : ' · not in roster'}`
    head.append(name, sub)
    top.appendChild(head)

    // The prompt is the asset: two props that came out wrong usually came out
    // wrong the same way, and that is only visible with the prompts side by side.
    const prompt = document.createElement('p')
    prompt.className = 'prompt'
    prompt.textContent = p.description ?? '(no description yet)'

    const chips = document.createElement('div')
    chips.className = 'chips'
    for (const [label, on] of [
      [`${p.candidateCount} img`, p.candidateCount > 0],
      ['source', p.has.source],
      [`${p.meshCount} mesh`, p.meshCount > 0],
      [`${p.lodCount} lod`, p.lodCount > 0],
      ['edited', p.edited],
    ]) {
      const chip = document.createElement('span')
      chip.className = `chip${on ? ' on' : ''}`
      chip.textContent = label
      chips.appendChild(chip)
    }
    const spent = document.createElement('span')
    spent.className = 'chip cost'
    spent.textContent = `$${p.usd.toFixed(3)}`
    chips.appendChild(spent)

    card.append(top, prompt, chips)
    card.addEventListener('click', () => {
      $('library').classList.remove('on')
      loadProp(p.id).catch((e) => setStatus(e.message, 'warn'))
    })
    grid.appendChild(card)
  }
}

async function loadProp(id) {
  const p = library.find((x) => x.id === id)
  if (!p) throw new Error(`no prop "${id}" in the library`)
  $('roster').value = id
  $('propId').value = p.id
  $('label').value = p.label ?? p.id
  $('category').value = p.category ?? 'other'
  $('sizeM').value = p.sizeM ?? ''
  $('texPx').value = String(p.texPx ?? texPx.max)
  $('description').value = p.description ?? ''
  $('style').value = p.style ?? ''
  $('styleNote').value = p.styleNote ?? ''
  $('aspectRatio').value = p.aspectRatio ?? defaultFrame
  candidates = []
  // Explicitly, not by falling out of refresh's "is the selection still valid"
  // check: every prop numbers its candidates from zero, so "0.glb" is valid for
  // the new one too and the selection would look like it survived.
  selectedMesh = null
  framedFor = null
  texChoice = p.texPx ?? texPx.max
  clearLods()
  clearModel()
  await refresh()
}

function stepRoster(delta) {
  const i = library.findIndex((p) => p.id === $('roster').value)
  const next = library[(i < 0 ? 0 : i + delta + library.length) % library.length]
  loadProp(next.id).catch((e) => setStatus(e.message, 'warn'))
}

// --- editing the prompt ------------------------------------------------------

const metaFromForm = () => ({
  label: $('label').value.trim() || undefined,
  category: $('category').value,
  sizeM: Number($('sizeM').value) || undefined,
  texPx: Number($('texPx').value),
  description: $('description').value.trim(),
  style: $('style').value.trim() || undefined,
  styleNote: $('styleNote').value.trim() || undefined,
  aspectRatio: $('aspectRatio').value,
})

$('saveMeta').addEventListener('click', () => withButton($('saveMeta'), 'saving', async () => {
  const id = currentId()
  const j = await post(`/__prop-save?id=${encodeURIComponent(id)}`, metaFromForm())
  await loadLibrary()
  $('roster').value = id
  $('metaOut').textContent = `saved -- "${j.prop.description}"`
  setStatus(`prompt saved for ${id}`, 'ok')
}))

/**
 * A new prop is just an id with a description saved against it; the roster
 * file never has to be touched to try one out.
 */
$('newProp').addEventListener('click', () => withButton($('newProp'), 'creating', async () => {
  const id = window.prompt('new prop id (lowercase letters, digits, hyphens)')
  if (!id) return
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`"${id}" is not a valid id -- lowercase letters, digits and hyphens only`)
  const meta = metaFromForm()
  if (!meta.description) throw new Error('write the description first -- it is the prompt, and a prop is not a prop without one')
  await post(`/__prop-save?id=${encodeURIComponent(id)}`, { ...meta, label: id.replace(/-/g, ' ') })
  await loadLibrary()
  await loadProp(id)
  setStatus(`created ${id} -- generate a candidate image to start`, 'ok')
}))

// The description is only the last line of the prompt: the studio, the house
// style and the lighting rules are wrapped around it on the server, so the
// preview asks the server rather than guessing at the wrapping.
$('previewPrompt').addEventListener('click', () => withButton($('previewPrompt'), 'composing', async () => {
  const j = await post('/__prop-prompt', {
    description: $('description').value.trim(),
    style: $('style').value.trim() || undefined,
    styleNote: $('styleNote').value.trim() || undefined,
    aspectRatio: $('aspectRatio').value,
  })
  $('promptDialogText').textContent = `${j.aspectRatio} frame, ${$('imageModel').selectedOptions[0].textContent}\n\n${j.prompt}`
  $('promptDialog').showModal()
  setStatus('prompt composed -- nothing generated', 'ok')
}))

// --- disk state -> which buttons are live ----------------------------------

async function refresh() {
  const id = currentId()
  if (!/^[a-z0-9-]+$/.test(id)) return
  const [cRes, mRes, aRes] = await Promise.all([
    fetch(`/__prop-candidates?id=${encodeURIComponent(id)}`),
    fetch(`/__prop-meshes?id=${encodeURIComponent(id)}`),
    fetch(`/__prop-assets?id=${encodeURIComponent(id)}`),
  ])
  const cj = await cRes.json()
  const mj = await mRes.json()
  const aj = await aRes.json()
  if (!cRes.ok) throw new Error(cj.error)
  if (!mRes.ok) throw new Error(mj.error)
  if (!aRes.ok) throw new Error(aj.error)
  candidates = cj.candidates
  meshCandidates = mj.meshes
  assets = aj
  // The selection follows the pick until you move it, and has to survive a
  // refresh: re-defaulting here would drag the LOD section back to the picked
  // candidate the moment a tier was saved.
  if (!meshCandidates.some((m) => m.file === selectedMesh)) {
    selectedMesh = (meshCandidates.find((m) => m.picked) ?? meshCandidates[0])?.file ?? null
  }
  renderGallery()
  renderMeshGallery()
  renderLodTable()
  // `meshCooling` is checked here as well as in the timer: a refresh landing
  // inside the cooldown would otherwise hand the button straight back.
  $('genMesh').disabled = !assets.source || meshCooling
  $('genLod').disabled = !selectedMesh
  $('genCards').disabled = !selectedMesh
  $('saveLod').disabled = lodTiers.length === 0
  $('reveal').disabled = !assets.source && !assets.mesh
  const show = renderFileSelect()
  // Nothing loads the viewport on startup, so without this a reload shows an
  // empty stage. Only when the stage is bare: refresh runs after every action,
  // and reloading here would throw away a tier the user had just clicked into
  // the preview.
  if (show && !model) await showModel(show)
}

/**
 * A candidate is generated at 1024px and shown at 200px, so the gallery is for
 * telling images apart and this is for judging one. The src is dropped on the
 * way out: the image it points at may be deleted from under it a moment later.
 */
function openLightbox(url, caption) {
  $('lightboxImg').src = url
  $('lightboxCap').textContent = caption
  $('lightbox').hidden = false
}

function closeLightbox() {
  $('lightbox').hidden = true
  $('lightboxImg').removeAttribute('src')
}

$('lightbox').addEventListener('click', closeLightbox)
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox() })

function renderGallery() {
  const g = $('gallery')
  g.innerHTML = ''
  if (!candidates.length && !pendingImages) {
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

    const caption = `${c.file} -- $${(c.cost ?? 0).toFixed(4)}`
    const zoom = document.createElement('button')
    zoom.className = 'corner zoom'
    zoom.innerHTML = '&#128269;'
    zoom.title = `view ${c.file} full size`
    zoom.addEventListener('click', () => openLightbox(c.url, caption))
    img.style.cursor = 'zoom-in'
    img.addEventListener('click', () => openLightbox(c.url, caption))

    const trash = document.createElement('button')
    trash.className = 'corner trash'
    trash.innerHTML = '&#128465;'
    trash.title = `delete ${c.file}`
    // Confirmed, unlike every other click in this gallery: the image cost money
    // and there is no way to get this exact one back.
    trash.addEventListener('click', () => {
      if (!window.confirm(`Delete candidate ${c.file}? It cost $${(c.cost ?? 0).toFixed(4)} and cannot be regenerated identically.`)) return
      withButton(trash, `deleting ${c.file}`, async () => {
        await post(`/__prop-delete-candidate?id=${encodeURIComponent(currentId())}`, { file: c.file })
        await refresh()
        await loadLibrary()
        setStatus(`deleted ${c.file}`, 'ok')
      })
    })

    div.append(img, btn, cost, zoom, trash)
    g.appendChild(div)
  }
  // One placeholder per generation still in flight, so a second click has
  // somewhere visible to land while the first request is still running.
  for (let i = 0; i < pendingImages; i++) {
    const div = document.createElement('div')
    div.className = 'candidate pending'
    const shot = document.createElement('div')
    shot.className = 'noshot'
    shot.textContent = 'generating...'
    div.append(shot)
    g.appendChild(div)
  }
}

// Mesh candidates are the expensive rung: every one cost 40-50 credits and
// Tripo has no task-history endpoint to re-fetch a lost one from. They are
// listed, never replaced.
function renderMeshGallery() {
  const g = $('meshGallery')
  g.innerHTML = ''
  if (!meshCandidates.length && !pendingMeshes) {
    g.innerHTML = '<p class="label">no meshes yet -- pick an image above, then generate one</p>'
    return
  }
  for (const m of meshCandidates) {
    const div = document.createElement('div')
    div.className = `candidate${m.picked ? ' is-picked' : ''}${m.file === selectedMesh ? ' is-selected' : ''}`

    let shot
    if (m.previewUrl) {
      shot = document.createElement('img')
      shot.src = m.previewUrl
    } else {
      shot = document.createElement('div')
      shot.className = 'noshot'
      shot.textContent = 'no preview render'
    }
    shot.style.cursor = 'pointer'
    shot.title = 'select this mesh: previews it and points the LOD section at it'
    shot.addEventListener('click', () => selectMesh(m.file).catch((e) => setStatus(`preview failed: ${e.message}`, 'warn')))

    const btn = document.createElement('button')
    btn.textContent = m.picked ? 'picked' : 'pick'
    btn.className = m.picked ? 'picked' : 'pick'
    btn.disabled = m.picked
    btn.addEventListener('click', () => withButton(btn, `picking ${m.file}`, () => pickMesh(m.file)))

    const meta = document.createElement('div')
    meta.className = 'cost'
    const p = m.params
    meta.innerHTML = [
      m.file,
      p ? `${p.model.replace(/-\d+$/, '')} @ ${p.faceLimit}f${p.pbr ? ' pbr' : ''}` : 'params not recorded',
      `${m.credits} credits`,
      m.lods.length ? `${m.lods.length} lod${m.lods.length === 1 ? '' : 's'}` : 'no lods',
    ].join(' &middot; ')

    div.append(shot, btn, meta)
    g.appendChild(div)
  }
  for (let i = 0; i < pendingMeshes; i++) {
    const div = document.createElement('div')
    div.className = 'candidate pending'
    const shot = document.createElement('div')
    shot.className = 'noshot'
    shot.textContent = 'generating...'
    div.append(shot)
    g.appendChild(div)
  }
}

/**
 * Points section 4 at one mesh candidate and previews it. The in-memory tiers
 * go with the old selection: they were decimated from a different mesh, and
 * leaving them on screen under a new candidate's heading is the one way the
 * table can lie about what it is showing.
 */
async function selectMesh(file) {
  if (file !== selectedMesh) {
    selectedMesh = file
    clearLods()
    renderMeshGallery()
    renderLodTable()
  }
  await showModel(`meshes/${file}`)
}

// --- the actions -------------------------------------------------------------

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

// Neither generate button waits for its request: it goes dead for a second --
// long enough that a double-click is one generation, not two -- and then lets
// you queue the next. The cooldown is the whole of the protection against an
// accidental double charge; it deliberately does NOT cap how many run at once.
const IMAGE_QUEUE_COOLDOWN_MS = 1000
const MESH_QUEUE_COOLDOWN_MS = 1000

$('genImage').addEventListener('click', () => {
  const btn = $('genImage')
  btn.disabled = true
  window.setTimeout(() => { btn.disabled = false }, IMAGE_QUEUE_COOLDOWN_MS)
  queueImage()
})

async function queueImage() {
  // Read now, not when the response lands: a queued generation belongs to what
  // was on screen when it was asked for.
  const body = {
    id: currentId(),
    description: $('description').value.trim(),
    style: $('style').value.trim() || undefined,
    styleNote: $('styleNote').value.trim() || undefined,
    aspectRatio: $('aspectRatio').value,
    model: $('imageModel').value,
  }
  pendingImages++
  renderGallery()
  setStatus(`generating ${pendingImages} candidate image${pendingImages === 1 ? '' : 's'}`)
  try {
    const j = await post('/__prop-image', body)
    bill('image', j.cost)
    pendingImages--
    // The server's own copy, not the page's reconstruction of it.
    $('promptOut').querySelector('pre').textContent = `${body.aspectRatio} frame, ${j.model}\n\n${j.prompt}`
    await refresh()
    setStatus(`candidate saved (${j.file}), $${j.cost.toFixed(4)}${pendingImages ? ` -- ${pendingImages} still generating` : ''}`, 'ok')
  } catch (e) {
    pendingImages--
    renderGallery()
    setStatus(`generating candidate image failed: ${e.message}`, 'warn')
  }
}

async function pick(file) {
  const j = await post(`/__prop-pick?id=${encodeURIComponent(currentId())}`, { file })
  await refresh()
  setStatus(`picked -> ${j.path}`, 'ok')
}

async function pickMesh(file) {
  const j = await post(`/__prop-pick-mesh?id=${encodeURIComponent(currentId())}`, { file })
  // Tiers in memory were decimated from the mesh that was picked a moment ago;
  // keeping them would let "save tiers" write them under this mesh's name.
  clearLods()
  await refresh()
  await showModel('mesh')
  setStatus(`working mesh -> ${j.path}`, 'ok')
}

// A Tripo mesh takes about a minute of wall clock and four in flight take the
// same minute, so generation queues rather than serialises. The button still
// goes dead for a second, which is what keeps a double-click from charging
// 100 credits.
$('genMesh').addEventListener('click', () => {
  meshCooling = true
  $('genMesh').disabled = true
  window.setTimeout(() => {
    meshCooling = false
    // Through refresh's own rule: source.png may have gone away meanwhile.
    $('genMesh').disabled = !assets.source
  }, MESH_QUEUE_COOLDOWN_MS)
  queueMesh()
})

async function queueMesh() {
  const p1 = $('meshModel').value === 'p1'
  const body = {
    model: p1 ? 'P1-20260311' : 'v3.1-20260211',
    faceLimit: Number($('faceLimit').value),
    // P1 is already a low-poly generator and Tripo rejects the flag on it.
    smartLowPoly: !p1 && $('smartLowPoly').checked,
    pbr: $('meshPbr').checked,
  }
  // The prop is captured too: switching props while a mesh runs must not file
  // the result under whichever one is on screen.
  const id = currentId()
  pendingMeshes++
  renderMeshGallery()
  setStatus(`generating ${pendingMeshes} mesh${pendingMeshes === 1 ? '' : 'es'} (Tripo, about a minute each)`)
  try {
    const j = await post(`/__prop-mesh?id=${encodeURIComponent(id)}`, body)
    bill('mesh', j.credits / 100)
    pendingMeshes--
    if (j.autoPicked) clearLods()
    if (id !== currentId()) {
      setStatus(`mesh candidate ${j.file} saved to ${id} (${j.credits} credits)`, 'ok')
      return
    }
    await refresh()
    // Only when nothing else is queued: yanking the viewer to each mesh as it
    // lands makes the last one to arrive win.
    if (!pendingMeshes) await selectMesh(j.file)
    setStatus(j.autoPicked
      ? `mesh -> ${j.path} (${j.credits} credits), picked as the working mesh`
      : `mesh candidate ${j.file} -> ${j.path} (${j.credits} credits)${pendingMeshes ? ` -- ${pendingMeshes} still generating` : ' -- "pick" it to make it the working mesh'}`, 'ok')
  } catch (e) {
    pendingMeshes--
    renderMeshGallery()
    setStatus(`generating mesh failed: ${e.message}`, 'warn')
  }
}

$('reveal').addEventListener('click', () => withButton($('reveal'), 'opening Finder', async () => {
  const j = await post(`/__prop-reveal?id=${encodeURIComponent(currentId())}`, {})
  setStatus(j.revealed ? `Finder: ${j.revealed} in ${j.dir}` : `Finder: ${j.dir}`, 'ok')
}))

// A click on a <dialog>'s backdrop targets the dialog element itself, so the
// hit test is against its box rather than the event target.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return
    const r = dlg.getBoundingClientRect()
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) dlg.close()
  })
}

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

// With `rotateLight` on, a left-drag swings the SUN instead of the camera --
// yaw about the world's up, pitch about the camera's right -- so the light
// sweeps across a still prop. The orbit keeps zoom and pan either way.
const TURN_PER_PX = 0.008
let dragFrom = null
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0 && $('rotateLight').checked) dragFrom = { x: e.clientX, y: e.clientY } })
window.addEventListener('pointerup', () => { dragFrom = null })
window.addEventListener('pointermove', (e) => {
  if (!dragFrom) return
  const dx = e.clientX - dragFrom.x, dy = e.clientY - dragFrom.y
  dragFrom = { x: e.clientX, y: e.clientY }
  turnLight(dx * TURN_PER_PX, dy * TURN_PER_PX)
})
$('rotateLight').addEventListener('change', () => { orbit.enableRotate = !$('rotateLight').checked })

// A click that did not drag reads a glow point off the model, in the frame the
// world draws the prop in (loadCritterGlb: centred over its feet on XZ, feet at
// y = 0), and marks it. The frame is the PICK's; a tier's bounds drift by its
// decimation, so read points off the pick.
const CLICK_PX = 4
const pickRay = new THREE.Raycaster()
let clickFrom = null
let glowMark = null
canvas.addEventListener('pointerdown', (e) => { if (e.button === 0) clickFrom = { x: e.clientX, y: e.clientY } })
canvas.addEventListener('pointerup', (e) => {
  const from = clickFrom
  clickFrom = null
  if (!from || !model || Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_PX) return
  const r = canvas.getBoundingClientRect()
  pickRay.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera)
  const hit = pickRay.intersectObject(model, true)[0]
  if (!hit) return
  const box = new THREE.Box3().setFromObject(model)
  const p = hit.point.clone().sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2))
  const r3 = (v) => Math.round(v * 1000) / 1000
  const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
  $('glowPick').textContent = `glow point { x: ${r3(p.x)}, y: ${r3(p.y)}, z: ${r3(p.z)}, r: ${r3(span * 0.07)}, nx: ${r3(n.x)}, nz: ${r3(n.z)} } -- the pick's frame, r a guess at the pane, n the face's way out`
  if (!glowMark) {
    glowMark = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb35c, depthTest: false, transparent: true, opacity: 0.8 }))
    glowMark.renderOrder = 1
  }
  glowMark.scale.setScalar(span * 0.02)
  glowMark.position.copy(hit.point)
  scene.add(glowMark)
})

const dragAxis = new THREE.Vector3()
function turnLight(yaw, pitch) {
  sun.position.applyAxisAngle(dragAxis.set(0, 1, 0), yaw)
  dragAxis.setFromMatrixColumn(camera.matrixWorld, 0)
  sun.position.applyAxisAngle(dragAxis, pitch)
}

const loader = new GLTFLoader()
const fbxLoader = new FBXLoader()

/**
 * Tripo delivers quad topology as FBX, because glTF has no quads, so a mesh
 * candidate is not always a glb; the workspace names each file from the bytes
 * it downloaded. Every Tripo file the bench shows comes through here, so this
 * is where they get culled (see tripo-culling.js) and stripped to the colour map.
 */
async function loadScene(url) {
  if (/\.fbx(\?|$)/i.test(url)) {
    const root = await fbxLoader.loadAsync(url)
    return { scene: matte(cullTripoBackfaces(root)) }
  }
  const gltf = await loader.loadAsync(url)
  matte(cullTripoBackfaces(gltf.scene))
  return gltf
}

/**
 * Colour map only, fully matte. Tripo's roughness, metalness and normal maps
 * are dropped on load: the world never ships them, so a preview wearing them
 * would be judging a prop it will never be.
 */
function matte(root) {
  root.traverse((o) => {
    if (!o.isMesh) return
    for (const m of [].concat(o.material)) {
      m.roughnessMap = null
      m.metalnessMap = null
      m.normalMap = null
      m.roughness = 1
      m.metalness = 0
      m.needsUpdate = true
    }
  })
  return root
}
let model = null

function clearModel() {
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
  if (glowMark) scene.remove(glowMark)
  $('glowPick').textContent = ''
  $('viewer').classList.remove('on')
  $('texRow').classList.remove('on')
}

/**
 * Frames the camera on the model's own bounds rather than the roster's sizeM:
 * Tripo's output scale depends on auto_size, so the declared size is a claim
 * about the prop, not about the file that just came back.
 *
 * ONCE PER PROP, not once per model. Swapping between a mesh and its LOD tiers
 * is a comparison, and a comparison whose viewpoint moves between the two
 * frames is not one. The clip planes still track the new model.
 */
let framedFor = null // the prop the current camera placement was chosen for

function frameModel(force = false) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const span = Math.max(size.x, size.y, size.z) || 1
  camera.near = span / 100
  camera.far = span * 50
  camera.updateProjectionMatrix()
  if (force || framedFor !== currentId()) {
    camera.position.set(centre.x + span * 1.6, centre.y + span * 0.9, centre.z + span * 1.6)
    orbit.target.copy(centre)
    framedFor = currentId()
  }
  orbit.update()
  return span
}

/**
 * `which` is a filename under the prop's work dir, or 'mesh' for the working
 * copy. The cache-buster matters: without it the loader serves the previous
 * generation's bytes from the HTTP cache and the mesh appears unchanged.
 */
async function showModel(which) {
  const id = currentId()
  const file = which === 'mesh' ? assets.mesh : which
  if (!file) throw new Error('no working mesh on disk -- generate one, or pick a mesh candidate')
  const url = `${WORK_URL}/${encodeURIComponent(id)}/${file}?t=${Date.now()}`
  const gltf = await loadScene(url)

  clearModel()
  model = gltf.scene
  scene.add(model)

  let tris = 0
  let found = null
  model.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3
    if (!found && o.material?.map?.image) found = o.material.map
    o.material.wireframe = $('showWire').checked
  })

  const span = frameModel()

  const requested = Number($('faceLimit').value)
  const over = tris > requested * 1.25
  $('meshStats').innerHTML =
    `${Math.round(tris)} tris (asked for ${requested}) &middot; ${span.toFixed(2)}m longest side` +
    (over ? ' <span class="warn">-- over the requested limit; face_limit is a target, not a contract</span>' : '')

  drawTexture(found)
  $('viewer').classList.add('on')
  setSize()
}

// --- the shipping resolutions -----------------------------------------------
//
// Both canvases draw the same Tripo source; only the destination size differs.
// The mesh never wears the raw 2048: the world caps every generated colour map
// at TEX_PX_MAX and designates the small ones TEX_PX_SMALL, so the preview
// wears the prop's own designation by default and clicking the other figure
// shows the trade.

let texChoice = null // a side in px: the prop's designation from loadProp, or the figure clicked since
let twins = {} // side -> the canvas at that side as a texture, rebuilt per source
let sourceMap = null // the map the twins were reduced from
const originalMaps = new WeakMap() // material -> the map it arrived with

function drawTexture(map) {
  const row = $('texRow')
  sourceMap = map?.image ? map : null
  twins = {}
  if (!sourceMap) { row.classList.remove('on'); return }

  // An FBX's texture is embedded and decoded through a blob URL, which the
  // loader does not wait for: the image exists with width 0, and drawing it
  // paints nothing at all rather than failing.
  if (!sourceMap.image.width) {
    sourceMap.image.addEventListener('load', () => drawTexture(map), { once: true })
    return
  }

  for (const [id, size] of [['texMax', texPx.max], ['texSmall', texPx.small]]) {
    const canvas = $(id)
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(sourceMap.image, 0, 0, size, size)
    twins[size] = canvasTwin(canvas, sourceMap)
  }

  row.classList.add('on')
  applyTexture()
}

/**
 * A canvas as a texture wearing `like`'s sampling state. Copied, not defaulted:
 * CanvasTexture flips Y where a glTF texture does not, and a wrong flip reads
 * as a plausible-looking texture on the wrong islands.
 */
function canvasTwin(canvasEl, like) {
  const t = new THREE.CanvasTexture(canvasEl)
  t.flipY = like.flipY
  t.colorSpace = like.colorSpace
  t.wrapS = like.wrapS
  t.wrapT = like.wrapT
  t.minFilter = like.minFilter
  t.magFilter = like.magFilter
  return t
}

/** Put the chosen side on every material that arrived wearing `sourceMap`. */
function applyTexture() {
  for (const [id, side] of [['texMax', texPx.max], ['texSmall', texPx.small]]) {
    $(id).parentElement.classList.toggle('is-active', texChoice === side)
  }
  if (!model || !sourceMap) return
  const twin = twins[texChoice]
  if (!twin) throw new Error(`no ${texChoice}px twin of the source map`)
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!originalMaps.has(m)) {
        if (!m.map) continue
        originalMaps.set(m, m.map)
      }
      // A second material with its own atlas keeps it: the twins were reduced
      // from one map, and handing one to another is showing the wrong picture.
      if (originalMaps.get(m) !== sourceMap) continue
      m.map = twin
      m.needsUpdate = true
    }
  })
}

for (const [id, key] of [['texMax', 'max'], ['texSmall', 'small']]) {
  $(id).parentElement.addEventListener('click', () => { texChoice = texPx[key]; applyTexture() })
}

// --- LOD: our decimator, run in this tab ------------------------------------

let lodMaterial = null // the source mesh's material, reused so tiers preview textured

/**
 * The source material with the atlas taken off and the bake switched on: a
 * drop tier has no uv attribute, so a map left on would sample texel (0,0)
 * across the whole prop.
 */
function bakedMaterial() {
  const m = lodMaterial.clone()
  m.map = null
  m.vertexColors = true
  return m
}

/**
 * Plain arrays in. decimate.js knows nothing about three -- it has to run under
 * node in scripts/check-decimate.mjs -- so the bridge lives on this side.
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

function toGeometry(mesh, colors) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  // A drop-mode tier has no atlas, so there is no `uv` to set and the colour
  // bake stands in.
  if (mesh.uvs) g.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2))
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (mesh.normals) g.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1))
  if (!mesh.normals) g.computeVertexNormals()
  return g
}

/**
 * Point sampler over a texture image. glTF puts the UV origin top-left and
 * GLTFLoader sets `flipY = false` to match, so v maps straight down the image;
 * a texture that was flipped back has to be read the other way up.
 */
function textureSampler(image, flipY) {
  const { width, height } = image
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  ctx.canvas.width = width
  ctx.canvas.height = height
  ctx.drawImage(image, 0, 0)
  const data = ctx.getImageData(0, 0, width, height).data
  const clamp = (n, hi) => Math.min(hi, Math.max(0, n))
  return (u, v) => {
    const x = clamp(Math.round(u * (width - 1)), width - 1)
    const y = clamp(Math.round((flipY ? 1 - v : v) * (height - 1)), height - 1)
    const i = (y * width + x) * 4
    return [data[i], data[i + 1], data[i + 2]]
  }
}

/**
 * Bake the source texture into per-vertex colours, using each output vertex's
 * remembered location in the ORIGINAL atlas. getImageData hands back sRGB
 * bytes; three's vertex colours are working-space, so the conversion is not
 * optional.
 */
function bakeColors(mesh, sample) {
  const uv = mesh.sampleUvs
  if (!uv) throw new Error('a drop-mode tier arrived without sampleUvs -- there is nothing to bake from')
  const count = mesh.positions.length / 3
  const out = new Float32Array(count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < count; i++) {
    const [r, g, b] = sample(uv[i * 2], uv[i * 2 + 1])
    c.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
    out[i * 3] = c.r
    out[i * 3 + 1] = c.g
    out[i * 3 + 2] = c.b
  }
  return out
}

/**
 * Weld tolerance, given as a percentage of the bounding diagonal. Blank means
 * the decimator's own hair-thin default; past ~1% it raises the floor, because
 * fusing points across a gap makes non-manifold edges that then pin themselves.
 */
function parseWeld(text, diagonal) {
  const s = text.trim()
  if (!s) return undefined
  const n = Number(s.replace('%', ''))
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${text}" is not a weld tolerance -- want a percentage of the bounding diagonal`)
  return (n / 100) * diagonal
}

function parseWeight(text, name) {
  const n = Number(text.trim())
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${text}" is not a ${name} weight -- want a number, 0 or more`)
  return n
}

/** Diagonal of the bounding box, the unit the weld tolerance is expressed in. */
function boundsDiagonal(positions) {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], positions[i + a])
      hi[a] = Math.max(hi[a], positions[i + a])
    }
  }
  return Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
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
  $('meshAnalysis').textContent = ''
  $('saveLod').disabled = true
}

/**
 * The one mesh in the selected candidate, loaded fresh. Both the decimator and
 * the card bake want the same thing and neither may use the previewed model:
 * that one is wearing whatever texture and wireframe state the last click left
 * on it, and the bake photographs exactly what it is handed.
 */
async function loadSelectedMesh() {
  if (!selectedMesh) throw new Error('no mesh candidate selected -- generate one, or click a candidate above')
  const id = currentId()
  const gltf = await loadScene(`${WORK_URL}/${encodeURIComponent(id)}/meshes/${selectedMesh}?t=${Date.now()}`)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
  // Loud rather than clever: a multi-mesh file would need per-mesh ladders and a
  // merge rule, and silently decimating only the first would look like it worked.
  if (meshes.length !== 1) throw new Error(`expected one mesh in ${selectedMesh}, found ${meshes.length} -- the ladder is per-mesh and this file needs splitting first`)
  return { root: gltf.scene, mesh: meshes[0] }
}

$('genLod').addEventListener('click', () => withButton($('genLod'), 'decimating', async () => {
  const { mesh } = await loadSelectedMesh()
  lodMaterial = mesh.material

  const plain = toPlainMesh(mesh.geometry)
  const weldEps = parseWeld($('lodWeld').value, boundsDiagonal(plain.positions))
  const analysis = analyzeMesh(plain, { weldEps })
  // The atlas floor: where decimation stops if every UV island must survive
  // exactly. It is the number that explains a tier switching to stretch.
  const floor = decimate(plain, 1, { weldEps, uvMode: 'preserve' }).stats.outputTris
  $('meshAnalysis').innerHTML =
    `${analysis.tris} tris, ${analysis.points} welded points &middot; ` +
    `${analysis.pieces} piece${analysis.pieces === 1 ? '' : 's'}` +
    `${analysis.pieces === 1 ? '' : ` (${analysis.minorFaces} faces off the main one)`} &middot; ` +
    `${analysis.uvIslands} UV island${analysis.uvIslands === 1 ? '' : 's'} &middot; ` +
    `${analysis.lockedPoints} pinned (${Math.round((analysis.lockedPoints / analysis.points) * 100)}%) &middot; ` +
    `${analysis.lockedFaces} unremovable faces &middot; ` +
    `quads ${Math.round(analysis.quadFraction * 100)}% &middot; ` +
    `atlas floor ${floor} tris`

  const targets = parseTargets($('lodTargets').value, analysis.tris)
  const sizeWeight = parseWeight($('lodSize').value, 'size'), shapeWeight = parseWeight($('lodShape').value, 'shape')
  const tiers = decimateLadder(plain, targets, { weldEps, uvMode: 'auto', sizeWeight, shapeWeight })
  // Sampled once, not per tier: every tier reads the same original texture.
  const map = lodMaterial.map
  const sample = map && map.image ? textureSampler(map.image, map.flipY) : null
  lodTiers = tiers.map((t, i) => {
    const baked = t.stats.uvMode === 'drop' && sample ? bakeColors(t, sample) : null
    // Preserve and stretch tiers still index the original atlas, so they wear
    // the source material; only a drop tier has to fall back to the bake.
    const material = baked ? bakedMaterial() : lodMaterial
    const object = new THREE.Mesh(toGeometry(t, baked), material)
    return {
      level: i + 1,
      object,
      kind: 'decimated',
      tris: t.stats.outputTris,
      targetTris: t.stats.targetTris,
      uvMode: t.stats.uvMode,
      reason: t.stats.reason,
      texture: material.map ?? null,
      detail:
        `lod${i + 1}: ${t.stats.outputTris} tris (asked ${t.stats.targetTris}, from ${t.stats.inputTris}) &middot; ` +
        `${t.stats.collapses} collapses &middot; ${t.stats.lockedPoints}/${t.stats.totalPoints} points pinned &middot; ` +
        `${t.stats.pieces} &rarr; ${t.stats.piecesLeft} pieces (${t.stats.piecesDropped} deleted whole) &middot; ` +
        (t.stats.uvMode === 'drop' ? 'atlas dropped, texture baked to vertex colours'
          : t.stats.uvMode === 'stretch' ? `atlas kept, ${t.stats.stretched} collapses stretched texels`
          : 'atlas preserved exactly'),
    }
  })

  renderLodTable()
  $('saveLod').disabled = false
  await showTier(lodTiers[0])
  setStatus(`${lodTiers.length} tier(s) built locally, $0.000`, 'ok')
}))

// --- the card cross ---------------------------------------------------------

const CARD_BAKE = TEX_SIZE * SUPERSAMPLE

/**
 * The last rung: two crossed cards, four triangles, each carrying its own 128px
 * cutout -- one photographed down the viewer's current line of sight, one a
 * quarter turn round from it. At the range this tier draws, the prop subtends
 * a few dozen pixels and its silhouette is the whole of what reads, so which
 * quarter turn you pick is the only real decision, and the bench makes it by
 * asking what you are already looking at.
 *
 * Captured at SUPERSAMPLE and boxed down in JS, the same way src/props/impostor.js
 * does it for ferns and for the same reason: an alpha-tested cutout rendered
 * straight at 128 has a binary one-texel edge. `dilate` then pushes colour
 * outward into the transparent margin, because bilinear filtering at the
 * silhouette blends TOWARD unwritten texels and an unwritten texel is
 * transparent BLACK.
 */
async function bakeCardCross() {
  const { root, mesh } = await loadSelectedMesh()

  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  if (!(size.y > 0)) throw new Error('the selected mesh has no height -- there is nothing to photograph')
  const centre = box.getCenter(new THREE.Vector3())

  // The front card is whatever the viewer is pointed at right now. Only the
  // BEARING is taken: the cards are vertical, so the camera's height above the
  // model is irrelevant and would only tilt the photograph.
  const eye = camera.position.clone().sub(orbit.target)
  if (Math.hypot(eye.x, eye.z) < 1e-6) {
    throw new Error('the camera is looking straight down -- orbit round to the side you want as the front, then bake')
  }
  const front = Math.atan2(eye.x, eye.z)

  // Stood at the origin with its base on y = 0, which is where impostorCardExtents
  // puts the bottom edge of a card and therefore the bottom row of the picture.
  root.position.set(-centre.x, -box.min.y, -centre.z)
  const bakeScene = new THREE.Scene()
  bakeScene.add(root)

  const reach = Math.max(size.x, size.y, size.z)
  // The bake rig from impostor.js, with a SOLID's ground bounce. The key rides
  // the capture's own azimuth rather than a fixed world direction -- anywhere
  // else burns a left-right terminator into a picture seen from both sides.
  const key = new THREE.DirectionalLight(0xffffff, 1.5)
  bakeScene.add(key)
  bakeScene.add(new THREE.HemisphereLight(0xffffff, BAKE_ROCK_BOUNCE, 1.0))

  const target = new THREE.WebGLRenderTarget(CARD_BAKE, CARD_BAKE, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  })
  const prevTarget = renderer.getRenderTarget()
  const prevClear = renderer.getClearColor(new THREE.Color())
  const prevAlpha = renderer.getClearAlpha()

  const group = new THREE.Group()
  const textures = []
  const cards = []
  // Screen-right at azimuth a is (cos a, 0, -sin a), so a box of size.x by size.z
  // projects to this much width across the camera. The box is symmetric about
  // the vertical axis through its own centre, and that axis is the origin, so
  // the subject lands centred at EVERY bearing and the two cards cross on that
  // same line.
  const widthAcross = (a) => Math.abs(Math.cos(a)) * size.x + Math.abs(Math.sin(a)) * size.z
  for (const [name, azimuth] of [['front', front], ['side', front + Math.PI / 2]]) {
    const width = widthAcross(azimuth)
    const { width: cardW, height: cardH } = impostorCardExtents({ width, height: size.y })
    cards.push({ name, width })

    // Ortho, because a card seen from 20 m and from 60 m has to be the same
    // picture. The frustum's [bottom, top] of [0, cardH] with a level camera
    // puts the subject's base exactly on the picture's bottom edge.
    const cam = new THREE.OrthographicCamera(-cardW / 2, cardW / 2, cardH, 0, 0.01, reach * 8)
    cam.position.set(Math.sin(azimuth) * reach * 2, 0, Math.cos(azimuth) * reach * 2)
    cam.lookAt(0, 0, 0)
    key.position.set(Math.sin(azimuth) * reach * 0.9, reach * 2.1, Math.cos(azimuth) * reach * 0.9)

    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear(true, true, false)
    renderer.render(bakeScene, cam)
    const raw = new Uint8Array(CARD_BAKE * CARD_BAKE * 4)
    renderer.readRenderTargetPixels(target, 0, 0, CARD_BAKE, CARD_BAKE, raw)

    const px = downsample(raw, CARD_BAKE)
    dilate(px)
    // NOT flipped. GL hands back its bottom row first, which is the subject's
    // base, and glTF reads image row 0 at v = 0 -- so the raw row order is
    // already the one a plane's own uvs want.
    const { preview, exported } = cardTextures(px)
    textures.push(exported)

    // A card faces the camera that photographed it, and a plane's normal starts
    // on +Z, so the yaw IS the azimuth.
    const geometry = new THREE.PlaneGeometry(cardW, cardH)
    geometry.translate(0, cardH / 2, 0)
    geometry.rotateY(azimuth)
    const card = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      map: preview,
      // Unlit: the light is already in the photograph.
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      name: `card-${name}`,
    }))
    card.name = `card-${name}`
    group.add(card)
  }

  renderer.setRenderTarget(prevTarget)
  renderer.setClearColor(prevClear, prevAlpha)
  target.dispose()

  // Dropped back over the mesh it was photographed from, so flipping between
  // the two tiers compares silhouettes rather than positions.
  group.position.set(centre.x, box.min.y, centre.z)

  mesh.geometry.dispose()
  return { group, textures, size, cards, front }
}

/**
 * The dilated cutout as two textures over the same bytes. Three uploads the raw
 * array as-is, so the PREVIEW is exact. GLTFExporter can only serialise an image
 * a canvas can draw, and a canvas backing store is premultiplied, which zeroes
 * the colour of every fully transparent texel -- precisely the gutter `dilate`
 * just wrote. So the exported copy loses the gutter and the previewed one keeps
 * it; the shipping card is re-photographed from the mesh by bakeImpostor, which
 * dilates into the prop atlas itself.
 */
function cardTextures(px) {
  const preview = new THREE.DataTexture(px, TEX_SIZE, TEX_SIZE, THREE.RGBAFormat)
  preview.colorSpace = THREE.SRGBColorSpace
  preview.minFilter = THREE.LinearMipmapLinearFilter
  preview.magFilter = THREE.LinearFilter
  preview.generateMipmaps = true
  preview.needsUpdate = true

  const canvas = document.createElement('canvas')
  canvas.width = TEX_SIZE
  canvas.height = TEX_SIZE
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), TEX_SIZE, TEX_SIZE), 0, 0)
  const exported = new THREE.CanvasTexture(canvas)
  exported.colorSpace = THREE.SRGBColorSpace
  // The bytes are already in glTF's row order, so the exporter must not flip
  // them back.
  exported.flipY = false

  return { preview, exported }
}

$('genCards').addEventListener('click', () => withButton($('genCards'), 'baking card cross', async () => {
  const { group, textures, size, cards, front } = await bakeCardCross()
  const bearing = Math.round(((THREE.MathUtils.radToDeg(front) % 360) + 360) % 360)
  const level = lodTiers.length + 1
  if (level > 9) throw new Error('nine tiers is the ceiling -- shorten the target list first')
  lodTiers = [...lodTiers, {
    level,
    object: group,
    kind: 'cards',
    tris: 4,
    targetTris: 4,
    uvMode: 'cards',
    reason: 'a cross is two quads; there is no lower rung',
    texture: null,
    exportTextures: textures,
    detail:
      `lod${level}: card cross, 4 tris &middot; two ${TEX_SIZE}px cutouts baked at ${CARD_BAKE}px &middot; ` +
      `front card ${cards[0].width.toFixed(2)}m wide shot from ${bearing}&deg;, side card ${cards[1].width.toFixed(2)}m, ` +
      `both ${(size.y).toFixed(2)}m tall`,
  }]
  renderLodTable()
  $('saveLod').disabled = false
  await showTier(lodTiers[lodTiers.length - 1])
  setStatus(`card cross baked from the current view (front at ${bearing}°, 4 tris, 2 x ${TEX_SIZE}px), $0.000`, 'ok')
}))

// --- the tier table ---------------------------------------------------------

function renderLodTable() {
  const t = $('lodTable')
  const saved = meshCandidates.find((m) => m.file === selectedMesh)?.lods ?? []
  const subject = selectedMesh ? `mesh candidate ${selectedMesh}` : 'no mesh candidate selected'
  $('lodSubject').textContent = selectedMesh ? `LOD target: ${selectedMesh}` : ''
  $('lodHead').textContent = `LOD tiers -- ${subject}`

  // Fresh tiers win over saved ones when they exist: they were decimated from
  // this same candidate in this session, and they carry the stats the saved
  // list only remembers a summary of.
  const fresh = lodTiers.length > 0
  const rows = fresh
    ? lodTiers.map((tier) => ({ tier, level: tier.level, target: tier.targetTris, tris: tier.tris, uvMode: tier.uvMode, reason: tier.reason }))
    : saved.map((l) => ({ lod: l, level: l.level, target: l.targetTris, tris: l.tris, uvMode: l.uvMode, reason: l.kind === 'cards' ? 'card cross' : 'on disk' }))

  if (!rows.length) {
    t.innerHTML = ''
    $('lodWrap').classList.toggle('on', Boolean(selectedMesh))
    if (selectedMesh) t.innerHTML = '<tr><td class="label">no tiers for this candidate yet -- decimate, or bake a card cross</td></tr>'
    return
  }

  t.innerHTML = `<tr><th>tier</th><th>target</th><th>got</th><th>texture</th><th>${fresh ? 'why it stopped' : 'source'}</th></tr>`
  for (const r of rows) {
    const tr = document.createElement('tr')
    const texture = r.uvMode === 'cards' ? `2 x ${TEX_SIZE}px cards` : r.uvMode === 'drop' ? 'baked colours'
      : r.uvMode === 'preserve' ? 'atlas' : r.uvMode === 'stretch' ? 'atlas, stretched' : 'unrecorded'
    tr.innerHTML =
      `<td>lod${r.level}</td><td>${r.target ?? '--'}</td><td>${r.tris ?? '--'}</td>` +
      `<td class="label">${texture}</td><td class="label">${r.reason}</td>`
    tr.style.cursor = 'pointer'
    tr.addEventListener('click', () => {
      const show = r.tier ? showTier(r.tier) : showModel(`meshes/${r.lod.file}`)
      show.catch((e) => setStatus(e.message, 'warn'))
    })
    t.appendChild(tr)
  }
  $('lodWrap').classList.add('on')
}

async function showTier(tier) {
  clearModel()
  model = tier.object
  model.userData.borrowed = true
  scene.add(model)
  model.traverse((o) => { if (o.isMesh) o.material.wireframe = $('showWire').checked })
  frameModel()
  $('meshStats').innerHTML = tier.detail
  drawTexture(tier.texture)
  $('viewer').classList.add('on')
  setSize()
}

$('saveLod').addEventListener('click', () => withButton($('saveLod'), 'writing tiers', async () => {
  const id = currentId()
  const exporter = new GLTFExporter()
  for (const tier of lodTiers) {
    // The card cross previews through DataTextures the exporter cannot draw, so
    // the canvas-backed twins go on for the length of the export and come off
    // again -- swapping them permanently would put the fringed copy on screen.
    const swapped = []
    if (tier.exportTextures) {
      tier.object.children.forEach((card, i) => {
        swapped.push([card.material, card.material.map])
        card.material.map = tier.exportTextures[i]
      })
    }
    let glb
    try {
      glb = await exporter.parseAsync(tier.object, { binary: true })
    } finally {
      for (const [material, map] of swapped) material.map = map
    }

    const q = new URLSearchParams({
      id, level: String(tier.level), mesh: selectedMesh,
      tris: String(tier.tris), targetTris: String(tier.targetTris), uvMode: tier.uvMode, kind: tier.kind,
    })
    const res = await fetch(`/__prop-lod?${q}`, {
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
  setStatus(`${lodTiers.length} tier(s) written to work/${id}/meshes/, $0.000`, 'ok')
}))

/**
 * Rebuild the file dropdown and return what it now has selected: the working
 * mesh and the picked candidate's saved tiers. Whatever was showing wins over
 * the default if that file still exists, so a refresh mid-session does not
 * yank the preview out from under a comparison.
 */
function renderFileSelect() {
  const sel = $('fileSelect')
  const was = sel.value
  sel.innerHTML = ''
  const options = []
  if (assets.mesh) options.push([assets.mesh, 'mesh'])
  // meshes/<n>-lod<k>.glb -> "lod<k>": the <n> is the mesh candidate this tier
  // came from, and only the picked one's tiers are ever listed.
  for (const l of assets.lods) options.push([l, l.replace(/^meshes\/\d+-|\.glb$/g, '')])
  for (const [value, text] of options) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    sel.appendChild(o)
  }
  sel.disabled = !options.length
  if (!options.length) return null
  const has = (v) => options.some(([value]) => value === v)
  sel.value = has(was) ? was : options[0][0]
  return sel.value
}

$('fileSelect').addEventListener('change', (e) => {
  showModel(e.target.value).catch((err) => setStatus(`preview failed: ${err.message}`, 'warn'))
})
$('showWire').addEventListener('change', () => {
  model?.traverse((o) => { if (o.isMesh) o.material.wireframe = $('showWire').checked })
})
$('refit').addEventListener('click', () => { if (model) frameModel(true) })
$('faceLimit').addEventListener('input', () => { $('faceLimitVal').textContent = $('faceLimit').value })

// Tripo refuses smart_low_poly on P1, so the box follows the model rather than
// letting you arm a request that comes back a 400.
function syncSmartLowPoly() {
  const p1 = $('meshModel').value === 'p1'
  $('smartLowPoly').disabled = p1
  if (p1) $('smartLowPoly').checked = false
}
$('meshModel').addEventListener('change', syncSmartLowPoly)
syncSmartLowPoly()

function setSize() {
  const w = canvas.clientWidth || 420, h = canvas.clientHeight || 320
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

function tick() {
  requestAnimationFrame(tick)
  orbit.update()
  renderer.render(scene, camera)
}
requestAnimationFrame(tick)
window.addEventListener('resize', setSize)

$('roster').addEventListener('change', (e) => loadProp(e.target.value).catch((err) => setStatus(err.message, 'warn')))
$('rosterPrev').addEventListener('click', () => stepRoster(-1))
$('rosterNext').addEventListener('click', () => stepRoster(1))
$('propId').addEventListener('change', () => {
  selectedMesh = null
  framedFor = null
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
  // Balance after the roster (it prices itself against the mesh credits) but
  // before anything else, so an empty wallet is on screen before the first click.
  .then(loadBalance)
  .then(loadLibrary)
  .then(() => loadProp(library[0].id))
  .catch((e) => setStatus(`startup failed: ${e.message}`, 'warn'))
