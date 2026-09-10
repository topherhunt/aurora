// ---------------------------------------------------------------------------
// The v9 species list and the image prompt built from it -- the one picture
// Tripo reconstructs a tree from.
//
//   ASK FOR THE THING YOU WANT A MESH OF. Two passes were spent asking for a
//   better photograph: first a closed opaque canopy (which came back as
//   modelling clay), then a real survey photograph on an overcast day (which
//   came back looking like a tree and reconstructed as an agglomeration of
//   lollipops). A photograph of dense lush foliage has no depth information
//   between the leaves, so there is nothing for the reconstruction to be right
//   about, and the better the photograph the worse the mesh. The picture is not
//   the deliverable -- the mesh is. So the prompt now asks for a LOW-POLY MODEL
//   of the tree: large flat facets, foliage as a few big smooth masses, no
//   individual leaves, no twigs, a closed silhouette. Tripo reconstructs that
//   well for the same reason it fails on leaves -- every surface in the picture
//   is a surface the mesh can actually have.
//
//   ONE EDITABLE FIELD PER TREE. The crown/trunk/description split existed to
//   force proportions to be stated, and it worked, but three boxes are three
//   places to edit for one change. Each species now carries a single `prompt`
//   holding everything specific to that tree -- style, proportions, colours,
//   irregularity -- and buildTreePrompt appends only the staging that every
//   later stage depends on and no one should have to retype.
//
//   THE TRUNK STILL HAS TO BE THERE. The paint step can only paint faces that
//   exist, so a canopy swallowing the trunk to the ground has no bark region in
//   it and no amount of clicking recovers one. Every species prompt says where
//   its own lowest branches start; the pine's says it in pine terms, because one
//   shared "a clear length of bare trunk" gave it a bare pole halfway up itself.
//
//   IRREGULARITY IS ORDERED, or the model returns a mirror-symmetrical lollipop,
//   which is the single most reliable tell that a mesh was generated.
//
// The staging is inherited from §27 for the reasons argued there: a plain
// background and never a chroma key (it bleeds its own hue into the
// reconstruction), flat light so nothing bakes into base colour and fights
// src/lighting.js, and a three-quarter view because reconstruction wants depth.
// Framing is pinned with a margin because asked for loosely the tree came back
// with its trunk cropped at the frame edge, and the foot of the trunk is what
// src/mesh/paint.js `groundAndScale` measures from.
// ---------------------------------------------------------------------------

/**
 * `heightM` is what src/mesh/paint.js `groundAndScale` normalises to, so it is
 * the tree's real size in the world and not a hint. The numbers match the
 * species defaults the runtime generators already use (props/tree-bank.js).
 *
 * `bark` and `foliage` name the STARTING texture slots the paint step opens
 * with. They are a convenience, not a constraint -- the whole point of the bench
 * is picking something else and seeing it.
 *
 * `prompt` is the whole editable half, and the bench edits it as one box.
 */
