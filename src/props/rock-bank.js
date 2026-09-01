import { buildRock, ROCK_TIERS, ROCK_DEFAULTS } from './rock.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER, ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: twenty-five named shapes, the tints they wear, the
// baked geometry for every mesh tier of every one of them, and the billboard
// card that stands in for all of them past the last mesh band.
//
// SINGLE SOURCE OF TRUTH for what a rock here can look like. /gen-rock and the
// world's scatter import the same ROCK_VARIANTS and TINTS, so a shape signed off
// on the bench is bit-identical to the one that ships. Edit the table below;
// there is nowhere else to edit.
//
// Same policy as tree-bank.js and fern-bank.js: NO OFFLINE BAKE STEP. Built at
// construction, handed to BatchedMesh.addGeometry(), disposed. The CARD tier is
// the one thing that arrives in two pieces -- quads at construction, pixels once
// the renderer exists. See THE CARD below.
//
// WHERE A SHAPE MAY STAND. Four environments make demands a generator can
// answer, and the table below is grouped by SHAPE FAMILY while these decide
// which families are allowed where:
//
//   RIVER   flat, wide, sunk, worn smooth. A riverbed is a crowd, so these have
//           to tile without every rock reading as a separate object, which
//           means low silhouettes and no drama.
//   FOREST  obstacles and line-of-sight breakers, at head height and above.
//           Weathered rather than freshly split: nothing has broken these since
//           the ice went.
//   CLIFF   things that stick OUT of a slope and give it a third dimension.
//           Bedding cuts, so they read as a layer of the rock behind them.
//   PEAK    scoured and frost-broken. Columns with blunt crowns, jointed blocks
//           the ice left behind, talus. NOT a forest of teeth: the pinnacle is
//           one entry out of twenty-five and it is the only one tagged here that
//           comes to a point.
//
// Every variant is tagged with the environments it belongs in and the scatter
// picks from the tagged subset. A variant may appear in more than one; the tag
// list is what stops a river shingle turning up on a summit.
//
// A variant may ALSO carry `site`, a demand on local relief rather than on
// environment: 'foot' for the base of a steep face, 'brow' for the lip above
// one. Site-tagged variants are held out of the ordinary pools entirely -- see
// RockBed._relief and SITES below.
//
// SIZE IS AUTHORED, NOT SCATTERED. `size` is the largest horizontal extent in
// metres, part of the variant rather than something the scatter rolls: the
// proportions that read at 30 cm are not the ones that read at 1.2 m, so a rock
// four times bigger is a different variant. The scatter varies yaw, a modest
// non-uniform scale and tint. Size does not pick LOD tiers -- every rock ships
// all three and size sets only the DISTANCES between them (rock.js,
// ROCK_LOD_AT).
// ---------------------------------------------------------------------------

// --- the environment palette ------------------------------------------------
//
// A TINT IS A DESTINATION, NOT A MULTIPLIER. Every hex below is the sRGB colour
// the tile should AVERAGE OUT TO once tinted; the multiplier that gets there is
// derived (TINT_GAIN) by dividing by the tile's measured mean.
//
// Multipliers only work against a tile graded pale and near-neutral.
// public/rocks/stone.png is a photograph of granite (mean 93/84/76, saturation
// 0.19): multiply THAT by 0x6e747c and the rock is mud, and since a multiply can
// only push a warm tile warmer, half the palette is unreachable. Dividing
// white-balances the photograph out of the way instead, and because
// BatchedMesh's colour texture is FLOAT (see the fade-slot guards in
// material.js) a gain above 1.0 is storable and BRIGHTENS. Nothing here darkens
// the tile; the smallest gain is 1.39 and check-rocks.mjs asserts it.
//
// The ceiling on tint brightness is highlight clipping, not taste: the tile's
// 99th percentile sits at 2.0-2.3x its own mean per channel, so a gain past
// about 5.7 blows out more than a percent of its pixels. That is why there is no
// white marble and why 'frost grey' stops where it does. check-rocks.mjs holds
// the clipped fraction under 2%.

// ROCK_TILE_MEAN is the tile's own linear-space channel means, imported from
// textures.js because the cliff terrain divides by the same three numbers. Every
// gain is a ratio against them, so a new tile with stale means silently drifts
// the whole palette; check-rocks.mjs re-measures the shipped PNG and fails.

// sRGB, because that is how a colour picker thinks. What a rock of this tint
// averages out to on screen before lighting.
export const TINTS = [
  ['granite', 0x9c9a96, 'the neutral one. Mid grey, a hair warm, what most stone is'],
  ['pale granite', 0xb3b0a9, 'the same rock bleached by a few thousand years of sun'],
  ['basalt', 0x7a8089, 'cold grey-blue and the darkest in the list. Peaks, scree, ice-scoured rock'],
  ['slate', 0x8d959d, 'blue-grey, lighter and flatter than basalt. Bedding planes and cliff shelves'],
  ['sandstone', 0xb59873, 'warm buff. River bluffs, dry ground, the shelf on a south face'],
  ['ironstone', 0x96755c, 'rust-brown. The one that reads as iron in the rock rather than as dirt'],
  ['lichen', 0x8e9678, 'green-grey. A forest boulder that has not moved in a century'],
  ['frost grey', 0xa9aeb4, 'pale and cold, for above the snow line'],
]

/**
 * Linear-space per-channel multipliers, derived. This is what actually goes into
 * BatchedMesh.setColorAt -- the shader's `diffuseColor.rgb *= vColor` happens in
 * linear, so the conversion has to happen here rather than at the call site.
 */
export const TINT_GAIN = TINTS.map(([, hex]) => {
  const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return [
    srgbToLinear(((hex >> 16) & 255) / 255) / ROCK_TILE_MEAN[0],
    srgbToLinear(((hex >> 8) & 255) / 255) / ROCK_TILE_MEAN[1],
    srgbToLinear((hex & 255) / 255) / ROCK_TILE_MEAN[2],
  ]
})

/** The four places a rock can belong. A variant carries a subset. */
export const ENVIRONMENTS = ['river', 'forest', 'cliff', 'peak']

// WHICH TINTS AN ENVIRONMENT CYCLES THROUGH. A variant's own `tint` is only its
// portrait colour for /gen-rock; the world rolls this list instead, because one
// tint per variant makes every mosshump in the wood the same green and the eye
// reads the repeat instantly.
//
// The roll is uniform and the weighting is done by repeating a colour in the
// list -- easier to read and retune than a table of probabilities.
export const ENV_TINTS = {
  river: [0, 3, 1, 4, 0, 6, 3],
  forest: [0, 6, 5, 1, 0, 4, 6, 2],
  cliff: [0, 4, 3, 5, 1, 2, 0, 6],
  peak: [2, 3, 7, 0, 2, 1, 7],
}

