import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural trees and bushes.
//
// Three primitives, and that is the whole tree:
//
//   TRUNK    one tapered tube, `trunkSides` around x `trunkRings` up, wearing
//            bark. The only closed surface in the mesh.
//   BRANCHES bent ribbons, integrated exactly the way a fern frond is: launch
//            at an angle, bend over by `branchDroop` along the way. Also bark.
//   SPRAYS   one quad each, wearing a leaf-spray cutout off the texture array
//            (public/trees/leaf_*.png, cut by tools/trees/gen-layers.mjs).
//            The canopy's entire silhouette lives in those alpha channels.
//
// so the cost is arithmetic, not a mystery:
//
//   tris = trunkSides x trunkRings x 2
//        + branches x branchQuads x 2
//        + branches x sprays x 2
//
// which is the number the previewer (gen-tree.html) puts at the top of its
// budget panel. DESIGN.md §5 gives the tree class 500 and 130 triangles for its
// two mesh tiers and the bush class 84 / 56 / 28; both are reachable by moving
// the three counts above and nothing else, which is what makes an LOD tier a
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
  trunkSides: 5,       // sides around. 3 is a wedge, 5 reads round at 10 m
  trunkRings: 3,       // segments up. More only matters if trunkBend > 0
  trunkRadius: 0.028,  // base radius as a FRACTION of height (0.028 x 9 m = 25 cm)
  trunkTaper: 0.72,    // fraction of that radius lost by the top
  trunkBend: 0.05,     // sideways lean at the top, as a fraction of height
  barkRepeat: 3,       // how many times bark tiles up the trunk

  // --- crown ---
  branches: 13,
  firstBranch: 0.38,   // fraction of height where the LOWEST branch attaches
  branchLength: 0.30,  // the longest branch, as a fraction of height
  crownPeak: 0.0,      // 0..1 -- where up the crown the longest branch sits
  crownFullness: 1.0,  // falloff from the peak. <1 fuller, >1 pointier
  branchMin: 0.12,     // shortest branch as a fraction of the longest, so the
                       // apex and the hem still carry foliage instead of ending
                       // in a zero-length branch with nothing on it
  whorlSize: 1,        // 1 = spiral (golden angle). >1 = conifer whorls: this
                       // many branches sharing one height, evenly around
  yawJitter: 0.35,

  // --- branch shape ---
  branchAngle: 0.0,    // radians above horizontal at the trunk, at the crown base
  branchRise: 0.85,    // added to that by the top of the crown, so the apex
                       // branches point up and the hem does not
  branchDroop: 0.55,   // total bend from launch to tip, radians
  branchCurve: 1.5,    // >1 concentrates the bend at the tip
  branchSway: 0.25,    // lateral drift, so a branch is not confined to a plane
  branchQuads: 1,      // ribbon segments per branch. 0 = no visible branches
  branchWidth: 0.055,  // ribbon width as a fraction of the branch's length
  branchTaper: 0.7,    // fraction of that width lost by the tip
  branchRoll: 0.5,     // random twist of the ribbon about its own axis

  // --- foliage ---
  sprays: 2,           // leaf cards per branch
  sprayStart: 0.35,    // where along the branch the first card sits
  sprayScale: 0.85,    // card height as a fraction of the branch's length
  sprayLift: 0.35,     // 0 = card lies along the branch, 1 = card stands upright
  sprayJitter: 0.6,    // radians of random roll about the card's own up axis
  sprayAspect: 1.0,    // card width/height; must match the art (note above)
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
// Presets, not a taxonomy. Each is a starting point in the previewer, and the
// numbers that matter for telling one from another are crownPeak, crownFullness
// and firstBranch -- the rest is character.
export const TREE_SPECIES = {
  pine: {
    label: 'pine',
    barkLayer: LAYER.BARK_PINE,
    leafLayer: LAYER.NEEDLES,
    params: {
      sprayAspect: 0.781,
      crownPeak: 0.0,
      crownFullness: 1.15,
      firstBranch: 0.42,
      branchLength: 0.16,
      branches: 16,
      whorlSize: 4,
      branchAngle: -0.12,
      branchRise: 0.55,
      branchDroop: 0.30,
      branchQuads: 1,
      sprays: 2,
      sprayLift: 0.12,
      sprayScale: 0.9,
      trunkRadius: 0.026,
      trunkTaper: 0.85,
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
      branchQuads: 2,
      sprays: 3,
      sprayLift: 0.45,
      sprayScale: 0.8,
      trunkRadius: 0.045,
      trunkTaper: 0.6,
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
      branchQuads: 2,
      sprays: 2,
      sprayLift: 0.2,
      sprayScale: 0.9,
      trunkRadius: 0.018,
      trunkTaper: 0.7,
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
      branchQuads: 1,
      sprays: 2,
      sprayLift: 0.4,
      sprayScale: 0.95,
      trunkRadius: 0.016,
      trunkTaper: 0.65,
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
  trunkTaper: 0.85,
  barkRepeat: 1,
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

// Walk a branch centreline out from its base, turning it a little further over
// at each step. Identical in spirit to fern.js's addFrond, and split out here
// because a tree needs the path itself, not just a ribbon: the leaf cards hang
// off points along it.
function branchPath(base, outward, side, o, n) {
  const pts = []
  const pos = base.clone()
  for (let k = 0; k <= n; k++) {
    const s = k / n
    const ang = o.elev - o.droop * Math.pow(s, o.curve)
    const drift = o.sway * s * s
    const tan = new THREE.Vector3()
      .copy(outward)
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

// A branch as a bent ribbon of `quads` segments, sampled off its own path.
function addRibbon(out, pts, quads, width, taper, roll, texLayer) {
  const base = out.positions.length / 3
  const bladeSide = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tmp = new THREE.Vector3()
  const horiz = new THREE.Vector3()

  for (let k = 0; k <= quads; k++) {
    const s = k / quads
    const { pos, tan } = samplePath(pts, s)

    // The ribbon's width runs roughly VERTICALLY, so its plane contains the
    // branch and stands upright. A branch ribbon lying flat is edge-on from eye
    // height, which is where a player looks from; upright it is edge-on only
    // when the branch points at you, and then it is foreshortened anyway.
    horiz.crossVectors(tan, UP)
    if (horiz.lengthSq() < 1e-8) horiz.set(1, 0, 0) // a branch straight up the axis
    horiz.normalize()
    bladeSide.crossVectors(horiz, tan).normalize().applyAxisAngle(tan, roll)
    normal.crossVectors(bladeSide, tan).normalize()

    const halfW = (width * (1 - taper * s)) / 2
    for (let e = 0; e < 2; e++) {
      const sign = e === 0 ? -1 : 1
      tmp.copy(pos).addScaledVector(bladeSide, sign * halfW)
      out.positions.push(tmp.x, tmp.y, tmp.z)
      out.normals.push(normal.x, normal.y, normal.z)
      out.uvs.push(e, s)
      out.layers.push(texLayer)
    }

    if (k < quads) {
      const a = base + k * 2
      out.indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }
  }
}

export function buildTree(options = {}) {
  const p = { ...TREE_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)

  const out = { positions: [], normals: [], uvs: [], layers: [], indices: [] }

  const sides = Math.max(3, Math.round(p.trunkSides))
  const rings = Math.max(1, Math.round(p.trunkRings))
  const nBranch = Math.max(0, Math.round(p.branches))
  const quads = Math.max(0, Math.round(p.branchQuads))
  const nSpray = Math.max(0, Math.round(p.sprays))
  const whorl = Math.max(1, Math.round(p.whorlSize))

  // Everything below is built at height = 1 and rescaled at the end, for the
  // same reason the fern is: `branchDroop` changes how much of a branch's
  // length shows up as height, so the only honest way to hit a metre target is
  // to build it and measure it.
  const bendAz = rand() * TAU
  const bendDir = new THREE.Vector3(Math.cos(bendAz), 0, Math.sin(bendAz))
  const trunkAt = (f) =>
    new THREE.Vector3(bendDir.x * p.trunkBend * f * f, f, bendDir.z * p.trunkBend * f * f)
  const radiusAt = (f) => p.trunkRadius * Math.max(0.04, 1 - p.trunkTaper * f)

  // --- trunk ----------------------------------------------------------------
  // The seam vertex is duplicated (sides + 1 per ring) so u can run 0..1 across
  // the whole way round; sharing it would wrap the bark backwards over the last
  // face. Triangles are still sides x rings x 2.
  let trunkTris = 0
  if (p.trunkRadius > 0) {
    const base = out.positions.length / 3
    for (let r = 0; r <= rings; r++) {
      const f = r / rings
      const c = trunkAt(f)
      const rad = radiusAt(f)
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * TAU
        const nx = Math.cos(a)
        const nz = Math.sin(a)
        out.positions.push(c.x + nx * rad, c.y, c.z + nz * rad)
        out.normals.push(nx, 0, nz)
        out.uvs.push(k / sides, f * p.barkRepeat)
        out.layers.push(p.barkLayer)
      }
    }
    const stride = sides + 1
    for (let r = 0; r < rings; r++) {
      for (let k = 0; k < sides; k++) {
        const a = base + r * stride + k
        out.indices.push(a, a + 1, a + stride + 1, a, a + stride + 1, a + stride)
        trunkTris += 2
      }
    }
  }

  // --- branches and their foliage -------------------------------------------
  const whorls = Math.max(1, Math.ceil(nBranch / whorl))
  let branchTris = 0
  let sprayTris = 0

  for (let i = 0; i < nBranch; i++) {
    // Whorled conifers put `whorl` branches at one height and step up; spiral
    // broadleaves give every branch its own height. Half-offsets at both ends
    // so neither the hem nor the apex lands exactly on a profile zero.
    const wi = Math.floor(i / whorl)
    const t = whorl > 1 ? (wi + 0.5) / whorls : (i + 0.5) / nBranch
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
    // Start just inside the trunk surface so a branch does not float off it.
    const start = trunkAt(f).addScaledVector(outward, radiusAt(f) * 0.85)

    const pts = branchPath(start, outward, side, {
      elev: p.branchAngle + p.branchRise * t,
      droop: p.branchDroop * (0.85 + rand() * 0.3),
      curve: Math.max(0.2, p.branchCurve),
      sway: p.branchSway * (rand() - 0.5) * 2,
      length,
    }, PATH_N)

    if (quads > 0 && p.branchWidth > 0) {
      addRibbon(out, pts, quads, length * p.branchWidth, p.branchTaper,
        p.branchRoll * (rand() - 0.5) * 2, p.barkLayer)
      branchTris += quads * 2
    }

    for (let j = 0; j < nSpray; j++) {
      const s =
        nSpray === 1
          ? p.sprayStart + (1 - p.sprayStart) * 0.55
          : p.sprayStart + (1 - p.sprayStart) * (j / (nSpray - 1))
      const q = samplePath(pts, s)

      const h = length * p.sprayScale * (0.85 + rand() * 0.3)
      // The card's own up axis: along the branch at sprayLift 0 (a needled
      // spray continues the twig), vertical at 1 (a broadleaf hangs off it).
      const up = new THREE.Vector3().lerpVectors(q.tan, UP, p.sprayLift).normalize()
      // Roll the card around that axis by the golden angle per spray, so the
      // cards on one branch do not all face the same way and read as a wall.
      const roll = yaw + j * GOLDEN_ANGLE + (rand() - 0.5) * p.sprayJitter
      const ref = new THREE.Vector3(Math.cos(roll), 0.35, Math.sin(roll))
      const right = new THREE.Vector3().crossVectors(up, ref)
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0)
      right.normalize()

      addCard(out, q.pos, right, up, h * p.sprayAspect, h, p.leafLayer)
      sprayTris += 2
    }
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
    sprays: nBranch * nSpray,
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
