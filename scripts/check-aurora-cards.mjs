// ---------------------------------------------------------------------------
// Gate for /test-aurora-v2, the contour-card aurora.
//
// The technique inverts where the work happens. The lab (/test-aurora) evaluates the ley-line potential per pixel, per march step, on the GPU: ~21 noise lookups a step, ~840 a pixel. This one evaluates the SAME potential once, on the CPU, over a coarse plan grid, traces its contours with marching squares, and extrudes each polyline into a strip of camera-facing cards. The GPU then does almost nothing per pixel. Everything below exists to keep that trade honest and to keep the physics from quietly drifting out of the shader while nobody is looking.
//
// The failure modes this catches, in rough order of how expensive they are to find any other way:
//
//   1. AN ALTITUDE TERM IN AN ALONG-CHANNEL TERM. design/13-aurora-and-sky.md
//      §"All structure is vertical": the rays ARE field lines, so the noise that
//      generates striations is indexed on distance along the arc and must not
//      contain an altitude term. In this technique the along-channel terms live
//      in the VERTEX shader specifically so they cannot reach for one, and this
//      gate is what keeps them there. One identifier's worth of mistake, and it
//      produces a picture rather than an error: coloured fog.
//
//   2. THE DOMAIN WARP CREEPING BACK ONTO THE GPU. The entire cost argument for
//      this approach is that the multi-octave warp runs once on the CPU. A
//      single `warp2` or `gfbm2` call in either shader and the approach has
//      become the expensive one with extra steps, silently, while still
//      rendering correctly.
//
//   3. A NON-ADDITIVE EMITTER. An aurora is optically thin. If the cards write
//      depth they sort wrongly against each other and against themselves, and
//      they punch a hole in the stars behind them.
//
//   4. A UNIFORM PARAM IN REBUILD_KEYS. A param marked `uniform: true` is
//      written into a shader uniform every frame and costs nothing to change.
//      The same key in REBUILD_KEYS means dragging its slider kicks off a full
//      CPU re-trace per mousemove event. The panel stays responsive right up
//      until it does not.
//
//   5. A DEFAULT OUTSIDE ITS OWN SLIDER RANGE, and 6. A STUB HINT. Both ported
//      from check-aurora-lab.mjs, same reasoning: a slider that jumps the first
//      time it is touched, and a panel that decays because nobody was made to
//      write down what a knob does.
//
//   7. A KEY THAT OUTLIVED ITS FEATURE. Cutting a term out of the shader means
//      cutting its params, its presets and any geometry that existed only to
//      carry it, and not one of those three fails loudly when it is missed. A
//      preset here is PARTIAL and curtains.js only console.warns a key it does
//      not recognise, so a stale `fold: 12` is silent. A schema entry with
//      nothing behind it is a slider that moves and changes nothing. And a card
//      still subdivided for a displacement that no longer exists is pure cost
//      at an identical picture. All three are invisible from the sky, which is
//      the only place anyone looks.
//
// What this can NOT check: whether the sky looks like an aurora, whether the
// contours it does find are anywhere anyone wanted them, or whether the card
// strips are wound so their normals face the camera. Those need eyes (§17).
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The aurora-cards modules are imported DYNAMICALLY, further down, and that is not a stylistic choice. glsl.js is one long template literal, a stray backtick inside it is a SyntaxError, and a static import of a file with a SyntaxError takes this whole script down with a bare stack trace before a single check has printed. That is the least useful possible way to report a fault. So every check that can run off the filesystem runs first, and the imports come after.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
// Sections that could not run at all. A skip is NOT a failure -- it must not
// turn the gate red -- but it must not be invisible either, so the final line
// names it. A check suite that prints ALL CHECKS PASSED when a whole section
// never executed is lying by omission, which is the failure mode the skip is
// supposed to protect against.
const skipped = []
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const warn = (label, detail = '') => {
  console.log(` warn  ${label}${detail ? `   ${detail}` : ''}`)
}

const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
const readIfPresent = (rel) => (exists(rel) ? fs.readFileSync(path.join(ROOT, rel), 'utf8') : '')

// Comments are stripped before any textual scan of GLSL. Without this, a comment saying "no altitude here" fails the altitude check, and a comment naming `gfbm2` fails the no-GPU-warp check, both of which are the opposite of what those checks are for.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

// ===========================================================================
console.log('\n--- the technique has all its files ---------------------------')
// ===========================================================================

const MODULE_FILES = [
  'src/aurora-cards/field.js',
  'src/aurora-cards/trace.js',
  'src/aurora-cards/cards.js',
  'src/aurora-cards/glsl.js',
  'src/aurora-cards/params.js',
  'src/aurora-cards/presets.js',
  'src/aurora-cards/curtains.js',
]

for (const rel of [...MODULE_FILES, 'test-aurora-v2.html', 'src/test-aurora-v2-main.js']) {
  check(exists(rel), `${rel} exists`)
}

// ===========================================================================
console.log('\n--- every file parses, and no GLSL literal ends early ----------')
// ===========================================================================
//
// This runs before anything is imported, because it is the one fault that stops the imports happening at all, and a fault that is reported as a stack trace instead of as a check is a fault nobody reads.
//
// Two checks per file, and the crude one is kept even though the parse is strictly stronger, because they answer different questions. `node --check` says THE FILE DOES NOT PARSE and points at the line where the parser gave up, which can be a long way from the backtick that closed the literal early. The backtick scan says WHICH LITERAL has a stray in it and on what line, which is the thing you actually go and delete.
//
// Counted INSIDE the exported literals only. The header comment at the top of glsl.js quotes `export const CARD_VERT =` in backticks on purpose, and a whole-file tally would fail on the very banner that warns about this.

const STRAY_BACKTICK_WHY = [
  '        why: the shaders are template literals, so a backtick inside one ends the string there and everything after it is parsed as JavaScript. The reason this is a gate and not a comment is that it usually does NOT throw: strays arrive in pairs, a pair closes and reopens the literal, the backtick tally over the file stays EVEN, and the file parses cleanly. What you get is a shader quietly missing its second half, which shows up as a blank sky or a missing term and never as an error. It has cost this repo an afternoon once already.',
].join('\n')

const cardsDir = path.join(ROOT, 'src', 'aurora-cards')
const cardsFiles = fs.existsSync(cardsDir)
  ? fs.readdirSync(cardsDir).filter((n) => n.endsWith('.js')).sort().map((n) => path.join(cardsDir, n))
  : []
check(cardsFiles.length >= 7, 'there are aurora-cards files to scan at all', `${cardsFiles.length} files`)

let strayBackticks = 0
for (const file of cardsFiles) {
  const rel = path.relative(ROOT, file)
  const src = fs.readFileSync(file, 'utf8')

  // Parsed, not executed: --check never runs module scope, so this is safe on curtains.js and cards.js, which both import three.js and cannot be loaded here at all.
  const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  const err = (parsed.stderr || '').split('\n')
  // node --check puts `path:line` on the first line of stderr and the SyntaxError further down, so both halves are recovered and printed together.
  const at = (err[0] || '').trim()
  const why = err.find((l) => /Error/.test(l)) || ''
  check(parsed.status === 0, `${rel}: parses as an ES module`,
    parsed.status === 0 ? '' : `${why.trim()} at ${at}`)

  // A GLSL export opens with a backtick at the end of its `export const X = ` line and closes with a backtick alone on a line. Every backtick between those two is a stray by construction, and its line number is reported because that is what you delete.
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const opened = /^export const (\w+)\s*=\s*`\s*$/.exec(lines[i])
    if (!opened) continue
    const name = opened[1]
    // The terminator has to be a backtick ALONE on its line, not merely a line starting with one. A stray that happens to land at column 0 would otherwise be read as the terminator, and the scan would cheerfully report an empty literal with no strays in it, which is the exact opposite of the truth. The strictness costs a convention: a GLSL export must close on its own line. If one ever closes as `.trim() instead, this fails loudly rather than silently going blind, which is the right way round.
    let close = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (/^`\s*$/.test(lines[j])) { close = j; break }
    }
    if (close < 0) {
      strayBackticks++
      check(false, `${rel}: ${name} closes with a backtick alone on its own line`,
        `no such line after line ${i + 1} -- either the literal is unterminated or it closes mid-line, and this scan needs the convention to find its end`)
      continue
    }
    const inside = []
    for (let j = i + 1; j < close; j++) {
      if (lines[j].includes('`')) inside.push(`line ${j + 1}`)
    }
    if (inside.length) strayBackticks++
    check(inside.length === 0, `${rel}: ${name} contains no stray backtick`,
      inside.length ? `${inside.length} at ${inside.join(', ')}` : `${close - i - 1} lines of GLSL`)
  }
}
if (strayBackticks) console.log(STRAY_BACKTICK_WHY)

