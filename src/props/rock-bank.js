import { buildRock, rockClass, ROCK_LADDERS, ROCK_DEFAULTS } from './rock.js'

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
// sRGB, because that is how a colour picker thinks; three converts on the way
// into the shader, where the multiply happens in linear. The tile is graded to
// a mean of 142/255, so every one of these is a REDUCTION -- there is no tint
// that makes a rock brighter than the tile, which is why the tile is graded
// bright in the first place (see tools/props/cut-rock.mjs).
export const TINTS = [
  ['granite', 0xc8c8c4, 'the neutral one. Brings the deliberately-bright tile back down to stone'],
  ['basalt', 0x6e747c, 'cold dark grey-blue. Peaks, scree, anything the ice left bare'],
  ['sandstone', 0xd2a878, 'warm buff. River bluffs, dry ground, the shelf on a south face'],
  ['shale, wet', 0x59636a, 'darkened and cooled. A riverbed rock that is actually in the river'],
  ['lichen', 0x9cab7c, 'green-grey. A forest boulder that has not moved in a century'],
  ['snow-pale', 0xdde3ea, 'washed out and cold, for above the snow line'],
]

/** The four places a rock can belong. A variant carries a subset. */
export const ENVIRONMENTS = ['river', 'forest', 'cliff', 'peak']

