// ---------------------------------------------------------------------------
// The wind gate.
//
// scripts/check-shaders.mjs already proves the three wind bodies COMPILE and
// LINK on a real GLSL front end. This file is for the things a compiler cannot
// see: numbers that are wrong rather than malformed, and wiring that is absent
// rather than broken.
//
// The headline check is the clock wrap. setPropClock wraps at PROP_CLOCK_WRAP
// seconds, so any frequency multiplying it has to be a whole number of cycles
// per wrap or every plant in the world steps in phase once every 17 minutes.
// That is a bug with a 17-minute repro and no visible cause, which is exactly
// the kind worth spending a gate on -- nobody is going to find it by looking.
// ---------------------------------------------------------------------------

import * as THREE from 'three'

import { createPropMaterial, WIND_PRESETS, setWind, getWind } from '../src/material.js'
import { treeVariants } from '../src/props/tree-bank.js'
import { FERN_DEFAULTS } from '../src/props/fern.js'
import { GRASS_BASE } from '../src/props/grass-bank.js'

let failed = 0
const ok = (name, detail = '') => console.log(`  ok   ${name}${detail ? `   ${detail}` : ''}`)
const bad = (name, detail = '') => { failed++; console.log(` FAIL  ${name}${detail ? `   ${detail}` : ''}`) }
const check = (cond, name, detail = '') => (cond ? ok(name, detail) : bad(name, detail))

// The wrap has to match material.js's PROP_CLOCK_WRAP, which is deliberately not
// exported -- it is a packing detail of the fade channel. Restating it here is
// the point: if someone moves the wrap, this gate fails and makes them look at
// the frequencies, which is the coupling that would otherwise go unnoticed.
const PROP_CLOCK_WRAP = 1024

const atlas = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4 * 4), 4, 4, 4)

/**
 * The vertex source and uniform set one createPropMaterial option bag produces.
 * onBeforeCompile MUTATES the shader object three.js hands it, so handing it a
 * stub with the same #include markers the real chunk assembler uses is enough to
 * read back exactly the GLSL a driver would see.
 */
function vertexSource(opts) {
  const material = createPropMaterial(atlas, opts)
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <project_vertex>\n',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>\n',
  }
  material.onBeforeCompile(shader)
  return { src: shader.vertexShader, uniforms: shader.uniforms }
}

console.log('\n=== wind: clock-wrap continuity ===\n')

// Pull the frequencies back OUT of the emitted GLSL rather than recomputing them
// from the preset. Recomputing would only prove windFreq() agrees with itself;
// reading the shipped source proves the numbers a driver will actually run are
// the snapped ones, which is the claim that matters.
const { src: treeSrc } = vertexSource({ billboardLayers: [0, 1, 2], wind: 'tree' })
const freqs = [...treeSrc.matchAll(/uPropClock \* ([0-9.]+)/g)].map((m) => Number(m[1]))
check(freqs.length === 2, 'the tree body multiplies the clock exactly twice -- a carrier and an envelope',
  `${freqs.length} site(s): ${freqs.join(', ')}`)

for (const f of freqs) {
  const cycles = (f * PROP_CLOCK_WRAP) / (2 * Math.PI)
  // Float32 in the shader and a 6-decimal literal in the source, so the
  // tolerance is about the printing, not about the snap.
  const off = Math.abs(cycles - Math.round(cycles))
  check(off < 1e-3, `${f} rad/s is a whole number of cycles per ${PROP_CLOCK_WRAP} s wrap`,
    `${cycles.toFixed(4)} cycles, off by ${off.toExponential(1)}`)
}

// And the gate can see a bad one: an unsnapped frequency has to fail the test
// above, or the test proves nothing. 1.7 rad/s is the raw number the preset asks
// for before windFreq rounds it.
{
  const cycles = (1.7 * PROP_CLOCK_WRAP) / (2 * Math.PI)
  const off = Math.abs(cycles - Math.round(cycles))
  check(off > 1e-3, 'and an UNSNAPPED frequency fails that same test, so the test is real',
    `raw 1.7 rad/s is ${cycles.toFixed(4)} cycles, off by ${off.toFixed(4)}`)
}

