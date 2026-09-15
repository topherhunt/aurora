// Node-side gates for the wildlife (src/v2/render/wildlife.js).
//
//   node scripts/check-wildlife.mjs
//
// The scatter runs against a synthetic moor: rolling ground, a pond in a basin,
// a crag too steep to stand on, two tree trunks, and a long ramp rising into the
// snow at the far edge. Everything below is a way an animal can go wrong without
// anything throwing: a scatter that is not one per 3000 square metres of each,
// or that is not the same twice; an animal standing in the water, up the crag,
// inside a trunk or in the snow; one that never moves, that skates (ground speed
// that is not the clip's stride), or that wanders off its tether; a graze that
// is not eat-down, chews, eat-up, or a sit that loops instead of playing its one
// round trip; a body that snaps to a new heading in a frame instead of turning
// to it; an animal that takes any notice of her; an animal in sight drawn as
// anything but its own animated puppet, or one drawn past the last rung; a herd
// that does not settle after dark; a frame that costs more than a scatter is
// allowed to. The three shipped GLBs are checked for shape too -- one skinned
// mesh, the whole clip library, the quadruped extras, and a bind pose that
// stands on y = 0 with its long axis on +X -- because the world loads them by
// name and builds every puppet from them.
//
// What this can NOT check: whether a stag reads as a stag, or whether the
// behaviour looks like grazing. That needs eyes, in the world.

