// Node-side gates for the Tripo creature pipeline (tools/creatures/).
//
//   node scripts/check-creatures.mjs
//
// SPENDS NOTHING AND MAKES NO NETWORK CALL. Almost everything it touches is
// pure -- the prompt builder, the credit table, the roster, the one path
// computation -- and the one request builder that is not runs against a stubbed
// `fetch`. That is the whole point: this pipeline's failure modes are expensive
// in a way a shader bug is not, so the parts that can be checked for free are
// checked on every `npm run check`.
//
//   THE PRICE LIST DRIFTS FROM THE REQUEST BUILDER. `estimateCredits` is what
//   gen-creature.html prints on a button before anyone clicks it, and it is a
//   hand transcription of Tripo's published table sitting next to the code that
//   builds the request. If a param that costs money gets added to
//   `createMeshTask` and not to the estimate, the bench quotes one price and
//   the account is charged another. Only pinning the table catches that.
//
//   A CREATURE ID REACHES THE FILESYSTEM. `id` arrives from a query string and
//   is concatenated into a working path. `../` in that string is an arbitrary
//   file write on a dev server that binds to the LAN by default (server.host is
//   true), so the id validator is a security boundary, not a tidiness check.
//
//   THE PROMPT STARTS LOOKING LIKE A CHARACTER SHEET. The character pipeline's
//   prompts key on flat magenta and are MEASURED; these are handed whole to a
//   reconstruction model that paints a texture from them. A magenta background
//   here does not fail -- it bleeds a magenta rim into the creature's fur, in
//   the shipped asset, which is only visible once it is in the world.
//
//   A ROSTER ENTRY NAMES A RIG TYPE THAT HAS NO SKELETON. The roster's rigType
//   picks both a prompt pose clause and the skeleton Tripo is asked for. A typo
//   is not caught until the (25-credit) rig call rejects it.
//
//   A PRESET IS OFFERED THAT DOES NOT EXIST. Non-biped animation coverage is
//   one gait per rig type, and the bench renders its checkboxes straight off
//   PRESETS. A stale entry there is a paid retarget that fails.
//
//   A TRIPO MESH IS DRAWN DOUBLE-SIDED. Tripo's material says doubleSided and
//   its fins are closed slabs a tenth of a millimetre thick, so a loader that
//   forgets to cull shows z-fighting the shipped game never would, or ships
//   it. Every src file that loads from a Tripo work directory or from
//   public/creatures has to import src/tripo-culling.js.
//
//   A CREATURE SHIPS OVER THE TEXTURE CAP. Nothing generated enters the world
//   with a colour map wider than TEX_PX_MAX, and a designated-small creature
//   ships at TEX_PX_SMALL (design/27-creature-pipeline.md). The shippers
//   enforce it, but a GLB copied into public/creatures by hand would not pass
//   through them, so every shipped GLB's one image is measured here -- the
//   WebP beside a packed mesh, or the PNG inside a pair of wing cards.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCreaturePrompt, frameForRig, ASPECT_RATIOS } from '../tools/creatures/creature-prompt.mjs'
import { CREATURES, TEX_PX_MAX, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readGlbChunks, webpSize } from '../tools/tripo-pack.mjs'
import { MODELS, PRESETS, RIG_TYPES, createMeshTask, estimateCredits, creditsToUsd } from '../tools/creatures/tripo.mjs'
import { workDir } from '../tools/creatures/workspace.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

// --- the mesh request body ---------------------------------------------------
//
// Field names Tripo will not tell you about until you spend a click finding
// out. Both of these shipped wrong and both failed at the vendor rather than
// here: a top-level `file_token` is silently ignored and comes back as "file is
// required", and `quad` sent to P1 is a hard rejection. `fetch` is stubbed, so
// this still makes no network call and creates no task.

