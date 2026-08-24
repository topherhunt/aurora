import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural trees and bushes.
//
// Three primitives, and that is the whole tree:
//
//   TRUNK    one solid cone, `trunkSides` around, closing to a POINT at the
//            top, wearing bark. `trunkRings` only buys subdivision for the lean.
//   LIMBS    solid cones too, launched off the trunk and bent over by
//            `branchDroop` along a path that is integrated exactly the way a
//            fern frond is. A limb is a branch off the trunk OR a fork off a
//            branch -- same code, one level deep, so
//            `limbs = branches x (1 + forks)`.
//   FOLIAGE  leaf-spray cutouts off the texture array, in one of two modes --
//            see CARDS OR CLOAKS below.
//
// A CONE THAT ENDS IN A POINT IS THE CHEAP SOLID. A tube of `sides` x `rings`
// quads costs `sides x rings x 2` triangles and ends in a flat cap that is a
// lie: real trunks and real branches taper to nothing. Ending in an APEX
// instead makes the last ring a fan of single triangles, so one ring plus a
// point -- which is the whole of a branch and the whole of a conifer trunk --
// is exactly `sides` triangles. Five triangles buys a solid branch where two
// used to buy a flat ribbon, and eight buys a solid trunk where forty-eight
// bought a tube with a cap on it.
//
//   cone(sides, rings) = sides x ((rings - 1) x 2 + 1)
//   limbs              = branches x (1 + forks)
//   tris = cone(trunkSides, trunkRings)
//        + limbs x cone(branchSides, branchRings)
//        + limbs x (cloaked ? 2 x cloakQuads x 2 : sprays x 2)
//
// which is the number the previewer (gen-tree.html) puts at the top of its
// budget panel. DESIGN.md §5 gives the tree class 500 and 130 triangles for its
// two mesh tiers and the bush class 84 / 56 / 28; both are reachable by moving
// the counts above and nothing else, which is what makes an LOD tier a
// re-generation rather than a decimation. See §9 bugs 10-11 for why decimating
// card foliage does not work at all.
//
// MACRO SHAPE IS A CROWN PROFILE, NOT A "TRIANGULARITY" SLIDER. What actually
// separates a pine from an oak is *where up the tree the branches are longest*.
// A pine's longest branches are at the very bottom of its crown and they
// shorten all the way to the tip; an oak's are halfway up with the crown
// falling away above AND below; a birch is somewhere between, widest about a
// third up. That is two numbers -- `crownPeak` (where the widest branch is, as
// a fraction of the crown) and `crownFullness` (how fast it falls away from
// there) -- and one slider could not have covered it, because a cone and a
// sphere differ in where the maximum sits, not in how sharp the top is.
//
//   crownPeak 0.0, fullness 1.0   cone            pine, spruce
//   crownPeak 0.35, fullness 0.8  egg             birch
//   crownPeak 0.5, fullness 0.5   round           oak, maple
//   crownPeak 0.5, fullness 2.0   spindle         poplar, cypress
//   crownPeak 0.9, fullness 1.0   inverted cone   an old open-grown oak
//
// HEIGHT IS A SHAPE PARAMETER *AND* A PLACEMENT ONE, and those are different
// things. Everything here is expressed as a fraction of `height`, so two builds
// that differ only in `height` are exact scaled copies of each other -- which
// is correct for the per-instance scale jitter the scatter applies at placement
// (it is the same plant a bit bigger), and WRONG as a way to make a dwarf pine.
// A real dwarf pine is not a scaled tower: its trunk is proportionally thicker,
// its first branch is proportionally lower, and its branches are proportionally
// longer. So a size ladder in the variant bank has to move `trunkRadius`,
// `firstBranch` and `branchLength` alongside `height`, and the previewer prints
// all three in metres for exactly that reason.
//
// FOLIAGE IS MANY SMALL SPRAYS, NOT A FEW BIG CARDS. The tempting way to make
// a canopy look full is to grow the leaf cards until they cover the gaps, and
// it is always wrong: the art on a card is a spray of leaves at a real size, so
// a card scaled to 2 m is a spruce needle two feet long. `sprayMetres` is
// therefore in WORLD METRES -- the stem-to-tip reach of one spray, half a metre
// or less, and it stays that whether it is on a sapling or a hundred-year tree.
// That is the one place in this file deliberately not scale-invariant, and
// lushness has to be bought with COUNT instead.
//
// CARDS OR CLOAKS. `foliage` picks how that count is paid for.
//
//   'cards'  one quad per spray. Sprays leave a limb SIDEWAYS (`sprayOut`) at
//            stratified-random points along it, at golden-angle azimuths, with
//            one terminal card continuing the twig. Two triangles each, so
//            density costs triangles. Right for broadleaves, whose foliage is
//            clumps rather than rows.
//
//   'cloak'  two long tapering flaps hinged on the limb, with the spray TILED
//            along them. A conifer branch really is a planar fan of needled
//            twigs, so two flaps in a shallow V (`cloakDihedral`) is what one
//            looks like -- and the tile count is a UV number, so twenty sprays
//            on a branch cost the same four triangles as one. This is the whole
//            reason a pine can afford to have needles the right size.
//
//            The art must be the PADDED cut (trees/spray_pine.png, `pad` in
//            gen-layers.mjs): the plain cut is cropped hard to its alpha bounds,
//            so tiling it fuses each spray into the next. And the art is turned
//            a quarter turn -- the tile repeats along the art's WIDTH, while its
//            stem-to-tip axis runs ACROSS the flap, stem on the branch. Hence
//            `cloakAspect` rather than `sprayAspect`: tile length is
//            `sprayMetres x cloakAspect`.
//
//            The tile count is CEILED, not fitted, so a flap is always a whole
//            number of sprays and no spray is ever sliced. That makes a flap
//            run past the twig tip by up to one tile, which is what a real
//            branch tip looks like, and it means a limb shorter than one tile
//            gets exactly one -- a short branch degrades to two plain cards
//            without a second code path.
//
// `forks` buys the other half of lushness. A single limb with foliage on it
// reads as a broom; a branch that splits once carries its foliage out into two
// directions and doubles the places foliage can attach without touching the
// trunk's branch count.
//
// ATTRIBUTES: one layout, always `{ position, normal, uvProj, texLayer }` --
// the shared prop material's (src/material.js). fern.js carries two layouts
// because a fern is one texture and can be previewed through `material.map`; a
// tree is bark AND leaves in one mesh, so per-vertex `texLayer` is not an
// option it can decline. The previewer renders the real array material.
// ---------------------------------------------------------------------------

