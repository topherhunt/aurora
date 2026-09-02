import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural rocks. The argument is DESIGN.md §23; this is the contract.
//
// A rock is an OPAQUE CLOSED LUMP whose silhouette IS the geometry -- there is no
// alpha channel to hide in, so the whole job is spending a handful of triangles on
// a shape that reads as stone. Three mechanisms do it.
//
// 1. DISPLACEMENT IS A PURE FUNCTION OF THE ORIGINAL UNIT DIRECTION. Every vertex
//    starts on the unit sphere and its final position comes from `shapePoint`,
//    which is deterministic and stateless -- nothing depends on which solid, how
//    many vertices, or what order. So the ico at detail 0/1/3 (20/80/320 faces,
//    20*(detail+1)^2) samples THE SAME ROCK at three resolutions, and a tier change
//    is a silhouette that simplifies rather than a rock that pops. Purity does not
//    equalise SIZE -- 20 directions lose every peak between samples -- so each tier
//    gets one uniform gain matching its mean silhouette radius to a dense reference.
//
// 2. FLAT FACES COME FROM RADIAL PLANE CLIPPING, NOT NOISE. Noise alone gives you a
//    potato; stone reads as stone through flat facets meeting at hard edges. Each
//    vertex is clipped radially from its shard centre:
//        r_max = min over planes with dot(p, n_i) > 0 of  c_i / dot(p, n_i)
//    Chosen because it is ORDER-INDEPENDENT, NEVER INVERTS a triangle (vertices only
//    move inward along their own ray), and needs no iteration. A face whose three
//    vertices were pinned by the SAME plane is shaded flat regardless of `smooth`,
//    or turning smoothing up rounds the fractures away and the potato is back.
//
// 3. ONE TILE (LAYER.ROCK), TINTED PER INSTANCE via BatchedMesh.setColorAt, so
//    granite, basalt, sandstone, wet shale and lichen-green are one draw call. The
//    tile is graded bright and near-neutral because a tint is a multiply. UVs are a
//    per-face planar projection off the dominant world axis, divided by an extent
//    that SCALES WITH THE ROCK (see texRepeat) rather than by fixed world metres.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, indexed with an
// identity index. That is the shared prop material's layout (src/material.js) and
// BatchedMesh rejects a geometry that disagrees. Unlike buildFern there is no second
// `uv` layout, because gen-rock.html renders the real material.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// The mesh tiers, coarsest last. `faces` is per SHARD -- a 3-shard outcrop at
// T80 is 240 triangles -- which is why `shards` is the most expensive slider on
// the bench by a wide margin and the budget panel prints the product.
//
// EVERY ROCK SHIPS ALL THREE, whatever size it is, and T8 is gone: an octahedron
// keeps the proportions and the lean and nothing else, while a two-triangle
// photograph below it is better at every distance where either is legible. The size
// argument lives entirely in ROCK_LOD_AT's thresholds, never in which meshes a
// shape owns -- §23 records why a per-size-class ladder could not work.
//
// A RUNG IS ITS SUBDIVISION LEVEL AND NOTHING ELSE -- `rockTier` derives the name
// and the face count from it, so the table cannot say T320 while building 80.
// Three splits each edge into `detail + 1`, hence 20 * (detail + 1)^2 rather than
// a doubling.
export function rockTier(detail, solid = 'ico') {
  const d = Math.max(0, Math.round(detail))
  const perSolid = solid === 'oct' ? 8 : 20
  const faces = perSolid * (d + 1) ** 2
  return { name: `T${faces}`, solid, detail: d, faces }
}

// How fine the bench may go past the ladder. 5 is 720 faces a shard, which is
// already finer than the reference the tiers are measured against -- see
// REFERENCE_DETAIL, which follows whatever is asked for.
export const ROCK_MAX_DETAIL = 5

export const ROCK_TIERS = [rockTier(3), rockTier(1), rockTier(0)]