console.log('\nmesh request body')
{
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ code: 0, data: { task_id: 'stub' } }), { status: 200 })
  }
  process.env.TRIPO_API_KEY ||= 'stub-key'
  try {
    await createMeshTask({ fileToken: 'file_abc', model: MODELS.p1, quad: true })
    await createMeshTask({ fileToken: 'file_abc', model: MODELS.h3, quad: true })
    await createMeshTask({ fileToken: 'file_abc', model: MODELS.h3, quad: false })
  } finally {
    globalThis.fetch = realFetch
  }
  const [p1, h3quad, h3plain] = sent.map((s) => s.body)
  check(sent[0].url.endsWith('/v3/generation/image-to-model'), 'posts to the image-to-model path')
  check(p1.file?.file_token === 'file_abc', 'the image token is nested under `file`, not top-level')
  check(p1.file_token === undefined, 'and is not also sent top-level, where Tripo ignores it')
  check(p1.quad === undefined, 'quad is omitted for P1, which rejects the field outright')
  check(h3quad.quad === true, 'quad is sent for H3, which accepts and charges for it')
  check(h3plain.quad === undefined, 'and omitted when not asked for')
  check(p1.model === MODELS.p1 && h3quad.model === MODELS.h3, 'the model id goes through unchanged')
}

// --- the price list ---------------------------------------------------------
//
// Pinned against Tripo's published table. A change here is only correct
// alongside a change in the vendor's pricing page, never on its own.

console.log('\ncredit table')
check(estimateCredits({ step: 'mesh', model: MODELS.p1, texture: true }) === 50, 'P1 with texture is 50 credits')
check(estimateCredits({ step: 'mesh', model: MODELS.p1, texture: false }) === 40, 'P1 without texture is 40')
check(estimateCredits({ step: 'mesh', model: MODELS.p1, texture: true, quad: true, smartLowPoly: true, textureQuality: 'detailed' }) === 50,
  'P1 ignores the H3 surcharges (its pricing is all-inclusive)')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: true, quad: false }) === 30, 'H3 with texture is 30')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: false, quad: false }) === 20, 'H3 without texture is 20')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: true, quad: true }) === 35, 'H3 + quad adds 5')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: true, quad: true, smartLowPoly: true }) === 45, 'H3 + quad + smart_low_poly adds 15')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: true, quad: true, smartLowPoly: true, textureQuality: 'detailed' }) === 55,
  'H3 + quad + smart_low_poly + detailed texture adds 25')
check(estimateCredits({ step: 'rig-check' }) === 0, 'rig-check is free -- the reason it is always worth running first')
check(estimateCredits({ step: 'rig' }) === 25, 'rig is 25')
check(estimateCredits({ step: 'retarget', animationCount: 3 }) === 30, 'retarget is 10 per animation')
check(throws(() => estimateCredits({ step: 'nonsense' })), 'an unknown step throws rather than quoting zero')
check(creditsToUsd(100) === 1, 'credits convert at $0.01 each')

// The number the whole bench is budgeted against: one creature, start to
// finish. If this moves, the design doc's cost claim is wrong.
const perCreature = estimateCredits({ step: 'mesh' }) + estimateCredits({ step: 'rig' }) + estimateCredits({ step: 'retarget', animationCount: 3 })
check(creditsToUsd(perCreature) <= 1.10, 'a full creature (P1 mesh + rig + 3 clips) stays at or under $1.10', `$${creditsToUsd(perCreature).toFixed(2)}`)

// --- the id is a security boundary ------------------------------------------

console.log('\ncreature id validation')
for (const bad of ['../etc', 'a/../../b', 'Foo', 'has space', '', 'a_b', './x', 'x/y']) {
  check(throws(() => workDir(bad)), `rejects ${JSON.stringify(bad)}`)
}
check(!throws(() => workDir('red-fox')), 'accepts a normal id')
check(workDir('red-fox').endsWith('tools/creatures/work/red-fox'), 'and puts it under the work dir')

// --- prompts ----------------------------------------------------------------