// ===========================================================================
console.log('\n--- the emitter composites order-free and never writes depth ---')
// ===========================================================================
//
// curtains.js imports three.js, which does not load in node, so it is read as TEXT and matched against the strings the rest of the repo already uses. src/aurora.js and src/aurora-lab/screen.js both configure their aurora material exactly this way, and the reasoning is written out at src/aurora.js:135: an optically thin emitter draws in the transparent pass, after the opaque pass has filled the depth buffer, so a mountain in front of it occludes it through the depth TEST, while writing depth would make the cards occlude each other and punch a hole in the stars. `fog: false` is there because fogging an emitter tints it toward the fog colour at exactly the distances an aurora is always at.
//
// The blend here is a SCREEN and not `AdditiveBlending`, and the three factors are checked as a SET because any two of them without the third is a different equation. `One` with `OneMinusSrcColor` gives dst = src + dst * ( 1 - src ), whose N-card composite is 1 - product( 1 - s_i ). The property this check is actually protecting is the same one the additive blend had -- that product commutes, so the cards need no sorting and the depth settings above stay correct -- plus the one it did not: the result is bounded by one, so a deep stack rolls off instead of clipping. Clipping is not a cosmetic problem for this technique. The smooth part of an overlap saturates first, so a clipped pixel keeps only the gaps between the brightest cores, and the sky grows a picket fence that no amount of profile tuning can remove because the profile was never what put it there.
//
// If somebody puts `AdditiveBlending` back, the sky will still draw, still be order independent and still pass every other check in this file. It will just clip again.

const curtainsSrc = readIfPresent('src/aurora-cards/curtains.js')
check(curtainsSrc.length > 0, 'curtains.js has something in it to check', `${curtainsSrc.length} bytes`)

for (const token of [
  'blending: THREE.CustomBlending',
  'blendSrc: THREE.OneFactor',
  'blendDst: THREE.OneMinusSrcColorFactor',
  'depthWrite: false', 'depthTest: true', 'transparent: true', 'fog: false',
]) {
  check(curtainsSrc.includes(token), `curtains.js sets \`${token}\` on the card material`)
}

check(
  !/blending:\s*THREE\.AdditiveBlending/.test(curtainsSrc),
  'the card material is not additive, so a deep stack rolls off instead of clipping to white',
)

// The screen blend is only bounded if every card hands it a src at or below one. Above one the dst factor ( 1 - src ) goes NEGATIVE and overlapping columns start subtracting from each other, which looks like dark seams between the cards -- a picket fence again, by the opposite route.
const fragSrc = readIfPresent('src/aurora-cards/glsl.js')
check(
  /clamp\(\s*vA\.rgb\s*\*\s*max\(\s*a,\s*0\.0\s*\),\s*0\.0,\s*1\.0\s*\)/.test(fragSrc),
  'the fragment shader clamps each card to one, which is what keeps the screen blend from subtracting',
)

check(/class\s+AuroraCards\b/.test(curtainsSrc), 'curtains.js exports the AuroraCards class the page drives')

// cards.js imports three.js too, so it gets the same treatment. KM_TO_WORLD is the one number that has to agree between the CPU trace, which works in kilometres, and the shader, which is handed the same constant as `u_kmToWorld`. Nothing here can check the two agree, but a rename that drops the export is at least loud.
const cardsSrc = readIfPresent('src/aurora-cards/cards.js')
check(/export\s+function\s+buildCards\b/.test(cardsSrc), 'cards.js exports buildCards')
check(/export\s+const\s+KM_TO_WORLD\b/.test(cardsSrc), 'cards.js exports KM_TO_WORLD')

// ===========================================================================
console.log('\n--- the page is wired -----------------------------------------')
// ===========================================================================
//
// vite has to be told about a second page in TWO places: the dev server's bare-route rewrite, so /test-aurora-v2 resolves without the extension, and the rollup build input, so the page survives `npm run build`. One without the other gives a page that works in dev and vanishes from the build, which is the worst version of this to find out about late.

const viteSrc = readIfPresent('vite.config.js')
const viteMentions = (viteSrc.match(/test-aurora-v2/g) || []).length
check(viteMentions >= 2, 'vite.config.js names the page for both the dev rewrite and the build input',
  `${viteMentions} mention(s) of test-aurora-v2`)

// A gate nobody runs is not a gate. `npm run check` is the only thing standing between this file and irrelevance.
const pkg = JSON.parse(readIfPresent('package.json') || '{}')
const scripts = pkg.scripts || {}
check(typeof scripts['check-aurora-cards'] === 'string', 'package.json has a check-aurora-cards script')
check(typeof scripts.check === 'string' && scripts.check.includes('check-aurora-cards'),
  'and the check chain runs it')

// ===========================================================================
// Everything below needs the modules. They are imported one at a time so a
// failure names the file that failed rather than reporting a bare SyntaxError
// with no context. If any of them will not load, nothing below can be checked,
// so say which and stop rather than throwing over the results that did print.
// ===========================================================================

// curtains.js and cards.js are deliberately absent from this list because both import three.js, and everything here is pure data or pure arithmetic that loads in milliseconds. Absent is not the same as unloadable: three imports perfectly well in node -- there is no WebGL until a WebGLRenderer is constructed, and a BufferGeometry is typed arrays and nothing else -- so cards.js IS imported further down, in the one section that needs it and nowhere else. curtains.js is the one that genuinely cannot be exercised here, because what it does is build a ShaderMaterial and hand it to a renderer, which is why the emitter section above reads it as text.
const PURE_MODULES = [
  '../src/aurora-cards/field.js',
  '../src/aurora-cards/trace.js',
  '../src/aurora-cards/glsl.js',
  '../src/aurora-cards/params.js',
  '../src/aurora-cards/presets.js',
]

// Both the merged bag and the namespaces are kept. The bag is what almost every check below reads, and it is convenient. It is also WRONG for `export let`: spreading a namespace copies the value at spread time, so warpX read out of the bag is forever its initial 0 no matter what warp2 does afterwards, and the one check that watches warp2 write would pass vacuously. Live bindings are read through NS.
let MODULES = {}
const NS = {}
let loadFailures = 0
for (const spec of PURE_MODULES) {
  try {
    const ns = await import(spec)
    NS[spec.split('/').pop()] = ns
    MODULES = { ...MODULES, ...ns }
  } catch (e) {
    loadFailures++
    console.log(` FAIL  ${spec.replace('../', '')} does not load   ${e.message.split('\n')[0]}`)
  }
}
if (loadFailures > 0) {
  console.log('\nnothing below this point can be checked until those modules load')
  console.log(`\n${failures + loadFailures} CHECK(S) FAILED`)
  process.exit(1)
}

const { hash21, vnoise2, gnoise2, gfbm2, warp2, phi } = MODULES
const { traceContours } = MODULES
const { CARD_VERT, CARD_FRAG } = MODULES
const { CARD_GROUPS, SCENE_GROUPS, allGroups, allParams, defaults, REBUILD_KEYS } = MODULES
const { BUILTIN_PRESETS } = MODULES

// ===========================================================================
console.log('\n--- param schema integrity ------------------------------------')
// ===========================================================================
//
// Ported wholesale from check-aurora-lab.mjs, because the panel is the same panel and the failure modes are the same failure modes.

const KEY = /^[a-z][A-Za-z0-9]*$/
const TYPES = new Set(['float', 'color', 'bool', 'enum'])
// Long enough that a placeholder cannot reach it, short enough that a real one-sentence hint clears it comfortably. Sixty sliders are usable only because every one of them says what it does and what it looks like when it is wrong.
const MIN_HINT = 40

