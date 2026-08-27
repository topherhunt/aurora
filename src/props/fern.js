import * as THREE from 'three'
import { mulberry32 } from '../sim/mathx.js'

// ---------------------------------------------------------------------------
// Procedural ferns.
//
// A fern is a ROSETTE, not a small tree: fronds emerge from one crown point,
// each arching along its own curve, with the outer ones lying flatter than the
// inner ones. That is the whole shape, and it is why no tree generator fits --
// ez-tree and friends model trunk -> children-at-angle, which is a different
// plant.
//
// Each frond is ONE bent ribbon of `segments` quads carrying ONE texture: a
// single scanned frond cut out of the Lady Fern megascan sheet by
// tools/props/extract-frond.mjs. The silhouette -- every pinna, the taper to
// the tip, the notch of each leaflet -- lives entirely in the alpha channel.
// The geometry is a plain rectangle bent along a curve and never tries to
// describe a leaflet, which is what keeps a convincing fern inside the `small`
// class's triangle budget (DESIGN.md §5: 16 tris, hard cull at 26 m).
//
// This sidesteps the failure recorded in DESIGN.md §9 (bugs 10-11) rather than
// fighting it. Photoreal card foliage cannot be decimated -- every leaf is its
// own quad, so the mesh is ~100% boundary edges and the collapse decimator
// does nothing at all. Here nothing is ever decimated: the fern is CONSTRUCTED
// at its target budget, so the boundary-edge floor never enters the picture.
// TASKS.md asked whether 15 triangles can be a fern at all. Not by crushing a
// scan down to 15; yes by building 15 on purpose.
//
// ATTRIBUTES: two layouts, chosen by whether `frondLayers` is passed, because
// BatchedMesh requires every geometry in a batch to agree on the attribute set.
//   - omitted  -> { position, normal, uv }. One bound texture. NOTHING RENDERS
//     THIS ANY MORE -- gen-fern.html moved to the shared prop material when the
//     card arrived, so the only callers left are the node probes, which measure
//     geometry and never sample a texel. Note that a sampler2D bound the
//     ordinary way defaults to flipY = true, so a renderer brought back onto
//     this layout would see the frond upside down against the v below.
//   - an array -> { position, normal, uvProj, texLayer }. The shared prop
//     material's layout (src/material.js): one sampler2DArray, one material,
//     one multi-draw call for every prop in the world.
// The old placeholder batch in props/scatter.js is vertexColors with no texture
// and still cannot hold a fern -- a fern without its alpha mask is a rectangle.
// ---------------------------------------------------------------------------

export const FERN_DEFAULTS = {
  seed: 1,

  // --- crown ---
  fronds: 7,          // frond count
  height: 0.55,       // final overall height in metres (geometry is rescaled to hit this)
  crownRadius: 0.035, // how far frond bases sit from the axis; 0 = all from one point
  crownRise: 0.02,    // how far up the axis the bases are stacked

  // --- frond shape ---
  segments: 3,        // quads along each frond. 2-4 is the useful range
  pitch: 1.35,        // launch angle above horizontal, radians (~77 deg)
  arch: 0.95,         // total bend from launch to tip, radians. Bigger = more droop
  curve: 1.35,        // >1 concentrates the bend toward the tip (a real frond is
                      // stiff at the base and floppy at the end)
  length: 1.0,        // frond length, relative -- absolute size comes from `height`
  lengthVar: 0.22,    // per-frond length jitter, fraction
  widthScale: 1.0,    // multiplies the frond's natural width (from texture aspect)
  taper: 0.0,         // geometric narrowing toward the tip. Default 0: the TEXTURE
                      // already tapers, and doing it twice pinches the tip away
  sway: 0.35,         // lateral drift along a frond, so it does not stay planar
  roll: 0.3,          // twist of the blade about its own axis, radians at the tip

  // --- rosette ---
  pitchFalloff: 0.28, // some fronds flatter than others. This is the single
                      // knob that most makes a rosette read as a rosette
  yawJitter: 0.35,    // fraction of the even spacing that each frond may wander
  crozier: 0,         // 0..1 fraction of fronds built as curled fiddleheads

  // --- source ---
  frondAspect: 0.378, // width/height of the source frond cutout; see public/ferns/fern_fronds.json
                      // May be an ARRAY parallel to `frondLayers`, one aspect per scan
  frondLayers: null,  // null = previewer layout (`uv`, one bound texture).
                      // An array of texture-array layer indices = batch layout
                      // (`uvProj` + per-vertex `texLayer`), fronds assigned
                      // round-robin so one fern wears several scans. See
                      // FERN_LAYERS/FERN_ASPECTS in src/props/fern-bank.js
}