import * as THREE from 'three'
import fs from 'node:fs'
import {
  Wildlife, SPECIES, CLIPS, ONE_SHOT, TILE, RADIUS, DENSITY, LOD_DEG, MAX, NIGHT_REST, PUPPETS, MAX_SLOPE, SNOW_MARGIN, TETHER_M, TURN_RATE,
} from '../src/v2/render/wildlife.js'
import { CRITTER_GLB, critterTier } from '../src/v2/render/critters.js'
import { CREATURES, shipTexPx } from '../tools/creatures/creature-roster.mjs'
import { readAccessor, readGlb } from '../tools/creatures/apply-rig-edit.mjs'
import { webpSize } from '../tools/tripo-pack.mjs'

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`)
}

// --- the synthetic moor ---------------------------------------------------------
const GROUND = 4
const SNOW_LINE = 30
// The ground climbs this steeply past RAMP_Z, so it crosses SNOW_LINE - SNOW_MARGIN at SNOW_Z while staying far gentler than MAX_SLOPE.
const RAMP_Z = 40
const RAMP = 0.35
const SNOW_Z = RAMP_Z + (SNOW_LINE - SNOW_MARGIN - GROUND) / RAMP
// A cone nine metres up over seven across: every face of it is 52 degrees.
const CRAG = { x: -36, z: 18, r: 7, h: 9 }
// A basin two metres deep, its water a hand over the rim's foot.
const POND = { x: 40, z: -24, r: 9, depth: 2, level: GROUND + 0.3 }
const TRUNKS = [{ x: 6, z: 6, r: 0.9 }, { x: -14, z: -30, r: 1.4 }]

const conical = (c, x, z) => Math.max(0, 1 - Math.hypot(x - c.x, z - c.z) / c.r)
function fieldAt(x, z) {
  let h = GROUND + 0.6 * Math.sin(x * 0.05) * Math.cos(z * 0.045)
  h += CRAG.h * conical(CRAG, x, z)
  h -= POND.depth * conical(POND, x, z)
  if (z > RAMP_Z) h += RAMP * (z - RAMP_Z)
  return h
}
const walk = {
  heightAt: fieldAt,
  normalAt(x, z, eps = 0.25, out = { x: 0, y: 1, z: 0 }) {
    const dx = (fieldAt(x + eps, z) - fieldAt(x - eps, z)) / (2 * eps)
    const dz = (fieldAt(x, z + eps) - fieldAt(x, z - eps)) / (2 * eps)
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
}
const height = { snowLineAt: () => SNOW_LINE }
const water = { isSubmerged: (x, z, y) => Math.hypot(x - POND.x, z - POND.z) < POND.r && y < POND.level }

// The same moor with nothing on it, for counting the scatter's rate against its own area.
const plain = {
  heightAt: () => GROUND,
  normalAt: (x, z, eps, out = { x: 0, y: 1, z: 0 }) => { out.x = 0; out.y = 1; out.z = 0; return out },
  obstacleAt: () => null,
}
const noWater = { isSubmerged: () => false }

// --- the shipped assets ---------------------------------------------------------
const shipped = {}
for (const sp of SPECIES) {
  const url = CRITTER_GLB[sp.key]
  const file = new URL(`../public/${url}`, import.meta.url)
  if (!fs.existsSync(file)) {
    check(false, `${url} is shipped -- run tools/creatures/ship-quadruped.mjs`)
    continue
  }
  const { json, bin } = readGlb(file)
  shipped[sp.key] = { url, file, json, bin }
  const id = url.replace(/^creatures\//, '').replace(/\.glb$/, '')
  const roster = CREATURES.find((c) => c.id === id)

  const meshes = json.meshes ?? []
  check(meshes.length === 1 && meshes[0].primitives.length === 1, `${id}: one mesh of one primitive -- these carry no LOD ladder`, `${meshes.length} meshes`)
  const prim = meshes[0]?.primitives[0]
  const tris = prim ? json.accessors[prim.indices].count / 3 : 0
  check(prim?.attributes.JOINTS_0 !== undefined && prim.attributes.WEIGHTS_0 !== undefined && prim.attributes.NORMAL !== undefined && prim.attributes.TEXCOORD_0 !== undefined && prim.material === 0, `${id}: the mesh is skinned, with normals and UVs, on the one material`, `${tris} tris`)
  check(json.skins?.length === 1 && (json.nodes ?? []).filter((n) => n.skin !== undefined).length === 1, `${id}: one skeleton, worn by the one mesh node`, `${json.skins?.[0]?.joints.length} joints`)

  const clips = (json.animations ?? []).map((a) => a.name)
  check(CLIPS.every((n) => clips.includes(n)) && clips.length === CLIPS.length, `${id}: the whole clip library, ${CLIPS.length} clips`, clips.join(' '))
  const joints = new Set(json.skins?.[0]?.joints ?? [])
  check((json.animations ?? []).every((a) => a.channels.every((ch) => joints.has(ch.target.node))), `${id}: every clip channel targets a joint of the skeleton`)
  const durs = Object.fromEntries((json.animations ?? []).map((a) => [a.name, Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))]))
  check((json.animations ?? []).every((a) => a.samplers.every((s) => json.accessors[s.input].min !== undefined)) && Object.values(durs).every((d) => d > 0.2), `${id}: every sampler carries min and max, and no clip is shorter than 0.2 s`, Object.entries(durs).map(([n, d]) => `${n} ${d.toFixed(2)}`).join(' '))

  const quad = json.scenes?.[json.scene ?? 0]?.extras?.quadruped
  check(quad !== undefined && quad.span > 0 && quad.height > 0 && quad.width > 0 && quad.sizeM === roster.sizeM && quad.frame && Number.isFinite(quad.frame.yaw), `${id}: the scene carries the quadruped extras, at the roster's ${roster.sizeM} m`, quad && `span ${quad.span.toFixed(3)} width ${quad.width.toFixed(3)} height ${quad.height.toFixed(3)} yaw ${quad.frame.yaw.toFixed(3)}`)
  check(quad && ['walk', 'trot', 'run'].every((n) => quad.gait[n] > 0) && quad.gait.walk < quad.gait.trot && quad.gait.trot < quad.gait.run && quad.gait.idle === undefined, `${id}: the gaits carry a ground speed each, walk under trot under run, and nothing else does`, quad && Object.entries(quad.gait).map(([n, v]) => `${n} ${v.toFixed(3)}`).join(' '))

  // The bind pose IS the POSITION accessor (every skin matrix is the identity
  // there), so the frame the root joint carries can be checked by applying it:
  // the body stands on y = 0, centred over its feet, long axis on +X.
  if (quad && prim) {
    const p = readAccessor(json, bin, prim.attributes.POSITION)
    const c = Math.cos(quad.frame.yaw), s = Math.sin(quad.frame.yaw)
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i += 3) {
      const v = [c * p[i] + s * p[i + 2] + quad.frame.t[0], p[i + 1] + quad.frame.t[1], -s * p[i] + c * p[i + 2] + quad.frame.t[2]]
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]) }
    }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    check(Math.abs(lo[1]) < 1e-4 && Math.abs(lo[0] + hi[0]) < 1e-4 && Math.abs(lo[2] + hi[2]) < 1e-4, `${id}: framed, the bind pose stands on y = 0 with its feet under its middle`, `y from ${lo[1].toExponential(2)}, mid x ${((lo[0] + hi[0]) / 2).toExponential(2)} z ${((lo[2] + hi[2]) / 2).toExponential(2)}`)
    check(Math.abs(ext[0] - quad.span) < 1e-4 && Math.abs(ext[1] - quad.height) < 1e-4 && Math.abs(ext[2] - quad.width) < 1e-4 && ext[0] > ext[2], `${id}: the extras are those extents, and the body is longer than it is wide -- it faces +X`, `${ext.map((e) => e.toFixed(3)).join(' x ')}`)
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
if (Object.keys(shipped).length !== SPECIES.length) {
  console.log(`\n${failures} failing -- the GLBs must ship before the scatter can be checked`)
  process.exit(1)
}

