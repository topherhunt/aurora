// The bone vocabulary our rigs speak: Mixamo's, for biped and quadruped alike.
//
// It is not invented here. Mixamo's humanoid naming is the closest thing to a
// lingua franca in this corner of the world -- Mixamo's own library, most of
// Sketchfab, every "humanoid" retargeter -- so a rig relabelled into it can play
// a Mixamo clip by name with no mapping table in between. That is the whole
// reason to adopt someone else's naming rather than our own.
//
// Three rules generate almost every name: the side is a PREFIX WORD
// (`LeftArm`, never `Arm.L`); the first link of a chain carries NO NUMBER
// (`Spine`, then `Spine1`); and the joints have anatomical rather than
// positional names -- thigh is `UpLeg`, shin is `Leg`, upper arm is `Arm`,
// forearm is `ForeArm`.
//
// Two shapes worth knowing before mapping a rig onto it:
//
//   The spine is asymmetric at its two ends. Legs hang straight off `Hips`, but
//   the arms travel all the way up to `Spine2` by way of a `Shoulder`. Pelvis
//   versus ribcage, which is correct.
//
//   QUADRUPEDS USE THIS VOCABULARY UNCHANGED. The front legs are the arm chain
//   and the hind legs are the leg chain, which is anatomically honest rather
//   than a fudge: `Shoulder` is the scapula, `Hand` and `ToeBase` are the paws,
//   and on a digitigrade animal `Foot` is the hock held vertical. What a
//   quadruped adds is only what Mixamo has no word for -- `Tail`, `LeftEar`,
//   `Jaw`, and a second `Neck1` for a long neck -- and those follow the same
//   numbering rules.
//
// So one hierarchy covers both, and a rig fills the part of it that its animal
// has. `expectedParent` is what makes that work: a biped with no `Neck1` hangs
// `Head` straight off `Neck`, and that is a shorter chain rather than a gap.

/** name -> parent name, in hierarchy order. `null` marks the root bone. */
export const HIERARCHY = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',

  Neck: 'Spine2',
  Neck1: 'Neck', // only long necks: a biped hangs Head off Neck
  Head: 'Neck1',
  HeadTop_End: 'Head',
  Jaw: 'Head',
  LeftEye: 'Head', RightEye: 'Head',
  LeftEar: 'Head', LeftEar1: 'LeftEar',
  RightEar: 'Head', RightEar1: 'RightEar',

  LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
  RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',

  // Mixamo carries three joints per digit and drives them in most of its clips.
  // A rig without them drops those tracks, which is the right failure.
  LeftHandThumb1: 'LeftHand', LeftHandThumb2: 'LeftHandThumb1', LeftHandThumb3: 'LeftHandThumb2',
  LeftHandIndex1: 'LeftHand', LeftHandIndex2: 'LeftHandIndex1', LeftHandIndex3: 'LeftHandIndex2',
  LeftHandMiddle1: 'LeftHand', LeftHandMiddle2: 'LeftHandMiddle1', LeftHandMiddle3: 'LeftHandMiddle2',
  LeftHandRing1: 'LeftHand', LeftHandRing2: 'LeftHandRing1', LeftHandRing3: 'LeftHandRing2',
  LeftHandPinky1: 'LeftHand', LeftHandPinky2: 'LeftHandPinky1', LeftHandPinky3: 'LeftHandPinky2',
  RightHandThumb1: 'RightHand', RightHandThumb2: 'RightHandThumb1', RightHandThumb3: 'RightHandThumb2',
  RightHandIndex1: 'RightHand', RightHandIndex2: 'RightHandIndex1', RightHandIndex3: 'RightHandIndex2',
  RightHandMiddle1: 'RightHand', RightHandMiddle2: 'RightHandMiddle1', RightHandMiddle3: 'RightHandMiddle2',
  RightHandRing1: 'RightHand', RightHandRing2: 'RightHandRing1', RightHandRing3: 'RightHandRing2',
  RightHandPinky1: 'RightHand', RightHandPinky2: 'RightHandPinky1', RightHandPinky3: 'RightHandPinky2',

  LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot', LeftToe_End: 'LeftToeBase',
  RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot', RightToe_End: 'RightToeBase',

  Tail: 'Hips', Tail1: 'Tail', Tail2: 'Tail1', Tail3: 'Tail2',
  Tail4: 'Tail3', Tail5: 'Tail4', Tail6: 'Tail5', Tail7: 'Tail6',
}

