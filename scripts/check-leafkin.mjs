// Node-side gates for the leafkin (src/v2/render/leafkin.js, DESIGN.md §30).
//
//   node scripts/check-leafkin.mjs
//
// The shipped GLB is checked for shape as the snowman's is -- the halving
// ladder over one skeleton, the whole human library with gather and run-carry
// in it, the biped extras, a bind pose on y = 0 facing +X. Then one leafkin on
// a flat field with a stand-in mouth, stand-in caps and the real hands: it is
// spawned only with her inside its roam, somewhere in the disc clear of her;
// its roam is run, never walked, stays in the disc and never beelines, and it
// chatters as it goes; a cap in reach is taken at the gather's key into the bundle, which
// fills at five; her feet within three metres scatter exactly the bundle and
// send it home, sliding round a wall on the way, and past its own cull it is
// gone the same; the village stays empty 300 s and refills only with her in
// range; and two instances stepped on different frame times agree to the bit.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Leafkin, CLIPS, LOD_TIERS, MAX, PUPPETS, SIZE_M, SIZE_VAR, ROAM_M, RETARGET_S, SEEK_M, REACH_M, GATHER_KEY,
  STARTLE_M, STARTLE_S, HOME_M, EMPTY_S, CHATTER_S, WHIMPER_S, SPAWN_CLEAR_M,
} from '../src/v2/render/leafkin.js'
import { Hands, CARRY_MAX, CARRIERS, POOL_CAP, LOOSE_MAX } from '../src/v2/hands.js'
import { CRITTER_GLB, TIER_TINTS, critterTier, cullRange, setTierTint } from '../src/v2/render/critters.js'
import { TICK_S, tickOf } from '../src/sim/score.js'
import { mulberry32 } from '../src/sim/mathx.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const swing = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const fmt = (v) => v.toFixed(2)

