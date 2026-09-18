import THREE from '../three-instance.js'
import { mulberry32 } from '../sim/mathx.js'
import { applyHomography, quadToSquare } from '../mesh/homography.js'

// ---------------------------------------------------------------------------
// The carrot's greens: a rosette of leaves sprouting from the crown of the
// shipped root (gen-props/carrot.glb, a Tripo pick at 50 faces), built the way
// a fern's fronds are (props/fern.js): each leaf is one ribbon of `segments`
// quads bent along an integrated centreline, launched at `pitch` and arching
// over by `arch`, the outer leaves flatter than the inner.
//
// What differs from a frond is the cut. fern_frond_0.png is a rectangle and
// its ribbon is a rectangle; carrot-leaf.png is a hand-marked QUAD of the
// photograph warped to fill its square (tools/props/cut-carrot-leaf.mjs), the
// stem and the tip in two opposite corners and the leaf's two widest points in
// the other two. So the ribbon here is built on that quad's own outline --
// zero width at the stem and at the tip, the width at every seam read off the
// quad's two side chains -- and every vertex is handed the uv the warp sent
// its point to (mesh/homography.js), which undoes the warp across the ribbon
// the way tree.js's addQuadCard undoes it across a card. The per-seam chords
// of the outline clip a sliver off each side corner; the art there is leaflet
// tips against air, so nothing is lost that the alpha would have kept.
//
// The ribbon's end triangles would be degenerate (a seam of zero width), so
// they are not emitted: a leaf costs 2 * segments - 2 triangles, six at the
// shipped four segments, and needs at least two segments to exist.
//
// Attributes are { position, normal, uv } with the crown at the origin; the
// caller seats the geometry on the root's crown and the leaf texture is bound
// as an ordinary `map`, flipY false, so file row 0 lands at v = 0 as the cut
// assumes.
// ---------------------------------------------------------------------------

// The cut's corners in the leaf's own frame -- stem at the origin, the tip one
// unit up Y, X across to the photograph's right -- in the texture's scan
// order: (0,0) left, (1,0) tip, (1,1) right, (0,1) stem. Printed by
// cut-carrot-leaf.mjs; a property of the art.
export const CARROT_LEAF_QUAD = [[-0.4356, 0.5141], [0, 1], [0.4286, 0.5412], [0, 0]]

export const CARROT_DEFAULTS = {
  seed: 1,

  // --- crown ---
  leaves: 7,          // leaf count
  crownRadius: 0.006, // metres the leaf bases sit from the axis
  crownRise: 0.008,   // metres the bases are stacked up the axis

  // --- leaf shape ---
  segments: 4,        // quads along each leaf; the end ones are triangles
  leafLength: 0.28,   // metres, stem to tip along the ribbon
  lengthVar: 0.15,    // per-leaf length jitter, fraction
  widthScale: 1.0,    // multiplies the cut's own width (0.86 of its length)
  pitch: 1.3,         // launch angle above horizontal, radians
  arch: 1.15,         // total bend from launch to tip, radians
  curve: 1.3,         // >1 concentrates the bend toward the tip
  tipBias: 1.0,       // >1 crowds the seams toward the tip; 1 is even, which
                      // puts a seam at the quad's widest point
  sway: 0.25,         // lateral drift along a leaf, so it leaves its plane
  roll: 0.3,          // twist about the leaf's own axis, radians at the tip

  // --- rosette ---
  pitchFalloff: 0.3,  // outer leaves launch flatter than inner ones
  yawJitter: 0.3,     // fraction of the even spacing each leaf may wander
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const [LEFT, TIP, RIGHT, STEM] = CARROT_LEAF_QUAD
const LEAF_UV = quadToSquare(LEFT, TIP, RIGHT, STEM)

// Where a side chain of the quad (stem -> corner -> tip) crosses the line
// `s` of the way up the axis.
const chainX = ([cx, cy], s) => (s <= cy ? (cx * s) / cy : (cx * (1 - s)) / (1 - cy))

function addLeaf(out, p) {
  const { positions, normals, uvs, indices } = out
  const base = positions.length / 3

  const cosY = Math.cos(p.yaw)
  const sinY = Math.sin(p.yaw)
  const outward = new THREE.Vector3(cosY, 0, sinY)
  const side = new THREE.Vector3(-sinY, 0, cosY)
  const up = new THREE.Vector3(0, 1, 0)

  const pos = new THREE.Vector3(p.baseX, p.baseY, p.baseZ)
  const tangent = new THREE.Vector3()
  const bladeSide = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tmp = new THREE.Vector3()

  const seamAt = (k) => Math.pow(k / p.segments, 1 / Math.max(0.2, p.tipBias))

  for (let k = 0; k <= p.segments; k++) {
    const s = seamAt(k)
    const ang = p.pitch - p.arch * Math.pow(s, p.curve)
    const drift = p.sway * s * s
    tangent.copy(outward).multiplyScalar(Math.cos(ang))
    tangent.addScaledVector(up, Math.sin(ang))
    tangent.addScaledVector(side, drift)
    tangent.normalize()
    bladeSide.copy(side).applyAxisAngle(tangent, p.roll * s).normalize()
    // bladeSide x tangent faces the quads' winding; see fern.js on why the
    // other order reads as a leaf lit from underneath.
    normal.crossVectors(bladeSide, tangent).normalize()

    // The two edges of the outline at this seam, in leaf-frame units, and the
    // uv the warp gave each point.
    for (const x of [chainX(LEFT, s), chainX(RIGHT, s)]) {
      tmp.copy(pos).addScaledVector(bladeSide, x * p.length * p.widthScale)
      positions.push(tmp.x, tmp.y, tmp.z)
      normals.push(normal.x, normal.y, normal.z)
      uvs.push(...applyHomography(LEAF_UV, x, s))
    }

    if (k < p.segments) {
      const a = base + k * 2
      if (k > 0) indices.push(a, a + 1, a + 3)
      if (k < p.segments - 1) indices.push(a, a + 3, a + 2)
      pos.addScaledVector(tangent, p.length * (seamAt(k + 1) - s))
    }
  }
}

export function buildCarrotLeaves(options = {}) {
  const p = { ...CARROT_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)
  const out = { positions: [], normals: [], uvs: [], indices: [] }

  const count = Math.max(1, Math.round(p.leaves))
  const segments = Math.max(2, Math.round(p.segments))
  for (let i = 0; i < count; i++) {
    // Even radial spread plus jitter; `f` runs outermost-first, as in the fern.
    const f = count === 1 ? 0 : i / (count - 1)
    const yaw = i * GOLDEN_ANGLE + (rand() - 0.5) * GOLDEN_ANGLE * p.yawJitter * 2
    const length = p.leafLength * (1 + (rand() - 0.5) * 2 * p.lengthVar)
    const pitch = p.pitch * (1 - p.pitchFalloff * (1 - f))
    const arch = p.arch * (0.85 + rand() * 0.3)
    addLeaf(out, {
      yaw,
      baseX: Math.cos(yaw) * p.crownRadius,
      baseY: p.crownRise * rand(),
      baseZ: Math.sin(yaw) * p.crownRadius,
      segments,
      pitch,
      arch,
      curve: Math.max(0.2, p.curve),
      tipBias: p.tipBias,
      length,
      widthScale: p.widthScale,
      sway: p.sway * (rand() - 0.5) * 2,
      roll: p.roll * (rand() - 0.5) * 2,
    })
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(out.uvs, 2))
  geo.setIndex(out.indices)
  geo.computeBoundingBox()
  geo.computeBoundingSphere()
  geo.userData.carrot = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    leaves: count,
  }
  return geo
}