const groups = typeof allGroups === 'function' ? allGroups() : []
check(Array.isArray(groups) && groups.length > 0, 'allGroups() returns groups at all', `${groups.length} group(s)`)

// The order matters because it is the order the sidebar renders in, and because SCENE_GROUPS holds the knobs that are not about the aurora at all. Compared by identity, so a group rebuilt into a copy with the same title still fails: allGroups is meant to be a concatenation, not a re-derivation.
const expectedGroups = [...(CARD_GROUPS || []), ...(SCENE_GROUPS || [])]
const sameGroups = groups.length === expectedGroups.length && groups.every((g, i) => g === expectedGroups[i])
check(sameGroups, 'allGroups() is exactly CARD_GROUPS followed by SCENE_GROUPS',
  `${groups.length} from allGroups, ${(CARD_GROUPS || []).length} + ${(SCENE_GROUPS || []).length} from the two constants`)

const params = typeof allParams === 'function' ? allParams() : []
check(Array.isArray(params) && params.length > 0, 'allParams() returns params at all', `${params.length} param(s)`)

const keyCounts = new Map()
for (const p of params) keyCounts.set(p.key, (keyCounts.get(p.key) || 0) + 1)
const dupes = [...keyCounts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`)
check(dupes.length === 0, 'no key appears in two groups', dupes.join(', '))

const badKey = params.filter((p) => !p.key || !KEY.test(p.key))
check(badKey.length === 0, 'every key is a plain lowerCamel identifier', badKey.map((p) => String(p.key)).join(', '))

const badLabel = params.filter((p) => !p.label || !p.label.trim())
check(badLabel.length === 0, 'every param has a label', badLabel.map((p) => p.key).join(', '))

const badHint = params.filter((p) => !p.hint || p.hint.trim().length < MIN_HINT)
check(badHint.length === 0, `every hint says something -- at least ${MIN_HINT} characters`,
  badHint.map((p) => `${p.key} (${(p.hint || '').trim().length})`).join(', '))

const badType = params.filter((p) => !TYPES.has(p.type))
check(badType.length === 0, 'every type is one the shader can declare', badType.map((p) => `${p.key}: ${p.type}`).join(', '))

const floats = params.filter((p) => p.type === 'float')
const badRange = floats.filter((p) => !Number.isFinite(p.min) || !Number.isFinite(p.max) || !(p.min < p.max))
check(badRange.length === 0, 'every float slider has a finite min below its max',
  badRange.map((p) => `${p.key} [${p.min}, ${p.max}]`).join(', '))

const badStep = floats.filter((p) => !Number.isFinite(p.step) || !(p.step > 0))
check(badStep.length === 0, 'and a positive step', badStep.map((p) => `${p.key} step ${p.step}`).join(', '))

// A default outside its own range presents as a slider that jumps the instant it is touched, and it is never obvious that the number moved because the schema was wrong rather than because you moved it.
const outside = floats.filter((p) => !Number.isFinite(p.value) || p.value < p.min || p.value > p.max)
check(outside.length === 0, 'and a default inside its own range',
  outside.map((p) => `${p.key} ${p.value} not in [${p.min}, ${p.max}]`).join(', '))

// Colours go to the shader as a vec3 and to the panel as a hex swatch, so anything that is not three numbers in 0..1 is wrong at both ends.
const badColor = params.filter((p) => p.type === 'color').filter(
  (p) => !Array.isArray(p.value) || p.value.length !== 3 || !p.value.every((c) => Number.isFinite(c) && c >= 0 && c <= 1)
)
check(badColor.length === 0, 'every colour default is three numbers in 0..1',
  badColor.map((p) => `${p.key} ${JSON.stringify(p.value)}`).join(', '))

// An enum default that is not in its own options list leaves the select showing nothing until it is touched, at which point the sky changes for a reason nobody asked for.
const badEnum = params.filter((p) => p.type === 'enum').filter((p) => {
  const opts = p.options || []
  const i = typeof p.value === 'string' ? opts.indexOf(p.value) : p.value
  return !Number.isInteger(i) || i < 0 || i >= opts.length
})
check(badEnum.length === 0, 'every enum default is one of its own options',
  badEnum.map((p) => `${p.key} ${JSON.stringify(p.value)} not in [${(p.options || []).join(', ')}]`).join(', '))

// defaults() is what the panel starts from and what `reset` restores, so a key missing from it is a control with no value behind it, and an extra key is a value nothing will ever show.
let defs = null
let defsThrew = ''
try {
  defs = defaults()
} catch (e) {
  defsThrew = e.message
}
check(defs !== null, 'defaults() does not throw', defsThrew)

const schemaKeys = new Set(params.map((p) => p.key))
if (defs) {
  const noDefault = params.filter((p) => !(p.key in defs))
  check(noDefault.length === 0, 'defaults() has a starting value for every param', noDefault.map((p) => p.key).join(', '))

  const strayDefault = Object.keys(defs).filter((k) => !schemaKeys.has(k))
  check(strayDefault.length === 0, 'and no value for a param the schema does not have', strayDefault.join(', '))
}

// ===========================================================================
console.log('\n--- the builtin presets still load ----------------------------')
// ===========================================================================
//
// A builtin is a tuning that is checked in rather than saved into localStorage, because a reference you cannot get back on another machine, in another browser, or after clearing a profile is not a reference. The drift that matters is quiet: a key renamed in params.js leaves the preset setting a knob that no longer exists, the panel ignores it, and the preset is still very nearly the sky it pinned. That is the worst possible version of this to discover halfway through a tuning pass.

const presetNames = Object.keys(BUILTIN_PRESETS || {})
check(presetNames.length > 0, 'there is at least one builtin preset', `${presetNames.length} builtin(s)`)

const everSet = new Set()

for (const name of presetNames) {
  const preset = BUILTIN_PRESETS[name]
  const values = preset && preset.values
  const hasValues = !!values && typeof values === 'object' && !Array.isArray(values)
  check(hasValues, `${name}: carries a values object`)
  if (!hasValues) continue

  for (const k of Object.keys(values)) everSet.add(k)

  const stray = Object.keys(values).filter((k) => !schemaKeys.has(k)).sort()
  check(stray.length === 0, `${name}: sets no knob the schema no longer has`, stray.join(', '))

  // In range as well as present. A preset value outside its own slider range means the panel loads it, the first touch of the slider clamps it, and the tuning quietly is not the tuning any more.
  const bad = []
  for (const p of params) {
    if (!(p.key in values)) continue
    const v = values[p.key]
    if (p.type === 'float') {
      if (!Number.isFinite(v) || v < p.min || v > p.max) bad.push(`${p.key} ${JSON.stringify(v)} not in [${p.min}, ${p.max}]`)
    } else if (p.type === 'color') {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => Number.isFinite(c))) bad.push(`${p.key} ${JSON.stringify(v)} is not three numbers`)
    } else if (p.type === 'enum') {
      const opts = p.options || []
      const i = typeof v === 'string' ? opts.indexOf(v) : v
      if (!Number.isInteger(i) || i < 0 || i >= opts.length) bad.push(`${p.key} ${JSON.stringify(v)} is not one of ${opts.join(', ')}`)
    }
  }
  check(bad.length === 0, `${name}: and every value is one the panel can take`, bad.join('; '))
}

// The reverse direction is information, not a failure. A preset is a PARTIAL override here, so a knob no preset states is simply a knob every preset was happy to leave at its default, which is legitimate. It is still worth printing, because it is also what a knob added and then forgotten looks like.
const neverSet = [...schemaKeys].filter((k) => !everSet.has(k)).sort()
if (neverSet.length) warn(`${neverSet.length} schema key(s) no builtin preset ever sets`, neverSet.join(', '))
else console.log('  ok   every schema key is stated by at least one builtin preset')

// ===========================================================================
console.log('\n--- REBUILD_KEYS is honest ------------------------------------')
// ===========================================================================
//
// This is the check that keeps the panel usable. A param split falls into exactly two camps. A `uniform: true` param is written straight into a shader uniform on the next frame: free to change, continuous while dragging. Everything else needs the CPU pipeline re-run, potential to contours to cards, which is tens of milliseconds at best, so it is listed in REBUILD_KEYS and the page debounces it.
//
// A key in BOTH is the accident. It looks harmless because the sky still renders correctly, but every mousemove event during a slider drag now schedules a full re-trace. The panel is fine for a static screenshot and unusable the moment anyone touches it, which is not a thing a screenshot review catches.

const rebuild = Array.isArray(REBUILD_KEYS) ? REBUILD_KEYS : REBUILD_KEYS instanceof Set ? [...REBUILD_KEYS] : null
check(rebuild !== null, 'REBUILD_KEYS is a list this gate can read', rebuild === null ? `got ${typeof REBUILD_KEYS}` : `${rebuild.length} key(s)`)

if (rebuild) {
  const strayRebuild = rebuild.filter((k) => !schemaKeys.has(k)).sort()
  check(strayRebuild.length === 0, 'every key in REBUILD_KEYS is a param that exists', strayRebuild.join(', '))

  const uniformKeys = new Set(params.filter((p) => p.uniform === true).map((p) => p.key))
  const both = rebuild.filter((k) => uniformKeys.has(k)).sort()
  check(both.length === 0, 'and no uniform param is also a rebuild key -- a slider drag must not re-trace', both.join(', '))
  if (both.length) {
    console.log('        why: a `uniform: true` param goes straight into a shader uniform every frame, so it is free to drag. Listing it in REBUILD_KEYS as well means every mousemove during that drag also schedules a CPU re-trace of the whole contour field. Pick one: either it is a uniform and it is cheap, or it changes the geometry and it rebuilds.')
  }
}

// ===========================================================================
console.log('\n--- a card is one quad, not a stack of them --------------------')
// ===========================================================================
//
// A card used to be subdivided vertically, and the subdivision had exactly one job: the fold and lean displacement pushed the column sideways by an amount that grew with height, so the column had to be made of several rows for that push to read as a CURVE. One row and every fold was a straight slanted plane, which looks like a shard rather than a drape.
//
// The fold is gone. The column is dead straight from hem to top, which means every interior row now lies exactly on the line between the two end rows, and subdividing is pure cost at a pixel-for-pixel identical picture: four rows is four times the vertices and four times the triangles to draw the same quad. Worse than the cost is the knob. A `rows` slider with no displacement left to curve is a control wired to nothing -- it moves, the triangle count in the readout changes, the sky does not, and the only way to find that out is to sit and stare at two screenshots that are the same screenshot.
//
// So both halves are asserted: the geometry is a single quad, and the schema does not offer a knob for a subdivision that cannot exist.
//
// Exercised against a synthetic polyline rather than against traceContours, deliberately. What is being checked here is the SHAPE of the base mesh, which is a property of cards.js alone, and running the real trace first would make this section fail whenever the field tuning changed in a way that produced no contours -- a failure about the wrong file entirely. The fixture is a straight run of points at a gentle, constant gradient, which is the case every clamp in buildCards leaves alone.

if (defs) {
  check(!schemaKeys.has('rows'), 'the schema has no `rows` knob -- there is no displacement left for a row to curve',
    schemaKeys.has('rows') ? 'a `rows` slider now changes the triangle count and nothing else, which is a control wired to nothing' : '')

  let cardsMod = null
  let cardsLoadErr = ''
  try {
    cardsMod = await import('../src/aurora-cards/cards.js')
  } catch (e) {
    cardsLoadErr = e.message.split('\n')[0]
  }

  if (!cardsMod) {
    // A skip rather than a failure, and recorded, because the reason cards.js might stop importing here is three.js reaching for something node does not have, which would be a fault in neither this gate nor cards.js. It must still be named at the bottom: a silent skip is how this check would rot.
    console.log(` SKIP  cards.js could not be imported   ${cardsLoadErr}`)
    console.log('        the base card geometry was NOT built and its shape was NOT checked this run')
    skipped.push('card geometry shape (cards.js would not import)')
  } else {
    // 17 points 25 km apart, centred on the eye so the draw-radius cull cannot reach them, at a gradient of 0.02 per km -- a half-width of 25 km, comfortably inside both width clamps at the shipped defaults.
    const N = 17
    const pts = new Float32Array(N * 2)
    const arc = new Float32Array(N)
    const grad = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      pts[i * 2] = -200 + i * 25
      pts[i * 2 + 1] = 0
      arc[i] = i * 25
      grad[i] = 0.02
    }
    const fixture = { level: 1, closed: false, pts, arc, grad }

    let built = null
    let builtThrew = ''
    try {
      built = cardsMod.buildCards([fixture], defs)
    } catch (e) {
      builtThrew = e.message
    }
    check(builtThrew === '', 'buildCards runs against defaults() without throwing', builtThrew)

    if (built) {
      // Without this every assertion below passes vacuously on an empty geometry, which is the shape a "no cards were built" bug would have.
      check(built.cards > 0, 'and builds cards from the fixture at all', `${built.cards} card(s), ${built.dropped} dropped`)

      const index = built.geometry && built.geometry.getIndex ? built.geometry.getIndex() : null
      check(index !== null, 'the card geometry is indexed', index === null ? 'no index buffer -- an unindexed quad is six vertices instead of four' : '')

      if (index) {
        check(index.count === 6, 'and its index buffer is exactly 6 entries -- two triangles, one quad, per card',
          `${index.count} entries = ${index.count / 3} triangle(s); anything above 6 is a vertical subdivision that no longer displaces anything`)
      }

      const pos = built.geometry && built.geometry.getAttribute ? built.geometry.getAttribute('position') : null
      check(pos != null && pos.count === 4, 'and the base mesh has 4 vertices -- the four corners and nothing between them',
        pos == null ? 'no position attribute' : `${pos.count} vertices`)

      // tris is what the page prints in its readout and what any triangle-budget decision is made from, so it has to agree with the mesh that is actually drawn rather than being computed from a row count that is no longer there.
      check(built.tris === built.cards * 2, 'and the reported triangle count is two per card',
        `${built.tris} tris for ${built.cards} cards`)
    }
  }
}

// ===========================================================================
console.log('\n--- the keys that were cut are gone everywhere -----------------')
// ===========================================================================
//
// `fold`, `foldFreq`, `shear` and `rows` were removed together: the sideways fold and lean displacement is gone, so every card is a dead-straight vertical column, and the vertical subdivision that existed only to curve that displacement went with it.
//
// Removing a key from params.js is the easy half. The half that gets missed is presets.js, and it is missed silently BY DESIGN: a builtin preset here is a PARTIAL override, and curtains.js only console.warns a key it does not recognise rather than throwing. So a leftover `fold: 12` inside a preset is a line of dead configuration that no page load, no build and no other check in this file will ever mention. The preset section above catches a stray key only for presets it can see through the schema; this catches it as text, which also covers the shader.
//
// MATCHED AS AN IDENTIFIER, NOT AS A SUBSTRING, and both halves of that matter. `foldFreq` CONTAINS `fold`, so a substring scan for `fold` reports a hit on every `foldFreq` and the two keys can never be distinguished. In the other direction the word "fold" is ordinary English and appears in this codebase's prose on purpose -- "channels start folding over themselves", "every fold on the ground" -- so a scan that reads prose would be permanently red for no reason.
//
// Prose lives in two places and each is neutralised its own way. Comments are blanked, preserving their newlines so the line numbers this prints still point at the line you have to open. Single-quoted strings -- which is what every label and hint in params.js is -- are blanked too, but only for the identifier pass; the quoted pass then looks for a string whose WHOLE content is the key, which is how `key: 'fold'` and a REBUILD_KEYS entry are caught without a hint that merely mentions folds tripping it. Template literals are left intact, because in glsl.js the template literal IS the shader.
//
// The `u_` prefix is folded into the identifier pattern rather than being listed as a separate key, because `u_fold` in the GLSL is not a different mistake from `fold` in the schema -- it is the same removal, half-finished.

const REMOVED_KEYS = ['fold', 'foldFreq', 'shear', 'rows']
const REMOVED_FROM = ['src/aurora-cards/params.js', 'src/aurora-cards/presets.js', 'src/aurora-cards/glsl.js']

// Blanked, not deleted: every replacement is the same length as what it replaced, so an offset in the scanned text is still an offset in the file on disk.
const blankRun = (m) => m.replace(/[^\n]/g, ' ')
const blankComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, blankRun).replace(/\/\/[^\n]*/g, blankRun)
const blankQuoted = (src) => src.replace(/'[^'\n]*'/g, (m) => `'${' '.repeat(m.length - 2)}'`)
const lineOf = (src, i) => src.slice(0, i).split('\n').length

for (const rel of REMOVED_FROM) {
  const raw = readIfPresent(rel)
  if (!raw) { check(false, `${rel} can be read for the cut-key scan`); continue }
  const code = blankComments(raw)
  const bare = blankQuoted(code)

  // The blanking above pairs quotes off left to right, so one unescaped apostrophe inside a hint would shift the pairing for the rest of that line and the identifier pass could read prose. That is a warning and not a failure, because it makes the scan below less trustworthy rather than wrong, and because failing the gate over an apostrophe would be a worse bug than the one it is guarding.
  const odd = code.split('\n').map((l, i) => [(l.match(/'/g) || []).length, i + 1]).filter(([n]) => n % 2).map(([, n]) => n)
  if (odd.length) warn(`${rel}: ${odd.length} line(s) with an unpaired quote -- the cut-key scan may misread prose there`, `line ${odd.slice(0, 5).join(', ')}`)

  for (const key of REMOVED_KEYS) {
    const hits = []
    const ident = new RegExp(`(?<![A-Za-z0-9_$])(?:u_)?${key}(?![A-Za-z0-9_$])`, 'g')
    for (let m = ident.exec(bare); m; m = ident.exec(bare)) hits.push(`line ${lineOf(bare, m.index)}: ${m[0]}`)
    const quoted = new RegExp(`(['"])${key}\\1`, 'g')
    for (let m = quoted.exec(code); m; m = quoted.exec(code)) hits.push(`line ${lineOf(code, m.index)}: ${m[0]}`)
    check(hits.length === 0, `${rel}: no trace of the cut \`${key}\``, hits.join('; '))
  }
}

// ===========================================================================
console.log('\n--- both shaders compile, and the pair links -------------------')
// ===========================================================================
//
// The hole this closes: NOTHING in `npm run check` has ever linked a shader for this technique. The design doc records a duplicate declaration that shipped, was never linked, and survived a full gate run plus a round of retuning -- because every other check in this file is a textual scan, and a textual scan cannot tell a working shader from one the driver will reject. `vite build` will not catch it either: to vite these are string literals.
//
// There is no WebGL in node, so this reconstructs what three actually hands the driver -- the ShaderMaterial prologue, the spliced-in noise and palette blocks, and the resolved #includes -- writes both stages to a temp directory, and runs a real GLSL ES 3.00 front end over them.
//
// Two invocations, and both earn their place:
//
//   COMPILE (-S vert / -S frag) catches everything inside one stage: a missing semicolon, an undeclared identifier, a redeclaration, a call with the wrong argument count.
//
//   LINK (-l vert frag) catches what neither stage can see alone. A varying declared `vec2` in the vertex stage and `vec3` in the fragment stage compiles CLEAN twice over -- each stage is internally consistent -- and fails only when the two are linked. That is not a theoretical risk here: vA and vB are PACKED varyings whose components mean different things in different slots, and what each slot means is recorded in a COMMENT rather than in the type system. A half-landed repack is exactly the shape of mistake that produces this.

const VALIDATOR = 'glslangValidator'

// glslang is a native binary, not something npm can install, and making the whole check suite refuse to run without `brew install glslang` would be a bad trade. check-shaders.mjs:26-34 makes the same call. The difference is that compiling shaders is the WHOLE job of check-shaders.mjs, so it can `process.exit(0)` on a miss; here it is one section among a dozen and more, and everything else in this file still has work to do. So this section alone degrades to a printed SKIP, recorded in `skipped` so the summary line at the bottom says so.
const haveValidator = (() => {
  const probe = spawnSync(VALIDATOR, ['--version'], { encoding: 'utf8' })
  return probe.error == null && probe.status === 0
})()

if (!haveValidator) {
  console.log(' SKIP  glslangValidator is not on PATH (brew install glslang)')
  console.log('        the two card shaders were NOT compiled and were NOT linked this run')
  skipped.push('shader compile + link (no glslangValidator)')
} else {
  // three is imported here rather than at the top of the file for the same reason the aurora-cards modules are: no import happens until the checks that can run off the filesystem have already printed.
  const THREE = await import('three')

  // Same helper shape as check-shaders.mjs:137. CARD_FRAG ends on `#include <colorspace_fragment>`, and an unresolved #include is a compile error, so the chunk has to be spliced in exactly the way WebGLProgram.js does it.
  const CHUNK = THREE.ShaderChunk
  const resolveIncludes = (src, depth = 0) => {
    if (depth > 16) throw new Error('#include recursion')
    return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name) => {
      const c = CHUNK[name]
      if (c === undefined) throw new Error(`unknown chunk <${name}>`)
      return resolveIncludes(c, depth + 1)
    })
  }

  const PRECISION = [
    'float', 'int', 'sampler2D', 'samplerCube', 'sampler3D', 'sampler2DArray',
    'sampler2DShadow', 'samplerCubeShadow', 'sampler2DArrayShadow',
    'isampler2D', 'isampler3D', 'isamplerCube', 'isampler2DArray',
    'usampler2D', 'usampler3D', 'usamplerCube', 'usampler2DArray',
  ].map((t) => `precision highp ${t};`).join('\n') + '\n#define HIGH_PRECISION'

  // ---------------------------------------------------------------------
  // WHY THIS PROLOGUE IS NOT THE ONE IN check-shaders.mjs. Read this before
  // copying F_PRE across from the file next door.
  //
  // That file's F_PRE deliberately OMITS `layout(location = 0) out highp vec4
  // pc_fragColor;` and `#define gl_FragColor pc_fragColor`, because every
  // shader it checks is built with `glslVersion: THREE.GLSL3`, and three skips
  // both lines in that case -- see node_modules/three/build/three.cjs ~65211-65215,
  // where each is written `parameters.glslVersion === GLSL3 ? '' : ...`. Those
  // shaders declare their own `out` and write it by name.
  //
  // src/aurora-cards/curtains.js builds a plain `new THREE.ShaderMaterial({...})`
  // with NO glslVersion, so three DOES emit both lines for us, and CARD_FRAG
  // relies on it: it writes `gl_FragColor` and then `#include
  // <colorspace_fragment>`, which writes gl_FragColor again through
  // linearToOutputTexel. Take F_PRE from next door and CARD_FRAG stops
  // compiling here for a reason that has nothing to do with CARD_FRAG. Worse
  // is the other direction: add the two lines to a GLSL3 shader and it passes
  // here while the browser rejects it as a duplicate output declaration. The
  // prologue has to match the material it is standing in for, one file at a
  // time.
  //
  // linearToOutputTexel and the colorspace helpers are generated by
  // WebGLProgram's getTexelEncodingFunction rather than living in a chunk, so
  // they are reproduced for the default (no output colour space conversion
  // beyond sRGB transfer) case.
  //
  // #define DOUBLE_SIDED because curtains.js sets `side: THREE.DoubleSide`
  // (three.cjs:65149). No USE_FOG, because it sets `fog: false` -- and both of
  // those are asserted as literal strings by the emitter section above, so if
  // one of them changes there this prologue is wrong and nothing will say so.
  // ---------------------------------------------------------------------
  const COLOR_FNS = [
    CHUNK.colorspace_pars_fragment,
    'vec4 linearToOutputTexel( vec4 value ) {',
    '\treturn sRGBTransferOETF( vec4( value.rgb * mat3( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ), value.a ) );',
    '}',
    'float luminance( const in vec3 rgb ) {',
    '\tconst vec3 weights = vec3( 0.2126, 0.7152, 0.0722 );',
    '\treturn dot( weights, rgb );',
    '}',
  ].join('\n')

  const V_PRE = `#version 300 es
#define attribute in
#define varying out
#define texture2D texture
${PRECISION}
#define SHADER_TYPE ShaderMaterial
#define SHADER_NAME
#define DOUBLE_SIDED
uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat3 normalMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
`

  const F_PRE = `#version 300 es
#define varying in
layout(location = 0) out highp vec4 pc_fragColor;
#define gl_FragColor pc_fragColor
#define gl_FragDepthEXT gl_FragDepth
#define texture2D texture
#define textureCube texture
#define texture2DProj textureProj
#define texture2DLodEXT textureLod
#define texture2DProjLodEXT textureProjLod
#define textureCubeLodEXT textureLod
#define texture2DGradEXT textureGrad
#define texture2DProjGradEXT textureProjGrad
#define textureCubeGradEXT textureGrad
${PRECISION}
#define SHADER_TYPE ShaderMaterial
#define SHADER_NAME
#define DOUBLE_SIDED
uniform mat4 viewMatrix;
uniform vec3 cameraPosition;
uniform bool isOrthographic;

${COLOR_FNS}
`

  // The SPLICED vertex shader, not the raw literal. curtains.js:95-98 assembles exactly this string, and the raw literal is not a program: `/* GLSL_INCLUDES */` is where UTIL, HASH, VALUE and PALETTE go, and without them every noise and palette call in CARD_VERT is an undeclared function. Compiling the unspliced literal would be compiling something that never runs, and it would fail for reasons that are not bugs.
  let stagePrep = ''
  let stages = []
  try {
    const noise = await import('../src/aurora-lab/glsl/noise.js')
    const palette = await import('../src/aurora-lab/glsl/palette.js')
    const splicedVert = CARD_VERT.replace(
      '/* GLSL_INCLUDES */',
      noise.UTIL_GLSL + noise.HASH_GLSL + noise.VALUE_GLSL + palette.PALETTE_GLSL,
    )
    // A .replace that matches nothing returns the string unchanged and throws nothing, so the marker moving or being renamed would silently downgrade this into a check of the unspliced literal.
    check(splicedVert !== CARD_VERT, 'CARD_VERT still carries the `/* GLSL_INCLUDES */` marker curtains.js splices into',
      splicedVert === CARD_VERT ? 'the marker is gone -- this section would have compiled the unspliced literal' : `${CARD_VERT.split('\n').length} lines of literal, ${splicedVert.split('\n').length} once the noise and palette blocks are in`)
    stages = [
      ['CARD_VERT', 'vert', V_PRE, resolveIncludes(splicedVert)],
      ['CARD_FRAG', 'frag', F_PRE, resolveIncludes(CARD_FRAG)],
    ]
  } catch (e) {
    stagePrep = e.message
  }
  check(stagePrep === '', 'the shader sources assemble the way curtains.js assembles them', stagePrep)

  if (stages.length) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cards-'))
    const written = {}
    let compiled = 0

    for (const [name, stage, pre, body] of stages) {
      const full = pre + body
      const file = path.join(tmpDir, `${name}.${stage}`)
      fs.writeFileSync(file, full)
      written[stage] = file
      const run = spawnSync(VALIDATOR, ['-S', stage, file], { encoding: 'utf8' })
      const out = (run.stdout || '') + (run.stderr || '')
      const ok = run.error == null && run.status === 0
      if (ok) compiled++
      // The temp file path is printed on success as well as failure. For the vertex stage that file is the ONLY copy of the spliced text that exists anywhere -- there is no file in the repo whose line 400 is the line the validator is complaining about.
      check(ok, `${name} compiles as GLSL ES 3.00`, `${file}`)
      if (ok) continue
      const lines = full.split('\n')
      const preLines = pre.split('\n').length - 1
      for (const line of out.split('\n')) {
        const m = /^ERROR: \d+:(\d+)/.exec(line)
        if (!m) continue
        const n = Number(m[1])
        // Reported against the LITERAL's own line numbers, not the concatenated file's, because the concatenated number is not something anyone can go and edit. Same arithmetic as check-shaders.mjs:440. For CARD_VERT "the literal" means the SPLICED source -- everything up to the splice point still lines up with glsl.js, and everything after it is offset by the noise and palette blocks, which is exactly why the temp file is printed above.
        const own = n - preLines
        console.log(`        ${line.trim()}`)
        if (lines[n - 1] !== undefined) console.log(`          line ${own} of ${name}: ${lines[n - 1].trim()}`)
      }
    }

    // The link. Kept as a real invocation rather than the regex varying-comparison check-shaders.mjs falls back to (there, the two stages come out of onBeforeCompile and there is no honest pair of files to hand the linker). Here there is, so this is the actual GLSL linker deciding, which means it also catches the cross-stage mistakes a regex over `varying|in|out` declarations would never think to look for.
    if (compiled === stages.length) {
      const link = spawnSync(VALIDATOR, ['-l', written.vert, written.frag], { encoding: 'utf8' })
      const out = (link.stdout || '') + (link.stderr || '')
      const ok = link.error == null && link.status === 0
      check(ok, 'CARD_VERT and CARD_FRAG link as a program -- every varying agrees across the stage boundary',
        ok ? `${path.basename(written.vert)} + ${path.basename(written.frag)}` : '')
      if (!ok) {
        for (const line of out.split('\n')) {
          if (line.trim() && !/^(Warning|glslangValidator|\s*$)/.test(line)) console.log(`        ${line.trim()}`)
        }
        console.log('        why: each stage compiled clean on its own, so this is a disagreement that only exists in the PAIR -- almost always a varying whose type or name changed on one side of the boundary and not the other. vA and vB are packed, and what each component means lives in a comment, so a repack that lands in one stage and not the other looks exactly like this.')
      }
    } else {
      console.log('        (link not attempted -- a stage that does not compile cannot link)')
    }
  }
}

