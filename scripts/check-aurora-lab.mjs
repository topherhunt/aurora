// ---------------------------------------------------------------------------
// Gate for /test-aurora, the raymarched-aurora shader lab.
//
// There is no GL context in node and no headless-gl in this project, so nothing
// here compiles a shader -- the same limitation every other shader gate in
// scripts/ works under. That is a smaller loss here than it sounds, because the
// highest-value invariants in this design are TEXTUAL, and a compiler would not
// catch most of them anyway:
//
//   1. THE SLIDER THAT MOVES NOTHING. The param schema exists so the uniform
//      block is GENERATED rather than hand-written, and the whole point of
//      generating it is that the two lists cannot disagree. That guarantee is
//      only real in one direction -- a param always gets a uniform -- and the
//      other direction is where the afternoon goes: GLSL that references
//      `u_something` no param declares. On a GPU that is a named compile error,
//      which is loud; in node it is nothing at all, so it is asserted here
//      instead. The reverse, a declared uniform no line reads, compiles fine
//      forever and is a dead slider, so it is reported as a warning.
//
//   2. AN ALTITUDE TERM IN A NOISE LOOKUP. The aurora is field-aligned: the
//      striations run ALONG the magnetic field lines, which is why
//      `auroraField` takes a plan vec2 and no height, and why every per-sample
//      term in the march (ray, flow, ca, cb) is indexed on `along`/`id` alone.
//      Add a height term to any of them and the striations stop running up the
//      curtain, the structure decorrelates between neighbouring altitude
//      slices, and the whole sky reads as coloured fog. It is one identifier's
//      worth of mistake and it produces a picture, not an error.
//
//   3. A DITHER THAT MOVES. The march offsets its samples by a per-pixel hash
//      to hide the concentric shells a low step count leaves. Index that hash
//      on time as well and the banding is still gone, but what replaces it is
//      crawling film grain -- which on a desktop canvas reads as "a bit noisy"
//      and in a headset, at 72 Hz an inch from the eye, is unwatchable.
//
//   4. A DEFAULT OUTSIDE ITS OWN SLIDER RANGE. Presents as a slider that jumps
//      the instant it is touched, and it is never obvious that the number moved
//      because the schema was wrong rather than because you moved it.
//
//   5. A STUB HINT. Sixty sliders are usable only because every one of them
//      carries a sentence saying what it does and what it looks like when it is
//      wrong. The hint is not documentation for someone else -- it is what
//      stops the panel decaying -- so a placeholder hint fails the gate rather
//      than passing quietly.
//
//   6. A BACKTICK INSIDE A TEMPLATE LITERAL. design/lessons.md counts an hour
//      lost to this once already. Every chunk of GLSL in this subsystem lives
//      in a template literal.
//
//   7. A CHUNK EMITTED TWICE. screen.js emits the base chunks unconditionally
//      and then whatever the algorithm's `needs` list asks for, so a chunk can
//      legitimately arrive twice and the include guards are the only reason
//      that is free.
//
// What this can NOT check: whether the sky looks like an aurora. That needs
// eyes, and on a headset (§17).
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The lab modules are imported DYNAMICALLY, further down, and that is not a
// stylistic choice. A stray backtick in a GLSL chunk is a SyntaxError, and a
// static import of a file with a SyntaxError takes this whole script down with
// a stack trace before a single check has printed -- which is the least useful
// possible way to report the one failure mode the source scan exists to name.
// The source scan runs first, off the filesystem; the imports come after.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LAB = path.join(ROOT, 'src', 'aurora-lab')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const warn = (label, detail = '') => {
  console.log(` warn  ${label}${detail ? `   ${detail}` : ''}`)
}

// ===========================================================================
console.log('\n--- no backtick inside a template literal ----------------------')
// ===========================================================================
//
// See failure mode 6, and note that this runs FIRST: every other check in this
// file needs the lab modules loaded, and a stray backtick is the one fault that
// stops them loading at all.
//
// Two checks, and the crude one is kept even though the parse is strictly
// stronger, because they answer different questions. `node --check` says THE
// FILE DOES NOT PARSE and points at the line where the parser gave up, which is
// usually a long way from the backtick that closed the literal early. The
// backtick tally says WHICH FILE has an odd one and how many it has, which is
// the number you actually go looking with.
//
// What the tally alone would miss, and does miss in practice: two stray
// backticks in the same file pair up and pass. A GLSL comment written as
// `like this` is exactly that shape, and it closes the template literal early
// while leaving the count even. That is why the parse check is here.

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name)
  return e.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : []
})

