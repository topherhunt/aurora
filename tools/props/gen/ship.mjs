// ---------------------------------------------------------------------------
// Ships picked prop meshes into public/gen-props/, the only bridge between the
// gitignored prop workspace and the world.
//
//   node tools/props/gen/ship.mjs [id ...]
//
// Every prop with a picked mesh (or just the ids named) ships as
// public/gen-props/<id>.glb plus <id>-lod<k>.glb for each decimated tier of the
// pick's ladder, all packed the way tools/creatures/ship.mjs packs a critter:
// only the bufferViews the accessors read, one material pointing at
// <id>.webp -- the pick's colour map boxed to the roster's `texPx` -- as an
// external EXT_texture_webp image, so the world never decodes Tripo's 2048 JPEG
// or the ladder's embedded PNGs. A roster entry flagged `delight` ships its map
// with Tripo's baked top-down light taken out first (delight.mjs). An entry's
// `cut` pieces are dropped from the mesh and its `glass` pieces have their red
// texels painted dark glass (pieces.mjs). NOT public/props/: `npm run props` wipes that
// tree before the Blender build writes it.
//
// TWO THINGS DIFFER FROM A CRITTER. The mesh node ships under the IDENTITY, not
// Tripo's node yaw: a prop's yaw is the scatter's roll, and in its own frame a
// Tripo mesh is axis-aligned (a log along X, a stump up Y), which is what the
// world measures its length and radius off (src/v2/render/gen-props.js). And no
// index is written -- each scatter names its files and carries its own metre
// band; the roster's `sizeM` only frames the bench.
//
// Re-run after picking a new mesh or saving a ladder in gen-prop.html, and
// commit what it writes. A prop without a pick is skipped and named.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { shipTexPx } from './prop-roster.mjs'
import { listAll, readMeta, readState, workDir } from './workspace.mjs'
import { packTexture, readGlbChunks, tripoColourJpeg, viewOf } from '../../tripo-pack.mjs'
import { delightJpeg } from './delight.mjs'
import { cutPieces, paintGlass } from './pieces.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const OUT = path.join(ROOT, 'public/gen-props')

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The one mesh node of a GLB, which must spell its transform as a matrix (or nothing): what Tripo and three's exporter both write. */
function meshNode(id, json) {
  const nodes = json.nodes.filter((n) => n.mesh !== undefined)
  if (nodes.length !== 1) throw new Error(`${id}: ${nodes.length} mesh nodes, expected one`)
  const node = nodes[0]
  if (node.rotation || node.translation || node.scale) throw new Error(`${id}: the mesh node spells its transform as TRS, which this shipper does not carry`)
  return node
}

/** The pick's GLB, then each decimated tier of its ladder, packed onto one WebP. */
function ship(id) {
  const meta = readMeta(id)
  const state = readState(id)
  const { pickedMesh } = state
  if (path.extname(pickedMesh) !== '.glb') throw new Error(`${id}: picked mesh ${pickedMesh} is not a glb -- the world loads glb only`)
  const src = path.join(workDir(id), 'meshes', pickedMesh)
  const entry = (state.meshes ?? []).find((m) => m.file === pickedMesh)
  if (!entry) throw new Error(`${id}: picked mesh ${pickedMesh} is not in state.json`)
  const lods = (entry.lods ?? []).filter((l) => l.kind === 'decimated')
  // A decimated tier's pieces are not the pick's, so its points would name other parts or none.
  if (meta.cut && lods.length) throw new Error(`${id}: a roster \`cut\` and a ladder together, which this shipper does not carry`)
  let glb = readGlbChunks(src)
  const notes = []
  if (meta.cut) {
    glb = cutPieces(src, glb.json, glb.bin, meta.cut)
    notes.push(`${glb.cut} tris cut`)
  }
  const texture = `${id}.webp`
  const texPx = shipTexPx(meta)
  const jpeg = tripoColourJpeg(src, glb.json, glb.bin, 0)
  // The roster's `delight` flag: the map flattened against the mesh's own
  // facing first, for a pick Tripo painted in its own top-down light.
  let image = meta.delight ? delightJpeg(src, jpeg).png : jpeg
  if (meta.delight) notes.push('delighted')
  if (meta.glass) {
    const glass = paintGlass(src, image, glb.json, glb.bin, meta.glass)
    image = glass.png
    notes.push(`${glass.painted} texels glassed`)
  }
  packTexture(image, path.join(OUT, texture), texPx)
  meshNode(id, glb.json)
  pack(id, src, glb, `${id}.glb`, texture, [`texture ${texPx}px ${(fs.statSync(path.join(OUT, texture)).size / 1024).toFixed(0)} KB`, ...notes].join(', '))
  for (const lod of lods) {
    const tier = path.join(workDir(id), 'meshes', `${pickedMesh.replace(/\.glb$/, '')}-lod${lod.level}.glb`)
    pack(id, tier, readGlbChunks(tier), `${id}-lod${lod.level}.glb`, texture, `${lod.tris} tris`)
  }
  return lods.length
}

