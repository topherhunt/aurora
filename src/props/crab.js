import * as THREE from 'three'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural crabs.
//
// A crab is a mushroom's carapace with legs instead of a stem, and that is
// most of the design: the domed shell top and its flat-ish belly close onto
// each other exactly the way a mushroom's cap and gilled underside do (see
// props/mushroom.js, points 1-3 in its header, not repeated here), and every
// limb -- eyestalk, pincer arm, claw prong, walking leg -- is the same
// swept-tube centreline walk as the mushroom's stem, just parameterised by an
// explicit start point and launch direction instead of always growing from
// the origin.
//
// COLOUR LIVES IN THE TEXTURE (props/crab-texture.js): a shell cell for the
// domed carapace top and belly, a limb cell for every tube. The two sheets
// are paired by index, so `shellCell: 1, limbCell: 1` is one consistent
// animal. The per-instance tint (BatchedMesh.setColorAt) is left for a
// gentle per-instance jitter, same reasoning as the mushroom.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, indexed. That is
// the shared prop material's fixed layout and BatchedMesh rejects a geometry
// that disagrees.
//
// SCOPE: mesh and texture only. Animation/rigging is a later phase and
// nothing here builds toward a skeleton -- the legs are static geometry in a
// standing pose.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

export const CRAB_DEFAULTS = {
  seed: 1,

  // Everything below is relative to a unit-tall crab; the geometry is
  // measured and rescaled at the end so the built thing is exactly `height`
  // metres tall, ground to the top of the carapace. Same reasoning as
  // buildMushroom: too many knobs move the top for a closed form to hit a
  // metre target any other way.
  height: 0.09, // metres. A shore crab is 5-8 cm across; this is a small one

  // --- carapace ---------------------------------------------------------
  shellWidth: 0.62,  // half-width, side to side (the wide axis of a crab)
  shellLength: 0.5,  // half-width, front to back (the narrow axis)
  shellRise: 0.34,   // dome height above the rim
  shellCurve: 2.0,   // 1 = conical, 2 = domed, 4+ = flat with a shoulder
  bellyDepth: 0.12,  // how far the underside dishes down from the rim
  bellyCurve: 1.6,

  // --- eyestalks ----------------------------------------------------------
  eyeLength: 0.32,   // relative to shellLength
  eyeRadius: 0.022,
  eyeBulb: 0.05,      // bulb radius at the tip
  eyeSpread: 0.5,     // angle between the two stalks at the mount, radians
  eyeLift: -0.5,      // launch angle up from horizontal, radians

  // --- pincers (chelae) ---------------------------------------------------
  armLength: 0.58,
  armRadius: 0.034,
  armTaper: 0.3,      // 0..1, thinner toward the claw
  armLift: 0.18,      // launch angle up from horizontal, radians
  armSplay: 0.58,      // angle outward from straight-forward, radians
  clawLength: 0.48,
  clawRadius: 0.071,
  clawGape: 0.4,      // half-angle between the two claw prongs, radians
  clawAsymmetry: 0.48, // 0 = matched pincers, up to ~0.6 = one much bigger

  // --- walking legs ---------------------------------------------------------
  legPairs: 3,
  legLength: 0.65,
  legRadius: 0.031,
  legTaper: 0.72,     // fraction the radius shrinks by, tip vs base
  legSpan: 1.16,        // arc along each flank the legs fan across, radians
  legLift0: 0.18,      // initial angle above horizontal at the mount
  legDroop: 2.3,       // additional downward bend accumulated to the tip

  // --- resolution -----------------------------------------------------------
  shellRadial: 9,     // columns around the carapace disc
  shellCapRings: 2,   // rings apex to rim on the shell top
  shellUnderRings: 1, // rings axis to rim on the belly
  limbCols: 3,        // columns around every tube (leg, arm, claw, eyestalk)
  legSegments: 2,      // straight segments per leg (the swept-tube walk)
  armSegments: 2,
  clawSegments: 1,
  eyeSegments: 2,

  // --- material -------------------------------------------------------------
  shellLayer: LAYER.CRAB_SHELL,
  limbLayer: LAYER.CRAB_LIMB,
  shellCell: 0, // which cell of the shell sheet (0..3)
  limbCell: 0,  // ...and of the limb sheet, paired by index
}

