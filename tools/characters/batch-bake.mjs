// ---------------------------------------------------------------------------
// Bakes every character in characters.json through generateCharacter() --
// shared rig, shared animation set, chroma-keyed sheets in, three LOD GLBs +
// billboard + rig.json out. Pure local compute, no OpenRouter call, safe to
// rerun freely.
//
//   node tools/characters/batch-bake.mjs
//   node tools/characters/batch-bake.mjs --only=blacksmith,farmer
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCharacter } from './generate-character.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null

const { characters } = JSON.parse(readFileSync(resolve(ROOT, 'tools/characters/characters.json'), 'utf8'))

let ok = 0, failed = 0
for (const c of characters) {
  if (only && !only.includes(c.id)) continue
  const sheetDir = resolve(ROOT, 'tools/characters/sheets', c.id)
  if (!existsSync(resolve(sheetDir, 'front.png'))) { console.warn(`skip ${c.id}: no sheets baked yet`); continue }
  const outDir = resolve(ROOT, 'public/characters', c.id)
  try {
    const r = generateCharacter({ id: c.id, sheetDir, outDir, heightM: c.heightM })
    const tris = r.results.map((res) => `LOD${res.lod}:${res.tris}`).join(' ')
    console.log(`${c.id}: ${tris}`)
    ok++
  } catch (e) {
    console.error(`${c.id} FAILED: ${e.message}`)
    failed++
  }
}
console.log(`done: ${ok} baked, ${failed} failed`)
if (failed) process.exitCode = 1
