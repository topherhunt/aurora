import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { paint, assemble } from '../props/shapes.js'

// ---------------------------------------------------------------------------
// Village prop geometry. Longhouses, huts, barns, fences, crops, market stalls,
// lampposts, bonfires, furniture, livestock, flames and smoke.
//
// Same contract as props/shapes.js and for the same reason: every geometry
// returned here is INDEXED and carries exactly `position`, `normal` and
// `color`. They all go into one BatchedMesh, which validates that every
// geometry it accepts has an identical attribute layout, and one stray `uv`
// makes the whole batch refuse the mesh. `paint()` deletes the uv that
// BoxGeometry and friends come with, which is why every part goes through it.
//
// Placeholder art, real architecture -- these get replaced by Meshy assets at
// §14 step 4. Two conventions here are NOT placeholders and should survive:
//
//   THE DOOR IS ON LOCAL +Z, on every building without exception. plan.js
//   routes a footpath from each door and cannot ask the geometry where that is.
//
//   EVERYTHING SITS ON y = 0 AND IS CENTRED ON XZ. Instancing is a translate
//   plus a Y rotation and nothing else.
//
// Colours are LINEAR, like props/shapes.js -- a prop mixed at sRGB values reads
// as a glowing plastic toy next to linear-0.05 ground. The one deliberate
// exception is the flame palette, which is near 1.0 because a flame is supposed
// to be the brightest thing in the frame.
//
// The village batch runs DoubleSide, which is a real decision rather than an
// oversight. Cloth awnings, crop leaves, fence rails seen edge-on and hanging
// fish are all single-quad surfaces, and mirroring each one in geometry -- the
// trick props/shapes.js uses for grass blades -- would double the vertex count
// of nearly everything in this file. The village is ~20k triangles against an
// 800k ceiling, so paying for backfaces here is cheaper than paying for twice
// the geometry, and it is what lets a crop row cost six triangles a plant.
// ---------------------------------------------------------------------------

const C = (r, g, b) => new THREE.Color(r, g, b)

// --- palette ----------------------------------------------------------------
const WOOD_DARK = C(0.032, 0.021, 0.013)
const WOOD = C(0.052, 0.036, 0.021)
const WOOD_LIGHT = C(0.082, 0.058, 0.034)
const TIMBER_TAR = C(0.019, 0.014, 0.011) // pitch-blackened Norse stave timber
const TURF = C(0.026, 0.045, 0.019) // a turf roof, which is the Norse signature
const TURF_LIGHT = C(0.048, 0.076, 0.03)
const THATCH = C(0.062, 0.047, 0.024)
const THATCH_LIGHT = C(0.095, 0.074, 0.038)
const STONE = C(0.036, 0.035, 0.033)
const STONE_LIGHT = C(0.072, 0.07, 0.066)
const IRON = C(0.021, 0.022, 0.026)
const HAY = C(0.11, 0.086, 0.036)
const CLOTH = [C(0.09, 0.024, 0.019), C(0.02, 0.036, 0.068), C(0.1, 0.088, 0.062), C(0.055, 0.05, 0.02)]
const WOOL = C(0.14, 0.135, 0.12)
const HIDE = [C(0.055, 0.032, 0.018), C(0.022, 0.018, 0.016), C(0.1, 0.094, 0.084)]
const FEATHER = C(0.11, 0.1, 0.086)
const EMBER = C(0.42, 0.11, 0.02)

// Flame and smoke. Flames live in a separate MeshBasicMaterial batch (see
// village.js) so they are not shaded by the sun -- a lit flame that goes dark
// on the shadow side of a post is the one thing that would give it away.
export const FLAME_HOT = C(1.0, 0.78, 0.3)
export const FLAME_TIP = C(0.95, 0.28, 0.05)
const SMOKE_DARK = C(0.055, 0.052, 0.05)
const SMOKE_LIGHT = C(0.16, 0.158, 0.152)

// Crop palettes, indexed by the `crop` name plan.js records.
const CROP_COLORS = {
  grain: [C(0.075, 0.062, 0.018), C(0.19, 0.145, 0.038)],
  cabbage: [C(0.018, 0.038, 0.016), C(0.048, 0.086, 0.03)],
  turnip: [C(0.05, 0.018, 0.042), C(0.04, 0.072, 0.026)],
  flax: [C(0.024, 0.042, 0.038), C(0.045, 0.072, 0.098)],
  squash: [C(0.022, 0.04, 0.014), C(0.16, 0.075, 0.014)],
}

// Market goods, as [dark, light] pairs.
const GOODS_COLORS = {
  fruit: [C(0.11, 0.03, 0.02), C(0.21, 0.09, 0.02)],
  veg: [C(0.02, 0.045, 0.016), C(0.06, 0.1, 0.03)],
  fish: [C(0.045, 0.052, 0.058), C(0.13, 0.14, 0.15)],
  meat: [C(0.075, 0.021, 0.018), C(0.14, 0.05, 0.042)],
  bread: [C(0.075, 0.05, 0.022), C(0.15, 0.11, 0.055)],
  tools: [C(0.028, 0.026, 0.028), C(0.075, 0.072, 0.07)],
}

// --- primitives -------------------------------------------------------------
// Every one takes its colours and returns a painted, uv-free part ready to
// merge. `bias` shifts paint()'s vertical gradient, which is the cheapest way
// to keep two adjacent boxes from reading as one slab.

function box(w, h, d, lo, hi = lo, bias = 0) {
  const g = new THREE.BoxGeometry(w, h, d)
  return paint(g, lo, hi, bias)
}

function cyl(rTop, rBot, h, seg, lo, hi = lo) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg)
  return paint(g, lo, hi)
}

function cone(r, h, seg, lo, hi = lo) {
  return paint(new THREE.ConeGeometry(r, h, seg), lo, hi)
}

// PolyhedronGeometry comes out NON-indexed, and mergeGeometries refuses a mix
// of indexed and non-indexed parts -- so a blob dropped in beside a box silently
// fails the whole assemble(). Nothing to weld here (the hard facets are the
// point), so this is an identity index, the same trick buildBoulder() uses.
function indexify(geo) {
  if (geo.index) return geo
  const n = geo.attributes.position.count
  const idx = new Uint16Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}

// A faceted blob. The workhorse for anything organic at this fidelity --
// cabbages, fruit, smoke puffs, the fluff on a sheep.
function blob(r, seg, lo, hi, squash = 1) {
  const g = new THREE.OctahedronGeometry(r, seg)
  g.scale(1, squash, 1)
  return indexify(paint(g, lo, hi))
}

