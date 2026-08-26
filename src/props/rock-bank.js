import { buildRock, rockClass, ROCK_LADDERS, ROCK_DEFAULTS } from './rock.js'
import { ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: twenty-five named shapes, the tints they wear, and
// the baked geometry for every tier of every one of them.
//
// This file is the SINGLE SOURCE OF TRUTH for what a rock in this world can
// look like. /gen-rock imports ROCK_VARIANTS as its preset list and TINTS as
// its palette, and the world's scatter imports the same two, so a shape signed
// off on the bench is bit-identical to the one that ships. Editing the table
// below is the intended way to change the world's rocks; there is nowhere else
// to edit.
//
// Same policy as tree-bank.js and fern-bank.js: NO OFFLINE BAKE STEP. The bank
// is built at construction, handed to BatchedMesh.addGeometry(), and disposed.
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
// Every variant is tagged with the environments it belongs in, and the scatter
// picks from the tagged subset. A variant may appear in more than one -- a
// pebble is underfoot everywhere -- but the tag list is what stops a river
// shingle turning up on a summit.
//
// A variant may ALSO carry `site`, which is a demand on the local relief rather
// than on the environment: 'foot' for the base of a steep face, 'brow' for the
// lip above one. Site-tagged variants are held out of the ordinary pools
// entirely -- see RockBed._relief and SITES below.
//
// SIZE IS AUTHORED, NOT SCATTERED. `size` is the largest horizontal extent in
// metres and it decides the LOD ladder (see rockClass), so it is part of the
// variant rather than something the scatter rolls. The scatter varies rocks by
// yaw, by a modest non-uniform scale and by tint; a rock that needed to be four
// times bigger is a different variant, because at four times the size it needs
// a different ladder anyway.
// ---------------------------------------------------------------------------

// --- the environment palette ------------------------------------------------
//
// A TINT IS A DESTINATION, NOT A MULTIPLIER. Every hex below is the sRGB colour
// the tile is supposed to AVERAGE OUT TO once the tint has been applied, and the
// multiplier that gets there is derived (TINT_GAIN). That inversion is the whole
// point of this block, so it is worth saying why it was made.
//
// The old table was a set of multipliers against a tile deliberately graded pale
// and near-neutral (mean 142/255, saturation 0.04), so every entry could be a
// reduction and still land on stone. public/rocks/stone.png is now a real
// photograph of granite: mean 93/84/76, luma 88/255, saturation 0.19. Multiply
// THAT by 0x6e747c and the rock is not basalt, it is mud. Worse, a multiply can
// only ever push a warm tile warmer, so half the palette was unreachable.
//
// Dividing by the tile's measured mean fixes both. The gain white-balances the
// photograph out of the way (the blue channel is the weakest, so it gets the
// largest gain) and lands on the authored colour, and because BatchedMesh's
// colour texture is FLOAT (see setPropFadeAt's own guard in material.js) a gain
// above 1.0 is storable and BRIGHTENS. Nothing here darkens the tile: the
// smallest gain in the table is 1.39 and check-rocks.mjs asserts it.
//
// The cost of a gain is highlight clipping, and the ceiling on how bright a tint
// may be authored comes from there rather than from taste. The tile's 99th
// percentile sits at 2.0-2.3x its own mean per channel, so a tint whose gain
// tops about 5.7 starts blowing out more than a percent of its pixels -- which
// is why there is no white marble in the list and why 'frost grey' stops where
// it does. check-rocks.mjs measures the clipped fraction and holds it under 2%.

// The tile's own linear-space channel means, from textures.js because the cliff
// terrain divides by the same three numbers for the same reason. Every gain
// below is a ratio against them, so if someone drops in a new tile and does not
// update them the whole palette silently drifts; check-rocks.mjs re-measures the
// shipped PNG and fails if they do.
// (imported at the top of the file as ROCK_TILE_MEAN)

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

// WHICH TINTS AN ENVIRONMENT CYCLES THROUGH. A variant's own `tint` is its
// portrait colour -- what /gen-rock shows you when you pick it off the dropdown
// -- and it is deliberately NOT what the world uses. One tint per variant means
// every mosshump in the wood is the same green and the eye reads the repeat
// instantly; the scatter rolls this list instead, so a slope of scree carries
// four or five stone colours and stops looking like one object stamped out.
//
// Ordered most to least common, but the roll is uniform: the weighting is done
// by how often a colour appears in the list, which is easier to read and easier
// to retune than a table of probabilities.
export const ENV_TINTS = {
  river: [0, 3, 1, 4, 0, 6, 3],
  forest: [0, 6, 5, 1, 0, 4, 6, 2],
  cliff: [0, 4, 3, 5, 1, 2, 0, 6],
  peak: [2, 3, 7, 0, 2, 1, 7],
}

// --- the twenty-five --------------------------------------------------------
//
// ORDERED BY SHAPE FAMILY, NOT BY ENVIRONMENT, and that reorganisation is the
// point rather than a tidy-up. Grouping by place hid the real problem: the
// `peak` tag had been handed to three tapered towers and nothing else, so above
// the treeline the entire world was buttress, spire and fang -- three spikes and
// a scree chip. Grouped by SHAPE it is obvious at a glance when a family is
// thin, which is the failure mode that matters.
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
// `tint` is an index into TINTS; `envs` is where it may be placed; `site` is
// the optional relief a variant demands -- 'foot' for the base of a steep face,
// 'brow' for the lip above one. A variant with a `site` is held OUT of the
// ordinary environment pools and only ever appears where the relief matches;
// see RockBed._relief. Everything else ignores the ground beyond its env tag.
//
// LUMPS RUN 0.4 TO 0.75 NOW, against 0.14-0.30 before. The old table was tuned
// against a ROCK_DEFAULTS of 0.55 that no variant ever used, so every shipped
// rock was far smoother than the bench's own opening view -- boulders were
// ellipsoids with a few flat cuts in them. The default is 0.7 and the table now
// sits around it, which is what makes these read as irregular rather than as
// faceted spheres.
//
// EVERY VARIANT IS SMOOTH-SHADED, and that is a correction. The table used to
// run `smooth` from 0 to 0.35 on everything big, on the theory that a boulder is
// a broken thing and broken things are faceted. What that actually produced was
// a polyhedron: a T80 shell flat-shaded is eighty visible planes, and no amount
// of stone texture over the top hides eighty planes once the light moves across
// them. Snow made it unmissable, because snow replaces the albedo with a near
// flat white and leaves the shading term as the only thing left to look at.
//
// The faceted look those low numbers were reaching for does not come from
// `smooth` at all -- it comes from the CUT PLANES, and rock.js shades a cut face
// flat no matter how high `smooth` goes (a face whose three vertices were all
// pinned by the same plane is genuinely planar, so flat is not a stylisation
// there, it is correct). So the fracture reads exactly as before and only the
// unbroken shell between the fractures rounds off, which is what weathering
// does to it. Nothing below drops under 0.85; the variation that is left is
// between 'water-worn' and 'freshly split', not between smooth and blocky.
export const ROCK_VARIANTS = {
  // --- A. rounded: glacial and water-worn -----------------------------------

  // The smallest thing in the world with its own geometry. One T8 octahedron,
  // eight triangles, no LOD at all -- which is the entire reason it is allowed
  // to exist in the numbers it does.
  pebble: { size: 0.11, squash: 0.68, elongate: 1.4, lumps: 0.55, lumpFreq: 1.9, grain: 0.12, smooth: 0.96, cuts: 2, cutDepth: 0.5, cutBias: 0, sit: 0.3, texRepeat: 1.4, tint: 0, envs: ['river', 'forest', 'cliff', 'peak'] },

  // The river cobble: rounded on every axis because it has been rolled. Two
  // tiers, T20 and T8, and it is culled while the T8 is still readable.
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

  // The workhorse forest obstacle, and now BLOCKY rather than round -- ten cuts
  // at 0.82 instead of four at 0.6. Rounding was the old recipe for "weathered",
  // but weathering rounds the EDGES of a broken block, it does not put the block
  // back into a sphere. Tagged `peak` as well: a glacially scoured summit is
  // covered in exactly this, and the peak needed something that is not a spike.
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
  shingle: { size: 0.5, squash: 0.3, elongate: 1.8, lumps: 0.45, lumpFreq: 1.9, grain: 0.06, smooth: 0.94, cuts: 4, cutDepth: 0.78, cutBias: -0.9, sit: 0.44, openBottom: 1, texRepeat: 2.0, tint: 3, envs: ['river'] },

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
  // EQUIDIMENSIONAL, and that is the correction. Frost splits rock along joints
  // in every direction at once, so a talus block is a lumpy die, not a shard.
  // The old `scree` carried taper 0.2 and squash 0.55, which is a miniature
  // spire, and it was the ONLY mid-size shape the peak had.

  // Angular chips: the fines that collect at the foot of anything that breaks.
  grit: { size: 0.14, squash: 0.52, elongate: 1.6, lumps: 0.4, lumpFreq: 2.4, grain: 0.06, smooth: 0.88, cuts: 5, cutDepth: 0.9, cutBias: 0.2, sit: 0.24, texRepeat: 1.2, tint: 2, envs: ['cliff', 'peak', 'river'] },

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
  // THE FIX FOR THE PEAK. Both of these were spires and are not any more, and
  // the single number that did it is `taperPow`. Above about 1.5 the narrowing
  // holds off through the body and then bites near the top -- shoulders, then a
  // tooth. Near 1.0 it narrows evenly the whole way and arrives at a real flat
  // crown, which is what a jointed column actually weathers into.

  // A squat tor: something you could stand on top of. Strata bands up the height
  // do the rest of the work of saying "this is bedrock, not a boulder".
  tor: { size: 4.2, squash: 1.35, elongate: 1.2, lumps: 0.55, lumpFreq: 1.2, grain: 0.09, smooth: 0.87, cuts: 10, cutDepth: 0.86, cutBias: 0.6, taper: 0.42, taperPow: 1.05, foot: 0.5, strata: 4, strataAmp: 0.07, sit: 0.26, texRepeat: 3.0, tint: 3, envs: ['peak', 'cliff'] },

  // The giant protruding from a cliff face: tall, heavy, cut on near-vertical
  // planes, with a flared base so it looks anchored in the slope rather than
  // balanced on it. taperPow was 1.8 and is now 1.1, so the top is a broken-off
  // crown rather than a horn.
  buttress: { size: 6.5, squash: 1.5, elongate: 1.3, lumps: 0.58, lumpFreq: 1.2, grain: 0.09, smooth: 0.86, cuts: 9, cutDepth: 0.86, cutBias: 0.6, taper: 0.34, taperPow: 1.1, foot: 0.55, strata: 3, strataAmp: 0.05, shards: 2, shardSpread: 0.55, shardDrop: 0.42, shardTilt: 0.3, sit: 0.26, texRepeat: 3.4, tint: 2, envs: ['cliff', 'peak'] },

  // --- F. pinnacle ----------------------------------------------------------

  // The one genuinely pointed rock in the bank, and it is `peak` only. It used
  // to have a 10.7 m twin called `fang` and the two of them, plus the buttress,
  // WERE the summit -- three tapered towers and nothing else above the treeline.
  // The fang is gone and this one is blunter (taper 0.85 -> 0.68, taperPow
  // 2.2 -> 1.7) because a pinnacle only reads as one when it is the exception.
  //
  // AND IT IS TAGGED `brow`, which is the rest of that same argument. Height
  // alone is the wrong test for a pinnacle: an elevation gate puts spires evenly
  // across every high slope, and an even scatter of pointed rocks is a field of
  // fangs however few of them there are. What a spire wants is the ground that
  // FALLS AWAY below it -- a summit, a crag top, the lip of an outcrop -- which
  // is exactly what RockBed._relief calls a brow. The tag does two jobs at once:
  // it pulls the spire out of the ordinary peak pool (so the open slopes get
  // buttress, tor and whaleback and nothing sharp at all) and it concentrates
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

  // The small one, at T20/T8: about a dozen triangles of rock breaking the
  // surface of a gravel bed.
  cap: { size: 0.75, squash: 0.5, elongate: 1.35, lumps: 0.62, lumpFreq: 1.8, grain: 0.08, smooth: 0.95, cuts: 3, cutDepth: 0.5, cutBias: -0.3, sit: 0.52, openBottom: 1, texRepeat: 1.6, tint: 0, envs: ['river', 'cliff'] },

  // The larger one: a flat plate of bedrock showing through, for the middle
  // distance where a `cap` has already been culled.
  capslab: { size: 2.0, squash: 0.34, elongate: 1.55, lumps: 0.55, lumpFreq: 1.6, grain: 0.07, smooth: 0.93, cuts: 5, cutDepth: 0.72, cutBias: -0.85, taper: -0.12, taperPow: 1.2, sit: 0.5, openBottom: 1, texRepeat: 2.4, tint: 3, envs: ['river', 'cliff'] },
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

/** How many tiers every variant reports, whatever its size class actually ships. */
export const ROCK_BAND_COUNT = 3

/**
 * Bake the whole bank: every variant, at `seeds` shapes each, at every tier its
 * size class ships.
 *
 * Returns `{ shapes, geometries, triangles, bytes }`.
 *
 *   `shapes[i]` is one buildable rock: `{ variant, name, seed, tint, envs,
 *   measured, tiers }`, where `tiers` is ALWAYS ROCK_BAND_COUNT long so a band
 *   index and a shape id are independent lookups.
 *
 *   `geometries` is the de-duplicated list of every geometry the bank made, in
 *   the order they should enter the batch. The caller owns them and MUST
 *   dispose them once BatchedMesh has copied them into its arena.
 *
 * WHY THE TIER LIST IS PADDED BY REPEATING RATHER THAN BY BUILDING. A pebble's
 * ladder is one entry long (ROCK_LADDERS.pebble is [3]) and a crag's is three.
 * Padding the short ones with a SECOND COPY of the coarsest geometry would cost
 * arena space for a mesh that is already there, so the padding repeats the same
 * OBJECT REFERENCE -- `geometries` de-duplicates by identity, the caller's
 * geometry-id map does too, and all three of a pebble's bands resolve to one id
 * and one arena entry. The scatter still gets a rectangular table for free.
 *
 * SEEDS ARE PER (VARIANT, INDEX), not global: adding a seed to the bank must
 * not reshape the rocks already in it, for the same reason tree-bank.js gives
 * one seed per variant rather than one per species.
 */
export function buildRockBank({ seed = 1, seeds = 3 } = {}) {
  if (!Number.isInteger(seeds) || seeds < 1) throw new Error(`buildRockBank: seeds must be a positive integer, got ${seeds}`)

  const shapes = []
  const geometries = []
  let triangles = 0
  let bytes = 0

  ROCK_NAMES.forEach((name, variant) => {
    const v = ROCK_VARIANTS[name]
    const ladder = ROCK_LADDERS[rockClass(v.size)]
    if (!ladder) throw new Error(`buildRockBank: ${name} has no ladder for size ${v.size}`)

    for (let s = 0; s < seeds; s++) {
      const rockSeed = seed + variant * 9173 + s * 101
      const built = ladder.map((tier) => {
        const g = buildRock({ ...rockParams(name, rockSeed), tier })
        geometries.push(g)
        triangles += g.userData.rock.triangles
        bytes += geometryBytes(g)
        return g
      })
      // Pad by REFERENCE, never by building -- see the note above.
      const tiers = built.slice(0, ROCK_BAND_COUNT)
      while (tiers.length < ROCK_BAND_COUNT) tiers.push(built[built.length - 1])

      shapes.push({
        variant,
        name,
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
        measured: built[0].userData.rock.measured,
        tiers,
      })
    }
  })

  return { shapes, geometries, triangles, bytes }
}
