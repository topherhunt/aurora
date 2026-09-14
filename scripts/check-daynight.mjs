// ---------------------------------------------------------------------------
// Gate for the day-night cycle, the horizon-map shadows, the sky and the stars.
// The aurora appears here only as the clock state that drives it; the mesh that
// used to draw it is archived, with its own gate at
// archive/aurora-mesh/check-aurora-mesh.mjs.
//
// What makes this system worth gating is that ALL of its failure modes are
// silent. A latitude typo gives a sun that rises in the wrong place -- and it
// still rises, and it still sets, and the sunset is still orange. A palette
// keyframe out of order gives a flash at dusk that lasts two frames on a
// headset nobody is wearing at the time. A `.replace()` in a shader patch that
// matches nothing leaves the shader compiling perfectly and doing nothing.
// None of that throws. So this file measures the things instead.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { WorldClock, CLOCK, MOON, MOONLIGHT, paletteAt, celestial } from '../src/clock.js'
import { bakeHorizon, decodeHorizon, AZIMUTHS, HORIZON_SOFT } from '../src/sim/horizon.js'
import { WorldLighting } from '../src/lighting.js'
import { createPropMaterial, setWindEnabled } from '../src/material.js'
import { buildTextureArray } from '../src/textures.js'
import { Sky } from '../src/sky.js'
import { Stars } from '../src/stars.js'
import { shadersIn, redeclarations } from './lib/glsl-scope.mjs'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const DEG = Math.PI / 180
// ===========================================================================
console.log('\n--- clock: the pace -------------------------------------------')
// ===========================================================================

{
  const c = new WorldClock({ hour: 0 })
  // §8: 24 real minutes = 24 in-world hours. One real minute is one hour.
  c.advance(60)
  check(Math.abs(c.elapsed - 1) < 1e-9, 'one real minute is one in-world hour', `got ${c.elapsed.toFixed(6)} h`)

  c.advance(60 * 60 * 24 / 24)
  const before = c.elapsed
  c.skip(CLOCK.skipHours)
  check(Math.abs(c.elapsed - before - CLOCK.skipHours) < 1e-9, `skip advances exactly ${CLOCK.skipHours} h`)

  // The skip has to move the MONOTONIC counter, not the hour of day. If it
  // wrapped first, skipping a whole day would leave the aurora's substorm noise
  // standing still -- you would skip forward and get the identical sky.
  const d = new WorldClock({ hour: 12 })
  for (let i = 0; i < 4; i++) d.skip(6)
  check(Math.abs(d.hour - 12) < 1e-9, 'four skips return to the same hour of day', `${d.clockText}`)
  check(Math.abs(d.elapsed - 36) < 1e-9, 'and to a different point in the substorm cycle', `elapsed ${d.elapsed} h`)
  check(d.state().activity !== new WorldClock({ hour: 12 }).state().activity, 'aurora activity differs after a full day skipped')

  // The wall-clock pace, which is what netplay syncs on: elapsed is derived
  // from an anchor, so two clocks built at different moments but handed the
  // same anchor agree, and a skip is a count the anchor's owner can restate.
  const e = new WorldClock({ hour: 0, anchorMs: 1000 })
  e.tick(61000)
  check(Math.abs(e.elapsed - 1) < 1e-9, 'tick: one real minute past the anchor is one in-world hour', `got ${e.elapsed.toFixed(6)} h`)
  e.skip(6)
  e.tick(61000)
  check(Math.abs(e.elapsed - 7) < 1e-9, 'tick: a local skip survives the next tick', `got ${e.elapsed.toFixed(6)} h`)
  const f = new WorldClock({ hour: 0, anchorMs: 999999 })
  f.sync({ anchorMs: 1000, skipHours: 6 })
  f.tick(61000)
  check(Math.abs(f.elapsed - e.elapsed) < 1e-9, 'sync: a clock built later agrees once handed the same anchor and skips', `${f.elapsed} vs ${e.elapsed}`)
  f.sync({ anchorMs: 1000, skipHours: 0 })
  f.tick(61000)
  check(Math.abs(f.elapsed - 1) < 1e-9, 'sync: the relay\'s skip count replaces the local one rather than adding to it', `got ${f.elapsed}`)
}

// ===========================================================================
console.log('\n--- clock: solar geometry -------------------------------------')
// ===========================================================================

{
  // Sample the whole day finely and measure the shape of it.
  const N = 24 * 240
  let riseHour = null
  let setHour = null
  let maxElev = -90
  let maxHour = 0
  let prev = celestial(0, CLOCK.latitude, CLOCK.declination).elevDeg
  for (let k = 1; k <= N; k++) {
    const h = (k / N) * 24
    const e = celestial(h, CLOCK.latitude, CLOCK.declination).elevDeg
    if (prev < 0 && e >= 0) riseHour = h
    if (prev >= 0 && e < 0) setHour = h
    if (e > maxElev) { maxElev = e; maxHour = h }
    prev = e
  }

  check(riseHour !== null && setHour !== null, 'the sun rises and sets', `rise ${riseHour?.toFixed(2)} set ${setHour?.toFixed(2)}`)
  const dayLen = setHour - riseHour
  // At 65 N with a -4 deg declination, spherical trig says the half-day arc is
  // acos(-tan(phi) tan(dec)) -- an 11.2 hour day. Anything materially different
  // means the latitude or the declination is not what the file says it is.
  const halfDay = Math.acos(-Math.tan(CLOCK.latitude * DEG) * Math.tan(CLOCK.declination * DEG)) / DEG / 15
  check(Math.abs(dayLen - 2 * halfDay) < 0.05, 'day length matches the closed-form solution', `${dayLen.toFixed(2)} h vs ${(2 * halfDay).toFixed(2)} h`)
  check(dayLen > 9 && dayLen < 14, 'and leaves a long usable night', `${dayLen.toFixed(2)} h of daylight`)

  check(Math.abs(maxHour - 12) < 0.02, 'the sun culminates at solar noon', `${maxHour.toFixed(3)} h`)
  const expectMax = 90 - CLOCK.latitude + CLOCK.declination
  check(Math.abs(maxElev - expectMax) < 0.02, 'at 90 - latitude + declination', `${maxElev.toFixed(2)} deg`)
  check(maxElev < 30, 'which is low enough for long shadows all day', `${maxElev.toFixed(1)} deg`)

  // Azimuth: the sun must come up in the east half and go down in the west
  // half, and pass through due south at noon. Getting the atan2 arguments
  // swapped produces a sun that rises in the north and nothing else complains.
  const riseAz = celestial(riseHour, CLOCK.latitude, CLOCK.declination).azDeg
  const setAz = celestial(setHour, CLOCK.latitude, CLOCK.declination).azDeg
  const noonAz = celestial(12, CLOCK.latitude, CLOCK.declination).azDeg
  check(riseAz > 60 && riseAz < 120, 'rises in the east', `az ${riseAz.toFixed(1)}`)
  check(setAz > 240 && setAz < 300, 'sets in the west', `az ${setAz.toFixed(1)}`)
  check(Math.abs(noonAz - 180) < 0.5, 'is due south at noon', `az ${noonAz.toFixed(2)}`)
  check(Math.abs(360 - setAz - riseAz) < 0.5, 'and rise/set azimuths are symmetric about south')

  // Continuity. A jump anywhere in here is a light that snaps across the sky.
  let worstJump = 0
  let pa = celestial(0, CLOCK.latitude, CLOCK.declination)
  for (let k = 1; k <= N; k++) {
    const a = celestial((k / N) * 24, CLOCK.latitude, CLOCK.declination)
    const d = Math.hypot(a.x - pa.x, a.y - pa.y, a.z - pa.z)
    if (d > worstJump) worstJump = d
    pa = a
  }
  check(worstJump < 0.01, 'the sun direction is continuous all day', `worst step ${worstJump.toFixed(5)}`)
}

