// ---------------------------------------------------------------------------
// Starter roster for gen-prop.html. Each entry's `description` feeds
// prop-prompt.mjs; `sizeM` is the prop's real longest dimension in metres, the
// scale the world will place it at; `category` is the world layer it is for
// (which renderer will eventually scatter it), and nothing else keys on it.
//
// `texPx` is the side of the colour map a prop SHIPS with and the bench
// previews it at that size. `delight` ships the map with its baked top-down
// light flattened against the mesh (delight.mjs; preview it bare first). Absent means TEX_PX_MAX; a mushroom is a few
// pixels tall in the world and is designated TEX_PX_SMALL. The cap and the
// designation are the creature roster's, imported rather than copied, so one
// number governs every generated asset.
//
// Every mushroom is ONE specimen. Clusters and tufts are the placer's job:
// scattering copies of a single mesh at random sizes and tilts gives a
// different clump at every site, where a generated cluster is the same three
// mushrooms in the same arrangement everywhere it stands.
//
// Editable in the bench -- this is the starting point for judging whether a
// concept is worth spending art on, not a fixed list. A prop invented in the
// bench lives only in its own work/<id>/state.json until it is settled enough
// to be written here.
// ---------------------------------------------------------------------------

import { TEX_PX_MAX, TEX_PX_SMALL } from '../../creatures/creature-roster.mjs'

export { TEX_PX_MAX, TEX_PX_SMALL }

export const CATEGORIES = ['deadwood', 'mushroom', 'bones', 'cave', 'other']

/** The side the prop's map ships at, from its roster entry (or bench-saved meta). Throws on one over the cap. */
export function shipTexPx(entry) {
  const px = entry.texPx ?? TEX_PX_MAX
  if (!(px > 0 && px <= TEX_PX_MAX)) throw new Error(`${entry.id}: texPx ${px} is over the ${TEX_PX_MAX}px cap`)
  return px
}

