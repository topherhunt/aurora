// Node-side gate for the weather channel and the overcast palette (§10,
// src/clock.js WEATHER, WorldClock.coverAt, overcast).
//
//   node scripts/check-weather.mjs
//
// What it measures: that the channel is a function of the room and nothing
// else (two clocks on one anchor agree at every tick, two anchors do not, a
// skip moves it); that cover 0 leaves the palette bit-identical at every sun
// elevation; that no frame steps the light more than the day-night gate
// allows; and the episode histogram -- ten rooms, two in-world weeks each at
// one-minute resolution -- against the §10 targets: most rain spells between
// one and five hours, rain neither rare nor constant, and a fair day in most
// fortnights; and that the sky dome's haze uniforms end its horizon in the
// land's fog, a band on a clear day and the whole horizon under rain.

import * as THREE from 'three'
import { WorldClock, WEATHER, paletteAt } from '../src/clock.js'
import { makeSkyUniforms, writeSkyUniforms, SKY_HAZE_M } from '../src/sky-glsl.js'
import { airCeiling } from '../src/lighting.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

const ANCHOR = 1758240000000 // 2025-09-19T00:00:00Z; any fixed anchor
const HOUR_MS = 60000

// --- determinism ------------------------------------------------------------
console.log('\n--- weather: a function of the room ---------------------------')
{
  const a = new WorldClock({ hour: 6, anchorMs: ANCHOR })
  const b = new WorldClock({ hour: 6, anchorMs: 999 })
  b.sync({ anchorMs: ANCHOR, skipHours: 0 })
  let worst = 0
  for (let i = 0; i < 24 * 14 * 60; i++) {
    const now = ANCHOR + i * 1000
    a.tick(now)
    b.tick(now)
    worst = Math.max(worst, Math.abs(a.state().cover - b.state().cover))
  }
  check(worst === 0, 'two clocks handed the same anchor draw the same cover at every second of a fortnight')

  const c = new WorldClock({ hour: 6, anchorMs: ANCHOR + 7 * 60000 })
  let differ = 0
  for (let i = 0; i < 24 * 60; i++) {
    const now = ANCHOR + 7 * 60000 + i * 60000
    a.tick(now)
    c.tick(now)
    if (Math.abs(a.state().cover - c.state().cover) > 0.02) differ++
  }
  check(differ > 24 * 60 * 0.5, 'a room opened seven minutes later has its own weather', `${differ} of ${24 * 60} minutes differ by more than 0.02`)

  const d = new WorldClock({ hour: 6, anchorMs: ANCHOR })
  d.tick(ANCHOR + 10 * HOUR_MS)
  const before = d.state().cover
  d.skip(24)
  check(d.state().cover !== before, 'a skip of a whole day lands on different weather')

  const e = new WorldClock({ hour: 6, anchorMs: ANCHOR, weather: 0.7 })
  e.tick(ANCHOR + 5 * HOUR_MS)
  check(e.state().cover === 0.7, 'a fixed weather overrides the channel')
  e.weather = null
  check(e.state().cover !== 0.7, 'and setting it back to null returns the channel')
}

