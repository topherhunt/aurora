// ---------------------------------------------------------------------------
// The on-disk workspace for one creature, and the four Tripo steps that write
// into it. vite.config.js's creatureGen() endpoints are thin wrappers over
// these; keeping the orchestration here means a batch script can drive the same
// pipeline later without going through the browser.
//
// Layout, all under tools/creatures/work/<id>/ (gitignored -- working sources,
// not shipped assets; the bake step is what writes public/):
//
//   candidates/<n>.png       every generated candidate image
//   source.png               the picked candidate, the one Tripo reconstructs
//   meshes/<n>.glb           every generated mesh, kept forever
//   meshes/<n>-preview.png   Tripo's own render of that mesh
//   meshes/<n>-lod<k>.glb    LOD tiers, decimated locally from that mesh
//   mesh.glb                 a copy of the picked mesh -- what rigging reads
//   rig.glb                  skeleton bound to the mesh
//   anim-<preset>.glb        one file per retargeted clip
//   state.json               task ids, costs, picks -- the record of what was spent
//
// state.json is the reason this module exists rather than living in the plugin:
// a Tripo task id is the only handle on work already paid for, so it is written
// the moment a task is created, BEFORE the wait, and survives a dev-server
// restart mid-generation. Losing it means paying twice.
//
// NOTHING PAID FOR IS EVER OVERWRITTEN. Generated output is appended under a new
// number and `taskLog` keeps every task id the account was ever charged for,
// including ones no longer referenced by a pick. `state.tasks[step]` holds only
// the *current* handle, so it is not a record and must never be the only copy --
// an earlier version of this module wrote every mesh to a fixed `mesh.glb` and
// silently destroyed the previous one, which costs 50 credits to undo and there
// is no task-history endpoint to recover from.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODELS, PRESETS, createMeshTask, createRigCheckTask, createRigTask, createRetargetTask,
  waitForTask, download, estimateCredits, uploadImage,
} from './tripo.mjs'
import { CREATURES } from './creature-roster.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(ROOT, 'tools/creatures/work')