// --- the twenty-five --------------------------------------------------------
//
// ORDERED BY SHAPE FAMILY, NOT BY ENVIRONMENT. Grouping by place hides a thin
// family: the `peak` tag once held three tapered towers and a scree chip, and
// nothing about that list said so. Grouped by shape it is obvious at a glance,
// which is the failure mode that matters.
//
// Eight families, each a distinct way rock ends up sitting on a hillside and
// each with its own parameter signature:
//
//   A ROUNDED     glacial till, river cobble. Convex, no planar faces at all.
//                 cutBias 0, shallow cutDepth, and LUMPS DOING THE WORK.
//   B JOINTED     granite broken on two or three joint sets and then weathered.
//                 Many cuts, deep, unbiased, no taper. Boxy but never square.
//   C BEDDED      flagstone, shingle, cliff shelves. cutBias hard negative,
//                 squash under 0.45, and now open-bottomed.
//   D SHATTERED   frost-riven talus. Sharp, EQUIDIMENSIONAL, no long axis and no
//                 taper -- a scree chip that tapers is a miniature spire, which
//                 is what the old `scree` was.
//   E TOR         a jointed column with a BLUNT, near-flat crown. taper carries
//                 the narrowing, taperPow stays near 1 so it narrows evenly
//                 instead of holding off and then biting.
//   F PINNACLE    genuinely pointed. taper past 0.65 AND taperPow past 1.5. One
//                 entry, tagged `peak` only, because a mountain that is all
//                 teeth reads as a stage set.
//   G OUTCROP     bedrock through the soil: big footprint, low, asymmetric,
//                 NEGATIVE taper so it widens as it rises.
//   H CAP         not a landform, a budget. An open-bottomed shell that
//                 protrudes from a bed for a fraction of a closed rock. See
//                 `openBottom` in rock.js for what it costs you.
//
// `tint` is an index into TINTS; `envs` is where it may be placed; `site` is the
// optional relief a variant demands. A variant with a `site` is held OUT of the
// ordinary environment pools; everything else ignores the ground beyond `envs`.
//
// LUMPS RUN 0.4 TO 0.75, around the 0.7 default. Anything near 0.2 gives an
// ellipsoid with a few flat cuts in it -- a faceted sphere, not a rock.
//
// EVERY VARIANT IS SMOOTH-SHADED, nothing under 0.85. Low `smooth` on a big rock
// gives a polyhedron: a flat-shaded T80 shell is eighty visible planes and no
// stone texture hides them once the light moves, least of all under snow, which
// replaces the albedo with flat white and leaves shading as the only cue.
//
// The faceted look low `smooth` reaches for comes from the CUT PLANES instead,
// and rock.js shades a cut face flat however high `smooth` goes -- three
// vertices pinned by one plane really are planar. So fracture reads sharp and
// only the unbroken shell between fractures rounds off, which is what weathering
// does. The variation left is water-worn against freshly split.
export const ROCK_VARIANTS = {
  // --- A. rounded: glacial and water-worn -----------------------------------

  // A river stone at half a metre, which the underfoot bed's 0.7-1.6 scale roll
  // ships between 0.39 m and 0.88 m: a stone you step around. Anything near a
  // tenth of a metre reads as bare gravel with dust on it -- the shapes are
  // there and none of them is big enough to see.
  //
  // SIZE IS AUTHORED HERE, NOT SCALED AT THE INSTANCE, and `texRepeat` moves
  // with it: the tile is sized relative to the rock, not the world (rock.js,
  // point 3), so an instance multiplier would stretch one granite grain to the
  // size of a fist. 1.9 is where the bank's size-to-repeat curve sits at half a
  // metre (`cobble` 0.34 m and `scree` 0.62 m are both 1.8). `sit` needs no such
  // correction -- it is a fraction of the rock's own height.
  //
  // RIVER ONLY. A stone this small still costs a whole instance, and per-frame
  // CPU does not care how few triangles are in it: over forest, cliff and peak
  // it put one every 1.7 m and crowded out the rocks you can see, 41 for every
  // boulder. A stream bed is the one place a carpet of small stones is the real
  // thing rather than litter. Everywhere else the ground gets LAYER.LITTER --
  // one texture, no instances.
  pebble: { size: 0.55, squash: 0.68, elongate: 1.4, lumps: 0.55, lumpFreq: 1.9, grain: 0.12, smooth: 0.96, cuts: 2, cutDepth: 0.5, cutBias: 0, sit: 0.3, texRepeat: 1.9, tint: 0, envs: ['river'] },

  // The river cobble: rounded on every axis because it has been rolled. At a
  // third of a metre across it is on its billboard from 27 m, so the mesh tiers
  // it ships are all spent inside arm's reach and the card carries the rest.
  cobble: { size: 0.34, squash: 0.66, elongate: 1.35, lumps: 0.6, lumpFreq: 1.7, grain: 0.1, smooth: 0.95, cuts: 3, cutDepth: 0.5, cutBias: 0, sit: 0.26, texRepeat: 1.8, tint: 0, envs: ['river', 'forest'] },

  // A low mossy dome. Almost no cuts, almost all smoothing: this is the shape
  // the moss shader flatters most, and it exists to give a wood something soft
  // among all the fractured stone.
  mosshump: { size: 0.9, squash: 0.62, elongate: 1.25, lumps: 0.72, lumpFreq: 1.3, grain: 0.05, smooth: 1, cuts: 2, cutDepth: 0.4, cutBias: -0.5, sit: 0.34, texRepeat: 2.0, tint: 6, envs: ['forest'] },

  // The plain one, and the wood's most common rock by design. No drama at all:
  // knee-to-waist, round-shouldered, three shallow cuts so it is not a pure
  // ellipsoid. A forest floor needs a shape you stop noticing, or every other
  // variant reads as a set piece.
  roundstone: { size: 1.3, squash: 0.7, elongate: 1.28, lumps: 0.68, lumpFreq: 1.45, grain: 0.09, smooth: 0.97, cuts: 3, cutDepth: 0.42, cutBias: -0.2, foot: 0.25, sit: 0.22, texRepeat: 2.0, tint: 0, envs: ['forest', 'river'] },

  // The glacial erratic: a big rounded lump dumped in the open, wider at the
  // top than the bottom, which is the giveaway that nothing eroded it in place.
  erratic: { size: 2.7, squash: 0.86, elongate: 1.15, lumps: 0.74, lumpFreq: 1.4, grain: 0.07, smooth: 0.96, cuts: 3, cutDepth: 0.45, cutBias: -0.4, taper: -0.35, taperPow: 1.4, sit: 0.1, texRepeat: 2.4, tint: 6, envs: ['forest'] },

  // --- B. jointed: broken on joint sets, then weathered ---------------------

  // The workhorse forest obstacle: BLOCKY, ten deep cuts. Rounding is the wrong
  // recipe for "weathered" -- weathering rounds the EDGES of a broken block, it
  // does not put the block back into a sphere. Tagged `peak` too, because a
  // glacially scoured summit is covered in exactly this and the peak needs
  // something that is not a spike.
  boulder: { size: 1.9, squash: 0.78, elongate: 1.28, lumps: 0.62, lumpFreq: 1.6, grain: 0.09, smooth: 0.93, cuts: 10, cutDepth: 0.82, cutBias: 0, foot: 0.2, sit: 0.16, texRepeat: 2.2, tint: 6, envs: ['forest', 'cliff', 'peak'] },

  // "Some more angular and slightly pointed": a jointed block with one raised
  // shoulder. taper 0.28 at taperPow 1.15 narrows it EVENLY to about
  // three-quarters at the crown -- a lean, not a tooth. The distinction between
  // this and a spire is entirely taperPow.
  wedge: { size: 2.2, squash: 0.92, elongate: 1.45, lumps: 0.58, lumpFreq: 1.5, grain: 0.09, smooth: 0.9, cuts: 11, cutDepth: 0.86, cutBias: 0.15, taper: 0.28, taperPow: 1.15, foot: 0.3, sit: 0.18, texRepeat: 2.4, tint: 0, envs: ['forest', 'cliff', 'peak'] },

  // Two blocks that came off the same joint set and settled against each other.
  // Low `shardTilt` and high `shardSink` are what make it read as stacked rather
  // than as scattered: the second mass sits DOWN into the first, square on.
  blockstack: { size: 3.2, squash: 1.0, elongate: 1.3, lumps: 0.5, lumpFreq: 1.25, grain: 0.08, smooth: 0.88, cuts: 12, cutDepth: 0.88, cutBias: -0.1, shards: 2, shardSpread: 0.45, shardDrop: 0.4, shardTilt: 0.12, shardSink: 0.55, foot: 0.28, sit: 0.2, texRepeat: 2.8, tint: 3, envs: ['forest', 'cliff'] },

  // House-sized. A single angular block, not a cluster: at five metres a
  // cluster reads as a pile and this has to read as one thing you cannot climb.
  blockhouse: { size: 5.2, squash: 1.0, elongate: 1.35, lumps: 0.48, lumpFreq: 1.15, grain: 0.07, smooth: 0.88, cuts: 11, cutDepth: 0.86, cutBias: -0.25, foot: 0.3, sit: 0.18, texRepeat: 3.0, tint: 0, envs: ['forest', 'cliff'] },

  // --- C. bedded: flat-lying, and open underneath ---------------------------
  //
  // The three small ones are `openBottom`. They are the flattest things in the
  // bank and the most numerous per square metre, so they are where dropping the
  // buried disc is worth the most -- and they lie flat, bedded deep enough that
  // there is no angle from which the missing underside can be seen. `shelf` is
  // the exception, for the reason given on its own line: it is the only one of
  // the four that gets tilted onto the ground normal, and a tilt is exactly the
  // thing that lets you see up under an open edge.

  // Shingle: a flake lying flat, half buried. The `sit` is the point -- at 0.44
  // most of the rock is under the gravel and what shows is a worn edge.
  //
  // TAGGED FOR THREE GROUNDS, because `pebble` and `grit` are river-only and
  // without it the underfoot bed has one shape in a wood and one above the
  // treeline -- the "same rock rotated" failure check-rocks' POOL_FLOOR catches.
  // A flake needs no water: in a wood it is bedrock through the leaf litter, and
  // frost splits rock along its bedding into plates, so a felsenmeer is mostly
  // shingle. Off `cliff` only, where a loose flake would lie on the face itself.
  // Size here is a LADDER choice, not a world size (like `cap` below, both beds
  // that place a shingle size it in metres): over the 0.8 m boulder line so a
  // shell standing 3 m across a lake floor has a middle tier to fall to instead
  // of dropping straight from T20 to a card.
  shingle: { size: 1.2, squash: 0.3, elongate: 1.8, lumps: 0.45, lumpFreq: 1.9, grain: 0.06, smooth: 0.94, cuts: 4, cutDepth: 0.78, cutBias: -0.9, sit: 0.44, openBottom: 1, texRepeat: 2.0, tint: 3, envs: ['river', 'forest', 'peak'] },

  // Riverbed and shore: flat, wide, sunk halfway, worn smooth. The one shape
  // that has to tile in a crowd without every rock reading as a separate
  // object, which is why it is the least dramatic entry in the table.
  slab: { size: 1.1, squash: 0.28, elongate: 1.6, lumps: 0.5, lumpFreq: 1.8, grain: 0.06, smooth: 0.94, cuts: 4, cutDepth: 0.75, cutBias: -0.9, sit: 0.42, openBottom: 1, texRepeat: 2.4, tint: 3, envs: ['river', 'forest'] },

  // The one you cross a stream on: wide, flat-topped, standing proud enough to
  // stay dry. A bedding cut with `foot` under it, so it does not look balanced.
  stepping: { size: 1.7, squash: 0.44, elongate: 1.3, lumps: 0.55, lumpFreq: 1.5, grain: 0.07, smooth: 0.92, cuts: 5, cutDepth: 0.8, cutBias: -0.75, foot: 0.35, sit: 0.34, openBottom: 1, texRepeat: 2.6, tint: 4, envs: ['river'] },

  // Cliff dressing: a wide low shelf that sticks out of a slope and gives it a
  // third dimension. Bedding-plane cuts, so the top and bottom are flat and the
  // whole thing reads as a layer of the rock behind it. NOT open-bottomed, alone
  // in this family: it is the only one the giants bed tilts 55% onto the ground
  // normal, and on a cliff face that is enough lean to see up under its edge.
  shelf: { size: 3.6, squash: 0.34, elongate: 1.9, lumps: 0.52, lumpFreq: 1.5, grain: 0.08, smooth: 0.88, cuts: 6, cutDepth: 0.82, cutBias: -0.85, taper: -0.15, taperPow: 1.3, strata: 3, strataAmp: 0.07, shards: 2, shardSpread: 0.5, shardDrop: 0.55, shardTilt: 0.15, sit: 0.3, texRepeat: 3.2, tint: 4, envs: ['cliff', 'river'] },

  // --- D. shattered: frost-riven talus --------------------------------------
  //
  // EQUIDIMENSIONAL. Frost splits rock along joints in every direction at once,
  // so a talus block is a lumpy die, not a shard. Any taper here is a miniature
  // spire, and these are the peak's only mid-size shapes.

  // Angular chips at 0.7 m -- the name describes the shape, not the grade:
  // equidimensional and freshly split. Being freshly broken IS this variant's
  // signature, and a chip small enough to ship as eight triangles cannot show
  // it. `texRepeat` sits between `scree` (0.62 m, 1.8) and `cap` (1.6). River
  // only, for the same instance-cost reason `pebble` is, and a gravel bar is
  // made of this at every size.
  grit: { size: 0.7, squash: 0.52, elongate: 1.6, lumps: 0.4, lumpFreq: 2.4, grain: 0.06, smooth: 0.88, cuts: 5, cutDepth: 0.9, cutBias: 0.2, sit: 0.24, texRepeat: 1.7, tint: 2, envs: ['river'] },

  // Freshly broken and sharp, sitting nearly on the surface (`sit` 0.12) because
  // talus rests on talus rather than in soil.
  scree: { size: 0.62, squash: 0.72, elongate: 1.35, lumps: 0.45, lumpFreq: 2.2, grain: 0.05, smooth: 0.86, cuts: 8, cutDepth: 0.9, cutBias: 0.15, sit: 0.12, texRepeat: 1.8, tint: 2, envs: ['cliff', 'peak'] },

  // Mid-size talus, and the first of the two `foot` shapes: nine deep cuts on
  // mixed planes, no taper, barely bedded. Only ever placed in a drift at the
  // base of a steep face.
  talus: { size: 1.6, squash: 0.8, elongate: 1.4, lumps: 0.5, lumpFreq: 1.9, grain: 0.08, smooth: 0.87, cuts: 9, cutDepth: 0.9, cutBias: -0.15, sit: 0.14, texRepeat: 2.0, tint: 2, site: 'foot', envs: ['cliff', 'peak'] },

  // The big end of the same drift: a block that came off the face whole and
  // broke on landing, which is what the second shard is doing at a high
  // `shardSink` -- a fragment lying against its parent, not a satellite.
  rubble: { size: 2.6, squash: 0.86, elongate: 1.3, lumps: 0.55, lumpFreq: 1.6, grain: 0.09, smooth: 0.86, cuts: 10, cutDepth: 0.9, cutBias: 0.25, shards: 2, shardSpread: 0.62, shardDrop: 0.5, shardTilt: 0.4, shardSink: 0.6, sit: 0.14, texRepeat: 2.6, tint: 3, site: 'foot', envs: ['cliff', 'peak'] },

  // --- E. tor: columns with blunt crowns ------------------------------------
  //
  // `taperPow` IS WHAT SEPARATES A TOR FROM A SPIRE. Above about 1.5 the
  // narrowing holds off through the body and then bites near the top --
  // shoulders, then a tooth. Near 1.0 it narrows evenly the whole way to a flat
  // crown, which is what a jointed column weathers into.

  // A squat tor: something you could stand on top of. Strata bands up the height
  // do the rest of the work of saying "this is bedrock, not a boulder".
  tor: { size: 4.2, squash: 1.35, elongate: 1.2, lumps: 0.55, lumpFreq: 1.2, grain: 0.09, smooth: 0.87, cuts: 10, cutDepth: 0.86, cutBias: 0.6, taper: 0.42, taperPow: 1.05, foot: 0.5, strata: 4, strataAmp: 0.07, sit: 0.26, texRepeat: 3.0, tint: 3, envs: ['peak', 'cliff'] },

  // The giant protruding from a cliff face: tall, heavy, cut on near-vertical
  // planes, with a flared base so it looks anchored in the slope rather than
  // balanced on it. taperPow 1.1, so the top is a broken-off crown, not a horn.
  buttress: { size: 6.5, squash: 1.5, elongate: 1.3, lumps: 0.58, lumpFreq: 1.2, grain: 0.09, smooth: 0.86, cuts: 9, cutDepth: 0.86, cutBias: 0.6, taper: 0.34, taperPow: 1.1, foot: 0.55, strata: 3, strataAmp: 0.05, shards: 2, shardSpread: 0.55, shardDrop: 0.42, shardTilt: 0.3, sit: 0.26, texRepeat: 3.4, tint: 2, envs: ['cliff', 'peak'] },

  // --- F. pinnacle ----------------------------------------------------------

  // The one genuinely pointed rock in the bank, `peak` only and deliberately
  // blunt for a pinnacle: it reads as one only while it is the exception.
  //
  // TAGGED `brow`, and height alone is the wrong test. An elevation gate puts
  // spires evenly across every high slope, and an even scatter of pointed rocks
  // is a field of fangs however few there are. A spire wants ground that FALLS
  // AWAY below it -- a summit, a crag top, the lip of an outcrop -- which is what
  // RockBed._relief calls a brow. The tag pulls it out of the ordinary peak pool
  // (open slopes get buttress, tor and whaleback, nothing sharp) and concentrates
  // what is left where a pinnacle is a landmark rather than litter.
  spire: { size: 3.6, squash: 2.2, elongate: 1.1, lumps: 0.5, lumpFreq: 1.15, grain: 0.09, smooth: 0.86, cuts: 9, cutDepth: 0.88, cutBias: 0.9, taper: 0.68, taperPow: 1.7, foot: 0.7, strata: 4, strataAmp: 0.06, shards: 1, sit: 0.3, texRepeat: 2.8, tint: 2, site: 'brow', envs: ['peak'] },

  // --- G. outcrop: bedrock through the soil ---------------------------------
  //
  // Big footprint, low, and NEGATIVE taper so they widen as they rise, which is
  // what says "this continues underground" rather than "this was put here".

  // A split outcrop: two masses that were one until frost got into them, still
  // leaning apart. `shardSpread` high is what opens the cleft -- past about 0.9
  // they stop overlapping and read as two rocks.
  cleft: { size: 3.4, squash: 0.66, elongate: 1.35, lumps: 0.6, lumpFreq: 1.4, grain: 0.08, smooth: 0.9, cuts: 7, cutDepth: 0.82, cutBias: 0.35, shards: 2, shardSpread: 0.8, shardDrop: 0.25, shardTilt: 0.42, shardSink: 0.4, foot: 0.3, sit: 0.24, texRepeat: 2.6, tint: 0, envs: ['forest', 'cliff'] },

  // A roche moutonnee: a long low bedrock hump the ice went over. Wide, smooth,
  // squash under 0.45 so it never becomes a boulder, and the only large variant
  // tagged for all four environments -- scoured bedrock turns up everywhere.
  whaleback: { size: 4.5, squash: 0.5, elongate: 1.75, lumps: 0.62, lumpFreq: 1.3, grain: 0.07, smooth: 0.95, cuts: 5, cutDepth: 0.55, cutBias: -0.55, taper: -0.22, taperPow: 1.2, foot: 0.4, strata: 2, strataAmp: 0.05, sit: 0.3, texRepeat: 3.0, tint: 1, envs: ['forest', 'cliff', 'peak', 'river'] },

  // The brow: a seven-metre jagged outcrop that only ever stands at the TOP edge
  // of a steep face (`site: 'brow'`), where its flat crown makes a lip you can
  // walk out onto. Hard negative cutBias for the flat top, four strata bands for
  // the layered face, and `sit` 0.34 so a third of it is inside the hill.
  lip: { size: 7.0, squash: 0.7, elongate: 1.7, lumps: 0.5, lumpFreq: 1.2, grain: 0.09, smooth: 0.87, cuts: 10, cutDepth: 0.88, cutBias: -0.6, taper: -0.18, taperPow: 1.25, foot: 0.45, strata: 4, strataAmp: 0.07, shards: 2, shardSpread: 0.6, shardDrop: 0.45, shardTilt: 0.1, shardSink: 0.35, sit: 0.34, texRepeat: 3.4, tint: 3, site: 'brow', envs: ['cliff', 'peak'] },

  // --- H. caps: open shells ------------------------------------------------
  //
  // Not landforms. These exist to put stone texture on a riverbed or a cliff
  // face for a third of the triangles a closed rock costs: `sit` past 0.5 buries
  // most of the shape and `openBottom` then throws the buried half away.

  // BOTH ARE TAGGED `peak`, for `shingle`'s reason: bedrock breaking a thin skin
  // of soil is if anything more of a peak thing than a riverbed thing, at any
  // size of plate. The `crust` bed in rocks.js places exactly these two, so
  // dropping either leaves it stamping one shape over a whole environment.

  // THIS SIZE DOES NOT SET HOW BIG A CAP IS IN THE WORLD, which is true of only
  // a handful of entries here. Both beds that place a cap -- `crust` and
  // `underfoot` in v2/render/rocks.js -- ask for a size in METRES and divide it
  // back through the shape's measured width, so this cancels out of the
  // placement. It is not dead: `texRepeat` and the proportions below are
  // authored against it, and it is what /gen-rock draws.
  cap: { size: 1.6, squash: 0.5, elongate: 1.35, lumps: 0.62, lumpFreq: 1.8, grain: 0.08, smooth: 0.95, cuts: 3, cutDepth: 0.5, cutBias: -0.3, sit: 0.52, openBottom: 1, texRepeat: 1.6, tint: 0, envs: ['river', 'cliff', 'peak'] },

  // The larger one: a flat plate of bedrock showing through, for the middle
  // distance where a `cap` has already been culled.
  capslab: { size: 2.0, squash: 0.34, elongate: 1.55, lumps: 0.55, lumpFreq: 1.6, grain: 0.07, smooth: 0.93, cuts: 5, cutDepth: 0.72, cutBias: -0.85, taper: -0.12, taperPow: 1.2, sit: 0.5, openBottom: 1, texRepeat: 2.4, tint: 3, envs: ['river', 'cliff', 'peak'] },
}

