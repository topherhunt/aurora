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
// run, that skates, or that holds on to her past its own cull; one that snaps to
// a heading; one lost with its tile while it was still following her, or laid
// twice because it was; a frame that costs more than a scatter is allowed to.
// The shipped GLB is checked for shape too -- the halving ladder over the one
// skeleton, the human clip library, the biped extras, and a bind pose that
// stands on y = 0 facing +X -- because the world loads it by name and builds
// every puppet from it.
//
// What this can NOT check: whether it is unsettling. That needs eyes, in the
// world, at night.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Snowmen, CLIPS, TILE, RADIUS, DENSITY, LOD_TIERS, MAX, PUPPETS, SIZE_M, MAX_SLOPE, HUE,
  NOTICE_M, AWAY_M, STANDOFF_M, RESUME_M, RUN_M, FORGET_M, TURN_RATE,
} from '../src/v2/render/snowmen.js'
import { CRITTER_GLB, LOD_HYSTERESIS, critterTier, cullRange, lodReach } from '../src/v2/render/critters.js'
import { LOD_FADE_S } from '../src/v2/render/puppet.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

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

// --- a stand-in asset: a slab on a two-bone skeleton, the shipped numbers ---------
function makeAsset() {
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0, 0.5, 0)
  root.add(spine)
  root.updateMatrixWorld(true)
  const bones = [root, spine]
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
  return { root, skeleton, tiers, clips, map: null, extras: biped, ...biped }
}

// --- construction ---------------------------------------------------------------
const scene = new THREE.Scene()
const make = (seed, world = { walk, water, height }) =>
  new Snowmen(scene, world.height, world.water, { seed, walk: world.walk, asset: makeAsset() })
const w = make(7)
check(w.loaded && w.asset.height === biped.height && w.asset.gait.run === biped.gait.run, 'the snowman is loaded, with its extras spread on the asset')
check(w.puppets.length === PUPPETS && w.freePuppets.length === PUPPETS && w.slots.length === MAX && w.free.length === MAX, `${PUPPETS} puppets and ${MAX} slots, all free`)
check(w.materials.length === PUPPETS * 3, 'three materials a puppet -- settled, dissolving in, dissolving out -- all offered to the lighting')
check(w.puppetMats.every((m) => m.plain.customProgramCacheKey() === 'snowmen' && m.in.customProgramCacheKey() === 'snowmen-fade' && m.out.customProgramCacheKey() === 'snowmen-fade') && new Set(w.materials.map((m) => m.customProgramCacheKey())).size === 2, 'two programs and not one a puppet')
check(w.batch.name === 'v2-snowmen' && w.batch.children.length === 0, 'nothing is in the batch but the puppets it lends out')
check(w.puppets.every((p) => p.skeleton !== w.asset.skeleton && p.skeleton.bones.length === 2 && p.meshes.length === LOD_TIERS && p.meshes.every((m) => m.skeleton === p.skeleton && !m.visible) && !p.group.matrixAutoUpdate && p.actions.size === json.animations.length), 'each puppet has its own copy of the skeleton, every shared tier bound to it, none shown, and an action per clip')
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
    k.place(0, 0)
    tiles += k.tiles.size
    overflow += k.overflow
    count += MAX - k.free.length
    k.dispose()
    const low = make(seed, { walk: plainAt(SNOW_LINE - 0.01), water: noWater, height })
    low.place(0, 0)
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
w.place(0, 0)
{
  const pool = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed)
    k.place(0, 0)
    for (const c of alive(k)) pool.push({ x: c.x, y: c.y, z: c.z, size: c.size, k: c.k, hue: c.hue, nx: c.nx, ny: c.ny, nz: c.nz, state: c.state, clip: c.clip })
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
  check(pool.every((c) => Math.hypot(c.nx, c.ny, c.nz) - 1 < 1e-9), 'each carries the unit normal of the ground it stands on')
  const sizes = pool.map((c) => c.size)
  check(sizes.every((s) => s >= SIZE_M[0] && s <= SIZE_M[1]) && Math.min(...sizes) < SIZE_M[0] + 0.2 && Math.max(...sizes) > SIZE_M[1] - 0.2, `a snowman is ${SIZE_M[0]} to ${SIZE_M[1]} m tall, and the range is walked`, `${Math.min(...sizes).toFixed(2)} to ${Math.max(...sizes).toFixed(2)} m`)
  check(pool.every((c) => Math.abs(c.k - c.size / biped.height) < 1e-9), 'and wears the scale that makes it so')
  const hues = new Set(pool.map((c) => c.hue.toFixed(4)))
  check(hues.size > pool.length / 2 && pool.every((c) => Math.abs(c.hue) <= HUE), `each wears its own hue within ${HUE}`, `${hues.size} hues in ${pool.length}`)
  check(pool.every((c) => c.state === 'cower' && ['cower', 'recoil', 'idle'].includes(c.clip)), 'every one is found cowering', [...new Set(pool.map((c) => c.clip))].join(' '))
  // Determinism: the same seed lays the same snowmen twice.
  const key = (of) => alive(of).map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  const again = make(7)
  again.place(0, 0)
  check(key(again) === key(w) && alive(w).length > 0, 'the scatter is a pure function of the seed', `${alive(w).length} snowmen`)
  const kept = alive(again).filter((c) => Math.hypot(c.x, c.z) < 30).map((c) => ({ c, x: c.x, z: c.z }))
  again.update(TILE, GROUND + 1.6, 0, 0)
  check(kept.every(({ c, x, z }) => c.tile !== null && c.x === x && c.z === z), 'a step of one tile leaves the snowmen she keeps exactly where they were', `${kept.length} kept`)
  again.dispose()
}