// --- stand-in assets: a slab on a two-bone skeleton, the shipped numbers ---------
function makeAsset(key) {
  const { json } = shipped[key]
  const quad = json.scenes[json.scene ?? 0].extras.quadruped
  const root = new THREE.Bone()
  root.name = 'tripo::Root'
  const spine = new THREE.Bone()
  spine.name = 'Spine'
  spine.position.set(0.2, 0.1, 0)
  root.add(spine)
  root.updateMatrixWorld(true)
  const bones = [root, spine]
  const skeleton = new THREE.Skeleton(bones, bones.map((b) => b.matrixWorld.clone().invert()))
  const geometry = new THREE.BoxGeometry(quad.span, quad.height, quad.width).translate(0, quad.height / 2, 0)
  const n = geometry.getAttribute('position').count
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2))
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4))
  const clips = json.animations.map((a) => {
    const dur = Math.max(...a.samplers.map((s) => json.accessors[s.input].max[0]))
    return new THREE.AnimationClip(a.name, dur, [new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0, dur], [0, 0, 0, 1, 0, 0, 0, 1])])
  })
  return { root, skeleton, geometry, clips, map: null, gait: quad.gait, sizeM: quad.sizeM, span: quad.span }
}
const assets = () => Object.fromEntries(SPECIES.map((sp) => [sp.key, makeAsset(sp.key)]))

// --- construction ---------------------------------------------------------------
const scene = new THREE.Scene()
const make = (seed, world = { walk, water, height }) =>
  new Wildlife(scene, world.height, world.water, { seed, walk: world.walk, assets: assets() })
const w = make(7)
check(w.loaded && w.species.length === 3 && w.species.map((s) => s.key).join(',') === 'stag,fox,hare', 'the three of them are loaded')
check(w.species.every((sp) => sp.puppets.length === PUPPETS && sp.freePuppets.length === PUPPETS && sp.slots.length === MAX && sp.free.length === MAX), `${PUPPETS} puppets and ${MAX} slots a species, all free`)
check(w.materials.length === 3 * PUPPETS, 'a material per puppet, all offered to the lighting')
check(w.species.every((sp) => sp.materials.every((m) => m.customProgramCacheKey() === `wildlife-${sp.key}`)) && new Set(w.materials.map((m) => m.customProgramCacheKey())).size === 3, 'one program a species, not one a puppet')
check(w.batch.children.length === 0, 'nothing is in the batch but the puppets it lends out -- there is no card mesh to draw')
check(w.species.every((sp) => sp.puppets.every((p) => p.skeleton !== sp.asset.skeleton && p.skeleton.bones.length === 2 && p.mesh.skeleton === p.skeleton && !p.group.matrixAutoUpdate && p.actions.size === CLIPS.length)), 'each puppet has its own copy of the skeleton, the shared geometry bound to it, and an action per clip')
check(w.species.every((sp) => sp.puppets.every((p) => [...p.actions].every(([name, a]) => (ONE_SHOT.has(name) ? a.loop === THREE.LoopOnce && a.clampWhenFinished : a.loop === THREE.LoopRepeat)))), `${[...ONE_SHOT].join(', ')} play once and hold, the rest cycle`)
{
  const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>\n', fragmentShader: '#include <common>\n#include <map_fragment>\n' }
  w.materials[0].onBeforeCompile(shader)
  check(shader.uniforms.uHue === w.materials[0].userData.uHue && shader.fragmentShader.includes('#define vHue uHue') && !shader.vertexShader.includes('aHue'), "a puppet's hue is its material's uHue uniform")
}