/** Variant names, in table order. An index into this is a variant id. */
export const ROCK_NAMES = Object.keys(ROCK_VARIANTS)

/**
 * The relief a variant can demand, on top of its environment. A variant with no
 * `site` stands wherever its `envs` allow; one WITH a site stands nowhere else.
 *
 *   'foot'  steep ground above, gentle ground below -- the base of a face, where
 *           everything that ever fell off it ended up.
 *   'brow'  gentle above, steep below -- the top edge, where bedrock is exposed
 *           by the drop rather than buried by the slope.
 */
export const SITES = ['foot', 'brow']

for (const name of ROCK_NAMES) {
  const v = ROCK_VARIANTS[name]
  if (v.site !== undefined && !SITES.includes(v.site)) {
    throw new Error(`rock-bank: ${name} claims unknown site ${v.site}`)
  }
}

/**
 * The buildRock options for one variant, with the bank's own bookkeeping keys
 * (`tint`, `envs`, `site`) stripped. Those are placement metadata, not shape,
 * and buildRock would silently carry them into `p` where nothing reads them.
 */
export function rockParams(name, seed) {
  const v = ROCK_VARIANTS[name]
  if (!v) throw new Error(`rockParams: no rock variant named ${name}`)
  const { tint, envs, site, ...shape } = v
  return { ...ROCK_DEFAULTS, ...shape, seed }
}