// WHEN A ROCK STEPS DOWN THAT LADDER, in metres of camera distance PER METRE of
// the rock's own size -- `rockLodSize` below says which metre that is. One
// number per boundary: T320 inside the first, T80 inside the second, T20 inside
// the third, and the two-triangle billboard card beyond it.
//
// Per metre because what decides whether a triangle is worth drawing is ANGULAR
// size. A 2 m rock holds its finest mesh to 8 m, its second to 15, its third to 50,
// and cards past that; a 12 m tor holds T320 to 48 m and cards at 300. One system
// for every rock -- they all step at the same apparent size, only the metres differ.
//
// Deliberately tighter than a pixel-error argument, which wants ~70 m per metre
// before the card against this 25: the ladder is set to buy back triangles, not to
// be invisible. This is the number to move if a band looks wrong -- nothing else in
// the system encodes a distance.
export const ROCK_LOD_AT = [4, 7.5, 25]

// THE METRE THE LADDER IS MEASURED IN: the LONGEST AXIS of the rock's box.
//
// Not height: a `shingle` is 1.2 m across and 11 cm tall and would be a billboard
// at 2.7 m, close enough to step on. Not width: a `spire` 2.5 m across and 6 m tall
// would card while still filling a third of the screen. The longest axis is the
// RIGHT quantity rather than a compromise -- the largest extent a box can present to
// any camera -- and it matters most for the card, which spins to face the eye and so
// looks that size from every bearing at once. Depth is in with width because the
// bank elongates in plan (`elongate` past 2), so the long horizontal axis is as
// often z as x. A CEILING on apparent size: worst case a slab seen exactly edge-on
// carries a finer mesh than it needs (§23).
export function rockLodSize(measured) {
  return Math.max(measured.height, measured.width, measured.depth)
}

// Where the rail stops being a rail. MEASURED, not chosen: drive every roughness
// slider on the bench to its ceiling at once -- lumps 0.9, grain 0.5 at freq 12,
// jitter 0.35, full strata -- and over 40 seeds the steepest vertex on the finest
// tier juts 43.6 degrees. Nothing this generator can build reaches 60, so at and
// above it the rail cannot bind and the four extra field samples are skipped
// rather than spent proving it. It is also why the bench's slider stops there: a
// dial whose top half provably does nothing is a dial nobody trusts.
const ANGLE_OFF = 60

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
  // Off the ladder entirely: a raw subdivision level, 0..ROCK_MAX_DETAIL, which
  // OVERRIDES `tier` when it is a number. /gen-rock's resolution slider, and the
  // dial a finer LOD0 gets chosen on before it is promoted into ROCK_TIERS.
  detail: null,

  // --- surface -------------------------------------------------------------
  // Two octaves and no more. A third costs a slider and reads as noise rather
  // than as rock, because below `grain`'s scale the 128px speckle is doing the
  // work and geometry cannot compete with it.
  lumps: 0.2, // large-scale radial displacement -- the mass of the rock
  lumpFreq: 1.6,
  grain: 0, // small-scale -- the bumps that catch light along an edge
  grainFreq: 5.0,
  smooth: 1, // 0 = every face flat-shaded, 1 = one smooth shell. Cut facets ignore it.

  // Both of the dials above move a vertex ALONG ITS OWN DIRECTION, so however hard
  // they are driven an icosphere keeps the even geodesic triangles it was born
  // with: the silhouette wobbles and the tessellation still reads as a ball. This
  // one displaces vertices SIDEWAYS as well -- see jitterOffset -- which is the
  // part that makes a surface look broken rather than moulded. As a fraction of the
  // unit radius; a T320 vertex sits about 0.28 of that from its neighbours, so past
  // ~0.3 vertices start to trade places and triangles fold through each other.
  vertexJitter: 0.12,
  // ...AND THE RAIL THAT KEEPS THAT ROUND. A cap on how far a vertex may stand off
  // the average of its neighbours, expressed as the ANGLE the surface makes there:
  // ANGLE_OFF is off, 35 lets a blob keep a shoulder, 15 is a river cobble. It is
  // measured against the FINISHED point, so it tames lumps, grain and jitter
  // together rather than any one of them. See shapePoint for what it costs, and
  // ANGLE_OFF for why the useful half of the dial is the bottom half.
  maxAngle: ANGLE_OFF,

  // --- fracture ------------------------------------------------------------
  cuts: 0,
  cutDepth: 0.78, // 0 = planes tangent (no cut), 1 = deep slices
  cutBias: 0, // -1 bedding (horizontal faces), +1 columnar (vertical faces)

  // --- profile -------------------------------------------------------------
  // See profileRadial: these three scale the HORIZONTAL semi-axes only, never
  // the vertical one, so a taper sharpens a rock to a point instead of chopping
  // its height off.
  taper: 0.0, // >0 narrows the top (spire), <0 narrows the base (mushroom, glacial erratic)
  taperPow: 1.6, // how the narrowing is distributed up the height. >1 = shoulders, then a tooth
  foot: 0.4, // flare on the bottom half only, so a tall rock stands on something solid
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
  sit: 0, // fraction of total height cut away at the bottom

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
// `shapeRadius`: it scales the two HORIZONTAL semi-axes and leaves the vertical one
// alone, which is the whole reason it is a separate function. An ISOTROPIC multiply
// on the radius cannot make a spire -- a vertex's height is dy * ay * r, so shrinking
// r near the top shrinks the HEIGHT there and the profile folds into a dome past
// taper ~0.5 (§23). Scaling only x and z keeps height monotone in dy, and `foot`
// flares the bottom half INDEPENDENTLY.
//
// `taperPow` distributes the narrowing: 1 is a linear cone, above 1 is the
// shoulders-and-a-tooth profile of a weathered pinnacle, below 1 is a needle. A
// negative `taper` narrows the BASE instead -- the erratic and the mushroom, the same
// curve mirrored, so `taperPow` means the same thing.
//
// The 0.94 clamps stop a horizontal semi-axis reaching zero, where the clip below
// would divide by a degenerate radius; the 0.04 floor is the same guard for the
// product.
function profileRadial(dy, p) {
  const t = dy * 0.5 + 0.5 // 0 at the bed plane, 1 at the crown
  const pow = Math.max(0.2, p.taperPow)
  let h = 1
  if (p.taper > 0) h -= Math.min(0.94, p.taper) * Math.pow(t, pow)
  else if (p.taper < 0) h += Math.max(-0.94, p.taper) * Math.pow(1 - t, pow)
  // A batter, not a skirt: quadratic in the distance below the crown, so most of the
  // flare is in the bottom third and has faded to nothing by the top. It has to reach
  // well above the bed plane because `sit` flattens the bottom `sit` of the height
  // onto that plane -- a flare peaking only at t = 0 would be entirely inside the
  // clamped part, and the dial would look broken at the settings that want it most.
  if (p.foot > 0) h *= 1 + p.foot * (1 - t) * (1 - t)
  return Math.max(0.04, h)
}