// Both crab sheets are a 2x2 grid of 64 px cells in a 128 px layer, same
// shape as the mushroom sheets -- see props/crab-texture.js.
const SHEET_GRID = 2
const CELL = 1 / SHEET_GRID
const INSET = 1 / 128

function cellUV(cell, u, v) {
  const cx = (cell % SHEET_GRID) * CELL
  const cy = Math.floor(cell / SHEET_GRID) * CELL
  const span = CELL - 2 * INSET
  return [cx + INSET + u * span, cy + INSET + v * span]
}

// Planar projection along the carapace's own axis, exactly the mushroom
// cap's `capUV` -- see its header for why this is affine and therefore exact
// under linear interpolation regardless of triangle count. `rN` is the
// vertex's own disc parameter `t`, since the carapace's radius is linear in
// t (no wavy rim or inroll here to make it otherwise).
function capUV(cell, rN, theta) {
  const cx = (cell % SHEET_GRID) * CELL
  const cy = Math.floor(cell / SHEET_GRID) * CELL
  const half = (CELL - 2 * INSET) * 0.5
  return [
    cx + CELL * 0.5 + rN * half * Math.cos(theta),
    cy + CELL * 0.5 + rN * half * Math.sin(theta),
  ]
}

// Central-difference analytic normal, identical technique to the mushroom's
// `surfaceNormal` -- sampling the parametric surface keeps theta continuous
// so there is no bright seam at the UV wrap boundary. `point(t, theta, out)`
// writes into `out` and this returns a shared, mutated Vector3.
const _du = new THREE.Vector3()
const _dt = new THREE.Vector3()
const _n = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

function surfaceNormal(point, t, theta, flip) {
  const dt = 1e-3
  const dth = 1e-3
  const t0 = Math.max(0, t - dt)
  const t1 = Math.min(1, t + dt)

  point(t1, theta, _a)
  point(t0, theta, _b)
  _dt.subVectors(_a, _b)

  point(t, theta + dth, _a)
  point(t, theta - dth, _b)
  _du.subVectors(_a, _b)

  _n.crossVectors(_du, _dt).normalize()
  if (!Number.isFinite(_n.x) || _n.lengthSq() < 0.5) _n.set(0, flip ? -1 : 1, 0)
  else if (flip) _n.negate()
  return _n
}

// ---------------------------------------------------------------------------
// Limbs: one swept-tube walker shared by legs, pincer arms, claw prongs and
// eyestalks. Unlike the mushroom's `stemFrames`, which always launches from
// the origin, this takes an explicit mount point and direction so a limb can
// start anywhere on the carapace rim. Frames are parallel-transported so a
// bent limb does not twist its texture along its length.
// ---------------------------------------------------------------------------

function limbFrames(start, dir, bendAxis, totalBend, length, segments, radiusFn) {
  const frames = []
  const pos = start.clone()
  const tangent = dir.clone().normalize()
  let side = new THREE.Vector3().crossVectors(bendAxis, tangent)
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(1, 0, 0).projectOnPlane(tangent)
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(0, 0, 1).projectOnPlane(tangent)
  side.normalize()

  const ds = 1 / segments
  for (let k = 0; k <= segments; k++) {
    const s = k * ds
    const fwd = new THREE.Vector3().crossVectors(side, tangent).normalize()
    frames.push({ pos: pos.clone(), tangent: tangent.clone(), side: side.clone(), fwd, radius: radiusFn(s), s })
    if (k === segments) break
    pos.addScaledVector(tangent, length * ds)
    if (totalBend !== 0) {
      tangent.applyAxisAngle(bendAxis, totalBend * ds).normalize()
      side = side.projectOnPlane(tangent).normalize()
    }
  }
  return frames
}

function makeSink() {
  return { positions: [], normals: [], uvs: [], layers: [], indices: [] }
}

function vert(out, x, y, z, nx, ny, nz, u, v, layer) {
  out.positions.push(x, y, z)
  out.normals.push(nx, ny, nz)
  out.uvs.push(u, v)
  out.layers.push(layer)
  return out.positions.length / 3 - 1
}