/** Which variant ids may be placed in `env`. Throws on an environment nobody tagged. */
export function variantsFor(env, site = null) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`variantsFor: unknown environment ${env}`)
  if (site !== null && !SITES.includes(site)) throw new Error(`variantsFor: unknown site ${site}`)
  // A site-tagged variant is NOT a member of the ordinary pool. `site: null`
  // means "wherever the relief is nothing in particular", which is most of the
  // world, and a talus block has no business standing there.
  const out = ROCK_NAMES.map((n, i) => {
    const v = ROCK_VARIANTS[n]
    return v.envs.includes(env) && (v.site ?? null) === site ? i : -1
  }).filter((i) => i >= 0)
  if (!out.length) throw new Error(`variantsFor: no rock variant is tagged ${env}${site ? ` / ${site}` : ''}`)
  return out
}

function geometryBytes(geo) {
  let n = geo.index ? geo.index.array.byteLength : 0
  for (const name of Object.keys(geo.attributes)) n += geo.attributes[name].array.byteLength
  return n
}

// ---------------------------------------------------------------------------
// THE CARD: what a rock is past the last mesh band.
//
// A FOURTH TIER, past the coarsest mesh. A card looks worse than a coarse solid
// -- a rock's whole read is the way its facets catch a moving light, and a
// photograph has no facets -- and that is not what decides. A coarse solid costs
// an instance, a matrix, a draw range and a scan slot exactly as a T320 does,
// and the outermost band of a scree slope holds tens of thousands of them. Two
// triangles that keep a grey lump on the hillside beat twenty that do, and both
// beat the hole culling leaves in a talus field.
//
// IT IS A BILLBOARD: ONE QUAD, SPUN IN EVERY DIRECTION. The pinned call is
// `buildImpostorCard(w, h, rockImpostorLayer(name), 1, { upNormal: true,
// spherical: true })` and every argument is load-bearing. A rock is looked DOWN
// on as often as across, so rocks.js is the only bed whose material is built
// with `sphericalBillboard`; `spherical` here tells the card which spin it will
// meet, and the difference is the bounding sphere -- centred on the foot rather
// than around the vertices. Getting that wrong does not misdraw the card, it
// culls a card that is still on screen. One plane is normally the ILLEGAL row of
// buildImpostorCard's table, since a fixed single quad seen along its own plane
// covers no pixels; `upNormal` makes it legal, because a vertical normal is the
// mark material.js's billboardVertex tests before yawing a quad toward the eye.
// Spun, one plane never goes edge-on, and two triangles is the floor -- which a
// rock needs, its far band being the largest population in the world.
//
// `tri` IS DELIBERATELY NOT PASSED. A conifer can spend two corners of its
// photograph because a conifer IS a triangle and the dropped corners hold no
// needles. A rock silhouette is convex and nearly fills its own box in every
// direction, so every corner a triangle throws away is stone: `tri: 'down'` eats
// the foot, which is the one part a distant rock needs in order to read as
// sitting on the ground rather than floating, and `tri: 'up'` eats the crown,
// which on a bedded shape is most of what is above ground at all.
//
// ONE PHOTOGRAPH PER VARIANT. The card stretches a 128x128 slice across whatever
// quad it is on, so a shared photograph only lands undistorted on a shape with
// the SUBJECT'S ASPECT -- and measured over the bank that aspect runs 0.14 on a
// `capslab` to 1.95 on a `spire`, a stretch of 0.29x to 4.00x against a single
// `boulder` subject. The card's world EXTENTS were always each shape's own, so
// what a shared photograph got wrong is the only thing inside that box: the
// outline. A spire and a slab differ in silhouette and in nothing else at 250 m.
//
// THE COST IS 25 ATLAS LAYERS, 1.6 MB, the cheap end of the trade: the same
// per-variant run for buildings would be 148 slices and 9.3 MB, which is why
// card.js photographs a wall-style x roof-kind grid instead. A rock has no such
// grid to collapse along. LAYER.IMPOSTOR_ROCK in textures.js is the base of the
// run and `rockImpostorLayer` indexes it, in ROCK_NAMES order. The per-vertex
// price is smaller than it looks: billboardVertex walks `uBillboardLayers`, so
// 25 entries is 25 step() calls per rock vertex -- under a million ops a frame
// at the measured 30k rock vertices in view.
//
// WHAT CANCELS. The card GEOMETRY is built when the bank is and the PIXELS
// cannot exist until there is a renderer, so the two halves can never check each
// other. Both go through `impostorCardExtents` and neither does the margin
// arithmetic itself (`bakeImpostor` applies it internally, which is why the bake
// is handed a frame and the quad the extents), so the transparent border cancels
// exactly for every shape.
//
// THE TWO FRAMES ARE DIFFERENT NUMBERS, deliberately. The PHOTOGRAPH is framed
// to the subject at its WIDEST (`rockBakeFrame`, at `widestAzimuth`), because a
// photograph that clips has thrown away silhouette it can never recover. The
// QUAD is sized to the MEAN silhouette (`rockCardFrame`), because a quad that
// spins is seen from every bearing -- sizing it to the widest view swelled a
// rock by up to 1.7x at the swap. Not a contradiction: the bake normalises the
// subject to its own frame, so the picture spans the quad's frame whatever that
// is, leaving a horizontal squeeze of `planMean / max(w, d)`. That squeeze is
// the only difference left between the card and the mesh it takes over from.
// ---------------------------------------------------------------------------

