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
// `texPx` is the side of the colour map a creature SHIPS with, and the bench
// previews it at that size. Absent means TEX_PX_MAX; the small creatures that
// are a few pixels tall in the world are designated 128. Tripo's 2048 stays in
// the work dir either way, so a designation is one edit and a re-ship.
//
// `faceTurnDeg` is the yaw about +Y ship.mjs turns the picked mesh by so it
// faces +X, which is what the world assumes of every shipped creature. Tripo
// hands a mesh back facing wherever its source image looked from, so a pick
// generated off a three-quarter view stands 45 deg off until told otherwise;
// it is a fact about the pick, so a new pick means measuring it again.
//
// Editable in the bench -- this is the starting point for judging whether a
// concept is worth spending art on, not a fixed list.
//
// The village NPCs are appended at the bottom, derived rather than written.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module'
import { describeNordicCharacter, professionsFor } from '../characters/nordic-roster.mjs'

// No generated asset enters the world with a colour map wider than this.
export const TEX_PX_MAX = 512
export const TEX_PX_SMALL = 128

/** The side the creature's map ships at, from its roster entry (or bench-saved meta). Throws on one over the cap. */
export function shipTexPx(entry) {
  const px = entry.texPx ?? TEX_PX_MAX
  if (!(px > 0 && px <= TEX_PX_MAX)) throw new Error(`${entry.id}: texPx ${px} is over the ${TEX_PX_MAX}px cap`)
  return px
}

const ANIMALS = [
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
    // Wingspan, not body length: with the wings spread they are the longest
    // dimension, and sizeM is what places the creature in the world.
    sizeM: 6,
    // Wings, but rigType stays quadruped: Tripo's RIG_TYPES has no draconic
    // skeleton, so the preset rigs the four legs and the wings ride along as
    // unweighted geometry until they get a hand-built hinge.
    //
    // Two things are deliberately absent, both of which produced a reared dragon.
    // "Heraldic" NAMES the rampant pose -- every picture captioned with it is up
    // on its hind legs. And spread wings cannot be shown from side-on, so asking
    // for them rotates the animal front-on, where a quadruped resolves as an
    // upright torso with dangling forelimbs; folded wings cost nothing, since
    // Tripo's quadruped preset never weights them anyway.
    //
    // No real animal is named. Naming one held the stance but dragged the whole
    // surface along with it, so what carries the pose now is repeated positive
    // geometry: weight down, feet flat, body horizontal, head no higher than the
    // shoulders, tail along the ground. That leaves the hide, skull and eyes free
    // to go strange. "One" tail is load-bearing too -- the generator grows a
    // second one otherwise.
    //
    // The build is held between two failures that are both one adjective away:
    // "slender" comes back lanky and dog-legged, "heavy" comes back fat. So the
    // bulk is described as muscle definition rather than as mass, and the legs
    // are kept short by what they are FOR (holding the body low and level) rather
    // than by calling them stout.
    description:
      'a large four-legged dragon at rest, standing four-square and settled with its whole weight down on all four ' +
      'feet, each foot planted flat, the long body carried horizontal and low. Lean and hard-muscled rather than ' +
      'bulky: a deep but narrow chest, long ropes of muscle across the shoulders and haunches, the flanks drawn in ' +
      'tight so the ribs and hip bones show through the hide, four powerful legs short enough to hold the body level ' +
      'and low, ending in long grasping talons, and one long heavy tapering tail lying straight out along the ground ' +
      'behind it. The hide is a close armour of small interlocking plates in matte peat-brown and bog-green under a faint ' +
      'oil-slick iridescence, crusted with pale grey lichen along the spine and shoulders and going soft and cream ' +
      'down the underbelly. A narrow elongated skull carried level on a short thick neck, no higher than the ' +
      'shoulders, crowned with a swept-back fan of thin ridged horns, a fringe of drooping barbels hanging beneath ' +
      'the jaw, no visible ears, and small pale eyes that glow faintly and show no pupil. A crest of dark quill-like ' +
      'spines runs from the back of the skull to the tail tip. A pair of large ribbed membrane wings folded shut ' +
      'along its back like a resting bat, the folded wing arms peaking above the shoulders and the membranes ' +
      'gathered in against the back, well clear of the legs',
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
    id: 'hedge-songbird',
    label: 'Hedge Songbird',
    rigType: 'avian',
    sizeM: 0.14,
    description:
      'a small round-bodied songbird, soft grey-brown plumage over the back and wings, a warm rust-orange ' +
      'breast fading to a pale cream belly, a fine pointed dark beak, a short square tail, thin scaled legs with ' +
      'delicate gripping toes, a bright dark eye ringed in pale feathers',
  },
  {
    id: 'greylag-goose',
    label: 'Greylag Goose',
    rigType: 'avian',
    sizeM: 0.85,
    description:
      'a heavy greylag goose with a thick barrel body, grey-brown barred plumage across the back and wings ' +
      'paling to off-white on the belly, a long thick neck, a stout wedge-shaped orange bill, broad webbed pink ' +
      'feet, dark eyes set high on a rounded head',
  },
  {
    id: 'ironscale-bass',
    label: 'Ironscale Bass',
    rigType: 'aquatic',
    sizeM: 0.35,
    texPx: TEX_PX_SMALL,
    description:
      'a sturdy freshwater bass with a deep round-bodied profile, thick overlapping scales in dull bronze-olive ' +
      'darkening to iron-grey along the back, a spiny dorsal fin held stiffly upright, a blunt underslung jaw ' +
      'and small dark eyes',
  },
  {
    id: 'reed-pike',
    label: 'Reed Pike',
    rigType: 'aquatic',
    sizeM: 0.8,
    texPx: TEX_PX_SMALL,
    description:
      'a long torpedo-shaped predatory fish, narrow and muscular, with a flattened duck-billed snout and a wide jaw ' +
      'lined with fine needle teeth, olive-green flanks broken by pale creamy bars and gold speckling over a white ' +
      'belly, dorsal and anal fins set far back near a broad forked tail, a hard staring eye',
  },
  {
    id: 'glimmerfin',
    label: 'Glimmerfin',
    rigType: 'aquatic',
    sizeM: 0.12,
    texPx: TEX_PX_SMALL,
    description:
      'a small plump endearing fish with rounded jewel-toned scales that catch the light like cut gemstones, facets ' +
      'of amethyst purple and sapphire blue over a softly glowing core, large round curious eyes, delicate ' +
      'translucent fins edged in gold like stained glass',
  },
  {
    id: 'marsh-frog',
    label: 'Marsh Frog',
    rigType: 'none',
    sizeM: 0.09,
    texPx: TEX_PX_SMALL,
    faceTurnDeg: -48,
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
    texPx: TEX_PX_SMALL,
    description:
      'a butterfly with wings spread flat and fully open, upper wings patterned in warm amber and chalk-white with ' +
      'a dark scalloped border and small eye spots, delicate dark veining across translucent wing membrane, ' +
      'a slender furred body and long thin antennae',
  },
  {
    id: 'birch-spider',
    label: 'Birch Spider',
    rigType: 'octopod',
    sizeM: 0.2,
    texPx: TEX_PX_SMALL,
    description:
      'an orb-weaving spider with a rounded bulbous abdomen patterned in cream and grey-brown with a pale cross ' +
      'marking, a small dark cephalothorax, eight long banded legs tapering to fine points, short dense bristles ' +
      'along every joint, a cluster of small glossy black eyes',
  },
  {
    id: 'shore-crab',
    label: 'Shore Crab',
    rigType: 'octopod',
    sizeM: 0.12,
    texPx: TEX_PX_SMALL,
    description:
      'a shore crab with a broad flattened carapace mottled in dark green and mud-brown with paler speckling and a ' +
      'scalloped notched front edge, two heavy asymmetric claws carried forward, eight jointed walking legs tipped ' +
      'in dark points, two small eyes on short stalks raised above the shell',
  },
  {
    id: 'wandering-trader',
    label: 'Wandering Trader',
    rigType: 'biped',
    sizeM: 1.75,
    description:
      'a weathered middle-aged Nordic trader from the medieval era, broad-shouldered and stocky, dressed in ' +
      'authentic early-medieval Norse clothing: a knee-length belted wool tunic with a plain round neckline over an ' +
      'undyed linen undershirt, a heavy fur-trimmed wool cloak fastened at one shoulder with a round bronze brooch, ' +
      'a wide leather belt with hanging drawstring pouches, wool trousers bound from knee to ankle with wrapped ' +
      'leg cloths, soft leather turnshoes, a short greying beard and a fur-lined hood pushed back off the head. ' +
      'No lapels, no buttons, no zips, no sewn pockets, no modern overcoat, no laced shoes',
  },
]

