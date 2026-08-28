// ---------------------------------------------------------------------------
// A fixed biped skeleton, identical bone names/hierarchy for every
// character, placed from the same `landmarks` loft-mesh.mjs used to build
// the mesh (so skeleton and geometry never disagree about proportions), plus
// linear-falloff skin weights per `parts` (also from loft-mesh.mjs).
//
// Sharing one hierarchy across all 25 characters is what lets a single
// animations.mjs clip apply to every one of them unmodified.
//
// Arm bones are the one place bind pose isn't translation-only: the
// character stands in a T-pose (arms horizontal), but animations.mjs's
// walk/run swing is written as a sagittal rotX (rotate about the bone's
// local X axis) -- the convention that swings a *vertical* rest bone
// forward/back. A horizontal rest bone rotated about its own long axis (X)
// wouldn't move at all (its translation is parallel to the rotation axis),
// so `UpperArmR`/`UpperArmL` get a constant rest quaternion,
// `rotZ(-side*pi/2)`, that redirects "rotate about local X" to an effective
// world-Y-axis rotation -- sweeping the horizontally-extended arm forward/
// back through the X-Z plane, the best a T-pose rest arm can do for a
// swing. Only UpperArm carries this: LowerArm/Hand stay at identity local
// rotation and simply *inherit* UpperArm's world rotation through the
// hierarchy (giving them the same non-identity quat too would compound it
// down the chain instead of holding it constant).
//
// Because UpperArm's rest rotation is non-identity, its children's
// translations can no longer be plain world-space diffs: glTF composes a
// child's translation in its parent's *rotated* local frame
// (childWorldPos = parentWorldPos + parentWorldRot * childTranslation), so
// LowerArm's/Hand's translation-from-parent has to be pre-rotated by the
// inverse of the parent's accumulated world rotation for their world
// position to land where landmarks.armX/armY actually measured it.
// ---------------------------------------------------------------------------

import { rotZ, quatMultiply } from './animations.mjs'

const IDENTITY_QUAT = [0, 0, 0, 1]

function conjugate([x, y, z, w]) { return [-x, -y, -z, w] }

