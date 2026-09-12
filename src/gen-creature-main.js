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
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { analyzeMesh, decimate, decimateLadder } from './mesh/decimate.js'
import { cullTripoBackfaces } from './tripo-culling.js'
import { TEX_SIZE } from './textures.js'
import { SUPERSAMPLE, BAKE_ROCK_BOUNCE, impostorCardExtents, downsample, dilate } from './props/impostor.js'

const $ = (id) => document.getElementById(id)
const status = $('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

let library = [] // every creature the bench knows about: roster seeds + anything on disk
let presets = {}
let frames = {} // rigType -> the frame a creature with that silhouette gets by default
let credits = {}
let imageModels = [] // the image models the server will bill for, cheapest first
let candidates = []
let meshCandidates = []
let assets = { source: false, mesh: null, rig: false, rigFixed: false, anims: [], lods: [], state: {} }
// The mesh candidate section 4 operates on. Not the same thing as the PICKED
// candidate: picking is what rigs and ships, selecting is what you are currently
// comparing ladders for, and the whole point of keeping every candidate is being
// able to decimate one you have not committed to.
let selectedMesh = null
let lodTiers = [] // { level, object, stats } decimated from `selectedMesh` this session
// Generations in flight, and the one-second guards on the buttons that start
// them. Declared up here rather than beside their handlers because `refresh`
// reads them and runs before those handlers are ever installed.
let pendingImages = 0
let pendingMeshes = 0
let meshCooling = false
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
  // Checked here rather than trusted, because everything that reads these reads
  // them much later and somewhere else: a response missing `frames` surfaced as
  // "cannot read properties of undefined (reading 'avian')" from the roster
  // arrows, and only on creatures with no saved aspectRatio, since the ?? in
  // loadCreature short-circuits for the ones that have one. vite.config.js's
  // middleware does not hot-reload, so a dev server older than this page is the
  // way that happens.
  if (!j.ok) throw new Error(j.error ?? 'GET /__creature-roster failed')
  for (const k of ['presets', 'frames', 'credits', 'imageModels']) {
    if (!j[k]) throw new Error(`/__creature-roster answered without "${k}" -- restart the dev server, its middleware is older than this page`)
  }
  presets = j.presets
  frames = j.frames
  credits = j.credits
  imageModels = j.imageModels
  // The list comes from the server because the server is what enforces it: an id
  // the select does not offer is refused rather than billed. Cheapest first, so
  // the default is FLUX.
  $('imageModel').innerHTML = imageModels
    .map((m) => `<option value="${m.id}">${m.label} (~$${m.usd.toFixed(3)})</option>`).join('')
  updateImagePrice()
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

function updateImagePrice() {
  const m = imageModels.find((x) => x.id === $('imageModel').value)
  if (!m) throw new Error(`image model "${$('imageModel').value}" is not one the server offers`)
  $('genImage').textContent = `generate candidate (~$${m.usd.toFixed(3)})`
}
$('imageModel').addEventListener('change', updateImagePrice)

/**
 * Reads the Tripo wallet at startup. Costs nothing, and it is the difference
 * between "the pipeline is broken" and "the wallet is empty" -- two failures
 * that look identical from inside a spend button.
 */
async function loadBalance() {
  const box = $('balance')
  const res = await fetch('/__creature-balance')
  const j = await res.json()
  if (!res.ok) { box.innerHTML = `<span class="warn">could not read balance: ${j.error}</span>`; return }
  const usd = (j.balance / 100).toFixed(2)
  const enough = j.balance >= credits.mesh
  box.innerHTML = `${j.balance} credits ($${usd})${j.frozen ? ` &middot; ${j.frozen} frozen` : ''}` +
    (enough ? '' : `<br><span class="warn">not enough for a mesh (${credits.mesh} credits) -- top up at tripo3d.ai before the orange buttons will work</span>`)
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
      [`${c.meshCount} mesh`, c.meshCount > 0],
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
  // The frame follows the SILHOUETTE, so it defaults from the rig type and is
  // only stored per creature once someone overrides it. Most creatures are wide
  // -- see FRAME_BY_RIG in creature-prompt.mjs.
  $('aspectRatio').value = c.aspectRatio ?? frames[c.rigType] ?? '4:3'
  candidates = []
  // Explicitly, not by falling out of refresh's "is the selection still valid"
  // check: every creature numbers its candidates from zero, so "0.glb" is valid
  // for the new one too and the selection would look like it survived.
  selectedMesh = null
  framedFor = null
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
    aspectRatio: $('aspectRatio').value,
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
    aspectRatio: $('aspectRatio').value,
  })
  await loadLibrary()
  await loadCreature(id)
  setStatus(`created ${id} -- generate a candidate image to start`, 'ok')
}))