// ===========================================================================
console.log('\n--- every uniform the GLSL reads is one something writes -------')
// ===========================================================================
//
// The lab GENERATES its uniform block from the schema, so its two lists cannot disagree. glsl.js declares them BY HAND, so they can, and this is the direction that goes unnoticed.
//
// The other direction is already covered at runtime: curtains.js throws at construction if a `uniform: true` param appears nowhere in the shader source, so a param with no uniform behind it fails loudly on the first load of the page. This direction fails silently. GLSL happily compiles a reference to a declared uniform nothing ever sets, and an unset uniform reads as ZERO, so the term it controls is either switched off or scaled to nothing. There is no error, no warning, and no visible tell beyond a feature that does not work.
//
// Scanned over CARD_VERT and CARD_FRAG only, and NOT over the spliced shader. The shaders also splice in UTIL_GLSL, HASH_GLSL, VALUE_GLSL and PALETTE_GLSL from src/aurora-lab/glsl/, and the palette block alone reads ten u_ names of its own. Those are all real schema keys and would pass, but scanning them here would quietly turn this into a gate on the lab's palette module, which belongs to check-aurora-lab.mjs.

// The three synthetic uniforms, allow-listed by name rather than by prefix. None is a slider: u_time is the frame clock, u_kmToWorld is the CPU-side kilometre scale handed to the shader so the vertex shader can place a card in world units, and u_fieldScale converts arc length in kilometres into the field units the raymarch's along-channel terms were tuned in. u_fieldScale is a schema key as well, but with `uniform: false` -- it is a REBUILD key, so it can only change on a re-trace, which is where curtains.js writes it. Named explicitly so a FOURTH synthetic uniform added later has to be added here too, rather than being silently exempted by a pattern.
const SYNTHETIC_UNIFORMS = new Set(['u_time', 'u_kmToWorld', 'u_fieldScale'])