console.log('\n=== wind: the foot stays planted ===\n')

// The bend is an ANGLE -- amp * y -- so a vertex at y = 0 cannot move however
// hard it blows. That is what keeps a tree's trunk in its hole and a grass
// strip on the tilt that seated it. Structural, because the alternative is
// re-implementing the shader in JS and gating a second copy that can drift.
for (const [label, opts] of [
  ['cards', { billboardLayers: [0, 1, 2], wind: 'tree' }],
  ['strips', { stripTiling: true, wind: 'grass' }],
  ['meshes', { wind: 'fern' }],
]) {
  const { src } = vertexSource(opts)
  check(/float wLean = pow\([^;]*\* transformed\.y/s.test(src),
    `the ${label} body scales its lean by transformed.y, so y = 0 cannot move`)
}

console.log('\n=== wind: the height weight matches the geometry ===\n')

{
  const { src: strips } = vertexSource({ stripTiling: true, wind: 'grass' })
  check(/float wH = 1\.0 - uvProj\.y;/.test(strips),
    'a strip reads its height fraction straight out of uvProj -- exact, no constant to get wrong')
  check(/wAspect/.test(strips) && /length\( wM\[ 0 \]\.xyz \)/.test(strips),
    'and divides by its own x/y scale ratio, being the one class scaled non-uniformly')

  const { src: cards } = vertexSource({ billboardLayers: [0, 1, 2], wind: 'tree' })
  check(/float wH = mix\(/.test(cards) && /propCard/.test(cards),
    'a bed with baked cards picks the uv fraction on cards and the pin ramp on meshes')
  check(!/wAspect = max/.test(cards),
    'and pays nothing for the strip scale correction it does not need')

  const { src: meshes } = vertexSource({ wind: 'fern' })
  check(/float wH = clamp\( transformed\.y/.test(meshes) && !/mix\(/.test(meshes.split('float wH')[1].split(';')[0]),
    'a bed with no cards at all takes the pin ramp alone')
}

console.log('\n=== wind: pin lengths are shorter than the plants they pin ===\n')

// pin is METRES of stem held stiff, and it is only meaningful BELOW the plant's
// own height. Prop geometry is authored at true world height -- tree.js rescales
// every build so the tip lands at p.height -- so transformed.y is metres and the
// pin can be compared against the bank directly. A pin longer than the plant
// clamps that plant's weight under 1 for its whole length, and pow( wH, stiff )
// then drives it toward nothing: a 3.0 m pin on the 1.98 m birch capped its tip
// at 0.35 and moved it 8 mm against the 12 m pine's 140 mm.
//
// ASK THE BANK for the floor rather than restating it. The shortest tree is not
// the shortest species -- treeVariants crosses species with TREE_SIZES, and it is
// that product that reaches down to 1.98 m. Hard-coding the number here would
// have gone stale the first time anyone added a size or a species.
const shortestTree = Math.min(...treeVariants().map((v) => v.height))
for (const [label, pin, shortest, source] of [
  ['tree', WIND_PRESETS.tree.pin, shortestTree, 'shortest of treeVariants()'],
  ['fern', WIND_PRESETS.fern.pin, FERN_DEFAULTS.height, 'FERN_DEFAULTS.height'],
  ['grass', WIND_PRESETS.grass.pin, GRASS_BASE.height, 'GRASS_BASE.height'],
]) {
  check(pin < shortest, `${label}: pin ${pin} m clears the shortest it must bend, ${shortest.toFixed(2)} m`,
    `${((pin / shortest) * 100).toFixed(0)}% of it (${source}), so even the smallest reaches full lean`)
}

console.log('\n=== wind: one canopy is not one rigid flag ===\n')

// The phase carries a dot( transformed.xz, ... ) term, so two sprays on opposite
// sides of a crown read the wave at different points and bend at different times.
// This was the part assumed to be out of reach -- per-branch motion normally
// wants a per-branch attribute, which BatchedMesh forbids -- and it falls out of
// the travelling wave for two multiplies, because object XZ is already a
// position and the wave is already a function of position.
//
// Measured over the four built species, the spread across a canopy is 3.0 rad
// (aspen, the narrowest) to 4.8 rad (oak, the widest) at branch = 0.55: most of
// a cycle, so the far side of an oak is close to antiphase with the near side.
// That measurement builds four trees and belongs in check-trees' cost bracket,
// not here; what is gated here is that the term still EXISTS, since deleting it
// would cost nothing visible in a diff and turn every tree into a rigid flag.
for (const [label, opts] of [
  ['cards', { billboardLayers: [0, 1, 2], wind: 'tree' }],
  ['meshes', { wind: 'fern' }],
]) {
  const { src } = vertexSource(opts)
  check(/dot\( transformed\.xz, vec2\(/.test(src),
    `the ${label} phase varies with object XZ, so one crown does not move as a slab`)
}
for (const [label, preset] of Object.entries(WIND_PRESETS)) {
  check(preset.branch > 0, `${label}: branch ${preset.branch} is live, not zeroed out`)
}

console.log('\n=== wind: nothing pays for wind it did not ask for ===\n')

{
  const { uniforms: plain } = vertexSource({})
  check(plain.uWindDir === undefined && plain.uWindStrength === undefined,
    'a material with no wind binds no wind uniforms')
  const { src: plainSrc } = vertexSource({})
  check(!/wLean/.test(plainSrc), 'and emits no wind GLSL at all')

  const { uniforms: windy } = vertexSource({ wind: 'tree' })
  check(windy.uWindDir !== undefined && windy.uWindStrength !== undefined,
    'and a material with wind binds both')

  // BY REFERENCE, like the snow -- one setWind has to move every program, or a
  // weather system would need a registry of every material ever built.
  const a = vertexSource({ wind: 'tree' }).uniforms.uWindDir
  const b = vertexSource({ wind: 'grass' }).uniforms.uWindDir
  check(a === b, 'and two materials share ONE direction uniform object, so setWind moves both')
}

console.log('\n=== wind: the API refuses what it cannot honour ===\n')

{
  let threw = false
  try { createPropMaterial(atlas, { wind: 'shrubbery' }) } catch { threw = true }
  check(threw, 'an unknown preset name throws rather than compiling a material that never moves')

  threw = false
  try { setWind({ strength: NaN }) } catch { threw = true }
  check(threw, 'a non-finite strength throws rather than turning every prop into a NaN')

  const before = getWind()
  setWind({ degrees: 90 })
  check(Math.abs(getWind().degrees - 90) < 1e-9, 'setWind/getWind round-trip the direction')
  setWind(before)
}

console.log('\n=== wind: the three scatters actually opted in ===\n')

// The whole feature is one option on one call, so a class that forgot it looks
// exactly like a class that has it -- everything compiles, nothing moves. Read
// the source: it is the only way to tell.
{
  const { readFileSync } = await import('node:fs')
  for (const [label, path, preset] of [
    ['trees', 'src/v2/render/trees.js', 'tree'],
    ['ferns', 'src/v2/render/ferns.js', 'fern'],
    ['grass', 'src/v2/render/grass.js', 'grass'],
  ]) {
    const src = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    check(src.includes(`wind: '${preset}'`), `${label} passes wind: '${preset}' to createPropMaterial`)
  }
  // Grass builds TWO materials -- the strip bed and the tuft ladder -- and the
  // tuft one is what the M key swaps to. A preset on only one of them is a bed
  // that stops moving when you press a key.
  const grass = readFileSync(new URL('../src/v2/render/grass.js', import.meta.url), 'utf8')
  const wired = (grass.match(/wind: 'grass'/g) ?? []).length
  check(wired === 2, 'and grass wires BOTH its beds, so the M key does not stop the wind', `${wired} of 2`)
}

console.log(failed === 0 ? '\nall wind checks passed\n' : `\n${failed} CHECK(S) FAILED\n`)
process.exit(failed === 0 ? 0 : 1)