export function workDir(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid creature id "${id}" -- lowercase letters, digits and hyphens only`)
  return path.join(WORK, id)
}

export function readState(id) {
  const file = path.join(workDir(id), 'state.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { candidates: [], picked: null, tasks: {}, creditsSpent: 0 }
}

export function writeState(id, state) {
  const dir = workDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
  return state
}

// --- candidate images (OpenRouter, already paid for by the caller) ----------

export function saveCandidate(id, buffer, cost) {
  const dir = workDir(id)
  fs.mkdirSync(path.join(dir, 'candidates'), { recursive: true })
  const state = readState(id)
  const file = `${state.candidates.length}.png`
  fs.writeFileSync(path.join(dir, 'candidates', file), buffer)
  state.candidates.push({ file, cost })
  writeState(id, state)
  return file
}

/**
 * Candidates come back as URLs into the dev server's static handler, not as
 * base64. A generated candidate is a megabyte or two of PNG and the gallery
 * reloads on every stage change; inlining five of them would push ten megabytes
 * of JSON per refresh and defeat the browser's cache for images that never
 * change once written.
 */
export function listCandidates(id) {
  const state = readState(id)
  return state.candidates.map((c) => ({
    file: c.file,
    cost: c.cost,
    picked: c.file === state.picked,
    url: `/tools/creatures/work/${id}/candidates/${c.file}`,
  }))
}

/** Copies one candidate to source.png -- the single image every Tripo step reads. */
export function pickCandidate(id, file) {
  const dir = workDir(id)
  const src = path.join(dir, 'candidates', file)
  if (!fs.existsSync(src)) throw new Error(`no candidate "${file}" for "${id}"`)
  fs.copyFileSync(src, path.join(dir, 'source.png'))
  const state = readState(id)
  state.picked = file
  writeState(id, state)
  return path.relative(ROOT, path.join(dir, 'source.png'))
}

// --- Tripo steps ------------------------------------------------------------
//
// Each records its task id and credit cost into state.json as it goes. `spend`
// is charged from tripo.mjs's estimate rather than the response, so the running
// total is right even for a task still in flight.

function charge(id, step, taskId, credits) {
  const state = readState(id)
  state.tasks[step] = { taskId, credits, at: Date.now() }
  // Append-only. `tasks` is overwritten by the next run of the same step; this
  // is the copy that makes a paid task id impossible to lose.
  state.taskLog = [...(state.taskLog ?? []), { step, taskId, credits, at: Date.now() }]
  state.creditsSpent = (state.creditsSpent ?? 0) + credits
  writeState(id, state)
}

// --- mesh candidates --------------------------------------------------------

/**
 * A mesh generated before meshes were kept as candidates lives at the top level
 * with no entry in `state.meshes`. Adopt it as candidate 0 rather than leaving
 * 50 credits of work invisible to the bench.
 */
function adoptLegacyMesh(id) {
  const dir = workDir(id)
  const state = readState(id)
  const legacy = path.join(dir, 'mesh.glb')
  if (state.meshes?.length || !fs.existsSync(legacy)) return state

  fs.mkdirSync(path.join(dir, 'meshes'), { recursive: true })
  fs.copyFileSync(legacy, path.join(dir, 'meshes', '0.glb'))
  const preview = path.join(dir, 'mesh-preview.png')
  if (fs.existsSync(preview)) fs.copyFileSync(preview, path.join(dir, 'meshes', '0-preview.png'))

  state.meshes = [{
    file: '0.glb',
    taskId: state.tasks?.mesh?.taskId ?? null,
    credits: state.tasks?.mesh?.credits ?? 0,
    at: state.tasks?.mesh?.at ?? null,
    params: null,
  }]
  state.pickedMesh = '0.glb'
  return writeState(id, state)
}

export function listMeshes(id) {
  const state = adoptLegacyMesh(id)
  const dir = workDir(id)
  return (state.meshes ?? []).map((m) => ({
    ...m,
    picked: m.file === state.pickedMesh,
    url: `/tools/creatures/work/${id}/meshes/${m.file}`,
    previewUrl: fs.existsSync(path.join(dir, 'meshes', m.file.replace('.glb', '-preview.png')))
      ? `/tools/creatures/work/${id}/meshes/${m.file.replace('.glb', '-preview.png')}`
      : null,
    lods: lodsOf(id, m.file),
  }))
}

function lodsOf(id, file) {
  const dir = path.join(workDir(id), 'meshes')
  if (!fs.existsSync(dir)) return []
  const stem = file.replace(/\.glb$/, '')
  return fs.readdirSync(dir)
    .filter((f) => new RegExp(`^${stem}-lod\\d+\\.glb$`).test(f))
    .sort()
    .map((f) => ({ file: f, level: Number(f.match(/-lod(\d+)\.glb$/)[1]), url: `/tools/creatures/work/${id}/meshes/${f}` }))
}

/**
 * Makes one mesh candidate the working mesh. Copies it to `mesh.glb`, which is
 * what the rig step and the bench's viewer read, and repoints `tasks.mesh` --
 * rigging is driven by the task id, so a pick that did not move it would rig a
 * different mesh than the one on screen.
 */
export function pickMesh(id, file) {
  const dir = workDir(id)
  const state = adoptLegacyMesh(id)
  const entry = (state.meshes ?? []).find((m) => m.file === file)
  if (!entry) throw new Error(`no mesh candidate "${file}" for "${id}"`)

  fs.copyFileSync(path.join(dir, 'meshes', file), path.join(dir, 'mesh.glb'))
  const preview = path.join(dir, 'meshes', file.replace('.glb', '-preview.png'))
  if (fs.existsSync(preview)) fs.copyFileSync(preview, path.join(dir, 'mesh-preview.png'))

  state.pickedMesh = file
  if (entry.taskId) state.tasks.mesh = { taskId: entry.taskId, credits: entry.credits, at: entry.at }
  writeState(id, state)
  return { file, path: path.relative(ROOT, path.join(dir, 'mesh.glb')) }
}

/**
 * image-to-model. Writes a NEW numbered candidate every time -- see the header.
 * Auto-picks only when nothing is picked yet, so a deliberate pick is never
 * silently replaced by a later generation.
 */
export async function runMesh(id, opts = {}) {
  const dir = workDir(id)
  const source = path.join(dir, 'source.png')
  if (!fs.existsSync(source)) throw new Error(`no source.png for "${id}" -- pick a candidate image first`)

  const params = { model: MODELS.p1, faceLimit: 4000, quad: true, texture: true, pbr: false, ...opts }
  const credits = estimateCredits({ step: 'mesh', ...params })

  const fileToken = await uploadImage(fs.readFileSync(source), `${id}.png`)
  const taskId = await createMeshTask({ fileToken, ...params })
  charge(id, 'mesh', taskId, credits)

  const task = await waitForTask(taskId)
  const modelUrl = task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model
  if (!modelUrl) throw new Error(`Tripo mesh task ${taskId} succeeded with no model url: ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)

  // The number is claimed from the state file, not from a directory listing, so
  // it cannot collide with a candidate whose file was moved away by hand.
  const state = adoptLegacyMesh(id)
  const file = `${(state.meshes ?? []).length}.glb`
  fs.mkdirSync(path.join(dir, 'meshes'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'meshes', file), await download(modelUrl))

  const previewUrl = task.output?.rendered_image_url ?? task.output?.rendered_image
  if (previewUrl) fs.writeFileSync(path.join(dir, 'meshes', file.replace('.glb', '-preview.png')), await download(previewUrl))

  const fresh = readState(id)
  fresh.meshes = [...(fresh.meshes ?? []), { file, taskId, credits, at: Date.now(), params }]
  writeState(id, fresh)

  const autoPicked = !fresh.pickedMesh
  if (autoPicked) pickMesh(id, file)

  return { taskId, credits, file, autoPicked, path: path.relative(ROOT, path.join(dir, 'meshes', file)) }
}