// --- the scatter's rate ----------------------------------------------------------
const alive = (of) => of.species.flatMap((sp) => sp.slots.filter((c) => c.tile !== null))
const SEEDS = 40
{
  const counts = Object.fromEntries(SPECIES.map((sp) => [sp.key, 0]))
  let tiles = 0
  let overflow = 0
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed, { walk: plain, water: noWater, height })
    k.place(0, 0)
    tiles += k.tiles.size
    overflow += k.overflow
    for (const sp of k.species) counts[sp.key] += MAX - sp.free.length
    k.dispose()
  }
  const area = tiles * TILE * TILE
  const rates = Object.fromEntries(Object.entries(counts).map(([key, n]) => [key, n / area]))
  check(overflow === 0, 'nothing was dropped for want of a slot, over every seed', `${overflow} over ${SEEDS} seeds`)
  check(Object.values(rates).every((r) => Math.abs(r / DENSITY - 1) < 0.12), `one of EACH per ${Math.round(1 / DENSITY)} square metres, on open ground`, Object.entries(rates).map(([k2, r]) => `${k2} 1 per ${Math.round(1 / r)}`).join(', ') + ` over ${Math.round(area / 1e3)}k m2`)
  check(Object.values(counts).every((n) => n > 100), 'and enough of each to say so', JSON.stringify(counts))
}

// --- where they sit --------------------------------------------------------------
w.place(0, 0)
{
  const pool = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const k = make(seed)
    k.place(0, 0)
    for (const c of alive(k)) pool.push({ key: c.sp.key, x: c.x, y: c.y, z: c.z, size: c.size, k: c.k, hue: c.hue, nx: c.nx, ny: c.ny, nz: c.nz })
    k.dispose()
  }
  check(pool.length > 3 * SEEDS, 'the moor carries animals', `${pool.length} over ${SEEDS} seeds; one seed: ${JSON.stringify(w.stats.alive)} on ${w.stats.tiles} tiles`)
  check(pool.every((c) => !water.isSubmerged(c.x, c.z, c.y)), 'none wades', `${pool.filter((c) => water.isSubmerged(c.x, c.z, c.y)).length} in the pond`)
  check(pool.every((c) => c.y <= SNOW_LINE - SNOW_MARGIN), `none stands within ${SNOW_MARGIN} m of the snow line`, `highest ${Math.max(...pool.map((c) => c.y)).toFixed(2)} m of ${SNOW_LINE - SNOW_MARGIN}`)
  // The rolling ground rides 0.6 m either way over the ramp, which is 1.7 m of z at this pitch.
  const ripple = 0.6 / RAMP + 0.05
  check(pool.some((c) => c.z > RAMP_Z) && !pool.some((c) => c.z > SNOW_Z + ripple), `the ramp is walked to about z ${SNOW_Z.toFixed(0)} and no further`, `to z ${Math.max(...pool.map((c) => c.z)).toFixed(1)}`)
  const onCrag = pool.filter((c) => Math.hypot(c.x - CRAG.x, c.z - CRAG.z) < CRAG.r - 0.5)
  check(onCrag.length === 0, `none on the crag's 52-degree faces (the limit is ${Math.round((MAX_SLOPE * 180) / Math.PI)})`, `${onCrag.length} on it`)
  const slopes = pool.map((c) => Math.acos(Math.min(1, walk.normalAt(c.x, c.z).y)))
  check(Math.max(...slopes) <= MAX_SLOPE + 1e-9, 'every animal stands on ground it could stand on', `steepest ${((Math.max(...slopes) * 180) / Math.PI).toFixed(1)} deg`)
  check(pool.every((c) => TRUNKS.every((t) => Math.hypot(c.x - t.x, c.z - t.z) > t.r)), 'none stands inside a trunk')
  check(pool.every((c) => Math.abs(c.y - fieldAt(c.x, c.z)) < 1e-9), 'every animal is on the walk surface, not floating over it')
  check(pool.every((c) => Math.hypot(c.nx, c.ny, c.nz) - 1 < 1e-9), 'each carries the unit normal of the ground it stands on')
  for (const sp of SPECIES) {
    const mine = pool.filter((c) => c.key === sp.key)
    const quad = shipped[sp.key].json.scenes[0].extras.quadruped
    const drawM = quad.sizeM * sp.scale
    const sizes = mine.map((c) => c.size)
    // The spread has to be seen as well as allowed: a vary that stopped being rolled would still pass a bound.
    const spread = (Math.max(...sizes) - Math.min(...sizes)) / drawM
    check(sizes.every((s) => Math.abs(s / drawM - 1) <= sp.vary + 1e-9) && spread > sp.vary, `a ${sp.key} is ${drawM} m (${quad.sizeM} shipped${sp.scale === 1 ? '' : ` x ${sp.scale}`}) give or take ${Math.round(sp.vary * 100)}%, and the range is walked`, `${Math.min(...sizes).toFixed(2)} to ${Math.max(...sizes).toFixed(2)} m`)
    check(mine.every((c) => Math.abs(c.k - c.size / quad.span) < 1e-9), `and wears the scale that makes it so`)
    const hues = new Set(mine.map((c) => c.hue.toFixed(4)))
    check(hues.size > mine.length / 2 && mine.every((c) => Math.abs(c.hue) <= sp.hue), `${sp.key}s wear their own hues within ${sp.hue}`, `${hues.size} hues in ${mine.length}`)
  }
  // Determinism: the same seed lays the same animals twice.
  const key = (of) => alive(of).map((c) => `${c.sp.key}:${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)},${c.size.toFixed(4)}`).sort().join('|')
  const again = make(7)
  again.place(0, 0)
  check(key(again) === key(w) && alive(w).length > 0, 'the scatter is a pure function of the seed', `${alive(w).length} animals`)
  // And of position: the tiles she keeps hold the same animals when she steps.
  const kept = alive(again).filter((c) => Math.hypot(c.x, c.z) < 30).map((c) => ({ c, x: c.x, z: c.z }))
  again.update(TILE, GROUND + 1.6, 0, 0)
  check(kept.length > 0 && kept.every(({ c, x, z }) => c.tile !== null && c.x === x && c.z === z), 'a step of one tile leaves the animals she keeps exactly where they were', `${kept.length} kept`)
  again.dispose()
}

