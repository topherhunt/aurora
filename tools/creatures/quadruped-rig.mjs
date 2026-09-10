// The bone vocabulary our quadruped rigs speak.
//
// It is not invented here: it is the skeleton the Quaternius CC0 animal pack
// ships (tmp/Quaternius Animated Animals, CC0 1.0). Thirty-eight bones are
// common to all twelve animals by identical name, varying only in ear count and
// tail length, so a rig relabelled into this vocabulary can play any of the
// pack's twelve or thirteen clips by name, for every creature we ever generate.
// That is the whole reason to adopt someone else's naming rather than our own.
//
// Twelve of those thirty-eight are Blender rig controls rather than anatomy --
// IKFrontLeg, IKBackLeg and the four PoleTargets -- and are deliberately absent
// here: nothing a generated rig has corresponds to them, and the pole targets
// carry no skin weight at all.
//
// Three shapes worth knowing before mapping a rig onto it:
//
//   Legs are asymmetric. The front leg is Shoulder -> UpperLeg -> LowerLeg, the
//   hind leg is Shoulder -> Leg -> UpperLeg -> LowerLeg -- one extra hip bone
//   behind.
//
//   Each leg does end in a foot -- FF.L/FF.R in front, FFB.L/FFB.R behind, real
//   deform bones carrying as much skin weight as a lower leg. The pack hangs
//   them off its IK targets rather than off the leg, so walking down from Body
//   never reaches them; we parent them to LowerLeg, where a paw anatomically
//   belongs. Their own tracks are constant in every clip -- the motion lives in
//   the IK bones and is mostly translation -- so a foot mapped here is a rigid
//   paw carried by the leg, which is what it is in the pack too once the IK is
//   baked.
//
//   The spine runs Body -> Back -> Torso -> Torso2 -> Torso3, front-ward. Hind
//   legs and the tail hang off Back (the rear); front legs off Torso2 (the
//   chest). Body is the root, and the whole animal hangs beneath it.

/** name -> parent name, in hierarchy order. `null` marks the root bone. */
export const HIERARCHY = {
  Body: null,
  Back: 'Body',
  Torso: 'Back',
  Torso2: 'Torso',
  Torso3: 'Torso2',
  Neck1: 'Torso3',
  Neck2: 'Neck1',
  Neck3: 'Neck2',
  Head: 'Neck3',
  'Ear1.L': 'Neck3', 'Ear2.L': 'Ear1.L', 'Ear3.L': 'Ear2.L', 'Ear4.L': 'Ear3.L',
  'Ear1.R': 'Neck3', 'Ear2.R': 'Ear1.R', 'Ear3.R': 'Ear2.R', 'Ear4.R': 'Ear3.R',
  'FrontShoulder.L': 'Torso2', 'FrontUpperLeg.L': 'FrontShoulder.L', 'FrontLowerLeg.L': 'FrontUpperLeg.L', 'FF.L': 'FrontLowerLeg.L',
  'FrontShoulder.R': 'Torso2', 'FrontUpperLeg.R': 'FrontShoulder.R', 'FrontLowerLeg.R': 'FrontUpperLeg.R', 'FF.R': 'FrontLowerLeg.R',
  'BackShoulder.L': 'Back', 'BackLeg.L': 'BackShoulder.L', 'BackUpperLeg.L': 'BackLeg.L', 'BackLowerLeg.L': 'BackUpperLeg.L', 'FFB.L': 'BackLowerLeg.L',
  'BackShoulder.R': 'Back', 'BackLeg.R': 'BackShoulder.R', 'BackUpperLeg.R': 'BackLeg.R', 'BackLowerLeg.R': 'BackUpperLeg.R', 'FFB.R': 'BackLowerLeg.R',
  Tail1: 'Back', Tail2: 'Tail1', Tail3: 'Tail2', Tail4: 'Tail3',
  Tail5: 'Tail4', Tail6: 'Tail5', Tail7: 'Tail6', Tail8: 'Tail7',
}

export const BONES = Object.keys(HIERARCHY)

// What a walk has to have to read as a walk. Everything outside this set is
// welcome but not load-bearing: a rig with no Neck3 drops that clip's neck
// track and looks slightly stiff, while a rig with no BackUpperLeg.R has a
// hind leg that does not bend. Feet are optional for the same reason they are
// rigid: nothing drives them, so a rig without them loses no motion. Tripo's
// rigs run 30-40 joints, so the feet, tail and ear bones are usually where they
// run out.
export const REQUIRED = new Set([
  'Body', 'Back', 'Torso', 'Torso2', 'Neck1', 'Head',
  'FrontShoulder.L', 'FrontUpperLeg.L', 'FrontLowerLeg.L',
  'FrontShoulder.R', 'FrontUpperLeg.R', 'FrontLowerLeg.R',
  'BackShoulder.L', 'BackLeg.L', 'BackUpperLeg.L', 'BackLowerLeg.L',
  'BackShoulder.R', 'BackLeg.R', 'BackUpperLeg.R', 'BackLowerLeg.R',
  'Tail1',
])

/** The clips every animal in the pack carries. Canids swap the two attacks for one `Attack`. */
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
 * or null for the root. A rig with no Neck2 and no Neck3 hangs Head straight
 * off Neck1, and that is correct rather than a gap: skipping a bone shortens
 * the chain, it does not break it.
 */
export function expectedParent(bone, assigned) {
  for (let b = HIERARCHY[bone]; b; b = HIERARCHY[b]) if (assigned.has(b)) return b
  return null
}