const writable = new Set([...SYNTHETIC_UNIFORMS, ...params.filter((p) => p.uniform === true).map((p) => `u_${p.key}`)])

for (const [name, src] of [['CARD_VERT', CARD_VERT], ['CARD_FRAG', CARD_FRAG]]) {
  const read = new Set(stripComments(src || '').match(/\bu_[A-Za-z0-9_]+/g) || [])
  const orphan = [...read].filter((u) => !writable.has(u)).sort()
  check(orphan.length === 0, `${name}: every u_ name it reads is a uniform param or a synthetic`,
    orphan.length ? `${orphan.join(', ')} -- read by the shader, written by nothing, so each one is silently zero` : `${read.size} uniform(s) read`)
}

// ===========================================================================
console.log('\n--- all structure is vertical ---------------------------------')
// ===========================================================================
//
// design/13-aurora-and-sky.md, §"What an aurora actually is", point 2: "All structure is vertical. The rays are field lines. This is the constraint that decides both shaders: the noise that generates striations must be indexed on distance ALONG the arc and must NOT contain an altitude term. One character's worth of mistake there and the whole thing stops being an aurora and becomes coloured fog."
//
// In this technique that constraint is enforced by ARCHITECTURE rather than by discipline: the gate, the patchiness, the rays, the flow, the caustic, the slow swath fade and the fine pulse flicker are all computed in the VERTEX shader, from `along` and `id`, precisely because a vertex there has no altitude to reach for. This gate is what stops someone helpfully passing one in.
//
// The list below is the whole point of this section and it is meant to GROW. Every new along-channel modulation is subject to the same rule for the same reason, so adding one to the shader without adding its name here leaves it unpoliced, and the term added tomorrow is exactly the one nobody remembers is load-bearing. `swath` and `pulse` are the newest two: a slow large-scale fade of whole stretches of a channel, and a fine chaotic flicker built from two value noises drifting at incommensurate rates. Both are functions of where you are ALONG the channel and of when it is, and of nothing else -- give either an altitude term and a stretch of curtain fades or flickers at one height while the height above it does not, which is a cloud, not a field line.
//
// Matched on ASSIGNMENTS rather than on declarations, because these terms are all declared with a neutral default and then computed inside a conditional. Anchoring on `float ray =` would read `float ray = 1.0;` and pass without ever seeing the expression the assertion exists to police.
//
// And matched on whole STATEMENTS rather than on lines, which is not a refinement -- it is the difference between an assertion and a decoration. Two things defeat a line scan here and both are already in the shader. `swath = mix( 1.0,` wraps, so a line scan reads the half with no noise in it and pronounces it clean. `gate` is written with `*=`, which `gate\\s*=` does not match AT ALL, so the only line a line scan ever found for it was `float gate = 1.0;` -- the assertion was passing on a literal, for both of the terms whose expression it most needed to read.
//
// One further hop: the statements a term's expression DEPENDS ON are pulled in too, transitively, because `pulse = mix( 1.0, pa * pb * 3.4, u_pulseAmt )` names no noise of its own -- the two lookups are computed into `pa` and `pb` a line earlier, and an altitude smuggled into either is an altitude in `pulse`. The closure stops at names that ARE the height (vv, altKm, hCol): their own definitions are legitimately about altitude, and following them would make every term red.
//
// What this still cannot see, stated because a check whose limits are not written down gets trusted past them: an altitude that arrives through a GLSL function rather than through a named local, and anything at all in the fragment shader, where an altitude is in scope by construction. The architecture is what covers the second -- these terms are in the vertex shader so there is nothing to reach for -- and this check is what keeps them there.
//
// A term that is never assigned at all fails too, and that is not incidental. If `swath` is not in CARD_VERT it is either in the fragment shader, where it has an altitude in scope, or it has quietly stopped existing -- and both are things this file should say out loud rather than pass over.

