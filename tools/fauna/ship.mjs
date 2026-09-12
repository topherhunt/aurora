// ---------------------------------------------------------------------------
// Ships every roster fish into public/fauna/, the world's only view of the
// picked Tripo meshes:
//
//   node tools/fauna/ship.mjs
//
// Reads tools/creatures/work/<creature>/mesh.glb (the pick made in
// gen-creature.html) for each species in TRIPO and writes public/fauna/fish.json
// -- the mesh as plain arrays, turned nose to -Z, scaled to the roster length,
// centred, with the per-vertex swim-bend weight fish.js's vertex stage reads --
// and public/fauna/<id>.jpg, the base colour map lifted out of the glb as is.
// Re-run after picking a new mesh, and commit what it writes.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SPECIES } from './fish-roster.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(ROOT, 'tools/creatures/work')
const OUT = path.join(ROOT, 'public/fauna')

// Which creature-bench pick each species wears, and which way Tripo happened
// to point its nose: Tripo orients the model to face the camera of its own
// preview, which lands a fish on either end of Z. The shipper checks the
// declared end against the mesh (the tail fin is the thin end) and throws on a
// repick that comes in the other way round, rather than shipping a fish that
// swims backwards.
const TRIPO = {
  'ironscale-bass': { creature: 'ironscale-bass', nose: -1 },
  'rime-fangpike': { creature: 'reed-pike', nose: +1 },
  glimmerfin: { creature: 'glimmerfin', nose: +1 },
}

const COMPONENT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

/** The one mesh in a Tripo glb: its node transform, attributes, indices and the base colour image's bytes. */
function readGlb(file) {
  const buf = fs.readFileSync(file)
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB (bad magic)`)
  let off = 12, json = null, bin = null
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'))
    else if (type === 0x004e4942) bin = data
    off += 8 + len + ((4 - (len % 4)) % 4)
  }
  if (!json || !bin) throw new Error(`${file}: missing JSON or BIN chunk`)
  const view = (i) => {
    const v = json.bufferViews[i]
    return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
  }
  const accessor = (i) => {
    const acc = json.accessors[i]
    const per = COUNTS[acc.type], Ctor = COMPONENT[acc.componentType]
    if (!per || !Ctor) throw new Error(`${file}: accessor ${i} is ${acc.type}/${acc.componentType}, which this reader does not take`)
    const v = json.bufferViews[acc.bufferView]
    if (v.byteStride && v.byteStride !== per * Ctor.BYTES_PER_ELEMENT) throw new Error(`${file}: accessor ${i} is interleaved`)
    const bytes = view(acc.bufferView).subarray(acc.byteOffset ?? 0)
    return new Ctor(bytes.buffer, bytes.byteOffset, acc.count * per)
  }
  const nodes = json.scenes[json.scene ?? 0].nodes
  if (nodes.length !== 1 || json.nodes[nodes[0]].children) throw new Error(`${file}: expected one mesh node, the Tripo shape`)
  const node = json.nodes[nodes[0]]
  const prims = json.meshes[node.mesh].primitives
  if (prims.length !== 1) throw new Error(`${file}: ${prims.length} primitives, expected one`)
  const prim = prims[0]
  if (prim.mode !== undefined && prim.mode !== 4) throw new Error(`${file}: primitive is not TRIANGLES`)
  for (const a of ['POSITION', 'NORMAL', 'TEXCOORD_0']) if (prim.attributes[a] === undefined) throw new Error(`${file}: no ${a}`)
  const mat = json.materials[prim.material]
  const image = json.images[json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].source]
  if (image.mimeType !== 'image/jpeg') throw new Error(`${file}: base colour is ${image.mimeType}, expected JPEG`)
  if (node.matrix === undefined || node.translation || node.rotation || node.scale) throw new Error(`${file}: node carries TRS, expected Tripo's matrix`)
  return {
    matrix: node.matrix,
    pos: accessor(prim.attributes.POSITION),
    nrm: accessor(prim.attributes.NORMAL),
    uv: accessor(prim.attributes.TEXCOORD_0),
    idx: accessor(prim.indices),
    jpeg: view(image.bufferView),
  }
}

