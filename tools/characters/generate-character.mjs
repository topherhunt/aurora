// ---------------------------------------------------------------------------
// Orchestrates one character end to end: three chroma-keyed sheet views on
// disk in -> three rigged, animated, textured GLBs (+ a billboard + rig.json)
// out. Does not call OpenRouter -- `sheetDir` already holds front.png/
// side.png/back.png, whether from a real generation or (during pipeline
// development, per the plan's sequencing) a hand-supplied placeholder.
//
//   node tools/characters/generate-character.mjs <id> <sheetDir> [heightM]
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writePng } from '../props/png.mjs'
import { decodeSheet, keyMagenta, silhouetteProfile } from './chromakey.mjs'
import { buildCharacterMesh } from './loft-mesh.mjs'
import { buildSkeleton, skinVertices } from './rig.mjs'
import { bakeTexture } from './bake-texture.mjs'
import { buildBillboard } from './billboard.mjs'
import { CLIP_NAMES, bakeClip } from './animations.mjs'
import { writeGlb } from './gltf-writer.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ANIM_PARAMS_PATH = path.join(ROOT, 'tools/characters/animations.json')

export function generateCharacter({ id, sheetDir, outDir, heightM = 1.7 }) {
  const views = {}
  const alphas = {}
  const profiles = {}
  for (const name of ['front', 'side', 'back']) {
    const view = decodeSheet(path.join(sheetDir, `${name}.png`))
    const alpha = keyMagenta(view)
    views[name] = view
    alphas[name] = alpha
    profiles[name] = silhouetteProfile(alpha, view.w, view.h)
  }

  fs.mkdirSync(outDir, { recursive: true })

  const texture = bakeTexture(views, profiles, 128)
  const texPath = path.join(outDir, 'texture.png')
  writePng(texPath, texture.w, texture.h, texture.rgba, 4)
  const textureBuffer = fs.readFileSync(texPath)

  const billboard = buildBillboard(views.front, alphas.front, profiles.front, heightM)
  writePng(path.join(outDir, 'billboard.png'), billboard.w, billboard.h, billboard.rgba, 4)

  // gen-anim.html's tuned params, when present, override animations.mjs's
  // own DEFAULT_PARAMS -- checked in so a fresh checkout still bakes.
  const animParams = fs.existsSync(ANIM_PARAMS_PATH) ? JSON.parse(fs.readFileSync(ANIM_PARAMS_PATH, 'utf8')) : {}

  let skeleton
  const results = []
  for (let lod = 0; lod < 3; lod++) {
    const mesh = buildCharacterMesh(profiles.front, profiles.side, { heightM, lod })
    if (lod === 0) {
      skeleton = buildSkeleton(mesh.landmarks)
      // gen-character.html's per-bone nudges, applied on top of rig.mjs's
      // proportional placement -- see that bench's own note on why this
      // moves the bind pose without touching skin weights.
      const overridePath = path.join(outDir, 'rig-override.json')
      if (fs.existsSync(overridePath)) {
        const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'))
        const boneIndex = new Map(skeleton.bones.map((b, i) => [b.name, i]))
        for (const [name, xyz] of Object.entries(override)) {
          const i = boneIndex.get(name)
          if (i === undefined) throw new Error(`rig-override.json for "${id}" references unknown bone "${name}"`)
          skeleton.translations[i * 3] = xyz[0]
          skeleton.translations[i * 3 + 1] = xyz[1]
          skeleton.translations[i * 3 + 2] = xyz[2]
        }
      }
    }
    const { skinIndices, skinWeights } = skinVertices(mesh, skeleton)
    const geo = { pos: mesh.pos, nrm: mesh.nrm, uv: mesh.uv, idx: mesh.idx, skinIndices, skinWeights }
    const animations = CLIP_NAMES.map((name) => bakeClip(name, skeleton, animParams[name]))
    const r = writeGlb(path.join(outDir, `lod${lod}.glb`), geo, { skeleton, animations, image: textureBuffer })
    results.push({ lod, ...r })
  }

  fs.writeFileSync(path.join(outDir, 'rig.json'), JSON.stringify({
    bones: skeleton.bones,
    translations: Array.from(skeleton.translations),
  }, null, 2))

  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({
    id, heightM,
    billboard: { worldWidthM: billboard.worldWidthM, worldHeightM: billboard.worldHeightM },
  }, null, 2))

  return { id, results, billboard: { worldWidthM: billboard.worldWidthM, worldHeightM: billboard.worldHeightM } }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, sheetDirArg, heightMArg] = process.argv.slice(2)
  if (!id || !sheetDirArg) {
    console.error('usage: node tools/characters/generate-character.mjs <id> <sheetDir> [heightM]')
    process.exit(1)
  }
  const sheetDir = path.resolve(sheetDirArg)
  const outDir = path.join(ROOT, 'public/characters', id)
  const r = generateCharacter({ id, sheetDir, outDir, heightM: heightMArg ? Number(heightMArg) : 1.7 })
  for (const res of r.results) {
    console.log(`  LOD${res.lod}  ${String(res.tris).padStart(4)} tris  ${String(res.verts).padStart(4)} verts  ${(res.bytes / 1024).toFixed(1)} KB`)
  }
  console.log(`billboard ${r.billboard.worldWidthM.toFixed(2)}m x ${r.billboard.worldHeightM.toFixed(2)}m`)
  console.log(`-> ${path.relative(ROOT, outDir)}/`)
}