export const TREE_DEFAULTS = {
  seed: 1,

  // --- size ---
  height: 9,           // metres, tip to root. Geometry is rescaled to hit this

  // --- trunk ---
  trunkSides: 8,       // sides around. 8 reads as round at any distance you can
                       // make out a trunk from; this is the LOD0 number, and a
                       // cheaper tier drops it rather than decimating the mesh
  trunkRings: 1,       // rings BELOW the apex. The trunk always closes to a
                       // point, so 1 is a plain cone at `trunkSides` triangles;
                       // raise it only to let `trunkBend` show as a curve
                       // instead of a lean
  trunkRadius: 0.028,  // base radius as a FRACTION of height (0.028 x 9 m = 25 cm)
  trunkBend: 0.05,     // sideways offset of the top, as a fraction of height
  barkRepeat: 8,       // bark tiles UP the trunk this many times; the tiling
                       // AROUND it is derived so a tile stays roughly square in
                       // world space -- see the note where the UVs are written

  // --- crown ---
  branches: 13,
  firstBranch: 0.38,   // fraction of height where the LOWEST branch attaches
  branchLength: 0.30,  // the longest branch, as a fraction of height
  crownPeak: 0.0,      // 0..1 -- where up the crown the longest branch sits
  crownFullness: 1.0,  // falloff from the peak. <1 fuller, >1 pointier
  branchMin: 0.12,     // shortest branch as a fraction of the longest, so the
                       // apex and the hem still carry foliage instead of ending
                       // in a zero-length branch with nothing on it
  whorlSize: 1,        // 0 = scattered: every branch gets its own randomised
                       // height, so the trunk shows no repeating pattern.
                       // 1 = spiral (golden angle), evenly spaced up the trunk.
                       // >1 = conifer whorls: this many branches sharing one
                       // height, evenly around. Rings read as regular and fake
                       // on a big tree, which is why 0 exists.
  yawJitter: 0.35,

  // --- branch shape ---
  branchAngle: 0.0,    // radians above horizontal at the trunk, at the crown base
  branchRise: 0.85,    // added to that by the top of the crown, so the apex
                       // branches point up and the hem does not
  branchDroop: 0.55,   // total bend from launch to tip, radians
  branchCurve: 1.5,    // >1 concentrates the bend at the tip
  branchSway: 0.25,    // lateral drift, so a branch is not confined to a plane
  branchSides: 5,      // sides around a limb. <3 draws no limb at all, only its
                       // foliage. Five is the cheapest thing that still reads
                       // as round rather than as a flat ribbon seen edge-on
  branchRings: 1,      // rings below the tip, as trunkRings. 1 = a straight
                       // cone from base to tip, which is the same chord a
                       // one-quad cloak lies along, so the two agree exactly.
                       // 2 makes a strongly drooping branch actually curve, at
                       // twice the triangles
  branchWidth: 0.03,   // base radius as a fraction of the limb's own length

  // --- forks ---
  // One level only. A second level is a geometric series in the triangle count
  // and an unreadable budget panel; if it is ever wanted, `growLimb` already
  // recurses and the guard is the `depth` argument.
  forks: 2,            // child limbs per branch
  forkScale: 0.45,     // child length as a fraction of its parent's
  forkAngle: 0.6,      // radians the child turns off the parent's tangent
  forkStart: 0.3,      // earliest point along the parent a child may split off

  // --- foliage ---
  foliage: 'cards',    // 'cards' or 'cloak' -- see the note at the top
  sprayMetres: 0.5,    // one spray's stem-to-tip reach in WORLD METRES. Not a
                       // fraction: the art is a leaf spray at a real size

  // cards only
  sprays: 6,           // leaf cards per limb, INCLUDING one terminal card
  sprayStart: 0.15,    // earliest point along a limb a side shoot may attach
  sprayOut: 0.8,       // 0 = shoots continue the limb, 1 = straight out its side
  sprayLift: 0.35,     // then turned this far toward vertical
  sprayJitter: 0.6,    // radians of random roll about the card's own up axis
  sprayVary: 0.3,      // +/- this fraction of random size variation per card
  sprayAspect: 1.0,    // card width/height; must match the art (note below)

  // cloak only
  cloakQuads: 1,       // segments per flap. 1 is a straight chord, matching a
                       // one-ring branch cone exactly
  cloakTaper: 0.45,    // fraction of the reach lost by the flap's tip
  cloakDihedral: 0.35, // radians each flap lifts off horizontal. 0 = one flat
                       // plane of needles, which is nearly what a spruce is
  cloakAspect: 1.0,    // tile length / reach; must match the PADDED art

  leafLayer: LAYER.LEAVES,
  barkLayer: LAYER.BARK,
}

