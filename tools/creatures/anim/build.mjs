/**
 * Build animation clips for a rigged creature.
 *
 *   node tools/creatures/anim/build.mjs <id> [clip ...] [--sheet] [--view side]
 *
 * Clips are JSON specs in ./clips. Each one becomes `anim-<name>.glb` in the
 * creature's work dir, which is exactly what the /gen-creature bench globs, so a
 * rebuilt clip shows up in the dropdown with no bench change.
 *
 * Every build prints its diagnostics. Those numbers, not the eye, are what say a
 * foot is planted -- see `diagnose()` in gait.mjs. `--sheet` additionally renders
 * a contact sheet per clip, which is for judging whether the result reads as an
 * animal rather than whether it is numerically sound.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bakeClip } from './bake.mjs'
import { diagnose, solveClip } from './gait.mjs'
import { readRigMap, workDir } from './rig-map.mjs'
import { poseClip } from './pose.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
export const CLIPS = path.join(HERE, 'clips')

export const clipNames = () => fs.readdirSync(CLIPS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

export function readSpec(name) {
  const file = path.join(CLIPS, `${name}.json`)
  if (!fs.existsSync(file)) throw new Error(`no clip spec "${name}" -- have ${clipNames().join(', ')}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** The rig a clip is built against, same preference order as the Blender export. */
export function rigFile(id) {
  const dir = workDir(id)
  const found = ['rig-fixed.glb', 'rig.glb'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
  if (!found) throw new Error(`no rig for "${id}" -- rig it first`)
  return found
}

export function buildClip(id, name) {
  const spec = readSpec(name)
  const map = readRigMap(id)
  const source = rigFile(id)
  // A gait spec places feet and solves IK; a pose spec interpolates hand-authored
  // keyframes. Sitting has no footfall cycle, so it cannot come from a gait.
  const solved = spec.kind === 'pose' ? poseClip(source, map, spec) : solveClip(source, map, spec)
  const out = path.join(workDir(id), `anim-${name}.glb`)
  const baked = bakeClip({
    source, out, name,
    times: solved.times,
    tracks: solved.tracks,
    root: solved.root,
    rootTranslations: solved.rootTranslations,
  })
  return { ...baked, stats: diagnose(solved), spec, map }
}

/** Render a contact sheet beside the clip, for judging it by eye. */
export function renderSheet(id, name, view = 'side', frames = 8) {
  const dir = workDir(id)
  const map = readRigMap(id)
  const out = path.join(dir, 'sheets', `${name}-${view}.png`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const blender = process.env.BLENDER
    || (fs.existsSync('/Applications/Blender.app/Contents/MacOS/Blender')
      ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender')
  execFileSync(blender, [
    '--background', '--factory-startup', '--python', path.join(HERE, 'sheet.py'), '--',
    '--in', path.join(dir, `anim-${name}.glb`),
    '--out', out,
    '--forward', String(map.frame.forward[0]), String(map.frame.forward[2]),
    '--ground', String(map.ground),
    '--frames', String(frames),
    '--view', view,
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  return out
}

const mm = (v) => `${(v * 1000).toFixed(1)}mm`

function main() {
  const args = process.argv.slice(2)
  const id = args.find((a) => !a.startsWith('--'))
  if (!id) throw new Error(`usage: build.mjs <id> [clip ...] [--sheet] -- clips: ${clipNames().join(', ')}`)
  const view = args.includes('--view') ? args[args.indexOf('--view') + 1] : 'side'
  const wanted = args.filter((a) => !a.startsWith('--') && a !== id && a !== view)
  const names = wanted.length ? wanted : clipNames()

  for (const name of names) {
    const { out, channels, duration, samples, stats } = buildClip(id, name)
    console.log(`${name.padEnd(8)} ${channels} channels, ${samples} samples, ${duration.toFixed(2)}s`
      + `  -> ${path.relative(ROOT, out)}`)
    console.log(`         slide ${mm(stats.stanceSlide)}  ik ${mm(stats.ikStance)}/${mm(stats.ikSwing)}`
      + `  float ${mm(stats.stanceFloat)}  sink ${mm(stats.penetration)}`
      + `  loop ${(stats.loopGap * 180 / Math.PI).toFixed(2)} deg  speed ${stats.speed.toFixed(2)} m/s`)
    if (args.includes('--sheet')) console.log(`         sheet ${path.relative(ROOT, renderSheet(id, name, view))}`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
