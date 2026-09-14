/**
 * Build `rig.blend` for one creature, or for every creature that has a rig.
 *
 *   node tools/creatures/blend-rig.mjs <id>      one creature
 *   node tools/creatures/blend-rig.mjs --all     every rig on disk
 *
 * The .blend is a derived artifact: throw it away and this rebuilds it. What it
 * adds over the GLB -- connected bones, hidden bone widgets, Auto IK on -- is
 * Blender authoring state that glTF cannot carry, so it has to live in a .blend
 * or be redone by hand on every import. See blend-rig.py for the why of each.
 *
 * Built from `rig-fixed.glb` when the rig editor has produced one, because that
 * is the skeleton carrying our Mixamo names and the one Blender should import.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WORK = path.join(ROOT, 'tools/creatures/work')

/** Same resolution order the bench's Blender dialog offers. */
export function rigSource(dir) {
  for (const name of ['rig-fixed.glb', 'rig.glb']) {
    if (fs.existsSync(path.join(dir, name))) return name
  }
  return null
}

function blenderBinary() {
  const guesses = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean)
  for (const b of guesses) {
    if (b === 'blender' || fs.existsSync(b)) return b
  }
  throw new Error(`no Blender found -- tried ${guesses.join(', ')}. Set BLENDER=/path/to/blender.`)
}

/**
 * Rebuild `<work>/<id>/rig.blend`. Throws if the creature has no rig, or if
 * Blender is missing or fails -- callers on a paid path should catch and report
 * rather than let a local tooling gap look like a lost rig.
 */
export function blendRig(id) {
  const dir = path.join(WORK, id)
  const src = rigSource(dir)
  if (!src) throw new Error(`no rig for "${id}" -- rig the mesh first`)
  const out = path.join(dir, 'rig.blend')
  const log = execFileSync(blenderBinary(), [
    '--background', '--factory-startup',
    '--python', path.join(ROOT, 'tools/creatures/blend-rig.py'),
    '--', '--in', path.join(dir, src), '--out', out,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const summary = log.split('\n').filter((l) => l.startsWith('blend-rig:'))
  if (!fs.existsSync(out)) throw new Error(`Blender wrote no .blend for "${id}":\n${log.slice(-2000)}`)
  return { id, source: src, file: 'rig.blend', summary }
}

function main() {
  const args = process.argv.slice(2)
  const ids = args.includes('--all')
    ? fs.readdirSync(WORK).filter((id) => rigSource(path.join(WORK, id)))
    : args.filter((a) => !a.startsWith('--'))
  if (!ids.length) throw new Error('usage: blend-rig.mjs <id> | --all')

  for (const id of ids) {
    const { source, summary } = blendRig(id)
    console.log(`${id}  <- ${source}`)
    for (const line of summary) console.log(`  ${line.replace(/^blend-rig: /, '')}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