// The width/height of the art on each leaf layer, measured from its alpha
// bounds by tools/trees/gen-layers.mjs and pasted in. The card is built at this
// ratio because the layer is a SQUARE and the art was stretched to fill it: a
// card at any other ratio hands back a leaf that is visibly squashed or drawn
// out. Re-run the tool and re-paste if the atlases are ever re-cut.
//
//     oak 0.651   ash 0.642   aspen 0.492   pine 0.781
//
// `cloakAspect` is the same measurement on the PADDED cut, which stands for a
// wider piece of world than the art inside it covers:
//
//     spray_pine 0.961
//
// Presets, not a taxonomy. Each is a starting point in the previewer, and the
// numbers that matter for telling one from another are crownPeak, crownFullness
// and firstBranch -- the rest is character.
export const TREE_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    leafLayer: LAYER.SPRAY_PINE,
    params: {
      foliage: 'cloak',
      cloakAspect: 0.961,
      cloakDihedral: 0.3,
      cloakTaper: 0.5,
      crownPeak: 0.0,
      crownFullness: 1.15,
      firstBranch: 0.2,   // a spruce carries branches most of the way down
      branchLength: 0.3,
      branches: 30,
      whorlSize: 0,       // scattered, not ringed -- see the note on whorlSize
      branchAngle: -0.12,
      branchRise: 0.55,
      branchDroop: 0.30,
      forks: 2,
      forkAngle: 0.5,
      sprayMetres: 0.28,  // needle reach off the twig, not the branch length
      barkRepeat: 8,
      trunkRadius: 0.026,
      trunkBend: 0.02,
    },
  },
  oak: {
    label: 'oak',
    barkLayer: LAYER.BARK,
    leafLayer: LAYER.LEAVES,
    params: {
      sprayAspect: 0.651,
      crownPeak: 0.5,
      crownFullness: 0.5,
      firstBranch: 0.36,
      branchLength: 0.42,
      branches: 12,
      whorlSize: 1,
      branchAngle: 0.32,
      branchRise: 0.5,
      branchDroop: 0.55,
      sprays: 5,
      sprayLift: 0.45,
      sprayMetres: 0.6,
      trunkRadius: 0.045,
      trunkBend: 0.07,
    },
  },
  birch: {
    label: 'birch',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASH,
    params: {
      sprayAspect: 0.642,
      crownPeak: 0.35,
      crownFullness: 0.8,
      firstBranch: 0.45,
      branchLength: 0.20,
      branches: 13,
      whorlSize: 1,
      branchAngle: 0.45,
      branchRise: 0.35,
      branchDroop: 0.95, // birch twigs hang; this is most of what says "birch"
      branchCurve: 2.2,
      sprays: 5,
      sprayLift: 0.2,
      sprayMetres: 0.4,
      trunkRadius: 0.018,
      trunkBend: 0.09,
    },
  },
  aspen: {
    label: 'aspen',
    barkLayer: LAYER.BARK_BIRCH,
    leafLayer: LAYER.LEAF_ASPEN,
    params: {
      sprayAspect: 0.492,
      crownPeak: 0.45,
      crownFullness: 1.6, // narrow and columnar -- aspens grow in stands and
                          // have almost no room to spread sideways
      firstBranch: 0.52,
      branchLength: 0.16,
      branches: 14,
      whorlSize: 1,
      branchAngle: 0.7,
      branchRise: 0.3,
      branchDroop: 0.3,
      sprays: 5,
      sprayLift: 0.4,
      sprayMetres: 0.4,
      trunkRadius: 0.016,
      trunkBend: 0.04,
    },
  },
}

