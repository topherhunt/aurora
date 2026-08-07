// Gate on the built prop library (DESIGN.md §9, build step 4).
//
//   node scripts/check-props.mjs
//
// Reads what `tools/props/build.py` actually wrote into public/props and
// asserts the things the runtime assumes. This parses the GLB container by
// hand rather than going through GLTFLoader, for two reasons: the loader needs
// a DOM, and more importantly a loader is forgiving in exactly the places this
// wants to be strict. The bug that motivated the COLOR_0 assertion below --
// Blender's exporter dropping every vertex colour because no material node
// read the layer -- produces a GLB that loads perfectly and renders untinted,
// flat and AO-less. Nothing short of looking at the attribute list catches it.
//
// What this can NOT check: whether the assets look right. That needs eyes, and
// on a headset (§17).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'public', 'props')

// §9: WebGL2 guarantees MAX_ARRAY_TEXTURE_LAYERS >= 256, and that is the
// ceiling the whole "one layer per asset" plan is written against.
const MAX_LAYERS = 256
const LAYER_SIZE = 128

let failures = 0
let warnings = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const warn = (label, detail = '') => {
  warnings++
  console.log(` warn  ${label}${detail ? `   ${detail}` : ''}`)
}

// --- GLB container ----------------------------------------------------------

function readGlb(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error(`not a GLB: ${file}`)
  const jsonLen = b.readUInt32LE(12)
  return JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'))
}

// PNG IHDR is fixed-offset and the first chunk by spec, so no decoder needed.
function pngInfo(file) {
  const b = fs.readFileSync(file)
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`not a PNG: ${file}`)
  return {
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
    colorType: b[25], // 6 = RGBA
  }
}

// --- load -------------------------------------------------------------------

if (!fs.existsSync(path.join(DIR, 'manifest.json'))) {
  console.log(' FAIL  public/props/manifest.json missing -- run `npm run props` first')
  process.exit(1)
}
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'))
const assets = manifest.assets ?? []

console.log(`\n=== prop library: ${assets.length} assets ===\n`)
check(assets.length > 0, 'manifest lists assets')

// --- per asset --------------------------------------------------------------

const layers = new Set()
let totalTris = 0
let totalVerts = 0
let totalBytes = 0
const stalled = []
const classCounts = {}