/**
 * The world extents the card QUAD is drawn at, from `userData.rock.measured`.
 *
 * WIDTH IS THE MEAN SILHOUETTE, not the box. A billboard spins to face the eye,
 * so its width is what the rock looks like from every bearing at once, and one
 * width makes the mesh-to-card swap free on average: the mean of the mesh's own
 * silhouette over the compass (`meanPlanWidth` in rock.js). The obvious
 * `max(width, depth)` measures 1.23x to 1.71x the mesh silhouette over the bank,
 * worst on the slabs -- a visible swell at the swap. `rockBakeFrame` below is
 * the OTHER framing and is deliberately wider.
 */
export function rockCardFrame(measured) {
  if (!(measured.planMean > 0) || !(measured.height > 0)) {
    throw new Error(`rockCardFrame: need a measured rock, got ${JSON.stringify(measured)}`)
  }
  return { width: measured.planMean, height: measured.height }
}

/**
 * The world extents the PHOTOGRAPH is framed to, which is the widest the subject
 * can present.
 *
 * WIDTH IS THE LARGER HORIZONTAL EXTENT, not the one on the x axis, and not the
 * mean either. The bake camera is put at `widestAzimuth` precisely so the
 * silhouette it captures is the fullest one the rock has; framing that shot to
 * anything narrower than `max(width, depth)` would clip the very thing the
 * azimuth search went looking for.
 */