// --- what one does, by her distance --------------------------------------------------
//
// One snowman on the open shoulder, her head moved about it. dt 0 where only
// the state is asked, real frames where it has to turn or walk.
const HEAD = 1.6
const dt = 1 / 60
function lone(seed = 3) {
  const k = make(seed, { walk: plain, water: noWater, height })
  k.place(0, 0)
  const c = alive(k)[0]
  return { k, c, at: (d, frames = 1, step = 0) => { for (let f = 0; f < frames; f++) k.update(c.x + d, GROUND + HEAD, c.z, step) } }
}
{
  const { k, c, at } = lone()
  const d = k.durations
  // Cowering: cower and recoil in whole cycles, a still stand between, nothing else, whichever way it happened to face.
  const acts = new Set()
  let whole = true
  const heading = c.heading
  for (let i = 0; i < 400; i++) {
    k._step(c)
    acts.add(c.clip)
    if (c.clip !== 'idle' && Math.abs(c.left / d[c.clip] - Math.round(c.left / d[c.clip])) > 1e-9) whole = false
    if (c.speed !== 0) whole = false
  }
  check([...acts].sort().join() === 'cower,idle,recoil' && whole, 'cowering is cower and recoil in whole cycles with a stand between, and it does not move', [...acts].join(' '))
  // She comes at it from +x. It notices her only inside NOTICE_M on the side it faces: not from behind, not from beside, not a metre too far.
  const facing = (rad) => { c.heading = c.aim = rad }
  facing(Math.PI)
  at(NOTICE_M - 1, 60, dt)
  check(c.state === 'cower' && c.heading === Math.PI, `${NOTICE_M - 1} m behind it she is nothing to it`, c.clip)
  facing(Math.PI / 2 + 0.05)
  at(NOTICE_M - 1, 60, dt)
  check(c.state === 'cower', 'nor just past its shoulder')
  facing(heading)
  at(NOTICE_M + 1, 60, dt)
  check(c.state === 'cower' && c.heading === heading, `nor ${NOTICE_M + 1} m off, whichever way it faces`, c.clip)
  facing(Math.PI / 2 - 0.05)
  at(NOTICE_M - 1)
  check(c.state === 'watch', `just inside its shoulder at ${NOTICE_M - 1} m it notices her`)
  // Noticed: it turns to her, and keeps turning to her wherever she goes.
  at(NOTICE_M - 1, 240, dt)
  check(Math.abs(swing(c.heading, Math.atan2(0, 1))) < 1e-6, 'and four seconds later it is facing her', `${c.heading.toFixed(4)} rad`)
  for (let f = 0; f < 240; f++) k.update(c.x, GROUND + HEAD, c.z + NOTICE_M - 1, dt)
  check(Math.abs(swing(c.heading, -Math.PI / 2)) < 1e-6, 'she steps round it and it turns to keep her in front', `${c.heading.toFixed(4)} rad`)
  const gestures = new Set()
  let timed = true
  for (let i = 0; i < 400; i++) {
    k._step(c)
    gestures.add(c.clip)
    if (c.clip !== 'idle' && Math.abs(c.left - d[c.clip]) > 1e-9) timed = false
    if (c.speed !== 0) timed = false
  }
  check(gestures.has('beckon') && gestures.has('idle') && [...gestures].every((g) => ['beckon', 'talk-gesture', 'talk-point', 'talk-nod', 'talk-shrug', 'idle'].includes(g)) && gestures.size >= 5 && timed, 'watching, it beckons and talks with its hands, each gesture once through, and stares between', [...gestures].join(' '))
  // Approaching does nothing; the first step back does.
  const near = 6
  for (const dd of [NOTICE_M - 1, 8, near]) at(dd, 5, dt)
  check(c.state === 'watch' && Math.abs(c.near - Math.hypot(near, HEAD)) < 1e-9, `she walks up to ${near} m and it only watches`, `near ${c.near.toFixed(2)}`)
  at(near + AWAY_M - 0.5, 5, dt)
  check(c.state === 'watch', `she backs off ${AWAY_M - 0.5} m and it only watches`)
  at(near + AWAY_M + 0.5)
  check(c.state === 'follow' && c.clip === 'walk' && Math.abs(c.speed - biped.gait.walk * c.k) < 1e-12, `she backs off ${AWAY_M + 0.5} m and it comes after her, at a walk`, `${c.speed.toFixed(2)} m/s for a ${c.size.toFixed(2)} m snowman`)
  // She stands: it closes to the standoff, and stops there to watch.
  const [hx, hz] = [c.x + near + AWAY_M + 0.5, c.z]
  let closest = Infinity
  let farthest = 0
  for (let f = 0; f < 900; f++) {
    k.update(hx, GROUND + HEAD, hz, dt)
    const dist = Math.hypot(c.x - hx, c.z - hz)
    if (f > 600) { closest = Math.min(closest, dist); farthest = Math.max(farthest, dist) }
  }
  check(c.state === 'follow' && c.speed === 0 && closest > STANDOFF_M - HEAD && farthest < STANDOFF_M + RESUME_M, `it walks up to ${STANDOFF_M} m of her and stops there`, `${closest.toFixed(2)} to ${farthest.toFixed(2)} m over the last five seconds, ${c.clip}`)
  check(Math.abs(swing(c.heading, Math.atan2(-(hz - c.z), hx - c.x))) < 1e-6, 'facing her')
  // She runs: it runs.
  // Facing her exactly, so the ground covered is the gait alone and not a curve.
  const far = RUN_M + 6
  c.heading = 0
  const [rx, rz] = [c.x + far, c.z]
  k.update(rx, GROUND + HEAD, rz, dt)
  check(c.state === 'follow' && c.clip === 'run' && Math.abs(c.speed - biped.gait.run * c.k) < 1e-12, `${far} m off she is chased at a run`, `${c.speed.toFixed(2)} m/s`)
  const [x0, z0] = [c.x, c.z]
  for (let f = 0; f < 30; f++) k.update(rx, GROUND + HEAD, rz, dt)
  check(Math.abs(Math.hypot(c.x - x0, c.z - z0) - c.speed * dt * 30) < 1e-6, 'and covers exactly the ground its clip was built for -- it does not skate')
  let walked = false
  for (let f = 0; f < 900 && !walked; f++) { k.update(rx, GROUND + HEAD, rz, dt); walked = c.clip === 'walk' }
  check(walked && Math.hypot(c.x - rx, c.z - rz) < RUN_M, `and drops to a walk inside ${RUN_M} m`, `${Math.hypot(c.x - rx, c.z - rz).toFixed(2)} m`)
  // Forgotten past FORGET_M, in any state, and not a metre before.
  k.update(c.x + FORGET_M - 1, GROUND + HEAD, c.z, dt)
  check(c.state === 'follow', `${FORGET_M - 1} m off it still follows`)
  k.update(c.x + FORGET_M + 1, GROUND + HEAD, c.z, dt)
  check(c.state === 'cower' && c.homeX === c.x && c.homeZ === c.z && c.speed === 0, `${FORGET_M + 1} m off it forgets her and cowers where it stands`, c.clip)
  at(NOTICE_M - 1)
  k.update(c.x + FORGET_M + 1, GROUND + HEAD, c.z, dt)
  check(c.state === 'cower', 'a watcher forgets her past it too')
  k.dispose()
}

