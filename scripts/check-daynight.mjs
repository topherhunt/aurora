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

import * as THREE from 'three'
import { WorldClock, CLOCK, MOON, paletteAt, celestial } from '../src/clock.js'
import { bakeHorizon, decodeHorizon, AZIMUTHS, HORIZON_SOFT } from '../src/sim/horizon.js'
import { WorldLighting } from '../src/lighting.js'
import { Sky } from '../src/sky.js'
import { Stars } from '../src/stars.js'
import { Aurora } from '../src/aurora.js'
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
  check(p.vertexShader.includes('vWlShade = vec2( wlSun('), 'props: sampled once per vertex')
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

  // Geometry placement. Everything has to sit inside the camera's 20000 m far
  // plane and outside anything the terrain can reach, or it either clips out or
  // gets buried in a mountain.
  const pos = aurora.mesh.geometry.attributes.position
  let rMin = Infinity
  let rMax = 0
  let elevMin = 90
  for (let i = 0; i < pos.count; i++) {
    // The vertex shader scales by KM; the buffer holds kilometres.
    const x = pos.getX(i) * 45
    const y = pos.getY(i) * 45
    const z = pos.getZ(i) * 45
    const r = Math.hypot(x, y, z)
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    const e = Math.atan2(y, Math.hypot(x, z)) / DEG
    if (e < elevMin) elevMin = e
  }
  check(rMax < 20000, 'the aurora fits inside the far plane', `${rMax.toFixed(0)} of 20000 m`)
  check(rMin > 4000, 'and sits well beyond any terrain', `nearest ${rMin.toFixed(0)} m`)
  check(elevMin > 15, 'no part of it is low enough for a mountain to wrongly occlude',
    `lowest ${elevMin.toFixed(1)} deg above the horizon`)

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
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