// How fast the jitter field turns over, in cells per unit of direction. Set
// against the FINEST tier's vertex spacing -- a T320 vertex sits 0.28 radians from
// its neighbours, so at 7 they are two cells apart and land on independent
// numbers. Much lower and the warp is a second `lumps`; much higher and it is a
// dither no tier can resolve and every tier resolves differently.
const JITTER_FREQ = 7

// The neighbour offset the roundness rail measures against, in radians, and
// deliberately a CONSTANT rather than the tier's own spacing: a limit that read
// the vertex count would round a T20 harder than a T320 and the two would stop
// being the same rock. 0.25 is about one T320 edge.
const ANGLE_EPS = 0.25
const DEG = Math.PI / 180


const nbPoint = { x: 0, y: 0, z: 0 }

/**
 * One vertex, in the shard's frame, before the cut planes.
 *
 * A pure function of the unit direction, like `shapeRadius`, and for the same
 * reason: two tiers hand it the same direction along a silhouette and have to get
 * back the same point or the rock moves when it swaps.
 *
 * `vertexJitter` is the part `shapeRadius` cannot do. Radial displacement leaves an
 * icosphere's even geodesic triangles exactly as even as it found them, however
 * hard it is driven -- what breaks that regularity is moving vertices SIDEWAYS, so
 * this adds a three-channel noise vector: a domain warp, not a height field.
 */
