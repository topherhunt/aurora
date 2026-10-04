// Node-side gates for the abominable snowmen (src/v2/render/snowmen.js).
//
//   node scripts/check-snowmen.mjs
//
// The scatter runs against a synthetic mountain: a rolling shoulder above the
// snow line, a tarn in a basin, a crag too steep to stand on, two tree trunks,
// and a long slope falling out of the snow at the near edge. Everything below
// is a way a snowman can go wrong without anything throwing: a scatter that is
// not one per 40,000 square metres of ground above the snow line, that puts one
// below it, or that is not the same twice; one standing in the tarn, up the
// crag or inside a trunk; one under 2 m or over 6 m; one found doing anything
// but cowering, or that cowers on with her in its face; one that notices her
// from too far, that does not turn to her, that follows her while she comes
// closer or fails to when she backs off, that walks through her, that will not
// run, that skates, or that does not walk home once it has forgotten her; one
// that snaps to a heading; one lost with its tile while it was still following
// her, or laid twice because it was; a frame that costs more than a scatter is
// allowed to. And the room (_notes/creature-sync.md): two clients on different
// frame rates that do not step the same ticks to the same pose, a gesture that
// is not closed-form in the key and the tick, an authority that does not owe an
// anchor a second or its rejoin, a joiner that does not land on the anchor or
// stay with it, a peer's snowman that notices a player on its own, a skip that
// is replayed. The shipped GLB is checked for shape too -- the halving ladder
// over the one skeleton, the human clip library, the biped extras, and a bind
// pose that stands on y = 0 facing +X -- because the world loads it by name and
// builds every puppet from it.
//
// What this can NOT check: whether it is unsettling. That needs eyes, in the
// world, at night.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Snowmen, CLIPS, PLANTED, TILE, RADIUS, DENSITY, LOD_TIERS, MAX, PUPPETS, SIZE_M, MAX_SLOPE, FOLLOW_SLOPE,
  NOTICE_M, AWAY_M, STANDOFF_M, RESUME_M, RUN_M, FORGET_M, HOME_M, TURN_RATE, ANCHOR_S, ANCHOR_STALE_S, COWER_ACTS, WATCH_ACTS,
} from '../src/v2/render/snowmen.js'
import { CATCH_UP_TICKS, CHAPTER_S, TICK_HZ, TICK_S, chapterOf, tickOf } from '../src/sim/score.js'
import { CRITTER_GLB, LOD_HYSTERESIS, critterTier, cullRange, lodReach } from '../src/v2/render/critters.js'
import { LOD_FADE_S, REPLANT } from '../src/v2/render/puppet.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'
import { setPuppetMode } from '../src/v2/render/baked-puppet.js'

// These gates read the skinned Puppet's own parts (its bones, its IK, its tier meshes); check-baked-puppet.mjs covers the baked body.
setPuppetMode('skinned')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}
const swing = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

// --- the synthetic mountain ---------------------------------------------------------
const SNOW_LINE = 30
// The shoulder sits this far above the snow line.
const GROUND = SNOW_LINE + 10
// The ground falls this steeply toward -z past SLOPE_Z, so it drops through SNOW_LINE at SNOW_Z while staying far gentler than MAX_SLOPE.
const SLOPE_Z = -20
const SLOPE = 0.35
const SNOW_Z = SLOPE_Z - (GROUND - SNOW_LINE) / SLOPE
// A cone nine metres up over seven across: every face of it is 52 degrees.
const CRAG = { x: -36, z: 18, r: 7, h: 9 }
// A basin two metres deep, its water a hand over the rim's foot.
const TARN = { x: 40, z: 24, r: 9, depth: 2, level: GROUND + 0.3 }
const TRUNKS = [{ x: 6, z: 6, r: 0.9 }, { x: -14, z: 30, r: 1.4 }]

const conical = (c, x, z) => Math.max(0, 1 - Math.hypot(x - c.x, z - c.z) / c.r)
function fieldAt(x, z) {
  let h = GROUND + 0.6 * Math.sin(x * 0.05) * Math.cos(z * 0.045)
  h += CRAG.h * conical(CRAG, x, z)
  h -= TARN.depth * conical(TARN, x, z)
  if (z < SLOPE_Z) h -= SLOPE * (SLOPE_Z - z)
  return h
}
const walkOn = (heightAt) => ({
  heightAt,
  normalAt(x, z, eps = 0.25, out = { x: 0, y: 1, z: 0 }) {
    const dx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (2 * eps)
    const dz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (2 * eps)
    const len = Math.hypot(dx, 1, dz)
    out.x = -dx / len; out.y = 1 / len; out.z = -dz / len
    return out
  },
  obstacleAt(x, z, out) {
    for (const t of TRUNKS) {
      if (Math.hypot(x - t.x, z - t.z) > t.r) continue
      out.x = t.x; out.z = t.z; out.r = t.r
      return out
    }
    return null
  },
})
const walk = walkOn(fieldAt)
const height = { snowLineAt: () => SNOW_LINE }
const water = { isSubmerged: (x, z, y) => Math.hypot(x - TARN.x, z - TARN.z) < TARN.r && y < TARN.level }

// The same shoulder with nothing on it, above the snow and below it, for counting the scatter's rate against its own area.
const plainAt = (h) => ({ heightAt: () => h, normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { out.x = 0; out.y = 1; out.z = 0; return out }, obstacleAt: () => null })
const plain = plainAt(GROUND)
const noWater = { isSubmerged: () => false }

