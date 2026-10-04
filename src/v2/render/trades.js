// The towns' works and shop signs (DESIGN.md §32 Trades), laid out by layers/towns.js and layers/trades.js: the smithy, the farms' fields and sheds, the woodpiles, and the emblem boards over the shops' doors. Prop arrays in the town's frame, merged into the town's mesh as one more part.
import THREE from '../../three-instance.js'
import { LAYER } from '../../textures.js'
import { addGeometry, propArrays } from './signposts.js'
import { TRADES, smithyLayout, fenceRuns } from '../layers/trades.js'

const WHITE = [1, 1, 1]
const DARK = [0.06, 0.05, 0.05]
const SOOT = [0.28, 0.27, 0.27]
const EMBER = [2.6, 0.9, 0.2]
const IRONISH = [0.22, 0.22, 0.24]
const BURLAP = [0.72, 0.6, 0.42]
const LEAF = [0.3, 0.7, 0.22]
const CARROT = [1.5, 0.55, 0.12]
const EMBLEM = { anvil: [[0.2, 0.2, 0.22]], flask: [[0.45, 1.2, 0.55], [0.9, 0.85, 0.75]], tankard: [[0.75, 0.55, 0.32], [1.2, 1.2, 1.15]] }

// Shared unit primitives, scaled per use.
const UNIT = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 10),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6),
  cone: new THREE.ConeGeometry(0.5, 1, 4),
  ball: new THREE.SphereGeometry(0.5, 8, 6),
  // Half a cylinder along z, the round side up: a forge's arch.
  arch: new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2),
  // A cylinder lying along z: a log.
  log: new THREE.CylinderGeometry(0.5, 0.5, 1, 6).rotateX(Math.PI / 2),
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _s = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)

// A piece in frame `f` (a Matrix4): unit geometry `g` at local (x, y, z) scaled (sx, sy, sz), turned `ry` about y.
function put(out, f, g, x, y, z, sx, sy, sz, layer, tint, ry = 0) {
  _m.compose(_v.set(x, y, z), _q.setFromAxisAngle(_up, ry), _s.set(sx, sy, sz)).premultiply(f)
  addGeometry(out, g, _m, layer, tint)
}

// A w x h beam from point a to point b (Vector3s in frame f), its width level: a box, or `g` (unit, along z).
function beam(out, f, a, b, w, h, layer, tint, g = UNIT.box) {
  const d = new THREE.Vector3().subVectors(b, a)
  const len = d.length()
  const yaw = Math.atan2(d.x, d.z)
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  _m.makeRotationY(yaw).multiply(new THREE.Matrix4().makeRotationX(-pitch)).scale(_s.set(w, h, len))
  _m.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2).premultiply(f)
  addGeometry(out, g, _m, layer, tint)
}

const frameOf = (town, x, y, z, yaw) => new THREE.Matrix4().makeRotationY(yaw).setPosition(x - town.x, y, z - town.z)

