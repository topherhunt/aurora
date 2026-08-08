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
  const json = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'))
  // BIN chunk starts after the JSON chunk plus its own 8-byte header.
  return { json, bin: b.subarray(20 + jsonLen + 8) }
}

const COMPONENT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array }
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }

// Accessors here are interleave-tolerant but not sparse-aware; the Blender
// exporter writes neither sparse accessors nor normalized integer positions.
function readAccessor(glb, index) {
  const acc = glb.json.accessors[index]
  const view = glb.json.bufferViews[acc.bufferView]
  const Ctor = COMPONENT[acc.componentType]
  const n = NCOMP[acc.type]
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  const stride = view.byteStride ?? Ctor.BYTES_PER_ELEMENT * n
  const out = new Float64Array(acc.count * n)
  for (let i = 0; i < acc.count; i++) {
    const el = new Ctor(glb.bin.buffer, glb.bin.byteOffset + base + i * stride, n)
    for (let c = 0; c < n; c++) out[i * n + c] = el[c]
  }
  return out
}

// Total world surface area, and how much of it sits in triangles too small to
// draw. See the "surface area, not triangle count" check below for why.
const DEGENERATE_M2 = 1e-4 // 1 cm^2
function surface(glb, prim) {
  const p = readAccessor(glb, prim.attributes.POSITION)
  const idx = readAccessor(glb, prim.indices)
  let area = 0
  let degenerate = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [i, j, k] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3]
    const ax = p[j] - p[i], ay = p[j + 1] - p[i + 1], az = p[j + 2] - p[i + 2]
    const bx = p[k] - p[i], by = p[k + 1] - p[i + 1], bz = p[k + 2] - p[i + 2]
    const a = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)
    area += a
    if (a < DEGENERATE_M2) degenerate++
  }
  return { area, degenerate }
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

  // A texture the build could not find is not a build failure -- Blender
  // substitutes magenta and the asset exports perfectly -- so the only trace is
  // this field. Without it the failure is a colour, and nothing here reads
  // colours.
  if (a.missing_images) warn(`${id}: built with textures it could not find -- ${a.missing_images.join(', ')}`)
  // A textured asset with an untextured slot is a chimera: correct trunk, grey
  // canopy. The build cannot resolve it (the map is on disk but the FBX never
  // references it), so it says so and this repeats it where it gets read.
  if (a.untextured_slots) warn(`${id}: ${a.untextured_slots.length} material slot(s) bake flat, not textured -- ${a.untextured_slots.join(', ')}`)

  let glb
  try {
    glb = readGlb(glbPath)
  } catch (e) {
    check(false, `${id}: glb parses`, e.message)
    continue
  }
  const gltf = glb.json

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

    // Surface area, not triangle count. A collapse decimator does not fail on a
    // tuft of grass blades -- it succeeds the only way it can, by flattening
    // them. The triangles remain, their UVs still address healthy texels, so the
    // manifest, the tri count and the UV-footprint probe all report a fine
    // asset that renders as a dozen specks. Four photoscan grass variants passed
    // every other check in this file that way, and only looking at a render
    // caught it. This is that look, made mechanical: a tier whose triangles have
    // no area is not a cheap tier, it is an absent one.
    // Two measures, because neither decides alone. `degenFrac` is how much of
    // the tier is triangles too small to draw; `frac` is how much of the
    // silhouette it could fill that it actually presents. Wasted triangles are
    // not fatal on their own -- `fern_polypody` is 6 slivers in 15 and the other
    // 9 are a fern. A thin silhouette is not fatal on its own either -- a wispy
    // tuft is legitimately thin, and `grass_wild_scan_d` sits at 2.4% in perfect
    // health. Both at once is the crush, and there it is unambiguous: the four
    // excluded grass variants ran 84-88% degenerate at 0.1-3.9% of silhouette.
    const geo = surface(glb, prim)
    const degenFrac = geo.degenerate / tris
    const pAcc = gltf.accessors[prim.attributes.POSITION]
    const hull = pAcc?.min && pAcc?.max
      ? Math.max(pAcc.max[0] - pAcc.min[0], pAcc.max[2] - pAcc.min[2]) * (pAcc.max[1] - pAcc.min[1])
      : 0
    const frac = hull > 0 ? geo.area / hull : 1
    const crushed = degenFrac > 0.25 && frac < 0.05
    check(!crushed, `${id}: ${lod.name} kept its surface through decimation`,
      crushed ? `${geo.degenerate} of ${tris} tris under ${DEGENERATE_M2 * 1e4} cm2, ${(100 * frac).toFixed(1)}% of silhouette` : '')
    if (!crushed && degenFrac > 0.25) warn(`${id}: ${lod.name} spends ${geo.degenerate} of ${tris} triangles on slivers under ${DEGENERATE_M2 * 1e4} cm2`)
    if (!crushed && frac < 0.02) warn(`${id}: ${lod.name} presents ${geo.area.toFixed(4)} m2, ${(100 * frac).toFixed(1)}% of its silhouette -- looks thin`)

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
  // Per tier, not per asset. Each mesh tier is unwrapped and baked against its
  // own triangulation (build.py), because a single atlas baked on the full-res
  // source addresses UVs that decimation has already invalidated -- five assets
  // rendered fully transparent that way. So a two-tier textured asset spends two
  // of the 256 slices, and the impostor sheet is another.
  for (const lod of lods) {
    const rel = lod.layer
    const key = `${lod.name} layer`
    // A billboard always carries its own sheet. A mesh tier carries one exactly
    // when the asset is textured, and the manifest has to agree with the mesh
    // about that: a tier with UVs and no layer would sample slice 0, which
    // belongs to whichever asset happens to be first in the array.
    if (lod.kind !== 'billboard') {
      check(!!rel === !!a.textured, `${id}: ${key} matches textured=${!!a.textured}`,
        !!rel === !!a.textured ? '' : `layer ${rel ?? 'null'}`)
    }
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
