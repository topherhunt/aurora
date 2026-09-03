// ---------------------------------------------------------------------------
// Thin client for Tripo's v3 OpenAPI -- mesh generation, rigging and animation
// retargeting. gen-creature.html's dev-server endpoints (vite.config.js) are
// the only callers, so every network call here starts as an explicit button
// click in that bench. Never call a spending function in a loop or on a timer,
// per the project's spend-gate rule; `estimateCredits` exists so the bench can
// show the price BEFORE the click.
//
// Design doc: design/27-creature-pipeline.md.
//
// Two things are deliberately loud rather than convenient:
//
//   Every response goes through `unwrap`, which throws on Tripo's `code != 0`
//   envelope carrying the server's own message. A failed task that still
//   returns HTTP 200 (Tripo's normal shape) must not read as success.
//
//   `waitForTask` has a hard timeout and no retry. A stuck task is a thing to
//   look at, not to silently re-submit -- a retry loop here spends real money
//   per iteration.
// ---------------------------------------------------------------------------

const BASE = 'https://openapi.tripo3d.ai/v3'

// Terminal task states. Anything else (queued, running, ...) is still in
// flight; treating an unknown state as terminal would strand a live task.
const DONE = 'success'
const DEAD = new Set(['failed', 'cancelled', 'banned', 'expired', 'unknown'])

function apiKey() {
  const key = process.env.TRIPO_API_KEY
  if (!key) throw new Error('TRIPO_API_KEY is not set -- add it to .env (gitignored) before generating')
  return key
}