// --- it turns, and never snaps ------------------------------------------------------
{
  const { k, c, at } = lone(5)
  c.heading = c.aim = 0
  at(NOTICE_M - 1)
  c.heading = Math.PI
  let worst = 0
  let frames = 0
  let prev = c.heading
  // The hardest turn there is: she is right behind it.
  while (Math.abs(swing(c.heading, 0)) > 1e-9 && frames < 600) {
    at(NOTICE_M - 1, 1, dt)
    worst = Math.max(worst, Math.abs(swing(prev, c.heading)))
    prev = c.heading
    frames++
  }
  check(frames >= Math.PI / TURN_RATE / dt && worst <= TURN_RATE * dt + 1e-12, 'an about-face to her is turned through, not snapped to', `${(frames * dt).toFixed(2)} s at up to ${(worst / dt).toFixed(2)} rad/s`)
  // A minute of her circling it at a run, then dragging it about: every heading of every frame.
  let snapped = 0
  let was = c.heading
  for (let f = 0; f < 3600; f++) {
    const a = f * dt * 1.2
    const r = 8 + 20 * Math.abs(Math.sin(f * dt * 0.15))
    k.update(c.x + Math.cos(a) * r, GROUND + HEAD, c.z + Math.sin(a) * r, dt)
    snapped = Math.max(snapped, Math.abs(swing(was, c.heading)))
    was = c.heading
  }
  check(snapped <= TURN_RATE * dt + 1e-12, 'in a minute of being circled and led about, it never turned faster than it may', `worst ${(snapped / dt).toFixed(3)} rad/s of ${TURN_RATE}`)
  k.dispose()
}