// --- the shipped asset ---------------------------------------------------------------
const url = CRITTER_GLB.leafkin
const file = new URL(`../public/${url}`, import.meta.url)
if (!fs.existsSync(file)) {
  console.log(` FAIL ${url} is shipped -- run tools/creatures/ship-biped.mjs\n\n1 failing -- the GLB must ship before the leafkin can be checked`)
  process.exit(1)
}
const { json, bin } = readGlb(file)
const id = 'leafkin'
const roster = CREATURES.find((c) => c.id === id)
let biped = null
{
  const meshes = json.meshes ?? []
  const names = meshes.map((m) => m.name)
  check(meshes.length === LOD_TIERS && names.join(',') === [id, ...Array.from({ length: LOD_TIERS - 1 }, (_, k) => `${id}-lod${k + 1}`)].join(','), `${id}: one mesh per rung of the ladder, the rig then lod1 up, in the one file`, names.join(','))
  const prim = meshes[0]?.primitives[0]
  const tris = meshes.map((m) => (m.primitives[0] ? json.accessors[m.primitives[0].indices].count / 3 : 0))
  // skin-ladder.mjs targets fractions of the top, and a tier that drops a whole loose piece lands under its target: the budget holds, the halving need not.
  check(tris.every((t, k) => t > 0 && t <= tris[0] / 2 ** k + 1 && (k === 0 || t < tris[k - 1])), `${id}: each rung is within its budget, the top halved per rung`, tris.join('/'))
  const skinned = (json.nodes ?? []).filter((n) => n.skin !== undefined)
  check(json.skins?.length === 1 && skinned.length === LOD_TIERS && skinned.every((n) => n.skin === 0), `${id}: ONE skeleton, worn by every rung`, `${json.skins?.[0]?.joints.length} joints`)
  const clips = (json.animations ?? []).map((a) => a.name)
  const human = fs.readdirSync(new URL('../tools/creatures/anim/clips/human/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  check(human.every((n) => clips.includes(n)) && clips.length === human.length, `${id}: the whole human clip library, ${human.length} clips`, clips.join(' '))
  check(CLIPS.every((n) => clips.includes(n)) && clips.includes('gather') && clips.includes('run-carry'), `${id}: including every clip the layer plays, the gather and the run-carry among them`, CLIPS.join(' '))
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check(Object.values(durs).every((d) => d > 0.2), `${id}: no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))
  check(Math.abs(durs['run-carry'] - durs.run) < 1e-6, `${id}: the run-carry is the run's length, so its speed is the run's`, `${durs['run-carry']?.toFixed(2)} vs ${durs.run?.toFixed(2)}`)
  biped = json.scenes?.[json.scene ?? 0]?.extras?.biped
  check(biped !== undefined && biped.span > 0 && biped.height > 0 && biped.width > 0 && biped.sizeM === roster.sizeM && biped.frame && Number.isFinite(biped.frame.yaw), `${id}: the scene carries the biped extras, at the roster's ${roster.sizeM} m`, biped && `span ${biped.span.toFixed(3)} width ${biped.width.toFixed(3)} height ${biped.height.toFixed(3)}`)
  check(biped && biped.gait.walk > 0 && biped.gait.run > biped.gait.walk && Object.keys(biped.gait).length === 2, `${id}: walk and run carry a ground speed each, walk under run`, biped && Object.entries(biped.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  const jointNames = new Set([...joints].map((j) => json.nodes[j].name))
  check(biped?.legs?.length === 2 && biped.legs.every((l) => l.chain.length >= 3 && l.chain.every((n) => jointNames.has(n))), `${id}: two legs named, hip to foot, on the skeleton's joints`)
  if (biped && prim) {
    const p = readAccessor(json, bin, prim.attributes.POSITION)
    const c = Math.cos(biped.frame.yaw), s = Math.sin(biped.frame.yaw)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      const v = [c * p[i] + s * p[i + 2] + biped.frame.t[0], p[i + 1] + biped.frame.t[1], -s * p[i] + c * p[i + 2] + biped.frame.t[2]]
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    check(Math.abs(lo[1]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[2] + hi[2]) < 1e-4, `${id}: framed, the bind pose stands on y = 0 with its feet under its middle`)
    check(Math.abs(ext[0] - biped.span) < 1e-4 && Math.abs(ext[1] - biped.height) < 1e-4 && Math.abs(ext[2] - biped.width) < 1e-4 && ext[1] > ext[2], `${id}: the extras are those extents, and it stands taller than it is wide`, ext.map((e) => e.toFixed(3)).join(' x '))
  }
  const image = json.images?.[0]
  const px = shipTexPx(roster)
  check(json.images?.length === 1 && image?.uri === `${id}.webp` && image.bufferView === undefined, `${id}: the one image is the packed WebP beside the GLB`)
  if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
    const { width, height: h } = webpSize(fs.readFileSync(new URL(image.uri, file)))
    check(width === px && h === px, `${id}: the colour map is ${px}px square`, `${width}x${h}`)
  } else check(false, `${id}: the WebP is shipped`)
}
if (!biped) {
  console.log(`\n${failures} failing -- the extras must ship before the leafkin can be checked`)
  process.exit(1)
}

// --- a stand-in asset: a slab on a skeleton of a spine and two legs, the shipped numbers ---------
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [side, sz] of [['L', 1], ['R', -1]]) {
    const hip = new THREE.Bone()
    hip.name = `Hip${side}`
    hip.position.set(0, biped.height * 0.55, sz * biped.width * 0.3)
    const knee = new THREE.Bone()
    knee.name = `Knee${side}`
    knee.position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    const foot = new THREE.Bone()
    foot.name = `Foot${side}`
    foot.position.set(-biped.height * 0.1, -biped.height * 0.26, 0)
    root.add(hip)
    hip.add(knee)
    knee.add(foot)
    bones.push(hip, knee, foot)
    legs.push({ id: side, chain: [hip.name, knee.name, foot.name] })
  }
  root.updateMatrixWorld(true)
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const tiers = Array.from({ length: LOD_TIERS }, (_, k) => {
    const g = new THREE.BoxGeometry(biped.span, biped.height, biped.width, LOD_TIERS - k, 1, 1).translate(0, biped.height / 2, 0)
    const n = g.getAttribute('position').count
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const clips = json.animations.map((a) => {
    const dur = Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))
    return new THREE.AnimationClip(a.name, dur, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])])
  })
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped, legs }
}

