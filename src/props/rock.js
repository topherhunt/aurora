import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural rocks.
//
// A rock is the opposite of a fern in every way that matters to a generator. A
// fern is a rosette of flat cards whose entire silhouette lives in an alpha
// channel; a rock is an OPAQUE CLOSED LUMP whose silhouette is the geometry and
// nothing else. There is no texture trick available: you cannot photograph your
// way out of a boulder. So the whole job here is to spend a handful of
// triangles on a shape that reads as stone, and the answer this file settles on
// has three parts.
//
// 1. DISPLACEMENT IS A PURE FUNCTION OF THE ORIGINAL UNIT DIRECTION.
//
// Every vertex of every base solid starts on the unit sphere, and its final
// position is decided by feeding that direction into `shapeRadius`, which is
// deterministic and stateless. Nothing depends on which solid we started from,
// how many vertices it had, or what order they came in. The consequence is the
// one the whole LOD ladder rests on: an octahedron (8 faces), an icosahedron
// (20), and its two subdivisions (80, 180) all sample THE SAME ROCK, coarser or
// finer (180, 80, 20, 8 -- three's polyhedron subdivision splits each edge into
// detail+1, so the counts go as 20*(detail+1)^2 rather than doubling). That is
// why a tier change is a silhouette that simplifies rather than
// a different rock that pops -- and why "some boulder shapes will also work
// well as medium & small rocks, just bump LOD0 -> LOD1" is literally true here:
// ROCK_LADDERS below does exactly that and nothing else.
//
// Purity gets the tiers onto the same shape; it does not get them to the same
// SIZE. Sampling a lump on 8 directions loses every peak between the samples,
// so the raw T8 is about a third smaller than the T180 it replaces even though
// both describe the same rock. So every tier is measured against one dense
// reference and given a single uniform gain that matches its mean silhouette
// radius to the reference's. That is the number a player perceives at an LOD
// switch, and driving it to zero is what makes the switch invisible.
//
// This is the same lesson buildBoulder in props/shapes.js records in one line
// ("jitter must be a pure function of the ORIGINAL position"), taken seriously.
// There the reason was to stop a non-indexed solid tearing apart at its seams.
// Here it is that plus the entire LOD story.
//
// 2. FLAT FACES COME FROM RADIAL PLANE CLIPPING, NOT FROM NOISE.
//
// Noise alone gives you a potato. What makes stone read as stone at 20
// triangles is FLAT FACETS meeting at hard edges -- conchoidal fracture, joint
// faces, bedding planes. So after displacement each vertex is clipped against a
// small set of half-spaces, radially from the shard's own centre:
//
//     r_max = min over planes with dot(p̂, n_i) > 0 of  c_i / dot(p̂, n_i)
//
// Radial clipping (rather than the obvious "project any vertex outside the
// plane onto it") is chosen for three properties. It is ORDER-INDEPENDENT, so
// five planes give the same solid in any sequence. It NEVER INVERTS a triangle,
// because every vertex only ever moves inward along its own ray. And it needs
// no iteration to converge, because the min is exact.
//
// `cutBias` steers the plane normals between two real rock behaviours: -1 tilts
// them toward vertical, which makes horizontal cut faces (BEDDING planes -- the
// stacked slabs of a riverbed), and +1 tilts them toward horizontal, which
// makes vertical cut faces (COLUMNAR jointing -- the sheer sides of a crag).
//
// A face whose three vertices were all pinned by the SAME plane is a genuine
// flat facet, and it is shaded flat regardless of `smooth`. Without that test,
// turning smoothing up to soften the lumps also rounds the fracture faces away,
// and the rock goes back to being a potato.
//
// 3. ONE TILE, TINTED PER INSTANCE, PROJECTED PER FACE, SCALED BY THE ROCK.
//
// Every rock in the world wears LAYER.ROCK -- one 128px granite speckle, cut by
// tools/props/cut-rock.mjs. Variety comes from a per-instance colour via
// BatchedMesh.setColorAt, which defines USE_BATCHING_COLOR -> USE_COLOR in the
// fragment prefix and multiplies diffuseColor by it WITHOUT needing
// material.vertexColors (props/scatter.js already tints stands this way). So
// granite, basalt, sandstone, wet shale and lichen-green are one draw call.
// That is also why the tile is graded bright and near-neutral: a tint is a
// multiply, so the tile's mean is the ceiling, and its hue would otherwise
// fight every tint laid over it.
//
// UVs are a per-face planar projection off whichever world axis the face normal
// dominates. No unwrapping and no seams to author. What that projection is
// DIVIDED BY is the part that changed. It used to be a fixed 0.9 world metres,
// which held absolute crystal size constant across a library spanning two orders
// of magnitude -- a 12 cm cobble and a 14 m outcrop wearing literally the same
// speckle. That is the textbook answer and it looks wrong. A 7 m crag under a
// 0.9 m tile is eight repeats of one photograph across its face, and eight
// repeats of anything reads as patterned fabric rather than as stone: the tile's
// features sit far below the scale its silhouette promises, so the rock stops
// having a size of its own and starts looking like a scale model.
//
// So the tile scales WITH the rock. `texRepeat` is how many times it tiles
// across the rock's largest horizontal extent, whatever that extent happens to
// be in metres, which makes a shape one picture at 0.2 m and at 14 m and makes
// "author the shapes at 2 m and scale them to fit the scenery" literally true
// rather than aspirational. The cost is real and worth naming: two rocks of
// different sizes side by side no longer agree about how big a grain of this
// granite is, so a boulder is no longer evidence about the cobble next to it.
// `texJitter` then rolls the repeat +/-50% per seed. That is what buys back the
// variety constant density used to get for free from the rocks being different
// sizes, and it is what stops a bed of same-size cobbles looking stamped.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, indexed with an
// identity index. That is the shared prop material's layout (src/material.js)
// and BatchedMesh rejects a geometry that disagrees. Unlike buildFern there is
// no second `uv` layout, because gen-rock.html renders the real material rather
// than a stand-in -- a rock needs the tint path to be worth looking at.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// The mesh tiers, coarsest last. `faces` is per SHARD -- a 3-shard outcrop at
// T80 is 240 triangles -- which is why `shards` is the most expensive slider on
// the bench by a wide margin and the budget panel prints the product.
//
// T180 is for CRAGS ONLY: the 3-14 m outcrops that stand on a peak or a cliff
// and are looked at from the next valley. Nothing that fits in a forest ever
// asks for it, and putting it on a boulder buys silhouette nobody can resolve.
//
// T8 exists to answer "we probably need a real LOD2, maybe just 8-16 tris,
// before going to a plain billboard". An octahedron is the smallest closed
// solid that still has a top, a bottom and four sides to catch light
// differently, and displaced by the same field as its bigger siblings it keeps
// the rock's proportions and its lean. A tetrahedron (4) does not: three of its
// four faces point sideways and it reads as a shard of glass.
export const ROCK_TIERS = [
  { name: 'T180', solid: 'ico', detail: 2, faces: 180 },
  { name: 'T80', solid: 'ico', detail: 1, faces: 80 },
  { name: 'T20', solid: 'ico', detail: 0, faces: 20 },
  { name: 'T8', solid: 'oct', detail: 0, faces: 8 },
]