const WHY_VERTICAL = [
  '        why: design/13-aurora-and-sky.md states that all auroral structure is vertical, because the rays ARE magnetic field lines. A field line is a column, so every term that varies ALONG the channel must have the same value all the way up that column. Give one of them an altitude term and neighbouring altitude slices decorrelate: the striations stop running up the curtain, the silhouette stops being a sheet, and the sky reads as coloured fog. It still renders, it still looks like something, and it is no longer an aurora.',
  '        These terms live in the vertex shader for exactly this reason -- a vertex has no altitude in scope to reach for. If one of them now mentions vv, altKm, hCol or position.y, whether in its own statement or in a local it is computed from, then either the term moved to the fragment shader or an altitude got passed in as a varying. Both undo the design.',
].join('\n')

const vert = stripComments(CARD_VERT || '')
const HEIGHT = /\bvv\b|\baltKm\b|\bhCol\b|position\.y/

// The list is meant to grow: add an along-channel term to the shader, add its name here. Nothing else in this file will notice if you do not.
const ALONG_TERMS = ['gate', 'ray', 'flow', 'caus', 'swath', 'pulse']

// Every `name <op>= expression;` in the shader, indexed by the name it writes. `[-+*/]?=` so compound assignment is caught, and `(?!=)` so `==`, `>=` and `<=` are not.
const ASSIGN = /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*(?:[-+*/]?=)(?!=)[\s\S]*?;/g
const assignedIn = new Map()
for (let m = ASSIGN.exec(vert); m; m = ASSIGN.exec(vert)) {
  const name = m[1]
  if (!assignedIn.has(name)) assignedIn.set(name, [])
  assignedIn.get(name).push(m[0].replace(/\s+/g, ' ').trim())
}