// --- the village -------------------------------------------------------------
//
// The 24 human NPCs are DERIVED from the character pipeline, not retyped into
// it: tools/characters/characters.json is the cast list and nordic-roster.mjs
// writes the bios, and both already drive gen-sheet.html. A second copy of those
// descriptions here would drift from the original the first time a profession's
// gear changes, and the ids match public/characters/<id>/ so the two pipelines
// stay pointed at the same person.
//
// They come in as `biped`, which is what gives them the A-pose clause and the
// 9:16 frame -- the one silhouette in FRAME_BY_RIG that is genuinely tall.

const require = createRequire(import.meta.url)
const { characters } = require('../characters/characters.json')

const NPCS = characters.map(({ id, role, gender, age, professionId, heightM }) => {
  const prof = professionId ? professionsFor(age).find((p) => p.id === professionId) : null
  return {
    id,
    // A child has no trade, so its id is the only name it has: "child-villager-1"
    // becomes "Child Villager 1".
    label: prof ? prof.label : id.replace(/-/g, ' ').replace(/\b[a-z]/g, (ch) => ch.toUpperCase()),
    rigType: 'biped',
    sizeM: heightM,
    // Trailing period stripped: buildCreaturePrompt punctuates the description
    // itself, and gen-sheet's bios end in one where the animal entries do not.
    description: describeNordicCharacter({ role, gender, age, professionId }).description.replace(/\.$/, ''),
  }
})

export const CREATURES = [...ANIMALS, ...NPCS]
