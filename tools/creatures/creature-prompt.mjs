// ---------------------------------------------------------------------------
// Prompt template for one creature candidate image -- the single picture Tripo
// reconstructs a mesh from. Fed to tools/characters/openrouter.mjs (FLUX.2
// Klein 4B), same generator the character sheets use.
//
// This is NOT the character-sheet prompt and must not drift toward it. Those
// images are chroma-keyed and measured (tools/characters/chromakey.mjs reads a
// magenta key and a silhouette profile); these are handed whole to a
// reconstruction model. Three differences fall out of that:
//
//   Neutral grey background, not #FF00FF. Tripo paints the texture from this
//   image, and a saturated key bleeds a magenta rim into the fur.
//
//   Flat, shadowless light. Any cast shadow or rim light gets baked into the
//   base colour and then fights src/lighting.js at runtime, which cannot be
//   undone downstream.
//
//   A three-quarter view, not an orthographic front. Reconstruction wants to
//   see depth; the chromakey loft wanted a flat measurable profile.
//
// The pose clause is chosen by rig type, because a limb tucked against the body
// is the documented cause of a bad auto-rig -- the skeleton solver cannot find
// a leg it cannot see separated from the torso.
//
// A standing creature is told it stands ON something. The floor is the same grey
// as the background so it never reads as scenery, but it has to be in the prompt:
// asking for feet flat on the ground while also asking for "no ground plane" is
// an argument the picture settles by lifting the creature off its front feet.
// ---------------------------------------------------------------------------

const POSE_BY_RIG = {
  biped: 'standing upright and symmetrical on a level floor in a relaxed A-pose, both feet flat on the floor, arms held away from the torso so both arms and both legs read as separate limbs, facing three-quarters toward the camera',
  quadruped: 'standing square and at rest on a level floor, its weight down on all four legs with every foot planted flat, seen side-on in a three-quarter view, all four legs visible and clearly separated from each other and from the belly, the back horizontal and the head carried no higher than the shoulders, tail hanging free and not curled against the body',
  avian: 'standing on a level floor with both feet flat on it, wings held partly open and away from the body so each wing reads as a separate limb, both legs visible, seen three-quarters from the side',
  serpentine: 'stretched out in a long gentle S-curve seen from above at a three-quarter angle, the whole body visible end to end with no coils crossing over each other',
  aquatic: 'in exact side profile swimming straight, body straight rather than curved, all fins spread open and clearly separated from the body',
  hexapod: 'standing on a level floor with all six legs spread and clearly separated, seen three-quarters from above and the side',
  // "every limb" rather than "all eight": a crab has eight walking legs plus two
  // claws, and a prompt that names a count the picture contradicts is a prompt
  // arguing with itself. The skeleton family is still octopod; what the clause
  // has to buy is limbs held clear of the body, not a headcount.
  octopod: 'with every limb spread evenly and clearly separated from the body and from each other, seen three-quarters from above',
  // Nothing to rig, so the pose is chosen to read well as a static prop.
  none: 'seen three-quarters from the side, whole subject visible with nothing cropped',
}

// THE FRAME IS PART OF THE POSE, and it outranks the words. A generator fills
// the canvas it is given, so a square asked for a wide subject repositions the
// subject to fit -- a spread-winged quadruped rears onto its hind legs, and a
// hare standing side-on gets shoved upright or cropped. No amount of "all four
// feet flat on the ground" in the description outvotes the canvas shape.
//
// So the frame is keyed off the same thing the pose clause is: rig type already
// says what silhouette the creature has. MOST CREATURES ARE WIDE -- a body seen
// side-on with legs, a tail, or open wings is the normal case here, and 16:9 is
// the normal answer. The exceptions are the shapes that genuinely are not wide:
// a biped standing upright, and a radially splayed crab or spider seen from
// above, which really is square.
//
// A creature can still override this; the roster and the bench both carry an
// `aspectRatio`, and this is only what they fall back to.
const FRAME_BY_RIG = {
  quadruped: '16:9',
  avian: '16:9',
  aquatic: '16:9',
  serpentine: '16:9',
  hexapod: '4:3',
  octopod: '1:1',
  biped: '9:16',
  none: '4:3',
}

export const ASPECT_RATIOS = ['1:1', '16:9', '4:3', '3:4', '9:16']

/**
 * The frame a creature gets when nothing has chosen one for it. Throws on an
 * unknown rig type for the same reason buildCreaturePrompt does: falling back
 * to a square silently is precisely the bug this table exists to fix.
 */
export function frameForRig(rigType = 'none') {
  const frame = FRAME_BY_RIG[rigType]
  if (!frame) throw new Error(`unknown rigType "${rigType}" -- expected one of ${Object.keys(FRAME_BY_RIG).join(', ')}`)
  return frame
}

/**
 * Builds the image prompt for one creature. `rigType` selects the pose clause
 * and should match what the roster (and later Tripo's free rig-check) says the
 * creature is; `none` for anything that will never be rigged.
 */
export function buildCreaturePrompt({ description, rigType = 'none', styleNote } = {}) {
  if (!description) throw new Error('buildCreaturePrompt requires a description')
  const pose = POSE_BY_RIG[rigType]
  if (!pose) throw new Error(`unknown rigType "${rigType}" -- expected one of ${Object.keys(POSE_BY_RIG).join(', ')}`)

  return (
    `A single creature, alone, centred, and photographed whole in a seamless neutral light-grey studio cyclorama, ` +
    `where the floor and the background are one continuous flat grey with no horizon line and no visible edge between them. ` +
    `The creature is ${pose}. ` +
    `Evenly lit from all sides with soft shadowless light -- no cast shadow on the floor, no strong rim light, no coloured light, ` +
    `no gradient or vignette on the background. Sharp focus across the whole subject, no depth-of-field blur, no motion blur. ` +
    `Nothing else in frame: no scenery, no props, no other creatures, no text, no watermark, no border. ` +
    (styleNote ? `${styleNote} ` : '') +
    `\n\nCreature: ${description}.`
  )
}
