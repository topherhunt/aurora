// Node-side gates for the fish (src/v2/render/fish.js).
//
//   node scripts/check-fish.mjs
//
// The beds run against a synthetic lake: a 60 m bowl of water at y = 10 over
// a bed that shelves from 2 m deep at the middle to the shore, with a bar of
// dry land across it, on a room clock stepped at 72 Hz from a time off every
// grid. Everything below is a way a fish can go wrong without anything
// throwing: a fish on the bank, a fish in the air, a school that has quietly
// dispersed, a pike lying beside another pike, a shoal of glimmerfin on the
// bed, a school swimming in lockstep or all one size or one colour, a 2 m
// lake handing out giants or a 24 m one handing out only fry, beds that stay
// where she entered the water instead of turning over as she swims, that
// churn while she stands still, that fail to empty on dry land or to refill
// in water, a segment turn that snaps a fish across the water, a twin client
// or a late joiner whose fish are not this client's to the bit, a lure the
// room is not told of, a taken fish a bed grows back, a frame that costs more
// than a scatter is allowed to. The shipped asset is checked against the
// roster too, because a species missing from fish.json would draw as nothing.
//
// What this can NOT check: whether they look like fish, or whether the tail
// moves. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import { Fish, SPECIES, TILE, RADIUS, HUE, DART_SPEED, STUN_S, LOOSE_GONE_M, LURES, LURE_M, LURE_FORGET_M, LURE_HASTE, LURED_EVERY_S } from '../src/v2/render/fish.js'
import { CHAPTER_S, GRID_S, chapterOf } from '../src/sim/score.js'
import { taken } from '../src/v2/taken.js'
import { SPECIES as ROSTER } from '../tools/fauna/fish-roster.mjs'
import { TEX_PX_MAX, TEX_PX_SMALL } from '../tools/creatures/creature-roster.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'
import { setTierTint } from '../src/v2/render/critters.js'

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
let levelAtCalls = 0
const water = {
  levelAt(x, z) {
    levelAtCalls++
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
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <lights_fragment_end>\n#include <dithering_fragment>\n' }
  sp.material.onBeforeCompile(shader)
  check(shader.vertexShader.includes('attribute vec4 aSwim') && shader.vertexShader.includes('FISH_WAVE_K') && shader.vertexShader.includes('+ aSwim.z') && shader.vertexShader.includes('aBend * aSwim.w'), `${sp.id}: swim wiggle, turn curve and lift spliced into begin_vertex`)
  // Underwater a fish does not glint -- the surface does. A specular term here would be a fish shining as if it were held up in the air.
  check(sp.material.isMeshLambertMaterial && !shader.fragmentShader.includes('directSpecular'), `${sp.id}: Lambert, no specular`, sp.material.type)
  // The hue turn (critters.js hueVary): read per instance, carried across, and applied to the sampled map before it is lit.
  check(shader.vertexShader.includes('attribute float aHue;') && shader.vertexShader.includes('vHue = aHue;') && /<map_fragment>\n\{\n[^}]*cross\( hueK, diffuseColor\.rgb \)/.test(shader.fragmentShader), `${sp.id}: the hue turns the sampled colour after map_fragment`)
  check(parseFloat(sp.material.defines.FISH_WAVE_K) > 0, `${sp.id}: wave number set from the length`, sp.material.defines.FISH_WAVE_K)
  // The tint row (critters.js tierTintSplice): a fish ships one mesh, so it wears tier 0, painted over the encoded output after dithering and switched by the row.
  check(shader.fragmentShader.includes('uniform vec4 uTierTint;') && /<dithering_fragment>\nif \( uTierTint\.w > 0\.5 \) gl_FragColor\.rgb = uTierTint\.xyz;/.test(shader.fragmentShader), `${sp.id}: the tint row paints over the output after dithering`)
  setTierTint(true)
  check(shader.uniforms.uTierTint.value.w === 1 && shader.uniforms.uTierTint.value.x < 0.5 && shader.uniforms.uTierTint.value.y > 0.5, `${sp.id}: the row switches the bound uniform on, tier 0's green`)
  setTierTint(false)
  check(shader.uniforms.uTierTint.value.w === 0, `${sp.id}: and off again`)
  check(sp.mesh.geometry.getAttribute('aBend') && sp.mesh.geometry.getAttribute('aSwim').isInstancedBufferAttribute && sp.mesh.geometry.getAttribute('aHue') === sp.hue && sp.hue.isInstancedBufferAttribute, `${sp.id}: aBend per vertex, aSwim and aHue per instance`)
}

// --- placement --------------------------------------------------------------
// The room's clock: a time well into a chapter and off every grid, so nothing lines up by accident.
const T0 = 4321.37
const DT = 1 / 72
const clock = { seconds: T0 }
const step = (x, y, z, lures) => { clock.seconds += DT; fish.update(x, y, z, clock.seconds, lures) }
fish.place(0, 0)
const alive = (of = fish) => of.species.flatMap((sp) => sp.slots.filter((f) => f.alive))
const bass = fish.species.find((sp) => sp.id === 'ironscale-bass')
const pikeSp = fish.species.find((sp) => sp.id === 'rime-fangpike')
const glim = fish.species.find((sp) => sp.id === 'glimmerfin')
// A bed rolls perTile sites a species and keeps the ones over water deep enough; four beds round her in the bowl, the bar and the rim refusing a few, so stocked is at least half the sites grown, each school at its species' smallest.
const stocked = (s) => [bass, glim, pikeSp].every((sp) => s[sp.id].schools >= s.tiles * sp.cfg.perTile * 0.5 && s[sp.id].alive >= s[sp.id].schools * sp.cfg.school[0])
{
  const s = fish.stats
  check(stocked(s), 'place stocks the beds around her', JSON.stringify(s))
  const all = alive()
  check(all.every(inWater), 'every placed fish is in the water', `${all.length} fish`)
  check(all.every((f) => Math.hypot(f.x, f.z) <= RADIUS + TILE), 'no placed fish beyond the beds', `${all.length} fish`)
  check(pikeSp.schools.every((sc) => sc.members.length === 1), 'pike are placed alone')
  check(bass.schools.every((sc) => sc.members.length >= bass.cfg.school[0]), 'bass are placed in schools', `${bass.schools.length} schools`)
  const hues = all.map((f) => f.hue)
  check(new Set(hues.map((h) => h.toFixed(3))).size > all.length * 0.8 && Math.min(...hues) < -HUE * 0.5 && Math.max(...hues) > HUE * 0.5 && hues.every((h) => Math.abs(h) <= HUE), 'hues vary either way round the wheel, within HUE', `${Math.min(...hues).toFixed(2)}..${Math.max(...hues).toFixed(2)} rad`)
  // A bed is a pure function of its tile: keys name the bed and the site, members are numbered through the bed, and a second layer on the same seed grows the same beds with the same rolls.
  const keys = fish.species.flatMap((sp) => sp.schools.map((sc) => sc.key))
  check(keys.every((k) => /^fs:-?\d+,-?\d+:\d+$/.test(k)) && new Set(keys).size === keys.length, 'every school wears its bed and site key, no two alike', keys.slice(0, 3).join(' '))
  check([...fish.tiles.values()].every((t) => t.fish.every((f, i, arr) => arr.findIndex((g) => g.index === f.index) === i)), 'members are numbered uniquely through their bed')
  const twin = new Fish(new THREE.Scene(), height, water, { seed: 23, assets })
  twin.place(0, 0)
  const same = fish.species.every((sp, i) => sp.schools.length === twin.species[i].schools.length && sp.schools.every((sc, j) => {
    const o = twin.species[i].schools[j]
    return sc.key === o.key && sc.home.x === o.home.x && sc.home.z === o.home.z && sc.members.length === o.members.length && sc.members.every((f, k) => f.index === o.members[k].index && f.scale === o.members[k].scale && f.hue === o.members[k].hue && f.ring === o.members[k].ring)
  }))
  check(same, 'a twin on the same seed grows the same beds, schools and fish', `${keys.length} schools`)
  twin.dispose()
}

// --- the run ----------------------------------------------------------------
const SECONDS = 90
let dry = 0
let bar = 0
const speeds = { 'ironscale-bass': 0, 'rime-fangpike': 0, 'glimmerfin': 0 }
let samples = 0
// Every frame's yaw per fish, to catch a fish that turns without bending: a turn faster than 0.6 rad/s must carry a curve toward its inside. Likewise a fish pitched past 0.15 rad must carry a lift the same way, so a climb is an arc and not a tilted board.
const yawOf = new Map()
let turning = 0
let bent = 0
let stiff = 0
let pitched = 0
let arched = 0
// Every glimmerfin bolt onset, grouped by the startle that armed it (the frame a school's boltIn timers were seen set), to catch a startle that fires the whole shoal at once: one startle's onsets must spread over time and miss some of the shoal.
const startles = new Map()
const armedBy = new Map()
const wasBolt = new Map()
// Every fast set-off (a new mood, or a bolt re-armed mid-bolt, at DART_SPEED or more) against what startled() lists that frame: the two must be the same fish, each once, and a glimmerfin's slow fidget is never among them. A segment turn re-rolls the mood and is not a set-off.
const wasMood = new Map()
const setOffs = { 'ironscale-bass': 0, 'rime-fangpike': 0, 'glimmerfin': 0 }
let listedWrong = 0
let listedSlow = 0
// The largest jump a drawn fish makes between frames: a segment turn snaps each fish onto its station, and the ease before it must have brought it close enough that the snap is nothing the eye reads.
const drawn = new Map()
let jumps = 0
let jumpMax = 0
let turns = 0
for (let i = 0; i < SECONDS / DT; i++) {
  step(0, LEVEL + 1.6, 0)
  const listedNow = new Set(fish.startled([]))
  if (listedNow.size !== fish.startles.length) listedWrong++
  for (const sp of fish.species) {
    for (const f of sp.slots) {
      const mood = wasMood.get(f)
      wasMood.set(f, f.alive ? { mood: f.mood, left: f.moodLeft, seg: f.school.seg } : undefined)
      const turned = f.alive && mood !== undefined && mood.seg !== f.school.seg
      if (turned) turns++
      const fresh = f.alive && mood !== undefined && !turned && (f.mood !== mood.mood || f.moodLeft > mood.left)
      const fast = fresh && f.speed >= DART_SPEED
      if (fast) setOffs[sp.id]++
      // The first frame catches every school up from its segment's start, many ticks in one frame; a turn frame re-rolls the mood after the tick.
      if (i > 0 && !turned && fast !== listedNow.has(f)) listedWrong++
      if (i > 0 && listedNow.has(f) && f.speed < DART_SPEED) listedSlow++
      const bolt = f.alive && f.mood === 'bolt'
      const onset = bolt && !wasBolt.get(f)
      // A segment turn resets the school, its bolt timers with it: the ripple is cut where it stood.
      if (turned && armedBy.has(f)) { armedBy.get(f).cut = true; armedBy.delete(f) }
      if (!f.alive) armedBy.delete(f)
      // A fish at the very edge the fright starts from bolts on the arming frame itself, so its timer is never seen above zero.
      else if ((f.boltIn > 0 || onset) && !armedBy.has(f)) {
        const key = `${f.school.key}@${i}`
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
      if (f.alive) {
        const a = f.school.rec.alpha
        const x = f.px + (f.x - f.px) * a, y = f.py + (f.y - f.py) * a, z = f.pz + (f.z - f.pz) * a
        const d = drawn.get(f)
        if (d && i > 72) {
          const jump = Math.hypot(x - d[0], y - d[1], z - d[2])
          if (jump > 0.35) jumps++
          jumpMax = Math.max(jumpMax, jump)
        }
        drawn.set(f, [x, y, z])
      } else drawn.delete(f)
      if (!f.alive || was === undefined || i < 72) continue
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
      sum += Math.hypot(f.vx, f.vy, f.vz)
      n++
    }
    if (n) speeds[sp.id] += sum / n
  }
}
check(dry === 0, `no fish out of the water over ${SECONDS} s`, `${dry} samples dry`)
check(bar === 0, 'no fish crossed the bar of land', `${bar} samples on it`)
check(fish.stats.beached === 0, 'no fish had to be put back at its anchor', `${fish.stats.beached} beached`)
check(fish.stats.ticks >= fish.stats.schools * SECONDS * 20 * 0.99, 'every school ticks at 20 Hz on the clock', `${fish.stats.ticks} ticks for ${fish.stats.schools} schools`)
check(turns >= alive().length * Math.floor(SECONDS / GRID_S) && jumps === 0, 'a segment turn snaps no drawn fish further than the eye reads', `${turns} fish-turns, ${jumps} jumps over 0.35 m, largest ${jumpMax.toFixed(3)} m`)
check(turning > 1000 && bent / turning > 0.9, 'a turning fish arcs into its turn', `${bent} of ${turning} turning frames bent the right way`)
check(stiff / Math.max(1, turning) < 0.01, 'no fish turns straight as a board', `${stiff} of ${turning} turning frames stiff`)
check(pitched > 1000 && arched / pitched > 0.9, 'a pitched fish arcs into its climb or dive', `${arched} of ${pitched} pitched frames arched the right way`)
{
  // A startle still rippling when the run ends is cut short; only whole ones count.
  // A startle cut by a segment turn is whatever bolted before the turn; only whole ripples are measured.
  const shoals = [...startles.values()].filter((s) => s.size >= 6 && s.n > 0 && s.first < SECONDS - 2 && !s.cut)
  const cut = [...startles.values()].filter((s) => s.size >= 6 && s.cut).length
  const spreads = shoals.map((s) => s.last - s.first)
  const onOneFrame = spreads.filter((s) => s < DT / 2).length
  const meanSpread = spreads.reduce((a, b) => a + b, 0) / Math.max(1, spreads.length)
  const bolted = shoals.reduce((a, s) => a + s.n / s.size, 0) / Math.max(1, shoals.length)
  check(shoals.length >= 20, 'glimmerfin shoals startle over the run', `${shoals.length} whole startles of 6+ fish, ${cut} cut by a segment turn`)
  check(onOneFrame === 0 && meanSpread > 0.25, 'a startle ripples through a shoal, never in one frame', `${onOneFrame} of ${shoals.length} startles fired on one frame; onsets spread ${meanSpread.toFixed(2)} s first to last on average`)
  check(bolted > 0.5 && bolted < 0.97, 'a startle misses a few of the shoal', `${(bolted * 100).toFixed(0)}% of a shoal bolts on average`)
}
{
  // startled(): every fast set-off, each once, on its frame, and nothing slower.
  const n = Object.values(setOffs).reduce((a, b) => a + b, 0)
  check(n > 100 && Object.values(setOffs).every((k) => k > 10), 'bass dart, pike burst and glimmerfin bolt over the run', JSON.stringify(setOffs))
  check(listedWrong === 0 && listedSlow === 0, `startled() lists exactly the fish setting off at ${DART_SPEED} m/s or more, each once, on its frame`, `${listedWrong} frames or fish disagree, ${listedSlow} listed slow`)
  check(fish.startled([]).every((f) => f.size > 0 && f.size === fish.species.find((sp) => sp.slots.includes(f)).lengthM * f.scale), 'a listed fish carries its length in metres')
  fish.follow(0, LEVEL + 1.6, 0)
  check(fish.startled([]).length === 0, 'the beds only following her list nobody')
  for (let i = 0; i < 500 && !fish.startles.length; i++) step(0, LEVEL + 1.6, 0)
  fish.batch.visible = false
  check(fish.startles.length > 0 && fish.startled([]).length === 0, 'a hidden layer lists nobody')
  fish.batch.visible = true
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
  check(sp.schools.every((sc) => Math.hypot(sc.x - sc.home.x, sc.z - sc.home.z) <= sp.cfg.tether + 1e-6 && water.levelAt(sc.x, sc.z) !== null), `${sp.id}: every anchor is in the water within its tether of home`)
}
{
  const pike = pikeSp.slots.filter((f) => f.alive)
  let minPair = Infinity
  let minBed = Infinity
  for (let i = 0; i < pike.length; i++) for (let j = i + 1; j < pike.length; j++) {
    const d = Math.hypot(pike[i].x - pike[j].x, pike[i].z - pike[j].z)
    minPair = Math.min(minPair, d)
    if (pike[i].tile === pike[j].tile) minBed = Math.min(minBed, d)
  }
  check(pike.length >= 2 && minBed > 2, 'pike of a bed keep apart', `${pike.length} pike, nearest pair in a bed ${minBed.toFixed(1)} m, over all ${minPair.toFixed(1)} m`)
  const depth = (sp) => { const a = sp.slots.filter((f) => f.alive); return a.reduce((s, f) => s + (f.level - f.y), 0) / a.length }
  check(depth(glim) < depth(bass) && depth(bass) < depth(pikeSp), 'glimmerfin above the bass above the pike', `${depth(glim).toFixed(2)} / ${depth(bass).toFixed(2)} / ${depth(pikeSp).toFixed(2)} m below the surface`)
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
  for (let i = 0; i < 10 * 72; i++) deepFish.update(0, LEVEL - 5, 0, T0 + i * DT)
  const big = deepFish.species.flatMap((sp) => sp.slots.filter((f) => f.alive))
  check(big.every((f) => f.y >= f.bed + f.margin && f.y <= f.level - f.margin), 'a giant keeps its own bulk off the bed and under the surface', `${big.length} fish after 10 s`)
  deepFish.dispose()
}

// --- the beds follow her ----------------------------------------------------
{
  const before = new Set(fish.species.flatMap((sp) => sp.schools))
  const n0 = alive().length
  // 20 s at 2 m/s, straight across the lake: about a swimmer's pace.
  for (let i = 0; i < 20 * 72; i++) step(0, LEVEL - 1, -2 * i * DT)
  const after = fish.species.flatMap((sp) => sp.schools)
  const fresh = after.filter((sc) => !before.has(sc)).length
  const gone = [...before].filter((sc) => !after.includes(sc)).length
  // Beds are TILE wide and kept to RADIUS: a 40 m swim retires the row behind her and grows the row ahead, the row beside her kept.
  check(fresh >= after.length * 0.25 && gone >= before.size * 0.25, 'swimming 40 m leaves beds behind and grows new ones ahead', `${fresh} of ${after.length} schools are new, ${gone} of ${before.size} retired`)
  check(alive().length > n0 * 0.5, 'and keeps the water stocked on the way', `${alive().length} of ${n0} before`)
  check(alive().every(inWater), 'every fish met on the way is in the water')
  const nearHer = alive().filter((f) => Math.hypot(f.x, f.z + 40) < 20).length
  check(nearHer > 30, 'with fish in sight where she has arrived', `${nearHer} within 20 m of her`)
  const still = new Set(fish.species.flatMap((sp) => sp.schools))
  for (let i = 0; i < 5 * 72; i++) step(0, LEVEL - 1, -40)
  const kept = fish.species.flatMap((sp) => sp.schools).filter((sc) => still.has(sc)).length
  check(kept === still.size, 'standing still retires nothing', `${kept} of ${still.size} schools kept over 5 s`)
  // A bed left and come back to grows the same schools with the same fish.
  const was = new Map(fish.species.flatMap((sp) => sp.schools.map((sc) => [sc.key, sc.members.map((f) => `${f.index}:${f.scale.toFixed(4)}:${f.hue.toFixed(4)}`).join(' ')])))
  for (let i = 0; i < 40 * 72; i++) step(0, LEVEL - 1, -40 - 2 * i * DT)
  check(!fish.species.some((sp) => sp.schools.some((sc) => was.has(sc.key))), 'swum 80 m on, every bed she was in is gone', `${fish.species.reduce((n, sp) => n + sp.schools.length, 0)} schools now`)
  for (let i = 0; i < 40 * 72; i++) step(0, LEVEL - 1, -120 + 2 * i * DT)
  const again = fish.species.flatMap((sp) => sp.schools).filter((sc) => was.has(sc.key))
  check(again.length > was.size * 0.8 && again.every((sc) => was.get(sc.key) === sc.members.map((f) => `${f.index}:${f.scale.toFixed(4)}:${f.hue.toFixed(4)}`).join(' ')), 'and swum back, the same beds grow the same fish', `${again.length} of ${was.size} schools met again`)
  check(alive().every(inWater), 'every fish met on the way back is in the water')
}
for (let i = 0; i < 72; i++) step(200, LEVEL, 0)
check(alive().length === 0, 'the beds are empty on dry land', JSON.stringify(fish.stats))
step(0, LEVEL, 0)
check(stocked(fish.stats), 'and stocked on the first frame back in the water', JSON.stringify(fish.stats))
check(alive().every(inWater), 'every refilled fish is in the water')

// --- out of the water, the beds follow without a fish stepped ---------------
{
  for (let i = 0; i < 72; i++) step(200, LEVEL, 0)
  check(alive().length === 0, 'the beds are empty again on dry land', JSON.stringify(fish.stats))
  fish.follow(0, LEVEL + 1.6, 0)
  check(stocked(fish.stats), 'follow() stocks the water around her from the shore', JSON.stringify(fish.stats))
  const pose = alive().map((f) => [f, f.x, f.y, f.z, f.phase, f.hx, f.hz])
  const frame = fish.frame
  const ticks = fish.stats.ticks
  levelAtCalls = 0
  for (let i = 0; i < 72; i++) fish.follow(0, LEVEL + 1.6, 0)
  check(pose.every(([f, x, y, z, ph, hx, hz]) => f.x === x && f.y === y && f.z === z && f.phase === ph && f.hx === hx && f.hz === hz), 'a second of follow() moves no fish and beats no tail')
  check(fish.frame === frame && fish.stats.ticks === ticks, 'counts no frame and ticks no school')
  check(levelAtCalls === 0, 'and standing still samples the water not once', `${levelAtCalls} levelAt calls in 72 frames`)
  const before = new Set(fish.species.flatMap((sp) => sp.schools))
  for (let i = 0; i < 20 * 72; i++) fish.follow(0, LEVEL + 1.6, -2 * i * DT)
  const after = fish.species.flatMap((sp) => sp.schools)
  const fresh = after.filter((sc) => !before.has(sc)).length
  const gone = [...before].filter((sc) => !after.includes(sc)).length
  check(fresh >= after.length * 0.25 && gone >= before.size * 0.25, 'walking the shore turns the beds over like swimming does', `${fresh} of ${after.length} schools are new, ${gone} of ${before.size} retired`)
  const nearHer = alive().filter((f) => Math.hypot(f.x, f.z + 40) < 20).length
  check(nearHer > 30, 'so the water is stocked where she would dive', `${nearHer} within 20 m of her`)
  // The first frame under: every school is caught up from its segment's start to the clock, and not a fish is out of the water.
  const ticks0 = fish.stats.ticks
  step(0, LEVEL - 1, -40)
  check(fish.stats.ticks > ticks0 && alive().every(inWater) && fish.species.every((sp) => sp.schools.every((sc) => sc.rec.alpha >= 0 && sc.rec.alpha <= 1)), 'the first frame under has every school caught up to the clock', `${fish.stats.ticks - ticks0} ticks for ${fish.stats.schools} schools`)
  for (let i = 0; i < 3 * 72; i++) step(0, LEVEL, 0)
}

// --- the room: two clients swim the same fish -------------------------------
// A twin on the same seed, fed the same head on another frame cadence, holds every fish to the bit; a late joiner placed mid-segment is on the same fish after its first frame.
const twin = new Fish(new THREE.Scene(), height, water, { seed: 23, assets })
const poseOf = (of) => new Map(of.species.flatMap((sp) => sp.schools.flatMap((sc) => sc.members.map((f) => [`${sc.key}#${f.index}`, [f.x, f.y, f.z, f.vx, f.vy, f.vz, f.mood, f.speed, sc.x, sc.z]]))))
const agree = (a, b) => {
  if (a.size !== b.size) return { ok: false, why: `${a.size} vs ${b.size} fish` }
  let worst = 0
  let where = ''
  for (const [k, p] of a) {
    const q = b.get(k)
    if (!q) return { ok: false, why: `${k} missing` }
    for (let i = 0; i < p.length; i++) {
      const d = typeof p[i] === 'number' ? Math.abs(p[i] - q[i]) : p[i] === q[i] ? 0 : 1
      if (d > worst) { worst = d; where = `${k}[${i}]` }
    }
  }
  return { ok: worst === 0, why: `${a.size} fish, worst ${worst.toExponential(2)} at ${where || 'none'}` }
}
{
  twin.place(0, 0)
  fish.place(0, 0)
  // 30 s on the room's clock for both: this layer at 72 Hz, the twin at a wobbling 40-60 Hz that never lands on the same instants.
  const T2 = clock.seconds + 30
  let t2 = clock.seconds
  let k = 0
  while (clock.seconds < T2) step(0, LEVEL - 1, 0)
  while (t2 < clock.seconds) { t2 = Math.min(clock.seconds, t2 + 1 / 50 + Math.sin(k++) / 200); twin.update(0, LEVEL - 1, 0, t2) }
  const r = agree(poseOf(fish), poseOf(twin))
  check(r.ok, 'a twin on another frame cadence holds every fish to the bit after 30 s', r.why)
  // A late joiner replays its segment's ticks on its first frame and agrees at once.
  const late = new Fish(new THREE.Scene(), height, water, { seed: 23, assets })
  late.place(0, 0)
  late.update(0, LEVEL - 1, 0, clock.seconds)
  const l = agree(poseOf(fish), poseOf(late))
  check(l.ok, 'a late joiner is on the same fish after its first frame', l.why)
  check(late.stats.ticks > 0 && late.stats.ticks <= late.stats.schools * (GRID_S * 20 + 1), 'having replayed at most a segment of ticks per school', `${late.stats.ticks} ticks for ${late.stats.schools} schools`)
  late.dispose()
  // The chapter turn: every anchor is sent home for it, so the next chapter's chain, which starts from home, snaps no school across the water.
  let far = 0
  const homes = fish.species.flatMap((sp) => sp.schools)
  let index = -1
  for (const sc of homes) {
    const ch = chapterOf(clock.seconds, sc.key)
    index = ch.index
    const a = { x: 0, z: 0, y: 0 }
    fish._anchorAt(sc, ch.start + CHAPTER_S - 1e-3, a)
    if (Math.hypot(a.x - sc.home.x, a.z - sc.home.z) > 0.5) far++
  }
  check(far === 0, 'every anchor is home before its chapter turns', `${far} of ${homes.length} schools out at the turn of chapter ${index}`)
}

// --- her hand: a fish taken, and one let go of in the water -----------------
{
  const head = { x: 0, y: LEVEL - 1, z: 0, yaw: 0 }
  step(head.x, head.y, head.z)
  twin.update(head.x, head.y, head.z, clock.seconds)
  const f = alive().find((g) => g.size < 2 && !g.loose)
  const sp = fish.species.find((s) => s.slots.includes(f))
  const key = f.school.key
  const index = f.index
  const home = { ...f.school.home }
  const before = alive().length
  // From a hand a little short of its nose.
  const hit = fish.pickAt(f.x + 0.1, f.y, f.z, 0.5, 2)
  check(hit !== null && hit.f === f && hit.size === f.size && hit.dist < 0.5, 'pickAt finds the fish at the hand', hit ? `${hit.dist.toFixed(3)} m` : 'null')
  const capped = fish.pickAt(f.x, f.y, f.z, 0.5, f.size)
  check(capped === null || capped.f !== f, 'and passes over one at or past the size cap')
  fish.batch.visible = false
  check(fish.pickAt(f.x, f.y, f.z, 0.5, 2) === null, 'nothing is picked while the layer is hidden')
  fish.batch.visible = true
  const rec = fish.take(hit, 1)
  check(rec.kind === 'fish' && rec.name === sp.id && rec.size === f.size && rec.geometry === sp.mesh.geometry && rec.material === sp.material && rec.attrs.aSwim.length === 4 && rec.attrs.aHue.length === 1 && rec.color.length === 3 && rec.scale[0] === f.scale && rec.stowable === (f.size < 1), 'take hands back the record for the hand', JSON.stringify({ kind: rec.kind, name: rec.name, size: rec.size, stowable: rec.stowable }))
  const { geometry: _g, material: _m, ...slot } = rec
  check(fish.dress(slot).geometry === rec.geometry && fish.dress(slot).material === rec.material, 'dress puts the packed record back on its species\' geometry and material')
  sp.loaded = false
  check(fish.dress(slot) === null, 'and is null before that species\' asset lands')
  sp.loaded = true
  let wrong = 0
  try { fish.dress({ ...slot, kind: 'crab' }) } catch { wrong++ }
  try { fish.dress({ ...slot, name: 'coelacanth' }) } catch { wrong++ }
  check(wrong === 2, 'and throws for another kind or an unknown species', `${wrong} of 2`)
  check(!f.alive && alive().length === before - 1 && !fish.species.some((s) => s.schools.some((sc) => sc.members.includes(f))), 'and the fish is out of the water and its school')
  check(taken.has(`fish${index}`, home.x, home.z), 'the take is recorded against its bed\'s home', `fish${index} at (${home.x.toFixed(1)}, ${home.z.toFixed(1)})`)
  // The twin, told by the relay (hands-net.js): the same fish leaves its copy of the school.
  const tf = twin.species.find((s) => s.id === sp.id).schools.find((sc) => sc.key === key).members.find((m) => m.index === index)
  check(tf !== undefined && twin.evict(`fish${index}`, home.x, home.z) === true && !tf.alive, 'a twin evicts the same fish from its copy of the school')
  check(twin.evict(`fish${index}`, home.x, home.z) === false && twin.evict('crab3', home.x, home.z) === false && twin.evict(`fish${index}`, home.x + 5, home.z) === false, 'and refuses one already gone, another kind, or another bed')
  // The bed left and come back to grows without it.
  for (let i = 0; i < 40 * 72; i++) step(0, LEVEL - 1, -2 * i * DT)
  check(!fish.species.some((s) => s.schools.some((sc) => sc.key === key)), 'swum off, the bed is gone')
  for (let i = 0; i < 40 * 72; i++) step(0, LEVEL - 1, -80 + 2 * i * DT)
  const back = fish.species.find((s) => s.id === sp.id).schools.find((sc) => sc.key === key)
  check(back !== undefined && !back.members.some((m) => m.index === index), 'swum back, the bed grows without the taken fish', back ? `${back.members.length} members, indices ${back.members.map((m) => m.index).join(',')}` : 'no school')
  step(head.x, head.y, head.z)
  // Let go over the bank: refused.
  check(fish.release(rec, BAR.x0 + 1, LEVEL + 2, 0, head) === false, 'release on dry ground is refused')
  check(fish.release(rec, 5, LEVEL + 1, 0, head) === false, 'and in the air over the lake')
  // Let go in the lake: stunned, then away from her.
  const ok = fish.release(rec, 5, LEVEL - 0.5, 0, head)
  const loose = sp.slots.find((g) => g.loose)
  check(ok && loose && loose.alive && loose.stun > 0 && loose.amp === 0 && loose.size === rec.size && loose.index === -1, 'in the lake it is back in the layer, loose and stunned', loose ? `stun ${loose.stun.toFixed(2)} s` : 'none')
  const x0 = loose.x
  step(head.x, head.y, head.z)
  check(Math.abs(loose.x - x0) < 0.01 && loose.amp === 0, 'stunned, it drifts with its tail still')
  for (let i = 0; i < 4 * 72; i++) step(head.x, head.y, head.z)
  const out = Math.hypot(loose.x - head.x, loose.z - head.z) - Math.hypot(x0 - head.x, 0)
  check(loose.stun <= 0 && loose.amp > 0 && out > 1, 'awake, it darts away from her', `${out.toFixed(2)} m further from her in 4 s, up to ${STUN_S[1]} s of it stunned`)
  check(fish.pickAt(loose.x, loose.y, loose.z, 0.5, 2)?.f === loose, 'a loose fish can be picked up again')
  let frames = 0
  while (loose.alive && frames++ < 60 * 72) step(head.x, head.y, head.z)
  check(!loose.alive && !loose.loose, `and is forgotten past LOOSE_GONE_M ${LOOSE_GONE_M}`, `${(frames / 72).toFixed(1)} s`)
}

// --- a lure: a spider in her hand has a fish swimming through it ------------
{
  const head = { x: 0, y: LEVEL - 1, z: 0 }
  fish.place(0, 0)
  twin.place(0, 0)
  // The twin swims alongside with no lure in it, so the lured school leaves it and comes back.
  const one = (lures) => { step(head.x, head.y, head.z, lures); twin.update(head.x, head.y, head.z, clock.seconds) }
  const run = (s, lures, seen) => { for (let i = 0; i < s * 72; i++) { one(lures); if (seen) seen(i) } }
  run(1, [])
  fish.pendingLured([])
  // A bass out in the middle, well off the bar and the bank.
  const f = bass.slots.find((g) => g.alive && !g.loose && Math.hypot(g.x, g.z) < 14 && g.x < BAR.x0 - 8)
  check(f !== undefined, 'a bass swims in the middle to be lured')
  const bed = f.tile.key
  head.x = f.x
  head.z = f.z
  const gap = (l) => Math.hypot(l.x - f.x, l.y - f.y, l.z - f.z)
  // A lure held at a fixed offset from the fish, wherever it swims, so a range is exactly what it says.
  const at = (dx, dy, dz, kind = 'spider', by = null) => ({ kind, by, get x() { return f.x + dx }, get y() { return f.y + dy }, get z() { return f.z + dz } })
  run(2, [at(LURE_M + 1, 0, 0)])
  check(f.lure === null && !f.lured, `a spider ${LURE_M + 1} m off is not noticed`)
  run(2, [at(1.5, 0, 0, 'carrot')])
  // A schoolmate may have passed within LURE_M of that spider; the set owed then names it and not this fish.
  check(f.lure === null && !fish.pendingLured([]).some((s) => s[3].includes(f.index)), 'nor is a carrot in reach, and no set names it', LURES.join(', '))
  // A butterfly two metres off: it is on it at once, at LURE_HASTE times its cruise, and the ear hears the dart.
  const lure = { kind: 'butterfly', by: null, x: f.x + 2, y: f.y, z: f.z }
  one([lure])
  const heard = fish.startled([]).includes(f)
  check(f.lure === lure && f.lured && f.speed === bass.cfg.cruise * LURE_HASTE && heard, `a butterfly 2 m off is taken up at ${LURE_HASTE}x cruise, and startled() lists the dart`, `lure ${f.lure ? f.lure.kind : 'none'}, speed ${f.speed.toFixed(2)}, heard ${heard}`)
  const owed = fish.pendingLured([]).filter((s) => s[0] === bed)
  check(owed.length === 1 && owed[0][1] === 'fs' && owed[0][2] === null && owed[0][3].includes(f.index) && owed[0][3].every((i) => Number.isInteger(i) && i >= 0), 'the bed owes the room its lured set, this fish in it', JSON.stringify(owed))
  check(fish.pendingLured([]).length === 0, 'and owes it once')
  // The chase: through the hand, round on its turning circle, and through it again, over and over, near its top speed; its schoolmates on the hand with it.
  let near = Infinity
  let passes = 0
  let out = true
  let top = 0
  let swarm = 0
  let sets = 0
  run(12, [lure], () => {
    const d = gap(lure)
    near = Math.min(near, d)
    if (d < 0.25) { if (out) { passes++; out = false } }
    else if (d > 0.4) out = true
    top = Math.max(top, Math.hypot(f.vx, f.vz))
    swarm = Math.max(swarm, bass.slots.filter((g) => g.alive && g.lure === lure).length)
    sets += fish.pendingLured([]).filter((s) => s[0] === bed).length
  })
  const want = bass.cfg.cruise * LURE_HASTE * f.pace
  check(near < 0.1 && passes >= 4, 'it runs through the hand and comes round to run through it again', `nearest ${near.toFixed(2)} m, ${passes} passes in 12 s`)
  check(top > want * 0.9 && top <= want * 1.01, `near ${LURE_HASTE}x its cruise the while`, `${top.toFixed(2)} of ${want.toFixed(2)} m/s`)
  // The lure takes whoever passes within LURE_M; the rest of the school follows its anchor on.
  check(swarm >= 2, 'and a schoolmate is on the hand with it', `${swarm} bass on it at most`)
  check(sets <= 12 / LURED_EVERY_S + 1, `the changing set goes out at most once in ${LURED_EVERY_S} s`, `${sets} sets in 12 s`)
  {
    const tf = twin.species.find((s) => s.id === bass.id).schools.find((sc) => sc.key === f.school.key).members.find((m) => m.index === f.index)
    check(Math.hypot(tf.x - f.x, tf.z - f.z) > 0.5, 'the twin without the lure has that fish elsewhere', `${Math.hypot(tf.x - f.x, tf.z - f.z).toFixed(2)} m apart`)
  }
  // Lifted: the fish rises to the hand's height.
  const y0 = f.y
  const high = { kind: 'spider', by: null, x: f.x + 0.8, y: Math.min(y0 + 0.5, LEVEL - 0.6), z: f.z }
  run(6, [high])
  check(high.y - y0 > 0.15 && Math.abs(f.y - high.y) < 0.2, 'lifted, it rises to the hand', `${y0.toFixed(2)} -> ${f.y.toFixed(2)} m, hand at ${high.y.toFixed(2)}`)
  // Carried off: kept to LURE_FORGET_M, then given up at a cruise.
  const kept = at(LURE_FORGET_M - 0.5, 0, 0)
  one([kept])
  check(f.lure === kept, `a lure carried to ${LURE_FORGET_M - 0.5} m is still chased`)
  const far = at(LURE_FORGET_M + 1, 0, 0)
  fish.pendingLured([])
  one([far])
  check(f.lure === null && !f.lured && f.speed === bass.cfg.cruise, `and one at ${LURE_FORGET_M + 1} m is given up, at a cruise again`, `speed ${f.speed.toFixed(2)}`)
  // The room hears a change within LURED_EVERY_S, not on its frame.
  run(LURED_EVERY_S + 0.1, [far])
  const without = fish.pendingLured([]).filter((s) => s[0] === bed)
  check(without.length >= 1 && !without.at(-1)[3].includes(f.index), `within ${LURED_EVERY_S} s the bed owes its set without it`, JSON.stringify(without))
  const hopper = at(2, 0, 0, 'grasshopper')
  one([hopper])
  check(f.lure === hopper && f.lured, 'a grasshopper brought back within reach is noticed again')
  run(LURED_EVERY_S + 0.1, [hopper])
  const withIt = fish.pendingLured([]).filter((s) => s[0] === bed)
  check(withIt.length >= 1 && withIt.at(-1)[3].includes(f.index), 'and the bed owes its set with it again', JSON.stringify(withIt))
  one([])
  check(f.lure === null && !f.lured && f.speed === bass.cfg.cruise, 'put away, it is forgotten')
  run(LURED_EVERY_S + 0.1, [])
  const last = fish.pendingLured([]).filter((s) => s[0] === bed)
  check(last.length === 1 && last[0][3].length === 0, `and within ${LURED_EVERY_S} s the bed owes an empty set`, JSON.stringify(last))
  run(3, [])
  check(f.lure === null && !f.lured && fish.pendingLured([]).length === 0, 'and stays forgotten, nothing more owed')
  // A segment later every fish is back at its station, and the room agrees on every fish again.
  run(GRID_S + 0.5, [])
  const r = agree(poseOf(fish), poseOf(twin))
  check(r.ok, 'a segment on, the room agrees on every fish again', r.why)
  // A peer's hand: its set says which fish it has, and those keep to its lure from LURE_M on; without the set a peer's lure past LURE_M is nothing, and nothing is owed for a peer's fish.
  const peer = at(LURE_M + 1.5, 0, 0, 'spider', 7)
  one([peer])
  check(f.lure === null, `a peer's lure ${LURE_M + 1.5} m off with no set is not noticed`)
  let bad = 0
  try { fish.applyLured([bed, 'fs', 7]) } catch { bad++ }
  try { fish.applyLured('junk') } catch { bad++ }
  check(bad === 2, 'a malformed set throws', `${bad} of 2`)
  fish.applyLured([bed, 'fs', 7, [f.index]])
  one([peer])
  check(f.lure === peer && f.lured, 'with the peer\'s set naming it, the fish keeps to that lure from LURE_M on')
  check(fish.pendingLured([]).length === 0, 'and nothing is owed for a peer\'s fish')
  one([])
  one([at(LURE_M + 1.5, 0, 0, 'spider', 8)])
  check(f.lure === null, 'another peer\'s lure at that range is not', 'the set is by 7')
  one([peer])
  check(f.lure === peer, 'while the named peer\'s is again')
  fish.applyLured([bed, 'fs', 7, []])
  one([])
  one([peer])
  check(!fish.luredIn.has(bed) && f.lure === null, 'an empty set clears the bed\'s entry, and the lure is out of reach again')
  fish.applyLured([bed, 'fs', 7, [f.index]])
  fish.place(200, 0)
  check(!fish.luredIn.has(bed), 'leaving the bed forgets the peer\'s set')
  fish.place(0, 0)
}

// --- cost -------------------------------------------------------------------
{
  for (let i = 0; i < 72; i++) step(0, LEVEL, 0)
  const FRAMES = 1000
  const t0 = performance.now()
  for (let i = 0; i < FRAMES; i++) step(0, LEVEL, 0)
  const ms = (performance.now() - t0) / FRAMES
  // Node, single-threaded, on whatever this machine is: a loose bound, there to catch a neighbour search that went quadratic, not to measure.
  check(ms < 1.5, 'a frame of the beds stays cheap', `${ms.toFixed(3)} ms for ${alive().length} fish`)
}

twin.dispose()
fish.dispose()
check(scene.children.length === 0, 'dispose removes the batch from the scene')

if (failures) {
  console.error(`\n${failures} fish check(s) failed`)
  process.exit(1)
}
console.log('\nall fish checks passed')