// --- what they do ----------------------------------------------------------------
{
  const c = alive(w).find((a) => a.sp.key === 'stag')
  const d = c.sp.durations
  // A graze: head down, a whole number of chews, head up.
  w._begin(c, 'graze')
  const graze = [[c.clip, c.left]]
  while (c.queue.length) { w._step(c); graze.push([c.clip, c.left]) }
  const chews = graze[1][1] / d['eat-loop']
  check(graze.map(([n]) => n).join(',') === 'eat-down,eat-loop,eat-up', 'a graze is eat-down, then chewing, then eat-up', graze.map(([n, t]) => `${n} ${t.toFixed(2)}s`).join(' -> '))
  check(Math.abs(graze[0][1] - d['eat-down']) < 1e-9 && Math.abs(graze[2][1] - d['eat-up']) < 1e-9, 'the head going down and coming up are timed by their own clips, played whole')
  check(Math.abs(chews - Math.round(chews)) < 1e-9 && chews >= 2, 'and the chewing between them is a whole number of eat-loops', `${Math.round(chews)} chews`)
  // A rest is one round trip, timed by itself, and both are used.
  const rests = new Set()
  let onceOnly = true
  for (let i = 0; i < 60; i++) {
    w._begin(c, 'rest')
    rests.add(c.clip)
    if (c.queue.length !== 0 || Math.abs(c.left - d[c.clip]) > 1e-9 || !ONE_SHOT.has(c.clip)) onceOnly = false
  }
  check(rests.size === 2 && rests.has('sit') && rests.has('lie') && onceOnly, 'a rest is sit or lie, played once and timed by its own length, and both are seen', `${[...rests].join(' and ')}, ${d.sit.toFixed(2)}s and ${d.lie.toFixed(2)}s`)
  // A gait moves the ground under it at the speed its stride was built for.
  w._begin(c, 'roam')
  const gait = c.sp.asset.gait[c.clip]
  check(gait > 0 && Math.abs(c.speed - gait * c.k) < 1e-12, `a roam plays a gait at ${c.clip} speed, scaled to the animal`, `${c.speed.toFixed(3)} m/s for a ${c.size.toFixed(2)} m stag`)
  check(['walk', 'trot'].includes(c.clip), 'and a stag roams at a walk or a trot, never a run', c.clip)
  // Every activity a species rolls is a clip the file carries.
  const seen = { acts: new Set(), clips: new Set() }
  for (const sp of w.species) {
    const probe = sp.slots[0]
    probe.sp = sp
    probe.k = 1
    for (let i = 0; i < 2000; i++) {
      w._pick(probe)
      seen.acts.add(probe.act)
      seen.clips.add(probe.clip)
      while (probe.queue.length) { w._step(probe); seen.clips.add(probe.clip) }
    }
  }
  const acts = new Set(SPECIES.flatMap((sp) => sp.acts.map(([n]) => n)))
  check([...seen.acts].every((a) => acts.has(a)) && [...acts].every((a) => seen.acts.has(a)), 'every activity the species weight is rolled, and no other', [...seen.acts].sort().join(' '))
  check([...seen.clips].every((n) => CLIPS.includes(n)), 'and every clip it asks for is one the file carries', [...seen.clips].sort().join(' '))
}

