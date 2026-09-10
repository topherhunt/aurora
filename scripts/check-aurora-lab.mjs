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
//   8. A RESERVED WORD USED AS A LOCAL VARIABLE. This one shipped. A vertex
//      shader named a local `patch`, and `patch` is reserved for future use in
//      the ESSL grammar -- it is a tessellation keyword -- which ANGLE enforces
//      to the letter. ANGLE is the GL layer under Chrome, Edge, Safari and the
//      Quest browser, so this was not one machine being fussy: the vertex
//      shader failed to compile EVERYWHERE WebGL runs, the material never
//      linked, the mesh never drew, and the frame was black with nothing in the
//      console anyone was reading. It took a full headless-GL probe to find,
//      for a fault whose entire signature is one identifier appearing in a
//      string. That is exactly the shape of thing a textual gate is for, and
//      the reserved list is short, published and fixed, so there is no excuse
//      for finding this one with a GPU.
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
    ...(await import('../src/aurora-lab/glsl/lut.js')),
    ...(await import('../src/aurora-lab/planmap/glsl.js')),
    ...(await import('../src/aurora-lab/skymap/glsl.js')),
    ...(await import('../src/aurora-lab/glsl/slab.js')),
    ...(await import('../src/aurora-lab/glsl/palette.js')),
    ...(await import('../src/aurora-lab/glsl/frame.js')),
    // The curtain's two shaders live OUTSIDE the algorithm registry -- they are
    // a geometry aurora, not a raymarched one, so nothing in `assemble` reaches
    // them and every check above this line is blind to them. They are also
    // where failure mode 8 actually shipped. glsl.js is safe to import in node
    // for the same reason every other file here is: it holds strings and pulls
    // in params.js, and neither touches three.js.
    ...(await import('../src/aurora-lab/curtain/glsl.js')),
    // The one module both pages read to decide what the knobs hold. Pure
    // numbers and one lerp; nothing here touches three.js.
    ...(await import('../src/aurora-lab/world-drive.js')),
  }
} catch (e) {
  console.log(`\n FAIL  the lab modules do not load, so nothing below can be checked   ${e.message.split('\n')[0]}`)
  console.log(`\n${failures + 1} CHECK(S) FAILED`)
  process.exit(1)
}

const { ALGORITHMS, algorithmById, paramsFor, defaultsFor } = LAB_MODULES
const { BUILTIN_PRESETS } = LAB_MODULES
const { UTIL_GLSL, HASH_GLSL, VALUE_GLSL, GRAD_GLSL, FBM_GLSL, WARP_GLSL, FILAMENT_GLSL } = LAB_MODULES
const { PALETTE_GLSL, MARCH_GLSL, MAIN_GLSL, VERTEX_GLSL, SLAB_MARCH_GLSL } = LAB_MODULES
const { LUT_GLSL, PLANMAP_GLSL } = LAB_MODULES
const { SKYMAP_GLSL, SKYMAP_FRAME_GLSL } = LAB_MODULES
const { CURTAIN_VERTEX, CURTAIN_FRAGMENT } = LAB_MODULES
const { DEFAULT_ALGORITHM } = LAB_MODULES
const { WORLD_ALGORITHM, ACT_LO, ACT_HI, ACTIVITY_SHAPE, DRIVEN_KEYS } = LAB_MODULES
const { PATTERNS, worldDrivenValues, worldFieldSeed } = LAB_MODULES

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
  lut: LUT_GLSL,
  planmap: PLANMAP_GLSL,
  skymap: SKYMAP_GLSL,
}

// Must match screen.js's list exactly, `grad` included. It drifted once, and the drift made this gate LAXER than the runtime rather than noisier: the gate assembled a smaller chunk set, so a uniform referenced only by GRAD_GLSL would have been reported as undeclared here while compiling perfectly on the page, and a dead slider in that chunk would have gone unseen.
const BASE_CHUNKS = ['util', 'hash', 'value', 'grad', 'fbm']

const GLSL_TYPE = { float: 'float', color: 'vec3', bool: 'float', enum: 'int' }

