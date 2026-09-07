// ---------------------------------------------------------------------------
// The on-disk workspace for one v9 tree, and the two Tripo steps that write
// into it. vite.config.js's treeGen() endpoints are thin wrappers over these.
//
// Layout, all under tools/trees/v9/work/<id>/ (gitignored -- working sources,
// not shipped assets):
//
//   candidates/<n>.png   every generated candidate image
//   source.png           the picked candidate, the one Tripo reconstructs
//   meshes/<n>.glb       every solid mesh bought, one per Tripo task
//   mesh.glb             a copy of the PICKED one -- what every later stage reads
//   mesh-lod<n>.glb      our decimator's tiers
//   painted.glb          the painted prop: position, normal, uvProj, texLayer
//   paint.json           the slot table and the per-face assignment behind it
//   state.json           task ids, costs, picks -- the record of what was spent
//
// THE VENDOR CLIENT IS THE CREATURE PIPELINE'S. tools/creatures/tripo.mjs knows
// nothing about creatures below its rig endpoints, and §27 names itself as the
// seam a second caller would attach at. This is that second caller. Nothing is
// copied and no price table is duplicated -- a Tripo price change lands in one
// file and both benches quote the new number.
//
// state.json is written the moment a task is created, BEFORE the wait, for the
// reason §27 gives: a task id is the only handle on work already paid for, and
// a dev-server restart mid-generation must lose the poll and not the purchase.
//
// NO RIG, NO ANIMATION. A tree does not move under its own power; wind is a
// vertex shader (src/material.js). Stages 4 and 5 of the creature pipeline have
// no analogue here and are not wired up, which is also why a v9 tree costs 50
// credits against a creature's 105.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODELS, createMeshTask, waitForTask, download, estimateCredits, uploadImage,
} from '../../creatures/tripo.mjs'
import { TREE_SPECIES, speciesById } from './tree-species.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const WORK = path.join(ROOT, 'tools/trees/v9/work')

// Where the paint bench looks for textures. Everything in this world ships as a
// 128px layer (src/textures.js TEX_SIZE), so anything else in these directories
// is listed with its real size and marked unusable rather than silently skipped
// -- a texture that is missing for a reason you cannot see is worse than one
// that is present and refuses.
const POOL_DIRS = ['trees', 'rocks', 'ferns', 'grass']
const TEX_SIZE = 128

/**
 * The id validator is a security boundary, not tidiness: it arrives from a query
 * string and is concatenated into a filesystem path, on a dev server that binds
 * to the LAN (`server.host`). `../` here is an arbitrary file write.
 */
