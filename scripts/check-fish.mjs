// Node-side gates for the fish (src/v2/render/fish.js).
//
//   node scripts/check-fish.mjs
//
// The pool runs against a synthetic lake: a 60 m bowl of water at y = 10 over
// a bed that shelves from 2 m deep at the middle to the shore, with a bar of
// dry land across it. Everything below is a way a fish can go wrong without
// anything throwing: a fish on the bank, a fish in the air, a school that has
// quietly dispersed, a pike lying beside another pike, a shoal of glimmerfin
// on the bed, a school swimming in lockstep or all one size, a 2 m lake
// handing out giants or a 24 m one handing out only fry, a pool that stays
// where she entered the water instead of turning over as she swims, that
// churns while she stands still, that fails to empty on dry land or to refill
// in water, a frame that costs more than a scatter is allowed to. The shipped
// asset is checked against the roster too, because a species missing from
// fish.json would draw as nothing.
//
// What this can NOT check: whether they look like fish, or whether the tail
// moves. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Fish, SPECIES, POOL_RADIUS, RETIRE_RADIUS, BORN_FOR } from '../src/v2/render/fish.js'
import { SPECIES as ROSTER } from '../tools/fauna/fish-roster.mjs'
import { TEX_PX_MAX, TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

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
  // The picks are Tripo's 500-face meshes as they came; a coarse ship reads as a card up close.
  check(a.idx.length / 3 >= 240, `${a.id}: shipped at the pick's density`, `${a.idx.length / 3} tris`)
  check(a.bend.every((b) => b >= 0 && b <= 1), `${a.id}: bend weights in [0, 1]`)
  check(a.uv.every((v) => v >= -1e-4 && v <= 1 + 1e-4), `${a.id}: uvs inside the map`)
  const mapFile = new URL(`../public/fauna/${a.texture}`, import.meta.url)
  check(fs.existsSync(mapFile) && a.texture.endsWith('.webp'), `${a.id}: colour map ${a.texture} is shipped`)
  if (fs.existsSync(mapFile)) {
    // Every fish is designated small in the creature roster; nothing generated ships wider than TEX_PX_MAX.
    const { width, height } = webpSize(fs.readFileSync(mapFile))
    check(width === TEX_PX_SMALL && height === TEX_PX_SMALL && width <= TEX_PX_MAX, `${a.id}: colour map is ${TEX_PX_SMALL}px square`, `${width}x${height}`)
  }
  check(a.metalness === undefined, `${a.id}: no metalness -- Tripo's PBR maps are not shipped`, `${a.metalness}`)
  // Nose at -Z, centred, at the roster length: the tail fin is the blade end, so the outer tenth at +Z is narrower across than the outer tenth at -Z.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < a.pos.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], a.pos[i + c]); hi[c] = Math.max(hi[c], a.pos[i + c]) }
  check(Math.abs(hi[2] - lo[2] - a.lengthM) < 1e-3 && Math.abs(hi[2] + lo[2]) < 1e-3 && Math.abs(hi[0] + lo[0]) < 1e-3, `${a.id}: spans its length along z about the origin`, `${lo[2]}..${hi[2]}`)
  const width = (sign) => {
    let xmin = Infinity, xmax = -Infinity
    for (let i = 0; i < a.pos.length; i += 3) {
      if (sign * a.pos[i + 2] < 0.4 * a.lengthM) continue
      xmin = Math.min(xmin, a.pos[i]); xmax = Math.max(xmax, a.pos[i])
    }
    return xmax - xmin
  }
  check(width(+1) < 0.5 * width(-1), `${a.id}: nose at -Z, tail at +Z`, `ends ${width(-1).toFixed(3)} / ${width(+1).toFixed(3)} m across`)
  let bendRises = true
  for (let i = 0; i < a.pos.length; i += 3) if (Math.abs(a.bend[i / 3] - ((a.pos[i + 2] / a.lengthM + 0.5) ** 2)) > 0.01) bendRises = false
  check(bendRises, `${a.id}: bend weight is the squared nose-to-tail fraction`)
}