/** Rotates every triple of `arr` by the upper 3x3 of a column-major 4x4, then by a half turn about Y when `flip`. */
function rotate(arr, m, flip) {
  const out = new Float32Array(arr.length)
  const s = flip ? -1 : 1
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1], z = arr[i + 2]
    out[i] = s * (m[0] * x + m[4] * y + m[8] * z)
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z
    out[i + 2] = s * (m[2] * x + m[6] * y + m[10] * z)
  }
  return out
}

/** The x extent of the vertices in the outer tenth of the body at the `sign` end of Z: a tail fin is a blade, a head is a bulb. */
function endWidth(pos, sign) {
  let zmin = Infinity, zmax = -Infinity
  for (let i = 2; i < pos.length; i += 3) { zmin = Math.min(zmin, pos[i]); zmax = Math.max(zmax, pos[i]) }
  const edge = sign > 0 ? zmax - 0.1 * (zmax - zmin) : zmin + 0.1 * (zmax - zmin)
  let xmin = Infinity, xmax = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    if (sign > 0 ? pos[i + 2] < edge : pos[i + 2] > edge) continue
    xmin = Math.min(xmin, pos[i]); xmax = Math.max(xmax, pos[i])
  }
  return xmax - xmin
}

fs.mkdirSync(OUT, { recursive: true })
const species = []
for (const s of SPECIES) {
  const pick = TRIPO[s.id]
  if (!pick) throw new Error(`${s.id}: no Tripo pick in TRIPO -- add the creature id and which end its nose is on`)
  const file = path.join(WORK, pick.creature, 'mesh.glb')
  if (!fs.existsSync(file)) throw new Error(`${s.id}: no picked mesh at ${path.relative(ROOT, file)} -- pick one in gen-creature.html`)
  const glb = readGlb(file)
  const lengthM = s.lengthCm / 100

  // Tripo's node matrix is a small yaw that squares the model up; a half turn on top puts the nose at -Z, which is where fish.js swims it from.
  const pos = rotate(glb.pos, glb.matrix, pick.nose > 0)
  const nrm = rotate(glb.nrm, glb.matrix, pick.nose > 0)
  if (!(endWidth(pos, +1) < 0.5 * endWidth(pos, -1))) throw new Error(`${s.id}: the mesh's thin end is not at the declared tail -- check TRIPO.nose against ${path.relative(ROOT, file)}`)

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < pos.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[i + c]); hi[c] = Math.max(hi[c], pos[i + c]) }
  const scale = lengthM / (hi[2] - lo[2])
  const bend = new Float32Array(pos.length / 3)
  for (let i = 0; i < pos.length; i += 3) {
    // Nose to tail runs 0..1 along z; the swim weight is its square, so the head barely stirs and the tail carries the wave.
    const t = (pos[i + 2] - lo[2]) / (hi[2] - lo[2])
    bend[i / 3] = t * t
    for (let c = 0; c < 3; c++) pos[i + c] = (pos[i + c] - (lo[c] + hi[c]) / 2) * scale
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1
    nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l
  }
  // glTF's v runs top-down and three's TextureLoader flips rows on upload, so v is mirrored here to land the same texel GLTFLoader would.
  const uv = new Float32Array(glb.uv.length)
  for (let i = 0; i < uv.length; i += 2) { uv[i] = glb.uv[i]; uv[i + 1] = 1 - glb.uv[i + 1] }

  const texture = `${s.id}.jpg`
  fs.writeFileSync(path.join(OUT, texture), glb.jpeg)
  const round = (v) => Math.round(v * 1e4) / 1e4
  species.push({
    id: s.id,
    lengthM,
    texture,
    pos: Array.from(pos, round),
    nrm: Array.from(nrm, round),
    uv: Array.from(uv, round),
    bend: Array.from(bend, round),
    idx: Array.from(glb.idx),
  })
  console.log(`ship ${s.id}: ${pick.creature} pick, ${glb.idx.length / 3} tris, ${lengthM} m, texture ${(glb.jpeg.length / 1024).toFixed(0)} KB`)
}
fs.writeFileSync(path.join(OUT, 'fish.json'), JSON.stringify({ species }) + '\n')
console.log(`wrote public/fauna/fish.json with ${species.length} species`)
