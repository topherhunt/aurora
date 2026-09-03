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
// ---------------------------------------------------------------------------

const POSE_BY_RIG = {
  biped: 'standing upright and symmetrical in a relaxed A-pose, arms held away from the torso so both arms and both legs read as separate limbs, facing three-quarters toward the camera',
  quadruped: 'standing square on all four legs in a neutral side-on three-quarter view, all four legs visible and clearly separated from each other and from the belly, head level, tail hanging free and not curled against the body',
  avian: 'standing with wings held partly open and away from the body so each wing reads as a separate limb, both legs visible, seen three-quarters from the side',
  serpentine: 'stretched out in a long gentle S-curve seen from above at a three-quarter angle, the whole body visible end to end with no coils crossing over each other',
  aquatic: 'in exact side profile swimming straight, body straight rather than curved, all fins spread open and clearly separated from the body',
  hexapod: 'standing with all six legs spread and clearly separated, seen three-quarters from above and the side',
  // "every limb" rather than "all eight": a crab has eight walking legs plus two
  // claws, and a prompt that names a count the picture contradicts is a prompt
  // arguing with itself. The skeleton family is still octopod; what the clause
  // has to buy is limbs held clear of the body, not a headcount.
  octopod: 'with every limb spread evenly and clearly separated from the body and from each other, seen three-quarters from above',
  // Nothing to rig, so the pose is chosen to read well as a static prop.
  none: 'seen three-quarters from the side, whole subject visible with nothing cropped',
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
    `A single creature, alone, centred, and photographed whole against a flat plain neutral light-grey studio background. ` +
    `The creature is ${pose}. ` +
    `Evenly lit from all sides with soft shadowless light -- no cast shadow on the ground, no strong rim light, no coloured light, ` +
    `no gradient or vignette on the background. Sharp focus across the whole subject, no depth-of-field blur, no motion blur. ` +
    `Nothing else in frame: no ground plane, no scenery, no props, no other creatures, no text, no watermark, no border. ` +
    (styleNote ? `${styleNote} ` : '') +
    `\n\nCreature: ${description}.`
  )
}