export const PROPS = [
  {
    id: 'stump-rotting',
    label: 'Rotting Stump',
    category: 'deadwood',
    sizeM: 0.9,
    aspectRatio: '4:3',
    description:
      'an old rotting tree stump about half a metre tall, the top a ragged crown of long torn upward-pointing ' +
      'splinters with one tall spear of trunk still standing up from the rim, thick deeply fissured grey-brown ' +
      'bark cracked and lifting in rough scales over punky crumbling orange-brown wood pitted with small dark ' +
      'bore holes, a hollow rotted-out core, fat gnarled exposed roots flaring out at the base, wet dark staining ' +
      'and patches of moss and lichen on the shaded side',
  },
  {
    id: 'log-fallen',
    label: 'Fallen Log',
    category: 'deadwood',
    sizeM: 3.2,
    aspectRatio: '16:9',
    // Tripo painted the underside it never saw five times darker than the top;
    // the world rolls the log and lights it itself (delight.mjs).
    delight: true,
    description:
      'a long fallen rotting log lying on its side, thick and slightly bowed, a fat torn root end and a jagged ' +
      'splintered narrow end, bark hanging off in long ragged strips over weathered silver-grey wood with deep ' +
      'cracks and lifted split fibres, one hollow rotted end open to the dark inside, two short snapped branch ' +
      'stubs jutting up at odd angles, dark damp staining, moss and small shelf fungi along the underside',
  },
  {
    id: 'snag-standing',
    label: 'Standing Snag',
    category: 'deadwood',
    sizeM: 4.5,
    aspectRatio: '3:4',
    description:
      'a dead standing leafless pine trunk about four metres tall, its top a crown of long jagged upward-pointing ' +
      'splinters, leaning slightly, fully clad in thick rough dark grey-brown pine bark in deep fissured plates ' +
      'with a few plates lifting loose, small patches of bleached silver-grey wood showing through at the ' +
      'splintered top and around the snapped branch stubs, a few short snapped branch stubs, small dark round ' +
      'bore holes, moss and pale lichen crusting the shaded side of the bark, a flared base',
  },
  {
    id: 'mushroom-agaric',
    label: 'Fly Agaric',
    category: 'mushroom',
    sizeM: 0.2,
    texPx: TEX_PX_SMALL,
    aspectRatio: '3:4',
    description:
      'a single fly agaric mushroom, a wide domed scarlet-red cap with the colour fading to orange at the ' +
      'edge, flecked with raised crusty creamy-white warts, the cap slightly tilted and its rim faintly ragged, ' +
      'a thick white stem with a torn skirt ring and a bulbous scaly base, a little dirt clinging to the foot',
  },
  {
    id: 'mushroom-bolete',
    label: 'Bolete',
    category: 'mushroom',
    sizeM: 0.18,
    texPx: TEX_PX_SMALL,
    aspectRatio: '3:4',
    description:
      'a single bolete mushroom, a bulging chestnut-brown cap with a matte, slightly cracked surface and a small ' +
      'ragged bite missing from one edge, a swollen pale tan stem with a fine netted texture, a spongy ' +
      'yellow-cream pore underside, soil and leaf litter stuck to the base',
  },
  {
    id: 'mushroom-honey',
    label: 'Honey Fungus',
    category: 'mushroom',
    sizeM: 0.12,
    texPx: TEX_PX_SMALL,
    aspectRatio: '3:4',
    description:
      'a single honey fungus mushroom, a small tawny cap with a darker scaly centre and a thin ragged edge, ' +
      'a thin fibrous tan stem with a faint pale ring, slightly bent, the surfaces dull and damp',
  },
  {
    id: 'carrot',
    label: 'Carrot',
    category: 'other',
    sizeM: 0.45,
    // The root alone: the greens are src/props/carrot.js's leaves sprouting
    // from the crown, each wearing gen-props/carrot-leaf.png, so the root's
    // map is a hand's width of orange and ships at the mushrooms' size.
    texPx: TEX_PX_SMALL,
    aspectRatio: '3:4',
    description:
      'a single whole carrot standing upright, balanced vertically on its narrow pointed tip with the long tapered ' +
      'orange root pointing straight down, the root skin slightly knobbly with fine horizontal ridges and small ' +
      'pale root hairs, dusted and streaked with damp dark clinging soil, a green-tinged shoulder at the top with ' +
      'one short stub of leaf stalk',
  },
  {
    id: 'egg-dragon',
    label: 'Dragon Egg',
    category: 'other',
    sizeM: 0.5,
    aspectRatio: '3:4',
    // One egg for every clutch colour: the world tints each instance through
    // instanceColor, and a tint is a MULTIPLY, so the shell is painted bright
    // and near-white with the scales' edges and shading in grey tone (the
    // rule rock.js grades its tile by). A pigmented shell would only ever
    // darken, and a red tint over a green egg is mud.
    description:
      'a single large dragon egg standing upright on its broad end, a tall oval about half a metre high with a ' +
      'rounded blunt base and a narrower domed top, the whole shell made of small overlapping dragon scales, ' +
      'each scale a smooth glossy teardrop lapped over the row beneath it in neat diagonal rows that wrap the ' +
      'egg from foot to crown, every scale a bright pale pearl-white with its edge and the shadow under its lap ' +
      'in soft light grey, the scales glinting with sharp small highlights, a little dark damp soil dusted ' +
      'around the foot',
    // The house style asks for a jagged, broken, gritty specimen; an egg is
    // the one prop whose silhouette must stay whole and whose surface is
    // glossy, and the note lands after the style so it has the last word.
    styleNote:
      'The shell is bright, pale and near-white, a glossy armour of small overlapping scales with only their ' +
      'edges and lap shadows in light grey, and the outline is one even, rounded, unbroken oval.',
  },
  {
    id: 'rowboat-viking',
    label: 'Viking Rowboat',
    category: 'other',
    sizeM: 3.5,
    aspectRatio: '16:9',
    description:
      'a small open wooden rowboat of medieval viking make, about three and a half metres long, clinker-built ' +
      'from overlapping lapstrake planks of weathered oak riveted along every strake, a sharp raised stem and ' +
      'stern sweeping up high at both ends, the bow post carved into a snarling dragon head with an open jaw, ' +
      'bared teeth, curled horns and a crest of scales running down its neck as the figurehead, two plank ' +
      'thwarts seating two rowers with a pair of oars shipped and lying along them, rope oar loops on wooden ' +
      'tholepins at the gunwales, the planks silver-grey and sun-bleached with dark tarred seams and rusted ' +
      'iron rivet heads, a shallow keel, the hull resting level with its keel and bottom flat on the ground',
    // The house style asks for a broken, asymmetric silhouette; a boat whose
    // hull is anything but whole and symmetric reads as a wreck, so the
    // weathering is confined to the surface and the note lands after the
    // style to have the last word.
    styleNote:
      'The hull is whole and sound, one even symmetric clinker shell with a clean sheer line sweeping from stem ' +
      'to stern, its weathering in the surface grain, the staining and the worn edges of the planks.',
  },
  {
    id: 'hand',
    label: 'Hand',
    category: 'other',
    // Her own hand under each Quest grip, replacing avatar.js's lowPolyHand().
    // ONE hand, the right; the left is its mirror (scale.x = -1) so the world
    // ships one mesh and one map. Wrist to middle fingertip, the pose's own
    // length. It is the one prop seen from thirty centimetres, so it ships at
    // the full map size.
    sizeM: 0.19,
    aspectRatio: '4:3',
    description:
      'a single living right hand, adult, androgynous and of medium size, with smooth warm living skin in a ' +
      'light warm tan, standing upright on the flat end of its wrist with the fingertips pointing up and the ' +
      'thumb towards the camera, held in a loose relaxed half-open pose ready to close around something, the ' +
      'four fingers gently curled in one soft even curve with a small gap between each, the thumb lifted a ' +
      'little out from the palm and curved slightly inward, the palm softly cupped, short clean trimmed nails ' +
      'with pale crescents, soft knuckle creases and faint blue veins under the skin on the back of the hand, ' +
      'fine palm lines, the forearm ending a few centimetres past the wrist in a flat smooth end of the same ' +
      'warm skin',
    // The house style's grit -- fissures, flaking, dirt, decay, a broken
    // silhouette -- gets painted whatever a note says after it, and on a hand
    // it paints a cracked stone cast. So the hand brings its own style.
    style:
      'Photorealistic: a living hand of real warm skin, soft and supple, with fine pores, soft creases and a ' +
      'faint natural sheen, in true natural skin colour with full surface detail in the albedo, and one clean, ' +
      'rounded, unbroken outline.',
  },
  {
    id: 'skeleton-deer',
    label: 'Deer Skeleton',
    category: 'bones',
    sizeM: 1.8,
    aspectRatio: '16:9',
    description:
      'the bleached skeleton of a deer lying on its side on the ground, ribcage arched up with a few ribs broken ' +
      'off, long spine curving to the pelvis, legs folded and partly scattered, the antlered skull resting with ' +
      'its jaw open, the bones weathered chalky white and grey-stained, sunk slightly into the ground',
  },
  {
    id: 'skull-elk',
    label: 'Elk Skull',
    category: 'bones',
    sizeM: 1.1,
    aspectRatio: '4:3',
    description:
      'a large bleached elk skull with a broad sweeping pair of antlers, lying on the ground on its jaw with the ' +
      'antlers tilted up and out, empty eye sockets, cracked and weathered chalk-white bone with brown stains ' +
      'in the seams, one antler tine snapped off',
  },
  {
    id: 'cave-mouth',
    label: 'Cave Mouth',
    category: 'cave',
    sizeM: 5,
    aspectRatio: '4:3',
    description:
      'a cave entrance as one freestanding chunk of rocky hillside, a dark arched opening about two and a half ' +
      'metres tall framed by heavy layered grey-brown boulders and a thick stone lintel, the sides sloping back ' +
      'into a rough mound of rock and packed earth, tufts of moss and a few loose stones at the threshold, the ' +
      'inside of the opening dark',
  },
  {
    id: 'house-leafkin',
    label: 'Leafkin House',
    category: 'other',
    // A home for the one-metre leafkin (creature-roster.mjs): the door and
    // windows are sized for it, so the stump is a giant. The uncanny decor is
    // spelled out as husks, cocoons, webbing and honeycomb because the gate
    // refuses "insect" and its kin -- an image model paints the noun -- and
    // the same rule keeps the cosy influence to what is on the stump (round
    // door, warm windows, chimney) with the source unnamed. The top is told
    // it is closed: a stump described by its splintered crown reconstructs
    // hollow, and the world seats one solid.
    sizeM: 4.5,
    aspectRatio: '4:3',
    description:
      'a giant old tree stump about three metres tall and four wide with a home carved into the trunk, the bark ' +
      'thick, deeply fissured and lifting in rough scales over fat gnarled roots flaring out at the base. The top ' +
      'of the stump is closed over by a domed roof of overlapping dead oak leaves layered as shingles, sagging ' +
      'and cobbled together, bound down with vine and weighted with flat stones, and two tall jagged splinters ' +
      'of the trunk stand up through the shingles as spires, the taller spire with one small round window set ' +
      'in its side. A small round wooden door set deep into the front of the trunk between two roots, made of ' +
      'warped planks bound with vine and hung on hinges of bent twig, a door knocker of two curved chitin ' +
      'mandibles, a worn stone step. Two small round windows of many tiny wax honeycomb cells glowing warm ' +
      'amber from inside. A crooked ramshackle chimney of stacked flat stones and packed mud jutting out ' +
      'sideways from the flank of the stump, bound with vine and leaning. A huge single dead oak leaf stretched ' +
      'over the entrance as a tarp awning, held up on two thick crooked branch poles lashed with twine, its ' +
      'edges curling and torn. The outside built up and decorated with forest debris: acorn caps, pine cones, ' +
      'bark shingles and bundled straw patched onto the walls, drifts of damp moss and dead leaves on every ' +
      'ledge, strings of empty pale moulted chitin husks hung along the eaves, papery grey cocoons and silk ' +
      'webbing bunched in the crooks of the roots, a cluster of pale waxy eggs tucked in a papery nest beside ' +
      'the door, a few shed translucent wings pinned over the doorway, wet dark staining and lichen on the ' +
      'shaded side',
  },
]

export const propById = (id) => PROPS.find((p) => p.id === id) ?? null
