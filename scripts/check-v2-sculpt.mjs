// Gate for the §18 terrain brush (src/v2/height/sculpt.js) and for the PNG
// encoder it writes through (src/v2/height/png.js).
//
//   node scripts/check-v2-sculpt.mjs
//
// The brush is the one v2 tool that edits the IMPORT rather than a document, so
// its failures are not "the lake is in the wrong place" -- they are texels of
// public/world/height.png that are quietly wrong and that Save then commits over
// the only copy. Four of those failures look identical on screen to a brush that
// is merely slow, which is why they are asserted here rather than eyeballed:
//
//   a falloff with a non-zero derivative at the rim -- a crease ring per stamp,
//     invisible at chunk LOD and obvious at 25 cm cells
//   a rect that is too small -- a ring of ground still meshed against heights
//     that are no longer there, right where the brush edge draws the eye
//   smooth blurring IN PLACE -- a directional smear that runs whichever way the
//     loop does, not a blur
//   a stroke run past the encoding's ceiling -- correct on screen until Save,
//     then a flattened summit on reload
//
// Everything here runs against a SYNTHETIC heightmap rather than the shipped
// one: the brush must be right on any grid, and a gate that only passes at
// 8 m/texel would go green on a re-bake that changed the resolution.

import { EventEmitter } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WORLD_HALF, WORLD_SIZE } from '../src/v2/config.js'
import { Heightmap } from '../src/v2/height/heightmap.js'
import { decodePng, encodePng } from '../src/v2/height/png.js'
import { brushRect, falloff, readRect, rectToWorld, stamp, unionRect, SCULPT_MODES } from '../src/v2/height/sculpt.js'
// Browser-side, but only in the sense that a pointer drives it: no DOM, no
// three, no worker. It reaches the workers through an injected terrain, which is
// what lets the stroke/undo bookkeeping -- the part with state in it -- be
// checked here rather than by dragging a mouse and hoping.
import { Sculptor } from '../src/v2/edit/sculptor.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const near = (a, b, tol) => Math.abs(a - b) <= tol

const META = { world: WORLD_SIZE, minY: -100, maxY: 900, encoding: 'rg16', exaggeration: 1 }

// 257 across the 8192 m world is 32 m a texel: fine enough that a 200 m brush
// covers a dozen texels each way (so falloff and rect padding are measurable),
// coarse enough that a whole-field round trip through the PNG codec is fast.
const N = 257
const TEXEL = WORLD_SIZE / (N - 1)

function makeField(fn) {
  const data = new Float32Array(N * N)
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) data[j * N + i] = fn(i, j)
  }
  return Heightmap.fromRaw({ width: N, height: N, data, meta: META })
}

const flat = (v = 0) => makeField(() => v)
const at = (hm, i, j) => hm.field[j * hm.width + i]
// Texel (i, j) sits at this world position -- the same mapping brushRect and
// stamp use, written out once so a sign error here cannot agree with a sign
// error there.
const worldOf = (i) => i * TEXEL - WORLD_HALF

// --- section 1: the falloff --------------------------------------------------

function sectionFalloff() {
  console.log('\nfalloff: smoothstep from the rim in, flat at both ends')

  check(falloff(0) === 1, 'falloff is 1 at the centre')
  check(falloff(1) === 0, 'falloff is 0 at the rim')
  check(falloff(1.5) === 0 && falloff(-0.2) === 1, 'falloff clamps outside 0..1', 'a brush does not dig outside its own radius')
  check(near(falloff(0.5), 0.5, 1e-12), 'falloff is 0.5 half way out')

  let monotone = true
  let prev = falloff(0)
  for (let k = 1; k <= 200; k++) {
    const v = falloff(k / 200)
    if (v > prev + 1e-12) monotone = false
    prev = v
  }
  check(monotone, 'falloff never rises on the way out')

  // THE POINT OF THE SECTION. A cone falls off at a constant -1 and leaves a
  // slope discontinuity in a circle around every stamp. smoothstep's derivative
  // is 0 at BOTH ends, so stamps blend into the ground and into each other.
  const h = 1e-4
  const dRim = (falloff(1) - falloff(1 - h)) / h
  const dCentre = (falloff(h) - falloff(0)) / h
  check(Math.abs(dRim) < 1e-3, 'the derivative at the rim is ~0', `d=${dRim.toExponential(2)} (a cone would be -1)`)
  check(Math.abs(dCentre) < 1e-3, 'the derivative at the centre is ~0', `d=${dCentre.toExponential(2)}`)
  // A middle slope near -1.5 is what says this is smoothstep and not something
  // flat everywhere -- zero derivatives at both ends are also true of a constant.
  const dMid = (falloff(0.5 + h) - falloff(0.5 - h)) / (2 * h)
  check(near(dMid, -1.5, 1e-3), 'the derivative half way out is -1.5', `d=${dMid.toFixed(4)}`)
}

// --- section 2: the rect the brush can touch ---------------------------------