// --- the walk --------------------------------------------------------------------
w.place(0, 0)
{
  const c = alive(w).filter((a) => Math.hypot(a.x, a.z) > 60)[0]
  c.heading = 0.4
  w._begin(c, 'roam')
  // Facing where it is going, so this is the ground speed alone and not a curve.
  c.aim = c.heading
  c.left = 100
  const dt = 1 / 60
  const [x0, z0] = [c.x, c.z]
  const FRAMES = 30
  for (let f = 0; f < FRAMES; f++) w.update(0, GROUND + 1.6, 0, dt)
  const moved = Math.hypot(c.x - x0, c.z - z0)
  check(Math.abs(moved - c.speed * dt * FRAMES) < 1e-6, 'a moving animal covers exactly the ground its clip was built for -- it does not skate', `${moved.toFixed(4)} m in ${(FRAMES * dt).toFixed(2)} s at ${c.speed.toFixed(3)} m/s`)
  check(Math.abs((c.x - x0) / moved - Math.cos(c.heading)) < 1e-6 && Math.abs((c.z - z0) / moved + Math.sin(c.heading)) < 1e-6, 'and it goes the way it is facing')

  // Ten minutes of wandering, her head far off.
  const far = alive(w).filter((a) => Math.hypot(a.homeX, a.homeZ) > 60)
  const start = far.map((a) => [a.x, a.z])
  let strayed = 0
  let ms = 0
  // Every heading of every animal, every frame: a tether turn, a turn away from
  // the water and a fresh roam all pass through here, and not one of them may
  // move a body faster than it can turn.
  const watched = alive(w)
  let snapped = 0
  let was = watched.map((a) => a.heading)
  for (let f = 0; f < 3600; f++) {
    const t0 = performance.now()
    w.update(0, GROUND + 1.6, 0, dt)
    ms += performance.now() - t0
    for (const a of far) strayed = Math.max(strayed, Math.hypot(a.x - a.homeX, a.z - a.homeZ))
    for (let i = 0; i < watched.length; i++) {
      const d = Math.abs(Math.atan2(Math.sin(watched[i].heading - was[i]), Math.cos(watched[i].heading - was[i])))
      snapped = Math.max(snapped, d)
    }
    was = watched.map((a) => a.heading)
  }
  check(snapped <= TURN_RATE * dt + 1e-12, `in ${(watched.length * 3600 / 1000).toFixed(0)}k animal-frames of wandering, no body ever turned faster than it may`, `worst ${(snapped / dt).toFixed(3)} rad/s of ${TURN_RATE}`)
  const wandered = far.filter((a, i) => Math.hypot(a.x - start[i][0], a.z - start[i][1]) > 1)
  check(wandered.length > far.length / 2, 'most of them have wandered somewhere in a minute', `${wandered.length} of ${far.length}`)
  // The probe looks a body length and a half ahead, so the animal itself may stand that much past the leash.
  const slack = 1.5 * Math.max(...far.map((a) => a.size)) + 0.5
  check(strayed <= TETHER_M + slack, `and none has left its ${TETHER_M} m tether`, `furthest ${strayed.toFixed(2)} m of ${(TETHER_M + slack).toFixed(2)}`)
  check(alive(w).every((a) => !water.isSubmerged(a.x, a.z, a.y) && Math.acos(Math.min(1, walk.normalAt(a.x, a.z).y)) <= MAX_SLOPE && TRUNKS.every((t) => Math.hypot(a.x - t.x, a.z - t.z) > t.r)), 'nobody has walked into the water, up the crag or through a trunk')
  check(alive(w).every((a) => Math.abs(a.y - fieldAt(a.x, a.z)) < 1e-9), 'and everybody is still on the ground')
  check(w.starved === 0, `and in a minute of it no animal in sight ever went undrawn for want of one of the ${PUPPETS} puppets`, `${w.starved} starved`)
  const perFrame = ms / 3600
  check(perFrame < 1.5, `a frame of ${alive(w).length} animals costs under 1.5 ms`, `${perFrame.toFixed(3)} ms`)
}

