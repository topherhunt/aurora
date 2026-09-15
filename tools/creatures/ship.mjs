// ---------------------------------------------------------------------------
// Ships picked creature meshes into public/creatures/, which is the only bridge
// between the gitignored workspace and the world.
//
//   node tools/creatures/ship.mjs
//
// Writes public/creatures/<id>.glb for every biped with a picked mesh candidate
// and public/creatures/avatars.json listing them with their heights. The world
// (src/v2/render/avatar.js) dresses each netplay peer in one of these, so the
// index is the roster of possible avatars. The critters in CRITTERS ship
// without an index entry -- the world module that scatters each one names its
// file directly. Every GLB ships PACKED: Tripo's geometry with its one material
// pointing at public/creatures/<id>.webp, the colour map boxed to the roster's
// `texPx` (tools/tripo-pack.mjs), as an external EXT_texture_webp image. Tripo's
// three embedded 2048 JPEGs are gone from it -- the roughness and normal maps
// stay in the work dir, unused -- so the world never decodes them -- and its
// mesh node turned to face +X by the roster's `faceTurnDeg`. A critter's
// decimated LOD tiers (the bench's ladder, meshes/<n>-lod<k>.glb) ship beside
// it as <id>-lod<k>.glb, packed the same way onto the same WebP and under the
// pick's node transform, which the bench's export leaves off; a card-cross tier
// does not ship, the world draws nothing for a critter that small. A pick of
// kind 'wing-cards' (tools/creatures/wing-cards.mjs) is already the shipped
// shape -- four tris, one embedded 128 px PNG, MASK -- and is copied whole.
// Re-run this after picking a new mesh or saving a ladder in gen-creature.html,
// and commit what it writes. A creature without a pick is skipped and named,
// not shipped stale.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CREATURES, shipTexPx } from './creature-roster.mjs'
import { readMeta, readState, workDir } from './workspace.mjs'
import { packTexture, readGlbChunks, tripoColourJpeg, viewOf } from '../tripo-pack.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'public/creatures')

// Non-biped creatures the world scatters on its own terms: src/v2/render/frogs.js,
// crabs.js and butterflies.js. A biped is shipped by its rig type; these are shipped by name.
const CRITTERS = new Set(['marsh-frog', 'shore-crab', 'meadow-butterfly'])

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** The one mesh node of a GLB, which must spell its transform as a matrix (or nothing): what Tripo and three's exporter both write. */
function meshNode(id, json) {
  const nodes = json.nodes.filter((n) => n.mesh !== undefined)
  if (nodes.length !== 1) throw new Error(`${id}: ${nodes.length} mesh nodes, expected one`)
  const node = nodes[0]
  if (node.rotation || node.translation || node.scale) throw new Error(`${id}: the mesh node spells its transform as TRS, which this shipper does not carry`)
  return node
}

/** `m` turned about +Y by the roster's faceTurnDeg, so the world's loader sees one transform that faces +X. */
function faced(m, meta) {
  const deg = meta.faceTurnDeg ?? 0
  if (!deg) return m
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180)
  // Column-major: each column (x, y, z, w) of m maps through the yaw, x' = c x + s z, z' = -s x + c z.
  const turned = [...m]
  for (let col = 0; col < 16; col += 4) {
    turned[col] = c * m[col] + s * m[col + 2]
    turned[col + 2] = -s * m[col] + c * m[col + 2]
  }
  return turned
}

/** The pick's GLB, then each decimated tier of its ladder, packed onto one WebP. */
function ship(id, meta, pickedMesh) {
  if (path.extname(pickedMesh) !== '.glb') throw new Error(`${id}: picked mesh ${pickedMesh} is not a glb -- the world loads glb only`)
  if (!(meta.sizeM > 0)) throw new Error(`${id}: no sizeM -- the world has no size to draw it at`)
  const src = path.join(workDir(id), 'meshes', pickedMesh)
  const entry = (readState(id).meshes ?? []).find((m) => m.file === pickedMesh)
  if (entry?.kind === 'wing-cards') {
    if (!CRITTERS.has(id)) throw new Error(`${id}: wing cards are a critter's shape, and ${id} is not in CRITTERS`)
    const out = path.join(OUT, `${id}.glb`)
    fs.copyFileSync(src, out)
    console.log(`ship ${id}.glb: ${pickedMesh} copied whole (${(fs.statSync(out).size / 1024).toFixed(0)} KB, wing cards, ${entry.params.tris} tris @ ${entry.params.texPx}px)`)
    return
  }
  const { json, bin } = readGlbChunks(src)
  const texture = `${id}.webp`
  const texPx = shipTexPx(meta)
  packTexture(tripoColourJpeg(src, json, bin, 0), path.join(OUT, texture), texPx)
  const matrix = faced(meshNode(id, json).matrix ?? IDENTITY, meta)
  pack(id, src, `${id}.glb`, texture, matrix, `${meta.sizeM} m, texture ${texPx}px ${(fs.statSync(path.join(OUT, texture)).size / 1024).toFixed(0)} KB`)
  if (!CRITTERS.has(id)) return
  for (const lod of entry?.lods ?? []) {
    if (lod.kind !== 'decimated') continue
    const tier = `${pickedMesh.replace(/\.glb$/, '')}-lod${lod.level}.glb`
    pack(id, path.join(workDir(id), 'meshes', tier), `${id}-lod${lod.level}.glb`, texture, matrix, `${lod.tris} tris`)
  }
}

/** One GLB with only the bufferViews its accessors read, its images replaced by `texture` as an external EXT_texture_webp image, its mesh node under `matrix`. */
function pack(id, src, outName, texture, matrix, note) {
  const { json, bin } = readGlbChunks(src)
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
    nodes: json.nodes.map((n) => n === node ? { ...n, matrix } : n),
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
const avatars = []
for (const { id } of CREATURES) {
  const meta = readMeta(id)
  const biped = meta.rigType === 'biped'
  if (!biped && !CRITTERS.has(id)) continue
  const { pickedMesh } = readState(id)
  if (!pickedMesh) {
    console.log(`skip ${id}: no picked mesh`)
    continue
  }
  ship(id, meta, pickedMesh)
  if (biped) avatars.push({ id, heightM: meta.sizeM })
}
if (!avatars.length) throw new Error('nothing to ship -- no biped has a picked mesh')
fs.writeFileSync(path.join(OUT, 'avatars.json'), JSON.stringify({ avatars }, null, 2) + '\n')
console.log(`wrote public/creatures/avatars.json with ${avatars.length} avatars`)