export function workDir(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid tree id "${id}" -- lowercase letters, digits and hyphens only`)
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

// --- the texture pool -------------------------------------------------------

/** Width and height out of a PNG's IHDR, without decoding the image. */
function pngSize(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(24)
    fs.readSync(fd, head, 0, 24, 0)
    if (head.toString('ascii', 1, 4) !== 'PNG') return null
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Every PNG the paint step could wear, with the size it actually is.
 *
 * Returns URLs under /public's served root, which is what the page loads them
 * from. Whether a file also has an atlas LAYER is decided in the page, not here:
 * src/textures.js is the registry and importing it into node would drag three in
 * for a lookup the browser can do for free.
 */
export function texturePool() {
  const out = []
  for (const dir of POOL_DIRS) {
    const abs = path.join(ROOT, 'public', dir)
    if (!fs.existsSync(abs)) continue
    for (const name of fs.readdirSync(abs).sort()) {
      if (!name.endsWith('.png')) continue
      const size = pngSize(path.join(abs, name))
      if (!size) continue
      out.push({
        file: `${dir}/${name}`,
        name,
        url: `/${dir}/${name}`,
        width: size.width,
        height: size.height,
        usable: size.width === TEX_SIZE && size.height === TEX_SIZE,
      })
    }
  }
  return out
}

// --- candidate images -------------------------------------------------------

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
 * Throws away one candidate image and its record of what it cost. The bench
 * confirms first: this one image cannot be regenerated identically, since the
 * seed that made it is not kept.
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

/** URLs rather than base64, for the reason workspace.mjs gives: a gallery of
 *  five megabyte PNGs re-inlined on every refresh defeats the browser's cache
 *  for images that never change once written. */
export function listCandidates(id) {
  const state = readState(id)
  return state.candidates.map((c) => ({
    file: c.file,
    cost: c.cost,
    picked: c.file === state.picked,
    url: `/tools/trees/v9/work/${id}/candidates/${c.file}`,
  }))
}

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

// --- Tripo -----------------------------------------------------------------

function charge(id, step, taskId, credits) {
  const state = readState(id)
  state.tasks[step] = { taskId, credits, at: Date.now() }
  state.creditsSpent = (state.creditsSpent ?? 0) + credits
  writeState(id, state)
}

/**
 * image-to-model, at a face limit low enough to be a prop rather than a hero.
 *
 * `texture` DEFAULTS OFF here, and that is the one parameter that differs from
 * the creature pipeline's call. Every face gets repainted with a tiling world
 * texture in the next stage, so Tripo's baked atlas is generated, downloaded and
 * then discarded. On P1 the texture is bundled into the price and turning it off
 * saves 10 credits; it also means the mesh arrives with no unwrap worth pinning,
 * which is what lets the decimator run in 'drop' mode with no reduction ceiling.
 *
 * It is still switchable, because the vendor's own texture is the fastest way to
 * see whether the RECONSTRUCTION is right before deciding the paint job is wrong.
 */
export async function runMesh(id, opts = {}) {
  const dir = workDir(id)
  const source = path.join(dir, 'source.png')
  if (!fs.existsSync(source)) throw new Error(`no source.png for "${id}" -- pick a candidate image first`)

  const params = { model: MODELS.p1, faceLimit: 1000, texture: false, pbr: false, ...opts }
  const credits = estimateCredits({ step: 'mesh', ...params })

  const fileToken = await uploadImage(fs.readFileSync(source), `${id}.png`)
  const taskId = await createMeshTask({ fileToken, ...params })
  charge(id, 'mesh', taskId, credits)

  const task = await waitForTask(taskId)
  const modelUrl = task.output?.model_url ?? task.output?.pbr_model ?? task.output?.model
  if (!modelUrl) throw new Error(`Tripo mesh task ${taskId} succeeded with no model url: ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)

  adoptLegacyMesh(id)
  const body = await download(modelUrl)
  const previewUrl = task.output?.rendered_image_url ?? task.output?.rendered_image
  const preview = previewUrl ? await download(previewUrl) : null

  // Everything from here to writeState runs with no `await` in it, and that is
  // what makes the slot claim indivisible: several mesh tasks are in flight at
  // once, and a number read from state.meshes.length before an await is one two
  // of them can both win -- the second overwrites the first's file and one 40
  // credit mesh is left where two were paid for. `wx` is the second guard, for a
  // file another dev server put there.
  const meshDir = path.join(dir, 'meshes')
  fs.mkdirSync(meshDir, { recursive: true })
  let file = null
  for (let n = 0; n < 1000 && !file; n++) {
    try {
      fs.writeFileSync(path.join(meshDir, `${n}.glb`), body, { flag: 'wx' })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      continue
    }
    file = `${n}.glb`
    if (preview) fs.writeFileSync(path.join(meshDir, `${n}-preview.png`), preview)
  }
  if (!file) throw new Error(`no free mesh slot for "${id}" -- 1000 meshes is not a workflow`)

  const fresh = readState(id)
  fresh.meshes = [...(fresh.meshes ?? []), { file, taskId, credits, at: Date.now(), params }]
  writeState(id, fresh)

  // Auto-pick only when nothing is picked, so a mesh chosen deliberately is
  // never swapped out from under a paint job by a generation that lands later.
  const autoPicked = !fresh.pickedMesh
  if (autoPicked) pickMesh(id, file)

  return { taskId, credits, file, autoPicked, path: path.relative(ROOT, path.join(meshDir, file)) }
}

/**
 * A workspace written before meshes were numbered has a bought mesh.glb and no
 * meshes/ at all. Adopt it as candidate 0 rather than leaving 40 credits of mesh
 * invisible to the gallery.
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

/**
 * Makes one mesh candidate the working mesh by copying it to mesh.glb, which is
 * what every later stage reads -- the decimator, the paint step, the viewer.
 * They are unchanged by candidates existing.
 */
export function pickMesh(id, file) {
  const dir = workDir(id)
  const state = adoptLegacyMesh(id)
  if (!(state.meshes ?? []).some((m) => m.file === file)) throw new Error(`no mesh candidate "${file}" for "${id}"`)

  fs.copyFileSync(path.join(dir, 'meshes', file), path.join(dir, 'mesh.glb'))
  const preview = path.join(dir, 'meshes', `${file.replace(/\.glb$/, '')}-preview.png`)
  if (fs.existsSync(preview)) fs.copyFileSync(preview, path.join(dir, 'mesh-preview.png'))

  state.pickedMesh = file
  writeState(id, state)
  return { file, path: path.relative(ROOT, path.join(dir, 'mesh.glb')) }
}

export function listMeshes(id) {
  const dir = workDir(id)
  if (!fs.existsSync(dir)) return []
  const state = adoptLegacyMesh(id)
  return (state.meshes ?? []).map((m) => ({
    ...m,
    picked: m.file === state.pickedMesh,
    previewUrl: fs.existsSync(path.join(dir, 'meshes', `${m.file.replace(/\.glb$/, '')}-preview.png`))
      ? `/tools/trees/v9/work/${id}/meshes/${m.file.replace(/\.glb$/, '')}-preview.png`
      : null,
  }))
}