// --- the shipped asset ---------------------------------------------------------------
const url = CRITTER_GLB.snowman
const file = new URL(`../public/${url}`, import.meta.url)
if (!fs.existsSync(file)) {
  console.log(` FAIL ${url} is shipped -- run tools/creatures/ship-biped.mjs\n\n1 failing -- the GLB must ship before the scatter can be checked`)
  process.exit(1)
}
const { json, bin } = readGlb(file)
const id = url.replace(/^creatures\//, '').replace(/\.glb$/, '')
const roster = CREATURES.find((c) => c.id === id)
let biped = null
{
  const meshes = json.meshes ?? []
  const names = meshes.map((m) => m.name)
  check(meshes.length === LOD_TIERS && names.join(',') === [id, ...Array.from({ length: LOD_TIERS - 1 }, (_, k) => `${id}-lod${k + 1}`)].join(','), `${id}: one mesh per rung of the ladder, the rig then lod1 up, in the one file`, names.join(','))
  const prim = meshes[0]?.primitives[0]
  const tris = meshes.map((m) => (m.primitives[0] ? json.accessors[m.primitives[0].indices].count / 3 : 0))
  check(tris.every((t, k) => k === 0 || Math.abs(t - tris[k - 1] / 2) <= 1), `${id}: each rung is half the triangles of the one above`, tris.join('/'))
  check(meshes.every((m) => m.primitives.length === 1 && m.primitives[0].attributes.JOINTS_0 !== undefined && m.primitives[0].attributes.WEIGHTS_0 !== undefined && m.primitives[0].attributes.NORMAL !== undefined && m.primitives[0].attributes.TEXCOORD_0 !== undefined && m.primitives[0].material === 0), `${id}: every rung is skinned, one primitive, on the one material`)
  const skinned = (json.nodes ?? []).filter((n) => n.skin !== undefined)
  check(json.skins?.length === 1 && skinned.length === LOD_TIERS && skinned.every((n) => n.skin === 0), `${id}: ONE skeleton, worn by every rung`, `${json.skins?.[0]?.joints.length} joints`)

  const clips = (json.animations ?? []).map((a) => a.name)
  const human = fs.readdirSync(new URL('../tools/creatures/anim/clips/human/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  check(human.every((n) => clips.includes(n)) && clips.length === human.length, `${id}: the whole human clip library, ${human.length} clips`, clips.join(' '))
  check(CLIPS.every((n) => clips.includes(n)), `${id}: including every clip the layer plays`, CLIPS.join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  check((json.animations ?? []).every((a) => a.channels.every((ch) => joints.has(ch.target.node))), `${id}: every clip channel targets a joint of the skeleton`)
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check((json.animations ?? []).every((a) => a.samplers.every((s) => json.accessors[s.input].min !== undefined)) && Object.values(durs).every((d) => d > 0.2), `${id}: every sampler carries min and max, and no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))

  biped = json.scenes?.[json.scene ?? 0]?.extras?.biped
  check(biped !== undefined && biped.span > 0 && biped.height > 0 && biped.width > 0 && biped.sizeM === roster.sizeM && biped.frame && Number.isFinite(biped.frame.yaw), `${id}: the scene carries the biped extras, at the roster's ${roster.sizeM} m`, biped && `span ${biped.span.toFixed(3)} width ${biped.width.toFixed(3)} height ${biped.height.toFixed(3)} yaw ${biped.frame.yaw.toFixed(3)}`)
  check(biped && biped.gait.walk > 0 && biped.gait.run > biped.gait.walk && Object.keys(biped.gait).length === 2, `${id}: walk and run carry a ground speed each, walk under run, and nothing else does`, biped && Object.entries(biped.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))
  const jointNames = new Set([...joints].map((j) => json.nodes[j].name))
  check(biped?.legs?.length === 2 && biped.legs.every((l) => l.chain.length >= 3 && l.chain.every((n) => jointNames.has(n))), `${id}: two legs named, hip to foot, every joint of every chain one of the skeleton's -- the puppet's foot IK reads its feet off them`, biped?.legs && biped.legs.map((l) => `${l.id} ${l.chain.length}`).join(' '))

  // The bind pose IS the POSITION accessor, so the frame the root joint carries can be checked by applying it: the body stands on y = 0, centred over its feet, facing +X.
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
    check(Math.abs(lo[1]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[2] + hi[2]) < 1e-4, `${id}: framed, the bind pose stands on y = 0 with its feet under its middle`, `y from ${lo[1].toExponential(2)}, mid x ${((lo[0] + hi[0]) / 2).toExponential(2)} z ${((lo[2] + hi[2]) / 2).toExponential(2)}`)
    check(Math.abs(ext[0] - biped.span) < 1e-4 && Math.abs(ext[1] - biped.height) < 1e-4 && Math.abs(ext[2] - biped.width) < 1e-4 && ext[1] > ext[2] && ext[2] > ext[0], `${id}: the extras are those extents, and the body is taller than it is wide and wider than it is deep -- it stands, facing +X`, `${ext.map((e) => e.toFixed(3)).join(' x ')}`)
  }

  const image = json.images?.[0]
  const px = shipTexPx(roster)
  check(json.images?.length === 1 && image?.uri === `${id}.webp` && image.bufferView === undefined, `${id}: the one image is the packed WebP beside the GLB`, JSON.stringify(json.images))
  if (image?.uri && fs.existsSync(new URL(image.uri, file))) {
    const { width, height: h } = webpSize(fs.readFileSync(new URL(image.uri, file)))
    check(width === px && h === px, `${id}: the colour map is ${px}px square`, `${width}x${h}`)
  } else check(false, `${id}: the WebP is shipped`)
  check(json.extensionsRequired?.includes('EXT_texture_webp') && json.textures?.[0]?.extensions?.EXT_texture_webp?.source === 0, `${id}: the texture declares EXT_texture_webp`)
  const pbr = json.materials?.[0]?.pbrMetallicRoughness
  check(json.materials?.length === 1 && pbr?.metallicFactor === 0 && pbr.roughnessFactor === 1 && json.materials[0].normalTexture === undefined, `${id}: one matte material, colour only`)
}
if (!biped) {
  console.log(`\n${failures} failing -- the extras must ship before the scatter can be checked`)
  process.exit(1)
}

// --- a stand-in asset: a slab on a skeleton of a spine and two legs, the shipped numbers ---------
// A leg is hip, knee, foot: the hip under a side of the body, the knee bent forward, the foot a hair over the ground, so the puppet's foot IK has a bend to work.
const LEG_HIP_Y = 0.55
const LEG_FOOT_Y = 0.02
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  const bones = [root, spine]
  const legs = []
  for (const [id, sz] of [['L', 1], ['R', -1]]) {
    const hip = new THREE.Bone()
    hip.name = `Hip${id}`
    hip.position.set(0, biped.height * LEG_HIP_Y, sz * biped.width * 0.3)
    const knee = new THREE.Bone()
    knee.name = `Knee${id}`
    knee.position.set(biped.height * 0.1, -biped.height * 0.27, 0)
    const foot = new THREE.Bone()
    foot.name = `Foot${id}`
    foot.position.set(-biped.height * 0.1, -biped.height * (LEG_HIP_Y - 0.27 - LEG_FOOT_Y), 0)
    root.add(hip)
    hip.add(knee)
    knee.add(foot)
    bones.push(hip, knee, foot)
    legs.push({ id, chain: [hip.name, knee.name, foot.name] })
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
const STAND_IN_BONES = 2 + 2 * 3

// --- construction ---------------------------------------------------------------
const scene = new THREE.Scene()
const make = (seed, world = { walk, water, height }) =>
  new Snowmen(scene, world.height, world.water, { seed, walk: world.walk, asset: makeAsset() })
const w = make(7)
check(w.loaded && w.asset.height === biped.height && w.asset.gait.run === biped.gait.run, 'the snowman is loaded, with its extras spread on the asset')
check(w.puppets.length === PUPPETS && w.freePuppets.length === PUPPETS && w.slots.length === MAX && w.free.length === MAX, `${PUPPETS} puppets and ${MAX} slots, all free`)
check(w.materials.length === PUPPETS * 2 + 1, 'ONE settled material between them all and a dissolving pair -- in, out -- a puppet, all offered to the lighting')
check(w.puppetMats.every((m) => m.plain === w.plain) && w.puppetMats.length === PUPPETS, 'every snowman standing draws through THE ONE material, so a drawn crowd is one material change a frame and not one a snowman')
check(w.puppetMats.every((m) => m.plain.customProgramCacheKey() === 'snowmen' && m.in.customProgramCacheKey() === 'snowmen-fade' && m.out.customProgramCacheKey() === 'snowmen-fade') && new Set(w.materials.map((m) => m.customProgramCacheKey())).size === 2, 'two programs and not one a puppet')
check(w.batch.name === 'v2-snowmen' && w.batch.children.length === 0, 'nothing is in the batch but the puppets it lends out')
check(w.puppets.every((p) => p.skeleton !== w.asset.skeleton && p.skeleton.bones.length === STAND_IN_BONES && p.meshes.length === LOD_TIERS && p.meshes.every((m) => m.skeleton === p.skeleton && !m.visible) && !p.group.matrixAutoUpdate && p.actions.size === json.animations.length), 'each puppet has its own copy of the skeleton, every shared tier bound to it, none shown, and an action per clip')
check(w.puppets.every((p) => [...p.actions].every(([, a]) => a.loop === THREE.LoopRepeat)), 'every clip cycles -- the human library is round trips, so a gesture is played whole by its own length instead')
for (const bad of [[{ snowLineAt: null }, water, walk], [height, {}, walk], [height, water, { heightAt: walk.heightAt }]]) {
  let threw = false
  try { new Snowmen(scene, bad[0], bad[1], { walk: bad[2], asset: makeAsset() }) } catch { threw = true }
  check(threw, 'a world without the snow line, the water or the walk surface is refused')
}

// --- the scatter's rate ----------------------------------------------------------
const alive = (of) => of.slots.filter((c) => c.tile !== null || c.loose)
const SEEDS = 160
{
  let count = 0
  let tiles = 0
  let overflow = 0
  let below = 0
  for (let seed = 1; seed <= SEEDS * 2; seed++) {
    const k = make(seed, { walk: plain, water: noWater, height })
    k.place(0, 0, 1000)
    tiles += k.tiles.size
    overflow += k.overflow
    count += MAX - k.free.length
    k.dispose()
    const low = make(seed, { walk: plainAt(SNOW_LINE - 0.01), water: noWater, height })
    low.place(0, 0, 1000)
    below += MAX - low.free.length
    low.dispose()
  }
  const area = tiles * TILE * TILE
  const rate = count / area
  check(overflow === 0, 'nothing was dropped for want of a slot, over every seed', `${overflow} over ${SEEDS * 2} seeds`)
  check(Math.abs(rate / DENSITY - 1) < 0.12, `one per ${Math.round(1 / DENSITY)} square metres of ground above the snow line`, `1 per ${Math.round(1 / rate)} over ${Math.round(area / 1e3)}k m2`)
  check(count > 100, 'and enough of them to say so', `${count}`)
  check(below === 0, 'and none at all on the same ground a hand under the snow line', `${below}`)
}

// --- where they stand --------------------------------------------------------------
w.place(0, 0, 1000)
{
  const pool = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed)
    k.place(0, 0, 1000)
    for (const c of alive(k)) pool.push({ x: c.x, y: c.y, z: c.z, size: c.size, k: c.k, nx: c.nx, ny: c.ny, nz: c.nz, state: c.state, clip: c.clip, slot: c })
    k.dispose()
  }
  check(pool.length >= 50, 'the mountain carries snowmen', `${pool.length} over ${SEEDS} seeds; one seed: ${w.stats.alive} on ${w.stats.tiles} tiles`)
  check(pool.every((c) => c.y >= SNOW_LINE), 'every one stands above the snow line', `lowest ${Math.min(...pool.map((c) => c.y)).toFixed(2)} m of ${SNOW_LINE}`)
  // The rolling ground rides 0.6 m either way over the slope, which is 1.7 m of z at this pitch.
  const ripple = 0.6 / SLOPE + 0.05
  check(pool.some((c) => c.z < SLOPE_Z) && !pool.some((c) => c.z < SNOW_Z - ripple), `the slope is walked down to about z ${SNOW_Z.toFixed(0)} and no further`, `to z ${Math.min(...pool.map((c) => c.z)).toFixed(1)}`)
  check(pool.every((c) => !water.isSubmerged(c.x, c.z, c.y)), 'none wades', `${pool.filter((c) => water.isSubmerged(c.x, c.z, c.y)).length} in the tarn`)
  const onCrag = pool.filter((c) => Math.hypot(c.x - CRAG.x, c.z - CRAG.z) < CRAG.r - 0.5)
  check(onCrag.length === 0, `none on the crag's 52-degree faces (the limit is ${Math.round((MAX_SLOPE * 180) / Math.PI)})`, `${onCrag.length} on it`)
  const slopes = pool.map((c) => Math.acos(Math.min(1, walk.normalAt(c.x, c.z).y)))
  check(Math.max(...slopes) <= MAX_SLOPE + 1e-9, 'every one stands on ground it could stand on', `steepest ${((Math.max(...slopes) * 180) / Math.PI).toFixed(1)} deg`)
  check(pool.every((c) => TRUNKS.every((t) => Math.hypot(c.x - t.x, c.z - t.z) > t.r)), 'none stands inside a trunk')
  check(pool.every((c) => Math.abs(c.y - fieldAt(c.x, c.z)) < 1e-9), 'every one is on the walk surface, not floating over it')
  const sizes = pool.map((c) => c.size)
  check(sizes.every((s) => s >= SIZE_M[0] && s <= SIZE_M[1]) && Math.min(...sizes) < SIZE_M[0] + 0.2 && Math.max(...sizes) > SIZE_M[1] - 0.2, `a snowman is ${SIZE_M[0]} to ${SIZE_M[1]} m tall, and the range is walked`, `${Math.min(...sizes).toFixed(2)} to ${Math.max(...sizes).toFixed(2)} m`)
  check(pool.every((c) => Math.abs(c.k - c.size / biped.height) < 1e-9), 'and wears the scale that makes it so')
  check(pool.every((c) => !('hue' in c.slot)), 'and no colour of its own: a skinned body can only wear one through a uniform, and a uniform costs a material a snowman (puppet.js makePuppetMaterials)')
  check(pool.every((c) => c.state === 'cower' && ['cower', 'recoil', 'idle'].includes(c.clip)), 'every one is found cowering', [...new Set(pool.map((c) => c.clip))].join(' '))
  // Determinism: the same seed lays the same snowmen twice.
  const key = (of) => alive(of).map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  const again = make(7)
  again.place(0, 0, 1000)
  check(key(again) === key(w) && alive(w).length > 0, 'the scatter is a pure function of the seed', `${alive(w).length} snowmen`)
  const kept = alive(again).filter((c) => Math.hypot(c.x, c.z) < 30).map((c) => ({ c, x: c.x, z: c.z }))
  again.update(TILE, GROUND + 1.6, 0, 1000, [], 0)
  check(kept.every(({ c, x, z }) => c.tile !== null && c.x === x && c.z === z), 'a step of one tile leaves the snowmen she keeps exactly where they were', `${kept.length} kept`)
  again.dispose()
}

// --- what one does, by her distance --------------------------------------------------
//
// One snowman on the open shoulder, her head moved about it, on the room's
// clock: every instance carries its own `t`, a frame moves it on by dt and
// steps the layer to it. dt 0 where only the drawing is asked.
const HEAD = 1.6
// Exact binary fractions, so a frame time is exact and two instances on different frame rates read a tick boundary the same way.
const dt = 1 / 64
// A frame long enough to step a tick whatever the frame before it left the clock at, for the checks that ask what the next tick does.
const TICK = 1 / 16
const T0 = 1000
const face = (c, rad) => { c.sh = c.lh = c.heading = c.aim = rad }
const frame = (k, hx, hy, hz, step = dt, peers = []) => { k.t += step; k.update(hx, hy, hz, k.t, peers, step) }
function lone(seed = 3, world = { walk: plain, water: noWater, height }) {
  const k = make(seed, world)
  k.t = T0
  k.place(0, 0, k.t)
  const c = alive(k)[0]
  return { k, c, at: (d, frames = 1, step = dt) => { for (let f = 0; f < frames; f++) frame(k, c.x + d, GROUND + HEAD, c.z, step) } }
}
/** The chain of gestures a snowman's `table` has it on from tick `from` to `to`, closed-form. */
const chainOf = (k, c, table, from, to) => {
  const out = []
  for (let t = from; t < to;) { const g = { ...k._gestureAt(c, table, t) }; out.push(g); t = g.end }
  return out
}
{
  const { k, c, at } = lone()
  const d = k.durations
  // Cowering is closed-form in (key, tick): three minutes of it, cower and recoil in whole cycles with a stand between, nothing else; and stepped through those minutes, the snowman plays exactly that chain.
  const from = tickOf(k.t)
  const chain = chainOf(k, c, COWER_ACTS, from, from + 180 * TICK_HZ)
  // The minute's last gesture ends on the minute, and only that one may be cut.
  const onMinute = (g) => (g.end + c.hash % (60 * TICK_HZ)) % (60 * TICK_HZ) === 0
  const cut = chain.filter(onMinute)
  const wholeCycles = (g) => g.clip === 'idle' || Math.abs((g.end - g.start) * TICK_S - Math.round((g.end - g.start) * TICK_S / d[g.clip]) * d[g.clip]) <= TICK_S / 2 + 1e-9
  const acts = new Set(chain.map((g) => g.clip))
  check([...acts].sort().join() === 'cower,idle,recoil' && chain.every((g, i) => i + 1 === chain.length || g.end === chain[i + 1].start) && chain.every((g) => wholeCycles(g) || onMinute(g)), 'cowering is cower and recoil in whole cycles with a stand between, chained without a gap, only the minute\'s last cut short', `${chain.length} gestures, ${cut.length} cut`)
  let matched = true
  let moved = false
  for (let f = 0; f < 180 * 64; f++) {
    at(NOTICE_M + 5)
    const g = chain.find((g) => g.start <= c.rec.tick && c.rec.tick < g.end)
    if (!g || c.clip !== g.clip || c.stepStart !== g.start || c.stepEnd !== g.end) matched = false
    if (c.speed !== 0 || c.x !== c.homeX || c.z !== c.homeZ) moved = true
  }
  check(matched && !moved, 'and three minutes of frames play that chain to the tick, without moving', c.clip)
  // She comes at it from +x. It notices her only inside NOTICE_M on the side it faces: not from behind, not from beside, not a metre too far.
  const heading = c.homeHeading
  face(c, Math.PI)
  at(NOTICE_M - 1, 60)
  check(c.state === 'cower' && c.heading === Math.PI && !c.live, `${NOTICE_M - 1} m behind it she is nothing to it`, c.clip)
  face(c, Math.PI / 2 + 0.05)
  at(NOTICE_M - 1, 60)
  check(c.state === 'cower', 'nor just past its shoulder')
  face(c, heading)
  at(NOTICE_M + 1, 60)
  check(c.state === 'cower' && c.heading === heading, `nor ${NOTICE_M + 1} m off, whichever way it faces`, c.clip)
  face(c, Math.PI / 2 - 0.05)
  at(NOTICE_M - 1, 1, TICK)
  check(c.state === 'watch' && c.live && c.live.by === null, `just inside its shoulder at ${NOTICE_M - 1} m it notices her, and this client is its authority`)
  const owed = k.pending([])
  check(owed.length === 1 && owed[0][0] === c.key && /^sn:-?\d+,-?\d+,\d+$/.test(c.key) && c.rec.tick * TICK_S - owed[0][1] < 2 * TICK_S && owed[0][7] === 'watch' && owed[0][8] === null && Math.abs(owed[0][9] - Math.hypot(NOTICE_M - 1, HEAD)) < 1e-9 && owed.every((a) => a.length === 10 && a.every((f) => f === null || typeof f === 'string' || Number.isFinite(f))), 'and owes the room a watch anchor at once, under its key, with the nearest she has come', JSON.stringify(owed[0]))
  // Noticed: it turns to her, and keeps turning to her wherever she goes.
  at(NOTICE_M - 1, 240)
  check(Math.abs(swing(c.heading, Math.atan2(0, 1))) < 1e-6, 'and four seconds later it is facing her', `${c.heading.toFixed(4)} rad`)
  for (let f = 0; f < 240; f++) frame(k, c.x, GROUND + HEAD, c.z + NOTICE_M - 1)
  check(Math.abs(swing(c.heading, -Math.PI / 2)) < 1e-6, 'she steps round it and it turns to keep her in front', `${c.heading.toFixed(4)} rad`)
  check(k.pending([]).filter((a) => a[7] === 'watch').length === 7 || k.pending([]).length === 0, `an anchor a second while she stands there`)
  const watched = chainOf(k, c, WATCH_ACTS, tickOf(k.t), tickOf(k.t) + 180 * TICK_HZ)
  const gestures = new Set(watched.map((g) => g.clip))
  const once = (g) => g.clip === 'idle' ? (g.end - g.start) * TICK_S >= 2 - TICK_S && (g.end - g.start) * TICK_S <= 5 + TICK_S : Math.abs((g.end - g.start) * TICK_S - d[g.clip]) <= TICK_S / 2 + 1e-9
  check(gestures.has('beckon') && gestures.has('idle') && [...gestures].every((g) => ['beckon', 'talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug', 'idle'].includes(g)) && gestures.size >= 5 && watched.every((g) => once(g) || onMinute(g)), 'watching, it beckons and talks with its hands, each gesture once through, and stares between', [...gestures].join(' '))
  // Approaching does nothing; the first step back does.
  const near = 6
  for (const dd of [NOTICE_M - 1, 8, near]) at(dd, 5)
  check(c.state === 'watch' && Math.abs(c.live.near - Math.hypot(near, HEAD)) < 1e-9, `she walks up to ${near} m and it only watches`, `near ${c.live.near.toFixed(2)}`)
  at(near + AWAY_M - 0.5, 5)
  check(c.state === 'watch', `she backs off ${AWAY_M - 0.5} m and it only watches`)
  at(near + AWAY_M + 0.5, 1, TICK)
  check(c.state === 'follow' && c.clip === 'walk' && Math.abs(c.speed - biped.gait.walk * c.k) < 1e-12, `she backs off ${AWAY_M + 0.5} m and it comes after her, at a walk`, `${c.speed.toFixed(2)} m/s for a ${c.size.toFixed(2)} m snowman`)
  // She stands: it closes to the standoff, and stops there to watch.
  const [hx, hz] = [c.x + near + AWAY_M + 0.5, c.z]
  let closest = Infinity
  let farthest = 0
  k.pending([])
  for (let f = 0; f < 960; f++) {
    frame(k, hx, GROUND + HEAD, hz)
    const dist = Math.hypot(c.x - hx, c.z - hz)
    if (f > 640) { closest = Math.min(closest, dist); farthest = Math.max(farthest, dist) }
  }
  check(c.state === 'follow' && c.speed === 0 && closest > STANDOFF_M - HEAD && farthest < STANDOFF_M + RESUME_M, `it walks up to ${STANDOFF_M} m of her and stops there`, `${closest.toFixed(2)} to ${farthest.toFixed(2)} m over the last five seconds, ${c.clip}`)
  check(Math.abs(swing(c.heading, Math.atan2(-(hz - c.z), hx - c.x))) < 1e-6, 'facing her')
  const following = k.pending([])
  check(following.length === 15 && following.every((a) => a[7] === 'follow') && following.every((a, i) => i === 0 || Math.abs(a[1] - following[i - 1][1] - ANCHOR_S) < 1e-9), `fifteen seconds of following owed fifteen follow anchors, one a second`, `${following.length} anchors, ${[...new Set(following.map((a) => a[7]))].join(' ')}`)
  // She runs: it runs.
  // Facing her exactly, so the ground covered is the gait alone and not a curve.
  const far = RUN_M + 6
  face(c, 0)
  const [rx, rz] = [c.x + far, c.z]
  frame(k, rx, GROUND + HEAD, rz, TICK)
  check(c.state === 'follow' && c.clip === 'run' && Math.abs(c.speed - biped.gait.run * c.k) < 1e-12, `${far} m off she is chased at a run`, `${c.speed.toFixed(2)} m/s`)
  const [x0, z0] = [c.x, c.z]
  for (let f = 0; f < 32; f++) frame(k, rx, GROUND + HEAD, rz)
  check(Math.abs(Math.hypot(c.x - x0, c.z - z0) - c.speed * 0.5) < 1e-6, 'and covers exactly the ground its clip was built for -- it does not skate')
  let walked = false
  for (let f = 0; f < 960 && !walked; f++) { frame(k, rx, GROUND + HEAD, rz); walked = c.clip === 'walk' }
  check(walked && Math.hypot(c.x - rx, c.z - rz) < RUN_M, `and drops to a walk inside ${RUN_M} m`, `${Math.hypot(c.x - rx, c.z - rz).toFixed(2)} m`)
  // Forgotten past FORGET_M, in any state, and not a metre before: a last rejoin anchor, and the walk home.
  frame(k, c.x + FORGET_M - 1, GROUND + HEAD, c.z, TICK)
  check(c.state === 'follow', `${FORGET_M - 1} m off it still follows`)
  k.pending([])
  const fx = c.x + FORGET_M + 1
  frame(k, fx, GROUND + HEAD, c.z, TICK)
  const last = k.pending([])
  check(c.state === 'home' && !c.live && c.clip === 'walk' && c.speed > 0 && last.length === 1 && last[0][7] === 'rejoin' && Math.abs(last[0][2] - c.lx) < 1e-9, `${FORGET_M + 1} m off it forgets her, owes the room one rejoin anchor from where it was, and sets off home`, `${Math.hypot(c.x - c.homeX, c.z - c.homeZ).toFixed(1)} m from home`)
  let frames = 0
  while (c.state === 'home' && frames < 64 * 120) { frame(k, fx, GROUND + HEAD, c.z); frames++ }
  check(c.state === 'cower' && Math.hypot(c.sx - c.homeX, c.sz - c.homeZ) <= HOME_M && c.speed === 0 && k.pending([]).length === 0, 'and walks there, cowers within a metre of it, and owes nothing more', `${(frames * dt).toFixed(1)} s`)
  face(c, 0)
  at(NOTICE_M - 1, 1, TICK)
  check(c.state === 'watch', 'home, she is noticed again')
  frame(k, c.x + FORGET_M + 1, GROUND + HEAD, c.z, TICK)
  check(c.state === 'cower' && k.pending([]).filter((a) => a[7] === 'rejoin').length === 1, 'a watcher forgets her past it too, and at home already it only cowers')
  k.dispose()
}

// --- it turns, and never snaps ------------------------------------------------------
{
  const { k, c, at } = lone(5)
  face(c, 0)
  at(NOTICE_M - 1, 1, TICK)
  check(c.live?.by === null, 'noticed')
  face(c, Math.PI)
  let worst = 0
  let frames = 0
  let prev = c.heading
  // The hardest turn there is: she is right behind it.
  while (Math.abs(swing(c.heading, 0)) > 1e-9 && frames < 600) {
    at(NOTICE_M - 1)
    worst = Math.max(worst, Math.abs(swing(prev, c.heading)))
    prev = c.heading
    frames++
  }
  check(frames >= Math.PI / TURN_RATE / dt && worst <= TURN_RATE * dt + 1e-9, 'an about-face to her is turned through, not snapped to', `${(frames * dt).toFixed(2)} s at up to ${(worst / dt).toFixed(2)} rad/s`)
  // A minute of her circling it at a run, then dragging it about: every heading of every frame.
  let snapped = 0
  let was = c.heading
  for (let f = 0; f < 3840; f++) {
    const a = f * dt * 1.2
    const r = 8 + 20 * Math.abs(Math.sin(f * dt * 0.15))
    frame(k, c.x + Math.cos(a) * r, GROUND + HEAD, c.z + Math.sin(a) * r)
    snapped = Math.max(snapped, Math.abs(swing(was, c.heading)))
    was = c.heading
  }
  check(snapped <= TURN_RATE * dt + 1e-9, 'in a minute of being circled and led about, it never turned faster than it may', `worst ${(snapped / dt).toFixed(3)} rad/s of ${TURN_RATE}`)
  k.dispose()
}

// --- the same on every client -------------------------------------------------------
//
// Two instances of the one seed on different frame rates, her head moved on
// integer seconds; a third joins forty seconds in with only the room's anchors
// and her relayed head; a fourth watches a peer stand in its face with no
// anchor at all.
{
  const A = lone(3)
  const B = lone(3)
  const c = A.c
  const her = (t) => {
    const s = t - T0
    if (s < 10) return [c.homeX + NOTICE_M - 1, c.homeZ]
    if (s < 20) return [c.homeX + NOTICE_M - 1 + AWAY_M + 1, c.homeZ]
    if (s < 40) return [c.homeX + 40, c.homeZ + 5]
    // Then away at a walk, a stride a second, so a joiner's replay sees near enough the head A's copy followed.
    const d = Math.min(20, (Math.floor(s) - 40) * 1.4)
    return [c.homeX + 40 - d, c.homeZ + 5 - d]
  }
  check(B.c.key === c.key && B.c.homeX === c.homeX, 'the twin lays the same snowman under the same key')
  face(c, 0)
  face(B.c, 0)
  const run = (k, step, until, peers = () => []) => { while (k.t + step <= until + 1e-9) { const [hx, hz] = her(k.t + step); frame(k, hx, GROUND + HEAD, hz, step, peers()) } }
  const same = (a, b) => a.sx === b.sx && a.sz === b.sz && a.sh === b.sh && a.state === b.state && a.clip === b.clip && a.stepStart === b.stepStart && a.rec.tick === b.rec.tick
  // The joiner: her head reaches it as a peer's, under A's id; its own player stands behind it, out of its notice.
  const J = lone(3)
  J.k.t = T0 + 40
  J.k.place(0, 0, J.k.t)
  const j = alive(J.k).find((s) => s.key === c.key)
  const anchors = []
  const relay = () => { for (const a of A.k.pending([])) { a[8] = 'a'; anchors.push(a) } }
  run(A.k, 1 / 64, T0 + 40, relay)
  run(B.k, 1 / 32, T0 + 40)
  check(same(c, B.c) && c.state === 'follow' && c.live?.by === null, 'forty seconds in, the twins have stepped the same ticks to the same pose, both following her', `${c.state} ${c.clip} at ${c.sx.toFixed(3)},${c.sz.toFixed(3)}`)
  check(anchors.length >= 38 && anchors.every((a) => ['watch', 'follow'].includes(a[7])), 'A owed the room an anchor a second all the while', `${anchors.length}`)
  // Everything the relay holds lands on the joiner: the latest for the key.
  J.k.apply(anchors[anchors.length - 1], J.k.t)
  const peer = { x: 0, y: GROUND + HEAD, z: 0, by: 'a' }
  const jHead = () => [c.homeX - 20, c.homeZ]
  const jPeers = () => { [peer.x, peer.z] = her(J.k.t); return [peer] }
  frame(J.k, jHead()[0], GROUND + HEAD, jHead()[1], TICK, jPeers())
  check(j.state === 'follow' && j.live?.by === 'a' && j.live.anchor === anchors[anchors.length - 1] && Math.hypot(j.x - c.x, j.z - c.z) < 1, 'the joiner puts it where the anchor has it, following A\'s player, and owes nothing', `${Math.hypot(j.x - c.x, j.z - c.z).toFixed(2)} m off A's`)
  const relayJ = () => { relay(); for (const a of anchors.splice(0)) J.k.apply(a, J.k.t); return jPeers() }
  let gap = 0
  let jOwed = 0
  while (A.k.t < T0 + 70) {
    const [hx, hz] = her(A.k.t + dt)
    frame(A.k, hx, GROUND + HEAD, hz, dt)
    frame(J.k, c.homeX - 20, GROUND + HEAD, c.homeZ, dt, relayJ())
    jOwed += J.k.pending([]).length
    gap = Math.max(gap, Math.hypot(j.x - c.x, j.z - c.z))
  }
  check(c.state === 'follow' && j.state === 'follow' && gap < 1.5 && jOwed === 0 && Math.hypot(j.x - c.x, j.z - c.z) < 0.5, 'half a minute on, nudged onto each anchor, it has stayed within arm\'s reach of A\'s and stands with it, having sent nothing', `at most ${gap.toFixed(2)} m apart, ${Math.hypot(j.x - c.x, j.z - c.z).toFixed(2)} m now`)
  // A's player leaves the room: A forgets her, sends its rejoin, the joiner walks home on that.
  // Past FORGET_M of A's copy, and inside RADIUS + TILE of its home so the loose snowman is not freed.
  const gone = c.sx + FORGET_M + 1
  frame(A.k, gone, GROUND + HEAD, c.homeZ, TICK)
  const rejoin = A.k.pending([])
  check(c.state === 'home' && rejoin.length === 1 && rejoin[0][7] === 'rejoin', 'she leaves and A sets it walking home with a rejoin anchor')
  rejoin[0][8] = 'a'
  J.k.apply(rejoin[0], J.k.t)
  check(j.state === 'home' && !j.live && Math.abs(j.sx - rejoin[0][2]) < 1e-9 && Math.abs(j.sz - rejoin[0][4]) < 1e-9, 'which puts the joiner\'s at the anchor\'s pose, walking home')
  while ((c.state === 'home' || j.state === 'home') && A.k.t < T0 + 200) {
    frame(A.k, gone, GROUND + HEAD, c.homeZ, dt)
    frame(J.k, c.homeX - 20, GROUND + HEAD, c.homeZ, dt, [])
  }
  check(c.state === 'cower' && j.state === 'cower' && Math.hypot(j.x - c.x, j.z - c.z) < 2 * HOME_M && c.clip === j.clip && c.stepStart === j.stepStart, 'both walk home, and cower there on the same gesture', `${Math.hypot(j.x - c.x, j.z - c.z).toFixed(2)} m apart, ${c.clip}`)
  // A peer with no anchor is nobody to it.
  const D = lone(3)
  face(D.c, 0)
  for (let f = 0; f < 64; f++) frame(D.k, D.c.homeX - 20, GROUND + HEAD, D.c.homeZ, dt, [{ x: D.c.homeX + 3, y: GROUND + HEAD, z: D.c.homeZ, by: 'b' }])
  check(D.c.state === 'cower' && !D.c.live && D.k.pending([]).length === 0, 'a peer standing in its face with no anchor from their client is not noticed: only their client\'s anchor makes it theirs')
  // A live anchor a chapter old is not read; one from this chapter but past ANCHOR_STALE_S sets the resident walking home from ANCHOR_STALE_S after it, the walk since replayed.
  const old = [D.c.key, chapterOf(D.k.t, D.c.key).start - 1, D.c.homeX + 30, GROUND, D.c.homeZ, 0, -1, 'follow', 'b', 5]
  D.k.apply(old, D.k.t)
  check(D.c.state === 'cower' && !D.c.live && D.c.sx === D.c.homeX, 'a live anchor from a chapter gone is not read: the resident cowers at home')
  const stale = [D.c.key, D.k.t - ANCHOR_STALE_S - 2, D.c.homeX + 30, GROUND, D.c.homeZ, Math.PI, -1, 'follow', 'b', 5]
  D.k.apply(stale, D.k.t)
  frame(D.k, D.c.homeX - 20, GROUND + HEAD, D.c.homeZ, TICK, [{ x: D.c.homeX + 33, y: GROUND + HEAD, z: D.c.homeZ, by: 'b' }])
  const walked = 30 - (D.c.sx - D.c.homeX)
  check(D.c.state === 'home' && !D.c.live && D.c.rec.tick === tickOf(D.k.t) && walked > 1.5 * D.c.speed && walked < 3 * D.c.speed, 'one from this chapter, gone stale, puts it at the anchor\'s pose walking home from ANCHOR_STALE_S after it, the walk since replayed', `${walked.toFixed(1)} m along`)
  for (const k of [A.k, B.k, J.k, D.k]) k.dispose()
}

// --- a skip is a step out of the timeline ---------------------------------------------
{
  const { k, c } = lone(3)
  face(c, 0)
  frame(k, c.homeX + NOTICE_M - 1, GROUND + HEAD, c.homeZ, TICK)
  frame(k, c.homeX + NOTICE_M - 1 + AWAY_M + 2, GROUND + HEAD, c.homeZ, TICK)
  for (let f = 0; f < 64; f++) frame(k, c.homeX + 30, GROUND + HEAD, c.homeZ)
  check(c.state === 'follow' && Math.hypot(c.x - c.homeX, c.z - c.homeZ) > 1, 'following her, a few metres out')
  k.pending([])
  const t1 = k.t + 500
  frame(k, c.homeX + 30, GROUND + HEAD, c.homeZ, 500)
  const a = k.anchored.get(c.key)
  const fromAnchor = a[1] >= chapterOf(t1, c.key).start
  check(k.stats.replayed === 0 && !k.stats.behind && c.rec.tick === tickOf(t1) && !c.live && k.pending([]).length === 0, `${CATCH_UP_TICKS * TICK_S}+ s in one frame is a skip: nothing replayed, the snowman placed afresh at now, its player forgotten`, `${k.stats.replayed} ticks`)
  check(fromAnchor ? (c.state === 'home' || c.state === 'cower') && (c.state === 'cower' ? Math.hypot(c.x - c.homeX, c.z - c.homeZ) <= HOME_M : true) : c.state === 'cower' && c.x === c.homeX && c.z === c.homeZ, fromAnchor ? 'on its own last follow anchor, stale by then: walking home from ANCHOR_STALE_S after it, replayed' : 'its last anchor a chapter old: laid at home, cowering')
  k.dispose()
}

// --- standing, its feet are on the ground ---------------------------------------------
//
// A tilted plain and one snowman on it, side-on to the slope. Cowering, each
// foot is solved to the ground under it (puppet.js FootIK); recoiling or
// walking, the clip is left exactly alone; turned to keep her in front as she
// steps round it, the ground is read again.
{
  const TILT = 0.35
  const tilted = walkOn((x, z) => GROUND + TILT * z)
  let k
  for (let seed = 1; ; seed++) {
    k = make(seed, { walk: tilted, water: noWater, height })
    k.t = T0
    k.place(0, 0, k.t)
    if (alive(k).length) break
    k.dispose()
  }
  const c = alive(k)[0]
  // Facing +x, across the slope: its left foot uphill, its right downhill.
  face(c, 0)
  // Her head `dx, dz` off it for `s` seconds; a metre past its notice straight ahead, it goes on cowering.
  const over = (s, dx = NOTICE_M + 1, dz = 0) => { for (let f = 0; f < Math.round(s / dt); f++) frame(k, c.x + dx, tilted.heightAt(c.x + dx, c.z + dz) + HEAD, c.z + dz) }
  // Each foot joint in the world: its height over the ground under it, and the bend at its knee.
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3()
  const feet = () => {
    // A bone's world matrix is creature-space (the rig is detached); the group puts it in the world.
    const g = c.puppet.group.matrix
    return c.puppet.ik.legs.map((l) => {
      A.setFromMatrixPosition(l.A.matrixWorld).applyMatrix4(g); B.setFromMatrixPosition(l.B.matrixWorld).applyMatrix4(g); C.setFromMatrixPosition(l.C.matrixWorld).applyMatrix4(g)
      return { id: l.id, hover: C.y - tilted.heightAt(C.x, C.z), knee: Math.acos(A.sub(B).normalize().dot(C.sub(B).normalize())) }
    })
  }
  const restKnee = Math.acos(new THREE.Vector3(-0.1, 0.27, 0).normalize().dot(new THREE.Vector3(-0.1, -(LEG_HIP_Y - 0.27 - LEG_FOOT_Y), 0).normalize()))
  const identity = new THREE.Quaternion()
  const untouched = () => !c.puppet.planted && !c.puppet.ik.active && !c.puppet.ik.dirty && c.puppet.ik.legs.every((l) => l.A.quaternion.equals(identity) && l.B.quaternion.equals(identity)) && feet().every((f) => Math.abs(f.knee - restKnee) < 1e-9)
  check([...PLANTED].sort().join() === 'beckon,cower,idle,talk-gesture,talk-nod,talk-point,talk-shrug', 'the clips whose feet stay put are the stand, the cower and every gesture -- a recoil steps a foot back, and no gait plants', [...PLANTED].join(' '))
  k._play(c, 'cower', c.rec.tick, Infinity)
  over(1)
  const own = LEG_FOOT_Y * biped.height * c.k
  const rise = 0.6 * biped.width * c.k * TILT
  const planted = feet()
  check(c.state === 'cower' && c.clip === 'cower' && c.speed === 0 && c.puppet?.planted && c.puppet.ik.w === 1, `a ${c.size.toFixed(1)} m snowman cowering side-on to a ${((Math.atan(TILT) * 180) / Math.PI).toFixed(0)}-degree slope has its feet planted`)
  check(planted.every((f) => Math.abs(f.hover - own) < 1e-3), `and a second later each foot stands exactly its clip's own ${(own * 100).toFixed(1)} cm over the ground under it, which rises ${(rise * 100).toFixed(0)} cm from its right foot to its left`, planted.map((f) => `${f.id} ${(f.hover * 100).toFixed(2)}`).join(' '))
  check(planted.find((f) => f.id === 'L').knee < restKnee - 0.02 && planted.find((f) => f.id === 'R').knee > restKnee + 0.02, 'its uphill knee folded and its downhill knee opened off the clip to get there', planted.map((f) => `${f.id} ${((f.knee * 180) / Math.PI).toFixed(1)}`).join(' ') + ` of ${((restKnee * 180) / Math.PI).toFixed(1)}`)
  k._play(c, 'recoil', c.rec.tick, Infinity)
  over(0.5)
  check(c.clip === 'recoil' && c.speed === 0 && untouched(), 'recoiling, half a second later its legs are the clip\'s exactly: a still clip that moves a foot is not planted')
  k._play(c, 'walk', c.rec.tick, Infinity)
  over(0.25)
  check(c.clip === 'walk' && c.speed > 0 && untouched(), 'and walking, so are they, whatever the ground under each foot')
  // She steps in front and round it: noticed, it turns to keep her in front, gesturing all the while, and past REPLANT of turning reads the ground under where its feet are now.
  k._play(c, 'cower', c.rec.tick, Infinity)
  over(1, NOTICE_M - 1, 0)
  const first = c.puppet.plantHeading
  check(c.state === 'watch' && c.puppet.planted && Math.abs(c.heading) < 1e-6, 'she steps in front of it and it watches her, planted, facing +x', `${c.clip} at ${first.toFixed(2)} rad`)
  over(4, 0, NOTICE_M - 1)
  const turned = feet()
  // Between re-plants a foot's ground is the one read up to REPLANT ago: at most that swing, at the foot's radius, down the tilt.
  const stale = 0.3 * biped.width * c.k * REPLANT * TILT
  check(Math.abs(swing(c.heading, -Math.PI / 2)) < 1e-6 && c.puppet.planted && c.puppet.plantHeading !== first && Math.abs(swing(c.puppet.plantHeading, c.heading)) <= REPLANT && turned.every((f) => Math.abs(f.hover - own) < stale + 1e-3), `she steps round to its left and it turns a quarter to her: it has read the ground again, and every foot stands on it to within the ${(stale * 100).toFixed(1)} cm a swing short of REPLANT can move the ground under a foot`, `planted at ${first.toFixed(2)}, again at ${c.puppet.plantHeading.toFixed(2)}, facing ${c.heading.toFixed(2)}, ${c.clip}; ${turned.map((f) => `${f.id} ${((f.hover - own) * 100).toFixed(2)}`).join(' ')}`)
  k.dispose()
}

// --- it walks round what it cannot cross, and off the snow after her ------------------
{
  // The mountain around her, and a snowman whose tile stays loaded while she moves a few metres: moved to where the test wants it, facing her.
  const stage = (hx, hz, x, z) => {
    for (let seed = 1; ; seed++) {
      const k = make(seed)
      k.t = T0
      k.place(hx, hz, k.t)
      const c = alive(k).find((a) => Math.hypot((a.tile.tx + 0.5) * TILE - hx, (a.tile.tz + 0.5) * TILE - hz) < RADIUS - 10)
      if (!c) { k.dispose(); continue }
      k._place(c, x, z, Math.atan2(-(hz - z), hx - x))
      return { k, c }
    }
  }
  // It faces the tarn from the near rim; she is noticed on that rim, then crosses to the far one.
  const [hx, hz] = [TARN.x - TARN.r - 1, TARN.z]
  const { k, c } = stage(hx, hz, hx - NOTICE_M + 1, TARN.z)
  frame(k, hx, fieldAt(hx, hz) + HEAD, hz, TICK)
  check(c.state === 'watch', 'it sees her on the near rim of the tarn')
  const far = TARN.x + TARN.r + 2
  let wet = 0
  let ms = 0
  for (let f = 0; f < 3840; f++) {
    const t0 = performance.now()
    frame(k, far, fieldAt(far, hz) + HEAD, hz)
    ms += performance.now() - t0
    if (water.isSubmerged(c.x, c.z, c.y)) wet++
  }
  check(c.state === 'follow' && c.speed === 0 && Math.hypot(c.x - far, c.z - hz) < STANDOFF_M + RESUME_M + 0.5, 'she crosses to the far rim and a minute later it stands at her side of it', `${Math.hypot(c.x - far, c.z - hz).toFixed(2)} m from her`)
  check(wet === 0, 'having gone round, not through', `${wet} wet frames`)
  check(alive(k).every((a) => Math.abs(a.y - fieldAt(a.x, a.z)) < 1e-9 && !water.isSubmerged(a.x, a.z, a.y) && Math.acos(Math.min(1, walk.normalAt(a.x, a.z).y)) <= FOLLOW_SLOPE + 1e-9 && TRUNKS.every((t) => Math.hypot(a.x - t.x, a.z - t.z) > t.r)), 'everybody is on the ground, and nobody in the water, up a face it could not climb or through a trunk')
  check(ms / 3840 < 1.5, `a frame of ${alive(k).length} snowmen, every one of them minded, costs under 1.5 ms`, `${(ms / 3840).toFixed(3)} ms`)
  k.dispose()
  // Led down the slope: it follows her under the snow line, where none is ever placed, and out of its tile.
  let [lx, lz] = [0, SLOPE_Z]
  const led = stage(lx, lz, lx, lz + NOTICE_M - 1)
  frame(led.k, lx, fieldAt(lx, lz) + HEAD, lz)
  for (let f = 0; f < 3840; f++) {
    lz -= 1.5 * dt
    frame(led.k, lx, fieldAt(lx, lz) + HEAD, lz)
  }
  check(led.c.state === 'follow' && led.c.y < SNOW_LINE - 5 && Math.hypot(led.c.x - lx, led.c.z - lz) < RUN_M, 'led down the slope for a minute, it follows her well below the snow line', `at ${led.c.y.toFixed(1)} m, ${Math.hypot(led.c.x - lx, led.c.z - lz).toFixed(1)} m behind her`)
  {
    // On that slope its puppet stands on the world vertical, not on the ground's normal: a biped on a hillside is upright.
    const q = new THREE.Quaternion()
    led.c.puppet.group.matrix.decompose(new THREE.Vector3(), q, new THREE.Vector3())
    const lean = Math.acos(walk.normalAt(led.c.x, led.c.z).y)
    check(led.c.puppet && lean > (15 * Math.PI) / 180 && new THREE.Vector3(0, 1, 0).applyQuaternion(q).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9, 'and stands upright on the world vertical while the ground leans under it', `ground leans ${((lean * 180) / Math.PI).toFixed(1)} deg`)
  }
  led.k.dispose()

  // A shelf across her way: a 45-degree face two metres high, steeper than one is ever laid on and gentler than she can climb (player.js LOCOMOTION.maxSlopeDeg). She walks straight over it, so a follower has to as well.
  const SHELF = { z: 0, w: 2, rise: 2 }
  const shelfAt = (x, z) => GROUND + Math.min(1, Math.max(0, (z - SHELF.z) / SHELF.w)) * SHELF.rise
  const shelfWalk = walkOn(shelfAt)
  const face45 = Math.acos(shelfWalk.normalAt(0, SHELF.z + SHELF.w / 2, 0.75).y)
  check(face45 > MAX_SLOPE && face45 < FOLLOW_SLOPE, `the shelf's face reads ${((face45 * 180) / Math.PI).toFixed(0)} degrees over the walk surface's own 1.5 m span: past ${Math.round((MAX_SLOPE * 180) / Math.PI)} where one is laid, inside ${Math.round((FOLLOW_SLOPE * 180) / Math.PI)} where one follows`)
  {
    let sx = 0, sz = -3
    let k, c
    for (let seed = 1; !c; seed++) {
      k = make(seed, { walk: shelfWalk, water: noWater, height })
      k.t = T0
      k.place(sx, sz, k.t)
      c = alive(k).find((a) => Math.hypot((a.tile.tx + 0.5) * TILE - sx, (a.tile.tz + 0.5) * TILE - sz) < RADIUS - 10)
      if (!c) k.dispose()
    }
    k._place(c, 0, -12, Math.atan2(-(sz - -12), sx - 0))
    frame(k, sx, shelfAt(sx, sz) + HEAD, sz, TICK)
    check(c.state === 'watch', 'it sees her from the foot of the shelf')
    sz = SHELF.z + SHELF.w + 20
    let steepest = 0
    for (let f = 0; f < 3840; f++) {
      frame(k, sx, shelfAt(sx, sz) + HEAD, sz)
      steepest = Math.max(steepest, Math.acos(shelfWalk.normalAt(c.x, c.z).y))
    }
    check(c.state === 'follow' && c.speed === 0 && c.z > SHELF.z + SHELF.w && Math.hypot(c.x - sx, c.z - sz) < STANDOFF_M + RESUME_M + 0.5, 'she crosses the shelf and a minute later it stands at her side of it', `${Math.hypot(c.x - sx, c.z - sz).toFixed(2)} m from her, ${c.z.toFixed(1)} m past its foot`)
    check(steepest > MAX_SLOPE, 'having climbed the face itself, ground it would never have been laid on', `steepest ground under it ${((steepest * 180) / Math.PI).toFixed(1)} deg`)
    k.dispose()
  }
}

// --- it outlives its tile, and is laid only once --------------------------------------
{
  const { k, c } = lone(3)
  // The biggest of them, whose cull reaches far past any tile of it: that is the one that is still
  // there to follow her once its tile has gone.
  c.size = SIZE_M[1]
  c.k = c.size / k.asset.height
  const key = c.key
  const [homeX, homeZ] = [c.x, c.z]
  const tile = c.tile
  face(c, 0)
  let hx = c.x + NOTICE_M - 1
  frame(k, hx, GROUND + HEAD, c.z, TICK)
  hx += AWAY_M + 1
  // She walks straight on for a minute, faster than it walks and slower than it runs.
  for (let f = 0; f < 3840; f++) {
    hx += 3 * dt
    frame(k, hx, GROUND + HEAD, c.z)
  }
  check(!k.tiles.has([...k.tiles.keys()].find((kk) => k.tiles.get(kk) === tile)) && c.tile === null && c.loose && k.loose.includes(c) && c.key === key, 'its tile has unloaded behind it and it is loose', `${k.stats.loose} loose, ${k.stats.states.follow} following`)
  check(c.state === 'follow' && Math.hypot(c.x - hx, c.z - homeZ) < RUN_M + 1 && c.puppet && k.batch.children.includes(c.puppet.group), 'still following her, still drawn', `${Math.hypot(c.x - hx, c.z - homeZ).toFixed(1)} m behind her, ${(hx - homeX).toFixed(0)} m from home`)
  // She goes back for the tile: the snowman it would lay is the one already out, so the tile takes that one back.
  frame(k, homeX, GROUND + HEAD, homeZ, TICK)
  const home = [...k.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(c.state === 'home' && !c.loose && c.tile === home && home.animals.includes(c) && !k.loose.includes(c) && alive(k).filter((a) => a.key === key).length === 1, 'its home tile re-entered while it is loose takes it back, once, where it stands, and at that distance it forgets her and turns for home', `${alive(k).filter((a) => a.key === key).length} with its key`)
  // And out past the tile horizon, on the far side from its home tile, it dissolves and is freed.
  const [lx, lz] = [c.x + RADIUS + TILE + 2, c.z]
  let frames = 0
  while ((c.tile || c.loose) && frames < 120) { frame(k, lx, GROUND + HEAD, lz); frames++ }
  check(!k.loose.includes(c) && c.tile === null && !c.loose && !c.puppet && k.free.includes(c) && Math.abs(frames * dt - LOD_FADE_S) < 3 / 64, `once she is ${RADIUS + TILE} m from a forgotten loose one it dissolves out and is freed`, `${(frames * dt).toFixed(2)} s`)
  check(k.freePuppets.length === PUPPETS - (k.batch.children.length), 'the pools balance')
  k.place(homeX, homeZ, k.t)
  const back = alive(k).find((a) => a.key === key)
  const a = k.anchored.get(key)
  check(back && a[7] === 'rejoin' && a[1] >= chapterOf(k.t, key).start && back.state === 'home' && !back.live && Math.hypot(back.x - a[2], back.z - a[4]) < Math.hypot(homeX - a[2], homeZ - a[4]), 'and laid again from its tile, it is on its way home from its own rejoin anchor, the ticks since replayed', `${Math.hypot(back.x - homeX, back.z - homeZ).toFixed(1)} m from home, rejoined ${(k.t - a[1]).toFixed(1)} s ago`)
  k.dispose()
}

// --- the ladder: four rungs doubling in distance, as a ratio of its own height ---
{
  const size = SIZE_M[0]
  const rungs = Array.from({ length: LOD_TIERS }, (_, k) => lodReach(size, k))
  check(LOD_TIERS === 4 && rungs.every((d, k) => k === 0 || Math.abs(d / rungs[k - 1] - 2) < 1e-12), `four rungs, each reaching twice as far as the one above it`, `a ${size} m snowman: ${rungs.map((d) => d.toFixed(0)).join(' / ')} m`)
  const fresh = rungs.map((m) => [critterTier(size, m - 0.01, -1, LOD_TIERS), critterTier(size, m + 0.01, -1, LOD_TIERS)])
  check(fresh.every(([a, b], i) => a === i && b === i + 1) && critterTier(size, 0, -1, LOD_TIERS) === 0 && critterTier(size, 1e4, -1, LOD_TIERS) === LOD_TIERS, 'each rung holds up to its reach and hands over the next, and past the last there is no rung', fresh.map((f) => f.join('>')).join(' '))
  const h = LOD_HYSTERESIS
  const e = rungs[0]
  check(critterTier(size, e * (1 + h) - 0.01, 0, LOD_TIERS) === 0 && critterTier(size, e * (1 + h) + 0.01, 0, LOD_TIERS) === 1 && critterTier(size, e * (1 - h) + 0.01, 1, LOD_TIERS) === 1 && critterTier(size, e * (1 - h) - 0.01, 1, LOD_TIERS) === 0, `a rung is left only ${h * 100}% past its edge, going either way`)
  const cull = cullRange(size)
  check(critterTier(size, cull * (1 + h) - 0.01, LOD_TIERS - 1, LOD_TIERS) === LOD_TIERS - 1 && critterTier(size, cull * (1 + h) + 0.01, LOD_TIERS - 1, LOD_TIERS) === LOD_TIERS, 'so one vanishes a little past its cull and comes back a little inside it, never both on the one spot', `culled past ${cull.toFixed(0)} m`)
  // Size IS in it: three times the snowman, three times every distance on the ladder.
  const { k, c } = lone(3)
  const walkOut = (m) => {
    c.size = m
    c.k = m / k.asset.height
    c.lod = LOD_TIERS
    // Just inside each rung and just outside it, as a FRACTION of the rung -- clear of the hysteresis at either size, which a fixed metre is not.
    const step = LOD_HYSTERESIS * 2
    return Array.from({ length: LOD_TIERS }, (_, i) => lodReach(m, i)).flatMap((d) => [d * (1 - step), d * (1 + step)]).map((d) => { for (let f = 0; f < 3; f++) frame(k, c.x, c.y + d, c.z, 0); return c.lod })
  }
  const [small, big] = [walkOut(SIZE_M[0]), walkOut(SIZE_M[1])]
  check(small.join() === big.join() && small.join() === '0,1,1,2,2,3,3,4', `a ${SIZE_M[0]} m and a ${SIZE_M[1]} m snowman walk the same ladder, one at ${SIZE_M[1] / SIZE_M[0]}x the other's distances`, `${lodReach(SIZE_M[0], 0).toFixed(0)} m against ${lodReach(SIZE_M[1], 0).toFixed(0)} m for the top rung`)
  k.dispose()
}

// --- drawn, or not drawn; nothing pops ---------------------------------------------------
{
  const { k, c } = lone(3)
  const at = (d, frames = 2, step = 0) => { for (let f = 0; f < frames; f++) frame(k, c.x, c.y + d, c.z, step); return c.lod }
  const settle = (d) => at(d, Math.ceil(LOD_FADE_S * 64) + 2, dt)
  // Read off its own height, because that is what the ladder is a ratio of.
  const expect = (d) => critterTier(c.size, d, -1, LOD_TIERS)
  const close = lodReach(c.size, 0) / 2
  const out = lodReach(c.size, LOD_TIERS - 1) * 0.9
  const near = settle(close)
  check(near === 0 && expect(close) === 0 && c.puppet && k.batch.children.includes(c.puppet.group), `${close.toFixed(0)} metres over it -- half of what the top rung holds -- the snowman is a puppet in the scene, on the top rung`)
  check(c.puppet.current.getClip().name === c.clip && c.puppet.current.isRunning(), 'playing what it is doing', c.clip)
  {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    c.puppet.group.matrix.decompose(p, q, s)
    const want = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.heading)
    check(p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-6 && Math.abs(s.x - c.k) < 1e-9 && Math.abs(q.dot(want)) > 1 - 1e-9, 'standing where it is, at its own size, facing its heading about the world vertical', `scale ${s.x.toFixed(3)}`)
  }
  const gone = settle(400)
  check(gone === LOD_TIERS && expect(400) === LOD_TIERS && !c.puppet && k.freePuppets.length === PUPPETS, 'four hundred metres off it is not drawn at all, and the pool is whole')
  const before = { clip: c.clip, start: c.stepStart }
  at(400, 64 * 30, dt)
  check(c.rec.tick === tickOf(k.t) && (c.clip !== before.clip || c.stepStart !== before.start), 'and undrawn, it is minded all the same: half a minute on it is on another gesture', `${before.clip} then ${c.clip}`)
  at(close, 40, dt)
  const p = c.puppet
  check(p && p.meshes[0].visible && p.meshes[0].material === p.mats.plain && p.mats.uCut.value === 1, 'settled on a rung it draws that tier through the plain material')
  at(out, 1, dt)
  const vis = () => p.meshes.map((m, i) => (m.visible ? i : -1)).filter((i) => i >= 0)
  const both = vis()
  check(both.length === 2 && p.meshes[both[0]].material === p.mats.out && p.meshes[both[1]].material === p.mats.in && p.mats.uCut.value > 0 && p.mats.uCut.value < 1, 'a step down the ladder draws both rungs at once, the old one masked out and the new one in', `tiers ${both.join(' and ')}`)
  at(400, 1, dt)
  check(c.lod === LOD_TIERS && c.puppet === p && vis().length >= 1 && p.mats.uCut.value < 1, 'past the last rung it is not switched off but dissolved')
  let frames = 1
  while (c.puppet && frames < 120) { at(400, 1, dt); frames++ }
  check(!c.puppet && Math.abs(frames / 64 - LOD_FADE_S) < 3 / 64, 'a vanishing takes LOD_FADE_S however far the step was', `${(frames / 64).toFixed(3)} s`)
  k.dispose()
}

// --- a tile that unloads under a drawn snowman does not take it with it ------------------
{
  const { k, c } = lone(3)
  // The biggest of them, whose last rung reaches well past its tile's horizon: that is the only one that can still be drawn once its tile has gone.
  c.size = SIZE_M[1]
  c.k = c.size / k.asset.height
  const close = lodReach(c.size, 0) / 2
  const tile = c.tile
  const [tcx, tcz] = [(tile.tx + 0.5) * TILE, (tile.tz + 0.5) * TILE]
  // Standing 15 m from its tile's centre, toward her: the tile can unload with it still well inside the last rung.
  k._place(c, tcx + 15, tcz, c.heading)
  for (let f = 0; f < 30; f++) frame(k, c.x, c.y + close, c.z)
  const p = c.puppet
  check(p && c.lod === 0 && p.mats.uCut.value === 1, 'settled on the top rung over its tile')
  frame(k, tcx + 97, GROUND + HEAD, tcz)
  check(!k.tiles.has([...k.tiles.keys()].find((kk) => k.tiles.get(kk) === tile)) && c.tile === null && c.loose && c.state === 'cower', 'her 97 m from the tile centre unloads the tile, and the cowering snowman 82 m off is loose', `${k.stats.loose} loose`)
  check(c.puppet === p && k.batch.children.includes(p.group) && p.from === 0 && p.to > p.from && p.to < LOD_TIERS && p.mats.uCut.value < 1, 'and still drawn, stepping down the ladder through a dissolve rather than switched off', `tier ${p.from} to ${p.to}`)
  for (let f = 0; f < 3; f++) frame(k, c.x, c.y + close, c.z)
  const back = [...k.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(back && c.tile === back && !c.loose && !k.loose.includes(c) && alive(k).filter((a) => a.key === c.key).length === 1 && c.puppet === p, 'she comes back and the tile takes it back, the one puppet on it throughout', `${alive(k).filter((a) => a.key === c.key).length} with its key`)
  // Out past its cull but not past the tile horizon -- which only the SMALLEST can be, a big one's last rung reaching further than any tile of it is loaded. So it shrinks to be the other case.
  c.size = SIZE_M[0]
  c.k = c.size / k.asset.height
  const small = cullRange(c.size)
  const far = (small * (1 + LOD_HYSTERESIS) + RADIUS + TILE) / 2
  let frames = 0
  while (c.puppet && frames < 120) { frame(k, c.x + far, GROUND + HEAD, c.z); frames++ }
  check(!c.puppet && c.loose && k.loose.includes(c) && Math.abs(frames * dt - LOD_FADE_S) < 3 / 64, `at ${far.toFixed(0)} m, past its ${small.toFixed(0)} m cull, it has dissolved out over LOD_FADE_S and is loose, undrawn, its slot kept`, `${(frames * dt).toFixed(2)} s`)
  frame(k, c.x + RADIUS + TILE + 1, GROUND + HEAD, c.z)
  check(!c.loose && c.tile === null && k.free.includes(c), `and at ${RADIUS + TILE + 1} m the slot is freed`)
  k.dispose()
}

// --- the ear hears the snowmen ------------------------------------------------------
//
// bodies() is what the ambience reads every frame for the footfall clock: the
// slots themselves, `speed > 0` on the ones on a gait. A cowerer and a watcher
// are listed standing; a hidden layer lists nothing.
{
  const { k, c, at } = lone()
  at(NOTICE_M + 5)
  check(c.state === 'cower' && k.bodies([]).includes(c) && c.speed === 0, 'a cowering snowman is listed, standing')
  face(c, Math.PI / 2 - 0.05)
  at(NOTICE_M - 1, 1, TICK)
  check(c.state === 'watch' && k.bodies([]).includes(c) && c.speed === 0, 'so is a watcher')
  at(6, 5)
  at(6 + AWAY_M + 0.5, 1, TICK)
  check(c.state === 'follow' && c.clip === 'walk' && c.speed > 0 && k.bodies([]).includes(c) && c.cycle === k.durations.walk, 'following her at a walk it moves, carrying the walk clip\'s own length for the footfall clock', `${c.cycle.toFixed(3)} s`)
  face(c, 0)
  frame(k, c.x + RUN_M + 6, GROUND + HEAD, c.z, TICK)
  check(c.clip === 'run' && c.speed > 0 && c.cycle === k.durations.run, 'chasing her at a run it carries the run clip\'s length', `${c.cycle.toFixed(3)} s`)
  k.batch.visible = false
  check(k.bodies([]).length === 0, 'a hidden layer lists nobody')
  k.dispose()
}

console.log(failures ? `\n${failures} failing` : '\nall snowmen checks pass')
process.exit(failures ? 1 : 0)
