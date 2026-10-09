// Node-side gates for the flames (src/v2/render/fire-tris.js).
//
//   node scripts/check-fire-tris.mjs
//
// What can go wrong without throwing: the sparks drawing other matrices or phases than the silhouettes (sparks float off empty air); a shader that orients toward the per-eye cameraPosition instead of the head (a flame doubles in a headset); a fragment shader that gained a discard or a texture fetch (the cost model of opaque triangles); a flame count that outruns the buffers; a phase hashed from the foot in the shader, which sends a moving torch racing through its flicker.

import { TriFlames, TRI_FIRE, TRI_WILDFIRE, TRI_TORCH, TRI_LAMP, TRI_CANDLE, FLAME_TRIS } from '../src/v2/render/fire-tris.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}
const throws = (fn) => { try { fn() } catch { return true } return false }

console.log('the meshes')
{
  const f = new TriFlames(4)
  check(f.sparks.instanceMatrix === f.mesh.instanceMatrix, 'the sparks share the silhouettes\' matrices')
  check(f.sparks.geometry.getAttribute('aFlame') === f.mesh.geometry.getAttribute('aFlame'), 'the sparks share the silhouettes\' phase and group')
  check(f.mesh.geometry.index.count / 3 + f.sparks.geometry.index.count / 3 === FLAME_TRIS, 'FLAME_TRIS is what one flame draws', String(FLAME_TRIS))
  for (const m of [f.mesh.material, f.sparks.material]) {
    check(!/discard/.test(m.fragmentShader) && !/texture2D|texture\(/.test(m.fragmentShader), 'the fragment shader neither discards nor samples')
    check(m.transparent === false && m.blending === 1, 'the material is opaque and unblended')
    check(/uHeadEye/.test(m.vertexShader) && 'uHeadEye' in m.uniforms, 'the flame turns toward the head, not the eye being drawn')
    check(/uTilt/.test(m.vertexShader), 'the flame pitches toward an eye above')
    check(/float ph = aFlame\.x;/.test(m.vertexShader), 'the flicker phase is the instance\'s alone, so a carried torch does not race through it as it moves')
  }
  check(throws(() => f.set({ ...TRI_FIRE, tilt: NaN })), 'a non-finite knob throws')
}

console.log('the looks')
{
  check(TRI_FIRE.tilt === 0.5 && [TRI_WILDFIRE, TRI_TORCH, TRI_LAMP, TRI_CANDLE].every((p) => p.tilt === TRI_FIRE.tilt), 'every flame pitches half the eye\'s elevation')
  check(TRI_FIRE.sparkSize === 1 && TRI_WILDFIRE.sparkSize === 1 && [TRI_TORCH, TRI_LAMP, TRI_CANDLE].every((p) => p.sparkSize === 2), 'the torch, lamp and candle throw sparks twice the campfire\'s')
  const f = new TriFlames(1, TRI_CANDLE)
  check(f.shared.uSparkSize.value === 2 && f.shared.uTilt.value === 0.5, 'a preset reaches the uniforms')
}

console.log('the placement')
{
  const f = new TriFlames(4)
  f.place(2, 1, 2, 3, { height: 0.3, radius: 0.1, phase: 1.5, group: 2 })
  const im = f.mesh.instanceMatrix.array.slice(32, 48)
  check(im[12] === 1 && im[13] === 2 && im[14] === 3 && Math.abs(im[0] - 0.1) < 1e-7 && Math.abs(im[5] - 0.3) < 1e-7, 'place writes the foot and the radius and height scale', `${im[12]}, ${im[13]}, ${im[14]}`)
  const a = f.mesh.geometry.getAttribute('aFlame')
  check(a.getX(2) === 1.5 && a.getY(2) === 2, 'place writes the phase and group')
  f.place(2, 5, 2, 9, { height: 0.3, radius: 0.1, phase: 1.5, group: 2 })
  f.place(1, 1, 2, 3, { height: 0.3, radius: 0.1 }); f.place(0, 4, 2, 3, { height: 0.3, radius: 0.1 })
  check(a.getX(2) === 1.5 && a.getX(1) !== a.getX(0), 'a flame moved keeps its phase; unphased flames apart differ', `${a.getX(1).toFixed(2)} vs ${a.getX(0).toFixed(2)}`)
  f.update(1, [1, 1, 1])
  check(f.count === 3 && f.mesh.count === 3 && f.sparks.count === 3, 'the flames draw up to the highest placed', String(f.mesh.count))
  check(f.triangles() === 3 * FLAME_TRIS, 'triangles() is count x FLAME_TRIS', String(f.triangles()))
  check(throws(() => f.place(4, 0, 0, 0, { height: 1, radius: 1 })), 'placing past the capacity throws')
  TriFlames.shown = false
  f.update(1, [1, 1, 1])
  check(f.mesh.count === 0 && f.sparks.count === 0 && f.triangles() === 0, 'the fire row off draws no flame and no spark')
  TriFlames.shown = true
  f.update(1, [1, 1, 1])
  check(f.mesh.count === 3, 'back on, the flames draw again')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