for (const a of assets) {
  const id = a.id
  classCounts[a.class] = (classCounts[a.class] ?? 0) + 1

  const glbPath = path.join(DIR, a.glb)
  if (!fs.existsSync(glbPath)) {
    check(false, `${id}: glb exists`, a.glb)
    continue
  }
  totalBytes += fs.statSync(glbPath).size

  let gltf
  try {
    gltf = readGlb(glbPath)
  } catch (e) {
    check(false, `${id}: glb parses`, e.message)
    continue
  }

  // Every LOD the manifest promises has to be a mesh in the file. A chain that
  // claims four tiers and ships three degrades to "the far tier never swaps in",
  // which on a headset looks like a distant pop rather than like a missing file.
  const meshByName = new Map(gltf.meshes?.map((m) => [m.name, m]) ?? [])
  const lods = a.lods ?? []
  check(lods.length > 0, `${id}: has at least one LOD`)

  let prevTris = Infinity
  for (const lod of lods) {
    const mesh = meshByName.get(lod.name)
    if (!mesh) {
      check(false, `${id}: ${lod.name} present in glb`)
      continue
    }

    // One material per asset (§5) -- BatchedMesh batches only across a shared
    // material, and one primitive per LOD is what makes the load-time merge a
    // no-op rather than a concatenation.
    check(mesh.primitives.length === 1, `${id}: ${lod.name} is one primitive`,
      mesh.primitives.length === 1 ? '' : `${mesh.primitives.length} primitives`)

    const prim = mesh.primitives[0]
    const attrs = Object.keys(prim.attributes)
    const tris = prim.indices != null ? gltf.accessors[prim.indices].count / 3 : 0
    const verts = gltf.accessors[prim.attributes.POSITION].count

    check(tris > 0, `${id}: ${lod.name} has geometry`, `${tris} tris`)
    check(Number.isInteger(tris), `${id}: ${lod.name} index count divisible by 3`)

    // The regression this file exists for. See the header.
    check(attrs.includes('COLOR_0'), `${id}: ${lod.name} carries COLOR_0`,
      attrs.includes('COLOR_0') ? '' : `attrs: ${attrs.join(',')}`)
    check(attrs.includes('NORMAL'), `${id}: ${lod.name} carries NORMAL`)
    if (a.textured) {
      check(attrs.includes('TEXCOORD_0'), `${id}: ${lod.name} carries TEXCOORD_0`)
    }

    // Monotonic chain. A LOD1 heavier than LOD0 costs triangles at the exact
    // distance the tier existed to save them, and reads on the HUD as "props
    // are expensive" rather than as a broken chain.
    check(tris <= prevTris, `${id}: ${lod.name} not heavier than the tier before it`,
      tris <= prevTris ? '' : `${prevTris} -> ${tris}`)
    prevTris = tris

    if (lod.stalled) stalled.push(`${id}/${lod.name} ${lod.tris} vs ${lod.target_tris} target`)

    // The manifest is what the runtime budgets against, so it has to match the
    // file rather than the intent.
    check(lod.tris === tris, `${id}: ${lod.name} manifest tri count matches glb`,
      lod.tris === tris ? '' : `manifest ${lod.tris}, glb ${tris}`)

    totalTris += tris
    totalVerts += verts
  }

  // --- placement contract ---------------------------------------------------
  // scatter.js places a prop by its foot and subtracts a small `sink` from the
  // terrain height. An asset centred on its bounding box instead floats by half
  // its own height, and because the error scales with the prop it reads as "the
  // big props are broken" rather than as one systematic offset.
  const lod0 = meshByName.get(lods[0]?.name)
  if (lod0) {
    const acc = gltf.accessors[lod0.primitives[0].attributes.POSITION]
    if (acc?.min && acc?.max) {
      const [minX, minY, minZ] = acc.min
      const [maxX, maxY, maxZ] = acc.max
      const h = maxY - minY
      check(Math.abs(minY) < 0.02, `${id}: base sits on y=0`, `minY ${minY.toFixed(4)}`)
      check(Math.abs(h - a.height_m) / a.height_m < 0.02, `${id}: stands ${a.height_m} m`,
        `measured ${h.toFixed(3)} m`)
      // Not a hard failure: a fallen log is legitimately wider than it is tall.
      // But a tree with this shape means the source was Z-up and nobody noticed.
      const foot = Math.max(maxX - minX, maxZ - minZ)
      if (foot > h * 4) warn(`${id}: footprint ${foot.toFixed(1)} m vs ${h.toFixed(1)} m tall -- check orientation`)
    } else {
      warn(`${id}: POSITION accessor has no min/max, cannot verify grounding`)
    }
  }

  // --- texture layers -------------------------------------------------------
  for (const key of ['layer', 'billboard_layer']) {
    const rel = a[key]
    if (!rel) continue
    const p = path.join(DIR, rel)
    if (!fs.existsSync(p)) {
      check(false, `${id}: ${key} exists`, rel)
      continue
    }
    layers.add(rel)
    const info = pngInfo(p)
    // §9: every Class-B layer is one slice of one DataArrayTexture, and a
    // DataArrayTexture requires every slice be identical in size and format.
    // One odd-sized PNG does not degrade -- it fails the upload for all of them.
    check(info.width === LAYER_SIZE && info.height === LAYER_SIZE,
      `${id}: ${key} is ${LAYER_SIZE}x${LAYER_SIZE}`, `${info.width}x${info.height}`)
    check(info.colorType === 6, `${id}: ${key} is RGBA`,
      info.colorType === 6 ? '' : `PNG colorType ${info.colorType}`)
  }

  if (a.billboard_layer) {
    const bb = lods[lods.length - 1]
    check(bb?.kind === 'billboard', `${id}: billboard is the last tier`)
  }
}

// --- library-wide -----------------------------------------------------------

console.log('')
check(layers.size < MAX_LAYERS, `texture layers fit one array`,
  `${layers.size} / ${MAX_LAYERS} guaranteed`)

// Orphaned PNGs mean a rebuild that renamed or dropped an asset left the old
// layer behind, and the layer index the runtime assigns is positional.
const onDisk = fs.existsSync(path.join(DIR, 'layers'))
  ? fs.readdirSync(path.join(DIR, 'layers')).filter((f) => f.endsWith('.png'))
  : []
const orphans = onDisk.filter((f) => !layers.has(`layers/${f}`))
check(orphans.length === 0, 'no orphaned layer PNGs',
  orphans.length ? orphans.slice(0, 5).join(', ') : '')

// --- report -----------------------------------------------------------------

console.log(`\n=== summary ===\n`)
console.log(`  assets            ${assets.length}   (${Object.entries(classCounts).map(([k, v]) => `${v} ${k}`).join(', ')})`)
console.log(`  texture layers    ${layers.size} / ${MAX_LAYERS}`)
console.log(`  library geometry  ${(totalTris / 1000).toFixed(1)}k tris, ${(totalVerts / 1000).toFixed(1)}k verts, all LODs`)
console.log(`  on disk           ${(totalBytes / 1024 / 1024).toFixed(2)} MB of GLB`)

if (stalled.length) {
  console.log(`\n  ${stalled.length} LOD(s) stalled above target -- the collapse decimator will`)
  console.log(`  not collapse across an open boundary, so meshes with many boundary`)
  console.log(`  loops have a hard floor. These are real triangles the budget pays for:`)
  for (const s of stalled.slice(0, 12)) console.log(`    ${s}`)
  if (stalled.length > 12) console.log(`    ... and ${stalled.length - 12} more`)
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}${warnings ? `, ${warnings} warning(s)` : ''}\n`)
process.exit(failures === 0 ? 0 : 1)