// Which tiers a size class actually ships, as indices into ROCK_TIERS. This is
// the whole of "bump LOD0 -> LOD1": the same `buildRock(options)` call with a
// different `tier`, so a cobble's LOD0 IS a boulder's LOD1 mesh.
//
// The classes are cut by ANGULAR size, not metres, because that is what decides
// whether a triangle is visible. A 0.4 m cobble is never seen from far enough
// away to need three tiers -- it is culled while its LOD1 is still 30 px wide.
// A 10 m crag is a landmark that has to hold up from the next valley.
export const ROCK_LADDERS = {
  crag: [0, 1, 2], //  3 - 14 m   outcrops, peak jaggedness, cliff furniture
  boulder: [1, 2, 3], //  0.8 - 3 m   forest obstacles, line-of-sight breakers
  cobble: [2, 3], //  0.15 - 0.7 m riverbed, shore, underfoot
  pebble: [3], //  under 0.15 m scatter, no LOD at all
}

// Which ladder a rock of this size uses. The thresholds are the class
// boundaries above and nothing more subtle -- `size` is the largest horizontal
// extent in metres, and the classes are already cut where the angular argument
// changes.
export function rockClass(size) {
  if (size >= 3) return 'crag'
  if (size >= 0.8) return 'boulder'
  if (size >= 0.15) return 'cobble'
  return 'pebble'
}