export const TREE_SPECIES = [
  {
    id: 'v9-oak',
    label: 'Oak',
    heightM: 9,
    bark: 'bark_oak.png',
    foliage: 'leaf_oak_solid.png',
    prompt:
      'A clean low-poly 3D model of a mature English oak, the kind sold as a game asset. ' +
      'The foliage is five or six big smooth rounded masses built from large flat polygon facets -- no individual leaves, no twigs, ' +
      'no holes smaller than a branch. The crown is about one and a third times as wide as the tree is tall and its underside begins ' +
      'a third of the way up. The trunk is short and heavy, about a tenth of the tree\'s height thick, and divides barely two metres up ' +
      'into three or four crooked limbs that stay visible where they enter the foliage. ' +
      'Irregular and asymmetric: the masses at different heights and different sizes, one side of the tree heavier than the other, ' +
      'the crown sitting off-centre over the trunk. ' +
      'Matte flat-shaded surfaces in two solid colours, grey-brown bark and deep summer green, with crisp visible facet edges.',
  },
  {
    id: 'v9-aspen',
    label: 'Aspen',
    heightM: 12,
    bark: 'bark_birch.png',
    foliage: 'leaf_aspen_solid.png',
    prompt:
      'A clean low-poly 3D model of a tall quaking aspen, the kind sold as a game asset. ' +
      'The foliage is four or five tall smooth masses built from large flat polygon facets -- no individual leaves, no twigs -- ' +
      'stacked into a narrow crown about a third as wide as the tree is tall, occupying the top half and fuller near the top. ' +
      'The trunk is straight and slender, about a fortieth of the tree\'s height thick, clear of branches for its lower half. ' +
      'Irregular and asymmetric: the masses at different heights and different sizes, one side heavier, the outline uneven. ' +
      'Matte flat-shaded surfaces in two solid colours, pale grey-green bark darkening toward the base and yellow-green foliage, ' +
      'with crisp visible facet edges.',
  },
  {
    id: 'v9-birch',
    label: 'Birch',
    heightM: 10,
    bark: 'bark_birch.png',
    foliage: 'leaf2_aspen_solid.png',
    prompt:
      'A clean low-poly 3D model of a silver birch, the kind sold as a game asset. ' +
      'The foliage is four or five smooth masses built from large flat polygon facets -- no individual leaves, no twigs -- ' +
      'hanging outward and downward from the ends of a few arching limbs, forming a crown about half as wide as the tree is tall ' +
      'carried in the top half. The trunk is slender, about a fortieth of the tree\'s height thick, with a slight lean, ' +
      'undivided for its lower half and then splitting into two or three arching limbs. ' +
      'Irregular and asymmetric: the masses at different heights and different sizes, one side wider than the other, the lean off vertical. ' +
      'Matte flat-shaded surfaces in solid colours, bright white bark with dark horizontal scars and a dark rough base, light green foliage, ' +
      'with crisp visible facet edges.',
  },
  {
    id: 'v9-pine',
    label: 'Pine',
    heightM: 11,
    bark: 'bark_pine.png',
    foliage: 'leaf_pine_solid.png',
    prompt:
      'A clean low-poly 3D model of a mature Scots pine, the kind sold as a game asset. ' +
      'The foliage is a few large angular masses built from large flat polygon facets -- no needles, no twigs -- of clearly unequal ' +
      'size, most of them touching or merging into their neighbours so the whole crown reads as one ragged irregular cone rather than ' +
      'a stack of separate discs, with two or three gaps where a bough is simply missing on one side. ' +
      'Not a bonsai, not a Japanese pine, no evenly stacked tiers, no flat-topped plates, no bare pole under an umbrella, ' +
      'not mirror-symmetrical. ' +
      'The silhouette is a tall ragged cone: the widest and heaviest masses attach barely a quarter of the way up the trunk, ' +
      'near the ground, and the masses shorten as they rise to a narrow point at the top. The crown is about half as wide as the ' +
      'tree is tall and occupies the upper three quarters of its height. ' +
      'The trunk is straight, about a thirtieth of the tree\'s height thick at the base, tapering as it rises, ' +
      'bare only for its lowest quarter and glimpsed between the masses above that. ' +
      'Matte flat-shaded surfaces in solid colours, orange-red bark high on the trunk and grey below, dark blue-green foliage, ' +
      'with crisp visible facet edges.',
  },
]

export const speciesById = (id) => TREE_SPECIES.find((s) => s.id === id) ?? null

/**
 * Builds the image prompt for one tree.
 *
 * `prompt` is the species' own text and is everything about which tree this is.
 * The tail is fixed because it is about what the RECONSTRUCTION and the paint
 * step need -- a closed object, a plain background, flat light, a whole tree in
 * frame with its foot showing -- rather than about the tree.
 */
export function buildTreePrompt({ prompt, styleNote } = {}) {
  if (!prompt) throw new Error('buildTreePrompt requires a prompt -- it is the whole description of the tree')

  return (
    `${prompt} ` +
    `The model is one closed solid object, watertight, with nothing floating detached from it. ` +
    `Seen three-quarters from the side at eye level. ` +
    `Framing: the tree fills about three quarters of the frame's height and no more, with empty background as a clear margin on all four sides. ` +
    `The foot of the trunk is well above the bottom edge and the top well below the top edge. Nothing is cropped. ` +
    `Plain flat mid-grey background: no ground plane, no shadow, no grass, no scenery, no other objects, no text, no watermark, no border. ` +
    `Even flat lighting from every side, matte surfaces, no glossy highlights, no cast shadow, no coloured light, no vignette. ` +
    (styleNote ? `${styleNote} ` : '')
  )
}