// ===========================================================================
console.log('\n--- clock: the moon -------------------------------------------')
// ===========================================================================

{
  const c = new WorldClock({ hour: 0 })
  let moonUpDarkHours = 0
  let darkHours = 0
  let moonRises = 0
  let prevUp = null
  const N = 24 * 60
  for (let k = 0; k < N; k++) {
    c.elapsed = (k / N) * 24
    c._recompute()
    const up = c.moon.elevDeg > 0
    if (prevUp === false && up) moonRises++
    prevUp = up
    if (c.sun.elevDeg < -6) {
      darkHours += 24 / N
      if (up) moonUpDarkHours += 24 / N
    }
  }
  check(moonRises === 1, 'the moon rises once a day', `${moonRises}`)
  const frac = moonUpDarkHours / darkHours
  // The ask was a crescent moon RISING with a pale glow, visible through the
  // night. If it were up for only a third of the dark it would be a detail
  // most sessions never saw.
  check(frac > 0.75, 'and is up for most of the dark', `${(frac * 100).toFixed(0)}% of ${darkHours.toFixed(1)} dark hours`)

  check(c.moonLit > 0.05 && c.moonLit < 0.35, 'the moon is a crescent', `${(c.moonLit * 100).toFixed(0)}% lit`)
  check(MOON.lit !== null, 'the illuminated fraction is art-directed, and says so in clock.js')

  // The terminator orientation is NOT art-directed -- it is derived from the
  // real sun direction. Check that the two are actually decoupled: the sun
  // moves through the night, so the illumination axis on the moon's disc has
  // to move with it.
  c.elapsed = 22
  c._recompute()
  const a = { ...c.sun }
  c.elapsed = 2
  c._recompute()
  const b = c.sun
  const swing = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) / DEG
  check(swing > 30, 'and the sun swings enough overnight for the horns to visibly turn', `${swing.toFixed(0)} deg`)
}

// ===========================================================================
console.log('\n--- palette: continuity and shape -----------------------------')
// ===========================================================================

{
  // Sweep the whole elevation range at a resolution far finer than the sun ever
  // moves in a frame, and look for a step. This is the check that catches a
  // keyframe typed out of order, which is otherwise a two-frame flash at dusk.
  const CH = ['horizon', 'zenith', 'glow', 'fog', 'haze', 'hemiSky', 'hemiGround']
  const SC = ['glowAmt', 'sunIntensity', 'hemiIntensity', 'stars', 'auroraMax', 'moonBright', 'glowSharp']
  let worst = 0
  let worstAt = ''
  let prev = paletteAt(90)
  const STEPS = 20000
  for (let k = 1; k <= STEPS; k++) {
    const e = 90 - (k / STEPS) * 180
    const p = paletteAt(e)
    for (const c of CH) {
      for (let i = 0; i < 3; i++) {
        const d = Math.abs(p[c][i] - prev[c][i])
        if (d > worst) { worst = d; worstAt = `${c}[${i}] at ${e.toFixed(2)} deg` }
      }
    }
    for (const c of SC) {
      // Scalars are on wildly different scales; normalise by the range each one
      // actually covers so one threshold can cover all of them.
      const d = Math.abs(p[c] - prev[c]) / (c === 'glowSharp' ? 5 : Math.max(1, 1))
      if (d > worst) { worst = d; worstAt = `${c} at ${e.toFixed(2)} deg` }
    }
    prev = p
  }
  // 0.009 per 0.009 deg of sun travel. The sun crosses the twilight band at
  // about 6 deg per in-world hour, i.e. 0.1 deg per real second, so this bounds
  // the on-screen rate of change to well under one 8-bit code per frame.
  check(worst < 0.009, 'the palette has no discontinuity anywhere', `worst step ${worst.toFixed(5)} (${worstAt})`)

  // Shape. These are the promises the palette is making to the rest of the
  // scene, and each one is load-bearing somewhere.
  check(paletteAt(45).sunIntensity > 2, 'daylight is bright')
  check(paletteAt(-6).sunIntensity === 0, 'the sun contributes nothing by the end of civil twilight')
  check(paletteAt(-6.0001).sunIntensity === 0, 'so the sun/moon handover at -6 deg is invisible')
  check(paletteAt(20).stars === 0, 'no stars in daylight')
  check(paletteAt(-18).stars === 1, 'full stars by astronomical twilight')
  check(paletteAt(20).auroraMax === 0, 'no aurora in daylight')
  check(paletteAt(-14).auroraMax > 0.8, 'and a full ceiling once it is properly dark')

  let mono = true
  for (let e = 20; e > -30; e -= 0.25) if (paletteAt(e - 0.25).stars < paletteAt(e).stars - 1e-9) mono = false
  check(mono, 'stars only ever fade IN as the sun sets')

  let fogMono = true
  for (let e = 20; e > -30; e -= 0.25) if (paletteAt(e - 0.25).fogDensity < paletteAt(e).fogDensity - 1e-12) fogMono = false
  check(fogMono, 'fog only thickens as it gets dark')

  // And haze runs the other way, which is the whole reason it is a second
  // number. fogDensity is the night-vision device and thickens after dark;
  // hazeDensity is daylight scattering -- the aerial-perspective extinction
  // coefficient -- and has to THIN, or the moonlit valley ends at the next
  // hill. Anyone who later "fixes" the two to agree breaks one of them.
  let hazeMono = true
  for (let e = 20; e > -30; e -= 0.25) if (paletteAt(e - 0.25).hazeDensity > paletteAt(e).hazeDensity + 1e-12) hazeMono = false
  check(hazeMono, 'haze only thins as it gets dark, opposite to fog')
  check(paletteAt(45).hazeDensity > paletteAt(-18).hazeDensity * 4, 'so daylight has far more aerial perspective than night')

  // The brief for the aerial ramp: a hillside is essentially untouched close in
  // and essentially a silhouette by 1.5 km. These are the two ends of the curve
  // lighting.js draws, keep = exp(-(d * density)^2), at the noon density. The
  // far end was 1 km until the extinction was stretched by 1.5x on the note that
  // it was biting too early; the near end got looser for free.
  const noonHaze = paletteAt(45).hazeDensity
  const keepAt = (d) => Math.exp(-((d * noonHaze) ** 2))
  check(keepAt(200) > 0.95, 'a nearby tree keeps its own colour', `keep ${(keepAt(200) * 100).toFixed(0)}%`)
  check(keepAt(1500) < 0.1, 'and a 1.5 km hillside is down to a silhouette', `keep ${(keepAt(1500) * 100).toFixed(0)}%`)
  check(keepAt(700) > 0.4 && keepAt(700) < 0.75,
    'with the mid distance still half its own colour, where the depth cue lives',
    `keep ${(keepAt(700) * 100).toFixed(0)}% at 700 m`)

  // And the column is one hue: no row may go magenta, which is what following
  // `fog` through its sunset hues would do. See the note on the pair in clock.js.
  let hueOk = true
  let hueAt = ''
  for (let e = 25; e >= -18; e -= 0.25) {
    const h = paletteAt(e).haze
    if (h[0] >= h[1] || h[1] >= h[2]) { hueOk = false; hueAt = `${e.toFixed(2)} deg: ${h.map((v) => v.toFixed(3)).join(', ')}` }
  }
  check(hueOk, 'the haze stays blue at every hour rather than drifting purple', hueAt)

  // The floor is duplicated at -18 and -90 on purpose so the bottom of the
  // sweep is flat; if someone edits one row and not the other this catches it.
  const a = paletteAt(-18)
  const b = paletteAt(-90)
  let flat = true
  for (const k of Object.keys(a)) {
    const va = [a[k]].flat()
    const vb = [b[k]].flat()
    for (let i = 0; i < va.length; i++) if (Math.abs(va[i] - vb[i]) > 1e-9) flat = false
  }
  check(flat, 'nothing changes below astronomical twilight')
}