function sectionRect() {
  console.log('\nbrushRect: every texel within the radius, clamped to the grid')

  const hm = flat()
  const radius = 200

  // OFF CENTRE, AND ON DIFFERENT COORDINATES IN X AND Z. The first version of
  // this section brushed at the origin, where x and z are both 0 and swapping
  // them is undetectable -- an axis mix-up passed every check in the file. Here
  // (1024, -2048) is texel (160, 64), and nothing about it is symmetric.
  const BX = 1024
  const BZ = -2048
  const ci = (BX + WORLD_HALF) / TEXEL
  const cj = (BZ + WORLD_HALF) / TEXEL
  const r = brushRect(hm, BX, BZ, radius)
  const ru = radius / TEXEL
  check(r !== null, 'a brush inside the world has a rect')
  check(
    r.i0 <= ci - ru && r.i1 > ci + ru && r.j0 <= cj - ru && r.j1 > cj + ru,
    'the rect covers every texel inside the radius',
    `${JSON.stringify(r)} vs +-${ru.toFixed(2)} texels of ${ci},${cj}`
  )
  // ON ALL FOUR SIDES, and the sides are checked one at a time. `smooth` reads a
  // 3x3 stencil around every texel it writes, and that stencil is taken from
  // inside the rect -- so a rect that stops at the radius on one side blurs the
  // rim texels there against a truncated neighbourhood, which is a faint bright
  // edge on one side of every smoothed hollow and nothing on the other three.
  check(
    BX - worldOf(r.i0) >= radius && worldOf(r.i1 - 1) - BX >= radius,
    'the rect reaches a padding texel past the radius on both X sides',
    `${(BX - worldOf(r.i0)).toFixed(0)} m / ${(worldOf(r.i1 - 1) - BX).toFixed(0)} m vs r=${radius}`
  )
  check(
    BZ - worldOf(r.j0) >= radius && worldOf(r.j1 - 1) - BZ >= radius,
    'and on both Z sides',
    `${(BZ - worldOf(r.j0)).toFixed(0)} m / ${(worldOf(r.j1 - 1) - BZ).toFixed(0)} m`
  )
  // And no more than that. A rect that grew without bound would satisfy every
  // line above and remesh the continent on every stamp.
  check(
    r.i0 >= Math.ceil(ci - ru - 1) && r.i1 <= Math.floor(ci + ru + 1) + 1,
    'the padding is one texel, not an unbounded margin',
    `${r.i1 - r.i0} texels across for a ${(2 * ru).toFixed(1)}-texel circle`
  )

  // Exhaustive: no texel outside the returned rect is within the radius. This is
  // the assertion that a sign flip or an off-by-one on the world mapping fails.
  let outside = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const inside = i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1
      if (inside) continue
      if (Math.hypot(worldOf(i) - BX, worldOf(j) - BZ) < radius) outside++
    }
  }
  check(outside === 0, 'no texel within the radius is left outside the rect', `${outside} missed`)

  const corner = brushRect(hm, -WORLD_HALF, -WORLD_HALF, radius)
  check(corner.i0 === 0 && corner.j0 === 0, 'a brush on the -X/-Z corner clamps to texel 0')
  check(corner.i1 > 0 && corner.i1 < N, 'and still has a rect to stamp')

  const far = brushRect(hm, WORLD_HALF, WORLD_HALF, radius)
  check(far.i1 === N && far.j1 === N, 'a brush on the +X/+Z corner clamps to the last texel', JSON.stringify(far))

  // Not an edge case that never happens: the world box is square and the
  // import's mirror bands run off both Z edges, so strokes near a corner are
  // routinely half outside and a stroke fully outside must not throw.
  check(brushRect(hm, -WORLD_HALF - 5000, 0, radius) === null, 'a brush entirely off the grid returns null')

  let threw = false
  try {
    brushRect(hm, 0, 0, 0)
  } catch {
    threw = true
  }
  check(threw, 'a radius of 0 throws rather than stamping nothing', 'fail explicitly')
}

// --- section 3: rects out to the world, and back -----------------------------

