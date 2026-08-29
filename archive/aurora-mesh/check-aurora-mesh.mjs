// ---------------------------------------------------------------------------
// Gate for the ARCHIVED band-mesh aurora. Not wired into `npm run check`; run it
// by hand with `node archive/aurora-mesh/check-aurora-mesh.mjs`.
//
// It exists so the mesh stays resurrectable rather than rotting into something
// that would need a week of re-tuning on the day it is wanted. See
// archive/README.md for what would bring it back. Nothing in the live tree
// imports it or the code it covers; the dependency runs one way only, from here
// into src/ and scripts/lib/.
//
// The clock-side aurora checks -- gating, the substorm cycle, ambient tinting --
// stayed in scripts/check-daynight.mjs, because the world clock still drives the
// aurora that ships. Only the mesh moved.
// ---------------------------------------------------------------------------

import THREE from '../../src/three-instance.js'
import { readFileSync } from 'node:fs'
import { WorldClock } from '../../src/clock.js'
import { Stars } from '../../src/stars.js'
import { Aurora } from './aurora.js'
import {
  PATTERNS,
  SLOTS,
  MAX_CONCURRENT,
  MAX_BANDS,
  FLOOR_BANDS,
  MAX_RADIUS_KM,
  composeAuto,
  bandsFor,
  bandRadiusKm,
} from './aurora-patterns.js'
import { shadersIn, redeclarations } from '../../scripts/lib/glsl-scope.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const DEG = Math.PI / 180
// World units per kilometre, mirroring KM in aurora.js.
const KM_UNITS = 45

console.log('\n--- the band mesh: shaders and geometry ------------------------')
// ===========================================================================