function surfacePoint(dx, dy, dz, p, nseed, phase, ax, ay, az, out) {
  const r = shapeRadius(dx, dy, dz, p, nseed, phase)
  const hr = profileRadial(dy, p)
  out.x = dx * ax * hr * r
  out.y = dy * ay * r
  out.z = dz * az * hr * r

  if (p.vertexJitter > 0) {
    const fx = dx * JITTER_FREQ
    const fy = dy * JITTER_FREQ
    const fz = dz * JITTER_FREQ
    const j = p.vertexJitter
    out.x += ax * hr * j * (noise3(fx + 1.7, fy + 9.2, fz + 4.4, nseed ^ 0x1f83d9ab) * 2 - 1)
    out.y += ay * j * (noise3(fx + 6.1, fy + 2.8, fz + 13.5, nseed ^ 0x5be0cd19) * 2 - 1)
    out.z += az * hr * j * (noise3(fx + 12.9, fy + 7.3, fz + 0.6, nseed ^ 0x9b05688c) * 2 - 1)
  }
  return out
}

/**
 * The same vertex with the roundness rail applied: a vertex may not stand further
 * off the mean of its four angular neighbours than tan(`maxAngle`) times their
 * spacing, which is exactly the statement "no face may jut at more than this angle".
 *
 * WHY A NEIGHBOURHOOD AND NOT A CLAMP ON EACH DIAL: a spike is not a large radius,
 * it is a large radius NEXT TO a small one. Capping `lumps` or `vertexJitter`
 * flattens the whole rock to kill a handful of teeth; this pulls the teeth in and
 * leaves the mass alone, which is what "round even when there are blobs" asks for.
 *
 * It costs four extra field evaluations per vertex, at build time only, and is
 * skipped entirely at 90 where it can never bind. Note it cannot see the cut
 * planes -- a `cuts` facet is a deliberate sharp edge and is not its business.
 */