export function rockBakeFrame(measured) {
  if (!(measured.width > 0) || !(measured.height > 0)) {
    throw new Error(`rockBakeFrame: need a measured rock, got ${JSON.stringify(measured)}`)
  }
  return { width: Math.max(measured.width, measured.depth), height: measured.height }
}

/**
 * The seed every card photograph is taken at, for every variant.
 *
 * A FIXED CONSTANT, not the bank's. `buildRockBank`'s seed is a dial someone may
 * turn, and the photographs must not move under the world when they do: the card
 * geometry is sized from each PLACED shape's measurement while the picture in it
 * comes from this seed, so a drifting subject would silently reproportion every
 * distant rock. Fixing it also means the bench and the world photograph the same
 * rock.
 *
 * One seed for all twenty-five rather than one per variant: what a card must get
 * right is the silhouette FAMILY -- a spire outline against a slab outline -- and
 * seed-to-seed variation inside a variant is small next to that. Which seed is
 * arbitrary.
 */
export const ROCK_CARD_SEED = 1978

/**
 * Which atlas layer holds `name`'s photograph.
 *
 * The run is laid out in ROCK_NAMES order from LAYER.IMPOSTOR_ROCK, and this is
 * the ONLY place that arithmetic happens: the bake writes through it and the
 * card geometry reads through it, so a variant added to the table in the middle
 * cannot leave the two disagreeing about which slice is whose.
 */