// Every statement `term` is computed from, following named locals one hop at a time. Bounded by the visited set rather than by a depth limit, because the shader has no loops and the set of locals is small.
const computedFrom = (term) => {
  const seen = new Set([term])
  const queue = [term]
  const out = []
  while (queue.length) {
    const name = queue.shift()
    for (const stmt of assignedIn.get(name) || []) {
      out.push([name, stmt])
      for (const id of stmt.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        if (seen.has(id) || !assignedIn.has(id) || HEIGHT.test(id)) continue
        seen.add(id)
        queue.push(id)
      }
    }
  }
  return out
}

let verticalBad = 0
for (const term of ALONG_TERMS) {
  const stmts = computedFrom(term)
  // The owning name is printed alongside the statement because it is the whole answer when the altitude arrived through a temporary: `pulse` is red, but the line to open is the one that computes `pa`.
  const bad = stmts.filter(([, s]) => HEIGHT.test(s)).map(([n, s]) => `via ${n}: ${s}`)
  const ok = stmts.length > 0 && bad.length === 0
  if (!ok) verticalBad++
  check(ok, `CARD_VERT: \`${term}\` is indexed on the channel, not on height`,
    stmts.length === 0
      ? 'term never assigned in CARD_VERT -- it has either moved to the fragment shader or stopped existing'
      : bad.join('   /   '))
}
if (verticalBad) console.log(WHY_VERTICAL)

// ===========================================================================
console.log('\n--- the domain warp does not run on the GPU --------------------')
// ===========================================================================
//
// The whole argument for this technique is that the expensive multi-octave warp is evaluated once per grid cell on the CPU instead of once per pixel per march step on the GPU. A single call to warp2, gfbm2 or gnoise2 in either shader and that argument has collapsed while the picture stays identical, which means nothing will ever tell you except the frame time on a headset.
//
// Checked as a CALL, name followed by an open paren, so a comment that has been stripped anyway and a uniform named after one of them do not trip it.

for (const [name, src] of [['CARD_VERT', CARD_VERT], ['CARD_FRAG', CARD_FRAG]]) {
  check(typeof src === 'string' && src.length > 0, `${name} is a non-empty GLSL string`, `${typeof src}`)
  const body = stripComments(src || '')
  for (const fn of ['warp2', 'gfbm2', 'gnoise2']) {
    const hits = (body.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) || []).length
    check(hits === 0, `${name} does not call \`${fn}\` -- the warp is CPU work`,
      hits ? `${hits} call(s); the cost argument for this whole technique is that this runs once on the CPU, not per pixel` : '')
  }
}

// ===========================================================================
console.log('\n--- the CPU field is a faithful port ---------------------------')
// ===========================================================================
//
// field.js is a hand port of the lab's GLSL noise into JS, and a hand port is exactly where a smoothstep gets dropped or a fract goes missing. None of that throws. What it does is shift the value range, and a noise basis whose range is not 0..1 any more feeds a potential whose contours land somewhere else entirely, which reads as "the tuning stopped transferring" rather than as a bug.