// Colour is deliberately NOT here. This module generates geometry; how a fern
// is tinted or brightened is a property of the material it ends up in, and the
// scan is dark enough (mean RGB 28,41,4 over its own coverage) that the
// adjustment is a real one to make -- see the brightness control in gen-fern.html.

// The golden angle gives the most even radial spread for any frond count
// without the regular spokes that an even division produces at low counts.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

// Build one frond as a bent ribbon and append it to the running arrays.
//
// The centreline is integrated rather than solved: walk along the frond in
// `segments` steps, turning the direction a little further over at each step.
// It costs nothing and it is far easier to reason about than fitting a spline,
// because every parameter is a physical quantity (launch angle, total bend).
function addFrond(out, p) {
  const { positions, normals, uvs, layers, indices } = out
  const base = positions.length / 3

  const cosY = Math.cos(p.yaw)
  const sinY = Math.sin(p.yaw)

  // Frame: `outward` is the frond's radial heading, `side` is across the blade.
  const outward = new THREE.Vector3(cosY, 0, sinY)
  const side = new THREE.Vector3(-sinY, 0, cosY)
  const up = new THREE.Vector3(0, 1, 0)

  const pos = new THREE.Vector3(p.baseX, p.baseY, p.baseZ)
  const tangent = new THREE.Vector3()
  const bladeSide = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const tmp = new THREE.Vector3()

  const ds = 1 / p.segments

  for (let k = 0; k <= p.segments; k++) {
    const s = k * ds

    // Elevation angle at this point: starts at `pitch`, bends over by `arch`.
    const ang = p.pitch - p.arch * Math.pow(s, p.curve)
    // Lateral drift, so the frond is not confined to one vertical plane.
    const drift = p.sway * s * s

    tangent.copy(outward).multiplyScalar(Math.cos(ang))
    tangent.addScaledVector(up, Math.sin(ang))
    tangent.addScaledVector(side, drift)
    tangent.normalize()

    // Blade cross-direction, rolled about the tangent so the frond twists.
    const roll = p.roll * s
    bladeSide.copy(side).applyAxisAngle(tangent, roll).normalize()

    // bladeSide x tangent, in THAT order. The quads below wind (-W, +W,
    // next+W), whose facing normal is bladeSide x tangent; the reverse product
    // points the shading normal out of the back face instead. Double-sided
    // rendering flips the normal for back faces, so getting this backwards does
    // not read as a missing side -- it reads as a frond lit from underneath and
    // solid black from above, which is exactly how the bug was found.
    normal.crossVectors(bladeSide, tangent).normalize()

    const halfW = (p.width * (1 - p.taper * s)) / 2

    for (let e = 0; e < 2; e++) {
      const sign = e === 0 ? -1 : 1
      tmp.copy(pos).addScaledVector(bladeSide, sign * halfW)
      positions.push(tmp.x, tmp.y, tmp.z)
      normals.push(normal.x, normal.y, normal.z)
      // v = 0 at the base: the cutout stores each frond with its stipe at the
      // TOP of the image (extract-frond.mjs never rotates a component, and
      // fern_frond_0.png's first ~16 rows are the bare 2-3 px stalk), and the
      // frond is sampled from a DataArrayTexture, whose flipY three sets to
      // false -- so image row 0 lands at v = 0, not v = 1.
      //
      // Getting this backwards does not look like a texture bug. The card is
      // symmetric enough that the fern still reads as a fern; what it reads as
      // is a fern whose stems all sprout in mid-air at the frond TIPS and whose
      // feathered ends meet at the crown, which is how it was found.
      uvs.push(e, s)
      // Constant across the frond, but it has to be per-vertex: that is what
      // lets ONE geometry in ONE batch wear several textures (textures.js).
      if (layers) layers.push(p.texLayer)
    }

    if (k < p.segments) {
      const a = base + k * 2
      indices.push(a, a + 1, a + 3, a, a + 3, a + 2)
    }

    // Step the centreline forward along the tangent we just computed.
    pos.addScaledVector(tangent, p.length * ds)
  }
}