// ===========================================================================
console.log('\n--- aurora: gating and substorm cycle -------------------------')
// ===========================================================================

{
  const c = new WorldClock({ hour: 12, seed: 20260804 })
  let dayMax = 0
  let nightMax = 0
  let nightMin = 1
  let nightSamples = 0
  const N = 24 * 120
  for (let k = 0; k < N; k++) {
    c.elapsed = (k / N) * 24
    c._recompute()
    const s = c.state()
    if (c.sun.elevDeg > 0) dayMax = Math.max(dayMax, s.aurora)
    if (c.sun.elevDeg < -15) {
      nightMax = Math.max(nightMax, s.aurora)
      nightMin = Math.min(nightMin, s.aurora)
      nightSamples++
    }
  }
  check(dayMax === 0, 'the aurora is exactly zero while the sun is up', `max ${dayMax}`)
  check(nightSamples > 0, 'and there are properly dark hours to put it in')
  check(nightMax > 0.6, 'it reaches storm strength during the night', `peak ${(nightMax * 100).toFixed(0)}%`)
  check(nightMin > 0.05, 'and never vanishes entirely -- a quiet arc is the default state', `floor ${(nightMin * 100).toFixed(0)}%`)
  check(nightMax - nightMin > 0.3, 'so the night has a visible arc-to-breakup progression', `range ${((nightMax - nightMin) * 100).toFixed(0)}%`)

  // Ambient tinting (§13: the aurora tints the world, it does not sit on a
  // layer in front of it). Find the strongest moment and check the hemisphere
  // light actually went green.
  let best = null
  for (let k = 0; k < N; k++) {
    c.elapsed = (k / N) * 24
    c._recompute()
    const s = c.state()
    if (!best || s.aurora > best.aurora) best = s
  }
  const base = paletteAt(-18)
  check(best.hemiSky[1] > base.hemiSky[1], 'a strong aurora pushes green into the scene ambient',
    `${base.hemiSky[1].toFixed(3)} -> ${best.hemiSky[1].toFixed(3)}`)
  check(best.hemiSky[0] < base.hemiSky[0], 'and pulls red out of it')
}

// ===========================================================================
console.log('\n--- horizon map: correctness ----------------------------------')
// ===========================================================================

{
  // Exactness against brute force. The convex-hull sweep is an EXACT algorithm,
  // not an approximation, so the only error allowed is the byte quantisation --
  // half a step, 0.176 deg.
  const n = 96
  const cell = 16
  const elev = new Float32Array(n * n)
  let s = 12345
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) elev[j * n + i] = Math.sin(i * 0.21) * 180 + Math.cos(j * 0.17) * 140 + rnd() * 60
  }
  const { horizon, sky } = bakeHorizon(elev, n, cell)

  check(horizon.length === n * n * AZIMUTHS, 'the map has one layer per azimuth', `${AZIMUTHS} layers`)

  // Azimuth 4 of 16 is due east: +i with j fixed, so the brute force is a
  // one-line scan along a row.
  const layer = 4 * n * n
  let worst = 0
  for (let j = 0; j < n; j += 3) {
    for (let i = 0; i < n; i += 2) {
      let m = 0
      for (let k = i + 1; k < n; k++) {
        const sl = (elev[j * n + k] - elev[j * n + i]) / ((k - i) * cell)
        if (sl > m) m = sl
      }
      const d = Math.abs(Math.atan(m) - decodeHorizon(horizon[layer + j * n + i])) / DEG
      if (d > worst) worst = d
    }
  }
  const quantum = 90 / 255
  check(worst <= quantum / 2 + 1e-6, 'every angle matches brute force to within the byte quantisation',
    `worst ${worst.toFixed(4)} deg vs ${(quantum / 2).toFixed(4)} allowed`)
  check(quantum / 2 < (HORIZON_SOFT / DEG) / 2, 'and the quantisation is finer than the shadow edge is soft',
    `${(quantum / 2).toFixed(3)} deg vs a ${(HORIZON_SOFT / DEG).toFixed(2)} deg penumbra`)

  check(sky.length === n * n, 'sky visibility comes out of the same bake')
  let skyMin = 255
  let skyMax = 0
  for (const v of sky) { if (v < skyMin) skyMin = v; if (v > skyMax) skyMax = v }
  check(skyMin >= Math.round(0.16 * 255) - 1, 'ambient occlusion never reaches black', `min ${(skyMin / 255).toFixed(3)}`)
  check(skyMax <= 255 && skyMax > 200, 'and open ground sees nearly the whole sky', `max ${(skyMax / 255).toFixed(3)}`)
}

// ===========================================================================
console.log('\n--- horizon map: it actually casts a shadow --------------------')
// ===========================================================================