// A grid of (rings + 1) x (cols + 1) vertices stitched into quads, rows
// inner-to-outer / base-to-tip. `up` picks the winding, same convention as
// the mushroom's `stitchGrid`.
function stitchGrid(out, base, rings, cols, up) {
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < cols; j++) {
      const a = base + k * (cols + 1) + j
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      if (up) {
        out.indices.push(a, d, c, a, b, d)
      } else {
        out.indices.push(a, c, d, a, d, b)
      }
    }
  }
}

// Emit one tube (leg, arm, claw prong or eyestalk) along `frames`, radius
// already baked into each frame by `limbFrames`. `radiusFn` is handed in a
// second time purely to compute dR/ds for a correctly tipped-back normal,
// exactly the mushroom stem's technique.
// `opts.pointyTip` collapses the last ring into a single point and closes
// the final segment with a triangle fan (cols triangles) instead of a quad
// strip (2*cols) -- a true cone tip, cheaper than tapering the last ring
// down to a near-zero-radius quad and looking pointed for it.
function emitTube(out, frames, cols, length, layer, cell, radiusFn, opts = {}) {
  const pointyTip = !!opts.pointyTip
  const ringCount = pointyTip ? frames.length - 1 : frames.length
  const base = out.positions.length / 3
  const tmp = new THREE.Vector3()
  for (let fi = 0; fi < ringCount; fi++) {
    const f = frames[fi]
    for (let j = 0; j <= cols; j++) {
      const theta = (j / cols) * TAU
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      tmp.copy(f.pos).addScaledVector(f.side, f.radius * c).addScaledVector(f.fwd, f.radius * s)
      const dR = (radiusFn(Math.min(1, f.s + 0.02)) - radiusFn(Math.max(0, f.s - 0.02)))
        / Math.max(1e-5, 0.04 * length)
      const n = new THREE.Vector3()
        .addScaledVector(f.side, c)
        .addScaledVector(f.fwd, s)
        .addScaledVector(f.tangent, -dR)
        .normalize()
      const [u, v] = cellUV(cell, j / cols, f.s)
      vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, layer)
    }
  }
  stitchGrid(out, base, ringCount - 1, cols, true)

  if (pointyTip) {
    const tip = frames[frames.length - 1]
    const [tu, tv] = cellUV(cell, 0.5, 1)
    const tipIdx = vert(out, tip.pos.x, tip.pos.y, tip.pos.z, tip.tangent.x, tip.tangent.y, tip.tangent.z, tu, tv, layer)
    const ringBase = base + (ringCount - 1) * (cols + 1)
    for (let j = 0; j < cols; j++) out.indices.push(ringBase + j, ringBase + j + 1, tipIdx)
  }
}

// ---------------------------------------------------------------------------
// The carapace: a dome (shell top) and a shallow dish (belly) that meet
// exactly at the rim (t = 1, y = 0 on both surfaces), so the shell closes
// with no separate rim wall needed -- the crab equivalent of the mushroom
// cap meeting its own gilled underside.
// ---------------------------------------------------------------------------

// Real crabs flare wider at the front (where the eyes and claws sit) and
// taper narrower at the rear -- a continuous stand-in for a pentagonal
// outline rather than the plain ellipse `cos/sin * shellWidth/shellLength`
// draws on its own. `theta = PI/2` is the front (see rimMount/addEyestalks),
// so `Math.sin(theta)` is +1 there and -1 at the rear.
function shellRadialScale(theta) {
  const front = Math.sin(theta)
  return front >= 0 ? 1 + 0.12 * front : 1 + 0.15 * front
}