export const ROCK_DEFAULTS = {
  seed: 1,

  // --- size and proportion -------------------------------------------------
  // `size` is the LARGEST HORIZONTAL EXTENT in metres: the rock is built in
  // relative units and uniformly rescaled at the end, same reasoning as
  // buildFern's height correction. Everything below is a ratio, so a shape found
  // at 1 m is still that shape at 14 m -- and since the texture scales with the
  // rock too (see `texRepeat`), it is now the same PICTURE at 14 m as well, which
  // is why 2 m is the canonical size to author a shape at and `size` is just the
  // dial that fits it to the scenery. It is measured on the dense reference, not
  // on the tier being built, and `userData.rock.measured` reports it -- which is
  // the number to place and space rocks by. A coarse tier's own box wanders
  // either side of it by design; see BOX_MARGIN.
  size: 2,
  squash: 0.72, // height / width, roughly; noise moves it, `measured` reports the truth
  elongate: 1.25, // x extent vs z extent. 1 = round in plan, 2 = twice as long as wide

  tier: 0, // index into ROCK_TIERS

  // --- surface -------------------------------------------------------------
  // Two octaves and no more. A third costs a slider and reads as noise rather
  // than as rock, because below `grain`'s scale the 128px speckle is doing the
  // work and geometry cannot compete with it.
  lumps: 0.7, // large-scale radial displacement -- the mass of the rock
  lumpFreq: 1.6,
  grain: 0.25, // small-scale -- the bumps that catch light along an edge
  grainFreq: 5.0,
  smooth: 1, // 0 = every face flat-shaded, 1 = one smooth shell. Cut facets ignore it.

  // --- fracture ------------------------------------------------------------
  cuts: 10,
  cutDepth: 0.78, // 0 = planes tangent (no cut), 1 = deep slices
  cutBias: 0, // -1 bedding (horizontal faces), +1 columnar (vertical faces)

  // --- profile -------------------------------------------------------------
  // See profileRadial: these three scale the HORIZONTAL semi-axes only, never
  // the vertical one, so a taper sharpens a rock to a point instead of chopping
  // its height off.
  taper: 0.0, // >0 narrows the top (spire), <0 narrows the base (mushroom, glacial erratic)
  taperPow: 1.6, // how the narrowing is distributed up the height. >1 = shoulders, then a tooth
  foot: 0.0, // flare on the bottom half only, so a tall rock stands on something solid
  strata: 0, // bedding bands up the height, as a count. 0 = none
  strataAmp: 0.08,

  // --- clustering ----------------------------------------------------------
  // An outcrop is not one lump, it is a main mass with smaller ones crowding
  // its skirt. Cheaper and better than trying to make one solid do it: the
  // creases where two shards interpenetrate are free silhouette detail.
  shards: 1,
  shardSpread: 0.55, // satellite centre distance, as a fraction of the main radius
  shardDrop: 0.45, // how much smaller satellites get
  shardTilt: 0.35, // radians they lean outward
  shardSink: 0.5, // how far the small ones drop, as a fraction of the size they lost

  // --- ground --------------------------------------------------------------
  // A rock resting exactly on its lowest point looks like it was placed. Real
  // ones are bedded in: cut the bottom off and stand the cut face on y = 0.
  sit: 0.12, // fraction of total height cut away at the bottom

  // AND OPTIONALLY, THROW THE BURIED BELLY AWAY. `sit` flattens everything below
  // the bed plane ONTO it, which leaves a real horizontal disc down there --
  // triangles that face straight down at ground level and are never once seen.
  // With this on, any face all three of whose vertices landed on the plane is
  // dropped, and what ships is an open shell: a cap that protrudes from a
  // riverbed or a cliff face for a fraction of a closed rock's triangles. It
  // costs nothing but the faces, because the rim vertices are shared with the
  // sides and survive there.
  //
  // ONLY EVER USE IT ON SOMETHING BEDDED. An open shell has no bottom, so the
  // moment the ground moves out from under it -- a terrain re-split, a rock on a
  // steeper slope than it was placed for -- you are looking into the inside of
  // it through backfaces. The saving scales with `sit`: on a T80 it is about a
  // tenth of the faces at 0.3, a quarter at 0.4, half at 0.6.
  openBottom: 0, // 0 = closed, 1 = drop the faces lying flat on the bed plane

  // --- material ------------------------------------------------------------
  // The tile is sized RELATIVE TO THE ROCK, not to the world -- see point 3 in
  // the header for why, and for what that costs. `texRepeat` is how many times
  // the 128px tile covers the rock's largest horizontal extent, so it is the one
  // number deciding how coarse the stone reads, at every size, forever.
  texLayer: LAYER.ROCK,
  texRepeat: 2.2,
  // Rolled off `seed` alone, so it is the same on every tier of one rock -- a
  // texture that rescaled at an LOD switch would be a worse pop than the
  // silhouette one the support gain exists to kill.
  texJitter: 0.5, // +/-50% on the repeat count
}

// ---------------------------------------------------------------------------
// Value noise. Small, integer-hashed, and deterministic across reloads -- which
// matters more here than quality, because a seed the user liked on the bench
// has to be the same rock tomorrow.
// ---------------------------------------------------------------------------

function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 2246822519) ^ Math.imul(seed | 0, 3266489917)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

function noise3(x, y, z, seed) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const sz = fz * fz * (3 - 2 * fz)

  const c000 = hash3(ix, iy, iz, seed)
  const c100 = hash3(ix + 1, iy, iz, seed)
  const c010 = hash3(ix, iy + 1, iz, seed)
  const c110 = hash3(ix + 1, iy + 1, iz, seed)
  const c001 = hash3(ix, iy, iz + 1, seed)
  const c101 = hash3(ix + 1, iy, iz + 1, seed)
  const c011 = hash3(ix, iy + 1, iz + 1, seed)
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed)

  const x00 = c000 + (c100 - c000) * sx
  const x10 = c010 + (c110 - c010) * sx
  const x01 = c001 + (c101 - c001) * sx
  const x11 = c011 + (c111 - c011) * sx
  const y0 = x00 + (x10 - x00) * sy
  const y1 = x01 + (x11 - x01) * sy
  return y0 + (y1 - y0) * sz
}

// The displacement field, and the reason the LOD ladder works: this reads
// nothing but the unit direction (dx, dy, dz) and the shard's parameters. Two
// solids with completely different vertex counts hand it the same directions
// along the same silhouette and get back the same radii.
function shapeRadius(dx, dy, dz, p, nseed, phase) {
  let r = 1

  r *= 1 + p.lumps * (noise3(dx * p.lumpFreq + 11.3, dy * p.lumpFreq + 5.7, dz * p.lumpFreq + 19.1, nseed) * 2 - 1)
  r *= 1 + p.grain * (noise3(dx * p.grainFreq + 3.9, dy * p.grainFreq + 27.4, dz * p.grainFreq + 8.2, nseed ^ 0x5bf03635) * 2 - 1)

  if (p.strata > 0) r *= 1 + p.strataAmp * Math.sin(dy * p.strata * Math.PI + phase)

  return Math.max(0.15, r)
}