export function buildFern(options = {}) {
  const p = { ...FERN_DEFAULTS, ...options }
  const rand = mulberry32(p.seed)

  // `frondLayers` decides the attribute layout, because the two are the same
  // decision. Omit it and you get { position, normal, uv }: one texture bound
  // as material.map, which now only the node probes ask for (see ATTRIBUTES
  // above). Pass it and you get { position, normal, uvProj, texLayer }: the shared
  // batch's layout, where `uv` is deliberately NOT the name (three's map path
  // assumes sampler2D and would fight us) and every geometry in the batch must
  // agree on the attribute set or BatchedMesh refuses it.
  //
  // Fronds are assigned round-robin, so a single fern wears all three scans at
  // once. That is per-VERTEX variety costing nothing: no extra geometry, no
  // extra draw call, and the 16-variant bank reads as far more than 16 plants.
  const frondLayers = p.frondLayers ?? null
  const out = {
    positions: [],
    normals: [],
    uvs: [],
    layers: frondLayers ? [] : null,
    indices: [],
  }

  const count = Math.max(1, Math.round(p.fronds))
  const croziers = Math.round(count * Math.min(1, Math.max(0, p.crozier)))

  for (let i = 0; i < count; i++) {
    // Even radial spread plus jitter. `i / count` also drives the inner/outer
    // distinction: fronds are emitted outermost-first.
    const f = count === 1 ? 0 : i / (count - 1)
    const yaw = i * GOLDEN_ANGLE + (rand() - 0.5) * GOLDEN_ANGLE * p.yawJitter * 2

    const isCrozier = i >= count - croziers

    const lengthJitter = 1 + (rand() - 0.5) * 2 * p.lengthVar
    let length = p.length * lengthJitter
    let pitch = p.pitch * (1 - p.pitchFalloff * (1 - f))
    let arch = p.arch * (0.85 + rand() * 0.3)

    // Which scan this frond wears, and therefore how wide its card has to be.
    // The three cuts are 0.343, 0.379 and 0.491 wide for their height, a 43%
    // spread -- share one aspect across them and a third of every fern is a
    // squashed texture. `frondAspect` accepts an array parallel to
    // `frondLayers` for exactly this.
    const slot = frondLayers ? i % frondLayers.length : 0
    const texLayer = frondLayers ? frondLayers[slot] : 0
    const aspect = Array.isArray(p.frondAspect) ? p.frondAspect[slot] : p.frondAspect
    let width = length * aspect * p.widthScale

    if (isCrozier) {
      // A fiddlehead is the same card, short and curled most of the way round.
      length *= 0.42
      width *= 0.62
      pitch = p.pitch * 1.15
      arch = Math.PI * 1.7
    }

    addFrond(out, {
      yaw,
      baseX: Math.cos(yaw) * p.crownRadius,
      baseY: p.crownRise * rand(),
      baseZ: Math.sin(yaw) * p.crownRadius,
      segments: Math.max(1, Math.round(p.segments)),
      pitch,
      arch,
      curve: Math.max(0.2, p.curve),
      length,
      width,
      taper: p.taper,
      sway: p.sway * (rand() - 0.5) * 2,
      roll: p.roll * (rand() - 0.5) * 2,
      texLayer,
    })
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3))
  if (out.layers) {
    geo.setAttribute('uvProj', new THREE.Float32BufferAttribute(out.uvs, 2))
    geo.setAttribute('texLayer', new THREE.Float32BufferAttribute(out.layers, 1))
  } else {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(out.uvs, 2))
  }
  geo.setIndex(out.indices)

  // Rescale to the requested height. Everything above works in relative units
  // because `length` interacts with `arch` -- a frond that bends further over
  // is shorter in Y for the same arc length -- so the only honest way to hit a
  // metre target is to build it and then measure it. Same reasoning as the
  // 1.7013 correction in buildBoulder.
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  const rawHeight = bb.max.y - bb.min.y
  if (rawHeight > 1e-6) {
    const k = p.height / rawHeight
    geo.scale(k, k, k)
  }
  // Sit the fern on y = 0 rather than wherever the crown happened to land.
  geo.computeBoundingBox()
  geo.translate(0, -geo.boundingBox.min.y, 0)

  geo.computeBoundingSphere()

  geo.userData.fern = {
    triangles: out.indices.length / 3,
    vertices: out.positions.length / 3,
    fronds: count,
    croziers,
  }
  return geo
}

// Byte cost of the generated buffers -- the runtime half of a fern's budget,
// against which the only stored cost is the frond PNG plus this source file.
export function geometryBytes(geo) {
  let total = 0
  for (const name of Object.keys(geo.attributes)) {
    total += geo.attributes[name].array.byteLength
  }
  if (geo.index) total += geo.index.array.byteLength
  return total
}
