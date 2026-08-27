import { buildRock, ROCK_TIERS, ROCK_DEFAULTS } from './rock.js'
import { bakeImpostor, buildImpostorCard, impostorCardExtents } from './impostor.js'
import { LAYER, ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: twenty-five named shapes, the tints they wear, the
// baked geometry for every mesh tier of every one of them, and the billboard
// card that stands in for all of them past the last mesh band.
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
// The CARD tier is the one thing here that arrives in two pieces -- quads at
// construction, pixels once the renderer exists -- for the reason fern-bank.js
// gives at length above its own `fernCardGeometries`. See THE CARD below.
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
// metres, so it is part of the variant rather than something the scatter rolls.
// The scatter varies rocks by yaw, by a modest non-uniform scale and by tint; a
// rock that needed to be four times bigger is a different variant, because the
// proportions that read at 30 cm are not the ones that read at 1.2 m. What it
// no longer decides is which LOD tiers the shape owns: every rock ships all
// three, and how big it ends up in the world sets only the DISTANCES at which
// it steps between them (props/rock.js, ROCK_LOD_AT).
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

  // A river stone, and NOT a speck any longer. It was authored at 0.11 m, and at
  // that size a riverbed read as bare gravel with dust on it: the shapes were
  // there in the numbers the bed asks for, and not one of them was big enough to
  // see. It is 0.55 m now, five times over, and the underfoot bed's own scale
  // roll of 0.7-1.6 puts what actually ships between 0.39 m and 0.88 m -- a stone
  // you step around rather than one you cannot resolve.
  //
  // THE FIVE TIMES IS AUTHORED HERE RATHER THAN APPLIED AT THE INSTANCE, and
  // the reason has outlived the mechanism it was written about. It used to be
  // the LOD ladder: at 0.11 m this variant fell in a `pebble` class that shipped
  // one 8-face octahedron in every band, so scaling the instance matrix by five
  // would have given a half-metre rock drawn as a die at arm's length. Size no
  // longer picks the geometry at all -- every rock ships T180/T80/T20 and the
  // thresholds scale with it -- so what is left is the plainer half: `texRepeat`
  // and the proportions below are authored against THIS number, and an instance
  // multiplier moves neither.
  //
  // `texRepeat` MOVES WITH IT, 1.4 -> 1.9. The tile is sized relative to the rock
  // rather than to the world (rock.js, point 3), so leaving the repeat alone
  // would hand the new stone the old picture stretched five times over: one
  // granite grain the size of a fist. 1.9 is where the bank's own size-to-repeat
  // curve already sits at half a metre -- `shingle` at 0.5 m is 2.0, `cobble` at
  // 0.34 m and `scree` at 0.62 m are both 1.8. `sit` needs no such correction,
  // because it is a fraction of the rock's OWN height and rescales itself.
  //
  // RIVER ONLY, and that argument is untouched by the resize. A stone this small
  // still costs a whole instance, which is per-frame CPU that does not care how
  // few triangles are in it; scattered over forest, cliff and peak it put one
  // every 1.7 m and crowded out the rocks you can actually see, 41 of them for
  // every boulder. A stream bed is the one place a carpet of small stones is the
  // real thing rather than litter, so that is the one place it stays. Everywhere
  // else the ground gets LAYER.LITTER -- one texture, no instances -- see
  // textures.js.
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
  //
  // TAGGED FOR THREE GROUNDS, and the two beyond the shore were added when
  // `pebble` and `grit` went river-only: that left the underfoot bed with a
  // single untagged shape in a wood and a single one above the treeline, which
  // is the "same rock rotated" failure check-rocks' POOL_FLOOR exists to catch.
  // A flake needs no water to explain it. In a wood it is a bit of bedrock
  // showing through the leaf litter, and at the peak it is the characteristic
  // shape up there -- frost splits rock along its bedding into flat plates, so
  // a felsenmeer is mostly shingle. The one ground it stays off is `cliff`,
  // where a loose flake would be lying on the face itself rather than on soil.
  // Size is a LADDER choice here and not a world size, for the same reason as
  // `cap` below: both beds that place a shingle size it in metres. Over the
  // 0.8 m boulder line so a shell standing 3 m across a lake floor has a middle
  // tier to fall to instead of dropping straight from T20 to a card.
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
  // EQUIDIMENSIONAL, and that is the correction. Frost splits rock along joints
  // in every direction at once, so a talus block is a lumpy die, not a shard.
  // The old `scree` carried taper 0.2 and squash 0.55, which is a miniature
  // spire, and it was the ONLY mid-size shape the peak had.

  // Angular chips, and the other half of the riverbed resize: 0.14 m to 0.7 m,
  // five times over on exactly the argument the `pebble` note makes at length.
  // It changes class with it, from the `pebble` ladder to the `cobble` one, so
  // what used to be an eight-triangle chip is a T20 with its cut faces actually
  // visible -- which matters more here than it does on a pebble, because being
  // freshly broken IS this variant's whole signature and eight faces cannot show
  // it. `texRepeat` follows for the same reason, 1.2 -> 1.7, landing between
  // `scree` (0.62 m, 1.8) and `cap` (0.75 m, 1.6) rather than where a 14 cm chip
  // sat. `sit` is a fraction of its own height and needs nothing.
  //
  // At 0.7 m these are no longer the FINES, so the name now describes the shape
  // rather than the grade: angular, equidimensional, freshly split. River only,
  // for the same reason `pebble` is, and it keeps `river` because a gravel bar is
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

  // BOTH OF THESE ARE TAGGED `peak`, for the same reason as `shingle`: bedrock
  // breaking a thin skin of soil is if anything MORE of a peak thing than a
  // riverbed thing. The argument does not depend on the size of the plate, which
  // is why it covers the pair rather than just the small one -- a scoured slab
  // lying on a summit is one of the most characteristic things up there, and the
  // `crust` bed in rocks.js places exactly these two, so leaving `capslab` off
  // `peak` left that bed with a single shape above the treeline and the world
  // stamping one rock out over a whole environment.

  // THIS SIZE NO LONGER SETS HOW BIG A CAP IS IN THE WORLD, and that is worth
  // saying plainly because it is true of only a handful of entries in this file.
  // Both beds that place a cap -- `crust` and `underfoot` in v2/render/rocks.js
  // -- ask for a size in METRES per environment and divide it back through the
  // shape's measured width, so the number here cancels out of the placement
  // entirely. It is not dead: `texRepeat` and the proportions below are authored
  // against it, and it is what /gen-rock draws. It used to pick the LOD ladder
  // as well, which is why it was raised from 0.75 to clear a class boundary that
  // no longer exists -- a cap on a cliff face is 1 to 10 m of rock, and the
  // tiers now step at distances read off THAT rather than off this.
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
// A FOURTH TIER, AND IT IS A REVERSAL. This file, textures.js and the /gen-rock
// bench all argued for a while that a rock's ladder ends at an 8-triangle
// octahedron and then culls: a rock is an opaque lump whose whole read is the
// way its facets catch a moving light, and a photograph has no facets to catch
// anything with. That is still true about what a card LOOKS like, and it is no
// longer the argument that decides. What decides is that a coarse solid costs
// an instance, a matrix, a draw range and a scan slot exactly as a T180 does,
// and the outermost band of a scree slope or a river bar holds tens of
// thousands of them. Two triangles that keep a grey lump on the hillside beat
// twenty that do, and both beat the hole that culling leaves in a talus field.
// The octahedron itself is gone -- it was a generic diamond at any size, and
// once the card existed there was nothing left for it to be better than.
//
// IT IS A BILLBOARD: ONE QUAD, SPUN, AND SPUN IN EVERY DIRECTION. The pinned
// call is `buildImpostorCard(w, h, LAYER.IMPOSTOR_ROCK, 1, { upNormal: true,
// spherical: true })`, and every one of those arguments is load-bearing. A rock
// is looked DOWN on as often as across, so rocks.js is the only bed that builds
// its material with `sphericalBillboard`, and `spherical` here is how the card
// is told which spin it will meet: the shape is the same either way, but the
// bounding sphere a spherical spin needs is the one centred on the foot rather
// than the one around the vertices. Getting that wrong does not misdraw the
// card, it makes the renderer cull a card that is still on screen. One plane is
// normally the illegal
// row of that function's own table -- a FIXED single quad seen along its own
// plane covers no pixels at all -- and `upNormal` is what makes it legal, because
// a vertical normal is the mark material.js's billboardVertex tests to decide
// whether to yaw a quad toward the eye. Spun, one plane never goes edge-on, and
// two triangles is the floor. A rock is the prop that can least afford anything
// above the floor, because its far band is the largest population in the world.
//
// `tri` IS DELIBERATELY NOT PASSED, which would have halved it again. A conifer
// can spend two corners of its photograph because a conifer IS a triangle and
// the corners it drops hold no needles. A rock silhouette is convex and close
// to filling its own box in every direction -- that is what "opaque closed lump"
// means -- so every corner a triangle throws away is stone. Neither orientation
// is survivable: `tri: 'down'` eats the two corners at the FOOT of the card,
// which is where the rock meets the ground and the one part a distant rock needs
// in order to read as sitting there rather than floating, and `tri: 'up'` eats
// the two at the crown, which on a bedded shape is most of what is above ground
// at all.
//
// ONE LAYER, ONE PHOTOGRAPH, TWENTY-FIVE SHAPES -- AND THE LAYER DOES NOT FIT
// THE BANK. This has to be said plainly rather than discovered later. The card
// stretches one 128x128 slice across whatever quad it is put on, so the picture
// only lands undistorted on a shape with the SUBJECT'S ASPECT. Measured over the
// bank (height against the larger horizontal extent, over the three shipped
// seeds of all twenty-five variants), that aspect runs from 0.089 on a `shingle`
// flake to 1.929 on a `spire`, a spread of 21.7x, with a median of 0.439 and a
// mean of 0.504. No single photograph covers that. The subject below is aimed at
// 0.415, the GEOMETRIC middle of that range rather than the arithmetic one,
// because the geometric middle is what balances the two worst cases against each
// other: 4.7x vertically squashed on the flake, 4.6x stretched on the spire.
//
// THAT IS ACCEPTED, AND ONLY BECAUSE THE SUBJECT IS A ROCK. The same stretch on
// a fern would bend every frond and on a pine would fatten the trunk, because
// those silhouettes carry structure the eye can measure against. A rock card is
// a grey blob of granite speckle with a lumpy outline: squash it and it is a
// flatter grey blob, which is what a shingle flake is, and stretch it and it is
// a taller one, which is what a spire is. The card's WORLD EXTENTS are each
// shape's own, so the silhouette a distant rock occupies is right even where
// the picture inside it has been reproportioned. Silhouette is what reads at
// this range; interior texel density is not.
//
// If this ever stops being good enough, the fix is the one fern-bank.js already
// runs -- cut the bank into two or three aspect classes and give each its own
// layer, the way `arch` cuts the ferns -- NOT a fatter card. Allocating layers
// is textures.js's call, so it is written down here rather than done here.
//
// WHAT CANCELS AND WHAT DOES NOT. The card GEOMETRY is built when the bank is,
// and the PIXELS cannot exist until there is a renderer, so the two halves can
// never check each other. Both go through `impostorCardExtents`, and neither
// does the margin arithmetic itself (`bakeImpostor` applies it internally, which
// is why the bake is handed a frame and the quad is handed the extents), so the
// transparent border cancels exactly, for every shape, forever.
//
// THE TWO FRAMES ARE NOT THE SAME NUMBER, and that is deliberate. The
// PHOTOGRAPH is framed to the subject at its WIDEST -- `rockBakeFrame`, taken at
// `widestAzimuth` -- because a photograph that clips has thrown away silhouette
// it can never get back. The QUAD is sized to each shape's MEAN silhouette --
// `rockCardFrame` -- because the quad spins to face you, so whatever it is sized
// to is what the rock looks like from EVERY bearing, and sizing it to the widest
// view made a rock swell by up to 1.7x at the moment it swapped to its card.
// Framing wide and drawing average is not a contradiction: the bake normalises
// the subject to its own frame, so the picture spans the quad's frame whatever
// that is. What does not cancel is the aspect difference argued above.
// ---------------------------------------------------------------------------

/**
 * The world extents the card QUAD is drawn at, from `userData.rock.measured`.
 *
 * WIDTH IS THE MEAN SILHOUETTE and not the box. A billboard spins to face the
 * eye, so its width is what the rock looks like from every bearing at once, and
 * there is exactly one width that makes the swap from mesh to card free on
 * average: the mean of the mesh's own silhouette over the compass. See
 * `meanPlanWidth` in rock.js, which measures it, and `rockBakeFrame` below,
 * which is the OTHER framing and is deliberately wider.
 *
 * Sizing to `max(width, depth)` -- the widest the rock can ever look -- is the
 * obvious thing and is what this used to do. Measured over the bank it put the
 * card at 1.23x to 1.71x the mesh's silhouette, worst on the slabs, so distant
 * stone was systematically too big and the swap was a visible swell.
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
 * Which rock gets photographed for the one impostor layer, and at which seed.
 *
 * `boulder`, and the choice is made on the same grounds fern-bank.js picks the
 * MIDDLE of its axes rather than variant 0. Four things had to be true at once
 * and only this variant manages all four:
 *
 *   MIDDLE ASPECT. `boulder`'s own mean over the shipped seeds is 0.478, which
 *   is the nearest any single variant gets to the middle of the bank without
 *   also having a signature silhouette. Photographing the first entry in the
 *   table instead would make every distant rock in the world a flattened river
 *   stone.
 *
 *   ONE MASS, NO SIGNATURE. A stand-in for twenty-five shapes must be the one
 *   nobody notices. That rules out everything whose silhouette says something
 *   specific: `cleft` sits at almost exactly the median aspect and is useless
 *   here, because it is two masses with a gap between them and the gap would be
 *   photographed into every rock on the far hillside. Same for `spire`'s point,
 *   `blockstack`'s step, and `shelf`'s overhang.
 *
 *   CLOSED. Every open-bottomed variant is a shell with no underside, so its
 *   photograph is thin along its own bed plane -- exactly the edge of the card
 *   that meets the ground, and exactly where a missing row of texels reads as a
 *   rock hovering.
 *
 *   BIG ENOUGH TO GET THERE. The card is the LAST band, so the shapes that
 *   actually wear it at any size on screen are the large ones; a cobble is culled
 *   long before. At 1.9 m across, tagged for three of the four environments and
 *   for no `site` at all, `boulder` is the shape most likely to BE the rock the
 *   card is standing in for.
 *
 * THE SEED IS A FIXED CONSTANT, not the bank's, and it is CHOSEN rather than
 * arbitrary. `buildRockBank`'s seed is a dial someone may turn, and the
 * photograph must not change under the world when they do -- the card geometry
 * is sized from each shape's own measurement and only the picture inside it
 * comes from here, so a drifting subject would silently reproportion every
 * distant rock. Fixing it also means the bench and the world photograph the
 * identical rock.
 *
 * 1978 is the seed whose boulder measures an aspect of 0.4150, which is the
 * bank's geometric middle to four places -- the value argued for in THE CARD
 * above, and the reason to prefer it over the variant's own mean of 0.478. Seeds
 * 1..4000 were searched for it. Re-derive it if the bank's extremes move: it is
 * sqrt(min aspect x max aspect) over every shipped shape.
 */
export const ROCK_CARD_SUBJECT = 'boulder'
export const ROCK_CARD_SEED = 1978

/**
 * Build the subject and hand back the geometry beside the framing it was
 * measured at, so the bake photographs the very thing that was measured rather
 * than a second build of it. Caller disposes.
 *
 * Photographed at the FINEST tier. The bake resolves to 128 px either way, so a
 * coarse subject would only donate its own faceting to a picture that is meant
 * to stand in for the fine one.
 */
function rockCardSubject() {
  const v = ROCK_VARIANTS[ROCK_CARD_SUBJECT]
  if (!v) throw new Error(`rockCardSubject: no rock variant named ${ROCK_CARD_SUBJECT}`)
  if (v.openBottom === 1) {
    throw new Error(`rockCardSubject: ${ROCK_CARD_SUBJECT} is an open shell -- see the note on ROCK_CARD_SUBJECT`)
  }
  const geo = buildRock({ ...rockParams(ROCK_CARD_SUBJECT, ROCK_CARD_SEED), tier: 0 })
  return { geo, frame: rockBakeFrame(geo.userData.rock.measured) }
}

/**
 * Photograph the bank into LAYER.IMPOSTOR_ROCK, in place.
 *
 * Call ONCE, after `loadImageLayers()` has resolved -- the subject wears
 * LAYER.ROCK, and LAYER.ROCK is a PNG that arrives some hundreds of
 * milliseconds into the session. Bake before it lands and the card is a
 * photograph of an untextured lump. Until then the far band draws an empty
 * layer, which is fully transparent and so discarded by alphaTest, exactly as
 * the tree, fern and grass cards do.
 *
 * Needs the live renderer, so it cannot live in `buildRockBank` -- that runs in
 * a constructor and in node. Returns what `bakeImpostor` measured, with the
 * layer beside it, for the caller to log.
 */
export function bakeRockImpostors(renderer, texArray) {
  const { geo, frame } = rockCardSubject()
  const azimuth = widestAzimuth(geo)
  const baked = bakeImpostor(renderer, geo, texArray, LAYER.IMPOSTOR_ROCK, { ...frame, azimuth })
  geo.dispose()
  return { layer: LAYER.IMPOSTOR_ROCK, subject: ROCK_CARD_SUBJECT, azimuth, ...baked }
}

/**
 * The compass bearing that sees the most of a rock, in radians.
 *
 * PHOTOGRAPH THE SUBJECT AT ITS LARGEST, NEVER FLAT-ON. The shot is framed to
 * `rockBakeFrame`, which is `max(width, depth)` across -- the widest the rock
 * can ever look -- so a bake taken along the rock's SHORT axis prints a narrow
 * silhouette into a wide frame and every distant rock in the world is drawn with
 * transparent margins down both sides. It does not misplace anything; it just
 * makes the far band quietly smaller than the mesh it replaced, which is one
 * half of the size mismatch a spun card can have.
 *
 * Azimuth 0 used to be hardcoded, and on the shipped subject and seed it happens
 * to land 4 degrees off the widest bearing -- 1.896 m photographed into a 1.900 m
 * frame, which is why the fault stayed invisible. It is luck and not a property:
 * the same subject at azimuth 113 degrees measures 1.399 m, so a new seed or a
 * new ROCK_CARD_SUBJECT could silently print a card 26% narrow. Searching costs
 * one pass over the subject's vertices, once, at boot.
 *
 * Half a turn is the whole search space -- a silhouette width at bearing `a` is
 * the same as at `a + pi`, since the projection is onto a line and direction
 * along it does not matter.
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
  return [LAYER.IMPOSTOR_ROCK]
}

/**
 * How many tiers every variant reports. The last one is ALWAYS the card, so the
 * mesh ladder gets ROCK_BAND_COUNT - 1 of these -- exactly ROCK_TIERS.
 */
export const ROCK_BAND_COUNT = ROCK_TIERS.length + 1

/** How many of those bands are real meshes. The rest -- one -- is the card. */
export const ROCK_MESH_BAND_COUNT = ROCK_BAND_COUNT - 1

/**
 * Bake the whole bank: every variant, at `seeds` shapes each, at every tier.
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
 * EVERY SHAPE SHIPS EVERY TIER. There used to be a per-size-class ladder here
 * and short ones were padded by repeating the coarsest geometry REFERENCE, so a
 * cobble's two coarse bands were one arena entry. That is gone with the classes
 * (props/rock.js): the table is rectangular because it is built rectangular,
 * and it costs the bank about 1.6x its geometry -- 25 variants x 3 seeds x 3
 * tiers rather than the 2.4 tiers the classes averaged. What it buys is that a
 * band index means the same thing for every rock in the world, which is what
 * lets ROCK_LOD_AT be one rule instead of a table per bed.
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
 * of 4 vertices each, about 150 bytes apiece. The PICTURE on them is still one
 * shared bake into one layer; see THE CARD above for what that costs.
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

    for (let s = 0; s < seeds; s++) {
      const rockSeed = seed + variant * 9173 + s * 101
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
      const card = buildImpostorCard(ext.width, ext.height, LAYER.IMPOSTOR_ROCK, 1, {
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