function sectionWorldRect() {
  console.log('\nrectToWorld / unionRect / readRect')

  const hm = flat()
  const rect = { i0: 10, j0: 20, i1: 14, j1: 26 }
  const w = rectToWorld(hm, rect)

  // WIDENED BY THE SAMPLING STENCIL, not by the texels. Heightmap.sample is
  // Catmull-Rom, so a moved texel is read by every sample within 2 texels of it;
  // handing TerrainV2 the bare texel box would leave a 2-texel ring meshed
  // against heights that are no longer there.
  check(near(w.minX, worldOf(10) - 2 * TEXEL, 1e-6), 'minX is 2 texels below the first texel', `${w.minX.toFixed(2)} m`)
  check(near(w.minZ, worldOf(20) - 2 * TEXEL, 1e-6), 'minZ is 2 texels below the first texel')
  check(near(w.maxX, worldOf(13) + 2 * TEXEL, 1e-6), 'maxX is 2 texels above the LAST texel', 'i1 is exclusive')
  check(near(w.maxZ, worldOf(25) + 2 * TEXEL, 1e-6), 'maxZ is 2 texels above the last texel')

  // The stencil has to be a widening, never a shrink: every texel in the rect is
  // strictly inside the world box that is handed to the mesher.
  check(
    w.minX < worldOf(rect.i0) && w.maxX > worldOf(rect.i1 - 1) && w.minZ < worldOf(rect.j0) && w.maxZ > worldOf(rect.j1 - 1),
    'the world box strictly contains every texel of the rect'
  )

  const u = unionRect({ i0: 5, j0: 5, i1: 9, j1: 9 }, { i0: 7, j0: 2, i1: 12, j1: 8 })
  check(u.i0 === 5 && u.j0 === 2 && u.i1 === 12 && u.j1 === 9, 'unionRect takes the outer bounds', JSON.stringify(u))
  check(unionRect(null, u) === u && unionRect(u, null) === u, 'unionRect passes a null through', 'the first stamp of a stroke has nothing to union with')

  // readRect -> patch is the wire between the brush and a worker's own copy of
  // the field, so it round trips or the workers mesh a different world.
  const src = makeField((i, j) => i * 3 + j)
  const data = readRect(src, rect)
  check(data.length === 4 * 6, 'readRect packs the rect tightly', `${data.length} of ${4 * 6}`)
  check(data[0] === at(src, 10, 20) && data[5] === at(src, 11, 21), 'readRect is row-major from the rect origin')

  const dst = flat(-1)
  dst.patch(rect, data)
  let same = true
  for (let j = rect.j0; j < rect.j1; j++) {
    for (let i = rect.i0; i < rect.i1; i++) if (at(dst, i, j) !== at(src, i, j)) same = false
  }
  check(same, 'readRect -> patch reproduces the rect texel for texel')
  check(at(dst, rect.i0 - 1, rect.j0) === -1 && at(dst, rect.i1, rect.j0) === -1, 'and touches nothing outside it')
}

// --- section 4: raise and lower ----------------------------------------------

function sectionRaiseLower() {
  console.log('\nstamp: raise / lower')

  check(SCULPT_MODES.join(',') === 'raise,lower,smooth', 'the modes the panel prints are the modes stamp accepts')

  const radius = 300
  const hm = flat()
  const res = stamp(hm, { x: 0, z: 0, radius, mode: 'raise', amount: 10 })
  check(res !== null && near(res.moved, 10, 1e-5), 'raise moves the centre texel by the full amount', `${res.moved.toFixed(4)} m`)
  check(res.clamped === 0, 'and clamps nothing in the middle of the range')
  check(near(at(hm, 128, 128), 10, 1e-5), 'the centre texel is up by 10 m')

  // The rim carries the falloff, so the last texel inside the radius has barely
  // moved -- this is the crease-ring check in field form.
  const rimI = 128 + Math.floor(radius / TEXEL)
  check(at(hm, rimI, 128) < 0.6, 'the outermost texel inside the radius has barely moved', `${at(hm, rimI, 128).toFixed(3)} m`)
  check(at(hm, 128 + Math.ceil(radius / TEXEL) + 1, 128) === 0, 'nothing outside the radius moved at all')

  // Radially symmetric: the same distance out is the same height, in all four
  // directions. An axis mix-up (u/v, x/z) survives every check above and fails
  // this one.
  const d = 4
  const v = at(hm, 128 + d, 128)
  check(
    near(at(hm, 128 - d, 128), v, 1e-6) && near(at(hm, 128, 128 + d), v, 1e-6) && near(at(hm, 128, 128 - d), v, 1e-6),
    'the stamp is radially symmetric',
    `${v.toFixed(4)} m at ${d} texels out`
  )

  const down = flat()
  stamp(down, { x: 0, z: 0, radius, mode: 'lower', amount: 10 })
  let mirrored = true
  for (let j = 100; j < 156; j++) {
    for (let i = 100; i < 156; i++) if (!near(at(down, i, j), -at(hm, i, j), 1e-6)) mirrored = false
  }
  check(mirrored, 'lower is raise negated, texel for texel')

  // The same axis trap as in brushRect, in the field: stamp somewhere with
  // different X and Z and demand the peak land on the texel nearest the brush.
  // Reading z where x belongs puts the whole stroke on the diagonal, which every
  // symmetric check above is blind to.
  const off = flat()
  const OX = 1024
  const OZ = -2048
  stamp(off, { x: OX, z: OZ, radius, mode: 'raise', amount: 10 })
  let peak = -Infinity
  let pi = -1
  let pj = -1
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (at(off, i, j) > peak) {
        peak = at(off, i, j)
        pi = i
        pj = j
      }
    }
  }
  check(
    pi === Math.round((OX + WORLD_HALF) / TEXEL) && pj === Math.round((OZ + WORLD_HALF) / TEXEL),
    'an off-centre stamp peaks on the texel nearest the brush',
    `peak at texel ${pi},${pj} = ${peak.toFixed(3)} m`
  )

  // A brush off the grid is a no-op, not a crash: Sculptor.stroke leans on the
  // null to decide there is nothing to snapshot.
  check(stamp(flat(), { x: -WORLD_HALF - 9000, z: 0, radius, mode: 'raise', amount: 10 }) === null, 'a stamp entirely off the grid returns null')

  let threw = false
  try {
    stamp(flat(), { x: 0, z: 0, radius, mode: 'flatten', amount: 1 })
  } catch {
    threw = true
  }
  check(threw, 'an unknown mode throws')
}

