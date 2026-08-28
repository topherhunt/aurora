import THREE from '../three-instance.js'
import { LAYER } from '../textures.js'

// ---------------------------------------------------------------------------
// Procedural butterflies.
//
// The fauna brief for this one is the opposite of the crab's: "the mesh can
// be very simple, color should vary randomly and wildly (as well as size)".
// So the shape does almost nothing -- a thin swept-tube body, two curled
// antennae (both built the same way the crab builds a leg, just shorter),
// and two FLAT RECTANGULAR CARDS for the wings, one per side, no subdivision
// at all. Every bit of what makes a butterfly recognisable -- the wing's own
// outline, its bands, its spots -- lives in the alpha-cutout texture
// (props/butterfly-texture.js), exactly the trick props/fern.js uses for a
// frond, pushed one step further: a fern cuts a leaf out of its card, this
// cuts the whole silhouette of an insect out of its.
//
// COLOUR AND SIZE ARE THE POINT, not the geometry, which is why `height` and
// `hue` are not baked into a small fixed species table the way the crab's
// shell/limb colours are: gen-butterfly.html's reroll throws BOTH across a
// wide range on every press, repainting the live texture cells to match, so
// two rerolled butterflies rarely look like recoloured twins.
//
// ATTRIBUTES: always { position, normal, uvProj, texLayer }, indexed --
// the shared prop material's fixed layout, same as every other prop file.
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

export const BUTTERFLY_DEFAULTS = {
  seed: 1,

  // Wingspan, tip to tip, in metres -- the ONE size knob everything else is
  // relative to. Real butterflies run from under 2 cm (blues) to over 15 cm
  // (birdwings); gen-butterfly.html's reroll spans that whole range.
  wingSpan: 0.045,

  // --- wings --------------------------------------------------------------
  wingChord: 0.62,     // fore/aft depth of a wing card, relative to its own half-span
  wingAngle: 0.35,     // dihedral: 0 = flat and wide (gliding), ~1.4 = folded upright (perched)
  wingSweep: 0.12,     // rotation of the wing plane backward about the vertical axis
  wingMount: 0.58,      // 0..1 along the body where the wings hinge (0 = tail, 1 = head)
  wingCell: 0,         // which wing pattern (0 or 1); the body cell is paired by index

  // --- body -----------------------------------------------------------------
  bodyLength: 0.62,    // relative to wingSpan
  bodyRadius: 0.05,     // relative to bodyLength
  headBulb: 0.4,        // head radius, relative to bodyRadius

  // --- antennae -------------------------------------------------------------
  antennaLength: 0.5,   // relative to bodyLength
  antennaRadius: 0.12,  // relative to bodyRadius
  antennaSpread: 0.5,   // angle between the two antennae at the mount, radians
  antennaLift: 1.0,     // launch angle up from horizontal, radians
  antennaCurl: 1.1,     // total bend accumulated along its length, radians

  // --- resolution -----------------------------------------------------------
  bodySegments: 5,      // straight segments along the body tube
  bodyCols: 5,           // columns around the body tube
  antennaSegments: 2,
  antennaCols: 3,

  // --- material -------------------------------------------------------------
  wingLayer: LAYER.BUTTERFLY_WING,
  bodyLayer: LAYER.BUTTERFLY_WING,
}

// The wing/body sheet is a 2x2 grid of 64 px cells in a 128 px layer -- see
// props/butterfly-texture.js. Cells 0/1 are the two wing patterns, 2/3 the
// paired body tones, exactly the crab's shell/limb pairing.
const SHEET_GRID = 2
const CELL = 1 / SHEET_GRID
const INSET = 1 / 128

function cellUV(cell, u, v) {
  const cx = (cell % SHEET_GRID) * CELL
  const cy = Math.floor(cell / SHEET_GRID) * CELL
  const span = CELL - 2 * INSET
  return [cx + INSET + u * span, cy + INSET + v * span]
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

function stitchGrid(out, base, rings, cols) {
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < cols; j++) {
      const a = base + k * (cols + 1) + j
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      out.indices.push(a, d, c, a, b, d)
    }
  }
}

// ---------------------------------------------------------------------------
// Swept tube, same walker as props/crab.js's limbFrames/emitTube (not shared
// between the two files on purpose -- each prop file is self-contained, same
// convention as mushroom.js vs fern.js).
// ---------------------------------------------------------------------------