// A flat sheet in the XY plane facing +Z, with its base at y = 0. Cloth,
// leaves, hanging fish -- everything that is a surface rather than a solid.
function sheet(w, h, lo, hi) {
  const g = new THREE.PlaneGeometry(w, h)
  g.translate(0, h / 2, 0)
  return paint(g, lo, hi)
}

// Two sheets crossed at right angles: the cheapest thing that reads as a plant
// from every direction. 4 triangles.
function crossSheet(w, h, lo, hi) {
  const a = sheet(w, h, lo, hi)
  const b = sheet(w, h, lo, hi)
  b.rotateY(Math.PI / 2)
  return [a, b]
}

// A pitched roof as two slabs plus the triangles that close its ends. Shared by
// every gabled building here, which is all of them except the shed.
//
// The gable ends have to be actual triangles: a box tall enough to fill the
// gable is necessarily wider than the roof above a third of the ridge height,
// so it pokes straight through the slabs. That lesson is props/shapes.js's,
// learned on the placeholder cabin.
function gableTriangles(width, ridgeH, depth, lo, hi) {
  const hw = width / 2
  const hd = depth / 2
  const positions = new Float32Array([
    -hw, 0, hd, hw, 0, hd, 0, ridgeH, hd,
    hw, 0, -hd, -hw, 0, -hd, 0, ridgeH, -hd,
  ])
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1])
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 3, 4, 5]), 1))
  return paint(g, lo, hi)
}

function gableRoof(width, depth, ridgeH, baseY, thick, eave, lo, hi) {
  const parts = []
  const angle = Math.atan2(ridgeH, width / 2)
  const slope = Math.hypot(width / 2, ridgeH)
  for (const side of [-1, 1]) {
    // rotateZ turns +X toward +Y, so the slab at +X needs a NEGATIVE angle to
    // slope downward.
    const slab = box(slope + eave, thick, depth + eave * 2, lo, hi)
    slab.rotateZ(-side * angle)
    slab.translate((side * width) / 4, baseY + ridgeH / 2, 0)
    parts.push(slab)
  }
  return parts
}

// --- buildings --------------------------------------------------------------

/**
 * The great hall. A Norse longhouse: bowed long walls, a steep turf roof, a
 * ridge that overhangs both ends, and crossed finials at the gables.
 *
 * The BOW is the detail doing the work. A longhouse in plan is not a rectangle
 * -- the long walls curve outward at the middle by a few percent of the length
 * -- and it is the single feature that separates "Viking hall" from "big shed"
 * at a glance, more than the roof pitch and much more than the dragon heads
 * everyone reaches for first. It costs a loop instead of a box.
 */
export function buildLonghouse({ w = 17, d = 6.6, wallH = 2.5, plinth = 0.45, seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []
  const SEGS = 7
  const bow = d * 0.13 // how far the walls bulge at midspan

  // Stone footing, itself bowed so it does not show square corners under a
  // curved wall.
  for (let i = 0; i < SEGS; i++) {
    const t = (i + 0.5) / SEGS
    const segW = w / SEGS
    const out = Math.sin(t * Math.PI) * bow
    for (const side of [-1, 1]) {
      const p = box(segW * 1.04, plinth, 1.0, STONE, STONE_LIGHT, rand() * 0.4)
      p.translate(-w / 2 + t * w, plinth / 2, side * (d / 2 + out))
      parts.push(p)
    }
  }

  // Bowed long walls, in staves. Each segment is turned to follow the curve --
  // without the rotation the wall reads as a polygon rather than a curve.
  for (let i = 0; i < SEGS; i++) {
    const t = (i + 0.5) / SEGS
    const segW = (w / SEGS) * 1.12
    const out = Math.sin(t * Math.PI) * bow
    const dOut = (Math.cos(t * Math.PI) * Math.PI * bow) / w
    for (const side of [-1, 1]) {
      const p = box(segW, wallH, 0.32, TIMBER_TAR, WOOD, rand() * 0.5)
      p.rotateY(side * Math.atan(dOut))
      p.translate(-w / 2 + t * w, plinth + wallH / 2, side * (d / 2 + out))
      parts.push(p)
    }
  }

  // End walls, and the gable triangles above them.
  for (const side of [-1, 1]) {
    const end = box(0.3, wallH, d, TIMBER_TAR, WOOD)
    end.translate((side * w) / 2, plinth + wallH / 2, 0)
    parts.push(end)
  }
  const ridgeH = (d / 2 + bow) * 1.3 // steeper than the huts: snow load, and it reads as Norse
  const gable = gableTriangles(d + bow * 2, ridgeH, w, WOOD, WOOD_LIGHT)
  gable.rotateY(Math.PI / 2)
  gable.translate(0, plinth + wallH, 0)
  parts.push(gable)

  // Turf roof, segmented so it follows the bow like the walls do.
  const angle = Math.atan2(ridgeH, d / 2 + bow)
  for (let i = 0; i < SEGS; i++) {
    const t = (i + 0.5) / SEGS
    const segW = (w / SEGS) * 1.06
    const out = Math.sin(t * Math.PI) * bow
    const slope = Math.hypot(d / 2 + out + 0.45, ridgeH)
    for (const side of [-1, 1]) {
      const slab = box(segW, 0.3, slope, TURF, TURF_LIGHT, rand() * 0.5)
      slab.rotateX(side * angle)
      slab.translate(-w / 2 + t * w, plinth + wallH + ridgeH / 2, (side * (d / 2 + out)) / 2)
      parts.push(slab)
    }
  }

  // Ridge beam, overhanging both gables -- the overhang is what makes the roof
  // look built rather than extruded.
  const ridge = box(w + 1.4, 0.26, 0.34, WOOD_DARK, WOOD)
  ridge.translate(0, plinth + wallH + ridgeH + 0.02, 0)
  parts.push(ridge)

  // Crossed finials at each gable.
  for (const side of [-1, 1]) {
    for (const arm of [-1, 1]) {
      const f = box(0.12, 1.5, 0.12, WOOD_DARK, WOOD_LIGHT)
      f.rotateX(arm * 0.42)
      f.translate((side * (w + 1.0)) / 2, plinth + wallH + ridgeH + 0.5, 0)
      parts.push(f)
    }
  }

  // Door on +Z, at the bulge, under a small porch.
  const doorH = 2.0
  const door = box(1.5, doorH, 0.16, WOOD_DARK, WOOD)
  door.translate(0, plinth + doorH / 2, d / 2 + bow + 0.1)
  parts.push(door)
  for (const side of [-1, 1]) {
    const post = cyl(0.1, 0.12, doorH + 0.5, 5, WOOD_DARK, WOOD)
    post.translate(side * 1.25, plinth + (doorH + 0.5) / 2, d / 2 + bow + 1.1)
    parts.push(post)
  }
  const porch = box(3.0, 0.16, 1.5, TURF, TURF_LIGHT)
  porch.rotateX(-0.22)
  porch.translate(0, plinth + doorH + 0.55, d / 2 + bow + 0.8)
  parts.push(porch)

  return assemble(parts)
}

/**
 * A dwelling. Stone plinth, timber walls, steep gable roof -- thatch or turf,
 * decided by variant, because a village where every roof matches reads as a
 * housing development.
 *
 * `plinth` comes from the plan, not from taste: it is however tall it has to be
 * to bridge the fall across the footprint. See the note on siteBuilding().
 */
export function buildHut({ w = 6, d = 4.6, wallH = 2.4, plinth = 0.45, variant = 0, seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []
  const turfRoof = variant % 2 === 0
  const [roofLo, roofHi] = turfRoof ? [TURF, TURF_LIGHT] : [THATCH, THATCH_LIGHT]

  const foot = box(w * 1.07, plinth, d * 1.07, STONE, STONE_LIGHT)
  foot.translate(0, plinth / 2, 0)
  parts.push(foot)

  const walls = box(w, wallH, d, WOOD, WOOD_LIGHT, rand() * 0.3)
  walls.translate(0, plinth + wallH / 2, 0)
  parts.push(walls)

  // Ridge runs along X, so the gables face +/-X and the eaves overhang +/-Z --
  // which is where the door is, so the door sits under the eave.
  const ridgeH = (d / 2) * (1.15 + variant * 0.08)
  const gable = gableTriangles(d, ridgeH, w, WOOD, WOOD_LIGHT)
  gable.rotateY(Math.PI / 2)
  gable.translate(0, plinth + wallH, 0)
  parts.push(gable)

  for (const slab of gableRoof(d, w, ridgeH, plinth + wallH, 0.24, 0.4, roofLo, roofHi)) {
    slab.rotateY(Math.PI / 2)
    parts.push(slab)
  }

  // Corner posts. Cheap, and they break the flat wall boxes into something
  // built out of pieces.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = box(0.2, wallH + 0.2, 0.2, TIMBER_TAR, WOOD_DARK)
      post.translate((sx * w) / 2, plinth + (wallH + 0.2) / 2, (sz * d) / 2)
      parts.push(post)
    }
  }

  const doorH = 1.9
  const door = box(0.95, doorH, 0.14, WOOD_DARK, TIMBER_TAR)
  door.translate((rand() - 0.5) * w * 0.35, plinth + doorH / 2, d / 2 + 0.02)
  parts.push(door)

  // A shuttered window on the door side, which is also a scale cue.
  if (rand() < 0.7) {
    const win = box(0.6, 0.5, 0.1, TIMBER_TAR, WOOD_DARK)
    win.translate(-w * 0.3 + rand() * w * 0.15, plinth + wallH * 0.62, d / 2 + 0.02)
    parts.push(win)
  }

  return assemble(parts)
}