/** Free. Tripo's own read on whether the mesh can be rigged, and as what. */
export async function runRigCheck(id) {
  const state = readState(id)
  const meshTask = state.tasks.mesh?.taskId
  if (!meshTask) throw new Error(`no mesh task for "${id}" -- generate the mesh first`)
  const taskId = await createRigCheckTask(meshTask)
  charge(id, 'rigCheck', taskId, 0)
  const task = await waitForTask(taskId)
  return { taskId, riggable: task.output?.riggable ?? false, rigType: task.output?.rig_type ?? null }
}

export async function runRig(id, { rigType, spec = 'mixamo' }) {
  const dir = workDir(id)
  const state = readState(id)
  const meshTask = state.tasks.mesh?.taskId
  if (!meshTask) throw new Error(`no mesh task for "${id}" -- generate the mesh first`)

  const credits = estimateCredits({ step: 'rig' })
  const taskId = await createRigTask({ modelTaskId: meshTask, rigType, spec })
  charge(id, 'rig', taskId, credits)

  const task = await waitForTask(taskId)
  const url = task.output?.model_url ?? task.output?.rigged_model
  if (!url) throw new Error(`Tripo rig task ${taskId} succeeded with no model url: ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)
  fs.writeFileSync(path.join(dir, 'rig.glb'), await download(url))

  const s = readState(id)
  s.rigType = rigType
  writeState(id, s)
  return { taskId, credits, rigType, path: path.relative(ROOT, path.join(dir, 'rig.glb')) }
}

/**
 * One retarget task carrying every requested preset. Batching matters: the
 * charge is 10 credits per animation either way, but a single task is one
 * queue slot instead of N against the account's concurrent-task cap.
 */
export async function runAnimate(id, { animations }) {
  const dir = workDir(id)
  const state = readState(id)
  const rigTask = state.tasks.rig?.taskId
  if (!rigTask) throw new Error(`no rig task for "${id}" -- rig the mesh first`)

  const list = Array.isArray(animations) ? animations : [animations]
  const known = PRESETS[state.rigType] ?? []
  for (const a of list) {
    if (!known.includes(a)) throw new Error(`"${a}" is not a preset for rig type "${state.rigType}" -- have: ${known.join(', ') || '(none)'}`)
  }

  const credits = estimateCredits({ step: 'retarget', animationCount: list.length })
  const taskId = await createRetargetTask({ rigTaskId: rigTask, animations: list })
  charge(id, 'animate', taskId, credits)

  const task = await waitForTask(taskId)
  // A multi-animation retarget answers with a list; a single one may answer
  // with a bare url. Both shapes are normalised here so the caller sees files.
  const outputs = task.output?.animations ?? (task.output?.model_url ? [{ animation: list[0], model_url: task.output.model_url }] : [])
  if (!outputs.length) throw new Error(`Tripo retarget task ${taskId} succeeded with no animation urls: ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)

  const written = []
  for (const out of outputs) {
    const name = String(out.animation ?? out.name ?? list[written.length]).replace(/[^a-z0-9]+/gi, '-').toLowerCase()
    const file = `anim-${name}.glb`
    fs.writeFileSync(path.join(dir, file), await download(out.model_url ?? out.url))
    written.push(file)
  }
  return { taskId, credits, files: written }
}

