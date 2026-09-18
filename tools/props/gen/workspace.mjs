// ---------------------------------------------------------------------------
// The on-disk workspace for one generated prop, and the one Tripo step that
// writes into it. vite.config.js's propGen() endpoints are thin wrappers over
// these. Third caller of tools/creatures/tripo.mjs after the creature and tree
// benches: THE VENDOR CLIENT, THE PRICE TABLE AND THE IMAGE GENERATOR ARE THE
// CREATURE PIPELINE'S, imported rather than copied. NO RIG, NO ANIMATION -- a
// prop's pipeline ends at the LOD ladder and the card cross, both of which are
// cut locally in the page.
//
// Layout, all under tools/props/gen/work/<id>/ (gitignored -- working sources,
// not shipped assets):
//
//   candidates/<n>.png       every generated candidate image
//   source.png               the picked candidate, the one Tripo reconstructs
//   meshes/<n>.glb|fbx       every generated mesh, kept forever
//   meshes/<n>-preview.png   Tripo's own render of that mesh
//   meshes/<n>-lod<k>.glb    LOD tiers and the card cross, cut locally from that mesh
//   mesh.glb|fbx             a copy of the picked mesh
//   state.json               task ids, costs, picks, edited meta -- the record of what was spent
//
// The spend rules are the creature workspace's, for the reasons its header
// gives: a task id is written to state.json BEFORE the wait, nothing paid for
// is ever overwritten (numbered candidates, exclusive `wx` slot claims), and
// `taskLog` keeps every task id the account was ever charged for.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODELS, createMeshTask, waitForTask, download, estimateCredits, uploadImage } from '../../creatures/tripo.mjs'
import { PROPS } from './prop-roster.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const WORK = path.join(ROOT, 'tools/props/gen/work')
const URL_BASE = '/tools/props/gen/work'

