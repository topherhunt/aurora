// ---------------------------------------------------------------------------
// The v9 species list and the image prompt built from it -- the one picture
// Tripo reconstructs a tree from.
//
// This is NOT tools/creatures/creature-prompt.mjs with the nouns changed:
//
//   IT ASKS FOR A PHOTOGRAPH OF A REAL TREE, and the solidity the mesh needs is
//   left to what real foliage already is. Vegetation reconstructs badly where the
//   structure is thinner than a few pixels -- bare twigs, single leaves against
//   the sky -- and the obvious defence is to order the canopy as one closed
//   opaque mass. That was tried and it produces exactly what it says: a smooth
//   symmetrical lollipop that reads as modelling clay. Every one of those bans
//   is now gone except the one that is also true of a real summer tree -- no bare
//   winter twigs past the foliage -- and the clumps are asked for as dense enough
//   to read solid at a glance, which a tree in full leaf is anyway.
//
//   PROPORTIONS ARE ORDERED AS RATIOS, not adjectives. "A broad crown on a thick
//   trunk" is drawn as a specimen-tree diagram; "a crown one and a third times as
//   wide as the tree is tall, on a trunk a tenth of its height thick" is drawn as
//   an oak. Every species carries the crown's width against the height, where the
//   crown starts up the trunk, and the trunk's thickness against the height.
//   Asymmetry has to be named too, or the model mirrors the tree down its axis.
//
//   THE TRUNK CLAUSE IS PER SPECIES, and mandatory. The paint step can only paint
//   faces that exist, so a canopy swallowing the trunk to the ground has no bark
//   region in it and no amount of clicking recovers one. But "a clear length of
//   bare trunk" applied to every species gives a pine a bare pole halfway up
//   itself, which no pine has.
//
// Alpha-tested foliage is still what costs the whole draw its low-resolution-Z on
// Adreno (tools/trees/solidify-leaves.mjs), and is still why v9 exists. That is
// answered by the RECONSTRUCTION, which returns a closed shell whatever it was
// shown, rather than by flattening the picture it works from.
//
// The rest is inherited from §27 for the same reasons argued there: neutral grey
// and never a chroma key, flat shadowless light so nothing bakes into base
// colour and fights src/lighting.js, and a three-quarter view because
// reconstruction wants depth.
// ---------------------------------------------------------------------------

/**
 * `heightM` is what src/mesh/paint.js `groundAndScale` normalises to, so it is
 * the tree's real size in the world and not a hint. The numbers match the
 * species defaults the runtime generators already use (props/tree-bank.js).
 *
 * `bark` and `foliage` name the STARTING texture slots the paint step opens
 * with. They are a convenience, not a constraint -- the whole point of the bench
 * is picking something else and seeing it.
 */