// The description is only the last line of the prompt: the studio, the pose
// clause for the rig type and the lighting rules are wrapped around it on the
// server, so the preview asks the server rather than guessing at the wrapping.
$('previewPrompt').addEventListener('click', () => withButton($('previewPrompt'), 'composing', async () => {
  const j = await post('/__creature-prompt', {
    description: $('description').value.trim(),
    rigType: $('rigType').value,
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
    fetch(`/__creature-candidates?id=${encodeURIComponent(id)}`),
    fetch(`/__creature-meshes?id=${encodeURIComponent(id)}`),
    fetch(`/__creature-assets?id=${encodeURIComponent(id)}`),
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
  // refresh: `refresh` runs after every action, and re-defaulting here would drag
  // the LOD section back to the picked candidate the moment a tier was saved.
  if (!meshCandidates.some((m) => m.file === selectedMesh)) {
    selectedMesh = (meshCandidates.find((m) => m.picked) ?? meshCandidates[0])?.file ?? null
  }
  renderGallery()
  renderMeshGallery()
  renderAnimList()
  renderLodTable()
  // `meshCooling` is checked here as well as in the timer: refresh runs after
  // every action, and without it a refresh landing inside the cooldown would
  // hand the button straight back and undo the double-click guard.
  $('genMesh').disabled = !assets.source || meshCooling
  $('genLod').disabled = !selectedMesh
  $('genCards').disabled = !selectedMesh
  $('saveLod').disabled = lodTiers.length === 0
  $('rigCheck').disabled = !assets.mesh
  $('genRig').disabled = !assets.mesh
  $('genAnim').disabled = !assets.rig
  // A mesh, not a rig: the armature is one of the things Blender can supply.
  $('blenderRoundTrip').disabled = !assets.mesh
  renderClipSelect()
}

/**
 * A candidate is generated at 1024px and shown at 200px, so the gallery is for
 * telling images apart and this is for judging one. Any click dismisses it, and
 * the src is dropped on the way out: a hidden node still holds the bytes, and
 * the image it points at may be deleted from under it a moment later.
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

    const zoom = document.createElement('button')
    zoom.className = 'corner zoom'
    zoom.innerHTML = '&#128269;'
    zoom.title = `view ${c.file} full size`
    zoom.addEventListener('click', () => openLightbox(c.url, `${c.file} -- $${(c.cost ?? 0).toFixed(4)}`))
    img.style.cursor = 'zoom-in'
    img.addEventListener('click', () => openLightbox(c.url, `${c.file} -- $${(c.cost ?? 0).toFixed(4)}`))

    const trash = document.createElement('button')
    trash.className = 'corner trash'
    trash.innerHTML = '&#128465;'
    trash.title = `delete ${c.file}`
    // Confirmed, unlike every other click in this gallery: the image cost money
    // and there is no way to get this exact one back.
    trash.addEventListener('click', () => {
      if (!window.confirm(`Delete candidate ${c.file}? It cost $${(c.cost ?? 0).toFixed(4)} and cannot be regenerated identically.`)) return
      withButton(trash, `deleting ${c.file}`, async () => {
        await post(`/__creature-delete-candidate?id=${encodeURIComponent(currentId())}`, { file: c.file })
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

// Mesh candidates are the expensive rung of the ladder: every one of these cost
// 40-50 credits and Tripo has no task-history endpoint to re-fetch a lost one
// from. They are listed, never replaced.
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
  // One placeholder per mesh still in flight, so a queued generation is visible
  // as a slot coming rather than as a click that did nothing for a minute.
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
 * Points section 4 at one mesh candidate and previews it. The in-memory tiers go
 * with the old selection: they were decimated from a different mesh, and leaving
 * them on screen under a new candidate's heading is the one way this table can
 * lie about what it is showing.
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

// Neither generate button waits for its request: it goes dead for a second --
// long enough that a double-click is one generation, not two -- and then lets
// you queue the next. The cooldown is the whole of the protection against an
// accidental double charge, so it guards the expensive button too (see
// queueMesh); what it deliberately does NOT do is cap how many run at once,
// because Tripo's minute of wall clock is the same minute for four meshes as
// for one.
const IMAGE_QUEUE_COOLDOWN_MS = 1000
const MESH_QUEUE_COOLDOWN_MS = 1000

$('genImage').addEventListener('click', () => {
  const btn = $('genImage')
  btn.disabled = true
  window.setTimeout(() => { btn.disabled = false }, IMAGE_QUEUE_COOLDOWN_MS)
  queueImage()
})

async function queueImage() {
  // Read now, not when the response lands: the prompt field and model are
  // editable and a queued generation belongs to what was on screen when it was
  // asked for.
  const body = {
    id: currentId(),
    description: $('description').value.trim(),
    rigType: $('rigType').value,
    aspectRatio: $('aspectRatio').value,
    model: $('imageModel').value,
  }
  pendingImages++
  renderGallery()
  setStatus(`generating ${pendingImages} candidate image${pendingImages === 1 ? '' : 's'}`)
  try {
    const j = await post('/__creature-image', body)
    bill('image', j.cost)
    pendingImages--
    // The server's own copy, not the page's reconstruction of it: "is my edit
    // even being used" is otherwise unanswerable without reading the source.
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
  const j = await post(`/__creature-pick?id=${encodeURIComponent(currentId())}`, { file })
  await refresh()
  setStatus(`picked -> ${j.path}`, 'ok')
}

async function pickMesh(file) {
  const j = await post(`/__creature-pick-mesh?id=${encodeURIComponent(currentId())}`, { file })
  // Tiers in memory were decimated from the mesh that was picked a moment ago;
  // keeping them would let "save tiers" write them under this mesh's name.
  clearLods()
  await refresh()
  await showModel('mesh')
  setStatus(`working mesh -> ${j.path}`, 'ok')
}

// Mesh generation queues the same way image generation does. A Tripo mesh takes
// about a minute of wall clock and four of them in flight take the same minute,
// so serialising them was costing four minutes to look at four candidates. The
// button still goes dead for a second, which is what keeps a double-click from
// charging 100 credits.
$('genMesh').addEventListener('click', () => {
  meshCooling = true
  $('genMesh').disabled = true
  window.setTimeout(() => {
    meshCooling = false
    // Through refresh's own rule, not straight to enabled: source.png may have
    // gone away while this was cooling.
    $('genMesh').disabled = !assets.source
  }, MESH_QUEUE_COOLDOWN_MS)
  queueMesh()
})

async function queueMesh() {
  // Read now, not when the response lands: the model and face-limit controls
  // stay live, and a queued mesh belongs to the settings it was asked for with.
  const p1 = $('meshModel').value === 'p1'
  const body = {
    model: p1 ? 'P1-20260311' : 'v3.1-20260211',
    faceLimit: Number($('faceLimit').value),
    // P1 is already a low-poly generator and Tripo rejects the flag on it.
    smartLowPoly: !p1 && $('smartLowPoly').checked,
    pbr: $('meshPbr').checked,
  }
  // The creature is captured too: a mesh takes a minute, and switching creatures
  // meanwhile must not file the result under whichever one is on screen.
  const id = currentId()
  pendingMeshes++
  renderMeshGallery()
  setStatus(`generating ${pendingMeshes} mesh${pendingMeshes === 1 ? '' : 'es'} (Tripo, about a minute each)`)
  try {
    const j = await post(`/__creature-mesh?id=${encodeURIComponent(id)}`, body)
    bill('mesh', j.credits / 100)
    pendingMeshes--
    if (j.autoPicked) clearLods()
    if (id !== currentId()) {
      setStatus(`mesh candidate ${j.file} saved to ${id} (${j.credits} credits)`, 'ok')
      return
    }
    await refresh()
    // Only when nothing else is queued. Yanking the viewer to each mesh as it
    // lands makes the last one to arrive win, which is not the one you were
    // looking at.
    if (!pendingMeshes) await selectMesh(j.file)
    setStatus(j.autoPicked
      ? `mesh -> ${j.path} (${j.credits} credits), picked as the working mesh`
      : `mesh candidate ${j.file} -> ${j.path} (${j.credits} credits)${pendingMeshes ? ` -- ${pendingMeshes} still generating` : ' -- "pick" it to rig or decimate it'}`, 'ok')
  } catch (e) {
    pendingMeshes--
    renderMeshGallery()
    setStatus(`generating mesh failed: ${e.message}`, 'warn')
  }
}

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

// A click on a <dialog>'s backdrop targets the dialog element itself, so the
// hit test is against its box rather than the event target: the dialog has
// padding, and a click landing in that padding is inside the popup even though
// it targets the same element the backdrop does.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return
    const r = dlg.getBoundingClientRect()
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    if (!inside) dlg.close()
  })
}

// --- the Blender round trip -------------------------------------------------
//
// Authoring clips is Blender's job, not ours, so the bench's whole part in it
// is telling you where the files go. The instructions live in the dialog's
// markup; what is computed here is the path and which file to import, because
// that differs by how far the creature has got.

const workPath = (id) => `tools/creatures/work/${id}`

$('blenderRoundTrip').addEventListener('click', () => {
  const id = currentId()
  $('blenderDir').textContent = `${workPath(id)}/`
  // Whatever is furthest along: rig-fixed.glb once the rig editor has saved
  // names to it, rig.glb if Tripo rigged it, and otherwise the bare mesh --
  // which is the right import when the armature is Blender's job too.
  $('blenderImport').textContent = assets.rigFixed ? 'rig-fixed.glb' : assets.rig ? 'rig.glb' : assets.mesh
  $('blenderNoRig').hidden = assets.rig
  $('blenderDialog').showModal()
})

$('blenderReveal').addEventListener('click', () => withButton($('blenderReveal'), 'opening Finder', async () => {
  const j = await post(`/__creature-reveal?id=${encodeURIComponent(currentId())}`, {})
  setStatus(j.revealed ? `Finder: ${j.revealed} in ${j.dir}` : `Finder: ${j.dir}`, 'ok')
}))

$('blenderCopy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(`${workPath(currentId())}/`)
  setStatus('path copied', 'ok')
})

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
const fbxLoader = new FBXLoader()

/**
 * Tripo delivers quad topology as FBX, because glTF has no quads, so a mesh
 * candidate is not always a glb. The workspace names each file from the bytes it
 * downloaded, which makes the extension the honest answer to which loader to use.
 */
// Every Tripo file the bench shows comes through here, so this is where they
// get culled (see tripo-culling.js).
async function loadScene(url) {
  if (/\.fbx(\?|$)/i.test(url)) {
    const root = await fbxLoader.loadAsync(url)
    return { scene: cullTripoBackfaces(root), animations: root.animations ?? [] }
  }
  const gltf = await loader.loadAsync(url)
  cullTripoBackfaces(gltf.scene)
  return gltf
}
let model = null
let skeletonHelper = null
let mixer = null
const clock = new THREE.Clock()

// --- bone names -------------------------------------------------------------
//
// A skeleton helper draws every bone as the same white stick, and which bone is
// which is exactly what a misbehaving clip turns on: Tripo retargets its presets
// BY NAME, and its names are its own guess at anatomy. On the fox it guessed
// wrong -- the spine came back called `0_Left_Limb_1` and a front leg called
// `Spine_0` -- so the walk cycle bends the animal at bones that are not joints
// of the kind the clip thinks they are. `scripts/probe-rig.mjs` prints the same
// names against each joint's measured position; this is the version you can
// orbit. The `tripo::` prefix is dropped because every name carries it.
let bones = []

function setBones(list) {
  bones = list
  const box = $('boneLabels')
  box.innerHTML = ''
  for (const b of bones) {
    const el = document.createElement('span')
    el.textContent = b.name.replace(/^tripo::/, '')
    box.appendChild(el)
  }
}

const labelAt = new THREE.Vector3()

function drawBoneLabels() {
  const box = $('boneLabels')
  const on = $('showBoneNames').checked && bones.length > 0
  box.classList.toggle('on', on)
  if (!on) return
  const w = canvas.clientWidth, h = canvas.clientHeight
  bones.forEach((b, i) => {
    const el = box.children[i]
    b.getWorldPosition(labelAt).project(camera)
    // Behind the camera, x and y flip sign; placing those would scatter labels
    // across the frame at mirrored positions.
    el.style.display = labelAt.z > 1 ? 'none' : ''
    el.style.left = `${(labelAt.x * 0.5 + 0.5) * w}px`
    el.style.top = `${(-labelAt.y * 0.5 + 0.5) * h}px`
  })
}

function clearModel() {
  if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null }
  setBones([])
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
 *
 * ONCE PER CREATURE, not once per model. Swapping between a mesh and its LOD
 * tiers is a comparison, and a comparison whose viewpoint moves between the two
 * frames is not one -- the eye reads the reframing as the change. The clip
 * planes still track the new model, since those cannot be judged by eye and a
 * stale near plane clips the thing being compared.
 */
let framedFor = null // the creature the current camera placement was chosen for

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

async function showModel(which) {
  const id = currentId()
  const file = which === 'mesh' ? assets.mesh : which === 'rig' ? 'rig.glb' : which
  if (!file) throw new Error('no working mesh on disk -- generate one, or pick a mesh candidate')
  const url = `/tools/creatures/work/${encodeURIComponent(id)}/${file}?t=${Date.now()}`
  const gltf = await loadScene(url)

  clearModel()
  model = gltf.scene
  scene.add(model)

  let tris = 0
  let found = null
  let foundRough = null
  model.traverse((o) => {
    if (!o.isMesh) return
    const g = o.geometry
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3
    if (!found && o.material?.map?.image) {
      found = o.material.map
      foundRough = o.material.roughnessMap ?? null
    }
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
  setBones(skeletonHelper.bones.filter((b) => b.name))

  if (gltf.animations?.length) {
    mixer = new THREE.AnimationMixer(model)
    mixer.clipAction(gltf.animations[0]).play()
  }

  drawTexture(found, foundRough)
  $('viewer').classList.add('on')
  setSize()
}

// --- the resolution comparison ----------------------------------------------
//
// Both canvases draw the same source; only the destination size differs, so what
// the small one loses is exactly what a 128px layer would lose. The preview wears
// the SOURCE by default: creatures ship on their own 512px array rather than in
// the 128px prop atlas (design/27-creature-pipeline.md), so the source is the
// shipping resolution and the 128 figure is now the comparison, not the target.
// Clicking either figure puts that resolution on the model.

let texChoice = 'source' // sticky across previews: a choice made once should hold
let downrez = null // the 128px canvas as a texture, rebuilt per source
let sourceMap = null // the map `downrez` was reduced from, and the other choice
const originalMaps = new WeakMap() // material -> the map it arrived with

function drawTexture(map, roughnessMap = null) {
  const row = $('texRow')
  sourceMap = map?.image ? map : null
  downrez = null
  if (!sourceMap) { row.classList.remove('on'); return }

  // An FBX's texture is embedded and decoded through a blob URL, which the
  // loader does not wait for: the image exists with width 0, and drawing it
  // paints nothing at all rather than failing.
  if (!sourceMap.image.width) {
    sourceMap.image.addEventListener('load', () => drawTexture(map, roughnessMap), { once: true })
    return
  }

  for (const [id, size] of [['texFull', 256], ['tex128', 128]]) {
    const ctx = $(id).getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, size, size)
    ctx.drawImage(sourceMap.image, 0, 0, size, size)
  }
  drawRoughness(roughnessMap)

  downrez = new THREE.CanvasTexture($('tex128'))
  // Copied, not defaulted. CanvasTexture flips Y where a glTF texture does not,
  // and a wrong flip reads as a plausible-looking texture on the wrong islands.
  downrez.flipY = sourceMap.flipY
  downrez.colorSpace = sourceMap.colorSpace
  downrez.wrapS = sourceMap.wrapS
  downrez.wrapT = sourceMap.wrapT
  downrez.minFilter = sourceMap.minFilter
  downrez.magFilter = sourceMap.magFilter

  row.classList.add('on')
  applyTexture()
}

/**
 * Tripo's roughness at the shipping resolution, as greyscale. glTF packs
 * roughness into the GREEN channel of the metallicRoughness texture (blue is
 * metallic, red unused), so the raw image reads as a green-blue wash and says
 * nothing; the G channel alone is the shiny/matte segmentation this figure
 * exists to judge. Hidden when the mesh was generated without PBR.
 */
function drawRoughness(roughnessMap) {
  const fig = $('texRoughFig')
  const image = roughnessMap?.image
  fig.hidden = !image
  if (!image) return
  if (!image.width) {
    image.addEventListener('load', () => drawRoughness(roughnessMap), { once: true })
    return
  }
  const ctx = $('texRough').getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, 128, 128)
  const px = ctx.getImageData(0, 0, 128, 128)
  const d = px.data
  for (let i = 0; i < d.length; i += 4) d[i] = d[i + 2] = d[i + 1]
  ctx.putImageData(px, 0, 0)
}

/** Put the chosen resolution on every material that arrived wearing `sourceMap`. */
function applyTexture() {
  for (const [id, choice] of [['texFull', 'source'], ['tex128', '128']]) {
    $(id).parentElement.classList.toggle('is-active', texChoice === choice)
  }
  if (!model || !sourceMap) return
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!originalMaps.has(m)) {
        if (!m.map) continue
        originalMaps.set(m, m.map)
      }
      const original = originalMaps.get(m)
      // A second material with its own atlas keeps it: the downrez was reduced
      // from one map, and handing it to another is showing the wrong picture.
      if (original !== sourceMap) continue
      m.map = texChoice === '128' && downrez ? downrez : original
      m.needsUpdate = true
    }
  })
}

