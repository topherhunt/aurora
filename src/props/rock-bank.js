import { buildRock, rockClass, ROCK_LADDERS, ROCK_DEFAULTS } from './rock.js'
import { ROCK_TILE_MEAN } from '../textures.js'

// ---------------------------------------------------------------------------
// The shipping rock bank: sixteen named shapes, the tints they wear, and the
// baked geometry for every tier of every one of them.
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
// HOW THE SIXTEEN WERE CHOSEN. Not by shape -- by the place a shape has to
// work. Four environments make demands a generator can actually answer:
//
//   RIVER   flat, wide, sunk, worn smooth. A riverbed is a crowd, so these have
//           to tile without every rock reading as a separate object, which
//           means low silhouettes and no drama.
//   FOREST  obstacles and line-of-sight breakers, at head height and above.
//           Weathered rather than freshly split: nothing has broken these since
//           the ice went.
//   CLIFF   things that stick OUT of a slope and give it a third dimension.
//           Bedding cuts, so they read as a layer of the rock behind them.
//   PEAK    jagged. Sheer sides, columnar cuts, tapered tops. This is the only
//           environment where the silhouette is the whole point, and the only
//           one that earns T180.
//
// Every variant is tagged with the environments it belongs in, and the scatter
// picks from the tagged subset. A variant may appear in more than one -- a
// pebble is underfoot everywhere -- but the tag list is what stops a river
// shingle turning up on a summit.
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

