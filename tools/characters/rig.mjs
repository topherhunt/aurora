// ---------------------------------------------------------------------------
// A fixed biped skeleton, identical bone names/hierarchy for every
// character, placed from the same `landmarks` loft-mesh.mjs used to build
// the mesh (so skeleton and geometry never disagree about proportions), plus
// linear-falloff skin weights per `parts` (also from loft-mesh.mjs).
//
// Sharing one hierarchy across all 25 characters is what lets a single
// animations.mjs clip apply to every one of them unmodified.
// ---------------------------------------------------------------------------

// [name, parent, x-sign (0 = centreline), landmark for its Y height]
const BONE_DEFS = [
  ['Hips', null, 0, 'hip'],
  ['Spine', 'Hips', 0, 'spine'],
  ['Chest', 'Spine', 0, 'chest'],
  ['Neck', 'Chest', 0, 'neck'],
  ['Head', 'Neck', 0, 'headTop'],

  ['ShoulderR', 'Chest', 1, 'shoulder'],
  ['UpperArmR', 'ShoulderR', 1, 'shoulder'],
  ['LowerArmR', 'UpperArmR', 1, 'elbow'],
  ['HandR', 'LowerArmR', 1, 'hip'],
  ['ShoulderL', 'Chest', -1, 'shoulder'],
  ['UpperArmL', 'ShoulderL', -1, 'shoulder'],
  ['LowerArmL', 'UpperArmL', -1, 'elbow'],
  ['HandL', 'LowerArmL', -1, 'hip'],

  ['UpperLegR', 'Hips', 1, 'hip'],
  ['LowerLegR', 'UpperLegR', 1, 'knee'],
  ['FootR', 'LowerLegR', 1, 'ankle'],
  ['UpperLegL', 'Hips', -1, 'hip'],
  ['LowerLegL', 'UpperLegL', -1, 'knee'],
  ['FootL', 'LowerLegL', -1, 'ankle'],
]

/**
 * Builds the skeleton for one character from loft-mesh's `landmarks`.
 * Returns { bones: [{name, parent: index|-1}], translations: number[] }
 * (translations are LOCAL to the parent, per gltf-writer.mjs's bind-pose
 * convention), plus a `worldY`/`worldX` lookup used by `skinVertices`.
 */
export function buildSkeleton(landmarks) {
  const { heightM, hipHalfW, shoulderHalfW } = landmarks
  // Elbow sits partway down the upper arm; landmarks has no dedicated
  // fraction for it, so it's derived here rather than added to loft-mesh's
  // landmark set, which exists to keep MESH proportions in one place -- this
  // is a skeleton-only subdivision of the arm's already-agreed span.
  const elbowFrac = (landmarks.shoulder + landmarks.hip) / 2
  const frac = { ...landmarks, elbow: elbowFrac }

  const worldX = { Hips: 0, Spine: 0, Chest: 0, Neck: 0, Head: 0 }
  const worldY = {}
  for (const [name, , , lm] of BONE_DEFS) worldY[name] = frac[lm] * heightM
  for (const [name, , sign] of BONE_DEFS) {
    if (name.startsWith('Shoulder') || name.startsWith('UpperArm') || name.startsWith('LowerArm') || name.startsWith('Hand')) {
      worldX[name] = sign * shoulderHalfW * 0.9
    } else if (name.startsWith('UpperLeg') || name.startsWith('LowerLeg') || name.startsWith('Foot')) {
      worldX[name] = sign * hipHalfW * 0.55
    } else {
      worldX[name] = 0
    }
  }

  const nameIndex = new Map(BONE_DEFS.map(([name], i) => [name, i]))
  const bones = BONE_DEFS.map(([name, parent]) => ({ name, parent: parent ? nameIndex.get(parent) : -1 }))
  const translations = new Float32Array(bones.length * 3)
  bones.forEach((bone, i) => {
    const wx = worldX[bone.name], wy = worldY[bone.name]
    const pwx = bone.parent >= 0 ? worldX[bones[bone.parent].name] : 0
    const pwy = bone.parent >= 0 ? worldY[bones[bone.parent].name] : 0
    translations[i * 3] = wx - pwx
    translations[i * 3 + 1] = wy - pwy
    translations[i * 3 + 2] = 0
  })

  return { bones, translations, worldX, worldY }
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
    // The torso chain runs low Y to high Y (Hips -> Head); arm/leg chains run
    // high Y to low Y (Shoulder -> Hand, UpperLeg -> Foot) since root-to-leaf
    // in a limb points down. Bracket search has to work either direction.
    const chainY = part.chain.map((n) => skeleton.worldY[n])
    for (let i = 0; i < part.vCount; i++) {
      const vi = part.vStart + i
      const y = mesh.pos[vi * 3 + 1]
      let lo = 0
      for (let k = 0; k < chainY.length - 1; k++) {
        lo = k
        if (y >= Math.min(chainY[k], chainY[k + 1]) && y <= Math.max(chainY[k], chainY[k + 1])) break
      }
      const hi = lo + 1
      const span = chainY[hi] - chainY[lo]
      const t = span !== 0 ? Math.min(1, Math.max(0, (y - chainY[lo]) / span)) : 0
      const iA = boneIndex.get(part.chain[lo]), iB = boneIndex.get(part.chain[hi])
      skinIndices[vi * 4] = iA; skinWeights[vi * 4] = 1 - t
      skinIndices[vi * 4 + 1] = iB; skinWeights[vi * 4 + 1] = t
    }
  }
  return { skinIndices: Array.from(skinIndices), skinWeights: Array.from(skinWeights) }
}
