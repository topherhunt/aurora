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
      'an old rotting tree stump about knee high, cut off jagged and splintered at the top with one tall shard of ' +
      'trunk still standing up from the rim, thick fissured grey-brown bark peeling away in slabs to show punky ' +
      'orange-brown wood beneath, a hollow crumbling core, fat exposed roots flaring out at the base like knuckles, ' +
      'patches of bright green moss on the shaded side',
  },
  {
    id: 'log-fallen',
    label: 'Fallen Log',
    category: 'deadwood',
    sizeM: 3.2,
    aspectRatio: '16:9',
    description:
      'a long fallen rotting log lying on its side, thick and slightly bowed with a fat broken root end and a ' +
      'splintered narrow end, bark sloughed off in long patches to show weathered silver-grey wood with deep ' +
      'cracks, one hollow end you could look into, two short broken branch stubs sticking up, moss and small ' +
      'shelf fungi along the damp underside',
  },
  {
    id: 'snag-standing',
    label: 'Standing Snag',
    category: 'deadwood',
    sizeM: 4.5,
    aspectRatio: '3:4',
    description:
      'a dead standing tree trunk with no leaves, broken off jagged at the top at about twice a person\'s height, ' +
      'leaning slightly, bleached silver-grey bare wood with long spiralling cracks, a few short snapped-off branch ' +
      'stubs, dark woodpecker holes, ragged strips of bark still clinging near the flared base',
  },
  {
    id: 'mushroom-agaric',
    label: 'Fly Agaric Cluster',
    category: 'mushroom',
    sizeM: 0.3,
    texPx: TEX_PX_SMALL,
    aspectRatio: '4:3',
    description:
      'a cluster of three fly agaric mushrooms growing from one patch of ground, one big and tall with a wide ' +
      'domed scarlet-red cap flecked with raised creamy-white warts, two smaller ones at its foot with rounder ' +
      'caps, thick white stems with a ragged skirt ring, the caps tilted at different angles so the cluster is ' +
      'lopsided and full of character',
  },
  {
    id: 'mushroom-bolete',
    label: 'Fat Bolete',
    category: 'mushroom',
    sizeM: 0.25,
    texPx: TEX_PX_SMALL,
    aspectRatio: '4:3',
    description:
      'a single fat bolete mushroom, a bulging chestnut-brown cap like a bread roll sitting on a swollen barrel ' +
      'of a stem that is wider than it is tall, pale yellow-cream underside, a small nibble taken out of one edge ' +
      'of the cap, squat and comically heavy',
  },
  {
    id: 'mushroom-tuft',
    label: 'Honey Fungus Tuft',
    category: 'mushroom',
    sizeM: 0.3,
    texPx: TEX_PX_SMALL,
    aspectRatio: '4:3',
    description:
      'a dense tuft of a dozen honey-coloured mushrooms of different heights crowding up from one clump, thin ' +
      'tan stems, small tawny caps with darker centres, the tallest leaning outward like a bouquet, growing out ' +
      'of a small chunk of dark rotten bark',
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
      'a cave entrance as one freestanding chunk of rocky hillside, a dark arched opening about a person and a ' +
      'half tall framed by heavy layered grey-brown boulders and a slab lintel, the sides sloping back into a ' +
      'rough mound of rock and packed earth, tufts of moss and a few loose stones at the threshold, the inside ' +
      'of the opening dark',
  },
]

export const propById = (id) => PROPS.find((p) => p.id === id) ?? null