export function workDir(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid prop id "${id}" -- lowercase letters, digits and hyphens only`)
  return path.join(WORK, id)
}

export function readState(id) {
  const file = path.join(workDir(id), 'state.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { candidates: [], picked: null, meshes: [], pickedMesh: null, tasks: {}, creditsSpent: 0 }
}

export function writeState(id, state) {
  const dir = workDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2))
  return state
}

// --- candidate images (OpenRouter, already paid for by the caller) ----------

/**
 * Several image generations run at once, so the slot number is CLAIMED on disk
 * with an exclusive write rather than read off `state.candidates.length`: two
 * requests that pick the same number cannot both win it, and the loser retries
 * instead of overwriting an image that was paid for. Deleting a candidate
 * leaves a hole, which the next generation fills. The prompt, frame and model
 * are recorded with the image, because the description is editable and "which
 * words produced this picture" stops being answerable after about four.
 */
export function saveCandidate(id, buffer, cost, { prompt = null, aspectRatio = null, model = null } = {}) {
  const dest = path.join(workDir(id), 'candidates')
  fs.mkdirSync(dest, { recursive: true })
  let file = null
  for (let n = 0; n < 1000 && !file; n++) {
    try {
      fs.writeFileSync(path.join(dest, `${n}.png`), buffer, { flag: 'wx' })
      file = `${n}.png`
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
  if (!file) throw new Error(`no free candidate slot for "${id}" -- 1000 images is not a workflow`)
  const state = readState(id)
  state.candidates.push({ file, cost, prompt, aspectRatio, model })
  writeState(id, state)
  return file
}

/**
 * Drops one candidate image. source.png is a COPY, so a picked candidate's
 * deletion leaves the Tripo input intact, but the pick must stop naming a file
 * that is gone or the gallery and disk disagree.
 */
export function deleteCandidate(id, file) {
  const state = readState(id)
  if (!state.candidates.some((c) => c.file === file)) throw new Error(`no candidate "${file}" for "${id}"`)
  fs.rmSync(path.join(workDir(id), 'candidates', file), { force: true })
  state.candidates = state.candidates.filter((c) => c.file !== file)
  if (state.picked === file) state.picked = null
  writeState(id, state)
  return { file, picked: state.picked }
}

/** URLs into the dev server's static handler, not base64: a candidate is a megabyte or two of PNG. */
export function listCandidates(id) {
  const state = readState(id)
  return state.candidates.map((c) => ({
    file: c.file,
    cost: c.cost,
    picked: c.file === state.picked,
    url: `${URL_BASE}/${id}/candidates/${c.file}`,
  }))
}

/** Copies one candidate to source.png -- the single image Tripo reads. */
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

// --- the Tripo step ----------------------------------------------------------

/** Records a task id and its credit cost the moment the task exists, before any wait. */
function charge(id, step, taskId, credits) {
  const state = readState(id)
  state.tasks[step] = { taskId, credits, at: Date.now() }
  // Append-only: `tasks` is overwritten by the next run of the same step, and
  // this is the copy that makes a paid task id impossible to lose.
  state.taskLog = [...(state.taskLog ?? []), { step, taskId, credits, at: Date.now() }]
  state.creditsSpent = (state.creditsSpent ?? 0) + credits
  writeState(id, state)
}

/**
 * What Tripo actually sent, read off the bytes: `quad: true` makes it deliver
 * FBX because glTF has no quads, and a body written blind to a `.glb` name
 * surfaces much later in the loader as "Unexpected token 'K'".
 */
function containerOf(buf) {
  if (buf.subarray(0, 4).toString('ascii') === 'glTF') return 'glb'
  if (buf.subarray(0, 18).toString('ascii') === 'Kaydara FBX Binary') return 'fbx'
  throw new Error(`Tripo returned a model in an unrecognised container, first bytes ${JSON.stringify(buf.subarray(0, 12).toString('ascii'))}`)
}

/** `meshes/3.fbx` -> `3`. The candidate number, whatever container it arrived in. */
const stemOf = (file) => file.replace(/\.[^.]+$/, '')

/** The picked candidate copied to the top level, under its own extension. */
function workingMesh(dir) {
  return ['mesh.glb', 'mesh.fbx'].find((f) => fs.existsSync(path.join(dir, f))) ?? null
}

export function listMeshes(id) {
  const state = readState(id)
  const dir = workDir(id)
  return (state.meshes ?? []).map((m) => ({
    ...m,
    picked: m.file === state.pickedMesh,
    url: `${URL_BASE}/${id}/meshes/${m.file}`,
    previewUrl: fs.existsSync(path.join(dir, 'meshes', `${stemOf(m.file)}-preview.png`))
      ? `${URL_BASE}/${id}/meshes/${stemOf(m.file)}-preview.png`
      : null,
    lods: lodsOf(id, m.file),
  }))
}

/**
 * The tiers cut from one mesh candidate. Disk is the truth about which exist;
 * state.json carries what each one cost in triangles, so the bench lists a
 * ladder without loading every glb to count faces.
 */
function lodsOf(id, file) {
  const dir = path.join(workDir(id), 'meshes')
  if (!fs.existsSync(dir)) return []
  const stem = stemOf(file)
  const recorded = (readState(id).meshes ?? []).find((m) => m.file === file)?.lods ?? []
  return fs.readdirSync(dir)
    .filter((f) => new RegExp(`^${stem}-lod\\d+\\.glb$`).test(f))
    .map((f) => {
      const level = Number(f.match(/-lod(\d+)\.glb$/)[1])
      return { ...(recorded.find((r) => r.level === level) ?? {}), file: f, level, url: `${URL_BASE}/${id}/meshes/${f}` }
    })
    .sort((a, b) => a.level - b.level)
}

/** Makes one mesh candidate the working mesh: a copy at `mesh.<ext>`, in the candidate's own container. */
export function pickMesh(id, file) {
  const dir = workDir(id)
  const state = readState(id)
  const entry = (state.meshes ?? []).find((m) => m.file === file)
  if (!entry) throw new Error(`no mesh candidate "${file}" for "${id}"`)

  // Picking a glb after an fbx has to take the previous copy away rather than leave two.
  const previous = workingMesh(dir)
  if (previous) fs.rmSync(path.join(dir, previous))
  const working = `mesh${path.extname(file)}`
  fs.copyFileSync(path.join(dir, 'meshes', file), path.join(dir, working))
  const preview = path.join(dir, 'meshes', `${stemOf(file)}-preview.png`)
  if (fs.existsSync(preview)) fs.copyFileSync(preview, path.join(dir, 'mesh-preview.png'))

  state.pickedMesh = file
  writeState(id, state)
  return { file, path: path.relative(ROOT, path.join(dir, working)) }
}

/**
 * image-to-model. Writes a NEW numbered candidate every time and auto-picks
 * only when nothing is picked yet, so a deliberate pick is never silently
 * replaced by a later generation. PBR maps are off by default: a prop ships
 * matte and colour-only (§27), and P1 charges the same either way, so the
 * checkbox in the bench is the only thing that turns them on.
 */
export async function runMesh(id, opts = {}) {
  const dir = workDir(id)
  const source = path.join(dir, 'source.png')
  if (!fs.existsSync(source)) throw new Error(`no source.png for "${id}" -- pick a candidate image first`)

  const params = { model: MODELS.p1, faceLimit: 1500, quad: true, texture: true, pbr: false, ...opts }
  const credits = estimateCredits({ step: 'mesh', ...params })

  const fileToken = await uploadImage(fs.readFileSync(source), `${id}.png`)
  const taskId = await createMeshTask({ fileToken, ...params })
  charge(id, 'mesh', taskId, credits)

  const task = await waitForTask(taskId)
  const modelUrl = task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model
  if (!modelUrl) throw new Error(`Tripo mesh task ${taskId} succeeded with no model url: ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)

  const body = await download(modelUrl)
  const previewUrl = task.output?.rendered_image_url ?? task.output?.rendered_image
  const preview = previewUrl ? await download(previewUrl) : null

  const file = claimMeshSlot(id, containerOf(body), body, preview)
  return fileMesh(id, { file, taskId, credits, at: Date.now(), params })
}