const labFiles = walk(LAB)
check(labFiles.length >= 8, 'there are lab files to scan at all', `${labFiles.length} files`)

for (const file of labFiles) {
  const src = fs.readFileSync(file, 'utf8')
  const n = (src.match(/`/g) || []).length
  const rel = path.relative(ROOT, file)
  check(n % 2 === 0, `${rel}: backticks pair up`, `${n} backticks`)
  check(!src.includes('``'), `${rel}: and none of them are adjacent`)

  // Parsed, not executed: --check never runs module scope, so this is safe on
  // files that would touch the DOM or a GL context on import.
  const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  const why = (parsed.stderr || '').split('\n').filter((l) => /Error/.test(l))[0] || ''
  check(parsed.status === 0, `${rel}: parses as an ES module`, why.trim())
}

// ===========================================================================
// Everything below needs the modules. If the section above failed, they will
// not load, so say so plainly and stop rather than throwing a stack trace over
// the results that did print.
// ===========================================================================

let LAB_MODULES = null
try {
  LAB_MODULES = {
    ...(await import('../src/aurora-lab/algorithms.js')),
    ...(await import('../src/aurora-lab/presets.js')),
    ...(await import('../src/aurora-lab/glsl/noise.js')),
    ...(await import('../src/aurora-lab/glsl/palette.js')),
    ...(await import('../src/aurora-lab/glsl/frame.js')),
  }
} catch (e) {
  console.log(`\n FAIL  the lab modules do not load, so nothing below can be checked   ${e.message.split('\n')[0]}`)
  console.log(`\n${failures + 1} CHECK(S) FAILED`)
  process.exit(1)
}

const { ALGORITHMS, algorithmById, paramsFor, defaultsFor } = LAB_MODULES
const { BUILTIN_PRESETS } = LAB_MODULES
const { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL, FILAMENT_GLSL } = LAB_MODULES
const { PALETTE_GLSL, MARCH_GLSL, MAIN_GLSL } = LAB_MODULES

// ---------------------------------------------------------------------------
// The shader assembly, DUPLICATED FROM screen.js ON PURPOSE.
//
// screen.js imports three.js and builds a ShaderMaterial, which touches WebGL
// types that do not exist in node, so importing it here is not an option. The
// concatenation itself is pure string work, so it is replicated below.
//
// What breaks if the two drift: this gate goes on asserting things about a
// shader the page no longer builds. The realistic drift is a new chunk added to
// screen.js's CHUNKS map and not to this one -- it would be dropped from the
// assembly here, and any uniform only that chunk references would be reported
// as a dead slider by the reverse check. That is the tell to look for. The
// ordering rule (library order, not `needs` order) is replicated too, because
// GRAD and WARP call into each other and the order is load-bearing.
// ---------------------------------------------------------------------------

const CHUNKS = {
  util: UTIL_GLSL,
  hash: HASH_GLSL,
  value: VALUE_GLSL,
  grad: GRAD_GLSL,
  fbm: FBM_GLSL,
  warp: WARP_GLSL,
  filament: FILAMENT_GLSL,
}

const BASE_CHUNKS = ['util', 'hash', 'value', 'fbm']

const GLSL_TYPE = { float: 'float', color: 'vec3', bool: 'float', enum: 'int' }

function declarationsFor(params) {
  const lines = ['uniform float uTime;']
  for (const p of params) {
    if (p.uniform === false) continue
    lines.push(`uniform ${GLSL_TYPE[p.type]} u_${p.key};`)
  }
  return lines.join('\n')
}

function assemble(id) {
  const algo = algorithmById(id)
  const params = paramsFor(id)

  const wanted = []
  const unknown = []
  for (const name of [...BASE_CHUNKS, ...(algo.needs || [])]) {
    if (!CHUNKS[name]) unknown.push(name)
    else if (!wanted.includes(name)) wanted.push(name)
  }
  const ordered = Object.keys(CHUNKS).filter((n) => wanted.includes(n))

  // Everything that is not the generated uniform block. Split out so the
  // reference scan below cannot be satisfied by the declaration itself.
  const body = [
    'varying vec3 vWorld;',
    'varying vec2 vUv;',
    ...ordered.map((n) => CHUNKS[n]),
    PALETTE_GLSL,
    algo.glsl,
    MARCH_GLSL,
    MAIN_GLSL,
  ].join('\n')

  return { algo, params, unknown, decls: declarationsFor(params), body }
}

// Comments are stripped before any reference scan. Without this, a comment that
// names a uniform which was later renamed would fail the gate, and a comment
// that names a live uniform would hide a dead slider from the reverse check.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

// ===========================================================================
console.log('\n--- every uniform the GLSL references is declared --------------')
// ===========================================================================

for (const algo of ALGORITHMS) {
  const { params, unknown, decls, body } = assemble(algo.id)

  check(unknown.length === 0, `${algo.id}: every chunk in \`needs\` exists`, unknown.join(', '))

  const declared = new Set(
    [...decls.matchAll(/^uniform\s+\w+\s+(u_\w+);$/gm)].map((m) => m[1])
  )
  // uTime is declared by hand at the top of the block rather than by a param,
  // so it is not in the u_ namespace and is added to the set by name.
  const referenced = new Set(stripComments(body).match(/\bu_[A-Za-z0-9_]+/g) || [])

  const missing = [...referenced].filter((u) => !declared.has(u)).sort()
  check(
    missing.length === 0,
    `${algo.id}: no GLSL line reads a uniform no param declares`,
    missing.length ? missing.join(', ') : `${referenced.size} referenced, ${declared.size} declared`
  )

  // The other direction is a warning, not a failure. A declared-but-unread
  // uniform compiles perfectly and costs nothing on the GPU; what it costs is a
  // row in the sidebar that does nothing when you drag it. Not a failure
  // because a knob can legitimately be declared shared and used by only some
  // algorithms -- but every one of these is worth looking at.
  const dead = [...declared].filter((u) => !referenced.has(u)).sort()
  if (dead.length) warn(`${algo.id}: declared uniforms no GLSL line reads -- dead sliders`, dead.join(', '))
  else console.log(`  ok   ${algo.id}: every declared uniform is read by some GLSL line`)

  // The generated block has to actually be generated from the schema, or the
  // check above is comparing the shader against a list that is not the panel's.
  const uniformParams = params.filter((p) => p.uniform !== false)
  check(
    declared.size === uniformParams.length,
    `${algo.id}: one declaration per shader-facing param, and no more`,
    `${declared.size} declarations, ${uniformParams.length} params`
  )
}

// ===========================================================================
console.log('\n--- the field is aligned: no altitude anywhere in the lookup ---')
// ===========================================================================
//
// See failure mode 2 in the header. Two halves: the SIGNATURE, which is what
// makes a height term impossible to pass in without changing every call site,
// and the BODY, which is what makes it impossible to reconstruct one from the
// shared uniforms that do carry altitude.

const SIGNATURE = 'vec4 auroraField( vec2 p, float t )'

for (const algo of ALGORITHMS) {
  check(
    algo.glsl.includes(SIGNATURE),
    `${algo.id}: auroraField takes a plan vec2 and a time, and nothing else`,
    algo.glsl.includes('auroraField') ? '' : 'no auroraField at all'
  )
  // Exactly one, or a second overload could take a height and the string match
  // above would still pass.
  const defs = (algo.glsl.match(/vec4\s+auroraField\s*\(/g) || []).length
  check(defs === 1, `${algo.id}: and defines it exactly once`, `${defs} definitions`)

  for (const forbidden of ['altKm', 'u_altLow', 'u_altHigh']) {
    check(
      !algo.glsl.includes(forbidden),
      `${algo.id}: does not reach for \`${forbidden}\``,
      ''
    )
  }
}

// The frame's own per-sample terms, which is where the mistake is easiest to
// make because `altKm` and `k` are both in scope three lines above them.
// Matched on ASSIGNMENTS rather than on declarations, because these terms are
// now declared with a neutral default and then computed inside a uniform-valued
// `if` that switches the cost off with the effect. Anchoring on `float ray =`
// would read `float ray = 1.0;` and pass without ever seeing the expression the
// assertion exists to police.
const march = stripComments(MARCH_GLSL)
const HEIGHT = /\baltKm\b|\bu_altLow\b|\bu_altHigh\b|\bh01\b/
for (const term of ['ray', 'flow', 'ca', 'cb']) {
  const lines = march
    .split('\n')
    .filter((l) => new RegExp(`(^|[^\\w.])${term}\\s*=[^=]`).test(l))
  const bad = lines.filter((l) => HEIGHT.test(l))
  check(
    lines.length > 0 && bad.length === 0,
    `the march's \`${term}\` term is indexed on the channel, not on height`,
    lines.length === 0 ? 'term never assigned' : bad.join(' / ').trim()
  )
}

// ===========================================================================
console.log('\n--- the dither is a function of position and nothing else ------')
// ===========================================================================
//
// See failure mode 3 in the header. `t` is checked as a whole word: `u_dither`
// and `float` both contain the letter, and a substring match would fail on the
// correct line.

{
  const lines = MARCH_GLSL.split('\n').filter((l) => /\bdither\s*=[^=]/.test(l))
  check(lines.length === 1, 'the dither is assigned in exactly one place', `${lines.length} assignments`)
  const line = lines[0] || ''
  check(line.includes('gl_FragCoord'), 'and it is a hash of the fragment coordinate', line.trim())
  check(
    !/\bt\b/.test(line) && !/\buTime\b/.test(line),
    'and carries no time term, so the grain does not crawl',
    line.trim()
  )
}

// ===========================================================================
console.log('\n--- param schema integrity ------------------------------------')
// ===========================================================================

const KEY = /^[a-z][A-Za-z0-9]*$/
const TYPES = new Set(['float', 'color', 'bool', 'enum'])
// Long enough that a placeholder cannot reach it, short enough that a real
// one-sentence hint clears it comfortably. See failure mode 5.
const MIN_HINT = 40

for (const algo of ALGORITHMS) {
  let params = null
  let threw = ''
  try {
    params = paramsFor(algo.id)
  } catch (e) {
    threw = e.message
  }
  check(params !== null, `${algo.id}: paramsFor does not throw -- no duplicate keys`, threw)
  if (!params) continue

  const badKey = params.filter((p) => !p.key || !KEY.test(p.key))
  check(badKey.length === 0, `${algo.id}: every key is a plain lowerCamel identifier`,
    badKey.map((p) => String(p.key)).join(', '))

  const badLabel = params.filter((p) => !p.label || !p.label.trim())
  check(badLabel.length === 0, `${algo.id}: every param has a label`, badLabel.map((p) => p.key).join(', '))

  const badHint = params.filter((p) => !p.hint || p.hint.trim().length < MIN_HINT)
  check(badHint.length === 0,
    `${algo.id}: every hint says something -- at least ${MIN_HINT} characters`,
    badHint.map((p) => `${p.key} (${(p.hint || '').trim().length})`).join(', '))

  const badType = params.filter((p) => !TYPES.has(p.type))
  check(badType.length === 0, `${algo.id}: every type is one the shader can declare`,
    badType.map((p) => `${p.key}: ${p.type}`).join(', '))

  const floats = params.filter((p) => p.type === 'float')
  const badRange = floats.filter(
    (p) => !Number.isFinite(p.min) || !Number.isFinite(p.max) || !(p.min < p.max)
  )
  check(badRange.length === 0, `${algo.id}: every float slider has a finite min below its max`,
    badRange.map((p) => `${p.key} [${p.min}, ${p.max}]`).join(', '))

  const badStep = floats.filter((p) => !Number.isFinite(p.step) || !(p.step > 0))
  check(badStep.length === 0, `${algo.id}: and a positive step`,
    badStep.map((p) => `${p.key} step ${p.step}`).join(', '))

  // Failure mode 4: a slider that jumps the first time it is touched.
  const outside = floats.filter(
    (p) => !Number.isFinite(p.value) || p.value < p.min || p.value > p.max
  )
  check(outside.length === 0, `${algo.id}: and a default inside its own range`,
    outside.map((p) => `${p.key} ${p.value} not in [${p.min}, ${p.max}]`).join(', '))

  // defaultsFor is what the panel starts from and what `reset` restores, so a
  // key missing from it is a control with no value behind it.
  let defs = null
  let defThrew = ''
  try {
    defs = defaultsFor(algo.id)
  } catch (e) {
    defThrew = e.message
  }
  check(defs !== null, `${algo.id}: defaultsFor does not throw -- every override names a real param`, defThrew)
  if (!defs) continue

  const noDefault = params.filter((p) => !(p.key in defs))
  check(noDefault.length === 0, `${algo.id}: every param has a starting value`,
    noDefault.map((p) => p.key).join(', '))

  // Restated against the schema rather than trusting the throw above, so this
  // still says something if defaultsFor's own guard is ever loosened.
  const keys = new Set(params.map((p) => p.key))
  const strayOverride = Object.keys(algo.overrides || {}).filter((k) => !keys.has(k))
  check(strayOverride.length === 0, `${algo.id}: and every override lands on one of them`,
    strayOverride.join(', '))
}

// ===========================================================================
console.log('\n--- the builtin presets still load ----------------------------')
// ===========================================================================
//
// A builtin is a tuning that is checked in rather than saved into
// localStorage, because a reference you cannot get back on another machine, in
// another browser, or after clearing a profile is not a reference. The one that
// matters most is reference-v1, which is the sky every later performance
// change is measured against.
//
// The failure mode here is quiet and it arrives late. Someone adds a knob to
// SHARED_GROUPS; the panel is fine, because it starts from defaultsFor; a
// preset out of localStorage is fine, because whatever it does not state falls
// back to the default. reference-v1 is then one knob short of the sky that was
// pinned, and it still looks very nearly right, which is the worst possible
// version of this to discover halfway through an optimisation pass.
//
// So the covering check below is exact in BOTH directions, and it is the
// assertion in this section with teeth. A key defaultsFor has that the preset
// does not is a knob the preset silently stopped stating. A key the preset has
// that defaultsFor does not is a knob renamed or deleted out from under it,
// which is the same drift arriving from the other side.

const ALGO_IDS = new Set(ALGORITHMS.map((a) => a.id))

check(BUILTIN_PRESETS.length > 0, 'there is at least one builtin preset',
  `${BUILTIN_PRESETS.length} builtin(s)`)

// Names are the only handle the panel has on a builtin -- they are what the
// preset list shows, what the load path looks up, and what savePreset refuses.
// Two builtins sharing one means the second is unreachable.
const builtinNames = BUILTIN_PRESETS.map((p) => p.name)
const dupeName = builtinNames.filter((n, i) => builtinNames.indexOf(n) !== i)
check(dupeName.length === 0, 'no two builtins answer to the same name', dupeName.join(', '))

for (const preset of BUILTIN_PRESETS) {
  const id = preset.name || '(unnamed)'

  check(typeof preset.name === 'string' && preset.name.trim().length > 0,
    `${id}: has a name the panel can list it under`)

  // The note is the only place a builtin says what it is FOR, and the two here
  // are for very different things -- one is a reference, one is a cheap tier.
  // A builtin nobody can tell apart from the next one is a builtin nobody
  // reaches for.
  check(typeof preset.note === 'string' && preset.note.trim().length > 0,
    `${id}: says in a note what it is for`)

  check(ALGO_IDS.has(preset.algorithm), `${id}: names an algorithm that exists`,
    String(preset.algorithm))

  const values = preset.values
  const hasValues = !!values && typeof values === 'object' && !Array.isArray(values)
  check(hasValues, `${id}: carries a values object`)

  if (!hasValues || !ALGO_IDS.has(preset.algorithm)) continue

  const defs = defaultsFor(preset.algorithm)
  const missing = Object.keys(defs).filter((k) => !(k in values)).sort()
  check(missing.length === 0, `${id}: states a value for every knob the algorithm has`,
    missing.join(', '))

  const stray = Object.keys(values).filter((k) => !(k in defs)).sort()
  check(stray.length === 0, `${id}: and no value for a knob the schema no longer has`,
    stray.join(', '))

  // In range as well as present. A preset value outside its own slider range is
  // failure mode 4 arriving by a different route: the panel loads it, the first
  // touch of the slider clamps it, and the tuning quietly is not the tuning any
  // more.
  const bad = []
  for (const p of paramsFor(preset.algorithm)) {
    if (!(p.key in values)) continue
    const v = values[p.key]
    if (p.type === 'float') {
      if (!Number.isFinite(v) || v < p.min || v > p.max) {
        bad.push(`${p.key} ${JSON.stringify(v)} not in [${p.min}, ${p.max}]`)
      }
    } else if (p.type === 'color') {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => Number.isFinite(c))) {
        bad.push(`${p.key} ${JSON.stringify(v)} is not three numbers`)
      }
    } else if (p.type === 'enum') {
      // The sidebar accepts the option's own name as well as its index, because
      // a hand-written preset reads better that way, so both are in range here.
      const opts = p.options || []
      const i = typeof v === 'string' ? opts.indexOf(v) : v
      if (!Number.isInteger(i) || i < 0 || i >= opts.length) {
        bad.push(`${p.key} ${JSON.stringify(v)} is not one of ${opts.join(', ')}`)
      }
    }
  }
  check(bad.length === 0, `${id}: and every value is one the panel can take`, bad.join('; '))
}