// The vertical profile, and the one part of the shape that does NOT go through
// `shapeRadius`. It scales the two HORIZONTAL semi-axes and leaves the vertical
// one alone, which is the whole reason it is a separate function.
//
// The first cut of this was one line inside shapeRadius -- `r *= 1 - taper*0.45*dy`
// -- an ISOTROPIC multiply on the radius, and it cannot make a spire. A vertex's
// height is dy * ay * r, so shrinking r near the top shrinks the HEIGHT there
// too: past taper ~0.5 the tallest point on the rock stops being the apex and
// the profile folds over into a dome. Which is exactly what a spire built that
// way looked like -- rounded on top, and (being linear and symmetric in dy) as
// much wider at the base as it was narrower at the crown, so the base flared
// into a point at the bed plane instead of sitting on it.
//
// Scaling only x and z fixes both. Height stays monotone in dy, so the apex is
// the apex and the sides converge on it; and `foot` flares the bottom half
// INDEPENDENTLY, so "pointed at the top" and "solid at the bottom" are two
// dials instead of two ends of one.
//
// `taperPow` shapes how the narrowing is distributed. At 1 it is the old linear
// cone. Above 1 the rock keeps its width and then loses it fast near the crown,
// which is the shoulders-and-a-tooth profile a weathered pinnacle actually has;
// below 1 it narrows immediately and reads as a needle.
//
// A negative `taper` narrows the BASE instead, which is the glacial erratic and
// the mushroom -- the same curve mirrored, so `taperPow` means the same thing.
//
// The 0.94 clamps stop a horizontal semi-axis reaching zero, where the clip
// below would divide by a degenerate radius; the 0.04 floor is the same guard
// for the product.
function profileRadial(dy, p) {
  const t = dy * 0.5 + 0.5 // 0 at the bed plane, 1 at the crown
  const pow = Math.max(0.2, p.taperPow)
  let h = 1
  if (p.taper > 0) h -= Math.min(0.94, p.taper) * Math.pow(t, pow)
  else if (p.taper < 0) h += Math.max(-0.94, p.taper) * Math.pow(1 - t, pow)
  // A batter, not a skirt: quadratic in the distance below the crown, so most
  // of the flare is in the bottom third and it has faded to nothing by the top.
  // It has to reach well above the bed plane because `sit` flattens the bottom
  // `sit` of the height onto that plane -- a flare that peaked only at t = 0
  // would be entirely inside the part of the rock that gets clamped away, and
  // the dial would look broken at exactly the settings that want it most.
  if (p.foot > 0) h *= 1 + p.foot * (1 - t) * (1 - t)
  return Math.max(0.04, h)
}

// Cut-plane normals, biased toward vertical or horizontal by `cutBias`. Note
// the inversion: a BEDDING plane is a horizontal FACE, which is a VERTICAL
// normal, so negative bias pushes |n.y| toward 1.
function cutPlanes(count, bias, depth, ax, ay, az, p, rand) {
  const planes = []
  for (let i = 0; i < count; i++) {
    let ny = rand() * 2 - 1
    const ang = rand() * TAU

    if (bias > 0) {
      ny *= 1 - bias * 0.92 // columnar: flatten the normal toward the equator
    } else if (bias < 0) {
      const s = ny < 0 ? -1 : 1
      ny = s * (Math.abs(ny) + -bias * 0.92 * (1 - Math.abs(ny))) // bedding: push it toward the pole
    }

    const s = Math.sqrt(Math.max(0, 1 - ny * ny))
    const nx = Math.cos(ang) * s
    const nz = Math.sin(ang) * s

    // Offset measured against the ellipsoid's own support in this direction, so
    // a cut bites the same proportion of a flat slab as of a tall spire.
    //
    // MEASURED AGAINST THE TAPERED ELLIPSOID, not the bare one, and on a spire
    // that is the difference between cuts and no cuts at all. A plane's offset
    // is a distance from the shard's centre; take it from the full semi-axes and
    // it lands outside a crown that has been narrowed to a fifth of them, so the
    // near-vertical columnar planes that are supposed to make the top TOOTHY
    // sail past it and the tip comes out a smooth cone. So: find where this
    // normal touches the untapered ellipsoid, read the profile at that height,
    // and re-measure the support against the semi-axes the rock actually has
    // there. Identical to the old line wherever `taper` and `foot` are 0.
    const support0 = Math.sqrt((ax * nx) ** 2 + (ay * ny) ** 2 + (az * nz) ** 2)
    const hr = profileRadial(support0 > 1e-9 ? (ay * ny) / support0 : 0, p)
    const support = Math.sqrt((ax * hr * nx) ** 2 + (ay * ny) ** 2 + (az * hr * nz) ** 2)
    const c = support * (1 - depth * (0.15 + 0.35 * rand()))
    planes.push({ nx, ny, nz, c })
  }
  return planes
}