{
  // A flat plain with one east-west wall across it. Everything about this case
  // is known in closed form, which is the point: it separates "the bake ran"
  // from "the bake is right".
  const n = 128
  const cell = 16
  const WALL_J = 64
  const WALL_H = 200
  const elev = new Float32Array(n * n)
  for (let i = 0; i < n; i++) elev[WALL_J * n + i] = WALL_H

  const { horizon, sky } = bakeHorizon(elev, n, cell)
  // Azimuth 8 of 16 is due south (+j); azimuth 0 is due north (-j).
  const south = 8 * n * n
  const north = 0

  const at = (layer, j) => decodeHorizon(horizon[layer + j * n + 64]) / DEG
  const want = (j) => Math.atan(WALL_H / ((WALL_J - j) * cell)) / DEG

  let ok = true
  for (const j of [40, 30, 20, 10]) if (Math.abs(at(south, j) - want(j)) > 0.2) ok = false
  check(ok, 'ground north of the wall sees it to the south at the right angle',
    `j=40: ${at(south, 40).toFixed(2)} deg (want ${want(40).toFixed(2)})`)

  let clear = true
  for (const j of [40, 30, 20, 10]) if (at(north, j) > 0.001) clear = false
  check(clear, 'and sees nothing at all to the north')

  // The shading test the shader will do, replicated exactly.
  const soft = HORIZON_SOFT / DEG
  const lit = (layer, j, sunElevDeg) => {
    const h = at(layer, j)
    const t = Math.max(0, Math.min(1, (sunElevDeg - (h - soft)) / (2 * soft)))
    return t * t * (3 - 2 * t)
  }
  check(lit(south, 40, 20) < 0.01, 'a 20 deg sun in the south leaves j=40 in full shadow', `vis ${lit(south, 40, 20).toFixed(3)}`)
  check(lit(south, 10, 20) > 0.99, 'and j=10, further away, in full sun', `vis ${lit(south, 10, 20).toFixed(3)}`)
  check(lit(south, 40, 60) > 0.99, 'a 60 deg sun clears the wall everywhere', `vis ${lit(south, 40, 60).toFixed(3)}`)
  check(lit(north, 40, 5) > 0.99, 'and a sun in the north is never blocked by a wall to the south')

  // The shadow edge has to MOVE as the sun climbs, or the whole exercise was
  // pointless. Find where it falls at two elevations.
  const edgeAt = (elevDeg) => {
    for (let j = WALL_J - 1; j >= 0; j--) if (lit(south, j, elevDeg) > 0.5) return j
    return -1
  }
  const e15 = edgeAt(15)
  const e35 = edgeAt(35)
  check(e15 >= 0 && e35 >= 0 && e35 > e15, 'the shadow edge retreats toward the wall as the sun rises',
    `j=${e15} at 15 deg -> j=${e35} at 35 deg (${(WALL_J - e15) * cell} m -> ${(WALL_J - e35) * cell} m of shade)`)

  // AO: the ground right at the foot of the wall sees half a sky.
  const foot = sky[(WALL_J - 1) * n + 64] / 255
  const open = sky[2 * n + 64] / 255
  check(foot < open - 0.05, 'the foot of the wall is occluded relative to open ground',
    `${foot.toFixed(3)} vs ${open.toFixed(3)}`)
}

// ===========================================================================
console.log('\n--- shader patches actually land ------------------------------')
// ===========================================================================

// A `.replace()` whose pattern is not found returns the string unchanged. Every
// shader patch in this project is one of those, and a three.js version bump that
// renames a chunk would silently disable the lot -- shaders still compile, world
// still renders, shadows quietly gone. So: run the patches against three's real
// shader source and assert the code arrived.
{
  // WITH MAPS, because that is the variant these assertions are about. The
  // patch has two compile-time axes (see lighting.js): with no maps the horizon
  // lookup is deliberately absent, and asserting its presence against an
  // unready WorldLighting would be asserting the wrong build. Four texels of
  // flat ground is enough -- nothing here reads a value out of them.
  const lighting = new WorldLighting()
  const MAP_N = 4
  lighting.setMaps(new Uint8Array(MAP_N * MAP_N * AZIMUTHS), new Uint8Array(MAP_N * MAP_N), MAP_N)
  const compile = (material) => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    }
    material.onBeforeCompile(shader, null)
    return shader
  }

  const terrain = createTerrainMaterial()
  lighting.patch(terrain, { mode: 'fragment', cacheKey: 'gate-terrain', worldPosVarying: 'vWorldPos' })
  const t = compile(terrain)
  check(t.fragmentShader.includes('uniform sampler2DArray uHorizonMap'), 'terrain: the horizon sampler is declared')
  check(t.fragmentShader.includes('wlSun( vWorldPos.xz )'), 'terrain: sun visibility is sampled per fragment')
  check(t.fragmentShader.includes('reflectedLight.directDiffuse *= wlSun'), 'terrain: shadow multiplies the DIRECT term')
  check(t.fragmentShader.includes('reflectedLight.indirectDiffuse *= wlSky'), 'terrain: occlusion multiplies the INDIRECT term')
  check(t.uniforms.uHorizonMap === lighting.uniforms.uHorizonMap, 'terrain: shares the one uniform object, by reference')
  // The chained patch is the easy thing to break: WorldLighting.patch replaces
  // onBeforeCompile, and forgetting to call the previous one removes the
  // terrain's entire surface grain without any error at all.
  check(t.fragmentShader.includes('uSpeckle'), "terrain: the material's own patch still ran")
  check(t.vertexShader.includes('vWorldPos = ( modelMatrix'), 'terrain: and its world-position varying survived')

  const prop = new THREE.MeshLambertMaterial()
  lighting.patch(prop, { mode: 'vertex', cacheKey: 'gate-prop' })
  const p = compile(prop)
  check(p.vertexShader.includes('vWlShade = vec3( wlSun('), 'props: sampled once per vertex')
  check(p.vertexShader.includes('batchingMatrix * wlLocal'), 'props: world position handles BatchedMesh')
  check(p.vertexShader.includes('instanceMatrix * wlLocal'), 'props: and InstancedMesh')
  check(p.fragmentShader.includes('reflectedLight.directDiffuse *= vWlShade.x'), 'props: applied in the fragment shader')
  check(!p.fragmentShader.includes('uHorizonMap'), 'props: and do NOT pay for a texture fetch per fragment')

  check(terrain.customProgramCacheKey() !== prop.customProgramCacheKey(), 'the two patched Lamberts do not share a program')

  // AND THE CACHE KEY IS CHAINED TOO, for the same reason onBeforeCompile is.
  // createPropMaterial's key varies with what it compiles in and out -- the
  // billboard layers, the strip tiling, and whether the wind block is there at
  // all. A patch that REPLACED the key would pin the material to one entry in
  // three's program cache, so flipping any of those would re-run
  // onBeforeCompile, look the result up under the unchanged key, and get back
  // the program compiled the first time. No error, no recompile, no effect --
  // which is how the menu's wind switch came to read "no difference".
  {
    const atlas = buildTextureArray()
    const grass = createPropMaterial(atlas, { stripTiling: true, wind: 'grass' })
    const own = grass.customProgramCacheKey()
    lighting.patch(grass, { mode: 'vertex', cacheKey: 'gate-grass' })
    const patched = grass.customProgramCacheKey()
    check(patched !== 'gate-grass' && patched.includes(own),
      "a patched prop material still carries its OWN cache key", patched)
    setWindEnabled(false)
    check(grass.customProgramCacheKey() !== patched,
      'so compiling the wind out still moves the key three caches on',
      `${patched} -> ${grass.customProgramCacheKey()}`)
    setWindEnabled(true)
  }

  // THE TWO COMPILE-TIME AXES, and both of them are the silent-failure shape
  // this section exists for: a switch that flips a flag, recompiles nothing,
  // and reports "no difference" from a headset.
  //
  //   UNREADY is what the whole /v2 route ships as today -- nothing calls
  //   setMaps() there -- so the horizon lookup can only ever return its
  //   constant, and emitting it anyway is two sampler declarations and two dead
  //   fetches per terrain fragment and per prop vertex, in every material.
  //
  //   OFF is the headset panel's `terrain & prop lighting` row. It has to emit
  //   NOTHING: the row's whole job is an A/B for what this system costs, and a
  //   row that leaves the instructions running measures zero and reads as a
  //   switch that does not work. It did exactly that until it grew this axis.
  {
    const flat = new WorldLighting()
    const ft = flat.patch(createTerrainMaterial(), { mode: 'fragment', cacheKey: 'gate-flat-t', worldPosVarying: 'vWorldPos' })
    const fp = flat.patch(new THREE.MeshLambertMaterial(), { mode: 'vertex', cacheKey: 'gate-flat-p' })
    const ftc = compile(ft), fpc = compile(fp)
    check(!ftc.fragmentShader.includes('uHorizonMap'), 'unready: the terrain declares no horizon sampler')
    check(ftc.fragmentShader.includes('aerialKeep'), 'unready: but keeps the aerial ramp, which needs no map')
    check(!fpc.vertexShader.includes('wlSun('), 'unready: and a prop vertex samples nothing')
    check(fpc.vertexShader.includes('vWlNear ='), 'unready: carrying only the near-field envelope across')
    check(ft.customProgramCacheKey() !== terrain.customProgramCacheKey(),
      'unready and ready are two entries in three\'s program cache',
      `${ft.customProgramCacheKey()} vs ${terrain.customProgramCacheKey()}`)

    const before = ft.customProgramCacheKey()
    flat.setEnabled(false)
    const offc = compile(ft)
    check(!offc.fragmentShader.includes('aerialKeep') && !offc.fragmentShader.includes('uCaustic'),
      'off: the terrain gets back stock fog and no caustic net')
    check(!compile(fp).vertexShader.includes('vWlNear'), 'off: and a prop vertex carries nothing')
    check(offc.fragmentShader.includes('uSpeckle'), "off: the material's own patch still ran")
    check(ft.customProgramCacheKey() !== before, 'off moves the key, so the recompile is not handed the old program',
      `${before} -> ${ft.customProgramCacheKey()}`)
    flat.setEnabled(true)
    check(compile(ft).fragmentShader.includes('aerialKeep'), 'and back on restores it')
  }

  // No unresolved template holes anywhere -- `${WORLD_HALF}` interpolating to
  // undefined would produce GLSL that fails to compile on the headset only.
  for (const [name, src] of [['terrain vert', t.vertexShader], ['terrain frag', t.fragmentShader], ['prop vert', p.vertexShader]]) {
    check(!/undefined|NaN|\[object/.test(src), `${name}: no unresolved template values`)
  }
}

