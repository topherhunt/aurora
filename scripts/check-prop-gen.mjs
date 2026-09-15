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
//   flat and the world then seats crooked at y = 0.
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
import { workDir, META_KEYS } from '../tools/props/gen/workspace.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

// --- the id validator ---------------------------------------------------------

console.log('\nprop id validator')
for (const bad of ['../x', 'a/b', '', 'Stump', 'stump rotting', 'stump.', '..', 'stump\\x']) {
  check(throws(() => workDir(bad)), `rejects ${JSON.stringify(bad)}`)
}
check(!throws(() => workDir('stump-rotting')), 'accepts a normal id')
check(workDir('stump-rotting').endsWith(path.join('tools', 'props', 'gen', 'work', 'stump-rotting')), 'and puts it under tools/props/gen/work')

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
  }
  check(PROPS.filter((p) => p.category === 'mushroom').every((p) => p.texPx === TEX_PX_SMALL), `every mushroom is designated ${TEX_PX_SMALL}px`)
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