export function rockImpostorLayer(name) {
  const i = ROCK_NAMES.indexOf(name)
  if (i < 0) throw new Error(`rockImpostorLayer: no rock variant named ${name}`)
  return LAYER.IMPOSTOR_ROCK + i
}

/**
 * Build one variant's photographic subject and hand back the geometry beside
 * the framing it was measured at, so the bake photographs the very thing that
 * was measured rather than a second build of it. Caller disposes.
 *
 * Photographed at the FINEST tier. The bake resolves to 128 px either way, so a
 * coarse subject would only donate its own faceting to a picture that is meant
 * to stand in for the fine one.
 *
 * OPEN SHELLS ARE PHOTOGRAPHED TOO. A shell has no underside, so its photograph
 * is thin along its own bed plane -- the edge of the card that meets the ground,
 * where missing texels read as a rock hovering. That objection is decisive only
 * for a shared subject, which would hollow the foot of all twenty-five. A `cap`
 * really is a shell bedded into the hillside, so a card whose bottom edge is the
 * shell's rim is the truthful picture of it.
 */
function rockCardSubject(name) {
  const v = ROCK_VARIANTS[name]
  if (!v) throw new Error(`rockCardSubject: no rock variant named ${name}`)
  const geo = buildRock({ ...rockParams(name, ROCK_CARD_SEED), tier: 0 })
  return { geo, frame: rockBakeFrame(geo.userData.rock.measured) }
}

/**
 * Photograph every variant into its own layer of the IMPOSTOR_ROCK run, in
 * place.
 *
 * Call ONCE, after `loadImageLayers()` has resolved -- the subjects wear
 * LAYER.ROCK, and LAYER.ROCK is a PNG that arrives some hundreds of
 * milliseconds into the session. Bake before it lands and the cards are
 * photographs of untextured lumps. Until then the far band draws empty layers,
 * which are fully transparent and so discarded by alphaTest, exactly as the
 * tree, fern and grass cards do.
 *
 * Needs the live renderer, so it cannot live in `buildRockBank` -- that runs in
 * a constructor and in node. Returns one row per variant, for the caller to log.
 */
export function bakeRockImpostors(renderer, texArray) {
  return ROCK_NAMES.map((name) => {
    const { geo, frame } = rockCardSubject(name)
    const azimuth = widestAzimuth(geo)
    const layer = rockImpostorLayer(name)
    const baked = bakeImpostor(renderer, geo, texArray, layer, { ...frame, azimuth })
    geo.dispose()
    return { layer, subject: name, azimuth, ...baked }
  })
}

/**
 * The compass bearing that sees the most of a rock, in radians.
 *
 * PHOTOGRAPH THE SUBJECT AT ITS LARGEST, NEVER FLAT-ON. The shot is framed to
 * `rockBakeFrame` = `max(width, depth)`, so a bake along the rock's SHORT axis
 * prints a narrow silhouette into a wide frame and every distant rock is drawn
 * with transparent margins down both sides -- nothing is misplaced, the far band
 * is just quietly smaller than the mesh it replaced.
 *
 * A hardcoded azimuth is luck, not a property: one shipped subject lands 4 deg
 * off its widest bearing (1.896 m into a 1.900 m frame) and the SAME subject at
 * 113 deg measures 1.399 m, so a new seed could print a card 26% narrow.
 * Searching costs one pass over the subject's vertices, once, at boot.
 *
 * Half a turn is the whole search space: width at bearing `a` equals width at
 * `a + pi`, the projection being onto a line.
 */
function widestAzimuth(geo, steps = 180) {
  const pos = geo.attributes.position.array
  let best = 0
  let bestWidth = -Infinity
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI
    // Screen right for a camera at azimuth `a`, which is the axis the
    // silhouette's width is measured along.
    const rx = Math.cos(a)
    const rz = -Math.sin(a)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      const u = pos[i] * rx + pos[i + 2] * rz
      if (u < lo) lo = u
      if (u > hi) hi = u
    }
    if (hi - lo > bestWidth) {
      bestWidth = hi - lo
      best = a
    }
  }
  return best
}

/**
 * The layers `createPropMaterial({ billboardLayers })` has to be told to spin,
 * exported the way tree-bank, mushroom-bank and grass-bank export theirs so the
 * bank stays the single place that knows which of its geometry is a billboard.
 *
 * A ROCK BATCH THAT DOES NOT PASS THIS IS BROKEN, not merely unspun. The card is
 * ONE plane, and material.js's billboardVertex needs BOTH conditions -- the
 * layer in `uBillboardLayers` and `normal.y` over CARD_UP_MARK -- before it turns
 * a quad. The normal is authored here and always passes; the layer list is the
 * caller's half. Miss it and every distant rock is a fixed single quad with a
 * vertical normal, which is the one row of buildImpostorCard's table where the
 * card VANISHES edge-on rather than just flattening.
 */
export function rockImpostorLayers() {
  return ROCK_NAMES.map(rockImpostorLayer)
}

/**
 * How many tiers every variant reports. The last one is ALWAYS the card, so the
 * mesh ladder gets ROCK_BAND_COUNT - 1 of these -- exactly ROCK_TIERS.
 */
export const ROCK_BAND_COUNT = ROCK_TIERS.length + 1

/** How many of those bands are real meshes. The rest -- one -- is the card. */
export const ROCK_MESH_BAND_COUNT = ROCK_BAND_COUNT - 1