// --- night puts them down ---------------------------------------------------------
{
  const k = make(11)
  k.place(0, 0)
  // One animal of each, rolled many times over at noon and again at full dark. The
  // roll is the species' own weights, so the share is read against itself and not
  // against a number written here.
  const share = (dayness) => {
    k.dayness = dayness
    const out = {}
    for (const sp of k.species) {
      const probe = sp.slots[0]
      probe.sp = sp
      probe.k = 1
      let rests = 0
      const N = 20000
      for (let i = 0; i < N; i++) {
        k._pick(probe)
        if (probe.act === 'rest') rests++
      }
      out[sp.key] = rests / N
    }
    return out
  }
  const day = share(1)
  const night = share(0)
  // A rest's weight doubles while the others keep theirs, so its share rises by less than NIGHT_REST: w*2/(w*2 + rest-of-the-weights).
  const want = Object.fromEntries(SPECIES.map((sp) => {
    const total = sp.acts.reduce((t, [, x]) => t + x, 0)
    const r = sp.acts.find(([n]) => n === 'rest')[1]
    return [sp.key, (r * NIGHT_REST) / (total + r * (NIGHT_REST - 1))]
  }))
  check(SPECIES.every((sp) => Math.abs(night[sp.key] / want[sp.key] - 1) < 0.05), `at full dark a rest is ${NIGHT_REST}x the weight it carries at noon`, SPECIES.map((sp) => `${sp.key} ${(day[sp.key] * 100).toFixed(1)}% -> ${(night[sp.key] * 100).toFixed(1)}% (want ${(want[sp.key] * 100).toFixed(1)})`).join(', '))
  check(SPECIES.every((sp) => night[sp.key] > day[sp.key] * 1.3), 'and a lot more of them are lying down than at noon', SPECIES.map((sp) => `${sp.key} x${(night[sp.key] / day[sp.key]).toFixed(2)}`).join(', '))
  const dusk = share(0.5)
  check(SPECIES.every((sp) => dusk[sp.key] > day[sp.key] && dusk[sp.key] < night[sp.key]), 'the settling is a ramp through the evening, not a switch at nightfall', SPECIES.map((sp) => `${sp.key} ${(dusk[sp.key] * 100).toFixed(1)}%`).join(', '))
  // The scalar arrives through update(), which is the only way the world sets it.
  k.update(0, GROUND + 1.6, 0, 1 / 60, 0.25)
  check(k.dayness === 0.25, 'and the world hands it down through update()')
  k.update(0, GROUND + 1.6, 0, 1 / 60)
  check(k.dayness === 1, 'which defaults to broad daylight when nobody passes one')
  k.dispose()
}

// --- a turn is a turn ------------------------------------------------------------
{
  const k = make(5)
  k.place(0, 0)
  const dt = 1 / 60
  const c = alive(k).find((a) => a.sp.key === 'stag')
  k._begin(c, 'roam')
  c.left = 100
  c.heading = 0
  c.aim = Math.PI
  let worst = 0
  let frames = 0
  let prev = c.heading
  // The hardest turn there is: a body asked to go back the way it came.
  while (Math.abs(Math.atan2(Math.sin(c.aim - c.heading), Math.cos(c.aim - c.heading))) > 1e-9 && frames < 600) {
    const aim = c.aim
    k.update(0, GROUND + 1.6, 0, dt)
    if (c.aim !== aim) break
    worst = Math.max(worst, Math.abs(c.heading - prev))
    prev = c.heading
    frames++
  }
  check(frames >= Math.PI / TURN_RATE / dt && worst <= TURN_RATE * dt + 1e-12, 'an about-face is turned through, not snapped to', `${(frames * dt).toFixed(2)} s at up to ${(worst / dt).toFixed(2)} rad/s`)
  check(Math.abs(Math.atan2(Math.sin(c.aim - c.heading), Math.cos(c.aim - c.heading))) < 1e-9, 'and it arrives facing where it aimed', `${c.heading.toFixed(4)} of ${c.aim.toFixed(4)} rad`)
  k.dispose()
}