/** One GLB (`src`'s chunks, `{ json, bin }`) with only the bufferViews its accessors read, its images replaced by `texture` as an external EXT_texture_webp image, its mesh node under the identity. */
function pack(id, src, { json, bin }, outName, texture, note) {
  if (json.extensionsRequired?.length) throw new Error(`${id}: ${src} requires ${json.extensionsRequired.join(', ')}, which this shipper does not carry`)
  if (json.materials.length !== 1 || json.meshes.length !== 1) throw new Error(`${id}: ${json.materials.length} materials and ${json.meshes.length} meshes in ${src}, expected one of each`)
  const node = meshNode(id, json)
  const views = [], parts = [], index = new Map()
  let off = 0
  for (const acc of json.accessors) {
    if (acc.bufferView === undefined || acc.sparse) throw new Error(`${id}: a sparse accessor, which this shipper does not carry`)
    if (index.has(acc.bufferView)) continue
    const bytes = viewOf(json, bin, acc.bufferView)
    index.set(acc.bufferView, views.length)
    views.push({ ...json.bufferViews[acc.bufferView], byteOffset: off, byteLength: bytes.length })
    const pad = (4 - (bytes.length % 4)) % 4
    parts.push(bytes, Buffer.alloc(pad))
    off += bytes.length + pad
  }
  const { name, doubleSided } = json.materials[0]
  const packed = {
    ...json,
    nodes: json.nodes.map((n) => n === node ? { ...n, matrix: IDENTITY } : n),
    extensionsUsed: ['EXT_texture_webp'],
    extensionsRequired: ['EXT_texture_webp'],
    accessors: json.accessors.map((a) => ({ ...a, bufferView: index.get(a.bufferView) })),
    bufferViews: views,
    buffers: [{ byteLength: off }],
    images: [{ uri: texture, mimeType: 'image/webp' }],
    textures: [{ extensions: { EXT_texture_webp: { source: 0 } } }],
    materials: [{ name, doubleSided, pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } }],
  }
  delete packed.samplers
  // glTF pads the JSON chunk with spaces and the BIN chunk with zeros, each to four bytes.
  let jsonBuf = Buffer.from(JSON.stringify(packed), 'utf8')
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)])
  const binBuf = Buffer.concat(parts)
  const header = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + jsonBuf.length + binBuf.length, 8)
  jsonHead.writeUInt32LE(jsonBuf.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4)
  binHead.writeUInt32LE(binBuf.length, 0); binHead.writeUInt32LE(0x004e4942, 4)
  const out = path.join(OUT, outName)
  fs.writeFileSync(out, Buffer.concat([header, jsonHead, jsonBuf, binHead, binBuf]))
  console.log(`ship ${outName}: ${path.basename(src)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${note})`)
}

fs.mkdirSync(OUT, { recursive: true })
const asked = process.argv.slice(2)
const ids = asked.length ? asked : listAll().map((p) => p.id)
let shipped = 0
for (const id of ids) {
  if (!readState(id).pickedMesh) {
    if (asked.length) throw new Error(`${id}: no picked mesh -- pick one in gen-prop.html first`)
    console.log(`skip ${id}: no picked mesh`)
    continue
  }
  const lods = ship(id)
  if (lods === 0) console.log(`  ${id} ships with no ladder -- cut one in gen-prop.html for the world's LOD tiers`)
  shipped++
}
if (!shipped) throw new Error('nothing to ship -- no prop has a picked mesh')
