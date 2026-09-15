// Node-side gates for the prop bench (gen-prop.html, tools/props/gen/).
//
//   node scripts/check-prop-gen.mjs
//
// SPENDS NOTHING AND MAKES NO NETWORK CALL. Everything it touches is pure: the
// prompt builder, the roster, the id validator, the credit table the bench
// prices its one orange mesh button from. The failure modes it pins are the
// ones check-creatures.mjs pins for the creature bench, because this bench is
// that one with the rig and animation stages cut off (design/29-prop-pipeline.md):
//
//   A PROP ID REACHES THE FILESYSTEM from a query string on a LAN-bound dev
//   server, so the validator is a security boundary.
//
//   THE PROMPT DRIFTS TOWARD A CHARACTER SHEET (chroma key, cast shadow), or
//   lets the subject float, which Tripo reconstructs with a base that is not
//   flat and the world then seats crooked at y = 0. Or it drifts toward a
//   "stylised low-poly game asset", which the first draft asked for and which
//   comes back smooth, rounded and cartoonish: the brief is gritty and real.
//
//   A DESCRIPTION NAMES WHAT IT DOES NOT WANT. The image models are literal:
//   "snapped off rather than sawn" painted sawn boards, "about a person's
//   height" is an invitation to paint a person, "beetle galleries" a beetle.
//   Negations, contrasts, similes and off-subject nouns are refused in the
//   house style and in every roster description.
//
//   A MUSHROOM ENTRY IS A CLUSTER. The placer clusters copies of one specimen
//   so no two clumps match; a generated cluster is the same three mushrooms in
//   the same arrangement at every site.
//
//   A ROSTER ENTRY IS MALFORMED: an id used twice, a size that is not a size,
//   a frame the image endpoint will refuse, a texture over the cap, a category
//   no renderer owns, or no description (which IS the prompt).
//
//   THE MESH BUTTON QUOTES A PRICE the workspace does not pay: runMesh always
//   asks for a textured P1 mesh, and the roster endpoint prices that from the
//   same table.
//
//   A TRIPO MESH IS DRAWN DOUBLE-SIDED. check-creatures.mjs scans src/ for
//   files that load from tools/creatures/work; this bench loads from
//   tools/props/gen/work, which that regex does not match, so the import is
//   pinned here by name.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPropPrompt, ASPECT_RATIOS, DEFAULT_FRAME, HOUSE_STYLE } from '../tools/props/gen/prop-prompt.mjs'
import { PROPS, CATEGORIES, TEX_PX_MAX, TEX_PX_SMALL, shipTexPx, propById } from '../tools/props/gen/prop-roster.mjs'
import { MODELS, estimateCredits } from '../tools/creatures/tripo.mjs'
import { workDir, readMeta, listAll, META_KEYS } from '../tools/props/gen/workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

// Words that put something in the picture that is meant to be kept out of it:
// negations and contrasts (the model paints the ruled-out thing), similes (it
// paints the compared thing), and nouns for creatures, people and tools that a
// description only ever mentions by way of explanation.
const LITERAL_TRAPS = /\b(not|never|no|none|nothing|without|rather than|instead of|unlike|like an?|as if|resembling|sawn|saw|cut|chopped|axe|chainsaw|person|man|woman|human|people|beetle|bug|insect|slug|snail|woodpecker|bird|animal|bread|cartoon|toy|plastic)\b/i

// --- the id validator ---------------------------------------------------------

console.log('\nprop id validator')
for (const bad of ['../x', 'a/b', '', 'Stump', 'stump rotting', 'stump.', '..', 'stump\\x']) {
  check(throws(() => workDir(bad)), `rejects ${JSON.stringify(bad)}`)
}
check(!throws(() => workDir('stump-rotting')), 'accepts a normal id')
check(workDir('stump-rotting').endsWith(path.join('tools', 'props', 'gen', 'work', 'stump-rotting')), 'and puts it under tools/props/gen/work')

// --- a work dir that outlived its roster entry ---------------------------------
//
// Renaming a roster id strands its work dir, and the candidates in it were paid
// for. The listing must carry it, not throw on it and take every prop down.