// --- section 5: smooth reads a snapshot --------------------------------------

function sectionSmooth() {
  console.log('\nstamp: smooth blurs the field it started with')

  // One spike on flat ground. Row-major order reaches the spike BEFORE the texel
  // to its right, so if the blur read the field in place, that texel would see
  // the already-flattened spike and come out ~9x too low. This is the whole
  // difference between a blur and a smear, and it is otherwise only visible as a
  // comet tail off every smoothed hollow.
  const SPIKE = 90
  const hm = flat()
  hm.field[128 * N + 128] = SPIKE

  const radius = 600 // wide enough that falloff is ~1 across the 3x3 stencil
  const res = stamp(hm, { x: 0, z: 0, radius, mode: 'smooth', amount: 1 })
  check(res !== null && res.clamped === 0, 'a smooth over flat ground clamps nothing')

  const wCentre = falloff(0)
  check(near(at(hm, 128, 128), SPIKE + (SPIKE / 9 - SPIKE) * wCentre, 1e-4), 'the spike falls to the mean of its 3x3 neighbourhood', `${at(hm, 128, 128).toFixed(3)} m`)

  const wRight = falloff(TEXEL / radius)
  const fromSnapshot = (SPIKE / 9) * wRight
  const fromInPlace = (SPIKE / 81) * wRight
  const got = at(hm, 129, 128)
  check(near(got, fromSnapshot, 1e-4), 'the texel stamped AFTER the spike still saw the spike', `${got.toFixed(4)} m, in-place would be ${fromInPlace.toFixed(4)}`)

  // Symmetry is the same statement read the other way: the texel BEFORE the
  // spike in loop order and the one after it must agree.
  check(near(at(hm, 127, 128), got, 1e-6), 'and matches the texel stamped before it')

  // amount is a 0..1 blend for smooth and is clamped there, so a fast machine
  // running many frames a second cannot overshoot the mean and ring.
  const half = flat()
  half.field[128 * N + 128] = SPIKE
  stamp(half, { x: 0, z: 0, radius, mode: 'smooth', amount: 0.5 })
  check(near(at(half, 128, 128), SPIKE + (SPIKE / 9 - SPIKE) * 0.5, 1e-4), 'a half-strength smooth goes half way to the mean')

  const over = flat()
  over.field[128 * N + 128] = SPIKE
  stamp(over, { x: 0, z: 0, radius, mode: 'smooth', amount: 5 })
  check(near(at(over, 128, 128), SPIKE / 9, 1e-4), 'an amount above 1 clamps to the mean rather than overshooting it')
}

// --- section 6: the encoding's ceiling ---------------------------------------

function sectionClamp() {
  console.log('\nstamp: clamped to what the PNG can store')

  // Ground already near the top of the encoding's range, raised hard. Without
  // the clamp this looks perfect until Save, and then the summit is flat on the
  // next load with nothing having reported anything.
  const hm = flat(META.maxY - 5)
  const res = stamp(hm, { x: 0, z: 0, radius: 300, mode: 'raise', amount: 50 })
  check(res.clamped > 0, 'texels pushed past maxY are counted', `${res.clamped} texels`)

  let over = 0
  let under = 0
  for (let i = 0; i < hm.field.length; i++) {
    if (hm.field[i] > META.maxY + 1e-6) over++
    if (hm.field[i] < META.minY - 1e-6) under++
  }
  check(over === 0, 'and none of them ended up above maxY', `${over} over`)

  const low = flat(META.minY + 5)
  const lowRes = stamp(low, { x: 0, z: 0, radius: 300, mode: 'lower', amount: 50 })
  for (let i = 0; i < low.field.length; i++) if (low.field[i] < META.minY - 1e-6) under++
  check(lowRes.clamped > 0 && under === 0, 'the floor is enforced the same way', `${lowRes.clamped} texels at minY`)

  // The count has to be per-stamp, not cumulative: Sculptor sums it over a
  // stroke and resets on pointer-down, so a stamp that returned a running total
  // would report a stroke's worth of clamping on its first frame.
  const second = stamp(hm, { x: 3000, z: 3000, radius: 300, mode: 'lower', amount: 1 })
  check(second.clamped === 0, 'a stamp reports only its own clamped texels')
}

// --- section 7: the field survives the round trip through the PNG ------------

