// ---------------------------------------------------------------------------
// Starter roster for gen-prop.html. Each entry's `description` feeds
// prop-prompt.mjs; `sizeM` is the prop's real longest dimension in metres, the
// scale the world will place it at; `category` is the world layer it is for
// (which renderer will eventually scatter it), and nothing else keys on it.
//
// `texPx` is the side of the colour map a prop SHIPS with and the bench
// previews it at that size. Absent means TEX_PX_MAX; a mushroom is a few
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
]

export const propById = (id) => PROPS.find((p) => p.id === id) ?? null
