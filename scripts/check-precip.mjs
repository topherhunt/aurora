// Node-side gate for the precipitation (§10, src/v2/render/precip.js): the
// draw's shape and slot, and the per-frame numbers main.js hands it -- when it
// draws at all, how hard by altitude, rain or snow by the snow line, that the
// fall offset stays inside the box however long it rains, and that a teleport
// is not a gust.
//
//   node scripts/check-precip.mjs

import * as THREE from 'three'
import { Precip, BOX_M, COUNT, SLEET_BAND_M, ELEVATION_GAIN, ELEVATION_TOP_M } from '../src/v2/render/precip.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const state = (precip, wind = [1, 0]) => ({ precip, wind, fog: [0.6, 0.65, 0.7] })

console.log('\n--- precip: the draw -----------------------------------------')
const scene = new THREE.Scene()
const p = new Precip(scene)
{
  const geo = p.mesh.geometry
  check(scene.children.length === 1 && scene.children[0] === p.mesh, 'one mesh, one draw')
  check(geo.index.count === COUNT * 6 && geo.attributes.aSeed.count === COUNT * 4 && !geo.attributes.position, `${COUNT} quads, placed by the vertex stage with no position attribute`)
  const m = p.material
  check(m.transparent && !m.depthWrite && m.depthTest && !m.fog, 'blended, depth-tested, never depth-written, unfogged')
  check(p.mesh.renderOrder > 950 && p.mesh.frustumCulled === false, 'drawn after the dome and never frustum-culled', `renderOrder ${p.mesh.renderOrder}`)
  check(m.fragmentShader.includes('#include <colorspace_fragment>'), 'the fragment ends on the colour-space conversion, so a set colour is the colour seen')
  check(!p.mesh.visible, 'nothing drawn before the first update')
}

console.log('\n--- precip: the numbers --------------------------------------')
{
  const head = new THREE.Vector3(0, 0, 0)
  p.update(1 / 60, head, state(0), 500)
  check(!p.mesh.visible && p.intensity === 0, 'dry weather is no draw')
  p.update(1 / 60, head, state(1), 500)
  const floor = p.intensity
  check(p.mesh.visible && Math.abs(floor - (1 - ELEVATION_GAIN)) < 1e-9, 'a downpour on the valley floor draws at the floor share', `${floor.toFixed(2)}`)
  head.y = ELEVATION_TOP_M + 50
  p.update(1 / 60, head, state(1), 2000)
  check(Math.abs(p.intensity - 1) < 1e-9, `and at ${ELEVATION_TOP_M} m and above at full`)
  head.y = ELEVATION_TOP_M / 2
  p.update(1 / 60, head, state(1), 2000)
  check(p.intensity > floor && p.intensity < 1, 'half way up, between the two', `${p.intensity.toFixed(2)}`)
  check(Math.abs(p.uniforms.uIntensity.value - p.intensity) < 1e-9, 'the shader gets the same number')
  p.enabled = false
  p.update(1 / 60, head, state(1), 2000)
  check(!p.mesh.visible, 'the row hides it whatever the weather')
  p.enabled = true
  p.update(1 / 60, head, state(1), 2000, true)
  check(!p.mesh.visible && p.intensity > 0, 'and under water nothing is drawn in the same downpour')
  p.update(1 / 60, head, state(1), 2000, false)
  check(p.mesh.visible, 'and it is back the frame she surfaces')

  head.y = 100
  p.update(1 / 60, head, state(1), 100 + SLEET_BAND_M + 1)
  check(p.snow === 0, 'well below the snow line it is all rain')
  p.update(1 / 60, head, state(1), 100 - SLEET_BAND_M - 1)
  check(p.snow === 1, 'well above it all snow')
  p.update(1 / 60, head, state(1), 100)
  check(Math.abs(p.snow - 0.5) < 1e-9, 'and sleet, half and half, on the line')

  const s = state(1, [0.6, 0.8])
  for (let i = 0; i < 60 * 60 * 3; i++) p.update(1 / 60, head, s, 2000)
  const inBox = (v) => v.x >= 0 && v.x < BOX_M && v.y >= 0 && v.y < BOX_M && v.z >= 0 && v.z < BOX_M
  check(inBox(p.uniforms.uFallRain.value) && inBox(p.uniforms.uFallSnow.value), 'three hours of rain leave both fall offsets inside the box', `rain y ${p.uniforms.uFallRain.value.y.toFixed(2)} snow y ${p.uniforms.uFallSnow.value.y.toFixed(2)}`)
  check(p.uniforms.uTime.value < 100, 'and the sway clock wrapped', `${p.uniforms.uTime.value.toFixed(1)} s`)
  const rainDrop = p.uniforms.uFallRain.value.clone(), snowDrop = p.uniforms.uFallSnow.value.clone()
  p.update(1, head, s, 2000)
  const fell = (a, b) => ((b.y - a.y) % BOX_M + BOX_M) % BOX_M
  const rainFell = fell(p.uniforms.uFallRain.value, rainDrop), snowFell = fell(p.uniforms.uFallSnow.value, snowDrop)
  check(rainFell > snowFell * 4, 'a drop falls further in a second than a flake', `${rainFell.toFixed(1)} m vs ${snowFell.toFixed(1)} m`)
  check(p.uniforms.uWind.value.x === 0.6 && p.uniforms.uWind.value.y === 0.8, 'the wind is the clock\'s')

  // Her motion: a walk sets the streak velocity, a teleport does not.
  const walker = new Precip(new THREE.Scene())
  const h = new THREE.Vector3(0, 1.6, 0)
  for (let i = 0; i < 120; i++) { h.z -= 4 / 60; walker.update(1 / 60, h, state(1), 500) }
  check(walker.uniforms.uCamVel.value.z < -3.5 && Math.abs(walker.uniforms.uCamVel.value.x) < 1e-6, 'two seconds of walking is a camera velocity along the walk', `${walker.uniforms.uCamVel.value.z.toFixed(2)} m/s`)
  h.x += 200
  walker.update(1 / 60, h, state(1), 500)
  check(walker.uniforms.uCamVel.value.length() === 0, 'a teleport zeroes it rather than smearing the view')
  walker.dispose()
}

p.dispose()
check(scene.children.length === 0, 'dispose takes it out of the scene')

console.log(failures === 0 ? '\nprecip: all checks passed' : `\nprecip: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
