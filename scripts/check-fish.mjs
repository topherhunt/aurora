// Node-side gates for the fish (src/v2/render/fish.js).
//
//   node scripts/check-fish.mjs
//
// The pool runs against a synthetic lake: a 60 m bowl of water at y = 10 over
// a bed that shelves from 2 m deep at the middle to the shore, with a bar of
// dry land across it. Everything below is a way a fish can go wrong without
// anything throwing: a fish on the bank, a fish in the air, a school that has
// quietly dispersed, a pike lying beside another pike, a shoal of glimmerfin
// on the bed, a pool that fails to empty on dry land or to refill in water,
// a frame that costs more than a scatter is allowed to. The shipped asset is
// checked against the roster too, because a species missing from fish.json
// would draw as nothing.
//
// What this can NOT check: whether they look like fish, or whether the tail
// moves. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Fish, SPECIES, POOL_RADIUS, RETIRE_RADIUS } from '../src/v2/render/fish.js'
import { SPECIES as ROSTER } from '../tools/fauna/fish-roster.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic lake -----------------------------------------------------
const LAKE_R = 60
const LEVEL = 10
const DEEP = 2
const BAR = { x0: 18, x1: 22 }
const onBar = (x) => x >= BAR.x0 && x <= BAR.x1
const height = {
  heightAt(x, z) {
    if (onBar(x)) return LEVEL + 1
    const r = Math.hypot(x, z) / LAKE_R
    return LEVEL - DEEP * Math.max(0, 1 - r * r)
  },
}
const water = {
  levelAt(x, z) {
    if (onBar(x)) return null
    return Math.hypot(x, z) < LAKE_R ? LEVEL : null
  },
}
const inWater = (f) => {
  const level = water.levelAt(f.x, f.z)
  if (level === null) return false
  const bed = height.heightAt(f.x, f.z)
  return f.y >= bed - 1e-6 && f.y <= level + 1e-6
}

// --- the asset --------------------------------------------------------------
const assets = JSON.parse(fs.readFileSync(new URL('../public/fauna/fish.json', import.meta.url), 'utf8'))
check(ROSTER.every((r) => SPECIES[r.id]), 'every roster species has a behaviour entry', ROSTER.map((r) => r.id).join(', '))
check(ROSTER.every((r) => assets.species.some((a) => a.id === r.id)), 'every roster species is shipped in fish.json')
for (const a of assets.species) {
  const n = a.pos.length / 3
  const roster = ROSTER.find((r) => r.id === a.id)
  check(roster && Math.abs(a.lengthM - roster.lengthCm / 100) < 1e-6, `${a.id}: lengthM matches the roster`, `${a.lengthM} m`)
  check(a.bend.length === n && a.uv.length === n * 2 && a.nrm.length === n * 3, `${a.id}: attribute lengths agree`, `${n} verts`)
  check(a.idx.length % 3 === 0 && Math.max(...a.idx) < n, `${a.id}: index in range`, `${a.idx.length / 3} tris`)
  check(a.bend.every((b) => b >= 0 && b <= 1), `${a.id}: bend weights in [0, 1]`)
  check(a.uv.every((v) => v >= -1e-4 && v <= 1 + 1e-4), `${a.id}: uvs inside the cutout`)
  check(fs.existsSync(new URL(`../public/fauna/${a.texture}`, import.meta.url)), `${a.id}: cutout ${a.texture} is shipped`)
}

// --- construction and the shader hook --------------------------------------
const scene = new THREE.Scene()
const fish = new Fish(scene, height, water, { seed: 23, assets })
check(fish.species.length === 3 && fish.species.every((sp) => sp.loaded), 'three species, all loaded from assets')
for (const sp of fish.species) {
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n' }
  sp.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec2 aSwim') && shader.vertexShader.includes('FISH_WAVE_K'), `${sp.id}: swim wiggle spliced into begin_vertex`)
  check(parseFloat(sp.material.defines.FISH_WAVE_K) > 0, `${sp.id}: wave number set from the length`, sp.material.defines.FISH_WAVE_K)
  check(sp.mesh.geometry.getAttribute('aBend') && sp.mesh.geometry.getAttribute('aSwim').isInstancedBufferAttribute, `${sp.id}: aBend per vertex, aSwim per instance`)
}

// --- placement --------------------------------------------------------------
fish.place(0, 0)
const alive = () => fish.species.flatMap((sp) => sp.slots.filter((f) => f.alive))
{
  const s = fish.stats
  check(fish.species.every((sp) => s[sp.id].alive > sp.cfg.count * 0.5), 'place fills every species past half its pool', JSON.stringify(s))
  const all = alive()
  check(all.every(inWater), 'every placed fish is in the water', `${all.length} fish`)
  check(all.every((f) => Math.hypot(f.x, f.z) <= POOL_RADIUS + 6), 'no placed fish beyond the pool radius')
  const solo = fish.species.find((sp) => sp.id === 'rime-fangpike')
  check(solo.schools.every((sc) => sc.members.length === 1), 'pike are placed alone')
  const bass = fish.species.find((sp) => sp.id === 'ironscale-bass')
  check(bass.schools.every((sc) => sc.members.length >= bass.cfg.school[0]), 'bass are placed in schools', `${bass.schools.length} schools`)
}