const solidCache = new Map()
function solidDirections(solid, detail) {
  const key = `${solid}${detail}`
  let dirs = solidCache.get(key)
  if (!dirs) {
    const geo = solid === 'oct' ? new THREE.OctahedronGeometry(1, detail) : new THREE.IcosahedronGeometry(1, detail)
    dirs = Float32Array.from(geo.attributes.position.array)
    geo.dispose()
    solidCache.set(key, dirs)
  }
  return dirs
}

// The direction set the rock is MEASURED on, deliberately finer than any tier
// that ships (320 faces). See the note at the call site: measuring each tier on
// its own vertices would give each tier a different bounding box and therefore
// a different rescale, and the LOD transition would visibly change the rock's
// height. Measuring them all on one dense set makes the coarse tiers INSCRIBED
// in the fine one -- which is what a lower LOD should be.
const REFERENCE_DIRS = () => solidDirections('ico', 3)

// 32 directions on a Fibonacci sphere, used to compare one tier's silhouette
// against the reference's. A bounding box is the wrong instrument for that: it
// is decided by however many vertices happen to land near the extremes, so an
// octahedron whose six poles miss every peak measures ~30% small. Averaging the
// SUPPORT (the furthest point along a direction) over a spread of directions is
// the same question asked 32 times, and its mean is what "how big does this
// read from over there" actually means.
const SUPPORT_DIRS = (() => {
  const n = 32
  const d = new Float64Array(n * 3)
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const a = i * GOLDEN_ANGLE
    d[i * 3] = Math.cos(a) * r
    d[i * 3 + 1] = y
    d[i * 3 + 2] = Math.sin(a) * r
  }
  return d
})()

// How far outside the reference's bounding box a tier is allowed to reach once
// it has been scaled up to match. Deliberately loose, and looser than it looks
// like it should be. The temptation is to pin it near 1.0 so `size` stays
// literally true of every tier, but that trades the error nobody can see for the
// one everybody can: an octahedron's six poles sit ON the shape while everything
// between them is cut away, so holding its box to the reference's leaves it 13%
// short in apparent radius -- a visible shrink at the LOD switch -- to save an
// overhang that is a fraction of a pixel at the distance a T8 is ever drawn.
//
// The number is 1.8 because a CAP THAT BINDS IS A BIAS GENERATOR, and that is
// the failure it has to stay clear of. The gain is one uniform number and the
// cap is taken on the worst axis, so a spire whose T8 happens to bulge in x and
// under-sample in y gets its gain throttled by x and comes out 22% short in y --
// exactly the visible shrink the gain exists to remove, reintroduced by its own
// safety rail. Measured over 60 seeds x 9 shapes x 3 coarse tiers: at 1.3 that
// happened to 46 of 1620 builds and the worst was 29% off; at 1.8 it is 0 of
// 1620 and the worst is 2.3%. So the cap now catches only a genuinely degenerate
// build, which is all it was ever for. Collision and spacing read `measured`,
// which is the reference's box, not a tier's.
export const BOX_MARGIN = 1.8

function meanSupport(pos, cx, cy, cz) {
  let total = 0
  for (let d = 0; d < SUPPORT_DIRS.length; d += 3) {
    const dx = SUPPORT_DIRS[d]
    const dy = SUPPORT_DIRS[d + 1]
    const dz = SUPPORT_DIRS[d + 2]
    let best = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      const v = (pos[i] - cx) * dx + (pos[i + 1] - cy) * dy + (pos[i + 2] - cz) * dz
      if (v > best) best = v
    }
    total += best
  }
  return total / (SUPPORT_DIRS.length / 3)
}