// --- it walks round what it cannot cross, and off the snow after her ------------------
{
  // The mountain around her, and a snowman whose tile stays loaded while she moves a few metres: moved to where the test wants it, facing her.
  const stage = (hx, hz, x, z) => {
    for (let seed = 1; ; seed++) {
      const k = make(seed)
      k.place(hx, hz)
      const c = alive(k).find((a) => Math.hypot((a.tile.tx + 0.5) * TILE - hx, (a.tile.tz + 0.5) * TILE - hz) < RADIUS - 10)
      if (!c) { k.dispose(); continue }
      c.x = x; c.z = z; c.y = fieldAt(x, z)
      c.heading = c.aim = Math.atan2(-(hz - z), hx - x)
      return { k, c }
    }
  }
  // It faces the tarn from the near rim; she is noticed on that rim, then crosses to the far one.
  const [hx, hz] = [TARN.x - TARN.r - 1, TARN.z]
  const { k, c } = stage(hx, hz, hx - NOTICE_M + 1, TARN.z)
  k.update(hx, fieldAt(hx, hz) + HEAD, hz, dt)
  check(c.state === 'watch', 'it sees her on the near rim of the tarn')
  const far = TARN.x + TARN.r + 2
  let wet = 0
  let ms = 0
  for (let f = 0; f < 3600; f++) {
    const t0 = performance.now()
    k.update(far, fieldAt(far, hz) + HEAD, hz, dt)
    ms += performance.now() - t0
    if (water.isSubmerged(c.x, c.z, c.y)) wet++
  }
  check(c.state === 'follow' && c.speed === 0 && Math.hypot(c.x - far, c.z - hz) < STANDOFF_M + RESUME_M + 0.5, 'she crosses to the far rim and a minute later it stands at her side of it', `${Math.hypot(c.x - far, c.z - hz).toFixed(2)} m from her`)
  check(wet === 0, 'having gone round, not through', `${wet} wet frames`)
  check(alive(k).every((a) => Math.abs(a.y - fieldAt(a.x, a.z)) < 1e-9 && !water.isSubmerged(a.x, a.z, a.y) && Math.acos(Math.min(1, walk.normalAt(a.x, a.z).y)) <= MAX_SLOPE + 1e-9 && TRUNKS.every((t) => Math.hypot(a.x - t.x, a.z - t.z) > t.r)), 'everybody is on the ground, and nobody in the water, up the crag or through a trunk')
  check(ms / 3600 < 1.5, `a frame of ${alive(k).length} snowmen costs under 1.5 ms`, `${(ms / 3600).toFixed(3)} ms`)
  k.dispose()
  // Led down the slope: it follows her under the snow line, where none is ever placed, and out of its tile.
  let [lx, lz] = [0, SLOPE_Z]
  const led = stage(lx, lz, lx, lz + NOTICE_M - 1)
  led.k.update(lx, fieldAt(lx, lz) + HEAD, lz, dt)
  for (let f = 0; f < 3600; f++) {
    lz -= 1.5 * dt
    led.k.update(lx, fieldAt(lx, lz) + HEAD, lz, dt)
  }
  check(led.c.state === 'follow' && led.c.y < SNOW_LINE - 5 && Math.hypot(led.c.x - lx, led.c.z - lz) < RUN_M, 'led down the slope for a minute, it follows her well below the snow line', `at ${led.c.y.toFixed(1)} m, ${Math.hypot(led.c.x - lx, led.c.z - lz).toFixed(1)} m behind her`)
  led.k.dispose()
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
  c.heading = c.aim = 0
  let hx = c.x + NOTICE_M - 1
  k.update(hx, GROUND + HEAD, c.z, dt)
  hx += AWAY_M + 1
  // She walks straight on for a minute, faster than it walks and slower than it runs.
  for (let f = 0; f < 3600; f++) {
    hx += 3 * dt
    k.update(hx, GROUND + HEAD, c.z, dt)
  }
  check(!k.tiles.has([...k.tiles.keys()].find((kk) => k.tiles.get(kk) === tile)) && c.tile === null && c.loose && k.loose.includes(c) && c.key === key, 'its tile has unloaded behind it and it is loose', `${k.stats.loose} loose, ${k.stats.states.follow} following`)
  check(c.state === 'follow' && Math.hypot(c.x - hx, c.z - homeZ) < RUN_M + 1 && c.puppet && k.batch.children.includes(c.puppet.group), 'still following her, still drawn', `${Math.hypot(c.x - hx, c.z - homeZ).toFixed(1)} m behind her, ${(hx - homeX).toFixed(0)} m from home`)
  // She goes back for the tile: the snowman it would lay is the one already out, so the tile takes that one back.
  k.update(homeX, GROUND + HEAD, homeZ, dt)
  const home = [...k.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(c.state === 'cower' && !c.loose && c.tile === home && home.animals.includes(c) && !k.loose.includes(c) && alive(k).filter((a) => a.key === key).length === 1, 'its home tile re-entered while it is loose takes it back, once, where it stands, and it forgets her at that distance', `${alive(k).filter((a) => a.key === key).length} with its key`)
  // And out past the tile horizon, on the far side from its home tile, it dissolves and is freed.
  const [lx, lz] = [c.x + RADIUS + TILE + 2, c.z]
  let frames = 0
  while ((c.tile || c.loose) && frames < 120) { k.update(lx, GROUND + HEAD, lz, dt); frames++ }
  check(!k.loose.includes(c) && c.tile === null && !c.loose && !c.puppet && k.free.includes(c) && Math.abs(frames * dt - LOD_FADE_S) < 3 / 60, `once she is ${RADIUS + TILE} m from a forgotten loose one it dissolves out and is freed`, `${(frames * dt).toFixed(2)} s`)
  check(k.freePuppets.length === PUPPETS - (k.batch.children.length), 'the pools balance')
  k.place(homeX, homeZ)
  const back = alive(k).find((a) => a.key === key)
  check(back && back.x === homeX && back.z === homeZ && back.state === 'cower', 'and laid again from its tile, it is home and cowering')
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
    return Array.from({ length: LOD_TIERS }, (_, i) => lodReach(m, i)).flatMap((d) => [d * (1 - step), d * (1 + step)]).map((d) => { for (let f = 0; f < 3; f++) k.update(c.x, c.y + d, c.z, 0); return c.lod })
  }
  const [small, big] = [walkOut(SIZE_M[0]), walkOut(SIZE_M[1])]
  check(small.join() === big.join() && small.join() === '0,1,1,2,2,3,3,4', `a ${SIZE_M[0]} m and a ${SIZE_M[1]} m snowman walk the same ladder, one at ${SIZE_M[1] / SIZE_M[0]}x the other's distances`, `${lodReach(SIZE_M[0], 0).toFixed(0)} m against ${lodReach(SIZE_M[1], 0).toFixed(0)} m for the top rung`)
  k.dispose()
}