// The overrides that turn any species into a bush of itself. NOT a fifth
// species: a bush is the same plant with no clear trunk, branching from the
// ground, and branches long relative to how tall it is. Keeping it as an
// override is what makes "8 bush variants per species" one axis of the bank
// rather than four more presets to keep in sync.
//
// DELIBERATELY SHORT. An earlier version of this list also set crownPeak,
// crownFullness, the branch angles and the spray counts, and the result was
// that all four species produced the same bush wearing four leaf textures --
// the overrides had overwritten everything that distinguished them. What is
// left here is only what the WORD bush means; the species keeps its own crown
// shape, so a pine bush is a conifer sapling and an oak bush is a round one.
export const BUSH_OVERRIDES = {
  height: 1.1,
  firstBranch: 0.04,   // branching from the ground is most of what "bush" means
  branchLength: 0.62,  // and being wider than it is tall is the rest
  branches: 10,
  trunkSides: 4,
  trunkRings: 1,
  trunkRadius: 0.035,
  barkRepeat: 1,
  forks: 0,            // a bush already branches from the ground; forking it as
                       // well triples the limb count against a 84-triangle budget
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const TAU = Math.PI * 2
const UP = new THREE.Vector3(0, 1, 0)

/**
 * The crown's silhouette: how long the branch at height `t` through the crown
 * is, as a fraction of the longest one. `t` is 0 at the first branch and 1 at
 * the apex.
 *
 * Two straight ramps meeting at `peak`, raised to `fullness`. That is the whole
 * function, and it is enough because a tree's outline really is a rise to one
 * widest point and a fall from it -- the species differences are where that
 * point sits and how convex the fall is.
 */
export function crownProfile(t, peak, fullness) {
  // Clamped rather than special-cased at the ends: peak = 0 then makes the
  // rising ramp infinitely steep, which is exactly the cone we want, and the
  // same for peak = 1 and an inverted cone.
  const p = Math.min(0.999, Math.max(0.001, peak))
  const u = t < p ? t / p : (1 - t) / (1 - p)
  return Math.pow(Math.min(1, Math.max(0, u)), Math.max(0.05, fullness))
}

// Walk a limb's centreline out from its base, turning it a little further over
// at each step. Identical in spirit to fern.js's addFrond, and split out here
// because a tree needs the path itself, not just a ribbon: the leaf cards hang
// off points along it.
//
// The launch is a DIRECTION rather than the (outward, elevation) pair it used
// to be, because a fork leaves a parent that is already drooping and pointing
// somewhere off the horizontal -- there is no meaningful "outward" for it.
// Passing cos(elev) * outward + sin(elev) * UP reproduces the old behaviour
// exactly, which is what a branch off the trunk still does.
function branchPath(base, dir, side, o, n) {
  const horiz = new THREE.Vector3(dir.x, 0, dir.z)
  if (horiz.lengthSq() < 1e-8) horiz.set(side.z, 0, -side.x) // a limb straight up
  if (horiz.lengthSq() < 1e-8) horiz.set(1, 0, 0)
  horiz.normalize()
  const elev = Math.asin(Math.min(1, Math.max(-1, dir.y)))

  const pts = []
  const pos = base.clone()
  for (let k = 0; k <= n; k++) {
    const s = k / n
    const ang = elev - o.droop * Math.pow(s, o.curve)
    const drift = o.sway * s * s
    const tan = new THREE.Vector3()
      .copy(horiz)
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(UP, Math.sin(ang))
      .addScaledVector(side, drift)
      .normalize()
    pts.push({ pos: pos.clone(), tan })
    pos.addScaledVector(tan, o.length / n)
  }
  return pts
}

// Linear interpolation along a path by normalised index. Close enough: the
// paths are integrated at PATH_N = 8 and sampled at a handful of points, so the
// error is under a millimetre at tree scale.
function samplePath(pts, s) {
  const f = Math.min(pts.length - 1, Math.max(0, s * (pts.length - 1)))
  const i = Math.min(pts.length - 2, Math.floor(f))
  const t = f - i
  return {
    pos: new THREE.Vector3().lerpVectors(pts[i].pos, pts[i + 1].pos, t),
    tan: new THREE.Vector3().lerpVectors(pts[i].tan, pts[i + 1].tan, t).normalize(),
  }
}

const PATH_N = 8

// One flat quad. `up` is its long axis and `right` its width; the face normal
// falls out of the pair, and the material draws it double-sided so which way it
// ends up facing costs nothing.
function addCard(out, centre, right, up, w, h, texLayer) {
  const base = out.positions.length / 3
  const n = new THREE.Vector3().crossVectors(right, up).normalize()
  const hw = w / 2
  const hh = h / 2
  const corners = [
    [-hw, -hh, 0, 0],
    [hw, -hh, 1, 0],
    [hw, hh, 1, 1],
    [-hw, hh, 0, 1],
  ]
  for (const [cx, cy, u, v] of corners) {
    out.positions.push(
      centre.x + right.x * cx + up.x * cy,
      centre.y + right.y * cx + up.y * cy,
      centre.z + right.z * cx + up.z * cy
    )
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(u, v)
    out.layers.push(texLayer)
  }
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

// A tapered solid closing to a POINT: `rings` rings of `sides` vertices each,
// then a fan of `sides` triangles to the apex. See the note at the top for why
// the apex is worth having; the cost is
// `sides x ((rings - 1) x 2 + 1)` triangles.
//
// Each ring carries its own frame (`e1`, `e2`) so this serves a trunk, whose
// rings are all horizontal, and a branch, whose rings turn with the path.
function addCone(out, rings, apex, sides, uRepeat, vRepeat, texLayer) {
  const base = out.positions.length / 3
  const stride = sides + 1
  const n = new THREE.Vector3()

  // The seam vertex is duplicated (sides + 1 per ring) so u can run the whole
  // way round; sharing it would wrap the bark backwards over the last face.
  for (const ring of rings) {
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * TAU
      n.copy(ring.e1).multiplyScalar(Math.cos(a)).addScaledVector(ring.e2, Math.sin(a))
      out.positions.push(
        ring.pos.x + n.x * ring.radius,
        ring.pos.y + n.y * ring.radius,
        ring.pos.z + n.z * ring.radius
      )
      out.normals.push(n.x, n.y, n.z)
      out.uvs.push((k / sides) * uRepeat, ring.v)
      out.layers.push(texLayer)
    }
  }

  // The apex is duplicated once per FACE, at the u halfway between that face's
  // two base corners. It is one point in space but a different u on every
  // triangle meeting it, and sharing it would spiral the bark into the tip.
  const last = rings[rings.length - 1]
  const apexBase = base + rings.length * stride
  for (let k = 0; k < sides; k++) {
    const a = ((k + 0.5) / sides) * TAU
    n.copy(last.e1).multiplyScalar(Math.cos(a)).addScaledVector(last.e2, Math.sin(a))
    out.positions.push(apex.x, apex.y, apex.z)
    out.normals.push(n.x, n.y, n.z)
    out.uvs.push(((k + 0.5) / sides) * uRepeat, vRepeat)
    out.layers.push(texLayer)
  }

  let tris = 0
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < sides; k++) {
      const a = base + r * stride + k
      out.indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride)
      tris += 2
    }
  }
  const lastBase = base + (rings.length - 1) * stride
  for (let k = 0; k < sides; k++) {
    out.indices.push(lastBase + k, lastBase + k + 1, apexBase + k)
    tris++
  }
  return tris
}