// --- the sixteen ------------------------------------------------------------
//
// Ordered small to large within each environment group, because that is the
// order the dropdown reads best in and the order the scatter's size beds fall
// into anyway. `tint` is an index into TINTS; `envs` is where it may be placed.
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
  // --- underfoot, everywhere ------------------------------------------------

  // The smallest thing in the world with its own geometry. One T8 octahedron,
  // eight triangles, no LOD at all -- which is the entire reason it is allowed
  // to exist in the numbers it does.
  pebble: { size: 0.11, squash: 0.68, elongate: 1.4, lumps: 0.26, lumpFreq: 1.9, grain: 0.12, smooth: 0.96, cuts: 2, cutDepth: 0.5, cutBias: 0, sit: 0.3, texRepeat: 1.4, tint: 0, envs: ['river', 'forest', 'cliff', 'peak'] },

  // Angular chips rather than worn ones: the fines that collect at the foot of
  // anything that breaks. smooth 0 and deep cuts are the whole recipe.
  grit: { size: 0.14, squash: 0.52, elongate: 1.6, lumps: 0.14, lumpFreq: 2.4, grain: 0.06, smooth: 0.88, cuts: 4, cutDepth: 0.9, cutBias: 0.2, sit: 0.24, texRepeat: 1.2, tint: 2, envs: ['cliff', 'peak', 'river'] },

  // --- river ---------------------------------------------------------------

  // The river cobble: rounded on every axis because it has been rolled. Two
  // tiers, T20 and T8, and it is culled while the T8 is still readable.
  cobble: { size: 0.34, squash: 0.66, elongate: 1.35, lumps: 0.24, lumpFreq: 1.7, grain: 0.1, smooth: 0.95, cuts: 3, cutDepth: 0.5, cutBias: 0, sit: 0.26, texRepeat: 1.8, tint: 0, envs: ['river', 'forest'] },

  // Shingle: a flake lying flat, half buried. The `sit` is the point -- at 0.44
  // most of the rock is under the gravel and what shows is a worn edge.
  shingle: { size: 0.5, squash: 0.3, elongate: 1.8, lumps: 0.16, lumpFreq: 1.9, grain: 0.06, smooth: 0.94, cuts: 4, cutDepth: 0.78, cutBias: -0.9, sit: 0.44, texRepeat: 2.0, tint: 3, envs: ['river'] },

  // Riverbed and shore: flat, wide, sunk halfway, worn smooth. The one shape
  // that has to tile in a crowd without every rock reading as a separate
  // object, which is why it is the least dramatic entry in the table.
  slab: { size: 1.1, squash: 0.28, elongate: 1.6, lumps: 0.16, lumpFreq: 1.8, grain: 0.06, smooth: 0.94, cuts: 4, cutDepth: 0.75, cutBias: -0.9, sit: 0.42, texRepeat: 2.4, tint: 3, envs: ['river', 'forest'] },

  // The one you cross a stream on: wide, flat-topped, standing proud enough to
  // stay dry. A bedding cut with `foot` under it, so it does not look balanced.
  stepping: { size: 1.7, squash: 0.44, elongate: 1.3, lumps: 0.2, lumpFreq: 1.5, grain: 0.07, smooth: 0.92, cuts: 5, cutDepth: 0.8, cutBias: -0.75, foot: 0.35, sit: 0.3, texRepeat: 2.6, tint: 4, envs: ['river'] },

  // --- forest --------------------------------------------------------------

  // A low mossy dome. Almost no cuts, almost all smoothing: this is the shape
  // the moss shader flatters most, and it exists to give a wood something soft
  // among all the fractured stone.
  mosshump: { size: 0.9, squash: 0.62, elongate: 1.25, lumps: 0.3, lumpFreq: 1.3, grain: 0.05, smooth: 1, cuts: 2, cutDepth: 0.4, cutBias: -0.5, sit: 0.34, texRepeat: 2.0, tint: 6, envs: ['forest'] },

  // The workhorse: a forest obstacle you walk around and cannot see past.
  // Rounded rather than fractured, because a boulder that has sat in a wood
  // since the ice went is weathered, not freshly split.
  boulder: { size: 1.9, squash: 0.74, elongate: 1.3, lumps: 0.26, lumpFreq: 1.6, grain: 0.09, smooth: 0.94, cuts: 4, cutDepth: 0.6, cutBias: 0, foot: 0.2, sit: 0.16, texRepeat: 2.2, tint: 6, envs: ['forest', 'cliff'] },

  // The glacial erratic: a big rounded lump dumped in the open, wider at the
  // top than the bottom, which is the giveaway that nothing eroded it in place.
  // The only variant with a NEGATIVE taper.
  erratic: { size: 2.7, squash: 0.86, elongate: 1.15, lumps: 0.3, lumpFreq: 1.4, grain: 0.07, smooth: 0.96, cuts: 3, cutDepth: 0.45, cutBias: -0.4, taper: -0.35, taperPow: 1.4, sit: 0.1, texRepeat: 2.4, tint: 6, envs: ['forest'] },

  // A split boulder: two masses that were one until frost got into them, still
  // leaning apart. `shardSpread` near the top of its range is what opens the
  // cleft -- past about 0.9 they stop overlapping and read as two rocks.
  cleft: { size: 3.4, squash: 0.8, elongate: 1.2, lumps: 0.24, lumpFreq: 1.4, grain: 0.08, smooth: 0.9, cuts: 5, cutDepth: 0.82, cutBias: 0.55, shards: 2, shardSpread: 0.86, shardDrop: 0.22, shardTilt: 0.5, shardSink: 0.35, foot: 0.25, sit: 0.2, texRepeat: 2.6, tint: 0, envs: ['forest', 'cliff'] },

  // House-sized. A single angular block, not a cluster: at five metres a
  // cluster reads as a pile and this has to read as one thing you cannot climb.
  blockhouse: { size: 5.2, squash: 1.0, elongate: 1.35, lumps: 0.2, lumpFreq: 1.15, grain: 0.07, smooth: 0.88, cuts: 7, cutDepth: 0.84, cutBias: -0.25, foot: 0.3, sit: 0.18, texRepeat: 3.0, tint: 0, envs: ['forest', 'cliff'] },

  // --- cliff ---------------------------------------------------------------

  // Freshly broken: sharp, angular, no weathering. Scree slopes and the debris
  // at the foot of a cliff. Deep cuts and smooth = 0 are the whole recipe.
  scree: { size: 0.62, squash: 0.55, elongate: 1.5, lumps: 0.14, lumpFreq: 2.2, grain: 0.05, smooth: 0.88, cuts: 6, cutDepth: 0.9, cutBias: 0.3, taper: 0.2, sit: 0.1, texRepeat: 1.8, tint: 2, envs: ['cliff', 'peak'] },

  // Cliff dressing: a wide low shelf that sticks out of a slope and gives it a
  // third dimension. Bedding-plane cuts, so the top and bottom are flat and the
  // whole thing reads as a layer of the rock behind it.
  shelf: { size: 3.6, squash: 0.34, elongate: 1.9, lumps: 0.2, lumpFreq: 1.5, grain: 0.08, smooth: 0.88, cuts: 6, cutDepth: 0.82, cutBias: -0.85, taper: -0.15, taperPow: 1.3, strata: 3, strataAmp: 0.07, shards: 2, shardSpread: 0.5, shardDrop: 0.55, shardTilt: 0.15, sit: 0.3, texRepeat: 3.2, tint: 4, envs: ['cliff', 'river'] },

  // The giant protruding from a cliff face: tall, heavy, cut on near-vertical
  // planes, with a flared base so it looks anchored in the slope rather than
  // balanced on it. This is the "cliffs littered with giant rocks" entry.
  buttress: { size: 6.5, squash: 1.5, elongate: 1.3, lumps: 0.26, lumpFreq: 1.2, grain: 0.09, smooth: 0.86, cuts: 8, cutDepth: 0.86, cutBias: 0.6, taper: 0.3, taperPow: 1.8, foot: 0.55, strata: 3, strataAmp: 0.05, shards: 2, shardSpread: 0.55, shardDrop: 0.42, shardTilt: 0.3, sit: 0.26, texRepeat: 3.4, tint: 2, envs: ['cliff', 'peak'] },

  // --- peak ----------------------------------------------------------------

  // A standing stone / tor: tall, narrow, columnar, and now genuinely POINTED.
  // The three numbers that do it are `taper` near its ceiling, `taperPow` above
  // 2 so the narrowing holds off and then bites (shoulders, then a tooth), and
  // `foot` to put a batter under it -- without the last one a tapered spire
  // stands on a point and reads as balanced rather than rooted. `sit` at 0.3
  // then stands that batter on a real flat bed face.
  spire: { size: 3.8, squash: 2.4, elongate: 1.1, lumps: 0.22, lumpFreq: 1.1, grain: 0.09, smooth: 0.86, cuts: 8, cutDepth: 0.88, cutBias: 0.95, taper: 0.85, taperPow: 2.2, foot: 0.7, strata: 4, strataAmp: 0.06, shards: 1, sit: 0.3, texRepeat: 2.8, tint: 2, envs: ['peak', 'cliff'] },

  // The summit fang: the spire's recipe at twice the size and in a cluster, so
  // a peak gets a group of teeth rather than one obelisk. Three masses crowding
  // each other, all tapered, is what makes a mountain silhouette jagged instead
  // of smooth -- and it is the only variant that really earns T180.
  fang: { size: 7.5, squash: 1.9, elongate: 1.15, lumps: 0.28, lumpFreq: 1.25, grain: 0.11, smooth: 0.86, cuts: 9, cutDepth: 0.88, cutBias: 0.8, taper: 0.72, taperPow: 2.0, foot: 0.6, strata: 0, shards: 3, shardSpread: 0.6, shardDrop: 0.45, shardTilt: 0.42, shardSink: 0.4, sit: 0.24, texRepeat: 3.6, tint: 2, envs: ['peak'] },
}

/** Variant names, in table order. An index into this is a variant id. */
export const ROCK_NAMES = Object.keys(ROCK_VARIANTS)

/**
 * The buildRock options for one variant, with the bank's own bookkeeping keys
 * (`tint`, `envs`) stripped. Those two are placement metadata, not shape, and
 * buildRock would silently carry them into `p` where nothing reads them.
 */
export function rockParams(name, seed) {
  const v = ROCK_VARIANTS[name]
  if (!v) throw new Error(`rockParams: no rock variant named ${name}`)
  const { tint, envs, ...shape } = v
  return { ...ROCK_DEFAULTS, ...shape, seed }
}

/** Which variant ids may be placed in `env`. Throws on an environment nobody tagged. */
export function variantsFor(env) {
  if (!ENVIRONMENTS.includes(env)) throw new Error(`variantsFor: unknown environment ${env}`)
  const out = ROCK_NAMES.map((n, i) => (ROCK_VARIANTS[n].envs.includes(env) ? i : -1)).filter((i) => i >= 0)
  if (!out.length) throw new Error(`variantsFor: no rock variant is tagged ${env}`)
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
        measured: built[0].userData.rock.measured,
        tiers,
      })
    }
  })

  return { shapes, geometries, triangles, bytes }
}