// Mirrors screen.js's CHUNK_SAMPLERS, holding bare uniform NAMES rather than the texture accessors the runtime binds. A sampler is the one uniform the param schema cannot express, so a chunk that needs one names it and it is declared only when that chunk is in the assembly -- and the value is an ARRAY because a chunk can need several. Without this the uniform-count check below fails by exactly one for `lut`, reporting u_noiseLut as an undeclared reference.
const CHUNK_SAMPLERS = {
  lut: ['u_noiseLut'],
  planmap: ['u_planMap'],
  skymap: ['u_skyMap', 'u_skyLanes', 'u_skyHue', 'u_skyKernel'],
}

// Mirrors screen.js's FRAMES. Hardcoding MARCH_GLSL here would leave an
// alternative integrator's GLSL entirely unscanned: its uniform references
// would never be checked against the schema, and the params only IT reads
// would be reported as dead sliders on the algorithm that uses it.
const FRAMES = { slab: SLAB_MARCH_GLSL, skymap: SKYMAP_FRAME_GLSL }

function declarationsFor(params, chunks) {
  const lines = ['uniform float uTime;', 'uniform float uDitherScale;']
  for (const name of chunks) {
    if (!CHUNK_SAMPLERS[name]) continue
    for (const uniform of CHUNK_SAMPLERS[name]) lines.push(`uniform sampler2D ${uniform};`)
  }
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
    algo.frame ? FRAMES[algo.frame] : MARCH_GLSL,
    MAIN_GLSL,
  ].join('\n')

  // Flattened to one entry per sampler NAME, not per chunk, because the count check downstream expects one declaration per element of this list.
  const samplers = ordered.filter((n) => CHUNK_SAMPLERS[n]).flatMap((n) => CHUNK_SAMPLERS[n])
  return { algo, params, unknown, samplers, decls: declarationsFor(params, ordered), body }
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
  const { params, unknown, samplers, decls, body } = assemble(algo.id)

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
  // Samplers are added because they are the one declaration with no param behind it, and they are added as a COUNT rather than by exempting the u_ prefix, so a sampler that is declared without its chunk being in the assembly still fails.
  const uniformParams = params.filter((p) => p.uniform !== false)
  const expected = uniformParams.length + samplers.length
  check(
    declared.size === expected,
    `${algo.id}: one declaration per shader-facing param, and no more`,
    `${declared.size} declarations, ${uniformParams.length} params + ${samplers.length} sampler(s)`
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
console.log('\n--- the bench and the world are the same sky -------------------')
// ===========================================================================
//
// The lab is only worth having if a sky tuned on it is the sky the headset
// shows. That held by accident for a while and then quietly stopped: /v2 pinned
// `skymap` and overwrote six shared knobs from a table of its own every frame,
// while the page opened on `leyline` and left them at their schema defaults. Two
// different skies, no error, and no way to see the gap from either page.
//
// world-drive.js is now the single copy of that table and both sides import it.
// What this section guards is that they GO ON importing it -- the failure to
// catch is somebody restating a number locally because it was one line.

const v2Rel = 'src/v2/render/aurora.js'
const v2Src = fs.readFileSync(path.join(ROOT, v2Rel), 'utf8')

check(/from\s+['"]\.\.\/\.\.\/aurora-lab\/world-drive\.js['"]/.test(v2Src),
  'the world imports its aurora tuning from world-drive.js', v2Rel)
check(!/ACTIVITY_SHAPE\s*=/.test(v2Src),
  'and does not keep a second copy of the shape table', v2Rel)
check(/worldDrivenValues\s*\(/.test(v2Src),
  'and turns the clock into knob values through the shared function', v2Rel)
check(/worldFieldSeed\s*\(/.test(v2Src),
  'and folds the world seed through the shared function', v2Rel)

check(/from\s+['"]\.\/aurora-lab\/world-drive\.js['"]/.test(mainSrc),
  'the bench imports the same module', mainRel)
check(/worldDrivenValues\s*\(/.test(mainSrc),
  'and drives its panel from the same function', mainRel)
check(/from\s+['"]\.\/v2\/config\.js['"]/.test(mainSrc) && /worldFieldSeed\s*\(\s*SEED\s*\)/.test(mainSrc),
  'and seeds its field from the world SEED, so it is the same patch of sky', mainRel)

// The page opening on an algorithm the world does not draw is the original bug
// in its purest form, and it is one constant.
check(DEFAULT_ALGORITHM === WORLD_ALGORITHM,
  'the bench opens on the algorithm the world draws',
  `default ${DEFAULT_ALGORITHM}, world ${WORLD_ALGORITHM}`)
check(ALGORITHMS.some((a) => a.id === WORLD_ALGORITHM),
  `and ${WORLD_ALGORITHM} is a real entry in the registry`)

// Bumping STORE is what makes the default reach anyone who has already used the
// page: without it a stored `leyline` wins forever and the fix ships to nobody.
check(/const STORE = 'aurora-lab\.state\.v2'/.test(mainSrc),
  'and the store key was bumped, so a stored algorithm cannot outlive the change',
  mainRel)

// ACT_LO and ACT_HI are AURORA_ACTIVITY.quiet and .storm, restated in the lab
// because clock.js is a v2 module. Restated values drift; this is the only
// thing that would notice.
const clockSrc = fs.readFileSync(path.join(ROOT, 'src', 'clock.js'), 'utf8')
const quiet = Number((clockSrc.match(/\bquiet:\s*([\d.]+)/) || [])[1])
const storm = Number((clockSrc.match(/\bstorm:\s*([\d.]+)/) || [])[1])
check(quiet === ACT_LO && storm === ACT_HI,
  "the activity bounds still match clock.js's AURORA_ACTIVITY",
  `clock ${quiet}..${storm}, world-drive ${ACT_LO}..${ACT_HI}`)

// Every driven key has to be a real param under the world's algorithm, or the
// bench throws on the first frame: the panel's setValue refuses a key with no
// widget, which is exactly the loud failure wanted here -- but only if it is
// found before the page loads rather than by the page loading.
const worldDefaults = defaultsFor(WORLD_ALGORITHM)
const missing = DRIVEN_KEYS.filter((k) => !(k in worldDefaults))
check(missing.length === 0,
  `every driven key is a param of ${WORLD_ALGORITHM}`, missing.join(', '))
check(DRIVEN_KEYS.length === Object.keys(ACTIVITY_SHAPE).length + 1,
  'and DRIVEN_KEYS is the shape table plus exposure, with nothing invented')

// The world sliders themselves. Without routes in sceneApply they are
// `uniform: false` params that fall through to screen.setParam and silently do
// nothing -- three sliders that move and change nothing, which is the exact
// failure the schema was built to prevent.
for (const key of ['worldDrive', 'worldAct', 'worldAurora']) {
  check(key in worldDefaults, `the panel declares ${key}`)
  check(new RegExp(`\\b${key}:\\s*\\(`).test(mainSrc),
    `and the page routes ${key} rather than letting it fall through`, mainRel)
}

// The drive must land inside the sliders it is writing into, at both ends and
// in the middle, or the panel shows a number the widget then clamps and the two
// stop agreeing about what is on screen.
const paramByKey = new Map(paramsFor(WORLD_ALGORITHM).map((p) => [p.key, p]))
const outOfRange = []
for (const activity of [ACT_LO, 0.45, 0.75, ACT_HI]) {
  const driven = worldDrivenValues(activity, 1.0)
  for (const [key, v] of Object.entries(driven)) {
    const p = paramByKey.get(key)
    if (v < p.min || v > p.max) outOfRange.push(`${key} ${v.toFixed(2)} outside ${p.min}..${p.max} at a=${activity}`)
  }
}
check(outOfRange.length === 0,
  'every value the drive produces fits the slider it writes to', outOfRange.join('; '))

// The four named points are what /v2's HUD prints and what the bench's stat row
// prints. A pattern outside the clock's own envelope is a name for a sky the
// world cannot reach.
const badPattern = PATTERNS.filter((p) => p.activity < ACT_LO || p.activity > ACT_HI)
check(badPattern.length === 0,
  'every named pattern is a real point on the clock scale',
  badPattern.map((p) => p.name).join(', '))

check(worldFieldSeed(20260824) === 22 && worldFieldSeed(-3) === 98,
  'the seed fold stays inside 0..100 and handles a negative seed')

// And the curtain must NOT show them. It has none of the six knobs the drive
// writes, so under it these would be three sliders that move nothing -- the same
// argument curtain/params.js makes for dropping the march and belt groups. This
// is why the world group is exported on its own rather than living inside
// SCENE_GROUPS, which the curtain does get.
const { curtainParams } = await import('../src/aurora-lab/curtain/params.js')
const curtainKeys = new Set(curtainParams().map((p) => p.key))
const leaked = ['worldDrive', 'worldAct', 'worldAurora'].filter((k) => curtainKeys.has(k))
check(leaked.length === 0,
  'the curtain is not handed world sliders it cannot obey', leaked.join(', '))

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
  ['LUT_GLSL', LUT_GLSL, 'AURLAB_LUT'],
  ['PLANMAP_GLSL', PLANMAP_GLSL, 'AURLAB_PLANMAP'],
  ['SKYMAP_GLSL', SKYMAP_GLSL, 'AURLAB_SKYMAP'],
  ['SKYMAP_FRAME_GLSL', SKYMAP_FRAME_GLSL, 'AURLAB_SKYMAP_FRAME'],
  ['PALETTE_GLSL', PALETTE_GLSL, 'AURLAB_PALETTE'],
  ['MARCH_GLSL', MARCH_GLSL, 'AURLAB_MARCH'],
  ['SLAB_MARCH_GLSL', SLAB_MARCH_GLSL, 'AURLAB_SLAB'],
]

// The list above is written out rather than derived, so a new chunk added to
// noise.js is not silently exempt -- it fails the count below until someone
// puts it here.
const chunkExports = []
for (const file of ['glsl/noise.js', 'glsl/lut.js', 'planmap/glsl.js', 'skymap/glsl.js']) {
  const src = fs.readFileSync(path.join(LAB, file), 'utf8')
  for (const m of src.match(/^export const (\w+_GLSL)\b/gm) || []) chunkExports.push(m.split(' ')[2])
}
const ungated = chunkExports.filter((n) => !GUARDED.some(([name]) => name === n))
check(ungated.length === 0, 'every chunk the basis files export is in the guarded list', ungated.join(', '))

for (const [name, src, token] of GUARDED) {
  const ifndef = (src.match(new RegExp(`#ifndef\\s+${token}\\b`, 'g')) || []).length
  const define = (src.match(new RegExp(`#define\\s+${token}\\b`, 'g')) || []).length
  const opens = (src.match(/#ifndef\b/g) || []).length
  const closes = (src.match(/#endif\b/g) || []).length
  check(ifndef === 1 && define === 1, `${name}: guarded by ${token}`, `${ifndef} ifndef, ${define} define`)
  check(opens === closes, `${name}: and every #ifndef is closed`, `${opens} open, ${closes} #endif`)
}

// ===========================================================================
console.log('\n--- no ESSL reserved word is used as an identifier -------------')
// ===========================================================================
//
// See failure mode 8. The list below is not a guess and it is not just `patch`:
// it is the RESERVED-FOR-FUTURE-USE list from §3.7 of the OpenGL ES Shading
// Language 3.00 specification, unioned with the one from §3.6 of the 1.00
// specification, because a chunk written for one dialect can end up assembled
// into the other and the two lists differ in both directions. Words that are
// live KEYWORDS in one dialect and reserved in the other (`switch`, `default`,
// `flat`, `sampler3D`) are kept, because they are illegal as an identifier
// either way, which is the only question this gate asks.
//
// Two words that belong on the spec's 3.00 reserved list are deliberately NOT
// here: `attribute` and `varying`. They are reserved in 3.00 only because 3.00
// removed them, and they are required vocabulary in 1.00 -- CURTAIN_VERTEX
// declares four attributes and three varyings, and every chunk in this lab is
// 1.00. Including them would fail the gate on correct code, and a gate that
// cries wolf over legitimate GLSL gets switched off, which leaves you worse off
// than the bug it was added for. Any word added here later has to clear the
// same bar: it must be illegal as an identifier in BOTH dialects.
//
// Matched on word boundaries rather than as substrings, which is not a detail:
// `u_cuPatchAmt`, `u_cuPatchKm` and `dispatch` all contain the letters of the
// word that broke the build and all three are perfectly legal identifiers.

const ESSL_RESERVED = [
  // Storage, memory and interpolation qualifiers held back for a later version.
  'coherent', 'volatile', 'restrict', 'readonly', 'writeonly',
  'noperspective', 'flat', 'patch', 'sample', 'subroutine',
  'common', 'partition', 'active', 'resource', 'packed',
  // Words held back because a C or C++ programmer will reach for them.
  'asm', 'class', 'union', 'enum', 'typedef', 'template', 'this',
  'goto', 'switch', 'default', 'inline', 'noinline', 'public', 'static',
  'extern', 'external', 'interface', 'sizeof', 'cast', 'namespace', 'using',
  // Numeric types the language does not have yet.
  'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'superp',
  'input', 'output', 'filter', 'atomic_uint',
  'hvec2', 'hvec3', 'hvec4', 'fvec2', 'fvec3', 'fvec4',
  'dvec2', 'dvec3', 'dvec4',
  // Sampler types that exist in desktop GL and not here.
  'sampler1D', 'sampler1DShadow', 'sampler1DArray', 'sampler1DArrayShadow',
  'isampler1D', 'isampler1DArray', 'usampler1D', 'usampler1DArray',
  'sampler3D', 'sampler3DRect',
  'sampler2DRect', 'sampler2DRectShadow', 'isampler2DRect', 'usampler2DRect',
  'samplerBuffer', 'isamplerBuffer', 'usamplerBuffer',
  'sampler2DMS', 'isampler2DMS', 'usampler2DMS',
  'sampler2DMSArray', 'isampler2DMSArray', 'usampler2DMSArray',
  // Image types, the whole family.
  'image1D', 'image2D', 'image3D', 'imageCube',
  'iimage1D', 'iimage2D', 'iimage3D', 'iimageCube',
  'uimage1D', 'uimage2D', 'uimage3D', 'uimageCube',
  'image1DArray', 'image2DArray',
  'iimage1DArray', 'iimage2DArray', 'uimage1DArray', 'uimage2DArray',
  'image1DShadow', 'image2DShadow', 'image1DArrayShadow', 'image2DArrayShadow',
  'imageBuffer', 'iimageBuffer', 'uimageBuffer',
]

const RESERVED_RE = new RegExp(`\\b(?:${ESSL_RESERVED.join('|')})\\b`, 'g')

// stripComments is the right tool here and the wrong shape by one detail: it
// collapses a block comment to a single space, and that takes the newlines with
// it, so every line number after a /* */ would be reported short. A line number
// the reader cannot find in the file is worse than no line number at all, so
// block comments are blanked IN PLACE first -- same length, same newlines --
// and stripComments is left to do the `//` form, which is already line-safe.
const blankBlockComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))

// Reported with the word AND the line, both, because the two answer different
// questions and you need both to fix it: the word is what you rename, the line
// is where. A gate that only says "reserved word found" over four thousand
// lines of GLSL costs the afternoon it was written to save.
//
// `base` is what the caller adds to turn a line number WITHIN THE STRING into a
// line number in a file. The named pass below leaves it at zero, because a chunk
// like MARCH_GLSL is a string that gets concatenated with others and its own
// first line is the only origin that means anything there; the source sweep sets
// it, because it knows where in the file the literal started and a file line is
// what you can jump to.
const reservedIn = (src, base = 0) => {
  const hits = []
  stripComments(blankBlockComments(src)).split('\n').forEach((line, i) => {
    for (const m of line.matchAll(RESERVED_RE)) hits.push(`\`${m[0]}\` on line ${i + 1 + base}`)
  })
  return hits
}

// The matcher is checked against a fixture before it is pointed at anything
// real, because the two ways this gate can be wrong are both silent. Too loose
// and it fails on correct code, which gets it deleted; too tight and it passes
// on the exact line that shipped black, which is the same as not having it. The
// fixture holds one genuine offence and three near misses that must NOT fire:
// two live uniform names from the shader that broke, and the word that contains
// the reserved one. It also holds a comment, because prose about `patch` is
// what most of this repo's mentions of the word are and none of them are bugs.
{
  const fixture = [
    'float a = u_cuPatchAmt * u_cuPatchKm;',   // 1: substrings, both legal
    'float dispatch = a;',                     // 2: contains it, still legal
    '// patch is reserved, says this comment', // 3: prose, must be invisible
    '/* and so',                               // 4: a block comment that
    '   does patch here */ float b = a;',      // 5: spans two lines
    'float patch = b;',                        // 6: the real thing
  ].join('\n')
  const hits = reservedIn(fixture)
  check(hits.length === 1 && hits[0] === '`patch` on line 6',
    'the matcher finds the one real offence and none of the near misses',
    hits.length ? hits.join(', ') : 'nothing matched at all')
}

// Every GLSL string the lab can hand to a compiler. GUARDED is reused rather
// than restated -- it is already the file's canonical "here is every chunk"
// list, and it is checked for completeness against the basis files' exports a
// few lines above -- and the four strings that are NOT chunks are added by
// name: the two ends of the raymarched material, and the curtain's own pair,
// which no other check in this file touches.
const RESERVED_SCAN = [
  ...GUARDED.map(([name, src]) => [name, src]),
  ['VERTEX_GLSL', VERTEX_GLSL],
  ['MAIN_GLSL', MAIN_GLSL],
  ['CURTAIN_VERTEX', CURTAIN_VERTEX],
  ['CURTAIN_FRAGMENT', CURTAIN_FRAGMENT],
  ...ALGORITHMS.map((a) => [`${a.id}: auroraField`, a.glsl]),
]

check(RESERVED_SCAN.every(([, src]) => typeof src === 'string' && src.length > 0),
  'every GLSL string in the scan list actually arrived as a string',
  `${RESERVED_SCAN.length} strings`)

for (const [name, src] of RESERVED_SCAN) {
  // Lines are counted from the top of the chunk, not of the file it lives in.
  // The sweep below reports the same fault against a real file line, so between
  // the two you get the name of the chunk and somewhere to jump to.
  const hits = typeof src === 'string' ? reservedIn(src) : []
  check(hits.length === 0, `${name}: uses no ESSL reserved word as an identifier`, hits.join(', '))
}

// The sweep that stops the list above going stale. The three GLSL strings the
// lab keeps for its own use -- the backdrop's sky, the low-res composite, and
// the plan-map's blit -- are module-private consts in files that construct a
// three.js material at import, so they cannot be reached by name the way the
// chunks above can. They are read off the filesystem instead, and read
// GENERICALLY: every template literal in every lab file that looks like GLSL is
// scanned, so a new shader added anywhere under src/aurora-lab is covered the
// moment it is written rather than the moment someone remembers this gate.
//
// Splitting on backticks and taking the odd pieces is only sound because the
// very first section of this file has already established that every lab file's
// backticks pair up and none are adjacent. It is the payoff for running that
// check first.

const LOOKS_LIKE_GLSL = /\bvoid\s+main\s*\(|\bgl_(?:Position|FragColor)\b|\bvec[234]\s+[A-Za-z_]/

let sweptLiterals = 0
for (const file of labFiles) {
  const rel = path.relative(ROOT, file)
  const pieces = fs.readFileSync(file, 'utf8').split('`')
  const hits = []
  let n = 0
  // Walked with a running line count rather than by searching for the literal
  // again, so what gets reported is the line you can jump to in the editor.
  // Every piece advances the count, literal and non-literal alike; the
  // backticks that split them are dropped by the split and carry no newline of
  // their own, so nothing is lost by not counting them.
  let line = 1
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 1 && LOOKS_LIKE_GLSL.test(pieces[i])) {
      n++
      hits.push(...reservedIn(pieces[i], line - 1))
    }
    line += (pieces[i].match(/\n/g) || []).length
  }
  sweptLiterals += n
  if (!n) continue
  check(hits.length === 0, `${rel}: no reserved word in its ${n} GLSL literal(s)`, hits.join(', '))
}

// A sweep that matched nothing would pass silently forever, which is the one
// way a derived check is worse than a written-out one.
check(sweptLiterals >= RESERVED_SCAN.length,
  'the source sweep found at least as many GLSL literals as the scan list names',
  `${sweptLiterals} literals swept, ${RESERVED_SCAN.length} named`)

// ===========================================================================
console.log('\n--- the prepasses are not drawn through the headset ------------')
// ===========================================================================
//
// This one shipped, and it is the shape of bug this whole file exists for: a
// picture, not an error, and only on the one machine that cannot be attached to
// a debugger.
//
// While an XR session is live, three.js REPLACES the camera handed to render()
// with its own ArrayCamera, and each of that camera's eye cameras carries a
// viewport sized to the HEADSET's framebuffer. skymap.js's four prepasses are
// full-target quads in clip space, so they were being rasterised into a rect two
// thousand texels wide instead of the sixty-four the map actually is -- which
// squeezes the whole of vSkyUv into one corner of every map, and that corner is
// below u_horizonCut, where the sky is black by definition. The aurora was
// perfect on a monitor and completely absent in the headset, with nothing in any
// console.
//
// Textual, because the fault needs a live XR session to reproduce and there is
// no session in node. `renderer.xr.enabled = false` around the passes is the
// whole fix, and it is the same one sky-probe.js and world-probe.js already
// carry for the same reason -- so all three are asserted together, since a
// future prepass that forgets it will look exactly like this did.
const XR_OFF = [
  ['src/aurora-lab/skymap/skymap.js', "the sky map's four prepasses"],
  ['src/sky-probe.js', "the sky probe's cube faces"],
  ['src/world-probe.js', "the world probe's cube faces"],
]
for (const [rel, what] of XR_OFF) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  check(/renderer\.xr\.enabled\s*=\s*false/.test(src),
    `${what} turn renderer.xr off before rendering`, rel)
  check(/renderer\.xr\.enabled\s*=\s*(wasXR|prevXR)/.test(src),
    'and put back what was there rather than a literal', rel)
}

// ===========================================================================
console.log('\n--- the page is wired -----------------------------------------')
// ===========================================================================
//
// A shader lab nobody can open is not a lab. The page is registered by
// existing -- vite.config.js reads the root for both the dev routes and the
// build inputs (DESIGN.md §17) -- so the failure this guards is no longer a
// forgotten config line but a broken derivation, which would silently drop
// every bench from the build at once. Asked by resolving the config rather
// than by grepping it, for the reason section 9 of check-v2-sculpt.mjs gives.
//
// `__dirname` is vite's injection, so a plain node import needs it defined
// first; if that ever stops being enough this fails loudly rather than skips.

const exists = (rel) => fs.existsSync(path.join(ROOT, rel))
check(exists('test-aurora.html'), 'test-aurora.html exists at the repo root')
check(exists('src/test-aurora-main.js'), 'src/test-aurora-main.js exists')

globalThis.__dirname = ROOT
const input = (await import(`${ROOT}/vite.config.js`)).default.build.rollupOptions.input
const entries = Object.values(input).map((p) => path.basename(p))
check(entries.includes('test-aurora.html'), 'and the build input the config resolves to includes it',
  `${entries.length} entr(ies), test-aurora.html ${entries.includes('test-aurora.html') ? 'present' : 'MISSING'}`)
check(entries.includes('index.html'), 'and the world itself, so the derivation is reading the real root')

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