function addCarapace(out, p) {
  const cols = Math.max(3, Math.round(p.shellRadial))

  const topPoint = (t, theta, target) => {
    const rs = shellRadialScale(theta)
    const x = t * Math.cos(theta) * p.shellWidth * rs
    const z = t * Math.sin(theta) * p.shellLength * rs
    const y = p.shellRise * (1 - Math.pow(t, p.shellCurve))
    return target.set(x, y, z)
  }
  const underPoint = (t, theta, target) => {
    const rs = shellRadialScale(theta)
    const x = t * Math.cos(theta) * p.shellWidth * rs
    const z = t * Math.sin(theta) * p.shellLength * rs
    const y = -p.bellyDepth * (1 - Math.pow(t, p.bellyCurve))
    return target.set(x, y, z)
  }

  const tmp = new THREE.Vector3()
  const capRings = Math.max(1, Math.round(p.shellCapRings))
  const topBase = out.positions.length / 3
  for (let k = 0; k <= capRings; k++) {
    const t = k / capRings
    for (let j = 0; j <= cols; j++) {
      const theta = (j / cols) * TAU
      topPoint(t, theta, tmp)
      const n = surfaceNormal(topPoint, t, theta, false)
      const [u, v] = capUV(p.shellCell, t, theta)
      vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.shellLayer)
    }
  }
  // The apex row is `cols + 1` coincident vertices; skip its degenerate
  // second triangle per quad, same as the mushroom cap.
  for (let k = 0; k < capRings; k++) {
    for (let j = 0; j < cols; j++) {
      const a = topBase + k * (cols + 1) + j
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      out.indices.push(a, d, c)
      if (k !== 0) out.indices.push(a, b, d)
    }
  }

  const underRings = Math.max(1, Math.round(p.shellUnderRings))
  const underBase = out.positions.length / 3
  for (let k = 0; k <= underRings; k++) {
    const t = k / underRings
    for (let j = 0; j <= cols; j++) {
      const theta = (j / cols) * TAU
      underPoint(t, theta, tmp)
      const n = surfaceNormal(underPoint, t, theta, true)
      const [u, v] = cellUV(p.limbCell, j / cols, t)
      vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, p.limbLayer)
    }
  }
  for (let k = 0; k < underRings; k++) {
    for (let j = 0; j < cols; j++) {
      const a = underBase + k * (cols + 1) + j
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      out.indices.push(a, c, d)
      if (k !== 0) out.indices.push(a, d, b)
    }
  }
}

// ---------------------------------------------------------------------------
// A rim mount point and its outward radial direction, shared by every limb
// so eyestalks, pincers and legs all attach exactly on the carapace's edge.
// ---------------------------------------------------------------------------

function rimMount(p, theta) {
  const radial = new THREE.Vector3(Math.cos(theta), 0, Math.sin(theta)).normalize()
  const rs = shellRadialScale(theta)
  const pos = new THREE.Vector3(
    Math.cos(theta) * p.shellWidth * rs,
    0,
    Math.sin(theta) * p.shellLength * rs,
  )
  return { pos, radial }
}

const UP = new THREE.Vector3(0, 1, 0)

// Bend axis perpendicular to both a rim mount's outward radial direction and
// up: rotating a tangent about it tips the limb between horizontal-outward
// and vertical, which is what every limb on this animal does.
function verticalBendAxis(radial) {
  return new THREE.Vector3().crossVectors(radial, UP).normalize()
}

// ---------------------------------------------------------------------------
// Eyestalks: thin tubes launched up and forward from the front of the
// carapace, each ending in a small bulb (a bump in the radius profile near
// the tip) closed off by a flat end-cap fan.
// ---------------------------------------------------------------------------

function addEyestalks(out, p) {
  const cols = Math.max(3, Math.round(p.limbCols))
  const segments = Math.max(1, Math.round(p.eyeSegments))
  const length = p.eyeLength * p.shellLength

  for (const side of [-1, 1]) {
    const theta = Math.PI / 2 - side * (p.eyeSpread / 2)
    const { pos, radial } = rimMount(p, theta)
    const bendAxis = verticalBendAxis(radial)
    const dir = radial.clone().applyAxisAngle(bendAxis, -p.eyeLift)

    const radiusFn = (s) => {
      const taper = p.eyeRadius * (1 - 0.6 * s)
      const bulb = p.eyeBulb * Math.exp(-Math.pow((s - 0.92) / 0.1, 2))
      return Math.max(0.002, taper + bulb)
    }
    const frames = limbFrames(pos, dir, bendAxis, 0.15, length, segments, radiusFn)
    emitTube(out, frames, cols, length, p.limbLayer, p.limbCell, radiusFn)

    // End cap: a small fan closing the bulb's tip so the eye is a solid.
    const tip = frames[frames.length - 1]
    const capCentre = tip.pos.clone().addScaledVector(tip.tangent, tip.radius * 0.4)
    const centreIdx = vert(
      out, capCentre.x, capCentre.y, capCentre.z,
      tip.tangent.x, tip.tangent.y, tip.tangent.z,
      ...cellUV(p.limbCell, 0.5, 1), p.limbLayer,
    )
    const ringBase = out.positions.length / 3
    const tmp = new THREE.Vector3()
    for (let j = 0; j <= cols; j++) {
      const th = (j / cols) * TAU
      tmp.copy(tip.pos)
        .addScaledVector(tip.side, tip.radius * Math.cos(th))
        .addScaledVector(tip.fwd, tip.radius * Math.sin(th))
      const [u, v] = cellUV(p.limbCell, j / cols, 1)
      vert(out, tmp.x, tmp.y, tmp.z, tip.tangent.x, tip.tangent.y, tip.tangent.z, u, v, p.limbLayer)
    }
    for (let j = 0; j < cols; j++) out.indices.push(centreIdx, ringBase + j, ringBase + j + 1)
  }
}