// The open-sided smithy: stone floor, beamed posts, a tiled gable along x, the arched forge at the back with its chimney, the anvils on stumps and the quench tub.
function smithy(out, town, w, detail) {
  const S = TRADES.smithy
  const L = smithyLayout(w.anvils)
  const f = frameOf(town, w.x, w.y, w.z, w.yaw)
  const top = S.post
  const ridge = top + S.rise
  put(out, f, UNIT.box, 0, (w.plinth + 0.12) / 2, 0, S.w, 0.12 - w.plinth, S.d, LAYER.STONE, WHITE)
  for (const [x, z] of L.posts) put(out, f, UNIT.box, x, (top - 0.3) / 2, z, 0.26, top - 0.3, 0.26, LAYER.TIMBER_BEAM, WHITE)
  const V = (x, y, z) => new THREE.Vector3(x, y, z)
  const ex = S.w / 2 - 0.15
  const ez = S.d / 2 - 0.15
  for (const z of [ez, -ez]) beam(out, f, V(-ex - 0.2, top - 0.15, z), V(ex + 0.2, top - 0.15, z), 0.3, 0.3, LAYER.TIMBER_BEAM, WHITE)
  for (const x of [-ex, -1.75, 1.75, ex]) beam(out, f, V(x, top - 0.12, -ez), V(x, top - 0.12, ez), 0.26, 0.26, LAYER.TIMBER_BEAM, WHITE)
  // King posts up from the end ties to the ridge beam.
  for (const x of [-ex, ex]) put(out, f, UNIT.box, x, (top + ridge - 0.28) / 2, 0, 0.2, ridge - 0.28 - top, 0.2, LAYER.TIMBER_BEAM, WHITE)
  beam(out, f, V(-ex - 0.3, ridge - 0.16, 0), V(ex + 0.3, ridge - 0.16, 0), 0.24, 0.24, LAYER.TIMBER_BEAM, WHITE)
  // Two tiled slopes, eave to ridge, with plank sarking under.
  const half = S.d / 2 + S.over
  const slope = Math.hypot(half, S.rise * (half / (S.d / 2)))
  const pitch = Math.atan2(S.rise, S.d / 2)
  for (const side of [1, -1]) {
    const m = new THREE.Matrix4().makeTranslation(0, ridge - (Math.sin(pitch) * slope) / 2, (side * Math.cos(pitch) * slope) / 2)
    m.multiply(new THREE.Matrix4().makeRotationX(side * pitch)).premultiply(f)
    put(out, m, UNIT.box, 0, 0.07, 0, S.w + 2 * S.over, 0.1, slope, LAYER.ROOF_TILE, WHITE)
    put(out, m, UNIT.box, 0, -0.01, 0, S.w + 2 * S.over - 0.05, 0.06, slope - 0.05, LAYER.TIMBER_PLANK, WHITE)
  }
  // The forge: a stone hearth under an arched stone hood, the hood's mouth black inside with the embers on the lip before it, and the chimney rising from its back through the roof.
  const F = L.forge
  put(out, f, UNIT.box, F.x, F.h / 2, F.z, F.w, F.h, F.d, LAYER.STONE, WHITE)
  const mz = F.z + F.d / 2
  put(out, f, UNIT.arch, F.x, F.h, mz - 0.1 - 0.45, 1.4, 1.5, 0.9, LAYER.STONE, WHITE)
  put(out, f, UNIT.arch, F.x, F.h + 0.005, mz - 0.08 - 0.45, 0.9, 1.0, 0.9, LAYER.PLASTER, DARK)
  put(out, f, UNIT.box, F.x, F.h + 0.015, mz - 0.04, 0.8, 0.03, 0.12, LAYER.PLASTER, EMBER)
  put(out, f, UNIT.box, F.x, (F.h + ridge + 0.9) / 2, F.z - 0.25, 0.8, ridge + 0.9 - F.h, 0.7, LAYER.STONE, WHITE)
  put(out, f, UNIT.box, F.x, ridge + 0.95, F.z - 0.25, 0.95, 0.12, 0.85, LAYER.STONE, SOOT)
  for (const a of L.anvils) {
    put(out, f, UNIT.cyl6, a.x, 0.22, a.z, 0.5, 0.45, 0.5, LAYER.TIMBER_BEAM, WHITE)
    put(out, f, UNIT.box, a.x, 0.5, a.z, 0.62, 0.12, 0.24, LAYER.STONE, IRONISH)
    put(out, f, UNIT.box, a.x, 0.6, a.z, 0.48, 0.08, 0.28, LAYER.STONE, IRONISH)
    put(out, f, UNIT.cone, a.x + 0.36, 0.6, a.z, 0.12, 0.26, 0.12, LAYER.STONE, IRONISH, 0)
    if (detail === 2) put(out, f, UNIT.box, a.x - 0.2, 0.66, a.z + 0.1, 0.25, 0.04, 0.05, LAYER.TIMBER_BEAM, WHITE)
  }
  const T = L.tub
  put(out, f, UNIT.cyl, T.x, 0.28, T.z, T.r * 2, 0.56, T.r * 2, LAYER.TIMBER_PLANK, WHITE)
  put(out, f, UNIT.cyl, T.x, 0.565, T.z, T.r * 1.8, 0.01, T.r * 1.8, LAYER.PLASTER, [0.08, 0.12, 0.14])
  // The sign: a post at the front corner, its board hanging toward the clearing.
  const px = -S.w / 2 - 0.5
  const pz = S.d / 2 + 0.2
  put(out, f, UNIT.box, px, 1.4, pz, 0.14, 2.8, 0.14, LAYER.TIMBER_BEAM, WHITE)
  sign(out, new THREE.Matrix4().makeTranslation(px, 2.55, pz + 0.07).premultiply(f), w.sign, detail)
}

