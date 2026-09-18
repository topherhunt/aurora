// ---------------------------------------------------------------------------
// Prompt template for one prop candidate image -- the single picture Tripo
// reconstructs a stump, log, mushroom, skeleton or cave mouth from. Same
// generator and the same staging rules as the creature prompt (§27 stage 2:
// neutral grey, flat shadowless light, three-quarter view, never a chroma key),
// and it must not drift toward the character-sheet prompt for the same reasons
// creature-prompt.mjs gives.
//
// What differs from a creature is what the picture is FOR. A prop is scenery
// seen from two metres and then from sixty, so the prompt asks for a gritty,
// realistic specimen with a jagged, irregular silhouette: the fine surface
// grit lives in the colour map and the silhouette is what survives the 128px
// map and the four-triangle card. The subject is told it rests on the floor
// with its underside on the ground, because the card bake and the world both
// seat a prop at y = 0 and a prop drawn floating reconstructs with a base that
// is not flat.
// ---------------------------------------------------------------------------

import { ASPECT_RATIOS } from '../../creatures/creature-prompt.mjs'

export { ASPECT_RATIOS }

/** The frame a prop gets when its roster entry and the bench have not chosen one. */
export const DEFAULT_FRAME = '4:3'

/**
 * The house style, applied to every prop that does not bring its own `style`.
 * Gritty and real is the brief: a weathered natural specimen with fine surface
 * detail and a jagged, irregular outline.
 *
 * ONLY NAME WHAT SHOULD BE IN THE PICTURE. The image models are literal: every
 * noun in the prompt is a thing to paint, and a negation or a contrast
 * ("snapped rather than sawn", "never cartoonish") plants the very thing it
 * rules out. So the style and every roster description say what IS there and
 * nothing about what is not; check-prop-gen.mjs refuses negations, contrasts
 * and similes in both. The staging paragraph's "no shadow, no text" list is
 * the one exception, carried over from the creature prompt where it proved out.
 *
 * The same rule is why a `styleNote` (appended AFTER the house style) can only
 * lean on it, never undo it: "dirt and decay" already in the prompt gets
 * painted whatever the note says next. A subject the grit is wrong for (a
 * living hand) sets `style` and REPLACES the house style outright.
 */
export const HOUSE_STYLE =
  'Photorealistic, gritty and weathered: a real natural specimen with dense fine surface detail -- grain, fissures, ' +
  'flaking, staining, dirt and decay -- in true muted natural colour with full surface texture in the albedo, ' +
  'and a jagged, broken, irregular, asymmetric silhouette.'

/**
 * Builds the image prompt for one prop. `description` is the whole of what the
 * prop is; `style` stands in for the house style when given, `styleNote`
 * follows whichever style is used; everything else is the staging every later
 * stage depends on.
 */
export function buildPropPrompt({ description, style, styleNote } = {}) {
  if (!description) throw new Error('buildPropPrompt requires a description -- it is the whole description of the prop')
  if (style !== undefined && !(typeof style === 'string' && style.trim())) throw new Error('buildPropPrompt: a style is a non-empty string, or absent for the house style')

  return (
    `A single object, alone, centred, and photographed whole in a seamless neutral light-grey studio cyclorama, ` +
    `where the floor and the background are one continuous flat grey with no horizon line and no visible edge between them. ` +
    `The object rests naturally on the floor with its underside flat on the ground, seen three-quarters from the side and slightly above eye level, ` +
    `the whole object visible with a clear margin of empty background on all four sides and nothing cropped. ` +
    `It is one closed solid object, watertight, with nothing floating detached from it. ` +
    `Evenly lit from all sides with soft shadowless light -- no cast shadow on the floor, no strong rim light, no coloured light, ` +
    `no gradient or vignette on the background. Sharp focus across the whole subject, no depth-of-field blur, no motion blur. ` +
    `Nothing else in frame: no scenery, no grass, no other objects, no text, no watermark, no border. ` +
    `${style ?? HOUSE_STYLE} ` +
    (styleNote ? `${styleNote} ` : '') +
    `\n\nObject: ${description}.`
  )
}