for (const [id, choice] of [['texFull', 'source'], ['tex128', '128']]) {
  $(id).parentElement.addEventListener('click', () => { texChoice = choice; applyTexture() })
}

// --- LOD: our decimator, run in this tab ------------------------------------

let lodMaterial = null // the source mesh's material, reused so tiers preview textured

/**
 * The source material with the atlas taken off and the bake switched on. The
 * PBR maps go with it: a drop tier has no uv attribute, so any map left on
 * would sample texel (0,0) across the whole creature.
 */
function bakedMaterial() {
  const m = lodMaterial.clone()
  m.map = null
  m.roughnessMap = null
  m.metalnessMap = null
  m.normalMap = null
  m.vertexColors = true
  return m
}

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
 * remembered location in the ORIGINAL atlas. This is what buys the low tiers:
 * once the atlas is gone the decimator is free, and the colour is what is left
 * of the texture. getImageData hands back sRGB bytes; three's vertex colours are
 * working-space, so the conversion is not optional.
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
 * the decimator's own hair-thin default. Measured on the fox: welding harder
 * does not lower the floor, and past ~1% it raises it, because fusing points
 * across a gap makes non-manifold edges that then pin themselves.
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
  const gltf = await loadScene(`/tools/creatures/work/${encodeURIComponent(id)}/meshes/${selectedMesh}?t=${Date.now()}`)
  const meshes = []
  gltf.scene.traverse((o) => { if (o.isMesh) meshes.push(o) })
  // Loud rather than clever: a multi-mesh file would need per-mesh ladders and a
  // merge rule, and silently decimating only the first would look like it worked.
  if (meshes.length !== 1) throw new Error(`expected one mesh in ${selectedMesh}, found ${meshes.length} -- the ladder is per-mesh and this file needs splitting first`)
  return { root: gltf.scene, mesh: meshes[0] }
}

