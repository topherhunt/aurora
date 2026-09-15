// ---------------------------------------------------------------------------
// Prompt template for one prop candidate image -- the single picture Tripo
// reconstructs a stump, log, mushroom, skeleton or cave mouth from. Same
// generator and the same staging rules as the creature prompt (§27 stage 2:
// neutral grey, flat shadowless light, three-quarter view, never a chroma key),
// and it must not drift toward the character-sheet prompt for the same reasons
// creature-prompt.mjs gives.
//
// What differs from a creature is what the picture is FOR. A prop is scenery
// seen from two metres and then from sixty, so the prompt asks for a stylised
// game asset with an exaggerated, readable silhouette rather than a specimen
// photograph: the personality has to survive a 128px colour map and a four-
// triangle card, and a botanically correct mushroom does not. The subject is
// told it rests on the floor with its underside on the ground, because the
// card bake and the world both seat a prop at y = 0 and a prop drawn floating
// reconstructs with a base that is not flat.
// ---------------------------------------------------------------------------

import { ASPECT_RATIOS } from '../../creatures/creature-prompt.mjs'

export { ASPECT_RATIOS }

/** The frame a prop gets when its roster entry and the bench have not chosen one. */
export const DEFAULT_FRAME = '4:3'

/**
 * The house style, applied to every prop unless the entry's `styleNote` says
 * otherwise. Personality is the brief: chunky forms, a silhouette that reads at
 * a glance, painterly colour with the shading already in the albedo the way a
 * hand-painted game texture carries it -- but no cast shadow and no directional
 * light, which is the line between "painted shading" and "baked lighting".
 */
export const HOUSE_STYLE =
  'Stylised hand-painted low-poly game asset: bold exaggerated proportions, a chunky silhouette that reads at a glance, ' +
  'a few large readable shapes rather than fine detail, painterly colour with soft form shading in the paint itself, ' +
  'slightly asymmetric and never perfectly regular.'

/**
 * Builds the image prompt for one prop. `description` is the whole of what the
 * prop is; everything else is the staging every later stage depends on.
 */
export function buildPropPrompt({ description, styleNote } = {}) {
  if (!description) throw new Error('buildPropPrompt requires a description -- it is the whole description of the prop')

  return (
    `A single object, alone, centred, and photographed whole in a seamless neutral light-grey studio cyclorama, ` +
    `where the floor and the background are one continuous flat grey with no horizon line and no visible edge between them. ` +
    `The object rests naturally on the floor with its underside flat on the ground, seen three-quarters from the side and slightly above eye level, ` +
    `the whole object visible with a clear margin of empty background on all four sides and nothing cropped. ` +
    `It is one closed solid object, watertight, with nothing floating detached from it. ` +
    `Evenly lit from all sides with soft shadowless light -- no cast shadow on the floor, no strong rim light, no coloured light, ` +
    `no gradient or vignette on the background. Sharp focus across the whole subject, no depth-of-field blur, no motion blur. ` +
    `Nothing else in frame: no scenery, no grass, no other objects, no text, no watermark, no border. ` +
    `${HOUSE_STYLE} ` +
    (styleNote ? `${styleNote} ` : '') +
    `\n\nObject: ${description}.`
  )
}