console.log('\nprompt builder')
const allRigTypes = [...RIG_TYPES, 'none']
for (const rigType of allRigTypes) {
  const p = buildCreaturePrompt({ description: 'a test creature', rigType })
  const ok = p.includes('a test creature') && p.length > 200
  check(ok, `builds a prompt for rigType "${rigType}"`)
}
const bipedPrompt = buildCreaturePrompt({ description: 'x', rigType: 'biped' })
const quadPrompt = buildCreaturePrompt({ description: 'x', rigType: 'quadruped' })
check(bipedPrompt !== quadPrompt, 'the pose clause actually differs by rig type')
check(/A-pose/i.test(bipedPrompt), 'the biped clause asks for an A-pose (auto-rig needs a standard pose)')
check(/four legs/i.test(quadPrompt), 'the quadruped clause asks for all four legs visible')
// The auto-rig solver cannot find geometry that is hidden behind other
// geometry. For a limbed creature that means a limb tucked against the torso;
// for a snake, which has no limbs, it means the body crossing over itself.
// Same failure, two wordings, so two assertions.
for (const rigType of RIG_TYPES.filter((t) => t !== 'serpentine')) {
  check(/separat/i.test(buildCreaturePrompt({ description: 'x', rigType })),
    `"${rigType}" pose clause asks for limbs separated from the body`)
}
check(/no coils crossing/i.test(buildCreaturePrompt({ description: 'x', rigType: 'serpentine' })),
  'the serpentine clause forbids the body crossing over itself (its version of a hidden limb)')

for (const rigType of allRigTypes) {
  const p = buildCreaturePrompt({ description: 'x', rigType })
  check(!/magenta|FF00FF|chroma/i.test(p), `"${rigType}" prompt does not ask for a chroma key -- that is the character pipeline's convention, and it would tint the texture`)
  check(/shadowless|no cast shadow/i.test(p), `"${rigType}" prompt forbids baked shadow`)
}
check(throws(() => buildCreaturePrompt({ description: 'x', rigType: 'wyvern' })), 'an unknown rig type throws rather than silently dropping the pose clause')
check(throws(() => buildCreaturePrompt({ rigType: 'biped' })), 'a missing description throws')

// --- the frame ---------------------------------------------------------------
//
// The canvas shape outranks the description: a wide subject asked for in a
// square gets REPOSED to fit, which is how the dragon kept coming back rearing
// on its hind legs no matter what the text said. So every rig type must name a
// frame, and the wide ones must actually be wide.

console.log('\nframe')
const wide = (r) => { const [w, h] = frameForRig(r).split(':').map(Number); return w > h }
for (const rigType of allRigTypes) {
  check(ASPECT_RATIOS.includes(frameForRig(rigType)), `"${rigType}" has a frame the image API accepts`)
}
for (const rigType of ['quadruped', 'avian', 'aquatic', 'serpentine']) {
  check(wide(rigType), `"${rigType}" is framed wide -- a body seen side-on with legs, tail or open wings does not fit a square`)
}
check(!wide('biped'), 'the biped is the exception: standing upright is a tall subject')
check(throws(() => frameForRig('wyvern')), 'an unknown rig type throws rather than silently falling back to a square')

// --- roster -----------------------------------------------------------------

console.log('\nroster')
const seen = new Set()
for (const c of CREATURES) {
  check(/^[a-z0-9-]+$/.test(c.id), `"${c.id}" is a filesystem-safe id`)
  check(!seen.has(c.id), `"${c.id}" is unique`)
  seen.add(c.id)
  check(allRigTypes.includes(c.rigType), `"${c.id}" names a real rig type`, c.rigType)
  check(Number.isFinite(c.sizeM) && c.sizeM > 0, `"${c.id}" has a positive sizeM`, String(c.sizeM))
  check(typeof c.description === 'string' && c.description.length > 40, `"${c.id}" has a description worth generating from`)
  check(typeof c.label === 'string' && c.label.length > 0, `"${c.id}" has a label`)
  // Every roster entry has to survive the thing it exists to feed.
  check(!throws(() => buildCreaturePrompt({ description: c.description, rigType: c.rigType })), `"${c.id}" builds a prompt`)
}

// --- preset tables ----------------------------------------------------------