// ---------------------------------------------------------------------------
// Pincers: an arm from the carapace's front corner to a claw made of two
// tapered prongs diverging in a V. `clawAsymmetry` scales one side up and
// the other down around 1, so a fiddler-style major claw is one knob away.
// ---------------------------------------------------------------------------

function addPincer(out, p, side, scale) {
  const cols = Math.max(3, Math.round(p.limbCols))
  const armSegments = Math.max(1, Math.round(p.armSegments))
  const clawSegments = Math.max(1, Math.round(p.clawSegments))
  const armLength = p.armLength * p.shellLength * scale
  const clawLength = p.clawLength * p.shellLength * scale

  const theta = Math.PI / 2 - side * p.armSplay
  const { pos, radial } = rimMount(p, theta)
  const bendAxis = verticalBendAxis(radial)
  const dir = radial.clone().applyAxisAngle(bendAxis, -p.armLift)

  const armRadiusFn = (s) => Math.max(0.002, p.armRadius * scale * (1 - p.armTaper * s))

  // Two straight segments meeting at an elbow, bent inward toward the
  // front-centre by a fixed interior angle -- a crab holds its claws out in
  // front of it with its arms bent, rather than pointing them straight out
  // to the side.
  const ELBOW_INTERIOR = (100 * Math.PI) / 180
  const hasElbow = armSegments >= 2
  const upperFrac = hasElbow ? 1 / armSegments : 1
  const upperLen = armLength * upperFrac
  const upperSegments = hasElbow ? 1 : armSegments
  const upperRadiusFn = (s) => armRadiusFn(s * upperFrac)
  const upperFrames = limbFrames(pos, dir, bendAxis, 0, upperLen, upperSegments, upperRadiusFn)
  emitTube(out, upperFrames, cols, upperLen, p.limbLayer, p.limbCell, upperRadiusFn)

  let armTip = upperFrames[upperFrames.length - 1]

  if (hasElbow) {
    const turn = Math.PI - ELBOW_INTERIOR
    const forearmDir = armTip.tangent.clone().applyAxisAngle(UP, -side * turn)
    const lowerLen = armLength - upperLen
    const lowerSegments = armSegments - 1
    const lowerRadiusFn = (s) => armRadiusFn(upperFrac + s * (1 - upperFrac))
    const lowerFrames = limbFrames(armTip.pos, forearmDir, bendAxis, 0, lowerLen, lowerSegments, lowerRadiusFn)
    emitTube(out, lowerFrames, cols, lowerLen, p.limbLayer, p.limbCell, lowerRadiusFn)
    armTip = lowerFrames[lowerFrames.length - 1]
  }

  // The claw's own bend axis is vertical at the arm tip, so the two prongs
  // splay apart left/right (in the arm's own side/fwd plane) rather than up
  // and down.
  const clawRadiusFn = (s) => Math.max(0.001, p.clawRadius * scale * (1 - 0.75 * s))
  for (const prongSide of [-1, 1]) {
    // Splay the prong direction about the vertical axis through the tip.
    const dirP = armTip.tangent.clone().applyAxisAngle(UP, prongSide * p.clawGape)
    const framesP = limbFrames(armTip.pos, dirP, UP, 0, clawLength, clawSegments, clawRadiusFn)
    emitTube(out, framesP, cols, clawLength, p.limbLayer, p.limbCell, clawRadiusFn)
  }
}