// --- drawn, or not drawn; nothing pops ---------------------------------------------------
{
  const { k, c } = lone(3)
  const at = (d, frames = 2, step = 0) => { for (let f = 0; f < frames; f++) k.update(c.x, c.y + d, c.z, step); return c.lod }
  const settle = (d) => at(d, Math.ceil(LOD_FADE_S * 60) + 2, dt)
  // Read off its own height, because that is what the ladder is a ratio of.
  const expect = (d) => critterTier(c.size, d, -1, LOD_TIERS)
  const close = lodReach(c.size, 0) / 2
  const out = lodReach(c.size, LOD_TIERS - 1) * 0.9
  const near = settle(close)
  check(near === 0 && expect(close) === 0 && c.puppet && k.batch.children.includes(c.puppet.group), `${close.toFixed(0)} metres over it -- half of what the top rung holds -- the snowman is a puppet in the scene, on the top rung`)
  check(c.puppet.current.getClip().name === c.clip && c.puppet.current.isRunning() && c.puppet.mats.uHue.value === c.hue, 'playing what it is doing, in its own hue', c.clip)
  {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    c.puppet.group.matrix.decompose(p, q, s)
    const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(c.nx, c.ny, c.nz))
    const want = tilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.heading))
    check(p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-6 && Math.abs(s.x - c.k) < 1e-9 && Math.abs(q.dot(want)) > 1 - 1e-9, 'standing where it is, at its own size, facing its heading on the ground it stands on', `scale ${s.x.toFixed(3)}`)
  }
  const gone = settle(400)
  check(gone === LOD_TIERS && expect(400) === LOD_TIERS && !c.puppet && k.freePuppets.length === PUPPETS, 'four hundred metres off it is not drawn at all, and the pool is whole')
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
  check(!c.puppet && Math.abs(frames / 60 - LOD_FADE_S) < 3 / 60, 'a vanishing takes LOD_FADE_S however far the step was', `${(frames / 60).toFixed(3)} s`)
  k.dispose()
}