// One shard's vertices, in the rock's frame. Pulled out of buildRock because it
// runs twice per rock: once on REFERENCE_DIRS to measure, once on the tier's own
// directions to build. `aux` collects the shell normals and facet ids, which the
// measuring pass has no use for.
function emitShards(p, ax, ay, az, dirs, out, aux) {
  const shardCount = Math.max(1, Math.round(p.shards))
  const count = dirs.length / 3

  const q = new THREE.Quaternion()
  const spin = new THREE.Quaternion()
  const axis = new THREE.Vector3(0, 1, 0)
  const up = new THREE.Vector3(0, 1, 0)
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()

  for (let s = 0; s < shardCount; s++) {
    // Each shard gets its own stream, so adding a shard never changes the ones
    // already there. Sliding shards 1..N around under the user as they drag the
    // count is the fastest way to make a bench feel untrustworthy.
    const rand = mulberry32(p.seed * 977 + s * 131 + 7)
    const nseed = (p.seed * 2654435761 + s * 40503) | 0
    const phase = rand() * TAU

    let scl = 1
    let ox = 0
    let oy = 0
    let oz = 0
    q.identity()

    if (s > 0) {
      const a = s * GOLDEN_ANGLE + (rand() - 0.5) * 0.8
      const dist = p.shardSpread * (0.55 + 0.6 * rand())
      scl = Math.max(0.15, 1 - p.shardDrop * (0.45 + 0.55 * rand()))
      ox = Math.cos(a) * dist * ax
      oz = Math.sin(a) * dist * az
      oy = -p.shardSink * (1 - scl) * ay

      // Lean outward, about the horizontal axis perpendicular to the direction
      // it sits in. Satellites that all stand upright read as a bag of marbles.
      axis.set(-Math.sin(a), 0, Math.cos(a))
      q.setFromAxisAngle(axis, p.shardTilt * (0.4 + 0.6 * rand()))
      q.multiply(spin.setFromAxisAngle(up, rand() * TAU))
    }

    const planes = cutPlanes(Math.max(0, Math.round(p.cuts)), p.cutBias, p.cutDepth, ax, ay, az, p, rand)

    for (let i = 0; i < count; i++) {
      const dx = dirs[i * 3]
      const dy = dirs[i * 3 + 1]
      const dz = dirs[i * 3 + 2]

      const r = shapeRadius(dx, dy, dz, p, nseed, phase)
      // Horizontal only -- see profileRadial. The vertical axis is deliberately
      // untouched, so the crown of a tapered rock is still at dy = 1.
      const hr = profileRadial(dy, p)
      let px = dx * ax * hr * r
      let py = dy * ay * r
      let pz = dz * az * hr * r

      // Radial clip. `pinned` records which plane -- if a whole triangle shares
      // one, that triangle IS the cut face and gets shaded flat.
      const len = Math.hypot(px, py, pz) || 1e-6
      let rmax = len
      let pinned = -1
      for (let k = 0; k < planes.length; k++) {
        const pl = planes[k]
        const dn = (px * pl.nx + py * pl.ny + pz * pl.nz) / len
        if (dn > 1e-4) {
          const lim = pl.c / dn
          if (lim < rmax) {
            rmax = lim
            pinned = k
          }
        }
      }
      if (rmax < len) {
        const t = rmax / len
        px *= t
        py *= t
        pz *= t
      } else {
        pinned = -1
      }

      v.set(px * scl, py * scl, pz * scl).applyQuaternion(q)
      out.push(v.x + ox, v.y + oy, v.z + oz)

      if (aux) {
        // The smooth-shell normal is the ELLIPSOID normal at this direction, not
        // the direction itself: on a rock elongated 2:1 they differ by up to 30
        // degrees, and using the direction lights a slab as though it were a ball.
        // The horizontal semi-axes are the PROFILED ones, so a spire's shell
        // normals tip outward with its taper instead of standing straight out.
        n.set(dx / (ax * hr), dy / ay, dz / (az * hr)).normalize().applyQuaternion(q)
        aux.shells.push(n.x, n.y, n.z)
        // Offset by shard so two shards' facets are never mistaken for one face.
        aux.facets.push(pinned < 0 ? -1 : s * 1024 + pinned)
      }
    }
  }
}

