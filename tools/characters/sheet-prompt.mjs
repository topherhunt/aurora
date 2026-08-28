// ---------------------------------------------------------------------------
// Prompt template for one character-sheet view (front, side, or back). Each
// view is its own generated image, not a single multi-view composite --
// chromakey.mjs's silhouetteProfile assumes one figure blob per row, which a
// three-views-side-by-side image would break. Consistency across the three
// views instead comes from gen-sheet.html attaching the already-picked front
// image as a reference (openrouter.mjs's `referenceImages`) when generating
// side and back.
//
// The character stands in a T-pose (arms straight out to the sides) in every
// view -- that separates the arm from the torso as a distinct blob in the
// front-view silhouette, the same way the legs are already separated, so
// loft-mesh.mjs can measure the arm directly (chromakey.mjs's columnProfile)
// instead of estimating its width by subtracting an assumed torso width.
// ---------------------------------------------------------------------------

const VIEW_TEXT = {
  front: 'FRONT VIEW: the character faces directly toward the camera.',
  side: 'SIDE VIEW: the character stands in exact profile, facing to their own right, camera at a 90 degree angle from the front view.',
  back: 'BACK VIEW: the character faces directly away from the camera, seen from behind.',
}

function describeSubject({ species, age, build, description, hair, clothing } = {}) {
  const bits = []
  if (species) bits.push(species)
  if (age) bits.push(age)
  if (build) bits.push(`${build} build`)
  if (description) bits.push(description)
  if (hair) bits.push(`${hair} hair`)
  if (clothing) bits.push(`wearing ${clothing}`)
  if (!bits.length) throw new Error('buildViewPrompt needs at least one of species/age/build/description/hair/clothing')
  return bits.join(', ')
}

/** Builds the prompt for one view. `vars` is a character's descriptive fields (see describeSubject). */
export function buildViewPrompt(view, vars) {
  const viewText = VIEW_TEXT[view]
  if (!viewText) throw new Error(`unknown view "${view}" -- expected front, side, or back`)
  const subject = describeSubject(vars)
  return (
    `Full-body character reference image on a solid flat magenta background (#FF00FF, chroma key). ` +
    `The character stands straight in a T-pose: arms held straight out to their sides, horizontal, palms down, legs together, ` +
    `orthographic proportions with no perspective distortion, evenly lit, no shadows or gradient on the background, ` +
    `no props, no other characters, no text or watermarks. ${viewText}\n\nCharacter: ${subject}.`
  )
}