$('genLod').addEventListener('click', () => withButton($('genLod'), 'decimating', async () => {
  const { mesh } = await loadSelectedMesh()
  const meshes = [mesh]
  lodMaterial = meshes[0].material

  const plain = toPlainMesh(meshes[0].geometry)
  const weldEps = parseWeld($('lodWeld').value, boundsDiagonal(plain.positions))
  const analysis = analyzeMesh(plain, { weldEps })
  // The atlas floor: where decimation stops if every UV island must survive
  // exactly. One island cannot go below one triangle, so a shattered atlas is a
  // hard floor, and it is the number that explains a tier switching to stretch.
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
      roughness: material.roughnessMap ?? null,
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
 * quarter turn round from it. At the range this tier draws, the creature
 * subtends a few dozen pixels and its silhouette is the whole of what reads,
 * so which quarter turn you pick is the only real decision, and the bench makes
 * it by asking what you are already looking at.
 *
 * Captured at SUPERSAMPLE and boxed down in JS, the same way src/props/impostor.js
 * does it for ferns and for the same reason: an alpha-tested cutout rendered
 * straight at 128 has a binary one-texel edge, and every mip after that is a
 * worse guess at where the edge was. `dilate` then pushes colour outward into
 * the transparent margin, because bilinear filtering at the silhouette blends
 * TOWARD unwritten texels and an unwritten texel is transparent BLACK.
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

  // Stood at the origin with its feet on y = 0, which is where impostorCardExtents
  // puts the bottom edge of a card and therefore the bottom row of the picture.
  root.position.set(-centre.x, -box.min.y, -centre.z)
  const bakeScene = new THREE.Scene()
  bakeScene.add(root)

  const reach = Math.max(size.x, size.y, size.z)
  // The bake rig from impostor.js, with a SOLID's ground bounce: a fox has no
  // shaded interior the way a canopy does, and the near-black canopy bounce
  // leaves its underside a black wedge. The key rides the capture's own azimuth
  // rather than a fixed world direction -- anywhere else burns a left-right
  // terminator into a picture that gets seen from both sides.
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
  // projects to this much width across the camera -- size.x at a = 0 and size.z at
  // a = 90, which is what the two axis-aligned captures used to be hardcoded to.
  // The box is symmetric about the vertical axis through its own centre, and that
  // axis is now the origin, so the subject lands centred in the frame at EVERY
  // bearing and the two cards cross on that same line rather than beside it.
  const widthAcross = (a) => Math.abs(Math.cos(a)) * size.x + Math.abs(Math.sin(a)) * size.z
  for (const [name, azimuth] of [['front', front], ['side', front + Math.PI / 2]]) {
    const width = widthAcross(azimuth)
    const { width: cardW, height: cardH } = impostorCardExtents({ width, height: size.y })
    cards.push({ name, width })

    // Ortho, because a card seen from 20 m and from 60 m has to be the same
    // picture. The frustum's [bottom, top] of [0, cardH] with a level camera puts
    // the subject's feet exactly on the picture's bottom edge.
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
    // feet, and glTF reads image row 0 at v = 0 -- so the raw row order is
    // already the one a plane's own uvs want, and flipping would only have to be
    // undone on export.
    const { preview, exported } = cardTextures(px)
    textures.push(exported)

    // A card faces the camera that photographed it, and a plane's normal starts
    // on +Z, so the yaw IS the azimuth.
    const geometry = new THREE.PlaneGeometry(cardW, cardH)
    geometry.translate(0, cardH / 2, 0)
    geometry.rotateY(azimuth)
    const card = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      map: preview,
      // Unlit: the light is already in the photograph, and lighting it again
      // would apply the bake rig twice.
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

  // Dropped back over the mesh it was photographed from. The cards are BUILT
  // about a centred vertical axis with their feet on y = 0, which is the shipping
  // convention and not necessarily where this glb's mesh sits; without this the
  // cross stands somewhere else in the viewer and flipping between the two tiers
  // compares positions instead of silhouettes.
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
 * it. That is the right way round: this glb is for looking at, and the shipping
 * card is re-photographed from the mesh by bakeImpostor, which dilates into the
 * prop atlas itself.
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
  // them back. Both textures therefore agree that v = 0 is the subject's feet.
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
  // this same candidate in this session, and they carry the stats the saved list
  // only remembers a summary of.
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
  drawTexture(tier.texture, tier.roughness ?? null)
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
    const res = await fetch(`/__creature-lod?${q}`, {
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

function renderClipSelect() {
  const sel = $('clipSelect')
  sel.innerHTML = ''
  const options = []
  if (assets.mesh) options.push([assets.mesh, 'mesh (no rig)'])
  // meshes/<n>-lod<k>.glb -> "lod<k>": the <n> is the mesh candidate this tier
  // came from, and only the picked one's tiers are ever listed.
  for (const l of assets.lods) options.push([l, l.replace(/^meshes\/\d+-|\.glb$/g, '')])
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
  const dt = clock.getDelta()
  mixer?.update(dt)
  orbit.update()
  renderer.render(scene, camera)
  drawBoneLabels()
}
requestAnimationFrame(tick)
window.addEventListener('resize', setSize)

$('roster').addEventListener('change', (e) => loadCreature(e.target.value).catch((err) => setStatus(err.message, 'warn')))
$('rosterPrev').addEventListener('click', () => stepRoster(-1))
$('rosterNext').addEventListener('click', () => stepRoster(1))
$('rigType').addEventListener('change', () => {
  renderAnimList()
  // The frame follows, because changing the rig type is changing what shape the
  // creature is -- and a new creature typed in from scratch would otherwise
  // silently keep whichever frame the last one left in the select.
  const saved = library.find((c) => c.id === currentId())?.aspectRatio
  if (!saved) $('aspectRatio').value = frames[$('rigType').value] ?? '4:3'
})
$('creatureId').addEventListener('change', () => {
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
  // Balance after the roster (it prices itself against credits.mesh) but before
  // anything else, so an empty wallet is on screen before the first click.
  .then(loadBalance)
  .then(loadLibrary)
  .then(() => loadCreature(library[0].id))
  .catch((e) => setStatus(`startup failed: ${e.message}`, 'warn'))
