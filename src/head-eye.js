import THREE from './three-instance.js'

// ---------------------------------------------------------------------------
// HEAD-CENTRED BILLBOARDS. A shader's `cameraPosition` is the EYE being drawn, so in a headset a card turned toward it is turned toward the left eye in one draw and the right in the other: the two images disagree about the card's depth and it doubles. Every billboard turns toward `HEAD_EYE_GLSL` instead, the midpoint of the eyes, so both eyes see the same flat card.
//
// A host sets the head once a frame with `setHeadEye`. A host that never does (a tool page on a monitor) falls back to `cameraPosition`, which is exact there: one eye, so eye and head are the same point.
//
// A billboard shader declares HEAD_EYE_DECL in its vertex common, binds the uniforms with `bindHeadEye(shader.uniforms)`, and reads HEAD_EYE_GLSL where it read `cameraPosition` to ORIENT. Distance fades and lighting keep the per-eye `cameraPosition`: they do not rotate anything.
// ---------------------------------------------------------------------------

const uniforms = {
  uHeadEye: { value: new THREE.Vector3() },
  uHeadEyeOn: { value: 0 },
}

export const HEAD_EYE = uniforms

export const setHeadEye = (x, y, z) => {
  uniforms.uHeadEye.value.set(x, y, z)
  uniforms.uHeadEyeOn.value = 1
}

export const bindHeadEye = (target) => Object.assign(target, uniforms)

export const HEAD_EYE_DECL = 'uniform vec3 uHeadEye;\nuniform float uHeadEyeOn;'
export const HEAD_EYE_GLSL = '( uHeadEyeOn > 0.5 ? uHeadEye : cameraPosition )'