// An emblem board in frame m: the arm runs out along +z from the origin and the board hangs under it in the yz plane, its emblem on both faces.
function sign(out, m, emblem, detail) {
  put(out, m, UNIT.box, 0, 0, 0.42, 0.05, 0.05, 0.84, LAYER.STONE, IRONISH)
  for (const z of [0.18, 0.72]) put(out, m, UNIT.box, 0, -0.08, z, 0.02, 0.14, 0.02, LAYER.STONE, IRONISH)
  put(out, m, UNIT.box, 0, -0.42, 0.45, 0.06, 0.52, 0.66, LAYER.TIMBER_PLANK, WHITE)
  const [a, b] = EMBLEM[emblem]
  for (const sx of [1, -1]) {
    const x = sx * 0.04
    const t = 0.03
    if (emblem === 'anvil') {
      put(out, m, UNIT.box, x, -0.36, 0.47, t, 0.08, 0.36, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.36, 0.25, t, 0.05, 0.12, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.45, 0.48, t, 0.1, 0.12, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.53, 0.48, t, 0.06, 0.26, LAYER.PLASTER, a)
    } else if (emblem === 'flask') {
      put(out, m, UNIT.ball, x, -0.5, 0.45, t, 0.26, 0.26, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.3, 0.45, t, 0.16, 0.08, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.21, 0.45, t * 1.2, 0.05, 0.07, LAYER.TIMBER_BEAM, WHITE)
      if (detail === 2) put(out, m, UNIT.box, x * 1.15, -0.53, 0.45, t, 0.08, 0.2, LAYER.PLASTER, b)
    } else {
      put(out, m, UNIT.box, x, -0.45, 0.42, t, 0.26, 0.2, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.3, 0.42, t * 1.2, 0.06, 0.22, LAYER.PLASTER, b)
      put(out, m, UNIT.box, x, -0.45, 0.57, t, 0.16, 0.04, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.39, 0.54, t, 0.04, 0.08, LAYER.PLASTER, a)
      put(out, m, UNIT.box, x, -0.51, 0.54, t, 0.04, 0.08, LAYER.PLASTER, a)
    }
  }
}