// One flap of a cloak: a long tapering quad hinged on the limb, with the leaf
// spray tiled along it. `spineAt` takes metres along the flap and hands back
// the point and tangent there -- past the twig tip it extrapolates, because the
// flap is a whole number of tiles and so is a little longer than the limb.
//
// v runs 0 at the hinge to 1 at the free edge, which is the art's stem-to-tip
// axis; u runs along the limb and carries the tiling. `sign` flips the flap to
// the other side of the limb AND reverses its u, which is free and stops the
// two halves of the V reading as one mirrored image of each other.
function addFlap(out, spineAt, len, tiles, reach, o, sign, texLayer) {
  const base = out.positions.length / 3
  const quads = Math.max(1, Math.round(o.quads))
  const lift = new THREE.Vector3()
  const dir = new THREE.Vector3()
  const nrm = new THREE.Vector3()
  const b1 = new THREE.Vector3()
  const b2 = new THREE.Vector3()
  const tmp = new THREE.Vector3()

  for (let k = 0; k <= quads; k++) {
    const f = k / quads
    const { pos, tan } = spineAt(f * len)

    b1.crossVectors(tan, UP)
    if (b1.lengthSq() < 1e-8) b1.set(1, 0, 0) // a limb straight up the axis
    b1.normalize()
    b2.crossVectors(tan, b1).normalize()
    lift.crossVectors(b1, tan).normalize()
    dir
      .copy(b1)
      .multiplyScalar(sign * Math.cos(o.dihedral))
      .addScaledVector(lift, Math.sin(o.dihedral))
      .normalize()
    nrm.crossVectors(tan, dir).normalize()

    const w = reach * (1 - o.taper * f)
    const u = sign > 0 ? f * tiles : (1 - f) * tiles
    for (let e = 0; e < 2; e++) {
      tmp.copy(pos).addScaledVector(dir, e * w)
      out.positions.push(tmp.x, tmp.y, tmp.z)
      out.normals.push(nrm.x, nrm.y, nrm.z)
      out.uvs.push(u, e)
      out.layers.push(texLayer)
    }

    if (k < quads) {
      const a = base + k * 2
      out.indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }
  return quads * 2
}

export function buildTree(options = {}) {
  const p = { ...TREE_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)

  const out = { positions: [], normals: [], uvs: [], layers: [], indices: [] }

  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const nBranch = Math.max(0, Math.round(p.branches))
  const brSides = Math.round(p.branchSides)
  const brRings = Math.max(1, Math.round(p.branchRings))
  const cloaked = p.foliage === 'cloak'
  const nSpray = Math.max(0, Math.round(p.sprays))
  const nFork = Math.max(0, Math.round(p.forks))
  const whorl = Math.max(0, Math.round(p.whorlSize))

  // Leaf cards are sized in world metres, and the geometry below is built at
  // height 1, so a card is `sprayMetres / height` local units tall. The final
  // rescale divides by the bounding box rather than by exactly 1 (foliage
  // stands a little above the trunk tip), so the achieved world size comes out
  // a few percent under; it is computed exactly at the bottom and reported,
  // rather than iterated for -- a second build to recover 4 cm is not a trade
  // worth making, and the previewer prints the truth either way.
  const sprayH = p.sprayMetres / Math.max(1e-6, p.height)

  // Everything below is built at height = 1 and rescaled at the end, for the
  // same reason the fern is: `branchDroop` changes how much of a branch's
  // length shows up as height, so the only honest way to hit a metre target is
  // to build it and measure it.
  const bendAz = rand() * TAU
  const bendDir = new THREE.Vector3(Math.cos(bendAz), 0, Math.sin(bendAz))
  const trunkAt = (f) =>
    new THREE.Vector3(bendDir.x * p.trunkBend * f * f, f, bendDir.z * p.trunkBend * f * f)
  // Linear to zero at the top, always: the trunk is a cone and a branch has to
  // attach to the surface that is actually drawn. There is no `trunkTaper` any
  // more because a cone has nothing left to taper.
  const radiusAt = (f) => p.trunkRadius * Math.max(0, 1 - f)

  // --- trunk ----------------------------------------------------------------
  // `barkRepeat` is the tiling UP the trunk, and the tiling AROUND it is
  // derived from it so that one bark tile stays roughly SQUARE in world space
  // instead of being smeared into a tall thin band. The trunk is 1 unit tall
  // locally, so a tile is 1/barkRepeat tall and the circumference is
  // 2*pi*trunkRadius: their ratio is how many tiles fit around. Rounded to an
  // integer because the seam vertex is duplicated at u = uRepeat -- a
  // fractional repeat would leave a visible mismatched stripe up the trunk.
  const uRepeat = Math.max(1, Math.round(TAU * p.trunkRadius * p.barkRepeat))
  const E1 = new THREE.Vector3(1, 0, 0)
  const E2 = new THREE.Vector3(0, 0, 1)
  let trunkTris = 0
  if (p.trunkRadius > 0) {
    const list = []
    for (let r = 0; r < rings; r++) {
      const f = r / rings // rings at 0 .. (R-1)/R; the apex takes f = 1
      list.push({ pos: trunkAt(f), e1: E1, e2: E2, radius: radiusAt(f), v: f * p.barkRepeat })
    }
    trunkTris = addCone(out, list, trunkAt(1), sides, uRepeat, p.barkRepeat, p.barkLayer)
  }

  // --- limbs and their foliage ----------------------------------------------
  const whorls = Math.max(1, Math.ceil(nBranch / Math.max(1, whorl)))
  let branchTris = 0
  let sprayTris = 0
  let sprayTiles = 0 // foliage INSTANCES, which a cloak decouples from triangles
  let limbs = 0

  // An orthonormal pair spanning the plane perpendicular to `tan`, written into
  // b1/b2. Everything that leaves a limb sideways -- a leaf shoot, a fork --
  // picks an azimuth in this frame, which is what stops them all sharing one
  // plane the way they did when they were rolled about a fixed yaw.
  const frame = (tan, b1, b2) => {
    b1.crossVectors(tan, UP)
    if (b1.lengthSq() < 1e-8) b1.set(1, 0, 0)
    b1.normalize()
    b2.crossVectors(tan, b1).normalize()
  }

  /**
   * One limb: its solid cone, the foliage along it, and -- only at depth 0 --
   * the forks that split off it. `dir` is the unit direction it leaves in,
   * `side` a unit vector it is allowed to sway toward, `phase` an arbitrary
   * angle that decorrelates this limb's azimuths from its neighbours'.
   */
  const growLimb = (start, dir, side, length, phase, depth) => {
    const pts = branchPath(start, dir, side, {
      droop: p.branchDroop * (0.85 + rand() * 0.3),
      curve: Math.max(0.2, p.branchCurve),
      sway: p.branchSway * (rand() - 0.5) * 2,
      length,
    }, PATH_N)
    limbs++

    const b1 = new THREE.Vector3()
    const b2 = new THREE.Vector3()

    // --- the limb itself, a solid cone to a point ---
    if (brSides >= 3 && p.branchWidth > 0) {
      const list = []
      for (let r = 0; r < brRings; r++) {
        const f = r / brRings
        const q = samplePath(pts, f)
        frame(q.tan, b1, b2)
        list.push({
          pos: q.pos,
          e1: b1.clone(),
          e2: b2.clone(),
          radius: length * p.branchWidth * (1 - f),
          // Bark along the limb at the same metres-per-tile as the trunk, and
          // once around: a branch is a few centimetres thick, so a second tile
          // round it would be sub-texel from anywhere you can see it.
          v: f * Math.max(1, Math.round(length * p.barkRepeat)),
        })
      }
      branchTris += addCone(out, list, samplePath(pts, 1).pos, brSides, 1,
        Math.max(1, Math.round(length * p.barkRepeat)), p.barkLayer)
    }

    // --- foliage ---
    if (cloaked) {
      // A whole number of tiles, ceiled, so no spray is ever sliced -- see the
      // note at the top. The flap therefore runs past the twig tip by up to one
      // tile, and a limb shorter than a single tile gets exactly one, which is
      // a plain card on each side and needs no separate code path.
      const tileLen = Math.max(1e-6, sprayH * p.cloakAspect)
      const tiles = Math.max(1, Math.ceil(length / tileLen))
      const flapLen = tiles * tileLen
      const end = samplePath(pts, 1)
      const spineAt = (d) =>
        d <= length
          ? samplePath(pts, d / length)
          : { pos: end.pos.clone().addScaledVector(end.tan, d - length), tan: end.tan }

      const o = { quads: p.cloakQuads, taper: p.cloakTaper, dihedral: p.cloakDihedral }
      const reach = sprayH * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      sprayTris += addFlap(out, spineAt, flapLen, tiles, reach, o, 1, p.leafLayer)
      sprayTris += addFlap(out, spineAt, flapLen, tiles, reach, o, -1, p.leafLayer)
      sprayTiles += tiles * 2
    } else for (let j = 0; j < nSpray; j++) {
      // j = 0 is the TERMINAL shoot: it sits at the tip and continues the twig
      // rather than leaving its side, which is what stops every limb ending in
      // a bare stick. The rest are side shoots at STRATIFIED-random points
      // along the limb -- stratified rather than uniform because uniform
      // random at these counts clumps two cards together and leaves a gap.
      const terminal = j === 0
      const s = terminal
        ? 1
        : p.sprayStart + (1 - p.sprayStart) * ((j - 1 + rand()) / Math.max(1, nSpray - 1))
      const q = samplePath(pts, s)

      frame(q.tan, b1, b2)
      const az = phase + j * GOLDEN_ANGLE + (rand() - 0.5) * p.sprayJitter
      const out0 = terminal ? 0 : p.sprayOut * (0.6 + rand() * 0.4)
      const shoot = new THREE.Vector3()
        .copy(q.tan)
        .multiplyScalar(1 - out0)
        .addScaledVector(b1, Math.cos(az) * out0)
        .addScaledVector(b2, Math.sin(az) * out0)
        .normalize()

      // The card's own up axis: along the shoot at sprayLift 0 (a needled
      // spray continues the twig), vertical at 1 (a broadleaf hangs off it).
      const up = new THREE.Vector3().lerpVectors(shoot, UP, p.sprayLift).normalize()
      const ref = new THREE.Vector3(Math.cos(az), 0.35, Math.sin(az))
      const right = new THREE.Vector3().crossVectors(up, ref)
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
      right.normalize()

      const h = sprayH * (1 + (rand() - 0.5) * 2 * p.sprayVary)
      // Seated at its STEM, not its centre. v = 0 of the art is the cut end of
      // the spray (see tools/trees/gen-layers.mjs), and addCard puts v = 0 at
      // -h/2 along `up`, so offsetting by +h/2 attaches the stem exactly where
      // the shoot leaves the limb. Centring on q.pos buries half of every card
      // inside the branch it grows from.
      const centre = new THREE.Vector3().copy(q.pos).addScaledVector(up, h / 2)
      addCard(out, centre, right, up, h * p.sprayAspect, h, p.leafLayer)
      sprayTris += 2
      sprayTiles += 1
    }

    // One level of forking only, so `limbs = branches x (1 + forks)` stays
    // arithmetic the budget panel can print. The recursion is written as a
    // recursion anyway because the depth guard is the only thing keeping it to
    // one level, and that is easier to raise than to reintroduce.
    if (depth > 0) return
    for (let k = 0; k < nFork; k++) {
      const s = p.forkStart + (1 - p.forkStart) * ((k + rand()) / nFork)
      const q = samplePath(pts, s)
      frame(q.tan, b1, b2)
      const az = phase + k * GOLDEN_ANGLE + (rand() - 0.5) * p.yawJitter
      const perp = new THREE.Vector3()
        .copy(b1)
        .multiplyScalar(Math.cos(az))
        .addScaledVector(b2, Math.sin(az))
      const childDir = new THREE.Vector3()
        .copy(q.tan)
        .multiplyScalar(Math.cos(p.forkAngle))
        .addScaledVector(perp, Math.sin(p.forkAngle))
        .normalize()
      growLimb(q.pos.clone(), childDir, perp, length * p.forkScale, az, depth + 1)
    }
  }

  for (let i = 0; i < nBranch; i++) {
    // whorl 0 = scattered: every branch gets its own stratified-random height,
    // so the trunk shows no repeating pattern at all. whorl 1 = spiral, one
    // branch per height evenly up. whorl > 1 = conifer whorls, that many
    // branches sharing a height. Half-offsets at both ends of the even cases so
    // neither the hem nor the apex lands exactly on a crown-profile zero.
    const wi = Math.floor(i / Math.max(1, whorl))
    const t =
      whorl === 0
        ? (i + rand()) / nBranch
        : whorl > 1
          ? (wi + 0.5) / whorls
          : (i + 0.5) / nBranch
    const yaw =
      whorl > 1
        ? ((i % whorl) / whorl) * TAU + wi * GOLDEN_ANGLE + (rand() - 0.5) * p.yawJitter
        : i * GOLDEN_ANGLE + (rand() - 0.5) * GOLDEN_ANGLE * p.yawJitter * 2

    const f = p.firstBranch + t * (1 - p.firstBranch)
    const prof = crownProfile(t, p.crownPeak, p.crownFullness)
    const length = p.branchLength * (p.branchMin + (1 - p.branchMin) * prof)
    if (length < 1e-4) continue

    const outward = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw))
    const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw))
    const elev = p.branchAngle + p.branchRise * t
    const dir = new THREE.Vector3()
      .copy(outward)
      .multiplyScalar(Math.cos(elev))
      .addScaledVector(UP, Math.sin(elev))
      .normalize()
    // Start just inside the trunk surface so a branch does not float off it.
    const start = trunkAt(f).addScaledVector(outward, radiusAt(f) * 0.85)

    growLimb(start, dir, side, length, yaw, 0)
  }

  // --- finish ---------------------------------------------------------------
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  geo.setIndex(out.indices)

  // Scale so the TIP lands at `height`, and do not re-seat the base afterwards.
  // This is the one place a tree deliberately differs from a fern: the fern is
  // translated so its bounding box sits on y = 0, but a low branch here can
  // droop below the root, and lifting the whole tree to clear it would leave
  // the trunk hanging in the air. The trunk base is at y = 0 by construction,
  // so it is already right and the drooping foliage is allowed to pass through
  // the ground -- which is what real low branches do.
  geo.computeBoundingBox()
  // Held, because computeBoundingBox() reuses the same Box3 in place -- reading
  // the "before" box after the rescale would silently give the after one.
  let scale = 1
  if (geo.boundingBox.max.y > 1e-6) {
    scale = p.height / geo.boundingBox.max.y
    geo.scale(scale, scale, scale)
  }
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  const b = geo.boundingBox
  geo.userData.tree = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    trunkTris,
    branchTris,
    sprayTris,
    branches: nBranch,
    limbs,
    sprays: sprayTiles,
    // What a leaf card ACTUALLY came out as in metres, which is `sprayMetres`
    // divided by however far past 1 the pre-scale bounding box reached. Printed
    // rather than corrected -- see the note where sprayH is computed.
    sprayMetres: p.sprayMetres * (scale / p.height),
    // Above ground, which is what `height` asked for: the tip is at exactly
    // p.height by construction. Foliage that droops through the ground is
    // reported separately rather than folded in, because on a slope that is
    // the difference between a low branch and a buried one.
    height: b.max.y,
    belowGround: -Math.min(0, b.min.y),
    // The two numbers that decide whether a size looks right, in metres rather
    // than in fractions -- see the note on height at the top of this file.
    crownWidth: Math.max(b.max.x - b.min.x, b.max.z - b.min.z),
    trunkDiameter: 2 * p.trunkRadius * scale,
    firstBranchHeight: p.firstBranch * scale,
  }
  return geo
}