export function buildRock(options = {}) {
  const p = { ...ROCK_DEFAULTS, ...options }
  const tier = ROCK_TIERS[Math.min(ROCK_TIERS.length - 1, Math.max(0, Math.round(p.tier)))]

  // Semi-axes. `size` is applied at the very end by measuring, so these only
  // have to carry the PROPORTIONS.
  const ax = Math.max(0.05, p.elongate)
  const ay = Math.max(0.05, p.squash)
  const az = Math.max(0.05, 1 / p.elongate)

  // --- measure the rock, once, on a set of directions no tier uses ---------
  // This is the one place the tiers are tied together. A T8 octahedron samples
  // eight directions and misses every peak between them, so its own bounding box
  // is ~20% shorter than a T80's; measure each tier on its own vertices and
  // every one of them gets a different bed plane, a different centre and a
  // different scale, and the rock jumps at every LOD change. One dense
  // measurement decides all three for all four tiers instead. What is left over
  // after that -- the AREA a coarse solid loses between its samples -- is what
  // the support gain further down corrects.
  const ref = []
  emitShards(p, ax, ay, az, REFERENCE_DIRS(), ref, null)

  let minY = Infinity
  let maxY = -Infinity
  for (let i = 1; i < ref.length; i += 3) {
    if (ref[i] < minY) minY = ref[i]
    if (ref[i] > maxY) maxY = ref[i]
  }
  const cutY = minY + Math.min(0.9, Math.max(0, p.sit)) * (maxY - minY)

  // Seat the reference on the bed plane BEFORE measuring it. `sit` does not
  // delete the buried belly, it flattens it onto the ground, so a boulder sunk
  // to its widest point is exactly that wide where it meets the dirt -- measure
  // only what was already above the plane and `size` under-reports the rock the
  // player walks into.
  for (let i = 1; i < ref.length; i += 3) {
    if (ref[i] < cutY) ref[i] = cutY
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < ref.length; i += 3) {
    if (ref[i] < minX) minX = ref[i]
    if (ref[i] > maxX) maxX = ref[i]
    if (ref[i + 2] < minZ) minZ = ref[i + 2]
    if (ref[i + 2] > maxZ) maxZ = ref[i + 2]
  }

  const span = Math.max(maxX - minX, maxZ - minZ)
  const k = span > 1e-6 ? p.size / span : 1
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  const cy = (cutY + maxY) / 2

  const measured = {
    width: (maxX - minX) * k,
    depth: (maxZ - minZ) * k,
    height: (maxY - cutY) * k,
  }

  // The reference's average silhouette radius, on the seated shape.
  const refSupport = meanSupport(ref, cx, cy, cz)

  // --- build the tier that actually ships ---------------------------------
  const positions = []
  const aux = { shells: [], facets: [] }
  emitShards(p, ax, ay, az, solidDirections(tier.solid, tier.detail), positions, aux)

  const shells = aux.shells
  const facets = aux.facets

  // A vertical clamp, not a radial one: the ground is a plane in the ROCK's
  // frame, and satellite shards are offset away from the origin, so the radial
  // trick used for cuts would slice each shard off at a different height.
  //
  // WHAT THIS LEAVES BEHIND is a flat disc on the bed plane, not nothing: three
  // vertices clamped to the same y but different x and z still span real area.
  // For a closed rock that is fine -- it is buried -- and for an open one
  // `openBottom` drops it below.
  const pinned = new Uint8Array(positions.length / 3)
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < cutY) {
      positions[i] = cutY
      pinned[(i - 1) / 3] = 1
    }
  }

  if (p.openBottom) {
    let w = 0
    for (let f = 0; f < pinned.length; f += 3) {
      if (pinned[f] && pinned[f + 1] && pinned[f + 2]) continue
      // Three parallel arrays, one stride each, compacted in lockstep: the face
      // loop further down indexes all three by the same vertex number and would
      // read someone else's normal if they ever fell out of step.
      for (let j = 0; j < 3; j++) {
        const src = f + j
        const dst = w + j
        positions[dst * 3] = positions[src * 3]
        positions[dst * 3 + 1] = positions[src * 3 + 1]
        positions[dst * 3 + 2] = positions[src * 3 + 2]
        shells[dst * 3] = shells[src * 3]
        shells[dst * 3 + 1] = shells[src * 3 + 1]
        shells[dst * 3 + 2] = shells[src * 3 + 2]
        facets[dst] = facets[src]
      }
      w += 3
    }
    if (w === 0) throw new Error(`buildRock: openBottom left nothing of ${tier.name} at sit ${p.sit}`)
    positions.length = w * 3
    shells.length = w * 3
    facets.length = w
  }

  const vertexCount = positions.length / 3

  // This tier's own extents, on exactly the terms the reference was measured on.
  const bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (positions[i + a] < bounds[a * 2]) bounds[a * 2] = positions[i + a]
      if (positions[i + a] > bounds[a * 2 + 1]) bounds[a * 2 + 1] = positions[i + a]
    }
  }

  // Match this tier's average silhouette radius to the reference's. Sampling a
  // lumpy shape on 8 directions instead of 320 does not just round the corners
  // off, it loses AREA -- every peak between two samples is cut away -- so an
  // untouched T8 reads a third smaller than the T180 it replaces and the swap
  // looks like the rock jumping backwards. One uniform gain about the bed origin
  // buys that back -- proportions, lean and the bed plane are all untouched --
  // and it drives the mean signed error between a tier and the reference to
  // roughly zero, which is the number a player perceives as a pop. What it
  // cannot fix is the SPREAD: the coarse tier is still short in some directions
  // and now long in others. That is the right trade. A silhouette that is the
  // right size and the wrong shape is invisible at the range a T8 is drawn at;
  // one that is the right shape and the wrong size is a visible jump.
  const tierSupport = meanSupport(positions, cx, cy, cz)
  let gain = tierSupport > 1e-6 ? refSupport / tierSupport : 1

  // ...with a loose bounding-box cap on top, for the pathological case only.
  // The gain is an average and an octahedron's error is not evenly spread -- its
  // six poles sit ON the shape while everything between them is cut away -- so a
  // gain that fixes the average necessarily pushes those poles outside the real
  // rock. That is allowed, up to BOX_MARGIN; read the argument there for why the
  // overhang is the cheaper error. The cap can bite a FINE tier too, for an
  // unrelated reason: an ico detail 2 vertex can point somewhere detail 3 never
  // sampled, so a slab's T180 occasionally measures wider than the reference
  // that defined `size` before any gain is applied at all.
  const refExtent = [maxX - minX, maxY - cutY, maxZ - minZ]
  for (let a = 0; a < 3; a++) {
    const ext = bounds[a * 2 + 1] - bounds[a * 2]
    if (ext > 1e-6) gain = Math.min(gain, (BOX_MARGIN * refExtent[a]) / ext)
  }

  const scale = k * gain

  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = (positions[i * 3] - cx) * scale
    positions[i * 3 + 1] = (positions[i * 3 + 1] - cutY) * scale
    positions[i * 3 + 2] = (positions[i * 3 + 2] - cz) * scale
  }

  // Re-seat. Usually a no-op: something was clamped, so the bed plane is already
  // the lowest point. But a coarse solid can miss the bed entirely -- an
  // icosahedron's lowest vertex points at y = -0.851, not -1, so a rock with
  // `sit` under about 0.1 has nothing down there to clamp -- and the tier would
  // hover above the ground by a few per cent of its height. A floating rock is a
  // bug at every distance; drop it onto its own lowest vertex.
  let sitY = Infinity
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < sitY) sitY = positions[i]
  }
  if (sitY > 1e-6) {
    for (let i = 1; i < positions.length; i += 3) positions[i] -= sitY
  }

  // --- normals and UVs, per face ------------------------------------------
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const layers = new Float32Array(vertexCount)
  const index = new Uint32Array(vertexCount)

  const smooth = Math.min(1, Math.max(0, p.smooth))

  // Metres per tile repeat, derived from the rock rather than from the world.
  // Jittered off the seed only: `size` must not enter the roll or two rocks that
  // differ solely in scale would get different grain, and the tier must not enter
  // it or the texture would rescale under an LOD switch.
  const jitter = 1 + Math.max(0, p.texJitter) * (mulberry32((p.seed | 0) * 7919 + 3)() * 2 - 1)
  const repeats = Math.max(0.05, p.texRepeat * jitter)
  const metres = Math.max(0.005, p.size / repeats)

  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const p0 = new THREE.Vector3()
  const fn = new THREE.Vector3()

  for (let f = 0; f < vertexCount; f += 3) {
    p0.fromArray(positions, f * 3)
    ab.fromArray(positions, (f + 1) * 3).sub(p0)
    ac.fromArray(positions, (f + 2) * 3).sub(p0)
    fn.copy(ab).cross(ac)
    const area = fn.length()
    if (area > 1e-9) fn.divideScalar(area)

    // A face all three of whose vertices were pinned by the same plane is a
    // fracture face. It stays flat however high `smooth` goes -- otherwise the
    // slider that softens the lumps also dissolves the only thing that made the
    // shape read as stone. A degenerate face (clamped flat by `sit`) has no
    // usable normal at all and falls back to the shell.
    const flat = area <= 1e-9 ? false : facets[f] >= 0 && facets[f] === facets[f + 1] && facets[f] === facets[f + 2]
    const blend = flat ? 0 : smooth

    // Dominant-axis planar projection. `abs` of the FACE normal, so the two
    // halves of a cut face never disagree about which axis they project from.
    const ex = Math.abs(fn.x)
    const ey = Math.abs(fn.y)
    const ez = Math.abs(fn.z)
    const axisId = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2

    for (let j = 0; j < 3; j++) {
      const i = f + j
      let nx = shells[i * 3]
      let ny = shells[i * 3 + 1]
      let nz = shells[i * 3 + 2]
      if (area > 1e-9) {
        nx = fn.x + (nx - fn.x) * blend
        ny = fn.y + (ny - fn.y) * blend
        nz = fn.z + (nz - fn.z) * blend
      }
      const nl = Math.hypot(nx, ny, nz) || 1
      normals[i * 3] = nx / nl
      normals[i * 3 + 1] = ny / nl
      normals[i * 3 + 2] = nz / nl

      const px = positions[i * 3]
      const py = positions[i * 3 + 1]
      const pz = positions[i * 3 + 2]
      if (axisId === 0) {
        uvs[i * 2] = pz / metres
        uvs[i * 2 + 1] = py / metres
      } else if (axisId === 1) {
        uvs[i * 2] = px / metres
        uvs[i * 2 + 1] = pz / metres
      } else {
        uvs[i * 2] = px / metres
        uvs[i * 2 + 1] = py / metres
      }

      layers[i] = p.texLayer
      index[i] = i
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geo.setAttribute('uvProj', new THREE.BufferAttribute(uvs, 2))
  geo.setAttribute('texLayer', new THREE.BufferAttribute(layers, 1))
  // Identity index. The geometry is non-indexed by construction -- every face
  // needs its own normals and its own projection axis -- but BatchedMesh only
  // accepts indexed geometry, so it gets one that shares nothing.
  geo.setIndex(new THREE.BufferAttribute(index, 1))
  geo.computeBoundingSphere()

  geo.userData.rock = {
    triangles: vertexCount / 3,
    vertices: vertexCount,
    shards: Math.max(1, Math.round(p.shards)),
    cuts: Math.max(0, Math.round(p.cuts)),
    // Whether the underside was thrown away, and how many faces that cost. A
    // closed rock reports 0 and `triangles` is then exactly tier faces x shards;
    // an open one is short by this much and nothing should expect otherwise.
    openBottom: p.openBottom ? 1 : 0,
    dropped: tier.faces * Math.max(1, Math.round(p.shards)) - vertexCount / 3,
    tier: tier.name,
    // How much this tier had to be inflated to read the same size as the dense
    // reference. 1.00 means the sampling lost nothing; the coarser the solid,
    // the further above 1 it climbs.
    gain,
    // What the tile ended up covering, after the per-seed jitter. Reported
    // because it is no longer a constant anyone can look up.
    texMetres: metres,
    texRepeat: repeats,
    // The SHAPE's extents, from the dense reference pass, so every tier of one
    // rock reports the same box. A coarse tier's own bbox is a little smaller
    // because it is inscribed in this one -- that is the point, not an error.
    measured,
  }
  return geo
}