/**
 * Writes `body` as the next free meshes/<n>.<ext>. No `await` inside, which is
 * what makes the claim indivisible with several mesh tasks in flight. Stems
 * are claimed across CONTAINERS, because `0.glb` and `0.fbx` are the same
 * candidate number to everything downstream.
 */
function claimMeshSlot(id, ext, body, preview) {
  const meshDir = path.join(workDir(id), 'meshes')
  fs.mkdirSync(meshDir, { recursive: true })
  const taken = new Set(fs.readdirSync(meshDir).map((f) => f.match(/^(\d+)\./)?.[1]).filter(Boolean))
  for (let n = 0; n < 1000; n++) {
    if (taken.has(String(n))) continue
    try {
      fs.writeFileSync(path.join(meshDir, `${n}.${ext}`), body, { flag: 'wx' })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      continue
    }
    if (preview) fs.writeFileSync(path.join(meshDir, `${n}-preview.png`), preview)
    return `${n}.${ext}`
  }
  throw new Error(`no free mesh slot for "${id}" -- 1000 meshes is not a workflow`)
}

/** Records a claimed mesh in state and auto-picks it only when nothing is picked yet. */
function fileMesh(id, entry) {
  const fresh = readState(id)
  fresh.meshes = [...(fresh.meshes ?? []), entry]
  writeState(id, fresh)
  const autoPicked = !fresh.pickedMesh
  if (autoPicked) pickMesh(id, entry.file)
  return {
    taskId: entry.taskId, credits: entry.credits, file: entry.file, autoPicked,
    path: path.relative(ROOT, path.join(workDir(id), 'meshes', entry.file)),
  }
}

/** What exists on disk right now, for the bench to render without guessing. */
export function assets(id) {
  const dir = workDir(id)
  const state = readState(id)
  // LODs belong to the mesh they were cut from, so switching pick shows that
  // mesh's tiers rather than a stale ladder. Paths are relative to the work dir.
  const lods = state.pickedMesh ? lodsOf(id, state.pickedMesh).map((l) => `meshes/${l.file}`) : []
  return { source: fs.existsSync(path.join(dir, 'source.png')), mesh: workingMesh(dir), lods, meshCount: (state.meshes ?? []).length, state }
}