// Rotates vector v by unit quaternion q (v' = q*v*q^-1), the standard
// efficient two-cross-product form.
function rotateVec([qx, qy, qz, qw], [vx, vy, vz]) {
  const tx = 2 * (qy * vz - qz * vy)
  const ty = 2 * (qz * vx - qx * vz)
  const tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

// [name, parent, x-sign (0 = centreline), landmark]. `landmark` is either a
// loft-mesh.mjs height-fraction name (torso/legs) or `armT:<t>` -- an arm
// length-fraction (0 = shoulder attach, 0.5 = elbow, 1 = fingertip), read via
// landmarks.armX/armY instead of a height fraction, since a T-pose arm's
// bone chain runs along X, not Y.
const BONE_DEFS = [
  ['Hips', null, 0, 'hip'],
  ['Spine', 'Hips', 0, 'spine'],
  ['Chest', 'Spine', 0, 'chest'],
  ['Neck', 'Chest', 0, 'neck'],
  ['Head', 'Neck', 0, 'headTop'],

  ['ShoulderR', 'Chest', 1, 'armT:0'],
  ['UpperArmR', 'ShoulderR', 1, 'armT:0'],
  ['LowerArmR', 'UpperArmR', 1, 'armT:0.5'],
  ['HandR', 'LowerArmR', 1, 'armT:1'],
  ['ShoulderL', 'Chest', -1, 'armT:0'],
  ['UpperArmL', 'ShoulderL', -1, 'armT:0'],
  ['LowerArmL', 'UpperArmL', -1, 'armT:0.5'],
  ['HandL', 'LowerArmL', -1, 'armT:1'],

  ['UpperLegR', 'Hips', 1, 'hip'],
  ['LowerLegR', 'UpperLegR', 1, 'knee'],
  ['FootR', 'LowerLegR', 1, 'ankle'],
  ['UpperLegL', 'Hips', -1, 'hip'],
  ['LowerLegL', 'UpperLegL', -1, 'knee'],
  ['FootL', 'LowerLegL', -1, 'ankle'],
]

const LEG_BONE_PREFIXES = ['UpperLeg', 'LowerLeg', 'Foot']

/**
 * Builds the skeleton for one character from loft-mesh's `landmarks`.
 * Returns { bones: [{name, parent: index|-1}], translations: number[],
 * rotations: number[] } (translations/rotations are LOCAL to the parent, per
 * gltf-writer.mjs's bind-pose convention; rotations is a flat quat-per-bone
 * array, identity for every bone except the six arm bones), plus a
 * `worldY`/`worldX` lookup used by `skinVertices`.
 */
export function buildSkeleton(landmarks) {
  const { heightM, armX, armY, legPlacement } = landmarks

  const worldX = { Hips: 0, Spine: 0, Chest: 0, Neck: 0, Head: 0 }
  const worldY = {}
  for (const [name, , sign, lm] of BONE_DEFS) {
    if (lm.startsWith('armT:')) {
      const t = parseFloat(lm.slice(5))
      worldX[name] = armX(t, sign)
      worldY[name] = armY(t)
    } else if (LEG_BONE_PREFIXES.some((pfx) => name.startsWith(pfx))) {
      worldX[name] = legPlacement(landmarks[lm])[sign === 1 ? 'R' : 'L'].x
      worldY[name] = landmarks[lm] * heightM
    } else {
      worldX[name] = 0
      worldY[name] = landmarks[lm] * heightM
    }
  }

  const nameIndex = new Map(BONE_DEFS.map(([name], i) => [name, i]))
  const bones = BONE_DEFS.map(([name, parent]) => ({ name, parent: parent ? nameIndex.get(parent) : -1 }))

  // Local (parent-relative) rest rotation per bone -- identity for
  // everything except UpperArmR/UpperArmL (see header comment). BONE_DEFS
  // lists parents before children, so a single forward pass can accumulate
  // each bone's WORLD rotation (needed below to re-express translations in
  // a rotated parent's local frame) as it goes.
  const localRot = bones.map((b) => (b.name.startsWith('UpperArm') ? rotZ(-(b.name.endsWith('R') ? 1 : -1) * Math.PI / 2) : IDENTITY_QUAT))
  const worldRot = []
  bones.forEach((bone, i) => { worldRot[i] = quatMultiply(bone.parent >= 0 ? worldRot[bone.parent] : IDENTITY_QUAT, localRot[i]) })

  const translations = new Float32Array(bones.length * 3)
  bones.forEach((bone, i) => {
    const wx = worldX[bone.name], wy = worldY[bone.name]
    const pwx = bone.parent >= 0 ? worldX[bones[bone.parent].name] : 0
    const pwy = bone.parent >= 0 ? worldY[bones[bone.parent].name] : 0
    const worldDiff = [wx - pwx, wy - pwy, 0]
    // glTF composes a child's translation in its parent's rotated local
    // frame, not world axes -- a no-op (worldDiff unchanged) whenever the
    // parent's world rotation is identity, which is every bone but
    // LowerArm/Hand.
    const parentRot = bone.parent >= 0 ? worldRot[bone.parent] : IDENTITY_QUAT
    const local = rotateVec(conjugate(parentRot), worldDiff)
    translations[i * 3] = local[0]; translations[i * 3 + 1] = local[1]; translations[i * 3 + 2] = local[2]
  })

  const rotations = new Float32Array(bones.length * 4)
  localRot.forEach((q, i) => {
    rotations[i * 4] = q[0]; rotations[i * 4 + 1] = q[1]; rotations[i * 4 + 2] = q[2]; rotations[i * 4 + 3] = q[3]
  })

  return { bones, translations, rotations, worldX, worldY }
}

/**
 * Per-vertex skin indices/weights for `mesh.parts` against `skeleton`.
 * Each part's chain is walked in order; a vertex weights against the two
 * chain bones whose world Y bracket its own Y, linearly by height -- e.g. a
 * torso vertex halfway between Chest and Neck gets ~0.5/0.5. Leaf bones
 * (Head, Hand*, Foot*) take any vertex past their end of the chain fully.
 *
 * Returns { skinIndices, skinWeights } as flat Uint8/Float32 arrays, length
 * vcount*4, ready for gltf-writer.mjs.
 */
export function skinVertices(mesh, skeleton) {
  const vcount = mesh.pos.length / 3
  const skinIndices = new Uint8Array(vcount * 4)
  const skinWeights = new Float32Array(vcount * 4)
  const boneIndex = new Map(skeleton.bones.map((b, i) => [b.name, i]))

  for (const part of mesh.parts) {
    // Every chain but arms runs along Y (torso: low to high; legs: high to
    // low, root-to-leaf points down) -- bracket by world Y, same as always.
    // Arm chains run along X instead (a T-pose arm's long axis), attach to
    // fingertip -- bracket by world X. Bracket search has to work either
    // direction regardless of axis (an L-side chain's X decreases outward).
    const isArm = part.name.startsWith('arm')
    const chainCoord = part.chain.map((n) => (isArm ? skeleton.worldX[n] : skeleton.worldY[n]))
    for (let i = 0; i < part.vCount; i++) {
      const vi = part.vStart + i
      const coord = isArm ? mesh.pos[vi * 3] : mesh.pos[vi * 3 + 1]
      let lo = 0
      for (let k = 0; k < chainCoord.length - 1; k++) {
        lo = k
        if (coord >= Math.min(chainCoord[k], chainCoord[k + 1]) && coord <= Math.max(chainCoord[k], chainCoord[k + 1])) break
      }
      const hi = lo + 1
      const span = chainCoord[hi] - chainCoord[lo]
      const t = span !== 0 ? Math.min(1, Math.max(0, (coord - chainCoord[lo]) / span)) : 0
      const iA = boneIndex.get(part.chain[lo]), iB = boneIndex.get(part.chain[hi])
      skinIndices[vi * 4] = iA; skinWeights[vi * 4] = 1 - t
      skinIndices[vi * 4 + 1] = iB; skinWeights[vi * 4 + 1] = t
    }
  }
  return { skinIndices: Array.from(skinIndices), skinWeights: Array.from(skinWeights) }
}