{
  const scene = new THREE.Scene()
  const stars = new Stars(scene, { seed: 20260804 })
  const aurora = new Aurora(scene)

  for (const [name, src] of [
    ['aurora vert', aurora.material.vertexShader],
    ['aurora frag', aurora.material.fragmentShader],
  ]) {
    check(!/undefined|NaN|\[object/.test(src), `${name}: no unresolved template values`)
    const open = (src.match(/{/g) || []).length
    const close = (src.match(/}/g) || []).length
    check(open === close, `${name}: braces balance`, `${open}/${close}`)
  }

  // §13's constraint, made measurable. The aurora fragment shader is the one
  // place a long shader shows up in frametime, and noise is what makes a
  // fragment shader long. Two evaluations, and a budget that will fail loudly
  // if someone adds a third.
  const noiseCalls = (aurora.material.fragmentShader.match(/aurNoise\(/g) || []).length - 1 // minus the definition
  check(noiseCalls <= 3, 'the aurora fragment shader stays within its noise budget', `${noiseCalls} evaluations`)

  // Field alignment: the ray lookup must not depend on altitude, or the
  // striations stop running along the field lines and the whole thing reads as
  // coloured fog. This is one character's worth of mistake.
  const rayBlock = aurora.material.fragmentShader.split('float ray =')[1].split(';')[0]
  check(!rayBlock.includes('vAlt'), 'aurora rays are field-aligned (no altitude term in the ray noise)')

  // Additive and depth-tested but not depth-written: that combination is what
  // makes mountains occlude the aurora without any sorting.
  check(aurora.material.blending === THREE.AdditiveBlending,
    'aurora: additive, so overlap is order-independent')
  check(aurora.material.depthTest === true && aurora.material.depthWrite === false,
    'aurora: depth tested, never written')
  check(aurora.material.fog === false, 'aurora: not fogged')

  // Geometry placement. `position` is all zeros -- every coordinate is computed
  // in the vertex shader from the band uniforms -- so this has to mirror that
  // arithmetic on the CPU instead of reading the buffer. That is the price of a
  // parametric mesh, and it is worth paying here: reading the buffer would have
  // checked ONE hard-coded arrangement, whereas this checks all sixteen named
  // forms, which is what actually ships.
  //
  // Two placement questions, and they are the two the camera cares about:
  // where in the sky each band sits, and whether the whole thing stays inside
  // the far plane without reaching down into the terrain. The far-plane half is
  // checked further down, where the fold walk has measured how far out the
  // folds actually push a footprint -- an analytic worst case over four
  // octaves is far looser than the shape that is drawn.
  const vs = aurora.material.vertexShader
  const auroraSrc = readFileSync(new URL('./aurora.js', import.meta.url), 'utf8')

  // Elevation of a point at altitude `alt` km on a footprint `d` km away. No
  // curvature term: the shader places bands on a flat plane at `vec3( dir *
  // dist, alt, ... )`, so a check that dropped them by d^2 / 2R would be
  // measuring a shape that is not drawn.
  const elevOf = (alt, d) => Math.atan2(alt, d) / DEG
  let elevMax = 0
  let elevMin = 90
  let highestBand = ''
  let lowestBand = ''
  for (const p of PATTERNS) {
    for (const b of p.bands) {
      const hem = elevOf(b.alt0, b.dist)
      const top = elevOf(b.alt1, b.dist)
      if (hem < elevMin) {
        elevMin = hem
        lowestBand = p.name
      }
      if (top > elevMax) {
        elevMax = top
        highestBand = p.name
      }
    }
  }
  // The aurora is additive and depth-tested, so a band whose hem sits low
  // enough to fall behind a ridgeline gets occluded by terrain 200 km closer
  // than it -- which is correct for a mountain in front of the sky and wrong
  // for one in front of something 250 km up. Fifteen degrees keeps every hem
  // clear of anything the terrain can reach.
  check(elevMin > 15, 'no band sits low enough for a mountain to wrongly occlude it',
    `lowest hem ${elevMin.toFixed(1)} deg (${lowestBand})`)
  // The other end of the same fence. Structure running up past ~80 degrees
  // stops reading as a thing in the sky and starts reading as the inside of a
  // cone overhead, because every part of it is foreshortened toward one point.
  check(elevMax > 40 && elevMax < 80, 'and the catalogue still reaches high overhead without becoming a cone',
    `highest ${elevMax.toFixed(1)} deg (${highestBand})`)
  // The catalogue's own declared radius has to agree with the shader's. If
  // bandRadiusKm drifted from what the vertex shader builds, MAX_RADIUS_KM
  // would be guarding nothing.
  let declaredMax = 0
  for (const p of PATTERNS) for (const b of p.bands) declaredMax = Math.max(declaredMax, bandRadiusKm(b))
  check(declaredMax <= MAX_RADIUS_KM, 'no catalogued band exceeds the declared radius cap',
    `${declaredMax.toFixed(0)} of ${MAX_RADIUS_KM} km`)
  // =========================================================================
  // Does the hem trace an S, and does the curtain fold back over itself?
  //
  // "The auroras look horrible" was answered by reverting the shader; "I still
  // want them to weave around in the sky, so the bottom hem traces S shapes
  // rather than just being a slightly wiggly straight-ish line" is the one
  // thing that was kept, and it is the one claim here that cannot be checked
  // by reading a parameter. It is a property of the noise, not of the
  // catalogue: two bands with identical `meander` trace a different shape
  // depending on their span, their distance and how high their hem sits.
  //
  // So aurHash/aurNoise/aurFold are ported to JS below -- exactly, including
  // the uint32 wrap, which is what `Math.imul(x >>> 0, k) >>> 0` reproduces --
  // and the footprint is walked at several times. Three things come out of the
  // walk:
  //
  //   swing  the peak-to-peak rise and fall of the hem, IN DEGREES OF SKY.
  //          This is the complaint made numeric. Before the meander the
  //          always-on quiet arc measured 0.7 degrees, which is a straight
  //          line with texture on it.
  //   bends  the number of turns in the hem once the fine folds are averaged
  //          out of it. An S needs at least two. Counting every local extremum
  //          instead would measure jitter -- the quiet arc had 24 of those
  //          while swinging 0.7 degrees -- so the hem is resampled coarsely
  //          first.
  //   rev    the number of times the BEARING of the footprint reverses. Zero
  //          reversals is a polar graph: single-valued in azimuth, which is
  //          what the shader built before the tangential term went in. Each
  //          pair of reversals is one loop of curtain lying over itself, which
  //          only the active forms should be doing.
  // =========================================================================
  const aurHash = (x, y) => {
    const qx = Math.imul(Math.floor(x) >>> 0, 1597334673) >>> 0
    const qy = Math.imul(Math.floor(y) >>> 0, 3812015801) >>> 0
    return (Math.imul((qx ^ qy) >>> 0, 1597334673) >>> 0) / 4294967296
  }
  const aurNoise = (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const lo = aurHash(ix, iy) + (aurHash(ix + 1, iy) - aurHash(ix, iy)) * ux
    const hi = aurHash(ix, iy + 1) + (aurHash(ix + 1, iy + 1) - aurHash(ix, iy + 1)) * ux
    return lo + (hi - lo) * uy
  }
  // The curtain's own folds: coordinate scale, time scale, weight, quarter-wave
  // offset. All three are scaled by the band's fold amplitude and by foldHz.
  const OCT = [
    { c: 0.0125, t: 0.055, w: 1.00, q: 20.0 },
    { c: 0.0410, t: 0.130, w: 0.52, q: 6.1 },
    { c: 0.1350, t: 0.310, w: 0.34, q: 1.85 },
  ]
  // The meander, which is neither scaled by amp nor by hz -- that is the whole
  // point of it.
  const MEANDER = { c: 0.0034, t: 0.014, q: 73.5 }
  const aurFold = (km, t, amp, hz, act, curl, ms, mAmp) => {
    let fx = 0
    let fy = 0
    for (let i = 0; i < OCT.length; i++) {
      const o = OCT[i]
      const c = o.c * hz
      const off = o.q / hz
      const g = o.w * (i === 2 ? act : 1)
      fx += (aurNoise(km * c, t * o.t) - 0.5) * g
      fy += (aurNoise((km + off) * c, t * o.t) - 0.5) * g
    }
    fx *= amp
    fy *= amp
    const mkm = km * ms
    fx += (aurNoise(mkm * MEANDER.c, t * MEANDER.t) - 0.5) * mAmp
    fy += (aurNoise((mkm + MEANDER.q) * MEANDER.c, t * MEANDER.t) - 0.5) * mAmp
    return [fx, fy * curl]
  }
  // Every rate in the mirror against the shader's, so a re-tuned octave cannot
  // leave this measuring a shape that is no longer drawn.
  for (const o of [...OCT, MEANDER]) {
    check(vs.includes(`t * ${o.t.toFixed(3)} )`), `fold octave at rate ${o.t} matches the shader`)
  }
  // And the amplitude the shader hands the meander, which is the one number
  // this whole section turns on.
  const mFrac = Number(auroraSrc.match(/const MEANDER_FRAC = ([\d.]+)/)[1])
  check(/f \+= \( vec2\( aurNoise\( vec2\( mkm \* 0\.0034,[\s\S]{0,180}\) \* mAmp;/.test(auroraSrc),
    'the meander is added after the fold amplitude, not multiplied by it', `frac ${mFrac}`)
  check(/bandG\[i4\] = b\.meander \* MEANDER_FRAC \* b\.dist/.test(auroraSrc),
    'and its amplitude is a fraction of the distance, so the swing is the same span of sky at any range')

  // The walk. Sampled at several in-world times because the shape morphs, and
  // over the middle 80% of each band because the ends are tapered out by
  // `endTaper` and their hem is not on screen.
  const walkOf = (b, act, meander = b.meander) => {
    const ampOf = (alt) => b.fold * (0.86 + (alt - 90) * 0.0042)
    const mAmp = meander * mFrac * b.dist
    const ms = 250 / b.dist
    const N = 400
    const lo = Math.round(N * 0.1)
    const hi = Math.round(N * 0.9)
    let swing = 0
    let path = 0
    let bends = 0
    let rev = 0
    let frames = 0
    let rMax = 0
    let rMin = Infinity
    for (let ut = 0; ut < 800; ut += 37) {
      const t = ut * b.speed
      const elev = []
      const bearing = []
      for (let i = 0; i <= N; i++) {
        const aU = i / N
        const km = (aU - 0.5) * b.span * DEG * b.dist + ut * b.drift
        const a = (b.az + (aU - 0.5) * b.span) * DEG
        // The hem, which is what all three measurements are about. shear is
        // zero at the base, so the hem samples the fold at km exactly.
        const f = aurFold(km, t, ampOf(b.alt0), b.foldHz, act, b.curl, ms, mAmp)
        const x = Math.sin(a) * (b.dist + f[0]) + Math.cos(a) * f[1]
        const z = -Math.cos(a) * (b.dist + f[0]) + Math.sin(a) * f[1]
        elev.push(elevOf(b.alt0, Math.hypot(x, z)))
        bearing.push(Math.atan2(x, -z))
        rMin = Math.min(rMin, Math.hypot(x, z, b.alt0) * KM_UNITS)
        // ...and the top of the column, where the fold amplitude is largest and
        // the geometry reaches furthest from the camera.
        const g = aurFold(km, t, ampOf(b.alt1), b.foldHz, act, b.curl, ms, mAmp)
        const gx = Math.sin(a) * (b.dist + g[0]) + Math.cos(a) * g[1]
        const gz = -Math.cos(a) * (b.dist + g[0]) + Math.sin(a) * g[1]
        rMax = Math.max(rMax, Math.hypot(gx, gz, b.alt1) * KM_UNITS)
      }
      const mid = elev.slice(lo, hi)
      swing += Math.max(...mid) - Math.min(...mid)
      // Coarse resample before counting turns: 16 buckets across the band,
      // which is well below the shortest fold wavelength and well above the
      // meander's, so what survives is the shape of the arc and not its texture.
      const BUCKETS = 16
      const coarse = []
      for (let k = 0; k < BUCKETS; k++) {
        const a0 = lo + Math.floor(((hi - lo) * k) / BUCKETS)
        const a1 = lo + Math.floor(((hi - lo) * (k + 1)) / BUCKETS)
        let sum = 0
        for (let i = a0; i < a1; i++) sum += elev[i]
        coarse.push(sum / (a1 - a0))
      }
      // The long-wave swing: the same peak-to-peak, measured on the resampled
      // curve. This is the swing of the PATH the band hangs along, with the
      // curtain's own folds averaged out of it, and it is the number the
      // meander is answerable for -- a 12 km fold at 103 km range moves the hem
      // a degree or so all by itself, which would let a form that is supposed
      // to run straight across the sky pass a total-swing check on texture.
      path += Math.max(...coarse) - Math.min(...coarse)
      let d0 = null
      for (let k = 1; k < BUCKETS; k++) {
        const d = coarse[k] - coarse[k - 1]
        if (d0 !== null && d0 * d < 0) bends++
        d0 = d
      }
      // Unwrapped, or a band that crosses due south counts two reversals per
      // frame that are an artefact of atan2 and not of the geometry.
      let prev = null
      let last = null
      for (let i = 0; i <= N; i++) {
        let ang = bearing[i]
        if (last !== null) {
          while (ang - last > Math.PI) ang -= 2 * Math.PI
          while (last - ang > Math.PI) ang += 2 * Math.PI
        }
        const d = last === null ? null : ang - last
        if (prev !== null && d !== null && prev * d < 0) rev++
        prev = d
        last = ang
      }
      frames++
    }
    return { swing: swing / frames, path: path / frames, bends: bends / frames, rev: rev / frames, rMax, rMin }
  }

  // Measured at activity 0.9, which is where the fine octave is fully on. The
  // meander does not depend on activity, so the hem numbers barely move with it.
  // Per BAND, not per form. A form's bands are different objects with different
  // promises -- STEVE is a straight mauve ribbon with a folded green fence
  // underneath it -- so taking the max over a form's bands would let one band
  // answer for another, in both directions.
  const bands = PATTERNS.flatMap((p) => p.bands.map((b, i) => ({
    name: p.bands.length > 1 ? `${p.name} #${i + 1}` : p.name,
    form: p.name,
    floor: !!p.floor,
    span: b.span,
    mean: b.meander,
    ...walkOf(b, 0.9),
    // The same band with the meander switched off. Differencing the two is the
    // only way to ask what the MEANDER did, as opposed to what the band's own
    // folds did: STEVE's green fence hangs at 103 km with 12 km folds, and that
    // alone moves its hem nearly two degrees whatever its path is doing.
    flat: walkOf(b, 0.9, 0).path,
  })))
  const shapes = PATTERNS.map((p) => {
    const w = bands.filter((x) => x.form === p.name)
    return {
      name: p.name,
      floor: !!p.floor,
      swing: Math.max(...w.map((x) => x.swing)),
      path: Math.max(...w.map((x) => x.path)),
      bends: Math.max(...w.map((x) => x.bends)),
      rev: Math.max(...w.map((x) => x.rev)),
    }
  })
  for (const s of shapes) {
    console.log(`       ${s.name.padEnd(18)} hem swings ${s.swing.toFixed(1).padStart(4)} deg` +
      ` (${s.path.toFixed(1).padStart(4)} of it the path itself),` +
      ` ${s.bends.toFixed(1).padStart(4)} bends, ${s.rev.toFixed(1).padStart(5)} fold-backs`)
  }

  // ---- The hem. The forms this is about are the ARCS AND BANDS: a thing that
  // crosses the sky and therefore has a hem you can follow. The two narrow
  // plumes span 30 degrees of azimuth, which is a fraction of one meander
  // wavelength, so asking their hem to trace an S is asking for a shape that
  // does not fit in them.
  // ...and the two forms whose rows declare themselves straight are held out of
  // it and checked separately below, so that the catalogue's own declaration is
  // what decides which promise each form carries.
  const arcs = bands.filter((s) => s.span >= 100 && s.mean >= 0.5)
  const flat = arcs.filter((s) => s.swing < 2)
  check(flat.length === 0, 'every arc that crosses the sky has a hem that rises and falls degrees, not fractions of one',
    flat.length ? flat.map((s) => `${s.name} ${s.swing.toFixed(1)}`).join(', ')
      : `smallest swing ${Math.min(...arcs.map((s) => s.swing)).toFixed(1)} deg`)
  // Two turns is the difference between an S and an arch. This is the shape
  // the request named, so it is checked on its own rather than folded into the
  // swing number -- a hem could swing five degrees in one smooth bow and still
  // not be what was asked for.
  // ...and for the bands that were the actual complaint, the swing has to be
  // the MEANDER's doing rather than a side effect of a big fold amplitude.
  // Restricted to the bands whose folds alone leave the hem under two degrees,
  // because that is the set the mechanism exists for: a breakup band already
  // swings six degrees on 56 km folds, and differencing peak-to-peak on top of
  // that measures nothing useful -- two overlapping waves do not add their
  // extremes.
  const needy = arcs.filter((s) => s.flat < 2)
  const notMeander = needy.filter((s) => s.path - s.flat < 1)
  check(notMeander.length === 0, 'and on the quiet ones it is the path doing it, not a side effect of big folds',
    notMeander.length ? notMeander.map((s) => `${s.name} ${(s.path - s.flat).toFixed(1)}`).join(', ')
      : `${needy.length} bands, smallest contribution ` +
        `${Math.min(...needy.map((s) => s.path - s.flat)).toFixed(1)} deg`)
  const straightish = arcs.filter((s) => s.bends < 2)
  check(straightish.length === 0, 'and it turns at least twice across the band, which is what makes it an S',
    straightish.length ? straightish.map((s) => `${s.name} ${s.bends.toFixed(1)}`).join(', ')
      : `fewest ${Math.min(...arcs.map((s) => s.bends)).toFixed(1)} turns`)
  // The floor form is up every clear night, so it carries this promise more
  // than any of the rare ones do.
  const floorForm = shapes.find((s) => s.floor)
  check(floorForm.swing >= 2 && floorForm.bends >= 2, 'and the always-on floor form is one of them',
    `${floorForm.name}: ${floorForm.swing.toFixed(1)} deg over ${floorForm.bends.toFixed(1)} turns`)
  // The two forms that are straight in nature have to stay straight. STEVE is
  // a river of plasma and the SAR arc is stable by definition; a catalogue
  // where EVERY form serpentines is as wrong as one where none does, and
  // `meander` on those rows is the only thing holding them down.
  const damped = bands.filter((s) => s.mean < 0.5)
  const notCalm = damped.filter((s) => s.path - s.flat > 0.5)
  check(damped.length >= 2 && notCalm.length === 0,
    'but the forms that are straight in nature stay straight',
    notCalm.length ? notCalm.map((s) => `${s.name} ${(s.path - s.flat).toFixed(1)}`).join(', ')
      : damped.map((s) => `${s.name} ${(s.path - s.flat).toFixed(1)} deg of meander`).join(', '))

  // ---- Folding back. The other half of "weave around in the sky": where the
  // tangential component outruns the along-track step the footprint doubles
  // back and the same stretch of sky gets two layers of curtain.
  const foldy = shapes.filter((s) => s.rev >= 2)
  check(foldy.length >= 5, 'the active forms fold back over themselves rather than only flapping sideways',
    `${foldy.length} of ${shapes.length} average two or more bearing reversals`)
  const quiet = shapes.filter((s) => s.rev < 1)
  check(quiet.length >= 5, 'while the quiet ones weave without lying over themselves',
    `${quiet.length} of ${shapes.length}`)

  // ---- And the whole thing still has to fit the camera. These are measured
  // from the same walk rather than bounded analytically, because an analytic
  // worst case over four octaves that never peak together is far looser than
  // the shape that is drawn -- loose enough that it would fail on geometry
  // which renders perfectly.
  const rMax = Math.max(...bands.map((s) => s.rMax))
  const rMin = Math.min(...bands.map((s) => s.rMin))
  const farthest = bands.find((s) => s.rMax === rMax)
  check(rMax < 20000, 'the aurora fits inside the far plane with its folds at full stretch',
    `${rMax.toFixed(0)} of 20000 units (${farthest.name})`)
  check(rMin > 4000, 'and never reaches down into anything the terrain can occupy',
    `nearest ${rMin.toFixed(0)} units`)

  const tris = aurora.mesh.geometry.index.count / 3
  check(tris < 40000, 'and it costs one draw call of a modest triangle count', `${tris} tris`)

  // Everything off during the day, so this whole system is free at noon.
  const noon = new WorldClock({ hour: 12 }).state()
  const head = new THREE.Vector3()
  aurora.update(head, noon, 0)
  check(!aurora.mesh.visible, 'the mesh draws nothing at all in daylight')

  const night = new WorldClock({ hour: 1, seed: 20260804 }).state()
  aurora.update(head, night, 0)
  check(aurora.mesh.visible, 'and is up at 01:00')
}

// ===========================================================================
// The pattern catalogue and the composer.
//
// This is the half of the aurora that is pure data and pure arithmetic, which
// makes it the half that can actually be measured. The shader can only be
// judged by looking at it; the composer cannot -- "does the sky ever lose a
// curtain in one frame" is a question about a function, and a function can be
// swept.
// ===========================================================================
{
  console.log('\n--- aurora patterns and the composer ---------------------------')

  check(PATTERNS.length >= 10, 'there are at least ten named forms', `${PATTERNS.length} patterns`)

  // Names are what the HUD prints and what the console logs, so a duplicate
  // would be a form you cannot tell apart from another one.
  const names = new Set(PATTERNS.map((p) => p.name))
  check(names.size === PATTERNS.length, 'and every one of them has a distinct name')

  // The slot count is not a tuning knob, it is a consequence: MAX_CONCURRENT
  // forms of at most MAX_BANDS bands each. If these ever disagree the composer
  // can emit bands with nowhere to go, and they would silently vanish.
  check(MAX_CONCURRENT * MAX_BANDS + FLOOR_BANDS === SLOTS, 'slots exactly cover the worst-case overlay',
    `${MAX_CONCURRENT} x ${MAX_BANDS} + ${FLOOR_BANDS} floor = ${SLOTS}`)
  // The reservation is only a guarantee if the floor form actually fits in it.
  const floors = PATTERNS.filter((p) => p.floor)
  check(floors.length === 1 && floors[0].bands.length === FLOOR_BANDS,
    'and exactly one form holds the reserved floor slots',
    `${floors.map((p) => p.name).join(', ')}, ${floors[0]?.bands.length} bands`)
  const maxBands = Math.max(...PATTERNS.map((p) => p.bands.length))
  check(maxBands <= MAX_BANDS, 'and no single form declares more bands than that',
    `worst is ${maxBands}`)
  // The other end of the same fence, and it is not hypothetical: an editing
  // slip removed both bands from `flaming aurora` while leaving the row and
  // its comment in place, and EVERY other check in this file passed. Emptiness
  // satisfies a universal quantifier -- `[].every(...)` is true, no field is
  // non-finite, no band exceeds the radius cap. The form simply drew nothing.
  const minBands = Math.min(...PATTERNS.map((p) => p.bands.length))
  check(minBands >= 1, 'and every form declares at least one band to draw',
    `thinnest is ${minBands}`)

  // Every parameter row must be complete. A missing field arrives in the shader
  // as an undefined -> NaN in a Float32Array, which does not throw and does not
  // draw -- the single worst failure mode this system has, because it looks
  // exactly like "that form is rare".
  const FIELDS = ['dist', 'az', 'span', 'alt0', 'alt1', 'fold', 'foldHz', 'speed', 'drift',
    'ray', 'rayHz', 'lobes', 'ragged', 'flick', 'fringe', 'pulse', 'tintAmt', 'bright', 'seed',
    'pale', 'crown', 'shear', 'breathe', 'meander', 'curl']
  let badField = ''
  for (const p of PATTERNS) {
    for (const b of p.bands) {
      for (const f of FIELDS) if (!Number.isFinite(b[f])) badField = `${p.name}.${f}`
      if (!Array.isArray(b.tint) || b.tint.length !== 3 || b.tint.some((v) => !Number.isFinite(v))) {
        badField = `${p.name}.tint`
      }
      if (!(b.alt1 > b.alt0)) badField = `${p.name}: alt1 <= alt0`
      if (bandRadiusKm(b) > MAX_RADIUS_KM) badField = `${p.name}: radius ${bandRadiusKm(b).toFixed(0)} km`
    }
  }
  check(badField === '', 'every band carries every parameter as a finite number', badField)

  // Sweep a simulated fortnight of in-world time. Nothing here may exceed the
  // slot budget, and -- the real point -- nothing may JUMP: a form appearing or
  // vanishing at full brightness in one step is the pop the adaptive cut in
  // composeAuto exists to prevent.
  // One FRAME, not one second: 1 real minute is 1 in-world hour, so a 60 Hz
  // frame is 1/3600 of an in-world hour. Sweeping at the display's own rate is
  // the only step size at which "does a curtain vanish in one frame" is
  // literally the question being asked.
  const STEP = 1 / 3600
  const SPAN = 336 // two in-world weeks
  let maxBandsSeen = 0
  let maxLiveSeen = 0
  let emptyFrames = 0
  let worstJump = 0
  let worstJumpAt = 0
  const seenPatterns = new Set()
  const floorIdx = PATTERNS.findIndex((p) => p.floor)
  let floorMissing = 0
  // Primed one step BEFORE the sweep starts, or the first iteration measures a
  // jump from an empty sky and reports a pop that is an artefact of the loop.
  let prev = new Map(composeAuto(-STEP, 0.5, 20260804).map((l) => [l.index, l.weight]))
  for (let h = 0; h < SPAN; h += STEP) {
    // Activity is driven the same way the clock drives it, so the windows in
    // the catalogue are exercised across their whole range rather than at one
    // arbitrary value.
    const act = 0.5 + 0.5 * Math.sin(h * 0.21)
    const live = composeAuto(h, act, 20260804)
    if (live.length > maxLiveSeen) maxLiveSeen = live.length
    const bands = bandsFor(live)
    if (bands.length > maxBandsSeen) maxBandsSeen = bands.length
    const now = new Map()
    for (const l of live) {
      seenPatterns.add(l.index)
      now.set(l.index, l.weight)
    }
    for (const idx of new Set([...now.keys(), ...prev.keys()])) {
      const d = Math.abs((now.get(idx) ?? 0) - (prev.get(idx) ?? 0))
      if (d > worstJump) {
        worstJump = d
        worstJumpAt = h
      }
    }
    if (live.length === 0) emptyFrames++
    if (!now.has(floorIdx)) floorMissing++
    prev = now
  }
  // The clock can say the aurora is at 85% while the composer has nothing to
  // show, and the result is a HUD reporting a sky that is not there. The
  // always-available diffuse form exists to make that impossible; this is the
  // assertion that says so.
  check(emptyFrames === 0, 'the sky is never empty while the aurora is up',
    `${emptyFrames} empty frames of ${Math.round(SPAN / STEP)}`)
  check(maxLiveSeen <= MAX_CONCURRENT + 1, 'the composer never overlays more forms than it promises',
    `worst ${maxLiveSeen} of ${MAX_CONCURRENT} + the floor`)
  // The floor is the whole reason the sky is never empty, so assert that it is
  // genuinely always there rather than merely usually there.
  check(floorMissing === 0, 'and the diffuse floor is in every single frame',
    `missing from ${floorMissing} frames`)
  check(maxBandsSeen <= SLOTS, 'and never asks for more bands than there are slots',
    `worst ${maxBandsSeen} of ${SLOTS}`)
  // 0.005 per frame is a fade no faster than about three seconds end to end.
  // For scale: the naive "sort and keep the top three" stepped a full 1.0, and
  // the version that skipped the crossfade when nothing was contending stepped
  // 0.13.
  check(worstJump < 0.005, 'and no form appears or vanishes in a single frame',
    `worst ${worstJump.toFixed(4)} at h=${worstJumpAt.toFixed(2)}`)
  check(seenPatterns.size === PATTERNS.length, 'every named form actually occurs over a fortnight',
    `${seenPatterns.size} of ${PATTERNS.length}`)

  // The vortex family. What makes these read as smoke rather than as fabric is
  // a shear past a full fold wavelength, so "is there a vapour form" is
  // literally a question about that one number -- which means it can be
  // checked rather than admired.
  const vortex = PATTERNS.filter((p) => p.bands.every((b) => b.shear > 0.8))
  check(vortex.length >= 3, 'there are at least three forms that twist rather than hang',
    vortex.map((p) => p.name).join(', '))
  // ...and they have to be soft. A twisting column with hard vertical
  // striations still reads as a curtain, just a bent one.
  const rayy = vortex.filter((p) => p.bands.some((b) => b.ray > 0.5))
  check(rayy.length === 0, 'and none of them is striated enough to read as a curtain',
    rayy.map((p) => p.name).join(', ') || 'all soft')

  // Colour varies form to form. This is a promise the HUD makes implicitly --
  // pinning a different pattern should change what you see, not just where it
  // is -- and it is one table column away from being silently untrue.
  const palettes = new Set(PATTERNS.map((p) =>
    `${p.bands[0].pale.toFixed(2)}/${p.bands[0].crown.toFixed(2)}/${p.bands[0].tintAmt.toFixed(2)}`))
  check(palettes.size >= 8, 'the forms do not all share one colour mix',
    `${palettes.size} distinct palettes across ${PATTERNS.length} forms`)

  // Source assertions, for the three shape properties that have no numeric
  // handle anywhere else. Each of these is a specific complaint that was
  // fixed, and each would regress invisibly.
  const auroraSrc = readFileSync(new URL('./aurora.js', import.meta.url), 'utf8')

  // ---- Does the GLSL even compile?
  //
  // This gate runs in node, so it cannot link a program, and for one release
  // that gap swallowed the entire system: `float mScale = 250.0 / A.x;` was
  // declared twice in the same scope of the vertex shader's main(). That is a
  // GLSL redefinition error, the program never linked, and the aurora did not
  // draw a single pixel at any hour under any pattern -- while every numeric
  // check in this file went on passing, because the numbers it checks are in
  // the catalogue and the catalogue was fine. Worse, the check right below
  // asserts that the mScale line is PRESENT, which two copies satisfy twice
  // over. A presence check cannot see a duplicate.
  //
  // So: a same-scope redeclaration scan. Brace depth gives the scopes, a fresh
  // Set per block gives same-scope-only semantics (GLSL does allow an inner
  // block to shadow an outer name, so only the top Set is consulted), and
  // for-init declarations are skipped because GLSL scopes those to the loop.
  // This is not a compiler, and it is not trying to be -- it catches the one
  // error class that is invisible to every other check here and fatal to all
  // of them.
  const shaderFiles = ['aurora.js']
  let shaderCount = 0
  const dupes = shaderFiles.flatMap((f) => {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    return shadersIn(src).flatMap((glsl) => {
      shaderCount++
      return redeclarations(glsl).map((n) => `${f}: ${n}`)
    })
  })
  check(dupes.length === 0, 'no shader declares the same name twice in one scope, so the GLSL links',
    dupes.length ? dupes.join(', ') : `${shaderCount} shaders clean`)
  // The presence envelope, which is what makes a band a set of lit REGIONS that
  // move rather than a ribbon that dims. Two scales of noise and an asymmetric
  // curve, and each half is a separate promise: drop the second octave and the
  // regions get big and even, straighten the curve and the band sits at a
  // steady middling brightness instead of spending most of its life faint and
  // occasionally flaring.
  check(/float mac = aurNoise[\s\S]{0,60}\* 0\.62\s*\n\s*\+ aurNoise[\s\S]{0,60}\* 0\.38;/
    .test(auroraSrc), 'the presence envelope works at two scales, not one')
  check(/pow\( smoothstep\( 0\.20, 0\.90, mac \), 2\.0 \)/.test(auroraSrc),
    'and its curve is asymmetric, so a band is usually faint and occasionally flares')
  check(/float breath = mix\( 1\.0, 0\.25 \+ 0\.75 \* aurNoise\( vec2\( E\.z \* 7\.3/.test(auroraSrc),
    'and a whole form comes and goes as well as parts of it')
  check(/float dep = smoothstep\( 0\.0, vCol\.z, h \)/.test(auroraSrc),
    'the bottom hem fades over a per-column width instead of a fixed one')
  check(/aurFold\( km \+ shear, t, amp/.test(auroraSrc),
    'and the fold pattern leans with altitude instead of standing straight up')
  // The meander has to be the LONGEST wave here, it must not be scaled by hz (or
  // a form with tight folds stops snaking and goes back to a ruled line), and it
  // must be scaled by mScale (or a 295 km arc shows four times the swings of an
  // 86 km one across the same span of sky, which reads as fuzz rather than as a
  // path).
  const foldFn = auroraSrc.slice(auroraSrc.indexOf('vec2 aurFold('), auroraSrc.indexOf('function buildGeometry'))
  const rates = [...foldFn.matchAll(/t \* (0\.\d+)/g)].map((m) => Number(m[1]))
  check(Math.min(...rates) === 0.014 && rates.filter((r) => r === 0.014).length === 2,
    'the meander is the slowest wave in the fold, and it is one wave in two axes',
    `rates ${[...new Set(rates)].join(', ')}`)
  const wavelengths = [...foldFn.matchAll(/\* (0\.\d+)( \* hz)?,/g)].map((m) => Number(m[1]))
  check(Math.min(...wavelengths) === 0.0034 && !/0\.0034 \* hz/.test(foldFn),
    'and it is the longest, and foldHz does not touch it',
    `scales ${[...new Set(wavelengths)].join(', ')}`)
  check(/float mkm = km \* ms;/.test(auroraSrc) && /float mScale = 250\.0 \/ A\.x;/.test(auroraSrc),
    'and it is measured in degrees of sky, so a distant arc snakes as widely as a near one')
  // The tangential term: without it the footprint is r(theta), single-valued in
  // azimuth, and cannot double back at any amplitude.
  check(/vec3 p = \( dir \* \( A\.x \+ f0\.x \) \+ tng \* f0\.y/.test(auroraSrc),
    'and the footprint carries a tangential term, so it is a curve and not a polar graph')
  // Both components have to enter the finite difference, or the normal is the
  // normal of a shape that is not being drawn and the edge-on brightening in
  // the fragment shader points the wrong way.
  check(/tng \* \( dk \+ f1\.y - f0\.y \) \+ dir \* \( f1\.x - f0\.x \)/.test(auroraSrc),
    'and the surface normal is differenced along the curve the vertices are on')
  const rayLookup = auroraSrc.slice(auroraSrc.indexOf('float ray = aurNoise'),
    auroraSrc.indexOf('float crisp'))
  check(!/\bh\b|vShape\.x|\balt\b/.test(rayLookup),
    'and the striations still contain no altitude term at all', rayLookup.trim().split('\n')[0])

  // Pinning. The hotkey has to reach every form and come back to auto, or some
  // of the catalogue is unreachable by hand and therefore untestable.
  const scene = new THREE.Scene()
  const aur = new Aurora(scene, { seed: 3 })
  check(aur.pattern === -1, 'the aurora starts in auto mode')
  const visited = new Set()
  for (let i = 0; i < PATTERNS.length; i++) visited.add(aur.cyclePattern())
  check(visited.size === PATTERNS.length && !visited.has(-1),
    'cycling reaches every named form exactly once', `${visited.size} forms`)
  check(aur.cyclePattern() === -1, 'and the next press returns to auto')

  // Uniform packing: a pinned form must land in slot 0 with the rest switched
  // off, and switching off is exactly `bright = 0` -- the test the vertex
  // shader's early return makes.
  aur.setPattern(4)
  const st = new WorldClock({ hour: 1, seed: 20260804 }).state()
  aur.update(new THREE.Vector3(), st, 0)
  const used = PATTERNS[4].bands.length
  let packed = true
  for (let i = 0; i < SLOTS; i++) {
    const bright = aur.bandA[i * 4 + 3]
    if (i < used ? !(bright > 0.0015) : bright !== 0) packed = false
  }
  check(packed, 'a pinned form fills exactly its own slots and blanks the rest',
    `${used} of ${SLOTS} live`)
  check(aur.label.includes(PATTERNS[4].name), 'and the HUD label names it', aur.label)

  aur.setPattern(-1)
  aur.update(new THREE.Vector3(), st, 0)
  check(aur.live.length > 0 && aur.label.startsWith('auto'), 'auto mode reports what it chose',
    aur.label)

  // The label goes on one HUD line, and the panel is 1024 px with a 22 px
  // margin at 26 px monospace (advance 0.60 em) = 62 characters. Now that the
  // reserved floor means two forms are up almost always and four are possible,
  // the unbudgeted version ran to 98 characters and simply fell off the right
  // edge -- silently, because canvas fillText does not complain.
  let longest = ''
  for (let h = 0; h < 400; h += 0.01) {
    aur.live = composeAuto(h, 0.5 + 0.5 * Math.sin(h * 0.21), 20260804)
    const line = `pattern ${aur.label}`
    if (line.length > longest.length) longest = line
  }
  check(longest.length <= 62, 'and the report fits on one line of the panel',
    `${longest.length} of 62 chars: ${longest}`)
  aur.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