// --- the asset index --------------------------------------------------------
//
// The roster is a seed list, not the truth: what a prop IS is whatever was last
// saved for it. `meta` in state.json holds the edits; the roster entry is the
// fallback underneath.

export function readMeta(id) {
  const seed = PROPS.find((p) => p.id === id)
  const { meta } = readState(id)
  // A work dir with neither is still a prop: it holds paid-for candidates that
  // outlived their roster entry (a renamed id), and they stay reachable with no
  // description until one is saved or they are deleted from the bench.
  if (!seed && !meta && !fs.existsSync(workDir(id))) throw new Error(`no prop "${id}" -- not in the roster and nothing saved for it`)
  return { id, ...(seed ?? {}), ...(meta ?? {}) }
}

export const META_KEYS = ['label', 'category', 'sizeM', 'texPx', 'description', 'style', 'styleNote', 'aspectRatio']

export function saveMeta(id, patch) {
  const meta = {}
  for (const k of META_KEYS) if (patch[k] !== undefined) meta[k] = patch[k]
  if (!meta.description) throw new Error('a prop needs a description -- it is the prompt')
  const state = readState(id)
  state.meta = { ...(state.meta ?? {}), ...meta }
  writeState(id, state)
  return readMeta(id)
}

/** Every prop the bench knows about: roster entries plus anything on disk. */
export function listAll() {
  const onDisk = fs.existsSync(WORK)
    ? fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  const ids = [...new Set([...PROPS.map((p) => p.id), ...onDisk])].filter((id) => /^[a-z0-9-]+$/.test(id))

  return ids.map((id) => {
    const state = readState(id)
    const a = assets(id)
    const meta = readMeta(id)
    const thumb = state.picked ?? state.candidates[0]?.file
    const imageCost = state.candidates.reduce((s, c) => s + (c.cost ?? 0), 0)
    return {
      ...meta,
      inRoster: PROPS.some((p) => p.id === id),
      edited: Boolean(state.meta),
      candidateCount: state.candidates.length,
      meshCount: a.meshCount,
      thumbUrl: thumb ? `${URL_BASE}/${id}/candidates/${thumb}` : null,
      has: { source: a.source, mesh: Boolean(a.mesh) },
      lodCount: a.lods.length,
      // Both wallets, kept apart: Tripo credits are not dollars until divided,
      // and the image spend never went through Tripo at all.
      usd: (state.creditsSpent ?? 0) / 100 + imageCost,
    }
  })
}

/**
 * Stores one locally-cut LOD tier or card cross. Costs nothing. A tier belongs
 * to the mesh candidate it was cut FROM, not to whichever candidate happens to
 * be picked when it lands. `stats` is whitelisted because it arrives from the
 * page and the ladder table renders it straight back.
 */
export function saveLod(id, level, buffer, { mesh = null, stats = null } = {}) {
  if (!Number.isInteger(level) || level < 1 || level > 9) throw new Error(`lod level must be 1-9, got ${level}`)
  const dir = workDir(id)
  const state = readState(id)
  const from = mesh ?? state.pickedMesh
  if (!from) throw new Error(`no picked mesh for "${id}" -- generate and pick a mesh first`)
  const entry = (state.meshes ?? []).find((m) => m.file === from)
  if (!entry) throw new Error(`no mesh candidate "${from}" for "${id}"`)

  const file = `${stemOf(from)}-lod${level}.glb`
  fs.writeFileSync(path.join(dir, 'meshes', file), buffer)

  const kept = { level }
  for (const k of ['tris', 'targetTris', 'uvMode', 'kind']) if (stats?.[k] !== undefined) kept[k] = stats[k]
  entry.lods = [...(entry.lods ?? []).filter((l) => l.level !== level), kept].sort((a, b) => a.level - b.level)
  writeState(id, state)

  return { file, path: path.relative(ROOT, path.join(dir, 'meshes', file)), bytes: buffer.length }
}
