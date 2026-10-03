// Node-side gates for the head-centred billboards (src/head-eye.js) and the flame shader's cheap-fill lines (src/v2/render/fire.js).
//
//   node scripts/check-flames.mjs
//
// What can go wrong without throwing: a billboard that went back to the per-eye `cameraPosition` (double vision in a headset, invisible on a monitor); a host that never sets the head and gets a card turned toward the origin; a flame shader that lost its discard or its highp noise clock (a flame that steps after an hour of play, only on a phone GPU).

import { Flames } from '../src/v2/render/fire.js'
import { billboardVertex, createCritterCardMaterial } from '../src/v2/render/critters.js'
import { HEAD_EYE, setHeadEye, bindHeadEye, HEAD_EYE_GLSL } from '../src/head-eye.js'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`)
}

console.log('the head')
{
  const u = bindHeadEye({})
  check(u.uHeadEyeOn.value === 0, 'a host that never sets the head leaves the per-eye camera in force')
  setHeadEye(1, 2, 3)
  check(u.uHeadEyeOn.value === 1 && u.uHeadEye.value.toArray().join() === '1,2,3', 'setHeadEye turns it on at the point')
  check(bindHeadEye({}).uHeadEye === u.uHeadEye, 'every shader shares the one uniform')
  check(HEAD_EYE_GLSL.includes('cameraPosition'), 'the shader falls back to the camera when the head is off')
}

console.log('the billboards')
{
  for (const mixed of [false, true]) {
    const glsl = billboardVertex(mixed)
    check(glsl.includes('uHeadEyeOn') && !/cameraPosition\.xz/.test(glsl), `a critter card turns toward the head${mixed ? ' (mixed)' : ''}`)
  }
  const material = createCritterCardMaterial('check-head', { billboard: true })
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <normal_fragment_begin>' }
  material.onBeforeCompile(shader)
  check(shader.uniforms.uHeadEye === HEAD_EYE.uHeadEye && /uniform vec3 uHeadEye;/.test(shader.vertexShader), 'a spun critter card declares and binds the head')
  const flat = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <normal_fragment_begin>' }
  createCritterCardMaterial('check-head-flat', { billboard: false }).onBeforeCompile(flat)
  check(!('uHeadEye' in flat.uniforms), 'a card that does not turn carries no head uniform')
}

console.log('the flame shader')
{
  const m = new Flames(1).material
  check(m.vertexShader.includes('uHeadEyeOn > 0.5 ? uHeadEye : cameraPosition') && !/vec3 to = cameraPosition/.test(m.vertexShader), 'the flame turns toward the head, not the eye being drawn')
  check(m.uniforms.uHeadEye === HEAD_EYE.uHeadEye && m.uniforms.uHeadEyeOn, 'the flame binds the shared head')
  check(/if \( v <= 0\.0 \) discard;/.test(m.fragmentShader), 'an emptied fragment is discarded, not blended as black')
  check(/precision mediump float;/.test(m.fragmentShader) && /uniform highp float uTime;/.test(m.fragmentShader) && /highp float t = uTime \* uSpeed;/.test(m.fragmentShader) && /highp vec2 c1/.test(m.fragmentShader) && /highp vec2 c2/.test(m.fragmentShader), 'the mask is mediump; the clock and the fetch coordinates are highp')
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1) }
console.log('\nall ok')