// --- the stand-in world: a flat field, a wall of trunks when asked, one mouth, caps where they are put ------
const GROUND = 40
const wall = { on: false, x: 10, half: 6, r: 0.5 }
const walk = {
  heightAt: () => GROUND,
  normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { out.x = 0; out.y = 1; out.z = 0; return out },
  obstacleAt(x, z, out) {
    if (!wall.on || Math.abs(x - wall.x) > wall.r || Math.abs(z) > wall.half) return null
    out.x = wall.x; out.z = z; out.r = wall.r
    return out
  },
}
const water = { isSubmerged: () => false, levelAt: () => null }
const mouth = () => ({ key: 'hollow:0,0', id: 0, blind: false, x: 0, y: GROUND, z: 0, nx: 1, nz: 0, r: 8, state: {} })
const entrancesOf = (...list) => ({ list, sites(into) { into.push(...this.list); return into } })

const capGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2).translate(0, 0.1, 0)
capGeo.setAttribute('aPropFade', new THREE.InstancedBufferAttribute(new Float32Array(4).fill(1), 1))
const capMat = new THREE.MeshBasicMaterial()
const CAP_SPAN = 0.2
/** Caps at fixed spots, the mushrooms' pickAt/take shape over instance arrays. */
class Caps {
  constructor(spots) {
    this.instX = Float32Array.from(spots, (s) => s[0])
    this.instY = new Float32Array(spots.length).fill(GROUND)
    this.instZ = Float32Array.from(spots, (s) => s[1])
    this.alive = new Set(spots.map((_, i) => i))
    this.taken = []
  }
  pickAt(x, y, z, reach) {
    let best = null, bestD = reach
    for (const id of this.alive) {
      const d = Math.hypot(this.instX[id] - x, this.instY[id] + CAP_SPAN / 2 - y, this.instZ[id] - z) - CAP_SPAN / 2
      if (d < bestD) { bestD = d; best = { dist: Math.max(0, d), id, tile: null, k: 0, size: CAP_SPAN } }
    }
    return best
  }
  take(hit) {
    if (!this.alive.delete(hit.id)) throw new Error(`Caps.take: ${hit.id} is not standing`)
    this.taken.push(hit.id)
    return { kind: 'mushroom', name: 'cap', size: CAP_SPAN, geometry: capGeo, material: capMat, color: null, scale: [1, 1, 1], stowable: true }
  }
}
const handsOf = () => new Hands(new THREE.Scene(), { walk, water, haptic() {}, stow: () => false, thud() {}, rand: mulberry32(5) })

const T0 = 1000
const FAR = { x: 300, y: GROUND, z: 0 }
const head = (feet) => ({ x: feet.x, y: feet.y + 1.6, z: feet.z })
const make = ({ entrances = entrancesOf(mouth()), mushrooms = null, hands = null } = {}) =>
  new Leafkin(new THREE.Scene(), water, { walk, entrances, mushrooms, hands, asset: makeAsset() })
/** Drive `w` for `seconds` at 60 Hz from world time `t`, her feet at `feet`; `each(c, t)` after every frame. Returns the time reached. */
function run(w, t, seconds, feet, each = null) {
  const frames = Math.round(seconds * 60)
  for (let i = 0; i < frames; i++) {
    t += 1 / 60
    w.update(feet, head(feet), t, 1 / 60)
    if (each) each(w.byKey.values().next().value, t)
  }
  return t
}
const one = (w) => w.byKey.values().next().value
/** A spawned leafkin moved onto the mouth point, for the tests that set caps and walls about it. */
const atMouth = (c) => { c.x = c.px = 0; c.z = c.pz = 0; return c }

// --- construction ---------------------------------------------------------------
console.log('\nconstruction')
{
  const w = make()
  check(w.loaded && w.asset.height === biped.height && w.asset.gait.run === biped.gait.run, 'the leafkin is loaded, with its extras spread on the asset')
  check(w.puppets.length === PUPPETS && w.slots.length === MAX && w.free.length === MAX && w.byKey.size === 0, `${PUPPETS} puppets and ${MAX} slots, none out`)
  check(w.materials.length === PUPPETS * 2 + 1 && w.puppetMats.every((m) => m.plain === w.plain), 'ONE settled material and a fade pair a puppet')
  let threw = 0
  for (const bad of [
    () => new Leafkin(new THREE.Scene(), {}, { walk, entrances: entrancesOf(), asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), water, { walk: { heightAt: walk.heightAt }, entrances: entrancesOf(), asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), water, { walk, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), water, { walk, entrances: entrancesOf(), mushrooms: { pickAt() {} }, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), water, { walk, entrances: entrancesOf(), hands: {}, asset: makeAsset() }),
    () => new Leafkin(new THREE.Scene(), water, { walk, entrances: entrancesOf(), asset: { ...makeAsset(), clips: [] } }),
  ]) { try { bad() } catch { threw++ } }
  check(threw === 6, 'no water, a half walk surface, no entrances, half mushrooms, hands without carry() and an asset short of a clip are each refused', `${threw} of 6`)
}

