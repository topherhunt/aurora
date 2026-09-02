// ---------------------------------------------------------------------------
// Starter roster for gen-creature.html. Each entry's `description` feeds
// creature-prompt.mjs; `rigType` picks both the prompt's pose clause and the
// skeleton Tripo is asked for, and `sizeM` is the creature's real longest
// dimension in metres (the scale the preview and the world both place it at).
//
// `rigType: 'none'` means the pipeline stops at a static mesh. That is a real
// answer, not a gap: a butterfly's wings want two textured planes and a hinge
// (gen-butterfly.html already does that better and cheaper than a rigged solid
// mesh would), and a frog is small enough that a hop is a whole-body transform.
//
// Editable in the bench -- this is the starting point for judging whether a
// concept is worth spending art on, not a fixed list.
// ---------------------------------------------------------------------------

export const CREATURES = [
  {
    id: 'red-fox',
    label: 'Red Fox',
    rigType: 'quadruped',
    sizeM: 0.7,
    description:
      'a red fox with a slender agile body, rich rust-orange fur over the back and flanks fading to cream on the ' +
      'throat and belly, black stockings on all four legs, a long thick brush tail tipped in white, large pointed ' +
      'ears with dark backs, a narrow pointed muzzle and sharp amber eyes',
  },
  {
    id: 'snow-hare',
    label: 'Snow Hare',
    rigType: 'quadruped',
    sizeM: 0.5,
    description:
      'a mountain hare in winter coat, dense pure-white fur with a faint blue-grey shadow tone, very long ears with ' +
      'black tips, powerful oversized hind legs built for bounding, large dark liquid eyes set wide on the skull, ' +
      'a short round tail',
  },
  {
    id: 'moor-stag',
    label: 'Moor Stag',
    rigType: 'quadruped',
    sizeM: 2.0,
    description:
      'a large red deer stag with a heavy muscular chest, coarse red-brown summer coat darkening along the spine, a ' +
      'shaggy mane at the throat, tall many-branched antlers rising in a wide sweep, long straight legs and dark ' +
      'polished hooves, alert and standing at full height',
  },
  {
    id: 'fen-dragon',
    label: 'Fen Dragon',
    rigType: 'quadruped',
    sizeM: 3.5,
    description:
      'a lean four-legged wingless drake the size of a horse, low-slung and lizard-like, overlapping scales in ' +
      'peat-brown and bog-green with a paler cream underbelly, a long tapering tail, a narrow crocodilian skull ' +
      'with backswept horns and a row of dark spines running from neck to tail tip, clawed feet',
  },
  {
    id: 'fjord-raven',
    label: 'Fjord Raven',
    rigType: 'avian',
    sizeM: 0.6,
    description:
      'a large raven with glossy blue-black plumage catching an oil-slick iridescence, a heavy wedge-shaped beak, ' +
      'shaggy throat hackles, broad fingered wingtips and strong scaled feet with dark curved talons, ' +
      'an intelligent pale eye',
  },
  {
    id: 'ironscale-bass',
    label: 'Ironscale Bass',
    rigType: 'aquatic',
    sizeM: 0.35,
    description:
      'a sturdy freshwater bass with a deep round-bodied profile, thick overlapping scales in dull bronze-olive ' +
      'darkening to iron-grey along the back, a spiny dorsal fin held stiffly upright, a blunt underslung jaw ' +
      'and small dark eyes',
  },
  {
    id: 'marsh-frog',
    label: 'Marsh Frog',
    rigType: 'none',
    sizeM: 0.09,
    description:
      'a plump marsh frog crouched low, damp mottled green and olive skin with darker blotches and a pale cream ' +
      'throat, a bright ridge line down each side of the back, long folded hind legs, splayed webbed feet, ' +
      'large round gold-flecked eyes bulging above a wide mouth',
  },
  {
    id: 'meadow-butterfly',
    label: 'Meadow Butterfly',
    rigType: 'none',
    sizeM: 0.06,
    description:
      'a butterfly with wings spread flat and fully open, upper wings patterned in warm amber and chalk-white with ' +
      'a dark scalloped border and small eye spots, delicate dark veining across translucent wing membrane, ' +
      'a slender furred body and long thin antennae',
  },
  {
    id: 'wandering-trader',
    label: 'Wandering Trader',
    rigType: 'biped',
    sizeM: 1.75,
    description:
      'a weathered middle-aged Nordic trader, broad-shouldered and stocky, wearing a heavy layered wool coat over a ' +
      'linen tunic, a wide leather belt with hanging pouches, sturdy boots and wrapped leggings, a short greying ' +
      'beard and a fur-lined hood pushed back off the head',
  },
]