/** What exists on disk right now, for the bench to render without guessing. */
export function assets(id) {
  const dir = workDir(id)
  const has = (f) => fs.existsSync(path.join(dir, f))
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  const anims = files.filter((f) => f.startsWith('anim-') && f.endsWith('.glb'))
  const state = readState(id)
  // LODs belong to the mesh they were decimated from, so switching pick shows
  // that mesh's tiers rather than a stale ladder from a different one. Paths are
  // relative to the work dir, which is what the bench's viewer appends to.
  const lods = state.pickedMesh ? lodsOf(id, state.pickedMesh).map((l) => `meshes/${l.file}`) : []
  return { source: has('source.png'), mesh: has('mesh.glb'), rig: has('rig.glb'), anims, lods, meshCount: (state.meshes ?? []).length, state }
}

// --- the asset index --------------------------------------------------------
//
// The roster is a seed list, not the truth. What a creature IS -- its prompt,
// its rig type, its size -- is whatever was last saved for it, because the whole
// point of the bench is editing those and regenerating. `meta` in state.json
// holds the edits; the roster entry is the fallback underneath.

export function readMeta(id) {
  const seed = CREATURES.find((c) => c.id === id)
  const { meta } = readState(id)
  if (!seed && !meta) throw new Error(`no creature "${id}" -- not in the roster and nothing saved for it`)
  return { id, ...(seed ?? {}), ...(meta ?? {}) }
}

export function saveMeta(id, patch) {
  const allowed = ['label', 'rigType', 'sizeM', 'description', 'styleNote']
  const meta = {}
  for (const k of allowed) if (patch[k] !== undefined) meta[k] = patch[k]
  if (!meta.description) throw new Error('a creature needs a description -- it is the prompt')
  const state = readState(id)
  state.meta = { ...(state.meta ?? {}), ...meta }
  writeState(id, state)
  return readMeta(id)
}

/** Every creature the bench knows about: roster entries plus anything on disk. */
export function listAll() {
  const onDisk = fs.existsSync(WORK)
    ? fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  const ids = [...new Set([...CREATURES.map((c) => c.id), ...onDisk])].filter((id) => /^[a-z0-9-]+$/.test(id))

  return ids.map((id) => {
    const state = readState(id)
    const a = assets(id)
    const meta = readMeta(id)
    const thumb = state.picked ?? state.candidates[0]?.file
    const imageCost = state.candidates.reduce((s, c) => s + (c.cost ?? 0), 0)
    return {
      ...meta,
      inRoster: CREATURES.some((c) => c.id === id),
      edited: Boolean(state.meta),
      candidateCount: state.candidates.length,
      meshCount: a.meshCount,
      thumbUrl: thumb ? `/tools/creatures/work/${id}/candidates/${thumb}` : null,
      has: { source: a.source, mesh: a.mesh, rig: a.rig },
      animCount: a.anims.length,
      lodCount: a.lods.length,
      // Both wallets, kept apart: Tripo credits are not dollars until divided,
      // and the image spend never went through Tripo at all.
      usd: (state.creditsSpent ?? 0) / 100 + imageCost,
    }
  })
}

/** Stores one locally-decimated LOD tier. Costs nothing -- our code made it. */
export function saveLod(id, level, buffer) {
  if (!Number.isInteger(level) || level < 1 || level > 9) throw new Error(`lod level must be 1-9, got ${level}`)
  const dir = workDir(id)
  const state = adoptLegacyMesh(id)
  if (!state.pickedMesh) throw new Error(`no picked mesh for "${id}" -- generate and pick a mesh first`)
  const file = `${state.pickedMesh.replace(/\.glb$/, '')}-lod${level}.glb`
  fs.writeFileSync(path.join(dir, 'meshes', file), buffer)
  return { file, path: path.relative(ROOT, path.join(dir, 'meshes', file)), bytes: buffer.length }
}