// --- the spawn ------------------------------------------------------------------
console.log('\nthe spawn')
{
  const w = make()
  let t = run(w, T0, 1, FAR)
  check(w.byKey.size === 0 && w.spawned === 0, `her feet ${FAR.x} m off, the village sends nobody out`)
  const near = { x: 80, y: GROUND, z: 0 }
  w.update(near, head(near), t += 1 / 60, 1 / 60)
  const c = one(w)
  const off = c && Math.hypot(c.x, c.z), fromHer = c && Math.hypot(c.x - near.x, c.z - near.z)
  check(w.byKey.size === 1 && c && off > 1 && off <= ROAM_M && fromHer >= SPAWN_CLEAR_M && c.y === GROUND, `inside ${ROAM_M} m, a leafkin stands somewhere in the disc, ${SPAWN_CLEAR_M} m clear of her`, c && `${fmt(off)} m from the mouth, ${fmt(fromHer)} m from her`)
  check(c && Math.abs(swing(c.heading, 0)) > 1e-3, 'facing whichever way', c && `${fmt(c.heading)}`)
  check(c && c.tick === tickOf(t) && c.state === 'roam' && c.clip === 'run' && c.speed > 0, 'on the world clock\'s tick, roaming at the run', c && `${c.state} ${c.clip}`)
  check(c && Math.abs(c.size - SIZE_M) <= SIZE_M * SIZE_VAR + 1e-9 && Math.abs(c.k - c.size / biped.height) < 1e-12, `a metre tall, give or take ${SIZE_VAR * 100}%, wearing the scale that makes it so`, c && `${fmt(c.size)} m`)
  check(c && c.lod === LOD_TIERS && c.puppet === null && w.bodies([]).length === 0, `${fmt(fromHer)} m off it is minded and not drawn: past its cull of ${fmt(cullRange(c.size))} m`)
  const spots = new Set()
  for (let i = 0; i < 6; i++) {
    const v = make()
    v.update(near, head(near), T0 + i * 7, 1 / 60)
    const d = one(v)
    spots.add(`${fmt(d.x)},${fmt(d.z)}`)
    v.dispose()
  }
  check(spots.size === 6, 'another spawn tick, another spot', [...spots].join('  '))
  const sizes = new Set()
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const v = make({ entrances: entrancesOf({ ...mouth(), key }) })
    v.update(near, head(near), T0, 1 / 60)
    sizes.add(one(v).size)
    v.dispose()
  }
  check(sizes.size === 6, 'another site, another size', [...sizes].map(fmt).join(' '))
  // The site gone from the entrances takes its leafkin with it.
  w.entrances.list.length = 0
  w.update(near, head(near), t += 1 / 60, 1 / 60)
  check(w.byKey.size === 0 && w.free.length === MAX, 'and the site evicted, the slot is back')
  w.dispose()
}