console.log('\norphaned work dir')
{
  const orphan = 'zz-check-orphan'
  const dir = workDir(orphan)
  check(!fs.existsSync(dir), 'the scratch id is free', dir)
  fs.mkdirSync(dir, { recursive: true })
  try {
    check(!throws(() => readMeta(orphan)), 'readMeta answers for a work dir with no roster entry and no saved meta')
    check(listAll().some((p) => p.id === orphan && p.inRoster === false), 'and listAll carries it, flagged as not in the roster')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  check(throws(() => readMeta(orphan)), 'while an id with no work dir at all still throws')
}

// --- the prompt ----------------------------------------------------------------

console.log('\nprompt')
{
  const p = buildPropPrompt({ description: 'a rotting stump' })
  const lower = p.toLowerCase()
  check(throws(() => buildPropPrompt({})), 'throws without a description')
  check(!/magenta|chroma|green screen/.test(lower), 'no chroma key -- a keyed colour bleeds into the reconstructed texture')
  check(/no cast shadow/.test(lower), 'asks for no cast shadow')
  check(/grey/.test(lower) && /background/.test(lower), 'stages on a grey background')
  check(/rests/.test(lower) && /floor/.test(lower), 'seats the object on the floor -- the bake and the world both put it at y = 0')
  check(/watertight/.test(lower), 'asks for a watertight solid')
  check(p.includes(HOUSE_STYLE), 'carries the house style')
  check(!/low[- ]poly|stylised|stylized|hand-painted|cartoon|chunky|exaggerated|smooth|simplif/.test(lower), 'does not mention a stylised, low-poly or smoothed asset, even to rule it out')
  check(!LITERAL_TRAPS.test(HOUSE_STYLE), 'the house style has no negation, contrast or simile', HOUSE_STYLE.match(LITERAL_TRAPS)?.[0])
  check(/photorealistic/.test(lower) && /gritty/.test(lower) && /weathered/.test(lower), 'asks for a photorealistic, gritty, weathered specimen')
  check(/jagged/.test(lower) && /irregular/.test(lower), 'asks for a jagged, irregular silhouette')
  check(p.trim().endsWith('Object: a rotting stump.'), 'ends with the description as the object line')
  const styled = buildPropPrompt({ description: 'a stump', styleNote: 'Extra gnarly.' })
  check(styled.includes('Extra gnarly.') && styled.indexOf('Extra gnarly.') > styled.indexOf(HOUSE_STYLE), 'a styleNote is appended after the house style')
  check(ASPECT_RATIOS.includes(DEFAULT_FRAME), `the default frame ${DEFAULT_FRAME} is one the image endpoint accepts`)
}

// --- the roster ------------------------------------------------------------------

console.log('\nroster')
{
  const ids = PROPS.map((p) => p.id)
  check(new Set(ids).size === ids.length, 'ids are unique')
  check(PROPS.length >= 3, `${PROPS.length} seed props`)
  for (const p of PROPS) {
    check(!throws(() => workDir(p.id)), `${p.id}: id is a valid work dir name`)
    check(typeof p.sizeM === 'number' && p.sizeM > 0, `${p.id}: sizeM is a positive number`, String(p.sizeM))
    check(ASPECT_RATIOS.includes(p.aspectRatio ?? DEFAULT_FRAME), `${p.id}: aspect ratio is one the image endpoint accepts`, p.aspectRatio)
    check(CATEGORIES.includes(p.category), `${p.id}: category is one of ${CATEGORIES.join('/')}`, p.category)
    check(typeof p.description === 'string' && p.description.length > 40, `${p.id}: has a description (it is the prompt)`)
    check(!throws(() => shipTexPx(p)) && shipTexPx(p) <= TEX_PX_MAX, `${p.id}: ships at ${shipTexPx(p)}px, within the ${TEX_PX_MAX}px cap`)
    check(!throws(() => buildPropPrompt(p)), `${p.id}: builds a prompt`)
    check(!LITERAL_TRAPS.test(p.description), `${p.id}: description names only what belongs in the picture`, p.description.match(LITERAL_TRAPS)?.[0])
  }
  const mushrooms = PROPS.filter((p) => p.category === 'mushroom')
  check(mushrooms.length > 0 && mushrooms.every((p) => p.texPx === TEX_PX_SMALL), `every mushroom is designated ${TEX_PX_SMALL}px`)
  for (const p of mushrooms) {
    check(/^a single /.test(p.description) && !/cluster|tuft|dozen|three|pair of|group/.test(p.description), `${p.id}: is one specimen -- the placer makes the clusters`)
  }
  for (const p of PROPS.filter((p) => p.category === 'deadwood')) {
    check(/jagged|splinter/.test(p.description), `${p.id}: deadwood is described jagged or splintered`)
  }
  check(throws(() => shipTexPx({ id: 'x', texPx: TEX_PX_MAX * 2 })), 'shipTexPx throws on a texture over the cap')
  check(propById(ids[0]) === PROPS[0] && propById('no-such-prop') === null, 'propById finds a seed and answers null for a stranger')
  for (const k of ['label', 'category', 'sizeM', 'texPx', 'description', 'styleNote', 'aspectRatio']) {
    check(META_KEYS.includes(k), `the bench can save "${k}"`)
  }
}

// --- the price on the mesh button -----------------------------------------------

console.log('\ncredits')
check(estimateCredits({ step: 'mesh', model: MODELS.p1, texture: true }) === 50, 'a textured P1 mesh is 50 credits')
check(estimateCredits({ step: 'mesh', model: MODELS.p1, texture: false }) === 40, 'a bare P1 mesh is 40')
check(estimateCredits({ step: 'mesh', model: MODELS.h3, texture: true, quad: false }) === 30, 'a textured H3 mesh is 30')

// --- the bench page ------------------------------------------------------------------

console.log('\nbench page')
{
  const main = fs.readFileSync(path.join(ROOT, 'src/gen-prop-main.js'), 'utf8')
  check(/from '\.\/tripo-culling\.js'/.test(main), 'src/gen-prop-main.js culls Tripo backfaces on load')
  check(/cullTripoBackfaces\(/.test(main), 'and calls it')
  check(!/__creature-|tools\/creatures\/work/.test(main), 'and never reaches for the creature bench\'s endpoints or work dir')
  for (const stage of ['rig', 'anim', 'skeleton']) {
    check(!new RegExp(`__prop-${stage}`).test(main), `no ${stage} stage -- props do not get one`)
  }
  const html = fs.readFileSync(path.join(ROOT, 'gen-prop.html'), 'utf8')
  check(/src="\/src\/gen-prop-main\.js"/.test(html), 'gen-prop.html loads the prop bench script')
  for (const id of ['genImage', 'genMesh', 'genLod', 'genCards', 'saveLod', 'fileSelect', 'texMax', 'texSmall']) {
    check(html.includes(`id="${id}"`) && main.includes(`'${id}'`), `#${id} exists in the page and is wired in the script`)
  }
  const vite = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8')
  check(/propGen\(\)/.test(vite) && /'\/__prop-roster'/.test(vite) && /'\/__prop-lod'/.test(vite), 'vite.config.js mounts the propGen() endpoints')
}

console.log(`\n${failures === 0 ? 'all prop-gen checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