// --- she is furniture ------------------------------------------------------------
{
  const dt = 1 / 60
  // The same world twice: once with her head inside the animal, once with her
  // two hundred metres straight up. Her height moves nothing but the LOD, so any
  // difference in the trace is an animal that noticed her.
  const trace = (lift) => {
    const k = make(7)
    k.place(0, 0)
    const c = alive(k).find((a) => a.sp.key === 'hare')
    const [hx, hz] = [c.x, c.z]
    const log = []
    for (let f = 0; f < 900; f++) {
      k.update(hx, c.y + lift, hz, dt)
      log.push(`${c.act}/${c.clip}/${c.x.toFixed(6)}/${c.z.toFixed(6)}/${c.heading.toFixed(6)}`)
    }
    const out = { log, away: Math.hypot(c.x - hx, c.z - hz) }
    k.dispose()
    return out
  }
  const under = trace(1.6)
  const over = trace(200)
  const same = under.log.every((s, i) => s === over.log[i])
  check(same, 'fifteen seconds with her standing on top of it, and the hare does exactly what it would have done with her two hundred metres up', `${under.log[under.log.length - 1].split('/').slice(0, 2).join('/')}`)
  check(under.away < 12, 'it has not bolted', `${under.away.toFixed(2)} m from her in 15 s`)
}

// --- drawn, or not drawn ---------------------------------------------------------
{
  w.place(0, 0)
  const c = alive(w).find((a) => a.sp.key === 'stag')
  // Straight up over it, so the distance is exactly d and the tiles do not move; dt 0, so nothing walks out from under the test.
  const at = (d, frames = 2, dt = 0) => {
    for (let f = 0; f < frames; f++) w.update(c.x, c.y + d, c.z, dt)
    return c.lod
  }
  const expect = (d) => critterTier(c.size, d, -1, LOD_DEG)
  const near = at(20)
  check(near === 0 && expect(20) === 0 && c.puppet && w.batch.children.includes(c.puppet.group), 'twenty metres off, the stag is a puppet in the scene')
  check(c.puppet.current.getClip().name === c.clip && c.puppet.current.isRunning() && c.puppet.material.userData.uHue.value === c.hue, 'playing what it is doing, in its own hue', c.clip)
  {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    c.puppet.group.matrix.decompose(p, q, s)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    check(p.distanceTo(new THREE.Vector3(c.x, c.y, c.z)) < 1e-6 && Math.abs(s.x - c.k) < 1e-9, 'standing where the animal is, at its own size', `scale ${s.x.toFixed(3)}`)
    check(up.distanceTo(new THREE.Vector3(c.nx, c.ny, c.nz)) < 1e-6, 'its feet tilted onto the ground it stands on')
    // Turned to its heading about the world up, and THAT tilted onto the ground: the body's own forward is never dragged off its course by the slope.
    const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(c.nx, c.ny, c.nz))
    const want = tilt.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.heading))
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q).applyQuaternion(tilt.invert())
    check(Math.abs(q.dot(want)) > 1 - 1e-9 && Math.abs(Math.atan2(-fwd.z, fwd.x) - Math.atan2(Math.sin(c.heading), Math.cos(c.heading))) < 1e-6, 'and its body faces its heading', `${c.heading.toFixed(2)} rad`)
  }
  // The band the old card tier covered: a stag this far off is still a puppet.
  const mid = at(80)
  check(mid === 0 && expect(80) === 0 && c.puppet, 'and eighty metres off it is still its own animated puppet, not a photograph of one')
  {
    const inSight = alive(w).filter((a) => a.lod < LOD_DEG.length)
    check(inSight.length > 0 && inSight.every((a) => a.puppet) && w.batch.children.length === inSight.length, 'every animal in sight wears a puppet, and the batch draws those and nothing else', `${inSight.length} drawn of ${alive(w).length}, ${w.starved} starved`)
  }
  const gone = at(400)
  check(gone === LOD_DEG.length && expect(400) === LOD_DEG.length && !c.puppet, 'four hundred metres off it is not drawn at all')
  check(w.species.every((sp) => sp.freePuppets.length + sp.puppets.filter((p) => p.group.parent === w.batch).length === PUPPETS), 'the pools balance')
  at(20, 4)
  const t = c.puppet.mixer.time
  at(20, 10, 1 / 60)
  check(c.puppet && Math.abs(c.puppet.mixer.time - t - 10 / 60) < 1e-9, "a puppet's mixer advances with the frames", `${(c.puppet.mixer.time - t).toFixed(4)} s in ten`)
}

console.log(failures ? `\n${failures} failing` : '\nall wildlife checks pass')
process.exit(failures ? 1 : 0)
