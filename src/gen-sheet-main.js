// ---------------------------------------------------------------------------
// gen-sheet.html: reroll/preview/pick bench for a character's three sheet
// views. "generate" fires one real OpenRouter call (vite.config.js's
// /__generate-sheet-view, which calls tools/characters/openrouter.mjs) --
// every other action here (picking a candidate, baking) is local and free.
// Side/back generations attach the picked front.png as a reference so the
// character stays consistent across views (see tools/characters/
// sheet-prompt.mjs's header for why each view is its own image rather than
// one multi-view composite).
// ---------------------------------------------------------------------------

import { ROLES, GENDERS, AGES, professionsFor, randomProfession, describeNordicCharacter } from '../tools/characters/nordic-roster.mjs'

const VIEWS = ['front', 'side', 'back']
let view = 'front'
const candidates = { front: [], side: [], back: [] }
const picked = { front: -1, side: -1, back: -1 } // index into candidates[view], or -1
let totalCost = 0
let callCount = 0

const status = document.getElementById('status')
function setStatus(text, cls) { status.textContent = text; status.className = `note ${cls || ''}` }

// --- worldbuilding dropdowns ---------------------------------------------

const roleSelect = document.getElementById('role')
const genderSelect = document.getElementById('gender')
const ageSelect = document.getElementById('age')
const professionSelect = document.getElementById('profession')

function fillOptions(select, options) {
  select.innerHTML = ''
  for (const opt of options) {
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    select.appendChild(el)
  }
}

fillOptions(roleSelect, ROLES.map((r) => ({ value: r.id, label: r.label })))
fillOptions(genderSelect, GENDERS.map((g) => ({ value: g, label: cap(g) })))
fillOptions(ageSelect, AGES.map((a) => ({ value: a, label: cap(a) })))

function fillProfessions() {
  const random = [{ value: 'random', label: '(random)' }]
  const list = professionsFor(ageSelect.value).map((p) => ({ value: p.id, label: p.label }))
  fillOptions(professionSelect, [...random, ...list])
}
fillProfessions()
ageSelect.addEventListener('change', fillProfessions) // child/adult have separate profession lists

// "random" rolls once and locks the concrete pick into the dropdown, rather
// than re-rolling on every generate click -- side/back views need the same
// profession text as front to stay a consistent character.
function resolveProfession() {
  if (professionSelect.value === 'random') {
    professionSelect.value = randomProfession(ageSelect.value).id
  }
  return professionSelect.value
}

function cap(s) { return s[0].toUpperCase() + s.slice(1) }

function vars() {
  return describeNordicCharacter({
    role: roleSelect.value,
    gender: genderSelect.value,
    age: ageSelect.value,
    professionId: resolveProfession(),
  })
}

function currentId() { return document.getElementById('charId').value.trim() }

function selectView(v) {
  view = v
  for (const name of VIEWS) document.getElementById(`view${cap(name)}`).classList.toggle('on', name === v)
  document.getElementById('galleryTitle').textContent = `${v} -- candidates`
  renderGallery()
}

function renderGallery() {
  const gallery = document.getElementById('gallery')
  gallery.innerHTML = ''
  candidates[view].forEach((c, i) => {
    const div = document.createElement('div')
    div.className = 'candidate'
    const img = document.createElement('img')
    img.src = `data:image/png;base64,${c.imageB64}`
    const btn = document.createElement('button')
    const isPicked = picked[view] === i
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

function updateBakeButton() {
  document.getElementById('bake').disabled = !VIEWS.every((v) => picked[v] >= 0)
}

async function generate() {
  const id = currentId()
  if (!/^[a-z0-9-]+$/.test(id)) { setStatus('character id must be lowercase letters, digits, hyphens', 'warn'); return }
  if (view !== 'front' && picked.front < 0) { setStatus('pick a front view first -- side/back reference it', 'warn'); return }

  const btn = document.getElementById('generate')
  btn.disabled = true
  setStatus(`generating ${view}...`)
  try {
    const res = await fetch('/__generate-sheet-view', {
      method: 'POST',
      body: JSON.stringify({ id, view, vars: vars(), useReference: view !== 'front' }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    candidates[view].push({ imageB64: j.imageB64, cost: j.cost })
    totalCost += j.cost
    callCount += 1
    updateCost()
    renderGallery()
    setStatus(`${view}: ${candidates[view].length} candidate(s), last cost $${j.cost.toFixed(4)}`, 'ok')
  } catch (e) {
    setStatus(`generate failed: ${e.message}`, 'warn')
  } finally {
    btn.disabled = false
  }
}

async function pickCandidate(i) {
  const id = currentId()
  const c = candidates[view][i]
  setStatus(`saving ${view} pick...`)
  try {
    const res = await fetch(`/__save-sheet-view?id=${encodeURIComponent(id)}&view=${view}`, {
      method: 'POST',
      body: JSON.stringify({ imageB64: c.imageB64 }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    picked[view] = i
    renderGallery()
    updateBakeButton()
    setStatus(`saved -> ${j.path}`, 'ok')
  } catch (e) {
    setStatus(`save failed: ${e.message}`, 'warn')
  }
}

async function bake() {
  const id = currentId()
  const btn = document.getElementById('bake')
  btn.disabled = true
  setStatus('baking character...')
  try {
    const res = await fetch(`/__bake-character?id=${encodeURIComponent(id)}`, { method: 'POST' })
    const j = await res.json()
    if (!res.ok) throw new Error(j.error)
    const tris = j.results.map((r) => `LOD${r.lod}:${r.tris}`).join(' ')
    setStatus(`baked -> public/characters/${id}/ (${tris})`, 'ok')
  } catch (e) {
    setStatus(`bake failed: ${e.message}`, 'warn')
  } finally {
    updateBakeButton()
  }
}

for (const v of VIEWS) document.getElementById(`view${cap(v)}`).addEventListener('click', () => selectView(v))
document.getElementById('generate').addEventListener('click', generate)
document.getElementById('bake').addEventListener('click', bake)

selectView('front')
updateCost()