function tubeFrames(start, dir, bendAxis, totalBend, length, segments, radiusFn) {
  const frames = []
  const pos = start.clone()
  const tangent = dir.clone().normalize()
  let side = new THREE.Vector3().crossVectors(bendAxis, tangent)
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(0, 0, 1).projectOnPlane(tangent)
  if (side.lengthSq() < 1e-8) side = new THREE.Vector3(1, 0, 0).projectOnPlane(tangent)
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

function emitTube(out, frames, cols, length, layer, cell, radiusFn) {
  const base = out.positions.length / 3
  const tmp = new THREE.Vector3()
  for (const f of frames) {
    for (let j = 0; j <= cols; j++) {
      const theta = (j / cols) * TAU
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      tmp.copy(f.pos).addScaledVector(f.side, f.radius * c).addScaledVector(f.fwd, f.radius * s)
      const dR = (radiusFn(Math.min(1, f.s + 0.02)) - radiusFn(Math.max(0, f.s - 0.02))) / Math.max(1e-5, 0.04 * length)
      const n = new THREE.Vector3()
        .addScaledVector(f.side, c)
        .addScaledVector(f.fwd, s)
        .addScaledVector(f.tangent, -dR)
        .normalize()
      const [u, v] = cellUV(cell, j / cols, f.s)
      vert(out, tmp.x, tmp.y, tmp.z, n.x, n.y, n.z, u, v, layer)
    }
  }
  stitchGrid(out, base, frames.length - 1, cols)
}

const UP = new THREE.Vector3(0, 1, 0)
const FWD = new THREE.Vector3(1, 0, 0)
const RIGHT = new THREE.Vector3(0, 0, 1)

// ---------------------------------------------------------------------------
// Body: one thin tube from tail to head, a small bulb at the head end. The
// body sits along local X (tail at x=0, head at x=bodyLength) so the wings'
// own fore/aft axis and the antennae's forward launch can both just reuse X.
// ---------------------------------------------------------------------------

function addBody(out, p, bodyLength) {
  const segments = Math.max(1, Math.round(p.bodySegments))
  const cols = Math.max(3, Math.round(p.bodyCols))
  const bodyRadius = bodyLength * p.bodyRadius

  const radiusFn = (s) => {
    // Thin at the tail, a thorax bulge around the wing mount, tapering to a
    // small head -- the bulb itself is added separately below.
    const thorax = Math.exp(-Math.pow((s - p.wingMount) / 0.28, 2)) * 0.5
    const taperTail = smooth01(Math.min(1, s / 0.12))
    const taperHead = 1 - smooth01(Math.max(0, (s - 0.88) / 0.12))
    return Math.max(0.15, (0.55 + thorax) * taperTail * taperHead) * bodyRadius
  }

  const start = new THREE.Vector3(0, 0, 0)
  const frames = tubeFrames(start, FWD, UP, 0, bodyLength, segments, radiusFn)
  emitTube(out, frames, cols, bodyLength, p.bodyLayer, p.bodyCell, radiusFn)

  // Head bulb: a small sphere-ish cap at the tip, painted with the body cell
  // so it reads as part of the same animal rather than a bare tube end.
  const head = frames[frames.length - 1].pos
  const headR = bodyRadius * p.headBulb
  const bulb = new THREE.SphereGeometry(headR, 8, 6)
  const bpos = bulb.attributes.position
  const bnorm = bulb.attributes.normal
  const base = out.positions.length / 3
  for (let i = 0; i < bpos.count; i++) {
    const x = head.x + bodyLength * 0.02 + bpos.getX(i)
    const y = head.y + bpos.getY(i)
    const z = head.z + bpos.getZ(i)
    const nx = bnorm.getX(i)
    const ny = bnorm.getY(i)
    const nz = bnorm.getZ(i)
    const theta = Math.atan2(nz, ny)
    const [u, v] = cellUV(p.bodyCell, (theta / TAU + 0.5), 0.92)
    vert(out, x, y, z, nx, ny, nz, u, v, p.bodyLayer)
  }
  const bidx = bulb.index
  for (let i = 0; i < bidx.count; i++) out.indices.push(base + bidx.getX(i))
  bulb.dispose()

  return { headPos: head, bodyRadius }
}

function smooth01(t) {
  return t * t * (3 - 2 * t)
}

export function buildButterfly(options = {}) {
  const p = { ...BUTTERFLY_DEFAULTS, ...options }
  p.bodyCell = p.wingCell % 2 === 0 ? 2 : 3
  const out = makeSink()

  const span = p.wingSpan
  const bodyLength = span * p.bodyLength
  const bodyRadius = bodyLength * p.bodyRadius

  const { headPos } = addBody(out, p, bodyLength)

  // Antennae, launched from the head.
  {
    const cols = Math.max(3, Math.round(p.antennaCols))
    const segments = Math.max(1, Math.round(p.antennaSegments))
    const length = p.antennaLength * bodyLength
    const radiusFn = (s) => Math.max(0.0006, bodyRadius * p.antennaRadius * (1 - 0.7 * s))
    for (const side of [-1, 1]) {
      const yaw = side * (p.antennaSpread / 2)
      const axis = RIGHT.clone().applyAxisAngle(UP, yaw) // the side axis after yaw, doubling as the bend axis
      const dir = FWD.clone().applyAxisAngle(UP, yaw).applyAxisAngle(axis, -p.antennaLift)
      const frames = tubeFrames(headPos, dir, axis, p.antennaCurl, length, segments, radiusFn)
      emitTube(out, frames, cols, length, p.bodyLayer, p.bodyCell, radiusFn)
    }
  }

  // Wings: one flat, unsubdivided quad per side. `u` runs from the hinge
  // (0, against the body) to the wingtip (1); `v` runs fore (0, toward the
  // head) to aft (1, toward the tail) -- exactly the polar chart
  // props/butterfly-texture.js's wingMask paints against.
  {
    const hingeX = bodyLength * p.wingMount
    const wingLen = span / 2
    const chord = wingLen * p.wingChord

    for (const side of [-1, 1]) {
      const hinge = new THREE.Vector3(hingeX, bodyRadius * 0.3, 0)
      // Wing-local axes before the dihedral/sweep tilt: `out0` points away
      // from the body (mirrored per side), `fwd0` runs fore/aft along the body.
      let out0 = RIGHT.clone().multiplyScalar(side)
      let fwd0 = FWD.clone()
      // Sweep: rotate the wing plane about the vertical axis, so the outer
      // edge trails backward.
      out0.applyAxisAngle(UP, -side * p.wingSweep)
      // Dihedral: rotate the wing plane about the fore/aft axis, lifting the
      // outward edge up from horizontal toward folded-upright.
      const dihedralAxis = fwd0.clone()
      out0.applyAxisAngle(dihedralAxis, side * p.wingAngle)

      const corners = [
        [0, 0], [1, 0], [0, 1], [1, 1],
      ]
      const base = out.positions.length / 3
      const normal = new THREE.Vector3().crossVectors(out0, fwd0).normalize().multiplyScalar(side >= 0 ? 1 : -1)
      const tmp = new THREE.Vector3()
      for (const [u, v] of corners) {
        tmp.copy(hinge).addScaledVector(out0, u * wingLen).addScaledVector(fwd0, (v - 0.5) * chord)
        const [tu, tv] = cellUV(p.wingCell, u, v)
        vert(out, tmp.x, tmp.y, tmp.z, normal.x, normal.y, normal.z, tu, tv, p.wingLayer)
      }
      if (side > 0) out.indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
      else out.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3)
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  geo.setIndex(out.indices)

  geo.computeBoundingBox()
  geo.translate(0, -geo.boundingBox.min.y, 0)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()

  geo.userData.butterfly = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    wingSpan: span,
    height: geo.boundingBox.max.y - geo.boundingBox.min.y,
  }
  return geo
}

export function butterflyTriangles(options = {}) {
  const p = { ...BUTTERFLY_DEFAULTS, ...options }
  const bodySegments = Math.max(1, Math.round(p.bodySegments))
  const bodyCols = Math.max(3, Math.round(p.bodyCols))
  const antennaSegments = Math.max(1, Math.round(p.antennaSegments))
  const antennaCols = Math.max(3, Math.round(p.antennaCols))

  let tris = bodySegments * bodyCols * 2
  tris += 2 * 8 * (6 - 1) // SphereGeometry(_, 8, 6) triangle count (head bulb) -- pole rows are triangle fans, not full quads
  tris += 2 * antennaSegments * antennaCols * 2 // two antennae
  tris += 2 * 2 // two wing quads
  return tris
}