function shapePoint(dx, dy, dz, p, nseed, phase, ax, ay, az, out) {
  surfacePoint(dx, dy, dz, p, nseed, phase, ax, ay, az, out)
  if (!(p.maxAngle < ANGLE_OFF)) return out

  // Any two tangents will do: the four samples are symmetric about the direction,
  // so their mean barely moves as the basis spins.
  let ux = 0
  let uy = 0
  let uz = 0
  if (Math.abs(dx) < Math.abs(dy) && Math.abs(dx) < Math.abs(dz)) ux = 1
  else if (Math.abs(dy) < Math.abs(dz)) uy = 1
  else uz = 1
  let t1x = dy * uz - dz * uy
  let t1y = dz * ux - dx * uz
  let t1z = dx * uy - dy * ux
  const t1l = Math.hypot(t1x, t1y, t1z) || 1e-6
  t1x /= t1l
  t1y /= t1l
  t1z /= t1l
  const t2x = dy * t1z - dz * t1y
  const t2y = dz * t1x - dx * t1z
  const t2z = dx * t1y - dy * t1x

  let bx = 0
  let by = 0
  let bz = 0
  for (let k = 0; k < 4; k++) {
    const s = k < 2 ? (k === 0 ? ANGLE_EPS : -ANGLE_EPS) : 0
    const t = k < 2 ? 0 : k === 2 ? ANGLE_EPS : -ANGLE_EPS
    let nx = dx + t1x * s + t2x * t
    let ny = dy + t1y * s + t2y * t
    let nz = dz + t1z * s + t2z * t
    const nl = Math.hypot(nx, ny, nz) || 1e-6
    nx /= nl
    ny /= nl
    nz /= nl
    surfacePoint(nx, ny, nz, p, nseed, phase, ax, ay, az, nbPoint)
    bx += nbPoint.x
    by += nbPoint.y
    bz += nbPoint.z
  }
  bx /= 4
  by /= 4
  bz /= 4

  // Their spacing, which is the run the jut's rise is measured against.
  const span = ANGLE_EPS * Math.hypot(bx, by, bz)
  if (span < 1e-6) return out

  // ALONG THE SURFACE NORMAL ONLY. A vertex slid SIDEWAYS is not a jut -- it is an
  // uneven triangle, which is the whole point of `vertexJitter` -- and measuring the
  // full deviation would spend the budget on it and leave nothing for the spikes
  // this exists to catch. The ellipsoid normal rather than the direction, for the
  // same reason the shell normals use it: on a 2:1 rock they differ by 30 degrees.
  const hr = profileRadial(dy, p)
  let nx = dx / (ax * hr)
  let ny = dy / ay
  let nz = dz / (az * hr)
  const nl = Math.hypot(nx, ny, nz) || 1e-6
  nx /= nl
  ny /= nl
  nz /= nl

  const rise = (out.x - bx) * nx + (out.y - by) * ny + (out.z - bz) * nz
  const limit = Math.tan(Math.max(1, p.maxAngle) * DEG) * span
  if (Math.abs(rise) > limit) {
    const pull = rise > 0 ? rise - limit : rise + limit
    out.x -= nx * pull
    out.y -= ny * pull
    out.z -= nz * pull
  }
  return out
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

    // Offset measured against the TAPERED ellipsoid's support in this direction, so a
    // cut bites the same proportion of a flat slab as of a tall spire. Taking it from
    // the bare semi-axes lands the plane outside a crown narrowed to a fifth of them,
    // so the columnar planes that should make the top toothy sail past it and the tip
    // comes out a smooth cone. Identical to the bare form wherever taper and foot are
    // 0.
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
// that ships. See the note at the call site: measuring each tier on its own
// vertices would give each tier a different bounding box and therefore a
// different rescale, and the LOD transition would visibly change the rock's
// height. Measuring them all on one dense set makes the coarse tiers INSCRIBED
// in the fine one -- which is what a lower LOD should be.
//
// DERIVED FROM THE LADDER RATHER THAN TYPED, because the invariant is not "320
// faces", it is "finer than every rung". Promote a finer LOD0 into ROCK_TIERS and
// this follows it, and every tier of a shape is re-measured together -- which is
// the only way `measured` stays one box per shape. A hard-coded 3 under a detail-3
// rung would silently measure the finest tier against itself.
const REFERENCE_DETAIL = Math.max(3, ...ROCK_TIERS.map((t) => t.detail + 1))
const REFERENCE_DIRS = (detail) => solidDirections('ico', Math.max(REFERENCE_DETAIL, detail + 1))

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

// How far outside the reference's bounding box a tier may reach once scaled up to
// match. Deliberately loose: pinning it near 1.0 keeps `size` literally true of
// every tier but trades the error nobody can see for the one everybody can -- a
// coarse solid's vertices sit ON the shape while everything between is cut away, so
// holding its box to the reference's leaves it 13% short in apparent radius.
//
// 1.8 because A CAP THAT BINDS IS A BIAS GENERATOR: the gain is one uniform number
// and the cap is taken on the worst axis, so a spire whose T20 bulges in x comes out
// 22% short in y -- the very shrink the gain exists to remove, reintroduced by its
// own safety rail. Over 60 seeds x 9 shapes x three coarse tiers: at 1.3, 46 of 1620
// builds bound and the worst was 29% off; at 1.8 it is 0 of 1620, worst 2.3%. So it
// catches only a degenerate build, which is all it was ever for. Collision and
// spacing read `measured`, which is the reference's box, not a tier's.
export const BOX_MARGIN = 1.8

/**
 * The rock's MEAN horizontal silhouette width, averaged over the compass.
 *
 * WHAT IT IS FOR is the billboard. `width` and `depth` are the box, so
 * `max(width, depth)` is the WIDEST the rock can ever look -- and a card sized to
 * that is that wide from every bearing, because it spins to face the eye. Over the
 * bank the widest extent averages 1.4x the mesh's actual silhouette and reaches
 * 1.7x on the slabs, so a rock swapping to its card visibly swelled. The mean makes
 * the swap free on average, which is all a single quad can promise.
 *
 * A HALF TURN, because the extent along a bearing and along its opposite are the
 * same measurement. 90 steps is 2 degrees against a signal whose whole variation is
 * the aspect ratio -- doubling them moves the answer by under a tenth of a percent
 * on every shape in the bank.
 *
 * Taken on the SEATED reference, like every other entry in `measured`, so the buried
 * belly is flattened rather than counted.
 */
function meanPlanWidth(pos, steps = 90) {
  let total = 0
  for (let s = 0; s < steps; s++) {
    const a = (s / steps) * Math.PI
    const rx = Math.cos(a)
    const rz = -Math.sin(a)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      const u = pos[i] * rx + pos[i + 2] * rz
      if (u < lo) lo = u
      if (u > hi) hi = u
    }
    total += hi - lo
  }
  return total / steps
}

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
  const vertex = { x: 0, y: 0, z: 0 }

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

      // Horizontal only -- see profileRadial. The vertical axis is deliberately
      // untouched, so the crown of a tapered rock is still at dy = 1. Kept here
      // for the shell normal below; shapePoint applies its own.
      const hr = profileRadial(dy, p)
      shapePoint(dx, dy, dz, p, nseed, phase, ax, ay, az, vertex)
      let px = vertex.x
      let py = vertex.y
      let pz = vertex.z

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
  // `tier` names a RUNG OF THE SHIPPING LADDER; `detail` names a RESOLUTION, and
  // is how the bench looks at ones the ladder does not carry yet. Null on every
  // path but /gen-rock, so the world reads the ladder and nothing else.
  const rung = ROCK_TIERS[Math.min(ROCK_TIERS.length - 1, Math.max(0, Math.round(p.tier)))]
  const tier = Number.isFinite(p.detail)
    ? rockTier(Math.min(ROCK_MAX_DETAIL, p.detail), rung.solid)
    : rung

  // Semi-axes. `size` is applied at the very end by measuring, so these only
  // have to carry the PROPORTIONS.
  const ax = Math.max(0.05, p.elongate)
  const ay = Math.max(0.05, p.squash)
  const az = Math.max(0.05, 1 / p.elongate)

  // --- measure the rock, once, on a set of directions no tier uses ---------
  // This is the one place the tiers are tied together. A T20 icosahedron samples
  // twenty directions and misses every peak between them, so its own bounding box
  // is shorter than a T80's; measure each tier on its own vertices and
  // every one of them gets a different bed plane, a different centre and a
  // different scale, and the rock jumps at every LOD change. One dense
  // measurement decides all three for all three tiers instead. What is left over
  // after that -- the AREA a coarse solid loses between its samples -- is what
  // the support gain further down corrects.
  const ref = []
  emitShards(p, ax, ay, az, REFERENCE_DIRS(tier.detail), ref, null)

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
    // Not a fourth box axis -- the mean of the box's own horizontal extent over
    // every bearing. See meanPlanWidth; the billboard is what wants it.
    planMean: meanPlanWidth(ref) * k,
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
  // That is fine and it is why the rock is CLOSED: it is buried, and a solid
  // with a floor can be turned onto any face without opening a hole in itself.
  for (let i = 1; i < positions.length; i += 3) {
    if (positions[i] < cutY) positions[i] = cutY
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

  // Match this tier's average silhouette radius to the reference's. Sampling a lumpy
  // shape on 20 directions instead of 320 does not just round the corners off, it
  // loses AREA -- every peak between two samples is cut away -- so an untouched T20
  // reads smaller than the T320 it replaces and the swap looks like the rock jumping
  // backwards. One uniform gain about the bed origin buys that back with proportions,
  // lean and bed plane untouched. What it cannot fix is the SPREAD, and that is the
  // right trade: a silhouette that is the right size and the wrong shape is invisible
  // at the range a T20 is drawn at; the right shape at the wrong size is a jump.
  const tierSupport = meanSupport(positions, cx, cy, cz)
  let gain = tierSupport > 1e-6 ? refSupport / tierSupport : 1

  // ...with a loose bounding-box cap on top, for the pathological case only.
  // The gain is an average and a coarse solid's error is not evenly spread --
  // its vertices sit ON the shape while everything between them is cut away -- so a
  // gain that fixes the average necessarily pushes those poles outside the real
  // rock. That is allowed, up to BOX_MARGIN; read the argument there for why the
  // overhang is the cheaper error. The cap can bite a FINE tier too, for an
  // unrelated reason: an ico detail 2 vertex can point somewhere detail 3 never
  // sampled, so a slab's T320 occasionally measures wider than the reference
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
    // How many faces went missing against tier faces x shards. ALWAYS 0 -- the
    // rock is closed and nothing drops a face -- and reported so that a change
    // to the shard or cut machinery that quietly loses geometry has somewhere
    // to show up. check-rocks.mjs holds it at zero.
    dropped: tier.faces * Math.max(1, Math.round(p.shards)) - vertexCount / 3,
    tier: tier.name,
    // The rung that was actually BUILT, which is not always the one `tier`
    // named: /gen-rock's resolution slider builds off-ladder tiers, and a reader
    // that looked its faces up in ROCK_TIERS would report the wrong number.
    faces: tier.faces,
    detail: tier.detail,
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