async function sectionRoundTrip() {
  console.log('\nheight.png: encode -> decode -> metres')

  const px = new Uint8Array(N * N * 3)
  for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 5)) & 0xff
  const bytes = await encodePng(N, N, px)
  const back = await decodePng(bytes)
  check(back.width === N && back.height === N, 'encodePng -> decodePng keeps the dimensions', `${back.width}x${back.height}`)
  check(back.channels === 3 && back.depth === 8, 'and stays RGB8', `${back.channels}ch/${back.depth}b`)
  let diff = 0
  for (let i = 0; i < px.length; i++) if (back.data[i] !== px[i]) diff++
  check(diff === 0, 'and every byte comes back', `${diff} differing`)

  // The trip the Save button actually takes: sculpt a field, encode it the way
  // the browser will, decode it the way the loader will, and check the metres.
  const hm = makeField((i, j) => 40 + 120 * Math.sin(i * 0.05) * Math.cos(j * 0.04))
  stamp(hm, { x: 500, z: -800, radius: 400, mode: 'raise', amount: 60 })
  stamp(hm, { x: 500, z: -800, radius: 150, mode: 'smooth', amount: 1 })
  const png = await hm.toPng()
  const reread = Heightmap.fromDecoded(await decodePng(png), META)

  // rg16 over minY..maxY: one level is span/65535, and a round trip rounds to
  // the nearest level, so half a level is the whole error budget.
  const level = (META.maxY - META.minY) / 65535
  let worst = 0
  for (let i = 0; i < hm.field.length; i++) worst = Math.max(worst, Math.abs(reread.field[i] - hm.field[i]))
  check(worst <= level * 0.5 + 1e-6, 'a sculpted field survives the PNG to within half a quantisation level', `${(worst * 100).toFixed(3)} cm, level ${(level * 100).toFixed(3)} cm`)
  check(level < 0.02, 'and that level is under 2 cm', `${(level * 100).toFixed(2)} cm at the ${META.maxY - META.minY} m range`)

  // B repeats the high byte, which is what makes the shipped file legible as
  // grayscale in any image viewer. Dropping it would still decode correctly and
  // would silently turn the asset into noise on screen.
  const dec = await decodePng(png)
  let mismatched = 0
  for (let i = 0; i < N * N; i++) if (dec.data[i * 3] !== dec.data[i * 3 + 2]) mismatched++
  check(mismatched === 0, 'B repeats R so the file still reads as a grayscale terrain', `${mismatched} pixels differ`)

  // A 'gray' import carries 8 bits; re-encoding a sculpt through it would throw
  // away everything below one source level -- 3.5 m of cliff at the shipped
  // range. It refuses instead of silently flattening.
  const gray = Heightmap.fromRaw({ width: N, height: N, data: new Float32Array(N * N), meta: { ...META, encoding: 'gray' } })
  let why = ''
  try {
    await gray.toPng()
  } catch (e) {
    why = e.message
  }
  check(/only rg16 is written/.test(why), "toPng refuses to write a 'gray' import", why ? `threw: ${why.slice(0, 60)}` : 'it wrote one')
}

// --- section 8: the Sculptor's stroke and undo bookkeeping -------------------

// Records what a TerrainV2 would have been told, and nothing else.
function fakeTerrain() {
  return { patches: [], patchHeight(rect, data, worldRect) { this.patches.push({ rect, data, worldRect }) } }
}

// The same for the V2Height the brush now holds. `coarsePatched` is how the
// field learns that the import under it moved: with the `erode` relief knob on,
// the surface the player collides with is DERIVED from the import rather than
// being the same array, so a stroke that skips this call leaves her walking on
// terrain that is no longer being drawn.
function fakeField() {
  return { rects: [], coarsePatched(rect) { this.rects.push(rect) } }
}