/** A barn: taller doors, wider span, a lean-to down one side. */
export function buildBarn({ w = 10, d = 7, wallH = 3.4, plinth = 0.4, seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []

  // `w` is the footprint plan.js sited and cleared, so the lean-to comes OUT of
  // it rather than being bolted onto the side -- otherwise the barn reaches two
  // metres into whatever was placed next door.
  const leanW = Math.min(2.2, w * 0.22)
  const body = w - leanW
  const cx = leanW / 2 // body centre, shifted so the pair is centred on origin

  const foot = box(body * 1.05, plinth, d * 1.05, STONE, STONE_LIGHT)
  foot.translate(cx, plinth / 2, 0)
  parts.push(foot)

  const walls = box(body, wallH, d, WOOD, WOOD_LIGHT, rand() * 0.3)
  walls.translate(cx, plinth + wallH / 2, 0)
  parts.push(walls)

  const ridgeH = (d / 2) * 1.05
  const gable = gableTriangles(d, ridgeH, body, WOOD, WOOD_LIGHT)
  gable.rotateY(Math.PI / 2)
  gable.translate(cx, plinth + wallH, 0)
  parts.push(gable)
  for (const slab of gableRoof(d, body, ridgeH, plinth + wallH, 0.26, 0.5, THATCH, THATCH_LIGHT)) {
    slab.rotateY(Math.PI / 2)
    slab.translate(cx, 0, 0)
    parts.push(slab)
  }

  // Wide double doors on +Z, tall enough for a cart -- which is the whole point
  // of a barn reading as a barn.
  const doorH = wallH * 0.82
  for (const side of [-1, 1]) {
    const leaf = box(body * 0.24, doorH, 0.16, TIMBER_TAR, WOOD_DARK)
    leaf.translate(cx + side * body * 0.13, plinth + doorH / 2, d / 2 + 0.03)
    parts.push(leaf)
  }
  // Cross-bracing on the doors.
  for (const side of [-1, 1]) {
    const brace = box(body * 0.27, 0.12, 0.06, WOOD_LIGHT, WOOD_LIGHT)
    brace.rotateZ(side * 0.5)
    brace.translate(cx + side * body * 0.13, plinth + doorH / 2, d / 2 + 0.13)
    parts.push(brace)
  }

  // Lean-to down the -X flank, roofed at a shallower pitch.
  const leanH = wallH * 0.55
  const leanRoof = box(leanW + 0.4, 0.2, d * 0.8, THATCH, THATCH_LIGHT)
  leanRoof.rotateZ(0.34)
  leanRoof.translate(-w / 2 + leanW / 2, plinth + leanH + 0.35, 0)
  parts.push(leanRoof)
  for (const sz of [-1, 1]) {
    const post = cyl(0.09, 0.11, leanH + 0.3, 5, WOOD_DARK, WOOD)
    post.translate(-w / 2 + 0.1, plinth + (leanH + 0.3) / 2, sz * d * 0.35)
    parts.push(post)
  }

  return assemble(parts)
}

/** A shed: one pitch, no gable, the cheapest building in the village. */
export function buildShed({ w = 5, d = 3.8, wallH = 2.1, plinth = 0.35, seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []

  const foot = box(w * 1.06, plinth, d * 1.06, STONE, STONE_LIGHT)
  foot.translate(0, plinth / 2, 0)
  parts.push(foot)

  // The back wall is taller than the front, and the roof is one slab across.
  const walls = box(w, wallH, d, WOOD, WOOD_LIGHT, rand() * 0.3)
  walls.translate(0, plinth + wallH / 2, 0)
  parts.push(walls)
  const wedge = box(w, 0.9, d * 0.5, WOOD, WOOD_LIGHT)
  wedge.translate(0, plinth + wallH + 0.45, -d * 0.25)
  parts.push(wedge)

  const pitch = Math.atan2(0.9, d)
  const roof = box(w + 0.5, 0.2, Math.hypot(d, 0.9) + 0.5, THATCH, THATCH_LIGHT)
  roof.rotateX(-pitch)
  roof.translate(0, plinth + wallH + 0.55, 0.05)
  parts.push(roof)

  const doorH = 1.75
  const door = box(0.9, doorH, 0.12, WOOD_DARK, TIMBER_TAR)
  door.translate(0, plinth + doorH / 2, d / 2 + 0.02)
  parts.push(door)

  return assemble(parts)
}

/** A workshop: a hut with its work done outside, under an awning. */
export function buildWorkshop({ w = 5.4, d = 4.2, wallH = 2.4, plinth = 0.4, seed = 1 }) {
  const parts = [buildHut({ w, d, wallH, plinth, variant: 1, seed })]

  const awnH = 2.15
  for (const side of [-1, 1]) {
    const post = cyl(0.08, 0.1, awnH, 5, WOOD_DARK, WOOD)
    post.translate(side * w * 0.36, awnH / 2, d / 2 + 1.7)
    parts.push(post)
  }
  const awn = box(w * 0.85, 0.08, 1.9, CLOTH[3], CLOTH[2])
  awn.rotateX(-0.16)
  awn.translate(0, awnH + 0.1, d / 2 + 0.95)
  parts.push(awn)

  // A workbench under it, with something half-made on top.
  const bench = box(w * 0.6, 0.12, 0.7, WOOD, WOOD_LIGHT)
  bench.translate(0, 0.85, d / 2 + 0.9)
  parts.push(bench)
  for (const side of [-1, 1]) {
    const leg = box(0.1, 0.85, 0.1, WOOD_DARK, WOOD_DARK)
    leg.translate(side * w * 0.24, 0.425, d / 2 + 0.9)
    parts.push(leg)
  }
  const work = box(0.5, 0.16, 0.3, IRON, STONE_LIGHT)
  work.translate(0.3, 0.99, d / 2 + 0.9)
  parts.push(work)

  return assemble(parts)
}

// --- fences -----------------------------------------------------------------
// Built along local +X, `len` metres long, so plan.js can lay a run down with
// one yaw and one translate. Posts extend BELOW y = 0 on purpose: a run sits at
// the height of its own midpoint, so on sloping ground the ends would otherwise
// float, and a buried post is invisible where a floating one is not.

export function buildFenceRun(len = 3, seed = 1) {
  const rand = mulberry32(seed)
  const parts = []
  const postH = 1.15
  for (const side of [-1, 1]) {
    const post = box(0.11, postH + 0.5, 0.11, WOOD_DARK, WOOD)
    post.rotateZ((rand() - 0.5) * 0.07) // nothing in a village is plumb
    post.translate((side * len) / 2, (postH - 0.5) / 2, 0)
    parts.push(post)
  }
  for (const h of [0.42, 0.86]) {
    const rail = box(len + 0.1, 0.09, 0.06, WOOD, WOOD_LIGHT)
    rail.rotateZ((rand() - 0.5) * 0.03)
    rail.translate(0, h, 0)
    parts.push(rail)
  }
  return assemble(parts)
}

export function buildGateRun(len = 3, seed = 1) {
  const parts = []
  const postH = 1.5
  for (const side of [-1, 1]) {
    const post = box(0.15, postH + 0.5, 0.15, WOOD_DARK, WOOD)
    post.translate((side * len) / 2, (postH - 0.5) / 2, 0)
    parts.push(post)
  }
  // Hung open, swung back on its hinge -- an open gate says the field is in use
  // and a closed one says the geometry is symmetrical.
  const leaf = box(len * 0.85, 1.0, 0.07, WOOD, WOOD_LIGHT)
  const brace = box(len * 0.85, 0.08, 0.06, WOOD_LIGHT, WOOD_LIGHT)
  brace.rotateZ(0.42)
  const leafParts = [leaf, brace]
  const swing = assemble(leafParts)
  swing.translate(len * 0.42, 0, 0)
  swing.rotateY(-0.9)
  swing.translate(-len / 2, 0.62, 0)
  parts.push(swing)
  return assemble(parts)
}

// --- crops ------------------------------------------------------------------

/**
 * One segment of a crop row, `len` metres long, running along local +X.
 *
 * Rows are instanced in segments rather than as whole rows because a 25 m row
 * laid as one rigid geometry spears through the ground at one end and floats at
 * the other on any slope this world actually has. A 6 m segment sitting at its
 * own sampled height follows the field.
 */
export function buildCropRow({ len = 6, crop = 'grain', variant = 0, seed = 1 }) {
  const rand = mulberry32(seed)
  const [lo, hi] = CROP_COLORS[crop] ?? CROP_COLORS.grain
  const parts = []
  const spacing = crop === 'squash' ? 0.95 : crop === 'cabbage' ? 0.78 : 0.62
  const n = Math.max(2, Math.round(len / spacing))

  for (let i = 0; i < n; i++) {
    const x = -len / 2 + ((i + 0.5) * len) / n
    // Plants stagger across the row rather than sitting on its centreline.
    const z = (rand() - 0.5) * 0.22
    const s = 0.75 + rand() * 0.5

    if (crop === 'grain' || crop === 'flax') {
      const h = (crop === 'grain' ? 1.0 : 0.72) * s
      for (const p of crossSheet(0.16 * s, h, lo, hi)) {
        p.rotateY(rand() * Math.PI)
        p.rotateZ((rand() - 0.5) * 0.28) // the lean is what makes it a crop
        p.translate(x, 0, z)
        parts.push(p)
      }
    } else if (crop === 'cabbage') {
      const b = blob(0.19 * s, 0, lo, hi, 0.78)
      b.translate(x, 0.15 * s, z)
      parts.push(b)
      for (const p of crossSheet(0.34 * s, 0.2 * s, lo, hi)) {
        p.rotateY(rand() * Math.PI)
        p.translate(x, 0.02, z)
        parts.push(p)
      }
    } else if (crop === 'turnip') {
      const b = blob(0.11 * s, 0, lo, lo, 0.9)
      b.translate(x, 0.08, z)
      parts.push(b)
      for (const p of crossSheet(0.15 * s, 0.42 * s, lo, hi)) {
        p.rotateY(rand() * Math.PI)
        p.rotateZ((rand() - 0.5) * 0.5)
        p.translate(x, 0.1, z)
        parts.push(p)
      }
    } else {
      // squash: a low sprawl of leaf with a gourd sitting in it
      for (const p of crossSheet(0.5 * s, 0.26 * s, lo, lo))
        parts.push(p.rotateY(rand() * Math.PI).translate(x, 0.01, z))
      if (rand() < 0.55) {
        const g = blob(0.15 * s, 0, hi, hi, 0.8)
        g.translate(x + (rand() - 0.5) * 0.25, 0.12, z + (rand() - 0.5) * 0.2)
        parts.push(g)
      }
    }
  }

  // Variant only perturbs the seed's effect; keeping it in the signature means
  // plan.js can ask for three visibly different rows of the same crop.
  if (variant > 0) parts[0].rotateY(variant * 0.4)
  return assemble(parts)
}

// --- market -----------------------------------------------------------------

/**
 * A market stall: four posts, a counter across the front (+Z, facing the
 * plaza), an awning, and goods.
 *
 * The goods are the point. A stall with an empty counter reads as scaffolding,
 * and each kind is only a handful of primitives -- but "fish laid out on a
 * board, and two more hanging" is a specific enough image that it survives
 * being made of octahedra.
 */
export function buildStall({ goods = 'fruit', seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []
  const W = 2.6
  const D = 1.5
  const H = 2.2
  const [gLo, gHi] = GOODS_COLORS[goods] ?? GOODS_COLORS.fruit

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = cyl(0.07, 0.085, H, 5, WOOD_DARK, WOOD)
      post.translate((sx * W) / 2, H / 2, (sz * D) / 2)
      parts.push(post)
    }
  }

  const counter = box(W + 0.3, 0.1, D * 0.62, WOOD, WOOD_LIGHT)
  counter.translate(0, 0.92, D * 0.2)
  parts.push(counter)
  const apron = box(W + 0.3, 0.55, 0.07, WOOD_DARK, WOOD)
  apron.translate(0, 0.62, D * 0.2 + D * 0.31)
  parts.push(apron)

  // Awning: a shallow gable in striped cloth, and the stripe is one extra box.
  const cloth = CLOTH[(rand() * CLOTH.length) | 0]
  for (const side of [-1, 1]) {
    const slab = box(W * 0.62, 0.06, D + 0.7, cloth, CLOTH[2])
    slab.rotateZ(-side * 0.36)
    slab.translate((side * W) / 4, H + 0.22, 0)
    parts.push(slab)
  }
  const ridge = box(W + 0.3, 0.07, 0.09, WOOD_DARK, WOOD)
  ridge.translate(0, H + 0.44, 0)
  parts.push(ridge)

  // A back shelf, so the stall has depth rather than being a facade.
  const shelf = box(W * 0.9, 0.07, 0.3, WOOD, WOOD_LIGHT)
  shelf.translate(0, 1.35, -D * 0.42)
  parts.push(shelf)

  const onCounter = (fn, count) => {
    for (let i = 0; i < count; i++) {
      const x = -W * 0.42 + rand() * W * 0.84
      const z = D * 0.05 + rand() * D * 0.28
      parts.push(...fn(x, z))
    }
  }

  if (goods === 'fruit' || goods === 'veg') {
    // Piled in open crates -- a heap of loose spheres reads as marbles.
    for (const cx of [-W * 0.28, W * 0.28]) {
      const crate = box(0.7, 0.22, 0.55, WOOD, WOOD_LIGHT)
      crate.translate(cx, 1.08, D * 0.18)
      parts.push(crate)
    }
    onCounter((x, z) => {
      const r = 0.07 + rand() * 0.05
      const b = blob(r, 0, gLo, gHi, 0.9)
      b.translate(x, 1.2 + rand() * 0.06, z)
      return [b]
    }, 14)
  } else if (goods === 'fish') {
    onCounter((x, z) => {
      const f = box(0.42, 0.07, 0.14, gLo, gHi)
      f.rotateY(rand() * 0.5 - 0.25)
      f.translate(x, 1.0, z)
      return [f]
    }, 6)
    // Two hanging from the awning frame, which is the detail that makes it a
    // fish stall rather than a table with grey boxes on it.
    for (const sx of [-0.55, 0.35]) {
      const f = sheet(0.16, 0.46, gHi, gLo)
      f.translate(sx, 1.42, D * 0.1)
      parts.push(f)
      const line = box(0.02, 0.4, 0.02, WOOD_DARK, WOOD_DARK)
      line.translate(sx, 1.88, D * 0.1)
      parts.push(line)
    }
  } else if (goods === 'meat') {
    for (const sx of [-0.6, 0, 0.55]) {
      const slab = box(0.26, 0.5, 0.16, gLo, gHi)
      slab.translate(sx, 1.5, -D * 0.1)
      parts.push(slab)
      const hook = box(0.03, 0.24, 0.03, IRON, IRON)
      hook.translate(sx, 1.85, -D * 0.1)
      parts.push(hook)
    }
    onCounter((x, z) => {
      const b = box(0.3, 0.12, 0.22, gLo, gHi)
      b.rotateY(rand())
      b.translate(x, 1.03, z)
      return [b]
    }, 3)
  } else if (goods === 'bread') {
    onCounter((x, z) => {
      const b = blob(0.13, 0, gLo, gHi, 0.5)
      b.rotateY(rand() * 3)
      b.scale(1.5, 1, 0.8)
      b.translate(x, 1.03, z)
      return [b]
    }, 9)
  } else {
    // tools and supplies: hafts leaning on the frame, iron heads, a coil of rope
    for (let i = 0; i < 4; i++) {
      const haft = cyl(0.035, 0.04, 1.3, 4, WOOD_DARK, WOOD)
      haft.rotateZ(0.16 - i * 0.09)
      haft.translate(-W * 0.35 + i * 0.28, 0.65, -D * 0.36)
      parts.push(haft)
      const head = box(0.18, 0.12, 0.07, gLo, gHi)
      head.translate(-W * 0.35 + i * 0.28 + 0.11, 1.28, -D * 0.36)
      parts.push(head)
    }
    onCounter((x, z) => {
      const c = cyl(0.13, 0.13, 0.08, 7, WOOD_DARK, WOOD)
      c.translate(x, 1.01, z)
      return [c]
    }, 3)
  }

  return assemble(parts)
}

// --- fixtures ---------------------------------------------------------------

/** A lamppost. The flame that sits in its basket is a separate instance. */
export function buildLamppost({ h = 2.7, seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const post = cyl(0.06, 0.09, h, 6, TIMBER_TAR, WOOD_DARK)
  post.rotateZ((rand() - 0.5) * 0.05)
  post.translate(0, h / 2, 0)
  parts.push(post)

  // A short arm and an iron basket on the end of it, so the flame hangs clear
  // of the post rather than balancing on top of it.
  const arm = box(0.5, 0.07, 0.07, IRON, STONE)
  arm.translate(0.22, h - 0.12, 0)
  parts.push(arm)
  const cup = cyl(0.14, 0.09, 0.18, 6, IRON, STONE)
  cup.translate(0.42, h - 0.24, 0)
  parts.push(cup)
  for (let i = 0; i < 4; i++) {
    const bar = box(0.03, 0.22, 0.03, IRON, IRON)
    bar.translate(0.42 + Math.cos((i / 4) * Math.PI * 2) * 0.11, h - 0.12, Math.sin((i / 4) * Math.PI * 2) * 0.11)
    parts.push(bar)
  }
  return assemble(parts)
}

// Where the flame sits relative to a lamppost's origin. Exported because
// village.js places the flame instance and must not guess.
export const LAMP_FLAME_OFFSET = { x: 0.42, y: 2.56, z: 0 }

/** A bonfire: a ring of stones, a pile of logs, a bed of embers. */
export function buildBonfire({ r = 1.3, seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []

  const n = 9
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.3
    const s = 0.16 + rand() * 0.12
    const stone = blob(s, 0, STONE, STONE_LIGHT, 0.8)
    stone.rotateY(rand() * 3)
    stone.translate(Math.cos(a) * r, s * 0.4, Math.sin(a) * r)
    parts.push(stone)
  }

  // Embers under the logs. Bright, and in the shaded batch rather than the
  // emissive one -- an ember bed reads as hot because it is orange against dark
  // stone, and putting it in the unlit batch would flatten the whole fire.
  const bed = cyl(r * 0.72, r * 0.8, 0.09, 9, EMBER, C(0.12, 0.03, 0.01))
  bed.translate(0, 0.05, 0)
  parts.push(bed)

  // Logs leaned into a cone, which is the shape everyone reads as a bonfire.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.4
    const log = cyl(0.08, 0.11, r * 1.7, 5, WOOD_DARK, WOOD)
    log.rotateX(0.52)
    log.rotateY(a)
    log.translate(Math.cos(a) * r * 0.42, r * 0.72, Math.sin(a) * r * 0.42)
    parts.push(log)
  }
  // Two lying across the base, half burnt.
  for (let i = 0; i < 2; i++) {
    const log = cyl(0.09, 0.1, r * 1.4, 5, TIMBER_TAR, WOOD_DARK)
    log.rotateZ(Math.PI / 2)
    log.rotateY(rand() * 3)
    log.translate((rand() - 0.5) * 0.3, 0.12, (rand() - 0.5) * 0.3)
    parts.push(log)
  }

  return assemble(parts)
}

export function buildBench({ len = 1.8, seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const seat = box(len, 0.09, 0.36, WOOD, WOOD_LIGHT)
  seat.rotateY((rand() - 0.5) * 0.04)
  seat.translate(0, 0.44, 0)
  parts.push(seat)
  for (const side of [-1, 1]) {
    // Slab legs, splayed -- a bench with four stick legs reads as a table.
    const leg = box(0.12, 0.44, 0.3, WOOD_DARK, WOOD)
    leg.rotateZ(side * 0.09)
    leg.translate(side * len * 0.36, 0.22, 0)
    parts.push(leg)
  }
  return assemble(parts)
}

export function buildStool({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const seat = cyl(0.19, 0.17, 0.07, 7, WOOD, WOOD_LIGHT)
  seat.translate(0, 0.42, 0)
  parts.push(seat)
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rand()
    const leg = cyl(0.035, 0.045, 0.44, 4, WOOD_DARK, WOOD)
    leg.rotateX(Math.sin(a) * 0.16)
    leg.rotateZ(-Math.cos(a) * 0.16)
    leg.translate(Math.cos(a) * 0.11, 0.21, Math.sin(a) * 0.11)
    parts.push(leg)
  }
  return assemble(parts)
}

export function buildWell({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const wall = cyl(0.75, 0.8, 0.85, 9, STONE, STONE_LIGHT)
  wall.translate(0, 0.42, 0)
  parts.push(wall)
  const cap = cyl(0.82, 0.82, 0.1, 9, STONE_LIGHT, STONE_LIGHT)
  cap.translate(0, 0.88, 0)
  parts.push(cap)
  const dark = cyl(0.66, 0.66, 0.06, 9, C(0.006, 0.007, 0.009), C(0.006, 0.007, 0.009))
  dark.translate(0, 0.86, 0)
  parts.push(dark)
  for (const side of [-1, 1]) {
    const post = box(0.13, 1.7, 0.13, WOOD_DARK, WOOD)
    post.translate(side * 0.72, 1.2, 0)
    parts.push(post)
  }
  const beam = box(1.8, 0.14, 0.14, WOOD_DARK, WOOD)
  beam.translate(0, 2.02, 0)
  parts.push(beam)
  const roof = box(2.1, 0.12, 1.3, THATCH, THATCH_LIGHT)
  roof.rotateX(0.2 + rand() * 0.04)
  roof.translate(0, 2.2, 0)
  parts.push(roof)
  const bucket = cyl(0.16, 0.19, 0.26, 6, WOOD_DARK, WOOD)
  bucket.translate(0, 1.4, 0)
  parts.push(bucket)
  const rope = box(0.03, 0.5, 0.03, WOOD_LIGHT, WOOD_LIGHT)
  rope.translate(0, 1.76, 0)
  parts.push(rope)
  return assemble(parts)
}

export function buildCart({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const bed = box(2.4, 0.14, 1.2, WOOD, WOOD_LIGHT)
  bed.translate(0, 0.62, 0)
  parts.push(bed)
  for (const side of [-1, 1]) {
    const rail = box(2.4, 0.35, 0.08, WOOD_DARK, WOOD)
    rail.translate(0, 0.86, side * 0.56)
    parts.push(rail)
  }
  const back = box(0.08, 0.35, 1.2, WOOD_DARK, WOOD)
  back.translate(-1.16, 0.86, 0)
  parts.push(back)
  for (const side of [-1, 1]) {
    const wheel = cyl(0.42, 0.42, 0.1, 9, WOOD_DARK, WOOD)
    wheel.rotateX(Math.PI / 2)
    wheel.translate(-0.35, 0.42, side * 0.68)
    parts.push(wheel)
    for (let i = 0; i < 4; i++) {
      const spoke = box(0.05, 0.78, 0.05, WOOD, WOOD_LIGHT)
      spoke.rotateZ((i / 4) * Math.PI)
      spoke.translate(-0.35, 0.42, side * 0.68)
      parts.push(spoke)
    }
  }
  // Shafts, dropped to the ground because the cart is parked.
  for (const side of [-1, 1]) {
    const shaft = box(1.5, 0.09, 0.09, WOOD_DARK, WOOD)
    shaft.rotateZ(-0.28)
    shaft.translate(1.75, 0.35, side * 0.42)
    parts.push(shaft)
  }
  if (rand() < 0.6) {
    const load = box(1.4, 0.5, 0.9, HAY, C(0.16, 0.13, 0.055))
    load.translate(-0.1, 0.94, 0)
    parts.push(load)
  }
  return assemble(parts)
}

export function buildBarrel({ seed = 1 } = {}) {
  const parts = []
  const body = cyl(0.28, 0.32, 0.82, 8, WOOD, WOOD_LIGHT)
  body.translate(0, 0.41, 0)
  parts.push(body)
  for (const y of [0.18, 0.64]) {
    const hoop = cyl(0.325, 0.325, 0.06, 8, IRON, STONE)
    hoop.translate(0, y, 0)
    parts.push(hoop)
  }
  return assemble(parts)
}

export function buildCrate({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const s = 0.55 + rand() * 0.2
  const body = box(s, s * 0.8, s * 0.85, WOOD, WOOD_LIGHT)
  body.translate(0, s * 0.4, 0)
  parts.push(body)
  for (const side of [-1, 1]) {
    const slat = box(s + 0.03, 0.07, 0.03, WOOD_DARK, WOOD_DARK)
    slat.translate(0, s * 0.4, (side * s * 0.85) / 2)
    parts.push(slat)
  }
  if (rand() < 0.4) {
    const lid = box(s * 0.9, 0.06, s * 0.78, WOOD_DARK, WOOD)
    lid.rotateZ(0.3)
    lid.translate(s * 0.2, s * 0.9, 0)
    parts.push(lid)
  }
  return assemble(parts)
}

export function buildHaybale({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const body = cyl(0.45, 0.45, 0.85, 8, HAY, C(0.16, 0.13, 0.05))
  body.rotateZ(Math.PI / 2)
  body.rotateY(rand() * 3)
  body.translate(0, 0.45, 0)
  parts.push(body)
  for (const side of [-1, 1]) {
    const band = box(0.05, 0.9, 0.9, WOOD_DARK, WOOD_DARK)
    band.translate(side * 0.22, 0.45, 0)
    parts.push(band)
  }
  return assemble(parts)
}

export function buildWoodpile({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const rows = 3
  for (let r = 0; r < rows; r++) {
    const n = 5 - r
    for (let i = 0; i < n; i++) {
      const log = cyl(0.075, 0.085, 0.9 + rand() * 0.25, 5, WOOD_DARK, WOOD)
      log.rotateZ(Math.PI / 2)
      log.rotateY((rand() - 0.5) * 0.14)
      log.translate((i - (n - 1) / 2) * 0.17, 0.09 + r * 0.16, (rand() - 0.5) * 0.12)
      parts.push(log)
    }
  }
  return assemble(parts)
}

/** A drying rack, hung with split fish. Nothing says "Norse coast" faster. */
export function buildDryingRack({ seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const parts = []
  const H = 2.3
  const W = 3.0
  for (const side of [-1, 1]) {
    for (const lean of [-1, 1]) {
      const leg = cyl(0.06, 0.08, H, 5, WOOD_DARK, WOOD)
      leg.rotateX(lean * 0.2)
      leg.translate((side * W) / 2, H / 2, lean * 0.35)
      parts.push(leg)
    }
  }
  for (const y of [H - 0.1, H * 0.62]) {
    const bar = box(W + 0.4, 0.07, 0.07, WOOD, WOOD_LIGHT)
    bar.translate(0, y, 0)
    parts.push(bar)
    const n = 7
    for (let i = 0; i < n; i++) {
      const f = sheet(0.13, 0.44 + rand() * 0.12, C(0.075, 0.07, 0.06), C(0.14, 0.13, 0.115))
      f.rotateY((rand() - 0.5) * 0.5)
      f.translate(-W / 2 + ((i + 0.5) * W) / n, y - 0.5 - rand() * 0.08, (rand() - 0.5) * 0.1)
      parts.push(f)
    }
  }
  return assemble(parts)
}

export function buildTrough({ seed = 1 } = {}) {
  const parts = []
  const body = box(1.8, 0.34, 0.5, WOOD, WOOD_LIGHT)
  body.translate(0, 0.25, 0)
  parts.push(body)
  const water = box(1.6, 0.04, 0.36, C(0.014, 0.024, 0.032), C(0.03, 0.045, 0.058))
  water.translate(0, 0.38, 0)
  parts.push(water)
  for (const side of [-1, 1]) {
    const leg = box(0.12, 0.16, 0.4, WOOD_DARK, WOOD_DARK)
    leg.translate(side * 0.7, 0.08, 0)
    parts.push(leg)
  }
  return assemble(parts)
}

// --- livestock --------------------------------------------------------------
// Lo-fi on purpose: a body, four legs, a head, and one identifying feature.
// Facing local +Z, so plan.js's yaw points them where it wants them looking.

export function buildAnimal({ kind = 'sheep', seed = 1 }) {
  const rand = mulberry32(seed)
  const parts = []

  if (kind === 'chicken') {
    const body = blob(0.16, 0, FEATHER, C(0.16, 0.15, 0.13), 0.85)
    body.scale(1, 1, 1.3)
    body.translate(0, 0.22, 0)
    parts.push(body)
    const head = blob(0.075, 0, FEATHER, FEATHER, 1)
    head.translate(0, 0.36, 0.14)
    parts.push(head)
    const beak = cone(0.03, 0.09, 4, C(0.2, 0.12, 0.02), C(0.2, 0.12, 0.02))
    beak.rotateX(Math.PI / 2)
    beak.translate(0, 0.35, 0.23)
    parts.push(beak)
    const comb = box(0.02, 0.06, 0.09, C(0.22, 0.02, 0.015), C(0.22, 0.02, 0.015))
    comb.translate(0, 0.43, 0.13)
    parts.push(comb)
    for (const side of [-1, 1]) {
      const leg = box(0.025, 0.14, 0.025, C(0.16, 0.1, 0.02), C(0.16, 0.1, 0.02))
      leg.translate(side * 0.06, 0.07, 0)
      parts.push(leg)
    }
    // A tail fan, because a chicken without one is a potato.
    const tail = sheet(0.14, 0.16, FEATHER, C(0.1, 0.09, 0.08))
    tail.rotateX(-0.7)
    tail.translate(0, 0.26, -0.16)
    parts.push(tail)
    return assemble(parts)
  }

  const big = kind === 'cow'
  const bodyL = big ? 1.45 : kind === 'goat' ? 0.85 : 0.95
  const bodyH = big ? 0.72 : 0.5
  const legH = big ? 0.72 : kind === 'goat' ? 0.5 : 0.38
  const hide = kind === 'sheep' ? WOOL : HIDE[(rand() * HIDE.length) | 0]
  const dark = kind === 'sheep' ? C(0.03, 0.028, 0.026) : hide

  // A sheep's body is the fluff, so it gets a blob; a cow and a goat get a box,
  // which is the honest shape for a flank.
  if (kind === 'sheep') {
    const body = blob(bodyH * 0.72, 1, hide, C(0.19, 0.185, 0.17), 0.85)
    body.scale(1, 1, bodyL / (bodyH * 1.3))
    body.translate(0, legH + bodyH * 0.4, 0)
    parts.push(body)
  } else {
    const body = box(bodyH * 0.95, bodyH, bodyL, hide, hide === HIDE[2] ? C(0.16, 0.15, 0.14) : WOOD_LIGHT)
    body.translate(0, legH + bodyH / 2, 0)
    parts.push(body)
    if (big && rand() < 0.6) {
      // A patch, which is most of what makes a box read as a cow.
      const patch = box(bodyH * 0.97, bodyH * 0.45, bodyL * 0.35, HIDE[2], HIDE[2])
      patch.translate(0, legH + bodyH * 0.6, bodyL * (rand() - 0.5) * 0.5)
      parts.push(patch)
    }
  }

  const head = box(bodyH * 0.5, bodyH * 0.52, bodyH * 0.62, dark, dark)
  head.rotateX(-0.25)
  head.translate(0, legH + bodyH * (kind === 'sheep' ? 0.72 : 0.85), bodyL * 0.52)
  parts.push(head)

  if (kind === 'goat' || kind === 'cow') {
    for (const side of [-1, 1]) {
      const horn = cone(0.035, kind === 'goat' ? 0.3 : 0.18, 4, C(0.09, 0.085, 0.07), C(0.14, 0.13, 0.11))
      horn.rotateZ(side * 0.5)
      horn.rotateX(-0.4)
      horn.translate(side * bodyH * 0.16, legH + bodyH * 1.15, bodyL * 0.46)
      parts.push(horn)
    }
  }
  if (kind === 'sheep' || kind === 'goat') {
    for (const side of [-1, 1]) {
      const ear = sheet(0.16, 0.09, dark, dark)
      ear.rotateZ(side * 1.3)
      ear.translate(side * bodyH * 0.26, legH + bodyH * 0.85, bodyL * 0.5)
      parts.push(ear)
    }
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = box(bodyH * 0.16, legH, bodyH * 0.16, dark, dark)
      // A slight splay, and a little per-leg jitter, so a herd of four-legged
      // boxes does not look like a rack of tables.
      leg.rotateZ(sx * 0.04 * rand())
      leg.translate(sx * bodyH * 0.32, legH / 2, sz * bodyL * 0.33)
      parts.push(leg)
    }
  }

  const tail = box(0.06, kind === 'cow' ? 0.42 : 0.2, 0.06, dark, dark)
  tail.rotateX(0.3)
  tail.translate(0, legH + bodyH * 0.75, -bodyL * 0.53)
  parts.push(tail)

  return assemble(parts)
}

// --- fire and smoke ---------------------------------------------------------
// These two go into a SEPARATE batch with an unlit material. A flame shaded by
// the sun goes dark on its shadow side, which is the one thing that would give
// it away instantly, and MeshBasicMaterial with vertex colours near 1.0 is the
// whole trick -- no bloom pass, no second light.

/** A stylised flame: two stacked cones, twisted. Animated by scale, in village.js. */
export function buildFlame({ h = 0.42, r = 0.15, seed = 1 } = {}) {
  const parts = []
  const lower = cone(r, h * 0.62, 5, FLAME_HOT, FLAME_HOT)
  lower.translate(0, h * 0.31, 0)
  parts.push(lower)
  const upper = cone(r * 0.66, h * 0.62, 5, FLAME_HOT, FLAME_TIP)
  upper.rotateY(0.6)
  upper.translate(0, h * 0.72, 0)
  parts.push(upper)
  const tip = cone(r * 0.3, h * 0.42, 4, FLAME_TIP, FLAME_TIP)
  tip.rotateY(1.2)
  tip.translate(0, h * 1.05, 0)
  parts.push(tip)
  return assemble(parts)
}

/**
 * A smoke puff: one faceted blob, 8 triangles.
 *
 * It is OPAQUE, and that is a constraint rather than a shortcut. §7 reserves
 * alpha blending for the aurora, water, mist cards and snow -- everything
 * batched is alpha test or nothing, because blending cannot be sorted inside a
 * batched draw call at all. So a puff cannot fade out. It grows as it rises and
 * then scales to zero, which is how stylised smoke has always been done and
 * costs nothing.
 */
export function buildPuff({ r = 0.5, seed = 1 } = {}) {
  const rand = mulberry32(seed)
  const g = new THREE.OctahedronGeometry(r, 0)
  const pos = g.attributes.position
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) * (0.75 + rand() * 0.5),
      pos.getY(i) * (0.6 + rand() * 0.4),
      pos.getZ(i) * (0.75 + rand() * 0.5)
    )
  }
  g.computeVertexNormals()
  return indexify(paint(g, SMOKE_DARK, SMOKE_LIGHT))
}