// A builtin the page never imports is not a builtin, it is a comment with
// commas in it. Read as text rather than by importing test-aurora-main.js,
// which touches the DOM on load.
const mainRel = 'src/test-aurora-main.js'
const mainPath = path.join(ROOT, mainRel)
const mainSrc = fs.existsSync(mainPath) ? fs.readFileSync(mainPath, 'utf8') : ''

check(/from\s+['"]\.\/aurora-lab\/presets\.js['"]/.test(mainSrc),
  'the page imports the builtins from presets.js')
check(mainSrc.includes('BUILTIN_NAMES'),
  'and lists them by name, so every builtin can be selected')

// Lenient on purpose -- what matters is that the save path consults the builtin
// names at all, not the wording of the message it flashes. Letting a save
// shadow a builtin would mean reference-v1 quietly becoming whatever was last
// on the panel, which is the one thing the builtins exist to prevent.
const saveAt = mainSrc.indexOf("case 'savePreset'")
const saveEnd = mainSrc.indexOf("case '", saveAt + 1)
const saveCase = saveAt < 0 ? '' : mainSrc.slice(saveAt, saveEnd < 0 ? mainSrc.length : saveEnd)
check(saveAt >= 0, 'the page has a savePreset handler to guard')
check(/BUILTIN_NAMES/.test(saveCase),
  'and it refuses to save over a name a builtin already holds')

// ===========================================================================
console.log('\n--- every chunk carries its include guard ----------------------')
// ===========================================================================
//
// See failure mode 7. A chunk emitted twice without a guard is a redefinition
// error, which is exactly the kind of thing that only shows up once someone
// adds a chunk to a second algorithm's `needs` list.

const GUARDED = [
  ['UTIL_GLSL', UTIL_GLSL, 'AURLAB_UTIL'],
  ['HASH_GLSL', HASH_GLSL, 'AURLAB_HASH'],
  ['VALUE_GLSL', VALUE_GLSL, 'AURLAB_VALUE'],
  ['GRAD_GLSL', GRAD_GLSL, 'AURLAB_GRAD'],
  ['FBM_GLSL', FBM_GLSL, 'AURLAB_FBM'],
  ['WARP_GLSL', WARP_GLSL, 'AURLAB_WARP'],
  ['FILAMENT_GLSL', FILAMENT_GLSL, 'AURLAB_FILAMENT'],
  ['PALETTE_GLSL', PALETTE_GLSL, 'AURLAB_PALETTE'],
  ['MARCH_GLSL', MARCH_GLSL, 'AURLAB_MARCH'],
]

// The list above is written out rather than derived, so a new chunk added to
// noise.js is not silently exempt -- it fails the count below until someone
// puts it here.
const noiseSrc = fs.readFileSync(path.join(LAB, 'glsl', 'noise.js'), 'utf8')
const noiseExports = (noiseSrc.match(/^export const (\w+_GLSL)\b/gm) || []).map((m) => m.split(' ')[2])
const ungated = noiseExports.filter((n) => !GUARDED.some(([name]) => name === n))
check(ungated.length === 0, 'every chunk noise.js exports is in the guarded list', ungated.join(', '))

for (const [name, src, token] of GUARDED) {
  const ifndef = (src.match(new RegExp(`#ifndef\\s+${token}\\b`, 'g')) || []).length
  const define = (src.match(new RegExp(`#define\\s+${token}\\b`, 'g')) || []).length
  const opens = (src.match(/#ifndef\b/g) || []).length
  const closes = (src.match(/#endif\b/g) || []).length
  check(ifndef === 1 && define === 1, `${name}: guarded by ${token}`, `${ifndef} ifndef, ${define} define`)
  check(opens === closes, `${name}: and every #ifndef is closed`, `${opens} open, ${closes} #endif`)
}

// ===========================================================================
console.log('\n--- the page is wired -----------------------------------------')
// ===========================================================================
//
// A shader lab nobody can open is not a lab. Three files have to line up: the
// HTML entry point, its module, and the two places vite has to be told about a
// second page -- the dev server's bare-route rewrite (so /test-aurora works
// without the extension) and the rollup build input (so it survives `npm run
// build`). Getting one of the two vite entries and not the other gives a page
// that works in dev and vanishes from the build, which is the worst version of
// this to find out about late.

const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
check(exists('test-aurora.html'), 'test-aurora.html exists at the repo root')
check(exists('src/test-aurora-main.js'), 'src/test-aurora-main.js exists')

const viteSrc = exists('vite.config.js') ? fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8') : ''
const mentions = (viteSrc.match(/test-aurora/g) || []).length
check(mentions >= 2, 'vite.config.js names the page for both the dev rewrite and the build input',
  `${mentions} mention(s) of test-aurora`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