console.log('\nanimation presets')
for (const t of RIG_TYPES) {
  check(Array.isArray(PRESETS[t]), `PRESETS covers rig type "${t}"`)
}
check(Object.keys(PRESETS).every((k) => RIG_TYPES.includes(k)), 'PRESETS names no rig type the rig call would reject')
check(PRESETS.biped.length > PRESETS.quadruped.length,
  'biped preset coverage still exceeds quadruped -- the asymmetry the local clip authoring exists to cover')
for (const [type, list] of Object.entries(PRESETS)) {
  check(list.every((p) => p.startsWith('preset:')), `"${type}" presets are all preset: identifiers`)
  check(new Set(list).size === list.length, `"${type}" presets are unique`)
}

// --- every Tripo loader culls -------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRIPO_PATH = /creatures\/work|trees\/v9\/work|['`]creatures\//
const srcFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? srcFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])
const loaders = srcFiles(path.join(ROOT, 'src')).filter((f) => TRIPO_PATH.test(fs.readFileSync(f, 'utf8')))
check(loaders.length >= 5, `found the Tripo loaders (${loaders.length}; the bench, the rig editor, the tree bench, avatar.js, critters.js)`)
for (const f of loaders) {
  check(/from '[./]*\/tripo-culling\.js'/.test(fs.readFileSync(f, 'utf8')),
    `${path.relative(ROOT, f)} imports tripo-culling.js -- a Tripo loader that does not cull z-fights its fins`)
}

// --- every shipped creature is under the texture cap -------------------------

console.log('\nshipped textures')
const SHIPPED = path.join(ROOT, 'public/creatures')
const shipped = fs.readdirSync(SHIPPED).filter((n) => n.endsWith('.glb'))
check(shipped.length > 0, `found the shipped creatures (${shipped.length})`)
for (const name of shipped) {
  // A ladder tier, <id>-lod<k>.glb, wears its pick's WebP.
  const id = name.slice(0, -4).replace(/-lod\d+$/, '')
  const entry = CREATURES.find((c) => c.id === id)
  check(!!entry, `${name} is a roster creature${id === name.slice(0, -4) ? '' : "'s ladder tier"}`)
  if (!entry) continue
  const { json, bin } = readGlbChunks(path.join(SHIPPED, name))
  const images = json.images ?? []
  const want = shipTexPx(entry)
  // Wing cards (tools/creatures/wing-cards.mjs) ship whole: their one PNG is embedded, and it is the card size.
  if (entry.rigType === 'none' && images[0]?.mimeType === 'image/png') {
    const view = json.bufferViews[images[0].bufferView]
    const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    check(images.length === 1 && png.toString('latin1', 1, 4) === 'PNG' && width === want && height === want,
      `${name} embeds one ${want}px PNG wing map`, `${width}x${height}`)
    check(json.materials?.length === 1 && json.materials[0].alphaMode === 'MASK' && json.materials[0].doubleSided === true && json.materials[0].extras?.cutout === true,
      `${name} is a double-sided MASK cutout flagged for tripo-culling`)
    continue
  }
  check(images.length === 1 && images[0].uri === `${id}.webp` && images[0].mimeType === 'image/webp',
    `${name} ships one WebP colour map beside it, not an embedded JPEG`, JSON.stringify(images))
  if (images.length !== 1 || !images[0].uri) continue
  const { width, height } = webpSize(fs.readFileSync(path.join(SHIPPED, images[0].uri)))
  check(width === want && height === want, `${name} colour map is its designated ${want}px square`, `${width}x${height}`)
  check(width <= TEX_PX_MAX && height <= TEX_PX_MAX, `${name} colour map is within the ${TEX_PX_MAX}px cap`)
  const pbr = json.materials?.[0]?.pbrMetallicRoughness
  check(json.materials?.length === 1 && pbr?.metallicFactor === 0 && pbr?.roughnessFactor === 1 && !pbr.metallicRoughnessTexture && !json.materials[0].normalTexture,
    `${name} ships colour only: matte, no roughness or normal map`)
}

// ---------------------------------------------------------------------------

console.log(`\n${failures === 0 ? 'all creature checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