// --- local outputs ----------------------------------------------------------

/** One locally-decimated LOD tier. Costs nothing -- our code made it. */
export function saveLod(id, level, buffer) {
  if (!Number.isInteger(level) || level < 1 || level > 9) throw new Error(`lod level must be 1-9, got ${level}`)
  const dir = workDir(id)
  if (!fs.existsSync(path.join(dir, 'mesh.glb'))) throw new Error(`no mesh.glb for "${id}" -- nothing to decimate from`)
  const file = `mesh-lod${level}.glb`
  fs.writeFileSync(path.join(dir, file), buffer)
  return { file, path: path.relative(ROOT, path.join(dir, file)), bytes: buffer.length }
}

/**
 * The painted GLB. `paint.json` is saved beside it and is the more important
 * half: the GLB's `texLayer` is a bare number, and the sidecar is the only
 * record of WHICH texture file each slot meant and how its UVs were solved.
 *
 * Kept as a sidecar rather than a glTF extra because it has to be readable and
 * diffable without a glTF parser -- the paint job is the authored artefact here,
 * and the mesh can be rebuilt from the source image for 50 credits.
 */
export function savePainted(id, buffer, paint) {
  const dir = workDir(id)
  fs.mkdirSync(dir, { recursive: true })
  if (!paint || !Array.isArray(paint.slots)) throw new Error('savePainted needs a paint record with a slots table')
  fs.writeFileSync(path.join(dir, 'painted.glb'), buffer)
  fs.writeFileSync(path.join(dir, 'paint.json'), JSON.stringify(paint, null, 2))
  const state = readState(id)
  state.paintedAt = Date.now()
  writeState(id, state)
  return { path: path.relative(ROOT, path.join(dir, 'painted.glb')), bytes: buffer.length, slots: paint.slots.length }
}

export function readPaint(id) {
  const file = path.join(workDir(id), 'paint.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

/** What exists on disk right now, so the bench renders stage state without guessing. */
export function assets(id) {
  const dir = workDir(id)
  const has = (f) => fs.existsSync(path.join(dir, f))
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  return {
    source: has('source.png'),
    mesh: has('mesh.glb'),
    meshes: listMeshes(id),
    painted: has('painted.glb'),
    lods: files.filter((f) => /^mesh-lod\d+\.glb$/.test(f)).sort(),
    state: readState(id),
  }
}

// --- the index --------------------------------------------------------------
//
// As in §27: the species list is a SEED, and what a tree is -- its prompt, its
// height -- is whatever was last saved for it. That is what lets a species be
// invented in the page and survive a reload without editing tree-species.mjs.

export function readMeta(id) {
  const seed = speciesById(id)
  const { meta } = readState(id)
  if (!seed && !meta) throw new Error(`no tree "${id}" -- not in the species list and nothing saved for it`)
  return { id, ...(seed ?? {}), ...(meta ?? {}) }
}

export function saveMeta(id, patch) {
  const allowed = ['label', 'heightM', 'description', 'crown', 'trunk', 'styleNote', 'bark', 'foliage']
  const meta = {}
  for (const k of allowed) if (patch[k] !== undefined) meta[k] = patch[k]
  if (!meta.description) throw new Error('a tree needs a description -- it is the prompt')
  if (!meta.crown) throw new Error('a tree needs a crown clause -- it is what makes one species not another')
  if (!meta.trunk) throw new Error('a tree needs a trunk clause -- without one a pine grows a bare pole halfway up itself')
  const state = readState(id)
  state.meta = { ...(state.meta ?? {}), ...meta }
  writeState(id, state)
  return readMeta(id)
}

/** Every tree the bench knows about: seeded species plus anything on disk. */
export function listAll() {
  const onDisk = fs.existsSync(WORK)
    ? fs.readdirSync(WORK, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []
  const ids = [...new Set([...TREE_SPECIES.map((s) => s.id), ...onDisk])].filter((id) => /^[a-z0-9-]+$/.test(id))

  return ids.map((id) => {
    const state = readState(id)
    const a = assets(id)
    const meta = readMeta(id)
    const thumb = state.picked ?? state.candidates[0]?.file
    const imageCost = state.candidates.reduce((s, c) => s + (c.cost ?? 0), 0)
    return {
      ...meta,
      seeded: TREE_SPECIES.some((s) => s.id === id),
      edited: Boolean(state.meta),
      candidateCount: state.candidates.length,
      thumbUrl: thumb ? `/tools/trees/v9/work/${id}/candidates/${thumb}` : null,
      has: { source: a.source, mesh: a.mesh, painted: a.painted },
      lodCount: a.lods.length,
      // Two wallets kept apart: Tripo credits are not dollars until divided, and
      // the image spend never went through Tripo at all.
      usd: (state.creditsSpent ?? 0) / 100 + imageCost,
    }
  })
}