// --- cover 0 is the palette -------------------------------------------------
console.log('\n--- weather: clear is today\'s palette --------------------------')
{
  const c = new WorldClock({ hour: 0, weather: 0 })
  let worst = 0, keys = 0
  for (let h = 0; h < 24; h += 0.25) {
    c.elapsed = h
    c._recompute()
    const st = c.state()
    const p = paletteAt(c.sun.elevDeg)
    for (const k of Object.keys(p)) {
      if (k === 'hemiSky' || k === 'hemiIntensity' || k === 'skyGlowAmt') continue // the aurora tints these
      // The sun's two fields reach the state as the shared light, by day only.
      if ((k === 'sunLight' || k === 'sunIntensity') && st.isNight) continue
      const a = k === 'sunLight' ? st.lightColor : k === 'sunIntensity' ? st.lightIntensity : st[k]
      const b = p[k]
      keys++
      const d = Array.isArray(a) ? Math.max(...a.map((v, i) => Math.abs(v - b[i]))) : Math.abs(a - b)
      worst = Math.max(worst, d)
    }
  }
  check(worst === 0, 'at cover 0 every palette field reaches the state untouched', `${keys} fields over 96 hours, worst diff ${worst}`)
  check(c.state().precip === 0, 'and precip is 0')

  const o = new WorldClock({ hour: 12, weather: 1 })
  const s = o.state()
  const p = paletteAt(o.sun.elevDeg)
  check(s.lightIntensity < p.sunIntensity * 0.2, 'full cover at noon takes the sun to under a fifth', `${s.lightIntensity.toFixed(3)} of ${p.sunIntensity.toFixed(3)}`)
  check(s.stars === 0 && s.auroraMax === 0 && s.moonBright === 0, 'and puts out the stars, the moon and the aurora')
  check(s.precip === 1 && s.hazeDensity > p.hazeDensity * 3.5, 'and is raining, with a third of the clear visibility', `1/e at ${(1 / s.hazeDensity).toFixed(0)} m vs ${(1 / p.hazeDensity).toFixed(0)} m`)
  const n = new WorldClock({ hour: 1, weather: 1 })
  check(n.state().hazeDensity < 0.001, 'rain at night still sees past a kilometre', `1/e at ${(1 / n.state().hazeDensity).toFixed(0)} m`)
  const lum = (c) => c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
  const sat = (c) => Math.max(...c) - Math.min(...c)
  check(sat(s.horizon) < sat(p.horizon) && sat(s.zenith) < sat(p.zenith), 'the dome flattens toward grey')
  check(lum(s.horizon) > 0.3 && lum(new WorldClock({ hour: 22, weather: 1 }).state().horizon) < 0.1, 'and the grey is bright at noon and dim at night', `${lum(s.horizon).toFixed(2)} vs ${lum(new WorldClock({ hour: 22, weather: 1 }).state().horizon).toFixed(3)}`)
}

// --- continuity -------------------------------------------------------------
console.log('\n--- weather: continuity ----------------------------------------')
{
  // Live weather over two days at 60 fps, the bar check-daynight holds the
  // palette to (0.03 per frame on the light) applied to every field weather
  // touches.
  const c = new WorldClock({ hour: 0, anchorMs: ANCHOR })
  const FIELDS = ['lightIntensity', 'hazeDensity', 'cover', 'precip', 'stars', 'auroraMax', 'hemiIntensity']
  const COLOURS = ['horizon', 'zenith', 'fog', 'haze', 'hemiSky', 'lightColor']
  const worst = {}
  let prev = null
  for (let i = 0; i < 48 * 60 * 60; i++) {
    c.tick(ANCHOR + i * (1000 / 60))
    const st = c.state()
    // The sun-to-moon handover swaps lightColor on one frame by design (§8).
    if (prev && prev.isNight === st.isNight) {
      for (const k of FIELDS) worst[k] = Math.max(worst[k] ?? 0, Math.abs(st[k] - prev[k]) / Math.max(1e-6, Math.abs(prev[k]), 0.05))
      for (const k of COLOURS) worst[k] = Math.max(worst[k] ?? 0, Math.max(...st[k].map((v, j) => Math.abs(v - prev[k][j]))))
    }
    prev = st
  }
  const bad = Object.entries(worst).filter(([, v]) => v > 0.03)
  check(bad.length === 0, 'no field steps more than 3% in one frame across two live days', bad.map(([k, v]) => `${k} ${v.toFixed(4)}`).join(' ') || `worst ${Math.max(...Object.values(worst)).toFixed(5)}`)
}