function sectionSculptor() {
  console.log('\nSculptor: strokes, patches, undo')

  const terrain = fakeTerrain()
  const field = fakeField()
  const hm = makeField((i, j) => 100 + 30 * Math.sin(i * 0.11) * Math.cos(j * 0.09))
  const before = Float32Array.from(hm.field)
  const s = new Sculptor({ heightmap: hm, field, terrain })

  check(s.mode === 'raise' && !s.dirty && !s.canUndo, 'a fresh Sculptor is clean and has nothing to undo')
  let threw = false
  try {
    s.setMode('flatten')
  } catch {
    threw = true
  }
  check(threw, 'setMode rejects a mode stamp does not implement')

  // A DRAG, not a click: eight positions along a line, each one frame apart, so
  // the stroke's rect grows on every step and the snapshot has to grow with it.
  s.radius = 250
  s.strength = 30
  s.begin()
  for (let k = 0; k < 8; k++) s.stroke(-1500 + k * 120, 900, 1 / 60)
  check(s.sculpting, 'the stroke stays open while the pointer is down')
  s.end()

  check(s.dirty, 'a drag leaves the world unsaved')
  check(s.canUndo, 'and one undo entry -- one per stroke, however long the drag')
  check(terrain.patches.length >= 1 && terrain.patches.length <= 2, 'eight stamps in one frame-time cost at most two patches', `${terrain.patches.length} sent for 8 stamps`)

  // The last patch is the one that closes the stroke, and it has to carry every
  // texel that moved since the previous one -- a flush that sent only the last
  // stamp's rect would leave the middle of the drag meshed against old heights.
  const last = terrain.patches[terrain.patches.length - 1]
  let missed = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (hm.field[j * N + i] === before[j * N + i]) continue
      const covered = terrain.patches.some((p) => i >= p.rect.i0 && i < p.rect.i1 && j >= p.rect.j0 && j < p.rect.j1)
      if (!covered) missed++
    }
  }
  check(missed === 0, 'every texel the drag moved was sent to the workers', `${missed} texels never patched`)

  // THE FIELD IS TOLD PER STAMP AND THE WORKERS PER FLUSH, and the asymmetry is
  // the point: the mesh may lag the brush by a frame without anyone noticing,
  // but the surface she is standing on this frame may not. So eight stamps are
  // eight coarsePatched calls against at most two patches.
  check(field.rects.length === 8, 'every stamp tells the field, unthrottled', `${field.rects.length} calls for 8 stamps`)
  let uncovered = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (hm.field[j * N + i] === before[j * N + i]) continue
      if (!field.rects.some((r) => i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1)) uncovered++
    }
  }
  check(uncovered === 0, 'and between them those calls cover every texel that moved', `${uncovered} texels the field never heard about`)
  check(
    near(last.worldRect.minX, rectToWorld(hm, last.rect).minX, 1e-6) && near(last.worldRect.maxZ, rectToWorld(hm, last.rect).maxZ, 1e-6),
    'the dirty world box is the rect widened by the sampling stencil'
  )
  const sent = readRect(hm, last.rect)
  let stale = 0
  for (let k = 0; k < sent.length; k++) if (sent[k] !== last.data[k]) stale++
  check(stale === 0, 'and the metres sent are the metres in the field', `${stale} differ`)

  // THE ONE THAT PAYS FOR THE SECTION. The snapshot is taken rect by rect as the
  // drag grows, pasting the stored originals back over the part already stamped;
  // get that paste wrong by a row and undo writes an "original" that was already
  // dug, which looks like the brush having left a faint ghost of itself.
  check(s.undo() === true, 'undo reports that it undid something')
  let worst = 0
  for (let k = 0; k < hm.field.length; k++) worst = Math.max(worst, Math.abs(hm.field[k] - before[k]))
  check(worst === 0, 'undo puts every texel of an eight-stamp drag back exactly', `worst residue ${worst.toExponential(2)} m`)
  check(!s.canUndo, 'and the entry is gone')
  // And undo does too, over the WHOLE stroke rather than over the last stamp:
  // the entry it restores is the union snapshot, so an undo that told the field
  // only the tail of the drag would leave the middle of the stroke standing in
  // the derived surface after it had been put back in the import.
  const back = field.rects[field.rects.length - 1]
  check(field.rects.length === 9, 'undo tells the field too', `${field.rects.length} calls after an undo of an 8-stamp drag`)
  let unrestored = 0
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!field.rects.slice(0, 8).some((r) => i >= r.i0 && i < r.i1 && j >= r.j0 && j < r.j1)) continue
      if (!(i >= back.i0 && i < back.i1 && j >= back.j0 && j < back.j1)) unrestored++
    }
  }
  check(unrestored === 0, 'and over every texel the stroke had told it about', `${unrestored} texels put back without the field hearing`)
  check(s.undo() === false, 'undoing an empty stack reports false rather than throwing')
  check(s.dirty, 'the world is STILL unsaved after an undo', 'the file on disk matches neither state')

  // A press that moved nothing must not push an entry, or Ctrl-Z starts doing
  // nothing visible several times in a row.
  s.begin()
  s.stroke(-WORLD_HALF - 9000, 0, 1 / 60)
  s.end()
  check(!s.canUndo, 'a stroke entirely off the grid leaves no undo entry')

  // And neither does a press that stamped real texels and moved none of them --
  // raising ground that is already at the encoding's ceiling. The snapshot IS
  // taken here, so this is the case that separates "nothing to record" from
  // "nothing changed", and only the second one is a plausible thing to get wrong.
  const capped = flat(META.maxY)
  const s4 = new Sculptor({ heightmap: capped, field: fakeField(), terrain: fakeTerrain() })
  s4.radius = 300
  s4.strength = 30
  s4.begin()
  s4.stroke(0, 0, 1 / 60)
  s4.end()
  check(!s4.canUndo, 'a press that moved nothing leaves no undo entry either', 'Ctrl-Z must never be a no-op you can press twice')

  // clamped is a per-stroke readout the panel prints, so it resets on the press.
  const high = flat(META.maxY - 2)
  const s2 = new Sculptor({ heightmap: high, field: fakeField(), terrain: fakeTerrain() })
  s2.radius = 300
  s2.strength = 60
  s2.begin()
  s2.stroke(0, 0, 1 / 5) // 12 m of lift into 2 m of headroom
  s2.end()
  check(s2.clamped > 0, 'sculpting into the ceiling is reported', `${s2.clamped} texels`)
  s2.begin()
  check(s2.clamped === 0, 'and the count resets on the next press')
  s2.end()

  // smooth takes its rate from smoothRate, not strength: two sliders because
  // metres per second means nothing to a blur.
  const sp = flat()
  sp.field[128 * N + 128] = 90
  const s3 = new Sculptor({ heightmap: sp, field: fakeField(), terrain: fakeTerrain() })
  s3.setMode('smooth')
  s3.radius = 600
  s3.strength = 0 // would freeze the brush if smooth read this one
  s3.smoothRate = 3
  s3.begin()
  s3.stroke(0, 0, 1 / 3) // 3 per second for a third of a second: all the way
  s3.end()
  check(near(sp.field[128 * N + 128], 10, 1e-4), 'smooth is driven by smoothRate, not strength', `${sp.field[128 * N + 128].toFixed(3)} m`)

  // Frame-rate independence: the same second of dragging moves the same ground
  // at 60 Hz and at 120 Hz, or the brush digs twice as fast on a better machine.
  const dig = (steps) => {
    const f = flat()
    const k = new Sculptor({ heightmap: f, field: fakeField(), terrain: fakeTerrain() })
    k.radius = 300
    k.strength = 24
    k.begin()
    for (let n = 0; n < steps; n++) k.stroke(0, 0, 1 / steps)
    k.end()
    return f.field[128 * N + 128]
  }
  const at60 = dig(60)
  const at120 = dig(120)
  check(near(at60, 24, 1e-4) && near(at120, at60, 1e-4), 'a second of digging is a second of digging at any frame rate', `${at60.toFixed(4)} m vs ${at120.toFixed(4)} m`)
}