// Tripo answers `{ code, data, message }` with HTTP 200 even for application
// errors, so status alone never decides. Non-JSON gets quoted raw: an HTML
// error page from a wrong path is the single most likely first-run failure and
// "unexpected token <" would hide it.
async function unwrap(res, what) {
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Tripo ${what} returned non-JSON (status ${res.status}): ${text.slice(0, 300)}`)
  }
  if (!res.ok || (json.code !== undefined && json.code !== 0)) {
    throw new Error(`Tripo ${what} failed (status ${res.status}, code ${json.code}): ${json.message || text.slice(0, 300)}`)
  }
  return json.data ?? json
}

async function post(path, body, what) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return unwrap(res, what)
}

/**
 * Uploads one PNG and returns its `file_token`. Tripo's image inputs take a
 * token, a public URL or an STS object -- a token is the only one of the three
 * that works for a file that exists solely on this laptop.
 *
 * The path is `/v3/files`, not `/v3/upload`. v2's was `/v2/openapi/upload` and
 * returned `image_token`; v3 renamed both the route and the field. Verified
 * against the live API -- upload is free, so the probe cost nothing.
 */
export async function uploadImage(buffer, filename = 'candidate.png') {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename)
  const res = await fetch(`${BASE}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}` }, // no Content-Type: fetch sets the multipart boundary
    body: form,
  })
  const data = await unwrap(res, 'upload')
  if (!data.file_token) throw new Error(`Tripo upload returned no file_token: ${JSON.stringify(data).slice(0, 300)}`)
  return data.file_token
}

/**
 * Remaining credits. Free, and the only way to tell "the pipeline is broken"
 * apart from "the wallet is empty" before a spend button is pressed.
 */
export async function getBalance() {
  const res = await fetch(`${BASE}/account/balance`, { headers: { Authorization: `Bearer ${apiKey()}` } })
  const data = await unwrap(res, 'balance')
  return { balance: data.balance, frozen: data.frozen }
}

export const MODELS = {
  // Native low-poly. Trained on polygonal mesh data rather than decimated from
  // a dense surface, so its UV islands survive the 128px downrez that a
  // decimated mesh's island scatter does not. The default here for that reason.
  p1: 'P1-20260311',
  h3: 'v3.1-20260211',
}

// P1 rejects the `quad` field outright (code 1004) -- it already emits quad
// topology, so there is nothing to ask for. Every other model accepts the flag
// and charges for it. The server's own error text claims quad is P2-only; that
// is wrong, v3.1 and v2.5 both take it. Verified by probe.
const REJECTS_QUAD = new Set([MODELS.p1])

/**
 * Image -> mesh. `faceLimit` is a target, not a contract: Tripo's own docs say
 * the count deviates with geometry complexity, so the caller checks the mesh it
 * actually gets against the budget rather than trusting this number.
 *
 * `pbr` defaults OFF. This world does its own lighting (src/lighting.js); baked
 * metallic/roughness maps fight it and cost texture budget for maps nothing
 * reads. `texture: true` with `pbr: false` gives base colour only.
 */
export async function createMeshTask({
  fileToken,
  model = MODELS.p1,
  faceLimit = 4000,
  quad = true,
  texture = true,
  pbr = false,
  textureQuality = 'standard',
  smartLowPoly = false,
  textureAlignment = 'original_image',
  autoSize = false,
  orientation = 'align_image',
  seed,
}) {
  if (!fileToken) throw new Error('createMeshTask requires a fileToken')
  const body = {
    // The image goes in a nested `file` object. A top-level `file_token` is not
    // an error -- it is ignored, and the request dies as "file is required",
    // which reads like the upload failed rather than like a wrong field name.
    file: { type: 'png', file_token: fileToken },
    model,
    face_limit: faceLimit,
    texture,
    pbr,
    texture_quality: textureQuality,
    texture_alignment: textureAlignment,
    auto_size: autoSize,
    orientation,
  }
  if (quad && !REJECTS_QUAD.has(model)) body.quad = true
  // smart_low_poly is an H3-only surcharge; P1 is natively low-poly and
  // rejects the combination.
  if (smartLowPoly && model !== MODELS.p1) body.smart_low_poly = true
  if (seed !== undefined) body.model_seed = seed
  const data = await post('/generation/image-to-model', body, 'image-to-model')
  return data.task_id
}

/**
 * Free. Returns `{ riggable, rig_type }` -- Tripo's own read on whether this
 * mesh can be rigged and which skeleton fits it. The bench calls this before
 * offering the (25-credit) rig button, so a butterfly that will never rig
 * costs nothing to rule out.
 */
export async function createRigCheckTask(modelTaskId) {
  const data = await post('/animations/rig-check', { input: modelTaskId }, 'rig-check')
  return data.task_id
}

export const RIG_TYPES = ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic']

/**
 * `spec: 'mixamo'` gives Mixamo-compatible bone names. That is what lets
 * tools/characters/animations.mjs's procedural clips -- written against a fixed
 * bone hierarchy -- drive a Tripo skeleton without a name-mapping table.
 */
export async function createRigTask({ modelTaskId, rigType = 'biped', spec = 'mixamo', outFormat = 'glb' }) {
  if (!RIG_TYPES.includes(rigType)) throw new Error(`unknown rigType "${rigType}" -- expected one of ${RIG_TYPES.join(', ')}`)
  const data = await post(
    '/animations/rig',
    { input: modelTaskId, rig_type: rigType, spec, out_format: outFormat, model: 'v2.5-20260210' },
    'rig',
  )
  return data.task_id
}

// Preset coverage is lopsided: bipeds get a real library, every other rig type
// gets one gait. Everything past that gait is authored locally against the
// mixamo-named skeleton (tools/characters/animations.mjs), which is why the rig
// step matters more than this one.
export const PRESETS = {
  biped: ['preset:idle', 'preset:walk', 'preset:run', 'preset:jump', 'preset:turn', 'preset:hurt', 'preset:fall', 'preset:climb', 'preset:dive', 'preset:slash', 'preset:shoot'],
  quadruped: ['preset:quadruped:walk'],
  hexapod: ['preset:hexapod:walk'],
  octopod: ['preset:octopod:walk'],
  serpentine: ['preset:serpentine:march'],
  aquatic: ['preset:aquatic:march'],
  avian: [],
}

/**
 * `animateInPlace` defaults true: root motion belongs to the game's locomotion
 * code, not baked into the clip, or the creature walks away from its own
 * transform.
 */
export async function createRetargetTask({ rigTaskId, animations, outFormat = 'glb', animateInPlace = true }) {
  const list = Array.isArray(animations) ? animations : [animations]
  if (!list.length) throw new Error('createRetargetTask requires at least one animation preset')
  const data = await post(
    '/animations/retarget',
    { input: rigTaskId, animations: list, out_format: outFormat, bake_animation: true, animate_in_place: animateInPlace },
    'retarget',
  )
  return data.task_id
}

export async function getTask(taskId) {
  const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  })
  return unwrap(res, `task ${taskId}`)
}

/**
 * Polls until terminal. No retry on failure and no resubmit -- see the header.
 * `onProgress` is called with the raw task each poll so a caller can stream
 * progress without a second request.
 */
export async function waitForTask(taskId, { intervalMs = 3000, timeoutMs = 10 * 60 * 1000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const task = await getTask(taskId)
    onProgress?.(task)
    if (task.status === DONE) return task
    if (DEAD.has(task.status)) {
      throw new Error(`Tripo task ${taskId} ended as "${task.status}": ${JSON.stringify(task.output ?? {}).slice(0, 300)}`)
    }
    if (Date.now() > deadline) {
      throw new Error(`Tripo task ${taskId} still "${task.status}" after ${Math.round(timeoutMs / 1000)}s -- check the dashboard rather than resubmitting`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Task outputs are CDN URLs that expire. Anything worth keeping gets pulled to
 * disk in the same request that observed SUCCEEDED -- never stored as a URL.
 */
export async function download(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed (status ${res.status}) for ${url.slice(0, 120)}`)
  return Buffer.from(await res.arrayBuffer())
}

// Credits from Tripo's published table, at $0.01/credit. Pure arithmetic, no
// network: the bench prices a click before the click happens. Kept beside the
// request builders so a param that changes cost cannot be added without the
// estimate landing in the same diff.
export function estimateCredits({ step, model = MODELS.p1, texture = true, textureQuality = 'standard', smartLowPoly = false, quad = true, animationCount = 1 }) {
  if (step === 'rig-check') return 0
  if (step === 'rig') return 25
  if (step === 'retarget') return 10 * animationCount
  if (step === 'convert') return 5
  if (step !== 'mesh') throw new Error(`unknown step "${step}"`)

  if (model === MODELS.p1) return texture ? 50 : 40 // P1 is all-inclusive; surcharges do not apply
  let credits = texture ? 30 : 20
  if (textureQuality === 'detailed') credits += 10
  if (smartLowPoly) credits += 10
  if (quad) credits += 5
  return credits
}

export const creditsToUsd = (credits) => credits / 100