// ---------------------------------------------------------------------------
// NAMING ONE SHAPE, which matters because a name that cannot be typed back into
// the previewer is not a name, it is a number that happens to be printed.
//
// A bank shape is fixed by the bank seed, the variant, and which of that
// variant's `seeds` shapes it is. The bank seed is one number for the whole
// world, so `variant-index` spells everything that distinguishes two shapes.
//
// Printing the raw rockSeed instead is useless even though it is what
// /gen-rock's box takes: `shingle#20402384070` is eleven digits of bank
// arithmetic nobody can read, compare or remember, and two rocks one seed apart
// look nothing like consecutive. `shingle-1` sorts and can be said out loud, and
// /gen-rock resolves it back through `rockShapeSeed`.
// ---------------------------------------------------------------------------

/**
 * The seed `buildRockBank` builds `name`'s `index`-th shape from.
 *
 * The strides are coprime with nothing in particular and simply have to keep
 * (variant, index) pairs from colliding at the bank sizes anyone builds: 9173
 * per variant against 101 per index leaves room for 90 shapes of a variant
 * before one variant's run reaches the next one's.
 *
 * SEEDS ARE PER (VARIANT, INDEX), not global, so adding a seed to the bank does
 * not reshape the rocks already in it -- the same reason tree-bank.js gives one
 * seed per variant rather than one per species.
 */
export function rockShapeSeed(bankSeed, name, index) {
  const variant = ROCK_NAMES.indexOf(name)
  if (variant < 0) throw new Error(`rockShapeSeed: no rock variant named ${name}`)
  if (!Number.isInteger(index) || index < 0) throw new Error(`rockShapeSeed: index must be a non-negative integer, got ${index}`)
  return bankSeed + variant * 9173 + index * 101
}

/** The printable id of one bank shape: `variant-index`, e.g. `shingle-1`. */
export function rockShapeId(name, index) {
  return `${name}-${index}`
}

/**
 * `variant-index` back into its two parts, or null if the string is not one.
 *
 * Deliberately strict about the variant existing, because the one caller is a
 * previewer box someone types into and "no such rock" is the answer it needs.
 */
export function parseRockShapeId(id) {
  const cut = String(id).lastIndexOf('-')
  if (cut <= 0) return null
  const name = id.slice(0, cut)
  const index = Number(id.slice(cut + 1))
  if (!ROCK_NAMES.includes(name)) return null
  if (!Number.isInteger(index) || index < 0) return null
  return { name, index }
}

/**
 * Bake the whole bank: every variant, at `seeds` shapes each, at every tier.
 *
 * Returns `{ shapes, geometries, triangles, bytes }`.
 *
 *   `shapes[i]` is one buildable rock: `{ variant, name, index, seed, tint,
 *   envs, measured, tiers }`, where `tiers` is ALWAYS ROCK_BAND_COUNT long so a
 *   band index and a shape id are independent lookups.
 *
 *   `geometries` is the de-duplicated list of every geometry the bank made, in
 *   the order they should enter the batch. The caller owns them and MUST
 *   dispose them once BatchedMesh has copied them into its arena.
 *
 * EVERY SHAPE SHIPS EVERY TIER. The table is rectangular because it is built
 * rectangular -- 25 variants x 3 seeds x 3 tiers -- which costs about 1.6x the
 * geometry a per-size-class ladder would. What it buys is that a band index
 * means the same thing for every rock in the world, which is what lets
 * ROCK_LOD_AT be one rule instead of a table per bed.
 *
 * THE CARD IS APPENDED LAST, so `tiers[ROCK_BAND_COUNT - 1]` is the card for
 * every shape without exception. Note the two are different kinds of object: a
 * mesh tier carries `userData.rock` and the card carries `userData.impostor`, so
 * anything walking a whole tier table has to ask which it is holding rather than
 * reaching straight for `userData.rock.triangles`.
 *
 * THE CARD IS PER SHAPE, NOT SHARED, and that is forced by world units rather
 * than chosen. A card is a quad measured in metres and the scatter's instance
 * scale is uniform on top of geometry already built at the variant's authored
 * `size`, so one shared quad would draw a `pebble` and a `lip` at the same size
 * on the hillside. Every shape therefore gets its own two triangles, sized from
 * its own `measured` -- which is `ROCK_NAMES.length * seeds` extra arena entries
 * of 4 vertices each, about 150 bytes apiece. The PICTURE on them is the
 * variant's own, one atlas layer per variant; see THE CARD above.
 *
 * Every shape's seed comes from `rockShapeSeed`, which is also what resolves a
 * printed `variant-index` back to a rock in the previewer.
 */
export function buildRockBank({ seed = 1, seeds = 3 } = {}) {
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error(`buildRockBank: seeds must be a positive integer, got ${seeds}`)

  const shapes = []
  const geometries = []
  let triangles = 0
  let bytes = 0

  ROCK_NAMES.forEach((name, variant) => {
    const v = ROCK_VARIANTS[name]

    for (let s = 0; s < seeds; s++) {
      const rockSeed = rockShapeSeed(seed, name, s)
      const tiers = ROCK_TIERS.map((_, tier) => {
        const g = buildRock({ ...rockParams(name, rockSeed), tier })
        geometries.push(g)
        triangles += g.userData.rock.triangles
        bytes += geometryBytes(g)
        return g
      })

      // ...and only then the card, so the last band is the card for every shape.
      // Sized through `rockCardFrame` + `impostorCardExtents` so it agrees with
      // `bakeRockImpostors` about the framing by construction -- see THE CARD.
      const measured = tiers[0].userData.rock.measured
      const ext = impostorCardExtents(rockCardFrame(measured))
      const card = buildImpostorCard(ext.width, ext.height, rockImpostorLayer(name), 1, {
        upNormal: true,
        spherical: true,
      })
      geometries.push(card)
      triangles += card.userData.impostor.triangles
      bytes += geometryBytes(card)
      tiers.push(card)

      shapes.push({
        variant,
        name,
        // Which of this variant's `seeds` shapes it is, 0-based. Together with
        // `name` it is the shape's whole identity within a bank -- see
        // `rockShapeId`, which is what the v2 cursor readout prints.
        index: s,
        seed: rockSeed,
        tint: v.tint,
        envs: v.envs,
        // null for the great majority; see SITES.
        site: v.site ?? null,
        // Whether this shape is an open shell. A scatter has to know, because an
        // open shell must be bedded deeply enough that its RIM is under the
        // ground -- see rock.js's `openBottom` for what you are looking into
        // otherwise.
        openBottom: v.openBottom === 1,
        measured,
        tiers,
      })
    }
  })

  return { shapes, geometries, triangles, bytes }
}