// A fenced field of carrots: posts and two rails following the ground, a dirt mound down each row, and the carrots on it (their orange shoulders only up close).
function field(out, town, w, ground, detail) {
  const F = TRADES.field
  const c = Math.cos(w.yaw)
  const s = Math.sin(w.yaw)
  const at = (lx, lz, dy = 0) => {
    const x = w.x + lx * c + lz * s
    const z = w.z - lx * s + lz * c
    return new THREE.Vector3(x - town.x, ground(x, z) + dy, z - town.z)
  }
  const id = new THREE.Matrix4()
  for (const run of fenceRuns(w.outline, w.gate)) {
    run.forEach(([lx, lz], i) => {
      const p = at(lx, lz)
      put(out, id, UNIT.cyl6, p.x, p.y + 0.5, p.z, 0.13, 1.2, 0.13, LAYER.BARK, WHITE)
      if (i === 0) return
      const [qx, qz] = run[i - 1]
      for (const y of F.rails) beam(out, id, at(qx, qz, y), at(lx, lz, y), 0.05, 0.09, LAYER.TIMBER_PLANK, WHITE)
    })
  }
  const step = detail === 2 ? F.step : F.step * 2
  for (const r of w.rows) {
    const n = Math.max(1, Math.ceil(r.x1 - r.x0))
    for (let k = 0; k < n; k++) beam(out, id, at(r.x0 + ((r.x1 - r.x0) * k) / n - 0.05, r.z), at(r.x0 + ((r.x1 - r.x0) * (k + 1)) / n + 0.05, r.z), 0.6, 0.2, LAYER.DIRT, WHITE, UNIT.log)
    for (let x = r.x0 + step / 2; x < r.x1; x += step) {
      const p = at(x, r.z, 0.09)
      put(out, id, UNIT.cone, p.x, p.y + 0.12, p.z, 0.2, 0.26, 0.2, LAYER.PLASTER, LEAF, x * 7.3)
      if (detail === 2) put(out, id, UNIT.cyl6, p.x, p.y, p.z, 0.07, 0.05, 0.07, LAYER.PLASTER, CARROT)
    }
  }
}

// The farm's shed: four posts, plank back and sides, a thatched gable, and barrels and grain sacks under it.
function shed(out, town, w, detail) {
  const S = TRADES.shed
  const f = frameOf(town, w.x, w.y, w.z, w.yaw)
  const h = 2.1
  const hx = S.w / 2 - 0.1
  const hz = S.d / 2 - 0.1
  put(out, f, UNIT.box, 0, (w.plinth + 0.1) / 2, 0, S.w, 0.1 - w.plinth, S.d, LAYER.TIMBER_HEWN, WHITE)
  for (const x of [hx, -hx]) for (const z of [hz, -hz]) put(out, f, UNIT.box, x, h / 2, z, 0.18, h, 0.18, LAYER.TIMBER_BEAM, WHITE)
  put(out, f, UNIT.box, 0, h / 2, -hz, S.w - 0.2, h, 0.06, LAYER.TIMBER_PLANK, WHITE)
  for (const x of [hx, -hx]) put(out, f, UNIT.box, x, h / 2, 0, 0.06, h, S.d - 0.2, LAYER.TIMBER_PLANK, WHITE)
  const rise = 1.1
  const half = S.d / 2 + 0.35
  const pitch = Math.atan2(rise, S.d / 2)
  const slope = half / Math.cos(pitch)
  for (const side of [1, -1]) {
    const m = new THREE.Matrix4().makeTranslation(0, h + rise - (Math.sin(pitch) * slope) / 2, (side * Math.cos(pitch) * slope) / 2)
    m.multiply(new THREE.Matrix4().makeRotationX(side * pitch)).premultiply(f)
    put(out, m, UNIT.box, 0, 0.08, 0, S.w + 0.6, 0.16, slope, LAYER.THATCH, [1.06, 0.98, 0.78])
  }
  for (const x of [hx, -hx]) {
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([x, h, hz, x, h, -hz, x, h + rise, 0, x, h, -hz, x, h, hz, x, h + rise, 0], 3))
    g.computeVertexNormals()
    addGeometry(out, g, f, LAYER.TIMBER_PLANK, WHITE)
  }
  for (const [x, z] of [[-0.9, -0.5], [-0.25, -0.6], [-0.6, 0.15]]) {
    put(out, f, UNIT.cyl, x, 0.45, z, 0.6, 0.85, 0.6, LAYER.TIMBER_PLANK, WHITE)
    if (detail === 2) for (const y of [0.2, 0.7]) put(out, f, UNIT.cyl, x, y, z, 0.63, 0.05, 0.63, LAYER.STONE, IRONISH)
  }
  for (const [x, y, z, r] of [[0.7, 0.22, -0.5, 0.3], [1.1, 0.22, -0.4, 0.5], [0.85, 0.5, -0.45, -0.2], [0.9, 0.22, 0.2, 1.2]]) put(out, f, UNIT.ball, x, y, z, 0.55, 0.45, 0.42, LAYER.PLASTER, BURLAP, r)
}