export const BONES = Object.keys(HIERARCHY)

// What a walk has to have to read as a walk, for a biped and a quadruped both --
// which is why there is one set rather than two: everything a quadruped adds
// (tail, ears, jaw, second neck joint) and everything a biped adds (fingers,
// toes, the two _End tips) is welcome but not load-bearing. A rig with no
// `Neck1` drops that clip's neck track and looks slightly stiff; a rig with no
// `RightLeg` has a hind leg that does not bend.
//
// Feet are optional for a reason worth knowing: in a retargeted clip the paw is
// carried rigid by the leg, so a rig without `ToeBase` loses no motion. Tripo's
// rigs run 30-40 joints, so the toes, tail, ears and fingers are usually where
// they run out.
export const REQUIRED = new Set([
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
])

/**
 * The Quaternius animal pack's names, mapped onto ours, for the rig editor's
 * preview only.
 *
 * Mixamo is humanoid-only, so a quadruped relabelled into the vocabulary above
 * gains a convention and no clips. The pack (tmp/Quaternius Animated Animals,
 * CC0 1.0) is still the only quadruped motion on hand, and it is what the
 * preview plays, so its names have to be translated at playback rather than
 * baked into the rig.
 *
 * The two skeletons are anchored to each other at the two joints that carry
 * limbs: Quaternius hangs hind legs and tail off `Back` where we hang them off
 * `Hips`, and front legs off `Torso2` where we hang them off `Spine2`. Four
 * source joints have no counterpart and are dropped -- `Body` (an extra root
 * above the pelvis), `Torso3` (an extra chest bone), `Neck3`, and
 * `BackShoulder` (an extra hip). Their motion is lost, which is acceptable for
 * a preview that answers "are the labels right" rather than "is this the clip".
 */
export const QUATERNIUS_TO_MIXAMO = {
  Back: 'Hips', Torso: 'Spine', Torso2: 'Spine2',
  Neck1: 'Neck', Neck2: 'Neck1', Head: 'Head',
  'Ear1.L': 'LeftEar', 'Ear2.L': 'LeftEar1',
  'Ear1.R': 'RightEar', 'Ear2.R': 'RightEar1',
  'FrontShoulder.L': 'LeftShoulder', 'FrontUpperLeg.L': 'LeftArm', 'FrontLowerLeg.L': 'LeftForeArm', 'FF.L': 'LeftHand',
  'FrontShoulder.R': 'RightShoulder', 'FrontUpperLeg.R': 'RightArm', 'FrontLowerLeg.R': 'RightForeArm', 'FF.R': 'RightHand',
  'BackLeg.L': 'LeftUpLeg', 'BackUpperLeg.L': 'LeftLeg', 'BackLowerLeg.L': 'LeftFoot', 'FFB.L': 'LeftToeBase',
  'BackLeg.R': 'RightUpLeg', 'BackUpperLeg.R': 'RightLeg', 'BackLowerLeg.R': 'RightFoot', 'FFB.R': 'RightToeBase',
  Tail1: 'Tail', Tail2: 'Tail1', Tail3: 'Tail2', Tail4: 'Tail3',
  Tail5: 'Tail4', Tail6: 'Tail5', Tail7: 'Tail6', Tail8: 'Tail7',
}

/** The clips every animal in the Quaternius pack carries. Canids swap the two attacks for one `Attack`. */
export const CLIPS = [
  'Attack_Headbutt', 'Attack_Kick', 'Death', 'Eating', 'Gallop', 'Gallop_Jump',
  'Idle', 'Idle_2', 'Idle_Headlow', 'Idle_HitReact1', 'Idle_HitReact2', 'Jump_toIdle', 'Walk',
]

/** Is `bone` at or below `ancestor` in the canonical hierarchy? */
export function descends(bone, ancestor) {
  for (let b = bone; b; b = HIERARCHY[b]) if (b === ancestor) return true
  return false
}

/**
 * The parent `bone` should have in a rig that fills only `assigned` of the
 * canonical names -- its closest canonical ancestor that is actually present,
 * or null for the root. A biped with no `Neck1` hangs `Head` straight off
 * `Neck`, and that is correct rather than a gap: skipping a bone shortens the
 * chain, it does not break it.
 */
export function expectedParent(bone, assigned) {
  for (let b = HIERARCHY[bone]; b; b = HIERARCHY[b]) if (assigned.has(b)) return b
  return null
}