// --- construction and the shader hook --------------------------------------
const scene = new THREE.Scene()
const fish = new Fish(scene, height, water, { seed: 23, assets })
check(fish.species.length === 3 && fish.species.every((sp) => sp.loaded), 'three species, all loaded from assets')
for (const sp of fish.species) {
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <map_fragment>\n#include <lights_fragment_end>\n' }
  sp.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec4 aSwim') && shader.vertexShader.includes('FISH_WAVE_K') && shader.vertexShader.includes('+ aSwim.z') && shader.vertexShader.includes('aBend * aSwim.w'), `${sp.id}: swim wiggle, turn curve and lift spliced into begin_vertex`)
  // Underwater a fish does not glint -- the surface does. A specular term here would be a fish shining as if it were held up in the air.
  check(sp.material.isMeshLambertMaterial && !shader.fragmentShader.includes('directSpecular'), `${sp.id}: Lambert, no specular, untouched fragment stage`, sp.material.type)
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
// Every frame's yaw per fish, to catch a fish that turns without bending: a turn faster than 0.6 rad/s must carry a curve toward its inside. Likewise a fish pitched past 0.15 rad must carry a lift the same way, so a climb is an arc and not a tilted board.
const yawOf = new Map()
let turning = 0
let bent = 0
let stiff = 0
let pitched = 0
let arched = 0
// Every glimmerfin bolt onset, grouped by the startle that armed it (the frame a school's boltIn timers were set), to catch a startle that fires the whole shoal at once: one startle's onsets must spread over time and miss some of the shoal.
const startles = new Map()
const armedBy = new Map()
const wasBolt = new Map()
for (let i = 0; i < SECONDS / DT; i++) {
  fish.update(0, LEVEL + 1.6, 0, DT)
  for (const sp of fish.species) {
    for (const f of sp.slots) {
      const bolt = f.alive && f.mood === 'bolt'
      const onset = bolt && !wasBolt.get(f)
      if (!f.alive) armedBy.delete(f)
      // A fish at the very edge the fright starts from bolts on the arming frame itself, so its timer is never seen above zero.
      else if ((f.boltIn > 0 || onset) && !armedBy.has(f)) {
        const key = `${sp.schools.indexOf(f.school)}@${i}`
        if (!startles.has(key)) startles.set(key, { first: Infinity, last: 0, n: 0, size: f.school.members.length })
        armedBy.set(f, startles.get(key))
      }
      if (onset) {
        const s = armedBy.get(f)
        armedBy.delete(f)
        s.first = Math.min(s.first, i * DT)
        s.last = Math.max(s.last, i * DT)
        s.n++
      }
      wasBolt.set(f, bolt)
      const yaw = Math.atan2(-f.hx, -f.hz)
      const was = yawOf.get(f)
      yawOf.set(f, f.alive ? yaw : undefined)
      if (!f.alive || was === undefined || f.born < 0.5) continue
      if (Math.abs(f.pitch) > 0.15) {
        pitched++
        if (Math.sign(f.lift) === Math.sign(f.pitch) && Math.abs(f.lift) > 0.05 * sp.lengthM) arched++
      }
      const rate = Math.atan2(Math.sin(yaw - was), Math.cos(yaw - was)) / DT
      if (Math.abs(rate) < 0.6) continue
      turning++
      // A left turn is yaw increasing and the tail swung to local -X.
      if (Math.sign(f.curve) === -Math.sign(rate) && Math.abs(f.curve) > 0.03 * sp.lengthM) bent++
      else if (Math.abs(f.curve) < 0.01 * sp.lengthM) stiff++
    }
  }
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
check(turning > 1000 && bent / turning > 0.9, 'a turning fish arcs into its turn', `${bent} of ${turning} turning frames bent the right way`)
check(stiff / Math.max(1, turning) < 0.01, 'no fish turns straight as a board', `${stiff} of ${turning} turning frames stiff`)
check(pitched > 1000 && arched / pitched > 0.9, 'a pitched fish arcs into its climb or dive', `${arched} of ${pitched} pitched frames arched the right way`)
{
  // A startle still rippling when the run ends is cut short; only whole ones count.
  const shoals = [...startles.values()].filter((s) => s.size >= 6 && s.n > 0 && s.first < SECONDS - 2)
  const spreads = shoals.map((s) => s.last - s.first)
  const onOneFrame = spreads.filter((s) => s < DT / 2).length
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / Math.max(1, spreads.length)
  const bolted = shoals.reduce((a, s) => a + s.n / s.size, 0) / Math.max(1, shoals.length)
  check(shoals.length >= 20, 'glimmerfin shoals startle over the run', `${shoals.length} startles of 6+ fish`)
  check(onOneFrame === 0 && meanSpread > 0.25, 'a startle ripples through a shoal, never in one frame', `${onOneFrame} startles fired on one frame; onsets spread ${meanSpread.toFixed(2)} s first to last on average`)
  check(bolted > 0.5 && bolted < 0.97, 'a startle misses a few of the shoal', `${(bolted * 100).toFixed(0)}% of a shoal bolts on average`)
}
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

// --- no two fish alike ------------------------------------------------------
// Read off the final frame: within a school, headings fan out and speeds differ, and the sizes of a school are not one size.
for (const sp of fish.species) {
  const schools = sp.schools.filter((sc) => sc.members.length >= 3)
  if (!schools.length) continue
  let fan = 0
  let spread = 0
  let sizes = 0
  for (const sc of schools) {
    const m = sc.members
    let mx = 0
    let mz = 0
    for (const f of m) { mx += f.hx; mz += f.hz }
    const ml = Math.hypot(mx, mz) || 1
    fan += m.reduce((s, f) => s + Math.acos(Math.max(-1, Math.min(1, (f.hx * mx + f.hz * mz) / ml))), 0) / m.length
    const v = m.map((f) => Math.hypot(f.vx, f.vz))
    const mean = v.reduce((a, b) => a + b, 0) / v.length
    spread += Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) / (mean || 1)
    const sc0 = m.map((f) => f.scale)
    sizes += (Math.max(...sc0) - Math.min(...sc0)) / Math.min(...sc0)
  }
  fan /= schools.length
  spread /= schools.length
  sizes /= schools.length
  check(fan > 0.2, `${sp.id}: a school's headings fan out`, `mean ${fan.toFixed(2)} rad off the school's mean heading`)
  check(spread > 0.1, `${sp.id}: a school's speeds differ`, `coefficient of variation ${spread.toFixed(2)}`)
  check(sizes > 0.2, `${sp.id}: a school's sizes differ`, `largest is ${(1 + sizes).toFixed(2)}x the smallest on average`)
}

// --- the deep is where the big ones are ------------------------------------
{
  const shallow = alive().map((f) => f.scale)
  const meanShallow = shallow.reduce((a, b) => a + b, 0) / shallow.length
  check(meanShallow < 0.9, 'fish in a 2 m lake are on the small side', `mean scale ${meanShallow.toFixed(2)}`)
  const DEEP2 = 24
  const deepHeight = { heightAt: (x, z) => { const r = Math.hypot(x, z) / LAKE_R; return LEVEL - DEEP2 * Math.max(0, 1 - r * r) } }
  const deepWater = { levelAt: (x, z) => (Math.hypot(x, z) < LAKE_R ? LEVEL : null) }
  const deepFish = new Fish(new THREE.Scene(), deepHeight, deepWater, { seed: 5, assets })
  deepFish.place(0, 0)
  const deep = deepFish.species.flatMap((sp) => sp.slots.filter((f) => f.alive && LEVEL - f.bed > 12).map((f) => f.scale))
  const meanDeep = deep.reduce((a, b) => a + b, 0) / deep.length
  check(deep.length > 40 && meanDeep > 1.6, 'fish over 12 m of water skew large', `${deep.length} fish, mean scale ${meanDeep.toFixed(2)}`)
  check(Math.min(...deep) < 0.9 && Math.max(...deep) > 2.2, 'but the deep still holds the odd small one, and some giants', `${Math.min(...deep).toFixed(2)} .. ${Math.max(...deep).toFixed(2)}`)
  for (let i = 0; i < 10 * 72; i++) deepFish.update(0, LEVEL - 5, 0, DT)
  const big = deepFish.species.flatMap((sp) => sp.slots.filter((f) => f.alive))
  check(big.every((f) => f.y >= f.bed + f.margin && f.y <= f.level - f.margin), 'a giant keeps its own bulk off the bed and under the surface', `${big.length} fish after 10 s`)
  deepFish.dispose()
}

// --- the pool turns over as she swims ---------------------------------------
{
  const before = new Set(fish.species.flatMap((sp) => sp.schools))
  const n0 = alive().length
  // 20 s at 2 m/s, straight across the lake: about a swimmer's pace.
  for (let i = 0; i < 20 * 72; i++) fish.update(0, LEVEL - 1, -2 * i * DT, DT)
  const after = fish.species.flatMap((sp) => sp.schools)
  const fresh = after.filter((sc) => !before.has(sc)).length
  check(fresh / after.length > 0.5, 'swimming 40 m turns over more than half the pool', `${fresh} of ${after.length} schools are new`)
  check(alive().length > n0 * 0.7, 'and keeps it full on the way', `${alive().length} of ${n0} before`)
  check(alive().every(inWater), 'every fish met on the way is in the water')
  const nearHer = alive().filter((f) => Math.hypot(f.x, f.z + 40) < 20).length
  check(nearHer > 30, 'with fish in sight where she has arrived', `${nearHer} within 20 m of her`)
  for (let i = 0; i < 5 * 72; i++) fish.update(0, LEVEL - 1, -40, DT)
  const still = new Set(fish.species.flatMap((sp) => sp.schools))
  for (let i = 0; i < 5 * 72; i++) fish.update(0, LEVEL - 1, -40, DT)
  const kept = fish.species.flatMap((sp) => sp.schools).filter((sc) => still.has(sc)).length
  check(kept >= still.size - 3, 'standing still recycles nothing', `${kept} of ${still.size} schools kept over 5 s`)
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

// --- out of the water, the pool follows without a fish stepped -------------
{
  for (let i = 0; i < 3 * 72; i++) fish.update(200, LEVEL, 0, DT)
  check(alive().length === 0, 'the pool is empty again on dry land', JSON.stringify(fish.stats))
  for (let i = 0; i < 3 * 72; i++) fish.follow(0, LEVEL + 1.6, 0)
  const s = fish.stats
  check(fish.species.every((sp) => s[sp.id].alive > sp.cfg.count * 0.5), 'follow() stocks the water around her from the shore', JSON.stringify(s))
  check(alive().every((f) => f.born === BORN_FOR), 'and every fish it seeds is born full-grown')
  const pose = alive().map((f) => [f, f.x, f.y, f.z, f.phase, f.hx, f.hz])
  const frame = fish.frame
  for (let i = 0; i < 72; i++) fish.follow(0, LEVEL + 1.6, 0)
  check(pose.every(([f, x, y, z, ph, hx, hz]) => f.x === x && f.y === y && f.z === z && f.phase === ph && f.hx === hx && f.hz === hz), 'a second of follow() moves no fish and beats no tail')
  check(fish.frame === frame, 'and counts no frame')
  const before = new Set(fish.species.flatMap((sp) => sp.schools))
  for (let i = 0; i < 20 * 72; i++) fish.follow(0, LEVEL + 1.6, -2 * i * DT)
  const after = fish.species.flatMap((sp) => sp.schools)
  check(after.filter((sc) => !before.has(sc)).length / after.length > 0.5, 'walking the shore turns the pool over like swimming does', `${after.filter((sc) => !before.has(sc)).length} of ${after.length} schools are new`)
  check(alive().filter((f) => Math.hypot(f.x, f.z + 40) < 20).length > 30, 'so the water is stocked where she would dive', `${alive().filter((f) => Math.hypot(f.x, f.z + 40) < 20).length} within 20 m of her`)
  fish.update(0, LEVEL - 1, -40, DT)
  check(alive().every((f) => f.born === BORN_FOR), 'the first frame under keeps them full-grown')
  for (let i = 0; i < 3 * 72; i++) fish.update(0, LEVEL, 0, DT)
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