// --- the sixteen ------------------------------------------------------------
//
// Ordered small to large within each environment group, because that is the
// order the dropdown reads best in and the order the scatter's size beds fall
// into anyway. `tint` is an index into TINTS; `envs` is where it may be placed.
export const ROCK_VARIANTS = {
  // --- underfoot, everywhere ------------------------------------------------

  // The smallest thing in the world with its own geometry. One T8 octahedron,
  // eight triangles, no LOD at all -- which is the entire reason it is allowed
  // to exist in the numbers it does.
  pebble: { size: 0.11, squash: 0.68, elongate: 1.4, lumps: 0.26, lumpFreq: 1.9, grain: 0.12, smooth: 0.8, cuts: 2, cutDepth: 0.5, cutBias: 0, sit: 0.3, texRepeat: 1.4, tint: 0, envs: ['river', 'forest', 'cliff', 'peak'] },

  // Angular chips rather than worn ones: the fines that collect at the foot of
  // anything that breaks. smooth 0 and deep cuts are the whole recipe.
  grit: { size: 0.14, squash: 0.52, elongate: 1.6, lumps: 0.14, lumpFreq: 2.4, grain: 0.06, smooth: 0, cuts: 4, cutDepth: 0.9, cutBias: 0.2, sit: 0.24, texRepeat: 1.2, tint: 1, envs: ['cliff', 'peak', 'river'] },

  // --- river ---------------------------------------------------------------

  // The river cobble: rounded on every axis because it has been rolled. Two
  // tiers, T20 and T8, and it is culled while the T8 is still readable.
  cobble: { size: 0.34, squash: 0.66, elongate: 1.35, lumps: 0.24, lumpFreq: 1.7, grain: 0.1, smooth: 0.75, cuts: 3, cutDepth: 0.5, cutBias: 0, sit: 0.26, texRepeat: 1.8, tint: 0, envs: ['river', 'forest'] },

  // Shingle: a flake lying flat, half buried. The `sit` is the point -- at 0.44
  // most of the rock is under the gravel and what shows is a worn edge.
  shingle: { size: 0.5, squash: 0.3, elongate: 1.8, lumps: 0.16, lumpFreq: 1.9, grain: 0.06, smooth: 0.7, cuts: 4, cutDepth: 0.78, cutBias: -0.9, sit: 0.44, texRepeat: 2.0, tint: 3, envs: ['river'] },

  // Riverbed and shore: flat, wide, sunk halfway, worn smooth. The one shape
  // that has to tile in a crowd without every rock reading as a separate
  // object, which is why it is the least dramatic entry in the table.
  slab: { size: 1.1, squash: 0.28, elongate: 1.6, lumps: 0.16, lumpFreq: 1.8, grain: 0.06, smooth: 0.7, cuts: 4, cutDepth: 0.75, cutBias: -0.9, sit: 0.42, texRepeat: 2.4, tint: 3, envs: ['river', 'forest'] },

  // The one you cross a stream on: wide, flat-topped, standing proud enough to
  // stay dry. A bedding cut with `foot` under it, so it does not look balanced.
  stepping: { size: 1.7, squash: 0.44, elongate: 1.3, lumps: 0.2, lumpFreq: 1.5, grain: 0.07, smooth: 0.55, cuts: 5, cutDepth: 0.8, cutBias: -0.75, foot: 0.35, sit: 0.3, texRepeat: 2.6, tint: 2, envs: ['river'] },

  // --- forest --------------------------------------------------------------

  // A low mossy dome. Almost no cuts, almost all smoothing: this is the shape
  // the moss shader flatters most, and it exists to give a wood something soft
  // among all the fractured stone.
  mosshump: { size: 0.9, squash: 0.62, elongate: 1.25, lumps: 0.3, lumpFreq: 1.3, grain: 0.05, smooth: 0.95, cuts: 2, cutDepth: 0.4, cutBias: -0.5, sit: 0.34, texRepeat: 2.0, tint: 4, envs: ['forest'] },

  // The workhorse: a forest obstacle you walk around and cannot see past.
  // Rounded rather than fractured, because a boulder that has sat in a wood
  // since the ice went is weathered, not freshly split.
  boulder: { size: 1.9, squash: 0.74, elongate: 1.3, lumps: 0.26, lumpFreq: 1.6, grain: 0.09, smooth: 0.5, cuts: 4, cutDepth: 0.6, cutBias: 0, foot: 0.2, sit: 0.16, texRepeat: 2.2, tint: 4, envs: ['forest', 'cliff'] },

  // The glacial erratic: a big rounded lump dumped in the open, wider at the
  // top than the bottom, which is the giveaway that nothing eroded it in place.
  // The only variant with a NEGATIVE taper.
  erratic: { size: 2.7, squash: 0.86, elongate: 1.15, lumps: 0.3, lumpFreq: 1.4, grain: 0.07, smooth: 0.75, cuts: 3, cutDepth: 0.45, cutBias: -0.4, taper: -0.35, taperPow: 1.4, sit: 0.1, texRepeat: 2.4, tint: 4, envs: ['forest'] },

  // A split boulder: two masses that were one until frost got into them, still
  // leaning apart. `shardSpread` near the top of its range is what opens the
  // cleft -- past about 0.9 they stop overlapping and read as two rocks.
  cleft: { size: 3.4, squash: 0.8, elongate: 1.2, lumps: 0.24, lumpFreq: 1.4, grain: 0.08, smooth: 0.35, cuts: 5, cutDepth: 0.82, cutBias: 0.55, shards: 2, shardSpread: 0.86, shardDrop: 0.22, shardTilt: 0.5, shardSink: 0.35, foot: 0.25, sit: 0.2, texRepeat: 2.6, tint: 0, envs: ['forest', 'cliff'] },

  // House-sized. A single angular block, not a cluster: at five metres a
  // cluster reads as a pile and this has to read as one thing you cannot climb.
  blockhouse: { size: 5.2, squash: 1.0, elongate: 1.35, lumps: 0.2, lumpFreq: 1.15, grain: 0.07, smooth: 0.2, cuts: 7, cutDepth: 0.84, cutBias: -0.25, foot: 0.3, sit: 0.18, texRepeat: 3.0, tint: 0, envs: ['forest', 'cliff'] },

  // --- cliff ---------------------------------------------------------------

  // Freshly broken: sharp, angular, no weathering. Scree slopes and the debris
  // at the foot of a cliff. Deep cuts and smooth = 0 are the whole recipe.
  scree: { size: 0.62, squash: 0.55, elongate: 1.5, lumps: 0.14, lumpFreq: 2.2, grain: 0.05, smooth: 0, cuts: 6, cutDepth: 0.9, cutBias: 0.3, taper: 0.2, sit: 0.1, texRepeat: 1.8, tint: 1, envs: ['cliff', 'peak'] },

  // Cliff dressing: a wide low shelf that sticks out of a slope and gives it a
  // third dimension. Bedding-plane cuts, so the top and bottom are flat and the
  // whole thing reads as a layer of the rock behind it.
  shelf: { size: 3.6, squash: 0.34, elongate: 1.9, lumps: 0.2, lumpFreq: 1.5, grain: 0.08, smooth: 0.25, cuts: 6, cutDepth: 0.82, cutBias: -0.85, taper: -0.15, taperPow: 1.3, strata: 3, strataAmp: 0.07, shards: 2, shardSpread: 0.5, shardDrop: 0.55, shardTilt: 0.15, sit: 0.3, texRepeat: 3.2, tint: 2, envs: ['cliff', 'river'] },

  // The giant protruding from a cliff face: tall, heavy, cut on near-vertical
  // planes, with a flared base so it looks anchored in the slope rather than
  // balanced on it. This is the "cliffs littered with giant rocks" entry.
  buttress: { size: 6.5, squash: 1.5, elongate: 1.3, lumps: 0.26, lumpFreq: 1.2, grain: 0.09, smooth: 0.18, cuts: 8, cutDepth: 0.86, cutBias: 0.6, taper: 0.3, taperPow: 1.8, foot: 0.55, strata: 3, strataAmp: 0.05, shards: 2, shardSpread: 0.55, shardDrop: 0.42, shardTilt: 0.3, sit: 0.26, texRepeat: 3.4, tint: 1, envs: ['cliff', 'peak'] },

  // --- peak ----------------------------------------------------------------

  // A standing stone / tor: tall, narrow, columnar, and now genuinely POINTED.
  // The three numbers that do it are `taper` near its ceiling, `taperPow` above
  // 2 so the narrowing holds off and then bites (shoulders, then a tooth), and
  // `foot` to put a batter under it -- without the last one a tapered spire
  // stands on a point and reads as balanced rather than rooted. `sit` at 0.3
  // then stands that batter on a real flat bed face.
  spire: { size: 3.8, squash: 2.4, elongate: 1.1, lumps: 0.22, lumpFreq: 1.1, grain: 0.09, smooth: 0.15, cuts: 8, cutDepth: 0.88, cutBias: 0.95, taper: 0.85, taperPow: 2.2, foot: 0.7, strata: 4, strataAmp: 0.06, shards: 1, sit: 0.3, texRepeat: 2.8, tint: 1, envs: ['peak', 'cliff'] },

  // The summit fang: the spire's recipe at twice the size and in a cluster, so
  // a peak gets a group of teeth rather than one obelisk. Three masses crowding
  // each other, all tapered, is what makes a mountain silhouette jagged instead
  // of smooth -- and it is the only variant that really earns T180.
  fang: { size: 7.5, squash: 1.9, elongate: 1.15, lumps: 0.28, lumpFreq: 1.25, grain: 0.11, smooth: 0.12, cuts: 9, cutDepth: 0.88, cutBias: 0.8, taper: 0.72, taperPow: 2.0, foot: 0.6, strata: 0, shards: 3, shardSpread: 0.6, shardDrop: 0.45, shardTilt: 0.42, shardSink: 0.4, sit: 0.24, texRepeat: 3.6, tint: 1, envs: ['peak'] },
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