// --- the run ----------------------------------------------------------------
const DT = 1 / 72
const SECONDS = 90
let dry = 0
let far = 0
let bar = 0
let maxDist = 0
const speeds = { 'ironscale-bass': 0, 'rime-fangpike': 0, 'glimmerfin': 0 }
let samples = 0
for (let i = 0; i < SECONDS / DT; i++) {
  fish.update(0, LEVEL + 1.6, 0, DT)
  if (i % 8) continue
  samples++
  for (const sp of fish.species) {
    let sum = 0
    let n = 0
    for (const f of sp.slots) {
      if (!f.alive) continue
      if (!inWater(f)) dry++
      if (onBar(f.x)) bar++
      const d = Math.hypot(f.x, f.z)
      maxDist = Math.max(maxDist, d)
      if (d > RETIRE_RADIUS + sp.cfg.schoolRadius + 2) far++
      sum += Math.hypot(f.vx, f.vy, f.vz)
      n++
    }
    if (n) speeds[sp.id] += sum / n
  }
}
check(dry === 0, `no fish out of the water over ${SECONDS} s`, `${dry} samples dry`)
check(bar === 0, 'no fish crossed the bar of land', `${bar} samples on it`)
check(far === 0, 'no fish left alive beyond the retire radius', `max ${maxDist.toFixed(1)} m`)
for (const sp of fish.species) {
  const mean = speeds[sp.id] / samples
  // The upper bound is loose because the bolts and bursts are on top of the cruise; it is there to catch a runaway, not to measure.
  check(mean > sp.cfg.cruise * 0.3 && mean < sp.cfg.cruise * 4, `${sp.id}: swims at roughly its cruise`, `${mean.toFixed(2)} m/s (cruise ${sp.cfg.cruise})`)
}

// --- the personalities, read off the final frame ----------------------------
for (const sp of fish.species) {
  const members = sp.schools.flatMap((sc) => sc.members.map((f) => ({ f, sc })))
  const stray = members.map(({ f, sc }) => Math.hypot(f.x - sc.x, f.z - sc.z))
  const meanStray = stray.reduce((a, b) => a + b, 0) / stray.length
  check(meanStray < sp.cfg.schoolRadius * 1.5, `${sp.id}: holds together around its anchor`, `mean ${meanStray.toFixed(2)} m of ${sp.cfg.schoolRadius} m`)
  const fracs = members.map(({ f }) => (f.y - f.bed) / (f.level - f.bed))
  const meanFrac = fracs.reduce((a, b) => a + b, 0) / fracs.length
  check(meanFrac > sp.cfg.depth[0] - 0.15 && meanFrac < sp.cfg.depth[1] + 0.15, `${sp.id}: sits in its band of the water column`, `mean ${meanFrac.toFixed(2)} of [${sp.cfg.depth}]`)
  const mesh = sp.mesh
  check(mesh.count === members.length, `${sp.id}: instance count is the live count`, `${mesh.count}`)
  const arr = mesh.instanceMatrix.array
  let finite = true
  for (let i = 0; i < mesh.count * 16; i++) if (!Number.isFinite(arr[i])) finite = false
  check(finite, `${sp.id}: instance matrices are finite`)
}
{
  const pike = fish.species.find((sp) => sp.id === 'rime-fangpike').slots.filter((f) => f.alive)
  let minPair = Infinity
  for (let i = 0; i < pike.length; i++) for (let j = i + 1; j < pike.length; j++) minPair = Math.min(minPair, Math.hypot(pike[i].x - pike[j].x, pike[i].z - pike[j].z))
  check(pike.length >= 2 && minPair > 2, 'pike keep apart', `${pike.length} pike, nearest pair ${minPair.toFixed(1)} m`)
  const glim = fish.species.find((sp) => sp.id === 'glimmerfin')
  const bass = fish.species.find((sp) => sp.id === 'ironscale-bass')
  const depth = (sp) => { const a = sp.slots.filter((f) => f.alive); return a.reduce((s, f) => s + (f.level - f.y), 0) / a.length }
  check(depth(glim) < depth(bass) && depth(bass) < depth(pike[0] ? fish.species.find((sp) => sp.id === 'rime-fangpike') : bass), 'glimmerfin above the bass above the pike', `${depth(glim).toFixed(2)} / ${depth(bass).toFixed(2)} m below the surface`)
}

// --- the pool follows her ---------------------------------------------------
for (let i = 0; i < 3 * 72; i++) fish.update(200, LEVEL, 0, DT)
check(alive().length === 0, 'the pool empties on dry land', JSON.stringify(fish.stats))
for (let i = 0; i < 3 * 72; i++) fish.update(0, LEVEL, 0, DT)
{
  const s = fish.stats
  check(fish.species.every((sp) => s[sp.id].alive > sp.cfg.count * 0.5), 'and refills within three seconds back in the water', JSON.stringify(s))
  check(alive().every(inWater), 'every refilled fish is in the water')
}

// --- cost -------------------------------------------------------------------
{
  const FRAMES = 1000
  const t0 = performance.now()
  for (let i = 0; i < FRAMES; i++) fish.update(0, LEVEL, 0, DT)
  const ms = (performance.now() - t0) / FRAMES
  // Node, single-threaded, on whatever this machine is: a loose bound, there to catch a neighbour search that went quadratic, not to measure.
  check(ms < 1.5, 'a frame of the pool stays cheap', `${ms.toFixed(3)} ms for ${alive().length} fish`)
}

fish.dispose()
check(scene.children.length === 0, 'dispose removes the batch from the scene')

if (failures) {
  console.error(`\n${failures} fish check(s) failed`)
  process.exit(1)
}
console.log('\nall fish checks passed')