// Split logs stacked along the pile, and a chopping stump in front of it.
function woodpile(out, town, w) {
  const W = TRADES.woodpile
  const f = frameOf(town, w.x, w.y, w.z, w.yaw)
  const n0 = Math.floor((W.w - 0.3) / 0.25)
  for (let row = 0; row < 4; row++) {
    const n = n0 - row
    for (let k = 0; k < n; k++) {
      const x = -W.w / 2 + 0.15 + row * 0.125 + 0.125 + k * 0.25
      put(out, f, UNIT.log, x, 0.13 + row * 0.22, 0, 0.26, 0.26, W.d - 0.1, LAYER.BARK, WHITE)
    }
  }
  put(out, f, UNIT.cyl, 0, 0.22, W.stump, 0.55, 0.45, 0.55, LAYER.BARK, WHITE)
}

/** Prop arrays for a town's works and shop signs at `detail`, in the town's frame (placedArrays' shape). `ground(x, z)` is the live ground the fields follow. */
export function tradeArrays(town, detail, ground) {
  const out = propArrays()
  for (const w of town.works) {
    if (w.kind === 'smithy') smithy(out, town, w, detail)
    else if (w.kind === 'field') field(out, town, w, ground, detail)
    else if (w.kind === 'shed') shed(out, town, w, detail)
    else if (w.kind === 'woodpile') woodpile(out, town, w)
    else throw new Error(`unknown work ${w.kind}`)
  }
  // A shop's board hangs off its front wall beside the door, above head height.
  for (const b of town.buildings) {
    if (b.sign === undefined) continue
    const d = b.plan.door
    const front = b.plan.masses.reduce((z, m) => Math.max(z, m.cz + m.d / 2), -Infinity)
    const side = d.x > 0 ? -1 : 1
    const m = frameOf(town, b.x, b.y, b.z, b.yaw).multiply(new THREE.Matrix4().makeTranslation(d.x + side * (d.width / 2 + 0.7), d.y0 + d.height + 0.6, front))
    sign(out, m, b.sign, detail)
  }
  const n = out.position.length / 3
  return { position: Float32Array.from(out.position), normal: Float32Array.from(out.normal), uvProj: Float32Array.from(out.uvProj), texLayer: Float32Array.from(out.texLayer), color: Float32Array.from(out.color), index: Uint32Array.from(out.index), tris: out.index.length / 3, verts: n }
}

/** The works' solids for the walker, oriented boxes with a floor and top: smithy floor, forge, anvils and tub; shed floor and contents; woodpile. Fields are open ground. */
export function tradeSolids(town) {
  const out = []
  const add = (w, lx, lz, hx, hz, y0, y1) => {
    const c = Math.cos(w.yaw)
    const s = Math.sin(w.yaw)
    out.push({ x: w.x + lx * c + lz * s, z: w.z - lx * s + lz * c, c, s, hx, hz, y0: w.y + y0, y1: w.y + y1 })
  }
  for (const w of town.works) {
    if (w.kind === 'smithy') {
      const L = smithyLayout(w.anvils)
      add(w, 0, 0, TRADES.smithy.w / 2, TRADES.smithy.d / 2, w.plinth, 0.12)
      add(w, L.forge.x, L.forge.z, L.forge.w / 2, L.forge.d / 2, 0, L.forge.h + 0.6)
      for (const a of L.anvils) add(w, a.x, a.z, 0.3, 0.15, 0, 0.64)
      add(w, L.tub.x, L.tub.z, L.tub.r, L.tub.r, 0, 0.57)
    } else if (w.kind === 'shed') {
      add(w, 0, 0, TRADES.shed.w / 2, TRADES.shed.d / 2, w.plinth, 0.1)
    } else if (w.kind === 'woodpile') {
      add(w, 0, 0, TRADES.woodpile.w / 2, TRADES.woodpile.d / 2, -0.3, 0.7)
    }
  }
  return out
}
