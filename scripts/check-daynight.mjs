// ---------------------------------------------------------------------------
// Gate for the day-night cycle, the horizon-map shadows, and the aurora.
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
import { Sky } from '../src/sky.js'
import { Stars } from '../src/stars.js'
import { Aurora } from '../src/aurora.js'
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
} from '../src/aurora-patterns.js'
import { createTerrainMaterial } from '../src/terrain/terrain-material.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const DEG = Math.PI / 180
// World units per kilometre, mirroring KM in src/aurora.js.
const KM_UNITS = 45

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
  const CH = ['horizon', 'zenith', 'glow', 'fog', 'hemiSky', 'hemiGround']
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
  const lighting = new WorldLighting()
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

  // No unresolved template holes anywhere -- `${WORLD_HALF}` interpolating to
  // undefined would produce GLSL that fails to compile on the headset only.
  for (const [name, src] of [['terrain vert', t.vertexShader], ['terrain frag', t.fragmentShader], ['prop vert', p.vertexShader]]) {
    check(!/undefined|NaN|\[object/.test(src), `${name}: no unresolved template values`)
  }
}

// ===========================================================================
console.log('\n--- sky, stars and aurora: geometry and shader hygiene ---------')
// ===========================================================================

{
  const scene = new THREE.Scene()
  const sky = new Sky(scene)
  const stars = new Stars(scene, { seed: 20260804 })
  const aurora = new Aurora(scene)

  const shaders = [
    ['sky vert', sky.material.vertexShader], ['sky frag', sky.material.fragmentShader],
    ['stars vert', stars.material.vertexShader], ['stars frag', stars.material.fragmentShader],
    ['aurora vert', aurora.material.vertexShader], ['aurora frag', aurora.material.fragmentShader],
  ]
  for (const [name, src] of shaders) {
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
  for (const [name, m] of [['stars', stars.material], ['aurora', aurora.material]]) {
    check(m.blending === THREE.AdditiveBlending, `${name}: additive, so overlap is order-independent`)
    check(m.depthTest === true && m.depthWrite === false, `${name}: depth tested, never written`)
    check(m.fog === false, `${name}: not fogged`)
  }

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
  const auroraSrc = readFileSync(new URL('../src/aurora.js', import.meta.url), 'utf8')

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
  stars.update(head, noon, 12, 0)
  aurora.update(head, noon, 0)
  check(!stars.points.visible && !aurora.mesh.visible, 'stars and aurora draw nothing at all in daylight')

  const night = new WorldClock({ hour: 1, seed: 20260804 }).state()
  stars.update(head, night, 1, 0)
  aurora.update(head, night, 0)
  check(stars.points.visible && aurora.mesh.visible, 'and both are up at 01:00')

  // The sky dome must never write depth or be culled: the camera lives inside
  // it, and it is drawn before everything else.
  check(sky.material.depthWrite === false && sky.mesh.renderOrder < 0, 'the sky dome draws first and writes no depth')
  check(sky.mesh.frustumCulled === false, 'and is never frustum culled')
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
  const auroraSrc = readFileSync(new URL('../src/aurora.js', import.meta.url), 'utf8')

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
  const TYPES = 'float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|mat2|mat3|mat4'
  // One shader at a time, not one file at a time: the vertex and fragment
  // shaders are separate translation units that legitimately declare the same
  // varying names, and scanning the whole JS file makes every varying look like
  // a duplicate. So: pull out every template literal that contains a main(),
  // which is exactly the set of shader sources, and scan each on its own.
  const shadersIn = (src) =>
    (src.match(/`[^`]*\bvoid\s+main\s*\(\s*\)[^`]*`/g) || []).map((t) => t.slice(1, -1))
  // Preprocessor branches are not duplicates: water.js declares fogAmt once
  // under #ifdef FOG_EXP2 and once under #else, and only one of those is ever
  // compiled. Keep the first branch of every conditional and drop the rest --
  // crude, but it is the right answer for this question, and the alternative is
  // evaluating the preprocessor, which is a compiler.
  const stripPre = (glsl) => {
    const out = []
    const skip = []
    for (const line of glsl.split('\n')) {
      const t = line.trim()
      if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) { skip.push(false); continue }
      if (/^#\s*(else|elif)\b/.test(t)) { if (skip.length) skip[skip.length - 1] = true; continue }
      if (/^#\s*endif\b/.test(t)) { skip.pop(); continue }
      if (t.startsWith('#')) continue
      out.push(skip.some(Boolean) ? '' : line)
    }
    return out.join('\n')
  }
  const redeclarations = (glsl) => {
    const clean = stripPre(glsl).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    const bad = []
    // The synthetic outermost Set is the shader's global scope, so a uniform
    // and a global of the same name are caught too.
    const stack = [new Set()]
    const re = new RegExp(
      `[{}]|\\bfor\\s*\\(|\\b(?:uniform|attribute|varying|in|out|const)?\\s*(?:${TYPES})\\s+([A-Za-z_]\\w*)\\s*(?=[=;,)\\[])`,
      'g')
    let m
    let forDepth = -1
    while ((m = re.exec(clean))) {
      if (m[0] === '{') stack.push(new Set())
      else if (m[0] === '}') { if (stack.length > 1) stack.pop() }
      else if (m[0].trimStart().startsWith('for')) forDepth = stack.length
      else {
        // Anything declared while a for-header is open belongs to the loop.
        if (forDepth === stack.length) { forDepth = -1; continue }
        const scope = stack[stack.length - 1]
        if (scope.has(m[1])) bad.push(m[1])
        else scope.add(m[1])
      }
    }
    return bad
  }
  const shaderFiles = ['aurora.js', 'sky.js', 'stars.js', 'lighting.js', 'water.js']
  let shaderCount = 0
  const dupes = shaderFiles.flatMap((f) => {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
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