// --- a tile that unloads under a drawn snowman does not take it with it ------------------
{
  const { k, c } = lone(3)
  // The biggest of them, whose last rung reaches well past its tile's horizon: that is the only one that can still be drawn once its tile has gone.
  c.size = SIZE_M[1]
  c.k = c.size / k.asset.height
  const close = lodReach(c.size, 0) / 2
  const cull = cullRange(c.size)
  const tile = c.tile
  const [tcx, tcz] = [(tile.tx + 0.5) * TILE, (tile.tz + 0.5) * TILE]
  // Standing 15 m from its tile's centre, toward her: the tile can unload with it still well inside the last rung.
  c.x = tcx + 15; c.z = tcz
  for (let f = 0; f < 30; f++) k.update(c.x, c.y + close, c.z, dt)
  const p = c.puppet
  check(p && c.lod === 0 && p.mats.uCut.value === 1, 'settled on the top rung over its tile')
  k.update(tcx + 97, GROUND + HEAD, tcz, dt)
  check(!k.tiles.has([...k.tiles.keys()].find((kk) => k.tiles.get(kk) === tile)) && c.tile === null && c.loose && c.state === 'cower', 'her 97 m from the tile centre unloads the tile, and the cowering snowman 82 m off is loose', `${k.stats.loose} loose`)
  check(c.puppet === p && k.batch.children.includes(p.group) && p.from === 0 && p.to > p.from && p.to < LOD_TIERS && p.mats.uCut.value < 1, 'and still drawn, stepping down the ladder through a dissolve rather than switched off', `tier ${p.from} to ${p.to}`)
  for (let f = 0; f < 3; f++) k.update(c.x, c.y + close, c.z, dt)
  const back = [...k.tiles.values()].find((t) => t.tx === tile.tx && t.tz === tile.tz)
  check(back && c.tile === back && !c.loose && !k.loose.includes(c) && alive(k).filter((a) => a.key === c.key).length === 1 && c.puppet === p, 'she comes back and the tile takes it back, the one puppet on it throughout', `${alive(k).filter((a) => a.key === c.key).length} with its key`)
  // Out past its cull but not past the tile horizon -- which only the SMALLEST can be, a big one's last rung reaching further than any tile of it is loaded. So it shrinks to be the other case.
  c.size = SIZE_M[0]
  c.k = c.size / k.asset.height
  const small = cullRange(c.size)
  const far = (small * (1 + LOD_HYSTERESIS) + RADIUS + TILE) / 2
  let frames = 0
  while (c.puppet && frames < 120) { k.update(c.x + far, GROUND + HEAD, c.z, dt); frames++ }
  check(!c.puppet && c.loose && k.loose.includes(c) && Math.abs(frames * dt - LOD_FADE_S) < 3 / 60, `at ${far.toFixed(0)} m, past its ${small.toFixed(0)} m cull, it has dissolved out over LOD_FADE_S and is loose, undrawn, its slot kept`, `${(frames * dt).toFixed(2)} s`)
  k.update(c.x + RADIUS + TILE + 1, GROUND + HEAD, c.z, dt)
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
  c.heading = c.aim = Math.PI / 2 - 0.05
  at(NOTICE_M - 1)
  check(c.state === 'watch' && k.bodies([]).includes(c) && c.speed === 0, 'so is a watcher')
  at(6, 5, dt)
  at(6 + AWAY_M + 0.5)
  check(c.state === 'follow' && c.clip === 'walk' && c.speed > 0 && k.bodies([]).includes(c) && c.cycle === k.durations.walk, 'following her at a walk it moves, carrying the walk clip\'s own length for the footfall clock', `${c.cycle.toFixed(3)} s`)
  c.heading = 0
  k.update(c.x + RUN_M + 6, GROUND + HEAD, c.z, dt)
  check(c.clip === 'run' && c.speed > 0 && c.cycle === k.durations.run, 'chasing her at a run it carries the run clip\'s length', `${c.cycle.toFixed(3)} s`)
  k.batch.visible = false
  check(k.bodies([]).length === 0, 'a hidden layer lists nobody')
  k.dispose()
}

console.log(failures ? `\n${failures} failing` : '\nall snowmen checks pass')
process.exit(failures ? 1 : 0)