for (const name of ['hash21', 'vnoise2', 'gnoise2', 'gfbm2', 'warp2', 'phi']) {
  check(typeof MODULES[name] === 'function', `field.js exports \`${name}\``, typeof MODULES[name])
}
check('warpX' in NS['field.js'] && 'warpY' in NS['field.js'], 'field.js exports the warpX/warpY out-parameters')

// A grid rather than random samples, so a failure is reproducible and the coordinates in the message mean something. Deliberately not axis-aligned to the integer lattice: gradient noise is exactly zero at every lattice point, so a grid on the integers would pass a completely broken implementation.
const SAMPLES = []
for (let i = 0; i < 18; i++) {
  for (let j = 0; j < 18; j++) SAMPLES.push([i * 0.7331 - 5.5, j * 0.6173 - 4.25])
}

const rangeCheck = (fn, name) => {
  if (typeof fn !== 'function') return
  const bad = []
  for (const [x, y] of SAMPLES) {
    const v = fn(x, y)
    if (!Number.isFinite(v) || v < 0 || v > 1) bad.push(`(${x.toFixed(2)}, ${y.toFixed(2)}) -> ${v}`)
  }
  check(bad.length === 0, `${name} stays inside [0, 1] over ${SAMPLES.length} samples`,
    bad.length ? `${bad.length} outside, first: ${bad[0]}` : '')
}

rangeCheck(hash21, 'hash21')
rangeCheck(vnoise2, 'vnoise2')
rangeCheck(gnoise2, 'gnoise2')
rangeCheck(gfbm2, 'gfbm2')

// A noise that returns the same number everywhere is inside [0, 1] and passes the check above, so the spread is asserted separately. This is what a dropped hash looks like.
for (const [fn, name] of [[vnoise2, 'vnoise2'], [gnoise2, 'gnoise2'], [gfbm2, 'gfbm2']]) {
  if (typeof fn !== 'function') continue
  const vals = SAMPLES.map(([x, y]) => fn(x, y))
  const spread = Math.max(...vals) - Math.min(...vals)
  check(spread > 0.05, `${name} actually varies across the grid`, `spread ${spread.toFixed(4)}`)
}

// warp2 has no return value: it writes the warped coordinate into the module-level warpX/warpY, which is the JS stand-in for GLSL's out parameters and is the one part of the port with no natural place for a mistake to show up.
if (typeof warp2 === 'function' && defs) {
  warp2(1.3, -0.7, 0.5, defs.leyWarp, defs.leyWarpFreq, defs.warpStages)
  const wx = NS['field.js'].warpX
  const wy = NS['field.js'].warpY
  const moved = wx !== 1.3 || wy !== -0.7
  check(Number.isFinite(wx) && Number.isFinite(wy) && moved,
    'warp2 writes warped, finite coordinates into warpX/warpY',
    moved ? `(${wx}, ${wy})` : `(${wx}, ${wy}) is the input unmoved -- the warp did nothing`)
}

// The potential itself. A constant phi means every contour level either finds nothing or finds the whole plane, so marching squares returns no polylines and the sky is simply empty -- a blank page with no error anywhere, which is worth catching for the price of 324 evaluations.
if (typeof phi === 'function' && defs) {
  const vals = []
  let threw = ''
  try {
    for (const [x, y] of SAMPLES) vals.push(phi(x, y, 0, defs))
  } catch (e) {
    threw = e.message
  }
  check(threw === '', 'phi evaluates against defaults() without throwing', threw)
  if (threw === '') {
    const nonFinite = vals.filter((v) => !Number.isFinite(v)).length
    check(nonFinite === 0, 'phi returns a finite number everywhere', `${nonFinite} of ${vals.length} not finite`)
    const spread = Math.max(...vals) - Math.min(...vals)
    check(spread > 1e-6, 'and is not constant, so there is something for marching squares to trace', `spread ${spread}`)
  }
}

// ===========================================================================
console.log('\n--- the trace finds real geometry at the shipped defaults ------')
// ===========================================================================
//
// The most valuable runtime check available, and the only one here that exercises the actual pipeline rather than the schema around it. Everything above can pass with a sky that is completely empty: phi can vary beautifully and still have its whole range fall between two integer contour levels, in which case marching squares visits every cell, finds nothing, and returns zero polylines. No error anywhere, just a black sky, and the first place anyone would look is the shader.
//
// This does a full grid pass at the default resolution, so it is timed. The number is printed on success as well as failure: gridN is a slider, someone will raise it, and a trace that has crept from tens of milliseconds into the hundreds is a frame hitch on every rebuild that nobody would otherwise see until they dragged a slider on a headset.

if (typeof traceContours === 'function' && defs) {
  let result = null
  let threw = ''
  const t0 = Date.now()
  try {
    result = traceContours(defs)
  } catch (e) {
    threw = e.message
  }
  const ms = Date.now() - t0
  check(threw === '', `traceContours runs against defaults() without throwing`, threw || `${ms} ms`)

  if (result) {
    const { lines, stats } = result
    check(Array.isArray(lines) && lines.length > 0, 'and finds contours at all', `${(lines || []).length} polyline(s)`)

    // Printed rather than asserted against a threshold, because the right component count is a tuning decision and pinning it would make every tuning change a gate failure. What it is here for is the log: a commit that halves the component count is visible in a diff of two runs, which is the cheapest regression signal this file can offer.
    console.log(`        stats: ${JSON.stringify(stats)}`)
    console.log(`        traced in ${ms} ms`)

    // The three arrays are parallel and they are consumed as parallel by cards.js: it walks arc, indexes pts at 2i, and indexes grad at i. A length disagreement is a read past the end of a Float32Array, which in JS is `undefined` rather than a crash, and `undefined` in the arithmetic downstream makes a NaN vertex. A NaN vertex takes the entire draw call with it, so ONE bad line blanks the whole sky.
    const badShape = []
    const badNumber = []
    for (let i = 0; i < (lines || []).length; i++) {
      const l = lines[i]
      if (!l || !l.pts || !l.arc || !l.grad) { badShape.push(`line ${i}: missing pts/arc/grad`); continue }
      if (l.pts.length !== l.arc.length * 2) badShape.push(`line ${i}: ${l.pts.length} pts for ${l.arc.length} arc entries`)
      if (l.grad.length !== l.arc.length) badShape.push(`line ${i}: ${l.grad.length} grad for ${l.arc.length} arc entries`)
      if (badNumber.length === 0) {
        for (let k = 0; k < l.pts.length; k++) if (!Number.isFinite(l.pts[k])) { badNumber.push(`line ${i} pts[${k}]`); break }
        for (let k = 0; k < l.arc.length; k++) if (!Number.isFinite(l.arc[k])) { badNumber.push(`line ${i} arc[${k}]`); break }
      }
    }
    check(badShape.length === 0, 'every line has pts, arc and grad in lockstep',
      badShape.length ? `${badShape.length} bad: ${badShape.slice(0, 3).join('; ')}` : `${(lines || []).length} line(s) consistent`)
    check(badNumber.length === 0, 'and every coordinate and arc length is finite -- one NaN vertex blanks the whole draw',
      badNumber.join(', '))

    // One level is a single band, not a family. It means the potential's range has collapsed to under two integers, so there is nothing for the contours to branch BETWEEN, and branching between neighbouring levels is the entire reason this technique exists rather than a deformed mesh.
    check(stats && stats.levels >= 2, 'the potential spans at least two contour levels',
      `${stats ? stats.levels : '?'} level(s) over phi range ${stats ? JSON.stringify(stats.phiRange) : '?'}`)

    check(stats && stats.totalKm > 0, 'and the contours have real length on the ground',
      `${stats ? stats.totalKm.toFixed(1) : '?'} km total`)
  }
}

// A skip does not fail the gate, but it does change what "passed" is allowed to claim: a bare ALL CHECKS PASSED after a section never ran reads as a compile that succeeded, which is the exact false reassurance this file exists to prevent.
const tail = skipped.length ? `  (${skipped.length} SECTION(S) SKIPPED: ${skipped.join('; ')})` : ''
console.log(failures ? `\n${failures} CHECK(S) FAILED${tail}` : `\n${skipped.length ? 'ALL CHECKS THAT RAN PASSED' : 'ALL CHECKS PASSED'}${tail}`)
process.exit(failures ? 1 : 0)