// ===========================================================================
console.log('\n--- sky and stars: geometry and shader hygiene -----------------')
// ===========================================================================

{
  const scene = new THREE.Scene()
  const sky = new Sky(scene)
  const stars = new Stars(scene, { seed: 20260804 })

  const shaders = [
    ['sky vert', sky.material.vertexShader], ['sky frag', sky.material.fragmentShader],
    ['stars vert', stars.material.vertexShader], ['stars frag', stars.material.fragmentShader],
  ]
  for (const [name, src] of shaders) {
    check(!/undefined|NaN|\[object/.test(src), `${name}: no unresolved template values`)
    const open = (src.match(/{/g) || []).length
    const close = (src.match(/}/g) || []).length
    check(open === close, `${name}: braces balance`, `${open}/${close}`)
  }

  // Additive and depth-tested but not depth-written: that combination is what
  // makes terrain occlude the stars without any sorting.
  check(stars.material.blending === THREE.AdditiveBlending,
    'stars: additive, so overlap is order-independent')
  check(stars.material.depthTest === true && stars.material.depthWrite === false,
    'stars: depth tested, never written')
  check(stars.material.fog === false, 'stars: not fogged')

  // Everything off during the day, so this whole system is free at noon.
  const noon = new WorldClock({ hour: 12 }).state()
  const head = new THREE.Vector3()
  stars.update(head, noon, 12, 0)
  check(!stars.points.visible, 'the stars draw nothing at all in daylight')

  const night = new WorldClock({ hour: 1, seed: 20260804 }).state()
  stars.update(head, night, 1, 0)
  check(stars.points.visible, 'and they are up at 01:00')

  // The sky dome must never write depth or be culled: the camera lives inside
  // it, and it is drawn before everything else.
  check(sky.material.depthWrite === false && sky.mesh.renderOrder < 0, 'the sky dome draws first and writes no depth')
  check(sky.mesh.frustumCulled === false, 'and is never frustum culled')
}

// ===========================================================================
console.log('\n--- the live shaders link --------------------------------------')
// ===========================================================================

// This gate runs in node, so it cannot link a program, and for one release that
// gap swallowed a whole system: a `float mScale` declared twice in one scope of
// a vertex shader's main() is a GLSL redefinition error, so the program never
// linked and the mesh drew no pixel at any hour -- while every numeric check
// went on passing, because the numbers it checked were in a catalogue and the
// catalogue was fine. A presence check cannot see a duplicate. The scanner is
// in scripts/lib/glsl-scope.mjs because the archived mesh's own gate needs it
// too.
{
  const shaderFiles = ['src/sky.js', 'src/stars.js', 'src/lighting.js', 'src/water.js']
  let shaderCount = 0
  const dupes = shaderFiles.flatMap((f) => {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    return shadersIn(src).flatMap((glsl) => {
      shaderCount++
      return redeclarations(glsl).map((n) => `${f}: ${n}`)
    })
  })
  check(dupes.length === 0, 'no shader declares the same name twice in one scope, so the GLSL links',
    dupes.length ? dupes.join(', ') : `${shaderCount} shaders clean`)
}

// ===========================================================================
// Night has to be navigable.
//
// This is the one thing in the whole day-night system that cannot be checked by
// reading the palette: "is it bright enough to walk around in" is a question
// about the FINAL PIXEL, which is albedo x (hemisphere irradiance) x occlusion
// plus the additive lift, and the answer for a dark surface is nothing like the
// answer for snow. So the model below reproduces three.js's Lambert +
// HemisphereLight maths and reports sRGB bytes, which is the number the eye
// actually gets.
// ===========================================================================
{
  console.log('\n--- night is navigable -----------------------------------------')

  // three's HemisphereLight irradiance, from lights_pars_begin:
  //   mix( groundColor, skyColor, 0.5 + 0.5 * normal.y ) * intensity
  // Colours are linear in the shader, so the palette's sRGB has to be
  // linearised first -- getting this backwards is a factor of two and would
  // make the whole measurement a fiction.
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
  const lin3 = (v) => v.map(toLin)

  // Albedos of the surfaces that actually matter, as authored. The trunk is the
  // hard case and the reason the additive lift exists at all.
  const SURFACES = [
    { name: 'grass, lit side up', albedo: [0.20, 0.26, 0.13], ny: 0.9, sky: 0.62, sun: 1 },
    { name: 'grass, in shadow', albedo: [0.20, 0.26, 0.13], ny: 0.9, sky: 0.30, sun: 0 },
    { name: 'rock in a gully', albedo: [0.31, 0.30, 0.29], ny: 0.4, sky: 0.12, sun: 0 },
    { name: 'tree trunk', albedo: [0.05, 0.04, 0.03], ny: 0.0, sky: 0.35, sun: 0 },
    { name: 'snow', albedo: [0.88, 0.90, 0.95], ny: 1.0, sky: 0.80, sun: 1 },
    // The same two materials again with the moon on the other side of the
    // ridge. These exist to be differenced against the two above: the thing
    // the night is judged on is not any one brightness, it is the RATIO.
    { name: 'grass, moon behind ridge', albedo: [0.20, 0.26, 0.13], ny: 0.9, sky: 0.30, sun: 0 },
    { name: 'snow, moon behind ridge', albedo: [0.88, 0.90, 0.95], ny: 1.0, sky: 0.20, sun: 0 },
  ]

  // The subset she actually puts her feet on. Separated from SURFACES because
  // the two carry different promises: a tree trunk is allowed to go to a
  // silhouette at 03:00, the ground under it is not.
  const GROUND = SURFACES.filter((s) => s.name !== 'tree trunk' && !s.name.startsWith('snow'))

  // `near` is lighting.js's near-field envelope: 1 within 25 m of the head, 0
  // beyond 50. It scales the ambient terms toward state.farAmbient and the
  // directional term toward state.farDirect. Defaulting it to 1 means every
  // check written before round five still measures what it used to.
  const lumaAt = (state, s, near = 1) => {
    const dirK = state.farDirect + (1 - state.farDirect) * near
    const ambK = state.farAmbient + (1 - state.farAmbient) * near
    const skyC = lin3(state.hemiSky)
    const grC = lin3(state.hemiGround)
    const irr = skyC.map((v, i) => (grC[i] + (v - grC[i]) * (0.5 + 0.5 * s.ny)) * state.hemiIntensity)

    // lighting.js: the occlusion term is floored, and the additive lift rides
    // the floored value.
    const skyF = state.skyFloor + (1 - state.skyFloor) * s.sky
    const lift = lin3(state.skyGlow).map((v) => v * state.skyGlowAmt)

    const dirC = lin3(state.lightColor)
    const out = [0, 1, 2].map((i) => {
      const indirect = (irr[i] * s.albedo[i] * skyF + lift[i] * skyF) * ambK
      // The directional term is generous to the check, not to the render: a
      // surface fully facing the moon. If even that is dark the palette is
      // wrong regardless of geometry.
      const direct =
        dirC[i] * state.lightIntensity * s.albedo[i] * s.sun * Math.max(state.lightDir.y, 0) * dirK
      return toSrgb(Math.min(1, indirect + direct))
    })
    return Math.round(255 * (0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2]))
  }

  // 01:00 with the moon where it happens to be, which is the ordinary case.
  const night = new WorldClock({ hour: 1, seed: 20260804 }).state()
  check(night.isNight, 'it is properly dark at 01:00', `sun ${night.sun.elevDeg.toFixed(1)} deg`)

  let darkest = 255
  let darkestName = ''
  for (const s of SURFACES) {
    const l = lumaAt(night, s)
    if (l < darkest) {
      darkest = l
      darkestName = s.name
    }
    console.log(`       ${s.name.padEnd(22)} luma ${String(l).padStart(3)}`)
  }
  // Before the night lift existed the darkest of these measured 0. The first
  // pass at fixing that overshot into a grey wash, so the lift and the
  // occlusion floor were then halved; luma 6 is about where an sRGB display
  // stops being distinguishable from black, and a 4%-albedo tree trunk sitting
  // just above it is right -- a trunk at night IS a silhouette.
  check(darkest >= 4, 'nothing in the world reads as pure black at night',
    `darkest is ${darkestName} at luma ${darkest}`)
  // But what she WALKS ON is a different promise and gets its own floor. The
  // ground can be dark; it cannot be unreadable, or the night stops being
  // atmospheric and starts being a navigation failure.
  const groundWorst = Math.min(...GROUND.map((s) => lumaAt(night, s)))
  check(groundWorst >= 10, 'and the ground she walks on stays readable', `worst ground luma ${groundWorst}`)
  // And the other end: night must not be a grey wash. Snow well above rock is
  // what makes it read as moonlight rather than as ambient turned up. The
  // ratio is 4 rather than 2.5 because halving the additive lift -- which adds
  // the same amount to a trunk as to snow, and therefore FLATTENS -- bought
  // back a good deal of contrast.
  const snow = lumaAt(night, SURFACES[4])
  check(snow > darkest * 4, 'and night still has real contrast in it',
    `snow ${snow} vs darkest ${darkest}`)
  check(snow < 200, 'without blowing the snow out', `snow ${snow}`)

  // ---- Slope contrast, which is the check the night was actually missing.
  //
  // Everything above measures how BRIGHT the night is. None of it measures
  // whether the night has a shape, and a world lit brightly enough to pass all
  // of it can still be flat and even and grey -- which is what this one was.
  // The cause was a ratio, not a level: ambient light has no direction, so
  // while it dominated, a slope facing the moon and a slope facing away from
  // it rendered nearly the same. The fix was to raise MOONLIGHT.intensity and
  // cut the night ambient in the same move.
  //
  // Measured at a full moon well up rather than at whatever the clock's own
  // moon happens to be doing, because the phase is a different question: a
  // thin crescent SHOULD flatten the world, and the promise here is only that
  // a good moon gives the world a lit side and a dark side.
  const full = new WorldClock({ hour: 1, seed: 20260804 }).state()
  full.lightDir = { ...full.lightDir, y: 0.8 }
  // moonPow is moonUp^2-smoothed x (0.35 + 0.65 * moonLit), which is exactly
  // 1.0 for a full moon well clear of the horizon.
  full.lightIntensity = MOONLIGHT.intensity
  const litGrass = lumaAt(full, SURFACES[0])
  const shadeGrass = lumaAt(full, SURFACES[5])
  const litSnow = lumaAt(full, SURFACES[4])
  const shadeSnow = lumaAt(full, SURFACES[6])
  console.log(`       full moon: grass ${litGrass} lit / ${shadeGrass} shaded,` +
    ` snow ${litSnow} lit / ${shadeSnow} shaded`)
  // 3:1 is the line between "you can tell which way that hillside faces" and
  // "the terrain is a grey field". Before this round it measured 2.4:1 on
  // grass, which passed every brightness check in this file and still looked
  // like nothing.
  check(litGrass / shadeGrass >= 3, 'a moonlit slope is plainly brighter than a shaded one',
    `${(litGrass / shadeGrass).toFixed(1)}:1 on grass`)
  check(litSnow / shadeSnow >= 3, 'and the same is true of snow, which is where she can see furthest',
    `${(litSnow / shadeSnow).toFixed(1)}:1 on snow`)
  // And the moonlit side has to be bright enough to actually walk by, not
  // merely brighter than the dark side. Snow under a full moon is the one
  // surface in this world that is genuinely easy to see.
  check(litSnow >= 150 && litSnow < 210, 'and moonlit snow is bright enough to navigate by',
    `luma ${litSnow}`)
  // The other end of the same promise: with the moon behind the ridge, the
  // far side is nearly out. This is asserted as an UPPER bound, which is the
  // opposite of every other check here and is the point -- a shaded slope that
  // measures 34 is not a shaded slope, it is ambient with a story attached.
  check(shadeGrass <= 26, 'while the shaded side goes most of the way to a silhouette',
    `luma ${shadeGrass}`)

  // The worst case is not 01:00, it is whichever dark hour the moon happens to
  // be under the horizon for -- there the directional light is off entirely and
  // the hemisphere plus the lift are all there is. If the world is navigable
  // then, it is navigable all night.
  //
  // This used to be one number -- the darkest any ground got at any hour, with
  // a floor of 12 -- and that single number is what made the night flat. It
  // cannot be met except by lifting the ambient until the whole world sits
  // above 12, and ambient lifts the moonlit side and the shaded side by the
  // same amount. The check enforced the exact thing being complained about.
  //
  // So it is two promises now, and they pull in opposite directions:
  //   - where the moon reaches, she can always see her way;
  //   - where it does not, she mostly cannot, but the world is still there.
  //
  // The lit half is only promised while the moon is actually delivering light.
  // A moon at 3 degrees of elevation through a thin crescent is not a light
  // source, and requiring the world to be navigable then would put the ambient
  // straight back where it was. `moonPow` is the clock's own term for this; the
  // product with the light's y is what reaches a horizontal surface.
  let worstLit = 255
  let worstLitHour = 0
  let worstDark = 255
  let darkHours = 0
  let moonlessHours = 0
  for (let h = 0; h < 24; h += 0.05) {
    const st = new WorldClock({ hour: h, seed: 20260804 }).state()
    if (!st.isNight) continue
    darkHours += 0.05
    const reach = st.lightIntensity * Math.max(st.lightDir.y, 0)
    if (reach < 0.15) moonlessHours += 0.05
    for (const s of GROUND) {
      const l = lumaAt(st, s)
      if (s.sun === 1) {
        if (reach >= 0.15 && l < worstLit) {
          worstLit = l
          worstLitHour = h
        }
      } else if (l < worstDark) {
        worstDark = l
      }
    }
  }
  check(darkHours > 8, 'the night is long enough to be worth lighting', `${darkHours.toFixed(1)} h dark`)
  check(worstLit >= 40, 'ground the moon reaches is readable whenever the moon is up',
    `worst lit ground luma ${worstLit} at ${worstLitHour.toFixed(2)} h`)
  // And the moonless stretch has to be a stretch, not the whole night -- if it
  // were, the lit-side promise above would be vacuous.
  check(moonlessHours < darkHours * 0.5, 'and the moon is up for most of it',
    `${moonlessHours.toFixed(1)} of ${darkHours.toFixed(1)} h moonless`)
  // 6 is roughly where an sRGB display stops separating from black. A gully
  // floor at 8 with the moon on the far side of the ridge is not a bug, it is
  // the request: dark enough that she navigates by the skyline and the aurora
  // rather than by the ground, and not so dark that the ground is gone.
  check(worstDark >= 6, 'and ground it does not reach is dark without being gone',
    `worst shaded ground luma ${worstDark}`)

  // =========================================================================
  // The far field. Everything above measures the ground at her feet; these
  // measure the same surfaces at 100 m, where lighting.js has faded the two
  // ambient terms out and scaled the directional one down.
  //
  // The point of the split is stated as a RATIO, not as a level, for the same
  // reason the moonlight ratio is: what went wrong before was that ambient --
  // which has no direction -- was most of the light out there, so a slope
  // facing the moon and a slope facing away measured the same and the
  // landscape had no shape. See the FAR FIELD block in clock.js.
  // =========================================================================
  const FAR = 0 // the envelope is fully out beyond 50 m
  const nearLit = lumaAt(night, SURFACES[0], 1)
  const farLit = lumaAt(night, SURFACES[0], FAR)
  const farShade = lumaAt(night, SURFACES[1], FAR)
  const farTrunk = lumaAt(night, SURFACES[3], FAR)
  const farSnow = lumaAt(night, SURFACES[4], FAR)
  console.log(`       far field at 01:00: lit grass ${farLit}, shaded grass ${farShade}, trunk ${farTrunk}, snow ${farSnow}`)
  check(farLit >= nearLit * 0.4 && farLit <= nearLit * 0.62,
    'distant moonlit ground is about half as bright as the ground at her feet',
    `${farLit} vs ${nearLit}`)
  // The other half of the request, and the one that makes the far field read
  // as landscape: with no ambient out there, a surface the moon cannot see is
  // the colour of nothing. Fog is what fills it back in with distance, not
  // light -- which is why it stays a silhouette instead of a grey wash.
  check(farShade === 0 && farTrunk === 0,
    'and ground the moon cannot see is genuinely black out there, not grey',
    `shaded grass ${farShade}, trunk ${farTrunk}`)
  // Slope contrast is the thing being bought. Near the head it is finite
  // because the ambient floor is there on purpose; in the far field the only
  // light is directional, so the ratio is unbounded and the check is that the
  // lit side is still worth looking at.
  check(farSnow >= 60, 'while distant moonlit snow still carries the ridgelines', `luma ${farSnow}`)

  // Daylight must be untouched: the envelope is a night mechanism and a
  // 25 m pool of brightness at noon would be grotesque.
  for (const h of [9, 12, 15]) {
    const st = new WorldClock({ hour: h }).state()
    check(st.farDirect === 1 && st.farAmbient === 1, `the near-field envelope is inert at ${h}:00`,
      `${st.farDirect} / ${st.farAmbient}`)
  }
  // The two radii live in lighting.js as constants baked into the generated
  // GLSL, so the source is the only place they can be read back from.
  const lightSrc = readFileSync(new URL('../src/lighting.js', import.meta.url), 'utf8')
  const near = Number(lightSrc.match(/const WL_NEAR_M = ([\d.]+)/)[1])
  const far = Number(lightSrc.match(/const WL_FAR_M = ([\d.]+)/)[1])
  check(/1\.0 - smoothstep\( \$\{WL_NEAR_M[\s\S]{0,120}distance\([\s\S]{0,40}cameraPosition/.test(lightSrc),
    'the near-field envelope is a distance-to-the-head falloff', `${near} m to ${far} m`)
  // The envelope must have NO PLATEAU. An inner radius above zero makes it a
  // fully-lit disc with the falloff outside it, and a disc with an edge that
  // travels with the player is a spotlight -- which is exactly what it looked
  // like at 25/50, and exactly what the request asked to be taken out. Zero
  // inner radius is the whole of "scale gradually from your current location
  // outward", so it is worth a check of its own rather than a comment.
  check(near === 0, 'and it starts falling off at her feet rather than at the edge of a lit disc',
    `inner radius ${near} m`)
  // smoothstep is symmetric about its midpoint, so this is the knob that keeps
  // the near field about as bright as it was while the plateau goes away.
  const mid = (near + far) / 2
  check(mid > 30 && mid < 45, 'and half strength still lands where it did before the plateau went',
    `half at ${mid} m`)
  const sampleNear = (d) => {
    const x = Math.min(Math.max((d - near) / (far - near), 0), 1)
    return 1 - x * x * (3 - 2 * x)
  }
  console.log(`       near-field lift: ${[0, 10, 25, 40, 60, 75]
    .map((d) => `${d}m ${(sampleNear(d) * 100).toFixed(0)}%`).join('  ')}`)
  // No step anywhere. A gradient she walks through must not have a knee in it,
  // and 4% per metre is well under what shows as banding on ground texture.
  let worstStep = 0
  for (let d = 0; d < far + 5; d += 0.5) {
    worstStep = Math.max(worstStep, Math.abs(sampleNear(d) - sampleNear(d + 0.5)))
  }
  check(worstStep < 0.02, 'and nothing in it reads as an edge', `worst ${(worstStep * 100).toFixed(1)}% per 0.5 m`)
  check(/reflectedLight\.directDiffuse \*= \$\{sun\} \* mix\( uFarLight\.x, 1\.0, wlNear \)/.test(lightSrc),
    'the directional term is scaled by distance but still shadowed')
  check(/mix\( uSkyFloor, 1\.0, \$\{sky\} \) \* mix\( uFarLight\.y, 1\.0, wlNear \)/.test(lightSrc),
    'and both ambient terms -- the multiplied one and the added lift -- fade together')

  // ---- Distance. FogExp2 in three is factor = 1 - exp(-(density * d)^2).
  //
  // Round four used this to make the far half of the landscape stop resolving
  // at night, and round six backs that out: fog is applied AFTER the lighting,
  // so a density that erases a ridge at 600 m erases it no matter how well the
  // moon is lighting it, and the world at night ended at the next hill. The
  // promise these checks now guard is the opposite one -- at night you can
  // still SEE the valley, dim and low-contrast and blue, and what makes the
  // distance dim is the far-field lighting split below, not the fog.
  const fogAt = (d, m) => 1 - Math.exp(-Math.pow(d * m, 2))
  const deepNight = paletteAt(-28)
  const noonFog = paletteAt(45).fogDensity
  const at = (m) => fogAt(deepNight.fogDensity, m)
  console.log(`       night fog: ${[30, 100, 300, 600, 1000]
    .map((m) => `${m}m ${(at(m) * 100).toFixed(0)}%`).join('  ')}`)
  check(at(30) < 0.02, 'what is right in front of her is not fogged at all',
    `${(at(30) * 100).toFixed(1)}% at 30 m`)
  check(at(100) < 0.10, 'and the near field still reads as ground rather than as haze',
    `${(at(100) * 100).toFixed(0)}% at 100 m`)
  // The regression this replaces: at 0.0022 these read 70% and 99%.
  check(at(1000) < 0.20, 'and a moonlit ridge a kilometre out is still scenery, not a hole',
    `${(at(1000) * 100).toFixed(0)}% at 1 km`)
  check(at(3000) > 0.35 && at(6000) > 0.85, 'while genuine distance still recedes',
    `${(at(3000) * 100).toFixed(0)}% at 3 km, ${(at(6000) * 100).toFixed(0)}% at 6 km`)
  // Night air is not actually thicker than day air. Whatever rise there is
  // here is a look choice, and it should stay small enough to be one.
  check(deepNight.fogDensity > noonFog && deepNight.fogDensity < noonFog * 2,
    'and night is hazier than noon by a look-choice margin, not by an order of magnitude',
    `${deepNight.fogDensity} vs ${noonFog}`)
  // A silhouette only reads as one if it is DARKER than what it is against.
  // Fog brighter than the sky would give haze, which is the daytime look and
  // the opposite of the request.
  const fogLuma = 0.2126 * deepNight.fog[0] + 0.7152 * deepNight.fog[1] + 0.0722 * deepNight.fog[2]
  const skyLuma = 0.2126 * deepNight.horizon[0] + 0.7152 * deepNight.horizon[1] +
    0.0722 * deepNight.horizon[2]
  check(fogLuma < skyLuma * 0.8, 'and the far distance is darker than the sky it stands against',
    `fog ${fogLuma.toFixed(3)} vs horizon ${skyLuma.toFixed(3)}`)
  // Daylight is not part of any of this and must not have moved.
  check(noonFog < 0.0003, 'and none of it touches daylight', `noon density ${noonFog}`)
  // Village fires are the one thing exempted, and it is exempted in a file the
  // rest of this gate never looks at, so assert it from here.
  const villageSrc = readFileSync(new URL('../src/village/village.js', import.meta.url), 'utf8')
  check(/flameMat = new THREE\.MeshBasicMaterial\(\{ vertexColors: true, fog: false \}\)/
    .test(villageSrc), 'but a village fire still burns through it')

  // The daylight end has to be untouched. The lift and the floor are both
  // exactly zero above the horizon, so noon renders bit-for-bit as it did
  // before any of this existed.
  const noon = new WorldClock({ hour: 12 }).state()
  check(noon.skyGlowAmt === 0 && noon.skyFloor === 0, 'the night lift is exactly off at noon',
    `lift ${noon.skyGlowAmt}, floor ${noon.skyFloor}`)

  // Continuity, same argument as the rest of the palette: a step in either of
  // these is a step in the brightness of every surface in the world at once.
  let worst = 0
  for (let e = 25; e >= -90; e -= 0.005) {
    const a = paletteAt(e)
    const b = paletteAt(e - 0.005)
    worst = Math.max(worst, Math.abs(a.skyFloor - b.skyFloor),
      Math.abs(a.skyGlowAmt - b.skyGlowAmt) * 10,
      // Same argument, and it applies harder here: a step in farAmbient is a
      // step in the brightness of everything past 50 m, which is most of the
      // frame.
      Math.abs(a.farDirect - b.farDirect), Math.abs(a.farAmbient - b.farAmbient))
  }
  check(worst < 0.002, 'the night lift ramps continuously with the sun', `worst step ${worst.toFixed(5)}`)

  // And the lift must be applied additively, not as another multiplier -- that
  // is the entire reason it exists, so it is worth asserting against the source
  // rather than trusting the comment.
  const lightingSrc = readFileSync(new URL('../src/lighting.js', import.meta.url), 'utf8')
  check(/indirectDiffuse \+= uNightLift/.test(lightingSrc),
    'lighting.js adds the night lift rather than multiplying by it')
  check(/mix\( uSkyFloor, 1\.0,/.test(lightingSrc),
    'and floors the occlusion term instead of letting it reach zero')
}

// ===========================================================================
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
