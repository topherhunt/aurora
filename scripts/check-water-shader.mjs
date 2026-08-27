// The water's REFLECTION, checked as far as it can be without a GPU (§11).
//
// There is no GL context in node, so nothing here renders a pixel. What it can
// do is pin the three things that fail silently -- that produce a lake which
// looks plausible in the headset and is wrong:
//
//   1. THE COMPASS. The horizon map is baked with north = -z and azimuth
//      growing clockwise, so the shader's `atan( dir.x, -dir.z )` is not the
//      atan(z, x) a maths convention would suggest. Swap them and every
//      mountain in the reflection sits 90 degrees from where it belongs. The
//      image still looks like water. Nothing complains.
//   2. ONE SKY. The water reflects the sky by calling the dome's own shading
//      function. The instant someone copies that maths instead, sunset works on
//      the dome and not on the lake, and it takes a sunset to notice.
//   3. WAVE SLOPE. The plane is flat and only the normal moves, so the summed
//      slopes decide how far the reflection can bend. Past 45 degrees of tilt
//      the reflected ray points into the ground on ordinary facets rather than
//      on rare ones, and the fold-up in the shader stops being a safety net and
//      starts being what you see.
//
// What this can NOT check: whether it looks like water. That needs eyes, and on
// a headset (§17).
import { bakeHorizon, AZIMUTHS, decodeHorizon } from '../src/sim/horizon.js'
import { SAMPLE_GLSL } from '../src/lighting.js'
import { SKY_GLSL } from '../src/sky-glsl.js'
import { WAVE_LAYERS, WATER } from '../src/water.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
function check(ok, title, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? ' ok  ' : ' FAIL'} ${title}${detail ? `   ${detail}` : ''}`)
}

console.log('\nwater shader')

// --- 1. the compass -----------------------------------------------------------
//
// Two halves, and they meet in the middle. First: what does the BAKE mean by
// layer 4? Answered from a grid with a wall in a known place, so the answer
// comes from the data rather than from restating horizon.js's comments. Second:
// what layer does the SHADER ask for given a world direction? Answered by
// reading the compiled string, not by porting the line -- a port cannot disagree
// with itself.

const N = 64
const CELL = 10
const elev = new Float32Array(N * N)
// A wall along the far EAST edge. Grid +i is +x is east.
for (let j = 0; j < N; j++) for (let i = N - 4; i < N; i++) elev[j * N + i] = 300

const { horizon } = bakeHorizon(elev, N, CELL)
const centre = (N >> 1) * N + (N >> 1)
const layerAngle = (a) => decodeHorizon(horizon[a * N * N + centre])

// Layer 4 of 16 is a quarter turn clockwise from north. If that is east, this is
// the one that sees the wall.
const eastLayer = 4
let hottest = 0
for (let a = 1; a < AZIMUTHS; a++) if (layerAngle(a) > layerAngle(hottest)) hottest = a
check(
  hottest === eastLayer,
  'the bake puts a wall to the EAST in layer 4 of 16',
  `hottest layer ${hottest} at ${((layerAngle(hottest) * 180) / Math.PI).toFixed(1)} deg`
)
// And the opposite direction sees nothing, so this is a real discrimination
// rather than every layer reading high off one tall wall.
check(
  layerAngle(12) < 0.01,
  'the layer facing away from the wall sees open sky',
  `layer 12 at ${((layerAngle(12) * 180) / Math.PI).toFixed(2)} deg`
)

// Now the shader end. Both of these are what a swap would change, and both are
// read out of the string that actually compiles.
check(
  SAMPLE_GLSL.includes('atan( dir.x, -dir.z )'),
  'the shader takes azimuth as atan(x, -z), i.e. clockwise from -z',
  SAMPLE_GLSL.includes('atan( dir.z, dir.x )') ? 'found atan(z, x) -- that is 90 deg out' : ''
)
const scale = /atan\( dir\.x, -dir\.z \) \* ([0-9.]+)/.exec(SAMPLE_GLSL)
check(
  scale !== null && Math.abs(Number(scale[1]) - 1 / (2 * Math.PI)) < 1e-8,
  'radians are converted to turns, not left as radians',
  scale ? `x${scale[1]} against 1/2pi = ${(1 / (2 * Math.PI)).toFixed(9)}` : 'no scale factor found'
)

// The one thing left that ties the two halves together: a world direction
// pointing east must land on layer 4. This restates the shader's line, which is
// why it is the WEAKEST check here and not the only one -- the two above are
// what defend the line itself.
const azTurns = (x, z) => (Math.atan2(x, -z) / (2 * Math.PI) + 1) % 1
check(
  Math.round(azTurns(1, 0) * AZIMUTHS) === eastLayer,
  'a world direction pointing east asks for that same layer',
  `east -> layer ${(azTurns(1, 0) * AZIMUTHS).toFixed(2)}`
)
check(
  Math.round(azTurns(0, -1) * AZIMUTHS) % AZIMUTHS === 0,
  'and world north (-z) asks for layer 0',
  `north -> layer ${(azTurns(0, -1) * AZIMUTHS).toFixed(2)}`
)

// --- 2. one sky ---------------------------------------------------------------

const skySrc = fs.readFileSync(path.join(ROOT, 'src', 'sky.js'), 'utf8')
const waterSrc = fs.readFileSync(path.join(ROOT, 'src', 'water.js'), 'utf8')

check(
  SKY_GLSL.includes('vec3 skyRadiance('),
  'the shared chunk defines skyRadiance'
)
for (const [name, src] of [['sky.js', skySrc], ['water.js', waterSrc]]) {
  check(src.includes('skyRadiance('), `${name} calls skyRadiance rather than reimplementing it`)
}
// The gradient's knee, the horizon-glow falloff and the sun's halo exponents are
// the fingerprints: any of them appearing outside the shared chunk means a
// second copy has been started.
for (const [fingerprint, what] of [
  ['0.35', 'the gradient knee'],
  ['4.5', 'the horizon-glow falloff'],
  ['1400.0', "the sun's halo exponent"],
]) {
  const copies = [skySrc, waterSrc].filter((s) => s.includes(fingerprint)).length
  check(copies === 0, `${what} exists only in sky-glsl.js`, copies ? `found in ${copies} consumer(s)` : '')
}
// The dome draws the hard discs; the water must not, or a 1.1 degree sun
// sampled through a wavy normal turns the lake into static.
check(
  /skyRadiance\(\s*normalize\( vDir \), 1\.0 \)/.test(skySrc),
  'the dome asks for the hard sun and moon discs'
)
check(
  /skyRadiance\( R, 0\.0 \)/.test(waterSrc),
  'the water does NOT, and supplies a broadened highlight instead'
)

// --- 3. the wave field --------------------------------------------------------
//
// The old summed-sine surface could be checked from its table alone: the worst
// tilt was the sum of the slopes, because cos() peaks at 1. Gradient noise has
// no such bound handed to it, so the tilt has to be MEASURED, which means
// running the same field the shader runs.
//
// This is a port, not the shader, and that is a real gap -- worth naming. What
// it is NOT is a gap in the numbers below: wHashDir returns a UNIT vector built
// from a uniformly distributed angle, so the distribution of gradients is the
// same whether the hash's low bits agree between 32-bit GLSL and 64-bit JS or
// not. The port measures the right distribution off a different sample of it.

const fract = (x) => x - Math.floor(x)

function hashDir(cx, cy) {
  let px = fract(cx * 0.1031)
  let py = fract(cy * 0.103)
  let pz = fract(cx * 0.0973)
  const d = px * (py + 33.33) + py * (pz + 33.33) + pz * (px + 33.33)
  px += d
  py += d
  pz += d
  const a = fract((px + py) * pz) * 6.28318531
  return [Math.cos(a), Math.sin(a)]
}

/** Gradient noise: [value, d/dx, d/dy]. Same formulation as WAVE_GLSL. */
function wNoise(x, y) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1)
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1)

  const ga = hashDir(ix, iy)
  const gb = hashDir(ix + 1, iy)
  const gc = hashDir(ix, iy + 1)
  const gd = hashDir(ix + 1, iy + 1)

  const va = ga[0] * fx + ga[1] * fy
  const vb = gb[0] * (fx - 1) + gb[1] * fy
  const vc = gc[0] * fx + gc[1] * (fy - 1)
  const vd = gd[0] * (fx - 1) + gd[1] * (fy - 1)

  const k1 = vb - va
  const k2 = vc - va
  const k3 = va - vb - vc + vd

  return [
    va + k1 * ux + k2 * uy + k3 * ux * uy,
    ga[0] + ux * (gb[0] - ga[0]) + uy * (gc[0] - ga[0]) + ux * uy * (ga[0] - gb[0] - gc[0] + gd[0]) + dux * (k1 + k3 * uy),
    ga[1] + ux * (gb[1] - ga[1]) + uy * (gc[1] - ga[1]) + ux * uy * (ga[1] - gb[1] - gc[1] + gd[1]) + duy * (k2 + k3 * ux),
  ]
}

/** The composite surface gradient at world (x, z) and time t, with both fades
 *  wide open -- i.e. what she sees standing at the shore, the worst case. */
function waveGradient(x, z, t) {
  let gx = 0
  let gz = 0
  let wx = 0
  let wz = 0
  let first = true
  for (const L of WAVE_LAYERS) {
    const freq = 1 / L.wavelength
    const th = (L.rotate * Math.PI) / 180
    const c = Math.cos(th)
    const s = Math.sin(th)
    const hd = (L.heading * Math.PI) / 180
    const vx = Math.sin(hd) * L.speed
    const vz = -Math.cos(hd) * L.speed
    const ax = (x - vx * WATER.flow * t) * freq
    const az = (z - vz * WATER.flow * t) * freq
    let qx = c * ax - s * az + L.offset[0]
    let qz = s * ax + c * az + L.offset[1]
    if (L.detail) {
      qx += wx * WATER.warp
      qz += wz * WATER.warp
    }
    const n = wNoise(qx, qz)
    gx += L.slope * (c * n[1] + s * n[2])
    gz += L.slope * (-s * n[1] + c * n[2])
    if (first) {
      wx = n[1]
      wz = n[2]
      first = false
    }
  }
  return Math.hypot(gx, gz)
}

// 20k samples spread over 8 km of world and 60 s of clock, because the tail is
// what breaks a surface and the mean says nothing about it.
const tilts = []
for (let k = 0; k < 20000; k++) {
  const x = ((k * 2654435761) % 16000) - 8000
  const z = ((k * 40503 + 7919) % 16000) - 8000
  const t = (k % 601) * 0.1
  tilts.push((Math.atan(waveGradient(x, z, t) * WATER.chop) * 180) / Math.PI)
}
tilts.sort((a, b) => a - b)
const median = tilts[tilts.length >> 1]
const p99 = tilts[Math.floor(tilts.length * 0.99)]
const peak = tilts[tilts.length - 1]
check(
  median > 3 && p99 < 35,
  'the waves tilt the surface enough to see and not enough to break',
  `median ${median.toFixed(1)} deg, p99 ${p99.toFixed(1)} deg, peak ${peak.toFixed(1)} deg`
)
// ...and the line above is only worth anything if the field is alive. A port
// that returned a constant would sail through "not enough to break".
check(
  p99 > median * 1.6 && tilts[0] < median * 0.5,
  'the tilt actually varies across the surface rather than sitting at one value',
  `${tilts[0].toFixed(1)} deg calmest, ${peak.toFixed(1)} deg steepest`
)

// The thing this whole rewrite exists to kill: a summed set of periodic
// functions repeats on the lattice of their common period, and the eye finds
// it. Sample one line of water at two points a long way apart and the field
// must not agree with itself.
let worstEcho = Infinity
let echoLag = 0
for (const lag of [52, 104, 546, 1092, 2184]) {
  let sum = 0
  for (let k = 0; k < 4000; k++) {
    const x = ((k * 7919) % 6000) - 3000
    sum += Math.abs(waveGradient(x, 0, 0) - waveGradient(x + lag, 0, 0))
  }
  const meanDiff = sum / 4000
  if (meanDiff < worstEcho) {
    worstEcho = meanDiff
    echoLag = lag
  }
}
check(worstEcho > 0.02, 'the surface does not repeat at any multiple of a layer wavelength', `closest echo at ${echoLag} m still differs by ${worstEcho.toFixed(3)} slope`)

// Four independent knobs per layer, and the point of every one of them is that
// no two layers share it. Two layers on the same lattice angle put an axis back
// into a field whose whole job is not to have one; two on the same offset are
// the same noise twice; two at the same speed and heading move as one slab.
const distinct = (key, get) => {
  const seen = new Set(WAVE_LAYERS.map(get))
  check(seen.size === WAVE_LAYERS.length, `every layer has its own ${key}`, [...seen].join(', '))
}
distinct('lattice rotation', (L) => L.rotate)
distinct('sampling offset', (L) => `${L.offset[0]},${L.offset[1]}`)
// Gradient noise is built on an integer lattice and has a faint plus-shaped
// signature along it. Leaving a layer at rotation 0 lays that signature square
// on world X/Z, aligned with the quads the mesher emits -- which is the tiling
// the noise was brought in to remove, reintroduced by a default.
const nearestAxis = Math.min(...WAVE_LAYERS.map((L) => {
  const m = ((L.rotate % 90) + 90) % 90
  return Math.min(m, 90 - m)
}))
check(nearestAxis > 5, 'no layer lays its noise lattice on the world axes', `closest ${nearestAxis} deg off`)
// A layer sampled at the origin of the noise field is not wrong, but it means
// two layers of similar size can only be told apart by their rotation. The
// offsets are the cheap independence.
check(
  WAVE_LAYERS.every((L) => Math.hypot(L.offset[0], L.offset[1]) > 10),
  'every layer is sampled from somewhere out in the field, not at its origin'
)
distinct('drift heading', (L) => L.heading)
distinct('drift speed', (L) => L.speed)
// Rotation and heading are meant to be unrelated. If they ever track each
// other, a correlation has crept back in behind two knobs that look separate.
const rotSpread = WAVE_LAYERS.map((L) => L.rotate - L.heading)
check(
  new Set(rotSpread).size === WAVE_LAYERS.length,
  'lattice rotation and drift heading are not locked to each other',
  `offsets ${rotSpread.join(', ')} deg`
)

// Every layer must actually move, and the bound is on the layers that carry the
// VISIBLE motion rather than on all five.
//
// The original rule was "no layer takes more than 4 s to cross its own
// wavelength", written when a uniformly physical `flow` had the whole surface
// frozen and the note back was "the large octave ripples appear to not move at
// all!?". That reading was about the surface, and the surface was stationary in
// every octave at once.
//
// The swell is deliberately exempt now. Long waves genuinely do travel slowly
// relative to their own length -- 52 m at 3.4 m/s is 15 s a wavelength -- and
// the surface still reads as moving because the four shorter layers underneath
// it have not changed, so there is no way for this to drift back into the
// failure the rule was written for without the OTHER four also going slack.
// Hence: the largest layer is excused, and every layer that is not the largest
// is held to the original bound. Slowing a second one trips this.
const period = (L) => L.wavelength / (L.speed * WATER.flow)
const swell = WAVE_LAYERS.reduce((a, b) => (a.wavelength > b.wavelength ? a : b))
const carriers = WAVE_LAYERS.filter((L) => L !== swell)
const slowest = Math.min(...carriers.map(period))
const laziest = Math.max(...carriers.map(period))
check(laziest < 4, 'every layer but the swell crosses its own wavelength in a few seconds', `${laziest.toFixed(1)} s slowest, ${slowest.toFixed(1)} s fastest`)
// And the swell must still move at all -- slow is the point, stopped is the bug.
check(period(swell) < 30, 'and the swell itself is slow rather than stopped', `${period(swell).toFixed(1)} s for its 52 m`)

// The noise budget is checked further down, against the ASSEMBLED shader
// rather than against this file: the per-layer terms are emitted at build time
// from WAVE_LAYERS, so none of them appears in the source text here.

// --- see-through only on purpose, and reflecting rather than lit --------------

// TRANSPARENCY IS A KNOB AND ZERO MUST COST NOTHING.
//
// `transparent` is derived from WATER.clarity rather than written as a literal,
// which is the whole guarantee: at 0 the material goes back into the opaque pass
// and the shader's alpha branch does not run, so the pinned look
// (2026-0827-badass-cubemap-v1, design/11-water.md) is reproducible by setting
// one number. A literal `true` here would strand that.
check(waterSrc.includes('transparent: WATER.clarity > 0'), 'seeing into the surface is a knob, and 0 restores the opaque pass')
check(WATER.clarity >= 0 && WATER.clarity < 1, 'and it is a fraction -- 1 would be a hole in the world', `clarity ${WATER.clarity}`)
// depthWrite stays on. This is a sheet, not a cloud: one water fragment per
// pixel, and everything drawn after it -- aurora, stars, markers -- must still be
// occluded by the lake the way it was before the knob existed.
check(waterSrc.includes('depthWrite: true'), 'and the surface still writes depth, so what is behind it stays behind it')
// The divide is what stops the water going dark exactly where it goes clear:
// blending returns src * a, so the reflection has to be pre-scaled back up.
check(/alpha = 1\.0 - uClarity \* \( 1\.0 - f \) \* near/.test(waterSrc), 'clarity is conditioned on both angle and distance')
check(/color \/= alpha/.test(waterSrc), 'and the surface light is pre-divided so transparency does not dim the reflection')
check(
  !/MeshStandardMaterial|MeshLambertMaterial/.test(waterSrc),
  'the surface is not a lit PBR material pretending to be water'
)
check(waterSrc.includes('wlBlocked('), 'the reflection is occluded by the terrain horizon')

// --- the assembled source -----------------------------------------------------
//
// The fragment shader is three chunks concatenated -- the sky, the horizon
// sampler, the waves -- plus three's own fog includes. Concatenation has exactly
// two ways to fail and both are compile errors that only a GPU would report, and
// there is no GPU here: a uniform declared twice, and a uniform referenced but
// never declared. Both are cheap to find by resolving the includes the way
// WebGLProgram does and reading the result.
//
// This is NOT a GLSL parser and does not pretend to be one. It cannot tell you
// the shader is correct, only that it is not broken in the two ways that
// assembling a shader out of pieces breaks it.
{
  const THREE = await import('three')
  const { Water } = await import('../src/water.js')
  const { Sky } = await import('../src/sky.js')
  const { WorldLighting } = await import('../src/lighting.js')
  const { SkyProbe } = await import('../src/sky-probe.js')
  const { WorldProbe } = await import('../src/world-probe.js')

  const scene = new THREE.Scene()
  const water = new Water(scene, { sky: new Sky(scene), lighting: new WorldLighting(), probe: new SkyProbe(), world: new WorldProbe() })

  const resolve = (src) => {
    let out = src
    for (let pass = 0; pass < 8; pass++) {
      const next = out.replace(/#include <(\w+)>/g, (m, name) => THREE.ShaderChunk[name] ?? m)
      if (next === out) break
      out = next
    }
    return out
  }

  for (const [stage, raw] of [
    ['vertex', water.material.vertexShader],
    ['fragment', water.material.fragmentShader],
  ]) {
    const src = resolve(raw)
    check(!/#include </.test(src), `${stage}: every three include resolves`,
      (src.match(/#include <\w+>/g) ?? []).join(' '))

    const opens = (src.match(/\{/g) ?? []).length
    const closes = (src.match(/\}/g) ?? []).length
    check(opens === closes, `${stage}: braces balance`, `${opens} open, ${closes} close`)

    // Declared twice is a compile error; three declares fog's own uniforms in
    // its chunks, and the sky and lighting blocks each declare their own.
    const declared = [...src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm)].map((m) => m[1])
    const dupes = declared.filter((d, i) => declared.indexOf(d) !== i)
    check(dupes.length === 0, `${stage}: no uniform is declared twice`, [...new Set(dupes)].join(', '))

    // Declared but never supplied means a silent zero -- a black lake, or a
    // reflection frozen at midnight, with no error anywhere.
    const builtin = new Set(['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix',
      'normalMatrix', 'cameraPosition', 'isOrthographic', 'logDepthBufFC'])
    const missing = declared.filter((d) => !(d in water.material.uniforms) && !builtin.has(d))
    check(missing.length === 0, `${stage}: every declared uniform has a value`, missing.join(', '))

    // USE BEFORE DECLARATION, which is the one that actually cost a release.
    //
    // GLSL wants declaration first, and JS does not, so main() reads as if it
    // were fine right up until the driver refuses it. What that looks like from
    // the outside is worth stating plainly: a ShaderMaterial that fails to
    // compile does not draw a dimmer lake or an untextured one, it draws
    // NOTHING. Every check above passed on a shader that rendered no pixels,
    // because every one of them asks about uniforms and none of them asks
    // whether the body is legal.
    //
    // Narrow on purpose, and that is what keeps it free of false positives: it
    // only considers names it has already seen DECLARED inside main, so
    // uniforms, varyings, built-ins and function names are not candidates. It
    // takes each name's FIRST declaration, so the same local reused in two
    // disjoint blocks -- which the wave layers do, with 'q' -- is not an error.
    // Comments are stripped first or a comment naming a variable above its own
    // declaration would fail it, which is exactly how the real bug read.
    //
    // It does not catch a name declared inside a nested block and used after
    // that block closes. That is a different error and this does not claim it.
    const mainAt = src.indexOf('void main(')
    let body = ''
    if (mainAt >= 0) {
      const open = src.indexOf('{', mainAt)
      let depth = 0
      let i = open
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) break
      }
      // Blanked rather than removed, so offsets keep meaning something.
      body = src.slice(open, i).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/\S/g, ' '))
                              .replace(/\/\/[^\n]*/g, (m) => m.replace(/\S/g, ' '))
    }
    const TYPES = 'float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|mat2|mat3|mat4'
    const firstDecl = new Map()
    for (const m of body.matchAll(new RegExp(`\\b(?:${TYPES})\\s+(\\w+)\\s*(?:=|;|\\[)`, 'g'))) {
      const namePos = m.index + m[0].indexOf(m[1])
      if (!firstDecl.has(m[1])) firstDecl.set(m[1], namePos)
    }
    const early = []
    for (const [name, declPos] of firstDecl) {
      const use = body.search(new RegExp(`\\b${name}\\b`))
      if (use >= 0 && use < declPos) early.push(name)
    }
    check(mainAt >= 0 && early.length === 0,
      `${stage}: no local is used above the line that declares it`,
      mainAt < 0 ? 'no main() found' : early.length ? `${early.join(', ')} used before declared` : `${firstDecl.size} locals, all declared first`)
  }

  // The reverse direction: a uniform supplied but not mentioned anywhere means a
  // rename happened on one side only, which is silent -- three simply does not
  // upload it and the shader reads whatever the old name still holds.
  //
  // MENTIONED, not read: a bare declaration satisfies this, so it does not prove
  // the value is used, only that the name still exists on both sides.
  const all = resolve(water.material.vertexShader) + resolve(water.material.fragmentShader)
  const unread = Object.keys(water.material.uniforms).filter(
    (k) => !new RegExp(`\\b${k}\\b`).test(all)
  )
  check(unread.length === 0, 'every supplied uniform is named in the shader source', unread.join(', '))

  // Noise is the expensive part of this shader and there is no profiler in
  // node, so the budget is enforced by counting instead. Four is what the
  // layer table asks for; a fifth arriving by accident -- a copy-pasted term,
  // a debug tap left in -- is a 25% fragment cost rise nobody chose.
  const frag = water.material.fragmentShader
  const noiseCalls = (frag.match(/wNoise\(/g) ?? []).length - 1 // minus the definition
  check(noiseCalls === WAVE_LAYERS.length,
    'the fragment shader evaluates the noise once per layer and no more',
    `${noiseCalls} calls, ${WAVE_LAYERS.length} layers`)

  // ...and the detail layers must sit behind the distance branch, or the far
  // half of every lake pays for ripples it is too far away to resolve. The
  // branch is coherent -- neighbouring fragments are at neighbouring distances
  // -- which is the only reason a branch is the right tool here at all.
  //
  // Brace-matched rather than regexed to a closing indent: the layer terms are
  // emitted with their own nesting, so "the next line starting with a brace" is
  // whichever inner block happens to end first, and a lazy match quietly finds
  // one detail layer instead of two -- passing for the wrong reason if the
  // count were not also asserted.
  const at = frag.indexOf('if ( near >')
  let body = ''
  if (at >= 0) {
    const open = frag.indexOf('{', at)
    let depth = 0
    let i = open
    for (; i < frag.length; i++) {
      if (frag[i] === '{') depth++
      else if (frag[i] === '}' && --depth === 0) break
    }
    body = frag.slice(open, i)
  }
  const inBranch = (body.match(/wNoise\(/g) ?? []).length
  const detailLayers = WAVE_LAYERS.filter((L) => L.detail).length
  check(at >= 0 && inBranch === detailLayers,
    'the detail layers are skipped at distance rather than computed and faded',
    at < 0 ? 'no distance branch found' : `${inBranch} of ${detailLayers} inside the branch`)

  // --- the sky probe ----------------------------------------------------------
  //
  // Everything here fails silently and photogenically. A probe that captures
  // the wrong layers gives a lake reflecting the terrain; one whose cameras
  // were never oriented gives five copies of the same slice of sky; one that
  // leaves scene.background set gives a lake full of flat fog grey. All of them
  // still look like water.
  const { SkyProbe: Probe, PROBE_LAYER, PROBE } = await import('../src/sky-probe.js')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
  const probeSrc = fs.readFileSync(path.join(ROOT, 'src', 'sky-probe.js'), 'utf8')
  const p = new Probe()

  // THE LAYER TRAP. three's XR manager does cameraL.layers.mask &= 0b011 and
  // cameraR &= 0b101, so layers 1 and 2 belong to the eyes and the mask is
  // three bits wide. An object on layer 1 or 2 renders to ONE eye, which in a
  // headset reads as a headache rather than as a bug; on layer 0 the probe
  // would capture the whole world.
  check(PROBE_LAYER > 2, 'the probe layer is clear of the eye layers three reserves', `layer ${PROBE_LAYER}`)
  check(p.rig.layers.mask === (1 << PROBE_LAYER),
    'the probe camera sees its own layer and nothing else',
    `mask ${p.rig.layers.mask.toString(2)}`)

  // ...and the aurora must be ADDED to that layer, not moved to it. `set`
  // clears layer 0, and the meshes vanish from both eyes while the probe keeps
  // working perfectly.
  const meshA = new THREE.Object3D()
  const meshB = new THREE.Object3D()
  Probe.include(meshA, meshB)
  check(meshA.layers.test(new THREE.Layers()) && meshA.layers.mask === (1 | (1 << PROBE_LAYER)),
    'included objects keep layer 0 and gain the probe layer',
    `mask ${meshA.layers.mask.toString(2)}`)
  // The aurora ALONE. Stars are points, and gl_PointSize counts framebuffer
  // pixels rather than angle -- the 1.1 to 4.5 px speck that is right on a screen
  // spans 1.5 to 6.3 degrees of a 64 px cube face, against the ~0.05 degrees a
  // real star has. 2400 of those is a lake reflecting gravel. Asserted negatively
  // as well, because putting them back is a one-word edit that looks harmless.
  check(/SkyProbe\.include\(\s*aurora\.mesh\s*\)/.test(mainSrc),
    'main.js captures the aurora, which is the only thing worth capturing')
  check(!/stars\.points/.test(mainSrc.slice(mainSrc.indexOf('SkyProbe.include'), mainSrc.indexOf('SkyProbe.include') + 60)),
    'and not the stars, which have no angular size a 64 px face can represent')

  // Half float, because the aurora's dim end lives below one 8-bit step and
  // quantising it would plate the curtain in the water while looking fine in
  // the sky.
  check(p.target.texture.type === THREE.HalfFloatType, 'the capture is half float, not 8-bit')

  // Drive it with a stub renderer. No GL needed to prove the bookkeeping, and
  // the bookkeeping is where the silent failures are.
  const scene2 = new THREE.Scene()
  scene2.background = new THREE.Color(0x9db4cf)
  const seen = []
  let backgroundDuringRender = 'never rendered'
  const stub = {
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: true },
    getRenderTarget: () => null,
    getClearColor: (c) => c.setHex(0x123456),
    getClearAlpha: () => 1,
    setClearColor: () => {},
    setRenderTarget: (t, face) => seen.push(face),
    clear: () => {},
    render: (s, cam) => {
      backgroundDuringRender = s.background
      seen[seen.length - 1] = { face: seen[seen.length - 1], dir: cam.getWorldDirection(new THREE.Vector3()), xr: stub.xr.enabled }
    },
  }
  const head = new THREE.Vector3(10, 2, -30)
  // Enough ticks to go all the way round the face cycle, at the real cadence.
  for (let k = 0; k < PROBE.everyNFrames * 5; k++) p.update(stub, scene2, head)
  const captures = seen.filter((s) => typeof s === 'object')

  check(captures.length === 5, 'one face per update, five updates to go round', `${captures.length} captures in ${PROBE.everyNFrames * 5} frames`)
  check(scene2.background !== null && backgroundDuringRender === null,
    'scene.background is suppressed during the capture and restored after',
    `during: ${backgroundDuringRender}, after: ${scene2.background ? 'restored' : 'LOST'}`)
  check(stub.xr.enabled === true, 'renderer.xr is switched back on afterwards')
  check(captures.every((c) => c.xr === false), 'and off during the capture, so three uses this camera rather than the eyes')

  // The face cycle must cover five DISTINCT faces and skip -Y (index 3). Water
  // folds the reflected ray into the upper hemisphere, so -Y is never sampled
  // -- but if either side of that ever changes alone, the lake gets a black
  // band where the aurora should be.
  const faces = captures.map((c) => c.face)
  check(new Set(faces).size === 5 && !faces.includes(3),
    'the cycle covers five distinct faces and skips the one facing down',
    `faces ${faces.join(', ')}`)
  check(/if \( R\.y < 0\.0 \) R\.y = -R\.y;/.test(waterSrc),
    'and the water folds its reflected ray up, so it never asks for that face')

  // THE ORIENTATION TRAP. CubeCamera leaves all six cameras unrotated until
  // updateCoordinateSystem() runs, which only its own update() calls. Miss it
  // and every face captures the same slice of sky -- uniformly wrong, nothing
  // obviously broken, and the reflection just never quite matches.
  const axes = captures.map((c) => `${Math.round(c.dir.x)},${Math.round(c.dir.y)},${Math.round(c.dir.z)}`)
  check(new Set(axes).size === 5, 'the five cameras point five different ways', axes.join('  '))
  check(axes.includes('1,0,0') && axes.includes('-1,0,0') && axes.includes('0,1,0')
     && axes.includes('0,0,1') && axes.includes('0,0,-1'),
    'and they are the five axes the cube faces want', axes.join('  '))

  // The capture carries additive light, so it is ADDED. Mixing it would replace
  // the analytic sky with a 64-pixel copy of nothing wherever the aurora is not.
  check(/refl \+= texture\( uProbe, R \)/.test(waterSrc),
    'the water adds the captured light rather than mixing toward it')
  // Nothing but the two additive meshes belongs in the capture: it is cleared
  // to transparent black, and black is the honest value for "no aurora here".
  check(/setClearColor\(\s*0x000000,\s*0\s*\)/.test(probeSrc),
    'the capture is cleared to transparent black, which is the absence of aurora')

  // Ordering in the frame loop. The probe binds a render target and toggles xr
  // off; doing that after the XR framebuffer is bound puts the frame in the
  // wrong buffer, and on a desktop canvas it would look completely fine.
  check(mainSrc.indexOf('probe.update(') < mainSrc.indexOf('renderer.render(scene, camera)'),
    'the probe runs before the frame is drawn, not after')

  // --- the mountain silhouette's darkness --------------------------------------
  //
  // The silhouette has to be as dark as the darkest terrain on screen, and
  // water.js works that out by REPLICATING three's Lambert indirect path on the
  // CPU. A replicated formula is a copy, and copies drift: three could change a
  // chunk in a minor release, or lighting.js could change what it multiplies,
  // and the only symptom would be a silhouette that is quietly the wrong
  // brightness -- which is the exact bug this was written to fix.
  //
  // So the formula is pinned to its sources on both sides. These are string
  // matches against three's own chunks rather than a re-derivation, because
  // re-deriving it here would just be the same guess written twice.
  const { ShaderChunk } = THREE
  check(/hemiDiffuseWeight\s*=\s*0\.5\s*\*\s*dotNL\s*\+\s*0\.5/.test(ShaderChunk.lights_pars_begin)
    && /mix\(\s*hemiLight\.groundColor,\s*hemiLight\.skyColor,\s*hemiDiffuseWeight\s*\)/.test(ShaderChunk.lights_pars_begin),
    'three still blends the hemisphere ground-to-sky by 0.5 * dot( N, up ) + 0.5')
  check(/BRDF_Lambert\([^)]*\)\s*\{\s*return\s+RECIPROCAL_PI\s*\*\s*diffuseColor/.test(ShaderChunk.common),
    'three still divides the Lambert albedo by PI')
  check(/reflectedLight\.indirectDiffuse\s*\+=\s*irradiance\s*\*\s*BRDF_Lambert\(\s*material\.diffuseColor\s*\)/
    .test(ShaderChunk.lights_lambert_pars_fragment),
    'three still builds indirect diffuse as irradiance times the Lambert BRDF')

  // ...and the other half of the formula, which is ours.
  const lightingSrc = fs.readFileSync(path.join(ROOT, 'src', 'lighting.js'), 'utf8')
  check(/reflectedLight\.indirectDiffuse \*= \$\{sky\}/.test(lightingSrc.replace(/wlSkyF/g, '${sky}'))
    || /indirectDiffuse \*= wlSkyF/.test(lightingSrc),
    'lighting.js still scales the ambient by the floored sky term')
  check(/indirectDiffuse \+= uNightLift \* wlSkyF/.test(lightingSrc),
    'lighting.js still ADDS the night lift, so the silhouette must add it too')

  // The palette end: the darkest colour must come from the palette, not from a
  // number written down beside it.
  const { TERRAIN_DARKEST, luminance: lum } = await import('../src/terrain/terrain-material.js')
  const matSrc = fs.readFileSync(path.join(ROOT, 'src', 'terrain', 'terrain-material.js'), 'utf8')
  const palette = [...matSrc.matchAll(/^const (\w+) = new THREE\.Color\(([\d.]+), ([\d.]+), ([\d.]+)\)/gm)]
    .map((m) => ({ name: m[1], l: 0.2126 * +m[2] + 0.7152 * +m[3] + 0.0722 * +m[4] }))
  const darkest = palette.reduce((a, b) => (a.l <= b.l ? a : b))
  check(Math.abs(lum(TERRAIN_DARKEST) - darkest.l) < 1e-9,
    'the exported darkest albedo really is the darkest colour in the palette',
    `${darkest.name} at ${darkest.l.toFixed(4)}`)

  // And the behaviour, end to end -- driven by the REAL palette at a real sun
  // elevation, not by numbers invented here. Inventing them is how a check ends
  // up asserting something true of a lighting state the world never enters.
  const { paletteAt } = await import('../src/clock.js')
  const hemi = new THREE.HemisphereLight()
  const setSRGB = (c, [r, g, b]) => c.setRGB(r, g, b, THREE.SRGBColorSpace)

  // Exactly what applySky and lighting.update do with a palette, in the same
  // order, so this measures the pipeline rather than a rehearsal of it.
  const atElev = (sunElevDeg) => {
    const p = paletteAt(sunElevDeg)
    setSRGB(hemi.color, p.hemiSky)
    setSRGB(hemi.groundColor, p.hemiGround)
    hemi.intensity = p.hemiIntensity
    setSRGB(water.night.lift.value, p.skyGlow)
    water.night.lift.value.multiplyScalar(p.skyGlowAmt)
    water.night.far.value.y = p.farAmbient
    water.update(0, hemi)

    const lift = water.night.lift.value
    const c = new THREE.Color().copy(hemi.groundColor).lerp(hemi.color, 0.5)
      .multiplyScalar(p.hemiIntensity).multiply(TERRAIN_DARKEST).multiplyScalar(1 / Math.PI)
    return {
      p,
      got: lum(water.uniforms.uSilTint.value),
      want: (lum(c) + lum(lift)) * p.farAmbient,
      tint: lum(water.uniforms.uTint.value),
    }
  }

  const noon = atElev(60)
  check(Math.abs(noon.got - noon.want) < 1e-9,
    'by day the silhouette lands exactly on the darkest shadowed terrain',
    `${noon.got.toExponential(3)} vs ${noon.want.toExponential(3)}`)

  const dusk = atElev(-4)
  check(Math.abs(dusk.got - dusk.want) < 1e-9,
    'and at dusk, where the night lift starts carrying the answer',
    `${dusk.got.toExponential(3)} vs ${dusk.want.toExponential(3)}`)

  // The failure being fixed: it used to be a fraction of the horizon's
  // luminance, which is the brightest part of the sky and left the silhouette
  // visibly lighter than the terrain casting it. It must track the AMBIENT now,
  // and the ambient falls by more than a factor of ten between these two.
  // Swept rather than spot-checked, because two hand-picked hours cannot show
  // that a formula holds -- only that it holds twice. The claim is that the
  // silhouette IS the reference brightness at every sun elevation the world
  // passes through, and that it never exceeds its noon value along the way.
  //
  // Note what is deliberately NOT asserted: monotonicity. The measured curve
  // rises by about 0.4% of noon during twilight, because skyGlowAmt climbs
  // faster than hemiIntensity falls for a few degrees around sunset. That is
  // the palette's behaviour and the TERRAIN does exactly the same thing there,
  // so the silhouette following it is the whole point. Asserting monotonicity
  // would be asserting something truer than the thing being matched.
  let worstErr = 0
  let brightest = 0
  for (let e = 60; e >= -40; e -= 0.5) {
    const r = atElev(e)
    worstErr = Math.max(worstErr, Math.abs(r.got - r.want))
    brightest = Math.max(brightest, r.got)
  }
  check(worstErr < 1e-9,
    'and at every sun elevation in between, not just at the two checked above',
    `worst error ${worstErr.toExponential(2)} over 201 elevations`)
  check(brightest <= noon.got,
    'the silhouette is never brighter than it is at noon',
    `peak ${brightest.toExponential(3)}, noon ${noon.got.toExponential(3)}`)
  check(dusk.got < noon.got * 0.4,
    'and it has fallen well down before the sun is even properly set',
    `noon ${noon.got.toExponential(2)}, dusk ${dusk.got.toExponential(2)}`)

  // ...all the way to actual black. farAmbient reaches 0 at full dark, which is
  // the rule that takes the distant terrain to black -- and the silhouette IS
  // distant terrain, so it must go with it. This is deliberately the opposite
  // of the water's FOG, which is exempt from that rule: fog is what the far
  // water fades to, and a lake at night is a mirror of the sky, not a shadow.
  const midnight = atElev(-40)
  check(midnight.p.farAmbient === 0 && midnight.got === 0,
    'and at full dark it is black, because the terrain it is standing in for is',
    `farAmbient ${midnight.p.farAmbient}, silhouette ${midnight.got}`)
  check(!/uHorizon/.test(water.material.fragmentShader.slice(
    water.material.fragmentShader.indexOf('float blocked'),
    water.material.fragmentShader.indexOf('uProbe, R'))),
    'and it is no longer derived from the sky horizon at all')

  // Hue survives the rescale, or the mountain stops being blue. Read at noon:
  // at midnight the colour is legitimately (0, 0, 0) and has no ratios.
  atElev(60)
  const hue = new THREE.Color(WATER.silhouetteTint)
  const got = water.uniforms.uSilTint.value
  check(Math.abs(got.r / got.b - hue.r / hue.b) < 1e-6 && Math.abs(got.g / got.b - hue.g / hue.b) < 1e-6,
    'only the brightness is replaced -- the hue is still WATER.silhouetteTint',
    `${got.r.toExponential(2)}, ${got.g.toExponential(2)}, ${got.b.toExponential(2)}`)

  // --- the body tint, which is the OTHER half of how dark a night lake is -----
  //
  // A correct silhouette is not enough on its own and that is worth spelling
  // out, because it was the bug: the shader composites mix( body, refl, mirror
  // ), so the (1 - mirror) share of the body colour reaches the eye at every
  // viewing angle. A constant body colour is therefore a floor under the whole
  // lake, and at full dark -- where the silhouette is legitimately zero -- that
  // floor is 100% of what is left. Measured before the fix, a blocked patch of
  // water was 1.29x brighter at noon than at midnight. It should be more like
  // an order of magnitude.
  const dayTint = new THREE.Color(WATER.tint)
  check(Math.abs(atElev(90).tint - lum(dayTint)) < 1e-9,
    'by day the body tint is exactly the colour WATER.tint was authored as',
    `${atElev(90).tint.toExponential(4)} vs ${lum(dayTint).toExponential(4)}`)

  // The reference is read out of the clock's own noon keyframe, so retuning the
  // palette moves both ends together and daylight water stays where it was
  // tuned. Pinned here so that stops being true loudly.
  const noonPal = paletteAt(90)
  const ambNoon = lum(setSRGB(new THREE.Color(), noonPal.hemiSky).multiplyScalar(noonPal.hemiIntensity))
  let worstTint = 0
  let darkestTint = Infinity
  for (let e = 90; e >= -40; e -= 0.5) {
    const r = atElev(e)
    const amb = lum(setSRGB(new THREE.Color(), r.p.hemiSky).multiplyScalar(r.p.hemiIntensity))
    worstTint = Math.max(worstTint, Math.abs(r.tint - lum(dayTint) * (amb / ambNoon)))
    darkestTint = Math.min(darkestTint, r.tint)
  }
  check(worstTint < 1e-9,
    'and at every other hour it is that colour times the sky it actually has',
    `worst error ${worstTint.toExponential(2)} over 261 elevations`)
  check(darkestTint < lum(dayTint) * 0.2,
    'so the body of the water goes properly dark after sunset instead of holding a floor',
    `noon ${lum(dayTint).toExponential(2)}, darkest ${darkestTint.toExponential(2)},` +
    ` ${(lum(dayTint) / darkestTint).toFixed(1)}x`)

  // ...and the shader side of the same argument. The body has to be taken to
  // the silhouette colour by `blocked` as well, or a fully occluded patch is
  // still (1 - mirror) * uTint no matter how dark the silhouette is -- which at
  // noon left it three times brighter than the darkest terrain on screen. With
  // both sides at the silhouette the composite is the silhouette for ANY Fresnel
  // value, which is what makes the match hold at grazing angles too.
  //
  // `land.rgb` rather than `uSilTint` since the world probe landed: it is
  // worldSilhouette's return, which IS uSilTint wherever the capture has no
  // colour of its own, so the invariant is unchanged and the colour is better
  // where there is one. What matters is that both sides read the same thing.
  check(/vec3 body = mix\( uTint, land\.rgb, blocked \);/.test(frag)
    && /refl = mix\( refl, land\.rgb, blocked \);/.test(frag)
    && /vec3 color = mix\( body, refl, mirror \);/.test(frag),
    'a fully blocked patch composites to the silhouette at every viewing angle',
    'both sides of the Fresnel mix are taken to the same silhouette colour')

  // And that silhouette really does fall back to uSilTint where the capture is
  // empty -- the line that keeps a far ridge the cube barely resolves from
  // reading as a hole of sky in the middle of a mountain.
  check(/return vec4\( mix\( uSilTint, wc\.rgb, cover \), max\( ridge, cover \) \);/.test(frag),
    'and it falls back to uSilTint where the world capture has no colour, taking the MAX of the two coverages',
    'a capture with 128 px cannot be allowed to argue a mountain away')

  // --- the glint lobe ----------------------------------------------------------
  //
  // The two exponents are named knobs now because the distant one is being
  // tuned by eye, and the thing that is easy to get wrong by eye is that these
  // are exponents and the user is looking at an angle. For pow( cos t, n ) the
  // half-maximum half-angle is sqrt( 2 ln2 / n ), so apparent size goes as
  // 1 / sqrt( n ): halving the distant sun costs 4x here, not 2x. This check
  // exists so the comment in WATER cannot drift away from the arithmetic.
  const halfAngle = (n) => Math.sqrt((2 * Math.LN2) / n) * (180 / Math.PI)
  check(Math.abs(halfAngle(WATER.sharpFar / 4) / halfAngle(WATER.sharpFar) - 2) < 1e-12,
    'four times the exponent really is half the angular radius',
    `${WATER.sharpFar} -> ${halfAngle(WATER.sharpFar).toFixed(2)} deg,` +
    ` ${WATER.sharpFar / 4} -> ${halfAngle(WATER.sharpFar / 4).toFixed(2)} deg`)
  check(WATER.sharpNear > WATER.sharpFar,
    'and near water still gets the tighter lobe than far water',
    `far ${WATER.sharpFar}, near ${WATER.sharpNear}`)
  check(/float sharp = mix\( uSharp\.x, uSharp\.y, near \* near \);/.test(frag)
    && water.uniforms.uSharp.value.x === WATER.sharpFar
    && water.uniforms.uSharp.value.y === WATER.sharpNear,
    'and the shader reads them from WATER rather than carrying its own copies')

  // THE LAND MAY NOT OUT-BRIGHTEN THE LAKE.
  //
  // lighting.js ends its aerial in-scatter ramp at fogColor dimmed by
  // AIR_CEILING, which exists to be the same light loss water.js puts on its own
  // far target -- a distant water pixel is skyRadiance(horizon) * uReflTint, and
  // fogColor is that same horizon sky. Aimed anywhere brighter, a 5 km ridge
  // comes out lighter than the water in front of it. AIR_CEILING is a copy
  // rather than an import because water.js imports lighting.js; this is what
  // stops the copy drifting.
  const { AIR_CEILING } = await import('../src/lighting.js')
  const refl = water.uniforms.uReflTint.value
  check(
    Math.abs(AIR_CEILING.r - refl.r) < 1e-12
      && Math.abs(AIR_CEILING.g - refl.g) < 1e-12
      && Math.abs(AIR_CEILING.b - refl.b) < 1e-12,
    'the aerial ramp ends on exactly the light a reflection loses',
    `AIR_CEILING ${AIR_CEILING.getHexString()} vs uReflTint ${refl.getHexString()}`
  )
  check(AIR_CEILING.r < 1 && AIR_CEILING.g < 1 && AIR_CEILING.b < 1,
    'so distant land lands below the sky rather than on it')
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
process.exit(failures ? 1 : 0)