// --- section 9: the save path, POST /__height -------------------------------
//
// The endpoint in vite.config.js is the only thing between a bug in the browser
// and public/world/height.png, which is the world. It is checked here by
// CALLING it -- fake req, fake res, temp root -- rather than by grepping the
// config for a string, because what matters is which bodies it refuses.
//
// Two shims and why they are safe:
//   `__dirname` -- vite injects it when IT loads the config, so a plain node
//     import of vite.config.js throws on the build.rollupOptions block at the
//     bottom. Defining it before the import is enough, and if that ever stops
//     being enough this section fails loudly rather than skipping.
//   a temp root -- the plugin resolves its paths against server.config.root, so
//     pointing that at a copy means this gate never writes the real asset. A
//     gate that overwrites the world it is checking is not one anybody runs.

async function sectionEndpoint() {
  console.log('\nPOST /__height: the write path to public/world/height.png')

  const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
  const realPng = join(repo, 'public', 'world', 'height.png')
  const realMeta = join(repo, 'public', 'world', 'height.json')
  if (!existsSync(realPng)) {
    check(false, 'public/world/height.png exists to POST', 'run scripts/make-heightmap.mjs')
    return
  }

  globalThis.__dirname = repo
  const cfg = (await import(`${repo}/vite.config.js`)).default
  const plugin = cfg.plugins.flat().find((p) => p?.name === 'aurora:world-height')
  check(!!plugin, 'vite.config.js registers the world-height plugin')
  if (!plugin) return
  check(plugin.apply === 'serve', "and only under the dev server", "apply: 'serve' -- a build has no writer")

  const root = mkdtempSync(join(tmpdir(), 'aurora-height-'))
  try {
    mkdirSync(join(root, 'public', 'world'), { recursive: true })
    copyFileSync(realPng, join(root, 'public', 'world', 'height.png'))
    copyFileSync(realMeta, join(root, 'public', 'world', 'height.json'))

    let route = null
    let handler = null
    plugin.configureServer({
      config: { root },
      middlewares: {
        use(r, fn) {
          route = r
          handler = fn
        },
      },
    })
    check(route === '/__height', 'on /__height', `got ${route}`)

    const call = (method, body) =>
      new Promise((done) => {
        const req = new EventEmitter()
        req.method = method
        const res = {
          statusCode: 200,
          setHeader() {},
          end(text) {
            done({ status: this.statusCode, body: text })
          },
        }
        handler(req, res)
        if (body) req.emit('data', Buffer.from(body))
        req.emit('end')
      })

    const png = readFileSync(join(root, 'public', 'world', 'height.png'))
    const posted = await call('POST', png)
    const answer = JSON.parse(posted.body)
    check(posted.status === 200 && answer.ok === true, 'a well-formed heightmap is written', `${posted.status} ${posted.body.slice(0, 80)}`)
    check(answer.bytes === png.length, 'and the endpoint reports the bytes it wrote', `${answer.bytes} of ${png.length}`)
    check(readFileSync(join(root, 'public', 'world', 'height.png')).equals(png), 'byte for byte')

    // The marker is what stops scripts/make-heightmap.mjs re-baking over an
    // afternoon of sculpting, and what tells check-v2-heightmap.mjs to stop
    // asserting that the shipped PNG is the import.
    const meta = JSON.parse(readFileSync(join(root, 'public', 'world', 'height.json'), 'utf8'))
    check(meta.sculpted === true, "and height.json is stamped sculpted", 'the re-bake guard and the gate both read this')
    check(meta.size === 1024 && meta.encoding === 'rg16', 'without disturbing the rest of the meta', JSON.stringify({ size: meta.size, encoding: meta.encoding }))

    // THE REFUSALS. A heightmap of the wrong size decodes perfectly well and is
    // a different world; writing it would leave the loader throwing on a file
    // nobody can tell by looking is wrong.
    const small = await encodePng(8, 8, new Uint8Array(8 * 8 * 3))
    const rejected = await call('POST', Buffer.from(small))
    check(rejected.status === 400 && /8x8/.test(rejected.body), 'a heightmap of the wrong size is refused', rejected.body.slice(0, 90))
    check(readFileSync(join(root, 'public', 'world', 'height.png')).equals(png), 'and the file on disk is untouched by the attempt')

    const garbage = await call('POST', Buffer.from('this is not a png'))
    check(garbage.status === 400 && /png:/.test(garbage.body), 'a body that is not a PNG is refused', garbage.body.slice(0, 60))

    const got = await call('GET', null)
    check(got.status === 405, 'GET is 405 rather than a write', got.body)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 10. A save that lands on a dev server too old to have the route.
//
// THE FAILURE THAT WROTE THIS SECTION, which cost an hour of sculpting: vite's
// SPA fallback answers a POST to an unknown path with index.html and HTTP 200.
// `res.ok` is therefore true, the not-ok branch never runs, and `JSON.parse` on
// "<!doctype html>" throws "Unexpected token '<'" -- a message that names
// neither the file that failed to save nor the one-keystroke cause. Nobody
// reads that as "restart the dev server", so the tab gets reloaded and the
// Float32Array that was the only copy of the sculpt goes with it.
//
// Asserted on the MESSAGE, not just on the throw, because the throw was never
// the problem. persist.js touches no DOM on this path, so a stubbed fetch is
// the whole harness.
async function sectionStaleServer() {
  console.log('\n-- stale dev server')
  const real = globalThis.fetch
  const calls = []
  const fake = (status, body, type) => {
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, method: opts.method })
      return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => type } }
    }
  }
  // toPng is the only thing saveHeightServer asks of a heightmap, so the field
  // itself is beside the point here -- what is under test is the answer.
  const heightmap = { toPng: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
  const layers = { serialize: () => ({ version: 1 }) }
  try {
    const { saveHeightServer, saveServer } = await import('../src/v2/edit/persist.js')

    fake(200, '<!doctype html>\n<html><head><title>aurora</title>', 'text/html')
    let msg = await saveHeightServer(heightmap).then(() => null, (e) => e.message)
    check(msg !== null, 'a 200 that is really the SPA fallback throws rather than resolving', 'HTTP 200 is not proof of a save')
    check(!/JSON|token/i.test(msg ?? ''), 'and not as a JSON parse error', msg)
    check(/__height/.test(msg ?? ''), 'the message names the route that is missing', msg)
    check(/dev server/i.test(msg ?? '') && /restart/i.test(msg ?? ''), 'and says to restart the dev server', msg)
    check(calls.length === 1 && calls[0].method === 'POST', 'after actually attempting the POST', JSON.stringify(calls))

    msg = await saveServer(layers).then(() => null, (e) => e.message)
    check(/__world/.test(msg ?? '') && /restart/i.test(msg ?? ''), 'the document save is diagnosed the same way', msg)

    // The other three answers must still read as themselves: a fallback check
    // that swallowed real refusals would be worse than the bug it replaced.
    fake(400, JSON.stringify({ ok: false, error: 'heightmap is 8x8, expected 1024x1024' }), 'application/json')
    msg = await saveHeightServer(heightmap).then(() => null, (e) => e.message)
    check(/8x8/.test(msg ?? ''), "a real refusal still reports the server's own reason", msg)

    fake(200, JSON.stringify({ ok: false, error: 'read-only' }), 'application/json')
    msg = await saveHeightServer(heightmap).then(() => null, (e) => e.message)
    check(/read-only/.test(msg ?? ''), 'and so does a 200 that says ok:false', msg)

    fake(200, JSON.stringify({ ok: true, path: 'public/world/height.png', bytes: 1317369 }), 'application/json')
    const good = await saveHeightServer(heightmap)
    check(good.bytes === 1317369 && good.path.endsWith('height.png'), 'a genuine save resolves to the endpoint answer', JSON.stringify(good))
  } finally {
    globalThis.fetch = real
  }
}

export async function run() {
  console.log('\n=== v2 terrain brush ===')
  sectionFalloff()
  sectionRect()
  sectionWorldRect()
  sectionRaiseLower()
  sectionSmooth()
  sectionClamp()
  sectionSculptor()
  await sectionRoundTrip()
  await sectionEndpoint()
  await sectionStaleServer()
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) throw new Error(`check-v2-sculpt: ${failures} check(s) failed`)
  return failures
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run()
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}