// --- the roam ---------------------------------------------------------------------
console.log('\nthe roam')
{
  const w = make()
  const feet = { x: 80, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = one(w)
  let far = 0, legs = 0, straight = 0, path = 0, off = 0, wob = 0, ticks = 0, lastTick = c.tick, lx = c.x, lz = c.z
  let tx = c.tx, tz = c.tz, legX = c.x, legZ = c.z
  let minRetarget = Infinity, maxRetarget = 0, legT = t
  const clips = new Set()
  t = run(w, t, 180, feet, (c, now) => {
    far = Math.max(far, Math.hypot(c.x, c.z))
    if (c.tick !== lastTick) {
      ticks++
      lastTick = c.tick
      path += Math.hypot(c.x - lx, c.z - lz)
      lx = c.x; lz = c.z
      if (Math.abs(swing(c.heading, Math.atan2(-(c.tz - c.z), c.tx - c.x))) > (10 * Math.PI) / 180) off++
      wob += Math.abs(c.wob)
    }
    clips.add(c.clip)
    if (c.tx !== tx || c.tz !== tz) {
      legs++
      straight += Math.hypot(c.x - legX, c.z - legZ)
      legX = c.x; legZ = c.z; tx = c.tx; tz = c.tz
      minRetarget = Math.min(minRetarget, now - legT)
      maxRetarget = Math.max(maxRetarget, now - legT)
      legT = now
    }
  })
  check(c.state === 'roam' && far <= ROAM_M + 1, `three minutes of roaming stays inside the ${ROAM_M} m disc`, `out to ${fmt(far)} m`)
  check(legs >= 180 / RETARGET_S[1] - 1 && legs <= 180 / RETARGET_S[0] + 1 && minRetarget >= RETARGET_S[0] - 0.1 && maxRetarget <= RETARGET_S[1] + 0.1, `a new target every ${RETARGET_S[0]}-${RETARGET_S[1]} s`, `${legs} legs, ${fmt(minRetarget)}-${fmt(maxRetarget)} s`)
  check(off / ticks > 0.3 && path > straight * 1.08, 'and it never beelines: the heading is off the bearing more than a third of the time, and the path is longer than its legs', `off ${(100 * off / ticks).toFixed(0)}% of ${ticks} ticks, the wander ${((wob / ticks) * 180 / Math.PI).toFixed(0)}° on average, ${fmt(path)} m walked over ${fmt(straight)} m of legs`)
  check(path > 0.9 * biped.gait.run * c.k * 180 * 0.6 && !clips.has('walk') && clips.has('run'), 'at the run, never the walk', `${fmt(path / 180)} m/s of ${fmt(biped.gait.run * c.k)}, clips ${[...clips].join(' ')}`)
  const voices = w.voices([])
  check(voices.length > 0 && w.voices([]).length === 0, 'its voices wait for the ear, which drains them', `${voices.length} waiting`)
  w.dispose()
}
{
  // Chatter: counted by an ear.
  const w = make()
  const feet = { x: 80, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const said = []
  t = run(w, t, 120, feet, () => w.voices(said))
  const chatter = said.filter((v) => v.sound.startsWith('leafkinChatter'))
  check(chatter.length >= 120 / CHATTER_S[1] - 1 && chatter.length <= 120 / CHATTER_S[0] + 1 && chatter.length === said.length, `it chatters every ${CHATTER_S[0]}-${CHATTER_S[1]} s and says nothing else roaming`, `${chatter.length} in 120 s: ${[...new Set(chatter.map((v) => v.sound))].sort().join(' ')}`)
  check(new Set(chatter.map((v) => v.sound)).size >= 3, 'in more than one voice')
  check(chatter.every((v) => Math.abs(v.y - GROUND) < 1 && Math.hypot(v.x, v.z) <= ROAM_M), 'each from where it stands')
  check(w.bodies([]).length === 0, 'the roam 80 m off is not drawn')
  w.dispose()
}

// --- the gather ------------------------------------------------------------------
console.log('\nthe gather')
{
  const hands = handsOf()
  const caps = new Caps([[2, 0]])
  const w = make({ mushrooms: caps, hands })
  const feet = { x: 30, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = atMouth(one(w))
  const said = []
  let bundleAt = null, tookAt = null
  t = run(w, t, 6, feet, (c, now) => {
    w.voices(said)
    if (c.bundle === 1 && bundleAt === null) { bundleAt = { t: now, clip: c.clip, into: c.dur - c.left }; tookAt = c.dur - c.left }
  })
  check(caps.taken.length === 1 && c.bundle === 1 && c.carrier && c.carrier.count() === 1, 'the cap two metres off is taken into the bundle', `${caps.taken.length} taken, bundle ${c.bundle}`)
  // Seen a frame on, the clip is a tick past the take.
  check(bundleAt && bundleAt.clip === 'gather' && tookAt >= GATHER_KEY * w.durations.gather - TICK_S && tookAt <= GATHER_KEY * w.durations.gather + 2 * TICK_S, `at the gather's key, ${GATHER_KEY} of the clip`, bundleAt && `${fmt(bundleAt.into)} s into the ${fmt(w.durations.gather)} s clip`)
  check(said.filter((v) => v.sound === 'leafkinSqueal').length === 1, 'with one squeal of delight', `${said.map((v) => v.sound).join(' ')}`)
  check(c.state === 'roam' && c.clip === 'run-carry' && Math.abs(c.speed - biped.gait.run * c.k) < 1e-12, 'then the roam again, at the run-carry, which runs at the run', `${c.state} ${c.clip} ${fmt(c.speed)}`)
  check(hands.stats.pools === 1 && hands.pools.values().next().value.items.length === 1 && hands.loose.length === 0, 'the cap is drawn from the hands\' pool and is not loose')
  const item = hands.pools.values().next().value.items[0]
  check(item.state === 'carried' && Math.hypot(item.x - c.pose.x, item.z - c.pose.z) < 0.5 && item.y > c.pose.y + 0.3 && item.y < c.pose.y + c.size, 'carried at its chest', `${fmt(item.x - c.pose.x)}, ${fmt(item.y - c.pose.y)}, ${fmt(item.z - c.pose.z)}`)
  // Five more within reach, one after another: the bundle fills at CARRY_MAX and the sixth stands.
  for (let i = 0; i < CARRY_MAX; i++) {
    caps.instX = Float32Array.from([c.x + 1.5 * Math.cos(c.heading)]); caps.instZ = Float32Array.from([c.z - 1.5 * Math.sin(c.heading)]); caps.instY = Float32Array.from([GROUND])
    caps.alive = new Set([0])
    t = run(w, t, 5, feet)
  }
  check(c.bundle === CARRY_MAX && c.carrier.count() === CARRY_MAX && caps.taken.length === CARRY_MAX && caps.alive.size === 1, `the bundle fills at ${CARRY_MAX} and the next cap is left standing`, `bundle ${c.bundle}, ${caps.taken.length} taken, ${caps.alive.size} standing`)
  check(hands.pools.values().next().value.items.length === CARRY_MAX && POOL_CAP - LOOSE_MAX >= CARRY_MAX * CARRIERS + 3, `the pool holds every carried thing beside the loose and the held`, `${POOL_CAP}`)
  w.dispose()
  check(hands.carriers === 0 && hands.pools.values().next().value.items.length === 0, 'the layer disposed, the carrier and its things are gone')
}

// --- the startle and the flight ------------------------------------------------------
console.log('\nthe startle')
{
  const hands = handsOf()
  const caps = new Caps([[2, 0], [2.5, 0.4], [3, -0.4]])
  const w = make({ mushrooms: caps, hands })
  const feet = { x: 30, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = atMouth(one(w))
  const said = []
  t = run(w, t, 12, feet, () => w.voices(said))
  check(c.bundle === 3, 'three caps in the arms', `${c.bundle}`)
  // Carried 25 m out, so the run home is long enough to whimper on. Her feet step to within STARTLE_M of its own: on the next tick it is startled.
  c.x = c.px = 25; c.z = c.pz = 0
  const at = { x: c.x + STARTLE_M - 0.5, y: GROUND, z: c.z }
  said.length = 0
  const x0 = c.x, z0 = c.z
  let hold = null
  t = run(w, t, 0.2, at, (c, now) => { w.voices(said); if (c.state === 'startle' && hold === null) hold = now })
  check(hold !== null && hold - t <= -0.2 + TICK_S + 1 / 60 + 1e-9 && c.state === 'startle' && c.clip === 'recoil' && c.speed === 0, `her feet within ${STARTLE_M} m of its own and on the next tick it recoils`, `${c.state} ${c.clip}, ${hold && fmt(hold - t + 0.2)} s on`)
  check(c.bundle === 0 && c.carrier.count() === 0 && hands.loose.length === 3 && hands.loose.every((i) => i.state === 'fall' && !i.mine && i.netId === null), 'the bundle is scattered: exactly the three caps, falling, loose, and nobody\'s to the room', `${hands.loose.length} loose`)
  check(said.length === 1 && said[0].sound === 'leafkinScream', 'with a scream', said.map((v) => v.sound).join(' '))
  check(!c.pose.pant, 'and the panting stops')
  let fleeAt = null, faced = NaN
  t = run(w, t, STARTLE_S, at, (c, now) => { w.voices(said); if (c.state === 'flee' && fleeAt === null) { fleeAt = now; faced = c.heading } })
  check(Math.abs(swing(faced, 0)) < 0.05, 'it has turned to face her by the time it runs', `${fmt(faced)}`)
  check(fleeAt !== null && Math.abs(fleeAt - hold - STARTLE_S) <= TICK_S + 1 / 60 && c.state === 'flee' && c.clip === 'run', `${STARTLE_S} s later it runs`, `${fleeAt && fmt(fleeAt - hold)} s`)
  check(c.pose.pant, 'panting')
  const home = Math.hypot(x0, z0)
  const runS = home / (biped.gait.run * c.k)
  let gone = null
  said.length = 0
  let farthest = 0
  t = run(w, t, runS * 1.5 + 2, at, (c, now) => { w.voices(said); if (c) farthest = Math.max(farthest, Math.hypot(c.x - x0, c.z - z0)); else if (gone === null) gone = now })
  check(w.byKey.size === 0 && gone !== null && gone - fleeAt < runS * 1.3 + 0.5, `it reaches the mouth ${fmt(home)} m off within the run's time and is gone`, `${gone && fmt(gone - fleeAt)} s of ${fmt(runS)}`)
  check(farthest <= home + 0.5, 'straight there', `${fmt(farthest)} m of ${fmt(home)}`)
  const site = w.entrances.list[0]
  check(Math.abs(site.state.emptyUntil - (gone + EMPTY_S)) < 1 / 60 + TICK_S, `the village is empty ${EMPTY_S} s from then`, `${fmt(site.state.emptyUntil - gone)}`)
  const whimpers = said.filter((v) => v.sound === 'leafkinWhimper')
  check(whimpers.length >= 1 && whimpers.length === said.length && whimpers.length <= (gone - fleeAt) / WHIMPER_S[0] + 1, `it whimpers every ${WHIMPER_S[0]}-${WHIMPER_S[1]} s on the way and says nothing else`, `${whimpers.length} in ${fmt(gone - fleeAt)} s`)
  check(hands.carriers === 0, 'the carrier is handed back')
  // Empty: nobody comes out while the cooldown runs, nor after it with her outside the roam; inside it, a fresh one.
  t = run(w, t, 10, at)
  check(w.byKey.size === 0, 'the village sends nobody out while it lies empty')
  t = site.state.emptyUntil + 1
  w.update(FAR, head(FAR), t, 1 / 60)
  check(w.byKey.size === 0, `nor after the ${EMPTY_S} s with her ${FAR.x} m off`)
  w.update(at, head(at), t += 1 / 60, 1 / 60)
  check(w.byKey.size === 1 && Math.hypot(one(w).x, one(w).z) <= ROAM_M && one(w).state === 'roam', 'and with her inside the roam, a fresh leafkin in the disc', `${w.byKey.size}`)
  w.dispose()
}

// --- the slide round a wall --------------------------------------------------------
console.log('\nthe wall')
{
  const w = make()
  const feet = { x: 30, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = one(w)
  // Planted 20 m out with a wall of trunks across the line home, and her on its heels.
  c.x = c.px = 20; c.z = c.pz = 0
  wall.on = true
  const at = { x: 22, y: GROUND, z: 0 }
  let gone = null, farthest = 0, nearest = Infinity
  t = run(w, t, 60, at, (c, now) => {
    if (!c) { if (gone === null) gone = now; return }
    farthest = Math.max(farthest, Math.abs(c.z))
    if (Math.abs(c.x - wall.x) <= wall.r) nearest = Math.min(nearest, Math.abs(c.z))
  })
  wall.on = false
  check(gone !== null, 'it gets home round the wall', gone ? `${fmt(gone - t + 60)} s` : 'never')
  check(farthest > wall.half && nearest >= wall.half - 0.05, 'by sliding along it to its end, never through it', `out to z ${fmt(farthest)}, past the wall\'s line at ${fmt(nearest)}`)
  w.dispose()
}

// --- lost to the cull ---------------------------------------------------------------
console.log('\nthe cull')
{
  const w = make()
  const feet = { x: 30, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = one(w)
  const cull = cullRange(c.size)
  c.x = c.px = cull + 30; c.z = c.pz = 0
  const at = { x: c.x + 2, y: GROUND, z: 0 }
  let gone = null, lastX = c.x
  t = run(w, t, 60, at, (c, now) => { if (c) lastX = c.x; else if (gone === null) gone = now })
  check(gone !== null && lastX < at.x - cull && lastX > at.x - cull - 1, `fleeing out past its own cull of ${fmt(cull)} m it is gone the same`, `last seen ${fmt(at.x - lastX)} m off`)
  check(w.entrances.list[0].state.emptyUntil > gone, 'and the village is empty for it')
  w.dispose()
}

// --- drawn within the cull ----------------------------------------------------------
console.log('\nthe puppet')
{
  const w = make()
  const feet = { x: 10, y: GROUND, z: 0 }
  let t = T0
  w.update(feet, head(feet), t, 1 / 60)
  const c = atMouth(one(w))
  t = run(w, t, 0.5, feet)
  const dist = Math.hypot(c.pose.x - 10, c.pose.y - GROUND - 1.6, c.pose.z)
  check(c.puppet !== null && c.lod < LOD_TIERS && c.lod === critterTier(c.size, dist, LOD_TIERS, LOD_TIERS) && w.bodies([]).length === 1 && w.bodies([])[0] === c.pose, 'ten metres off it wears a puppet on the ladder\'s rung for that distance, and the ear is given its frame pose', `rung ${c.lod} at ${fmt(dist)} m`)
  const b = w.bodies([])[0]
  check(b.clip === 'run' && b.speed === c.speed && b.cycle === w.durations.run && b.size === c.size && b.pant, 'with the clip, its cycle, the speed and the size on it, panting')
  check(Math.abs(c.pose.x - c.x) <= c.speed * TICK_S + 1e-9 && c.alpha >= 0 && c.alpha <= 1, 'the frame\'s pose lies between the last two ticks', `alpha ${fmt(c.alpha)}`)
  check(c.puppet.group.matrix.elements[12] === c.pose.x && c.puppet.group.matrix.elements[13] === c.pose.y, 'and the puppet stands on it')
  setTierTint(true)
  t = run(w, t, 0.5, feet)
  const shown = c.puppet.meshes.filter((m) => m.visible)
  check(shown.length === 1 && shown[0].material === TIER_TINTS[c.lod], 'under the critter LOD tint row it wears its rung\'s flat colour like every other creature', `rung ${c.lod}`)
  setTierTint(false)
  t = run(w, t, 0.5, feet)
  check(c.puppet.meshes.filter((m) => m.visible)[0].material === w.plain, 'and its own skin again with the row off')
  w.dispose()
}

// --- two instances agree ---------------------------------------------------------------
console.log('\ntwo instances agree')
{
  const feet = { x: 30, y: GROUND, z: 0 }
  const a = make({ mushrooms: new Caps([[2, 0], [3, 1], [6, -2]]) })
  const b = make({ mushrooms: new Caps([[2, 0], [3, 1], [6, -2]]) })
  let ta = T0, tb = T0
  a.update(feet, head(feet), ta, 1 / 60)
  b.update(feet, head(feet), tb, 1 / 60)
  atMouth(one(a)); atMouth(one(b))
  const rand = mulberry32(9)
  let compared = 0, same = 0
  for (let i = 0; i < 60 * 90; i++) {
    ta += 1 / 60
    a.update(feet, head(feet), ta, 1 / 60)
    while (tb < ta - 1e-9) {
      const dt = Math.min(ta - tb, 1 / 30 + rand() / 45)
      tb += dt
      b.update(feet, head(feet), tb, dt)
    }
    const ca = one(a), cb = one(b)
    if (ca.tick !== cb.tick) continue
    compared++
    if (ca.x === cb.x && ca.z === cb.z && ca.heading === cb.heading && ca.state === cb.state && ca.bundle === cb.bundle && ca.clip === cb.clip && ca.cue === cb.cue && ca.tx === cb.tx) same++
  }
  check(compared > 60 * 80 && same === compared, 'stepped on different frame times, two instances hold the same pose, state, clip and bundle on every shared tick, to the bit', `${same} of ${compared}`)
  check(one(a).bundle >= 2 && one(a).bundle === one(b).bundle, 'and both gathered the same caps', `${one(a).bundle} / ${one(b).bundle}`)
  a.dispose()
  b.dispose()
}

console.log(failures ? `\n${failures} FAILED` : '\nall leafkin checks passed')
process.exit(failures ? 1 : 0)