function addPincers(out, p) {
  const major = 1 + Math.max(0, p.clawAsymmetry) * 0.6
  const minor = 1 - Math.max(0, p.clawAsymmetry) * 0.4
  addPincer(out, p, -1, major)
  addPincer(out, p, 1, minor)
}

// ---------------------------------------------------------------------------
// Walking legs: `legPairs` pairs fanned along each flank, launched near-
// horizontal and bending down toward the ground as they extend, tapering to
// a near-zero tip.
// ---------------------------------------------------------------------------

function addLegs(out, p) {
  const cols = Math.max(3, Math.round(p.limbCols))
  const segments = Math.max(1, Math.round(p.legSegments))
  const length = p.legLength * p.shellWidth
  const pairs = Math.max(1, Math.round(p.legPairs))

  for (const side of [-1, 1]) {
    for (let i = 0; i < pairs; i++) {
      const spanT = pairs === 1 ? 0.5 : i / (pairs - 1)
      const offset = (spanT - 0.5) * p.legSpan
      const theta = side === 1 ? offset : Math.PI - offset

      const { pos, radial } = rimMount(p, theta)
      const bendAxis = verticalBendAxis(radial)
      const dir = radial.clone().applyAxisAngle(bendAxis, -p.legLift0)

      const radiusFn = (s) => Math.max(0.0015, p.legRadius * (1 - p.legTaper * s))
      const frames = limbFrames(pos, dir, bendAxis, -p.legDroop, length, segments, radiusFn)
      emitTube(out, frames, cols, length, p.limbLayer, p.limbCell, radiusFn, { pointyTip: true })
    }
  }
}

export function buildCrab(options = {}) {
  const p = { ...CRAB_DEFAULTS, ...options }
  const out = makeSink()

  addCarapace(out, p)
  addEyestalks(out, p)
  addPincers(out, p)
  addLegs(out, p)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  geo.setIndex(out.indices)

  // Rescale to the requested height, then sit it on y = 0 -- built at unit
  // scale because `shellRise`, `legDroop` etc all move the extremes, so the
  // only honest way to hit a metre target is to build it and measure it.
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const raw = bb.max.y - bb.min.y
  if (raw > 1e-9) geo.scale(p.height / raw, p.height / raw, p.height / raw)
  geo.computeBoundingBox()
  geo.translate(0, -geo.boundingBox.min.y, 0)
  geo.computeBoundingSphere()

  geo.userData.crab = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    height: p.height,
    spread: 2 * Math.max(
      Math.abs(geo.boundingBox.min.x), Math.abs(geo.boundingBox.max.x),
      Math.abs(geo.boundingBox.min.z), Math.abs(geo.boundingBox.max.z)
    ),
  }
  return geo
}

// The triangle count a given parameter set will produce, without building
// it -- used by the bench to price a parameter set before dragging a slider
// onto it.
export function crabTriangles(options = {}) {
  const p = { ...CRAB_DEFAULTS, ...options }
  const cols = Math.max(3, Math.round(p.shellRadial))
  const limbCols = Math.max(3, Math.round(p.limbCols))
  const capRings = Math.max(1, Math.round(p.shellCapRings))
  const underRings = Math.max(1, Math.round(p.shellUnderRings))
  const legSegments = Math.max(1, Math.round(p.legSegments))
  const armSegments = Math.max(1, Math.round(p.armSegments))
  const clawSegments = Math.max(1, Math.round(p.clawSegments))
  const eyeSegments = Math.max(1, Math.round(p.eyeSegments))
  const legPairs = Math.max(1, Math.round(p.legPairs))

  let tris = cols * (2 * capRings - 1) // shell top, apex row half-degenerate
  tris += cols * (2 * underRings - 1)  // belly, same reasoning
  tris += 2 * (limbCols * 2 * eyeSegments + limbCols) // eyestalks + end caps
  tris += 2 * (limbCols * 2 * armSegments + 2 * limbCols * 2 * clawSegments) // pincers
  tris += 2 * legPairs * limbCols * (2 * legSegments - 1) // legs, last segment a pointy fan
  return tris
}