export const TREE_SPECIES = [
  {
    id: 'v9-oak',
    label: 'Oak',
    heightM: 9,
    crown: 'a broad rounded crown about one and a third times as wide as the tree is tall, its underside beginning a third of the way up, built of five or six irregular leaf masses at different heights with one side of the tree carrying visibly more than the other',
    trunk: 'a short trunk about a tenth of the tree\'s height thick -- close to a metre across at the base -- dividing barely two metres up into three or four heavy crooked limbs that stay visible where they enter the foliage',
    bark: 'bark_oak.png',
    foliage: 'leaf_oak_solid.png',
    description: 'a mature English oak grown in the open, deeply fissured grey-brown bark, heavy spreading limbs, dense deep-green summer foliage in full leaf',
  },
  {
    id: 'v9-aspen',
    label: 'Aspen',
    heightM: 12,
    crown: 'a narrow crown about a third as wide as the tree is tall, occupying the top half of the tree, fuller near the top, its outline uneven from side to side',
    trunk: 'a straight trunk about a fortieth of the tree\'s height thick -- roughly the thickness of a forearm -- clear of branches for its lower half',
    bark: 'bark_birch.png',
    foliage: 'leaf_aspen_solid.png',
    description: 'a tall quaking aspen in full summer leaf, smooth pale grey-green bark darkening and roughening toward the base, crown of small round leaves',
  },
  {
    id: 'v9-birch',
    label: 'Birch',
    heightM: 10,
    crown: 'an open crown about half as wide as the tree is tall, carried in the top half, built of foliage hanging outward and downward from the ends of arching limbs, wider on one side than the other',
    trunk: 'a slender trunk about a fortieth of the tree\'s height thick with a slight natural lean, undivided for its lower half, then splitting into two or three arching limbs',
    bark: 'bark_birch.png',
    foliage: 'leaf2_aspen_solid.png',
    description: 'a silver birch in summer, bright white papery bark with dark horizontal scars and a dark rough base, drooping light-green crown',
  },
  {
    id: 'v9-pine',
    label: 'Pine',
    heightM: 11,
    crown: 'a crown about half as wide as the tree is tall, occupying the top two thirds, built of thick boughs that leave the trunk at uneven heights and reach different distances on each side -- longest and heaviest low down, shortening toward a narrow leader at the top, with daylight between one bough and the next and nothing tiered, mirrored or evenly spaced',
    trunk: 'a straight trunk about a thirtieth of the tree\'s height thick at the base -- some forty centimetres -- tapering as it rises, bare of boughs for its lowest third and then visible between the boughs above that',
    bark: 'bark_pine.png',
    foliage: 'leaf_pine_solid.png',
    description: 'a mature Scots pine, orange-red plated bark on the upper trunk and grey fissured bark below, dark blue-green needles massed into thick flat sprays at the ends of the boughs',
  },
]

export const speciesById = (id) => TREE_SPECIES.find((s) => s.id === id) ?? null

/**
 * Builds the image prompt for one tree.
 *
 * `crown` and `trunk` are the species' own shape clauses; everything else is
 * fixed, because everything else is about what the reconstruction and the paint
 * step need rather than about which tree this is.
 */
export function buildTreePrompt({ description, crown, trunk, styleNote } = {}) {
  if (!description) throw new Error('buildTreePrompt requires a description')
  if (!crown) throw new Error('buildTreePrompt requires a crown clause -- it is what makes one species not another')
  if (!trunk) throw new Error('buildTreePrompt requires a trunk clause -- a prompt without one grows a bare pole halfway up a pine')

  return (
    `A PHOTOREALISTIC photograph of one real tree, alone, upright, centred, whole from root to crown against a flat plain neutral light-grey studio background. ` +
    `Crown: ${crown}. ` +
    `Trunk: ${trunk}. ` +
    `These proportions are the point: get the crown's width against the tree's height, and the trunk's thickness against both, exactly as stated. ` +
    `The tree is asymmetrical, as a real one is -- one side heavier than the other, the crown sitting off-centre over the trunk, no two limbs alike. ` +
    `Not mirror-symmetrical, not a smooth geometric solid on a bare stick, not a lollipop, not a topiary, not a cartoon or a diagram of a tree, ` +
    `and never sculpted clay, carved foam, plastic or a moss ball. ` +
    `Real photographic detail: real bark texture on the trunk, real leaves in real depth, the foliage carried in natural clumps ` +
    `that are dense enough to read as solid masses at a glance while the limbs between them stay legible. ` +
    `Summer, in full leaf. No bare winter twigs poking out past the foliage. ` +
    `Seen three-quarters from the side at eye level, whole tree in frame with nothing cropped. ` +
    `Evenly lit from all sides with soft shadowless light -- no cast shadow on the ground, no strong rim light, no coloured light, ` +
    `no gradient or vignette on the background. Sharp focus throughout, no depth-of-field blur. ` +
    `Nothing else in frame: no ground plane, no grass, no scenery, no other trees, no people, no text, no watermark, no border. ` +
    (styleNote ? `${styleNote} ` : '') +
    `\n\nTree: ${description}.`
  )
}
