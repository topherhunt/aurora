/**
 * Seal, remesh and re-bake one dense generated mesh (Trellis-2) into low-poly tiers, written as
 * `<out-dir>/<name>-<tris>.glb`. Design: design/43-remesh.md.
 *
 *   node tools/mesh/remesh.mjs <dense.glb> <out-dir> [--tiers 500] [--tex 512]
 *     [--seal-res 128,96] [--ray m [--ray-far m]] [--cage m] [--focus z>0.85:4] [--normals transfer]
 *
 * Needs Blender (BLENDER=/path, else the macOS app or `blender` on PATH) and xatlas (`npm run mesh:pydeps`).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function blenderBinary() {
  const guesses = [process.env.BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', 'blender'].filter(Boolean)
  for (const b of guesses) if (b === 'blender' || fs.existsSync(b)) return b
  throw new Error(`no Blender found -- tried ${guesses.join(', ')}. Set BLENDER=/path/to/blender.`)
}

export function remesh(src, outDir, { tiers = [500], tex = 512, sealRes = null, ray = null, rayFar = null, cage = null, focus = null, normals = null } = {}) {
  if (!fs.existsSync(src)) throw new Error(`no mesh ${src}`)
  fs.mkdirSync(outDir, { recursive: true })
  const prefix = path.join(outDir, path.basename(src, '.glb'))
  // Blender exits 0 after a Python exception and prints the traceback on stderr.
  const run = spawnSync(blenderBinary(), [
    '--background', '--factory-startup',
    '--python', path.join(ROOT, 'tools/mesh/remesh.py'),
    '--', '--in', src, '--out-prefix', prefix, '--tiers', tiers.join(','), '--tex', String(tex),
    ...(sealRes ? ['--seal-res', sealRes.join(',')] : []),
    ...(ray != null ? ['--ray', String(ray)] : []),
    ...(rayFar != null ? ['--ray-far', String(rayFar)] : []),
    ...(cage != null ? ['--cage', String(cage)] : []),
    ...(focus ? ['--focus', focus] : []),
    ...(normals ? ['--normals', normals] : []),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
  if (run.error) throw run.error
  const stages = run.stdout.split('\n').filter((l) => l.startsWith('remesh: ')).map((l) => JSON.parse(l.slice(8)))
  const done = stages.filter((s) => s.stage === 'tier')
  if (done.length !== tiers.length) throw new Error(`Blender finished ${done.length} of ${tiers.length} tiers:\n${run.stderr.slice(-1500)}`)
  return done
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i < 0 ? null : args.splice(i, 2)[1]
  }
  const opts = {
    tiers: flag('--tiers')?.split(',').map(Number),
    tex: flag('--tex') ? Number(flag('--tex')) : undefined,
    sealRes: flag('--seal-res')?.split(',').map(Number),
    ray: flag('--ray') ? Number(flag('--ray')) : null,
    rayFar: flag('--ray-far') ? Number(flag('--ray-far')) : null,
    cage: flag('--cage') ? Number(flag('--cage')) : null,
    focus: flag('--focus'),
    normals: flag('--normals'),
  }
  const [src, outDir] = args
  if (!src || !outDir) throw new Error('usage: remesh.mjs <dense.glb> <out-dir> [--tiers 500] [--tex 512] [--seal-res 128,96] [--ray m [--ray-far m]] [--cage m] [--focus z>0.85:4] [--normals transfer]')
  for (const t of remesh(src, outDir, opts)) console.log(`${t.file}  ${t.tris} tris (target ${t.targetTris}) from seal ${t.sealRes}, ${t.selfIntersections} crossing face pairs, ${t.charts} UV charts filling ${Math.round(t.fill * 100)}%  ${t.seconds}s`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