// --- the episode histogram --------------------------------------------------
console.log('\n--- weather: the fortnight -------------------------------------')
{
  const STEP_MS = 60000 / 60 // one in-world minute
  const HOURS = 24 * 14
  const spells = []
  let rainMin = 0, clearMin = 0, total = 0, roomsWithClearDay = 0
  const ROOMS = 10
  for (let r = 0; r < ROOMS; r++) {
    const c = new WorldClock({ hour: 6, anchorMs: ANCHOR + r * 3600 * 1000 * 37 })
    let cur = 0, clearRun = 0, hadClearDay = false
    for (let i = 0; i < HOURS * 60; i++) {
      c.tick(c.anchorMs + i * STEP_MS)
      const st = c.state()
      total++
      if (st.precip > 0.5) { cur++; rainMin++ } else { if (cur > 0) spells.push(cur / 60); cur = 0 }
      if (st.cover < 0.35) clearMin++
      // A fair day: a whole day that never reaches overcast.
      if (st.cover < 0.55) { clearRun++; if (clearRun >= 24 * 60) hadClearDay = true } else clearRun = 0
    }
    if (cur > 0) spells.push(cur / 60)
    if (hadClearDay) roomsWithClearDay++
  }
  spells.sort((a, b) => a - b)
  const q = (p) => spells[Math.floor(p * (spells.length - 1))]
  const inBand = spells.filter((s) => s >= 1 && s <= 5).length / spells.length
  const bins = [0, 0.5, 1, 2, 3, 5, 8, 12, Infinity]
  const hist = bins.slice(0, -1).map((lo, i) => `${lo}-${bins[i + 1]}h:${spells.filter((s) => s >= lo && s < bins[i + 1]).length}`).join('  ')
  console.log(`       ${spells.length} rain spells over ${ROOMS} fortnights   ${hist}`)
  check(q(0.5) >= 1 && q(0.5) <= 5, 'the median rain spell is between one and five hours', `median ${q(0.5).toFixed(1)} h, p10 ${q(0.1).toFixed(1)}, p90 ${q(0.9).toFixed(1)}, longest ${q(1).toFixed(1)}`)
  check(inBand >= 0.6, 'and at least six spells in ten are', `${(inBand * 100).toFixed(0)}%`)
  check(q(1) < 24, 'no spell runs a whole day')
  const rainFrac = rainMin / total
  check(rainFrac > 0.08 && rainFrac < 0.25, 'it rains between one hour in twelve and one in four', `${(rainFrac * 100).toFixed(1)}%`)
  check(clearMin / total > 0.2, 'and the sky is mostly clear (cover < 0.35) at least a fifth of the time', `${(clearMin / total * 100).toFixed(0)}%`)
  check(roomsWithClearDay >= ROOMS * 0.7, 'most fortnights hold a whole fair day (cover under 0.55 throughout)', `${roomsWithClearDay} of ${ROOMS}`)
  check(WEATHER.presets.rain === 1 && WEATHER.presets.clear === 0, 'the debug presets span the channel')
}

// --- the horizon in the haze -------------------------------------------------
console.log('\n--- weather: the sky ends in the land\'s haze ---------------------')
{
  const lin = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace)
  const near = (s) => Math.max(...['r', 'g', 'b'].map((k) => Math.abs(s[k])))
  const u = makeSkyUniforms()
  const clear = new WorldClock({ hour: 12, weather: 0 }).state()
  writeSkyUniforms(u, clear)
  check(u.uSkyHaze.value.x === clear.hazeDensity && u.uSkyHaze.value.y === SKY_HAZE_M, 'the dome gets the clock\'s haze density and the fixed horizon path', `${SKY_HAZE_M} m`)
  check(near(u.uSkyAirNear.value.clone().sub(lin(clear.fog))) < 1e-6, 'its near haze is the land\'s fog')
  const ceil = airCeiling(0, new THREE.Color())
  check(near(u.uSkyAirFar.value.clone().sub(lin(clear.fog).multiply(ceil))) < 1e-6 && ceil.r < 0.9, 'and on a clear day its far haze is that under the far ceiling', `ceiling ${ceil.r.toFixed(2)}`)
  const tau = (deg, d) => { const L = SKY_HAZE_M / Math.sin(deg * Math.PI / 180); return 1 - Math.exp(-((L * d) ** 2)) }
  check(tau(3, clear.hazeDensity) > 0.25 && tau(20, clear.hazeDensity) < 0.05, 'clear: a haze band at the horizon, none at 20 degrees', `3deg ${(tau(3, clear.hazeDensity) * 100).toFixed(0)}%  20deg ${(tau(20, clear.hazeDensity) * 100).toFixed(1)}%`)

  const rain = new WorldClock({ hour: 12, weather: 1 }).state()
  writeSkyUniforms(u, rain)
  check(near(u.uSkyAirFar.value.clone().sub(u.uSkyAirNear.value)) < 1e-6, 'under full cover the ceiling lifts, so far haze is near haze')
  check(rain.haze.every((v, i) => v === rain.fog[i]), 'and the land\'s near haze is its fog, so near land, far land and low sky are one grey')
  check(tau(6, rain.hazeDensity) > 0.7 && tau(45, rain.hazeDensity) < 0.05, 'rain: the horizon is gone to six degrees and the clouds still read overhead', `6deg ${(tau(6, rain.hazeDensity) * 100).toFixed(0)}%  45deg ${(tau(45, rain.hazeDensity) * 100).toFixed(1)}%`)
  check(rain.hazeDensity > clear.hazeDensity * 3, 'a clear day sees three times further than a wet one', `1/e at ${(1 / clear.hazeDensity).toFixed(0)} m vs ${(1 / rain.hazeDensity).toFixed(0)} m`)
}

console.log(failures === 0 ? '\nweather: all checks passed' : `\nweather: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
